// Canonical language v5 -- the version that MATERIALIZES a state machine's
// state field as an ordinary enum field on its entity. Purchasing declares no
// capability of its own, and nothing here appends an inventory fact.
//
// SCOPE, as held: the purchase order DOCUMENT and its lines -- entities,
// fields, queries, generic operations, two named transitions, surfaces and the
// parent-scoped line relation. No receipt, no movement, no posting role, no
// sales.
//
// THIS FILE IS THE FIRST FIRST-PARTY DECLARATION OF `stateMachines`.
// `ADR-0050` ruled `transitionStateEffect` and `stateMachines` as one decision
// -- a `transitionDefinition` exists nowhere but inside a
// `stateMachineDefinition`, so the effect cannot name an entity, a field or a
// target without the machine -- and bound the placement:
//
//   "normalization materializes each machine's state field as an ordinary enum
//    field on its entity, whose options are the machine's states, and the
//    parallel `derivedStateField` storage construct is retired."
//
// So `state` is NOT authored here. The document has one state field, minted by
// `materializeStateFields` from the machine, and the compiler refuses a second
// owner of that identity by name (`CANON_STATE_FIELD_COLLISION`).
//
// A prior lane stopped at this wall and was right to: before ADR-0050 a
// precondition could REFUSE an edit but could not IMPLEMENT a transition. The
// seam exists now, it runs at `tier: 'o0'` through the generic press, and this
// module is what ADR-0050:150 called "the moment any module adopts one" --
// release roots move and normalized bytes change, by design.
const version = 'v5' as const;
const normalizationProfileVersion = 'northstar.normalization/v5' as const;

export const PURCHASING_NAMESPACE = 'northstar.purchasing' as const;

type FieldType = Record<string, unknown>;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

/**
 * The four states, in lifecycle order. `orderKey` follows this order and the
 * materialized enum's options ARE these states, so a reader never has to keep
 * two lists in step.
 *
 * THE WHOLE LIFECYCLE IS DECLARED HERE, INCLUDING THE PARTS `PUR-1` CANNOT
 * DRIVE. That is deliberate and it is the expensive half of ADR-0050:150 --
 * *"that is what makes the cut cheap today and expensive the moment any module
 * adopts one."* Every state or transition added later is another normalization
 * event and another lineage entry, so the one-way door is declared once, in
 * full, by the module that opens it. What CLOSES an order is `PUR-2`'s to
 * decide; that the transition exists is decided now.
 *
 * `cancelled` is terminal. `closed` is not -- a closed order needing a further
 * receipt or an amended quantity returns to `released` through the reopen.
 */
const STATES = [
  ['draft', 'Draft', false],
  ['released', 'Released', false],
  ['closed', 'Closed', false],
  ['cancelled', 'Cancelled', true],
] as const;

type StateLocalId = (typeof STATES)[number][0];

/**
 * The four transitions, and the four that are deliberately absent.
 *
 * | transition | ruled |
 * |---|---|
 * | `draft -> released` | the release |
 * | `released -> closed` | the close; what triggers it is `PUR-2`'s |
 * | `closed -> released` | the reopen |
 * | `released -> cancelled` | the cancel |
 * | `released -> draft` | **no** -- `draft` asserts no commitments exist, and once released, receipts may |
 * | `draft -> cancelled` | **no** -- a draft's exit is the generic ARCHIVE the four standard operations already provide |
 * | `closed -> cancelled` | **no** -- reopen first, so the cancel departs from one state and needs one transition |
 * | `cancelled -> anything` | **no** -- terminal; reissue instead |
 *
 * Cancel departs from `released` rather than from `draft` because a released
 * order is guarded against every generic operation, so cancel is its only exit,
 * while a draft order still has archive. `transitionStateEffect` carries
 * exactly ONE `transition` reference (`schemas.ts`), so one operation drives one
 * transition and a cancel reachable from two states would need two of each.
 */
const TRANSITIONS = [
  ['release', 'Release order', 10, 'draft', 'released'],
  ['close', 'Close order', 20, 'released', 'closed'],
  ['reopen', 'Reopen order', 30, 'closed', 'released'],
  ['cancel', 'Cancel order', 40, 'released', 'cancelled'],
] as const;

type TransitionLocalId = (typeof TRANSITIONS)[number][0];

/**
 * Both purchasing families are `entityOwned` (ADR-0015), so every query is
 * scoped by an `exactlyOne` legal-entity operand. The classification itself is
 * declared in THREE places and all three must agree -- the domain map
 * (`inventory/contracts.ts`), the compiler rules (`compiler/src/conformance.ts`)
 * and the relation semantics in both. This set is the module's own local
 * statement of the same fact; the pinned contract is what enforces it.
 */
const ENTITY_OWNED_QUERY_FAMILIES = new Set([
  'purchase_order',
  'purchase_order_line',
]);

function ids(namespace: string) {
  const entity = (local: string) => `${namespace}:entity.${local}`;
  const field = (local: string, name: string) =>
    `${namespace}:field.${local}_${name}`;
  const machineId = `${namespace}:machine.purchase_order_lifecycle`;
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
        supplierPartyId: field('purchase_order', 'supplier_party_id'),
      },
      purchaseOrderLine: {
        itemId: field('purchase_order_line', 'item_id'),
        lineNumber: field('purchase_order_line', 'line_number'),
        orderedQuantity: field('purchase_order_line', 'ordered_quantity'),
        unitPrice: field('purchase_order_line', 'unit_price'),
      },
    },
    machineId,
    moduleId: `${namespace}:module.purchasing`,
    namespace,
    packageId: `${namespace}:package.purchasing`,
    relationIds: {
      purchaseOrderLineOrder: `${namespace}:relation.purchase_order_line_order`,
    },
    // Not authored anywhere in this file: normalization mints it from the
    // machine identity. It is declared here so preconditions and query
    // selections can ADDRESS it, and `purchasing-definition.test.ts` pins this
    // spelling against what normalization actually materializes rather than
    // trusting the two to stay in step.
    stateFieldId: derivedStateFieldId(machineId),
    stateIds: Object.fromEntries(
      STATES.map(([local]) => [
        local,
        `${namespace}:state.purchase_order_${local}`,
      ]),
    ) as Record<StateLocalId, string>,
    transitionIds: Object.fromEntries(
      TRANSITIONS.map(([local]) => [
        local,
        `${namespace}:transition.purchase_order_${local}`,
      ]),
    ) as Record<TransitionLocalId, string>,
  } as const;
}

type PurchasingIds = ReturnType<typeof ids>;

const defaultIds = ids(PURCHASING_NAMESPACE);

export const PURCHASING_IDS = Object.freeze(defaultIds);

/**
 * The purchase order document.
 *
 * Editing is closed by ADR-0034 declared preconditions rather than by UI. The
 * header's four generic operations carry a not-editable-once-committed guard,
 * and the generic parent-aggregate rule carries the header's UPDATE guard down
 * to `purchase_order_line` with zero line-level declarations -- a mutating
 * operation on the source of an active `parentScopedChild` relation must also
 * satisfy the parent's update precondition against the parent's current image
 * (`module-runtime-interpreter.ts`, `requireExistingParentGuards` ->
 * `requireRelationTarget`).
 *
 * That guard states what MUST NOT happen once an order leaves draft. What moves
 * an order between states is the state machine below, and only the machine: the
 * state field is excluded from every caller-writable input contract, so the
 * press cannot forge a state and the compiled `toStateId` is the sole source of
 * the target.
 */
export function purchasingModuleDefinition(
  namespace: string = PURCHASING_NAMESPACE,
): Record<string, unknown> {
  const definitionIds = ids(namespace);
  const { entityIds, fieldIds, moduleId, packageId, stateFieldId } =
    definitionIds;
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
      // NO `state` field. See the file header: the machine owns that identity
      // and normalization materializes it at `orderKey: 0`, ahead of every
      // authored field.
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
        fieldIds.purchaseOrder.orderDate,
        'Order date',
        30,
        instant(),
      ),
      field(
        definitionIds,
        entityIds.purchaseOrder,
        fieldIds.purchaseOrder.expectedDate,
        'Expected date',
        40,
        instant(),
        { optional: true },
      ),
      // The money boundary, per plan §7.3 as corrected: no accounting,
      // invoicing, tax or AR, but the commercial facts an order actually
      // carries are retained. The program plan's own catalog (:1275, :1276)
      // places currency on the HEADER and optional unit price on the LINE, and
      // that is what is authored.
      field(
        definitionIds,
        entityIds.purchaseOrder,
        fieldIds.purchaseOrder.currency,
        'Currency',
        50,
        text(3),
      ),
      field(
        definitionIds,
        entityIds.purchaseOrder,
        fieldIds.purchaseOrder.notes,
        'Notes',
        60,
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
      // NO received quantity. Plan §6.2 calls it a "received quantity read
      // model", derived from posted receipts -- and `PUR-1` ships no receipts,
      // so a stored column here could only ever hold zero. §7.12 ruled it out
      // of this packet for that reason: `PS-0`'s race table closes over-receipt
      // two different ways, compare-and-swap on a STORED quantity or
      // lock-and-sum on a DERIVED one, and authoring the column now would
      // pre-commit that choice on behalf of the packet that has the data to
      // make it. `PUR-2` chooses; `SAL-1`/`SAL-2` inherit the same rule for
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
        editableStates(definitionIds),
      ),
      ...operations(
        definitionIds,
        'purchase_order_line',
        entityIds.purchaseOrderLine,
      ),
      ...TRANSITIONS.map(([local, , , fromState]) =>
        transitionOperation(
          definitionIds,
          local,
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
      ...standardEntities.flatMap(([local, , entityId]) =>
        permissions(definitionIds, local, entityId),
      ),
      // ADR-0050 §7 -- and this is the one rule in this file that guards a
      // SECURITY declaration rather than a business one. The language declares
      // two permissions for a transition: `transitionDefinition.permission` and
      // the operation's. Execution honours exactly one -- the gateway
      // authorizes `definition.permissionId`, which is the OPERATION's -- and
      // the compiled effect carries `entity`, `fromStateId`, `toStateId`,
      // `stateFieldId` and `transition` with NO permission at all. A transition
      // declaring a restricted permission under an operation declaring a loose
      // one therefore executes on the loose one, and the declaration a reader
      // trusts is precisely the one ignored.
      //
      // So both positions carry the SAME id, deliberately and by construction:
      // `transitionPermissionId` is the single source for both, and
      // `COMPILER_TRANSITION_PERMISSION_MISMATCH` refuses any divergence by
      // name at compile time.
      ...TRANSITIONS.map(([local]) =>
        transitionPermission(definitionIds, local),
      ),
    ],
    queries: standardEntities.flatMap(([local, , entityId]) =>
      queries(
        definitionIds,
        local,
        entityId,
        selectedFieldsForEntity(definitionIds, local),
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
    stateMachines: [stateMachine(definitionIds)],
    storageMappings: standardEntities.map(([local, , entityId]) =>
      storageMapping(definitionIds, local, entityId),
    ),
    surfaces: standardEntities.flatMap(([local, label]) =>
      surfaces(definitionIds, local, label),
    ),
  };
}

/**
 * Mirrors `normalize.ts`'s `derivedStateField`: the field id is derived from the
 * machine identity by splicing `derived_state_field` in for the namespace's
 * local part. This is a SECOND spelling of a compiler-owned rule, so
 * `purchasing-definition.test.ts` normalizes the package and asserts the
 * materialized field carries exactly this id. If normalization ever changes the
 * derivation, that control reds rather than the module silently addressing a
 * field that no longer exists.
 */
function derivedStateFieldId(machineId: string): string {
  const separator = machineId.indexOf(':');
  return `${machineId.slice(0, separator)}:derived_state_field.${machineId.slice(separator + 1)}`;
}

/**
 * The lifecycle, and the whole of it. See `STATES` and `TRANSITIONS` above for
 * what is declared and what is deliberately not.
 *
 * `stateField` is NOT authored: normalization derives it from `machineId` and
 * refuses any authored value that is not byte-identical
 * (`CANON_DERIVED_STATE_FIELD_INVALID`), which is why the module addresses it
 * through `ids().stateFieldId` and pins that spelling in a control.
 */
function stateMachine(ids: PurchasingIds): Record<string, unknown> {
  return {
    entity: reference('entityReference', ids.entityIds.purchaseOrder),
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
      ([local, label, orderKey, fromState, toState]) => ({
        fromState: reference('stateReference', ids.stateIds[fromState]),
        kind: 'transitionDefinition',
        label,
        orderKey,
        // The SAME id the operation declares. See the permissions block.
        permission: reference(
          'permissionReference',
          transitionPermissionId(ids, local),
        ),
        schemaVersion: version,
        toState: reference('stateReference', ids.stateIds[toState]),
        transitionId: ids.transitionIds[local],
      }),
    ),
  };
}

function transitionPermissionId(
  ids: PurchasingIds,
  action: TransitionLocalId,
): string {
  return `${ids.namespace}:permission.purchase_order_${action}`;
}

function transitionPermission(
  ids: PurchasingIds,
  action: TransitionLocalId,
): Record<string, unknown> {
  return {
    action: 'transition',
    kind: 'permissionDefinition',
    label: `purchase_order ${action}`,
    permissionId: transitionPermissionId(ids, action),
    resource: reference('entityReference', ids.entityIds.purchaseOrder),
    schemaVersion: version,
  };
}

/**
 * A transition is an `o0` operation with a closed input contract
 * (`['expectedRevision','recordId']`) and no caller patch. Its precondition is
 * evaluated against the PERSISTED prior image, and the compare-and-swap
 * additionally pins `fromState`, so the guard here is not the only thing
 * standing between a caller and a forged state -- it is what stops the command
 * from being OFFERED on a record it cannot move, and a second, independent
 * refusal when it is invoked anyway.
 *
 * `readBack` is the header `get`, so the caller sees the new state without a
 * second round trip.
 *
 * The operation id's final verb is load-bearing presentation data: ADR-0056
 * gives the web renderer a closed precedence over `release` (first) and
 * `cancel` (last), with every other verb keeping its compiled binding order --
 * so `close` and `reopen` land between them, which is the order a reader wants.
 * `surface-contract.ts`'s `operationLabel` derives the button text from the
 * same suffix.
 */
function transitionOperation(
  ids: PurchasingIds,
  action: TransitionLocalId,
  precondition: Record<string, unknown>,
): Record<string, unknown> {
  return {
    // Only the terminal move asks for a human confirmation. `close` and
    // `reopen` are each other's inverse and `release` is the primary forward
    // action; `cancel` cannot be undone from `cancelled`, so it is the one that
    // gets the extra step.
    confirmation: action === 'cancel' ? 'humanRequired' : 'none',
    effect: {
      kind: 'transitionStateEffect',
      schemaVersion: version,
      transition: reference('transitionReference', ids.transitionIds[action]),
    },
    kind: 'operationDefinition',
    module: reference('moduleReference', ids.moduleId),
    operationId: `${ids.namespace}:operation.purchase_order_${action}`,
    permission: reference(
      'permissionReference',
      transitionPermissionId(ids, action),
    ),
    precondition,
    readBack: reference(
      'queryReference',
      `${ids.namespace}:query.purchase_order_get`,
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
    value: {
      kind: 'textValue',
      schemaVersion: version,
      value: targetId,
    },
  };
}

/** `state equals <stateId>` -- the shape the command bar evaluates per record. */
function inState(fieldId: string, stateId: string): Record<string, unknown> {
  return fieldComparison(fieldId, stateId);
}

/**
 * The header's editing guard: `not(released) and not(closed) and not(cancelled)`
 * -- that is, "editable only while draft", spelled negatively.
 *
 * THE NEGATIVE FORM IS STRUCTURALLY FORCED, not stylistic. `prepareMutation`
 * evaluates a create's precondition against the CANDIDATE image, which is the
 * caller's patch -- and the state field is excluded from every caller-writable
 * contract, so it is absent there. Under ADR-0021 total-absence semantics
 * (`absentComparison: 'false'`) a positive `state equals draft` would evaluate
 * FALSE on that image and refuse every create. `not(equals X)` evaluates true
 * on the same absence, which is why ADR-0034's `stock_count` guard is spelled
 * the same way.
 *
 * Three terms rather than the charter's single not-released, and the extra two
 * are not decoration: this module makes `closed` and `cancelled` reachable, and
 * a lone `not(released)` would leave an order in either of them fully editable
 * -- and, through the parent-aggregate rule, its lines too. `all` composes them
 * so ONE predicate still covers all four generic operations, which is
 * ADR-0034's shape.
 *
 * It is also the predicate the platform propagates: `parentGuardsFromCatalog`
 * derives the line guard from the parent's UPDATE operation precondition, so
 * this is what `purchase_order_line` inherits with zero declarations of its
 * own.
 */
function editableStates(ids: PurchasingIds): Record<string, unknown> {
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

/**
 * ADR-0050 §6 item 1 -- the read path, and `PUR-1`'s acceptance criterion
 * rather than a follow-up. The materialized state field is selected by every
 * `purchase_order` query, so a released order can be LISTED by state and not
 * merely transitioned. Below v5 this selection cannot exist at all: the field
 * is not in `packageRevision.fields`, so it fails `CANON_QUERY_FIELD_LOCALITY`
 * and `CANON_REFERENCE_UNRESOLVED`.
 *
 * State comes first, matching its materialized `orderKey: 0`.
 */
function selectedFieldsForEntity(
  ids: PurchasingIds,
  local: string,
): readonly string[] {
  switch (local) {
    case 'purchase_order':
      return [ids.stateFieldId, ...Object.values(ids.fieldIds.purchaseOrder)];
    case 'purchase_order_line':
      return Object.values(ids.fieldIds.purchaseOrderLine);
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
    // `parentScopedChild`, not `reference`, and this one word is what carries
    // the header's guard down to the lines. A `reference` relation is
    // deliberately exempt from the parent-aggregate rule.
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
 * Party's anatomy, not Inventory's pre-ADR-0054 debt. `ADR-0054` fixed the
 * five-slot Record/Form anatomy this runtime actually registers; authoring
 * `activity` or `childTables` ships an inert form, which is the mechanism
 * behind the five-inert-Inventory-forms incident. A purchase order has to be
 * edited, released and cancelled by a person, so it takes the slot set the
 * renderer renders -- `commandBar` above all, because that is where Release and
 * Cancel appear.
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
