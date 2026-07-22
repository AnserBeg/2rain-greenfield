import type { NormalizedApplicationPackage } from '@north-star/canonical-model';

import { hashCanonical } from './hash.js';
import {
  HASH_DOMAINS,
  OPERATIONS_AGENT_TOOL_IDS,
  POLICY_MODEL_VERSION,
  PROJECTION_FAMILY_IDS,
  type LogicalScope,
  type ProjectionFamilyId,
  type RuntimeCapabilityRequirement,
} from './protocol.js';

export interface ProjectionPayloadPlan {
  familyId: ProjectionFamilyId;
  instanceId: string;
  logicalScope: LogicalScope;
  payload: unknown;
  payloadSchemaVersion: string;
  requiredRuntimeCapability: RuntimeCapabilityRequirement;
}

const payloadSchemaVersions: Record<
  Exclude<ProjectionFamilyId, typeof PROJECTION_FAMILY_IDS.storageTransition>,
  string
> = {
  [PROJECTION_FAMILY_IDS.agentDiscovery]:
    'northstar.agent-discovery-payload/v0-provisional',
  [PROJECTION_FAMILY_IDS.operationCatalog]:
    'northstar.operation-catalog-payload/v0-provisional',
  [PROJECTION_FAMILY_IDS.policyReferences]:
    'northstar.policy-references-payload/v0-provisional',
  [PROJECTION_FAMILY_IDS.queryCatalog]:
    'northstar.query-catalog-payload/v0-provisional',
  [PROJECTION_FAMILY_IDS.semanticModel]:
    'northstar.semantic-model-payload/v0-provisional',
  [PROJECTION_FAMILY_IDS.storageTarget]:
    'northstar.storage-target-payload/v0-provisional',
  [PROJECTION_FAMILY_IDS.surfaceManifest]:
    'northstar.surface-manifest-payload/v0-provisional',
  [PROJECTION_FAMILY_IDS.verificationPlan]:
    'northstar.verification-plan-payload/v0-provisional',
};

const runtimeCapabilities: Record<
  Exclude<ProjectionFamilyId, typeof PROJECTION_FAMILY_IDS.storageTransition>,
  RuntimeCapabilityRequirement
> = {
  [PROJECTION_FAMILY_IDS.agentDiscovery]: {
    capabilityId: 'northstar.runtime:capability.agent-discovery',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.operationCatalog]: {
    capabilityId: 'northstar.runtime:capability.operation-catalog',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.policyReferences]: {
    capabilityId: 'northstar.runtime:capability.policy-references',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.queryCatalog]: {
    capabilityId: 'northstar.runtime:capability.query-catalog',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.semanticModel]: {
    capabilityId: 'northstar.runtime:capability.semantic-model',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.storageTarget]: {
    capabilityId: 'northstar.runtime:capability.storage-target',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.surfaceManifest]: {
    capabilityId: 'northstar.runtime:capability.surface-manifest',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.verificationPlan]: {
    capabilityId: 'northstar.runtime:capability.verification-plan',
    minimumVersion: 1,
  },
};

export function lowerBaseProjectionPayloads(
  packageRevision: NormalizedApplicationPackage,
): ProjectionPayloadPlan[] {
  const namespace = packageRevision.package.namespace;
  const packageScope: LogicalScope = {
    kind: 'packageScope',
    scopeId: packageRevision.package.packageId,
  };
  const queryById = new Map(
    packageRevision.queries.map((query) => [query.queryId, query] as const),
  );

  return [
    plan(
      PROJECTION_FAMILY_IDS.semanticModel,
      namespace,
      packageScope,
      semanticModelPayload(packageRevision),
    ),
    plan(
      PROJECTION_FAMILY_IDS.storageTarget,
      namespace,
      packageScope,
      storageTargetPayload(packageRevision),
    ),
    plan(
      PROJECTION_FAMILY_IDS.queryCatalog,
      namespace,
      packageScope,
      queryCatalogPayload(packageRevision),
    ),
    plan(
      PROJECTION_FAMILY_IDS.operationCatalog,
      namespace,
      packageScope,
      operationCatalogPayload(packageRevision),
    ),
    plan(
      PROJECTION_FAMILY_IDS.surfaceManifest,
      namespace,
      packageScope,
      surfaceManifestPayload(packageRevision, queryById),
    ),
    plan(
      PROJECTION_FAMILY_IDS.policyReferences,
      namespace,
      packageScope,
      policyReferencesPayload(packageRevision),
    ),
    plan(
      PROJECTION_FAMILY_IDS.agentDiscovery,
      namespace,
      packageScope,
      agentDiscoveryPayload(packageRevision),
    ),
    plan(
      PROJECTION_FAMILY_IDS.verificationPlan,
      namespace,
      packageScope,
      verificationPlanPayload(packageRevision),
    ),
  ];
}

export function requiredProjectionFamily(
  requirement: string,
): ProjectionFamilyId | null {
  const mapping: Record<string, ProjectionFamilyId | null> = {
    agent: PROJECTION_FAMILY_IDS.agentDiscovery,
    operation: PROJECTION_FAMILY_IDS.operationCatalog,
    policy: PROJECTION_FAMILY_IDS.policyReferences,
    query: PROJECTION_FAMILY_IDS.queryCatalog,
    reporting: null,
    storage: PROJECTION_FAMILY_IDS.storageTarget,
    surface: PROJECTION_FAMILY_IDS.surfaceManifest,
    verification: PROJECTION_FAMILY_IDS.verificationPlan,
  };
  return mapping[requirement] ?? null;
}

function plan(
  familyId: Exclude<
    ProjectionFamilyId,
    typeof PROJECTION_FAMILY_IDS.storageTransition
  >,
  namespace: string,
  logicalScope: LogicalScope,
  payload: unknown,
): ProjectionPayloadPlan {
  const suffix = familyId.slice(familyId.lastIndexOf('.') + 1);
  return {
    familyId,
    instanceId: `${namespace}:projection.${suffix}`,
    logicalScope,
    payload,
    payloadSchemaVersion: payloadSchemaVersions[familyId],
    requiredRuntimeCapability: runtimeCapabilities[familyId],
  };
}

function semanticModelPayload(
  packageRevision: NormalizedApplicationPackage,
): unknown {
  const constructs: Array<{
    constructKind: string;
    semanticFingerprint: string;
    subjectId: string;
  }> = [];
  const add = (constructKind: string, subjectId: string, value: unknown) => {
    constructs.push({
      constructKind,
      semanticFingerprint: hashCanonical(HASH_DOMAINS.semanticConstruct, value)
        .digest,
      subjectId,
    });
  };

  add(
    packageRevision.package.kind,
    packageRevision.package.packageId,
    packageRevision.package,
  );
  addFamily(constructs, packageRevision.modules, 'moduleId');
  addFamily(constructs, packageRevision.entities, 'entityId');
  addFamily(constructs, packageRevision.fields, 'fieldId');
  addFamily(constructs, packageRevision.relations, 'relationId');
  addFamily(constructs, packageRevision.surfaces, 'surfaceId');
  addFamily(constructs, packageRevision.queries, 'queryId');
  addFamily(constructs, packageRevision.operations, 'operationId');
  addFamily(constructs, packageRevision.permissions, 'permissionId');
  addFamily(constructs, packageRevision.assertions, 'assertionId');
  addFamily(constructs, packageRevision.storageMappings, 'storageMappingId');
  addFamily(constructs, packageRevision.capabilityRequirements, 'capabilityId');
  for (const machine of packageRevision.stateMachines) {
    add(machine.kind, machine.machineId, machine);
    for (const state of machine.states) add(state.kind, state.stateId, state);
    for (const transition of machine.transitions) {
      add(transition.kind, transition.transitionId, transition);
    }
  }

  constructs.sort((left, right) => compare(left.subjectId, right.subjectId));
  return {
    constructs,
    kind: 'semanticModelPayload',
    schemaVersion: payloadSchemaVersions[PROJECTION_FAMILY_IDS.semanticModel],
  };
}

function storageTargetPayload(
  packageRevision: NormalizedApplicationPackage,
): unknown {
  const fieldsByEntity = new Map<string, typeof packageRevision.fields>();
  for (const field of packageRevision.fields) {
    const fields = fieldsByEntity.get(field.entity.targetId) ?? [];
    fields.push(field);
    fieldsByEntity.set(field.entity.targetId, fields);
  }
  const stateFieldsByEntity = new Map<
    string,
    Array<{
      fieldId: string;
      lifecycle: string;
      stateMachineId: string;
      valueKind: 'stateId';
    }>
  >();
  for (const machine of packageRevision.stateMachines) {
    const stateFields = stateFieldsByEntity.get(machine.entity.targetId) ?? [];
    stateFields.push({
      fieldId: machine.stateField.fieldId,
      lifecycle: machine.lifecycle,
      stateMachineId: machine.machineId,
      valueKind: machine.stateField.valueKind,
    });
    stateFieldsByEntity.set(machine.entity.targetId, stateFields);
  }
  const storageById = new Map(
    packageRevision.storageMappings.map((mapping) => [
      mapping.storageMappingId,
      mapping,
    ]),
  );
  return {
    entities: packageRevision.entities.map((entity) => {
      const selectedStorage = storageById.get(entity.storage.targetId);
      return {
        derivedStateFields: stateFieldsByEntity.get(entity.entityId) ?? [],
        entityId: entity.entityId,
        fields: (fieldsByEntity.get(entity.entityId) ?? []).map((field) => ({
          classification: field.classification,
          fieldId: field.fieldId,
          fieldType: field.fieldType,
          lifecycle: field.lifecycle,
          presence: field.presence,
        })),
        lifecycle: entity.lifecycle,
        storageClass: selectedStorage?.storageClass ?? null,
        storageMappingId: entity.storage.targetId,
      };
    }),
    kind: 'storageTargetPayload',
    schemaVersion: payloadSchemaVersions[PROJECTION_FAMILY_IDS.storageTarget],
  };
}

function queryCatalogPayload(
  packageRevision: NormalizedApplicationPackage,
): unknown {
  return {
    kind: 'queryCatalogPayload',
    queries: packageRevision.queries.map((query) => ({
      filter: query.filter,
      lifecycle: query.lifecycle,
      maximumResultCount: query.maximumResultCount,
      permissionId: query.permission.targetId,
      queryId: query.queryId,
      queryType: query.queryType,
      selections: query.selections.map((selection) => ({
        fieldId: selection.field.targetId,
        orderKey: selection.orderKey,
        selectionId: selection.selectionId,
      })),
      sourceEntityId: query.sourceEntity.targetId,
      tier: query.tier,
    })),
    schemaVersion: payloadSchemaVersions[PROJECTION_FAMILY_IDS.queryCatalog],
  };
}

function operationCatalogPayload(
  packageRevision: NormalizedApplicationPackage,
): unknown {
  return {
    kind: 'operationCatalogPayload',
    operations: packageRevision.operations.map((operation) => ({
      confirmation: operation.confirmation,
      effect: operation.effect,
      lifecycle: operation.lifecycle,
      operationId: operation.operationId,
      permissionId: operation.permission.targetId,
      precondition: operation.precondition,
      readBackQueryId: operation.readBack.targetId,
      tier: operation.tier,
    })),
    schemaVersion:
      payloadSchemaVersions[PROJECTION_FAMILY_IDS.operationCatalog],
  };
}

function surfaceManifestPayload(
  packageRevision: NormalizedApplicationPackage,
  queryById: Map<string, NormalizedApplicationPackage['queries'][number]>,
): unknown {
  return {
    kind: 'surfaceManifestPayload',
    schemaVersion: payloadSchemaVersions[PROJECTION_FAMILY_IDS.surfaceManifest],
    surfaces: packageRevision.surfaces.map((surface) => ({
      archetype: surface.archetype,
      dataSourceQueryId: surface.dataSource.targetId,
      fieldIds:
        queryById
          .get(surface.dataSource.targetId)
          ?.selections.map((selection) => selection.field.targetId) ?? [],
      label: surface.label,
      lifecycle: surface.lifecycle,
      slots: surface.slots.map((slot) => ({
        contentReferenceId: slot.content.targetId,
        orderKey: slot.orderKey,
        slot: slot.slot,
        slotId: slot.slotId,
      })),
      statusRoles: surface.statusRoles,
      surfaceId: surface.surfaceId,
    })),
  };
}

function policyReferencesPayload(
  packageRevision: NormalizedApplicationPackage,
): unknown {
  return {
    decisionDependency: 'liveCurrentDenyCapable',
    kind: 'policyReferencesPayload',
    permissions: packageRevision.permissions.map((permission) => ({
      action: permission.action,
      lifecycle: permission.lifecycle,
      permissionId: permission.permissionId,
      resourceId: permission.resource.targetId,
    })),
    policyModelVersion: POLICY_MODEL_VERSION,
    schemaVersion:
      payloadSchemaVersions[PROJECTION_FAMILY_IDS.policyReferences],
  };
}

function agentDiscoveryPayload(
  packageRevision: NormalizedApplicationPackage,
): unknown {
  return {
    kind: 'agentDiscoveryPayload',
    operations: packageRevision.operations.map((operation) => ({
      operationId: operation.operationId,
      readBackQueryId: operation.readBack.targetId,
    })),
    queries: packageRevision.queries.map((query) => ({
      fieldIds: query.selections.map((selection) => selection.field.targetId),
      queryId: query.queryId,
    })),
    schemaVersion: payloadSchemaVersions[PROJECTION_FAMILY_IDS.agentDiscovery],
    surfaces: packageRevision.surfaces.map((surface) => surface.surfaceId),
    toolIds: [...OPERATIONS_AGENT_TOOL_IDS],
  };
}

function verificationPlanPayload(
  packageRevision: NormalizedApplicationPackage,
): unknown {
  return {
    assertions: packageRevision.assertions.map((assertion) => ({
      assertionId: assertion.assertionId,
      evidenceKinds: assertion.evidenceKinds,
      expectedDiagnosticCode: assertion.expectedDiagnosticCode,
      expectedOutcome: assertion.expectedOutcome,
      invocation: assertion.invocation,
    })),
    kind: 'verificationPlanPayload',
    schemaVersion:
      payloadSchemaVersions[PROJECTION_FAMILY_IDS.verificationPlan],
  };
}

function addFamily<T extends Record<string, unknown>>(
  constructs: Array<{
    constructKind: string;
    semanticFingerprint: string;
    subjectId: string;
  }>,
  values: T[],
  idKey: keyof T,
): void {
  for (const value of values) {
    const subjectId = value[idKey];
    const constructKind = value.kind;
    if (typeof subjectId !== 'string' || typeof constructKind !== 'string') {
      continue;
    }
    constructs.push({
      constructKind,
      semanticFingerprint: hashCanonical(HASH_DOMAINS.semanticConstruct, value)
        .digest,
      subjectId,
    });
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
