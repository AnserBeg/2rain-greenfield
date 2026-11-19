import { parseFormulaValidationBindings } from '../../../packages/canonical-model/src/formula-validation-projection.js';
import type { RequestRuntimeView } from '@north-star/runtime/request-runtime-view';

export function validationRefusalForOperation(
  view: RequestRuntimeView,
  operationId: string,
  error: unknown,
) {
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
