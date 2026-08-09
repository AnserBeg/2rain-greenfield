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
  NoSuchRegisteredCapabilityError,
  NoSuchRegisteredOperationError,
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SEMANTIC_OPERATION_RESULT_VERSION,
  SemanticOperationConfirmationRequiredError,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
  SemanticOperationPolicyDeniedError,
  type SemanticOperationRequestEnvelope,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  MalformedPinnedQueryCatalogError,
  MalformedSemanticQueryRequestError,
  NoSuchRegisteredQueryError,
  SEMANTIC_AGGREGATE_RESULT_VERSION,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SEMANTIC_QUERY_RESULT_VERSION,
  SemanticQueryGateway,
  SemanticQueryPolicyDeniedError,
  type RegisteredQueryLatencyObservation,
  type SemanticAggregateResultEnvelope,
  type SemanticQueryExecutor,
  type SemanticQueryRequestEnvelope,
  type SemanticQueryResultEnvelope,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  PARAMETERIZED_PREDICATE_LOWERING_PLAN_VERSION,
  PREDICATE_POSITION_PROFILE_VERSION,
  QUERY_AGGREGATE_LOWERING_PLAN_VERSION,
  canonicalizeAndHash,
} from '../../packages/canonical-model/src/index.js';
import { ObservabilityMetrics } from '../../packages/observability/src/index.js';
import { composedRegisteredQueryLatencyInstrumentation } from '../../packages/postgres-provider/src/composed-application-runtime.js';

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

test('O1 capability operations require confirmation and dispatch by one exact ID', async () => {
  const capabilityId = 'northstar.inventory:capability.posting';
  const commandOperationId =
    'northstar.bootstrap:operation.inventory_transaction_post';
  const getQueryId = 'northstar.bootstrap:query.inventory_transaction_get';
  const fixture = createFixture({
    operationPayload: capabilityOperationCatalogWith(
      commandOperationId,
      capabilityId,
      getQueryId,
    ),
    queryPayload: getQueryCatalogWith(getQueryId),
  });
  const view = await fixture.requestEntry.run(authenticationInput, (value) =>
    Promise.resolve(value),
  );
  const input = Object.freeze({
    expectedRevision: 1,
    recordId: 'ab000000-0000-4000-8000-000000000002',
  });
  const request = {
    confirmationGrant: null,
    idempotencyKey: 'ab000000-0000-4000-8000-000000000003',
    input,
    operationId: commandOperationId,
    schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
  } as const;
  let executions = 0;
  const gateway = new SemanticOperationGateway(
    fixture.policy,
    undefined,
    fixture.operationMediation,
    undefined,
    [
      {
        capabilityId,
        async execute(execution) {
          executions += 1;
          assert.equal(
            execution.definition.effect.capability.targetId,
            capabilityId,
          );
          return {
            kind: 'semanticOperationResult' as const,
            operationId: commandOperationId,
            outcome: 'succeeded' as const,
            readBack: null,
            schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
            trust: null,
            unsupportedReason: null,
          };
        },
      },
    ],
  );
  await assert.rejects(
    gateway.invoke(
      view,
      request,
      fixture.operationMediation.issueInvocation(view, 'UI'),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SemanticOperationConfirmationRequiredError);
      assert.equal(error.code, 'SEMANTIC_OPERATION_CONFIRMATION_REQUIRED');
      return true;
    },
  );
  assert.equal(executions, 0);

  const confirmed = {
    ...request,
    confirmationGrant: fixture.operationMediation.issueConfirmationGrant(
      view,
      commandOperationId,
      input,
    ),
  };
  const result = await gateway.invoke(
    view,
    confirmed,
    fixture.operationMediation.issueInvocation(view, 'UI'),
  );
  assert.equal(result.outcome, 'succeeded');
  assert.equal(executions, 1);

  const absent = new SemanticOperationGateway(
    fixture.policy,
    undefined,
    fixture.operationMediation,
  );
  await assert.rejects(
    absent.invoke(
      view,
      confirmed,
      fixture.operationMediation.issueInvocation(view, 'UI'),
    ),
    (error: unknown) => {
      assert.ok(error instanceof NoSuchRegisteredCapabilityError);
      assert.equal(error.code, 'NO_SUCH_REGISTERED_CAPABILITY');
      assert.equal(error.capabilityId, capabilityId);
      return true;
    },
  );

  let wrongExecutions = 0;
  const wrongRegistration = new SemanticOperationGateway(
    fixture.policy,
    undefined,
    fixture.operationMediation,
    undefined,
    [
      {
        capabilityId: 'northstar.inventory:capability.not_posting',
        execute() {
          wrongExecutions += 1;
          return Promise.reject(new Error('wrong executor reached'));
        },
      },
    ],
  );
  await assert.rejects(
    wrongRegistration.invoke(
      view,
      confirmed,
      fixture.operationMediation.issueInvocation(view, 'UI'),
    ),
    NoSuchRegisteredCapabilityError,
  );
  assert.equal(wrongExecutions, 0);
});

test('O1 admission does not make an entity-less O0 record effect valid', async () => {
  const malformed = structuredClone(operationCatalogWith(operationId)) as {
    operations: Array<{ effect: Record<string, unknown> }>;
  };
  delete malformed.operations[0]!.effect.entity;
  const fixture = createFixture({
    operationPayload: malformed as ImmutableJsonValue,
    queryPayload: queryCatalogWith(queryId),
  });
  const view = await fixture.requestEntry.run(authenticationInput, (value) =>
    Promise.resolve(value),
  );
  await assert.rejects(
    new SemanticOperationGateway(
      fixture.policy,
      undefined,
      fixture.operationMediation,
    ).invoke(
      view,
      operationRequest,
      fixture.operationMediation.issueInvocation(view, 'API'),
    ),
    (error: unknown) => {
      assert.ok(error instanceof MalformedPinnedOperationCatalogError);
      assert.equal(error.code, 'MALFORMED_PINNED_OPERATION_CATALOG');
      return true;
    },
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

/**
 * A canonical reference is more than a `targetId`. Three arms of the catalog
 * parser each grew their own shallow copy, and all of them admitted a reference
 * declaring the WRONG CONSTRUCT, or a version the language never had, or a
 * version admitted but disagreeing with its own effect. Nothing downstream
 * noticed, because the interpreter resolves from `targetId` and never consults
 * the other two fields.
 *
 * **Every one of the four reference positions is forged here**, not one. A
 * control installed at a single call site cannot distinguish "all arms route
 * through the shared parser" from "the arm I happened to pick does" — restoring
 * a shallow check in either of the other two would leave it green.
 *
 * **And each specimen carries exactly one defect.** Its unrelated properties are
 * valid for its own enclosing effect, including the version on the wrong-kind
 * case. A specimen wrong in two ways cannot attribute the refusal to either, and
 * no amount of reading the failure text recovers that.
 */
const forgedReferencePositions = [
  {
    arm: 'record effect entity',
    expectedKind: 'entityReference',
    install: (catalog: ForgeableCatalog, reference: ImmutableJsonValue) => {
      catalog.operations[0]!.effect.entity = reference;
    },
    payload: () => structuredClone(operationCatalogWith(operationId)),
    request: () => operationRequest,
    version: 'v0-experimental',
  },
  {
    arm: 'capability effect capability',
    expectedKind: 'capabilityReference',
    install: (catalog: ForgeableCatalog, reference: ImmutableJsonValue) => {
      catalog.operations[0]!.effect.capability = reference;
    },
    payload: () =>
      structuredClone(
        capabilityOperationCatalogWith(
          operationId,
          'northstar.inventory:capability.posting',
          queryId,
        ),
      ),
    request: () => operationRequest,
    version: 'v4',
  },
  {
    arm: 'transition effect entity',
    expectedKind: 'entityReference',
    install: (catalog: ForgeableCatalog, reference: ImmutableJsonValue) => {
      catalog.operations[0]!.effect.entity = reference;
    },
    payload: () => structuredClone(transitionOperationCatalogWith(operationId)),
    request: () => operationRequest,
    version: 'v5',
  },
  {
    arm: 'transition effect transition',
    expectedKind: 'transitionReference',
    install: (catalog: ForgeableCatalog, reference: ImmutableJsonValue) => {
      catalog.operations[0]!.effect.transition = reference;
    },
    payload: () => structuredClone(transitionOperationCatalogWith(operationId)),
    request: () => operationRequest,
    version: 'v5',
  },
] as const;

type ForgeableCatalog = {
  operations: Array<{ effect: Record<string, unknown> }>;
};

/**
 * The admission twin for the forgery table below, and the reason it exists is
 * the table's own history: a control whose specimen is refused for an unrelated
 * reason proves nothing, and reading the failure text cannot recover the
 * attribution. If an UNFORGED catalog at some position is already rejected as
 * malformed, then all three forgeries at that position are decoration.
 */
/**
 * Version MEMBERSHIP, isolated.
 *
 * The obvious specimen -- a reference at an invented version -- is refused by
 * the equality check too, because an invented version cannot equal a real
 * effect's. Deleting membership alone therefore left the whole table green: a
 * confound of exactly the kind this control exists to avoid, found by asking
 * the generative question of each check rather than of the control as a whole.
 *
 * So this moves the EFFECT's version and the reference's together. They agree,
 * equality is satisfied, and membership is the only thing left that can refuse
 * a version the language never had.
 */
test('an effect at a version the language never had is refused', async (t) => {
  for (const position of forgedReferencePositions) {
    await t.test(position.arm, async () => {
      const catalog = position.payload() as unknown as ForgeableCatalog;
      const effect = catalog.operations[0]!.effect;
      effect.schemaVersion = 'invented-version';
      for (const key of ['entity', 'capability', 'transition']) {
        const reference = effect[key];
        if (reference && typeof reference === 'object') {
          (reference as Record<string, unknown>).schemaVersion =
            'invented-version';
        }
      }
      const fixture = createFixture({
        operationPayload: catalog as unknown as ImmutableJsonValue,
      });
      await assert.rejects(
        fixture.operationApi.handle(authenticationInput, position.request()),
        MalformedPinnedOperationCatalogError,
      );
      assert.equal(fixture.policy.authorizationCalls.length, 1);
    });
  }
});

test('every forgery position starts from a catalog the parser admits', async (t) => {
  for (const position of forgedReferencePositions) {
    await t.test(position.arm, async () => {
      const fixture = createFixture({
        operationPayload: position.payload() as unknown as ImmutableJsonValue,
      });
      const failure = await fixture.operationApi
        .handle(authenticationInput, position.request())
        .then(
          () => null,
          (error: unknown) => error,
        );
      assert.equal(
        failure instanceof MalformedPinnedOperationCatalogError,
        false,
        `unforged catalog for ${position.arm} must parse: ${String(failure)}`,
      );
    });
  }
});

test('a forged canonical reference never reaches the executor, at every position', async (t) => {
  for (const position of forgedReferencePositions) {
    for (const [label, reference] of [
      // Only `kind` is wrong. The version is this effect's own, so deleting the
      // production kind check is the only way to make this specimen pass.
      [
        'kind names a different construct',
        {
          kind: 'queryReference',
          schemaVersion: position.version,
          targetId: 'northstar.bootstrap:entity.item',
        },
      ],
      // Only the version is wrong, and wrong by never having existed. NOTE this
      // is ALSO caught by the equality check, since it cannot equal a real
      // effect version -- the membership case that isolates membership is
      // below, where the effect itself is moved.
      [
        'version was never in the language',
        {
          kind: position.expectedKind,
          schemaVersion: 'invented-version',
          targetId: 'northstar.bootstrap:entity.item',
        },
      ],
      // Only the version is wrong, and wrong by disagreeing with its effect
      // while being a real language version -- the case membership alone misses.
      [
        'version is admitted but disagrees with its effect',
        {
          kind: position.expectedKind,
          schemaVersion:
            position.version === 'v0-experimental' ? 'v4' : 'v0-experimental',
          targetId: 'northstar.bootstrap:entity.item',
        },
      ],
    ] as const) {
      await t.test(`${position.arm}: ${label}`, async () => {
        const catalog = position.payload() as unknown as ForgeableCatalog;
        position.install(catalog, reference as ImmutableJsonValue);
        const fixture = createFixture({
          operationPayload: catalog as unknown as ImmutableJsonValue,
        });
        await assert.rejects(
          fixture.operationApi.handle(authenticationInput, position.request()),
          MalformedPinnedOperationCatalogError,
        );
        // The executor is never constructed for a malformed catalog, so a
        // refusal later than this would surface as an execution.
        assert.equal(fixture.policy.authorizationCalls.length, 1);
      });
    }
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

/**
 * ADR-0032 §2 admits a loading treatment only where a *measured* operation
 * exceeds the Doherty threshold, and `ux-strategy-proposal.md` §18 risk 4 says
 * the ladder is meaningless unless something measures. These gates read the
 * recorded counter rather than the observer they injected, because the ingress
 * swallows observer faults by design: silence there is indistinguishable from
 * an observer that never ran.
 */
test('every read-ingress call is graded into one band, answered and refused alike', async () => {
  const fixture = createFixture({
    queryPayload: queryCatalogWith(answeringQueryId),
  });
  const view = await fixture.requestEntry.run(authenticationInput, (value) =>
    Promise.resolve(value),
  );
  const metrics = new ObservabilityMetrics();
  const observations: RegisteredQueryLatencyObservation[] = [];
  // A controlled clock, per AGENTS.md §6: paired start/end reads, never a sleep.
  const clock = scriptedClock([0, 45, 100, 1_400, 2_000, 2_500, 3_000, 3_010]);
  const gateway = new SemanticQueryGateway(
    fixture.policy,
    stubQueryExecutor(),
    undefined,
    undefined,
    {
      monotonicMilliseconds: clock.read,
      observe: (observation) => {
        observations.push(observation);
        metrics.recordRegisteredQueryLatency(
          observation.outcome,
          observation.durationMilliseconds,
        );
      },
    },
  );

  const answered = await gateway.invoke(view, ladderRequest(answeringQueryId));
  assert.equal(answered.outcome, 'exact');
  await gateway.invoke(view, ladderRequest(answeringQueryId));
  await assert.rejects(
    gateway.invoke(view, ladderRequest('northstar.bootstrap:query.absent')),
    NoSuchRegisteredQueryError,
  );
  await assert.rejects(
    gateway.invoke(view, { queryId: answeringQueryId }),
    MalformedSemanticQueryRequestError,
  );

  assert.equal(
    clock.remaining(),
    0,
    'the ingress read the clock exactly twice per call',
  );
  assert.deepEqual(
    observations.map((observation) => [
      observation.outcome,
      observation.queryId,
    ]),
    [
      ['answered', answeringQueryId],
      ['answered', answeringQueryId],
      ['refused', 'northstar.bootstrap:query.absent'],
      // The envelope was refused before it named a query, so nothing is named.
      ['refused', null],
    ],
  );

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.queryLatency, [
    ['answered|under_100ms', 1],
    ['answered|1s_3s', 1],
    ['refused|under_100ms', 1],
    ['refused|400ms_1s', 1],
  ]);
  assert.deepEqual(snapshot.queryLatencyRejections, []);
  assert.equal(
    snapshot.queryLatency.reduce((total, [, count]) => total + count, 0),
    4,
    'the graded total equals the invocation count: no ingress path escapes measurement',
  );
});

test('ladder evidence does not grow with the query catalog', async () => {
  const fixture = createFixture();
  const view = await fixture.requestEntry.run(authenticationInput, (value) =>
    Promise.resolve(value),
  );
  const metrics = new ObservabilityMetrics();
  let reads = 0;
  const gateway = new SemanticQueryGateway(
    fixture.policy,
    stubQueryExecutor(),
    undefined,
    undefined,
    {
      monotonicMilliseconds: () => (reads++ % 2 === 0 ? 0 : 250),
      observe: (observation) => {
        metrics.recordRegisteredQueryLatency(
          observation.outcome,
          observation.durationMilliseconds,
        );
      },
    },
  );

  for (let ordinal = 0; ordinal < 200; ordinal += 1) {
    await assert.rejects(
      gateway.invoke(
        view,
        ladderRequest(`northstar.bootstrap:query.absent_${String(ordinal)}`),
      ),
      NoSuchRegisteredQueryError,
    );
  }

  const rendered = metrics.renderPrometheus();
  const series = rendered
    .split('\n')
    .filter((line) =>
      line.startsWith('north_star_registered_query_latency_band_total{'),
    );
  assert.deepEqual(series, [
    'north_star_registered_query_latency_band_total{band="100ms_400ms",outcome="refused"} 200',
  ]);
  assert.equal(
    rendered.includes('northstar.bootstrap:query.'),
    false,
    'no query id reaches the exported evidence, so cardinality cannot follow the catalog',
  );
});

test('a backward or unusable clock reaches the evidence as a named rejection, and the read still answers', async () => {
  const fixture = createFixture({
    queryPayload: queryCatalogWith(answeringQueryId),
  });
  const view = await fixture.requestEntry.run(authenticationInput, (value) =>
    Promise.resolve(value),
  );
  const metrics = new ObservabilityMetrics();
  // 500 -> 480 is the ~2s WSL2 wall-clock step AGENTS.md §6 records, in
  // miniature. A clamp would file it as an instantaneous response.
  const backward = scriptedClock([500, 480]);
  const backwardGateway = new SemanticQueryGateway(
    fixture.policy,
    stubQueryExecutor(),
    undefined,
    undefined,
    {
      monotonicMilliseconds: backward.read,
      observe: (observation) => {
        metrics.recordRegisteredQueryLatency(
          observation.outcome,
          observation.durationMilliseconds,
        );
      },
    },
  );
  const steppedBack = await backwardGateway.invoke(
    view,
    ladderRequest(answeringQueryId),
  );
  assert.equal(
    steppedBack.outcome,
    'exact',
    'a bad clock never fails the read',
  );

  const brokenGateway = new SemanticQueryGateway(
    fixture.policy,
    stubQueryExecutor(),
    undefined,
    undefined,
    {
      monotonicMilliseconds: () => {
        throw new Error('monotonic source unavailable');
      },
      observe: (observation) => {
        metrics.recordRegisteredQueryLatency(
          observation.outcome,
          observation.durationMilliseconds,
        );
      },
    },
  );
  const unclocked = await brokenGateway.invoke(
    view,
    ladderRequest(answeringQueryId),
  );
  assert.equal(unclocked.outcome, 'exact');

  const snapshot = metrics.snapshot();
  assert.deepEqual(
    snapshot.queryLatency,
    [],
    'neither unusable sample was graded as a band',
  );
  assert.deepEqual(snapshot.queryLatencyRejections, [
    ['negative', 1],
    ['not_finite', 1],
  ]);
});

test('a throwing observer degrades the evidence and never the read', async () => {
  const fixture = createFixture({
    queryPayload: queryCatalogWith(answeringQueryId),
  });
  const view = await fixture.requestEntry.run(authenticationInput, (value) =>
    Promise.resolve(value),
  );
  let observations = 0;
  const gateway = new SemanticQueryGateway(
    fixture.policy,
    stubQueryExecutor(),
    undefined,
    undefined,
    {
      monotonicMilliseconds: scriptedClock([0, 10, 20, 30]).read,
      observe: () => {
        observations += 1;
        throw new Error('metrics sink unavailable');
      },
    },
  );

  const answered = await gateway.invoke(view, ladderRequest(answeringQueryId));
  assert.equal(answered.outcome, 'exact');
  await assert.rejects(
    gateway.invoke(view, ladderRequest('northstar.bootstrap:query.absent')),
    NoSuchRegisteredQueryError,
  );
  assert.equal(observations, 2, 'both paths still attempted an observation');
});

/**
 * Round 1 recorded `answered` before the public method checked the envelope
 * shape, so a call that threw `MalformedPinnedQueryCatalogError` was graded as
 * a successful answer — the outcome axis meant "the ingress returned to the
 * public method", not "the caller was answered". Both directions, because the
 * record path was the only one round 1 exercised at all.
 */
test('an executor answering with the wrong envelope kind is graded refused, both directions', async () => {
  const recordFixture = createFixture({
    queryPayload: queryCatalogWith(answeringQueryId),
  });
  const recordView = await recordFixture.requestEntry.run(
    authenticationInput,
    (value) => Promise.resolve(value),
  );
  const recordMetrics = new ObservabilityMetrics();
  const recordGateway = new SemanticQueryGateway(
    recordFixture.policy,
    // Lies about its envelope kind, which the executor contract cannot express.
    {
      execute: () =>
        Promise.resolve(
          aggregateEnvelope(
            answeringQueryId,
          ) as unknown as SemanticQueryResultEnvelope,
        ),
    },
    undefined,
    undefined,
    ladderInstrumentation(recordMetrics, scriptedClock([0, 250]).read),
  );
  await assert.rejects(
    recordGateway.invoke(recordView, ladderRequest(answeringQueryId)),
    (error: unknown) => {
      assert.ok(error instanceof MalformedPinnedQueryCatalogError);
      assert.equal(error.code, 'MALFORMED_PINNED_QUERY_CATALOG');
      // The message, not just the type: a malformed catalog raises the same
      // error class, so type alone would let a broken fixture pass this.
      assert.equal(error.message, 'record query returned an aggregate result');
      return true;
    },
  );
  assert.deepEqual(
    recordMetrics.snapshot().queryLatency,
    [['refused|100ms_400ms', 1]],
    'a record query handed an aggregate envelope is refused, not answered',
  );

  const aggregateFixture = createFixture({
    queryPayload: aggregateQueryCatalogWith(aggregateQueryId),
  });
  const aggregateView = await aggregateFixture.requestEntry.run(
    authenticationInput,
    (value) => Promise.resolve(value),
  );
  const aggregateMetrics = new ObservabilityMetrics();
  const aggregateGateway = new SemanticQueryGateway(
    aggregateFixture.policy,
    {
      execute: () => Promise.reject(new Error('record path must not be used')),
      executeAggregate: () =>
        Promise.resolve(
          recordEnvelope(
            aggregateQueryId,
          ) as unknown as SemanticAggregateResultEnvelope,
        ),
    },
    undefined,
    undefined,
    ladderInstrumentation(aggregateMetrics, scriptedClock([0, 1_500]).read),
  );
  await assert.rejects(
    aggregateGateway.invokeAggregate(
      aggregateView,
      ladderRequest(aggregateQueryId),
    ),
    (error: unknown) => {
      assert.ok(error instanceof MalformedPinnedQueryCatalogError);
      assert.equal(error.message, 'aggregate query returned a record result');
      return true;
    },
  );
  assert.deepEqual(
    aggregateMetrics.snapshot().queryLatency,
    [['refused|1s_3s', 1]],
    'an aggregate query handed a record envelope is refused, not answered',
  );
});

/**
 * Round 1 had no `invokeAggregate` witness at all — every fixture call and the
 * composed-path control used `invoke`. This is the answered half of that hole;
 * the refused half is above. Neither runs against a real database (see the
 * unproven list in runtime-slos.md).
 */
test('an aggregate invocation is graded on the same ladder as a record read', async () => {
  const fixture = createFixture({
    queryPayload: aggregateQueryCatalogWith(aggregateQueryId),
  });
  const view = await fixture.requestEntry.run(authenticationInput, (value) =>
    Promise.resolve(value),
  );
  const metrics = new ObservabilityMetrics();
  const clock = scriptedClock([0, 42]);
  const gateway = new SemanticQueryGateway(
    fixture.policy,
    {
      execute: () => Promise.reject(new Error('record path must not be used')),
      executeAggregate: (request) =>
        Promise.resolve(aggregateEnvelope(request.definition.queryId)),
    },
    undefined,
    undefined,
    ladderInstrumentation(metrics, clock.read),
  );

  const result = await gateway.invokeAggregate(
    view,
    ladderRequest(aggregateQueryId),
  );
  assert.equal(result.kind, 'semanticAggregateResult');
  assert.equal(clock.remaining(), 0);
  assert.deepEqual(metrics.snapshot().queryLatency, [
    ['answered|under_100ms', 1],
  ]);
});

/**
 * Fix 2, half one: the object the composition actually installs, driven across
 * ADR-0032's 400 ms boundary. It proves the composed wiring carries a duration
 * into a band rather than merely producing some band — round 1's composed
 * control could not tell those apart. It says nothing about whether the real
 * clock moves; that is the liveness gate in the observability suite.
 */
test('the composed instrumentation carries a duration across a real ladder boundary', async () => {
  const fixture = createFixture({
    queryPayload: queryCatalogWith(answeringQueryId),
  });
  const view = await fixture.requestEntry.run(authenticationInput, (value) =>
    Promise.resolve(value),
  );
  const metrics = new ObservabilityMetrics();
  // 399.5 ms then 400.5 ms: one step either side of Doherty, so a wiring that
  // dropped the duration would put both in the same band.
  const clock = scriptedClock([0, 399.5, 1_000, 1_400.5]);
  const gateway = new SemanticQueryGateway(
    fixture.policy,
    stubQueryExecutor(),
    undefined,
    undefined,
    composedRegisteredQueryLatencyInstrumentation(metrics, clock.read),
  );

  await gateway.invoke(view, ladderRequest(answeringQueryId));
  await gateway.invoke(view, ladderRequest(answeringQueryId));

  assert.equal(clock.remaining(), 0);
  assert.deepEqual(
    metrics.snapshot().queryLatency,
    [
      ['answered|100ms_400ms', 1],
      ['answered|400ms_1s', 1],
    ],
    'the composed observer grades each call by its own measured duration',
  );
});

/**
 * The production default branch, which every other control bypasses. Liveness
 * calls the exported source directly; both boundary controls pass a clock. So
 * `clock ?? monotonicMilliseconds` resolving to a dead fallback survives all of
 * them, and extracting the factory is what introduced that branch.
 *
 * **No band assertion could ever catch it**: a 0 ms sample and a 99 ms sample
 * are both `under_100ms`, and the composed PostgreSQL control asks only for
 * valid bands and no rejections, which twenty zero-duration readings satisfy
 * exactly. This observes the duration instead.
 *
 * It injects no clock, deliberately — that is the branch under test — so every
 * assertion here is threshold-free: strict positivity, an empty rejection set,
 * and one answered sample in whichever band the real clock produced. The
 * interval is burned rather than slept through.
 */
test('the composed factory default times a call from the live monotonic source', async () => {
  const fixture = createFixture({
    queryPayload: queryCatalogWith(answeringQueryId),
  });
  const view = await fixture.requestEntry.run(authenticationInput, (value) =>
    Promise.resolve(value),
  );
  const metrics = new ObservabilityMetrics();
  // No clock argument: this is exactly what the composition constructs.
  const instrumentation =
    composedRegisteredQueryLatencyInstrumentation(metrics);
  const observations: RegisteredQueryLatencyObservation[] = [];
  const gateway = new SemanticQueryGateway(
    fixture.policy,
    busyQueryExecutor(),
    undefined,
    undefined,
    Object.freeze({
      // The factory's own resolved clock, unwrapped. Only `observe` is wrapped,
      // and only so the duration that clock produced can be read back.
      monotonicMilliseconds: instrumentation.monotonicMilliseconds,
      observe: (observation: RegisteredQueryLatencyObservation) => {
        observations.push(observation);
        instrumentation.observe(observation);
      },
    }),
  );

  await gateway.invoke(view, ladderRequest(answeringQueryId));

  assert.equal(observations.length, 1);
  const observed = observations[0]!;
  assert.ok(
    observed.durationMilliseconds > 0,
    `the composed default clock produced ${String(
      observed.durationMilliseconds,
    )} ms across a busy interval`,
  );
  const snapshot = metrics.snapshot();
  assert.deepEqual(
    snapshot.queryLatencyRejections,
    [],
    'a live default source yields a usable sample, not a refused one',
  );
  // One answered sample, in whichever band the real clock produced. Naming the
  // band would assert a bound this test has no business asserting: ADR-0032 §1
  // makes 100-400 ms the *target* for a registered query, so a correct 120 ms
  // observation is inside the ratified budget, and a scheduler or GC pause on a
  // loaded host would red a correct invocation. Band boundaries are proved by
  // the controlled-clock tests above, where they are deterministic.
  assert.equal(snapshot.queryLatency.length, 1);
  assert.equal(snapshot.queryLatency[0]![1], 1);
  assert.match(snapshot.queryLatency[0]![0], /^answered\|/u);
});

const answeringQueryId = 'northstar.bootstrap:query.item_list';
const aggregateQueryId = 'northstar.bootstrap:query.item_amount_sum';
const aggregateNodeVersion = 'v4';
const aggregateMeasureFieldType = Object.freeze({
  kind: 'exactDecimalFieldType',
  precision: 38,
  representation: 'canonicalString',
  scale: 2,
  schemaVersion: aggregateNodeVersion,
});

function ladderInstrumentation(
  metrics: ObservabilityMetrics,
  clock: () => number,
) {
  return {
    monotonicMilliseconds: clock,
    observe: (observation: RegisteredQueryLatencyObservation) => {
      metrics.recordRegisteredQueryLatency(
        observation.outcome,
        observation.durationMilliseconds,
      );
    },
  };
}

function recordEnvelope(targetQueryId: string): SemanticQueryResultEnvelope {
  return Object.freeze({
    kind: 'semanticQueryResult' as const,
    outcome: 'exact' as const,
    queryId: targetQueryId,
    records: Object.freeze([]),
    schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
    unsupportedReason: null,
  });
}

function aggregateEnvelope(
  targetQueryId: string,
): SemanticAggregateResultEnvelope {
  return Object.freeze({
    kind: 'semanticAggregateResult' as const,
    outcome: 'exact' as const,
    queryId: targetQueryId,
    schemaVersion: SEMANTIC_AGGREGATE_RESULT_VERSION,
    value: Object.freeze({
      kind: 'exactDecimalResult' as const,
      precision: 38 as const,
      scale: 2,
      selectionId: 'northstar.bootstrap:selection.item_amount_sum',
      value: '0',
    }),
  });
}

function aggregateQueryCatalogWith(
  registeredQueryId: string,
): ImmutableJsonValue {
  const filter = {
    kind: 'booleanPredicate',
    schemaVersion: aggregateNodeVersion,
    value: true,
  };
  return {
    kind: 'queryCatalogPayload',
    queries: [
      {
        aggregate: {
          fieldId: 'northstar.bootstrap:field.item_amount',
          measureFieldType: aggregateMeasureFieldType,
          operator: 'sum',
          resultType: {
            kind: 'exactDecimalAggregateResultType',
            precision: 38,
            scale: 2,
            schemaVersion: aggregateNodeVersion,
          },
          selectionId: 'northstar.bootstrap:selection.item_amount_sum',
        },
        aggregatePlan: {
          costClass: 'tenantBoundedScan',
          kind: 'queryAggregateLoweringPlan',
          loweringRowId: 'northstar.query-aggregate-lowering/required-sum-v1',
          providerProbeId: 'Q1-P3b/required-sum-tenant-bounded-scan',
          schemaVersion: QUERY_AGGREGATE_LOWERING_PLAN_VERSION,
          sourceFieldType: aggregateMeasureFieldType,
        },
        filter,
        filterPlan: {
          costClass: 'tenantBoundedScan',
          kind: 'predicateLoweringPlan',
          positionProfileVersion: PREDICATE_POSITION_PROFILE_VERSION,
          predicateDigest: canonicalizeAndHash(filter).contentHash,
          // A lowering node carries no schemaVersion; the plan above does.
          root: { kind: 'booleanPredicate', value: true },
          schemaVersion: PARAMETERIZED_PREDICATE_LOWERING_PLAN_VERSION,
        },
        lifecycle: 'active',
        maximumResultCount: 1,
        parameters: [],
        permissionId: 'northstar.bootstrap:permission.read',
        queryId: registeredQueryId,
        queryType: 'aggregate',
        resultContract: {
          kind: 'semanticAggregateResult',
          outcome: 'exact',
          schemaVersion: SEMANTIC_AGGREGATE_RESULT_VERSION,
        },
        sourceEntityId: 'northstar.bootstrap:entity.item',
        tier: 'q1',
      },
    ],
    schemaVersion: 'northstar.query-catalog-payload/v0-provisional',
  } as ImmutableJsonValue;
}

function ladderRequest(targetQueryId: string): SemanticQueryRequestEnvelope {
  return Object.freeze({
    arguments: Object.freeze({}),
    queryId: targetQueryId,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
}

/**
 * Burns a bounded interval so a duration measured across it is unambiguous.
 * Busy, never asleep: AGENTS.md §6 forbids sleep-and-measure, and nothing here
 * asserts a bound on how long the interval took.
 */
function busyQueryExecutor(): SemanticQueryExecutor {
  return {
    execute(request) {
      const deadline = process.hrtime.bigint() + 1_000_000n;
      let spins = 0;
      while (process.hrtime.bigint() < deadline) {
        spins += 1;
      }
      assert.ok(spins >= 0);
      return Promise.resolve(recordEnvelope(request.definition.queryId));
    },
  };
}

function stubQueryExecutor(): SemanticQueryExecutor {
  return {
    execute(request) {
      return Promise.resolve(
        Object.freeze({
          kind: 'semanticQueryResult' as const,
          outcome: 'exact' as const,
          queryId: request.definition.queryId,
          records: Object.freeze([]),
          schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
          unsupportedReason: null,
        }),
      );
    },
  };
}

/**
 * The injected controlled clock. `remaining()` is what proves the ingress read
 * it exactly twice per call, so an extra or missing read cannot pass unnoticed.
 */
function scriptedClock(readings: readonly number[]): {
  read: () => number;
  remaining: () => number;
} {
  const pending = [...readings];
  return {
    read: () => {
      const next = pending.shift();
      assert.notEqual(next, undefined, 'the scripted clock was over-read');
      return next!;
    },
    remaining: () => pending.length,
  };
}

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

/**
 * A transition effect at the shape the compiler emits: both references present,
 * the flattened ids alongside them, and every node at the effect's own version.
 * The forgery table above spoils exactly one field of it at a time.
 */
function transitionOperationCatalogWith(
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
            schemaVersion: 'v5',
            targetId: 'northstar.bootstrap:entity.item',
          },
          fromStateId: 'northstar.bootstrap:state.item_draft',
          kind: 'transitionStateEffect',
          schemaVersion: 'v5',
          stateFieldId: 'northstar.bootstrap:derived_state_field.machine.item',
          toStateId: 'northstar.bootstrap:state.item_released',
          transition: {
            kind: 'transitionReference',
            schemaVersion: 'v5',
            targetId: 'northstar.bootstrap:transition.item_release',
          },
        },
        inputContract: {
          closedArgumentKeys: ['expectedRevision', 'recordId'],
          fields: [],
          relationInputs: [],
          schemaVersion: 'northstar.module-input-contract/v1',
          writableFieldIds: [],
        },
        lifecycle: 'active',
        operationId: registeredOperationId,
        permissionId: 'northstar.bootstrap:permission.create',
        precondition: {
          kind: 'booleanPredicate',
          schemaVersion: 'v5',
          value: true,
        },
        readBackQueryId: queryId,
        tier: 'o0',
      },
    ],
    schemaVersion: 'northstar.operation-catalog-payload/v0-provisional',
  };
}

function capabilityOperationCatalogWith(
  registeredOperationId: string,
  capabilityId: string,
  readBackQueryId: string,
): ImmutableJsonValue {
  return {
    kind: 'operationCatalogPayload',
    operations: [
      {
        confirmation: 'humanRequired',
        effect: {
          capability: {
            kind: 'capabilityReference',
            schemaVersion: 'v4',
            targetId: capabilityId,
          },
          kind: 'registeredCapabilityEffect',
          schemaVersion: 'v4',
        },
        inputContract: {
          closedArgumentKeys: ['expectedRevision', 'recordId'],
          fields: [],
          relationInputs: [],
          schemaVersion: 'northstar.module-input-contract/v1',
          writableFieldIds: [],
        },
        lifecycle: 'active',
        operationId: registeredOperationId,
        permissionId: 'northstar.bootstrap:permission.post',
        precondition: {
          kind: 'booleanPredicate',
          schemaVersion: 'v4',
          value: true,
        },
        readBackQueryId,
        tier: 'o1',
      },
    ],
    schemaVersion: 'northstar.operation-catalog-payload/v0-provisional',
  };
}

function getQueryCatalogWith(registeredQueryId: string): ImmutableJsonValue {
  return {
    kind: 'queryCatalogPayload',
    queries: [
      {
        filter: {
          kind: 'booleanPredicate',
          schemaVersion: 'v4',
          value: true,
        },
        lifecycle: 'active',
        maximumResultCount: 1,
        permissionId: 'northstar.bootstrap:permission.read',
        queryId: registeredQueryId,
        queryType: 'get',
        selections: [
          {
            fieldId: 'northstar.bootstrap:field.id',
            orderKey: 0,
            selectionId: 'northstar.bootstrap:selection.id',
          },
        ],
        sourceEntityId: 'northstar.bootstrap:entity.inventory_transaction',
        tier: 'q0',
      },
    ],
    schemaVersion: 'northstar.query-catalog-payload/v0-provisional',
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
