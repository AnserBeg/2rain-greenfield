import type { BoundDisplayOperand } from '../../canonical-model/src/calculated-display-bindings.js';
import {
  decimalDisplayCoefficient,
  decimalDisplayText,
  evaluateDisplayArithmetic,
} from '../../canonical-model/src/calculated-display.js';
import {
  parseCalculatedDisplayProjection,
  type CalculatedDisplayProjectionEntry,
} from '../../canonical-model/src/calculated-display-projection.js';
import type { RequestRuntimeView } from './request-runtime-view.js';
import type {
  RegisteredQueryDefinition,
  SemanticRecordDto,
} from './semantic-query-gateway.js';

const byProjection = new WeakMap<
  object,
  ReadonlyMap<string, readonly CalculatedDisplayProjectionEntry[]>
>();

function fieldsForQuery(view: RequestRuntimeView, queryId: string) {
  const payload = view.projections.formulaRule?.payload;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !Object.hasOwn(payload, 'calculatedFields')
  )
    return [];
  let index = byProjection.get(payload);
  if (!index) {
    const byQuery = new Map<string, CalculatedDisplayProjectionEntry[]>();
    for (const entry of parseCalculatedDisplayProjection(payload)) {
      for (const query of new Set(
        entry.readSinks.map(({ queryId }) => queryId),
      )) {
        const fields = byQuery.get(query) ?? [];
        fields.push(entry);
        byQuery.set(query, fields);
      }
    }
    index = byQuery;
    byProjection.set(payload, index);
  }
  return index.get(queryId) ?? [];
}

export class CalculatedDisplayReadError extends Error {
  readonly code = 'CALCULATED_DISPLAY_INPUT_INVALID';
}

export function withCalculatedDisplay(
  view: RequestRuntimeView,
  definition: RegisteredQueryDefinition,
  record: SemanticRecordDto,
): SemanticRecordDto {
  const fields = fieldsForQuery(view, definition.queryId);
  if (!fields.length) return record;
  const selected = new Set(definition.selections.map(({ fieldId }) => fieldId));
  const read = (binding: BoundDisplayOperand): bigint | null => {
    const { operand, valueType } = binding;
    if (operand.kind === 'field' && !selected.has(operand.fieldId)) {
      throw new CalculatedDisplayReadError(
        'A field used in a calculation is outside the authorized read.',
      );
    }
    const value =
      operand.kind === 'field' ? record.values[operand.fieldId] : operand.value;
    if (value === null || value === undefined) return null;
    const decimal =
      typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : value;
    const coefficient =
      typeof decimal === 'string'
        ? decimalDisplayCoefficient(decimal, valueType)
        : null;
    if (coefficient === null)
      throw new CalculatedDisplayReadError(
        'A field used in a calculation has an invalid exact decimal value.',
      );
    return coefficient;
  };
  const values = { ...record.values };
  for (const { declaration, left, right, readSinks } of fields) {
    if (
      declaration.entityId !== record.entityId ||
      !readSinks.some(
        ({ queryId, permissionId }) =>
          queryId === definition.queryId &&
          permissionId === definition.permissionId,
      )
    ) {
      throw new CalculatedDisplayReadError(
        'A calculated field is outside the authorized read.',
      );
    }
    const a = read(left);
    const b = read(right);
    values[declaration.fieldId] =
      a === null || b === null
        ? null
        : decimalDisplayText(
            evaluateDisplayArithmetic(
              declaration.expression.operator,
              a,
              left.valueType.scale,
              b,
              right.valueType.scale,
            ),
            declaration.resultType.scale,
          );
  }
  return Object.freeze({ ...record, values: Object.freeze(values) });
}
