import {
  PREDICATE_LOWERING_PLAN_VERSION,
  PREDICATE_POSITION_PROFILE_VERSION,
  STRUCTURAL_LIMITS_V0,
  canonicalizeAndHash,
  inspectPredicateForExecution,
  type PredicateCostClass,
  type PredicateKernelReceipt,
  type PredicateLoweringPlan,
} from '@north-star/canonical-model';

import type { TrustedRequestContext } from './request-context.js';
import {
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  assertRequestRuntimeView,
  authorizeCurrentPolicy,
  trustedContextForRequestRuntimeView,
  type CurrentPolicyGateway,
  type ImmutableJsonValue,
} from './request-runtime-view.js';
import type { RequestRuntimeView as IssuedRequestRuntimeView } from './request-runtime-view.js';
import {
  authorizeSharedListFields,
  parseSharedListArguments,
  requireSharedListResult,
  SharedListContractError,
  type AuthorizedSharedListRequest,
  type SharedListCoverage,
} from './list-behavior/index.js';

export const SEMANTIC_QUERY_REQUEST_VERSION =
  'northstar.semantic-query-request/v1' as const;
export const SEMANTIC_QUERY_RESULT_VERSION =
  'northstar.semantic-query-result/v1' as const;

const QUERY_CATALOG_PAYLOAD_VERSION =
  'northstar.query-catalog-payload/v0-provisional' as const;
const QUERY_POLICY_INPUT_VERSION =
  'northstar.semantic-query-policy-input/v1' as const;
const QUERY_BOUNDARY_PERMISSION_ID =
  'northstar.runtime:permission.semantic-query-boundary' as const;
const canonicalIdPattern =
  /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export interface SemanticQueryRequestEnvelope {
  readonly arguments: ImmutableJsonValue;
  readonly queryId: string;
  readonly schemaVersion: typeof SEMANTIC_QUERY_REQUEST_VERSION;
}

export interface SemanticRecordDto {
  readonly archived: boolean;
  readonly displayValues?: Readonly<Record<string, string | null>>;
  readonly entityId: string;
  readonly recordId: string;
  readonly relationLabels?: Readonly<
    Record<
      string,
      Readonly<{
        label: string | null;
        recordId: string | null;
      }>
    >
  >;
  readonly revision: number;
  readonly values: Readonly<Record<string, ImmutableJsonValue>>;
}

export interface SemanticQueryResultEnvelope {
  readonly kind: 'semanticQueryResult';
  readonly outcome: 'ambiguous' | 'exact' | 'not-found' | 'unsupported';
  readonly queryId: string;
  readonly records: readonly SemanticRecordDto[];
  readonly schemaVersion: typeof SEMANTIC_QUERY_RESULT_VERSION;
  readonly listCoverage?: SharedListCoverage;
  readonly unsupportedReason: string | null;
}

export interface RegisteredQueryDefinition {
  readonly filter: Readonly<Record<string, ImmutableJsonValue>>;
  readonly filterPlan?: PredicateLoweringPlan;
  readonly infrastructure?: {
    readonly archive: 'nullableArchivedAt';
    readonly optimisticRevision: 'requiredOnMutation';
    readonly recordIdentity: 'canonicalUuid';
  };
  readonly lifecycle: 'active' | 'retired';
  readonly maximumResultCount: number;
  readonly permissionId: string;
  readonly queryId: string;
  readonly queryType: 'get' | 'list' | 'resolve' | 'search';
  readonly resolveMatchKeys?: readonly {
    readonly authority: 'advisory' | 'identifier';
    readonly fieldId: string;
    readonly matchKeyId: string;
    readonly orderKey: number;
  }[];
  readonly selections: readonly {
    readonly fieldId: string;
    readonly orderKey: number;
    readonly selectionId: string;
  }[];
  readonly sourceEntityId: string;
  readonly tier: 'q0' | 'q1';
}

export interface SemanticQueryExecutionRequest {
  readonly arguments: ImmutableJsonValue;
  readonly context: TrustedRequestContext;
  readonly definition: RegisteredQueryDefinition;
  readonly filterPlans: readonly PredicateLoweringPlan[];
  readonly list: AuthorizedSharedListRequest | null;
  readonly view: IssuedRequestRuntimeView;
}

export interface QueryPolicyNarrowingRequest {
  readonly arguments: ImmutableJsonValue;
  readonly definition: RegisteredQueryDefinition;
  readonly view: IssuedRequestRuntimeView;
}

/** A future policy authority may contribute only another validated narrowing. */
export interface QueryPolicyNarrowingGateway {
  narrow(request: QueryPolicyNarrowingRequest): Promise<unknown>;
}

export interface SemanticQueryExecutor {
  execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope>;
}

export class MalformedSemanticQueryRequestError extends Error {
  readonly code = 'MALFORMED_SEMANTIC_QUERY_REQUEST' as const;
  override readonly name = 'MalformedSemanticQueryRequestError';
}

export class MalformedPinnedQueryCatalogError extends Error {
  readonly code = 'MALFORMED_PINNED_QUERY_CATALOG' as const;
  override readonly name = 'MalformedPinnedQueryCatalogError';
}

export class MalformedQueryPolicyNarrowingError extends Error {
  readonly code = 'MALFORMED_QUERY_POLICY_NARROWING' as const;
  override readonly name = 'MalformedQueryPolicyNarrowingError';
}

export class SemanticQueryPolicyDeniedError extends Error {
  readonly code = 'SEMANTIC_QUERY_POLICY_DENIED' as const;
  override readonly name = 'SemanticQueryPolicyDeniedError';
  readonly pinnedReleaseContentHash: string;
  readonly pinnedReleaseId: string;
  readonly queryId: string;

  constructor(queryId: string, view: IssuedRequestRuntimeView) {
    super(
      `current policy denied query ${queryId} for pinned release ${view.release.releaseId}`,
    );
    this.queryId = queryId;
    this.pinnedReleaseContentHash = view.release.contentHash;
    this.pinnedReleaseId = view.release.releaseId;
  }
}

export class NoSuchRegisteredQueryError extends Error {
  readonly code = 'NO_SUCH_REGISTERED_QUERY' as const;
  override readonly name = 'NoSuchRegisteredQueryError';
  readonly pinnedReleaseContentHash: string;
  readonly pinnedReleaseId: string;
  readonly queryId: string;

  constructor(queryId: string, view: IssuedRequestRuntimeView) {
    super(
      `query ${queryId} is not registered in pinned release ${view.release.releaseId}`,
    );
    this.queryId = queryId;
    this.pinnedReleaseContentHash = view.release.contentHash;
    this.pinnedReleaseId = view.release.releaseId;
  }
}

/** Sole application read ingress for the request-pinned semantic contract. */
export class SemanticQueryGateway {
  constructor(
    private readonly currentPolicy: CurrentPolicyGateway,
    private readonly executor: SemanticQueryExecutor | undefined = undefined,
    private readonly observePredicateReceipt:
      ((receipt: PredicateKernelReceipt) => void) | undefined = undefined,
    private readonly policyNarrowing:
      QueryPolicyNarrowingGateway | undefined = undefined,
  ) {}

  async invoke(
    view: IssuedRequestRuntimeView,
    requestInput: unknown,
  ): Promise<SemanticQueryResultEnvelope> {
    assertRequestRuntimeView(view);
    const request = parseSemanticQueryRequest(requestInput);
    const boundaryDecision = await authorizeCurrentPolicy(
      this.currentPolicy,
      view,
      QUERY_BOUNDARY_PERMISSION_ID,
      Object.freeze({
        arguments: request.arguments,
        kind: 'semanticQueryPolicyInput',
        queryId: request.queryId,
        requestId: view.requestId,
        schemaVersion: QUERY_POLICY_INPUT_VERSION,
      }),
    );
    if (boundaryDecision.decision === 'DENY') {
      throw new SemanticQueryPolicyDeniedError(request.queryId, view);
    }

    const definition = registeredQueryFromPinnedView(view, request.queryId);
    if (!definition || !this.executor) {
      throw new NoSuchRegisteredQueryError(request.queryId, view);
    }
    const queryDecision = await authorizeCurrentPolicy(
      this.currentPolicy,
      view,
      definition.permissionId,
      Object.freeze({
        arguments: request.arguments,
        kind: 'registeredSemanticQueryPolicyInput',
        queryId: request.queryId,
        requestId: view.requestId,
        schemaVersion: QUERY_POLICY_INPUT_VERSION,
      }),
    );
    if (queryDecision.decision === 'DENY') {
      throw new SemanticQueryPolicyDeniedError(request.queryId, view);
    }
    if (definition.lifecycle !== 'active') {
      return unsupportedQueryResult(request.queryId, 'query-tier-unsupported');
    }
    const filterPlans: PredicateLoweringPlan[] = [];
    if (definition.tier === 'q0') {
      const predicateReceipt = inspectPredicateForExecution(definition.filter);
      observePredicateReceiptSafely(
        this.observePredicateReceipt,
        predicateReceipt,
      );
      if (predicateReceipt.outcome !== 'accepted') {
        return unsupportedQueryResult(
          request.queryId,
          'query-filter-unsupported',
        );
      }
    } else {
      if (!definition.filterPlan) {
        return unsupportedQueryResult(
          request.queryId,
          'query-filter-unsupported',
        );
      }
      filterPlans.push(definition.filterPlan);
    }
    if (this.policyNarrowing) {
      const contributed = await this.policyNarrowing.narrow(
        Object.freeze({
          arguments: request.arguments,
          definition,
          view,
        }),
      );
      filterPlans.push(parsePolicyNarrowing(contributed));
    }
    const listQuery = parseSharedListArguments(request.arguments, {
      maximumResultCount: definition.maximumResultCount,
      queryId: definition.queryId,
    });
    if (listQuery && definition.queryType !== 'list') {
      throw new SharedListContractError(
        'LIST_INPUT_MALFORMED',
        'shared list arguments belong only to a registered list query',
        definition.queryId,
      );
    }
    const list = listQuery
      ? await authorizeSharedListProjection(
          this.currentPolicy,
          view,
          definition,
          listQuery,
          this.observePredicateReceipt,
        )
      : null;
    if (listQuery && !list) {
      return unsupportedQueryResult(
        request.queryId,
        'query-filter-unsupported',
      );
    }
    const result = await this.executor.execute(
      Object.freeze({
        arguments: request.arguments,
        context: trustedContextForRequestRuntimeView(view),
        definition,
        filterPlans: Object.freeze(filterPlans),
        list,
        view,
      }),
    );
    if (list) requireSharedListResult(result);
    return result;
  }
}

async function authorizeSharedListProjection(
  currentPolicy: CurrentPolicyGateway,
  view: IssuedRequestRuntimeView,
  sourceDefinition: RegisteredQueryDefinition,
  query: NonNullable<ReturnType<typeof parseSharedListArguments>>,
  observePredicateReceipt:
    ((receipt: PredicateKernelReceipt) => void) | undefined,
): Promise<AuthorizedSharedListRequest | null> {
  authorizeSharedListFields(query, {
    selectedFieldIds: new Set(
      sourceDefinition.selections.map((selection) => selection.fieldId),
    ),
  });
  const relationLabels = [];
  for (const relation of query.relationLabels) {
    const targetDefinition = registeredQueryFromPinnedView(
      view,
      relation.queryId,
    );
    if (
      !targetDefinition ||
      targetDefinition.lifecycle !== 'active' ||
      targetDefinition.tier !== 'q0' ||
      targetDefinition.queryType !== 'list' ||
      !targetDefinition.selections.some(
        (selection) => selection.fieldId === relation.fieldId,
      )
    ) {
      throw new SharedListContractError(
        'LIST_FIELD_NOT_AUTHORIZED',
        'relation label must use a selected field from an active pinned list query',
        relation.fieldId,
      );
    }
    const decision = await authorizeCurrentPolicy(
      currentPolicy,
      view,
      targetDefinition.permissionId,
      Object.freeze({
        arguments: Object.freeze({
          fieldId: relation.fieldId,
          relationId: relation.relationId,
        }),
        kind: 'registeredSemanticListRelationPolicyInput',
        queryId: targetDefinition.queryId,
        requestId: view.requestId,
        schemaVersion: QUERY_POLICY_INPUT_VERSION,
      }),
    );
    if (decision.decision === 'DENY') {
      throw new SemanticQueryPolicyDeniedError(targetDefinition.queryId, view);
    }
    const predicateReceipt = inspectPredicateForExecution(
      targetDefinition.filter,
    );
    observePredicateReceiptSafely(observePredicateReceipt, predicateReceipt);
    if (predicateReceipt.outcome !== 'accepted') return null;
    relationLabels.push(
      Object.freeze({
        ...relation,
        targetEntityId: targetDefinition.sourceEntityId,
      }),
    );
  }
  return Object.freeze({
    query,
    relationLabels: Object.freeze(relationLabels),
  });
}

export function observePredicateReceiptSafely(
  observer: ((receipt: PredicateKernelReceipt) => void) | undefined,
  receipt: PredicateKernelReceipt,
): void {
  try {
    observer?.(receipt);
  } catch {
    // Observation is evidence only; it must never become execution authority.
  }
}

function parseSemanticQueryRequest(
  value: unknown,
): SemanticQueryRequestEnvelope {
  if (!isRecord(value)) {
    throw new MalformedSemanticQueryRequestError(
      'semantic query request must be an object',
    );
  }
  assertExactKeys(
    value,
    ['arguments', 'queryId', 'schemaVersion'],
    (message) => new MalformedSemanticQueryRequestError(message),
  );
  if (value.schemaVersion !== SEMANTIC_QUERY_REQUEST_VERSION) {
    throw new MalformedSemanticQueryRequestError(
      'semantic query request version is not supported',
    );
  }
  assertCanonicalId(
    value.queryId,
    'queryId',
    (message) => new MalformedSemanticQueryRequestError(message),
  );
  return Object.freeze({
    arguments: cloneImmutableJson(
      value.arguments,
      '$.arguments',
      (message) => new MalformedSemanticQueryRequestError(message),
    ),
    queryId: value.queryId,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
}

export function registeredQueryFromPinnedView(
  view: IssuedRequestRuntimeView,
  queryId: string,
): RegisteredQueryDefinition | undefined {
  const projection = view.projections.query;
  if (
    projection.familyId !== REQUEST_RUNTIME_PROJECTION_FAMILIES.query ||
    projection.payloadSchemaVersion !== QUERY_CATALOG_PAYLOAD_VERSION
  ) {
    throw new MalformedPinnedQueryCatalogError(
      'pinned query projection has an invalid family or version',
    );
  }
  const payload = projection.payload;
  if (!isRecord(payload)) {
    throw new MalformedPinnedQueryCatalogError(
      'pinned query catalog must be an object',
    );
  }
  assertExactKeys(
    payload,
    ['kind', 'queries', 'schemaVersion'],
    (message) => new MalformedPinnedQueryCatalogError(message),
  );
  if (
    payload.kind !== 'queryCatalogPayload' ||
    payload.schemaVersion !== QUERY_CATALOG_PAYLOAD_VERSION ||
    !Array.isArray(payload.queries)
  ) {
    throw new MalformedPinnedQueryCatalogError(
      'pinned query catalog has an invalid kind, version, or shape',
    );
  }
  const queryIds = new Set<string>();
  let selected: RegisteredQueryDefinition | undefined;
  for (const query of payload.queries) {
    assertQueryDefinition(query);
    if (queryIds.has(query.queryId)) {
      throw new MalformedPinnedQueryCatalogError(
        'pinned query catalog contains a duplicate queryId',
      );
    }
    queryIds.add(query.queryId);
    if (query.queryId === queryId) selected = query;
  }
  return selected;
}

function assertQueryDefinition(
  value: unknown,
): asserts value is RegisteredQueryDefinition {
  const invalid = (message: string): MalformedPinnedQueryCatalogError =>
    new MalformedPinnedQueryCatalogError(message);
  if (!isRecord(value)) {
    throw invalid('pinned query definition must be an object');
  }
  const expectedKeys = [
    'filter',
    'lifecycle',
    'maximumResultCount',
    'permissionId',
    'queryId',
    'queryType',
    'selections',
    'sourceEntityId',
    'tier',
  ];
  const hasFilterPlan = Object.hasOwn(value, 'filterPlan');
  const hasInfrastructure = Object.hasOwn(value, 'infrastructure');
  const hasResolveMatchKeys = Object.hasOwn(value, 'resolveMatchKeys');
  assertExactKeys(
    value,
    [
      ...expectedKeys,
      ...(hasFilterPlan ? ['filterPlan'] : []),
      ...(hasInfrastructure ? ['infrastructure'] : []),
      ...(hasResolveMatchKeys ? ['resolveMatchKeys'] : []),
    ],
    invalid,
  );
  assertCanonicalId(value.queryId, 'queryId', invalid);
  assertCanonicalId(value.permissionId, 'permissionId', invalid);
  assertCanonicalId(value.sourceEntityId, 'sourceEntityId', invalid);
  if (
    (value.lifecycle !== 'active' && value.lifecycle !== 'retired') ||
    (value.queryType !== 'get' &&
      value.queryType !== 'list' &&
      value.queryType !== 'resolve' &&
      value.queryType !== 'search') ||
    (value.tier !== 'q0' && value.tier !== 'q1') ||
    !Number.isSafeInteger(value.maximumResultCount) ||
    Number(value.maximumResultCount) < 1 ||
    !isRecord(value.filter) ||
    !Array.isArray(value.selections) ||
    (hasResolveMatchKeys && !Array.isArray(value.resolveMatchKeys))
  ) {
    throw invalid('pinned query definition has an invalid shape');
  }
  if (value.tier === 'q1') {
    if (!hasFilterPlan) {
      throw invalid('q1 query requires a predicate lowering plan');
    }
    assertPredicateLoweringPlan(value.filterPlan, value.filter, invalid);
  } else if (hasFilterPlan) {
    throw invalid('q0 query cannot carry a predicate lowering plan');
  }
  if (value.queryType === 'search' && !hasInfrastructure) {
    throw invalid('search requires the v1 infrastructure contract');
  }
  if (
    value.queryType === 'resolve' &&
    (!Array.isArray(value.resolveMatchKeys) ||
      value.resolveMatchKeys.length === 0)
  ) {
    throw invalid('resolve requires explicit match authority');
  }
  if (
    value.queryType !== 'resolve' &&
    Array.isArray(value.resolveMatchKeys) &&
    value.resolveMatchKeys.length > 0
  ) {
    throw invalid('resolve match authority belongs only to resolve queries');
  }
  if (hasInfrastructure) {
    if (!isRecord(value.infrastructure)) {
      throw invalid('pinned query infrastructure must be an object');
    }
    assertExactKeys(
      value.infrastructure,
      ['archive', 'optimisticRevision', 'recordIdentity'],
      invalid,
    );
    if (
      value.infrastructure.archive !== 'nullableArchivedAt' ||
      value.infrastructure.optimisticRevision !== 'requiredOnMutation' ||
      value.infrastructure.recordIdentity !== 'canonicalUuid'
    ) {
      throw invalid('pinned query infrastructure is unsupported');
    }
  }
  for (const selection of value.selections) {
    if (!isRecord(selection)) {
      throw invalid('pinned query selection must be an object');
    }
    assertExactKeys(selection, ['fieldId', 'orderKey', 'selectionId'], invalid);
    assertCanonicalId(selection.fieldId, 'fieldId', invalid);
    assertCanonicalId(selection.selectionId, 'selectionId', invalid);
    if (
      !Number.isSafeInteger(selection.orderKey) ||
      Number(selection.orderKey) < 0 ||
      Number(selection.orderKey) > 1_000_000
    ) {
      throw invalid('pinned query selection has an invalid orderKey');
    }
  }
  const matchKeyIds = new Set<string>();
  const matchFieldIds = new Set<string>();
  for (const matchKey of Array.isArray(value.resolveMatchKeys)
    ? value.resolveMatchKeys
    : []) {
    if (!isRecord(matchKey)) {
      throw invalid('pinned resolve match key must be an object');
    }
    assertExactKeys(
      matchKey,
      ['authority', 'fieldId', 'matchKeyId', 'orderKey'],
      invalid,
    );
    assertCanonicalId(matchKey.fieldId, 'fieldId', invalid);
    assertCanonicalId(matchKey.matchKeyId, 'matchKeyId', invalid);
    if (
      (matchKey.authority !== 'identifier' &&
        matchKey.authority !== 'advisory') ||
      !Number.isSafeInteger(matchKey.orderKey) ||
      Number(matchKey.orderKey) < 0 ||
      Number(matchKey.orderKey) > 1_000_000
    ) {
      throw invalid('pinned resolve match key has an invalid shape');
    }
    if (
      matchKeyIds.has(matchKey.matchKeyId) ||
      matchFieldIds.has(matchKey.fieldId)
    ) {
      throw invalid('pinned resolve match authority contains duplicates');
    }
    matchKeyIds.add(matchKey.matchKeyId);
    matchFieldIds.add(matchKey.fieldId);
  }
}

function parsePolicyNarrowing(value: unknown): PredicateLoweringPlan {
  const invalid = (message: string): MalformedQueryPolicyNarrowingError =>
    new MalformedQueryPolicyNarrowingError(message);
  const cloned = cloneImmutableJson(value, '$.policyNarrowing', invalid);
  if (!isRecord(cloned)) {
    throw invalid('policy narrowing must be an object');
  }
  assertExactKeys(cloned, ['filter', 'filterPlan'], invalid);
  if (!isRecord(cloned.filter)) {
    throw invalid('policy narrowing filter must be an object');
  }
  assertPredicateLoweringPlan(cloned.filterPlan, cloned.filter, invalid);
  return cloned.filterPlan as unknown as PredicateLoweringPlan;
}

function assertPredicateLoweringPlan(
  value: unknown,
  predicate: Readonly<Record<string, unknown>>,
  error: (message: string) => Error,
): asserts value is PredicateLoweringPlan {
  if (!isRecord(value)) {
    throw error('predicate lowering plan must be an object');
  }
  assertExactKeys(
    value,
    [
      'costClass',
      'kind',
      'positionProfileVersion',
      'predicateDigest',
      'root',
      'schemaVersion',
    ],
    error,
  );
  if (
    value.kind !== 'predicateLoweringPlan' ||
    value.schemaVersion !== PREDICATE_LOWERING_PLAN_VERSION ||
    value.positionProfileVersion !== PREDICATE_POSITION_PROFILE_VERSION ||
    typeof value.predicateDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.predicateDigest) ||
    value.predicateDigest !== canonicalizeAndHash(predicate).contentHash
  ) {
    throw error('predicate lowering plan identity is invalid');
  }
  const predicateReceipt = inspectPredicateForExecution(predicate, {
    bindingPosition: 'queryFilter',
    resolveComparison: () => ({ presence: 'absent' }),
  });
  if (predicateReceipt.outcome !== 'evaluated') {
    throw error('predicate lowering input is invalid');
  }
  const observed = inspectLoweringNode(value.root, 1, error);
  assertLoweringMatchesPredicate(value.root, predicate, error);
  const expectedCost =
    isRecord(value.root) &&
    value.root.kind === 'fieldComparisonPredicate' &&
    observed.comparisonCosts.length > 0 &&
    observed.comparisonCosts.every(
      (costClass) => costClass === 'indexedFoldedEquality',
    )
      ? 'indexedFoldedEquality'
      : 'tenantBoundedScan';
  if (value.costClass !== expectedCost) {
    throw error('predicate lowering plan cost class is invalid');
  }
}

function assertLoweringMatchesPredicate(
  value: unknown,
  predicate: unknown,
  error: (message: string) => Error,
): void {
  if (
    !isRecord(value) ||
    !isRecord(predicate) ||
    value.kind !== predicate.kind
  ) {
    throw error('predicate lowering plan does not match its predicate');
  }
  switch (predicate.kind) {
    case 'booleanPredicate':
      if (value.value !== predicate.value) {
        throw error('predicate Boolean lowering does not match its predicate');
      }
      return;
    case 'fieldComparisonPredicate':
      if (
        !isRecord(predicate.field) ||
        !isRecord(predicate.value) ||
        value.fieldId !== predicate.field.targetId ||
        value.operator !== predicate.operator ||
        !isRecord(value.value) ||
        canonicalizeAndHash(value.value).contentHash !==
          canonicalizeAndHash(predicate.value).contentHash
      ) {
        throw error(
          'predicate comparison lowering does not match its predicate',
        );
      }
      return;
    case 'notPredicate':
      assertLoweringMatchesPredicate(value.term, predicate.term, error);
      return;
    case 'allPredicate':
    case 'anyPredicate':
      if (
        !Array.isArray(value.terms) ||
        !Array.isArray(predicate.terms) ||
        value.terms.length !== predicate.terms.length
      ) {
        throw error('predicate Boolean lowering does not match its predicate');
      }
      for (let index = 0; index < predicate.terms.length; index += 1) {
        assertLoweringMatchesPredicate(
          value.terms[index],
          predicate.terms[index]!,
          error,
        );
      }
  }
}

function inspectLoweringNode(
  value: unknown,
  depth: number,
  error: (message: string) => Error,
): Readonly<{
  comparisonCosts: PredicateCostClass[];
}> {
  if (depth > STRUCTURAL_LIMITS_V0.maximumExpressionDepth) {
    throw error('predicate lowering plan exceeds the expression depth limit');
  }
  if (!isRecord(value)) {
    throw error('predicate lowering node must be an object');
  }
  switch (value.kind) {
    case 'booleanPredicate':
      assertExactKeys(value, ['kind', 'value'], error);
      if (typeof value.value !== 'boolean') {
        throw error('predicate Boolean lowering is invalid');
      }
      return { comparisonCosts: [] };
    case 'fieldComparisonPredicate': {
      assertExactKeys(
        value,
        [
          'comparisonMode',
          'costClass',
          'fieldId',
          'kind',
          'loweringRowId',
          'operator',
          'value',
        ],
        error,
      );
      assertCanonicalId(value.fieldId, 'fieldId', error);
      if (
        !isRecord(value.value) ||
        !['equals', 'notEquals', 'lessThan', 'greaterThan'].includes(
          String(value.operator),
        )
      ) {
        throw error('predicate comparison lowering is invalid');
      }
      const folded =
        value.loweringRowId ===
          'northstar.predicate-lowering/folded-equality-v1' &&
        value.comparisonMode === 'unicodeCaseFold' &&
        value.operator === 'equals' &&
        value.costClass === 'indexedFoldedEquality';
      const bounded =
        value.loweringRowId ===
          'northstar.predicate-lowering/tenant-scan-comparison-v1' &&
        (value.comparisonMode === 'binary' ||
          value.comparisonMode === 'unicodeCaseFold') &&
        value.costClass === 'tenantBoundedScan';
      if (!folded && !bounded) {
        throw error('predicate comparison lowering row is not admitted');
      }
      return {
        comparisonCosts: [value.costClass as PredicateCostClass],
      };
    }
    case 'notPredicate': {
      assertExactKeys(value, ['kind', 'term'], error);
      return inspectLoweringNode(value.term, depth + 1, error);
    }
    case 'allPredicate':
    case 'anyPredicate': {
      assertExactKeys(value, ['kind', 'terms'], error);
      if (!Array.isArray(value.terms)) {
        throw error('predicate Boolean terms must be an array');
      }
      const terms = value.terms.map((term) =>
        inspectLoweringNode(term, depth + 1, error),
      );
      return {
        comparisonCosts: terms.flatMap((term) => term.comparisonCosts),
      };
    }
    default:
      throw error('predicate lowering node kind is not admitted');
  }
}

function unsupportedQueryResult(
  queryId: string,
  reason: string,
): SemanticQueryResultEnvelope {
  return Object.freeze({
    kind: 'semanticQueryResult',
    outcome: 'unsupported',
    queryId,
    records: Object.freeze([]),
    schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
    unsupportedReason: reason,
  });
}

function assertCanonicalId(
  value: unknown,
  name: string,
  error: (message: string) => Error,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 5 ||
    value.length > 180 ||
    !canonicalIdPattern.test(value)
  ) {
    throw error(`${name} must be a canonical ID`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  error: (message: string) => Error,
): void {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (actualKeys.join('\0') !== expectedKeys.join('\0')) {
    throw error('object keys do not match the closed contract');
  }
}

function cloneImmutableJson(
  value: unknown,
  path: string,
  error: (message: string) => Error,
): ImmutableJsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry, index) =>
        cloneImmutableJson(entry, `${path}[${index}]`, error),
      ),
    );
  }
  if (isRecord(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          cloneImmutableJson(entry, `${path}.${key}`, error),
        ]),
      ),
    );
  }
  throw error(`${path} must contain only immutable JSON values`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
