const version = 'v6' as const;
const normalizationProfileVersion = 'northstar.normalization/v6' as const;

export const LOCATION_NAMESPACE = 'northstar.location' as const;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

function ids(namespace: string) {
  return {
    contentCapabilityId: `${namespace}:capability.standard_surface_content`,
    entityIds: {
      location: `${namespace}:entity.location`,
    },
    fieldIds: {
      code: `${namespace}:field.location_code`,
      locationType: `${namespace}:field.location_type`,
      name: `${namespace}:field.location_name`,
      // What the stock held here may be used for, and why it last changed
      // (LOCATIONS): an attribute of the location, never a stock dimension.
      status: `${namespace}:field.location_status`,
      statusChangedAt: `${namespace}:field.location_status_changed_at`,
      statusReason: `${namespace}:field.location_status_reason`,
    },
    moduleId: `${namespace}:module.location`,
    namespace,
    packageId: `${namespace}:package.location`,
    relationIds: {
      // The location that contains this one, such as a warehouse holding its
      // bins (LOCATIONS slice 2).
      parent: `${namespace}:relation.location_parent`,
    },
    statusOptionIds: {
      damaged: `${namespace}:option.location_status_damaged`,
      inTransit: `${namespace}:option.location_status_in_transit`,
      quarantine: `${namespace}:option.location_status_quarantine`,
      returnPending: `${namespace}:option.location_status_return_pending`,
      usable: `${namespace}:option.location_status_usable`,
    },
  } as const;
}

/**
 * A location's inventory status (LOCATIONS, owner ruling L-A): only stock in a
 * usable location counts as usable or available. Quarantine, damaged, in
 * transit and return pending hold stock that is on hand but not to be sold.
 * Option ids carry the field's name: a type and a status may share a word.
 */
const STATUSES = [
  ['location_status_usable', 'Usable'],
  ['location_status_quarantine', 'Quarantine'],
  ['location_status_damaged', 'Damaged'],
  ['location_status_in_transit', 'In transit'],
  ['location_status_return_pending', 'Return pending'],
] as const;

/**
 * The location types beside a warehouse and a store (owner ruling L-B),
 * appended so the released constraint widens (`widenEnumDomain`, ADR-0064)
 * and no stored type changes meaning.
 */
const WIDENED_TYPES = [
  ['location_type_storage', 'Storage'],
  ['location_type_receiving', 'Receiving'],
  ['location_type_shipping', 'Shipping'],
  ['location_type_quarantine', 'Quarantine'],
  ['location_type_in_transit', 'In transit'],
  ['location_type_scrap', 'Scrap'],
  ['location_type_yard', 'Yard'],
] as const;

type LocationIds = ReturnType<typeof ids>;

const { contentCapabilityId, entityIds, fieldIds, moduleId, statusOptionIds } =
  ids(LOCATION_NAMESPACE);

/**
 * The complete Location module is definition data. Compiler projections and the
 * generic platform press own storage, queries, operations, surfaces, agent
 * discovery, reporting, policy, verification, and runtime execution.
 */
export function locationModuleDefinition(
  namespace: string = LOCATION_NAMESPACE,
  options: {
    /**
     * A location's inventory status with the reason and time it last
     * changed, and the widened location types (LOCATIONS). Only the product
     * application mounts them; the standalone harness keeps the Location it
     * has always compiled.
     */
    readonly inventoryStatus?: boolean;
    /**
     * The location that contains this one -- a warehouse holding its bins
     * (LOCATIONS slice 2). Chosen when the location is created; a location
     * can only name one that already exists, so the containment never loops.
     */
    readonly hierarchy?: boolean;
  } = {},
): Record<string, unknown> {
  const definitionIds = ids(namespace);
  const { contentCapabilityId, entityIds, fieldIds, moduleId, packageId } =
    definitionIds;
  const inventoryStatus = options.inventoryStatus === true;
  const hierarchy = options.hierarchy === true;
  const locationFields = [
    fieldIds.code,
    fieldIds.name,
    fieldIds.locationType,
    ...(inventoryStatus
      ? [fieldIds.status, fieldIds.statusReason, fieldIds.statusChangedAt]
      : []),
  ];
  return {
    assertions: [
      conformanceAssertion(
        definitionIds,
        'location',
        `${namespace}:query.location_get`,
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
      entity(definitionIds, 'location', 'Location', entityIds.location, 10),
    ],
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
        definitionIds,
        entityIds.location,
        fieldIds.locationType,
        'Location type',
        30,
        [
          ['warehouse', 'Warehouse'],
          ['store', 'Store'],
          ...(inventoryStatus ? WIDENED_TYPES : []),
        ],
      ),
      ...(inventoryStatus
        ? [
            // Every location is usable until a declared status change with a
            // reason says otherwise: the column's declared default fills a
            // location released before this field existed and one created
            // without it, as every generic create is (the form omits it).
            // Optional, not required: an operation's input contract requires
            // a create to state every required field, default or not.
            {
              ...enumField(
                definitionIds,
                entityIds.location,
                fieldIds.status,
                'Inventory status',
                40,
                STATUSES,
              ),
              presence: 'optional',
              defaultSemantics: 'declaredDefault',
              defaultValue: {
                kind: 'textValue',
                schemaVersion: version,
                value: definitionIds.statusOptionIds.usable,
              },
            },
            textField({
              entityId: entityIds.location,
              fieldId: fieldIds.statusReason,
              label: 'Status reason',
              maximumLength: 1000,
              orderKey: 50,
              presence: 'optional',
              searchable: false,
            }),
            {
              classification: 'internal',
              collation: 'binary',
              defaultSemantics: 'nullable',
              entity: reference('entityReference', entityIds.location),
              fieldId: fieldIds.statusChangedAt,
              fieldType: {
                kind: 'dateTimeFieldType',
                precision: 'millisecond',
                schemaVersion: version,
                timezoneSemantics: 'utcInstant',
              },
              kind: 'fieldDefinition',
              label: 'Status changed',
              orderKey: 60,
              presence: 'optional',
              reportable: true,
              schemaVersion: version,
              searchable: false,
            },
          ]
        : []),
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
        label: 'Location',
        moduleId,
        orderKey: 10,
        ownerPackageId: packageId,
        schemaVersion: version,
      },
    ],
    normalizationProfileVersion,
    operations: entityOperations(definitionIds, 'location', entityIds.location),
    package: {
      kind: 'packageDefinition',
      namespace,
      packageId,
      provenance: 'firstParty',
      schemaVersion: version,
      version: '1.0.0',
    },
    permissions: entityPermissions(
      definitionIds,
      'location',
      entityIds.location,
    ),
    queries: [
      ...entityQueries(
        definitionIds,
        'location',
        entityIds.location,
        locationFields,
        [
          {
            authority: 'identifier',
            fieldId: fieldIds.code,
            localId: 'code',
          },
          { authority: 'advisory', fieldId: fieldIds.name, localId: 'name' },
        ],
      ),
    ],
    relations: hierarchy
      ? [
          {
            // A parent with locations inside it cannot be archived first.
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
            ownership: 'reference',
            relationId: definitionIds.relationIds.parent,
            required: false,
            schemaVersion: version,
            sourceEntity: reference('entityReference', entityIds.location),
            targetEntity: reference('entityReference', entityIds.location),
          },
        ]
      : [],
    schemaVersion: version,
    stateMachines: [],
    storageMappings: [
      storageMapping(definitionIds, 'location', entityIds.location),
    ],
    surfaces: entitySurfaces(definitionIds, 'location', 'Location'),
  };
}

export const LOCATION_IDS = Object.freeze({
  contentCapabilityId,
  entityIds,
  fieldIds,
  moduleId,
  namespace: LOCATION_NAMESPACE,
  statusOptionIds,
});

function entity(
  ids: LocationIds,
  local: string,
  label: string,
  entityId: string,
  orderKey: number,
): Record<string, unknown> {
  return {
    entityId,
    kind: 'entityDefinition',
    label,
    module: reference('moduleReference', ids.moduleId),
    orderKey,
    schemaVersion: version,
    storage: reference(
      'storageMappingReference',
      `${ids.namespace}:storage.${local}`,
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
  ids: LocationIds,
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
        optionId: `${ids.namespace}:option.${local}`,
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
  ids: LocationIds,
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
    module: reference('moduleReference', ids.moduleId),
    permission: reference(
      'permissionReference',
      `${ids.namespace}:permission.${local}_read`,
    ),
    queryId: `${ids.namespace}:query.${local}_${queryType}`,
    queryType,
    ...(queryType === 'resolve'
      ? {
          resolveMatchKeys: resolveKeys.map((key, index) => ({
            authority: key.authority,
            field: reference('fieldReference', key.fieldId),
            kind: 'resolveMatchKey',
            matchKeyId: `${ids.namespace}:resolve-key.${local}_${key.localId}`,
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
      selectionId: `${ids.namespace}:selection.${local}_${queryType}_${String(index + 1)}`,
    })),
    sourceEntity: reference('entityReference', entityId),
    tier: 'q0',
  }));
}

function entityOperations(
  ids: LocationIds,
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
    module: reference('moduleReference', ids.moduleId),
    operationId: `${ids.namespace}:operation.${local}_${action}`,
    permission: reference(
      'permissionReference',
      `${ids.namespace}:permission.${local}_${action}`,
    ),
    readBack: reference(
      'queryReference',
      `${ids.namespace}:query.${local}_get`,
    ),
    schemaVersion: version,
    tier: 'o0',
  }));
}

function entityPermissions(
  ids: LocationIds,
  local: string,
  entityId: string,
): Array<Record<string, unknown>> {
  return ['create', 'read', 'update', 'archive', 'restore'].map((action) => ({
    action,
    kind: 'permissionDefinition',
    label: `${local} ${action}`,
    permissionId: `${ids.namespace}:permission.${local}_${action}`,
    resource: reference('entityReference', entityId),
    schemaVersion: version,
  }));
}

function entitySurfaces(
  ids: LocationIds,
  local: string,
  label: string,
): Array<Record<string, unknown>> {
  return [
    ['list', 'list', ['title', 'dataGrid', 'bulkActions'], 'list'],
    [
      'detail',
      'record',
      ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts', 'sections'],
      'record',
    ],
    [
      'form',
      'record',
      ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts', 'sections'],
      'form',
    ],
  ].map(([suffix, archetype, slots, surfaceRole]) => ({
    archetype,
    dataSource: reference(
      'queryReference',
      `${ids.namespace}:query.${local}_${surfaceRole === 'list' ? 'list' : 'get'}`,
    ),
    kind: 'surfaceDefinition',
    label: `${label} ${suffix}`,
    module: reference('moduleReference', ids.moduleId),
    schemaVersion: version,
    slots: (slots as string[]).map((slot, index) => ({
      content: reference(
        'opaqueSurfaceContentReference',
        ids.contentCapabilityId,
      ),
      kind: 'surfaceSlot',
      orderKey: (index + 1) * 10,
      schemaVersion: version,
      slot,
      slotId: `${ids.namespace}:slot.${local}_${suffix}_${slot.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}`,
    })),
    statusRoles: [],
    surfaceId: `${ids.namespace}:surface.${local}_${suffix}`,
    surfaceRole,
  }));
}

function storageMapping(
  ids: LocationIds,
  local: string,
  entityId: string,
): Record<string, unknown> {
  return {
    entity: reference('entityReference', entityId),
    kind: 'storageMappingDefinition',
    schemaVersion: version,
    storageClass: 'dedicatedTable',
    storageMappingId: `${ids.namespace}:storage.${local}`,
  };
}

function conformanceAssertion(
  ids: LocationIds,
  local: string,
  queryId: string,
): Record<string, unknown> {
  return {
    assertionId: `${ids.namespace}:assertion.${local}_walking_slice`,
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
