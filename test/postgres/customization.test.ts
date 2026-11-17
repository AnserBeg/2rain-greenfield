import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import type pg from 'pg';

import { COMPOSED_APPLICATION_INVENTORY_SCOPE } from '../../apps/api/src/composition-root.js';
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
