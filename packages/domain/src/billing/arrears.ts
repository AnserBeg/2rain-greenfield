import {
  hasBillingRules,
  hasBillingTiming,
  type BillingPeriod,
  type BillingPlan,
} from '../../../canonical-model/src/billing.js';
import type { BillingQuoteEvidence } from '../../../canonical-model/src/billing-evidence.js';
import { ServiceUseSnapshotSchema } from '../../../canonical-model/src/service-evidence.js';
import {
  BillingCalendar,
  hourMs,
  instant,
  iso,
  monthShift,
} from './calendar.js';
import { periodDays } from './cover.js';
import { occurrences, openedOccurrences } from './occurrences.js';
import { isAdvanceFee, quoteBillingCycle } from './quote.js';
import { digest } from './terms.js';
import {
  serviceUseCoverage,
  serviceUseEnd,
  type ServiceUseInput,
} from './service-use.js';
export type { ServiceUseInput } from './service-use.js';

/** The service anchor survives invoice boundaries. A read cannot move the
 * accounting for prior coverage or make the next occurrence due early. */
export function dueArrearsCycle(
  plan: BillingPlan,
  evidence: Pick<
    BillingQuoteEvidence,
    'zone' | 'anchor' | 'asOf' | 'serviceEnd' | 'periodStart'
  >,
) {
  const anchor = instant(evidence.anchor);
  const asOf = instant(evidence.asOf);
  const start = instant(evidence.periodStart);
  const end =
    evidence.serviceEnd === null ? null : instant(evidence.serviceEnd);
  if (start < anchor || (end !== null && end <= anchor))
    throw new Error('Invalid billing service period');
  const horizon = Math.min(asOf, end ?? asOf);
  if (start >= horizon) return null;
  const periods = occurrences(
    new BillingCalendar(anchor, evidence.zone),
    plan.schedule,
    horizon,
    end,
  );
  // Service-end occurrences are absent until the service has ended.
  if (plan.schedule.kind === 'onServiceEnd' && !periods.length) return null;
  const next = periods.find((p) => p.start === start);
  if (!next) throw new Error('Billing checkpoint requires cutover evidence');
  return next.closed ? { start: iso(next.start), end: iso(next.end) } : null;
}

/** B2: the advance cycles owed at the review instant, for every advance fee.
 * They are owed whether or not an earlier review saw them (a late first
 * review still owes every opened cycle), and none opens at or after the
 * service end (keepPaidPeriod). */
export function dueAdvanceCycles(
  plan: BillingPlan,
  evidence: Pick<
    BillingQuoteEvidence,
    'zone' | 'anchor' | 'asOf' | 'serviceEnd'
  >,
) {
  const calendar = new BillingCalendar(instant(evidence.anchor), evidence.zone);
  const end =
    evidence.serviceEnd === null ? null : instant(evidence.serviceEnd);
  return plan.components.flatMap((c) =>
    isAdvanceFee(c)
      ? openedOccurrences(
          calendar,
          c.occurrence.cadence,
          instant(evidence.asOf),
          end,
        ).map((o) => ({
          componentId: c.id,
          start: iso(o.start),
          end: iso(o.fullEnd),
        }))
      : [],
  );
}

/** With service-use evidence, actual use first sets the service end, the
 * due cycle follows, then the engagement supplies the actual coverage. An
 * advance fee is due for each opened cycle even before any cycle closes. */
export function reviewArrearsCharges(
  plan: BillingPlan,
  evidence: BillingQuoteEvidence,
  input?: ServiceUseInput,
) {
  // The protocol shape is enforced where it is consumed, so any provider's
  // decoder is held to it (northstar.service-use/v1).
  const use = input && {
    ...input,
    snapshot: ServiceUseSnapshotSchema.parse(input.snapshot),
  };
  // Early return is a rule key: it is rated under calculation v4 only, so a
  // plan that does not declare it cannot be handed one.
  if (use?.earlyReturn && !hasBillingRules(plan))
    throw new Error('Early return requires calculation v4');
  // Advance fees are rated on the agreed interval, so its end is kept before
  // actual use moves the service end.
  if (hasBillingTiming(plan) && evidence.agreedEnd === undefined)
    evidence.agreedEnd = evidence.serviceEnd;
  if (use) {
    const term = use.earlyReturn?.minimumTerm;
    evidence.serviceEnd = serviceUseEnd(
      use.snapshot,
      use.subjectId,
      evidence.serviceEnd,
      use.earlyReturn,
      term && minimumTermEnd(evidence, term),
    );
  }
  const cycle = dueArrearsCycle(plan, evidence);
  const timed = plan.components.some(isAdvanceFee);
  const advance = timed ? dueAdvanceCycles(plan, evidence) : [];
  if (!cycle && !advance.length) return { status: 'notDue' as const };
  // Advance coverage reads actual use through the review instant, so the
  // snapshot must be complete through it, not only through a closed cycle.
  if (use)
    Object.assign(
      evidence,
      serviceUseCoverage(
        use,
        plan.serviceUnit,
        advance.length ? evidence.asOf : cycle!.end,
        evidence.serviceEnd,
      ),
    );
  // With no closed cycle the arrears prefix is empty: only advance is rated.
  const quote = quoteBillingCycle(
    plan,
    evidence,
    cycle?.end ?? evidence.periodStart,
  );
  const quoteDigest = digest({
    cycle,
    inputDigest: quote.inputDigest,
    resultDigest: quote.resultDigest,
  });
  // Plans without an advance fee keep their review bytes.
  return timed
    ? { status: 'due' as const, cycle, advance, quote, quoteDigest }
    : { status: 'due' as const, cycle, quote, quoteDigest };
}

/** The end of a minimum term counted in periods from service start, on the
 * same civil calendar as the pricing windows (months clamp from the original
 * day; a day is one local day at the anchor's wall time). */
function minimumTermEnd(
  evidence: Pick<BillingQuoteEvidence, 'anchor' | 'zone'>,
  term: { period: BillingPeriod; count: number },
) {
  const anchor = instant(evidence.anchor);
  if (term.period === 'hour') return anchor + term.count * hourMs;
  const calendar = new BillingCalendar(anchor, evidence.zone);
  return term.period === 'month'
    ? calendar.resolve(monthShift(calendar.wallAnchor, term.count))
    : calendar.day(term.count * periodDays(term.period, 0));
}
