import { z } from 'zod';

import { canonicalizeAndHash } from './canonicalize.js';

import type { BoundCalculatedDisplayField } from './calculated-display-bindings.js';
import { CalculatedDisplayFieldDefinitionSchema } from './schemas.js';

export const CALCULATED_DISPLAY_QUERY_READER = 4;
export const DISPLAY_ARITHMETIC_KERNEL = 'northstar.display-arithmetic/v1';

const decimal = z
  .strictObject({
    precision: z.int().min(1).max(38),
    scale: z.int().min(0).max(18),
    currency: z.string().nullable(),
    unit: z.string().nullable(),
  })
  .refine(({ precision, scale }) => scale <= precision);
const operand = z.strictObject({
  operand: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('field'),
      schemaVersion: z.literal('v6'),
      fieldId: z.string(),
    }),
    z.strictObject({
      kind: z.literal('decimalLiteral'),
      schemaVersion: z.literal('v6'),
      value: z.string(),
      decimalType: decimal,
    }),
  ]),
  valueType: decimal,
});
const display = z.strictObject({
  declaration: CalculatedDisplayFieldDefinitionSchema,
  classification: z.enum(['public', 'internal']),
  left: operand,
  right: operand,
  readSinks: z
    .array(
      z.strictObject({
        kind: z.enum(['record', 'list']),
        surfaceId: z.string(),
        queryId: z.string(),
        permissionId: z.string(),
      }),
    )
    .min(1)
    .max(16),
  bindingPosition: z.literal('calculatedDisplay'),
  phase: z.literal('read'),
  purity: z.literal('deterministic'),
  kernelVersion: z.literal(DISPLAY_ARITHMETIC_KERNEL),
  allowedSinks: z.tuple([z.literal('queryDisplayValue')]),
  target: z.literal('authorizedQueryRow'),
  absence: z.literal('northstar.display-missing-is-null/v1'),
  malformedInput: z.literal('CALCULATED_DISPLAY_INPUT_INVALID'),
  explanation: z.literal('configuredDisplayLabel'),
  irHash: z.hash('sha256'),
  assertionQueryIds: z.array(z.string()).min(1),
});
const payload = z.object({
  kind: z.literal('formulaRulePayload'),
  schemaVersion: z.literal('northstar.formula-rule-payload/v1'),
  calculatedFields: z.array(display).min(1).max(128),
});

export type CalculatedDisplayProjectionEntry = BoundCalculatedDisplayField & {
  readonly bindingPosition: 'calculatedDisplay';
  readonly phase: 'read';
  readonly purity: 'deterministic';
  readonly kernelVersion: typeof DISPLAY_ARITHMETIC_KERNEL;
  readonly allowedSinks: readonly ['queryDisplayValue'];
  readonly target: 'authorizedQueryRow';
  readonly absence: 'northstar.display-missing-is-null/v1';
  readonly malformedInput: 'CALCULATED_DISPLAY_INPUT_INVALID';
  readonly explanation: 'configuredDisplayLabel';
  readonly irHash: string;
  readonly assertionQueryIds: readonly string[];
};

export function projectCalculatedDisplay(
  binding: BoundCalculatedDisplayField,
): CalculatedDisplayProjectionEntry {
  return {
    ...binding,
    bindingPosition: 'calculatedDisplay',
    phase: 'read',
    purity: 'deterministic',
    kernelVersion: DISPLAY_ARITHMETIC_KERNEL,
    allowedSinks: ['queryDisplayValue'],
    target: 'authorizedQueryRow',
    absence: 'northstar.display-missing-is-null/v1',
    malformedInput: 'CALCULATED_DISPLAY_INPUT_INVALID',
    explanation: 'configuredDisplayLabel',
    irHash: canonicalizeAndHash({
      domain: 'northstar.display-arithmetic-ir/v1',
      expression: binding.declaration.expression,
      leftType: binding.left.valueType,
      rightType: binding.right.valueType,
      resultType: binding.declaration.resultType,
    }).contentHash,
    assertionQueryIds: [
      ...new Set(binding.readSinks.map(({ queryId }) => queryId)),
    ].sort(),
  };
}

export function parseCalculatedDisplayProjection(
  input: unknown,
): readonly CalculatedDisplayProjectionEntry[] {
  return payload.parse(input).calculatedFields;
}
