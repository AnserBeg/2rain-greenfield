import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import {
  admitPredicateForExecution,
  inspectPredicateForExecution,
  type PredicateKernelReceipt,
} from '@north-star/canonical-model';

import type { TrustedRequestContext } from './request-context.js';
import {
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  RequestRuntimeViewIntegrityError,
  assertRequestRuntimeView,
  authorizeCurrentPolicy,
  trustedContextForRequestRuntimeView,
  type CurrentPolicyGateway,
  type ImmutableJsonValue,
} from './request-runtime-view.js';
import type { RequestRuntimeView as IssuedRequestRuntimeView } from './request-runtime-view.js';
import type { SemanticRecordDto } from './semantic-query-gateway.js';
import {
  observePredicateReceiptSafely,
  registeredQueryFromPinnedView,
  type RegisteredQueryDefinition,
} from './semantic-query-gateway.js';

export const SEMANTIC_OPERATION_REQUEST_VERSION =
  'northstar.semantic-operation-request/v1' as const;
export const SEMANTIC_OPERATION_RESULT_VERSION =
  'northstar.semantic-operation-result/v1' as const;

export type TrustedInvocationChannel =
  'AGENT' | 'API' | 'IMPORT' | 'SYSTEM' | 'UI' | 'WORKFLOW';

const OPERATION_CATALOG_PAYLOAD_VERSION =
  'northstar.operation-catalog-payload/v0-provisional' as const;
const OPERATION_POLICY_INPUT_VERSION =
  'northstar.semantic-operation-policy-input/v1' as const;
const OPERATION_BOUNDARY_PERMISSION_ID =
  'northstar.runtime:permission.semantic-operation-boundary' as const;
const MALFORMED_OPERATION_ACTION_ID =
  'northstar.runtime:operation.malformed_request' as const;
const canonicalIdPattern =
  /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export interface SemanticOperationRequestEnvelope {
  readonly confirmationGrant: string | null;
  readonly idempotencyKey: string;
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
    readonly classification: 'INTERNAL' | 'PUBLIC';
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
  readonly channel: TrustedInvocationChannel;
  readonly context: TrustedRequestContext;
  readonly definition: RegisteredOperationDefinition;
  readonly idempotencyKey: string;
  readonly input: ImmutableJsonValue;
  readonly inputDigest: string;
  readonly policyVersion: string;
  readonly readBackDefinition: RegisteredQueryDefinition;
  readonly view: IssuedRequestRuntimeView;
}

export interface SemanticOperationExecutor {
  execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope>;
  recordNonAccepted(
    request: SemanticOperationNonAcceptedRequest,
  ): Promise<void>;
}

export interface SemanticOperationNonAcceptedRequest {
  readonly channel: TrustedInvocationChannel;
  readonly context: TrustedRequestContext;
  readonly failureCode: string;
  readonly operationId: string;
  readonly outcome: 'DENIED' | 'FAILED';
  readonly policyDecision: 'ALLOW' | 'DENY';
  readonly policyVersion: string;
  readonly view: IssuedRequestRuntimeView;
}

export interface TrustedSemanticOperationInvocation {
  readonly channel: TrustedInvocationChannel;
}

interface ConfirmationGrantClaims {
  readonly environmentId: string;
  readonly expectedRevision: number | null;
  readonly inputDigest: string;
  readonly operationId: string;
  readonly principalId: string;
  readonly releaseContentHash: string;
  readonly releaseId: string;
  readonly schemaVersion: 'northstar.semantic-operation-confirmation-grant/v1';
  readonly targetRecordId: string;
  readonly tenantId: string;
}

/** Server-owned authority for trusted channel attribution and signed grants. */
export class SemanticOperationMediationAuthority {
  readonly #confirmationKey = randomBytes(32);
  readonly #issuedInvocations = new WeakMap<object, IssuedRequestRuntimeView>();

  issueInvocation(
    view: IssuedRequestRuntimeView,
    channel: TrustedInvocationChannel,
  ): TrustedSemanticOperationInvocation {
    assertRequestRuntimeView(view);
    if (!isInvocationChannel(channel)) {
      throw new SemanticOperationInvocationContextError(
        'semantic operation channel is not supported',
      );
    }
    const invocation = Object.freeze({ channel });
    this.#issuedInvocations.set(invocation, view);
    return invocation;
  }

  issueConfirmationGrant(
    view: IssuedRequestRuntimeView,
    operationId: string,
    input: ImmutableJsonValue,
  ): string {
    assertRequestRuntimeView(view);
    const definition = findPinnedOperation(view, operationId);
    if (
      !definition ||
      definition.lifecycle !== 'active' ||
      definition.confirmation !== 'humanRequired'
    ) {
      throw new SemanticOperationConfirmationGrantError(
        'confirmation grant requires an active human-confirmed operation',
      );
    }
    const binding = operationTargetBinding(input);
    const claims: ConfirmationGrantClaims = Object.freeze({
      environmentId: view.environmentId,
      expectedRevision: binding.expectedRevision,
      inputDigest: digestOperationInput(input),
      operationId,
      principalId: view.principalId,
      releaseContentHash: view.release.contentHash,
      releaseId: view.release.releaseId,
      schemaVersion: 'northstar.semantic-operation-confirmation-grant/v1',
      targetRecordId: binding.targetRecordId,
      tenantId: view.tenantId,
    });
    const payload = Buffer.from(canonicalJson(claims)).toString('base64url');
    const signature = createHmac('sha256', this.#confirmationKey)
      .update(payload)
      .digest('base64url');
    return `${payload}.${signature}`;
  }

  assertInvocation(
    view: IssuedRequestRuntimeView,
    invocation: TrustedSemanticOperationInvocation,
  ): void {
    if (this.#issuedInvocations.get(invocation) !== view) {
      throw new SemanticOperationInvocationContextError(
        'semantic operation invocation must be issued at a trusted entry',
      );
    }
  }

  assertConfirmationGrant(
    view: IssuedRequestRuntimeView,
    definition: RegisteredOperationDefinition,
    input: ImmutableJsonValue,
    token: string | null,
  ): void {
    if (definition.confirmation === 'none') {
      if (token !== null) {
        throw new SemanticOperationConfirmationGrantError(
          'confirmation grant is not accepted for this operation',
        );
      }
      return;
    }
    if (token === null) {
      throw new SemanticOperationConfirmationRequiredError(
        definition.operationId,
      );
    }
    const claims = this.#verifiedClaims(token);
    const binding = operationTargetBinding(input);
    if (
      claims.schemaVersion !==
        'northstar.semantic-operation-confirmation-grant/v1' ||
      claims.tenantId !== view.tenantId ||
      claims.environmentId !== view.environmentId ||
      claims.principalId !== view.principalId ||
      claims.releaseId !== view.release.releaseId ||
      claims.releaseContentHash !== view.release.contentHash ||
      claims.operationId !== definition.operationId ||
      claims.targetRecordId !== binding.targetRecordId ||
      claims.expectedRevision !== binding.expectedRevision ||
      claims.inputDigest !== digestOperationInput(input)
    ) {
      throw new SemanticOperationConfirmationStaleError(definition.operationId);
    }
  }

  #verifiedClaims(token: string): ConfirmationGrantClaims {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined || token.length > 4096) {
      throw new SemanticOperationConfirmationGrantError(
        'confirmation grant has an invalid envelope',
      );
    }
    const expected = createHmac('sha256', this.#confirmationKey)
      .update(payload)
      .digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, 'base64url');
    } catch {
      throw new SemanticOperationConfirmationGrantError(
        'confirmation grant signature is invalid',
      );
    }
    if (
      received.byteLength !== expected.byteLength ||
      !timingSafeEqual(received, expected)
    ) {
      throw new SemanticOperationConfirmationGrantError(
        'confirmation grant signature is invalid',
      );
    }
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new SemanticOperationConfirmationGrantError(
        'confirmation grant payload is invalid',
      );
    }
    if (!isConfirmationGrantClaims(claims)) {
      throw new SemanticOperationConfirmationGrantError(
        'confirmation grant claims are invalid',
      );
    }
    return claims;
  }
}

export class MalformedSemanticOperationRequestError extends Error {
  readonly code = 'MALFORMED_SEMANTIC_OPERATION_REQUEST' as const;
  override readonly name = 'MalformedSemanticOperationRequestError';
}

export class MalformedPinnedOperationCatalogError extends Error {
  readonly code = 'MALFORMED_PINNED_OPERATION_CATALOG' as const;
  override readonly name = 'MalformedPinnedOperationCatalogError';
}

export class SemanticOperationInvocationContextError extends Error {
  readonly code = 'SEMANTIC_OPERATION_INVOCATION_CONTEXT_INVALID' as const;
  override readonly name = 'SemanticOperationInvocationContextError';
}

export class SemanticOperationConfirmationRequiredError extends Error {
  readonly code = 'SEMANTIC_OPERATION_CONFIRMATION_REQUIRED' as const;
  override readonly name = 'SemanticOperationConfirmationRequiredError';

  constructor(readonly operationId: string) {
    super(
      `operation ${operationId} requires a server-issued confirmation grant`,
    );
  }
}

export class SemanticOperationConfirmationGrantError extends Error {
  readonly code = 'SEMANTIC_OPERATION_CONFIRMATION_INVALID' as const;
  override readonly name = 'SemanticOperationConfirmationGrantError';
}

export class SemanticOperationConfirmationStaleError extends Error {
  readonly code = 'SEMANTIC_OPERATION_CONFIRMATION_STALE' as const;
  override readonly name = 'SemanticOperationConfirmationStaleError';

  constructor(readonly operationId: string) {
    super(`confirmation grant no longer matches operation ${operationId}`);
  }
}

export class SemanticOperationExecutionFailedError extends Error {
  readonly code = 'SEMANTIC_OPERATION_EXECUTION_FAILED' as const;
  override readonly name = 'SemanticOperationExecutionFailedError';

  constructor() {
    super('semantic operation execution failed');
  }
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
    private readonly mediation: SemanticOperationMediationAuthority = new SemanticOperationMediationAuthority(),
    private readonly observePredicateReceipt:
      ((receipt: PredicateKernelReceipt) => void) | undefined = undefined,
  ) {}

  async invoke(
    view: IssuedRequestRuntimeView,
    requestInput: unknown,
    invocation: TrustedSemanticOperationInvocation,
  ): Promise<SemanticOperationResultEnvelope> {
    assertRequestRuntimeView(view);
    this.mediation.assertInvocation(view, invocation);
    let operationId = attemptedOperationId(requestInput);
    let policyDecision: 'ALLOW' | 'DENY' = 'DENY';
    let policyVersion = view.entryPolicyVersion;
    let recorded = false;
    try {
      const request = parseSemanticOperationRequest(requestInput);
      operationId = request.operationId;
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
      policyDecision = boundaryDecision.decision;
      policyVersion = boundaryDecision.policyVersion;
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
      policyDecision = operationDecision.decision;
      policyVersion = operationDecision.policyVersion;
      if (operationDecision.decision === 'DENY') {
        throw new SemanticOperationPolicyDeniedError(request.operationId, view);
      }
      this.mediation.assertConfirmationGrant(
        view,
        definition,
        request.input,
        request.confirmationGrant,
      );
      if (definition.lifecycle !== 'active' || definition.tier !== 'o0') {
        await this.#recordNonAccepted(
          view,
          invocation,
          operationId,
          'FAILED',
          'SEMANTIC_OPERATION_TIER_UNSUPPORTED',
          policyDecision,
          policyVersion,
        );
        recorded = true;
        return unsupportedOperationResult(
          request.operationId,
          'operation-tier-unsupported',
        );
      }
      // Structural admission only. The gateway answers "is this a predicate
      // this platform can execute at all"; whether it HOLDS is evaluated by
      // the generic interpreter against the record image, which the gateway
      // does not hold. Until that evaluation exists this fence is the only
      // thing standing between an authored precondition and an unguarded
      // mutation, so it refuses anything it cannot parse.
      const preconditionReceipt = admitPredicateForExecution(
        definition.precondition,
        'operationPrecondition',
      );
      observePredicateReceiptSafely(
        this.observePredicateReceipt,
        preconditionReceipt,
      );
      // Deliberately `!== 'admitted'` rather than `=== 'rejected'`: only an
      // explicit admission proceeds, so any receipt shape this gateway does
      // not recognise refuses instead of falling through.
      if (preconditionReceipt.outcome !== 'admitted') {
        await this.#recordNonAccepted(
          view,
          invocation,
          operationId,
          'FAILED',
          'SEMANTIC_OPERATION_PRECONDITION_UNSUPPORTED',
          policyDecision,
          policyVersion,
        );
        recorded = true;
        return unsupportedOperationResult(
          request.operationId,
          'operation-precondition-unsupported',
        );
      }
      const readBackDefinition = registeredQueryFromPinnedView(
        view,
        definition.readBackQueryId,
      );
      const readBackPredicateReceipt =
        readBackDefinition?.lifecycle === 'active' &&
        readBackDefinition.tier === 'q0' &&
        readBackDefinition.queryType === 'get' &&
        readBackDefinition.sourceEntityId === definition.effect.entity.targetId
          ? inspectPredicateForExecution(readBackDefinition.filter)
          : null;
      if (readBackPredicateReceipt) {
        observePredicateReceiptSafely(
          this.observePredicateReceipt,
          readBackPredicateReceipt,
        );
      }
      if (
        !readBackDefinition ||
        readBackDefinition.lifecycle !== 'active' ||
        readBackDefinition.tier !== 'q0' ||
        readBackDefinition.queryType !== 'get' ||
        readBackDefinition.sourceEntityId !==
          definition.effect.entity.targetId ||
        readBackPredicateReceipt?.outcome !== 'accepted'
      ) {
        await this.#recordNonAccepted(
          view,
          invocation,
          request.operationId,
          'FAILED',
          'SEMANTIC_OPERATION_READ_BACK_UNSUPPORTED',
          policyDecision,
          policyVersion,
        );
        recorded = true;
        return unsupportedOperationResult(
          request.operationId,
          'operation-read-back-unsupported',
        );
      }
      return await this.executor.execute(
        Object.freeze({
          channel: invocation.channel,
          context: trustedContextForRequestRuntimeView(view),
          definition,
          idempotencyKey: request.idempotencyKey,
          input: request.input,
          inputDigest: digestOperationInput(request.input),
          policyVersion: operationDecision.policyVersion,
          readBackDefinition,
          view,
        }),
      );
    } catch (error) {
      if (!recorded && this.executor) {
        const outcome =
          error instanceof SemanticOperationPolicyDeniedError
            ? 'DENIED'
            : 'FAILED';
        await this.#recordNonAccepted(
          view,
          invocation,
          operationId,
          outcome,
          stableFailureCode(error),
          outcome === 'DENIED' ? 'DENY' : policyDecision,
          policyVersion,
        );
      }
      throw typedOperationFailure(error);
    }
  }

  async #recordNonAccepted(
    view: IssuedRequestRuntimeView,
    invocation: TrustedSemanticOperationInvocation,
    operationId: string,
    outcome: 'DENIED' | 'FAILED',
    failureCode: string,
    policyDecision: 'ALLOW' | 'DENY',
    policyVersion: string,
  ): Promise<void> {
    if (!this.executor) return;
    await this.executor.recordNonAccepted(
      Object.freeze({
        channel: invocation.channel,
        context: trustedContextForRequestRuntimeView(view),
        failureCode,
        operationId,
        outcome,
        policyDecision,
        policyVersion,
        view,
      }),
    );
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
    [
      'confirmationGrant',
      'idempotencyKey',
      'input',
      'operationId',
      'schemaVersion',
    ],
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
  if (
    (value.confirmationGrant !== null &&
      typeof value.confirmationGrant !== 'string') ||
    !isUuid(value.idempotencyKey)
  ) {
    throw new MalformedSemanticOperationRequestError(
      'semantic operation mediation fields are invalid',
    );
  }
  return Object.freeze({
    confirmationGrant: value.confirmationGrant,
    idempotencyKey: value.idempotencyKey,
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
        'classification',
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
      (field.classification !== 'INTERNAL' &&
        field.classification !== 'PUBLIC') ||
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

function digestOperationInput(input: ImmutableJsonValue): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function attemptedOperationId(value: unknown): string {
  return isRecord(value) &&
    typeof value.operationId === 'string' &&
    value.operationId.length >= 5 &&
    value.operationId.length <= 180 &&
    canonicalIdPattern.test(value.operationId)
    ? value.operationId
    : MALFORMED_OPERATION_ACTION_ID;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function operationTargetBinding(input: ImmutableJsonValue): {
  readonly expectedRevision: number | null;
  readonly targetRecordId: string;
} {
  if (!isRecord(input) || typeof input.recordId !== 'string') {
    throw new MalformedSemanticOperationRequestError(
      'semantic operation input requires a target recordId',
    );
  }
  const expectedRevision = Object.hasOwn(input, 'expectedRevision')
    ? input.expectedRevision
    : null;
  if (
    expectedRevision !== null &&
    (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)
  ) {
    throw new MalformedSemanticOperationRequestError(
      'semantic operation expectedRevision is invalid',
    );
  }
  return Object.freeze({
    expectedRevision: expectedRevision as number | null,
    targetRecordId: input.recordId,
  });
}

function isConfirmationGrantClaims(
  value: unknown,
): value is ConfirmationGrantClaims {
  if (!isRecord(value)) return false;
  const keys = [
    'environmentId',
    'expectedRevision',
    'inputDigest',
    'operationId',
    'principalId',
    'releaseContentHash',
    'releaseId',
    'schemaVersion',
    'targetRecordId',
    'tenantId',
  ].sort();
  if (Object.keys(value).sort().join('\0') !== keys.join('\0')) return false;
  return (
    isUuid(value.environmentId) &&
    (value.expectedRevision === null ||
      (Number.isSafeInteger(value.expectedRevision) &&
        Number(value.expectedRevision) > 0)) &&
    typeof value.inputDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.inputDigest) &&
    typeof value.operationId === 'string' &&
    canonicalIdPattern.test(value.operationId) &&
    isUuid(value.principalId) &&
    typeof value.releaseContentHash === 'string' &&
    /^[0-9a-f]{64}$/.test(value.releaseContentHash) &&
    isUuid(value.releaseId) &&
    value.schemaVersion ===
      'northstar.semantic-operation-confirmation-grant/v1' &&
    typeof value.targetRecordId === 'string' &&
    value.targetRecordId.length > 0 &&
    isUuid(value.tenantId)
  );
}

function isInvocationChannel(
  value: unknown,
): value is TrustedInvocationChannel {
  return (
    value === 'AGENT' ||
    value === 'API' ||
    value === 'IMPORT' ||
    value === 'SYSTEM' ||
    value === 'UI' ||
    value === 'WORKFLOW'
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function stableFailureCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)
  ) {
    return error.code;
  }
  return 'SEMANTIC_OPERATION_EXECUTION_FAILED';
}

function typedOperationFailure(error: unknown): Error {
  return error instanceof Error &&
    (stableFailureCode(error) !== 'SEMANTIC_OPERATION_EXECUTION_FAILED' ||
      error instanceof RequestRuntimeViewIntegrityError)
    ? error
    : new SemanticOperationExecutionFailedError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
