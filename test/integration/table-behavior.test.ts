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
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import {
  authorizeSharedListFields,
  encodeSharedListCursor,
  parseSharedListArguments,
  requireSharedListEcho,
  requireSharedListResult,
  SharedListContractError,
  type SharedListCoverage,
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

test('relation-label target predicates pass through the kernel before execution', async () => {
  const policy = new SelectivePolicy();
  const executor = new ObservedListExecutor();
  const { view } = await issuedPartyView(policy, (projections) =>
    withQueryFilter(projections, `${PARTY_IDS.namespace}:query.party_list`, {
      kind: 'booleanPredicate',
      schemaVersion: queryFilterVersion(
        projections,
        `${PARTY_IDS.namespace}:query.party_list`,
      ),
      value: false,
    }),
  );
  const predicateOutcomes: string[] = [];

  const result = await new SemanticQueryGateway(policy, executor, (receipt) =>
    predicateOutcomes.push(receipt.outcome),
  ).invoke(view, request(`${PARTY_IDS.namespace}:query.party_role_list`));

  assert.deepEqual(
    { outcome: result.outcome, reason: result.unsupportedReason },
    { outcome: 'unsupported', reason: 'query-filter-unsupported' },
  );
  assert.deepEqual(predicateOutcomes, ['accepted', 'rejected']);
  assert.equal(executor.executions, 0);
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

const PARTY_LIST = `${PARTY_IDS.namespace}:query.party_list`;
const ROLE_LIST = `${PARTY_IDS.namespace}:query.party_role_list`;
/** A progress argument over the party fixture's own lists (the gateway view). */
const partyProgress = {
  done: {
    fieldId: PARTY_IDS.fieldIds.name,
    queryId: PARTY_LIST,
    relationId: PARTY_IDS.relationIds.roleParty,
  },
  lines: {
    fieldId: PARTY_IDS.fieldIds.name,
    queryId: PARTY_LIST,
    relationId: PARTY_IDS.relationIds.roleParty,
  },
  outputs: {
    done: `${PARTY_IDS.namespace}:list_output.fixture_done`,
    open: `${PARTY_IDS.namespace}:list_output.fixture_open`,
    ordered: `${PARTY_IDS.namespace}:list_output.fixture_ordered`,
  },
} as const;
const today = '2026-09-29T00:00:00.000Z';

test('additional List progress is cursor-bound and re-authorized independently', async () => {
  const extra = {
    ...partyProgress.done,
    queryId: ROLE_LIST,
    fieldId: PARTY_IDS.fieldIds.roleKind,
    fieldFilters: [
      {
        fieldId: PARTY_IDS.fieldIds.roleStatus,
        value: `${PARTY_IDS.namespace}:option.active`,
      },
    ],
    output: `${PARTY_IDS.namespace}:list_output.extra`,
  };
  const progress = { ...partyProgress, additionalDone: extra };
  const parsed = parseSharedListArguments(
    listArguments({ progress }),
    parseInput,
  )!;
  assert.deepEqual(parsed.progress, progress);
  const cursor = encodeSharedListCursor(ROLE_LIST, parsed, 25);
  assert.throws(
    () =>
      parseSharedListArguments(
        listArguments({
          cursor,
          progress: {
            ...progress,
            additionalDone: {
              ...extra,
              fieldFilters: [{ ...extra.fieldFilters[0]!, value: 'revoked' }],
            },
          },
        }),
        parseInput,
      ),
    refusedWith('LIST_CURSOR_INVALID'),
  );
  const policy: CurrentPolicyGateway = {
    async authorize(call) {
      const input = call.decisionInput as {
        kind?: string;
        arguments?: { fieldId?: string };
      };
      return {
        decision:
          input.kind === 'registeredSemanticListProgressPolicyInput' &&
          input.arguments?.fieldId === extra.fieldId
            ? 'DENY'
            : 'ALLOW',
        decisionVersion: CURRENT_POLICY_DECISION_VERSION,
        policyVersion: 'additional-progress/v1',
      };
    },
    async readCurrentVersion() {
      return { policyVersion: 'additional-progress/v1' };
    },
  };
  const { view } = await issuedPartyView(policy);
  const executor = new ObservedListExecutor();
  await assert.rejects(
    new SemanticQueryGateway(policy, executor).invoke(view, {
      ...request(ROLE_LIST),
      arguments: listArguments({ progress }),
    }),
    (error) =>
      error instanceof SemanticQueryPolicyDeniedError &&
      error.queryId === ROLE_LIST,
  );
  assert.equal(executor.executions, 0);
});
const listArguments = (list: Record<string, ImmutableJsonValue>) =>
  ({
    includeArchived: false,
    list: {
      cursor: null,
      matchMode: 'substring',
      pageSize: 25,
      relationLabels: [],
      schemaVersion: 'northstar.shared-list-query/v1',
      search: '',
      sort: [],
      ...list,
    },
  }) as unknown as ImmutableJsonValue;
const parseInput = {
  declaredParameterIds: [],
  maximumResultCount: 100,
  queryId: ROLE_LIST,
};
const refusedWith =
  (code: SharedListContractError['code']) => (error: unknown) =>
    error instanceof SharedListContractError && error.code === code;

test('list progress and before filters are closed arguments bound into the cursor', () => {
  const before = [{ before: today, fieldId: PARTY_IDS.fieldIds.roleKind }];
  const parsed = parseSharedListArguments(
    listArguments({
      progress: { ...partyProgress, openOnly: true },
      beforeFilters: before,
    }),
    parseInput,
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.progress, { ...partyProgress, openOnly: true });
  assert.deepEqual(parsed.beforeFilters, before);
  // Absent, the request's shape is exactly what it was before.
  const plain = parseSharedListArguments(listArguments({}), parseInput)!;
  assert.equal('progress' in plain, false);
  assert.equal('beforeFilters' in plain, false);

  for (const [name, list] of [
    ['unknown progress key', { progress: { ...partyProgress, sum: true } }],
    ['openOnly false', { progress: { ...partyProgress, openOnly: false } }],
    [
      'repeated output id',
      {
        progress: {
          ...partyProgress,
          outputs: {
            ...partyProgress.outputs,
            open: partyProgress.outputs.done,
          },
        },
      },
    ],
    [
      'unknown source key',
      {
        progress: {
          ...partyProgress,
          lines: { ...partyProgress.lines, archived: true },
        },
      },
    ],
    [
      'local wall time',
      {
        beforeFilters: [
          {
            before: '2026-09-29T00:00:00',
            fieldId: PARTY_IDS.fieldIds.roleKind,
          },
        ],
      },
    ],
    [
      'non-canonical instant',
      {
        beforeFilters: [
          {
            before: '2026-09-29T00:00:00Z',
            fieldId: PARTY_IDS.fieldIds.roleKind,
          },
        ],
      },
    ],
    ['empty before filters', { beforeFilters: [] }],
  ] as const)
    assert.throws(
      () =>
        parseSharedListArguments(
          listArguments(list as unknown as Record<string, ImmutableJsonValue>),
          parseInput,
        ),
      refusedWith('LIST_INPUT_MALFORMED'),
      name,
    );

  // A window minted for today's open orders pages exactly that shape: not
  // another day's "before today", and not the set without the open filter.
  const cursor = encodeSharedListCursor(ROLE_LIST, parsed, 25);
  assert.equal(
    parseSharedListArguments(
      listArguments({
        cursor,
        progress: { ...partyProgress, openOnly: true },
        beforeFilters: before,
      }),
      parseInput,
    )?.pageOffset,
    25,
  );
  for (const list of [
    {
      cursor,
      progress: { ...partyProgress, openOnly: true },
      beforeFilters: [{ ...before[0]!, before: '2026-09-30T00:00:00.000Z' }],
    },
    { cursor, progress: partyProgress, beforeFilters: before },
    { cursor, beforeFilters: before },
  ])
    assert.throws(
      () =>
        parseSharedListArguments(
          listArguments(list as unknown as Record<string, ImmutableJsonValue>),
          parseInput,
        ),
      refusedWith('LIST_CURSOR_INVALID'),
    );

  // Compared fields are selected ones; figures shadow nothing projected.
  const selected = new Set([PARTY_IDS.fieldIds.roleKind]);
  assert.throws(
    () =>
      authorizeSharedListFields(
        parseSharedListArguments(
          listArguments({
            beforeFilters: [
              { before: today, fieldId: PARTY_IDS.fieldIds.name },
            ],
          }),
          parseInput,
        )!,
        { selectedFieldIds: selected },
      ),
    refusedWith('LIST_FIELD_NOT_AUTHORIZED'),
  );
  assert.throws(
    () =>
      authorizeSharedListFields(
        parseSharedListArguments(
          listArguments({
            progress: {
              ...partyProgress,
              outputs: {
                ...partyProgress.outputs,
                open: PARTY_IDS.fieldIds.roleKind,
              },
            },
          }),
          parseInput,
        )!,
        { selectedFieldIds: selected },
      ),
    refusedWith('LIST_FIELD_NOT_AUTHORIZED'),
  );

  // The executor must report both back unchanged.
  const coverage = {
    effectivePageSize: 25,
    hasMore: false,
    includeArchived: false,
    matchMode: 'substring',
    nextCursor: null,
    pageOffset: 0,
    parentScope: null,
    projectedSearchValueCount: 0,
    requestedPageSize: 25,
    returnedCount: 0,
    schemaVersion: 'northstar.shared-list-result/v1',
    search: '',
    sort: [],
    totalCount: 0,
    truncatedByMaximum: false,
  } as const satisfies SharedListCoverage;
  requireSharedListEcho(parsed, {
    ...coverage,
    progress: parsed.progress!,
    beforeFilters: parsed.beforeFilters!,
  });
  requireSharedListEcho(plain, coverage);
  for (const echoed of [
    coverage,
    { ...coverage, progress: parsed.progress! },
    {
      ...coverage,
      progress: partyProgress,
      beforeFilters: parsed.beforeFilters!,
    },
    {
      ...coverage,
      progress: parsed.progress!,
      beforeFilters: [{ ...before[0]!, before: '2026-09-28T00:00:00.000Z' }],
    },
  ])
    assert.throws(
      () => requireSharedListEcho(parsed, echoed),
      refusedWith('LIST_RESULT_MALFORMED'),
    );
});

test('each list progress read passes current policy and a denial names the progress query', async () => {
  const request = (list: Record<string, ImmutableJsonValue>) => ({
    arguments: listArguments(list),
    queryId: ROLE_LIST,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  const denied = new SelectivePolicy(
    `${PARTY_IDS.namespace}:permission.party_read`,
  );
  const executor = new ObservedListExecutor();
  const { view } = await issuedPartyView(denied);
  await assert.rejects(
    new SemanticQueryGateway(denied, executor).invoke(
      view,
      request({ progress: partyProgress }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SemanticQueryPolicyDeniedError);
      assert.equal(error.queryId, PARTY_LIST);
      return true;
    },
  );
  assert.equal(executor.executions, 0);
  assert.deepEqual(
    denied.calls
      .filter(
        (call) =>
          (call.decisionInput as { kind?: string }).kind ===
          'registeredSemanticListProgressPolicyInput',
      )
      .map((call) => call.permissionId),
    [`${PARTY_IDS.namespace}:permission.party_read`],
  );

  // Allowed, an executor that ignores the progress or the before filter
  // cannot pass its answer off as the narrowed set.
  const allowed = new SelectivePolicy();
  const { view: allowedView } = await issuedPartyView(allowed);
  for (const list of [
    { progress: partyProgress },
    {
      beforeFilters: [{ before: today, fieldId: PARTY_IDS.fieldIds.roleKind }],
    },
  ])
    await assert.rejects(
      new SemanticQueryGateway(allowed, new ObservedListExecutor()).invoke(
        allowedView,
        request(list as unknown as Record<string, ImmutableJsonValue>),
      ),
      refusedWith('LIST_RESULT_MALFORMED'),
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
        parentScope: null,
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
  transform: (
    projections: LoadedRequestRuntimeDefinition['projections'],
  ) => LoadedRequestRuntimeDefinition['projections'] = (projections) =>
    projections,
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
          projections: transform(partyRuntimeProjections(compiled)),
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

function withQueryFilter(
  projections: LoadedRequestRuntimeDefinition['projections'],
  queryId: string,
  filter: ImmutableJsonValue,
): LoadedRequestRuntimeDefinition['projections'] {
  const payload = projections.query.payload;
  assert.ok(isRecord(payload));
  const queries = payload.queries;
  assert.ok(Array.isArray(queries));
  let matched = 0;
  const updated = queries.map((query) => {
    assert.ok(isRecord(query));
    if (query.queryId !== queryId) return query;
    matched += 1;
    return { ...query, filter };
  });
  assert.equal(matched, 1);
  return {
    ...projections,
    query: {
      ...projections.query,
      payload: { ...payload, queries: updated },
    },
  };
}

function queryFilterVersion(
  projections: LoadedRequestRuntimeDefinition['projections'],
  queryId: string,
): string {
  const payload = projections.query.payload;
  assert.ok(isRecord(payload));
  const queries = payload.queries;
  assert.ok(Array.isArray(queries));
  const query = queries.find(
    (candidate) => isRecord(candidate) && candidate.queryId === queryId,
  );
  assert.ok(isRecord(query));
  const filter = query.filter;
  if (filter === undefined) assert.fail('query filter is absent');
  assert.ok(isRecord(filter));
  const schemaVersion = filter.schemaVersion;
  if (typeof schemaVersion !== 'string') {
    assert.fail('query filter schemaVersion is absent');
  }
  return schemaVersion;
}

function isRecord(
  value: ImmutableJsonValue,
): value is Readonly<Record<string, ImmutableJsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
