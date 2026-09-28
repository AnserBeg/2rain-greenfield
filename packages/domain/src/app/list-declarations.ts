/**
 * Declared Lists for the composed application: which columns, saved views,
 * filters, order and export each List offers. This is application content in
 * the canonical `surface.list` vocabulary; the shared List runtime has no
 * knowledge of any of these surfaces.
 */
const version = 'v6';

type Role = 'title' | 'value' | 'status';
type StatusRole = 'success' | 'attention' | 'blocked' | 'inProgress';

export interface ListColumnSpec {
  readonly local: string;
  readonly label: string;
  readonly field: string;
  readonly role?: Role;
  readonly sortable?: boolean;
  readonly format?: 'date';
  readonly reference?: { readonly query: string; readonly labelField: string };
  readonly statusRoles?: Readonly<Record<string, StatusRole>>;
}

export interface ListSpec {
  readonly pageSize: number;
  readonly columns: readonly ListColumnSpec[];
  readonly defaultSort: readonly {
    readonly column: string;
    readonly direction: 'ascending' | 'descending';
  }[];
  readonly views: readonly {
    readonly local: string;
    readonly label: string;
    readonly filters: Readonly<Record<string, string>>;
  }[];
  readonly filters: readonly {
    readonly local: string;
    readonly label: string;
    readonly field: string;
    readonly options: readonly (readonly [value: string, label: string])[];
  }[];
  readonly export: boolean;
}

const CURRENCIES = [
  ['CAD', 'CAD'],
  ['USD', 'USD'],
  ['EUR', 'EUR'],
] as const;

function documentList(
  namespace: string,
  document: 'sales_order' | 'purchase_order',
  counterparty: { field: string; label: string },
  dateColumns: readonly { field: string; label: string }[],
  /** Further parties named on the document, such as the salesperson. */
  namedParties: readonly { field: string; label: string }[] = [],
): ListSpec {
  const field = (local: string) => `${namespace}:field.${document}_${local}`;
  const state = (local: string) => `${namespace}:state.${document}_${local}`;
  const lifecycle = `${namespace}:derived_state_field.machine.${document}_lifecycle`;
  return {
    pageSize: 50,
    columns: [
      {
        local: 'number',
        label: 'Number',
        field: field('number'),
        role: 'title',
      },
      {
        local: 'counterparty',
        label: counterparty.label,
        field: field(counterparty.field),
        reference: {
          query: `${namespace}:query.party_list`,
          labelField: `${namespace}:field.party_name`,
        },
      },
      ...namedParties.map((party) => ({
        local: party.field,
        label: party.label,
        field: field(party.field),
        reference: {
          query: `${namespace}:query.party_list`,
          labelField: `${namespace}:field.party_name`,
        },
      })),
      ...dateColumns.map((column) => ({
        local: column.field,
        label: column.label,
        field: field(column.field),
        format: 'date' as const,
      })),
      {
        local: 'status',
        label: 'Status',
        field: lifecycle,
        role: 'status' as const,
        statusRoles: {
          [state('released')]: 'inProgress' as const,
          [state('closed')]: 'success' as const,
        },
      },
      { local: 'currency', label: 'Currency', field: field('currency') },
    ],
    defaultSort: [{ column: 'order_date', direction: 'descending' }],
    views: [
      { local: 'all', label: 'All', filters: {} },
      ...(
        [
          ['draft', 'Draft'],
          ['released', 'Released'],
          ['closed', 'Closed'],
          ['cancelled', 'Cancelled'],
        ] as const
      ).map(([local, label]) => ({
        local,
        label,
        filters: { [lifecycle]: state(local) },
      })),
    ],
    filters: [
      {
        local: 'currency',
        label: 'Currency',
        field: field('currency'),
        options: CURRENCIES,
      },
    ],
    export: true,
  };
}

/** The declared Lists of the composed application, by List surface local id. */
export function composedListSpecs(
  namespace: string,
): Readonly<Record<string, ListSpec>> {
  const item = (labelField: string) => ({
    query: `${namespace}:query.item_list`,
    labelField: `${namespace}:field.${labelField}`,
  });
  return {
    sales_order_list: documentList(
      namespace,
      'sales_order',
      { field: 'customer_party_id', label: 'Customer' },
      [
        { field: 'order_date', label: 'Order date' },
        { field: 'requested_date', label: 'Requested' },
      ],
      [{ field: 'salesperson_party_id', label: 'Salesperson' }],
    ),
    purchase_order_list: documentList(
      namespace,
      'purchase_order',
      { field: 'supplier_party_id', label: 'Supplier' },
      [
        { field: 'order_date', label: 'Order date' },
        { field: 'expected_date', label: 'Expected' },
      ],
    ),
    // A balance, not a document: no lifecycle, so no saved views; item and
    // location are named through their own lists rather than shown as ids.
    posted_stock_balance_list: {
      pageSize: 50,
      columns: [
        {
          local: 'sku',
          label: 'SKU',
          field: `${namespace}:field.posted_stock_balance_item_id`,
          role: 'title',
          reference: item('item_sku'),
        },
        {
          local: 'item',
          label: 'Item',
          field: `${namespace}:field.posted_stock_balance_item_id`,
          reference: item('item_name'),
        },
        {
          local: 'location',
          label: 'Location',
          field: `${namespace}:field.posted_stock_balance_location_id`,
          reference: {
            query: `${namespace}:query.location_list`,
            labelField: `${namespace}:field.location_code`,
          },
        },
        {
          local: 'on_hand',
          label: 'On hand',
          field: `${namespace}:field.posted_stock_balance_posted_quantity`,
        },
        {
          local: 'unit',
          label: 'Unit',
          field: `${namespace}:field.posted_stock_balance_unit_id`,
          sortable: false,
        },
      ],
      defaultSort: [{ column: 'sku', direction: 'ascending' }],
      views: [],
      filters: [],
      export: true,
    },
  };
}

function lowerList(namespace: string, listLocal: string, spec: ListSpec) {
  const id = (kind: string, local: string) =>
    `${namespace}:${kind}.${listLocal}_${local}`;
  return {
    kind: 'surfaceList',
    schemaVersion: version,
    pageSize: spec.pageSize,
    columns: spec.columns.map((column, index) => ({
      columnId: id('list_column', column.local),
      label: column.label,
      orderKey: (index + 1) * 10,
      field: column.field,
      role: column.role ?? 'value',
      priority: index,
      sortable: column.sortable ?? true,
      ...(column.format ? { format: column.format } : {}),
      ...(column.reference
        ? {
            reference: {
              query: {
                kind: 'queryReference',
                schemaVersion: version,
                targetId: column.reference.query,
              },
              labelField: {
                kind: 'fieldReference',
                schemaVersion: version,
                targetId: column.reference.labelField,
              },
            },
          }
        : {}),
      ...(column.statusRoles
        ? {
            statusRoles: Object.entries(column.statusRoles).map(
              ([value, role]) => ({ value, role }),
            ),
          }
        : {}),
    })),
    defaultSort: spec.defaultSort.map((sort) => ({
      columnId: id('list_column', sort.column),
      direction: sort.direction,
    })),
    views: spec.views.map((view, index) => ({
      viewId: id('list_view', view.local),
      label: view.label,
      orderKey: (index + 1) * 10,
      filters: Object.entries(view.filters).map(([field, value]) => ({
        field,
        value,
      })),
    })),
    filters: spec.filters.map((filter, index) => ({
      filterId: id('list_filter', filter.local),
      label: filter.label,
      orderKey: (index + 1) * 10,
      field: filter.field,
      options: filter.options.map(([value, label]) => ({ value, label })),
    })),
    ...(spec.export ? { export: { format: 'csv' } } : {}),
  };
}

/**
 * Adds each declared List to its surface, with the savedViews slot when it
 * declares views. Export limits belong to the queries, which their modules
 * declare; this pass changes surfaces only.
 */
export function declareLists(
  namespace: string,
  surfaces: Record<string, unknown>[],
  specs: Readonly<Record<string, ListSpec>> = composedListSpecs(namespace),
): Record<string, unknown>[] {
  return surfaces.map((surface) => {
    const local = String(surface.surfaceId).split(':surface.')[1] ?? '';
    const spec = specs[local];
    if (!spec) return surface;
    const slots = surface.slots as Record<string, unknown>[];
    return {
      ...surface,
      list: lowerList(namespace, local, spec),
      slots:
        spec.views.length > 0 &&
        !slots.some((slot) => slot.slot === 'savedViews')
          ? [
              ...slots,
              {
                kind: 'surfaceSlot',
                schemaVersion: version,
                slot: 'savedViews',
                slotId: `${namespace}:slot.${local}_saved_views`,
                orderKey: 15,
                content: {
                  kind: 'opaqueSurfaceContentReference',
                  schemaVersion: version,
                  targetId: `${namespace}:capability.standard_surface_content`,
                },
              },
            ]
          : slots,
    };
  });
}
