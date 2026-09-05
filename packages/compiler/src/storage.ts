import { createHash } from 'node:crypto';

import {
  languageHasMaterializedStateFields,
  type NormalizedApplicationPackage,
} from '@north-star/canonical-model';

import {
  isPinnedInventoryBaseUnitField,
  isPinnedLegalEntityMaster,
  resolvePinnedInventoryFactStorage,
  resolvePinnedInventoryMovementFieldRole,
  resolvePinnedInventoryPeriodLockStorage,
  resolvePinnedInventoryStorageReference,
  resolvePinnedLegalEntityRelationSemantics,
  resolvePinnedLegalEntityMasterFieldRole,
  resolvePinnedLegalEntityFamily,
} from './conformance.js';
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
  STORAGE_TARGET_PAYLOAD_V2_VERSION,
  STORAGE_TARGET_PAYLOAD_V3_VERSION,
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
  createPartition: Object.freeze({
    admission: 'additive',
    newRead: 'compatible',
    newWrite: 'compatible',
    oldRead: 'notApplicable',
    oldWrite: 'notApplicable',
  }),
  createCompanionTable: Object.freeze({
    admission: 'additive',
    newRead: 'compatible',
    newWrite: 'compatible',
    oldRead: 'notApplicable',
    oldWrite: 'notApplicable',
  }),
  createRejectMutationTrigger: Object.freeze({
    admission: 'blockingWhileAffectedWritersLive',
    newRead: 'compatible',
    newWrite: 'compatible',
    oldRead: 'compatible',
    oldWrite: 'mayReject',
  }),
  addAbiFunctionCheck: Object.freeze({
    admission: 'blockingWhileAffectedWritersLive',
    newRead: 'compatible',
    newWrite: 'compatible',
    oldRead: 'compatible',
    oldWrite: 'mayReject',
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
  relaxNotNull: Object.freeze({
    admission: 'additive',
    newRead: 'compatible',
    newWrite: 'compatible',
    // An old reader was compiled against a relation its model calls required,
    // so it never planned for the absence of a target. Relaxation does not make
    // it reject -- reads do not reject -- but the moment a NEW writer stores a
    // null, that old reader observes one where its model says a value is always
    // present. That is the same shape as `addColumn`'s `newRead`, read from the
    // other side of the release boundary, and it is the honest cell: the
    // widening is safe for the DATABASE and not transparent to a live READER.
    oldRead: 'requiresReadFallback',
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
  widenEnumDomain: Object.freeze({
    admission: 'additive',
    newRead: 'compatible',
    newWrite: 'compatible',
    // The same cell as `relaxNotNull`, for the same reason. A reader compiled
    // against the previous release models the field as one of N options; the
    // moment a NEW writer stores the (N+1)th, that old reader observes a value
    // its model does not name. Reads do not reject, so this is not
    // `mayReject` -- it is the fallback burden on the OLD side.
    oldRead: 'requiresReadFallback',
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
  schemaVersion:
    | typeof STORAGE_TARGET_PAYLOAD_VERSION
    | typeof STORAGE_TARGET_PAYLOAD_V2_VERSION
    | typeof STORAGE_TARGET_PAYLOAD_V3_VERSION;
}

export interface StorageAbiFunctionCheckTarget {
  checkKind: 'baseUnitBinding';
  itemIdColumn: string;
  movementItemIdColumn: string;
  movementRecordIdColumn: string;
  movementRecordedAtColumn: string;
  movementTableName: string;
  movementUnitIdColumn: string;
  physicalName: string;
  unitIdColumn: string;
}

export interface StorageFactCompanionTarget {
  columns: Array<{ name: string; postgresqlType: string }>;
  movementForeignKey: {
    physicalName: string;
    sourceColumns: string[];
    targetColumns: string[];
  };
  movementUnique: { columns: string[]; physicalName: string };
  physicalTableName: string;
  primaryKey: { columns: string[]; physicalName: string };
  reservationTriggerName: string;
  rejectMutationTriggerName: string;
}

export interface StorageFactTarget {
  businessPeriod: {
    checkConstraintName: string;
    column: 'business_period';
    effectiveAtColumn: string;
    postgresqlType: 'date';
  };
  companion: StorageFactCompanionTarget;
  effectIdentityUnique: { columns: string[]; physicalName: string };
  fieldColumns: Record<
    | 'itemId'
    | 'locationId'
    | 'postingRole'
    | 'recordedAt'
    | 'sourceId'
    | 'sourceLine'
    | 'sourceRevision'
    | 'sourceType'
    | 'unitId',
    string
  >;
  mutability: 'appendOnly';
  partitioning: {
    keyColumns: readonly ['tenant_id', 'business_period'];
    kind: 'tenantBusinessPeriodHash';
    partitions: Array<{
      modulus: 8;
      physicalTableName: string;
      remainder: number;
    }>;
  };
  rejectMutationTriggerName: string;
  stockHorizonIndex: {
    columns: string[];
    physicalName: string;
  };
  stockIdentityV1MemberChecks: Array<{
    column: string;
    physicalName: string;
    rejectedSentinel: '00000000-0000-0000-0000-000000000000';
  }>;
}

export interface StorageEntityTarget {
  abiFunctionChecks?: StorageAbiFunctionCheckTarget[];
  archive: {
    archivedAtColumn: string;
    defaultVisibility: 'excludeArchived';
    representation: 'nullableTimestamp';
  };
  businessKeyScopeColumns?: readonly [
    'tenant_id',
    'environment_id',
    'legal_entity_id',
  ];
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
  foldedColumns: StorageFoldedColumnTarget[];
  factStorage?: StorageFactTarget;
  indexes: StorageIndexTarget[];
  lifecycle: string;
  legalEntity?: {
    column: 'legal_entity_id';
    familyClassification: 'entityOwned';
    immutableAfterCreate: true;
    nullable: false;
    postgresqlType: 'uuid';
    referencedFamilyId: 'legal_entity';
  };
  legalEntityMaster?: {
    activeStatusValue: string;
    defaultUniqueIndex: {
      columns: ['tenant_id', 'environment_id'];
      physicalName: string;
      predicate: string;
    };
    fieldColumns: {
      code: string;
      isDefault: string;
      name: string;
      status: string;
    };
    provisioning: 'oneDefaultPerTenantEnvironment';
  };
  optimisticRevision: {
    column: string;
    initialValue: '1';
    postgresqlType: 'bigint';
  };
  periodLock?: {
    advanceOperationId: string;
    closedThroughColumn: string;
    reopenOperationId: string;
    provisioningTriggerName: string;
    scopeUniqueIndex: {
      columns: readonly ['tenant_id', 'environment_id', 'legal_entity_id'];
      physicalName: string;
    };
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

export interface StorageFoldedColumnTarget {
  canonicalFieldId: string;
  collation: 'C';
  foldFunction: 'north_star_module.nsm_unicode_case_fold_v1';
  physicalName: string;
  postgresqlType: 'text';
  sourceColumn: string;
  stored: true;
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
  indexKind:
    | 'caseInsensitiveUnique'
    | 'foldedAccess'
    | 'legalEntityDefaultUnique'
    | 'periodLockScopeUnique'
    | 'relation'
    | 'resolveAccess'
    | 'stockHorizon';
  physicalName: string;
  predicate: string | null;
}

export interface StorageUniqueKeyTarget {
  collation: 'unicodeCaseInsensitive';
  columns: string[];
  normalization: 'unicodeCaseFold';
  physicalName: string;
  predicate: string;
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
    origin?: 'field';
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

/**
 * `materializedStateFields` is PASSED, not re-derived. Projection lowering
 * receives `projectionDispatchRevision(...)`, an alias whose `languageVersion`
 * is rewritten to the legacy compatibility literal so v2 physical families
 * fingerprint unchanged. Asking that alias what version the author wrote is
 * always answered "v2", so a gate derived here would silently take the
 * pre-v5 branch for a v5 package -- observed as
 * `COMPILER_PHYSICAL_NAME_REUSE_INCOMPATIBLE`, because both the materialized
 * column and the retired parallel construct were then emitted.
 *
 * The default keeps direct callers (tests, the coverage gate) correct, since
 * they pass the real revision.
 */
export function lowerStorageTargetV1(
  packageRevision: NormalizedApplicationPackage,
  previousStorageTarget: StorageTargetPayloadV1 | null = null,
  materializedStateFields: boolean = languageHasMaterializedStateFields(
    packageRevision.languageVersion,
  ),
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
      const legalEntityFamily = resolvePinnedLegalEntityFamily(
        packageRevision.package.packageId,
        entity.entityId,
      );
      if (legalEntityFamily.status === 'undeclared') {
        throw new Error(
          `INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED: ${entity.entityId}`,
        );
      }
      const entityOwned =
        legalEntityFamily.status === 'classified' &&
        legalEntityFamily.classification === 'entityOwned';
      const factRule = resolvePinnedInventoryFactStorage(
        packageRevision.package.packageId,
        entity.entityId,
      );
      if (factRule && !entityOwned) {
        throw new Error(
          `INVENTORY_FACT_STORAGE_REQUIRES_ENTITY_OWNERSHIP: ${entity.entityId}`,
        );
      }
      const businessKeyScopeColumns = entityOwned
        ? ['tenant_id', 'environment_id', 'legal_entity_id']
        : ['tenant_id', 'environment_id'];
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
      const primaryKeyColumns = factRule
        ? [
            'tenant_id',
            'business_period',
            'environment_id',
            'legal_entity_id',
            'record_id',
          ]
        : entityOwned
          ? ['tenant_id', 'environment_id', 'legal_entity_id', 'record_id']
          : ['tenant_id', 'environment_id', 'record_id'];
      addMapping(
        mappings,
        'constraint',
        `${entity.entityId}#primary-key`,
        primaryKeyName,
        { columns: primaryKeyColumns },
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
          return lowerColumn(
            field,
            mappings,
            deferRequiredTightening,
            resolvePinnedInventoryStorageReference(
              entity.entityId,
              field.fieldId,
            )
              ? 'uuid'
              : undefined,
          );
        },
      );
      const resolveMatchFieldIds = new Set<string>(
        (queriesByEntity.get(entity.entityId) ?? []).flatMap((query) =>
          query.queryType === 'resolve'
            ? (query.resolveMatchKeys ?? []).map(
                (matchKey) => matchKey.field.targetId,
              )
            : [],
        ),
      );
      const foldedColumns = columns.flatMap(
        (column): StorageFoldedColumnTarget[] => {
          const field = (fieldsByEntity.get(entity.entityId) ?? []).find(
            (candidate) => candidate.fieldId === column.canonicalFieldId,
          );
          if (
            !field ||
            !isUnicodeFoldableField(field) ||
            (field.businessKey !== 'tenantEnvironmentCaseInsensitiveUnique' &&
              !field.searchable &&
              !resolveMatchFieldIds.has(field.fieldId))
          ) {
            return [];
          }
          const folded: StorageFoldedColumnTarget = {
            canonicalFieldId: field.fieldId,
            collation: 'C',
            foldFunction: 'north_star_module.nsm_unicode_case_fold_v1' as const,
            physicalName: physicalNameFor(
              'column',
              `${field.fieldId}/unicode-case-fold-v1`,
            ),
            postgresqlType: 'text',
            sourceColumn: column.physicalName,
            stored: true,
          };
          addMapping(
            mappings,
            'column',
            `${field.fieldId}#unicode-case-fold-v1`,
            folded.physicalName,
            folded,
          );
          return [folded];
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
      // From v5 the machine's state field is an ordinary column, lowered by
      // the `columns` map above like any other enumeration field, and this
      // parallel construct is retired. Emitting both registers two
      // incompatible shapes for one physical identifier and the compiler
      // refuses with `COMPILER_PHYSICAL_NAME_REUSE_INCOMPATIBLE` -- the
      // ruling's one-state-per-document claim, enforced by the compiler
      // itself rather than asserted in prose.
      const derivedStateFields = materializedStateFields
        ? []
        : (stateMachinesByEntity.get(entity.entityId) ?? [])
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
      const archiveExcludingPredicate = 'archived_at IS NULL';
      for (const column of columns) {
        const field = (fieldsByEntity.get(entity.entityId) ?? []).find(
          (candidate) => candidate.fieldId === column.canonicalFieldId,
        );
        const foldedColumn = foldedColumns.find(
          (candidate) => candidate.canonicalFieldId === column.canonicalFieldId,
        );
        if (field?.businessKey === 'tenantEnvironmentCaseInsensitiveUnique') {
          const physicalName = physicalNameFor(
            'constraint',
            `${column.canonicalFieldId}/tenant-environment-unique`,
          );
          const unique = {
            collation: 'unicodeCaseInsensitive' as const,
            columns: [...businessKeyScopeColumns, column.physicalName],
            normalization: 'unicodeCaseFold' as const,
            physicalName,
            predicate: archiveExcludingPredicate,
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
            predicate: archiveExcludingPredicate,
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
        if (
          foldedColumn &&
          !uniqueKeys.some((unique) =>
            unique.columns.includes(column.physicalName),
          )
        ) {
          const physicalName = physicalNameFor(
            'index',
            `${column.canonicalFieldId}/tenant-environment-folded-access`,
          );
          const index = {
            columnNames: [
              'tenant_id',
              'environment_id',
              foldedColumn.physicalName,
            ],
            indexKind: 'foldedAccess' as const,
            physicalName,
            predicate: null,
          };
          indexes.push(index);
          addMapping(
            mappings,
            'index',
            `${column.canonicalFieldId}#tenant-environment-folded-access`,
            physicalName,
            index,
          );
        }
        if (
          field &&
          resolveMatchFieldIds.has(field.fieldId) &&
          !isUnicodeFoldableField(field)
        ) {
          const physicalName = physicalNameFor(
            'index',
            `${column.canonicalFieldId}/tenant-environment-resolve-access`,
          );
          const index = {
            columnNames: [...businessKeyScopeColumns, column.physicalName],
            indexKind: 'resolveAccess' as const,
            physicalName,
            predicate: null,
          };
          indexes.push(index);
          addMapping(
            mappings,
            'index',
            `${column.canonicalFieldId}#tenant-environment-resolve-access`,
            physicalName,
            index,
          );
        }
      }
      const factStorage = factRule
        ? buildFactStorageTarget(
            packageRevision.package.packageId,
            entity.entityId,
            columns,
            physicalTableName,
            mappings,
          )
        : undefined;
      const legalEntityMaster = isPinnedLegalEntityMaster(
        packageRevision.package.packageId,
        entity.entityId,
      )
        ? buildLegalEntityMasterTarget(
            packageRevision.package.packageId,
            entity.entityId,
            columns,
            mappings,
          )
        : undefined;
      const periodLockRule = resolvePinnedInventoryPeriodLockStorage(
        entity.entityId,
      );
      const periodLock = periodLockRule
        ? buildPeriodLockStorageTarget(
            packageRevision.package.namespace,
            entity.entityId,
            columns,
            mappings,
            periodLockRule,
          )
        : undefined;
      if (factStorage) {
        indexes.push({
          columnNames: factStorage.stockHorizonIndex.columns,
          indexKind: 'stockHorizon',
          physicalName: factStorage.stockHorizonIndex.physicalName,
          predicate: null,
        });
      }
      if (legalEntityMaster) {
        indexes.push({
          columnNames: [...legalEntityMaster.defaultUniqueIndex.columns],
          indexKind: 'legalEntityDefaultUnique',
          physicalName: legalEntityMaster.defaultUniqueIndex.physicalName,
          predicate: legalEntityMaster.defaultUniqueIndex.predicate,
        });
      }
      if (periodLock) {
        indexes.push({
          columnNames: [...periodLock.scopeUniqueIndex.columns],
          indexKind: 'periodLockScopeUnique',
          physicalName: periodLock.scopeUniqueIndex.physicalName,
          predicate: null,
        });
      }
      return {
        archive: {
          archivedAtColumn: 'archived_at',
          defaultVisibility: 'excludeArchived',
          representation: 'nullableTimestamp',
        },
        ...(entityOwned
          ? {
              businessKeyScopeColumns: [
                'tenant_id',
                'environment_id',
                'legal_entity_id',
              ] as const,
            }
          : {}),
        ...(legalEntityMaster ? { legalEntityMaster } : {}),
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
        foldedColumns: foldedColumns.sort((left, right) =>
          compare(left.physicalName, right.physicalName),
        ),
        ...(factStorage ? { factStorage } : {}),
        indexes: indexes.sort((left, right) =>
          compare(left.physicalName, right.physicalName),
        ),
        lifecycle: entity.lifecycle,
        ...(entityOwned
          ? {
              legalEntity: {
                column: 'legal_entity_id' as const,
                familyClassification: 'entityOwned' as const,
                immutableAfterCreate: true as const,
                nullable: false as const,
                postgresqlType: 'uuid' as const,
                referencedFamilyId: 'legal_entity' as const,
              },
            }
          : {}),
        optimisticRevision: {
          column: 'revision',
          initialValue: '1',
          postgresqlType: 'bigint',
        },
        ...(periodLock ? { periodLock } : {}),
        physicalTableName,
        primaryKey: {
          columns: primaryKeyColumns,
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
  const factEntity = entities.find(
    (entity) => entity.factStorage !== undefined,
  );
  if (factEntity?.factStorage) {
    for (const itemEntity of entities) {
      const baseUnitColumns = itemEntity.columns.filter((column) =>
        isPinnedInventoryBaseUnitField(
          packageRevision.package.packageId,
          itemEntity.entityId,
          column.canonicalFieldId,
        ),
      );
      if (baseUnitColumns.length === 0) continue;
      if (baseUnitColumns.length !== 1) {
        throw new Error(
          `INVENTORY_BASE_UNIT_COLUMN_INVALID: ${itemEntity.entityId}`,
        );
      }
      const baseUnitColumn = baseUnitColumns[0]!;
      const physicalName = physicalNameFor(
        'constraint',
        `${baseUnitColumn.canonicalFieldId}/first-movement-binding`,
      );
      const check: StorageAbiFunctionCheckTarget = {
        checkKind: 'baseUnitBinding',
        itemIdColumn: itemEntity.recordIdentity.column,
        movementItemIdColumn: factEntity.factStorage.fieldColumns.itemId,
        movementRecordIdColumn: factEntity.recordIdentity.column,
        movementRecordedAtColumn:
          factEntity.factStorage.fieldColumns.recordedAt,
        movementTableName: factEntity.physicalTableName,
        movementUnitIdColumn: factEntity.factStorage.fieldColumns.unitId,
        physicalName,
        unitIdColumn: baseUnitColumn.physicalName,
      };
      itemEntity.abiFunctionChecks = [check];
      addMapping(
        mappings,
        'constraint',
        `${baseUnitColumn.canonicalFieldId}#first-movement-binding`,
        physicalName,
        check,
      );
    }
  }
  const relations: StorageRelationTarget[] = [];
  const registerRelation = (input: {
    archiveBehavior: StorageRelationTarget['archiveBehavior'];
    nullable: boolean;
    origin: 'declaredRelation' | 'field';
    ownership: StorageRelationTarget['ownership'];
    relationColumn: string;
    relationId: string;
    semantics: 'crossEntityAllowed' | 'sameEntity' | null;
    source: StorageEntityTarget;
    targetEntityId: string;
    targetLegalEntityScoped: boolean;
    targetRecordIdentityColumn: string;
  }): void => {
    const entityScoped =
      input.semantics === 'sameEntity' &&
      input.source.legalEntity !== undefined &&
      input.targetLegalEntityScoped;
    const sourceColumns = [
      'tenant_id',
      'environment_id',
      ...(entityScoped ? ['legal_entity_id'] : []),
      input.relationColumn,
    ];
    const targetColumns = [
      'tenant_id',
      'environment_id',
      ...(entityScoped ? ['legal_entity_id'] : []),
      input.targetRecordIdentityColumn,
    ];
    const physicalName = physicalNameFor(
      'constraint',
      `${input.relationId}/foreign-key`,
    );
    const targetShape: StorageRelationTarget = {
      archiveBehavior: input.archiveBehavior,
      foreignKey: {
        onDelete: 'restrict',
        onUpdate: 'restrict',
        physicalName,
        sourceColumns,
        targetColumns,
      },
      ownership: input.ownership,
      relationColumn: {
        nullable: input.nullable,
        ...(input.origin === 'field' ? { origin: 'field' as const } : {}),
        physicalName: input.relationColumn,
        postgresqlType: 'uuid',
      },
      relationId: input.relationId,
      sourceEntityId: input.source.entityId,
      targetEntityId: input.targetEntityId,
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
    if (input.origin === 'declaredRelation') {
      addMapping(
        mappings,
        'column',
        `${input.relationId}#target-record-id`,
        input.relationColumn,
        compatibilityShape,
      );
    }
    addMapping(
      mappings,
      'constraint',
      `${input.relationId}#foreign-key`,
      physicalName,
      compatibilityShape,
    );
    const relationIndexSuffix =
      input.origin === 'declaredRelation'
        ? 'tenant-environment-relation'
        : 'scoped-relation';
    const relationIndex = {
      columnNames: sourceColumns,
      indexKind: 'relation' as const,
      physicalName: physicalNameFor(
        'index',
        `${input.relationId}/${relationIndexSuffix}`,
      ),
      predicate: null,
    };
    input.source.indexes.push(relationIndex);
    input.source.indexes.sort((left, right) =>
      compare(left.physicalName, right.physicalName),
    );
    addMapping(
      mappings,
      'index',
      `${input.relationId}#${relationIndexSuffix}`,
      relationIndex.physicalName,
      relationIndex,
    );
    relations.push(targetShape);
  };

  for (const relation of packageRevision.relations) {
    const source = entityById.get(relation.sourceEntity.targetId);
    const target = entityById.get(relation.targetEntity.targetId);
    if (!source || !target) {
      throw new Error('validated relation target is missing');
    }
    const sourceFamily = resolvePinnedLegalEntityFamily(
      packageRevision.package.packageId,
      source.entityId,
    );
    const targetFamily = resolvePinnedLegalEntityFamily(
      packageRevision.package.packageId,
      target.entityId,
    );
    const semantics =
      sourceFamily.status === 'classified' &&
      targetFamily.status === 'classified'
        ? resolvePinnedLegalEntityRelationSemantics(
            sourceFamily.familyId,
            targetFamily.familyId,
          )
        : null;
    registerRelation({
      archiveBehavior: relation.archiveBehavior,
      nullable: !relation.required,
      origin: 'declaredRelation',
      ownership: relation.ownership,
      relationColumn: physicalNameFor(
        'column',
        `${relation.relationId}/target-record-id`,
      ),
      relationId: relation.relationId,
      semantics,
      source,
      targetEntityId: target.entityId,
      targetLegalEntityScoped: target.legalEntity !== undefined,
      targetRecordIdentityColumn: target.recordIdentity.column,
    });
  }

  for (const source of entities) {
    for (const column of source.columns) {
      const rule = resolvePinnedInventoryStorageReference(
        source.entityId,
        column.canonicalFieldId,
      );
      if (!rule) continue;
      const target = entities.find((candidate) => {
        const family = resolvePinnedLegalEntityFamily(
          packageRevision.package.packageId,
          candidate.entityId,
        );
        return (
          family.status === 'classified' &&
          family.familyId === rule.targetFamilyId
        );
      });
      registerRelation({
        archiveBehavior: 'restrict',
        nullable: !rule.required,
        origin: 'field',
        ownership: 'reference',
        relationColumn: column.physicalName,
        relationId: `${column.canonicalFieldId}#inventory-reference`,
        semantics: rule.semantics,
        source,
        targetEntityId:
          target?.entityId ??
          `${packageRevision.package.namespace}:entity.${rule.targetFamilyId}`,
        targetLegalEntityScoped: target?.legalEntity !== undefined,
        targetRecordIdentityColumn:
          target?.recordIdentity.column ?? 'record_id',
      });
    }
  }

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
    schemaVersion: entities.some((entity) => entity.factStorage !== undefined)
      ? STORAGE_TARGET_PAYLOAD_V3_VERSION
      : entities.some((entity) => entity.legalEntity !== undefined)
        ? STORAGE_TARGET_PAYLOAD_V2_VERSION
        : STORAGE_TARGET_PAYLOAD_VERSION,
  };
}

function buildPeriodLockStorageTarget(
  namespace: string,
  entityId: string,
  columns: readonly StorageColumnTarget[],
  mappings: PhysicalMappingRecord[],
  rule: NonNullable<ReturnType<typeof resolvePinnedInventoryPeriodLockStorage>>,
): NonNullable<StorageEntityTarget['periodLock']> {
  const closedThrough = columns.find((column) =>
    column.canonicalFieldId.endsWith(
      ':field.inventory_period_lock_closed_through',
    ),
  );
  if (!closedThrough) {
    throw new Error(
      `INVENTORY_PERIOD_LOCK_FIELD_REQUIRED: ${entityId}/closedThrough`,
    );
  }
  const physicalName = physicalNameFor(
    'index',
    `${entityId}/one-per-legal-entity`,
  );
  const scopeUniqueIndex = {
    columns: ['tenant_id', 'environment_id', 'legal_entity_id'] as const,
    physicalName,
  };
  const provisioningTriggerName = physicalNameFor(
    'trigger',
    `${entityId}/provision-on-legal-entity-insert`,
  );
  addMapping(
    mappings,
    'index',
    `${entityId}#one-per-legal-entity`,
    physicalName,
    scopeUniqueIndex,
  );
  addMapping(
    mappings,
    'trigger',
    `${entityId}#provision-on-legal-entity-insert`,
    provisioningTriggerName,
    { operation: 'AFTER INSERT' },
  );
  return {
    advanceOperationId: `${namespace}:operation.${rule.advanceOperationLocalId}`,
    closedThroughColumn: closedThrough.physicalName,
    provisioningTriggerName,
    reopenOperationId: `${namespace}:operation.${rule.reopenOperationLocalId}`,
    scopeUniqueIndex,
  };
}

function buildLegalEntityMasterTarget(
  packageId: string,
  entityId: string,
  columns: readonly StorageColumnTarget[],
  mappings: PhysicalMappingRecord[],
): NonNullable<StorageEntityTarget['legalEntityMaster']> {
  const byRole = new Map<string, StorageColumnTarget>();
  for (const column of columns) {
    const role = resolvePinnedLegalEntityMasterFieldRole(
      packageId,
      entityId,
      column.canonicalFieldId,
    );
    if (role) byRole.set(role, column);
  }
  const required = (role: string): StorageColumnTarget => {
    const column = byRole.get(role);
    if (!column) {
      throw new Error(
        `LEGAL_ENTITY_MASTER_FIELD_REQUIRED: ${entityId}/${role}`,
      );
    }
    return column;
  };
  const status = required('status');
  const activeStatusValue = status.fieldContract.enumOptionIds.find((option) =>
    option.endsWith('_active'),
  );
  if (!activeStatusValue) {
    throw new Error(`LEGAL_ENTITY_MASTER_ACTIVE_STATUS_REQUIRED: ${entityId}`);
  }
  const isDefault = required('isDefault');
  const defaultUniqueIndex = {
    columns: ['tenant_id', 'environment_id'] as ['tenant_id', 'environment_id'],
    physicalName: physicalNameFor('index', `${entityId}/one-active-default`),
    predicate: `${isDefault.physicalName} IS TRUE AND archived_at IS NULL`,
  };
  addMapping(
    mappings,
    'index',
    `${entityId}#one-active-default`,
    defaultUniqueIndex.physicalName,
    defaultUniqueIndex,
  );
  return {
    activeStatusValue,
    defaultUniqueIndex,
    fieldColumns: {
      code: required('code').physicalName,
      isDefault: isDefault.physicalName,
      name: required('name').physicalName,
      status: status.physicalName,
    },
    provisioning: 'oneDefaultPerTenantEnvironment',
  };
}

function buildFactStorageTarget(
  packageId: string,
  entityId: string,
  columns: readonly StorageColumnTarget[],
  physicalTableName: string,
  mappings: PhysicalMappingRecord[],
): StorageFactTarget {
  const byRole = new Map<string, StorageColumnTarget>();
  for (const column of columns) {
    const role = resolvePinnedInventoryMovementFieldRole(
      packageId,
      entityId,
      column.canonicalFieldId,
    );
    if (role) byRole.set(role, column);
  }
  const required = (role: string): StorageColumnTarget => {
    const column = byRole.get(role);
    if (!column) {
      throw new Error(
        `INVENTORY_FACT_STORAGE_FIELD_REQUIRED: ${entityId}/${role}`,
      );
    }
    return column;
  };
  const effectiveAt = required('effectiveAt');
  const fieldColumns = {
    itemId: required('itemId').physicalName,
    locationId: required('locationId').physicalName,
    postingRole: required('postingRole').physicalName,
    recordedAt: required('recordedAt').physicalName,
    sourceId: required('sourceId').physicalName,
    sourceLine: required('sourceLine').physicalName,
    sourceRevision: required('sourceRevision').physicalName,
    sourceType: required('sourceType').physicalName,
    unitId: required('unitId').physicalName,
  };
  const effectTuple = [
    fieldColumns.sourceType,
    fieldColumns.sourceId,
    fieldColumns.sourceLine,
    fieldColumns.sourceRevision,
    fieldColumns.postingRole,
  ];
  const businessPeriodCheckName = physicalNameFor(
    'constraint',
    `${entityId}/business-period-check`,
  );
  const effectIdentityUniqueName = physicalNameFor(
    'constraint',
    `${entityId}/effect-identity-unique`,
  );
  const companionTableName = physicalNameFor(
    'table',
    `${entityId}/companion/effect-identity`,
  );
  const companionPrimaryKeyName = physicalNameFor(
    'constraint',
    `${entityId}/companion/effect-identity/primary-key`,
  );
  const companionMovementUniqueName = physicalNameFor(
    'constraint',
    `${entityId}/companion/effect-identity/movement-unique`,
  );
  const companionForeignKeyName = physicalNameFor(
    'constraint',
    `${entityId}/companion/effect-identity/movement-foreign-key`,
  );
  const movementTriggerName = physicalNameFor(
    'trigger',
    `${entityId}/reject-mutation`,
  );
  const companionTriggerName = physicalNameFor(
    'trigger',
    `${entityId}/companion/effect-identity/reject-mutation`,
  );
  const reservationTriggerName = physicalNameFor(
    'trigger',
    `${entityId}/companion/effect-identity/reserve-on-insert`,
  );
  const stockHorizonIndexName = physicalNameFor(
    'index',
    `${entityId}/stock-horizon`,
  );
  const stockIdentityV1MemberChecks = [
    {
      column: fieldColumns.itemId,
      physicalName: physicalNameFor(
        'constraint',
        `${entityId}/stock-identity-v1/item-real-value`,
      ),
      rejectedSentinel: '00000000-0000-0000-0000-000000000000' as const,
    },
    {
      column: fieldColumns.locationId,
      physicalName: physicalNameFor(
        'constraint',
        `${entityId}/stock-identity-v1/location-real-value`,
      ),
      rejectedSentinel: '00000000-0000-0000-0000-000000000000' as const,
    },
  ];

  const partitioning = {
    keyColumns: ['tenant_id', 'business_period'] as const,
    kind: 'tenantBusinessPeriodHash' as const,
    partitions: Array.from({ length: 8 }, (_, remainder) => ({
      modulus: 8 as const,
      physicalTableName: physicalNameFor(
        'table',
        `${entityId}/partition/${String(remainder)}`,
      ),
      remainder,
    })),
  };

  for (const partition of partitioning.partitions) {
    addMapping(
      mappings,
      'table',
      `${entityId}#partition-${String(partition.remainder)}`,
      partition.physicalTableName,
      partition,
    );
  }
  addMapping(
    mappings,
    'table',
    `${entityId}#companion-effect-identity`,
    companionTableName,
    { owner: entityId },
  );
  for (const [canonicalId, physicalName, shape] of [
    [
      `${entityId}#business-period-check`,
      businessPeriodCheckName,
      { effectiveAt: effectiveAt.physicalName },
    ],
    [
      `${entityId}#effect-identity-unique`,
      effectIdentityUniqueName,
      { columns: effectTuple },
    ],
    [
      `${entityId}#companion-effect-identity-primary-key`,
      companionPrimaryKeyName,
      { columns: effectTuple },
    ],
    [
      `${entityId}#companion-effect-identity-movement-unique`,
      companionMovementUniqueName,
      { columns: ['record_id'] },
    ],
    [
      `${entityId}#companion-effect-identity-movement-foreign-key`,
      companionForeignKeyName,
      { columns: ['record_id', ...effectTuple] },
    ],
  ] as const) {
    addMapping(mappings, 'constraint', canonicalId, physicalName, shape);
  }
  addMapping(
    mappings,
    'index',
    `${entityId}#stock-horizon`,
    stockHorizonIndexName,
    { columns: [fieldColumns.itemId, fieldColumns.locationId] },
  );
  for (const check of stockIdentityV1MemberChecks) {
    addMapping(
      mappings,
      'constraint',
      `${entityId}#stock-identity-v1-real-${check.column}`,
      check.physicalName,
      check,
    );
  }
  addMapping(
    mappings,
    'trigger',
    `${entityId}#reject-mutation`,
    movementTriggerName,
    { operation: 'UPDATE OR DELETE' },
  );
  addMapping(
    mappings,
    'trigger',
    `${entityId}#companion-effect-identity-reserve-on-insert`,
    reservationTriggerName,
    { operation: 'AFTER INSERT' },
  );
  addMapping(
    mappings,
    'trigger',
    `${entityId}#companion-effect-identity-reject-mutation`,
    companionTriggerName,
    { operation: 'UPDATE OR DELETE' },
  );

  const companionColumns = [
    { name: 'tenant_id', postgresqlType: 'uuid' },
    { name: 'environment_id', postgresqlType: 'uuid' },
    { name: 'legal_entity_id', postgresqlType: 'uuid' },
    { name: 'business_period', postgresqlType: 'date' },
    { name: 'record_id', postgresqlType: 'uuid' },
    ...effectTuple.map((name) => ({
      name,
      postgresqlType: required(
        [...byRole.entries()].find(
          ([, column]) => column.physicalName === name,
        )?.[0] ?? '',
      ).postgresqlType,
    })),
  ];

  return {
    businessPeriod: {
      checkConstraintName: businessPeriodCheckName,
      column: 'business_period',
      effectiveAtColumn: effectiveAt.physicalName,
      postgresqlType: 'date',
    },
    companion: {
      columns: companionColumns,
      movementForeignKey: {
        physicalName: companionForeignKeyName,
        sourceColumns: [
          'tenant_id',
          'business_period',
          'environment_id',
          'legal_entity_id',
          'record_id',
          ...effectTuple,
        ],
        targetColumns: [
          'tenant_id',
          'business_period',
          'environment_id',
          'legal_entity_id',
          'record_id',
          ...effectTuple,
        ],
      },
      movementUnique: {
        columns: [
          'tenant_id',
          'environment_id',
          'legal_entity_id',
          'record_id',
        ],
        physicalName: companionMovementUniqueName,
      },
      physicalTableName: companionTableName,
      primaryKey: {
        columns: [
          'tenant_id',
          'environment_id',
          'legal_entity_id',
          ...effectTuple,
        ],
        physicalName: companionPrimaryKeyName,
      },
      reservationTriggerName,
      rejectMutationTriggerName: companionTriggerName,
    },
    effectIdentityUnique: {
      columns: [
        'tenant_id',
        'business_period',
        'environment_id',
        'legal_entity_id',
        'record_id',
        ...effectTuple,
      ],
      physicalName: effectIdentityUniqueName,
    },
    fieldColumns,
    mutability: 'appendOnly',
    partitioning,
    rejectMutationTriggerName: movementTriggerName,
    stockHorizonIndex: {
      columns: [
        'tenant_id',
        'environment_id',
        'legal_entity_id',
        fieldColumns.itemId,
        fieldColumns.locationId,
        effectiveAt.physicalName,
        fieldColumns.recordedAt,
      ],
      physicalName: stockHorizonIndexName,
    },
    stockIdentityV1MemberChecks,
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
  const legalEntityMaster = candidate.entities.find(
    (entity) => entity.legalEntityMaster !== undefined,
  );
  const newLegalEntityMasterTableElement =
    legalEntityMaster && !previousEntities.has(legalEntityMaster.entityId)
      ? element(
          'createTable',
          legalEntityMaster.entityId,
          null,
          legalEntityMaster.physicalTableName,
          [],
          'samePlan',
        )
      : null;
  if (newLegalEntityMasterTableElement && legalEntityMaster) {
    createdTableElementIds.set(
      legalEntityMaster.entityId,
      newLegalEntityMasterTableElement.elementId,
    );
  }
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
      const tableDependencies = entity.legalEntity
        ? [
            legalEntityMaster
              ? createdTableElementIds.get(legalEntityMaster.entityId)
              : undefined,
          ].filter((entry): entry is string => entry !== undefined)
        : [];
      const tableElement =
        entity.entityId === legalEntityMaster?.entityId &&
        newLegalEntityMasterTableElement
          ? newLegalEntityMasterTableElement
          : element(
              'createTable',
              entity.entityId,
              null,
              entity.physicalTableName,
              tableDependencies,
              'samePlan',
            );
      elements.push(tableElement);
      createdTableElementIds.set(entity.entityId, tableElement.elementId);
      const factDependencies: string[] = [];
      if (entity.factStorage) {
        const businessPeriodCheck = element(
          'addAbiFunctionCheck',
          entity.entityId,
          null,
          entity.factStorage.businessPeriod.checkConstraintName,
          [tableElement.elementId],
          'samePlan',
        );
        elements.push(businessPeriodCheck);
        const companion = element(
          'createCompanionTable',
          entity.entityId,
          null,
          entity.factStorage.companion.physicalTableName,
          [tableElement.elementId],
          'samePlan',
        );
        elements.push(companion);
        for (const partition of entity.factStorage.partitioning.partitions) {
          const partitionElement = element(
            'createPartition',
            entity.entityId,
            null,
            partition.physicalTableName,
            [tableElement.elementId, businessPeriodCheck.elementId],
            'samePlan',
          );
          elements.push(partitionElement);
          factDependencies.push(partitionElement.elementId);
        }
        elements.push(
          element(
            'createRejectMutationTrigger',
            entity.entityId,
            null,
            entity.factStorage.rejectMutationTriggerName,
            [tableElement.elementId],
            'samePlan',
          ),
          element(
            'createRejectMutationTrigger',
            entity.entityId,
            null,
            entity.factStorage.companion.rejectMutationTriggerName,
            [companion.elementId],
            'samePlan',
          ),
        );
      }
      for (const index of entity.indexes) {
        elements.push(
          element(
            'createIndex',
            entity.entityId,
            null,
            index.physicalName,
            [tableElement.elementId, ...factDependencies],
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
    const oldChecks = new Map(
      (oldEntity.checkConstraints ?? []).map((check) => [
        check.physicalName,
        check,
      ]),
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
      const sourceField = packageRevision.fields.find(
        (entry) => entry.fieldId === fieldId,
      )!;
      if (
        oldField &&
        oldField.shapeFingerprint !== field.shapeFingerprint &&
        !isAdditiveSearchMappingTransition(oldField, field) &&
        !isAdditiveEnumDomainTransition(oldField, field, sourceField)
      ) {
        return failureDiagnostic(
          'COMPILER_STORAGE_RETYPE_UNSUPPORTED',
          '$.fields.fieldType',
          fieldId,
        );
      }
      if (oldField) continue;
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
      const oldCheck = oldChecks.get(check.physicalName);
      if (oldCheck) {
        // The physical name derives from the field id alone, so a constraint
        // whose DEFINITION moved still matches by name. Matching by name only
        // is the gap `PUR-2c` measured: a widened option list compiled,
        // prepared and activated with zero elements, and the live CHECK kept
        // refusing the option the release advertised. Compare the definition.
        if (
          hashCanonical(
            `${HASH_DOMAINS.projectionSemantic}/storage-check-transition-shape`,
            oldCheck,
          ).digest ===
          hashCanonical(
            `${HASH_DOMAINS.projectionSemantic}/storage-check-transition-shape`,
            check,
          ).digest
        ) {
          continue;
        }
        if (widensEnumDomain(oldCheck, check)) {
          elements.push(
            element(
              'widenEnumDomain',
              entity.entityId,
              check.canonicalFieldId,
              check.physicalName,
              [],
              'existing',
            ),
          );
          continue;
        }
        // Any other definition change on a released constraint is refused.
        // The column predicate above already refuses every non-widening
        // option-list change, so this branch is a second, independent fence
        // for a check whose column somehow passed -- it fails closed.
        return failureDiagnostic(
          'COMPILER_STORAGE_RETYPE_UNSUPPORTED',
          '$.fields.fieldType',
          check.canonicalFieldId,
        );
      }
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
    const oldFoldedColumnNames = new Set(
      (oldEntity.foldedColumns ?? []).map((column) => column.physicalName),
    );
    for (const foldedColumn of entity.foldedColumns) {
      if (oldFoldedColumnNames.has(foldedColumn.physicalName)) continue;
      const addFoldedColumn = deferredGeneratedColumnElement(
        entity.entityId,
        foldedColumn.canonicalFieldId,
        foldedColumn.physicalName,
      );
      elements.push(addFoldedColumn);
      for (const index of entity.indexes.filter(
        (candidateIndex) =>
          (candidateIndex.indexKind === 'foldedAccess' &&
            candidateIndex.columnNames.includes(foldedColumn.physicalName)) ||
          (candidateIndex.indexKind === 'caseInsensitiveUnique' &&
            candidateIndex.columnNames.includes(foldedColumn.sourceColumn)),
      )) {
        if (
          oldEntity.indexes.some(
            (oldIndex) => oldIndex.physicalName === index.physicalName,
          )
        ) {
          continue;
        }
        elements.push(
          element(
            'createIndex',
            entity.entityId,
            foldedColumn.canonicalFieldId,
            index.physicalName,
            [addFoldedColumn.elementId],
            'existing',
          ),
        );
      }
    }
  }

  for (const entity of candidate.entities) {
    const previousEntity = previousEntities.get(entity.entityId);
    const previousChecks = new Set(
      (previousEntity?.abiFunctionChecks ?? []).map(
        (check) => check.physicalName,
      ),
    );
    for (const check of entity.abiFunctionChecks ?? []) {
      if (previousChecks.has(check.physicalName)) continue;
      const movementEntity = candidate.entities.find(
        (candidateEntity) =>
          candidateEntity.physicalTableName === check.movementTableName,
      );
      const dependencies = [
        createdTableElementIds.get(entity.entityId),
        movementEntity
          ? createdTableElementIds.get(movementEntity.entityId)
          : undefined,
      ].filter((entry): entry is string => entry !== undefined);
      elements.push(
        element(
          'addAbiFunctionCheck',
          entity.entityId,
          null,
          check.physicalName,
          dependencies,
          previousEntity ? 'existing' : 'samePlan',
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
      const relaxed = relaxesRelationRequiredness(previousRelation, relation);
      if (!relaxed && !sameRelationShape(previousRelation, relation)) {
        return failureDiagnostic(
          'COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED',
          '$.relations',
          relation.relationId,
        );
      }
      if (relaxed) {
        elements.push(
          element(
            'relaxNotNull',
            relation.relationId,
            null,
            relation.relationColumn.physicalName,
            [],
            'existing',
          ),
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

function isAdditiveSearchMappingTransition(
  previous: StorageColumnTarget,
  candidate: StorageColumnTarget,
): boolean {
  if (
    previous.searchMapping !== 'none' ||
    candidate.searchMapping !== 'normalizedTextIndex'
  ) {
    return false;
  }
  const comparableShape = (column: StorageColumnTarget) =>
    Object.fromEntries(
      Object.entries(column).filter(
        ([key]) => key !== 'searchMapping' && key !== 'shapeFingerprint',
      ),
    );
  const previousShape = comparableShape(previous);
  const candidateShape = comparableShape(candidate);
  return (
    hashCanonical(
      `${HASH_DOMAINS.projectionSemantic}/storage-column-transition-shape`,
      previousShape,
    ).digest ===
    hashCanonical(
      `${HASH_DOMAINS.projectionSemantic}/storage-column-transition-shape`,
      candidateShape,
    ).digest
  );
}

/**
 * A released enum field whose option list grew, and NOTHING ELSE moved.
 *
 * `lowerColumn` hashes `shapeFingerprint` over `fieldType` wholesale, and an
 * enum's `fieldType` carries its option RECORDS -- id, label, orderKey -- so
 * every option-list change presents to the planner as a retype. The physical
 * column is `text` before and after.
 *
 * "Nothing else moved" is tested EXACTLY rather than by exclusion. Round 1
 * compared the two lowered columns with the option ids and the fingerprint
 * removed, which let a widening that ALSO relabelled or reordered an existing
 * option through, because labels and orderKeys exist only inside the excluded
 * fingerprint (round-1 finding). Instead: take the candidate's SOURCE field,
 * drop every option record whose id the previous release did not carry, and
 * fingerprint what remains the way `lowerColumn` would have. It must equal the
 * previous release's stored fingerprint byte for byte. That admits exactly one
 * kind of change -- new option records appended -- and refuses a changed
 * label, a changed orderKey, a reordering, a narrowing, a rebinding, a
 * relabelling with an equal id set, and any other column property, all under
 * `COMPILER_STORAGE_RETYPE_UNSUPPORTED`.
 *
 * A previous target lowered before field contracts existed carries no
 * `fieldContract`; such a pair is not a widening this predicate can judge and
 * it returns false rather than guessing.
 */
function isAdditiveEnumDomainTransition(
  previous: StorageColumnTarget,
  candidate: StorageColumnTarget,
  candidateField: Field,
): boolean {
  if (
    !Object.hasOwn(previous, 'fieldContract') ||
    previous.fieldContract.fieldKind !== 'enumFieldType' ||
    candidateField.fieldType.kind !== 'enumFieldType'
  ) {
    return false;
  }
  const previousIds = previous.fieldContract.enumOptionIds;
  const candidateIds = candidateField.fieldType.options
    .map((option) => option.optionId)
    .sort(compare);
  if (!isStrictOptionSuperset(previousIds, candidateIds)) return false;
  const previousSet = new Set(previousIds);
  const withoutNewOptions: Field = {
    ...candidateField,
    fieldType: {
      ...candidateField.fieldType,
      options: candidateField.fieldType.options.filter((option) =>
        previousSet.has(option.optionId),
      ),
    },
  };
  return (
    columnShapeFingerprint(
      withoutNewOptions,
      candidate.requiredAfterTightening,
    ) === previous.shapeFingerprint
  );
}

/**
 * The same monotonic-superset rule, stated on the enum-domain CHECK itself.
 *
 * **Exported because the provider imports it**, for the reason
 * `relaxesRelationRequiredness` gives above: the materializer must recognise
 * the same widening when two accounted live roots disagree about one
 * constraint's option list, and a second copy of this rule is the drift that
 * already happened once. Both members must be the SAME constraint -- same
 * field, same physical name, same kind, both `NOT VALID` -- and the candidate's
 * option set must strictly contain the previous one.
 */
export function widensEnumDomain(
  previous: StorageCheckConstraintTarget,
  candidate: StorageCheckConstraintTarget,
): boolean {
  return (
    previous.canonicalFieldId === candidate.canonicalFieldId &&
    previous.physicalName === candidate.physicalName &&
    previous.checkKind === 'enumDomain' &&
    candidate.checkKind === 'enumDomain' &&
    previous.validated === false &&
    candidate.validated === false &&
    isStrictOptionSuperset(previous.enumOptionIds, candidate.enumOptionIds)
  );
}

function isStrictOptionSuperset(
  previous: readonly string[],
  candidate: readonly string[],
): boolean {
  const previousSet = new Set(previous);
  const candidateSet = new Set(candidate);
  if (
    previousSet.size !== previous.length ||
    candidateSet.size !== candidate.length
  ) {
    return false;
  }
  if (candidateSet.size <= previousSet.size) return false;
  for (const optionId of previousSet) {
    if (!candidateSet.has(optionId)) return false;
  }
  return true;
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
      case 'createPartition':
      case 'createCompanionTable':
        return {
          dataEffect: 'catalogOnly',
          operationalRisk: 'boundedCatalogLock',
          preparationValidity: 'preApprovalInert',
          semanticEffect: 'additive',
        };
      case 'createRejectMutationTrigger':
      case 'addAbiFunctionCheck':
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
      case 'relaxNotNull':
        // `ALTER COLUMN ... DROP NOT NULL` rewrites no rows and reads none, so
        // it is catalogOnly rather than a scan; it takes a brief ACCESS
        // EXCLUSIVE lock, so the risk is the same bounded catalog lock that
        // `addColumn` carries. It is `preApprovalInert` for the property that
        // separates inert from in-attempt everywhere else in this planner: it
        // can never reject a write. Every `inAttemptOnly` kind either rejects
        // old writes (`oldWrite: 'mayReject'`) or mutates rows (`backfill`);
        // relaxation does neither.
        return {
          dataEffect: 'catalogOnly',
          operationalRisk: 'boundedCatalogLock',
          preparationValidity: 'preApprovalInert',
          semanticEffect: 'additive',
        };
      case 'tightenNotNull':
        return {
          dataEffect: 'dataScan',
          operationalRisk: 'longRunning',
          preparationValidity: 'deferredTightening',
          semanticEffect: 'tightening',
        };
      case 'widenEnumDomain':
        // The enum-domain CHECK is replaced by a superset of itself, NOT VALID
        // before and after, so PostgreSQL scans no rows and rewrites none:
        // catalogOnly. The replacement is one `ALTER TABLE ... DROP CONSTRAINT,
        // ADD CONSTRAINT` statement under ACCESS EXCLUSIVE, measured at
        // milliseconds against 200k rows -- the same bounded catalog lock as
        // `addColumn`. It is `preApprovalInert` by the planner's own rule: it
        // can never reject a write, because every value the old constraint
        // admitted is admitted by the new one.
        return {
          dataEffect: 'catalogOnly',
          operationalRisk: 'boundedCatalogLock',
          preparationValidity: 'preApprovalInert',
          semanticEffect: 'additive',
        };
    }
  })();
  const base = STORAGE_COMPATIBILITY_MATRIX[kind];
  const coexistence =
    (kind === 'createIndex' ||
      kind === 'addForeignKey' ||
      kind === 'addAbiFunctionCheck' ||
      kind === 'createRejectMutationTrigger') &&
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
      : coexistence.newRead === 'requiresReadFallback' ||
          coexistence.oldRead === 'requiresReadFallback'
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
    trigger: 'nsm_g_',
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

/**
 * The renderer allowlist, and it is an ALLOWLIST rather than a denylist since
 * this packet -- which is the correction, not the original design.
 *
 * It used to name six destructive kinds and admit everything else. That fails
 * OPEN, and it was already failing open before this packet: `rendererStatement`
 * casts `{ kind: element.kind }` into `StorageRendererStatement`, a union that
 * carries only seven of the element kinds, so `backfill`, `duplicateScan` and
 * `tightenNotNull` reached this function as values outside its own declared
 * type and were admitted by falling through the denylist. Adding `relaxNotNull`
 * -- an operation whose entire purpose is to REMOVE an enforcement constraint
 * -- to that fail-open set is what made the standing defect worth closing here.
 *
 * The admitted set is DERIVED from `STORAGE_COMPATIBILITY_MATRIX`'s keys rather
 * than restated. That object is a `Record<StorageTransitionElementKind, ...>`,
 * so TypeScript forces a new element kind into it, and the allowlist follows
 * for free. A hand-maintained second list is the `sameRelationShape` defect
 * this packet already had to correct once; it is not reintroduced here.
 *
 * Every genuinely destructive statement kind -- `dropBusinessObject`,
 * `truncateTable`, `onDeleteCascade`, `removePartition`, `deleteCapableRule`,
 * `deleteCapableTrigger` -- is by construction NOT an element kind, so each is
 * refused exactly as before. What changes is that an unrecognised kind is now
 * refused too, instead of being waved through.
 */
export function validateStorageRendererStatements(
  statements: readonly StorageRendererStatement[],
): CompilerDiagnostic[] {
  const admitted: ReadonlySet<string> = new Set(
    Object.keys(STORAGE_COMPATIBILITY_MATRIX),
  );
  return statements.flatMap((statement, index) =>
    admitted.has(statement.kind)
      ? []
      : [
          compilerDiagnostic(
            'COMPILER_DESTRUCTIVE_STORAGE_DDL_UNSUPPORTED',
            'postLoweringValidation',
            `$.renderer.statements[${index}]`,
            statement.kind,
            index,
          ),
        ],
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

function isUnicodeFoldableField(field: Field): boolean {
  return (
    field.fieldType.kind === 'textFieldType' ||
    field.fieldType.kind === 'enumFieldType'
  );
}

function lowerColumn(
  field: Field,
  mappings: PhysicalMappingRecord[],
  deferRequiredTightening: boolean,
  postgresqlTypeOverride?: string,
): StorageColumnTarget {
  const physicalName = physicalNameFor('column', field.fieldId);
  const postgresqlType =
    postgresqlTypeOverride ?? postgresqlTypeFor(field.fieldType);
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
    shapeFingerprint: columnShapeFingerprint(field, deferRequiredTightening),
  };
  addMapping(mappings, 'column', field.fieldId, physicalName, value);
  return value;
}

/**
 * The column fingerprint, over the FULL field -- `fieldType` wholesale, so an
 * enum's option records (id, label, orderKey) are all inside it. Factored out
 * of `lowerColumn` so `isAdditiveEnumDomainTransition` can recompute what a
 * candidate field would have fingerprinted as WITHOUT its new options and
 * compare that against the previous release's stored fingerprint exactly.
 */
function columnShapeFingerprint(
  field: Field,
  deferRequiredTightening: boolean,
): string {
  const defaultSemantics =
    field.defaultSemantics ??
    (field.presence === 'optional' ? 'nullable' : 'none');
  return hashCanonical(`${HASH_DOMAINS.projectionSemantic}/storage-column`, {
    businessKey: field.businessKey ?? 'none',
    collation: field.collation ?? 'binary',
    defaultSemantics,
    defaultValue: field.defaultValue ?? null,
    fieldType: field.fieldType,
    nullable: field.presence !== 'required' || deferRequiredTightening,
    presence: field.presence,
    requiredAfterTightening: deferRequiredTightening,
    searchable: field.searchable,
  }).digest;
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

function deferredGeneratedColumnElement(
  subjectId: string,
  fieldId: string,
  physicalObjectName: string,
): StorageTransitionElement {
  const base = element(
    'addColumn',
    subjectId,
    fieldId,
    physicalObjectName,
    [],
    'existing',
  );
  return {
    ...base,
    classification: {
      dataEffect: 'rowMutation',
      operationalRisk: 'onlineStrategyRequired',
      preparationValidity: 'deferredOnlineFamily',
      semanticEffect: 'additive',
    },
    coexistence: {
      admission: 'deferred',
      newRead: 'requiresReadFallback',
      newWrite: 'compatible',
      oldRead: 'compatible',
      oldWrite: 'compatible',
    },
    coexistenceImpact: 'requiresReadFallback',
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

/**
 * A relation is RELAXED when the previous release carried it as required, the
 * candidate carries it as optional, and NOTHING ELSE about it moved.
 * `NOT NULL` -> `NULL` is a widening DDL: it rewrites no rows, cannot reject a
 * write that used to succeed, and leaves every row that already exists valid.
 * It is the only direction of requiredness this planner takes.
 *
 * **This compares the WHOLE relation, not a projection of it, and that is a
 * correction rather than a preference.** The first version delegated to
 * `sameRelationShape`, whose `physicalShape` is a HAND-MAINTAINED SUBSET that
 * omits `archiveBehavior` -- deliberately, as a legacy bridge for roots that
 * predate the property. Reusing it made this carve-out inherit the omission, so
 * `required + archiveBehavior: 'restrict'` -> `optional + 'retainReference'`
 * was ADMITTED as a pure widening, and the provider then refused the same
 * release at PREPARE with `LIVE_SET_SHAPE_CONFLICT`. The comment that stood
 * here claimed a future property would fail closed by construction; against a
 * hand-maintained subset that claim was FALSE, because a new property is
 * omitted from the subset too. Comparing the whole object makes it true.
 *
 * The legacy `archiveBehavior` tolerance is therefore stated EXPLICITLY and
 * symmetrically instead of being inherited: when both roots declare it they
 * must agree, and only when one omits it entirely is it dropped from both.
 *
 * **This function is exported and the provider imports it**, because two copies
 * of this rule already drifted once -- the provider's copy was corrected while
 * this one was not, and the compiler then accepted a release its own
 * materializer refuses. One authority is the fix; a second corrected copy is
 * the same defect waiting.
 *
 * `origin: 'field'` relations are excluded, and that exclusion is a
 * correctness boundary rather than caution. Their physical column is an
 * ORDINARY ENTITY COLUMN -- `createManagedTable` filters them out of the
 * relation columns it renders and emits them from `entity.columns`, whose own
 * `nullable` governs the `NOT NULL`. Planning a relaxation from the relation
 * side would therefore drop a constraint on an existing tenant that a FRESH
 * install of the very same release still creates as `NOT NULL`: one release,
 * two physical shapes, and no gate between them. Requiredness for those columns
 * has to move through the column path, which refuses it today with
 * `COMPILER_STORAGE_RETYPE_UNSUPPORTED`.
 */
export function relaxesRelationRequiredness(
  previous: StorageRelationTarget,
  candidate: StorageRelationTarget,
): boolean {
  if (previous.relationColumn.nullable) return false;
  if (!candidate.relationColumn.nullable) return false;
  if (
    previous.relationColumn.origin === 'field' ||
    candidate.relationColumn.origin === 'field'
  ) {
    return false;
  }
  const bridgeLegacyArchiveBehavior =
    !Object.hasOwn(previous, 'archiveBehavior') ||
    !Object.hasOwn(candidate, 'archiveBehavior');
  const comparable = (relation: StorageRelationTarget) => {
    if (!bridgeLegacyArchiveBehavior) return relation;
    const { archiveBehavior: _archiveBehavior, ...rest } = relation;
    void _archiveBehavior;
    return rest;
  };
  const widened: StorageRelationTarget = {
    ...previous,
    relationColumn: { ...previous.relationColumn, nullable: true },
  };
  return (
    hashCanonical(
      `${HASH_DOMAINS.projectionSemantic}/storage-relation-relaxation`,
      comparable(widened),
    ).digest ===
    hashCanonical(
      `${HASH_DOMAINS.projectionSemantic}/storage-relation-relaxation`,
      comparable(candidate),
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
