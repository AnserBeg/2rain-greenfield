const version = 'v6' as const;
const normalizationProfileVersion = 'northstar.normalization/v6' as const;

export const SALES_NAMESPACE = 'northstar.sales' as const;
export const FULFILLMENT_CAPABILITY_ID =
  'northstar.sales:capability.fulfillment' as const;
export const FULFILLMENT_CAPABILITY_VERSION = 1 as const;

type FieldType = Record<string, unknown>;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

const STATES = [
  ['draft', 'Draft', false],
  ['released', 'Released', false],
  ['closed', 'Closed', false],
  ['cancelled', 'Cancelled', true],
] as const;

const TRANSITIONS = [
  ['release', 'Release order', 10, 'draft', 'released', 'release', true],
  ['draft_cancel', 'Cancel order', 20, 'draft', 'cancelled', 'cancel', true],
  ['close', 'Close order', 30, 'released', 'closed', 'close', false],
  ['cancel', 'Cancel order', 40, 'released', 'cancelled', 'cancel', false],
] as const;

type StateLocalId = (typeof STATES)[number][0];
type TransitionLocalId = (typeof TRANSITIONS)[number][0];
type TransitionPermissionLocalId = (typeof TRANSITIONS)[number][5];

const DRIVEN_TRANSITIONS = TRANSITIONS.filter(([, , , , , , driven]) => driven);
const TRANSITION_PERMISSIONS = [
  ...new Set(TRANSITIONS.map(([, , , , , permission]) => permission)),
] as readonly TransitionPermissionLocalId[];

const ENTITY_OWNED_QUERY_FAMILIES = new Set([
  'sales_order',
  'sales_order_line',
  'reservation',
  'reservation_balance',
  'shipment',
  'shipment_line',
  'sales_order_shipped',
]);

function ids(namespace: string) {
  const entity = (local: string) => `${namespace}:entity.${local}`;
  const field = (local: string, name: string) =>
    `${namespace}:field.${local}_${name}`;
  const machineId = `${namespace}:machine.sales_order_lifecycle`;
  return {
    contentCapabilityId: `${namespace}:capability.standard_surface_content`,
    entityIds: {
      salesOrder: entity('sales_order'),
      salesOrderLine: entity('sales_order_line'),
      reservation: entity('reservation'),
      reservationBalance: entity('reservation_balance'),
      shipment: entity('shipment'),
      shipmentLine: entity('shipment_line'),
      shipped: entity('sales_order_shipped'),
    },
    fieldIds: {
      salesOrder: {
        currency: field('sales_order', 'currency'),
        customerPartyId: field('sales_order', 'customer_party_id'),
        notes: field('sales_order', 'notes'),
        number: field('sales_order', 'number'),
        orderDate: field('sales_order', 'order_date'),
        requestedDate: field('sales_order', 'requested_date'),
      },
      salesOrderLine: {
        itemId: field('sales_order_line', 'item_id'),
        lineNumber: field('sales_order_line', 'line_number'),
        orderedQuantity: field('sales_order_line', 'ordered_quantity'),
        unitId: field('sales_order_line', 'unit_id'),
        unitPrice: field('sales_order_line', 'unit_price'),
      },
    },
    machineId,
    moduleId: `${namespace}:module.sales`,
    namespace,
    packageId: `${namespace}:package.sales`,
    relationIds: {
      salesOrderLineOrder: `${namespace}:relation.sales_order_line_order`,
      reservationOrderLine: `${namespace}:relation.reservation_order_line`,
      reservationBalanceReservation: `${namespace}:relation.reservation_balance_reservation`,
      shipmentOrder: `${namespace}:relation.shipment_order`,
      shipmentSupersedes: `${namespace}:relation.shipment_supersedes`,
      shipmentLineShipment: `${namespace}:relation.shipment_line_shipment`,
      shipmentLineOrderLine: `${namespace}:relation.shipment_line_order_line`,
      shipmentLineReservation: `${namespace}:relation.shipment_line_reservation`,
      shippedOrderLine: `${namespace}:relation.sales_order_shipped_order_line`,
    },
    stateFieldId: derivedStateFieldId(machineId),
    stateIds: Object.fromEntries(
      STATES.map(([local]) => [
        local,
        `${namespace}:state.sales_order_${local}`,
      ]),
    ) as Record<StateLocalId, string>,
    transitionIds: Object.fromEntries(
      TRANSITIONS.map(([local]) => [
        local,
        `${namespace}:transition.sales_order_${local}`,
      ]),
    ) as Record<TransitionLocalId, string>,
  } as const;
}

type SalesIds = ReturnType<typeof ids>;

export const SALES_IDS = Object.freeze(ids(SALES_NAMESPACE));

/** Sales order entry plus the fulfillment documents and read-model carriers. */
export function salesModuleDefinition(
  namespace: string = SALES_NAMESPACE,
): Record<string, unknown> {
  const definitionIds = ids(namespace);
  const { entityIds, fieldIds, moduleId, packageId, stateFieldId } =
    definitionIds;
  const entities = [
    ['sales_order', 'Sales order', entityIds.salesOrder],
    ['sales_order_line', 'Sales order line', entityIds.salesOrderLine],
    ['reservation', 'Reservation', entityIds.reservation],
    [
      'reservation_balance',
      'Reservation coverage',
      entityIds.reservationBalance,
    ],
    ['shipment', 'Shipment', entityIds.shipment],
    ['shipment_line', 'Shipment line', entityIds.shipmentLine],
    ['sales_order_shipped', 'Shipped quantity', entityIds.shipped],
  ] as const;

  return {
    assertions: entities.map(([local]) => assertion(definitionIds, local)),
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
      {
        capabilityId: FULFILLMENT_CAPABILITY_ID,
        capabilityVersion: FULFILLMENT_CAPABILITY_VERSION,
        declaredEffects: ['appendFact'],
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
    entities: entities.map(([local, label, entityId], index) =>
      entity(definitionIds, local, label, entityId, (index + 1) * 10),
    ),
    fields: [
      field(
        definitionIds,
        entityIds.salesOrder,
        fieldIds.salesOrder.number,
        'Order number',
        10,
        text(60),
        { businessKey: true, searchable: true },
      ),
      field(
        definitionIds,
        entityIds.salesOrder,
        fieldIds.salesOrder.customerPartyId,
        'Customer party id',
        20,
        text(80),
        { searchable: true },
      ),
      field(
        definitionIds,
        entityIds.salesOrder,
        fieldIds.salesOrder.orderDate,
        'Order date',
        30,
        instant(),
      ),
      field(
        definitionIds,
        entityIds.salesOrder,
        fieldIds.salesOrder.requestedDate,
        'Requested date',
        40,
        instant(),
        { optional: true },
      ),
      ...fulfillmentFields(definitionIds),
      field(
        definitionIds,
        entityIds.salesOrder,
        fieldIds.salesOrder.currency,
        'Currency',
        50,
        text(3),
        { searchable: true },
      ),
      field(
        definitionIds,
        entityIds.salesOrder,
        fieldIds.salesOrder.notes,
        'Notes',
        60,
        text(1000),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.salesOrderLine,
        fieldIds.salesOrderLine.lineNumber,
        'Line number',
        10,
        integer(),
      ),
      field(
        definitionIds,
        entityIds.salesOrderLine,
        fieldIds.salesOrderLine.itemId,
        'Item id',
        20,
        text(80),
        { searchable: true },
      ),
      field(
        definitionIds,
        entityIds.salesOrderLine,
        fieldIds.salesOrderLine.unitId,
        'Unit',
        30,
        text(32),
        { searchable: true },
      ),
      field(
        definitionIds,
        entityIds.salesOrderLine,
        fieldIds.salesOrderLine.orderedQuantity,
        'Ordered quantity',
        40,
        decimal(),
      ),
      field(
        definitionIds,
        entityIds.salesOrderLine,
        fieldIds.salesOrderLine.unitPrice,
        'Unit price',
        50,
        decimal(),
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
        label: 'Sales',
        moduleId,
        orderKey: 10,
        ownerPackageId: packageId,
        schemaVersion: version,
      },
    ],
    normalizationProfileVersion,
    operations: [
      ...operations(
        definitionIds,
        'sales_order',
        entityIds.salesOrder,
        editableStates(definitionIds),
      ),
      ...operations(
        definitionIds,
        'sales_order_line',
        entityIds.salesOrderLine,
      ),
      ...operations(
        definitionIds,
        'reservation',
        entityIds.reservation,
        fieldComparison(
          `${namespace}:field.reservation_state`,
          `${namespace}:option.reservation_state_draft`,
        ),
      ),
      ...operations(
        definitionIds,
        'shipment',
        entityIds.shipment,
        fieldComparison(
          `${namespace}:field.shipment_state`,
          `${namespace}:option.shipment_state_draft`,
        ),
      ),
      ...operations(definitionIds, 'shipment_line', entityIds.shipmentLine),
      fulfillmentOperation(definitionIds, 'reservation', 'reserve'),
      fulfillmentOperation(definitionIds, 'reservation', 'release'),
      fulfillmentOperation(definitionIds, 'shipment', 'post'),
      fulfillmentOperation(definitionIds, 'sales_order', 'close'),
      fulfillmentOperation(definitionIds, 'sales_order', 'cancel'),
      ...DRIVEN_TRANSITIONS.map(([local, , , fromState, , permission]) =>
        transitionOperation(
          definitionIds,
          local,
          permission,
          inState(stateFieldId, definitionIds.stateIds[fromState]),
        ),
      ),
    ],
    package: {
      kind: 'packageDefinition',
      namespace,
      packageId,
      provenance: 'firstParty',
      schemaVersion: version,
      version: '1.0.0',
    },
    permissions: [
      ...entities.flatMap(([local, , entityId]) =>
        permissions(definitionIds, local, entityId).filter(
          (permission) =>
            !['sales_order_shipped', 'reservation_balance'].includes(local) ||
            permission.action === 'read',
        ),
      ),
      ...TRANSITION_PERMISSIONS.map((local) =>
        transitionPermission(definitionIds, local),
      ),
      ...(
        [
          ['reservation', 'reserve'],
          ['reservation', 'release'],
          ['shipment', 'post'],
        ] as const
      ).map(([local, action]) => ({
        action: 'transition',
        kind: 'permissionDefinition',
        label: `${local} ${action}`,
        permissionId: `${namespace}:permission.${local}_${action}`,
        resource: reference('entityReference', `${namespace}:entity.${local}`),
        schemaVersion: version,
      })),
    ],
    queries: entities.flatMap(([local, , entityId]) =>
      queries(
        definitionIds,
        local,
        entityId,
        selectedFieldsForEntity(definitionIds, local),
        resolveFieldForEntity(definitionIds, local),
      ),
    ),
    relations: [
      relation(
        definitionIds.relationIds.salesOrderLineOrder,
        entityIds.salesOrderLine,
        entityIds.salesOrder,
        10,
      ),
      {
        ...relation(
          definitionIds.relationIds.reservationOrderLine,
          entityIds.reservation,
          entityIds.salesOrderLine,
          20,
        ),
        ownership: 'reference',
      },
      {
        ...relation(
          definitionIds.relationIds.reservationBalanceReservation,
          entityIds.reservationBalance,
          entityIds.reservation,
          25,
        ),
        ownership: 'reference',
      },
      {
        ...relation(
          definitionIds.relationIds.shipmentOrder,
          entityIds.shipment,
          entityIds.salesOrder,
          30,
        ),
        ownership: 'reference',
      },
      {
        ...relation(
          definitionIds.relationIds.shipmentSupersedes,
          entityIds.shipment,
          entityIds.shipment,
          40,
        ),
        ownership: 'reference',
        required: false,
      },
      relation(
        definitionIds.relationIds.shipmentLineShipment,
        entityIds.shipmentLine,
        entityIds.shipment,
        50,
      ),
      {
        ...relation(
          definitionIds.relationIds.shipmentLineOrderLine,
          entityIds.shipmentLine,
          entityIds.salesOrderLine,
          60,
        ),
        ownership: 'reference',
      },
      {
        ...relation(
          definitionIds.relationIds.shipmentLineReservation,
          entityIds.shipmentLine,
          entityIds.reservation,
          70,
        ),
        ownership: 'reference',
      },
      {
        ...relation(
          definitionIds.relationIds.shippedOrderLine,
          entityIds.shipped,
          entityIds.salesOrderLine,
          80,
        ),
        ownership: 'reference',
      },
    ],
    schemaVersion: version,
    stateMachines: [stateMachine(definitionIds)],
    storageMappings: entities.map(([local, , entityId]) =>
      storageMapping(definitionIds, local, entityId),
    ),
    surfaces: entities.flatMap(([local, label]) =>
      surfaces(definitionIds, local, label).filter(
        (surface) =>
          !['sales_order_shipped', 'reservation_balance'].includes(local) ||
          surface.surfaceRole !== 'form',
      ),
    ),
  };
}

function fulfillmentFields(ids: SalesIds): Array<Record<string, unknown>> {
  const enumType = (
    local: string,
    name: string,
    options: readonly string[],
  ): FieldType => ({
    kind: 'enumFieldType',
    schemaVersion: version,
    options: options.map((value, index) => ({
      kind: 'enumOption',
      schemaVersion: version,
      optionId: `${ids.namespace}:option.${local}_${name}_${value}`,
      label: value.replaceAll('_', ' '),
      orderKey: (index + 1) * 10,
    })),
  });
  const specs: Array<readonly [string, string, string, FieldType, boolean?]> = [
    ['reservation', 'number', 'Reservation number', text(60)],
    [
      'reservation',
      'state',
      'State',
      enumType('reservation', 'state', [
        'draft',
        'active',
        'partially_consumed',
        'consumed',
        'released',
      ]),
    ],
    ['reservation', 'item_id', 'Item', text(80)],
    ['reservation', 'location_id', 'Location', text(80)],
    ['reservation', 'quantity', 'Quantity', decimal()],
    ['reservation', 'unit_id', 'Base unit', text(32)],
    ['reservation', 'reason', 'Release reason', text(1000), true],
    [
      'reservation_balance',
      'remaining_quantity',
      'Reserved quantity',
      decimal(),
    ],
    ['reservation_balance', 'unit_id', 'Base unit', text(32)],
    ['shipment', 'number', 'Shipment number', text(60)],
    [
      'shipment',
      'state',
      'State',
      enumType('shipment', 'state', ['draft', 'posted']),
    ],
    [
      'shipment',
      'kind',
      'Kind',
      enumType('shipment', 'kind', ['initial', 'correction', 'reversal']),
    ],
    ['shipment', 'effective_at', 'Shipped at', instant()],
    ['shipment', 'location_id', 'Ship-from location', text(80)],
    ['shipment', 'external_reference', 'External reference', text(120), true],
    ['shipment', 'reason_code', 'Reason code', text(80)],
    ['shipment', 'reason_narrative', 'Reason', text(1000), true],
    ['shipment_line', 'line_number', 'Line number', integer()],
    ['shipment_line', 'item_id', 'Item', text(80)],
    ['shipment_line', 'quantity', 'Quantity', decimal()],
    ['shipment_line', 'unit_id', 'Base unit', text(32)],
    [
      'shipment_line',
      'reversal_of_movement_id',
      'Compensated movement',
      text(80),
      true,
    ],
    ['sales_order_shipped', 'shipped_quantity', 'Shipped quantity', decimal()],
    ['sales_order_shipped', 'unit_id', 'Base unit', text(32)],
  ];
  return specs.map(([local, name, label, type, optional], index) =>
    field(
      ids,
      `${ids.namespace}:entity.${local}`,
      `${ids.namespace}:field.${local}_${name}`,
      label,
      (index + 1) * 10,
      type,
      {
        optional: optional ?? false,
        searchable: ['number', 'item_id', 'location_id', 'unit_id'].includes(
          name,
        ),
        businessKey: name === 'number',
      },
    ),
  );
}

function fulfillmentOperation(
  ids: SalesIds,
  local: string,
  action: string,
): Record<string, unknown> {
  return {
    confirmation: 'humanRequired',
    effect: {
      kind: 'registeredCapabilityEffect',
      schemaVersion: version,
      capability: reference('capabilityReference', FULFILLMENT_CAPABILITY_ID),
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
    tier: 'o1',
  };
}

function derivedStateFieldId(machineId: string): string {
  const separator = machineId.indexOf(':');
  return `${machineId.slice(0, separator)}:derived_state_field.${machineId.slice(separator + 1)}`;
}

function stateMachine(ids: SalesIds): Record<string, unknown> {
  return {
    entity: reference('entityReference', ids.entityIds.salesOrder),
    initialState: reference('stateReference', ids.stateIds.draft),
    kind: 'stateMachineDefinition',
    machineId: ids.machineId,
    schemaVersion: version,
    states: STATES.map(([local, label, terminal], index) => ({
      kind: 'stateDefinition',
      label,
      orderKey: (index + 1) * 10,
      schemaVersion: version,
      stateId: ids.stateIds[local],
      terminal,
    })),
    transitions: TRANSITIONS.map(
      ([local, label, orderKey, fromState, toState, permission]) => ({
        fromState: reference('stateReference', ids.stateIds[fromState]),
        kind: 'transitionDefinition',
        label,
        orderKey,
        permission: reference(
          'permissionReference',
          transitionPermissionId(ids, permission),
        ),
        schemaVersion: version,
        toState: reference('stateReference', ids.stateIds[toState]),
        transitionId: ids.transitionIds[local],
      }),
    ),
  };
}

function transitionPermissionId(
  ids: SalesIds,
  action: TransitionPermissionLocalId,
): string {
  return `${ids.namespace}:permission.sales_order_${action}`;
}

function transitionPermission(
  ids: SalesIds,
  action: TransitionPermissionLocalId,
): Record<string, unknown> {
  return {
    action: 'transition',
    kind: 'permissionDefinition',
    label: `sales_order ${action}`,
    permissionId: transitionPermissionId(ids, action),
    resource: reference('entityReference', ids.entityIds.salesOrder),
    schemaVersion: version,
  };
}

function transitionOperation(
  ids: SalesIds,
  action: TransitionLocalId,
  permission: TransitionPermissionLocalId,
  precondition: Record<string, unknown>,
): Record<string, unknown> {
  return {
    confirmation: permission === 'cancel' ? 'humanRequired' : 'none',
    effect: {
      kind: 'transitionStateEffect',
      schemaVersion: version,
      transition: reference('transitionReference', ids.transitionIds[action]),
    },
    kind: 'operationDefinition',
    module: reference('moduleReference', ids.moduleId),
    operationId: `${ids.namespace}:operation.sales_order_${action}`,
    permission: reference(
      'permissionReference',
      transitionPermissionId(ids, permission),
    ),
    precondition,
    readBack: reference(
      'queryReference',
      `${ids.namespace}:query.sales_order_get`,
    ),
    schemaVersion: version,
    tier: 'o0',
  };
}

function fieldComparison(
  fieldId: string,
  targetId: string,
): Record<string, unknown> {
  return {
    field: reference('fieldReference', fieldId),
    kind: 'fieldComparisonPredicate',
    operator: 'equals',
    schemaVersion: version,
    value: { kind: 'textValue', schemaVersion: version, value: targetId },
  };
}

function inState(fieldId: string, stateId: string): Record<string, unknown> {
  return fieldComparison(fieldId, stateId);
}

function editableStates(ids: SalesIds): Record<string, unknown> {
  return {
    kind: 'allPredicate',
    schemaVersion: version,
    terms: (['released', 'closed', 'cancelled'] as const).map((state) => ({
      kind: 'notPredicate',
      schemaVersion: version,
      term: fieldComparison(ids.stateFieldId, ids.stateIds[state]),
    })),
  };
}

function selectedFieldsForEntity(
  ids: SalesIds,
  local: string,
): readonly string[] {
  if (local === 'sales_order')
    return [ids.stateFieldId, ...Object.values(ids.fieldIds.salesOrder)];
  if (local === 'sales_order_line')
    return Object.values(ids.fieldIds.salesOrderLine);
  const fields: Record<string, readonly string[]> = {
    reservation: [
      'number',
      'state',
      'item_id',
      'location_id',
      'quantity',
      'unit_id',
      'reason',
    ],
    reservation_balance: ['remaining_quantity', 'unit_id'],
    shipment: [
      'number',
      'state',
      'kind',
      'effective_at',
      'location_id',
      'external_reference',
      'reason_code',
      'reason_narrative',
    ],
    shipment_line: [
      'line_number',
      'item_id',
      'quantity',
      'unit_id',
      'reversal_of_movement_id',
    ],
    sales_order_shipped: ['shipped_quantity', 'unit_id'],
  };
  return (fields[local] ?? []).map(
    (name) => `${ids.namespace}:field.${local}_${name}`,
  );
}

function resolveFieldForEntity(ids: SalesIds, local: string): string {
  const name =
    local === 'sales_order'
      ? 'sales_order_number'
      : local === 'sales_order_line'
        ? 'sales_order_line_item_id'
        : local === 'reservation'
          ? 'reservation_number'
          : local === 'reservation_balance'
            ? 'reservation_balance_unit_id'
            : local === 'shipment'
              ? 'shipment_number'
              : local === 'shipment_line'
                ? 'shipment_line_item_id'
                : 'sales_order_shipped_unit_id';
  return `${ids.namespace}:field.${name}`;
}

function entity(
  ids: SalesIds,
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
  ids: SalesIds,
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

function queries(
  ids: SalesIds,
  local: string,
  entityId: string,
  selectedFieldIds: readonly string[],
  resolveFieldId: string,
): Array<Record<string, unknown>> {
  return (['get', 'list', 'search', 'resolve'] as const).map((queryType) => {
    const scopeParameterId = `${ids.namespace}:parameter.${local}_${queryType}_legal_entity_scope`;
    return {
      kind: 'queryDefinition',
      ...(ENTITY_OWNED_QUERY_FAMILIES.has(local)
        ? {
            legalEntityScope: {
              cardinality: 'exactlyOne',
              kind: 'queryLegalEntityScope',
              operand: {
                kind: 'queryParameterReference',
                parameterId: scopeParameterId,
                schemaVersion: version,
              },
              schemaVersion: version,
            },
            parameters: [
              {
                kind: 'queryParameterDefinition',
                orderKey: 10,
                parameterId: scopeParameterId,
                schemaVersion: version,
              },
            ],
          }
        : {}),
      maximumResultCount: queryType === 'get' ? 1 : 100,
      // The declared List exports this whole filtered set in one statement.
      ...(queryType === 'list' && local === 'sales_order'
        ? { exportMaximumResultCount: 5_000 }
        : {}),
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
    };
  });
}

function operations(
  ids: SalesIds,
  local: string,
  entityId: string,
  precondition?: Record<string, unknown>,
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
    ...(precondition ? { precondition } : {}),
    readBack: reference(
      'queryReference',
      `${ids.namespace}:query.${local}_get`,
    ),
    schemaVersion: version,
    tier: 'o0',
  }));
}

function relation(
  relationId: string,
  sourceEntityId: string,
  targetEntityId: string,
  orderKey: number,
): Record<string, unknown> {
  return {
    archiveBehavior: 'restrict',
    cardinality: 'manyToOne',
    foreignKeyActions: {
      onDelete: 'restrict',
      onUpdate: 'restrict',
      schemaVersion: version,
    },
    joinEligibility: 'query',
    kind: 'relationDefinition',
    orderKey,
    ownership: 'parentScopedChild',
    relationId,
    required: true,
    schemaVersion: version,
    sourceEntity: reference('entityReference', sourceEntityId),
    targetEntity: reference('entityReference', targetEntityId),
  };
}

function permissions(
  ids: SalesIds,
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

function surfaces(
  ids: SalesIds,
  local: string,
  label: string,
): Array<Record<string, unknown>> {
  const descriptors: Array<
    readonly [string, string, readonly string[], 'form' | 'list' | 'record']
  > = [
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
  ids: SalesIds,
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

function assertion(ids: SalesIds, local: string): Record<string, unknown> {
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
