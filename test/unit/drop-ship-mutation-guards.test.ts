import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { assertDropShipMutation } from '../../packages/postgres-provider/src/drop-ship-mutation-guards.js';
import { InventoryPostingError } from '../../packages/postgres-provider/src/inventory-posting-error.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { additionalListProgressSql } from '../../packages/postgres-provider/src/list-progress-read-model.js';

test('drop-ship admission requires a fresh active supplier, leaves stock alone and refuses generic link assignment', async () => {
  const storage = await governedStorageTarget();
  const entity = storage.entities.find((entry) =>
    entry.entityId.endsWith(':entity.sales_order_line'),
  )!;
  const ns = 'northstar.app';
  const supplier = randomUUID();
  const scope = { tenantId: randomUUID(), environmentId: randomUUID() };
  const reads: unknown[][] = [];
  let active = true;
  const client = {
    query: async (_sql: string, parameters: unknown[]) => {
      reads.push(parameters);
      return { rows: [{ count: active ? 1 : 0 }] };
    },
  } as unknown as Parameters<typeof assertDropShipMutation>[0];
  const request = {
    context: scope,
    definition: {
      operationId: `${ns}:operation.sales_order_line_create`,
      effect: { kind: 'createRecordEffect' },
    },
  } as Parameters<typeof assertDropShipMutation>[3];
  const input = (
    patch: Record<string, string>,
    relations: Record<string, string> = {},
  ) => ({ patch, relations }) as Parameters<typeof assertDropShipMutation>[4];
  const stock = input({
    [`${ns}:field.sales_order_line_fulfillment_route`]: `${ns}:option.fulfillment_route_stock`,
  });
  await assertDropShipMutation(client, storage, entity, request, stock);
  assert.deepEqual(reads, [], 'stock admission has no supplier lookup');
  const dropShip = input({
    [`${ns}:field.sales_order_line_fulfillment_route`]: `${ns}:option.fulfillment_route_drop_ship`,
  });
  await assert.rejects(
    assertDropShipMutation(client, storage, entity, request, dropShip),
    (error: unknown) =>
      error instanceof InventoryPostingError &&
      error.code === 'INVENTORY_POSTING_INPUT_INVALID' &&
      error.message.includes('requires a supplier'),
  );
  const supplied = input({
    ...dropShip.patch,
    [`${ns}:field.sales_order_line_drop_ship_supplier_id`]: supplier,
  } as Record<string, string>);
  await assertDropShipMutation(client, storage, entity, request, supplied);
  assert.deepEqual(reads, [
    [
      scope.tenantId,
      scope.environmentId,
      supplier,
      `${ns}:option.supplier`,
      `${ns}:option.active`,
    ],
  ]);
  active = false;
  await assert.rejects(
    assertDropShipMutation(client, storage, entity, request, supplied),
    /active supplier/u,
  );
  assert.equal(reads.length, 2, 'eligibility is re-read, never cached');
  await assert.rejects(
    assertDropShipMutation(
      client,
      storage,
      entity,
      request,
      input(stock.patch as Record<string, string>, {
        [`${ns}:relation.sales_order_line_purchase_line`]: randomUUID(),
      }),
    ),
    /only by Create drop-ship PO/u,
  );
});

test('linked purchase header protection resolves the declared supplier, currency and ship-to fields', async () => {
  const storage = await governedStorageTarget();
  const target = storage.entities.find((entry) =>
    entry.entityId.endsWith(':entity.purchase_order'),
  )!;
  const field = (name: string) =>
    target.columns.find((column) =>
      column.canonicalFieldId.endsWith(`:field.purchase_order_${name}`),
    )!;
  const supplier = randomUUID();
  const values: Record<string, string> = {
    supplier_party_id: supplier,
    currency: 'CAD',
    ship_to_name: 'Customer dock',
  };
  const header = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      field(key).physicalName,
      value,
    ]),
  );
  let reads = 0;
  const client = {
    query: async (sql: string) => {
      reads++;
      return sql.includes('FOR NO KEY UPDATE')
        ? { rows: [header], rowCount: 1 }
        : { rows: [{ record_id: randomUUID() }], rowCount: 1 };
    },
  } as unknown as Parameters<typeof assertDropShipMutation>[0];
  const request = {
    context: { tenantId: randomUUID(), environmentId: randomUUID() },
    definition: { effect: { kind: 'updateRecordEffect' } },
  } as Parameters<typeof assertDropShipMutation>[3];
  const input = (patch: Record<string, string>) =>
    ({ recordId: randomUUID(), patch, relations: {} }) as Parameters<
      typeof assertDropShipMutation
    >[4];
  await assertDropShipMutation(
    client,
    storage,
    target,
    request,
    input({ [field('notes').canonicalFieldId]: 'Still editable' }),
  );
  assert.equal(reads, 0);
  for (const [key, value] of Object.entries(values)) {
    await assertDropShipMutation(
      client,
      storage,
      target,
      request,
      input({ [field(key).canonicalFieldId]: value }),
    );
    await assert.rejects(
      assertDropShipMutation(
        client,
        storage,
        target,
        request,
        input({
          [field(key).canonicalFieldId]:
            key === 'supplier_party_id' ? randomUUID() : `${value} changed`,
        }),
      ),
      /keeps its supplier, currency and customer ship-to/u,
    );
  }
});

test('additional progress filters bind stored canonical enum identities, not display labels', async () => {
  const storage = await governedStorageTarget();
  const extra = storage.entities.find((entry) =>
    entry.entityId.endsWith(':entity.drop_ship_delivery'),
  )!;
  const lines = storage.entities.find((entry) =>
    entry.entityId.endsWith(':entity.sales_order_line'),
  )!;
  const state = extra.columns.find((column) =>
    column.canonicalFieldId.endsWith(':field.drop_ship_delivery_state'),
  )!;
  const quantity = extra.columns.find((column) =>
    column.canonicalFieldId.endsWith(':field.drop_ship_delivery_quantity'),
  )!;
  const link = storage.relations.find((relation) =>
    relation.relationId.endsWith(':relation.drop_ship_delivery_sales_line'),
  )!;
  assert.equal(state.fieldContract.fieldKind, 'enumFieldType');
  const posted = 'northstar.app:option.drop_ship_delivery_state_posted';
  const bound: unknown[] = [];
  const sql = additionalListProgressSql(
    {
      entity: extra,
      lineColumn: link.relationColumn.physicalName,
      quantityColumn: quantity.physicalName,
      filters: [{ column: state, value: posted }],
      output: 'delivered',
    },
    lines,
    'scoped_live_lines',
    {
      quote: (name) => `"${name}"`,
      column: (alias, name) => `"${alias}"."${name}"`,
      bind: (value) => {
        bound.push(value);
        return `$${bound.length}`;
      },
      scope: () => ' AND issued_company',
      sameCompany: () => ' AND same_company',
    },
  );
  assert.deepEqual(bound, [posted]);
  assert.ok(
    sql.includes(
      `"table_progress_additional"."${state.physicalName}"::text=$1::text`,
    ),
  );
  assert.doesNotMatch(sql, /initcap|regexp_replace/u);
});
