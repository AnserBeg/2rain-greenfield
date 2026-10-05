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
/**
 * The company an entry settles on (`authorizedSingleOrPreference`) once the
 * offered companies are known. An explicit company must be exactly one of
 * them. Without one, a surface that may default takes the only offered
 * company, else the one this person chose last while it is still offered.
 */
export function entryCompanyChoice(input: {
  readonly offered: readonly string[];
  readonly explicit: readonly string[];
  readonly preference: string | undefined;
  readonly mayDefault: boolean;
}): { readonly selected: string | null; readonly invalid: boolean } {
  const { offered, explicit, preference } = input;
  if (explicit.length)
    return {
      selected: explicit.length === 1 ? explicit[0]! : null,
      invalid: explicit.length !== 1 || !offered.includes(explicit[0]!),
    };
  if (!input.mayDefault) return { selected: null, invalid: false };
  return {
    selected:
      offered.length === 1
        ? offered[0]!
        : (offered.find((recordId) => recordId === preference) ?? null),
    invalid: false,
  };
}

export type WorkspaceEntry = NonNullable<
  Awaited<ReturnType<typeof resolveWorkspaceEntry>>
>;

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
  if (!policy || !definition) return null;
  // A record every company shares (an item) has no company of its own: its
  // company-owned sections read the company its entry names, carried under
  // the authorization List's own operand, as that List carries it.
  const shared =
    surface.surfaceRole === 'record' && !definition.legalEntityScope;
  const scope = shared
    ? registeredSemanticQueryFromPinnedView(view, policy.authorizationQueryId)
        ?.legalEntityScope
    : definition.legalEntityScope;
  if (!scope) return null;
  const parameter = scope.operand.parameterId;
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
  const choice = entryCompanyChoice({
    offered: options.map((option) => option.recordId),
    explicit,
    preference: preferences.get(key),
    // Only workspace entry can default; existing documents and tasks require
    // pinned URLs. A record every company shares may: it is the same record
    // in each company, so the choice decides only whose sections it shows.
    mayDefault:
      shared ||
      (surface.surfaceRole === 'list' && !url.searchParams.has('record')),
  });
  if (explicit.length) {
    // Explicit context is validated against current active authorized membership.
    if (!choice.invalid) preferences.set(key, explicit[0]!);
    return {
      options,
      parameter,
      shared,
      selected: choice.selected,
      redirect: null,
      invalid: choice.invalid,
    };
  }
  if (choice.selected) url.searchParams.set(parameter, choice.selected);
  return {
    options,
    parameter,
    shared,
    selected: choice.selected,
    redirect: choice.selected ? url.pathname + url.search : null,
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
  /** Children whose text also answers the search -- an item's aliases. */
  searchChildren?: readonly ReferenceSearchChild[],
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
          // Echoed or refused by the gateway: a picker never searches
          // without the children it declares (CATALOG-EXTRAS).
          ...(searchChildren?.length
            ? {
                searchChildren: searchChildren.map((child) => ({
                  fieldId: child.fieldId,
                  queryId: child.queryId,
                  relationId: child.relationId,
                })),
              }
            : {}),
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

/** A child entity whose text field also answers a picker's search. */
export interface ReferenceSearchChild {
  readonly fieldId: string;
  readonly queryId: string;
  readonly relationId: string;
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
