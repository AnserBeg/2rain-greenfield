import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  type ComposedApplicationRuntime,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { openCustomizationService } from '../../packages/postgres-provider/src/customization-service.js';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/inventory-posting-capability-executor.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/purchase-order-approval-executor.js';
import { RECEIVING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receiving-capability-executor.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import { renderedDiffDigest } from '../../packages/customization/src/index.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import { SEMANTIC_OPERATION_REQUEST_VERSION } from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  NoSuchRegisteredQueryError,
  SEMANTIC_QUERY_REQUEST_VERSION,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

const authoredPath = resolve('apps/web/release/app.authored.json');
const firstPartyAuthored = JSON.parse(
  readFileSync(authoredPath, 'utf8'),
) as Record<string, unknown>;
const compiledApplication = JSON.parse(
  readFileSync(resolve('apps/web/release/app.compiled.json'), 'utf8'),
) as unknown;
const migrationsDirectory = resolve('db/migrations');
const equipment = JSON.parse(
  readFileSync(resolve('apps/api/scripts/examples/equipment.json'), 'utf8'),
) as unknown;
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

async function activeReleaseId(
  pool: pg.Pool,
  tenantId: string,
): Promise<string | null> {
  const result = await pool.query<{ release_id: string | null }>(
    'SELECT release_id FROM platform.active_release_pointers WHERE tenant_id = $1',
    [tenantId],
  );
  return result.rows[0]?.release_id ?? null;
}

async function patchCount(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM platform.customization_patches',
  );
  return result.rows[0]!.count;
}

async function recordedPatch(pool: pg.Pool, patchId: string) {
  const result = await pool.query<{
    active_revision_id: string;
    authored_by: string;
    base_release_root: string;
    channel: string;
    parent_revision_id: string;
    patch_kind: string;
    payload: Buffer;
    payload_digest: string;
    resulting_parent_revision_id: string;
    resulting_provenance: string;
    resulting_release_id: string;
    resulting_release_root: string;
    resulting_revision_id: string;
  }>(
    `SELECT patch.patch_kind, patch.channel, patch.authored_by,
            patch.base_release_root, patch.payload, patch.payload_digest,
            patch.parent_revision_id, patch.resulting_revision_id,
            patch.resulting_release_id,
            revision.provenance AS resulting_provenance,
            revision.parent_revision_id AS resulting_parent_revision_id,
            release.content_hash AS resulting_release_root,
            active.app_package_revision_id AS active_revision_id
       FROM platform.customization_patches AS patch
       JOIN platform.app_package_revisions AS revision
         ON revision.revision_id = patch.resulting_revision_id
       JOIN platform.tenant_releases AS release
         ON release.release_id = patch.resulting_release_id
       JOIN platform.active_release_pointers AS pointer
         ON pointer.tenant_id = patch.tenant_id
        AND pointer.environment_id = patch.environment_id
       JOIN platform.tenant_releases AS active
         ON active.release_id = pointer.release_id
      WHERE patch.patch_id = $1`,
    [patchId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

const EQUIPMENT = Object.freeze({
  create: 'northstar.app:operation.custom_equipment_create',
  list: 'northstar.app:query.custom_equipment_list',
  name: 'northstar.app:field.custom_equipment_name',
  purchaseDate: 'northstar.app:field.custom_equipment_purchase_date',
  serial: 'northstar.app:field.custom_equipment_serial_number',
  status: 'northstar.app:field.custom_equipment_status',
  inService: 'northstar.app:option.custom_equipment_status_in_service',
});

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

function startRuntime(databaseUrl: string, slug: string) {
  return createComposedApplicationRuntime({
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
    tenantSlug: slug,
  });
}

function listEquipment(runtime: ComposedApplicationRuntime) {
  return runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
    runtime.queryGateway.invoke(view, {
      arguments: {
        includeArchived: false,
        list: {
          cursor: null,
          matchMode: 'substring',
          pageSize: 100,
          relationLabels: [],
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          search: '',
          sort: [],
        },
      },
      queryId: EQUIPMENT.list,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    }),
  );
}

function createEquipment(
  runtime: ComposedApplicationRuntime,
  recordId: string,
) {
  return runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
    runtime.operationGateway.invoke(
      view,
      {
        confirmationGrant: null,
        idempotencyKey: randomUUID(),
        input: {
          recordId,
          values: {
            [EQUIPMENT.name]: 'Forklift 3',
            [EQUIPMENT.serial]: 'FL-0003',
            [EQUIPMENT.purchaseDate]: '2026-11-01',
            [EQUIPMENT.status]: EQUIPMENT.inService,
          },
        },
        operationId: EQUIPMENT.create,
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      },
      runtime.operationMediation.issueInvocation(view, 'UI'),
    ),
  );
}

async function pointerFence(pool: pg.Pool, tenantId: string): Promise<string> {
  const result = await pool.query<{ fence: string; release_id: string }>(
    'SELECT fence::text AS fence, release_id FROM platform.active_release_pointers WHERE tenant_id = $1',
    [tenantId],
  );
  return `${result.rows[0]!.release_id}@${result.rows[0]!.fence}`;
}

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
                'Alpine Office Supply',
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
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
