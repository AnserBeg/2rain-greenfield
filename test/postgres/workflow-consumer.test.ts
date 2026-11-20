import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalize } from '@north-star/canonical-model';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type pg from 'pg';

import { fieldComparisonValidationDraft } from '../../packages/customization/src/validation-draft.js';
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
import { storeWorkflowBundle } from '../../packages/postgres-provider/src/workflow-bundle.js';
import { InMemoryWorkflowRun } from '../../packages/postgres-provider/src/workflow-run.js';
import { generateWorkflowSdk } from '../../packages/postgres-provider/src/workflow-sdk.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { recordVerifiedWorkflow } from '../../packages/postgres-provider/src/workflow-verification.js';
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
const reviewName = 'northstar.app:field.custom_receipt_review_name';
const contextName = 'northstar.app:field.custom_review_context_name';
const contextRead = 'northstar.app:permission.custom_review_context_read';
const contextEntity = 'northstar.app:entity.custom_review_context';
const contextLink = 'northstar.app:relation.custom_receipt_review_context';
const companyReview = 'northstar.app:operation.custom_company_review_update';
const companyName = 'northstar.app:field.custom_company_review_name';
const excludedRole = 'workflow-receipt-excluded';

test(
  'verified activation and restart-safe receipt consumption with same-pin remedy',
  { timeout: 900_000 },
  async (t) => {
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
          const recordsDraft = await service.draft(
            {
              kind: 'changeSet',
              patches: [
                {
                  kind: 'addRecordType',
                  label: 'Review Context',
                  fields: [{ label: 'Name', type: 'text' }],
                },
                {
                  kind: 'addRecordType',
                  label: 'Receipt Review',
                  fields: [
                    { label: 'Name', type: 'text' },
                    { label: 'Receipt Reference', type: 'text' },
                  ],
                },
                {
                  kind: 'addLink',
                  entity,
                  label: 'Context',
                  target: contextEntity,
                },
                {
                  kind: 'addRecordType',
                  label: 'Company Review',
                  companyOwnership: 'entityOwned',
                  fields: [{ label: 'Name', type: 'text' }],
                },
              ],
            },
            'declarativeEditor',
          );
          assert.ok(
            recordsDraft.status === 'drafted',
            JSON.stringify(recordsDraft),
          );
          await service.approve(recordsDraft.patchId);
          await service.activate(recordsDraft.patchId);
          const validationTarget = (
            await service.targets()
          ).validationTargets?.find((target) => target.entityId === entity);
          assert.ok(validationTarget);
          const validationDraft = await service.draft(
            fieldComparisonValidationDraft(validationTarget, {
              fieldId: reviewName,
              operator: 'notEqual',
              otherFieldId: contextName,
              relationId: contextLink,
              message: 'The review needs a different name from its context.',
            }),
            'declarativeEditor',
          );
          assert.ok(
            validationDraft.status === 'drafted',
            JSON.stringify(validationDraft),
          );
          await service.approve(validationDraft.patchId);
          await service.activate(validationDraft.patchId);

          const foreignCompany = randomUUID();
          await world.invoke('legal_entity_create', {
            recordId: foreignCompany,
            values: {
              'northstar.app:field.legal_entity_code': 'WORKFLOW-B',
              'northstar.app:field.legal_entity_name':
                'Workflow review company',
              'northstar.app:field.legal_entity_is_default': false,
              'northstar.app:field.legal_entity_status':
                'northstar.app:option.legal_entity_status_active',
            },
          });
          const foreignRecord = randomUUID();
          await world.invoke('custom_company_review_create', {
            legalEntityId: foreignCompany,
            recordId: foreignRecord,
            values: { [companyName]: 'Foreign review' },
          });
          await provisionLocalDemoAuthorization(
            pool,
            { tenantId, environmentId, principalId: randomUUID() },
            [],
            excludedRole,
          );
          const draft = await service.draft(
            {
              kind: 'narrowPermission',
              roleKey: excludedRole,
              target: { kind: 'operation', id: operation },
            },
            'declarativeEditor',
          );
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
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
          const bindings = [
            ...['create', 'read'].map((action) => ({
              action,
              permissionId: `northstar.app:permission.custom_receipt_review_${action}`,
              resourceId: entity,
            })),
            {
              action: 'read',
              permissionId: contextRead,
              resourceId: contextEntity,
            },
            {
              action: 'update',
              permissionId:
                'northstar.app:permission.custom_company_review_update',
              resourceId: 'northstar.app:entity.custom_company_review',
            },
          ];
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
          const grants = {
            queries: [],
            operations: [operation, companyReview].sort(),
          };
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
          const createReviewInput = `{ recordId: event.receiptId, values: {
        'northstar.app:field.custom_receipt_review_name': 'Pending',
        'northstar.app:field.custom_receipt_review_receipt_reference': event.receiptId
      }}`;
          const body = `sdk.operation('${operation}', ${createReviewInput});`;
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
          const release = await new PostgresImmutableReleaseRepository(
            runtimePool,
          ).getTenantRelease(operator, enrolled.releaseId);
          assert.ok(release);
          const verify = async (id: string, asRuntime = false) => {
            const definition = (
              await pool.query<{ digest: string }>(
                `SELECT platform.workflow_definition_digest(d) AS digest FROM platform.workflow_definitions AS d
                  WHERE release_id = $1 AND workflow_id = $2`,
                [enrolled.releaseId, id],
              )
            ).rows[0]!;
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              await client.query(
                "SELECT set_config('north_star.tenant_id', $1, true), set_config('north_star.environment_id', $2, true)",
                [tenantId, environmentId],
              );
              await client.query(
                asRuntime
                  ? 'SET LOCAL ROLE north_star_runtime'
                  : 'SET LOCAL ROLE north_star_workflow_verifier',
              );
              await recordVerifiedWorkflow(
                client,
                release,
                { id, digest: definition.digest, grants },
                Buffer.from('{}'),
              );
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          };
          await verify('receipt-review');
          await service.approve(draft.patchId);
          await cloneDefinition(
            pool,
            enrolled.releaseId,
            'late-verified-definition',
            undefined,
            'northstar.app:event.test_only',
          );
          await assert.rejects(verify('late-verified-definition', true), {
            code: '42501',
          });
          await verify('late-verified-definition');
          await service.activate(draft.patchId);
          assert.deepEqual(
            (
              await pool.query<{ workflow_id: string }>(
                `SELECT jsonb_object_keys(w.definition_bindings) AS workflow_id
                 FROM platform.workflow_activation_watermarks AS w
                 JOIN platform.active_release_pointers AS p USING (tenant_id, environment_id, pointer_id, fence, release_id)
                WHERE w.tenant_id = $1 AND w.environment_id = $2`,
                [tenantId, environmentId],
              )
            ).rows,
            [{ workflow_id: 'receipt-review' }],
            'verification after approval cannot change the approved set',
          );
          await t.test(
            'Customize lists only source bound to the live approval',
            async () => {
              assert.deepEqual(await service.workflows(operator), [
                {
                  workflowId: 'receipt-review',
                  body,
                  grants,
                  trigger: 'A goods receipt is posted',
                },
              ]);
              assert.deepEqual(
                await service.workflows(await trustedContext(automation)),
                [],
              );
            },
          );
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

          await t.test(
            'dispatch derives company and receipt from the source event',
            async () => {
              await postReceipt(world);
              const source = await latestReceipt(pool, tenantId);
              const runId = await stageReceiptRun(
                workerPool,
                scope,
                source.outbox_id,
                'receipt-review',
                {
                  companyId: randomUUID(),
                  receiptId: prior.receipt_id,
                },
              );
              let dispatchScope:
                { companyId: string; receiptId: string } | undefined;
              const execution = new PostgresWorkflowExecution(
                workerPool,
                runtimePool,
                wrapGateway(gateways, {
                  async dispatch(pin, call, key) {
                    dispatchScope = {
                      companyId: pin.legal_entity_id,
                      receiptId: pin.receipt_id,
                    };
                    return gateways.dispatch(pin, call, key);
                  },
                }),
              );
              await execution.step(scope, runId);
              await execution.step(scope, runId);
              const { rows } = await pool.query<{ record_id: string }>(
                `SELECT d.record_id FROM platform.workflow_effect_outbox AS e
                JOIN platform.semantic_operation_receipts AS r USING (tenant_id, environment_id, idempotency_key)
                JOIN platform.trust_business_change_documents AS d USING (tenant_id, environment_id, change_document_id)
               WHERE e.run_id = $1`,
                [runId],
              );
              assert.deepEqual(
                { dispatchScope, records: rows },
                {
                  dispatchScope: {
                    companyId: COMPANY,
                    receiptId: source.receipt_id,
                  },
                  records: [{ record_id: source.receipt_id }],
                },
                'worker instance operands must not change the dispatched company or written receipt',
              );
            },
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
          await t.test(
            'R4 activation and rollback finish while workflow replay is stalled',
            async () => {
              try {
                await Promise.race([
                  replayEntered.promise,
                  delayedReplay.then(() => {
                    throw new Error('replay did not reach the runtime load');
                  }),
                ]);
                const switchRelease = (async () => {
                  const rollback = await service.rollback();
                  assert.equal(rollback.status, 'rolledBack');
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
                  await restarted.step(scope, secondRun);
                  assert.equal(await runStatus(pool, secondRun), 'SUSPENDED');
                  assert.deepEqual(
                    await restarted.remedy(operator, [secondRun], 'retry'),
                    [{ runId: secondRun, outcome: 'ineligible' }],
                  );
                  await service.approve(draft.patchId);
                  const activation = await service.activate(draft.patchId);
                  assert.equal(activation.releaseId, enrolled.releaseId);
                  return true;
                })();
                try {
                  assert.equal(
                    await Promise.race([
                      switchRelease,
                      delay(20_000, false, { ref: false }),
                    ]),
                    true,
                    'activation and rollback must complete before workflow replay resumes',
                  );
                } finally {
                  resumeReplay.resolve();
                  await switchRelease;
                }
              } finally {
                resumeReplay.resolve();
                await delayedReplay;
              }
            },
          );
          await t.test(
            'only a recorded human Retry can advance the run fence',
            async () => {
              const { rows } = await pool.query<{
                old_fence: string;
                new_fence: string;
              }>(
                `SELECT r.execution_fence AS old_fence, p.fence AS new_fence
                 FROM platform.workflow_runs AS r
                 JOIN platform.active_release_pointers AS p USING (tenant_id, environment_id, pointer_id)
                WHERE r.run_id = $1`,
                [secondRun],
              );
              const { old_fence: oldFence, new_fence: newFence } = rows[0]!;
              const advance = `UPDATE platform.workflow_runs
                SET execution_fence = $2, status = 'RUNNABLE', reason = NULL WHERE run_id = $1`;
              await assert.rejects(
                withWorkflowTransaction(workerPool, scope, (client) =>
                  client.query(advance, [secondRun, newFence]),
                ),
                { code: '42501' },
                'worker can update the run fence and status directly',
              );
              // Simulate a legacy row advanced before the database grant was revoked.
              await pool.query(advance, [secondRun, newFence]);
              try {
                await restarted.step(scope, secondRun);
                assert.equal(
                  await operationReceiptCount(pool, secondRun),
                  0,
                  'replay dispatched without a human Retry decision',
                );
                assert.equal(
                  await runStatus(pool, secondRun),
                  'SUSPENDED',
                  'replay did not refuse a fence without a human Retry decision',
                );
                const { rows: refusal } = await pool.query<{ reason: string }>(
                  'SELECT reason FROM platform.workflow_runs WHERE run_id = $1',
                  [secondRun],
                );
                assert.equal(refusal[0]?.reason, 'retry-decision-missing');
              } finally {
                await pool.query(
                  `UPDATE platform.workflow_runs
                    SET execution_fence = $2, status = 'SUSPENDED', reason = 'stale-release-pin'
                  WHERE run_id = $1`,
                  [secondRun, oldFence],
                );
              }
            },
          );
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

          await t.test(
            'the pinned role restriction applies to both workflow principals',
            async () => {
              for (const [principal, originalRole] of [
                [automation, 'workflow-receipt-automation'],
                [operator, 'workflow-receipt-approver'],
              ] as const) {
                const runId = await newRun();
                await provisionLocalDemoAuthorization(
                  pool,
                  principal,
                  bindings,
                  excludedRole,
                );
                try {
                  await restarted.step(scope, runId);
                  assert.equal(
                    await operationReceiptCount(pool, runId),
                    0,
                    'the excluded role authorized a workflow write',
                  );
                  assert.equal(await runStatus(pool, runId), 'SUSPENDED');
                } finally {
                  await provisionLocalDemoAuthorization(
                    pool,
                    principal,
                    bindings,
                    originalRole,
                  );
                }
              }
            },
          );

          await t.test(
            'a role gained after activation cannot widen a workflow grant',
            async () => {
              const allowedRole = 'workflow-receipt-approver';
              await service.rollback();
              await provisionLocalDemoAuthorization(
                pool,
                operator,
                bindings,
                excludedRole,
              );
              await service.approve(draft.patchId);
              await service.activate(draft.patchId);
              await provisionLocalDemoAuthorization(
                pool,
                operator,
                bindings,
                allowedRole,
              );
              try {
                const runId = await newRun();
                await restarted.step(scope, runId);
                assert.equal(
                  await operationReceiptCount(pool, runId),
                  0,
                  'a newly allowed role widened the activation grant',
                );
                assert.equal(await runStatus(pool, runId), 'SUSPENDED');
              } finally {
                await service.rollback();
                await service.approve(draft.patchId);
                await service.activate(draft.patchId);
              }
            },
          );

          await t.test(
            'R1 a create with unknown dependencies cannot write without approval',
            async () => {
              const runId = await newRun();
              const missingProof = new PostgresWorkflowExecution(
                workerPool,
                runtimePool,
                wrapGateway(gateways, {
                  dispatch(pin, call, key) {
                    return gateways.dispatch(
                      { ...pin, unattended_operations: {} },
                      call,
                      key,
                    );
                  },
                }),
              );
              try {
                await missingProof.step(scope, runId);
                assert.equal(
                  await operationReceiptCount(pool, runId),
                  0,
                  'a proof-free create must leave no committed operation receipt',
                );
                assert.equal(await runStatus(pool, runId), 'SUSPENDED');
              } finally {
                if ((await runStatus(pool, runId)) === 'RUNNABLE')
                  await restarted.step(scope, runId);
              }
            },
          );

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
                async dispatch() {
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

          await assert.rejects(
            gateways.dispatch(
              dispatchPin,
              {
                kind: 'query',
                id: queryId,
                input: { [companyParameter]: randomUUID() },
              },
              randomUUID(),
            ),
            /query-company-scope-refused/,
          );
          assert.equal(
            (
              await pool.query(
                `SELECT 1 FROM platform.trust_action_invocations WHERE action_id = $1
                AND execution_principal_id = $2 AND outcome = 'DENIED' AND channel = 'WORKFLOW'`,
                [queryId, automation.principalId],
              )
            ).rowCount,
            2,
            'cross-company refusal commits audit evidence before returning',
          );

          const duplicate = await newRun();
          const duplicateReceipt = await latestReceipt(pool, tenantId);
          await world.invoke('custom_receipt_review_create', {
            recordId: duplicateReceipt.receipt_id,
            values: {
              'northstar.app:field.custom_receipt_review_name':
                'Already recorded',
              'northstar.app:field.custom_receipt_review_receipt_reference':
                duplicateReceipt.receipt_id,
            },
          });
          await restarted.step(scope, duplicate);
          assert.equal(await runStatus(pool, duplicate), 'QUARANTINED');
          assert.equal(await operationReceiptCount(pool, duplicate), 0);

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
          await verify('permanent-guest-error');
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
          await t.test(
            'R3 a workflow write cannot outlive the automation actor’s grants',
            async () => {
              await restarted.step(scope, refusedRun);
              await pool.query(
                `UPDATE platform.current_policy_memberships SET revoked_at = clock_timestamp()
                  WHERE tenant_id = $1 AND environment_id = $2 AND principal_id = $3`,
                [tenantId, environmentId, automation.principalId],
              );
              try {
                await restarted.step(scope, refusedRun);
                assert.equal(
                  await operationReceiptCount(pool, refusedRun),
                  0,
                  'an actor without a current grant must leave no committed operation receipt',
                );
                assert.equal(await runStatus(pool, refusedRun), 'SUSPENDED');
                assert.equal(await journalCount(pool, refusedRun, 'RESULT'), 0);
                assert.deepEqual(
                  await restarted.remedy(
                    operator,
                    [refusedRun, firstRun],
                    'cancel',
                  ),
                  [
                    { runId: refusedRun, outcome: 'cancelled' },
                    { runId: firstRun, outcome: 'ineligible' },
                  ],
                );
                assert.equal(await runStatus(pool, refusedRun), 'CANCELLED');
              } finally {
                await provisionLocalDemoAuthorization(
                  pool,
                  automation,
                  bindings,
                  'workflow-receipt-automation',
                );
              }
            },
          );
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
            const manager = await scheduled.runtime.entry.run(
              { headers: { cookie: 'northstar-demo-actor=manager' } },
              (view) => view.principalId,
            );
            assert.equal(
              (
                await pool.query<{ eligible: boolean }>(
                  `SELECT eligible FROM platform.release_approver_eligibility_events
                  WHERE tenant_id = $1 AND principal_id = $2
                  ORDER BY policy_version DESC LIMIT 1`,
                  [tenantId, manager],
                )
              ).rows[0]?.eligible,
              true,
              'the opt-in Manager can decide workflow plans within current operation grants',
            );
            const approvals = await fetch(`${scheduled.baseUrl}/?approvals`, {
              headers: { cookie: 'northstar-demo-actor=manager' },
            });
            assert.equal(approvals.status, 200);
            assert.match(await approvals.text(), /<h1>Approvals<\/h1>/u);
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

          await service.rollback();
          await cloneDefinition(
            pool,
            enrolled.releaseId,
            'human-approval',
            compileWorkflowBody(
              `if (sdk.requestApproval('Escalate', '${operation}', ${createReviewInput})) { ${body} }`,
              sdk,
            ).executable,
          );
          await verify('human-approval');
          const foreignWorkflow = 'approval-for-foreign-record';
          await cloneDefinition(
            pool,
            enrolled.releaseId,
            foreignWorkflow,
            compileWorkflowBody(
              `sdk.requestApproval('Update company review', '${companyReview}', ${JSON.stringify(
                {
                  recordId: foreignRecord,
                  expectedRevision: 1,
                  patch: { [companyName]: 'Review escalated' },
                },
              )});`,
              sdk,
            ).executable,
          );
          await verify(foreignWorkflow);

          const validatedWorkflow = 'review-with-context';
          await cloneDefinition(
            pool,
            enrolled.releaseId,
            validatedWorkflow,
            compileWorkflowBody(
              `sdk.operation('${operation}', {
                ...${createReviewInput}, relations: { '${contextLink}': event.receiptId }
              });`,
              sdk,
            ).executable,
          );
          await verify(validatedWorkflow);
          await service.approve(draft.patchId);
          await service.activate(draft.patchId);
          const startRun = async (workflowId: string) => {
            await postReceipt(world);
            const receipt = await latestReceipt(pool, tenantId);
            assert.equal(await consumer.claim(scope), 5);
            const runId = await runFor(pool, receipt.outbox_id, workflowId);
            return { runId, receiptId: receipt.receipt_id };
          };
          const startApproval = async (workflowId = 'human-approval') => {
            const { runId } = await startRun(workflowId);
            await restarted.step(scope, runId);
            assert.equal(await runStatus(pool, runId), 'WAITING');
            return runId;
          };

          await t.test(
            'a workflow create uses intersected authority for validation reads',
            async () => {
              const createLinked = async (contextLabel: string) => {
                const { runId, receiptId } = await startRun(validatedWorkflow);
                // Use the receipt ID to correlate the shared validation operand.
                await world.invoke('custom_review_context_create', {
                  recordId: receiptId,
                  values: { [contextName]: contextLabel },
                });
                await restarted.step(scope, runId);
                await restarted.step(scope, runId);
                return runId;
              };
              const valid = await createLinked('Ready for review');
              assert.equal(
                await operationReceiptCount(pool, valid),
                1,
                'a valid workflow create could not read its validation operand',
              );
              const invalid = await createLinked('Pending');
              assert.equal(await operationReceiptCount(pool, invalid), 0);
              assert.equal(await runStatus(pool, invalid), 'QUARANTINED');

              await provisionLocalDemoAuthorization(
                pool,
                automation,
                bindings.filter(
                  ({ permissionId }) => permissionId !== contextRead,
                ),
                'workflow-without-context-read',
              );
              try {
                const denied = await createLinked('Ready for review');
                assert.equal(await operationReceiptCount(pool, denied), 0);
                assert.equal(await runStatus(pool, denied), 'QUARANTINED');
              } finally {
                await provisionLocalDemoAuthorization(
                  pool,
                  automation,
                  bindings,
                  'workflow-receipt-automation',
                );
              }
            },
          );

          const forged = await startApproval();
          await writeAdversarialApprovalResult(workerPool, scope, forged, true);
          // Corrupt the run as an administrator to exercise replay's independent check.
          await pool.query(
            "UPDATE platform.workflow_runs SET status = 'RUNNABLE' WHERE run_id = $1",
            [forged],
          );
          await restarted.step(scope, forged);
          assert.equal(await runStatus(pool, forged), 'QUARANTINED');
          assert.equal(await journalCount(pool, forged, 'REQUEST'), 1);

          const declined = await startApproval();
          await writeAdversarialApprovalResult(
            workerPool,
            scope,
            declined,
            true,
          );
          await assertApprovalBoundary(
            pool,
            workerPool,
            runtimePool,
            operator,
            declined,
            'DECLINED',
          );
          await restarted.step(scope, declined);
          assert.equal(await runStatus(pool, declined), 'COMPLETED');
          assert.equal(await journalCount(pool, declined, 'REQUEST'), 1);

          const accepted = await startApproval();
          await writeAdversarialApprovalResult(
            workerPool,
            scope,
            accepted,
            false,
          );
          await assertApprovalBoundary(
            pool,
            workerPool,
            runtimePool,
            operator,
            accepted,
            'APPROVED',
          );
          await restarted.step(scope, accepted);
          assert.equal(await journalCount(pool, accepted, 'REQUEST'), 2);

          const ordinary = await startApproval();
          await assertApprovalBoundary(
            pool,
            workerPool,
            runtimePool,
            operator,
            ordinary,
            'APPROVED',
          );
          assert.equal(await journalCount(pool, ordinary, 'RESULT'), 1);
          await restarted.step(scope, ordinary);
          assert.equal(await journalCount(pool, ordinary, 'REQUEST'), 2);

          await t.test(
            'same-pin Retry asks for fresh approval before an uncommitted effect',
            async () => {
              const runId = await startApproval();
              const previous = await pendingApproval(pool, runId);
              assert.equal(
                await decideApproval(
                  runtimePool,
                  operator,
                  runId,
                  previous.plan_digest,
                  previous.fence,
                  'APPROVED',
                ),
                true,
              );
              await restarted.step(scope, runId);
              assert.equal(await journalCount(pool, runId, 'REQUEST'), 2);
              await service.rollback();
              await restarted.step(scope, runId);
              assert.equal(await runStatus(pool, runId), 'SUSPENDED');
              await service.approve(draft.patchId);
              await service.activate(draft.patchId);

              assert.deepEqual(
                await restarted.remedy(operator, [runId], 'retry'),
                [{ runId, outcome: 'retried' }],
              );
              await restarted.step(scope, runId);
              assert.equal(
                await runStatus(pool, runId),
                'WAITING',
                'retry quarantined historical approval instead of requesting a fresh decision',
              );
              assert.equal(await operationReceiptCount(pool, runId), 0);
              const fresh = await pendingApproval(pool, runId);
              assert.notEqual(fresh.fence, previous.fence);
              assert.notEqual(fresh.plan_digest, previous.plan_digest);
              assert.equal(
                await decideApproval(
                  runtimePool,
                  operator,
                  runId,
                  previous.plan_digest,
                  previous.fence,
                  'APPROVED',
                ),
                false,
              );
              assert.equal(
                await decideApproval(
                  runtimePool,
                  operator,
                  runId,
                  fresh.plan_digest,
                  fresh.fence,
                  'APPROVED',
                ),
                true,
              );
              await restarted.step(scope, runId);
              assert.equal(await operationReceiptCount(pool, runId), 1);
              assert.equal(await journalCount(pool, runId, 'RESULT'), 2);
            },
          );

          await t.test(
            'a shared approval needs a global grant for the exact action',
            async () => {
              const authorityProbe = await startApproval();
              const plan = await pendingApproval(pool, authorityProbe);
              const decide = () =>
                decideApproval(
                  runtimePool,
                  operator,
                  authorityProbe,
                  plan.plan_digest,
                  plan.fence,
                  'APPROVED',
                );
              const list = () =>
                withTrustedRequestTransaction(
                  runtimePool,
                  operator,
                  async (client) =>
                    (
                      await client.query<{ run_id: string }>(
                        'SELECT run_id FROM platform.workflow_approval_worklist($1)',
                        [authorityProbe],
                      )
                    ).rows,
                );
              const setCompany = (company: string | null) =>
                pool.query(
                  `UPDATE platform.current_policy_memberships SET legal_entity_id = $4
                WHERE tenant_id = $1 AND environment_id = $2 AND principal_id = $3`,
                  [tenantId, environmentId, operator.principalId, company],
                );
              const setCreateGrant = (revoked: boolean) =>
                pool.query(
                  `UPDATE platform.current_policy_permission_grants AS grant_row
                  SET revoked_at = CASE WHEN $5 THEN clock_timestamp() ELSE NULL END
                 FROM platform.current_policy_memberships AS membership
                WHERE (grant_row.tenant_id, grant_row.environment_id, grant_row.role_id) =
                      (membership.tenant_id, membership.environment_id, membership.role_id)
                  AND membership.tenant_id = $1 AND membership.environment_id = $2
                  AND membership.principal_id = $3 AND grant_row.permission_id = $4`,
                  [
                    tenantId,
                    environmentId,
                    operator.principalId,
                    bindings[0]!.permissionId,
                    revoked,
                  ],
                );
              try {
                await setCompany(COMPANY);
                assert.equal(
                  await decide(),
                  false,
                  'a company-scoped release approver decided a shared plan',
                );
                assert.deepEqual(await list(), []);
                await setCompany(null);
                await setCreateGrant(true);
                assert.equal(
                  await decide(),
                  false,
                  'a release approver without the exact action grant recorded a decision',
                );
                assert.deepEqual(await list(), []);
                assert.equal(
                  await journalCount(pool, authorityProbe, 'RESULT'),
                  0,
                );
                assert.equal(await runStatus(pool, authorityProbe), 'WAITING');
                await setCreateGrant(false);
                assert.deepEqual(await list(), [{ run_id: authorityProbe }]);
              } finally {
                await setCreateGrant(false);
                await setCompany(null);
              }
            },
          );

          await t.test(
            'the worklist and decision use the target record’s stored owner',
            async () => {
              const runId = await startApproval(foreignWorkflow);
              const plan = await pendingApproval(pool, runId);
              const decide = () =>
                decideApproval(
                  runtimePool,
                  operator,
                  runId,
                  plan.plan_digest,
                  plan.fence,
                  'APPROVED',
                );
              const list = () =>
                withTrustedRequestTransaction(
                  runtimePool,
                  operator,
                  async (client) =>
                    (
                      await client.query<{ run_id: string }>(
                        'SELECT run_id FROM platform.workflow_approval_worklist($1)',
                        [runId],
                      )
                    ).rows,
                );
              const setCompany = (company: string | null) =>
                pool.query(
                  `UPDATE platform.current_policy_memberships SET legal_entity_id = $4
                  WHERE tenant_id = $1 AND environment_id = $2 AND principal_id = $3`,
                  [tenantId, environmentId, operator.principalId, company],
                );
              try {
                await setCompany(COMPANY);
                assert.equal(
                  await decide(),
                  false,
                  'the receipt company authorized a foreign target',
                );
                assert.deepEqual(await list(), []);
                assert.equal(await journalCount(pool, runId, 'RESULT'), 0);
                await setCompany(foreignCompany);
                assert.deepEqual(await list(), [{ run_id: runId }]);
                assert.equal(await decide(), true);
                assert.equal(await journalCount(pool, runId, 'RESULT'), 1);
              } finally {
                await setCompany(null);
              }

              await world.invoke('custom_company_review_create', {
                legalEntityId: COMPANY,
                recordId: foreignRecord,
                values: { [companyName]: 'Review with the same ID' },
              });
              const ambiguous = await startApproval(foreignWorkflow);
              const ambiguousPlan = await pendingApproval(pool, ambiguous);
              assert.equal(
                await decideApproval(
                  runtimePool,
                  operator,
                  ambiguous,
                  ambiguousPlan.plan_digest,
                  ambiguousPlan.fence,
                  'APPROVED',
                ),
                false,
                'a plan with an ambiguous record ID recorded a decision',
              );
              assert.equal(await journalCount(pool, ambiguous, 'RESULT'), 0);
            },
          );

          await t.test(
            'R2 a definition verified after approval cannot enter replay',
            async () => {
              const id = 'late-approved-probe';
              await cloneDefinition(pool, enrolled.releaseId, id);
              await verify(id);
              await postReceipt(world);
              const source = await latestReceipt(pool, tenantId);
              const runId = await stageReceiptRun(
                workerPool,
                scope,
                source.outbox_id,
                id,
              );
              const execution = new PostgresWorkflowExecution(
                workerPool,
                runtimePool,
                wrapGateway(gateways, {
                  async loadView() {
                    throw new Error(
                      'a definition verified after approval reached replay',
                    );
                  },
                }),
              );
              await execution.step(scope, runId);
              assert.equal(await runStatus(pool, runId), 'SUSPENDED');
              assert.equal(await journalCount(pool, runId, 'REQUEST'), 0);
            },
          );

          await t.test(
            'a restarted worker wakes a durable timer once at its business deadline',
            async () => {
              const workflowId = 'receipt-timer';
              const start = '2026-11-19T17:30:00.000Z';
              const due = '2026-11-21T17:30:00.000Z';
              let instant = new Date(start);
              const worker = () =>
                new PostgresWorkflowExecution(
                  workerPool,
                  runtimePool,
                  gateways,
                  undefined,
                  () => instant,
                );
              await service.rollback();
              await cloneDefinition(
                pool,
                enrolled.releaseId,
                workflowId,
                compileWorkflowBody(
                  `if (sdk.now() !== '${start}') throw new Error('clock changed');
                 sdk.sleep(172_800_000);`,
                  sdk,
                ).executable,
              );
              await verify(workflowId);
              await service.approve(draft.patchId);
              await service.activate(draft.patchId);
              await postReceipt(world);
              const receipt = await latestReceipt(pool, tenantId);
              assert.ok(await consumer.claim(scope));
              const run = await runFor(pool, receipt.outbox_id, workflowId);
              const original = worker();
              await original.step(scope, run);
              await original.step(scope, run);
              assert.equal(await runStatus(pool, run), 'WAITING');
              assert.equal(
                (
                  await pool.query<{ due_at: Date }>(
                    'SELECT due_at FROM platform.workflow_timers WHERE run_id = $1 AND cursor = 1',
                    [run],
                  )
                ).rows[0]?.due_at.toISOString(),
                due,
              );

              const rebooted = worker();
              instant = new Date('2026-11-21T17:29:59.999Z');
              await rebooted.tick(scope);
              assert.equal(await journalCount(pool, run, 'RESULT'), 1);
              assert.equal(await runStatus(pool, run), 'WAITING');
              instant = new Date(due);
              await Promise.all([rebooted.tick(scope), worker().tick(scope)]);
              await rebooted.step(scope, run);
              assert.equal(await journalCount(pool, run, 'RESULT'), 2);
              await rebooted.step(scope, run);
              assert.equal(await runStatus(pool, run), 'COMPLETED');
              assert.equal(await journalCount(pool, run, 'REQUEST'), 2);

              instant = new Date(start);
              await postReceipt(world);
              const outgoing = await latestReceipt(pool, tenantId);
              assert.ok(await consumer.claim(scope));
              const stale = await runFor(pool, outgoing.outbox_id, workflowId);
              await rebooted.step(scope, stale);
              await rebooted.step(scope, stale);
              assert.equal(await runStatus(pool, stale), 'WAITING');
              await service.rollback();
              instant = new Date(due);
              await worker().tick(scope);
              assert.equal(await runStatus(pool, stale), 'SUSPENDED');
              assert.equal(await journalCount(pool, stale, 'RESULT'), 1);
            },
          );

          const fixtureGrants = { queries: [], operations: [] };
          const fixtureBody = 'sdk.sleep(10);';
          const fixtureDigest = await withTrustedRequestTransaction(
            runtimePool,
            operator,
            (client) =>
              storeWorkflowBundle(client, operator, {
                body: fixtureBody,
                executable: compileWorkflowBody(
                  fixtureBody,
                  generateWorkflowSdk(view, fixtureGrants),
                ).executable,
                authoredBy: operator.principalId,
                fixtures: [
                  {
                    event: {
                      type: 'goodsReceiptPosted',
                      eventId: randomUUID(),
                      receiptId: randomUUID(),
                      legalEntityId: COMPANY,
                    },
                    effects: [
                      {
                        call: { kind: 'sleep', milliseconds: 10 },
                        result: null,
                      },
                    ],
                  },
                ],
              }),
          );
          const workflowPatch = (workflowId: string) => ({
            kind: 'saveWorkflow' as const,
            workflow: {
              schemaVersion: 'v6' as const,
              workflowId,
              trigger: 'goodsReceiptPosted' as const,
              bodyDigest: fixtureDigest,
              grants: fixtureGrants,
            },
          });
          await t.test(
            'candidate admission refuses post-fixture replay divergence',
            async () => {
              const candidate = await service.draft(
                workflowPatch('divergent-replay'),
                'conversationalAi',
              );
              assert.ok(
                candidate.status === 'drafted',
                JSON.stringify(candidate),
              );
              const step = InMemoryWorkflowRun.prototype.step;
              const firstPass = new WeakSet<InMemoryWorkflowRun>();
              const divergence = t.mock.method(
                InMemoryWorkflowRun.prototype,
                'step',
                async function (this: InMemoryWorkflowRun) {
                  if (!firstPass.has(this) && this.snapshot().prefix.length > 0)
                    return {
                      kind: 'quarantined',
                      cursor: 0,
                      reason: 'changed-request',
                    } as const;
                  firstPass.add(this);
                  return step.call(this);
                },
              );
              try {
                await assert.rejects(
                  service.approve(candidate.patchId),
                  /Workflow replay failed at cursor 0 \(quarantined\)/u,
                  'candidate was admitted without running the recorded fixture again',
                );
              } finally {
                divergence.mock.restore();
              }
            },
          );

          await t.test(
            'candidate admission refuses incomplete workflow evidence',
            async () => {
              const complete = await service.draft(
                workflowPatch('complete-evidence'),
                'conversationalAi',
              );
              assert.ok(
                complete.status === 'drafted',
                JSON.stringify(complete),
              );
              await service.approve(complete.patchId);
              await service.activate(complete.patchId);
              const candidate = await service.draft(
                workflowPatch('missing-evidence'),
                'conversationalAi',
              );
              assert.ok(
                candidate.status === 'drafted',
                JSON.stringify(candidate),
              );
              await pool.query(`
              CREATE FUNCTION platform.test_skip_workflow_evidence() RETURNS trigger
              LANGUAGE plpgsql AS $test$
              BEGIN
                IF NEW.workflow_id = 'missing-evidence' THEN RETURN NULL; END IF;
                RETURN NEW;
              END
              $test$;
              CREATE TRIGGER test_skip_workflow_evidence
                BEFORE INSERT ON platform.workflow_verification_evidence
                FOR EACH ROW EXECUTE FUNCTION platform.test_skip_workflow_evidence();
            `);
              try {
                await assert.rejects(
                  service.approve(candidate.patchId),
                  /Workflow verification evidence is incomplete or does not match the candidate/u,
                  'candidate was admitted with one declared workflow missing evidence',
                );
                const { rows } = await pool.query<{ workflow_ids: string[] }>(
                  `SELECT array_agg(w.workflow_id ORDER BY w.workflow_id) AS workflow_ids
                   FROM platform.tenant_releases AS r
                   JOIN platform.release_verification_evidence AS e
                     USING (tenant_id, environment_id, verification_evidence_id)
                   JOIN platform.workflow_verification_evidence AS w
                     USING (tenant_id, environment_id, verification_evidence_id)
                  WHERE r.release_id = $1
                  GROUP BY e.verification_evidence_id`,
                  [candidate.releaseId],
                );
                assert.deepEqual(rows, [
                  { workflow_ids: ['complete-evidence'] },
                ]);
              } finally {
                await pool.query(`
                DROP TRIGGER test_skip_workflow_evidence ON platform.workflow_verification_evidence;
                DROP FUNCTION platform.test_skip_workflow_evidence();
              `);
                await service.rollback();
              }
            },
          );

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
          assert.deepEqual(
            await revokeDuringBulk.remedy(
              operator,
              [refusedRun, firstRun],
              'cancel',
            ),
            [
              { runId: refusedRun, outcome: 'ineligible' },
              { runId: firstRun, outcome: 'refused' },
            ],
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

async function stageReceiptRun(
  workerPool: pg.Pool,
  scope: { tenant_id: string; environment_id: string },
  outboxId: string,
  workflowId: string,
  substitute?: { companyId: string; receiptId: string },
): Promise<string> {
  const instanceId = randomUUID();
  const runId = randomUUID();
  await withWorkflowTransaction(workerPool, scope, async (client) => {
    const binding = await client.query<{
      pointer_id: string;
      fence: string;
      release_id: string;
      release_root: string;
    }>(`
      SELECT p.pointer_id, p.fence, p.release_id, w.release_root
        FROM platform.workflow_read_pointer() AS p
        JOIN platform.workflow_activation_watermarks AS w USING (pointer_id, fence, release_id)
    `);
    const pin = binding.rows[0]!;
    await client.query(
      `INSERT INTO platform.workflow_event_occurrences (tenant_id, environment_id, outbox_id, pointer_id, fence, disposition)
       VALUES ($1, $2, $3, $4, $5, 'CLAIMED')`,
      [
        scope.tenant_id,
        scope.environment_id,
        outboxId,
        pin.pointer_id,
        pin.fence,
      ],
    );
    const instance = await client.query(
      `INSERT INTO platform.workflow_instances (
         tenant_id, environment_id, instance_id, outbox_id, event_id, workflow_id,
         legal_entity_id, receipt_id, trigger_principal_id
       )
       SELECT e.tenant_id, e.environment_id, $4, e.outbox_id, e.domain_event_id, $5,
              COALESCE($6::uuid, (e.payload #>> '{legalEntityId,value}')::uuid),
              COALESCE($7::uuid, d.record_id::uuid), d.execution_principal_id
         FROM platform.trust_domain_events AS e
         JOIN platform.trust_business_change_documents AS d USING (tenant_id, environment_id, change_document_id)
        WHERE e.tenant_id = $1 AND e.environment_id = $2 AND e.outbox_id = $3`,
      [
        scope.tenant_id,
        scope.environment_id,
        outboxId,
        instanceId,
        workflowId,
        substitute?.companyId ?? null,
        substitute?.receiptId ?? null,
      ],
    );
    assert.equal(instance.rowCount, 1);
    await client.query(
      `INSERT INTO platform.workflow_runs (
         tenant_id, environment_id, run_id, instance_id, workflow_id, pointer_id,
         release_id, release_root, initial_fence, execution_fence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [
        scope.tenant_id,
        scope.environment_id,
        runId,
        instanceId,
        workflowId,
        pin.pointer_id,
        pin.release_id,
        pin.release_root,
        pin.fence,
      ],
    );
  });
  return runId;
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

async function runFor(
  pool: pg.Pool,
  outbox: string,
  id = 'receipt-review',
): Promise<string> {
  const result = await pool.query<{ run_id: string }>(
    `SELECT r.run_id FROM platform.workflow_runs AS r
      JOIN platform.workflow_instances AS i USING (tenant_id, environment_id, instance_id)
     WHERE i.outbox_id = $1 AND r.workflow_id = $2`,
    [outbox, id],
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
  eventType?: string,
) {
  await pool.query(
    `INSERT INTO platform.workflow_definitions
     SELECT tenant_id, environment_id, release_id, $2, COALESCE($5, event_type), body_digest,
            COALESCE($3, executable), COALESCE($4, executable_digest),
            sdk_digest, engine_build, host_version, sdk_version,
            automation_principal_id, authored_by, grants
       FROM platform.workflow_definitions WHERE release_id = $1 AND workflow_id = 'receipt-review'`,
    [
      releaseId,
      id,
      executable === undefined ? null : Buffer.from(executable),
      executable === undefined ? null : sha256(executable),
      eventType ?? null,
    ],
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

async function writeAdversarialApprovalResult(
  workerPool: pg.Pool,
  scope: { tenant_id: string; environment_id: string },
  runId: string,
  result: boolean,
) {
  await withWorkflowTransaction(workerPool, scope, async (client) => {
    await client.query(
      `INSERT INTO platform.workflow_journal (tenant_id, environment_id, run_id, cursor, kind, canonical_bytes)
        VALUES ($1, $2, $3, 0, 'RESULT', convert_to($4, 'UTF8'))`,
      [scope.tenant_id, scope.environment_id, runId, String(result)],
    );
  });
}

async function assertApprovalBoundary(
  pool: pg.Pool,
  workerPool: pg.Pool,
  runtimePool: pg.Pool,
  operator: Awaited<ReturnType<typeof trustedContext>>,
  runId: string,
  decision: 'APPROVED' | 'DECLINED',
) {
  const scope = {
    tenant_id: operator.tenantId,
    environment_id: operator.environmentId,
  };
  const { fence, plan_digest: digest } = await pendingApproval(pool, runId);
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
  });
  const decide = (planDigest: string, activeFence: string) =>
    decideApproval(
      runtimePool,
      operator,
      runId,
      planDigest,
      activeFence,
      decision,
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

async function pendingApproval(pool: pg.Pool, runId: string) {
  const result = await pool.query<{ fence: string; plan_digest: string }>(
    'SELECT fence, plan_digest FROM platform.workflow_pending_approvals WHERE run_id = $1',
    [runId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function decideApproval(
  runtimePool: pg.Pool,
  operator: Awaited<ReturnType<typeof trustedContext>>,
  runId: string,
  digest: string,
  fence: string,
  decision: 'APPROVED' | 'DECLINED',
) {
  return withTrustedRequestTransaction(
    runtimePool,
    operator,
    async (client) =>
      (
        await client.query<{ decided: boolean }>(
          'SELECT platform.workflow_decide_approval($1, 0, $2, $3, $4) AS decided',
          [runId, fence, digest, decision],
        )
      ).rows[0]!.decided,
  );
}
