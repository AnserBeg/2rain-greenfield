import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LANGUAGE_VERSION,
  canonicalize,
  normalizeApplicationPackage,
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
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SEMANTIC_OPERATION_RESULT_VERSION,
  SemanticOperationGateway,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationResultEnvelope,
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
  const operations = new SemanticOperationGateway(policy, executor);

  const query = await queries.invoke(view, {
    arguments: { recordId: 'd6000000-0000-4000-8000-000000000006' },
    queryId: `${FIXTURE_IDS.namespace}:query.master_get`,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  const operation = await operations.invoke(view, {
    input: {
      recordId: 'd7000000-0000-4000-8000-000000000007',
      values: {
        [FIXTURE_IDS.fieldIds.parentName]: 'Definition data',
        [FIXTURE_IDS.fieldIds.parentNumber]: 'D-001',
      },
    },
    operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
    schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
  });

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

test('unsupported compiled predicates fail closed before the generic executor', async () => {
  const compiled = compileFixture();
  const policy = new AllowPolicy();
  const executor = new RecordingExecutor();
  const view = await issuedView(compiled, policy, (projections) => ({
    ...projections,
    operation: mutateCatalog(projections.operation, 'operations', (entry) => ({
      ...entry,
      precondition: {
        kind: 'booleanPredicate',
        schemaVersion: LANGUAGE_VERSION,
        value: false,
      },
    })),
    query: mutateCatalog(projections.query, 'queries', (entry) => ({
      ...entry,
      filter: {
        kind: 'booleanPredicate',
        schemaVersion: LANGUAGE_VERSION,
        value: false,
      },
    })),
  }));
  const query = await new SemanticQueryGateway(policy, executor).invoke(view, {
    arguments: { recordId: 'd6000000-0000-4000-8000-000000000006' },
    queryId: `${FIXTURE_IDS.namespace}:query.master_get`,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  const operation = await new SemanticOperationGateway(policy, executor).invoke(
    view,
    {
      input: {
        recordId: 'd7000000-0000-4000-8000-000000000007',
        values: {},
      },
      operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
      schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
    },
  );

  assert.deepEqual(
    { outcome: query.outcome, reason: query.unsupportedReason },
    { outcome: 'unsupported', reason: 'query-filter-unsupported' },
  );
  assert.deepEqual(
    { outcome: operation.outcome, reason: operation.unsupportedReason },
    {
      outcome: 'unsupported',
      reason: 'operation-precondition-unsupported',
    },
  );
  assert.equal(executor.queryCalls.length, 0);
  assert.equal(executor.operationCalls.length, 0);
});

class RecordingExecutor
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  readonly operationCalls: SemanticOperationExecutionRequest[] = [];
  readonly queryCalls: SemanticQueryExecutionRequest[] = [];

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
    return { policyVersion: 'module-runtime-integration-policy/v1' };
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
    profile: { ...MODULE_COMPILER_PROFILE },
  });
  assert.equal(result.status, 'compiled');
  return result as CompileSuccess;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
