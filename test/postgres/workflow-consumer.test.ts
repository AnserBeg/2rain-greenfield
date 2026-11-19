import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalize } from '@north-star/canonical-model';
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
  withWorkflowTransaction,
} from '../../packages/postgres-provider/src/workflow-consumer.js';
import {
  PostgresWorkflowExecution,
  WorkflowEffectRefusal,
  type WorkflowGateway,
  type WorkflowRunPin,
  sha256,
  WORKFLOW_ENGINE_BUILD,
  WORKFLOW_HOST_VERSION,
  WORKFLOW_SDK_VERSION,
} from '../../packages/postgres-provider/src/workflow-execution.js';
import { PostgresWorkflowGateway } from '../../packages/postgres-provider/src/workflow-gateway.js';
import { generateWorkflowSdk } from '../../packages/postgres-provider/src/workflow-sdk.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import { parsePinnedOperationCatalog } from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
} from '../../packages/runtime/src/semantic-query-gateway.js';
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
          const view = await gateways.loadView(automation);
          const sdk = generateWorkflowSdk(view, grants);
          const receivingReadModel =
            'northstar.app:query.receiving_receipt_lines';
          const registeredReadModel = registeredSemanticQueryFromPinnedView(
            view,
            receivingReadModel,
          );
          assert.ok(
            registeredReadModel &&
              'readModel' in registeredReadModel &&
              registeredReadModel.readModel,
          );
          assert.throws(
            () =>
              generateWorkflowSdk(view, {
                queries: [receivingReadModel],
                operations: [],
              }),
            /Workflow query grant does not resolve/,
          );
          const operationDefinition = parsePinnedOperationCatalog(
            view.projections.operation.payload,
          ).find((definition) => definition.operationId === operation)!;
          const proof = {
            [operation]: {
              releaseRoot: view.release.contentHash,
              operationDigest: sha256(canonicalize(operationDefinition)),
              inputContractDigest: sha256(
                canonicalize(operationDefinition.inputContract),
              ),
              reachableWriteEntities: [entity],
              tierBIntersections: [],
            },
          };
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
          await verifyFixtureDefinition(
            pool,
            enrolled.releaseId,
            'receipt-review',
            proof,
          );
          await service.approve(draft.patchId);
          await service.activate(draft.patchId);
          await cloneDefinition(pool, enrolled.releaseId, 'late-definition');
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
          await pool.query(
            `INSERT INTO platform.workflow_receipt_scan_positions
             SELECT tenant_id, environment_id, pointer_id, fence, 'ffffffff-ffff-ffff-ffff-ffffffffffff'
               FROM platform.active_release_pointers
              WHERE tenant_id = $1 AND environment_id = $2`,
            [tenantId, environmentId],
          );
          assert.equal(
            await new PostgresWorkflowConsumer(workerPool).claim(scope),
            0,
            'fresh worker resumes the persisted scan position',
          );
          assert.equal(
            await new PostgresWorkflowConsumer(workerPool).claim(scope),
            1,
            'wrap catches the earlier receipt and excludes definitions appended after activation',
          );
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
          const replayEntered = Promise.withResolvers<void>();
          const resumeReplay = Promise.withResolvers<void>();
          const delayedReplay = new PostgresWorkflowExecution(
            workerPool,
            runtimePool,
            wrapGateway(gateways, {
              async loadView(context) {
                replayEntered.resolve();
                await resumeReplay.promise;
                return gateways.loadView(context);
              },
            }),
          ).step(scope, secondRun);
          await Promise.race([
            replayEntered.promise,
            delayedReplay.then(() => {
              throw new Error('replay did not reach the runtime load');
            }),
          ]);
          try {
            await pool.query(
              `SELECT pointer_id FROM platform.active_release_pointers
                WHERE tenant_id = $1 AND environment_id = $2 FOR UPDATE NOWAIT`,
              [tenantId, environmentId],
            );
            await service.rollback();
          } finally {
            resumeReplay.resolve();
            await delayedReplay;
          }
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

          const newRun = async () => {
            await postReceipt(world);
            const receipt = await latestReceipt(pool, tenantId);
            assert.equal(await consumer.claim(scope), 1);
            const run = await runFor(pool, receipt.outbox_id);
            await restarted.step(scope, run);
            return run;
          };

          const cancelledRun = await newRun();
          const dispatchEntered = Promise.withResolvers<void>();
          const resumeDispatch = Promise.withResolvers<void>();
          let dispatchPin: WorkflowRunPin | undefined;
          const delayedDispatch = new PostgresWorkflowExecution(
            workerPool,
            runtimePool,
            wrapGateway(gateways, {
              async dispatch(...args) {
                dispatchPin = args[0];
                dispatchEntered.resolve();
                await resumeDispatch.promise;
                return gateways.dispatch(...args);
              },
            }),
          ).step(scope, cancelledRun);
          await Promise.race([
            dispatchEntered.promise,
            delayedDispatch.then(() => {
              throw new Error('effect did not reach dispatch');
            }),
          ]);
          try {
            await new PostgresWorkflowExecution(
              workerPool,
              runtimePool,
              wrapGateway(gateways, {
                async dispatch(pin, call, key) {
                  await assert.rejects(
                    gateways.dispatch(
                      { ...pin, unattended_operations: {} },
                      call,
                      key,
                    ),
                    /confirmation-required/,
                  );
                  throw new WorkflowEffectRefusal('confirmation-required');
                },
              }),
            ).step(scope, cancelledRun);
            assert.deepEqual(
              await restarted.remedy(operator, [cancelledRun], 'cancel'),
              [{ runId: cancelledRun, outcome: 'cancelled' }],
            );
          } finally {
            resumeDispatch.resolve();
            await delayedDispatch;
          }
          assert.equal(
            await operationReceiptCount(pool, cancelledRun),
            0,
            'late dispatch cannot commit after cancellation',
          );

          assert.ok(dispatchPin);
          const queryId = 'northstar.app:query.purchase_order_list';
          const companyParameter = registeredSemanticQueryFromPinnedView(
            view,
            queryId,
          )?.legalEntityScope?.operand.parameterId;
          assert.ok(companyParameter);
          await assert.rejects(
            gateways.dispatch(
              dispatchPin,
              {
                kind: 'query',
                id: queryId,
                input: { [companyParameter]: dispatchPin.legal_entity_id },
              },
              randomUUID(),
            ),
            /current-policy-refused/,
          );
          assert.equal(
            (
              await pool.query(
                `SELECT 1 FROM platform.trust_action_invocations WHERE action_id = $1
              AND execution_principal_id = $2 AND outcome = 'DENIED' AND channel = 'WORKFLOW'`,
                [queryId, automation.principalId],
              )
            ).rowCount,
            1,
          );

          const oversized = await newRun();
          await stageOversizedReceipt(pool, oversized);
          await restarted.step(scope, oversized);
          assert.equal(await runStatus(pool, oversized), 'SUSPENDED');
          assert.equal(await journalCount(pool, oversized, 'RESULT'), 0);
          assert.equal(
            (
              await pool.query(
                `SELECT 1 FROM platform.workflow_journal
              WHERE run_id = $1 AND kind = 'CONTROL'
                AND convert_from(canonical_bytes, 'UTF8')::jsonb->'receipt'->>'idempotencyKey' IS NOT NULL`,
                [oversized],
              )
            ).rowCount,
            1,
          );
          await assertApprovalBoundary(
            pool,
            workerPool,
            runtimePool,
            operator,
            oversized,
          );

          await service.rollback();
          await withWorkflowTransaction(workerPool, scope, async (client) => {
            const { rows } = await client.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM platform.trust_outbox WHERE event_type = $1',
              [RECEIPT_POSTED_TYPE],
            );
            assert.equal(
              rows[0]?.count,
              0,
              'a historical subscription gives no source access after rollback',
            );
          });
          await cloneDefinition(
            pool,
            enrolled.releaseId,
            'permanent-guest-error',
            compileWorkflowBody(
              "throw new Error('permanent guest failure');",
              sdk,
            ).executable,
          );
          await verifyFixtureDefinition(
            pool,
            enrolled.releaseId,
            'permanent-guest-error',
            {},
          );
          await service.approve(draft.patchId);
          await service.activate(draft.patchId);

          await postReceipt(world);
          const batchReceipt = await latestReceipt(pool, tenantId);
          assert.equal(await consumer.claim(scope), 2);
          const batch = await pool.query<{
            run_id: string;
            workflow_id: string;
          }>(
            `SELECT r.run_id, r.workflow_id FROM platform.workflow_runs AS r
              JOIN platform.workflow_instances AS i USING (tenant_id, environment_id, instance_id)
             WHERE i.outbox_id = $1`,
            [batchReceipt.outbox_id],
          );
          const bad = batch.rows.find(
            (entry) => entry.workflow_id === 'permanent-guest-error',
          )!.run_id;
          const good = batch.rows.find(
            (entry) => entry.workflow_id === 'receipt-review',
          )!.run_id;
          await pool.query(
            "UPDATE platform.workflow_runs SET created_at = '2000-01-01' WHERE run_id = $1",
            [bad],
          );
          let firstView = true;
          await assert.rejects(
            new PostgresWorkflowExecution(
              workerPool,
              runtimePool,
              wrapGateway(gateways, {
                async loadView(context) {
                  if (firstView) {
                    firstView = false;
                    throw new Error('temporary runtime pool failure');
                  }
                  return gateways.loadView(context);
                },
              }),
            ).tick(scope),
            /run batch failed/,
          );
          assert.equal(
            await journalCount(pool, good, 'REQUEST'),
            1,
            'later run progressed despite earlier failure',
          );
          await restarted.tick(scope);
          assert.equal(await runStatus(pool, bad), 'QUARANTINED');
          await restarted.tick(scope);
          assert.equal(await runStatus(pool, good), 'COMPLETED');

          await postReceipt(world);
          const refused = await latestReceipt(pool, tenantId);
          assert.equal(await consumer.claim(scope), 2);
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
          const scheduled = await startComposedApplication({
            databaseUrl,
            tenantSlug,
            port: 0,
            seedProfile: 'distributor',
            workflowScheduler: {
              workerDatabaseUrl: databaseUrl.replace(
                'postgres@',
                'north_star_workflow_worker@',
              ),
              runtimeDatabaseUrl: databaseUrl.replace(
                'postgres@',
                'north_star_runtime@',
              ),
            },
          });
          try {
            const { rows } = await pool.query<{ run_id: string }>(
              `SELECT r.run_id FROM platform.workflow_runs AS r
                JOIN platform.workflow_instances AS i USING (tenant_id, environment_id, instance_id)
               WHERE i.outbox_id = $1 AND r.workflow_id = 'permanent-guest-error'`,
              [refused.outbox_id],
            );
            const runId = rows[0]!.run_id;
            const start = performance.now();
            while (
              (await runStatus(pool, runId)) === 'RUNNABLE' &&
              performance.now() - start < 10_000
            ) {
              await delay(50);
            }
            assert.equal(
              await runStatus(pool, runId),
              'QUARANTINED',
              'the composed server polls workflow runs',
            );
          } finally {
            await scheduled.close();
          }

          const revokeDuringBulk = new PostgresWorkflowExecution(
            workerPool,
            runtimePool,
            wrapGateway(gateways, {
              async withRemedyAuthority(operator, work) {
                const result = await gateways.withRemedyAuthority(
                  operator,
                  work,
                );
                await pool.query(
                  'SELECT platform.set_release_approver_eligibility($1, $2, false, $2, $3)',
                  [tenantId, operator.principalId, randomUUID()],
                );
                return result;
              },
            }),
          );
          await assert.rejects(
            revokeDuringBulk.remedy(operator, [refusedRun, firstRun], 'cancel'),
            /permission refused/,
          );
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
     WHERE i.outbox_id = $1 AND r.workflow_id = 'receipt-review'`,
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
        RETURNING tenant_id, environment_id, outbox_id, event_type
      )
      INSERT INTO platform.workflow_event_occurrences (tenant_id, environment_id, outbox_id, pointer_id, fence, disposition)
      SELECT extra.tenant_id, extra.environment_id, extra.outbox_id, occurrence.pointer_id,
             occurrence.fence, 'PRE_ACTIVATION'
        FROM extra CROSS JOIN platform.workflow_event_occurrences AS occurrence
       WHERE occurrence.outbox_id = $1 AND extra.event_type = 'northstar.purchasing:event.receipt_posted'
         ORDER BY extra.outbox_id OFFSET 80
    `,
      [sample],
    );
    assert.equal(
      (
        await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM platform.workflow_event_sources WHERE event_type = $1 AND NOT resolved',
          [RECEIPT_POSTED_TYPE],
        )
      ).rows[0]?.count,
      80,
    );
    await client.query('ANALYZE platform.workflow_event_sources');
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
    assert.ok(
      nodes.some(
        (node) => node['Index Name'] === 'workflow_event_sources_pending_idx',
      ),
      JSON.stringify(plan),
    );
    const scan = nodes.find((node) => node['Node Type'] === 'CTE Scan');
    assert.ok(scan, JSON.stringify(plan));
    assert.equal(scan['Actual Rows'], WORKFLOW_POLL_BATCH_SIZE + 1);
    assert.ok(
      nodes.every((node) => node['Actual Rows'] * node['Actual Loops'] <= 80),
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

function wrapGateway(
  gateway: PostgresWorkflowGateway,
  overrides: Partial<WorkflowGateway>,
): WorkflowGateway {
  return {
    loadView: gateway.loadView.bind(gateway),
    dispatch: gateway.dispatch.bind(gateway),
    withRemedyAuthority: gateway.withRemedyAuthority.bind(gateway),
    ...overrides,
  };
}

async function cloneDefinition(
  pool: pg.Pool,
  releaseId: string,
  id: string,
  executable?: string,
) {
  await pool.query(
    `INSERT INTO platform.workflow_definitions
     SELECT tenant_id, environment_id, release_id, $2, event_type, body_digest,
            COALESCE($3, executable), COALESCE($4, executable_digest),
            sdk_digest, engine_build, host_version, sdk_version,
            automation_principal_id, authored_by, grants
       FROM platform.workflow_definitions WHERE release_id = $1 AND workflow_id = 'receipt-review'`,
    [
      releaseId,
      id,
      executable === undefined ? null : Buffer.from(executable),
      executable === undefined ? null : sha256(executable),
    ],
  );
}

async function verifyFixtureDefinition(
  pool: pg.Pool,
  releaseId: string,
  workflowId: string,
  proof: unknown,
) {
  await pool.query(
    `INSERT INTO platform.workflow_verification_evidence (
       tenant_id, environment_id, verification_evidence_id, workflow_id,
       binding_digest, result_bytes, unattended_operations
     )
     SELECT d.tenant_id, d.environment_id, r.verification_evidence_id, d.workflow_id,
            platform.workflow_definition_digest(d), convert_to('{}', 'UTF8'), $3
       FROM platform.workflow_definitions AS d
       JOIN platform.tenant_releases AS r USING (tenant_id, environment_id, release_id)
      WHERE d.release_id = $1 AND d.workflow_id = $2`,
    [releaseId, workflowId, JSON.stringify(proof)],
  );
}

async function operationReceiptCount(
  pool: pg.Pool,
  runId: string,
): Promise<number> {
  return (
    await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM platform.semantic_operation_receipts AS r
       JOIN platform.workflow_effect_outbox AS e USING (tenant_id, environment_id, idempotency_key)
      WHERE e.run_id = $1`,
      [runId],
    )
  ).rows[0]!.count;
}

async function stageOversizedReceipt(pool: pg.Pool, runId: string) {
  const { rows } = await pool.query<{
    canonical_bytes: Buffer;
    idempotency_key: string;
  }>(
    `SELECT j.canonical_bytes, e.idempotency_key FROM platform.workflow_effect_outbox AS e
       JOIN platform.workflow_journal AS j
         ON (j.tenant_id, j.environment_id, j.run_id, j.journal_id) =
            (e.tenant_id, e.environment_id, e.run_id, e.request_journal_id)
      WHERE e.run_id = $1`,
    [runId],
  );
  const request = JSON.parse(rows[0]!.canonical_bytes.toString()) as {
    input: unknown;
  };
  const result = await pool.query(
    `INSERT INTO platform.semantic_operation_receipts
     SELECT receipt.tenant_id, receipt.environment_id, receipt.principal_id, receipt.release_id,
            receipt.release_content_hash, receipt.action_id, $2, $3,
            jsonb_build_object('large', repeat('x', 17000)), receipt.invocation_id,
            receipt.correlation_id, receipt.change_document_id, receipt.domain_event_id,
            receipt.outbox_id, receipt.recorded_at
       FROM platform.workflow_runs AS r
       JOIN platform.workflow_definitions AS d USING (tenant_id, environment_id, release_id, workflow_id)
       JOIN platform.semantic_operation_receipts AS receipt
         ON (receipt.tenant_id, receipt.environment_id, receipt.release_id,
             receipt.release_content_hash, receipt.principal_id) =
            (r.tenant_id, r.environment_id, r.release_id, r.release_root, d.automation_principal_id)
      WHERE r.run_id = $4 AND receipt.action_id = $1
      ORDER BY receipt.recorded_at LIMIT 1`,
    [
      operation,
      rows[0]!.idempotency_key,
      sha256(canonicalize(request.input)),
      runId,
    ],
  );
  assert.equal(result.rowCount, 1);
}

async function assertApprovalBoundary(
  pool: pg.Pool,
  workerPool: pg.Pool,
  runtimePool: pg.Pool,
  operator: Awaited<ReturnType<typeof trustedContext>>,
  runId: string,
) {
  const scope = {
    tenant_id: operator.tenantId,
    environment_id: operator.environmentId,
  };
  await pool.query(
    "UPDATE platform.workflow_runs SET status = 'WAITING', reason = NULL WHERE run_id = $1",
    [runId],
  );
  const fence = (
    await pool.query<{ execution_fence: string }>(
      'SELECT execution_fence FROM platform.workflow_runs WHERE run_id = $1',
      [runId],
    )
  ).rows[0]!.execution_fence;
  const digest = sha256('{"summary":"Escalate"}');
  await withWorkflowTransaction(workerPool, scope, async (client) => {
    const { rows } = await client.query<{
      insert_status: boolean;
      update_decision: boolean;
      read_changes: boolean;
    }>(`
      SELECT has_column_privilege('platform.workflow_pending_approvals', 'status', 'INSERT') AS insert_status,
             has_column_privilege('platform.workflow_pending_approvals', 'decided_by', 'UPDATE') AS update_decision,
             has_column_privilege('platform.trust_business_change_documents', 'changes', 'SELECT') AS read_changes
    `);
    assert.deepEqual(rows[0], {
      insert_status: false,
      update_decision: false,
      read_changes: false,
    });
    await client.query(
      `INSERT INTO platform.workflow_pending_approvals
        (tenant_id, environment_id, run_id, cursor, fence, plan, plan_digest)
       VALUES ($1, $2, $3, 0, $4, $5, $6)`,
      [
        scope.tenant_id,
        scope.environment_id,
        runId,
        fence,
        Buffer.from('{"summary":"Escalate"}'),
        digest,
      ],
    );
  });
  const decide = (planDigest: string, activeFence: string) =>
    withTrustedRequestTransaction(
      runtimePool,
      operator,
      async (client) =>
        (
          await client.query<{ decided: boolean }>(
            "SELECT platform.workflow_decide_approval($1, 0, $2, $3, 'APPROVED') AS decided",
            [runId, activeFence, planDigest],
          )
        ).rows[0]!.decided,
    );
  assert.equal(await decide(sha256('{}'), fence), false);
  assert.equal(await decide(digest, String(Number(fence) - 1)), false);
  assert.equal(await decide(digest, fence), true);
  assert.equal(await decide(digest, fence), false);
  assert.equal(
    (
      await pool.query<{ decided_by: string }>(
        'SELECT decided_by FROM platform.workflow_pending_approvals WHERE run_id = $1',
        [runId],
      )
    ).rows[0]?.decided_by,
    operator.principalId,
  );
}
