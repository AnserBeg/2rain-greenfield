import {
  LANGUAGE_VERSION,
  LEGACY_LANGUAGE_VERSION,
  PREVIOUS_LANGUAGE_VERSION,
  type CanonicalLanguageVersion,
} from './constants.js';

export const PREDICATE_KERNEL_RECEIPT_VERSION =
  'northstar.predicate-kernel-receipt/v1' as const;

export interface LiteralTruePredicate {
  readonly kind: 'booleanPredicate';
  readonly schemaVersion: CanonicalLanguageVersion;
  readonly value: true;
}

export type PredicateKernelReceipt =
  | Readonly<{
      kind: 'predicateKernelReceipt';
      outcome: 'accepted';
      predicate: LiteralTruePredicate;
      reason: 'literal-true';
      schemaVersion: typeof PREDICATE_KERNEL_RECEIPT_VERSION;
    }>
  | Readonly<{
      kind: 'predicateKernelReceipt';
      nodeSchemaVersion: string | null;
      outcome: 'rejected';
      reason:
        | 'invalid-node-shape'
        | 'unsupported-literal'
        | 'unsupported-node-kind'
        | 'unsupported-node-version';
      schemaVersion: typeof PREDICATE_KERNEL_RECEIPT_VERSION;
    }>;

export type PredicateKernelEntryPoint = (
  value: unknown,
) => PredicateKernelReceipt;

/**
 * The v0 runtime fence. It deliberately admits only the executable subset that
 * existed before the expression kernel was ratified: an exact literal `true`.
 * Input is untrusted wire JSON, so dispatch is by the node's own version and the
 * shape is closed independently of the current authoring schema.
 */
export const inspectPredicateForExecution: PredicateKernelEntryPoint = (
  value,
) => {
  if (!isRecord(value)) {
    return rejected(null, 'invalid-node-shape');
  }
  const nodeSchemaVersion =
    typeof value.schemaVersion === 'string' ? value.schemaVersion : null;
  if (value.kind !== 'booleanPredicate') {
    return rejected(nodeSchemaVersion, 'unsupported-node-kind');
  }
  if (!hasExactKeys(value, ['kind', 'schemaVersion', 'value'])) {
    return rejected(nodeSchemaVersion, 'invalid-node-shape');
  }
  switch (value.schemaVersion) {
    case LEGACY_LANGUAGE_VERSION:
      return inspectLiteralForVersion(value, LEGACY_LANGUAGE_VERSION);
    case PREVIOUS_LANGUAGE_VERSION:
      return inspectLiteralForVersion(value, PREVIOUS_LANGUAGE_VERSION);
    case LANGUAGE_VERSION:
      return inspectLiteralForVersion(value, LANGUAGE_VERSION);
    default:
      return rejected(nodeSchemaVersion, 'unsupported-node-version');
  }
};

function inspectLiteralForVersion(
  value: Readonly<Record<string, unknown>>,
  schemaVersion: CanonicalLanguageVersion,
): PredicateKernelReceipt {
  if (value.value !== true) {
    return rejected(schemaVersion, 'unsupported-literal');
  }
  return Object.freeze({
    kind: 'predicateKernelReceipt',
    outcome: 'accepted',
    predicate: Object.freeze({
      kind: 'booleanPredicate',
      schemaVersion,
      value: true,
    }),
    reason: 'literal-true',
    schemaVersion: PREDICATE_KERNEL_RECEIPT_VERSION,
  });
}

function rejected(
  nodeSchemaVersion: string | null,
  reason: Extract<PredicateKernelReceipt, { outcome: 'rejected' }>['reason'],
): PredicateKernelReceipt {
  return Object.freeze({
    kind: 'predicateKernelReceipt',
    nodeSchemaVersion,
    outcome: 'rejected',
    reason,
    schemaVersion: PREDICATE_KERNEL_RECEIPT_VERSION,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => actual[index] === key)
  );
}
