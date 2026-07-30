import assert from 'node:assert/strict';
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
  legalEntityIdsFromIssuedReadScope,
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
import { AuthenticatedSemanticQueryApiAdapter } from '../../packages/runtime/src/semantic-gateway-api-adapters.js';
import {
  MalformedLegalEntityScopeArgumentError,
  MalformedPinnedQueryCatalogError,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SEMANTIC_QUERY_RESULT_VERSION,
  SemanticQueryGateway,
  type SemanticQueryExecutionRequest,
  type SemanticQueryExecutor,
  type SemanticQueryResultEnvelope,
} from '../../packages/runtime/src/semantic-query-gateway.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const environmentId = 'a1000000-0000-4000-8000-000000000001';
const principalId = 'aa000000-0000-4000-8000-000000000001';
const pointerId = 'a2000000-0000-4000-8000-000000000001';
const releaseId = 'a3000000-0000-4000-8000-000000000001';
const releaseContentHash = 'a'.repeat(64);

const ENTITY_A = '5a2b6f10-9c31-4d8e-b7a4-1f0c2d3e4a5b';
const ENTITY_B = '7c4d8e20-1a53-4f6b-9d82-3e5a7c9b1d0f';

const scopedQueryId = 'northstar.bootstrap:query.entity_scoped_list';
const scopeParameterId = 'northstar.bootstrap:parameter.entity_scope';
const permissionId = 'northstar.bootstrap:permission.read';

const authenticationInput = Object.freeze({
  headers: Object.freeze({ authorization: 'Bearer q1p5-scope-fixture' }),
});

/**
 * THE CONTROL THIS PACKET EXISTS FOR.
 *
 * `AuthenticatedSemanticQueryApiAdapter.handle` invokes the gateway with TWO
 * arguments (`semantic-gateway-api-adapters.ts:23-25`) and cannot carry an
 * execution capability. That is why the whole legal-entity read scope was
 * unreachable in production, and it is why this control drives the real
 * adapter rather than calling the gateway directly: a direct gateway call
 * would pass while the API remained unable to ask.
 *
 * Victim: `semantic-gateway-api-adapters.ts:23-25`, the two-argument
 * `this.queryGateway.invoke(view, semanticEnvelope)` inside
 * `requestEntry.run`. Deleting the envelope pass-through, or routing the
 * operand anywhere other than `envelope.arguments`, makes the operand
 * unreachable again and this test fails.
 */
test('an ordinary API caller supplies the legal-entity operand end to end', async () => {
  const fixture = createFixture();
  const result = await fixture.queryApi.handle(authenticationInput, {
    arguments: { [scopeParameterId]: [ENTITY_B, ENTITY_A] },
    queryId: scopedQueryId,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assert.equal(result.outcome, 'exact');

  const request = fixture.executor.lastRequest;
  assert.ok(request, 'the executor was never reached');
  assert.ok(request.legalEntityReadScope, 'no scope reached the executor');

  // The capability is sealed by runtime identity, so reading its members back
  // through the issuing view is the observation, not a copied field.
  assert.deepEqual(
    legalEntityIdsFromIssuedReadScope(
      request.legalEntityReadScope,
      request.view,
    ),
    [ENTITY_A, ENTITY_B],
  );

  // The caller never held a capability — only an ordinary query argument.
  assert.equal(AuthenticatedSemanticQueryApiAdapter.length, 2);
  assert.equal(
    fixture.policy.permissions.filter(
      (id) => id === 'northstar.runtime:permission.legal-entity-read-scope',
    ).length,
    2,
    'each selected entity must receive its own live policy decision',
  );
});

/**
 * Victim: the `receipt.outcome !== 'accepted'` refusal inside
 * `#issueDeclaredLegalEntityScope`. Every one of these must fail BEFORE the
 * executor runs — a scope the gateway cannot read must never become a
 * narrower scope, a wider scope, or tenant-wide execution.
 */
test('an unreadable operand is refused before the executor runs', async () => {
  for (const [selection, reason] of [
    [undefined, 'selection-omitted'],
    [[], 'empty-selection'],
    [ENTITY_A, 'scalar-selection-for-non-empty-set'],
    [[ENTITY_A, ENTITY_A], 'duplicate-member'],
    [[ENTITY_A.toUpperCase()], 'invalid-member'],
  ] as const) {
    const fixture = createFixture();
    await assert.rejects(
      () =>
        fixture.queryApi.handle(authenticationInput, {
          arguments:
            selection === undefined ? {} : { [scopeParameterId]: selection },
          queryId: scopedQueryId,
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        }),
      (error: unknown) =>
        error instanceof MalformedLegalEntityScopeArgumentError &&
        error.reason === reason,
      `selection ${JSON.stringify(selection)}`,
    );
    assert.equal(
      fixture.executor.lastRequest,
      null,
      `executor ran for ${JSON.stringify(selection)}`,
    );
  }
});

/**
 * RELEASE VERIFICATION'S MECHANISM, per ADR-0031 §5. Verification probes a
 * scope-declaring query with the operand OMITTED and requires this typed
 * refusal. It asserts no business fact: an omitted operand is not a claim
 * about which companies exist.
 *
 * Victim: the same refusal branch. It cannot pass vacuously — an unregistered
 * query raises `NoSuchRegisteredQueryError` instead, a different type, so a
 * query that silently vanished from the catalog fails this probe.
 */
test('omission is refused with a typed error and no business entity', async () => {
  const fixture = createFixture();
  await assert.rejects(
    () =>
      fixture.queryApi.handle(authenticationInput, {
        arguments: {},
        queryId: scopedQueryId,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      }),
    (error: unknown) =>
      error instanceof MalformedLegalEntityScopeArgumentError &&
      error.code === 'SEMANTIC_QUERY_LEGAL_ENTITY_SCOPE_INVALID' &&
      error.reason === 'selection-omitted',
  );
  assert.equal(fixture.executor.lastRequest, null);

  // The probe names a real registered query, so it cannot pass by probing
  // nothing.
  const missing = createFixture();
  await assert.rejects(
    () =>
      missing.queryApi.handle(authenticationInput, {
        arguments: {},
        queryId: 'northstar.bootstrap:query.absent',
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      }),
    (error: unknown) =>
      !(error instanceof MalformedLegalEntityScopeArgumentError),
  );
});

/**
 * Victim: the `assertLegalEntityScopeContract` operand/parameter cross-check.
 * A compiled member naming a parameter the query does not declare would make
 * the gateway read an argument no contract describes.
 */
test('a compiled scope operand must name a declared parameter', async () => {
  const fixture = createFixture({ dropParameterDeclaration: true });
  await assert.rejects(
    () =>
      fixture.queryApi.handle(authenticationInput, {
        arguments: { [scopeParameterId]: [ENTITY_A] },
        queryId: scopedQueryId,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      }),
    (error: unknown) => error instanceof MalformedPinnedQueryCatalogError,
  );
  assert.equal(fixture.executor.lastRequest, null);
});

class RecordingExecutor implements SemanticQueryExecutor {
  lastRequest: SemanticQueryExecutionRequest | null = null;

  execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope> {
    this.lastRequest = request;
    return Promise.resolve({
      kind: 'semanticQueryResult',
      outcome: 'exact',
      queryId: request.definition.queryId,
      records: Object.freeze([]),
      schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
      unsupportedReason: null,
    });
  }
}

class RecordingPolicyGateway implements CurrentPolicyGateway {
  readonly permissions: string[] = [];
  readonly subjects: string[] = [];

  authorize(
    request: CurrentPolicyDecisionRequest,
  ): Promise<CurrentPolicyDecision> {
    this.permissions.push(request.permissionId);
    return Promise.resolve({
      decision: 'ALLOW',
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'policy-v1',
    });
  }

  readCurrentVersion(
    subject: CurrentPolicySubject,
  ): Promise<CurrentPolicyVersionEvidence> {
    this.subjects.push(subject.tenantId);
    return Promise.resolve({ policyVersion: 'policy-v1' });
  }
}

interface FixtureOptions {
  readonly dropParameterDeclaration?: boolean;
}

class FixtureDefinitionLoader implements RequestRuntimeDefinitionLoader {
  constructor(private readonly options: FixtureOptions) {}

  load(
    context: TrustedRequestContext,
  ): Promise<LoadedRequestRuntimeDefinition> {
    return Promise.resolve({
      environmentId: context.environmentId,
      pointer: { fence: 7, pointerId },
      projections: {
        agent: projection(
          REQUEST_RUNTIME_PROJECTION_FAMILIES.agent,
          'northstar.agent-discovery-payload/v0-provisional',
          { kind: 'agentDiscoveryPayload', operations: [], queries: [] },
        ),
        catalog: projection(
          REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog,
          'northstar.semantic-model-payload/v0-provisional',
          { kind: 'semanticModelPayload' },
        ),
        operation: projection(
          REQUEST_RUNTIME_PROJECTION_FAMILIES.operation,
          'northstar.operation-catalog-payload/v0-provisional',
          {
            kind: 'operationCatalogPayload',
            operations: [],
            schemaVersion: 'northstar.operation-catalog-payload/v0-provisional',
          },
        ),
        query: projection(
          REQUEST_RUNTIME_PROJECTION_FAMILIES.query,
          'northstar.query-catalog-payload/v0-provisional',
          scopedQueryCatalog(this.options),
        ),
        surface: projection(
          REQUEST_RUNTIME_PROJECTION_FAMILIES.surface,
          'northstar.surface-manifest-payload/v0-provisional',
          { kind: 'surfaceManifestPayload', surfaces: [] },
        ),
      },
      release: { contentHash: releaseContentHash, releaseId },
      tenantId: context.tenantId,
    });
  }
}

function scopedQueryCatalog(options: FixtureOptions): ImmutableJsonValue {
  return {
    kind: 'queryCatalogPayload',
    queries: [
      {
        filter: {
          kind: 'booleanPredicate',
          schemaVersion: 'v0-experimental',
          value: true,
        },
        legalEntityScope: {
          cardinality: 'nonEmptySet',
          kind: 'queryLegalEntityScope',
          operand: {
            kind: 'queryParameterReference',
            parameterId: scopeParameterId,
            schemaVersion: 'v4',
          },
          schemaVersion: 'v4',
        },
        lifecycle: 'active',
        maximumResultCount: 10,
        ...(options.dropParameterDeclaration
          ? {}
          : {
              parameters: [
                {
                  orderKey: 10,
                  parameterId: scopeParameterId,
                  parameterType: {
                    kind: 'legalEntityReferenceParameterType',
                    schemaVersion: 'v4',
                  },
                },
              ],
            }),
        permissionId,
        queryId: scopedQueryId,
        queryType: 'list',
        selections: [
          {
            fieldId: 'northstar.bootstrap:field.id',
            orderKey: 0,
            selectionId: 'northstar.bootstrap:selection.id',
          },
        ],
        sourceEntityId: 'northstar.bootstrap:entity.master',
        tier: 'q0',
      },
    ],
    schemaVersion: 'northstar.query-catalog-payload/v0-provisional',
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

function createFixture(options: FixtureOptions = {}): {
  executor: RecordingExecutor;
  policy: RecordingPolicyGateway;
  queryApi: AuthenticatedSemanticQueryApiAdapter;
} {
  const policy = new RecordingPolicyGateway();
  const executor = new RecordingExecutor();
  const identity: AuthenticatedIdentity = {
    environmentId,
    principalId,
    tenantId,
  };
  const requestEntry = new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async (request) =>
      request.headers?.authorization ===
      authenticationInput.headers.authorization
        ? identity
        : null,
    ),
    new FixtureDefinitionLoader(options),
    policy,
  );
  return {
    executor,
    policy,
    queryApi: new AuthenticatedSemanticQueryApiAdapter(
      requestEntry,
      new SemanticQueryGateway(policy, executor),
    ),
  };
}
