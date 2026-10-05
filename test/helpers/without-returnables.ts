import assert from 'node:assert/strict';

import { returnablesDeclarations } from '../../packages/domain/src/party/returnables.js';

/**
 * The composed application without Party's returnables (RETURNABLE-ASSETS):
 * their declarations, the Returnables held clone of their List, their
 * capability, and the party page's company entry, section and Tasks that read
 * and start them. Custody records are company-owned, entered through
 * Inventory's legal entities, so a fixture that removes Inventory removes
 * them with it. Every removed entry must be present exactly once.
 */
export function withoutReturnables(
  composed: Record<string, unknown>,
  namespace = 'northstar.app',
): Record<string, unknown> {
  const declarations = returnablesDeclarations(
    namespace,
    `${namespace}:module.party`,
    `${namespace}:capability.standard_surface_content`,
  );
  const idKeys = {
    assertions: 'assertionId',
    entities: 'entityId',
    fields: 'fieldId',
    operations: 'operationId',
    permissions: 'permissionId',
    queries: 'queryId',
    relations: 'relationId',
    storageMappings: 'storageMappingId',
    surfaces: 'surfaceId',
    capabilityRequirements: 'capabilityId',
  } as const;
  const held = 'returnables_held_list';
  for (const [collectionName, idKey] of Object.entries(idKeys)) {
    const target = composed[collectionName];
    assert.ok(Array.isArray(target));
    const ids = new Set<unknown>(
      (declarations[collectionName] ?? []).map((entry) => entry[idKey]),
    );
    if (collectionName === 'surfaces') ids.add(`${namespace}:surface.${held}`);
    if (collectionName === 'queries') ids.add(`${namespace}:query.${held}`);
    for (const id of ids)
      assert.equal(
        (target as Record<string, unknown>[]).filter(
          (candidate) => candidate[idKey] === id,
        ).length,
        1,
        `fixture must identify each returnables ${collectionName} entry exactly once`,
      );
    composed[collectionName] = (target as Record<string, unknown>[]).filter(
      (candidate) => !ids.has(candidate[idKey]),
    );
  }
  const party = (composed.surfaces as Record<string, unknown>[]).find(
    (surface) => surface.surfaceId === `${namespace}:surface.party_detail`,
  ) as
    | {
        workspace: Record<string, unknown>;
        composition: { children: unknown[]; actions: unknown[] };
      }
    | undefined;
  assert.ok(party?.workspace.entry, 'the party page enters a company');
  delete party.workspace.entry;
  const mentionsReturnables = (value: unknown) =>
    /:(?:query|operation|surface)\.returnable_/u.test(JSON.stringify(value));
  party.composition.children = party.composition.children.filter(
    (child) => !mentionsReturnables(child),
  );
  party.composition.actions = party.composition.actions.filter(
    (action) => !mentionsReturnables(action),
  );
  return composed;
}
