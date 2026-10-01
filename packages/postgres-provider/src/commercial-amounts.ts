/**
 * Exact commercial arithmetic for owner ruling B: a line amount is quantity ×
 * unit price less its percentage discount, and its tax is that amount × the
 * tax code's rate. Each is rounded half up to cents on its own line; totals
 * add the rounded line and charge figures. One currency per order, so no
 * conversion happens here. Everything is BigInt over the exact decimal
 * strings the store returns; nothing passes through a float.
 */

interface Exact {
  readonly units: bigint;
  readonly scale: number;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/u;
const pow10 = (exponent: number) => 10n ** BigInt(exponent);

/** An exact decimal, or `null` for anything that is not one. */
export function parseExact(value: unknown): Exact | null {
  if (typeof value !== 'string') return null;
  const match = DECIMAL.exec(value.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match as unknown as [
    string,
    string,
    string,
    string | undefined,
  ];
  const units = BigInt(`${whole}${fraction}`);
  return { units: sign === '-' ? -units : units, scale: fraction.length };
}

/** `units / 10^scale` rounded half up (away from zero at .5) to cents. */
export function toCents(units: bigint, scale: number): bigint {
  if (scale <= 2) return units * pow10(2 - scale);
  const divisor = pow10(scale - 2);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const quotient = magnitude / divisor;
  const rounded =
    (magnitude % divisor) * 2n >= divisor ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Cents as a money string: `1234` → `12.34`. */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const fraction = String(magnitude % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}${String(magnitude / 100n)}.${fraction}`;
}

/** A non-negative percentage rate, or `null`. */
function rate(value: unknown): Exact | null {
  const parsed = parseExact(value);
  return parsed && parsed.units >= 0n ? parsed : null;
}

/** Tax on an amount in cents at a percentage rate, rounded half up. */
export function taxOn(amountCents: bigint, ratePercent: Exact): bigint {
  // amount (scale 2) × rate (scale r) / 100 (scale +2)
  return toCents(amountCents * ratePercent.units, 2 + ratePercent.scale + 2);
}

export interface LineInput {
  readonly quantity: unknown;
  readonly unitPrice: unknown;
  readonly discountPercent: unknown;
  /** `undefined`: the line has no tax code (untaxed); `null`: unknown rate. */
  readonly taxRatePercent: string | null | undefined;
}

export interface LineAmounts {
  readonly amountCents: bigint;
  readonly taxCents: bigint;
}

/**
 * A line's amount and tax, or `null` when either cannot be stated: no unit
 * price yet, a negative quantity or price, a discount outside 0-100%, or a
 * tax code whose rate cannot be read.
 */
export function lineAmounts(line: LineInput): LineAmounts | null {
  const quantity = parseExact(line.quantity);
  const price = parseExact(line.unitPrice);
  const discount =
    line.discountPercent === null || line.discountPercent === undefined
      ? { units: 0n, scale: 0 }
      : parseExact(line.discountPercent);
  if (!quantity || !price || !discount) return null;
  if (quantity.units < 0n || price.units < 0n) return null;
  const hundred = 100n * pow10(discount.scale);
  if (discount.units < 0n || discount.units > hundred) return null;
  const amountCents = toCents(
    quantity.units * price.units * (hundred - discount.units),
    quantity.scale + price.scale + discount.scale + 2,
  );
  if (line.taxRatePercent === undefined) return { amountCents, taxCents: 0n };
  const taxRate = rate(line.taxRatePercent);
  if (!taxRate) return null;
  return { amountCents, taxCents: taxOn(amountCents, taxRate) };
}

/**
 * A charge (freight, other fee) in cents with its tax, or `null` when its
 * amount is not a non-negative decimal or its rate cannot be read. An absent
 * charge is zero.
 */
export function chargeAmounts(
  amount: unknown,
  taxRatePercent: string | null | undefined,
): LineAmounts | null {
  if (amount === null || amount === undefined || amount === '')
    return { amountCents: 0n, taxCents: 0n };
  const parsed = parseExact(amount);
  if (!parsed || parsed.units < 0n) return null;
  const amountCents = toCents(parsed.units, parsed.scale);
  if (taxRatePercent === undefined) return { amountCents, taxCents: 0n };
  const taxRate = rate(taxRatePercent);
  if (!taxRate) return null;
  return { amountCents, taxCents: taxOn(amountCents, taxRate) };
}

/** Whether two exact decimals are equal in value (`12.5` and `12.500`). */
export function sameExact(left: unknown, right: unknown): boolean {
  const a = parseExact(left);
  const b = parseExact(right);
  if (!a || !b) return false;
  const scale = Math.max(a.scale, b.scale);
  return a.units * pow10(scale - a.scale) === b.units * pow10(scale - b.scale);
}
