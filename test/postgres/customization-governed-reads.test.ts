import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { OperationsAgentSession } from '../../packages/operations-agent/src/session.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import { trustedContextForRequestRuntimeView } from '../../packages/runtime/src/request-runtime-view.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import { recordedPatch } from '../helpers/customization-patch-record.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

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
