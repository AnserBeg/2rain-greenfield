import assert from 'node:assert/strict';
import test from 'node:test';

import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import { CATALOG_IDS } from '../../packages/domain/src/catalog/index.js';
import {
  compileCatalogFixture,
  projectionPayload,
} from '../fixtures/g2/catalog/compiler.js';

test('Catalog agent discovery is compiler data over the same Q0/O0 item DTO', () => {
  const { compiled } = compileCatalogFixture();
  const agent = projectionPayload<{
    kind: string;
    operations: Array<{ operationId: string; readBackQueryId: string }>;
    queries: Array<{ fieldIds: string[]; queryId: string }>;
    surfaces: string[];
    toolIds: string[];
  }>(compiled, PROJECTION_FAMILY_IDS.agentDiscovery);
  assert.equal(agent.kind, 'agentDiscoveryPayload');
  assert.deepEqual(
    agent.queries.map((query) => query.queryId),
    ['item_get', 'item_list', 'item_resolve', 'item_search'].map(
      (local) => `${CATALOG_IDS.namespace}:query.${local}`,
    ),
  );
  assert.equal(agent.operations.length, 4);
  assert.equal(agent.surfaces.length, 3);
  assert.equal(
    agent.operations.every(
      (operation) =>
        operation.readBackQueryId === `${CATALOG_IDS.namespace}:query.item_get`,
    ),
    true,
  );
  assert.equal(
    agent.operations.some((operation) =>
      /delete|purge|destroy/i.test(operation.operationId),
    ),
    false,
  );
  assert.ok(agent.toolIds.length > 0, 'agent discovery emitted no tools');
});
