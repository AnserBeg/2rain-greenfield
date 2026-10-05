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
    // RETURNS (ruling D): the customer returns List.
    `${ns}:surface.customer_return_list`,
    // PURCHASING-PARITY: what is still to arrive, beside Purchase orders.
    expectedList,
    // INVENTORY-PARITY: stock documents, by state and type.
    `${ns}:surface.inventory_transaction_list`,
    `${ns}:surface.posted_stock_balance_list`,
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
      progress?: { whenDenied?: string };
      rowActions?: Array<{ label: string; section?: string }>;
      views: Array<{ label: string; open?: true }>;
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
      order.list.rowActions?.map((value) => [value.label, value.section]),
      [
        [action, section],
        ['View', undefined],
      ],
    );
  }
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
          sales(app)[1]!.orderKey = 5;
        },
      ],
      [
        'a row action condition names a filter or open',
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
