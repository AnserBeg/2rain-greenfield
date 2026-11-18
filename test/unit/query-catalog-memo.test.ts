import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogParseCount } from '../../packages/runtime/src/catalog-parse-count.js';
import { AuthenticatedRequestEntryAdapter } from '../../packages/runtime/src/request-context.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import { registeredSemanticQueryFromPinnedView } from '../../packages/runtime/src/semantic-query-gateway.js';

// SPEED-1 slice 4: a release's query catalog is parsed once across requests,
// found by its exact content; a refused catalog is never published.

const tenantId = 'c1000000-0000-4000-8000-000000000001';
const environmentId = 'c2000000-0000-4000-8000-000000000002';
const principalId = 'c3000000-0000-4000-8000-000000000003';
const queryParses = () => catalogParseCount().queryCatalog;

test('SPEED-1 query catalog memo: one parse per catalog content across request views; a refused catalog refuses every time', async () => {
  // Content no other test in this process parses: a unique schema-valid id.
  const catalog = (extra: Record<string, ImmutableJsonValue> = {}) => ({
    kind: 'queryCatalogPayload',
    queries: [],
    schemaVersion: 'northstar.query-catalog-payload/v0-provisional',
    ...extra,
  });
  const first = queryParses();
  const one = await view(catalog());
  assert.equal(
    registeredSemanticQueryFromPinnedView(one, 'x:query.a'),
    undefined,
  );
  assert.equal(queryParses(), first + 1);
  // Another request's view of the same release: no parse.
  const two = await view(catalog());
  registeredSemanticQueryFromPinnedView(two, 'x:query.a');
  registeredSemanticQueryFromPinnedView(two, 'x:query.b');
  assert.equal(queryParses(), first + 1);

  // A refused catalog is never published: it refuses on every request.
  const refusedOne = await view(catalog({ queries: [{ queryId: 1 }] }));
  const refusedTwo = await view(catalog({ queries: [{ queryId: 1 }] }));
  assert.throws(() =>
    registeredSemanticQueryFromPinnedView(refusedOne, 'x:query.a'),
  );
  assert.throws(() =>
    registeredSemanticQueryFromPinnedView(refusedTwo, 'x:query.a'),
  );
  assert.equal(queryParses(), first + 3);
});

async function view(queryPayload: ImmutableJsonValue) {
  const identity = Object.freeze({ environmentId, principalId, tenantId });
  const empty = Object.freeze([]) as readonly ImmutableJsonValue[];
  const projection = (
    familyId: string,
    payloadSchemaVersion: string,
    payload: ImmutableJsonValue,
  ) => ({
    artifactRoot: 'c'.repeat(64),
    familyId,
    instanceId: `northstar.test:projection.${familyId.split('.').at(-1)}`,
    payload,
    payloadSchemaVersion,
    semanticDigest: 'd'.repeat(64),
  });
  const family = REQUEST_RUNTIME_PROJECTION_FAMILIES;
  const definition = {
    environmentId,
    pointer: { fence: 1, pointerId: 'c7000000-0000-4000-8000-000000000007' },
    projections: {
      agent: projection(
        family.agent,
        'northstar.agent-discovery-payload/v0-provisional',
        {
          kind: 'agentDiscoveryPayload',
          operations: empty,
          queries: empty,
          schemaVersion: 'northstar.agent-discovery-payload/v0-provisional',
          surfaces: empty,
          toolIds: empty,
        },
      ),
      catalog: projection(
        family.catalog,
        'northstar.semantic-model-payload/v0-provisional',
        {
          constructs: empty,
          kind: 'semanticModelPayload',
          schemaVersion: 'northstar.semantic-model-payload/v0-provisional',
        },
      ),
      operation: projection(
        family.operation,
        'northstar.operation-catalog-payload/v0-provisional',
        {
          kind: 'operationCatalogPayload',
          operations: empty,
          schemaVersion: 'northstar.operation-catalog-payload/v0-provisional',
        },
      ),
      query: projection(
        family.query,
        'northstar.query-catalog-payload/v0-provisional',
        queryPayload,
      ),
      surface: projection(
        family.surface,
        'northstar.surface-manifest-payload/v0-provisional',
        {
          kind: 'surfaceManifestPayload',
          schemaVersion: 'northstar.surface-manifest-payload/v0-provisional',
          surfaces: empty,
        },
      ),
    },
    release: {
      contentHash: 'b'.repeat(64),
      releaseId: 'c8000000-0000-4000-8000-000000000008',
    },
    tenantId,
  } as unknown as LoadedRequestRuntimeDefinition;
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => identity),
    { load: async () => definition },
    {
      authorize: async () => ({
        decision: 'DENY' as const,
        decisionVersion: CURRENT_POLICY_DECISION_VERSION,
        policyVersion: 'v',
      }),
      readCurrentVersion: async () => ({ policyVersion: 'v' }),
    },
  );
  let issued: RequestRuntimeView | undefined;
  await entry.run({}, (value) => {
    issued = value;
  });
  return issued!;
}
