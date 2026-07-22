import {
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  assertRequestRuntimeView,
  authorizeCurrentPolicy,
  type CurrentPolicyGateway,
  type ImmutableJsonValue,
} from './request-runtime-view.js';
import type { RequestRuntimeView as IssuedRequestRuntimeView } from './request-runtime-view.js';

export const SEMANTIC_QUERY_REQUEST_VERSION =
  'northstar.semantic-query-request/v1' as const;

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

export class MalformedSemanticQueryRequestError extends Error {
  readonly code = 'MALFORMED_SEMANTIC_QUERY_REQUEST' as const;
  override readonly name = 'MalformedSemanticQueryRequestError';
}

export class MalformedPinnedQueryCatalogError extends Error {
  readonly code = 'MALFORMED_PINNED_QUERY_CATALOG' as const;
  override readonly name = 'MalformedPinnedQueryCatalogError';
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
  constructor(private readonly currentPolicy: CurrentPolicyGateway) {}

  async invoke(
    view: IssuedRequestRuntimeView,
    requestInput: unknown,
  ): Promise<never> {
    assertRequestRuntimeView(view);
    const request = parseSemanticQueryRequest(requestInput);
    const policyDecision = await authorizeCurrentPolicy(
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
    if (policyDecision.decision === 'DENY') {
      throw new SemanticQueryPolicyDeniedError(request.queryId, view);
    }

    assertPinnedQueryCatalog(view);
    throw new NoSuchRegisteredQueryError(request.queryId, view);
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

function assertPinnedQueryCatalog(view: IssuedRequestRuntimeView): void {
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
  for (const query of payload.queries) {
    assertQueryDefinition(query);
    if (queryIds.has(query.queryId)) {
      throw new MalformedPinnedQueryCatalogError(
        'pinned query catalog contains a duplicate queryId',
      );
    }
    queryIds.add(query.queryId);
  }
}

function assertQueryDefinition(
  value: unknown,
): asserts value is Record<string, unknown> & { queryId: string } {
  const invalid = (message: string): MalformedPinnedQueryCatalogError =>
    new MalformedPinnedQueryCatalogError(message);
  if (!isRecord(value)) {
    throw invalid('pinned query definition must be an object');
  }
  assertExactKeys(
    value,
    [
      'filter',
      'lifecycle',
      'maximumResultCount',
      'permissionId',
      'queryId',
      'queryType',
      'selections',
      'sourceEntityId',
      'tier',
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
      value.queryType !== 'resolve') ||
    (value.tier !== 'q0' && value.tier !== 'q1') ||
    !Number.isSafeInteger(value.maximumResultCount) ||
    Number(value.maximumResultCount) < 1 ||
    !isRecord(value.filter) ||
    !Array.isArray(value.selections)
  ) {
    throw invalid('pinned query definition has an invalid shape');
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
