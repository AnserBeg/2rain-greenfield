import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CanonicalIdSchema,
  CanonicalModelError,
  CanonicalScalarSchema,
  FieldTypeSchema,
  canonicalAuthoredProjection,
  normalizeApplicationPackage,
  parseAuthoredApplicationPackageJson,
  type AuthoredApplicationPackage,
} from '../../../packages/canonical-model/src/index.js';

function fixture(): AuthoredApplicationPackage {
  return parseAuthoredApplicationPackageJson(
    readFileSync('test/fixtures/canonical-model/representative.authored.json'),
  );
}

function expectDiagnostic(
  action: () => unknown,
  code: string,
  expected: Partial<{
    acceptedAlternative: string;
    objectId: string | null;
    path: string;
    rule: string;
  }> = {},
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CanonicalModelError);
    const found = error.diagnostics.find((entry) => entry.code === code);
    assert.ok(found, `expected ${code}: ${JSON.stringify(error.diagnostics)}`);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(found[key as keyof typeof found], value);
    }
    assert.equal(typeof found.path, 'string');
    assert.equal(typeof found.rule, 'string');
    assert.equal(typeof found.acceptedAlternative, 'string');
    return true;
  });
}

test('unknown kinds, versions, properties, slots, and status roles fail closed', () => {
  const unknownKind = structuredClone(fixture()) as unknown as {
    modules: Array<Record<string, unknown>>;
  };
  unknownKind.modules[0]!.kind = 'moduleAlias';
  expectDiagnostic(
    () => normalizeApplicationPackage(unknownKind),
    'CANON_KIND_UNSUPPORTED',
  );

  const unknownVersion = structuredClone(fixture()) as unknown as {
    modules: Array<Record<string, unknown>>;
  };
  unknownVersion.modules[0]!.schemaVersion = 'v1';
  expectDiagnostic(
    () => normalizeApplicationPackage(unknownVersion),
    'CANON_VERSION_UNSUPPORTED',
  );

  const hiddenHook = structuredClone(fixture()) as unknown as {
    operations: Array<Record<string, unknown>>;
  };
  hiddenHook.operations[0]!.handler = 'src/run.ts';
  expectDiagnostic(
    () => normalizeApplicationPackage(hiddenHook),
    'CANON_SCHEMA_INVALID',
    { objectId: 'northstar.inventory:operation.item_archive' },
  );

  const unknownSlot = structuredClone(fixture());
  unknownSlot.surfaces[0]!.slots[0]!.slot = 'sidebar';
  expectDiagnostic(
    () => normalizeApplicationPackage(unknownSlot),
    'CANON_SURFACE_SLOT_UNSUPPORTED',
    { objectId: 'northstar.inventory:surface.item_record' },
  );

  const unknownStatus = structuredClone(fixture()) as unknown as {
    surfaces: Array<{ statusRoles: string[] }>;
  };
  unknownStatus.surfaces[0]!.statusRoles.push('neutral');
  expectDiagnostic(
    () => normalizeApplicationPackage(unknownStatus),
    'CANON_SURFACE_STATUS_ROLE_UNSUPPORTED',
  );
});

test('unresolved and wrong-kind references fail with structured diagnostics', () => {
  const unresolved = structuredClone(fixture());
  unresolved.queries[0]!.sourceEntity.targetId =
    'northstar.inventory:entity.missing' as never;
  expectDiagnostic(
    () => normalizeApplicationPackage(unresolved),
    'CANON_REFERENCE_UNRESOLVED',
    { objectId: 'northstar.inventory:query.item_get' },
  );

  const wrongKind = structuredClone(fixture());
  wrongKind.queries[0]!.sourceEntity.kind = 'fieldReference';
  expectDiagnostic(
    () => normalizeApplicationPackage(wrongKind),
    'CANON_REFERENCE_KIND_MISMATCH',
    { objectId: 'northstar.inventory:query.item_get' },
  );
});

test('cross-package references parse and then reject as unsupported in v0', () => {
  const crossPackage = structuredClone(fixture());
  crossPackage.relations[0]!.targetEntity.targetId =
    'vendor.catalog:entity.item' as never;
  expectDiagnostic(
    () => normalizeApplicationPackage(crossPackage),
    'CANON_REFERENCE_CROSS_PACKAGE_UNSUPPORTED',
    { objectId: 'northstar.inventory:relation.item_alias_parent' },
  );
});

test('duplicate JSON keys and lone surrogates reject before normalization', () => {
  expectDiagnostic(
    () => parseAuthoredApplicationPackageJson('{"kind":"a","kind":"b"}'),
    'CANON_JSON_DUPLICATE_KEY',
    { path: '$.kind' },
  );
  expectDiagnostic(
    () => parseAuthoredApplicationPackageJson('{"value":"\\ud800"}'),
    'CANON_UNICODE_LONE_SURROGATE',
    { path: '$.value' },
  );
});

test('branded IDs and exact business scalar shapes are runtime validated', () => {
  assert.equal(
    CanonicalIdSchema.safeParse('northstar.inventory:field.sku').success,
    true,
  );
  assert.equal(CanonicalIdSchema.safeParse('Field SKU').success, false);

  assert.equal(
    FieldTypeSchema.safeParse({
      kind: 'exactDecimalFieldType',
      schemaVersion: 'v0-experimental',
      precision: 20,
      scale: 6,
      representation: 'canonicalString',
    }).success,
    true,
  );
  assert.equal(
    FieldTypeSchema.safeParse({
      kind: 'moneyFieldType',
      schemaVersion: 'v0-experimental',
      precision: 20,
      scale: 2,
      representation: 'canonicalString',
      currencyCode: 'USD',
      minorUnit: 2,
      defaultValue: 1.1,
    }).success,
    false,
  );
});

test('duplicate order keys and expression depth exceedance fail deterministically', () => {
  const duplicateOrder = structuredClone(fixture());
  duplicateOrder.fields[1]!.orderKey = duplicateOrder.fields[0]!.orderKey;
  expectDiagnostic(
    () => normalizeApplicationPackage(duplicateOrder),
    'CANON_ORDER_KEY_DUPLICATE',
  );

  const duplicateEntityOrder = structuredClone(fixture());
  duplicateEntityOrder.entities[1]!.orderKey =
    duplicateEntityOrder.entities[0]!.orderKey;
  expectDiagnostic(
    () => normalizeApplicationPackage(duplicateEntityOrder),
    'CANON_ORDER_KEY_DUPLICATE',
    { objectId: 'northstar.inventory:module.inventory' },
  );

  const independentFieldScopes = structuredClone(fixture());
  independentFieldScopes.fields[5]!.orderKey =
    independentFieldScopes.fields[0]!.orderKey;
  assert.doesNotThrow(() =>
    normalizeApplicationPackage(independentFieldScopes),
  );

  const tooDeep = structuredClone(fixture());
  let predicate: Record<string, unknown> = {
    kind: 'booleanPredicate',
    schemaVersion: 'v0-experimental',
    value: true,
  };
  for (let index = 0; index < 25; index += 1) {
    predicate = {
      kind: 'notPredicate',
      schemaVersion: 'v0-experimental',
      term: predicate,
    };
  }
  tooDeep.operations[0]!.precondition = predicate as never;
  expectDiagnostic(
    () => normalizeApplicationPackage(tooDeep),
    'CANON_LIMIT_EXPRESSION_DEPTH',
  );
});

test('parent scope, assertion diagnostics, and reference locality are closed', () => {
  const parentScope = structuredClone(fixture());
  parentScope.relations[0]!.required = false;
  expectDiagnostic(
    () => normalizeApplicationPackage(parentScope),
    'CANON_RELATION_PARENT_SCOPE_INVALID',
    { objectId: 'northstar.inventory:relation.item_alias_parent' },
  );

  const duplicateParent = structuredClone(fixture());
  const secondParent = structuredClone(duplicateParent.relations[0]!);
  secondParent.relationId =
    'northstar.inventory:relation.item_alias_second_parent' as never;
  secondParent.orderKey = 20;
  duplicateParent.relations.push(secondParent);
  expectDiagnostic(
    () => normalizeApplicationPackage(duplicateParent),
    'CANON_RELATION_PARENT_OWNER_DUPLICATE',
    { objectId: 'northstar.inventory:entity.item_alias' },
  );

  const selfParent = structuredClone(fixture());
  selfParent.relations[0]!.targetEntity.targetId =
    'northstar.inventory:entity.item_alias' as never;
  expectDiagnostic(
    () => normalizeApplicationPackage(selfParent),
    'CANON_RELATION_PARENT_TOPOLOGY_INVALID',
    { objectId: 'northstar.inventory:relation.item_alias_parent' },
  );

  const nestedParent = structuredClone(fixture());
  const nestedRelation = structuredClone(nestedParent.relations[0]!);
  nestedRelation.relationId =
    'northstar.inventory:relation.item_nested_parent' as never;
  nestedRelation.sourceEntity.targetId =
    'northstar.inventory:entity.item' as never;
  nestedRelation.targetEntity.targetId =
    'northstar.inventory:entity.item_alias' as never;
  nestedParent.relations.push(nestedRelation);
  expectDiagnostic(
    () => normalizeApplicationPackage(nestedParent),
    'CANON_RELATION_PARENT_TOPOLOGY_INVALID',
  );

  const crossModuleParent = structuredClone(fixture());
  crossModuleParent.modules.push({
    composition: {
      kind: 'compositionSeam',
      schemaVersion: 'v0-experimental',
      status: 'unsupported',
    },
    kind: 'moduleDefinition',
    label: 'Aliases',
    moduleId: 'northstar.inventory:module.aliases' as never,
    orderKey: 20,
    ownerPackageId: 'northstar.inventory:package.launch' as never,
    schemaVersion: 'v0-experimental',
  });
  crossModuleParent.entities[1]!.module.targetId =
    'northstar.inventory:module.aliases' as never;
  expectDiagnostic(
    () => normalizeApplicationPackage(crossModuleParent),
    'CANON_RELATION_PARENT_TOPOLOGY_INVALID',
    { objectId: 'northstar.inventory:relation.item_alias_parent' },
  );

  const assertion = structuredClone(fixture());
  assertion.assertions[0]!.expectedOutcome = 'fails';
  expectDiagnostic(
    () => normalizeApplicationPackage(assertion),
    'CANON_ASSERTION_DIAGNOSTIC_MISMATCH',
    { objectId: 'northstar.inventory:assertion.item_archive_readback' },
  );

  const absentNullable = structuredClone(fixture()) as unknown as {
    assertions: Array<Record<string, unknown>>;
  };
  delete absentNullable.assertions[0]!.expectedDiagnosticCode;
  expectDiagnostic(
    () => normalizeApplicationPackage(absentNullable),
    'CANON_SCHEMA_INVALID',
  );

  const selection = structuredClone(fixture());
  selection.queries[0]!.selections[0]!.field.targetId =
    'northstar.inventory:field.item_alias_value' as never;
  expectDiagnostic(
    () => normalizeApplicationPackage(selection),
    'CANON_QUERY_FIELD_LOCALITY',
    { objectId: 'northstar.inventory:query.item_get' },
  );

  const filter = structuredClone(fixture());
  filter.queries[0]!.filter = {
    field: {
      kind: 'fieldReference',
      schemaVersion: 'v0-experimental',
      targetId: 'northstar.inventory:field.item_alias_value' as never,
    },
    kind: 'fieldComparisonPredicate',
    operator: 'equals',
    schemaVersion: 'v0-experimental',
    value: {
      kind: 'textValue',
      schemaVersion: 'v0-experimental',
      value: 'alias',
    },
  };
  expectDiagnostic(
    () => normalizeApplicationPackage(filter),
    'CANON_QUERY_FILTER_FIELD_LOCALITY',
    { objectId: 'northstar.inventory:query.item_get' },
  );
});

test('state storage is derived and authored state-field authority rejects', () => {
  const authored = fixture();
  const normalized = normalizeApplicationPackage(authored);
  assert.deepEqual(normalized.stateMachines[0]!.stateField, {
    fieldId: 'northstar.inventory:derived_state_field.machine.item_lifecycle',
    kind: 'derivedStateField',
    schemaVersion: 'v0-experimental',
    valueKind: 'stateId',
  });
  assert.equal(
    canonicalAuthoredProjection(normalized).stateMachines[0]!.stateField,
    undefined,
  );

  const selected = structuredClone(authored);
  selected.stateMachines[0]!.stateField = {
    fieldId: 'northstar.inventory:derived_state_field.author_selected' as never,
    kind: 'derivedStateField',
    schemaVersion: 'v0-experimental',
    valueKind: 'stateId',
  };
  expectDiagnostic(
    () => normalizeApplicationPackage(selected),
    'CANON_DERIVED_STATE_FIELD_INVALID',
    { objectId: 'northstar.inventory:machine.item_lifecycle' },
  );
});

test('schema diagnostic ownership ignores object property insertion order', () => {
  const first = structuredClone(fixture()) as unknown as {
    modules: Array<Record<string, unknown>>;
  };
  first.modules[0]!.hiddenHook = true;
  expectDiagnostic(
    () => normalizeApplicationPackage(first),
    'CANON_SCHEMA_INVALID',
    { objectId: 'northstar.inventory:module.inventory' },
  );

  const second = structuredClone(fixture()) as unknown as {
    modules: Array<Record<string, unknown>>;
  };
  const module = second.modules[0]!;
  second.modules[0] = {
    ownerPackageId: module.ownerPackageId,
    moduleId: module.moduleId,
    kind: module.kind,
    schemaVersion: module.schemaVersion,
    label: module.label,
    orderKey: module.orderKey,
    composition: module.composition,
    hiddenHook: true,
  };
  expectDiagnostic(
    () => normalizeApplicationPackage(second),
    'CANON_SCHEMA_INVALID',
    { objectId: 'northstar.inventory:module.inventory' },
  );
});

test('date, time, decimal, money, and quantity shapes reject ambiguous values', () => {
  assert.equal(
    CanonicalScalarSchema.safeParse({
      kind: 'dateValue',
      schemaVersion: 'v0-experimental',
      value: '2026-02-29',
    }).success,
    false,
  );
  assert.equal(
    CanonicalScalarSchema.safeParse({
      kind: 'timeValue',
      schemaVersion: 'v0-experimental',
      value: '24:00:00',
    }).success,
    false,
  );
  assert.equal(
    CanonicalScalarSchema.safeParse({
      kind: 'dateTimeValue',
      schemaVersion: 'v0-experimental',
      value: '2026-07-21T12:00:00-00:00',
    }).success,
    false,
  );
  assert.equal(
    CanonicalScalarSchema.safeParse({
      kind: 'exactDecimalValue',
      schemaVersion: 'v0-experimental',
      value: 1.25,
    }).success,
    false,
  );
  assert.equal(
    FieldTypeSchema.safeParse({
      kind: 'moneyFieldType',
      schemaVersion: 'v0-experimental',
      precision: 10,
      scale: 2,
      representation: 'canonicalString',
      currencyCode: 'USD',
      minorUnit: 3,
    }).success,
    false,
  );
  assert.equal(
    FieldTypeSchema.safeParse({
      kind: 'moneyFieldType',
      schemaVersion: 'v0-experimental',
      precision: 10,
      scale: 2,
      representation: 'canonicalString',
      currencyCode: 'ZZZ',
      minorUnit: 2,
    }).success,
    false,
  );
  assert.equal(
    CanonicalScalarSchema.safeParse({
      kind: 'moneyValue',
      schemaVersion: 'v0-experimental',
      currencyCode: 'USD',
      minorUnit: 0,
      value: '1',
    }).success,
    false,
  );
  assert.equal(
    FieldTypeSchema.safeParse({
      kind: 'quantityFieldType',
      schemaVersion: 'v0-experimental',
      precision: 4,
      scale: 6,
      representation: 'canonicalString',
      baseUnit: {
        kind: 'unitReference',
        schemaVersion: 'v0-experimental',
        targetId: 'northstar.inventory:capability.unit_each',
      },
    }).success,
    false,
  );
});

test('family, collection, and authored-byte bounds fail with stable codes', () => {
  const tooManySurfaces = structuredClone(fixture());
  tooManySurfaces.surfaces = Array.from({ length: 513 }, () =>
    structuredClone(tooManySurfaces.surfaces[0]!),
  );
  expectDiagnostic(
    () => normalizeApplicationPackage(tooManySurfaces),
    'CANON_LIMIT_FAMILY_COUNT',
  );

  const tooManyTerms = structuredClone(fixture());
  tooManyTerms.operations[0]!.precondition = {
    kind: 'allPredicate',
    schemaVersion: 'v0-experimental',
    terms: Array.from({ length: 4_097 }, () => ({
      kind: 'booleanPredicate' as const,
      schemaVersion: 'v0-experimental' as const,
      value: true,
    })),
  };
  expectDiagnostic(
    () => normalizeApplicationPackage(tooManyTerms),
    'CANON_LIMIT_COLLECTION_COUNT',
  );

  const authoredText = readFileSync(
    'test/fixtures/canonical-model/representative.authored.json',
    'utf8',
  );
  const padded = `${' '.repeat(2_097_153)}${authoredText}`;
  expectDiagnostic(
    () => parseAuthoredApplicationPackageJson(padded),
    'CANON_LIMIT_PACKAGE_BYTES',
  );
});
