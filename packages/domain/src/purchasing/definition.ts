// Canonical language v4 is the query-operand language, shared with every other
// first-party module. Purchasing declares no capability of its own, and nothing
// here appends an inventory fact.
//
// SCOPE, as held: this file is the purchase order DOCUMENT -- entities, fields,
// queries, generic operations, surfaces and the parent-scoped line relation. It
// deliberately contains NO business transition. PUR-1's viability review
// refuted the assumption that `draft -> released` could be delivered by an
// enumeration plus an ADR-0034 precondition: the generic O0 input contract
// makes every active field writable and the interpreter applies the caller's
// patch verbatim, so a precondition can REFUSE an edit but cannot IMPLEMENT a
// transition. A business transition needs a named O1 handler, and that seam
// does not exist yet. The four state values are authored because the shape is
// the plan's; only `draft` is producible until the handler seam lands.
const version = 'v4' as const;
const normalizationProfileVersion = 'northstar.normalization/v4' as const;

export const PURCHASING_NAMESPACE = 'northstar.purchasing' as const;

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
      purchaseOrder: entity('purchase_order'),
      purchaseOrderLine: entity('purchase_order_line'),
    },
    fieldIds: {
      purchaseOrder: {
        currency: field('purchase_order', 'currency'),
        expectedDate: field('purchase_order', 'expected_date'),
        notes: field('purchase_order', 'notes'),
        number: field('purchase_order', 'number'),
        orderDate: field('purchase_order', 'order_date'),
        state: field('purchase_order', 'state'),
        supplierPartyId: field('purchase_order', 'supplier_party_id'),
      },
      purchaseOrderLine: {
        itemId: field('purchase_order_line', 'item_id'),
        lineNumber: field('purchase_order_line', 'line_number'),
        orderedQuantity: field('purchase_order_line', 'ordered_quantity'),
        unitPrice: field('purchase_order_line', 'unit_price'),
      },
    },
    moduleId: `${namespace}:module.purchasing`,
    namespace,
    optionIds: {
      state: {
        cancelled: `${namespace}:option.purchase_order_state_cancelled`,
        closed: `${namespace}:option.purchase_order_state_closed`,
        draft: `${namespace}:option.purchase_order_state_draft`,
        released: `${namespace}:option.purchase_order_state_released`,
      },
    },
    packageId: `${namespace}:package.purchasing`,
    relationIds: {
      purchaseOrderLineOrder: `${namespace}:relation.purchase_order_line_order`,
    },
  } as const;
}

type PurchasingIds = ReturnType<typeof ids>;

const defaultIds = ids(PURCHASING_NAMESPACE);

export const PURCHASING_IDS = Object.freeze(defaultIds);

/** Both purchasing families are `entityOwned` (ADR-0015): every query is scoped. */
const ENTITY_OWNED_QUERY_FAMILIES = new Set([
  'purchase_order',
  'purchase_order_line',
]);

/**
 * The purchase order document.
 *
 * `state` is an ordinary enumeration field, exactly as `stock_count` authors
 * its four values. `stateMachines` stays empty: the concept compiles and
 * materializes but nothing in `packages/runtime/` reads it, so declaring one
 * would add a second, unexecuted description of the same lifecycle.
 *
 * Editing is closed by ADR-0034 declared preconditions rather than by UI. The
 * header's four generic operations carry a not-released precondition, and the
 * generic parent-aggregate rule carries it down to `purchase_order_line` with
 * zero line-level declarations -- a mutating operation on the source of an
 * active `parentScopedChild` relation must also satisfy the parent's update
 * precondition against the parent's current image.
 *
 * That guard is the half of the design that survives review. It states what
 * MUST NOT happen once an order is released. What moves an order INTO
 * `released` is not expressible here, and is not attempted -- see the scope
 * note at the top of this file.
 */
export function purchasingModuleDefinition(
  namespace: string = PURCHASING_NAMESPACE,
): Record<string, unknown> {
  const definitionIds = ids(namespace);
  const { entityIds, fieldIds, moduleId, packageId } = definitionIds;
  const standardEntities = [
    ['purchase_order', 'Purchase order', entityIds.purchaseOrder],
    ['purchase_order_line', 'Purchase order line', entityIds.purchaseOrderLine],
  ] as const;

  return {
    assertions: standardEntities.map(([local]) =>
      assertion(definitionIds, local),
    ),
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
    entities: standardEntities.map(([local, label, entityId], index) =>
      entity(definitionIds, local, label, entityId, (index + 1) * 10),
    ),
    fields: [
      field(
        definitionIds,
        entityIds.purchaseOrder,
        fieldIds.purchaseOrder.number,
        'Order number',
        10,
        text(60),
        { businessKey: true, searchable: true },
      ),
      field(
        definitionIds,
        entityIds.purchaseOrder,
        fieldIds.purchaseOrder.supplierPartyId,
        'Supplier party id',
        20,
        text(80),
        { searchable: true },
      ),
      field(
        definitionIds,
        entityIds.purchaseOrder,
        fieldIds.purchaseOrder.state,
        'Order state',
        30,
        enumeration(definitionIds, 'purchase_order_state', [
          'draft',
          'released',
          'closed',
          'cancelled',
        ]),
      ),
      field(
        definitionIds,
        entityIds.purchaseOrder,
        fieldIds.purchaseOrder.orderDate,
        'Order date',
        40,
        instant(),
      ),
      field(
        definitionIds,
        entityIds.purchaseOrder,
        fieldIds.purchaseOrder.expectedDate,
        'Expected date',
        50,
        instant(),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.purchaseOrder,
        fieldIds.purchaseOrder.currency,
        'Currency',
        60,
        text(3),
      ),
      field(
        definitionIds,
        entityIds.purchaseOrder,
        fieldIds.purchaseOrder.notes,
        'Notes',
        70,
        text(1000),
        { optional: true },
      ),

      field(
        definitionIds,
        entityIds.purchaseOrderLine,
        fieldIds.purchaseOrderLine.lineNumber,
        'Line number',
        10,
        integer(),
      ),
      field(
        definitionIds,
        entityIds.purchaseOrderLine,
        fieldIds.purchaseOrderLine.itemId,
        'Item id',
        20,
        text(80),
        { searchable: true },
      ),
      field(
        definitionIds,
        entityIds.purchaseOrderLine,
        fieldIds.purchaseOrderLine.orderedQuantity,
        'Ordered quantity',
        30,
        decimal(),
      ),
      // NO received quantity. Plan section 6.2 calls it "received quantity read
      // model", derived from posted receipts -- and PUR-1 ships no receipts, so
      // a stored column here could only ever hold zero. PS-0's race table
      // closes over-receipt two different ways: compare-and-swap on a STORED
      // quantity, or lock-and-sum on a DERIVED one. Authoring the column now
      // would pre-commit that choice on behalf of a packet that has no data to
      // justify it. PUR-2 chooses, together with the posting protocol that
      // makes the choice meaningful, and SAL-1 inherits the same rule for
      // shipped quantity.
      field(
        definitionIds,
        entityIds.purchaseOrderLine,
        fieldIds.purchaseOrderLine.unitPrice,
        'Unit price',
        40,
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
        label: 'Purchasing',
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
        'purchase_order',
        entityIds.purchaseOrder,
        notInState(definitionIds, definitionIds.optionIds.state.released),
      ),
      ...operations(
        definitionIds,
        'purchase_order_line',
        entityIds.purchaseOrderLine,
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
    permissions: standardEntities.flatMap(([local, , entityId]) =>
      permissions(definitionIds, local, entityId),
    ),
    queries: standardEntities.flatMap(([local, , entityId]) =>
      queries(
        definitionIds,
        local,
        entityId,
        fieldsForEntity(fieldIds, local),
        resolveFieldForEntity(fieldIds, local),
      ),
    ),
    relations: [
      relation(
        definitionIds.relationIds.purchaseOrderLineOrder,
        entityIds.purchaseOrderLine,
        entityIds.purchaseOrder,
        10,
      ),
    ],
    schemaVersion: version,
    stateMachines: [],
    storageMappings: standardEntities.map(([local, , entityId]) =>
      storageMapping(definitionIds, local, entityId),
    ),
    surfaces: standardEntities.flatMap(([local, label]) =>
      surfaces(definitionIds, local, label),
    ),
  };
}

function fieldComparison(
  fieldId: string,
  optionId: string,
): Record<string, unknown> {
  return {
    field: reference('fieldReference', fieldId),
    kind: 'fieldComparisonPredicate',
    operator: 'equals',
    schemaVersion: version,
    value: {
      kind: 'textValue',
      schemaVersion: version,
      value: optionId,
    },
  };
}

/** The ADR-0034 shape: `not( state equals <option> )`, as `stock_count` writes it. */
function notInState(
  ids: PurchasingIds,
  optionId: string,
): Record<string, unknown> {
  return {
    kind: 'notPredicate',
    schemaVersion: version,
    term: fieldComparison(ids.fieldIds.purchaseOrder.state, optionId),
  };
}

function fieldsForEntity(
  fieldIds: PurchasingIds['fieldIds'],
  local: string,
): readonly string[] {
  switch (local) {
    case 'purchase_order':
      return Object.values(fieldIds.purchaseOrder);
    case 'purchase_order_line':
      return Object.values(fieldIds.purchaseOrderLine);
    default:
      throw new TypeError(`unknown purchasing entity ${local}`);
  }
}

/**
 * ADR-0042: an entity that CAN be looked up by typed text must expose that
 * lookup, and the key is chosen deliberately rather than taken from field
 * order. The order number is the document's business key; a line is found by
 * the item it orders.
 */
function resolveFieldForEntity(
  fieldIds: PurchasingIds['fieldIds'],
  local: string,
): string {
  switch (local) {
    case 'purchase_order':
      return fieldIds.purchaseOrder.number;
    case 'purchase_order_line':
      return fieldIds.purchaseOrderLine.itemId;
    default:
      throw new TypeError(`unknown purchasing entity ${local}`);
  }
}

function entity(
  ids: PurchasingIds,
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
  ids: PurchasingIds,
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

function enumeration(
  ids: PurchasingIds,
  local: string,
  values: readonly string[],
): FieldType {
  return {
    kind: 'enumFieldType',
    options: values.map((value, index) => ({
      kind: 'enumOption',
      label: value,
      optionId: `${ids.namespace}:option.${local}_${value}`,
      orderKey: (index + 1) * 10,
      schemaVersion: version,
    })),
    schemaVersion: version,
  };
}

function queries(
  ids: PurchasingIds,
  local: string,
  entityId: string,
  selectedFieldIds: readonly string[],
  resolveFieldId: string,
): Array<Record<string, unknown>> {
  return (['get', 'list', 'search', 'resolve'] as const).map((queryType) => {
    const legalEntityScopeParameterId = `${ids.namespace}:parameter.${local}_${queryType}_legal_entity_scope`;
    return {
      kind: 'queryDefinition',
      ...(ENTITY_OWNED_QUERY_FAMILIES.has(local)
        ? {
            legalEntityScope: {
              cardinality: 'exactlyOne',
              kind: 'queryLegalEntityScope',
              operand: {
                kind: 'queryParameterReference',
                parameterId: legalEntityScopeParameterId,
                schemaVersion: version,
              },
              schemaVersion: version,
            },
            parameters: [
              {
                kind: 'queryParameterDefinition',
                orderKey: 10,
                parameterId: legalEntityScopeParameterId,
                schemaVersion: version,
              },
            ],
          }
        : {}),
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
    };
  });
}

function operations(
  ids: PurchasingIds,
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
  ids: PurchasingIds,
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

/**
 * Party's anatomy, not Inventory's. The surface-grammar baseline records
 * Inventory's Record surfaces as dropping `commandBar` -- so archive, restore,
 * release and cancel have nowhere to render -- and its Forms as carrying a
 * lone `activity` slot whose component `apps/web/src/component-registry.ts`
 * deliberately does not register. A purchase order has to be edited and
 * released by a person, so it takes the slot set this runtime renders.
 */
function surfaces(
  ids: PurchasingIds,
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
  ids: PurchasingIds,
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

function assertion(ids: PurchasingIds, local: string): Record<string, unknown> {
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
