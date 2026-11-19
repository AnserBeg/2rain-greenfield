import {
  BUSINESS_DATE_FIELD_ID,
  type BoundFormulaValidation,
} from '../../canonical-model/src/formula-validation-bindings.js';
import {
  inspectValidation,
  sameValidationValue,
  type ResolvedOperand,
  type ValidationOperand,
  type ValidationScalar,
} from '../../canonical-model/src/formula-validation.js';

type Values = Readonly<Record<string, ValidationScalar | null>>;

interface SynthesizedInput {
  readonly values: Values;
  readonly previousValues?: Values;
}

interface ValidationInvocation {
  readonly operationId: string;
  readonly kind: 'create' | 'update';
  readonly businessDate: string;
}

export interface ValidationWitness extends SynthesizedInput {
  readonly invocation: ValidationInvocation;
}

interface ViolatingWitness extends ValidationWitness {
  readonly ruleId: string;
  readonly refusalCode: 'MODULE_VALIDATION_REFUSED';
  readonly message: string;
}

export type JointValidationWitnesses =
  | {
      readonly status: 'proved';
      readonly satisfying: ValidationWitness;
      readonly violating: readonly ViolatingWitness[];
    }
  | { readonly status: 'unproved'; readonly ruleIds: readonly string[] };

function readWitnessOperand(
  witness: ValidationWitness,
  operand: Exclude<ValidationOperand, { kind: 'literal' }>,
): ResolvedOperand {
  if (operand.kind === 'path')
    return { status: 'refused', code: 'VALIDATION_OPERAND_UNREADABLE' };
  if (operand.fieldId === BUSINESS_DATE_FIELD_ID) {
    return {
      status: 'present',
      scalar: { kind: 'date', value: witness.invocation.businessDate },
    };
  }
  const scalar = witness.values[operand.fieldId];
  return scalar ? { status: 'present', scalar } : { status: 'absent' };
}

function changesWatchedField(
  binding: BoundFormulaValidation,
  witness: ValidationWitness,
): boolean {
  if (witness.invocation.kind === 'create') return true;
  if (!witness.previousValues) return false;
  return Object.keys(binding.watchedFields).some(
    (fieldId) =>
      !sameValidationValue(
        witness.previousValues?.[fieldId] ?? null,
        witness.values[fieldId] ?? null,
      ),
  );
}

/** Select exact witnesses from compiler-synthesized, base-valid inputs. */
export function proveJointValidationWitnesses(
  invocation: ValidationInvocation,
  bindings: readonly BoundFormulaValidation[],
  inputs: Iterable<SynthesizedInput>,
): JointValidationWitnesses {
  const applicable = bindings.filter((binding) =>
    binding.rule.boundOperationIds.includes(invocation.operationId),
  );
  let satisfying: ValidationWitness | undefined;
  const violations = new Map<string, ViolatingWitness>();
  for (const input of inputs) {
    const witness = { ...input, invocation };
    const results = applicable.map((binding) =>
      inspectValidation(binding.rule.predicate, (operand) =>
        readWitnessOperand(witness, operand),
      ),
    );
    if (results.some((result) => result.status === 'refused')) continue;
    const falseBindings = applicable.filter(
      (_, index) =>
        results[index]?.status === 'evaluated' &&
        results[index].value === 'false',
    );
    if (
      !satisfying &&
      falseBindings.length === 0 &&
      applicable.every((binding) => changesWatchedField(binding, witness))
    )
      satisfying = witness;
    const onlyFailure =
      falseBindings.length === 1 ? falseBindings[0] : undefined;
    if (
      onlyFailure &&
      !violations.has(onlyFailure.rule.ruleId) &&
      changesWatchedField(onlyFailure, witness)
    ) {
      violations.set(onlyFailure.rule.ruleId, {
        ...witness,
        ruleId: onlyFailure.rule.ruleId,
        refusalCode: 'MODULE_VALIDATION_REFUSED',
        message: onlyFailure.rule.message,
      });
    }
    if (satisfying && violations.size === applicable.length) {
      return {
        status: 'proved',
        satisfying,
        violating: [...violations.values()],
      };
    }
  }
  return {
    status: 'unproved',
    ruleIds: applicable
      .map(({ rule }) => rule.ruleId)
      .filter((id) => !satisfying || !violations.has(id)),
  };
}
