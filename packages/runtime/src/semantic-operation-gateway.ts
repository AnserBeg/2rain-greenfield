import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import {
  SUPPORTED_LANGUAGE_VERSIONS,
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
export const SEMANTIC_OPERATION_POLICY_EVALUATOR_VERSION =
  'northstar.semantic-gateway-policy-evaluator/v1' as const;

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

interface RegisteredOperationDefinitionBase {
  readonly confirmation: 'humanRequired' | 'none';
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

export interface RegisteredRecordOperationDefinition extends RegisteredOperationDefinitionBase {
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
  readonly tier: 'o0';
}

export interface RegisteredCapabilityOperationDefinition extends RegisteredOperationDefinitionBase {
  readonly effect: {
    readonly capability: {
      readonly kind: string;
      readonly schemaVersion: string;
      readonly targetId: string;
    };
    readonly kind: 'registeredCapabilityEffect';
    readonly schemaVersion: string;
  };
  readonly tier: 'o1';
}

/**
 * A record transition: an O0 record effect whose next state is DECLARED by the
 * release rather than supplied by the caller. `toStateId` is the whole
 * difference from an update, and it is what makes the target server-selected --
 * the closed input contract carries no argument through which a caller could
 * name one.
 */
export interface RegisteredTransitionOperationDefinition extends RegisteredOperationDefinitionBase {
  readonly effect: {
    readonly entity: {
      readonly kind: string;
      readonly schemaVersion: string;
      readonly targetId: string;
    };
    readonly fromStateId: string;
    readonly kind: 'transitionStateEffect';
    readonly schemaVersion: string;
    readonly stateFieldId: string;
    readonly toStateId: string;
    readonly transition: {
      readonly kind: string;
      readonly schemaVersion: string;
      readonly targetId: string;
    };
  };
  readonly tier: 'o0';
}

export type RegisteredOperationDefinition =
  | RegisteredCapabilityOperationDefinition
  | RegisteredRecordOperationDefinition
  | RegisteredTransitionOperationDefinition;

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
    // Present exactly at the generation-2 versions (v3/v4). A generation-1
    // artifact is still readable, and is refused if it carries the key it never
    // declared.
    readonly targetEntityId?: string;
  }[];
  readonly schemaVersion:
    | 'northstar.module-input-contract/v1'
    | 'northstar.module-input-contract/v2'
    | 'northstar.module-input-contract/v3'
    | 'northstar.module-input-contract/v4';
  readonly systemInput?: RegisteredOperationSystemInput;
  readonly writableFieldIds: readonly string[];
}

export interface RegisteredOperationSystemInput {
  readonly argumentKey: 'legalEntityId';
  readonly classification: 'INTERNAL';
  readonly immutableAfterCreate: true;
  readonly physicalColumn: 'legal_entity_id';
  readonly required: true;
  readonly valueKind: 'uuid';
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
  // The generic executor receives transition definitions as well as record
  // definitions: a transition is executed by the same press, not by a
  // registered capability.
  readonly definition:
    | RegisteredRecordOperationDefinition
    | RegisteredTransitionOperationDefinition;
  readonly idempotencyKey: string;
  readonly input: ImmutableJsonValue;
  readonly inputDigest: string;
  readonly parentGuards: readonly SemanticOperationParentGuard[];
  readonly policyVersion: string;
  readonly readBackDefinition: RegisteredQueryDefinition;
  readonly view: IssuedRequestRuntimeView;
}

export interface RegisteredCapabilityOperationExecutionRequest {
  readonly channel: TrustedInvocationChannel;
  readonly context: TrustedRequestContext;
  readonly definition: RegisteredCapabilityOperationDefinition;
  readonly idempotencyKey: string;
  readonly input: ImmutableJsonValue;
  readonly inputDigest: string;
  readonly policyVersion: string;
  readonly policyEvaluatorVersion: typeof SEMANTIC_OPERATION_POLICY_EVALUATOR_VERSION;
  readonly readBackDefinition: RegisteredQueryDefinition;
  readonly view: IssuedRequestRuntimeView;
}

export interface SemanticOperationParentGuard {
  readonly operationId: string;
  readonly parentEntityId: string;
  readonly precondition: Readonly<Record<string, ImmutableJsonValue>>;
}

export interface SemanticOperationExecutor {
  execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope>;
  recordNonAccepted(
    request: SemanticOperationNonAcceptedRequest,
  ): Promise<void>;
}

/** Exact-ID registration for capability-backed O1 execution. */
export interface RegisteredCapabilityOperationExecutor {
  readonly capabilityId: string;
  execute(
    request: RegisteredCapabilityOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope>;
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

export interface RegisteredOperationPreconditionEvaluation {
  readonly outcome: 'holds' | 'refused' | 'unsupported';
}

/**
 * One evaluator for compiled operation preconditions over a canonical record
 * image. Surfaces use it only to decide whether to offer a command; executors
 * still evaluate the same contract against authoritative stored state.
 */
export function evaluateRegisteredOperationPrecondition(
  precondition: Readonly<Record<string, ImmutableJsonValue>>,
  image: Readonly<Record<string, ImmutableJsonValue>>,
): RegisteredOperationPreconditionEvaluation {
  try {
    const receipt = inspectPredicateForExecution(precondition, {
      bindingPosition: 'operationPrecondition',
      resolveComparison: (comparison) =>
        resolveOperationComparisonAgainstImage(comparison, image),
    });
    return Object.freeze({
      outcome:
        receipt.outcome !== 'evaluated'
          ? 'unsupported'
          : receipt.result
            ? 'holds'
            : 'refused',
    });
  } catch {
    return Object.freeze({ outcome: 'unsupported' });
  }
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
    const definition = readPinnedOperationCatalog(view).find(
      (operation) => operation.operationId === operationId,
    );
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

export class NoSuchRegisteredCapabilityError extends Error {
  readonly code = 'NO_SUCH_REGISTERED_CAPABILITY' as const;
  override readonly name = 'NoSuchRegisteredCapabilityError';

  constructor(
    readonly capabilityId: string,
    readonly operationId: string,
  ) {
    super(
      `operation ${operationId} names unregistered capability ${capabilityId}`,
    );
  }
}

/** Sole application mutation ingress for the request-pinned semantic contract. */
export class SemanticOperationGateway {
  readonly #capabilityExecutors: ReadonlyMap<
    string,
    RegisteredCapabilityOperationExecutor
  >;

  constructor(
    private readonly currentPolicy: CurrentPolicyGateway,
    private readonly executor:
      SemanticOperationExecutor | undefined = undefined,
    private readonly mediation: SemanticOperationMediationAuthority = new SemanticOperationMediationAuthority(),
    private readonly observePredicateReceipt:
      ((receipt: PredicateKernelReceipt) => void) | undefined = undefined,
    capabilityExecutors: readonly RegisteredCapabilityOperationExecutor[] = [],
  ) {
    const registrations = new Map<
      string,
      RegisteredCapabilityOperationExecutor
    >();
    for (const executor of capabilityExecutors) {
      assertCanonicalId(
        executor.capabilityId,
        'capabilityId',
        (message) => new TypeError(message),
      );
      if (registrations.has(executor.capabilityId)) {
        throw new TypeError(
          `registered capability executor is duplicated: ${executor.capabilityId}`,
        );
      }
      registrations.set(executor.capabilityId, executor);
    }
    this.#capabilityExecutors = registrations;
  }

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

      const operationCatalog = readPinnedOperationCatalog(view);
      const definition = operationCatalog.find(
        (operation) => operation.operationId === request.operationId,
      );
      if (!definition) {
        throw new NoSuchRegisteredOperationError(request.operationId, view);
      }
      // The gateway owns the closed-argument fence for every operation whose
      // declared contract admits no caller-supplied values -- a capability
      // command and a record transition alike. Both were already refused, but
      // a transition's refusal came one layer down, which meant an argument the
      // declared contract forbids travelled further than it should before
      // anything rejected it. The inner check stays; two fences on a closed
      // contract is defence in depth, and the outer one belongs where the
      // contract is read.
      if (
        isRegisteredCapabilityOperation(definition) ||
        isRegisteredTransitionOperation(definition)
      ) {
        assertClosedOperationArguments(definition, request.input);
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
      if (definition.lifecycle !== 'active') {
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
      const recordEffectEntityId =
        definition.effect.kind === 'registeredCapabilityEffect'
          ? null
          : definition.effect.entity.targetId;
      const readBackPredicateReceipt =
        readBackDefinition?.lifecycle === 'active' &&
        readBackDefinition.tier === 'q0' &&
        readBackDefinition.queryType === 'get' &&
        (recordEffectEntityId === null ||
          readBackDefinition.sourceEntityId === recordEffectEntityId)
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
        (recordEffectEntityId !== null &&
          readBackDefinition.sourceEntityId !== recordEffectEntityId) ||
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
      const commonExecution = {
        channel: invocation.channel,
        context: trustedContextForRequestRuntimeView(view),
        definition,
        idempotencyKey: request.idempotencyKey,
        input: request.input,
        inputDigest: digestOperationInput(request.input),
        policyVersion: operationDecision.policyVersion,
        readBackDefinition,
        view,
      } as const;
      if (isRegisteredCapabilityOperation(definition)) {
        const capabilityExecutor = this.#capabilityExecutors.get(
          definition.effect.capability.targetId,
        );
        if (!capabilityExecutor) {
          throw new NoSuchRegisteredCapabilityError(
            definition.effect.capability.targetId,
            definition.operationId,
          );
        }
        return await capabilityExecutor.execute(
          Object.freeze({
            ...commonExecution,
            policyEvaluatorVersion: SEMANTIC_OPERATION_POLICY_EVALUATOR_VERSION,
          }) as RegisteredCapabilityOperationExecutionRequest,
        );
      }
      if (!this.executor) {
        throw new NoSuchRegisteredOperationError(request.operationId, view);
      }
      return await this.executor.execute(
        Object.freeze({
          ...commonExecution,
          definition,
          parentGuards: parentGuardsFromCatalog(operationCatalog),
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

function assertClosedOperationArguments(
  definition: RegisteredOperationDefinition,
  value: ImmutableJsonValue,
): void {
  const contract = definition.inputContract;
  if (!contract) return;
  if (!isRecord(value)) {
    throw new MalformedSemanticOperationRequestError(
      'semantic operation input must be an object',
    );
  }
  const admitted = new Set(contract.closedArgumentKeys);
  if (Object.keys(value).some((key) => !admitted.has(key))) {
    throw new MalformedSemanticOperationRequestError(
      'semantic operation input contains a key outside its compiled contract',
    );
  }
}

function readPinnedOperationCatalog(
  view: IssuedRequestRuntimeView,
): readonly RegisteredOperationDefinition[] {
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
  const operations: RegisteredOperationDefinition[] = [];
  for (const operation of payload.operations) {
    assertOperationDefinition(operation);
    if (operationIds.has(operation.operationId)) {
      throw new MalformedPinnedOperationCatalogError(
        'pinned operation catalog contains a duplicate operationId',
      );
    }
    operationIds.add(operation.operationId);
    operations.push(operation);
  }
  return Object.freeze(operations);
}

function isRegisteredCapabilityOperation(
  definition: RegisteredOperationDefinition,
): definition is RegisteredCapabilityOperationDefinition {
  return definition.effect.kind === 'registeredCapabilityEffect';
}

function isRegisteredTransitionOperation(
  definition: RegisteredOperationDefinition,
): definition is RegisteredTransitionOperationDefinition {
  return definition.effect.kind === 'transitionStateEffect';
}

function parentGuardsFromCatalog(
  operations: readonly RegisteredOperationDefinition[],
): readonly SemanticOperationParentGuard[] {
  return Object.freeze(
    operations.flatMap((operation) =>
      operation.lifecycle === 'active' &&
      operation.effect.kind === 'updateRecordEffect'
        ? [
            Object.freeze({
              operationId: operation.operationId,
              parentEntityId: operation.effect.entity.targetId,
              precondition: operation.precondition,
            }),
          ]
        : [],
    ),
  );
}

/**
 * A malformed catalog entry refuses the WHOLE catalog, deliberately: this is an
 * artifact-integrity fence, and an artifact with one entry the runtime cannot
 * parse is not an artifact one entry of which can be trusted. Narrowing it to
 * "skip the bad entry" would let a tampered projection serve.
 *
 * What was a defect is that it refused ANONYMOUSLY. An unrelated create
 * operation died with `object keys do not match the closed contract`, naming
 * neither the operation at fault nor its effect, which is the misnamed-cause
 * failure [ADR-0046](../../../docs/decisions/ADR-0046-rollback-activates-history-and-defects-refuse-by-name.md)
 * forbids and ADR-0050 §1 measured. Every refusal below now names its subject.
 *
 * The reachable cause is closed separately and earlier:
 * `COMPILER_TRANSITION_EFFECT_UNSUPPORTED` refuses the only known way to build
 * such a release, at compile time, before any of it is persisted.
 */
/**
 * ONE parser for every canonical reference the pinned catalog carries.
 *
 * Three arms of `assertOperationDefinition` each grew their own shallow copy of
 * this -- `assertExactKeys` plus a `targetId` check -- and all three admitted a
 * reference whose `kind` was for something else entirely: an `effect.entity`
 * declaring `fieldReference`, an `effect.transition` declaring `queryReference`,
 * either at an invented `schemaVersion`. Nothing downstream noticed, because the
 * interpreter resolves from `targetId` and never consults the other two fields.
 * A fence that reads only the field it later uses is not checking the artifact,
 * it is trusting it.
 *
 * `expectedKind` is required rather than inferred, and the node version must be
 * an admitted one AND equal to the effect that encloses it -- node-version
 * purity is a property of the artifact, so a reference disagreeing with its own
 * effect is a reference no released artifact could have carried.
 */
function assertCanonicalReference(
  value: unknown,
  expectedKind: string,
  effectSchemaVersion: string,
  path: string,
  invalid: (message: string) => Error,
): asserts value is {
  readonly kind: string;
  readonly schemaVersion: string;
  readonly targetId: string;
} {
  if (!isRecord(value)) {
    throw invalid(`${path} must be an object`);
  }
  assertExactKeys(value, ['kind', 'schemaVersion', 'targetId'], invalid);
  assertCanonicalId(value.targetId, `${path}.targetId`, invalid);
  if (value.kind !== expectedKind) {
    throw invalid(`${path}.kind must be ${expectedKind}`);
  }
  if (
    typeof value.schemaVersion !== 'string' ||
    !(SUPPORTED_LANGUAGE_VERSIONS as readonly string[]).includes(
      value.schemaVersion,
    ) ||
    value.schemaVersion !== effectSchemaVersion
  ) {
    throw invalid(`${path}.schemaVersion must match its effect`);
  }
}

function assertOperationDefinition(
  value: unknown,
): asserts value is RegisteredOperationDefinition {
  const subject =
    isRecord(value) && typeof value.operationId === 'string'
      ? value.operationId
      : '<unidentified operation>';
  const effectKind =
    isRecord(value) &&
    isRecord(value.effect) &&
    typeof value.effect.kind === 'string'
      ? value.effect.kind
      : '<unidentified effect>';
  const invalid = (message: string): MalformedPinnedOperationCatalogError =>
    new MalformedPinnedOperationCatalogError(
      `${message} (operation ${subject}, effect ${effectKind})`,
    );
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
  if (value.effect.kind === 'registeredCapabilityEffect') {
    assertExactKeys(
      value.effect,
      ['capability', 'kind', 'schemaVersion'],
      invalid,
    );
    if (
      value.tier !== 'o1' ||
      !isRecord(value.effect.capability) ||
      typeof value.effect.schemaVersion !== 'string'
    ) {
      throw invalid('pinned capability operation effect is unsupported');
    }
    assertCanonicalReference(
      value.effect.capability,
      'capabilityReference',
      value.effect.schemaVersion,
      'effect.capability',
      invalid,
    );
  } else if (value.effect.kind === 'transitionStateEffect') {
    // The transition arm keeps the O0 fence the record arm below states: an
    // entity-less effect is still refused, and the entity reference is still
    // required in full. What it additionally admits is a SERVER-SELECTED
    // target -- `toStateId` is declared, never an argument -- over the same
    // closed ['expectedRevision','recordId'] contract the release already
    // carried for this effect kind before anything executed it.
    assertExactKeys(
      value.effect,
      [
        'entity',
        'fromStateId',
        'kind',
        'schemaVersion',
        'stateFieldId',
        'toStateId',
        'transition',
      ],
      invalid,
    );
    // Every nested reference is checked to the same depth the record arm
    // below checks its entity. Leaving `schemaVersion` untyped and the two
    // references unshaped admitted `{ ...valid, schemaVersion: 7,
    // transition: null }`: the flattened ids still parsed, so it EXECUTED --
    // a malformed artifact reaching the writer because the fence read only
    // the fields it happened to use.
    if (
      value.tier !== 'o0' ||
      typeof value.effect.schemaVersion !== 'string' ||
      !isRecord(value.effect.entity) ||
      !isRecord(value.effect.transition)
    ) {
      throw invalid('pinned transition operation effect is unsupported');
    }
    assertCanonicalReference(
      value.effect.entity,
      'entityReference',
      value.effect.schemaVersion,
      'effect.entity',
      invalid,
    );
    assertCanonicalReference(
      value.effect.transition,
      'transitionReference',
      value.effect.schemaVersion,
      'effect.transition',
      invalid,
    );
    assertCanonicalId(
      value.effect.stateFieldId,
      'effect.stateFieldId',
      invalid,
    );
    assertCanonicalId(value.effect.fromStateId, 'effect.fromStateId', invalid);
    assertCanonicalId(value.effect.toStateId, 'effect.toStateId', invalid);
  } else {
    // Load-bearing O0 fence: capability admission must never make an entity-
    // less record effect valid. The complete entity reference remains required
    // inside this record-only arm.
    assertExactKeys(value.effect, ['entity', 'kind', 'schemaVersion'], invalid);
    if (
      value.tier !== 'o0' ||
      !isRecord(value.effect.entity) ||
      ![
        'archiveRecordEffect',
        'createRecordEffect',
        'restoreRecordEffect',
        'updateRecordEffect',
      ].includes(String(value.effect.kind)) ||
      typeof value.effect.schemaVersion !== 'string'
    ) {
      throw invalid('pinned record operation effect is unsupported');
    }
    assertCanonicalReference(
      value.effect.entity,
      'entityReference',
      value.effect.schemaVersion,
      'effect.entity',
      invalid,
    );
  }
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
  if (hasInputContract) {
    assertOperationInputContract(value.inputContract);
    const createEffect = value.effect.kind === 'createRecordEffect';
    const version = value.inputContract.schemaVersion;
    if (
      (version === 'northstar.module-input-contract/v2' ||
        version === 'northstar.module-input-contract/v4') &&
      !createEffect
    ) {
      throw invalid(
        'pinned operation system input is admitted only on create effects',
      );
    }
    // ADR-0052 s4 says relations are create-only, and the provider ENFORCES
    // that by hardcoding `relations: {}` on every non-create branch. Until this
    // check existed the catalog parser did not, so a fully shaped contract
    // declaring a REQUIRED relation on an update effect was admitted -- and the
    // provider then validated its hardcoded empty relations against that
    // declaration, making every update of that entity unsatisfiable by any
    // representable input. An optional one was admitted and silently ignored.
    // Both are ADR-0041's accepted-and-ignored state, so the artifact is
    // refused here rather than discovered at execution.
    if (value.inputContract.relationInputs.length > 0 && !createEffect) {
      throw invalid(
        'pinned relation inputs are admitted only on create effects',
      );
    }
    if (
      (version === 'northstar.module-input-contract/v3' ||
        version === 'northstar.module-input-contract/v4') &&
      !createEffect
    ) {
      throw invalid(
        'pinned relation targets are admitted only on create effects',
      );
    }
    // The closed argument key and the declaration must agree in both
    // directions, so a contract cannot accept a `relations` argument it never
    // declares, nor declare relations it gives the caller no key to supply.
    if (
      value.inputContract.closedArgumentKeys.includes('relations') !==
      createEffect
    ) {
      throw invalid(
        'pinned relation argument key and operation effect disagree',
      );
    }
  }
}

export interface PinnedRelationInput {
  readonly archiveBehavior: 'restrict' | 'retainReference';
  readonly relationId: string;
  readonly required: boolean;
  readonly targetEntityId: string | null;
}

/**
 * The ONE authority on what a pinned relation input may say, and the ONLY place
 * relation inputs are validated anywhere in the platform.
 *
 * This gateway and the browser's surface contract both consume relation inputs.
 * A prior attempt exported a parser that validated a strict SUBSET of what this
 * gateway checked and left the gateway's own loop in place; the browser then
 * accepted five single-property forgeries the gateway refused, and deleting the
 * shared call removed no gateway check at all. So this function is deliberately
 * COMPLETE and the gateway keeps no second loop: delete the call below and the
 * gateway stops validating relation inputs entirely, which is what makes the
 * shared authority load-bearing rather than decorative.
 *
 * `targetEntityId` is carried on EVERY relation input iff the contract is v3 or
 * v4. A non-empty relation list does NOT imply v3/v4 — a generation-1 artifact
 * may legitimately declare relations without targets, and refusing those would
 * break every historical contract.
 */
export function parsePinnedRelationInputs(
  inputContract: unknown,
  fail: (message: string) => Error,
): readonly PinnedRelationInput[] {
  if (!isRecord(inputContract)) {
    throw fail('pinned operation input contract must be an object');
  }
  const schemaVersion = inputContract.schemaVersion;
  const carriesTargets =
    schemaVersion === 'northstar.module-input-contract/v3' ||
    schemaVersion === 'northstar.module-input-contract/v4';
  if (
    schemaVersion !== 'northstar.module-input-contract/v1' &&
    schemaVersion !== 'northstar.module-input-contract/v2' &&
    !carriesTargets
  ) {
    throw fail('pinned operation input contract declares an unknown version');
  }
  const relationInputs = inputContract.relationInputs;
  if (!Array.isArray(relationInputs)) {
    throw fail('pinned operation input contract has an invalid shape');
  }
  // A version claiming to carry relation targets must have a relation to carry
  // them on, so v3/v4 cannot be minted vacuously.
  if (carriesTargets && relationInputs.length === 0) {
    throw fail(
      'pinned operation input contract declares relation targets without a relation',
    );
  }
  return Object.freeze(
    relationInputs.map((relation) => {
      if (!isRecord(relation)) {
        throw fail('pinned relation input contract must be an object');
      }
      assertExactKeys(
        relation,
        carriesTargets
          ? ['archiveBehavior', 'relationId', 'required', 'targetEntityId']
          : ['archiveBehavior', 'relationId', 'required'],
        fail,
      );
      assertCanonicalId(
        relation.relationId,
        'inputContract.relationInputs.relationId',
        fail,
      );
      if (carriesTargets) {
        assertCanonicalId(
          relation.targetEntityId,
          'inputContract.relationInputs.targetEntityId',
          fail,
        );
      }
      if (
        (relation.archiveBehavior !== 'restrict' &&
          relation.archiveBehavior !== 'retainReference') ||
        typeof relation.required !== 'boolean'
      ) {
        throw fail('pinned relation input contract has an invalid shape');
      }
      return Object.freeze({
        archiveBehavior: relation.archiveBehavior,
        relationId: relation.relationId,
        required: relation.required,
        targetEntityId: carriesTargets
          ? (relation.targetEntityId as string)
          : null,
      });
    }),
  );
}

function assertOperationInputContract(
  value: unknown,
): asserts value is RegisteredOperationInputContract {
  const invalid = (message: string): MalformedPinnedOperationCatalogError =>
    new MalformedPinnedOperationCatalogError(message);
  if (!isRecord(value)) {
    throw invalid('pinned operation input contract must be an object');
  }
  const hasSystemInput = Object.hasOwn(value, 'systemInput');
  assertExactKeys(
    value,
    [
      'closedArgumentKeys',
      'fields',
      'relationInputs',
      'schemaVersion',
      ...(hasSystemInput ? ['systemInput'] : []),
      'writableFieldIds',
    ],
    invalid,
  );
  if (
    (value.schemaVersion !== 'northstar.module-input-contract/v1' &&
      value.schemaVersion !== 'northstar.module-input-contract/v2' &&
      value.schemaVersion !== 'northstar.module-input-contract/v3' &&
      value.schemaVersion !== 'northstar.module-input-contract/v4') ||
    hasSystemInput !==
      (value.schemaVersion === 'northstar.module-input-contract/v2' ||
        value.schemaVersion === 'northstar.module-input-contract/v4') ||
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
  // The ONLY relation-input validation in this gateway. Deliberately not
  // duplicated here: a second loop is how the browser and this gateway drifted
  // into admitting different artifacts.
  parsePinnedRelationInputs(value, invalid);
  if (hasSystemInput) {
    if (!isRecord(value.systemInput)) {
      throw invalid('pinned operation system input must be an object');
    }
    assertExactKeys(
      value.systemInput,
      [
        'argumentKey',
        'classification',
        'immutableAfterCreate',
        'physicalColumn',
        'required',
        'valueKind',
      ],
      invalid,
    );
    if (
      value.systemInput.argumentKey !== 'legalEntityId' ||
      value.systemInput.classification !== 'INTERNAL' ||
      value.systemInput.immutableAfterCreate !== true ||
      value.systemInput.physicalColumn !== 'legal_entity_id' ||
      value.systemInput.required !== true ||
      value.systemInput.valueKind !== 'uuid' ||
      !value.closedArgumentKeys.includes(value.systemInput.argumentKey)
    ) {
      throw invalid('pinned operation system input has an invalid shape');
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

function resolveOperationComparisonAgainstImage(
  comparison: { field: { targetId: string }; operator: string; value: unknown },
  image: Readonly<Record<string, ImmutableJsonValue>>,
): { presence: 'absent' } | { presence: 'present'; result: boolean } {
  const actual = Object.hasOwn(image, comparison.field.targetId)
    ? image[comparison.field.targetId]
    : undefined;
  if (actual === undefined || actual === null) return { presence: 'absent' };
  if (
    typeof comparison.value !== 'object' ||
    comparison.value === null ||
    !('value' in comparison.value)
  ) {
    throw new TypeError('precondition comparison operand is not a scalar');
  }
  const expected = (comparison.value as { value: unknown }).value;
  const scalarKind = (comparison.value as { kind?: unknown }).kind;
  // Raw `===` is sound only when persistence returns the canonical operand
  // byte-for-byte. A false equality makes `not(equals)` admit, so widening this
  // set requires a codec round-trip proof. Numeric(p,s) preserves scale while
  // temporal codecs may add milliseconds; both therefore remain refused until
  // field-contract-aware canonicalization exists.
  if (
    typeof scalarKind !== 'string' ||
    !new Set(['booleanValue', 'integerValue', 'textValue']).has(scalarKind)
  ) {
    throw new TypeError(
      `precondition comparison operand kind ${String(scalarKind)} has no canonical equality`,
    );
  }
  switch (comparison.operator) {
    case 'equals':
      return { presence: 'present', result: actual === expected };
    case 'notEquals':
      return { presence: 'present', result: actual !== expected };
    case 'lessThan':
    case 'greaterThan':
    case 'lessThanOrEqual':
    case 'greaterThanOrEqual': {
      if (
        (typeof actual !== 'string' && typeof actual !== 'number') ||
        typeof expected !== typeof actual
      ) {
        throw new TypeError('precondition ordering operands are not ordered');
      }
      const ordered = expected as string | number;
      return {
        presence: 'present',
        result:
          comparison.operator === 'lessThan'
            ? actual < ordered
            : comparison.operator === 'greaterThan'
              ? actual > ordered
              : comparison.operator === 'lessThanOrEqual'
                ? actual <= ordered
                : actual >= ordered,
      };
    }
    default:
      throw new TypeError('precondition comparison operator is not admitted');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
