import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { calculatedDisplayDraft } from '../../packages/customization/src/calculated-display-draft.js';
import { OperationsAgentSession } from '../../packages/operations-agent/src/session.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import {
  archivedRuntimeRead,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-customization-runtime.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

test(
  'calculated margin is exact through item reads, lists and operation read-back and disappears on rollback',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-calculated-display',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'customize-calculated-display',
        };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        try {
          const target = (
            await opened.service.targets()
          ).calculatedDisplayTargets?.find(
            ({ recordSurfaceId }) =>
              recordSurfaceId === 'northstar.app:surface.item_detail',
          );
          assert.ok(target);
          const price = 'northstar.app:field.item_price_cad';
          const cost = 'northstar.app:field.item_standard_cost_cad';
          const itemList = 'northstar.app:query.item_list';
          const patch = calculatedDisplayDraft(target, {
            label: 'Margin CAD',
            operator: 'subtract',
            leftFieldId: price,
            rightFieldId: cost,
            listSurfaceId: 'northstar.app:surface.item_list',
          });
          const fieldId = patch.field.fieldId;
          const readPhysicalColumns = () =>
            pool
              .query(
                `SELECT table_schema, table_name, column_name
          FROM information_schema.columns
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          ORDER BY table_schema, table_name, ordinal_position`,
              )
              .then(({ rows }) => rows);
          const columns = await readPhysicalColumns();
          const draft = await opened.service.draft(patch, 'visualBuilder');
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          assert.match(
            draft.renderedDiff,
            /Price \(CAD\) − Standard cost \(CAD\)/u,
          );
          await opened.service.approve(draft.patchId);
          await withArchivedCustomizationRuntime(
            '61c8afb1dd760c854bc5bc33890f1e85fc2a0e99',
            async (run) => {
              const read = () =>
                archivedRuntimeRead(run, {
                  databaseUrl: options.databaseUrl,
                  identity: app.runtime.identity,
                });
              assert.equal((await read()).outcome, 'loaded');
              await opened.service.activate(draft.patchId);
              const refusal = await read();
              assert.equal(refusal.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
              assert.match(
                refusal.message ?? '',
                /query-catalog requires version 4/u,
              );
            },
          );
          assert.deepEqual(await readPhysicalColumns(), columns);
          const world = worldOver(app.runtime, String(connection.database));
          const recordId = randomUUID();
          const issue = (sku: string, id: string, value?: string) =>
            world.invoke(
              'item_create',
              {
                recordId: id,
                relations: {},
                values: {
                  'northstar.app:field.item_sku': sku,
                  'northstar.app:field.item_name': sku,
                  'northstar.app:field.item_base_unit': 'EA',
                  [price]: '1.230000000000000001',
                  ...(value ? { [cost]: value } : {}),
                },
              },
              { actor: 'buyer' },
            );
          const created = await issue(
            'MARGIN-PG',
            recordId,
            '0.230000000000000002',
          );
          assert.equal(
            created.readBack?.values[fieldId],
            '0.999999999999999999',
          );
          assert.equal(
            (await world.read('item', recordId)).values[fieldId],
            '0.999999999999999999',
          );
          const listed = (await world.list(itemList)).find(
            (row) => row.recordId === recordId,
          );
          assert.equal(listed?.values[fieldId], '0.999999999999999999');
          const absent = await issue('MARGIN-ABSENT', randomUUID());
          assert.equal(absent.readBack?.values[fieldId], null);
          const agent = new OperationsAgentSession({
            runtime: app.runtime,
            companyId: COMPANY,
            personHeaders: { cookie: 'northstar-demo-actor=manager' },
            approve: () => Promise.resolve(true),
          });
          const discover = () =>
            agent.call('erp_discover', {
              mode: 'contracts',
              canonicalIds: ['northstar.app:query.item_get'],
            });
          assert.match(
            JSON.stringify((await discover()).content),
            /Margin CAD/u,
          );
          const assistantRead = await agent.call('erp_query', {
            queryId: 'northstar.app:query.item_get',
            arguments: { recordId },
            selection: [fieldId],
          });
          assert.match(
            JSON.stringify(assistantRead.content),
            /0\.999999999999999999/u,
          );
          await opened.service.rollback();
          assert.equal(
            Object.hasOwn((await world.read('item', recordId)).values, fieldId),
            false,
          );
          assert.doesNotMatch(
            JSON.stringify((await discover()).content),
            /Margin CAD/u,
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
