import type {
  SurfaceList,
  SurfaceListRowAction,
} from '../../../packages/canonical-model/src/index.js';
import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import {
  encodeSharedListCursor,
  SHARED_LIST_QUERY_VERSION,
  type SharedListQueryRequest,
} from '../../../packages/runtime/src/list-behavior/index.js';
import {
  SemanticQueryPolicyDeniedError,
  type SemanticRecordDto,
} from '../../../packages/runtime/src/semantic-query-gateway.js';

/**
 * A declared List (canonical `surface.list`) read from the request URL. The
 * declaration is the only authority for what may be asked: a view, filter
 * value or sort the declaration does not offer falls back to the declared
 * default, and everything chosen becomes query-gateway arguments that are
 * re-authorized on every request. Nothing is filtered, sorted or counted in
 * the browser or over a fetched page.
 */
export interface DeclaredListState {
  /**
   * The one currency a List's currency figures are read in (REPORTS-HOME):
   * a declared option, the first unless the URL names another; `null` for a
   * List that declares none.
   */
  readonly currency: string | null;
  readonly filterValues: Readonly<Record<string, string>>;
  readonly includeArchived: boolean;
  readonly page: number;
  readonly search: string;
  readonly sort: readonly {
    readonly columnId: string;
    readonly direction: 'ascending' | 'descending';
  }[];
  readonly sortIsExplicit: boolean;
  readonly viewId: string | null;
}

export type DeclaredListColumn = SurfaceList['columns'][number];

export function orderedColumns(
  list: SurfaceList,
): readonly DeclaredListColumn[] {
  return [...list.columns].sort(
    (left, right) =>
      left.orderKey - right.orderKey ||
      left.columnId.localeCompare(right.columnId),
  );
}

export function orderedViews(list: SurfaceList): SurfaceList['views'] {
  return [...list.views].sort(
    (left, right) =>
      left.orderKey - right.orderKey || left.viewId.localeCompare(right.viewId),
  );
}

export function orderedFilters(list: SurfaceList): SurfaceList['filters'] {
  return [...list.filters].sort(
    (left, right) =>
      left.orderKey - right.orderKey ||
      left.filterId.localeCompare(right.filterId),
  );
}

export function readDeclaredListState(
  list: SurfaceList,
  url: URL,
): DeclaredListState {
  const views = orderedViews(list);
  const requestedView = url.searchParams.get('view');
  const viewId =
    views.find((view) => view.viewId === requestedView)?.viewId ??
    views[0]?.viewId ??
    null;
  const filterValues = Object.fromEntries(
    orderedFilters(list).flatMap((filter) => {
      const value = url.searchParams.get(filter.filterId);
      return filter.options.some((option) => option.value === value)
        ? [[filter.filterId, value as string]]
        : [];
    }),
  );
  const requestedSort = list.columns.find(
    (column) =>
      column.sortable && column.columnId === url.searchParams.get('sort'),
  );
  const page = Number(url.searchParams.get('page') ?? '1');
  const currencies = list.figures?.currency?.options ?? [];
  const requestedCurrency = url.searchParams.get('currency');
  return Object.freeze({
    currency:
      currencies.find((option) => option.value === requestedCurrency)?.value ??
      currencies[0]?.value ??
      null,
    filterValues: Object.freeze(filterValues),
    includeArchived: url.searchParams.get('archived') === 'yes',
    page:
      Number.isSafeInteger(page) && page >= 1 && page <= 1_000_000 ? page : 1,
    search: url.searchParams.get('q') ?? '',
    sort: Object.freeze(
      requestedSort
        ? [
            {
              columnId: requestedSort.columnId,
              direction:
                url.searchParams.get('dir') === 'desc'
                  ? ('descending' as const)
                  : ('ascending' as const),
            },
          ]
        : list.defaultSort.map((sort) => ({ ...sort })),
    ),
    sortIsExplicit: requestedSort !== undefined,
    viewId,
  });
}

/** The URL parameters that reproduce a state, for links and the filter form. */
export function declaredListParameters(
  state: DeclaredListState,
  base: URLSearchParams,
  change: Partial<DeclaredListState> = {},
): URLSearchParams {
  const next = { ...state, ...change };
  const parameters = new URLSearchParams(base);
  if (next.viewId) parameters.set('view', next.viewId);
  if (next.currency !== null) parameters.set('currency', next.currency);
  for (const [filterId, value] of Object.entries(next.filterValues))
    parameters.set(filterId, value);
  if (next.search.length > 0) parameters.set('q', next.search);
  if (next.includeArchived) parameters.set('archived', 'yes');
  if (next.sortIsExplicit && next.sort[0]) {
    parameters.set('sort', next.sort[0].columnId);
    parameters.set(
      'dir',
      next.sort[0].direction === 'descending' ? 'desc' : 'asc',
    );
  }
  if (next.page > 1) parameters.set('page', String(next.page));
  return parameters;
}

interface ListArgumentOptions {
  readonly exportMaximumResultCount?: number;
  readonly mode: 'count' | 'export' | 'page';
  /**
   * The request's clock, read once per request and injectable -- as the
   * editor's "N days from today" default is -- so the page, every tab count
   * and the export compare against the same "before today".
   */
  readonly now: Date;
  readonly pageOffset?: number;
  readonly queryId: string;
  readonly scopeArguments: Readonly<
    Record<string, RuntimeViewContract.ImmutableJsonValue>
  >;
  /** For a view count, the view counted instead of the selected one. */
  readonly viewId?: string | null;
  /**
   * The List's progress withheld by current policy (`whenDenied: 'omit'`):
   * the request carries none, so its figures read "—". A view that keeps
   * only open rows cannot be asked this way -- it would count every row.
   */
  readonly withoutProgress?: boolean;
  /**
   * The progress supply withheld by current policy (SUPPLY-WARNINGS,
   * `whenDenied: 'omit'`): the progress is sent without it, so its figures
   * read "—". A view that keeps covered or short rows cannot be asked this
   * way, and neither can it without the progress the supply extends.
   */
  readonly withoutSupply?: boolean;
}

const DAY_MILLISECONDS = 86_400_000;

/**
 * `startOfTodayUtc`: midnight UTC of the request's day, the calendar every
 * List date is shown in. The release names only the symbol; the instant is
 * made here, at request time, and sent to the gateway as an argument.
 */
export function startOfTodayUtc(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * One part of a supply's free stock in the list argument's shape -- a figure
 * sum without an id of its own. Inferred, so it stays a plain JSON value.
 */
function supplySumArgument(
  entry: NonNullable<
    NonNullable<SurfaceList['progress']>['supply']
  >['free']['plus'][number],
) {
  return Object.freeze({
    ...(entry.related
      ? {
          related: Object.freeze({
            fieldId: entry.related.quantity,
            queryId: entry.related.query.targetId,
            relationId: entry.related.relation,
          }),
        }
      : {}),
    rows: Object.freeze({
      matchFieldId: entry.rows.match,
      queryId: entry.rows.query.targetId,
      ...(entry.rows.quantity ? { quantityFieldId: entry.rows.quantity } : {}),
    }),
    sum: entry.sum,
    ...(entry.within
      ? {
          within: Object.freeze({
            fieldId: entry.within.field,
            queryId: entry.within.query.targetId,
            ...('relation' in entry.within
              ? { relationId: entry.within.relation }
              : { referenceFieldId: entry.within.reference }),
            values: Object.freeze([...entry.within.values]),
          }),
        }
      : {}),
  });
}

/**
 * The supply argument a declared List sends with its progress (SUPPLY-
 * WARNINGS), with a view's `supply` as `keep`. Inferred rather than
 * annotated, so it stays a plain JSON argument value.
 */
function supplyArgument(
  supply: NonNullable<NonNullable<SurfaceList['progress']>['supply']>,
  keep: 'covered' | 'short' | undefined,
) {
  return Object.freeze({
    coverage: Object.freeze({
      queryId: supply.coverage.query.targetId,
      related: Object.freeze({
        fieldId: supply.coverage.related.quantity,
        queryId: supply.coverage.related.query.targetId,
        relationId: supply.coverage.related.relation,
      }),
      relationId: supply.coverage.relation,
    }),
    free: Object.freeze({
      minus: Object.freeze(supply.free.minus.map(supplySumArgument)),
      plus: Object.freeze(supply.free.plus.map(supplySumArgument)),
    }),
    itemFieldId: supply.item,
    ...(keep ? { keep } : {}),
    outputs: Object.freeze({ ...supply.outputs }),
    ...(supply.shortIn
      ? {
          shortIn: Object.freeze({
            fieldId: supply.shortIn.field,
            values: Object.freeze([...supply.shortIn.values]),
          }),
        }
      : {}),
  });
}

/**
 * The progress argument a declared List sends, with a view's `open` and its
 * supply's `keep` -- or without its supply when current policy withholds it.
 * Inferred rather than annotated, so it stays a plain JSON argument value.
 */
function progressArgument(
  list: SurfaceList,
  open: boolean,
  keep: 'covered' | 'short' | undefined,
  withoutSupply: boolean,
) {
  const progress = list.progress;
  if (!progress) return undefined;
  return Object.freeze({
    done: Object.freeze({
      fieldId: progress.done.quantity,
      queryId: progress.done.query.targetId,
      relationId: progress.done.relation,
    }),
    lines: Object.freeze({
      fieldId: progress.lines.quantity,
      queryId: progress.lines.query.targetId,
      relationId: progress.lines.relation,
    }),
    ...(progress.openIn
      ? {
          openIn: Object.freeze({
            fieldId: progress.openIn.field,
            values: Object.freeze([...progress.openIn.values]),
          }),
        }
      : {}),
    ...(open ? { openOnly: true as const } : {}),
    outputs: Object.freeze({ ...progress.outputs }),
    ...(progress.supply && !withoutSupply
      ? { supply: supplyArgument(progress.supply, keep) }
      : {}),
  });
}

/**
 * The figures argument a declared List sends -- the declaration in the list
 * argument's own shape, band labels left out -- with a view's band as `keep`.
 * Inferred rather than annotated, so it stays a plain JSON argument value.
 */
function figuresArgument(
  list: SurfaceList,
  band: SurfaceList['views'][number]['band'],
  /**
   * REPORTS-HOME: the one currency the List is read in, and midnight UTC of
   * the request's day, from which an age counts whole days.
   */
  read: { readonly currency: string | null; readonly today: string },
) {
  const figures = list.figures;
  if (!figures) return undefined;
  const aged = figures.sums.some((sum) => sum.age !== undefined);
  const currencied = figures.sums.some((sum) => sum.currency !== undefined);
  const within = (
    value: NonNullable<
      NonNullable<SurfaceList['figures']>['latest']
    >[number]['within'],
  ) =>
    Object.freeze({
      fieldId: value.field,
      queryId: value.query.targetId,
      ...('relation' in value
        ? { relationId: value.relation }
        : { referenceFieldId: value.reference }),
      values: Object.freeze([...value.values]),
    });
  const operand = (value: { figure: string } | { field: string }) =>
    Object.freeze(
      'figure' in value ? { figureId: value.figure } : { fieldId: value.field },
    );
  const threshold = (
    value: { field: string } | { figure: string } | { value: string },
  ) =>
    Object.freeze(
      'field' in value
        ? { fieldId: value.field }
        : 'figure' in value
          ? { figureId: value.figure }
          : { value: value.value },
    );
  type Choice = NonNullable<NonNullable<SurfaceList['figures']>['choices']>;
  const taken = (value: NonNullable<Choice[number]['otherwise']>) =>
    Object.freeze(
      'percent' in value
        ? {
            percent: Object.freeze({
              company: Object.freeze({
                fieldId: value.percent.company.field,
                queryId: value.percent.company.query.targetId,
              }),
              of: operand(value.percent.of),
            }),
          }
        : operand(value),
    );
  return Object.freeze({
    ...(figures.bands
      ? {
          bands: Object.freeze(
            figures.bands.map((entry) =>
              Object.freeze({
                cases: Object.freeze(
                  entry.cases.map((value) =>
                    Object.freeze({
                      value: value.value,
                      ...(value.below ? { below: threshold(value.below) } : {}),
                      ...(value.atMost
                        ? { atMost: threshold(value.atMost) }
                        : {}),
                      ...(value.when
                        ? {
                            when: Object.freeze({
                              fieldId: value.when.field,
                              values: Object.freeze([...value.when.values]),
                            }),
                          }
                        : {}),
                    }),
                  ),
                ),
                figureId: entry.figureId,
                of: entry.of,
                otherwise: entry.otherwise.value,
              }),
            ),
          ),
        }
      : {}),
    ...(figures.choices
      ? {
          choices: Object.freeze(
            figures.choices.map((entry) =>
              Object.freeze({
                byFieldId: entry.by,
                cases: Object.freeze(
                  entry.cases.map((value) =>
                    Object.freeze({
                      ...(value.value ? { value: taken(value.value) } : {}),
                      values: Object.freeze([...value.values]),
                    }),
                  ),
                ),
                figureId: entry.figureId,
                ...(entry.otherwise
                  ? { otherwise: taken(entry.otherwise) }
                  : {}),
              }),
            ),
          ),
        }
      : {}),
    ...(currencied && read.currency !== null
      ? { currency: read.currency }
      : {}),
    ...(band
      ? {
          keep: Object.freeze({
            figureId: band.figure,
            values: Object.freeze([...band.values]),
          }),
        }
      : {}),
    ...(figures.latest
      ? {
          latest: Object.freeze(
            figures.latest.map((entry) =>
              Object.freeze({
                byFieldId: entry.by,
                figureId: entry.figureId,
                label: Object.freeze({
                  fieldId: entry.label.field,
                  queryId: entry.label.query.targetId,
                }),
                rows: Object.freeze({
                  matchFieldId: entry.rows.match,
                  queryId: entry.rows.query.targetId,
                }),
                valueFieldId: entry.value,
                within: within(entry.within),
              }),
            ),
          ),
        }
      : {}),
    ...(figures.summary
      ? { summary: Object.freeze([...figures.summary]) }
      : {}),
    sums: Object.freeze(
      figures.sums.map((entry) =>
        Object.freeze({
          ...(entry.age
            ? {
                age: Object.freeze({
                  fieldId: entry.age.field,
                  ...(entry.age.from === undefined
                    ? {}
                    : { from: entry.age.from }),
                  ...(entry.age.to === undefined ? {} : { to: entry.age.to }),
                }),
              }
            : {}),
          ...(entry.currency ? { currencyFieldId: entry.currency } : {}),
          figureId: entry.figureId,
          ...(entry.price
            ? {
                price: Object.freeze({
                  ...(entry.price.discount
                    ? { discountFieldId: entry.price.discount }
                    : {}),
                  fieldId: entry.price.field,
                }),
              }
            : {}),
          ...(entry.related
            ? {
                related: Object.freeze({
                  fieldId: entry.related.quantity,
                  queryId: entry.related.query.targetId,
                  relationId: entry.related.relation,
                }),
              }
            : {}),
          rows: Object.freeze({
            ...(entry.rows.match ? { matchFieldId: entry.rows.match } : {}),
            queryId: entry.rows.query.targetId,
            ...(entry.rows.quantity
              ? { quantityFieldId: entry.rows.quantity }
              : {}),
          }),
          sum: entry.sum,
          ...(entry.where
            ? {
                where: Object.freeze({
                  fieldId: entry.where.field,
                  values: Object.freeze([...entry.where.values]),
                }),
              }
            : {}),
          ...(entry.within
            ? {
                within: Object.freeze({
                  ...within(entry.within),
                  ...('match' in entry.within && entry.within.match
                    ? { matchFieldId: entry.within.match }
                    : {}),
                }),
              }
            : {}),
        }),
      ),
    ),
    ...(aged ? { today: read.today } : {}),
    ...(figures.totals
      ? {
          totals: Object.freeze(
            figures.totals.map((entry) =>
              Object.freeze({
                figureId: entry.figureId,
                ...(entry.floor ? { floor: entry.floor } : {}),
                minus: Object.freeze(entry.minus.map(operand)),
                plus: Object.freeze(entry.plus.map(operand)),
              }),
            ),
          ),
        }
      : {}),
  });
}

/**
 * What a person reads for a band figure's value: the label the List declares
 * for it. `null` for anything that is not a band value of this List.
 */
export function figureBandLabel(
  list: SurfaceList,
  fieldId: string,
  value: RuntimeViewContract.ImmutableJsonValue,
): string | null {
  const band = list.figures?.bands?.find((entry) => entry.figureId === fieldId);
  if (!band || typeof value !== 'string') return null;
  return (
    [...band.cases, band.otherwise].find((entry) => entry.value === value)
      ?.label ?? null
  );
}

/**
 * The exact list-query arguments for one declared request. The cursor is
 * minted from the same fields the gateway digests, so a page number is an
 * offset the gateway itself would have issued, and a changed view, filter,
 * search or sort can never reuse another window's cursor.
 */
export function declaredListArguments(
  list: SurfaceList,
  state: DeclaredListState,
  options: ListArgumentOptions,
): RuntimeViewContract.ImmutableJsonValue {
  const viewId = options.viewId === undefined ? state.viewId : options.viewId;
  const view = list.views.find((candidate) => candidate.viewId === viewId);
  const filtersById = new Map(
    list.filters.map((filter) => [filter.filterId, filter]),
  );
  const fieldFilters = Object.freeze([
    ...(view?.filters ?? []).map((filter) =>
      Object.freeze({ fieldId: filter.field, value: filter.value }),
    ),
    ...orderedFilters(list).flatMap((filter) => {
      const value = state.filterValues[filter.filterId];
      return value !== undefined && filtersById.has(filter.filterId)
        ? [Object.freeze({ fieldId: filter.field, value })]
        : [];
    }),
  ]);
  const referenceLabels = Object.freeze(
    orderedColumns(list).flatMap((column) =>
      column.reference
        ? [
            Object.freeze({
              fieldId: column.reference.labelField.targetId,
              queryId: column.reference.query.targetId,
              referenceId: column.columnId,
              sourceFieldId: column.field,
            }),
          ]
        : [],
    ),
  );
  const columns = new Map<string, DeclaredListColumn>(
    list.columns.map((column) => [column.columnId, column]),
  );
  const sort = Object.freeze(
    options.mode === 'count'
      ? []
      : state.sort.flatMap((entry) => {
          const column = columns.get(entry.columnId);
          return column
            ? [
                Object.freeze({
                  direction: entry.direction,
                  fieldId: column.reference ? column.columnId : column.field,
                }),
              ]
            : [];
        }),
  );
  const pageSize =
    options.mode === 'count'
      ? 1
      : options.mode === 'export'
        ? (options.exportMaximumResultCount ?? list.pageSize)
        : list.pageSize;
  // Every request of the List carries its progress, so a count, a page and
  // an export read the same figures; a view's `open` and `before` narrow all
  // three in the statement, never over a fetched page.
  if (options.withoutProgress && view?.open)
    throw new Error('an open view is never read without its progress');
  if ((options.withoutProgress || options.withoutSupply) && view?.supply)
    throw new Error('a supply view is never read without its supply');
  const progress = options.withoutProgress
    ? undefined
    : progressArgument(
        list,
        view?.open === true,
        view?.supply,
        options.withoutSupply === true,
      );
  // Figures ride every request too: a count, a page and an export read the
  // same figures, and a view's band narrows all three in the statement.
  const figures = figuresArgument(list, view?.band, {
    currency: state.currency,
    today: startOfTodayUtc(options.now).toISOString(),
  });
  // REPORTS-HOME: only the rows the List's eligibility keeps -- customers --
  // on every request, so a count, a page and an export read the same set.
  const relatedFilter = list.eligibility
    ? Object.freeze({
        fieldFilters: Object.freeze(
          list.eligibility.filters.map((filter) =>
            Object.freeze({ fieldId: filter.fieldId, value: filter.value }),
          ),
        ),
        queryId: list.eligibility.queryId,
        relationId: list.eligibility.relationId,
      })
    : undefined;
  const beforeFilters = Object.freeze(
    view?.before
      ? [
          Object.freeze({
            before: startOfTodayUtc(options.now).toISOString(),
            fieldId: view.before.field,
          }),
        ]
      : [],
  );
  // The children the search also matches through, on every request, so a
  // count, a page and an export find the same rows (CATALOG-EXTRAS).
  const searchChildren = list.searchChildren
    ? Object.freeze(
        list.searchChildren.map((child) =>
          Object.freeze({
            fieldId: child.field,
            queryId: child.query.targetId,
            relationId: child.relation,
          }),
        ),
      )
    : undefined;
  const digestInput: SharedListQueryRequest = {
    cursor: null,
    effectivePageSize: pageSize,
    includeArchived: state.includeArchived,
    matchMode: 'substring',
    pageOffset: options.pageOffset ?? 0,
    parentScope: null,
    ...(fieldFilters.length > 0 ? { fieldFilters } : {}),
    ...(relatedFilter ? { relatedFilter } : {}),
    ...(progress ? { progress } : {}),
    ...(figures ? { figures } : {}),
    ...(beforeFilters.length > 0 ? { beforeFilters } : {}),
    relationLabels: [],
    ...(referenceLabels.length > 0 ? { referenceLabels } : {}),
    requestedPageSize: pageSize,
    schemaVersion: SHARED_LIST_QUERY_VERSION,
    search: state.search,
    ...(searchChildren ? { searchChildren } : {}),
    sort,
    truncatedByMaximum: false,
  };
  const offset = options.pageOffset ?? 0;
  return Object.freeze({
    includeArchived: state.includeArchived,
    list: Object.freeze({
      cursor:
        options.mode === 'page' && offset > 0
          ? encodeSharedListCursor(options.queryId, digestInput, offset)
          : null,
      ...(fieldFilters.length > 0 ? { fieldFilters } : {}),
      ...(relatedFilter ? { relatedFilter } : {}),
      ...(progress ? { progress } : {}),
      ...(figures ? { figures } : {}),
      ...(beforeFilters.length > 0 ? { beforeFilters } : {}),
      matchMode: 'substring',
      ...(options.mode === 'export' ? { outputMode: 'export' } : {}),
      pageSize,
      ...(referenceLabels.length > 0 ? { referenceLabels } : {}),
      relationLabels: [],
      schemaVersion: SHARED_LIST_QUERY_VERSION,
      search: state.search,
      ...(searchChildren ? { searchChildren } : {}),
      sort,
    }),
    ...options.scopeArguments,
  });
}

/** Presents one stored value by its compiled field kind (enum label, date). */
export type FieldPresenter = (
  record: SemanticRecordDto,
  fieldId: string,
  value: RuntimeViewContract.ImmutableJsonValue,
) => string;

/**
 * An exact decimal shown as money: grouped digits and at least two decimals.
 * Never rounded -- a stored price of 12.345 reads 12.345 -- and anything that
 * is not a plain decimal string is shown as it is.
 */
export function moneyText(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) return value;
  const [, sign, whole, fraction = ''] = match;
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  return `${sign}${grouped}.${fraction.replace(/0+$/u, '').padEnd(2, '0')}`;
}

/** The display text of one declared cell, from server-projected values only. */
export function declaredCellText(
  column: DeclaredListColumn,
  record: SemanticRecordDto,
  present?: FieldPresenter,
): string | null {
  if (column.reference)
    return record.relationLabels?.[column.columnId]?.label ?? null;
  const value = record.values[column.field];
  if (value === null || value === undefined) return null;
  if (column.format === 'date' && typeof value === 'string') {
    const instant = Date.parse(value);
    if (Number.isFinite(instant))
      return new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeZone: 'UTC',
      }).format(new Date(instant));
  }
  if (column.format === 'money' && typeof value === 'string')
    return moneyText(value);
  if (present) return present(record, column.field, value);
  const display = record.displayValues?.[column.field];
  if (typeof display === 'string') return display;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Whole days a row's date is late, for a column declaring `overdue`: `null`
 * unless the row meets every condition of the named view -- its exact filters,
 * something open when the view keeps only open rows, and the date before the
 * request's midnight UTC -- judged from the row's server-projected values and
 * the same anchor the view's own tab was counted with. A date on the UTC day
 * before today is one day late.
 */
export function overdueDays(
  list: SurfaceList,
  column: DeclaredListColumn,
  record: SemanticRecordDto,
  now: Date,
): number | null {
  const view = column.overdue
    ? list.views.find((candidate) => candidate.viewId === column.overdue?.view)
    : undefined;
  if (!view?.before) return null;
  if (
    !view.filters.every(
      (filter) => record.values[filter.field] === filter.value,
    )
  )
    return null;
  if (view.open && !somethingOpen(list, record)) return null;
  if (view.supply && !somethingSupplied(list, record, view.supply)) return null;
  const value = record.values[view.before.field];
  const instant = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  const anchor = startOfTodayUtc(now).getTime();
  if (!Number.isFinite(instant) || instant >= anchor) return null;
  const day = startOfTodayUtc(new Date(instant)).getTime();
  return Math.round((anchor - day) / DAY_MILLISECONDS);
}

/**
 * Whether the row's server-projected progress leaves something open: an
 * unsigned exact decimal with a digit other than zero. A withheld or absent
 * figure is not open -- nothing unstated is guessed.
 */
function somethingOpen(list: SurfaceList, record: SemanticRecordDto): boolean {
  const open = list.progress
    ? record.values[list.progress.outputs.open]
    : undefined;
  return (
    typeof open === 'string' &&
    /^\d+(?:\.\d+)?$/u.test(open) &&
    /[1-9]/u.test(open)
  );
}

/**
 * Whether the row's server-projected supply leaves something covered, or
 * something short: an unsigned exact decimal with a digit other than zero. A
 * withheld or absent figure states neither -- nothing unstated is guessed.
 */
function somethingSupplied(
  list: SurfaceList,
  record: SemanticRecordDto,
  kind: 'covered' | 'short',
): boolean {
  const supply = list.progress?.supply;
  const value = supply ? record.values[supply.outputs[kind]] : undefined;
  return (
    typeof value === 'string' &&
    /^\d+(?:\.\d+)?$/u.test(value) &&
    /[1-9]/u.test(value)
  );
}

/**
 * Whether a declared column shows what the row is short of and the row is
 * short (SUPPLY-WARNINGS): such a cell is marked, as the reference marks an
 * exception "!", judged from the server-projected figure alone.
 */
export function shortMarked(
  list: SurfaceList,
  column: DeclaredListColumn,
  record: SemanticRecordDto,
): boolean {
  const supply = list.progress?.supply;
  return (
    supply !== undefined &&
    column.field === supply.outputs.short &&
    somethingSupplied(list, record, 'short')
  );
}

/**
 * Whether a view can be read only with the List's progress: it keeps the
 * rows with something open -- or covered or short, which the progress's
 * supply judges -- which only the list statement can judge. Without the
 * progress such a view is refused; every other view still serves.
 */
export function viewNeedsProgress(
  list: SurfaceList,
  viewId: string | null,
): boolean {
  const view = list.views.find((candidate) => candidate.viewId === viewId);
  return view?.open === true || view?.supply !== undefined;
}

/**
 * Whether a view can be read only with the List's supply: it keeps the rows
 * with something covered or short. Without the supply such a view is
 * refused; every other view still serves (SUPPLY-WARNINGS).
 */
export function viewNeedsSupply(
  list: SurfaceList,
  viewId: string | null,
): boolean {
  return (
    list.views.find((candidate) => candidate.viewId === viewId)?.supply !==
    undefined
  );
}

/**
 * The progress query current policy withheld from a List whose progress is
 * supplementary (`whenDenied: 'omit'`), named by the gateway's refusal; `null`
 * for anything else -- the List's own query, a label, or a List whose progress
 * is its purpose, which keep refusing as they did.
 */
export function withheldProgressQuery(
  list: SurfaceList,
  error: unknown,
): string | null {
  const progress = list.progress;
  if (
    progress?.whenDenied !== 'omit' ||
    !(error instanceof SemanticQueryPolicyDeniedError)
  )
    return null;
  const summed: readonly string[] = [
    progress.lines.query.targetId,
    progress.done.query.targetId,
  ];
  return summed.includes(error.queryId) ? error.queryId : null;
}

/**
 * The supply query current policy withheld from a List whose supply is
 * supplementary (`whenDenied: 'omit'`, SUPPLY-WARNINGS), named by the
 * gateway's refusal; `null` for anything else -- the List's own query, its
 * progress, a label, or a supply that is the List's purpose.
 */
export function withheldSupplyQuery(
  list: SurfaceList,
  error: unknown,
): string | null {
  const supply = list.progress?.supply;
  if (
    supply?.whenDenied !== 'omit' ||
    !(error instanceof SemanticQueryPolicyDeniedError)
  )
    return null;
  const read: readonly string[] = [
    supply.coverage.query.targetId,
    supply.coverage.related.query.targetId,
    ...[...supply.free.plus, ...supply.free.minus].flatMap((sum) => [
      sum.rows.query.targetId,
      ...(sum.within ? [sum.within.query.targetId] : []),
      ...(sum.related ? [sum.related.query.targetId] : []),
    ]),
  ];
  return read.includes(error.queryId) ? error.queryId : null;
}

export type DeclaredListRowAction = SurfaceListRowAction;

export function orderedRowActions(
  list: SurfaceList,
): readonly DeclaredListRowAction[] {
  return [...(list.rowActions ?? [])].sort(
    (left, right) =>
      left.orderKey - right.orderKey ||
      left.actionId.localeCompare(right.actionId),
  );
}

/**
 * The row's action: the first declared (in order) whose condition holds --
 * its exact filters, for `open` something open, and for `supply` something
 * covered or short -- judged from the row's server-projected values, as an
 * overdue date is. With its progress or supply withheld a row states nothing
 * open, covered or short, so an action that needs it is not the row's.
 */
export function declaredRowAction(
  list: SurfaceList,
  record: SemanticRecordDto,
): DeclaredListRowAction | null {
  return (
    orderedRowActions(list).find(
      (action) =>
        (action.when?.filters ?? []).every(
          (filter) => record.values[filter.field] === filter.value,
        ) &&
        (!action.when?.open || somethingOpen(list, record)) &&
        (action.when?.supply === undefined ||
          somethingSupplied(list, record, action.when.supply)),
    ) ?? null
  );
}

// A leading = + - @ (or tab/CR) makes a spreadsheet evaluate the cell. The
// export is data, so such a cell is prefixed with an apostrophe.
function csvCell(value: string | null): string {
  const text = value ?? '';
  const safe = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * The CSV keeps machine values -- ISO instants and exact decimal strings --
 * and presents only what a code would hide: labels and enumeration options.
 */
export function declaredListCsv(
  list: SurfaceList,
  records: readonly SemanticRecordDto[],
  presentLabel: FieldPresenter,
): string {
  const columns = orderedColumns(list);
  const rows = [
    columns.map((column) => csvCell(column.label)).join(','),
    ...records.map((record) =>
      columns
        .map((column) =>
          csvCell(
            declaredCellText(
              { ...column, format: undefined },
              record,
              presentLabel,
            ),
          ),
        )
        .join(','),
    ),
  ];
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

export function exportFileName(label: string, now: Date): string {
  const slug =
    label
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, '-')
      .replaceAll(/^-|-$/gu, '') || 'list';
  return `${slug}-${now.toISOString().slice(0, 10)}.csv`;
}
