import type { ReportAgeBand, ReportCurrencyBinding } from './schemas.js';
import type {
  CurrencyPartition,
  GroupKey,
  GroupedCell,
  GroupedRow,
} from './grouped-aggregate.js';

/** REPORTS-1 slice 2. The period, age and measure semantics every reader of a
 * v2 report shares: the provider computes facts in SQL, then orders, fills and
 * rounds through these functions; the reference evaluator recomputes the same
 * result from raw facts so the provider's arithmetic can be compared. */
export type ReportMeasureKind =
  | 'count'
  | 'sum'
  | 'min'
  | 'max'
  | 'average'
  | 'distinctCount'
  | 'distinctTargets';
export interface ReportDimensionSpec {
  readonly operand: string;
  readonly kind: 'direct' | 'calendar' | 'age';
  readonly type: string;
  readonly basis?: 'civilDate' | 'instant';
  readonly unit?: 'day' | 'week' | 'month';
  readonly bands?: readonly ReportAgeBand[];
  /** A finite declared member set (choice options). */
  readonly options?: readonly string[];
}
export interface ReportMeasureSpec {
  readonly id: string;
  readonly operator: ReportMeasureKind;
  readonly operand?: string;
  readonly scale: number;
  readonly type?: string;
  readonly unitId?: string;
  readonly currency?: ReportCurrencyBinding;
}
export interface ReportCalendar {
  readonly businessDate: string;
  readonly zone: string;
  readonly boundary: string;
}
export const RESTRICTED_KEY: GroupKey = Object.freeze({ restricted: true });
export type ReportFactValue = string | null | { restricted: true };
type Fact = Readonly<Record<string, ReportFactValue>>;

const DAY = 86_400_000;
const civilMs = (date: string) => Date.parse(date + 'T00:00:00Z');
const civil = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The business date of an instant: the company calendar's wall clock less its
 * day boundary. A civil-encoded instant is read as its UTC date, never zoned. */
export function businessDateOf(
  value: string,
  type: string,
  basis: string | undefined,
  calendar: ReportCalendar,
) {
  if (type === 'date') return value.slice(0, 10);
  if (basis === 'civilDate') return new Date(value).toISOString().slice(0, 10);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: calendar.zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(value))
      .map((p) => [p.type, p.value]),
  );
  const [h, m, s] = calendar.boundary.split(':').map(Number);
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return civil(wall - ((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000);
}

export function calendarKey(date: string, unit: 'day' | 'week' | 'month') {
  if (unit === 'day') return date;
  if (unit === 'month') return date.slice(0, 7);
  const ms = civilMs(date);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  return civil(ms - weekday * DAY);
}

export function ageDays(asOf: string, date: string) {
  return Math.round((civilMs(asOf) - civilMs(date)) / DAY);
}

export function ageBand(bands: readonly ReportAgeBand[], age: number) {
  return bands.find(
    (b) =>
      (b.from === null || age >= b.from) &&
      (b.through === null || age <= b.through),
  )?.bandId;
}

/** Bands are ordered, contiguous and cover every age exactly once. */
export function ageBandProblem(bands: readonly ReportAgeBand[]) {
  if (new Set(bands.map((b) => b.bandId)).size !== bands.length)
    return 'Use distinct band IDs.';
  if (bands[0]!.from !== null || bands.at(-1)!.through !== null)
    return 'The first band starts open and the last band ends open.';
  for (const [i, band] of bands.entries()) {
    if (band.from !== null && band.through !== null && band.from > band.through)
      return 'Band ' + band.bandId + ' ends before it starts.';
    const next = bands[i + 1];
    if (!next) continue;
    if (band.through === null || next.from === null)
      return 'Only the first and last bands are open-ended.';
    if (next.from !== band.through + 1)
      return 'Band ' + next.bandId + ' leaves a gap or overlaps.';
  }
  return null;
}

export const DEFAULT_AGE_BANDS: readonly ReportAgeBand[] = Object.freeze([
  { bandId: 'not_due', label: 'Not yet due', from: null, through: -1 },
  { bandId: 'd0_30', label: '0–30', from: 0, through: 30 },
  { bandId: 'd31_60', label: '31–60', from: 31, through: 60 },
  { bandId: 'd61_90', label: '61–90', from: 61, through: 90 },
  { bandId: 'd91', label: '91+', from: 91, through: null },
]);

function scaled(value: string, scale: number): bigint {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value))
    throw new RangeError('Invalid report decimal');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale && /[1-9]/u.test(fraction.slice(scale)))
    throw new RangeError('Invalid report scale');
  return BigInt(whole + fraction.slice(0, scale).padEnd(scale, '0'));
}
export function renderDecimal(value: bigint, scale: number): string {
  const digits = (value < 0n ? -value : value)
    .toString()
    .padStart(scale + 1, '0');
  if (digits.length > 38) throw new RangeError('Report precision overflow');
  const sign = value < 0n ? '-' : '';
  return (
    sign +
    (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits)
  );
}
/** Half-even at the operand scale (R8); the exact ratio stays in the cell. */
export function averageValue(sum: string, count: number, scale: number) {
  if (count === 0) return null;
  const total = scaled(sum, scale);
  const n = BigInt(count);
  let q = total / n;
  const r = total % n;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice > n || (twice === n && q % 2n !== 0n)) q += total < 0n ? -1n : 1n;
  return renderDecimal(q, scale);
}

const numeric = (type: string | undefined) =>
  type === 'decimal' || type === 'integer' || type === 'quantity';
function compareValues(type: string | undefined, a: string, b: string) {
  if (numeric(type)) {
    const scale = Math.max(
      a.split('.')[1]?.length ?? 0,
      b.split('.')[1]?.length ?? 0,
    );
    const x = scaled(a, scale);
    const y = scaled(b, scale);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
const isRestricted = (k: GroupKey): k is { restricted: true } =>
  typeof k === 'object' && k !== null;
/** Deterministic typed order: values, then Restricted, then absence. Age
 * bands follow their declared order; the absent band is last. */
export function compareKeys(
  dims: readonly ReportDimensionSpec[],
  a: readonly GroupKey[],
  b: readonly GroupKey[],
) {
  for (const [i, dim] of dims.entries()) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    const rank = (k: GroupKey) => (k === null ? 2 : isRestricted(k) ? 1 : 0);
    if (rank(x) !== rank(y)) return rank(x) - rank(y);
    if (typeof x !== 'string' || typeof y !== 'string') continue;
    const order =
      dim.kind === 'age'
        ? dim.bands!.findIndex((band) => band.bandId === x) -
          dim.bands!.findIndex((band) => band.bandId === y)
        : compareValues(dim.kind === 'direct' ? dim.type : 'text', x, y);
    if (order) return order;
  }
  return 0;
}
const partitionRank = (p: CurrencyPartition) =>
  p.kind === 'currency' ? '0' + p.code : '1';
export function comparePartitions(a: CurrencyPartition, b: CurrencyPartition) {
  return partitionRank(a) < partitionRank(b)
    ? -1
    : partitionRank(a) > partitionRank(b)
      ? 1
      : 0;
}

export function emptyCell(m: ReportMeasureSpec): GroupedCell {
  return {
    measureId: m.id,
    value: ['count', 'distinctCount', 'distinctTargets'].includes(m.operator)
      ? '0'
      : m.operator === 'sum'
        ? renderDecimal(0n, m.scale)
        : null,
    ...(m.unitId && { unitId: m.unitId }),
    ...(m.operator === 'average' && {
      exact: { sum: renderDecimal(0n, m.scale), count: 0 },
    }),
    recordsWithoutMeasure: 0,
  };
}

/** Finite dimensions (bands, choices) emit typed zero rows for their declared
 * members when every dimension is finite (R8). References never do. Rows are
 * then ordered deterministically. */
export function finishGroups(
  dims: readonly ReportDimensionSpec[],
  measures: readonly ReportMeasureSpec[],
  groups: GroupedRow[],
  partitions: readonly CurrencyPartition[],
) {
  const members = dims.map((d) =>
    d.kind === 'age'
      ? [...d.bands!.map((b) => b.bandId), null]
      : d.kind === 'direct' && d.options
        ? d.options
        : undefined,
  );
  if (dims.length && members.every(Boolean)) {
    const seen = new Set(
      groups.map((g) => JSON.stringify([g.partition, g.keys])),
    );
    let product: GroupKey[][] = [[]];
    for (const set of members as GroupKey[][])
      product = product.flatMap((p) => set.map((k) => [...p, k]));
    for (const partition of partitions)
      for (const keys of product)
        if (!seen.has(JSON.stringify([partition, keys])))
          groups.push({ keys, partition, cells: measures.map(emptyCell) });
  }
  return groups.sort(
    (a, b) =>
      comparePartitions(a.partition, b.partition) ||
      compareKeys(dims, a.keys, b.keys),
  );
}

function partitionFor(
  binding: ReportCurrencyBinding | undefined,
  fact: Fact,
): CurrencyPartition {
  if (!binding) return { kind: 'unitless' };
  if (binding.kind === 'fixed')
    return { kind: 'currency', code: binding.currencyCode };
  const value = fact[binding.fieldId];
  const code = binding.codes.find((candidate) => candidate === value);
  return code ? { kind: 'currency', code } : { kind: 'noCurrency' };
}

/** Reference result for a complete, already-authorized and already-joined set
 * of facts at the report grain. */
export function evaluateReportFacts(
  dims: readonly ReportDimensionSpec[],
  measures: readonly ReportMeasureSpec[],
  facts: readonly Fact[],
  calendar: ReportCalendar,
) {
  const binding = measures.find((m) => m.currency)?.currency;
  const keyOf = (dim: ReportDimensionSpec, fact: Fact): GroupKey => {
    const raw = fact[dim.operand] ?? null;
    if (raw === null || typeof raw === 'object') return raw;
    if (dim.kind === 'direct') return raw;
    const date = businessDateOf(raw, dim.type, dim.basis, calendar);
    if (dim.kind === 'calendar') return calendarKey(date, dim.unit!);
    return ageBand(dim.bands!, ageDays(calendar.businessDate, date)) ?? null;
  };
  type Acc = {
    n: number;
    sum: bigint;
    present: number;
    missing: number;
    best: string | null;
    set: Set<string>;
  };
  const fresh = (): Acc => ({
    n: 0,
    sum: 0n,
    present: 0,
    missing: 0,
    best: null,
    set: new Set(),
  });
  const rows = new Map<
    string,
    { keys: GroupKey[]; partition: CurrencyPartition; acc: Acc[] }
  >();
  const totals = new Map<
    string,
    { keys: GroupKey[]; partition: CurrencyPartition; acc: Acc[] }
  >();
  const at = (
    map: typeof rows,
    keys: GroupKey[],
    partition: CurrencyPartition,
  ) => {
    const id = JSON.stringify([partition, keys]);
    const entry = map.get(id) ?? {
      keys,
      partition,
      acc: measures.map(fresh),
    };
    map.set(id, entry);
    return entry;
  };
  if (binding?.kind !== 'stored') at(totals, [], partitionFor(binding, {}));
  for (const fact of facts) {
    const partition = partitionFor(binding, fact);
    const targets = [
      ...(dims.length
        ? [
            at(
              rows,
              dims.map((d) => keyOf(d, fact)),
              partition,
            ),
          ]
        : []),
      at(totals, [], partition),
    ];
    for (const [i, m] of measures.entries()) {
      const raw = m.operand === undefined ? '1' : (fact[m.operand] ?? null);
      const value = typeof raw === 'object' ? null : raw;
      for (const target of targets) {
        const acc = target.acc[i]!;
        acc.n++;
        if (m.operator === 'count') continue;
        if (value === null) {
          acc.missing++;
          continue;
        }
        acc.present++;
        if (m.operator === 'sum' || m.operator === 'average')
          acc.sum += scaled(value, m.scale);
        else if (m.operator === 'min' || m.operator === 'max') {
          const order =
            acc.best === null ? 0 : compareValues(m.type, value, acc.best);
          if (
            acc.best === null ||
            (m.operator === 'min' ? order < 0 : order > 0)
          )
            acc.best = value;
        } else acc.set.add(numeric(m.type) ? String(scaled(value, 18)) : value);
      }
    }
  }
  const cell = (m: ReportMeasureSpec, acc: Acc): GroupedCell => ({
    measureId: m.id,
    value:
      m.operator === 'count'
        ? String(acc.n)
        : m.operator === 'sum'
          ? renderDecimal(acc.sum, m.scale)
          : m.operator === 'average'
            ? averageValue(
                renderDecimal(acc.sum, m.scale),
                acc.present,
                m.scale,
              )
            : m.operator === 'min' || m.operator === 'max'
              ? acc.best === null
                ? null
                : numeric(m.type)
                  ? renderDecimal(scaled(acc.best, m.scale), m.scale)
                  : acc.best
              : String(acc.set.size),
    ...(m.unitId && { unitId: m.unitId }),
    ...(m.operator === 'average' && {
      exact: { sum: renderDecimal(acc.sum, m.scale), count: acc.present },
    }),
    recordsWithoutMeasure: acc.missing,
  });
  const render = (map: typeof rows): GroupedRow[] =>
    [...map.values()].map(({ keys, partition, acc }) => ({
      keys,
      partition,
      cells: measures.map((m, i) => cell(m, acc[i]!)),
    }));
  const totalRows = render(totals).sort((a, b) =>
    comparePartitions(a.partition, b.partition),
  );
  return {
    groups: finishGroups(
      dims,
      measures,
      render(rows),
      totalRows.map((t) => t.partition),
    ),
    totals: totalRows,
  };
}
