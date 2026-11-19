import { STRUCTURAL_LIMITS_V0 } from './constants.js';

/** The authored nodes use canonical v6. Projection readers pin the position profile. */
export const VALIDATION_NODE_VERSION = 'v6' as const;
export const VALIDATION_POSITION_PROFILE =
  'northstar.formula-validation-position/v1' as const;

type Node = { readonly schemaVersion: typeof VALIDATION_NODE_VERSION };
export type Truth = 'true' | 'false' | 'unknown';
type Comparison =
  | 'equal'
  | 'notEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'greaterThan'
  | 'greaterThanOrEqual';

export type ValidationScalar =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'integer'; readonly value: string }
  | { readonly kind: 'date'; readonly value: string }
  | {
      readonly kind: 'decimal';
      readonly value: string;
      readonly precision: number;
      readonly scale: number;
      readonly currency: string | null;
      readonly unit: string | null;
    };

export type ValidationOperand = Node &
  (
    | { readonly kind: 'literal'; readonly scalar: ValidationScalar }
    | {
        readonly kind: 'field';
        readonly fieldId: string;
        readonly select: 'value' | 'textLength';
      }
    | {
        readonly kind: 'path';
        readonly relationIds: readonly string[];
        readonly fieldId: string;
      }
  );

export type ValidationPredicate = Node &
  (
    | { readonly kind: 'required'; readonly operand: ValidationOperand }
    | {
        readonly kind: 'comparison';
        readonly operator: Comparison;
        readonly left: ValidationOperand;
        readonly right: ValidationOperand;
      }
    | { readonly kind: 'not'; readonly term: ValidationPredicate }
    | {
        readonly kind: 'all' | 'any';
        readonly terms: readonly ValidationPredicate[];
      }
  );

export type ResolvedOperand =
  | { readonly status: 'present'; readonly scalar: ValidationScalar }
  | { readonly status: 'absent' }
  | ValidationRefusal;

export type ValidationRefusal = {
  readonly status: 'refused';
  readonly code:
    'VALIDATION_OPERAND_UNREADABLE' | 'VALIDATION_OPERAND_MALFORMED';
};

type Evaluated = { readonly status: 'evaluated'; readonly value: Truth };
type Evaluation = Evaluated | ValidationRefusal;
type ReadOperand = (
  operand: Exclude<ValidationOperand, { kind: 'literal' }>,
) => ResolvedOperand;

const invert: Readonly<Record<Truth, Truth>> = {
  true: 'false',
  false: 'true',
  unknown: 'unknown',
};
const failedComparison: ValidationRefusal = {
  status: 'refused',
  code: 'VALIDATION_OPERAND_MALFORMED',
};

type Ordering = -1 | 0 | 1;

function compareOrdered<T extends string | bigint>(
  left: T,
  right: T,
): Ordering {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith('0000'))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().startsWith(value)
  );
}

function exactCoefficient(
  value: string,
  precision: number,
  scale: number,
): bigint | null {
  if (
    !Number.isInteger(precision) ||
    precision < 1 ||
    precision > 38 ||
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > 18 ||
    scale > precision ||
    value.length > 40 ||
    !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)
  )
    return null;
  const sign = value.startsWith('-') ? -1n : 1n;
  const [whole = '', fraction = ''] = (
    sign < 0n ? value.slice(1) : value
  ).split('.');
  const wholeDigits = whole === '0' ? 0 : whole.length;
  if (wholeDigits > precision - scale || fraction.length > scale) return null;
  return sign * BigInt(whole + fraction.padEnd(scale, '0'));
}

function compareScalars(
  left: ValidationScalar,
  right: ValidationScalar,
  operator: Comparison,
): Ordering | null {
  if (left.kind === 'integer' && right.kind === 'integer') {
    if (
      [left.value, right.value].some(
        (value) => value.length > 40 || !/^-?(?:0|[1-9][0-9]*)$/u.test(value),
      )
    )
      return null;
    return compareOrdered(BigInt(left.value), BigInt(right.value));
  }
  if (left.kind === 'decimal' && right.kind === 'decimal') {
    if (left.currency !== right.currency || left.unit !== right.unit)
      return null;
    const a = exactCoefficient(left.value, left.precision, left.scale);
    const b = exactCoefficient(right.value, right.precision, right.scale);
    if (a === null || b === null) return null;
    const scale = Math.max(left.scale, right.scale);
    return compareOrdered(
      a * 10n ** BigInt(scale - left.scale),
      b * 10n ** BigInt(scale - right.scale),
    );
  }
  if (left.kind === 'date' && right.kind === 'date') {
    if (![left.value, right.value].every(validCalendarDate)) return null;
    return compareOrdered(left.value, right.value);
  }
  if (operator === 'equal' || operator === 'notEqual') {
    if (left.kind === 'boolean' && right.kind === 'boolean')
      return left.value === right.value ? 0 : 1;
    if (left.kind === 'text' && right.kind === 'text')
      return left.value === right.value ? 0 : 1;
  }
  return null;
}

export function sameValidationValue(
  left: ValidationScalar | null,
  right: ValidationScalar | null,
): boolean {
  if (left === null || right === null) return left === right;
  return compareScalars(left, right, 'equal') === 0;
}

function compare(operator: Comparison, balance: Ordering): Truth {
  const holds = {
    equal: balance === 0,
    notEqual: balance !== 0,
    lessThan: balance < 0,
    lessThanOrEqual: balance <= 0,
    greaterThan: balance > 0,
    greaterThanOrEqual: balance >= 0,
  }[operator];
  return holds ? 'true' : 'false';
}

export function inspectValidation(
  predicate: ValidationPredicate,
  read: ReadOperand,
): Evaluation {
  const resolve = (operand: ValidationOperand): ResolvedOperand => {
    if (operand.kind === 'literal')
      return { status: 'present', scalar: operand.scalar };
    const resolved = read(operand);
    if (
      operand.kind !== 'field' ||
      operand.select !== 'textLength' ||
      resolved.status !== 'present'
    )
      return resolved;
    if (resolved.scalar.kind !== 'text') return failedComparison;
    return {
      status: 'present',
      scalar: {
        kind: 'integer',
        value: String(Array.from(resolved.scalar.value).length),
      },
    };
  };
  const walk = (term: ValidationPredicate, depth: number): Evaluation => {
    if (
      depth > STRUCTURAL_LIMITS_V0.maximumExpressionDepth ||
      term.schemaVersion !== VALIDATION_NODE_VERSION
    )
      return failedComparison;
    switch (term.kind) {
      case 'required': {
        const operand = resolve(term.operand);
        if (operand.status === 'refused') return operand;
        return {
          status: 'evaluated',
          value: operand.status === 'present' ? 'true' : 'false',
        };
      }
      case 'comparison': {
        const left = resolve(term.left);
        const right = resolve(term.right);
        if (left.status === 'refused') return left;
        if (right.status === 'refused') return right;
        if (left.status === 'absent' || right.status === 'absent')
          return { status: 'evaluated', value: 'unknown' };
        const balance = compareScalars(
          left.scalar,
          right.scalar,
          term.operator,
        );
        if (balance === null) return failedComparison;
        return { status: 'evaluated', value: compare(term.operator, balance) };
      }
      case 'not': {
        const child = walk(term.term, depth + 1);
        if (child.status === 'refused') return child;
        return { status: 'evaluated', value: invert[child.value] };
      }
      case 'all':
      case 'any': {
        const results = term.terms.map((child) => walk(child, depth + 1));
        const refused = results.find(
          (result): result is ValidationRefusal => result.status === 'refused',
        );
        if (refused) return refused;
        const decisive = term.kind === 'all' ? 'false' : 'true';
        if (
          results.some(
            (result) =>
              result.status === 'evaluated' && result.value === decisive,
          )
        ) {
          return { status: 'evaluated', value: decisive };
        }
        if (
          results.some(
            (result) =>
              result.status === 'evaluated' && result.value === 'unknown',
          )
        ) {
          return { status: 'evaluated', value: 'unknown' };
        }
        return { status: 'evaluated', value: invert[decisive] };
      }
    }
  };
  return walk(predicate, 1);
}
