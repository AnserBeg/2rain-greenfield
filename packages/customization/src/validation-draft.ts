import {
  BUSINESS_DATE_FIELD_ID,
  type FormulaValidationFieldType,
} from '../../canonical-model/src/formula-validation-bindings.js';
import {
  VALIDATION_NODE_VERSION as schemaVersion,
  type ValidationOperand,
  type ValidationPredicate,
} from '../../canonical-model/src/formula-validation.js';

export interface LiteralValidationTarget {
  readonly entityId: string;
  readonly label: string;
  readonly operationIds: readonly string[];
  readonly fields: readonly {
    readonly fieldId: string;
    readonly label: string;
    readonly valueType: FormulaValidationFieldType;
  }[];
}

export function literalValidationDraft(
  target: LiteralValidationTarget,
  input: {
    readonly fieldId: string;
    readonly check: string;
    readonly limit: string;
    readonly message: string;
  },
) {
  const field = target.fields.find(({ fieldId }) => fieldId === input.fieldId);
  if (!field) throw new Error('Choose a field on this record type.');
  const left: ValidationOperand = {
    schemaVersion,
    kind: 'field',
    fieldId: field.fieldId,
    select: input.check === 'maximumLength' ? 'textLength' : 'value',
  };
  let predicate: ValidationPredicate;
  switch (input.check) {
    case 'required':
      predicate = { schemaVersion, kind: 'required', operand: left };
      break;
    case 'notBeforeToday':
      if (field.valueType.kind !== 'date')
        throw new Error('Choose a date field.');
      predicate = {
        schemaVersion,
        kind: 'comparison',
        left,
        operator: 'greaterThanOrEqual',
        right: {
          schemaVersion,
          kind: 'field',
          fieldId: BUSINESS_DATE_FIELD_ID,
          select: 'value',
        },
      };
      break;
    case 'minimum':
    case 'maximum':
    case 'maximumLength': {
      const value = input.limit.trim();
      const type = field.valueType;
      let right: ValidationOperand;
      if (input.check === 'maximumLength') {
        if (type.kind !== 'text') throw new Error('Choose a text field.');
        right = {
          schemaVersion,
          kind: 'literal',
          scalar: { kind: 'integer', value },
        };
      } else if (type.kind === 'decimal' || type.kind === 'integer') {
        right = {
          schemaVersion,
          kind: 'literal',
          scalar:
            type.kind === 'decimal'
              ? { ...type, value }
              : { kind: 'integer', value },
        };
      } else {
        throw new Error('Choose a number field.');
      }
      predicate = {
        schemaVersion,
        kind: 'comparison',
        operator:
          input.check === 'minimum' ? 'greaterThanOrEqual' : 'lessThanOrEqual',
        left,
        right,
      };
      break;
    }
    default:
      throw new Error('Choose a validation rule.');
  }
  const [namespace = '', localField = ''] = field.fieldId.split(':field.');
  return {
    kind: 'addValidation' as const,
    rule: {
      kind: 'validationRule' as const,
      schemaVersion,
      ruleId: `${namespace}:rule.custom_${localField}_${input.check.toLowerCase()}`,
      targetId: target.entityId,
      boundOperationIds: target.operationIds,
      trigger: { kind: 'afterDefaultsOrChangedFields' as const, schemaVersion },
      absence: { kind: 'validationThreeValued' as const, schemaVersion },
      effect: 'refuse' as const,
      existingRecords: 'grandfather' as const,
      message: input.message.trim(),
      fieldAnchors: [field.fieldId],
      predicate,
    },
  };
}
