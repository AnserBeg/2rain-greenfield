import {
  displayArithmeticType,
  type DisplayArithmetic,
  type DisplayDecimalType,
} from '../../canonical-model/src/calculated-display.js';
import type {
  CalculatedDisplayField,
  DisplayOperand,
} from '../../canonical-model/src/calculated-display-schema.js';
import { slug } from './apply.js';

export const DISPLAY_OPERATIONS = [
  ['add', 'Add'],
  ['subtract', 'Subtract'],
  ['multiply', 'Multiply'],
] as const satisfies readonly (readonly [DisplayArithmetic, string])[];

export interface CalculatedDisplayTarget {
  readonly entityId: string;
  readonly label: string;
  readonly recordSurfaceId: string;
  readonly fields: readonly {
    fieldId: string;
    label: string;
    valueType: DisplayDecimalType;
  }[];
  readonly lists: readonly {
    surfaceId: string;
    label: string;
    fields: readonly string[];
  }[];
}

export function calculatedDisplayDraft(
  target: CalculatedDisplayTarget,
  input: {
    readonly label: string;
    readonly operator: string;
    readonly leftFieldId: string;
    readonly rightFieldId: string;
    readonly listSurfaceId: string;
  },
): { kind: 'addCalculatedDisplayField'; field: CalculatedDisplayField } {
  const label = input.label.trim();
  if (!label || label.length > 80 || !/[\p{L}\p{N}]/u.test(label))
    throw new Error('Enter a field name of up to 80 characters.');
  const left = target.fields.find(
    ({ fieldId }) => fieldId === input.leftFieldId,
  );
  const right = target.fields.find(
    ({ fieldId }) => fieldId === input.rightFieldId,
  );
  const operator = DISPLAY_OPERATIONS.find(
    ([key]) => key === input.operator,
  )?.[0];
  if (!left || !right || !operator)
    throw new Error(
      'Choose two numeric fields and the operation to apply to them.',
    );
  const resultType = displayArithmeticType(
    operator,
    left.valueType,
    right.valueType,
  );
  if (!resultType)
    throw new Error(
      'That calculation combines incompatible currencies or units, or exceeds the exact decimal display bounds.',
    );
  const list = target.lists.find(
    ({ surfaceId }) => surfaceId === input.listSurfaceId,
  );
  if (
    input.listSurfaceId &&
    (!list ||
      !list.fields.includes(left.fieldId) ||
      !list.fields.includes(right.fieldId))
  )
    throw new Error(
      'Choose a list that already reads both fields used in the calculation.',
    );
  const [namespace, entityLocal = 'record'] = target.entityId.split(':entity.');
  const fieldId = `${namespace}:field.custom_${entityLocal}_${slug(label).slice(0, 45)}`;
  const operand = (fieldId: string): DisplayOperand => ({
    kind: 'field',
    schemaVersion: 'v6',
    fieldId,
  });
  return {
    kind: 'addCalculatedDisplayField',
    field: {
      kind: 'calculatedDisplayField',
      schemaVersion: 'v6',
      fieldId,
      entityId: target.entityId,
      label,
      expression: {
        kind: 'decimalArithmetic',
        schemaVersion: 'v6',
        operator,
        left: operand(left.fieldId),
        right: operand(right.fieldId),
      },
      resultType,
      displaySinks: [
        { kind: 'record', surfaceId: target.recordSurfaceId },
        ...(list ? [{ kind: 'list' as const, surfaceId: list.surfaceId }] : []),
      ],
    },
  };
}
