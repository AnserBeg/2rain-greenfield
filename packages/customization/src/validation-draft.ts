import {
  BUSINESS_DATE_FIELD_ID,
  type FormulaValidationFieldType,
} from '../../canonical-model/src/formula-validation-bindings.js';
import {
  VALIDATION_NODE_VERSION as schemaVersion,
  type ValidationOperand,
  type ValidationPredicate,
} from '../../canonical-model/src/formula-validation.js';
import type { CustomizationPatch } from './patch.js';

type ValidationPatch = Extract<CustomizationPatch, { kind: 'addValidation' }>;
type ComparisonOperator = Extract<
  ValidationPredicate,
  { kind: 'comparison' }
>['operator'];
export const VALIDATION_COMPARISONS = [
  ['lessThanOrEqual', 'At most'],
  ['lessThan', 'Less than'],
  ['greaterThanOrEqual', 'At least'],
  ['greaterThan', 'Greater than'],
  ['equal', 'Equal to'],
  ['notEqual', 'Different from'],
] as const satisfies readonly (readonly [ComparisonOperator, string])[];

export interface LiteralValidationTarget {
  readonly entityId: string;
  readonly label: string;
  readonly operationIds: readonly string[];
  readonly fields: readonly {
    readonly fieldId: string;
    readonly label: string;
    readonly valueType: FormulaValidationFieldType;
  }[];
  readonly relatedFields?: readonly {
    readonly relationId: string;
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
  return validationPatch(
    target,
    field.fieldId,
    input.check.toLowerCase(),
    input.message,
    predicate,
  );
}

export function fieldComparisonValidationDraft(
  target: LiteralValidationTarget,
  input: {
    readonly fieldId: string;
    readonly operator: string;
    readonly otherFieldId: string;
    readonly relationId?: string;
    readonly message: string;
  },
): ValidationPatch {
  const operator = VALIDATION_COMPARISONS.find(
    ([choice]) => choice === input.operator,
  )?.[0];
  if (!operator) throw new Error('Choose how to compare the fields.');
  if (!target.fields.some(({ fieldId }) => fieldId === input.fieldId))
    throw new Error('Choose a field on this record type.');
  const right: ValidationOperand = input.relationId
    ? {
        schemaVersion,
        kind: 'path',
        relationIds: [input.relationId],
        fieldId: input.otherFieldId,
      }
    : {
        schemaVersion,
        kind: 'field',
        fieldId: input.otherFieldId,
        select: 'value',
      };
  const otherField = input.relationId
    ? target.relatedFields?.some(
        ({ relationId, fieldId }) =>
          relationId === input.relationId && fieldId === input.otherFieldId,
      )
    : input.otherFieldId !== input.fieldId &&
      target.fields.some(({ fieldId }) => fieldId === input.otherFieldId);
  if (!otherField) throw new Error('Choose another field to compare.');
  const [, relatedName = ''] = input.otherFieldId.split(':field.');
  const [, relationName = ''] = input.relationId?.split(':relation.') ?? [];
  return validationPatch(
    target,
    input.fieldId,
    [operator.toLowerCase(), relationName, relatedName]
      .filter(Boolean)
      .join('_'),
    input.message,
    {
      schemaVersion,
      kind: 'comparison',
      left: {
        schemaVersion,
        kind: 'field',
        fieldId: input.fieldId,
        select: 'value',
      },
      right,
      operator,
    },
  );
}

function validationPatch(
  target: LiteralValidationTarget,
  fieldId: string,
  idSuffix: string,
  message: string,
  predicate: ValidationPredicate,
): ValidationPatch {
  const [namespace = '', localField = ''] = fieldId.split(':field.');
  return {
    kind: 'addValidation' as const,
    rule: {
      kind: 'validationRule' as const,
      schemaVersion,
      ruleId: `${namespace}:rule.custom_${localField}_${idSuffix}`,
      targetId: target.entityId,
      boundOperationIds: [...target.operationIds],
      trigger: { kind: 'afterDefaultsOrChangedFields' as const, schemaVersion },
      absence: { kind: 'validationThreeValued' as const, schemaVersion },
      effect: 'refuse' as const,
      existingRecords: 'grandfather' as const,
      message: message.trim(),
      fieldAnchors: [fieldId],
      predicate,
    },
  };
}
