import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  bindLiteralValidation,
  retypedFormulaRule,
} from '../../packages/canonical-model/src/formula-validation-bindings.js';
import { canonicalize } from '../../packages/canonical-model/src/canonicalize.js';
import type { FormulaValidationRule } from '../../packages/canonical-model/src/formula-validation-schema.js';
import {
  normalizeApplicationPackage,
  parseVersionedAuthoredApplicationPackageJson,
} from '../../packages/canonical-model/src/normalize.js';
import { compileLiteralFormulaRules } from '../../packages/compiler/src/formula-validation-plan.js';
import { compileApplication } from '../../packages/compiler/src/index.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/protocol.js';
import { proveJointValidationWitnesses } from '../../packages/compiler/src/formula-validation-witness.js';
import { applyCustomizationPatches } from '../../packages/customization/src/apply.js';
import { parseCustomizationPatch } from '../../packages/customization/src/patch.js';
import { observeValidationRefusals } from '../../packages/runtime/src/formula-validation.js';
import { compilerInput, mustCompile } from '../compiler/helpers.js';

import {
  inspectValidation,
  VALIDATION_NODE_VERSION as schemaVersion,
  type ValidationOperand,
  type ValidationPredicate,
  type ValidationScalar,
} from '../../packages/canonical-model/src/formula-validation.js';

const field: ValidationOperand = {
  schemaVersion,
  kind: 'field',
  fieldId: 'northstar.app:field.item_unit_cost',
  select: 'value',
};

function money(
  value: string,
  currency = 'CAD',
): Extract<ValidationScalar, { kind: 'decimal' }> {
  return {
    kind: 'decimal',
    value,
    precision: 38,
    scale: 4,
    currency,
    unit: null,
  };
}

const minimum: ValidationPredicate = {
  schemaVersion,
  kind: 'comparison',
  operator: 'greaterThanOrEqual',
  left: field,
  right: {
    schemaVersion,
    kind: 'literal',
    scalar: money('9007199254740993.0001'),
  },
};
const required: ValidationPredicate = {
  schemaVersion,
  kind: 'required',
  operand: field,
};

test('Formula validation compares decimal thresholds exactly, including equality', () => {
  assert.deepEqual(
    inspectValidation(minimum, () => ({
      status: 'present',
      scalar: money('9007199254740993'),
    })),
    { status: 'evaluated', value: 'false' },
  );
  assert.deepEqual(
    inspectValidation(minimum, () => ({
      status: 'present',
      scalar: money('9007199254740993.0001'),
    })),
    { status: 'evaluated', value: 'true' },
  );
  assert.deepEqual(
    inspectValidation(minimum, () => ({
      status: 'present',
      scalar: money('9007199254740993.0001', 'USD'),
    })),
    { status: 'refused', code: 'VALIDATION_OPERAND_MALFORMED' },
  );
});

test('Formula validation propagates absence through composition and preserves refusals', () => {
  assert.deepEqual(
    inspectValidation({ schemaVersion, kind: 'not', term: minimum }, () => ({
      status: 'absent',
    })),
    { status: 'evaluated', value: 'unknown' },
  );
  assert.deepEqual(
    inspectValidation(
      { schemaVersion, kind: 'all', terms: [minimum, required] },
      () => ({ status: 'absent' }),
    ),
    { status: 'evaluated', value: 'false' },
  );
  assert.deepEqual(
    inspectValidation(
      { schemaVersion, kind: 'any', terms: [minimum, required] },
      () => ({
        status: 'refused',
        code: 'VALIDATION_OPERAND_UNREADABLE',
      }),
    ),
    { status: 'refused', code: 'VALIDATION_OPERAND_UNREADABLE' },
  );
  assert.deepEqual(
    inspectValidation(required, () => ({
      status: 'present',
      scalar: { kind: 'boolean', value: false },
    })),
    { status: 'evaluated', value: 'true' },
  );
});

test('a text-length operand counts Unicode code points', () => {
  const limit: ValidationPredicate = {
    schemaVersion,
    kind: 'comparison',
    operator: 'lessThanOrEqual',
    left: {
      schemaVersion,
      kind: 'field',
      fieldId: 'northstar.app:field.item_name',
      select: 'textLength',
    },
    right: {
      schemaVersion,
      kind: 'literal',
      scalar: { kind: 'integer', value: '2' },
    },
  };
  assert.deepEqual(
    inspectValidation(limit, () => ({
      status: 'present',
      scalar: { kind: 'text', value: 'a😀' },
    })),
    { status: 'evaluated', value: 'true' },
  );
});

test('a literal guard binds to the actual typed create and update operations', () => {
  const authored = parseVersionedAuthoredApplicationPackageJson(
    readFileSync('apps/web/release/app.authored.json', 'utf8'),
  );
  assert.ok(authored.languageVersion === 'v6');
  const revision = normalizeApplicationPackage(authored);
  assert.equal(Object.hasOwn(revision, 'formulaRules'), false);
  const price = 'northstar.app:field.item_price_cad';
  const rule: FormulaValidationRule = {
    kind: 'validationRule',
    schemaVersion,
    ruleId: 'northstar.app:rule.custom_minimum_item_price',
    targetId: 'northstar.app:entity.item',
    boundOperationIds: [
      'northstar.app:operation.item_create',
      'northstar.app:operation.item_update',
    ],
    trigger: { schemaVersion, kind: 'afterDefaultsOrChangedFields' },
    absence: { schemaVersion, kind: 'validationThreeValued' },
    effect: 'refuse',
    existingRecords: 'grandfather',
    message: 'Enter a price of at least $10.',
    fieldAnchors: [price],
    predicate: {
      schemaVersion,
      kind: 'comparison',
      operator: 'greaterThanOrEqual',
      left: { schemaVersion, kind: 'field', fieldId: price, select: 'value' },
      right: {
        schemaVersion,
        kind: 'literal',
        scalar: { ...money('10'), currency: null },
      },
    },
  };
  const patch = parseCustomizationPatch({ kind: 'addValidation', rule });
  assert.ok(patch.status === 'parsed', JSON.stringify(patch));
  const applied = applyCustomizationPatches(authored, [patch.patch]);
  assert.ok(applied.status === 'applied', JSON.stringify(applied));
  const declaredSource = parseVersionedAuthoredApplicationPackageJson(
    JSON.stringify(applied.authored),
  );
  assert.ok(declaredSource.languageVersion === 'v6');
  const declared = normalizeApplicationPackage(declaredSource);
  assert.deepEqual(declared.formulaRules, [rule]);
  const plan = compileLiteralFormulaRules(declared);
  assert.ok(plan.status === 'compiled', JSON.stringify(plan));
  assert.equal(plan.payload.bindings[0]?.rule.ruleId, rule.ruleId);
  assert.equal(plan.payload.witnesses.length, 2);
  assert.deepEqual(compileLiteralFormulaRules(revision), { status: 'absent' });
  const authoredRuleFixture = normalizeApplicationPackage({
    ...authored,
    formulaRules: [rule],
  });
  const compiled = mustCompile(
    compilerInput(new TextEncoder().encode(canonicalize(authoredRuleFixture))),
  );
  const references = compiled.bundle.releaseManifest.projections;
  assert.equal(
    references.find(
      ({ familyId }) => familyId === PROJECTION_FAMILY_IDS.operationCatalog,
    )?.requiredRuntimeCapability.minimumVersion,
    3,
  );
  assert.equal(
    references.find(
      ({ familyId }) => familyId === PROJECTION_FAMILY_IDS.formulaRule,
    )?.payloadSchemaVersion,
    'northstar.formula-rule-payload/v1',
  );
  const bound = bindLiteralValidation(rule, revision);
  assert.ok(bound.status === 'bound', JSON.stringify(bound));
  assert.deepEqual(Object.keys(bound.binding.watchedFields), [price]);
  assert.equal(retypedFormulaRule(declared, revision, revision), null);
  assert.equal(
    retypedFormulaRule(
      declared,
      {
        ...revision,
        fields: revision.fields.map((field) =>
          field.fieldId === price ? { ...field, lifecycle: 'retired' } : field,
        ),
      },
      revision,
    ),
    rule.ruleId,
  );

  const update = (prior: string, current: string) =>
    observeValidationRefusals([bound.binding], {
      operationId: rule.boundOperationIds[1]!,
      businessDate: '2026-06-15',
      previousValues: { [price]: prior },
      values: { [price]: current },
    });
  assert.deepEqual(update('9.00', '9'), []);
  assert.deepEqual(
    observeValidationRefusals([bound.binding], {
      operationId: rule.boundOperationIds[1]!,
      businessDate: null,
      previousValues: { [price]: 'malformed old value' },
      values: { [price]: 'malformed old value' },
      updatedFieldIds: ['northstar.app:field.item_name'],
    }),
    [],
  );
  assert.deepEqual(update('11', '9'), [
    {
      code: 'MODULE_VALIDATION_REFUSED',
      fieldAnchors: [price],
      message: rule.message,
      ruleId: rule.ruleId,
    },
  ]);
  assert.equal(
    update('11', 'eleven')[0]?.code,
    'MODULE_VALIDATION_OPERAND_MALFORMED',
  );

  assert.ok(rule.predicate.kind === 'comparison');
  const wrongCurrencyRule: FormulaValidationRule = {
    ...rule,
    predicate: {
      ...rule.predicate,
      right: { schemaVersion, kind: 'literal', scalar: money('10', 'USD') },
    },
  };
  assert.deepEqual(bindLiteralValidation(wrongCurrencyRule, revision), {
    status: 'refused',
    message:
      'The field and its bound must have the same type, currency and unit.',
  });
  const unprovedRule: FormulaValidationRule = {
    ...rule,
    predicate: {
      schemaVersion,
      kind: 'all',
      terms: [
        rule.predicate,
        { schemaVersion, kind: 'not', term: rule.predicate },
        { schemaVersion, kind: 'required', operand: rule.predicate.left },
      ],
    },
  };
  const refused = compileApplication(
    compilerInput(
      new TextEncoder().encode(
        canonicalize({
          ...authoredRuleFixture,
          formulaRules: [unprovedRule],
        }),
      ),
    ),
  );
  assert.ok(refused.status !== 'compiled');
  assert.ok(
    refused.diagnostics.some(
      ({ code, subjectId }) =>
        code === 'COMPILER_TYPE_INVALID' && subjectId === rule.ruleId,
    ),
    JSON.stringify(refused.diagnostics),
  );
  const exactDecimal = (value: string): ValidationScalar => ({
    ...money(value),
    currency: null,
  });
  const upper = bindLiteralValidation(
    {
      ...rule,
      ruleId: 'northstar.app:rule.custom_maximum_item_price',
      message: 'Enter a price of at most $20.',
      predicate: {
        ...rule.predicate,
        operator: 'lessThanOrEqual',
        right: { schemaVersion, kind: 'literal', scalar: exactDecimal('20') },
      },
    },
    revision,
  );
  assert.ok(upper.status === 'bound');
  const witness = (prior: string, proposed: string) => ({
    previousValues: { [price]: exactDecimal(prior) },
    values: { [price]: exactDecimal(proposed) },
  });
  const proofs = proveJointValidationWitnesses(
    {
      operationId: 'northstar.app:operation.item_update',
      kind: 'update',
      businessDate: '2026-06-15',
    },
    [bound.binding, upper.binding],
    [
      witness('10.00', '10'),
      witness('12', '10'),
      witness('12', '9'),
      witness('12', '21'),
    ],
  );
  assert.ok(proofs.status === 'proved', JSON.stringify(proofs));
  assert.equal(proofs.satisfying.previousValues?.[price]?.value, '12');
  assert.deepEqual(
    proofs.violating.map(({ ruleId, refusalCode, values }) => [
      ruleId,
      refusalCode,
      values[price]?.value,
    ]),
    [
      [rule.ruleId, 'MODULE_VALIDATION_REFUSED', '9'],
      [upper.binding.rule.ruleId, 'MODULE_VALIDATION_REFUSED', '21'],
    ],
  );

  assert.equal(
    bindLiteralValidation(
      {
        ...rule,
        boundOperationIds: ['northstar.app:operation.location_archive'],
      },
      revision,
    ).status,
    'refused',
  );
});
