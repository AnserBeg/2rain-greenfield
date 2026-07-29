import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CanonicalIdSchema,
  CanonicalModelError,
  CanonicalScalarSchema,
  FieldTypeSchema,
  QUERY_AGGREGATE_PROFILE_VERSION,
  canonicalAuthoredProjection,
  evaluateQueryAggregateSemantics,
  inspectPredicateForExecution,
  normalizeApplicationPackage,
  parseAuthoredApplicationPackageJson,
  type AuthoredApplicationPackage,
} from '../../../packages/canonical-model/src/index.js';
import {
  V3_AGGREGATE_IDS,
  v3AggregateModule,
} from '../../compiler/v3-definition.js';
import {
  Q1_AGGREGATE_PARITY_CASES,
  evaluatePredicateCase,
  loadPredicateParityCorpus,
  loadPredicateScenarios,
} from '../../helpers/q1-predicate-corpus.js';

const demonstrateUnsupportedAggregate =
  process.env.Q1P3A_DEMONSTRATE_UNSUPPORTED_AGGREGATE === '1';

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
  unknownVersion.modules[0]!.schemaVersion = 'v4';
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

test('the runtime predicate fence is strict, version-dispatched, and admits only literal true', () => {
  for (const schemaVersion of ['v0-experimental', 'v1', 'v2', 'v3'] as const) {
    const receipt = inspectPredicateForExecution({
      kind: 'booleanPredicate',
      schemaVersion,
      value: true,
    });
    assert.equal(receipt.outcome, 'accepted');
    assert.deepEqual(receipt.outcome === 'accepted' && receipt.predicate, {
      kind: 'booleanPredicate',
      schemaVersion,
      value: true,
    });
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(
      receipt.outcome === 'accepted' && Object.isFrozen(receipt.predicate),
      true,
    );
  }

  assert.deepEqual(
    inspectPredicateForExecution({
      kind: 'booleanPredicate',
      schemaVersion: 'unknown',
      value: true,
    }),
    {
      kind: 'predicateKernelReceipt',
      nodeSchemaVersion: 'unknown',
      outcome: 'rejected',
      reason: 'unsupported-node-version',
      schemaVersion: 'northstar.predicate-kernel-receipt/v1',
    },
  );
  assert.equal(
    inspectPredicateForExecution({
      kind: 'booleanPredicate',
      schemaVersion: 'v2',
      unexpectedAuthority: 'x',
      value: true,
    }).reason,
    'invalid-node-shape',
  );
  assert.equal(
    inspectPredicateForExecution({
      kind: 'booleanPredicate',
      schemaVersion: 'v2',
      value: false,
    }).reason,
    'unsupported-literal',
  );
});

test('absent comparisons are total at every predicate binding position', () => {
  const comparison = {
    field: {
      kind: 'fieldReference',
      schemaVersion: 'v2',
      targetId: 'northstar.inventory:field.item_quantity',
    },
    kind: 'fieldComparisonPredicate',
    operator: 'lessThan',
    schemaVersion: 'v2',
    value: {
      kind: 'integerValue',
      schemaVersion: 'v2',
      value: '5',
    },
  };
  const expectedDispositions = {
    derivation: 'derive-false',
    guard: 'disable-guarded-path',
    operationPrecondition: 'reject-operation',
    queryFilter: 'exclude-row',
    validation: 'reject-value',
    visibilityCondition: 'hide-content',
  } as const;

  for (const [bindingPosition, falseDisposition] of Object.entries(
    expectedDispositions,
  )) {
    const receipt = inspectPredicateForExecution(comparison, {
      bindingPosition: bindingPosition as keyof typeof expectedDispositions,
      resolveComparison: () => ({ presence: 'absent' }),
    });
    assert.equal(receipt.outcome, 'evaluated');
    assert.equal(receipt.outcome === 'evaluated' && receipt.result, false);
    assert.equal(
      receipt.outcome === 'evaluated' && receipt.falseDisposition,
      falseDisposition,
    );
  }

  const negated = inspectPredicateForExecution(
    { kind: 'notPredicate', schemaVersion: 'v2', term: comparison },
    {
      bindingPosition: 'queryFilter',
      resolveComparison: () => ({ presence: 'absent' }),
    },
  );
  assert.equal(negated.outcome, 'evaluated');
  assert.equal(negated.outcome === 'evaluated' && negated.result, true);

  const undefinedResolution = inspectPredicateForExecution(comparison, {
    bindingPosition: 'queryFilter',
    resolveComparison: () => undefined as never,
  });
  assert.equal(undefinedResolution.outcome, 'rejected');
  assert.equal(
    undefinedResolution.outcome === 'rejected' && undefinedResolution.reason,
    'invalid-comparison-resolution',
  );

  for (const schemaVersion of ['v0-experimental', 'v1', 'v2', 'v3'] as const) {
    const versioned = structuredClone(comparison);
    versioned.schemaVersion = schemaVersion;
    versioned.field.schemaVersion = schemaVersion;
    versioned.value.schemaVersion = schemaVersion;
    const receipt = inspectPredicateForExecution(versioned, {
      bindingPosition: 'queryFilter',
      resolveComparison: () => ({ presence: 'absent' }),
    });
    assert.equal(receipt.outcome, 'evaluated');
    assert.equal(receipt.outcome === 'evaluated' && receipt.result, false);
  }

  const unknownNestedVersion = inspectPredicateForExecution(
    {
      kind: 'notPredicate',
      schemaVersion: 'v2',
      term: { ...comparison, schemaVersion: 'unknown' },
    },
    {
      bindingPosition: 'queryFilter',
      resolveComparison: () => ({ presence: 'absent' }),
    },
  );
  assert.equal(unknownNestedVersion.outcome, 'rejected');
  assert.equal(
    unknownNestedVersion.outcome === 'rejected' && unknownNestedVersion.reason,
    'unsupported-node-version',
  );

  const emptyAll = inspectPredicateForExecution(
    { kind: 'allPredicate', schemaVersion: 'v2', terms: [] },
    {
      bindingPosition: 'queryFilter',
      resolveComparison: () => ({ presence: 'absent' }),
    },
  );
  const emptyAny = inspectPredicateForExecution(
    { kind: 'anyPredicate', schemaVersion: 'v2', terms: [] },
    {
      bindingPosition: 'queryFilter',
      resolveComparison: () => ({ presence: 'absent' }),
    },
  );
  assert.equal(emptyAll.outcome === 'evaluated' && emptyAll.result, true);
  assert.equal(emptyAny.outcome === 'evaluated' && emptyAny.result, false);
});

test('predicate evaluation starts at normalization root depth', () => {
  let maximumDepthPredicate: Record<string, unknown> = {
    field: {
      kind: 'fieldReference',
      schemaVersion: 'v2',
      targetId: 'northstar.inventory:field.item_quantity',
    },
    kind: 'fieldComparisonPredicate',
    operator: 'lessThan',
    schemaVersion: 'v2',
    value: {
      kind: 'integerValue',
      schemaVersion: 'v2',
      value: '5',
    },
  };
  for (let depth = 0; depth < 24; depth += 1) {
    maximumDepthPredicate = {
      kind: 'notPredicate',
      schemaVersion: 'v2',
      term: maximumDepthPredicate,
    };
  }
  const depthReceipt = inspectPredicateForExecution(maximumDepthPredicate, {
    bindingPosition: 'queryFilter',
    resolveComparison: () => ({ presence: 'absent' }),
  });
  assert.equal(depthReceipt.outcome, 'rejected');
  assert.equal(
    depthReceipt.outcome === 'rejected' && depthReceipt.reason,
    'expression-depth-exceeded',
  );
});

test('predicate evaluation rejects inherited binding-position names', () => {
  let comparisons = 0;
  const inheritedPosition = inspectPredicateForExecution(
    {
      field: {
        kind: 'fieldReference',
        schemaVersion: 'v2',
        targetId: 'northstar.inventory:field.item_quantity',
      },
      kind: 'fieldComparisonPredicate',
      operator: 'lessThan',
      schemaVersion: 'v2',
      value: {
        kind: 'integerValue',
        schemaVersion: 'v2',
        value: '5',
      },
    },
    {
      bindingPosition: 'toString' as never,
      resolveComparison: () => {
        comparisons += 1;
        return { presence: 'absent' };
      },
    },
  );
  assert.equal(inheritedPosition.outcome, 'rejected');
  assert.equal(
    inheritedPosition.outcome === 'rejected' && inheritedPosition.reason,
    'invalid-binding-position',
  );
  assert.equal(comparisons, 0);
});

test('F3 operators and the complete v2 aggregate spelling stay compile-time rejected', () => {
  for (const operator of ['greaterThanOrEqual', 'lessThanOrEqual']) {
    const authored = structuredClone(fixture()) as unknown as {
      queries: Array<Record<string, unknown>>;
    };
    authored.queries[0]!.filter = {
      field: {
        kind: 'fieldReference',
        schemaVersion: 'v0-experimental',
        targetId: 'northstar.inventory:field.item_name',
      },
      kind: 'fieldComparisonPredicate',
      operator,
      schemaVersion: 'v0-experimental',
      value: {
        kind: 'textValue',
        schemaVersion: 'v0-experimental',
        value: 'M',
      },
    };
    expectDiagnostic(
      () => normalizeApplicationPackage(authored),
      'CANON_SCHEMA_INVALID',
    );
  }

  for (const presence of ['optional', 'required'] as const) {
    for (const operator of ['sum', 'count', 'min', 'max'] as const) {
      const aggregate = structuredClone(fixture()) as unknown as {
        fields: Array<{ fieldId: string; presence?: string }>;
        queries: Array<Record<string, unknown>>;
      };
      const quantity = aggregate.fields.find(
        (field) => field.fieldId === 'northstar.inventory:field.item_quantity',
      );
      assert.ok(quantity);
      quantity.presence = presence;
      aggregate.queries[0]!.aggregates = [
        {
          field: {
            kind: 'fieldReference',
            schemaVersion: 'v0-experimental',
            targetId: quantity.fieldId,
          },
          function: operator,
          kind: 'aggregateSelection',
          schemaVersion: 'v0-experimental',
        },
      ];
      if (
        process.env.Q1P3A_DEMONSTRATE_V2_AGGREGATE_ADMISSION === '1' &&
        presence === 'required' &&
        operator === 'sum'
      ) {
        normalizeApplicationPackage(aggregate);
      } else {
        expectDiagnostic(
          () => normalizeApplicationPackage(aggregate),
          'CANON_SCHEMA_INVALID',
        );
      }
    }
  }

  const ruledSingularShape = structuredClone(fixture()) as unknown as {
    queries: Array<Record<string, unknown>>;
  };
  ruledSingularShape.queries[0]!.aggregate = {
    field: {
      kind: 'fieldReference',
      schemaVersion: 'v0-experimental',
      targetId: 'northstar.inventory:field.item_quantity',
    },
    kind: 'queryAggregateSelection',
    operator: 'sum',
    schemaVersion: 'v0-experimental',
    selectionId: 'northstar.inventory:selection.item_quantity_sum',
  };
  ruledSingularShape.queries[0]!.queryType = 'aggregate';
  expectDiagnostic(
    () => normalizeApplicationPackage(ruledSingularShape),
    'CANON_SCHEMA_INVALID',
  );
});

test('query aggregate semantics are total, exact, strict, and sum-only', () => {
  assert.equal(
    CanonicalScalarSchema.safeParse({
      kind: 'exactDecimalValue',
      schemaVersion: 'v2',
      value: '-0.25',
    }).success,
    false,
    'v2 cannot represent the negative sub-unit value that v3 must admit',
  );
  for (const candidate of Q1_AGGREGATE_PARITY_CASES) {
    const receipt = evaluateQueryAggregateSemantics({
      elements: candidate.elements.map((value) => ({
        presence: 'present',
        value,
      })),
      field:
        candidate.field.kind === 'quantityFieldType'
          ? {
              ...candidate.field,
              baseUnitId: 'northstar.inventory:unit.each',
              presence: 'required',
            }
          : { ...candidate.field, presence: 'required' },
      operator: 'sum',
      profileVersion: QUERY_AGGREGATE_PROFILE_VERSION,
    });
    assert.equal(receipt.outcome, 'evaluated', candidate.caseId);
    assert.equal(
      receipt.outcome === 'evaluated' && receipt.result.value,
      candidate.expected,
    );
    assert.equal(
      receipt.outcome === 'evaluated' && receipt.result.precision,
      38,
    );
    assert.equal(
      receipt.outcome === 'evaluated' && receipt.costClass,
      'tenantBoundedScan',
    );
    if (candidate.field.kind === 'quantityFieldType') {
      assert.equal(
        receipt.outcome === 'evaluated' && receipt.result.kind,
        'quantityResult',
      );
      assert.equal(
        receipt.outcome === 'evaluated' &&
          receipt.result.kind === 'quantityResult' &&
          receipt.result.baseUnitId,
        'northstar.inventory:unit.each',
      );
    }
  }

  const field = {
    fieldId: 'northstar.q1:field.aggregate_exact_decimal',
    kind: 'exactDecimalFieldType',
    precision: 38,
    presence: 'required',
    scale: 0,
  } as const;
  const rejectedCases = [
    {
      expected: 'optional-aggregand',
      value: { field: { ...field, presence: 'optional' } },
    },
    {
      expected: 'required-element-absent',
      value: { elements: [{ presence: 'absent' }] },
    },
    {
      expected: 'numeric-overflow',
      value: {
        elements: [
          {
            presence: 'present',
            value: '99999999999999999999999999999999999999',
          },
          { presence: 'present', value: '1' },
        ],
      },
    },
    {
      expected: 'unsupported-profile-version',
      value: { profileVersion: 'northstar.query-aggregate-profile/v2' },
    },
    {
      expected: 'invalid-request-shape',
      value: { repairBeforeMeasurement: true },
    },
    {
      expected: 'invalid-element-shape',
      value: { elements: [{ presence: 'present', value: '-0' }] },
    },
    {
      expected: 'unsupported-field-type',
      value: { field: { ...field, kind: 'integerFieldType' } },
    },
  ] as const;
  const request = {
    elements: [{ presence: 'present', value: '1' }],
    field,
    operator: 'sum',
    profileVersion: QUERY_AGGREGATE_PROFILE_VERSION,
  };
  assert.equal(Object.isFrozen(request.field), false);
  evaluateQueryAggregateSemantics(request);
  assert.equal(
    Object.isFrozen(request.field),
    false,
    'the pure evaluator must not freeze or mutate caller-owned input',
  );
  for (const candidate of rejectedCases) {
    const receipt = evaluateQueryAggregateSemantics({
      ...request,
      ...candidate.value,
    });
    assert.deepEqual(receipt, {
      kind: 'queryAggregateKernelReceipt',
      outcome: 'rejected',
      reason: candidate.expected,
      schemaVersion: 'northstar.query-aggregate-kernel-receipt/v1',
    });
  }
  for (const operator of ['count', 'min', 'max']) {
    const receipt = evaluateQueryAggregateSemantics({
      ...request,
      operator,
    });
    if (demonstrateUnsupportedAggregate && operator === 'count') {
      assert.equal(receipt.outcome, 'evaluated');
      continue;
    }
    assert.equal(receipt.outcome, 'rejected');
    assert.equal(
      receipt.outcome === 'rejected' && receipt.reason,
      'unsupported-operator',
    );
  }
});

test('v3 aggregate admission rejects optional, unused, and unsupported shapes', () => {
  const optional = v3AggregateModule() as {
    fields: Array<Record<string, unknown>>;
  };
  optional.fields.find(
    (field) => field.fieldId === 'northstar.modulefixture:field.master_amount',
  )!.presence = 'optional';
  expectDiagnostic(
    () => normalizeApplicationPackage(optional),
    'CANON_QUERY_AGGREGATE_OPTIONAL_UNSUPPORTED',
    { objectId: V3_AGGREGATE_IDS.aggregateQuery },
  );

  const unused = v3AggregateModule() as {
    queries: Array<Record<string, unknown>>;
  };
  const unusedQuery = unused.queries.find(
    (query) => query.queryId === V3_AGGREGATE_IDS.aggregateQuery,
  )!;
  unusedQuery.parameters = [
    ...(unusedQuery.parameters as unknown[]),
    {
      kind: 'queryParameterDefinition',
      orderKey: 30,
      parameterId: 'northstar.modulefixture:parameter.unused',
      schemaVersion: 'v3',
    },
  ];
  expectDiagnostic(
    () => normalizeApplicationPackage(unused),
    'CANON_QUERY_PARAMETER_UNUSED',
    { objectId: V3_AGGREGATE_IDS.aggregateQuery },
  );

  const unsupportedOperator = v3AggregateModule() as {
    queries: Array<Record<string, unknown>>;
  };
  (
    unsupportedOperator.queries.find(
      (query) => query.queryId === V3_AGGREGATE_IDS.aggregateQuery,
    )!.aggregate as Record<string, unknown>
  ).operator = 'count';
  expectDiagnostic(
    () => normalizeApplicationPackage(unsupportedOperator),
    'CANON_SCHEMA_INVALID',
  );

  const tooManyRows = v3AggregateModule() as {
    queries: Array<Record<string, unknown>>;
  };
  tooManyRows.queries.find(
    (query) => query.queryId === V3_AGGREGATE_IDS.aggregateQuery,
  )!.maximumResultCount = 2;
  expectDiagnostic(
    () => normalizeApplicationPackage(tooManyRows),
    'CANON_SCHEMA_INVALID',
  );

  const tooManyParameters = v3AggregateModule() as {
    queries: Array<Record<string, unknown>>;
  };
  tooManyParameters.queries.find(
    (query) => query.queryId === V3_AGGREGATE_IDS.aggregateQuery,
  )!.parameters = Array.from({ length: 65 }, (_, index) => ({
    kind: 'queryParameterDefinition',
    orderKey: index,
    parameterId: `northstar.modulefixture:parameter.bound_${index}`,
    schemaVersion: 'v3',
  }));
  expectDiagnostic(
    () => normalizeApplicationPackage(tooManyParameters),
    'CANON_SCHEMA_INVALID',
  );

  const crossEntity = v3AggregateModule() as {
    queries: Array<Record<string, unknown>>;
  };
  const crossEntityQuery = crossEntity.queries.find(
    (query) => query.queryId === V3_AGGREGATE_IDS.aggregateQuery,
  )!;
  (
    (crossEntityQuery.aggregate as Record<string, unknown>).field as Record<
      string,
      unknown
    >
  ).targetId = 'northstar.modulefixture:field.master_role_kind';
  expectDiagnostic(
    () => normalizeApplicationPackage(crossEntity),
    'CANON_QUERY_AGGREGATE_FIELD_LOCALITY',
    { objectId: V3_AGGREGATE_IDS.aggregateQuery },
  );

  const incompatibleParameter = v3AggregateModule() as {
    queries: Array<Record<string, unknown>>;
  };
  const incompatibleQuery = incompatibleParameter.queries.find(
    (query) => query.queryId === V3_AGGREGATE_IDS.aggregateQuery,
  )!;
  const terms = (
    incompatibleQuery.filter as { terms: Array<Record<string, unknown>> }
  ).terms;
  (terms[1]!.value as Record<string, unknown>).parameterId =
    V3_AGGREGATE_IDS.stockParameter;
  expectDiagnostic(
    () => normalizeApplicationPackage(incompatibleParameter),
    'CANON_QUERY_PARAMETER_TYPE_MISMATCH',
    { objectId: V3_AGGREGATE_IDS.aggregateQuery },
  );

  for (const authoredAuthority of [
    { path: 'query', property: 'groupBy', value: [] },
    { path: 'query', property: 'selections', value: [] },
    {
      path: 'aggregate',
      property: 'resultType',
      value: { kind: 'exactDecimalAggregateResultType' },
    },
    {
      path: 'parameter',
      property: 'parameterType',
      value: { kind: 'textFieldType' },
    },
    { path: 'parameter', property: 'presence', value: 'optional' },
  ] as const) {
    const candidate = v3AggregateModule() as {
      queries: Array<Record<string, unknown>>;
    };
    const query = candidate.queries.find(
      (entry) => entry.queryId === V3_AGGREGATE_IDS.aggregateQuery,
    )!;
    const target =
      authoredAuthority.path === 'aggregate'
        ? (query.aggregate as Record<string, unknown>)
        : authoredAuthority.path === 'parameter'
          ? ((query.parameters as Array<Record<string, unknown>>)[0] ?? {})
          : query;
    target[authoredAuthority.property] = authoredAuthority.value;
    expectDiagnostic(
      () => normalizeApplicationPackage(candidate),
      'CANON_SCHEMA_INVALID',
    );
  }
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

test('decimal predicate bounds reserve the declared fractional scale', () => {
  const authored = structuredClone(fixture());
  authored.queries[0]!.filter = {
    field: {
      kind: 'fieldReference',
      schemaVersion: 'v0-experimental',
      targetId: 'northstar.inventory:field.item_quantity' as never,
    },
    kind: 'fieldComparisonPredicate',
    operator: 'equals',
    schemaVersion: 'v0-experimental',
    value: {
      baseUnit: {
        kind: 'unitReference',
        schemaVersion: 'v0-experimental',
        targetId: 'northstar.inventory:capability.unit_each' as never,
      },
      kind: 'quantityValue',
      schemaVersion: 'v0-experimental',
      value: '123456789012345',
    },
  };
  expectDiagnostic(
    () => normalizeApplicationPackage(authored),
    'CANON_PREDICATE_VALUE_INVALID',
    { objectId: 'northstar.inventory:query.item_get' },
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

test('model-authored predicate scenarios are judged by the deterministic kernel', () => {
  const corpus = loadPredicateParityCorpus();
  const artifact = loadPredicateScenarios();
  const cases = new Map(
    corpus.cases.map((candidate) => [candidate.caseId, candidate] as const),
  );
  const rows = new Map(
    corpus.rows.map((candidate) => [candidate.recordId, candidate] as const),
  );
  for (const scenario of artifact.scenarios) {
    const candidate = cases.get(scenario.caseId);
    const row = rows.get(scenario.rowId);
    assert.ok(candidate, `unknown scenario case ${scenario.caseId}`);
    assert.ok(row, `unknown scenario row ${scenario.rowId}`);
    assert.equal(
      evaluatePredicateCase(candidate, row),
      scenario.expected,
      `${scenario.scenarioId}: GIVEN ${scenario.given}; WHEN ${scenario.when}; THEN ${scenario.then}`,
    );
  }
  console.log(
    `Q1-P2 scenarios=${String(artifact.scenarios.length)} approval=behavior-not-implementation deterministic=kernel`,
  );
});

test('the committed parity corpus has a deterministic offline IR receipt', () => {
  const corpus = loadPredicateParityCorpus();
  const verdicts = corpus.cases.map((candidate) => [
    candidate.caseId,
    corpus.rows.map((row) => [
      row.recordId,
      evaluatePredicateCase(candidate, row),
    ]),
  ]);
  const digest = createHash('sha256')
    .update(JSON.stringify(verdicts))
    .digest('hex');
  assert.equal(
    digest,
    'fb68943504912eead0e68bb486fba0a6cd86e3fef43d3093825be05f18dca3a8',
  );
  console.log(
    `Q1-P2 offline corpus receipt cases=${String(corpus.cases.length)} rows=${String(corpus.rows.length)} sha256=${digest}`,
  );
});
