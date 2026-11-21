export const hourMs = 3_600_000;
const dayMs = 24 * hourMs;

// Integer wall-clock coordinates are used only for civil date arithmetic.
// Offset resolution always comes from the enrollment's IANA zone.
export function instant(text: string) {
  if (
    typeof text !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(text)
  )
    throw new Error('Billing requires UTC instants at millisecond precision');
  const value = Date.parse(text);
  if (
    !Number.isSafeInteger(value) ||
    new Date(value).toISOString() !== text.replace(/(?<!\.\d{3})Z$/u, '.000Z')
  )
    throw new Error('Invalid billing instant');
  return value;
}
export const iso = (v: number) => new Date(v).toISOString();
export function monthShift(wall: number, months: number) {
  const d = new Date(wall),
    original = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months + 1, 0);
  d.setUTCDate(Math.min(original, d.getUTCDate()));
  return d.valueOf();
}

export interface CalendarPin {
  zone: string;
  zoneData: string;
  boundaries: readonly {
    local: string;
    instant: string;
    offsetMilliseconds: number;
  }[];
}
/** ADR-0083 A1 maps a derived civil boundary through IANA gaps and folds. */
export class CivilCalendar {
  private readonly format: Intl.DateTimeFormat;
  constructor(zone: string) {
    this.format = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  }
  wallAt(ms: number) {
    const parts = Object.fromEntries(
      this.format.formatToParts(ms).map((p) => [p.type, p.value]),
    );
    const date = new Date(ms);
    date.setUTCFullYear(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
    );
    date.setUTCHours(
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return date.valueOf();
  }
  resolveBoundary(wall: number): number {
    const before = wall - 2 * dayMs,
      after = wall + 2 * dayMs;
    const firstOffset = this.wallAt(before) - before,
      lastOffset = this.wallAt(after) - after;
    const candidates = [wall - firstOffset, wall - lastOffset].filter(
      (ms) => this.wallAt(ms) === wall,
    );
    let ms: number;
    if (candidates.length)
      ms = Math.min(...candidates); // The first occurrence in an overlap.
    else {
      // Find the offset transition itself. Shifting the requested minute by the
      // gap would overbill for anchors in the middle of a missing hour.
      let lo = before,
        hi = after;
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (this.wallAt(mid) - mid === firstOffset) lo = mid;
        else hi = mid;
      }
      if (!(this.wallAt(lo) < wall && wall < this.wallAt(hi)))
        throw new Error('Unresolvable billing day');
      ms = hi;
    }
    return ms;
  }
}

export class BillingCalendar extends CivilCalendar {
  readonly wallAnchor: number;
  private readonly cache = new Map<number, number>();
  constructor(
    readonly start: number,
    readonly zone: string,
    private readonly pinned?: CalendarPin,
  ) {
    super(zone);
    if (pinned) {
      if (pinned.zone !== zone || pinned.boundaries.length > 4097)
        throw new Error('Incompatible pinned calendar');
      for (const b of pinned.boundaries)
        this.cache.set(instant(b.local + 'Z'), instant(b.instant));
      const first = pinned.boundaries.find(
        (b) =>
          instant(b.instant) === start &&
          instant(b.local + 'Z') === start + b.offsetMilliseconds,
      );
      if (!first) throw new Error('Billing replay lacks the original anchor');
      this.wallAnchor = instant(first.local + 'Z');
    } else this.wallAnchor = this.wallAt(start);
    this.cache.set(this.wallAnchor, start); // The source gives the first instant explicitly.
  }
  resolve(wall: number): number {
    const cached = this.cache.get(wall);
    if (cached !== undefined) return cached;
    if (this.pinned) throw new Error('Billing replay lacks a pinned boundary');
    if (this.cache.size > 4096)
      throw new Error('Billing calendar boundary limit exceeded');
    const ms = this.resolveBoundary(wall);
    this.cache.set(wall, ms);
    return ms;
  }
  day(index: number) {
    return this.resolve(this.wallAnchor + dayMs * index);
  }
  monthDay(index: number) {
    return (monthShift(this.wallAnchor, index) - this.wallAnchor) / dayMs;
  }
  monthLength(dayIndex: number) {
    const wall = this.wallAnchor + dayIndex * dayMs;
    return (monthShift(wall, 1) - wall) / dayMs;
  }
  get boundaries() {
    if (this.pinned) return this.pinned.boundaries;
    return Array.from(this.cache, ([wall, ms]) => ({
      local: iso(wall).slice(0, -1),
      instant: iso(ms),
      offsetMilliseconds: this.wallAt(ms) - ms,
    })).sort((a, b) => a.local.localeCompare(b.local, 'en'));
  }
}
export interface Span {
  start: number;
  end: number;
}
export function union(spans: readonly Span[]) {
  const result: Span[] = [];
  for (const span of [...spans].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  )) {
    if (span.start >= span.end) continue;
    const last = result.at(-1);
    if (last && last.end >= span.start) last.end = Math.max(last.end, span.end);
    else result.push({ ...span });
  }
  return result;
}
export function exclude(spans: readonly Span[], pauses: readonly Span[]) {
  const result: Span[] = [];
  for (const span of spans) {
    let cursor = span.start;
    for (const pause of pauses) {
      if (pause.end <= cursor) continue;
      if (pause.start >= span.end) break;
      if (cursor < pause.start)
        result.push({ start: cursor, end: pause.start });
      cursor = Math.max(cursor, pause.end);
    }
    if (cursor < span.end) result.push({ start: cursor, end: span.end });
  }
  return result;
}
export function covered(spans: readonly Span[], start: number, end: number) {
  return spans.reduce(
    (sum, span) =>
      sum + Math.max(0, Math.min(span.end, end) - Math.max(span.start, start)),
    0,
  );
}
