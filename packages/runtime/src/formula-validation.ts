import {
  BUSINESS_DATE_FIELD_ID,
  type BoundFormulaValidation,
} from '../../canonical-model/src/formula-validation-bindings.js';
import {
  inspectValidation,
  sameValidationValue,
  type ResolvedOperand,
  type ValidationScalar,
} from '../../canonical-model/src/formula-validation.js';

type RawValues = Readonly<Record<string, unknown>>;
type FieldType = BoundFormulaValidation['watchedFields'][string];

interface ValidationMutation {
  readonly operationId: string;
  readonly businessDate: string | null;
  readonly values: RawValues;
  readonly previousValues?: RawValues;
  readonly updatedFieldIds?: readonly string[];
  readonly previousRelationKeys?: Readonly<Record<string, string | null>>;
  readonly relationKeys?: Readonly<Record<string, string | null>>;
  readonly pathValues?: Readonly<Record<string, RawValues | null>>;
}

interface RuleRefusal {
  readonly ruleId: string;
  readonly fieldAnchors: readonly string[];
  readonly code:
    | 'MODULE_VALIDATION_REFUSED'
    | 'MODULE_VALIDATION_OPERAND_UNREADABLE'
    | 'MODULE_VALIDATION_OPERAND_MALFORMED';
  readonly message: string;
}

const unreadable = {
  status: 'refused',
  code: 'VALIDATION_OPERAND_UNREADABLE',
} as const;
const malformed = {
  status: 'refused',
  code: 'VALIDATION_OPERAND_MALFORMED',
} as const;

function readField(
  values: RawValues,
  fieldId: string,
  type: FieldType,
): ResolvedOperand {
  if (!Object.hasOwn(values, fieldId)) return unreadable;
  const value = values[fieldId];
  if (value === null) return { status: 'absent' };
  if (type.kind === 'boolean') {
    return typeof value === 'boolean'
      ? { status: 'present', scalar: { kind: 'boolean', value } }
      : malformed;
  }
  if (typeof value !== 'string') return malformed;
  const scalar: ValidationScalar =
    type.kind === 'decimal' ? { ...type, value } : { kind: type.kind, value };
  return sameValidationValue(scalar, scalar)
    ? { status: 'present', scalar }
    : malformed;
}

function scalarOrNull(
  value: Exclude<ResolvedOperand, { status: 'refused' }>,
): ValidationScalar | null {
  return value.status === 'present' ? value.scalar : null;
}

/** Evaluate the active operation guards against a complete, scoped mutation row. */
export function observeValidationRefusals(
  bindings: readonly BoundFormulaValidation[],
  mutation: ValidationMutation,
): readonly RuleRefusal[] {
  const refusals: RuleRefusal[] = [];
  const updated = new Set(
    mutation.updatedFieldIds ?? Object.keys(mutation.values),
  );
  for (const binding of bindings) {
    const rule = binding.rule;
    if (!rule.boundOperationIds.includes(mutation.operationId)) continue;
    let watchedValueChanged =
      mutation.previousValues === undefined ||
      (binding.watchedRelationIds ?? []).some(
        (relationId) =>
          (mutation.previousRelationKeys?.[relationId] ?? null) !==
          (mutation.relationKeys?.[relationId] ?? null),
      );
    const resolved = new Map<string, ResolvedOperand>();
    for (const [fieldId, type] of Object.entries(binding.watchedFields)) {
      const next = readField(mutation.values, fieldId, type);
      resolved.set(fieldId, next);
      if (!mutation.previousValues || !updated.has(fieldId)) continue;
      const prior = readField(mutation.previousValues, fieldId, type);
      if (prior.status === 'refused' || next.status === 'refused') {
        watchedValueChanged = true;
      } else if (
        !sameValidationValue(scalarOrNull(prior), scalarOrNull(next))
      ) {
        watchedValueChanged = true;
      }
    }
    if (!watchedValueChanged) continue;

    const evaluated = inspectValidation(rule.predicate, (operand) => {
      if (operand.kind === 'path') {
        const [relationId] = operand.relationIds;
        const path = binding.paths?.find(
          (candidate) =>
            candidate.relationId === relationId &&
            candidate.fieldId === operand.fieldId,
        );
        if (!path || operand.relationIds.length !== 1) return unreadable;
        const related = mutation.pathValues?.[path.relationId];
        if (related === null) return { status: 'absent' };
        return related
          ? readField(related, path.fieldId, path.fieldType)
          : unreadable;
      }
      if (operand.fieldId === BUSINESS_DATE_FIELD_ID) {
        return mutation.businessDate === null
          ? unreadable
          : {
              status: 'present',
              scalar: { kind: 'date', value: mutation.businessDate },
            };
      }
      return resolved.get(operand.fieldId) ?? unreadable;
    });
    if (evaluated.status === 'evaluated' && evaluated.value !== 'false')
      continue;
    refusals.push({
      ruleId: rule.ruleId,
      fieldAnchors: rule.fieldAnchors,
      code:
        evaluated.status === 'evaluated'
          ? 'MODULE_VALIDATION_REFUSED'
          : evaluated.code === 'VALIDATION_OPERAND_UNREADABLE'
            ? 'MODULE_VALIDATION_OPERAND_UNREADABLE'
            : 'MODULE_VALIDATION_OPERAND_MALFORMED',
      message: rule.message,
    });
  }
  return refusals;
}
