import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { assertDropShipMutation } from '../../packages/postgres-provider/src/drop-ship-mutation-guards.js';
import { InventoryPostingError } from '../../packages/postgres-provider/src/inventory-posting-error.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';

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
