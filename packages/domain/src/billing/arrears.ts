import type { BillingPlan } from '../../../canonical-model/src/billing.js';
import type { BillingQuoteEvidence } from '../../../canonical-model/src/billing-evidence.js';
import { BillingCalendar, instant, iso } from './calendar.js';
import { occurrences } from './occurrences.js';
import { quoteBillingCycle } from './quote.js';
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

/** With service-use evidence, actual use first sets the service end, the
 * due cycle follows, then the engagement supplies the actual coverage. */
export function reviewArrearsCharges(
  plan: BillingPlan,
  evidence: BillingQuoteEvidence,
  use?: ServiceUseInput,
) {
  if (use)
    evidence.serviceEnd = serviceUseEnd(
      use.snapshot,
      use.subjectId,
      evidence.serviceEnd,
    );
  const cycle = dueArrearsCycle(plan, evidence);
  if (!cycle) return { status: 'notDue' as const };
  if (use)
    Object.assign(
      evidence,
      serviceUseCoverage(use, plan.serviceUnit, cycle.end),
    );
  const quote = quoteBillingCycle(plan, evidence, cycle.end);
  return {
    status: 'due' as const,
    cycle,
    quote,
    quoteDigest: digest({
      cycle,
      inputDigest: quote.inputDigest,
      resultDigest: quote.resultDigest,
    }),
  };
}
