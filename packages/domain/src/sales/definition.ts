const version = 'v6' as const;
const normalizationProfileVersion = 'northstar.normalization/v6' as const;

export const SALES_NAMESPACE = 'northstar.sales' as const;
export const FULFILLMENT_CAPABILITY_ID =
  'northstar.sales:capability.fulfillment' as const;
export const FULFILLMENT_CAPABILITY_VERSION = 1 as const;
/** Line amounts and order totals (owner ruling B), computed on read. */
export const COMMERCIAL_CAPABILITY_ID =
  'northstar.sales:capability.commercial' as const;
export const COMMERCIAL_CAPABILITY_VERSION = 1 as const;
/** Internal invoices, payments and credits (owner ruling C). */
export const RECEIVABLES_CAPABILITY_ID =
  'northstar.sales:capability.receivables' as const;
export const RECEIVABLES_CAPABILITY_VERSION = 1 as const;

type FieldType = Record<string, unknown>;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

const STATES = [
  ['draft', 'Draft', false],
  // Owner ruling F asks for "Confirmed"; relabelling a released enum option is
  // refused as a storage retype (its label is inside the column fingerprint),
  // so the state label waits for an authorized re-baseline. The command reads
  // "Confirm" through the operation's declared label.
  ['released', 'Released', false],
  ['closed', 'Closed', false],
  ['cancelled', 'Cancelled', true],
] as const;

const TRANSITIONS = [
  ['release', 'Confirm order', 10, 'draft', 'released', 'release', true],
  ['draft_cancel', 'Cancel order', 20, 'draft', 'cancelled', 'cancel', true],
  ['close', 'Close order', 30, 'released', 'closed', 'close', false],
  ['cancel', 'Cancel order', 40, 'released', 'cancelled', 'cancel', false],
  // Ruling F: a closed order may be reopened while nothing on it is invoiced.
  // The receivables capability reopens it, because only it reads the order's
  // invoices under the order's lock.
  ['reopen', 'Reopen order', 50, 'closed', 'released', 'close', false],
] as const;

/**
 * Payment terms (owner ruling B). The labels are the same as the Party's
 * customer default, because the editor maps that default onto this field by
 * label and the validator refuses a label the two do not share.
 */
const PAYMENT_TERMS = [
  ['due_on_receipt', 'Due on receipt'],
  ['net_15', 'Net 15'],
  ['net_30', 'Net 30'],
  ['net_45', 'Net 45'],
  ['net_60', 'Net 60'],
] as const;

/** The ship-to lines an order copies and a shipment carries (owner ruling E). */
const SHIP_TO_FIELDS = [
  ['ship_to_name', 'Ship-to recipient', 240],
  ['ship_to_street', 'Ship-to street', 500],
  ['ship_to_city', 'Ship-to city', 120],
  ['ship_to_region', 'Ship-to province or state', 120],
  ['ship_to_postal_code', 'Ship-to postal code', 20],
  ['ship_to_country', 'Ship-to country', 60],
] as const;
/** A ship-to is complete when it names a street, city, postal code and country. */
const SHIP_TO_REQUIRED = [
  'ship_to_street',
  'ship_to_city',
  'ship_to_postal_code',
  'ship_to_country',
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
  'customer_invoice',
  'customer_invoice_line',
  'customer_payment',
  'customer_credit',
]);

/** The receivables documents: each is written as a draft and posted once. */
const RECEIVABLES_DOCUMENTS = [
  'customer_invoice',
  'customer_payment',
  'customer_credit',
] as const;

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
      customerInvoice: entity('customer_invoice'),
      customerInvoiceLine: entity('customer_invoice_line'),
      customerPayment: entity('customer_payment'),
      customerCredit: entity('customer_credit'),
    },
    fieldIds: {
      salesOrder: {
        currency: field('sales_order', 'currency'),
        customerPartyId: field('sales_order', 'customer_party_id'),
        notes: field('sales_order', 'notes'),
        number: field('sales_order', 'number'),
        orderDate: field('sales_order', 'order_date'),
        requestedDate: field('sales_order', 'requested_date'),
        salespersonPartyId: field('sales_order', 'salesperson_party_id'),
        paymentTerms: field('sales_order', 'payment_terms'),
        shipToAddressId: field('sales_order', 'ship_to_address_id'),
        shipToName: field('sales_order', 'ship_to_name'),
        shipToStreet: field('sales_order', 'ship_to_street'),
        shipToCity: field('sales_order', 'ship_to_city'),
        shipToRegion: field('sales_order', 'ship_to_region'),
        shipToPostalCode: field('sales_order', 'ship_to_postal_code'),
        shipToCountry: field('sales_order', 'ship_to_country'),
        taxCodeId: field('sales_order', 'tax_code_id'),
        freightAmount: field('sales_order', 'freight_amount'),
        freightTaxCodeId: field('sales_order', 'freight_tax_code_id'),
        otherFeeAmount: field('sales_order', 'other_fee_amount'),
        otherFeeTaxCodeId: field('sales_order', 'other_fee_tax_code_id'),
        freightTaxRatePercent: field('sales_order', 'freight_tax_rate_percent'),
        otherFeeTaxRatePercent: field(
          'sales_order',
          'other_fee_tax_rate_percent',
        ),
      },
      salesOrderLine: {
        itemId: field('sales_order_line', 'item_id'),
        lineNumber: field('sales_order_line', 'line_number'),
        orderedQuantity: field('sales_order_line', 'ordered_quantity'),
        unitId: field('sales_order_line', 'unit_id'),
        unitPrice: field('sales_order_line', 'unit_price'),
        listPrice: field('sales_order_line', 'list_price'),
        discountPercent: field('sales_order_line', 'discount_percent'),
        taxCodeId: field('sales_order_line', 'tax_code_id'),
        taxRatePercent: field('sales_order_line', 'tax_rate_percent'),
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
      invoiceOrder: `${namespace}:relation.customer_invoice_order`,
      invoiceLineInvoice: `${namespace}:relation.customer_invoice_line_invoice`,
      invoiceLineOrderLine: `${namespace}:relation.customer_invoice_line_order_line`,
      paymentInvoice: `${namespace}:relation.customer_payment_invoice`,
      creditInvoice: `${namespace}:relation.customer_credit_invoice`,
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
    ['customer_invoice', 'Invoice', entityIds.customerInvoice],
    ['customer_invoice_line', 'Invoice line', entityIds.customerInvoiceLine],
    ['customer_payment', 'Payment', entityIds.customerPayment],
    ['customer_credit', 'Credit', entityIds.customerCredit],
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
        capabilityId: COMMERCIAL_CAPABILITY_ID,
        capabilityVersion: COMMERCIAL_CAPABILITY_VERSION,
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
      {
        capabilityId: RECEIVABLES_CAPABILITY_ID,
        capabilityVersion: RECEIVABLES_CAPABILITY_VERSION,
        declaredEffects: ['recordMutation'],
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
        { businessKey: true, searchable: true, numberedAs: 'SO' },
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
      ...receivablesFields(definitionIds),
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
      // Master data (owner ruling E): an optional salesperson, the payment
      // terms, and the order's own copy of its ship-to address -- copied from
      // the customer's address book when chosen, then the order's to change.
      field(
        definitionIds,
        entityIds.salesOrder,
        fieldIds.salesOrder.salespersonPartyId,
        'Salesperson',
        70,
        text(80),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.salesOrder,
        fieldIds.salesOrder.paymentTerms,
        'Payment terms',
        80,
        enumeration(definitionIds, 'sales_order_payment_terms', PAYMENT_TERMS),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.salesOrder,
        fieldIds.salesOrder.shipToAddressId,
        'Ship-to address',
        90,
        text(80),
        { optional: true },
      ),
      ...SHIP_TO_FIELDS.map(([name, label, maximumLength], index) =>
        field(
          definitionIds,
          entityIds.salesOrder,
          `${namespace}:field.sales_order_${name}`,
          label,
          100 + index * 10,
          text(maximumLength),
          { optional: true },
        ),
      ),
      // Commercial terms (owner ruling B): the order's tax code, which new
      // lines start from, and two charges, each taxed by its own code.
      ...(
        [
          ['taxCodeId', 'Tax code', text(80)],
          ['freightAmount', 'Freight', decimal()],
          ['freightTaxCodeId', 'Freight tax code', text(80)],
          ['otherFeeAmount', 'Other fee', decimal()],
          ['otherFeeTaxCodeId', 'Other fee tax code', text(80)],
          // Each charge's rate, frozen from its tax code when chosen.
          ['freightTaxRatePercent', 'Freight tax rate %', decimal()],
          ['otherFeeTaxRatePercent', 'Other fee tax rate %', decimal()],
        ] as const
      ).map(([key, label, type], index) =>
        field(
          definitionIds,
          entityIds.salesOrder,
          fieldIds.salesOrder[key],
          label,
          160 + index * 10,
          type,
          { optional: true },
        ),
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
      // The item's price in the order currency when the product was chosen,
      // kept so a changed unit price reads as a manual override (ruling B).
      field(
        definitionIds,
        entityIds.salesOrderLine,
        fieldIds.salesOrderLine.listPrice,
        'List price',
        60,
        decimal(),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.salesOrderLine,
        fieldIds.salesOrderLine.discountPercent,
        'Discount %',
        70,
        decimal(),
        { optional: true },
      ),
      field(
        definitionIds,
        entityIds.salesOrderLine,
        fieldIds.salesOrderLine.taxCodeId,
        'Tax code',
        80,
        text(80),
        { optional: true },
      ),
      // The rate the line is taxed at, frozen from its tax code when chosen
      // (ruling B): a later change of the code's rate leaves the line alone.
      field(
        definitionIds,
        entityIds.salesOrderLine,
        fieldIds.salesOrderLine.taxRatePercent,
        'Tax rate %',
        90,
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
        // An initial shipment is written and kept only with a complete ship-to
        // (owner ruling E), whoever creates it; a correction or reversal
        // restates movements of one that had it.
        {
          kind: 'allPredicate',
          schemaVersion: version,
          terms: [
            fieldComparison(
              `${namespace}:field.shipment_state`,
              `${namespace}:option.shipment_state_draft`,
            ),
            {
              kind: 'anyPredicate',
              schemaVersion: version,
              terms: [
                {
                  kind: 'notPredicate',
                  schemaVersion: version,
                  term: fieldComparison(
                    `${namespace}:field.shipment_kind`,
                    `${namespace}:option.shipment_kind_initial`,
                  ),
                },
                shipToComplete(namespace, 'shipment'),
              ],
            },
          ],
        },
      ),
      ...operations(definitionIds, 'shipment_line', entityIds.shipmentLine),
      fulfillmentOperation(definitionIds, 'reservation', 'reserve'),
      fulfillmentOperation(definitionIds, 'reservation', 'release'),
      fulfillmentOperation(definitionIds, 'shipment', 'post'),
      // Close and cancel act on a confirmed order; the declared guard keeps
      // them out of a draft's or a closed order's commands.
      {
        ...fulfillmentOperation(definitionIds, 'sales_order', 'close'),
        precondition: inState(stateFieldId, definitionIds.stateIds.released),
      },
      {
        ...fulfillmentOperation(definitionIds, 'sales_order', 'cancel'),
        precondition: inState(stateFieldId, definitionIds.stateIds.released),
      },
      // Receivables documents change only while drafts; each posts once
      // through the receivables capability, which freezes its figures.
      ...RECEIVABLES_DOCUMENTS.flatMap((local) =>
        operations(
          definitionIds,
          local,
          `${namespace}:entity.${local}`,
          fieldComparison(
            `${namespace}:field.${local}_state`,
            `${namespace}:option.${local}_state_draft`,
          ),
        ),
      ),
      ...operations(
        definitionIds,
        'customer_invoice_line',
        entityIds.customerInvoiceLine,
      ),
      // Each command is offered only where it applies; the capability
      // re-checks every rule under its locks.
      ...(
        [
          ['customer_invoice', 'post', 'draft'],
          ['customer_invoice', 'void', 'open'],
          ['customer_payment', 'post', 'draft'],
          ['customer_credit', 'post', 'draft'],
        ] as const
      ).map(([local, action, state]) => ({
        ...receivablesOperation(definitionIds, local, action),
        precondition: fieldComparison(
          `${namespace}:field.${local}_state`,
          `${namespace}:option.${local}_state_${state}`,
        ),
      })),
      {
        ...receivablesOperation(
          definitionIds,
          'sales_order',
          'reopen',
          'close',
        ),
        precondition: inState(stateFieldId, definitionIds.stateIds.closed),
      },
      ...DRIVEN_TRANSITIONS.map(([local, , , fromState, , permission]) =>
        transitionOperation(
          definitionIds,
          local,
          permission,
          // Confirm needs a complete ship-to: a confirmed order's header is
          // no longer editable, and it may only ship to a complete address.
          local === 'release'
            ? {
                kind: 'allPredicate',
                schemaVersion: version,
                terms: [
                  inState(stateFieldId, definitionIds.stateIds[fromState]),
                  shipToComplete(namespace, 'sales_order'),
                ],
              }
            : inState(stateFieldId, definitionIds.stateIds[fromState]),
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
          ['customer_invoice', 'post'],
          ['customer_invoice', 'void'],
          ['customer_payment', 'post'],
          ['customer_credit', 'post'],
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
      {
        ...relation(
          definitionIds.relationIds.invoiceOrder,
          entityIds.customerInvoice,
          entityIds.salesOrder,
          90,
        ),
        ownership: 'reference',
      },
      relation(
        definitionIds.relationIds.invoiceLineInvoice,
        entityIds.customerInvoiceLine,
        entityIds.customerInvoice,
        100,
      ),
      {
        ...relation(
          definitionIds.relationIds.invoiceLineOrderLine,
          entityIds.customerInvoiceLine,
          entityIds.salesOrderLine,
          110,
        ),
        ownership: 'reference',
      },
      {
        ...relation(
          definitionIds.relationIds.paymentInvoice,
          entityIds.customerPayment,
          entityIds.customerInvoice,
          120,
        ),
        ownership: 'reference',
      },
      {
        ...relation(
          definitionIds.relationIds.creditInvoice,
          entityIds.customerCredit,
          entityIds.customerInvoice,
          130,
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
    // Carrier and the carrier's tracking number or bill of lading. Optional on
    // the entity (a correction has none); the ship task requires them.
    ['shipment', 'carrier', 'Carrier', text(80), true],
    [
      'shipment',
      'shipping_reference_kind',
      'Reference type',
      enumType('shipment', 'shipping_reference_kind', ['tracking', 'bol']),
      true,
    ],
    [
      'shipment',
      'shipping_reference',
      'Tracking or BOL number',
      text(120),
      true,
    ],
    // The ship-to the shipment went to, copied from its order. Optional on
    // the entity; an initial shipment is refused without a complete one.
    ...SHIP_TO_FIELDS.map(
      ([name, label, maximumLength]) =>
        ['shipment', name, label, text(maximumLength), true] as const,
    ),
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
        ...(local === 'shipment' && name === 'number'
          ? { numberedAs: 'SHP' }
          : {}),
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

/**
 * Receivables fields (owner ruling C). An invoice's customer, currency, terms,
 * due date and figures are written when it posts, from its order; they are
 * optional on the entity because a draft has none of them yet.
 */
const RECEIVABLES_FIELDS: Readonly<
  Record<
    string,
    ReadonlyArray<
      readonly [
        name: string,
        label: string,
        type: 'text' | 'integer' | 'decimal' | 'instant' | 'choice',
        options: {
          readonly length?: number;
          readonly optional?: boolean;
          readonly searchable?: boolean;
          readonly numberedAs?: string;
          readonly choices?: ReadonlyArray<readonly [string, string]>;
        },
      ]
    >
  >
> = {
  customer_invoice: [
    ['number', 'Invoice number', 'text', { length: 60, numberedAs: 'INV' }],
    [
      'state',
      'State',
      'choice',
      {
        choices: [
          ['draft', 'Draft'],
          ['open', 'Open'],
          ['partially_paid', 'Partially paid'],
          ['paid', 'Paid'],
          ['void', 'Void'],
        ],
      },
    ],
    ['invoice_date', 'Invoice date', 'instant', {}],
    ['due_date', 'Due date', 'instant', { optional: true }],
    [
      'customer_party_id',
      'Customer',
      'text',
      { length: 80, optional: true, searchable: true },
    ],
    [
      'currency',
      'Currency',
      'text',
      { length: 3, optional: true, searchable: true },
    ],
    [
      'payment_terms',
      'Payment terms',
      'choice',
      { optional: true, choices: PAYMENT_TERMS },
    ],
    ['subtotal', 'Subtotal', 'decimal', { optional: true }],
    ['charges', 'Charges', 'decimal', { optional: true }],
    ['tax', 'Tax', 'decimal', { optional: true }],
    ['total', 'Total', 'decimal', { optional: true }],
    ['paid_amount', 'Paid', 'decimal', { optional: true }],
    ['credited_amount', 'Credited', 'decimal', { optional: true }],
    ['balance', 'Balance', 'decimal', { optional: true }],
  ],
  customer_invoice_line: [
    ['line_number', 'Line', 'integer', {}],
    ['item_id', 'Item', 'text', { length: 80, searchable: true }],
    ['unit_id', 'Unit', 'text', { length: 32, searchable: true }],
    ['quantity', 'Quantity', 'decimal', {}],
    ['unit_price', 'Unit price', 'decimal', { optional: true }],
    ['discount_percent', 'Discount %', 'decimal', { optional: true }],
    ['tax_rate_percent', 'Tax rate %', 'decimal', { optional: true }],
    ['amount', 'Amount', 'decimal', {}],
    ['tax', 'Tax', 'decimal', {}],
  ],
  customer_payment: [
    ['number', 'Payment number', 'text', { length: 60, numberedAs: 'PAY' }],
    [
      'state',
      'State',
      'choice',
      {
        choices: [
          ['draft', 'Draft'],
          ['posted', 'Posted'],
        ],
      },
    ],
    ['payment_date', 'Payment date', 'instant', {}],
    ['amount', 'Amount', 'decimal', {}],
    [
      'method',
      'Method',
      'choice',
      {
        choices: [
          ['cash', 'Cash'],
          ['cheque', 'Cheque'],
          ['eft', 'EFT'],
          ['card', 'Card'],
          ['other', 'Other'],
        ],
      },
    ],
    ['reference', 'Reference', 'text', { length: 120, optional: true }],
  ],
  customer_credit: [
    ['number', 'Credit number', 'text', { length: 60, numberedAs: 'CM' }],
    [
      'state',
      'State',
      'choice',
      {
        choices: [
          ['draft', 'Draft'],
          ['posted', 'Posted'],
        ],
      },
    ],
    ['credit_date', 'Credit date', 'instant', {}],
    ['amount', 'Amount', 'decimal', {}],
    ['reason', 'Reason', 'text', { length: 1000 }],
  ],
};

function receivablesFields(ids: SalesIds): Array<Record<string, unknown>> {
  return Object.entries(RECEIVABLES_FIELDS).flatMap(([local, specs]) =>
    specs.map(([name, label, type, options], index) =>
      field(
        ids,
        `${ids.namespace}:entity.${local}`,
        `${ids.namespace}:field.${local}_${name}`,
        label,
        (index + 1) * 10,
        type === 'text'
          ? text(options.length ?? 120)
          : type === 'integer'
            ? integer()
            : type === 'decimal'
              ? decimal()
              : type === 'instant'
                ? instant()
                : enumeration(ids, `${local}_${name}`, options.choices ?? []),
        {
          optional: options.optional ?? false,
          searchable: options.searchable ?? options.numberedAs !== undefined,
          ...(options.numberedAs
            ? { businessKey: true, numberedAs: options.numberedAs }
            : {}),
        },
      ),
    ),
  );
}

function receivablesOperation(
  ids: SalesIds,
  local: string,
  action: string,
  permission: string = action,
): Record<string, unknown> {
  return {
    confirmation: 'humanRequired',
    effect: {
      kind: 'registeredCapabilityEffect',
      schemaVersion: version,
      capability: reference('capabilityReference', RECEIVABLES_CAPABILITY_ID),
    },
    kind: 'operationDefinition',
    module: reference('moduleReference', ids.moduleId),
    operationId: `${ids.namespace}:operation.${local}_${action}`,
    permission: reference(
      'permissionReference',
      `${ids.namespace}:permission.${local}_${permission}`,
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
    confirmation:
      permission === 'cancel' || action === 'reopen' ? 'humanRequired' : 'none',
    effect: {
      kind: 'transitionStateEffect',
      schemaVersion: version,
      transition: reference('transitionReference', ids.transitionIds[action]),
    },
    kind: 'operationDefinition',
    // The command words; the stable id keeps its verb (ADR-0056 ordering).
    ...(action === 'release' ? { label: 'Confirm' } : {}),
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

/** Each required ship-to line is present and not blank (absent compares false). */
function shipToComplete(
  namespace: string,
  local: 'sales_order' | 'shipment',
): Record<string, unknown> {
  return {
    kind: 'allPredicate',
    schemaVersion: version,
    terms: SHIP_TO_REQUIRED.map((name) => ({
      field: reference('fieldReference', `${namespace}:field.${local}_${name}`),
      kind: 'fieldComparisonPredicate',
      operator: 'notEquals',
      schemaVersion: version,
      value: { kind: 'textValue', schemaVersion: version, value: '' },
    })),
  };
}

function enumeration(
  ids: SalesIds,
  prefix: string,
  options: ReadonlyArray<readonly [string, string]>,
): FieldType {
  return {
    kind: 'enumFieldType',
    schemaVersion: version,
    options: options.map(([value, label], index) => ({
      kind: 'enumOption',
      schemaVersion: version,
      optionId: `${ids.namespace}:option.${prefix}_${value}`,
      label,
      orderKey: (index + 1) * 10,
    })),
  };
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
      'carrier',
      'shipping_reference_kind',
      'shipping_reference',
      ...SHIP_TO_FIELDS.map(([name]) => name),
    ],
    shipment_line: [
      'line_number',
      'item_id',
      'quantity',
      'unit_id',
      'reversal_of_movement_id',
    ],
    sales_order_shipped: ['shipped_quantity', 'unit_id'],
    ...Object.fromEntries(
      Object.entries(RECEIVABLES_FIELDS).map(([document, specs]) => [
        document,
        specs.map(([name]) => name),
      ]),
    ),
  };
  return (fields[local] ?? []).map(
    (name) => `${ids.namespace}:field.${local}_${name}`,
  );
}

function resolveFieldForEntity(ids: SalesIds, local: string): string {
  const names: Readonly<Record<string, string>> = {
    sales_order: 'sales_order_number',
    sales_order_line: 'sales_order_line_item_id',
    reservation: 'reservation_number',
    reservation_balance: 'reservation_balance_unit_id',
    shipment: 'shipment_number',
    shipment_line: 'shipment_line_item_id',
    customer_invoice: 'customer_invoice_number',
    customer_invoice_line: 'customer_invoice_line_item_id',
    customer_payment: 'customer_payment_number',
    customer_credit: 'customer_credit_number',
  };
  return `${ids.namespace}:field.${names[local] ?? 'sales_order_shipped_unit_id'}`;
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
      ...(queryType === 'list' &&
      (local === 'sales_order' || local === 'customer_invoice')
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
  /** A stricter guard for the create and update images, when declared. */
  writePrecondition: Record<string, unknown> | undefined = precondition,
): Array<Record<string, unknown>> {
  const guardFor = (action: string) =>
    action === 'create' || action === 'update'
      ? writePrecondition
      : precondition;
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
    ...(guardFor(action) ? { precondition: guardFor(action) } : {}),
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
