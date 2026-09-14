export const FULFILLMENT_READ_MODEL_BINDINGS = Object.freeze({
  line: 'northstar.sales:read_model.line',
  reservation: 'northstar.sales:read_model.reservation',
});
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
      column(
        'requested_date',
        'Requested date',
        30,
        field('sales_order_requested_date'),
      ),
    ],
    children: [
      {
        datasetId: lines,
        label: 'Order lines',
        orderKey: 10,
        query: q('sales_order_line_list'),
        parent: {
          relationId: id('relation', 'sales_order_line_order'),
          value: record('recordId'),
          ownership: 'parentScopedChild',
        },
        columns: [
          column('line', 'Line', 10, field('sales_order_line_line_number')),
          column('item', 'Item', 20, field('sales_order_line_item_id'), [
            'item_get',
            'item_name',
          ]),
          column(
            'ordered',
            'Ordered',
            30,
            field('sales_order_line_ordered_quantity'),
          ),
          column('unit', 'Unit', 40, field('sales_order_line_unit_id')),
          column('coverage', 'Reserved', 50, id('metric', 'coverage')),
          column('shipped', 'Shipped', 60, id('metric', 'shipped')),
          column('open', 'Open to ship', 70, id('metric', 'open_to_ship')),
        ],
      },
      {
        datasetId: reservations,
        label: 'Selected line reservations',
        orderKey: 20,
        query: q('reservation_list'),
        parent: {
          relationId: id('relation', 'reservation_order_line'),
          value: { ...selected('recordId'), datasetId: lines },
          ownership: 'reference',
        },
        columns: [
          column('reservation', 'Reservation', 10, field('reservation_number')),
          column('location', 'Location', 20, field('reservation_location_id'), [
            'location_get',
            'location_name',
          ]),
          column(
            'quantity',
            'Original quantity',
            30,
            field('reservation_quantity'),
          ),
          column('state', 'State', 40, field('reservation_state')),
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
      },
      {
        datasetId: shipments,
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
        ],
      },
    ],
    actions: [
      {
        actionId: id('action', 'reserve_stock'),
        label: 'Reserve stock',
        description:
          'Create a reservation and reserve this exact quantity. On hand stays unchanged; available stock decreases.',
        orderKey: 10,
        datasetId: lines,
        conditions: [released],
        inputs: [
          quantityInput,
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
        label: 'Ship reserved stock',
        description:
          'Create and post a partial shipment against the selected reservation. On hand and reserved stock decrease by the shipped quantity.',
        orderKey: 20,
        datasetId: reservations,
        conditions: [released, active],
        inputs: [quantityInput],
        steps: [
          create(
            'shipment_draft',
            'shipment',
            {
              number: generated('uuid'),
              state: literal(id('option', 'shipment_state_draft')),
              kind: literal(id('option', 'shipment_kind_initial')),
              effective_at: generated('instant'),
              location_id: selected(field('reservation_location_id')),
              external_reference: literal(null),
              reason_code: literal('SHIP'),
              reason_narrative: literal('Ship reserved stock'),
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
        label: 'Release remainder',
        description:
          'Release the remaining reservation. On hand stays unchanged; the unused stock becomes available.',
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
    fields: [
      column('number', 'Packing document', 10, 'shipment_number'),
      column('location', 'Ship-from location', 20, 'shipment_location_id', [
        'location_get',
        'location_name',
      ]),
      column('date', 'Shipped at', 30, 'shipment_effective_at'),
    ],
    children: [
      {
        datasetId: `${namespace}:dataset.packing_lines`,
        label: 'Packed lines',
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
        ],
      },
    ],
    actions: [],
  };
}
