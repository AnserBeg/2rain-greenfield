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
