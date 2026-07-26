import assert from 'node:assert/strict';
import test from 'node:test';

import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import { LOCATION_IDS } from '../../packages/domain/src/location/index.js';
import {
  compileLocationFixture,
  projectionPayload,
} from '../fixtures/g2/location/compiler.js';

test('Location agent discovery is compiler data over the same Q0/O0 location DTO', () => {
  const { compiled } = compileLocationFixture();
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
    [
      'location_get',
      'location_list',
      'location_resolve',
      'location_search',
    ].map((local) => `${LOCATION_IDS.namespace}:query.${local}`),
  );
  assert.equal(agent.operations.length, 4);
  assert.equal(agent.surfaces.length, 3);
  assert.equal(
    agent.operations.every(
      (operation) =>
        operation.readBackQueryId ===
        `${LOCATION_IDS.namespace}:query.location_get`,
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
