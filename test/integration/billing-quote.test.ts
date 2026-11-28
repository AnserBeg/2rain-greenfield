import type { PoolClient } from 'pg';
import {
  BOOKING_USAGE_BINDING,
  bookingServiceUse,
} from '../../packages/canonical-model/src/booking.js';
import { serviceUseCoverage } from '../../packages/domain/src/billing/service-use.js';
import '../../packages/postgres-provider/src/booking-owner-usage.js';
import { serviceUseFence } from '../../packages/postgres-provider/src/service-use-fence.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BillingCalendar,
  hourMs,
} from '../../packages/domain/src/billing/calendar.js';
import { compileRatePlan } from '../../packages/domain/src/billing/terms.js';
import { reviewArrearsCharges } from '../../packages/domain/src/billing/arrears.js';
import {
  quoteBillingCycle,
  quoteBillingService,
  replayBillingQuote,
} from '../../packages/domain/src/billing/quote.js';
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
        ? [
            ...Object.values(c.rates),
            typeof c.cap === 'string' ? c.cap : undefined,
            c.minimumMoney,
          ]
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
        publishedAt: '2020-01-01T00:00:00.000Z',
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
    termPins: first.terms,
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
  // The January enrollment minimum is already earned when February opens.
  const minimum = plan([
    { ...time, minimumDuration: { period: 'day', count: 29 } },
  ]);
  assert.equal(
    cents(minimum, evidence(minimum, 36, undefined, e.anchor)),
    59000,
  );
  const first = roll(e.anchor, 31);
  assert.equal(cents(p, { ...e, asOf: first }), 49000);
  assert.equal(cents(p, allocate(e, p, first)), 10000);
  for (let split = 1; split < 36; split++) {
    const boundary = roll(e.anchor, split);
    const allocated = allocate(e, p, boundary);
    const prior = allocated.allocations[0]!;
    assert.equal(Number(prior.allocatedCents) + cents(p, allocated), 59000);
    assert.equal(
      cents(p, {
        ...allocated,
        allocations: [
          {
            ...prior,
            reservedCents: prior.allocatedCents,
            allocatedCents: '0',
          },
        ],
      }),
      cents(p, allocated),
    );
  }
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
    termPins: quoteBillingService(p, e).terms,
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
  const jan31 = '2025-01-31T16:00:00.000Z';
  for (const partialTime of ['wholeStarted', 'prorateShortestTail'] as const)
    for (const daily of [1, 31])
      for (const weekly of [4, 90])
        for (const monthly of [15, 100]) {
          const p = plan([
            {
              ...time,
              partialTime,
              rates: { day: 'd', week: 'w', month: 'm' },
            },
          ]);
          for (const days of [0.5, 1, 4, 7, 7.25, 13.5, 15, 27.75, 28]) {
            // Enumerate all week/month counts, then buy just the remaining days.
            let best = Infinity;
            for (let m = 0; m <= 1; m++)
              for (let w = 0; w <= Math.ceil(days / 7); w++) {
                const tail = Math.max(0, days - 28 * m - 7 * w);
                best = Math.min(
                  best,
                  m * monthly +
                    w * weekly +
                    daily *
                      (partialTime === 'wholeStarted' ? Math.ceil(tail) : tail),
                );
              }
            assert.equal(
              cents(
                p,
                evidence(
                  p,
                  days,
                  { d: String(daily), w: String(weekly), m: String(monthly) },
                  jan31,
                ),
              ),
              100 * best,
            );
          }
        }
  const monthly = plan([
    { ...time, rates: { month: 'm' }, partialTime: 'prorateShortestTail' },
  ]);
  assert.equal(
    cents(monthly, evidence(monthly, 28, { m: '100' }, jan31)),
    10000,
  );
  assert.equal(
    cents(monthly, evidence(monthly, 14, { m: '100' }, jan31)),
    5000,
  );
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
      publishedAt: base.publishedAt,
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

test('one positive hour earns a three-day minimum limited to CAD 70', () => {
  const p = plan([
    {
      ...time,
      rates: { day: 'daily' },
      minimumDuration: { period: 'day', count: 3 },
      cap: 'cap',
    },
  ]);
  assert.equal(cents(p, evidence(p, 1 / 24, { daily: '30', cap: '70' })), 7000);
});

test('a different currency on the selected table alone refuses the quote', () => {
  const p = plan(),
    e = evidence(p, 1);
  e.tables[0]!.currency = 'USD';
  assert.throws(
    () => quoteBillingService(p, e),
    /Rate table plan version or currency mismatch/,
  );
});

test('a first publication can price an already open window', () => {
  const p = plan(),
    e = evidence(p, 8);
  e.tables[0]!.effectiveFrom = e.anchor;
  e.tables[0]!.publishedAt = roll(e.anchor, 2);
  assert.equal(cents(p, e), 13000);
  assert.throws(
    () => cents(p, { ...e, asOf: roll(e.anchor, 1) }),
    /Missing effective rate table/,
  );
  e.tables[0]!.effectiveFrom = roll(e.anchor, 1);
  assert.throws(() => cents(p, e), /Missing effective rate table/);
});

test('a same-day customer override applies before the first allocation', () => {
  const p = plan(),
    e = evidence(p, 8);
  e.tables.push({
    ...e.tables[0]!,
    version: 'same-day',
    effectiveFrom: e.anchor,
    publishedAt: roll(e.anchor, 0.25),
    selector: { kind: 'customer', customerId: e.customerId },
    values: { daily: '10', weekly: '50' },
  });
  assert.equal(cents(p, e), 6000);
});

test('publication after first allocation never reprices that window', () => {
  const p = plan(),
    e = evidence(p, 8);
  const boundary = roll(e.anchor, 4);
  e.tables[0]!.effectiveFrom = e.anchor;
  e.tables[0]!.publishedAt = roll(e.anchor, 2);
  const split = allocate(e, p, boundary);
  const successor = {
    ...e.tables[0]!,
    version: 'backdated',
    publishedAt: roll(e.anchor, 5),
    values: { daily: '10', weekly: '50' },
  };
  e.tables.push(successor);
  assert.equal(split.allocations[0]?.allocatedCents, '10000');
  assert.equal(cents(p, split), 3000);
  assert.equal(cents(p, e), 6000);
  const acrossWindows = quoteBillingService(p, {
    ...split,
    asOf: roll(start, 36),
  });
  assert.deepEqual(
    acrossWindows.terms.map((pin) => pin.version),
    ['t1', 'backdated'],
  );
  assert.throws(
    () => quoteBillingService(p, { ...split, termPins: [] }),
    /Prior allocation requires pinned billing terms/,
  );
  // A new list assignment can affect the first allocation only.
  e.tables.push({
    ...successor,
    publishedAt: e.tables[0]!.publishedAt,
    version: 'list',
    selector: { kind: 'priceList', listId: 'discount' },
  });
  e.assignments.push({
    listId: 'discount',
    revision: 'joined',
    priority: 1,
    effectiveFrom: e.anchor,
    publishedAt: successor.publishedAt,
  });
  assert.equal(cents(p, split), 3000);
  assert.equal(
    quoteBillingService(p, e).terms[0]!.assignment?.revision,
    'joined',
  );
});

test('a service-end fee uses the end occurrence across invoice schedules', () => {
  const close = {
    id: 'end',
    kind: 'fixed',
    stage: 'afterCapBeforeTax',
    taxClassification: 'untaxed',
    base: 'enrollment',
    amount: 'fee',
    occurrence: { kind: 'oneOff', at: 'serviceEnd' },
  } as const;
  for (const schedule of [
    { kind: 'onServiceEnd' },
    { kind: 'calendarMonth', boundaryMinutes: 0 },
  ] as const) {
    const p = plan([close]);
    p.schedule = schedule;
    const e = evidence(p, 45, { fee: '10' }, '2025-01-01T00:00:00.000Z');
    e.serviceEnd = e.asOf;
    e.tables.push({
      ...e.tables[0]!,
      version: 'feb',
      effectiveFrom: '2025-02-01T00:00:00.000Z',
      values: { fee: '20' },
    });
    assert.equal(cents(p, e), 2000);
  }
});

test('a 31-digit entitlement is accepted as either allocated or reserved cents', () => {
  const p = plan([{ ...time, rates: { day: 'daily' } }]);
  const e = evidence(p, 2, { daily: '100000000000000' });
  e.bands[0]!.quantity = '100000000000000';
  const split = allocate(e, p, roll(start, 1)),
    first = 10n ** 30n;
  assert.equal(
    quoteBillingService(p, e).lines[0]!.entitlementCents,
    String(2n * first),
  );
  assert.equal(split.allocations[0]!.allocatedCents, String(first));
  assert.equal(
    quoteBillingService(p, split).lines[0]!.differenceCents,
    String(first),
  );
  split.allocations[0]!.reservedCents = String(first);
  split.allocations[0]!.allocatedCents = '0';
  assert.equal(
    quoteBillingService(p, split).lines[0]!.differenceCents,
    String(first),
  );
});

test('arrears review stops at the next earned cycle and pins the exact late quote', () => {
  const p = plan();
  p.schedule = { kind: 'anniversary', months: 1 };
  const e = evidence(p, 70, undefined, '2025-01-31T16:00:00.000Z');
  // A backdated publication visible at review may price an unopened allocation.
  e.tables[0]!.publishedAt = '2025-03-05T00:00:00.000Z';
  e.serviceEnd = roll(e.anchor, 65);
  const review = reviewArrearsCharges(p, e);
  assert.equal(review.status, 'due');
  assert.deepEqual(review.cycle, {
    start: e.anchor,
    end: '2025-02-28T16:00:00.000Z',
  });
  assert.equal(review.quote.lines[0]!.differenceCents, '40000');
  assert.deepEqual(replayBillingQuote(review.quote), review.quote);
  assert.equal(reviewArrearsCharges(p, e).quoteDigest, review.quoteDigest);
  const changed = reviewArrearsCharges(p, { ...e, sourceRevision: '2' });
  assert.notEqual(changed.quoteDigest, review.quoteDigest);
  assert.deepEqual(
    reviewArrearsCharges(p, {
      ...e,
      asOf: roll(e.anchor, 27),
      tables: e.tables.map((t) => ({ ...t, publishedAt: e.anchor })),
    }),
    { status: 'notDue' },
  );
  assert.throws(
    () => reviewArrearsCharges(p, { ...e, periodStart: roll(e.anchor, 1) }),
    /cutover evidence/,
  );
  const next = reviewArrearsCharges(p, {
    ...e,
    periodStart: review.cycle.end,
    termPins: review.quote.terms,
    allocations: review.quote.lines.map((l) => ({
      componentId: l.componentId,
      occurrence: l.occurrence,
      allocatedCents: '0',
      reservedCents: l.entitlementCents,
    })),
  });
  assert.equal(next.status, 'due');
  assert.equal(next.cycle.end, '2025-03-31T15:00:00.000Z');
  assert.equal(next.quote.lines[0]!.differenceCents, '49000');
});

test('arrears end charges require an attested end and keep the original quote replayable', () => {
  const p = plan([
    {
      kind: 'fixed',
      id: 'finish',
      base: 'enrollment',
      stage: 'afterCapBeforeTax',
      taxClassification: 'untaxed',
      amount: 'fee',
      occurrence: { kind: 'oneOff', at: 'serviceEnd' },
    },
  ]);
  p.schedule = { kind: 'fixedDays', days: 7 };
  const e = evidence(p, 14, { fee: '31' });
  e.serviceEnd = roll(e.anchor, 10);
  const first = reviewArrearsCharges(p, e);
  assert.equal(first.status, 'due');
  assert.deepEqual(first.quote.lines, []);
  const last = reviewArrearsCharges(p, { ...e, periodStart: first.cycle.end });
  assert.equal(last.status, 'due');
  assert.equal(last.quote.lines[0]!.differenceCents, '3100');
  assert.throws(
    () => quoteBillingCycle(p, e, roll(e.anchor, 15)),
    /not delivered/,
  );
  assert.throws(
    () => quoteBillingService(p, { ...e, coverageThrough: first.cycle.end }),
    /coverage boundary/,
  );
  p.schedule = { kind: 'onServiceEnd' };
  assert.deepEqual(reviewArrearsCharges(p, { ...e, serviceEnd: null }), {
    status: 'notDue',
  });
});

test('three businesses review net charge lines through the same closed-cycle calculator', () => {
  const cycle = { kind: 'fixedDays', days: 10 } as const;
  const rental = plan([{ ...time, cap: 'cap' }], 'fourWeek');
  rental.schedule = cycle;
  const usagePlan = plan([
    {
      kind: 'meter',
      id: 'meter',
      streamId: 'copies',
      unit: 'copy',
      stage: 'afterCapBeforeTax',
      taxClassification: 'untaxed',
      overageRate: 'price',
      allowanceProration: 'none',
      allowanceBasis: { kind: 'perCycle', quantity: 'allowance' },
    },
  ]);
  usagePlan.schedule = cycle;
  const contract = plan([
    {
      kind: 'fixed',
      id: 'retainer',
      base: 'enrollment',
      amount: 'fee',
      stage: 'afterCapBeforeTax',
      taxClassification: 'untaxed',
      occurrence: {
        kind: 'recurring',
        cadence: cycle,
        fixedFeeDuringPause: 'continue',
        feeProration: 'activeCoverage',
      },
    },
  ]);
  contract.schedule = cycle;
  const hire = evidence(rental, 10, { daily: '30', weekly: '100', cap: '140' });
  const owner = {
    entityId: 'example:entity.service',
    recordId: 's1',
    companyId: 'company',
  };
  const snapshot = {
    schemaVersion: 'booking.ownerUsage/v1',
    ownerRef: owner,
    ownerScope: { kind: 'company', companyId: 'company' },
    asOf: hire.asOf,
    cursor: '9',
    highWater: '9',
    hasMore: false,
    changes: [],
    bookings: [
      {
        bookingId: 'hire',
        slotId: 'equipment',
        fulfilmentMode: 'tracked',
        unit: 'each',
      },
    ],
    evidence: [
      {
        id: 'leg1',
        revision: 1,
        bookingId: 'hire',
        kind: 'use',
        voided: false,
        effectiveStart: start,
        effectiveEnd: roll(start, 5),
        quantity: '1',
        unit: 'each',
      },
      {
        id: 'leg2',
        revision: 1,
        bookingId: 'hire',
        kind: 'use',
        voided: false,
        effectiveStart: roll(start, 5),
        effectiveEnd: null,
        quantity: '1',
        unit: 'each',
      },
      {
        id: 'pause',
        revision: 1,
        bookingId: 'hire',
        kind: 'pause',
        voided: false,
        effectiveStart: roll(start, 5),
        effectiveEnd: roll(start, 8),
        quantity: null,
        unit: null,
      },
    ],
  };
  const read = (input: unknown) =>
    serviceUseCoverage(
      { snapshot: bookingServiceUse(input), subjectId: 'equipment', owner },
      'each',
      hire.asOf,
    );
  Object.assign(hire, read(snapshot));
  const meter = evidence(usagePlan, 10, { price: '1.50', allowance: '10' });
  meter.basis = 'usageOnly';
  meter.bands = [];
  meter.periodMeter = {
    streamId: 'copies',
    unit: 'copy',
    opening: { at: start, reading: '9007199254740993.25' },
    closing: { at: meter.asOf, reading: '9007199254741008.75' },
  };
  const fee = evidence(contract, 20, { fee: '31' });
  fee.basis = 'agreed';
  fee.serviceEnd = roll(start, 5);
  for (const [p, e, expected] of [
    [rental, hire, '10000'],
    [usagePlan, meter, '825'],
    [contract, fee, '1550'],
  ] as const) {
    const review = reviewArrearsCharges(p, e);
    assert.equal(review.status, 'due');
    assert.deepEqual(
      review.quote.lines.map((l) => [
        l.servicePeriodStart,
        l.servicePeriodEnd,
        l.differenceCents,
      ]),
      [[start, review.cycle.end, expected]],
    );
    assert.deepEqual(replayBillingQuote(review.quote), review.quote);
  }
  assert.throws(
    () =>
      read({
        ...snapshot,
        ownerScope: { kind: 'company', companyId: 'other' },
      }),
    /owner or company/,
  );
  assert.throws(
    () => read({ ...snapshot, highWater: '10' }),
    /Incomplete service-use/,
  );
  assert.throws(
    () => read({ ...snapshot, asOf: start }),
    /Incomplete service-use/,
  );
  for (const ownerRef of [
    { ...owner, entityId: 'foreign' },
    { ...owner, recordId: 'other' },
  ])
    assert.throws(() => read({ ...snapshot, ownerRef }), /owner or company/);
  for (const invalid of [
    { slotId: 'elsewhere' },
    { fulfilmentMode: 'scheduled' },
    { unit: 'hour' },
  ])
    assert.throws(
      () =>
        read({
          ...snapshot,
          bookings: snapshot.bookings.map((b) => ({ ...b, ...invalid })),
        }),
      /identifiable/,
    );
  assert.throws(
    () =>
      read({
        ...snapshot,
        evidence: snapshot.evidence.map((r) => ({ ...r, voided: true })),
      }),
    /actual use/,
  );
  assert.throws(
    () =>
      read({
        ...snapshot,
        evidence: snapshot.evidence.filter((r) => r.kind === 'pause'),
      }),
    /actual use/,
  );
  assert.throws(
    () =>
      read({
        ...snapshot,
        evidence: snapshot.evidence.map((r) =>
          r.id === 'leg2' ? { ...r, quantity: '2' } : r,
        ),
      }),
    /unambiguous/,
  );
  // Booking's microsecond clock truncates to the Billing millisecond (ADR-0083).
  assert.equal(
    read({
      ...snapshot,
      evidence: snapshot.evidence.map((r) =>
        r.id === 'leg1'
          ? { ...r, effectiveStart: start.replace('.000Z', '.000999Z') }
          : r,
      ),
    }).bands[0]!.intervals.find((i) => i.id === 'leg1')!.start,
    start,
  );
  assert.throws(
    () =>
      read({
        ...snapshot,
        bookings: [...snapshot.bookings, ...snapshot.bookings],
      }),
    /identifiable/,
  );
  assert.throws(
    () =>
      reviewArrearsCharges(usagePlan, {
        ...meter,
        periodMeter: {
          ...meter.periodMeter!,
          closing: { at: meter.asOf, reading: '1' },
        },
      }),
    /decreased/,
  );
  assert.throws(
    () =>
      reviewArrearsCharges(usagePlan, {
        ...meter,
        periodMeter: {
          ...meter.periodMeter!,
          closing: { at: roll(start, 11), reading: '100' },
        },
      }),
    /boundary readings/,
  );
  assert.throws(
    () =>
      reviewArrearsCharges(usagePlan, {
        ...meter,
        periodMeter: { ...meter.periodMeter!, unit: 'liter' },
      }),
    /boundary readings/,
  );
});

test('the billing consumer fences all owners in one call and checks identities and cursors', async () => {
  const fenceBillingBookingOwners = serviceUseFence(BOOKING_USAGE_BINDING)!;
  const owners = [
    { queryId: 'one', entityId: 'visit', recordId: 'a', cursor: '2' },
    { queryId: 'two', entityId: 'account', recordId: 'b', cursor: '7' },
  ];
  const result = owners.toReversed().map(({ entityId, recordId, cursor }) => ({
    ownerRef: { entityId, recordId },
    cursor,
  }));
  let observed = result;
  let calls = 0;
  const client = {
    async query(sql: string, args: unknown[]) {
      calls++;
      assert.equal(
        sql,
        'SELECT platform.booking_owner_cursor_fence($1,$2,$3) AS result',
      );
      assert.deepEqual(args, [
        'release',
        4,
        JSON.stringify([
          { queryId: 'one', recordId: 'a' },
          { queryId: 'two', recordId: 'b' },
        ]),
      ]);
      return {
        rows: [
          {
            result: {
              schemaVersion: 'booking.ownerCursorFence/v1',
              owners: observed,
            },
          },
        ],
      };
    },
  } as unknown as PoolClient;
  await fenceBillingBookingOwners(client, 'release', 4, owners);
  await assert.rejects(
    fenceBillingBookingOwners(client, 'release', 4, [owners[0]!, owners[0]!]),
    /Duplicate service-use owner/,
  );
  assert.equal(calls, 1);
  for (const incorrect of [
    result.slice(1),
    [result[0]!, result[0]!],
    [{ ...result[0]!, cursor: '6' }, result[1]!],
    [
      { ...result[0]!, ownerRef: { entityId: 'foreign', recordId: 'b' } },
      result[1]!,
    ],
  ]) {
    observed = incorrect;
    await assert.rejects(
      fenceBillingBookingOwners(client, 'release', 4, owners),
      /Stale service-use cursor/,
    );
  }
});
