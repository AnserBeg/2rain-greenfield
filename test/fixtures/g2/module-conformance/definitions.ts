import {
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
} from '@north-star/canonical-model';

const version = LANGUAGE_VERSION;
const namespace = 'northstar.modulefixture';

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

const entityIds = {
  child: `${namespace}:entity.master_role`,
  parent: `${namespace}:entity.master`,
} as const;

const fieldIds = {
  childRole: `${namespace}:field.master_role_kind`,
  parentName: `${namespace}:field.master_name`,
  parentNumber: `${namespace}:field.master_number`,
  parentNotes: `${namespace}:field.master_notes`,
} as const;

const moduleId = `${namespace}:module.master`;
const contentCapabilityId = `${namespace}:capability.standard_surface_content`;

export function ordinaryModuleV1(): Record<string, unknown> {
  const queries = [
    ...entityQueries(
      'master',
      entityIds.parent,
      fieldIds.parentName,
      fieldIds.parentNumber,
    ),
    ...entityQueries('master_role', entityIds.child, fieldIds.childRole),
  ];
  const operations = [
    ...entityOperations('master', entityIds.parent),
    ...entityOperations('master_role', entityIds.child),
  ];
  return {
    assertions: [
      assertion('master', `${namespace}:query.master_get`),
      assertion('master_role', `${namespace}:query.master_role_get`),
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
        entityId: entityIds.parent,
        kind: 'entityDefinition',
        label: 'Master',
        module: reference('moduleReference', moduleId),
        orderKey: 10,
        schemaVersion: version,
        storage: reference(
          'storageMappingReference',
          `${namespace}:storage.master`,
        ),
      },
      {
        entityId: entityIds.child,
        kind: 'entityDefinition',
        label: 'Master role',
        module: reference('moduleReference', moduleId),
        orderKey: 20,
        schemaVersion: version,
        storage: reference(
          'storageMappingReference',
          `${namespace}:storage.master_role`,
        ),
      },
    ],
    fields: [
      {
        businessKey: 'tenantEnvironmentCaseInsensitiveUnique',
        classification: 'internal',
        collation: 'unicodeCaseInsensitive',
        defaultSemantics: 'none',
        entity: reference('entityReference', entityIds.parent),
        fieldId: fieldIds.parentNumber,
        fieldType: {
          kind: 'textFieldType',
          maximumLength: 40,
          schemaVersion: version,
        },
        kind: 'fieldDefinition',
        label: 'Number',
        orderKey: 10,
        presence: 'required',
        reportable: true,
        schemaVersion: version,
        searchable: true,
      },
      {
        classification: 'internal',
        collation: 'unicodeCaseInsensitive',
        defaultSemantics: 'none',
        entity: reference('entityReference', entityIds.parent),
        fieldId: fieldIds.parentName,
        fieldType: {
          kind: 'textFieldType',
          maximumLength: 240,
          schemaVersion: version,
        },
        kind: 'fieldDefinition',
        label: 'Name',
        orderKey: 20,
        presence: 'required',
        reportable: true,
        schemaVersion: version,
        searchable: true,
      },
      {
        classification: 'internal',
        collation: 'binary',
        defaultSemantics: 'none',
        entity: reference('entityReference', entityIds.child),
        fieldId: fieldIds.childRole,
        fieldType: {
          kind: 'textFieldType',
          maximumLength: 40,
          schemaVersion: version,
        },
        kind: 'fieldDefinition',
        label: 'Role',
        orderKey: 10,
        presence: 'required',
        reportable: true,
        schemaVersion: version,
        searchable: true,
      },
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
        label: 'Ordinary master module',
        moduleId,
        orderKey: 10,
        ownerPackageId: `${namespace}:package.fixture`,
        schemaVersion: version,
      },
    ],
    normalizationProfileVersion: NORMALIZATION_PROFILE_VERSION,
    operations,
    package: {
      kind: 'packageDefinition',
      namespace,
      packageId: `${namespace}:package.fixture`,
      provenance: 'firstParty',
      schemaVersion: version,
      version: '1.0.0',
    },
    permissions: [
      ...entityPermissions('master', entityIds.parent),
      ...entityPermissions('master_role', entityIds.child),
    ],
    queries,
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
        relationId: `${namespace}:relation.master_role_parent`,
        required: true,
        schemaVersion: version,
        sourceEntity: reference('entityReference', entityIds.child),
        targetEntity: reference('entityReference', entityIds.parent),
      },
    ],
    schemaVersion: version,
    stateMachines: [],
    storageMappings: [
      storageMapping('master', entityIds.parent),
      storageMapping('master_role', entityIds.child),
    ],
    surfaces: [...entitySurfaces('master'), ...entitySurfaces('master_role')],
  };
}

export function ordinaryModuleV2(): Record<string, unknown> {
  const definition = structuredClone(ordinaryModuleV1()) as {
    fields: Array<Record<string, unknown>>;
    package: { version: string };
    queries: Array<{
      queryId: string;
      selections: Array<Record<string, unknown>>;
    }>;
  } & Record<string, unknown>;
  definition.package.version = '1.1.0';
  definition.fields.push({
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'nullable',
    entity: reference('entityReference', entityIds.parent),
    fieldId: fieldIds.parentNotes,
    fieldType: {
      kind: 'textFieldType',
      maximumLength: 500,
      schemaVersion: version,
    },
    kind: 'fieldDefinition',
    label: 'Notes',
    orderKey: 30,
    presence: 'optional',
    reportable: true,
    schemaVersion: version,
    searchable: false,
  });
  for (const query of definition.queries.filter((entry) =>
    new RegExp(`^${namespace}:query\\.master_(get|list|search|resolve)$`).test(
      entry.queryId,
    ),
  )) {
    query.selections.push({
      field: reference('fieldReference', fieldIds.parentNotes),
      kind: 'querySelection',
      orderKey: 30,
      schemaVersion: version,
      selectionId: `${query.queryId.replace(':query.', ':selection.')}_notes`,
    });
  }
  return definition;
}

export function ordinaryModuleV1ForNamespace(
  targetNamespace: string,
): Record<string, unknown> {
  if (!/^northstar\.[a-z][a-z0-9]*$/.test(targetNamespace)) {
    throw new TypeError('fixture namespace must be canonical and lowercase');
  }
  return replaceNamespace(ordinaryModuleV1(), targetNamespace) as Record<
    string,
    unknown
  >;
}

export const FIXTURE_IDS = Object.freeze({
  contentCapabilityId,
  entityIds,
  fieldIds,
  moduleId,
  namespace,
});

function entityQueries(
  local: string,
  entityId: string,
  selectedFieldId: string,
  identifierFieldId?: string,
): Array<Record<string, unknown>> {
  return ['get', 'list', 'search', 'resolve'].map((queryType) => {
    const queryId = `${namespace}:query.${local}_${queryType}`;
    return {
      kind: 'queryDefinition',
      maximumResultCount: queryType === 'get' ? 1 : 100,
      module: reference('moduleReference', moduleId),
      permission: reference(
        'permissionReference',
        `${namespace}:permission.${local}_read`,
      ),
      queryId,
      queryType,
      resolveMatchKeys:
        queryType === 'resolve'
          ? [
              ...(identifierFieldId
                ? [
                    {
                      authority: 'identifier',
                      field: reference('fieldReference', identifierFieldId),
                      kind: 'resolveMatchKey',
                      matchKeyId: `${namespace}:resolve-key.${local}_identifier`,
                      orderKey: 10,
                      schemaVersion: version,
                    },
                  ]
                : []),
              {
                authority: 'advisory',
                field: reference('fieldReference', selectedFieldId),
                kind: 'resolveMatchKey',
                matchKeyId: `${namespace}:resolve-key.${local}_advisory`,
                orderKey: 20,
                schemaVersion: version,
              },
            ]
          : [],
      schemaVersion: version,
      selections: [
        {
          field: reference('fieldReference', selectedFieldId),
          kind: 'querySelection',
          orderKey: 10,
          schemaVersion: version,
          selectionId: `${namespace}:selection.${local}_${queryType}_primary`,
        },
      ],
      sourceEntity: reference('entityReference', entityId),
      tier: 'q0',
    };
  });
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
    operationId: `${namespace}:operation.${local}_${action}`,
    permission: reference(
      'permissionReference',
      `${namespace}:permission.${local}_${action}`,
    ),
    readBack: reference('queryReference', `${namespace}:query.${local}_get`),
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
    permissionId: `${namespace}:permission.${local}_${action}`,
    resource: reference('entityReference', entityId),
    schemaVersion: version,
  }));
}

function entitySurfaces(local: string): Array<Record<string, unknown>> {
  return [
    ['list', 'list', 'dataGrid'],
    ['record', 'record', 'keyFacts'],
    ['form', 'record', 'sections'],
  ].map(([surfaceRole, archetype, slot], index) => ({
    archetype,
    dataSource: reference(
      'queryReference',
      `${namespace}:query.${local}_${surfaceRole === 'list' ? 'list' : 'get'}`,
    ),
    kind: 'surfaceDefinition',
    label: `${local} ${surfaceRole}`,
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
        slotId: `${namespace}:slot.${local}_${surfaceRole}_${String(index)}`,
      },
    ],
    statusRoles: [],
    surfaceId: `${namespace}:surface.${local}_${surfaceRole}`,
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
    storageMappingId: `${namespace}:storage.${local}`,
  };
}

function assertion(local: string, queryId: string): Record<string, unknown> {
  return {
    assertionId: `${namespace}:assertion.${local}_conformance`,
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

function replaceNamespace(value: unknown, targetNamespace: string): unknown {
  if (typeof value === 'string') {
    return value === namespace
      ? targetNamespace
      : value.startsWith(`${namespace}:`)
        ? `${targetNamespace}${value.slice(namespace.length)}`
        : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceNamespace(entry, targetNamespace));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceNamespace(entry, targetNamespace),
      ]),
    );
  }
  return value;
}
