import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BILLING_ARREARS_READER,
  BILLING_CYCLE_CALCULATION,
  BILLING_RULES_CALCULATION,
  BILLING_RULES_READER,
  BillingPlanSchema,
  billingEvidenceQuery,
  billingReleaseMismatch,
  hasBillingRules,
} from '../../packages/canonical-model/src/billing.js';
import type { BillingQuoteEvidence } from '../../packages/canonical-model/src/billing-evidence.js';
import {
  bookingServiceUse,
  truncateBookingInstant,
} from '../../packages/canonical-model/src/booking.js';
import { SERVICE_USE_PROTOCOL } from '../../packages/canonical-model/src/service-evidence.js';
import {
  dueArrearsCycle,
  reviewArrearsCharges,
} from '../../packages/domain/src/billing/arrears.js';
import {
  quoteBillingService,
  replayBillingQuote,
} from '../../packages/domain/src/billing/quote.js';
import { serviceUseCoverage } from '../../packages/domain/src/billing/service-use.js';
import { compileRatePlan } from '../../packages/domain/src/billing/terms.js';
import { agreedQuantity } from '../../packages/postgres-provider/src/billing-quote.js';

// BILLING-1 slice 3a-i: rate rules (B1), per-quantity fees (B7), early
// return (B9) and the checks the slice 2 review found without a test.
const day = 86_400_000;
const start = '2025-01-28T16:00:00.000Z';
const roll = (days: number) =>
  new Date(Date.parse(start) + day * days).toISOString();

type Authored = Record<string, unknown>;
function timePlan(extra: Authored, rates: Authored = { day: 'd', week: 'w' }) {
  return {
    schemaVersion: 'v6',
    id: 'hire',
    version: '1',
    currency: 'CAD',
    serviceUnit: 'each',
    pricingWindow: 'month',
    schedule: { kind: 'onServiceEnd' },
    slots: Object.values(rates).map((id) => ({
      id,
      kind: 'money',
      currency: 'CAD',
      scale: 2,
    })),
    components: [
      {
        kind: 'time',
        id: 'time',
        base: 'serviceInterval',
        stage: 'beforeMinimum',
        taxClassification: 'untaxed',
        rates,
        ...extra,
      },
    ],
  };
}
function evidence(
  planInput: unknown,
  days: number,
  values: Record<string, string>,
  quantity = '1',
): BillingQuoteEvidence {
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
    anchor: start,
    zone: 'America/Edmonton',
    asOf: roll(days),
    periodStart: start,
    serviceEnd: roll(days),
    basis: 'agreed',
    bands: [
      {
        id: 'band',
        quantity,
        intervals: [{ id: 'leg', revision: '1', start, end: roll(days) }],
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
        planDigest: compileRatePlan(planInput).digest,
        currency: 'CAD',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
        selector: { kind: 'base' },
        values,
      },
    ],
  };
}
const daily20weekly100 = { d: '20', w: '100' };
function cents(planInput: unknown, days: number, values = daily20weekly100) {
  const quote = quoteBillingService(
    planInput,
    evidence(planInput, days, values),
  );
  assert.equal(quote.algorithm, BILLING_RULES_CALCULATION);
  assert.deepEqual(replayBillingQuote(quote).resultDigest, quote.resultDigest);
  return quote.lines.map((l) => Number(l.differenceCents));
}

test('B1: each combination rule prices 3, 10 and 13 days at 20 a day or 100 a week', () => {
  for (const [name, extra, expected] of [
    ['prorate (the tier reached)', { rule: 'prorate' }, [6000, 14286, 18571]],
    [
      'ladder without a cap',
      { rule: 'ladder', capAtNextTier: false },
      [6000, 16000, 22000],
    ],
    [
      'ladder capped at the next tier',
      { rule: 'ladder', capAtNextTier: true },
      [6000, 16000, 20000],
    ],
    ['bestPrice, declared', { rule: 'bestPrice' }, [6000, 16000, 20000]],
  ] as const) {
    const plan = timePlan({ combination: extra });
    assert.deepEqual(
      [3, 10, 13].map((days) => cents(plan, days)[0]),
      expected,
      name,
    );
  }
});

test('B1: a ladder fills whole blocks from the longest rate down', () => {
  // 25 days at 10/100/300 in a 31-day window: three weeks and four days.
  const rates = { day: 'd', week: 'w', month: 'm' };
  const values = { d: '20', w: '100', m: '300' };
  const ladder = timePlan(
    { combination: { rule: 'ladder', capAtNextTier: false } },
    rates,
  );
  assert.deepEqual(cents(ladder, 25, values), [38000]);
  const capped = timePlan(
    { combination: { rule: 'ladder', capAtNextTier: true } },
    rates,
  );
  assert.deepEqual(cents(capped, 25, values), [30000]);
  const quote = quoteBillingService(ladder, evidence(ladder, 25, values));
  const blocks = (
    quote.lines[0]!.derivation[0] as { blocks: { period: string }[] }
  ).blocks.map((b) => b.period);
  assert.deepEqual(blocks, [
    'week',
    'week',
    'week',
    'day',
    'day',
    'day',
    'day',
  ]);
});

test('B1: a per-rate partial rule prorates a final partial block of that rate', () => {
  // Ten and a half days: whole-started days charge 11, a prorated day 10.5.
  const half = (plan: unknown) =>
    Number(
      quoteBillingService(plan, {
        ...evidence(plan, 10, daily20weekly100),
        asOf: new Date(Date.parse(roll(10)) + day / 2).toISOString(),
        serviceEnd: new Date(Date.parse(roll(10)) + day / 2).toISOString(),
        bands: [
          {
            id: 'band',
            quantity: '1',
            intervals: [
              {
                id: 'leg',
                revision: '1',
                start,
                end: new Date(Date.parse(roll(10)) + day / 2).toISOString(),
              },
            ],
          },
        ],
      }).lines[0]!.differenceCents,
    );
  const ladder = { rule: 'ladder', capAtNextTier: false };
  assert.equal(half(timePlan({ combination: ladder })), 10000 + 4 * 2000);
  assert.equal(
    half(timePlan({ combination: ladder, partial: { day: 'prorate' } })),
    10000 + 3.5 * 2000,
  );
  // Under prorate the reached rate is pro rata unless declared whole.
  assert.equal(
    half(
      timePlan({
        combination: { rule: 'prorate' },
        partial: { week: 'whole' },
      }),
    ),
    20000,
  );
});

test('B1: a cap can be a whole multiple of an offered rate', () => {
  const plan = timePlan({ cap: { rate: 'week', times: 2 } });
  // 20 days cost three weeks (300) before the cap of 2 x 100.
  assert.deepEqual(cents(plan, 20), [20000]);
  assert.deepEqual(cents(plan, 10), [16000]);
  assert.equal(
    BillingPlanSchema.safeParse(timePlan({ cap: { rate: 'month', times: 2 } }))
      .success,
    false,
    'the cap names a rate the component offers',
  );
});

test('B1: partial rules name offered rates and replace the legacy shortest-tail switch', () => {
  for (const [reason, extra] of [
    ['an unoffered rate', { partial: { month: 'prorate' } }],
    [
      'the legacy switch beside a combination',
      { partialTime: 'prorateShortestTail', combination: { rule: 'prorate' } },
    ],
    [
      'the legacy switch beside a partial rule',
      { partialTime: 'prorateShortestTail', partial: { day: 'whole' } },
    ],
  ] as const)
    assert.equal(
      BillingPlanSchema.safeParse(timePlan(extra)).success,
      false,
      reason,
    );
});

test('rule keys, and only rule keys, select calculation v4 and the rules reader', () => {
  const legacy = timePlan({});
  assert.equal(hasBillingRules(legacy), false);
  assert.equal(
    quoteBillingService(legacy, evidence(legacy, 3, daily20weekly100))
      .algorithm,
    'northstar.billing-calculation/v2',
  );
  for (const extra of [
    { combination: { rule: 'bestPrice' } },
    { partial: { day: 'whole' } },
    { cap: { rate: 'week', times: 1 } },
  ])
    assert.equal(hasBillingRules(timePlan(extra)), true, JSON.stringify(extra));
  // A replayed quote cannot move a plan between calculations.
  const quote = quoteBillingService(
    legacy,
    evidence(legacy, 3, daily20weekly100),
  );
  assert.throws(
    () =>
      replayBillingQuote({ ...quote, algorithm: BILLING_RULES_CALCULATION }),
    /calculation v4/,
  );
  const ruled = timePlan({ combination: { rule: 'bestPrice' } });
  const ruledQuote = quoteBillingService(
    ruled,
    evidence(ruled, 3, daily20weekly100),
  );
  assert.throws(
    () =>
      replayBillingQuote({
        ...ruledQuote,
        algorithm: 'northstar.billing-calculation/v2',
      }),
    /calculation v4/,
  );
});

function seatPlan(perQuantity: boolean) {
  return {
    schemaVersion: 'v6',
    id: 'seats',
    version: '1',
    currency: 'CAD',
    serviceUnit: 'each',
    schedule: { kind: 'anniversary', months: 1 },
    slots: [{ id: 'fee', kind: 'money', currency: 'CAD', scale: 2 }],
    components: [
      {
        kind: 'fixed',
        id: 'fee',
        base: 'enrollment',
        stage: 'afterCapBeforeTax',
        taxClassification: 'untaxed',
        amount: 'fee',
        ...(perQuantity ? { perQuantity: true } : {}),
        occurrence: {
          kind: 'recurring',
          cadence: { kind: 'anniversary', months: 1 },
        },
      },
    ],
  };
}

test('B7: a per-quantity fee charges 5 seats x the monthly fee', () => {
  const seats = seatPlan(true);
  const month = evidence(seats, 31, { fee: '15' }, '5');
  const quote = quoteBillingService(seats, month);
  assert.equal(quote.algorithm, BILLING_RULES_CALCULATION);
  assert.deepEqual(
    quote.lines.map((l) => l.differenceCents),
    ['7500'],
  );
  assert.deepEqual(
    (quote.lines[0]!.derivation[0] as { quantity: string }).quantity,
    '5',
  );
  // Without perQuantity the fee ignores the quantity, as before.
  const flat = seatPlan(false);
  assert.deepEqual(
    quoteBillingService(flat, evidence(flat, 31, { fee: '15' }, '5')).lines.map(
      (l) => l.differenceCents,
    ),
    ['1500'],
  );
  // Several quantity bands have no one quantity to multiply by.
  assert.throws(
    () =>
      quoteBillingService(seats, {
        ...month,
        bands: [
          month.bands[0]!,
          { ...month.bands[0]!, id: 'other', intervals: [] },
        ],
      }),
    /one commercial quantity/,
  );
});

// ---- B9: early return, over the service-use protocol ----
const owner = { entityId: 'hire', recordId: 'h1', companyId: 'company' };
const subject = 'slot.equipment';
function useSnapshot(returnedDay: number | null, asOfDay = 20) {
  return bookingServiceUse({
    schemaVersion: 'booking.ownerUsage/v1',
    ownerRef: { entityId: owner.entityId, recordId: owner.recordId },
    ownerScope: { kind: 'company', companyId: owner.companyId },
    asOf: roll(asOfDay),
    cursor: '4',
    highWater: '4',
    hasMore: false,
    changes: [],
    bookings: [
      {
        bookingId: 'b1',
        slotId: subject,
        fulfilmentMode: 'tracked',
        unit: 'each',
      },
    ],
    evidence: [
      {
        id: 'use',
        bookingId: 'b1',
        revision: 1,
        kind: 'use',
        voided: false,
        effectiveStart: start,
        effectiveEnd: returnedDay === null ? null : roll(returnedDay),
        quantity: '1',
        unit: 'each',
      },
    ],
  });
}
const dailyHire = compileRatePlan(timePlan({}, { day: 'd' })).plan;
function hireEvidence(asOfDay: number, agreedDays = 5) {
  return {
    ...evidence(dailyHire, agreedDays, { d: '30' }),
    asOf: roll(asOfDay),
    bands: [],
  } as BillingQuoteEvidence;
}
type EarlyReturn = NonNullable<
  ReturnType<typeof billingEvidenceQuery>
>['earlyReturn'];
function earlyReview(earlyReturn: EarlyReturn, returnedDay = 3, asOfDay = 20) {
  const result = reviewArrearsCharges(dailyHire, hireEvidence(asOfDay), {
    snapshot: useSnapshot(returnedDay, asOfDay),
    subjectId: subject,
    owner,
    ...(earlyReturn ? { earlyReturn } : {}),
  });
  if (result.status !== 'due') return { status: result.status };
  return {
    status: result.status,
    end: result.cycle.end,
    cents: result.quote.lines.map((l) => l.differenceCents).join(),
  };
}

test('B9: early return bills to the agreed end or the actual end, and absent keeps v3', () => {
  // Agreed five days at CAD 30, returned on day three (measured on main:
  // the cycle closes at the agreed end and the three days held are rated).
  assert.deepEqual(earlyReview(undefined), {
    status: 'due',
    end: roll(5),
    cents: '9000',
  });
  assert.deepEqual(earlyReview({ bill: 'actualEnd' }), {
    status: 'due',
    end: roll(3),
    cents: '9000',
  });
  assert.deepEqual(earlyReview({ bill: 'agreedEnd' }), {
    status: 'due',
    end: roll(5),
    cents: '15000',
  });
  // Agreed time is billed only once it has elapsed (arrears).
  assert.deepEqual(earlyReview({ bill: 'agreedEnd' }, 3, 4), {
    status: 'notDue',
  });
  // Possession past the agreed end bills through the return under both.
  for (const bill of ['agreedEnd', 'actualEnd'] as const)
    assert.deepEqual(earlyReview({ bill }, 9), {
      status: 'due',
      end: roll(9),
      cents: '27000',
    });
});

test('B9: a minimum term in periods holds the service open until it elapses', () => {
  const week = { period: 'week', count: 1 } as const;
  assert.deepEqual(earlyReview({ bill: 'actualEnd', minimumTerm: week }), {
    status: 'due',
    end: roll(7),
    cents: '21000',
  });
  assert.deepEqual(
    earlyReview({ bill: 'actualEnd', minimumTerm: week }, 3, 6),
    { status: 'notDue' },
  );
  // A term already served changes nothing.
  assert.deepEqual(
    earlyReview({
      bill: 'actualEnd',
      minimumTerm: { period: 'day', count: 2 },
    }),
    { status: 'due', end: roll(3), cents: '9000' },
  );
  // Months count from the original day on the civil calendar.
  assert.deepEqual(
    earlyReview(
      { bill: 'actualEnd', minimumTerm: { period: 'month', count: 1 } },
      3,
      40,
    ),
    { status: 'due', end: '2025-02-28T16:00:00.000Z', cents: '93000' },
  );
});

test('the evidence source declares the service-use protocol and the persisted reader-45 form replays as it', () => {
  const legacy = { kind: 'bookingActuals' as const, queryId: 'q', slotId: 's' };
  assert.deepEqual(billingEvidenceQuery(legacy), {
    kind: 'evidenceQuery',
    queryId: 'q',
    protocol: SERVICE_USE_PROTOCOL,
    subjectId: 's',
  });
  assert.equal(billingEvidenceQuery({ kind: 'agreedInterval' }), undefined);
  const plan = (arrearsSource: unknown) => ({
    ...timePlan({}),
    bindings: {
      quoteQueryId: 'q',
      evidenceQueryId: 'e',
      agreedInterval: {
        customerFieldId: 'c',
        currencyFieldId: 'k',
        startFieldId: 's',
        endFieldId: 'n',
        zone: 'UTC',
      },
      arrearsSource,
      publishOperationId: 'p',
      overrideOperationId: 'o',
      assignmentOperationId: 'a',
      termsQueryId: 't',
      termsFieldId: 'f',
    },
  });
  // The persisted form keeps its reader and calculation; the protocol form
  // takes the rules reader.
  assert.equal(hasBillingRules(plan(legacy)), false);
  assert.equal(
    hasBillingRules(
      plan({
        kind: 'evidenceQuery',
        queryId: 'q',
        protocol: SERVICE_USE_PROTOCOL,
        subjectId: 's',
      }),
    ),
    true,
  );
  assert.equal(
    BillingPlanSchema.safeParse(
      plan({
        kind: 'evidenceQuery',
        queryId: 'q',
        protocol: 'other',
        subjectId: 's',
      }),
    ).success,
    false,
    'an undeclared protocol does not parse',
  );
});

test('the release loader refuses a plan below its billing reader (BILLING_PLAN_MISMATCH)', () => {
  const arrears = {
    ...timePlan({}),
    bindings: { agreedInterval: {}, arrearsSource: { kind: 'agreedInterval' } },
  };
  const payload = (plans: unknown, calculation?: string) => ({
    billingPlans: plans,
    ...(calculation ? { billingCalculationVersion: calculation } : {}),
  });
  assert.equal(
    billingReleaseMismatch(
      [arrears],
      payload([arrears], BILLING_CYCLE_CALCULATION),
      BILLING_ARREARS_READER,
    ),
    false,
  );
  assert.equal(
    billingReleaseMismatch(
      [arrears],
      payload([arrears], BILLING_CYCLE_CALCULATION),
      BILLING_ARREARS_READER - 1,
    ),
    true,
    'the arrears floor',
  );
  const ruled = {
    ...arrears,
    components: [
      { ...arrears.components[0], combination: { rule: 'prorate' } },
    ],
  };
  assert.equal(
    billingReleaseMismatch(
      [ruled],
      payload([ruled], BILLING_RULES_CALCULATION),
      BILLING_RULES_READER - 1,
    ),
    true,
    'the rules floor',
  );
  assert.equal(
    billingReleaseMismatch(
      [ruled],
      payload([ruled], BILLING_CYCLE_CALCULATION),
      BILLING_RULES_READER,
    ),
    true,
    'the rules calculation',
  );
});

// ---- The slice 2 checks without a test (BILLING-1.md finding 3) ----
function meterReview(
  change: Partial<BillingQuoteEvidence> | ((e: BillingQuoteEvidence) => void),
  planChange?: Authored,
) {
  const meter = compileRatePlan({
    schemaVersion: 'v6',
    id: 'usage',
    version: '1',
    currency: 'CAD',
    serviceUnit: 'each',
    schedule: { kind: 'anniversary', months: 1 },
    slots: [
      { id: 'rate', kind: 'money', currency: 'CAD', scale: 2 },
      { id: 'included', kind: 'quantity', unit: 'copy', scale: 2 },
    ],
    components: [
      {
        id: 'overage',
        kind: 'meter',
        stage: 'afterCapBeforeTax',
        taxClassification: 'untaxed',
        streamId: 'copies',
        unit: 'copy',
        overageRate: 'rate',
        allowanceBasis: { kind: 'perCycle', quantity: 'included' },
        ...planChange,
      },
    ],
  }).plan;
  const e = {
    ...evidence(meter, 31, { rate: '2', included: '10' }),
    basis: 'usageOnly',
    bands: [],
    serviceEnd: null,
    asOf: roll(40),
    periodMeter: {
      streamId: 'copies',
      unit: 'copy',
      opening: { at: start, reading: '100' },
      closing: { at: '2025-02-28T16:00:00.000Z', reading: '120' },
    },
  } as BillingQuoteEvidence;
  if (typeof change === 'function') change(e);
  else Object.assign(e, change);
  return reviewArrearsCharges(meter, e);
}

test('boundary readings refuse every shape that is not one unpaused meter cycle', () => {
  const ok = meterReview({});
  assert.ok(ok.status === 'due');
  assert.equal(ok.quote.lines[0]!.differenceCents, '2000');
  const refusals: [string, Parameters<typeof meterReview>[0], Authored?][] = [
    ['basis', { basis: 'actual' }],
    [
      'usage events',
      {
        usage: [
          {
            id: 'u',
            revision: '1',
            streamId: 'copies',
            unit: 'copy',
            at: roll(1),
            quantity: '1',
          },
        ],
      },
    ],
    [
      'pauses',
      { pauses: [{ id: 'p', revision: '1', start: roll(1), end: roll(2) }] },
    ],
    [
      'opening instant',
      (e) => {
        e.periodMeter = {
          ...e.periodMeter!,
          opening: { at: roll(1), reading: '100' },
        };
      },
    ],
    [
      'stream',
      (e) => {
        e.periodMeter = { ...e.periodMeter!, streamId: 'other' };
      },
    ],
    [
      'per-cycle allowance',
      {},
      { allowanceBasis: { kind: 'perPricingWindow', quantity: 'included' } },
    ],
  ];
  for (const [name, change, planChange] of refusals)
    assert.throws(
      () => meterReview(change, planChange),
      /complete boundary readings/,
      name,
    );
});

test('an arrears review refuses an invalid service period', () => {
  const e = hireEvidence(20);
  for (const [name, change] of [
    ['a period before the anchor', { periodStart: roll(-1) }],
    ['a service end at the anchor', { serviceEnd: start }],
  ] as const)
    assert.throws(
      () => dueArrearsCycle(dailyHire, { ...e, ...change }),
      /Invalid billing service period/,
      name,
    );
});

test('a service-use engagement carries only its own facts in its own unit', () => {
  const raw = {
    schemaVersion: 'booking.ownerUsage/v1',
    ownerRef: { entityId: owner.entityId, recordId: owner.recordId },
    ownerScope: { kind: 'company', companyId: owner.companyId },
    asOf: roll(20),
    cursor: '4',
    highWater: '4',
    hasMore: false,
    changes: [],
    bookings: [
      {
        bookingId: 'b1',
        slotId: subject,
        fulfilmentMode: 'tracked',
        unit: 'each',
      },
      {
        bookingId: 'b2',
        slotId: 'slot.other',
        fulfilmentMode: 'tracked',
        unit: 'each',
      },
    ],
    evidence: [
      {
        id: 'mine',
        bookingId: 'b1',
        revision: 1,
        kind: 'use',
        voided: false,
        effectiveStart: start,
        effectiveEnd: roll(3),
        quantity: '1',
        unit: 'each',
      },
      {
        id: 'theirs',
        bookingId: 'b2',
        revision: 1,
        kind: 'use',
        voided: false,
        effectiveStart: roll(4),
        effectiveEnd: roll(6),
        quantity: '1',
        unit: 'each',
      },
    ],
  };
  // Evidence of another booking never joins this one (Booking's half).
  const snapshot = bookingServiceUse(raw);
  assert.deepEqual(
    snapshot.engagements.map((e) => [e.id, e.legs.map((l) => l.id)]),
    [
      ['b1', ['mine']],
      ['b2', ['theirs']],
    ],
  );
  const coverage = serviceUseCoverage(
    { snapshot, subjectId: subject, owner },
    'each',
    roll(5),
  );
  assert.deepEqual(
    coverage.bands[0]!.intervals.map((i) => i.id),
    ['mine'],
  );
  // A leg measured in another unit refuses (Billing's half).
  assert.throws(
    () =>
      serviceUseCoverage(
        {
          snapshot: bookingServiceUse({
            ...raw,
            evidence: [{ ...raw.evidence[0]!, unit: 'hour' }],
          }),
          subjectId: subject,
          owner,
        },
        'each',
        roll(5),
      ),
    /unambiguous commercial quantity/,
  );
  assert.equal(truncateBookingInstant(roll(1)), roll(1));
});

test('B1: each rule prices each pricing window on its own (34 days cross a month window)', () => {
  // 31 days in the first window, 3 in the second, at 20 a day or 100 a week.
  for (const [name, extra, expected] of [
    // 31/7 weeks pro rata (442.86) then three days (60).
    ['prorate', { rule: 'prorate' }, 50286],
    // Four weeks and three days (460) then three days (60).
    ['ladder', { rule: 'ladder', capAtNextTier: false }, 52000],
    ['capped ladder', { rule: 'ladder', capAtNextTier: true }, 52000],
    ['bestPrice', { rule: 'bestPrice' }, 52000],
  ] as const)
    assert.deepEqual(
      cents(timePlan({ combination: extra }), 34),
      [expected],
      name,
    );
});

test('the persisted reader-45 bound plan keeps its digest (rate tables are keyed by it)', () => {
  // Measured on origin/main 3c1c0c270 before the protocol existed.
  const bound = {
    ...timePlan({}, { day: 'daily' }),
    id: 'hire',
    slots: [{ id: 'daily', kind: 'money', currency: 'CAD', scale: 2 }],
    pricingWindow: undefined,
    schedule: { kind: 'fixedDays', days: 10 },
    bindings: {
      quoteQueryId: 'q',
      evidenceQueryId: 'e',
      agreedInterval: {
        customerFieldId: 'c',
        currencyFieldId: 'k',
        startFieldId: 's',
        endFieldId: 'n',
        zone: 'America/Edmonton',
      },
      arrearsSource: {
        kind: 'bookingActuals',
        queryId: 'u',
        slotId: 'example:slot.equipment',
      },
      publishOperationId: 'p',
      overrideOperationId: 'o',
      assignmentOperationId: 'a',
      termsQueryId: 't',
      termsFieldId: 'f',
    },
  };
  assert.equal(
    compileRatePlan(JSON.parse(JSON.stringify(bound))).digest,
    'a5cdb6dfcd90684a6d7702b0c5acdf3174c8374cb84d62a6df5923f1dde53b5a',
  );
});

test('the service-use protocol shape is enforced where Billing consumes it', () => {
  const snapshot = useSnapshot(3);
  const review = (value: unknown) =>
    reviewArrearsCharges(dailyHire, hireEvidence(20), {
      snapshot: value as typeof snapshot,
      subjectId: subject,
      owner,
    });
  assert.equal(review(snapshot).status, 'due');
  for (const [reason, value] of [
    ['an undeclared key', { ...snapshot, extra: true }],
    [
      'an instant finer than a millisecond',
      { ...snapshot, asOf: '2025-02-17T16:00:00.000001Z' },
    ],
    [
      'another protocol version',
      { ...snapshot, schemaVersion: 'northstar.service-use/v2' },
    ],
  ] as const)
    assert.throws(
      () => review(value),
      /invalid|Unrecognized|expected/iu,
      reason,
    );
});

test('B7: the agreed band reads the record quantity field, 1 when none is bound', () => {
  assert.equal(agreedQuantity({ seats: '5' }, 'seats'), '5');
  assert.equal(agreedQuantity({ seats: 5 }, 'seats'), '5');
  assert.equal(agreedQuantity({ seats: '5' }, undefined), '1');
  assert.equal(agreedQuantity({ seats: null }, 'seats'), undefined);
  assert.equal(agreedQuantity({}, 'seats'), undefined);
});
