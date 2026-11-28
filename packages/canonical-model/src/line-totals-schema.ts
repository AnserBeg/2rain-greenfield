import { z } from 'zod';

import type { DisplayArithmetic } from './calculated-display.js';

/** ADR-0094 declarations (see line-totals.ts). */
export type DerivedTerm =
  | { readonly kind: 'field'; readonly fieldId: string }
  | { readonly kind: 'decimalLiteral'; readonly value: string }
  | {
      readonly kind: 'arithmetic';
      readonly operator: DisplayArithmetic;
      readonly left: DerivedTerm;
      readonly right: DerivedTerm;
    };

export interface DerivedDecimalDeclaration {
  readonly schemaVersion: 'v6';
  readonly fieldId: string;
  readonly entityId: string;
  readonly expression: DerivedTerm;
  readonly rounding: 'halfAwayFromZero';
  readonly absentAs?:
    | readonly {
        readonly fieldId: string;
        readonly value: string;
      }[]
    | undefined;
}

export interface RollupDeclaration {
  readonly schemaVersion: 'v6';
  readonly fieldId: string;
  readonly entityId: string;
  readonly label: string;
  readonly relationId: string;
  readonly operator: 'sum';
  readonly aggregandFieldId: string;
  readonly maximumLines: number;
  readonly materialize: 'onRead' | 'stored';
}

export interface CreateOnlyFieldDeclaration {
  readonly schemaVersion: 'v6';
  readonly fieldId: string;
  readonly entityId: string;
}

export function lineTotalsSchemas(
  canonicalId: z.ZodType<string>,
  label: z.ZodType<string>,
  decimal: z.ZodType<string>,
) {
  const term: z.ZodType<DerivedTerm> = z.lazy(() =>
    z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('field'), fieldId: canonicalId }),
      z.strictObject({ kind: z.literal('decimalLiteral'), value: decimal }),
      z.strictObject({
        kind: z.literal('arithmetic'),
        operator: z.enum(['add', 'subtract', 'multiply']),
        left: term,
        right: term,
      }),
    ]),
  );
  const derivedDecimal: z.ZodType<DerivedDecimalDeclaration> = z.strictObject({
    schemaVersion: z.literal('v6'),
    fieldId: canonicalId,
    entityId: canonicalId,
    expression: term,
    rounding: z.literal('halfAwayFromZero'),
    absentAs: z
      .array(z.strictObject({ fieldId: canonicalId, value: decimal }))
      .min(1)
      .max(16)
      .optional(),
  });
  const rollup: z.ZodType<RollupDeclaration> = z.strictObject({
    schemaVersion: z.literal('v6'),
    fieldId: canonicalId,
    entityId: canonicalId,
    label,
    relationId: canonicalId,
    operator: z.literal('sum'),
    aggregandFieldId: canonicalId,
    maximumLines: z.int().min(1).max(100_000),
    materialize: z.enum(['onRead', 'stored']),
  });
  const createOnly: z.ZodType<CreateOnlyFieldDeclaration> = z.strictObject({
    schemaVersion: z.literal('v6'),
    fieldId: canonicalId,
    entityId: canonicalId,
  });
  return {
    derivedDecimals: z.array(derivedDecimal).min(1).max(128).optional(),
    rollups: z.array(rollup).min(1).max(64).optional(),
    createOnlyFields: z.array(createOnly).min(1).max(256).optional(),
  };
}
