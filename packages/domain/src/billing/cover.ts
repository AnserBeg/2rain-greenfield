import type {
  BillingPeriod,
  TimeComponent,
} from '../../../canonical-model/src/billing.js';
import { BillingCalendar, covered, hourMs, type Span } from './calendar.js';
import { decimal, Fraction, integer, zero } from './fraction.js';

const descending = ['month', 'fourWeek', 'week', 'day', 'hour'] as const;
export const periodDays = (
  period: Exclude<BillingPeriod, 'hour'>,
  monthDays: number,
) => ({ day: 1, week: 7, fourWeek: 28, month: monthDays })[period];
interface Segment {
  end: Fraction;
  dayLength: Fraction;
}
export interface CoverBlock {
  period: BillingPeriod;
  covered: Fraction;
  price: Fraction;
}
export interface Budget {
  remaining: number;
}
export function timeline(
  calendar: BillingCalendar,
  day: number,
  endDay: number,
  spans: readonly Span[],
) {
  const segments: Segment[] = [];
  let end = zero;
  for (let i = day; i < endDay; i++) {
    const start = calendar.day(i),
      next = calendar.day(i + 1);
    if (next < start) throw new Error('Billing calendar days must be ordered');
    const active = covered(spans, start, next);
    if (!active) continue;
    end = end.plus(integer(active));
    const length = integer(next - start);
    if (segments.at(-1)?.dayLength.compare(length) === 0)
      segments[segments.length - 1]!.end = end;
    else segments.push({ end, dayLength: length });
  }
  return segments;
}
// A cursor is exact cumulative active milliseconds. The same cursor can be reached
// by different covers, including fractional elapsed positions across a DST day.
function advance(
  segments: readonly Segment[],
  pos: Fraction,
  period: BillingPeriod,
  size: Fraction,
) {
  let remaining = size;
  for (const segment of segments) {
    if (segment.end.compare(pos) <= 0) continue;
    const unit = period === 'hour' ? integer(hourMs) : segment.dayLength;
    const amount = segment.end.minus(pos).over(unit).min(remaining);
    pos = pos.plus(amount.times(unit));
    remaining = remaining.minus(amount);
    if (!remaining.n) break;
  }
  return { pos, fraction: size.minus(remaining).over(size) };
}
interface Path {
  price: Fraction;
  count: number;
  counts: readonly number[];
  block: CoverBlock | null;
  tail: Path | null;
}
function prefer(a: Path, b: Path) {
  const cost = a.price.compare(b.price);
  if (cost !== 0) return cost < 0;
  if (a.count !== b.count) return a.count < b.count;
  for (let i = 0; i < a.counts.length; i++)
    if (a.counts[i] !== b.counts[i]) return a.counts[i]! > b.counts[i]!;
  // Alternatives at the same cursor have distinct first periods. The suffix
  // of each path has already won the same comparison at its own cursor.
  return (
    descending.indexOf(a.block!.period) < descending.indexOf(b.block!.period)
  );
}
export function bestCover(
  segments: readonly Segment[],
  monthDays: number,
  component: TimeComponent,
  values: Readonly<Record<string, string>>,
  budget: Budget,
) {
  const end = segments.at(-1)?.end ?? zero;
  const offers = descending.flatMap((period, i) => {
    const ref = component.rates[period];
    return ref
      ? [
          {
            period,
            i,
            rate: decimal(values[ref]!),
            size: integer(
              period === 'hour' ? 1 : periodDays(period, monthDays),
            ),
          },
        ]
      : [];
  });
  const memo = new Map<string, Path>();
  const terminal: Path = {
    price: zero,
    count: 0,
    counts: descending.map(() => 0),
    block: null,
    tail: null,
  };
  function solve(pos: Fraction): Path {
    if (pos.compare(end) === 0) return terminal;
    const key = pos.toString(),
      hit = memo.get(key);
    if (hit) return hit;
    if (--budget.remaining < 0)
      throw new Error('Billing cover state limit exceeded');
    let best: Path | undefined;
    for (const offer of offers) {
      const next = advance(segments, pos, offer.period, offer.size);
      const price =
        offer === offers.at(-1) &&
        component.partialTime === 'prorateShortestTail'
          ? offer.rate.times(next.fraction)
          : offer.rate;
      const tail = solve(next.pos);
      const counts = [...tail.counts];
      counts[offer.i] = counts[offer.i]! + 1;
      const path = {
        price: price.plus(tail.price),
        count: tail.count + 1,
        counts,
        block: { period: offer.period, covered: next.fraction, price },
        tail,
      };
      if (!best || prefer(path, best)) best = path;
    }
    memo.set(key, best!);
    return best!;
  }
  const winner = solve(zero);
  const blocks: CoverBlock[] = [];
  for (let p: Path | null = winner; p?.block; p = p.tail) blocks.push(p.block);
  return { price: winner.price, blocks };
}

export function durationFloor(
  calendar: BillingCalendar,
  day: number,
  endDay: number,
  monthDays: number,
  component: TimeComponent,
  values: Readonly<Record<string, string>>,
  budget: Budget,
) {
  let floor = component.minimumMoney
    ? decimal(values[component.minimumMoney]!)
    : zero;
  const duration = component.minimumDuration;
  if (duration) {
    const start = calendar.day(day);
    const end =
      duration.period === 'hour'
        ? start + duration.count * hourMs
        : calendar.day(
            day + periodDays(duration.period, monthDays) * duration.count,
          );
    if (end > calendar.day(endDay))
      throw new Error('Minimum duration exceeds the pricing window');
    floor = floor.max(
      bestCover(
        timeline(calendar, day, endDay, [{ start, end }]),
        monthDays,
        component,
        values,
        budget,
      ).price,
    );
  }
  return floor;
}
