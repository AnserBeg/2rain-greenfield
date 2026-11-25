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
  rolePool,
  trustedContext,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { compileWorkflowBody } from '../../packages/postgres-provider/src/workflow-compile.js';
import { PostgresWorkflowConsumer } from '../../packages/postgres-provider/src/workflow-consumer.js';
import { PostgresWorkflowExecution } from '../../packages/postgres-provider/src/workflow-execution.js';
import { PostgresWorkflowGateway } from '../../packages/postgres-provider/src/workflow-gateway.js';
import { storeWorkflowBundle } from '../../packages/postgres-provider/src/workflow-bundle.js';
import { generateWorkflowSdk } from '../../packages/postgres-provider/src/workflow-sdk.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import { INVENTORY_WRITE_INVARIANTS } from '../../packages/postgres-provider/src/inventory-write-invariants.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
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
  { timeout: 900_000 },
  async () => {
    await withEphemeralPostgres(
      'workflow-record',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://postgres@${String(connection.host)}:${String(connection.port)}/postgres`;
        const tenantSlug = 'workflow-record';
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

          const typeDraft = await service.draft(
            {
              kind: 'addRecordType',
              label: 'Appointment',
              companyOwnership: 'entityOwned',
              fields: [{ label: 'Name', type: 'text' }],
            },
            'declarativeEditor',
          );
          assert.ok(typeDraft.status === 'drafted', JSON.stringify(typeDraft));
          const approval = await service.approve(typeDraft.patchId);
          await service.activate(typeDraft.patchId);
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
          await service.activate(workflowDraft.patchId);
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
  'the start key is the occurrence: one command creating N records starts N runs, a duplicate none',
  { timeout: 300_000 },
  async () => {
    // The schema contract the consumer relies on. Before this slice the key
    // was (event, workflow), so a second record of the same command collapsed.
    await withEphemeralPostgres('workflow-start-key', async ({ pool }) => {
      const { loadMigrations, runMigrations } =
        await import('../../packages/postgres-provider/src/migrations.js');
      const client = await pool.connect();
      try {
        await runMigrations(client, await loadMigrations('db/migrations'));
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

        // The digest of a receipt definition is the pre-slice formula; the
        // record type of a general member is covered, so it cannot be swapped.
        const definition = (recordType: string | null) =>
          JSON.stringify({
            tenant_id: randomUUID(),
            environment_id: randomUUID(),
            release_id: randomUUID(),
            workflow_id: 'probe',
            event_type: recordType
              ? 'northstar.platform:event.record-created'
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

        // An occurrence written under a creation action that no outbox row
        // seals cannot commit; without an action nothing is recorded.
        await client.query(`CREATE TABLE north_star_module.workflow_probe (
          tenant_id uuid, environment_id uuid, record_id uuid, legal_entity_id uuid)`);
        await client.query(`CREATE TRIGGER record_creation AFTER INSERT ON north_star_module.workflow_probe
          FOR EACH ROW EXECUTE FUNCTION north_star_internal.capture_record_creation('northstar.test:entity.probe')`);
        const insert = async (action: string | null) => {
          const tenant = randomUUID();
          await client.query('BEGIN');
          await client.query(
            `SELECT set_config('north_star.tenant_id', $1, true),
                    set_config('north_star.environment_id', $1, true),
                    set_config('north_star.request_id', $2, true),
                    set_config('north_star.creation_action', $3, true)`,
            [tenant, randomUUID(), action ?? ''],
          );
          await client.query(
            `INSERT INTO north_star_module.workflow_probe
             SELECT $1::uuid, $1::uuid, gen_random_uuid(), gen_random_uuid() FROM generate_series(1, 2)`,
            [tenant],
          );
          const recorded = (
            await client.query<{ count: number }>(
              'SELECT count(*)::integer AS count FROM platform.record_creation_occurrences WHERE tenant_id = $1',
              [tenant],
            )
          ).rows[0]!.count;
          return { recorded, commit: () => client.query('COMMIT') };
        };
        const unsealed = await insert('northstar.test:operation.probe_create');
        assert.equal(unsealed.recorded, 2, 'one occurrence per inserted row');
        await assert.rejects(unsealed.commit(), { code: '23503' });
        const ungoverned = await insert(null);
        assert.equal(ungoverned.recorded, 0);
        await ungoverned.commit();
      } finally {
        client.release();
      }
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
