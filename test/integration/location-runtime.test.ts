import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { renderSurfaceRuntimeWithData } from '../../apps/web/src/surface-runtime.js';
import { unicodeCaseFold } from '../../packages/canonical-model/src/index.js';
import { LOCATION_IDS } from '../../packages/domain/src/location/index.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
} from '../../packages/runtime/src/request-context.js';
import { resolveByName } from '../../packages/runtime/src/resolve-by-name.js';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SEMANTIC_OPERATION_RESULT_VERSION,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationNonAcceptedRequest,
  type SemanticOperationResultEnvelope,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
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
  type CurrentPolicyGateway,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import {
  compileLocationFixture,
  locationRuntimeProjections,
} from '../fixtures/g2/location/compiler.js';

const tenantA = 'a1000000-0000-4000-8000-000000000001';
const environmentA = 'a2000000-0000-4000-8000-000000000002';
const principalA = 'a3000000-0000-4000-8000-000000000003';
const tenantB = 'b1000000-0000-4000-8000-000000000001';
const environmentB = 'b2000000-0000-4000-8000-000000000002';
const principalB = 'b3000000-0000-4000-8000-000000000003';
const warehouseType = `${LOCATION_IDS.namespace}:option.warehouse`;

test('Location serves one tenant-scoped location DTO to query, agent, surface, and operation read-back', async () => {
  const compiled = compileLocationFixture().compiled;
  const policy = allowPolicy();
  const executor = new LocationMemoryExecutor();
  const queryGateway = new SemanticQueryGateway(policy, executor);
  const operationMediation = new SemanticOperationMediationAuthority();
  const operationGateway = new SemanticOperationGateway(
    policy,
    executor,
    operationMediation,
  );
  const entry = runtimeEntry(compiled, policy);
  const viewA = await issuedView(entry, 'a');
  const viewB = await issuedView(entry, 'b');

  const before = await queryGateway.invoke(viewA, {
    arguments: { limit: 100 },
    queryId: `${LOCATION_IDS.namespace}:query.location_list`,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assert.deepEqual(
    before.records,
    [],
    'negative control requires empty pre-state',
  );

  const created = await operationGateway.invoke(
    viewA,
    {
      confirmationGrant: null,
      idempotencyKey: randomUUID(),
      input: {
        recordId: 'a4000000-0000-4000-8000-000000000004',
        values: locationValues('LOC-100', 'North Warehouse', warehouseType),
      },
      operationId: `${LOCATION_IDS.namespace}:operation.location_create`,
      schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
    },
    operationMediation.issueInvocation(viewA, 'API'),
  );
  assert.equal(created.outcome, 'succeeded');
  assert.ok(created.readBack);

  const queryRead = await queryGateway.invoke(viewA, {
    arguments: { recordId: created.readBack.recordId },
    queryId: `${LOCATION_IDS.namespace}:query.location_get`,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assert.deepEqual(queryRead.records, [created.readBack]);

  const agentQueryId = (
    viewA.projections.agent.payload as { queries: Array<{ queryId: string }> }
  ).queries.find(
    (query) => query.queryId === `${LOCATION_IDS.namespace}:query.location_get`,
  )?.queryId;
  assert.ok(agentQueryId);
  const agentRead = await queryGateway.invoke(viewA, {
    arguments: { recordId: created.readBack.recordId },
    queryId: agentQueryId,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assert.deepEqual(agentRead.records, [created.readBack]);

  const surface = await renderSurfaceRuntimeWithData(
    viewA,
    `http://location.test/?surface=${encodeURIComponent(`${LOCATION_IDS.namespace}:surface.location_detail`)}&record=${created.readBack.recordId}`,
    { operationGateway, operationMediation, queryGateway },
  );
  assert.equal(surface.statusCode, 200);
  assert.match(surface.html, /North Warehouse/);
  assert.match(surface.html, /LOC-100/);
  assert.match(surface.html, /northstar\.location:option\.warehouse/);
  assert.doesNotMatch(surface.html, /north_star_module|storageClass|physical/i);

  const tenantBRead = await queryGateway.invoke(viewB, {
    arguments: { recordId: created.readBack.recordId },
    queryId: `${LOCATION_IDS.namespace}:query.location_get`,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assert.equal(tenantBRead.outcome, 'not-found');
  assert.deepEqual(tenantBRead.records, []);
});

test('Location resolver preserves identifier authority and advisory ambiguity', async () => {
  const compiled = compileLocationFixture().compiled;
  const policy = allowPolicy();
  const executor = new LocationMemoryExecutor();
  const gateway = new SemanticQueryGateway(policy, executor);
  const viewA = await issuedView(runtimeEntry(compiled, policy), 'a');
  const viewB = await issuedView(runtimeEntry(compiled, policy), 'b');
  executor.seed(tenantA, randomUUID(), 'LOC-101', 'North Warehouse');
  executor.seed(tenantA, randomUUID(), 'LOC-102', 'North Warehouse');
  executor.seed(tenantA, randomUUID(), 'LOC-103', 'South Store');
  executor.seed(tenantA, randomUUID(), 'LOC-104', 'LOC-103');
  executor.seed(tenantB, randomUUID(), 'LOC-HIDDEN', 'Hidden location');

  assert.equal(
    (await resolveLocation(gateway, viewA, 'LOC-101')).outcome,
    'exact',
  );
  assert.equal(
    (await resolveLocation(gateway, viewA, 'North Warehouse')).outcome,
    'ambiguous',
  );
  assert.equal(
    (await resolveLocation(gateway, viewA, 'South Store')).outcome,
    'ambiguous',
  );
  assert.equal(
    (await resolveLocation(gateway, viewA, 'Noth Warehous')).outcome,
    'ambiguous',
  );
  assert.equal(
    (await resolveLocation(gateway, viewA, 'LOC-103')).outcome,
    'ambiguous',
  );
  assert.equal(
    (await resolveLocation(gateway, viewA, 'Missing')).outcome,
    'not-found',
  );
  assert.equal(
    (await resolveLocation(gateway, viewA, 'LOC-HIDDEN')).outcome,
    'not-found',
  );
  assert.equal(
    (await resolveLocation(gateway, viewB, 'LOC-HIDDEN')).outcome,
    'exact',
  );
});

function resolveLocation(
  gateway: SemanticQueryGateway,
  view: RequestRuntimeView,
  text: string,
): Promise<SemanticQueryResultEnvelope> {
  return resolveByName(
    gateway,
    view,
    {
      exactIdentifierFieldIds: [LOCATION_IDS.fieldIds.code],
      listQueryId: `${LOCATION_IDS.namespace}:query.location_list`,
      nameFieldIds: [LOCATION_IDS.fieldIds.name],
      resolveQueryId: `${LOCATION_IDS.namespace}:query.location_resolve`,
    },
    text,
  );
}

class LocationMemoryExecutor
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  private readonly records = new Map<string, Map<string, SemanticRecordDto>>();

  async recordNonAccepted(
    _request: SemanticOperationNonAcceptedRequest,
  ): Promise<void> {
    void _request;
  }

  seed(tenantId: string, recordId: string, code: string, name: string): void {
    this.tenantRecords(tenantId).set(
      recordId,
      dto(recordId, locationValues(code, name, warehouseType)),
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
    if ('arguments' in request) return this.query(request);
    const input = asRecord(request.input);
    const recordId = String(input.recordId);
    const record = dto(recordId, asRecord(input.values));
    this.tenantRecords(request.context.tenantId).set(recordId, record);
    return {
      kind: 'semanticOperationResult',
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: record,
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      trust: {
        changeDocumentId: randomUUID(),
        domainEventId: randomUUID(),
        invocationId: randomUUID(),
        outboxId: randomUUID(),
      },
      unsupportedReason: null,
    };
  }

  private query(
    request: SemanticQueryExecutionRequest,
  ): SemanticQueryResultEnvelope {
    const args = asRecord(request.arguments);
    const visible = [...this.tenantRecords(request.context.tenantId).values()];
    let records: SemanticRecordDto[];
    let outcome: SemanticQueryResultEnvelope['outcome'] | undefined;
    switch (request.definition.queryType) {
      case 'get':
        records = visible.filter((record) => record.recordId === args.recordId);
        break;
      case 'resolve': {
        const folded = unicodeCaseFold(String(args.text ?? ''));
        const matches = (authority: 'advisory' | 'identifier') =>
          visible.filter((record) =>
            (request.definition.resolveMatchKeys ?? [])
              .filter((key) => key.authority === authority)
              .some(
                (key) =>
                  unicodeCaseFold(String(record.values[key.fieldId] ?? '')) ===
                  folded,
              ),
          );
        const identifiers = matches('identifier');
        const advisory = matches('advisory');
        records = [
          ...new Map(
            [...identifiers, ...advisory].map((record) => [
              record.recordId,
              record,
            ]),
          ).values(),
        ];
        outcome =
          records.length === 0
            ? 'not-found'
            : identifiers.length === 1 && advisory.length === 0
              ? 'exact'
              : 'ambiguous';
        break;
      }
      case 'list':
      case 'search':
        records = visible;
        break;
    }
    return {
      kind: 'semanticQueryResult',
      outcome:
        outcome ??
        (request.definition.queryType === 'list' ||
        request.definition.queryType === 'search'
          ? 'exact'
          : records.length === 0
            ? 'not-found'
            : records.length === 1
              ? 'exact'
              : 'ambiguous'),
      queryId: request.definition.queryId,
      records,
      schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
      unsupportedReason: null,
    };
  }

  private tenantRecords(tenantId: string): Map<string, SemanticRecordDto> {
    let records = this.records.get(tenantId);
    if (!records) {
      records = new Map();
      this.records.set(tenantId, records);
    }
    return records;
  }
}

function runtimeEntry(
  compiled: ReturnType<typeof compileLocationFixture>['compiled'],
  policy: CurrentPolicyGateway,
): AuthenticatedRequestRuntimeEntryAdapter {
  const identities: Record<string, AuthenticatedIdentity> = {
    a: {
      environmentId: environmentA,
      principalId: principalA,
      tenantId: tenantA,
    },
    b: {
      environmentId: environmentB,
      principalId: principalB,
      tenantId: tenantB,
    },
  };
  return new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async (request) => {
      const token = request.headers?.authorization;
      return typeof token === 'string' ? (identities[token] ?? null) : null;
    }),
    {
      async load(context): Promise<LoadedRequestRuntimeDefinition> {
        return {
          environmentId: context.environmentId,
          pointer: { fence: 1, pointerId: randomUUID() },
          projections: locationRuntimeProjections(compiled),
          release: {
            contentHash: compiled.releaseRoot,
            releaseId: randomUUID(),
          },
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

function allowPolicy(): CurrentPolicyGateway {
  return {
    async authorize() {
      return {
        decision: 'ALLOW',
        decisionVersion: CURRENT_POLICY_DECISION_VERSION,
        policyVersion: 'location-policy/v1',
      };
    },
    async readCurrentVersion() {
      return { policyVersion: 'location-policy/v1' };
    },
  };
}

function locationValues(
  code: string,
  name: string,
  locationType: string,
): Record<string, string> {
  return {
    [LOCATION_IDS.fieldIds.locationType]: locationType,
    [LOCATION_IDS.fieldIds.name]: name,
    [LOCATION_IDS.fieldIds.code]: code,
  };
}

function dto(
  recordId: string,
  values: Readonly<Record<string, unknown>>,
): SemanticRecordDto {
  return {
    archived: false,
    entityId: LOCATION_IDS.entityIds.location,
    recordId,
    revision: 1,
    values: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, String(value)]),
    ),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.ok(value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
