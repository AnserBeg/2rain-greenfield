import { z } from 'zod';

import type {
  DisplayArithmetic,
  DisplayDecimalType,
} from './calculated-display.js';

export type DisplayOperand = { readonly schemaVersion: 'v6' } & (
  | { readonly kind: 'field'; readonly fieldId: string }
  | {
      readonly kind: 'decimalLiteral';
      readonly value: string;
      readonly decimalType: DisplayDecimalType;
    }
);

export interface CalculatedDisplayField {
  readonly kind: 'calculatedDisplayField';
  readonly schemaVersion: 'v6';
  readonly fieldId: string;
  readonly entityId: string;
  readonly label: string;
  readonly expression: {
    readonly kind: 'decimalArithmetic';
    readonly schemaVersion: 'v6';
    readonly operator: DisplayArithmetic;
    readonly left: DisplayOperand;
    readonly right: DisplayOperand;
  };
  readonly resultType: DisplayDecimalType;
  readonly displaySinks: readonly {
    readonly kind: 'record' | 'list';
    readonly surfaceId: string;
  }[];
}

export function calculatedDisplayFieldSchema(
  canonicalId: z.ZodType<string>,
  label: z.ZodType<string>,
  decimal: z.ZodType<string>,
  currencyCode: z.ZodType<string>,
): z.ZodType<CalculatedDisplayField> {
  const decimalType = (precision: number, scale: number) =>
    z
      .strictObject({
        precision: z.int().min(1).max(precision),
        scale: z.int().min(0).max(scale),
        currency: currencyCode.nullable(),
        unit: canonicalId.nullable(),
      })
      .refine(
        (type) => type.scale <= type.precision && !(type.currency && type.unit),
      );
  const operand = z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('field'),
      schemaVersion: z.literal('v6'),
      fieldId: canonicalId,
    }),
    z.strictObject({
      kind: z.literal('decimalLiteral'),
      schemaVersion: z.literal('v6'),
      value: decimal,
      decimalType: decimalType(38, 18),
    }),
  ]);
  return z.strictObject({
    kind: z.literal('calculatedDisplayField'),
    schemaVersion: z.literal('v6'),
    fieldId: canonicalId,
    entityId: canonicalId,
    label,
    expression: z.strictObject({
      kind: z.literal('decimalArithmetic'),
      schemaVersion: z.literal('v6'),
      operator: z.enum(['add', 'subtract', 'multiply']),
      left: operand,
      right: operand,
    }),
    resultType: decimalType(76, 36),
    displaySinks: z
      .array(
        z.strictObject({
          kind: z.enum(['record', 'list']),
          surfaceId: canonicalId,
        }),
      )
      .min(1)
      .max(16),
  });
}
