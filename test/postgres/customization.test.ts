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

import { readActiveRelease } from '../../packages/postgres-provider/src/active-release-root.js';
import { scriptedModel } from '../../packages/operations-agent/src/model.js';
import { OperationsAgentSession } from '../../packages/operations-agent/src/session.js';
import { COMPANY, worldOver, seededId } from '../agent/agent-world.js';
import {
  inspection,
  inspectionChange,
  inspectionLinkRecords,
} from '../fixtures/inspection-customization.js';
import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  openComposedApplicationRuntime,
  openCustomizeService,
  startComposedApplication,
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
  openCustomizationService,
  upgradeLogFields,
} from '../../packages/postgres-provider/src/customization-service.js';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/inventory-posting-capability-executor.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/purchase-order-approval-executor.js';
import { RECEIVING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receiving-capability-executor.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import {
  DRAFT_CUSTOMIZATION_TOOL,
  serializeRelease,
} from '../../packages/customization/src/index.js';
import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  compileApplicationRelease,
  expectedActiveReleaseFrom,
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
} from '../../packages/compiler/src/index.js';
import { renderedDiffDigest } from '../../packages/customization/src/index.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import { trustedContextForRequestRuntimeView } from '../../packages/runtime/src/request-runtime-view.js';
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
  'a live saved view batches exact counts and the assistant reads its filtered order',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-views',
      async ({ connection }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'customize-views',
        };
        const app = await startComposedApplication({
          ...options,
          seedProfile: 'distributor',
          port: 0,
        });
        const opened = await openCustomizeService(options);
        try {
          const world = worldOver(app.runtime, String(connection.database));
          const type = 'northstar.app:field.location_type';
          const name = 'northstar.app:field.location_name';
          const code = 'northstar.app:field.location_code';
          const warehouse = 'northstar.app:option.warehouse';
          const store = 'northstar.app:option.store';
          for (const [suffix, value] of [
            ['Alpha', warehouse],
            ['Zulu', warehouse],
            ['Store', store],
          ] as const) {
            const created = await world.invoke('location_create', {
              recordId: randomUUID(),
              relations: {},
              values: {
                [code]: `C3-${suffix.toUpperCase()}`,
                [name]: `Customize view ${suffix}`,
                [type]: value,
              },
            });
            assert.equal(created.outcome, 'succeeded');
          }
          const draft = await opened.service.draft(
            {
              kind: 'saveListView',
              surface: 'northstar.app:surface.location_list',
              label: 'Warehouses',
              columns: [
                'northstar.app:list_column.location_list_name',
                'northstar.app:list_column.location_list_code',
              ],
              sort: [
                {
                  column: 'northstar.app:list_column.location_list_name',
                  direction: 'descending',
                },
              ],
              filters: [{ field: type, value: warehouse }],
            },
            'visualBuilder',
          );
          assert.equal(draft.status, 'drafted');
          await opened.service.approve(draft.patchId);
          await opened.service.activate(draft.patchId);
          const viewId =
            'northstar.app:list_view.custom_location_list_warehouses';
          const counts = await app.runtime.entry.run(
            { headers: { cookie: 'northstar-demo-actor=manager' } },
            (snapshot) =>
              app.runtime.queryGateway.invoke(snapshot, {
                schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
                queryId: 'northstar.app:query.location_list',
                arguments: {
                  includeArchived: false,
                  list: {
                    cursor: null,
                    matchMode: 'substring',
                    pageSize: 1,
                    relationLabels: [],
                    schemaVersion: SHARED_LIST_QUERY_VERSION,
                    search: 'Customize view',
                    sort: [],
                    viewCounts: [
                      {
                        viewId,
                        filters: [{ fieldId: type, value: warehouse }],
                      },
                      {
                        viewId: 'northstar.app:list_view.test_store_count',
                        filters: [{ fieldId: type, value: store }],
                      },
                    ],
                  },
                },
              }),
          );
          assert.deepEqual(
            counts.listCoverage?.viewCounts?.map((count) => [
              count.viewId,
              count.totalCount,
            ]),
            [
              [viewId, 2],
              ['northstar.app:list_view.test_store_count', 1],
            ],
          );

          const agent = new OperationsAgentSession({
            runtime: app.runtime,
            companyId: COMPANY,
            personHeaders: { cookie: 'northstar-demo-actor=manager' },
            approve: () => Promise.resolve(true),
          });
          const read = () =>
            agent.call('erp_query', {
              queryId: 'location_list',
              arguments: { view: viewId, search: 'Customize view' },
            });
          const answer = await read();
          assert.equal(answer.isError, false, JSON.stringify(answer.content));
          const records = (
            answer.content as { records: { values: Record<string, string> }[] }
          ).records;
          assert.deepEqual(
            records.map((row) => row.values),
            [
              { [code]: 'C3-ZULU', [name]: 'Customize view Zulu' },
              { [code]: 'C3-ALPHA', [name]: 'Customize view Alpha' },
            ],
          );
          await opened.service.rollback();
          assert.equal((await read()).isError, true);
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
  'a role restriction denies the actual operation and rollback restores its permission',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-role',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'customize-role',
        };
        const app = await startComposedApplication({
          ...options,
          seedProfile: 'distributor',
          port: 0,
        });
        const opened = await openCustomizeService(options);
        try {
          const roleKey = 'local-demo-full-release';
          const createId = 'northstar.app:operation.item_create';
          const updateId = 'northstar.app:operation.item_update';
          const headers = { cookie: 'northstar-demo-actor=manager' };
          const preview = (operationId: string, asManager = false) =>
            app.runtime.entry.run(
              { headers: asManager ? headers : {} },
              (view) =>
                app.runtime.operationGateway.previewTaskEligibility(
                  view,
                  [operationId],
                  null,
                ),
            );
          const recordId = randomUUID();
          const world = worldOver(app.runtime, String(connection.database));
          const create = () =>
            world.invoke(
              'item_create',
              {
                recordId,
                relations: {},
                values: {
                  'northstar.app:field.item_name': 'Role restriction witness',
                  'northstar.app:field.item_sku': 'ROLE-RESTRICTION',
                  'northstar.app:field.item_base_unit': 'EA',
                },
              },
              { actor: 'buyer' },
            );
          const manager = await app.runtime.entry.run(
            { headers },
            async (view) => trustedContextForRequestRuntimeView(view),
          );
          assert.notEqual(
            manager.principalId,
            app.runtime.identity.principalId,
          );
          assert.ok(
            (
              await opened.service.targets(manager)
            ).permissionRoleKeys?.includes(roleKey),
          );
          assert.equal(await preview(createId), 'eligible');
          const draft = await opened.service.draft(
            {
              kind: 'narrowPermission',
              roleKey,
              target: { kind: 'operation', id: createId },
            },
            'visualBuilder',
            undefined,
            manager,
          );
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          assert.equal(
            (await recordedPatch(pool, draft.patchId)).authored_by,
            manager.principalId,
          );
          await opened.service.approve(draft.patchId);
          const setRoleAvailability = (active: boolean) =>
            pool.query(
              `UPDATE platform.current_policy_roles
                  SET revoked_at = CASE WHEN $4::boolean THEN NULL ELSE clock_timestamp() END
                WHERE tenant_id = $1 AND environment_id = $2 AND role_key = $3`,
              [
                app.runtime.identity.tenantId,
                app.runtime.identity.environmentId,
                roleKey,
                active,
              ],
            );
          await setRoleAvailability(false);
          await assert.rejects(() => opened.service.activate(draft.patchId), {
            code: 'CUSTOMIZE_TARGET_NOT_FOUND',
          });
          await setRoleAvailability(true);
          await opened.service.activate(draft.patchId);
          await assert.rejects(
            create,
            { name: 'SemanticOperationPolicyDeniedError' },
            'the selected role cannot perform the live operation',
          );
          assert.equal(await preview(createId), 'ineligible');
          assert.equal(await preview(updateId), 'eligible');
          assert.equal(await preview(createId, true), 'eligible');
          const removal = await opened.service.draft(
            {
              kind: 'unNarrowPermission',
              roleKey,
              target: { kind: 'operation', id: createId },
            },
            'visualBuilder',
          );
          assert.ok(removal.status === 'drafted', JSON.stringify(removal));
          await opened.service.approve(removal.patchId);
          await opened.service.activate(removal.patchId);
          assert.equal(await preview(createId), 'eligible');
          await opened.service.rollback();
          assert.equal(await preview(createId), 'ineligible');
          await opened.service.approve(removal.patchId);
          await opened.service.activate(removal.patchId);
          assert.equal(await preview(createId), 'eligible');
          assert.equal((await create()).outcome, 'succeeded');
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
  'an approved Today card reads the exact sum before pagination and disappears on rollback',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-metric',
      async ({ connection }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'customize-metric',
        };
        const app = await startComposedApplication({
          ...options,
          seedProfile: 'distributor',
          port: 0,
        });
        const opened = await openCustomizeService(options);
        try {
          const world = worldOver(app.runtime, String(connection.database));
          const field = 'northstar.app:field.item_price_cad';
          for (const [suffix, price] of [
            ['A', '0.1'],
            ['B', '0.2'],
          ] as const) {
            const created = await world.invoke('item_create', {
              recordId: randomUUID(),
              relations: {},
              values: {
                'northstar.app:field.item_name': `Metric witness ${suffix}`,
                'northstar.app:field.item_sku': `METRIC-${suffix}`,
                'northstar.app:field.item_base_unit': 'EA',
                [field]: price,
              },
            });
            assert.equal(created.outcome, 'succeeded');
          }
          const draft = await opened.service.draft(
            {
              kind: 'addMetricCard',
              surface: 'northstar.app:surface.item_list',
              label: 'Catalog prices in CAD',
              sumField: field,
            },
            'visualBuilder',
          );
          assert.equal(draft.status, 'drafted', JSON.stringify(draft));
          await opened.service.approve(draft.patchId);
          await opened.service.activate(draft.patchId);
          const actor = { cookie: 'northstar-demo-actor=manager' };
          const readSum = (search: string) =>
            app.runtime.entry.run({ headers: actor }, (view) =>
              app.runtime.queryGateway.invoke(view, {
                schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
                queryId: 'northstar.app:query.item_list',
                arguments: {
                  includeArchived: false,
                  list: {
                    cursor: null,
                    matchMode: 'substring',
                    pageSize: 1,
                    relationLabels: [],
                    schemaVersion: SHARED_LIST_QUERY_VERSION,
                    search,
                    sort: [],
                    sumField: field,
                  },
                },
              }),
            );
          const result = await readSum('Metric witness');
          assert.equal(result.records.length, 1);
          assert.equal(result.listCoverage?.totalCount, 2);
          assert.deepEqual(
            result.listCoverage?.sum,
            { fieldId: field, value: '0.3' },
            'the exact sum covers the matching rows beyond the first page',
          );
          const agent = new OperationsAgentSession({
            runtime: app.runtime,
            companyId: COMPANY,
            personHeaders: actor,
            approve: () => Promise.resolve(true),
          });
          const discover = () =>
            agent.call('erp_discover', {
              mode: 'contracts',
              canonicalIds: ['northstar.app:query.item_list'],
            });
          assert.match(
            JSON.stringify((await discover()).content),
            /Catalog prices in CAD/u,
          );
          const metricId = 'northstar.app:metric.custom_catalog_prices_in_cad';
          const readCard = () =>
            agent.call('erp_query', {
              queryId: 'northstar.app:query.item_list',
              arguments: { metric: metricId },
            });
          const answer = await readCard();
          assert.equal(answer.isError, false, JSON.stringify(answer.content));
          assert.deepEqual(answer.content, {
            queryId: 'northstar.app:query.item_list',
            metricId,
            label: 'Catalog prices in CAD',
            outcome: 'exact',
            value: (await readSum('')).listCoverage?.sum?.value,
          });
          await opened.service.rollback();
          assert.doesNotMatch(
            JSON.stringify((await discover()).content),
            /Catalog prices in CAD/u,
          );
          assert.equal((await readCard()).isError, true);
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

function startRuntime(
  databaseUrl: string,
  slug: string,
  inputs: Pick<
    Parameters<typeof createComposedApplicationRuntime>[0],
    'compiledApplication' | 'customization'
  > = { compiledApplication },
) {
  return createComposedApplicationRuntime({
    capabilityOperationExecutorFactories: [
      INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
      RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
      PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY,
    ],
    ...inputs,
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
  'one inspection change activates linked records and owned lines, and an assistant transition needs a yes',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-inspection',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'customize-inspection',
        };
        const app = await startComposedApplication({
          ...options,
          port: 0,
          seedProfile: 'distributor',
        });
        const request =
          'Set up an inspection process for incoming goods with result lines and pass, fail, conditional and quarantine outcomes.';
        const opened = await openCustomizeService({
          ...options,
          draftingProvider: () =>
            Promise.resolve(
              scriptedModel([
                (conversation) => {
                  assert.deepEqual(conversation, [
                    { role: 'user', text: request },
                  ]);
                  return {
                    toolCalls: [
                      {
                        name: DRAFT_CUSTOMIZATION_TOOL,
                        input: inspectionChange,
                      },
                    ],
                  };
                },
              ]),
            ),
        });
        try {
          const drafted = await opened.service.draftFromRequest(request);
          assert.equal(
            drafted.status,
            'drafted',
            JSON.stringify(drafted.status === 'drafted' ? [] : drafted),
          );
          assert.match(drafted.renderedDiff, /Inspection results/u);
          assert.match(
            drafted.renderedDiff,
            /Quarantine changes "Pending" to "Quarantined"/u,
          );
          assert.equal(
            (await recordedPatch(pool, drafted.patchId)).patch_kind,
            'changeSet',
          );
          assert.equal((await opened.service.status()).patches.length, 1);
          await opened.service.approve(drafted.patchId);
          await opened.service.activate(drafted.patchId);
          const world = worldOver(app.runtime, String(connection.database));
          const { receipt, supplier, item, location } =
            await inspectionLinkRecords(world.create, seededId);
          const beforeMovements = await world.list(
            'northstar.app:query.inventory_movement_list',
          );
          const header = await world.create(
            inspection,
            { name: 'Incoming lot' },
            { goods_receipt: receipt.recordId, supplier, item, location },
          );
          const lineType = `${inspection}_lines`;
          const line = await world.create(
            lineType,
            {
              line_number: '1',
              characteristic: 'Length',
              measured_value: '21',
              pass: true,
            },
            { parent: header.recordId },
          );
          const other = await world.create(inspection, { name: 'Another lot' });
          await world.create(
            lineType,
            { line_number: '1', characteristic: 'Width' },
            { parent: other.recordId },
          );
          const lines = await world.list(
            `northstar.app:query.${lineType}_list`,
            {
              parentScope: {
                relationId: `northstar.app:relation.${lineType}_parent`,
                recordId: header.recordId,
              },
            },
          );
          assert.deepEqual(
            lines.map((row) => row.recordId),
            [line.recordId],
          );
          await assert.rejects(
            world.invoke(`${inspection}_archive`, {
              recordId: header.recordId,
              expectedRevision: header.revision,
            }),
            /active dependent records/u,
          );

          const agent = new OperationsAgentSession({
            runtime: app.runtime,
            companyId: COMPANY,
            personHeaders: { cookie: 'northstar-demo-actor=manager' },
            autoApproveReversible: true,
            approve: (plan) =>
              Promise.resolve(plan.steps[0]?.operationLabel === 'Quarantine'),
          });
          const found = await agent.call('erp_query', {
            queryId: `${inspection}_list`,
            arguments: {
              search:
                receipt.values['northstar.app:field.goods_receipt_number'],
            },
          });
          assert.equal(found.isError, false, JSON.stringify(found.content));
          assert.deepEqual(
            (found.content as { records: { recordId: string }[] }).records.map(
              (record) => record.recordId,
            ),
            [header.recordId],
          );
          const plan = await agent.call('erp_plan', {
            intents: [
              {
                operationId: `${inspection}_action_quarantine`,
                target: header.recordId,
              },
            ],
          });
          assert.equal(plan.isError, false, JSON.stringify(plan.content));
          assert.equal(agent.approvals.at(-1)?.riskClass, 'needsYes');
          assert.equal(agent.approvals.at(-1)?.by, 'person');
          const executed = await agent.call('erp_execute', {
            planId: (plan.content as { planId: string }).planId,
            executionIdempotencyKey: 'inspection-quarantine',
          });
          assert.equal(
            executed.isError,
            false,
            JSON.stringify(executed.content),
          );
          const current = await world.read(inspection, header.recordId);
          assert.equal(
            current.values[
              `northstar.app:derived_state_field.machine.${inspection}`
            ],
            `northstar.app:state.${inspection}_quarantined`,
          );
          const afterMovements = await world.list(
            'northstar.app:query.inventory_movement_list',
          );
          assert.deepEqual(
            afterMovements.map((row) => row.recordId),
            beforeMovements.map((row) => row.recordId),
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
          assert.equal(diagnostic.code, 'CUSTOMIZE_UPGRADE_CONFLICT');
          assert.match(
            JSON.stringify(diagnostic.issues),
            /firstPartySubject.*northstar.app:field.item_sku/u,
          );
          assert.match(
            JSON.stringify(diagnostic.issues),
            /firstPartyBase.*tenantPatch.*Shelf code/u,
          );
          assert.deepEqual(
            upgradeLogFields(diagnostic),
            {
              status: 'rejected',
              code: 'CUSTOMIZE_UPGRADE_CONFLICT',
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
          while (
            !(
              await holder.query(
                `SELECT 1 FROM pg_stat_activity WHERE pg_backend_pid()=ANY(pg_blocking_pids(pid))`,
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
) {
  const authored = structuredClone(firstPartyAuthored) as Record<
    string,
    unknown
  >;
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
    assert.equal(
      refusals.rows[0]?.diagnostic.code,
      'CUSTOMIZE_UPGRADE_CONFLICT',
    );
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
  'a refused record-type upgrade serves verified records and an unknown live kind can roll back',
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
            assert.equal(boot.customizationUpgrade?.status, 'refused');
            const status = await opened.service.status();
            assert.equal(status.upgradeRefusal?.code, 'CUSTOMIZE_BASE_MOVED');
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
              assert.match(
                cli,
                /Platform upgrade refused: CUSTOMIZE_BASE_MOVED/u,
              );
              assert.match(cli, /futurePatchKind/u);
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
