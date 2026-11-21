import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import type pg from 'pg';

import { OperationsAgentSession } from '../../packages/operations-agent/src/session.js';
import { COMPANY, worldOver, seededId } from '../agent/agent-world.js';
import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  createComposedApplicationRuntime,
  parseCompiledApplication,
  rolePool,
  trustedContext,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { openCustomizationService } from '../../packages/postgres-provider/src/customization-service.js';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/inventory-posting-capability-executor.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/purchase-order-approval-executor.js';
import { RECEIVING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receiving-capability-executor.js';
import { PostgresModuleRuntimeInterpreter } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import { renderedDiffDigest } from '../../packages/customization/src/index.js';
import { NoSuchRegisteredQueryError } from '../../packages/runtime/src/semantic-query-gateway.js';
import { checkStaffCustomizationWriter } from '../helpers/staff-decision-checks.js';
import { recordedPatch } from '../helpers/customization-patch-record.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

import {
  authoredPath,
  firstPartyAuthored,
  compiledApplication,
  migrationsDirectory,
  equipment,
  activeReleaseId,
  EQUIPMENT,
  startRuntime,
  listEquipment,
  createEquipment,
  pointerFence,
} from '../helpers/customization-fixture.js';

const tenantSlug = 'customize-draft';

test(
  'a drafted change is recorded append-only beside its tenant revision and staged release, and nothing goes live',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-draft',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
        const runtime = await createComposedApplicationRuntime({
          capabilityOperationExecutorFactories: [
            INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
            RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
            PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY,
          ],
          compiledApplication,
          databaseUrl,
          inventoryScopeProvisioning: COMPOSED_APPLICATION_INVENTORY_SCOPE,
          localDemoIdentity: true,
          migrationsDirectory,
          providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
          tenantSlug,
        });
        try {
          const opened = await openCustomizationService({
            acknowledgement: readUnboundPermissionAcknowledgementFor(
              authoredPath,
              'northstar.app:package.application',
            ),
            compiledApplication,
            databaseUrl,
            firstPartyAuthored,
            migrationsDirectory,
            tenantSlug,
          });
          try {
            // The model has finished, and the draft is waiting on the release lock.
            // Stop before releasing it; neither a candidate release nor a patch may appear.
            const stopped = new AbortController();
            const lock = await pool.connect();
            const counts = async () =>
              (
                await pool.query(
                  'SELECT (SELECT count(*) FROM platform.customization_patches) AS patches, (SELECT count(*) FROM platform.app_package_revisions) AS revisions',
                )
              ).rows;
            const before = await counts();
            let attempt: Promise<unknown>;
            try {
              await lock.query('BEGIN');
              await lock.query(
                'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                [
                  `northstar.release-scope:${runtime.identity.tenantId}:${runtime.identity.environmentId}`,
                ],
              );
              attempt = opened.service.draft(
                equipment,
                'conversationalAi',
                stopped.signal,
              );
              const until = performance.now() + 90000;
              for (;;) {
                const wait = await pool.query(
                  "SELECT 1 FROM pg_locks waiter JOIN pg_locks holder USING (locktype,database,classid,objid,objsubid) WHERE holder.pid=$1 AND holder.granted AND NOT waiter.granted AND waiter.locktype='advisory'",
                  [
                    (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0]
                      .pid,
                  ],
                );
                if (wait.rowCount) break;
                assert.ok(
                  performance.now() < until,
                  'draft never reached the held release lock',
                );
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              stopped.abort();
            } finally {
              await lock.query('ROLLBACK');
              lock.release();
            }
            await assert.rejects(attempt!, /abort/iu);
            assert.deepEqual(await counts(), before);
            const drafted = await opened.service.draft(
              equipment,
              'declarativeEditor',
            );
            assert.equal(drafted.status, 'drafted');
            if (drafted.status !== 'drafted') return;
            assert.equal(drafted.reused, false);
            assert.match(
              drafted.renderedDiff,
              /New record type "Equipment" with 4 fields/u,
            );
            assert.equal(
              await activeReleaseId(pool, runtime.identity.tenantId),
              runtime.activeReleaseId,
              'drafting moves no pointer',
            );

            const tip =
              parseCompiledApplication(compiledApplication).application.compiled
                .releaseRoot;
            const row = await recordedPatch(pool, drafted.patchId);
            assert.equal(row.patch_kind, 'addRecordType');
            assert.equal(row.channel, 'declarativeEditor');
            assert.equal(row.authored_by, runtime.identity.principalId);
            assert.equal(row.base_release_root, tip);
            assert.equal(
              row.payload_digest,
              createHash('sha256').update(row.payload).digest('hex'),
            );
            assert.equal(row.resulting_revision_id, drafted.revisionId);
            assert.equal(row.resulting_release_id, drafted.releaseId);
            assert.equal(row.resulting_provenance, 'tenantAuthored');
            assert.equal(row.parent_revision_id, row.active_revision_id);
            assert.equal(
              row.resulting_parent_revision_id,
              row.parent_revision_id,
            );
            assert.equal(row.resulting_release_root, drafted.releaseRoot);

            const again = await opened.service.draft(
              equipment,
              'declarativeEditor',
            );
            assert.equal(again.status === 'drafted' && again.reused, true);
            assert.equal(
              again.status === 'drafted' && again.patchId,
              drafted.patchId,
            );
            assert.equal(
              again.status === 'drafted' && again.releaseRoot,
              drafted.releaseRoot,
              're-drafting the same change on the same base reproduces its release',
            );

            // Review F2: a second, older revision with the same content and
            // parent -- what two identical drafts racing leave behind. The
            // re-draft must record the revision its release is linked to.
            await pool.query(
              `INSERT INTO platform.app_package_revisions (
                 tenant_id, revision_id, parent_revision_id, schema_version,
                 language_version, normalization_profile_version,
                 canonicalization_profile_version, hash_algorithm,
                 content_hash, desired_state, provenance, created_by,
                 created_at
               )
               SELECT tenant_id, gen_random_uuid(), parent_revision_id,
                      schema_version, language_version,
                      normalization_profile_version,
                      canonicalization_profile_version, hash_algorithm,
                      content_hash, desired_state, provenance, created_by,
                      created_at - interval '1 minute'
                 FROM platform.app_package_revisions
                WHERE revision_id = $1`,
              [drafted.revisionId],
            );
            const raced = await opened.service.draft(
              equipment,
              'declarativeEditor',
            );
            assert.equal(
              raced.status === 'drafted' && raced.revisionId,
              drafted.revisionId,
              'a reused release returns the revision it is linked to',
            );
            assert.equal(
              (await opened.service.status()).patches.length,
              1,
              'status still reads the one recorded change',
            );

            const unsupported = await opened.service.draft(
              { kind: 'addWorkflow', label: 'Approve equipment purchases' },
              'declarativeEditor',
            );
            assert.equal(unsupported.status, 'unsupported');
            const refused = await opened.service.draft(
              {
                entity: 'northstar.app:entity.inventory_movement',
                field: { label: 'Note', type: 'text' },
                kind: 'addField',
              },
              'declarativeEditor',
            );
            assert.equal(
              refused.status === 'refused' && refused.code,
              'CUSTOMIZE_TARGET_IN_TIER_B_DEPENDENCY_SET',
            );
            assert.equal(await patchCount(pool), 1, 'refusals record nothing');

            const status = await opened.service.status();
            assert.deepEqual(
              status.patches.map((patch) => patch.patchId),
              [drafted.patchId],
            );
            assert.deepEqual(status.activeChain, []);

            await assert.rejects(
              pool.query(
                `UPDATE platform.customization_patches SET channel = 'visualBuilder'`,
              ),
              /immutable_release_write_guard_reject/u,
            );
            await assert.rejects(
              pool.query(`DELETE FROM platform.customization_patches`),
              /immutable_release_write_guard_reject/u,
            );
            await assert.rejects(
              pool.query(
                `INSERT INTO platform.customization_patches
                   SELECT tenant_id, environment_id, gen_random_uuid(),
                          patch_version, patch_kind, payload,
                          repeat('0', 64), channel, authored_by,
                          base_package_id, base_package_version,
                          base_revision_id, base_release_root,
                          parent_revision_id, resulting_revision_id,
                          resulting_release_id, language_version,
                          normalization_profile_version, created_at
                     FROM platform.customization_patches`,
              ),
              /customization_patches_shape/u,
              'a payload whose digest does not match is refused by the database',
            );
            const insertPatch = (kind: string, payload: object) =>
              pool.query<{ patch_id: string }>(
                `INSERT INTO platform.customization_patches
                   SELECT tenant_id, environment_id, gen_random_uuid(),
                          patch_version, $2, $3::bytea,
                          encode(sha256($3::bytea), 'hex'), channel, authored_by,
                          base_package_id, base_package_version,
                          base_revision_id, base_release_root,
                          parent_revision_id, resulting_revision_id,
                          resulting_release_id, language_version,
                          normalization_profile_version, created_at
                     FROM platform.customization_patches WHERE patch_id = $1
                     RETURNING patch_id`,
                [drafted.patchId, kind, Buffer.from(JSON.stringify(payload))],
              );
            const invalidKind = 'a'.repeat(65);
            await assert.rejects(
              insertPatch(invalidKind, { kind: invalidKind }),
              /customization_patches_shape/u,
              'the database refuses an identifier over 64 characters',
            );
            await assert.rejects(
              insertPatch('addField', { kind: 'addChoice' }),
              /customization_patches_shape/u,
              'the database refuses an identifier that differs from the payload',
            );
            await assert.rejects(
              insertPatch('addField', {}),
              /customization_patches_shape/u,
              'the database refuses a missing payload kind',
            );
            assert.equal(await patchCount(pool), 1);

            // Review R4: two identical drafts at once record one change, and
            // both return exactly the release and revision that change
            // recorded.
            const vehicle = {
              fields: [{ label: 'Name', required: true, type: 'text' }],
              kind: 'addRecordType',
              label: 'Vehicle',
            };
            const duplicates = await Promise.all([
              opened.service.draft(vehicle, 'declarativeEditor'),
              opened.service.draft(vehicle, 'declarativeEditor'),
            ]);
            const vehiclePatchId =
              duplicates[0].status === 'drafted' ? duplicates[0].patchId : '';
            const vehicleRow = await recordedPatch(pool, vehiclePatchId);
            for (const outcome of duplicates) {
              assert.equal(outcome.status, 'drafted');
              if (outcome.status !== 'drafted') return;
              assert.equal(outcome.patchId, vehiclePatchId);
              assert.equal(outcome.releaseId, vehicleRow.resulting_release_id);
              assert.equal(
                outcome.revisionId,
                vehicleRow.resulting_revision_id,
              );
            }
            assert.deepEqual(
              duplicates
                .map(
                  (outcome) => outcome.status === 'drafted' && outcome.reused,
                )
                .sort(),
              [false, true],
            );
            assert.equal(await patchCount(pool), 2);

            const stranger = await trustedContext({
              environmentId: randomUUID(),
              principalId: randomUUID(),
              tenantId: randomUUID(),
            });
            const runtimeRole = rolePool(databaseUrl, 'north_star_runtime', 1);
            const visible = await withTrustedRequestTransaction(
              runtimeRole,
              stranger,
              async (client) =>
                client.query(
                  'SELECT count(*)::integer AS count FROM platform.customization_patches',
                ),
            ).finally(() => runtimeRole.end());
            assert.equal(
              (visible.rows[0] as { count: number }).count,
              0,
              'another tenant sees no patch',
            );

            const unknownKind = 'unrecognizedTestKind';
            const unknownPatch = { ...vehicle, kind: unknownKind };
            const refusedKind = await opened.service.draft(
              unknownPatch,
              'declarativeEditor',
            );
            assert.equal(
              refusedKind.status,
              'unsupported',
              'the write parser refuses the unrecognized patch kind',
            );
            assert.equal(
              refusedKind.status === 'unsupported' &&
                refusedKind.missingCapability,
              unknownKind,
            );
            assert.equal(await patchCount(pool), 2);

            // Model a newer writer's row with valid structural checks and digest.
            const {
              rows: [unknown],
            } = await insertPatch(unknownKind, unknownPatch);
            assert.ok(unknown);
            await assert.rejects(
              opened.service.approve(unknown.patch_id),
              {
                code: 'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
                message: /unrecognizedTestKind/u,
              },
              'replay names the unsupported kind and refuses approval',
            );
            await checkStaffCustomizationWriter(
              pool,
              connection,
              runtime.identity,
              opened.service,
              { ...vehicle, label: 'Service truck' },
            );
          } finally {
            await opened.close();
          }
        } finally {
          await runtime.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

async function patchCount(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM platform.customization_patches',
  );
  return result.rows[0]!.count;
}

test(
  'an approved change goes live in a running runtime, rolls back keeping its rows, and returns',
  { timeout: 900_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-live',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
        const liveTenant = 'customize-live';
        let runtime = await startRuntime(databaseUrl, liveTenant);
        const opened = await openCustomizationService({
          acknowledgement: readUnboundPermissionAcknowledgementFor(
            authoredPath,
            'northstar.app:package.application',
          ),
          capabilityOperationExecutorFactories: [
            INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
            RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
            PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY,
          ],
          compiledApplication,
          databaseUrl,
          firstPartyAuthored,
          localDemoIdentity: true,
          migrationsDirectory,
          providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
          tenantSlug: liveTenant,
        });
        try {
          const firstPartyRelease = runtime.activeReleaseId;
          const drafted = await opened.service.draft(
            equipment,
            'declarativeEditor',
          );
          assert.equal(drafted.status, 'drafted');
          if (drafted.status !== 'drafted') return;
          await assert.rejects(
            listEquipment(runtime),
            NoSuchRegisteredQueryError,
            'a drafted change is not served',
          );
          await assert.rejects(
            opened.service.activate(drafted.patchId),
            /CUSTOMIZE_NOT_APPROVED|no current approval/u,
          );

          const approved = await opened.service.approve(drafted.patchId);
          assert.equal(approved.renderedDiff, drafted.renderedDiff);
          const preparation = await pool.query<{
            canonical_diff_digest: Buffer;
            rendered_diff_evidence_digest: Buffer;
            transition_plan_digest: Buffer | null;
          }>(
            `SELECT preparation.canonical_diff_digest,
                    preparation.rendered_diff_evidence_digest,
                    preparation.transition_plan_digest
               FROM platform.release_approvals AS approval
               JOIN platform.release_activation_preparations AS preparation
                 ON preparation.preparation_id = approval.preparation_id
              WHERE approval.activation_attempt_id = $1`,
            [approved.activationAttemptId],
          );
          assert.equal(
            preparation.rows[0]!.canonical_diff_digest.toString('hex'),
            drafted.canonicalDiffDigest,
            'the approval binds the canonical diff the approver was shown',
          );
          assert.equal(
            preparation.rows[0]!.rendered_diff_evidence_digest.toString('hex'),
            renderedDiffDigest(approved.renderedDiff),
            'the approval binds the plain-language text the approver read',
          );
          assert.notEqual(preparation.rows[0]!.transition_plan_digest, null);

          const activated = await opened.service.activate(drafted.patchId);
          assert.equal(activated.status, 'activated');
          assert.equal(activated.releaseId, drafted.releaseId);

          // A second process opening the same database -- the agent
          // terminal -- serves the live customization too and moves nothing.
          const fenceBefore = await pointerFence(
            pool,
            runtime.identity.tenantId,
          );
          const terminal = await startRuntime(databaseUrl, liveTenant);
          try {
            assert.equal(terminal.releaseRoot, drafted.releaseRoot);
          } finally {
            await terminal.close();
          }
          assert.equal(
            await pointerFence(pool, runtime.identity.tenantId),
            fenceBefore,
            'opening another runtime does not switch the active release',
          );

          // The SAME runtime, never restarted, now serves Equipment.
          const recordId = randomUUID();
          const created = await createEquipment(runtime, recordId);
          assert.equal(created.outcome, 'succeeded');
          assert.deepEqual(
            (await listEquipment(runtime)).records.map(
              (record) => record.recordId,
            ),
            [recordId],
          );

          const rolledBack = await opened.service.rollback();
          assert.equal(rolledBack.status, 'rolledBack');
          assert.equal(rolledBack.releaseId, firstPartyRelease);
          await assert.rejects(
            listEquipment(runtime),
            NoSuchRegisteredQueryError,
            'a rolled-back change is hidden',
          );
          await assert.rejects(
            opened.service.rollback(),
            /nothing|no customization/u,
          );

          await opened.service.approve(drafted.patchId);
          await opened.service.activate(drafted.patchId);
          assert.deepEqual(
            (await listEquipment(runtime)).records.map(
              (record) => record.recordId,
            ),
            [recordId],
            're-activation shows the rows kept through the rollback',
          );

          // Review F5: base -> A -> B, then roll back twice. The first goes
          // to A (the change B was built on, not whatever the last swap came
          // from). The second is refused by the reverse-transition policy,
          // which reverses only the activation that made the current release
          // live -- here B's rollback (filed).
          const choice = await opened.service.draft(
            {
              enumField: EQUIPMENT.status,
              kind: 'addChoice',
              option: 'Lost',
            },
            'declarativeEditor',
          );
          assert.equal(choice.status, 'drafted');
          if (choice.status !== 'drafted') return;
          await opened.service.approve(choice.patchId);
          await opened.service.activate(choice.patchId);
          const back = await opened.service.rollback();
          assert.equal(back.releaseId, drafted.releaseId);
          await assert.rejects(
            opened.service.rollback(),
            /CUSTOMIZE_ROLLBACK_NOT_REVERSIBLE|rolling back past it is not supported/u,
          );
          assert.deepEqual(
            (await listEquipment(runtime)).records.map(
              (record) => record.recordId,
            ),
            [recordId],
          );

          await runtime.close();
          runtime = await startRuntime(databaseUrl, liveTenant);
          assert.equal(
            runtime.releaseRoot,
            drafted.releaseRoot,
            'a restart serves the live customization',
          );
          assert.deepEqual(
            (await listEquipment(runtime)).records.map(
              (record) => record.recordId,
            ),
            [recordId],
          );
        } finally {
          await opened.close();
          await runtime.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

test(
  'a purchase order extension reads back on its page and returns after rollback with the value the assistant set',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-po',
      async ({ connection }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'customize-po',
        };
        const app = await startComposedApplication({
          ...options,
          seedProfile: 'distributor',
          port: 0,
        });
        const opened = await openCustomizeService(options);
        try {
          const world = worldOver(app.runtime, String(connection.database));
          const draft = await opened.service.draft(
            {
              kind: 'addField',
              entity: 'northstar.app:entity.purchase_order',
              field: { label: 'Person ordering', type: 'text' },
            },
            'visualBuilder',
          );
          assert.equal(draft.status, 'drafted');
          if (draft.status !== 'drafted') return;
          await opened.service.approve(draft.patchId);
          await opened.service.activate(draft.patchId);
          const field =
            'northstar.app:field.custom_purchase_order_person_ordering';
          const recordId = randomUUID();
          const created = await world.invoke('purchase_order_create', {
            recordId,
            legalEntityId: COMPANY,
            relations: {},
            values: {
              'northstar.app:field.purchase_order_supplier_party_id': seededId(
                'Cascade Fastener Works',
              ),
              'northstar.app:field.purchase_order_order_date':
                '2026-11-18T00:00:00.000Z',
              'northstar.app:field.purchase_order_currency': 'CAD',
              [field]: 'Robin',
            },
          });
          assert.equal(created.outcome, 'succeeded');
          const page = () => world.read('commercial_purchase_order', recordId);
          assert.equal((await page()).values[field], 'Robin');
          const agent = new OperationsAgentSession({
            runtime: app.runtime,
            companyId: COMPANY,
            personHeaders: { cookie: 'northstar-demo-actor=manager' },
            approve: () => Promise.resolve(true),
          });
          const read = await agent.call('erp_query', {
            queryId: 'purchase_order_get',
            arguments: { recordId },
            selection: [field],
          });
          assert.equal(read.isError, false);
          assert.match(JSON.stringify(read.content), /Robin/u);
          const plan = await agent.call('erp_plan', {
            intents: [
              {
                operationId: 'purchase_order_update',
                target: recordId,
                patch: { [field]: 'Morgan' },
              },
            ],
          });
          assert.equal(plan.isError, false, JSON.stringify(plan.content));
          const updated = await agent.call('erp_execute', {
            planId: (plan.content as { planId: string }).planId,
            executionIdempotencyKey: 'update-person',
          });
          assert.equal(updated.isError, false, JSON.stringify(updated.content));
          assert.equal((await page()).values[field], 'Morgan');
          await opened.service.rollback();
          assert.equal(Object.hasOwn((await page()).values, field), false);
          await opened.service.approve(draft.patchId);
          await opened.service.activate(draft.patchId);
          assert.equal((await page()).values[field], 'Morgan');
          const arrangement = await opened.service.draft(
            {
              kind: 'arrangeLayout',
              surface: 'northstar.app:surface.purchase_order_list',
              order: [field, 'northstar.app:field.purchase_order_notes'],
            },
            'visualBuilder',
          );
          assert.equal(arrangement.status, 'drafted');
          if (arrangement.status !== 'drafted') return;
          await opened.service.approve(arrangement.patchId);
          await opened.service.activate(arrangement.patchId);
          const columns = () =>
            app.runtime.entry.run(
              { headers: { cookie: 'northstar-demo-actor=manager' } },
              (view) => {
                const manifest = view.projections.surface
                  .payload as unknown as {
                  surfaces: {
                    surfaceId: string;
                    list?: { columns: { field: string }[] };
                  }[];
                };
                return manifest.surfaces
                  .find(
                    (s) =>
                      s.surfaceId ===
                      'northstar.app:surface.purchase_order_list',
                  )!
                  .list!.columns.map((c) => c.field);
              },
            );
          assert.deepEqual((await columns()).slice(0, 2), [
            field,
            'northstar.app:field.purchase_order_notes',
          ]);
          const rows = await world.list(
            'northstar.app:query.commercial_purchase_order_list',
          );
          assert.equal(
            rows.find((row) => row.recordId === recordId)?.values[field],
            'Morgan',
          );
          await opened.service.rollback();
          assert.equal((await columns()).includes(field), false);
          assert.equal(
            (await columns()).includes(
              'northstar.app:field.purchase_order_notes',
            ),
            false,
          );
          assert.equal((await page()).values[field], 'Morgan');
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

test(
  'company-owned tenant record mutations follow the stored owner',
  { timeout: 600_000 },
  async (t) => {
    await withEphemeralPostgres(
      'custom-company',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'custom-company',
        };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        try {
          const type = 'custom_review';
          const field = `northstar.app:field.${type}_name`;
          const ordinaryField = `northstar.app:field.${type}_external_legal_entity_id`;
          const draft = await opened.service.draft(
            {
              kind: 'changeSet',
              patches: [
                {
                  kind: 'addRecordType',
                  label: 'Review',
                  companyOwnership: 'entityOwned',
                  fields: [
                    { label: 'Name', type: 'text' },
                    { label: 'External legal entity ID', type: 'text' },
                  ],
                },
                {
                  kind: 'declareLifecycle',
                  entity: `northstar.app:entity.${type}`,
                  initial: 'Pending',
                  states: [{ label: 'Pending' }, { label: 'Passed' }],
                  transitions: [
                    { label: 'Pass', from: 'Pending', to: 'Passed' },
                  ],
                },
              ],
            },
            'visualBuilder',
          );
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          await opened.service.approve(draft.patchId);
          await opened.service.activate(draft.patchId);
          const world = worldOver(app.runtime, String(connection.database));
          const foreignCompany = randomUUID();
          await world.invoke('legal_entity_create', {
            recordId: foreignCompany,
            values: {
              'northstar.app:field.legal_entity_code': 'REVIEW-B',
              'northstar.app:field.legal_entity_name': 'Review B',
              'northstar.app:field.legal_entity_is_default': false,
              'northstar.app:field.legal_entity_status':
                'northstar.app:option.legal_entity_status_active',
            },
          });
          const foreign = randomUUID();
          await world.invoke(`${type}_create`, {
            legalEntityId: foreignCompany,
            recordId: foreign,
            values: { [field]: 'Foreign review' },
          });
          const local = await world.create(type, { name: 'Local review' });
          const buyer = { actor: 'buyer' } as const;
          const { tenantId, environmentId, principalId } = app.runtime.identity;
          const setBuyerCompany = (company: string) =>
            pool.query(
              'UPDATE platform.current_policy_memberships SET legal_entity_id=$4 WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3 AND revoked_at IS NULL',
              [tenantId, environmentId, principalId, company],
            );
          assert.ok((await setBuyerCompany(COMPANY)).rowCount);
          const foreignInput = { recordId: foreign, expectedRevision: 1 };
          const denied = { name: 'SemanticOperationPolicyDeniedError' };
          const scopedExecution = t.mock.method(
            PostgresModuleRuntimeInterpreter.prototype,
            'executeWithRecordCompany',
            { times: 1 },
          );
          await assert.rejects(
            world.invoke(
              `${type}_update`,
              {
                ...foreignInput,
                patch: { [ordinaryField]: COMPANY },
              },
              buyer,
            ),
            denied,
          );
          await t.test(
            'plain executor requires stored-owner authorization',
            async () => {
              // Use the exact request the gateway just declined for this buyer.
              const call = scopedExecution.mock.calls[0]!;
              assert.ok(call.this instanceof PostgresModuleRuntimeInterpreter);
              await assert.rejects(call.this.execute(call.arguments[0]), {
                code: 'MODULE_RECORD_COMPANY_AUTHORIZATION_REQUIRED',
              });
            },
          );
          for (const effect of ['action_pass', 'archive', 'restore']) {
            await assert.rejects(
              world.invoke(`${type}_${effect}`, foreignInput, buyer),
              denied,
            );
          }
          // A globally granted actor also cannot reassign ownership.
          await assert.rejects(
            world.invoke(`${type}_update`, {
              recordId: local.recordId,
              expectedRevision: 1,
              legalEntityId: foreignCompany,
              patch: { [field]: 'Moved review' },
            }),
            { code: 'MODULE_INPUT_MALFORMED' },
          );
          const idempotencyKey = randomUUID();
          const updateLocal = () =>
            world.invoke(
              `${type}_update`,
              {
                recordId: local.recordId,
                expectedRevision: 1,
                patch: { [field]: 'Edited review' },
              },
              { ...buyer, idempotencyKey },
            );
          const updated = await updateLocal();
          assert.equal(updated.readBack?.revision, 2);
          assert.deepEqual((await updateLocal()).trust, updated.trust);
          for (const [index, effect] of [
            'action_pass',
            'archive',
            'restore',
          ].entries()) {
            const result = await world.invoke(
              `${type}_${effect}`,
              {
                recordId: local.recordId,
                expectedRevision: index + 2,
              },
              buyer,
            );
            assert.equal(result.readBack?.revision, index + 3);
          }
          await setBuyerCompany(foreignCompany);
          await assert.rejects(
            updateLocal(),
            denied,
            'a replay also requires the stored company grant',
          );
          // Revision one is still current after every refused foreign write.
          assert.equal(
            (
              await world.invoke(`${type}_update`, {
                ...foreignInput,
                patch: { [field]: 'Manager edit' },
              })
            ).readBack?.revision,
            2,
          );
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
