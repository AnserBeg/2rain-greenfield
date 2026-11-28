import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BILLING_ARREARS_READER,
  BILLING_CYCLE_CALCULATION,
  BILLING_PRICING_READER,
  BILLING_RULES_CALCULATION,
  BILLING_RULES_READER,
  BILLING_TIMING_CALCULATION,
  BILLING_TIMING_READER,
  BillingPlanSchema,
  billingEvidenceQuery,
  billingReleaseMismatch,
  billingReleaseTerms,
  hasBillingPricing,
  hasBillingRules,
  hasBillingTiming,
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
  quoteBillingCycle,
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
    [
      'a longer rate under ladder',
      {
        combination: { rule: 'ladder', capAtNextTier: true },
        partial: { week: 'prorate' },
      },
    ],
  ] as const)
    assert.equal(
      BillingPlanSchema.safeParse(timePlan(extra)).success,
      false,
      reason,
    );
  // A ladder's shortest rate takes a partial rule.
  assert.ok(
    BillingPlanSchema.safeParse(
      timePlan({
        combination: { rule: 'ladder', capAtNextTier: true },
        partial: { day: 'prorate' },
      }),
    ).success,
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
function useSnapshot(returnedDay: number | null, asOfDay = 20, pickupDay = 0) {
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
        effectiveStart: roll(pickupDay),
        effectiveEnd: returnedDay === null ? null : roll(returnedDay),
        quantity: '1',
        unit: 'each',
      },
    ],
  });
}
type EarlyReturn = NonNullable<
  ReturnType<typeof billingEvidenceQuery>
>['earlyReturn'];
const dailyHire = compileRatePlan(timePlan({}, { day: 'd' })).plan;
// A plan declares its early-return rule on its bound evidence source, so it
// is rated under calculation v4; the unbound plan is the v3 baseline.
function boundHire(earlyReturn: NonNullable<EarlyReturn>) {
  return compileRatePlan({
    ...timePlan({}, { day: 'd' }),
    bindings: {
      quoteQueryId: 'quote',
      evidenceQueryId: 'source',
      agreedInterval: {
        customerFieldId: 'customer',
        currencyFieldId: 'currency',
        startFieldId: 'start',
        endFieldId: 'end',
        zone: 'America/Edmonton',
      },
      arrearsSource: {
        kind: 'evidenceQuery',
        queryId: 'usage',
        protocol: SERVICE_USE_PROTOCOL,
        subjectId: subject,
        earlyReturn,
      },
      publishOperationId: 'publish',
      overrideOperationId: 'override',
      assignmentOperationId: 'assign',
      termsQueryId: 'terms',
      termsFieldId: 'termsField',
    },
  }).plan;
}
function hireEvidence(plan: unknown, asOfDay: number, agreedDays = 5) {
  return {
    ...evidence(plan, agreedDays, { d: '30' }),
    asOf: roll(asOfDay),
    bands: [],
  } as BillingQuoteEvidence;
}
function earlyReview(
  earlyReturn: EarlyReturn,
  returnedDay = 3,
  asOfDay = 20,
  pickupDay = 0,
) {
  const plan = earlyReturn ? boundHire(earlyReturn) : dailyHire;
  const result = reviewArrearsCharges(plan, hireEvidence(plan, asOfDay), {
    snapshot: useSnapshot(returnedDay, asOfDay, pickupDay),
    subjectId: subject,
    owner,
    ...(earlyReturn ? { earlyReturn } : {}),
  });
  if (result.status !== 'due') return { status: result.status };
  assert.equal(
    result.quote.algorithm,
    earlyReturn ? BILLING_RULES_CALCULATION : BILLING_CYCLE_CALCULATION,
  );
  return {
    status: result.status,
    end: result.cycle!.end,
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

test('B9: committed time runs from the last return, not from pickup', () => {
  // Agreed five days at CAD 30, picked up on day one, returned on day three:
  // two days held, then committed time from the return to the service end.
  assert.deepEqual(earlyReview({ bill: 'agreedEnd' }, 3, 20, 1), {
    status: 'due',
    end: roll(5),
    cents: '12000',
  });
  assert.deepEqual(
    earlyReview(
      { bill: 'actualEnd', minimumTerm: { period: 'week', count: 1 } },
      3,
      20,
      1,
    ),
    { status: 'due', end: roll(7), cents: '18000' },
  );
});

test('B9: early return is rated under calculation v4 only', () => {
  // A plan that does not declare the rule cannot be handed one.
  assert.throws(
    () =>
      reviewArrearsCharges(dailyHire, hireEvidence(dailyHire, 20), {
        snapshot: useSnapshot(3),
        subjectId: subject,
        owner,
        earlyReturn: { bill: 'agreedEnd' },
      }),
    /Early return requires calculation v4/,
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
  const e = hireEvidence(dailyHire, 20);
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
    reviewArrearsCharges(dailyHire, hireEvidence(dailyHire, 20), {
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

// ---- BILLING-1 slice 3a-ii-a: a recurring fixed fee billed in advance (B2) ----
// E1: CAD 300 a month, calendar months, advance, active coverage, agreed from
// Jun 10 2027 (Edmonton midnight), open-ended.
const e1Start = '2027-06-10T06:00:00.000Z';
const july = '2027-07-01T06:00:00.000Z',
  august = '2027-08-01T06:00:00.000Z';
const e1Return = '2027-07-12T18:00:00.000Z';
type Timing = { when: 'advance' | 'arrears'; earlyEnd?: string };
function feeComponent(
  id: string,
  amount: string,
  timing: Timing | undefined,
  pause: 'continue' | 'suspend' | 'absent' = 'continue',
) {
  return {
    kind: 'fixed',
    id,
    base: 'enrollment',
    stage: 'afterCapBeforeTax',
    taxClassification: 'untaxed',
    amount,
    ...(timing && { timing }),
    occurrence: {
      kind: 'recurring',
      cadence: { kind: 'calendarMonth', boundaryMinutes: 0 },
      ...(pause !== 'absent' && { fixedFeeDuringPause: pause }),
    },
  };
}
const advance: Timing = { when: 'advance' };
function advancePlan(
  options: {
    source?: 'agreed' | 'use' | 'none' | 'meter';
    components?: Authored[];
    slots?: string[];
  } = {},
) {
  const { source = 'agreed' } = options;
  const components = options.components ?? [
    feeComponent('rent', 'rent', advance),
  ];
  const slots = options.slots ?? ['rent'];
  return {
    schemaVersion: 'v6',
    id: 'lease',
    version: '1',
    currency: 'CAD',
    serviceUnit: 'each',
    schedule: { kind: 'calendarMonth', boundaryMinutes: 0 },
    slots: slots.map((id) => ({
      id,
      kind: 'money',
      currency: 'CAD',
      scale: 2,
    })),
    components,
    ...(source !== 'none' && {
      bindings: {
        quoteQueryId: 'quote',
        evidenceQueryId: 'source',
        agreedInterval: {
          customerFieldId: 'customer',
          currencyFieldId: 'currency',
          startFieldId: 'start',
          endFieldId: 'end',
          zone: 'America/Edmonton',
        },
        arrearsSource:
          source === 'agreed'
            ? { kind: 'agreedInterval' }
            : source === 'meter'
              ? {
                  kind: 'periodMeter',
                  streamId: 's',
                  unit: 'u',
                  openingReadingFieldId: 'a',
                  closingReadingFieldId: 'b',
                  openingInstantFieldId: 'c',
                  closingInstantFieldId: 'd',
                }
              : {
                  kind: 'evidenceQuery',
                  queryId: 'usage',
                  protocol: SERVICE_USE_PROTOCOL,
                  subjectId: subject,
                  earlyReturn: { bill: 'actualEnd' },
                },
        publishOperationId: 'publish',
        overrideOperationId: 'override',
        assignmentOperationId: 'assign',
        termsQueryId: 'terms',
        termsFieldId: 'termsField',
      },
    }),
  };
}
function e1Evidence(
  planInput: unknown,
  asOf: string,
  end: string | null = null,
  values: Record<string, string> = { rent: '300' },
): BillingQuoteEvidence {
  return {
    ...evidence(planInput, 1, values),
    anchor: e1Start,
    periodStart: e1Start,
    asOf,
    serviceEnd: end,
    bands: [
      {
        id: 'band',
        quantity: '1',
        intervals: [{ id: 'leg', revision: '1', start: e1Start, end }],
      },
    ],
  };
}
// Each line as [component, service period start, cents].
function reviewLines(review: ReturnType<typeof reviewArrearsCharges>) {
  assert.equal(review.status, 'due');
  assert.equal(review.quote.algorithm, BILLING_TIMING_CALCULATION);
  assert.equal(
    replayBillingQuote(review.quote).resultDigest,
    review.quote.resultDigest,
  );
  return review.quote.lines.map((l) => [
    l.componentId,
    l.servicePeriodStart,
    l.differenceCents,
  ]);
}
const agreedReview = (asOf: string, end: string | null = null) =>
  reviewLines(
    reviewArrearsCharges(
      compileRatePlan(advancePlan()).plan,
      e1Evidence(advancePlan(), asOf, end),
    ),
  );

test('B2: an advance fee bills the opened cycle on agreed coverage, not on elapsed time', () => {
  // E1 on Jun 10: 21 of June's 30 days, before any cycle has closed.
  const opened = reviewArrearsCharges(
    compileRatePlan(advancePlan()).plan,
    e1Evidence(advancePlan(), e1Start),
  );
  assert.equal(opened.status, 'due');
  assert.equal(opened.cycle, null);
  assert.deepEqual(reviewLines(opened), [['rent', e1Start, '21000']]);
  assert.deepEqual(agreedReview('2027-06-15T06:00:00.000Z'), [
    ['rent', e1Start, '21000'],
  ]);
  // Jul 1: July opens in full; June keeps its amount.
  assert.deepEqual(agreedReview(july), [
    ['rent', e1Start, '21000'],
    ['rent', july, '30000'],
  ]);
  // Before the agreed start nothing is owed.
  assert.equal(
    reviewArrearsCharges(
      compileRatePlan(advancePlan()).plan,
      e1Evidence(advancePlan(), '2027-06-09T06:00:00.000Z'),
    ).status,
    'notDue',
  );
  // An agreed end inside a cycle prorates that cycle (Aug 1 to Aug 20).
  assert.deepEqual(agreedReview(august, '2027-08-20T06:00:00.000Z'), [
    ['rent', e1Start, '21000'],
    ['rent', july, '30000'],
    ['rent', august, '18387'],
  ]);
});

test('B2: an opened advance cycle is not rated again when it closes', () => {
  for (const asOf of [july, '2027-07-20T06:00:00.000Z', august])
    assert.deepEqual(agreedReview(asOf).slice(0, 2), [
      ['rent', e1Start, '21000'],
      ['rent', july, '30000'],
    ]);
});

// The service-use journey: actual use sets the service end (actualEnd).
function e1Snapshot(returned: string | null, asOf: string) {
  return bookingServiceUse({
    schemaVersion: 'booking.ownerUsage/v1',
    ownerRef: { entityId: owner.entityId, recordId: owner.recordId },
    ownerScope: { kind: 'company', companyId: owner.companyId },
    asOf,
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
        effectiveStart: e1Start,
        effectiveEnd: returned,
        quantity: '1',
        unit: 'each',
      },
    ],
  });
}
function useReview(
  asOf: string,
  returned: string | null = e1Return,
  snapshotAsOf = asOf,
  planInput: unknown = advancePlan({ source: 'use' }),
) {
  const plan = compileRatePlan(planInput).plan;
  return reviewArrearsCharges(
    plan,
    { ...e1Evidence(planInput, asOf), bands: [] },
    {
      snapshot: e1Snapshot(returned, snapshotAsOf),
      subjectId: subject,
      owner,
      earlyReturn: { bill: 'actualEnd' },
    },
  );
}

test('B2: keepPaidPeriod keeps an opened cycle whole after an early end, and no cycle opens after it', () => {
  // Returned Jul 12: July stays 300.00 (total 510.00); August never opens.
  for (const asOf of [
    '2027-07-12T19:00:00.000Z',
    august,
    '2027-09-15T06:00:00.000Z',
  ])
    assert.deepEqual(reviewLines(useReview(asOf)), [
      ['rent', e1Start, '21000'],
      ['rent', july, '30000'],
    ]);
  // While the equipment is out, July is owed from its first instant.
  assert.deepEqual(reviewLines(useReview(july, null)), [
    ['rent', e1Start, '21000'],
    ['rent', july, '30000'],
  ]);
});

test('B2: a late first review still owes every opened cycle', () => {
  // First reviewed on Aug 5, after the Jul 12 return: June and July, never August.
  const late = useReview('2027-08-05T06:00:00.000Z');
  assert.equal(late.status, 'due');
  assert.deepEqual(late.status === 'due' && late.advance?.map((c) => c.start), [
    e1Start,
    july,
  ]);
  assert.deepEqual(reviewLines(late), [
    ['rent', e1Start, '21000'],
    ['rent', july, '30000'],
  ]);
});

test('B2: advance reads actual use through the review instant', () => {
  // A snapshot older than the review instant cannot say the service is open.
  assert.throws(
    () => useReview(august, null, '2027-07-31T06:00:00.000Z'),
    /Incomplete service-use snapshot/,
  );
  // An overrun past the agreed end is billed on top of the agreed coverage:
  // agreed to Jul 15, still out on Aug 10, so July is whole and August has
  // nine of its 31 days so far.
  const planInput = advancePlan({ source: 'use' });
  const plan = compileRatePlan(planInput).plan;
  const overrun = reviewArrearsCharges(
    plan,
    {
      ...e1Evidence(
        planInput,
        '2027-08-10T06:00:00.000Z',
        '2027-07-15T06:00:00.000Z',
      ),
      bands: [],
    },
    {
      snapshot: e1Snapshot(null, '2027-08-10T06:00:00.000Z'),
      subjectId: subject,
      owner,
      earlyReturn: { bill: 'actualEnd' },
    },
  );
  assert.deepEqual(reviewLines(overrun), [
    ['rent', e1Start, '21000'],
    ['rent', july, '30000'],
    ['rent', august, '8710'],
  ]);
});

test('B2: arrears fees and one-offs in an advance plan stay closed-cycle only', () => {
  const planInput = advancePlan({
    slots: ['rent', 'fuel', 'setup'],
    components: [
      feeComponent('rent', 'rent', advance),
      feeComponent('fuel', 'fuel', { when: 'arrears' }),
      {
        kind: 'fixed',
        id: 'setup',
        base: 'enrollment',
        stage: 'afterCapBeforeTax',
        taxClassification: 'untaxed',
        amount: 'setup',
        occurrence: { kind: 'oneOff', at: 'serviceStart' },
      },
    ],
  });
  const plan = compileRatePlan(planInput).plan;
  const review = (asOf: string) =>
    reviewLines(
      reviewArrearsCharges(
        plan,
        e1Evidence(planInput, asOf, null, {
          rent: '300',
          fuel: '50',
          setup: '25',
        }),
      ),
    );
  // Jun 15: only the advance fee; nothing has closed.
  assert.deepEqual(review('2027-06-15T06:00:00.000Z'), [
    ['rent', e1Start, '21000'],
  ]);
  // Jul 15: June closed, so June's fuel and the set-up fee; July's fuel is
  // not billed while July is open.
  assert.deepEqual(review('2027-07-15T06:00:00.000Z'), [
    ['fuel', e1Start, '3500'],
    ['rent', e1Start, '21000'],
    ['rent', july, '30000'],
    ['setup', e1Start, '2500'],
  ]);
});

test('B2: timing refusals (unstated, suspend, prorateAndRefund, advance outside a recurring fee)', () => {
  const refused = (planInput: unknown, message: RegExp, reason: string) => {
    const parsed = BillingPlanSchema.safeParse(planInput);
    assert.equal(parsed.success, false, reason);
    assert.match(JSON.stringify(parsed.error?.issues), message, reason);
  };
  refused(
    advancePlan({
      slots: ['rent', 'fuel'],
      components: [
        feeComponent('rent', 'rent', advance),
        feeComponent('fuel', 'fuel', undefined),
      ],
    }),
    /states it on every component/,
    'an unstated recurring fee beside a timed one',
  );
  refused(
    advancePlan({
      slots: ['rent', 'd'],
      components: [
        feeComponent('rent', 'rent', advance),
        { ...timePlan({}, { day: 'd' }).components[0] },
      ],
    }),
    /states it on every component/,
    'an unstated time component beside a timed fee',
  );
  for (const pause of ['suspend', 'absent'] as const)
    refused(
      advancePlan({
        components: [feeComponent('rent', 'rent', advance, pause)],
      }),
      /continues during a pause/,
      'advance with a suspending pause: ' + String(pause),
    );
  refused(
    advancePlan({
      components: [
        feeComponent('rent', 'rent', {
          when: 'advance',
          earlyEnd: 'prorateAndRefund',
        }),
      ],
    }),
    /customer credit balances/,
    'prorateAndRefund',
  );
  refused(
    advancePlan({
      slots: ['d'],
      components: [
        { ...timePlan({}, { day: 'd' }).components[0], timing: advance },
      ],
    }),
    /Advance time billing/,
    'advance on a time component',
  );
  refused(
    advancePlan({
      components: [
        {
          ...feeComponent('rent', 'rent', undefined),
          timing: advance,
          occurrence: { kind: 'oneOff', at: 'serviceStart' },
        },
      ],
    }),
    /one-off fee has no billing timing/,
    'advance on a one-off',
  );
  for (const source of ['none', 'meter'] as const)
    refused(
      advancePlan({ source }),
      /interval or service-use source/,
      'advance without a cycle source: ' + source,
    );
  refused(
    advancePlan({
      slots: ['rent', 'fuel'],
      components: [
        feeComponent('rent', 'rent', advance),
        feeComponent('fuel', 'fuel', {
          when: 'arrears',
          earlyEnd: 'keepPaidPeriod',
        }),
      ],
    }),
    /early-end rule applies only to an advance component/,
    'an early-end rule on an arrears component',
  );
  // A meter declares no timing at all.
  const meterPlan = advancePlan({
    slots: ['rent', 'rate', 'included'],
    components: [
      feeComponent('rent', 'rent', advance),
      {
        id: 'overage',
        kind: 'meter',
        stage: 'afterCapBeforeTax',
        taxClassification: 'untaxed',
        streamId: 'copies',
        unit: 'copy',
        overageRate: 'rate',
        timing: advance,
        allowanceBasis: { kind: 'perCycle', quantity: 'included' },
      },
    ],
  });
  assert.equal(BillingPlanSchema.safeParse(meterPlan).success, false);
  // A stated arrears time component beside an advance fee is admitted.
  assert.equal(
    BillingPlanSchema.safeParse(
      advancePlan({
        slots: ['rent', 'd'],
        components: [
          feeComponent('rent', 'rent', advance),
          {
            ...timePlan({}, { day: 'd' }).components[0],
            timing: { when: 'arrears' },
          },
        ],
      }),
    ).success,
    true,
  );
});

test('B2: advance on service use requires a declared early return', () => {
  // Without one, service use holds the service open to the agreed end, so
  // an advance fee would keep opening whole cycles after the return (agreed
  // Jun 10 to Aug 31, returned Jul 12: August 300.00 with no commitment).
  const use = advancePlan({ source: 'use' }) as {
    bindings: { arrearsSource: Record<string, unknown> };
  };
  assert.equal(BillingPlanSchema.safeParse(use).success, true);
  const withoutRule = { ...use.bindings.arrearsSource };
  delete withoutRule.earlyReturn;
  for (const [reason, arrearsSource] of [
    ['an evidence source with no early return', withoutRule],
    [
      'the persisted Booking source',
      { kind: 'bookingActuals', queryId: 'usage', slotId: subject },
    ],
  ] as const) {
    const parsed = BillingPlanSchema.safeParse({
      ...use,
      bindings: { ...use.bindings, arrearsSource },
    });
    assert.equal(parsed.success, false, reason);
    assert.match(
      JSON.stringify(parsed.error?.issues),
      /requires a declared early return/,
      reason,
    );
  }
});

test('B2: timing selects calculation v5 and the timing reader; plans without it keep their bytes', () => {
  const timed = advancePlan();
  const untimed = advancePlan({
    components: [feeComponent('rent', 'rent', undefined)],
  });
  assert.equal(hasBillingTiming(timed), true);
  assert.equal(hasBillingTiming(untimed), false);
  // No timing key is added by normalization, so the digest is unchanged.
  assert.equal('timing' in compileRatePlan(untimed).plan.components[0]!, false);
  assert.deepEqual(billingReleaseTerms([timed]), {
    agreed: true,
    calculation: BILLING_TIMING_CALCULATION,
    floor: BILLING_TIMING_READER,
  });
  assert.deepEqual(billingReleaseTerms([untimed]), {
    agreed: true,
    calculation: BILLING_CYCLE_CALCULATION,
    floor: BILLING_ARREARS_READER,
  });
  // The previous reader refuses a v5 plan by name.
  const payload = {
    billingPlans: [timed],
    billingCalculationVersion: BILLING_TIMING_CALCULATION,
  };
  assert.equal(
    billingReleaseMismatch([timed], payload, BILLING_TIMING_READER),
    false,
  );
  assert.equal(
    billingReleaseMismatch([timed], payload, BILLING_RULES_READER),
    true,
  );
  assert.equal(
    billingReleaseMismatch(
      [timed],
      { ...payload, billingCalculationVersion: BILLING_RULES_CALCULATION },
      BILLING_TIMING_READER,
    ),
    true,
  );
  // A timed plan is never rated under v4, and an untimed plan never under v5.
  const plan = compileRatePlan(timed).plan;
  const review = reviewArrearsCharges(plan, e1Evidence(timed, july));
  assert.equal(review.status, 'due');
  assert.throws(
    () =>
      replayBillingQuote({
        ...review.quote,
        algorithm: BILLING_RULES_CALCULATION,
      }),
    /calculation v5/,
  );
  const untimedReview = reviewArrearsCharges(
    compileRatePlan(untimed).plan,
    e1Evidence(untimed, july),
  );
  assert.equal(untimedReview.status, 'due');
  assert.equal(untimedReview.quote.algorithm, BILLING_CYCLE_CALCULATION);
  assert.equal('advance' in untimedReview, false);
  assert.throws(
    () =>
      replayBillingQuote({
        ...untimedReview.quote,
        algorithm: BILLING_TIMING_CALCULATION,
      }),
    /calculation v5/,
  );
  // An advance fee is rated only in a cycle review with its agreed end.
  assert.throws(
    () => quoteBillingService(timed, e1Evidence(timed, july)),
    /cycle review and its agreed end/,
  );
  assert.throws(
    () => quoteBillingCycle(plan, e1Evidence(timed, july), july),
    /cycle review and its agreed end/,
  );
});

// ---- BILLING-1 slice 3a-ii-b: the minimum charge from the agreed start ----
// Measured before s3a-ii-b under Node 22.22.2 (zone data 2025c): later slices
// must leave a v4 quote and a slice-a v5 review byte for byte.
test('s3a-ii-b leaves v4 quotes and slice-a v5 reviews byte for byte', () => {
  const v4 = timePlan({
    combination: { rule: 'ladder', capAtNextTier: false },
  });
  const quote = quoteBillingService(v4, evidence(v4, 10, daily20weekly100));
  assert.equal(
    quote.resultDigest,
    '4c1e4ae3e8c4b6ce334fc885e3425ce696a62a5be530913b969391bdc37f1918',
  );
  const agreed = reviewArrearsCharges(
    compileRatePlan(advancePlan()).plan,
    e1Evidence(advancePlan(), july),
  );
  assert.ok(agreed.status === 'due');
  assert.equal(
    agreed.quote.resultDigest,
    '99c2bbca94fd3ce269e7a183f3d96bf28c07e032a57a1bc3f2cedcfafcf69544',
  );
  const late = useReview('2027-08-05T06:00:00.000Z');
  assert.ok(late.status === 'due');
  assert.equal(
    late.quoteDigest,
    'b8c37a9a8f8e7bf7cb64d0d1070673c3bd917fe933ce29d40f1e4f56babb3fa1',
  );
});

// E2: CAD 30 a day, minimum duration 7 days per enrollment, actualEnd, booked
// seven days, returned on day three: the minimum is owed at the return.
function e2Plan() {
  return {
    ...timePlan(
      {
        minimumDuration: { period: 'day', count: 7 },
        timing: { when: 'arrears' },
      },
      { day: 'd' },
    ),
    bindings: boundHire({ bill: 'actualEnd' }).bindings,
  };
}
function e2Review(pickupDay: number, returnedDay = 3) {
  const planInput = e2Plan();
  const plan = compileRatePlan(planInput).plan;
  const result = reviewArrearsCharges(
    plan,
    hireEvidence(planInput, returnedDay, 7),
    {
      snapshot: useSnapshot(returnedDay, returnedDay, pickupDay),
      subjectId: subject,
      owner,
      earlyReturn: { bill: 'actualEnd' },
    },
  );
  assert.ok(result.status === 'due');
  assert.equal(result.quote.algorithm, BILLING_TIMING_CALCULATION);
  return [
    result.cycle!.end,
    ...result.quote.lines.map((l) => l.differenceCents),
  ];
}

test('B2 minimum: a time minimum is a minimum charge from the agreed start (E2)', () => {
  // Due on day three (v4's early-return minimumTerm made it due on day seven).
  assert.deepEqual(e2Review(0), [roll(3), '21000']);
  // A late pickup does not move the minimum: picked up day one, still 210.00.
  assert.deepEqual(e2Review(1), [roll(3), '21000']);
  // Kept past the minimum, the time earned is billed.
  assert.deepEqual(e2Review(0, 9), [roll(9), '27000']);
});

// E1m: E1 with a three-month minimum term (ends Sep 10).
const threeMonths = { period: 'month', count: 3 } as const;
const september = '2027-09-01T06:00:00.000Z',
  termEnds = '2027-09-10T06:00:00.000Z';
function termFee(timing: Timing, term: Authored | undefined = threeMonths) {
  return {
    ...feeComponent('rent', 'rent', timing),
    ...(term && { minimumTerm: term }),
  };
}

test('B2 minimum: a fixed minimum term bills to the term end at an early end (E1m)', () => {
  const planInput = advancePlan({
    source: 'use',
    components: [termFee(advance)],
  });
  // Returned Jul 12: August 300.00 and Sep 1-10 90.00 fall due at the return.
  // Total 900.00 = 3 x 300.
  const e1m = [
    ['rent', e1Start, '21000'],
    ['rent', july, '30000'],
    ['rent', august, '30000'],
    ['rent', september, '9000'],
  ];
  for (const asOf of ['2027-07-12T19:00:00.000Z', '2027-09-15T06:00:00.000Z'])
    assert.deepEqual(
      reviewLines(useReview(asOf, e1Return, asOf, planInput)),
      e1m,
    );
  const review = useReview(
    '2027-07-12T19:00:00.000Z',
    e1Return,
    undefined,
    planInput,
  );
  assert.ok(review.status === 'due');
  assert.deepEqual(review.advance?.at(-1), {
    componentId: 'rent',
    start: september,
    end: termEnds,
  });
  // While the equipment is out the term holds nothing back.
  assert.deepEqual(
    reviewLines(
      useReview('2027-07-05T06:00:00.000Z', null, undefined, planInput),
    ),
    e1m.slice(0, 2),
  );
  // Returned after the term end, the term is spent: cycles open as before.
  assert.deepEqual(
    reviewLines(
      useReview(
        '2027-09-25T06:00:00.000Z',
        '2027-09-20T06:00:00.000Z',
        undefined,
        planInput,
      ),
    ),
    [...e1m.slice(0, 3), ['rent', september, '30000']],
  );
  // On an agreed interval the record's end is the service end: agreed to
  // Jul 12, the term still bills to Sep 10.
  const agreedInput = advancePlan({ components: [termFee(advance)] });
  assert.deepEqual(
    reviewLines(
      reviewArrearsCharges(
        compileRatePlan(agreedInput).plan,
        e1Evidence(agreedInput, '2027-07-12T19:00:00.000Z', e1Return),
      ),
    ),
    e1m,
  );
});

test('B2 minimum: an arrears fee with a minimum term bills to the term end in its final review', () => {
  const planInput = advancePlan({ components: [termFee({ when: 'arrears' })] });
  const plan = compileRatePlan(planInput).plan;
  const review = (periodStart: string) =>
    reviewLines(
      reviewArrearsCharges(plan, {
        ...e1Evidence(planInput, '2027-07-13T06:00:00.000Z', e1Return),
        periodStart,
      }),
    );
  // The June cycle's review: the service has not ended within it.
  assert.deepEqual(review(e1Start), [['rent', e1Start, '21000']]);
  // The final review reaches the service end: July whole, August, Sep 1-10.
  assert.deepEqual(review(july), [
    ['rent', e1Start, '21000'],
    ['rent', july, '30000'],
    ['rent', august, '30000'],
    ['rent', september, '9000'],
  ]);
});

test('B2 minimum: refusals and the pricing reader', () => {
  const refused = (planInput: unknown, message: RegExp, reason: string) => {
    const parsed = BillingPlanSchema.safeParse(planInput);
    assert.equal(parsed.success, false, reason);
    assert.match(JSON.stringify(parsed.error?.issues), message, reason);
  };
  refused(
    advancePlan({
      components: [
        {
          ...termFee(advance),
          timing: undefined,
          occurrence: { kind: 'oneOff', at: 'serviceStart' },
        },
      ],
    }),
    /one-off fee has no minimum term/,
    'a minimum term on a one-off',
  );
  const use = advancePlan({
    source: 'use',
    components: [termFee(advance)],
  }) as {
    bindings: { arrearsSource: Record<string, unknown> };
  };
  refused(
    {
      ...use,
      bindings: {
        ...use.bindings,
        arrearsSource: {
          ...use.bindings.arrearsSource,
          earlyReturn: { bill: 'actualEnd', minimumTerm: threeMonths },
        },
      },
    },
    /one minimum term form/,
    'both minimum term forms',
  );
  // Any v5 key requires stated timing, not only a timing key.
  const unstated = {
    ...feeComponent('rent', 'rent', undefined),
    minimumTerm: threeMonths,
  };
  refused(
    advancePlan({ components: [unstated] }),
    /states it on every component/,
    'a minimum term with no stated timing',
  );
  // A minimum duration that can never fit its pricing window refuses under v5
  // (a v4 plan keeps parsing: its reviews refuse at rating, as before).
  const longMinimum = timePlan(
    { minimumDuration: { period: 'week', count: 2 } },
    { day: 'd' },
  );
  const weekly = { ...longMinimum, pricingWindow: 'week' };
  assert.equal(BillingPlanSchema.safeParse(weekly).success, true);
  refused(
    {
      ...weekly,
      components: [{ ...weekly.components[0], timing: { when: 'arrears' } }],
    },
    /can never fit its pricing window/,
    'a two-week minimum in a weekly window',
  );
  assert.equal(
    BillingPlanSchema.safeParse({
      ...longMinimum,
      components: [
        { ...longMinimum.components[0], timing: { when: 'arrears' } },
      ],
    }).success,
    true,
    'two weeks fit a month window',
  );
  // The term selects calculation v5 and its own reader: rung 56 (timing only)
  // refuses it by name.
  const termed = advancePlan({ components: [termFee(advance)] });
  assert.equal(hasBillingPricing(termed), true);
  assert.equal(hasBillingPricing(advancePlan()), false);
  assert.deepEqual(billingReleaseTerms([termed]), {
    agreed: true,
    calculation: BILLING_TIMING_CALCULATION,
    floor: BILLING_PRICING_READER,
  });
  const payload = {
    billingPlans: [termed],
    billingCalculationVersion: BILLING_TIMING_CALCULATION,
  };
  assert.equal(
    billingReleaseMismatch([termed], payload, BILLING_PRICING_READER),
    false,
  );
  assert.equal(
    billingReleaseMismatch([termed], payload, BILLING_TIMING_READER),
    true,
  );
  assert.equal(
    billingReleaseMismatch(undefined, {}, BILLING_PRICING_READER),
    true,
  );
});

test('B2 minimum: the early-return term form charges exactly the term too (slice-a correction)', () => {
  // Ruling 2026-11-28: a minimum term charges exactly the term from the agreed
  // start, prorated, never more. Slice a billed September whole (1110.00)
  // because the held service end opened it on the open-ended agreed interval.
  // A cycle that opens after the return is rated on the committed interval.
  const planInput = advancePlan({ source: 'use' }) as {
    bindings: { arrearsSource: Record<string, unknown> };
  };
  const earlyReturn = { bill: 'actualEnd', minimumTerm: threeMonths } as const;
  planInput.bindings.arrearsSource.earlyReturn = earlyReturn;
  const plan = compileRatePlan(planInput).plan;
  const review = (asOf: string) =>
    reviewLines(
      reviewArrearsCharges(
        plan,
        { ...e1Evidence(planInput, asOf), bands: [] },
        {
          snapshot: e1Snapshot(e1Return, asOf),
          subjectId: subject,
          owner,
          earlyReturn,
        },
      ),
    );
  // Same facts as E1m: 210 + 300 + 300 + 90 = 900.00 once the term has run.
  assert.deepEqual(review('2027-09-15T06:00:00.000Z'), [
    ['rent', e1Start, '21000'],
    ['rent', july, '30000'],
    ['rent', august, '30000'],
    ['rent', september, '9000'],
  ]);
  // This form keeps its timing: held cycles fall due as they open.
  assert.deepEqual(review('2027-07-12T19:00:00.000Z'), [
    ['rent', e1Start, '21000'],
    ['rent', july, '30000'],
  ]);
});

// ---- BILLING-1 slice 3a-ii-b: percent discounts (B13) and percentage components ----
const off = { kind: 'percent', rate: 'off', reason: 'loyalty' } as const;
const arrearsTiming = { when: 'arrears' } as const;
function slotList(money: string[], percent: string[]) {
  return [
    ...money.map((id) => ({ id, kind: 'money', currency: 'CAD', scale: 2 })),
    ...percent.map((id) => ({ id, kind: 'percentage', scale: 2 })),
  ];
}
// E3: CAD 30 a day or 100 a week, four-week window, cap 240, 10% off.
function e3Plan(extra: Authored[] = [], percent: string[] = ['off']) {
  const base = timePlan({ cap: 'cap', discount: off, timing: arrearsTiming });
  return {
    ...base,
    pricingWindow: 'fourWeek',
    slots: slotList(['d', 'w', 'cap'], percent),
    components: [...base.components, ...extra],
  };
}
const e3Values = { d: '30', w: '100', cap: '240', off: '10' };
function quoteLines(
  planInput: unknown,
  days: number,
  values: Record<string, string>,
) {
  const quote = quoteBillingService(
    planInput,
    evidence(planInput, days, values),
  );
  assert.equal(quote.algorithm, BILLING_TIMING_CALCULATION);
  assert.equal(replayBillingQuote(quote).resultDigest, quote.resultDigest);
  return quote.lines;
}

test('B13: a percent discount applies after the minimum and the cap (E3)', () => {
  const [day7] = quoteLines(e3Plan(), 7, e3Values);
  assert.equal(day7!.differenceCents, '9000');
  assert.deepEqual(day7!.discount, {
    kind: 'percent',
    reason: 'loyalty',
    grossExact: '100',
    discountExact: '10',
    grossCents: '10000',
    discountCents: '1000',
  });
  // Day 20: best cover 300, capped 240, 10% off: 216.00 (126.00 after the 90.00).
  const [day20] = quoteLines(e3Plan(), 20, e3Values);
  assert.equal(day20!.differenceCents, '21600');
  assert.equal(day20!.discount?.grossCents, '24000');
  assert.equal(day20!.discount?.discountCents, '2400');
  // Each window's rate is evidence in the derivation.
  assert.equal(
    (day20!.derivation[0] as { discountRate: string }).discountRate,
    '10',
  );
  // The cover is chosen on undiscounted prices: the same blocks either way.
  const plain = quoteLines(e3Plan(), 20, { ...e3Values, off: '0' })[0]!;
  assert.deepEqual(
    (plain.derivation[0] as { blocks: unknown }).blocks,
    (day20!.derivation[0] as { blocks: unknown }).blocks,
  );
  assert.equal(plain.differenceCents, '24000');
});

test('B13: the enrollment minimum is discounted at the first window rate, then x quantity (E4)', () => {
  // Minimum seven days at 30, three days active: floor 210.00, 10% off 189.00.
  const floor = timePlan(
    {
      minimumDuration: { period: 'day', count: 7 },
      discount: off,
      timing: arrearsTiming,
    },
    { day: 'd' },
  );
  const floorPlan = { ...floor, slots: slotList(['d'], ['off']) };
  const [line] = quoteLines(floorPlan, 3, { d: '30', off: '10' });
  assert.equal(line!.differenceCents, '18900');
  assert.equal(line!.discount?.grossCents, '21000');
  // E4: ladder at 20 a day or 100 a week, ten days (160), quantity 2, 15% off.
  const ladder = timePlan({
    combination: { rule: 'ladder', capAtNextTier: false },
    discount: off,
    timing: arrearsTiming,
  });
  const ladderPlan = { ...ladder, slots: slotList(['d', 'w'], ['off']) };
  const quote = quoteBillingService(
    ladderPlan,
    evidence(ladderPlan, 10, { d: '20', w: '100', off: '15' }, '2'),
  );
  assert.equal(quote.lines[0]!.differenceCents, '27200');
  assert.equal(quote.lines[0]!.discount?.discountCents, '4800');
});

test('B13: a fixed fee is discounted per occurrence, with its rate and version', () => {
  const planInput = advancePlan({
    slots: ['rent'],
    components: [{ ...feeComponent('rent', 'rent', advance), discount: off }],
  }) as { slots: unknown[] };
  planInput.slots = slotList(['rent'], ['off']);
  const lines = reviewArrearsCharges(
    compileRatePlan(planInput).plan,
    e1Evidence(planInput, july, null, { rent: '300', off: '10' }),
  );
  assert.ok(lines.status === 'due');
  assert.deepEqual(
    lines.quote.lines.map((l) => [
      l.differenceCents,
      l.discount?.discountCents,
      l.discount?.rate,
    ]),
    [
      ['18900', '2100', '10'],
      ['27000', '3000', '10'],
    ],
  );
});

test('B13: a percentage above 100 refuses in every table, overrides included', () => {
  const planInput = e3Plan();
  assert.throws(
    () => quoteLines(planInput, 7, { ...e3Values, off: '100.01' }),
    /percentage above 100/,
  );
  const ev = evidence(planInput, 7, e3Values);
  ev.tables.push({
    ...ev.tables[0]!,
    version: 'override',
    selector: { kind: 'customer', customerId: 'c1' },
    values: { ...e3Values, off: '150' },
  });
  assert.throws(
    () => quoteBillingService(planInput, ev),
    /percentage above 100/,
  );
  // 100 is a whole discount: a 0.00 line that keeps its evidence.
  const [free] = quoteLines(planInput, 7, { ...e3Values, off: '100' });
  assert.equal(free!.differenceCents, '0');
  assert.equal(free!.discount?.discountCents, '10000');
});

// E5: a 12% damage waiver on E3's time line.
function waiver(stage: 'gross' | 'net') {
  return {
    kind: 'percentage',
    id: 'waiver',
    taxClassification: 'untaxed',
    stage: 'afterCapBeforeTax',
    rate: 'waiver',
    base: { componentId: 'time', stage },
  };
}
test('B13: a percentage component rates its base at the named stage (E5)', () => {
  const values = { ...e3Values, waiver: '12' };
  const at = (stage: 'gross' | 'net', days: number) =>
    quoteLines(e3Plan([waiver(stage)], ['off', 'waiver']), days, values).map(
      (l) => [l.componentId, l.occurrence, l.differenceCents],
    );
  const pct = JSON.stringify(['pct', JSON.stringify(['time', 'band'])]);
  assert.deepEqual(at('net', 20), [
    ['time', JSON.stringify(['time', 'band']), '21600'],
    ['waiver', pct, '2592'],
  ]);
  assert.deepEqual(at('gross', 20)[1], ['waiver', pct, '2880']);
  // Split as E3: 10.80 after day 7, then 15.12.
  assert.deepEqual(at('net', 7)[1], ['waiver', pct, '1080']);
});

test('B13: a percentage component mirrors each fee occurrence and its timing', () => {
  const planInput = advancePlan({
    components: [
      feeComponent('rent', 'rent', advance),
      { ...waiver('gross'), base: { componentId: 'rent', stage: 'gross' } },
    ],
  }) as { slots: unknown[] };
  planInput.slots = slotList(['rent'], ['waiver']);
  const review = (asOf: string) =>
    reviewLines(
      reviewArrearsCharges(
        compileRatePlan(planInput).plan,
        e1Evidence(planInput, asOf, null, { rent: '300', waiver: '12' }),
      ),
    );
  // Billed in advance with its base, before any cycle closes.
  assert.deepEqual(review(e1Start), [
    ['rent', e1Start, '21000'],
    ['waiver', e1Start, '2520'],
  ]);
  assert.deepEqual(review(july).slice(2), [
    ['waiver', e1Start, '2520'],
    ['waiver', july, '3600'],
  ]);
});

test('B13: discount and percentage refusals, and the pricing reader', () => {
  const refused = (planInput: unknown, message: RegExp, reason: string) => {
    const parsed = BillingPlanSchema.safeParse(planInput);
    assert.equal(parsed.success, false, reason);
    assert.match(JSON.stringify(parsed.error?.issues), message, reason);
  };
  refused(
    { ...e3Plan(), slots: slotList(['d', 'w', 'cap', 'off'], []) },
    /Incompatible billing slot off/,
    'a discount rate on a money slot',
  );
  refused(
    {
      ...e3Plan([waiver('net')], ['off']),
      slots: slotList(['d', 'w', 'cap', 'waiver'], ['off']),
    },
    /Incompatible billing slot waiver/,
    'a percentage rate on a money slot',
  );
  for (const [componentId, reason] of [
    ['missing', 'an unknown base'],
    ['waiver', 'itself as its base'],
  ] as const)
    refused(
      e3Plan(
        [{ ...waiver('net'), base: { componentId, stage: 'net' } }],
        ['off', 'waiver'],
      ),
      /one non-percentage component as its base/,
      reason,
    );
  refused(
    e3Plan(
      [
        waiver('net'),
        {
          ...waiver('net'),
          id: 'second',
          base: { componentId: 'waiver', stage: 'net' },
        },
      ],
      ['off', 'waiver'],
    ),
    /one non-percentage component as its base/,
    'another percentage as its base',
  );
  for (const [key, value] of [
    ['discount', off],
    ['timing', arrearsTiming],
    ['base', [{ componentId: 'time', stage: 'net' }]],
  ] as const)
    assert.equal(
      BillingPlanSchema.safeParse(
        e3Plan([{ ...waiver('net'), [key]: value }], ['off', 'waiver']),
      ).success,
      false,
      'a percentage component with ' + key,
    );
  // A discount is a v5 key: it requires stated timing.
  const untimed = e3Plan() as { components: Authored[] };
  untimed.components = [{ ...untimed.components[0], timing: undefined }];
  refused(
    untimed,
    /states it on every component/,
    'a discount with no stated timing',
  );
  assert.equal(hasBillingPricing(e3Plan()), true);
  assert.deepEqual(
    billingReleaseTerms([e3Plan()]).floor,
    BILLING_PRICING_READER,
  );
  // Plans without a discount keep the key absent (digest stability).
  assert.equal(
    'discount' in compileRatePlan(advancePlan()).plan.components[0]!,
    false,
  );
});

test('B13: a meter discounts its overage, never its allowance; a one-off is discounted once', () => {
  const planInput = {
    schemaVersion: 'v6',
    id: 'usage',
    version: '1',
    currency: 'CAD',
    serviceUnit: 'each',
    schedule: { kind: 'anniversary', months: 1 },
    slots: [
      { id: 'rate', kind: 'money', currency: 'CAD', scale: 2 },
      { id: 'included', kind: 'quantity', unit: 'copy', scale: 2 },
      { id: 'off', kind: 'percentage', scale: 2 },
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
        discount: off,
        allowanceBasis: { kind: 'perCycle', quantity: 'included' },
      },
    ],
  };
  const meter = compileRatePlan(planInput).plan;
  const review = reviewArrearsCharges(meter, {
    ...evidence(planInput, 31, { rate: '2', included: '10', off: '10' }),
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
  } as BillingQuoteEvidence);
  assert.ok(review.status === 'due');
  assert.equal(review.quote.algorithm, BILLING_TIMING_CALCULATION);
  const [line] = review.quote.lines;
  // 20 copies, 10 included at full allowance, 10 x 2.00 = 20.00, 10% off.
  assert.equal(line!.differenceCents, '1800');
  assert.equal(line!.discount?.grossCents, '2000');
  assert.equal((line!.derivation[0] as { allowance: string }).allowance, '10');
  // A one-off set-up fee of 25.00 at 10% off: 22.50, once.
  const oneOff = advancePlan({
    components: [
      feeComponent('rent', 'rent', advance),
      {
        kind: 'fixed',
        id: 'setup',
        base: 'enrollment',
        stage: 'afterCapBeforeTax',
        taxClassification: 'untaxed',
        amount: 'setup',
        discount: off,
        occurrence: { kind: 'oneOff', at: 'serviceStart' },
      },
    ],
  }) as { slots: unknown[] };
  oneOff.slots = slotList(['rent', 'setup'], ['off']);
  const lines = reviewArrearsCharges(
    compileRatePlan(oneOff).plan,
    e1Evidence(oneOff, '2027-07-15T06:00:00.000Z', null, {
      rent: '300',
      setup: '25',
      off: '10',
    }),
  );
  assert.ok(lines.status === 'due');
  assert.deepEqual(
    lines.quote.lines
      .filter((l) => l.componentId === 'setup')
      .map((l) => [l.differenceCents, l.discount?.discountCents]),
    [['2250', '250']],
  );
});

test('B2 minimum: a term never bills a partly held cycle whole (feeProration none refuses)', () => {
  const refused = (planInput: unknown, reason: string) => {
    const parsed = BillingPlanSchema.safeParse(planInput);
    assert.equal(parsed.success, false, reason);
    assert.match(
      JSON.stringify(parsed.error?.issues),
      /minimum term prorates its last cycle/,
      reason,
    );
  };
  const whole = (fee: Authored) => ({
    ...fee,
    occurrence: {
      ...(fee.occurrence as Authored),
      feeProration: 'none',
    },
  });
  refused(
    advancePlan({ source: 'use', components: [whole(termFee(advance))] }),
    'a fee term with feeProration none',
  );
  const use = advancePlan({
    source: 'use',
    components: [whole(feeComponent('rent', 'rent', advance))],
  }) as { bindings: { arrearsSource: Record<string, unknown> } };
  use.bindings.arrearsSource.earlyReturn = {
    bill: 'actualEnd',
    minimumTerm: threeMonths,
  };
  refused(
    use,
    'the early-return term on an advance fee with feeProration none',
  );
});

test('B2 minimum: a fee term still binds on cycles opening between the return and a held agreed end (review finding 1)', () => {
  // E1m with earlyReturn agreedEnd and an agreed end of Aug 20: returned
  // Jul 12, the service is held to Aug 20, so August opens after the return
  // and must still owe the term (300.00, not 183.87). Total 900.00.
  const planInput = advancePlan({
    source: 'use',
    components: [termFee(advance)],
  }) as { bindings: { arrearsSource: Record<string, unknown> } };
  const earlyReturn = { bill: 'agreedEnd' } as const;
  planInput.bindings.arrearsSource.earlyReturn = earlyReturn;
  const asOf = '2027-09-15T06:00:00.000Z';
  const lines = reviewLines(
    reviewArrearsCharges(
      compileRatePlan(planInput).plan,
      {
        ...e1Evidence(planInput, asOf, '2027-08-20T06:00:00.000Z'),
        bands: [],
      },
      {
        snapshot: e1Snapshot(e1Return, asOf),
        subjectId: subject,
        owner,
        earlyReturn,
      },
    ),
  );
  assert.deepEqual(lines, [
    ['rent', e1Start, '21000'],
    ['rent', july, '30000'],
    ['rent', august, '30000'],
    ['rent', september, '9000'],
  ]);
});

test('B2: a use leg cannot carry the reserved committed identity (review finding 2)', () => {
  const snapshot = e1Snapshot(e1Return, '2027-09-15T06:00:00.000Z');
  const engagement = snapshot.engagements[0]!;
  const forged = {
    ...snapshot,
    engagements: [
      {
        ...engagement,
        legs: engagement.legs.map((leg) => ({
          ...leg,
          id: JSON.stringify(['committed', engagement.id]),
        })),
      },
    ],
  };
  assert.throws(
    () =>
      serviceUseCoverage(
        { snapshot: forged, subjectId: subject, owner },
        'each',
        '2027-09-15T06:00:00.000Z',
        e1Return,
      ),
    /reserved identity/,
  );
});
