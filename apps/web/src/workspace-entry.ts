import {
  trustedContextForRequestRuntimeView,
  type RequestRuntimeView,
} from '../../../packages/runtime/src/request-runtime-view.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticQueryGateway,
  type SemanticRecordDto,
} from '../../../packages/runtime/src/semantic-query-gateway.js';
import {
  requireSharedListResult,
  SHARED_LIST_QUERY_VERSION,
} from '../../../packages/runtime/src/list-behavior/index.js';
import type { CompiledSurfaceDefinition } from './surface-contract.js';

const preferences = new Map<string, string>();
export function workspacePrincipalKey(view: RequestRuntimeView) {
  const identity = trustedContextForRequestRuntimeView(view);
  return JSON.stringify([
    identity.tenantId,
    identity.environmentId,
    identity.principalId,
  ]);
}
export async function workspaceList(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  queryId: string,
  scope: string | null,
  restriction?: { relationId: string; recordId: string },
  sort: readonly {
    fieldId: string;
    direction: 'ascending' | 'descending';
  }[] = [],
) {
  const definition = registeredSemanticQueryFromPinnedView(view, queryId);
  if (!definition || definition.queryType !== 'list')
    throw new Error('Declared list unavailable');
  const records: SemanticRecordDto[] = [];
  let cursor: string | null = null;
  do {
    const result: ReturnType<
      typeof requireSharedListResult<SemanticRecordDto>
    > = requireSharedListResult(
      await gateway.invoke(view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId,
        arguments: {
          includeArchived: false,
          ...(definition.legalEntityScope
            ? { [definition.legalEntityScope.operand.parameterId]: scope }
            : {}),
          list: {
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            cursor,
            pageSize: definition.maximumResultCount,
            search: '',
            matchMode: 'substring',
            sort: [...sort],
            relationLabels: [],
            ...(restriction ? { parentScope: restriction } : {}),
          },
        },
      }),
    );
    if (
      restriction &&
      (result.listCoverage.parentScope?.recordId !== restriction.recordId ||
        result.listCoverage.parentScope.relationId !== restriction.relationId)
    )
      throw new Error('Exact parent scope unavailable');
    records.push(...result.records);
    const next = result.listCoverage.hasMore
      ? result.listCoverage.nextCursor
      : null;
    if (
      result.listCoverage.hasMore &&
      (!next || next === cursor || !result.records.length)
    )
      throw new Error('Incomplete list');
    cursor = next;
  } while (cursor);
  return records;
}
/** Preference never supplies an operation operand: entry materializes a URL. */
export async function resolveWorkspaceEntry(
  view: RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  url: URL,
  gateway: SemanticQueryGateway,
) {
  const policy = surface.workspace?.entry;
  const definition = registeredSemanticQueryFromPinnedView(
    view,
    surface.dataSourceQueryId,
  );
  if (!policy || !definition?.legalEntityScope) return null;
  const parameter = definition.legalEntityScope.operand.parameterId;
  const candidates = await workspaceList(
    view,
    gateway,
    policy.companyQueryId,
    null,
  ).catch(() => []);
  const options: { recordId: string; label: string }[] = [];
  for (const record of candidates) {
    if (record.values[policy.companyStateFieldId] !== policy.activeStateId)
      continue;
    try {
      // A current scoped semantic read proves entry authority for this workspace.
      await workspaceList(
        view,
        gateway,
        policy.authorizationQueryId,
        record.recordId,
      );
      const label = record.values[policy.companyNameFieldId];
      if (typeof label === 'string' && label.trim())
        options.push({ recordId: record.recordId, label });
    } catch {
      /* Unavailable or unauthorized companies are never defaults. */
    }
  }
  const explicit = url.searchParams.getAll(parameter);
  const key = workspacePrincipalKey(view);
  if (explicit.length) {
    // Explicit context is validated against current active authorized membership.
    if (
      explicit.length === 1 &&
      options.some((option) => option.recordId === explicit[0])
    )
      preferences.set(key, explicit[0]!);
    return {
      options,
      parameter,
      selected: explicit.length === 1 ? explicit[0]! : null,
      redirect: null,
      invalid:
        explicit.length !== 1 ||
        !options.some((option) => option.recordId === explicit[0]),
    };
  }
  // Only workspace entry can default. Existing documents/tasks require pinned URLs.
  if (url.searchParams.has('record') || surface.surfaceRole !== 'list')
    return { options, parameter, selected: null, redirect: null };
  const preference = preferences.get(key);
  const selected =
    options.length === 1
      ? options[0]!.recordId
      : (options.find((option) => option.recordId === preference)?.recordId ??
        null);
  if (selected) url.searchParams.set(parameter, selected);
  return {
    options,
    parameter,
    selected,
    redirect: selected ? url.pathname + url.search : null,
  };
}

/**
 * One authorized page of a declared list, searched on the server. A picker uses
 * this instead of `workspaceList`, so it never pulls a whole master table into
 * every line, and it reports `hasMore` so "not on this page" is never read as
 * "does not exist".
 */
export async function workspaceSearch(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  queryId: string,
  scope: string | null,
  search: string,
  cursor: string | null,
  eligibility?: ReferenceEligibility,
  parentScope?: { readonly relationId: string; readonly recordId: string },
): Promise<{
  records: readonly SemanticRecordDto[];
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const definition = registeredSemanticQueryFromPinnedView(view, queryId);
  if (!definition || definition.queryType !== 'list')
    throw new Error('Declared list unavailable');
  const relatedFilter = eligibility
    ? {
        queryId: eligibility.queryId,
        relationId: eligibility.relationId,
        fieldFilters: eligibility.filters.map((filter) => ({
          fieldId: filter.fieldId,
          value: filter.value,
        })),
      }
    : undefined;
  const result = requireSharedListResult<SemanticRecordDto>(
    await gateway.invoke(view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId,
      arguments: {
        includeArchived: false,
        ...(definition.legalEntityScope
          ? { [definition.legalEntityScope.operand.parameterId]: scope }
          : {}),
        list: {
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          cursor,
          pageSize: Math.min(definition.maximumResultCount, 20),
          search,
          matchMode: 'substring',
          sort: [],
          relationLabels: [],
          ...(relatedFilter ? { relatedFilter } : {}),
          ...(parentScope ? { parentScope } : {}),
        },
      },
    }),
  );
  // An executor that ignored the eligibility filter cannot echo it, so a
  // broader list is refused rather than offered as eligible choices.
  const applied = result.listCoverage.relatedFilter;
  if (
    relatedFilter &&
    (applied?.queryId !== relatedFilter.queryId ||
      applied.relationId !== relatedFilter.relationId ||
      !sameFilters(applied.fieldFilters, relatedFilter.fieldFilters))
  )
    throw new Error('Eligibility filter not applied');
  // Likewise a parent scope the executor did not echo was not applied.
  if (
    parentScope &&
    (result.listCoverage.parentScope?.relationId !== parentScope.relationId ||
      result.listCoverage.parentScope.recordId !== parentScope.recordId)
  )
    throw new Error('Parent scope not applied');
  return {
    records: result.records,
    hasMore: result.listCoverage.hasMore,
    nextCursor: result.listCoverage.nextCursor,
  };
}

/** A picker's declared eligibility: records another entity points at. */
export interface ReferenceEligibility {
  readonly queryId: string;
  readonly relationId: string;
  readonly filters: readonly {
    readonly fieldId: string;
    readonly value: string;
  }[];
}

/**
 * Whether one record is eligible now: at least one active related record of
 * the declared kind points at it. Read through the related entity's own List,
 * restricted to that record as parent, under current authority. A denied or
 * failed read throws, so withheld authority is never read as "eligible".
 */
export async function workspaceEligible(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  eligibility: ReferenceEligibility,
  recordId: string,
): Promise<boolean> {
  const definition = registeredSemanticQueryFromPinnedView(
    view,
    eligibility.queryId,
  );
  if (!definition || definition.queryType !== 'list')
    throw new Error('Declared eligibility list unavailable');
  const parentScope = { relationId: eligibility.relationId, recordId };
  const fieldFilters = eligibility.filters.map((filter) => ({
    fieldId: filter.fieldId,
    value: filter.value,
  }));
  const result = requireSharedListResult<SemanticRecordDto>(
    await gateway.invoke(view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: eligibility.queryId,
      arguments: {
        includeArchived: false,
        list: {
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          cursor: null,
          pageSize: 1,
          search: '',
          matchMode: 'substring',
          sort: [],
          relationLabels: [],
          parentScope,
          fieldFilters,
        },
      },
    }),
  );
  if (
    result.listCoverage.parentScope?.recordId !== recordId ||
    result.listCoverage.parentScope.relationId !== eligibility.relationId ||
    !sameFilters(result.listCoverage.fieldFilters, fieldFilters)
  )
    throw new Error('Eligibility check not applied');
  return result.records.length > 0;
}

/**
 * Whether one record is tied to a parent through a declared owned relation,
 * read now through the record entity's own List restricted to that parent.
 * The owned children of one parent are few; a set too large to read whole
 * within the bounded pages is refused rather than guessed.
 */
export async function workspaceWithin(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  queryId: string,
  parentScope: { readonly relationId: string; readonly recordId: string },
  recordId: string,
): Promise<boolean> {
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const result = await workspaceSearch(
      view,
      gateway,
      queryId,
      null,
      '',
      cursor,
      undefined,
      parentScope,
    );
    if (result.records.some((record) => record.recordId === recordId))
      return true;
    if (!result.hasMore || result.nextCursor === null) return false;
    cursor = result.nextCursor;
  }
  throw new Error('Parent scope too large to verify');
}

const sameFilters = (
  applied:
    readonly { readonly fieldId: string; readonly value: string }[] | undefined,
  requested: readonly { readonly fieldId: string; readonly value: string }[],
) =>
  applied?.length === requested.length &&
  requested.every(
    (filter, index) =>
      applied[index]?.fieldId === filter.fieldId &&
      applied[index]?.value === filter.value,
  );

/**
 * The exact authorized read of one selected record. `null` means the record is
 * genuinely absent; a denied or failed read throws, so a caller can never
 * mistake withheld authority for a missing record.
 */
export async function workspaceGet(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  getQueryId: string,
  scope: string | null,
  recordId: string,
): Promise<SemanticRecordDto | null> {
  const definition = registeredSemanticQueryFromPinnedView(view, getQueryId);
  if (!definition || definition.queryType !== 'get')
    throw new Error('Declared get unavailable');
  const result = await gateway.invoke(view, {
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    queryId: getQueryId,
    arguments: {
      recordId,
      includeArchived: false,
      ...(definition.legalEntityScope
        ? { [definition.legalEntityScope.operand.parameterId]: scope }
        : {}),
    },
  });
  if (result.outcome === 'not-found') return null;
  if (result.outcome !== 'exact' || result.records.length !== 1)
    throw new Error('Selected record unavailable');
  return result.records[0]!;
}
