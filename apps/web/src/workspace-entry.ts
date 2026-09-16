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
