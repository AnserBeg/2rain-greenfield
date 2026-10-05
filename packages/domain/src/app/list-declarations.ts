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
  readonly format?: 'date' | 'money';
  readonly reference?: { readonly query: string; readonly labelField: string };
  readonly statusRoles?: Readonly<Record<string, StatusRole>>;
  /** The view (local id) whose rows this date marks "N days late". */
  readonly overdue?: string;
}

/** A list query whose rows are added up per List row, through one relation. */
interface ListProgressSourceSpec {
  readonly query: string;
  readonly relation: string;
  readonly quantity: string;
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
    /** Only rows the List's progress leaves something open on. */
    readonly open?: true;
    /** Only rows whose date in this field is before today (UTC). */
    readonly before?: string;
  }[];
  readonly filters: readonly {
    readonly local: string;
    readonly label: string;
    readonly field: string;
    readonly options: readonly (readonly [value: string, label: string])[];
  }[];
  readonly export: boolean;
  /**
   * Per row, what its lines order and their done rows record, summed by the
   * list statement; outputs are the ids the columns show them under.
   */
  readonly progress?: {
    readonly lines: ListProgressSourceSpec;
    readonly done: ListProgressSourceSpec;
    readonly openIn?: {
      readonly field: string;
      readonly values: readonly string[];
    };
    readonly outputs: {
      readonly ordered: string;
      readonly done: string;
      readonly open: string;
    };
    /**
     * `omit`: supplementary figures. A principal who may not read them still
     * gets the List, with the figures reading "—"; only a view that keeps
     * open rows is refused.
     */
    readonly whenDenied?: 'omit';
  };
  /**
   * Links from a row to its record page, at a named section of it. The first
   * whose condition holds is the row's, so an unconditional one comes last.
   */
  readonly rowActions?: readonly {
    readonly local: string;
    readonly label: string;
    readonly when?: {
      readonly filters?: Readonly<Record<string, string>>;
      /** Only while the row's progress leaves something open. */
      readonly open?: true;
    };
    /** A dataset of the record page's composition. */
    readonly section?: string;
  }[];
}

const CURRENCIES = [
  ['CAD', 'CAD'],
  ['USD', 'USD'],
  ['EUR', 'EUR'],
] as const;

/**
 * What a document List adds up per order (ORDER-PARITY): the units its active
 * lines order against what has been done with them -- shipped for a sales
 * order, received for a purchase order -- and the open remainder while the
 * order is released. The figures are supplementary (owner ruling, 2026-09-30):
 * without the reads they need the List still serves, with "—" in their place,
 * and only the views that keep open rows are refused.
 */
interface OrderWork {
  /** The list query of the document's lines the statement sums. */
  readonly linesQuery: string;
  readonly done: ListProgressSourceSpec & {
    readonly local: string;
    readonly label: string;
  };
  /** The worklist view: released with something open. */
  readonly openView: { readonly local: string; readonly label: string };
  /** A "Late" view over this date column, which then marks late rows. */
  readonly late?: string;
  /** The row's link while something is open, at a section of its page. */
  readonly action: {
    readonly local: string;
    readonly label: string;
    readonly section: string;
  };
  /** A read-model total, shown beside the currency and never sorted. */
  readonly total?: string;
}

function documentList(
  namespace: string,
  document: 'sales_order' | 'purchase_order',
  counterparty: { field: string; label: string },
  dateColumns: readonly { field: string; label: string }[],
  /** Further parties named on the document, such as the salesperson. */
  namedParties: readonly { field: string; label: string }[] = [],
  work?: OrderWork,
): ListSpec {
  const field = (local: string) => `${namespace}:field.${document}_${local}`;
  const state = (local: string) => `${namespace}:state.${document}_${local}`;
  const output = (local: string) =>
    `${namespace}:list_output.${document}_list_${local}`;
  const lifecycle = `${namespace}:derived_state_field.machine.${document}_lifecycle`;
  const released = { [lifecycle]: state('released') };
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
        // The rows the Late tab counts read "N days late" on this date.
        ...(work?.late === column.field ? { overdue: 'late' } : {}),
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
      // Summed in the list statement: shown and exported, never sorted.
      ...(work
        ? [
            {
              local: 'ordered',
              label: 'Ordered',
              field: output('ordered'),
              sortable: false,
            },
            {
              local: work.done.local,
              label: work.done.label,
              field: output(work.done.local),
              sortable: false,
            },
            {
              local: 'open',
              label: 'Open',
              field: output('open'),
              sortable: false,
            },
          ]
        : []),
      // Computed from the page's own rows: shown, never sorted or counted.
      ...(work?.total
        ? [
            {
              local: 'total',
              label: 'Total',
              field: work.total,
              format: 'money' as const,
              sortable: false,
            },
          ]
        : []),
      { local: 'currency', label: 'Currency', field: field('currency') },
    ],
    defaultSort: [{ column: 'order_date', direction: 'descending' }],
    views: [
      { local: 'all', label: 'All', filters: {} },
      // The worklist tabs lead, as the reference's "Open fulfillment" does.
      ...(work
        ? [
            {
              local: work.openView.local,
              label: work.openView.label,
              filters: released,
              open: true as const,
            },
            ...(work.late
              ? [
                  {
                    local: 'late',
                    label: 'Late',
                    filters: released,
                    open: true as const,
                    before: field(work.late),
                  },
                ]
              : []),
          ]
        : []),
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
    ...(work
      ? {
          progress: {
            lines: {
              query: `${namespace}:query.${work.linesQuery}`,
              relation: `${namespace}:relation.${document}_line_order`,
              quantity: field('line_ordered_quantity'),
            },
            done: {
              query: work.done.query,
              relation: work.done.relation,
              quantity: work.done.quantity,
            },
            openIn: { field: lifecycle, values: [state('released')] },
            outputs: {
              ordered: output('ordered'),
              done: output(work.done.local),
              open: output('open'),
            },
            whenDenied: 'omit' as const,
          },
          // A link to the order at the work, else to the order itself; the
          // page re-checks everything it offers there.
          rowActions: [
            {
              local: work.action.local,
              label: work.action.label,
              when: { filters: released, open: true as const },
              section: work.action.section,
            },
            { local: 'view', label: 'View' },
          ],
        }
      : {}),
  };
}

/**
 * A settlement document's List (receivables' invoices, payables' bills): each
 * document with its balance, the tabs its states, the counterparty named
 * through the party list.
 */
interface SettlementListSpec {
  /** The document entity's local id. */
  readonly document: string;
  readonly counterparty: {
    readonly local: string;
    readonly label: string;
    readonly field: string;
  };
  /** A further text column, such as the supplier's own invoice number. */
  readonly reference?: {
    readonly local: string;
    readonly label: string;
    readonly field: string;
  };
  readonly date: {
    readonly local: string;
    readonly label: string;
    readonly field: string;
  };
}

function settlementList(
  namespace: string,
  settlement: SettlementListSpec,
): ListSpec {
  const field = (local: string) =>
    `${namespace}:field.${settlement.document}_${local}`;
  const state = (local: string) =>
    `${namespace}:option.${settlement.document}_state_${local}`;
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
        local: settlement.counterparty.local,
        label: settlement.counterparty.label,
        field: field(settlement.counterparty.field),
        reference: {
          query: `${namespace}:query.party_list`,
          labelField: `${namespace}:field.party_name`,
        },
      },
      ...(settlement.reference
        ? [
            {
              local: settlement.reference.local,
              label: settlement.reference.label,
              field: field(settlement.reference.field),
            },
          ]
        : []),
      {
        local: settlement.date.local,
        label: settlement.date.label,
        field: field(settlement.date.field),
        format: 'date',
      },
      {
        local: 'due_date',
        label: 'Due',
        field: field('due_date'),
        format: 'date',
      },
      {
        local: 'status',
        label: 'Status',
        field: field('state'),
        role: 'status',
        statusRoles: {
          [state('open')]: 'inProgress',
          [state('partially_paid')]: 'attention',
          [state('paid')]: 'success',
        },
      },
      {
        local: 'total',
        label: 'Total',
        field: field('total'),
        format: 'money',
      },
      {
        local: 'balance',
        label: 'Balance',
        field: field('balance'),
        format: 'money',
      },
      { local: 'currency', label: 'Currency', field: field('currency') },
    ],
    defaultSort: [{ column: settlement.date.local, direction: 'descending' }],
    views: [
      { local: 'all', label: 'All', filters: {} },
      ...(
        [
          ['open', 'Open'],
          ['partially_paid', 'Partially paid'],
          ['paid', 'Paid'],
          ['void', 'Void'],
        ] as const
      ).map(([local, label]) => ({
        local,
        label,
        filters: { [field('state')]: state(local) },
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

/** Receivables' Invoices List (owner ruling C). */
export const INVOICE_LIST: SettlementListSpec = Object.freeze({
  document: 'customer_invoice',
  counterparty: {
    local: 'customer',
    label: 'Customer',
    field: 'customer_party_id',
  },
  date: { local: 'invoice_date', label: 'Invoice date', field: 'invoice_date' },
});

/** Payables' Bills List (PAYABLES), with the supplier's own invoice number. */
export const BILL_LIST: SettlementListSpec = Object.freeze({
  document: 'vendor_bill',
  counterparty: {
    local: 'vendor',
    label: 'Vendor',
    field: 'supplier_party_id',
  },
  reference: {
    local: 'supplier_invoice',
    label: 'Supplier invoice',
    field: 'supplier_invoice_number',
  },
  date: { local: 'bill_date', label: 'Bill date', field: 'bill_date' },
});

/**
 * Expected receipts (PURCHASING-PARITY): released purchase orders with
 * something still to arrive, one row per ORDER, as the reference's worklist
 * is. Ordered, Received and Open add the units of the order's active lines
 * across items; open is zero unless the order is released, so a draft, closed
 * or cancelled order has nothing to receive. "Late" keeps those whose expected
 * date is before today (UTC), and the same view marks the date "N days late".
 */
function expectedReceiptList(namespace: string): ListSpec {
  const field = (local: string) => `${namespace}:field.${local}`;
  const output = (local: string) =>
    `${namespace}:list_output.${EXPECTED_RECEIPT_LIST}_${local}`;
  const lifecycle = `${namespace}:derived_state_field.machine.purchase_order_lifecycle`;
  const released = {
    [lifecycle]: `${namespace}:state.purchase_order_released`,
  };
  return {
    pageSize: 50,
    columns: [
      {
        local: 'number',
        label: 'Number',
        field: field('purchase_order_number'),
        role: 'title',
      },
      {
        local: 'supplier',
        label: 'Supplier',
        field: field('purchase_order_supplier_party_id'),
        reference: {
          query: `${namespace}:query.party_list`,
          labelField: field('party_name'),
        },
      },
      {
        local: 'expected_date',
        label: 'Expected',
        field: field('purchase_order_expected_date'),
        format: 'date',
        overdue: 'late',
      },
      // Summed in the list statement: shown and exported, never sorted.
      {
        local: 'ordered',
        label: 'Ordered',
        field: output('ordered'),
        sortable: false,
      },
      {
        local: 'received',
        label: 'Received',
        field: output('received'),
        sortable: false,
      },
      { local: 'open', label: 'Open', field: output('open'), sortable: false },
      {
        local: 'currency',
        label: 'Currency',
        field: field('purchase_order_currency'),
      },
    ],
    defaultSort: [{ column: 'expected_date', direction: 'ascending' }],
    views: [
      {
        local: 'to_receive',
        label: 'To receive',
        filters: released,
        open: true,
      },
      {
        local: 'late',
        label: 'Late',
        filters: released,
        open: true,
        before: field('purchase_order_expected_date'),
      },
      { local: 'all_released', label: 'All released', filters: released },
    ],
    filters: [],
    export: true,
    progress: {
      lines: {
        query: `${namespace}:query.purchase_order_line_list`,
        relation: `${namespace}:relation.purchase_order_line_order`,
        quantity: field('purchase_order_line_ordered_quantity'),
      },
      done: {
        query: `${namespace}:query.purchase_order_received_list`,
        relation: `${namespace}:relation.purchase_order_received_order_line`,
        quantity: field('purchase_order_received_received_quantity'),
      },
      openIn: {
        field: lifecycle,
        values: [`${namespace}:state.purchase_order_released`],
      },
      outputs: {
        ordered: output('ordered'),
        done: output('received'),
        open: output('open'),
      },
    },
  };
}

/** The Expected receipts List surface and the query it reads, by local id. */
export const EXPECTED_RECEIPT_LIST = 'expected_receipt_list';

/**
 * A worklist is a second List over a document's records beside the
 * document's own List, read through its own clone of that List's query so its
 * company entry, its cursor and its agent preset are its own. The clone keeps
 * the source's selections, scope, permission and export limit; nothing about
 * the source List or the source query changes.
 */
const WORKLISTS: Readonly<
  Record<string, { readonly source: string; readonly label: string }>
> = Object.freeze({
  [EXPECTED_RECEIPT_LIST]: {
    source: 'purchase_order_list',
    label: 'Expected receipts',
  },
});

/** Clones of the worklists' source queries, when their source is composed. */
export function worklistQueries(
  namespace: string,
  queries: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return Object.entries(WORKLISTS).flatMap(([local, worklist]) => {
    const source = queries.find(
      (query) => query.queryId === `${namespace}:query.${worklist.source}`,
    );
    return source
      ? [
          renamed(source, [
            [`:query.${worklist.source}`, `:query.${local}`],
            [`:selection.${worklist.source}_`, `:selection.${local}_`],
            [`:parameter.${worklist.source}_`, `:parameter.${local}_`],
          ]),
        ]
      : [];
  });
}

/** The worklists' List surfaces, cut from their source List's surface. */
export function worklistSurfaces(
  namespace: string,
  surfaces: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return Object.entries(WORKLISTS).flatMap(([local, worklist]) => {
    const source = surfaces.find(
      (surface) =>
        surface.surfaceId === `${namespace}:surface.${worklist.source}`,
    );
    return source
      ? [
          {
            ...renamed(source, [
              [`:surface.${worklist.source}`, `:surface.${local}`],
              [`:slot.${worklist.source}_`, `:slot.${local}_`],
              [`:query.${worklist.source}`, `:query.${local}`],
            ]),
            label: worklist.label,
          },
        ]
      : [];
  });
}

/** The worklists by local id, for the workspace pass (navigation, entry). */
export function isWorklist(local: string): boolean {
  return Object.hasOwn(WORKLISTS, local);
}

function renamed(
  value: Record<string, unknown>,
  renames: readonly (readonly [from: string, to: string])[],
): Record<string, unknown> {
  let text = JSON.stringify(value);
  for (const [from, to] of renames) text = text.replaceAll(from, to);
  return JSON.parse(text) as Record<string, unknown>;
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
    drop_ship_delivery_list: {
      pageSize: 25,
      columns: [
        { local: 'number', label: 'Delivery', field: `${namespace}:field.drop_ship_delivery_number`, role: 'title' },
        { local: 'state', label: 'State', field: `${namespace}:field.drop_ship_delivery_state`, role: 'status' },
        { local: 'date', label: 'Delivered', field: `${namespace}:field.drop_ship_delivery_delivery_date`, format: 'date' },
        { local: 'quantity', label: 'Quantity', field: `${namespace}:field.drop_ship_delivery_quantity` },
        { local: 'unit', label: 'Unit', field: `${namespace}:field.drop_ship_delivery_unit_id` },
        { local: 'reference', label: 'Supplier reference', field: `${namespace}:field.drop_ship_delivery_external_reference` },
      ],
      defaultSort: [{ column: 'number', direction: 'descending' }],
      views: ['draft', 'posted', 'reversed'].map((state) => ({ local: state, label: state[0]!.toUpperCase() + state.slice(1),
        filters: { [`${namespace}:field.drop_ship_delivery_state`]: `${namespace}:option.drop_ship_delivery_state_${state}` } })),
      filters: [], export: true,
    },
    sales_order_list: documentList(
      namespace,
      'sales_order',
      { field: 'customer_party_id', label: 'Customer' },
      [
        { field: 'order_date', label: 'Order date' },
        { field: 'requested_date', label: 'Requested' },
      ],
      [{ field: 'salesperson_party_id', label: 'Salesperson' }],
      {
        // The plain clone of the line list: the line list itself carries the
        // fulfillment read model, which the statement never runs.
        linesQuery: 'commercial_lines',
        // Shipped per line, net of corrections, as the fulfillment kernel
        // keeps it.
        done: {
          local: 'shipped',
          label: 'Shipped',
          query: `${namespace}:query.sales_order_shipped_list`,
          relation: `${namespace}:relation.sales_order_shipped_order_line`,
          quantity: `${namespace}:field.sales_order_shipped_shipped_quantity`,
        },
        openView: { local: 'to_ship', label: 'To ship' },
        // "Post shipment" waits for reservation coverage (a later increment):
        // until then a row opens its order's fulfillment section.
        action: {
          local: 'fulfill',
          label: 'Fulfill',
          section: `${namespace}:dataset.fulfillment_lines`,
        },
      },
    ),
    purchase_order_list: documentList(
      namespace,
      'purchase_order',
      { field: 'supplier_party_id', label: 'Supplier' },
      [
        { field: 'order_date', label: 'Order date' },
        { field: 'expected_date', label: 'Expected' },
      ],
      [],
      {
        linesQuery: 'purchase_order_line_list',
        done: {
          local: 'received',
          label: 'Received',
          query: `${namespace}:query.purchase_order_received_list`,
          relation: `${namespace}:relation.purchase_order_received_order_line`,
          quantity: `${namespace}:field.purchase_order_received_received_quantity`,
        },
        openView: { local: 'to_receive', label: 'To receive' },
        late: 'expected_date',
        action: {
          local: 'receive',
          label: 'Receive',
          section: `${namespace}:dataset.purchasing_lines`,
        },
        // The List reads the commercial clone of its query (LIST_DATA_SOURCES
        // in the builder), whose read model states each order's total.
        total: `${namespace}:metric.order_total`,
      },
    ),
    // What is still to arrive (PURCHASING-PARITY), beside Purchase orders.
    [EXPECTED_RECEIPT_LIST]: expectedReceiptList(namespace),
    // Receivables (owner ruling C): each invoice with its balance; the tabs
    // are the invoice states, the customer is named through the party list.
    customer_invoice_list: settlementList(namespace, INVOICE_LIST),
    // Payables (PAYABLES): each vendor bill the same way, with the supplier's
    // own invoice number.
    vendor_bill_list: settlementList(namespace, BILL_LIST),
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
      ...(column.overdue
        ? { overdue: { view: id('list_view', column.overdue) } }
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
      ...(view.open ? { open: true } : {}),
      ...(view.before
        ? { before: { field: view.before, anchor: 'startOfTodayUtc' } }
        : {}),
    })),
    filters: spec.filters.map((filter, index) => ({
      filterId: id('list_filter', filter.local),
      label: filter.label,
      orderKey: (index + 1) * 10,
      field: filter.field,
      options: filter.options.map(([value, label]) => ({ value, label })),
    })),
    ...(spec.export ? { export: { format: 'csv' } } : {}),
    ...(spec.progress
      ? {
          progress: {
            lines: progressSource(spec.progress.lines),
            done: progressSource(spec.progress.done),
            ...(spec.progress.openIn
              ? {
                  openIn: {
                    field: spec.progress.openIn.field,
                    values: [...spec.progress.openIn.values],
                  },
                }
              : {}),
            outputs: { ...spec.progress.outputs },
            ...(spec.progress.whenDenied
              ? { whenDenied: spec.progress.whenDenied }
              : {}),
          },
        }
      : {}),
    ...(spec.rowActions
      ? {
          rowActions: spec.rowActions.map((action, index) => ({
            actionId: id('list_row_action', action.local),
            label: action.label,
            orderKey: (index + 1) * 10,
            ...(action.when
              ? {
                  when: {
                    ...(action.when.filters
                      ? {
                          filters: Object.entries(action.when.filters).map(
                            ([field, value]) => ({ field, value }),
                          ),
                        }
                      : {}),
                    ...(action.when.open ? { open: true } : {}),
                  },
                }
              : {}),
            ...(action.section ? { section: action.section } : {}),
          })),
        }
      : {}),
  };
}

function progressSource(source: ListProgressSourceSpec) {
  return {
    query: {
      kind: 'queryReference',
      schemaVersion: version,
      targetId: source.query,
    },
    relation: source.relation,
    quantity: source.quantity,
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
