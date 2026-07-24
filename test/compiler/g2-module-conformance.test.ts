import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CanonicalModelError,
  LANGUAGE_VERSION,
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
  ordinaryModuleV1,
  ordinaryModuleV2,
} from '../fixtures/g2/module-conformance/definitions.js';

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

test('executable conformance rejects declarations and fabricated linked results', () => {
  const compiled = mustCompile(input(ordinaryModuleV1()));
  const plan = projectionPayload<VerificationPlanPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.verificationPlan,
  );
  const labelsOnly = validateExecutedVerificationPlan(plan, []);
  assert.equal(labelsOnly.status, 'failed');
  assert.equal(labelsOnly.diagnostics.length, plan.scenarios.length);

  const fabricated = plan.scenarios.map(
    (scenario): ExecutedVerificationResult => ({
      negativeProbeDigest:
        scenario.probePolarity === 'positiveAndNegative'
          ? '0'.repeat(64)
          : null,
      positiveProbeDigest: '1'.repeat(64),
      provider: 'realPostgresql',
      providerRunId: 'fabricated',
      scenarioFingerprint: scenario.scenarioFingerprint,
      scenarioId: scenario.scenarioId,
      schemaVersion: 'northstar.verification-result/v1',
    }),
  );
  const fabricatedResult = validateExecutedVerificationPlan(plan, fabricated);
  assert.equal(fabricatedResult.status, 'failed');
  assert.equal(fabricatedResult.diagnostics.length, plan.scenarios.length);
  assert.equal(
    fabricatedResult.diagnostics.every(
      (diagnostic) =>
        diagnostic.code === 'VERIFICATION_EXECUTED_RESULT_INVALID',
    ),
    true,
  );
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

test('resolver authority is explicit language v2 evolution while v1 remains profile-stable', () => {
  assert.equal(PREVIOUS_LANGUAGE_VERSION, 'v1');
  assert.equal(
    PREVIOUS_NORMALIZATION_PROFILE_VERSION,
    'northstar.normalization/v1',
  );
  assert.equal(LANGUAGE_VERSION, 'v2');
  assert.equal(NORMALIZATION_PROFILE_VERSION, 'northstar.normalization/v2');
  assert.equal(MODULE_COMPILER_PROFILE.languageVersion, 'v2');
  const legacy = replaceVersion(
    ordinaryModuleV1(),
    LANGUAGE_VERSION,
    'v0-experimental',
  ) as Record<string, unknown>;
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
    schemaVersion: LANGUAGE_VERSION,
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
    schemaVersion: LANGUAGE_VERSION,
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
      schemaVersion: LANGUAGE_VERSION,
    },
    joinEligibility: 'query',
    kind: 'relationDefinition',
    orderKey: 20,
    ownership: 'reference',
    relationId: `${FIXTURE_IDS.namespace}:relation.master_role_secondary_parent`,
    required: false,
    schemaVersion: LANGUAGE_VERSION,
    sourceEntity: {
      kind: 'entityReference',
      schemaVersion: LANGUAGE_VERSION,
      targetId: FIXTURE_IDS.entityIds.child,
    },
    targetEntity: {
      kind: 'entityReference',
      schemaVersion: LANGUAGE_VERSION,
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
    profile: { ...MODULE_COMPILER_PROFILE },
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
