import {
  BILLING_CALCULATION_VERSION,
  BILLING_CYCLE_CALCULATION,
  BILLING_RULES_CALCULATION,
  BILLING_TIMING_CALCULATION,
  hasBillingRules,
  hasBillingV5Keys,
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
  capValue,
  durationFloor,
  priceCover,
  timeline,
  type CoverBlock,
} from './cover.js';
import { decimal, type Fraction, integer, one, zero } from './fraction.js';
import {
  bindingTerm,
  occurrences,
  owedAdvanceOccurrences,
  pricingWindows,
  type Occurrence,
} from './occurrences.js';
import { committedIntervalId } from './service-use.js';
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
export interface BillingQuoteLine {
  componentId: string;
  occurrence: string;
  servicePeriodStart: string;
  servicePeriodEnd: string;
  currency: string;
  taxClassification: string;
  exactEntitlement: string;
  rounding: 'halfUp';
  entitlementCents: string;
  allocatedCents: string;
  reservedCents: string;
  differenceCents: string;
  derivation: readonly unknown[];
  /** B13 (calculation v5): present only on a discounted line. The line's
   * entitlement is the net; gross = net + discount exactly in cents. */
  discount?: {
    kind: 'percent';
    reason: string;
    rate?: string;
    rateVersion?: string;
    grossExact: string;
    discountExact: string;
    grossCents: string;
    discountCents: string;
  };
}
const occurrenceId = (...parts: string[]) => JSON.stringify(parts);
type Component = BillingPlan['components'][number];
/** B2: a recurring fixed fee declared in advance (calculation v5). */
export function isAdvanceFee(c: Component): c is Extract<
  Component,
  { kind: 'fixed' }
> & {
  occurrence: Extract<
    Extract<Component, { kind: 'fixed' }>['occurrence'],
    { kind: 'recurring' }
  >;
} {
  return (
    c.kind === 'fixed' &&
    c.occurrence.kind === 'recurring' &&
    c.timing?.when === 'advance'
  );
}
/** The newest calculation a plan's declared keys require. */
function planCalculation<T extends CalculationVersion>(
  plan: unknown,
  otherwise: T,
) {
  return hasBillingV5Keys(plan)
    ? BILLING_TIMING_CALCULATION
    : hasBillingRules(plan)
      ? BILLING_RULES_CALCULATION
      : otherwise;
}
const legacyCalculation = 'northstar.billing-calculation/v1';
type CalculationVersion =
  | typeof legacyCalculation
  | typeof BILLING_CALCULATION_VERSION
  | typeof BILLING_CYCLE_CALCULATION
  | typeof BILLING_RULES_CALCULATION
  | typeof BILLING_TIMING_CALCULATION;

function termPin(at: number, selection: ReturnType<typeof selectTable>) {
  const { publishedAt, ...table } = selection.table;
  return {
    opening: iso(at),
    publishedAt,
    tableDigest: digest(table),
    version: table.version,
    assignment: selection.assignment,
  };
}

export function quoteBillingService(
  planInput: unknown,
  evidenceInput: unknown,
) {
  return calculate(
    planInput,
    evidenceInput,
    undefined,
    planCalculation(planInput, BILLING_CALCULATION_VERSION),
  );
}

export function quoteBillingCycle(
  plan: BillingPlan,
  evidence: BillingQuoteEvidence,
  through: string,
) {
  return calculate(
    plan,
    { ...evidence, coverageThrough: through },
    undefined,
    planCalculation(plan, BILLING_CYCLE_CALCULATION),
  );
}
export function replayBillingQuote(
  quote: ReturnType<typeof quoteBillingService>,
) {
  const replay = calculate(
    quote.inputs.plan,
    quote.inputs.evidence,
    quote.calendar,
    quote.algorithm,
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
  algorithm: CalculationVersion = BILLING_CALCULATION_VERSION,
) {
  const { plan, digest: planDigest } = compileRatePlan(planInput);
  const e = BillingQuoteEvidenceSchema.parse(evidenceInput);
  if (e.currency !== plan.currency || e.serviceUnit !== plan.serviceUnit)
    throw new Error('Incompatible service currency or unit');
  distinct(
    e.tables.map((t) => t.version),
    'rate version',
  );
  const tables = e.tables.map(({ publishedAt, ...t }) => ({
    publishedAt,
    ...publishRateTable(plan, t).table,
  }));
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
  // Calculation v4 rates the rule keys in either mode; a plan without them
  // keeps the version it was first quoted under.
  const cycle = e.coverageThrough !== undefined;
  if (
    algorithm === BILLING_RULES_CALCULATION ||
    algorithm === BILLING_TIMING_CALCULATION
      ? false
      : (algorithm === BILLING_CYCLE_CALCULATION) !== cycle
  )
    throw new Error('Billing cycle requires its coverage boundary');
  // Calculation v5 rates timing and the pricing keys beside any rule key; v4
  // only rule keys.
  const timed = hasBillingV5Keys(plan);
  if (timed !== (algorithm === BILLING_TIMING_CALCULATION))
    throw new Error('Billing timing requires calculation v5');
  if (
    !timed &&
    hasBillingRules(plan) !== (algorithm === BILLING_RULES_CALCULATION)
  )
    throw new Error('Billing rate rules require calculation v4');
  const advance = plan.components.filter(isAdvanceFee);
  if (advance.length && (!cycle || e.agreedEnd === undefined))
    throw new Error(
      'Advance billing requires a cycle review and its agreed end',
    );
  const coverageThrough = e.coverageThrough ? instant(e.coverageThrough) : asOf;
  if (coverageThrough > asOf)
    throw new Error('Billing coverage is not delivered');
  const through = Math.min(serviceEnd ?? asOf, coverageThrough),
    periodStart = instant(e.periodStart);
  if (through - anchor > 3660 * 86_400_000)
    throw new Error('Billing service exceeds the calendar horizon');
  // An advance review may owe opened cycles before any cycle has closed; its
  // arrears prefix is then empty and only advance fees are rated.
  const advanceOnly = advance.length > 0 && through === periodStart;
  if (
    advanceOnly
      ? periodStart < anchor
      : through <= anchor || periodStart < anchor || periodStart >= through
  )
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
  const termPins = new Map(
    e.termPins?.map((pin) => [instant(pin.opening), pin]),
  );
  if (e.termPins) {
    if (termPins.size !== e.termPins.length)
      throw new Error('Duplicate billing term pin');
    e.termPins.sort((a, b) => order(a.opening, b.opening));
  }
  if (
    algorithm !== legacyCalculation &&
    !termPins.size &&
    e.allocations.some(
      (a) => a.allocatedCents !== '0' || a.reservedCents !== '0',
    )
  )
    throw new Error('Prior allocation requires pinned billing terms');
  if (
    e.periodMeter &&
    (!cycle ||
      e.basis !== 'usageOnly' ||
      e.usage.length ||
      e.pauses.length ||
      e.periodMeter.opening.at !== e.periodStart ||
      e.periodMeter.closing.at !== e.coverageThrough ||
      !plan.components.some((c) => c.kind === 'meter') ||
      plan.components.some(
        (c) =>
          c.kind === 'meter' &&
          (c.streamId !== e.periodMeter!.streamId ||
            c.unit !== e.periodMeter!.unit ||
            c.allowanceBasis.kind !== 'perCycle'),
      ))
  )
    throw new Error(
      'Billing requires complete boundary readings for one unpaused meter cycle',
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
      const pin = termPins.get(at);
      const publishedThrough = algorithm === legacyCalculation ? at : asOf;
      if (pin) {
        const table = tables.find((t) => t.version === pin.version);
        const assignments = pin.assignment
          ? e.assignments.filter(
              (a) =>
                a.listId === pin.assignment!.listId &&
                a.revision === pin.assignment!.revision,
            )
          : [];
        selection = selectTable(
          table ? [table] : [],
          e.customerId,
          assignments,
          at,
          publishedThrough,
        );
        if (digest(termPin(at, selection)) !== digest(pin))
          throw new Error('Pinned billing terms disagree');
      } else {
        selection = selectTable(
          tables,
          e.customerId,
          e.assignments,
          at,
          publishedThrough,
        );
      }
      termPins.set(at, termPin(at, selection));
      prices.set(at, selection);
    }
    return selection;
  }
  const allocations = new Map(
    e.allocations.map((a) => [occurrenceId(a.componentId, a.occurrence), a]),
  );
  if (allocations.size !== e.allocations.length)
    throw new Error('Duplicate prior allocation');
  const lines: BillingQuoteLine[] = [];
  // Each rated line's exact gross and net, for percentage components, which
  // are rated after their base although components sort by id.
  const rated: {
    componentId: string;
    occurrence: string;
    start: number;
    end: number;
    opening: number;
    gross: Fraction;
    net: Fraction;
  }[] = [];
  const hundred = integer(100);
  /** The share a percent discount keeps, under one table's values. */
  const kept = (c: Component, values: Readonly<Record<string, string>>) =>
    'discount' in c && c.discount
      ? one.minus(decimal(values[c.discount.rate]!).over(hundred))
      : one;
  function line(
    c: BillingPlan['components'][number],
    occurrence: string,
    start: number,
    end: number,
    gross: Fraction,
    derivation: readonly unknown[],
    // The opening whose terms rated the line, and the net when the caller
    // discounted it window by window (time); otherwise the table discounts.
    priced: {
      opening: number;
      table?: { version: string; values: Readonly<Record<string, string>> };
      net?: Fraction;
    },
  ) {
    const key = occurrenceId(c.id, occurrence),
      prior = allocations.get(key);
    allocations.delete(key);
    const off = 'discount' in c ? c.discount : undefined;
    const earned =
      priced.net ?? (off ? gross.times(kept(c, priced.table!.values)) : gross);
    rated.push({
      componentId: c.id,
      occurrence,
      start,
      end,
      opening: priced.opening,
      gross,
      net: earned,
    });
    const cents = earned.cents(),
      allocated = prior?.allocatedCents ?? '0',
      reserved = prior?.reservedCents ?? '0';
    const grossCents = gross.cents();
    lines.push({
      componentId: c.id,
      occurrence,
      servicePeriodStart: iso(start),
      servicePeriodEnd: iso(end),
      currency: plan.currency,
      taxClassification: c.taxClassification,
      exactEntitlement: earned.toString(),
      rounding: 'halfUp',
      entitlementCents: String(cents),
      allocatedCents: allocated,
      reservedCents: reserved,
      differenceCents: String(cents - BigInt(allocated) - BigInt(reserved)),
      derivation,
      ...(off && {
        discount: {
          kind: off.kind,
          reason: off.reason,
          ...(priced.table &&
            priced.net === undefined && {
              rate: priced.table.values[off.rate]!,
              rateVersion: priced.table.version,
            }),
          grossExact: gross.toString(),
          discountExact: gross.minus(earned).toString(),
          grossCents: String(grossCents),
          discountCents: String(grossCents - cents),
        },
      }),
    });
  }
  const budget = { remaining: 100000 };
  const winning = new Map<
    string,
    { quantity: Fraction; blocks: CoverBlock[] }[]
  >();
  for (const c of advanceOnly
    ? []
    : plan.components.filter((c) => c.kind === 'time')) {
    if (e.basis === 'usageOnly')
      throw new Error('Time component requires service intervals');
    for (const band of coverage.bands) {
      // Gross and net run side by side: the net discounts each window's
      // capped amount at that window's rate, and the enrollment floor at the
      // first positive window's rate (B13: after the minimum and the cap).
      let total = zero,
        totalNet = zero,
        enrollmentFloor: Fraction | null = null,
        floorKept = one,
        opening: number | null = null;
      const trace = [];
      for (const w of windows) {
        const segments = timeline(calendar, w.day, w.next, band.active);
        if (!segments.length) continue;
        const t = terms(w.start).table,
          values = t.values;
        const cover = priceCover(segments, w.monthDays, c, values, budget);
        const cap = capValue(c, values);
        const floor: Fraction =
          c.minimumScope === 'perEnrollment' && enrollmentFloor !== null
            ? zero
            : durationFloor(
                calendar,
                w.day,
                w.next,
                w.monthDays,
                c,
                values,
                budget,
              );
        const keep = kept(c, values);
        if (enrollmentFloor === null) {
          enrollmentFloor = cap ? floor.min(cap) : floor;
          floorKept = keep;
          opening = w.start;
        }
        const gross =
          c.minimumScope === 'perPricingWindow'
            ? cover.price.max(floor)
            : cover.price;
        const net = cap ? gross.min(cap) : gross;
        total = total.plus(net);
        totalNet = totalNet.plus(net.times(keep));
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
          ...(c.discount && { discountRate: values[c.discount.rate] }),
          quantity: band.quantity.toString(),
          blocks: cover.blocks.map((b) => ({
            period: b.period,
            price: b.price.toString(),
            covered: b.covered.toString(),
          })),
        });
      }
      if (c.minimumScope === 'perEnrollment' && enrollmentFloor) {
        total = total.max(enrollmentFloor);
        totalNet = totalNet.max(enrollmentFloor.times(floorKept));
      }
      line(
        c,
        occurrenceId('time', band.id),
        periodStart,
        through,
        total.times(band.quantity),
        trace,
        {
          opening: opening ?? anchor,
          ...(c.discount && { net: totalNet.times(band.quantity) }),
        },
      );
    }
  }
  const cycles = occurrences(calendar, plan.schedule, through, serviceEnd);
  // Advance horizon (B2): the agreed interval is billed whole for each opened
  // cycle, never clipped to the review instant, together with any actual use
  // through it (an overrun past the agreed end is billed on top). An early
  // end never reduces an opened cycle (keepPaidPeriod).
  const agreedEnd =
    e.agreedEnd === null || e.agreedEnd === undefined
      ? Number.POSITIVE_INFINITY
      : instant(e.agreedEnd);
  const advanceCoverage = advance.length
    ? union([
        { start: anchor, end: agreedEnd },
        ...deriveCoverage(e, anchor, Math.min(serviceEnd ?? asOf, asOf))
          .eligible,
      ])
    : [];
  // A declared early-return rule can hold the service end past the last
  // return (its minimum term, or the agreed end): the committed interval
  // from the return to that end. A cycle that opens after the return is owed
  // only because of that hold, so it is rated on the committed interval
  // alone, never on the agreed interval (ruling 2026-11-28: a minimum term is
  // charged exactly, prorated, never more).
  const committed = advance.length
    ? union(
        e.bands.flatMap((b) =>
          b.intervals
            .filter((s) => s.id === committedIntervalId(b.id) && s.end)
            .map((s) => ({ start: instant(s.start), end: instant(s.end!) })),
        ),
      )
    : [];
  const committedFrom = committed[0]?.start ?? Number.POSITIVE_INFINITY;
  for (const c of advanceOnly ? advance : plan.components) {
    if (c.kind === 'fixed') {
      const fee = c.occurrence;
      // A per-quantity fee multiplies by the service's one commercial
      // quantity (seats, desks, units from the source). Several quantity
      // bands would need a quantity per instant, so they refuse.
      if (c.perQuantity && coverage.bands.length !== 1)
        throw new Error('A per-quantity fee requires one commercial quantity');
      const quantity = c.perQuantity ? coverage.bands[0]!.quantity : one;
      const perQuantity = c.perQuantity
        ? { quantity: quantity.toString() }
        : {};
      if (fee.kind === 'oneOff') {
        const period = fee.at === 'serviceStart' ? cycles[0] : cycles.at(-1);
        if (!period || (fee.at === 'serviceEnd' && through !== serviceEnd))
          continue;
        const at = fee.at === 'serviceEnd' ? through : anchor;
        const t = terms(at).table;
        line(
          c,
          occurrenceId(fee.at),
          period.start,
          period.end,
          decimal(t.values[c.amount]!).times(quantity),
          [
            {
              rateVersion: t.version,
              at: fee.at,
              rate: t.values[c.amount],
              ...perQuantity,
            },
          ],
          { opening: at, table: t },
        );
        continue;
      }
      if (isAdvanceFee(c)) {
        // A binding minimum term adds [service end, term end): cycles that
        // open only because of it are rated on the term alone, never on the
        // agreed interval past the service end.
        const { owed, binding } = owedAdvanceOccurrences(
          calendar,
          fee.cadence,
          c.minimumTerm,
          asOf,
          serviceEnd,
        );
        const held = binding ? [binding] : [];
        const opened = binding
          ? union([...advanceCoverage, binding])
          : advanceCoverage;
        for (const o of owed) {
          const ms = covered(
            o.term ? held : o.start >= committedFrom ? committed : opened,
            o.start,
            o.fullEnd,
          );
          const fraction = prorate(ms, o, fee.feeProration),
            t = terms(o.start).table;
          line(
            c,
            occurrenceId('fee', iso(o.fullStart)),
            o.start,
            o.term ? o.end : o.fullEnd,
            decimal(t.values[c.amount]!).times(fraction).times(quantity),
            [
              {
                timing: 'advance',
                rateVersion: t.version,
                rate: t.values[c.amount],
                eligibleMs: ms,
                basisMs: o.fullEnd - o.fullStart,
                fraction: fraction.toString(),
                ...perQuantity,
                ...(binding && { minimumTermEnd: iso(binding.end) }),
              },
            ],
            { opening: o.start, table: t },
          );
        }
        continue;
      }
      // In arrears a binding term is due in the review that reaches the
      // service end: the cycles to the term end are rated on actual coverage
      // united with [service end, term end), each under its natural identity.
      const binding =
        through === serviceEnd
          ? bindingTerm(calendar, c.minimumTerm, serviceEnd, through)
          : null;
      const actual =
        fee.fixedFeeDuringPause === 'suspend'
          ? coverage.active
          : coverage.eligible;
      for (const o of binding
        ? occurrences(calendar, fee.cadence, binding.end, null)
        : occurrences(calendar, fee.cadence, through, serviceEnd).filter(
            (o) => o.closed,
          )) {
        const ms = covered(
          binding ? union([...actual, binding]) : actual,
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
          decimal(t.values[c.amount]!).times(fraction).times(quantity),
          [
            {
              rateVersion: t.version,
              rate: t.values[c.amount],
              eligibleMs: ms,
              basisMs: o.fullEnd - o.fullStart,
              fraction: fraction.toString(),
              ...perQuantity,
              ...(binding && { minimumTermEnd: iso(binding.end) }),
            },
          ],
          { opening: o.start, table: t },
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
        let usage = used.reduce((v, u) => v.plus(decimal(u.quantity)), zero);
        if (e.periodMeter) {
          if (
            iso(o.start) !== e.periodMeter.opening.at ||
            iso(o.end) !== e.periodMeter.closing.at
          )
            throw new Error('Billing requires readings for every meter cycle');
          usage = decimal(e.periodMeter.closing.reading).minus(
            decimal(e.periodMeter.opening.reading),
          );
          if (usage.n < 0n) throw new Error('Billing meter reading decreased');
        }
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
          { opening: o.start, table: t },
        );
      }
    }
  }
  // Percentage components (the reserved row): each mirrors its base's lines,
  // rated after them on the base's exact gross or net, rounded once. Its
  // rate is read at the base line's opening (for time, the first positive
  // pricing window, as for the enrollment minimum).
  for (const c of plan.components) {
    if (c.kind !== 'percentage') continue;
    for (const base of rated.filter(
      (r) => r.componentId === c.base.componentId,
    )) {
      const t = terms(base.opening).table;
      const on = c.base.stage === 'gross' ? base.gross : base.net;
      line(
        c,
        occurrenceId('pct', base.occurrence),
        base.start,
        base.end,
        on.times(decimal(t.values[c.rate]!).over(hundred)),
        [
          {
            rateVersion: t.version,
            rate: t.values[c.rate],
            base: c.base.componentId,
            stage: c.base.stage,
            baseExact: on.toString(),
          },
        ],
        { opening: base.opening, table: t },
      );
    }
  }
  if (allocations.size)
    throw new Error(
      'Prior allocation has no matching occurrence or quantity band',
    );
  const result = {
    algorithm,
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
    terms: [...termPins.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, pin]) => pin),
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
