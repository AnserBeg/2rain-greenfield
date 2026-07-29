const version = 'v3' as const;
const normalizationProfileVersion = 'northstar.normalization/v3' as const;

export const INVENTORY_NAMESPACE = 'northstar.inventory' as const;

type FieldType = Record<string, unknown>;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

function ids(namespace: string) {
  const entity = (local: string) => `${namespace}:entity.${local}`;
  const field = (local: string, name: string) =>
    `${namespace}:field.${local}_${name}`;
  return {
    contentCapabilityId: `${namespace}:capability.standard_surface_content`,
    entityIds: {
      legalEntity: entity('legal_entity'),
      movement: entity('inventory_movement'),
      periodLock: entity('inventory_period_lock'),
      transaction: entity('inventory_transaction'),
      transactionLine: entity('inventory_transaction_line'),
    },
    fieldIds: {
      legalEntity: {
        code: field('legal_entity', 'code'),
        isDefault: field('legal_entity', 'is_default'),
        name: field('legal_entity', 'name'),
        status: field('legal_entity', 'status'),
      },
      movement: {
        actorId: field('inventory_movement', 'actor_id'),
        effectiveAt: field('inventory_movement', 'effective_at'),
        itemId: field('inventory_movement', 'item_id'),
        locationId: field('inventory_movement', 'location_id'),
        postingRole: field('inventory_movement', 'posting_role'),
        quantityDelta: field('inventory_movement', 'quantity_delta'),
        reasonCode: field('inventory_movement', 'reason_code'),
        reasonNarrative: field('inventory_movement', 'reason_narrative'),
        recordedAt: field('inventory_movement', 'recorded_at'),
        reversalOfMovementId: field(
          'inventory_movement',
          'reversal_of_movement_id',
        ),
        sourceId: field('inventory_movement', 'source_id'),
        sourceLine: field('inventory_movement', 'source_line'),
        sourceRevision: field('inventory_movement', 'source_revision'),
        sourceType: field('inventory_movement', 'source_type'),
        stockDimensionSetVersion: field(
          'inventory_movement',
          'stock_dimension_set_version',
        ),
        transactionId: field('inventory_movement', 'transaction_id'),
        transactionLineId: field('inventory_movement', 'transaction_line_id'),
        unitId: field('inventory_movement', 'unit_id'),
      },
      periodLock: {
        closedThrough: field('inventory_period_lock', 'closed_through'),
      },
      transaction: {
        actorId: field('inventory_transaction', 'actor_id'),
        effectiveAt: field('inventory_transaction', 'effective_at'),
        number: field('inventory_transaction', 'number'),
        reasonCode: field('inventory_transaction', 'reason_code'),
        reasonNarrative: field('inventory_transaction', 'reason_narrative'),
        recordedAt: field('inventory_transaction', 'recorded_at'),
        sourceId: field('inventory_transaction', 'source_id'),
        sourceType: field('inventory_transaction', 'source_type'),
        state: field('inventory_transaction', 'state'),
        type: field('inventory_transaction', 'type'),
      },
      transactionLine: {
        fromLocationId: field('inventory_transaction_line', 'from_location_id'),
        itemId: field('inventory_transaction_line', 'item_id'),
        lineNumber: field('inventory_transaction_line', 'line_number'),
        quantity: field('inventory_transaction_line', 'quantity'),
        toLocationId: field('inventory_transaction_line', 'to_location_id'),
        transactionId: field('inventory_transaction_line', 'transaction_id'),
        unitId: field('inventory_transaction_line', 'unit_id'),
      },
    },
    moduleId: `${namespace}:module.inventory`,
    namespace,
    packageId: `${namespace}:package.inventory`,
  } as const;
}

type InventoryIds = ReturnType<typeof ids>;

const defaultIds = ids(INVENTORY_NAMESPACE);

export const INVENTORY_IDS = Object.freeze(defaultIds);

/**
 * The inventory module owns business records in the same canonical module
 * plane as every other first-party domain. The movement is intentionally
 * read-only here: G3-P3 owns the only sanctioned posting writer.
 */
export function inventoryModuleDefinition(
  namespace: string = INVENTORY_NAMESPACE,
): Record<string, unknown> {
  const definitionIds = ids(namespace);
  const { entityIds, fieldIds, moduleId, packageId } = definitionIds;
  const standardEntities = [
    ['legal_entity', 'Legal entity', entityIds.legalEntity],
    ['inventory_transaction', 'Inventory transaction', entityIds.transaction],
    [
      'inventory_transaction_line',
      'Inventory transaction line',
      entityIds.transactionLine,
    ],
    ['inventory_period_lock', 'Inventory period lock', entityIds.periodLock],
  ] as const;
  const movementFields = Object.values(fieldIds.movement);

  return {
    assertions: [
      ...standardEntities.map(([local]) => assertion(definitionIds, local)),
      assertion(definitionIds, 'inventory_movement'),
    ],
    capabilityRequirements: [
      {
        capabilityId: definitionIds.contentCapabilityId,
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
      ...standardEntities.map(([local, label, entityId], index) =>
        entity(definitionIds, local, label, entityId, (index + 1) * 10),
      ),
      entity(
        definitionIds,
        'inventory_movement',
        'Inventory movement',
        entityIds.movement,
        50,
      ),
    ],
    fields: [
      field(
        definitionIds,
        entityIds.legalEntity,
        fieldIds.legalEntity.code,
        'Code',
        10,
        text(40),
        {
          businessKey: true,
          searchable: true,
        },
      ),
      field(
        definitionIds,
        entityIds.legalEntity,
        fieldIds.legalEntity.name,
        'Name',
        20,
        text(240),
        {
          searchable: true,
        },
      ),
      field(
        definitionIds,
        entityIds.legalEntity,
        fieldIds.legalEntity.status,
        'Status',
        30,
        enumeration(definitionIds, 'legal_entity_status', [
          'active',
          'archived',
        ]),
      ),
      field(
        definitionIds,
        entityIds.legalEntity,
        fieldIds.legalEntity.isDefault,
        'Default entity',
        40,
        boolean(),
      ),

      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.number,
        'Transaction number',
        10,
        text(60),
        {
          businessKey: true,
          searchable: true,
        },
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.type,
        'Transaction type',
        20,
        enumeration(definitionIds, 'inventory_transaction_type', [
          'opening',
          'adjustment',
          'transfer',
          'countCorrection',
          'reBaseline',
        ]),
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.state,
        'State',
        30,
        enumeration(definitionIds, 'inventory_transaction_state', [
          'draft',
          'posted',
          'reversed',
        ]),
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.reasonCode,
        'Reason code',
        40,
        text(80),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.reasonNarrative,
        'Reason narrative',
        50,
        text(1000),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.sourceType,
        'Source type',
        60,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.sourceId,
        'Source id',
        70,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.effectiveAt,
        'Effective at',
        80,
        instant(),
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.recordedAt,
        'Recorded at',
        90,
        instant(),
      ),
      field(
        definitionIds,
        entityIds.transaction,
        fieldIds.transaction.actorId,
        'Actor id',
        100,
        text(80),
      ),

      field(
        definitionIds,
        entityIds.transactionLine,
        fieldIds.transactionLine.transactionId,
        'Transaction id',
        10,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.transactionLine,
        fieldIds.transactionLine.lineNumber,
        'Line number',
        20,
        integer(),
      ),
      field(
        definitionIds,
        entityIds.transactionLine,
        fieldIds.transactionLine.itemId,
        'Item id',
        30,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.transactionLine,
        fieldIds.transactionLine.fromLocationId,
        'From location id',
        40,
        text(80),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.transactionLine,
        fieldIds.transactionLine.toLocationId,
        'To location id',
        50,
        text(80),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.transactionLine,
        fieldIds.transactionLine.quantity,
        'Quantity',
        60,
        decimal(),
      ),
      field(
        definitionIds,
        entityIds.transactionLine,
        fieldIds.transactionLine.unitId,
        'Unit id',
        70,
        text(32),
      ),

      field(
        definitionIds,
        entityIds.periodLock,
        fieldIds.periodLock.closedThrough,
        'Closed through',
        10,
        instant(),
        { optional: true },
      ),

      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.transactionId,
        'Transaction id',
        10,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.transactionLineId,
        'Transaction line id',
        20,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.stockDimensionSetVersion,
        'Stock dimension set version',
        30,
        enumeration(definitionIds, 'stock_dimension_set_version', ['v1']),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.itemId,
        'Item id',
        40,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.locationId,
        'Location id',
        50,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.quantityDelta,
        'Quantity delta',
        60,
        decimal(),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.unitId,
        'Unit id',
        70,
        text(32),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.effectiveAt,
        'Effective at',
        80,
        instant(),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.recordedAt,
        'Recorded at',
        90,
        instant(),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.sourceType,
        'Source type',
        100,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.sourceId,
        'Source id',
        110,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.sourceLine,
        'Source line',
        120,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.sourceRevision,
        'Source revision',
        130,
        integer(),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.postingRole,
        'Posting role',
        140,
        enumeration(definitionIds, 'inventory_posting_role', [
          'adjustment',
          'transfer',
          'count',
          'correction',
          'reBaseline',
        ]),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.reasonCode,
        'Reason code',
        150,
        text(80),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.reasonNarrative,
        'Reason narrative',
        160,
        text(1000),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.actorId,
        'Actor id',
        170,
        text(80),
      ),
      field(
        definitionIds,
        entityIds.movement,
        fieldIds.movement.reversalOfMovementId,
        'Reversal movement id',
        180,
        text(80),
        { optional: true },
      ),
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
        label: 'Inventory',
        moduleId,
        orderKey: 10,
        ownerPackageId: packageId,
        schemaVersion: version,
      },
    ],
    normalizationProfileVersion,
    operations: standardEntities.flatMap(([local, , entityId]) =>
      operations(definitionIds, local, entityId),
    ),
    package: {
      kind: 'packageDefinition',
      namespace,
      packageId,
      provenance: 'firstParty',
      schemaVersion: version,
      version: '1.0.0',
    },
    permissions: [
      ...standardEntities.flatMap(([local, , entityId]) =>
        permissions(definitionIds, local, entityId, false),
      ),
      ...permissions(
        definitionIds,
        'inventory_movement',
        entityIds.movement,
        true,
      ),
    ],
    queries: [
      ...standardEntities.flatMap(([local, , entityId]) => {
        const entityFields = fieldsForEntity(fieldIds, local);
        return queries(
          definitionIds,
          local,
          entityId,
          entityFields,
          entityFields[0]!,
        );
      }),
      ...queries(
        definitionIds,
        'inventory_movement',
        entityIds.movement,
        movementFields,
        fieldIds.movement.sourceId,
      ),
    ],
    relations: [],
    schemaVersion: version,
    stateMachines: [],
    storageMappings: [
      ...standardEntities.map(([local, , entityId]) =>
        storageMapping(definitionIds, local, entityId),
      ),
      storageMapping(definitionIds, 'inventory_movement', entityIds.movement),
    ],
    surfaces: [
      ...standardEntities.flatMap(([local, label]) =>
        surfaces(definitionIds, local, label, false),
      ),
      ...surfaces(
        definitionIds,
        'inventory_movement',
        'Inventory movement',
        true,
      ),
    ],
  };
}

function fieldsForEntity(
  fieldIds: InventoryIds['fieldIds'],
  local: string,
): readonly string[] {
  switch (local) {
    case 'legal_entity':
      return Object.values(fieldIds.legalEntity);
    case 'inventory_transaction':
      return Object.values(fieldIds.transaction);
    case 'inventory_transaction_line':
      return Object.values(fieldIds.transactionLine);
    case 'inventory_period_lock':
      return Object.values(fieldIds.periodLock);
    default:
      throw new TypeError(`unknown inventory entity ${local}`);
  }
}

function entity(
  ids: InventoryIds,
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

function field(
  ids: InventoryIds,
  entityId: string,
  fieldId: string,
  label: string,
  orderKey: number,
  fieldType: FieldType,
  options: {
    businessKey?: boolean;
    optional?: boolean;
    searchable?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    ...(options.businessKey
      ? { businessKey: 'tenantEnvironmentCaseInsensitiveUnique' }
      : {}),
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: options.optional ? 'nullable' : 'none',
    entity: reference('entityReference', entityId),
    fieldId,
    fieldType,
    kind: 'fieldDefinition',
    label,
    orderKey,
    presence: options.optional ? 'optional' : 'required',
    reportable: true,
    schemaVersion: version,
    searchable: options.searchable ?? false,
  };
}

const text = (maximumLength: number): FieldType => ({
  kind: 'textFieldType',
  maximumLength,
  schemaVersion: version,
});
const boolean = (): FieldType => ({
  kind: 'booleanFieldType',
  schemaVersion: version,
});
const integer = (): FieldType => ({
  kind: 'integerFieldType',
  representation: 'canonicalString',
  schemaVersion: version,
});
const decimal = (): FieldType => ({
  kind: 'exactDecimalFieldType',
  precision: 38,
  representation: 'canonicalString',
  scale: 18,
  schemaVersion: version,
});
const instant = (): FieldType => ({
  kind: 'dateTimeFieldType',
  precision: 'millisecond',
  schemaVersion: version,
  timezoneSemantics: 'utcInstant',
});

function enumeration(
  ids: InventoryIds,
  local: string,
  values: readonly string[],
): FieldType {
  return {
    kind: 'enumFieldType',
    options: values.map((value, index) => ({
      kind: 'enumOption',
      label: value,
      optionId: `${ids.namespace}:option.${local}_${value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}`,
      orderKey: (index + 1) * 10,
      schemaVersion: version,
    })),
    schemaVersion: version,
  };
}

function queries(
  ids: InventoryIds,
  local: string,
  entityId: string,
  selectedFieldIds: readonly string[],
  resolveFieldId: string,
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
          resolveMatchKeys: [
            {
              authority: 'identifier',
              field: reference('fieldReference', resolveFieldId),
              kind: 'resolveMatchKey',
              matchKeyId: `${ids.namespace}:resolve-key.${local}`,
              orderKey: 10,
              schemaVersion: version,
            },
          ],
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

function operations(
  ids: InventoryIds,
  local: string,
  entityId: string,
): Array<Record<string, unknown>> {
  return (
    [
      ['create', 'createRecordEffect'],
      ['update', 'updateRecordEffect'],
      ['archive', 'archiveRecordEffect'],
      ['restore', 'restoreRecordEffect'],
    ] as const
  ).map(([action, kind]) => ({
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

function permissions(
  ids: InventoryIds,
  local: string,
  entityId: string,
  readOnly: boolean,
): Array<Record<string, unknown>> {
  return (
    readOnly ? ['read'] : ['create', 'read', 'update', 'archive', 'restore']
  ).map((action) => ({
    action,
    kind: 'permissionDefinition',
    label: `${local} ${action}`,
    permissionId: `${ids.namespace}:permission.${local}_${action}`,
    resource: reference('entityReference', entityId),
    schemaVersion: version,
  }));
}

function surfaces(
  ids: InventoryIds,
  local: string,
  label: string,
  readOnly: boolean,
): Array<Record<string, unknown>> {
  const descriptors: Array<
    readonly [string, string, readonly string[], 'form' | 'list' | 'record']
  > = [
    ['list', 'list', ['title', 'dataGrid'], 'list'],
    [
      'detail',
      'record',
      ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts'],
      'record',
    ],
    ...(readOnly
      ? []
      : ([
          [
            'form',
            'record',
            ['breadcrumb', 'titleStatus', 'commandBar', 'sections'],
            'form',
          ],
        ] as const)),
  ];
  return descriptors.map(([suffix, archetype, slots, surfaceRole]) => ({
    archetype,
    dataSource: reference(
      'queryReference',
      `${ids.namespace}:query.${local}_${surfaceRole === 'list' ? 'list' : 'get'}`,
    ),
    kind: 'surfaceDefinition',
    label: `${label} ${suffix}`,
    module: reference('moduleReference', ids.moduleId),
    schemaVersion: version,
    slots: slots.map((slot, index) => ({
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
  ids: InventoryIds,
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

function assertion(ids: InventoryIds, local: string): Record<string, unknown> {
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
      query: reference('queryReference', `${ids.namespace}:query.${local}_get`),
      schemaVersion: version,
    },
    kind: 'assertionDefinition',
    schemaVersion: version,
  };
}
