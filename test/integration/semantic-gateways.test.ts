import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  RequestRuntimeViewIntegrityError,
  type CurrentPolicyDecision,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type CurrentPolicyVersionEvidence,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeDefinitionLoader,
  type RequestRuntimeProjectionFamily,
  type RuntimeProjection,
} from '../../packages/runtime/src/request-runtime-view.js';
import {
  AuthenticatedSemanticOperationApiAdapter,
  AuthenticatedSemanticQueryApiAdapter,
} from '../../packages/runtime/src/semantic-gateway-api-adapters.js';
import {
  MalformedPinnedOperationCatalogError,
  MalformedSemanticOperationRequestError,
  NoSuchRegisteredOperationError,
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
  SemanticOperationPolicyDeniedError,
  type SemanticOperationRequestEnvelope,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  MalformedPinnedQueryCatalogError,
  MalformedSemanticQueryRequestError,
  NoSuchRegisteredQueryError,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryGateway,
  SemanticQueryPolicyDeniedError,
  type SemanticQueryRequestEnvelope,
} from '../../packages/runtime/src/semantic-query-gateway.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const environmentId = 'a1000000-0000-4000-8000-000000000001';
const principalId = 'aa000000-0000-4000-8000-000000000001';
const pointerId = 'a2000000-0000-4000-8000-000000000001';
const releaseId = 'a3000000-0000-4000-8000-000000000001';
const releaseContentHash = 'a'.repeat(64);
const queryId = 'northstar.bootstrap:query.missing';
const operationId = 'northstar.bootstrap:operation.missing';
const authenticationInput = Object.freeze({
  headers: Object.freeze({ authorization: 'Bearer semantic-gateway-fixture' }),
});
const identity: AuthenticatedIdentity = Object.freeze({
  environmentId,
  principalId,
  tenantId,
});

const queryRequest: SemanticQueryRequestEnvelope = Object.freeze({
  arguments: Object.freeze({ includeArchived: false, limit: 5 }),
  queryId,
  schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
});
const operationRequest: SemanticOperationRequestEnvelope = Object.freeze({
  confirmationGrant: null,
  idempotencyKey: 'ab000000-0000-4000-8000-000000000001',
  input: Object.freeze({ note: 'fixture input' }),
  operationId,
  schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
});

test('query API uses one issued pinned view, consults current policy, and returns exact typed absence', async () => {
  const fixture = createFixture();

  await assert.rejects(
    fixture.queryApi.handle(authenticationInput, queryRequest),
    (error: unknown) => {
      assert.ok(error instanceof NoSuchRegisteredQueryError);
      assert.equal(error.code, 'NO_SUCH_REGISTERED_QUERY');
      assert.equal(error.queryId, queryId);
      assert.equal(error.pinnedReleaseId, releaseId);
      assert.equal(error.pinnedReleaseContentHash, releaseContentHash);
      assertNoUnpinnedEvidence(error);
      return true;
    },
  );

  assert.equal(fixture.loader.contexts.length, 1);
  assert.equal(fixture.policy.authorizationCalls.length, 1);
  const issuedContext = fixture.loader.contexts[0]!;
  assert.deepEqual(fixture.policy.authorizationCalls[0], {
    decisionInput: {
      arguments: { includeArchived: false, limit: 5 },
      kind: 'semanticQueryPolicyInput',
      queryId,
      requestId: issuedContext.requestId,
      schemaVersion: 'northstar.semantic-query-policy-input/v1',
    },
    entryPolicyVersion: 'fixture-policy/entry-1',
    environmentId,
    permissionId: 'northstar.runtime:permission.semantic-query-boundary',
    pinnedReleaseContentHash: releaseContentHash,
    pinnedReleaseId: releaseId,
    pointerFence: 7,
    pointerId,
    principalId,
    tenantId,
  });
  assert.equal(Object.isFrozen(fixture.policy.authorizationCalls[0]), true);
  assert.equal(
    Object.isFrozen(fixture.policy.authorizationCalls[0]!.decisionInput),
    true,
  );
  assert.equal(
    Object.isFrozen(
      fixture.policy.authorizationCalls[0]!.decisionInput.arguments,
    ),
    true,
  );
});

test('operation API uses one issued pinned view, consults current policy, and returns exact typed absence', async () => {
  const fixture = createFixture();

  await assert.rejects(
    fixture.operationApi.handle(authenticationInput, operationRequest),
    (error: unknown) => {
      assert.ok(error instanceof NoSuchRegisteredOperationError);
      assert.equal(error.code, 'NO_SUCH_REGISTERED_OPERATION');
      assert.equal(error.operationId, operationId);
      assert.equal(error.pinnedReleaseId, releaseId);
      assert.equal(error.pinnedReleaseContentHash, releaseContentHash);
      assertNoUnpinnedEvidence(error);
      return true;
    },
  );

  assert.equal(fixture.loader.contexts.length, 1);
  assert.equal(fixture.policy.authorizationCalls.length, 1);
  const issuedContext = fixture.loader.contexts[0]!;
  assert.deepEqual(fixture.policy.authorizationCalls[0], {
    decisionInput: {
      input: { note: 'fixture input' },
      kind: 'semanticOperationPolicyInput',
      operationId,
      requestId: issuedContext.requestId,
      schemaVersion: 'northstar.semantic-operation-policy-input/v1',
    },
    entryPolicyVersion: 'fixture-policy/entry-1',
    environmentId,
    permissionId: 'northstar.runtime:permission.semantic-operation-boundary',
    pinnedReleaseContentHash: releaseContentHash,
    pinnedReleaseId: releaseId,
    pointerFence: 7,
    pointerId,
    principalId,
    tenantId,
  });
  assert.equal(Object.isFrozen(fixture.policy.authorizationCalls[0]), true);
  assert.equal(
    Object.isFrozen(fixture.policy.authorizationCalls[0]!.decisionInput),
    true,
  );
  assert.equal(
    Object.isFrozen(fixture.policy.authorizationCalls[0]!.decisionInput.input),
    true,
  );
});

test('closed API envelopes reject catalog and physical bypass fields while ambient data is inert', async () => {
  const queryFixture = createFixture();
  await assert.rejects(
    queryFixture.queryApi.handle(authenticationInput, {
      ...queryRequest,
      catalog: emptyQueryCatalog(),
    }),
    MalformedSemanticQueryRequestError,
  );
  assert.equal(queryFixture.policy.authorizationCalls.length, 0);

  const operationFixture = createFixture();
  await assert.rejects(
    operationFixture.operationApi.handle(authenticationInput, {
      ...operationRequest,
      physicalHandler: 'plain-accidental-bypass',
    }),
    MalformedSemanticOperationRequestError,
  );
  assert.equal(operationFixture.policy.authorizationCalls.length, 0);

  const ambientKey = '__northstarG1P6QueryCatalog';
  Reflect.set(globalThis, ambientKey, {
    queries: [{ queryId }],
  });
  try {
    const ambientFixture = createFixture();
    await assert.rejects(
      ambientFixture.queryApi.handle(authenticationInput, queryRequest),
      NoSuchRegisteredQueryError,
    );
    assert.equal(ambientFixture.policy.authorizationCalls.length, 1);
  } finally {
    Reflect.deleteProperty(globalThis, ambientKey);
  }
});

test('a separately issued synthetic catalog cannot replace the view being handled', async () => {
  const emptyFixture = createFixture();
  const emptyView = await emptyFixture.requestEntry.run(
    authenticationInput,
    (view) => view,
  );
  const syntheticFixture = createFixture({
    operationPayload: operationCatalogWith(operationId),
    queryPayload: queryCatalogWith(queryId),
    releaseId: 'b3000000-0000-4000-8000-000000000001',
  });
  const syntheticView = await syntheticFixture.requestEntry.run(
    authenticationInput,
    (view) => view,
  );
  assert.notEqual(syntheticView.release.releaseId, emptyView.release.releaseId);
  assert.notDeepEqual(
    syntheticView.projections.query.payload,
    emptyView.projections.query.payload,
  );
  assert.notDeepEqual(
    syntheticView.projections.operation.payload,
    emptyView.projections.operation.payload,
  );

  const queryGateway = new SemanticQueryGateway(emptyFixture.policy);
  await assert.rejects(
    queryGateway.invoke(emptyView, queryRequest),
    (error: unknown) => {
      assert.ok(error instanceof NoSuchRegisteredQueryError);
      assert.equal(error.pinnedReleaseId, releaseId);
      return true;
    },
  );
  const operationGateway = new SemanticOperationGateway(
    emptyFixture.policy,
    undefined,
    emptyFixture.operationMediation,
  );
  await assert.rejects(
    operationGateway.invoke(
      emptyView,
      operationRequest,
      emptyFixture.operationMediation.issueInvocation(emptyView, 'API'),
    ),
    (error: unknown) => {
      assert.ok(error instanceof NoSuchRegisteredOperationError);
      assert.equal(error.pinnedReleaseId, releaseId);
      return true;
    },
  );
  assert.equal(emptyFixture.policy.authorizationCalls.length, 2);
  assert.equal(syntheticFixture.policy.authorizationCalls.length, 0);
});

test('current policy denial and malformed decisions fail closed for both gateways', async (t) => {
  await t.test('query DENY', async () => {
    const fixture = createFixture({ policyOutcome: 'DENY' });
    await assert.rejects(
      fixture.queryApi.handle(authenticationInput, queryRequest),
      (error: unknown) => {
        assert.ok(error instanceof SemanticQueryPolicyDeniedError);
        assert.equal(error.code, 'SEMANTIC_QUERY_POLICY_DENIED');
        assert.equal(error.queryId, queryId);
        return true;
      },
    );
    assert.equal(fixture.policy.authorizationCalls.length, 1);
  });

  await t.test('operation DENY', async () => {
    const fixture = createFixture({ policyOutcome: 'DENY' });
    await assert.rejects(
      fixture.operationApi.handle(authenticationInput, operationRequest),
      (error: unknown) => {
        assert.ok(error instanceof SemanticOperationPolicyDeniedError);
        assert.equal(error.code, 'SEMANTIC_OPERATION_POLICY_DENIED');
        assert.equal(error.operationId, operationId);
        return true;
      },
    );
    assert.equal(fixture.policy.authorizationCalls.length, 1);
  });

  await t.test('query malformed decision', async () => {
    const fixture = createFixture({ policyOutcome: 'MALFORMED' });
    await assert.rejects(
      fixture.queryApi.handle(authenticationInput, queryRequest),
      RequestRuntimeViewIntegrityError,
    );
    assert.equal(fixture.policy.authorizationCalls.length, 1);
  });

  await t.test('operation malformed decision', async () => {
    const fixture = createFixture({ policyOutcome: 'MALFORMED' });
    await assert.rejects(
      fixture.operationApi.handle(authenticationInput, operationRequest),
      RequestRuntimeViewIntegrityError,
    );
    assert.equal(fixture.policy.authorizationCalls.length, 1);
  });
});

test('wrong catalog kind, schema, and shape fail closed after a live policy call', async (t) => {
  const malformedQueryPayloads: readonly ImmutableJsonValue[] = [
    {
      ...emptyQueryCatalog(),
      kind: 'notAQueryCatalogPayload',
    },
    {
      ...emptyQueryCatalog(),
      schemaVersion: 'northstar.query-catalog-payload/unsupported',
    },
    {
      kind: 'queryCatalogPayload',
      queries: {},
      schemaVersion: 'northstar.query-catalog-payload/v0-provisional',
    },
  ];
  for (const [index, payload] of malformedQueryPayloads.entries()) {
    await t.test(`query malformed catalog ${index + 1}`, async () => {
      const fixture = createFixture({ queryPayload: payload });
      await assert.rejects(
        fixture.queryApi.handle(authenticationInput, queryRequest),
        MalformedPinnedQueryCatalogError,
      );
      assert.equal(fixture.policy.authorizationCalls.length, 1);
    });
  }

  const malformedOperationPayloads: readonly ImmutableJsonValue[] = [
    {
      ...emptyOperationCatalog(),
      kind: 'notAnOperationCatalogPayload',
    },
    {
      ...emptyOperationCatalog(),
      schemaVersion: 'northstar.operation-catalog-payload/unsupported',
    },
    {
      kind: 'operationCatalogPayload',
      operations: {},
      schemaVersion: 'northstar.operation-catalog-payload/v0-provisional',
    },
  ];
  for (const [index, payload] of malformedOperationPayloads.entries()) {
    await t.test(`operation malformed catalog ${index + 1}`, async () => {
      const fixture = createFixture({ operationPayload: payload });
      await assert.rejects(
        fixture.operationApi.handle(authenticationInput, operationRequest),
        MalformedPinnedOperationCatalogError,
      );
      assert.equal(fixture.policy.authorizationCalls.length, 1);
    });
  }
});

test('unissued views fail before catalog access at each direct gateway boundary', async () => {
  let queryCatalogAccesses = 0;
  const forgedQueryView = Object.create(null);
  Object.defineProperty(forgedQueryView, 'projections', {
    get: () => {
      queryCatalogAccesses += 1;
      return Object.create(null);
    },
  });
  const queryGateway = new SemanticQueryGateway(
    new RecordingPolicyGateway('ALLOW'),
  );
  await assert.rejects(
    Reflect.apply(queryGateway.invoke, queryGateway, [
      forgedQueryView,
      queryRequest,
    ]),
    TypeError,
  );
  assert.equal(queryCatalogAccesses, 0);

  let operationCatalogAccesses = 0;
  const forgedOperationView = Object.create(null);
  Object.defineProperty(forgedOperationView, 'projections', {
    get: () => {
      operationCatalogAccesses += 1;
      return Object.create(null);
    },
  });
  const operationGateway = new SemanticOperationGateway(
    new RecordingPolicyGateway('ALLOW'),
  );
  await assert.rejects(
    Reflect.apply(operationGateway.invoke, operationGateway, [
      forgedOperationView,
      operationRequest,
      { channel: 'API' },
    ]),
    TypeError,
  );
  assert.equal(operationCatalogAccesses, 0);
});

test('owned gateway sources expose one authority each, closed request keys, and no prohibited capability seam', () => {
  const querySource = readFileSync(
    'packages/runtime/src/semantic-query-gateway.ts',
    'utf8',
  );
  const operationSource = readFileSync(
    'packages/runtime/src/semantic-operation-gateway.ts',
    'utf8',
  );
  const adapterSource = readFileSync(
    'packages/runtime/src/semantic-gateway-api-adapters.ts',
    'utf8',
  );
  const ownedSources = [querySource, operationSource, adapterSource].join('\n');

  assert.equal(
    [...ownedSources.matchAll(/class SemanticQueryGateway\b/g)].length,
    1,
  );
  assert.equal(
    [...ownedSources.matchAll(/class SemanticOperationGateway\b/g)].length,
    1,
  );
  assert.deepEqual(
    publicReadonlyKeys(querySource, 'SemanticQueryRequestEnvelope'),
    ['arguments', 'queryId', 'schemaVersion'],
  );
  assert.deepEqual(
    publicReadonlyKeys(operationSource, 'SemanticOperationRequestEnvelope'),
    [
      'confirmationGrant',
      'idempotencyKey',
      'input',
      'operationId',
      'schemaVersion',
    ],
  );
  assert.equal(SemanticQueryGateway.length, 1);
  assert.equal(SemanticOperationGateway.length, 1);
  assert.equal(AuthenticatedSemanticQueryApiAdapter.length, 2);
  assert.equal(AuthenticatedSemanticOperationApiAdapter.length, 3);
  assert.doesNotMatch(
    ownedSources,
    /\b(?:db|database|sql|table|storage|source|filesystem|shell|http|compiler|handler|route|transaction|patch|purge|activation|dispatcher|dispatch)\b/i,
  );
  assert.doesNotMatch(
    ownedSources,
    /\b(?:globalThis|AsyncLocalStorage|defaultTenant|defaultRelease|process)\b/,
  );
  assert.deepEqual([...ownedSources.matchAll(/\berp_[a-z0-9_]+\b/g)], []);
});

type PolicyOutcome = 'ALLOW' | 'DENY' | 'MALFORMED';

interface FixtureOptions {
  readonly operationPayload?: ImmutableJsonValue;
  readonly policyOutcome?: PolicyOutcome;
  readonly queryPayload?: ImmutableJsonValue;
  readonly releaseId?: string;
}

class FixtureDefinitionLoader implements RequestRuntimeDefinitionLoader {
  readonly contexts: TrustedRequestContext[] = [];

  constructor(private readonly options: FixtureOptions) {}

  async load(
    context: TrustedRequestContext,
  ): Promise<LoadedRequestRuntimeDefinition> {
    this.contexts.push(context);
    return loadedDefinition(context, this.options);
  }
}

class RecordingPolicyGateway implements CurrentPolicyGateway {
  readonly authorizationCalls: CurrentPolicyDecisionRequest[] = [];
  readonly versionCalls: CurrentPolicySubject[] = [];

  constructor(private readonly outcome: PolicyOutcome) {}

  async readCurrentVersion(
    subject: CurrentPolicySubject,
  ): Promise<CurrentPolicyVersionEvidence> {
    this.versionCalls.push(subject);
    return Object.freeze({ policyVersion: 'fixture-policy/entry-1' });
  }

  async authorize(
    request: CurrentPolicyDecisionRequest,
  ): Promise<CurrentPolicyDecision> {
    this.authorizationCalls.push(request);
    if (this.outcome === 'MALFORMED') {
      return JSON.parse(
        '{"decision":"ALLOW","decisionVersion":"unsupported","policyVersion":"fixture-policy/decision-1"}',
      );
    }
    return Object.freeze({
      decision: this.outcome,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'fixture-policy/decision-1',
    });
  }
}

function createFixture(options: FixtureOptions = {}): {
  loader: FixtureDefinitionLoader;
  operationApi: AuthenticatedSemanticOperationApiAdapter;
  operationMediation: SemanticOperationMediationAuthority;
  policy: RecordingPolicyGateway;
  queryApi: AuthenticatedSemanticQueryApiAdapter;
  requestEntry: AuthenticatedRequestRuntimeEntryAdapter;
} {
  const loader = new FixtureDefinitionLoader(options);
  const policy = new RecordingPolicyGateway(options.policyOutcome ?? 'ALLOW');
  const authenticatedEntry = new AuthenticatedRequestEntryAdapter(
    async (request) =>
      request.headers?.authorization ===
      authenticationInput.headers.authorization
        ? identity
        : null,
  );
  const requestEntry = new AuthenticatedRequestRuntimeEntryAdapter(
    authenticatedEntry,
    loader,
    policy,
  );
  const operationMediation = new SemanticOperationMediationAuthority();
  return {
    loader,
    operationApi: new AuthenticatedSemanticOperationApiAdapter(
      requestEntry,
      new SemanticOperationGateway(policy, undefined, operationMediation),
      operationMediation,
    ),
    operationMediation,
    policy,
    queryApi: new AuthenticatedSemanticQueryApiAdapter(
      requestEntry,
      new SemanticQueryGateway(policy),
    ),
    requestEntry,
  };
}

function loadedDefinition(
  context: TrustedRequestContext,
  options: FixtureOptions,
): LoadedRequestRuntimeDefinition {
  return {
    environmentId: context.environmentId,
    pointer: { fence: 7, pointerId },
    projections: {
      agent: projection(
        REQUEST_RUNTIME_PROJECTION_FAMILIES.agent,
        'northstar.agent-discovery-payload/v0-provisional',
        {
          kind: 'agentDiscoveryPayload',
          operations: [],
          queries: [],
          schemaVersion: 'northstar.agent-discovery-payload/v0-provisional',
          surfaces: [],
          toolIds: [
            'erp_discover',
            'erp_query',
            'erp_plan',
            'erp_execute',
            'erp_verify',
          ],
        },
      ),
      catalog: projection(
        REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog,
        'northstar.semantic-model-payload/v0-provisional',
        {
          constructs: [],
          kind: 'semanticModelPayload',
          schemaVersion: 'northstar.semantic-model-payload/v0-provisional',
        },
      ),
      operation: projection(
        REQUEST_RUNTIME_PROJECTION_FAMILIES.operation,
        'northstar.operation-catalog-payload/v0-provisional',
        options.operationPayload ?? emptyOperationCatalog(),
      ),
      query: projection(
        REQUEST_RUNTIME_PROJECTION_FAMILIES.query,
        'northstar.query-catalog-payload/v0-provisional',
        options.queryPayload ?? emptyQueryCatalog(),
      ),
      surface: projection(
        REQUEST_RUNTIME_PROJECTION_FAMILIES.surface,
        'northstar.surface-manifest-payload/v0-provisional',
        {
          kind: 'surfaceManifestPayload',
          schemaVersion: 'northstar.surface-manifest-payload/v0-provisional',
          surfaces: [],
        },
      ),
    },
    release: {
      contentHash: releaseContentHash,
      releaseId: options.releaseId ?? releaseId,
    },
    tenantId: context.tenantId,
  };
}

function projection<TFamily extends RequestRuntimeProjectionFamily>(
  familyId: TFamily,
  payloadSchemaVersion: string,
  payload: ImmutableJsonValue,
): RuntimeProjection<TFamily> {
  return {
    artifactRoot: 'b'.repeat(64),
    familyId,
    instanceId: `northstar.bootstrap:projection.${familyId.split('.').at(-1)}`,
    payload,
    payloadSchemaVersion,
    semanticDigest: 'c'.repeat(64),
  };
}

function emptyQueryCatalog(): {
  readonly kind: 'queryCatalogPayload';
  readonly queries: readonly ImmutableJsonValue[];
  readonly schemaVersion: 'northstar.query-catalog-payload/v0-provisional';
} {
  return {
    kind: 'queryCatalogPayload',
    queries: [],
    schemaVersion: 'northstar.query-catalog-payload/v0-provisional',
  };
}

function emptyOperationCatalog(): {
  readonly kind: 'operationCatalogPayload';
  readonly operations: readonly ImmutableJsonValue[];
  readonly schemaVersion: 'northstar.operation-catalog-payload/v0-provisional';
} {
  return {
    kind: 'operationCatalogPayload',
    operations: [],
    schemaVersion: 'northstar.operation-catalog-payload/v0-provisional',
  };
}

function queryCatalogWith(registeredQueryId: string): ImmutableJsonValue {
  return {
    kind: 'queryCatalogPayload',
    queries: [
      {
        filter: {
          kind: 'booleanPredicate',
          schemaVersion: 'v0-experimental',
          value: true,
        },
        lifecycle: 'active',
        maximumResultCount: 10,
        permissionId: 'northstar.bootstrap:permission.read',
        queryId: registeredQueryId,
        queryType: 'list',
        selections: [
          {
            fieldId: 'northstar.bootstrap:field.id',
            orderKey: 0,
            selectionId: 'northstar.bootstrap:selection.id',
          },
        ],
        sourceEntityId: 'northstar.bootstrap:entity.item',
        tier: 'q0',
      },
    ],
    schemaVersion: 'northstar.query-catalog-payload/v0-provisional',
  };
}

function operationCatalogWith(
  registeredOperationId: string,
): ImmutableJsonValue {
  return {
    kind: 'operationCatalogPayload',
    operations: [
      {
        confirmation: 'none',
        effect: {
          entity: {
            kind: 'entityReference',
            schemaVersion: 'v0-experimental',
            targetId: 'northstar.bootstrap:entity.item',
          },
          kind: 'createRecordEffect',
          schemaVersion: 'v0-experimental',
        },
        lifecycle: 'active',
        operationId: registeredOperationId,
        permissionId: 'northstar.bootstrap:permission.create',
        precondition: {
          kind: 'booleanPredicate',
          schemaVersion: 'v0-experimental',
          value: true,
        },
        readBackQueryId: queryId,
        tier: 'o0',
      },
    ],
    schemaVersion: 'northstar.operation-catalog-payload/v0-provisional',
  };
}

function assertNoUnpinnedEvidence(error: object): void {
  for (const forbidden of [
    'environmentId',
    'permissionId',
    'pointerFence',
    'pointerId',
    'principalId',
    'tenantId',
  ]) {
    assert.equal(forbidden in error, false);
  }
}

function publicReadonlyKeys(source: string, interfaceName: string): string[] {
  const body = new RegExp(
    `export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`,
  ).exec(source)?.[1];
  assert.ok(body, `${interfaceName} must remain a public interface`);
  return [...body.matchAll(/readonly ([A-Za-z][A-Za-z0-9]*):/g)]
    .map((match) => match[1]!)
    .sort();
}
