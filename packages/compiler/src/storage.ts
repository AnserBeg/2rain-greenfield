import { createHash } from 'node:crypto';

import type { NormalizedApplicationPackage } from '@north-star/canonical-model';

import { compilerDiagnostic } from './diagnostics.js';
import { hashCanonical } from './hash.js';
import {
  BACKFILL_ADMISSIBILITY_VERSION,
  HASH_DOMAINS,
  MODULE_FIELD_CONTRACT_VERSION,
  PHYSICAL_MAPPING_VERSION,
  POSTGRES_PROVIDER_ABI_VERSION,
  STORAGE_COMPATIBILITY_MATRIX_VERSION,
  STORAGE_ELEMENT_CONTRACT_VERSION,
  STORAGE_RENDERER_POLICY_VERSION,
  STORAGE_TARGET_PAYLOAD_VERSION,
  STORAGE_TRANSITION_ENVELOPE_VERSION,
  TIGHTENING_DEBT_VERSION,
  type CompilerDiagnostic,
  type PhysicalMappingRecord,
  type StorageCompatibilityCell,
  type StorageElementClassification,
  type StorageRendererStatement,
  type StorageTransitionElement,
  type StorageTransitionElementKind,
  type StorageTransitionEnvelope,
  type TighteningDebt,
} from './protocol.js';

type Field = NormalizedApplicationPackage['fields'][number];
type FieldType = Field['fieldType'];

export const POSTGRESQL_FIELD_TYPE_TABLE = Object.freeze([
  {
    canonicalType: 'booleanFieldType',
    postgresqlType: 'boolean',
  },
  {
    canonicalType: 'dateFieldType',
    postgresqlType: 'date',
  },
  {
    canonicalType: 'dateTimeFieldType.utcInstant.second',
    postgresqlType: 'timestamp(0) with time zone',
  },
  {
    canonicalType: 'dateTimeFieldType.utcInstant.millisecond',
    postgresqlType: 'timestamp(3) with time zone',
  },
  {
    canonicalType: 'dateTimeFieldType.offsetDateTime.second',
    postgresqlType: 'text',
  },
  {
    canonicalType: 'dateTimeFieldType.offsetDateTime.millisecond',
    postgresqlType: 'text',
  },
  {
    canonicalType: 'enumFieldType',
    postgresqlType: 'text',
  },
  {
    canonicalType: 'exactDecimalFieldType',
    postgresqlType: 'numeric(precision,scale)',
  },
  {
    canonicalType: 'integerFieldType',
    postgresqlType: 'numeric',
  },
  {
    canonicalType: 'moneyFieldType',
    postgresqlType: 'numeric(precision,scale)',
  },
  {
    canonicalType: 'quantityFieldType',
    postgresqlType: 'numeric(precision,scale)',
  },
  {
    canonicalType: 'textFieldType',
    postgresqlType: 'varchar(maximumLength)',
  },
  {
    canonicalType: 'timeFieldType.second',
    postgresqlType: 'time(0) without time zone',
  },
  {
    canonicalType: 'timeFieldType.millisecond',
    postgresqlType: 'time(3) without time zone',
  },
] as const);

export const MODULE_RLS_GRANT_TEMPLATE = Object.freeze({
  forcedRowLevelSecurity: true,
  grants: ['SELECT', 'INSERT', 'UPDATE'] as const,
  keyRule:
    'tenant_id and environment_id prefix every primary key, unique key, and foreign key',
  policyCommands: ['SELECT', 'INSERT', 'UPDATE'] as const,
  predicate: {
    environment:
      'environment_id = north_star_internal.trusted_environment_id()',
    kind: 'trustedTenantEnvironmentConjunction' as const,
    tenant: 'tenant_id = north_star_internal.trusted_tenant_id()',
  },
  scopeKeyColumns: ['tenant_id', 'environment_id'] as const,
  templateVersion: 'northstar.postgresql-module-rls-grants/v1' as const,
});

export const STORAGE_COMPATIBILITY_MATRIX: Readonly<
  Record<StorageTransitionElementKind, StorageCompatibilityCell>
> = Object.freeze({
  addColumn: Object.freeze({
    admission: 'additive',
    newRead: 'requiresReadFallback',
    newWrite: 'compatible',
    oldRead: 'compatible',
    oldWrite: 'compatible',
  }),
  addForeignKey: Object.freeze({
    admission: 'blockingWhileAffectedWritersLive',
    newRead: 'compatible',
    newWrite: 'compatible',
    oldRead: 'compatible',
    oldWrite: 'mayReject',
  }),
  addNotValidConstraint: Object.freeze({
    admission: 'blockingWhileAffectedWritersLive',
    newRead: 'compatible',
    newWrite: 'compatible',
    oldRead: 'compatible',
    oldWrite: 'mayReject',
  }),
  backfill: Object.freeze({
    admission: 'additive',
    newRead: 'requiresReadFallback',
    newWrite: 'compatible',
    oldRead: 'compatible',
    oldWrite: 'compatible',
  }),
  createIndex: Object.freeze({
    admission: 'deferred',
    newRead: 'compatible',
    newWrite: 'compatible',
    oldRead: 'compatible',
    oldWrite: 'compatible',
  }),
  createTable: Object.freeze({
    admission: 'additive',
    newRead: 'compatible',
    newWrite: 'compatible',
    oldRead: 'notApplicable',
    oldWrite: 'notApplicable',
  }),
  duplicateScan: Object.freeze({
    admission: 'deferred',
    newRead: 'compatible',
    newWrite: 'compatible',
    oldRead: 'compatible',
    oldWrite: 'compatible',
  }),
  tightenNotNull: Object.freeze({
    admission: 'blockingWhileAffectedWritersLive',
    newRead: 'compatible',
    newWrite: 'compatible',
    oldRead: 'compatible',
    oldWrite: 'mayReject',
  }),
  validateConstraint: Object.freeze({
    admission: 'deferred',
    newRead: 'compatible',
    newWrite: 'compatible',
    oldRead: 'compatible',
    oldWrite: 'compatible',
  }),
});

export interface StorageTargetPayloadV1 {
  backfillInvariant: {
    completenessLoadBearing: false;
    residualRowsRequire: 'declaredDefaultOrCoalesceAtRead';
    version: typeof BACKFILL_ADMISSIBILITY_VERSION;
  };
  entities: StorageEntityTarget[];
  fieldTypeTable: typeof POSTGRESQL_FIELD_TYPE_TABLE;
  kind: 'storageTargetPayload';
  physicalMapping: {
    digest: 'sha256';
    encoding: 'base32-lowercase-no-padding';
    maximumIdentifierBytes: 63;
    records: PhysicalMappingRecord[];
    version: typeof PHYSICAL_MAPPING_VERSION;
  };
  promotionReserve: {
    capabilityId: 'northstar.storage:capability.promote-storage-class';
    invariant: 'canonical identity and gateway contracts survive promotion; the physical locator may change; the eventual dedicated name is deterministic from canonical identity';
    status: 'unsupported';
  };
  providerAbi: {
    managedSchema: 'north_star_module';
    materializerRole: 'north_star_module_materializer';
    runtimeRole: 'north_star_module_runtime';
    scopeKeyTypes: {
      environment_id: 'uuid';
      tenant_id: 'uuid';
    };
    trustedContextFunctions: readonly [
      'north_star_internal.trusted_tenant_id()',
      'north_star_internal.trusted_environment_id()',
    ];
    version: typeof POSTGRES_PROVIDER_ABI_VERSION;
  };
  relations: StorageRelationTarget[];
  rendererPolicyVersion: typeof STORAGE_RENDERER_POLICY_VERSION;
  rlsGrantTemplate: typeof MODULE_RLS_GRANT_TEMPLATE;
  schemaVersion: typeof STORAGE_TARGET_PAYLOAD_VERSION;
}

export interface StorageEntityTarget {
  archive: {
    archivedAtColumn: string;
    defaultVisibility: 'excludeArchived';
    representation: 'nullableTimestamp';
  };
  columns: StorageColumnTarget[];
  checkConstraints: StorageCheckConstraintTarget[];
  consumerWriterRoots: {
    readerQueryIds: string[];
    writerOperationIds: string[];
  };
  derivedStateFields: Array<{
    fieldId: string;
    physicalName: string;
    postgresqlType: 'text';
    stateMachineId: string;
  }>;
  entityId: string;
  indexes: StorageIndexTarget[];
  lifecycle: string;
  optimisticRevision: {
    column: string;
    initialValue: '1';
    postgresqlType: 'bigint';
  };
  physicalTableName: string;
  primaryKey: {
    columns: string[];
    physicalName: string;
  };
  recordIdentity: {
    column: string;
    postgresqlType: 'uuid';
  };
  scopeKeyColumns: readonly ['tenant_id', 'environment_id'];
  storageClass: 'dedicatedTable';
  storageMappingId: string;
  uniqueKeys: StorageUniqueKeyTarget[];
}

export interface StorageColumnTarget {
  canonicalFieldId: string;
  coexistenceImpact: 'none' | 'requiresReadFallback';
  collation: 'binary' | 'unicodeCaseInsensitive';
  defaultSemantics: 'none' | 'nullable' | 'declaredDefault' | 'coalesceAtRead';
  defaultValue: unknown | null;
  fieldContract: ModuleFieldContract;
  nullable: boolean;
  physicalName: string;
  postgresqlType: string;
  requiredAfterTightening: boolean;
  searchMapping: 'none' | 'normalizedTextIndex';
  shapeFingerprint: string;
}

export interface ModuleFieldContract {
  bounds: {
    maximumLength: number | null;
    precision: number | null;
    scale: number | null;
  };
  enumOptionIds: string[];
  fieldId: string;
  fieldKind:
    | 'booleanFieldType'
    | 'dateFieldType'
    | 'dateTimeFieldType'
    | 'enumFieldType'
    | 'exactDecimalFieldType'
    | 'integerFieldType'
    | 'moneyFieldType'
    | 'quantityFieldType'
    | 'textFieldType'
    | 'timeFieldType';
  normalization: 'none' | 'unicodeCaseFoldNoCompatibilityNormalization';
  required: boolean;
  schemaVersion: typeof MODULE_FIELD_CONTRACT_VERSION;
  temporal: {
    precision: 'millisecond' | 'second' | null;
    timezoneSemantics:
      'calendarDate' | 'localWallTime' | 'offsetDateTime' | 'utcInstant' | null;
  };
  writable: true;
}

export interface StorageCheckConstraintTarget {
  canonicalFieldId: string;
  checkKind: 'enumDomain';
  enumOptionIds: string[];
  physicalName: string;
  validated: false;
}

export interface StorageIndexTarget {
  columnNames: string[];
  indexKind: 'caseInsensitiveUnique' | 'relation' | 'search';
  physicalName: string;
}

export interface StorageUniqueKeyTarget {
  collation: 'unicodeCaseInsensitive';
  columns: string[];
  normalization: 'unicodeCaseFold';
  physicalName: string;
}

export interface StorageRelationTarget {
  archiveBehavior: 'restrict' | 'retainReference';
  foreignKey: {
    onDelete: 'restrict';
    onUpdate: 'restrict';
    physicalName: string;
    sourceColumns: string[];
    targetColumns: string[];
  };
  ownership: 'reference' | 'parentScopedChild';
  relationColumn: {
    nullable: boolean;
    physicalName: string;
    postgresqlType: 'uuid';
  };
  relationId: string;
  sourceEntityId: string;
  targetEntityId: string;
}

export interface TransitionBinding {
  fromNormalizedDefinitionDigest: string;
  fromReleaseRoot: string;
  fromStorageTargetArtifactRoot: string;
  fromStorageTargetSemanticDigest: string;
  toNormalizedDefinitionDigest: string;
  toStorageTargetArtifactRoot: string;
  toStorageTargetSemanticDigest: string;
}

export function buildStorageTransitionEnvelopeFromLegacyTargets(
  additions: Array<{ entityId: string; fieldId: string }>,
  binding: TransitionBinding,
): StorageTransitionEnvelope {
  const elements = additions.map(({ entityId, fieldId }) =>
    element(
      'addColumn',
      entityId,
      fieldId,
      physicalNameFor('column', fieldId),
      [],
      'existing',
    ),
  );
  return {
    backfillAdmissibilityVersion: BACKFILL_ADMISSIBILITY_VERSION,
    compatibilityMatrixVersion: STORAGE_COMPATIBILITY_MATRIX_VERSION,
    elements: totalOrder(elements),
    ...binding,
    kind: 'storageTransitionEnvelope',
    rendererPolicyVersion: STORAGE_RENDERER_POLICY_VERSION,
    schemaVersion: STORAGE_TRANSITION_ENVELOPE_VERSION,
    tighteningDebt: [],
    totalOrdering: 'declaredDependenciesThenElementIdCodeUnits',
  };
}

export function lowerStorageTargetV1(
  packageRevision: NormalizedApplicationPackage,
  previousStorageTarget: StorageTargetPayloadV1 | null = null,
): StorageTargetPayloadV1 {
  const mappings: PhysicalMappingRecord[] = [];
  const previousEntities = new Map(
    (previousStorageTarget?.entities ?? []).map((entity) => [
      entity.entityId,
      entity,
    ]),
  );
  const fieldsByEntity = groupBy(
    packageRevision.fields,
    (field) => field.entity.targetId,
  );
  const queriesByEntity = groupBy(
    packageRevision.queries.filter((query) => query.lifecycle === 'active'),
    (query) => query.sourceEntity.targetId,
  );
  const operationsByEntity = groupBy(
    packageRevision.operations.filter(
      (operation) =>
        operation.lifecycle === 'active' && 'entity' in operation.effect,
    ),
    (operation) =>
      'entity' in operation.effect ? operation.effect.entity.targetId : '',
  );
  const storageById = new Map(
    packageRevision.storageMappings.map((mapping) => [
      mapping.storageMappingId,
      mapping,
    ]),
  );
  const stateMachinesByEntity = groupBy(
    packageRevision.stateMachines,
    (machine) => machine.entity.targetId,
  );

  const entities = packageRevision.entities.map(
    (entity): StorageEntityTarget => {
      const storage = storageById.get(entity.storage.targetId);
      if (storage?.storageClass !== 'dedicatedTable') {
        throw new Error(
          'v1 storage lowering requires validated dedicated storage',
        );
      }
      const physicalTableName = physicalNameFor('table', entity.entityId);
      addMapping(mappings, 'table', entity.entityId, physicalTableName, {
        entityId: entity.entityId,
        storageClass: storage.storageClass,
      });
      const primaryKeyName = physicalNameFor(
        'constraint',
        `${entity.entityId}/primary-key`,
      );
      addMapping(
        mappings,
        'constraint',
        `${entity.entityId}#primary-key`,
        primaryKeyName,
        { columns: ['tenant_id', 'environment_id', 'record_id'] },
      );
      const previousEntity = previousEntities.get(entity.entityId);
      const previousColumns = new Map(
        (previousEntity?.columns ?? []).map((column) => [
          column.canonicalFieldId,
          column,
        ]),
      );
      const columns = (fieldsByEntity.get(entity.entityId) ?? []).map(
        (field) => {
          const previousColumn = previousColumns.get(field.fieldId);
          const deferRequiredTightening =
            field.presence === 'required' &&
            previousEntity !== undefined &&
            (previousColumn === undefined || previousColumn.nullable);
          return lowerColumn(field, mappings, deferRequiredTightening);
        },
      );
      const checkConstraints = (
        fieldsByEntity.get(entity.entityId) ?? []
      ).flatMap((field): StorageCheckConstraintTarget[] => {
        if (field.fieldType.kind !== 'enumFieldType') return [];
        const physicalName = physicalNameFor(
          'constraint',
          `${field.fieldId}/enum-domain`,
        );
        const constraint = {
          canonicalFieldId: field.fieldId,
          checkKind: 'enumDomain' as const,
          enumOptionIds: field.fieldType.options
            .map((option) => option.optionId)
            .sort(compare),
          physicalName,
          validated: false as const,
        };
        addMapping(
          mappings,
          'constraint',
          `${field.fieldId}#enum-domain`,
          physicalName,
          constraint,
        );
        return [constraint];
      });
      const derivedStateFields = (
        stateMachinesByEntity.get(entity.entityId) ?? []
      )
        .map((machine) => {
          const physicalName = physicalNameFor(
            'column',
            machine.stateField.fieldId,
          );
          const derived = {
            fieldId: machine.stateField.fieldId,
            physicalName,
            postgresqlType: 'text' as const,
            stateMachineId: machine.machineId,
          };
          addMapping(
            mappings,
            'column',
            machine.stateField.fieldId,
            physicalName,
            derived,
          );
          return derived;
        })
        .sort((left, right) => compare(left.fieldId, right.fieldId));
      const uniqueKeys: StorageUniqueKeyTarget[] = [];
      const indexes: StorageIndexTarget[] = [];
      for (const column of columns) {
        if (
          (fieldsByEntity.get(entity.entityId) ?? []).find(
            (field) => field.fieldId === column.canonicalFieldId,
          )?.businessKey === 'tenantEnvironmentCaseInsensitiveUnique'
        ) {
          const physicalName = physicalNameFor(
            'constraint',
            `${column.canonicalFieldId}/tenant-environment-unique`,
          );
          const unique = {
            collation: 'unicodeCaseInsensitive' as const,
            columns: ['tenant_id', 'environment_id', column.physicalName],
            normalization: 'unicodeCaseFold' as const,
            physicalName,
          };
          uniqueKeys.push(unique);
          addMapping(
            mappings,
            'constraint',
            `${column.canonicalFieldId}#tenant-environment-unique`,
            physicalName,
            unique,
          );
          const index = {
            columnNames: unique.columns,
            indexKind: 'caseInsensitiveUnique' as const,
            physicalName: physicalNameFor(
              'index',
              `${column.canonicalFieldId}/tenant-environment-unique`,
            ),
          };
          indexes.push(index);
          addMapping(
            mappings,
            'index',
            `${column.canonicalFieldId}#tenant-environment-unique-index`,
            index.physicalName,
            index,
          );
        }
        if (column.searchMapping === 'normalizedTextIndex') {
          const physicalName = physicalNameFor(
            'index',
            `${column.canonicalFieldId}/search`,
          );
          const index = {
            columnNames: ['tenant_id', 'environment_id', column.physicalName],
            indexKind: 'search' as const,
            physicalName,
          };
          indexes.push(index);
          addMapping(
            mappings,
            'index',
            `${column.canonicalFieldId}#search`,
            physicalName,
            index,
          );
        }
      }
      return {
        archive: {
          archivedAtColumn: 'archived_at',
          defaultVisibility: 'excludeArchived',
          representation: 'nullableTimestamp',
        },
        checkConstraints,
        columns,
        consumerWriterRoots: {
          readerQueryIds: (queriesByEntity.get(entity.entityId) ?? [])
            .map((query) => query.queryId)
            .sort(compare),
          writerOperationIds: (operationsByEntity.get(entity.entityId) ?? [])
            .map((operation) => operation.operationId)
            .sort(compare),
        },
        derivedStateFields,
        entityId: entity.entityId,
        indexes: indexes.sort((left, right) =>
          compare(left.physicalName, right.physicalName),
        ),
        lifecycle: entity.lifecycle,
        optimisticRevision: {
          column: 'revision',
          initialValue: '1',
          postgresqlType: 'bigint',
        },
        physicalTableName,
        primaryKey: {
          columns: ['tenant_id', 'environment_id', 'record_id'],
          physicalName: primaryKeyName,
        },
        recordIdentity: { column: 'record_id', postgresqlType: 'uuid' },
        scopeKeyColumns: ['tenant_id', 'environment_id'],
        storageClass: storage.storageClass,
        storageMappingId: storage.storageMappingId,
        uniqueKeys: uniqueKeys.sort((left, right) =>
          compare(left.physicalName, right.physicalName),
        ),
      };
    },
  );

  const entityById = new Map(
    entities.map((entity) => [entity.entityId, entity]),
  );
  const relations = packageRevision.relations.map(
    (relation): StorageRelationTarget => {
      const source = entityById.get(relation.sourceEntity.targetId)!;
      const target = entityById.get(relation.targetEntity.targetId)!;
      if (!source || !target) {
        throw new Error('validated relation target is missing');
      }
      const relationColumn = physicalNameFor(
        'column',
        `${relation.relationId}/target-record-id`,
      );
      const physicalName = physicalNameFor(
        'constraint',
        `${relation.relationId}/foreign-key`,
      );
      const foreignKey = {
        onDelete: 'restrict' as const,
        onUpdate: 'restrict' as const,
        physicalName,
        sourceColumns: ['tenant_id', 'environment_id', relationColumn],
        targetColumns: [
          'tenant_id',
          'environment_id',
          target.recordIdentity.column,
        ],
      };
      const targetShape: StorageRelationTarget = {
        archiveBehavior: relation.archiveBehavior,
        foreignKey,
        ownership: relation.ownership,
        relationColumn: {
          nullable: !relation.required,
          physicalName: relationColumn,
          postgresqlType: 'uuid',
        },
        relationId: relation.relationId,
        sourceEntityId: relation.sourceEntity.targetId,
        targetEntityId: relation.targetEntity.targetId,
      };
      const compatibilityShape = {
        archiveBehavior: targetShape.archiveBehavior,
        foreignKey: targetShape.foreignKey,
        ownership: targetShape.ownership,
        relationColumn: targetShape.relationColumn,
        relationId: targetShape.relationId,
        sourceEntityId: targetShape.sourceEntityId,
        targetEntityId: targetShape.targetEntityId,
      };
      addMapping(
        mappings,
        'column',
        `${relation.relationId}#target-record-id`,
        relationColumn,
        compatibilityShape,
      );
      addMapping(
        mappings,
        'constraint',
        `${relation.relationId}#foreign-key`,
        physicalName,
        compatibilityShape,
      );
      const relationIndex = {
        columnNames: ['tenant_id', 'environment_id', relationColumn],
        indexKind: 'relation' as const,
        physicalName: physicalNameFor(
          'index',
          `${relation.relationId}/tenant-environment-relation`,
        ),
      };
      source.indexes.push(relationIndex);
      source.indexes.sort((left, right) =>
        compare(left.physicalName, right.physicalName),
      );
      addMapping(
        mappings,
        'index',
        `${relation.relationId}#tenant-environment-relation`,
        relationIndex.physicalName,
        relationIndex,
      );
      return targetShape;
    },
  );

  return {
    backfillInvariant: {
      completenessLoadBearing: false,
      residualRowsRequire: 'declaredDefaultOrCoalesceAtRead',
      version: BACKFILL_ADMISSIBILITY_VERSION,
    },
    entities,
    fieldTypeTable: POSTGRESQL_FIELD_TYPE_TABLE,
    kind: 'storageTargetPayload',
    physicalMapping: {
      digest: 'sha256',
      encoding: 'base32-lowercase-no-padding',
      maximumIdentifierBytes: 63,
      records: mappings.sort(compareMappings),
      version: PHYSICAL_MAPPING_VERSION,
    },
    promotionReserve: {
      capabilityId: 'northstar.storage:capability.promote-storage-class',
      invariant:
        'canonical identity and gateway contracts survive promotion; the physical locator may change; the eventual dedicated name is deterministic from canonical identity',
      status: 'unsupported',
    },
    providerAbi: {
      managedSchema: 'north_star_module',
      materializerRole: 'north_star_module_materializer',
      runtimeRole: 'north_star_module_runtime',
      scopeKeyTypes: {
        environment_id: 'uuid',
        tenant_id: 'uuid',
      },
      trustedContextFunctions: [
        'north_star_internal.trusted_tenant_id()',
        'north_star_internal.trusted_environment_id()',
      ],
      version: POSTGRES_PROVIDER_ABI_VERSION,
    },
    relations: relations.sort((left, right) =>
      compare(left.relationId, right.relationId),
    ),
    rendererPolicyVersion: STORAGE_RENDERER_POLICY_VERSION,
    rlsGrantTemplate: MODULE_RLS_GRANT_TEMPLATE,
    schemaVersion: STORAGE_TARGET_PAYLOAD_VERSION,
  };
}

export function buildStorageTransitionEnvelope(
  packageRevision: NormalizedApplicationPackage,
  previous: StorageTargetPayloadV1,
  candidate: StorageTargetPayloadV1,
  binding: TransitionBinding,
): StorageTransitionEnvelope | { diagnostic: CompilerDiagnostic } {
  const previousEntities = new Map(
    previous.entities.map((entity) => [entity.entityId, entity]),
  );
  const candidateEntities = new Map(
    candidate.entities.map((entity) => [entity.entityId, entity]),
  );
  const elements: StorageTransitionElement[] = [];
  const debts: TighteningDebt[] = [];
  const createdTableElementIds = new Map<string, string>();

  for (const oldEntityId of previousEntities.keys()) {
    if (!candidateEntities.has(oldEntityId)) {
      return failureDiagnostic(
        'COMPILER_STORAGE_TRANSITION_UNSUPPORTED',
        '$.entities',
        oldEntityId,
      );
    }
  }

  for (const entity of candidate.entities) {
    const oldEntity = previousEntities.get(entity.entityId);
    if (!oldEntity) {
      const tableElement = element(
        'createTable',
        entity.entityId,
        null,
        entity.physicalTableName,
        [],
        'samePlan',
      );
      elements.push(tableElement);
      createdTableElementIds.set(entity.entityId, tableElement.elementId);
      for (const index of entity.indexes) {
        elements.push(
          element(
            'createIndex',
            entity.entityId,
            null,
            index.physicalName,
            [tableElement.elementId],
            'samePlan',
          ),
        );
      }
      continue;
    }
    if (oldEntity.physicalTableName !== entity.physicalTableName) {
      return failureDiagnostic(
        'COMPILER_PHYSICAL_NAME_REUSE_INCOMPATIBLE',
        '$.physicalMapping.records',
        entity.entityId,
      );
    }
    const oldFields = new Map(
      oldEntity.columns.map((field) => [field.canonicalFieldId, field]),
    );
    const oldChecks = new Set(
      (oldEntity.checkConstraints ?? []).map((check) => check.physicalName),
    );
    const newFields = new Map(
      entity.columns.map((field) => [field.canonicalFieldId, field]),
    );
    const addedColumnElementIds = new Map<string, string>();
    const removed = [...oldFields.keys()].filter(
      (fieldId) => !newFields.has(fieldId),
    );
    const added = [...newFields.keys()].filter(
      (fieldId) => !oldFields.has(fieldId),
    );
    if (removed.length > 0 && added.length > 0) {
      return failureDiagnostic(
        'COMPILER_STORAGE_RENAME_AS_ADD_UNSUPPORTED',
        '$.fields',
        [...removed, ...added].sort(compare)[0]!,
      );
    }
    if (removed.length > 0) {
      return failureDiagnostic(
        'COMPILER_STORAGE_TRANSITION_UNSUPPORTED',
        '$.fields',
        removed.sort(compare)[0]!,
      );
    }
    for (const [fieldId, field] of newFields) {
      const oldField = oldFields.get(fieldId);
      if (oldField && oldField.shapeFingerprint !== field.shapeFingerprint) {
        return failureDiagnostic(
          'COMPILER_STORAGE_RETYPE_UNSUPPORTED',
          '$.fields.fieldType',
          fieldId,
        );
      }
      if (oldField) continue;
      const sourceField = packageRevision.fields.find(
        (entry) => entry.fieldId === fieldId,
      )!;
      if (
        sourceField.storageEvolution?.residualReadSemantics ===
        'requiresCompleteness'
      ) {
        return failureDiagnostic(
          'COMPILER_BACKFILL_INADMISSIBLE',
          '$.fields.storageEvolution.residualReadSemantics',
          fieldId,
        );
      }
      if (
        sourceField.presence === 'required' &&
        sourceField.defaultSemantics !== 'coalesceAtRead' &&
        sourceField.defaultSemantics !== 'declaredDefault'
      ) {
        return failureDiagnostic(
          'COMPILER_BACKFILL_INADMISSIBLE',
          '$.fields.defaultSemantics',
          fieldId,
        );
      }
      if (
        sourceField.storageEvolution?.residualReadSemantics ===
          'declaredDefault' &&
        sourceField.defaultSemantics !== 'declaredDefault'
      ) {
        return failureDiagnostic(
          'COMPILER_BACKFILL_INADMISSIBLE',
          '$.fields.defaultSemantics',
          fieldId,
        );
      }
      if (
        sourceField.storageEvolution?.residualReadSemantics ===
          'coalesceAtRead' &&
        sourceField.defaultSemantics !== 'coalesceAtRead'
      ) {
        return failureDiagnostic(
          'COMPILER_BACKFILL_INADMISSIBLE',
          '$.fields.defaultSemantics',
          fieldId,
        );
      }
      const addColumn = element(
        'addColumn',
        entity.entityId,
        fieldId,
        field.physicalName,
        [],
        'existing',
      );
      elements.push(addColumn);
      addedColumnElementIds.set(fieldId, addColumn.elementId);
      let tightenDependency = addColumn;
      if (sourceField.storageEvolution) {
        const backfill = element(
          'backfill',
          entity.entityId,
          fieldId,
          field.physicalName,
          [addColumn.elementId],
          'existing',
        );
        elements.push(backfill);
        tightenDependency = backfill;
      }
      if (field.searchMapping === 'normalizedTextIndex') {
        const index = entity.indexes.find((candidateIndex) =>
          candidateIndex.columnNames.includes(field.physicalName),
        );
        if (index) {
          elements.push(
            element(
              'createIndex',
              entity.entityId,
              fieldId,
              index.physicalName,
              [addColumn.elementId],
              'existing',
            ),
          );
        }
      }
      if (field.requiredAfterTightening) {
        const tighten = element(
          'tightenNotNull',
          entity.entityId,
          fieldId,
          field.physicalName,
          [tightenDependency.elementId],
          'existing',
        );
        elements.push(tighten);
        debts.push(
          tighteningDebt(
            tighten,
            binding.fromReleaseRoot,
            affectedConsumerWriters(oldEntity, entity),
          ),
        );
      }
    }
    for (const check of entity.checkConstraints) {
      if (oldChecks.has(check.physicalName)) continue;
      elements.push(
        element(
          'addNotValidConstraint',
          entity.entityId,
          check.canonicalFieldId,
          check.physicalName,
          [addedColumnElementIds.get(check.canonicalFieldId)].filter(
            (dependency): dependency is string => dependency !== undefined,
          ),
          'existing',
        ),
      );
    }
  }

  const previousRelations = new Map(
    previous.relations.map((relation) => [relation.relationId, relation]),
  );
  const candidateRelations = new Map(
    candidate.relations.map((relation) => [relation.relationId, relation]),
  );
  for (const relation of previous.relations) {
    if (!candidateRelations.has(relation.relationId)) {
      return failureDiagnostic(
        'COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED',
        '$.relations',
        relation.relationId,
      );
    }
  }
  for (const relation of candidate.relations) {
    const previousRelation = previousRelations.get(relation.relationId);
    if (previousRelation) {
      if (!sameRelationShape(previousRelation, relation)) {
        return failureDiagnostic(
          'COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED',
          '$.relations',
          relation.relationId,
        );
      }
      const source = candidateEntities.get(relation.sourceEntityId)!;
      const previousSource = previousEntities.get(relation.sourceEntityId)!;
      const relationIndex = source.indexes.find(
        (index) =>
          index.indexKind === 'relation' &&
          index.columnNames.includes(relation.relationColumn.physicalName),
      );
      if (
        relationIndex &&
        !previousSource.indexes.some(
          (index) => index.physicalName === relationIndex.physicalName,
        )
      ) {
        elements.push(
          element(
            'createIndex',
            relation.relationId,
            null,
            relationIndex.physicalName,
            [],
            'existing',
          ),
        );
      }
      continue;
    }
    const sourceOrigin = previousEntities.has(relation.sourceEntityId)
      ? 'existing'
      : 'samePlan';
    if (sourceOrigin === 'existing' && !relation.relationColumn.nullable) {
      return failureDiagnostic(
        'COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED',
        '$.relations.required',
        relation.relationId,
      );
    }
    const dependencies = [
      createdTableElementIds.get(relation.sourceEntityId),
      createdTableElementIds.get(relation.targetEntityId),
    ].filter((entry): entry is string => entry !== undefined);
    let relationColumnElementId: string | undefined;
    if (sourceOrigin === 'existing') {
      const relationColumn = element(
        'addColumn',
        relation.relationId,
        null,
        relation.relationColumn.physicalName,
        [],
        'existing',
      );
      elements.push(relationColumn);
      dependencies.push(relationColumn.elementId);
      relationColumnElementId = relationColumn.elementId;
    }
    const entry = element(
      'addForeignKey',
      relation.relationId,
      null,
      relation.foreignKey.physicalName,
      dependencies,
      sourceOrigin,
    );
    elements.push(entry);
    if (sourceOrigin === 'existing') {
      const source = candidateEntities.get(relation.sourceEntityId)!;
      const relationIndex = source.indexes.find(
        (index) =>
          index.indexKind === 'relation' &&
          index.columnNames.includes(relation.relationColumn.physicalName),
      );
      if (!relationIndex) {
        throw new Error('validated relation index is missing');
      }
      elements.push(
        element(
          'createIndex',
          relation.relationId,
          null,
          relationIndex.physicalName,
          relationColumnElementId ? [relationColumnElementId] : [],
          'existing',
        ),
      );
    }
    if (entry.coexistence.admission === 'blockingWhileAffectedWritersLive') {
      debts.push(
        tighteningDebt(
          entry,
          binding.fromReleaseRoot,
          affectedConsumerWriters(
            previousEntities.get(relation.sourceEntityId),
            candidateEntities.get(relation.sourceEntityId),
          ),
        ),
      );
    }
  }

  return {
    backfillAdmissibilityVersion: BACKFILL_ADMISSIBILITY_VERSION,
    compatibilityMatrixVersion: STORAGE_COMPATIBILITY_MATRIX_VERSION,
    elements: totalOrder(elements),
    ...binding,
    kind: 'storageTransitionEnvelope',
    rendererPolicyVersion: STORAGE_RENDERER_POLICY_VERSION,
    schemaVersion: STORAGE_TRANSITION_ENVELOPE_VERSION,
    tighteningDebt: debts.sort((left, right) =>
      compare(left.debtId, right.debtId),
    ),
    totalOrdering: 'declaredDependenciesThenElementIdCodeUnits',
  };
}

export function classifyStorageTransitionElement(
  kind: StorageTransitionElementKind,
  objectOrigin: 'samePlan' | 'existing',
): {
  classification: StorageElementClassification;
  coexistence: StorageCompatibilityCell;
  coexistenceImpact: StorageTransitionElement['coexistenceImpact'];
} {
  const classification: StorageElementClassification = (() => {
    switch (kind) {
      case 'createTable':
        return {
          dataEffect: 'catalogOnly',
          operationalRisk: 'boundedCatalogLock',
          preparationValidity: 'preApprovalInert',
          semanticEffect: 'additive',
        };
      case 'addColumn':
        return {
          dataEffect: 'catalogOnly',
          operationalRisk: 'boundedCatalogLock',
          preparationValidity: 'preApprovalInert',
          semanticEffect: 'additive',
        };
      case 'createIndex':
        return objectOrigin === 'samePlan'
          ? {
              dataEffect: 'catalogOnly',
              operationalRisk: 'none',
              preparationValidity: 'preApprovalInert',
              semanticEffect: 'none',
            }
          : {
              dataEffect: 'dataScan',
              operationalRisk: 'onlineStrategyRequired',
              preparationValidity: 'deferredOnlineFamily',
              semanticEffect: 'none',
            };
      case 'addForeignKey':
        return objectOrigin === 'samePlan'
          ? {
              dataEffect: 'catalogOnly',
              operationalRisk: 'none',
              preparationValidity: 'preApprovalInert',
              semanticEffect: 'additive',
            }
          : {
              dataEffect: 'catalogOnly',
              operationalRisk: 'boundedCatalogLock',
              preparationValidity: 'inAttemptOnly',
              semanticEffect: 'tightening',
            };
      case 'addNotValidConstraint':
        return {
          dataEffect: 'catalogOnly',
          operationalRisk: 'boundedCatalogLock',
          preparationValidity: 'inAttemptOnly',
          semanticEffect: 'tightening',
        };
      case 'validateConstraint':
      case 'duplicateScan':
        return {
          dataEffect: 'dataScan',
          operationalRisk: 'longRunning',
          preparationValidity: 'deferredTightening',
          semanticEffect: 'tightening',
        };
      case 'backfill':
        return {
          dataEffect: 'rowMutation',
          operationalRisk: 'longRunning',
          preparationValidity: 'inAttemptOnly',
          semanticEffect: 'none',
        };
      case 'tightenNotNull':
        return {
          dataEffect: 'dataScan',
          operationalRisk: 'longRunning',
          preparationValidity: 'deferredTightening',
          semanticEffect: 'tightening',
        };
    }
  })();
  const base = STORAGE_COMPATIBILITY_MATRIX[kind];
  const coexistence =
    (kind === 'createIndex' || kind === 'addForeignKey') &&
    objectOrigin === 'samePlan'
      ? {
          ...base,
          admission: 'additive' as const,
          oldRead: 'notApplicable' as const,
          oldWrite: 'notApplicable' as const,
        }
      : base;
  const coexistenceImpact =
    coexistence.oldWrite === 'mayReject'
      ? 'oldWritesMayReject'
      : coexistence.newRead === 'requiresReadFallback'
        ? 'requiresReadFallback'
        : 'none';
  return { classification, coexistence, coexistenceImpact };
}

export function physicalNameFor(
  objectKind: PhysicalMappingRecord['objectKind'],
  canonicalId: string,
): string {
  const prefix: Record<PhysicalMappingRecord['objectKind'], string> = {
    column: 'nsm_c_',
    constraint: 'nsm_k_',
    index: 'nsm_i_',
    table: 'nsm_t_',
  };
  const digest = createHash('sha256')
    .update(`${HASH_DOMAINS.physicalName}/${objectKind}`, 'utf8')
    .update(Uint8Array.of(0))
    .update(canonicalId, 'utf8')
    .digest();
  return `${prefix[objectKind]}${base32(digest)}`;
}

export function validatePhysicalMappingRecords(
  records: readonly PhysicalMappingRecord[],
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const byName = new Map<string, PhysicalMappingRecord>();
  for (const record of [...records].sort(compareMappings)) {
    if (Buffer.byteLength(record.physicalName, 'utf8') > 63) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_PHYSICAL_NAME_TOO_LONG',
          'postLoweringValidation',
          '$.physicalMapping.records.physicalName',
          record.canonicalId,
        ),
      );
    }
    const prior = byName.get(record.physicalName);
    if (prior && prior.canonicalId !== record.canonicalId) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_PHYSICAL_NAME_COLLISION',
          'postLoweringValidation',
          '$.physicalMapping.records.physicalName',
          record.canonicalId,
        ),
      );
    } else if (prior && prior.shapeFingerprint !== record.shapeFingerprint) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_PHYSICAL_NAME_REUSE_INCOMPATIBLE',
          'postLoweringValidation',
          '$.physicalMapping.records.shapeFingerprint',
          record.canonicalId,
        ),
      );
    }
    byName.set(record.physicalName, record);
  }
  return diagnostics;
}

export function validateStorageRendererStatements(
  statements: readonly StorageRendererStatement[],
): CompilerDiagnostic[] {
  const destructive = new Set<StorageRendererStatement['kind']>([
    'deleteCapableRule',
    'deleteCapableTrigger',
    'dropBusinessObject',
    'onDeleteCascade',
    'removePartition',
    'truncateTable',
  ]);
  return statements.flatMap((statement, index) =>
    destructive.has(statement.kind)
      ? [
          compilerDiagnostic(
            'COMPILER_DESTRUCTIVE_STORAGE_DDL_UNSUPPORTED',
            'postLoweringValidation',
            `$.renderer.statements[${index}]`,
            statement.kind,
            index,
          ),
        ]
      : [],
  );
}

export function postgresqlTypeFor(fieldType: FieldType): string {
  switch (fieldType.kind) {
    case 'booleanFieldType':
      return 'boolean';
    case 'dateFieldType':
      return 'date';
    case 'dateTimeFieldType':
      return fieldType.timezoneSemantics === 'offsetDateTime'
        ? 'text'
        : `timestamp(${fieldType.precision === 'second' ? 0 : 3}) with time zone`;
    case 'enumFieldType':
      return 'text';
    case 'exactDecimalFieldType':
    case 'moneyFieldType':
    case 'quantityFieldType':
      return `numeric(${fieldType.precision},${fieldType.scale})`;
    case 'integerFieldType':
      return 'numeric';
    case 'textFieldType':
      return `varchar(${fieldType.maximumLength})`;
    case 'timeFieldType':
      return `time(${fieldType.precision === 'second' ? 0 : 3}) without time zone`;
  }
}

function lowerColumn(
  field: Field,
  mappings: PhysicalMappingRecord[],
  deferRequiredTightening: boolean,
): StorageColumnTarget {
  const physicalName = physicalNameFor('column', field.fieldId);
  const postgresqlType = postgresqlTypeFor(field.fieldType);
  const defaultSemantics =
    field.defaultSemantics ??
    (field.presence === 'optional' ? 'nullable' : 'none');
  const value = {
    canonicalFieldId: field.fieldId,
    coexistenceImpact:
      field.presence === 'required' && !deferRequiredTightening
        ? ('none' as const)
        : ('requiresReadFallback' as const),
    collation: field.collation ?? ('binary' as const),
    defaultSemantics,
    defaultValue: field.defaultValue ?? null,
    fieldContract: fieldContract(field),
    nullable: field.presence !== 'required' || deferRequiredTightening,
    physicalName,
    postgresqlType,
    requiredAfterTightening: deferRequiredTightening,
    searchMapping: field.searchable
      ? ('normalizedTextIndex' as const)
      : ('none' as const),
    shapeFingerprint: hashCanonical(
      `${HASH_DOMAINS.projectionSemantic}/storage-column`,
      {
        businessKey: field.businessKey ?? 'none',
        collation: field.collation ?? 'binary',
        defaultSemantics,
        defaultValue: field.defaultValue ?? null,
        fieldType: field.fieldType,
        nullable: field.presence !== 'required' || deferRequiredTightening,
        presence: field.presence,
        requiredAfterTightening: deferRequiredTightening,
        searchable: field.searchable,
      },
    ).digest,
  };
  addMapping(mappings, 'column', field.fieldId, physicalName, value);
  return value;
}

function fieldContract(field: Field): ModuleFieldContract {
  const precision =
    'precision' in field.fieldType &&
    typeof field.fieldType.precision === 'number'
      ? field.fieldType.precision
      : null;
  const scale = 'scale' in field.fieldType ? field.fieldType.scale : null;
  return {
    bounds: {
      maximumLength:
        field.fieldType.kind === 'textFieldType'
          ? field.fieldType.maximumLength
          : null,
      precision,
      scale,
    },
    enumOptionIds:
      field.fieldType.kind === 'enumFieldType'
        ? field.fieldType.options.map((option) => option.optionId).sort(compare)
        : [],
    fieldId: field.fieldId,
    fieldKind: field.fieldType.kind,
    normalization:
      field.businessKey === 'tenantEnvironmentCaseInsensitiveUnique'
        ? 'unicodeCaseFoldNoCompatibilityNormalization'
        : 'none',
    required: field.presence === 'required',
    schemaVersion: MODULE_FIELD_CONTRACT_VERSION,
    temporal: temporalContract(field.fieldType),
    writable: true,
  };
}

function temporalContract(
  fieldType: FieldType,
): ModuleFieldContract['temporal'] {
  switch (fieldType.kind) {
    case 'dateFieldType':
      return { precision: null, timezoneSemantics: 'calendarDate' };
    case 'timeFieldType':
      return {
        precision: fieldType.precision,
        timezoneSemantics: 'localWallTime',
      };
    case 'dateTimeFieldType':
      return {
        precision: fieldType.precision,
        timezoneSemantics: fieldType.timezoneSemantics,
      };
    default:
      return { precision: null, timezoneSemantics: null };
  }
}

function element(
  kind: StorageTransitionElementKind,
  subjectId: string,
  fieldId: string | null,
  physicalObjectName: string,
  declaredDependencyIds: string[],
  objectOrigin: 'samePlan' | 'existing',
): StorageTransitionElement {
  const classified = classifyStorageTransitionElement(kind, objectOrigin);
  const identityCore = {
    fieldId,
    kind,
    physicalObjectName,
    storageDomain: 'managedModule',
    storageGeneration: 'dedicatedTyped/v1',
    subjectId,
  };
  return {
    ...classified,
    declaredDependencyIds: [...declaredDependencyIds].sort(compare),
    elementId: hashCanonical(
      HASH_DOMAINS.storageTransitionElement,
      identityCore,
    ).digest,
    fieldId,
    kind,
    physicalObjectName,
    schemaVersion: STORAGE_ELEMENT_CONTRACT_VERSION,
    scope: {
      keyColumns: ['tenant_id', 'environment_id'],
      kind: 'tenantEnvironment',
    },
    storageDomain: 'managedModule',
    storageGeneration: 'dedicatedTyped/v1',
    subjectId,
  };
}

function tighteningDebt(
  entry: StorageTransitionElement,
  blockingOldReleaseRoot: string,
  affected: {
    candidateAffectedReaderQueryIds: string[];
    candidateAffectedWriterOperationIds: string[];
    priorAffectedReaderQueryIds: string[];
    priorAffectedWriterOperationIds: string[];
  },
): TighteningDebt {
  return {
    admissionConsequence: 'blocksTenantAccessibleModuleCreation',
    blockingRootIds: [blockingOldReleaseRoot],
    candidateAffectedReaderQueryIds: affected.candidateAffectedReaderQueryIds,
    candidateAffectedWriterOperationIds:
      affected.candidateAffectedWriterOperationIds,
    debtId: hashCanonical(`${HASH_DOMAINS.storageTransitionElement}/debt`, {
      elementId: entry.elementId,
      owner: entry.subjectId,
    }).digest,
    elementId: entry.elementId,
    liveRootResolution:
      'materializerResolvesActiveAndNonTerminalPreparationUnion',
    owner: entry.subjectId,
    prerequisites: [
      'union-live-root completeness revalidated',
      'affected physical-table writers retired or proven compatible',
      'object-level verifier passes',
    ],
    priorAffectedReaderQueryIds: affected.priorAffectedReaderQueryIds,
    priorAffectedWriterOperationIds: affected.priorAffectedWriterOperationIds,
    schemaVersion: TIGHTENING_DEBT_VERSION,
  };
}

function affectedConsumerWriters(
  previous: StorageEntityTarget | undefined,
  candidate: StorageEntityTarget | undefined,
): {
  candidateAffectedReaderQueryIds: string[];
  candidateAffectedWriterOperationIds: string[];
  priorAffectedReaderQueryIds: string[];
  priorAffectedWriterOperationIds: string[];
} {
  return {
    candidateAffectedReaderQueryIds: [
      ...new Set(candidate?.consumerWriterRoots.readerQueryIds ?? []),
    ].sort(compare),
    candidateAffectedWriterOperationIds: [
      ...new Set(candidate?.consumerWriterRoots.writerOperationIds ?? []),
    ].sort(compare),
    priorAffectedReaderQueryIds: [
      ...new Set(previous?.consumerWriterRoots.readerQueryIds ?? []),
    ].sort(compare),
    priorAffectedWriterOperationIds: [
      ...new Set(previous?.consumerWriterRoots.writerOperationIds ?? []),
    ].sort(compare),
  };
}

function sameRelationShape(
  previous: StorageRelationTarget,
  candidate: StorageRelationTarget,
): boolean {
  const physicalShape = (relation: StorageRelationTarget) => ({
    foreignKey: relation.foreignKey,
    ownership: relation.ownership,
    relationColumn: relation.relationColumn,
    relationId: relation.relationId,
    sourceEntityId: relation.sourceEntityId,
    targetEntityId: relation.targetEntityId,
  });
  return (
    hashCanonical(
      `${HASH_DOMAINS.projectionSemantic}/storage-relation-shape`,
      physicalShape(previous),
    ).digest ===
    hashCanonical(
      `${HASH_DOMAINS.projectionSemantic}/storage-relation-shape`,
      physicalShape(candidate),
    ).digest
  );
}

function totalOrder(
  elements: StorageTransitionElement[],
): StorageTransitionElement[] {
  const remaining = new Map(elements.map((entry) => [entry.elementId, entry]));
  const emitted = new Set<string>();
  const ordered: StorageTransitionElement[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((entry) =>
        entry.declaredDependencyIds.every((id) => emitted.has(id)),
      )
      .sort((left, right) => compare(left.elementId, right.elementId));
    if (ready.length === 0) throw new Error('storage element dependency cycle');
    for (const entry of ready) {
      ordered.push(entry);
      emitted.add(entry.elementId);
      remaining.delete(entry.elementId);
    }
  }
  return ordered;
}

function addMapping(
  mappings: PhysicalMappingRecord[],
  objectKind: PhysicalMappingRecord['objectKind'],
  canonicalId: string,
  physicalName: string,
  shape: unknown,
): void {
  mappings.push({
    canonicalId,
    mappingVersion: PHYSICAL_MAPPING_VERSION,
    objectKind,
    physicalName,
    shapeFingerprint: hashCanonical(`${HASH_DOMAINS.physicalName}/shape`, shape)
      .digest,
    storageDomain: 'managedModule',
  });
}

function failureDiagnostic(
  code:
    | 'COMPILER_BACKFILL_INADMISSIBLE'
    | 'COMPILER_PHYSICAL_NAME_REUSE_INCOMPATIBLE'
    | 'COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED'
    | 'COMPILER_STORAGE_RENAME_AS_ADD_UNSUPPORTED'
    | 'COMPILER_STORAGE_RETYPE_UNSUPPORTED'
    | 'COMPILER_STORAGE_TRANSITION_UNSUPPORTED',
  path: string,
  subjectId: string,
): { diagnostic: CompilerDiagnostic } {
  return {
    diagnostic: compilerDiagnostic(
      code,
      'postLoweringValidation',
      path,
      subjectId,
    ),
  };
}

function base32(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let buffer = 0;
  let result = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}

function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const identity = key(value);
    const entries = grouped.get(identity) ?? [];
    entries.push(value);
    grouped.set(identity, entries);
  }
  return grouped;
}

function compareMappings(
  left: PhysicalMappingRecord,
  right: PhysicalMappingRecord,
): number {
  return (
    compare(left.physicalName, right.physicalName) ||
    compare(left.canonicalId, right.canonicalId)
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
