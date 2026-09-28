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
    `${ns}:surface.posted_stock_balance_list`,
    `${ns}:surface.purchase_order_list`,
    salesList,
  ]);
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

test('an unknown List key is refused rather than ignored', () => {
  assert.match(
    refused((app) => {
      listOf(app).list.bulkExport = true;
    }),
    /closed supported schema/u,
  );
});
