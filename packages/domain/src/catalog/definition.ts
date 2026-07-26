const version = 'v2' as const;
const normalizationProfileVersion = 'northstar.normalization/v2' as const;

export const CATALOG_NAMESPACE = 'northstar.catalog' as const;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

const moduleId = `${CATALOG_NAMESPACE}:module.catalog`;
const contentCapabilityId = `${CATALOG_NAMESPACE}:capability.standard_surface_content`;

const entityIds = {
  item: `${CATALOG_NAMESPACE}:entity.item`,
} as const;

const fieldIds = {
  description: `${CATALOG_NAMESPACE}:field.item_description`,
  name: `${CATALOG_NAMESPACE}:field.item_name`,
  sku: `${CATALOG_NAMESPACE}:field.item_sku`,
} as const;

/**
 * The complete Catalog module is definition data. Compiler projections and the
 * generic platform press own storage, queries, operations, surfaces, agent
 * discovery, reporting, policy, verification, and runtime execution.
 */
export function catalogModuleDefinition(): Record<string, unknown> {
  const itemFields = [fieldIds.sku, fieldIds.name, fieldIds.description];
  return {
    assertions: [
      conformanceAssertion('item', `${CATALOG_NAMESPACE}:query.item_get`),
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
    entities: [entity('item', 'Item', entityIds.item, 10)],
    fields: [
      textField({
        businessKey: 'tenantEnvironmentCaseInsensitiveUnique',
        entityId: entityIds.item,
        fieldId: fieldIds.sku,
        label: 'SKU',
        maximumLength: 40,
        orderKey: 10,
        presence: 'required',
        searchable: true,
      }),
      textField({
        entityId: entityIds.item,
        fieldId: fieldIds.name,
        label: 'Item name',
        maximumLength: 240,
        orderKey: 20,
        presence: 'required',
        searchable: true,
      }),
      textField({
        classification: 'internal',
        entityId: entityIds.item,
        fieldId: fieldIds.description,
        label: 'Description',
        maximumLength: 500,
        orderKey: 30,
        presence: 'optional',
        searchable: true,
      }),
    ],
    hashAlgorithm: 'sha256',
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
        label: 'Catalog',
        moduleId,
        orderKey: 10,
        ownerPackageId: `${CATALOG_NAMESPACE}:package.catalog`,
        schemaVersion: version,
      },
    ],
    normalizationProfileVersion,
    operations: entityOperations('item', entityIds.item),
    package: {
      kind: 'packageDefinition',
      namespace: CATALOG_NAMESPACE,
      packageId: `${CATALOG_NAMESPACE}:package.catalog`,
      provenance: 'firstParty',
      schemaVersion: version,
      version: '1.0.0',
    },
    permissions: entityPermissions('item', entityIds.item),
    queries: [
      ...entityQueries('item', entityIds.item, itemFields, [
        {
          authority: 'identifier',
          fieldId: fieldIds.sku,
          localId: 'sku',
        },
        { authority: 'advisory', fieldId: fieldIds.name, localId: 'name' },
      ]),
    ],
    relations: [],
    schemaVersion: version,
    stateMachines: [],
    storageMappings: [storageMapping('item', entityIds.item)],
    surfaces: entitySurfaces('item', 'Item'),
  };
}

export const CATALOG_IDS = Object.freeze({
  contentCapabilityId,
  entityIds,
  fieldIds,
  moduleId,
  namespace: CATALOG_NAMESPACE,
});

function entity(
  local: string,
  label: string,
  entityId: string,
  orderKey: number,
): Record<string, unknown> {
  return {
    entityId,
    kind: 'entityDefinition',
    label,
    module: reference('moduleReference', moduleId),
    orderKey,
    schemaVersion: version,
    storage: reference(
      'storageMappingReference',
      `${CATALOG_NAMESPACE}:storage.${local}`,
    ),
  };
}

function textField(input: {
  businessKey?: 'tenantEnvironmentCaseInsensitiveUnique';
  classification?: 'internal';
  entityId: string;
  fieldId: string;
  label: string;
  maximumLength: number;
  orderKey: number;
  presence: 'optional' | 'required';
  searchable: boolean;
}): Record<string, unknown> {
  return {
    ...(input.businessKey ? { businessKey: input.businessKey } : {}),
    classification: input.classification ?? 'internal',
    collation: 'unicodeCaseInsensitive',
    defaultSemantics: input.presence === 'optional' ? 'nullable' : 'none',
    entity: reference('entityReference', input.entityId),
    fieldId: input.fieldId,
    fieldType: {
      kind: 'textFieldType',
      maximumLength: input.maximumLength,
      schemaVersion: version,
    },
    kind: 'fieldDefinition',
    label: input.label,
    orderKey: input.orderKey,
    presence: input.presence,
    reportable: true,
    schemaVersion: version,
    searchable: input.searchable,
  };
}

function entityQueries(
  local: string,
  entityId: string,
  selectedFieldIds: readonly string[],
  resolveKeys: readonly {
    authority: 'advisory' | 'identifier';
    fieldId: string;
    localId: string;
  }[],
): Array<Record<string, unknown>> {
  return ['get', 'list', 'search', 'resolve'].map((queryType) => ({
    kind: 'queryDefinition',
    maximumResultCount: queryType === 'get' ? 1 : 100,
    module: reference('moduleReference', moduleId),
    permission: reference(
      'permissionReference',
      `${CATALOG_NAMESPACE}:permission.${local}_read`,
    ),
    queryId: `${CATALOG_NAMESPACE}:query.${local}_${queryType}`,
    queryType,
    ...(queryType === 'resolve'
      ? {
          resolveMatchKeys: resolveKeys.map((key, index) => ({
            authority: key.authority,
            field: reference('fieldReference', key.fieldId),
            kind: 'resolveMatchKey',
            matchKeyId: `${CATALOG_NAMESPACE}:resolve-key.${local}_${key.localId}`,
            orderKey: (index + 1) * 10,
            schemaVersion: version,
          })),
        }
      : {}),
    schemaVersion: version,
    selections: selectedFieldIds.map((fieldId, index) => ({
      field: reference('fieldReference', fieldId),
      kind: 'querySelection',
      orderKey: (index + 1) * 10,
      schemaVersion: version,
      selectionId: `${CATALOG_NAMESPACE}:selection.${local}_${queryType}_${String(index + 1)}`,
    })),
    sourceEntity: reference('entityReference', entityId),
    tier: 'q0',
  }));
}

function entityOperations(
  local: string,
  entityId: string,
): Array<Record<string, unknown>> {
  const effects = [
    ['create', 'createRecordEffect'],
    ['update', 'updateRecordEffect'],
    ['archive', 'archiveRecordEffect'],
    ['restore', 'restoreRecordEffect'],
  ] as const;
  return effects.map(([action, kind]) => ({
    confirmation: action === 'archive' ? 'humanRequired' : 'none',
    effect: {
      entity: reference('entityReference', entityId),
      kind,
      schemaVersion: version,
    },
    kind: 'operationDefinition',
    module: reference('moduleReference', moduleId),
    operationId: `${CATALOG_NAMESPACE}:operation.${local}_${action}`,
    permission: reference(
      'permissionReference',
      `${CATALOG_NAMESPACE}:permission.${local}_${action}`,
    ),
    readBack: reference(
      'queryReference',
      `${CATALOG_NAMESPACE}:query.${local}_get`,
    ),
    schemaVersion: version,
    tier: 'o0',
  }));
}

function entityPermissions(
  local: string,
  entityId: string,
): Array<Record<string, unknown>> {
  return ['create', 'read', 'update', 'archive', 'restore'].map((action) => ({
    action,
    kind: 'permissionDefinition',
    label: `${local} ${action}`,
    permissionId: `${CATALOG_NAMESPACE}:permission.${local}_${action}`,
    resource: reference('entityReference', entityId),
    schemaVersion: version,
  }));
}

function entitySurfaces(
  local: string,
  label: string,
): Array<Record<string, unknown>> {
  return [
    ['list', 'list', 'dataGrid', 'list'],
    ['detail', 'record', 'keyFacts', 'record'],
    ['form', 'record', 'sections', 'form'],
  ].map(([suffix, archetype, slot, surfaceRole], index) => ({
    archetype,
    dataSource: reference(
      'queryReference',
      `${CATALOG_NAMESPACE}:query.${local}_${surfaceRole === 'list' ? 'list' : 'get'}`,
    ),
    kind: 'surfaceDefinition',
    label: `${label} ${suffix}`,
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
        slotId: `${CATALOG_NAMESPACE}:slot.${local}_${suffix}_${String(index + 1)}`,
      },
    ],
    statusRoles: [],
    surfaceId: `${CATALOG_NAMESPACE}:surface.${local}_${suffix}`,
    surfaceRole,
  }));
}

function storageMapping(
  local: string,
  entityId: string,
): Record<string, unknown> {
  return {
    entity: reference('entityReference', entityId),
    kind: 'storageMappingDefinition',
    schemaVersion: version,
    storageClass: 'dedicatedTable',
    storageMappingId: `${CATALOG_NAMESPACE}:storage.${local}`,
  };
}

function conformanceAssertion(
  local: string,
  queryId: string,
): Record<string, unknown> {
  return {
    assertionId: `${CATALOG_NAMESPACE}:assertion.${local}_walking_slice`,
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
      query: reference('queryReference', queryId),
      schemaVersion: version,
    },
    kind: 'assertionDefinition',
    schemaVersion: version,
  };
}
