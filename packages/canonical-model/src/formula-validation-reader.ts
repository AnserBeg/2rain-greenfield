import { BUSINESS_DATE_FIELD_ID } from './formula-validation-bindings.js';
import type { FormulaValidationRule } from './formula-validation-schema.js';
import type { ValidationPredicate } from './formula-validation.js';

export const LITERAL_VALIDATION_OPERATION_READER = 3;
export const CROSS_FIELD_VALIDATION_OPERATION_READER = 4;

export function requiredFormulaValidationOperationReader(
  rules: readonly FormulaValidationRule[],
):
  | typeof LITERAL_VALIDATION_OPERATION_READER
  | typeof CROSS_FIELD_VALIDATION_OPERATION_READER {
  return rules.some(({ predicate }) => usesOtherField(predicate))
    ? CROSS_FIELD_VALIDATION_OPERATION_READER
    : LITERAL_VALIDATION_OPERATION_READER;
}

function usesOtherField(predicate: ValidationPredicate): boolean {
  switch (predicate.kind) {
    case 'all':
    case 'any':
      return predicate.terms.some(usesOtherField);
    case 'not':
      return usesOtherField(predicate.term);
    case 'required':
      return false;
    case 'comparison':
      return (
        predicate.right.kind === 'path' ||
        (predicate.right.kind === 'field' &&
          predicate.right.fieldId !== BUSINESS_DATE_FIELD_ID)
      );
  }
}
