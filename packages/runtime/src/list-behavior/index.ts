import { createHash } from 'node:crypto';

import { canonicalize } from '@north-star/canonical-model';

import type { ImmutableJsonValue } from '../request-runtime-view.js';

export const SHARED_LIST_QUERY_VERSION =
  'northstar.shared-list-query/v1' as const;
export const SHARED_LIST_RESULT_VERSION =
  'northstar.shared-list-result/v1' as const;
const SHARED_LIST_CURSOR_VERSION = 'northstar.shared-list-cursor/v1' as const;

const canonicalIdPattern =
  /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export interface SharedListSort {
  readonly direction: 'ascending' | 'descending';
  readonly fieldId: string;
}

export interface SharedListRelationLabelRequest {
  readonly fieldId: string;
  readonly queryId: string;
  readonly relationId: string;
}

export interface SharedListQueryRequest {
  readonly cursor: string | null;
  readonly effectivePageSize: number;
  readonly includeArchived: boolean;
  readonly matchMode: 'prefix' | 'substring';
  readonly pageOffset: number;
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

export class SharedListContractError extends Error {
  override readonly name = 'SharedListContractError';

  constructor(
    readonly code:
      | 'LIST_CURSOR_INVALID'
      | 'LIST_FIELD_NOT_AUTHORIZED'
      | 'LIST_INPUT_MALFORMED'
      | 'LIST_RESULT_MALFORMED',
    message: string,
    readonly subjectId: string | null = null,
  ) {
    super(message);
  }
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
  assertExactKeys(list, [
    'cursor',
    'matchMode',
    'pageSize',
    'relationLabels',
    'schemaVersion',
    'search',
    'sort',
  ]);
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

export function encodeSharedListCursor(
  queryId: string,
  query: SharedListQueryRequest,
  nextOffset: number,
): string {
  if (!Number.isSafeInteger(nextOffset) || nextOffset < 1) {
    throw new SharedListContractError(
      'LIST_CURSOR_INVALID',
      'list cursor offset must be a positive safe integer',
    );
  }
  const bindingDigest = sharedListBindingDigest(queryId, query);
  const unsigned = {
    bindingDigest,
    offset: nextOffset,
    schemaVersion: SHARED_LIST_CURSOR_VERSION,
  };
  const checksum = digestCanonical(unsigned);
  return Buffer.from(canonicalize({ ...unsigned, checksum })).toString(
    'base64url',
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

function decodeSharedListCursor(
  cursor: string,
  expectedBindingDigest: string,
): number {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (!isRecord(decoded)) throw new Error('not an object');
    assertExactKeys(decoded, [
      'bindingDigest',
      'checksum',
      'offset',
      'schemaVersion',
    ]);
    if (
      decoded.schemaVersion !== SHARED_LIST_CURSOR_VERSION ||
      decoded.bindingDigest !== expectedBindingDigest ||
      typeof decoded.checksum !== 'string' ||
      !Number.isSafeInteger(decoded.offset) ||
      Number(decoded.offset) < 1
    ) {
      throw new Error('cursor values are invalid');
    }
    const expectedChecksum = digestCanonical({
      bindingDigest: decoded.bindingDigest,
      offset: decoded.offset,
      schemaVersion: decoded.schemaVersion,
    });
    if (decoded.checksum !== expectedChecksum) {
      throw new Error('cursor checksum is invalid');
    }
    return Number(decoded.offset);
  } catch {
    throw new SharedListContractError(
      'LIST_CURSOR_INVALID',
      'list cursor is malformed, altered, or belongs to another query shape',
    );
  }
}

function sharedListBindingDigest(
  queryId: string,
  query: Pick<
    SharedListQueryRequest,
    'includeArchived' | 'matchMode' | 'relationLabels' | 'search' | 'sort'
  >,
): string {
  return digestCanonical({
    includeArchived: query.includeArchived,
    matchMode: query.matchMode,
    queryId,
    relationLabels: query.relationLabels,
    search: query.search,
    sort: query.sort,
  });
}

function digestCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function optionalBoolean(
  value: ImmutableJsonValue | undefined,
  name: string,
): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw malformed(`${name} must be boolean`);
  return value;
}

function parseNullableCursor(
  value: ImmutableJsonValue | undefined,
): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048) {
    throw malformed('list cursor must be null or a bounded opaque string');
  }
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

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  allowMissing = false,
): void {
  const actual = Object.keys(value).sort();
  const expectedSorted = [...expected].sort();
  if (
    actual.some((key) => !expectedSorted.includes(key)) ||
    (!allowMissing && actual.join('\0') !== expectedSorted.join('\0'))
  ) {
    throw malformed('list object keys do not match the closed contract');
  }
}

function malformed(message: string): SharedListContractError {
  return new SharedListContractError('LIST_INPUT_MALFORMED', message);
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, ImmutableJsonValue | undefined>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
