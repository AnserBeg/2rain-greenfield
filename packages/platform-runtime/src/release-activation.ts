import type {
  MintedUuid,
  TenantEnvironmentIdentity,
} from './release-records.js';

export const APPROVAL_CONTRACT_VERSION =
  'northstar.release-approval/v1' as const;
export const ACTIVATION_ATTEMPT_CONTRACT_VERSION =
  'northstar.release-activation-attempt/v1' as const;
export const ACTIVATION_OUTCOME_VERSION =
  'northstar.release-activation-outcome/v1' as const;
export const ACTIVATION_PHASE_RECEIPT_VERSION =
  'northstar.release-activation-phase-receipt/v1' as const;
export const ACTIVATION_HISTORY_VERSION =
  'northstar.release-activation-history/v1' as const;
export const ACTIVATION_OUTBOX_ENVELOPE_VERSION =
  'northstar.release-activation-outbox/v1' as const;
export const ACTIVATION_SWAP_RECEIPT_VERSION =
  'northstar.release-activation-swap-receipt/v1' as const;
export const ACTIVATION_VERIFICATION_RECEIPT_VERSION =
  'northstar.release-activation-verification/v1' as const;
export const ACTIVATION_RECONCILIATION_ALARM_VERSION =
  'northstar.release-activation-reconciliation-alarm/v1' as const;
export const ACTIVATION_INVALIDATION_EVENT_VERSION =
  'northstar.release-activation-invalidation/v1' as const;
export const ACTIVATION_INVALIDATION_EVENT_CODE =
  'ACTIVE_RELEASE_POINTER_CHANGED' as const;
export const RELEASE_EXECUTOR_AUTHORITY_POLICY_VERSION =
  'northstar.release-executor-authority/v1' as const;
export const RELEASE_ACTIVATION_CONTROL_POLICY_VERSION =
  'northstar.release-activation-control/v1' as const;
export const APPROVER_AUTHORITY_POLICY_VERSION =
  'northstar.release-approver-authority/v1' as const;
export const APPROVAL_EXPIRY_POLICY_VERSION =
  'northstar.release-approval-expiry/v1' as const;
export const APPROVAL_DEFAULT_EXPIRY_MILLISECONDS = 24 * 60 * 60 * 1000;
export const APPROVAL_MAX_EXPIRY_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
/** Greater than the bounded two-second backward wall-clock step. */
export const APPROVAL_EXPIRY_SKEW_MARGIN_MILLISECONDS = 3_000;
export const RECONCILIATION_MAX_AGE_MILLISECONDS = 5 * 60 * 1000;
export const INITIAL_ACTIVATION_BINDING_VERSION =
  'northstar.initial-activation-binding/v1' as const;
export const RELEASE_DIFF_BINDING_VERSION =
  'northstar.release-diff-binding/v1' as const;
export const TRANSITION_PREPARATION_RECEIPT_VERSION =
  'northstar.transition-preparation-receipt/v1' as const;
export const COMPILER_TRANSITION_FACTS_VERSION =
  'northstar.compiler-transition-facts/v1' as const;
export const EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION =
  'northstar.executor-applied-state-evidence/v1' as const;
export const TRANSITION_COMPATIBILITY_POLICY_VERSION =
  'northstar.transition-compatibility-policy/v1' as const;
export const ROLLOUT_CONTROL_POLICY_VERSION =
  'northstar.rollout-control-deny-only/v1' as const;

/** A reserved non-human identity for future dispatcher/reconciler mechanics. */
export const SYSTEM_EXECUTION_PRINCIPAL = Object.freeze({
  kind: 'SYSTEM' as const,
  principalId: '00000000-0000-4000-8000-000000000001',
  version: 'northstar.system-execution-principal/v1' as const,
});

export type TransitionScope = 'sharedDatabase' | 'tenantLocal';
export type CompilerTransitionClass =
  'IRREVERSIBLE' | 'NO_STORAGE_TRANSITION' | 'REVERSIBLE';
export type ExecutorAppliedState =
  'APPLIED' | 'NOT_APPLIED' | 'NOT_REQUIRED' | 'UNKNOWN';
export type CompatibilityVerdict = 'ALLOW' | 'DENY';
export type RecoveryMode =
  'FORWARD_RECOVERY_ONLY' | 'NO_STORAGE_RECOVERY_REQUIRED' | 'REVERSIBLE';

export interface TransitionCompatibilityInput {
  readonly compilerExactPair: boolean;
  readonly compilerFactsVersion: string;
  readonly compilerStaticCompatibility: 'BLOCKED' | 'SATISFIED';
  readonly compilerTransitionClass: CompilerTransitionClass;
  readonly executorAppliedState: ExecutorAppliedState;
  readonly executorEvidenceVersion: string;
  readonly executorExactPair: boolean;
  readonly policyVersion: string;
  readonly sourceManifestRoot: Uint8Array | null;
  readonly targetManifestRoot: Uint8Array;
}

export interface TransitionCompatibilityDecision {
  readonly policyVersion: typeof TRANSITION_COMPATIBILITY_POLICY_VERSION;
  readonly recoveryMode: RecoveryMode;
  readonly verdict: CompatibilityVerdict;
}

/**
 * The versioned policy is the sole allow/deny contributor. Compiler facts and
 * executor evidence are factual inputs; neither is itself an authorization.
 */
export function evaluateTransitionCompatibility(
  input: TransitionCompatibilityInput,
): TransitionCompatibilityDecision {
  if (
    input.policyVersion !== TRANSITION_COMPATIBILITY_POLICY_VERSION ||
    input.compilerFactsVersion !== COMPILER_TRANSITION_FACTS_VERSION ||
    input.executorEvidenceVersion !== EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION
  ) {
    throw new Error('unsupported transition compatibility contract version');
  }
  if (input.targetManifestRoot.byteLength !== 32) {
    throw new Error('target manifest root must be an exact SHA-256 digest');
  }
  if (
    input.sourceManifestRoot !== null &&
    input.sourceManifestRoot.byteLength !== 32
  ) {
    throw new Error(
      'source manifest root must be null or an exact SHA-256 digest',
    );
  }

  const executorStateSatisfied =
    input.compilerTransitionClass === 'NO_STORAGE_TRANSITION'
      ? input.executorAppliedState === 'NOT_REQUIRED'
      : input.executorAppliedState === 'APPLIED';
  const verdict =
    input.compilerExactPair &&
    input.executorExactPair &&
    input.compilerStaticCompatibility === 'SATISFIED' &&
    executorStateSatisfied
      ? 'ALLOW'
      : 'DENY';
  const recoveryMode =
    input.compilerTransitionClass === 'IRREVERSIBLE'
      ? 'FORWARD_RECOVERY_ONLY'
      : input.compilerTransitionClass === 'NO_STORAGE_TRANSITION'
        ? 'NO_STORAGE_RECOVERY_REQUIRED'
        : 'REVERSIBLE';
  return Object.freeze({
    policyVersion: TRANSITION_COMPATIBILITY_POLICY_VERSION,
    recoveryMode,
    verdict,
  });
}

export interface InitialActivationBinding {
  readonly bindingKind: 'INITIAL_ACTIVATION';
  readonly bindingVersion: typeof INITIAL_ACTIVATION_BINDING_VERSION;
  readonly canonicalDiffDigest: Uint8Array;
  readonly releaseDiffAlgorithmVersion: null;
  readonly releaseDiffVersion: null;
  readonly sourceManifestRoot: null;
  readonly sourceReleaseId: null;
  readonly transitionPlanDigest: null;
}

export interface ExistingReleaseDiffBinding {
  readonly bindingKind: 'RELEASE_DIFF';
  readonly bindingVersion: typeof RELEASE_DIFF_BINDING_VERSION;
  readonly canonicalDiffDigest: Uint8Array;
  readonly releaseDiffAlgorithmVersion: string;
  readonly releaseDiffVersion: string;
  readonly sourceManifestRoot: Uint8Array;
  readonly sourceReleaseId: MintedUuid;
  readonly transitionPlanDigest: Uint8Array | null;
}

export type ApprovalDiffBinding =
  ExistingReleaseDiffBinding | InitialActivationBinding;

export interface TransitionPreparationReceipt extends TenantEnvironmentIdentity {
  readonly compilerExactPair: boolean;
  readonly compilerFactsDigest: Uint8Array;
  readonly compilerFactsVersion: string;
  readonly compilerStaticCompatibility: 'BLOCKED' | 'SATISFIED';
  readonly compilerTransitionClass: CompilerTransitionClass;
  readonly createdAt: string;
  readonly executorAppliedState: ExecutorAppliedState;
  readonly executorEvidenceDigest: Uint8Array;
  readonly executorEvidenceVersion: string;
  readonly executorExactPair: boolean;
  readonly policyVerdict: CompatibilityVerdict;
  readonly policyVersion: string;
  readonly receiptId: MintedUuid;
  readonly receiptVersion: typeof TRANSITION_PREPARATION_RECEIPT_VERSION;
  readonly recoveryMode: RecoveryMode;
  readonly schemaGeneration: number;
  readonly sourceManifestRoot: Uint8Array | null;
  readonly sourceReleaseId: MintedUuid | null;
  readonly storageDomainId: string;
  readonly targetManifestRoot: Uint8Array;
  readonly targetReleaseId: MintedUuid;
  readonly transitionScope: TransitionScope;
}

export interface CanonicalReleasePreparation extends TenantEnvironmentIdentity {
  readonly binding: ApprovalDiffBinding;
  readonly capabilitySupportDigest: Uint8Array;
  readonly capabilitySupportResult: 'SUPPORTED' | 'UNSUPPORTED';
  readonly capabilitySupportVersion: string;
  readonly compilerAttestationDigest: Uint8Array;
  readonly compilerOutputProtocolVersion: string;
  readonly compilerSemanticProfileVersion: string;
  readonly compilerVersion: string;
  readonly createdAt: string;
  readonly expectedFence: number;
  readonly expectedPointerId: MintedUuid;
  readonly preparationId: MintedUuid;
  readonly preparationVersion: string;
  readonly renderedDiffEvidenceDigest: Uint8Array;
  readonly rendererVersion: string;
  readonly targetManifestRoot: Uint8Array;
  readonly targetReleaseId: MintedUuid;
  readonly transitionPreparationReceiptId: MintedUuid;
  readonly verificationEvidenceDigest: Uint8Array;
  readonly verificationEvidenceId: MintedUuid;
  readonly verificationEvidenceVersion: string;
  readonly viewSchemaVersion: string;
}

export interface CreateReleaseApprovalCommand {
  readonly activationAttemptId: MintedUuid;
  readonly approvalId: MintedUuid;
  readonly approvingHumanId: string;
  readonly expiresAt?: string;
  readonly initiatingHumanId: string;
  readonly issuingActorId: string;
  readonly preparationId: MintedUuid;
  readonly rolloutId?: MintedUuid;
  readonly sourceDecisionId?: MintedUuid;
  readonly targetReleaseId: MintedUuid;
}

export interface ReleaseApproval extends TenantEnvironmentIdentity {
  readonly activationAttemptId: MintedUuid;
  readonly approvalContractVersion: typeof APPROVAL_CONTRACT_VERSION;
  readonly approvalId: MintedUuid;
  readonly authorityPolicyVersion: number;
  readonly authorityPolicyContractVersion: typeof APPROVER_AUTHORITY_POLICY_VERSION;
  readonly approvingHumanId: string;
  readonly binding: ApprovalDiffBinding;
  readonly capabilitySupportDigest: Uint8Array;
  readonly capabilitySupportVersion: string;
  readonly compilerAttestationDigest: Uint8Array;
  readonly compilerOutputProtocolVersion: string;
  readonly compilerSemanticProfileVersion: string;
  readonly compilerVersion: string;
  readonly compatibilityPolicyVersion: typeof TRANSITION_COMPATIBILITY_POLICY_VERSION;
  readonly decidedAt: string;
  readonly expectedFence: number;
  readonly expectedPointerId: MintedUuid;
  readonly expiresAt: string;
  readonly expiryPolicyVersion: typeof APPROVAL_EXPIRY_POLICY_VERSION;
  readonly initiatingHumanId: string;
  readonly issuingActorId: string;
  readonly preparationId: MintedUuid;
  readonly renderedDiffEvidenceDigest: Uint8Array;
  readonly rendererVersion: string;
  readonly rolloutId: MintedUuid | null;
  readonly sourceDecisionId: MintedUuid | null;
  readonly targetManifestRoot: Uint8Array;
  readonly targetReleaseId: MintedUuid;
  readonly transitionPreparationReceiptId: MintedUuid;
  readonly verificationEvidenceDigest: Uint8Array;
  readonly verificationEvidenceId: MintedUuid;
  readonly verificationEvidenceVersion: string;
  readonly viewSchemaVersion: string;
}

export interface ReleaseActivationAttempt extends TenantEnvironmentIdentity {
  readonly activationAttemptId: MintedUuid;
  readonly approvalId: MintedUuid;
  readonly attemptContractVersion: typeof ACTIVATION_ATTEMPT_CONTRACT_VERSION;
  readonly createdAt: string;
  readonly executionPrincipalId: string;
  readonly executionPrincipalKind: 'SYSTEM';
  readonly state: 'PREBOUND';
}

export interface CreatedReleaseApproval {
  readonly approval: ReleaseApproval;
  readonly attempt: ReleaseActivationAttempt;
}

export type PointerOutcome =
  | 'AMBIGUOUS'
  | 'NOT_ATTEMPTED'
  | 'NOT_SWAPPED'
  | 'SWAPPED'
  | 'SWAPPED_THEN_SUPERSEDED';
export type VerificationOutcome = 'FAILED' | 'NOT_RUN' | 'PASSED' | 'UNKNOWN';
export type WorkflowDisposition = 'CONSUMED' | 'RETAINED';
export type WorkflowStatus =
  'CANCELLED' | 'FAILED' | 'PAUSED' | 'RECONCILING' | 'RUNNING' | 'SUCCEEDED';

export interface ReleaseActivationOutcomeDimensions {
  readonly outcomeVersion: typeof ACTIVATION_OUTCOME_VERSION;
  readonly pointerOutcome: PointerOutcome;
  readonly terminal: boolean;
  readonly verificationOutcome: VerificationOutcome;
  readonly workflowDisposition: WorkflowDisposition;
  readonly workflowStatus: WorkflowStatus;
}

export type ActivationTransitionCondition =
  | 'AMBIGUOUS_COMMIT'
  | 'APPROVER_REVOCATION'
  | 'CANCELLATION'
  | 'DEFINITIVE_BLOCKING_FAILURE'
  | 'EXECUTOR_UNAVAILABLE'
  | 'EXPIRED_APPROVAL'
  | 'INFRASTRUCTURE_ERROR'
  | 'INVALID_BINDING'
  | 'LOST_RACE'
  | 'OBSOLETE_POLICY'
  | 'PRE_CAS_POLICY_DENY'
  | 'ROLLOUT_PAUSE'
  | 'STALE_POINTER'
  | 'TIMEOUT';

type TransitionClassification = Readonly<{
  approvalDisposition: WorkflowDisposition;
  resumable: boolean;
  terminal: boolean;
  workflowStatus: WorkflowStatus;
}>;

export const ACTIVATION_TRANSITION_CLASSIFICATIONS = Object.freeze({
  AMBIGUOUS_COMMIT: {
    approvalDisposition: 'RETAINED',
    resumable: true,
    terminal: false,
    workflowStatus: 'RECONCILING',
  },
  APPROVER_REVOCATION: {
    approvalDisposition: 'CONSUMED',
    resumable: false,
    terminal: true,
    workflowStatus: 'FAILED',
  },
  CANCELLATION: {
    approvalDisposition: 'CONSUMED',
    resumable: false,
    terminal: true,
    workflowStatus: 'CANCELLED',
  },
  DEFINITIVE_BLOCKING_FAILURE: {
    approvalDisposition: 'CONSUMED',
    resumable: false,
    terminal: true,
    workflowStatus: 'FAILED',
  },
  EXECUTOR_UNAVAILABLE: {
    approvalDisposition: 'RETAINED',
    resumable: true,
    terminal: false,
    workflowStatus: 'RUNNING',
  },
  EXPIRED_APPROVAL: {
    approvalDisposition: 'CONSUMED',
    resumable: false,
    terminal: true,
    workflowStatus: 'FAILED',
  },
  INFRASTRUCTURE_ERROR: {
    approvalDisposition: 'RETAINED',
    resumable: true,
    terminal: false,
    workflowStatus: 'RUNNING',
  },
  INVALID_BINDING: {
    approvalDisposition: 'CONSUMED',
    resumable: false,
    terminal: true,
    workflowStatus: 'FAILED',
  },
  LOST_RACE: {
    approvalDisposition: 'CONSUMED',
    resumable: false,
    terminal: true,
    workflowStatus: 'FAILED',
  },
  OBSOLETE_POLICY: {
    approvalDisposition: 'CONSUMED',
    resumable: false,
    terminal: true,
    workflowStatus: 'FAILED',
  },
  PRE_CAS_POLICY_DENY: {
    approvalDisposition: 'CONSUMED',
    resumable: false,
    terminal: true,
    workflowStatus: 'FAILED',
  },
  ROLLOUT_PAUSE: {
    approvalDisposition: 'RETAINED',
    resumable: true,
    terminal: false,
    workflowStatus: 'PAUSED',
  },
  STALE_POINTER: {
    approvalDisposition: 'CONSUMED',
    resumable: false,
    terminal: true,
    workflowStatus: 'FAILED',
  },
  TIMEOUT: {
    approvalDisposition: 'RETAINED',
    resumable: true,
    terminal: false,
    workflowStatus: 'RECONCILING',
  },
} satisfies Record<ActivationTransitionCondition, TransitionClassification>);

export function classifyActivationTransition(
  condition: ActivationTransitionCondition,
): TransitionClassification {
  return ACTIVATION_TRANSITION_CLASSIFICATIONS[condition];
}

export const DECISIVE_ACTIVATION_OUTCOME_CODES = Object.freeze([
  'SWAPPED',
  'STALE_POINTER',
  'EXPIRED_APPROVAL',
  'INVALID_BINDING',
  'LOST_RACE',
  'OBSOLETE_POLICY',
  'DEFINITIVE_BLOCKING_FAILURE',
  'CANCELLATION',
  'APPROVER_REVOCATION',
  'PRE_CAS_POLICY_DENY',
] as const);

export type DecisiveActivationOutcomeCode =
  (typeof DECISIVE_ACTIVATION_OUTCOME_CODES)[number];

const TERMINAL_FAILED_NO_SWAP_OUTCOME = Object.freeze({
  outcomeVersion: ACTIVATION_OUTCOME_VERSION,
  pointerOutcome: 'NOT_SWAPPED',
  terminal: true,
  verificationOutcome: 'NOT_RUN',
  workflowDisposition: 'CONSUMED',
  workflowStatus: 'FAILED',
} satisfies ReleaseActivationOutcomeDimensions);

export const DECISIVE_ACTIVATION_OUTCOME_DIMENSIONS = Object.freeze({
  SWAPPED: Object.freeze({
    outcomeVersion: ACTIVATION_OUTCOME_VERSION,
    pointerOutcome: 'SWAPPED',
    terminal: false,
    verificationOutcome: 'NOT_RUN',
    workflowDisposition: 'CONSUMED',
    workflowStatus: 'RUNNING',
  } satisfies ReleaseActivationOutcomeDimensions),
  STALE_POINTER: TERMINAL_FAILED_NO_SWAP_OUTCOME,
  EXPIRED_APPROVAL: TERMINAL_FAILED_NO_SWAP_OUTCOME,
  INVALID_BINDING: TERMINAL_FAILED_NO_SWAP_OUTCOME,
  LOST_RACE: TERMINAL_FAILED_NO_SWAP_OUTCOME,
  OBSOLETE_POLICY: TERMINAL_FAILED_NO_SWAP_OUTCOME,
  DEFINITIVE_BLOCKING_FAILURE: TERMINAL_FAILED_NO_SWAP_OUTCOME,
  CANCELLATION: Object.freeze({
    outcomeVersion: ACTIVATION_OUTCOME_VERSION,
    pointerOutcome: 'NOT_SWAPPED',
    terminal: true,
    verificationOutcome: 'NOT_RUN',
    workflowDisposition: 'CONSUMED',
    workflowStatus: 'CANCELLED',
  } satisfies ReleaseActivationOutcomeDimensions),
  APPROVER_REVOCATION: TERMINAL_FAILED_NO_SWAP_OUTCOME,
  PRE_CAS_POLICY_DENY: TERMINAL_FAILED_NO_SWAP_OUTCOME,
} satisfies Record<
  DecisiveActivationOutcomeCode,
  ReleaseActivationOutcomeDimensions
>);

export function decisiveActivationOutcomeDimensions(
  outcomeCode: DecisiveActivationOutcomeCode,
): ReleaseActivationOutcomeDimensions {
  return DECISIVE_ACTIVATION_OUTCOME_DIMENSIONS[outcomeCode];
}

export interface DenyOnlyRolloutControlResult {
  readonly policyVersion: typeof ROLLOUT_CONTROL_POLICY_VERSION;
  readonly result: 'DENIED' | 'NOT_DENIED';
}

export interface ReleaseActivationPhaseReceipt extends TenantEnvironmentIdentity {
  readonly activationAttemptId: MintedUuid;
  readonly phaseCode: string;
  readonly phaseReceiptId: MintedUuid;
  readonly receiptDigest: Uint8Array;
  readonly receiptVersion: typeof ACTIVATION_PHASE_RECEIPT_VERSION;
}

export interface ReleaseActivationHistoryRecord
  extends ReleaseActivationOutcomeDimensions, TenantEnvironmentIdentity {
  readonly activationAttemptId: MintedUuid;
  readonly approvingHumanId: string;
  readonly historyId: MintedUuid;
  readonly historyVersion: typeof ACTIVATION_HISTORY_VERSION;
  readonly initiatingHumanId: string;
  readonly issuingActorId: string;
  readonly executionPrincipalId: string;
  readonly executionPrincipalKind: 'SYSTEM';
}

export interface ReleaseActivationAttemptOutcome
  extends ReleaseActivationOutcomeDimensions, TenantEnvironmentIdentity {
  readonly activationAttemptId: MintedUuid;
  readonly outcomeDigest: Uint8Array;
  readonly outcomeId: MintedUuid;
  readonly outcomeCode: DecisiveActivationOutcomeCode;
}

export interface ReleaseActivationOutboxEnvelope extends TenantEnvironmentIdentity {
  readonly activationAttemptId: MintedUuid;
  readonly envelopeVersion: typeof ACTIVATION_OUTBOX_ENVELOPE_VERSION;
  readonly eventCode: string;
  readonly outboxId: MintedUuid;
  readonly payloadDigest: Uint8Array;
}

export interface ActivateReleaseCommand {
  /** The only caller-selected activation identity; all authority is persisted. */
  readonly activationAttemptId: MintedUuid;
}

export interface CancelReleaseActivationCommand {
  readonly activationAttemptId: MintedUuid;
}

export type ActivationKernelStatus =
  | 'EXECUTOR_UNAVAILABLE'
  | 'NO_SWAP_TERMINAL'
  | 'PAUSED'
  | 'RECONCILING'
  | 'SUPERSEDED'
  | 'SWAPPED_VERIFICATION_FAILED'
  | 'SWAPPED_VERIFIED'
  | 'SWAPPED_VERIFY_PENDING';

export interface ActivationKernelResult extends TenantEnvironmentIdentity {
  readonly activationAttemptId: MintedUuid;
  readonly alarmDue: boolean;
  readonly decisiveOutcomeCode: DecisiveActivationOutcomeCode | null;
  readonly fence: number | null;
  readonly pointerId: MintedUuid | null;
  readonly releaseId: MintedUuid | null;
  readonly retryable: boolean;
  readonly status: ActivationKernelStatus;
  readonly terminal: boolean;
}

export interface ReleaseActivationSwapReceipt extends TenantEnvironmentIdentity {
  readonly activatedReleaseId: MintedUuid;
  readonly activationAttemptId: MintedUuid;
  readonly approvalId: MintedUuid;
  readonly fence: number;
  readonly historyId: MintedUuid;
  readonly outboxId: MintedUuid;
  readonly pointerId: MintedUuid;
  readonly previousReleaseId: MintedUuid | null;
  readonly recordedAt: string;
  readonly swapReceiptId: MintedUuid;
  readonly swapReceiptVersion: typeof ACTIVATION_SWAP_RECEIPT_VERSION;
}

export type ActivationVerificationStatus =
  'SUPERSEDED' | 'SWAPPED_VERIFICATION_FAILED' | 'SWAPPED_VERIFIED';

/** G1 declares no post-swap check nonblocking, so no warning verdict exists. */
export const NONBLOCKING_POST_SWAP_VERIFICATION_CHECKS = Object.freeze(
  [] as const,
);

export interface ReleaseActivationVerificationReceipt extends TenantEnvironmentIdentity {
  readonly activatedReleaseId: MintedUuid;
  readonly activationAttemptId: MintedUuid;
  readonly artifactAvailabilityPassed: boolean;
  readonly fence: number;
  readonly pointerId: MintedUuid;
  readonly pointerReadBackPassed: boolean;
  readonly releaseKernelInvariantsPassed: boolean;
  readonly status: ActivationVerificationStatus;
  readonly verificationReceiptId: MintedUuid;
  readonly verificationVersion: typeof ACTIVATION_VERIFICATION_RECEIPT_VERSION;
}

export interface ReleaseActivationReconciliationAlarm extends TenantEnvironmentIdentity {
  readonly activationAttemptId: MintedUuid;
  readonly alarmId: MintedUuid;
  readonly alarmVersion: typeof ACTIVATION_RECONCILIATION_ALARM_VERSION;
  readonly maxAgeMilliseconds: number;
  readonly reasonCode: 'RECONCILIATION_OVERDUE';
}

/**
 * Frozen producer envelope for the G1-P5 activation-invalidation dispatcher.
 * PostgreSQL commits one row; the dispatcher delivers it at least once and
 * consumers must deduplicate. This event never selects or pins a release.
 */
export interface ReleaseActivationInvalidationEvent extends TenantEnvironmentIdentity {
  readonly activationAttemptId: MintedUuid;
  readonly deduplicationKey: string;
  readonly eventCode: typeof ACTIVATION_INVALIDATION_EVENT_CODE;
  readonly fence: number;
  readonly historyId: MintedUuid;
  readonly newReleaseId: MintedUuid;
  readonly oldReleaseId: MintedUuid | null;
  readonly outboxId: MintedUuid;
  readonly pointerId: MintedUuid;
  readonly schemaVersion: typeof ACTIVATION_INVALIDATION_EVENT_VERSION;
}

export type InvalidationConsumerDecision =
  | 'ACCEPTED_CONTIGUOUS'
  | 'ACCEPTED_GAP_REREAD_REQUIRED'
  | 'REJECTED_STALE_OR_DUPLICATE';

export interface InvalidationConsumerResult {
  readonly decision: InvalidationConsumerDecision;
  readonly highestFence: number;
  readonly requestPointerReread: boolean;
}

/**
 * P5 consumer helper. It retains only the maximum fence per stable pointer,
 * rejects duplicate/reordered delivery, and asks for an authoritative pointer
 * reread on a gap or whenever the caller reports doubt.
 */
export class ReleaseInvalidationFenceState {
  readonly #highestFenceByPointer = new Map<string, number>();

  consume(
    event: ReleaseActivationInvalidationEvent,
    options: Readonly<{ doubt?: boolean }> = {},
  ): InvalidationConsumerResult {
    assertInvalidationEvent(event);
    const previous = this.#highestFenceByPointer.get(event.pointerId);
    if (previous !== undefined && event.fence <= previous) {
      return Object.freeze({
        decision: 'REJECTED_STALE_OR_DUPLICATE',
        highestFence: previous,
        requestPointerReread: Boolean(options.doubt),
      });
    }

    this.#highestFenceByPointer.set(event.pointerId, event.fence);
    const gap =
      previous === undefined ? event.fence !== 1 : event.fence !== previous + 1;
    const doubt = Boolean(options.doubt);
    return Object.freeze({
      decision:
        gap || doubt ? 'ACCEPTED_GAP_REREAD_REQUIRED' : 'ACCEPTED_CONTIGUOUS',
      highestFence: event.fence,
      requestPointerReread: gap || doubt,
    });
  }

  highestFence(pointerId: MintedUuid): number | null {
    return this.#highestFenceByPointer.get(pointerId) ?? null;
  }
}

export interface FenceTaggedDerivedCacheEntry {
  /** Read with the pointer in the same PostgreSQL snapshot as the artifacts. */
  readonly filledAtFence: number;
  readonly pointerId: MintedUuid;
}

/** Derived cache entries below the highest invalidated fence are discarded. */
export function shouldDiscardFenceTaggedCache(
  entry: FenceTaggedDerivedCacheEntry,
  highestInvalidatedFence: number,
): boolean {
  return entry.filledAtFence < highestInvalidatedFence;
}

function assertInvalidationEvent(
  event: ReleaseActivationInvalidationEvent,
): void {
  if (
    event.schemaVersion !== ACTIVATION_INVALIDATION_EVENT_VERSION ||
    event.eventCode !== ACTIVATION_INVALIDATION_EVENT_CODE ||
    !Number.isSafeInteger(event.fence) ||
    event.fence <= 0 ||
    event.deduplicationKey.trim() === ''
  ) {
    throw new Error('invalid release activation invalidation event');
  }
}
