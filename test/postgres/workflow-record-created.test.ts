/**
 * WORKFLOW-2 slice 4b (ADR-0073 A1, recordCreated). A tenant-built clinic
 * Appointment starts a workflow through the same verified machinery as the
 * goods receipt: release declaration, admission, watermark, scoped consumer,
 * pinned run and the generated SDK event. Each creation starts exactly one run
 * per matching workflow, in the record's own company; a creation committed
 * before activation starts nothing.
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
import { COMPANY, worldOver } from '../agent/agent-world.js';
import {
  exerciseWorkflowTriggerReader,
  workflowTriggerPredecessorRelease,
} from '../helpers/workflow-trigger-reader.js';
import { RecordCreatedTriggerSchema } from '../../packages/canonical-model/src/schemas.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

const NS = 'northstar.app';
const appointment = `${NS}:entity.custom_appointment`;
const appointmentName = `${NS}:field.custom_appointment_name`;
const trigger = RecordCreatedTriggerSchema.parse({
  kind: 'recordCreated',
  triggerVersion: 'v1',
  recordTypeId: appointment,
});

test(
  'a tenant record type starts one pinned run per created record, in its own company',
  { timeout: 1_500_000 },
  async () => {
    await withEphemeralPostgres(
      'workflow-record',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://postgres@${String(connection.host)}:${String(connection.port)}/postgres`;
        const tenantSlug = 'workflow-record';
        const compiledApplication = workflowTriggerPredecessorRelease();
        const seeded = await startComposedApplication({
          databaseUrl,
          tenantSlug,
          compiledApplication,
          port: 0,
          seedProfile: 'distributor',
        });
        await seeded.close();
        const runtime = await openComposedApplicationRuntime({
          databaseUrl,
          tenantSlug,
          compiledApplication,
        });
        const customization = await openCustomizeService({
          databaseUrl,
          tenantSlug,
          compiledApplication,
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

          const appointmentType = {
            kind: 'addRecordType',
            label: 'Appointment',
            companyOwnership: 'entityOwned',
            fields: [{ label: 'Name', type: 'text' }],
          };
          const typeDraft = await service.draft(
            appointmentType,
            'declarativeEditor',
          );
          assert.ok(typeDraft.status === 'drafted', JSON.stringify(typeDraft));
          const approval = await service.approve(typeDraft.patchId);
          const compatible = await service.activate(typeDraft.patchId);
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

          // A second company in the SAME tenant: its record's run must act
          // in that company, so the company is never taken from the default.
          const otherCompany = randomUUID();
          await world.invoke('legal_entity_create', {
            recordId: otherCompany,
            values: {
              [`${NS}:field.legal_entity_code`]: 'CLINIC-B',
              [`${NS}:field.legal_entity_name`]: 'Second clinic',
              [`${NS}:field.legal_entity_is_default`]: false,
              [`${NS}:field.legal_entity_status`]: `${NS}:option.legal_entity_status_active`,
            },
          });
          const book = async (company: string, name: string) => {
            const recordId = randomUUID();
            const result = await world.invoke('custom_appointment_create', {
              recordId,
              legalEntityId: company,
              values: { [appointmentName]: name },
            });
            assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
            return recordId;
          };
          // Committed before any workflow subscribes: never fires later.
          const early = await book(COMPANY, 'Booked before the workflow');

          const gateways = new PostgresWorkflowGateway(
            runtimePool,
            INVENTORY_WRITE_INVARIANTS,
          );
          const view = await gateways.loadView(operator);
          const grants = { queries: [], operations: [] };
          const sdk = generateWorkflowSdk(
            view,
            grants,
            undefined,
            undefined,
            trigger,
          );
          assert.match(sdk.declarations, /type TriggerEvent = /u);
          assert.doesNotMatch(sdk.declarations, /ReceiptEvent|receiptId/u);
          const body =
            'if (event.recordTypeId === ' +
            JSON.stringify(appointment) +
            ' && event.recordId.length === 36) sdk.sleep(10);';
          const fixtureEvent = {
            type: 'recordCreated' as const,
            eventId: randomUUID(),
            recordTypeId: trigger.recordTypeId,
            recordId: randomUUID(),
            legalEntityId: COMPANY,
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
                        call: { kind: 'sleep', milliseconds: 10 },
                        result: null,
                      },
                    ],
                  },
                ],
              }),
          );
          // Rule 13: the preceding serving binary answers a query on the
          // Appointment release (byte-identical to its own compile of the
          // recorded change), then refuses the workflow release by name.
          await exerciseWorkflowTriggerReader({
            pool,
            databaseUrl,
            identity: runtime.identity,
            compatibleId: compatible.releaseId,
            compatiblePatch: appointmentType,
            queryId: `${NS}:query.custom_appointment_get`,
            args: {
              recordId: early,
              [`${NS}:parameter.custom_appointment_get_legal_entity_scope`]:
                COMPANY,
            },
            recordId: early,
            declare: async () => {
              const workflowDraft = await service.draft(
                {
                  kind: 'saveWorkflow',
                  workflow: {
                    schemaVersion: 'v6',
                    workflowId: 'appointment-follow-up',
                    trigger,
                    bodyDigest,
                    grants,
                  },
                },
                'conversationalAi',
              );
              assert.ok(
                workflowDraft.status === 'drafted',
                JSON.stringify(workflowDraft),
              );
              await service.approve(
                workflowDraft.patchId,
                workflowDraft.workflowReviewDigest,
              );
              return (await service.activate(workflowDraft.patchId)).releaseId;
            },
          });
          assert.deepEqual(
            (
              await pool.query<{ binding: unknown }>(
                `SELECT w.definition_bindings->'appointment-follow-up'->'recordType' AS binding
                   FROM platform.workflow_activation_watermarks AS w
                   JOIN platform.active_release_pointers AS p USING (tenant_id, environment_id, pointer_id, fence, release_id)
                  WHERE w.tenant_id = $1 AND w.environment_id = $2`,
                [tenantId, environmentId],
              )
            ).rows,
            [{ binding: appointment }],
          );
          // WORKFLOW-3 s1 B4: a recordCreated binding gains no key.
          assert.deepEqual(
            (
              await pool.query<{ keys: string[] }>(
                `SELECT array_agg(k ORDER BY k) AS keys
                   FROM platform.workflow_activation_watermarks AS w
                   JOIN platform.active_release_pointers AS p USING (tenant_id, environment_id, pointer_id, fence, release_id)
                   CROSS JOIN LATERAL jsonb_object_keys(w.definition_bindings->'appointment-follow-up') AS k
                  WHERE w.tenant_id = $1 AND w.environment_id = $2`,
                [tenantId, environmentId],
              )
            ).rows,
            [
              {
                keys: [
                  'digest',
                  'eventType',
                  'recordType',
                  'unattendedOperations',
                ],
              },
            ],
            'a recordCreated approval binding keeps exactly its keys',
          );
          assert.deepEqual(
            await occurrenceDispositions(pool, tenantId, [early]),
            [[early, 'PRE_ACTIVATION']],
            'a creation before activation is sealed out at the watermark',
          );

          const home = await book(COMPANY, 'Check-up');
          const away = await book(otherCompany, 'Follow-up visit');
          const consumer = new PostgresWorkflowConsumer(workerPool);
          assert.equal(await consumer.claim(scope), 2);
          assert.equal(
            await consumer.claim(scope),
            0,
            'a repeated poll starts no second run',
          );
          const instances = (
            await pool.query<{
              trigger_record_id: string;
              legal_entity_id: string;
              record_type: string;
              outbox_id: string | null;
              receipt_id: string | null;
              causation_depth: number;
              run_id: string;
            }>(
              `SELECT i.trigger_record_id, i.legal_entity_id, i.record_type, i.outbox_id,
                      i.receipt_id, i.causation_depth, r.run_id
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
              i.outbox_id,
              i.receipt_id,
              i.causation_depth,
            ]),
            [
              [home, COMPANY, appointment, null, null, 0],
              [away, otherCompany, appointment, null, null, 0],
            ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          );

          // The run re-derives its scope from the occurrence chain and the
          // body sees the generated event: it sleeps only for its own type.
          const execution = new PostgresWorkflowExecution(
            workerPool,
            runtimePool,
            gateways,
          );
          for (const { run_id } of instances) {
            await execution.step(scope, run_id);
            const status = (
              await pool.query<{ status: string; reason: string | null }>(
                'SELECT status, reason FROM platform.workflow_runs WHERE run_id = $1',
                [run_id],
              )
            ).rows[0]!;
            assert.equal(status.status, 'WAITING', JSON.stringify(status));
          }

          // Removing the occurrence chain leaves the run without a verified
          // source: the scope function, not the instance row, is authority.
          const scoped = await withScopedWorker(workerPool, scope, (client) =>
            client.query<{ trigger_record_id: string }>(
              `SELECT s.trigger_record_id FROM platform.workflow_instances AS i
                 CROSS JOIN LATERAL platform.workflow_record_trigger_scope(i.instance_id) AS s
                WHERE i.trigger_record_id = $1`,
              [home],
            ),
          );
          assert.deepEqual(scoped.rows, [{ trigger_record_id: home }]);
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

test(
  'recordCreated runs ask for approval in their own company, link only their trigger type and never restart themselves',
  { timeout: 1_500_000 },
  async () => {
    await withEphemeralPostgres(
      'workflow-record-rules',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://postgres@${String(connection.host)}:${String(connection.port)}/postgres`;
        const tenantSlug = 'workflow-record-rules';
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
          const local = (name: string) => `${NS}:${name}`;
          const followUp = local('entity.custom_follow_up');
          const note = local('entity.custom_clinic_note');
          const followCreate = local('operation.custom_follow_up_create');
          const appointmentCreate = local(
            'operation.custom_appointment_create',
          );
          const followName = local('field.custom_follow_up_name');
          const noteName = local('field.custom_clinic_note_name');
          const toAppointment = local('relation.custom_follow_up_appointment');
          const toNote = local('relation.custom_follow_up_note');
          let livePatch = '';
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
            livePatch = draft.patchId;
            return approval;
          };
          const typed = (label: string) => ({
            kind: 'addRecordType',
            label,
            companyOwnership: 'entityOwned',
            fields: [{ label: 'Name', type: 'text' }],
          });
          const link = (label: string, target: string) => ({
            kind: 'addLink',
            entity: followUp,
            label,
            target,
            required: false,
          });
          // Links are added with their record types, in one change.
          const approval = await activate({
            kind: 'changeSet',
            patches: [
              typed('Appointment'),
              typed('Follow-up'),
              typed('Clinic note'),
              link('Appointment', appointment),
              link('Note', note),
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
          const bindings = [
            ...['create', 'read'].flatMap((action) =>
              [
                'custom_follow_up',
                'custom_appointment',
                'custom_clinic_note',
              ].map((type) => ({
                action,
                permissionId: local(`permission.${type}_${action}`),
                resourceId: local(`entity.${type}`),
              })),
            ),
          ];
          for (const workflowId of [
            'follow-up-approval',
            'note-link',
            'rebook',
          ])
            await provisionLocalDemoAuthorization(
              pool,
              {
                tenantId,
                environmentId,
                principalId: workflowAutomationPrincipal(
                  tenantId,
                  environmentId,
                  workflowId,
                ),
              },
              bindings,
              `workflow-record-${workflowId}`,
            );
          await provisionLocalDemoAuthorization(
            pool,
            operator,
            bindings,
            'workflow-record-approver',
          );

          const gateways = new PostgresWorkflowGateway(
            runtimePool,
            INVENTORY_WRITE_INVARIANTS,
          );
          const view = await gateways.loadView(operator);
          const fixtureEvent = {
            type: 'recordCreated' as const,
            eventId: randomUUID(),
            recordTypeId: trigger.recordTypeId,
            recordId: randomUUID(),
            legalEntityId: COMPANY,
          };
          const readBack = {
            outcome: 'succeeded',
            readBack: {
              recordId: fixtureEvent.recordId,
              revision: 1,
              values: {},
            },
          };
          const followInput = (recordId: string, relation: string) => ({
            recordId,
            legalEntityId: fixtureEvent.legalEntityId,
            values: { [followName]: 'Call back' },
            relations: { [relation]: fixtureEvent.recordId },
          });
          const declare = async (
            workflowId: string,
            operations: string[],
            body: string,
            effects: { call: unknown; result: unknown }[],
          ) => {
            const grants = { queries: [], operations };
            const sdk = generateWorkflowSdk(
              view,
              grants,
              undefined,
              undefined,
              trigger,
            );
            const bodyDigest = await withTrustedRequestTransaction(
              runtimePool,
              operator,
              (client) =>
                storeWorkflowBundle(client, operator, {
                  body,
                  executable: compileWorkflowBody(body, sdk).executable,
                  authoredBy: operator.principalId,
                  fixtures: [{ event: fixtureEvent, effects } as never],
                }),
            );
            await activate(
              {
                kind: 'saveWorkflow',
                workflow: {
                  schemaVersion: 'v6',
                  workflowId,
                  trigger,
                  bodyDigest,
                  grants,
                },
              },
              '',
            );
          };
          const followLiteral = (recordId: string, relation: string) =>
            `{ recordId: ${recordId}, legalEntityId: event.legalEntityId, values: { ${JSON.stringify(followName)}: 'Call back' }, relations: { ${JSON.stringify(relation)}: event.recordId } }`;
          await declare(
            'follow-up-approval',
            [followCreate],
            `if (sdk.requestApproval('Create a follow-up', ${JSON.stringify(followCreate)}, ${followLiteral('event.recordId', toAppointment)})) sdk.operation(${JSON.stringify(followCreate)}, ${followLiteral('event.recordId', toAppointment)});`,
            [
              {
                call: {
                  kind: 'requestApproval',
                  summary: 'Create a follow-up',
                  operationId: followCreate,
                  input: followInput(fixtureEvent.recordId, toAppointment),
                },
                result: true,
              },
              {
                call: {
                  kind: 'operation',
                  id: followCreate,
                  input: followInput(fixtureEvent.recordId, toAppointment),
                },
                result: readBack,
              },
            ],
          );
          // Links a record with the trigger's ID through a relation whose
          // target is ANOTHER type: refused even though the ID matches.
          await declare(
            'note-link',
            [followCreate],
            `sdk.operation(${JSON.stringify(followCreate)}, ${followLiteral('event.eventId', toNote)});`,
            [
              {
                call: {
                  kind: 'operation',
                  id: followCreate,
                  input: followInput(fixtureEvent.eventId, toNote),
                },
                result: readBack,
              },
            ],
          );
          // Creates a record of its own trigger type: the creation it causes
          // must not start this workflow again.
          await declare(
            'rebook',
            [appointmentCreate],
            `sdk.operation(${JSON.stringify(appointmentCreate)}, { recordId: event.eventId, legalEntityId: event.legalEntityId, values: { ${JSON.stringify(appointmentName)}: 'Rebooked' } });`,
            [
              {
                call: {
                  kind: 'operation',
                  id: appointmentCreate,
                  input: {
                    recordId: fixtureEvent.eventId,
                    legalEntityId: fixtureEvent.legalEntityId,
                    values: { [appointmentName]: 'Rebooked' },
                  },
                },
                result: readBack,
              },
            ],
          );

          const otherCompany = randomUUID();
          await world.invoke('legal_entity_create', {
            recordId: otherCompany,
            values: {
              [`${NS}:field.legal_entity_code`]: 'CLINIC-S',
              [`${NS}:field.legal_entity_name`]: 'South clinic',
              [`${NS}:field.legal_entity_is_default`]: false,
              [`${NS}:field.legal_entity_status`]: `${NS}:option.legal_entity_status_active`,
            },
          });
          const create = async (
            operation: string,
            company: string,
            values: Record<string, string>,
            recordId = randomUUID(),
          ) => {
            const result = await world.invoke(operation, {
              recordId,
              legalEntityId: company,
              values,
            });
            assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
            return recordId;
          };
          // A clinic note and an appointment share one ID in the north clinic.
          const shared = await create('custom_clinic_note_create', COMPANY, {
            [noteName]: 'Allergy',
          });
          const north = await create(
            'custom_appointment_create',
            COMPANY,
            { [appointmentName]: 'North visit' },
            shared,
          );
          const south = await create(
            'custom_appointment_create',
            otherCompany,
            {
              [appointmentName]: 'South visit',
            },
          );
          const consumer = new PostgresWorkflowConsumer(workerPool);
          assert.equal(await consumer.claim(scope), 6);
          const execution = new PostgresWorkflowExecution(
            workerPool,
            runtimePool,
            gateways,
          );
          const runOf = async (workflowId: string, recordId: string) =>
            (
              await pool.query<{ run_id: string }>(
                `SELECT r.run_id FROM platform.workflow_runs AS r
                   JOIN platform.workflow_instances AS i USING (tenant_id, environment_id, instance_id, workflow_id)
                  WHERE i.tenant_id = $1 AND i.workflow_id = $2 AND i.trigger_record_id = $3`,
                [tenantId, workflowId, recordId],
              )
            ).rows[0]!.run_id;
          const status = async (runId: string) => {
            const row = (
              await pool.query<{ status: string; reason: string | null }>(
                'SELECT status, reason FROM platform.workflow_runs WHERE run_id = $1',
                [runId],
              )
            ).rows[0]!;
            // The reason rides in the failure message of any status assertion.
            if (row.status === 'SUSPENDED' || row.status === 'QUARANTINED')
              return `${row.status}:${row.reason ?? ''}`;
            return row.status;
          };
          const settle = async (runId: string) => {
            for (let step = 0; step < 4; step += 1) {
              await execution.step(scope, runId);
              if ((await status(runId)) !== 'RUNNABLE') break;
            }
            return status(runId);
          };
          const created = async (type: string, recordId: string) =>
            (
              await pool.query<{ company_id: string }>(
                `SELECT company_id FROM platform.record_creation_occurrences
                  WHERE tenant_id = $1 AND record_type = $2 AND record_id = $3`,
                [tenantId, type, recordId],
              )
            ).rows.map((row) => row.company_id);

          // F4: the link to the note that shares the ID is refused.
          for (const recordId of [north, south]) {
            await settle(await runOf('note-link', recordId));
          }
          assert.equal(
            (
              await pool.query<{ count: number }>(
                `SELECT count(*)::integer AS count FROM platform.trust_action_invocations
                  WHERE tenant_id = $1 AND action_id = $2
                    AND failure_code = 'WORKFLOW_OPERATION_RECEIPT_LINK_REFUSED'`,
                [tenantId, followCreate],
              )
            ).rows[0]!.count,
            2,
            'a link through a relation to another type is refused',
          );

          // F2: approval in the record's own company; approve and deny.
          const waiting = await runOf('follow-up-approval', south);
          assert.equal(await settle(waiting), 'WAITING');
          const plan = (
            await pool.query<{ fence: string; plan_digest: string }>(
              `SELECT fence, plan_digest FROM platform.workflow_pending_approvals
                WHERE run_id = $1 AND status = 'PENDING'`,
              [waiting],
            )
          ).rows[0]!;
          const worklist = (runId = waiting) =>
            withTrustedRequestTransaction(
              runtimePool,
              operator,
              async (client) =>
                (
                  await client.query<{ run_id: string; company_id: string }>(
                    'SELECT run_id, company_id FROM platform.workflow_approval_worklist($1)',
                    [runId],
                  )
                ).rows,
            );
          const decide = (
            runId: string,
            fence: string,
            digest: string,
            decision: 'APPROVED' | 'DECLINED',
          ) =>
            withTrustedRequestTransaction(
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
          const membership = (company: string | null) =>
            pool.query(
              `UPDATE platform.current_policy_memberships SET legal_entity_id = $4
                WHERE tenant_id = $1 AND environment_id = $2 AND principal_id = $3`,
              [tenantId, environmentId, operator.principalId, company],
            );
          try {
            await membership(COMPANY);
            assert.deepEqual(
              await worklist(),
              [],
              'a north approver sees nothing',
            );
            assert.equal(
              await decide(waiting, plan.fence, plan.plan_digest, 'APPROVED'),
              false,
            );
            await membership(otherCompany);
            assert.deepEqual(await worklist(), [
              { run_id: waiting, company_id: otherCompany },
            ]);
            assert.equal(
              await decide(waiting, plan.fence, plan.plan_digest, 'APPROVED'),
              true,
            );
            // The activation approver's grants are re-read at dispatch; the
            // company narrowing above is only for the decision.
            await membership(null);
            assert.equal(await settle(waiting), 'COMPLETED');
            assert.deepEqual(await created(followUp, south), [otherCompany]);

            const declined = await runOf('follow-up-approval', north);
            assert.equal(await settle(declined), 'WAITING');
            const northPlan = (
              await pool.query<{ fence: string; plan_digest: string }>(
                `SELECT fence, plan_digest FROM platform.workflow_pending_approvals
                  WHERE run_id = $1 AND status = 'PENDING'`,
                [declined],
              )
            ).rows[0]!;
            await membership(COMPANY);
            assert.equal(
              await decide(
                declined,
                northPlan.fence,
                northPlan.plan_digest,
                'DECLINED',
              ),
              true,
            );
            await membership(null);
            assert.equal(await settle(declined), 'COMPLETED');
            assert.deepEqual(await created(followUp, north), []);
          } finally {
            await membership(null);
          }

          // F5: the appointment a rebook run creates starts the other
          // workflows one level deeper and never the rebook workflow itself.
          const rebooks = [
            await runOf('rebook', north),
            await runOf('rebook', south),
          ];
          for (const runId of rebooks)
            assert.equal(await settle(runId), 'COMPLETED');
          assert.equal(await consumer.claim(scope), 4);
          const loops = (
            await pool.query<{ workflow_id: string; reason: string }>(
              `SELECT workflow_id, reason FROM platform.workflow_record_start_skips
                WHERE tenant_id = $1 ORDER BY workflow_id`,
              [tenantId],
            )
          ).rows;
          assert.deepEqual(loops, [
            { workflow_id: 'rebook', reason: 'self-caused' },
            { workflow_id: 'rebook', reason: 'self-caused' },
          ]);
          assert.deepEqual(
            (
              await pool.query<{ depth: number; count: number }>(
                `SELECT causation_depth AS depth, count(*)::integer AS count
                   FROM platform.workflow_instances
                  WHERE tenant_id = $1 AND creation_occurrence_id IS NOT NULL
                  GROUP BY causation_depth ORDER BY causation_depth`,
                [tenantId],
              )
            ).rows,
            [
              { depth: 0, count: 6 },
              { depth: 1, count: 4 },
            ],
          );

          // F7: a creation instance a worker forges for another company has no
          // verified scope, so it can neither dispatch nor be approved.
          const forged = await withScopedWorker(
            workerPool,
            scope,
            async (client) => {
              await client.query(
                `INSERT INTO platform.workflow_instances (
                 tenant_id, environment_id, instance_id, event_id, workflow_id, legal_entity_id,
                 trigger_principal_id, trigger_record_id, record_type, creation_occurrence_id)
               SELECT tenant_id, environment_id, gen_random_uuid(), event_id, 'forged', $2,
                      trigger_principal_id, trigger_record_id, record_type, creation_occurrence_id
                 FROM platform.workflow_instances
                WHERE workflow_id = 'follow-up-approval' AND trigger_record_id = $1`,
                [south, COMPANY],
              );
              return (
                await client.query(
                  `SELECT s.* FROM platform.workflow_instances AS i
                   CROSS JOIN LATERAL platform.workflow_record_trigger_scope(i.instance_id) AS s
                  WHERE i.workflow_id = 'forged'`,
                )
              ).rows;
            },
          );
          assert.deepEqual(forged, []);

          // A wait the release switch suspends and staff Retry moves to the new
          // fence keeps its old-fence PENDING row beside the new one; the
          // worklist still lists the approval once, and only the fresh plan
          // decides it.
          const later = await create('custom_appointment_create', COMPANY, {
            [appointmentName]: 'Later visit',
          });
          assert.equal(await consumer.claim(scope), 3);
          const retried = await runOf('follow-up-approval', later);
          assert.equal(await settle(retried), 'WAITING');
          const pendingPlans = async () =>
            (
              await pool.query<{ fence: string; plan_digest: string }>(
                `SELECT fence, plan_digest FROM platform.workflow_pending_approvals
                  WHERE run_id = $1 AND status = 'PENDING' ORDER BY fence`,
                [retried],
              )
            ).rows;
          const [stale] = await pendingPlans();
          assert.ok(stale);
          const pinned = (
            await pool.query<{ release_id: string }>(
              'SELECT release_id FROM platform.workflow_runs WHERE run_id = $1',
              [retried],
            )
          ).rows[0]!.release_id;
          assert.equal((await service.rollback()).status, 'rolledBack');
          const review = await service.reviewWorkflow(livePatch);
          await service.approve(livePatch, review.workflowReviewDigest);
          assert.equal((await service.activate(livePatch)).releaseId, pinned);
          await execution.tick(scope);
          assert.equal(await status(retried), 'SUSPENDED:stale-release-pin');
          assert.deepEqual(
            await execution.remedy(operator, [retried], 'retry'),
            [{ runId: retried, outcome: 'retried' }],
          );
          assert.equal(await settle(retried), 'WAITING');
          const plans = await pendingPlans();
          assert.equal(plans.length, 2, JSON.stringify(plans));
          const fresh = plans[1]!;
          assert.notEqual(fresh.fence, stale.fence);
          const listed = await worklist(retried);
          assert.equal(
            listed.length,
            1,
            `a staff-retried waiting approval is listed exactly once: ${JSON.stringify(listed)}`,
          );
          assert.deepEqual(listed, [{ run_id: retried, company_id: COMPANY }]);
          assert.equal(
            await decide(retried, stale.fence, stale.plan_digest, 'APPROVED'),
            false,
          );
          assert.equal(
            await decide(retried, fresh.fence, fresh.plan_digest, 'APPROVED'),
            true,
          );
          assert.equal(await settle(retried), 'COMPLETED');
          assert.deepEqual(await created(followUp, later), [COMPANY]);
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

/** One migrated database for the schema-level proofs; each test isolates one check. */
async function withMigrated(
  label: string,
  run: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  await withEphemeralPostgres(label, async ({ pool }) => {
    const { loadMigrations, runMigrations } =
      await import('../../packages/postgres-provider/src/migrations.js');
    const client = await pool.connect();
    try {
      await runMigrations(client, await loadMigrations('db/migrations'));
      await client.query(`CREATE TABLE north_star_module.workflow_probe (
        tenant_id uuid, environment_id uuid, legal_entity_id uuid, record_id uuid,
        PRIMARY KEY (tenant_id, environment_id, legal_entity_id, record_id))`);
      await run(client);
    } finally {
      client.release();
    }
  });
}

const probeAction = 'northstar.test:operation.probe_create';
async function governed(
  client: pg.PoolClient,
  action: string | null,
): Promise<string> {
  const tenant = randomUUID();
  await client.query('BEGIN');
  await client.query(
    `SELECT set_config('north_star.tenant_id', $1, true),
            set_config('north_star.environment_id', $1, true),
            set_config('north_star.request_id', $2, true),
            set_config('north_star.creation_action', $3, true)`,
    [tenant, randomUUID(), action ?? ''],
  );
  return tenant;
}
const store = (
  client: pg.PoolClient,
  tenant: string,
  company: string,
  ids: string[],
) =>
  client.query(
    `INSERT INTO north_star_module.workflow_probe
     SELECT $1::uuid, $1::uuid, $2::uuid, unnest($3::uuid[])`,
    [tenant, company, ids],
  );
const claim = (client: pg.PoolClient, company: string, ids: string[]) =>
  client.query(
    `SELECT north_star_internal.record_creations('workflow_probe', 'record_id',
       'northstar.test:entity.probe', $1::uuid, $2::uuid[])`,
    [company, ids],
  );
const occurrences = async (client: pg.PoolClient, tenant: string) =>
  (
    await client.query<{ record_id: string; company_id: string }>(
      `SELECT record_id, company_id FROM platform.record_creation_occurrences
        WHERE tenant_id = $1 ORDER BY record_id, company_id`,
      [tenant],
    )
  ).rows;

test(
  'the start key is the occurrence, so N records from one command cannot collapse into one run',
  { timeout: 300_000 },
  async () => {
    // Before this slice the key was (event, workflow): a second record of the
    // same command collapsed into the first one's run.
    await withMigrated('workflow-start-key', async (client) => {
      const indexes = (
        await client.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes
            WHERE schemaname = 'platform' AND tablename = 'workflow_instances'
              AND indexdef LIKE 'CREATE UNIQUE INDEX%' ORDER BY indexname`,
        )
      ).rows.map((r) => r.indexdef);
      assert.ok(
        indexes.some((d) =>
          /\(tenant_id, environment_id, creation_occurrence_id, workflow_id\) WHERE \(creation_occurrence_id IS NOT NULL\)/u.test(
            d,
          ),
        ),
        JSON.stringify(indexes),
      );
      assert.ok(
        !indexes.some((d) =>
          /\(tenant_id, environment_id, event_id, workflow_id\)$/u.test(d),
        ),
        'no unconditional (event, workflow) key collapses a multi-record command',
      );
    });
  },
);

test(
  'a recordCreated definition digest covers its record type; a receipt keeps its bytes',
  { timeout: 300_000 },
  async () => {
    await withMigrated('workflow-digest', async (client) => {
      const definition = (recordType: string | null) =>
        JSON.stringify({
          tenant_id: randomUUID(),
          environment_id: randomUUID(),
          release_id: randomUUID(),
          workflow_id: 'probe',
          event_type: recordType
            ? 'northstar.runtime:event.record-created'
            : 'northstar.purchasing:event.receipt_posted',
          body_digest: 'b'.repeat(64),
          executable_digest: 'c'.repeat(64),
          sdk_digest: 'd'.repeat(64),
          engine_build: 'engine',
          host_version: 'host',
          sdk_version: 'sdk',
          automation_principal_id: randomUUID(),
          authored_by: randomUUID(),
          grants: { queries: [], operations: [] },
          record_type: recordType,
        });
      const digest = async (recordType: string | null) =>
        (
          await client.query<{ digest: string; legacy: string }>(
            `SELECT platform.workflow_definition_digest(d) AS digest,
                    encode(sha256(convert_to(jsonb_build_array(
                      d.tenant_id, d.environment_id, d.release_id, d.workflow_id, d.event_type,
                      d.body_digest, d.executable_digest, d.sdk_digest, d.engine_build,
                      d.host_version, d.sdk_version, d.automation_principal_id, d.authored_by,
                      d.grants)::text, 'UTF8')), 'hex') AS legacy
               FROM jsonb_populate_record(NULL::platform.workflow_definitions, $1::jsonb) AS d`,
            [definition(recordType)],
          )
        ).rows[0]!;
      const receipt = await digest(null);
      assert.equal(receipt.digest, receipt.legacy);
      const general = await digest('northstar.app:entity.custom_appointment');
      assert.notEqual(general.digest, general.legacy);
    });
  },
);

test(
  'one command creating N records seals N occurrences into one batch on its one event',
  { timeout: 300_000 },
  async () => {
    await withMigrated('workflow-seal', async (client) => {
      const tenant = await governed(client, probeAction);
      const company = randomUUID();
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await store(client, tenant, company, ids);
      await claim(client, company, ids);
      const event = randomUUID();
      // A synthetic outbox row for this command; its trust FKs are deferred
      // and the transaction rolls back before they would fire.
      await client.query(
        `INSERT INTO platform.trust_outbox (
           tenant_id, environment_id, outbox_id, outbox_version, invocation_id, change_document_id,
           domain_event_id, request_id, action_id, correlation_id, release_id, release_content_hash,
           event_type, event_schema_version, deduplication_key)
         VALUES ($1, $1, gen_random_uuid(), 'northstar.trust-outbox/v1', gen_random_uuid(), gen_random_uuid(), $2,
           current_setting('north_star.request_id')::uuid, $3, gen_random_uuid(), gen_random_uuid(),
           repeat('a', 64), 'northstar.test:event.probe_created', 'v1', gen_random_uuid()::text)`,
        [tenant, event, probeAction],
      );
      const batches = (
        await client.query<{ domain_event_id: string; record_count: string }>(
          `SELECT b.domain_event_id, b.record_count::text
             FROM platform.record_creation_batches AS b WHERE b.tenant_id = $1`,
          [tenant],
        )
      ).rows;
      assert.deepEqual(batches, [
        { domain_event_id: event, record_count: '3' },
      ]);
      const linked = (
        await client.query<{ count: number }>(
          `SELECT count(*)::integer AS count
             FROM platform.record_creation_occurrences AS c
             JOIN platform.record_creation_batches AS b
               USING (tenant_id, environment_id, writer_xid, request_id, action_id)
            WHERE c.tenant_id = $1 AND b.domain_event_id = $2`,
          [tenant, event],
        )
      ).rows[0]!.count;
      assert.equal(
        linked,
        3,
        'each record is its own occurrence of the one event',
      );
      // A creation after the seal would never reach a subscriber.
      await assert.rejects(
        claim(client, company, [randomUUID()]),
        /after its command was sealed/u,
      );
      await client.query('ROLLBACK');
    });
  },
);

test('an unsealed occurrence cannot commit', { timeout: 300_000 }, async () => {
  await withMigrated('workflow-unsealed', async (client) => {
    const tenant = await governed(client, probeAction);
    const company = randomUUID();
    const ids = [randomUUID(), randomUUID()];
    await store(client, tenant, company, ids);
    await claim(client, company, ids);
    assert.equal((await occurrences(client, tenant)).length, 2);
    await assert.rejects(client.query('COMMIT'), { code: '23503' });
  });
});

test(
  'a creation is matched in its own company and refused outside a governed write',
  { timeout: 300_000 },
  async () => {
    await withMigrated('workflow-company', async (client) => {
      const tenant = await governed(client, probeAction);
      const [north, south] = [randomUUID(), randomUUID()];
      const shared = randomUUID();
      // North already stores the ID; South creates the same ID.
      await store(client, tenant, north, [shared]);
      await store(client, tenant, south, [shared]);
      await claim(client, south, [shared]);
      assert.deepEqual(await occurrences(client, tenant), [
        { record_id: shared, company_id: south },
      ]);
      // A record this company does not store is refused, never recorded.
      await assert.rejects(
        claim(client, south, [randomUUID()]),
        /not stored in this scope/u,
      );
      await client.query('ROLLBACK');
      await governed(client, null);
      await store(client, tenant, north, [randomUUID()]);
      await assert.rejects(
        claim(client, north, [shared]),
        /outside a governed write/u,
      );
      await client.query('ROLLBACK');
    });
  },
);

async function occurrenceDispositions(
  pool: pg.Pool,
  tenantId: string,
  records: readonly string[],
) {
  return (
    await pool.query<{ record_id: string; disposition: string | null }>(
      `SELECT c.record_id, d.disposition
         FROM platform.record_creation_occurrences AS c
         LEFT JOIN platform.workflow_record_dispositions AS d USING (tenant_id, environment_id, occurrence_id)
        WHERE c.tenant_id = $1 AND c.record_id = ANY($2::uuid[]) ORDER BY c.record_id`,
      [tenantId, records],
    )
  ).rows.map((r) => [r.record_id, r.disposition]);
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
