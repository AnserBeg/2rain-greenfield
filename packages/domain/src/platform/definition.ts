const version = 'v3' as const;
const normalizationProfileVersion = 'northstar.normalization/v3' as const;

export const PLATFORM_NAMESPACE = 'northstar.platform' as const;

const moduleId = `${PLATFORM_NAMESPACE}:module.saved_filters`;
const entityId = `${PLATFORM_NAMESPACE}:entity.saved_filter`;
const storageMappingId = `${PLATFORM_NAMESPACE}:storage.saved_filter`;
const contentCapabilityId = `${PLATFORM_NAMESPACE}:capability.standard_surface_content`;

const fieldIds = {
  criteria: `${PLATFORM_NAMESPACE}:field.saved_filter_criteria`,
  name: `${PLATFORM_NAMESPACE}:field.saved_filter_name`,
  queryId: `${PLATFORM_NAMESPACE}:field.saved_filter_query_id`,
} as const;

const queryIds = {
  get: `${PLATFORM_NAMESPACE}:query.saved_filter_get`,
  list: `${PLATFORM_NAMESPACE}:query.saved_filter_list`,
  resolve: `${PLATFORM_NAMESPACE}:query.saved_filter_resolve`,
  search: `${PLATFORM_NAMESPACE}:query.saved_filter_search`,
} as const;

const operationIds = {
  archive: `${PLATFORM_NAMESPACE}:operation.saved_filter_archive`,
  create: `${PLATFORM_NAMESPACE}:operation.saved_filter_create`,
  restore: `${PLATFORM_NAMESPACE}:operation.saved_filter_restore`,
  update: `${PLATFORM_NAMESPACE}:operation.saved_filter_update`,
} as const;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

/**
 * First-party platform definition data. The ordinary compiler press registers
 * the saved-filter entity and its Semantic Query/Operation contracts; the
 * provider supplies the trusted principal/release-scoped persistence semantics.
 */
export function platformModuleDefinition(): Record<string, unknown> {
  return {
    assertions: [
      {
        assertionId: `${PLATFORM_NAMESPACE}:assertion.saved_filter_walking_slice`,
        evidenceKinds: [
          'structure',
          'provider',
          'userInterface',
          'agent',
          'migration',
          'recovery',
        ],
        expectedDiagnosticCode: null,
        expectedOutcome: 'succeeds',
        invocation: {
          kind: 'queryInvocation',
          query: reference('queryReference', queryIds.get),
          schemaVersion: version,
        },
        kind: 'assertionDefinition',
        schemaVersion: version,
      },
    ],
    capabilityRequirements: [
      {
        capabilityId: contentCapabilityId,
        capabilityVersion: 1,
        declaredEffects: ['read'],
        kind: 'capabilityRequirement',
        requiredProjections: [
          'storage',
          'policy',
          'query',
          'operation',
          'surface',
          'agent',
          'reporting',
          'verification',
        ],
        schemaVersion: version,
        supportStatus: 'supported',
      },
    ],
    entities: [
      {
        entityId,
        kind: 'entityDefinition',
        label: 'Saved filter',
        module: reference('moduleReference', moduleId),
        orderKey: 10,
        schemaVersion: version,
        storage: reference('storageMappingReference', storageMappingId),
      },
    ],
    fields: [
      textField(fieldIds.name, 'Name', 10, 120),
      textField(fieldIds.queryId, 'Query identity', 20, 320),
      textField(fieldIds.criteria, 'Canonical predicate criteria', 30, 4_000),
    ],
    hashAlgorithm: 'sha256',
    impactAnalyses: [],
    kind: 'applicationPackageRevision',
    languageVersion: version,
    modules: [
      {
        composition: {
          kind: 'compositionSeam',
          schemaVersion: version,
          status: 'unsupported',
        },
        kind: 'moduleDefinition',
        label: 'Platform saved filters',
        moduleId,
        orderKey: 10,
        ownerPackageId: `${PLATFORM_NAMESPACE}:package.platform`,
        schemaVersion: version,
      },
    ],
    normalizationProfileVersion,
    operations: Object.entries(operationIds).map(([action, operationId]) => ({
      confirmation: action === 'archive' ? 'humanRequired' : 'none',
      effect: {
        entity: reference('entityReference', entityId),
        kind: `${action}RecordEffect`,
        schemaVersion: version,
      },
      kind: 'operationDefinition',
      module: reference('moduleReference', moduleId),
      operationId,
      permission: reference(
        'permissionReference',
        `${PLATFORM_NAMESPACE}:permission.saved_filter_${action}`,
      ),
      readBack: reference('queryReference', queryIds.get),
      schemaVersion: version,
      tier: 'o0',
    })),
    package: {
      kind: 'packageDefinition',
      namespace: PLATFORM_NAMESPACE,
      packageId: `${PLATFORM_NAMESPACE}:package.platform`,
      provenance: 'firstParty',
      schemaVersion: version,
      version: '1.0.0',
    },
    permissions: ['archive', 'create', 'read', 'restore', 'update'].map(
      (action) => permission(action),
    ),
    queries: Object.entries(queryIds).map(([queryType, queryId]) =>
      query(queryType as keyof typeof queryIds, queryId),
    ),
    relations: [],
    schemaVersion: version,
    stateMachines: [],
    storageMappings: [
      {
        entity: reference('entityReference', entityId),
        kind: 'storageMappingDefinition',
        schemaVersion: version,
        storageClass: 'dedicatedTable',
        storageMappingId,
      },
    ],
    surfaces: [
      surface('list', 'list', 'dataGrid', 'list'),
      surface('detail', 'record', 'keyFacts', 'record'),
      surface('form', 'record', 'sections', 'form'),
    ],
  };
}

export const PLATFORM_IDS = Object.freeze({
  entityId,
  contentCapabilityId,
  fieldIds,
  moduleId,
  namespace: PLATFORM_NAMESPACE,
  operationIds,
  queryIds,
});

function textField(
  fieldId: string,
  label: string,
  orderKey: number,
  maximumLength: number,
): Record<string, unknown> {
  return {
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'none',
    entity: reference('entityReference', entityId),
    fieldId,
    fieldType: { kind: 'textFieldType', maximumLength, schemaVersion: version },
    kind: 'fieldDefinition',
    label,
    orderKey,
    presence: 'required',
    reportable: false,
    schemaVersion: version,
    searchable: false,
  };
}

function permission(action: string): Record<string, unknown> {
  return {
    action,
    kind: 'permissionDefinition',
    label: `saved filter ${action}`,
    permissionId: `${PLATFORM_NAMESPACE}:permission.saved_filter_${action}`,
    resource: reference('entityReference', entityId),
    schemaVersion: version,
  };
}

function query(
  queryType: keyof typeof queryIds,
  queryId: string,
): Record<string, unknown> {
  return {
    kind: 'queryDefinition',
    maximumResultCount: queryType === 'get' ? 1 : 100,
    module: reference('moduleReference', moduleId),
    permission: reference(
      'permissionReference',
      `${PLATFORM_NAMESPACE}:permission.saved_filter_read`,
    ),
    queryId,
    queryType,
    ...(queryType === 'resolve'
      ? {
          resolveMatchKeys: [
            {
              authority: 'advisory',
              field: reference('fieldReference', fieldIds.name),
              kind: 'resolveMatchKey',
              matchKeyId: `${PLATFORM_NAMESPACE}:resolve-key.saved_filter_name`,
              orderKey: 10,
              schemaVersion: version,
            },
          ],
        }
      : {}),
    schemaVersion: version,
    selections: Object.values(fieldIds).map((fieldId, index) => ({
      field: reference('fieldReference', fieldId),
      kind: 'querySelection',
      orderKey: (index + 1) * 10,
      schemaVersion: version,
      selectionId: `${PLATFORM_NAMESPACE}:selection.saved_filter_${queryType}_${String(index + 1)}`,
    })),
    sourceEntity: reference('entityReference', entityId),
    tier: 'q0',
  };
}

function surface(
  suffix: string,
  archetype: 'list' | 'record',
  slot: 'dataGrid' | 'keyFacts' | 'sections',
  surfaceRole: 'form' | 'list' | 'record',
): Record<string, unknown> {
  return {
    archetype,
    dataSource: reference(
      'queryReference',
      surfaceRole === 'list' ? queryIds.list : queryIds.get,
    ),
    kind: 'surfaceDefinition',
    label: `Saved filter ${suffix}`,
    module: reference('moduleReference', moduleId),
    schemaVersion: version,
    slots: [
      {
        content: reference(
          'opaqueSurfaceContentReference',
          contentCapabilityId,
        ),
        kind: 'surfaceSlot',
        orderKey: 10,
        schemaVersion: version,
        slot,
        slotId: `${PLATFORM_NAMESPACE}:slot.saved_filter_${suffix}`,
      },
    ],
    statusRoles: [],
    surfaceId: `${PLATFORM_NAMESPACE}:surface.saved_filter_${suffix}`,
    surfaceRole,
  };
}
