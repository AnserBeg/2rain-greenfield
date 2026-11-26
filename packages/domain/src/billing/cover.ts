import type {
  BillingPeriod,
  TimeComponent,
} from '../../../canonical-model/src/billing.js';
import {
  type BillingCalendar,
  covered,
  hourMs,
  type Span,
} from './calendar.js';
import { decimal, type Fraction, integer, one, zero } from './fraction.js';

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
/** Whether a final, partly used block of `period` is charged pro rata. A
 * declared per-rate rule wins; otherwise the legacy partialTime prorates only
 * the shortest offer, and the prorate combination prorates every rate. */
function prorates(
  component: TimeComponent,
  period: BillingPeriod,
  shortest: boolean,
) {
  const declared = component.partial?.[period];
  if (declared) return declared === 'prorate';
  if (component.combination?.rule === 'prorate') return true;
  return shortest && component.partialTime === 'prorateShortestTail';
}

function offersOf(
  component: TimeComponent,
  values: Readonly<Record<string, string>>,
  monthDays: number,
) {
  return descending.flatMap((period, i) => {
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
}

/** One price for a pricing window's active time, under the component's
 * combination rule. Every rule returns the blocks it charged, in timeline
 * order, so per-billed-period allowances read the same shape. */
export function priceCover(
  segments: readonly Segment[],
  monthDays: number,
  component: TimeComponent,
  values: Readonly<Record<string, string>>,
  budget: Budget,
): { price: Fraction; blocks: CoverBlock[] } {
  switch (component.combination?.rule) {
    case 'ladder':
      return ladderCover(segments, monthDays, component, values, budget);
    case 'prorate':
      return prorateCover(segments, monthDays, component, values, budget);
    default:
      return bestCover(segments, monthDays, component, values, budget);
  }
}

/** The cap on a window's time subtotal: a published money slot, or a whole
 * multiple of an offered rate. */
export function capValue(
  component: TimeComponent,
  values: Readonly<Record<string, string>>,
): Fraction | null {
  const cap = component.cap;
  if (cap === undefined) return null;
  if (typeof cap === 'string') return decimal(values[cap]!);
  return decimal(values[component.rates[cap.rate]!]!).times(integer(cap.times));
}

// Whole blocks of one rate from `pos`, then the final partly used block
// when `tail` is set (whole or pro rata by the rate's partial rule).
function fill(
  segments: readonly Segment[],
  end: Fraction,
  component: TimeComponent,
  offer: ReturnType<typeof offersOf>[number],
  shortest: boolean,
  pos: Fraction,
  tail: boolean,
  budget: Budget,
) {
  const blocks: CoverBlock[] = [];
  let price = zero;
  while (pos.compare(end) < 0) {
    if (--budget.remaining < 0)
      throw new Error('Billing cover state limit exceeded');
    const next = advance(segments, pos, offer.period, offer.size);
    const whole = next.fraction.compare(one) === 0;
    if (!whole && !tail) break;
    const charged =
      !whole && prorates(component, offer.period, shortest)
        ? offer.rate.times(next.fraction)
        : offer.rate;
    blocks.push({
      period: offer.period,
      covered: next.fraction,
      price: charged,
    });
    price = price.plus(charged);
    pos = next.pos;
  }
  return { pos, price, blocks };
}

/** Ladder: whole blocks of the longest rate that fit, then of each shorter
 * rate, the remainder in started blocks of the shortest. With capAtNextTier
 * the shorter rates never charge more than one more block of the rate above
 * them (1 week + 6 days at 100/20 costs 200, not 220). */
function ladderCover(
  segments: readonly Segment[],
  monthDays: number,
  component: TimeComponent,
  values: Readonly<Record<string, string>>,
  budget: Budget,
) {
  const end = segments.at(-1)?.end ?? zero;
  const offers = offersOf(component, values, monthDays);
  const capped =
    component.combination?.rule === 'ladder' &&
    component.combination.capAtNextTier;
  function tier(
    i: number,
    pos: Fraction,
  ): { price: Fraction; blocks: CoverBlock[] } {
    const offer = offers[i]!;
    const last = i === offers.length - 1;
    const head = fill(segments, end, component, offer, last, pos, last, budget);
    if (last || head.pos.compare(end) === 0) return head;
    const rest = tier(i + 1, head.pos);
    if (capped && rest.price.compare(offer.rate) > 0) {
      const next = advance(segments, head.pos, offer.period, offer.size);
      return {
        price: head.price.plus(offer.rate),
        blocks: [
          ...head.blocks,
          { period: offer.period, covered: next.fraction, price: offer.rate },
        ],
      };
    }
    return {
      price: head.price.plus(rest.price),
      blocks: [...head.blocks, ...rest.blocks],
    };
  }
  return tier(0, zero);
}

/** Prorate: the longest rate one whole block of which fits the active time
 * (the tier reached), charged pro rata for all of it. Ten days at 100 a week
 * or 20 a day costs 10/7 x 100 = 142.86; three days costs 3 x 20 = 60. */
function prorateCover(
  segments: readonly Segment[],
  monthDays: number,
  component: TimeComponent,
  values: Readonly<Record<string, string>>,
  budget: Budget,
) {
  const end = segments.at(-1)?.end ?? zero;
  const offers = offersOf(component, values, monthDays);
  const reached =
    offers.find(
      (o) =>
        advance(segments, zero, o.period, o.size).fraction.compare(one) === 0,
    ) ?? offers.at(-1)!;
  const { price, blocks } = fill(
    segments,
    end,
    component,
    reached,
    reached === offers.at(-1),
    zero,
    true,
    budget,
  );
  return { price, blocks };
}

export function bestCover(
  segments: readonly Segment[],
  monthDays: number,
  component: TimeComponent,
  values: Readonly<Record<string, string>>,
  budget: Budget,
) {
  const end = segments.at(-1)?.end ?? zero;
  const offers = offersOf(component, values, monthDays);
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
      const price = prorates(component, offer.period, offer === offers.at(-1))
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
      priceCover(
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
