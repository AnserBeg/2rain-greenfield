import { parseFormulaValidationBindings } from '../../../packages/canonical-model/src/formula-validation-projection.js';
import type { FormulaValidationRule } from '@north-star/canonical-model';
import type { RequestRuntimeView } from '@north-star/runtime/request-runtime-view';

/** A refusal the form shows beside its field, keeping the user's values. */
export type FieldRefusal = Pick<
  FormulaValidationRule,
  'fieldAnchors' | 'message'
>;

export function validationRefusalForOperation(
  view: RequestRuntimeView,
  operationId: string,
  error: unknown,
): FieldRefusal | undefined {
  // CUSTOMIZE-6: a value outside a field's declared allowed values is a
  // field-level refusal with its own message ("Choose CAD, USD or EUR.").
  if (
    error instanceof Error &&
    'code' in error &&
    error.code === 'MODULE_FIELD_VALUE_NOT_ALLOWED' &&
    'subjectId' in error &&
    typeof error.subjectId === 'string'
  )
    return { fieldAnchors: [error.subjectId], message: error.message };
  const formula = view.projections.formulaRule;
  if (
    !formula ||
    !(error instanceof Error) ||
    !('code' in error) ||
    error.code !== 'MODULE_VALIDATION_REFUSED' ||
    !('subjectId' in error)
  )
    return undefined;
  return parseFormulaValidationBindings(formula.payload).find(
    ({ rule }) =>
      rule.ruleId === error.subjectId &&
      rule.boundOperationIds.includes(operationId),
  )?.rule;
}
