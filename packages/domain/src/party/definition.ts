const version = 'v2' as const;
const normalizationProfileVersion = 'northstar.normalization/v2' as const;

export const PARTY_NAMESPACE = 'northstar.party' as const;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

const moduleId = `${PARTY_NAMESPACE}:module.party`;
const contentCapabilityId = `${PARTY_NAMESPACE}:capability.standard_surface_content`;

const entityIds = {
  party: `${PARTY_NAMESPACE}:entity.party`,
  role: `${PARTY_NAMESPACE}:entity.party_role`,
} as const;

const fieldIds = {
  contactSummary: `${PARTY_NAMESPACE}:field.party_contact_summary`,
  name: `${PARTY_NAMESPACE}:field.party_name`,
  number: `${PARTY_NAMESPACE}:field.party_number`,
  roleKind: `${PARTY_NAMESPACE}:field.party_role_kind`,
  roleStatus: `${PARTY_NAMESPACE}:field.party_role_status`,
} as const;

const relationIds = {
  roleParty: `${PARTY_NAMESPACE}:relation.party_role_party`,
} as const;

/**
 * The complete Party module is definition data. Compiler projections and the
 * generic platform press own storage, queries, operations, surfaces, agent
 * discovery, reporting, policy, verification, and runtime execution.
 */
export function partyModuleDefinition(): Record<string, unknown> {
  const partyFields = [fieldIds.number, fieldIds.name, fieldIds.contactSummary];
  const roleFields = [fieldIds.roleKind, fieldIds.roleStatus];
  return {
    assertions: [
      conformanceAssertion('party', `${PARTY_NAMESPACE}:query.party_get`),
      conformanceAssertion(
        'party_role',
        `${PARTY_NAMESPACE}:query.party_role_get`,
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
    entities: [
      entity('party', 'Party', entityIds.party, 10),
      entity('party_role', 'Party role', entityIds.role, 20),
    ],
    fields: [
      textField({
        businessKey: 'tenantEnvironmentCaseInsensitiveUnique',
        entityId: entityIds.party,
        fieldId: fieldIds.number,
        label: 'Party number',
        maximumLength: 40,
        orderKey: 10,
        presence: 'required',
        searchable: true,
      }),
      textField({
        entityId: entityIds.party,
        fieldId: fieldIds.name,
        label: 'Party name',
        maximumLength: 240,
        orderKey: 20,
        presence: 'required',
        searchable: true,
      }),
      textField({
        classification: 'confidential',
        entityId: entityIds.party,
        fieldId: fieldIds.contactSummary,
        label: 'Contact summary',
        maximumLength: 500,
        orderKey: 30,
        presence: 'optional',
        searchable: false,
      }),
      enumField(entityIds.role, fieldIds.roleKind, 'Party role', 10, [
        ['supplier', 'Supplier'],
        ['customer', 'Customer'],
      ]),
      enumField(entityIds.role, fieldIds.roleStatus, 'Role status', 20, [
        ['active', 'Active'],
        ['inactive', 'Inactive'],
      ]),
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
        label: 'Party',
        moduleId,
        orderKey: 10,
        ownerPackageId: `${PARTY_NAMESPACE}:package.party`,
        schemaVersion: version,
      },
    ],
    normalizationProfileVersion,
    operations: [
      ...entityOperations('party', entityIds.party),
      ...entityOperations('party_role', entityIds.role),
    ],
    package: {
      kind: 'packageDefinition',
      namespace: PARTY_NAMESPACE,
      packageId: `${PARTY_NAMESPACE}:package.party`,
      provenance: 'firstParty',
      schemaVersion: version,
      version: '1.0.0',
    },
    permissions: [
      ...entityPermissions('party', entityIds.party),
      ...entityPermissions('party_role', entityIds.role),
    ],
    queries: [
      ...entityQueries('party', entityIds.party, partyFields, [
        {
          authority: 'identifier',
          fieldId: fieldIds.number,
          localId: 'number',
        },
        { authority: 'advisory', fieldId: fieldIds.name, localId: 'name' },
      ]),
      ...entityQueries('party_role', entityIds.role, roleFields, [
        {
          authority: 'advisory',
          fieldId: fieldIds.roleKind,
          localId: 'role_kind',
        },
      ]),
    ],
    relations: [
      {
        archiveBehavior: 'restrict',
        cardinality: 'manyToOne',
        foreignKeyActions: {
          onDelete: 'restrict',
          onUpdate: 'restrict',
          schemaVersion: version,
        },
        joinEligibility: 'query',
        kind: 'relationDefinition',
        orderKey: 10,
        ownership: 'parentScopedChild',
        relationId: relationIds.roleParty,
        required: true,
        schemaVersion: version,
        sourceEntity: reference('entityReference', entityIds.role),
        targetEntity: reference('entityReference', entityIds.party),
      },
    ],
    schemaVersion: version,
    stateMachines: [],
    storageMappings: [
      storageMapping('party', entityIds.party),
      storageMapping('party_role', entityIds.role),
    ],
    surfaces: [
      ...entitySurfaces('party', 'Party'),
      ...entitySurfaces('party_role', 'Party role'),
    ],
  };
}

export const PARTY_IDS = Object.freeze({
  contentCapabilityId,
  entityIds,
  fieldIds,
  moduleId,
  namespace: PARTY_NAMESPACE,
  relationIds,
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
      `${PARTY_NAMESPACE}:storage.${local}`,
    ),
  };
}

function textField(input: {
  businessKey?: 'tenantEnvironmentCaseInsensitiveUnique';
  classification?: 'confidential' | 'internal';
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
        optionId: `${PARTY_NAMESPACE}:option.${local}`,
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
      `${PARTY_NAMESPACE}:permission.${local}_read`,
    ),
    queryId: `${PARTY_NAMESPACE}:query.${local}_${queryType}`,
    queryType,
    ...(queryType === 'resolve'
      ? {
          resolveMatchKeys: resolveKeys.map((key, index) => ({
            authority: key.authority,
            field: reference('fieldReference', key.fieldId),
            kind: 'resolveMatchKey',
            matchKeyId: `${PARTY_NAMESPACE}:resolve-key.${local}_${key.localId}`,
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
      selectionId: `${PARTY_NAMESPACE}:selection.${local}_${queryType}_${String(index + 1)}`,
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
    operationId: `${PARTY_NAMESPACE}:operation.${local}_${action}`,
    permission: reference(
      'permissionReference',
      `${PARTY_NAMESPACE}:permission.${local}_${action}`,
    ),
    readBack: reference(
      'queryReference',
      `${PARTY_NAMESPACE}:query.${local}_get`,
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
    permissionId: `${PARTY_NAMESPACE}:permission.${local}_${action}`,
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
      `${PARTY_NAMESPACE}:query.${local}_${surfaceRole === 'list' ? 'list' : 'get'}`,
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
        slotId: `${PARTY_NAMESPACE}:slot.${local}_${suffix}_${String(index + 1)}`,
      },
    ],
    statusRoles: [],
    surfaceId: `${PARTY_NAMESPACE}:surface.${local}_${suffix}`,
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
    storageMappingId: `${PARTY_NAMESPACE}:storage.${local}`,
  };
}

function conformanceAssertion(
  local: string,
  queryId: string,
): Record<string, unknown> {
  return {
    assertionId: `${PARTY_NAMESPACE}:assertion.${local}_walking_slice`,
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
