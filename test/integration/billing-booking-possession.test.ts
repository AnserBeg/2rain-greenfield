import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dueArrearsCycle,
  reviewArrearsCharges,
} from '../../packages/domain/src/billing/arrears.js';
import { compileRatePlan } from '../../packages/domain/src/billing/terms.js';
import type { BillingQuoteEvidence } from '../../packages/canonical-model/src/billing-evidence.js';
import {
  billingBookingUsage,
  bookingPossessionServiceEnd,
  truncateBookingInstant,
} from '../../packages/postgres-provider/src/billing-booking-usage.js';

// Booking stamps clock_timestamp() in microseconds and renders it with an
// offset. These are the shapes production Booking writes, not whole seconds.
const day = 86_400_000;
const anchor = '2025-01-28T16:00:00.000Z';
const at = (days: number, micros = '482913') =>
  new Date(Date.parse(anchor) + day * days)
    .toISOString()
    .replace(/\.\d{3}Z$/u, `.${micros}+00:00`);
const owner = {
  entityId: 'example:entity.hire',
  recordId: 'hire-1',
  companyId: 'company-a',
};
const slotId = 'example:slot.equipment';

function snapshot(
  legs: readonly (readonly [string, string | null])[],
  pauses: readonly (readonly [string, string | null])[] = [],
) {
  const row = (
    kind: 'use' | 'pause',
    index: number,
    [start, end]: readonly [string, string | null],
  ) => ({
    id: `${kind}-${String(index)}`,
    bookingId: 'booking-1',
    revision: 1,
    kind,
    voided: false,
    effectiveStart: start,
    effectiveEnd: end,
    quantity: kind === 'use' ? '1' : null,
    unit: kind === 'use' ? 'each' : null,
  });
  return {
    schemaVersion: 'booking.ownerUsage/v1',
    ownerRef: { entityId: owner.entityId, recordId: owner.recordId },
    ownerScope: { kind: 'company', companyId: owner.companyId },
    asOf: at(20),
    cursor: '4',
    highWater: '4',
    hasMore: false,
    changes: [],
    bookings: [
      {
        bookingId: 'booking-1',
        slotId,
        fulfilmentMode: 'tracked',
        unit: 'each',
      },
    ],
    evidence: [
      ...legs.map((leg, i) => row('use', i, leg)),
      ...pauses.map((pause, i) => row('pause', i, pause)),
    ],
  };
}

const { plan } = compileRatePlan({
  schemaVersion: 'v6',
  id: 'hire',
  version: '1',
  currency: 'CAD',
  serviceUnit: 'each',
  slots: [{ id: 'daily', kind: 'money', currency: 'CAD', scale: 2 }],
  components: [
    {
      kind: 'time',
      id: 'time',
      base: 'serviceInterval',
      stage: 'beforeMinimum',
      taxClassification: 'untaxed',
      rates: { day: 'daily' },
    },
  ],
  schedule: { kind: 'fixedDays', days: 10 },
});

function agreedEvidence(agreedEnd: string | null): BillingQuoteEvidence {
  return {
    schemaVersion: 'northstar.billing-quote-evidence/v1',
    release: 'release',
    sourceQueryId: 'query',
    sourceRevision: '1',
    cursor: '1',
    serviceId: owner.recordId,
    companyId: owner.companyId,
    tenantId: 'tenant',
    environmentId: 'environment',
    customerId: 'customer',
    serviceUnit: 'each',
    currency: 'CAD',
    anchor,
    zone: 'America/Edmonton',
    asOf: new Date(Date.parse(anchor) + day * 20).toISOString(),
    periodStart: anchor,
    serviceEnd: agreedEnd,
    basis: 'agreed',
    bands: [],
    usage: [],
    pauses: [],
    assignments: [],
    allocations: [],
    tables: [
      {
        schemaVersion: 'northstar.billing-rate-table/v1',
        publishedAt: '2020-01-01T00:00:00.000Z',
        version: 't1',
        planDigest: compileRatePlan(plan).digest,
        currency: 'CAD',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
        selector: { kind: 'base' },
        values: { daily: '30' },
      },
    ],
  } as unknown as BillingQuoteEvidence;
}

// The production order in the released quote query: possession sets the
// service end, the cycle follows, then the adapter supplies the actuals.
function review(value: unknown, agreedEnd: string | null) {
  const evidence = agreedEvidence(agreedEnd);
  evidence.serviceEnd = bookingPossessionServiceEnd(value, slotId, agreedEnd);
  const cycle = dueArrearsCycle(plan, evidence);
  if (!cycle) return { status: 'notDue' as const, evidence };
  Object.assign(
    evidence,
    billingBookingUsage(value, owner, slotId, 'each', cycle.end),
  );
  const result = reviewArrearsCharges(plan, evidence);
  assert.ok(result.status === 'due');
  return {
    status: result.status,
    cycle: result.cycle,
    cents: result.quote.lines.reduce(
      (sum, line) => sum + BigInt(line.differenceCents),
      0n,
    ),
    evidence,
  };
}

test('Booking microsecond instants truncate toward the past to the Billing millisecond', () => {
  assert.equal(
    truncateBookingInstant('2025-02-11T17:03:12.482913+00:00'),
    '2025-02-11T17:03:12.482Z',
  );
  assert.equal(
    truncateBookingInstant('2025-02-11T10:03:12.999999-07:00'),
    '2025-02-11T17:03:12.999Z',
  );
  assert.equal(
    truncateBookingInstant('2025-02-11T17:03:12+00:00'),
    '2025-02-11T17:03:12.000Z',
  );
  const usage = billingBookingUsage(
    snapshot([[at(0), at(3, '105338')]]),
    owner,
    slotId,
    'each',
    at(10),
  );
  assert.deepEqual(
    usage.bands[0]!.intervals.map((i) => [i.start, i.end]),
    [
      [
        new Date(Date.parse(anchor)).toISOString().replace('.000Z', '.482Z'),
        new Date(Date.parse(anchor) + day * 3)
          .toISOString()
          .replace('.000Z', '.105Z'),
      ],
    ],
  );
});

test('a pause shorter than a millisecond collapses to an empty span and the hire still reviews', () => {
  const pause = [at(2, '482913'), at(2, '482999')] as const;
  const collapsed = review(snapshot([[at(0), at(9)]], [pause]), at(5));
  assert.equal(collapsed.status, 'due');
  assert.deepEqual(
    collapsed.evidence.pauses.map((p) => p.end === p.start),
    [true],
  );
  assert.equal(
    collapsed.cents,
    review(snapshot([[at(0), at(9)]]), at(5)).cents,
  );
});

test('possession past the agreed end bills through the recorded return', () => {
  // Agreed five days, returned on day nine, CAD 30 a day.
  const overrun = review(snapshot([[at(0), at(9)]]), at(5));
  assert.equal(overrun.status, 'due');
  assert.deepEqual(overrun.cycle, {
    start: anchor,
    end: truncateBookingInstant(at(9)),
  });
  assert.equal(overrun.cents, 27_000n);
});

test('a live use leg past the agreed end keeps earning completed cycles', () => {
  const live = review(snapshot([[at(0), null]]), at(5));
  assert.equal(live.status, 'due');
  assert.equal(live.evidence.serviceEnd, null);
  assert.deepEqual(live.cycle, {
    start: anchor,
    end: new Date(Date.parse(anchor) + day * 10).toISOString(),
  });
  // Ten full days less the 482 ms before the start, rounded to the cent.
  assert.equal(live.cents, 30_000n);
});

test('an early return keeps the agreed end and a hire without use falls back to it', () => {
  assert.equal(
    bookingPossessionServiceEnd(snapshot([[at(0), at(3)]]), slotId, at(5)),
    truncateBookingInstant(at(5)),
  );
  const early = review(snapshot([[at(0), at(3)]]), at(5));
  assert.equal(early.status, 'due');
  assert.equal(early.cents, 9_000n);
  assert.equal(bookingPossessionServiceEnd(snapshot([]), slotId, at(5)), at(5));
  assert.equal(
    bookingPossessionServiceEnd(snapshot([[at(0), at(9)]]), 'other', at(5)),
    at(5),
  );
  assert.equal(
    bookingPossessionServiceEnd(snapshot([[at(0), at(9)]]), slotId, null),
    new Date(Date.parse(anchor) + day * 9)
      .toISOString()
      .replace('.000Z', '.482Z'),
  );
});
