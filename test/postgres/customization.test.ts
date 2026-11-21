import { RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receivables-capability-executor.js';
import { PAYABLES_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/payables-capability-executor.js';
import { FULFILLMENT_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/fulfillment-capability-executor.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import type pg from 'pg';

import { applicationBeforeStockCountWorkflow } from '../helpers/application-before-stock-count-workflow.js';

import { readActiveRelease } from '../../packages/postgres-provider/src/active-release-root.js';
import {
  openComposedApplicationRuntime,
  openCustomizeService,
} from '../../apps/api/src/composition-root.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  createComposedApplicationRuntime,
  ensureScope,
  reconcileInventoryScopeToPointer,
  type PointerState,
  parseCompiledApplication,
  rolePool,
  trustedContext,
  type ComposedApplicationRuntime,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import {
  withArchivedCustomizationRuntime,
  archivedRuntimeRead,
} from '../helpers/archived-runtime-process.js';
import { upgradeLogFields } from '../../packages/postgres-provider/src/customization-service.js';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/inventory-posting-capability-executor.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/purchase-order-approval-executor.js';
import { RECEIVING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receiving-capability-executor.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import {
  applyCustomizationPatches,
  customizationTargets,
  draftLayoutRevision,
  serializeRelease,
} from '../../packages/customization/src/index.js';
import {
  layoutDigest,
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  compileApplicationRelease,
  expectedActiveReleaseFrom,
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
} from '../../packages/compiler/src/index.js';
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
  startRuntime,
  listEquipment,
  createEquipment,
  pointerFence,
} from '../helpers/customization-fixture.js';

test(
  'a platform label upgrade preserves the field and layout, waits for approval, activates and rolls back',
  { timeout: 900_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-upgrade',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
        const tenantSlug = 'upgrade-proof';
        const options = { databaseUrl, tenantSlug };
        let runtime = await openComposedApplicationRuntime(options);
        const old = await openCustomizeService(options);
        const fieldId = 'northstar.app:field.custom_item_shelf_code';
        const savedColumns = [
          'northstar.app:list_column.item_list_item',
          'northstar.app:list_column.item_list_sku',
        ];
        let sourceRoot: string;
        let sourceFence: string;
        try {
          for (const patch of [
            {
              kind: 'addField',
              entity: 'northstar.app:entity.item',
              field: { label: 'Shelf code', type: 'text' },
            },
            {
              kind: 'arrangeLayout',
              surface: 'northstar.app:surface.item_list',
              relabel: [
                {
                  field: 'northstar.app:field.item_name',
                  label: 'Warehouse name',
                },
              ],
            },
            {
              kind: 'saveListView',
              surface: 'northstar.app:surface.item_list',
              label: 'Warehouse lookup',
              columns: savedColumns,
              sort: [{ column: savedColumns[0]!, direction: 'ascending' }],
              filters: [],
            },
            {
              kind: 'addMetricCard',
              surface: 'northstar.app:surface.item_list',
              label: 'Catalog prices in CAD',
              sumField: 'northstar.app:field.item_price_cad',
            },
          ]) {
            const drafted = await old.service.draft(patch, 'declarativeEditor');
            assert.equal(drafted.status, 'drafted');
            if (drafted.status !== 'drafted') return;
            await old.service.approve(drafted.patchId);
            await old.service.activate(drafted.patchId);
            if (patch.kind === 'addField') {
              const extended = platformLabelVariant(
                'Stock code',
                false,
                undefined,
                compiledApplication,
                true,
              );
              const newer = await startRuntime(databaseUrl, tenantSlug, {
                compiledApplication: extended.envelope,
                customization: {
                  acknowledgement: extended.acknowledgement,
                  firstPartyAuthored: extended.authored,
                },
              });
              try {
                assert.equal(newer.activeReleaseId, drafted.releaseId);
                assert.equal(
                  newer.customizationUpgrade?.status,
                  'drafted',
                  'a new active permission must allow the field-only historical chain to upgrade',
                );
              } finally {
                await newer.close();
              }
            }
          }
          sourceRoot = (await old.service.status()).activeReleaseRoot;
          sourceFence = await pointerFence(pool, runtime.identity.tenantId);
        } finally {
          await old.close();
          await runtime.close();
        }
        // The first-party field now collides with the tenant's field label.
        const conflict = platformLabelVariant('Shelf code');
        runtime = await openComposedApplicationRuntime({
          ...options,
          compiledApplication: conflict.envelope,
        });
        try {
          assert.equal(runtime.releaseRoot, sourceRoot);
          const diagnostic = runtime.customizationUpgrade;
          assert.equal(diagnostic?.status, 'rejected');
          assert.ok(diagnostic && diagnostic.status === 'rejected');
          assert.equal(diagnostic.code, 'FIELD_COLLISION');
          assert.match(
            JSON.stringify(diagnostic.issues),
            /northstar.app:field.item_sku/u,
          );
          assert.match(JSON.stringify(diagnostic.issues), /Shelf code/u);
          assert.deepEqual(
            upgradeLogFields(diagnostic),
            {
              status: 'rejected',
              code: 'FIELD_COLLISION',
              sourceReleaseId: runtime.activeReleaseId,
              baseReleaseRoot: parseCompiledApplication(conflict.envelope)
                .application.compiled.releaseRoot,
            },
            'bootstrap logs must contain only opaque identifiers and diagnostic codes',
          );
          assert.equal(
            await pointerFence(pool, runtime.identity.tenantId),
            sourceFence,
          );
          const again = await openComposedApplicationRuntime({
            ...options,
            compiledApplication: conflict.envelope,
          });
          try {
            assert.deepEqual(again.customizationUpgrade, diagnostic);
          } finally {
            await again.close();
          }
        } finally {
          await runtime.close();
        }

        // The tenant relabels this column. Both proposed platform labels
        // disappear in the replay, leaving one candidate for different bases.
        const discardedBase = platformLabelVariant(
          'Stock number',
          false,
          'Office item',
        );
        const discarded = await openComposedApplicationRuntime({
          ...options,
          compiledApplication: discardedBase.envelope,
        });
        const pending = discarded.customizationUpgrade;
        await discarded.close();
        assert.ok(pending?.status === 'drafted');
        const intermediate = platformLabelVariant(
          'Stock number',
          false,
          'Catalog item',
        );
        // Two distinct first-party releases carry this same package revision.
        const upgraded = platformLabelVariant(
          'Stock number',
          false,
          'Catalog item',
          intermediate.envelope,
        );
        runtime = await openComposedApplicationRuntime({
          ...options,
          compiledApplication: upgraded.envelope,
        });
        const service = await openCustomizeService({
          ...options,
          compiledApplication: upgraded.envelope,
        });
        try {
          const prepared = runtime.customizationUpgrade;
          assert.ok(prepared && prepared.status === 'drafted');
          assert.equal(
            await pointerFence(pool, runtime.identity.tenantId),
            sourceFence,
            'boot must not activate a replay',
          );
          const state = await service.service.status();
          assert.equal(
            state.upgrades.filter((u) => u.state === 'drafted').length,
            2,
          );
          const upgrade = state.upgrades.find(
            (u) => u.upgradeId === prepared.upgradeId,
          )!;
          const other = state.upgrades.find(
            (u) => u.upgradeId === pending.upgradeId,
          )!;
          assert.equal(other.candidateRevisionId, upgrade.candidateRevisionId);
          assert.notEqual(other.baseReleaseId, upgrade.baseReleaseId);
          assert.equal(upgrade.upgradeId, prepared.upgradeId);
          assert.equal(upgrade.state, 'drafted');
          await assert.rejects(
            service.service.activate(upgrade.upgradeId),
            /approve it first/u,
          );
          const candidate = await pool.query<{ desired_state: Buffer }>(
            `SELECT desired_state FROM platform.app_package_revisions WHERE revision_id = $1`,
            [upgrade.candidateRevisionId],
          );
          const definition = JSON.parse(
            candidate.rows[0]!.desired_state.toString('utf8'),
          ) as {
            fields: { fieldId: string; label: string }[];
            surfaces: {
              surfaceId: string;
              list?: {
                columns: { label: string }[];
                views: { label: string; layout?: { columns: string[] } }[];
              };
              launcher?: {
                metrics?: { label: string; sumField?: string }[];
              };
            }[];
          };
          assert.equal(
            definition.fields.find((field) => field.fieldId === fieldId)?.label,
            'Shelf code',
          );
          assert.equal(
            definition.fields.find(
              (field) => field.fieldId === 'northstar.app:field.item_sku',
            )?.label,
            'Stock number',
          );
          assert.ok(
            definition.surfaces
              .find(
                (surface) =>
                  surface.surfaceId === 'northstar.app:surface.item_list',
              )
              ?.list?.columns.some(
                (column) => column.label === 'Warehouse name',
              ),
          );
          assert.deepEqual(
            definition.surfaces
              .find(
                (surface) =>
                  surface.surfaceId === 'northstar.app:surface.item_list',
              )
              ?.list?.views.find((view) => view.label === 'Warehouse lookup')
              ?.layout?.columns,
            savedColumns,
          );
          assert.equal(
            definition.surfaces
              .find(
                (surface) =>
                  surface.surfaceId === 'northstar.app:surface.inventory_today',
              )
              ?.launcher?.metrics?.find(
                (metric) => metric.label === 'Catalog prices in CAD',
              )?.sumField,
            'northstar.app:field.item_price_cad',
          );
          await assertUpgradePersistence(
            pool,
            databaseUrl,
            tenantSlug,
            upgrade.upgradeId,
          );
          await pool.query(
            'ALTER TABLE platform.customization_upgrades DISABLE RULE customization_upgrades_reject_update',
          );
          const history = (await service.service.status()).upgrades.map(
            (record) => record.upgradeId,
          );
          assert.ok(history.includes(other.upgradeId));
          assert.ok(history.includes(upgrade.upgradeId));
          const oldPayload = (
            await pool.query<{ payload: Buffer }>(
              'SELECT payload FROM platform.customization_upgrades WHERE upgrade_id=$1',
              [other.upgradeId],
            )
          ).rows[0]!.payload;
          const setPayload = (bytes: Buffer) =>
            pool.query(
              'UPDATE platform.customization_upgrades SET payload=$2,payload_digest=$3 WHERE upgrade_id=$1',
              [
                other.upgradeId,
                bytes,
                createHash('sha256').update(bytes).digest('hex'),
              ],
            );
          try {
            await setPayload(
              Buffer.from(
                canonicalize({
                  ...(JSON.parse(oldPayload.toString()) as object),
                  patchIds: [42],
                }),
              ),
            );
            const isolated = await service.service.status();
            assert.deepEqual(
              isolated.upgrades.map((record) => record.upgradeId),
              history.filter((id) => id !== other.upgradeId),
            );
          } finally {
            await setPayload(oldPayload);
            await pool.query(
              'ALTER TABLE platform.customization_upgrades ENABLE RULE customization_upgrades_reject_update',
            );
          }
          const approval = await service.service.approve(upgrade.upgradeId);
          await assertLegacyApprovalReconciliation(
            pool,
            approval.activationAttemptId,
          );
          assert.match(approval.renderedDiff, /Stock number/u);
          assert.equal(
            (
              await pool.query(
                'SELECT customization_upgrade_id FROM platform.release_approvals WHERE activation_attempt_id=$1',
                [approval.activationAttemptId],
              )
            ).rows[0]?.customization_upgrade_id,
            upgrade.upgradeId,
          );
          await assert.rejects(
            service.service.activate(other.upgradeId),
            /no current approval/,
            'approval must select the requested upgrade',
          );
          await assert.rejects(
            service.service.rollback(upgrade.candidateReleaseId),
            /live release changed/iu,
            'rollback must match the displayed release',
          );
          assert.equal(
            await pointerFence(pool, runtime.identity.tenantId),
            sourceFence,
          );
          const laterCheckout = await openCustomizeService({
            ...options,
            compiledApplication: discardedBase.envelope,
          });
          try {
            await assert.rejects(
              laterCheckout.service.activate(upgrade.upgradeId),
              { code: 'CUSTOMIZE_BASE_MOVED' },
            );
            assert.equal(
              await pointerFence(pool, runtime.identity.tenantId),
              sourceFence,
            );
          } finally {
            await laterCheckout.close();
          }
          await service.service.activate(upgrade.upgradeId);
          assert.equal(
            (await service.service.status()).activeReleaseRoot,
            prepared.releaseRoot,
          );
          assert.equal(
            (await readActiveRelease(options))?.baseReleaseRoot,
            parseCompiledApplication(upgraded.envelope).application.compiled
              .releaseRoot,
            'the agent guard follows the new first-party base after activation',
          );
          const roots = await pool.query<{ content_hash: string }>(
            `SELECT content_hash FROM platform.tenant_releases
            WHERE tenant_id=$1 AND environment_id=$2 AND app_package_revision_id =
            (SELECT app_package_revision_id FROM platform.tenant_releases WHERE release_id=$3)`,
            [
              runtime.identity.tenantId,
              runtime.identity.environmentId,
              upgrade.baseReleaseId,
            ],
          );
          assert.ok(
            roots.rows.some(
              (row) =>
                row.content_hash ===
                parseCompiledApplication(intermediate.envelope).application
                  .compiled.releaseRoot,
            ),
          );
          assert.notEqual(
            parseCompiledApplication(intermediate.envelope).application.compiled
              .releaseRoot,
            parseCompiledApplication(upgraded.envelope).application.compiled
              .releaseRoot,
          );
          const restarted = await openComposedApplicationRuntime({
            ...options,
            compiledApplication: upgraded.envelope,
          });
          try {
            assert.equal(restarted.releaseRoot, prepared.releaseRoot);
            assert.equal(restarted.customizationUpgrade?.status, 'current');
          } finally {
            await restarted.close();
          }
          const predecessorReceipt = (
            await pool.query<{
              verification_receipt_id: string;
              fence: string;
            }>(
              `SELECT proof.verification_receipt_id, proof.fence FROM platform.release_activation_verification_receipts AS proof
                JOIN platform.release_approvals AS approval USING (tenant_id, environment_id)
               WHERE proof.tenant_id=$1 AND proof.environment_id=$2 AND proof.activated_release_id=$3
                 AND approval.activation_attempt_id=$4 AND approval.expected_pointer_id=proof.pointer_id
                 AND approval.expected_release_id=proof.activated_release_id AND approval.expected_fence=proof.fence`,
              [
                runtime.identity.tenantId,
                runtime.identity.environmentId,
                upgrade.sourceReleaseId,
                approval.activationAttemptId,
              ],
            )
          ).rows[0]!;
          await pool.query(
            'ALTER TABLE platform.release_activation_verification_receipts DISABLE RULE release_activation_verification_receipts_reject_update',
          );
          try {
            await pool.query(
              'UPDATE platform.release_activation_verification_receipts SET fence=fence+100 WHERE verification_receipt_id=$1',
              [predecessorReceipt.verification_receipt_id],
            );
            await assert.rejects(service.service.rollback(), {
              code: 'ROLLBACK_FORWARD_ACTIVATION_NOT_VERIFIED',
            });
          } finally {
            await pool.query(
              'UPDATE platform.release_activation_verification_receipts SET fence=$2 WHERE verification_receipt_id=$1',
              [
                predecessorReceipt.verification_receipt_id,
                predecessorReceipt.fence,
              ],
            );
            await pool.query(
              'ALTER TABLE platform.release_activation_verification_receipts ENABLE RULE release_activation_verification_receipts_reject_update',
            );
          }
          // A later pre-tenant baseline omits the old first-party releases from
          // the file. Their immutable database artifacts still reproduce intent.
          const nextBase = platformLabelVariant('Platform stock number', true);
          const nextRuntime = await openComposedApplicationRuntime({
            ...options,
            compiledApplication: nextBase.envelope,
          });
          const nextService = await openCustomizeService({
            ...options,
            compiledApplication: nextBase.envelope,
          });
          try {
            assert.equal(nextRuntime.customizationUpgrade?.status, 'drafted');
            assert.equal(
              (await nextService.service.status()).activeReleaseRoot,
              prepared.releaseRoot,
            );
            await assertCycleRejected(
              pool,
              options,
              upgraded.envelope,
              upgrade.upgradeId,
            );
          } finally {
            await nextService.close();
            await nextRuntime.close();
          }
          assert.equal(
            (await service.service.status()).activeReleaseRoot,
            sourceRoot,
            'rollback must restore the exact prior tenant release',
          );
          assert.notEqual(
            await pointerFence(pool, runtime.identity.tenantId),
            sourceFence,
            'rollback advances the fence',
          );
        } finally {
          await service.close();
          await runtime.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

test(
  'standard boot diagnoses an invalid or refused successor and serializes its verified swap',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'boot-verified',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
        const options = { databaseUrl, tenantSlug: 'verified-standard-boot' };
        const installed = await openComposedApplicationRuntime(options);
        const previous = installed.activeReleaseId;
        const { tenantId, environmentId } = installed.identity;
        await installed.close();
        const next = platformLabelVariant('New catalog code');
        const malformed = platformLabelVariant(
          'Wrong predecessor',
          false,
          undefined,
          next.envelope,
        );
        malformed.envelope.applications.splice(-2, 1);
        async function assertServesPrevious(compiledApplication: unknown) {
          const boot = await openComposedApplicationRuntime({
            ...options,
            compiledApplication,
          });
          try {
            assert.equal(boot.activeReleaseId, previous);
            assert.equal(boot.customizationUpgrade?.status, 'refused');
            assert.equal(
              await boot.entry.run({}, (view) => view.release.releaseId),
              previous,
            );
          } finally {
            await boot.close();
          }
        }
        const unreadable = await openComposedApplicationRuntime({
          ...options,
          get compiledApplication(): unknown {
            throw new SyntaxError('malformed successor JSON');
          },
        });
        try {
          assert.equal(unreadable.activeReleaseId, previous);
          assert.equal(unreadable.customizationUpgrade?.status, 'refused');
        } finally {
          await unreadable.close();
        }
        await assertServesPrevious(malformed.envelope);
        await pool.query(`CREATE FUNCTION public.refuse_successor() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test successor refused'; END $$;
      CREATE TRIGGER refuse_successor BEFORE UPDATE ON platform.active_release_pointers
        FOR EACH ROW EXECUTE FUNCTION public.refuse_successor()`);
        try {
          await assertServesPrevious(next.envelope);
        } finally {
          await pool.query(
            'DROP TRIGGER refuse_successor ON platform.active_release_pointers',
          );
        }

        const holder = await pool.connect();
        let opening: Promise<ComposedApplicationRuntime> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            [`northstar.release-scope:${tenantId}:${environmentId}`],
          );
          const holderPid = (
            await holder.query<{ pid: number }>(
              'SELECT pg_backend_pid() AS pid',
            )
          ).rows[0]!.pid;
          opening = createComposedApplicationRuntime({
            ...options,
            compiledApplication: next.envelope,
            localDemoIdentity: true,
            migrationsDirectory,
            providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
            capabilityOperationExecutorFactories: [
              INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
              RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
              PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY,
              FULFILLMENT_CAPABILITY_EXECUTOR_FACTORY,
              RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY,
              PAYABLES_CAPABILITY_EXECUTOR_FACTORY,
            ],
          });
          void opening.catch(() => undefined);
          const deadline = performance.now() + 120_000;
          // Observe from a separate autocommit session so a statistics
          // snapshot taken before the boot connected cannot hide it.
          while (
            !(
              await pool.query(
                'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
                [holderPid],
              )
            ).rowCount
          ) {
            if (performance.now() > deadline)
              throw new Error('boot did not reach the release scope lock');
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const physical = await holder.query<{ release_id: string }>(
            'SELECT release_id FROM platform.active_release_pointers WHERE tenant_id=$1 AND environment_id=$2',
            [tenantId, environmentId],
          );
          assert.equal(
            physical.rows[0]!.release_id,
            previous,
            'first-party boot waits for the lock before swapping',
          );
        } finally {
          await holder.query('ROLLBACK');
          holder.release();
          if (opening) {
            const boot = await opening;
            try {
              assert.equal(
                boot.releaseRoot,
                next.envelope.applications.at(-1)!.releaseRoot,
              );
              const client = await pool.connect();
              try {
                await client.query('BEGIN');
                const current = (
                  await client.query<PointerState>(
                    `SELECT pointer_id AS "pointerId", release_id AS "releaseId", fence::int AS fence
                     FROM platform.active_release_pointers WHERE tenant_id=$1 AND environment_id=$2`,
                    [tenantId, environmentId],
                  )
                ).rows[0]!;
                await client.query(
                  'UPDATE platform.inventory_posting_configurations SET contract_release_root=$3 WHERE tenant_id=$1 AND environment_id=$2',
                  [tenantId, environmentId, installed.releaseRoot],
                );
                assert.equal(
                  await reconcileInventoryScopeToPointer(
                    client,
                    boot.identity,
                    { ...current, fence: current.fence - 1 },
                  ),
                  null,
                );
                const scopes = await client.query<{
                  contract_release_root: string;
                }>(
                  'SELECT DISTINCT contract_release_root FROM platform.inventory_posting_configurations WHERE tenant_id=$1 AND environment_id=$2',
                  [tenantId, environmentId],
                );
                assert.deepEqual(scopes.rows, [
                  { contract_release_root: installed.releaseRoot },
                ]);
                assert.equal(
                  await reconcileInventoryScopeToPointer(
                    client,
                    boot.identity,
                    current,
                  ),
                  boot.releaseRoot,
                );
              } finally {
                await client.query('ROLLBACK');
                client.release();
              }
            } finally {
              await boot.close();
            }
          }
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

function platformLabelVariant(
  label: string,
  baseline = false,
  columnLabel?: string,
  previous: unknown = compiledApplication,
  addPermission = false,
  optionalField = false,
  baseAuthored = firstPartyAuthored,
) {
  let authored = structuredClone(baseAuthored) as Record<string, unknown>;
  if (optionalField) {
    const changed = applyCustomizationPatches(authored, [
      {
        kind: 'addField',
        entity: 'northstar.app:entity.purchase_order',
        screens: 'record',
        field: { type: 'text', label: 'Dock note' },
      },
    ]);
    assert.equal(changed.status, 'applied');
    const party = authored.package;
    authored = { ...changed.authored, package: party };
  }
  const fields = authored.fields as { fieldId: string; label: string }[];
  fields.find(
    (field) => field.fieldId === 'northstar.app:field.item_sku',
  )!.label = label;
  if (columnLabel) {
    const list = (
      authored.surfaces as {
        surfaceId: string;
        list?: { columns: { field: string; label: string }[] };
      }[]
    ).find((s) => s.surfaceId === 'northstar.app:surface.item_list')!;
    list.list!.columns.find(
      (c) => c.field === 'northstar.app:field.item_name',
    )!.label = columnLabel;
  }
  const original = parseCompiledApplication(previous);
  const parent = baseline ? original.bootstrap : original.application;
  const checkedIn = readUnboundPermissionAcknowledgementFor(
    authoredPath,
    'northstar.app:package.application',
  );
  const originalBinding = checkedIn.evaluatorBindings![0]!;
  const newId = 'northstar.app:permission.upgrade_review';
  const acknowledgement = addPermission
    ? {
        ...checkedIn,
        evaluatorBindings: [
          ...checkedIn.evaluatorBindings!,
          { ...originalBinding, permissionId: newId },
        ],
      }
    : checkedIn;
  if (addPermission) {
    const permissions = authored.permissions as { permissionId: string }[];
    const declared = permissions.find(
      (p) => p.permissionId === originalBinding.permissionId,
    )!;
    permissions.push({ ...declared, permissionId: newId });
  }
  const normalized = normalizeApplicationPackage(authored);
  const normalizedDefinitionBytes = new TextEncoder().encode(
    canonicalize(normalized),
  );
  const compiled = compileApplicationRelease(
    {
      dependencies: [],
      expectedActiveRelease: expectedActiveReleaseFrom(parent.compiled),
      kind: 'compilerInput',
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes,
      profile: {
        ...MODULE_COMPILER_PROFILE,
        languageVersion: normalized.languageVersion,
        normalizationProfileVersion: normalized.normalizationProfileVersion,
      },
    },
    acknowledgement,
  );
  assert.equal(
    compiled.status,
    'compiled',
    JSON.stringify(compiled.diagnostics),
  );
  if (compiled.status !== 'compiled') throw new Error('base did not compile');
  const parsed = original;
  return {
    authored,
    acknowledgement,
    envelope: {
      schemaVersion: 'northstar.web:compiled-application-release/v2',
      bootstrap: serializeRelease(parsed.bootstrap),
      applications: [
        ...(baseline ? [] : parsed.applications.map(serializeRelease)),
        serializeRelease({ compiled, normalizedDefinitionBytes }),
      ],
    },
  };
}

// Replay the corrective migration against an approval in the exact on-disk
// shape left by 0035. The transaction restores the original schema and rows.
async function assertLegacyApprovalReconciliation(
  pool: pg.Pool,
  attemptId: string,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE platform.release_approvals DISABLE RULE release_approvals_reject_update;
      ALTER TABLE platform.release_approvals DROP COLUMN IF EXISTS customization_reconciliation_required;
      ALTER TABLE platform.customization_patches DROP COLUMN IF EXISTS compiler_acknowledgement;
      ALTER TABLE platform.customization_upgrades DROP COLUMN IF EXISTS compiler_acknowledgement;
      DROP TRIGGER IF EXISTS customization_upgrade_patch_refs ON platform.customization_upgrades;
      DROP FUNCTION IF EXISTS platform.check_customization_patch_refs();
      DROP FUNCTION IF EXISTS platform.customization_patch_refs_valid(uuid,uuid,bytea)`);
    await client.query(
      'UPDATE platform.release_approvals SET source_decision_id=NULL,customization_upgrade_id=NULL WHERE activation_attempt_id=$1',
      [attemptId],
    );
    const original = readFileSync(
      resolve(migrationsDirectory, '0035_customization_upgrade_bindings.sql'),
      'utf8',
    );
    const backfill =
      /UPDATE platform\.release_approvals AS a SET customization_upgrade_id[\s\S]*?;/u.exec(
        original,
      )![0];
    await client.query(backfill);
    const approval = () =>
      client.query<{
        customization_upgrade_id: string | null;
        ambiguous: boolean | null;
      }>(
        `SELECT customization_upgrade_id,(to_jsonb(a)->>'customization_reconciliation_required')::boolean AS ambiguous FROM platform.release_approvals a WHERE activation_attempt_id=$1`,
        [attemptId],
      );
    assert.ok(
      (await approval()).rows[0]!.customization_upgrade_id,
      '0035 inferred the id from the release pair',
    );
    await client.query(
      'ALTER TABLE platform.release_approvals ENABLE RULE release_approvals_reject_update',
    );
    const correction = readdirSync(migrationsDirectory).find((name) =>
      name.endsWith('_verified_release_history.sql'),
    );
    if (correction)
      await client.query(
        readFileSync(resolve(migrationsDirectory, correction), 'utf8'),
      );
    assert.deepEqual(
      (await approval()).rows[0],
      { customization_upgrade_id: null, ambiguous: true },
      'an approval with no original action evidence requires reconciliation',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function assertUpgradePersistence(
  pool: pg.Pool,
  databaseUrl: string,
  tenantSlug: string,
  upgradeId: string,
) {
  const identities = await ensureScope(pool, tenantSlug, 'production');
  const foreign = await ensureScope(pool, 'upgrade-foreign', 'production');
  const otherEnvironment = await ensureScope(pool, tenantSlug, 'staging');
  const runtimePool = rolePool(databaseUrl, 'north_star_runtime', 2);
  try {
    const refusals = await withTrustedRequestTransaction(
      runtimePool,
      await trustedContext(identities.runtime),
      (client) =>
        client.query(
          'SELECT diagnostic FROM platform.customization_upgrade_refusals',
        ),
    );
    assert.equal(refusals.rows[0]?.diagnostic.code, 'FIELD_COLLISION');
    for (const identity of [foreign.runtime, otherEnvironment.runtime]) {
      await withTrustedRequestTransaction(
        runtimePool,
        await trustedContext(identity),
        async (client) => {
          const refused = await client.query(
            'SELECT diagnostic FROM platform.customization_upgrade_refusals',
          );
          assert.equal(
            refused.rowCount,
            0,
            'upgrade refusals must be tenant and environment scoped',
          );
          const rows = await client.query(
            'SELECT * FROM platform.customization_upgrades',
          );
          assert.equal(
            rows.rowCount,
            0,
            'upgrade rows must be tenant and environment scoped',
          );
        },
      );
    }
    await withTrustedRequestTransaction(
      runtimePool,
      await trustedContext(identities.runtime),
      async (client) => {
        assert.equal(
          (
            await client.query(
              'SELECT * FROM platform.customization_upgrades WHERE upgrade_id = $1',
              [upgradeId],
            )
          ).rowCount,
          1,
        );
      },
    );
    const original = await pool.query<{
      tenant_id: string;
      environment_id: string;
      source_release_id: string;
      base_release_id: string;
      candidate_release_id: string;
      candidate_revision_id: string;
      payload: Buffer;
      payload_digest: string;
      authored_by: string;
    }>('SELECT * FROM platform.customization_upgrades WHERE upgrade_id = $1', [
      upgradeId,
    ]);
    const row = original.rows[0]!;
    for (const identity of [foreign.runtime, otherEnvironment.runtime]) {
      await assert.rejects(
        withTrustedRequestTransaction(
          runtimePool,
          await trustedContext(identity),
          async (client) => {
            await client.query(
              `INSERT INTO platform.customization_upgrades (
             tenant_id, environment_id, upgrade_id, source_release_id, base_release_id,
             candidate_release_id, candidate_revision_id, payload, payload_digest, authored_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                row.tenant_id,
                row.environment_id,
                randomUUID(),
                row.source_release_id,
                row.base_release_id,
                row.candidate_release_id,
                row.candidate_revision_id,
                row.payload,
                row.payload_digest,
                identity.principalId,
              ],
            );
          },
        ),
        /row-level security/u,
      );
    }
    for (const query of [
      'UPDATE platform.customization_upgrades SET payload_digest = payload_digest',
      'DELETE FROM platform.customization_upgrades',
    ])
      await assert.rejects(
        pool.query(query),
        /immutable_release_write_guard_reject/u,
      );
    await assert.rejects(
      pool.query(
        `INSERT INTO platform.customization_upgrades
       SELECT tenant_id, environment_id, gen_random_uuid(), source_release_id, base_release_id,
              candidate_release_id, candidate_revision_id, payload, repeat('0',64), authored_by, created_at
         FROM platform.customization_upgrades WHERE upgrade_id = $1`,
        [upgradeId],
      ),
      /customization_upgrades_binding/u,
    );
    const firstParty = await pool.query<{ release_id: string }>(
      `SELECT r.release_id FROM platform.tenant_releases r JOIN platform.app_package_revisions v ON v.tenant_id=r.tenant_id AND v.revision_id=r.app_package_revision_id WHERE r.tenant_id=$1 AND r.environment_id=$2 AND v.provenance='firstParty' AND NOT EXISTS (SELECT 1 FROM platform.customization_upgrades u WHERE u.tenant_id=r.tenant_id AND u.environment_id=r.environment_id AND u.base_release_id=r.release_id) LIMIT 1`,
      [row.tenant_id, row.environment_id],
    );
    const firstPartyId = firstParty.rows[0]!.release_id;
    const originalIds = (
      JSON.parse(row.payload.toString()) as { patchIds: string[] }
    ).patchIds;
    for (const ids of [
      [42],
      [originalIds[0], originalIds[0]],
      [randomUUID()],
    ]) {
      const payload = Buffer.from(
        canonicalize({
          ...(JSON.parse(row.payload.toString()) as object),
          baseReleaseId: firstPartyId,
          patchIds: ids,
        }),
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO platform.customization_upgrades (tenant_id, environment_id, upgrade_id, source_release_id, base_release_id, candidate_release_id, candidate_revision_id, payload, payload_digest, authored_by)
         VALUES ($1,$2,gen_random_uuid(),$3,$4,$5,$6,$7,$8,$9)`,
          [
            row.tenant_id,
            row.environment_id,
            row.source_release_id,
            firstPartyId,
            row.candidate_release_id,
            row.candidate_revision_id,
            payload,
            createHash('sha256').update(payload).digest('hex'),
            row.authored_by,
          ],
        ),
        /invalid customization patch references/u,
      );
    }
    for (const [baseId, revisionId] of [
      [row.source_release_id, row.candidate_revision_id],
      [
        firstPartyId,
        (
          await pool.query(
            'SELECT app_package_revision_id FROM platform.tenant_releases WHERE release_id=$1',
            [firstPartyId],
          )
        ).rows[0]!.app_package_revision_id as string,
      ],
    ]) {
      const payload = Buffer.from(
        canonicalize({
          ...(JSON.parse(row.payload.toString('utf8')) as object),
          baseReleaseId: baseId,
          candidateRevisionId: revisionId,
        }),
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO platform.customization_upgrades(tenant_id, environment_id, upgrade_id, source_release_id, base_release_id, candidate_release_id, candidate_revision_id, payload, payload_digest, authored_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            row.tenant_id,
            row.environment_id,
            randomUUID(),
            row.source_release_id,
            baseId,
            row.candidate_release_id,
            revisionId,
            payload,
            createHash('sha256').update(payload).digest('hex'),
            row.authored_by,
          ],
        ),
        /customization upgrade release binding is invalid/u,
        'a valid digest cannot substitute another base or revision',
      );
    }
    const grants = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND table_name = 'customization_upgrades' AND grantee = 'north_star_runtime'
        ORDER BY privilege_type`,
    );
    assert.deepEqual(
      grants.rows.map((row) => row.privilege_type),
      ['INSERT', 'SELECT'],
    );
  } finally {
    await runtimePool.end();
  }
}

test(
  'a record-type upgrade stages for approval and an unknown live kind can roll back',
  { timeout: 900_000 },
  async () => {
    await withEphemeralPostgres(
      'refused-upgrade',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'refused-record-type',
        };
        const installed = {
          ...options,
          compiledApplication: platformLabelVariant(
            'Original stock identifier',
            true,
          ).envelope,
        };
        const runtime = await openComposedApplicationRuntime(installed);
        const original = await openCustomizeService(installed);
        const recordId = randomUUID();
        const base = runtime.activeReleaseId;
        let source: string;
        let patchId: string;
        try {
          const change = await original.service.draft(
            equipment,
            'declarativeEditor',
          );
          assert.ok(change.status === 'drafted');
          patchId = change.patchId;
          await original.service.approve(patchId);
          source = (await original.service.activate(patchId)).releaseId;
          assert.equal(
            (await createEquipment(runtime, recordId)).outcome,
            'succeeded',
          );
        } finally {
          await original.close();
          await runtime.close();
        }
        const next = options;
        for (const kind of ['addRecordType', 'futurePatchKind']) {
          if (kind === 'futurePatchKind') {
            // Model a row written by a newer parser in this disposable tenant.
            await pool.query(
              'ALTER TABLE platform.customization_patches DROP CONSTRAINT customization_patches_shape',
            );
            await pool.query(
              'ALTER TABLE platform.customization_patches DISABLE RULE customization_patches_reject_update',
            );
            const payload = Buffer.from(JSON.stringify({ kind }));
            await pool.query(
              'UPDATE platform.customization_patches SET patch_kind=$1,payload=$2,payload_digest=$3 WHERE patch_id=$4',
              [
                kind,
                payload,
                createHash('sha256').update(payload).digest('hex'),
                patchId,
              ],
            );
            await pool.query(
              'ALTER TABLE platform.customization_patches ENABLE RULE customization_patches_reject_update',
            );
          }
          const boot = await openComposedApplicationRuntime(next);
          const opened = await openCustomizeService(next);
          try {
            assert.equal(boot.activeReleaseId, source);
            assert.deepEqual(
              (await listEquipment(boot)).records.map((r) => r.recordId),
              [recordId],
            );
            const status = await opened.service.status();
            if (kind === 'addRecordType') {
              assert.equal(boot.customizationUpgrade?.status, 'drafted');
              assert.equal(status.upgradeRefusal, null);
            } else {
              assert.equal(boot.customizationUpgrade?.status, 'refused');
              assert.equal(status.upgradeRefusal?.code, 'KIND_NOT_ADMITTED');
            }
            assert.equal(status.activeChain[0]?.kind, kind);
            if (kind === 'futurePatchKind') {
              const cli = execFileSync(
                process.execPath,
                [
                  '--import',
                  'tsx',
                  'apps/api/scripts/customize-cli.ts',
                  'status',
                ],
                {
                  encoding: 'utf8',
                  env: {
                    ...process.env,
                    DATABASE_URL: options.databaseUrl,
                    NORTH_STAR_TENANT_SLUG: options.tenantSlug,
                  },
                },
              );
              assert.match(cli, /Platform upgrade refused: KIND_NOT_ADMITTED/u);
              assert.match(cli, /futurePatchKind/u);
              const report = status.upgradeRefusal?.report;
              assert.ok(report);
              assert.deepEqual(
                JSON.parse(
                  cli.split('\n').find((line) => line.startsWith('{'))!,
                ),
                report,
              );
              assert.equal(report.sourceReleaseId, source);
              assert.equal(report.sourceFence, String(status.activeFence));
              assert.deepEqual(
                report.findings.map((f) => [f.patchId, f.code, f.subject]),
                [[patchId, 'KIND_NOT_ADMITTED', kind]],
              );
              await assert.rejects(
                opened.service.rollback(base),
                /live release changed/iu,
              );
              await assert.rejects(
                opened.service.rollback(source, String(status.activeFence - 1)),
                /live release changed/iu,
              );
              assert.equal(
                (
                  await opened.service.rollback(
                    source,
                    String(status.activeFence),
                  )
                ).releaseId,
                base,
              );
              assert.equal(
                (await opened.service.status()).activeChain.length,
                0,
              );
            }
          } finally {
            await opened.close();
            await boot.close();
          }
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

async function assertCycleRejected(
  pool: pg.Pool,
  options: { databaseUrl: string; tenantSlug: string },
  envelope: unknown,
  id: string,
) {
  // Corrupt just the historical edge in the disposable database. Restore the
  // same immutable bytes and constraints before exercising normal rollback.
  const original = (
    await pool.query<{
      base_release_id: string;
      payload: Buffer;
      payload_digest: string;
    }>(`SELECT * FROM platform.customization_upgrades WHERE upgrade_id=$1`, [
      id,
    ])
  ).rows[0]!;
  const constraint = (
    await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='platform.customization_upgrades'::regclass AND conname='customization_upgrades_binding'`,
    )
  ).rows[0]!.definition;
  await pool.query(
    'ALTER TABLE platform.customization_upgrades DISABLE RULE customization_upgrades_reject_update',
  );
  await pool.query(
    'ALTER TABLE platform.customization_upgrades DROP CONSTRAINT customization_upgrades_binding',
  );
  try {
    await pool.query(
      'UPDATE platform.customization_upgrades SET base_release_id=candidate_release_id WHERE upgrade_id=$1',
      [id],
    );
    await assert.rejects(
      readActiveRelease(options),
      /lineage contains a cycle/u,
    );
    const runtime = await openComposedApplicationRuntime({
      ...options,
      compiledApplication: envelope,
    });
    const service = await openCustomizeService({
      ...options,
      compiledApplication: envelope,
    });
    try {
      const diagnostic = runtime.customizationUpgrade;
      assert.ok(diagnostic?.status === 'refused');
      assert.match(diagnostic.message, /lineage contains a cycle/u);
      const status = await service.service.status();
      assert.equal(
        status.upgradeRefusal?.code,
        'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE',
      );
      assert.equal(status.activeReleaseId, runtime.activeReleaseId);
      assert.equal(status.historyUnavailable, true);
      assert.equal(
        status.rollbackAvailable,
        true,
        'verified rollback survives unreadable replay metadata',
      );
      const rolled = await service.service.rollback(
        status.activeReleaseId,
        String(status.activeFence),
      );
      assert.equal(
        rolled.releaseId,
        (
          await pool.query<{ source_release_id: string }>(
            'SELECT source_release_id FROM platform.customization_upgrades WHERE upgrade_id=$1',
            [id],
          )
        ).rows[0]!.source_release_id,
      );
    } finally {
      await service.close();
      await runtime.close();
    }
  } finally {
    await pool.query(
      'UPDATE platform.customization_upgrades SET base_release_id=$1 WHERE upgrade_id=$2',
      [original.base_release_id, id],
    );
    await pool.query(
      `ALTER TABLE platform.customization_upgrades ADD CONSTRAINT customization_upgrades_binding ${constraint}`,
    );
    await pool.query(
      'ALTER TABLE platform.customization_upgrades ENABLE RULE customization_upgrades_reject_update',
    );
  }
}

test(
  'a tenant with Equipment and a purchase-order layout takes a platform upgrade without changing its patch rows',
  { timeout: 900_000 },
  async () => {
    await withEphemeralPostgres(
      'upgrade-layout-survival',
      async ({ connection, pool }) => {
        const compatibility = applicationBeforeStockCountWorkflow();
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'upgrade-layout',
          compiledApplication: compatibility.release,
        };
        const old = await openComposedApplicationRuntime(options);
        const service = await openCustomizeService(options);
        const patches = () =>
          pool
            .query<{ row: unknown }>(
              `SELECT to_jsonb(p) AS row FROM platform.customization_patches p WHERE tenant_id=$1 AND environment_id=$2 ORDER BY created_at,patch_id`,
              [old.identity.tenantId, old.identity.environmentId],
            )
            .then((r) => r.rows);
        const successor = platformLabelVariant(
          'Stock identifier',
          false,
          undefined,
          compatibility.release,
          false,
          true,
          compatibility.authored,
        );
        const target = () =>
          service.service
            .targets()
            .then((t) =>
              t.layouts!.find(
                (l) =>
                  l.body.surfaceId.endsWith(':surface.purchase_order_form') &&
                  l.body.mode === 'create',
              )!,
            );
        const save = async (change: unknown) => {
          const draft = await service.service.draft(
            change,
            'declarativeEditor',
          );
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          await service.service.approve(draft.patchId);
          return service.service.activate(draft.patchId);
        };
        const delivery = 'tenant-section/2ea905ad-e361-41fa-bb3f-13571d071b94';
        let source: string;
        let before: Awaited<ReturnType<typeof patches>>;
        let chain: string[];
        const recordId = randomUUID();
        let parentId: string;
        try {
          await save(equipment);
          assert.equal(
            (await createEquipment(old, recordId)).outcome,
            'succeeded',
          );
          const sourceLayout = await target();
          const newLayout = customizationTargets(
            normalizeApplicationPackage(successor.authored),
          ).layouts!.find(
            (l) =>
              l.body.surfaceId === sourceLayout.body.surfaceId &&
              l.body.mode === 'create',
          )!;
          const baseSection = newLayout.body.sections.find((s) =>
            s.fields.some((f) => f.label.text === 'Dock note'),
          )!;
          const index = baseSection.fields.findIndex(
            (f) => f.label.text === 'Dock note',
          );
          assert.ok(index > 0);
          parentId = baseSection.fields[index - 1]!.id;
          const originalSection = sourceLayout.body.sections.find((s) =>
            s.fields.some((f) => f.id === parentId),
          )!;
          source = (
            await save(
              draftLayoutRevision(sourceLayout, [
                {
                  kind: 'createSection',
                  schemaVersion: 'v6',
                  id: delivery,
                  parent: sourceLayout.body.slotId,
                  position: { edge: 'last' },
                  label: { schemaVersion: 'v6', text: 'Delivery' },
                },
                {
                  kind: 'move',
                  schemaVersion: 'v6',
                  id: parentId,
                  parent: originalSection.id,
                  destination: delivery,
                  position: { edge: 'last' },
                },
              ]),
            )
          ).releaseId;
          before = await patches();
          chain = (await service.service.status()).activeChain.map(
            (p) => p.patchId,
          );
        } finally {
          await service.close();
          await old.close();
        }
        const next = { ...options, compiledApplication: successor.envelope };
        const boot = await openComposedApplicationRuntime(next);
        const newer = await openCustomizeService(next);
        try {
          const prepared = boot.customizationUpgrade;
          assert.ok(prepared?.status === 'drafted', JSON.stringify(prepared));
          assert.equal(boot.activeReleaseId, source);
          assert.ok(prepared.report);
          assert.deepEqual(await patches(), before);
          assert.equal(prepared.report.approvalMode, 'Manual');
          assert.deepEqual(prepared.report.findings, []);
          await assert.rejects(newer.service.activate(prepared.upgradeId), {
            code: 'CUSTOMIZE_NOT_APPROVED',
          });
          await newer.service.approve(prepared.upgradeId);
          const activate = () => newer.service.activate(prepared.upgradeId);
          const live = process.env.CI
            ? await withArchivedCustomizationRuntime(
                '8e3603b8e734a14ed350f2f2f7f64d1e2b034eb7',
                async (run) => {
                  const read = () =>
                    archivedRuntimeRead(run, {
                      databaseUrl: options.databaseUrl,
                      identity: boot.identity,
                    });
                  const { REPLAYED_LAYOUT_READER } =
                    await import('../../packages/canonical-model/src/index.js');
                  assert.equal((await read()).outcome, 'loaded');
                  const activated = await activate();
                  const refused = await read();
                  assert.equal(
                    refused.code,
                    'UNSUPPORTED_RUNTIME_CAPABILITY',
                    JSON.stringify(refused),
                  );
                  assert.match(
                    refused.message ?? '',
                    new RegExp(
                      `surface-manifest requires version ${REPLAYED_LAYOUT_READER}`,
                      'u',
                    ),
                  );
                  return activated;
                },
              )
            : await activate();
          const status = await newer.service.status();
          assert.equal(status.activeReleaseId, live.releaseId);
          assert.deepEqual(
            status.activeChain.map((p) => p.patchId),
            chain,
          );
          assert.deepEqual(await patches(), before);
          const layout = (await newer.service.targets()).layouts!.find(
            (l) =>
              l.body.surfaceId.endsWith(':surface.purchase_order_form') &&
              l.body.mode === 'create',
          )!;
          const section = layout.body.sections.find((s) => s.id === delivery)!;
          assert.deepEqual(
            section.fields.map((f) => f.id),
            [parentId, 'northstar.app:field.custom_purchase_order_dock_note'],
          );
          const evidence = await pool.query<{ payload: Buffer }>(
            `SELECT payload FROM platform.customization_upgrades WHERE upgrade_id=$1 AND candidate_release_id=$2 AND source_release_id=$3`,
            [prepared.upgradeId, live.releaseId, source],
          );
          const binding = JSON.parse(
            evidence.rows[0]!.payload.toString('utf8'),
          );
          assert.deepEqual(binding.patchIds, chain);
          assert.ok(
            binding.layoutEvidence.some(
              (l: {
                placementRuleVersion: number;
                resultLayoutDigest: string;
              }) =>
                l.placementRuleVersion === 1 &&
                l.resultLayoutDigest === layoutDigest(layout.body),
            ),
          );
          assert.deepEqual(
            (await listEquipment(boot)).records.map((r) => r.recordId),
            [recordId],
          );
          assert.equal(
            (
              await newer.service.rollback(
                live.releaseId,
                String(status.activeFence),
              )
            ).releaseId,
            source,
          );
          assert.deepEqual(await patches(), before);
        } finally {
          await newer.close();
          await boot.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
