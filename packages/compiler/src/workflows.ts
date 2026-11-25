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

export class WorkflowTriggerBindingError extends Error {
  constructor(readonly recordTypeId: string) {
    super(`Workflow trigger record type does not resolve: ${recordTypeId}`);
  }
}

/**
 * ADR-0073 A1 admission for general members: the record type is a stored
 * entity of the release with exactly one owning company per record, because a
 * run needs a company scope, and the release creates it through an active
 * create operation, whose governed writer records each creation. A type that
 * only a writer without that guarantee creates (a projection, a ledger row, a
 * provisioned lock) fails closed. Returns whether any general member is
 * declared.
 */
export function workflowTriggerRecordTypes(
  storagePayload: unknown,
  operationsPayload: unknown,
): ReadonlySet<string> {
  const entities = (storagePayload as { entities?: unknown } | null)?.entities;
  const operations = (operationsPayload as { operations?: unknown } | null)
    ?.operations;
  const created = new Set(
    (Array.isArray(operations) ? (operations as CatalogEntry[]) : [])
      .filter(
        (operation) =>
          operation.lifecycle === 'active' &&
          (operation.effect as { kind?: unknown } | undefined)?.kind ===
            'createRecordEffect',
      )
      .map(
        (operation) =>
          (operation.effect as { entity?: { targetId?: unknown } }).entity
            ?.targetId,
      ),
  );
  return new Set(
    (Array.isArray(entities) ? (entities as CatalogEntry[]) : [])
      .filter(
        (entity) =>
          entity.lifecycle === 'active' &&
          entity.storageClass === 'dedicatedTable' &&
          (entity.legalEntity as { nullable?: unknown } | undefined)
            ?.nullable === false &&
          created.has(entity.entityId),
      )
      .map((entity) => String(entity.entityId)),
  );
}

export function assertWorkflowTriggers(
  workflows: readonly WorkflowDefinition[],
  storagePayload: unknown,
  operationsPayload: unknown,
): boolean {
  const admitted = workflowTriggerRecordTypes(storagePayload, operationsPayload);
  let general = false;
  for (const { trigger } of workflows) {
    if (typeof trigger === 'string') continue;
    general = true;
    if (!admitted.has(trigger.recordTypeId))
      throw new WorkflowTriggerBindingError(trigger.recordTypeId);
  }
  return general;
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
