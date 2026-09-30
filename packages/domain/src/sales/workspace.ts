export const FULFILLMENT_READ_MODEL_BINDINGS = Object.freeze({
  line: 'northstar.sales:read_model.line',
  reservation: 'northstar.sales:read_model.reservation',
  // RETURNS: a return's lines with what each can still take back.
  returnLine: 'northstar.sales:read_model.return_line',
});
/**
 * RETURNS (ruling D): what an order line has had returned (net of
 * corrections) and what may still come back, beside what it shipped.
 */
export const RETURN_LINE_OUTPUTS = Object.freeze(['returned', 'returnable']);
/** What each line of a posted return still adds, and how to reverse it. */
export const RETURN_REVERSAL_OUTPUTS = Object.freeze([
  'return_movement',
  'return_reversible',
  'return_reversal_quantity',
  'return_order_line',
]);
/** Line amounts and order totals, computed on read (owner ruling B). */
export const COMMERCIAL_READ_MODEL_BINDINGS = Object.freeze({
  line: 'northstar.sales:read_model.commercial_line',
  order: 'northstar.sales:read_model.commercial_order',
  // The same figures for a purchase order (ruling B extended to purchasing).
  purchaseLine: 'northstar.sales:read_model.commercial_purchase_line',
  purchaseOrder: 'northstar.sales:read_model.commercial_purchase_order',
});
/** The commercial outputs, by read-model binding. */
export const COMMERCIAL_READ_MODEL_OUTPUTS = Object.freeze({
  line: ['line_amount', 'line_tax', 'price_basis'],
  order: [
    'order_subtotal',
    'order_charges',
    'order_tax',
    'order_total',
    'order_to_invoice',
  ],
  // A purchase line also states what has arrived and what is still to arrive
  // (PURCHASING-PARITY), from the receiving projection.
  purchaseLine: ['line_amount', 'line_tax', 'received', 'open_to_receive'],
  purchaseOrder: [
    'order_subtotal',
    'order_charges',
    'order_tax',
    'order_total',
  ],
} as const);
/**
 * A purchase order's received quantity not yet on a live vendor bill
 * (PAYABLES), stated only when the application composes payables.
 */
export const PAYABLES_READ_MODEL_OUTPUTS = Object.freeze({
  // Each line's three-way match (PY-G): billed, left to bill, and how billing
  // compares with what was received.
  purchaseLine: ['billed', 'to_bill', 'match_status'],
  purchaseOrder: ['order_to_bill'],
} as const);
/** Why goods came back (ruling D); stored as the return's reason code. */
const RETURN_REASONS = [
  ['DAMAGED', 'Damaged'],
  ['DEFECTIVE', 'Defective'],
  ['WRONG_ITEM', 'Wrong item'],
  ['NOT_NEEDED', 'No longer needed'],
  ['OTHER', 'Other'],
] as const;
/** The order's ship-to lines, as the workspace shows and prints them. */
const SHIP_TO_LINES = [
  ['ship_to_name', 'Ship-to recipient'],
  ['ship_to_street', 'Ship-to street'],
  ['ship_to_city', 'Ship-to city'],
  ['ship_to_region', 'Ship-to province or state'],
  ['ship_to_postal_code', 'Ship-to postal code'],
  ['ship_to_country', 'Ship-to country'],
] as const;

/** RAIN-META-SALES: product composition; the runtime interprets the same data for any module. */
export function salesWorkspace(namespace: string): Record<string, unknown> {
  const id = (type: string, name: string) => `${namespace}:${type}.${name}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const q = (name: string) => ref('queryReference', id('query', name));
  const field = (name: string) => id('field', name);
  const column = (
    name: string,
    label: string,
    orderKey: number,
    value: string,
    lookup?: readonly [string, string],
  ) => ({
    columnId: id('column', name),
    label,
    orderKey,
    field: value,
    ...(lookup
      ? {
          reference: {
            query: q(lookup[0]),
            labelField: ref('fieldReference', field(lookup[1])),
          },
        }
      : {}),
  });
  const hierarchy = (
    columns: ReturnType<typeof column>[],
    primary: string,
    secondary: string[],
    quantities: string[],
    details: string[] = [],
  ) =>
    columns.map((value) => ({
      ...value,
      ...(value.columnId === id('column', primary) ||
      [...secondary, ...quantities, ...details].some(
        (name) => value.columnId === id('column', name),
      )
        ? {
            presentation: {
              role:
                value.columnId === id('column', primary)
                  ? 'primary'
                  : secondary.some(
                        (name) => value.columnId === id('column', name),
                      )
                    ? 'secondary'
                    : quantities.some(
                          (name) => value.columnId === id('column', name),
                        )
                      ? 'quantity'
                      : details.some(
                            (name) => value.columnId === id('column', name),
                          )
                        ? 'detail'
                        : 'secondary',
              priority: value.orderKey,
            },
          }
        : {}),
    }));
  const selected = (name: string) => ({ source: 'selected', field: name });
  const record = (name: string) => ({ source: 'record', field: name });
  const literal = (value: string | number | null) => ({
    source: 'literal',
    value,
  });
  const generated = (value: string) => ({ source: 'generated', value });
  const input = (name: string) => ({
    source: 'input',
    inputId: id('input', name),
  });
  const stepValue = (name: string, value: string) => ({
    source: 'step',
    stepId: id('step', name),
    field: value,
  });
  const bind = (path: string[], value: unknown) => ({ path, value });
  const step = (name: string, operation: string, bindings: unknown[]) => ({
    stepId: id('step', name),
    operation: ref('operationReference', id('operation', operation)),
    bindings,
  });
  const create = (
    name: string,
    entity: string,
    values: Record<string, unknown>,
    relations: Record<string, unknown>,
  ) =>
    step(name, `${entity}_create`, [
      bind(['recordId'], generated('uuid')),
      bind(['legalEntityId'], generated('scope')),
      ...Object.entries(values).map(([key, value]) =>
        bind(['values', field(`${entity}_${key}`)], value),
      ),
      ...Object.entries(relations).map(([key, value]) =>
        bind(['relations', id('relation', `${entity}_${key}`)], value),
      ),
    ]);
  const command = (name: string, operation: string, source: string) =>
    step(name, operation, [
      bind(['recordId'], stepValue(source, 'recordId')),
      bind(['expectedRevision'], stepValue(source, 'revision')),
    ]);
  // Shown with grouped digits and two decimals, never rounded (ruling B).
  const money = <T extends object>(value: T) => ({
    ...value,
    format: 'money' as const,
  });
  const lines = id('dataset', 'fulfillment_lines');
  const pricedLines = id('dataset', 'order_lines');
  // An order total, read with the record: the detail surface reads through
  // the commercial order query, whose read model states the totals.
  const totalColumn = (name: string, label: string, orderKey: number) =>
    money(
      column(`order_${name}`, label, orderKey, id('metric', `order_${name}`)),
    );
  const reservations = id('dataset', 'line_reservations');
  const shipments = id('dataset', 'order_shipments');
  const invoices = id('dataset', 'order_invoices');
  // RETURNS (ruling D): the order's returns and a selected return's lines.
  const returns = id('dataset', 'order_returns');
  const returnLines = id('dataset', 'order_return_lines');
  const taskColumn = (datasetId: string, name: string) => ({
    datasetId,
    columnId: id('column', name),
  });
  const taskPresentation = (kind: 'reserve' | 'ship' | 'release') => {
    const reserving = kind === 'reserve';
    const reservationQuantity = {
      value: taskColumn(reservations, 'remaining'),
      unit: taskColumn(reservations, 'reservation_unit'),
      label: 'remaining in this reservation',
    };
    return {
      placement: 'selection',
      task: {
        summary: {
          identity: taskColumn(lines, 'item'),
          secondary: taskColumn(lines, 'sku'),
          ...(!reserving
            ? {
                context: taskColumn(reservations, 'location'),
                quantity: reservationQuantity,
              }
            : {}),
        },
        confirmation: {
          title: reserving ? 'Reserve' : kind === 'ship' ? 'Ship' : 'Release',
          reviewLabel: reserving
            ? 'Review reservation'
            : kind === 'ship'
              ? 'Review shipment'
              : 'Review release',
          confirmLabel: reserving
            ? 'Confirm reservation'
            : kind === 'ship'
              ? 'Confirm shipment'
              : 'Confirm release',
          quantity:
            kind === 'release'
              ? { source: 'column', ...reservationQuantity.value }
              : input('quantity'),
          unit: taskColumn(
            reserving ? lines : reservations,
            reserving ? 'unit' : 'reservation_unit',
          ),
          context: reserving
            ? input('location')
            : { source: 'column', ...taskColumn(reservations, 'location') },
        },
      },
    };
  };
  const released = {
    value: record(
      `${namespace}:derived_state_field.machine.sales_order_lifecycle`,
    ),
    operator: 'equals',
    compare: id('state', 'sales_order_released'),
  };
  const lifecycle = (
    operator: 'equals' | 'notEquals',
    state: 'draft' | 'released' | 'closed' | 'cancelled',
  ) => ({
    value: record(
      `${namespace}:derived_state_field.machine.sales_order_lifecycle`,
    ),
    operator,
    compare: id('state', `sales_order_${state}`),
  });
  const inState = (state: Parameters<typeof lifecycle>[1]) =>
    lifecycle('equals', state);
  const notInState = (state: Parameters<typeof lifecycle>[1]) =>
    lifecycle('notEquals', state);
  const active = {
    value: selected(id('metric', 'remaining')),
    operator: 'positive',
    compare: null,
  };
  const quantityInput = {
    inputId: id('input', 'quantity'),
    label: 'Quantity',
    orderKey: 10,
    type: 'quantity',
    required: true,
  };
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: id('column', 'order_number'),
        subtitle: [id('column', 'customer')],
        status: id('column', 'order_state'),
        facts: [
          id('column', 'order_date'),
          id('column', 'requested_date'),
          id('column', 'currency'),
          id('column', 'salesperson'),
          id('column', 'payment_terms'),
          id('column', 'order_total'),
        ],
      },
      context: {
        label: 'Fulfillment',
        description:
          'Choose a line to reserve stock, or a reservation to ship.',
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
      task: { mode: 'nativeDialog', fallback: 'page' },
      // Owner ruling G: a printable order, saved as PDF by the browser.
      print: {
        label: 'Sales order',
        datasets: [pricedLines],
        note: id('column', 'notes'),
        totals: [
          id('column', 'order_subtotal'),
          id('column', 'freight'),
          id('column', 'other_fee'),
          id('column', 'order_tax'),
          id('column', 'order_total'),
        ],
      },
      // The ship-to lines read as one address, on screen and when printed.
      blocks: [
        {
          label: 'Ship to',
          columns: SHIP_TO_LINES.map(([name]) => id('column', name)),
        },
      ],
      // PaneFlow's fulfillment exception: the lines this order is short.
      alerts: [
        {
          label: 'Fulfillment exception',
          description:
            'Open quantity that neither this order’s reservations nor free stock now cover. Incoming purchase orders are not counted.',
          datasetId: lines,
          columnId: id('column', 'short'),
        },
      ],
      // Order to cash: where this order stands and what to do next.
      progression: {
        title: 'Order to cash',
        steps: [
          {
            label: 'Sales order',
            current: [inState('draft')],
            complete: [notInState('draft'), notInState('cancelled')],
            stopped: [inState('cancelled')],
          },
          {
            label: 'Fulfillment',
            current: [inState('released')],
            complete: [inState('closed')],
            stopped: [inState('cancelled')],
            documents: shipments,
          },
          {
            label: 'Invoicing',
            current: [inState('released')],
            complete: [inState('closed')],
            // Shipped quantity is waiting to be invoiced.
            attention: [
              {
                value: record(id('metric', 'order_to_invoice')),
                operator: 'positive',
                compare: null,
              },
            ],
            stopped: [inState('cancelled')],
            documents: invoices,
          },
          {
            label: 'Closed',
            current: [],
            complete: [inState('closed')],
            stopped: [inState('cancelled')],
          },
        ],
        next: [
          {
            operation: ref(
              'operationReference',
              id('operation', 'sales_order_release'),
            ),
          },
          { action: id('action', 'invoice_shipped') },
        ],
      },
    },
    fields: [
      column('order_number', 'Sales order', 10, field('sales_order_number')),
      column(
        'order_state',
        'Order state',
        15,
        `${namespace}:derived_state_field.machine.sales_order_lifecycle`,
      ),
      column(
        'customer',
        'Customer',
        20,
        field('sales_order_customer_party_id'),
        ['party_get', 'party_name'],
      ),
      column('order_date', 'Order date', 25, field('sales_order_order_date')),
      column(
        'requested_date',
        'Requested date',
        30,
        field('sales_order_requested_date'),
      ),
      column('currency', 'Currency', 35, field('sales_order_currency')),
      // Read back as stored; shown in the document's sections.
      column('notes', 'Notes', 40, field('sales_order_notes')),
      column(
        'salesperson',
        'Salesperson',
        45,
        field('sales_order_salesperson_party_id'),
        ['party_get', 'party_name'],
      ),
      column(
        'payment_terms',
        'Payment terms',
        50,
        field('sales_order_payment_terms'),
      ),
      ...SHIP_TO_LINES.map(([name, label], index) =>
        column(name, label, 55 + index, field(`sales_order_${name}`)),
      ),
      // Commercial terms and totals (owner ruling B).
      column('tax_code', 'Tax code', 65, field('sales_order_tax_code_id'), [
        'tax_code_get',
        'tax_code_code',
      ]),
      money(
        column('freight', 'Freight', 66, field('sales_order_freight_amount')),
      ),
      column(
        'freight_tax_code',
        'Freight tax code',
        67,
        field('sales_order_freight_tax_code_id'),
        ['tax_code_get', 'tax_code_code'],
      ),
      money(
        column(
          'other_fee',
          'Other fee',
          68,
          field('sales_order_other_fee_amount'),
        ),
      ),
      column(
        'other_fee_tax_code',
        'Other fee tax code',
        69,
        field('sales_order_other_fee_tax_code_id'),
        ['tax_code_get', 'tax_code_code'],
      ),
      totalColumn('subtotal', 'Subtotal', 70),
      totalColumn('charges', 'Charges', 71),
      totalColumn('tax', 'Tax', 72),
      totalColumn('total', 'Total', 73),
    ],
    children: [
      {
        // What each line costs: price, discount, tax and amount (ruling B).
        datasetId: pricedLines,
        presentation: { selection: 'none' },
        label: 'Order lines',
        orderKey: 5,
        query: q('commercial_order_lines'),
        sort: [
          {
            fieldId: field('sales_order_line_line_number'),
            direction: 'ascending',
          },
        ],
        parent: {
          relationId: id('relation', 'sales_order_line_order'),
          value: record('recordId'),
          ownership: 'parentScopedChild',
        },
        columns: hierarchy(
          [
            column(
              'priced_line',
              'Line',
              10,
              field('sales_order_line_line_number'),
            ),
            column(
              'priced_item',
              'Item',
              20,
              field('sales_order_line_item_id'),
              ['item_get', 'item_name'],
            ),
            column(
              'priced_quantity',
              'Quantity',
              30,
              field('sales_order_line_ordered_quantity'),
            ),
            column(
              'priced_unit',
              'Unit',
              35,
              field('sales_order_line_unit_id'),
            ),
            money(
              column(
                'priced_unit_price',
                'Unit price',
                40,
                field('sales_order_line_unit_price'),
              ),
            ),
            column('priced_basis', 'Price', 45, id('metric', 'price_basis')),
            money(
              column(
                'priced_list_price',
                'List price',
                50,
                field('sales_order_line_list_price'),
              ),
            ),
            column(
              'priced_discount',
              'Discount %',
              55,
              field('sales_order_line_discount_percent'),
            ),
            column(
              'priced_tax_code',
              'Tax code',
              60,
              field('sales_order_line_tax_code_id'),
              ['tax_code_get', 'tax_code_code'],
            ),
            money(column('priced_tax', 'Tax', 70, id('metric', 'line_tax'))),
            money(
              column(
                'priced_amount',
                'Amount',
                80,
                id('metric', 'line_amount'),
              ),
            ),
          ],
          'priced_item',
          ['priced_unit', 'priced_unit_price', 'priced_basis'],
          ['priced_quantity', 'priced_tax', 'priced_amount'],
          ['priced_list_price', 'priced_discount', 'priced_tax_code'],
        ),
      },
      {
        datasetId: lines,
        presentation: { selection: 'explicit', selectedActions: 'row' },
        label: 'Fulfillment',
        orderKey: 10,
        // The line figures and what each line is short (ORDER-PARITY), read
        // only where this page shows them.
        query: q('fulfillment_order_lines'),
        sort: [
          {
            fieldId: field('sales_order_line_line_number'),
            direction: 'ascending',
          },
        ],
        parent: {
          relationId: id('relation', 'sales_order_line_order'),
          value: record('recordId'),
          ownership: 'parentScopedChild',
        },
        columns: hierarchy(
          [
            column('line', 'Line', 10, field('sales_order_line_line_number')),
            column('item', 'Item', 20, field('sales_order_line_item_id'), [
              'item_get',
              'item_name',
            ]),
            column('sku', 'SKU', 25, field('sales_order_line_item_id'), [
              'item_get',
              'item_sku',
            ]),
            column(
              'ordered',
              'Ordered',
              30,
              field('sales_order_line_ordered_quantity'),
            ),
            column('unit', 'Unit', 40, field('sales_order_line_unit_id')),
            money(
              column(
                'unit_price',
                'Unit price',
                45,
                field('sales_order_line_unit_price'),
              ),
            ),
            column('coverage', 'Reserved', 50, id('metric', 'coverage')),
            column('shipped', 'Shipped', 60, id('metric', 'shipped')),
            // Ruling D: returned stays apart from shipped.
            column('returned', 'Returned', 65, id('metric', 'returned')),
            column('open', 'Open to ship', 70, id('metric', 'open_to_ship')),
            // Advisory (owner ruling of 2026-09-30): open quantity neither
            // this line's reservations nor free stock now cover.
            column('short', 'Short', 80, id('metric', 'short')),
            column(
              'available_now',
              'Free stock now',
              90,
              id('metric', 'available_now'),
            ),
          ],
          'item',
          ['sku', 'unit', 'unit_price'],
          ['ordered', 'coverage', 'shipped', 'returned', 'open', 'short'],
          ['available_now'],
        ),
      },
      {
        datasetId: reservations,
        presentation: {
          selection: 'explicit',
          compact: 'scrollTable',
          description:
            'Reservation-scoped availability for this item and location. Missing or unavailable data is not zero stock.',
        },
        label: 'Reservations and stock',
        orderKey: 20,
        query: q('reservation_list'),
        parent: {
          relationId: id('relation', 'reservation_order_line'),
          value: { ...selected('recordId'), datasetId: lines },
          ownership: 'reference',
        },
        columns: hierarchy(
          [
            column(
              'reservation',
              'Reservation',
              10,
              field('reservation_number'),
            ),
            column(
              'location',
              'Location',
              20,
              field('reservation_location_id'),
              ['location_get', 'location_name'],
            ),
            column(
              'quantity',
              'Original quantity',
              30,
              field('reservation_quantity'),
            ),
            column('state', 'State', 40, field('reservation_state')),
            column(
              'reservation_unit',
              'Unit',
              45,
              field('reservation_unit_id'),
            ),
            column('remaining', 'Remaining', 50, id('metric', 'remaining')),
            column('on_hand', 'On hand', 60, id('metric', 'on_hand')),
            column(
              'reserved_total',
              'Reserved stock',
              70,
              id('metric', 'reserved'),
            ),
            column('available', 'Available', 80, id('metric', 'available')),
          ],
          'location',
          ['state', 'reservation_unit'],
          ['remaining', 'on_hand', 'reserved_total', 'available'],
          ['reservation', 'quantity'],
        ),
      },
      {
        datasetId: shipments,
        presentation: { selection: 'none', compact: 'scrollTable' },
        label: 'Shipments and packing',
        orderKey: 30,
        query: q('shipment_list'),
        parent: {
          relationId: id('relation', 'shipment_order'),
          value: record('recordId'),
          ownership: 'reference',
        },
        columns: [
          column('shipment', 'Shipment', 10, field('shipment_number')),
          column('shipment_state', 'State', 20, field('shipment_state')),
          column(
            'shipped_at',
            'Shipped at',
            30,
            field('shipment_effective_at'),
          ),
          column('carrier', 'Carrier', 40, field('shipment_carrier')),
          column(
            'shipping_reference',
            'Tracking or BOL',
            50,
            field('shipment_shipping_reference'),
          ),
        ],
      },
      {
        // RETURNS (ruling D): what came back against this order's shipped
        // lines; a selected return shows its lines and what they still add.
        datasetId: returns,
        presentation: {
          selection: 'explicit',
          selectedActions: 'row',
          compact: 'scrollTable',
        },
        label: 'Returns',
        orderKey: 35,
        query: q('customer_return_list'),
        parent: {
          relationId: id('relation', 'customer_return_order'),
          value: record('recordId'),
          ownership: 'reference',
        },
        columns: [
          column('return', 'Return', 10, field('customer_return_number')),
          column('return_state', 'State', 20, field('customer_return_state')),
          column('return_kind', 'Kind', 25, field('customer_return_kind')),
          column(
            'returned_at',
            'Returned at',
            30,
            field('customer_return_effective_at'),
          ),
          column(
            'return_location',
            'Returned into',
            40,
            field('customer_return_location_id'),
            ['location_get', 'location_name'],
          ),
          column(
            'return_reason',
            'Reason',
            50,
            field('customer_return_reason_code'),
          ),
        ],
      },
      {
        datasetId: returnLines,
        label: 'Return lines',
        orderKey: 36,
        query: q('fulfillment_return_lines'),
        presentation: {
          selection: 'none',
          compact: 'scrollTable',
          description:
            'Still returned is what each line adds to stock after earlier corrections. Missing or unavailable data is not zero.',
        },
        parent: {
          relationId: id('relation', 'customer_return_line_return'),
          value: { ...selected('recordId'), datasetId: returns },
          ownership: 'parentScopedChild',
        },
        sort: [
          {
            fieldId: field('customer_return_line_line_number'),
            direction: 'ascending',
          },
        ],
        columns: [
          column(
            'return_line',
            'Line',
            10,
            field('customer_return_line_line_number'),
          ),
          column(
            'return_item',
            'Item',
            20,
            field('customer_return_line_item_id'),
            ['item_get', 'item_name'],
          ),
          column(
            'return_quantity',
            'Quantity',
            30,
            field('customer_return_line_quantity'),
          ),
          column(
            'return_unit',
            'Unit',
            40,
            field('customer_return_line_unit_id'),
          ),
          column(
            'return_still',
            'Still returned',
            50,
            id('metric', 'return_reversible'),
          ),
        ],
      },
      {
        // Receivables (owner ruling C): the order's invoices and balances.
        datasetId: invoices,
        presentation: { selection: 'none', compact: 'scrollTable' },
        label: 'Invoices',
        orderKey: 40,
        query: q('customer_invoice_list'),
        parent: {
          relationId: id('relation', 'customer_invoice_order'),
          value: record('recordId'),
          ownership: 'reference',
        },
        sort: [
          {
            fieldId: field('customer_invoice_invoice_date'),
            direction: 'ascending',
          },
        ],
        columns: [
          column('invoice', 'Invoice', 10, field('customer_invoice_number')),
          column('invoice_state', 'State', 20, field('customer_invoice_state')),
          column(
            'invoice_date',
            'Invoice date',
            30,
            field('customer_invoice_invoice_date'),
          ),
          column('invoice_due', 'Due', 40, field('customer_invoice_due_date')),
          money(
            column(
              'invoice_total',
              'Total',
              50,
              field('customer_invoice_total'),
            ),
          ),
          money(
            column(
              'invoice_balance',
              'Balance',
              60,
              field('customer_invoice_balance'),
            ),
          ),
        ],
      },
    ],
    actions: [
      {
        actionId: id('action', 'reserve_stock'),
        presentation: taskPresentation('reserve'),
        label: 'Reserve stock',
        description: 'On hand stays unchanged; available stock decreases.',
        orderKey: 10,
        datasetId: lines,
        conditions: [released],
        inputs: [
          { ...quantityInput, label: 'Quantity to reserve' },
          {
            inputId: id('input', 'location'),
            label: 'Stock location',
            orderKey: 20,
            type: 'reference',
            required: true,
            query: q('location_list'),
            labelField: ref('fieldReference', field('location_name')),
          },
        ],
        steps: [
          create(
            'reserve_draft',
            'reservation',
            {
              number: generated('uuid'),
              state: literal(id('option', 'reservation_state_draft')),
              item_id: selected(field('sales_order_line_item_id')),
              location_id: input('location'),
              quantity: input('quantity'),
              unit_id: selected(field('sales_order_line_unit_id')),
              reason: literal('Release unused stock'),
            },
            { order_line: selected('recordId') },
          ),
          command('reserve_commit', 'reservation_reserve', 'reserve_draft'),
        ],
      },
      {
        actionId: id('action', 'ship_reserved'),
        presentation: taskPresentation('ship'),
        label: 'Ship reserved stock',
        description:
          'On hand and reserved stock decrease by the shipped quantity.',
        orderKey: 20,
        datasetId: reservations,
        conditions: [released, active],
        inputs: [
          { ...quantityInput, label: 'Quantity to ship' },
          {
            inputId: id('input', 'carrier'),
            label: 'Carrier',
            orderKey: 20,
            type: 'text',
            required: true,
          },
          {
            inputId: id('input', 'shipping_reference_kind'),
            label: 'Reference type',
            orderKey: 30,
            type: 'text',
            required: true,
            presentation: {
              kind: 'choice',
              options: [
                {
                  value: id(
                    'option',
                    'shipment_shipping_reference_kind_tracking',
                  ),
                  label: 'Tracking number',
                },
                {
                  value: id('option', 'shipment_shipping_reference_kind_bol'),
                  label: 'Bill of lading',
                },
              ],
              defaultValue: id(
                'option',
                'shipment_shipping_reference_kind_tracking',
              ),
            },
          },
          {
            inputId: id('input', 'shipping_reference'),
            label: 'Tracking or BOL number',
            orderKey: 40,
            type: 'text',
            required: true,
          },
        ],
        steps: [
          create(
            'shipment_draft',
            'shipment',
            {
              // The shipment number is assigned on create (SHP-000001).
              carrier: input('carrier'),
              shipping_reference_kind: input('shipping_reference_kind'),
              shipping_reference: input('shipping_reference'),
              state: literal(id('option', 'shipment_state_draft')),
              kind: literal(id('option', 'shipment_kind_initial')),
              effective_at: generated('instant'),
              location_id: selected(field('reservation_location_id')),
              external_reference: literal(null),
              reason_code: literal('SHIP'),
              reason_narrative: literal('Ship reserved stock'),
              // The shipment keeps the address it went to (ruling E).
              ...Object.fromEntries(
                SHIP_TO_LINES.map(([name]) => [
                  name,
                  record(field(`sales_order_${name}`)),
                ]),
              ),
            },
            { order: record('recordId') },
          ),
          create(
            'shipment_line',
            'shipment_line',
            {
              line_number: literal('1'),
              item_id: selected(field('reservation_item_id')),
              quantity: input('quantity'),
              unit_id: selected(field('reservation_unit_id')),
              reversal_of_movement_id: literal(null),
            },
            {
              shipment: stepValue('shipment_draft', 'recordId'),
              order_line: {
                source: 'selected',
                datasetId: lines,
                field: 'recordId',
              },
              reservation: selected('recordId'),
            },
          ),
          command('shipment_commit', 'shipment_post', 'shipment_draft'),
        ],
      },
      {
        actionId: id('action', 'release_remaining'),
        presentation: taskPresentation('release'),
        label: 'Release remainder',
        description:
          'On hand stays unchanged; the remaining reservation becomes available.',
        orderKey: 30,
        datasetId: reservations,
        conditions: [released, active],
        inputs: [],
        steps: [
          step('release_commit', 'reservation_release', [
            bind(['recordId'], selected('recordId')),
            bind(['expectedRevision'], selected('revision')),
          ]),
        ],
      },
      {
        // RETURNS (ruling D): goods back from the customer against this
        // shipped line, into any active location (ruling R-C). Shipped stays
        // shipped and invoicing is unchanged; a credit is a separate step.
        actionId: id('action', 'receive_return'),
        presentation: { placement: 'selection' },
        label: 'Receive return',
        description:
          'Returned goods go back on hand at the location you choose. Shipped and invoiced quantities are unchanged.',
        orderKey: 32,
        datasetId: lines,
        // A confirmed or closed order, while the line has something shipped
        // that has not come back; the posting kernel bounds it under lock.
        conditions: [
          notInState('draft'),
          notInState('cancelled'),
          {
            value: selected(id('metric', 'returnable')),
            operator: 'positive',
            compare: null,
          },
        ],
        inputs: [
          {
            inputId: id('input', 'return_quantity'),
            label: 'Quantity returned',
            orderKey: 10,
            type: 'quantity',
            required: true,
          },
          {
            inputId: id('input', 'return_location'),
            label: 'Return into location',
            orderKey: 20,
            type: 'reference',
            required: true,
            query: q('location_list'),
            labelField: ref('fieldReference', field('location_name')),
          },
          {
            inputId: id('input', 'return_reason'),
            label: 'Reason',
            orderKey: 30,
            type: 'text',
            required: true,
            presentation: {
              kind: 'choice',
              options: RETURN_REASONS.map(([value, label]) => ({
                value,
                label,
              })),
              defaultValue: RETURN_REASONS[0][0],
            },
          },
          {
            inputId: id('input', 'return_notes'),
            label: 'Notes',
            orderKey: 40,
            type: 'text',
            required: false,
            presentation: { kind: 'multiline' },
          },
        ],
        steps: [
          create(
            'return_draft',
            'customer_return',
            {
              // The return number is assigned on create (RMA-000001).
              state: literal(id('option', 'customer_return_state_draft')),
              kind: literal(id('option', 'customer_return_kind_initial')),
              effective_at: generated('instant'),
              location_id: input('return_location'),
              reason_code: input('return_reason'),
              reason_narrative: input('return_notes'),
            },
            { order: record('recordId') },
          ),
          create(
            'return_line',
            'customer_return_line',
            {
              line_number: selected(field('sales_order_line_line_number')),
              item_id: selected(field('sales_order_line_item_id')),
              quantity: input('return_quantity'),
              unit_id: selected(field('sales_order_line_unit_id')),
              reversal_of_movement_id: literal(null),
            },
            {
              return: stepValue('return_draft', 'recordId'),
              order_line: selected('recordId'),
            },
          ),
          command('return_commit', 'customer_return_post', 'return_draft'),
        ],
      },
      {
        // A posted return taken back (ruling D): a draft return of kind
        // reversal naming the original, one line for every line of it that
        // still adds to stock -- each at exactly that quantity, naming its own
        // movement -- then posted. The posting kernel admits only that.
        actionId: id('action', 'reverse_return'),
        presentation: { placement: 'selection' },
        label: 'Reverse return',
        description:
          'Takes back every line of this return that still adds to stock, at exactly that quantity, with a posted reversal. Refused if the stock has already left.',
        orderKey: 37,
        datasetId: returns,
        conditions: [
          {
            value: selected(field('customer_return_state')),
            operator: 'equals',
            compare: id('option', 'customer_return_state_posted'),
          },
          {
            value: selected(field('customer_return_kind')),
            operator: 'equals',
            compare: id('option', 'customer_return_kind_initial'),
          },
        ],
        rows: {
          datasetId: returnLines,
          conditions: [
            {
              value: selected(id('metric', 'return_reversible')),
              operator: 'positive',
              compare: null,
            },
          ],
        },
        inputs: [
          {
            inputId: id('input', 'reverse_return_reason'),
            label: 'Reason',
            orderKey: 10,
            type: 'text',
            required: true,
            presentation: { kind: 'multiline' },
          },
        ],
        steps: [
          create(
            'return_reversal',
            'customer_return',
            {
              state: literal(id('option', 'customer_return_state_draft')),
              kind: literal(id('option', 'customer_return_kind_reversal')),
              effective_at: generated('instant'),
              // The original's location: a reversal takes back from where the
              // return put the goods.
              location_id: selected(field('customer_return_location_id')),
              reason_code: literal('REVERSE'),
              reason_narrative: input('reverse_return_reason'),
            },
            { order: record('recordId'), supersedes: selected('recordId') },
          ),
          {
            ...create(
              'return_reversal_line',
              'customer_return_line',
              {
                line_number: selected(
                  field('customer_return_line_line_number'),
                ),
                item_id: selected(field('customer_return_line_item_id')),
                quantity: selected(id('metric', 'return_reversal_quantity')),
                unit_id: selected(field('customer_return_line_unit_id')),
                reversal_of_movement_id: selected(
                  id('metric', 'return_movement'),
                ),
              },
              {
                return: stepValue('return_reversal', 'recordId'),
                order_line: selected(id('metric', 'return_order_line')),
              },
            ),
            each: true,
          },
          command(
            'return_reversal_commit',
            'customer_return_post',
            'return_reversal',
          ),
        ],
      },
      {
        // Every shipped quantity not yet invoiced, at the order's own prices,
        // discounts and frozen rates; the first invoice carries the charges.
        actionId: id('action', 'invoice_shipped'),
        label: 'Invoice shipped quantities',
        description:
          'Invoices every shipped quantity not yet invoiced at this order’s prices and tax rates. The first invoice also carries the freight and other fee.',
        orderKey: 35,
        // Offered while shipped quantity is not yet invoiced and the order's
        // figures can be stated; the capability decides per line.
        conditions: [
          {
            value: record(id('metric', 'order_to_invoice')),
            operator: 'positive',
            compare: null,
          },
          {
            value: record(id('metric', 'order_total')),
            operator: 'positive',
            compare: null,
          },
        ],
        inputs: [],
        steps: [
          create(
            'invoice_draft',
            'customer_invoice',
            {
              // The invoice number is assigned on create (INV-000001).
              state: literal(id('option', 'customer_invoice_state_draft')),
              invoice_date: generated('instant'),
            },
            { order: record('recordId') },
          ),
          command('invoice_commit', 'customer_invoice_post', 'invoice_draft'),
        ],
      },
      {
        actionId: id('action', 'open_invoice'),
        presentation: { placement: 'row' },
        label: 'Open invoice',
        description: 'Open the invoice with its lines, payments and credits.',
        orderKey: 45,
        datasetId: invoices,
        conditions: [],
        inputs: [],
        steps: [],
        navigate: {
          surface: ref(
            'surfaceReference',
            id('surface', 'customer_invoice_detail'),
          ),
          query: q('customer_invoice_get'),
          record: selected('recordId'),
        },
      },
      {
        actionId: id('action', 'open_packing'),
        presentation: { placement: 'row' },
        label: 'Open packing',
        description: 'Open the complete committed shipment document.',
        orderKey: 40,
        datasetId: shipments,
        conditions: [
          {
            value: selected(field('shipment_state')),
            operator: 'equals',
            compare: id('option', 'shipment_state_posted'),
          },
        ],
        inputs: [],
        steps: [],
        navigate: {
          surface: ref('surfaceReference', id('surface', 'shipment_detail')),
          query: q('shipment_get'),
          record: selected('recordId'),
        },
      },
    ],
  };
}

/** Queries used by the registered fulfillment read model, all under normal gateway policy. */
export function salesWorkspaceQueries(
  namespace: string,
  queries: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const clone = (original: string, name: string) => {
    const source = queries.find(
      (query) => query.queryId === `${namespace}:query.${original}`,
    );
    if (!source) throw new Error(`Missing query ${original}`);
    return JSON.parse(
      JSON.stringify(source)
        .replaceAll(
          `${namespace}:query.${original}`,
          `${namespace}:query.${name}`,
        )
        .replaceAll(`selection.${original}_`, `selection.${name}_`)
        .replaceAll(`parameter.${original}_`, `parameter.${name}_`),
    ) as Record<string, unknown>;
  };
  const plain = clone('reservation_list', 'workspace_reservations');
  const stockReservations = clone(
    'reservation_list',
    'workspace_stock_reservations',
  );
  const stock = clone('posted_stock_balance_list', 'workspace_stock');
  // Commercial reads: priced order lines, and order totals over the lines
  // (read through a plain clone, as read models do not nest).
  const commercial = (
    kind: keyof typeof COMMERCIAL_READ_MODEL_BINDINGS,
    query: Record<string, unknown>,
    dependencyQueries: Record<string, string>,
    outputs: readonly string[] = COMMERCIAL_READ_MODEL_OUTPUTS[kind],
  ) => ({
    ...query,
    readModel: {
      capability: ref(
        'capabilityReference',
        'northstar.sales:capability.commercial',
      ),
      binding: COMMERCIAL_READ_MODEL_BINDINGS[kind],
      queries: Object.fromEntries(
        Object.entries(dependencyQueries).map(([key, value]) => [
          key,
          ref('queryReference', `${namespace}:query.${value}`),
        ]),
      ),
      resultFields: Object.fromEntries(
        outputs.map((key) => [key, `${namespace}:metric.${key}`]),
      ),
    },
  });
  const commercialLines = clone('sales_order_line_list', 'commercial_lines');
  const pricedLines = commercial(
    'line',
    clone('sales_order_line_list', 'commercial_order_lines'),
    {},
  );
  const orderTotals = commercial(
    'order',
    clone('sales_order_get', 'commercial_order_get'),
    {
      lines: 'commercial_lines',
      shipped: 'sales_order_shipped_get',
      invoices: 'customer_invoice_list',
      invoiceLines: 'customer_invoice_line_list',
    },
  );
  // A purchase order's priced lines and totals, the same figures read the
  // same way, when the application composes purchasing with its terms.
  const purchasing = queries.some(
    (query) => query.queryId === `${namespace}:query.purchase_order_get`,
  );
  // With payables composed, the order also states what is received and not
  // yet on a live bill, so "Bill received quantities" is offered only when a
  // post would bill something (PAYABLES).
  const payables = queries.some(
    (query) => query.queryId === `${namespace}:query.vendor_bill_get`,
  );
  const purchaseCommercial = purchasing
    ? [
        clone('purchase_order_line_list', 'commercial_purchase_lines'),
        commercial(
          'purchaseLine',
          clone('purchase_order_line_list', 'commercial_purchase_order_lines'),
          {
            received: 'purchase_order_received_get',
            ...(payables
              ? {
                  billLines: 'vendor_bill_line_list',
                  bills: 'vendor_bill_list',
                  bill: 'vendor_bill_get',
                }
              : {}),
          },
          payables
            ? [
                ...COMMERCIAL_READ_MODEL_OUTPUTS.purchaseLine,
                ...PAYABLES_READ_MODEL_OUTPUTS.purchaseLine,
              ]
            : COMMERCIAL_READ_MODEL_OUTPUTS.purchaseLine,
        ),
        commercial(
          'purchaseOrder',
          clone('purchase_order_get', 'commercial_purchase_order_get'),
          {
            lines: 'commercial_purchase_lines',
            ...(payables
              ? {
                  received: 'purchase_order_received_get',
                  bills: 'vendor_bill_list',
                  billLines: 'vendor_bill_line_list',
                }
              : {}),
          },
          payables
            ? [
                ...COMMERCIAL_READ_MODEL_OUTPUTS.purchaseOrder,
                ...PAYABLES_READ_MODEL_OUTPUTS.purchaseOrder,
              ]
            : COMMERCIAL_READ_MODEL_OUTPUTS.purchaseOrder,
        ),
        // The Purchase orders List reads its orders with their totals
        // (ORDER-PARITY): the same figures, stated for each paged row.
        commercial(
          'purchaseOrder',
          clone('purchase_order_list', 'commercial_purchase_order_list'),
          { lines: 'commercial_purchase_lines' },
        ),
      ]
    : [];
  const dependencies = {
    reservations: 'workspace_reservations',
    balances: 'reservation_balance_get',
    shipped: 'sales_order_shipped_get',
    stockReservations: 'workspace_stock_reservations',
    stock: 'workspace_stock',
  };
  const fulfillment = (
    name: keyof typeof FULFILLMENT_READ_MODEL_BINDINGS,
    outputs: readonly string[],
    queriesByKey: Record<string, string>,
  ) => ({
    capability: ref(
      'capabilityReference',
      'northstar.sales:capability.fulfillment',
    ),
    binding: FULFILLMENT_READ_MODEL_BINDINGS[name],
    queries: Object.fromEntries(
      Object.entries(queriesByKey).map(([key, value]) => [
        key,
        ref('queryReference', `${namespace}:query.${value}`),
      ]),
    ),
    resultFields: Object.fromEntries(
      outputs.map((key) => [key, `${namespace}:metric.${key}`]),
    ),
  });
  // The order page's Fulfillment lines: the same line figures, and what each
  // line is short, allocated over the order's lines (ORDER-PARITY). Its own
  // query, so no other reader of the lines pays for the stock reads.
  // RETURNS (ruling D): what each line has had returned, and a return's
  // lines with what each still adds, read from the posted movements under
  // current policy -- declared only where the application composes returns
  // with the movement ledger.
  const returns =
    queries.some(
      (query) =>
        query.queryId === `${namespace}:query.customer_return_line_list`,
    ) &&
    queries.some(
      (query) => query.queryId === `${namespace}:query.inventory_movement_list`,
    );
  const returnDependencies = returns
    ? {
        returnLines: 'customer_return_line_list',
        movements: 'inventory_movement_list',
      }
    : {};
  const fulfillmentLines = {
    ...clone('sales_order_line_list', 'fulfillment_order_lines'),
    readModel: fulfillment(
      'line',
      [
        'coverage',
        'shipped',
        'open_to_ship',
        'available_now',
        'short',
        ...(returns ? RETURN_LINE_OUTPUTS : []),
      ],
      {
        ...dependencies,
        ...returnDependencies,
        orderLines: 'commercial_lines',
        order: 'sales_order_get',
      },
    ),
  };
  const returnLines = returns
    ? [
        {
          ...clone('customer_return_line_list', 'fulfillment_return_lines'),
          readModel: fulfillment(
            'returnLine',
            RETURN_REVERSAL_OUTPUTS,
            returnDependencies,
          ),
        },
      ]
    : [];
  return [
    ...queries.map((query) => {
      const name =
        query.queryId === `${namespace}:query.sales_order_line_list`
          ? 'line'
          : query.queryId === `${namespace}:query.reservation_list`
            ? 'reservation'
            : null;
      if (!name) return query;
      const outputs =
        name === 'line'
          ? ['coverage', 'shipped', 'open_to_ship']
          : ['remaining', 'on_hand', 'reserved', 'available'];
      return {
        ...query,
        readModel: fulfillment(name, outputs, dependencies),
      };
    }),
    plain,
    stockReservations,
    stock,
    commercialLines,
    pricedLines,
    orderTotals,
    ...purchaseCommercial,
    fulfillmentLines,
    ...returnLines,
  ];
}

/**
 * An invoice (owner ruling C): its frozen figures and balance, its lines, and
 * the payments and credits against it. A payment or a credit posts only up to
 * the balance; Void is offered only while nothing is settled.
 */
export function invoiceWorkspace(namespace: string): Record<string, unknown> {
  const id = (type: string, name: string) => `${namespace}:${type}.${name}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const q = (name: string) => ref('queryReference', id('query', name));
  const field = (name: string) => id('field', name);
  const column = (
    name: string,
    label: string,
    orderKey: number,
    value: string,
    lookup?: readonly [string, string],
  ) => ({
    columnId: id('column', `invoice_${name}`),
    label,
    orderKey,
    field: value,
    ...(lookup
      ? {
          reference: {
            query: q(lookup[0]),
            labelField: ref('fieldReference', field(lookup[1])),
          },
        }
      : {}),
  });
  const money = <T extends object>(value: T) => ({
    ...value,
    format: 'money' as const,
  });
  const record = (name: string) => ({ source: 'record', field: name });
  const literal = (value: string | null) => ({ source: 'literal', value });
  const generated = (value: string) => ({ source: 'generated', value });
  const input = (name: string) => ({
    source: 'input',
    inputId: id('input', `invoice_${name}`),
  });
  const bind = (path: string[], value: unknown) => ({ path, value });
  const step = (name: string, operation: string, bindings: unknown[]) => ({
    stepId: id('step', `invoice_${name}`),
    operation: ref('operationReference', id('operation', operation)),
    bindings,
  });
  const settle = (
    kind: 'payment' | 'credit',
    values: Record<string, unknown>,
  ) => [
    step(`${kind}_draft`, `customer_${kind}_create`, [
      bind(['recordId'], generated('uuid')),
      bind(['legalEntityId'], generated('scope')),
      ...Object.entries(values).map(([key, value]) =>
        bind(['values', field(`customer_${kind}_${key}`)], value),
      ),
      bind(
        ['relations', id('relation', `customer_${kind}_invoice`)],
        record('recordId'),
      ),
    ]),
    step(`${kind}_commit`, `customer_${kind}_post`, [
      bind(['recordId'], {
        source: 'step',
        stepId: id('step', `invoice_${kind}_draft`),
        field: 'recordId',
      }),
      bind(['expectedRevision'], {
        source: 'step',
        stepId: id('step', `invoice_${kind}_draft`),
        field: 'revision',
      }),
    ]),
  ];
  const state = field('customer_invoice_state');
  const inState = (...states: string[]) =>
    states.length === 1
      ? [
          {
            value: record(state),
            operator: 'equals',
            compare: id('option', `customer_invoice_state_${states[0]!}`),
          },
        ]
      : // Neither of the states the task does not apply to.
        (['draft', 'open', 'partially_paid', 'paid', 'void'] as const)
          .filter((value) => !states.includes(value))
          .map((value) => ({
            value: record(state),
            operator: 'notEquals',
            compare: id('option', `customer_invoice_state_${value}`),
          }));
  const amount = (label: string) => ({
    inputId: id('input', 'invoice_amount'),
    label,
    orderKey: 10,
    type: 'quantity',
    required: true,
  });
  const lines = id('dataset', 'invoice_lines');
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: id('column', 'invoice_number'),
        subtitle: [id('column', 'invoice_customer')],
        status: id('column', 'invoice_state'),
        facts: [
          id('column', 'invoice_order'),
          id('column', 'invoice_date'),
          id('column', 'invoice_due'),
          id('column', 'invoice_currency'),
          id('column', 'invoice_total'),
          id('column', 'invoice_balance'),
        ],
      },
      context: {
        label: 'Balance',
        description:
          'Record a payment or a credit against this invoice’s balance.',
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
      task: { mode: 'nativeDialog', fallback: 'page' },
      // Owner ruling G: the printable invoice, saved as PDF by the browser.
      print: {
        label: 'Invoice',
        datasets: [lines],
        totals: [
          id('column', 'invoice_subtotal'),
          id('column', 'invoice_charges'),
          id('column', 'invoice_tax'),
          id('column', 'invoice_total'),
          id('column', 'invoice_paid'),
          id('column', 'invoice_credited'),
          id('column', 'invoice_balance'),
        ],
      },
    },
    fields: [
      column('number', 'Invoice', 10, field('customer_invoice_number')),
      column('state', 'Invoice state', 15, state),
      column(
        'customer',
        'Customer',
        20,
        field('customer_invoice_customer_party_id'),
        ['party_get', 'party_name'],
      ),
      column(
        'date',
        'Invoice date',
        25,
        field('customer_invoice_invoice_date'),
      ),
      column('due', 'Due date', 30, field('customer_invoice_due_date')),
      // The order this invoice bills (ORDER-PARITY): the invoice stores it as
      // a relation, stated by its get and labelled through the order's own
      // get under current policy -- "—" when that read is withheld.
      column(
        'order',
        'Sales order',
        32,
        id('relation', 'customer_invoice_order'),
        ['sales_order_get', 'sales_order_number'],
      ),
      column('currency', 'Currency', 35, field('customer_invoice_currency')),
      column(
        'terms',
        'Payment terms',
        40,
        field('customer_invoice_payment_terms'),
      ),
      ...[
        column('subtotal', 'Subtotal', 50, field('customer_invoice_subtotal')),
        column('charges', 'Charges', 51, field('customer_invoice_charges')),
        column('tax', 'Tax', 52, field('customer_invoice_tax')),
        column('total', 'Total', 53, field('customer_invoice_total')),
        column('paid', 'Paid', 54, field('customer_invoice_paid_amount')),
        column(
          'credited',
          'Credited',
          55,
          field('customer_invoice_credited_amount'),
        ),
        column('balance', 'Balance', 56, field('customer_invoice_balance')),
      ].map(money),
    ],
    children: [
      {
        datasetId: lines,
        presentation: { selection: 'none' },
        label: 'Invoice lines',
        orderKey: 10,
        query: q('customer_invoice_line_list'),
        sort: [
          {
            fieldId: field('customer_invoice_line_line_number'),
            direction: 'ascending',
          },
        ],
        parent: {
          relationId: id('relation', 'customer_invoice_line_invoice'),
          value: record('recordId'),
          ownership: 'parentScopedChild',
        },
        columns: [
          column(
            'line',
            'Line',
            10,
            field('customer_invoice_line_line_number'),
          ),
          column('item', 'Item', 20, field('customer_invoice_line_item_id'), [
            'item_get',
            'item_name',
          ]),
          column(
            'quantity',
            'Quantity',
            30,
            field('customer_invoice_line_quantity'),
          ),
          column('unit', 'Unit', 40, field('customer_invoice_line_unit_id')),
          money(
            column(
              'unit_price',
              'Unit price',
              50,
              field('customer_invoice_line_unit_price'),
            ),
          ),
          column(
            'discount',
            'Discount %',
            60,
            field('customer_invoice_line_discount_percent'),
          ),
          column(
            'tax_rate',
            'Tax rate %',
            70,
            field('customer_invoice_line_tax_rate_percent'),
          ),
          money(
            column(
              'amount',
              'Amount',
              80,
              field('customer_invoice_line_amount'),
            ),
          ),
          money(
            column('line_tax', 'Tax', 90, field('customer_invoice_line_tax')),
          ),
        ],
      },
      ...(['payment', 'credit'] as const).map((kind, index) => ({
        datasetId: id('dataset', `invoice_${kind}s`),
        presentation: { selection: 'none', compact: 'scrollTable' },
        label: kind === 'payment' ? 'Payments' : 'Credits',
        orderKey: 20 + index * 10,
        query: q(`customer_${kind}_list`),
        parent: {
          relationId: id('relation', `customer_${kind}_invoice`),
          value: record('recordId'),
          ownership: 'reference',
        },
        columns: [
          column(
            `${kind}_number`,
            kind === 'payment' ? 'Payment' : 'Credit',
            10,
            field(`customer_${kind}_number`),
          ),
          column(`${kind}_state`, 'State', 20, field(`customer_${kind}_state`)),
          column(
            `${kind}_date`,
            'Date',
            30,
            field(
              kind === 'payment'
                ? 'customer_payment_payment_date'
                : 'customer_credit_credit_date',
            ),
          ),
          money(
            column(
              `${kind}_amount`,
              'Amount',
              40,
              field(`customer_${kind}_amount`),
            ),
          ),
          ...(kind === 'payment'
            ? [
                column(
                  'payment_method',
                  'Method',
                  50,
                  field('customer_payment_method'),
                ),
                column(
                  'payment_reference',
                  'Reference',
                  60,
                  field('customer_payment_reference'),
                ),
              ]
            : [
                column(
                  'credit_reason',
                  'Reason',
                  50,
                  field('customer_credit_reason'),
                ),
              ]),
        ],
      })),
    ],
    actions: [
      {
        actionId: id('action', 'invoice_record_payment'),
        label: 'Record payment',
        description:
          'Records a payment received against this invoice. It may not exceed the balance.',
        orderKey: 10,
        conditions: inState('open', 'partially_paid'),
        inputs: [
          amount('Amount received'),
          {
            inputId: id('input', 'invoice_method'),
            label: 'Method',
            orderKey: 20,
            type: 'text',
            required: true,
            presentation: {
              kind: 'choice',
              options: (
                [
                  ['cash', 'Cash'],
                  ['cheque', 'Cheque'],
                  ['eft', 'EFT'],
                  ['card', 'Card'],
                  ['other', 'Other'],
                ] as const
              ).map(([value, label]) => ({
                value: id('option', `customer_payment_method_${value}`),
                label,
              })),
              defaultValue: id('option', 'customer_payment_method_eft'),
            },
          },
          {
            inputId: id('input', 'invoice_reference'),
            label: 'Reference (cheque or transaction number)',
            orderKey: 30,
            type: 'text',
            required: true,
          },
        ],
        steps: settle('payment', {
          // The payment number is assigned on create (PAY-000001).
          state: literal(id('option', 'customer_payment_state_draft')),
          payment_date: generated('instant'),
          amount: input('amount'),
          method: input('method'),
          reference: input('reference'),
        }),
      },
      {
        actionId: id('action', 'invoice_issue_credit'),
        label: 'Issue credit',
        description:
          'Credits part or all of this invoice’s balance, such as for a return or a price correction.',
        orderKey: 20,
        conditions: inState('open', 'partially_paid'),
        inputs: [
          amount('Amount credited'),
          {
            inputId: id('input', 'invoice_reason'),
            label: 'Reason',
            orderKey: 20,
            type: 'text',
            required: true,
            presentation: { kind: 'multiline' },
          },
        ],
        steps: settle('credit', {
          // The credit number is assigned on create (CM-000001).
          state: literal(id('option', 'customer_credit_state_draft')),
          credit_date: generated('instant'),
          amount: input('amount'),
          reason: input('reason'),
        }),
      },
      {
        actionId: id('action', 'invoice_void'),
        label: 'Void invoice',
        description:
          'Voids this invoice while nothing is paid or credited on it; its quantities can be invoiced again.',
        orderKey: 30,
        conditions: inState('open'),
        inputs: [],
        steps: [
          step('void', 'customer_invoice_void', [
            bind(['recordId'], record('recordId')),
            bind(['expectedRevision'], record('revision')),
          ]),
        ],
      },
      {
        // The way back to the order from wherever the invoice was opened.
        actionId: id('action', 'invoice_open_order'),
        label: 'Open sales order',
        description: 'Open the sales order this invoice bills.',
        orderKey: 40,
        conditions: [],
        inputs: [],
        steps: [],
        navigate: {
          surface: ref('surfaceReference', id('surface', 'sales_order_detail')),
          query: q('commercial_order_get'),
          record: record(id('relation', 'customer_invoice_order')),
        },
      },
    ],
  };
}

export function packingWorkspace(namespace: string): Record<string, unknown> {
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const column = (
    name: string,
    label: string,
    orderKey: number,
    field: string,
    lookup?: readonly [string, string],
  ) => ({
    columnId: `${namespace}:column.packing_${name}`,
    label,
    orderKey,
    field: `${namespace}:field.${field}`,
    ...(lookup
      ? {
          reference: {
            query: ref('queryReference', `${namespace}:query.${lookup[0]}`),
            labelField: ref(
              'fieldReference',
              `${namespace}:field.${lookup[1]}`,
            ),
          },
        }
      : {}),
  });
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: `${namespace}:column.packing_number`,
        subtitle: [`${namespace}:column.packing_location`],
        facts: [
          `${namespace}:column.packing_order`,
          `${namespace}:column.packing_date`,
        ],
        status: `${namespace}:column.packing_state`,
      },
      // The address the shipment went to, as one block.
      blocks: [
        {
          label: 'Ship to',
          columns: SHIP_TO_LINES.map(
            ([name]) => `${namespace}:column.packing_${name}`,
          ),
        },
      ],
      recordActions: 'progressive',
      technicalDetails: 'progressive',
    },
    fields: [
      column('number', 'Packing document', 10, 'shipment_number'),
      column('location', 'Ship-from location', 20, 'shipment_location_id', [
        'location_get',
        'location_name',
      ]),
      // The order this shipment fulfils (ORDER-PARITY): the relation stated by
      // the shipment's get, labelled through the order's own get.
      {
        ...column('order', 'Sales order', 25, 'shipment_order', [
          'sales_order_get',
          'sales_order_number',
        ]),
        field: `${namespace}:relation.shipment_order`,
      },
      column('date', 'Shipped at', 30, 'shipment_effective_at'),
      column('state', 'Shipment state', 40, 'shipment_state'),
      column('carrier', 'Carrier', 50, 'shipment_carrier'),
      column(
        'shipping_reference',
        'Tracking or BOL',
        60,
        'shipment_shipping_reference',
      ),
      ...SHIP_TO_LINES.map(([name, label], index) =>
        column(name, label, 70 + index, `shipment_${name}`),
      ),
    ],
    children: [
      {
        datasetId: `${namespace}:dataset.packing_lines`,
        label: 'Packed lines',
        presentation: { selection: 'none', compact: 'scrollTable' },
        orderKey: 10,
        query: ref('queryReference', `${namespace}:query.shipment_line_list`),
        parent: {
          relationId: `${namespace}:relation.shipment_line_shipment`,
          ownership: 'parentScopedChild',
          value: { source: 'record', field: 'recordId' },
        },
        columns: [
          column('line', 'Line', 10, 'shipment_line_line_number'),
          column('item', 'Item', 20, 'shipment_line_item_id', [
            'item_get',
            'item_name',
          ]),
          column('quantity', 'Quantity', 30, 'shipment_line_quantity'),
          column('unit', 'Unit', 40, 'shipment_line_unit_id'),
        ].map((value) => ({
          ...value,
          presentation: {
            role:
              value.columnId === `${namespace}:column.packing_item`
                ? 'primary'
                : value.columnId === `${namespace}:column.packing_quantity`
                  ? 'quantity'
                  : 'secondary',
            priority: value.orderKey,
          },
        })),
      },
    ],
    actions: [],
  };
}

/**
 * A customer return (ruling D), as its own document: the order it came back
 * against, where it went, why, and its lines. Reversal is offered on the
 * order's page, where the return's lines state what they still add.
 */
export function returnWorkspace(namespace: string): Record<string, unknown> {
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const column = (
    name: string,
    label: string,
    orderKey: number,
    field: string,
    lookup?: readonly [string, string],
  ) => ({
    columnId: `${namespace}:column.customer_return_${name}`,
    label,
    orderKey,
    field: `${namespace}:field.${field}`,
    ...(lookup
      ? {
          reference: {
            query: ref('queryReference', `${namespace}:query.${lookup[0]}`),
            labelField: ref(
              'fieldReference',
              `${namespace}:field.${lookup[1]}`,
            ),
          },
        }
      : {}),
  });
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: `${namespace}:column.customer_return_number`,
        subtitle: [`${namespace}:column.customer_return_location`],
        facts: [
          `${namespace}:column.customer_return_order`,
          `${namespace}:column.customer_return_date`,
          `${namespace}:column.customer_return_kind`,
          `${namespace}:column.customer_return_reason`,
        ],
        status: `${namespace}:column.customer_return_state`,
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
    },
    fields: [
      column('number', 'Return', 10, 'customer_return_number'),
      column('location', 'Returned into', 20, 'customer_return_location_id', [
        'location_get',
        'location_name',
      ]),
      // The order this return came back against: the relation stated by the
      // return's get, labelled through the order's own get.
      {
        ...column('order', 'Sales order', 25, 'customer_return_order', [
          'sales_order_get',
          'sales_order_number',
        ]),
        field: `${namespace}:relation.customer_return_order`,
      },
      column('date', 'Returned at', 30, 'customer_return_effective_at'),
      column('kind', 'Kind', 35, 'customer_return_kind'),
      column('state', 'Return state', 40, 'customer_return_state'),
      column('reason', 'Reason', 50, 'customer_return_reason_code'),
      column('notes', 'Notes', 60, 'customer_return_reason_narrative'),
    ],
    children: [
      {
        datasetId: `${namespace}:dataset.customer_return_lines`,
        label: 'Returned lines',
        presentation: { selection: 'none', compact: 'scrollTable' },
        orderKey: 10,
        query: ref(
          'queryReference',
          `${namespace}:query.customer_return_line_list`,
        ),
        parent: {
          relationId: `${namespace}:relation.customer_return_line_return`,
          ownership: 'parentScopedChild',
          value: { source: 'record', field: 'recordId' },
        },
        columns: [
          column('line', 'Line', 10, 'customer_return_line_line_number'),
          column('item', 'Item', 20, 'customer_return_line_item_id', [
            'item_get',
            'item_name',
          ]),
          column('quantity', 'Quantity', 30, 'customer_return_line_quantity'),
          column('unit', 'Unit', 40, 'customer_return_line_unit_id'),
        ].map((value) => ({
          ...value,
          presentation: {
            role:
              value.columnId === `${namespace}:column.customer_return_item`
                ? 'primary'
                : value.columnId ===
                    `${namespace}:column.customer_return_quantity`
                  ? 'quantity'
                  : 'secondary',
            priority: value.orderKey,
          },
        })),
      },
    ],
    actions: [],
  };
}
