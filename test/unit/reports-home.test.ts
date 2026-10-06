import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeApplicationPackage,
  type SurfaceList,
} from '../../packages/canonical-model/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import {
  declaredListArguments,
  declaredListParameters,
  readDeclaredListState,
} from '../../apps/web/src/list-declaration.js';
import {
  parseSharedListArguments,
  requireSharedListEcho,
  SharedListContractError,
  type SharedListCoverage,
} from '../../packages/runtime/src/list-behavior/index.js';
import { parseSharedListFigures } from '../../packages/runtime/src/list-behavior/figures.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';

/**
 * REPORTS-HOME's request contract: the figures a declared List sends -- one
 * currency, the day an age counts from, counted rows, kept values, prices,
 * a parent's match and a summary -- parsed closed, echoed exactly and bound
 * into the cursor, as the web runtime builds them from the declaration.
 */
type Json = Record<string, unknown>;
const ns = 'northstar.app';
const normalized = normalizeApplicationPackage(
  composedApplicationDefinition() as never,
);
const listOf = (local: string) =>
  (
    normalized.surfaces.find(
      (surface) => surface.surfaceId === `${ns}:surface.${local}`,
    ) as unknown as { list: SurfaceList }
  ).list;
const aging = listOf('receivables_aging_list');
const accounts = listOf('customer_account_list');
const now = new Date('2026-10-06T15:42:00.000Z');

/** The `list` argument the web runtime sends for one view and currency. */
function sent(
  list: SurfaceList,
  local: string,
  url = 'http://list.local/',
  mode: 'count' | 'export' | 'page' = 'page',
) {
  const args = declaredListArguments(
    list,
    readDeclaredListState(list, new URL(url)),
    {
      mode,
      now,
      queryId: `${ns}:query.${local}`,
      scopeArguments: {
        [`${ns}:parameter.${local}_legal_entity_scope`]:
          '00000000-0000-4000-8000-000000000001',
      },
    },
  ) as { list: Json & { figures: Json } };
  return args;
}

const parse = (args: unknown, local: string) =>
  parseSharedListArguments(args as never, {
    declaredParameterIds: [`${ns}:parameter.${local}_legal_entity_scope`],
    exportMaximumResultCount: 5_000,
    maximumResultCount: 100,
    queryId: `${ns}:query.${local}`,
  });

test('REPORTS-HOME: a declared List sends its one currency, the day its ages count from, its eligibility and its summary', () => {
  const first = sent(aging, 'receivables_aging_list');
  // CAD unless the URL names another declared currency; never all of them.
  assert.equal(first.list.figures.currency, 'CAD');
  assert.equal(first.list.figures.today, '2026-10-06T00:00:00.000Z');
  assert.deepEqual(first.list.figures.summary, [
    `${ns}:list_figure.receivables_aging_list_owing`,
    `${ns}:list_figure.receivables_aging_list_current`,
    `${ns}:list_figure.receivables_aging_list_days_1_30`,
    `${ns}:list_figure.receivables_aging_list_days_31_60`,
    `${ns}:list_figure.receivables_aging_list_days_61_90`,
    `${ns}:list_figure.receivables_aging_list_over_90`,
  ]);
  assert.equal(
    sent(aging, 'receivables_aging_list', 'http://list.local/?currency=USD')
      .list.figures.currency,
    'USD',
  );
  assert.equal(
    sent(aging, 'receivables_aging_list', 'http://list.local/?currency=GBP')
      .list.figures.currency,
    'CAD',
  );
  // The chosen currency travels with every link the List makes.
  const state = readDeclaredListState(
    aging,
    new URL('http://list.local/?currency=EUR'),
  );
  assert.equal(
    declaredListParameters(state, new URLSearchParams()).get('currency'),
    'EUR',
  );
  // An age never reaches a List without one: Customer accounts has none.
  const accountArgs = sent(accounts, 'customer_account_list');
  assert.equal('today' in accountArgs.list.figures, false);
  assert.deepEqual(accountArgs.list.relatedFilter, {
    fieldFilters: [
      {
        fieldId: `${ns}:field.party_role_kind`,
        value: `${ns}:option.customer`,
      },
      {
        fieldId: `${ns}:field.party_role_status`,
        value: `${ns}:option.active`,
      },
    ],
    queryId: `${ns}:query.party_role_list`,
    relationId: `${ns}:relation.party_role_party`,
  });
  // Both parse as the gateway parses them, counts and exports included.
  for (const mode of ['count', 'export', 'page'] as const) {
    assert.ok(
      parse(
        sent(aging, 'receivables_aging_list', undefined, mode),
        'receivables_aging_list',
      ),
    );
    assert.ok(
      parse(
        sent(accounts, 'customer_account_list', undefined, mode),
        'customer_account_list',
      ),
    );
  }
  // A window read in CAD is not a window read in USD: the cursor binds it.
  const paged = (currency: string) =>
    (
      sent(
        aging,
        'receivables_aging_list',
        `http://list.local/?currency=${currency}&page=2`,
      ) as unknown as { list: { cursor: string | null } }
    ).list.cursor;
  // One page only in this declaration's window, so mint at an offset.
  const at = (currency: string) =>
    declaredListArguments(
      aging,
      readDeclaredListState(
        aging,
        new URL(`http://list.local/?currency=${currency}`),
      ),
      {
        mode: 'page',
        now,
        pageOffset: 50,
        queryId: `${ns}:query.receivables_aging_list`,
        scopeArguments: {},
      },
    ) as unknown as { list: { cursor: string } };
  assert.notEqual(at('CAD').list.cursor, at('USD').list.cursor);
  assert.equal(paged('CAD'), null);
});

test('REPORTS-HOME: the figures contract refuses every member a statement could not honour', () => {
  const base = sent(aging, 'receivables_aging_list').list.figures as Json & {
    sums: Array<Json & { rows: Json; within?: Json }>;
  };
  const accountFigures = sent(accounts, 'customer_account_list').list
    .figures as Json & { sums: Array<Json & { rows: Json; within?: Json }> };
  const variant = (
    from: Json,
    mutate: (
      figures: Json & { sums: Array<Json & { rows: Json; within?: Json }> },
    ) => void,
  ) => {
    const figures = structuredClone(from) as Json & {
      sums: Array<Json & { rows: Json; within?: Json }>;
    };
    mutate(figures);
    return figures;
  };
  assert.ok(parseSharedListFigures(base as ImmutableJsonValue));
  assert.ok(parseSharedListFigures(accountFigures as ImmutableJsonValue));
  const cases: Array<[RegExp, Json]> = [
    // One currency exactly when a sum reads one.
    [
      /one currency exactly when a sum reads one/u,
      variant(base, (f) => delete f.currency),
    ],
    [
      /one currency exactly when a sum reads one/u,
      variant(base, (f) => {
        f.currency = '';
      }),
    ],
    [
      /one currency exactly when a sum reads one/u,
      variant(base, (f) => {
        for (const sum of f.sums) delete sum.currencyFieldId;
      }),
    ],
    // The day an age counts from: midnight UTC, exactly when a sum ages.
    [/midnight UTC an age counts from/u, variant(base, (f) => delete f.today)],
    [
      /midnight UTC an age counts from/u,
      variant(base, (f) => {
        f.today = '2026-10-06T12:00:00.000Z';
      }),
    ],
    [
      /midnight UTC an age counts from/u,
      variant(accountFigures, (f) => {
        f.today = '2026-10-06T00:00:00.000Z';
      }),
    ],
    [
      /age names a range of days/u,
      variant(base, (f) => {
        f.sums[1]!.age = {
          fieldId: `${ns}:field.customer_invoice_due_date`,
          from: 30,
          to: 1,
        };
      }),
    ],
    [
      /age names a range of days/u,
      variant(base, (f) => {
        f.sums[1]!.age = { fieldId: `${ns}:field.customer_invoice_due_date` };
      }),
    ],
    [
      /whole number of days/u,
      variant(base, (f) => {
        f.sums[1]!.age = {
          fieldId: `${ns}:field.customer_invoice_due_date`,
          from: 1.5,
        };
      }),
    ],
    // A count adds no quantity; a price multiplies a quantity or remainder.
    [
      /names exactly the parts it adds/u,
      variant(base, (f) => {
        f.sums[6]!.rows.quantityFieldId = `${ns}:field.customer_invoice_balance`;
      }),
    ],
    [
      /price a quantity or a remainder/u,
      variant(base, (f) => {
        f.sums[6]!.price = { fieldId: `${ns}:field.customer_invoice_total` };
      }),
    ],
    [
      /sum is rows, related, remaining or count/u,
      variant(base, (f) => {
        f.sums[6]!.sum = 'distinct';
      }),
    ],
    // The rows or their parent hold the listed id, exactly one.
    [
      /rows or their parent match the listed record, exactly one/u,
      variant(accountFigures, (f) => {
        f.sums[1]!.rows.matchFieldId = `${ns}:field.sales_order_line_item_id`;
      }),
    ],
    [
      /rows or their parent match the listed record, exactly one/u,
      variant(accountFigures, (f) => {
        delete f.sums[1]!.within!.matchFieldId;
      }),
    ],
    // A summary adds up number figures, each once.
    [
      /summary adds up sums, choices and totals/u,
      variant(base, (f) => {
        f.summary = [`${ns}:list_figure.receivables_aging_list_standing`];
      }),
    ],
    [
      /must be unique/u,
      variant(base, (f) => {
        f.summary = [
          `${ns}:list_figure.receivables_aging_list_owing`,
          `${ns}:list_figure.receivables_aging_list_owing`,
        ];
      }),
    ],
    // Closed members.
    [
      /closed contract/u,
      variant(base, (f) => {
        (f.sums[0]!.age as Json).weeks = 2;
      }),
    ],
  ];
  for (const [reason, figures] of cases)
    assert.throws(
      () => parseSharedListFigures(figures as ImmutableJsonValue),
      (error: unknown) =>
        error instanceof SharedListContractError && reason.test(error.message),
      String(reason),
    );
});

test('REPORTS-HOME: an answer must carry exactly the requested summary, each a decimal or unstated', () => {
  const query = parse(
    sent(aging, 'receivables_aging_list'),
    'receivables_aging_list',
  )!;
  const summary = Object.fromEntries(
    (query.figures!.summary ?? []).map((figureId) => [figureId, '0']),
  );
  const coverage = (extra: Json = {}) =>
    ({
      effectivePageSize: 50,
      hasMore: false,
      includeArchived: false,
      matchMode: 'substring',
      nextCursor: null,
      pageOffset: 0,
      parentScope: null,
      figures: query.figures,
      projectedSearchValueCount: 0,
      requestedPageSize: 50,
      returnedCount: 0,
      schemaVersion: 'northstar.shared-list-result/v1',
      search: '',
      sort: query.sort,
      totalCount: 0,
      truncatedByMaximum: false,
      ...extra,
    }) as unknown as SharedListCoverage;
  assert.doesNotThrow(() =>
    requireSharedListEcho(query, coverage({ figureSummary: summary })),
  );
  // An unstated total is null, never 0.
  const unstated = { ...summary };
  unstated[Object.keys(unstated)[0]!] = null as never;
  assert.doesNotThrow(() =>
    requireSharedListEcho(query, coverage({ figureSummary: unstated })),
  );
  const refusals: Json[] = [
    {},
    { figureSummary: { ...summary, extra: '1' } },
    {
      figureSummary: Object.fromEntries(Object.entries(summary).slice(1)),
    },
    {
      figureSummary: {
        ...summary,
        [Object.keys(summary)[0]!]: 'twelve',
      },
    },
  ];
  for (const extra of refusals)
    assert.throws(
      () => requireSharedListEcho(query, coverage(extra)),
      (error: unknown) =>
        error instanceof SharedListContractError &&
        error.code === 'LIST_RESULT_MALFORMED',
    );
  // A List without a summary is never answered with one.
  const plain = parse(
    sent(accounts, 'customer_account_list'),
    'customer_account_list',
  )!;
  const { summary: _ignored, ...unsummed } = plain.figures!;
  const withoutSummary = { ...plain, figures: unsummed };
  assert.doesNotThrow(() =>
    requireSharedListEcho(
      withoutSummary as never,
      coverage({ figures: unsummed, sort: plain.sort }),
    ),
  );
  assert.throws(
    () =>
      requireSharedListEcho(
        withoutSummary as never,
        coverage({
          figures: unsummed,
          sort: plain.sort,
          figureSummary: summary,
        }),
      ),
    SharedListContractError,
  );
});
