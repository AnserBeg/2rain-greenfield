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

/** How one purchase order line's billing stands against its receipts. */
export type ThreeWayMatchStatus =
  'Matched' | 'Billed above received' | 'Received, not billed' | 'Not received';

/**
 * The three-way match of one purchase order line (PAYABLES, owner ruling
 * PY-G): what is received and not yet billed, and how the two compare, from
 * exact quantities at one scale. Either side unstated states nothing: a
 * withheld read is not a zero. It is shown, never enforced.
 */
export function threeWayMatch(
  received: bigint | null,
  billed: bigint | null,
): {
  readonly toBill: bigint | null;
  readonly status: ThreeWayMatchStatus | null;
} {
  if (received === null || billed === null)
    return { toBill: null, status: null };
  return {
    toBill: received > billed ? received - billed : 0n,
    status:
      billed > received
        ? 'Billed above received'
        : received > billed
          ? 'Received, not billed'
          : received === 0n
            ? 'Not received'
            : 'Matched',
  };
}

/**
 * A credit limit in cents (SALES-EXTRAS), rounded half up like every money
 * figure: a positive amount sets a limit; empty, zero or anything that is not
 * a non-negative decimal sets none.
 */
export function creditLimitCents(value: unknown): bigint | null {
  const parsed = parseExact(value);
  if (!parsed || parsed.units <= 0n) return null;
  const cents = toCents(parsed.units, parsed.scale);
  return cents > 0n ? cents : null;
}

/**
 * An order's total in cents -- its lines' amounts and taxes and its charges
 * with theirs -- or `null` when any figure cannot be stated, as the
 * commercial read model states it.
 */
export function orderTotalCents(
  lines: readonly LineInput[],
  charges: readonly {
    readonly amount: unknown;
    readonly taxRatePercent: string | null | undefined;
  }[],
): bigint | null {
  let total = 0n;
  for (const line of lines) {
    const amounts = lineAmounts(line);
    if (!amounts) return null;
    total += amounts.amountCents + amounts.taxCents;
  }
  for (const charge of charges) {
    const amounts = chargeAmounts(charge.amount, charge.taxRatePercent);
    if (!amounts) return null;
    total += amounts.amountCents + amounts.taxCents;
  }
  return total;
}

/** How a customer's credit stands, as its pages show it (SALES-EXTRAS). */
export type CreditStatus =
  | 'On hold'
  | 'No limit'
  | 'Within limit'
  | 'Over limit'
  | 'Limit in another currency';

export interface CreditPosition {
  readonly limitCents: bigint | null;
  /** Open and partially paid invoice balances, in the currency. */
  readonly openBalanceCents: bigint | null;
  /** Confirmed orders' totals not yet on a live invoice, in the currency. */
  readonly onOrderCents: bigint | null;
  /** The limit less both, when there is a limit and both are stated. */
  readonly availableCents: bigint | null;
  readonly status: CreditStatus | null;
}

/**
 * A customer's credit position in one currency (SALES-EXTRAS): exposure is
 * what its open invoices still owe plus what its confirmed orders will still
 * invoice, in that currency only -- nothing is converted. A limit set in
 * another currency is not compared. Either figure unstated (a withheld read,
 * an unpriced line) states no availability: nothing is guessed as zero.
 */
export function creditPosition(input: {
  readonly hold: boolean;
  readonly limitCents: bigint | null;
  /** Whether the limit is in the currency the figures are in. */
  readonly sameCurrency: boolean;
  readonly openBalanceCents: bigint | null;
  readonly onOrderCents: bigint | null;
}): CreditPosition {
  const limit = input.sameCurrency ? input.limitCents : null;
  const exposure =
    input.openBalanceCents === null || input.onOrderCents === null
      ? null
      : input.openBalanceCents + input.onOrderCents;
  const available =
    limit === null || exposure === null ? null : limit - exposure;
  return {
    limitCents: input.limitCents,
    openBalanceCents: input.openBalanceCents,
    onOrderCents: input.onOrderCents,
    availableCents: available,
    status: input.hold
      ? 'On hold'
      : input.limitCents === null
        ? 'No limit'
        : !input.sameCurrency
          ? 'Limit in another currency'
          : available === null
            ? null
            : available < 0n
              ? 'Over limit'
              : 'Within limit',
  };
}
