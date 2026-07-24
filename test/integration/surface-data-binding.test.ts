import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import test from 'node:test';

import {
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
  SEMANTIC_OPERATION_RESULT_VERSION,
  SemanticOperationGateway,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationResultEnvelope,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_RESULT_VERSION,
  SemanticQueryGateway,
  type SemanticQueryExecutionRequest,
  type SemanticQueryExecutor,
  type SemanticQueryResultEnvelope,
  type SemanticRecordDto,
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
  type RequestRuntimeProjectionFamily,
  type RequestRuntimeView,
  type RuntimeProjection,
} from '../../packages/runtime/src/request-runtime-view.js';
import { createSurfaceRuntimeServer } from '../../apps/web/src/app-server.js';
import {
  renderSurfaceRuntimeWithData,
  submitSurfaceRuntimeIntent,
  type SurfaceRuntimeGateways,
} from '../../apps/web/src/surface-runtime.js';
import {
  FIXTURE_IDS,
  ordinaryModuleV1,
} from '../fixtures/g2/module-conformance/definitions.js';

const tenantA = 'a1000000-0000-4000-8000-000000000001';
const tenantB = 'b1000000-0000-4000-8000-000000000001';
const environmentA = 'a2000000-0000-4000-8000-000000000002';
const environmentB = 'b2000000-0000-4000-8000-000000000002';
const principalA = 'a3000000-0000-4000-8000-000000000003';
const principalB = 'b3000000-0000-4000-8000-000000000003';
const releaseId = 'd4000000-0000-4000-8000-000000000004';
const pointerId = 'd5000000-0000-4000-8000-000000000005';

test('compiled fixture surfaces bind live Q0/O0 data through one pinned request path', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  executor.seed(tenantA, 'Tenant A live');
  executor.seed(tenantB, 'Tenant B hidden');
  const gateways = semanticGateways(policy, executor);
  const server = createSurfaceRuntimeServer(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
      b: identity(tenantB, environmentB, principalB),
    }),
    gateways,
  );
  const baseUrl = await listen(server);
  try {
    const list = await fetch(
      `${baseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_list`)}`,
      { headers: { authorization: 'a' } },
    );
    const listHtml = await list.text();
    assert.equal(list.status, 200);
    assert.match(listHtml, /Tenant A live/);
    assert.doesNotMatch(listHtml, /Tenant B hidden/);
    assert.doesNotMatch(
      listHtml,
      /north_star_module|nsm_[ctik]_|storageClass/i,
    );

    const formSurface = `${FIXTURE_IDS.namespace}:surface.master_form`;
    const create = await fetch(
      `${baseUrl}/?surface=${encodeURIComponent(formSurface)}`,
      {
        body: new URLSearchParams({
          intent: 'create',
          [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Created in browser',
        }),
        headers: {
          authorization: 'a',
          'content-type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
      },
    );
    const createHtml = await create.text();
    assert.equal(create.status, 200);
    assert.match(createHtml, /Created in browser/);
    assert.match(createHtml, /data-operation-intent="create"/);
    assert.match(createHtml, /data-trust-linked="true"/);
    assert.equal(executor.operationCalls.length, 1);
    assert.equal(executor.operationCalls[0]?.context.tenantId, tenantA);
    assert.equal(
      executor.operationCalls[0]?.context.environmentId,
      environmentA,
    );
    assert.equal(executor.operationCalls[0]?.context.principalId, principalA);
    assert.equal(executor.trustFacts.length, 1);
    assert.deepEqual(Object.keys(executor.trustFacts[0]!.links).sort(), [
      'changeDocumentId',
      'domainEventId',
      'invocationId',
      'outboxId',
    ]);

    const createdInput = asRecord(executor.operationCalls[0]!.input);
    const createdId = String(createdInput.recordId);
    const update = await postIntent(baseUrl, formSurface, {
      expectedRevision: '1',
      intent: 'update',
      recordId: createdId,
      [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Updated in browser',
    });
    assert.match(update, /Updated in browser/);
    const recordSurface = `${FIXTURE_IDS.namespace}:surface.master_record`;
    const archived = await postIntent(baseUrl, recordSurface, {
      confirmed: 'yes',
      expectedRevision: '2',
      intent: 'archive',
      recordId: createdId,
    });
    assert.match(archived, /Archived · revision 3/);
    const restored = await postIntent(baseUrl, recordSurface, {
      expectedRevision: '3',
      intent: 'restore',
      recordId: createdId,
    });
    assert.match(restored, /Active · revision 4/);
    assert.deepEqual(
      executor.operationCalls.map((call) => call.definition.effect.kind),
      [
        'createRecordEffect',
        'updateRecordEffect',
        'archiveRecordEffect',
        'restoreRecordEffect',
      ],
    );
    assert.equal(executor.trustFacts.length, 4);
    assert.ok(
      policy.calls.some(
        (call) =>
          call.permissionId ===
          'northstar.runtime:permission.semantic-operation-boundary',
      ),
    );
  } finally {
    await close(server);
  }
});

test('frozen Q0 outcomes and gateway failures render bounded safe states', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const operationGateway = new SemanticOperationGateway(
    policy,
    new InMemoryGenericExecutor(),
  );
  const recordUrl = `/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_record`)}&record=${randomUUID()}`;
  const cases: ReadonlyArray<
    readonly [SemanticQueryResultEnvelope['outcome'], string]
  > = [
    ['ambiguous', 'QUERY_AMBIGUOUS'],
    ['not-found', 'QUERY_NOT_FOUND'],
    ['unsupported', 'QUERY_UNSUPPORTED'],
  ];
  for (const [outcome, diagnostic] of cases) {
    const result = await renderSurfaceRuntimeWithData(view, recordUrl, {
      operationGateway,
      queryGateway: fixedQueryGateway(outcome, []),
    });
    assert.equal(result.statusCode, 200);
    assert.match(result.html, new RegExp(diagnostic));
  }

  const empty = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_list`)}`,
    {
      operationGateway,
      queryGateway: fixedQueryGateway('exact', []),
    },
  );
  assert.match(empty.html, /data-data-state="empty"/);

  const denied = await renderSurfaceRuntimeWithData(view, recordUrl, {
    operationGateway,
    queryGateway: new SemanticQueryGateway(
      new RecordingPolicy('DENY'),
      new InMemoryGenericExecutor(),
    ),
  });
  assert.match(denied.html, /QUERY_PERMISSION_DENIED/);

  const unavailable = await renderSurfaceRuntimeWithData(view, recordUrl, {
    operationGateway,
    queryGateway: new SemanticQueryGateway(new RecordingPolicy('ALLOW'), {
      async execute() {
        throw new Error('north_star_module.private_table');
      },
    }),
  });
  assert.match(unavailable.html, /QUERY_UNAVAILABLE/);
  assert.doesNotMatch(unavailable.html, /private_table|north_star_module/);
});

test('compiler-valid collection queries fail closed on singular surfaces', async () => {
  const definition = ordinaryModuleV1();
  assert.ok(Array.isArray(definition.surfaces));
  const form = definition.surfaces
    .map(asRecord)
    .find(
      (surface) =>
        surface.surfaceId === `${FIXTURE_IDS.namespace}:surface.master_form`,
    );
  assert.ok(form);
  asRecord(form.dataSource).targetId =
    `${FIXTURE_IDS.namespace}:query.master_list`;

  const compiled = compileFixture(definition);
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const result = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`,
    semanticGateways(policy, executor),
  );

  assert.equal(result.statusCode, 422);
  assert.match(result.html, /QUERY_UNSUPPORTED/);
  assert.equal(executor.queryCalls.length, 0);
});

test('human-confirmed forms render the authoritative operation read-back without a follow-up query', async () => {
  const definition = ordinaryModuleV1();
  assert.ok(Array.isArray(definition.operations));
  for (const operation of definition.operations.map(asRecord)) {
    if (
      operation.operationId ===
        `${FIXTURE_IDS.namespace}:operation.master_create` ||
      operation.operationId ===
        `${FIXTURE_IDS.namespace}:operation.master_update`
    ) {
      operation.confirmation = 'humanRequired';
    }
  }

  const compiled = compileFixture(definition);
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  let queryCalls = 0;
  const gateways: SurfaceRuntimeGateways = {
    operationGateway: new SemanticOperationGateway(policy, executor),
    queryGateway: new SemanticQueryGateway(policy, {
      async execute() {
        queryCalls += 1;
        throw new Error('follow-up query must not replace operation read-back');
      },
    }),
  };
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const formUrl = `/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`;
  const initial = await renderSurfaceRuntimeWithData(view, formUrl, gateways);
  assert.match(initial.html, /name="confirmed" value="yes"/);

  const blocked = await submitSurfaceRuntimeIntent(
    view,
    formUrl,
    {
      intent: 'create',
      [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Not yet confirmed',
    },
    gateways,
  );
  assert.equal(blocked.statusCode, 422);
  assert.match(blocked.html, /OPERATION_CONFIRMATION_REQUIRED/);
  assert.equal(executor.operationCalls.length, 0);

  const created = await submitSurfaceRuntimeIntent(
    view,
    formUrl,
    {
      confirmed: 'yes',
      intent: 'create',
      [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Authoritative read-back',
    },
    gateways,
  );
  assert.equal(created.statusCode, 200);
  assert.match(created.html, /Authoritative read-back/);
  assert.match(created.html, /name="confirmed" value="yes"/);
  assert.equal(queryCalls, 0);
  assert.equal(executor.operationCalls.length, 1);

  const createInput = asRecord(executor.operationCalls[0]!.input);
  const updated = await submitSurfaceRuntimeIntent(
    view,
    formUrl,
    {
      confirmed: 'yes',
      expectedRevision: '1',
      intent: 'update',
      recordId: String(createInput.recordId),
      [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Updated read-back',
    },
    gateways,
  );
  assert.equal(updated.statusCode, 200);
  assert.match(updated.html, /Updated read-back/);
  assert.equal(queryCalls, 0);
  assert.equal(executor.operationCalls.length, 2);
});

class RecordingPolicy implements CurrentPolicyGateway {
  readonly calls: CurrentPolicyDecisionRequest[] = [];

  constructor(private readonly decision: 'ALLOW' | 'DENY') {}

  async authorize(request: CurrentPolicyDecisionRequest) {
    this.calls.push(request);
    return {
      decision: this.decision,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'surface-binding-policy/v1',
    };
  }

  async readCurrentVersion(_subject: CurrentPolicySubject) {
    void _subject;
    return { policyVersion: 'surface-binding-policy/v1' };
  }
}

class InMemoryGenericExecutor
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  readonly operationCalls: SemanticOperationExecutionRequest[] = [];
  readonly queryCalls: SemanticQueryExecutionRequest[] = [];
  readonly trustFacts: Array<{
    readonly links: NonNullable<SemanticOperationResultEnvelope['trust']>;
    readonly tenantId: string;
  }> = [];
  private readonly recordsByTenant = new Map<
    string,
    Map<string, SemanticRecordDto>
  >();

  seed(tenantId: string, name: string): void {
    const recordId = randomUUID();
    this.tenantRecords(tenantId).set(
      recordId,
      record(recordId, name, FIXTURE_IDS.entityIds.parent),
    );
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
    return 'arguments' in request
      ? this.query(request)
      : this.operation(request);
  }

  private async query(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope> {
    this.queryCalls.push(request);
    const values = [...this.tenantRecords(request.context.tenantId).values()];
    const args = asRecord(request.arguments);
    const selected =
      request.definition.queryType === 'get'
        ? values.filter((entry) => entry.recordId === args.recordId)
        : values;
    const visible =
      args.includeArchived === true
        ? selected
        : selected.filter((entry) => !entry.archived);
    return {
      kind: 'semanticQueryResult',
      outcome:
        visible.length > 0 || request.definition.queryType === 'list'
          ? 'exact'
          : 'not-found',
      queryId: request.definition.queryId,
      records: visible,
      schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
      unsupportedReason: null,
    };
  }

  private async operation(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    this.operationCalls.push(request);
    const input = asRecord(request.input);
    const recordId = String(input.recordId);
    const tenantRecords = this.tenantRecords(request.context.tenantId);
    const previous = tenantRecords.get(recordId);
    const values = asRecord(input.values ?? input.patch ?? {});
    const stored = operationRecord(request, previous, recordId, values);
    tenantRecords.set(recordId, stored);
    const links = {
      changeDocumentId: randomUUID(),
      domainEventId: randomUUID(),
      invocationId: randomUUID(),
      outboxId: randomUUID(),
    };
    this.trustFacts.push({ links, tenantId: request.context.tenantId });
    return {
      kind: 'semanticOperationResult',
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: stored,
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      trust: links,
      unsupportedReason: null,
    };
  }

  private tenantRecords(tenantId: string): Map<string, SemanticRecordDto> {
    const existing = this.recordsByTenant.get(tenantId);
    if (existing) return existing;
    const created = new Map<string, SemanticRecordDto>();
    this.recordsByTenant.set(tenantId, created);
    return created;
  }
}

function semanticGateways(
  policy: CurrentPolicyGateway,
  executor: InMemoryGenericExecutor,
): SurfaceRuntimeGateways {
  return {
    operationGateway: new SemanticOperationGateway(policy, executor),
    queryGateway: new SemanticQueryGateway(policy, executor),
  };
}

function fixedQueryGateway(
  outcome: SemanticQueryResultEnvelope['outcome'],
  records: readonly SemanticRecordDto[],
): SurfaceRuntimeGateways['queryGateway'] {
  return new SemanticQueryGateway(new RecordingPolicy('ALLOW'), {
    async execute(request) {
      return {
        kind: 'semanticQueryResult',
        outcome,
        queryId: request.definition.queryId,
        records,
        schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
        unsupportedReason: outcome === 'unsupported' ? 'fixture' : null,
      };
    },
  });
}

function runtimeEntry(
  compiled: CompileSuccess,
  policy: CurrentPolicyGateway,
  identities: Readonly<Record<string, AuthenticatedIdentity>>,
): AuthenticatedRequestRuntimeEntryAdapter {
  return new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async (request) => {
      const token = request.headers?.authorization;
      return typeof token === 'string' ? (identities[token] ?? null) : null;
    }),
    {
      async load(context): Promise<LoadedRequestRuntimeDefinition> {
        return {
          environmentId: context.environmentId,
          pointer: { fence: 1, pointerId },
          projections: runtimeProjections(compiled),
          release: { contentHash: compiled.releaseRoot, releaseId },
          tenantId: context.tenantId,
        };
      },
    },
    policy,
  );
}

async function issuedView(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
  token: string,
): Promise<RequestRuntimeView> {
  return entry.run({ headers: { authorization: token } }, (view) => view);
}

function identity(
  tenantId: string,
  environmentId: string,
  principalId: string,
): AuthenticatedIdentity {
  return { environmentId, principalId, tenantId };
}

function record(
  recordId: string,
  name: string,
  entityId: string,
): SemanticRecordDto {
  return Object.freeze({
    archived: false,
    entityId,
    recordId,
    revision: 1,
    values: Object.freeze({ [FIXTURE_IDS.fieldIds.parentName]: name }),
  });
}

function operationRecord(
  request: SemanticOperationExecutionRequest,
  previous: SemanticRecordDto | undefined,
  recordId: string,
  values: Record<string, unknown>,
): SemanticRecordDto {
  const kind = request.definition.effect.kind;
  const nextValues =
    kind === 'createRecordEffect'
      ? values
      : { ...(previous?.values ?? {}), ...values };
  return Object.freeze({
    archived:
      kind === 'archiveRecordEffect'
        ? true
        : kind === 'restoreRecordEffect'
          ? false
          : (previous?.archived ?? false),
    entityId: request.definition.effect.entity.targetId,
    recordId,
    revision: (previous?.revision ?? 0) + 1,
    values: Object.freeze(nextValues as Record<string, ImmutableJsonValue>),
  });
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
  const manifestValue = decode(artifact(compiled, reference.artifactRoot));
  assert.ok(Array.isArray(manifestValue.chunks));
  const descriptor = manifestValue.chunks[0];
  assert.ok(isRecord(descriptor));
  assert.equal(typeof descriptor.contentHash, 'string');
  return {
    artifactRoot: reference.artifactRoot,
    familyId,
    instanceId: reference.instanceId,
    payload: decode(
      artifact(compiled, String(descriptor.contentHash)),
    ) as unknown as ImmutableJsonValue,
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
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

function decode(value: ContentAddressedArtifact): Record<string, unknown> {
  const decoded: unknown = JSON.parse(
    new TextDecoder().decode(value.canonicalBytes),
  );
  assert.ok(isRecord(decoded));
  return decoded;
}

function compileFixture(
  definition: Record<string, unknown> = ordinaryModuleV1(),
): CompileSuccess {
  const normalized = normalizeApplicationPackage(definition);
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

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function postIntent(
  baseUrl: string,
  surfaceId: string,
  submission: Record<string, string>,
): Promise<string> {
  const response = await fetch(
    `${baseUrl}/?surface=${encodeURIComponent(surfaceId)}`,
    {
      body: new URLSearchParams(submission),
      headers: {
        authorization: 'a',
        'content-type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    },
  );
  assert.equal(response.status, 200);
  return response.text();
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
