import { z } from 'zod';

import {
  VALIDATION_KERNEL_VERSION,
  type BoundFormulaValidation,
} from './formula-validation-bindings.js';
import { VALIDATION_POSITION_PROFILE } from './formula-validation.js';
import { FormulaValidationRuleDefinitionSchema } from './schemas.js';

const watchedField = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['text', 'boolean', 'integer', 'date']) }),
  // ADR-0087: presence on a whole logical dateTime value.
  z.strictObject({ kind: z.literal('dateTime') }),
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
  watchedRelationIds: z.array(z.string()).min(1).optional(),
  paths: z
    .array(
      z.strictObject({
        relationId: z.string(),
        targetEntityId: z.string(),
        fieldId: z.string(),
        fieldType: watchedField,
        fieldClassification: z.enum(['public', 'internal']),
        readQueryId: z.string(),
        readPermissionId: z.string(),
      }),
    )
    .min(1)
    .optional(),
  contextDependencies: z.array(z.string()),
});

const validationProjection = z
  .object({
    kind: z.literal('formulaRulePayload'),
    schemaVersion: z.literal('northstar.formula-rule-payload/v1'),
    bindings: z.array(validationBinding).min(1).optional(),
    verificationBusinessDate: z.iso.date().optional(),
  })
  .refine(
    (value) =>
      Boolean(value.bindings) === Boolean(value.verificationBusinessDate),
  );

export function parseFormulaValidationBindings(
  payload: unknown,
): readonly BoundFormulaValidation[] {
  return (validationProjection.parse(payload).bindings ?? []).map(
    ({ watchedRelationIds, paths, ...binding }) => ({
      ...binding,
      ...(watchedRelationIds ? { watchedRelationIds } : {}),
      ...(paths ? { paths } : {}),
    }),
  );
}

export function formulaVerificationBusinessDate(payload: unknown): string {
  return z.iso
    .date()
    .parse(validationProjection.parse(payload).verificationBusinessDate);
}
