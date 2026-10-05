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
    /** Only rows whose band figure holds one of these values. */
    readonly band?: {
      readonly figure: string;
      readonly values: readonly string[];
    };
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
  /**
   * Per row, figures the list statement computes before the count and the
   * page, in the canonical `surface.list.figures` shape with query ids as
   * strings (REPLENISHMENT).
   */
  readonly figures?: ListFiguresSpec;
}

/** Rows of a list query that hold the listed record's id as text. */
interface ListFigureRowsSpec {
  readonly query: string;
  readonly match: string;
  readonly quantity?: string;
}

/**
 * Only rows whose parent holds one of these values in a field: the parent
 * through the rows' relation to it, or the record whose id the rows hold in a
 * text field (`reference`), as a stock balance holds its location.
 */
type ListFigureWithinSpec = {
  readonly query: string;
  readonly field: string;
  readonly values: readonly string[];
} & (
  | { readonly relation: string; readonly reference?: never }
  | { readonly reference: string; readonly relation?: never }
);

type ListFigureOperandSpec =
  { readonly figure: string } | { readonly field: string };

type ListFigureThresholdSpec =
  { readonly field: string } | { readonly value: string };

interface ListFiguresSpec {
  readonly sums: readonly {
    readonly figureId: string;
    readonly rows: ListFigureRowsSpec;
    readonly within?: ListFigureWithinSpec;
    readonly related?: {
      readonly query: string;
      readonly relation: string;
      readonly quantity: string;
    };
    readonly sum: 'rows' | 'related' | 'remaining';
  }[];
  readonly totals?: readonly {
    readonly figureId: string;
    readonly plus: readonly ListFigureOperandSpec[];
    readonly minus: readonly ListFigureOperandSpec[];
    readonly floor?: 'zero';
  }[];
  readonly bands?: readonly {
    readonly figureId: string;
    readonly of: string;
    readonly cases: readonly {
      readonly value: string;
      readonly label: string;
      readonly below?: ListFigureThresholdSpec;
      readonly atMost?: ListFigureThresholdSpec;
    }[];
    readonly otherwise: { readonly value: string; readonly label: string };
  }[];
  readonly latest?: readonly {
    readonly figureId: string;
    readonly rows: { readonly query: string; readonly match: string };
    readonly within: ListFigureWithinSpec;
    readonly by: string;
    readonly value: string;
    readonly label: { readonly query: string; readonly field: string };
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
 * Stock documents (INVENTORY-PARITY): every inventory transaction, newest
 * first. Receipts, shipments and counts write companion transactions too, so
 * the tabs keep drafts and the two documents a person records -- adjustments
 * and transfers -- one click away.
 */
function inventoryTransactionList(namespace: string): ListSpec {
  const field = (local: string) =>
    `${namespace}:field.inventory_transaction_${local}`;
  const option = (local: string) =>
    `${namespace}:option.inventory_transaction_${local}`;
  return {
    pageSize: 50,
    columns: [
      {
        local: 'number',
        label: 'Number',
        field: field('number'),
        role: 'title',
      },
      { local: 'type', label: 'Type', field: field('type') },
      { local: 'reason', label: 'Reason', field: field('reason_code') },
      {
        local: 'effective',
        label: 'Effective',
        field: field('effective_at'),
        format: 'date',
      },
      {
        local: 'state',
        label: 'State',
        field: field('state'),
        role: 'status',
        statusRoles: {
          [option('state_draft')]: 'inProgress',
          [option('state_posted')]: 'success',
          [option('state_reversed')]: 'attention',
        },
      },
    ],
    defaultSort: [{ column: 'effective', direction: 'descending' }],
    // The type is chosen by its tab: a List filters a field its views do not.
    views: [
      { local: 'all', label: 'All', filters: {} },
      {
        local: 'drafts',
        label: 'Drafts',
        filters: { [field('state')]: option('state_draft') },
      },
      {
        local: 'adjustments',
        label: 'Adjustments',
        filters: { [field('type')]: option('type_adjustment') },
      },
      {
        local: 'transfers',
        label: 'Transfers',
        filters: { [field('type')]: option('type_transfer') },
      },
    ],
    filters: [],
    export: false,
  };
}

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

/** Stock by item and the Buying worklist (REPLENISHMENT), by local id. */
export const ITEM_STOCK_LIST = 'item_stock_list';
export const ITEM_BUYING_LIST = 'item_buying_list';

/**
 * Stock by item and the Buying worklist (REPLENISHMENT): one row per catalog
 * item, with figures the list statement adds up in the one company the List
 * is entered with. On hand is the item's posted stock; Usable the part of it
 * held at usable locations (LOCATIONS); Reserved what its live reservations
 * still hold; Available the usable stock less what reservations hold at
 * usable locations; Incoming what released purchase orders still have to
 * receive, line by line; Open demand what confirmed sales orders still have
 * to ship, line by line. Projected is usable stock plus incoming less open
 * demand -- not available stock, since open demand already holds the units
 * reservations set aside. An item is due at or below its reorder point; one
 * without a reorder point never is, and without a reorder-up-to level its
 * suggestion is unstated. Figures are shown, never sorted.
 */
function itemFigureList(
  namespace: string,
  local: typeof ITEM_STOCK_LIST | typeof ITEM_BUYING_LIST,
): ListSpec {
  const field = (name: string) => `${namespace}:field.${name}`;
  const query = (name: string) => `${namespace}:query.${name}`;
  const relation = (name: string) => `${namespace}:relation.${name}`;
  const figure = (name: string) => `${namespace}:list_figure.${local}_${name}`;
  const band = (name: string) => `${namespace}:list_band.${local}_${name}`;
  const buying = local === ITEM_BUYING_LIST;
  const lines = (
    document: 'purchase_order' | 'sales_order',
    states: string[],
  ) =>
    ({
      relation: relation(`${document}_line_order`),
      query: query(`${document}_list`),
      field: `${namespace}:derived_state_field.machine.${document}_lifecycle`,
      values: states.map((state) => `${namespace}:state.${document}_${state}`),
    }) as const;
  // Only rows held at a usable location (LOCATIONS, owner ruling L-A): stock
  // in quarantine, damaged, in transit or return pending is on hand but
  // neither usable nor available. A row naming no live location counts
  // nowhere usable.
  const usable = (locationField: string) => ({
    reference: field(locationField),
    query: query('location_list'),
    field: field('location_status'),
    values: [`${namespace}:option.location_status_usable`],
  });
  const onHand = {
    query: query('posted_stock_balance_list'),
    match: field('posted_stock_balance_item_id'),
    quantity: field('posted_stock_balance_posted_quantity'),
  };
  // What each reservation still holds: nothing once released or consumed,
  // and a draft has no balance yet.
  const reservations = {
    rows: {
      query: query('workspace_stock_reservations'),
      match: field('reservation_item_id'),
    },
    related: {
      query: query('reservation_balance_list'),
      relation: relation('reservation_balance_reservation'),
      quantity: field('reservation_balance_remaining_quantity'),
    },
    sum: 'related' as const,
  };
  const sums: ListFiguresSpec['sums'] = [
    { figureId: figure('on_hand'), rows: onHand, sum: 'rows' },
    {
      figureId: figure('usable'),
      rows: onHand,
      within: usable('posted_stock_balance_location_id'),
      sum: 'rows',
    },
    { figureId: figure('reserved'), ...reservations },
    // What reservations hold at usable locations: Available is what is left
    // of the usable stock (PaneFlow's `on_hand - reserved` where usable).
    {
      figureId: figure('reserved_usable'),
      ...reservations,
      within: usable('reservation_location_id'),
    },
    {
      figureId: figure('incoming'),
      rows: {
        query: query('purchase_order_line_list'),
        match: field('purchase_order_line_item_id'),
        quantity: field('purchase_order_line_ordered_quantity'),
      },
      within: lines('purchase_order', ['released']),
      related: {
        query: query('purchase_order_received_list'),
        relation: relation('purchase_order_received_order_line'),
        quantity: field('purchase_order_received_received_quantity'),
      },
      sum: 'remaining',
    },
    // The plain clone of the line list: the line list carries the
    // fulfillment read model, which the statement never runs.
    {
      figureId: figure('open_demand'),
      rows: {
        query: query('commercial_lines'),
        match: field('sales_order_line_item_id'),
        quantity: field('sales_order_line_ordered_quantity'),
      },
      within: lines('sales_order', ['released']),
      related: {
        query: query('sales_order_shipped_list'),
        relation: relation('sales_order_shipped_order_line'),
        quantity: field('sales_order_shipped_shipped_quantity'),
      },
      sum: 'remaining',
    },
  ];
  const reorderPoint = { field: field('item_reorder_point') };
  const figures: ListFiguresSpec = {
    sums,
    totals: [
      {
        figureId: figure('available'),
        plus: [{ figure: figure('usable') }],
        minus: [{ figure: figure('reserved_usable') }],
      },
      // Usable stock, not on hand: what sits in quarantine cannot meet
      // demand (PaneFlow's projected = usable + incoming - demand).
      {
        figureId: figure('projected'),
        plus: [{ figure: figure('usable') }, { figure: figure('incoming') }],
        minus: [{ figure: figure('open_demand') }],
      },
      // Back up to the item's level; unstated without one.
      ...(buying
        ? [
            {
              figureId: figure('suggested'),
              plus: [{ field: field('item_reorder_up_to') }],
              minus: [{ figure: figure('projected') }],
              floor: 'zero' as const,
            },
          ]
        : []),
    ],
    bands: [
      buying
        ? {
            figureId: figure('due'),
            of: figure('projected'),
            cases: [
              { value: band('due'), label: 'To buy', atMost: reorderPoint },
            ],
            otherwise: { value: band('covered'), label: 'Covered' },
          }
        : {
            figureId: figure('status'),
            of: figure('projected'),
            cases: [
              {
                value: band('shortage'),
                label: 'Shortage',
                below: { value: '0' },
              },
              {
                value: band('reorder'),
                label: 'Reorder',
                atMost: reorderPoint,
              },
            ],
            otherwise: { value: band('healthy'), label: 'Healthy' },
          },
    ],
    // The supplier of the newest released or closed purchase order with a
    // line for the item, named through the party list.
    ...(buying
      ? {
          latest: [
            {
              figureId: figure('last_supplier'),
              rows: {
                query: query('purchase_order_line_list'),
                match: field('purchase_order_line_item_id'),
              },
              within: lines('purchase_order', ['released', 'closed']),
              by: field('purchase_order_order_date'),
              value: field('purchase_order_supplier_party_id'),
              label: { query: query('party_list'), field: field('party_name') },
            },
          ],
        }
      : {}),
  };
  const shown = (name: string, label: string): ListColumnSpec => ({
    local: name,
    label,
    field: figure(name),
    sortable: false,
  });
  return {
    pageSize: 50,
    columns: [
      { local: 'sku', label: 'SKU', field: field('item_sku'), role: 'title' },
      { local: 'item', label: 'Item', field: field('item_name') },
      {
        local: 'unit',
        label: 'Unit',
        field: field('item_base_unit'),
        sortable: false,
      },
      ...(buying
        ? [shown('usable', 'Usable')]
        : [
            shown('on_hand', 'On hand'),
            shown('usable', 'Usable'),
            shown('reserved', 'Reserved'),
          ]),
      shown('available', 'Available'),
      shown('incoming', 'Incoming'),
      shown('open_demand', 'Open demand'),
      shown('projected', 'Projected'),
      {
        local: 'reorder_point',
        label: 'Reorder point',
        field: field('item_reorder_point'),
      },
      ...(buying
        ? [
            {
              local: 'reorder_up_to',
              label: 'Reorder up to',
              field: field('item_reorder_up_to'),
            },
            shown('suggested', 'Suggested'),
            shown('last_supplier', 'Last supplier'),
          ]
        : [
            {
              ...shown('status', 'Status'),
              role: 'status' as const,
              statusRoles: {
                [band('shortage')]: 'blocked' as const,
                [band('reorder')]: 'attention' as const,
                [band('healthy')]: 'success' as const,
              },
            },
          ]),
    ],
    defaultSort: [{ column: 'sku', direction: 'ascending' }],
    views: buying
      ? [
          {
            local: 'to_buy',
            label: 'To buy',
            filters: {},
            band: { figure: figure('due'), values: [band('due')] },
          },
        ]
      : [
          { local: 'all', label: 'All', filters: {} },
          {
            local: 'shortage',
            label: 'Shortage',
            filters: {},
            band: { figure: figure('status'), values: [band('shortage')] },
          },
          {
            local: 'reorder',
            label: 'Reorder',
            filters: {},
            band: { figure: figure('status'), values: [band('reorder')] },
          },
        ],
    filters: [],
    export: true,
    figures,
  };
}

/**
 * The locations (LOCATIONS): each with its type and inventory status, the
 * status shown as a status and filtered by value, so what is in quarantine or
 * damaged is one choice away. Names sort; the reason is shown, never sorted.
 */
function locationList(namespace: string): ListSpec {
  const field = (name: string) => `${namespace}:field.location_${name}`;
  const option = (name: string) => `${namespace}:option.${name}`;
  const status = (name: string) => option(`location_status_${name}`);
  const statuses = [
    [status('usable'), 'Usable'],
    [status('quarantine'), 'Quarantine'],
    [status('damaged'), 'Damaged'],
    [status('in_transit'), 'In transit'],
    [status('return_pending'), 'Return pending'],
  ] as const;
  const types: (readonly [string, string])[] = [
    [option('warehouse'), 'Warehouse'],
    [option('store'), 'Store'],
    ...(
      [
        ['storage', 'Storage'],
        ['receiving', 'Receiving'],
        ['shipping', 'Shipping'],
        ['quarantine', 'Quarantine'],
        ['in_transit', 'In transit'],
        ['scrap', 'Scrap'],
        ['yard', 'Yard'],
      ] as const
    ).map(
      ([local, label]) => [option(`location_type_${local}`), label] as const,
    ),
  ];
  return {
    pageSize: 50,
    columns: [
      { local: 'code', label: 'Code', field: field('code'), role: 'title' },
      { local: 'name', label: 'Name', field: field('name') },
      { local: 'type', label: 'Type', field: field('type') },
      {
        local: 'status',
        label: 'Inventory status',
        field: field('status'),
        role: 'status',
        statusRoles: {
          [status('usable')]: 'success',
          [status('quarantine')]: 'attention',
          [status('damaged')]: 'blocked',
          [status('in_transit')]: 'inProgress',
          [status('return_pending')]: 'attention',
        },
      },
      {
        local: 'status_reason',
        label: 'Status reason',
        field: field('status_reason'),
        sortable: false,
      },
    ],
    defaultSort: [{ column: 'code', direction: 'ascending' }],
    views: [],
    filters: [
      {
        local: 'status',
        label: 'Inventory status',
        field: field('status'),
        options: statuses,
      },
      { local: 'type', label: 'Type', field: field('type'), options: types },
    ],
    // The location query declares no export limit; a short setup list.
    export: false,
  };
}

/**
 * A worklist is a second List over a document's records beside the
 * document's own List, read through its own clone of that List's query so its
 * company entry, its cursor and its agent preset are its own. The clone keeps
 * the source's selections, scope, permission and export limit; nothing about
 * the source List or the source query changes.
 */
interface Worklist {
  readonly source: string;
  readonly label: string;
  /**
   * A List over records every company shares, read in one company
   * (REPLENISHMENT: Catalog's items with their stock). Its clone gains the
   * exactly-one company operand its source does not declare, and an export
   * limit, so its figures add up that company's rows; it is cut only where
   * every query its figures read is composed and its source selects every
   * field it names. Read-only: no bulk action.
   */
  readonly inCompany?: {
    /** The module whose navigation group lists it. */
    readonly navigationModule: string;
    /** The List query whose company read authorizes its entry. */
    readonly authorization: string;
  };
}

const WORKLISTS: Readonly<Record<string, Worklist>> = Object.freeze({
  [EXPECTED_RECEIPT_LIST]: {
    source: 'purchase_order_list',
    label: 'Expected receipts',
  },
  [ITEM_STOCK_LIST]: {
    source: 'item_list',
    label: 'Stock by item',
    inCompany: {
      navigationModule: 'inventory',
      authorization: 'posted_stock_balance_list',
    },
  },
  [ITEM_BUYING_LIST]: {
    source: 'item_list',
    label: 'Buying worklist',
    inCompany: {
      navigationModule: 'inventory',
      authorization: 'posted_stock_balance_list',
    },
  },
});

/**
 * Whether a worklist read in one company can be cut: every query its figures
 * read is composed, and its source selects every field its columns, totals
 * and bands name.
 */
function figuresComposed(
  namespace: string,
  local: string,
  source: Record<string, unknown>,
  queries: readonly Record<string, unknown>[],
): boolean {
  const spec = composedListSpecs(namespace)[local];
  if (!spec?.figures) return true;
  const figures = spec.figures;
  const composed = new Set(queries.map((query) => String(query.queryId)));
  const read = [
    ...figures.sums.flatMap((sum) => [
      sum.rows.query,
      ...(sum.within ? [sum.within.query] : []),
      ...(sum.related ? [sum.related.query] : []),
    ]),
    ...(figures.latest ?? []).flatMap((latest) => [
      latest.rows.query,
      latest.within.query,
      latest.label.query,
    ]),
  ];
  const selected = new Set(
    (source.selections as { field: { targetId: string } }[]).map(
      (selection) => selection.field.targetId,
    ),
  );
  const figureIds = new Set([
    ...figures.sums.map((sum) => sum.figureId),
    ...(figures.totals ?? []).map((total) => total.figureId),
    ...(figures.bands ?? []).map((band) => band.figureId),
    ...(figures.latest ?? []).map((latest) => latest.figureId),
  ]);
  const operand = (value: { figure: string } | { field: string }) =>
    'field' in value ? [value.field] : [];
  const named = [
    ...spec.columns
      .map((column) => column.field)
      .filter((field) => !figureIds.has(field)),
    ...(figures.totals ?? []).flatMap((total) =>
      [...total.plus, ...total.minus].flatMap(operand),
    ),
    ...(figures.bands ?? []).flatMap((band) =>
      band.cases.flatMap((entry) => {
        const threshold = entry.below ?? entry.atMost;
        return threshold && 'field' in threshold ? [threshold.field] : [];
      }),
    ),
  ];
  return (
    read.every((queryId) => composed.has(queryId)) &&
    named.every((fieldId) => selected.has(fieldId))
  );
}

/** Clones of the worklists' source queries, when their source is composed. */
export function worklistQueries(
  namespace: string,
  queries: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return Object.entries(WORKLISTS).flatMap(([local, worklist]) => {
    const source = queries.find(
      (query) => query.queryId === `${namespace}:query.${worklist.source}`,
    );
    if (!source) return [];
    const clone = renamed(source, [
      [`:query.${worklist.source}`, `:query.${local}`],
      [`:selection.${worklist.source}_`, `:selection.${local}_`],
      [`:parameter.${worklist.source}_`, `:parameter.${local}_`],
    ]);
    if (!worklist.inCompany) return [clone];
    if (!figuresComposed(namespace, local, source, queries)) return [];
    const parameterId = `${namespace}:parameter.${local}_legal_entity_scope`;
    return [
      {
        ...clone,
        legalEntityScope: {
          cardinality: 'exactlyOne',
          kind: 'queryLegalEntityScope',
          operand: {
            kind: 'queryParameterReference',
            parameterId,
            schemaVersion: version,
          },
          schemaVersion: version,
        },
        parameters: [
          {
            kind: 'queryParameterDefinition',
            orderKey: 10,
            parameterId,
            schemaVersion: version,
          },
        ],
        // The declared List exports its whole filtered set in one statement.
        exportMaximumResultCount: 5_000,
      },
    ];
  });
}

/**
 * The worklists' List surfaces, cut from their source List's surface where
 * their query is composed.
 */
export function worklistSurfaces(
  namespace: string,
  surfaces: readonly Record<string, unknown>[],
  queries: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return Object.entries(WORKLISTS).flatMap(([local, worklist]) => {
    const source = surfaces.find(
      (surface) =>
        surface.surfaceId === `${namespace}:surface.${worklist.source}`,
    );
    if (
      !source ||
      !queries.some((query) => query.queryId === `${namespace}:query.${local}`)
    )
      return [];
    const surface = renamed(source, [
      [`:surface.${worklist.source}`, `:surface.${local}`],
      [`:slot.${worklist.source}_`, `:slot.${local}_`],
      [`:query.${worklist.source}`, `:query.${local}`],
    ]);
    return [
      {
        ...surface,
        label: worklist.label,
        ...(worklist.inCompany
          ? {
              slots: (surface.slots as Record<string, unknown>[]).filter(
                (slot) => slot.slot !== 'bulkActions',
              ),
            }
          : {}),
      },
    ];
  });
}

/** The worklists by local id, for the workspace pass (navigation, entry). */
export function isWorklist(local: string): boolean {
  return Object.hasOwn(WORKLISTS, local);
}

/**
 * Where a worklist read in one company is listed and what authorizes its
 * entry; `null` for every other List.
 */
export function worklistPlacement(local: string): Worklist['inCompany'] | null {
  return (
    (Object.hasOwn(WORKLISTS, local) && WORKLISTS[local]?.inCompany) || null
  );
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
    // Stock documents, recorded in the draft editor (INVENTORY-PARITY).
    inventory_transaction_list: inventoryTransactionList(namespace),
    // Stock by item and the Buying worklist (REPLENISHMENT).
    [ITEM_STOCK_LIST]: itemFigureList(namespace, ITEM_STOCK_LIST),
    [ITEM_BUYING_LIST]: itemFigureList(namespace, ITEM_BUYING_LIST),
    // Every location with its type and inventory status (LOCATIONS).
    location_list: locationList(namespace),
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
      ...(view.band
        ? { band: { figure: view.band.figure, values: [...view.band.values] } }
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
    ...(spec.figures ? { figures: lowerFigures(spec.figures) } : {}),
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

/** A List's figures in the canonical shape: each query as its reference. */
function lowerFigures(figures: ListFiguresSpec) {
  const queryReference = (targetId: string) => ({
    kind: 'queryReference',
    schemaVersion: version,
    targetId,
  });
  const within = (value: ListFigureWithinSpec) => ({
    ...(value.reference !== undefined
      ? { reference: value.reference }
      : { relation: value.relation }),
    query: queryReference(value.query),
    field: value.field,
    values: [...value.values],
  });
  return {
    sums: figures.sums.map((sum) => ({
      figureId: sum.figureId,
      rows: {
        query: queryReference(sum.rows.query),
        match: sum.rows.match,
        ...(sum.rows.quantity ? { quantity: sum.rows.quantity } : {}),
      },
      ...(sum.within ? { within: within(sum.within) } : {}),
      ...(sum.related
        ? {
            related: {
              query: queryReference(sum.related.query),
              relation: sum.related.relation,
              quantity: sum.related.quantity,
            },
          }
        : {}),
      sum: sum.sum,
    })),
    ...(figures.totals
      ? {
          totals: figures.totals.map((total) => ({
            figureId: total.figureId,
            plus: total.plus.map((operand) => ({ ...operand })),
            minus: total.minus.map((operand) => ({ ...operand })),
            ...(total.floor ? { floor: total.floor } : {}),
          })),
        }
      : {}),
    ...(figures.bands
      ? {
          bands: figures.bands.map((band) => ({
            figureId: band.figureId,
            of: band.of,
            cases: band.cases.map((entry) => ({
              value: entry.value,
              label: entry.label,
              ...(entry.below ? { below: { ...entry.below } } : {}),
              ...(entry.atMost ? { atMost: { ...entry.atMost } } : {}),
            })),
            otherwise: { ...band.otherwise },
          })),
        }
      : {}),
    ...(figures.latest
      ? {
          latest: figures.latest.map((latest) => ({
            figureId: latest.figureId,
            rows: {
              query: queryReference(latest.rows.query),
              match: latest.rows.match,
            },
            within: within(latest.within),
            by: latest.by,
            value: latest.value,
            label: {
              query: queryReference(latest.label.query),
              field: latest.label.field,
            },
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
