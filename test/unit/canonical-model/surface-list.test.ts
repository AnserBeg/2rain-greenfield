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
    `${ns}:surface.posted_stock_balance_list`,
    `${ns}:surface.purchase_order_list`,
    salesList,
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
  type Declared = { list: { progress?: unknown } };
  const list = (expected as unknown as Declared).list;
  assert.ok(list.progress, 'Expected receipts declares its progress');
  assert.equal(
    (
      declared.find(
        (surface) => surface.surfaceId === `${ns}:surface.purchase_order_list`,
      ) as unknown as Declared
    ).list.progress,
    undefined,
  );
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
          listOf(app).list.views[1]!.open = true;
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
