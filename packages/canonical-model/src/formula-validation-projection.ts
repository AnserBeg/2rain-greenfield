import { z } from 'zod';

import {
  VALIDATION_KERNEL_VERSION,
  type BoundFormulaValidation,
} from './formula-validation-bindings.js';
import { VALIDATION_POSITION_PROFILE } from './formula-validation.js';
import { FormulaValidationRuleDefinitionSchema } from './schemas.js';

const watchedField = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['text', 'boolean', 'integer', 'date']) }),
  z
    .strictObject({
      kind: z.literal('decimal'),
      precision: z.int().min(1).max(38),
      scale: z.int().min(0).max(18),
      currency: z.string().nullable(),
      unit: z.string().nullable(),
    })
    .refine(({ precision, scale }) => scale <= precision),
]);

const validationBinding = z.object({
  rule: FormulaValidationRuleDefinitionSchema,
  bindingPosition: z.literal('validation'),
  phase: z.literal('transaction'),
  purity: z.literal('deterministic'),
  target: z.literal('transactionBoundServer'),
  resultType: z.literal('threeValuedBoolean'),
  positionProfile: z.literal(VALIDATION_POSITION_PROFILE),
  kernelVersion: z.literal(VALIDATION_KERNEL_VERSION),
  writeSet: z.literal('changedValues'),
  allowedSinks: z.tuple([z.literal('operationRefusal')]),
  explanation: z.literal('configuredMessageAndFieldAnchors'),
  watchedFields: z.record(z.string(), watchedField),
  contextDependencies: z.array(z.string()),
});

const validationProjection = z.object({
  kind: z.literal('formulaRulePayload'),
  schemaVersion: z.literal('northstar.formula-rule-payload/v1'),
  bindings: z.array(validationBinding).min(1),
  verificationBusinessDate: z.iso.date(),
});

export function parseFormulaValidationBindings(
  payload: unknown,
): readonly BoundFormulaValidation[] {
  return validationProjection.parse(payload).bindings;
}

export function formulaVerificationBusinessDate(payload: unknown): string {
  return validationProjection.parse(payload).verificationBusinessDate;
}
