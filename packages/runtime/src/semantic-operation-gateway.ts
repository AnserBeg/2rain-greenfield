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
import type { SemanticRecordDto } from './semantic-query-gateway.js';
import {
  registeredQueryFromPinnedView,
  type RegisteredQueryDefinition,
} from './semantic-query-gateway.js';

export const SEMANTIC_OPERATION_REQUEST_VERSION =
  'northstar.semantic-operation-request/v1' as const;
export const SEMANTIC_OPERATION_RESULT_VERSION =
  'northstar.semantic-operation-result/v1' as const;

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

export interface RegisteredOperationDefinition {
  readonly confirmation: 'humanRequired' | 'none';
  readonly effect: {
    readonly entity: {
      readonly kind: string;
      readonly schemaVersion: string;
      readonly targetId: string;
    };
    readonly kind:
      | 'archiveRecordEffect'
      | 'createRecordEffect'
      | 'restoreRecordEffect'
      | 'updateRecordEffect';
    readonly schemaVersion: string;
  };
  readonly infrastructure?: {
    readonly archiveRepresentation: 'nullableArchivedAt';
    readonly optimisticRevision: 'compareAndIncrement';
    readonly recordIdentity: 'canonicalUuid';
  };
  readonly inputContract?: RegisteredOperationInputContract;
  readonly lifecycle: 'active' | 'retired';
  readonly operationId: string;
  readonly permissionId: string;
  readonly precondition: Readonly<Record<string, ImmutableJsonValue>>;
  readonly readBackQueryId: string;
  readonly tier: 'o0' | 'o1';
}

export interface RegisteredOperationInputContract {
  readonly closedArgumentKeys: readonly string[];
  readonly fields: readonly {
    readonly bounds: {
      readonly maximumLength: number | null;
      readonly precision: number | null;
      readonly scale: number | null;
    };
    readonly enumOptionIds: readonly string[];
    readonly fieldId: string;
    readonly fieldKind:
      | 'booleanFieldType'
      | 'dateFieldType'
      | 'dateTimeFieldType'
      | 'enumFieldType'
      | 'exactDecimalFieldType'
      | 'integerFieldType'
      | 'moneyFieldType'
      | 'quantityFieldType'
      | 'textFieldType'
      | 'timeFieldType';
    readonly normalization:
      'none' | 'unicodeCaseFoldNoCompatibilityNormalization';
    readonly required: boolean;
    readonly temporal: {
      readonly precision: 'millisecond' | 'second' | null;
      readonly timezoneSemantics:
        | 'calendarDate'
        | 'localWallTime'
        | 'offsetDateTime'
        | 'utcInstant'
        | null;
    };
    readonly writable: true;
  }[];
  readonly relationInputs: readonly {
    readonly archiveBehavior: 'restrict' | 'retainReference';
    readonly relationId: string;
    readonly required: boolean;
  }[];
  readonly schemaVersion: 'northstar.module-input-contract/v1';
  readonly writableFieldIds: readonly string[];
}

export interface SemanticOperationResultEnvelope {
  readonly kind: 'semanticOperationResult';
  readonly operationId: string;
  readonly outcome: 'succeeded' | 'unsupported';
  readonly readBack: SemanticRecordDto | null;
  readonly schemaVersion: typeof SEMANTIC_OPERATION_RESULT_VERSION;
  readonly trust: {
    readonly changeDocumentId: string;
    readonly domainEventId: string;
    readonly invocationId: string;
    readonly outboxId: string;
  } | null;
  readonly unsupportedReason: string | null;
}

export interface SemanticOperationExecutionRequest {
  readonly context: TrustedRequestContext;
  readonly definition: RegisteredOperationDefinition;
  readonly input: ImmutableJsonValue;
  readonly policyVersion: string;
  readonly readBackDefinition: RegisteredQueryDefinition;
  readonly view: IssuedRequestRuntimeView;
}

export interface SemanticOperationExecutor {
  execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope>;
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
  constructor(
    private readonly currentPolicy: CurrentPolicyGateway,
    private readonly executor:
      SemanticOperationExecutor | undefined = undefined,
  ) {}

  async invoke(
    view: IssuedRequestRuntimeView,
    requestInput: unknown,
  ): Promise<SemanticOperationResultEnvelope> {
    assertRequestRuntimeView(view);
    const request = parseSemanticOperationRequest(requestInput);
    const boundaryDecision = await authorizeCurrentPolicy(
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
    if (boundaryDecision.decision === 'DENY') {
      throw new SemanticOperationPolicyDeniedError(request.operationId, view);
    }

    const definition = findPinnedOperation(view, request.operationId);
    if (!definition || !this.executor) {
      throw new NoSuchRegisteredOperationError(request.operationId, view);
    }
    const operationDecision = await authorizeCurrentPolicy(
      this.currentPolicy,
      view,
      definition.permissionId,
      Object.freeze({
        input: request.input,
        kind: 'registeredSemanticOperationPolicyInput',
        operationId: request.operationId,
        requestId: view.requestId,
        schemaVersion: OPERATION_POLICY_INPUT_VERSION,
      }),
    );
    if (operationDecision.decision === 'DENY') {
      throw new SemanticOperationPolicyDeniedError(request.operationId, view);
    }
    if (definition.lifecycle !== 'active' || definition.tier !== 'o0') {
      return unsupportedOperationResult(
        request.operationId,
        'operation-tier-unsupported',
      );
    }
    if (!isAlwaysTruePredicate(definition.precondition)) {
      return unsupportedOperationResult(
        request.operationId,
        'operation-precondition-unsupported',
      );
    }
    const readBackDefinition = registeredQueryFromPinnedView(
      view,
      definition.readBackQueryId,
    );
    if (
      !readBackDefinition ||
      readBackDefinition.lifecycle !== 'active' ||
      readBackDefinition.tier !== 'q0' ||
      readBackDefinition.queryType !== 'get' ||
      readBackDefinition.sourceEntityId !== definition.effect.entity.targetId ||
      !isAlwaysTruePredicate(readBackDefinition.filter)
    ) {
      return unsupportedOperationResult(
        request.operationId,
        'operation-read-back-unsupported',
      );
    }
    return this.executor.execute(
      Object.freeze({
        context: trustedContextForRequestRuntimeView(view),
        definition,
        input: request.input,
        policyVersion: operationDecision.policyVersion,
        readBackDefinition,
        view,
      }),
    );
  }
}

function isAlwaysTruePredicate(
  value: Readonly<Record<string, ImmutableJsonValue>>,
): boolean {
  return value.kind === 'booleanPredicate' && value.value === true;
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

function findPinnedOperation(
  view: IssuedRequestRuntimeView,
  operationId: string,
): RegisteredOperationDefinition | undefined {
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
  let selected: RegisteredOperationDefinition | undefined;
  for (const operation of payload.operations) {
    assertOperationDefinition(operation);
    if (operationIds.has(operation.operationId)) {
      throw new MalformedPinnedOperationCatalogError(
        'pinned operation catalog contains a duplicate operationId',
      );
    }
    operationIds.add(operation.operationId);
    if (operation.operationId === operationId) selected = operation;
  }
  return selected;
}

function assertOperationDefinition(
  value: unknown,
): asserts value is RegisteredOperationDefinition {
  const invalid = (message: string): MalformedPinnedOperationCatalogError =>
    new MalformedPinnedOperationCatalogError(message);
  if (!isRecord(value)) {
    throw invalid('pinned operation definition must be an object');
  }
  const expectedKeys = [
    'confirmation',
    'effect',
    'lifecycle',
    'operationId',
    'permissionId',
    'precondition',
    'readBackQueryId',
    'tier',
  ];
  const hasInfrastructure = Object.hasOwn(value, 'infrastructure');
  const hasInputContract = Object.hasOwn(value, 'inputContract');
  assertExactKeys(
    value,
    [
      ...expectedKeys,
      ...(hasInfrastructure ? ['infrastructure'] : []),
      ...(hasInputContract ? ['inputContract'] : []),
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
  assertExactKeys(value.effect, ['entity', 'kind', 'schemaVersion'], invalid);
  if (
    !isRecord(value.effect.entity) ||
    ![
      'archiveRecordEffect',
      'createRecordEffect',
      'restoreRecordEffect',
      'updateRecordEffect',
    ].includes(String(value.effect.kind)) ||
    typeof value.effect.schemaVersion !== 'string'
  ) {
    throw invalid('pinned operation effect is unsupported');
  }
  assertExactKeys(
    value.effect.entity,
    ['kind', 'schemaVersion', 'targetId'],
    invalid,
  );
  assertCanonicalId(
    value.effect.entity.targetId,
    'effect.entity.targetId',
    invalid,
  );
  if (hasInfrastructure) {
    if (!isRecord(value.infrastructure)) {
      throw invalid('pinned operation infrastructure must be an object');
    }
    assertExactKeys(
      value.infrastructure,
      ['archiveRepresentation', 'optimisticRevision', 'recordIdentity'],
      invalid,
    );
    if (
      value.infrastructure.archiveRepresentation !== 'nullableArchivedAt' ||
      value.infrastructure.optimisticRevision !== 'compareAndIncrement' ||
      value.infrastructure.recordIdentity !== 'canonicalUuid'
    ) {
      throw invalid('pinned operation infrastructure is unsupported');
    }
  }
  if (hasInputContract) assertOperationInputContract(value.inputContract);
}

function assertOperationInputContract(
  value: unknown,
): asserts value is RegisteredOperationInputContract {
  const invalid = (message: string): MalformedPinnedOperationCatalogError =>
    new MalformedPinnedOperationCatalogError(message);
  if (!isRecord(value)) {
    throw invalid('pinned operation input contract must be an object');
  }
  assertExactKeys(
    value,
    [
      'closedArgumentKeys',
      'fields',
      'relationInputs',
      'schemaVersion',
      'writableFieldIds',
    ],
    invalid,
  );
  if (
    value.schemaVersion !== 'northstar.module-input-contract/v1' ||
    !Array.isArray(value.closedArgumentKeys) ||
    !Array.isArray(value.fields) ||
    !Array.isArray(value.relationInputs) ||
    !Array.isArray(value.writableFieldIds) ||
    !value.closedArgumentKeys.every((entry) => typeof entry === 'string') ||
    !value.writableFieldIds.every((entry) => typeof entry === 'string')
  ) {
    throw invalid('pinned operation input contract has an invalid shape');
  }
  for (const field of value.fields) {
    if (!isRecord(field)) {
      throw invalid('pinned field input contract must be an object');
    }
    assertExactKeys(
      field,
      [
        'bounds',
        'enumOptionIds',
        'fieldId',
        'fieldKind',
        'normalization',
        'required',
        'temporal',
        'writable',
      ],
      invalid,
    );
    assertCanonicalId(field.fieldId, 'inputContract.fields.fieldId', invalid);
    if (
      !isRecord(field.bounds) ||
      !Array.isArray(field.enumOptionIds) ||
      !field.enumOptionIds.every((entry) => typeof entry === 'string') ||
      !isRecord(field.temporal) ||
      typeof field.required !== 'boolean' ||
      field.writable !== true ||
      ![
        'booleanFieldType',
        'dateFieldType',
        'dateTimeFieldType',
        'enumFieldType',
        'exactDecimalFieldType',
        'integerFieldType',
        'moneyFieldType',
        'quantityFieldType',
        'textFieldType',
        'timeFieldType',
      ].includes(String(field.fieldKind)) ||
      !['none', 'unicodeCaseFoldNoCompatibilityNormalization'].includes(
        String(field.normalization),
      )
    ) {
      throw invalid('pinned field input contract has an invalid shape');
    }
    assertExactKeys(
      field.bounds,
      ['maximumLength', 'precision', 'scale'],
      invalid,
    );
    if (
      !isPositiveIntegerOrNull(field.bounds.maximumLength) ||
      !isPositiveIntegerOrNull(field.bounds.precision) ||
      !isNonNegativeIntegerOrNull(field.bounds.scale)
    ) {
      throw invalid('pinned field input bounds have an invalid shape');
    }
    assertExactKeys(
      field.temporal,
      ['precision', 'timezoneSemantics'],
      invalid,
    );
    if (!isTemporalContract(field.fieldKind, field.temporal)) {
      throw invalid('pinned field temporal contract has an invalid shape');
    }
  }
  for (const relation of value.relationInputs) {
    if (!isRecord(relation)) {
      throw invalid('pinned relation input contract must be an object');
    }
    assertExactKeys(
      relation,
      ['archiveBehavior', 'relationId', 'required'],
      invalid,
    );
    assertCanonicalId(
      relation.relationId,
      'inputContract.relationInputs.relationId',
      invalid,
    );
    if (
      !['restrict', 'retainReference'].includes(
        String(relation.archiveBehavior),
      ) ||
      typeof relation.required !== 'boolean'
    ) {
      throw invalid('pinned relation input contract has an invalid shape');
    }
  }
}

function isTemporalContract(
  fieldKind: unknown,
  temporal: Record<string, unknown>,
): boolean {
  switch (fieldKind) {
    case 'dateFieldType':
      return (
        temporal.precision === null &&
        temporal.timezoneSemantics === 'calendarDate'
      );
    case 'timeFieldType':
      return (
        (temporal.precision === 'second' ||
          temporal.precision === 'millisecond') &&
        temporal.timezoneSemantics === 'localWallTime'
      );
    case 'dateTimeFieldType':
      return (
        (temporal.precision === 'second' ||
          temporal.precision === 'millisecond') &&
        (temporal.timezoneSemantics === 'utcInstant' ||
          temporal.timezoneSemantics === 'offsetDateTime')
      );
    default:
      return temporal.precision === null && temporal.timezoneSemantics === null;
  }
}

function isPositiveIntegerOrNull(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

function isNonNegativeIntegerOrNull(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function unsupportedOperationResult(
  operationId: string,
  reason: string,
): SemanticOperationResultEnvelope {
  return Object.freeze({
    kind: 'semanticOperationResult',
    operationId,
    outcome: 'unsupported',
    readBack: null,
    schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
    trust: null,
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
