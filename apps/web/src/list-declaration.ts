import type { SurfaceList } from '../../../packages/canonical-model/src/index.js';
import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import {
  encodeSharedListCursor,
  SHARED_LIST_QUERY_VERSION,
  type SharedListQueryRequest,
} from '../../../packages/runtime/src/list-behavior/index.js';
import type { SemanticRecordDto } from '../../../packages/runtime/src/semantic-query-gateway.js';

/**
 * A declared List (canonical `surface.list`) read from the request URL. The
 * declaration is the only authority for what may be asked: a view, filter
 * value or sort the declaration does not offer falls back to the declared
 * default, and everything chosen becomes query-gateway arguments that are
 * re-authorized on every request. Nothing is filtered, sorted or counted in
 * the browser or over a fetched page.
 */
export interface DeclaredListState {
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
  return Object.freeze({
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
  readonly pageOffset?: number;
  readonly queryId: string;
  readonly scopeArguments: Readonly<
    Record<string, RuntimeViewContract.ImmutableJsonValue>
  >;
  /** For a view count, the view counted instead of the selected one. */
  readonly viewId?: string | null;
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
  const digestInput: SharedListQueryRequest = {
    cursor: null,
    effectivePageSize: pageSize,
    includeArchived: state.includeArchived,
    matchMode: 'substring',
    pageOffset: options.pageOffset ?? 0,
    parentScope: null,
    ...(fieldFilters.length > 0 ? { fieldFilters } : {}),
    relationLabels: [],
    ...(referenceLabels.length > 0 ? { referenceLabels } : {}),
    requestedPageSize: pageSize,
    schemaVersion: SHARED_LIST_QUERY_VERSION,
    search: state.search,
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
      matchMode: 'substring',
      ...(options.mode === 'export' ? { outputMode: 'export' } : {}),
      pageSize,
      ...(referenceLabels.length > 0 ? { referenceLabels } : {}),
      relationLabels: [],
      schemaVersion: SHARED_LIST_QUERY_VERSION,
      search: state.search,
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
