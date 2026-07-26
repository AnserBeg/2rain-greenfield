const version = 'v2' as const;
const normalizationProfileVersion = 'northstar.normalization/v2' as const;

export const LOCATION_NAMESPACE = 'northstar.location' as const;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

const moduleId = `${LOCATION_NAMESPACE}:module.location`;
const contentCapabilityId = `${LOCATION_NAMESPACE}:capability.standard_surface_content`;

const entityIds = {
  location: `${LOCATION_NAMESPACE}:entity.location`,
} as const;

const fieldIds = {
  locationType: `${LOCATION_NAMESPACE}:field.location_type`,
  name: `${LOCATION_NAMESPACE}:field.location_name`,
  code: `${LOCATION_NAMESPACE}:field.location_code`,
} as const;

/**
 * The complete Location module is definition data. Compiler projections and the
 * generic platform press own storage, queries, operations, surfaces, agent
 * discovery, reporting, policy, verification, and runtime execution.
 */
export function locationModuleDefinition(): Record<string, unknown> {
  const locationFields = [fieldIds.code, fieldIds.name, fieldIds.locationType];
  return {
    assertions: [
      conformanceAssertion(
        'location',
        `${LOCATION_NAMESPACE}:query.location_get`,
      ),
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
    entities: [entity('location', 'Location', entityIds.location, 10)],
    fields: [
      textField({
        businessKey: 'tenantEnvironmentCaseInsensitiveUnique',
        entityId: entityIds.location,
        fieldId: fieldIds.code,
        label: 'Code',
        maximumLength: 40,
        orderKey: 10,
        presence: 'required',
        searchable: true,
      }),
      textField({
        entityId: entityIds.location,
        fieldId: fieldIds.name,
        label: 'Location name',
        maximumLength: 240,
        orderKey: 20,
        presence: 'required',
        searchable: true,
      }),
      enumField(
        entityIds.location,
        fieldIds.locationType,
        'Location type',
        30,
        [
          ['warehouse', 'Warehouse'],
          ['store', 'Store'],
        ],
      ),
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
        label: 'Location',
        moduleId,
        orderKey: 10,
        ownerPackageId: `${LOCATION_NAMESPACE}:package.location`,
        schemaVersion: version,
      },
    ],
    normalizationProfileVersion,
    operations: entityOperations('location', entityIds.location),
    package: {
      kind: 'packageDefinition',
      namespace: LOCATION_NAMESPACE,
      packageId: `${LOCATION_NAMESPACE}:package.location`,
      provenance: 'firstParty',
      schemaVersion: version,
      version: '1.0.0',
    },
    permissions: entityPermissions('location', entityIds.location),
    queries: [
      ...entityQueries('location', entityIds.location, locationFields, [
        {
          authority: 'identifier',
          fieldId: fieldIds.code,
          localId: 'code',
        },
        { authority: 'advisory', fieldId: fieldIds.name, localId: 'name' },
      ]),
    ],
    relations: [],
    schemaVersion: version,
    stateMachines: [],
    storageMappings: [storageMapping('location', entityIds.location)],
    surfaces: entitySurfaces('location', 'Location'),
  };
}

export const LOCATION_IDS = Object.freeze({
  contentCapabilityId,
  entityIds,
  fieldIds,
  moduleId,
  namespace: LOCATION_NAMESPACE,
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
      `${LOCATION_NAMESPACE}:storage.${local}`,
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

function enumField(
  entityId: string,
  fieldId: string,
  label: string,
  orderKey: number,
  options: ReadonlyArray<readonly [string, string]>,
): Record<string, unknown> {
  return {
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'none',
    entity: reference('entityReference', entityId),
    fieldId,
    fieldType: {
      kind: 'enumFieldType',
      options: options.map(([local, optionLabel], index) => ({
        kind: 'enumOption',
        label: optionLabel,
        optionId: `${LOCATION_NAMESPACE}:option.${local}`,
        orderKey: (index + 1) * 10,
        schemaVersion: version,
      })),
      schemaVersion: version,
    },
    kind: 'fieldDefinition',
    label,
    orderKey,
    presence: 'required',
    reportable: true,
    schemaVersion: version,
    searchable: false,
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
      `${LOCATION_NAMESPACE}:permission.${local}_read`,
    ),
    queryId: `${LOCATION_NAMESPACE}:query.${local}_${queryType}`,
    queryType,
    ...(queryType === 'resolve'
      ? {
          resolveMatchKeys: resolveKeys.map((key, index) => ({
            authority: key.authority,
            field: reference('fieldReference', key.fieldId),
            kind: 'resolveMatchKey',
            matchKeyId: `${LOCATION_NAMESPACE}:resolve-key.${local}_${key.localId}`,
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
      selectionId: `${LOCATION_NAMESPACE}:selection.${local}_${queryType}_${String(index + 1)}`,
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
    operationId: `${LOCATION_NAMESPACE}:operation.${local}_${action}`,
    permission: reference(
      'permissionReference',
      `${LOCATION_NAMESPACE}:permission.${local}_${action}`,
    ),
    readBack: reference(
      'queryReference',
      `${LOCATION_NAMESPACE}:query.${local}_get`,
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
    permissionId: `${LOCATION_NAMESPACE}:permission.${local}_${action}`,
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
      `${LOCATION_NAMESPACE}:query.${local}_${surfaceRole === 'list' ? 'list' : 'get'}`,
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
        slotId: `${LOCATION_NAMESPACE}:slot.${local}_${suffix}_${String(index + 1)}`,
      },
    ],
    statusRoles: [],
    surfaceId: `${LOCATION_NAMESPACE}:surface.${local}_${suffix}`,
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
    storageMappingId: `${LOCATION_NAMESPACE}:storage.${local}`,
  };
}

function conformanceAssertion(
  local: string,
  queryId: string,
): Record<string, unknown> {
  return {
    assertionId: `${LOCATION_NAMESPACE}:assertion.${local}_walking_slice`,
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
