import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { renderSurfaceRuntimeWithData } from '../../apps/web/src/surface-runtime.js';
import { unicodeCaseFold } from '../../packages/canonical-model/src/index.js';
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
  type SemanticRecordDto,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  type CurrentPolicyGateway,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import { PARTY_IDS } from '../fixtures/g2/party/definition.js';
import {
  compilePartyFixture,
  partyRuntimeProjections,
} from '../fixtures/g2/party/compiler.js';

const tenantA = '71000000-0000-4000-8000-000000000001';
const environmentA = '72000000-0000-4000-8000-000000000002';
const principalA = '73000000-0000-4000-8000-000000000003';
const tenantB = '81000000-0000-4000-8000-000000000001';
const environmentB = '82000000-0000-4000-8000-000000000002';
const principalB = '83000000-0000-4000-8000-000000000003';

test('Party definition serves one tenant-scoped DTO to query, agent, surface and operation read-back', async () => {
  const compiled = compilePartyFixture().compiled;
  const policy = allowPolicy();
  const executor = new PartyMemoryExecutor();
  const queryGateway = new SemanticQueryGateway(policy, executor);
  const operationGateway = new SemanticOperationGateway(policy, executor);
  const entry = runtimeEntry(compiled, policy);
  const viewA = await issuedView(entry, 'a');
  const viewB = await issuedView(entry, 'b');

  const created = await operationGateway.invoke(viewA, {
    input: {
      recordId: '74000000-0000-4000-8000-000000000004',
      values: partyValues('P-100', 'Northern Equipment', 'ops@example.test'),
    },
    operationId: `${PARTY_IDS.namespace}:operation.party_create`,
    schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
  });
  assert.equal(created.outcome, 'succeeded');
  assert.ok(created.readBack);

  const queryRead = await queryGateway.invoke(viewA, {
    arguments: { recordId: created.readBack.recordId },
    queryId: `${PARTY_IDS.namespace}:query.party_get`,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assert.deepEqual(queryRead.records[0], created.readBack);

  const agentPayload = viewA.projections.agent.payload as {
    queries: Array<{ queryId: string }>;
  };
  const agentQueryId = agentPayload.queries.find(
    (entry) => entry.queryId === `${PARTY_IDS.namespace}:query.party_get`,
  )?.queryId;
  assert.ok(agentQueryId);
  const agentRead = await queryGateway.invoke(viewA, {
    arguments: { recordId: created.readBack.recordId },
    queryId: agentQueryId,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assert.deepEqual(agentRead.records[0], created.readBack);

  const surface = await renderSurfaceRuntimeWithData(
    viewA,
    `http://party.test/?surface=${encodeURIComponent(`${PARTY_IDS.namespace}:surface.party_detail`)}&record=${created.readBack.recordId}`,
    { operationGateway, queryGateway },
  );
  assert.equal(surface.statusCode, 200);
  assert.match(surface.html, /Northern Equipment/);
  assert.match(surface.html, /P-100/);
  assert.match(surface.html, /ops@example\.test/);
  assert.doesNotMatch(surface.html, /north_star_module|storageClass|physical/i);

  const tenantBRead = await queryGateway.invoke(viewB, {
    arguments: { recordId: created.readBack.recordId },
    queryId: `${PARTY_IDS.namespace}:query.party_get`,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assert.equal(tenantBRead.outcome, 'not-found');
});

test('compiled resolver authority serves exact/ambiguous/not-found through the gateway', async () => {
  const compiled = compilePartyFixture().compiled;
  const policy = allowPolicy();
  const executor = new PartyMemoryExecutor();
  const gateway = new SemanticQueryGateway(policy, executor);
  const viewA = await issuedView(runtimeEntry(compiled, policy), 'a');
  const viewB = await issuedView(runtimeEntry(compiled, policy), 'b');
  executor.seed(
    tenantA,
    '74100000-0000-4000-8000-000000000001',
    'P-101',
    'Acme Rentals',
  );
  executor.seed(
    tenantA,
    '74100000-0000-4000-8000-000000000002',
    'P-102',
    'Acme Rentals',
  );
  executor.seed(
    tenantA,
    '74100000-0000-4000-8000-000000000003',
    'P-103',
    'Maximum Construction',
  );
  executor.seed(
    tenantB,
    '84100000-0000-4000-8000-000000000001',
    'B-900',
    'Hidden Party',
  );

  assert.equal((await resolveParty(gateway, viewA, 'P-101')).outcome, 'exact');
  assert.equal(
    (await resolveParty(gateway, viewA, 'Acme Rentals')).outcome,
    'ambiguous',
  );
  assert.equal(
    (await resolveParty(gateway, viewA, 'Maximum Construction')).outcome,
    'ambiguous',
  );
  assert.equal(
    (await resolveParty(gateway, viewA, 'Missing')).outcome,
    'not-found',
  );
  assert.equal(
    (await resolveParty(gateway, viewA, 'B-900')).outcome,
    'not-found',
  );
  assert.equal((await resolveParty(gateway, viewB, 'B-900')).outcome, 'exact');
});

function resolveParty(
  gateway: SemanticQueryGateway,
  view: RequestRuntimeView,
  text: string,
): Promise<SemanticQueryResultEnvelope> {
  return gateway.invoke(view, {
    arguments: { text },
    queryId: `${PARTY_IDS.namespace}:query.party_resolve`,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
}

class PartyMemoryExecutor
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  private readonly records = new Map<string, Map<string, SemanticRecordDto>>();

  seed(tenantId: string, recordId: string, number: string, name: string): void {
    this.tenantRecords(tenantId).set(
      recordId,
      dto(recordId, partyValues(number, name, '')),
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
  compiled: ReturnType<typeof compilePartyFixture>['compiled'],
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
          pointer: {
            fence: 1,
            pointerId: '75000000-0000-4000-8000-000000000005',
          },
          projections: partyRuntimeProjections(compiled),
          release: {
            contentHash: compiled.releaseRoot,
            releaseId: '76000000-0000-4000-8000-000000000006',
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
        policyVersion: 'party-policy/v1',
      };
    },
    async readCurrentVersion() {
      return { policyVersion: 'party-policy/v1' };
    },
  };
}

function partyValues(
  number: string,
  name: string,
  contactSummary: string,
): Record<string, string> {
  return {
    [PARTY_IDS.fieldIds.contactSummary]: contactSummary,
    [PARTY_IDS.fieldIds.name]: name,
    [PARTY_IDS.fieldIds.number]: number,
  };
}

function dto(
  recordId: string,
  values: Readonly<Record<string, unknown>>,
): SemanticRecordDto {
  return {
    archived: false,
    entityId: PARTY_IDS.entityIds.party,
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
