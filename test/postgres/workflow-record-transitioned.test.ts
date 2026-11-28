/**
 * WORKFLOW-3 slice 1 (ADR-0073 A1, recordTransitioned; owner O1, orchestrator
 * ruling Q3). A tenant Inspection with a declared lifecycle starts a workflow
 * when it moves into Failed: the generic transition writer names the move, the
 * verified consumer claims it once, and the run creates a Repair linked to the
 * inspection in the inspection's own company. Moves into another state, from
 * another state, and creations of the same type start nothing; a move before
 * activation is sealed out. The schema-level proofs isolate the definer, the
 * occurrence key, the created-digest bytes and the grants, one check each.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type pg from 'pg';

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
import { workflowAutomationPrincipal } from '../../packages/postgres-provider/src/workflow-admission.js';
import { compileWorkflowBody } from '../../packages/postgres-provider/src/workflow-compile.js';
import { PostgresWorkflowConsumer } from '../../packages/postgres-provider/src/workflow-consumer.js';
import { PostgresWorkflowExecution } from '../../packages/postgres-provider/src/workflow-execution.js';
import { PostgresWorkflowGateway } from '../../packages/postgres-provider/src/workflow-gateway.js';
import { storeWorkflowBundle } from '../../packages/postgres-provider/src/workflow-bundle.js';
import { generateWorkflowSdk } from '../../packages/postgres-provider/src/workflow-sdk.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import { INVENTORY_WRITE_INVARIANTS } from '../../packages/postgres-provider/src/inventory-write-invariants.js';
import { RecordTransitionedTriggerSchema } from '../../packages/canonical-model/src/schemas.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

const NS = 'northstar.app';
const local = (name: string) => `${NS}:${name}`;
const inspection = local('entity.custom_inspection');
const repair = local('entity.custom_repair');
const inspectionName = local('field.custom_inspection_name');
const repairName = local('field.custom_repair_name');
const repairCreate = local('operation.custom_repair_create');
const toInspection = local('relation.custom_repair_inspection');
const state = (name: string) => local(`state.custom_inspection_${name}`);
const trigger = RecordTransitionedTriggerSchema.parse({
  kind: 'recordTransitioned',
  triggerVersion: 'v1',
  recordTypeId: inspection,
  toStateId: state('failed'),
  fromStateId: state('scheduled'),
});
const WORKFLOW = 'inspection-repair';

test(
  'a tenant lifecycle move starts one pinned run per matching move, in its own company',
  { timeout: 1_500_000 },
  async () => {
    await withEphemeralPostgres(
      'workflow-transition',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://postgres@${String(connection.host)}:${String(connection.port)}/postgres`;
        const tenantSlug = 'workflow-transition';
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
          const service = customization.service;
          const activate = async (patch: unknown, digest?: string) => {
            const draft = await service.draft(
              patch as never,
              digest === undefined ? 'declarativeEditor' : 'conversationalAi',
            );
            assert.ok(draft.status === 'drafted', JSON.stringify(draft));
            const approval = await service.approve(
              draft.patchId,
              ...(digest === undefined ? [] : [draft.workflowReviewDigest]),
            );
            await service.activate(draft.patchId);
            return approval;
          };
          const typed = (label: string) => ({
            kind: 'addRecordType',
            label,
            companyOwnership: 'entityOwned',
            fields: [{ label: 'Name', type: 'text' }],
          });
          const approval = await activate({
            kind: 'changeSet',
            patches: [
              typed('Inspection'),
              typed('Repair'),
              {
                kind: 'addLink',
                entity: repair,
                label: 'Inspection',
                target: inspection,
                required: false,
              },
              {
                kind: 'declareLifecycle',
                entity: inspection,
                initial: 'Scheduled',
                states: [
                  { label: 'Scheduled' },
                  { label: 'Passed' },
                  { label: 'Failed' },
                  { label: 'In progress' },
                ],
                transitions: [
                  { label: 'Pass', from: 'Scheduled', to: 'Passed' },
                  { label: 'Fail', from: 'Scheduled', to: 'Failed' },
                  { label: 'Start', from: 'Scheduled', to: 'In progress' },
                  { label: 'Abandon', from: 'In progress', to: 'Failed' },
                ],
              },
            ],
          });
          const approver = (
            await pool.query<{ approving_human_id: string }>(
              `SELECT approving_human_id FROM platform.release_approvals
                WHERE tenant_id = $1 AND environment_id = $2 AND activation_attempt_id = $3`,
              [tenantId, environmentId, approval.activationAttemptId],
            )
          ).rows[0]!.approving_human_id;
          const operator = await trustedContext({
            tenantId,
            environmentId,
            principalId: approver,
          });
          const bindings = ['create', 'read'].flatMap((action) =>
            ['custom_repair', 'custom_inspection'].map((type) => ({
              action,
              permissionId: local(`permission.${type}_${action}`),
              resourceId: local(`entity.${type}`),
            })),
          );
          await provisionLocalDemoAuthorization(
            pool,
            {
              tenantId,
              environmentId,
              principalId: workflowAutomationPrincipal(
                tenantId,
                environmentId,
                WORKFLOW,
              ),
            },
            bindings,
            'workflow-transition-automation',
          );
          // The activation approver's grants are captured at activation.
          await provisionLocalDemoAuthorization(
            pool,
            operator,
            bindings,
            'workflow-transition-approver',
          );

          // A second company in the SAME tenant.
          const otherCompany = randomUUID();
          await world.invoke('legal_entity_create', {
            recordId: otherCompany,
            values: {
              [local('field.legal_entity_code')]: 'FIELD-B',
              [local('field.legal_entity_name')]: 'Second branch',
              [local('field.legal_entity_is_default')]: false,
              [local('field.legal_entity_status')]: local(
                'option.legal_entity_status_active',
              ),
            },
          });
          const revisions = new Map<string, number>();
          const schedule = async (company: string, name: string) => {
            const recordId = randomUUID();
            const result = await world.invoke('custom_inspection_create', {
              recordId,
              legalEntityId: company,
              values: { [inspectionName]: name },
            });
            assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
            revisions.set(recordId, 1);
            return recordId;
          };
          // Each move goes through the semantic gateway's generic transition.
          const move = async (recordId: string, action: string) => {
            const expectedRevision = revisions.get(recordId)!;
            const result = await world.invoke(
              `custom_inspection_action_${action}`,
              { recordId, expectedRevision },
            );
            assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
            revisions.set(recordId, expectedRevision + 1);
          };

          // Failed before any workflow subscribes: never fires later.
          const early = await schedule(COMPANY, 'Failed before the workflow');
          await move(early, 'fail');

          const gateways = new PostgresWorkflowGateway(
            runtimePool,
            INVENTORY_WRITE_INVARIANTS,
          );
          const view = await gateways.loadView(operator);
          const grants = { queries: [], operations: [repairCreate] };
          const sdk = generateWorkflowSdk(
            view,
            grants,
            undefined,
            undefined,
            trigger,
          );
          assert.match(
            sdk.declarations,
            /type TriggerEvent = Readonly<\{ type: 'recordTransitioned'/u,
          );
          const repairLiteral = `{ recordId: event.eventId, legalEntityId: event.legalEntityId, values: { ${JSON.stringify(repairName)}: 'Repair' }, relations: { ${JSON.stringify(toInspection)}: event.recordId } }`;
          // The body acts only on the move the event names, so a completed
          // repair also proves the event carried both states.
          const body = `if (event.fromStateId === ${JSON.stringify(state('scheduled'))} && event.toStateId === ${JSON.stringify(state('failed'))}) sdk.operation(${JSON.stringify(repairCreate)}, ${repairLiteral});`;
          const fixtureEvent = {
            type: 'recordTransitioned' as const,
            eventId: randomUUID(),
            recordTypeId: inspection,
            recordId: randomUUID(),
            fromStateId: state('scheduled'),
            toStateId: state('failed'),
            legalEntityId: COMPANY,
          };
          const fixtureInput = {
            recordId: fixtureEvent.eventId,
            legalEntityId: fixtureEvent.legalEntityId,
            values: { [repairName]: 'Repair' },
            relations: { [toInspection]: fixtureEvent.recordId },
          };
          const bodyDigest = await withTrustedRequestTransaction(
            runtimePool,
            operator,
            (client) =>
              storeWorkflowBundle(client, operator, {
                body,
                executable: compileWorkflowBody(body, sdk).executable,
                authoredBy: operator.principalId,
                fixtures: [
                  {
                    event: fixtureEvent,
                    effects: [
                      {
                        call: {
                          kind: 'operation',
                          id: repairCreate,
                          input: fixtureInput,
                        },
                        result: {
                          outcome: 'succeeded',
                          readBack: {
                            recordId: fixtureEvent.eventId,
                            revision: 1,
                            values: {},
                          },
                        },
                      },
                    ],
                  } as never,
                ],
              }),
          );
          await activate(
            {
              kind: 'saveWorkflow',
              workflow: {
                schemaVersion: 'v6',
                workflowId: WORKFLOW,
                trigger,
                bodyDigest,
                grants,
              },
            },
            '',
          );
          assert.deepEqual(
            (
              await pool.query<{ binding: unknown }>(
                `SELECT w.definition_bindings->$3->'recordType' AS record_type,
                        w.definition_bindings->$3->'toState' AS to_state,
                        w.definition_bindings->$3->'fromState' AS from_state
                   FROM platform.workflow_activation_watermarks AS w
                   JOIN platform.active_release_pointers AS p USING (tenant_id, environment_id, pointer_id, fence, release_id)
                  WHERE w.tenant_id = $1 AND w.environment_id = $2`,
                [tenantId, environmentId, WORKFLOW],
              )
            ).rows,
            [
              {
                record_type: inspection,
                to_state: state('failed'),
                from_state: state('scheduled'),
              },
            ],
            'the approval binds the record type and both states',
          );
          assert.deepEqual(
            await dispositions(pool, tenantId, [early]),
            [
              [early, 'created', null, 'PRE_ACTIVATION'],
              [early, 'transitioned', state('failed'), 'PRE_ACTIVATION'],
            ],
            'a move before activation is sealed out at the watermark',
          );

          const home = await schedule(COMPANY, 'Roof');
          const away = await schedule(otherCompany, 'Boiler');
          const passed = await schedule(COMPANY, 'Wiring');
          const abandoned = await schedule(COMPANY, 'Drains');
          await move(home, 'fail');
          await move(away, 'fail');
          await move(passed, 'pass');
          await move(abandoned, 'start');
          await move(abandoned, 'abandon');

          const consumer = new PostgresWorkflowConsumer(workerPool);
          assert.equal(
            await consumer.claim(scope),
            2,
            'one matching move per company starts exactly one run',
          );
          assert.equal(
            await consumer.claim(scope),
            0,
            'a repeated poll starts no second run',
          );
          assert.deepEqual(
            await dispositions(pool, tenantId, [home, away, passed, abandoned]),
            [
              [home, 'created', null, 'INELIGIBLE'],
              [home, 'transitioned', state('failed'), 'CLAIMED'],
              [away, 'created', null, 'INELIGIBLE'],
              [away, 'transitioned', state('failed'), 'CLAIMED'],
              [passed, 'created', null, 'INELIGIBLE'],
              [passed, 'transitioned', state('passed'), 'INELIGIBLE'],
              [abandoned, 'created', null, 'INELIGIBLE'],
              [abandoned, 'transitioned', state('failed'), 'INELIGIBLE'],
              [abandoned, 'transitioned', state('in_progress'), 'INELIGIBLE'],
            ].sort(byRow),
            'each occurrence resolves once: matching moves CLAIMED, every other occurrence of the type INELIGIBLE',
          );
          const instances = (
            await pool.query<{
              trigger_record_id: string;
              legal_entity_id: string;
              record_type: string;
              event_id: string;
              run_id: string;
              instance_id: string;
              trigger_principal_id: string;
            }>(
              `SELECT i.trigger_record_id, i.legal_entity_id, i.record_type, i.event_id,
                      r.run_id, i.instance_id, i.trigger_principal_id
                 FROM platform.workflow_instances AS i
                 JOIN platform.workflow_runs AS r USING (tenant_id, environment_id, instance_id, workflow_id)
                WHERE i.tenant_id = $1 ORDER BY i.trigger_record_id`,
              [tenantId],
            )
          ).rows;
          assert.deepEqual(
            instances.map((i) => [
              i.trigger_record_id,
              i.legal_entity_id,
              i.record_type,
            ]),
            [
              [home, COMPANY, inspection],
              [away, otherCompany, inspection],
            ].sort(byRow),
            'each run is in its inspection’s own company',
          );

          // The run re-derives its scope from the occurrence chain, sees the
          // generated recordTransitioned event and creates the linked repair.
          const execution = new PostgresWorkflowExecution(
            workerPool,
            runtimePool,
            gateways,
          );
          for (const { run_id } of instances) {
            for (let step = 0; step < 4; step += 1) {
              await execution.step(scope, run_id);
              const status = (
                await pool.query<{ status: string }>(
                  'SELECT status FROM platform.workflow_runs WHERE run_id = $1',
                  [run_id],
                )
              ).rows[0]!.status;
              if (status !== 'RUNNABLE') break;
            }
          }
          const runs = (
            await pool.query<{ status: string; reason: string | null }>(
              `SELECT status, reason FROM platform.workflow_runs
                WHERE tenant_id = $1 ORDER BY run_id`,
              [tenantId],
            )
          ).rows;
          assert.deepEqual(
            runs.map((r) => r.status),
            ['COMPLETED', 'COMPLETED'],
            JSON.stringify(runs),
          );
          for (const instance of instances)
            assert.deepEqual(
              (
                await pool.query<{ company_id: string }>(
                  `SELECT company_id FROM platform.record_creation_occurrences
                    WHERE tenant_id = $1 AND record_type = $2 AND record_id = $3 AND kind = 'created'`,
                  [tenantId, repair, instance.event_id],
                )
              ).rows.map((r) => r.company_id),
              [instance.legal_entity_id],
              'the repair is created in the inspection’s own company',
            );

          // B7: a worker-forged instance on a move its definition does not
          // name (into Passed) has no trigger scope, so it can neither run,
          // be approved nor be retried; the real instance keeps its scope.
          const passedMove = (
            await pool.query<{ occurrence_id: string; event_id: string }>(
              `SELECT c.occurrence_id, b.domain_event_id AS event_id
                 FROM platform.record_creation_occurrences AS c
                 JOIN platform.record_creation_batches AS b
                   USING (tenant_id, environment_id, writer_xid, request_id, action_id)
                WHERE c.tenant_id = $1 AND c.record_id = $2 AND c.kind = 'transitioned'`,
              [tenantId, passed],
            )
          ).rows[0]!;
          const scopes = await withScopedWorker(
            workerPool,
            scope,
            async (client) => {
              await client.query(
                `INSERT INTO platform.workflow_instances (
                   tenant_id, environment_id, instance_id, event_id, workflow_id, legal_entity_id,
                   trigger_principal_id, trigger_record_id, record_type, creation_occurrence_id)
                 VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, $6, $7, $8, $9)`,
                [
                  tenantId,
                  environmentId,
                  passedMove.event_id,
                  WORKFLOW,
                  COMPANY,
                  instances[0]!.trigger_principal_id,
                  passed,
                  inspection,
                  passedMove.occurrence_id,
                ],
              );
              return (
                await client.query<{
                  trigger_record_id: string;
                  kind: string;
                  from_state: string;
                  to_state: string;
                }>(
                  `SELECT s.trigger_record_id, s.kind, s.from_state, s.to_state
                     FROM platform.workflow_instances AS i
                     CROSS JOIN LATERAL platform.workflow_record_trigger_scope(i.instance_id) AS s
                    WHERE i.trigger_record_id = ANY($1::uuid[])
                    ORDER BY s.trigger_record_id`,
                  [[home, passed]],
                )
              ).rows;
            },
          );
          assert.deepEqual(
            scopes,
            [
              {
                trigger_record_id: home,
                kind: 'transitioned',
                from_state: state('scheduled'),
                to_state: state('failed'),
              },
            ],
            'a run on a move its definition does not name has no trigger scope',
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

/** One migrated database for the schema-level proofs; each subtest isolates one check. */
test(
  'the transition occurrence schema, one check at a time',
  { timeout: 600_000 },
  async (t) => {
    await withEphemeralPostgres(
      'workflow-transition-schema',
      async ({ pool }) => {
        const { loadMigrations, runMigrations } =
          await import('../../packages/postgres-provider/src/migrations.js');
        const client = await pool.connect();
        try {
          await runMigrations(client, await loadMigrations('db/migrations'));
          await client.query(`CREATE TABLE north_star_module.transition_probe (
          tenant_id uuid, environment_id uuid, legal_entity_id uuid, record_id uuid, state text,
          PRIMARY KEY (tenant_id, environment_id, legal_entity_id, record_id))`);
          const action = 'northstar.test:operation.probe_fail';
          const governed = async (marker: string | null) => {
            const tenant = randomUUID();
            await client.query('BEGIN');
            await client.query(
              `SELECT set_config('north_star.tenant_id', $1, true),
                    set_config('north_star.environment_id', $1, true),
                    set_config('north_star.request_id', $2, true),
                    set_config('north_star.creation_action', $3, true)`,
              [tenant, randomUUID(), marker ?? ''],
            );
            return tenant;
          };
          const store = (
            tenant: string,
            company: string,
            record: string,
            at: string,
          ) =>
            client.query(
              `INSERT INTO north_star_module.transition_probe VALUES ($1, $1, $2, $3, $4)`,
              [tenant, company, record, at],
            );
          const transition = (company: string, record: string, to: string) =>
            client.query(
              `SELECT north_star_internal.record_transitions('transition_probe', 'record_id', 'state',
               'northstar.test:entity.probe', $1::uuid, $2::uuid, 'northstar.test:state.scheduled', $3)`,
              [company, record, to],
            );
          const attempt = async (run: () => Promise<unknown>) => {
            await client.query('SAVEPOINT attempt');
            try {
              await run();
              await client.query('RELEASE SAVEPOINT attempt');
            } catch (error) {
              await client.query('ROLLBACK TO SAVEPOINT attempt');
              throw error;
            }
          };
          const occurrences = async (tenant: string) =>
            (
              await client.query<{
                kind: string;
                company_id: string;
                from_state: string | null;
                to_state: string | null;
              }>(
                `SELECT kind, company_id, from_state, to_state FROM platform.record_creation_occurrences
                WHERE tenant_id = $1 ORDER BY kind, to_state`,
                [tenant],
              )
            ).rows;
          const failedState = 'northstar.test:state.failed';

          await t.test(
            'the definer names a move only when the stored row is in the target state',
            async () => {
              try {
                const tenant = await governed(action);
                const company = randomUUID();
                const record = randomUUID();
                await store(
                  tenant,
                  company,
                  record,
                  'northstar.test:state.scheduled',
                );
                await assert.rejects(
                  attempt(() => transition(company, record, failedState)),
                  /a claimed record transition is not stored in this scope/u,
                  'a move the stored row has not made was named',
                );
                await client.query(
                  `UPDATE north_star_module.transition_probe SET state = $2 WHERE record_id = $1`,
                  [record, failedState],
                );
                await transition(company, record, failedState);
                assert.deepEqual(await occurrences(tenant), [
                  {
                    kind: 'transitioned',
                    company_id: company,
                    from_state: 'northstar.test:state.scheduled',
                    to_state: failedState,
                  },
                ]);
              } finally {
                await client.query('ROLLBACK');
              }
            },
          );

          await t.test(
            'the company is the stored row’s own, never another company’s record with the same ID',
            async () => {
              try {
                const tenant = await governed(action);
                const [north, south, record] = [
                  randomUUID(),
                  randomUUID(),
                  randomUUID(),
                ];
                await store(tenant, north, record, failedState);
                await store(
                  tenant,
                  south,
                  record,
                  'northstar.test:state.scheduled',
                );
                await assert.rejects(
                  attempt(() => transition(south, record, failedState)),
                  /a claimed record transition is not stored in this scope/u,
                  'a move was named in a company whose record never made it',
                );
                assert.deepEqual(await occurrences(tenant), []);
              } finally {
                await client.query('ROLLBACK');
              }
            },
          );

          await t.test(
            'one command naming a creation and a move of one record keeps both occurrences',
            async () => {
              try {
                const tenant = await governed(action);
                const company = randomUUID();
                const record = randomUUID();
                await store(tenant, company, record, failedState);
                await client.query(
                  `SELECT north_star_internal.record_creations('transition_probe', 'record_id',
                   'northstar.test:entity.probe', $1::uuid, ARRAY[$2::uuid])`,
                  [company, record],
                );
                await transition(company, record, failedState);
                assert.deepEqual(
                  (await occurrences(tenant)).map((row) => row.kind),
                  ['created', 'transitioned'],
                  'the per-command key separates the kinds',
                );
              } finally {
                await client.query('ROLLBACK');
              }
            },
          );

          await t.test(
            'a move outside a governed write is refused by name',
            async () => {
              try {
                const tenant = await governed(null);
                const company = randomUUID();
                const record = randomUUID();
                await store(tenant, company, record, failedState);
                await assert.rejects(
                  attempt(() => transition(company, record, failedState)),
                  /record transition outside a governed write/u,
                  'a move outside a governed write was named',
                );
              } finally {
                await client.query('ROLLBACK');
              }
            },
          );

          await t.test(
            'a recordCreated definition hashes exactly the bytes it hashed before',
            async () => {
              const definition = (toState: string | null) =>
                JSON.stringify({
                  tenant_id: randomUUID(),
                  environment_id: randomUUID(),
                  release_id: randomUUID(),
                  workflow_id: 'probe',
                  event_type: toState
                    ? 'northstar.runtime:event.record-transitioned'
                    : 'northstar.runtime:event.record-created',
                  body_digest: 'b'.repeat(64),
                  executable_digest: 'c'.repeat(64),
                  sdk_digest: 'd'.repeat(64),
                  engine_build: 'engine',
                  host_version: 'host',
                  sdk_version: 'sdk',
                  automation_principal_id: randomUUID(),
                  authored_by: randomUUID(),
                  grants: { queries: [], operations: [] },
                  record_type: 'northstar.app:entity.custom_inspection',
                  to_state: toState,
                  from_state: null,
                });
              const digest = async (toState: string | null) =>
                (
                  await client.query<{ digest: string; created: string }>(
                    `SELECT platform.workflow_definition_digest(d) AS digest,
                          encode(sha256(convert_to((jsonb_build_array(
                            d.tenant_id, d.environment_id, d.release_id, d.workflow_id, d.event_type,
                            d.body_digest, d.executable_digest, d.sdk_digest, d.engine_build,
                            d.host_version, d.sdk_version, d.automation_principal_id, d.authored_by,
                            d.grants) || jsonb_build_array(d.record_type))::text, 'UTF8')), 'hex') AS created
                     FROM jsonb_populate_record(NULL::platform.workflow_definitions, $1::jsonb) AS d`,
                    [definition(toState)],
                  )
                ).rows[0]!;
              const created = await digest(null);
              assert.equal(
                created.digest,
                created.created,
                'a recordCreated definition hashes exactly the bytes it hashed before',
              );
              const moved = await digest(
                'northstar.app:state.custom_inspection_failed',
              );
              assert.notEqual(moved.digest, moved.created);
            },
          );

          await t.test(
            'the changed definers grant no PUBLIC execute and keep their role grants',
            async () => {
              const grants = (
                await client.query<{
                  fn: string;
                  public_execute: boolean;
                  worker: boolean;
                  runtime: boolean;
                }>(
                  `SELECT p.oid::regprocedure::text AS fn,
                        EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
                                 WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute,
                        has_function_privilege('north_star_workflow_worker', p.oid, 'EXECUTE') AS worker,
                        has_function_privilege('north_star_runtime', p.oid, 'EXECUTE') AS runtime
                   FROM pg_proc AS p
                  WHERE p.oid IN (
                    'north_star_internal.record_transitions(text, text, text, text, uuid, uuid, text, text)'::regprocedure,
                    'platform.workflow_record_creation_page(integer)'::regprocedure,
                    'platform.workflow_record_trigger_scope(uuid)'::regprocedure)
                  ORDER BY 1`,
                )
              ).rows;
              assert.deepEqual(
                grants.map((g) => [g.fn, g.public_execute]),
                grants.map((g) => [g.fn, false]),
                'a changed definer is executable by PUBLIC',
              );
              assert.deepEqual(
                grants.map((g) =>
                  g.fn.startsWith('north_star_internal.')
                    ? g.runtime
                    : g.worker,
                ),
                [true, true, true],
                `each changed definer keeps its role grant: ${JSON.stringify(grants)}`,
              );
            },
          );
        } finally {
          client.release();
        }
      },
    );
  },
);

function byRow(a: readonly unknown[], b: readonly unknown[]): number {
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

async function dispositions(
  pool: pg.Pool,
  tenantId: string,
  records: readonly string[],
) {
  return (
    await pool.query<{
      record_id: string;
      kind: string;
      to_state: string | null;
      disposition: string | null;
    }>(
      `SELECT c.record_id, c.kind, c.to_state, d.disposition
         FROM platform.record_creation_occurrences AS c
         LEFT JOIN platform.workflow_record_dispositions AS d USING (tenant_id, environment_id, occurrence_id)
        WHERE c.tenant_id = $1 AND c.record_id = ANY($2::uuid[])`,
      [tenantId, records],
    )
  ).rows
    .map((r) => [r.record_id, r.kind, r.to_state, r.disposition])
    .sort(byRow);
}

async function withScopedWorker<T>(
  workerPool: pg.Pool,
  scope: { tenant_id: string; environment_id: string },
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await workerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('north_star.tenant_id', $1, true),
              set_config('north_star.environment_id', $2, true)`,
      [scope.tenant_id, scope.environment_id],
    );
    const result = await run(client);
    await client.query('ROLLBACK');
    return result;
  } finally {
    client.release();
  }
}
