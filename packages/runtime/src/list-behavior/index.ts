import { canonicalize } from '@north-star/canonical-model';

import type { ImmutableJsonValue } from '../request-runtime-view.js';
import {
  assertExactKeys,
  isRecord,
  malformed,
  SharedListContractError,
} from './contract.js';
import {
  decodeSharedListCursor,
  parseNullableCursor,
  sharedListBindingDigest,
} from './cursor.js';
import {
  parseSharedListFigures,
  sharedListFigureKinds,
  sharedListFigureRowFields,
  type AuthorizedSharedListFigures,
  type SharedListFigures,
} from './figures.js';
import { parseSharedListSupply, type SharedListSupply } from './supply.js';

// The closed-contract primitives and cursor identity moved to siblings; both
// stay part of this module's public surface so no caller import changes.
export { SharedListContractError } from './contract.js';
export { encodeSharedListCursor } from './cursor.js';
export {
  sharedListFigureKinds,
  type AuthorizedSharedListFigures,
  type SharedListFigureBand,
  type SharedListFigureChoice,
  type SharedListFigureChoiceValue,
  type SharedListFigureLatest,
  type SharedListFigureOperand,
  type SharedListFigureRelated,
  type SharedListFigures,
  type SharedListFigureSum,
  type SharedListFigureThreshold,
  type SharedListSumParts,
  type SharedListFigureTotal,
  type SharedListFigureWithin,
} from './figures.js';
export {
  sharedListSupplyReads,
  type SharedListSupply,
  type SharedListSupplySum,
} from './supply.js';

export const SHARED_LIST_QUERY_VERSION =
  'northstar.shared-list-query/v1' as const;
export const SHARED_LIST_RESULT_VERSION =
  'northstar.shared-list-result/v1' as const;

const canonicalIdPattern =
  /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const canonicalRecordIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SharedListSort {
  readonly direction: 'ascending' | 'descending';
  readonly fieldId: string;
}

export interface SharedListRelationLabelRequest {
  readonly fieldId: string;
  readonly queryId: string;
  readonly relationId: string;
}

/**
 * A label read through a declared list query for a field that STORES another
 * record's id, where no compiled relation exists (for example an order's
 * customer party id). The executor joins the target entity on its record id,
 * so search and sort by the label are complete server facts, never a lookup
 * over the shown page. `referenceId` names the label in the result and in sort.
 */
export interface SharedListReferenceLabelRequest {
  readonly fieldId: string;
  readonly queryId: string;
  readonly referenceId: string;
  readonly sourceFieldId: string;
}

/**
 * An exact parent restriction for a `parentScopedChild` relation. It narrows a
 * child list to one parent record BEFORE the count and the page window, so a
 * caller that wants one parent's children never pages a broader set. Naming the
 * relation rather than a column keeps the operand a compiled identity: the
 * gateway resolves it against the pinned relation and the executor resolves the
 * physical column, so a caller-supplied string never becomes table authority.
 */
export interface SharedListParentScope {
  readonly recordId: string;
  readonly relationId: string;
}

/**
 * Keeps only records that at least one active record of another entity points
 * at through a declared relation, where that record matches exact field
 * values -- for example parties with an active customer role. Applied BEFORE
 * the count and the page window, so a page is never a broader set filtered
 * afterwards. The related list query names the entity and carries the read
 * permission that must allow the check.
 */
export interface SharedListRelatedFilter {
  readonly queryId: string;
  readonly relationId: string;
  readonly fieldFilters: readonly {
    readonly fieldId: string;
    readonly value: string;
  }[];
}

/**
 * A child entity whose records also answer the search (CATALOG-EXTRAS): a row
 * matches when one of its active children, through the child's
 * parentScopedChild relation to it, holds the search text in a text field of
 * the child's unscoped list query -- an item found by an alias. The list
 * query carries the read permission that must allow the match.
 */
export interface SharedListSearchChild {
  readonly fieldId: string;
  readonly queryId: string;
  readonly relationId: string;
}

/** A declared list query whose rows are added up, through one relation. */
export interface SharedListProgressSource {
  readonly fieldId: string;
  readonly queryId: string;
  readonly relationId: string;
}

/**
 * Per row, what its active lines order and what their active done rows record
 * -- for example a purchase order's ordered and received units -- summed by
 * the list statement itself, with the open remainder between them. `lines`
 * are the row's children; `done` rows point at those lines. `openIn` names the
 * row states in which anything is open; in any other state open is 0.
 * `openOnly` keeps only rows with something open, BEFORE the count and the
 * page window, so a tab count, a page and an export are all exact. The three
 * figures come back in each record's values under `outputs`.
 */
export interface SharedListProgress {
  readonly done: SharedListProgressSource;
  readonly lines: SharedListProgressSource;
  readonly openIn?: {
    readonly fieldId: string;
    readonly values: readonly string[];
  };
  readonly openOnly?: true;
  readonly outputs: {
    readonly done: string;
    readonly open: string;
    readonly ordered: string;
  };
  /**
   * What reservations still hold for the lines and what they are short of
   * now, in the same statement (SUPPLY-WARNINGS); its `keep` narrows the set
   * before the count and the page window, as `openOnly` does.
   */
  readonly supply?: SharedListSupply;
}

/**
 * Keeps only rows whose date is before an instant -- a view's "before today"
 * turned into the request's own midnight UTC by the caller -- ahead of the
 * count and the page window. The instant is part of the request, so the
 * release stays clock-free and a cursor minted on one day cannot page another.
 */
export interface SharedListBeforeFilter {
  readonly before: string;
  readonly fieldId: string;
}

export interface SharedListQueryRequest {
  readonly cursor: string | null;
  readonly effectivePageSize: number;
  readonly includeArchived: boolean;
  readonly matchMode: 'prefix' | 'substring';
  readonly pageOffset: number;
  readonly parentScope: SharedListParentScope | null;
  readonly referenceScope?: SharedListParentScope;
  readonly fieldFilters?: readonly {
    readonly fieldId: string;
    readonly value: string;
  }[];
  readonly beforeFilters?: readonly SharedListBeforeFilter[];
  readonly progress?: SharedListProgress;
  /** Per-row figures the statement computes before the count and the page. */
  readonly figures?: SharedListFigures;
  readonly relatedFilter?: SharedListRelatedFilter;
  readonly relationLabels: readonly SharedListRelationLabelRequest[];
  readonly referenceLabels?: readonly SharedListReferenceLabelRequest[];
  /**
   * `export` asks for the whole filtered set in ONE statement, bounded by the
   * query's declared export limit. It never pages: a set larger than the limit
   * comes back with `hasMore`, and the caller must refuse rather than truncate.
   */
  readonly outputMode?: 'export';
  readonly requestedPageSize: number;
  readonly schemaVersion: typeof SHARED_LIST_QUERY_VERSION;
  readonly search: string;
  /** Children whose text also answers the search; echoed when applied. */
  readonly searchChildren?: readonly SharedListSearchChild[];
  readonly sort: readonly SharedListSort[];
  readonly truncatedByMaximum: boolean;
}

export interface AuthorizedSharedListRelationLabel extends SharedListRelationLabelRequest {
  readonly targetEntityId: string;
}

export interface AuthorizedSharedListRelatedFilter extends SharedListRelatedFilter {
  readonly relatedEntityId: string;
}

export interface AuthorizedSharedListReferenceLabel extends SharedListReferenceLabelRequest {
  readonly targetEntityId: string;
}

/** A searched child whose query passed current policy, with its entity. */
export interface AuthorizedSharedListSearchChild extends SharedListSearchChild {
  readonly childEntityId: string;
}

/** Progress whose two queries passed current policy, with their entities. */
export interface AuthorizedSharedListProgress extends SharedListProgress {
  readonly doneEntityId: string;
  readonly linesEntityId: string;
  /** The source entity of every query the supply reads, by query id. */
  readonly supplyEntityIds?: Readonly<Record<string, string>>;
}

export interface AuthorizedSharedListRequest {
  readonly query: SharedListQueryRequest;
  readonly relationLabels: readonly AuthorizedSharedListRelationLabel[];
  readonly referenceLabels?: readonly AuthorizedSharedListReferenceLabel[];
  readonly relatedFilter?: AuthorizedSharedListRelatedFilter;
  readonly progress?: AuthorizedSharedListProgress;
  readonly figures?: AuthorizedSharedListFigures;
  readonly searchChildren?: readonly AuthorizedSharedListSearchChild[];
}

export interface SharedListCoverage {
  readonly effectivePageSize: number;
  readonly hasMore: boolean;
  readonly includeArchived: boolean;
  readonly matchMode: 'prefix' | 'substring';
  readonly nextCursor: string | null;
  readonly pageOffset: number;
  /**
   * The parent restriction the executor actually applied. It is echoed so a
   * caller can require its filter to have been honoured: an executor that did
   * not understand `parentScope` cannot report having applied one, which turns
   * a silently ignored filter into an observable mismatch.
   */
  readonly parentScope: SharedListParentScope | null;
  readonly referenceScope?: SharedListParentScope;
  readonly fieldFilters?: readonly {
    readonly fieldId: string;
    readonly value: string;
  }[];
  /** Echoed like `parentScope`, so an executor that ignored it is observable. */
  readonly relatedFilter?: SharedListRelatedFilter;
  /**
   * Echoed, and REQUIRED to match by the gateway: an executor that ignored an
   * open view or a before-today view would count the wrong rows silently.
   */
  readonly beforeFilters?: readonly SharedListBeforeFilter[];
  readonly progress?: SharedListProgress;
  /** Echoed and REQUIRED to match, as progress is: a band kept is a count. */
  readonly figures?: SharedListFigures;
  /**
   * The figures' summary (REPORTS-HOME): each requested figure added up over
   * the whole filtered set, as a canonical decimal, or `null` where any row's
   * value is unstated. Present exactly when the figures ask for a summary.
   */
  readonly figureSummary?: Readonly<Record<string, string | null>>;
  /**
   * Echoed and REQUIRED to match: an executor that searched without the
   * children would miss every row found only through one of them.
   */
  readonly searchChildren?: readonly SharedListSearchChild[];
  /** Echoed so an executor that paged an export instead is observable. */
  readonly outputMode?: 'export';
  readonly projectedSearchValueCount: number;
  readonly requestedPageSize: number;
  readonly returnedCount: number;
  readonly schemaVersion: typeof SHARED_LIST_RESULT_VERSION;
  readonly search: string;
  readonly sort: readonly SharedListSort[];
  readonly totalCount: number;
  readonly truncatedByMaximum: boolean;
}

export interface SharedListResultLike<RecordValue = unknown> {
  readonly records: readonly RecordValue[];
  readonly listCoverage?: SharedListCoverage;
}

export function parseSharedListArguments(
  argumentsValue: ImmutableJsonValue,
  input: {
    readonly declaredParameterIds: readonly string[];
    readonly exportMaximumResultCount?: number;
    readonly maximumResultCount: number;
    readonly queryId: string;
  },
): SharedListQueryRequest | null {
  if (!isRecord(argumentsValue) || !Object.hasOwn(argumentsValue, 'list')) {
    return null;
  }
  assertExactKeys(
    argumentsValue,
    ['includeArchived', 'list', ...input.declaredParameterIds],
    true,
  );
  const includeArchived = optionalBoolean(
    argumentsValue.includeArchived,
    'includeArchived',
  );
  const list = argumentsValue.list;
  if (!isRecord(list)) {
    throw malformed('list must be an object');
  }
  // `parentScope` is the one optional member. It is lifted out so the rest of
  // the request keeps its exact closed-key contract: every required key must
  // still be present and any unknown key is still refused. Widening
  // `assertExactKeys` to tolerate absence would have relaxed the whole object.
  const {
    parentScope: parentScopeValue,
    fieldFilters: fieldFiltersValue,
    referenceScope: referenceScopeValue,
    relatedFilter: relatedFilterValue,
    referenceLabels: referenceLabelsValue,
    outputMode: outputModeValue,
    progress: progressValue,
    beforeFilters: beforeFiltersValue,
    figures: figuresValue,
    searchChildren: searchChildrenValue,
    ...closedList
  } = list;
  assertExactKeys(closedList, [
    'cursor',
    'matchMode',
    'pageSize',
    'relationLabels',
    'schemaVersion',
    'search',
    'sort',
  ]);
  const parentScope = parseParentScope(parentScopeValue);
  const referenceScope = parseParentScope(referenceScopeValue);
  const fieldFilters =
    fieldFiltersValue === undefined
      ? undefined
      : parseExactFieldFilters(fieldFiltersValue);
  const relatedFilter =
    relatedFilterValue === undefined
      ? undefined
      : (() => {
          if (!isRecord(relatedFilterValue))
            throw malformed('related filter must be an object');
          assertExactKeys(relatedFilterValue, [
            'fieldFilters',
            'queryId',
            'relationId',
          ]);
          assertCanonicalId(
            relatedFilterValue.queryId,
            'related filter queryId',
          );
          assertCanonicalId(
            relatedFilterValue.relationId,
            'related filter relationId',
          );
          return Object.freeze({
            fieldFilters: parseExactFieldFilters(
              relatedFilterValue.fieldFilters,
            ),
            queryId: relatedFilterValue.queryId,
            relationId: relatedFilterValue.relationId,
          });
        })();
  if (parentScope && referenceScope)
    throw malformed('one exact relation scope is allowed');
  const progress =
    progressValue === undefined ? undefined : parseProgress(progressValue);
  const figures =
    figuresValue === undefined
      ? undefined
      : parseSharedListFigures(figuresValue);
  if (progress && figures)
    throw malformed('a list reads progress or figures, not both');
  const beforeFilters =
    beforeFiltersValue === undefined
      ? undefined
      : parseBeforeFilters(beforeFiltersValue);
  const searchChildren =
    searchChildrenValue === undefined
      ? undefined
      : parseSearchChildren(searchChildrenValue);
  if (list.schemaVersion !== SHARED_LIST_QUERY_VERSION) {
    throw malformed('list schemaVersion is not supported');
  }
  if (
    !Number.isSafeInteger(list.pageSize) ||
    Number(list.pageSize) < 1 ||
    Number(list.pageSize) > 10_000
  ) {
    throw malformed('list pageSize must be an integer from 1 through 10000');
  }
  if (
    typeof list.search !== 'string' ||
    list.search.length > 240 ||
    list.search.includes('\u0000')
  ) {
    throw malformed('list search must be at most 240 characters');
  }
  if (list.matchMode !== 'substring' && list.matchMode !== 'prefix') {
    throw malformed('list matchMode must be prefix or substring');
  }
  const sort = parseSort(list.sort);
  const relationLabels = parseRelationLabels(list.relationLabels);
  const referenceLabels =
    referenceLabelsValue === undefined
      ? undefined
      : parseReferenceLabels(referenceLabelsValue, relationLabels);
  if (outputModeValue !== undefined && outputModeValue !== 'export')
    throw malformed('list outputMode must be export');
  const exporting = outputModeValue === 'export';
  if (exporting && input.exportMaximumResultCount === undefined)
    throw new SharedListContractError(
      'LIST_EXPORT_UNSUPPORTED',
      'this list query declares no export limit',
      input.queryId,
    );
  const cursor = parseNullableCursor(list.cursor);
  if (exporting && cursor !== null)
    throw malformed('an export reads the whole set and takes no cursor');
  const requestedPageSize = Number(list.pageSize);
  const effectivePageSize = Math.min(
    requestedPageSize,
    exporting
      ? (input.exportMaximumResultCount ?? 0)
      : input.maximumResultCount,
  );
  const bindingDigest = sharedListBindingDigest(input.queryId, {
    includeArchived,
    matchMode: list.matchMode,
    parentScope,
    ...(referenceScope ? { referenceScope } : {}),
    ...(fieldFilters ? { fieldFilters } : {}),
    ...(relatedFilter ? { relatedFilter } : {}),
    ...(progress ? { progress } : {}),
    ...(figures ? { figures } : {}),
    ...(beforeFilters ? { beforeFilters } : {}),
    relationLabels,
    ...(referenceLabels ? { referenceLabels } : {}),
    search: list.search,
    ...(searchChildren ? { searchChildren } : {}),
    sort,
  });
  const pageOffset = cursor ? decodeSharedListCursor(cursor, bindingDigest) : 0;
  return Object.freeze({
    cursor,
    effectivePageSize,
    includeArchived,
    matchMode: list.matchMode,
    pageOffset,
    parentScope,
    ...(referenceScope ? { referenceScope } : {}),
    ...(fieldFilters ? { fieldFilters } : {}),
    ...(relatedFilter ? { relatedFilter } : {}),
    ...(progress ? { progress } : {}),
    ...(figures ? { figures } : {}),
    ...(beforeFilters ? { beforeFilters } : {}),
    relationLabels,
    ...(referenceLabels ? { referenceLabels } : {}),
    ...(exporting ? { outputMode: 'export' as const } : {}),
    requestedPageSize,
    schemaVersion: SHARED_LIST_QUERY_VERSION,
    search: list.search,
    ...(searchChildren ? { searchChildren } : {}),
    sort,
    truncatedByMaximum: requestedPageSize > effectivePageSize,
  });
}

export function authorizeSharedListFields(
  query: SharedListQueryRequest,
  input: {
    readonly selectedFieldIds: ReadonlySet<string>;
  },
): void {
  const relationIds = new Set([
    ...query.relationLabels.map((relation) => relation.relationId),
    ...(query.referenceLabels ?? []).map((reference) => reference.referenceId),
  ]);
  for (const reference of query.referenceLabels ?? []) {
    if (!input.selectedFieldIds.has(reference.sourceFieldId)) {
      throw new SharedListContractError(
        'LIST_FIELD_NOT_AUTHORIZED',
        'a reference label reads a field the list query selects',
        reference.sourceFieldId,
      );
    }
  }
  for (const sort of query.sort) {
    if (
      !input.selectedFieldIds.has(sort.fieldId) &&
      !relationIds.has(sort.fieldId)
    ) {
      throw new SharedListContractError(
        'LIST_FIELD_NOT_AUTHORIZED',
        'list sort field is not an authorized server projection',
        sort.fieldId,
      );
    }
  }
  // A progress state and a before-today date compare stored values the query
  // selects; the figures come back under ids that shadow nothing it projects.
  const compared = [
    ...(query.progress?.openIn ? [query.progress.openIn.fieldId] : []),
    ...(query.progress?.supply?.shortIn
      ? [query.progress.supply.shortIn.fieldId]
      : []),
    ...(query.beforeFilters ?? []).map((filter) => filter.fieldId),
  ];
  for (const fieldId of compared) {
    if (!input.selectedFieldIds.has(fieldId)) {
      throw new SharedListContractError(
        'LIST_FIELD_NOT_AUTHORIZED',
        'a progress state or before filter reads a field the list query selects',
        fieldId,
      );
    }
  }
  for (const output of [
    ...Object.values(query.progress?.outputs ?? {}),
    ...Object.values(query.progress?.supply?.outputs ?? {}),
  ]) {
    if (input.selectedFieldIds.has(output) || relationIds.has(output)) {
      throw new SharedListContractError(
        'LIST_FIELD_NOT_AUTHORIZED',
        'a progress output would shadow a projected field or label',
        output,
      );
    }
  }
  // A figure adds or compares the listed row's own exact decimals, which the
  // query selects; its id shadows nothing the query projects.
  if (query.figures) {
    for (const fieldId of sharedListFigureRowFields(query.figures))
      if (!input.selectedFieldIds.has(fieldId))
        throw new SharedListContractError(
          'LIST_FIELD_NOT_AUTHORIZED',
          'a figure adds or compares a field the list query selects',
          fieldId,
        );
    for (const figureId of sharedListFigureKinds(query.figures).keys())
      if (input.selectedFieldIds.has(figureId) || relationIds.has(figureId))
        throw new SharedListContractError(
          'LIST_FIELD_NOT_AUTHORIZED',
          'a figure would shadow a projected field or label',
          figureId,
        );
  }
}

/**
 * The executor must report the progress and before filters it applied, and
 * they must be the ones asked for: a figure missing from a row reads as an
 * unstated value, but a count taken without the open or before filter would be
 * a wrong number presented as exact. Checked by the gateway on every answer.
 */
export function requireSharedListEcho(
  query: SharedListQueryRequest,
  listCoverage: SharedListCoverage,
): void {
  const same = (
    left: ImmutableJsonValue | undefined,
    right: ImmutableJsonValue | undefined,
  ) =>
    left === undefined || right === undefined
      ? left === right
      : canonicalize(left) === canonicalize(right);
  if (
    !same(
      query.progress as ImmutableJsonValue | undefined,
      listCoverage.progress as ImmutableJsonValue | undefined,
    ) ||
    !same(
      query.beforeFilters as ImmutableJsonValue | undefined,
      listCoverage.beforeFilters as ImmutableJsonValue | undefined,
    ) ||
    !same(
      query.figures as ImmutableJsonValue | undefined,
      listCoverage.figures as ImmutableJsonValue | undefined,
    ) ||
    !same(
      query.searchChildren as ImmutableJsonValue | undefined,
      listCoverage.searchChildren as ImmutableJsonValue | undefined,
    )
  ) {
    throw new SharedListContractError(
      'LIST_RESULT_MALFORMED',
      'the list result did not apply the requested progress, figures, before filters or searched children',
    );
  }
  // A report's totals answer exactly the figures asked for, each a decimal
  // or unstated (REPORTS-HOME): a missing or extra total is never guessed.
  const asked = query.figures?.summary;
  const answered = listCoverage.figureSummary;
  if (
    (asked === undefined) !== (answered === undefined) ||
    (asked !== undefined &&
      answered !== undefined &&
      (Object.keys(answered).length !== asked.length ||
        !asked.every(
          (figureId) =>
            Object.hasOwn(answered, figureId) &&
            (answered[figureId] === null ||
              (typeof answered[figureId] === 'string' &&
                /^-?\d+(?:\.\d+)?$/u.test(answered[figureId]))),
        )))
  )
    throw new SharedListContractError(
      'LIST_RESULT_MALFORMED',
      'the list result did not answer the requested figure summary',
    );
}

export function requireSharedListResult<RecordValue>(
  result: SharedListResultLike<RecordValue>,
): Readonly<{
  listCoverage: SharedListCoverage;
  records: readonly RecordValue[];
}> {
  if (!result.listCoverage) {
    throw new SharedListContractError(
      'LIST_RESULT_MALFORMED',
      'semantic query did not return shared list coverage',
    );
  }
  assertSharedListResult(result.listCoverage, result.records.length);
  return Object.freeze({
    listCoverage: result.listCoverage,
    records: result.records,
  });
}

export function assertSharedListResult(
  listCoverage: SharedListCoverage,
  recordCount: number,
): void {
  if (
    listCoverage.schemaVersion !== SHARED_LIST_RESULT_VERSION ||
    !Number.isSafeInteger(listCoverage.returnedCount) ||
    listCoverage.returnedCount !== recordCount ||
    !Number.isSafeInteger(listCoverage.totalCount) ||
    listCoverage.totalCount < listCoverage.returnedCount ||
    !Number.isSafeInteger(listCoverage.pageOffset) ||
    listCoverage.pageOffset < 0 ||
    !Number.isSafeInteger(listCoverage.projectedSearchValueCount) ||
    listCoverage.projectedSearchValueCount < 0 ||
    listCoverage.hasMore !==
      listCoverage.pageOffset + listCoverage.returnedCount <
        listCoverage.totalCount ||
    (listCoverage.hasMore && listCoverage.nextCursor === null) ||
    (!listCoverage.hasMore && listCoverage.nextCursor !== null)
  ) {
    throw new SharedListContractError(
      'LIST_RESULT_MALFORMED',
      'shared list result coverage is internally inconsistent',
    );
  }
}

function parseSort(
  value: ImmutableJsonValue | undefined,
): readonly SharedListSort[] {
  if (!Array.isArray(value) || value.length > 3) {
    throw malformed('list sort must contain at most three entries');
  }
  const fieldIds = new Set<string>();
  const result = value.map((entry): SharedListSort => {
    if (!isRecord(entry)) throw malformed('list sort entry must be an object');
    assertExactKeys(entry, ['direction', 'fieldId']);
    assertCanonicalId(entry.fieldId, 'list sort fieldId');
    if (entry.direction !== 'ascending' && entry.direction !== 'descending') {
      throw malformed('list sort direction is not supported');
    }
    if (fieldIds.has(entry.fieldId)) {
      throw malformed('list sort fieldIds must be unique');
    }
    fieldIds.add(entry.fieldId);
    return Object.freeze({
      direction: entry.direction,
      fieldId: entry.fieldId,
    });
  });
  return Object.freeze(result);
}

function parseExactFieldFilters(
  value: ImmutableJsonValue | undefined,
): readonly { readonly fieldId: string; readonly value: string }[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4)
    throw malformed('one to four exact field filters required');
  return Object.freeze(
    value.map((entry) => {
      if (!isRecord(entry)) throw malformed('field filter must be an object');
      assertExactKeys(entry, ['fieldId', 'value']);
      if (
        typeof entry.fieldId !== 'string' ||
        !canonicalIdPattern.test(entry.fieldId) ||
        typeof entry.value !== 'string' ||
        entry.value.length > 240
      )
        throw malformed('invalid exact field filter');
      return Object.freeze({ fieldId: entry.fieldId, value: entry.value });
    }),
  );
}

function parseProgressSource(
  value: ImmutableJsonValue | undefined,
  name: string,
): SharedListProgressSource {
  if (!isRecord(value))
    throw malformed(`list progress ${name} must be an object`);
  assertExactKeys(value, ['fieldId', 'queryId', 'relationId']);
  assertCanonicalId(value.fieldId, `list progress ${name} fieldId`);
  assertCanonicalId(value.queryId, `list progress ${name} queryId`);
  assertCanonicalId(value.relationId, `list progress ${name} relationId`);
  return Object.freeze({
    fieldId: value.fieldId,
    queryId: value.queryId,
    relationId: value.relationId,
  });
}

function parseProgress(value: ImmutableJsonValue): SharedListProgress {
  if (!isRecord(value)) throw malformed('list progress must be an object');
  const { openIn, openOnly, supply: supplyValue, ...closed } = value;
  assertExactKeys(closed, ['done', 'lines', 'outputs']);
  const outputs = closed.outputs;
  if (!isRecord(outputs))
    throw malformed('list progress outputs must be an object');
  assertExactKeys(outputs, ['done', 'open', 'ordered']);
  assertCanonicalId(outputs.done, 'list progress done output');
  assertCanonicalId(outputs.open, 'list progress open output');
  assertCanonicalId(outputs.ordered, 'list progress ordered output');
  if (new Set([outputs.done, outputs.open, outputs.ordered]).size !== 3)
    throw malformed('list progress outputs must be three distinct ids');
  const supply =
    supplyValue === undefined ? undefined : parseSharedListSupply(supplyValue);
  if (
    supply &&
    [supply.outputs.covered, supply.outputs.short].some((output) =>
      [outputs.done, outputs.open, outputs.ordered].includes(output),
    )
  )
    throw malformed('list supply outputs are not progress outputs');
  if (openOnly !== undefined && openOnly !== true)
    throw malformed('list progress openOnly is true when present');
  const states =
    openIn === undefined
      ? undefined
      : (() => {
          if (!isRecord(openIn))
            throw malformed('list progress openIn must be an object');
          assertExactKeys(openIn, ['fieldId', 'values']);
          assertCanonicalId(openIn.fieldId, 'list progress openIn fieldId');
          const values = openIn.values;
          if (
            !Array.isArray(values) ||
            values.length === 0 ||
            values.length > 8 ||
            values.some(
              (entry) =>
                typeof entry !== 'string' ||
                entry.length === 0 ||
                entry.length > 240,
            ) ||
            new Set(values).size !== values.length
          )
            throw malformed('list progress openIn holds one to eight values');
          return Object.freeze({
            fieldId: openIn.fieldId,
            values: Object.freeze([...(values as string[])]),
          });
        })();
  return Object.freeze({
    done: parseProgressSource(closed.done, 'done'),
    lines: parseProgressSource(closed.lines, 'lines'),
    ...(states ? { openIn: states } : {}),
    ...(openOnly === true ? { openOnly: true as const } : {}),
    outputs: Object.freeze({
      done: outputs.done,
      open: outputs.open,
      ordered: outputs.ordered,
    }),
    ...(supply ? { supply } : {}),
  });
}

/** One or two children, each through its own relation. */
function parseSearchChildren(
  value: ImmutableJsonValue,
): readonly SharedListSearchChild[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2)
    throw malformed('one or two searched children required');
  const relationIds = new Set<string>();
  return Object.freeze(
    value.map((entry) => {
      if (!isRecord(entry)) throw malformed('searched child must be an object');
      assertExactKeys(entry, ['fieldId', 'queryId', 'relationId']);
      assertCanonicalId(entry.fieldId, 'searched child fieldId');
      assertCanonicalId(entry.queryId, 'searched child queryId');
      assertCanonicalId(entry.relationId, 'searched child relationId');
      if (relationIds.has(entry.relationId))
        throw malformed('searched child relationIds must be unique');
      relationIds.add(entry.relationId);
      return Object.freeze({
        fieldId: entry.fieldId,
        queryId: entry.queryId,
        relationId: entry.relationId,
      });
    }),
  );
}

/** Only a canonical UTC instant, so the digest and the SQL see one spelling. */
function parseBeforeFilters(
  value: ImmutableJsonValue,
): readonly SharedListBeforeFilter[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4)
    throw malformed('one to four before filters required');
  const fieldIds = new Set<string>();
  return Object.freeze(
    value.map((entry) => {
      if (!isRecord(entry)) throw malformed('before filter must be an object');
      assertExactKeys(entry, ['before', 'fieldId']);
      assertCanonicalId(entry.fieldId, 'before filter fieldId');
      const before = entry.before;
      if (
        typeof before !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(before) ||
        !Number.isFinite(Date.parse(before)) ||
        new Date(before).toISOString() !== before
      )
        throw malformed('before filter must be a canonical UTC instant');
      if (fieldIds.has(entry.fieldId))
        throw malformed('before filter fieldIds must be unique');
      fieldIds.add(entry.fieldId);
      return Object.freeze({ before, fieldId: entry.fieldId });
    }),
  );
}

function parseRelationLabels(
  value: ImmutableJsonValue | undefined,
): readonly SharedListRelationLabelRequest[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw malformed('list relationLabels must contain at most eight entries');
  }
  const relationIds = new Set<string>();
  return Object.freeze(
    value.map((entry): SharedListRelationLabelRequest => {
      if (!isRecord(entry)) {
        throw malformed('list relation label entry must be an object');
      }
      assertExactKeys(entry, ['fieldId', 'queryId', 'relationId']);
      assertCanonicalId(entry.fieldId, 'list relation label fieldId');
      assertCanonicalId(entry.queryId, 'list relation label queryId');
      assertCanonicalId(entry.relationId, 'list relation label relationId');
      if (relationIds.has(entry.relationId)) {
        throw malformed('list relation label relationIds must be unique');
      }
      relationIds.add(entry.relationId);
      return Object.freeze({
        fieldId: entry.fieldId,
        queryId: entry.queryId,
        relationId: entry.relationId,
      });
    }),
  );
}

function parseReferenceLabels(
  value: ImmutableJsonValue,
  relationLabels: readonly SharedListRelationLabelRequest[],
): readonly SharedListReferenceLabelRequest[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw malformed('list referenceLabels must contain at most eight entries');
  }
  const ids = new Set(relationLabels.map((relation) => relation.relationId));
  return Object.freeze(
    value.map((entry): SharedListReferenceLabelRequest => {
      if (!isRecord(entry)) {
        throw malformed('list reference label entry must be an object');
      }
      assertExactKeys(entry, [
        'fieldId',
        'queryId',
        'referenceId',
        'sourceFieldId',
      ]);
      assertCanonicalId(entry.fieldId, 'list reference label fieldId');
      assertCanonicalId(entry.queryId, 'list reference label queryId');
      assertCanonicalId(entry.referenceId, 'list reference label referenceId');
      assertCanonicalId(
        entry.sourceFieldId,
        'list reference label sourceFieldId',
      );
      if (ids.has(entry.referenceId)) {
        throw malformed('list label ids must be unique');
      }
      ids.add(entry.referenceId);
      return Object.freeze({
        fieldId: entry.fieldId,
        queryId: entry.queryId,
        referenceId: entry.referenceId,
        sourceFieldId: entry.sourceFieldId,
      });
    }),
  );
}

function optionalBoolean(
  value: ImmutableJsonValue | undefined,
  name: string,
): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw malformed(`${name} must be boolean`);
  return value;
}

function assertCanonicalId(
  value: unknown,
  name: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 5 ||
    value.length > 180 ||
    !canonicalIdPattern.test(value)
  ) {
    throw malformed(`${name} must be a canonical ID`);
  }
}

function parseParentScope(
  value: ImmutableJsonValue | undefined,
): SharedListParentScope | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw malformed('list parentScope must be an object');
  }
  assertExactKeys(value, ['recordId', 'relationId']);
  const { recordId, relationId } = value;
  if (typeof relationId !== 'string' || !canonicalIdPattern.test(relationId)) {
    throw malformed('list parentScope relationId must be a canonical id');
  }
  if (
    typeof recordId !== 'string' ||
    !canonicalRecordIdPattern.test(recordId)
  ) {
    throw malformed('list parentScope recordId must be a canonical uuid');
  }
  return Object.freeze({ recordId, relationId });
}
