import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  registeredSemanticQueryFromPinnedView,
  type SemanticRecordDto,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import {
  dropShipEntity,
  dropShipTable,
  dropShipColumn,
  dropShipQuote,
} from '../../packages/postgres-provider/src/drop-ship-support.js';

test(
  'dedicated special-order supply gates reservation, shipment and receipt reversal without automatic reservation',
  { timeout: 300_000 },
  async (t) => {
    await withOrderEntryFixture(async (fixture) => {
      const ns = 'northstar.app';
      const query = (local: string, args: Record<string, unknown>) =>
        fixture.app.runtime.entry.run({ headers: {} }, (view) =>
          fixture.app.runtime.queryGateway.invoke(view, {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId: `${ns}:query.${local}`,
            arguments: {
              ...args,
              [registeredSemanticQueryFromPinnedView(
                view,
                `${ns}:query.${local}`,
              )!.legalEntityScope!.operand.parameterId]: fixture.scope,
            } as never,
          }),
        );
      const get = async (
        local: string,
        recordId: string,
        relationTargets: string[] = [],
      ) =>
        (
          await query(`${local}_get`, {
            recordId,
            includeArchived: false,
            relationTargets: relationTargets.map(
              (local) => `${ns}:relation.${local}`,
            ),
          })
        ).records[0]!;
      const command = async (local: string, record: SemanticRecordDto) =>
        (
          await fixture.invoke(local, {
            recordId: record.recordId,
            expectedRevision: record.revision,
          })
        ).readBack!;
      const order = await fixture.create('sales_order', {
        customer_party_id: fixture.customer,
        currency: 'CAD',
        order_date: new Date().toISOString(),
        ship_to_name: 'Customer',
        ship_to_street: '1 Main St',
        ship_to_city: 'Calgary',
        ship_to_region: 'AB',
        ship_to_postal_code: 'T2P 0A1',
        ship_to_country: 'Canada',
      });
      await t.test(
        'supplier is required before confirming special-order demand',
        async () => {
          await assert.rejects(
            fixture.create(
              'sales_order_line',
              {
                line_number: '1',
                item_id: fixture.item,
                unit_id: 'EA',
                ordered_quantity: '5',
                fulfillment_route: `${ns}:option.fulfillment_route_special_order`,
              },
              { order: order.recordId },
            ),
            /requires a supplier/u,
          );
        },
      );
      const demand = await fixture.create(
        'sales_order_line',
        {
          line_number: '1',
          item_id: fixture.item,
          unit_id: 'EA',
          ordered_quantity: '5',
          unit_price: '12',
          fulfillment_route: `${ns}:option.fulfillment_route_special_order`,
          drop_ship_supplier_id: fixture.customer,
        },
        { order: order.recordId },
      );
      await command('sales_order_release', order);
      const reserve = (amount: string) =>
        fixture.create(
          'reservation',
          {
            state: `${ns}:option.reservation_state_draft`,
            item_id: fixture.item,
            unit_id: 'EA',
            location_id: fixture.location,
            quantity: amount,
            reason: 'Dedicated special order',
          },
          { order_line: demand.recordId },
        );
      const noLink = await reserve('1');
      await t.test(
        'unlinked special order cannot reserve unrelated opening stock',
        async () => {
          await assert.rejects(
            command('reservation_reserve', noLink),
            /SPECIAL_ORDER_SUPPLY_LINK_REQUIRED/u,
          );
        },
      );
      await fixture.invoke('reservation_archive', {
        recordId: noLink.recordId,
        expectedRevision: noLink.revision,
      });
      await command(
        'sales_order_create_special_order_po',
        await get('sales_order', order.recordId),
      );
      const linked = await get('sales_order_line', demand.recordId, [
        'sales_order_line_purchase_line',
      ]);
      const purchaseLineId =
        linked.relationLabels![`${ns}:relation.sales_order_line_purchase_line`]!
          .recordId!;
      const supply = await get('purchase_order_line', purchaseLineId, [
        'purchase_order_line_order',
        'purchase_order_line_sales_line',
      ]);
      const purchaseId =
        supply.relationLabels![`${ns}:relation.purchase_order_line_order`]!
          .recordId!;
      await t.test(
        'link creation reuses the same supply line and preserves the one-to-one link',
        async () => {
          await command(
            'sales_order_create_special_order_po',
            await get('sales_order', order.recordId),
          );
          const repeated = await get('sales_order_line', demand.recordId, [
            'sales_order_line_purchase_line',
          ]);
          assert.equal(
            repeated.relationLabels![
              `${ns}:relation.sales_order_line_purchase_line`
            ]!.recordId,
            purchaseLineId,
          );
          assert.equal(
            supply.relationLabels![
              `${ns}:relation.purchase_order_line_sales_line`
            ]!.recordId,
            demand.recordId,
          );
        },
      );
      await command(
        'purchase_order_release',
        await get('purchase_order', purchaseId),
      );
      const early = await reserve('1');
      await t.test(
        'linked but unreceived supply refuses reservation',
        async () => {
          await assert.rejects(
            command('reservation_reserve', early),
            /SPECIAL_ORDER_ARRIVAL_LIMIT/u,
          );
        },
      );
      await fixture.invoke('reservation_archive', {
        recordId: early.recordId,
        expectedRevision: early.revision,
      });
      const receipt = async (
        amount: string,
        original?: string,
        movement?: string,
      ) => {
        const header = await fixture.create(
          'goods_receipt',
          {
            effective_at: new Date().toISOString(),
            kind: `${ns}:option.goods_receipt_kind_${original ? 'reversal' : 'initial'}`,
            location_id: fixture.location,
            reason_code: original ? 'CORRECTION' : 'RECEIPT',
            reason_narrative: 'Special order arrived',
            state: `${ns}:option.goods_receipt_state_draft`,
          },
          { order: purchaseId, ...(original ? { supersedes: original } : {}) },
        );
        await fixture.create(
          'goods_receipt_line',
          {
            line_number: '1',
            item_id: fixture.item,
            unit_id: 'EA',
            quantity: amount,
            cost_status: `${ns}:option.goods_receipt_line_cost_status_absent`,
            ...(movement ? { reversal_of_movement_id: movement } : {}),
          },
          { receipt: header.recordId, order_line: purchaseLineId },
        );
        return header;
      };
      const firstReceipt = await receipt('2');
      await command('goods_receipt_post', firstReceipt);
      await t.test(
        'receipt enters stock, shows arrived on both sides, and creates no reservation',
        async () => {
          const list = {
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            cursor: null,
            pageSize: 100,
            search: '',
            matchMode: 'substring',
            sort: [],
            relationLabels: [],
          };
          const sales = (
            await query('fulfillment_order_lines', {
              includeArchived: false,
              list: {
                ...list,
                parentScope: {
                  relationId: `${ns}:relation.sales_order_line_order`,
                  recordId: order.recordId,
                },
              },
            })
          ).records.find((row) => row.recordId === demand.recordId)!;
          assert.equal(
            sales.values[`${ns}:metric.sales_line_route`],
            'Special order',
          );
          assert.equal(sales.values[`${ns}:metric.sales_line_arrived`], '2');
          assert.equal(sales.values[`${ns}:metric.special_reservable`], '2');
          const reservations = await query('reservation_list', {
            includeArchived: false,
            list: {
              ...list,
              referenceScope: {
                relationId: `${ns}:relation.reservation_order_line`,
                recordId: demand.recordId,
              },
            },
          });
          assert.equal(reservations.records.length, 0);
        },
      );
      const tooMuch = await reserve('3');
      await t.test(
        'unrelated stock cannot cover more than arrived supply',
        async () => {
          await assert.rejects(
            command('reservation_reserve', tooMuch),
            /SPECIAL_ORDER_ARRIVAL_LIMIT/u,
          );
        },
      );
      await fixture.invoke('reservation_archive', {
        recordId: tooMuch.recordId,
        expectedRevision: tooMuch.revision,
      });
      const [a, b] = await Promise.all([reserve('2'), reserve('2')]);
      const outcomes = await Promise.allSettled([
        command('reservation_reserve', a),
        command('reservation_reserve', b),
      ]);
      await t.test(
        'competing reservations cannot each consume the same arrivals',
        () => {
          assert.equal(
            outcomes.filter((result) => result.status === 'fulfilled').length,
            1,
          );
          assert.match(
            String(
              outcomes.find((result) => result.status === 'rejected')!
                .status === 'rejected' &&
                (
                  outcomes.find(
                    (result) => result.status === 'rejected',
                  ) as PromiseRejectedResult
                ).reason,
            ),
            /SPECIAL_ORDER_ARRIVAL_LIMIT/u,
          );
        },
      );
      const reserved = outcomes[0]!.status === 'fulfilled' ? a : b;
      const storage = await governedStorageTarget();
      const movement = dropShipEntity(storage, 'inventory_movement');
      const originalMovement = (
        await fixture.pool.query<{ record_id: string }>(
          `SELECT record_id FROM ${dropShipTable(movement)} WHERE tenant_id=$1 AND environment_id=$2 AND ${dropShipQuote(dropShipColumn(movement, 'inventory_movement_source_id'))}=$3`,
          [
            fixture.app.runtime.identity.tenantId,
            fixture.app.runtime.identity.environmentId,
            firstReceipt.recordId,
          ],
        )
      ).rows[0]!.record_id;
      const reduction = await receipt(
        '-2',
        firstReceipt.recordId,
        originalMovement,
      );
      await t.test(
        'receipt reversal cannot remove supply backing a live reservation',
        async () => {
          await assert.rejects(
            command('goods_receipt_post', reduction),
            /SPECIAL_ORDER_ARRIVAL_LIMIT/u,
          );
        },
      );
      const header = await fixture.create(
        'shipment',
        {
          effective_at: new Date().toISOString(),
          external_reference: randomUUID(),
          kind: `${ns}:option.shipment_kind_initial`,
          location_id: fixture.location,
          reason_code: 'SHIP',
          reason_narrative: 'Ship special order',
          state: `${ns}:option.shipment_state_draft`,
          ...Object.fromEntries(
            Object.entries(order.values)
              .filter(([key]) => key.includes(':field.sales_order_ship_to_'))
              .map(([key, value]) => [key.split('sales_order_')[1]!, value]),
          ),
        },
        { order: order.recordId },
      );
      await fixture.create(
        'shipment_line',
        {
          line_number: '1',
          item_id: fixture.item,
          unit_id: 'EA',
          quantity: '2',
        },
        {
          shipment: header.recordId,
          order_line: demand.recordId,
          reservation: reserved.recordId,
        },
      );
      await t.test(
        'reserved arrived quantity ships through the unchanged stock operation',
        async () => {
          const shipped = await command('shipment_post', header);
          assert.ok(shipped);
        },
      );
      await t.test(
        'receipt reversal cannot remove supply already shipped',
        async () => {
          await assert.rejects(
            command('goods_receipt_post', reduction),
            /SPECIAL_ORDER_ARRIVAL_LIMIT/u,
          );
        },
      );
      await t.test(
        'receipt and shipment persist real stock movements, never off-ledger deliveries',
        async () => {
          const rows = await fixture.pool.query<{
            role: string;
            quantity: string;
          }>(
            `SELECT ${dropShipQuote(dropShipColumn(movement, 'inventory_movement_posting_role'))} AS role, ${dropShipQuote(dropShipColumn(movement, 'inventory_movement_quantity_delta'))}::text AS quantity FROM ${dropShipTable(movement)} WHERE tenant_id=$1 AND environment_id=$2 AND ${dropShipQuote(dropShipColumn(movement, 'inventory_movement_source_id'))}=ANY($3::text[])`,
            [
              fixture.app.runtime.identity.tenantId,
              fixture.app.runtime.identity.environmentId,
              [firstReceipt.recordId, header.recordId],
            ],
          );
          assert.equal(rows.rows.length, 2);
          assert.deepEqual(
            rows.rows.map((row) => Number(row.quantity)).sort((a, b) => a - b),
            [-2, 2],
          );
        },
      );
    });
  },
);
