import { z } from 'zod';

import { STRUCTURAL_LIMITS_V0 } from './constants.js';
import {
  VALIDATION_NODE_VERSION,
  type ValidationPredicate,
} from './formula-validation.js';

interface CanonicalValidationScalars {
  readonly canonicalId: z.ZodType<string>;
  readonly currencyCode: z.ZodType<string>;
  readonly date: z.ZodType<string>;
  readonly decimal: z.ZodType<string>;
  readonly integer: z.ZodType<string>;
}

export function formulaValidationRuleSchema({
  canonicalId,
  currencyCode,
  date,
  decimal,
  integer,
}: CanonicalValidationScalars) {
  const schemaVersion = z.literal(VALIDATION_NODE_VERSION);
  const scalar = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text'), value: z.string().max(4_000) }),
    z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
    z.strictObject({ kind: z.literal('integer'), value: integer }),
    z.strictObject({ kind: z.literal('date'), value: date }),
    z
      .strictObject({
        kind: z.literal('decimal'),
        value: decimal,
        precision: z.int().min(1).max(38),
        scale: z.int().min(0).max(18),
        currency: currencyCode.nullable(),
        unit: canonicalId.nullable(),
      })
      .refine(
        ({ precision, scale, currency, unit }) =>
          scale <= precision && (currency === null || unit === null),
      ),
  ]);
  const operand = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('literal'), schemaVersion, scalar }),
    z.strictObject({
      kind: z.literal('field'),
      schemaVersion,
      fieldId: canonicalId,
      select: z.enum(['value', 'textLength']),
    }),
    z.strictObject({
      kind: z.literal('path'),
      schemaVersion,
      fieldId: canonicalId,
      relationIds: z
        .array(canonicalId)
        .min(1)
        .max(STRUCTURAL_LIMITS_V0.maximumExpressionDepth),
    }),
  ]);
  const required = z.strictObject({
    kind: z.literal('required'),
    schemaVersion,
    operand,
  });
  const comparison = z.strictObject({
    kind: z.literal('comparison'),
    schemaVersion,
    operator: z.enum([
      'equal',
      'notEqual',
      'lessThan',
      'lessThanOrEqual',
      'greaterThan',
      'greaterThanOrEqual',
    ]),
    left: operand,
    right: operand,
  });

  function predicateAtDepth(depth: number): z.ZodType<ValidationPredicate> {
    if (depth === STRUCTURAL_LIMITS_V0.maximumExpressionDepth) {
      return z.discriminatedUnion('kind', [required, comparison]);
    }
    const child = z.lazy(() => predicateAtDepth(depth + 1));
    const terms = z.array(child).min(1).max(24);
    return z.discriminatedUnion('kind', [
      required,
      comparison,
      z.strictObject({ kind: z.literal('not'), schemaVersion, term: child }),
      z.strictObject({ kind: z.literal('all'), schemaVersion, terms }),
      z.strictObject({ kind: z.literal('any'), schemaVersion, terms }),
    ]);
  }

  return z.strictObject({
    kind: z.literal('validationRule'),
    schemaVersion,
    ruleId: canonicalId,
    targetId: canonicalId,
    boundOperationIds: z.array(canonicalId).min(1).max(16),
    trigger: z.strictObject({
      kind: z.literal('afterDefaultsOrChangedFields'),
      schemaVersion,
    }),
    absence: z.strictObject({
      kind: z.literal('validationThreeValued'),
      schemaVersion,
    }),
    effect: z.literal('refuse'),
    existingRecords: z.literal('grandfather'),
    message: z.string().min(1).max(240),
    fieldAnchors: z.array(canonicalId).min(1).max(24),
    predicate: predicateAtDepth(1),
  });
}

export type FormulaValidationRule = z.infer<
  ReturnType<typeof formulaValidationRuleSchema>
>;
