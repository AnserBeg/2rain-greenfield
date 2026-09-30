import assert from 'node:assert/strict';
import test from 'node:test';
import {
  itemCostFigures,
  replayInventoryValue,
  display,
  divide,
  type CostMovement,
  type ReceiptCost,
} from '../../packages/postgres-provider/src/inventory-valuation.js';

const movement = (
  id: string,
  quantity: string,
  extra: Partial<CostMovement> = {},
): CostMovement => ({
  id,
  quantity,
  item: 'item',
  unit: 'EA',
  sourceType: 'goodsReceipt',
  sourceId: id,
  sourceLine: id,
  role: 'receipt',
  reversal: null,
  effectiveAt: `2026-09-30T10:00:0${id}.000Z`,
  recordedAt: `2026-09-30T10:00:0${id}.000Z`,
  ...extra,
});
const costs = (entries: readonly [string, string | null, string?][]) =>
  new Map<string, ReceiptCost>(
    entries.map(([id, cost, currency = 'CAD']) => [
      JSON.stringify([id, id]),
      {
        item: 'item',
        unit: 'EA',
        known: cost !== null,
        unitCost: cost,
        currency: cost === null ? null : currency,
      },
    ]),
  );

test('moving average uses remaining stock and exact effective ordering; inputs are never changed', () => {
  const rows = [
    movement('1', '10'),
    movement('2', '-4', { sourceType: 'shipment', role: 'shipment' }),
    movement('3', '2'),
  ];
  const original = structuredClone(rows);
  const replay = replayInventoryValue(
    [...rows].reverse(),
    costs([
      ['1', '5'],
      ['3', '9'],
    ]),
  );
  assert.deepEqual(itemCostFigures(replay.items.get('item')), {
    on_hand: '8',
    average_cost: 'CAD 6',
    inventory_value: 'CAD 48.00',
    unvalued_quantity: '0',
  });
  assert.equal(
    display(replay.effects.get('2')!.pools.get('CAD')!.value, 2),
    '-20.00',
  );
  assert.deepEqual(rows, original);
});

test('unknown costs remain unvalued and each currency has its own average and proportional relief', () => {
  const rows = [
    movement('1', '2'),
    movement('2', '2'),
    movement('3', '2'),
    movement('4', '-3', { sourceType: 'shipment', role: 'shipment' }),
  ];
  const replay = replayInventoryValue(
    rows,
    costs([
      ['1', '10'],
      ['2', '20', 'USD'],
      ['3', null],
    ]),
  );
  assert.deepEqual(itemCostFigures(replay.items.get('item')), {
    on_hand: '3',
    average_cost: 'CAD 10 · USD 20',
    inventory_value: 'CAD 10.00 · USD 20.00',
    unvalued_quantity: '1',
  });
  assert.equal(display(replay.effects.get('4')!.unvalued, 18, true), '-1');
  assert.equal(replay.effects.get('4')!.pools.size, 2);
});

test('opening stock is unvalued, known zero is costed; repeating fractions do not round in replay', () => {
  const replay = replayInventoryValue(
    [
      movement('1', '1', { sourceType: 'opening', role: 'adjustment' }),
      movement('2', '2'),
      movement('3', '-1', { sourceType: 'shipment', role: 'shipment' }),
    ],
    costs([['2', '0']]),
  );
  assert.equal(
    display(replay.items.get('item')!.unvalued, 18, true),
    '0.666666666666666667',
  );
  assert.equal(
    itemCostFigures(replay.items.get('item')).inventory_value,
    'CAD 0.00',
  );
  const repeating = replayInventoryValue(
    [
      movement('1', '1'),
      movement('2', '2'),
      movement('3', '-1', { sourceType: 'shipment', role: 'shipment' }),
    ],
    costs([
      ['1', '1'],
      ['2', '2'],
    ]),
  );
  const pool = repeating.items.get('item')!.pools.get('CAD')!;
  assert.deepEqual(divide(pool.value, pool.quantity), { n: 5n, d: 3n });
});

test('compensation restores original relief after the average changed; paired transfers preserve cost', () => {
  const rows = [
    movement('1', '10'),
    movement('2', '-4', { sourceType: 'shipment', role: 'shipment' }),
    movement('3', '2'),
    movement('4', '2', {
      sourceType: 'shipment',
      role: 'shipment',
      reversal: '2',
    }),
    movement('5', '-2', {
      sourceType: 'transfer',
      role: 'transfer',
      sourceId: 'transfer',
      sourceLine: 'line',
    }),
    movement('6', '2', {
      sourceType: 'transfer',
      role: 'transfer',
      sourceId: 'transfer',
      sourceLine: 'line',
    }),
  ];
  const replay = replayInventoryValue(
    rows,
    costs([
      ['1', '5'],
      ['3', '9'],
    ]),
  );
  assert.deepEqual(itemCostFigures(replay.items.get('item')), {
    on_hand: '10',
    average_cost: 'CAD 5.8',
    inventory_value: 'CAD 58.00',
    unvalued_quantity: '0',
  });
  assert.equal(
    display(replay.effects.get('4')!.pools.get('CAD')!.value, 2),
    '10.00',
  );
  assert.throws(
    () => replayInventoryValue(rows.slice(0, -1), new Map()),
    /Incomplete valuation transfer/u,
  );
});

test('receipt compensation with residual value at zero quantity withholds money instead of dropping value', () => {
  const replay = replayInventoryValue(
    [
      movement('1', '10'),
      movement('2', '-5', { sourceType: 'shipment', role: 'shipment' }),
      movement('3', '5'),
      movement('4', '-10', { reversal: '1' }),
    ],
    costs([
      ['1', '5'],
      ['3', '10'],
    ]),
  );
  const state = replay.items.get('item')!;
  assert.equal(display(state.pools.get('CAD')!.value, 2), '25.00');
  assert.deepEqual(itemCostFigures(state), {
    on_hand: '0',
    average_cost: null,
    inventory_value: null,
    unvalued_quantity: 'Unstated: incomplete cost coverage',
  });
});

test('missing or wrong compensation and mismatched receipt lineage refuse; negative coverage withholds money', () => {
  assert.throws(
    () =>
      replayInventoryValue(
        [movement('1', '1', { reversal: 'absent' })],
        new Map(),
      ),
    /Invalid valuation compensation/u,
  );
  const wrong = costs([['1', '5']]);
  wrong.set(JSON.stringify(['1', '1']), {
    ...wrong.get(JSON.stringify(['1', '1']))!,
    item: 'other',
  });
  assert.throws(
    () => replayInventoryValue([movement('1', '1')], wrong),
    /lineage mismatch/u,
  );
  const replay = replayInventoryValue(
    [
      movement('1', '-1', { sourceType: 'shipment', role: 'shipment' }),
      movement('2', '2'),
    ],
    costs([['2', '5']]),
  );
  assert.equal(itemCostFigures(replay.items.get('item')).inventory_value, null);
  assert.equal(itemCostFigures(replay.items.get('item')).average_cost, null);
});
