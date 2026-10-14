import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateLandedCharges } from '../../packages/postgres-provider/src/inventory-landed-cost.js';
import {
  deriveShipmentCosts,
  deriveInvoiceCosts,
  relievedCostFigures,
  productMargin,
  shippedProductRevenue,
} from '../../packages/postgres-provider/src/inventory-shipment-cost.js';
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

test('landed charges use actual billed receipt value, conserving exact fractional fees across items', () => {
  const rows = [movement('1', '10'), movement('2', '10', { item: 'other' })];
  const actual = costs([
    ['1', '5'],
    ['2', '15'],
  ]);
  actual.set(JSON.stringify(['2', '2']), {
    ...actual.get(JSON.stringify(['2', '2']))!,
    item: 'other',
  });
  const sources = new Map([
    ['1', { orderLine: 'a', item: 'item', unit: 'EA' }],
    ['2', { orderLine: 'b', item: 'other', unit: 'EA' }],
  ]);
  const lines = [
    { bill: 'bill', orderLine: 'a', item: 'item', unit: 'EA', quantity: '10' },
    { bill: 'bill', orderLine: 'b', item: 'other', unit: 'EA', quantity: '10' },
  ];
  const original = structuredClone({ rows, actual, sources, lines });
  const bill = {
    id: 'bill',
    date: '2026-09-30',
    currency: 'CAD',
    charges: '20',
    live: true,
  };
  const allocation = allocateLandedCharges(
    rows,
    actual,
    sources,
    [bill],
    lines,
  );
  assert.equal(allocation.invalidItems.size, 0);
  assert.deepEqual(
    [...allocation.grossCharges.values()],
    [
      { n: 5n, d: 1n },
      { n: 15n, d: 1n },
    ],
  );
  const replay = replayInventoryValue(rows, actual, allocation.grossCharges);
  assert.equal(
    itemCostFigures(replay.items.get('item')).inventory_value,
    'CAD 55.00',
  );
  assert.equal(
    itemCostFigures(replay.items.get('other')).average_cost,
    'CAD 16.5',
  );
  const penny = allocateLandedCharges(
    rows,
    actual,
    sources,
    [{ ...bill, charges: '0.01' }],
    lines,
  );
  assert.deepEqual(
    [...penny.grossCharges.values()],
    [
      { n: 1n, d: 400n },
      { n: 3n, d: 400n },
    ],
  );
  assert.deepEqual({ rows, actual, sources, lines }, original);
  const incomplete = new Map(actual);
  incomplete.set(JSON.stringify(['1', '1']), {
    item: 'item',
    unit: 'EA',
    known: false,
    unitCost: null,
    currency: null,
  });
  const withheld = allocateLandedCharges(
    rows,
    incomplete,
    sources,
    [bill],
    lines,
  );
  assert.equal(withheld.grossCharges.size, 0);
  assert.deepEqual([...withheld.invalidItems.keys()], ['item', 'other']);
});

test('net receipt corrections retain exactly the allocated fee and re-derive previously shipped relief', () => {
  const rows = [
    movement('1', '10'),
    movement('2', '-2', { sourceType: 'shipment', role: 'shipment' }),
    movement('3', '-5', { reversal: '1' }),
  ];
  const actual = costs([['1', '5']]);
  const allocation = allocateLandedCharges(
    rows,
    actual,
    new Map([['1', { orderLine: 'a', item: 'item', unit: 'EA' }]]),
    [
      {
        id: 'bill',
        date: '2026-09-30',
        currency: 'CAD',
        charges: '5',
        live: true,
      },
    ],
    [{ bill: 'bill', orderLine: 'a', item: 'item', unit: 'EA', quantity: '5' }],
  );
  assert.deepEqual(allocation.grossCharges.get('1'), { n: 10n, d: 1n });
  const replay = replayInventoryValue(rows, actual, allocation.grossCharges);
  assert.equal(
    itemCostFigures(replay.items.get('item')).inventory_value,
    'CAD 18.00',
  );
  assert.equal(
    display(replay.effects.get('2')!.pools.get('CAD')!.value, 2),
    '-12.00',
  );
  assert.equal(
    display(replay.effects.get('3')!.pools.get('CAD')!.value, 2),
    '-30.00',
  );
});

test('uncovered, absent, foreign or zero receipt bases withhold allocation; zero-charge bills consume only provenance', () => {
  const rows = [movement('1', '10'), movement('2', '10')];
  const sources = new Map(
    rows.map((m) => [
      m.sourceLine,
      { orderLine: 'a', item: 'item', unit: 'EA' },
    ]),
  );
  const bill = {
    id: 'bill',
    date: '2026-09-30',
    currency: 'CAD',
    charges: '5',
    live: true,
  };
  const line = {
    bill: 'bill',
    orderLine: 'a',
    item: 'item',
    unit: 'EA',
    quantity: '10',
  };
  for (const [actual, quantity, reason] of [
    [
      costs([
        ['1', null],
        ['2', '15'],
      ]),
      '10',
      'absent',
    ],
    [
      costs([
        ['1', '5', 'USD'],
        ['2', '15'],
      ]),
      '10',
      'currency',
    ],
    [
      costs([
        ['1', '0'],
        ['2', '15'],
      ]),
      '10',
      'zero',
    ],
    [
      costs([
        ['1', '5'],
        ['2', '15'],
      ]),
      '21',
      'uncovered',
    ],
  ] as const) {
    const result = allocateLandedCharges(
      rows,
      actual,
      sources,
      [bill],
      [{ ...line, quantity }],
    );
    assert.equal(result.grossCharges.size, 0);
    assert.match(result.invalidItems.get('item')!, new RegExp(reason, 'u'));
  }
  const actual = costs([
    ['1', '5'],
    ['2', '15'],
  ]);
  const result = allocateLandedCharges(
    rows,
    actual,
    sources,
    [
      { ...bill, id: 'first', date: '2026-09-29', charges: '0' },
      bill,
      { ...bill, id: 'draft', live: false },
    ],
    [
      { ...line, bill: 'first' },
      { ...line, quantity: '5' },
      { ...line, bill: 'draft' },
    ],
  );
  assert.equal(result.grossCharges.has('1'), false);
  assert.deepEqual(result.grossCharges.get('2'), { n: 5n, d: 1n });
  const remaining = itemCostFigures({
    ...replayInventoryValue(rows, actual).items.get('item')!,
    landedComplete: false,
    landedCoverage: 'Unstated: receipt cost is absent',
  });
  assert.equal(remaining.average_cost, null);
  assert.equal(remaining.inventory_value, null);
  assert.equal(remaining.unvalued_quantity, '0');
  assert.match(remaining.landed_cost_coverage!, /Unstated/u);
});

test('shipment relief and compensation use original cost; partial live invoices share net line cost and never overclaim it', () => {
  const rows = [
    movement('1', '10'),
    movement('2', '-4', {
      sourceType: 'shipment',
      role: 'shipment',
      sourceId: 'ship',
    }),
    movement('3', '10'),
    movement('4', '2', {
      sourceType: 'shipment',
      role: 'shipment',
      sourceId: 'return',
      reversal: '2',
    }),
  ];
  const replay = replayInventoryValue(
    rows,
    costs([
      ['1', '5'],
      ['3', '15'],
    ]),
  );
  const sources = new Map([
    [
      '2',
      {
        shipment: 'ship',
        orderLine: 'line',
        item: 'item',
        unit: 'EA',
        posted: true,
      },
    ],
    [
      '4',
      {
        shipment: 'return',
        orderLine: 'line',
        item: 'item',
        unit: 'EA',
        posted: true,
      },
    ],
  ]);
  const orders = new Map([
    [
      'line',
      {
        order: 'order',
        item: 'item',
        unit: 'EA',
        unitPrice: '25',
        discountPercent: '10',
      },
    ],
  ]);
  const derived = deriveShipmentCosts(rows, replay, sources, orders);
  assert.equal(
    relievedCostFigures(derived.shipmentLines.get('2')!).cost_of_goods,
    'CAD 20.00',
  );
  assert.equal(
    relievedCostFigures(derived.shipments.get('return')!).cost_of_goods,
    'CAD -10.00',
  );
  const order = derived.orders.get('order')!;
  assert.equal(relievedCostFigures(order).cost_of_goods, 'CAD 10.00');
  assert.equal(
    productMargin(
      order,
      'CAD',
      shippedProductRevenue('order', orders, derived.orderLines),
    ),
    'CAD 35.00',
  );
  const billed = deriveInvoiceCosts(
    [
      { id: 'void', date: '0', live: false },
      { id: 'b', date: '1', live: true },
      { id: 'a', date: '1', live: true },
      { id: 'c', date: '2', live: true },
    ],
    [
      { invoice: 'void', orderLine: 'line', quantity: '99', amount: '990' },
      ...['a', 'b', 'c'].map((invoice) => ({
        invoice,
        orderLine: 'line',
        quantity: '1',
        amount: '25',
      })),
    ],
    derived.orderLines,
  );
  for (const id of ['a', 'b']) {
    const invoice = billed.get(id)!;
    assert.equal(relievedCostFigures(invoice.cost).cost_of_goods, 'CAD 5.00');
    assert.equal(
      productMargin(invoice.cost, 'CAD', invoice.revenue),
      'CAD 20.00',
    );
  }
  assert.equal(billed.has('void'), false);
  assert.equal(relievedCostFigures(billed.get('c')!.cost).cost_of_goods, null);
  assert.match(billed.get('c')!.coverage!, /billed above net shipped/u);
  assert.throws(
    () => deriveShipmentCosts(rows, replay, new Map(), orders),
    /lineage/u,
  );
});

test('shipment costs expose unknown quantities and currencies, withholding margin rather than guessing or converting', () => {
  const rows = [
    movement('1', '2'),
    movement('2', '2'),
    movement('3', '2'),
    movement('4', '-3', {
      sourceType: 'shipment',
      role: 'shipment',
      sourceId: 'ship',
    }),
  ];
  const derived = deriveShipmentCosts(
    rows,
    replayInventoryValue(
      rows,
      costs([
        ['1', '10'],
        ['2', '20', 'USD'],
        ['3', null],
      ]),
    ),
    new Map([
      [
        '4',
        {
          shipment: 'ship',
          orderLine: 'line',
          item: 'item',
          unit: 'EA',
          posted: true,
        },
      ],
    ]),
    new Map([
      [
        'line',
        {
          order: 'order',
          item: 'item',
          unit: 'EA',
          unitPrice: '25',
          discountPercent: null,
        },
      ],
    ]),
  );
  const cost = derived.orders.get('order')!;
  assert.deepEqual(relievedCostFigures(cost), {
    cost_of_goods: 'CAD 10.00 · USD 20.00',
    cost_unvalued_quantity: '1',
    cost_coverage: 'Unvalued quantity',
  });
  assert.equal(productMargin(cost, 'CAD', { n: 75n, d: 1n }), null);
  const fullyKnown = { ...cost, unvalued: { n: 0n, d: 1n } };
  assert.equal(productMargin(fullyKnown, 'CAD', { n: 75n, d: 1n }), null);
  assert.equal(
    relievedCostFigures(fullyKnown).cost_coverage,
    'Multiple cost currencies',
  );
});

test('known zero shipment cost permits margin; an absent live invoice line and incomplete coverage state no cost', () => {
  const rows = [
    movement('1', '2'),
    movement('2', '-1', {
      sourceType: 'shipment',
      role: 'shipment',
      sourceId: 'ship',
    }),
  ];
  const derived = deriveShipmentCosts(
    rows,
    replayInventoryValue(rows, costs([['1', '0']])),
    new Map([
      [
        '2',
        {
          shipment: 'ship',
          orderLine: 'line',
          item: 'item',
          unit: 'EA',
          posted: true,
        },
      ],
    ]),
    new Map([
      [
        'line',
        {
          order: 'order',
          item: 'item',
          unit: 'EA',
          unitPrice: '25',
          discountPercent: null,
        },
      ],
    ]),
  );
  const cost = derived.orders.get('order')!;
  assert.equal(productMargin(cost, 'CAD', { n: 25n, d: 1n }), 'CAD 25.00');
  assert.equal(
    productMargin({ ...cost, complete: false }, 'CAD', { n: 25n, d: 1n }),
    null,
  );
  const absent = deriveInvoiceCosts(
    [{ id: 'invoice', date: '1', live: true }],
    [],
    derived.orderLines,
  ).get('invoice')!;
  assert.equal(relievedCostFigures(absent.cost).cost_of_goods, null);
  assert.match(absent.coverage!, /lines are absent/u);
});

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
    landed_cost_coverage: 'No billed charges',
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
    landed_cost_coverage: 'No billed charges',
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
      sourceLine: 'line:out',
    }),
    movement('6', '2', {
      sourceType: 'transfer',
      role: 'transfer',
      sourceId: 'transfer',
      sourceLine: 'line:in',
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
    landed_cost_coverage: 'No billed charges',
  });
  assert.equal(
    display(replay.effects.get('4')!.pools.get('CAD')!.value, 2),
    '10.00',
  );
  assert.throws(
    () => replayInventoryValue(rows.slice(0, -1), new Map()),
    /Incomplete valuation transfer/u,
  );
  for (const sourceLine of ['different:in', 'line:out', 'line'])
    assert.throws(
      () =>
        replayInventoryValue(
          rows.map((row) => (row.id === '6' ? { ...row, sourceLine } : row)),
          new Map(),
        ),
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
    landed_cost_coverage: 'No billed charges',
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
