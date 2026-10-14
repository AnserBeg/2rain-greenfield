import assert from 'node:assert/strict';
import test from 'node:test';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  fulfillmentTable,
  fulfillmentColumn,
  quoteFulfillmentIdentifier as q,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';
import {
  seedInventoryValuation,
  seedInventoryShipmentValuation,
  seedInventoryLandedValuation,
} from '../helpers/inventory-valuation-fixture.js';

const ns = 'northstar.app';
test(
  'landed stock values equal an independent allocation computed from stored bill charges and actual receipt rows',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (f) => {
      const seed = await seedInventoryLandedValuation(f);
      const target = await governedStorageTarget();
      const entity = (local: string) =>
        target.entities.find((e) => e.entityId === `${ns}:entity.${local}`)!;
      const movement = entity('inventory_movement');
      const receipt = entity('goods_receipt_line');
      const bill = entity('vendor_bill');
      const m = (key: string) =>
        `m.${q(fulfillmentColumn(movement, `inventory_movement_${key}`))}`;
      const r = (key: string) =>
        `r.${q(fulfillmentColumn(receipt, `goods_receipt_line_${key}`))}`;
      // This fixture has two receipt lines and one bill. The oracle uses SQL's
      // independent arithmetic over persisted quantities, costs and charges.
      const { rows } = await f.pool.query(
        `
      WITH received AS (
        SELECT ${m('item_id')} AS item, sum(${m('quantity_delta')}) AS quantity,
          sum(${m('quantity_delta')} * ${r('unit_cost')}) AS basis
        FROM ${fulfillmentTable(movement)} m JOIN ${fulfillmentTable(receipt)} r
          ON r.record_id::text=${m('source_line')} AND r.tenant_id=m.tenant_id
          AND r.environment_id=m.environment_id AND r.legal_entity_id=m.legal_entity_id
        WHERE m.tenant_id=$1 AND m.environment_id=$2 AND m.legal_entity_id=$3
          AND ${m('source_type')}='goodsReceipt' AND ${m('item_id')} IN ($4,$5)
          AND m.archived_at IS NULL GROUP BY ${m('item_id')}
      ), charged AS (
        SELECT ${q(fulfillmentColumn(bill, 'vendor_bill_charges'))} AS charges
        FROM ${fulfillmentTable(bill)} WHERE tenant_id=$1 AND environment_id=$2
          AND legal_entity_id=$3 AND record_id=$6 AND archived_at IS NULL
      ) SELECT item, quantity::text, basis::numeric(38,2)::text,
        charges::numeric(38,2)::text,
        (basis + charges * basis / sum(basis) OVER())::numeric(38,2)::text AS value,
        ((basis + charges * basis / sum(basis) OVER()) / quantity)::numeric(38,6)::text AS average
      FROM received CROSS JOIN charged`,
        [
          f.app.runtime.identity.tenantId,
          f.app.runtime.identity.environmentId,
          f.scope,
          seed.items[0]!.id,
          seed.items[1]!.id,
          seed.bill,
        ],
      );
      assert.equal(rows.length, 2);
      assert.equal(
        rows.reduce((sum, row) => sum + Number(row.basis), 0),
        200,
      );
      assert.equal(rows[0]!.charges, '20.00');
      assert.equal(
        rows.reduce((sum, row) => sum + Number(row.value), 0),
        220,
      );
      for (const oracle of rows) {
        const read = await f.app.runtime.entry.run({ headers: {} }, (view) => {
          const query = registeredSemanticQueryFromPinnedView(
            view,
            `${ns}:query.inventory_value_get`,
          )!;
          return f.app.runtime.queryGateway.invoke(view, {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId: query.queryId,
            arguments: {
              recordId: oracle.item,
              includeArchived: false,
              [query.legalEntityScope!.operand.parameterId]: f.scope,
            },
          });
        });
        const values = read.records[0]!.values;
        assert.equal(
          values[`${ns}:metric.on_hand`],
          String(Number(oracle.quantity)),
        );
        assert.equal(
          values[`${ns}:metric.average_cost`],
          `CAD ${Number(oracle.average)}`,
        );
        assert.equal(
          values[`${ns}:metric.inventory_value`],
          `CAD ${oracle.value}`,
        );
        assert.equal(values[`${ns}:metric.unvalued_quantity`], '0');
        assert.equal(
          values[`${ns}:metric.landed_cost_coverage`],
          'Allocated by actual receipt value',
        );
      }
    });
  },
);
test(
  'inventory value equals an independent SQL computation from posted rows and immutable actual receipt costs',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (f) => {
      await seedInventoryValuation(f);
      const target = await governedStorageTarget();
      const movement = target.entities.find(
        (e) => e.entityId === `${ns}:entity.inventory_movement`,
      )!;
      const receipt = target.entities.find(
        (e) => e.entityId === `${ns}:entity.goods_receipt_line`,
      )!;
      const m = (key: string) =>
        `m.${q(fulfillmentColumn(movement, `inventory_movement_${key}`))}`;
      const r = (key: string) =>
        `r.${q(fulfillmentColumn(receipt, `goods_receipt_line_${key}`))}`;
      // Independent of production replay: this scenario has receipts and opening
      // stock only. SQL sums actual extended cost, known quantities and all units.
      const {
        rows: [oracle],
      } = await f.pool.query(
        `SELECT sum(${m('quantity_delta')})::text AS on_hand,
      sum(CASE WHEN ${m('source_type')}='goodsReceipt' THEN ${m('quantity_delta')} * ${r('unit_cost')} ELSE 0 END)::numeric(38,2)::text AS value,
      (sum(${m('quantity_delta')} * ${r('unit_cost')}) / sum(CASE WHEN ${r('unit_cost')} IS NOT NULL THEN ${m('quantity_delta')} ELSE 0 END))::numeric(38,6)::text AS average,
      sum(CASE WHEN ${r('unit_cost')} IS NULL THEN ${m('quantity_delta')} ELSE 0 END)::text AS unvalued
      FROM ${fulfillmentTable(movement)} m LEFT JOIN ${fulfillmentTable(receipt)} r ON r.record_id::text=${m('source_line')} AND r.tenant_id=m.tenant_id AND r.environment_id=m.environment_id AND r.legal_entity_id=m.legal_entity_id
      WHERE m.tenant_id=$1 AND m.environment_id=$2 AND m.legal_entity_id=$3 AND ${m('item_id')}=$4 AND m.archived_at IS NULL`,
        [
          f.app.runtime.identity.tenantId,
          f.app.runtime.identity.environmentId,
          f.scope,
          f.item,
        ],
      );
      assert.equal(Number(oracle.on_hand), 30);
      assert.equal(Number(oracle.value), 200);
      assert.equal(Number(oracle.average), 10);
      assert.equal(Number(oracle.unvalued), 10);
      const read = await f.app.runtime.entry.run(
        { headers: {} },
        async (view) => {
          const query = registeredSemanticQueryFromPinnedView(
            view,
            `${ns}:query.inventory_value_get`,
          )!;
          return f.app.runtime.queryGateway.invoke(view, {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId: query.queryId,
            arguments: {
              recordId: f.item,
              includeArchived: false,
              [query.legalEntityScope!.operand.parameterId]: f.scope,
            },
          });
        },
      );
      const values = read.records[0]!.values;
      assert.equal(
        values[`${ns}:metric.on_hand`],
        String(Number(oracle.on_hand)),
      );
      assert.equal(
        values[`${ns}:metric.inventory_value`],
        `CAD ${oracle.value}`,
      );
      assert.equal(
        values[`${ns}:metric.average_cost`],
        `CAD ${Number(oracle.average)}`,
      );
      assert.equal(
        values[`${ns}:metric.unvalued_quantity`],
        String(Number(oracle.unvalued)),
      );
      // Reading does not write monetary stock facts or create movements.
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*)::int AS n FROM ${fulfillmentTable(movement)} WHERE tenant_id=$1 AND environment_id=$2`,
            [
              f.app.runtime.identity.tenantId,
              f.app.runtime.identity.environmentId,
            ],
          )
        ).rows[0].n,
        3,
      );
    });
  },
);

test(
  'shipment, order and invoice costs equal stored-row average at shipment time, while a later receipt changes current stock value',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (f) => {
      const seed = await seedInventoryShipmentValuation(f);
      const target = await governedStorageTarget();
      const entity = (local: string) =>
        target.entities.find((e) => e.entityId === `${ns}:entity.${local}`)!;
      const movement = entity('inventory_movement');
      const receipt = entity('goods_receipt_line');
      const invoiceLine = entity('customer_invoice_line');
      const m = (key: string) =>
        `m.${q(fulfillmentColumn(movement, `inventory_movement_${key}`))}`;
      const r = (key: string) =>
        `r.${q(fulfillmentColumn(receipt, `goods_receipt_line_${key}`))}`;
      // Independent SQL observes the stored business ordering: the two initial
      // receipt instants precede the shipment, and the final one follows it.
      const {
        rows: [oracle],
      } = await f.pool.query(
        `
        WITH shipped AS (
          SELECT -sum(${m('quantity_delta')}) AS shipped_quantity, max(${m('effective_at')}) AS instant
          FROM ${fulfillmentTable(movement)} m
          WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3
            AND ${m('source_type')}='shipment' AND ${m('source_id')}=$5
        ), inputs AS (
          SELECT ${m('quantity_delta')} AS quantity, ${r('unit_cost')} AS cost,
            ${m('effective_at')} < shipped.instant AS before_ship
          FROM ${fulfillmentTable(movement)} m
          JOIN ${fulfillmentTable(receipt)} r ON r.record_id::text=${m('source_line')}
            AND r.tenant_id=m.tenant_id AND r.environment_id=m.environment_id AND r.legal_entity_id=m.legal_entity_id
          CROSS JOIN shipped
          WHERE m.tenant_id=$1 AND m.environment_id=$2 AND m.legal_entity_id=$3 AND ${m('item_id')}=$4
            AND ${m('source_type')}='goodsReceipt'
        ) SELECT (shipped.shipped_quantity * sum(quantity*cost) FILTER (WHERE before_ship) / sum(quantity) FILTER (WHERE before_ship))::numeric(38,2)::text AS relieved,
          (sum(quantity*cost) - shipped.shipped_quantity * sum(quantity*cost) FILTER (WHERE before_ship) / sum(quantity) FILTER (WHERE before_ship))::numeric(38,2)::text AS remaining
          FROM inputs CROSS JOIN shipped GROUP BY shipped.shipped_quantity`,
        [
          f.app.runtime.identity.tenantId,
          f.app.runtime.identity.environmentId,
          f.scope,
          seed.item,
          seed.shipment,
        ],
      );
      assert.equal(oracle.relieved, '40.00');
      assert.equal(oracle.remaining, '460.00');
      const {
        rows: [billed],
      } = await f.pool.query(
        `SELECT sum(${q(fulfillmentColumn(invoiceLine, 'customer_invoice_line_amount'))})::numeric(38,2)::text AS revenue,
        sum(${q(fulfillmentColumn(invoiceLine, 'customer_invoice_line_quantity'))})::text AS quantity
        FROM ${fulfillmentTable(invoiceLine)} WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3
          AND ${q(target.relations.find((relation) => relation.relationId === `${ns}:relation.customer_invoice_line_invoice`)!.relationColumn.physicalName)}=$4`,
        [
          f.app.runtime.identity.tenantId,
          f.app.runtime.identity.environmentId,
          f.scope,
          seed.invoice,
        ],
      );
      assert.equal(billed.revenue, '100.00');
      assert.equal(Number(billed.quantity), 4);
      const read = (local: string, recordId: string) =>
        f.app.runtime.entry.run({ headers: {} }, (view) => {
          const query = registeredSemanticQueryFromPinnedView(
            view,
            `${ns}:query.${local}`,
          )!;
          return f.app.runtime.queryGateway.invoke(view, {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId: query.queryId,
            arguments: {
              recordId,
              includeArchived: false,
              [query.legalEntityScope!.operand.parameterId]: f.scope,
            },
          });
        });
      for (const [local, id] of [
        ['valuation_shipment_get', seed.shipment],
        ['commercial_order_get', seed.order],
        ['valuation_customer_invoice_get', seed.invoice],
      ]) {
        const row = (await read(local!, id!)).records[0]!;
        assert.equal(
          row.values[`${ns}:metric.cost_of_goods`],
          `CAD ${oracle.relieved}`,
          local,
        );
        assert.equal(row.values[`${ns}:metric.cost_unvalued_quantity`], '0');
        if (local !== 'valuation_shipment_get')
          assert.equal(
            row.values[`${ns}:metric.product_margin`],
            `CAD ${(Number(billed.revenue) - Number(oracle.relieved)).toFixed(2)}`,
          );
      }
      const stock = (await read('inventory_value_get', seed.item)).records[0]!;
      assert.equal(
        stock.values[`${ns}:metric.inventory_value`],
        `CAD ${oracle.remaining}`,
      );
      assert.equal(stock.values[`${ns}:metric.average_cost`], 'CAD 17.692308');
      const lines = await f.app.runtime.entry.run({ headers: {} }, (view) => {
        const query = registeredSemanticQueryFromPinnedView(
          view,
          `${ns}:query.valuation_shipment_line_list`,
        )!;
        return f.app.runtime.queryGateway.invoke(view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId: query.queryId,
          arguments: {
            includeArchived: false,
            [query.legalEntityScope!.operand.parameterId]: f.scope,
          },
        });
      });
      assert.equal(
        lines.records.find((row) => row.recordId === seed.shipmentLine)!.values[
          `${ns}:metric.cost_of_goods`
        ],
        `CAD ${oracle.relieved}`,
      );
    });
  },
);
