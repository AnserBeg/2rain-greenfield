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

// The closed-contract primitives and cursor identity moved to siblings; both
// stay part of this module's public surface so no caller import changes.
export { SharedListContractError } from './contract.js';
export { encodeSharedListCursor } from './cursor.js';

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
  readonly relationLabels: readonly SharedListRelationLabelRequest[];
  readonly requestedPageSize: number;
  readonly schemaVersion: typeof SHARED_LIST_QUERY_VERSION;
  readonly search: string;
  readonly sort: readonly SharedListSort[];
  readonly truncatedByMaximum: boolean;
}

export interface AuthorizedSharedListRelationLabel extends SharedListRelationLabelRequest {
  readonly targetEntityId: string;
}

export interface AuthorizedSharedListRequest {
  readonly query: SharedListQueryRequest;
  readonly relationLabels: readonly AuthorizedSharedListRelationLabel[];
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
      : (() => {
          if (
            !Array.isArray(fieldFiltersValue) ||
            fieldFiltersValue.length === 0 ||
            fieldFiltersValue.length > 4
          )
            throw malformed('one to four exact field filters required');
          return fieldFiltersValue.map((value) => {
            if (!isRecord(value))
              throw malformed('field filter must be an object');
            assertExactKeys(value, ['fieldId', 'value']);
            if (
              typeof value.fieldId !== 'string' ||
              !canonicalIdPattern.test(value.fieldId) ||
              typeof value.value !== 'string' ||
              value.value.length > 240
            )
              throw malformed('invalid exact field filter');
            return { fieldId: value.fieldId, value: value.value };
          });
        })();
  if (parentScope && referenceScope)
    throw malformed('one exact relation scope is allowed');
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
  const cursor = parseNullableCursor(list.cursor);
  const requestedPageSize = Number(list.pageSize);
  const effectivePageSize = Math.min(
    requestedPageSize,
    input.maximumResultCount,
  );
  const bindingDigest = sharedListBindingDigest(input.queryId, {
    includeArchived,
    matchMode: list.matchMode,
    parentScope,
    ...(referenceScope ? { referenceScope } : {}),
    ...(fieldFilters ? { fieldFilters } : {}),
    relationLabels,
    search: list.search,
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
    relationLabels,
    requestedPageSize,
    schemaVersion: SHARED_LIST_QUERY_VERSION,
    search: list.search,
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
  const relationIds = new Set(
    query.relationLabels.map((relation) => relation.relationId),
  );
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
