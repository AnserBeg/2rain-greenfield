import {
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  assertRequestRuntimeView,
  authorizeCurrentPolicy,
  type CurrentPolicyGateway,
  type ImmutableJsonValue,
} from './request-runtime-view.js';
import type { RequestRuntimeView as IssuedRequestRuntimeView } from './request-runtime-view.js';

export const SEMANTIC_OPERATION_REQUEST_VERSION =
  'northstar.semantic-operation-request/v1' as const;

const OPERATION_CATALOG_PAYLOAD_VERSION =
  'northstar.operation-catalog-payload/v0-provisional' as const;
const OPERATION_POLICY_INPUT_VERSION =
  'northstar.semantic-operation-policy-input/v1' as const;
const OPERATION_BOUNDARY_PERMISSION_ID =
  'northstar.runtime:permission.semantic-operation-boundary' as const;
const canonicalIdPattern =
  /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export interface SemanticOperationRequestEnvelope {
  readonly input: ImmutableJsonValue;
  readonly operationId: string;
  readonly schemaVersion: typeof SEMANTIC_OPERATION_REQUEST_VERSION;
}

export class MalformedSemanticOperationRequestError extends Error {
  readonly code = 'MALFORMED_SEMANTIC_OPERATION_REQUEST' as const;
  override readonly name = 'MalformedSemanticOperationRequestError';
}

export class MalformedPinnedOperationCatalogError extends Error {
  readonly code = 'MALFORMED_PINNED_OPERATION_CATALOG' as const;
  override readonly name = 'MalformedPinnedOperationCatalogError';
}

export class SemanticOperationPolicyDeniedError extends Error {
  readonly code = 'SEMANTIC_OPERATION_POLICY_DENIED' as const;
  override readonly name = 'SemanticOperationPolicyDeniedError';
  readonly operationId: string;
  readonly pinnedReleaseContentHash: string;
  readonly pinnedReleaseId: string;

  constructor(operationId: string, view: IssuedRequestRuntimeView) {
    super(
      `current policy denied operation ${operationId} for pinned release ${view.release.releaseId}`,
    );
    this.operationId = operationId;
    this.pinnedReleaseContentHash = view.release.contentHash;
    this.pinnedReleaseId = view.release.releaseId;
  }
}

export class NoSuchRegisteredOperationError extends Error {
  readonly code = 'NO_SUCH_REGISTERED_OPERATION' as const;
  override readonly name = 'NoSuchRegisteredOperationError';
  readonly operationId: string;
  readonly pinnedReleaseContentHash: string;
  readonly pinnedReleaseId: string;

  constructor(operationId: string, view: IssuedRequestRuntimeView) {
    super(
      `operation ${operationId} is not registered in pinned release ${view.release.releaseId}`,
    );
    this.operationId = operationId;
    this.pinnedReleaseContentHash = view.release.contentHash;
    this.pinnedReleaseId = view.release.releaseId;
  }
}

/** Sole application mutation ingress for the request-pinned semantic contract. */
export class SemanticOperationGateway {
  constructor(private readonly currentPolicy: CurrentPolicyGateway) {}

  async invoke(
    view: IssuedRequestRuntimeView,
    requestInput: unknown,
  ): Promise<never> {
    assertRequestRuntimeView(view);
    const request = parseSemanticOperationRequest(requestInput);
    const policyDecision = await authorizeCurrentPolicy(
      this.currentPolicy,
      view,
      OPERATION_BOUNDARY_PERMISSION_ID,
      Object.freeze({
        input: request.input,
        kind: 'semanticOperationPolicyInput',
        operationId: request.operationId,
        requestId: view.requestId,
        schemaVersion: OPERATION_POLICY_INPUT_VERSION,
      }),
    );
    if (policyDecision.decision === 'DENY') {
      throw new SemanticOperationPolicyDeniedError(request.operationId, view);
    }

    assertPinnedOperationCatalog(view);
    throw new NoSuchRegisteredOperationError(request.operationId, view);
  }
}

function parseSemanticOperationRequest(
  value: unknown,
): SemanticOperationRequestEnvelope {
  if (!isRecord(value)) {
    throw new MalformedSemanticOperationRequestError(
      'semantic operation request must be an object',
    );
  }
  assertExactKeys(
    value,
    ['input', 'operationId', 'schemaVersion'],
    (message) => new MalformedSemanticOperationRequestError(message),
  );
  if (value.schemaVersion !== SEMANTIC_OPERATION_REQUEST_VERSION) {
    throw new MalformedSemanticOperationRequestError(
      'semantic operation request version is not supported',
    );
  }
  assertCanonicalId(
    value.operationId,
    'operationId',
    (message) => new MalformedSemanticOperationRequestError(message),
  );

  return Object.freeze({
    input: cloneImmutableJson(
      value.input,
      '$.input',
      (message) => new MalformedSemanticOperationRequestError(message),
    ),
    operationId: value.operationId,
    schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
  });
}

function assertPinnedOperationCatalog(view: IssuedRequestRuntimeView): void {
  const projection = view.projections.operation;
  if (
    projection.familyId !== REQUEST_RUNTIME_PROJECTION_FAMILIES.operation ||
    projection.payloadSchemaVersion !== OPERATION_CATALOG_PAYLOAD_VERSION
  ) {
    throw new MalformedPinnedOperationCatalogError(
      'pinned operation projection has an invalid family or version',
    );
  }
  const payload = projection.payload;
  if (!isRecord(payload)) {
    throw new MalformedPinnedOperationCatalogError(
      'pinned operation catalog must be an object',
    );
  }
  assertExactKeys(
    payload,
    ['kind', 'operations', 'schemaVersion'],
    (message) => new MalformedPinnedOperationCatalogError(message),
  );
  if (
    payload.kind !== 'operationCatalogPayload' ||
    payload.schemaVersion !== OPERATION_CATALOG_PAYLOAD_VERSION ||
    !Array.isArray(payload.operations)
  ) {
    throw new MalformedPinnedOperationCatalogError(
      'pinned operation catalog has an invalid kind, version, or shape',
    );
  }

  const operationIds = new Set<string>();
  for (const operation of payload.operations) {
    assertOperationDefinition(operation);
    if (operationIds.has(operation.operationId)) {
      throw new MalformedPinnedOperationCatalogError(
        'pinned operation catalog contains a duplicate operationId',
      );
    }
    operationIds.add(operation.operationId);
  }
}

function assertOperationDefinition(
  value: unknown,
): asserts value is Record<string, unknown> & { operationId: string } {
  const invalid = (message: string): MalformedPinnedOperationCatalogError =>
    new MalformedPinnedOperationCatalogError(message);
  if (!isRecord(value)) {
    throw invalid('pinned operation definition must be an object');
  }
  assertExactKeys(
    value,
    [
      'confirmation',
      'effect',
      'lifecycle',
      'operationId',
      'permissionId',
      'precondition',
      'readBackQueryId',
      'tier',
    ],
    invalid,
  );
  assertCanonicalId(value.operationId, 'operationId', invalid);
  assertCanonicalId(value.permissionId, 'permissionId', invalid);
  assertCanonicalId(value.readBackQueryId, 'readBackQueryId', invalid);
  if (
    (value.confirmation !== 'none' && value.confirmation !== 'humanRequired') ||
    (value.lifecycle !== 'active' && value.lifecycle !== 'retired') ||
    (value.tier !== 'o0' && value.tier !== 'o1') ||
    !isRecord(value.effect) ||
    !isRecord(value.precondition)
  ) {
    throw invalid('pinned operation definition has an invalid shape');
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
