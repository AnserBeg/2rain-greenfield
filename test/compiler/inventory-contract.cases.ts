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
  resolvePinnedInventoryProviderWrittenReadModel,
  validateInventoryBaseUnitChange,
  validateInventoryMovementCandidate,
  type CompiledInventoryContractV1,
  type InventoryContractDiagnostic,
  type InventoryMovementCandidateV1,
} from '../../packages/compiler/src/conformance.js';
import {
  INVENTORY_CONTRACT_V1,
  INVENTORY_FACT_STORAGE_V1,
  INVENTORY_NAMESPACE,
  INVENTORY_PERIOD_LOCK_STORAGE_V1,
  INVENTORY_PROVIDER_WRITTEN_READ_MODELS_V1,
  INVENTORY_STORAGE_REFERENCES_V1,
  LEGAL_ENTITY_FAMILY_MAP_V1,
  LEGAL_ENTITY_RELATION_SEMANTICS_V1,
  inventoryModuleDefinition,
} from '../../packages/domain/src/inventory/index.js';
import { catalogModuleDefinition } from '../../packages/domain/src/catalog/definition.js';
import { partyModuleDefinition } from '../../packages/domain/src/party/definition.js';

interface MutableInventoryContract {
  authoritativeDependencies: {
    accessPlan: Array<Record<string, unknown>>;
    dependencySetRoot: string;
    dependencies: Array<Record<string, unknown>>;
    version: number;
  };
  compiledArtifacts: Array<Record<string, unknown>>;
  countEvidence: {
    lineValues: Array<Record<string, unknown>>;
  };
  configuration: {
    dials: Record<string, unknown>;
  };
  legalEntity: {
    families: Array<Record<string, unknown>>;
    relations: Array<Record<string, unknown>>;
  };
  readModels: {
    authoredOperations: string;
    providerWritten: Array<Record<string, unknown>>;
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
    'posted stock is an operationless legal-entity row model whose labels state its temporal limit',
    () => {
      const definition = inventoryModuleDefinition() as unknown as {
        entities: Array<{ entityId: string; label: string }>;
        fields: Array<{
          businessKey?: string;
          entity: { targetId: string };
          fieldId: string;
          fieldType: {
            kind: string;
            maximumLength?: number;
            scale?: number;
          };
        }>;
        languageVersion: string;
        operations: Array<
          Record<string, unknown> & {
            effect: { entity?: { targetId?: string }; kind: string };
            lifecycle?: string;
            operationId: string;
            permission: { targetId: string };
            readBack: { targetId: string };
            tier: string;
          }
        >;
        permissions: Array<
          Record<string, unknown> & {
            label: string;
            permissionId: string;
            resource: { targetId: string };
          }
        >;
        stateMachines: Array<Record<string, unknown>>;
        surfaces: Array<{ label: string; surfaceId: string }>;
      };
      const entityId = `${INVENTORY_NAMESPACE}:entity.posted_stock_balance`;
      const assertHonestLabels = (candidate: typeof definition): void => {
        assert.equal(
          candidate.entities.find((entity) => entity.entityId === entityId)
            ?.label,
          'Posted stock balance',
        );
        assert.deepEqual(
          candidate.surfaces
            .filter((surface) =>
              surface.surfaceId.includes('.posted_stock_balance_'),
            )
            .map((surface) => surface.label),
          ['Posted stock list', 'Posted stock detail'],
        );
      };
      assertHonestLabels(definition);
      assert.equal(
        definition.operations.some(
          (operation) => operation.effect.entity?.targetId === entityId,
        ),
        false,
        'the platform-written projection authors no operation',
      );
      assert.deepEqual(INVENTORY_PROVIDER_WRITTEN_READ_MODELS_V1, [
        {
          classification: 'providerWritten',
          familyId: 'posted_stock_balance',
          maintainerId:
            'northstar.postgresql-module-provider:posted-stock-balance/v1',
        },
      ]);
      assert.deepEqual(
        resolvePinnedInventoryProviderWrittenReadModel(
          `${INVENTORY_NAMESPACE}:package.inventory`,
          entityId,
        ),
        INVENTORY_PROVIDER_WRITTEN_READ_MODELS_V1[0],
        'the pinned candidate rule is resolved by canonical family before ABI qualification',
      );
      assert.equal(
        resolvePinnedInventoryProviderWrittenReadModel(
          'northstar.catalog:package.catalog',
          'northstar.catalog:entity.unpinned_projection',
        ),
        null,
        'an unpinned family cannot earn the exemption',
      );

      const admitted = compileApplication(moduleInput(definition));
      assert.equal(
        admitted.status,
        'compiled',
        'removing the provider-written conformance branch must red here with missing CRUD/form diagnostics',
      );

      const assertProviderOperationRefused = (
        candidate: typeof definition,
        message: string,
      ): void => {
        const refused = compileApplication(moduleInput(candidate));
        assert.equal(refused.status, 'failed', message);
        if (refused.status !== 'failed') return;
        assert.deepEqual(
          refused.diagnostics
            .filter(
              (diagnostic) =>
                diagnostic.path === '$.operations.providerWritten',
            )
            .map((diagnostic) => [diagnostic.code, diagnostic.subjectId]),
          [['COMPILER_DESTRUCTIVE_OPERATION_UNSUPPORTED', entityId]],
          message,
        );
      };
      for (const probe of [
        { label: 'active o0', lifecycle: undefined, tier: 'o0' },
        { label: 'active o1', lifecycle: undefined, tier: 'o1' },
        { label: 'retired o0', lifecycle: 'retired', tier: 'o0' },
      ]) {
        const withAuthoredOperation = structuredClone(definition);
        const exemplar = withAuthoredOperation.operations.find(
          (operation) =>
            operation.operationId ===
            `${INVENTORY_NAMESPACE}:operation.legal_entity_create`,
        );
        assert.ok(exemplar);
        const operation = structuredClone(exemplar);
        assert.ok(operation.effect.entity);
        operation.operationId = `${INVENTORY_NAMESPACE}:operation.posted_stock_balance_create_${probe.label.replace(' ', '_')}_probe`;
        operation.effect.entity.targetId = entityId;
        operation.permission.targetId = `${INVENTORY_NAMESPACE}:permission.posted_stock_balance_read`;
        operation.readBack.targetId = `${INVENTORY_NAMESPACE}:query.posted_stock_balance_get`;
        operation.tier = probe.tier;
        if (probe.lifecycle) operation.lifecycle = probe.lifecycle;
        withAuthoredOperation.operations.push(operation);
        assertProviderOperationRefused(
          withAuthoredOperation,
          `a direct ${probe.label} operation must hit the provider-written refusing twin by entity name`,
        );
      }

      const malformedCompanionWithAuthoredOperation =
        structuredClone(definition);
      const malformedMovementSourceType =
        malformedCompanionWithAuthoredOperation.fields.find(
          (field) =>
            field.fieldId ===
            `${INVENTORY_NAMESPACE}:field.inventory_movement_source_type`,
        );
      assert.ok(malformedMovementSourceType);
      malformedMovementSourceType.businessKey =
        'tenantEnvironmentCaseInsensitiveUnique';
      const malformedCompanionOperation = structuredClone(
        malformedCompanionWithAuthoredOperation.operations.find(
          (operation) =>
            operation.operationId ===
            `${INVENTORY_NAMESPACE}:operation.legal_entity_create`,
        ),
      );
      assert.ok(malformedCompanionOperation);
      assert.ok(malformedCompanionOperation.effect.entity);
      malformedCompanionOperation.operationId = `${INVENTORY_NAMESPACE}:operation.posted_stock_balance_malformed_companion_probe`;
      malformedCompanionOperation.effect.entity.targetId = entityId;
      malformedCompanionOperation.permission.targetId = `${INVENTORY_NAMESPACE}:permission.posted_stock_balance_read`;
      malformedCompanionOperation.readBack.targetId = `${INVENTORY_NAMESPACE}:query.posted_stock_balance_get`;
      malformedCompanionOperation.tier = 'o0';
      malformedCompanionWithAuthoredOperation.operations.push(
        malformedCompanionOperation,
      );
      assertProviderOperationRefused(
        malformedCompanionWithAuthoredOperation,
        'the refusing twin must remain pinned-candidate-based when the movement companion fails storage ABI qualification',
      );

      const withTransitionOperation = structuredClone(definition);
      const transitionPermission = structuredClone(
        withTransitionOperation.permissions.find(
          (permission) =>
            permission.permissionId ===
            `${INVENTORY_NAMESPACE}:permission.inventory_transaction_post`,
        ),
      );
      assert.ok(transitionPermission);
      transitionPermission.permissionId = `${INVENTORY_NAMESPACE}:permission.posted_stock_balance_transition_probe`;
      transitionPermission.label = 'posted stock transition probe';
      transitionPermission.resource.targetId = entityId;
      withTransitionOperation.permissions.push(transitionPermission);
      const transitionId = `${INVENTORY_NAMESPACE}:transition.posted_stock_balance_probe`;
      const openStateId = `${INVENTORY_NAMESPACE}:state.posted_stock_balance_open_probe`;
      const closedStateId = `${INVENTORY_NAMESPACE}:state.posted_stock_balance_closed_probe`;
      const reference = (kind: string, targetId: string) => ({
        kind,
        schemaVersion: definition.languageVersion,
        targetId,
      });
      withTransitionOperation.stateMachines.push({
        entity: reference('entityReference', entityId),
        initialState: reference('stateReference', openStateId),
        kind: 'stateMachineDefinition',
        machineId: `${INVENTORY_NAMESPACE}:machine.posted_stock_balance_probe`,
        schemaVersion: definition.languageVersion,
        states: [
          {
            kind: 'stateDefinition',
            label: 'Open',
            orderKey: 10,
            schemaVersion: definition.languageVersion,
            stateId: openStateId,
          },
          {
            kind: 'stateDefinition',
            label: 'Closed',
            orderKey: 20,
            schemaVersion: definition.languageVersion,
            stateId: closedStateId,
            terminal: true,
          },
        ],
        transitions: [
          {
            fromState: reference('stateReference', openStateId),
            kind: 'transitionDefinition',
            label: 'Close probe',
            orderKey: 10,
            permission: reference(
              'permissionReference',
              transitionPermission.permissionId,
            ),
            schemaVersion: definition.languageVersion,
            toState: reference('stateReference', closedStateId),
            transitionId,
          },
        ],
      });
      const transitionOperation = structuredClone(
        withTransitionOperation.operations.find(
          (operation) =>
            operation.operationId ===
            `${INVENTORY_NAMESPACE}:operation.legal_entity_create`,
        ),
      );
      assert.ok(transitionOperation);
      transitionOperation.operationId = `${INVENTORY_NAMESPACE}:operation.posted_stock_balance_transition_probe`;
      transitionOperation.effect = {
        kind: 'transitionStateEffect',
        schemaVersion: definition.languageVersion,
        transition: reference('transitionReference', transitionId),
      } as typeof transitionOperation.effect;
      transitionOperation.permission.targetId =
        transitionPermission.permissionId;
      transitionOperation.readBack.targetId = `${INVENTORY_NAMESPACE}:query.posted_stock_balance_get`;
      transitionOperation.tier = 'o0';
      withTransitionOperation.operations.push(transitionOperation);
      assertProviderOperationRefused(
        withTransitionOperation,
        'a transition effect must resolve through its machine to the provider-written entity',
      );

      const impliedAsOf = structuredClone(definition);
      impliedAsOf.entities.find(
        (entity) => entity.entityId === entityId,
      )!.label = 'On-hand balance';
      assert.throws(
        () => assertHonestLabels(impliedAsOf),
        /Posted stock balance/u,
        'one changed label makes the honesty control red',
      );
    },
  );

  register(
    'posted-stock provider status requires the exact maintainer storage ABI',
    () => {
      const definition = inventoryModuleDefinition() as unknown as {
        entities: Array<{ entityId: string; lifecycle?: string }>;
        fields: Array<{
          businessKey?: string;
          collation?: string;
          defaultSemantics?: string;
          defaultValue?: unknown;
          entity: { targetId: string };
          fieldId: string;
          fieldType: {
            kind: string;
            maximumLength?: number;
            scale?: number;
          };
          lifecycle?: string;
          presence?: string;
          searchable: boolean;
          storageEvolution?: {
            kind: string;
            residualReadSemantics: string;
            schemaVersion: string;
          };
        }>;
        languageVersion: string;
        relations: Array<{
          archiveBehavior: string;
          lifecycle?: string;
          orderKey: number;
          ownership: string;
          relationId: string;
          required?: boolean;
          sourceEntity: { targetId: string };
          targetEntity: { targetId: string };
        }>;
      };
      const postedStockBalanceEntityId = `${INVENTORY_NAMESPACE}:entity.posted_stock_balance`;
      const missingProviderAuthoredProjectionPaths = [
        '$.conformance.operation.archive',
        '$.conformance.operation.create',
        '$.conformance.operation.restore',
        '$.conformance.operation.update',
        '$.conformance.surface.form',
      ];
      const assertProviderExemptionWithheld = (
        result: ReturnType<typeof compileApplication>,
        message: string,
      ): void => {
        assert.equal(result.status, 'failed', message);
        if (result.status !== 'failed') return;
        assert.deepEqual(
          result.diagnostics
            .filter(
              (diagnostic) =>
                diagnostic.code === 'COMPILER_ENTITY_PROJECTION_MISSING' &&
                diagnostic.subjectId === postedStockBalanceEntityId,
            )
            .map((diagnostic) => diagnostic.path)
            .sort(),
          missingProviderAuthoredProjectionPaths,
          message,
        );
      };
      assert.equal(
        compileApplication(moduleInput(definition)).status,
        'compiled',
        'the exact maintainer ABI remains the admission twin',
      );
      const movementEntityId = `${INVENTORY_NAMESPACE}:entity.inventory_movement`;
      const movementRelationLocalIds = definition.relations
        .filter(
          (relation) => relation.sourceEntity.targetId === movementEntityId,
        )
        .map((relation) => relation.relationId.split(':relation.')[1]);
      assert.deepEqual(
        movementRelationLocalIds,
        [
          'inventory_movement_transaction',
          'inventory_movement_transaction_line',
        ],
        'the admission twin declares exactly the two relations maintained by posting',
      );
      const assertMovementRelationIncompatible = (
        candidate: typeof definition,
        diagnosticPath: string,
        subjectId: string,
        message: string,
      ): void => {
        const result = compileApplication(moduleInput(candidate));
        assertProviderExemptionWithheld(result, message);
        if (result.status !== 'failed') return;
        assert.equal(
          result.diagnostics.some(
            (diagnostic) =>
              diagnostic.code === 'INVENTORY_CONTRACT_INVALID' &&
              diagnostic.path === diagnosticPath &&
              diagnostic.subjectId === subjectId,
          ),
          true,
          `${message}: exact movement-relation ABI diagnostic`,
        );
      };
      const movementTransactionRelationId = `${INVENTORY_NAMESPACE}:relation.inventory_movement_transaction`;
      const movementTransactionLineRelationId = `${INVENTORY_NAMESPACE}:relation.inventory_movement_transaction_line`;
      const extraRelation = structuredClone(definition);
      const relationExemplar = extraRelation.relations.find(
        (relation) => relation.relationId === movementTransactionLineRelationId,
      );
      assert.ok(relationExemplar);
      const duplicateRelation = structuredClone(relationExemplar);
      duplicateRelation.relationId = `${INVENTORY_NAMESPACE}:relation.inventory_movement_transaction_line_duplicate_probe`;
      duplicateRelation.orderKey = 35;
      extraRelation.relations.push(duplicateRelation);
      assertMovementRelationIncompatible(
        extraRelation,
        '$.relations.inventory_movement_transaction_line_duplicate_probe',
        duplicateRelation.relationId,
        'an extra declared movement relation must not retain the provider-written exemption',
      );

      const missingRelation = structuredClone(definition);
      missingRelation.relations = missingRelation.relations.filter(
        (relation) => relation.relationId !== movementTransactionLineRelationId,
      );
      assertMovementRelationIncompatible(
        missingRelation,
        '$.relations.inventory_movement_transaction_line',
        movementTransactionLineRelationId,
        'a missing declared movement relation must not retain the provider-written exemption',
      );

      const movementRelationMutations: Array<{
        diagnosticSuffix: string;
        label: string;
        relationId: string;
        mutate: (relation: (typeof definition.relations)[number]) => void;
      }> = [
        {
          diagnosticSuffix: '.archiveBehavior',
          label: 'movement relation archive behavior',
          relationId: movementTransactionLineRelationId,
          mutate: (relation) => {
            relation.archiveBehavior = 'retainReference';
          },
        },
        {
          diagnosticSuffix: '.lifecycle',
          label: 'movement relation lifecycle',
          relationId: movementTransactionLineRelationId,
          mutate: (relation) => {
            relation.lifecycle = 'retired';
          },
        },
        {
          diagnosticSuffix: '.ownership',
          label: 'movement relation ownership',
          relationId: movementTransactionRelationId,
          mutate: (relation) => {
            relation.ownership = 'reference';
          },
        },
        {
          diagnosticSuffix: '.required',
          label: 'movement relation nullability',
          relationId: movementTransactionLineRelationId,
          mutate: (relation) => {
            relation.required = false;
          },
        },
        {
          diagnosticSuffix: '.sourceEntity',
          label: 'movement relation source',
          relationId: movementTransactionLineRelationId,
          mutate: (relation) => {
            relation.sourceEntity.targetId = `${INVENTORY_NAMESPACE}:entity.stock_count_line`;
          },
        },
        {
          diagnosticSuffix: '.targetEntity',
          label: 'movement relation target',
          relationId: movementTransactionLineRelationId,
          mutate: (relation) => {
            relation.targetEntity.targetId = `${INVENTORY_NAMESPACE}:entity.inventory_transaction`;
          },
        },
      ];
      for (const {
        diagnosticSuffix,
        label,
        relationId,
        mutate,
      } of movementRelationMutations) {
        const incompatible = structuredClone(definition);
        const relation = incompatible.relations.find(
          (candidate) => candidate.relationId === relationId,
        );
        assert.ok(relation);
        mutate(relation);
        assertMovementRelationIncompatible(
          incompatible,
          `$.relations.${relationId.split(':relation.')[1]}${diagnosticSuffix}`,
          relationId,
          `${label} incompatibility must return every authored CRUD/Form requirement`,
        );
      }

      const unitFieldId = `${INVENTORY_NAMESPACE}:field.posted_stock_balance_unit_id`;
      const renamedUnitFieldId = `${INVENTORY_NAMESPACE}:field.posted_stock_balance_unit_identifier`;
      const renamed = replaceExactString(
        definition,
        unitFieldId,
        renamedUnitFieldId,
      );
      const renamedResult = compileApplication(moduleInput(renamed));
      assert.equal(renamedResult.status, 'failed');
      if (renamedResult.status === 'failed') {
        assert.deepEqual(
          new Set(
            renamedResult.diagnostics
              .filter(
                (diagnostic) =>
                  diagnostic.code === 'INVENTORY_CONTRACT_INVALID' &&
                  diagnostic.path.startsWith(
                    '$.fields.posted_stock_balance_unit_',
                  ),
              )
              .map((diagnostic) => diagnostic.path),
          ),
          new Set([
            '$.fields.posted_stock_balance_unit_id',
            '$.fields.posted_stock_balance_unit_identifier',
          ]),
          'renaming the provider unit field must name both the missing ABI slot and the unmaintained replacement',
        );
      }
      assertProviderExemptionWithheld(
        renamedResult,
        'a renamed provider field must return every authored CRUD/Form requirement for the exact posted-stock subject',
      );

      const fieldMutations: Array<{
        diagnosticSuffix: string;
        fieldLocalId: string;
        label: string;
        mutate: (field: (typeof definition.fields)[number]) => void;
      }> = [
        {
          diagnosticSuffix: '',
          fieldLocalId: 'posted_stock_balance_item_id',
          label: 'item type',
          mutate: (field) => {
            field.fieldType.maximumLength = 81;
          },
        },
        {
          diagnosticSuffix: '',
          fieldLocalId: 'posted_stock_balance_location_id',
          label: 'location type',
          mutate: (field) => {
            field.fieldType.maximumLength = 81;
          },
        },
        {
          diagnosticSuffix: '',
          fieldLocalId: 'posted_stock_balance_posted_quantity',
          label: 'quantity type',
          mutate: (field) => {
            field.fieldType.scale = 17;
          },
        },
        {
          diagnosticSuffix: '',
          fieldLocalId: 'posted_stock_balance_unit_id',
          label: 'unit type',
          mutate: (field) => {
            field.fieldType.maximumLength = 33;
          },
        },
        ...[
          'posted_stock_balance_item_id',
          'posted_stock_balance_location_id',
          'posted_stock_balance_posted_quantity',
          'posted_stock_balance_unit_id',
        ].map((fieldLocalId) => ({
          diagnosticSuffix: '.businessKey',
          fieldLocalId,
          label: `${fieldLocalId} business key`,
          mutate: (field: (typeof definition.fields)[number]) => {
            field.businessKey = 'tenantEnvironmentCaseInsensitiveUnique';
          },
        })),
        {
          diagnosticSuffix: '.collation',
          fieldLocalId: 'posted_stock_balance_item_id',
          label: 'item collation',
          mutate: (field) => {
            field.collation = 'unicodeCaseInsensitive';
          },
        },
        {
          diagnosticSuffix: '.defaultSemantics',
          fieldLocalId: 'posted_stock_balance_location_id',
          label: 'location default semantics',
          mutate: (field) => {
            field.defaultSemantics = 'nullable';
          },
        },
        {
          diagnosticSuffix: '.searchable',
          fieldLocalId: 'posted_stock_balance_item_id',
          label: 'item search mapping',
          mutate: (field) => {
            field.searchable = false;
          },
        },
        {
          diagnosticSuffix: '.searchable',
          fieldLocalId: 'posted_stock_balance_location_id',
          label: 'location search mapping',
          mutate: (field) => {
            field.searchable = true;
          },
        },
        {
          diagnosticSuffix: '.storageEvolution',
          fieldLocalId: 'posted_stock_balance_unit_id',
          label: 'unit storage evolution',
          mutate: (field) => {
            field.storageEvolution = {
              kind: 'backfillEvolution',
              residualReadSemantics: 'requiresCompleteness',
              schemaVersion: definition.languageVersion,
            };
          },
        },
        {
          diagnosticSuffix: '',
          fieldLocalId: 'posted_stock_balance_item_id',
          label: 'item presence',
          mutate: (field) => {
            field.presence = 'optional';
          },
        },
        {
          diagnosticSuffix: '',
          fieldLocalId: 'posted_stock_balance_item_id',
          label: 'item lifecycle',
          mutate: (field) => {
            field.lifecycle = 'retired';
          },
        },
      ];
      for (const {
        diagnosticSuffix,
        fieldLocalId,
        label,
        mutate,
      } of fieldMutations) {
        const incompatible = structuredClone(definition);
        const field = incompatible.fields.find(
          (candidate) =>
            candidate.fieldId ===
            `${INVENTORY_NAMESPACE}:field.${fieldLocalId}`,
        );
        assert.ok(field);
        mutate(field);
        const result = compileApplication(moduleInput(incompatible));
        assertProviderExemptionWithheld(
          result,
          `${label} incompatibility must return every authored CRUD/Form requirement`,
        );
        if (result.status !== 'failed') continue;
        assert.equal(
          result.diagnostics.some(
            (diagnostic) =>
              diagnostic.code === 'INVENTORY_CONTRACT_INVALID' &&
              diagnostic.path ===
                `$.fields.${fieldLocalId}${diagnosticSuffix}` &&
              diagnostic.subjectId === field.fieldId,
          ),
          true,
          `${label} must be refused by its exact provider ABI path and subject`,
        );
      }

      const withoutActiveMovement = structuredClone(definition);
      const movement = withoutActiveMovement.entities.find(
        (entity) =>
          entity.entityId ===
          `${INVENTORY_NAMESPACE}:entity.inventory_movement`,
      );
      assert.ok(movement);
      movement.lifecycle = 'retired';
      const withoutMovementResult = compileApplication(
        moduleInput(withoutActiveMovement),
      );
      assert.equal(withoutMovementResult.status, 'failed');
      if (withoutMovementResult.status === 'failed') {
        assert.equal(
          withoutMovementResult.diagnostics.some(
            (diagnostic) =>
              diagnostic.code === 'INVENTORY_CONTRACT_INVALID' &&
              diagnostic.path === '$.entities.inventory_movement',
          ),
          true,
          'the named maintainer requires exactly one active movement companion',
        );
      }
      assertProviderExemptionWithheld(
        withoutMovementResult,
        'a provider family without its active movement companion must return every authored CRUD/Form requirement',
      );

      const withMalformedMovement = structuredClone(definition);
      const malformedMovementField = withMalformedMovement.fields.find(
        (field) =>
          field.fieldId ===
          `${INVENTORY_NAMESPACE}:field.inventory_movement_item_id`,
      );
      assert.ok(malformedMovementField);
      malformedMovementField.fieldType.maximumLength = 81;
      const malformedMovementResult = compileApplication(
        moduleInput(withMalformedMovement),
      );
      assertProviderExemptionWithheld(
        malformedMovementResult,
        'a malformed active movement companion must return every authored CRUD/Form requirement',
      );
      if (malformedMovementResult.status === 'failed') {
        assert.equal(
          malformedMovementResult.diagnostics.some(
            (diagnostic) =>
              diagnostic.code === 'INVENTORY_CONTRACT_INVALID' &&
              diagnostic.path === '$.fields.inventory_movement_item_id' &&
              diagnostic.subjectId === malformedMovementField.fieldId,
          ),
          true,
          'the malformed movement companion must retain its exact pinned-ABI diagnostic',
        );
      }

      const movementFieldLocalIds = definition.fields
        .filter((field) => field.entity.targetId === movementEntityId)
        .map((field) => field.fieldId.split(':field.')[1])
        .filter((fieldLocalId): fieldLocalId is string =>
          Boolean(fieldLocalId),
        );
      assert.equal(
        movementFieldLocalIds.length,
        16,
        'the movement storage-metadata table must cover the complete pinned field set',
      );
      const movementStorageMutations: Array<{
        diagnosticSuffix: string;
        fieldLocalId: string;
        label: string;
        mutate: (field: (typeof definition.fields)[number]) => void;
      }> = [
        ...movementFieldLocalIds.map((fieldLocalId) => ({
          diagnosticSuffix: '.businessKey',
          fieldLocalId,
          label: `${fieldLocalId} business key`,
          mutate: (field: (typeof definition.fields)[number]) => {
            field.businessKey = 'tenantEnvironmentCaseInsensitiveUnique';
          },
        })),
        {
          diagnosticSuffix: '.collation',
          fieldLocalId: 'inventory_movement_source_type',
          label: 'movement source-type collation',
          mutate: (field) => {
            field.collation = 'unicodeCaseInsensitive';
          },
        },
        {
          diagnosticSuffix: '.defaultSemantics',
          fieldLocalId: 'inventory_movement_location_id',
          label: 'required movement default semantics',
          mutate: (field) => {
            field.defaultSemantics = 'nullable';
          },
        },
        {
          diagnosticSuffix: '.defaultSemantics',
          fieldLocalId: 'inventory_movement_reason_code',
          label: 'optional movement default semantics',
          mutate: (field) => {
            field.defaultSemantics = 'none';
          },
        },
        {
          diagnosticSuffix: '.searchable',
          fieldLocalId: 'inventory_movement_source_id',
          label: 'movement indexed search mapping',
          mutate: (field) => {
            field.searchable = false;
          },
        },
        {
          diagnosticSuffix: '.searchable',
          fieldLocalId: 'inventory_movement_source_type',
          label: 'movement unindexed search mapping',
          mutate: (field) => {
            field.searchable = true;
          },
        },
        {
          diagnosticSuffix: '.storageEvolution',
          fieldLocalId: 'inventory_movement_source_line',
          label: 'movement storage evolution',
          mutate: (field) => {
            field.storageEvolution = {
              kind: 'backfillEvolution',
              residualReadSemantics: 'requiresCompleteness',
              schemaVersion: definition.languageVersion,
            };
          },
        },
      ];
      for (const {
        diagnosticSuffix,
        fieldLocalId,
        label,
        mutate,
      } of movementStorageMutations) {
        const incompatible = structuredClone(definition);
        const field = incompatible.fields.find(
          (candidate) =>
            candidate.fieldId ===
            `${INVENTORY_NAMESPACE}:field.${fieldLocalId}`,
        );
        assert.ok(field);
        mutate(field);
        const result = compileApplication(moduleInput(incompatible));
        assertProviderExemptionWithheld(
          result,
          `${label} incompatibility must return every authored CRUD/Form requirement`,
        );
        if (result.status !== 'failed') continue;
        assert.equal(
          result.diagnostics.some(
            (diagnostic) =>
              diagnostic.code === 'INVENTORY_CONTRACT_INVALID' &&
              diagnostic.path ===
                `$.fields.${fieldLocalId}${diagnosticSuffix}` &&
              diagnostic.subjectId === field.fieldId,
          ),
          true,
          `${label} must be refused by its exact movement ABI path and subject`,
        );
      }
    },
  );

  register(
    'entity-owned Inventory reads declare one legal-entity operand while the master stays tenant-shared',
    () => {
      const authoredModule = inventoryModuleDefinition();
      // `5g3-sm-impl` finding 4: `normalize.ts` MINTS this parameter type, and
      // minted it at a hand-written 'v4'. The emitter now derives from
      // `authored.languageVersion`; this assertion did not, so it went on
      // pinning the literal the emitter had stopped producing. The fact under
      // test is that the minted node carries ITS OWN PACKAGE's version -- an
      // emitter naming any other version is `CANON_VERSION_MIXED` -- so the
      // package under test is the source, not a constant and not a literal.
      const mintedNodeVersion = (authoredModule as { languageVersion: string })
        .languageVersion;
      const compiled = mustCompileModule(authoredModule);
      const queries = projectionPayload<{
        queries: Array<{
          legalEntityScope?: {
            cardinality: string;
            operand: { parameterId: string };
          };
          parameters?: Array<{
            orderKey: number;
            parameterId: string;
            parameterType: { kind: string; schemaVersion: string };
          }>;
          queryId: string;
          queryType: string;
        }>;
      }>(compiled, PROJECTION_FAMILY_IDS.queryCatalog).queries;
      const scoped = queries.filter((query) => query.legalEntityScope);
      assert.equal(scoped.length, 27);
      const scopedRowQueries = scoped.filter(
        (query) => query.queryType !== 'aggregate',
      );
      assert.equal(scopedRowQueries.length, 26);
      assert.equal(
        queries.some(
          (query) =>
            query.queryId ===
            'northstar.inventory:query.inventory_period_lock_resolve',
        ),
        false,
        'the timestamp-only period-lock family declares no unusable text resolver',
      );
      for (const query of scopedRowQueries) {
        assert.equal(query.legalEntityScope?.cardinality, 'exactlyOne');
        assert.deepEqual(query.parameters, [
          {
            orderKey: 10,
            parameterId: query.legalEntityScope?.operand.parameterId,
            parameterType: {
              kind: 'legalEntityReferenceParameterType',
              schemaVersion: mintedNodeVersion,
            },
          },
        ]);
      }
      const scopedAggregateQueries = scoped.filter(
        (query) => query.queryType === 'aggregate',
      );
      assert.equal(scopedAggregateQueries.length, 1);
      const onHand = scopedAggregateQueries[0]!;
      assert.equal(
        onHand.queryId,
        `${INVENTORY_NAMESPACE}:query.inventory_movement_on_hand`,
      );
      assert.equal(onHand.legalEntityScope?.cardinality, 'exactlyOne');
      assert.deepEqual(
        onHand.parameters?.filter(
          (parameter) =>
            parameter.parameterId ===
            onHand.legalEntityScope?.operand.parameterId,
        ),
        [
          {
            orderKey: 10,
            parameterId: `${INVENTORY_NAMESPACE}:parameter.on_hand_legal_entity_id`,
            parameterType: {
              kind: 'legalEntityReferenceParameterType',
              schemaVersion: mintedNodeVersion,
            },
          },
        ],
      );
      assert.equal(
        queries
          .filter((query) => query.queryId.includes(':query.legal_entity_'))
          .some((query) => query.legalEntityScope),
        false,
      );
    },
  );

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
      assert.equal(INVENTORY_STORAGE_REFERENCES_V1.length, 7);
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
        7,
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
        version: number;
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
      assert.equal(dependencies.version, 4);
      assert.equal(dependencies.dependencies.length, 35);
      assert.deepEqual(
        contract.countEvidence,
        INVENTORY_CONTRACT_V1.countEvidence,
      );
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

      const withRetiredMoney = structuredClone(inventoryModuleDefinition()) as {
        fields: Array<Record<string, unknown>>;
      };
      const retiredQuantity = withRetiredMoney.fields.find((field) =>
        String(field.fieldId).endsWith(
          ':field.inventory_movement_quantity_delta',
        ),
      );
      assert.ok(retiredQuantity);
      withRetiredMoney.fields.push({
        ...structuredClone(retiredQuantity),
        fieldId: 'northstar.inventory:field.inventory_movement_unit_cost',
        label: 'Unit cost',
        lifecycle: 'retired',
        orderKey: 170,
      });
      const retiredMoneyResult = compileApplication(
        moduleInput(withRetiredMoney),
      );
      assert.equal(retiredMoneyResult.status, 'failed');
      assert.equal(
        retiredMoneyResult.diagnostics.some(
          ({ code, subjectId }) =>
            code === 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN' &&
            subjectId ===
              'northstar.inventory:field.inventory_movement_unit_cost',
        ),
        true,
      );

      const withRetiredMovement = structuredClone(
        inventoryModuleDefinition(),
      ) as {
        entities: Array<{ entityId: string; lifecycle?: string }>;
      };
      const retiredMovement = withRetiredMovement.entities.find((entity) =>
        entity.entityId.endsWith(':entity.inventory_movement'),
      );
      assert.ok(retiredMovement);
      retiredMovement.lifecycle = 'retired';
      const retiredMovementResult = compileApplication(
        moduleInput(withRetiredMovement),
      );
      assert.equal(retiredMovementResult.status, 'failed');
      assert.equal(
        retiredMovementResult.diagnostics.some(
          ({ code, path, subjectId }) =>
            code === 'INVENTORY_CONTRACT_INVALID' &&
            path === '$.entities.inventory_movement.lifecycle' &&
            subjectId === 'northstar.inventory:entity.inventory_movement',
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

  for (const familyLocalId of [
    'legal_entity',
    'inventory_transaction',
    'inventory_transaction_line',
    'inventory_period_lock',
    'inventory_movement',
    'stock_count',
    'stock_count_line',
  ] as const) {
    register(
      `the Inventory module requires the ${familyLocalId} family`,
      () => {
        const result = compileApplication(
          moduleInput(inventoryDefinitionWithoutFamily(familyLocalId)),
        );
        assertCompileDiagnostic(
          result,
          'INVENTORY_CONTRACT_INVALID',
          `$.entities.${familyLocalId}`,
          `northstar.inventory:entity.${familyLocalId}`,
        );
      },
    );
  }

  register(
    'stock-count entities preserve expected, counted, and variance as three exact recorded fields',
    () => {
      const definition = inventoryModuleDefinition() as {
        fields: Array<Record<string, unknown>>;
        relations: Array<Record<string, unknown>>;
      };
      const lineFields = definition.fields
        .filter((field) =>
          String((field.entity as { targetId?: unknown }).targetId).endsWith(
            ':entity.stock_count_line',
          ),
        )
        .map((field) => String(field.fieldId).split(':field.').at(-1));
      assert.deepEqual(lineFields, [
        'stock_count_line_line_number',
        'stock_count_line_item_id',
        'stock_count_line_expected_quantity',
        'stock_count_line_counted_quantity',
        'stock_count_line_variance_quantity',
        'stock_count_line_unit_id',
        'stock_count_line_reversal_of_movement_id',
      ]);
      for (const victim of [
        'stock_count_line_expected_quantity',
        'stock_count_line_counted_quantity',
        'stock_count_line_variance_quantity',
      ]) {
        const mutation = inventoryDefinitionWithoutCountEvidenceField(victim);
        const result = compileApplication(moduleInput(mutation));
        assertOnlyCompileDiagnostic(
          result,
          'INVENTORY_COUNT_EVIDENCE_INVALID',
          `$.fields.${victim}`,
          `northstar.inventory:field.${victim}`,
        );
      }
      for (const relationLocalId of [
        'stock_count_transaction',
        'stock_count_supersedes',
        'stock_count_line_session',
        'stock_count_line_transaction_line',
      ]) {
        const mutation = structuredClone(inventoryModuleDefinition()) as {
          relations: Array<{ relationId: string }>;
        };
        mutation.relations = mutation.relations.filter(
          (relation) =>
            !relation.relationId.endsWith(`:relation.${relationLocalId}`),
        );
        const result = compileApplication(moduleInput(mutation));
        assertCompileDiagnostic(
          result,
          'INVENTORY_COUNT_EVIDENCE_INVALID',
          `$.relations.${relationLocalId}`,
          `northstar.inventory:relation.${relationLocalId}`,
        );
      }
    },
  );

  for (const fieldLocalId of [
    'inventory_transaction_line_item_id',
    'inventory_transaction_line_from_location_id',
    'inventory_transaction_line_to_location_id',
  ] as const) {
    for (const mutation of ['retired', 'boolean'] as const) {
      register(
        `the Inventory ${fieldLocalId} reference rejects a ${mutation} field`,
        () => {
          const definition = structuredClone(inventoryModuleDefinition()) as {
            fields: Array<Record<string, unknown>>;
            languageVersion: string;
          };
          const field = definition.fields.find((candidate) =>
            String(candidate.fieldId).endsWith(`:field.${fieldLocalId}`),
          );
          assert.ok(field);
          if (mutation === 'retired') field.lifecycle = 'retired';
          else {
            field.fieldType = {
              kind: 'booleanFieldType',
              schemaVersion: definition.languageVersion,
            };
          }
          const result = compileApplication(moduleInput(definition));
          assertCompileDiagnostic(
            result,
            'INVENTORY_CONTRACT_INVALID',
            `$.fields.${fieldLocalId}`,
            `northstar.inventory:field.${fieldLocalId}`,
          );
        },
      );
    }
  }

  for (const mutation of ['retired', 'boolean'] as const) {
    register(
      `the Catalog base-unit binding rejects a ${mutation} field`,
      () => {
        const definition = structuredClone(catalogModuleDefinition()) as {
          fields: Array<Record<string, unknown>>;
          languageVersion: string;
        };
        const field = definition.fields.find((candidate) =>
          String(candidate.fieldId).endsWith(':field.item_base_unit'),
        );
        assert.ok(field);
        if (mutation === 'retired') field.lifecycle = 'retired';
        else {
          field.fieldType = {
            kind: 'booleanFieldType',
            schemaVersion: definition.languageVersion,
          };
        }
        const result = compileApplication(moduleInput(definition));
        assertCompileDiagnostic(
          result,
          'INVENTORY_CONTRACT_INVALID',
          '$.fields.item_base_unit',
          'northstar.catalog:field.item_base_unit',
        );
      },
    );
  }

  register('every Inventory movement query retains recordedAt', () => {
    const definition = structuredClone(inventoryModuleDefinition()) as {
      queries: Array<{
        selections?: Array<{ field: { targetId: string } }>;
        sourceEntity: { targetId: string };
      }>;
    };
    let changedQueries = 0;
    for (const query of definition.queries) {
      if (!query.sourceEntity.targetId.endsWith(':entity.inventory_movement')) {
        continue;
      }
      // Aggregates have no selections to strip. They retain recorded time by
      // ANCHORING to a recorded horizon in their filter, which G3-P0 item 5
      // requires ("discards"), not by projecting the column. The separate
      // aggregate case below is what keeps this a skip rather than an
      // exemption.
      if (query.selections === undefined) continue;
      const retained = query.selections.filter(
        (selection) =>
          !selection.field.targetId.endsWith(
            ':field.inventory_movement_recorded_at',
          ),
      );
      if (retained.length !== query.selections.length) changedQueries += 1;
      query.selections = retained;
    }
    assert.equal(changedQueries, 4);
    const result = compileApplication(moduleInput(definition));
    assertCompileDiagnostic(
      result,
      'INVENTORY_CONTRACT_INVALID',
      '$.queries.inventory_movement_recorded_at',
      'northstar.inventory:field.inventory_movement_recorded_at',
    );
  });

  register(
    'every Inventory movement aggregate anchors to a recorded horizon',
    () => {
      const definition = structuredClone(inventoryModuleDefinition()) as {
        queries: Array<{
          aggregate?: unknown;
          filter?: unknown;
          queryId: string;
          selections?: unknown;
          sourceEntity: { targetId: string };
        }>;
      };
      const aggregates = definition.queries.filter(
        (query) =>
          query.sourceEntity.targetId.endsWith(':entity.inventory_movement') &&
          query.selections === undefined,
      );
      assert.ok(
        aggregates.length > 0,
        'no movement aggregate found; this control would be vacuous',
      );
      for (const aggregate of aggregates) {
        assert.ok(
          JSON.stringify(aggregate.filter ?? null).includes(
            ':field.inventory_movement_recorded_at',
          ),
          `${aggregate.queryId} does not anchor to a recorded horizon`,
        );
      }
    },
  );

  register('period-lock advance is bound to its matching permission', () => {
    const definition = structuredClone(inventoryModuleDefinition()) as {
      operations: Array<{
        operationId: string;
        permission: { targetId: string };
      }>;
    };
    const advance = definition.operations.find((operation) =>
      operation.operationId.endsWith(':operation.advance_period_lock'),
    );
    assert.ok(advance);
    advance.permission.targetId =
      'northstar.inventory:permission.reopen_period';
    const result = compileApplication(moduleInput(definition));
    assertCompileDiagnostic(
      result,
      'INVENTORY_CONTRACT_INVALID',
      '$.operations.advance_period_lock.permission',
      'northstar.inventory:operation.advance_period_lock',
    );
  });

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
          schemaVersion: definition.languageVersion,
          targetId: periodEntityId,
        },
      });
      operations.push({
        ...structuredClone(templateOperation),
        effect: {
          entity: {
            kind: 'entityReference',
            schemaVersion: definition.languageVersion,
            targetId: periodEntityId,
          },
          kind: 'createRecordEffect',
          schemaVersion: definition.languageVersion,
        },
        operationId:
          'northstar.inventory:operation.inventory_period_lock_create',
        permission: {
          kind: 'permissionReference',
          schemaVersion: definition.languageVersion,
          targetId: permissionId,
        },
        readBack: {
          kind: 'queryReference',
          schemaVersion: definition.languageVersion,
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
      assert.deepEqual(compiled.release.contract.readModels, {
        authoredOperations: 'forbidden',
        providerWritten: INVENTORY_PROVIDER_WRITTEN_READ_MODELS_V1,
      });

      const wrongMaintainer = mutableContract();
      wrongMaintainer.readModels.providerWritten[0]!.maintainerId =
        'northstar.postgresql-module-provider:unmaintained/v1';
      const wrongMaintainerResult = compileInventoryContract(wrongMaintainer);
      assert.equal(wrongMaintainerResult.status, 'failed');
      assertHasDiagnostic(
        wrongMaintainerResult.diagnostics,
        'INVENTORY_CONTRACT_INVALID',
        '$.readModels.providerWritten.posted_stock_balance',
        'posted_stock_balance',
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

      const missingPostedStockFamily = mutableContract();
      missingPostedStockFamily.legalEntity.families =
        missingPostedStockFamily.legalEntity.families.filter(
          (rule) => rule.familyId !== 'posted_stock_balance',
        );
      const missingPostedStockResult = compileInventoryContract(
        missingPostedStockFamily,
      );
      assert.equal(missingPostedStockResult.status, 'failed');
      assertHasDiagnostic(
        missingPostedStockResult.diagnostics,
        'INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED',
        '$.legalEntity.families.posted_stock_balance',
        'posted_stock_balance',
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

      const countMoneyValue = mutableContract();
      countMoneyValue.countEvidence.lineValues.push({
        fieldId: 'unitCost',
        presence: 'required',
        semantic: 'ordinaryQuantity',
        valueShape: { representation: 'canonicalDecimalStringV2' },
      });
      const countMoneyResult = compileInventoryContract(countMoneyValue);
      assert.equal(countMoneyResult.status, 'failed');
      assertHasDiagnostic(
        countMoneyResult.diagnostics,
        'INVENTORY_COUNT_EVIDENCE_MONEY_FORBIDDEN',
        '$.countEvidence.lineValues.3.fieldId',
        'unitCost',
      );
    },
  );

  register(
    'the count-evidence contract requires expected, counted, and variance independently',
    () => {
      for (const fieldId of [
        'expectedQuantity',
        'countedQuantity',
        'varianceQuantity',
      ]) {
        const candidate = mutableContract();
        candidate.countEvidence.lineValues =
          candidate.countEvidence.lineValues.filter(
            (value) => value.fieldId !== fieldId,
          );
        const result = compileInventoryContract(candidate);
        assert.equal(result.status, 'failed');
        assertHasDiagnostic(
          result.diagnostics,
          'INVENTORY_COUNT_EVIDENCE_INVALID',
          '$.countEvidence.lineValues',
          null,
        );
      }
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

    for (const dependencyId of [
      'northstar.inventory:transaction_line',
      'northstar.trust:outbox_event',
    ]) {
      const missingRequiredRead = mutableContract();
      for (const key of ['dependencies', 'accessPlan'] as const) {
        missingRequiredRead.authoritativeDependencies[key] =
          missingRequiredRead.authoritativeDependencies[key].filter(
            (entry) => entry.dependencyId !== dependencyId,
          );
      }
      const missingRequiredReadResult =
        compileInventoryContract(missingRequiredRead);
      assert.equal(missingRequiredReadResult.status, 'failed');
      assertHasDiagnostic(
        missingRequiredReadResult.diagnostics,
        'INVENTORY_CONTRACT_INVALID',
        '$.authoritativeDependencies.dependencies',
        'dependencies',
      );
    }

    const oldDependencyProtocol = mutableContract();
    for (const key of ['dependencies', 'accessPlan'] as const) {
      oldDependencyProtocol.authoritativeDependencies[key] =
        oldDependencyProtocol.authoritativeDependencies[key].filter(
          (entry) =>
            ![
              'northstar.inventory:stock_count',
              'northstar.inventory:stock_count_line',
              'northstar.inventory:stock_count.state',
            ].includes(String(entry.dependencyId)),
        );
    }
    oldDependencyProtocol.authoritativeDependencies.version = 3;
    oldDependencyProtocol.authoritativeDependencies.dependencySetRoot =
      '35fc38eaca7fbe47d8da5030ceefce8211a2194a25d233c45282ef0450d553ad';
    const oldDependencyProtocolResult = compileInventoryContract(
      oldDependencyProtocol,
    );
    assert.equal(oldDependencyProtocolResult.status, 'failed');
    assertHasDiagnostic(
      oldDependencyProtocolResult.diagnostics,
      'INVENTORY_CONTRACT_INVALID',
      '$.authoritativeDependencies.version',
      'version',
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
  const normalized = normalizeApplicationPackage(definition);
  return {
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    // Version-from-artifact: the profile follows the definition's own declared
    // version, never a pinned constant.
    profile: {
      ...MODULE_COMPILER_PROFILE,
      languageVersion: normalized.languageVersion,
      normalizationProfileVersion: normalized.normalizationProfileVersion,
    },
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
    assertions: Array<Record<string, unknown>>;
    fields: Array<{ fieldId: string }>;
    queries: Array<{
      queryId: string;
      selections?: Array<{ field: { targetId: string } }>;
    }>;
    surfaces: Array<Record<string, unknown>>;
  };
  const suffix = `:field.${fieldLocalId}`;
  definition.fields = definition.fields.filter(
    (field) => !field.fieldId.endsWith(suffix),
  );
  // An aggregate references the removed field through its aggregate and filter
  // rather than through selections, so stripping selections alone leaves a
  // dangling reference and normalization fails with CANON_REFERENCE_UNRESOLVED
  // BEFORE the inventory contract rule this fixture exists to provoke. Drop the
  // referencing aggregate so the fixture stays valid until its target rule --
  // the discipline G3-P4b recorded after the same trap.
  const droppedQueryIds = definition.queries
    .filter(
      (query) =>
        query.selections === undefined &&
        JSON.stringify(query).includes(suffix),
    )
    .map((query) => query.queryId);
  definition.queries = definition.queries.filter(
    (query) => !droppedQueryIds.includes(query.queryId),
  );
  // Dropping a query orphans whatever referenced it, so removal must be
  // transitive or normalization fails on an orphaned assertion or surface
  // instead of on the field this fixture exists to remove.
  definition.assertions = definition.assertions.filter(
    (assertion) =>
      !droppedQueryIds.some((queryId) =>
        JSON.stringify(assertion).includes(queryId),
      ),
  );
  definition.surfaces = definition.surfaces.filter(
    (surface) =>
      !droppedQueryIds.some((queryId) =>
        JSON.stringify(surface).includes(queryId),
      ),
  );
  for (const query of definition.queries) {
    if (query.selections === undefined) continue;
    query.selections = query.selections.filter(
      (selection) => !selection.field.targetId.endsWith(suffix),
    );
  }
  return definition;
}

function inventoryDefinitionWithoutCountEvidenceField(
  fieldLocalId: string,
): Record<string, unknown> {
  const definition = structuredClone(inventoryModuleDefinition()) as {
    fields: Array<{ fieldId: string }>;
    queries: Array<{
      resolveMatchKeys?: Array<{ field: { targetId: string } }>;
      selections: Array<{ field: { targetId: string } }>;
    }>;
  };
  const fieldId = `northstar.inventory:field.${fieldLocalId}`;
  definition.fields = definition.fields.filter(
    (field) => field.fieldId !== fieldId,
  );
  let removedSelections = 0;
  let replacedMatchKeys = 0;
  for (const query of definition.queries) {
    // Aggregate queries carry no `selections`. Inventory's first aggregate
    // arrived with onHand, so a helper that assumed every query is a row query
    // would throw here rather than mutate the fixture it was asked to mutate.
    if (query.selections !== undefined) {
      const retained = query.selections.filter(
        (selection) => selection.field.targetId !== fieldId,
      );
      removedSelections += query.selections.length - retained.length;
      query.selections = retained;
    }
    for (const matchKey of query.resolveMatchKeys ?? []) {
      if (matchKey.field.targetId !== fieldId) continue;
      replacedMatchKeys += 1;
    }
  }
  assert.equal(removedSelections, 4);
  assert.equal(replacedMatchKeys, 0);
  assert.equal(containsAnyExactString(definition, new Set([fieldId])), false);
  return definition;
}

function inventoryDefinitionWithoutFamily(
  familyLocalId: string,
): Record<string, unknown> {
  const definition = structuredClone(inventoryModuleDefinition()) as Record<
    string,
    unknown
  >;
  const entityId = `northstar.inventory:entity.${familyLocalId}`;
  const fields = definition.fields as Array<Record<string, unknown>>;
  const storageMappings = definition.storageMappings as Array<
    Record<string, unknown>
  >;
  const queries = definition.queries as Array<Record<string, unknown>>;
  const operations = definition.operations as Array<Record<string, unknown>>;
  const permissions = definition.permissions as Array<Record<string, unknown>>;

  const fieldIds = new Set(
    fields
      .filter((field) => referenceTarget(field.entity) === entityId)
      .map((field) => String(field.fieldId)),
  );
  const storageIds = new Set(
    storageMappings
      .filter((mapping) => referenceTarget(mapping.entity) === entityId)
      .map((mapping) => String(mapping.storageMappingId)),
  );
  const queryIds = new Set(
    queries
      .filter((query) => referenceTarget(query.sourceEntity) === entityId)
      .map((query) => String(query.queryId)),
  );
  const operationIds = new Set(
    operations
      .filter(
        (operation) =>
          (typeof operation.effect === 'object' &&
            operation.effect !== null &&
            referenceTarget(
              (operation.effect as Record<string, unknown>).entity,
            ) === entityId) ||
          queryIds.has(referenceTarget(operation.readBack) ?? ''),
      )
      .map((operation) => String(operation.operationId)),
  );
  const permissionIds = new Set(
    permissions
      .filter((permission) => referenceTarget(permission.resource) === entityId)
      .map((permission) => String(permission.permissionId)),
  );
  const removedIds = new Set<string>([
    entityId,
    ...fieldIds,
    ...storageIds,
    ...queryIds,
    ...operationIds,
    ...permissionIds,
  ]);
  for (const collection of [
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
    definition[collection] = (
      definition[collection] as Array<Record<string, unknown>>
    ).filter((entry) => !containsAnyExactString(entry, removedIds));
  }
  return definition;
}

function referenceTarget(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const targetId = (value as Record<string, unknown>).targetId;
  return typeof targetId === 'string' ? targetId : null;
}

function containsAnyExactString(
  value: unknown,
  removedIds: ReadonlySet<string>,
): boolean {
  if (typeof value === 'string') return removedIds.has(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsAnyExactString(entry, removedIds));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((entry) =>
      containsAnyExactString(entry, removedIds),
    );
  }
  return false;
}

function assertCompileDiagnostic(
  result: ReturnType<typeof compileApplication>,
  code: string,
  path: string,
  subjectId: string,
): void {
  assert.equal(
    result.status,
    'failed',
    result.status === 'compiled'
      ? JSON.stringify(result.diagnostics)
      : undefined,
  );
  if (result.status !== 'failed') return;
  assert.equal(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === code &&
        diagnostic.path === path &&
        diagnostic.subjectId === subjectId,
    ),
    true,
    JSON.stringify(result.diagnostics),
  );
}

function assertOnlyCompileDiagnostic(
  result: ReturnType<typeof compileApplication>,
  code: string,
  path: string,
  subjectId: string,
): void {
  assert.equal(
    result.status,
    'failed',
    result.status === 'compiled'
      ? JSON.stringify(result.diagnostics)
      : undefined,
  );
  if (result.status !== 'failed') return;
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      path: diagnostic.path,
      subjectId: diagnostic.subjectId,
    })),
    [{ code, path, subjectId }],
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
    dependencySetRoot: string;
    dependencies: Array<{ access: string; dependencyId: string }>;
    version: number;
  };
  return {
    configuration: compiled.release.configuration,
    configurationScope: compiled.release.configurationScope,
    countEvidence: contract.countEvidence,
    dependencySet: dependencies.dependencies.map(
      (entry) => `${entry.access}:${entry.dependencyId}`,
    ),
    dependencySetRoot: dependencies.dependencySetRoot,
    dependencySetVersion: dependencies.version,
    legalEntity: contract.legalEntity,
    readModels: contract.readModels,
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
