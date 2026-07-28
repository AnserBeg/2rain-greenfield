import {
  LANGUAGE_VERSION,
  LEGACY_LANGUAGE_VERSION,
  PREVIOUS_LANGUAGE_VERSION,
  STRUCTURAL_LIMITS_V0,
  type CanonicalLanguageVersion,
} from './constants.js';
import {
  CanonicalReferenceSchema,
  CanonicalScalarSchema,
  type CanonicalScalar,
  type PredicateExpression,
} from './schemas.js';

export const PREDICATE_KERNEL_RECEIPT_VERSION =
  'northstar.predicate-kernel-receipt/v1' as const;

export const PREDICATE_POSITION_PROFILE_VERSION =
  'northstar.predicate-position-profile/v1' as const;

export const PREDICATE_LOWERING_PLAN_VERSION =
  'northstar.predicate-lowering-plan/postgres-row-v1' as const;

export type PredicateCostClass =
  | 'indexedEquality'
  | 'indexedFoldedEquality'
  | 'indexedPrefixRange'
  | 'tenantBoundedScan';

export type PredicateLoweringRowId =
  | 'northstar.predicate-lowering/folded-equality-v1'
  | 'northstar.predicate-lowering/tenant-scan-comparison-v1';

export type PredicateLoweringNode =
  | Readonly<{
      kind: 'booleanPredicate';
      value: boolean;
    }>
  | Readonly<{
      comparisonMode: 'binary' | 'unicodeCaseFold';
      costClass: PredicateCostClass;
      fieldId: string;
      kind: 'fieldComparisonPredicate';
      loweringRowId: PredicateLoweringRowId;
      operator: FieldComparisonPredicate['operator'];
      value: Readonly<CanonicalScalar>;
    }>
  | Readonly<{
      kind: 'allPredicate' | 'anyPredicate';
      terms: readonly PredicateLoweringNode[];
    }>
  | Readonly<{
      kind: 'notPredicate';
      term: PredicateLoweringNode;
    }>;

export interface PredicateLoweringPlan {
  readonly costClass: PredicateCostClass;
  readonly kind: 'predicateLoweringPlan';
  readonly positionProfileVersion: typeof PREDICATE_POSITION_PROFILE_VERSION;
  readonly predicateDigest: string;
  readonly root: PredicateLoweringNode;
  readonly schemaVersion: typeof PREDICATE_LOWERING_PLAN_VERSION;
}

export type PredicateBindingPosition =
  | 'derivation'
  | 'guard'
  | 'operationPrecondition'
  | 'queryFilter'
  | 'validation'
  | 'visibilityCondition';

export type PredicateFalseDisposition =
  | 'derive-false'
  | 'disable-guarded-path'
  | 'exclude-row'
  | 'hide-content'
  | 'reject-operation'
  | 'reject-value';

export interface PredicatePositionProfile {
  readonly absentComparison: 'false';
  readonly errorBehavior: 'reject-expression';
  readonly falseDisposition: PredicateFalseDisposition;
  readonly position: PredicateBindingPosition;
  readonly resultType: 'boolean';
  readonly schemaVersion: typeof PREDICATE_POSITION_PROFILE_VERSION;
}

/**
 * F1 is deliberately explicit per binding position. The comparison rule is
 * shared, while each position owns the meaning of a total `false` result.
 */
export const PREDICATE_POSITION_PROFILES: Readonly<
  Record<PredicateBindingPosition, PredicatePositionProfile>
> = Object.freeze({
  derivation: profile('derivation', 'derive-false'),
  guard: profile('guard', 'disable-guarded-path'),
  operationPrecondition: profile('operationPrecondition', 'reject-operation'),
  queryFilter: profile('queryFilter', 'exclude-row'),
  validation: profile('validation', 'reject-value'),
  visibilityCondition: profile('visibilityCondition', 'hide-content'),
});

export interface LiteralTruePredicate {
  readonly kind: 'booleanPredicate';
  readonly schemaVersion: CanonicalLanguageVersion;
  readonly value: true;
}

type FieldComparisonPredicate = Extract<
  PredicateExpression,
  { kind: 'fieldComparisonPredicate' }
>;

export type PredicateComparisonResolution =
  | Readonly<{ presence: 'absent' }>
  | Readonly<{ presence: 'present'; result: boolean }>;

export interface PredicateEvaluationOptions {
  readonly bindingPosition: PredicateBindingPosition;
  /**
   * A target-owned comparison evaluator supplies only present-value truth.
   * The kernel owns absence and Boolean composition, so targets cannot fork F1.
   */
  readonly resolveComparison: (
    comparison: Readonly<FieldComparisonPredicate>,
  ) => PredicateComparisonResolution;
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
      falseDisposition: PredicateFalseDisposition;
      kind: 'predicateKernelReceipt';
      outcome: 'evaluated';
      position: PredicateBindingPosition;
      positionProfileVersion: typeof PREDICATE_POSITION_PROFILE_VERSION;
      reason: 'evaluated-expression';
      result: boolean;
      schemaVersion: typeof PREDICATE_KERNEL_RECEIPT_VERSION;
    }>
  | Readonly<{
      kind: 'predicateKernelReceipt';
      nodeSchemaVersion: string | null;
      outcome: 'rejected';
      reason:
        | 'invalid-node-shape'
        | 'invalid-binding-position'
        | 'invalid-comparison-resolution'
        | 'expression-depth-exceeded'
        | 'unsupported-literal'
        | 'unsupported-node-kind'
        | 'unsupported-node-version';
      schemaVersion: typeof PREDICATE_KERNEL_RECEIPT_VERSION;
    }>;

export type PredicateKernelEntryPoint = (
  value: unknown,
  evaluation?: PredicateEvaluationOptions,
) => PredicateKernelReceipt;

/**
 * The strict wire-shaped kernel entry point. With one argument it preserves the
 * v0 runtime fence and admits only exact literal `true`. With an evaluation
 * request it executes the version-dispatched structural algebra while leaving
 * present scalar comparison to the selected target. Neither mode trusts current
 * authoring types as proof that pinned wire JSON is safe.
 */
export const inspectPredicateForExecution: PredicateKernelEntryPoint = (
  value,
  evaluation,
) => {
  if (evaluation !== undefined) {
    const parsed = parsePredicate(value, 1);
    if (parsed.outcome === 'rejected') return parsed;
    return evaluatePredicate(parsed.predicate, evaluation);
  }
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

type RejectedPredicateReceipt = Extract<
  PredicateKernelReceipt,
  { outcome: 'rejected' }
>;

type ParsedPredicate =
  | Readonly<{ outcome: 'parsed'; predicate: Readonly<PredicateExpression> }>
  | RejectedPredicateReceipt;

function parsePredicate(value: unknown, depth: number): ParsedPredicate {
  if (depth > STRUCTURAL_LIMITS_V0.maximumExpressionDepth) {
    return rejected(nodeVersion(value), 'expression-depth-exceeded');
  }
  if (!isRecord(value)) return rejected(null, 'invalid-node-shape');
  const version = supportedNodeVersion(value.schemaVersion);
  if (version === null) {
    return rejected(nodeVersion(value), 'unsupported-node-version');
  }

  switch (value.kind) {
    case 'booleanPredicate':
      if (
        !hasExactKeys(value, ['kind', 'schemaVersion', 'value']) ||
        typeof value.value !== 'boolean'
      ) {
        return rejected(version, 'invalid-node-shape');
      }
      return parsed(
        Object.freeze({
          kind: 'booleanPredicate',
          schemaVersion: version,
          value: value.value,
        }),
      );
    case 'fieldComparisonPredicate': {
      if (
        !hasExactKeys(value, [
          'field',
          'kind',
          'operator',
          'schemaVersion',
          'value',
        ]) ||
        !isComparisonOperator(value.operator)
      ) {
        return rejected(version, 'invalid-node-shape');
      }
      const field = CanonicalReferenceSchema.safeParse(value.field);
      const scalar = CanonicalScalarSchema.safeParse(value.value);
      if (
        !field.success ||
        field.data.kind !== 'fieldReference' ||
        !scalar.success
      ) {
        return rejected(version, 'invalid-node-shape');
      }
      return parsed(
        Object.freeze({
          field: Object.freeze(field.data),
          kind: 'fieldComparisonPredicate',
          operator: value.operator,
          schemaVersion: version,
          value: Object.freeze(scalar.data),
        }),
      );
    }
    case 'notPredicate': {
      if (!hasExactKeys(value, ['kind', 'schemaVersion', 'term'])) {
        return rejected(version, 'invalid-node-shape');
      }
      const term = parsePredicate(value.term, depth + 1);
      if (term.outcome === 'rejected') return term;
      return parsed(
        Object.freeze({
          kind: 'notPredicate',
          schemaVersion: version,
          term: term.predicate,
        }),
      );
    }
    case 'allPredicate':
    case 'anyPredicate': {
      if (
        !hasExactKeys(value, ['kind', 'schemaVersion', 'terms']) ||
        !Array.isArray(value.terms)
      ) {
        return rejected(version, 'invalid-node-shape');
      }
      const terms: PredicateExpression[] = [];
      for (const candidate of value.terms) {
        const term = parsePredicate(candidate, depth + 1);
        if (term.outcome === 'rejected') return term;
        terms.push(term.predicate as PredicateExpression);
      }
      return parsed(
        Object.freeze({
          kind: value.kind,
          schemaVersion: version,
          terms: Object.freeze(terms) as unknown as PredicateExpression[],
        }),
      );
    }
    default:
      return rejected(version, 'unsupported-node-kind');
  }
}

function evaluatePredicate(
  predicate: Readonly<PredicateExpression>,
  evaluation: PredicateEvaluationOptions,
): PredicateKernelReceipt {
  if (
    !Object.hasOwn(
      PREDICATE_POSITION_PROFILES,
      evaluation.bindingPosition as string,
    )
  ) {
    return rejected(predicate.schemaVersion, 'invalid-binding-position');
  }
  const profile = PREDICATE_POSITION_PROFILES[evaluation.bindingPosition];
  const result = evaluateNode(predicate, evaluation.resolveComparison);
  if (result === null) {
    return rejected(predicate.schemaVersion, 'invalid-comparison-resolution');
  }
  return Object.freeze({
    falseDisposition: profile.falseDisposition,
    kind: 'predicateKernelReceipt',
    outcome: 'evaluated',
    position: profile.position,
    positionProfileVersion: profile.schemaVersion,
    reason: 'evaluated-expression',
    result,
    schemaVersion: PREDICATE_KERNEL_RECEIPT_VERSION,
  });
}

function evaluateNode(
  predicate: Readonly<PredicateExpression>,
  resolveComparison: PredicateEvaluationOptions['resolveComparison'],
): boolean | null {
  switch (predicate.kind) {
    case 'booleanPredicate':
      return predicate.value;
    case 'fieldComparisonPredicate': {
      let resolution: unknown;
      try {
        resolution = resolveComparison(predicate);
      } catch {
        return null;
      }
      if (!isComparisonResolution(resolution)) return null;
      return resolution.presence === 'absent' ? false : resolution.result;
    }
    case 'notPredicate': {
      const result = evaluateNode(predicate.term, resolveComparison);
      return result === null ? null : !result;
    }
    case 'allPredicate':
    case 'anyPredicate': {
      // Evaluate every term: canonical term ordering may not conceal errors or
      // side effects behind short-circuit behavior.
      const results = predicate.terms.map((term) =>
        evaluateNode(term, resolveComparison),
      );
      if (results.some((result) => result === null)) return null;
      return predicate.kind === 'allPredicate'
        ? results.every((result) => result === true)
        : results.some((result) => result === true);
    }
  }
}

function parsed(predicate: Readonly<PredicateExpression>): ParsedPredicate {
  return Object.freeze({ outcome: 'parsed', predicate });
}

function supportedNodeVersion(value: unknown): CanonicalLanguageVersion | null {
  switch (value) {
    case LEGACY_LANGUAGE_VERSION:
      return LEGACY_LANGUAGE_VERSION;
    case PREVIOUS_LANGUAGE_VERSION:
      return PREVIOUS_LANGUAGE_VERSION;
    case LANGUAGE_VERSION:
      return LANGUAGE_VERSION;
    default:
      return null;
  }
}

function nodeVersion(value: unknown): string | null {
  return isRecord(value) && typeof value.schemaVersion === 'string'
    ? value.schemaVersion
    : null;
}

function isComparisonOperator(
  value: unknown,
): value is FieldComparisonPredicate['operator'] {
  return (
    value === 'equals' ||
    value === 'notEquals' ||
    value === 'lessThan' ||
    value === 'greaterThan'
  );
}

function isComparisonResolution(
  value: unknown,
): value is PredicateComparisonResolution {
  if (!isRecord(value)) return false;
  if (value.presence === 'absent') {
    return hasExactKeys(value, ['presence']);
  }
  return (
    value.presence === 'present' &&
    typeof value.result === 'boolean' &&
    hasExactKeys(value, ['presence', 'result'])
  );
}

function profile(
  position: PredicateBindingPosition,
  falseDisposition: PredicateFalseDisposition,
): PredicatePositionProfile {
  return Object.freeze({
    absentComparison: 'false',
    errorBehavior: 'reject-expression',
    falseDisposition,
    position,
    resultType: 'boolean',
    schemaVersion: PREDICATE_POSITION_PROFILE_VERSION,
  });
}

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
  reason: RejectedPredicateReceipt['reason'],
): RejectedPredicateReceipt {
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
