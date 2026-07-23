import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  MODULE_RLS_GRANT_TEMPLATE,
  PHYSICAL_MAPPING_VERSION,
  POSTGRESQL_FIELD_TYPE_TABLE,
  PROJECTION_FAMILY_IDS,
  STORAGE_COMPATIBILITY_MATRIX,
  STORAGE_TRANSITION_ENVELOPE_VERSION,
  classifyStorageTransitionElement,
  compileApplication,
  expectedActiveReleaseFrom,
  validatePhysicalMappingRecords,
  validateStorageRendererStatements,
  type CompileSuccess,
  type CompilerInput,
  type PhysicalMappingRecord,
  type ProjectionFamilyId,
  type ProjectionManifestEnvelope,
  type StorageTargetPayloadV1,
  type StorageTransitionEnvelope,
} from '../../packages/compiler/src/index.js';
import {
  FIXTURE_IDS,
  ordinaryModuleV1,
  ordinaryModuleV2,
} from '../fixtures/g2/module-conformance/definitions.js';

test('v1 storage lowering is deterministic across schedules and authored permutations', () => {
  const authored = ordinaryModuleV2();
  const canonical = mustCompile(input(authored), 'canonical');
  const reverse = mustCompile(input(authored), 'reverse');
  const interleaved = mustCompile(input(authored), 'interleaved');
  assert.equal(canonical.releaseRoot, reverse.releaseRoot);
  assert.equal(canonical.releaseRoot, interleaved.releaseRoot);
  assert.deepEqual(canonical.bundle.artifacts, reverse.bundle.artifacts);
  assert.deepEqual(canonical.bundle.artifacts, interleaved.bundle.artifacts);

  for (let seed = 1; seed <= 8; seed += 1) {
    const candidate = structuredClone(authored) as Record<string, unknown[]>;
    for (const family of [
      'assertions',
      'capabilityRequirements',
      'entities',
      'fields',
      'modules',
      'operations',
      'permissions',
      'queries',
      'relations',
      'storageMappings',
      'surfaces',
    ]) {
      candidate[family] = permute(candidate[family] ?? [], seed);
    }
    candidate.queries = (candidate.queries ?? []).map((query) => {
      const value = query as { selections: unknown[] };
      return { ...value, selections: permute(value.selections, seed + 11) };
    });
    candidate.surfaces = (candidate.surfaces ?? []).map((surface) => {
      const value = surface as { slots: unknown[] };
      return { ...value, slots: permute(value.slots, seed + 17) };
    });
    const compiled = mustCompile(input(candidate));
    assert.equal(compiled.releaseRoot, canonical.releaseRoot);
    assert.deepEqual(
      compiled.bundle.releaseManifestBytes,
      canonical.bundle.releaseManifestBytes,
    );
  }
});

test('the v1 transition envelope matches its structural golden and has no provisional lineage', () => {
  const first = mustCompile(input(ordinaryModuleV1()));
  const second = mustCompile(
    input(ordinaryModuleV2(), expectedActiveReleaseFrom(first)),
  );
  const transition = projectionPayload<StorageTransitionEnvelope>(
    second,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  assert.equal(transition.kind, 'storageTransitionEnvelope');
  assert.equal(transition.schemaVersion, STORAGE_TRANSITION_ENVELOPE_VERSION);
  assert.doesNotMatch(canonicalize(transition), /v0-provisional/);
  assert.doesNotMatch(canonicalize(transition), /storageTransitionPayload/);
  assert.equal(transition.fromReleaseRoot, first.releaseRoot);
  assert.equal(transition.elements.length, 1);
  assert.deepEqual(
    structuralTransition(transition),
    JSON.parse(
      readFileSync(
        'test/fixtures/g2/module-conformance/v1-v2.transition.structural.golden.json',
        'utf8',
      ),
    ),
  );
});

test('physical names, reverse mappings, PostgreSQL types, scope, RLS, and grants are explicit', () => {
  const compiled = mustCompile(input(ordinaryModuleV1()));
  const storage = projectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.deepEqual(storage.fieldTypeTable, POSTGRESQL_FIELD_TYPE_TABLE);
  assert.deepEqual(storage.rlsGrantTemplate, MODULE_RLS_GRANT_TEMPLATE);
  assert.deepEqual(storage.rlsGrantTemplate.grants, [
    'SELECT',
    'INSERT',
    'UPDATE',
  ]);
  assert.equal(storage.rlsGrantTemplate.forcedRowLevelSecurity, true);
  assert.deepEqual(storage.rlsGrantTemplate.scopeKeyColumns, [
    'tenant_id',
    'environment_id',
  ]);
  assert.ok(storage.physicalMapping.records.length > 0);
  for (const record of storage.physicalMapping.records) {
    assert.ok(Buffer.byteLength(record.physicalName, 'utf8') <= 63);
    assert.match(record.physicalName, /^nsm_[ctik]_[a-z2-7]{52}$/);
    assert.match(record.shapeFingerprint, /^[0-9a-f]{64}$/);
  }
  for (const entity of storage.entities) {
    assert.deepEqual(entity.primaryKey.columns.slice(0, 2), [
      'tenant_id',
      'environment_id',
    ]);
    for (const unique of entity.uniqueKeys) {
      assert.deepEqual(unique.columns.slice(0, 2), [
        'tenant_id',
        'environment_id',
      ]);
    }
  }
  for (const relation of storage.relations) {
    assert.deepEqual(relation.foreignKey.sourceColumns.slice(0, 2), [
      'tenant_id',
      'environment_id',
    ]);
    assert.deepEqual(relation.foreignKey.targetColumns.slice(0, 2), [
      'tenant_id',
      'environment_id',
    ]);
    assert.equal(relation.foreignKey.onDelete, 'restrict');
    assert.equal(relation.foreignKey.onUpdate, 'restrict');
  }
  const requiredColumns = storage.entities.flatMap((entity) =>
    entity.columns.filter((column) =>
      [
        FIXTURE_IDS.fieldIds.parentNumber,
        FIXTURE_IDS.fieldIds.parentName,
        FIXTURE_IDS.fieldIds.childRole,
      ].includes(column.canonicalFieldId as never),
    ),
  );
  assert.equal(requiredColumns.length, 3);
  assert.ok(
    requiredColumns.every(
      (column) => !column.nullable && column.coexistenceImpact === 'none',
    ),
  );
});

test('physical mapping validation rejects collisions, incompatible reuse, and overlength names stably', () => {
  const base: PhysicalMappingRecord = {
    canonicalId: 'northstar.fixture:field.a',
    mappingVersion: PHYSICAL_MAPPING_VERSION,
    objectKind: 'column',
    physicalName: `nsm_c_${'a'.repeat(52)}`,
    shapeFingerprint: '1'.repeat(64),
    storageDomain: 'managedModule',
  };
  const collisions = validatePhysicalMappingRecords([
    base,
    { ...base, canonicalId: 'northstar.fixture:field.b' },
  ]);
  assert.deepEqual(
    collisions.map(({ code, subjectId }) => ({ code, subjectId })),
    [
      {
        code: 'COMPILER_PHYSICAL_NAME_COLLISION',
        subjectId: 'northstar.fixture:field.b',
      },
    ],
  );
  const reuse = validatePhysicalMappingRecords([
    base,
    { ...base, shapeFingerprint: '2'.repeat(64) },
  ]);
  assert.deepEqual(
    reuse.map((entry) => entry.code),
    ['COMPILER_PHYSICAL_NAME_REUSE_INCOMPATIBLE'],
  );
  const overlength = validatePhysicalMappingRecords([
    { ...base, physicalName: 'x'.repeat(64) },
  ]);
  assert.deepEqual(
    overlength.map((entry) => entry.code),
    ['COMPILER_PHYSICAL_NAME_TOO_LONG'],
  );
});

test('A2/A4 classification axes and compatibility carve-outs are exact', () => {
  assert.deepEqual(
    classifyStorageTransitionElement('createTable', 'samePlan'),
    {
      classification: {
        dataEffect: 'catalogOnly',
        operationalRisk: 'boundedCatalogLock',
        preparationValidity: 'preApprovalInert',
        semanticEffect: 'additive',
      },
      coexistence: STORAGE_COMPATIBILITY_MATRIX.createTable,
      coexistenceImpact: 'none',
    },
  );
  assert.deepEqual(
    classifyStorageTransitionElement('createIndex', 'samePlan'),
    {
      classification: {
        dataEffect: 'catalogOnly',
        operationalRisk: 'none',
        preparationValidity: 'preApprovalInert',
        semanticEffect: 'none',
      },
      coexistence: {
        ...STORAGE_COMPATIBILITY_MATRIX.createIndex,
        admission: 'additive',
        oldRead: 'notApplicable',
        oldWrite: 'notApplicable',
      },
      coexistenceImpact: 'none',
    },
  );
  assert.deepEqual(
    classifyStorageTransitionElement('createIndex', 'existing').classification,
    {
      dataEffect: 'dataScan',
      operationalRisk: 'onlineStrategyRequired',
      preparationValidity: 'deferredOnlineFamily',
      semanticEffect: 'none',
    },
  );
  const notValid = classifyStorageTransitionElement(
    'addNotValidConstraint',
    'existing',
  );
  assert.equal(notValid.classification.preparationValidity, 'inAttemptOnly');
  assert.equal(notValid.coexistence.oldWrite, 'mayReject');
  assert.equal(
    notValid.coexistence.admission,
    'blockingWhileAffectedWritersLive',
  );
  assert.deepEqual(
    classifyStorageTransitionElement('validateConstraint', 'existing')
      .classification,
    {
      dataEffect: 'dataScan',
      operationalRisk: 'longRunning',
      preparationValidity: 'deferredTightening',
      semanticEffect: 'tightening',
    },
  );
  assert.equal(
    classifyStorageTransitionElement('duplicateScan', 'existing').classification
      .preparationValidity,
    'deferredTightening',
  );
});

test('new-in-plan entities create required NOT NULL storage with coexistence impact none', () => {
  const empty = ordinaryModuleV1() as Record<string, unknown>;
  for (const family of [
    'assertions',
    'entities',
    'fields',
    'operations',
    'permissions',
    'queries',
    'relations',
    'stateMachines',
    'storageMappings',
    'surfaces',
  ]) {
    empty[family] = [];
  }
  const base = mustCompile(input(empty));
  const candidate = mustCompile(
    input(ordinaryModuleV1(), expectedActiveReleaseFrom(base)),
  );
  const transition = projectionPayload<StorageTransitionEnvelope>(
    candidate,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  const tableElements = transition.elements.filter(
    (element) => element.kind === 'createTable',
  );
  assert.equal(tableElements.length, 2);
  assert.ok(
    tableElements.every(
      (element) =>
        element.coexistenceImpact === 'none' &&
        element.classification.preparationValidity === 'preApprovalInert',
    ),
  );
  const storage = projectionPayload<StorageTargetPayloadV1>(
    candidate,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.ok(
    storage.entities
      .flatMap((entity) => entity.columns)
      .filter((column) => column.defaultSemantics === 'none')
      .every(
        (column) =>
          column.nullable === false && column.coexistenceImpact === 'none',
      ),
  );
});

test('the compatibility matrix is closed and old-writes-may-reject is never additive', () => {
  assert.deepEqual(Object.keys(STORAGE_COMPATIBILITY_MATRIX).sort(), [
    'addColumn',
    'addForeignKey',
    'addNotValidConstraint',
    'backfill',
    'createIndex',
    'createTable',
    'duplicateScan',
    'tightenNotNull',
    'validateConstraint',
  ]);
  for (const cell of Object.values(STORAGE_COMPATIBILITY_MATRIX)) {
    if (cell.oldWrite === 'mayReject') {
      assert.equal(cell.admission, 'blockingWhileAffectedWritersLive');
    }
  }
});

test('backfill completeness cannot become load-bearing', () => {
  const first = mustCompile(input(ordinaryModuleV1()));
  const admissible = ordinaryModuleV2() as {
    fields: Array<Record<string, unknown>>;
  };
  const admissibleField = admissible.fields.find(
    (field) => field.fieldId === FIXTURE_IDS.fieldIds.parentNotes,
  )!;
  admissibleField.defaultSemantics = 'coalesceAtRead';
  admissibleField.defaultValue = {
    kind: 'textValue',
    schemaVersion: 'v1',
    value: '',
  };
  admissibleField.storageEvolution = {
    kind: 'backfillEvolution',
    residualReadSemantics: 'coalesceAtRead',
    schemaVersion: 'v1',
  };
  const admissibleResult = mustCompile(
    input(admissible, expectedActiveReleaseFrom(first)),
  );
  const admissibleTransition = projectionPayload<StorageTransitionEnvelope>(
    admissibleResult,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  const backfill = admissibleTransition.elements.find(
    (element) => element.kind === 'backfill',
  );
  const column = admissibleTransition.elements.find(
    (element) => element.kind === 'addColumn',
  );
  assert.deepEqual(backfill?.declaredDependencyIds, [column?.elementId]);
  assert.equal(backfill?.classification.preparationValidity, 'inAttemptOnly');

  const candidate = ordinaryModuleV2() as {
    fields: Array<Record<string, unknown>>;
  };
  const added = candidate.fields.find(
    (field) => field.fieldId === FIXTURE_IDS.fieldIds.parentNotes,
  )!;
  added.storageEvolution = {
    kind: 'backfillEvolution',
    residualReadSemantics: 'requiresCompleteness',
    schemaVersion: 'v1',
  };
  const result = compileApplication(
    input(candidate, expectedActiveReleaseFrom(first)),
  );
  assert.equal(result.status, 'failed');
  assert.deepEqual(
    result.diagnostics.map(({ code, path, subjectId }) => ({
      code,
      path,
      subjectId,
    })),
    [
      {
        code: 'COMPILER_BACKFILL_INADMISSIBLE',
        path: '$.fields.storageEvolution.residualReadSemantics',
        subjectId: FIXTURE_IDS.fieldIds.parentNotes,
      },
    ],
  );
});

test('destructive renderer statements fail the compiler-owned allowlist', () => {
  const diagnostics = validateStorageRendererStatements([
    { kind: 'createTable' },
    { kind: 'onDeleteCascade' },
    { kind: 'deleteCapableTrigger' },
    { kind: 'deleteCapableRule' },
    { kind: 'truncateTable' },
    { kind: 'removePartition' },
    { kind: 'dropBusinessObject' },
  ]);
  assert.deepEqual(
    diagnostics.map(({ code, subjectId }) => ({ code, subjectId })),
    [
      ['onDeleteCascade', 1],
      ['deleteCapableTrigger', 2],
      ['deleteCapableRule', 3],
      ['truncateTable', 4],
      ['removePartition', 5],
      ['dropBusinessObject', 6],
    ].map(([subjectId]) => ({
      code: 'COMPILER_DESTRUCTIVE_STORAGE_DDL_UNSUPPORTED',
      subjectId,
    })),
  );
});

function input(
  definition: unknown,
  expectedActiveRelease: CompilerInput['expectedActiveRelease'] = null,
): CompilerInput {
  return {
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalizeApplicationPackage(definition)),
    ),
    profile: { ...MODULE_COMPILER_PROFILE },
  };
}

function mustCompile(
  compilerInput: CompilerInput,
  projectionSchedule: 'canonical' | 'interleaved' | 'reverse' = 'canonical',
): CompileSuccess {
  const result = compileApplication(compilerInput, { projectionSchedule });
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

function structuralTransition(transition: StorageTransitionEnvelope): unknown {
  return {
    backfillAdmissibilityVersion: transition.backfillAdmissibilityVersion,
    compatibilityMatrixVersion: transition.compatibilityMatrixVersion,
    elements: transition.elements.map(
      ({ elementId: _elementId, ...entry }) => entry,
    ),
    kind: transition.kind,
    rendererPolicyVersion: transition.rendererPolicyVersion,
    schemaVersion: transition.schemaVersion,
    tighteningDebt: transition.tighteningDebt,
    totalOrdering: transition.totalOrdering,
  };
}

function permute<T>(values: T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}
