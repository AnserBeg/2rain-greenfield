/** Exact arithmetic at the document boundary. No IEEE-754 quantity arithmetic. */
export class UnitConversionError extends Error {
  override readonly name = 'UnitConversionError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const refuse = (code: string, message: string): never => {
  throw new UnitConversionError(code, message);
};
export interface UnitFactor {
  readonly itemId: string | null;
  readonly from: string;
  readonly to: string;
  readonly numerator: string;
  readonly denominator: string;
}
export function positiveUnitInteger(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,37}$/.test(value))
    return refuse(
      'UNIT_FACTOR_INVALID',
      'Unit conversion numerator and denominator must be positive integers',
    );
  return BigInt(value);
}
export function unitDecimals(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:[0-9]|1[0-8])$/.test(value))
    return refuse(
      'UNIT_PRECISION_INVALID',
      'Unit decimals must be an integer from 0 through 18',
    );
  return Number(value);
}
export function resolveUnitFactor(
  itemId: string,
  from: string,
  to: string,
  factors: readonly UnitFactor[],
): readonly [bigint, bigint] {
  if (from === to) return [1n, 1n];
  for (const reverse of [false, true]) {
    for (const item of [itemId, null]) {
      const matches = factors.filter(
        (factor) =>
          factor.itemId === item &&
          factor.from === (reverse ? to : from) &&
          factor.to === (reverse ? from : to),
      );
      if (matches.length > 1)
        return refuse(
          'UNIT_CONVERSION_AMBIGUOUS',
          `More than one conversion applies from ${from} to ${to}`,
        );
      const match = matches[0];
      if (match) {
        const numerator = positiveUnitInteger(match.numerator);
        const denominator = positiveUnitInteger(match.denominator);
        return reverse ? [denominator, numerator] : [numerator, denominator];
      }
    }
  }
  return refuse(
    'UNIT_CONVERSION_MISSING',
    `No conversion from ${from} to ${to} for this item and company`,
  );
}
export function convertUnitQuantity(
  quantity: unknown,
  numerator: bigint,
  denominator: bigint,
  decimals: number,
  baseUnit: string,
): string {
  if (
    typeof quantity !== 'string' ||
    !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(quantity) ||
    quantity.length > 60
  )
    return refuse(
      'UNIT_QUANTITY_INVALID',
      'Entered quantity must be an exact decimal string',
    );
  if (numerator <= 0n || denominator <= 0n)
    return refuse(
      'UNIT_FACTOR_INVALID',
      'Unit conversion factor must be positive',
    );
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    return refuse(
      'UNIT_PRECISION_INVALID',
      'Unit decimals must be between 0 and 18',
    );
  const negative = quantity.startsWith('-');
  const [whole, fraction = ''] = (
    negative ? quantity.slice(1) : quantity
  ).split('.');
  const scaled =
    BigInt(whole! + fraction) * numerator * 10n ** BigInt(decimals);
  const divisor = denominator * 10n ** BigInt(fraction.length);
  if (scaled % divisor !== 0n)
    return refuse(
      'UNIT_CONVERSION_NON_EXACT',
      `Quantity cannot be represented exactly in ${baseUnit} with ${decimals} decimals`,
    );
  const result = scaled / divisor;
  const digits = result.toString().padStart(decimals + 1, '0');
  if (digits.slice(0, digits.length - decimals).length > 20)
    return refuse(
      'UNIT_QUANTITY_OVERFLOW',
      'Converted base quantity exceeds the document quantity precision',
    );
  const text = decimals
    ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(
        /\.?0+$/,
        '',
      )
    : digits;
  return negative && result !== 0n ? `-${text}` : text;
}
