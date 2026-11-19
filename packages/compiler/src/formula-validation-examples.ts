import {
  BUSINESS_DATE_FIELD_ID,
  type BoundFormulaValidation,
} from '../../canonical-model/src/formula-validation-bindings.js';
import type {
  ValidationPredicate,
  ValidationScalar,
} from '../../canonical-model/src/formula-validation.js';
import type { VersionedNormalizedApplicationPackage } from '../../canonical-model/src/schemas.js';

type Field = Extract<
  VersionedNormalizedApplicationPackage,
  { languageVersion: 'v6' }
>['fields'][number];
type FieldType = BoundFormulaValidation['watchedFields'][string];
type Values = Readonly<Record<string, ValidationScalar | null>>;

type Bound = {
  readonly select: 'value' | 'textLength';
  readonly value: ValidationScalar;
};

const MAXIMUM_SYNTHESIZED_ROWS = 512;
const DAYS_IN_MILLISECONDS = 86_400_000;

function collectBounds(
  predicate: ValidationPredicate,
  businessDate: string,
  bounds: Map<string, Bound[]>,
): void {
  switch (predicate.kind) {
    case 'not':
      collectBounds(predicate.term, businessDate, bounds);
      return;
    case 'all':
    case 'any':
      for (const term of predicate.terms)
        collectBounds(term, businessDate, bounds);
      return;
    case 'comparison': {
      const { left, right } = predicate;
      if (left.kind !== 'field') return;
      const value =
        right.kind === 'literal'
          ? right.scalar
          : right.kind === 'field' && right.fieldId === BUSINESS_DATE_FIELD_ID
            ? { kind: 'date' as const, value: businessDate }
            : null;
      if (!value) return;
      const fieldBounds = bounds.get(left.fieldId) ?? [];
      fieldBounds.push({ select: left.select, value });
      bounds.set(left.fieldId, fieldBounds);
      return;
    }
    case 'required':
      return;
  }
}

function adjacentDates(value: string): readonly string[] {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time)) return [];
  return [-1, 0, 1]
    .map(
      (offset) =>
        new Date(time + offset * DAYS_IN_MILLISECONDS)
          .toISOString()
          .split('T')[0]!,
    )
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date));
}

function coefficientAtScale(value: string, scale: number): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (
    negative ? value.slice(1) : value
  ).split('.');
  const digits = whole + fraction.slice(0, scale).padEnd(scale, '0');
  return (negative ? -1n : 1n) * BigInt(digits);
}

function coefficientText(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = String(negative ? -value : value).padStart(scale + 1, '0');
  if (scale === 0) return (negative ? '-' : '') + digits;
  const fraction = digits.slice(-scale).replace(/0+$/u, '');
  return (
    (negative ? '-' : '') +
    digits.slice(0, -scale) +
    (fraction ? '.' + fraction : '')
  );
}

function syntheticScalars(
  field: Field,
  type: FieldType,
  bounds: readonly Bound[],
  businessDate: string,
): readonly ValidationScalar[] {
  switch (type.kind) {
    case 'boolean':
      return [true, false].map((value) => ({ kind: 'boolean', value }));
    case 'date': {
      const dates = [businessDate];
      for (const { value } of bounds)
        if (value.kind === 'date') dates.push(value.value);
      return [...new Set(dates.flatMap(adjacentDates))].map((value) => ({
        kind: 'date',
        value,
      }));
    }
    case 'integer': {
      const centers = [0n, 1n];
      for (const { value } of bounds) {
        if (value.kind === 'integer' && value.value.length <= 40)
          centers.push(BigInt(value.value));
      }
      const minimum = -(1n << 63n);
      const maximum = (1n << 63n) - 1n;
      return [
        ...new Set(centers.flatMap((value) => [value, value - 1n, value + 1n])),
      ]
        .filter((value) => value >= minimum && value <= maximum)
        .map((value) => ({ kind: 'integer', value: String(value) }));
    }
    case 'decimal': {
      const centers = [0n, 10n ** BigInt(type.scale)];
      for (const { value } of bounds) {
        if (value.kind === 'decimal')
          centers.push(coefficientAtScale(value.value, type.scale));
      }
      const maximum = 10n ** BigInt(type.precision) - 1n;
      return [
        ...new Set(centers.flatMap((value) => [value, value - 1n, value + 1n])),
      ]
        .filter((value) => value >= -maximum && value <= maximum)
        .map((value) => ({
          ...type,
          value: coefficientText(value, type.scale),
        }));
    }
    case 'text': {
      if (field.fieldType.kind !== 'textFieldType') return [];
      const limit = field.fieldType.maximumLength;
      const candidates = ['A', '', 'B'];
      for (const { select, value } of bounds) {
        if (value.kind === 'text' && select === 'value')
          candidates.push(value.value);
        if (value.kind === 'integer' && select === 'textLength') {
          const length = Number(value.value);
          if (!Number.isSafeInteger(length)) continue;
          for (const size of [length, length - 1, length + 1]) {
            if (size >= 0 && size <= limit) candidates.push('A'.repeat(size));
          }
        }
      }
      return [...new Set(candidates)]
        .filter((value) => value.length <= limit)
        .map((value) => ({ kind: 'text', value }));
    }
  }
}

/** Enumerate typed fixture values near the admitted literal and contextual bounds. */
export function synthesizeLiteralRows(
  bindings: readonly BoundFormulaValidation[],
  fields: readonly Field[],
  businessDate: string,
): readonly Values[] {
  const bounds = new Map<string, Bound[]>();
  const watchedFields = new Map<string, FieldType>();
  for (const binding of bindings) {
    collectBounds(binding.rule.predicate, businessDate, bounds);
    for (const [id, type] of Object.entries(binding.watchedFields))
      watchedFields.set(id, type);
  }
  const fieldById = new Map<string, Field>(
    fields.map((field) => [field.fieldId, field]),
  );
  let rows: Values[] = [{}];
  for (const fieldId of [...watchedFields.keys()].sort()) {
    const field = fieldById.get(fieldId);
    const type = watchedFields.get(fieldId);
    if (!field || !type) return [];
    const scalars = syntheticScalars(
      field,
      type,
      bounds.get(fieldId) ?? [],
      businessDate,
    );
    const options =
      field.presence === 'optional' ? [...scalars, null] : scalars;
    const expanded: Values[] = [];
    for (const row of rows) {
      for (const value of options) {
        expanded.push({ ...row, [fieldId]: value });
        if (expanded.length === MAXIMUM_SYNTHESIZED_ROWS) break;
      }
      if (expanded.length === MAXIMUM_SYNTHESIZED_ROWS) break;
    }
    rows = expanded;
  }
  return rows;
}
