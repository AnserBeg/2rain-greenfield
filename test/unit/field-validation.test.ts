import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  canonicalize,
  normalizeApplicationPackage,
  parseVersionedAuthoredApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import {
  bindLiteralValidation,
  retypedFormulaRule,
} from '../../packages/canonical-model/src/formula-validation-bindings.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/protocol.js';
import { compileLiteralFormulaRules } from '../../packages/compiler/src/formula-validation-plan.js';
import { compileApplication } from '../../packages/compiler/src/index.js';
import { customizationTargets } from '../../packages/customization/src/targets.js';
import { fieldComparisonValidationDraft } from '../../packages/customization/src/validation-draft.js';
import { observeValidationRefusals } from '../../packages/runtime/src/formula-validation.js';
import {
  inspectValidation,
  VALIDATION_NODE_VERSION,
} from '../../packages/canonical-model/src/formula-validation.js';
import { compilerInput, mustCompile } from '../compiler/helpers.js';

const entityId = 'northstar.app:entity.location';
const name = 'northstar.app:field.location_name';
const code = 'northstar.app:field.location_code';
const parent = 'northstar.app:relation.location_parent';

test('v6 guards bind existing fields and one declared relation and raise the operation reader floor', () => {
  const authored = parseVersionedAuthoredApplicationPackageJson(
    readFileSync('apps/web/release/app.authored.json', 'utf8'),
  );
  assert.ok(authored.languageVersion === 'v6');
  const revision = normalizeApplicationPackage(authored);
  const target = customizationTargets(revision).validationTargets?.find(
    (entry) => entry.entityId === entityId,
  );
  assert.ok(target);
  const same = fieldComparisonValidationDraft(target, {
    fieldId: name,
    operator: 'notEqual',
    otherFieldId: code,
    message: 'Enter a name different from the location code.',
  }).rule;
  const related = fieldComparisonValidationDraft(target, {
    fieldId: name,
    operator: 'notEqual',
    otherFieldId: name,
    relationId: parent,
    message: 'Enter a name different from the parent location.',
  }).rule;
  const withRules = normalizeApplicationPackage({
    ...authored,
    formulaRules: [same, related],
  });
  const proof = compileLiteralFormulaRules(withRules);
  assert.ok(proof.status === 'compiled', JSON.stringify(proof));
  for (const witness of proof.payload.witnesses) {
    assert.equal(witness.violating.length, 2);
    assert.ok(witness.satisfying.relatedValues?.[parent]?.[name]);
  }
  const compiled = mustCompile(
    compilerInput(new TextEncoder().encode(canonicalize(withRules))),
  );
  assert.equal(
    compiled.bundle.releaseManifest.projections.find(
      ({ familyId }) => familyId === PROJECTION_FAMILY_IDS.operationCatalog,
    )?.requiredRuntimeCapability.minimumVersion,
    4,
  );

  const result = bindLiteralValidation(related, withRules);
  assert.ok(result.status === 'bound');
  assert.deepEqual(result.binding.watchedRelationIds, [parent]);
  const incoming = {
    operationId: 'northstar.app:operation.location_create',
    businessDate: '2026-06-15',
    values: { [name]: 'North Warehouse' },
  };
  assert.equal(
    observeValidationRefusals([result.binding], {
      ...incoming,
      pathValues: { [parent]: { [name]: 'North Warehouse' } },
    })[0]?.code,
    'MODULE_VALIDATION_REFUSED',
  );
  assert.deepEqual(
    observeValidationRefusals([result.binding], {
      ...incoming,
      pathValues: { [parent]: null },
    }),
    [],
  );
  assert.equal(
    observeValidationRefusals([result.binding], incoming)[0]?.code,
    'MODULE_VALIDATION_OPERAND_UNREADABLE',
  );
  assert.equal(
    retypedFormulaRule(
      withRules,
      {
        ...revision,
        relations: revision.relations.map((relation) =>
          relation.relationId === parent
            ? { ...relation, lifecycle: 'retired' }
            : relation,
        ),
      },
      revision,
    ),
    related.ruleId,
  );
  const predicate = related.predicate;
  assert.ok(predicate.kind === 'comparison' && predicate.right.kind === 'path');
  const refused = compileApplication(
    compilerInput(
      new TextEncoder().encode(
        canonicalize({
          ...withRules,
          formulaRules: [
            same,
            {
              ...related,
              predicate: {
                ...predicate,
                right: { ...predicate.right, relationIds: [parent, parent] },
              },
            },
          ],
        }),
      ),
    ),
  );
  assert.ok(refused.status === 'failed');
  assert.ok(
    refused.diagnostics.some(
      ({ code, subjectId }) =>
        code === 'CANON_VALIDATION_BINDING_UNSUPPORTED' &&
        subjectId === related.ruleId,
    ),
  );
});

test('a later-date guard compares both typed fields and distinguishes equality', () => {
  const schemaVersion = VALIDATION_NODE_VERSION;
  const start = 'northstar.app:field.start_date';
  const end = 'northstar.app:field.end_date';
  const check = (endDate: string) =>
    inspectValidation(
      {
        kind: 'comparison',
        schemaVersion,
        operator: 'greaterThan',
        left: { kind: 'field', schemaVersion, fieldId: end, select: 'value' },
        right: {
          kind: 'field',
          schemaVersion,
          fieldId: start,
          select: 'value',
        },
      },
      (operand) => ({
        status: 'present',
        scalar: {
          kind: 'date',
          value: operand.fieldId === start ? '2026-12-31' : endDate,
        },
      }),
    );
  assert.deepEqual(check('2026-12-31'), {
    status: 'evaluated',
    value: 'false',
  });
  assert.deepEqual(check('2027-01-01'), { status: 'evaluated', value: 'true' });
});

test('a validation path refuses company-owned storage even with an unscoped get', () => {
  const authored = parseVersionedAuthoredApplicationPackageJson(
    readFileSync('apps/web/release/app.authored.json', 'utf8'),
  );
  assert.ok(authored.languageVersion === 'v6');
  const revision = normalizeApplicationPackage(authored);
  const target = customizationTargets(revision).validationTargets!.find(
    (entry) => entry.entityId === entityId,
  )!;
  const { rule } = fieldComparisonValidationDraft(target, {
    fieldId: name,
    otherFieldId: name,
    relationId: parent,
    operator: 'notEqual',
    message: 'Choose another name.',
  });
  const owned = 'northstar.app:entity.custom_depot';
  const variant = JSON.parse(
    JSON.stringify({ ...revision, formulaRules: [rule] }).replaceAll(
      entityId,
      owned,
    ),
  ) as typeof revision;
  const result = compileLiteralFormulaRules({
    ...variant,
    entities: variant.entities.map((entity) =>
      entity.entityId === owned
        ? { ...entity, companyOwnership: 'entityOwned' as const }
        : entity,
    ),
  });
  assert.equal(result.status, 'refused');
});
