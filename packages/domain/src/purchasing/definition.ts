// Canonical language v5 -- the version that MATERIALIZES a state machine's
// state field as an ordinary enum field on its entity. Purchasing declares no
// generic CRUD for documents; receiving runs through the registered capability.
//
// SCOPE, as held: the purchase order DOCUMENT and its lines -- entities,
// fields, queries, generic operations, two named transitions, surfaces and the
// parent-scoped line relation, goods receipts, received progress and guarded
// quantity amendment requests. No sales.
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
const version = 'v6' as const;
const normalizationProfileVersion = 'northstar.normalization/v6' as const;

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
 * | transition | ruled | operation in `PUR-1`? |
 * |---|---|---|
 * | `draft -> released` | the release | **yes** |
 * | `draft -> cancelled` | the cancel of an uncommitted order | **yes** |
 * | `released -> cancelled` | the cancel of a committed order | **yes** |
 * | `released -> closed` | the close | **NO -- `PUR-2`'s** |
 * | `closed -> released` | the reopen | **NO -- `PUR-2`'s** |
 * | `released -> draft` | **refused** -- `draft` asserts no commitments exist, and once released, receipts may |  |
 * | `closed -> cancelled` | **refused** -- reopen first |  |
 * | `cancelled -> anything` | **refused** -- terminal; reissue instead |  |
 *
 * THE LAST COLUMN IS THE POINT, and it corrects an earlier version of this file
 * that emitted an operation for every row.
 *
 * **A state names a DESTINATION; an active transition operation grants a
 * PRESENT BEHAVIOUR.** Declaring `closed` now is forced -- adding a state to a
 * materialized machine widens the enum and raises
 * `COMPILER_STORAGE_RETYPE_UNSUPPORTED`, measured. Declaring the close and
 * reopen EDGES now is free and useful, because `PUR-2` can then bind operations
 * to them without touching the machine. But EMITTING those operations here
 * would let any caller persist `released -> closed` today, with no receipt rule,
 * no open-to-receive calculation and no `PUR-2` mechanism of any kind -- an
 * arbitrary manual close becoming a stored business fact every later reader
 * takes as true, on a document that is then uneditable with no amend path.
 *
 * **The one-way-door measurement does not license it.** Measured on this
 * module: adding a TRANSITION to an already-materialized machine compiles with
 * no retype, and a transition declared with no operation referencing it
 * compiles too. So the cost the retype evidence establishes is the cost of a
 * STATE, and deferring these two operations to the packet that can give them
 * semantics is cheap. Plan section 7.17 says what closes an order is `PUR-2`'s to
 * decide, and this file now says the same thing.
 */
const TRANSITIONS = [
  ['release', 'Release order', 10, 'draft', 'released', 'release', true],
  ['draft_cancel', 'Cancel order', 20, 'draft', 'cancelled', 'cancel', true],
  ['close', 'Close order', 30, 'released', 'closed', 'close', false],
  ['reopen', 'Reopen order', 40, 'closed', 'released', 'reopen', false],
  ['cancel', 'Cancel order', 50, 'released', 'cancelled', 'cancel', true],
] as const;

/** The transitions `PUR-1` binds an operation to. The rest are declared only. */
const DRIVEN_TRANSITIONS = TRANSITIONS.filter(([, , , , , , driven]) => driven);

type TransitionLocalId = (typeof TRANSITIONS)[number][0];
type TransitionPermissionLocalId = (typeof TRANSITIONS)[number][5];

/**
 * FOUR permissions for five transitions: both cancels authorize on one
 * `purchase_order_cancel` permission.
 *
 * The permission names the business ACT -- may this principal cancel a purchase
 * order -- and the state it departs from is the transition's business, not the
 * permission's. ADR-0050 section 7 warns specifically against buying a second
 * authorization decision in advance of a shape that needs one, and nothing here
 * needs to distinguish abandoning a draft from cancelling a released order at
 * the policy layer. Splitting them later is an ordinary additive permission,
 * not a lineage event: permissions are not the materialized state column.
 */
const TRANSITION_PERMISSIONS = [
  ...new Set(TRANSITIONS.map(([, , , , , permission]) => permission)),
] as readonly TransitionPermissionLocalId[];

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
  'goods_receipt',
  'goods_receipt_line',
  'purchase_order_received',
  'purchase_order_amendment',
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
    /**
     * Commercial terms (PURCHASING-PARITY, owner ruling B extended to purchase
     * orders), declared only when the product application asks for them.
     */
    commercialFieldIds: {
      purchaseOrder: {
        paymentTerms: field('purchase_order', 'payment_terms'),
        taxCodeId: field('purchase_order', 'tax_code_id'),
        freightAmount: field('purchase_order', 'freight_amount'),
        freightTaxCodeId: field('purchase_order', 'freight_tax_code_id'),
        otherFeeAmount: field('purchase_order', 'other_fee_amount'),
        otherFeeTaxCodeId: field('purchase_order', 'other_fee_tax_code_id'),
        freightTaxRatePercent: field(
          'purchase_order',
          'freight_tax_rate_percent',
        ),
        otherFeeTaxRatePercent: field(
          'purchase_order',
          'other_fee_tax_rate_percent',
        ),
      },
      purchaseOrderLine: {
        discountPercent: field('purchase_order_line', 'discount_percent'),
        taxCodeId: field('purchase_order_line', 'tax_code_id'),
        taxRatePercent: field('purchase_order_line', 'tax_rate_percent'),
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
  options: {
    /**
     * Payment terms, a tax code, charges and line discounts and tax on the
     * purchase order. Only the product application passes it: the terms read
     * Catalog tax codes, which a purchasing-only harness does not compile.
     */
    readonly commercialTerms?: boolean;
  } = {},
): Record<string, unknown> {
  const definitionIds = ids(namespace);
  const commercialTerms = options.commercialTerms === true;
  const { entityIds, fieldIds, moduleId, packageId, stateFieldId } =
    definitionIds;
  const standardEntities = [
    ['purchase_order', 'Purchase order', entityIds.purchaseOrder],
    ['purchase_order_line', 'Purchase order line', entityIds.purchaseOrderLine],
    ['goods_receipt', 'Goods receipt', `${namespace}:entity.goods_receipt`],
    [
      'purchase_order_amendment',
      'Order quantity amendment request',
      `${namespace}:entity.purchase_order_amendment`,
    ],
    [
      'goods_receipt_line',
      'Receipt line',
      `${namespace}:entity.goods_receipt_line`,
    ],
    [
      'purchase_order_received',
      'Received quantity',
      `${namespace}:entity.purchase_order_received`,
    ],
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
      {
        capabilityId: 'northstar.purchasing:capability.receiving',
        capabilityVersion: 1,
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
    entities: standardEntities.map(([local, label, entityId], index) =>
      entity(definitionIds, local, label, entityId, (index + 1) * 10),
    ),
    fields: [
      ...receiptFields(definitionIds),
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
        { businessKey: true, searchable: true, numberedAs: 'PO' },
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
      //
      // SEARCHABLE, and the reason is the field's own nature rather than the
      // defect that surfaced it. A currency code is a short, human-typed,
      // controlled identifier -- the same class as `party_number`, `item_sku`,
      // `location_code` and `inventory_transaction_line_unit_id`, every one of
      // which is searchable here. "Show me the orders in EUR" is a thing an
      // operator types, unlike a note or a timestamp.
      //
      // It ALSO removes a `searchableExclusion` verification scenario that this
      // field could not pass, and that is worth stating rather than hiding.
      // `verificationFieldValue` seeds every text field with `V-` plus a hash
      // TRUNCATED TO `maximumLength`, and the search predicate is a SUBSTRING
      // match -- so at length 3 the generated value is `V-<one hex char>`,
      // which is a prefix of every sibling text value on the same record and
      // matches roughly one run in eight. **That is a platform weakness, not a
      // property of currency**: it makes any text field shorter than about
      // eight characters non-deterministic under the prober, and this is the
      // application's first such field -- the next shortest is 32. It is filed
      // rather than worked around, and `searchable` here is not the fix for it.
      field(
        definitionIds,
        entityIds.purchaseOrder,
        fieldIds.purchaseOrder.currency,
        'Currency',
        50,
        text(3),
        { searchable: true },
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
      ...(commercialTerms ? commercialFields(definitionIds) : []),
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
        'goods_receipt',
        `${namespace}:entity.goods_receipt`,
        {
          kind: 'notPredicate',
          schemaVersion: version,
          term: fieldComparison(
            `${namespace}:field.goods_receipt_state`,
            `${namespace}:option.goods_receipt_state_posted`,
          ),
        },
      ),
      ...operations(
        definitionIds,
        'goods_receipt_line',
        `${namespace}:entity.goods_receipt_line`,
      ),
      ...(['post'] as const).map((action) =>
        receivingOperation(definitionIds, 'goods_receipt', action),
      ),
      ...(['close', 'reopen'] as const).map((action) =>
        receivingOperation(definitionIds, 'purchase_order', action),
      ),
      receivingOperation(definitionIds, 'purchase_order_line', 'amend'),
      ...operations(
        definitionIds,
        'purchase_order_amendment',
        `${namespace}:entity.purchase_order_amendment`,
      ),
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
      // DRIVEN_TRANSITIONS, not TRANSITIONS. `close` and `reopen` are declared
      // edges with no operation, so nothing can invoke them until `PUR-2` binds
      // one. See the table above the transition list.
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
      ...(['goods_receipt_post', 'purchase_order_line_amend'] as const).map(
        (local) => ({
          action: 'transition',
          kind: 'permissionDefinition',
          label: local.replaceAll('_', ' '),
          permissionId: `${namespace}:permission.${local}`,
          resource: reference(
            'entityReference',
            `${namespace}:entity.${local === 'goods_receipt_post' ? 'goods_receipt' : 'purchase_order_line'}`,
          ),
          schemaVersion: version,
        }),
      ),
      ...standardEntities.flatMap(([local, , entityId]) =>
        permissions(definitionIds, local, entityId).filter(
          (permission) =>
            local !== 'purchase_order_received' || permission.action === 'read',
        ),
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
      ...TRANSITION_PERMISSIONS.map((local) =>
        transitionPermission(definitionIds, local),
      ),
    ],
    queries: standardEntities.flatMap(([local, , entityId]) =>
      queries(
        definitionIds,
        local,
        entityId,
        selectedFieldsForEntity(definitionIds, local, commercialTerms),
        resolveFieldForEntity(fieldIds, local) ||
          `${namespace}:field.${local}_${local === 'goods_receipt' || local === 'purchase_order_amendment' ? 'number' : local === 'goods_receipt_line' ? 'item_id' : 'unit_id'}`,
      ),
    ),
    relations: [
      ...(
        [
          [
            'purchase_order_amendment_order_line',
            'purchase_order_amendment',
            'purchase_order_line',
            'reference',
            true,
          ],
          [
            'goods_receipt_order',
            'goods_receipt',
            'purchase_order',
            'reference',
            true,
          ],
          [
            'goods_receipt_supersedes',
            'goods_receipt',
            'goods_receipt',
            'reference',
            false,
          ],
          [
            'goods_receipt_line_receipt',
            'goods_receipt_line',
            'goods_receipt',
            'parentScopedChild',
            true,
          ],
          [
            'goods_receipt_line_order_line',
            'goods_receipt_line',
            'purchase_order_line',
            'reference',
            true,
          ],
          [
            'purchase_order_received_order_line',
            'purchase_order_received',
            'purchase_order_line',
            'reference',
            true,
          ],
        ] as const
      ).map(([local, source, target, ownership, required], index) => ({
        ...relation(
          `${namespace}:relation.${local}`,
          `${namespace}:entity.${source}`,
          `${namespace}:entity.${target}`,
          20 + index * 10,
        ),
        ownership,
        required,
      })),
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
      surfaces(definitionIds, local, label).filter(
        (surface) =>
          local !== 'purchase_order_received' || surface.surfaceRole !== 'form',
      ),
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

/** Payment terms a purchase order may carry, labelled as a party's terms are. */
const PAYMENT_TERMS = [
  ['due_on_receipt', 'Due on receipt'],
  ['net_15', 'Net 15'],
  ['net_30', 'Net 30'],
  ['net_45', 'Net 45'],
  ['net_60', 'Net 60'],
] as const;

/**
 * A purchase order's commercial terms (owner ruling B extended to purchase
 * orders): payment terms, the order's tax code, which new lines start from,
 * two charges each taxed by its own code with the rate frozen beside it, and
 * each line's discount and frozen tax. All optional; no accounting, payable or
 * ledger posting follows from them.
 */
function commercialFields(ids: PurchasingIds): Array<Record<string, unknown>> {
  const header = ids.commercialFieldIds.purchaseOrder;
  const line = ids.commercialFieldIds.purchaseOrderLine;
  const order = ids.entityIds.purchaseOrder;
  const orderLine = ids.entityIds.purchaseOrderLine;
  const paymentTerms: FieldType = {
    kind: 'enumFieldType',
    schemaVersion: version,
    options: PAYMENT_TERMS.map(([value, label], index) => ({
      kind: 'enumOption',
      schemaVersion: version,
      optionId: `${ids.namespace}:option.purchase_order_payment_terms_${value}`,
      label,
      orderKey: (index + 1) * 10,
    })),
  };
  const optional = { optional: true };
  return [
    field(
      ids,
      order,
      header.paymentTerms,
      'Payment terms',
      70,
      paymentTerms,
      optional,
    ),
    field(ids, order, header.taxCodeId, 'Tax code', 80, text(80), optional),
    field(ids, order, header.freightAmount, 'Freight', 90, decimal(), optional),
    field(
      ids,
      order,
      header.freightTaxCodeId,
      'Freight tax code',
      100,
      text(80),
      optional,
    ),
    field(
      ids,
      order,
      header.otherFeeAmount,
      'Other fee',
      110,
      decimal(),
      optional,
    ),
    field(
      ids,
      order,
      header.otherFeeTaxCodeId,
      'Other fee tax code',
      120,
      text(80),
      optional,
    ),
    // Each charge's rate, frozen from its tax code when chosen.
    field(
      ids,
      order,
      header.freightTaxRatePercent,
      'Freight tax rate %',
      130,
      decimal(),
      optional,
    ),
    field(
      ids,
      order,
      header.otherFeeTaxRatePercent,
      'Other fee tax rate %',
      140,
      decimal(),
      optional,
    ),
    field(
      ids,
      orderLine,
      line.discountPercent,
      'Discount %',
      50,
      decimal(),
      optional,
    ),
    field(ids, orderLine, line.taxCodeId, 'Tax code', 60, text(80), optional),
    field(
      ids,
      orderLine,
      line.taxRatePercent,
      'Tax rate %',
      70,
      decimal(),
      optional,
    ),
  ];
}

function receiptFields(ids: PurchasingIds): Array<Record<string, unknown>> {
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
      label: value,
      orderKey: index * 10 + 10,
    })),
  });
  const specs: Array<readonly [string, string, string, FieldType, boolean?]> = [
    [
      'purchase_order_amendment',
      'number',
      'Amendment request number',
      text(60),
    ],
    [
      'purchase_order_amendment',
      'line_revision',
      'Expected order line revision',
      integer(),
    ],
    ['purchase_order_amendment', 'quantity', 'New ordered quantity', decimal()],
    ['purchase_order_amendment', 'reason', 'Amendment reason', text(2000)],
    ['goods_receipt', 'number', 'Receipt number', text(60)],
    [
      'goods_receipt',
      'state',
      'State',
      enumType('goods_receipt', 'state', ['draft', 'posted']),
    ],
    [
      'goods_receipt',
      'kind',
      'Kind',
      enumType('goods_receipt', 'kind', ['initial', 'correction', 'reversal']),
    ],
    ['goods_receipt', 'effective_at', 'Received at', instant()],
    ['goods_receipt', 'location_id', 'Receiving location', text(80)],
    ['goods_receipt', 'reason_code', 'Reason code', text(80)],
    ['goods_receipt', 'reason_narrative', 'Reason', text(1000)],
    ['goods_receipt_line', 'line_number', 'Line number', integer()],
    ['goods_receipt_line', 'item_id', 'Item', text(80)],
    ['goods_receipt_line', 'quantity', 'Quantity', decimal()],
    ['goods_receipt_line', 'unit_id', 'Base unit', text(32)],
    [
      'goods_receipt_line',
      'cost_status',
      'Actual cost',
      enumType('goods_receipt_line', 'cost_status', ['known', 'absent']),
    ],
    [
      'goods_receipt_line',
      'unit_cost',
      'Actual received unit cost',
      decimal(),
      true,
    ],
    ['goods_receipt_line', 'currency', 'Actual cost currency', text(3), true],
    [
      'goods_receipt_line',
      'reversal_of_movement_id',
      'Compensated movement',
      text(80),
      true,
    ],
    [
      'purchase_order_received',
      'received_quantity',
      'Received quantity',
      decimal(),
    ],
    ['purchase_order_received', 'unit_id', 'Base unit', text(32)],
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
        searchable:
          name === 'number' ||
          // Currency codes are ordinary searchable identifiers, as on the PO.
          name === 'currency' ||
          name === 'item_id' ||
          (local === 'purchase_order_received' && name === 'unit_id'),
        businessKey: name === 'number',
        // A goods receipt takes a server-assigned number on its first save
        // (PURCHASING-PARITY), as a purchase order does: RCV-000001.
        ...(local === 'goods_receipt' && name === 'number'
          ? { numberedAs: 'RCV' }
          : {}),
      },
    ),
  );
}

function receivingOperation(
  ids: PurchasingIds,
  local: string,
  action: string,
): Record<string, unknown> {
  return {
    confirmation: 'humanRequired',
    effect: {
      kind: 'registeredCapabilityEffect',
      schemaVersion: version,
      capability: reference(
        'capabilityReference',
        'northstar.purchasing:capability.receiving',
      ),
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
      ([local, label, orderKey, fromState, toState, permission]) => ({
        fromState: reference('stateReference', ids.stateIds[fromState]),
        kind: 'transitionDefinition',
        label,
        orderKey,
        // The SAME id the operation declares. See the permissions block.
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
  ids: PurchasingIds,
  action: TransitionPermissionLocalId,
): string {
  return `${ids.namespace}:permission.purchase_order_${action}`;
}

function transitionPermission(
  ids: PurchasingIds,
  action: TransitionPermissionLocalId,
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
  permission: TransitionPermissionLocalId,
  precondition: Record<string, unknown>,
): Record<string, unknown> {
  return {
    // Only the terminal move asks for a human confirmation. `close` and
    // `reopen` are each other's inverse and `release` is the primary forward
    // action; `cancel` cannot be undone from `cancelled`, so it is the one that
    // gets the extra step.
    // Only a move into the TERMINAL state asks for a human confirmation, and
    // both cancels do. `close` and `reopen` are each other's inverse and
    // `release` is the primary forward action.
    confirmation: permission === 'cancel' ? 'humanRequired' : 'none',
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
      transitionPermissionId(ids, permission),
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
  commercialTerms: boolean,
): readonly string[] {
  switch (local) {
    case 'purchase_order':
      return [
        ids.stateFieldId,
        ...Object.values(ids.fieldIds.purchaseOrder),
        ...(commercialTerms
          ? Object.values(ids.commercialFieldIds.purchaseOrder)
          : []),
      ];
    case 'purchase_order_line':
      return [
        ...Object.values(ids.fieldIds.purchaseOrderLine),
        ...(commercialTerms
          ? Object.values(ids.commercialFieldIds.purchaseOrderLine)
          : []),
      ];
    default:
      return receiptFields(ids)
        .filter(
          (value) =>
            (value.entity as { targetId: string }).targetId ===
            `${ids.namespace}:entity.${local}`,
        )
        .map((value) => String(value.fieldId));
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
      return '';
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
    /** A server-assigned document number: `PREFIX-000001`, one per tenant. */
    numberedAs?: string;
  } = {},
): Record<string, unknown> {
  const local = entityId.slice(
    entityId.indexOf(':entity.') + ':entity.'.length,
  );
  return {
    ...(options.businessKey
      ? { businessKey: 'tenantEnvironmentCaseInsensitiveUnique' }
      : {}),
    ...(options.numberedAs
      ? {
          numbering: {
            kind: 'documentSequence',
            sequenceId: `${ids.namespace}:document_sequence.${local}`,
            prefix: options.numberedAs,
            minimumDigits: 6,
            start: 1,
          },
        }
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
      // The declared List exports this whole filtered set in one statement.
      ...(queryType === 'list' && local === 'purchase_order'
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
