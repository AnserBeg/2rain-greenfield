import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BillingCalendar,
  hourMs,
} from '../../packages/domain/src/billing/calendar.js';
import { compileRatePlan } from '../../packages/domain/src/billing/terms.js';
import { quoteBillingService } from '../../packages/domain/src/billing/quote.js';
import type { BillingQuoteEvidence } from '../../packages/canonical-model/src/billing-evidence.js';
import type {
  BillingPlan,
  TimeComponent,
} from '../../packages/canonical-model/src/billing.js';

const day = 24 * hourMs;
const start = '2025-01-28T16:00:00.000Z';
const stamp = (ms: number) => new Date(ms).toISOString();
const roll = (from: string, d: number) => stamp(Date.parse(from) + day * d);
const time: TimeComponent = {
  kind: 'time',
  id: 'time',
  base: 'serviceInterval',
  stage: 'beforeMinimum',
  taxClassification: 'untaxed',
  rates: { day: 'daily', week: 'weekly' },
  minimumScope: 'perEnrollment',
  partialTime: 'wholeStarted',
};
function plan(
  components: BillingPlan['components'] = [time],
  pricingWindow: BillingPlan['pricingWindow'] = 'month',
) {
  const slots = new Map<string, BillingPlan['slots'][number]>();
  for (const c of components) {
    const money =
      c.kind === 'time'
        ? [...Object.values(c.rates), c.cap, c.minimumMoney]
        : c.kind === 'fixed'
          ? [c.amount]
          : [c.overageRate];
    for (const id of money)
      if (id) slots.set(id, { id, kind: 'money', currency: 'CAD', scale: 6 });
    if (c.kind === 'meter') {
      const b = c.allowanceBasis;
      for (const id of b.kind === 'perBilledPeriod'
        ? Object.values(b.quantities)
        : [b.quantity])
        slots.set(id, { id, kind: 'quantity', unit: c.unit, scale: 6 });
    }
  }
  return compileRatePlan({
    schemaVersion: 'v6',
    id: 'service',
    version: 'v1',
    currency: 'CAD',
    serviceUnit: 'each',
    slots: [...slots.values()],
    components,
    pricingWindow,
    schedule: { kind: 'calendarMonth', boundaryMinutes: 0 },
  }).plan;
}
function evidence(
  p: BillingPlan,
  days: number,
  values: Record<string, string> = { daily: '30', weekly: '100' },
  anchor = start,
): BillingQuoteEvidence {
  const end = roll(anchor, days);
  return {
    schemaVersion: 'northstar.billing-quote-evidence/v1',
    release: 'release',
    sourceQueryId: 'source',
    sourceRevision: '1',
    cursor: '1',
    serviceId: 's1',
    companyId: 'company',
    tenantId: 'tenant',
    environmentId: 'env',
    customerId: 'c1',
    serviceUnit: 'each',
    currency: 'CAD',
    anchor,
    zone: 'America/Edmonton',
    asOf: end,
    periodStart: anchor,
    serviceEnd: null,
    basis: 'actual',
    bands: [
      {
        id: 'band',
        quantity: '1',
        intervals: [{ id: 'leg', revision: '1', start: anchor, end: null }],
      },
    ],
    usage: [],
    pauses: [],
    assignments: [],
    allocations: [],
    tables: [
      {
        schemaVersion: 'northstar.billing-rate-table/v1',
        version: 't1',
        planDigest: compileRatePlan(p).digest,
        currency: 'CAD',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
        selector: { kind: 'base' },
        values,
      },
    ],
  };
}
function cents(p: BillingPlan, e: BillingQuoteEvidence) {
  return Number(quoteBillingService(p, e).lines[0]!.differenceCents);
}
function allocate(e: BillingQuoteEvidence, p: BillingPlan, firstEnd: string) {
  const first = quoteBillingService(p, { ...e, asOf: firstEnd });
  return {
    ...e,
    periodStart: firstEnd,
    allocations: first.lines.map((l) => ({
      componentId: l.componentId,
      occurrence: l.occurrence,
      allocatedCents: l.entitlementCents,
      reservedCents: '0',
    })),
  };
}

test('month-end allocations are 100 + 30 or 110 + 20 with the enrollment minimum', () => {
  for (const [floor, first, second] of [
    [false, 10000, 3000],
    [true, 11000, 2000],
  ] as const) {
    const p = plan([
        { ...time, ...(floor ? { minimumMoney: 'minimum' } : {}) },
      ]),
      e = evidence(p, 8);
    if (floor) e.tables[0]!.values.minimum = '110';
    assert.equal(cents(p, e), 13000);
    const boundary = roll(start, 4);
    assert.equal(cents(p, { ...e, asOf: boundary }), first);
    assert.equal(cents(p, allocate(e, p, boundary)), second);
  }
});
test('service-anniversary windows price 36 days as CAD 490 + 100', () => {
  const p = plan(),
    e = evidence(p, 36, undefined, '2025-01-01T16:00:00.000Z');
  assert.equal(cents(p, e), 59000);
  const first = roll(e.anchor, 31);
  assert.equal(cents(p, { ...e, asOf: first }), 49000);
  assert.equal(cents(p, allocate(e, p, first)), 10000);
});
test('twenty active days cap at CAD 240 with CAD 100 then CAD 140 allocated', () => {
  const p = plan([{ ...time, cap: 'cap' }], 'fourWeek'),
    e = evidence(p, 20, { daily: '30', weekly: '100', cap: '240' });
  const cut = roll(start, 7),
    l = quoteBillingService(p, allocate(e, p, cut)).lines[0]!;
  assert.equal(l.differenceCents, '14000');
  assert.equal(l.allocatedCents, '10000');
  assert.equal(l.entitlementCents, '24000');
  assert.deepEqual((l.derivation[0] as { raw: string }).raw, '300');
  for (let split = 1; split < 20; split++)
    assert.equal(
      cents(p, { ...e, asOf: roll(start, split) }) +
        cents(p, allocate(e, p, roll(start, split))),
      24000,
    );
});
test('pause unions, quantity identity, and corrections preserve the original allocated cents', () => {
  const p = plan(),
    e = evidence(p, 10);
  e.pauses = [
    { id: 'pause', revision: '1', start: roll(start, 1), end: roll(start, 2) },
  ];
  assert.equal(cents(p, e), 16000);
  const corrected = {
    ...e,
    pauses: [
      ...e.pauses,
      {
        id: 'late',
        revision: '2',
        start: roll(start, 1.5),
        end: roll(start, 3),
      },
    ],
    allocations: [
      {
        componentId: 'time',
        occurrence: JSON.stringify(['time', 'band']),
        allocatedCents: '16000',
        reservedCents: '0',
      },
    ],
  };
  assert.equal(cents(p, corrected), -3000);
  assert.deepEqual(
    quoteBillingService(p, corrected),
    quoteBillingService(p, {
      ...corrected,
      pauses: [...corrected.pauses].reverse(),
    }),
  );
  const half = {
    ...e,
    bands: [
      ...e.bands,
      {
        id: 'returned',
        quantity: '0.5',
        intervals: [{ id: 'short', revision: '1', start, end: roll(start, 1) }],
      },
    ],
  };
  assert.deepEqual(
    quoteBillingService(p, half).lines.map((l) => l.entitlementCents),
    ['16000', '1500'],
  );
  assert.throws(
    () =>
      cents(p, {
        ...e,
        bands: [
          {
            ...e.bands[0]!,
            intervals: [
              ...e.bands[0]!.intervals,
              { id: 'ambiguous', revision: '1', start, end: null },
            ],
          },
        ],
      }),
    /overlapping/,
  );
});
test('Edmonton civil days cost CAD 30 across both DST changes while hourly offers count 23 or 25', () => {
  const daily = plan([{ ...time, rates: { day: 'd' } }]),
    hourly = plan([{ ...time, rates: { hour: 'h' } }]);
  for (const [a, b, hours] of [
    ['2025-03-08T16:00:00.000Z', '2025-03-09T15:00:00.000Z', 23],
    ['2025-11-01T15:00:00.000Z', '2025-11-02T16:00:00.000Z', 25],
  ] as const) {
    for (const [p, rates, expected] of [
      [daily, { d: '30' }, 3000],
      [hourly, { h: '1' }, 100 * hours],
    ] as const) {
      assert.equal(
        cents(p, { ...evidence(p, 1, rates, a), asOf: b }),
        expected,
      );
    }
  }
});
test('every missing Edmonton anchor minute resolves to the gap end, every repeated minute to its first offset', () => {
  for (let minute = 0; minute < 60; minute++) {
    const spring = Date.UTC(2025, 2, 8, 9, minute, 17, 123),
      fall = Date.UTC(2025, 10, 1, 7, minute, 17, 123);
    const s = new BillingCalendar(spring, 'America/Edmonton'),
      f = new BillingCalendar(fall, 'America/Edmonton');
    assert.equal(s.day(1), Date.UTC(2025, 2, 9, 9));
    assert.equal(s.day(2), Date.UTC(2025, 2, 10, 8, minute, 17, 123));
    assert.equal(f.day(1), Date.UTC(2025, 10, 2, 7, minute, 17, 123));
    assert.equal(f.day(2), Date.UTC(2025, 10, 3, 8, minute, 17, 123));
  }
});
test('small best covers agree with exhaustive mixed-period enumeration, including longer tails and cent rounding', () => {
  for (const daily of [1, 5, 31])
    for (const weekly of [4, 21, 90])
      for (let days = 1; days <= 15; days++) {
        let best = Infinity;
        for (let d = 0; d <= days; d++)
          for (let w = 0; w <= Math.ceil(days / 7); w++)
            if (d + 7 * w >= days)
              best = Math.min(best, d * daily + w * weekly);
        const p = plan(),
          e = evidence(p, days, {
            daily: String(daily),
            weekly: String(weekly),
          });
        assert.equal(cents(p, e), 100 * best);
      }
  const p = plan([
    { ...time, rates: { day: 'd' }, partialTime: 'prorateShortestTail' },
  ]);
  const e = evidence(p, 1, { d: '0.01' });
  e.asOf = roll(start, 0.5);
  assert.equal(cents(p, e), 1);
  e.asOf = stamp(Date.parse(e.asOf) - 1);
  assert.equal(cents(p, e), 0);
});
test('the fee and per-cycle allowance prorate independently to CAD 15.50 and CAD 6', () => {
  for (const proration of ['none', 'activeCoverage'] as const) {
    const cadence = { kind: 'fixedDays', days: 10 } as const;
    const p = plan([
      {
        id: 'fee',
        kind: 'fixed',
        base: 'enrollment',
        stage: 'afterCapBeforeTax',
        taxClassification: 'untaxed',
        amount: 'fee',
        occurrence: {
          kind: 'recurring',
          cadence,
          fixedFeeDuringPause: 'suspend',
          feeProration: proration,
        },
      },
      {
        id: 'usage',
        kind: 'meter',
        streamId: 'kwh',
        unit: 'kWh',
        stage: 'afterCapBeforeTax',
        taxClassification: 'untaxed',
        overageRate: 'rate',
        allowanceProration: proration,
        allowanceBasis: { kind: 'perCycle', quantity: 'included' },
      },
    ]);
    p.schedule = cadence;
    const e = evidence(p, 10, { fee: '31', rate: '2', included: '10' });
    e.bands = [];
    e.basis = 'usageOnly';
    e.pauses = [
      { id: 'paused', revision: '1', start: roll(start, 5), end: null },
    ];
    e.usage = [
      {
        id: 'm1',
        revision: '1',
        at: start,
        quantity: '8',
        streamId: 'kwh',
        unit: 'kWh',
      },
      {
        id: 'm2',
        revision: '1',
        at: roll(start, 5),
        quantity: '80',
        streamId: 'kwh',
        unit: 'kWh',
      },
    ];
    assert.deepEqual(
      quoteBillingService(p, e).lines.map((l) => l.entitlementCents),
      proration === 'none' ? ['3100', '0'] : ['1550', '600'],
    );
  }
});

test('Jan 31 anniversaries clamp independently and minimum scope survives intermediate invoices', () => {
  const anchor = '2025-01-31T16:00:00.000Z',
    calendar = new BillingCalendar(Date.parse(anchor), 'America/Edmonton');
  assert.equal(
    stamp(calendar.day(calendar.monthDay(1))),
    '2025-02-28T16:00:00.000Z',
  );
  assert.equal(
    stamp(calendar.day(calendar.monthDay(2))),
    '2025-03-31T15:00:00.000Z',
  );
  for (const scope of ['perEnrollment', 'perPricingWindow'] as const) {
    const p = plan([{ ...time, minimumScope: scope, minimumMoney: 'min' }]);
    const e = evidence(
      p,
      30,
      { daily: '30', weekly: '100', min: '110' },
      anchor,
    );
    e.pauses = [
      {
        id: 'pause',
        revision: '1',
        start: roll(anchor, 1),
        end: roll(anchor, 28),
      },
    ];
    assert.equal(cents(p, e), scope === 'perEnrollment' ? 11000 : 22000);
    e.pauses[0]!.start = anchor;
    e.pauses[0]!.end = null;
    assert.equal(cents(p, e), 0);
  }
});
test('billed-period allowances follow the winning blocks at close, and a time minimum buys no usage', () => {
  for (const kind of ['perBilledPeriod', 'perPricingWindow'] as const) {
    const p = plan([
      { ...time, minimumMoney: 'min' },
      {
        id: 'meter',
        kind: 'meter',
        streamId: 'meter',
        unit: 'u',
        stage: 'afterCapBeforeTax',
        taxClassification: 'untaxed',
        overageRate: 'over',
        allowanceProration: 'none',
        allowanceBasis:
          kind === 'perBilledPeriod'
            ? {
                kind,
                timeComponent: 'time',
                quantities: { day: 'dailyIncluded', week: 'weeklyIncluded' },
              }
            : { kind, quantity: 'included' },
      },
    ]);
    const amounts: Record<string, string> = {
      daily: '30',
      weekly: '100',
      min: '200',
      over: '2',
    };
    if (kind === 'perBilledPeriod')
      Object.assign(amounts, { dailyIncluded: '1', weeklyIncluded: '4' });
    else amounts.included = '3';
    const e = evidence(p, 8, amounts);
    e.serviceEnd = e.asOf;
    e.usage = [
      {
        id: 'u',
        revision: '1',
        at: start,
        streamId: 'meter',
        unit: 'u',
        quantity: '8',
      },
    ];
    const result = quoteBillingService(p, e).lines;
    assert.deepEqual(
      result.map((l) => l.entitlementCents),
      ['20000', kind === 'perBilledPeriod' ? '600' : '1000'],
    );
    assert.equal(
      quoteBillingService(p, { ...e, asOf: roll(start, 7) }).lines.length,
      1,
    );
  }
});
test('mixed civil and elapsed blocks price their actual positions across a DST transition', () => {
  const p = plan([
    {
      ...time,
      rates: { hour: 'h', day: 'd' },
      partialTime: 'prorateShortestTail',
    },
  ]);
  const e = evidence(p, 2, { h: '1', d: '20' }, '2025-11-01T15:00:00.000Z');
  e.asOf = '2025-11-02T17:30:00.000Z';
  const line = quoteBillingService(p, e).lines[0]!;
  assert.equal(line.entitlementCents, '2150');
  const blocks = (
    line.derivation[0] as { blocks: { period: string }[] }
  ).blocks.map((b) => b.period);
  assert.deepEqual(blocks, ['day', 'hour', 'hour']);
});
test('pinned complete tables use customer then assigned list then base and refuse ties or mixed currency', async () => {
  const p = plan(),
    e = evidence(p, 1),
    base = e.tables[0]!;
  e.assignments = [
    {
      listId: 'list',
      revision: '1',
      priority: 3,
      effectiveFrom: base.effectiveFrom,
    },
  ];
  e.tables.push({
    ...base,
    version: 'list',
    selector: { kind: 'priceList', listId: 'list' },
    values: { daily: '20', weekly: '80' },
  });
  assert.equal(cents(p, e), 2000);
  e.tables.push({
    ...base,
    version: 'customer',
    selector: { kind: 'customer', customerId: 'c1' },
    values: { daily: '10', weekly: '40' },
  });
  const q = quoteBillingService(p, e);
  assert.equal(q.lines[0]!.entitlementCents, '1000');
  const { replayBillingQuote } =
    await import('../../packages/domain/src/billing/quote.js');
  assert.deepEqual(replayBillingQuote(q), q);
  e.tables[2]!.values.daily = '9';
  assert.equal(cents(p, e), 900);
  assert.equal(replayBillingQuote(q).lines[0]!.entitlementCents, '1000');
  const changed = structuredClone(q);
  changed.inputs.evidence.tables[0]!.values.daily = '7';
  assert.throws(() => replayBillingQuote(changed), /digest mismatch/);
  e.tables.push({ ...e.tables[2]!, version: 'competing' });
  assert.throws(() => cents(p, e), /Ambiguous/);
  assert.throws(
    () =>
      compileRatePlan({
        ...p,
        slots: p.slots.map((s) => ({ ...s, currency: 'USD' })),
      }),
    /Mixed billing currencies/,
  );
  assert.throws(() => cents(p, { ...e, currency: 'EUR' }), /currency/);
  assert.throws(() =>
    compileRatePlan({ ...p, components: [{ kind: 'percentage' }] }),
  );
  assert.throws(() =>
    compileRatePlan({
      ...p,
      components: [{ ...p.components[0], stage: 'afterTax' }],
    }),
  );
  assert.throws(() => cents(p, { ...e, asOf: roll(start, 4000) }), /horizon/);
});
