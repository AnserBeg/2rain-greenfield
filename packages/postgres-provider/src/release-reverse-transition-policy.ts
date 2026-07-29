import {
  TRANSITION_COMPATIBILITY_POLICY_V2_VERSION,
  TRANSITION_COMPATIBILITY_POLICY_VERSION,
  TRANSITION_PREPARATION_RECEIPT_V2_VERSION,
  TRANSITION_PREPARATION_RECEIPT_VERSION,
  type CompilerTransitionClass,
  type MintedUuid,
  type RecoveryMode,
} from '@north-star/platform-runtime';
import type { TrustedRequestContext } from '@north-star/runtime';
import type { PoolClient } from 'pg';

export const RELEASE_REVERSE_TRANSITION_POLICY_VERSION =
  'northstar.release-reverse-transition-policy/v1' as const;

export type ReleaseReverseTransitionRefusalCode =
  | 'RELEASE_TRANSITION_NOT_EXACT_LINEAGE_EDGE'
  | 'ROLLBACK_FORWARD_ACTIVATION_NOT_VERIFIED'
  | 'ROLLBACK_FORWARD_EVIDENCE_INVALID'
  | 'ROLLBACK_FORWARD_TRANSITION_NOT_REVERSIBLE'
  | 'ROLLBACK_TARGET_NOT_IMMEDIATE_PREDECESSOR';

export class ReleaseReverseTransitionRefusal extends Error {
  override readonly name = 'ReleaseReverseTransitionRefusal';

  constructor(
    readonly code: ReleaseReverseTransitionRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ReleaseReverseTransitionAuthorization {
  readonly forwardActivationAttemptId: MintedUuid;
  readonly forwardReceiptId: MintedUuid;
  readonly forwardRecoveryMode: RecoveryMode;
  readonly forwardTransitionClass: CompilerTransitionClass;
  readonly policyVersion: typeof RELEASE_REVERSE_TRANSITION_POLICY_VERSION;
  readonly sourceReleaseId: MintedUuid;
  readonly targetReleaseId: MintedUuid;
}

interface ReverseTransitionEvidenceRow {
  exact_forward_lineage: boolean;
  exact_reverse_lineage: boolean;
  forward_activation_attempt_id: MintedUuid | null;
  forward_receipt_id: MintedUuid | null;
  forward_receipt_version: string | null;
  forward_recovery_mode: RecoveryMode | null;
  forward_transition_class: CompilerTransitionClass | null;
  forward_verification_status: string | null;
  receipt_compatibility_policy_version: string | null;
  receipt_compiler_exact_pair: boolean | null;
  receipt_executor_exact_pair: boolean | null;
  receipt_policy_verdict: string | null;
  receipt_source_manifest_root_matches: boolean | null;
  receipt_source_release_id: MintedUuid | null;
  receipt_static_compatibility: string | null;
  receipt_target_manifest_root_matches: boolean | null;
  receipt_target_release_id: MintedUuid | null;
  target_is_ancestor: boolean;
}

/**
 * Returns null for a positively established exact forward lineage edge and for
 * equivalent or unrelated pairs in the pre-existing generic forward-activation
 * domain. For an exact reverse lineage edge, returns the immutable forward
 * activation evidence or throws a typed refusal. A non-immediate ancestor is
 * an attempted skipped reverse edge and fails closed. The current pointer
 * fence selects the activation that actually established the source release;
 * an older compatible receipt cannot authorize reversal of a later activation.
 */
export async function authorizeReverseTransitionIfApplicable(
  client: PoolClient,
  context: TrustedRequestContext,
  input: Readonly<{
    expectedFence: number;
    sourceReleaseId: MintedUuid;
    targetReleaseId: MintedUuid;
  }>,
): Promise<ReleaseReverseTransitionAuthorization | null> {
  const result = await client.query<ReverseTransitionEvidenceRow>(
    `SELECT target_revision.parent_revision_id = source_revision.revision_id
              AS exact_forward_lineage,
            source_revision.parent_revision_id = target_revision.revision_id
              AS exact_reverse_lineage,
            EXISTS (
              WITH RECURSIVE source_ancestors(revision_id) AS (
                SELECT source_revision.parent_revision_id
                UNION
                SELECT ancestor.parent_revision_id
                  FROM platform.app_package_revisions AS ancestor
                  JOIN source_ancestors
                    ON source_ancestors.revision_id = ancestor.revision_id
                 WHERE ancestor.tenant_id = source.tenant_id
                   AND source_ancestors.revision_id IS NOT NULL
              )
              SELECT 1
                FROM source_ancestors
               WHERE revision_id = target_revision.revision_id
            ) AS target_is_ancestor,
            swap.activation_attempt_id AS forward_activation_attempt_id,
            verification.status AS forward_verification_status,
            receipt.receipt_id AS forward_receipt_id,
            receipt.receipt_version AS forward_receipt_version,
            receipt.source_release_id AS receipt_source_release_id,
            receipt.target_release_id AS receipt_target_release_id,
            receipt.source_manifest_root = decode(target.content_hash, 'hex')
              AS receipt_source_manifest_root_matches,
            receipt.target_manifest_root = decode(source.content_hash, 'hex')
              AS receipt_target_manifest_root_matches,
            receipt.compiler_transition_class AS forward_transition_class,
            receipt.compiler_static_compatibility
              AS receipt_static_compatibility,
            receipt.compiler_exact_pair AS receipt_compiler_exact_pair,
            receipt.executor_exact_pair AS receipt_executor_exact_pair,
            receipt.compatibility_policy_verdict AS receipt_policy_verdict,
            receipt.compatibility_policy_version
              AS receipt_compatibility_policy_version,
            receipt.recovery_mode AS forward_recovery_mode
       FROM platform.tenant_releases AS source
       JOIN platform.app_package_revisions AS source_revision
         ON source_revision.tenant_id = source.tenant_id
        AND source_revision.revision_id = source.app_package_revision_id
       JOIN platform.tenant_releases AS target
         ON target.tenant_id = source.tenant_id
        AND target.environment_id = source.environment_id
        AND target.release_id = $4
       JOIN platform.app_package_revisions AS target_revision
         ON target_revision.tenant_id = target.tenant_id
        AND target_revision.revision_id = target.app_package_revision_id
       LEFT JOIN platform.release_activation_swap_receipts AS swap
         ON swap.tenant_id = source.tenant_id
        AND swap.environment_id = source.environment_id
        AND swap.previous_release_id = target.release_id
        AND swap.activated_release_id = source.release_id
        AND swap.fence = $5
       LEFT JOIN platform.release_activation_verification_receipts AS verification
         ON verification.tenant_id = swap.tenant_id
        AND verification.environment_id = swap.environment_id
        AND verification.activation_attempt_id = swap.activation_attempt_id
        AND verification.activated_release_id = source.release_id
        AND verification.fence = swap.fence
       LEFT JOIN platform.release_approvals AS approval
         ON approval.tenant_id = swap.tenant_id
        AND approval.environment_id = swap.environment_id
        AND approval.approval_id = swap.approval_id
        AND approval.activation_attempt_id = swap.activation_attempt_id
       LEFT JOIN platform.transition_preparation_receipts AS receipt
         ON receipt.tenant_id = approval.tenant_id
        AND receipt.environment_id = approval.environment_id
        AND receipt.receipt_id = approval.transition_preparation_receipt_id
      WHERE source.tenant_id = $1
        AND source.environment_id = $2
        AND source.release_id = $3`,
    [
      context.tenantId,
      context.environmentId,
      input.sourceReleaseId,
      input.targetReleaseId,
      input.expectedFence,
    ],
  );
  const row = result.rows[0];
  if (row?.exact_forward_lineage) return null;
  if (!row) {
    refuse(
      'RELEASE_TRANSITION_NOT_EXACT_LINEAGE_EDGE',
      'release transition pair is not visible in the trusted environment',
    );
  }
  if (!row.exact_reverse_lineage) {
    if (row.target_is_ancestor) {
      refuse(
        'RELEASE_TRANSITION_NOT_EXACT_LINEAGE_EDGE',
        'reverse release transition must follow one exact lineage edge',
      );
    }
    return null;
  }

  if (
    row.forward_activation_attempt_id === null ||
    row.forward_verification_status !== 'SWAPPED_VERIFIED'
  ) {
    refuse(
      'ROLLBACK_FORWARD_ACTIVATION_NOT_VERIFIED',
      'rollback requires the verified forward activation that established the current release',
    );
  }
  if (
    row.forward_receipt_id === null ||
    row.forward_transition_class === null ||
    row.forward_recovery_mode === null ||
    row.receipt_source_release_id !== input.targetReleaseId ||
    row.receipt_target_release_id !== input.sourceReleaseId ||
    row.receipt_source_manifest_root_matches !== true ||
    row.receipt_target_manifest_root_matches !== true ||
    row.receipt_static_compatibility !== 'SATISFIED' ||
    row.receipt_compiler_exact_pair !== true ||
    row.receipt_executor_exact_pair !== true ||
    row.receipt_policy_verdict !== 'ALLOW'
  ) {
    refuse(
      'ROLLBACK_FORWARD_EVIDENCE_INVALID',
      'rollback forward-transition evidence is incomplete or does not bind the exact release pair',
    );
  }
  const reversible =
    (row.forward_transition_class === 'NO_STORAGE_TRANSITION' &&
      row.forward_recovery_mode === 'NO_STORAGE_RECOVERY_REQUIRED' &&
      row.forward_receipt_version === TRANSITION_PREPARATION_RECEIPT_VERSION &&
      row.receipt_compatibility_policy_version ===
        TRANSITION_COMPATIBILITY_POLICY_VERSION) ||
    (row.forward_transition_class === 'REVERSIBLE' &&
      row.forward_recovery_mode === 'REVERSIBLE' &&
      row.forward_receipt_version ===
        TRANSITION_PREPARATION_RECEIPT_V2_VERSION &&
      row.receipt_compatibility_policy_version ===
        TRANSITION_COMPATIBILITY_POLICY_V2_VERSION);
  if (!reversible) {
    refuse(
      'ROLLBACK_FORWARD_TRANSITION_NOT_REVERSIBLE',
      'rollback is refused because the forward transition is forward-recovery-only',
    );
  }
  return Object.freeze({
    forwardActivationAttemptId: row.forward_activation_attempt_id,
    forwardReceiptId: row.forward_receipt_id,
    forwardRecoveryMode: row.forward_recovery_mode,
    forwardTransitionClass: row.forward_transition_class,
    policyVersion: RELEASE_REVERSE_TRANSITION_POLICY_VERSION,
    sourceReleaseId: input.sourceReleaseId,
    targetReleaseId: input.targetReleaseId,
  });
}

export function refuseReverseTransition(
  code: ReleaseReverseTransitionRefusalCode,
  message: string,
): never {
  return refuse(code, message);
}

function refuse(
  code: ReleaseReverseTransitionRefusalCode,
  message: string,
): never {
  throw new ReleaseReverseTransitionRefusal(code, message);
}
