import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type pg from 'pg';

import { RECEIPT_POSTED_EVENT } from '../../packages/domain/src/purchasing/receipt-posted-event.js';

import {
  openComposedApplicationRuntime,
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  provisionLocalDemoAuthorization,
  rolePool,
  trustedContext,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { compileWorkflowBody } from '../../packages/postgres-provider/src/workflow-compile.js';
import {
  PostgresWorkflowConsumer,
  RECEIPT_POSTED_TYPE,
  WORKFLOW_POLL_BATCH_SIZE,
  WORKFLOW_RECEIPT_PAGE_SQL,
} from '../../packages/postgres-provider/src/workflow-consumer.js';
import {
  PostgresWorkflowExecution,
  sha256,
  WORKFLOW_ENGINE_BUILD,
  WORKFLOW_HOST_VERSION,
  WORKFLOW_SDK_VERSION,
} from '../../packages/postgres-provider/src/workflow-execution.js';
import { PostgresWorkflowGateway } from '../../packages/postgres-provider/src/workflow-gateway.js';
import { generateWorkflowSdk } from '../../packages/postgres-provider/src/workflow-sdk.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  OperationsAgentSession,
  runOperationsAgent,
  scriptedModel,
  SpendMeter,
} from '../../packages/operations-agent/src/index.js';
import { COMPANY, worldOver, type AgentWorld } from '../agent/agent-world.js';
import { referenceScript } from '../agent/reference-scripts.js';
import { TASKS } from '../agent/tasks.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

const operation = 'northstar.app:operation.custom_receipt_review_create';
const entity = 'northstar.app:entity.custom_receipt_review';

test(
  'verified activation and restart-safe receipt consumption with same-pin remedy',
  { timeout: 900_000 },
  async () => {
    await withEphemeralPostgres(
      'workflow-receipt',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://postgres@${String(connection.host)}:${String(connection.port)}/postgres`;
        const tenantSlug = 'workflow-receipt';
        const seeded = await startComposedApplication({
          databaseUrl,
          tenantSlug,
          port: 0,
          seedProfile: 'distributor',
        });
        await seeded.close();
        const runtime = await openComposedApplicationRuntime({
          databaseUrl,
          tenantSlug,
        });
        const customization = await openCustomizeService({
          databaseUrl,
          tenantSlug,
        });
        const workerPool = rolePool(
          databaseUrl,
          'north_star_workflow_worker',
          2,
        );
        const runtimePool = rolePool(databaseUrl, 'north_star_runtime', 4);
        try {
          const { tenantId, environmentId } = runtime.identity;
          const scope = { tenant_id: tenantId, environment_id: environmentId };
          const world = worldOver(runtime, 'postgres');
          await postReceipt(world);
          const prior = await latestReceipt(pool, tenantId);
          const consumer = new PostgresWorkflowConsumer(workerPool);
          assert.deepEqual(await consumer.scopes(), [scope]);
          assert.equal(
            await consumer.claim(scope),
            0,
            'a fence with no watermark starts nothing',
          );
          await assertNoWorkflowActivationOverhead(pool, tenantId);

          const service = customization.service;
          const draft = await service.draft(
            {
              kind: 'addRecordType',
              label: 'Receipt Review',
              fields: [
                { label: 'Name', type: 'text' },
                { label: 'Receipt Reference', type: 'text' },
              ],
            },
            'declarativeEditor',
          );
          assert.equal(draft.status, 'drafted');
          if (draft.status !== 'drafted')
            throw new Error('Receipt review draft refused');
          const approval = await service.approve(draft.patchId);
          const enrolled = await service.activate(draft.patchId);
          const approver = (
            await pool.query<{ approving_human_id: string }>(
              `SELECT approving_human_id FROM platform.release_approvals
          WHERE tenant_id = $1 AND environment_id = $2 AND activation_attempt_id = $3`,
              [tenantId, environmentId, approval.activationAttemptId],
            )
          ).rows[0]!.approving_human_id;

          const automation = {
            tenantId,
            environmentId,
            principalId: randomUUID(),
          };
          const operator = await trustedContext({
            tenantId,
            environmentId,
            principalId: approver,
          });
          const bindings = ['create', 'read'].map((action) => ({
            action,
            permissionId: `northstar.app:permission.custom_receipt_review_${action}`,
            resourceId: entity,
          }));
          await provisionLocalDemoAuthorization(
            pool,
            automation,
            bindings,
            'workflow-receipt-automation',
          );
          await provisionLocalDemoAuthorization(
            pool,
            operator,
            bindings,
            'workflow-receipt-approver',
          );
          const gateways = new PostgresWorkflowGateway(runtimePool);
          const grants = { queries: [], operations: [operation] };
          const sdk = generateWorkflowSdk(
            await gateways.loadView(automation),
            grants,
          );
          const body = `sdk.operation('${operation}', { recordId: event.receiptId, values: {
        'northstar.app:field.custom_receipt_review_name': 'Pending',
        'northstar.app:field.custom_receipt_review_receipt_reference': event.receiptId
      }});`;
          const compiled = compileWorkflowBody(body, sdk);
          // Fixture admission uses privileged storage until the verifier slice.
          assert.equal(await consumer.claim(scope), 0);
          await service.rollback();
          const bundle = JSON.stringify({ body, fixtures: [] });
          await pool.query(
            `INSERT INTO platform.workflow_body_blobs VALUES ($1, $2, $3, $4)`,
            [tenantId, environmentId, sha256(bundle), Buffer.from(bundle)],
          );
          await pool.query(
            `
        INSERT INTO platform.workflow_definitions (
          tenant_id, environment_id, release_id, workflow_id, event_type, body_digest, executable,
          executable_digest, sdk_digest, engine_build, host_version, sdk_version,
          automation_principal_id, authored_by, grants
        ) VALUES ($1, $2, $3, 'receipt-review', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `,
            [
              tenantId,
              environmentId,
              enrolled.releaseId,
              RECEIPT_POSTED_TYPE,
              sha256(bundle),
              Buffer.from(compiled.executable),
              sha256(compiled.executable),
              sha256(sdk.declarations),
              WORKFLOW_ENGINE_BUILD,
              WORKFLOW_HOST_VERSION,
              WORKFLOW_SDK_VERSION,
              automation.principalId,
              approver,
              JSON.stringify(grants),
            ],
          );
          await service.approve(draft.patchId);
          await service.activate(draft.patchId);
          assert.equal(
            (
              await pool.query<{ disposition: string }>(
                'SELECT disposition FROM platform.workflow_event_occurrences WHERE outbox_id = $1',
                [prior.outbox_id],
              )
            ).rows[0]?.disposition,
            'PRE_ACTIVATION',
          );

          await postReceipt(world);
          const first = await latestReceipt(pool, tenantId);
          assert.equal(await consumer.claim(scope), 1);
          assert.equal(
            await new PostgresWorkflowConsumer(workerPool).claim(scope),
            0,
          );
          const firstRun = await runFor(pool, first.outbox_id);
          await new PostgresWorkflowExecution(
            workerPool,
            runtimePool,
            gateways,
          ).step(scope, firstRun);
          assert.equal(await journalCount(pool, firstRun, 'REQUEST'), 1);
          assert.equal(await journalCount(pool, firstRun, 'RESULT'), 0);
          const interrupted = new PostgresWorkflowExecution(
            workerPool,
            runtimePool,
            gateways,
            async () => {
              throw new Error('simulated worker crash after operation commit');
            },
          );
          await assert.rejects(
            interrupted.step(scope, firstRun),
            /simulated worker crash/,
          );
          assert.equal(await journalCount(pool, firstRun, 'RESULT'), 0);
          const restarted = new PostgresWorkflowExecution(
            workerPool,
            runtimePool,
            gateways,
          );
          await restarted.step(scope, firstRun);
          await restarted.step(scope, firstRun);
          assert.equal(await runStatus(pool, firstRun), 'COMPLETED');
          assert.equal(await journalCount(pool, firstRun, 'RESULT'), 1);
          const records = await pool.query<{
            record_id: string;
            execution_principal_kind: string;
          }>(
            `SELECT record_id, execution_principal_kind FROM platform.trust_business_change_documents
          WHERE tenant_id = $1 AND action_id = $2 AND execution_principal_id = $3`,
            [tenantId, operation, automation.principalId],
          );
          assert.deepEqual(records.rows, [
            {
              record_id: first.receipt_id,
              execution_principal_kind: 'AUTOMATION',
            },
          ]);
          const created = await runtime.entry.run(
            { headers: { cookie: 'northstar-demo-actor=manager' } },
            (view) =>
              runtime.queryGateway.invoke(view, {
                schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
                queryId: 'northstar.app:query.custom_receipt_review_get',
                arguments: { recordId: first.receipt_id },
              }),
          );
          assert.equal(
            created.records[0]?.values[
              'northstar.app:field.custom_receipt_review_receipt_reference'
            ],
            first.receipt_id,
          );

          await assertBoundedPoll(pool, scope, first.outbox_id);
          await postReceipt(world);
          const second = await latestReceipt(pool, tenantId);
          assert.equal(await consumer.claim(scope), 1);
          const secondRun = await runFor(pool, second.outbox_id);
          await restarted.step(scope, secondRun);
          await postReceipt(world);
          const pendingAtRollback = await latestReceipt(pool, tenantId);
          await service.rollback();
          await restarted.step(scope, secondRun);
          assert.equal(await runStatus(pool, secondRun), 'SUSPENDED');
          assert.equal(await consumer.claim(scope), 0);
          assert.equal(
            (
              await pool.query<{ disposition: string }>(
                'SELECT disposition FROM platform.workflow_event_occurrences WHERE outbox_id = $1',
                [pendingAtRollback.outbox_id],
              )
            ).rows[0]?.disposition,
            'PRE_ACTIVATION',
          );
          assert.deepEqual(
            await restarted.remedy(operator, [secondRun], 'retry'),
            [{ runId: secondRun, outcome: 'ineligible' }],
          );
          await service.approve(draft.patchId);
          await service.activate(draft.patchId);
          assert.deepEqual(
            await restarted.remedy(operator, [secondRun], 'retry'),
            [{ runId: secondRun, outcome: 'retried' }],
          );
          await restarted.step(scope, secondRun);
          await restarted.step(scope, secondRun);
          assert.equal(await runStatus(pool, secondRun), 'COMPLETED');

          await postReceipt(world);
          const refused = await latestReceipt(pool, tenantId);
          assert.equal(await consumer.claim(scope), 1);
          const refusedRun = await runFor(pool, refused.outbox_id);
          await restarted.step(scope, refusedRun);
          await pool.query(
            `UPDATE platform.current_policy_memberships SET revoked_at = clock_timestamp()
              WHERE tenant_id = $1 AND environment_id = $2 AND principal_id = $3`,
            [tenantId, environmentId, automation.principalId],
          );
          await restarted.step(scope, refusedRun);
          assert.equal(await runStatus(pool, refusedRun), 'SUSPENDED');
          assert.equal(await journalCount(pool, refusedRun, 'RESULT'), 0);
          assert.deepEqual(
            await restarted.remedy(operator, [refusedRun, firstRun], 'cancel'),
            [
              { runId: refusedRun, outcome: 'cancelled' },
              { runId: firstRun, outcome: 'ineligible' },
            ],
          );
          assert.equal(await runStatus(pool, refusedRun), 'CANCELLED');
        } finally {
          await workerPool.end();
          await runtimePool.end();
          await customization.close();
          await runtime.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

async function postReceipt(world: AgentWorld): Promise<void> {
  const task = TASKS.find(({ id }) => id === 5)!;
  const context = await task.arrange(world);
  const session = new OperationsAgentSession({
    approve: () => Promise.resolve(true),
    companyId: COMPANY,
    personHeaders: { cookie: 'northstar-demo-actor=buyer' },
    runtime: world.runtime,
  });
  const run = await runOperationsAgent({
    meter: new SpendMeter(null, 1),
    model: scriptedModel(referenceScript(5, context)),
    request: task.request(context),
    session,
  });
  assert.equal(run.stop, 'answered', run.answer);
  assert.ok(
    session.toolCalls.every((call) => !call.isError),
    run.answer,
  );
}

async function latestReceipt(
  pool: pg.Pool,
  tenantId: string,
): Promise<{ outbox_id: string; receipt_id: string }> {
  const result = await pool.query<{ outbox_id: string; receipt_id: string }>(
    `SELECT o.outbox_id, d.record_id AS receipt_id
       FROM platform.trust_outbox AS o
       JOIN platform.trust_business_change_documents AS d USING (tenant_id, environment_id, change_document_id)
      WHERE o.tenant_id = $1 AND o.event_type = $2 ORDER BY o.recorded_at DESC LIMIT 1`,
    [tenantId, RECEIPT_POSTED_TYPE],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

async function runFor(pool: pg.Pool, outbox: string): Promise<string> {
  const result = await pool.query<{ run_id: string }>(
    `SELECT r.run_id FROM platform.workflow_runs AS r
      JOIN platform.workflow_instances AS i USING (tenant_id, environment_id, instance_id)
     WHERE i.outbox_id = $1`,
    [outbox],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0]!.run_id;
}

async function runStatus(pool: pg.Pool, run: string): Promise<string> {
  return (
    await pool.query<{ status: string }>(
      'SELECT status FROM platform.workflow_runs WHERE run_id = $1',
      [run],
    )
  ).rows[0]!.status;
}

async function journalCount(
  pool: pg.Pool,
  run: string,
  kind: string,
): Promise<number> {
  return (
    await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM platform.workflow_journal WHERE run_id = $1 AND kind = $2',
      [run, kind],
    )
  ).rows[0]!.count;
}

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  Plans?: PlanNode[];
}

async function assertBoundedPoll(
  pool: pg.Pool,
  scope: { tenant_id: string; environment_id: string },
  sample: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Synthetic history is rolled back before its deferred trust FKs fire.
    await client.query(
      `
      WITH extra AS (
        INSERT INTO platform.trust_outbox (
          tenant_id, environment_id, outbox_id, outbox_version, invocation_id, change_document_id,
          domain_event_id, request_id, action_id, correlation_id, release_id, release_content_hash,
          event_type, event_schema_version, deduplication_key
        )
        SELECT tenant_id, environment_id, gen_random_uuid(), outbox_version, gen_random_uuid(),
               gen_random_uuid(), gen_random_uuid(), request_id, action_id, correlation_id,
               release_id, release_content_hash,
               CASE WHEN ordinal % 4 = 0 THEN event_type ELSE 'other' END,
               event_schema_version, gen_random_uuid()::text
          FROM platform.trust_outbox CROSS JOIN generate_series(1, 20000) AS ordinal
         WHERE outbox_id = $1
        RETURNING tenant_id, environment_id, outbox_id
      )
      INSERT INTO platform.workflow_event_occurrences (tenant_id, environment_id, outbox_id, pointer_id, fence, disposition)
      SELECT extra.tenant_id, extra.environment_id, extra.outbox_id, occurrence.pointer_id,
             occurrence.fence, 'PRE_ACTIVATION'
        FROM extra CROSS JOIN platform.workflow_event_occurrences AS occurrence
       WHERE occurrence.outbox_id = $1
    `,
      [sample],
    );
    await client.query('ANALYZE platform.trust_outbox');
    await client.query('ANALYZE platform.workflow_event_occurrences');
    await client.query('SET LOCAL ROLE north_star_workflow_worker');
    await client.query(
      `SELECT set_config('north_star.tenant_id', $1, true),
      set_config('north_star.environment_id', $2, true)`,
      [scope.tenant_id, scope.environment_id],
    );
    const plan = (
      await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${WORKFLOW_RECEIPT_PAGE_SQL}`,
        [
          scope.tenant_id,
          scope.environment_id,
          '00000000-0000-0000-0000-000000000000',
          WORKFLOW_POLL_BATCH_SIZE + 1,
          RECEIPT_POSTED_EVENT.postingAction,
          RECEIPT_POSTED_EVENT.schemaVersion,
          RECEIPT_POSTED_EVENT.recordType,
          RECEIPT_POSTED_TYPE,
        ],
      )
    ).rows[0]!['QUERY PLAN'][0]!.Plan;
    const flatten = (node: PlanNode): PlanNode[] => [
      node,
      ...(node.Plans ?? []).flatMap(flatten),
    ];
    const nodes = flatten(plan);
    const scan = nodes.find(
      (node) => node['Index Name'] === 'workflow_receipt_outbox_scan_idx',
    );
    assert.ok(scan, JSON.stringify(plan));
    assert.equal(scan['Actual Rows'], WORKFLOW_POLL_BATCH_SIZE + 1);
    assert.ok(
      nodes.every(
        (node) =>
          node['Actual Rows'] * node['Actual Loops'] <=
          WORKFLOW_POLL_BATCH_SIZE + 1,
      ),
      JSON.stringify(plan),
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function assertNoWorkflowActivationOverhead(
  pool: pg.Pool,
  tenantId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE control_receipt (LIKE platform.release_activation_verification_receipts);
      CREATE TEMP TABLE hooked_receipt (LIKE platform.release_activation_verification_receipts);
      CREATE TRIGGER test_workflow_watermark
        AFTER INSERT ON hooked_receipt
        FOR EACH ROW WHEN (NEW.status = 'SWAPPED_VERIFIED')
        EXECUTE FUNCTION platform.workflow_capture_watermark()
    `);
    const samples = {
      control_receipt: [] as number[],
      hooked_receipt: [] as number[],
    };
    for (let repeat = 0; repeat < 15; repeat++) {
      for (const table of ['control_receipt', 'hooked_receipt'] as const) {
        const observed = await client.query<{
          'QUERY PLAN': { 'Execution Time': number }[];
        }>(
          `EXPLAIN (ANALYZE, FORMAT JSON)
           INSERT INTO ${table}
           SELECT * FROM platform.release_activation_verification_receipts
           WHERE tenant_id = $1 AND status = 'SWAPPED_VERIFIED' LIMIT 1`,
          [tenantId],
        );
        samples[table].push(
          observed.rows[0]!['QUERY PLAN'][0]!['Execution Time'],
        );
      }
    }
    const bytes = await client.query<{
      equal: boolean;
      workflow_rows: number;
    }>(`
      SELECT (SELECT array_agg(record_send(c)) FROM control_receipt c) =
             (SELECT array_agg(record_send(h)) FROM hooked_receipt h) AS equal,
             (SELECT count(*)::int FROM platform.workflow_activation_watermarks) AS workflow_rows
    `);
    assert.deepEqual(bytes.rows[0], { equal: true, workflow_rows: 0 });
    const median = (values: number[]) =>
      values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    assert.ok(
      median(samples.hooked_receipt) <= median(samples.control_receipt) + 1,
      JSON.stringify(samples),
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
