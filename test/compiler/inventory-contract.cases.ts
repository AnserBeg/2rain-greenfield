import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  type CompileSuccess,
  type CompilerInput,
} from '../../packages/compiler/src/index.js';
import {
  compileInventoryContract,
  validateInventoryBaseUnitChange,
  validateInventoryMovementCandidate,
  type CompiledInventoryContractV1,
  type InventoryContractDiagnostic,
  type InventoryMovementCandidateV1,
} from '../../packages/compiler/src/conformance.js';
import {
  INVENTORY_CONTRACT_V1,
  INVENTORY_FACT_STORAGE_V1,
  INVENTORY_PERIOD_LOCK_STORAGE_V1,
  INVENTORY_STORAGE_REFERENCES_V1,
  LEGAL_ENTITY_FAMILY_MAP_V1,
  LEGAL_ENTITY_RELATION_SEMANTICS_V1,
  inventoryModuleDefinition,
} from '../../packages/domain/src/inventory/index.js';
import { partyModuleDefinition } from '../../packages/domain/src/party/definition.js';

interface MutableInventoryContract {
  authoritativeDependencies: {
    accessPlan: Array<Record<string, unknown>>;
    dependencies: Array<Record<string, unknown>>;
  };
  compiledArtifacts: Array<Record<string, unknown>>;
  configuration: {
    dials: Record<string, unknown>;
  };
  legalEntity: {
    families: Array<Record<string, unknown>>;
    relations: Array<Record<string, unknown>>;
  };
  movement: {
    fields: Array<Record<string, unknown>>;
  };
  stockDimensionSet: {
    v1: Record<string, unknown>;
  };
}

type InventoryContractCase = (name: string, run: () => void) => void;

export function registerInventoryContractCases(
  register: InventoryContractCase,
): void {
  register(
    'inventory fact storage lowers to payload v3 with compiled partitions and an append-only companion',
    () => {
      assert.deepEqual(INVENTORY_FACT_STORAGE_V1, [
        {
          familyId: 'inventory_movement',
          mutability: 'appendOnly',
          partitionBy: 'tenantBusinessPeriod',
        },
      ]);
      assert.equal(INVENTORY_STORAGE_REFERENCES_V1.length, 5);
      assert.deepEqual(INVENTORY_PERIOD_LOCK_STORAGE_V1, {
        advanceOperationLocalId: 'advance_period_lock',
        familyId: 'inventory_period_lock',
        reopenOperationLocalId: 'reopen_period',
        scope: 'onePerLegalEntity',
      });
      const compiled = mustCompileModule(inventoryModuleDefinition());
      const target = projectionPayload<{
        entities: Array<{
          consumerWriterRoots: { writerOperationIds: string[] };
          entityId: string;
          factStorage?: {
            businessPeriod: {
              column: string;
              effectiveAtColumn: string;
            };
            companion: {
              physicalTableName: string;
              reservationTriggerName: string;
            };
            mutability: string;
            partitioning: {
              keyColumns: string[];
              kind: string;
              partitions: Array<{ modulus: number; remainder: number }>;
            };
          };
          indexes: Array<{
            columnNames: string[];
            indexKind: string;
            physicalName: string;
            predicate: string | null;
          }>;
          legalEntity?: { column: string };
          legalEntityMaster?: {
            defaultUniqueIndex: {
              columns: string[];
              physicalName: string;
              predicate: string;
            };
            provisioning: string;
          };
          periodLock?: {
            advanceOperationId: string;
            provisioningTriggerName: string;
            reopenOperationId: string;
            scopeUniqueIndex: { columns: string[] };
          };
          physicalTableName: string;
          primaryKey: { columns: string[] };
        }>;
        relations: Array<{
          foreignKey: { sourceColumns: string[]; targetColumns: string[] };
          relationColumn: { origin?: string };
          sourceEntityId: string;
          targetEntityId: string;
        }>;
        schemaVersion: string;
      }>(compiled, PROJECTION_FAMILY_IDS.storageTarget);
      assert.equal(target.schemaVersion, 'northstar.storage-target-payload/v3');
      const movement = target.entities.find((entity) =>
        entity.entityId.endsWith(':entity.inventory_movement'),
      );
      assert.ok(movement?.factStorage);
      assert.deepEqual(movement.primaryKey.columns, [
        'tenant_id',
        'business_period',
        'environment_id',
        'legal_entity_id',
        'record_id',
      ]);
      assert.deepEqual(movement.consumerWriterRoots.writerOperationIds, []);
      assert.equal(movement.factStorage.mutability, 'appendOnly');
      assert.equal(
        movement.factStorage.partitioning.kind,
        'tenantBusinessPeriodHash',
      );
      assert.deepEqual(movement.factStorage.partitioning.keyColumns, [
        'tenant_id',
        'business_period',
      ]);
      assert.deepEqual(
        movement.factStorage.partitioning.partitions.map(
          ({ modulus, remainder }) => ({ modulus, remainder }),
        ),
        Array.from({ length: 8 }, (_, remainder) => ({
          modulus: 8,
          remainder,
        })),
      );
      assert.match(
        movement.factStorage.companion.physicalTableName,
        /^nsm_t_[a-z2-7]{52}$/u,
      );
      assert.match(
        movement.factStorage.companion.reservationTriggerName,
        /^nsm_g_[a-z2-7]{52}$/u,
      );
      const periodLock = target.entities.find((entity) =>
        entity.entityId.endsWith(':entity.inventory_period_lock'),
      );
      assert.ok(periodLock?.periodLock);
      assert.deepEqual(periodLock.primaryKey.columns, [
        'tenant_id',
        'environment_id',
        'legal_entity_id',
        'record_id',
      ]);
      assert.deepEqual(periodLock.periodLock.scopeUniqueIndex.columns, [
        'tenant_id',
        'environment_id',
        'legal_entity_id',
      ]);
      assert.equal(
        periodLock.consumerWriterRoots.writerOperationIds.includes(
          'northstar.inventory:operation.inventory_period_lock_create',
        ),
        false,
      );
      assert.equal(
        target.relations.filter(
          (relation) =>
            relation.foreignKey.sourceColumns.includes('legal_entity_id') &&
            relation.foreignKey.targetColumns.includes('legal_entity_id'),
        ).length,
        3,
      );
      const legalEntity = target.entities.find((entity) =>
        entity.entityId.endsWith(':entity.legal_entity'),
      );
      assert.equal(
        legalEntity?.legalEntityMaster?.provisioning,
        'oneDefaultPerTenantEnvironment',
      );
      assert.ok(legalEntity);
      const declaredDefaultIndex =
        legalEntity.legalEntityMaster?.defaultUniqueIndex;
      assert.ok(declaredDefaultIndex);
      assert.deepEqual(declaredDefaultIndex.columns, [
        'tenant_id',
        'environment_id',
      ]);
      assert.match(
        declaredDefaultIndex.predicate,
        /^nsm_c_[a-z2-7]{52} IS TRUE AND archived_at IS NULL$/u,
      );
      assert.deepEqual(
        legalEntity.indexes.find(
          (index) => index.indexKind === 'legalEntityDefaultUnique',
        ),
        {
          columnNames: ['tenant_id', 'environment_id'],
          indexKind: 'legalEntityDefaultUnique',
          physicalName: declaredDefaultIndex.physicalName,
          predicate: declaredDefaultIndex.predicate,
        },
      );
      const invalid = structuredClone(inventoryModuleDefinition()) as {
        operations: Array<Record<string, unknown>>;
      };
      const transactionUpdate = invalid.operations.find(
        (operation) =>
          operation.operationId ===
          'northstar.inventory:operation.inventory_transaction_update',
      );
      assert.ok(transactionUpdate);
      invalid.operations.push({
        ...(replaceExactString(
          transactionUpdate,
          'northstar.inventory:entity.inventory_transaction',
          'northstar.inventory:entity.inventory_movement',
        ) as Record<string, unknown>),
        operationId:
          'northstar.inventory:operation.inventory_movement_update_regression',
      });
      const rejected = compileApplication(moduleInput(invalid));
      assert.equal(rejected.status, 'failed');
      if (rejected.status === 'failed') {
        assert.equal(
          rejected.diagnostics.some(
            (diagnostic) =>
              diagnostic.code ===
                'COMPILER_DESTRUCTIVE_OPERATION_UNSUPPORTED' &&
              diagnostic.subjectId ===
                'northstar.inventory:entity.inventory_movement',
          ),
          true,
        );
      }
    },
  );

  register(
    'inventory declarations compile to one deterministic quantity-only contract release',
    () => {
      const first = mustCompile();
      const second = mustCompile();
      assert.equal(first.releaseRoot, second.releaseRoot);
      assert.deepEqual(first.canonicalBytes, second.canonicalBytes);

      const contract = first.release.contract;
      const stock = contract.stockDimensionSet as {
        dimensions: string[];
        setId: string;
      };
      const movement = contract.movement as {
        fields: Array<{
          fieldId: string;
          semantic: string;
          valueShape?: Record<string, unknown>;
        }>;
        kind: string;
        updatePath: string;
      };
      const dependencies = contract.authoritativeDependencies as {
        dependencies: Array<{ access: string; dependencyId: string }>;
        exhaustiveByConstruction: boolean;
        undeclaredAccess: string;
      };

      assert.deepEqual(stock, {
        dimensions: ['legalEntityId', 'itemId', 'locationId'],
        extension: {
          addition: 'governedVersionedEvent',
          reBaselineOperationId: 'northstar.inventory:operation.re_baseline',
          removal: 'unsupported',
          unspecifiedFromVersion: 2,
        },
        setId: 'northstar.stock-dimension-set/v1',
        v1: {
          allowedVersions: ['v1'],
          membersRequiredAtPosting: true,
          unspecifiedMembers: 'structurallyUnreachable',
        },
      });
      assert.equal(movement.kind, 'quantityOnlyMovement');
      assert.equal(movement.updatePath, 'none');
      assert.deepEqual(
        movement.fields.map((field) => [field.fieldId, field.semantic]),
        [
          ['movementId', 'identifier'],
          ['stockDimensionSetVersion', 'stockDimensionSetVersion'],
          ['quantityDelta', 'quantity'],
          ['unitId', 'unit'],
          ['effectiveAt', 'instant'],
          ['recordedAt', 'instant'],
          ['sourceType', 'sourceType'],
          ['sourceId', 'identifier'],
          ['sourceLine', 'sourceLine'],
          ['postingRole', 'postingRole'],
        ],
      );
      assert.deepEqual(
        movement.fields.find((field) => field.fieldId === 'quantityDelta')
          ?.valueShape,
        {
          precision: 38,
          representation: 'canonicalDecimalStringV2',
          scale: 18,
          signed: true,
          unitFieldId: 'unitId',
        },
      );
      assert.equal(dependencies.exhaustiveByConstruction, true);
      assert.equal(dependencies.undeclaredAccess, 'compileFailure');
      assert.equal(dependencies.dependencies.length, 30);
      assert.deepEqual(contract.legalEntity, INVENTORY_CONTRACT_V1.legalEntity);

      const golden = JSON.parse(
        readFileSync(
          'test/compiler/inventory-contract.release.golden.json',
          'utf8',
        ),
      ) as unknown;
      assert.deepEqual(releaseSummary(first), golden);
    },
  );

  register(
    'the compiled movement entity is bound to the quantity-only movement contract',
    () => {
      const withMoney = structuredClone(inventoryModuleDefinition()) as {
        fields: Array<Record<string, unknown>>;
      };
      const quantity = withMoney.fields.find((field) =>
        String(field.fieldId).endsWith(
          ':field.inventory_movement_quantity_delta',
        ),
      );
      assert.ok(quantity);
      withMoney.fields.push({
        ...structuredClone(quantity),
        fieldId: 'northstar.inventory:field.inventory_movement_unit_cost',
        label: 'Unit cost',
        orderKey: 170,
      });
      const moneyResult = compileApplication(moduleInput(withMoney));
      assert.equal(moneyResult.status, 'failed');
      assert.equal(
        moneyResult.diagnostics.some(
          ({ code, subjectId }) =>
            code === 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN' &&
            subjectId ===
              'northstar.inventory:field.inventory_movement_unit_cost',
        ),
        true,
      );

      const withoutQuantity = inventoryDefinitionWithoutMovementField(
        'inventory_movement_quantity_delta',
      );
      const quantityResult = compileApplication(moduleInput(withoutQuantity));
      assert.equal(quantityResult.status, 'failed');
      assert.equal(
        quantityResult.diagnostics.some(
          ({ code, subjectId }) =>
            code === 'INVENTORY_CONTRACT_INVALID' &&
            subjectId ===
              'northstar.inventory:field.inventory_movement_quantity_delta',
        ),
        true,
      );

      const withoutVersion = inventoryDefinitionWithoutMovementField(
        'inventory_movement_stock_dimension_set_version',
      );
      const versionResult = compileApplication(moduleInput(withoutVersion));
      assert.equal(versionResult.status, 'failed');
      assert.equal(
        versionResult.diagnostics.some(
          ({ code, subjectId }) =>
            code === 'INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED' &&
            subjectId ===
              'northstar.inventory:field.inventory_movement_stock_dimension_set_version',
        ),
        true,
      );

      const withRenamedVersion = structuredClone(
        inventoryModuleDefinition(),
      ) as {
        fields: Array<{
          fieldId: string;
          fieldType: { options?: Array<{ optionId: string }> };
        }>;
      };
      const versionField = withRenamedVersion.fields.find((field) =>
        field.fieldId.endsWith(
          ':field.inventory_movement_stock_dimension_set_version',
        ),
      );
      assert.ok(versionField?.fieldType.options?.[0]);
      versionField.fieldType.options[0].optionId =
        'northstar.inventory:option.stock_dimension_set_version_v2';
      const renamedVersionResult = compileApplication(
        moduleInput(withRenamedVersion),
      );
      assert.equal(renamedVersionResult.status, 'failed');
      assert.equal(
        renamedVersionResult.diagnostics.some(
          ({ code, subjectId }) =>
            code === 'INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED' &&
            subjectId ===
              'northstar.inventory:field.inventory_movement_stock_dimension_set_version',
        ),
        true,
      );
    },
  );

  register(
    'period locks expose only the named advance and reopen mutation authority',
    () => {
      const definition = structuredClone(inventoryModuleDefinition()) as Record<
        string,
        unknown
      >;
      const operations = definition.operations as Array<
        Record<string, unknown>
      >;
      const permissions = definition.permissions as Array<
        Record<string, unknown>
      >;
      const templateOperation = operations.find((operation) =>
        String(operation.operationId).endsWith(
          ':operation.inventory_transaction_create',
        ),
      );
      const templatePermission = permissions.find((permission) =>
        String(permission.permissionId).endsWith(
          ':permission.inventory_transaction_create',
        ),
      );
      assert.ok(templateOperation);
      assert.ok(templatePermission);
      const periodEntityId = 'northstar.inventory:entity.inventory_period_lock';
      const permissionId =
        'northstar.inventory:permission.inventory_period_lock_create';
      permissions.push({
        ...structuredClone(templatePermission),
        permissionId,
        resource: {
          kind: 'entityReference',
          schemaVersion: 'v3',
          targetId: periodEntityId,
        },
      });
      operations.push({
        ...structuredClone(templateOperation),
        effect: {
          entity: {
            kind: 'entityReference',
            schemaVersion: 'v3',
            targetId: periodEntityId,
          },
          kind: 'createRecordEffect',
          schemaVersion: 'v3',
        },
        operationId:
          'northstar.inventory:operation.inventory_period_lock_create',
        permission: {
          kind: 'permissionReference',
          schemaVersion: 'v3',
          targetId: permissionId,
        },
        readBack: {
          kind: 'queryReference',
          schemaVersion: 'v3',
          targetId: 'northstar.inventory:query.inventory_period_lock_get',
        },
      });
      const result = compileApplication(moduleInput(definition));
      assert.equal(result.status, 'failed');
      if (result.status !== 'failed') return;
      assert.equal(
        result.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'COMPILER_ENTITY_PROJECTION_MISSING' &&
            diagnostic.path === '$.conformance.operation.periodLockLifecycle' &&
            diagnostic.subjectId === periodEntityId,
        ),
        true,
        JSON.stringify(result.diagnostics),
      );
    },
  );

  register(
    'legal-entity families and relation endpoint semantics have no default',
    () => {
      const compiled = mustCompile();
      const legalEntity = compiled.release.contract.legalEntity as {
        families: unknown[];
        relations: unknown[];
      };
      assert.deepEqual(legalEntity.families, LEGAL_ENTITY_FAMILY_MAP_V1);
      assert.deepEqual(
        legalEntity.relations,
        LEGAL_ENTITY_RELATION_SEMANTICS_V1,
      );

      const missingFamily = mutableContract();
      missingFamily.legalEntity.families =
        missingFamily.legalEntity.families.filter(
          (rule) => rule.familyId !== 'inventory_movement',
        );
      const missingFamilyResult = compileInventoryContract(missingFamily);
      assert.equal(missingFamilyResult.status, 'failed');
      assertHasDiagnostic(
        missingFamilyResult.diagnostics,
        'INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED',
        '$.legalEntity.families.inventory_movement',
        'inventory_movement',
      );

      const missingRelation = mutableContract();
      missingRelation.legalEntity.relations =
        missingRelation.legalEntity.relations.filter(
          (rule) =>
            !(
              rule.sourceFamilyId === 'inventory_movement' &&
              rule.targetFamilyId === 'location'
            ),
        );
      const missingRelationResult = compileInventoryContract(missingRelation);
      assert.equal(missingRelationResult.status, 'failed');
      assertHasDiagnostic(
        missingRelationResult.diagnostics,
        'INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED',
        '$.legalEntity.relations.inventory_movement->location',
        'inventory_movement->location',
      );

      const reclassified = mutableContract();
      const movement = reclassified.legalEntity.families.find(
        (rule) => rule.familyId === 'inventory_movement',
      );
      assert.ok(movement);
      movement.classification = 'tenantShared';
      const reclassifiedResult = compileInventoryContract(reclassified);
      assert.equal(reclassifiedResult.status, 'failed');
      assertHasDiagnostic(
        reclassifiedResult.diagnostics,
        'INVENTORY_CONTRACT_INVALID',
        '$.legalEntity.families.inventory_movement.classification',
        'inventory_movement',
      );

      const hiddenDefault = mutableContract() as MutableInventoryContract & {
        legalEntity: Record<string, unknown>;
      };
      hiddenDefault.legalEntity.defaultClassification = 'tenantShared';
      const hiddenDefaultResult = compileInventoryContract(hiddenDefault);
      assert.equal(hiddenDefaultResult.status, 'failed');
      assertHasDiagnostic(
        hiddenDefaultResult.diagnostics,
        'INVENTORY_CONTRACT_INVALID',
        '$.legalEntity',
        'legalEntity',
      );

      const reordered = mutableContract();
      reordered.legalEntity.families.reverse();
      const reorderedResult = compileInventoryContract(reordered);
      assert.equal(reorderedResult.status, 'failed');
      assertHasDiagnostic(
        reorderedResult.diagnostics,
        'INVENTORY_CONTRACT_INVALID',
        '$.legalEntity.families',
        'order',
      );
    },
  );

  register(
    'canonical relation endpoints derive pinned entity semantics at compilation',
    () => {
      const accepted = compileApplication(moduleInput(partyModuleDefinition()));
      assert.equal(
        accepted.status,
        'compiled',
        accepted.status === 'failed'
          ? JSON.stringify(accepted.diagnostics)
          : undefined,
      );

      const undeclaredFamily = replaceExactString(
        partyModuleDefinition(),
        'northstar.party:entity.party_role',
        'northstar.party:entity.undeclared_role',
      );
      const familyResult = compileApplication(moduleInput(undeclaredFamily));
      assert.equal(familyResult.status, 'failed');
      assert.deepEqual(
        familyResult.diagnostics
          .filter(
            (diagnostic) =>
              diagnostic.code === 'INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED',
          )
          .map(({ code, path, subjectId }) => ({ code, path, subjectId })),
        [
          {
            code: 'INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED',
            path: '$.entities.entityId',
            subjectId: 'northstar.party:entity.undeclared_role',
          },
        ],
      );

      const undeclaredRelation = partyModuleDefinition() as {
        relations: Array<{
          ownership: string;
          sourceEntity: { targetId: string };
          targetEntity: { targetId: string };
        }>;
      };
      undeclaredRelation.relations[0]!.ownership = 'reference';
      undeclaredRelation.relations[0]!.sourceEntity.targetId =
        'northstar.party:entity.party';
      undeclaredRelation.relations[0]!.targetEntity.targetId =
        'northstar.party:entity.party_role';
      const relationResult = compileApplication(
        moduleInput(undeclaredRelation),
      );
      assert.equal(relationResult.status, 'failed');
      assert.deepEqual(
        relationResult.diagnostics
          .filter(
            (diagnostic) =>
              diagnostic.code ===
              'INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED',
          )
          .map(({ code, path, subjectId }) => ({ code, path, subjectId })),
        [
          {
            code: 'INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED',
            path: '$.relations',
            subjectId: 'northstar.party:relation.party_role_party',
          },
        ],
      );
    },
  );

  register(
    'compiled release data is detached, frozen, and still matches its canonical bytes',
    () => {
      const candidate = mutableContract();
      const result = compileInventoryContract(candidate);
      assert.equal(result.status, 'compiled');
      candidate.configuration.dials.negativeStock = { default: 'allow' };

      assert.equal(
        result.release.release.configuration.negativeStock,
        'reject',
      );
      assert.equal(Object.isFrozen(result.release.release), true);
      assert.equal(Object.isFrozen(result.release.release.contract), true);
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(result.release.canonicalBytes)),
        result.release.release,
      );
    },
  );

  register(
    'configuration rejects a missing required dial and an out-of-range value',
    () => {
      const missing = mutableContract();
      delete missing.configuration.dials.reasonRequirements;
      const missingResult = compileInventoryContract(missing);
      assert.equal(missingResult.status, 'failed');
      assert.deepEqual(diagnosticView(missingResult.diagnostics), [
        {
          bindingMovementId: null,
          code: 'INVENTORY_CONFIGURATION_REQUIRED',
          path: '$.configuration.dials.reasonRequirements',
          subjectId: 'reasonRequirements',
        },
        {
          bindingMovementId: null,
          code: 'INVENTORY_CONFIGURATION_REQUIRED',
          path: '$.configuration.dials.reasonRequirements.default',
          subjectId: null,
        },
        {
          bindingMovementId: null,
          code: 'INVENTORY_CONTRACT_INVALID',
          path: '$.configuration.dials.reasonRequirements.kind',
          subjectId: 'kind',
        },
      ]);

      const outOfRange = compileInventoryContract(INVENTORY_CONTRACT_V1, {
        maximumBackdateDays: 3651,
      });
      assert.equal(outOfRange.status, 'failed');
      assert.deepEqual(diagnosticView(outOfRange.diagnostics), [
        {
          bindingMovementId: null,
          code: 'INVENTORY_CONFIGURATION_OUT_OF_RANGE',
          path: '$.configuration.values.maximumBackdateDays',
          subjectId: '3651',
        },
      ]);
    },
  );

  register(
    'negative stock defaults from declaration data and is recorded in release bytes',
    () => {
      const compiled = mustCompile();
      assert.equal(compiled.release.configurationScope, 'legalEntity');
      assert.equal(compiled.release.configuration.negativeStock, 'reject');
      assert.match(
        new TextDecoder().decode(compiled.canonicalBytes),
        /"configuration":\{"approvalThresholds".*"negativeStock":"reject"/u,
      );

      const explicit = mustCompile({ negativeStock: 'allowWithFlag' });
      assert.equal(
        explicit.release.configuration.negativeStock,
        'allowWithFlag',
      );
      assert.notEqual(explicit.releaseRoot, compiled.releaseRoot);
    },
  );

  register(
    'approval thresholds are release-recorded exact base-unit quantities',
    () => {
      const thresholds = {
        adjustment: '12.5',
        correction: null,
        count: null,
        reBaseline: null,
        transfer: '100',
      };
      const compiled = mustCompile({ approvalThresholds: thresholds });
      assert.deepEqual(
        compiled.release.configuration.approvalThresholds,
        thresholds,
      );

      const invalid = compileInventoryContract(INVENTORY_CONTRACT_V1, {
        approvalThresholds: {
          ...thresholds,
          adjustment: '0.1234567890123456789',
        },
      });
      assert.equal(invalid.status, 'failed');
      assert.deepEqual(diagnosticView(invalid.diagnostics), [
        {
          bindingMovementId: null,
          code: 'INVENTORY_CONFIGURATION_OUT_OF_RANGE',
          path: '$.configuration.values.approvalThresholds.adjustment',
          subjectId: 'adjustment',
        },
      ]);
    },
  );

  register(
    'money fields and movement-derived monetary artifacts fail compilation separately',
    () => {
      const moneyField = mutableContract();
      moneyField.movement.fields.push({
        fieldId: 'monetaryAmount',
        immutable: true,
        presence: 'required',
        semantic: 'money',
        valueShape: { kind: 'moneyFieldType' },
      });
      const fieldResult = compileInventoryContract(moneyField);
      assert.equal(fieldResult.status, 'failed');
      assert.deepEqual(diagnosticView(fieldResult.diagnostics), [
        {
          bindingMovementId: null,
          code: 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN',
          path: '$.movement.fields.monetaryAmount',
          subjectId: 'monetaryAmount',
        },
      ]);

      const monetaryProjection = mutableContract();
      monetaryProjection.compiledArtifacts.push({
        artifactId: 'northstar.inventory:artifact.movement_value',
        outputSemantic: 'money',
        source: 'inventoryMovement',
      });
      const artifactResult = compileInventoryContract(monetaryProjection);
      assert.equal(artifactResult.status, 'failed');
      assert.deepEqual(diagnosticView(artifactResult.diagnostics), [
        {
          bindingMovementId: null,
          code: 'INVENTORY_MOVEMENT_VALUE_DERIVATION_FORBIDDEN',
          path: '$.compiledArtifacts.outputSemantic',
          subjectId: 'northstar.inventory:artifact.movement_value',
        },
      ]);
    },
  );

  register('missing and unknown stock-dimension versions are rejected', () => {
    const compiled = mustCompile();
    const missingCandidate = validMovementCandidate();
    delete missingCandidate.stockDimensionSetVersion;

    const missing = validateInventoryMovementCandidate(
      compiled,
      missingCandidate,
    );
    assert.equal(missing.status, 'rejected');
    assert.deepEqual(diagnosticView(missing.diagnostics), [
      {
        bindingMovementId: null,
        code: 'INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED',
        path: '$.movement.stockDimensionSetVersion',
        subjectId: null,
      },
    ]);

    const unknown = validateInventoryMovementCandidate(compiled, {
      ...validMovementCandidate(),
      stockDimensionSetVersion: 'v99',
    });
    assert.equal(unknown.status, 'rejected');
    assert.deepEqual(diagnosticView(unknown.diagnostics), [
      {
        bindingMovementId: null,
        code: 'INVENTORY_STOCK_DIMENSION_VERSION_UNKNOWN',
        path: '$.movement.stockDimensionSetVersion',
        subjectId: 'v99',
      },
    ]);
  });

  register('v1 unspecified members are structurally unreachable', () => {
    const declaration = mutableContract();
    declaration.stockDimensionSet.v1.unspecifiedMembers = 'declared';
    const declarationResult = compileInventoryContract(declaration);
    assert.equal(declarationResult.status, 'failed');
    assert.deepEqual(diagnosticView(declarationResult.diagnostics), [
      {
        bindingMovementId: null,
        code: 'INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN',
        path: '$.stockDimensionSet.v1.unspecifiedMembers',
        subjectId: 'unspecifiedMembers',
      },
    ]);

    const result = validateInventoryMovementCandidate(mustCompile(), {
      ...validMovementCandidate(),
      stockIdentity: {
        itemId: 'item-1',
        legalEntityId: 'entity-1',
        locationId: 'northstar.location:member.unspecified',
      },
    });
    assert.equal(result.status, 'rejected');
    assert.deepEqual(diagnosticView(result.diagnostics), [
      {
        bindingMovementId: null,
        code: 'INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN',
        path: '$.movement.stockIdentity.locationId',
        subjectId: 'northstar.location:member.unspecified',
      },
    ]);
  });

  register(
    'movement candidates reject monetary and other undeclared fields',
    () => {
      assert.deepEqual(
        validateInventoryMovementCandidate(
          mustCompile(),
          validMovementCandidate(),
        ),
        { diagnostics: [], status: 'accepted' },
      );

      const result = validateInventoryMovementCandidate(mustCompile(), {
        ...validMovementCandidate(),
        currency: 'CAD',
        monetaryAmount: '125.00',
        warehouseNote: 'ordinary undeclared field',
      } as InventoryMovementCandidateV1);
      assert.equal(result.status, 'rejected');
      assert.deepEqual(diagnosticView(result.diagnostics), [
        {
          bindingMovementId: null,
          code: 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN',
          path: '$.movement.currency',
          subjectId: 'currency',
        },
        {
          bindingMovementId: null,
          code: 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN',
          path: '$.movement.monetaryAmount',
          subjectId: 'monetaryAmount',
        },
        {
          bindingMovementId: null,
          code: 'INVENTORY_CONTRACT_INVALID',
          path: '$.movement.warehouseNote',
          subjectId: 'warehouseNote',
        },
      ]);
    },
  );

  register('base-unit mutation rejection names the binding movement', () => {
    const result = validateInventoryBaseUnitChange(mustCompile(), {
      bindingMovementId: 'movement-00017',
      currentBaseUnitId: 'unit.each',
      itemId: 'item-42',
      requestedBaseUnitId: 'unit.case',
    });
    assert.equal(result.status, 'rejected');
    assert.deepEqual(diagnosticView(result.diagnostics), [
      {
        bindingMovementId: 'movement-00017',
        code: 'INVENTORY_BASE_UNIT_IMMUTABLE',
        path: '$.item.baseUnitId',
        subjectId: 'item-42',
      },
    ]);
  });

  register('undeclared posting dependencies fail conformance', () => {
    for (const entry of [
      {
        access: 'read',
        authority: 'catalog',
        dependencyId: 'northstar.catalog:item.description',
      },
      {
        access: 'append',
        authority: 'trust',
        dependencyId: 'northstar.trust:undeclared_append',
      },
      {
        access: 'transition',
        authority: 'inventory',
        dependencyId: 'northstar.inventory:undeclared_transition',
      },
    ]) {
      const candidate = mutableContract();
      candidate.authoritativeDependencies.accessPlan.push(entry);
      const result = compileInventoryContract(candidate);
      assert.equal(result.status, 'failed');
      assertHasDiagnostic(
        result.diagnostics,
        'INVENTORY_POSTING_DEPENDENCY_UNDECLARED',
        '$.authoritativeDependencies.accessPlan',
        entry.dependencyId,
      );
    }

    const mutation = mutableContract();
    mutation.authoritativeDependencies.accessPlan[0]!.dependencyId =
      'northstar.context:undeclared';
    const mutationResult = compileInventoryContract(mutation);
    assert.equal(mutationResult.status, 'failed');
    assertHasDiagnostic(
      mutationResult.diagnostics,
      'INVENTORY_POSTING_DEPENDENCY_UNDECLARED',
      '$.authoritativeDependencies.accessPlan',
      'northstar.context:undeclared',
    );

    const coordinatedRemoval = mutableContract();
    coordinatedRemoval.authoritativeDependencies.dependencies.pop();
    coordinatedRemoval.authoritativeDependencies.accessPlan.pop();
    const coordinatedResult = compileInventoryContract(coordinatedRemoval);
    assert.equal(coordinatedResult.status, 'failed');
    assertHasDiagnostic(
      coordinatedResult.diagnostics,
      'INVENTORY_CONTRACT_INVALID',
      '$.authoritativeDependencies.dependencies',
      'dependencies',
    );
    assertHasDiagnostic(
      coordinatedResult.diagnostics,
      'INVENTORY_CONTRACT_INVALID',
      '$.authoritativeDependencies.accessPlan',
      'accessPlan',
    );
  });

  register('malformed artifact and dial declarations fail closed', () => {
    for (const artifact of [
      { outputSemantic: 'money' },
      {
        artifactId: 'northstar.inventory:artifact.bad_source',
        outputSemantic: 'quantity',
        source: 'movementGuess',
      },
    ]) {
      const candidate = mutableContract();
      candidate.compiledArtifacts.push(artifact);
      const result = compileInventoryContract(candidate);
      assert.equal(result.status, 'failed');
      assertHasDiagnostic(
        result.diagnostics,
        'INVENTORY_CONTRACT_INVALID',
        '$.compiledArtifacts',
        'artifactId' in artifact ? artifact.artifactId : null,
      );
    }

    const extraDial = mutableContract();
    extraDial.configuration.dials.sameInstantOrder = {
      default: 'sourceId',
    };
    const dialResult = compileInventoryContract(extraDial);
    assert.equal(dialResult.status, 'failed');
    assertHasDiagnostic(
      dialResult.diagnostics,
      'INVENTORY_CONFIGURATION_MALFORMED',
      '$.configuration.dials.sameInstantOrder',
      'sameInstantOrder',
    );
  });

  register(
    'temporal operations, global tie-break, and the v2 decimal limit stay explicit',
    () => {
      const contract = mustCompile().release.contract;
      assert.deepEqual(contract.temporal, INVENTORY_CONTRACT_V1.temporal);
      assert.deepEqual(
        contract.sameInstantTieBreak,
        INVENTORY_CONTRACT_V1.sameInstantTieBreak,
      );
      assert.equal(
        (contract.sameInstantTieBreak as { configurable: boolean })
          .configurable,
        false,
      );

      const limit = contract.v2DecimalLimit as {
        canonicalPattern: string;
        signedSubUnitExample: string;
        signedSubUnitValues: string;
      };
      const v2Decimal = new RegExp(limit.canonicalPattern);
      assert.equal(v2Decimal.test('-0.25'), false);
      assert.equal(v2Decimal.test('-1.25'), true);
      assert.equal(limit.signedSubUnitExample, '-0.25');
      assert.equal(limit.signedSubUnitValues, 'inexpressibleUntilV3');
    },
  );
}

function mustCompile(
  configuration: Record<string, unknown> = {},
): CompiledInventoryContractV1 {
  const result = compileInventoryContract(INVENTORY_CONTRACT_V1, configuration);
  assert.equal(
    result.status,
    'compiled',
    result.status === 'failed' ? JSON.stringify(result.diagnostics) : undefined,
  );
  return result.release;
}

function mutableContract(): MutableInventoryContract {
  return structuredClone(
    INVENTORY_CONTRACT_V1,
  ) as unknown as MutableInventoryContract;
}

function validMovementCandidate(): InventoryMovementCandidateV1 {
  return {
    effectiveAt: '2026-07-28T18:00:00.000Z',
    movementId: 'movement-1',
    postingRole: 'adjustment',
    quantityDelta: '-1.25',
    recordedAt: '2026-07-28T18:00:01.000Z',
    sourceId: 'adjustment-1',
    sourceLine: '1',
    sourceType: 'inventoryAdjustment',
    stockDimensionSetVersion: 'v1',
    stockIdentity: {
      itemId: 'item-1',
      legalEntityId: 'entity-1',
      locationId: 'location-1',
    },
    unitId: 'unit.each',
  };
}

function moduleInput(definition: unknown): CompilerInput {
  return {
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalizeApplicationPackage(definition)),
    ),
    profile: { ...MODULE_COMPILER_PROFILE },
  };
}

function mustCompileModule(definition: unknown): CompileSuccess {
  const result = compileApplication(moduleInput(definition));
  assert.equal(
    result.status,
    'compiled',
    result.status === 'failed' ? JSON.stringify(result.diagnostics) : undefined,
  );
  return result as CompileSuccess;
}

function storageTargetPayloadVersion(definition: unknown): string {
  const compiled = mustCompileModule(definition);
  const reference = compiled.bundle.releaseManifest.projections.find(
    (projection) => projection.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.ok(reference);
  return reference.payloadSchemaVersion;
}

function projectionPayload<T>(compiled: CompileSuccess, familyId: string): T {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (projection) => projection.familyId === familyId,
  );
  assert.ok(reference);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === reference.artifactRoot,
  );
  assert.ok(manifestArtifact);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as { chunks: Array<{ contentHash: string }> };
  assert.equal(manifest.chunks.length, 1);
  const chunk = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === manifest.chunks[0]?.contentHash,
  );
  assert.ok(chunk);
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
}

function entityOwnedStorageDefinition(): unknown {
  return inventoryModuleDefinition();
}

function inventoryDefinitionWithoutMovementField(
  fieldLocalId: string,
): Record<string, unknown> {
  const definition = structuredClone(inventoryModuleDefinition()) as {
    fields: Array<{ fieldId: string }>;
    queries: Array<{
      selections: Array<{ field: { targetId: string } }>;
    }>;
  };
  const suffix = `:field.${fieldLocalId}`;
  definition.fields = definition.fields.filter(
    (field) => !field.fieldId.endsWith(suffix),
  );
  for (const query of definition.queries) {
    query.selections = query.selections.filter(
      (selection) => !selection.field.targetId.endsWith(suffix),
    );
  }
  return definition;
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

function diagnosticView(diagnostics: InventoryContractDiagnostic[]): unknown {
  return diagnostics.map(({ bindingMovementId, code, path, subjectId }) => ({
    bindingMovementId,
    code,
    path,
    subjectId,
  }));
}

function assertHasDiagnostic(
  diagnostics: InventoryContractDiagnostic[],
  code: InventoryContractDiagnostic['code'],
  path: string,
  subjectId: string | null,
): void {
  assert.equal(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === code &&
        diagnostic.path === path &&
        diagnostic.subjectId === subjectId,
    ),
    true,
    JSON.stringify(diagnosticView(diagnostics)),
  );
}

function releaseSummary(compiled: CompiledInventoryContractV1): unknown {
  const contract = compiled.release.contract;
  const movement = contract.movement as {
    fields: Array<{ fieldId: string; semantic: string }>;
    kind: string;
  };
  const dependencies = contract.authoritativeDependencies as {
    dependencies: Array<{ access: string; dependencyId: string }>;
  };
  return {
    configuration: compiled.release.configuration,
    configurationScope: compiled.release.configurationScope,
    dependencySet: dependencies.dependencies.map(
      (entry) => `${entry.access}:${entry.dependencyId}`,
    ),
    legalEntity: contract.legalEntity,
    movement: {
      fields: movement.fields.map((field) => ({
        fieldId: field.fieldId,
        semantic: field.semantic,
      })),
      kind: movement.kind,
    },
    releaseRoot: compiled.releaseRoot,
    storageTargetPayloadVersions: {
      entityOwned: storageTargetPayloadVersion(entityOwnedStorageDefinition()),
      tenantShared: storageTargetPayloadVersion(partyModuleDefinition()),
    },
    stockDimensions: (contract.stockDimensionSet as { dimensions: string[] })
      .dimensions,
  };
}
