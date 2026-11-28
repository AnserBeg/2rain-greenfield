import type {
  BillingPeriod,
  BillingSchedule,
} from '../../../canonical-model/src/billing.js';
import { type BillingCalendar, hourMs, monthShift } from './calendar.js';
import { periodDays } from './cover.js';

export interface Occurrence {
  start: number;
  end: number;
  fullStart: number;
  fullEnd: number;
  closed: boolean;
}
export function pricingWindows(
  calendar: BillingCalendar,
  period: Exclude<BillingPeriod, 'hour'>,
  through: number,
  serviceEnd: number | null,
) {
  const result = [];
  let day = 0;
  for (let i = 0; calendar.day(day) < through; i++) {
    const next =
      period === 'month'
        ? calendar.monthDay(i + 1)
        : day + periodDays(period, 0);
    if (next > 3660)
      throw new Error('Billing service exceeds the calendar horizon');
    const start = calendar.day(day),
      fullEnd = calendar.day(next),
      end = Math.min(fullEnd, through);
    if (fullEnd <= start) throw new Error('Empty pricing window');
    result.push({
      day,
      next,
      start,
      fullStart: start,
      end,
      fullEnd,
      closed: end === fullEnd || end === serviceEnd,
      monthDays: period === 'month' ? next - day : calendar.monthLength(day),
    });
    day = next;
  }
  return result;
}
export function occurrences(
  calendar: BillingCalendar,
  schedule: BillingSchedule,
  through: number,
  serviceEnd: number | null,
): Occurrence[] {
  const start = calendar.start;
  if (schedule.kind === 'onServiceEnd')
    return serviceEnd !== null && serviceEnd <= through && serviceEnd > start
      ? [
          {
            start,
            end: serviceEnd,
            fullStart: start,
            fullEnd: serviceEnd,
            closed: true,
          },
        ]
      : [];
  let wall = calendar.wallAnchor;
  if (schedule.kind === 'calendarMonth') {
    const date = new Date(wall);
    date.setUTCDate(1);
    date.setUTCHours(0, schedule.boundaryMinutes, 0, 0);
    wall = date.valueOf();
    if (calendar.resolve(wall) > start) wall = monthShift(wall, -1);
  }
  const boundary = (i: number) =>
    schedule.kind === 'fixedDays'
      ? calendar.day(i * schedule.days)
      : calendar.resolve(
          monthShift(
            wall,
            i * (schedule.kind === 'anniversary' ? schedule.months : 1),
          ),
        );
  const out: Occurrence[] = [];
  for (let i = 0, fullStart = boundary(0); fullStart < through; i++) {
    if (i >= 3660 || through - start > 3660 * 24 * hourMs)
      throw new Error('Billing schedule horizon exceeded');
    const fullEnd = boundary(i + 1),
      end = Math.min(fullEnd, through);
    if (fullEnd <= fullStart) throw new Error('Empty billing cycle');
    out.push({
      fullStart,
      fullEnd,
      start: Math.max(fullStart, start),
      end,
      closed: end === fullEnd || end === serviceEnd,
    });
    fullStart = fullEnd;
  }
  return out;
}

/** B2 advance billing: the cycles owed at `asOf`. A cycle is owed once it has
 * opened (its start, clamped to the service anchor, is at or before `asOf`)
 * and only if it opened before the service end; an open service owes every
 * opened cycle. One rule for a timely and a late review. */
export function openedOccurrences(
  calendar: BillingCalendar,
  cadence: Exclude<BillingSchedule, { kind: 'onServiceEnd' }>,
  asOf: number,
  serviceEnd: number | null,
): Occurrence[] {
  return occurrences(calendar, cadence, asOf + 1, serviceEnd).filter(
    (o) => o.start <= asOf && (serviceEnd === null || o.start < serviceEnd),
  );
}

/** The end of a term counted in periods from the service anchor, on the same
 * civil calendar as the pricing windows (months clamp from the original day;
 * a day is one local day at the anchor's wall time). */
export function termEnd(
  calendar: BillingCalendar,
  term: { period: BillingPeriod; count: number },
) {
  if (term.period === 'hour') return calendar.start + term.count * hourMs;
  return term.period === 'month'
    ? calendar.resolve(monthShift(calendar.wallAnchor, term.count))
    : calendar.day(term.count * periodDays(term.period, 0));
}

/** A fixed fee's minimum term (calculation v5) once it binds: the service
 * ended before the term elapsed, and the ending is visible at `horizon`. The
 * fee for [service end, term end) is then owed. */
export function bindingTerm(
  calendar: BillingCalendar,
  term: { period: BillingPeriod; count: number } | undefined,
  serviceEnd: number | null,
  horizon: number,
) {
  if (!term || serviceEnd === null || serviceEnd > horizon) return null;
  const end = termEnd(calendar, term);
  return end > serviceEnd ? { start: serviceEnd, end } : null;
}

/** The advance cycles a fee owes at `asOf`: its opened cycles and, once a
 * minimum term binds, every cycle that starts from the service end up to the
 * term end (the last one ends at the term end). Natural occurrence identities:
 * each cycle appears once. */
export function owedAdvanceOccurrences(
  calendar: BillingCalendar,
  cadence: Exclude<BillingSchedule, { kind: 'onServiceEnd' }>,
  term: { period: BillingPeriod; count: number } | undefined,
  asOf: number,
  serviceEnd: number | null,
) {
  const opened = openedOccurrences(calendar, cadence, asOf, serviceEnd).map(
    (o) => ({ ...o, term: false }),
  );
  const binding = bindingTerm(calendar, term, serviceEnd, asOf);
  if (!binding) return { owed: opened, binding };
  const held = occurrences(calendar, cadence, binding.end, null)
    .filter((o) => o.start >= binding.start)
    .map((o) => ({ ...o, term: true }));
  return { owed: [...opened, ...held], binding };
}
