import { createHash } from 'node:crypto';

import { canonicalize } from '@north-star/canonical-model';

import type { ImmutableJsonValue } from '../request-runtime-view.js';
import {
  assertExactKeys,
  isRecord,
  malformed,
  SharedListContractError,
} from './contract.js';
import type { SharedListQueryRequest } from './index.js';

/**
 * CURSOR IDENTITY. A page window only means something against the exact query
 * shape it was minted for, so the binding digest covers every member that can
 * move a row into or out of the set -- archive inclusion, match mode, search,
 * sort, relation labels and the parent scope -- and the cursor carries a
 * checksum over that digest. A cursor minted for one shape, one parent or one
 * relation therefore cannot decode against another; it is refused rather than
 * silently reinterpreted as an offset into a different set.
 */
const SHARED_LIST_CURSOR_VERSION = 'northstar.shared-list-cursor/v1' as const;

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

export function decodeSharedListCursor(
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

export function sharedListBindingDigest(
  queryId: string,
  query: Pick<
    SharedListQueryRequest,
    | 'includeArchived'
    | 'matchMode'
    | 'parentScope'
    | 'referenceScope'
    | 'fieldFilters'
    | 'relatedFilter'
    | 'relationLabels'
    | 'search'
    | 'sort'
  >,
): string {
  return digestCanonical({
    includeArchived: query.includeArchived,
    matchMode: query.matchMode,
    // The parent belongs to cursor identity: a page window for parent A is
    // meaningless against parent B or against a different relation, so a cursor
    // minted under one parent scope must not decode under another.
    parentScope: query.parentScope,
    ...(query.referenceScope ? { referenceScope: query.referenceScope } : {}),
    ...(query.fieldFilters ? { fieldFilters: query.fieldFilters } : {}),
    // Likewise a window over customers is not a window over suppliers.
    ...(query.relatedFilter ? { relatedFilter: query.relatedFilter } : {}),
    queryId,
    relationLabels: query.relationLabels,
    search: query.search,
    sort: query.sort,
  });
}

function digestCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function parseNullableCursor(
  value: ImmutableJsonValue | undefined,
): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048) {
    throw malformed('list cursor must be null or a bounded opaque string');
  }
  return value;
}
