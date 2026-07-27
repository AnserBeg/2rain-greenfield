import assert from 'node:assert/strict';
import test from 'node:test';

import { renderSurfaceDataComponent } from '../../apps/web/src/component-registry.js';
import { sharedListView } from '../../apps/web/src/list-runtime.js';
import { readCompiledSurfaceManifest } from '../../apps/web/src/surface-contract.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SEMANTIC_QUERY_RESULT_VERSION,
  SemanticQueryGateway,
  SemanticQueryPolicyDeniedError,
  type SemanticQueryExecutionRequest,
  type SemanticQueryExecutor,
  type SemanticQueryResultEnvelope,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
} from '../../packages/runtime/src/request-context.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import {
  requireSharedListResult,
  SharedListContractError,
} from '../../packages/runtime/src/list-behavior/index.js';
import {
  compilePartyFixture,
  partyRuntimeProjections,
} from '../fixtures/g2/party/compiler.js';
import { PARTY_IDS } from '../fixtures/g2/party/definition.js';

const identity: AuthenticatedIdentity = {
  environmentId: 'c1000000-0000-4000-8000-000000000001',
  principalId: 'c1000000-0000-4000-8000-000000000002',
  tenantId: 'c1000000-0000-4000-8000-000000000003',
};

test('UI, Semantic Query, and agent consume the identical shared list result', async () => {
  const policy = new SelectivePolicy();
  const executor = new ObservedListExecutor();
  const { view } = await issuedPartyView(policy);
  const agentQueryId = (
    view.projections.agent.payload as {
      queries: Array<{ queryId: string }>;
    }
  ).queries.find(
    (query) => query.queryId === `${PARTY_IDS.namespace}:query.party_role_list`,
  )?.queryId;
  assert.ok(agentQueryId);
  const semanticQueryResult = await new SemanticQueryGateway(
    policy,
    executor,
  ).invoke(view, request(agentQueryId));
  const agentResult = semanticQueryResult;
  const uiView = sharedListView(semanticQueryResult);
  const shared = requireSharedListResult(semanticQueryResult);
  const surface = readCompiledSurfaceManifest(view).surfaces.find(
    (candidate) =>
      candidate.surfaceId === `${PARTY_IDS.namespace}:surface.party_role_list`,
  );
  assert.ok(surface);
  const uiHtml = renderSurfaceDataComponent({
    data: {
      records: semanticQueryResult.records,
      result: semanticQueryResult,
      status: 'READY',
    },
    feedback: null,
    operations: [],
    surface,
  });

  assert.strictEqual(agentResult, semanticQueryResult);
  assert.strictEqual(uiView.result, semanticQueryResult);
  assert.strictEqual(uiView.records, semanticQueryResult.records);
  assert.strictEqual(shared.records, semanticQueryResult.records);
  assert.strictEqual(uiView.listCoverage, semanticQueryResult.listCoverage);
  assert.equal(executor.executions, 1);
  assert.equal(semanticQueryResult.listCoverage?.returnedCount, 1);
  assert.match(uiHtml, /Authorized relation label/);
  assert.match(uiHtml, /data-list-coverage="1–1 of 1"/);
  assert.equal(
    semanticQueryResult.records[0]?.relationLabels?.[
      PARTY_IDS.relationIds.roleParty
    ]?.label,
    'Authorized relation label',
  );
});

test('relation-label search fails closed before execution when its field query is denied', async () => {
  const deniedPermission = `${PARTY_IDS.namespace}:permission.party_read`;
  const policy = new SelectivePolicy(deniedPermission);
  const executor = new ObservedListExecutor();
  const { view } = await issuedPartyView(policy);

  await assert.rejects(
    new SemanticQueryGateway(policy, executor).invoke(
      view,
      request(`${PARTY_IDS.namespace}:query.party_role_list`),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SemanticQueryPolicyDeniedError);
      assert.equal(error.queryId, `${PARTY_IDS.namespace}:query.party_list`);
      return true;
    },
  );
  assert.equal(executor.executions, 0);
  const denial = policy.calls.find(
    (call) => call.permissionId === deniedPermission,
  );
  assert.ok(denial);
  assert.deepEqual(denial.decisionInput, {
    arguments: {
      fieldId: PARTY_IDS.fieldIds.name,
      relationId: PARTY_IDS.relationIds.roleParty,
    },
    kind: 'registeredSemanticListRelationPolicyInput',
    queryId: `${PARTY_IDS.namespace}:query.party_list`,
    requestId: view.requestId,
    schemaVersion: 'northstar.semantic-query-policy-input/v1',
  });
});

test('list result coverage cannot pass when the executor omits it', async () => {
  const policy = new SelectivePolicy();
  const { view } = await issuedPartyView(policy);
  const executor: SemanticQueryExecutor = {
    async execute(request): Promise<SemanticQueryResultEnvelope> {
      return {
        kind: 'semanticQueryResult',
        outcome: 'exact',
        queryId: request.definition.queryId,
        records: [],
        schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
        unsupportedReason: null,
      };
    },
  };
  await assert.rejects(
    new SemanticQueryGateway(policy, executor).invoke(
      view,
      request(`${PARTY_IDS.namespace}:query.party_role_list`),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SharedListContractError);
      assert.equal(error.code, 'LIST_RESULT_MALFORMED');
      return true;
    },
  );
});

class ObservedListExecutor implements SemanticQueryExecutor {
  executions = 0;

  async execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope> {
    this.executions += 1;
    assert.ok(request.list);
    const query = request.list.query;
    const record = Object.freeze({
      archived: false,
      displayValues: Object.freeze({
        [PARTY_IDS.fieldIds.roleKind]: 'Customer',
        [PARTY_IDS.fieldIds.roleStatus]: 'Active',
      }),
      entityId: PARTY_IDS.entityIds.role,
      recordId: 'c1000000-0000-4000-8000-000000000004',
      relationLabels: Object.freeze({
        [PARTY_IDS.relationIds.roleParty]: Object.freeze({
          label: 'Authorized relation label',
          recordId: 'c1000000-0000-4000-8000-000000000005',
        }),
      }),
      revision: 1,
      values: Object.freeze({
        [PARTY_IDS.fieldIds.roleKind]: `${PARTY_IDS.namespace}:option.customer`,
        [PARTY_IDS.fieldIds.roleStatus]: `${PARTY_IDS.namespace}:option.active`,
      }),
    });
    return Object.freeze({
      kind: 'semanticQueryResult',
      outcome: 'exact',
      queryId: request.definition.queryId,
      records: Object.freeze([record]),
      schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
      listCoverage: Object.freeze({
        effectivePageSize: query.effectivePageSize,
        hasMore: false,
        includeArchived: query.includeArchived,
        matchMode: query.matchMode,
        nextCursor: null,
        pageOffset: 0,
        projectedSearchValueCount: 3,
        requestedPageSize: query.requestedPageSize,
        returnedCount: 1,
        schemaVersion: 'northstar.shared-list-result/v1',
        search: query.search,
        sort: query.sort,
        totalCount: 1,
        truncatedByMaximum: query.truncatedByMaximum,
      }),
      unsupportedReason: null,
    });
  }
}

class SelectivePolicy implements CurrentPolicyGateway {
  readonly calls: CurrentPolicyDecisionRequest[] = [];

  constructor(private readonly deniedPermission: string | null = null) {}

  async authorize(request: CurrentPolicyDecisionRequest) {
    this.calls.push(request);
    return {
      decision:
        request.permissionId === this.deniedPermission
          ? ('DENY' as const)
          : ('ALLOW' as const),
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'g2-p5a-policy/v1',
    };
  }

  async readCurrentVersion() {
    return { policyVersion: 'g2-p5a-policy/v1' };
  }
}

async function issuedPartyView(
  policy: CurrentPolicyGateway,
): Promise<{ readonly view: RequestRuntimeView }> {
  const compiled = compilePartyFixture().compiled;
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => identity),
    {
      async load(): Promise<LoadedRequestRuntimeDefinition> {
        return {
          environmentId: identity.environmentId,
          pointer: {
            fence: 1,
            pointerId: 'c1000000-0000-4000-8000-000000000006',
          },
          projections: partyRuntimeProjections(compiled),
          release: {
            contentHash: compiled.releaseRoot,
            releaseId: 'c1000000-0000-4000-8000-000000000007',
          },
          tenantId: identity.tenantId,
        };
      },
    },
    policy,
  );
  return entry.run({}, (view) => ({ view }));
}

function request(queryId: string): Record<string, unknown> {
  return {
    arguments: {
      includeArchived: false,
      list: {
        cursor: null,
        matchMode: 'substring',
        pageSize: 25,
        relationLabels: [
          {
            fieldId: PARTY_IDS.fieldIds.name,
            queryId: `${PARTY_IDS.namespace}:query.party_list`,
            relationId: PARTY_IDS.relationIds.roleParty,
          },
        ],
        schemaVersion: 'northstar.shared-list-query/v1',
        search: 'authorized',
        sort: [
          {
            direction: 'ascending',
            fieldId: PARTY_IDS.fieldIds.roleKind,
          },
        ],
      },
    },
    queryId,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  };
}
