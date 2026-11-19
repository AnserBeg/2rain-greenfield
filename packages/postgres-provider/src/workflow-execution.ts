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
import {
  MAXIMUM_WORKFLOW_EFFECT_BYTES,
  WorkflowWatchdogExpired,
} from './workflow-isolate.js';
import { InMemoryWorkflowRun, WorkflowGuestError } from './workflow-run.js';
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

interface WorkflowUnattendedProof {
  readonly releaseRoot: string;
  readonly operationDigest: string;
  readonly inputContractDigest: string;
  readonly reachableWriteEntities: readonly string[];
  readonly tierBIntersections: readonly string[];
}

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
  readonly unattended_operations: Readonly<
    Record<string, WorkflowUnattendedProof>
  >;
  readonly approver_grants: readonly [
    permission: string,
    resource: string,
    company: string | null,
  ][];
}

interface Run extends WorkflowRunPin {
  readonly workflow_id: string;
  readonly status:
    | 'RUNNABLE'
    | 'WAITING'
    | 'COMPLETED'
    | 'CANCELLED'
    | 'SUSPENDED'
    | 'QUARANTINED';
  readonly reason: string | null;
  readonly executable: Buffer;
  readonly verified_digest: string | null;
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
  withRemedyAuthority<T>(
    operator: TrustedRequestContext,
    work: () => Promise<T>,
  ): Promise<T>;
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

type Journal = Awaited<ReturnType<typeof loadJournal>>;

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
    const failures: unknown[] = [];
    for (const { run_id } of candidates) {
      try {
        await this.step(scope, run_id);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Workflow run batch failed');
  }

  async step(scope: WorkflowScope, runId: string): Promise<void> {
    // Read and replay without holding the pointer or run lock. The short
    // transaction below validates the snapshot before recording its decision.
    const snapshot = await this.#snapshot(scope, runId);
    if (!snapshot || snapshot.run.status !== 'RUNNABLE') return;
    const { run, journal } = snapshot;
    const pending = journal.pending && { ...journal.pending, run };
    const recovered = pending && (await this.#readReceipt(pending));
    const decision =
      recovered || !matchesPin(run, snapshot.pointer)
        ? null
        : await this.#replay(run, journal);
    const dispatch = await this.#withCurrent(
      run,
      journal,
      async (client, current, pointer) => {
        if (pending && recovered) {
          await persistEffectResult(client, current, pending, recovered);
          return null;
        }
        if (!matchesPin(current, pointer)) {
          await setStatus(client, current, 'SUSPENDED', 'stale-release-pin');
          return null;
        }
        if (!decision) return null;
        if (decision.kind === 'SUSPENDED' || decision.kind === 'QUARANTINED') {
          await setStatus(client, current, decision.kind, decision.reason);
          return null;
        }
        if (decision.kind === 'done') {
          await setStatus(client, current, 'COMPLETED', null);
          return null;
        }
        if (decision.kind === 'quarantined') {
          await setStatus(
            client,
            current,
            'QUARANTINED',
            `${decision.reason}:${decision.cursor}`,
          );
          return null;
        }
        const { call, cursor } = decision;
        if (call.kind !== 'query' && call.kind !== 'operation') {
          await setStatus(
            client,
            current,
            'SUSPENDED',
            'durable-call-unavailable',
          );
          return null;
        }
        if (pending) return { ...pending, call };
        const requestId = await insertJournal(
          client,
          current,
          cursor,
          'REQUEST',
          call,
        );
        await client.query(
          `INSERT INTO platform.workflow_effect_outbox (
           tenant_id, environment_id, run_id, cursor, request_journal_id, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            ...runKey(current),
            cursor,
            requestId,
            workflowEffectId(current.instance_id, cursor),
          ],
        );
        return null;
      },
    );
    if (!dispatch) return;
    await this.#dispatch(dispatch, journal);
  }

  async #dispatch(dispatch: Dispatch, journal: Journal): Promise<void> {
    const { run, call, idempotencyKey } = dispatch;
    let result: ImmutableJsonValue;
    try {
      result = await this.gateway.dispatch(run, call, idempotencyKey);
    } catch (error) {
      if (!(error instanceof WorkflowEffectRefusal)) throw error;
      const recovered = await this.#readReceipt(dispatch);
      await this.#withCurrent(
        run,
        journal,
        async (client, current, pointer) => {
          if (recovered)
            await persistEffectResult(client, current, dispatch, recovered);
          else
            await setStatus(
              client,
              current,
              'SUSPENDED',
              matchesPin(current, pointer)
                ? error.message
                : 'stale-release-pin',
            );
        },
      );
      return;
    }
    if (call.kind === 'operation') await this.afterOperationCommit?.();
    await this.#withCurrent(run, journal, async (client, current, pointer) => {
      if (call.kind === 'query' && !matchesPin(current, pointer)) {
        await setStatus(client, current, 'SUSPENDED', 'stale-release-pin');
        return;
      }
      await persistEffectResult(client, current, dispatch, result);
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
    const scope = {
      tenant_id: operator.tenantId,
      environment_id: operator.environmentId,
    };
    const results: {
      runId: string;
      outcome: 'retried' | 'cancelled' | 'ineligible';
    }[] = [];
    for (const runId of new Set(runIds)) {
      const snapshot = await this.#snapshot(scope, runId);
      const pending =
        snapshot?.run.status === 'SUSPENDED' &&
        snapshot.run.reason !== 'oversized-effect-result' &&
        snapshot.journal.pending
          ? { ...snapshot.journal.pending, run: snapshot.run }
          : null;
      const recovered = pending && (await this.#readReceipt(pending));
      // Hold current operator authority through each committed transition.
      const outcome = await this.gateway.withRemedyAuthority(
        operator,
        async () => {
          if (!snapshot) return 'ineligible' as const;
          const applied = await this.#withCurrent(
            snapshot.run,
            snapshot.journal,
            async (client, run, pointer) => {
              if (run.status !== 'SUSPENDED') {
                await recordControl(
                  client,
                  run,
                  `${action}-ineligible`,
                  operator.principalId,
                );
                return 'ineligible' as const;
              }
              const parked =
                pending &&
                recovered &&
                (await persistEffectResult(client, run, pending, recovered));
              const watermark =
                pointer &&
                (await verifiedWorkflowWatermark(client, scope, pointer));
              const canRetry =
                !parked &&
                pointer?.pointer_id === run.pointer_id &&
                pointer.release_id === run.release_id &&
                watermark?.release_root === run.release_root &&
                run.verified_digest !== null &&
                watermark.definition_bindings[run.workflow_id]?.digest ===
                  run.verified_digest &&
                canonicalize(
                  watermark.definition_bindings[run.workflow_id]
                    ?.unattendedOperations,
                ) === canonicalize(run.unattended_operations) &&
                runtimeAvailable(run) &&
                run.reason === 'stale-release-pin';
              if (action === 'retry' && !canRetry) {
                await recordControl(
                  client,
                  run,
                  'retry-ineligible',
                  operator.principalId,
                );
                return 'ineligible' as const;
              }
              if (action === 'cancel') {
                await setStatus(
                  client,
                  run,
                  'CANCELLED',
                  'operator-cancelled',
                  operator.principalId,
                );
                return 'cancelled' as const;
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
              return 'retried' as const;
            },
          );
          return applied ?? 'ineligible';
        },
      );
      results.push({ runId, outcome });
    }
    return results;
  }

  async #snapshot(scope: WorkflowScope, runId: string) {
    return withWorkflowTransaction(this.workerPool, scope, async (client) => {
      const pointer =
        (
          await client.query<WorkflowPointer>(
            'SELECT * FROM platform.workflow_read_pointer()',
          )
        ).rows[0] ?? null;
      const run = await loadRun(client, scope, runId);
      return run && { pointer, run, journal: await loadJournal(client, run) };
    });
  }

  async #withCurrent<T>(
    snapshot: Run,
    journal: Journal,
    work: (
      client: PoolClient,
      run: Run,
      pointer: WorkflowPointer | null,
    ) => Promise<T>,
  ): Promise<T | null> {
    return withWorkflowTransaction(
      this.workerPool,
      snapshot,
      async (client) => {
        const pointer = await lockWorkflowPointer(client);
        const { rows } = await client.query<
          Pick<Run, 'status' | 'reason' | 'execution_fence'>
        >(
          `SELECT status, reason, execution_fence
           FROM platform.workflow_runs
          WHERE tenant_id = $1 AND environment_id = $2 AND run_id = $3 FOR UPDATE`,
          runKey(snapshot),
        );
        const run = rows[0];
        if (
          !run ||
          run.status !== snapshot.status ||
          run.reason !== snapshot.reason ||
          run.execution_fence !== snapshot.execution_fence
        )
          return null;
        // Requests and results are immutable and appended at contiguous cursors.
        const { rows: counts } = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM platform.workflow_journal
          WHERE tenant_id = $1 AND environment_id = $2 AND run_id = $3 AND kind IN ('REQUEST', 'RESULT')`,
          runKey(snapshot),
        );
        if (
          counts[0]?.count !==
          journal.prefix.length * 2 + Number(journal.pending !== null)
        )
          return null;
        return work(client, snapshot, pointer);
      },
    );
  }

  async #replay(run: Run, journal: Journal) {
    try {
      if (!run.verified_digest)
        throw new WorkflowEffectRefusal('unverified-definition');
      if (!runtimeAvailable(run))
        throw new WorkflowEffectRefusal('unavailable-runtime-version');
      const view = await this.gateway.loadView(await automationContext(run));
      if (
        view.release.releaseId !== run.release_id ||
        view.release.contentHash !== run.release_root ||
        String(view.pointer.fence) !== run.execution_fence ||
        view.pointer.pointerId !== run.pointer_id
      ) {
        throw new WorkflowEffectRefusal('runtime-release-pin-mismatch');
      }
      let sdk: ReturnType<typeof generateWorkflowSdk>;
      try {
        sdk = generateWorkflowSdk(view, run.grants);
      } catch (cause) {
        throw new WorkflowEffectRefusal('unavailable-sdk-artifact', { cause });
      }
      if (sha256(sdk.declarations) !== run.sdk_digest)
        throw new WorkflowEffectRefusal('unavailable-sdk-artifact');
      const event: WorkflowEvent = {
        type: 'goodsReceiptPosted',
        eventId: run.event_id,
        legalEntityId: run.legal_entity_id,
        receiptId: run.receipt_id,
      };
      const workflow = { executable: run.executable.toString(), sdk };
      const base = new InMemoryWorkflowRun(workflow, event);
      return await new InMemoryWorkflowRun(workflow, event, {
        ...base.snapshot(),
        prefix: journal.prefix,
        pending: journal.pending && canonicalize(journal.pending.call),
      }).step();
    } catch (error) {
      if (error instanceof WorkflowEffectRefusal)
        return { kind: 'SUSPENDED' as const, reason: error.message };
      if (
        error instanceof WorkflowGuestError ||
        error instanceof WorkflowWatchdogExpired
      )
        return {
          kind: 'QUARANTINED' as const,
          reason: 'permanent-guest-failure',
        };
      throw error;
    }
  }

  async #readReceipt({
    run,
    call,
    idempotencyKey,
  }: Dispatch): Promise<ImmutableJsonValue | null> {
    if (call.kind !== 'operation') return null;
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
              idempotencyKey,
            ],
          )
        ).rows[0],
    );
    if (!receipt) return null;
    if (receipt.input_digest !== sha256(canonicalize(call.input)))
      throw new Error('Workflow operation receipt input digest mismatch');
    return { outcome: 'succeeded', readBack: receipt.mutation_result };
  }
}

async function persistEffectResult(
  client: PoolClient,
  run: Run,
  dispatch: Dispatch,
  value: ImmutableJsonValue,
): Promise<boolean> {
  if (Buffer.byteLength(canonicalize(value)) <= MAXIMUM_WORKFLOW_EFFECT_BYTES) {
    await insertJournal(client, run, dispatch.cursor, 'RESULT', value);
    return false;
  }
  const reason = 'oversized-effect-result';
  await setStatus(client, run, 'SUSPENDED', reason);
  if (dispatch.call.kind === 'operation') {
    await insertJournal(client, run, dispatch.cursor, 'CONTROL', {
      reason,
      receipt: {
        actionId: dispatch.call.id,
        idempotencyKey: dispatch.idempotencyKey,
        principalId: run.automation_principal_id,
        releaseId: run.release_id,
        releaseRoot: run.release_root,
      },
    });
  }
  return true;
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
             w.approver_id, w.approver_grants,
             CASE WHEN w.definition_bindings->d.workflow_id->>'digest' = platform.workflow_definition_digest(d)
                  THEN w.definition_bindings->d.workflow_id->>'digest' END AS verified_digest,
             COALESCE(w.definition_bindings->d.workflow_id->'unattendedOperations', '{}'::jsonb) AS unattended_operations
        FROM platform.workflow_runs AS r
        JOIN platform.workflow_instances AS i USING (tenant_id, environment_id, instance_id, workflow_id)
        JOIN platform.workflow_definitions AS d USING (tenant_id, environment_id, release_id, workflow_id)
        JOIN platform.workflow_activation_watermarks AS w
          ON w.tenant_id = r.tenant_id AND w.environment_id = r.environment_id
         AND w.pointer_id = r.pointer_id AND w.fence = r.initial_fence
       WHERE r.tenant_id = $1 AND r.environment_id = $2 AND r.run_id = $3`,
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
