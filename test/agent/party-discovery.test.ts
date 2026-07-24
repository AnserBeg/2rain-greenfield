import assert from 'node:assert/strict';
import test from 'node:test';

import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import { PARTY_IDS } from '../fixtures/g2/party/definition.js';
import {
  compilePartyFixture,
  projectionPayload,
} from '../fixtures/g2/party/compiler.js';

test('Party agent discovery is compiler data over the same Q0/O0 DTO contracts', () => {
  const { compiled } = compilePartyFixture();
  const agent = projectionPayload<{
    kind: string;
    operations: Array<{ operationId: string; readBackQueryId: string }>;
    queries: Array<{ fieldIds: string[]; queryId: string }>;
    surfaces: string[];
    toolIds: string[];
  }>(compiled, PROJECTION_FAMILY_IDS.agentDiscovery);
  assert.equal(agent.kind, 'agentDiscoveryPayload');
  assert.deepEqual(
    agent.queries
      .filter((query) => query.queryId.includes(':query.party_'))
      .map((query) => query.queryId),
    [
      'party_get',
      'party_list',
      'party_resolve',
      'party_role_get',
      'party_role_list',
      'party_role_resolve',
      'party_role_search',
      'party_search',
    ].map((local) => `${PARTY_IDS.namespace}:query.${local}`),
  );
  assert.equal(agent.operations.length, 8);
  assert.equal(agent.surfaces.length, 6);
  assert.equal(
    agent.operations.every((operation) =>
      operation.readBackQueryId.endsWith('_get'),
    ),
    true,
  );
  assert.equal(
    agent.operations.some((operation) =>
      /delete|purge|destroy/i.test(operation.operationId),
    ),
    false,
  );
  assert.equal(agent.toolIds.length > 0, true);
});
