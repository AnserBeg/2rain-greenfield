import * as SemanticQueryContract from './semantic-query-gateway.js';
import type * as RuntimeViewContract from './request-runtime-view.js';

export const RESOLVE_BY_NAME_VERSION = 'northstar.resolve-by-name/v1' as const;

export interface ResolveByNameContract {
  readonly exactIdentifierFieldIds: readonly string[];
  readonly listQueryId: string;
  readonly nameFieldIds: readonly string[];
  readonly resolveQueryId: string;
}

export class InvalidResolveByNameContractError extends Error {
  readonly code = 'INVALID_RESOLVE_BY_NAME_CONTRACT' as const;
  override readonly name = 'InvalidResolveByNameContractError';
}

/**
 * Generic resolver composition over tenant-scoped semantic queries. Exact
 * identifiers may select; every name/fuzzy result requires clarification.
 */
export async function resolveByName(
  gateway: SemanticQueryContract.SemanticQueryGateway,
  view: RuntimeViewContract.RequestRuntimeView,
  contract: ResolveByNameContract,
  text: string,
): Promise<SemanticQueryContract.SemanticQueryResultEnvelope> {
  const declared = assertContract(view, contract);
  const queryText = normalizeResolverText(text);
  if (queryText.length === 0)
    return result(contract.resolveQueryId, 'not-found');

  const exact = await gateway.invoke(view, {
    arguments: { text },
    queryId: contract.resolveQueryId,
    schemaVersion: SemanticQueryContract.SEMANTIC_QUERY_REQUEST_VERSION,
  });
  if (exact.outcome !== 'not-found') return exact;

  const candidates = await gateway.invoke(view, {
    arguments: { limit: declared.maximumResultCount },
    queryId: contract.listQueryId,
    schemaVersion: SemanticQueryContract.SEMANTIC_QUERY_REQUEST_VERSION,
  });
  if (candidates.outcome === 'unsupported') {
    return result(
      contract.resolveQueryId,
      'unsupported',
      [],
      candidates.unsupportedReason,
    );
  }
  const ranked = rankResolverCandidates(
    text,
    candidates.records,
    contract.nameFieldIds,
  );
  return ranked.length === 0
    ? result(contract.resolveQueryId, 'not-found')
    : result(
        contract.resolveQueryId,
        'ambiguous',
        ranked.map((entry) => entry.record),
      );
}

export function normalizeResolverText(value: string): string {
  return value
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[_-]+/g, ' ')
    .replaceAll(/[^a-z0-9\s]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

export function resolverTextSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeResolverText(left);
  const normalizedRight = normalizeResolverText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  const edit = normalizedEditSimilarity(normalizedLeft, normalizedRight);
  const tokenSort = normalizedEditSimilarity(
    sortedTokens(normalizedLeft),
    sortedTokens(normalizedRight),
  );
  const jaccard = tokenJaccard(normalizedLeft, normalizedRight);
  const containment =
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
      ? Math.min(normalizedLeft.length, normalizedRight.length) /
        Math.max(normalizedLeft.length, normalizedRight.length)
      : 0;
  return Math.max(edit, tokenSort, jaccard, containment);
}

export function rankResolverCandidates(
  text: string,
  records: readonly SemanticQueryContract.SemanticRecordDto[],
  declaredNameFieldIds: readonly string[],
  minimumScore = 0.72,
): readonly {
  readonly record: SemanticQueryContract.SemanticRecordDto;
  readonly score: number;
}[] {
  return records
    .map((record) => ({
      record,
      score: Math.max(
        0,
        ...declaredNameFieldIds.map((fieldId) =>
          resolverTextSimilarity(text, stringValue(record, fieldId)),
        ),
      ),
    }))
    .filter((entry) => entry.score >= minimumScore)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.record.recordId.localeCompare(right.record.recordId),
    );
}

function assertContract(
  view: RuntimeViewContract.RequestRuntimeView,
  contract: ResolveByNameContract,
): { readonly maximumResultCount: number } {
  const resolve = SemanticQueryContract.registeredQueryFromPinnedView(
    view,
    contract.resolveQueryId,
  );
  const list = SemanticQueryContract.registeredQueryFromPinnedView(
    view,
    contract.listQueryId,
  );
  const allFieldIds = [
    ...contract.exactIdentifierFieldIds,
    ...contract.nameFieldIds,
  ];
  const resolveSelections = new Set(
    resolve?.selections.map((selection) => selection.fieldId) ?? [],
  );
  const listSelections = new Set(
    list?.selections.map((selection) => selection.fieldId) ?? [],
  );
  const identifierAuthorities = new Set(
    resolve?.resolveMatchKeys
      ?.filter((key) => key.authority === 'identifier')
      .map((key) => key.fieldId) ?? [],
  );
  const advisoryAuthorities = new Set(
    resolve?.resolveMatchKeys
      ?.filter((key) => key.authority === 'advisory')
      .map((key) => key.fieldId) ?? [],
  );
  if (
    !resolve ||
    !list ||
    resolve.queryType !== 'resolve' ||
    list.queryType !== 'list' ||
    resolve.sourceEntityId !== list.sourceEntityId ||
    contract.exactIdentifierFieldIds.length === 0 ||
    contract.nameFieldIds.length === 0 ||
    new Set(allFieldIds).size !== allFieldIds.length ||
    !sameMembers(
      identifierAuthorities,
      new Set(contract.exactIdentifierFieldIds),
    ) ||
    !sameMembers(advisoryAuthorities, new Set(contract.nameFieldIds)) ||
    allFieldIds.some(
      (fieldId) =>
        !resolveSelections.has(fieldId) || !listSelections.has(fieldId),
    )
  ) {
    throw new InvalidResolveByNameContractError(
      'resolve-by-name requires compatible compiled resolve/list queries whose selected fields match the declared identifier/advisory authority',
    );
  }
  return { maximumResultCount: list.maximumResultCount };
}

function sameMembers(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size === right.size && [...left].every((member) => right.has(member))
  );
}

function stringValue(
  record: SemanticQueryContract.SemanticRecordDto,
  fieldId: string,
): string {
  const value = record.values[fieldId];
  return typeof value === 'string' ? value : '';
}

function result(
  queryId: string,
  outcome: SemanticQueryContract.SemanticQueryResultEnvelope['outcome'],
  records: readonly SemanticQueryContract.SemanticRecordDto[] = [],
  unsupportedReason: string | null = null,
): SemanticQueryContract.SemanticQueryResultEnvelope {
  return Object.freeze({
    kind: 'semanticQueryResult' as const,
    outcome,
    queryId,
    records: Object.freeze([...records]),
    schemaVersion: SemanticQueryContract.SEMANTIC_QUERY_RESULT_VERSION,
    unsupportedReason,
  });
}

function normalizedEditSimilarity(left: string, right: string): number {
  const maximum = Math.max(left.length, right.length);
  return maximum === 0 ? 1 : 1 - levenshtein(left, right) / maximum;
}

function levenshtein(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function sortedTokens(value: string): string {
  return value.split(' ').filter(Boolean).sort().join(' ');
}

function tokenJaccard(left: string, right: string): number {
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  const union = new Set([...leftTokens, ...rightTokens]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / union.size;
}
