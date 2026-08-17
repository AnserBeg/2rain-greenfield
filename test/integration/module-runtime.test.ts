import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  canonicalize,
  normalizeApplicationPackage,
  type PredicateKernelReceipt,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  compileApplication,
  type CompileSuccess,
  type ContentAddressedArtifact,
} from '../../packages/compiler/src/index.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
} from '../../packages/runtime/src/request-context.js';
import {
  MalformedSemanticOperationRequestError,
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SEMANTIC_OPERATION_RESULT_VERSION,
  SemanticOperationGateway,
  SemanticOperationConfirmationGrantError,
  SemanticOperationConfirmationRequiredError,
  SemanticOperationConfirmationStaleError,
  SemanticOperationMediationAuthority,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationNonAcceptedRequest,
  type SemanticOperationResultEnvelope,
  type TrustedInvocationChannel,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SEMANTIC_QUERY_RESULT_VERSION,
  SemanticQueryGateway,
  type SemanticQueryExecutionRequest,
  type SemanticQueryExecutor,
  type SemanticQueryResultEnvelope,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeView,
  type RequestRuntimeProjectionFamily,
  type RuntimeProjection,
} from '../../packages/runtime/src/request-runtime-view.js';
import {
  FIXTURE_IDS,
  ordinaryModuleV1,
} from '../fixtures/g2/module-conformance/definitions.js';

const tenantId = 'd1000000-0000-4000-8000-000000000001';
const environmentId = 'd2000000-0000-4000-8000-000000000002';
const principalId = 'd3000000-0000-4000-8000-000000000003';
const releaseId = 'd4000000-0000-4000-8000-000000000004';
const pointerId = 'd5000000-0000-4000-8000-000000000005';

test('compiled registration data drives both generic gateway ports from one pinned view', async () => {
  const compiled = compileFixture();
  const policy = new AllowPolicy();
  const executor = new RecordingExecutor();
  const view = await issuedView(compiled, policy);
  const queries = new SemanticQueryGateway(policy, executor);
  const operationMediation = new SemanticOperationMediationAuthority();
  const operations = new SemanticOperationGateway(
    policy,
    executor,
    operationMediation,
  );

  const query = await queries.invoke(view, {
    arguments: { recordId: 'd6000000-0000-4000-8000-000000000006' },
    queryId: `${FIXTURE_IDS.namespace}:query.master_get`,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  const operation = await operations.invoke(
    view,
    {
      confirmationGrant: null,
      idempotencyKey: randomUUID(),
      input: {
        recordId: 'd7000000-0000-4000-8000-000000000007',
        values: {
          [FIXTURE_IDS.fieldIds.parentName]: 'Definition data',
          [FIXTURE_IDS.fieldIds.parentNumber]: 'D-001',
        },
      },
      operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
      schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
    },
    operationMediation.issueInvocation(view, 'API'),
  );

  assert.equal(query.outcome, 'exact');
  assert.equal(operation.outcome, 'succeeded');
  assert.equal(executor.queryCalls.length, 1);
  assert.equal(executor.operationCalls.length, 1);
  assert.equal(
    executor.queryCalls[0]?.definition.sourceEntityId,
    FIXTURE_IDS.entityIds.parent,
  );
  assert.equal(
    executor.operationCalls[0]?.definition.effect.entity.targetId,
    FIXTURE_IDS.entityIds.parent,
  );
  assert.equal(
    executor.operationCalls[0]?.readBackDefinition.queryId,
    `${FIXTURE_IDS.namespace}:query.master_get`,
  );
  assert.equal(executor.queryCalls[0]?.context.tenantId, tenantId);
  assert.equal(executor.operationCalls[0]?.context.principalId, principalId);
  assert.deepEqual(
    policy.calls.map((call) => call.permissionId),
    [
      'northstar.runtime:permission.semantic-query-boundary',
      `${FIXTURE_IDS.namespace}:permission.master_read`,
      'northstar.runtime:permission.semantic-operation-boundary',
      `${FIXTURE_IDS.namespace}:permission.master_create`,
    ],
  );
});

test('probe: scoped create converts a request selection into INTERNAL input and refuses vacuity', async () => {
  const compiled = compileFixture();
  const policy = new AllowPolicy();
  const executor = new RecordingExecutor();
  const view = await issuedView(compiled, policy, (projections) => ({
    ...projections,
    operation: mutateCatalog(projections.operation, 'operations', (entry) =>
      entry.operationId === `${FIXTURE_IDS.namespace}:operation.master_create`
        ? operationWithLegalEntitySystemInput(entry)
        : entry,
    ),
  }));
  const mediation = new SemanticOperationMediationAuthority();
  const gateway = new SemanticOperationGateway(policy, executor, mediation);
  const legalEntityId = 'dc000000-0000-4000-8000-00000000000c';

  await gateway.invoke(
    view,
    createRequest(),
    mediation.issueInvocation(view, 'UI'),
    { legalEntitySelection: legalEntityId },
  );

  assert.equal(executor.operationCalls.length, 1);
  assert.deepEqual(executor.operationCalls[0]?.input, {
    ...createRequest().input,
    legalEntityId,
  });
  const operationPolicyInput = policy.calls.find(
    (call) =>
      isRecord(call.decisionInput) &&
      call.decisionInput.kind === 'registeredSemanticOperationPolicyInput',
  )?.decisionInput;
  assert.ok(isRecord(operationPolicyInput));
  assert.deepEqual(
    operationPolicyInput.input,
    executor.operationCalls[0]?.input,
  );

  const alternateLegalEntityId = 'dd000000-0000-4000-8000-00000000000d';
  await gateway.invoke(
    view,
    createRequest(),
    mediation.issueInvocation(view, 'UI'),
    { legalEntitySelection: alternateLegalEntityId },
  );
  assert.equal(executor.operationCalls.length, 2);
  assert.notEqual(
    executor.operationCalls[0]?.inputDigest,
    executor.operationCalls[1]?.inputDigest,
  );

  await assert.rejects(
    gateway.invoke(
      view,
      createRequest(),
      mediation.issueInvocation(view, 'UI'),
    ),
    (error: unknown) =>
      error instanceof MalformedSemanticOperationRequestError &&
      error.message.includes('selection-omitted'),
  );
  await assert.rejects(
    gateway.invoke(
      view,
      createRequest(),
      mediation.issueInvocation(view, 'UI'),
      { legalEntitySelection: [legalEntityId] },
    ),
    (error: unknown) =>
      error instanceof MalformedSemanticOperationRequestError &&
      error.message.includes('set-selection-for-exactly-one'),
  );
  await assert.rejects(
    gateway.invoke(
      view,
      {
        ...createRequest(),
        input: { ...createRequest().input, legalEntityId },
      },
      mediation.issueInvocation(view, 'UI'),
      { legalEntitySelection: legalEntityId },
    ),
    (error: unknown) =>
      error instanceof MalformedSemanticOperationRequestError &&
      error.message.includes('cannot be supplied'),
  );

  const unscopedView = await issuedView(compiled, policy);
  await assert.rejects(
    gateway.invoke(
      unscopedView,
      createRequest(),
      mediation.issueInvocation(unscopedView, 'UI'),
      { legalEntitySelection: legalEntityId },
    ),
    (error: unknown) =>
      error instanceof MalformedSemanticOperationRequestError &&
      error.message.includes('does not declare'),
  );
  assert.equal(executor.operationCalls.length, 2);
});

test('gateway admits parseable operation predicates without deciding their truth', async () => {
  const compiled = compileFixture();
  const schemaVersion = compiled.bundle.releaseManifest.languageVersion;
  const policy = new AllowPolicy();
  const executor = new RecordingExecutor();
  const view = await issuedView(compiled, policy, (projections) => ({
    ...projections,
    operation: mutateCatalog(projections.operation, 'operations', (entry) => ({
      ...entry,
      precondition: {
        kind: 'booleanPredicate',
        schemaVersion,
        value: false,
      },
    })),
    query: mutateCatalog(projections.query, 'queries', (entry) => ({
      ...entry,
      filter: {
        kind: 'booleanPredicate',
        schemaVersion,
        value: false,
      },
    })),
  }));
  const query = await new SemanticQueryGateway(policy, executor).invoke(view, {
    arguments: { recordId: 'd6000000-0000-4000-8000-000000000006' },
    queryId: `${FIXTURE_IDS.namespace}:query.master_get`,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  const operationMediation = new SemanticOperationMediationAuthority();
  const operation = await new SemanticOperationGateway(
    policy,
    executor,
    operationMediation,
  ).invoke(
    view,
    {
      confirmationGrant: null,
      idempotencyKey: randomUUID(),
      input: {
        recordId: 'd7000000-0000-4000-8000-000000000007',
        values: {},
      },
      operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
      schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
    },
    operationMediation.issueInvocation(view, 'API'),
  );

  assert.deepEqual(
    { outcome: query.outcome, reason: query.unsupportedReason },
    { outcome: 'unsupported', reason: 'query-filter-unsupported' },
  );
  assert.deepEqual(
    { outcome: operation.outcome, reason: operation.unsupportedReason },
    {
      outcome: 'unsupported',
      reason: 'operation-read-back-unsupported',
    },
  );
  assert.equal(executor.queryCalls.length, 0);
  assert.equal(executor.operationCalls.length, 0);
});

test('strict predicate receipts route every gateway site and preserve exact outcomes', async (t) => {
  const compiled = compileFixture();
  const schemaVersion = compiled.bundle.releaseManifest.languageVersion;
  const rejectedPredicates: readonly {
    label: string;
    value: ImmutableJsonValue;
  }[] = [
    {
      label: 'unknown schemaVersion',
      value: {
        kind: 'booleanPredicate',
        schemaVersion: 'unknown',
        value: true,
      },
    },
    {
      label: 'unknown property',
      value: {
        kind: 'booleanPredicate',
        schemaVersion,
        unexpectedAuthority: 'x',
        value: true,
      },
    },
  ];

  for (const rejected of rejectedPredicates) {
    await t.test(`${rejected.label}: query filter`, async () => {
      const policy = new AllowPolicy();
      const executor = new RecordingExecutor();
      const kernel = new RecordingPredicateKernel(true);
      const view = await issuedView(compiled, policy, (projections) => ({
        ...projections,
        query: mutateCatalog(projections.query, 'queries', (entry) => ({
          ...entry,
          filter: rejected.value,
        })),
      }));
      const result = await new SemanticQueryGateway(
        policy,
        executor,
        kernel.observe,
      ).invoke(view, {
        arguments: { recordId: 'd6000000-0000-4000-8000-000000000006' },
        queryId: `${FIXTURE_IDS.namespace}:query.master_get`,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      });

      assert.equal(result.outcome, 'unsupported');
      assert.equal(result.unsupportedReason, 'query-filter-unsupported');
      assert.equal(executor.queryCalls.length, 0);
      assert.equal(kernel.receipts.length, 1);
      assert.equal(kernel.receipts[0]?.outcome, 'rejected');
    });

    await t.test(`${rejected.label}: operation precondition`, async () => {
      const policy = new AllowPolicy();
      const executor = new RecordingExecutor();
      const kernel = new RecordingPredicateKernel(true);
      const mediation = new SemanticOperationMediationAuthority();
      const view = await issuedView(compiled, policy, (projections) => ({
        ...projections,
        operation: mutateCatalog(
          projections.operation,
          'operations',
          (entry) => ({ ...entry, precondition: rejected.value }),
        ),
      }));
      const result = await new SemanticOperationGateway(
        policy,
        executor,
        mediation,
        kernel.observe,
      ).invoke(view, createRequest(), mediation.issueInvocation(view, 'API'));

      assert.equal(result.outcome, 'unsupported');
      assert.equal(
        result.unsupportedReason,
        'operation-precondition-unsupported',
      );
      assert.deepEqual(executor.persistedNonAcceptedRows, [
        {
          failureCode: 'SEMANTIC_OPERATION_PRECONDITION_UNSUPPORTED',
          operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
          outcome: 'FAILED',
        },
      ]);
      assert.equal(executor.operationCalls.length, 0);
      assert.equal(kernel.receipts.length, 1);
      assert.equal(kernel.receipts[0]?.outcome, 'rejected');
    });

    await t.test(`${rejected.label}: operation read-back`, async () => {
      const policy = new AllowPolicy();
      const executor = new RecordingExecutor();
      const kernel = new RecordingPredicateKernel(true);
      const mediation = new SemanticOperationMediationAuthority();
      const view = await issuedView(compiled, policy, (projections) => ({
        ...projections,
        query: mutateCatalog(projections.query, 'queries', (entry) => ({
          ...entry,
          filter: rejected.value,
        })),
      }));
      const result = await new SemanticOperationGateway(
        policy,
        executor,
        mediation,
        kernel.observe,
      ).invoke(view, createRequest(), mediation.issueInvocation(view, 'API'));

      assert.equal(result.outcome, 'unsupported');
      assert.equal(result.unsupportedReason, 'operation-read-back-unsupported');
      assert.deepEqual(executor.persistedNonAcceptedRows, [
        {
          failureCode: 'SEMANTIC_OPERATION_READ_BACK_UNSUPPORTED',
          operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
          outcome: 'FAILED',
        },
      ]);
      assert.equal(executor.operationCalls.length, 0);
      assert.deepEqual(
        kernel.receipts.map((receipt) => receipt.outcome),
        ['admitted', 'rejected'],
      );
    });
  }
});

test('predicate receipt observation cannot alter accepted query or operation execution', async () => {
  const compiled = compileFixture();
  const policy = new AllowPolicy();
  const executor = new RecordingExecutor();
  const kernel = new RecordingPredicateKernel(true);
  const view = await issuedView(compiled, policy);

  const query = await new SemanticQueryGateway(
    policy,
    executor,
    kernel.observe,
  ).invoke(view, {
    arguments: { recordId: 'd6000000-0000-4000-8000-000000000006' },
    queryId: `${FIXTURE_IDS.namespace}:query.master_get`,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  const mediation = new SemanticOperationMediationAuthority();
  const operation = await new SemanticOperationGateway(
    policy,
    executor,
    mediation,
    kernel.observe,
  ).invoke(view, createRequest(), mediation.issueInvocation(view, 'API'));

  assert.equal(query.outcome, 'exact');
  assert.equal(operation.outcome, 'succeeded');
  assert.equal(executor.queryCalls.length, 1);
  assert.equal(executor.operationCalls.length, 1);
  assert.deepEqual(
    kernel.receipts.map((receipt) => receipt.outcome),
    ['accepted', 'admitted', 'accepted'],
  );
});

test('empty catalogs execute zero predicate-kernel inputs explicitly', async () => {
  const fixturePolicy = new AllowPolicy();
  const kernel = new RecordingPredicateKernel();
  const compiled = compileFixture();
  const view = await issuedView(compiled, fixturePolicy, (projections) => ({
    ...projections,
    operation: {
      ...projections.operation,
      payload: {
        kind: 'operationCatalogPayload',
        operations: [],
        schemaVersion: 'northstar.operation-catalog-payload/v0-provisional',
      },
    },
    query: {
      ...projections.query,
      payload: {
        kind: 'queryCatalogPayload',
        queries: [],
        schemaVersion: 'northstar.query-catalog-payload/v0-provisional',
      },
    },
  }));

  await assert.rejects(
    new SemanticQueryGateway(
      fixturePolicy,
      new RecordingExecutor(),
      kernel.observe,
    ).invoke(view, {
      arguments: {},
      queryId: `${FIXTURE_IDS.namespace}:query.master_get`,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    }),
    /is not registered/,
  );
  assert.equal(
    kernel.receipts.length,
    0,
    'zero catalog subjects must be reported as zero kernel inputs',
  );
});

test('human-required operations refuse every channel without a matching server grant and stale grants fail', async () => {
  const compiled = compileFixture();
  const policy = new AllowPolicy();
  const executor = new RecordingExecutor();
  const view = await issuedView(compiled, policy);
  const mediation = new SemanticOperationMediationAuthority();
  const gateway = new SemanticOperationGateway(policy, executor, mediation);
  const operationId = `${FIXTURE_IDS.namespace}:operation.master_archive`;
  const input = Object.freeze({
    expectedRevision: 1,
    recordId: 'd7000000-0000-4000-8000-000000000007',
  });
  const channels: readonly TrustedInvocationChannel[] = [
    'AGENT',
    'API',
    'IMPORT',
    'SYSTEM',
    'UI',
    'WORKFLOW',
  ];

  for (const channel of channels) {
    await assert.rejects(
      gateway.invoke(
        view,
        {
          confirmationGrant: null,
          idempotencyKey: randomUUID(),
          input,
          operationId,
          schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
        },
        mediation.issueInvocation(view, channel),
      ),
      SemanticOperationConfirmationRequiredError,
    );
  }
  assert.deepEqual(
    executor.nonAcceptedCalls.map((call) => [
      call.channel,
      call.outcome,
      call.failureCode,
    ]),
    channels.map((channel) => [
      channel,
      'FAILED',
      'SEMANTIC_OPERATION_CONFIRMATION_REQUIRED',
    ]),
  );
  assert.equal(executor.operationCalls.length, 0);

  const grant = mediation.issueConfirmationGrant(view, operationId, input);
  await assert.rejects(
    gateway.invoke(
      view,
      {
        confirmationGrant: grant,
        idempotencyKey: randomUUID(),
        input: { ...input, expectedRevision: 2 },
        operationId,
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      },
      mediation.issueInvocation(view, 'API'),
    ),
    SemanticOperationConfirmationStaleError,
  );
  assert.equal(executor.nonAcceptedCalls.length, channels.length + 1);

  const [grantPayload, grantSignature] = grant.split('.');
  assert.ok(grantPayload && grantSignature);
  const forgedGrant = `${grantPayload}.${grantSignature.startsWith('a') ? 'b' : 'a'}${grantSignature.slice(1)}`;
  await assert.rejects(
    gateway.invoke(
      view,
      {
        confirmationGrant: forgedGrant,
        idempotencyKey: randomUUID(),
        input,
        operationId,
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      },
      mediation.issueInvocation(view, 'API'),
    ),
    SemanticOperationConfirmationGrantError,
  );
  assert.equal(executor.nonAcceptedCalls.length, channels.length + 2);

  const accepted = await gateway.invoke(
    view,
    {
      confirmationGrant: grant,
      idempotencyKey: randomUUID(),
      input,
      operationId,
      schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
    },
    mediation.issueInvocation(view, 'UI'),
  );
  assert.equal(accepted.outcome, 'succeeded');
  assert.equal(executor.operationCalls.length, 1);
});

test('gateway records exactly one trusted denied or failed terminal outcome', async () => {
  const compiled = compileFixture();

  const deniedPolicy = new DenyPolicy();
  const deniedExecutor = new RecordingExecutor();
  const deniedView = await issuedView(compiled, deniedPolicy);
  const deniedMediation = new SemanticOperationMediationAuthority();
  const deniedGateway = new SemanticOperationGateway(
    deniedPolicy,
    deniedExecutor,
    deniedMediation,
  );
  await assert.rejects(
    deniedGateway.invoke(
      deniedView,
      createRequest(),
      deniedMediation.issueInvocation(deniedView, 'UI'),
    ),
    /current policy denied operation/,
  );
  assert.deepEqual(
    deniedExecutor.nonAcceptedCalls.map((call) => ({
      channel: call.channel,
      failureCode: call.failureCode,
      outcome: call.outcome,
      policyDecision: call.policyDecision,
    })),
    [
      {
        channel: 'UI',
        failureCode: 'SEMANTIC_OPERATION_POLICY_DENIED',
        outcome: 'DENIED',
        policyDecision: 'DENY',
      },
    ],
  );

  const allowedPolicy = new AllowPolicy();
  const failure = Object.assign(new Error('fixture validation detail'), {
    code: 'FIXTURE_VALIDATION_FAILED',
  });
  const failedExecutor = new RecordingExecutor(failure);
  const failedView = await issuedView(compiled, allowedPolicy);
  const failedMediation = new SemanticOperationMediationAuthority();
  const failedGateway = new SemanticOperationGateway(
    allowedPolicy,
    failedExecutor,
    failedMediation,
  );
  await assert.rejects(
    failedGateway.invoke(
      failedView,
      createRequest(),
      failedMediation.issueInvocation(failedView, 'API'),
    ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'FIXTURE_VALIDATION_FAILED',
  );
  assert.deepEqual(
    failedExecutor.nonAcceptedCalls.map((call) => ({
      channel: call.channel,
      failureCode: call.failureCode,
      outcome: call.outcome,
    })),
    [
      {
        channel: 'API',
        failureCode: 'FIXTURE_VALIDATION_FAILED',
        outcome: 'FAILED',
      },
    ],
  );

  const malformedExecutor = new RecordingExecutor();
  const malformedMediation = new SemanticOperationMediationAuthority();
  const malformedGateway = new SemanticOperationGateway(
    allowedPolicy,
    malformedExecutor,
    malformedMediation,
  );
  await assert.rejects(
    malformedGateway.invoke(
      failedView,
      { ...createRequest(), idempotencyKey: '' },
      malformedMediation.issueInvocation(failedView, 'API'),
    ),
    MalformedSemanticOperationRequestError,
  );
  assert.deepEqual(
    malformedExecutor.nonAcceptedCalls.map((call) => ({
      channel: call.channel,
      failureCode: call.failureCode,
      operationId: call.operationId,
      outcome: call.outcome,
    })),
    [
      {
        channel: 'API',
        failureCode: 'MALFORMED_SEMANTIC_OPERATION_REQUEST',
        operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
        outcome: 'FAILED',
      },
    ],
  );

  await assert.rejects(
    malformedGateway.invoke(
      failedView,
      {
        ...createRequest(),
        operationId: `${FIXTURE_IDS.namespace}:operation.${'a'.repeat(181)}`,
      },
      malformedMediation.issueInvocation(failedView, 'API'),
    ),
    MalformedSemanticOperationRequestError,
  );
  assert.deepEqual(
    malformedExecutor.nonAcceptedCalls.at(-1) && {
      failureCode: malformedExecutor.nonAcceptedCalls.at(-1)!.failureCode,
      operationId: malformedExecutor.nonAcceptedCalls.at(-1)!.operationId,
      outcome: malformedExecutor.nonAcceptedCalls.at(-1)!.outcome,
    },
    {
      failureCode: 'MALFORMED_SEMANTIC_OPERATION_REQUEST',
      operationId: 'northstar.runtime:operation.malformed_request',
      outcome: 'FAILED',
    },
  );
  assert.equal(malformedExecutor.nonAcceptedCalls.length, 2);
});

function createRequest() {
  return {
    confirmationGrant: null,
    idempotencyKey: randomUUID(),
    input: {
      recordId: 'd7000000-0000-4000-8000-000000000007',
      values: {
        [FIXTURE_IDS.fieldIds.parentName]: 'Failure evidence',
        [FIXTURE_IDS.fieldIds.parentNumber]: 'D-002',
      },
    },
    operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
    schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
  } as const;
}

function operationWithLegalEntitySystemInput(
  entry: Record<string, ImmutableJsonValue>,
): ImmutableJsonValue {
  assert.ok(isRecord(entry.inputContract));
  const inputContract = entry.inputContract;
  assert.ok(Array.isArray(inputContract.closedArgumentKeys));
  assert.ok(
    inputContract.schemaVersion === 'northstar.module-input-contract/v1' ||
      inputContract.schemaVersion === 'northstar.module-input-contract/v3',
  );
  return {
    ...entry,
    inputContract: {
      ...inputContract,
      closedArgumentKeys: [
        ...inputContract.closedArgumentKeys,
        'legalEntityId',
      ],
      schemaVersion:
        inputContract.schemaVersion === 'northstar.module-input-contract/v1'
          ? 'northstar.module-input-contract/v2'
          : 'northstar.module-input-contract/v4',
      systemInput: {
        argumentKey: 'legalEntityId',
        classification: 'INTERNAL',
        immutableAfterCreate: true,
        physicalColumn: 'legal_entity_id',
        required: true,
        valueKind: 'uuid',
      },
    },
  };
}

class RecordingExecutor
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  readonly nonAcceptedCalls: SemanticOperationNonAcceptedRequest[] = [];
  readonly operationCalls: SemanticOperationExecutionRequest[] = [];
  readonly persistedNonAcceptedRows: {
    failureCode: string;
    operationId: string;
    outcome: 'DENIED' | 'FAILED';
  }[] = [];
  readonly queryCalls: SemanticQueryExecutionRequest[] = [];

  constructor(private readonly operationFailure: Error | null = null) {}

  async recordNonAccepted(
    request: SemanticOperationNonAcceptedRequest,
  ): Promise<void> {
    this.nonAcceptedCalls.push(request);
    this.persistedNonAcceptedRows.push({
      failureCode: request.failureCode,
      operationId: request.operationId,
      outcome: request.outcome,
    });
  }

  execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope>;
  execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope>;
  async execute(
    request: SemanticQueryExecutionRequest | SemanticOperationExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope | SemanticOperationResultEnvelope> {
    if ('arguments' in request) {
      this.queryCalls.push(request);
      return {
        kind: 'semanticQueryResult',
        outcome: 'exact',
        queryId: request.definition.queryId,
        records: [],
        schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
        unsupportedReason: null,
      };
    }
    if (this.operationFailure) throw this.operationFailure;
    this.operationCalls.push(request);
    return {
      kind: 'semanticOperationResult',
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: null,
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      trust: {
        changeDocumentId: 'd8000000-0000-4000-8000-000000000008',
        domainEventId: 'd9000000-0000-4000-8000-000000000009',
        invocationId: 'da000000-0000-4000-8000-00000000000a',
        outboxId: 'db000000-0000-4000-8000-00000000000b',
      },
      unsupportedReason: null,
    };
  }
}

class RecordingPredicateKernel {
  readonly receipts: PredicateKernelReceipt[] = [];

  constructor(private readonly throwAfterRecording = false) {}

  readonly observe = (receipt: PredicateKernelReceipt): void => {
    this.receipts.push(receipt);
    if (this.throwAfterRecording) {
      throw new Error('predicate receipt observer failed');
    }
  };
}

class AllowPolicy implements CurrentPolicyGateway {
  readonly calls: CurrentPolicyDecisionRequest[] = [];

  async authorize(request: CurrentPolicyDecisionRequest) {
    this.calls.push(request);
    return {
      decision: 'ALLOW' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'module-runtime-integration-policy/v1',
    };
  }

  async readCurrentVersion(_subject: CurrentPolicySubject) {
    void _subject;
    return { policyVersion: 'module-runtime-integration-policy/v1' };
  }
}

class DenyPolicy implements CurrentPolicyGateway {
  async authorize(_request: CurrentPolicyDecisionRequest) {
    void _request;
    return {
      decision: 'DENY' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'module-runtime-deny-policy/v1',
    };
  }

  async readCurrentVersion(_subject: CurrentPolicySubject) {
    void _subject;
    return { policyVersion: 'module-runtime-deny-policy/v1' };
  }
}

async function issuedView(
  compiled: CompileSuccess,
  policy: CurrentPolicyGateway,
  transform: (
    value: LoadedRequestRuntimeDefinition['projections'],
  ) => LoadedRequestRuntimeDefinition['projections'] = (value) => value,
): Promise<RequestRuntimeView> {
  const identity: AuthenticatedIdentity = {
    environmentId,
    principalId,
    tenantId,
  };
  const loader = {
    async load(): Promise<LoadedRequestRuntimeDefinition> {
      return {
        environmentId,
        pointer: { fence: 1, pointerId },
        projections: transform(runtimeProjections(compiled)),
        release: { contentHash: compiled.releaseRoot, releaseId },
        tenantId,
      };
    },
  };
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => identity),
    loader,
    policy,
  );
  return entry.run({}, (view) => view);
}

function runtimeProjections(
  compiled: CompileSuccess,
): LoadedRequestRuntimeDefinition['projections'] {
  return {
    agent: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.agent),
    catalog: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog),
    operation: projection(
      compiled,
      REQUEST_RUNTIME_PROJECTION_FAMILIES.operation,
    ),
    query: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.query),
    surface: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.surface),
  };
}

function projection<TFamily extends RequestRuntimeProjectionFamily>(
  compiled: CompileSuccess,
  familyId: TFamily,
): RuntimeProjection<TFamily> {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  const manifest = artifact(compiled, reference.artifactRoot);
  const manifestValue = decode(manifest);
  assert.ok(Array.isArray(manifestValue.chunks));
  const descriptor = manifestValue.chunks[0];
  assert.ok(isRecord(descriptor));
  assert.ok(typeof descriptor.contentHash === 'string');
  return {
    artifactRoot: reference.artifactRoot,
    familyId,
    instanceId: reference.instanceId,
    payload: decode(
      artifact(compiled, descriptor.contentHash),
    ) as unknown as ImmutableJsonValue,
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  };
}

function mutateCatalog<TFamily extends RequestRuntimeProjectionFamily>(
  source: RuntimeProjection<TFamily>,
  collection: 'operations' | 'queries',
  transform: (entry: Record<string, ImmutableJsonValue>) => ImmutableJsonValue,
): RuntimeProjection<TFamily> {
  assert.ok(isRecord(source.payload));
  const entries = source.payload[collection];
  assert.ok(Array.isArray(entries));
  return {
    ...source,
    payload: {
      ...source.payload,
      [collection]: entries.map((entry) => {
        assert.ok(isRecord(entry));
        return transform(entry as Record<string, ImmutableJsonValue>);
      }),
    },
  };
}

function artifact(
  compiled: CompileSuccess,
  contentHash: string,
): ContentAddressedArtifact {
  const value = compiled.bundle.artifacts.find(
    (candidate) => candidate.contentHash === contentHash,
  );
  assert.ok(value);
  return value;
}

function decode(
  artifactValue: ContentAddressedArtifact,
): Record<string, unknown> {
  const value: unknown = JSON.parse(
    new TextDecoder().decode(artifactValue.canonicalBytes),
  );
  assert.ok(isRecord(value));
  return value;
}

function compileFixture(): CompileSuccess {
  const normalized = normalizeApplicationPackage(ordinaryModuleV1());
  const result = compileApplication({
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    // Version-from-artifact: compile the fixture at the version it declares.
    profile: {
      ...MODULE_COMPILER_PROFILE,
      languageVersion: normalized.languageVersion,
      normalizationProfileVersion: normalized.normalizationProfileVersion,
    },
  });
  assert.equal(result.status, 'compiled');
  return result as CompileSuccess;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
