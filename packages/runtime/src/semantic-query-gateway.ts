import {
  FieldTypeSchema,
  PARAMETERIZED_PREDICATE_LOWERING_PLAN_VERSION,
  PREDICATE_LOWERING_PLAN_VERSION,
  PREDICATE_POSITION_PROFILE_VERSION,
  QUERY_AGGREGATE_LOWERING_PLAN_VERSION,
  LEGAL_ENTITY_SCOPE_CONTRACT_V1,
  LEGAL_ENTITY_SCOPE_PROFILE_VERSION,
  SUPPORTED_LANGUAGE_VERSIONS,
  STRUCTURAL_LIMITS_V0,
  VersionedPredicateExpressionSchema,
  canonicalizeAndHash,
  evaluateLegalEntityScopeSelection,
  inspectPredicateForExecution,
  languageHasV3Features,
  type CanonicalLanguageVersion,
  type LegalEntityScopeCardinality,
  type PredicateCostClass,
  type PredicateKernelReceipt,
  type QueryAggregateLoweringPlan,
  type QueryFilterLoweringPlan,
} from '@north-star/canonical-model';

import type { TrustedRequestContext } from './request-context.js';
import {
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  assertRequestRuntimeView,
  authorizeCurrentPolicy,
  trustedContextForRequestRuntimeView,
  issueLegalEntityReadScope,
  verifyLegalEntityReadScope,
  type CurrentPolicyGateway,
  type ImmutableJsonValue,
  type LegalEntityReadScope,
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
export const SEMANTIC_AGGREGATE_RESULT_VERSION =
  'northstar.semantic-aggregate-result/v1' as const;

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

export interface SemanticAggregateResultEnvelope {
  readonly kind: 'semanticAggregateResult';
  readonly outcome: 'exact';
  readonly queryId: string;
  readonly schemaVersion: typeof SEMANTIC_AGGREGATE_RESULT_VERSION;
  readonly value:
    | Readonly<{
        kind: 'exactDecimalResult';
        precision: 38;
        scale: number;
        selectionId: string;
        value: string;
      }>
    | Readonly<{
        baseUnitId: string;
        kind: 'quantityResult';
        precision: 38;
        scale: number;
        selectionId: string;
        value: string;
      }>;
}

interface RegisteredQueryParameterDefinition {
  readonly orderKey: number;
  readonly parameterId: string;
  readonly parameterType: Readonly<Record<string, ImmutableJsonValue>>;
}

interface RegisteredQueryAggregateSelection {
  readonly fieldId: string;
  readonly measureFieldType: Readonly<Record<string, ImmutableJsonValue>>;
  readonly operator: 'sum';
  readonly resultType: Readonly<Record<string, ImmutableJsonValue>>;
  readonly selectionId: string;
}

export interface RegisteredLegalEntityScope {
  readonly cardinality: LegalEntityScopeCardinality;
  readonly kind: 'queryLegalEntityScope';
  readonly operand: {
    readonly kind: 'queryParameterReference';
    readonly parameterId: string;
    readonly schemaVersion: 'v4';
  };
  readonly schemaVersion: 'v4';
}

interface RegisteredQueryDefinitionBase {
  readonly filter: Readonly<Record<string, ImmutableJsonValue>>;
  readonly legalEntityScope?: RegisteredLegalEntityScope;
  readonly filterPlan?: QueryFilterLoweringPlan;
  readonly lifecycle: 'active' | 'retired';
  readonly maximumResultCount: number;
  readonly permissionId: string;
  readonly queryId: string;
  readonly sourceEntityId: string;
  readonly tier: 'q0' | 'q1';
}

export interface RegisteredQueryDefinition extends RegisteredQueryDefinitionBase {
  readonly parameters?: readonly RegisteredQueryParameterDefinition[];
  readonly infrastructure?: {
    readonly archive: 'nullableArchivedAt';
    readonly optimisticRevision: 'requiredOnMutation';
    readonly recordIdentity: 'canonicalUuid';
  };
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
}

export interface RegisteredAggregateQueryDefinition extends RegisteredQueryDefinitionBase {
  readonly aggregate: RegisteredQueryAggregateSelection;
  readonly aggregatePlan: QueryAggregateLoweringPlan;
  readonly filterPlan: QueryFilterLoweringPlan;
  readonly maximumResultCount: 1;
  readonly parameters: readonly RegisteredQueryParameterDefinition[];
  readonly queryType: 'aggregate';
  readonly resultContract: Readonly<Record<string, ImmutableJsonValue>>;
  readonly tier: 'q1';
}

export type RegisteredSemanticQueryDefinition =
  RegisteredAggregateQueryDefinition | RegisteredQueryDefinition;

export interface SemanticQueryExecutionContext {
  readonly legalEntityReadScope?: LegalEntityReadScope;
}

export interface SemanticQueryExecutionRequest {
  readonly arguments: ImmutableJsonValue;
  readonly context: TrustedRequestContext;
  readonly definition: RegisteredQueryDefinition;
  readonly filterPlans: readonly QueryFilterLoweringPlan[];
  readonly legalEntityReadScope: LegalEntityReadScope | null;
  readonly list: AuthorizedSharedListRequest | null;
  readonly parameterValues: Readonly<Record<string, ImmutableJsonValue>>;
  readonly view: IssuedRequestRuntimeView;
}

export interface SemanticAggregateQueryExecutionRequest {
  readonly arguments: ImmutableJsonValue;
  readonly context: TrustedRequestContext;
  readonly definition: RegisteredAggregateQueryDefinition;
  readonly filterPlans: readonly QueryFilterLoweringPlan[];
  readonly legalEntityReadScope: LegalEntityReadScope | null;
  readonly list: AuthorizedSharedListRequest | null;
  readonly parameterValues: Readonly<Record<string, ImmutableJsonValue>>;
  readonly view: IssuedRequestRuntimeView;
}

export interface QueryPolicyNarrowingRequest {
  readonly arguments: ImmutableJsonValue;
  readonly definition: RegisteredSemanticQueryDefinition;
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
  executeAggregate?(
    request: SemanticAggregateQueryExecutionRequest,
  ): Promise<SemanticAggregateResultEnvelope>;
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

export class UnsupportedSemanticAggregateQueryError extends Error {
  readonly code = 'SEMANTIC_AGGREGATE_UNSUPPORTED' as const;
  override readonly name = 'UnsupportedSemanticAggregateQueryError';
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
    executionContext: SemanticQueryExecutionContext = Object.freeze({}),
  ): Promise<SemanticQueryResultEnvelope> {
    const result = await this.#invoke(
      view,
      requestInput,
      'records',
      executionContext,
    );
    if (result.kind !== 'semanticQueryResult') {
      throw new MalformedPinnedQueryCatalogError(
        'record query returned an aggregate result',
      );
    }
    return result;
  }

  async invokeAggregate(
    view: IssuedRequestRuntimeView,
    requestInput: unknown,
    executionContext: SemanticQueryExecutionContext = Object.freeze({}),
  ): Promise<SemanticAggregateResultEnvelope> {
    const result = await this.#invoke(
      view,
      requestInput,
      'aggregate',
      executionContext,
    );
    if (result.kind !== 'semanticAggregateResult') {
      throw new MalformedPinnedQueryCatalogError(
        'aggregate query returned a record result',
      );
    }
    return result;
  }

  async #invoke(
    view: IssuedRequestRuntimeView,
    requestInput: unknown,
    expectedResult: 'aggregate' | 'records',
    executionContext: SemanticQueryExecutionContext,
  ): Promise<SemanticAggregateResultEnvelope | SemanticQueryResultEnvelope> {
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

    const definition = registeredSemanticQueryFromPinnedView(
      view,
      request.queryId,
    );
    if (!definition || !this.executor) {
      throw new NoSuchRegisteredQueryError(request.queryId, view);
    }
    if (
      (expectedResult === 'aggregate') !==
      (definition.queryType === 'aggregate')
    ) {
      throw new MalformedSemanticQueryRequestError(
        'query result shape does not match the selected gateway method',
      );
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
    // The operand is part of the REQUEST contract, so it is validated before
    // any branch that can return an `unsupported` envelope. Issuance stays
    // below, next to execution. Validating late let a retired or
    // unsupported-filter query answer `unsupported` to a malformed operand,
    // which breaks ADR-0031's typed-omission probe: verification would read
    // that envelope as "the query is fine".
    const declaredScope = definition.legalEntityScope;
    if (declaredScope && executionContext.legalEntityReadScope !== undefined) {
      throw new MalformedSemanticQueryRequestError(
        'query declares a legal-entity operand and cannot also take an issued scope',
      );
    }
    const scopeSelection = declaredScope
      ? acceptedLegalEntityScopeSelection(
          definition,
          declaredScope,
          request.arguments,
        )
      : null;
    if (definition.lifecycle !== 'active') {
      if (definition.queryType === 'aggregate') {
        throw new UnsupportedSemanticAggregateQueryError(
          'aggregate query is not active',
        );
      }
      return unsupportedQueryResult(request.queryId, 'query-tier-unsupported');
    }
    const filterPlans: QueryFilterLoweringPlan[] = [];
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
    const list =
      listQuery && definition.queryType === 'list'
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
    const parameterValues = bindQueryParameters(definition, request.arguments);
    // One authority per query: the declared operand or a supplied capability,
    // never both. The conflict is refused above, with the validation.
    const legalEntityReadScope = scopeSelection
      ? await issueLegalEntityReadScope(
          this.currentPolicy,
          view,
          scopeSelection,
        )
      : executionContext.legalEntityReadScope === undefined
        ? null
        : await verifyLegalEntityReadScope(
            this.currentPolicy,
            executionContext.legalEntityReadScope,
            view,
            definition.sourceEntityId,
          );
    let result: SemanticAggregateResultEnvelope | SemanticQueryResultEnvelope;
    if (definition.queryType === 'aggregate') {
      if (!this.executor.executeAggregate) {
        throw new UnsupportedSemanticAggregateQueryError(
          'query executor does not implement aggregate execution',
        );
      }
      result = await this.executor.executeAggregate(
        Object.freeze({
          arguments: request.arguments,
          context: trustedContextForRequestRuntimeView(view),
          definition,
          filterPlans: Object.freeze(filterPlans),
          legalEntityReadScope,
          list: null,
          parameterValues,
          view,
        }),
      );
    } else {
      result = await this.executor.execute(
        Object.freeze({
          arguments: request.arguments,
          context: trustedContextForRequestRuntimeView(view),
          definition,
          filterPlans: Object.freeze(filterPlans),
          legalEntityReadScope,
          list,
          parameterValues,
          view,
        }),
      );
    }
    if (list) {
      if (result.kind !== 'semanticQueryResult') {
        throw new SharedListContractError(
          'LIST_RESULT_MALFORMED',
          'shared list query returned an aggregate result',
          definition.queryId,
        );
      }
      requireSharedListResult(result);
    }
    if (
      result.kind === 'semanticAggregateResult' &&
      definition.queryType === 'aggregate'
    ) {
      requireSemanticAggregateResult(definition, result);
    }
    return result;
  }
}

/**
 * Rules the caller's ordinary query argument against the query's declared
 * cardinality, returning the members an issued capability may carry.
 *
 * The caller supplies an untrusted UUID or nonempty UUID array under the
 * declared parameter id and never touches the capability, which is why the
 * two-argument API adapter carries this without a new transport. The canonical
 * kernel is the single authority on what the selection means; issuance
 * authorizes it per member against live policy. Every failure is a refusal:
 * an unreadable operand must never become a narrower scope, a wider scope, or
 * tenant-wide execution.
 */
function acceptedLegalEntityScopeSelection(
  definition: RegisteredSemanticQueryDefinition,
  declaredScope: RegisteredLegalEntityScope,
  argumentsValue: ImmutableJsonValue,
): readonly string[] {
  const receipt = evaluateLegalEntityScopeSelection({
    cardinality: declaredScope.cardinality,
    profileVersion: LEGAL_ENTITY_SCOPE_PROFILE_VERSION,
    selection: isRecord(argumentsValue)
      ? argumentsValue[declaredScope.operand.parameterId]
      : undefined,
  });
  if (receipt.outcome !== 'accepted') {
    throw new MalformedLegalEntityScopeArgumentError(
      definition.queryId,
      receipt.reason,
    );
  }
  return receipt.members;
}

/** Refused before any executor runs, so an unreadable operand never executes. */
export class MalformedLegalEntityScopeArgumentError extends Error {
  readonly code = 'SEMANTIC_QUERY_LEGAL_ENTITY_SCOPE_INVALID' as const;
  override readonly name = 'MalformedLegalEntityScopeArgumentError';
  readonly reason: string;

  constructor(queryId: string, reason: string) {
    super(`legal-entity scope argument for query ${queryId} is ${reason}`);
    this.reason = reason;
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
  const definition = registeredSemanticQueryFromPinnedView(view, queryId);
  return definition?.queryType === 'aggregate' ? undefined : definition;
}

function registeredSemanticQueryFromPinnedView(
  view: IssuedRequestRuntimeView,
  queryId: string,
): RegisteredSemanticQueryDefinition | undefined {
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
  let selected: RegisteredSemanticQueryDefinition | undefined;
  for (const query of payload.queries) {
    const definition = parseQueryDefinition(query);
    if (queryIds.has(definition.queryId)) {
      throw new MalformedPinnedQueryCatalogError(
        'pinned query catalog contains a duplicate queryId',
      );
    }
    queryIds.add(definition.queryId);
    if (definition.queryId === queryId) selected = definition;
  }
  return selected;
}

function parseQueryDefinition(
  value: unknown,
): RegisteredSemanticQueryDefinition {
  const invalid = (message: string): MalformedPinnedQueryCatalogError =>
    new MalformedPinnedQueryCatalogError(message);
  if (!isRecord(value)) {
    throw invalid('pinned query definition must be an object');
  }
  const aggregate = value.queryType === 'aggregate';
  const expectedKeys = [
    ...(aggregate
      ? ['aggregate', 'aggregatePlan', 'parameters', 'resultContract']
      : ['selections']),
    'filter',
    'lifecycle',
    'maximumResultCount',
    'permissionId',
    'queryId',
    'queryType',
    'sourceEntityId',
    'tier',
  ];
  const hasLegalEntityScope = Object.hasOwn(value, 'legalEntityScope');
  const hasParameters = !aggregate && Object.hasOwn(value, 'parameters');
  const hasFilterPlan = Object.hasOwn(value, 'filterPlan');
  const hasInfrastructure = Object.hasOwn(value, 'infrastructure');
  const hasResolveMatchKeys = Object.hasOwn(value, 'resolveMatchKeys');
  assertExactKeys(
    value,
    [
      ...expectedKeys,
      ...(hasLegalEntityScope ? ['legalEntityScope'] : []),
      ...(hasParameters ? ['parameters'] : []),
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
    (value.queryType !== 'aggregate' &&
      value.queryType !== 'get' &&
      value.queryType !== 'list' &&
      value.queryType !== 'resolve' &&
      value.queryType !== 'search') ||
    (value.tier !== 'q0' && value.tier !== 'q1') ||
    !Number.isSafeInteger(value.maximumResultCount) ||
    Number(value.maximumResultCount) < 1 ||
    !isRecord(value.filter) ||
    (!aggregate && !Array.isArray(value.selections)) ||
    (hasResolveMatchKeys && !Array.isArray(value.resolveMatchKeys))
  ) {
    throw invalid('pinned query definition has an invalid shape');
  }
  if (value.tier === 'q1') {
    if (!hasFilterPlan) {
      throw invalid('q1 query requires a predicate lowering plan');
    }
    assertPredicateLoweringPlan(
      value.filterPlan,
      value.filter,
      invalid,
      aggregate,
    );
  } else if (hasFilterPlan) {
    throw invalid('q0 query cannot carry a predicate lowering plan');
  }
  if (hasParameters) {
    assertRowQueryParameters(value.parameters, invalid);
  }
  if (hasLegalEntityScope) {
    assertLegalEntityScopeContract(value.legalEntityScope, value, invalid);
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
  if (aggregate) {
    assertAggregateQueryDefinition(value, invalid);
    return Object.freeze(
      value as unknown as RegisteredAggregateQueryDefinition,
    );
  }
  for (const selection of value.selections as unknown[]) {
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
  return value as unknown as RegisteredQueryDefinition;
}

function assertAggregateQueryDefinition(
  value: Record<string, unknown>,
  invalid: (message: string) => Error,
): void {
  if (
    value.tier !== 'q1' ||
    value.maximumResultCount !== 1 ||
    !isRecord(value.aggregate) ||
    !isRecord(value.aggregatePlan) ||
    !Array.isArray(value.parameters) ||
    !isRecord(value.resultContract) ||
    Object.hasOwn(value, 'infrastructure') ||
    Object.hasOwn(value, 'resolveMatchKeys')
  ) {
    throw invalid('aggregate query definition has an invalid shape');
  }
  assertExactKeys(
    value.aggregate,
    ['fieldId', 'measureFieldType', 'operator', 'resultType', 'selectionId'],
    invalid,
  );
  assertCanonicalId(value.aggregate.fieldId, 'aggregate.fieldId', invalid);
  assertCanonicalId(
    value.aggregate.selectionId,
    'aggregate.selectionId',
    invalid,
  );
  if (
    value.aggregate.operator !== 'sum' ||
    !isRecord(value.aggregate.measureFieldType) ||
    FieldTypeSchema.safeParse(value.aggregate.measureFieldType).success ===
      false ||
    !isRecord(value.aggregate.resultType)
  ) {
    throw invalid('aggregate query selection is invalid');
  }
  const aggregateNodeVersion = requiredAggregateNodeVersion(
    value.aggregate.measureFieldType.schemaVersion,
    invalid,
  );
  assertAggregateResultType(
    value.aggregate.resultType,
    aggregateNodeVersion,
    invalid,
  );
  assertExactKeys(
    value.aggregatePlan,
    [
      'costClass',
      'kind',
      'loweringRowId',
      'providerProbeId',
      'schemaVersion',
      'sourceFieldType',
    ],
    invalid,
  );
  if (
    value.aggregatePlan.costClass !== 'tenantBoundedScan' ||
    value.aggregatePlan.kind !== 'queryAggregateLoweringPlan' ||
    value.aggregatePlan.loweringRowId !==
      'northstar.query-aggregate-lowering/required-sum-v1' ||
    value.aggregatePlan.providerProbeId !==
      'Q1-P3b/required-sum-tenant-bounded-scan' ||
    value.aggregatePlan.schemaVersion !==
      QUERY_AGGREGATE_LOWERING_PLAN_VERSION ||
    FieldTypeSchema.safeParse(value.aggregatePlan.sourceFieldType).success ===
      false ||
    !isRecord(value.aggregatePlan.sourceFieldType)
  ) {
    throw invalid('aggregate query lowering plan is invalid');
  }
  if (
    canonicalizeAndHash(value.aggregatePlan.sourceFieldType).contentHash !==
    canonicalizeAndHash(value.aggregate.measureFieldType).contentHash
  ) {
    throw invalid(
      'aggregate lowering plan does not match its catalog measure field',
    );
  }
  assertAggregateSourceMatchesResult(
    value.aggregate.measureFieldType,
    value.aggregate.resultType,
    aggregateNodeVersion,
    invalid,
  );
  assertExactKeys(
    value.resultContract,
    ['kind', 'outcome', 'schemaVersion'],
    invalid,
  );
  if (
    value.resultContract.kind !== 'semanticAggregateResult' ||
    value.resultContract.outcome !== 'exact' ||
    value.resultContract.schemaVersion !== SEMANTIC_AGGREGATE_RESULT_VERSION
  ) {
    throw invalid('aggregate result contract is invalid');
  }
  const fieldParameterTypes = new Map<string, Record<string, unknown>>();
  const parameterIds = new Set<string>();
  for (const parameter of value.parameters) {
    if (!isRecord(parameter)) {
      throw invalid('aggregate query parameter must be an object');
    }
    assertExactKeys(
      parameter,
      ['orderKey', 'parameterId', 'parameterType'],
      invalid,
    );
    assertCanonicalId(parameter.parameterId, 'parameterId', invalid);
    if (
      !Number.isSafeInteger(parameter.orderKey) ||
      Number(parameter.orderKey) < 0 ||
      Number(parameter.orderKey) > 1_000_000 ||
      parameterIds.has(parameter.parameterId as string) ||
      !isRecord(parameter.parameterType)
    ) {
      throw invalid('aggregate query parameter contract is invalid');
    }
    parameterIds.add(parameter.parameterId as string);
    const parameterType = parameter.parameterType;
    // This branch ENABLES the v4 legal-entity scope operand, so it belongs to
    // this packet rather than to adoption. LANG-ADOPT deliberately removed it
    // to keep adoption semantically inert, on its review's finding; G3-P5
    // restores it as the feature it is.
    if (parameterType.kind === 'legalEntityReferenceParameterType') {
      assertExactKeys(parameterType, ['kind', 'schemaVersion'], invalid);
      if (parameterType.schemaVersion !== aggregateNodeVersion) {
        throw invalid('aggregate legal-entity parameter version is invalid');
      }
      continue;
    }
    if (
      FieldTypeSchema.safeParse(parameterType).success === false ||
      parameterType.schemaVersion !== aggregateNodeVersion
    ) {
      throw invalid('aggregate query parameter field type is invalid');
    }
    fieldParameterTypes.set(parameter.parameterId as string, parameterType);
  }
  assertParameterizedPlanReferences(
    value.filterPlan,
    fieldParameterTypes,
    aggregateNodeVersion,
    invalid,
  );
}

function assertAggregateSourceMatchesResult(
  sourceFieldType: Record<string, unknown>,
  resultType: Record<string, unknown>,
  aggregateNodeVersion: CanonicalLanguageVersion,
  invalid: (message: string) => Error,
): void {
  const quantity = sourceFieldType.kind === 'quantityFieldType';
  if (
    (sourceFieldType.kind !== 'exactDecimalFieldType' && !quantity) ||
    sourceFieldType.schemaVersion !== aggregateNodeVersion ||
    sourceFieldType.scale !== resultType.scale ||
    (quantity
      ? resultType.kind !== 'quantityAggregateResultType' ||
        !isRecord(sourceFieldType.baseUnit) ||
        !isRecord(resultType.baseUnit) ||
        canonicalizeAndHash(sourceFieldType.baseUnit).contentHash !==
          canonicalizeAndHash(resultType.baseUnit).contentHash
      : resultType.kind !== 'exactDecimalAggregateResultType')
  ) {
    throw invalid('aggregate result type does not match its measure field');
  }
}

function assertAggregateResultType(
  value: Record<string, unknown>,
  aggregateNodeVersion: CanonicalLanguageVersion,
  invalid: (message: string) => Error,
): void {
  const quantity = value.kind === 'quantityAggregateResultType';
  assertExactKeys(
    value,
    quantity
      ? ['baseUnit', 'kind', 'precision', 'scale', 'schemaVersion']
      : ['kind', 'precision', 'scale', 'schemaVersion'],
    invalid,
  );
  if (
    (value.kind !== 'exactDecimalAggregateResultType' && !quantity) ||
    value.precision !== 38 ||
    !Number.isInteger(value.scale) ||
    Number(value.scale) < 0 ||
    Number(value.scale) > 18 ||
    value.schemaVersion !== aggregateNodeVersion
  ) {
    throw invalid('aggregate result type is invalid');
  }
  if (quantity) {
    if (!isRecord(value.baseUnit)) {
      throw invalid('quantity aggregate base unit is invalid');
    }
    assertExactKeys(
      value.baseUnit,
      ['kind', 'schemaVersion', 'targetId'],
      invalid,
    );
    assertCanonicalId(value.baseUnit.targetId, 'baseUnit.targetId', invalid);
    if (
      value.baseUnit.kind !== 'unitReference' ||
      value.baseUnit.schemaVersion !== aggregateNodeVersion
    ) {
      throw invalid('quantity aggregate base unit is invalid');
    }
  }
}

/**
 * Aggregate nodes are cumulative language features. The catalog node declares
 * which supported language authored it; consumers ask that authority instead
 * of pinning one compile-time version literal.
 */
function requiredAggregateNodeVersion(
  value: unknown,
  invalid: (message: string) => Error,
): CanonicalLanguageVersion {
  const supported = SUPPORTED_LANGUAGE_VERSIONS.find(
    (candidate) => candidate === value,
  );
  if (!supported || !languageHasV3Features(supported)) {
    throw invalid('aggregate node language version is unsupported');
  }
  return supported;
}

/**
 * Row queries carry declared parameters from v4. They are validated with the
 * same closed contract the aggregate branch already applies, because an
 * unvalidated declaration is a hole in a closed pinned catalog.
 */
function assertRowQueryParameters(
  value: unknown,
  invalid: (message: string) => Error,
): void {
  if (!Array.isArray(value)) {
    throw invalid('query parameters must be an array');
  }
  const parameterIds = new Set<string>();
  for (const parameter of value) {
    if (!isRecord(parameter)) {
      throw invalid('query parameter must be an object');
    }
    assertExactKeys(
      parameter,
      ['orderKey', 'parameterId', 'parameterType'],
      invalid,
    );
    assertCanonicalId(parameter.parameterId, 'parameterId', invalid);
    if (
      !Number.isSafeInteger(parameter.orderKey) ||
      Number(parameter.orderKey) < 0 ||
      Number(parameter.orderKey) > 1_000_000 ||
      parameterIds.has(parameter.parameterId) ||
      !isRecord(parameter.parameterType)
    ) {
      throw invalid('query parameter contract is invalid');
    }
    const parameterType = parameter.parameterType;
    const legalEntityReference =
      parameterType.kind === 'legalEntityReferenceParameterType' &&
      parameterType.schemaVersion === 'v4';
    if (
      !legalEntityReference &&
      FieldTypeSchema.safeParse(parameterType).success === false
    ) {
      throw invalid('query parameter type is not admitted');
    }
    if (legalEntityReference) {
      assertExactKeys(parameterType, ['kind', 'schemaVersion'], invalid);
    }
    parameterIds.add(parameter.parameterId);
  }
}

function assertLegalEntityScopeContract(
  value: unknown,
  query: Record<string, unknown>,
  invalid: (message: string) => Error,
): void {
  if (!isRecord(value)) {
    throw invalid('legal-entity scope must be an object');
  }
  assertExactKeys(
    value,
    ['cardinality', 'kind', 'operand', 'schemaVersion'],
    invalid,
  );
  if (
    value.kind !== 'queryLegalEntityScope' ||
    value.schemaVersion !== 'v4' ||
    !LEGAL_ENTITY_SCOPE_CONTRACT_V1.admittedCardinalities.includes(
      value.cardinality as 'exactlyOne',
    ) ||
    !isRecord(value.operand)
  ) {
    throw invalid('legal-entity scope contract is invalid');
  }
  const operand = value.operand;
  assertExactKeys(operand, ['kind', 'parameterId', 'schemaVersion'], invalid);
  assertCanonicalId(operand.parameterId, 'parameterId', invalid);
  if (
    operand.kind !== 'queryParameterReference' ||
    operand.schemaVersion !== 'v4'
  ) {
    throw invalid('legal-entity scope operand is invalid');
  }
  // The operand must name a declared parameter carrying the derived
  // legal-entity type. Checking only that the id exists would admit a catalog
  // the canonical model could not have produced -- normalization derives this
  // type for exactly the parameter a scope names, so a scope pointing at an
  // ordinary field-typed parameter is a forged contract.
  const parameters = Array.isArray(query.parameters) ? query.parameters : [];
  const operandParameter = parameters.find(
    (parameter) =>
      isRecord(parameter) && parameter.parameterId === operand.parameterId,
  );
  if (!isRecord(operandParameter)) {
    throw invalid('legal-entity scope operand names no declared parameter');
  }
  if (
    !isRecord(operandParameter.parameterType) ||
    operandParameter.parameterType.kind !==
      'legalEntityReferenceParameterType' ||
    operandParameter.parameterType.schemaVersion !== 'v4'
  ) {
    throw invalid('legal-entity scope operand has the wrong parameter type');
  }
}

function parsePolicyNarrowing(value: unknown): QueryFilterLoweringPlan {
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
  const parameterized =
    isRecord(cloned.filterPlan) &&
    cloned.filterPlan.schemaVersion ===
      PARAMETERIZED_PREDICATE_LOWERING_PLAN_VERSION;
  assertPredicateLoweringPlan(
    cloned.filterPlan,
    cloned.filter,
    invalid,
    parameterized,
  );
  return cloned.filterPlan as unknown as QueryFilterLoweringPlan;
}

function assertPredicateLoweringPlan(
  value: unknown,
  predicate: Readonly<Record<string, unknown>>,
  error: (message: string) => Error,
  parameterizedExpected = false,
): asserts value is QueryFilterLoweringPlan {
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
    value.schemaVersion !==
      (parameterizedExpected
        ? PARAMETERIZED_PREDICATE_LOWERING_PLAN_VERSION
        : PREDICATE_LOWERING_PLAN_VERSION) ||
    value.positionProfileVersion !== PREDICATE_POSITION_PROFILE_VERSION ||
    typeof value.predicateDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.predicateDigest) ||
    value.predicateDigest !== canonicalizeAndHash(predicate).contentHash
  ) {
    throw error('predicate lowering plan identity is invalid');
  }
  if (parameterizedExpected) {
    if (
      VersionedPredicateExpressionSchema.safeParse(predicate).success === false
    ) {
      throw error('parameterized predicate lowering input is invalid');
    }
  } else {
    const predicateReceipt = inspectPredicateForExecution(predicate, {
      bindingPosition: 'queryFilter',
      resolveComparison: () => ({ presence: 'absent' }),
    });
    if (predicateReceipt.outcome !== 'evaluated') {
      throw error('predicate lowering input is invalid');
    }
  }
  const aggregateNodeVersion = parameterizedExpected
    ? requiredAggregateNodeVersion(predicate.schemaVersion, error)
    : undefined;
  const observed = inspectLoweringNode(
    value.root,
    1,
    error,
    parameterizedExpected,
    aggregateNodeVersion,
  );
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
  parameterized: boolean,
  aggregateNodeVersion?: CanonicalLanguageVersion,
  parameterTypes?: Map<string, Record<string, unknown>>,
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
          ...(parameterized ? ['sourceFieldType'] : []),
          'value',
        ],
        error,
      );
      assertCanonicalId(value.fieldId, 'fieldId', error);
      if (
        !isRecord(value.value) ||
        (parameterized &&
          (!isRecord(value.sourceFieldType) ||
            FieldTypeSchema.safeParse(value.sourceFieldType).success ===
              false ||
            value.sourceFieldType.schemaVersion !== aggregateNodeVersion)) ||
        !(
          parameterized
            ? [
                'equals',
                'notEquals',
                'lessThan',
                'greaterThan',
                'greaterThanOrEqual',
                'lessThanOrEqual',
              ]
            : ['equals', 'notEquals', 'lessThan', 'greaterThan']
        ).includes(String(value.operator))
      ) {
        throw error('predicate comparison lowering is invalid');
      }
      if (parameterized && value.value.kind === 'queryParameterReference') {
        assertExactKeys(
          value.value,
          ['kind', 'parameterId', 'schemaVersion'],
          error,
        );
        assertCanonicalId(value.value.parameterId, 'parameterId', error);
        if (value.value.schemaVersion !== aggregateNodeVersion) {
          throw error('aggregate lowering parameter reference is invalid');
        }
        const parameterId = value.value.parameterId as string;
        const sourceFieldType = value.sourceFieldType as Record<
          string,
          unknown
        >;
        const prior = parameterTypes?.get(parameterId);
        if (
          prior &&
          canonicalizeAndHash(prior).contentHash !==
            canonicalizeAndHash(sourceFieldType).contentHash
        ) {
          throw error(
            'aggregate lowering uses one parameter with incompatible field types',
          );
        }
        parameterTypes?.set(parameterId, sourceFieldType);
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
        (!parameterized ||
          (value.value.kind !== 'queryParameterReference' &&
            ['equals', 'notEquals', 'lessThan', 'greaterThan'].includes(
              String(value.operator),
            ))) &&
        value.costClass === 'tenantBoundedScan';
      const parameterizedComparison =
        parameterized &&
        value.loweringRowId ===
          'northstar.predicate-lowering/parameterized-comparison-v1' &&
        (value.comparisonMode === 'binary' ||
          value.comparisonMode === 'unicodeCaseFold') &&
        (value.value.kind === 'queryParameterReference' ||
          value.operator === 'greaterThanOrEqual' ||
          value.operator === 'lessThanOrEqual') &&
        value.costClass === 'tenantBoundedScan';
      if (!folded && !bounded && !parameterizedComparison) {
        throw error('predicate comparison lowering row is not admitted');
      }
      return {
        comparisonCosts: [value.costClass as PredicateCostClass],
      };
    }
    case 'notPredicate': {
      assertExactKeys(value, ['kind', 'term'], error);
      return inspectLoweringNode(
        value.term,
        depth + 1,
        error,
        parameterized,
        aggregateNodeVersion,
        parameterTypes,
      );
    }
    case 'allPredicate':
    case 'anyPredicate': {
      assertExactKeys(value, ['kind', 'terms'], error);
      if (!Array.isArray(value.terms)) {
        throw error('predicate Boolean terms must be an array');
      }
      const terms = value.terms.map((term) =>
        inspectLoweringNode(
          term,
          depth + 1,
          error,
          parameterized,
          aggregateNodeVersion,
          parameterTypes,
        ),
      );
      return {
        comparisonCosts: terms.flatMap((term) => term.comparisonCosts),
      };
    }
    default:
      throw error('predicate lowering node kind is not admitted');
  }
}

function assertParameterizedPlanReferences(
  plan: unknown,
  declaredParameterTypes: ReadonlyMap<string, Record<string, unknown>>,
  aggregateNodeVersion: CanonicalLanguageVersion,
  error: (message: string) => Error,
): void {
  if (!isRecord(plan) || !isRecord(plan.root)) {
    throw error('aggregate parameterized lowering plan is invalid');
  }
  const observed = new Map<string, Record<string, unknown>>();
  inspectLoweringNode(
    plan.root,
    1,
    error,
    true,
    aggregateNodeVersion,
    observed,
  );
  if (
    observed.size !== declaredParameterTypes.size ||
    [...declaredParameterTypes].some(
      ([parameterId, parameterType]) =>
        !observed.has(parameterId) ||
        canonicalizeAndHash(observed.get(parameterId)!).contentHash !==
          canonicalizeAndHash(parameterType).contentHash,
    ) ||
    [...observed].some(
      ([parameterId]) => !declaredParameterTypes.has(parameterId),
    )
  ) {
    throw error(
      'aggregate lowering does not use exactly the declared parameter types',
    );
  }
}

function bindQueryParameters(
  definition: RegisteredSemanticQueryDefinition,
  argumentsValue: ImmutableJsonValue,
): Readonly<Record<string, ImmutableJsonValue>> {
  if (definition.queryType !== 'aggregate') return Object.freeze({});
  if (!isRecord(argumentsValue) || !Array.isArray(definition.parameters)) {
    throw new MalformedSemanticQueryRequestError(
      'aggregate query arguments must be an object',
    );
  }
  const expected = definition.parameters.map(
    (parameter) => parameter.parameterId,
  );
  const actual = Object.keys(argumentsValue).sort();
  if (actual.join('\0') !== [...expected].sort().join('\0')) {
    throw new MalformedSemanticQueryRequestError(
      'aggregate query arguments do not match the declared parameters',
    );
  }
  const bound: Record<string, ImmutableJsonValue> = {};
  for (const parameter of definition.parameters) {
    const value = argumentsValue[parameter.parameterId];
    if (!queryParameterValueMatches(parameter.parameterType, value)) {
      throw new MalformedSemanticQueryRequestError(
        `aggregate query argument ${parameter.parameterId} violates its declared type`,
      );
    }
    bound[parameter.parameterId] = value!;
  }
  return Object.freeze(bound);
}

function queryParameterValueMatches(
  type: Readonly<Record<string, ImmutableJsonValue>>,
  value: ImmutableJsonValue | undefined,
): boolean {
  switch (type.kind) {
    case 'legalEntityReferenceParameterType':
      // Ruled by the canonical selection kernel against the query's declared
      // cardinality, not by field-type matching. Accepting here and refusing
      // there keeps one authority over what a scope argument means.
      return value !== undefined;
    case 'booleanFieldType':
      return typeof value === 'boolean';
    case 'textFieldType':
      return (
        typeof value === 'string' &&
        Number.isSafeInteger(type.maximumLength) &&
        [...value].length <= Number(type.maximumLength)
      );
    case 'enumFieldType':
      return (
        typeof value === 'string' &&
        Array.isArray(type.options) &&
        type.options.some(
          (option) => isRecord(option) && option.optionId === value,
        )
      );
    case 'integerFieldType':
      return (
        typeof value === 'string' && /^(?:0|-[1-9]\d*|[1-9]\d*)$/u.test(value)
      );
    case 'exactDecimalFieldType':
    case 'moneyFieldType':
    case 'quantityFieldType':
      return (
        typeof value === 'string' &&
        decimalArgumentFits(value, type.precision, type.scale)
      );
    case 'dateFieldType':
      return typeof value === 'string' && isoDateArgumentFits(value);
    case 'timeFieldType':
      return (
        typeof value === 'string' && isoTimeArgumentFits(value, type.precision)
      );
    case 'dateTimeFieldType':
      return (
        typeof value === 'string' &&
        isoDateTimeArgumentFits(value, type.precision, type.timezoneSemantics)
      );
    default:
      return false;
  }
}

function isoDateArgumentFits(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function isoTimeArgumentFits(
  value: string,
  precision: ImmutableJsonValue | undefined,
): boolean {
  if (precision !== 'second' && precision !== 'millisecond') return false;
  const fraction = precision === 'millisecond' ? '\\.\\d{3}' : '';
  const match = new RegExp(`^(\\d{2}):(\\d{2}):(\\d{2})${fraction}$`, 'u').exec(
    value,
  );
  return (
    match !== null &&
    Number(match[1]) < 24 &&
    Number(match[2]) < 60 &&
    Number(match[3]) < 60
  );
}

function isoDateTimeArgumentFits(
  value: string,
  precision: ImmutableJsonValue | undefined,
  timezoneSemantics: ImmutableJsonValue | undefined,
): boolean {
  if (
    (precision !== 'second' && precision !== 'millisecond') ||
    (timezoneSemantics !== 'utcInstant' &&
      timezoneSemantics !== 'offsetDateTime')
  ) {
    return false;
  }
  const fraction = precision === 'millisecond' ? '(\\.\\d{3})' : '';
  const zone =
    timezoneSemantics === 'utcInstant' ? '(Z)' : '([+-](\\d{2}):(\\d{2}))';
  const match = new RegExp(
    `^(\\d{4}-\\d{2}-\\d{2})T(\\d{2}:\\d{2}:\\d{2})${fraction}${zone}$`,
    'u',
  ).exec(value);
  if (!match || !isoDateArgumentFits(match[1]!)) return false;
  const time = `${match[2]}${precision === 'millisecond' ? match[3] : ''}`;
  if (!isoTimeArgumentFits(time, precision)) return false;
  if (timezoneSemantics === 'utcInstant') return true;
  const zoneValue = match.at(-3);
  const offsetHour = Number(match.at(-2));
  const offsetMinute = Number(match.at(-1));
  if (zoneValue === '-00:00') return false;
  return (
    offsetMinute < 60 &&
    (offsetHour < 14 || (offsetHour === 14 && offsetMinute === 0))
  );
}

function decimalArgumentFits(
  value: string,
  precision: ImmutableJsonValue | undefined,
  scale: ImmutableJsonValue | undefined,
): boolean {
  if (
    !Number.isSafeInteger(precision) ||
    !Number.isSafeInteger(scale) ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u.test(value) ||
    value === '-0'
  ) {
    return false;
  }
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [integer = '', fraction = ''] = unsigned.split('.');
  const integerDigits = integer === '0' ? 0 : integer.length;
  return (
    fraction.length <= Number(scale) &&
    integerDigits <= Number(precision) - Number(scale)
  );
}

function requireSemanticAggregateResult(
  definition: RegisteredAggregateQueryDefinition,
  result: SemanticAggregateResultEnvelope | SemanticQueryResultEnvelope,
): asserts result is SemanticAggregateResultEnvelope {
  const malformed = (message: string): MalformedPinnedQueryCatalogError =>
    new MalformedPinnedQueryCatalogError(message);
  if (!isRecord(result)) {
    throw malformed('aggregate executor returned a malformed result');
  }
  assertExactKeys(
    result,
    ['kind', 'outcome', 'queryId', 'schemaVersion', 'value'],
    malformed,
  );
  if (
    result.kind !== 'semanticAggregateResult' ||
    result.schemaVersion !== SEMANTIC_AGGREGATE_RESULT_VERSION ||
    result.outcome !== 'exact' ||
    result.queryId !== definition.queryId ||
    !isRecord(result.value) ||
    !definition.aggregate
  ) {
    throw new MalformedPinnedQueryCatalogError(
      'aggregate executor returned a malformed result',
    );
  }
  const expected = definition.aggregate.resultType;
  const quantity = expected.kind === 'quantityAggregateResultType';
  assertExactKeys(
    result.value,
    quantity
      ? ['baseUnitId', 'kind', 'precision', 'scale', 'selectionId', 'value']
      : ['kind', 'precision', 'scale', 'selectionId', 'value'],
    malformed,
  );
  const valueShapeMatches =
    quantity && result.value.kind === 'quantityResult'
      ? isRecord(expected.baseUnit) &&
        result.value.baseUnitId === expected.baseUnit.targetId
      : !quantity && result.value.kind === 'exactDecimalResult';
  if (
    !valueShapeMatches ||
    result.value.precision !== 38 ||
    result.value.scale !== expected.scale ||
    result.value.selectionId !== definition.aggregate.selectionId ||
    typeof result.value.value !== 'string' ||
    !decimalArgumentFits(result.value.value, 38, expected.scale)
  ) {
    throw new MalformedPinnedQueryCatalogError(
      'aggregate executor result does not match the compiled contract',
    );
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
