import {
  BILLING_CALCULATION_VERSION,
  type BillingPlan,
} from '../../../canonical-model/src/billing.js';
import {
  BillingQuoteEvidenceSchema,
  type BillingQuoteEvidence,
} from '../../../canonical-model/src/billing-evidence.js';
import {
  BillingCalendar,
  covered,
  exclude,
  instant,
  iso,
  union,
  type CalendarPin,
  type Span,
} from './calendar.js';
import {
  bestCover,
  durationFloor,
  timeline,
  type CoverBlock,
} from './cover.js';
import { decimal, Fraction, integer, one, zero } from './fraction.js';
import { occurrences, pricingWindows, type Occurrence } from './occurrences.js';
import {
  compileRatePlan,
  digest,
  publishRateTable,
  selectTable,
} from './terms.js';

function distinct(ids: readonly string[], kind: string) {
  if (new Set(ids).size !== ids.length)
    throw new Error('Ambiguous ' + kind + ' identity');
}
function deriveCoverage(
  e: BillingQuoteEvidence,
  anchor: number,
  through: number,
) {
  const span = (s: { start: string; end: string | null }): Span => {
    const start = instant(s.start),
      end = s.end ? instant(s.end) : Math.max(start, through);
    if (end < start) throw new Error('Reversed billing interval');
    return { start: Math.max(start, anchor), end: Math.min(end, through) };
  };
  distinct(
    e.bands.map((b) => b.id),
    'quantity band',
  );
  distinct(
    e.bands.flatMap((b) => b.intervals.map((s) => s.id)),
    'source interval',
  );
  distinct(
    e.pauses.map((p) => p.id),
    'pause',
  );
  const bandIds = new Set(e.bands.map((b) => b.id));
  for (const p of [...e.pauses, ...e.usage])
    if (p.bandId && !bandIds.has(p.bandId))
      throw new Error('Missing commercial quantity allocation');
  if (e.basis === 'usageOnly' && e.bands.length)
    throw new Error('Unexpected quantity band on usage-only service');
  const bands = e.bands.map((b) => {
    const spans = b.intervals
      .map(span)
      .filter((s) => s.end > s.start)
      .sort((a, b) => a.start - b.start);
    if (spans.some((s, i) => i > 0 && s.start < spans[i - 1]!.end))
      throw new Error('Ambiguous overlapping quantity legs');
    if (!decimal(b.quantity).n) throw new Error('Empty billing quantity');
    const pauses = union(
      e.pauses.filter((p) => !p.bandId || p.bandId === b.id).map(span),
    );
    return {
      id: b.id,
      quantity: decimal(b.quantity),
      eligible: union(spans),
      active: exclude(union(spans), pauses),
      pauses,
    };
  });
  const eligible =
    e.basis === 'usageOnly'
      ? [{ start: anchor, end: through }]
      : union(bands.flatMap((b) => b.eligible));
  const active =
    e.basis === 'usageOnly'
      ? exclude(eligible, union(e.pauses.map(span)))
      : union(bands.flatMap((b) => b.active));
  return { bands, eligible, active };
}
interface Line {
  componentId: string;
  occurrence: string;
  servicePeriodStart: string;
  servicePeriodEnd: string;
  currency: string;
  taxClassification: string;
  entitlementCents: string;
  allocatedCents: string;
  reservedCents: string;
  differenceCents: string;
  derivation: readonly unknown[];
}
const occurrenceId = (...parts: string[]) => JSON.stringify(parts);
export function quoteBillingService(
  planInput: unknown,
  evidenceInput: unknown,
) {
  return calculate(planInput, evidenceInput);
}
export function replayBillingQuote(
  quote: ReturnType<typeof quoteBillingService>,
) {
  const replay = calculate(
    quote.inputs.plan,
    quote.inputs.evidence,
    quote.calendar,
  );
  if (
    replay.inputDigest !== quote.inputDigest ||
    replay.resultDigest !== quote.resultDigest
  )
    throw new Error('Billing replay digest mismatch');
  return replay;
}
function calculate(
  planInput: unknown,
  evidenceInput: unknown,
  pinned?: CalendarPin,
) {
  const { plan, digest: planDigest } = compileRatePlan(planInput);
  const e = BillingQuoteEvidenceSchema.parse(evidenceInput);
  if (e.currency !== plan.currency || e.serviceUnit !== plan.serviceUnit)
    throw new Error('Incompatible service currency or unit');
  distinct(
    e.tables.map((t) => t.version),
    'rate version',
  );
  const tables = e.tables.map((t) => publishRateTable(plan, t).table);
  distinct(
    e.usage.map((u) => occurrenceId(u.streamId, u.id)),
    'usage event',
  );
  for (const a of e.assignments)
    if (a.effectiveEnd && instant(a.effectiveEnd) <= instant(a.effectiveFrom))
      throw new Error('Empty assignment interval');
  const anchor = instant(e.anchor),
    asOf = instant(e.asOf),
    serviceEnd = e.serviceEnd === null ? null : instant(e.serviceEnd);
  const through = Math.min(serviceEnd ?? asOf, asOf),
    periodStart = instant(e.periodStart);
  if (through - anchor > 3660 * 86_400_000)
    throw new Error('Billing service exceeds the calendar horizon');
  if (through <= anchor || periodStart < anchor || periodStart >= through)
    throw new Error('Invalid billing prefix');
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  e.bands.sort((a, b) => order(a.id, b.id));
  for (const b of e.bands) b.intervals.sort((a, b) => order(a.id, b.id));
  e.pauses.sort((a, b) => order(a.id, b.id));
  e.usage.sort((a, b) => order(a.streamId, b.streamId) || order(a.id, b.id));
  e.tables.sort((a, b) => order(a.version, b.version));
  e.assignments.sort(
    (a, b) => order(a.listId, b.listId) || order(a.revision, b.revision),
  );
  e.allocations.sort(
    (a, b) =>
      order(a.componentId, b.componentId) || order(a.occurrence, b.occurrence),
  );
  const calendar = new BillingCalendar(anchor, e.zone, pinned),
    coverage = deriveCoverage(e, anchor, through);
  const windows = pricingWindows(
    calendar,
    plan.pricingWindow,
    through,
    serviceEnd,
  );
  const prices = new Map<number, ReturnType<typeof selectTable>>();
  function terms(at: number) {
    let selection = prices.get(at);
    if (!selection) {
      selection = selectTable(tables, e.customerId, e.assignments, at);
      prices.set(at, selection);
    }
    return selection;
  }
  const allocations = new Map(
    e.allocations.map((a) => [occurrenceId(a.componentId, a.occurrence), a]),
  );
  if (allocations.size !== e.allocations.length)
    throw new Error('Duplicate prior allocation');
  const lines: Line[] = [];
  function line(
    c: BillingPlan['components'][number],
    occurrence: string,
    start: number,
    end: number,
    earned: Fraction,
    derivation: readonly unknown[],
  ) {
    const key = occurrenceId(c.id, occurrence),
      prior = allocations.get(key);
    allocations.delete(key);
    const cents = earned.cents(),
      allocated = prior?.allocatedCents ?? '0',
      reserved = prior?.reservedCents ?? '0';
    lines.push({
      componentId: c.id,
      occurrence,
      servicePeriodStart: iso(start),
      servicePeriodEnd: iso(end),
      currency: plan.currency,
      taxClassification: c.taxClassification,
      entitlementCents: String(cents),
      allocatedCents: allocated,
      reservedCents: reserved,
      differenceCents: String(cents - BigInt(allocated) - BigInt(reserved)),
      derivation,
    });
  }
  const budget = { remaining: 100000 };
  const winning = new Map<
    string,
    { quantity: Fraction; blocks: CoverBlock[] }[]
  >();
  for (const c of plan.components.filter((c) => c.kind === 'time')) {
    if (e.basis === 'usageOnly')
      throw new Error('Time component requires service intervals');
    for (const band of coverage.bands) {
      let total = zero,
        enrollmentFloor: Fraction | null = null;
      const trace = [];
      for (const w of windows) {
        const segments = timeline(calendar, w.day, w.next, band.active);
        if (!segments.length) continue;
        const t = terms(w.start).table,
          values = t.values;
        const cover = bestCover(segments, w.monthDays, c, values, budget);
        const cap = c.cap ? decimal(values[c.cap]!) : null;
        const floor = durationFloor(
          calendar,
          w.day,
          w.next,
          w.monthDays,
          c,
          values,
          budget,
        );
        if (enrollmentFloor === null)
          enrollmentFloor = cap ? floor.min(cap) : floor;
        const gross =
          c.minimumScope === 'perPricingWindow'
            ? cover.price.max(floor)
            : cover.price;
        const net = cap ? gross.min(cap) : gross;
        total = total.plus(net);
        const blockKey = occurrenceId(c.id, iso(w.start));
        const grants = winning.get(blockKey) ?? [];
        grants.push({ quantity: band.quantity, blocks: cover.blocks });
        winning.set(blockKey, grants);
        trace.push({
          start: iso(w.start),
          end: iso(w.end),
          windowEnd: iso(w.fullEnd),
          rateVersion: t.version,
          raw: cover.price.toString(),
          floor: floor.toString(),
          cap: cap?.toString() ?? null,
          capped: net.toString(),
          quantity: band.quantity.toString(),
          blocks: cover.blocks.map((b) => ({
            period: b.period,
            price: b.price.toString(),
            covered: b.covered.toString(),
          })),
        });
      }
      if (c.minimumScope === 'perEnrollment' && enrollmentFloor)
        total = total.max(enrollmentFloor);
      line(
        c,
        occurrenceId('time', band.id),
        periodStart,
        through,
        total.times(band.quantity),
        trace,
      );
    }
  }
  const cycles = occurrences(calendar, plan.schedule, through, serviceEnd);
  for (const c of plan.components) {
    if (c.kind === 'fixed') {
      const fee = c.occurrence;
      if (fee.kind === 'oneOff') {
        const period = fee.at === 'serviceStart' ? cycles[0] : cycles.at(-1);
        if (!period || (fee.at === 'serviceEnd' && through !== serviceEnd))
          continue;
        const t = terms(period.start).table;
        line(
          c,
          occurrenceId(fee.at),
          period.start,
          period.end,
          decimal(t.values[c.amount]!),
          [{ rateVersion: t.version, at: fee.at }],
        );
        continue;
      }
      for (const o of occurrences(
        calendar,
        fee.cadence,
        through,
        serviceEnd,
      ).filter((o) => o.closed)) {
        const ms = covered(
          fee.fixedFeeDuringPause === 'suspend'
            ? coverage.active
            : coverage.eligible,
          o.start,
          o.end,
        );
        const fraction = prorate(ms, o, fee.feeProration),
          t = terms(o.start).table;
        line(
          c,
          occurrenceId('fee', iso(o.fullStart)),
          o.start,
          o.end,
          decimal(t.values[c.amount]!).times(fraction),
          [
            {
              rateVersion: t.version,
              eligibleMs: ms,
              basisMs: o.fullEnd - o.fullStart,
              fraction: fraction.toString(),
            },
          ],
        );
      }
    } else if (c.kind === 'meter') {
      const basis = c.allowanceBasis,
        periods = basis.kind === 'perCycle' ? cycles : windows;
      const events = e.usage
        .filter((u) => u.streamId === c.streamId)
        .map((u) => {
          if (u.unit !== c.unit) throw new Error('Incompatible meter unit');
          const at = instant(u.at);
          const matching = coverage.bands.filter((b) =>
            b.eligible.some((s) => s.start <= at && at < s.end),
          );
          if (
            !u.bandId &&
            matching.length > 1 &&
            matching.some((b) =>
              b.active.some((s) => s.start <= at && at < s.end),
            ) &&
            matching.some(
              (b) => !b.active.some((s) => s.start <= at && at < s.end),
            )
          )
            throw new Error('Ambiguous meter pause allocation');
          const active = u.bandId
            ? coverage.bands.find((b) => b.id === u.bandId)!.active
            : coverage.active;
          return {
            ...u,
            at,
            active: active.some((s) => s.start <= at && at < s.end),
          };
        });
      for (const o of periods.filter((o) => o.closed)) {
        const t = terms(o.start).table;
        const fraction = prorate(
          covered(coverage.active, o.start, o.end),
          o,
          c.allowanceProration,
        );
        let allowance = zero;
        if (basis.kind === 'perBilledPeriod') {
          for (const { quantity, blocks } of winning.get(
            occurrenceId(basis.timeComponent, iso(o.start)),
          ) ?? [])
            for (const b of blocks)
              allowance = allowance.plus(
                decimal(t.values[basis.quantities[b.period]!]!)
                  .times(quantity)
                  .times(c.allowanceProration === 'none' ? one : b.covered),
              );
        } else allowance = decimal(t.values[basis.quantity]!).times(fraction);
        const used = events.filter(
          (u) => u.active && o.start <= u.at && u.at < o.end,
        );
        const usage = used.reduce((v, u) => v.plus(decimal(u.quantity)), zero);
        const overage = usage.minus(allowance).max(zero),
          rate = decimal(t.values[c.overageRate]!);
        line(
          c,
          occurrenceId('meter', iso(o.fullStart)),
          o.start,
          o.end,
          overage.times(rate),
          [
            {
              rateVersion: t.version,
              basis: basis.kind,
              fraction: fraction.toString(),
              usage: usage.toString(),
              allowance: allowance.toString(),
              overage: overage.toString(),
              rate: rate.toString(),
            },
          ],
        );
      }
    }
  }
  if (allocations.size)
    throw new Error(
      'Prior allocation has no matching occurrence or quantity band',
    );
  const result = {
    algorithm: BILLING_CALCULATION_VERSION,
    planDigest,
    lines,
    coverage: coverage.bands.map((b) => ({
      band: b.id,
      active: b.active,
      excludedPauses: b.pauses,
    })),
    calendar: {
      zone: e.zone,
      zoneData: pinned?.zoneData ?? process.versions.tz!,
      boundaries: calendar.boundaries,
    },
    terms: [...prices.entries()]
      .sort(([a], [b]) => a - b)
      .map(([at, s]) => ({
        opening: iso(at),
        tableDigest: digest(s.table),
        version: s.table.version,
        assignment: s.assignment,
      })),
  };
  return {
    ...result,
    inputs: { plan, evidence: e },
    inputDigest: digest({ plan, evidence: e }),
    resultDigest: digest(result),
  };
}
function prorate(ms: number, o: Occurrence, policy: 'none' | 'activeCoverage') {
  return policy === 'none'
    ? ms > 0
      ? one
      : zero
    : integer(ms).over(integer(o.fullEnd - o.fullStart));
}
