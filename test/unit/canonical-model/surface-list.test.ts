import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanonicalModelError,
  normalizeApplicationPackage,
} from '../../../packages/canonical-model/src/index.js';
import { composedApplicationDefinition } from '../../../packages/domain/src/app/builder.js';

type Json = Record<string, unknown>;
const ns = 'northstar.app';
const salesList = `${ns}:surface.sales_order_list`;
const expectedList = `${ns}:surface.expected_receipt_list`;
const purchaseList = `${ns}:surface.purchase_order_list`;
const invoiceList = `${ns}:surface.customer_invoice_list`;
const stockList = `${ns}:surface.item_stock_list`;
const buyingList = `${ns}:surface.item_buying_list`;

function application(): Json & { surfaces: Json[]; queries: Json[] } {
  return structuredClone(composedApplicationDefinition()) as Json & {
    surfaces: Json[];
    queries: Json[];
  };
}

function listOf(app: ReturnType<typeof application>, surfaceId = salesList) {
  const surface = app.surfaces.find((value) => value.surfaceId === surfaceId)!;
  return {
    surface,
    list: surface.list as {
      columns: Json[];
      views: Json[];
      filters: Json[];
      [key: string]: unknown;
    },
  };
}

function refused(mutate: (app: ReturnType<typeof application>) => void) {
  const app = application();
  mutate(app);
  try {
    normalizeApplicationPackage(app as never);
  } catch (error) {
    assert.ok(error instanceof CanonicalModelError, String(error));
    return error.diagnostics.map((diagnostic) => diagnostic.rule).join(' ');
  }
  assert.fail('the declaration was accepted');
}

test('the composed application declares its Lists and they normalize unchanged', () => {
  const normalized = normalizeApplicationPackage(
    composedApplicationDefinition() as never,
  );
  const declared = normalized.surfaces.filter(
    (surface) => 'list' in surface && surface.list,
  );
  assert.deepEqual(declared.map((surface) => surface.surfaceId).sort(), [
    // Ruling C: the Invoices List.
    `${ns}:surface.customer_invoice_list`,
    // PURCHASING-PARITY: what is still to arrive, beside Purchase orders.
    expectedList,
    // INVENTORY-PARITY: stock documents, by state and type.
    `${ns}:surface.inventory_transaction_list`,
    // VALUATION: derived known value and explicit unvalued quantity.
    `${ns}:surface.inventory_value_list`,
    // REPLENISHMENT: the Buying worklist and Stock by item.
    buyingList,
    // CATALOG-EXTRAS: the Items List, found by an alias too.
    `${ns}:surface.item_list`,
    stockList,
    // LOCATIONS: each location's type and inventory status.
    `${ns}:surface.location_list`,
    `${ns}:surface.posted_stock_balance_list`,
    `${ns}:surface.purchase_order_approval_list`,
    `${ns}:surface.purchase_order_list`,
    salesList,
    // PAYABLES: the Bills List, by bill state.
    `${ns}:surface.vendor_bill_list`,
  ]);
  // Its own clone of the Purchase orders query: same selections, scope,
  // permission and export limit; the Purchase orders List is unchanged.
  type Selected = { selections: Array<{ field: { targetId: string } }> };
  const clone = normalized.queries.find(
    (value) => value.queryId === `${ns}:query.expected_receipt_list`,
  )!;
  const source = normalized.queries.find(
    (value) => value.queryId === `${ns}:query.purchase_order_list`,
  )!;
  assert.deepEqual(
    (clone as unknown as Selected).selections.map(
      (selection) => selection.field.targetId,
    ),
    (source as unknown as Selected).selections.map(
      (selection) => selection.field.targetId,
    ),
  );
  assert.equal(clone.permission.targetId, source.permission.targetId);
  assert.equal(
    'exportMaximumResultCount' in clone && clone.exportMaximumResultCount,
    5000,
  );
  const expected = declared.find(
    (surface) => surface.surfaceId === expectedList,
  )!;
  type Declared = {
    dataSource: { targetId: string };
    list: {
      progress?: { whenDenied?: string; supply?: { whenDenied?: string } };
      rowActions?: Array<{
        label: string;
        section?: string;
        when?: { supply?: string };
      }>;
      views: Array<{ label: string; open?: true; supply?: string }>;
      columns: Array<{ label: string }>;
    };
  };
  const list = (expected as unknown as Declared).list;
  assert.ok(list.progress, 'Expected receipts declares its progress');
  // Its progress is its purpose: a denial refuses it.
  assert.equal(list.progress.whenDenied, undefined);
  // ORDER-PARITY: both order Lists sum their lines, supplementary, and link
  // each row to its order's work while something is open.
  for (const [surfaceId, dataSource, work, action, section] of [
    [
      salesList,
      `${ns}:query.sales_order_list`,
      'To ship',
      'Fulfill',
      `${ns}:dataset.fulfillment_lines`,
    ],
    [
      `${ns}:surface.purchase_order_list`,
      // Read with each order's total through the commercial read model.
      `${ns}:query.commercial_purchase_order_list`,
      'To receive',
      'Receive',
      `${ns}:dataset.purchasing_lines`,
    ],
  ] as const) {
    const order = declared.find(
      (surface) => surface.surfaceId === surfaceId,
    ) as unknown as Declared;
    assert.equal(order.dataSource.targetId, dataSource);
    assert.equal(order.list.progress?.whenDenied, 'omit');
    assert.equal(order.list.views[1]?.label, work);
    assert.equal(order.list.views[1]?.open, true);
    assert.deepEqual(
      order.list.rowActions
        ?.filter((value) => value.when?.supply === undefined)
        .map((value) => [value.label, value.section]),
      [
        [action, section],
        ['View', undefined],
      ],
    );
  }
  // SUPPLY-WARNINGS: the Sales orders List says what its open lines are
  // short of and what reservations hold for them, supplementary like its
  // progress: the reference's two supply tabs after To ship, a Short column
  // after Open, and "Post shipment" leading the row's actions while reserved
  // stock is still to ship, at the same section.
  const salesOrders = declared.find(
    (surface) => surface.surfaceId === salesList,
  ) as unknown as Declared;
  assert.equal(salesOrders.list.progress?.supply?.whenDenied, 'omit');
  assert.deepEqual(
    salesOrders.list.views.map((view) => [view.label, view.supply ?? null]),
    [
      ['All', null],
      ['To ship', null],
      ['Blocked by supply', 'short'],
      ['Reserved', 'covered'],
      ['Draft', null],
      ['Released', null],
      ['Closed', null],
      ['Cancelled', null],
    ],
  );
  // RECEIVING-EXTRAS: what placed purchase orders cover of it, after Short.
  assert.deepEqual(
    salesOrders.list.columns.map((column) => column.label).slice(-4),
    ['Open', 'Short', 'On order', 'Currency'],
  );
  assert.deepEqual(
    salesOrders.list.rowActions?.map((value) => [
      value.label,
      value.section,
      value.when?.supply ?? null,
    ]),
    [
      ['Post shipment', `${ns}:dataset.fulfillment_lines`, 'covered'],
      ['Fulfill', `${ns}:dataset.fulfillment_lines`, null],
      ['View', undefined, null],
    ],
  );
  // The commercial clone keeps the source's selections and permission.
  const totals = normalized.queries.find(
    (value) => value.queryId === `${ns}:query.commercial_purchase_order_list`,
  )!;
  assert.deepEqual(
    (totals as unknown as Selected).selections.map(
      (selection) => selection.field.targetId,
    ),
    (source as unknown as Selected).selections.map(
      (selection) => selection.field.targetId,
    ),
  );
  assert.equal(totals.permission.targetId, source.permission.targetId);
  const sales = declared.find((surface) => surface.surfaceId === salesList)!;
  assert.deepEqual(
    sales.slots.map((slot) => slot.slot),
    ['title', 'savedViews', 'dataGrid', 'bulkActions'],
  );
  // The export limit rides the query, where the agent path reads it.
  const query = normalized.queries.find(
    (value) => value.queryId === `${ns}:query.sales_order_list`,
  )!;
  assert.equal(
    'exportMaximumResultCount' in query && query.exportMaximumResultCount,
    5000,
  );
});

test('a List declaration is refused for each combination the runtime cannot honour', () => {
  const cases: Array<[string, (app: ReturnType<typeof application>) => void]> =
    [
      [
        'list columns read fields the query selects',
        (app) => {
          listOf(app).list.columns[0]!.field = `${ns}:field.party_name`;
        },
      ],
      [
        'exactly one title column',
        (app) => {
          listOf(app).list.columns[1]!.role = 'title';
        },
      ],
      [
        'default sort names a sortable column',
        (app) => {
          listOf(app).list.columns.find((column) =>
            String(column.columnId).endsWith('_order_date'),
          )!.sortable = false;
        },
      ],
      [
        'an enumeration filter value is one of its options',
        (app) => {
          (listOf(app).list.views[1]!.filters as Json[])[0]!.value =
            `${ns}:state.sales_order_shipped`;
        },
      ],
      [
        'saved views and the savedViews slot are declared together',
        (app) => {
          const { surface } = listOf(app);
          surface.slots = (surface.slots as Json[]).filter(
            (slot) => slot.slot !== 'savedViews',
          );
        },
      ],
      [
        'page size exceeds the query maximum result count',
        (app) => {
          listOf(app).list.pageSize = 100;
          app.queries.find(
            (query) => query.queryId === `${ns}:query.sales_order_list`,
          )!.maximumResultCount = 40;
        },
      ],
      [
        'export requires the query to declare its export limit',
        (app) => {
          delete app.queries.find(
            (query) => query.queryId === `${ns}:query.sales_order_list`,
          )!.exportMaximumResultCount;
        },
      ],
      [
        'only a list query declares an export limit',
        (app) => {
          app.queries.find(
            (query) => query.queryId === `${ns}:query.sales_order_get`,
          )!.exportMaximumResultCount = 10;
        },
      ],
      [
        'active unscoped q0 list query',
        (app) => {
          const column = listOf(app).list.columns.find(
            (value) => value.reference,
          )!;
          (column.reference as { query: { targetId: string } }).query.targetId =
            `${ns}:query.purchase_order_list`;
        },
      ],
      [
        'compare stored values, not labels',
        (app) => {
          const { list } = listOf(app);
          const customer = list.columns.find((value) => value.reference)!;
          (list.filters[0] as Json).field = customer.field;
          (list.filters[0] as Json).options = [
            { value: 'x', label: 'Someone' },
          ];
        },
      ],
      [
        'a filter field is not also a view field',
        (app) => {
          const { list } = listOf(app);
          (list.filters[0] as Json).field = (
            (list.views[1]!.filters as Json[])[0] as Json
          ).field;
          (list.filters[0] as Json).options = [
            { value: `${ns}:state.sales_order_draft`, label: 'Draft' },
          ];
        },
      ],
      [
        'a date column reads a date or date-time field',
        (app) => {
          listOf(app).list.columns.find(
            (value) => value.role === 'title',
          )!.format = 'date';
        },
      ],
      [
        'status roles belong to a status column',
        (app) => {
          listOf(app).list.columns.find(
            (value) => value.role === 'title',
          )!.statusRoles = [{ value: 'x', role: 'success' }];
        },
      ],
      [
        'at most four fields',
        (app) => {
          const { list } = listOf(app);
          for (const local of ['number', 'notes', 'order_date'])
            list.filters.push({
              filterId: `${ns}:list_filter.sales_order_list_${local}`,
              label: local,
              orderKey: 90,
              field: `${ns}:field.sales_order_${local}`,
              options: [{ value: 'x', label: 'x' }],
            });
        },
      ],
    ];
  const outcomes = cases.map(([reason, mutate]) => [reason, refused(mutate)]);
  for (const [reason, rule] of outcomes)
    assert.match(rule!, new RegExp(reason!), `${reason!} -> ${rule!}`);
});

test('List progress, open and before views and overdue dates are refused for each misuse the runtime cannot honour', () => {
  type Progress = {
    lines: { query: { targetId: string }; relation: string; quantity: string };
    done: { query: { targetId: string }; relation: string; quantity: string };
    openIn?: { field: string; values: string[] };
    outputs: { ordered: string; done: string; open: string };
  };
  const expected = (app: ReturnType<typeof application>) => {
    const { list } = listOf(app, expectedList);
    const column = (local: string) =>
      list.columns.find(
        (value) =>
          value.columnId === `${ns}:list_column.expected_receipt_list_${local}`,
      )!;
    const view = (local: string) =>
      list.views.find(
        (value) =>
          value.viewId === `${ns}:list_view.expected_receipt_list_${local}`,
      )!;
    return { list, column, view, progress: list.progress as Progress };
  };
  const cases: Array<[string, (app: ReturnType<typeof application>) => void]> =
    [
      [
        'a progress column is an unsorted plain value',
        (app) => {
          expected(app).column('open').sortable = true;
        },
      ],
      [
        "an open view needs the List's declared progress",
        (app) => {
          // The Invoices List declares no progress (the order Lists do).
          listOf(app, invoiceList).list.views[1]!.open = true;
        },
      ],
      [
        'a before view compares a selected date or UTC instant field',
        (app) => {
          (expected(app).view('late').before as { field: string }).field =
            `${ns}:field.purchase_order_number`;
        },
      ],
      [
        'an overdue marker names a view that keeps rows before today on its own date',
        (app) => {
          (
            expected(app).column('expected_date').overdue as { view: string }
          ).view = `${ns}:list_view.expected_receipt_list_to_receive`;
        },
      ],
      [
        'list progress reads an active q0 list query',
        (app) => {
          expected(app).progress.lines.query.targetId =
            `${ns}:query.purchase_order_line_get`;
        },
      ],
      [
        'list progress sums an exact decimal its query selects',
        (app) => {
          expected(app).progress.done.quantity =
            `${ns}:field.purchase_order_received_unit_id`;
        },
      ],
      [
        "list progress lines are the List's children through a parentScopedChild relation",
        (app) => {
          expected(app).progress.lines.relation =
            `${ns}:relation.purchase_order_received_order_line`;
        },
      ],
      [
        'list progress done rows point at its lines through a relation',
        (app) => {
          expected(app).progress.done.relation =
            `${ns}:relation.purchase_order_line_order`;
        },
      ],
      [
        'list progress outputs must be unique',
        (app) => {
          const { column, progress } = expected(app);
          progress.outputs.open = progress.outputs.ordered;
          column('open').field = progress.outputs.ordered;
        },
      ],
      [
        'list progress outputs name no field or column',
        (app) => {
          const { column, progress } = expected(app);
          progress.outputs.open = `${ns}:field.purchase_order_notes`;
          column('open').field = `${ns}:field.purchase_order_notes`;
        },
      ],
      [
        'an enumeration filter value is one of its options',
        (app) => {
          expected(app).progress.openIn!.values = [
            `${ns}:state.purchase_order_shipped`,
          ];
        },
      ],
      [
        'list progress reads company rows only under a company List',
        (app) => {
          // The same progress on an unscoped List: nothing issues it a company.
          const query = app.queries.find(
            (value) => value.queryId === `${ns}:query.expected_receipt_list`,
          )!;
          delete query.legalEntityScope;
          delete query.parameters;
          delete (listOf(app, expectedList).surface.workspace as Json).entry;
        },
      ],
    ];
  const outcomes = cases.map(([reason, mutate]) => [reason, refused(mutate)]);
  for (const [reason, rule] of outcomes)
    assert.match(
      rule!,
      new RegExp(reason!.replace(/[()']/gu, '.')),
      `${reason!} -> ${rule!}`,
    );
  // Closed keys: an unknown progress or view member is refused, not ignored.
  assert.match(
    refused((app) => {
      (expected(app).progress as unknown as Json).sortable = true;
    }),
    /closed supported schema/u,
  );
  assert.match(
    refused((app) => {
      (expected(app).view('late').before as Json).anchor = 'now';
    }),
    /closed supported schema|anchor/u,
  );
});

test('List row actions, supplementary progress and read-model columns are refused for each misuse the runtime cannot honour', () => {
  type RowAction = {
    actionId: string;
    label: string;
    orderKey: number;
    when?: { filters?: Json[]; open?: true };
    section?: string;
  };
  const purchase = (app: ReturnType<typeof application>) => {
    const { list, surface } = listOf(app, purchaseList);
    const column = (local: string) =>
      list.columns.find(
        (value) =>
          value.columnId === `${ns}:list_column.purchase_order_list_${local}`,
      )!;
    return {
      list,
      surface,
      column,
      progress: list.progress as {
        outputs: Record<string, string>;
        whenDenied?: string;
      },
      actions: list.rowActions as RowAction[],
    };
  };
  const sales = (app: ReturnType<typeof application>) =>
    listOf(app).list.rowActions as RowAction[];
  const cases: Array<[string, (app: ReturnType<typeof application>) => void]> =
    [
      [
        'a read-model column is an unsorted value, plain or money',
        (app) => {
          purchase(app).column('total').sortable = true;
        },
      ],
      [
        'a read-model column is an unsorted value, plain or money',
        (app) => {
          purchase(app).column('total').format = 'date';
        },
      ],
      [
        // Nothing before the page can read a read-model figure.
        'list views and filters read fields the query selects',
        (app) => {
          (purchase(app).list.views[0]!.filters as Json[]).push({
            field: `${ns}:metric.order_total`,
            value: '10',
          });
        },
      ],
      [
        'list progress outputs name no read-model figure',
        (app) => {
          const { column, progress } = purchase(app);
          progress.outputs.open = `${ns}:metric.order_total`;
          column('open').field = `${ns}:metric.order_total`;
          column('total').field = `${ns}:metric.order_tax`;
        },
      ],
      [
        'a List that omits denied progress keeps a view that does not need it',
        (app) => {
          const { list } = listOf(app, expectedList);
          (list.progress as { whenDenied?: string }).whenDenied = 'omit';
          for (const view of list.views) view.open = true;
        },
      ],
      [
        'list row action ids must be unique',
        (app) => {
          const actions = sales(app);
          actions[1]!.actionId = actions[0]!.actionId;
        },
      ],
      [
        'an unconditional row action is the last one',
        (app) => {
          sales(app).at(-1)!.orderKey = 5;
        },
      ],
      [
        'a row action condition names a filter, open or supply',
        (app) => {
          sales(app)[0]!.when = {};
        },
      ],
      [
        'row action filter fields must be unique',
        (app) => {
          const when = sales(app)[0]!.when!;
          when.filters = [...when.filters!, { ...when.filters![0]! }];
        },
      ],
      [
        'list views and filters read fields the query selects',
        (app) => {
          sales(app)[0]!.when!.filters![0]!.field = `${ns}:field.party_name`;
        },
      ],
      [
        'an enumeration filter value is one of its options',
        (app) => {
          sales(app)[0]!.when!.filters![0]!.value =
            `${ns}:state.sales_order_shipped`;
        },
      ],
      [
        "a row action's open condition needs the List's declared progress",
        (app) => {
          listOf(app, invoiceList).list.rowActions = [
            {
              actionId: `${ns}:list_row_action.customer_invoice_list_pay`,
              label: 'Pay',
              orderKey: 10,
              when: { open: true },
            },
          ];
        },
      ],
      [
        "a row action's section is a dataset of the List's record page",
        (app) => {
          sales(app)[0]!.section = `${ns}:dataset.purchasing_lines`;
        },
      ],
      [
        "list row actions link to the record page of the List's rows",
        (app) => {
          // Stock balances with no active record page to open.
          app.surfaces.find(
            (value) =>
              value.surfaceId === `${ns}:surface.posted_stock_balance_detail`,
          )!.lifecycle = 'retired';
          listOf(
            app,
            `${ns}:surface.posted_stock_balance_list`,
          ).list.rowActions = [
            {
              actionId: `${ns}:list_row_action.posted_stock_balance_list_view`,
              label: 'View',
              orderKey: 10,
            },
          ];
        },
      ],
    ];
  const outcomes = cases.map(([reason, mutate]) => [reason, refused(mutate)]);
  for (const [reason, rule] of outcomes)
    assert.match(
      rule!,
      new RegExp(reason!.replace(/[()']/gu, '.')),
      `${reason!} -> ${rule!}`,
    );
  // Closed keys and bounds: an unknown member, a fourth action or an unknown
  // denial treatment is refused, not ignored.
  assert.match(
    refused((app) => {
      (sales(app)[0] as unknown as Json).bulk = true;
    }),
    /closed supported schema/u,
  );
  assert.match(
    refused((app) => {
      const actions = sales(app);
      for (const local of ['a', 'b'])
        actions.push({
          ...actions[1]!,
          actionId: `${ns}:list_row_action.sales_order_list_${local}`,
        });
    }),
    /closed supported schema/u,
  );
  assert.match(
    refused((app) => {
      purchase(app).progress.whenDenied = 'zero';
    }),
    /closed supported schema/u,
  );
  // Omitting the new keys still normalizes: both are optional.
  const app = application();
  delete listOf(app).list.rowActions;
  delete (listOf(app).list.progress as { whenDenied?: string }).whenDenied;
  assert.doesNotThrow(() => normalizeApplicationPackage(app as never));
});

test('SUPPLY-WARNINGS: a List progress supply, its views and its row actions are refused for each misuse the runtime cannot honour', () => {
  type Sum = {
    rows: { query: { targetId: string }; match: string; quantity?: string };
    within?: Json;
    related?: {
      query: { targetId: string };
      relation: string;
      quantity: string;
    };
    sum: string;
  };
  type Supply = {
    coverage: {
      query: { targetId: string };
      relation: string;
      related: {
        query: { targetId: string };
        relation: string;
        quantity: string;
      };
    };
    item: string;
    free: { plus: Sum[]; minus: Sum[] };
    shortIn?: { field: string; values: string[] };
    outputs: { covered: string; short: string };
    whenDenied?: string;
  };
  const sales = (app: ReturnType<typeof application>) => {
    const { list } = listOf(app);
    const progress = list.progress as {
      outputs: Record<string, string>;
      supply: Supply;
    };
    return {
      list,
      progress,
      supply: progress.supply,
      column: (local: string) =>
        list.columns.find(
          (value) =>
            value.columnId === `${ns}:list_column.sales_order_list_${local}`,
        )!,
    };
  };
  const query = (local: string) => `${ns}:query.${local}`;
  const field = (local: string) => `${ns}:field.${local}`;
  const relation = (local: string) => `${ns}:relation.${local}`;
  const cases: Array<[string, (app: ReturnType<typeof application>) => void]> =
    [
      [
        // The line list carries a read model the statement never runs.
        'list supply reads active q0 list queries without a read model',
        (app) => {
          sales(app).supply.coverage.query.targetId = query('reservation_list');
        },
      ],
      [
        "list supply coverage rows point at the List's lines through a relation",
        (app) => {
          sales(app).supply.coverage.relation = relation(
            'reservation_balance_reservation',
          );
        },
      ],
      [
        'list supply coverage holds what related rows pointing at it hold',
        (app) => {
          sales(app).supply.coverage.related.relation = relation(
            'reservation_order_line',
          );
        },
      ],
      [
        'list supply adds an exact decimal its query selects',
        (app) => {
          sales(app).supply.coverage.related.quantity = field(
            'reservation_balance_unit_id',
          );
        },
      ],
      [
        "list supply names a line's item by a text field the lines' query selects",
        (app) => {
          sales(app).supply.item = field('sales_order_line_ordered_quantity');
        },
      ],
      [
        "list supply names a line's item by a text field the lines' query selects",
        (app) => {
          sales(app).supply.item = field('posted_stock_balance_item_id');
        },
      ],
      [
        "a supply sum's rows hold the item's id in a text field their query selects",
        (app) => {
          sales(app).supply.free.plus[0]!.rows.match = field(
            'posted_stock_balance_posted_quantity',
          );
        },
      ],
      [
        'a supply sum names exactly the parts it adds up',
        (app) => {
          sales(app).supply.free.plus[0]!.sum = 'related';
        },
      ],
      [
        'a supply sum names exactly the parts it adds up',
        (app) => {
          delete sales(app).supply.free.minus[0]!.related;
        },
      ],
      [
        "a supply sum's related rows point at its rows through a relation",
        (app) => {
          sales(app).supply.free.minus[0]!.related!.relation = relation(
            'reservation_order_line',
          );
        },
      ],
      [
        'list supply adds an exact decimal its query selects',
        (app) => {
          sales(app).supply.free.plus[0]!.rows.quantity = field(
            'posted_stock_balance_unit_id',
          );
        },
      ],
      [
        "a figure's parent is the record whose id its rows hold in a text field their query selects",
        (app) => {
          (sales(app).supply.free.plus[0]!.within as Json).reference = field(
            'posted_stock_balance_posted_quantity',
          );
        },
      ],
      [
        'list supply reads active q0 list queries without a read model',
        (app) => {
          (
            (sales(app).supply.free.plus[0]!.within as Json).query as {
              targetId: string;
            }
          ).targetId = query('location_get');
        },
      ],
      [
        'an enumeration filter value is one of its options',
        (app) => {
          sales(app).supply.shortIn!.values = [
            `${ns}:state.sales_order_shipped`,
          ];
        },
      ],
      [
        'supply short values must be unique',
        (app) => {
          const { shortIn } = sales(app).supply;
          shortIn!.values = [shortIn!.values[0]!, shortIn!.values[0]!];
        },
      ],
      [
        'progress outputs must be unique',
        (app) => {
          const { progress, supply } = sales(app);
          supply.outputs.covered = progress.outputs.open!;
        },
      ],
      [
        'list progress outputs name no field or column',
        (app) => {
          const { supply, column } = sales(app);
          supply.outputs.short = field('sales_order_notes');
          column('short').field = field('sales_order_notes');
        },
      ],
      [
        'a progress column is an unsorted plain value',
        (app) => {
          sales(app).column('short').sortable = true;
        },
      ],
      [
        'a List that omits denied supply keeps a view that does not need it',
        (app) => {
          for (const view of sales(app).list.views) view.supply = 'short';
        },
      ],
      [
        "a supply view needs the List's declared supply",
        (app) => {
          listOf(app, purchaseList).list.views[0]!.supply = 'covered';
        },
      ],
      [
        "a row action's supply condition needs the List's declared supply",
        (app) => {
          const actions = listOf(app, purchaseList).list.rowActions as Array<{
            when?: Json;
          }>;
          actions[0]!.when = { supply: 'covered' };
        },
      ],
      [
        // A view keeps covered or short rows only.
        'closed supported schema',
        (app) => {
          sales(app).list.views[2]!.supply = 'incoming';
        },
      ],
    ];
  const outcomes = cases.map(([reason, mutate]) => [reason, refused(mutate)]);
  for (const [reason, rule] of outcomes)
    assert.match(
      rule!,
      new RegExp(reason!.replace(/[()']/gu, '.')),
      `${reason!} -> ${rule!}`,
    );
});

test('RECEIVING-EXTRAS: a List supply sums what placed purchase orders still have to receive, stated exactly when it is summed', () => {
  type Sum = {
    rows: { query: { targetId: string }; match: string; quantity?: string };
    within?: Json;
    related?: { relation: string };
    sum: string;
  };
  type Supply = {
    incoming?: Sum[];
    outputs: { covered: string; short: string; incoming?: string };
  };
  const supply = (app: ReturnType<typeof application>) =>
    (listOf(app).list.progress as { supply: Supply }).supply;
  const incomingColumn = (app: ReturnType<typeof application>) =>
    listOf(app).list.columns.find(
      (value) =>
        value.columnId === `${ns}:list_column.sales_order_list_incoming`,
    )!;
  // As declared: one part, each released order line less what it received.
  const declared = supply(application());
  assert.deepEqual(
    declared.incoming?.map((sum) => [
      sum.rows.query.targetId,
      sum.rows.match,
      sum.sum,
      (sum.within as { values: string[] }).values,
    ]),
    [
      [
        `${ns}:query.purchase_order_line_list`,
        `${ns}:field.purchase_order_line_item_id`,
        'remaining',
        [`${ns}:state.purchase_order_released`],
      ],
    ],
  );
  assert.equal(
    declared.outputs.incoming,
    `${ns}:list_output.sales_order_list_incoming`,
  );
  const cases: Array<[string, (app: ReturnType<typeof application>) => void]> =
    [
      [
        'list supply states incoming supply exactly when it sums it',
        (app) => {
          delete supply(app).outputs.incoming;
          const columns = listOf(app).list.columns;
          columns.splice(columns.indexOf(incomingColumn(app)), 1);
        },
      ],
      [
        'list supply states incoming supply exactly when it sums it',
        (app) => {
          delete supply(app).incoming;
        },
      ],
      [
        'a supply sum names exactly the parts it adds up',
        (app) => {
          delete supply(app).incoming![0]!.related;
        },
      ],
      [
        "a supply sum's rows hold the item's id in a text field their query selects",
        (app) => {
          supply(app).incoming![0]!.rows.match =
            `${ns}:field.purchase_order_line_ordered_quantity`;
        },
      ],
      [
        "a supply sum's related rows point at its rows through a relation",
        (app) => {
          supply(app).incoming![0]!.related!.relation =
            `${ns}:relation.reservation_balance_reservation`;
        },
      ],
      [
        'progress outputs must be unique',
        (app) => {
          const outputs = supply(app).outputs;
          outputs.incoming = outputs.short;
          incomingColumn(app).field = outputs.short;
        },
      ],
      [
        'a progress column is an unsorted plain value',
        (app) => {
          incomingColumn(app).sortable = true;
        },
      ],
    ];
  for (const [reason, mutate] of cases) {
    const rule = refused(mutate);
    assert.match(
      rule,
      new RegExp(reason.replace(/[()']/gu, '.')),
      `${reason} -> ${rule}`,
    );
  }
});

test('REPLENISHMENT: Stock by item and the Buying worklist read items in one company, with figures their statement adds up', () => {
  const normalized = normalizeApplicationPackage(
    composedApplicationDefinition() as never,
  );
  type Selected = { selections: Array<{ field: { targetId: string } }> };
  const query = (local: string) =>
    normalized.queries.find(
      (value) => value.queryId === `${ns}:query.${local}`,
    )! as unknown as Selected & {
      legalEntityScope?: { cardinality: string };
      exportMaximumResultCount?: number;
      permission: { targetId: string };
    };
  const items = query('item_list');
  // The Items List and its query are untouched: no company, no export.
  assert.equal(items.legalEntityScope, undefined);
  assert.equal(items.exportMaximumResultCount, undefined);
  for (const local of ['item_stock_list', 'item_buying_list']) {
    const clone = query(local);
    assert.deepEqual(
      clone.selections.map((selection) => selection.field.targetId),
      items.selections.map((selection) => selection.field.targetId),
    );
    assert.equal(clone.permission.targetId, items.permission.targetId);
    assert.equal(clone.legalEntityScope?.cardinality, 'exactlyOne');
    assert.equal(clone.exportMaximumResultCount, 5000);
  }
  type Declared = {
    label: string;
    module: { targetId: string };
    slots: Array<{ slot: string }>;
    workspace: {
      membership: string;
      navigationModuleId?: string;
      entry?: { authorizationQueryId: string };
    };
    list: {
      columns: Array<{
        label: string;
        field: string;
        role: string;
        sortable: boolean;
        statusRoles?: Array<{ value: string; role: string }>;
      }>;
      views: Array<{
        label: string;
        band?: { figure: string; values: string[] };
      }>;
      defaultSort: Array<{ columnId: string; direction: string }>;
      figures: {
        sums: Array<{ figureId: string; sum: string }>;
        totals?: Array<{ figureId: string; floor?: string }>;
        bands?: Array<{ figureId: string; of: string }>;
        latest?: Array<{ figureId: string }>;
      };
    };
  };
  const declared = (surfaceId: string) =>
    normalized.surfaces.find(
      (surface) => surface.surfaceId === surfaceId,
    ) as unknown as Declared;
  const figure = (list: string, local: string) =>
    `${ns}:list_figure.${list}_${local}`;
  const stock = declared(stockList);
  const buying = declared(buyingList);
  for (const surface of [stock, buying]) {
    // Catalog's Lists, listed in Inventory's group, entered like Posted
    // stock and authorized by its query; read-only.
    assert.equal(surface.module.targetId, `${ns}:module.catalog`);
    assert.equal(surface.workspace.membership, 'operational');
    assert.equal(
      surface.workspace.navigationModuleId,
      `${ns}:module.inventory`,
    );
    assert.equal(
      surface.workspace.entry?.authorizationQueryId,
      `${ns}:query.posted_stock_balance_list`,
    );
    assert.deepEqual(
      surface.slots.map((slot) => slot.slot),
      ['title', 'savedViews', 'dataGrid'],
    );
    assert.equal('rowActions' in surface.list, false);
    // Figures are shown, never sorted: only the item's own fields sort.
    assert.deepEqual(
      surface.list.columns
        .filter((column) => column.field.includes(':list_figure.'))
        .map((column) => column.sortable),
      surface.list.columns
        .filter((column) => column.field.includes(':list_figure.'))
        .map(() => false),
    );
  }
  assert.equal(stock.label, 'Stock by item');
  assert.deepEqual(
    stock.list.columns.map((column) => column.label),
    [
      'SKU',
      'Item',
      'Unit',
      'On hand',
      'Usable',
      'Reserved',
      'Available',
      'Incoming',
      'Open demand',
      'Projected',
      'Reorder point',
      'Status',
    ],
  );
  assert.deepEqual(
    stock.list.views.map((value) => [value.label, value.band?.values]),
    [
      ['All', undefined],
      ['Shortage', [`${ns}:list_band.item_stock_list_shortage`]],
      ['Reorder', [`${ns}:list_band.item_stock_list_reorder`]],
    ],
  );
  assert.deepEqual(
    stock.list.figures.sums.map((value) => [value.figureId, value.sum]),
    [
      [figure('item_stock_list', 'on_hand'), 'rows'],
      [figure('item_stock_list', 'usable'), 'rows'],
      [figure('item_stock_list', 'reserved'), 'related'],
      [figure('item_stock_list', 'reserved_usable'), 'related'],
      [figure('item_stock_list', 'incoming'), 'remaining'],
      [figure('item_stock_list', 'open_demand'), 'remaining'],
    ],
  );
  // LOCATIONS: Usable, and what reservations hold, only at a usable location
  // -- reached through the location id the rows hold, not a relation.
  for (const [local, holder] of [
    ['usable', 'posted_stock_balance_location_id'],
    ['reserved_usable', 'reservation_location_id'],
  ] as const)
    assert.deepEqual(
      (
        stock.list.figures.sums.find(
          (value) => value.figureId === figure('item_stock_list', local),
        ) as unknown as { within: Json }
      ).within,
      {
        reference: `${ns}:field.${holder}`,
        query: {
          kind: 'queryReference',
          schemaVersion: 'v6',
          targetId: `${ns}:query.location_list`,
        },
        field: `${ns}:field.location_status`,
        values: [`${ns}:option.location_status_usable`],
      },
    );
  // Available and Projected start from usable stock, not on hand.
  assert.deepEqual(
    (
      stock.list.figures.totals as unknown as Array<{
        figureId: string;
        plus: Json[];
        minus: Json[];
      }>
    ).map((value) => [value.figureId, value.plus, value.minus]),
    [
      [
        figure('item_stock_list', 'available'),
        [{ figure: figure('item_stock_list', 'usable') }],
        [{ figure: figure('item_stock_list', 'reserved_usable') }],
      ],
      [
        figure('item_stock_list', 'projected'),
        [
          { figure: figure('item_stock_list', 'usable') },
          { figure: figure('item_stock_list', 'incoming') },
        ],
        [{ figure: figure('item_stock_list', 'open_demand') }],
      ],
    ],
  );
  assert.deepEqual(
    stock.list.columns.find((column) => column.role === 'status')!.statusRoles,
    [
      { value: `${ns}:list_band.item_stock_list_shortage`, role: 'blocked' },
      { value: `${ns}:list_band.item_stock_list_reorder`, role: 'attention' },
      { value: `${ns}:list_band.item_stock_list_healthy`, role: 'success' },
    ],
  );
  assert.equal(buying.label, 'Buying worklist');
  assert.deepEqual(
    buying.list.columns.map((column) => column.label),
    [
      'SKU',
      'Item',
      'Unit',
      'Usable',
      'Available',
      'Incoming',
      'Open demand',
      'Projected',
      'Reorder point',
      'Reorder up to',
      'Suggested',
      'Last supplier',
    ],
  );
  assert.deepEqual(
    buying.list.views.map((value) => [value.label, value.band]),
    [
      [
        'To buy',
        {
          figure: figure('item_buying_list', 'due'),
          values: [`${ns}:list_band.item_buying_list_due`],
        },
      ],
    ],
  );
  // Suggested restores the item's level, never below zero.
  assert.equal(
    buying.list.figures.totals!.find(
      (value) => value.figureId === figure('item_buying_list', 'suggested'),
    )!.floor,
    'zero',
  );
  assert.deepEqual(
    buying.list.figures.latest!.map((value) => value.figureId),
    [figure('item_buying_list', 'last_supplier')],
  );
  for (const surface of [stock, buying])
    assert.deepEqual(surface.list.defaultSort, [
      {
        columnId: `${ns}:list_column.${surface === stock ? 'item_stock_list' : 'item_buying_list'}_sku`,
        direction: 'ascending',
      },
    ]);
});

test('LOCATIONS: the Location List shows each location type and inventory status and filters by either', () => {
  const normalized = normalizeApplicationPackage(
    composedApplicationDefinition() as never,
  );
  const location = normalized.surfaces.find(
    (surface) => surface.surfaceId === `${ns}:surface.location_list`,
  ) as unknown as {
    workspace: { membership: string };
    list: {
      columns: Array<{
        label: string;
        role: string;
        sortable: boolean;
        statusRoles?: Array<{ value: string; role: string }>;
      }>;
      filters: Array<{
        label: string;
        field: string;
        options: Array<{ value: string; label: string }>;
      }>;
      views: Json[];
      export?: Json;
    };
  };
  const status = (local: string) => `${ns}:option.location_status_${local}`;
  // A setup List, as before: no company, no export, no saved views.
  assert.equal(location.workspace.membership, 'setup');
  assert.deepEqual(location.list.views, []);
  assert.equal(location.list.export, undefined);
  assert.deepEqual(
    location.list.columns.map((column) => [
      column.label,
      column.role,
      column.sortable,
    ]),
    [
      ['Code', 'title', true],
      ['Name', 'value', true],
      ['Type', 'value', true],
      ['Inventory status', 'status', true],
      ['Status reason', 'value', false],
    ],
  );
  assert.deepEqual(
    location.list.columns.find((column) => column.role === 'status')!
      .statusRoles,
    [
      { value: status('usable'), role: 'success' },
      { value: status('quarantine'), role: 'attention' },
      { value: status('damaged'), role: 'blocked' },
      { value: status('in_transit'), role: 'inProgress' },
      { value: status('return_pending'), role: 'attention' },
    ],
  );
  const [byStatus, byType] = location.list.filters;
  assert.equal(byStatus!.field, `${ns}:field.location_status`);
  assert.deepEqual(
    byStatus!.options.map((option) => option.label),
    ['Usable', 'Quarantine', 'Damaged', 'In transit', 'Return pending'],
  );
  // Every type a location may have: a warehouse and a store as before, and
  // the widened ones (owner ruling L-B).
  assert.equal(byType!.field, `${ns}:field.location_type`);
  assert.deepEqual(
    byType!.options.map((option) => option.label),
    [
      'Warehouse',
      'Store',
      'Storage',
      'Receiving',
      'Shipping',
      'Quarantine',
      'In transit',
      'Scrap',
      'Yard',
    ],
  );
  const typeField = normalized.fields.find(
    (field) => field.fieldId === `${ns}:field.location_type`,
  )!;
  assert.deepEqual(
    typeField.fieldType.kind === 'enumFieldType'
      ? typeField.fieldType.options.map((option) => option.optionId)
      : [],
    byType!.options.map((option) => option.value),
  );
});

test('List figures and band views are refused for each misuse the runtime cannot honour', () => {
  type Figures = {
    sums: Array<
      Json & {
        figureId: string;
        rows: { query: { targetId: string }; match: string; quantity?: string };
        within?: {
          relation?: string;
          reference?: string;
          query: { targetId: string };
          field: string;
          values: string[];
        };
        related?: {
          query: { targetId: string };
          relation: string;
          quantity: string;
        };
        sum: string;
      }
    >;
    totals: Array<
      Json & {
        figureId: string;
        plus: Json[];
        minus: Json[];
      }
    >;
    bands: Array<
      Json & {
        figureId: string;
        of: string;
        cases: Array<Json & { value: string }>;
        otherwise: Json & { value: string };
      }
    >;
    latest: Array<
      Json & {
        figureId: string;
        by: string;
        value: string;
        label: { query: { targetId: string }; field: string };
      }
    >;
  };
  const figures = (
    app: ReturnType<typeof application>,
    surfaceId = stockList,
  ) => listOf(app, surfaceId).list.figures as Figures;
  const column = (
    app: ReturnType<typeof application>,
    local: string,
    surfaceId = stockList,
  ) =>
    listOf(app, surfaceId).list.columns.find((value) =>
      String(value.columnId).endsWith(`_list_${local}`),
    )!;
  const sum = (app: ReturnType<typeof application>, local: string) =>
    figures(app).sums.find((value) => value.figureId.endsWith(`_${local}`))!;
  const field = (local: string) => `${ns}:field.${local}`;
  const queryRef = (local: string) => ({
    kind: 'queryReference',
    schemaVersion: 'v6',
    targetId: `${ns}:query.${local}`,
  });
  const cases: Array<[string, (app: ReturnType<typeof application>) => void]> =
    [
      [
        'list figures read active q0 list queries without a read model',
        (app) => {
          // The fulfillment read model's copy of the posted stock list.
          sum(app, 'on_hand').rows.query = queryRef('item_stock_positions');
        },
      ],
      [
        'list figures read active q0 list queries without a read model',
        (app) => {
          sum(app, 'on_hand').rows.query = queryRef('posted_stock_balance_get');
        },
      ],
      [
        "a figure's rows hold the listed record's id in a text field their query selects",
        (app) => {
          // A unit code could never hold a record id.
          sum(app, 'on_hand').rows.match = field(
            'posted_stock_balance_unit_id',
          );
        },
      ],
      [
        "a figure's rows hold the listed record's id in a text field their query selects",
        (app) => {
          // Another entity's item field.
          sum(app, 'on_hand').rows.match = field('reservation_item_id');
        },
      ],
      [
        'a figure sums an exact decimal its query selects',
        (app) => {
          sum(app, 'on_hand').rows.quantity = field(
            'posted_stock_balance_location_id',
          );
        },
      ],
      [
        'a figure names exactly the parts its sum adds up',
        (app) => {
          sum(app, 'on_hand').sum = 'remaining';
        },
      ],
      [
        'a figure names exactly the parts its sum adds up',
        (app) => {
          delete sum(app, 'reserved').related;
        },
      ],
      [
        "a figure's related rows point at its rows through a relation",
        (app) => {
          sum(app, 'incoming').related!.relation =
            `${ns}:relation.purchase_order_line_order`;
        },
      ],
      [
        "a figure's parent is its rows' parent through a relation",
        (app) => {
          sum(app, 'incoming').within!.relation =
            `${ns}:relation.sales_order_line_order`;
        },
      ],
      [
        "a figure's parent values are values of a field its parent query selects",
        (app) => {
          sum(app, 'incoming').within!.values = [
            `${ns}:state.purchase_order_shipped`,
          ];
        },
      ],
      [
        "a figure's parent values are values of a field its parent query selects",
        (app) => {
          sum(app, 'incoming').within!.field = field('item_name');
        },
      ],
      [
        "a figure's parent is the record whose id its rows hold in a text field their query selects",
        (app) => {
          // A unit code could never hold a location's id.
          sum(app, 'usable').within!.reference = field(
            'posted_stock_balance_unit_id',
          );
        },
      ],
      [
        "a figure's parent is the record whose id its rows hold in a text field their query selects",
        (app) => {
          // Another entity's location field.
          sum(app, 'usable').within!.reference = field(
            'reservation_location_id',
          );
        },
      ],
      [
        "a figure's parent values are values of a field its parent query selects",
        (app) => {
          // A location type is not an inventory status.
          sum(app, 'usable').within!.values = [`${ns}:option.warehouse`];
        },
      ],
      [
        'list figures read active q0 list queries without a read model',
        (app) => {
          // A location is read through its List, never its get.
          sum(app, 'usable').within!.query = queryRef('location_get');
        },
      ],
      [
        'list figures read company rows only under a company List',
        (app) => {
          // The same figures on an unscoped List: nothing issues it a company.
          const query = app.queries.find(
            (value) => value.queryId === `${ns}:query.item_stock_list`,
          )!;
          delete query.legalEntityScope;
          delete query.parameters;
          delete (listOf(app, stockList).surface.workspace as Json).entry;
        },
      ],
      [
        'a total adds figures declared before it or exact decimals the List selects',
        (app) => {
          // Projected is declared after Available.
          figures(app).totals[0]!.plus = [
            { figure: figures(app).totals[1]!.figureId },
          ];
        },
      ],
      [
        'a total adds figures declared before it or exact decimals the List selects',
        (app) => {
          figures(app).totals[0]!.plus = [{ field: field('item_name') }];
        },
      ],
      [
        'a band names the range of a sum or a total',
        (app) => {
          figures(app).bands[0]!.of = figures(app).bands[0]!.figureId;
        },
      ],
      [
        'a band case compares with one fixed decimal or exact decimal the List selects',
        (app) => {
          const [first] = figures(app).bands[0]!.cases;
          first!.atMost = { value: '0' };
        },
      ],
      [
        'a band case compares with one fixed decimal or exact decimal the List selects',
        (app) => {
          figures(app).bands[0]!.cases[1]!.atMost = {
            field: field('item_name'),
          };
        },
      ],
      [
        'band values must be unique',
        (app) => {
          // The worklist shows no band column, so only the band is wrong.
          const band = figures(app, buyingList).bands[0]!;
          band.otherwise.value = band.cases[0]!.value;
        },
      ],
      [
        'a latest figure orders its parents by a date and reads a record id their query selects',
        (app) => {
          figures(app, buyingList).latest[0]!.by = field(
            'purchase_order_number',
          );
        },
      ],
      [
        'a latest figure orders its parents by a date and reads a record id their query selects',
        (app) => {
          figures(app, buyingList).latest[0]!.value = field(
            'purchase_order_freight_amount',
          );
        },
      ],
      [
        'a latest label reads a selected field of an active unscoped q0 list query',
        (app) => {
          // A company's purchase orders cannot name a shared party.
          figures(app, buyingList).latest[0]!.label.query = queryRef(
            'purchase_order_list',
          );
        },
      ],
      [
        'list figures name no field, column or other output',
        (app) => {
          // On hand renamed, everywhere the List names it, to a field's id.
          const { surface } = listOf(app, stockList);
          surface.list = JSON.parse(
            JSON.stringify(surface.list).replaceAll(
              sum(app, 'on_hand').figureId,
              field('party_name'),
            ),
          ) as Json;
        },
      ],
      [
        'figure ids must be unique',
        (app) => {
          sum(app, 'reserved').figureId = sum(app, 'on_hand').figureId;
          column(app, 'reserved').field = sum(app, 'on_hand').figureId;
        },
      ],
      [
        'a List declares progress or figures, not both',
        (app) => {
          // Expected receipts keeps its progress and gains the item figures.
          listOf(app, expectedList).list.figures = structuredClone(
            figures(app),
          );
        },
      ],
      [
        'a figure column is an unsorted value and a band column its status',
        (app) => {
          column(app, 'on_hand').sortable = true;
        },
      ],
      [
        'a figure column is an unsorted value and a band column its status',
        (app) => {
          column(app, 'status').role = 'value';
          delete column(app, 'status').statusRoles;
        },
      ],
      [
        'a figure column is an unsorted value and a band column its status',
        (app) => {
          column(app, 'status').statusRoles = [
            {
              value: `${ns}:list_band.item_stock_list_overstock`,
              role: 'success',
            },
          ];
        },
      ],
      [
        "a view keeps values of one of the List's band figures",
        (app) => {
          (
            listOf(app, stockList).list.views[1]!.band as { values: string[] }
          ).values = [`${ns}:list_band.item_stock_list_overstock`];
        },
      ],
      [
        "a view keeps values of one of the List's band figures",
        (app) => {
          // Projected is a total, not a band.
          (
            listOf(app, stockList).list.views[1]!.band as { figure: string }
          ).figure = figures(app).totals[1]!.figureId;
        },
      ],
    ];
  const outcomes = cases.map(([reason, mutate]) => [reason, refused(mutate)]);
  for (const [reason, rule] of outcomes)
    assert.match(
      rule!,
      new RegExp(reason!.replace(/[()']/gu, '.')),
      `${reason!} -> ${rule!}`,
    );
  // Closed keys and bounds: an unknown member, a ninth sum or a third band
  // is refused, not ignored.
  assert.match(
    refused((app) => {
      (figures(app) as unknown as Json).weights = [];
    }),
    /closed supported schema/u,
  );
  assert.match(
    refused((app) => {
      const sums = figures(app).sums;
      for (let index = sums.length; index < 9; index += 1)
        sums.push({
          ...structuredClone(sums[0]!),
          figureId: `${ns}:list_figure.item_stock_list_extra_${String(index)}`,
        });
    }),
    /closed supported schema/u,
  );
  assert.match(
    refused((app) => {
      (listOf(app, stockList).list.views[1]!.band as Json).open = true;
    }),
    /closed supported schema/u,
  );
  // A parent is reached through a relation or a reference field, never both.
  assert.match(
    refused((app) => {
      sum(app, 'usable').within!.relation =
        `${ns}:relation.purchase_order_line_order`;
    }),
    /closed supported schema/u,
  );
});

test('an unknown List key is refused rather than ignored', () => {
  assert.match(
    refused((app) => {
      listOf(app).list.bulkExport = true;
    }),
    /closed supported schema/u,
  );
});

test('a printable document is declared over the record composition and refused when it names anything undeclared', () => {
  const normalized = normalizeApplicationPackage(
    composedApplicationDefinition() as never,
  );
  const printed = normalized.surfaces.flatMap((surface) => {
    const print = (
      surface as {
        composition?: { presentation?: { print?: { label: string } } };
      }
    ).composition?.presentation?.print;
    return print ? [[surface.surfaceId, print.label]] : [];
  });
  assert.deepEqual(printed.sort(), [
    // Ruling C: the printable invoice.
    [`${ns}:surface.customer_invoice_detail`, 'Invoice'],
    [`${ns}:surface.purchase_order_detail`, 'Purchase order'],
    [`${ns}:surface.sales_order_detail`, 'Sales order'],
    // PAYABLES: the printable vendor bill.
    [`${ns}:surface.vendor_bill_detail`, 'Vendor bill'],
  ]);
  const print = (app: ReturnType<typeof application>) =>
    (
      app.surfaces.find(
        (value) => value.surfaceId === `${ns}:surface.sales_order_detail`,
      )!.composition as { presentation: { print: Json } }
    ).presentation.print;
  assert.match(
    refused((app) => {
      print(app).datasets = [`${ns}:dataset.not_a_child`];
    }),
    /a printed dataset is a declared child/u,
  );
  assert.match(
    refused((app) => {
      print(app).note = `${ns}:column.not_a_column`;
    }),
    /a printed note is a declared column/u,
  );
});
