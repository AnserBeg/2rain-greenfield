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
  SHARED_LIST_QUERY_VERSION,
  SHARED_LIST_RESULT_VERSION,
  SharedListContractError,
} from '../../packages/runtime/src/list-behavior/index.js';
import {
  MalformedLegalEntityScopeArgumentError,
  MalformedPinnedQueryCatalogError,
  MalformedSemanticQueryRequestError,
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
const rowParameterId = 'northstar.bootstrap:parameter.row_text';
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
  assert.deepEqual(request.parameterValues, {
    [scopeParameterId]: [ENTITY_B, ENTITY_A],
  });
  assert.equal(Object.isFrozen(request.parameterValues), true);

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
 * 5g3-rowparam CONTROL A. The value must reach the executor through the same
 * `parameterValues` member aggregates use; observing the request argument
 * alone would pass while binding still returned an empty object.
 *
 * Victim: the non-aggregate early return in `bindQueryParameters`.
 */
test('a declared row parameter is bound and reaches the executor', async () => {
  const fixture = createFixture({ rowParameter: true, unscopedQuery: true });
  const result = await fixture.queryApi.handle(authenticationInput, {
    arguments: { [rowParameterId]: 'counted stock' },
    queryId: scopedQueryId,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assert.equal(result.outcome, 'exact');
  assert.deepEqual(fixture.executor.lastRequest?.parameterValues, {
    [rowParameterId]: 'counted stock',
  });
  assert.equal(
    Object.isFrozen(fixture.executor.lastRequest?.parameterValues),
    true,
  );
});

/**
 * 5g3-rowparam CONTROL B. The declared field type is enforced before the
 * executor. Merely observing that a value was copied would not prove this.
 *
 * Victim: the field-type match in `bindQueryParameters`.
 */
test('a wrong row parameter type fails closed before execution', async () => {
  const fixture = createFixture({ rowParameter: true, unscopedQuery: true });
  await assert.rejects(
    () =>
      fixture.queryApi.handle(authenticationInput, {
        arguments: { [rowParameterId]: false },
        queryId: scopedQueryId,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      }),
    (error: unknown) =>
      error instanceof MalformedSemanticQueryRequestError &&
      error.code === 'MALFORMED_SEMANTIC_QUERY_REQUEST',
  );
  assert.equal(fixture.executor.lastRequest, null);
});

/**
 * 5g3-rowparam CONTROL C. Omission is its own vacuity vector: the binder must
 * not silently default a required declaration or deliver `undefined`.
 *
 * Victim: the declared-parameter presence check in `bindQueryParameters`.
 */
test('an omitted row parameter fails closed before execution', async () => {
  const fixture = createFixture({ rowParameter: true, unscopedQuery: true });
  await assert.rejects(
    () =>
      fixture.queryApi.handle(authenticationInput, {
        arguments: {},
        queryId: scopedQueryId,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      }),
    (error: unknown) =>
      error instanceof MalformedSemanticQueryRequestError &&
      error.code === 'MALFORMED_SEMANTIC_QUERY_REQUEST',
  );
  assert.equal(fixture.executor.lastRequest, null);
});

/**
 * G3-P6a CONTROL A. ADR-0031's original journey omitted the real `list`
 * member, so shared-list parsing returned early and never tested its closed
 * root beside a declared row parameter.
 *
 * Victim: the `declaredParameterIds` supplied to `parseSharedListArguments`
 * in `SemanticQueryGateway.#invoke`. Removing it restores
 * LIST_INPUT_MALFORMED before the executor observes either contract.
 */
test('a declared legal-entity operand coexists with real shared-list arguments', async () => {
  const fixture = createFixture();
  const result = await fixture.queryApi.handle(authenticationInput, {
    arguments: {
      [scopeParameterId]: [ENTITY_A],
      includeArchived: false,
      list: sharedListArguments(),
    },
    queryId: scopedQueryId,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assert.equal(result.outcome, 'exact');
  const request = fixture.executor.lastRequest;
  assert.ok(request?.list);
  assert.equal(request.list.query.requestedPageSize, 7);
  assert.equal(request.list.query.search, 'counted stock');
  assert.deepEqual(request.list.query.sort, [
    {
      direction: 'ascending',
      fieldId: 'northstar.bootstrap:field.id',
    },
  ]);
  assert.ok(request.legalEntityReadScope);
  assert.deepEqual(
    legalEntityIdsFromIssuedReadScope(
      request.legalEntityReadScope,
      request.view,
    ),
    [ENTITY_A],
  );
});

/** G3-P6a CONTROL B: v0-v3 unparameterized list roots remain unchanged. */
test('an unparameterized list still admits exactly the original root contract', async () => {
  const fixture = createFixture({ unscopedQuery: true });
  const result = await fixture.queryApi.handle(authenticationInput, {
    arguments: {
      includeArchived: true,
      list: sharedListArguments(),
    },
    queryId: scopedQueryId,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assert.equal(result.outcome, 'exact');
  assert.deepEqual(
    Object.keys(fixture.executor.lastRequest?.arguments ?? {}).sort(),
    ['includeArchived', 'list'],
  );
  assert.equal(fixture.executor.lastRequest?.list?.query.includeArchived, true);
});

/**
 * G3-P6a CONTROL C. The request cannot register its own root keys.
 *
 * Victim: the root `assertExactKeys` in `parseSharedListArguments`. Removing
 * it lets this undeclared value reach the semantic executor.
 */
test('a shared-list root still refuses every undeclared query argument', async () => {
  const fixture = createFixture({ unscopedQuery: true });
  await assert.rejects(
    () =>
      fixture.queryApi.handle(authenticationInput, {
        arguments: {
          'northstar.bootstrap:parameter.undeclared': ENTITY_A,
          includeArchived: false,
          list: sharedListArguments(),
        },
        queryId: scopedQueryId,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      }),
    (error: unknown) =>
      error instanceof SharedListContractError &&
      error.code === 'LIST_INPUT_MALFORMED',
  );
  assert.equal(fixture.executor.lastRequest, null);
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

/**
 * REVIEW FINDING 2. The operand is part of the request contract, so its
 * refusal must precede every branch that can return an `unsupported` envelope.
 * A retired query previously answered `unsupported` to a malformed operand,
 * which release verification's probe would read as "the query is fine".
 *
 * Victim: the `scopeSelection` evaluation placed above the lifecycle branch in
 * `#invoke`. Moving it back below that branch makes this test fail.
 */
test('a malformed operand is refused even when the query is not active', async () => {
  const fixture = createFixture({ retiredQuery: true });
  await assert.rejects(
    () =>
      fixture.queryApi.handle(authenticationInput, {
        arguments: {},
        queryId: scopedQueryId,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      }),
    (error: unknown) =>
      error instanceof MalformedLegalEntityScopeArgumentError &&
      error.reason === 'selection-omitted',
  );
  assert.equal(fixture.executor.lastRequest, null);

  // A retired query with a WELL-FORMED operand still reports unsupported, so
  // the reordering did not turn lifecycle into a scope error.
  const wellFormed = createFixture({ retiredQuery: true });
  const result = await wellFormed.queryApi.handle(authenticationInput, {
    arguments: { [scopeParameterId]: [ENTITY_A] },
    queryId: scopedQueryId,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assert.equal(result.outcome, 'unsupported');
  assert.equal(wellFormed.executor.lastRequest, null);
});

/**
 * REVIEW FINDING 3. A row query's declared parameters are part of the closed
 * pinned catalog and must be validated like the aggregate branch's are.
 * Checking only that the operand's id exists admitted a catalog the canonical
 * model could not have produced.
 *
 * Victim: `assertRowQueryParameters`, and the parameter-type check inside
 * `assertLegalEntityScopeContract`.
 */
test('a forged row parameter declaration cannot reach the executor', async () => {
  for (const declaration of [
    // Missing the derived type entirely.
    { orderKey: 10, parameterId: scopeParameterId },
    // An ordinary field type where the derived legal-entity type belongs.
    {
      orderKey: 10,
      parameterId: scopeParameterId,
      parameterType: { kind: 'textFieldType', maximumLength: 40 },
    },
    // The right kind at a version that never declared it.
    {
      orderKey: 10,
      parameterId: scopeParameterId,
      parameterType: {
        kind: 'legalEntityReferenceParameterType',
        schemaVersion: 'v3',
      },
    },
  ]) {
    const fixture = createFixture({
      parameterDeclaration: declaration as ImmutableJsonValue,
    });
    await assert.rejects(
      () =>
        fixture.queryApi.handle(authenticationInput, {
          arguments: { [scopeParameterId]: [ENTITY_A] },
          queryId: scopedQueryId,
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        }),
      (error: unknown) => error instanceof MalformedPinnedQueryCatalogError,
      JSON.stringify(declaration),
    );
    assert.equal(
      fixture.executor.lastRequest,
      null,
      JSON.stringify(declaration),
    );
  }
});

class RecordingExecutor implements SemanticQueryExecutor {
  lastRequest: SemanticQueryExecutionRequest | null = null;

  execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope> {
    this.lastRequest = request;
    return Promise.resolve({
      kind: 'semanticQueryResult',
      ...(request.list
        ? {
            listCoverage: {
              effectivePageSize: request.list.query.effectivePageSize,
              hasMore: false,
              includeArchived: request.list.query.includeArchived,
              matchMode: request.list.query.matchMode,
              nextCursor: null,
              pageOffset: request.list.query.pageOffset,
              projectedSearchValueCount: 0,
              requestedPageSize: request.list.query.requestedPageSize,
              returnedCount: 0,
              schemaVersion: SHARED_LIST_RESULT_VERSION,
              search: request.list.query.search,
              sort: request.list.query.sort,
              totalCount: 0,
              truncatedByMaximum: request.list.query.truncatedByMaximum,
            },
          }
        : {}),
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
  readonly parameterDeclaration?: ImmutableJsonValue;
  readonly retiredQuery?: boolean;
  readonly rowParameter?: boolean;
  readonly unscopedQuery?: boolean;
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
        ...(options.unscopedQuery
          ? {}
          : {
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
            }),
        lifecycle: options.retiredQuery ? 'retired' : 'active',
        maximumResultCount: 10,
        ...((!options.dropParameterDeclaration && !options.unscopedQuery) ||
        options.rowParameter
          ? {
              parameters: [
                ...(!options.dropParameterDeclaration && !options.unscopedQuery
                  ? [
                      options.parameterDeclaration ?? {
                        orderKey: 10,
                        parameterId: scopeParameterId,
                        parameterType: {
                          kind: 'legalEntityReferenceParameterType',
                          schemaVersion: 'v4',
                        },
                      },
                    ]
                  : []),
                ...(options.rowParameter
                  ? [
                      {
                        orderKey: 20,
                        parameterId: rowParameterId,
                        parameterType: {
                          kind: 'textFieldType',
                          maximumLength: 40,
                          schemaVersion: 'v4',
                        },
                      },
                    ]
                  : []),
              ],
            }
          : {}),
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

function sharedListArguments(): ImmutableJsonValue {
  return {
    cursor: null,
    matchMode: 'substring',
    pageSize: 7,
    relationLabels: [],
    schemaVersion: SHARED_LIST_QUERY_VERSION,
    search: 'counted stock',
    sort: [
      {
        direction: 'ascending',
        fieldId: 'northstar.bootstrap:field.id',
      },
    ],
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
