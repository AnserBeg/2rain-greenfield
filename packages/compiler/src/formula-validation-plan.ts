import {
  bindLiteralValidation,
  type BoundFormulaValidation,
} from '../../canonical-model/src/formula-validation-bindings.js';
import type { VersionedNormalizedApplicationPackage } from '../../canonical-model/src/schemas.js';

import { synthesizeLiteralRows } from './formula-validation-examples.js';
import {
  proveJointValidationWitnesses,
  type JointValidationWitnesses,
} from './formula-validation-witness.js';
import { hashCanonical } from './hash.js';

export const FORMULA_RULE_PAYLOAD_VERSION =
  'northstar.formula-rule-payload/v1' as const;
const FORMULA_RULE_IR_DOMAIN = 'northstar.formula-rule-ir/v1';
const VERIFICATION_BUSINESS_DATE = '2026-06-15';

type ProvedWitnesses = Extract<JointValidationWitnesses, { status: 'proved' }>;

type CompiledFormulaBinding = BoundFormulaValidation & {
  readonly irHash: string;
  readonly permissionIds: readonly string[];
  readonly fieldClassifications: Readonly<Record<string, string>>;
  readonly assertionOperationIds: readonly string[];
};

export interface FormulaRulePayload {
  readonly kind: 'formulaRulePayload';
  readonly schemaVersion: typeof FORMULA_RULE_PAYLOAD_VERSION;
  readonly bindings: readonly CompiledFormulaBinding[];
  readonly verificationBusinessDate: string;
  readonly witnesses: readonly ProvedWitnesses[];
}

export type FormulaValidationPlan =
  | { readonly status: 'absent' }
  | { readonly status: 'compiled'; readonly payload: FormulaRulePayload }
  | {
      readonly status: 'refused';
      readonly subjectId: string;
      readonly message: string;
    };

export function compileLiteralFormulaRules(
  revision: VersionedNormalizedApplicationPackage,
): FormulaValidationPlan {
  if (revision.languageVersion !== 'v6' || !revision.formulaRules)
    return { status: 'absent' };
  const fields = new Map<string, (typeof revision.fields)[number]>(
    revision.fields.map((field) => [field.fieldId, field]),
  );
  const operations = new Map<string, (typeof revision.operations)[number]>(
    revision.operations.map((operation) => [operation.operationId, operation]),
  );
  const byEntity = new Map<string, CompiledFormulaBinding[]>();
  const seenRuleIds = new Set<string>();
  const bindings: CompiledFormulaBinding[] = [];
  for (const rule of revision.formulaRules) {
    const result = bindLiteralValidation(rule, revision);
    if (result.status === 'refused' || seenRuleIds.has(rule.ruleId)) {
      return {
        status: 'refused',
        subjectId: rule.ruleId,
        message:
          result.status === 'refused'
            ? result.message
            : 'A validation rule ID must be unique.',
      };
    }
    const permissionIds = new Set<string>();
    for (const id of rule.boundOperationIds) {
      const operation = operations.get(id);
      if (!operation)
        return {
          status: 'refused',
          subjectId: id,
          message: 'The bound operation is unavailable.',
        };
      permissionIds.add(operation.permission.targetId);
    }
    const fieldClassifications = Object.fromEntries(
      Object.keys(result.binding.watchedFields).map((fieldId) => [
        fieldId,
        fields.get(fieldId)!.classification,
      ]),
    );
    const binding: CompiledFormulaBinding = {
      ...result.binding,
      irHash: hashCanonical(FORMULA_RULE_IR_DOMAIN, rule.predicate).digest,
      permissionIds: [...permissionIds].sort(),
      fieldClassifications,
      assertionOperationIds: rule.boundOperationIds,
    };
    seenRuleIds.add(rule.ruleId);
    bindings.push(binding);
    const entityBindings = byEntity.get(rule.targetId) ?? [];
    entityBindings.push(binding);
    byEntity.set(rule.targetId, entityBindings);
  }

  const witnesses: ProvedWitnesses[] = [];
  for (const entityBindings of byEntity.values()) {
    const rows = synthesizeLiteralRows(
      entityBindings,
      revision.fields,
      VERIFICATION_BUSINESS_DATE,
    );
    const ids = [
      ...new Set(entityBindings.flatMap(({ rule }) => rule.boundOperationIds)),
    ].sort();
    const creates = ids.filter(
      (id) => operations.get(id)?.effect.kind === 'createRecordEffect',
    );
    const updates = ids.filter(
      (id) => operations.get(id)?.effect.kind === 'updateRecordEffect',
    );
    let createFixture: (typeof rows)[number] | undefined;
    for (const operationId of creates) {
      const proof = proveJointValidationWitnesses(
        {
          operationId,
          kind: 'create',
          businessDate: VERIFICATION_BUSINESS_DATE,
        },
        entityBindings,
        rows.map((values) => ({ values })),
      );
      if (proof.status === 'unproved') {
        return {
          status: 'refused',
          subjectId: proof.ruleIds[0] ?? operationId,
          message:
            'The compiler could not prove both a satisfying and violating create example.',
        };
      }
      createFixture ??= proof.satisfying.values;
      witnesses.push(proof);
    }
    createFixture ??= rows[0];
    if (!createFixture) {
      return {
        status: 'refused',
        subjectId: ids[0] ?? entityBindings[0]!.rule.ruleId,
        message:
          'The compiler could not synthesize a valid fixture for this record type.',
      };
    }
    const previousValues = createFixture;
    for (const operationId of updates) {
      const proof = proveJointValidationWitnesses(
        {
          operationId,
          kind: 'update',
          businessDate: VERIFICATION_BUSINESS_DATE,
        },
        entityBindings,
        rows.map((values) => ({ previousValues, values })),
      );
      if (proof.status === 'unproved') {
        return {
          status: 'refused',
          subjectId: proof.ruleIds[0] ?? operationId,
          message:
            'The compiler could not prove both a satisfying and violating changed-field update.',
        };
      }
      witnesses.push(proof);
    }
  }

  return {
    status: 'compiled',
    payload: {
      kind: 'formulaRulePayload',
      schemaVersion: FORMULA_RULE_PAYLOAD_VERSION,
      bindings,
      verificationBusinessDate: VERIFICATION_BUSINESS_DATE,
      witnesses,
    },
  };
}
