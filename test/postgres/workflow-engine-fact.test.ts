/**
 * WORKFLOW-3 slice 1b (ADR-0073 A1 engineFactChanged). A rental agreement (a
 * sales order that owns Booking commitments) starts a workflow when one of its
 * bookings is confirmed: Booking's history writer names the state change in
 * its own transaction, the verified consumer claims it once, and the run
 * creates a Prep task linked to the agreement in the agreement's own company.
 * A hold (a create), a cancel, a replayed confirm and a confirm before
 * activation start nothing. In the same database, one check each: the timer
 * sweep runs with no tenant scope and still expires and names every hold
 * (E2), the receipt seal, the per-revision key, the grant, the writer census
 * (E8) and the fact-aware trigger scope (E4/E5).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type pg from 'pg';

import {
  openComposedApplicationRuntime,
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  narrowAcknowledgementToDeclared,
  readUnboundPermissionAcknowledgementFor,
} from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  BOOKING_CAPABILITY,
  BOOKING_COMMITMENT_STATE_FACT,
  BOOKING_COMMITMENT_VALUES,
  parseAuthoredApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import { EngineFactChangedTriggerSchema } from '../../packages/canonical-model/src/schemas.js';
import {
  compileApplicationRelease,
  expectedActiveReleaseFrom,
  MODULE_COMPILER_PROFILE,
} from '../../packages/compiler/src/index.js';
import { serializeRelease } from '../../packages/customization/src/index.js';
import {
  parseCompiledApplication,
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
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import { compilerInput, normalizedBytes } from '../compiler/helpers.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

const NS = 'northstar.app';
const local = (name: string) => `${NS}:${name}`;
const AUTHORED = 'apps/web/release/app.authored.json';
const order = local('entity.sales_order');
const task = local('entity.custom_prep_task');
const taskName = local('field.custom_prep_task_name');
const taskCreate = local('operation.custom_prep_task_create');
const toRental = local('relation.custom_prep_task_rental');
const value = BOOKING_COMMITMENT_VALUES;
const fact = BOOKING_COMMITMENT_STATE_FACT;
const trigger = EngineFactChangedTriggerSchema.parse({
  kind: 'engineFactChanged',
  triggerVersion: 'v1',
  factId: fact,
  recordTypeId: order,
  toValueId: value.confirmed,
});
const WORKFLOW = 'rental-prep';
const ref = (kind: string, targetId: string) => ({
  kind,
  targetId,
  schemaVersion: 'v6',
});

/**
 * The first-party release plus three Booking operations (hold, confirm,
 * cancel) whose owner and resource are the sales order: a rental agreement
 * reserving a unit. No permission is added.
 */
function engineFactRelease(): unknown {
  const source = parseAuthoredApplicationPackageJson(
    readFileSync(AUTHORED, 'utf8'),
  );
  const read = source.queries.find(
    (q) => q.queryId === local('query.sales_order_get'),
  )!;
  const release = source.operations.find(
    (o) => o.operationId === local('operation.sales_order_release'),
  )!;
  const requirement = source.capabilityRequirements.find(
    (c) => c.capabilityId === 'northstar.sales:capability.fulfillment',
  )!;
  const operations = (['hold', 'confirm', 'cancel'] as const).map((verb) => ({
    ...release,
    operationId: local(`operation.${verb}_rental`),
    ...(verb === 'hold' ? {} : { confirmation: 'humanRequired' as const }),
    readBack: ref('queryReference', read.queryId),
    precondition: {
      kind: 'booleanPredicate',
      schemaVersion: 'v6',
      value: true,
    },
    effect: {
      kind: 'registeredCapabilityEffect',
      schemaVersion: 'v6',
      capability: ref('capabilityReference', BOOKING_CAPABILITY),
    },
    booking: {
      bindingVersion: 'booking.commitment/v1',
      declarationRevision: local('revision.rental_unit'),
      slotRevision: local('revision.rental_slot'),
      slotId: local('slot.rental'),
      ownerEntity: order,
      resourceEntity: order,
      ownerReadPermission: read.permission.targetId,
      resourceReadPermission: read.permission.targetId,
      operation: verb,
      kind: 'unit',
      fulfilmentMode: 'tracked',
      unit: 'each',
      scale: 0,
      maxBackdateDays: 1,
      holdSeconds: 900,
    },
  }));
  const bytes = normalizedBytes({
    ...source,
    operations: [...source.operations, ...operations],
    capabilityRequirements: [
      ...source.capabilityRequirements,
      {
        ...requirement,
        capabilityId: BOOKING_CAPABILITY,
        declaredEffects: ['appendFact'],
      },
    ],
  });
  const prior = parseCompiledApplication(
    JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
  );
  const input = compilerInput(
    bytes,
    expectedActiveReleaseFrom(prior.application.compiled),
  );
  const compiled = compileApplicationRelease(
    {
      ...input,
      profile: {
        ...MODULE_COMPILER_PROFILE,
        languageVersion: source.languageVersion,
        normalizationProfileVersion: input.profile.normalizationProfileVersion,
      },
    },
    narrowAcknowledgementToDeclared(
      readUnboundPermissionAcknowledgementFor(
        AUTHORED,
        source.package.packageId,
      ),
      new Set(source.permissions.map((p) => p.permissionId)),
    ),
  );
  assert.ok(
    compiled.status === 'compiled',
    JSON.stringify(compiled.diagnostics),
  );
  return {
    schemaVersion: 'northstar.web:compiled-application-release/v2',
    bootstrap: serializeRelease(prior.bootstrap),
    applications: [
      ...prior.applications.map(serializeRelease),
      serializeRelease({ compiled, normalizedDefinitionBytes: bytes }),
    ],
  };
}

test(
  'a confirmed booking starts one linked task per company through its owner record',
  { timeout: 1_800_000 },
  async (t) => {
    await withEphemeralPostgres(
      'workflow-engine-fact',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://postgres@${String(connection.host)}:${String(connection.port)}/postgres`;
        const tenantSlug = 'workflow-engine-fact';
        const compiledApplication = engineFactRelease();
        const seeded = await startComposedApplication({
          databaseUrl,
          tenantSlug,
          compiledApplication,
          port: 0,
          seedProfile: 'demo',
        });
        const customer = seeded.seededRecords.find(
          (r) => r.operationId === local('operation.party_create'),
        )!.recordId;
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
          const approval = await activate({
            kind: 'changeSet',
            patches: [
              {
                kind: 'addRecordType',
                label: 'Prep task',
                companyOwnership: 'entityOwned',
                fields: [{ label: 'Name', type: 'text' }],
              },
              {
                kind: 'addLink',
                entity: task,
                label: 'Rental',
                target: order,
                required: false,
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
          const bindings = [
            ...['create', 'read'].map((action) => ({
              action,
              permissionId: local(`permission.custom_prep_task_${action}`),
              resourceId: task,
            })),
            {
              action: 'read',
              permissionId: local('permission.sales_order_read'),
              resourceId: order,
            },
          ];
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
            'workflow-engine-fact-automation',
          );
          await provisionLocalDemoAuthorization(
            pool,
            operator,
            bindings,
            'workflow-engine-fact-approver',
          );

          // A second company in the SAME tenant.
          const otherCompany = randomUUID();
          await world.invoke('legal_entity_create', {
            recordId: otherCompany,
            values: {
              [local('field.legal_entity_code')]: 'RENT-B',
              [local('field.legal_entity_name')]: 'Second yard',
              [local('field.legal_entity_is_default')]: false,
              [local('field.legal_entity_status')]: local(
                'option.legal_entity_status_active',
              ),
            },
          });
          const agreement = async (company: string) => {
            const recordId = randomUUID();
            const result = await world.invoke('sales_order_create', {
              recordId,
              legalEntityId: company,
              values: {
                [local('field.sales_order_customer_party_id')]: customer,
                [local('field.sales_order_order_date')]:
                  new Date().toISOString(),
                [local('field.sales_order_currency')]: 'CAD',
              },
            });
            assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
            return { company, recordId };
          };
          const revisionOf = (owner: { company: string; recordId: string }) =>
            runtime.entry.run(
              { headers: { cookie: 'northstar-demo-actor=manager' } },
              async (view) =>
                (
                  await runtime.queryGateway.invoke(view, {
                    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
                    queryId: local('query.sales_order_get'),
                    arguments: {
                      recordId: owner.recordId,
                      [local('parameter.sales_order_get_legal_entity_scope')]:
                        owner.company,
                    },
                  })
                ).records[0]!.revision,
            );
          const until = () =>
            new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16);
          type Booked = { bookingId: string; revision: number; state: string };
          const book = async (
            verb: 'hold' | 'confirm' | 'cancel',
            owner: { company: string; recordId: string },
            args: Record<string, string | number | Record<string, string>>,
            idempotencyKey?: string,
          ) => {
            const result = await world.invoke(
              `${verb}_rental`,
              {
                recordId: owner.recordId,
                expectedRevision: await revisionOf(owner),
                arguments: args,
              },
              idempotencyKey === undefined ? {} : { idempotencyKey },
            );
            assert.equal(result.outcome, 'succeeded', JSON.stringify(result));
            return result.capabilityResult as Booked;
          };
          const hold = async (owner: { company: string; recordId: string }) => {
            const unit = await agreement(owner.company);
            return book('hold', owner, {
              resourceId: unit.recordId,
              quantity: '1',
              interval: { kind: 'now', end: until() },
            });
          };
          const step = (b: Booked) => ({
            bookingId: b.bookingId,
            bookingRevision: b.revision,
          });

          // Confirmed before any workflow subscribes: never fires later.
          const early = await agreement(COMPANY);
          await book('confirm', early, step(await hold(early)));

          const gateways = new PostgresWorkflowGateway(
            runtimePool,
            INVENTORY_WRITE_INVARIANTS,
          );
          const view = await gateways.loadView(operator);
          const grants = { queries: [], operations: [taskCreate] };
          const sdk = generateWorkflowSdk(
            view,
            grants,
            undefined,
            undefined,
            trigger,
          );
          assert.match(
            sdk.declarations,
            /type TriggerEvent = Readonly<\{ type: 'engineFactChanged'/u,
          );
          const taskLiteral = `{ recordId: event.subjectId, legalEntityId: event.legalEntityId, values: { ${JSON.stringify(taskName)}: 'Prep' }, relations: { ${JSON.stringify(toRental)}: event.recordId } }`;
          // The body acts only on the change the event names, so a created
          // task also proves the event carried the fact and both values.
          const body = `if (event.factId === ${JSON.stringify(fact)} && event.fromValueId === ${JSON.stringify(value.hold)} && event.toValueId === ${JSON.stringify(value.confirmed)}) sdk.operation(${JSON.stringify(taskCreate)}, ${taskLiteral});`;
          const fixtureEvent = {
            type: 'engineFactChanged' as const,
            eventId: randomUUID(),
            factId: fact,
            recordTypeId: order,
            recordId: randomUUID(),
            subjectId: randomUUID(),
            fromValueId: value.hold,
            toValueId: value.confirmed,
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
                        call: {
                          kind: 'operation',
                          id: taskCreate,
                          input: {
                            recordId: fixtureEvent.subjectId,
                            legalEntityId: fixtureEvent.legalEntityId,
                            values: { [taskName]: 'Prep' },
                            relations: { [toRental]: fixtureEvent.recordId },
                          },
                        },
                        result: {
                          outcome: 'succeeded',
                          readBack: {
                            recordId: fixtureEvent.subjectId,
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
              await pool.query(
                `SELECT w.definition_bindings->$3->>'recordType' AS record_type,
                        w.definition_bindings->$3->>'factId' AS fact_id,
                        w.definition_bindings->$3->>'toState' AS to_state,
                        w.definition_bindings->$3 ? 'fromState' AS pinned_from
                   FROM platform.workflow_activation_watermarks AS w
                   JOIN platform.active_release_pointers AS p USING (tenant_id, environment_id, pointer_id, fence, release_id)
                  WHERE w.tenant_id = $1 AND w.environment_id = $2`,
                [tenantId, environmentId, WORKFLOW],
              )
            ).rows,
            [
              {
                record_type: order,
                fact_id: fact,
                to_state: value.confirmed,
                pinned_from: false,
              },
            ],
            'the approval binds the owner type, the fact and the value',
          );
          assert.deepEqual(
            await factDispositions(pool, tenantId, [early.recordId]),
            [[early.recordId, value.hold, value.confirmed, 'PRE_ACTIVATION']],
            'a confirm before activation is sealed out at the watermark',
          );

          const home = await agreement(COMPANY);
          const away = await agreement(otherCompany);
          const dropped = await agreement(COMPANY);
          const homeHold = await hold(home);
          const replayKey = randomUUID();
          const homeConfirm = await book(
            'confirm',
            home,
            step(homeHold),
            replayKey,
          );
          // A replayed confirm returns the stored receipt and writes nothing.
          const replayed = await book(
            'confirm',
            home,
            step(homeHold),
            replayKey,
          );
          assert.deepEqual(
            [replayed.bookingId, replayed.revision, replayed.state],
            [homeConfirm.bookingId, homeConfirm.revision, 'confirmed'],
          );
          const awayHold = await hold(away);
          await book('confirm', away, step(awayHold));
          await book('cancel', dropped, step(await hold(dropped)));

          const consumer = new PostgresWorkflowConsumer(workerPool);
          assert.equal(
            await consumer.claim(scope),
            2,
            'one confirm per company starts exactly one run',
          );
          assert.equal(
            await consumer.claim(scope),
            0,
            'a repeated poll starts no second run',
          );
          assert.deepEqual(
            await factDispositions(pool, tenantId, [
              home.recordId,
              away.recordId,
              dropped.recordId,
            ]),
            [
              [home.recordId, value.hold, value.confirmed, 'CLAIMED'],
              [away.recordId, value.hold, value.confirmed, 'CLAIMED'],
              [dropped.recordId, value.hold, value.cancelled, 'INELIGIBLE'],
            ].sort(byRow),
            'each change is named once: confirms CLAIMED, a cancel INELIGIBLE, a hold and a replay name nothing',
          );
          const instances = (
            await pool.query<{
              trigger_record_id: string;
              legal_entity_id: string;
              record_type: string;
              run_id: string;
              instance_id: string;
              trigger_principal_id: string;
              event_id: string;
            }>(
              `SELECT i.trigger_record_id, i.legal_entity_id, i.record_type, r.run_id, i.instance_id,
                      i.trigger_principal_id, i.event_id
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
              [home.recordId, COMPANY, order],
              [away.recordId, otherCompany, order],
            ].sort(byRow),
            'each run is in its agreement’s own company',
          );

          const execution = new PostgresWorkflowExecution(
            workerPool,
            runtimePool,
            gateways,
          );
          for (const { run_id } of instances) {
            for (let attempt = 0; attempt < 4; attempt += 1) {
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
            'each run completes on its re-derived trigger scope',
          );
          assert.deepEqual(
            (
              await pool.query<{ record_id: string; company_id: string }>(
                `SELECT record_id, company_id FROM platform.record_creation_occurrences
                  WHERE tenant_id = $1 AND record_type = $2 AND kind = 'created'`,
                [tenantId, task],
              )
            ).rows
              .map((r) => [r.record_id, r.company_id])
              .sort(byRow),
            [
              [homeHold.bookingId, COMPANY],
              [awayHold.bookingId, otherCompany],
            ].sort(byRow),
            'one prep task per confirmed booking, in the agreement’s own company',
          );

          // E4/E5: the real run's scope comes through its own invocation; a
          // worker-forged instance on the cancel (a value the definition does
          // not name) has no scope, so it can neither run nor be approved.
          const cancelled = (
            await pool.query<{ occurrence_id: string; event_id: string }>(
              `SELECT c.occurrence_id, i.domain_event_id AS event_id
                 FROM platform.record_creation_occurrences AS c
                 JOIN platform.trust_action_invocations AS i
                   USING (tenant_id, environment_id, invocation_id)
                WHERE c.tenant_id = $1 AND c.record_id = $2 AND c.kind = 'engineFact'`,
              [tenantId, dropped.recordId],
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
                  cancelled.event_id,
                  WORKFLOW,
                  COMPANY,
                  instances[0]!.trigger_principal_id,
                  dropped.recordId,
                  order,
                  cancelled.occurrence_id,
                ],
              );
              return (
                await client.query(
                  `SELECT s.trigger_record_id, s.kind, s.fact_id, s.subject_id, s.from_state, s.to_state
                     FROM platform.workflow_instances AS i
                     CROSS JOIN LATERAL platform.workflow_record_trigger_scope(i.instance_id) AS s
                    WHERE i.trigger_record_id = ANY($1::uuid[])
                    ORDER BY s.trigger_record_id`,
                  [[home.recordId, dropped.recordId]],
                )
              ).rows;
            },
          );
          assert.deepEqual(
            scopes,
            [
              {
                trigger_record_id: home.recordId,
                kind: 'engineFact',
                fact_id: fact,
                subject_id: homeHold.bookingId,
                from_state: value.hold,
                to_state: value.confirmed,
              },
            ],
            'a fact run’s scope names its own fact and value, and no other change has one',
          );

          await t.test(
            'the timer sweep with no tenant scope expires every due hold and names each change',
            async () => {
              const first = await agreement(COMPANY);
              const second = await agreement(otherCompany);
              const firstHold = await hold(first);
              const secondHold = await hold(second);
              // The production clock is private; tests replace it only in
              // their isolated database. A day later every hold is due.
              await pool.query(`CREATE OR REPLACE FUNCTION north_star_internal.booking_now() RETURNS timestamptz
                LANGUAGE sql VOLATILE SET search_path = pg_catalog, pg_temp AS $$ SELECT clock_timestamp() + interval '1 day' $$`);
              // The worker's bare query: no tenant, environment or principal.
              await workerPool.query(
                'SELECT platform.booking_sweep_due($1)',
                [16],
              );
              assert.deepEqual(
                (
                  await pool.query<{ booking_id: string; state: string }>(
                    `SELECT booking_id, state FROM platform.booking_commitments
                      WHERE booking_id = ANY($1::uuid[])`,
                    [[firstHold.bookingId, secondHold.bookingId]],
                  )
                ).rows
                  .map((r) => [r.booking_id, r.state])
                  .sort(byRow),
                [
                  [firstHold.bookingId, 'cancelled'],
                  [secondHold.bookingId, 'cancelled'],
                ].sort(byRow),
                'the sweep expires the hold in each company',
              );
              assert.deepEqual(
                (
                  await pool.query<{
                    subject_id: string;
                    company_id: string;
                    to_state: string;
                  }>(
                    `SELECT subject_id, company_id, to_state FROM platform.record_creation_occurrences
                      WHERE kind = 'engineFact' AND subject_id = ANY($1::uuid[])`,
                    [[firstHold.bookingId, secondHold.bookingId]],
                  )
                ).rows
                  .map((r) => [r.subject_id, r.company_id, r.to_state])
                  .sort(byRow),
                [
                  [firstHold.bookingId, COMPANY, value.cancelled],
                  [secondHold.bookingId, otherCompany, value.cancelled],
                ].sort(byRow),
                'each timer change is named in its owner’s company, with no tenant scope',
              );
            },
          );

          const owner = (
            await pool.query<{
              table_name: string;
              invocation_id: string;
            }>(
              `SELECT c.invocation_id,
                      (SELECT value->>'physicalTableName'
                         FROM jsonb_array_elements(north_star_internal.booking_projection(
                           c.tenant_id, c.environment_id, i.release_id, 'storageTargetPayload')->'entities')
                        WHERE value->>'entityId' = c.record_type) AS table_name
                 FROM platform.record_creation_occurrences AS c
                 JOIN platform.trust_action_invocations AS i USING (tenant_id, environment_id, invocation_id)
                WHERE c.tenant_id = $1 AND c.record_id = $2 AND c.kind = 'engineFact'`,
              [tenantId, home.recordId],
            )
          ).rows[0]!;
          const name = (
            client: pg.PoolClient | pg.Pool,
            invocation: string,
            subject: string,
          ) =>
            client.query(
              `SELECT north_star_internal.engine_facts($1, $2, $3, $4, $5, 'record_id', $6, $7, $8, $9, 1, $10, $11)`,
              [
                tenantId,
                environmentId,
                fact,
                invocation,
                owner.table_name,
                order,
                COMPANY,
                home.recordId,
                subject,
                value.hold,
                value.confirmed,
              ],
            );

          await t.test(
            'a fact whose receipt is never written refuses commit',
            async () => {
              const client = await pool.connect();
              const subject = randomUUID();
              try {
                await client.query('BEGIN');
                await name(client, randomUUID(), subject);
                await assert.rejects(
                  client.query('COMMIT'),
                  /record_occurrences_fact_invocation/u,
                  'a fact with no receipt committed',
                );
              } finally {
                await client.query('ROLLBACK').catch(() => undefined);
                client.release();
              }
              assert.equal(
                (
                  await pool.query(
                    'SELECT 1 FROM platform.record_creation_occurrences WHERE subject_id = $1',
                    [subject],
                  )
                ).rowCount,
                0,
                'nothing of the refused fact remains',
              );
            },
          );

          await t.test(
            'one occurrence per fact, subject and revision',
            async () => {
              const client = await pool.connect();
              const subject = randomUUID();
              try {
                await client.query('BEGIN');
                await name(client, owner.invocation_id, subject);
                await assert.rejects(
                  name(client, owner.invocation_id, subject),
                  /record_occurrences_fact_key/u,
                  'a second occurrence of one revision was named',
                );
              } finally {
                await client.query('ROLLBACK');
                client.release();
              }
            },
          );

          await t.test('no runtime role may name an engine fact', async () => {
            for (const role of [
              'north_star_runtime',
              'north_star_module_runtime',
              'north_star_workflow_worker',
            ]) {
              const rolePoolFor = rolePool(databaseUrl, role, 1);
              try {
                await assert.rejects(
                  name(rolePoolFor, owner.invocation_id, randomUUID()),
                  /permission denied for function engine_facts/u,
                  `${role} named an engine fact directly`,
                );
              } finally {
                await rolePoolFor.end();
              }
            }
          });

          await t.test(
            'every live writer of booking history names its state change',
            async () => {
              const writers = (
                await pool.query<{ name: string; names: boolean }>(
                  `SELECT p.proname AS name, p.prosrc LIKE '%booking_emit_state_fact(%' AS names
                     FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
                    WHERE n.nspname IN ('platform', 'north_star_internal')
                      AND p.prosrc ~* 'INSERT\\s+INTO\\s+platform\\.booking_history'
                    ORDER BY p.proname`,
                )
              ).rows;
              assert.deepEqual(
                writers,
                [
                  { name: 'booking_record_change', names: true },
                  { name: 'booking_record_kit', names: true },
                ],
                'a history writer does not name its state change',
              );
              assert.match(
                (
                  await pool.query<{ src: string }>(
                    `SELECT prosrc AS src FROM pg_proc WHERE proname = 'booking_emit_state_fact'`,
                  )
                ).rows[0]!.src,
                /north_star_internal\.engine_facts\(/u,
              );
            },
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

function byRow(a: readonly unknown[], b: readonly unknown[]): number {
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

async function factDispositions(
  pool: pg.Pool,
  tenantId: string,
  records: readonly string[],
) {
  return (
    await pool.query<{
      record_id: string;
      from_state: string;
      to_state: string;
      disposition: string | null;
    }>(
      `SELECT c.record_id, c.from_state, c.to_state, d.disposition
         FROM platform.record_creation_occurrences AS c
         LEFT JOIN platform.workflow_record_dispositions AS d USING (tenant_id, environment_id, occurrence_id)
        WHERE c.tenant_id = $1 AND c.kind = 'engineFact' AND c.record_id = ANY($2::uuid[])`,
      [tenantId, records],
    )
  ).rows
    .map((r) => [r.record_id, r.from_state, r.to_state, r.disposition])
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
