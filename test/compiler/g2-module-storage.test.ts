import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CanonicalModelError,
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
  buildStorageTransitionEnvelope,
  classifyStorageTransitionElement,
  compileApplication,
  diffCompiledReleases,
  expectedActiveReleaseFrom,
  lowerStorageTargetV1,
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
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { inventoryModuleDefinition } from '../../packages/domain/src/inventory/definition.js';
import {
  FIXTURE_IDS,
  FIXTURE_LANGUAGE_VERSION,
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
  assert.equal(transition.elements.length, 6);
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

test('release diff rejects every non-envelope transition schema and payload kind', () => {
  const first = mustCompile(input(ordinaryModuleV1()));
  const second = mustCompile(
    input(ordinaryModuleV2(), expectedActiveReleaseFrom(first)),
  );

  const wrongSchema = structuredClone(second);
  const wrongSchemaReference =
    wrongSchema.bundle.releaseManifest.projections.find(
      (projection) =>
        projection.familyId === PROJECTION_FAMILY_IDS.storageTransition,
    )!;
  wrongSchemaReference.payloadSchemaVersion =
    'northstar.storage-transition-payload/v0-provisional';
  assert.throws(
    () => diffCompiledReleases(first, wrongSchema),
    /accepts only storage transition envelope v1/,
  );

  const wrongManifestSchema = structuredClone(second);
  const wrongManifestReference =
    wrongManifestSchema.bundle.releaseManifest.projections.find(
      (projection) =>
        projection.familyId === PROJECTION_FAMILY_IDS.storageTransition,
    )!;
  const wrongManifestArtifact = wrongManifestSchema.bundle.artifacts.find(
    (artifact) => artifact.contentHash === wrongManifestReference.artifactRoot,
  )!;
  const wrongManifest = JSON.parse(
    new TextDecoder().decode(wrongManifestArtifact.canonicalBytes),
  ) as Record<string, unknown>;
  wrongManifest.payloadSchemaVersion =
    'northstar.storage-transition-payload/v0-provisional';
  wrongManifestArtifact.canonicalBytes = new TextEncoder().encode(
    canonicalize(wrongManifest),
  );
  assert.throws(
    () => diffCompiledReleases(first, wrongManifestSchema),
    /accepts only storage transition envelope v1/,
  );

  const wrongKind = structuredClone(second);
  const transitionReference = wrongKind.bundle.releaseManifest.projections.find(
    (projection) =>
      projection.familyId === PROJECTION_FAMILY_IDS.storageTransition,
  )!;
  const manifestArtifact = wrongKind.bundle.artifacts.find(
    (artifact) => artifact.contentHash === transitionReference.artifactRoot,
  )!;
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  const chunk = wrongKind.bundle.artifacts.find(
    (artifact) => artifact.contentHash === manifest.chunks[0]?.contentHash,
  )!;
  const payload = JSON.parse(
    new TextDecoder().decode(chunk.canonicalBytes),
  ) as Record<string, unknown>;
  payload.kind = 'storageTransitionPayload';
  chunk.canonicalBytes = new TextEncoder().encode(canonicalize(payload));
  assert.throws(
    () => diffCompiledReleases(first, wrongKind),
    /accepts only storage transition envelope v1/,
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
      assert.equal(
        unique.predicate,
        `${entity.archive.archivedAtColumn} IS NULL`,
      );
    }
    for (const foldedColumn of entity.foldedColumns) {
      assert.equal(foldedColumn.collation, 'C');
      assert.equal(
        foldedColumn.foldFunction,
        'north_star_module.nsm_unicode_case_fold_v1',
      );
      assert.equal(foldedColumn.postgresqlType, 'text');
      assert.equal(foldedColumn.stored, true);
      assert.ok(
        entity.columns.some(
          (column) => column.physicalName === foldedColumn.sourceColumn,
        ),
      );
      assert.ok(
        storage.physicalMapping.records.some(
          (record) =>
            record.objectKind === 'column' &&
            record.physicalName === foldedColumn.physicalName &&
            record.canonicalId ===
              `${foldedColumn.canonicalFieldId}#unicode-case-fold-v1`,
        ),
      );
    }
    assert.equal(
      entity.indexes.some((index) => (index.indexKind as string) === 'search'),
      false,
    );
    for (const index of entity.indexes) {
      assert.equal(
        index.predicate,
        index.indexKind === 'caseInsensitiveUnique'
          ? `${entity.archive.archivedAtColumn} IS NULL`
          : null,
      );
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
    const source = storage.entities.find(
      (entity) => entity.entityId === relation.sourceEntityId,
    );
    const relationIndex = source?.indexes.find(
      (index) =>
        index.indexKind === 'relation' &&
        index.columnNames.includes(relation.relationColumn.physicalName),
    );
    assert.deepEqual(relationIndex?.columnNames, [
      'tenant_id',
      'environment_id',
      relation.relationColumn.physicalName,
    ]);
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

test('pinned family ownership derives legal-entity storage and both business-key enforcers', () => {
  const entityOwnedId = `${FIXTURE_IDS.namespace}:entity.inventory_transaction`;
  const entityOwnedTarget = lowerStorageTargetV1(
    normalizeApplicationPackage(
      definitionWithParentFamily('inventory_transaction'),
    ),
  );
  assert.equal(
    entityOwnedTarget.schemaVersion,
    'northstar.storage-target-payload/v2',
  );
  const entityOwned = entityOwnedTarget.entities.find(
    (entity) => entity.entityId === entityOwnedId,
  );
  assert.ok(entityOwned);
  assert.deepEqual(entityOwned.legalEntity, {
    column: 'legal_entity_id',
    familyClassification: 'entityOwned',
    immutableAfterCreate: true,
    nullable: false,
    postgresqlType: 'uuid',
    referencedFamilyId: 'legal_entity',
  });
  assert.deepEqual(entityOwned.businessKeyScopeColumns, [
    'tenant_id',
    'environment_id',
    'legal_entity_id',
  ]);
  assert.deepEqual(entityOwned.scopeKeyColumns, [
    'tenant_id',
    'environment_id',
  ]);
  assert.deepEqual(entityOwned.primaryKey.columns, [
    'tenant_id',
    'environment_id',
    'legal_entity_id',
    'record_id',
  ]);

  assert.equal(entityOwned.uniqueKeys.length, 1);
  assert.deepEqual(entityOwned.uniqueKeys[0]?.columns.slice(0, 3), [
    'tenant_id',
    'environment_id',
    'legal_entity_id',
  ]);
  const caseInsensitive = entityOwned.indexes.filter(
    (index) => index.indexKind === 'caseInsensitiveUnique',
  );
  assert.equal(caseInsensitive.length, 1);
  assert.deepEqual(
    caseInsensitive[0]?.columnNames,
    entityOwned.uniqueKeys[0]?.columns,
  );
  assert.equal(
    caseInsensitive[0]?.predicate,
    `${entityOwned.archive.archivedAtColumn} IS NULL`,
  );

  const tenantSharedId = `${FIXTURE_IDS.namespace}:entity.item`;
  const tenantShared = lowerStorageTargetV1(
    normalizeApplicationPackage(definitionWithParentFamily('item')),
  ).entities.find((entity) => entity.entityId === tenantSharedId);
  assert.ok(tenantShared);
  assert.equal(Object.hasOwn(tenantShared, 'legalEntity'), false);
  assert.equal(Object.hasOwn(tenantShared, 'businessKeyScopeColumns'), false);
  assert.equal(
    tenantShared.uniqueKeys.every(
      (unique) => !unique.columns.includes('legal_entity_id'),
    ),
    true,
  );
  assert.equal(
    tenantShared.indexes
      .filter((index) => index.indexKind === 'caseInsensitiveUnique')
      .every((index) => !index.columnNames.includes('legal_entity_id')),
    true,
  );
});

test('entity ownership derives one create-only system input while tenant-shared families cannot author it', () => {
  const entityOwnedId = 'northstar.app:entity.inventory_transaction';
  const entityOwnedDefinition = composedApplicationDefinition();
  const entityOwned = mustCompile(input(entityOwnedDefinition));
  const entityOwnedOperations = projectionPayload<{
    operations: Array<{
      effect: { entity: { targetId: string }; kind: string };
      inputContract?: {
        closedArgumentKeys: string[];
        schemaVersion: string;
        systemInput?: {
          argumentKey: string;
          classification: string;
          immutableAfterCreate: boolean;
          physicalColumn: string;
          required: boolean;
          valueKind: string;
        };
      };
    }>;
  }>(entityOwned, PROJECTION_FAMILY_IDS.operationCatalog).operations;
  const entityOwnedCreate = entityOwnedOperations.find(
    (operation) =>
      operation.effect.entity.targetId === entityOwnedId &&
      operation.effect.kind === 'createRecordEffect',
  );
  assert.deepEqual(entityOwnedCreate?.inputContract?.systemInput, {
    argumentKey: 'legalEntityId',
    classification: 'INTERNAL',
    immutableAfterCreate: true,
    physicalColumn: 'legal_entity_id',
    required: true,
    valueKind: 'uuid',
  });
  assert.equal(
    entityOwnedCreate?.inputContract?.schemaVersion,
    'northstar.module-input-contract/v2',
  );
  assert.deepEqual(entityOwnedCreate?.inputContract?.closedArgumentKeys, [
    'legalEntityId',
    'recordId',
    'relations',
    'values',
  ]);
  for (const operation of entityOwnedOperations.filter(
    (candidate) =>
      candidate.effect.entity.targetId === entityOwnedId &&
      candidate.effect.kind !== 'createRecordEffect',
  )) {
    assert.equal(
      Object.hasOwn(operation.inputContract ?? {}, 'systemInput'),
      false,
      `${operation.effect.kind} gained the create-only system input`,
    );
    assert.equal(
      operation.inputContract?.closedArgumentKeys.includes('legalEntityId'),
      false,
    );
  }

  const tenantSharedId = 'northstar.app:entity.item';
  const tenantShared = entityOwned;
  const tenantSharedCreate = projectionPayload<{
    operations: Array<{
      effect: { entity: { targetId: string }; kind: string };
      inputContract?: {
        closedArgumentKeys: string[];
        schemaVersion: string;
        systemInput?: unknown;
      };
    }>;
  }>(tenantShared, PROJECTION_FAMILY_IDS.operationCatalog).operations.find(
    (operation) =>
      operation.effect.entity.targetId === tenantSharedId &&
      operation.effect.kind === 'createRecordEffect',
  );
  assert.equal(
    Object.hasOwn(tenantSharedCreate?.inputContract ?? {}, 'systemInput'),
    false,
  );
  assert.equal(
    tenantSharedCreate?.inputContract?.closedArgumentKeys.includes(
      'legalEntityId',
    ),
    false,
  );
  assert.equal(
    tenantSharedCreate?.inputContract?.schemaVersion,
    'northstar.module-input-contract/v1',
  );

  const authoredAttempt = structuredClone(entityOwnedDefinition) as {
    operations: Array<Record<string, unknown>>;
  };
  const authoredCreate = authoredAttempt.operations.find(
    (operation) =>
      (operation.effect as { kind?: string } | undefined)?.kind ===
      'createRecordEffect',
  );
  assert.ok(authoredCreate);
  authoredCreate.systemInput = {
    argumentKey: 'author-chosen-entity',
    valueKind: 'uuid',
  };
  assert.throws(
    () => normalizeApplicationPackage(authoredAttempt),
    (error: unknown) =>
      error instanceof CanonicalModelError &&
      error.diagnostics.some(
        (diagnostic) => diagnostic.code === 'CANON_SCHEMA_INVALID',
      ),
    'the authored operation shape admitted a second system-input authority',
  );
});

test('storage-target payload versions expose the pinned v1/v2/v3 split in release artifacts', () => {
  const entityOwnedDefinition = inventoryModuleDefinition();
  const entityOwned = mustCompile(input(entityOwnedDefinition));
  const entityOwnedStorage = projectionPayload<StorageTargetPayloadV1>(
    entityOwned,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const entityOwnedReference = projectionReference(
    entityOwned,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const entityOwnedManifest = projectionManifest(
    entityOwned,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.equal(
    entityOwnedStorage.schemaVersion,
    'northstar.storage-target-payload/v3',
  );
  assert.equal(
    entityOwnedReference.payloadSchemaVersion,
    entityOwnedStorage.schemaVersion,
  );
  assert.equal(
    entityOwnedManifest.payloadSchemaVersion,
    entityOwnedStorage.schemaVersion,
  );
  const entityOwnedNext = mustCompile(
    input(entityOwnedDefinition, expectedActiveReleaseFrom(entityOwned)),
  );
  const entityOwnedTransition = projectionPayload<StorageTransitionEnvelope>(
    entityOwnedNext,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  assert.equal(
    entityOwnedTransition.schemaVersion,
    STORAGE_TRANSITION_ENVELOPE_VERSION,
  );
  assert.deepEqual(entityOwnedTransition.elements, []);

  const tenantShared = mustCompile(
    input(definitionWithFamilies('party', 'party_role')),
  );
  const tenantSharedStorage = projectionPayload<StorageTargetPayloadV1>(
    tenantShared,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const tenantSharedReference = projectionReference(
    tenantShared,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const tenantSharedManifest = projectionManifest(
    tenantShared,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.equal(
    tenantSharedStorage.schemaVersion,
    'northstar.storage-target-payload/v1',
  );
  assert.equal(
    tenantSharedReference.payloadSchemaVersion,
    tenantSharedStorage.schemaVersion,
  );
  assert.equal(
    tenantSharedManifest.payloadSchemaVersion,
    tenantSharedStorage.schemaVersion,
  );
});

test('entity-owned table creation depends on a new legal-entity master regardless of target order', () => {
  const packageRevision = normalizeApplicationPackage(
    inventoryModuleDefinition(),
  );
  const candidate = lowerStorageTargetV1(packageRevision);
  candidate.entities = candidate.entities.toSorted(
    (left, right) =>
      Number(left.legalEntityMaster !== undefined) -
      Number(right.legalEntityMaster !== undefined),
  );
  const previous = structuredClone(candidate);
  previous.entities = [];
  previous.relations = [];
  previous.physicalMapping.records = [];
  const transition = buildStorageTransitionEnvelope(
    packageRevision,
    previous,
    candidate,
    transitionBinding(),
  );
  assert.equal('diagnostic' in transition, false);
  if ('diagnostic' in transition) return;
  const master = candidate.entities.find(
    (entity) => entity.legalEntityMaster !== undefined,
  );
  assert.ok(master);
  const masterTable = transition.elements.find(
    (element) =>
      element.kind === 'createTable' && element.subjectId === master.entityId,
  );
  assert.ok(masterTable);
  for (const entity of candidate.entities.filter(
    (candidateEntity) => candidateEntity.legalEntity !== undefined,
  )) {
    const table = transition.elements.find(
      (element) =>
        element.kind === 'createTable' && element.subjectId === entity.entityId,
    );
    assert.ok(table);
    assert.ok(
      table.declaredDependencyIds.includes(masterTable.elementId),
      `${entity.entityId} must depend on ${master.entityId}`,
    );
  }
});

test('ratified storage targets evolve additively with relation-index elements', () => {
  const packageRevision = normalizeApplicationPackage(ordinaryModuleV1());
  const candidate = lowerStorageTargetV1(packageRevision);
  const previous = structuredClone(candidate);
  for (const entity of previous.entities) {
    entity.indexes = entity.indexes.filter(
      (index) => index.indexKind !== 'relation',
    );
  }
  const transition = buildStorageTransitionEnvelope(
    packageRevision,
    previous,
    candidate,
    transitionBinding(),
  );
  assert.equal('diagnostic' in transition, false);
  if ('diagnostic' in transition) return;
  const expectedNames = candidate.entities
    .flatMap((entity) => entity.indexes)
    .filter((index) => index.indexKind === 'relation')
    .map((index) => index.physicalName)
    .sort();
  const additions = transition.elements.filter(
    (element) => element.kind === 'createIndex',
  );
  assert.deepEqual(
    additions.map((element) => element.physicalObjectName).sort(),
    expectedNames,
  );
  assert.ok(
    additions.every(
      (element) =>
        element.classification.preparationValidity === 'deferredOnlineFamily' &&
        element.classification.operationalRisk === 'onlineStrategyRequired',
    ),
  );
});

test('folded access covers advisory resolve keys and defers populated-table rewrites', () => {
  const authored = ordinaryModuleV1() as {
    fields: Array<Record<string, unknown>>;
  };
  const advisoryField = authored.fields.find(
    (field) => field.fieldId === FIXTURE_IDS.fieldIds.parentName,
  );
  assert.ok(advisoryField);
  advisoryField.searchable = false;
  const packageRevision = normalizeApplicationPackage(authored);
  const candidate = lowerStorageTargetV1(packageRevision);
  const entity = candidate.entities.find(
    (entry) => entry.entityId === FIXTURE_IDS.entityIds.parent,
  );
  assert.ok(entity);
  const foldedColumn = entity.foldedColumns.find(
    (column) => column.canonicalFieldId === FIXTURE_IDS.fieldIds.parentName,
  );
  assert.ok(foldedColumn);
  const foldedIndex = entity.indexes.find(
    (index) =>
      index.indexKind === 'foldedAccess' &&
      index.columnNames.includes(foldedColumn.physicalName),
  );
  assert.ok(foldedIndex);

  const previous = structuredClone(candidate);
  for (const previousEntity of previous.entities) {
    previousEntity.foldedColumns = [];
    previousEntity.indexes = previousEntity.indexes.filter(
      (index) => index.indexKind !== 'foldedAccess',
    );
  }
  const transition = buildStorageTransitionEnvelope(
    packageRevision,
    previous,
    candidate,
    transitionBinding(),
  );
  assert.equal('diagnostic' in transition, false);
  if ('diagnostic' in transition) return;
  const addFoldedColumn = transition.elements.find(
    (element) =>
      element.kind === 'addColumn' &&
      element.physicalObjectName === foldedColumn.physicalName,
  );
  assert.ok(addFoldedColumn);
  assert.deepEqual(addFoldedColumn.classification, {
    dataEffect: 'rowMutation',
    operationalRisk: 'onlineStrategyRequired',
    preparationValidity: 'deferredOnlineFamily',
    semanticEffect: 'additive',
  });
  assert.equal(addFoldedColumn.coexistence.admission, 'deferred');
  assert.equal(addFoldedColumn.coexistenceImpact, 'requiresReadFallback');
  const addFoldedIndex = transition.elements.find(
    (element) =>
      element.kind === 'createIndex' &&
      element.physicalObjectName === foldedIndex.physicalName,
  );
  assert.ok(addFoldedIndex);
  assert.deepEqual(addFoldedIndex.declaredDependencyIds, [
    addFoldedColumn.elementId,
  ]);
  assert.equal(
    addFoldedIndex.classification.preparationValidity,
    'deferredOnlineFamily',
  );
});

test('search-only fields receive stored folds and prefix indexes', () => {
  const authored = ordinaryModuleV2() as {
    fields: Array<Record<string, unknown>>;
  };
  const searchOnlyField = authored.fields.find(
    (field) => field.fieldId === FIXTURE_IDS.fieldIds.parentNotes,
  );
  assert.ok(searchOnlyField);
  searchOnlyField.searchable = true;
  const storage = lowerStorageTargetV1(normalizeApplicationPackage(authored));
  const entity = storage.entities.find(
    (entry) => entry.entityId === FIXTURE_IDS.entityIds.parent,
  );
  assert.ok(entity);
  const foldedColumn = entity.foldedColumns.find(
    (column) => column.canonicalFieldId === FIXTURE_IDS.fieldIds.parentNotes,
  );
  assert.ok(foldedColumn);
  assert.equal(
    entity.indexes.some(
      (index) =>
        index.indexKind === 'foldedAccess' &&
        index.columnNames.includes(foldedColumn.physicalName),
    ),
    true,
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

test('required fields added to existing tables stay nullable until deferred tightening', () => {
  const first = mustCompile(input(ordinaryModuleV1()));
  const candidate = ordinaryModuleV2() as {
    fields: Array<Record<string, unknown>>;
  };
  const added = candidate.fields.find(
    (field) => field.fieldId === FIXTURE_IDS.fieldIds.parentNotes,
  )!;
  added.presence = 'required';
  added.defaultSemantics = 'coalesceAtRead';
  added.defaultValue = {
    kind: 'textValue',
    schemaVersion: FIXTURE_LANGUAGE_VERSION,
    value: '',
  };

  const compiled = mustCompile(
    input(candidate, expectedActiveReleaseFrom(first)),
  );
  const storage = projectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const column = storage.entities
    .flatMap((entity) => entity.columns)
    .find(
      (candidateColumn) =>
        candidateColumn.canonicalFieldId === FIXTURE_IDS.fieldIds.parentNotes,
    );
  assert.deepEqual(
    {
      coexistenceImpact: column?.coexistenceImpact,
      defaultSemantics: column?.defaultSemantics,
      nullable: column?.nullable,
      requiredAfterTightening: column?.requiredAfterTightening,
    },
    {
      coexistenceImpact: 'requiresReadFallback',
      defaultSemantics: 'coalesceAtRead',
      nullable: true,
      requiredAfterTightening: true,
    },
  );

  const transition = projectionPayload<StorageTransitionEnvelope>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  const addColumn = transition.elements.find(
    (entry) =>
      entry.kind === 'addColumn' &&
      entry.fieldId === FIXTURE_IDS.fieldIds.parentNotes,
  );
  const tighten = transition.elements.find(
    (entry) =>
      entry.kind === 'tightenNotNull' &&
      entry.fieldId === FIXTURE_IDS.fieldIds.parentNotes,
  );
  assert.equal(addColumn?.coexistenceImpact, 'requiresReadFallback');
  assert.equal(
    addColumn?.classification.preparationValidity,
    'preApprovalInert',
  );
  assert.deepEqual(tighten?.declaredDependencyIds, [addColumn?.elementId]);
  assert.equal(tighten?.coexistence.oldWrite, 'mayReject');
  assert.equal(
    tighten?.coexistence.admission,
    'blockingWhileAffectedWritersLive',
  );
  assert.equal(
    tighten?.classification.preparationValidity,
    'deferredTightening',
  );
  assert.equal(
    transition.elements.some(
      (entry) =>
        entry.coexistenceImpact === 'oldWritesMayReject' &&
        entry.coexistence.admission === 'additive',
    ),
    false,
  );
  const debt = transition.tighteningDebt.find(
    (entry) => entry.elementId === tighten?.elementId,
  );
  assert.deepEqual(debt?.blockingRootIds, [first.releaseRoot]);
  assert.equal(
    debt?.liveRootResolution,
    'materializerResolvesActiveAndNonTerminalPreparationUnion',
  );
});

test('relation mapping fingerprints include nullability and existing physical mutations fail closed', () => {
  const optional = ordinaryModuleV1() as {
    relations: Array<Record<string, unknown>>;
  };
  optional.relations.push(secondaryParentRelation(false));
  const required = ordinaryModuleV1() as {
    relations: Array<Record<string, unknown>>;
  };
  required.relations.push(secondaryParentRelation(true));
  const relationMappingId = `${FIXTURE_IDS.namespace}:relation.master_role_secondary_parent#target-record-id`;
  const optionalMapping = lowerStorageTargetV1(
    normalizeApplicationPackage(optional),
  ).physicalMapping.records.find(
    (record) => record.canonicalId === relationMappingId,
  );
  const requiredMapping = lowerStorageTargetV1(
    normalizeApplicationPackage(required),
  ).physicalMapping.records.find(
    (record) => record.canonicalId === relationMappingId,
  );
  assert.ok(optionalMapping);
  assert.ok(requiredMapping);
  assert.notEqual(
    optionalMapping.shapeFingerprint,
    requiredMapping.shapeFingerprint,
  );

  const packageRevision = normalizeApplicationPackage(ordinaryModuleV1());
  const previous = lowerStorageTargetV1(packageRevision);
  const relationId = previous.relations[0]!.relationId;
  const mutations: Array<(target: StorageTargetPayloadV1) => void> = [
    (target) => {
      target.relations.splice(0, 1);
    },
    (target) => {
      target.relations[0]!.relationColumn.nullable =
        !target.relations[0]!.relationColumn.nullable;
    },
    (target) => {
      target.relations[0]!.ownership = 'reference';
    },
    (target) => {
      target.relations[0]!.targetEntityId = FIXTURE_IDS.entityIds.child;
    },
    (target) => {
      (
        target.relations[0]!.foreignKey as {
          onDelete: string;
        }
      ).onDelete = 'cascade';
    },
    (target) => {
      target.relations[0]!.relationColumn.physicalName = `${target.relations[0]!.relationColumn.physicalName}_changed`;
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(previous);
    mutate(candidate);
    const result = buildStorageTransitionEnvelope(
      packageRevision,
      previous,
      candidate,
      transitionBinding(),
    );
    assert.ok('diagnostic' in result);
    if (!('diagnostic' in result)) continue;
    assert.deepEqual(
      {
        code: result.diagnostic.code,
        path: result.diagnostic.path,
        subjectId: result.diagnostic.subjectId,
      },
      {
        code: 'COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED',
        path: '$.relations',
        subjectId: relationId,
      },
    );
  }
});

test('the PR-2 metadata bridge adds enum checks without retyping persisted columns', () => {
  const packageRevision = normalizeApplicationPackage(ordinaryModuleV1());
  const current = lowerStorageTargetV1(packageRevision);
  const previous = structuredClone(current) as StorageTargetPayloadV1;
  for (const entity of previous.entities) {
    delete (entity as Partial<typeof entity>).checkConstraints;
    for (const column of entity.columns) {
      delete (column as Partial<typeof column>).fieldContract;
    }
  }
  for (const relation of previous.relations) {
    delete (relation as Partial<typeof relation>).archiveBehavior;
  }

  const candidate = lowerStorageTargetV1(packageRevision, previous);
  const result = buildStorageTransitionEnvelope(
    packageRevision,
    previous,
    candidate,
    transitionBinding(),
  );
  assert.equal('diagnostic' in result, false);
  if ('diagnostic' in result) return;
  assert.deepEqual(
    result.elements.map((element) => ({
      fieldId: element.fieldId,
      kind: element.kind,
      subjectId: element.subjectId,
    })),
    [
      {
        fieldId: FIXTURE_IDS.fieldIds.childRole,
        kind: 'addNotValidConstraint',
        subjectId: FIXTURE_IDS.entityIds.child,
      },
    ],
  );
});

test('the compatibility matrix is closed and old-writes-may-reject is never additive', () => {
  assert.deepEqual(Object.keys(STORAGE_COMPATIBILITY_MATRIX).sort(), [
    'addAbiFunctionCheck',
    'addColumn',
    'addForeignKey',
    'addNotValidConstraint',
    'backfill',
    'createCompanionTable',
    'createIndex',
    'createPartition',
    'createRejectMutationTrigger',
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
    schemaVersion: FIXTURE_LANGUAGE_VERSION,
    value: '',
  };
  admissibleField.storageEvolution = {
    kind: 'backfillEvolution',
    residualReadSemantics: 'coalesceAtRead',
    schemaVersion: FIXTURE_LANGUAGE_VERSION,
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
    (element) =>
      element.kind === 'addColumn' &&
      element.fieldId === FIXTURE_IDS.fieldIds.parentNotes,
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
    schemaVersion: FIXTURE_LANGUAGE_VERSION,
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
  const normalized = normalizeApplicationPackage(definition);
  return {
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    // Version-from-artifact: the profile follows the definition's own declared
    // version, never a pinned constant. Supported profiles differ only in these
    // two fields, so this reconstructs exactly the supported profile for it.
    profile: {
      ...MODULE_COMPILER_PROFILE,
      languageVersion: normalized.languageVersion,
      normalizationProfileVersion: normalized.normalizationProfileVersion,
    },
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
  const manifest = projectionManifest(compiled, familyId);
  const chunk = compiled.bundle.artifacts.find(
    (entry) => entry.contentHash === manifest.chunks[0]?.contentHash,
  )!;
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
}

function projectionReference(
  compiled: CompileSuccess,
  familyId: ProjectionFamilyId,
) {
  return compiled.bundle.releaseManifest.projections.find(
    (entry) => entry.familyId === familyId,
  )!;
}

function projectionManifest(
  compiled: CompileSuccess,
  familyId: ProjectionFamilyId,
): ProjectionManifestEnvelope {
  const reference = projectionReference(compiled, familyId);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (entry) => entry.contentHash === reference.artifactRoot,
  )!;
  return JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
}

function structuralTransition(transition: StorageTransitionEnvelope): unknown {
  return {
    backfillAdmissibilityVersion: transition.backfillAdmissibilityVersion,
    compatibilityMatrixVersion: transition.compatibilityMatrixVersion,
    elements: transition.elements.map(({ elementId, ...entry }) => {
      void elementId;
      return entry;
    }),
    kind: transition.kind,
    rendererPolicyVersion: transition.rendererPolicyVersion,
    schemaVersion: transition.schemaVersion,
    tighteningDebt: transition.tighteningDebt,
    totalOrdering: transition.totalOrdering,
  };
}

function secondaryParentRelation(required: boolean): Record<string, unknown> {
  return {
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
    required,
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
  };
}

function definitionWithParentFamily(familyId: string): unknown {
  return replaceExactString(
    ordinaryModuleV2(),
    FIXTURE_IDS.entityIds.parent,
    `${FIXTURE_IDS.namespace}:entity.${familyId}`,
  );
}

function definitionWithFamilies(
  parentFamilyId: string,
  childFamilyId: string,
): unknown {
  return replaceExactString(
    replaceExactString(
      ordinaryModuleV2(),
      FIXTURE_IDS.entityIds.parent,
      `${FIXTURE_IDS.namespace}:entity.${parentFamilyId}`,
    ),
    FIXTURE_IDS.entityIds.child,
    `${FIXTURE_IDS.namespace}:entity.${childFamilyId}`,
  );
}

function replaceExactString(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (Array.isArray(value)) {
    return value.map((entry) => replaceExactString(entry, from, to));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceExactString(entry, from, to),
      ]),
    );
  }
  return value;
}

function transitionBinding() {
  return {
    fromNormalizedDefinitionDigest: '0'.repeat(64),
    fromReleaseRoot: '1'.repeat(64),
    fromStorageTargetArtifactRoot: '2'.repeat(64),
    fromStorageTargetSemanticDigest: '3'.repeat(64),
    toNormalizedDefinitionDigest: '4'.repeat(64),
    toStorageTargetArtifactRoot: '5'.repeat(64),
    toStorageTargetSemanticDigest: '6'.repeat(64),
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
