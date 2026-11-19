export interface DisplayDecimalType {
  readonly precision: number;
  readonly scale: number;
  readonly currency: string | null;
  readonly unit: string | null;
}

export type DisplayArithmetic = 'add' | 'subtract' | 'multiply';

const MAXIMUM_DISPLAY_PRECISION = 76;
const MAXIMUM_DISPLAY_SCALE = 36;

export function displayArithmeticType(
  operator: DisplayArithmetic,
  left: DisplayDecimalType,
  right: DisplayDecimalType,
): DisplayDecimalType | null {
  const numeric = (
    currency: string | null,
    unit: string | null,
    precision: number,
    scale: number,
  ) =>
    precision <= MAXIMUM_DISPLAY_PRECISION && scale <= MAXIMUM_DISPLAY_SCALE
      ? { precision, scale, currency, unit }
      : null;
  if (operator === 'multiply') {
    if ((left.currency && right.currency) || (left.unit && right.unit))
      return null;
    const currency = left.currency ?? right.currency;
    return numeric(
      currency,
      currency ? null : (left.unit ?? right.unit),
      left.precision + right.precision,
      left.scale + right.scale,
    );
  }
  if (left.currency !== right.currency || left.unit !== right.unit) return null;
  const scale = Math.max(left.scale, right.scale);
  const wholeDigits = Math.max(
    left.precision - left.scale,
    right.precision - right.scale,
  );
  return numeric(left.currency, left.unit, wholeDigits + scale + 1, scale);
}

export function decimalDisplayCoefficient(
  value: string,
  type: DisplayDecimalType,
): bigint | null {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(value);
  if (!match) return null;
  const [, sign, whole = '', fraction = ''] = match;
  if (
    fraction.length > type.scale ||
    (whole !== '0' && whole.length > type.precision - type.scale)
  )
    return null;
  return BigInt(`${sign}${whole}${fraction.padEnd(type.scale, '0')}`);
}

export function evaluateDisplayArithmetic(
  operator: DisplayArithmetic,
  left: bigint,
  leftScale: number,
  right: bigint,
  rightScale: number,
): bigint {
  if (operator === 'multiply') return left * right;
  const scale = Math.max(leftScale, rightScale);
  const leftAtScale = left * 10n ** BigInt(scale - leftScale);
  const rightAtScale = right * 10n ** BigInt(scale - rightScale);
  return operator === 'add'
    ? leftAtScale + rightAtScale
    : leftAtScale - rightAtScale;
}

export function decimalDisplayText(coefficient: bigint, scale: number): string {
  const sign = coefficient < 0n ? '-' : '';
  const digits = String(coefficient < 0n ? -coefficient : coefficient).padStart(
    scale + 1,
    '0',
  );
  if (!scale) return sign + digits;
  const fraction = digits.slice(-scale).replace(/0+$/u, '');
  return sign + digits.slice(0, -scale) + (fraction ? `.${fraction}` : '');
}
