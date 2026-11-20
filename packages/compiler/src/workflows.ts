import type { WorkflowDefinition } from '../../canonical-model/src/schemas.js';
import { hashCanonical } from './hash.js';

type CatalogEntry = Record<string, unknown>;

export class WorkflowGrantBindingError extends Error {
  constructor(readonly grantId: string | null) {
    super(
      grantId
        ? `Workflow grant does not resolve: ${grantId}`
        : 'Workflow SDK catalog missing',
    );
  }
}

function selectGrants(
  payload: unknown,
  collection: 'operations' | 'queries',
  ids: readonly string[],
) {
  const values = (payload as Record<string, unknown> | null)?.[collection];
  if (!Array.isArray(values)) throw new WorkflowGrantBindingError(null);
  const idKey = collection === 'operations' ? 'operationId' : 'queryId';
  return ids.map((id) => {
    const entry = (values as CatalogEntry[]).find(
      (candidate) =>
        candidate[idKey] === id && candidate.lifecycle === 'active',
    );
    if (
      !entry ||
      (collection === 'operations' &&
        (entry.tier !== 'o0' || !entry.inputContract)) ||
      (collection === 'queries' && entry.readModel)
    )
      throw new WorkflowGrantBindingError(id);
    return entry;
  });
}

export function workflowSdkBindingDigest(
  grants: WorkflowDefinition['grants'],
  operations: unknown,
  queries: unknown,
): string {
  return hashCanonical('northstar.workflow-sdk-binding/v1', {
    operations: selectGrants(operations, 'operations', grants.operations),
    queries: selectGrants(queries, 'queries', grants.queries),
  }).digest;
}
