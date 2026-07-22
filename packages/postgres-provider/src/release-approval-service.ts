import {
  ACTIVATION_ATTEMPT_CONTRACT_VERSION,
  APPROVAL_CONTRACT_VERSION,
  APPROVAL_DEFAULT_EXPIRY_MILLISECONDS,
  APPROVAL_EXPIRY_POLICY_VERSION,
  APPROVAL_MAX_EXPIRY_MILLISECONDS,
  APPROVER_AUTHORITY_POLICY_VERSION,
  INITIAL_ACTIVATION_BINDING_VERSION,
  RELEASE_DIFF_BINDING_VERSION,
  SYSTEM_EXECUTION_PRINCIPAL,
  type TRANSITION_COMPATIBILITY_POLICY_VERSION,
  evaluateTransitionCompatibility,
  type ApprovalDiffBinding,
  type CreateReleaseApprovalCommand,
  type CreatedReleaseApproval,
  type ExecutorAppliedState,
  type MintedUuid,
  type RecoveryMode,
  type ReleaseActivationAttempt,
  type ReleaseApproval,
  type TransitionCompatibilityDecision,
  type CompilerTransitionClass,
} from '@north-star/platform-runtime';
import type { TrustedRequestContext } from '@north-star/runtime';
import type { Pool, PoolClient } from 'pg';

import { withTrustedRequestTransaction } from './request-context.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const authorityLockNamespace = 'northstar.release-approval-authority:';

export class ReleaseApprovalError extends Error {
  override readonly name = 'ReleaseApprovalError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface PointerRow {
  fence: string;
  pointer_id: MintedUuid;
  release_id: MintedUuid | null;
}

interface ReleaseRow {
  compiler_attestation_digest: string;
  compiler_semantic_profile_version: string;
  compiler_version: string;
  content_hash: string;
  created_by: string;
  output_protocol_version: string;
  release_id: MintedUuid;
  verification_evidence_id: MintedUuid;
}

interface AuthorityRow {
  eligible: boolean | null;
  policy_version: string | null;
}

interface PreparationRow {
  canonical_diff_digest: Uint8Array;
  capability_support_digest: Uint8Array;
  capability_support_result: 'SUPPORTED' | 'UNSUPPORTED';
  capability_support_version: string;
  compiler_attestation_digest: Uint8Array;
  compiler_output_protocol_version: string;
  compiler_semantic_profile_version: string;
  compiler_version: string;
  diff_binding_kind: 'INITIAL_ACTIVATION' | 'RELEASE_DIFF';
  diff_binding_version: string;
  expected_fence: string;
  expected_pointer_id: MintedUuid;
  expected_release_id: MintedUuid | null;
  preparation_id: MintedUuid;
  release_diff_algorithm_version: string | null;
  release_diff_version: string | null;
  rendered_diff_evidence_digest: Uint8Array;
  renderer_version: string;
  source_manifest_root: Uint8Array | null;
  target_manifest_root: Uint8Array;
  target_release_id: MintedUuid;
  transition_plan_digest: Uint8Array | null;
  transition_preparation_receipt_id: MintedUuid;
  verification_evidence_digest: Uint8Array;
  verification_evidence_id: MintedUuid;
  verification_evidence_version: string;
  view_schema_version: string;
  receipt_compiler_exact_pair: boolean;
  receipt_compiler_facts_digest: Uint8Array;
  receipt_compiler_facts_version: string;
  receipt_compiler_static_compatibility: 'BLOCKED' | 'SATISFIED';
  receipt_compiler_transition_class: CompilerTransitionClass;
  receipt_executor_applied_state: ExecutorAppliedState;
  receipt_executor_evidence_digest: Uint8Array;
  receipt_executor_evidence_version: string;
  receipt_executor_exact_pair: boolean;
  receipt_policy_verdict: 'ALLOW' | 'DENY';
  receipt_policy_version: string;
  receipt_recovery_mode: RecoveryMode;
  receipt_source_manifest_root: Uint8Array | null;
  receipt_source_release_id: MintedUuid | null;
  receipt_target_manifest_root: Uint8Array;
  receipt_target_release_id: MintedUuid;
}

interface ApprovalRow {
  activation_attempt_id: MintedUuid;
  approval_contract_version: typeof APPROVAL_CONTRACT_VERSION;
  approval_id: MintedUuid;
  authority_policy_version: string;
  authority_policy_contract_version: typeof APPROVER_AUTHORITY_POLICY_VERSION;
  approving_human_id: string;
  canonical_diff_digest: Uint8Array;
  capability_support_digest: Uint8Array;
  capability_support_version: string;
  compiler_attestation_digest: Uint8Array;
  compiler_output_protocol_version: string;
  compiler_semantic_profile_version: string;
  compiler_version: string;
  compatibility_policy_version: typeof TRANSITION_COMPATIBILITY_POLICY_VERSION;
  decided_at: Date | string;
  diff_binding_kind: 'INITIAL_ACTIVATION' | 'RELEASE_DIFF';
  diff_binding_version: string;
  environment_id: string;
  expected_fence: string;
  expected_pointer_id: MintedUuid;
  expected_release_id: MintedUuid | null;
  expires_at: Date | string;
  expiry_policy_version: typeof APPROVAL_EXPIRY_POLICY_VERSION;
  initiating_human_id: string;
  issuing_actor_id: string;
  preparation_id: MintedUuid;
  release_diff_algorithm_version: string | null;
  release_diff_version: string | null;
  rendered_diff_evidence_digest: Uint8Array;
  renderer_version: string;
  rollout_id: MintedUuid | null;
  source_decision_id: MintedUuid | null;
  source_manifest_root: Uint8Array | null;
  target_manifest_root: Uint8Array;
  target_release_id: MintedUuid;
  tenant_id: string;
  transition_plan_digest: Uint8Array | null;
  transition_preparation_receipt_id: MintedUuid;
  verification_evidence_digest: Uint8Array;
  verification_evidence_id: MintedUuid;
  verification_evidence_version: string;
  view_schema_version: string;
}

interface AttemptRow {
  activation_attempt_id: MintedUuid;
  approval_id: MintedUuid;
  attempt_contract_version: typeof ACTIVATION_ATTEMPT_CONTRACT_VERSION;
  attempt_state: 'PREBOUND';
  created_at: Date | string;
  environment_id: string;
  execution_principal_id: string;
  execution_principal_kind: 'SYSTEM';
  tenant_id: string;
}

export interface ReleaseApprovalServiceOptions {
  readonly now?: () => Date;
}

export class PostgresReleaseApprovalService {
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    options: ReleaseApprovalServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async createApproval(
    context: TrustedRequestContext,
    command: CreateReleaseApprovalCommand,
  ): Promise<CreatedReleaseApproval> {
    validateCommandIdentity(context, command);
    const decidedAt = validNow(this.now());
    const expiresAt = approvalExpiry(decidedAt, command.expiresAt);

    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      await lockAuthoritySnapshot(client, context.tenantId);
      const pointer = await loadPointer(client, context);
      const release = await loadTargetRelease(
        client,
        context,
        command.targetReleaseId,
      );
      const preparation = await loadPreparation(
        client,
        context,
        command.preparationId,
        command.targetReleaseId,
      );
      const authority = await loadCurrentAuthority(
        client,
        context.tenantId,
        command.approvingHumanId,
      );

      assertCurrentApprover(authority, release, command);
      await assertCanonicalBinding(
        client,
        context,
        pointer,
        release,
        preparation,
      );

      const approvalResult = await client.query<ApprovalRow>(
        `INSERT INTO platform.release_approvals (
           tenant_id,
           environment_id,
           approval_id,
           approval_contract_version,
           activation_attempt_id,
           preparation_id,
           target_release_id,
           target_manifest_root,
           expected_pointer_id,
           expected_release_id,
           expected_fence,
           source_manifest_root,
           diff_binding_kind,
           diff_binding_version,
           release_diff_version,
           release_diff_algorithm_version,
           canonical_diff_digest,
           transition_plan_digest,
           compiler_attestation_digest,
           compiler_version,
           compiler_semantic_profile_version,
           compiler_output_protocol_version,
           verification_evidence_id,
           verification_evidence_version,
           verification_evidence_digest,
           capability_support_version,
           capability_support_digest,
           renderer_version,
           view_schema_version,
           rendered_diff_evidence_digest,
           transition_preparation_receipt_id,
           compatibility_policy_version,
           authority_policy_version,
           authority_policy_contract_version,
           approving_human_id,
           issuing_actor_id,
           initiating_human_id,
           source_decision_id,
           rollout_id,
           decided_at,
           expires_at,
           expiry_policy_version
         )
         SELECT $1,
                $2,
                $3,
                $4,
                $5,
                preparation.preparation_id,
                preparation.target_release_id,
                preparation.target_manifest_root,
                preparation.expected_pointer_id,
                preparation.expected_release_id,
                preparation.expected_fence,
                preparation.source_manifest_root,
                preparation.diff_binding_kind,
                preparation.diff_binding_version,
                preparation.release_diff_version,
                preparation.release_diff_algorithm_version,
                preparation.canonical_diff_digest,
                preparation.transition_plan_digest,
                preparation.compiler_attestation_digest,
                preparation.compiler_version,
                preparation.compiler_semantic_profile_version,
                preparation.compiler_output_protocol_version,
                preparation.verification_evidence_id,
                preparation.verification_evidence_version,
                preparation.verification_evidence_digest,
                preparation.capability_support_version,
                preparation.capability_support_digest,
                preparation.renderer_version,
                preparation.view_schema_version,
                preparation.rendered_diff_evidence_digest,
                preparation.transition_preparation_receipt_id,
                receipt.compatibility_policy_version,
                $6,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                $13,
                $14,
                $15
           FROM platform.release_activation_preparations AS preparation
           JOIN platform.transition_preparation_receipts AS receipt
             ON receipt.tenant_id = preparation.tenant_id
            AND receipt.environment_id = preparation.environment_id
            AND receipt.receipt_id =
                  preparation.transition_preparation_receipt_id
          WHERE preparation.tenant_id = $1
            AND preparation.environment_id = $2
            AND preparation.preparation_id = $16
         RETURNING *`,
        [
          context.tenantId,
          context.environmentId,
          command.approvalId,
          APPROVAL_CONTRACT_VERSION,
          command.activationAttemptId,
          authority.policyVersion,
          APPROVER_AUTHORITY_POLICY_VERSION,
          command.approvingHumanId,
          command.issuingActorId,
          command.initiatingHumanId,
          command.sourceDecisionId ?? null,
          command.rolloutId ?? null,
          decidedAt,
          expiresAt,
          APPROVAL_EXPIRY_POLICY_VERSION,
          command.preparationId,
        ],
      );
      const approvalRow = requiredRow(
        approvalResult.rows[0],
        'canonical preparation disappeared while approval was being created',
      );

      const attemptResult = await client.query<AttemptRow>(
        `INSERT INTO platform.release_activation_attempts (
           tenant_id,
           environment_id,
           activation_attempt_id,
           approval_id,
           attempt_contract_version,
           execution_principal_kind,
           execution_principal_id,
           attempt_state
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PREBOUND')
         RETURNING *`,
        [
          context.tenantId,
          context.environmentId,
          command.activationAttemptId,
          command.approvalId,
          ACTIVATION_ATTEMPT_CONTRACT_VERSION,
          SYSTEM_EXECUTION_PRINCIPAL.kind,
          SYSTEM_EXECUTION_PRINCIPAL.principalId,
        ],
      );
      return Object.freeze({
        approval: approvalFromRow(approvalRow),
        attempt: attemptFromRow(
          requiredRow(
            attemptResult.rows[0],
            'prebound activation attempt was not created',
          ),
        ),
      });
    });
  }
}

function validateCommandIdentity(
  context: TrustedRequestContext,
  command: CreateReleaseApprovalCommand,
): void {
  for (const [name, value] of [
    ['approvalId', command.approvalId],
    ['activationAttemptId', command.activationAttemptId],
    ['preparationId', command.preparationId],
    ['targetReleaseId', command.targetReleaseId],
    ['approvingHumanId', command.approvingHumanId],
    ['issuingActorId', command.issuingActorId],
    ['initiatingHumanId', command.initiatingHumanId],
  ] as const) {
    assertUuid(value, name);
  }
  if (command.sourceDecisionId) {
    assertUuid(command.sourceDecisionId, 'sourceDecisionId');
  }
  if (command.rolloutId) assertUuid(command.rolloutId, 'rolloutId');
  if (command.approvalId === command.activationAttemptId) {
    fail(
      'IDENTITY_COLLAPSE',
      'approval and attempt identities must be distinct',
    );
  }
  if (
    command.approvingHumanId === SYSTEM_EXECUTION_PRINCIPAL.principalId ||
    command.initiatingHumanId === SYSTEM_EXECUTION_PRINCIPAL.principalId
  ) {
    fail(
      'HUMAN_IDENTITY_REQUIRED',
      'human attribution cannot use the SYSTEM principal',
    );
  }
  if (
    command.approvingHumanId !== context.principalId ||
    command.issuingActorId !== context.principalId
  ) {
    fail(
      'UNTRUSTED_ACTOR_IDENTITY',
      'approving human and issuing actor must be the trusted request principal',
    );
  }
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    fail('CLOCK_INVALID', 'approval clock returned an invalid instant');
  }
  return new Date(value.getTime());
}

function approvalExpiry(decidedAt: Date, requested: string | undefined): Date {
  const expiresAt = requested
    ? new Date(requested)
    : new Date(decidedAt.getTime() + APPROVAL_DEFAULT_EXPIRY_MILLISECONDS);
  if (!Number.isFinite(expiresAt.getTime())) {
    fail('EXPIRY_INVALID', 'explicit approval expiry must be a valid instant');
  }
  const duration = expiresAt.getTime() - decidedAt.getTime();
  if (duration <= 0) {
    fail('EXPIRY_NOT_FUTURE', 'approval expiry must be in the future');
  }
  if (duration > APPROVAL_MAX_EXPIRY_MILLISECONDS) {
    fail(
      'EXPIRY_EXCEEDS_POLICY',
      'approval expiry exceeds the platform maximum',
    );
  }
  return expiresAt;
}

async function lockAuthoritySnapshot(
  client: PoolClient,
  tenantId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock_shared(
       hashtextextended($1 || $2::text, 0)
     )`,
    [authorityLockNamespace, tenantId],
  );
}

async function loadPointer(
  client: PoolClient,
  context: TrustedRequestContext,
): Promise<PointerRow> {
  const result = await client.query<PointerRow>(
    `SELECT pointer_id, release_id, fence
       FROM platform.active_release_pointers
      WHERE tenant_id = $1 AND environment_id = $2
      FOR SHARE`,
    [context.tenantId, context.environmentId],
  );
  return requiredRow(
    result.rows[0],
    'trusted environment has no active release pointer',
  );
}

async function loadTargetRelease(
  client: PoolClient,
  context: TrustedRequestContext,
  releaseId: MintedUuid,
): Promise<ReleaseRow> {
  const result = await client.query<ReleaseRow>(
    `SELECT release_id,
            content_hash,
            compiler_attestation_digest,
            compiler_version,
            compiler_semantic_profile_version,
            output_protocol_version,
            verification_evidence_id,
            created_by
       FROM platform.tenant_releases
      WHERE tenant_id = $1
        AND environment_id = $2
        AND release_id = $3`,
    [context.tenantId, context.environmentId, releaseId],
  );
  return requiredRow(result.rows[0], 'target tenant release is not visible');
}

async function loadPreparation(
  client: PoolClient,
  context: TrustedRequestContext,
  preparationId: MintedUuid,
  targetReleaseId: MintedUuid,
): Promise<PreparationRow> {
  const result = await client.query<PreparationRow>(
    `SELECT preparation.*,
            receipt.source_release_id AS receipt_source_release_id,
            receipt.source_manifest_root AS receipt_source_manifest_root,
            receipt.target_release_id AS receipt_target_release_id,
            receipt.target_manifest_root AS receipt_target_manifest_root,
            receipt.compiler_facts_version AS receipt_compiler_facts_version,
            receipt.compiler_facts_digest AS receipt_compiler_facts_digest,
            receipt.compiler_transition_class AS receipt_compiler_transition_class,
            receipt.compiler_static_compatibility AS receipt_compiler_static_compatibility,
            receipt.compiler_exact_pair AS receipt_compiler_exact_pair,
            receipt.executor_evidence_version AS receipt_executor_evidence_version,
            receipt.executor_evidence_digest AS receipt_executor_evidence_digest,
            receipt.executor_applied_state AS receipt_executor_applied_state,
            receipt.executor_exact_pair AS receipt_executor_exact_pair,
            receipt.compatibility_policy_version AS receipt_policy_version,
            receipt.compatibility_policy_verdict AS receipt_policy_verdict,
            receipt.recovery_mode AS receipt_recovery_mode
       FROM platform.release_activation_preparations AS preparation
       JOIN platform.transition_preparation_receipts AS receipt
         ON receipt.tenant_id = preparation.tenant_id
        AND receipt.environment_id = preparation.environment_id
        AND receipt.receipt_id = preparation.transition_preparation_receipt_id
      WHERE preparation.tenant_id = $1
        AND preparation.environment_id = $2
        AND preparation.preparation_id = $3
        AND preparation.target_release_id = $4`,
    [context.tenantId, context.environmentId, preparationId, targetReleaseId],
  );
  return requiredRow(
    result.rows[0],
    'exact canonical preparation and transition receipt are not visible',
  );
}

async function loadCurrentAuthority(
  client: PoolClient,
  tenantId: string,
  approvingHumanId: string,
): Promise<{ eligible: boolean; policyVersion: number }> {
  const result = await client.query<AuthorityRow>(
    `WITH current_policy AS (
       SELECT max(policy_version) AS policy_version
         FROM platform.release_approver_eligibility_events
        WHERE tenant_id = $1
     ), principal_state AS (
       SELECT eligible
         FROM platform.release_approver_eligibility_events
        WHERE tenant_id = $1 AND principal_id = $2
        ORDER BY policy_version DESC
        LIMIT 1
     )
     SELECT current_policy.policy_version,
            (SELECT eligible FROM principal_state) AS eligible
       FROM current_policy`,
    [tenantId, approvingHumanId],
  );
  const row = requiredRow(
    result.rows[0],
    'approval authority state is unavailable',
  );
  if (row.policy_version === null || row.eligible === null) {
    fail(
      'APPROVER_NOT_ELIGIBLE',
      'approving human has no current eligibility grant',
    );
  }
  return {
    eligible: row.eligible,
    policyVersion: safeBigIntNumber(
      row.policy_version,
      'authority policy version',
    ),
  };
}

function assertCurrentApprover(
  authority: { eligible: boolean; policyVersion: number },
  release: ReleaseRow,
  command: CreateReleaseApprovalCommand,
): void {
  if (!authority.eligible) {
    fail('APPROVER_REVOKED', 'approving human is not currently eligible');
  }
  if (release.created_by === command.approvingHumanId) {
    fail(
      'MAKER_CHECKER_VIOLATION',
      'release maker cannot approve the same release',
    );
  }
}

async function assertCanonicalBinding(
  client: PoolClient,
  context: TrustedRequestContext,
  pointer: PointerRow,
  release: ReleaseRow,
  preparation: PreparationRow,
): Promise<void> {
  const expectedFence = safeBigIntNumber(
    preparation.expected_fence,
    'expected fence',
  );
  const pointerFence = safeBigIntNumber(pointer.fence, 'pointer fence');
  if (
    preparation.expected_pointer_id !== pointer.pointer_id ||
    preparation.expected_release_id !== pointer.release_id ||
    expectedFence !== pointerFence
  ) {
    fail(
      'STALE_PREPARATION',
      'canonical preparation does not bind the current pointer',
    );
  }
  if (
    preparation.target_release_id !== release.release_id ||
    !equalBytes(
      preparation.target_manifest_root,
      digestBytes(release.content_hash),
    )
  ) {
    fail(
      'PREPARATION_TARGET_MISMATCH',
      'preparation does not bind the target release root',
    );
  }
  if (
    !equalBytes(
      preparation.compiler_attestation_digest,
      digestBytes(release.compiler_attestation_digest),
    ) ||
    preparation.compiler_version !== release.compiler_version ||
    preparation.compiler_semantic_profile_version !==
      release.compiler_semantic_profile_version ||
    preparation.compiler_output_protocol_version !==
      release.output_protocol_version ||
    preparation.verification_evidence_id !== release.verification_evidence_id
  ) {
    fail(
      'PREPARATION_EVIDENCE_MISMATCH',
      'preparation does not bind target compiler and verification evidence',
    );
  }
  if (preparation.capability_support_result !== 'SUPPORTED') {
    fail(
      'CAPABILITY_UNSUPPORTED',
      'canonical capability result does not support activation',
    );
  }

  let sourceRoot: Uint8Array | null = null;
  if (pointer.release_id !== null) {
    const source = await client.query<{ content_hash: string }>(
      `SELECT content_hash
         FROM platform.tenant_releases
        WHERE tenant_id = $1
          AND environment_id = $2
          AND release_id = $3`,
      [context.tenantId, context.environmentId, pointer.release_id],
    );
    sourceRoot = digestBytes(
      requiredRow(source.rows[0], 'pointer source release is not visible')
        .content_hash,
    );
  }
  if (
    !equalOptionalBytes(preparation.source_manifest_root, sourceRoot) ||
    preparation.receipt_source_release_id !== pointer.release_id ||
    !equalOptionalBytes(preparation.receipt_source_manifest_root, sourceRoot) ||
    preparation.receipt_target_release_id !== release.release_id ||
    !equalBytes(
      preparation.receipt_target_manifest_root,
      preparation.target_manifest_root,
    )
  ) {
    fail(
      'TRANSITION_PAIR_MISMATCH',
      'transition receipt is not the exact pointer-to-target pair',
    );
  }

  const compatibility = evaluateTransitionCompatibility({
    compilerExactPair: preparation.receipt_compiler_exact_pair,
    compilerFactsVersion: preparation.receipt_compiler_facts_version,
    compilerStaticCompatibility:
      preparation.receipt_compiler_static_compatibility,
    compilerTransitionClass: preparation.receipt_compiler_transition_class,
    executorAppliedState: preparation.receipt_executor_applied_state,
    executorEvidenceVersion: preparation.receipt_executor_evidence_version,
    executorExactPair: preparation.receipt_executor_exact_pair,
    policyVersion: preparation.receipt_policy_version,
    sourceManifestRoot: sourceRoot,
    targetManifestRoot: preparation.target_manifest_root,
  });
  assertStoredCompatibility(compatibility, preparation);
}

function assertStoredCompatibility(
  decision: TransitionCompatibilityDecision,
  preparation: PreparationRow,
): void {
  if (
    decision.verdict !== preparation.receipt_policy_verdict ||
    decision.recoveryMode !== preparation.receipt_recovery_mode
  ) {
    fail(
      'COMPATIBILITY_VERDICT_MISMATCH',
      'stored compatibility verdict does not match the versioned policy',
    );
  }
  if (decision.verdict !== 'ALLOW') {
    fail(
      'COMPATIBILITY_POLICY_DENY',
      'versioned compatibility policy denied the transition',
    );
  }
}

function approvalFromRow(row: ApprovalRow): ReleaseApproval {
  return Object.freeze({
    activationAttemptId: row.activation_attempt_id,
    approvalContractVersion: row.approval_contract_version,
    approvalId: row.approval_id,
    authorityPolicyVersion: safeBigIntNumber(
      row.authority_policy_version,
      'authority policy version',
    ),
    authorityPolicyContractVersion: row.authority_policy_contract_version,
    approvingHumanId: row.approving_human_id,
    binding: bindingFromRow(row),
    capabilitySupportDigest: copyBytes(row.capability_support_digest),
    capabilitySupportVersion: row.capability_support_version,
    compilerAttestationDigest: copyBytes(row.compiler_attestation_digest),
    compilerOutputProtocolVersion: row.compiler_output_protocol_version,
    compilerSemanticProfileVersion: row.compiler_semantic_profile_version,
    compilerVersion: row.compiler_version,
    compatibilityPolicyVersion: row.compatibility_policy_version,
    decidedAt: iso(row.decided_at),
    environmentId: row.environment_id,
    expectedFence: safeBigIntNumber(row.expected_fence, 'expected fence'),
    expectedPointerId: row.expected_pointer_id,
    expiresAt: iso(row.expires_at),
    expiryPolicyVersion: row.expiry_policy_version,
    initiatingHumanId: row.initiating_human_id,
    issuingActorId: row.issuing_actor_id,
    preparationId: row.preparation_id,
    renderedDiffEvidenceDigest: copyBytes(row.rendered_diff_evidence_digest),
    rendererVersion: row.renderer_version,
    rolloutId: row.rollout_id,
    sourceDecisionId: row.source_decision_id,
    targetManifestRoot: copyBytes(row.target_manifest_root),
    targetReleaseId: row.target_release_id,
    tenantId: row.tenant_id,
    transitionPreparationReceiptId: row.transition_preparation_receipt_id,
    verificationEvidenceDigest: copyBytes(row.verification_evidence_digest),
    verificationEvidenceId: row.verification_evidence_id,
    verificationEvidenceVersion: row.verification_evidence_version,
    viewSchemaVersion: row.view_schema_version,
  });
}

function bindingFromRow(row: ApprovalRow): ApprovalDiffBinding {
  if (row.diff_binding_kind === 'INITIAL_ACTIVATION') {
    if (row.diff_binding_version !== INITIAL_ACTIVATION_BINDING_VERSION) {
      fail(
        'BINDING_VERSION_INVALID',
        'initial activation binding version is unsupported',
      );
    }
    return Object.freeze({
      bindingKind: 'INITIAL_ACTIVATION',
      bindingVersion: INITIAL_ACTIVATION_BINDING_VERSION,
      canonicalDiffDigest: copyBytes(row.canonical_diff_digest),
      releaseDiffAlgorithmVersion: null,
      releaseDiffVersion: null,
      sourceManifestRoot: null,
      sourceReleaseId: null,
      transitionPlanDigest: null,
    });
  }
  if (
    row.diff_binding_version !== RELEASE_DIFF_BINDING_VERSION ||
    row.expected_release_id === null ||
    row.source_manifest_root === null ||
    row.release_diff_algorithm_version === null ||
    row.release_diff_version === null
  ) {
    fail(
      'BINDING_VERSION_INVALID',
      'release diff binding is incomplete or unsupported',
    );
  }
  return Object.freeze({
    bindingKind: 'RELEASE_DIFF',
    bindingVersion: RELEASE_DIFF_BINDING_VERSION,
    canonicalDiffDigest: copyBytes(row.canonical_diff_digest),
    releaseDiffAlgorithmVersion: row.release_diff_algorithm_version,
    releaseDiffVersion: row.release_diff_version,
    sourceManifestRoot: copyBytes(row.source_manifest_root),
    sourceReleaseId: row.expected_release_id,
    transitionPlanDigest: row.transition_plan_digest
      ? copyBytes(row.transition_plan_digest)
      : null,
  });
}

function attemptFromRow(row: AttemptRow): ReleaseActivationAttempt {
  return Object.freeze({
    activationAttemptId: row.activation_attempt_id,
    approvalId: row.approval_id,
    attemptContractVersion: row.attempt_contract_version,
    createdAt: iso(row.created_at),
    environmentId: row.environment_id,
    executionPrincipalId: row.execution_principal_id,
    executionPrincipalKind: row.execution_principal_kind,
    state: row.attempt_state,
    tenantId: row.tenant_id,
  });
}

function assertUuid(value: string, name: string): void {
  if (!uuidPattern.test(value)) {
    fail('IDENTITY_INVALID', `${name} must be a UUID identity`);
  }
}

function digestBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    fail(
      'DIGEST_INVALID',
      'persisted release digest is not canonical SHA-256 hex',
    );
  }
  return Buffer.from(hex, 'hex');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function equalOptionalBytes(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  return left === null || right === null
    ? left === right
    : equalBytes(left, right);
}

function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function safeBigIntNumber(value: string, name: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    fail('INTEGER_RANGE_INVALID', `${name} exceeds the safe contract range`);
  }
  return converted;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function requiredRow<T>(value: T | undefined, message: string): T {
  if (value === undefined) fail('CANONICAL_RECORD_NOT_FOUND', message);
  return value;
}

function fail(code: string, message: string): never {
  throw new ReleaseApprovalError(code, message);
}
