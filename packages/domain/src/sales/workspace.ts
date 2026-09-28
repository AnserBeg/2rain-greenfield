export const FULFILLMENT_READ_MODEL_BINDINGS = Object.freeze({
  line: 'northstar.sales:read_model.line',
  reservation: 'northstar.sales:read_model.reservation',
});
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
  const lines = id('dataset', 'fulfillment_lines');
  const reservations = id('dataset', 'line_reservations');
  const shipments = id('dataset', 'order_shipments');
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
        datasets: [lines],
        note: id('column', 'notes'),
      },
      // The ship-to lines read as one address, on screen and when printed.
      blocks: [
        {
          label: 'Ship to',
          columns: SHIP_TO_LINES.map(([name]) => id('column', name)),
        },
      ],
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
    ],
    children: [
      {
        datasetId: lines,
        presentation: { selection: 'explicit', selectedActions: 'row' },
        label: 'Order lines',
        orderKey: 10,
        query: q('sales_order_line_list'),
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
            column(
              'unit_price',
              'Unit price',
              45,
              field('sales_order_line_unit_price'),
            ),
            column('coverage', 'Reserved', 50, id('metric', 'coverage')),
            column('shipped', 'Shipped', 60, id('metric', 'shipped')),
            column('open', 'Open to ship', 70, id('metric', 'open_to_ship')),
          ],
          'item',
          ['sku', 'unit', 'unit_price'],
          ['ordered', 'coverage', 'shipped', 'open'],
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
  const dependencies = {
    reservations: 'workspace_reservations',
    balances: 'reservation_balance_get',
    shipped: 'sales_order_shipped_get',
    stockReservations: 'workspace_stock_reservations',
    stock: 'workspace_stock',
  };
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
        readModel: {
          capability: ref(
            'capabilityReference',
            'northstar.sales:capability.fulfillment',
          ),
          binding: FULFILLMENT_READ_MODEL_BINDINGS[name],
          queries: Object.fromEntries(
            Object.entries(dependencies).map(([key, value]) => [
              key,
              ref('queryReference', `${namespace}:query.${value}`),
            ]),
          ),
          resultFields: Object.fromEntries(
            outputs.map((key) => [key, `${namespace}:metric.${key}`]),
          ),
        },
      };
    }),
    plain,
    stockReservations,
    stock,
  ];
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
        facts: [`${namespace}:column.packing_date`],
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
