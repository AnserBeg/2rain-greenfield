import assert from 'node:assert/strict';
import test from 'node:test';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import {
  fulfillmentColumn,
  quoteFulfillmentIdentifier as q,
} from '../../packages/postgres-provider/src/fulfillment.js';
import {
  convertUnitQuantity,
  resolveUnitFactor,
} from '../../packages/runtime/src/unit-conversion.js';

const ns = 'northstar.app';
test(
  'unit setup persists exact factors by company/item and rational figures equal an independent computation from stored rows',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      await fixture.create(
        'unit',
        { code: 'EA', name: 'Each', decimals: `${ns}:option.unit_decimals_0` },
        {},
        false,
      );
      await fixture.create(
        'unit',
        { code: 'BOX', name: 'Box', decimals: `${ns}:option.unit_decimals_0` },
        {},
        false,
      );
      await fixture.create('unit_conversion', {
        code: 'BOX-EA',
        from_unit: 'BOX',
        to_unit: 'EA',
        numerator: '12',
        denominator: '1',
      });
      const specific = await fixture.create(
        'unit_conversion',
        {
          code: 'ITEM-BOX-EA',
          from_unit: 'BOX',
          to_unit: 'EA',
          numerator: '24',
          denominator: '1',
        },
        { item: fixture.item },
      );
      const storage = await governedStorageTarget();
      const entity = storage.entities.find(
        (value) => value.entityId === `${ns}:entity.unit_conversion`,
      )!;
      const columns = ['from_unit', 'to_unit', 'numerator', 'denominator'].map(
        (name) => fulfillmentColumn(entity, `unit_conversion_${name}`),
      );
      const itemRelation = storage.relations.find(
        (relation) =>
          relation.relationId === `${ns}:relation.unit_conversion_item`,
      )!;
      const rows = await fixture.pool.query<{
        from_unit: string;
        to_unit: string;
        numerator: string;
        denominator: string;
        item_id: string | null;
      }>(
        `SELECT ${columns.map((column, index) => `${q(column)}::text AS ${q(['from_unit', 'to_unit', 'numerator', 'denominator'][index]!)}`).join(',')}, ${q(itemRelation.relationColumn.physicalName)}::text AS item_id FROM north_star_module.${q(entity.physicalTableName)} WHERE ${q(entity.legalEntity!.column)} = $1 AND ${q(entity.archive.archivedAtColumn)} IS NULL ORDER BY ${q(entity.recordIdentity.column)}`,
        [fixture.scope],
      );
      assert.equal(rows.rowCount, 2);
      const factors = rows.rows.map((row) => ({
        itemId: row.item_id,
        from: row.from_unit,
        to: row.to_unit,
        numerator: row.numerator,
        denominator: row.denominator,
      }));
      const selected = rows.rows.find((row) => row.item_id === fixture.item)!;
      // Independent integer cross multiplication from persisted values, without production lookup or conversion helpers.
      const independentlyComputed =
        (2n * BigInt(selected.numerator)) / BigInt(selected.denominator);
      assert.equal(
        (2n * BigInt(selected.numerator)) % BigInt(selected.denominator),
        0n,
      );
      const [numerator, denominator] = resolveUnitFactor(
        fixture.item,
        'BOX',
        'EA',
        factors,
      );
      assert.equal(
        convertUnitQuantity('2', numerator, denominator, 0, 'EA'),
        independentlyComputed.toString(),
      );
      assert.equal(independentlyComputed, 48n);
      assert.equal(
        specific.values[`${ns}:field.unit_conversion_numerator`],
        '24',
      );
      await assert.rejects(() =>
        fixture.create(
          'unit',
          {
            code: 'ea',
            name: 'Duplicate',
            decimals: `${ns}:option.unit_decimals_0`,
          },
          {},
          false,
        ),
      );
      await assert.rejects(() =>
        fixture.create(
          'unit',
          {
            code: 'BAD',
            name: 'Invalid precision',
            decimals: `${ns}:option.unit_decimals_19`,
          },
          {},
          false,
        ),
      );
    });
  },
);
