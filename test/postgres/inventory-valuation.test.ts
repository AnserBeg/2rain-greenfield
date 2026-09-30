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
import { seedInventoryValuation } from '../helpers/inventory-valuation-fixture.js';

const ns = 'northstar.app';
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
