import { createHash } from 'node:crypto';

import { canonicalize } from '@north-star/canonical-model';
import {
  AuthenticatedRequestEntryAdapter,
  assertTrustedRequestContext,
  type TrustedRequestContext,
} from '@north-star/runtime';
import type {
  ImmutableJsonValue,
  RequestRuntimeView,
} from '@north-star/runtime/request-runtime-view';
import type { Pool, PoolClient } from 'pg';

import { withTrustedRequestTransaction } from './request-context.js';
import {
  lockWorkflowPointer,
  verifiedWorkflowWatermark,
  withWorkflowTransaction,
  type WorkflowPointer,
  type WorkflowScope,
} from './workflow-consumer.js';
import { InMemoryWorkflowRun } from './workflow-run.js';
import {
  generateWorkflowSdk,
  type WorkflowCall,
  type WorkflowEvent,
  type WorkflowGrants,
} from './workflow-sdk.js';

export const WORKFLOW_ENGINE_BUILD = 'quickjs-emscripten@0.32.0';
export const WORKFLOW_HOST_VERSION = 'northstar.workflow-host/v1';
export const WORKFLOW_SDK_VERSION = 'northstar.workflow-sdk/v1';

type EffectCall = Extract<WorkflowCall, { kind: 'query' | 'operation' }>;

export interface WorkflowRunPin extends WorkflowScope {
  readonly run_id: string;
  readonly instance_id: string;
  readonly pointer_id: string;
  readonly release_id: string;
  readonly release_root: string;
  readonly initial_fence: string;
  readonly execution_fence: string;
  readonly automation_principal_id: string;
  readonly trigger_principal_id: string;
  readonly legal_entity_id: string;
  readonly receipt_id: string;
  readonly event_id: string;
  readonly approver_id: string;
  readonly approver_grants: readonly [
    permission: string,
    resource: string,
    company: string | null,
  ][];
}

interface Run extends WorkflowRunPin {
  readonly status:
    | 'RUNNABLE'
    | 'WAITING'
    | 'COMPLETED'
    | 'CANCELLED'
    | 'SUSPENDED'
    | 'QUARANTINED';
  readonly reason: string | null;
  readonly executable: Buffer;
  readonly sdk_digest: string;
  readonly grants: WorkflowGrants;
  readonly engine_build: string;
  readonly host_version: string;
  readonly sdk_version: string;
}

interface JournalRow {
  readonly cursor: number;
  readonly kind: 'REQUEST' | 'RESULT';
  readonly canonical_bytes: Buffer;
  readonly idempotency_key: string | null;
}

export interface WorkflowGateway {
  loadView(principal: TrustedRequestContext): Promise<RequestRuntimeView>;
  dispatch(
    run: WorkflowRunPin,
    call: EffectCall,
    idempotencyKey: string,
  ): Promise<ImmutableJsonValue>;
  authorizeRemedy(operator: TrustedRequestContext): Promise<boolean>;
}

export class WorkflowEffectRefusal extends Error {
  override readonly name = 'WorkflowEffectRefusal';
}

type Dispatch = {
  readonly run: Run;
  readonly cursor: number;
  readonly call: EffectCall;
  readonly idempotencyKey: string;
};

export class PostgresWorkflowExecution {
  constructor(
    private readonly workerPool: Pool,
    private readonly runtimePool: Pool,
    private readonly gateway: WorkflowGateway,
    private readonly afterOperationCommit?: () => Promise<void>,
  ) {}

  async tick(scope: WorkflowScope): Promise<void> {
    const candidates = await withWorkflowTransaction(
      this.workerPool,
      scope,
      async (client) =>
        (
          await client.query<{ run_id: string }>(
            `SELECT run_id FROM platform.workflow_runs
          WHERE tenant_id = $1 AND environment_id = $2 AND status = 'RUNNABLE'
          ORDER BY created_at, run_id LIMIT 16`,
            [scope.tenant_id, scope.environment_id],
          )
        ).rows,
    );
    for (const { run_id } of candidates) await this.step(scope, run_id);
  }

  async step(scope: WorkflowScope, runId: string): Promise<void> {
    // Commit a request and its outbox before dispatch. The operation commits
    // independently. An exact semantic receipt bridges that second boundary.
    const dispatch = await withWorkflowTransaction(
      this.workerPool,
      scope,
      (client) => this.#prepare(client, scope, runId),
    );
    if (!dispatch) return;
    const { run, call, cursor, idempotencyKey } = dispatch;
    let result: ImmutableJsonValue;
    try {
      result = await this.gateway.dispatch(run, call, idempotencyKey);
    } catch (error) {
      if (!(error instanceof WorkflowEffectRefusal)) throw error;
      await withWorkflowTransaction(this.workerPool, scope, async (client) => {
        const pointer = await lockWorkflowPointer(client);
        const current = await loadRun(client, scope, runId);
        if (
          current?.status !== 'RUNNABLE' ||
          current.execution_fence !== run.execution_fence
        )
          return;
        if (await this.#recover(client, current, dispatch)) return;
        await setStatus(
          client,
          current,
          'SUSPENDED',
          matchesPin(current, pointer) ? error.message : 'stale-release-pin',
        );
      });
      return;
    }
    if (call.kind === 'operation') await this.afterOperationCommit?.();
    await withWorkflowTransaction(this.workerPool, scope, async (client) => {
      const pointer = call.kind === 'query' ? await lockWorkflowPointer(client) : null;
      const current = await loadRun(client, scope, runId);
      if (!current) return;
      if (call.kind === 'query' && (!matchesPin(current, pointer) ||
          current.status !== 'RUNNABLE' || current.execution_fence !== run.execution_fence)) return;
      await insertResult(client, current, cursor, result, call.kind === 'query');
    });
  }

  async remedy(
    operator: TrustedRequestContext,
    runIds: readonly string[],
    action: 'retry' | 'cancel',
  ): Promise<
    readonly {
      runId: string;
      outcome: 'retried' | 'cancelled' | 'ineligible';
    }[]
  > {
    assertTrustedRequestContext(operator);
    if (runIds.length > 100)
      throw new RangeError('Select at most 100 workflow runs');
    if (!(await this.gateway.authorizeRemedy(operator)))
      throw new Error('Workflow remedy permission refused');
    const scope = {
      tenant_id: operator.tenantId,
      environment_id: operator.environmentId,
    };
    const results: {
      runId: string;
      outcome: 'retried' | 'cancelled' | 'ineligible';
    }[] = [];
    for (const runId of new Set(runIds)) {
      const outcome = await withWorkflowTransaction(
        this.workerPool,
        scope,
        async (client) => {
          const pointer = await lockWorkflowPointer(client);
          const run = await loadRun(client, scope, runId);
          if (!run) return 'ineligible';
        if (run.status !== 'SUSPENDED') {
          await recordControl(client, run, `${action}-ineligible`, operator.principalId);
          return 'ineligible';
        }
          const { pending } = await loadJournal(client, run);
          if (pending && pending.call.kind === 'operation')
            await this.#recover(client, run, { ...pending, run });
          const watermark =
            pointer &&
            (await verifiedWorkflowWatermark(client, scope, pointer));
          const canRetry =
            pointer &&
            pointer.pointer_id === run.pointer_id &&
            pointer.release_id === run.release_id &&
            watermark?.release_root === run.release_root &&
            runtimeAvailable(run) &&
            run.reason === 'stale-release-pin';
          if (action === 'retry' && !canRetry) {
            await recordControl(
              client,
              run,
              'retry-ineligible',
              operator.principalId,
            );
            return 'ineligible';
          }
          if (action === 'cancel') {
            await setStatus(
              client,
              run,
              'CANCELLED',
              'operator-cancelled',
              operator.principalId,
            );
            return 'cancelled';
          }
          await client.query(
            `UPDATE platform.workflow_runs SET status = 'RUNNABLE', reason = NULL, execution_fence = $4
            WHERE tenant_id = $1 AND environment_id = $2 AND run_id = $3`,
            [...runKey(run), pointer!.fence],
          );
          await recordControl(
            client,
            run,
            'same-pin-retry',
            operator.principalId,
            pointer!.fence,
          );
          return 'retried';
        },
      );
      results.push({ runId, outcome });
    }
    return results;
  }

  async #prepare(
    client: PoolClient,
    scope: WorkflowScope,
    runId: string,
  ): Promise<Dispatch | null> {
    const pointer = await lockWorkflowPointer(client);
    const run = await loadRun(client, scope, runId);
    if (run?.status !== 'RUNNABLE') return null;

    const journal = await loadJournal(client, run);
    if (
      journal.pending &&
      (await this.#recover(client, run, { ...journal.pending, run }))
    ) {
      return null;
    }
    if (!matchesPin(run, pointer)) {
      await setStatus(client, run, 'SUSPENDED', 'stale-release-pin');
      return null;
    }
    if (!runtimeAvailable(run)) {
      await setStatus(client, run, 'SUSPENDED', 'unavailable-runtime-version');
      return null;
    }

    try {
      const view = await this.gateway.loadView(await automationContext(run));
      if (
        view.release.releaseId !== run.release_id ||
        view.release.contentHash !== run.release_root ||
        String(view.pointer.fence) !== run.execution_fence ||
        view.pointer.pointerId !== run.pointer_id
      ) {
        throw new WorkflowEffectRefusal('runtime-release-pin-mismatch');
      }
      const sdk = generateWorkflowSdk(view, run.grants);
      if (sha256(sdk.declarations) !== run.sdk_digest)
        throw new WorkflowEffectRefusal('unavailable-sdk-artifact');
      const event: WorkflowEvent = {
        type: 'goodsReceiptPosted',
        eventId: run.event_id,
        legalEntityId: run.legal_entity_id,
        receiptId: run.receipt_id,
      };
      const base = new InMemoryWorkflowRun(
        { executable: run.executable.toString(), sdk },
        event,
      );
      const replay = new InMemoryWorkflowRun(
        { executable: run.executable.toString(), sdk },
        event,
        {
          ...base.snapshot(),
          prefix: journal.prefix,
          pending: journal.pending && canonicalize(journal.pending.call),
        },
      );
      const step = await replay.step();
      if (step.kind === 'done') {
        await setStatus(client, run, 'COMPLETED', null);
        return null;
      }
      if (step.kind === 'quarantined') {
        await setStatus(
          client,
          run,
          'QUARANTINED',
          `${step.reason}:${step.cursor}`,
        );
        return null;
      }
      const { cursor, call } = step;
      if (call.kind !== 'query' && call.kind !== 'operation')
        throw new WorkflowEffectRefusal('durable-call-unavailable');
      if (journal.pending) return { ...journal.pending, call, run };
      const requestId = await insertJournal(
        client,
        run,
        cursor,
        'REQUEST',
        call,
      );
      const idempotencyKey = workflowEffectId(run.instance_id, cursor);
      await client.query(
        `INSERT INTO platform.workflow_effect_outbox (
           tenant_id, environment_id, run_id, cursor, request_journal_id, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [...runKey(run), cursor, requestId, idempotencyKey],
      );
      // A later tick will see the committed outbox.
      return null;
    } catch (error) {
      if (error instanceof WorkflowEffectRefusal) {
        await setStatus(client, run, 'SUSPENDED', error.message);
        return null;
      }
      throw error;
    }
  }

  async #recover(
    client: PoolClient,
    run: Run,
    dispatch: Dispatch,
  ): Promise<boolean> {
    if (dispatch.call.kind !== 'operation') return false;
    const call = dispatch.call;
    const receipt = await withTrustedRequestTransaction(
      this.runtimePool,
      await automationContext(run),
      async (runtime) =>
        (
          await runtime.query<{
            mutation_result: ImmutableJsonValue;
            input_digest: string;
          }>(
            `SELECT mutation_result, input_digest FROM platform.semantic_operation_receipts
          WHERE tenant_id = $1 AND environment_id = $2 AND principal_id = $3
            AND release_id = $4 AND release_content_hash = $5 AND action_id = $6 AND idempotency_key = $7`,
            [
              run.tenant_id,
              run.environment_id,
              run.automation_principal_id,
              run.release_id,
              run.release_root,
              call.id,
              dispatch.idempotencyKey,
            ],
          )
        ).rows[0],
    );
    if (!receipt) return false;
    if (receipt.input_digest !== sha256(canonicalize(call.input)))
      throw new Error('Workflow operation receipt input digest mismatch');
    await insertResult(client, run, dispatch.cursor, {
      outcome: 'succeeded',
      readBack: receipt.mutation_result,
    });
    return true;
  }
}

async function loadRun(
  client: PoolClient,
  scope: WorkflowScope,
  runId: string,
): Promise<Run | null> {
  return (
    (
      await client.query<Run>(
        `SELECT r.*, d.executable, d.sdk_digest, d.grants, d.engine_build, d.host_version, d.sdk_version,
             d.automation_principal_id, i.legal_entity_id, i.receipt_id, i.event_id, i.trigger_principal_id,
             w.approver_id, w.approver_grants
        FROM platform.workflow_runs AS r
        JOIN platform.workflow_instances AS i USING (tenant_id, environment_id, instance_id, workflow_id)
        JOIN platform.workflow_definitions AS d USING (tenant_id, environment_id, release_id, workflow_id)
        JOIN platform.workflow_activation_watermarks AS w
          ON w.tenant_id = r.tenant_id AND w.environment_id = r.environment_id
         AND w.pointer_id = r.pointer_id AND w.fence = r.initial_fence
       WHERE r.tenant_id = $1 AND r.environment_id = $2 AND r.run_id = $3
       FOR UPDATE OF r`,
        [scope.tenant_id, scope.environment_id, runId],
      )
    ).rows[0] ?? null
  );
}

async function loadJournal(
  client: PoolClient,
  run: Run,
): Promise<{
  prefix: { request: string; result: string }[];
  pending: Omit<Dispatch, 'run'> | null;
}> {
  const journal = await client.query<JournalRow>(
    `SELECT j.cursor, j.kind, j.canonical_bytes, e.idempotency_key
       FROM platform.workflow_journal AS j
       LEFT JOIN platform.workflow_effect_outbox AS e
         ON e.tenant_id = j.tenant_id AND e.environment_id = j.environment_id
        AND e.run_id = j.run_id AND e.cursor = j.cursor AND e.request_journal_id = j.journal_id
      WHERE j.tenant_id = $1 AND j.environment_id = $2 AND j.run_id = $3 AND j.kind <> 'CONTROL'
      ORDER BY j.cursor, j.kind`,
    runKey(run),
  );
  const prefix: { request: string; result: string }[] = [];
  for (let index = 0; index < journal.rows.length; index += 2) {
    const request = journal.rows[index]!;
    const result = journal.rows[index + 1];
    if (
      request.kind !== 'REQUEST' ||
      request.cursor !== prefix.length ||
      !request.idempotency_key
    )
      throw new Error(
        'Workflow journal has a missing or noncontiguous request',
      );
    if (!result)
      return {
        prefix,
        pending: {
          cursor: request.cursor,
          call: JSON.parse(request.canonical_bytes.toString()) as EffectCall,
          idempotencyKey: request.idempotency_key,
        },
      };
    if (result.kind !== 'RESULT' || result.cursor !== request.cursor)
      throw new Error('Workflow journal result is not paired with its request');
    prefix.push({
      request: request.canonical_bytes.toString(),
      result: result.canonical_bytes.toString(),
    });
  }
  return { prefix, pending: null };
}

async function insertResult(
  client: PoolClient,
  run: Run,
  cursor: number,
  value: ImmutableJsonValue,
  useFirstResult = false,
): Promise<void> {
  const encoded = canonicalize(value);
  const old = await client.query<{ canonical_bytes: Buffer }>(
    `SELECT canonical_bytes FROM platform.workflow_journal
      WHERE tenant_id = $1 AND environment_id = $2 AND run_id = $3 AND cursor = $4 AND kind = 'RESULT'`,
    [...runKey(run), cursor],
  );
  if (old.rows[0]) {
    if (!useFirstResult && old.rows[0].canonical_bytes.toString() !== encoded)
      throw new Error('Workflow effect already has a different durable result');
    return;
  }
  await insertJournal(client, run, cursor, 'RESULT', value);
}

async function insertJournal(
  client: PoolClient,
  run: Run,
  cursor: number,
  kind: JournalRow['kind'] | 'CONTROL',
  value: unknown,
): Promise<string> {
  const row = await client.query<{ journal_id: string }>(
    `INSERT INTO platform.workflow_journal (tenant_id, environment_id, run_id, cursor, kind, canonical_bytes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING journal_id`,
    [...runKey(run), cursor, kind, Buffer.from(canonicalize(value))],
  );
  return row.rows[0]!.journal_id;
}

async function setStatus(
  client: PoolClient,
  run: Run,
  status: Run['status'],
  reason: string | null,
  operator: string | null = null,
): Promise<void> {
  await client.query(
    `UPDATE platform.workflow_runs SET status = $4, reason = $5
      WHERE tenant_id = $1 AND environment_id = $2 AND run_id = $3`,
    [...runKey(run), status, reason],
  );
  await recordControl(client, run, reason ?? status, operator);
}

async function recordControl(
  client: PoolClient,
  run: Run,
  reason: string,
  operator: string | null,
  fence = run.execution_fence,
): Promise<void> {
  await insertJournal(client, run, 0, 'CONTROL', { fence, operator, reason });
}

function matchesPin(run: Run, pointer: WorkflowPointer | null): boolean {
  return (
    pointer?.pointer_id === run.pointer_id &&
    pointer.release_id === run.release_id &&
    pointer.fence === run.execution_fence
  );
}

function runtimeAvailable(run: Run): boolean {
  return (
    run.engine_build === WORKFLOW_ENGINE_BUILD &&
    run.host_version === WORKFLOW_HOST_VERSION &&
    run.sdk_version === WORKFLOW_SDK_VERSION
  );
}

function runKey(run: Run): [string, string, string] {
  return [run.tenant_id, run.environment_id, run.run_id];
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function workflowEffectId(instanceId: string, cursor: number): string {
  const hash = sha256(`northstar.workflow-effect/v1:${instanceId}:${cursor}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function automationContext(
  run: WorkflowRunPin,
): Promise<TrustedRequestContext> {
  return new AuthenticatedRequestEntryAdapter(async () => ({
    tenantId: run.tenant_id,
    environmentId: run.environment_id,
    principalId: run.automation_principal_id,
  })).enter({});
}
