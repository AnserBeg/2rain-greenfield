import type { StorageTargetPayloadV1 } from './storage.js';

/**
 * Conservative closure for the generated create effect. Tier B can depend on
 * any first-party storage, including through declared relations and owned rows.
 * Keep the entire first-party side in the set while some packs lack field-level
 * dependency contracts. Capability writers also seed the closure explicitly.
 */
export function workflowTierBDependencies(
  storage: {
    readonly entities: readonly Pick<
      StorageTargetPayloadV1['entities'][number],
      | 'entityId'
      | 'factStorage'
      | 'periodLock'
      | 'legalEntityMaster'
      | 'consumerWriterRoots'
    >[];
    readonly relations: readonly Pick<
      StorageTargetPayloadV1['relations'][number],
      'sourceEntityId' | 'targetEntityId' | 'ownership'
    >[];
  },
  capabilityOperationIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const dependencies = new Set<string>();
  const queue: string[] = [];
  const edges = new Map<string, string[]>();
  function include(id: string): void {
    if (dependencies.has(id)) return;
    dependencies.add(id);
    queue.push(id);
  }
  for (const entity of storage.entities) {
    edges.set(entity.entityId, []);
    if (
      !/^[^:]+:entity\.custom_/.test(entity.entityId) ||
      entity.factStorage ||
      entity.periodLock ||
      entity.legalEntityMaster ||
      entity.consumerWriterRoots.writerOperationIds.some((id) =>
        capabilityOperationIds.has(id),
      )
    )
      include(entity.entityId);
  }
  for (const relation of storage.relations) {
    edges.get(relation.sourceEntityId)!.push(relation.targetEntityId);
    if (relation.ownership === 'parentScopedChild')
      edges.get(relation.targetEntityId)!.push(relation.sourceEntityId);
  }
  for (const id of queue) {
    for (const dependency of edges.get(id)!) include(dependency);
  }
  return dependencies;
}
