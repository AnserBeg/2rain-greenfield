import { CanonicalIdSchema } from './schemas.js';

export const QUERY_AGGREGATE_PROFILE_VERSION =
  'northstar.query-aggregate-profile/v1' as const;

export const QUERY_AGGREGATE_KERNEL_RECEIPT_VERSION =
  'northstar.query-aggregate-kernel-receipt/v1' as const;

export const QUERY_AGGREGATE_CONTRACT_V1 = Object.freeze({
  admittedFieldTypes: Object.freeze([
    'exactDecimalFieldType',
    'quantityFieldType',
  ] as const),
  admittedOperators: Object.freeze(['sum'] as const),
  archivedRows: 'excluded' as const,
  cardinality: 'exactly-one-scalar-result' as const,
  costClass: 'tenantBoundedScan' as const,
  emptyInput: 'typed-zero' as const,
  grouping: 'unsupported' as const,
  rowSetConjunctions: Object.freeze([
    'tenant',
    'environment',
    'archive',
    'policy',
    'queryFilter',
    'effectiveTimeWhenSupplied',
  ] as const),
  optionalAggregand: 'rejected' as const,
  parameterBinding: 'typed-query-parameter-reference' as const,
  providerProbeId: 'Q1-P3b/required-sum-tenant-bounded-scan' as const,
  resultPrecision: 38 as const,
  schemaVersion: QUERY_AGGREGATE_PROFILE_VERSION,
});

export type QueryAggregateFieldContract =
  | Readonly<{
      fieldId: string;
      kind: 'exactDecimalFieldType';
      precision: number;
      presence: 'optional' | 'required';
      scale: number;
    }>
  | Readonly<{
      baseUnitId: string;
      fieldId: string;
      kind: 'quantityFieldType';
      precision: number;
      presence: 'optional' | 'required';
      scale: number;
    }>;

export type QueryAggregateElement =
  | Readonly<{ presence: 'absent' }>
  | Readonly<{ presence: 'present'; value: string }>;

export interface QueryAggregateEvaluationRequest {
  readonly elements: readonly QueryAggregateElement[];
  readonly field: QueryAggregateFieldContract;
  readonly operator: 'sum';
  readonly profileVersion: typeof QUERY_AGGREGATE_PROFILE_VERSION;
}

export type QueryAggregateKernelReceipt =
  | Readonly<{
      costClass: 'tenantBoundedScan';
      fieldId: string;
      kind: 'queryAggregateKernelReceipt';
      operator: 'sum';
      outcome: 'evaluated';
      result:
        | Readonly<{
            kind: 'exactDecimalResult';
            precision: 38;
            scale: number;
            value: string;
          }>
        | Readonly<{
            baseUnitId: string;
            kind: 'quantityResult';
            precision: 38;
            scale: number;
            value: string;
          }>;
      schemaVersion: typeof QUERY_AGGREGATE_KERNEL_RECEIPT_VERSION;
    }>
  | Readonly<{
      kind: 'queryAggregateKernelReceipt';
      outcome: 'rejected';
      reason:
        | 'invalid-element-shape'
        | 'invalid-field-contract'
        | 'invalid-request-shape'
        | 'numeric-overflow'
        | 'optional-aggregand'
        | 'required-element-absent'
        | 'unsupported-field-type'
        | 'unsupported-operator'
        | 'unsupported-profile-version';
      schemaVersion: typeof QUERY_AGGREGATE_KERNEL_RECEIPT_VERSION;
    }>;

/**
 * Pure-server reference evaluator for ADR-0022's query-level aggregate
 * semantics. This is not a serialized canonical query node: v2 remains closed
 * and rejects aggregate selections. The future language version will serialize
 * the ruled shape, while PostgreSQL remains a separate execution target whose
 * lowering must prove parity against this evaluator.
 */
export function evaluateQueryAggregateSemantics(
  value: unknown,
): QueryAggregateKernelReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['elements', 'field', 'operator', 'profileVersion'])
  ) {
    return rejected('invalid-request-shape');
  }
  if (value.profileVersion !== QUERY_AGGREGATE_PROFILE_VERSION) {
    return rejected('unsupported-profile-version');
  }
  if (value.operator !== 'sum') {
    return rejected('unsupported-operator');
  }
  if (!Array.isArray(value.elements)) {
    return rejected('invalid-request-shape');
  }
  const field = parseFieldContract(value.field);
  if (field.outcome === 'rejected') return field;
  if (field.field.presence === 'optional') {
    return rejected('optional-aggregand');
  }

  let total = 0n;
  for (const element of value.elements) {
    if (!isRecord(element) || typeof element.presence !== 'string') {
      return rejected('invalid-element-shape');
    }
    if (element.presence === 'absent') {
      if (!hasExactKeys(element, ['presence'])) {
        return rejected('invalid-element-shape');
      }
      return rejected('required-element-absent');
    }
    if (
      element.presence !== 'present' ||
      !hasExactKeys(element, ['presence', 'value']) ||
      typeof element.value !== 'string'
    ) {
      return rejected('invalid-element-shape');
    }
    const scaled = parseScaledDecimal(
      element.value,
      field.field.precision,
      field.field.scale,
    );
    if (scaled === null) return rejected('invalid-element-shape');
    total += scaled;
  }

  if (digitCount(total) > QUERY_AGGREGATE_CONTRACT_V1.resultPrecision) {
    return rejected('numeric-overflow');
  }
  const common = {
    precision: QUERY_AGGREGATE_CONTRACT_V1.resultPrecision,
    scale: field.field.scale,
    value: formatScaledDecimal(total, field.field.scale),
  } as const;
  return Object.freeze({
    costClass: QUERY_AGGREGATE_CONTRACT_V1.costClass,
    fieldId: field.field.fieldId,
    kind: 'queryAggregateKernelReceipt' as const,
    operator: 'sum' as const,
    outcome: 'evaluated' as const,
    result:
      field.field.kind === 'quantityFieldType'
        ? Object.freeze({
            ...common,
            baseUnitId: field.field.baseUnitId,
            kind: 'quantityResult' as const,
          })
        : Object.freeze({
            ...common,
            kind: 'exactDecimalResult' as const,
          }),
    schemaVersion: QUERY_AGGREGATE_KERNEL_RECEIPT_VERSION,
  });
}

type ParsedField =
  | Readonly<{ field: QueryAggregateFieldContract; outcome: 'parsed' }>
  | Extract<QueryAggregateKernelReceipt, { outcome: 'rejected' }>;

function parseFieldContract(value: unknown): ParsedField {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return rejected('invalid-field-contract');
  }
  if (
    value.kind !== 'exactDecimalFieldType' &&
    value.kind !== 'quantityFieldType'
  ) {
    return rejected('unsupported-field-type');
  }
  const expectedKeys =
    value.kind === 'quantityFieldType'
      ? ['baseUnitId', 'fieldId', 'kind', 'precision', 'presence', 'scale']
      : ['fieldId', 'kind', 'precision', 'presence', 'scale'];
  if (
    !hasExactKeys(value, expectedKeys) ||
    CanonicalIdSchema.safeParse(value.fieldId).success === false ||
    (value.presence !== 'optional' && value.presence !== 'required') ||
    !Number.isInteger(value.precision) ||
    !Number.isInteger(value.scale) ||
    typeof value.precision !== 'number' ||
    typeof value.scale !== 'number' ||
    value.precision < 1 ||
    value.precision > 38 ||
    value.scale < 0 ||
    value.scale > 18 ||
    value.scale > value.precision
  ) {
    return rejected('invalid-field-contract');
  }
  if (
    value.kind === 'quantityFieldType' &&
    CanonicalIdSchema.safeParse(value.baseUnitId).success === false
  ) {
    return rejected('invalid-field-contract');
  }
  const common = {
    fieldId: value.fieldId as string,
    precision: value.precision as number,
    presence: value.presence as 'optional' | 'required',
    scale: value.scale as number,
  };
  return Object.freeze({
    field:
      value.kind === 'quantityFieldType'
        ? Object.freeze({
            ...common,
            baseUnitId: value.baseUnitId as string,
            kind: value.kind,
          })
        : Object.freeze({ ...common, kind: value.kind }),
    outcome: 'parsed' as const,
  });
}

function parseScaledDecimal(
  value: string,
  precision: number,
  scale: number,
): bigint | null {
  if (!isAggregateDecimal(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '', fraction = ''] = unsigned.split('.');
  const integerDigits = integer === '0' ? 0 : integer.length;
  if (fraction.length > scale || integerDigits > precision - scale) {
    return null;
  }
  const magnitude = BigInt(`${integer}${fraction.padEnd(scale, '0')}`);
  return negative ? -magnitude : magnitude;
}

function isAggregateDecimal(value: string): boolean {
  // ADR-0022 closes the v2 scalar hole for negative sub-unit quantities in the
  // future language version: -0.25 is canonical, while -0 remains forbidden.
  return value !== '-0' && /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u.test(value);
}

function formatScaledDecimal(value: bigint, scale: number): string {
  if (value === 0n) return '0';
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(scale + 1, '0');
  const integer = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? '' : digits.slice(-scale).replace(/0+$/u, '');
  return `${negative ? '-' : ''}${integer}${fraction === '' ? '' : `.${fraction}`}`;
}

function digitCount(value: bigint): number {
  return (value < 0n ? -value : value).toString().length;
}

function rejected(
  reason: Extract<
    QueryAggregateKernelReceipt,
    { outcome: 'rejected' }
  >['reason'],
): Extract<QueryAggregateKernelReceipt, { outcome: 'rejected' }> {
  return Object.freeze({
    kind: 'queryAggregateKernelReceipt' as const,
    outcome: 'rejected' as const,
    reason,
    schemaVersion: QUERY_AGGREGATE_KERNEL_RECEIPT_VERSION,
  });
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
