/**
 * Display formatting shared by document sections.
 *
 * Quantities and prices arrive from the semantic gateway as canonical decimal
 * STRINGS (precision 38, scale 18). They are never converted to a JavaScript
 * number: `0.1 + 0.2` is not `0.3` in binary floating point, and an ERP total
 * that is off by a rounding error is a defect. Everything here works on
 * `bigint` values scaled by 10^18, which is exact.
 */

const DECIMAL_SCALE_DIGITS = 18;
const DECIMAL_SCALE = 10n ** BigInt(DECIMAL_SCALE_DIGITS);
const CANONICAL_DECIMAL = /^-?\d+(\.\d{1,18})?$/u;

/** An exact decimal, held as an integer count of 10^-18 units. */
export type ExactDecimal = bigint;

export const ZERO: ExactDecimal = 0n;

/** Parses a canonical decimal string, or returns `null` when it is not one. */
export function parseDecimal(value: unknown): ExactDecimal | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !CANONICAL_DECIMAL.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^-/u, '').split('.');
  const magnitude =
    BigInt(whole!) * DECIMAL_SCALE +
    BigInt(fraction.padEnd(DECIMAL_SCALE_DIGITS, '0'));
  return negative ? -magnitude : magnitude;
}

/**
 * Multiplies two exact decimals. The product of two scale-18 values has scale
 * 36, so it is brought back to scale 18 rounding half away from zero. Callers
 * display at most a handful of fraction digits, far inside that precision.
 */
export function multiplyDecimal(
  left: ExactDecimal,
  right: ExactDecimal,
): ExactDecimal {
  const product = left * right;
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const rounded = (magnitude + DECIMAL_SCALE / 2n) / DECIMAL_SCALE;
  return negative ? -rounded : rounded;
}

/** Whole-number percentage of `part` in `total`, clamped to 0–100. */
export function percentOf(part: ExactDecimal, total: ExactDecimal): number {
  if (total <= 0n || part <= 0n) return 0;
  if (part >= total) return 100;
  return Number((part * 100n) / total);
}

export interface DecimalFormat {
  /** Fraction digits always shown, padded with zeros. Default 0. */
  readonly minimumFractionDigits?: number;
  /** Fraction digits kept before rounding. Default 6. */
  readonly maximumFractionDigits?: number;
}

/**
 * Formats an exact decimal for reading: thousands separators, trailing zeros
 * trimmed down to `minimumFractionDigits`, rounded half away from zero at
 * `maximumFractionDigits`.
 */
export function formatDecimal(
  value: ExactDecimal,
  { minimumFractionDigits = 0, maximumFractionDigits = 6 }: DecimalFormat = {},
): string {
  const keep = Math.min(
    DECIMAL_SCALE_DIGITS,
    Math.max(minimumFractionDigits, maximumFractionDigits),
  );
  const unit = 10n ** BigInt(DECIMAL_SCALE_DIGITS - keep);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const rounded = (magnitude + unit / 2n) / unit;
  const keepScale = 10n ** BigInt(keep);
  const whole = (rounded / keepScale).toString();
  let fraction =
    keep === 0 ? '' : (rounded % keepScale).toString().padStart(keep, '0');
  while (fraction.length > minimumFractionDigits && fraction.endsWith('0')) {
    fraction = fraction.slice(0, -1);
  }
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const sign = negative && rounded !== 0n ? '−' : '';
  return `${sign}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/** Quantities: as entered, without padded zeros. */
export function formatQuantity(value: ExactDecimal): string {
  return formatDecimal(value);
}

/**
 * A money amount — a line total or an order total — at two fraction digits.
 * The currency is shown separately, because an order stores a currency CODE
 * and nothing here may guess a symbol or a locale from it.
 */
export function formatAmount(value: ExactDecimal): string {
  return formatDecimal(value, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
}

/**
 * A unit price: two fraction digits minimum, up to six when the stored price
 * genuinely carries them. Suppliers quote fractions of a cent per unit, and
 * rounding those away would make `quantity × price` disagree with the total.
 */
export function formatUnitPrice(value: ExactDecimal): string {
  return formatDecimal(value, {
    maximumFractionDigits: 6,
    minimumFractionDigits: 2,
  });
}

const MONTHS = Object.freeze([
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]);

/**
 * A stored UTC instant (`2026-07-30T12:00:00.000Z`) read as a calendar date.
 *
 * The date is taken from the instant's UTC fields, not the server's local
 * zone, so every reader sees the same day for the same record. Returns `null`
 * when the value is not a parseable instant; the caller then shows the raw
 * text rather than a wrong date.
 */
export function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

/** `30 Jul 2026` — day, month name and a four-digit year, in UTC. */
export function formatDate(instant: Date): string {
  return `${String(instant.getUTCDate())} ${MONTHS[instant.getUTCMonth()]!} ${String(instant.getUTCFullYear())}`;
}

/** Whole UTC calendar days from `from` to `to`; negative when `to` is earlier. */
export function calendarDaysBetween(from: Date, to: Date): number {
  const day = (instant: Date): number =>
    Date.UTC(
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate(),
    );
  return Math.round((day(to) - day(from)) / 86_400_000);
}
