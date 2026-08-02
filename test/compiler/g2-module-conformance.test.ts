import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ADOPTED_LANGUAGE_VERSION,
  CanonicalModelError,
  LANGUAGE_VERSION,
  LANGUAGE_VERSIONS,
  NORMALIZATION_PROFILE_VERSIONS,
  NORMALIZATION_PROFILE_VERSION,
  PREVIOUS_LANGUAGE_VERSION,
  PREVIOUS_NORMALIZATION_PROFILE_VERSION,
  PROMOTE_STORAGE_CLASS_CAPABILITY_ID,
  canonicalAuthoredProjection,
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  diffCompiledReleases,
  executeVerificationPlan,
  expectedActiveReleaseFrom,
  requiredProjectionFamily,
  validateExecutedVerificationPlan,
  type CompileResult,
  type CompileSuccess,
  type CompilerInput,
  type ExecutedVerificationResult,
  type ProjectionFamilyId,
  type ProjectionManifestEnvelope,
  type StorageTargetPayloadV1,
  type StorageTransitionEnvelope,
  type VerificationPlanPayloadV1,
} from '../../packages/compiler/src/index.js';
import {
  FIXTURE_IDS,
  FIXTURE_LANGUAGE_VERSION,
  ordinaryModuleV1,
  ordinaryModuleV2,
} from '../fixtures/g2/module-conformance/definitions.js';
import { registerInventoryContractCases } from './inventory-contract.cases.js';
import { V3_AGGREGATE_IDS, v3AggregateModule } from './v3-definition.js';

registerInventoryContractCases((name, run) => test(name, run));

test('ordinary v1 and v2 parent/child definitions compile cleanly and twice identically', () => {
  const first = mustCompile(input(ordinaryModuleV1()));
  const firstAgain = mustCompile(input(ordinaryModuleV1()));
  assert.equal(first.releaseRoot, firstAgain.releaseRoot);
  assert.deepEqual(first.bundle.artifacts, firstAgain.bundle.artifacts);

  const secondInput = input(
    ordinaryModuleV2(),
    expectedActiveReleaseFrom(first),
  );
  const second = mustCompile(secondInput);
  const secondAgain = mustCompile(secondInput);
  assert.equal(second.releaseRoot, secondAgain.releaseRoot);
  assert.deepEqual(second.bundle.artifacts, secondAgain.bundle.artifacts);

  const queryTypes = new Set(
    projectionPayload<{ queries: Array<{ queryType: string }> }>(
      second,
      PROJECTION_FAMILY_IDS.queryCatalog,
    ).queries.map((query) => query.queryType),
  );
  assert.deepEqual([...queryTypes].sort(), [
    'get',
    'list',
    'resolve',
    'search',
  ]);
  const resolveQueries = projectionPayload<{
    queries: Array<{
      queryId: string;
      queryType: string;
      resolveMatchKeys: Array<{
        authority: string;
        fieldId: string;
        matchKeyId: string;
      }>;
    }>;
  }>(second, PROJECTION_FAMILY_IDS.queryCatalog).queries.filter(
    (query) => query.queryType === 'resolve',
  );
  assert.deepEqual(
    resolveQueries.map((query) => ({
      authorities: query.resolveMatchKeys.map((key) => key.authority),
      fields: query.resolveMatchKeys.map((key) => key.fieldId),
      queryId: query.queryId,
    })),
    [
      {
        authorities: ['identifier', 'advisory'],
        fields: [
          FIXTURE_IDS.fieldIds.parentNumber,
          FIXTURE_IDS.fieldIds.parentName,
        ],
        queryId: `${FIXTURE_IDS.namespace}:query.master_resolve`,
      },
      {
        authorities: ['advisory'],
        fields: [FIXTURE_IDS.fieldIds.childRole],
        queryId: `${FIXTURE_IDS.namespace}:query.master_role_resolve`,
      },
    ],
  );
  const transitionReference = second.bundle.releaseManifest.projections.find(
    (projection) =>
      projection.familyId === PROJECTION_FAMILY_IDS.storageTransition,
  )!;
  assert.deepEqual(
    {
      languageVersion: first.bundle.releaseManifest.languageVersion,
      normalizationProfileVersion:
        first.bundle.releaseManifest.normalizationProfileVersion,
      transitionSchemaVersion: transitionReference.payloadSchemaVersion,
      v1ProjectionFamilies: first.bundle.releaseManifest.projections.map(
        (projection) => projection.familyId,
      ),
      v1ReleaseRoot: first.releaseRoot,
      v2ReleaseRoot: second.releaseRoot,
    },
    JSON.parse(
      readFileSync(
        'test/fixtures/g2/module-conformance/v1-v2.release.structural.golden.json',
        'utf8',
      ),
    ),
  );
});

test('compiler-derived conformance names the entity and missing family', () => {
  const candidate = ordinaryModuleV1() as {
    queries: Array<{ queryId: string }>;
  } & Record<string, unknown>;
  candidate.queries = candidate.queries.filter(
    (query) =>
      query.queryId !== `${FIXTURE_IDS.namespace}:query.master_role_search`,
  );
  const result = compileApplication(input(candidate));
  assert.equal(result.status, 'failed');
  assert.deepEqual(structuralDiagnostics(result), [
    {
      code: 'COMPILER_ENTITY_PROJECTION_MISSING',
      path: '$.conformance.query.search',
      subjectId: FIXTURE_IDS.entityIds.child,
    },
  ]);
});

test('executable conformance survives serialization and rejects missing or tampered results', async () => {
  const compiled = mustCompile(input(ordinaryModuleV1()));
  const plan = projectionPayload<VerificationPlanPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.verificationPlan,
  );
  const binding = {
    artifactClosureDigest: 'a'.repeat(64),
    providerRunId: 'compiler-durable-round-trip',
    releaseRoot: 'b'.repeat(64),
    verificationPlanArtifactRoot: 'c'.repeat(64),
    verificationPlanSemanticDigest: 'd'.repeat(64),
  };
  const executed = await executeVerificationPlan(plan, binding, (scenario) => ({
    negativeProbe:
      scenario.probePolarity === 'positiveAndNegative'
        ? { observed: 'negative', scenarioId: scenario.scenarioId }
        : undefined,
    positiveProbe: { observed: 'positive', scenarioId: scenario.scenarioId },
  }));
  const serialized = JSON.parse(JSON.stringify(executed)) as typeof executed;
  const expectedBinding = {
    artifactClosureDigest: binding.artifactClosureDigest,
    releaseRoot: binding.releaseRoot,
    verificationPlanArtifactRoot: binding.verificationPlanArtifactRoot,
    verificationPlanSemanticDigest: binding.verificationPlanSemanticDigest,
  };
  assert.deepEqual(
    validateExecutedVerificationPlan(plan, serialized, expectedBinding),
    { diagnostics: [], status: 'passed' },
  );

  const differentlyRooted = validateExecutedVerificationPlan(plan, serialized, {
    ...expectedBinding,
    releaseRoot: 'e'.repeat(64),
  });
  assert.equal(differentlyRooted.status, 'failed');
  assert.equal(
    differentlyRooted.diagnostics.some(
      (diagnostic) => diagnostic.code === 'VERIFICATION_RESULT_SET_INVALID',
    ),
    true,
  );

  const next = mustCompile(
    input(ordinaryModuleV2(), expectedActiveReleaseFrom(compiled)),
  );
  const nextPlan = projectionPayload<VerificationPlanPayloadV1>(
    next,
    PROJECTION_FAMILY_IDS.verificationPlan,
  );
  const stale = validateExecutedVerificationPlan(nextPlan, serialized);
  assert.equal(stale.status, 'failed');
  assert.ok(
    stale.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'VERIFICATION_RESULT_SET_INVALID' ||
        diagnostic.code === 'VERIFICATION_EXECUTED_RESULT_MISSING' ||
        diagnostic.code === 'VERIFICATION_EXECUTED_RESULT_UNDECLARED',
    ),
  );

  const labelsOnly = validateExecutedVerificationPlan(plan, {
    ...serialized,
    resultSetDigest: '0'.repeat(64),
    results: [],
  });
  assert.equal(labelsOnly.status, 'failed');
  assert.equal(
    labelsOnly.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === 'VERIFICATION_EXECUTED_RESULT_MISSING',
    ).length,
    plan.scenarios.length,
  );

  const partial = validateExecutedVerificationPlan(plan, {
    ...serialized,
    results: serialized.results.slice(1),
  });
  assert.equal(partial.status, 'failed');
  assert.equal(
    partial.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === 'VERIFICATION_EXECUTED_RESULT_MISSING',
    ).length,
    1,
  );

  const tamperedResult = validateExecutedVerificationPlan(plan, {
    ...serialized,
    results: serialized.results.map((result, index) =>
      index === 0
        ? ({
            ...result,
            positiveProbeDigest: '1'.repeat(64),
          } satisfies ExecutedVerificationResult)
        : result,
    ),
  });
  assert.equal(tamperedResult.status, 'failed');
  assert.equal(
    tamperedResult.diagnostics.some(
      (diagnostic) => diagnostic.code === 'VERIFICATION_RESULT_SET_INVALID',
    ),
    true,
  );

  for (const forbidden of [
    { skipVerification: true },
    { sampleSize: 1 },
    { timeBoxMs: 1 },
  ]) {
    await assert.rejects(
      executeVerificationPlan(plan, { ...binding, ...forbidden }, () => ({
        positiveProbe: true,
      })),
      /command is closed/,
    );
  }
});

test('parent-scoped children receive the complete Q0/O0 and surface quartet', () => {
  const compiled = mustCompile(input(ordinaryModuleV1()));
  const queries = projectionPayload<{
    queries: Array<{ queryType: string; sourceEntityId: string }>;
  }>(compiled, PROJECTION_FAMILY_IDS.queryCatalog).queries.filter(
    (query) => query.sourceEntityId === FIXTURE_IDS.entityIds.child,
  );
  assert.deepEqual(queries.map((query) => query.queryType).sort(), [
    'get',
    'list',
    'resolve',
    'search',
  ]);
  const operations = projectionPayload<{
    operations: Array<{
      effect: { entity: { targetId: string }; kind: string };
    }>;
  }>(compiled, PROJECTION_FAMILY_IDS.operationCatalog).operations.filter(
    (operation) =>
      operation.effect.entity?.targetId === FIXTURE_IDS.entityIds.child,
  );
  assert.deepEqual(
    operations.map((operation) => operation.effect.kind).sort(),
    [
      'archiveRecordEffect',
      'createRecordEffect',
      'restoreRecordEffect',
      'updateRecordEffect',
    ],
  );
  const surfaces = projectionPayload<{
    surfaces: Array<{ surfaceId: string; surfaceRole: string }>;
  }>(compiled, PROJECTION_FAMILY_IDS.surfaceManifest).surfaces.filter(
    (surface) => surface.surfaceId.includes('master_role'),
  );
  assert.deepEqual(surfaces.map((surface) => surface.surfaceRole).sort(), [
    'form',
    'list',
    'record',
  ]);
  const agent = projectionPayload<{
    operations: Array<{ operationId: string }>;
    queries: Array<{ queryId: string }>;
  }>(compiled, PROJECTION_FAMILY_IDS.agentDiscovery);
  assert.equal(
    agent.queries.filter((query) => query.queryId.includes('master_role_'))
      .length,
    4,
  );
  assert.equal(
    agent.operations.filter((operation) =>
      operation.operationId.includes('master_role_'),
    ).length,
    4,
  );
});

test('compiled field/input contracts and enum defenses preserve declared semantics generically', () => {
  const compiled = mustCompile(input(ordinaryModuleV1()));
  const operations = projectionPayload<{
    operations: Array<{
      inputContract?: {
        closedArgumentKeys: string[];
        fields: Array<{
          classification: string;
          enumOptionIds: string[];
          fieldId: string;
          fieldKind: string;
          normalization: string;
          required: boolean;
          temporal: {
            precision: string | null;
            timezoneSemantics: string | null;
          };
        }>;
        schemaVersion: string;
        writableFieldIds: string[];
      };
      operationId: string;
    }>;
  }>(compiled, PROJECTION_FAMILY_IDS.operationCatalog).operations;
  const childCreate = operations.find((operation) =>
    operation.operationId.endsWith(':operation.master_role_create'),
  );
  assert.deepEqual(childCreate?.inputContract, {
    closedArgumentKeys: ['recordId', 'relations', 'values'],
    fields: [
      {
        bounds: {
          maximumLength: null,
          precision: null,
          scale: null,
        },
        classification: 'INTERNAL',
        enumOptionIds: [
          FIXTURE_IDS.optionIds.owner,
          FIXTURE_IDS.optionIds.buyer,
        ],
        fieldId: FIXTURE_IDS.fieldIds.childRole,
        fieldKind: 'enumFieldType',
        normalization: 'none',
        required: true,
        temporal: { precision: null, timezoneSemantics: null },
        writable: true,
      },
    ],
    relationInputs: [
      {
        archiveBehavior: 'restrict',
        relationId: `${FIXTURE_IDS.namespace}:relation.master_role_parent`,
        required: true,
      },
    ],
    schemaVersion: 'northstar.module-input-contract/v1',
    writableFieldIds: [FIXTURE_IDS.fieldIds.childRole],
  });
  const parentCreate = operations.find((operation) =>
    operation.operationId.endsWith(':operation.master_create'),
  );
  assert.equal(
    parentCreate?.inputContract?.fields.find(
      (field) => field.fieldId === FIXTURE_IDS.fieldIds.parentNumber,
    )?.normalization,
    'unicodeCaseFoldNoCompatibilityNormalization',
  );

  const storage = projectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const child = storage.entities.find(
    (entity) => entity.entityId === FIXTURE_IDS.entityIds.child,
  );
  const childRole = child?.columns.find(
    (column) => column.canonicalFieldId === FIXTURE_IDS.fieldIds.childRole,
  );
  assert.deepEqual(childRole?.fieldContract, {
    bounds: { maximumLength: null, precision: null, scale: null },
    enumOptionIds: [FIXTURE_IDS.optionIds.buyer, FIXTURE_IDS.optionIds.owner],
    fieldId: FIXTURE_IDS.fieldIds.childRole,
    fieldKind: 'enumFieldType',
    normalization: 'none',
    required: true,
    schemaVersion: 'northstar.module-field-contract/v1',
    temporal: { precision: null, timezoneSemantics: null },
    writable: true,
  });
  assert.deepEqual(child?.checkConstraints, [
    {
      canonicalFieldId: FIXTURE_IDS.fieldIds.childRole,
      checkKind: 'enumDomain',
      enumOptionIds: [FIXTURE_IDS.optionIds.buyer, FIXTURE_IDS.optionIds.owner],
      physicalName: child?.checkConstraints[0]?.physicalName,
      validated: false,
    },
  ]);
  assert.equal(storage.relations[0]?.archiveBehavior, 'restrict');

  const temporalCompiled = mustCompile(input(ordinaryModuleV2()));
  const temporalOperations = projectionPayload<{
    operations: Array<{
      inputContract?: {
        fields: Array<{
          bounds: {
            precision: number | null;
            scale: number | null;
          };
          fieldId: string;
          temporal: {
            precision: string | null;
            timezoneSemantics: string | null;
          };
        }>;
      };
      operationId: string;
    }>;
  }>(temporalCompiled, PROJECTION_FAMILY_IDS.operationCatalog).operations;
  const temporalFields = temporalOperations
    .find((operation) =>
      operation.operationId.endsWith(':operation.master_update'),
    )
    ?.inputContract?.fields.filter((field) =>
      new Set<string>([
        FIXTURE_IDS.fieldIds.parentLocalTime,
        FIXTURE_IDS.fieldIds.parentUtcInstant,
      ]).has(field.fieldId),
    )
    .map((field) => ({ fieldId: field.fieldId, temporal: field.temporal }));
  assert.deepEqual(temporalFields, [
    {
      fieldId: FIXTURE_IDS.fieldIds.parentLocalTime,
      temporal: {
        precision: 'second',
        timezoneSemantics: 'localWallTime',
      },
    },
    {
      fieldId: FIXTURE_IDS.fieldIds.parentUtcInstant,
      temporal: {
        precision: 'millisecond',
        timezoneSemantics: 'utcInstant',
      },
    },
  ]);
  assert.deepEqual(
    temporalOperations
      .find((operation) =>
        operation.operationId.endsWith(':operation.master_update'),
      )
      ?.inputContract?.fields.find(
        (field) => field.fieldId === FIXTURE_IDS.fieldIds.parentAmount,
      )?.bounds,
    { maximumLength: null, precision: 5, scale: 2 },
  );
});

test('unsupported field classifications fail closed with one stable compiler diagnostic', () => {
  for (const classification of ['confidential', 'restricted'] as const) {
    const definition = ordinaryModuleV1() as {
      fields: Array<{ classification: string; fieldId: string }>;
    };
    const field = definition.fields[0]!;
    field.classification = classification;
    const result = compileApplication(input(definition));
    assert.equal(result.status, 'failed');
    assert.deepEqual(structuralDiagnostics(result), [
      {
        code: 'MODULE_CLASSIFICATION_UNSUPPORTED',
        path: '$.fields.classification',
        subjectId: field.fieldId,
      },
    ]);
  }

  const supported = ordinaryModuleV1() as {
    fields: Array<{ classification: string }>;
  };
  supported.fields[0]!.classification = 'public';
  assert.equal(compileApplication(input(supported)).status, 'compiled');
});

test('reporting is a sanctioned required family and has per-entity lineage', () => {
  assert.equal(
    requiredProjectionFamily('reporting'),
    PROJECTION_FAMILY_IDS.reporting,
  );
  const first = mustCompile(input(ordinaryModuleV1()));
  const reporting = projectionPayload<{
    entities: Array<{
      entityId: string;
      fields: Array<{
        fieldId: string;
        lineage: { canonicalEntityId: string; canonicalFieldId: string };
      }>;
    }>;
  }>(first, PROJECTION_FAMILY_IDS.reporting);
  assert.deepEqual(
    reporting.entities.map((entity) => entity.entityId).sort(),
    [FIXTURE_IDS.entityIds.child, FIXTURE_IDS.entityIds.parent].sort(),
  );
  for (const entity of reporting.entities) {
    for (const field of entity.fields) {
      assert.deepEqual(field.lineage, {
        canonicalEntityId: entity.entityId,
        canonicalFieldId: field.fieldId,
      });
    }
  }
  const second = mustCompile(
    input(ordinaryModuleV2(), expectedActiveReleaseFrom(first)),
  );
  assert.ok(
    diffCompiledReleases(first, second).impactCodes.includes(
      'reporting-projection-changed',
    ),
  );
});

test('adoption retains the explicit v2 and v1 compatibility authorities', () => {
  assert.equal(PREVIOUS_LANGUAGE_VERSION, 'v1');
  assert.equal(
    PREVIOUS_NORMALIZATION_PROFILE_VERSION,
    'northstar.normalization/v1',
  );
  assert.equal(LANGUAGE_VERSION, 'v2');
  assert.equal(NORMALIZATION_PROFILE_VERSION, 'northstar.normalization/v2');
  // Derived, not pinned: this control is about adoption LEAVING the older
  // authorities alone, so it must not itself name the adopted version. The
  // adopted value is pinned once, in normalization.test.ts's adoption ratchet.
  assert.equal(
    MODULE_COMPILER_PROFILE.languageVersion,
    ADOPTED_LANGUAGE_VERSION,
  );
  const legacy = replaceVersion(
    ordinaryModuleV1(),
    FIXTURE_LANGUAGE_VERSION,
    'v0-experimental',
  ) as Record<string, unknown>;
  delete legacy.impactAnalyses;
  legacy.normalizationProfileVersion =
    'northstar.normalization/v0-experimental';
  assert.throws(
    () => normalizeApplicationPackage(legacy),
    (error: unknown) =>
      error instanceof CanonicalModelError &&
      error.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'CANON_QUERY_TYPE_VERSION_UNSUPPORTED',
      ),
  );
});

test('v3 compiles through explicit profile dispatch with the complete v2 projection structure', () => {
  const authoredV2 = replaceVersion(
    ordinaryModuleV1(),
    FIXTURE_LANGUAGE_VERSION,
    LANGUAGE_VERSION,
  ) as Record<string, unknown>;
  delete authoredV2.impactAnalyses;
  authoredV2.normalizationProfileVersion = NORMALIZATION_PROFILE_VERSION;
  const normalizedV2 = normalizeApplicationPackage(authoredV2);
  const v2Input = inputNormalized(normalizedV2);
  v2Input.profile = {
    ...MODULE_COMPILER_PROFILE,
    languageVersion: LANGUAGE_VERSION,
    normalizationProfileVersion: NORMALIZATION_PROFILE_VERSION,
  };
  const v2 = mustCompile(v2Input);

  const authoredV3 = ordinaryModuleV1();
  const authoredOperation = (
    authoredV3.operations as Array<Record<string, unknown>>
  )[0]!;
  authoredOperation.precondition = {
    kind: 'booleanPredicate',
    schemaVersion: LANGUAGE_VERSIONS.v3,
    value: false,
  };
  const normalizedV3 = normalizeApplicationPackage(authoredV3);
  const v3Input = inputNormalized(normalizedV3);
  v3Input.profile = {
    ...MODULE_COMPILER_PROFILE,
    languageVersion: LANGUAGE_VERSIONS.v3,
    normalizationProfileVersion: NORMALIZATION_PROFILE_VERSIONS.v3,
  };
  const v3 = mustCompile(v3Input);

  const v3TransitionInput = inputNormalized(
    normalizedV3,
    expectedActiveReleaseFrom(v2),
  );
  v3TransitionInput.profile = { ...v3Input.profile };
  const v3Transitioned = mustCompile(v3TransitionInput);
  const versionOnlyTransition = projectionPayload<StorageTransitionEnvelope>(
    v3Transitioned,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  assert.deepEqual(versionOnlyTransition.elements, []);

  assert.deepEqual(
    v3.bundle.releaseManifest.projections.map((entry) => entry.familyId),
    v2.bundle.releaseManifest.projections.map((entry) => entry.familyId),
  );
  for (const projection of v2.bundle.releaseManifest.projections) {
    assert.deepEqual(
      structuralShape(projectionPayload(v3, projection.familyId)),
      structuralShape(projectionPayload(v2, projection.familyId)),
      projection.familyId,
    );
  }
  assert.equal(v3.bundle.releaseManifest.languageVersion, LANGUAGE_VERSIONS.v3);
  assert.equal(
    v3.bundle.releaseManifest.normalizationProfileVersion,
    NORMALIZATION_PROFILE_VERSIONS.v3,
  );
  const operationCatalog = projectionPayload<{
    operations: Array<{ operationId: string; precondition: unknown }>;
  }>(v3, PROJECTION_FAMILY_IDS.operationCatalog);
  const normalizedPrecondition = normalizedV3.operations.find(
    (operation) => operation.operationId === authoredOperation.operationId,
  )?.precondition;
  assert.deepEqual(normalizedPrecondition, {
    kind: 'booleanPredicate',
    schemaVersion: LANGUAGE_VERSIONS.v3,
    value: false,
  });
  assert.deepEqual(
    operationCatalog.operations.find(
      (operation) => operation.operationId === authoredOperation.operationId,
    )?.precondition,
    normalizedPrecondition,
  );

  const invalidV3 = structuredClone(normalizedV3);
  invalidV3.queries.find(
    (query) => query.queryType === 'resolve',
  )!.resolveMatchKeys = [];
  const invalidInput = inputNormalized(invalidV3);
  invalidInput.profile = { ...v3Input.profile };
  const rejected = compileApplication(invalidInput);
  assert.equal(rejected.status, 'failed');
  assert.ok(
    rejected.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'COMPILER_RESOLVE_MATCH_AUTHORITY_REQUIRED',
    ),
  );
});

test('v3 aggregate catalog metadata is derived from one canonical source', () => {
  const normalized = normalizeApplicationPackage(v3AggregateModule());
  const compilerInput = inputNormalized(normalized);
  compilerInput.profile = {
    ...MODULE_COMPILER_PROFILE,
    languageVersion: LANGUAGE_VERSIONS.v3,
    normalizationProfileVersion: NORMALIZATION_PROFILE_VERSIONS.v3,
  };
  const compiled = mustCompile(compilerInput);
  const catalog = projectionPayload<{
    queries: Array<{
      aggregate?: {
        fieldId: string;
        measureFieldType: Record<string, unknown>;
        operator: string;
        resultType: Record<string, unknown>;
        selectionId: string;
      };
      parameters?: Array<{
        parameterId: string;
        parameterType: { kind: string };
      }>;
      queryId: string;
      queryType: string;
      resultContract?: Record<string, unknown>;
    }>;
  }>(compiled, PROJECTION_FAMILY_IDS.queryCatalog);
  const aggregate = catalog.queries.find(
    (query) => query.queryId === V3_AGGREGATE_IDS.aggregateQuery,
  );
  assert.deepEqual(aggregate, {
    aggregate: {
      fieldId: FIXTURE_IDS.fieldIds.parentAmount,
      measureFieldType: {
        kind: 'exactDecimalFieldType',
        precision: 5,
        representation: 'canonicalString',
        scale: 2,
        schemaVersion: LANGUAGE_VERSIONS.v3,
      },
      operator: 'sum',
      resultType: {
        kind: 'exactDecimalAggregateResultType',
        precision: 38,
        scale: 2,
        schemaVersion: LANGUAGE_VERSIONS.v3,
      },
      selectionId: V3_AGGREGATE_IDS.aggregateSelection,
    },
    aggregatePlan: {
      costClass: 'tenantBoundedScan',
      kind: 'queryAggregateLoweringPlan',
      loweringRowId: 'northstar.query-aggregate-lowering/required-sum-v1',
      providerProbeId: 'Q1-P3b/required-sum-tenant-bounded-scan',
      schemaVersion: 'northstar.query-aggregate-lowering-plan/postgres-v1',
      sourceFieldType: {
        kind: 'exactDecimalFieldType',
        precision: 5,
        representation: 'canonicalString',
        scale: 2,
        schemaVersion: LANGUAGE_VERSIONS.v3,
      },
    },
    filter: (
      normalized.queries.find(
        (query) => query.queryId === V3_AGGREGATE_IDS.aggregateQuery,
      ) as { filter: unknown }
    ).filter,
    filterPlan: {
      costClass: 'tenantBoundedScan',
      kind: 'predicateLoweringPlan',
      positionProfileVersion: 'northstar.predicate-position-profile/v1',
      predicateDigest:
        'dcb40bb99f3a2cb9845832fa096bf3a981d26a07aec198a66a7e03d8450f1e2f',
      root: {
        kind: 'allPredicate',
        terms: [
          {
            comparisonMode: 'unicodeCaseFold',
            costClass: 'indexedFoldedEquality',
            fieldId: FIXTURE_IDS.fieldIds.parentNumber,
            kind: 'fieldComparisonPredicate',
            loweringRowId: 'northstar.predicate-lowering/folded-equality-v1',
            operator: 'equals',
            sourceFieldType: {
              kind: 'textFieldType',
              maximumLength: 40,
              schemaVersion: LANGUAGE_VERSIONS.v3,
            },
            value: {
              kind: 'queryParameterReference',
              parameterId: V3_AGGREGATE_IDS.stockParameter,
              schemaVersion: LANGUAGE_VERSIONS.v3,
            },
          },
          {
            comparisonMode: 'binary',
            costClass: 'tenantBoundedScan',
            fieldId: FIXTURE_IDS.fieldIds.parentUtcInstant,
            kind: 'fieldComparisonPredicate',
            loweringRowId:
              'northstar.predicate-lowering/parameterized-comparison-v1',
            operator: 'lessThanOrEqual',
            sourceFieldType: {
              kind: 'dateTimeFieldType',
              precision: 'millisecond',
              schemaVersion: LANGUAGE_VERSIONS.v3,
              timezoneSemantics: 'utcInstant',
            },
            value: {
              kind: 'queryParameterReference',
              parameterId: V3_AGGREGATE_IDS.atTimeParameter,
              schemaVersion: LANGUAGE_VERSIONS.v3,
            },
          },
        ],
      },
      schemaVersion:
        'northstar.predicate-lowering-plan/postgres-parameterized-v1',
    },
    lifecycle: 'active',
    maximumResultCount: 1,
    parameters: [
      {
        orderKey: 10,
        parameterId: V3_AGGREGATE_IDS.stockParameter,
        parameterType: {
          kind: 'textFieldType',
          maximumLength: 40,
          schemaVersion: LANGUAGE_VERSIONS.v3,
        },
      },
      {
        orderKey: 20,
        parameterId: V3_AGGREGATE_IDS.atTimeParameter,
        parameterType: {
          kind: 'dateTimeFieldType',
          precision: 'millisecond',
          schemaVersion: LANGUAGE_VERSIONS.v3,
          timezoneSemantics: 'utcInstant',
        },
      },
    ],
    permissionId: `${FIXTURE_IDS.namespace}:permission.master_read`,
    queryId: V3_AGGREGATE_IDS.aggregateQuery,
    queryType: 'aggregate',
    resultContract: {
      kind: 'semanticAggregateResult',
      outcome: 'exact',
      schemaVersion: 'northstar.semantic-aggregate-result/v1',
    },
    sourceEntityId: FIXTURE_IDS.entityIds.parent,
    tier: 'q1',
  });

  const semantic = projectionPayload<{
    constructs: Array<{ constructKind: string; subjectId: string }>;
  }>(compiled, PROJECTION_FAMILY_IDS.semanticModel);
  assert.deepEqual(
    semantic.constructs
      .filter(
        (construct) => construct.subjectId === V3_AGGREGATE_IDS.aggregateQuery,
      )
      .map(({ constructKind, subjectId }) => ({ constructKind, subjectId })),
    [
      {
        constructKind: 'queryDefinition',
        subjectId: V3_AGGREGATE_IDS.aggregateQuery,
      },
    ].sort((left, right) =>
      left.subjectId < right.subjectId
        ? -1
        : left.subjectId > right.subjectId
          ? 1
          : 0,
    ),
  );

  const tamperedResultType = structuredClone(normalized) as unknown as {
    queries: Array<Record<string, unknown>>;
  };
  const tamperedAggregate = tamperedResultType.queries.find(
    (query) => query.queryId === V3_AGGREGATE_IDS.aggregateQuery,
  )!.aggregate as { resultType: Record<string, unknown> };
  tamperedAggregate.resultType.scale = 3;
  const tamperedResultInput = inputNormalized(tamperedResultType);
  tamperedResultInput.profile = { ...compilerInput.profile };
  const tamperedResult = compileApplication(tamperedResultInput);
  assert.equal(tamperedResult.status, 'failed');
  assert.ok(
    tamperedResult.diagnostics.some(
      (diagnostic) => diagnostic.code === 'CANON_NORMALIZED_DERIVED_MISMATCH',
    ),
  );

  const tamperedParameter = structuredClone(normalized) as unknown as {
    queries: Array<Record<string, unknown>>;
  };
  const tamperedFilter = tamperedParameter.queries.find(
    (query) => query.queryId === V3_AGGREGATE_IDS.aggregateQuery,
  )!.filter as { terms: Array<Record<string, unknown>> };
  (tamperedFilter.terms[0]!.value as Record<string, unknown>).parameterId =
    'northstar.modulefixture:parameter.missing';
  const tamperedParameterInput = inputNormalized(tamperedParameter);
  tamperedParameterInput.profile = { ...compilerInput.profile };
  const unresolvedParameter = compileApplication(tamperedParameterInput);
  assert.equal(unresolvedParameter.status, 'failed');
  assert.ok(
    unresolvedParameter.diagnostics.some(
      (diagnostic) => diagnostic.code === 'CANON_QUERY_PARAMETER_UNRESOLVED',
    ),
  );
});

test('aggregate assertions emit declared-evidence verification scenarios', () => {
  const assertionId = `${FIXTURE_IDS.namespace}:assertion.aggregate_verification`;
  const withoutAssertion = mustCompile(input(v3AggregateModule()));
  const withoutPlan = projectionPayload<VerificationPlanPayloadV1>(
    withoutAssertion,
    PROJECTION_FAMILY_IDS.verificationPlan,
  );
  assert.deepEqual(declaredEvidenceFor(withoutPlan, assertionId), []);

  const definition = v3AggregateModule() as {
    assertions: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  definition.assertions.push(
    queryAssertion(assertionId, V3_AGGREGATE_IDS.aggregateQuery),
  );
  const compiled = mustCompile(input(definition));
  const plan = projectionPayload<VerificationPlanPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.verificationPlan,
  );
  assert.deepEqual(
    declaredEvidenceFor(plan, assertionId).map((scenario) => ({
      assertionId: scenario.assertionId,
      entityId: scenario.entityId,
      evidenceKind: scenario.evidenceKind,
      invocation: scenario.invocation,
      kind: scenario.kind,
      subjectId: scenario.subjectId,
    })),
    [
      {
        assertionId,
        entityId: FIXTURE_IDS.entityIds.parent,
        evidenceKind: 'provider',
        invocation: {
          kind: 'queryInvocation',
          query: {
            kind: 'queryReference',
            schemaVersion: LANGUAGE_VERSIONS.v3,
            targetId: V3_AGGREGATE_IDS.aggregateQuery,
          },
          schemaVersion: LANGUAGE_VERSIONS.v3,
        },
        kind: 'declaredEvidence',
        subjectId: FIXTURE_IDS.entityIds.parent,
      },
    ],
  );
});

test('unresolvable assertion queries fail compilation with the assertion identity', () => {
  const assertionId = `${FIXTURE_IDS.namespace}:assertion.unresolvable_query`;
  const valid = v3AggregateModule() as {
    assertions: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  valid.assertions.push(
    queryAssertion(assertionId, `${FIXTURE_IDS.namespace}:query.master_get`),
  );
  const validCompiled = mustCompile(input(valid));
  const validPlan = projectionPayload<VerificationPlanPayloadV1>(
    validCompiled,
    PROJECTION_FAMILY_IDS.verificationPlan,
  );
  assert.equal(declaredEvidenceFor(validPlan, assertionId).length, 1);

  const unresolved = structuredClone(
    normalizeApplicationPackage(valid),
  ) as unknown as {
    assertions: Array<{
      assertionId: string;
      invocation: { query: { targetId: string } };
    }>;
  };
  unresolved.assertions.find(
    (assertion) => assertion.assertionId === assertionId,
  )!.invocation.query.targetId = `${FIXTURE_IDS.namespace}:query.missing`;
  const rejected = compileApplication(inputNormalized(unresolved));
  assert.equal(rejected.status, 'failed');
  assert.deepEqual(structuralDiagnostics(rejected), [
    {
      code: 'CANON_REFERENCE_UNRESOLVED',
      path: '$.assertions.invocation.query',
      subjectId: assertionId,
    },
  ]);
});

test('capability operation assertions derive their scenario subject from read-back', () => {
  const assertionId = `${FIXTURE_IDS.namespace}:assertion.capability_operation`;
  const operationId = `${FIXTURE_IDS.namespace}:operation.capability_verification`;
  const definition = v3AggregateModule() as {
    assertions: Array<Record<string, unknown>>;
    operations: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  const operation = structuredClone(definition.operations[0]!);
  operation.operationId = operationId;
  operation.effect = {
    capability: {
      kind: 'capabilityReference',
      schemaVersion: LANGUAGE_VERSIONS.v3,
      targetId: `${FIXTURE_IDS.namespace}:capability.standard_surface_content`,
    },
    kind: 'registeredCapabilityEffect',
    schemaVersion: LANGUAGE_VERSIONS.v3,
  };
  operation.tier = 'o1';
  definition.operations.push(operation);
  const assertion = operationAssertion(assertionId, operationId);
  assertion.expectedDiagnosticCode = 'EXPECTED_CAPABILITY_REFUSAL';
  assertion.expectedOutcome = 'fails';
  definition.assertions.push(assertion);

  const compiled = mustCompile(input(definition));
  const operationCatalog = projectionPayload<{
    readonly operations: readonly {
      readonly effect: unknown;
      readonly inputContract: unknown;
      readonly operationId: string;
      readonly tier: string;
    }[];
  }>(compiled, PROJECTION_FAMILY_IDS.operationCatalog);
  const capabilityOperation = operationCatalog.operations.find(
    (candidate) => candidate.operationId === operationId,
  );
  assert.deepEqual(capabilityOperation, {
    confirmation: 'none',
    effect: {
      capability: {
        kind: 'capabilityReference',
        schemaVersion: LANGUAGE_VERSIONS.v3,
        targetId: `${FIXTURE_IDS.namespace}:capability.standard_surface_content`,
      },
      kind: 'registeredCapabilityEffect',
      schemaVersion: LANGUAGE_VERSIONS.v3,
    },
    inputContract: {
      closedArgumentKeys: ['expectedRevision', 'recordId'],
      fields: [],
      relationInputs: [],
      schemaVersion: 'northstar.module-input-contract/v1',
      writableFieldIds: [],
    },
    infrastructure: {
      archiveRepresentation: 'nullableArchivedAt',
      optimisticRevision: 'compareAndIncrement',
      recordIdentity: 'canonicalUuid',
    },
    lifecycle: 'active',
    operationId,
    permissionId: `${FIXTURE_IDS.namespace}:permission.master_create`,
    precondition: {
      kind: 'booleanPredicate',
      schemaVersion: LANGUAGE_VERSIONS.v3,
      value: true,
    },
    readBackQueryId: `${FIXTURE_IDS.namespace}:query.master_get`,
    tier: 'o1',
  });
  const plan = projectionPayload<VerificationPlanPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.verificationPlan,
  );
  assert.deepEqual(
    declaredEvidenceFor(plan, assertionId).map((scenario) => ({
      entityId: scenario.entityId,
      expectedDiagnosticCode: scenario.expectedDiagnosticCode,
      expectedOutcome: scenario.expectedOutcome,
      subjectId: scenario.subjectId,
    })),
    [
      {
        entityId: FIXTURE_IDS.entityIds.parent,
        expectedDiagnosticCode: 'EXPECTED_CAPABILITY_REFUSAL',
        expectedOutcome: 'fails',
        subjectId: FIXTURE_IDS.entityIds.parent,
      },
    ],
  );
});

test('aggregate verification registration preserves row-query assertion scenarios', () => {
  const rowAssertionId = `${FIXTURE_IDS.namespace}:assertion.row_regression`;
  const aggregateAssertionId = `${FIXTURE_IDS.namespace}:assertion.aggregate_regression`;
  const definition = v3AggregateModule() as {
    assertions: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  definition.assertions.push(
    queryAssertion(rowAssertionId, `${FIXTURE_IDS.namespace}:query.master_get`),
    queryAssertion(aggregateAssertionId, V3_AGGREGATE_IDS.aggregateQuery),
  );
  const compiled = mustCompile(input(definition));
  const plan = projectionPayload<VerificationPlanPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.verificationPlan,
  );
  const rowScenario = declaredEvidenceFor(plan, rowAssertionId);
  assert.equal(rowScenario.length, 1);
  assert.equal(rowScenario[0]!.entityId, FIXTURE_IDS.entityIds.parent);

  const retargeted = structuredClone(definition);
  const rowAssertion = (
    retargeted.assertions as Array<{
      assertionId: string;
      invocation: { query: { targetId: string } };
    }>
  ).find((assertion) => assertion.assertionId === rowAssertionId)!;
  rowAssertion.invocation.query.targetId = `${FIXTURE_IDS.namespace}:query.master_role_get`;
  const retargetedPlan = projectionPayload<VerificationPlanPayloadV1>(
    mustCompile(input(retargeted)),
    PROJECTION_FAMILY_IDS.verificationPlan,
  );
  const retargetedScenario = declaredEvidenceFor(
    retargetedPlan,
    rowAssertionId,
  );
  assert.equal(retargetedScenario.length, 1);
  assert.equal(retargetedScenario[0]!.entityId, FIXTURE_IDS.entityIds.child);
});

test('compiler rejects a v2 resolve query with no declared match authority', () => {
  const normalized = structuredClone(
    normalizeApplicationPackage(ordinaryModuleV1()),
  );
  const resolve = normalized.queries.find(
    (query) =>
      query.queryId === `${FIXTURE_IDS.namespace}:query.master_resolve`,
  )!;
  resolve.resolveMatchKeys = [];
  const result = compileApplication(inputNormalized(normalized));
  assert.equal(result.status, 'failed');
  assert.deepEqual(structuralDiagnostics(result), [
    {
      code: 'COMPILER_RESOLVE_MATCH_AUTHORITY_REQUIRED',
      path: '$.queries.resolveMatchKeys',
      subjectId: resolve.queryId,
    },
  ]);
});

test('missing and null storageClass produce the same stable compiler diagnostic', () => {
  for (const mode of ['missing', 'null'] as const) {
    const candidate = ordinaryModuleV1() as {
      storageMappings: Array<Record<string, unknown>>;
    };
    if (mode === 'missing') delete candidate.storageMappings[0]!.storageClass;
    else candidate.storageMappings[0]!.storageClass = null;
    const result = compileApplication(input(candidate));
    assert.equal(result.status, 'failed');
    assert.deepEqual(structuralDiagnostics(result), [
      {
        code: 'COMPILER_STORAGE_CLASS_REQUIRED',
        path: '$.storageMappings.storageClass',
        subjectId: `${FIXTURE_IDS.namespace}:storage.master`,
      },
    ]);
  }
});

test('delete operations and renderer forms fail with compiler-owned diagnostics', () => {
  const destructive = ordinaryModuleV1() as {
    operations: Array<{
      effect: Record<string, unknown>;
      operationId: string;
    }>;
  };
  const create = destructive.operations.find((operation) =>
    operation.operationId.endsWith('master_create'),
  )!;
  create.effect.kind = 'deleteRecordEffect';
  const deleteResult = compileApplication(input(destructive));
  assert.equal(deleteResult.status, 'failed');
  assert.ok(
    structuralDiagnostics(deleteResult).some(
      (diagnostic) =>
        diagnostic.code === 'COMPILER_DESTRUCTIVE_OPERATION_UNSUPPORTED' &&
        diagnostic.subjectId === create.operationId,
    ),
  );

  const rendered = ordinaryModuleV1() as {
    surfaces: Array<Record<string, unknown>>;
  };
  rendered.surfaces[0]!.renderer = {
    kind: 'rendererForm',
    rendererId: `${FIXTURE_IDS.namespace}:renderer.destructive_form`,
    schemaVersion: FIXTURE_LANGUAGE_VERSION,
  };
  const rendererResult = compileApplication(input(rendered));
  assert.equal(rendererResult.status, 'failed');
  assert.deepEqual(structuralDiagnostics(rendererResult), [
    {
      code: 'COMPILER_RENDERER_FORM_UNSUPPORTED',
      path: '$.surfaces.renderer',
      subjectId: `${FIXTURE_IDS.namespace}:surface.master_list`,
    },
  ]);
});

test('retype and rename-as-add fail with distinct stable diagnostics', () => {
  const first = mustCompile(input(ordinaryModuleV1()));
  const retype = ordinaryModuleV1() as {
    fields: Array<{
      fieldId: string;
      fieldType: { kind: string; maximumLength?: number };
    }>;
  };
  const name = retype.fields.find(
    (field) => field.fieldId === FIXTURE_IDS.fieldIds.parentName,
  )!;
  name.fieldType.maximumLength = 241;
  const retypeResult = compileApplication(
    input(retype, expectedActiveReleaseFrom(first)),
  );
  assert.equal(retypeResult.status, 'failed');
  assert.deepEqual(structuralDiagnostics(retypeResult), [
    {
      code: 'COMPILER_STORAGE_RETYPE_UNSUPPORTED',
      path: '$.fields.fieldType',
      subjectId: FIXTURE_IDS.fieldIds.parentName,
    },
  ]);

  const renamedId = `${FIXTURE_IDS.namespace}:field.master_display_name`;
  const renamed = replaceVersion(
    ordinaryModuleV1(),
    FIXTURE_IDS.fieldIds.parentName,
    renamedId,
  );
  const renameResult = compileApplication(
    input(renamed, expectedActiveReleaseFrom(first)),
  );
  assert.equal(renameResult.status, 'failed');
  assert.deepEqual(structuralDiagnostics(renameResult), [
    {
      code: 'COMPILER_STORAGE_RENAME_AS_ADD_UNSUPPORTED',
      path: '$.fields',
      subjectId: [FIXTURE_IDS.fieldIds.parentName, renamedId].sort()[0],
    },
  ]);
});

test('generatedTyped and promotion reserves normalize and round-trip but compile unsupported', () => {
  const generated = ordinaryModuleV1() as {
    storageMappings: Array<Record<string, unknown>>;
  };
  generated.storageMappings[0]!.storageClass = 'generatedTyped';
  assertCanonicalRoundTrip(generated);
  const generatedResult = compileApplication(input(generated));
  assert.equal(generatedResult.status, 'failed');
  assert.deepEqual(structuralDiagnostics(generatedResult), [
    {
      code: 'COMPILER_GENERATED_STORAGE_UNSUPPORTED',
      path: '$.storageMappings.storageClass',
      subjectId: `${FIXTURE_IDS.namespace}:storage.master`,
    },
  ]);

  const promotion = ordinaryModuleV1() as {
    storageMappings: Array<Record<string, unknown>>;
  };
  promotion.storageMappings[0]!.promotion = {
    capabilityId: PROMOTE_STORAGE_CLASS_CAPABILITY_ID,
    invariantVersion: 'northstar.storage-class-promotion-invariant/v1',
    kind: 'storageClassPromotionReserve',
    schemaVersion: FIXTURE_LANGUAGE_VERSION,
  };
  assertCanonicalRoundTrip(promotion);
  const promotionResult = compileApplication(input(promotion));
  assert.equal(promotionResult.status, 'failed');
  assert.deepEqual(structuralDiagnostics(promotionResult), [
    {
      code: 'COMPILER_STORAGE_PROMOTION_UNSUPPORTED',
      path: '$.storageMappings.promotion.capabilityId',
      subjectId: `${FIXTURE_IDS.namespace}:storage.master`,
    },
  ]);
});

test('relation additions order the column before the FK and debt preserves both release writer sets', () => {
  const first = mustCompile(input(ordinaryModuleV1()));
  const previousReaderIds = ['get', 'list', 'resolve', 'search'].map(
    (suffix) => `${FIXTURE_IDS.namespace}:query.master_role_${suffix}`,
  );
  const previousWriterIds = ['archive', 'create', 'restore', 'update'].map(
    (suffix) => `${FIXTURE_IDS.namespace}:operation.master_role_${suffix}`,
  );
  const candidateReaderIds = previousReaderIds.map((id) => `${id}_v2`);
  const candidateWriterIds = previousWriterIds.map((id) => `${id}_v2`);
  let renamedCandidate: unknown = ordinaryModuleV2();
  for (const id of [...previousReaderIds, ...previousWriterIds]) {
    renamedCandidate = replaceVersion(renamedCandidate, id, `${id}_v2`);
  }
  const candidate = renamedCandidate as {
    relations: Array<Record<string, unknown>>;
  };
  candidate.relations.push({
    archiveBehavior: 'retainReference',
    cardinality: 'manyToOne',
    foreignKeyActions: {
      onDelete: 'restrict',
      onUpdate: 'restrict',
      schemaVersion: FIXTURE_LANGUAGE_VERSION,
    },
    joinEligibility: 'query',
    kind: 'relationDefinition',
    orderKey: 20,
    ownership: 'reference',
    relationId: `${FIXTURE_IDS.namespace}:relation.master_role_secondary_parent`,
    required: false,
    schemaVersion: FIXTURE_LANGUAGE_VERSION,
    sourceEntity: {
      kind: 'entityReference',
      schemaVersion: FIXTURE_LANGUAGE_VERSION,
      targetId: FIXTURE_IDS.entityIds.child,
    },
    targetEntity: {
      kind: 'entityReference',
      schemaVersion: FIXTURE_LANGUAGE_VERSION,
      targetId: FIXTURE_IDS.entityIds.parent,
    },
  });
  const compiled = mustCompile(
    input(candidate, expectedActiveReleaseFrom(first)),
  );
  const transition = projectionPayload<StorageTransitionEnvelope>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  const relationId = `${FIXTURE_IDS.namespace}:relation.master_role_secondary_parent`;
  const relationColumn = transition.elements.find(
    (entry) => entry.kind === 'addColumn' && entry.subjectId === relationId,
  );
  const foreignKey = transition.elements.find(
    (entry) => entry.kind === 'addForeignKey' && entry.subjectId === relationId,
  );
  assert.ok(relationColumn);
  assert.ok(foreignKey);
  assert.ok(
    transition.elements.indexOf(relationColumn) <
      transition.elements.indexOf(foreignKey),
  );
  assert.deepEqual(foreignKey.declaredDependencyIds, [
    relationColumn.elementId,
  ]);
  assert.equal(transition.tighteningDebt.length, 1);
  const debt = transition.tighteningDebt[0]!;
  assert.equal(
    debt.admissionConsequence,
    'blocksTenantAccessibleModuleCreation',
  );
  assert.deepEqual(debt.blockingRootIds, [first.releaseRoot]);
  assert.equal(debt.schemaVersion, 'northstar.tightening-debt/v2');
  assert.deepEqual(debt.priorAffectedReaderQueryIds, previousReaderIds);
  assert.deepEqual(debt.candidateAffectedReaderQueryIds, candidateReaderIds);
  assert.deepEqual(debt.priorAffectedWriterOperationIds, previousWriterIds);
  assert.deepEqual(
    debt.candidateAffectedWriterOperationIds,
    candidateWriterIds,
  );
  for (const ids of [
    debt.priorAffectedReaderQueryIds,
    debt.candidateAffectedReaderQueryIds,
    debt.priorAffectedWriterOperationIds,
    debt.candidateAffectedWriterOperationIds,
  ]) {
    assert.deepEqual(ids, [...new Set(ids)].sort());
  }
  assert.equal('affectedReaderQueryIds' in debt, false);
  assert.equal('affectedWriterOperationIds' in debt, false);
  assert.equal(
    debt.liveRootResolution,
    'materializerResolvesActiveAndNonTerminalPreparationUnion',
  );
});

function input(
  definition: unknown,
  expectedActiveRelease: CompilerInput['expectedActiveRelease'] = null,
): CompilerInput {
  return inputNormalized(
    normalizeApplicationPackage(definition),
    expectedActiveRelease,
  );
}

function inputNormalized(
  normalizedDefinition: unknown,
  expectedActiveRelease: CompilerInput['expectedActiveRelease'] = null,
): CompilerInput {
  return {
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalizedDefinition),
    ),
    // Version-from-artifact: when the normalized definition declares its own
    // version, the profile follows it rather than a pinned constant. The
    // parameter stays `unknown` because several callers pass deliberately
    // partial packages to probe tampering; those declare no version, fall back
    // to the adopted profile, and override `profile` themselves anyway.
    profile: profileForNormalized(normalizedDefinition),
  };
}

function profileForNormalized(
  normalizedDefinition: unknown,
): CompilerInput['profile'] {
  const declared =
    typeof normalizedDefinition === 'object' && normalizedDefinition !== null
      ? (normalizedDefinition as Partial<CompilerInput['profile']>)
      : {};
  return {
    ...MODULE_COMPILER_PROFILE,
    ...(declared.languageVersion === undefined
      ? {}
      : { languageVersion: declared.languageVersion }),
    ...(declared.normalizationProfileVersion === undefined
      ? {}
      : {
          normalizationProfileVersion: declared.normalizationProfileVersion,
        }),
  };
}

function mustCompile(compilerInput: CompilerInput): CompileSuccess {
  const result = compileApplication(compilerInput);
  if (result.status !== 'compiled')
    throw new Error(JSON.stringify(result.diagnostics));
  return result;
}

function projectionPayload<T>(
  compiled: CompileSuccess,
  familyId: ProjectionFamilyId,
): T {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (entry) => entry.familyId === familyId,
  )!;
  const manifestArtifact = compiled.bundle.artifacts.find(
    (entry) => entry.contentHash === reference.artifactRoot,
  )!;
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  const chunk = compiled.bundle.artifacts.find(
    (entry) => entry.contentHash === manifest.chunks[0]?.contentHash,
  )!;
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
}

function structuralDiagnostics(result: CompileResult): Array<{
  code: string;
  path: string;
  subjectId: string | null;
}> {
  return result.diagnostics.map(({ code, path, subjectId }) => ({
    code,
    path,
    subjectId,
  }));
}

function declaredEvidenceFor(
  plan: VerificationPlanPayloadV1,
  assertionId: string,
): VerificationPlanPayloadV1['scenarios'][number][] {
  return plan.scenarios.filter(
    (scenario) =>
      scenario.kind === 'declaredEvidence' &&
      scenario.assertionId === assertionId,
  );
}

function queryAssertion(
  assertionId: string,
  queryId: string,
): Record<string, unknown> {
  return {
    assertionId,
    evidenceKinds: ['provider'],
    expectedDiagnosticCode: null,
    expectedOutcome: 'succeeds',
    invocation: {
      kind: 'queryInvocation',
      query: {
        kind: 'queryReference',
        schemaVersion: LANGUAGE_VERSIONS.v3,
        targetId: queryId,
      },
      schemaVersion: LANGUAGE_VERSIONS.v3,
    },
    kind: 'assertionDefinition',
    schemaVersion: LANGUAGE_VERSIONS.v3,
  };
}

function operationAssertion(
  assertionId: string,
  operationId: string,
): Record<string, unknown> {
  return {
    assertionId,
    evidenceKinds: ['provider'],
    expectedDiagnosticCode: null,
    expectedOutcome: 'succeeds',
    invocation: {
      kind: 'operationInvocation',
      operation: {
        kind: 'operationReference',
        schemaVersion: LANGUAGE_VERSIONS.v3,
        targetId: operationId,
      },
      schemaVersion: LANGUAGE_VERSIONS.v3,
    },
    kind: 'assertionDefinition',
    schemaVersion: LANGUAGE_VERSIONS.v3,
  };
}

function assertCanonicalRoundTrip(definition: unknown): void {
  const normalized = normalizeApplicationPackage(definition);
  const roundTripped = normalizeApplicationPackage(
    canonicalAuthoredProjection(normalized),
  );
  assert.equal(canonicalize(roundTripped), canonicalize(normalized));
}

function replaceVersion(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value === from ? to : value;
  if (Array.isArray(value)) {
    return value.map((entry) => replaceVersion(entry, from, to));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceVersion(entry, from, to),
      ]),
    );
  }
  return value;
}

function structuralShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(structuralShape).sort((left, right) => {
      const leftShape = JSON.stringify(left);
      const rightShape = JSON.stringify(right);
      return leftShape < rightShape ? -1 : leftShape > rightShape ? 1 : 0;
    });
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          structuralShape((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return typeof value;
}
