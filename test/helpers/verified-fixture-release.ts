import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  COMPILER_TRANSITION_FACTS_VERSION,
  EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
  INITIAL_ACTIVATION_BINDING_VERSION,
  RELEASE_DIFF_BINDING_VERSION,
  SYSTEM_EXECUTION_PRINCIPAL,
  TRANSITION_COMPATIBILITY_POLICY_VERSION,
  TRANSITION_PREPARATION_RECEIPT_VERSION,
  type CreateReleaseApprovalCommand,
  type MintedUuid,
} from '../../packages/platform-runtime/src/index.js';
import type { TrustedRequestContext } from '../../packages/runtime/src/request-context.js';
import { PostgresReleaseActivationService } from '../../packages/postgres-provider/src/release-activation-service.js';
import { PostgresReleaseApprovalService } from '../../packages/postgres-provider/src/release-approval-service.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import {
  readPointer,
  trustedContext,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';

export async function activateFixtureRelease(
  admin: pg.Pool,
  runtime: pg.Pool,
  tenantId: string,
  environmentId: string,
  releaseId: MintedUuid,
): Promise<void> {
  const principalId = randomUUID();
  const approver = await trustedContext({
    tenantId,
    environmentId,
    principalId,
  });
  const system = await trustedContext({
    tenantId,
    environmentId,
    principalId: SYSTEM_EXECUTION_PRINCIPAL.principalId,
  });
  await admin.query(
    'SELECT platform.set_release_approver_eligibility($1,$2,true,$2,$3)',
    [tenantId, principalId, randomUUID()],
  );
  await admin.query(
    `SELECT platform.set_release_executor_authority($1,$2,true,$3,$4)
      WHERE (SELECT authorized FROM platform.release_executor_authority_events
              WHERE tenant_id=$1 AND principal_id=$2 ORDER BY policy_version DESC LIMIT 1)
            IS DISTINCT FROM true`,
    [tenantId, system.principalId, principalId, randomUUID()],
  );
  const attempt = await prepareApproval(runtime, approver, approver, {
    releaseId,
  });
  const result = await new PostgresReleaseActivationService(runtime).activate(
    system,
    attempt,
  );
  assert.equal(result.status, 'SWAPPED_VERIFIED');
  assert.equal(result.releaseId, releaseId);
}

export async function prepareApproval(
  pool: pg.Pool,
  approverContext: TrustedRequestContext,
  preparationContext: TrustedRequestContext,
  target: { releaseId: MintedUuid },
) {
  const current = await readPointer(pool, preparationContext);
  const preparationId = minted(randomUUID());
  const receiptId = minted(randomUUID());
  const release = await withTrustedRequestTransaction(
    pool,
    preparationContext,
    async (client) => {
      const result = await client.query<{
        content_hash: string;
        compiler_attestation_digest: string;
        compiler_version: string;
        compiler_semantic_profile_version: string;
        output_protocol_version: string;
        verification_evidence_id: MintedUuid;
      }>(
        `SELECT content_hash, compiler_attestation_digest, compiler_version,
              compiler_semantic_profile_version, output_protocol_version, verification_evidence_id
           FROM platform.tenant_releases
          WHERE tenant_id = $1 AND environment_id = $2 AND release_id = $3`,
        [
          preparationContext.tenantId,
          preparationContext.environmentId,
          target.releaseId,
        ],
      );
      assert.ok(result.rows[0]);
      return result.rows[0];
    },
  );
  const targetRoot = Buffer.from(release.content_hash, 'hex');
  const sourceRoot =
    current.releaseId === null
      ? null
      : await releaseRoot(pool, preparationContext, current.releaseId);

  await withTrustedRequestTransaction(
    pool,
    preparationContext,
    async (client) => {
      await client.query(
        `INSERT INTO platform.transition_preparation_receipts (
           tenant_id, environment_id, receipt_id, receipt_version,
           source_release_id, source_manifest_root,
           target_release_id, target_manifest_root,
           transition_scope, storage_domain_id, schema_generation,
           compiler_facts_version, compiler_facts_digest,
           compiler_transition_class, compiler_static_compatibility,
           compiler_exact_pair, executor_evidence_version,
           executor_evidence_digest, executor_applied_state,
           executor_exact_pair, compatibility_policy_version,
           compatibility_policy_verdict, recovery_mode
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           'tenantLocal', 'tenant-primary-storage', $9,
           $10, $11, 'NO_STORAGE_TRANSITION', 'SATISFIED', true,
           $12, $13, 'NOT_REQUIRED', true, $14, 'ALLOW',
           'NO_STORAGE_RECOVERY_REQUIRED'
         )`,
        [
          preparationContext.tenantId,
          preparationContext.environmentId,
          receiptId,
          TRANSITION_PREPARATION_RECEIPT_VERSION,
          current.releaseId,
          sourceRoot,
          target.releaseId,
          targetRoot,
          current.fence,
          COMPILER_TRANSITION_FACTS_VERSION,
          digest('compiler-facts', current.pointerId, target.releaseId),
          EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
          digest('executor-evidence', current.pointerId, target.releaseId),
          TRANSITION_COMPATIBILITY_POLICY_VERSION,
        ],
      );

      const initial = current.releaseId === null;
      await client.query(
        `INSERT INTO platform.release_activation_preparations (
           tenant_id, environment_id, preparation_id, preparation_version,
           expected_pointer_id, expected_release_id, expected_fence,
           source_manifest_root, target_release_id, target_manifest_root,
           diff_binding_kind, diff_binding_version, release_diff_version,
           release_diff_algorithm_version, canonical_diff_digest,
           transition_plan_digest, compiler_attestation_digest,
           compiler_version, compiler_semantic_profile_version,
           compiler_output_protocol_version, verification_evidence_id,
           verification_evidence_version, verification_evidence_digest,
           capability_support_version, capability_support_digest,
           capability_support_result, renderer_version, view_schema_version,
           rendered_diff_evidence_digest, transition_preparation_receipt_id
         ) VALUES (
           $1, $2, $3, 'northstar.release-activation-preparation/v1',
           $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL,
           $15, $16, $17, $18, $19, 'northstar.verification-evidence/v1',
           $20, 'northstar.capability-support/v1', $21, 'SUPPORTED',
           'northstar.release-diff-renderer/v1',
           'northstar.release-diff-view/v1', $22, $23
         )`,
        [
          preparationContext.tenantId,
          preparationContext.environmentId,
          preparationId,
          current.pointerId,
          current.releaseId,
          current.fence,
          sourceRoot,
          target.releaseId,
          targetRoot,
          initial ? 'INITIAL_ACTIVATION' : 'RELEASE_DIFF',
          initial
            ? INITIAL_ACTIVATION_BINDING_VERSION
            : RELEASE_DIFF_BINDING_VERSION,
          initial ? null : 'northstar.release-diff/v0-experimental',
          initial ? null : 'northstar.release-diff-algorithm/v1',
          digest('canonical-diff', current.pointerId, target.releaseId),
          Buffer.from(release.compiler_attestation_digest, 'hex'),
          release.compiler_version,
          release.compiler_semantic_profile_version,
          release.output_protocol_version,
          release.verification_evidence_id,
          digest('verification-evidence', release.verification_evidence_id),
          digest('capability-support', target.releaseId),
          digest('rendered-diff', current.pointerId, target.releaseId),
          receiptId,
        ],
      );
    },
  );

  const command: CreateReleaseApprovalCommand = {
    activationAttemptId: minted(randomUUID()),
    approvalId: minted(randomUUID()),
    approvingHumanId: approverContext.principalId,
    initiatingHumanId: approverContext.principalId,
    issuingActorId: approverContext.principalId,
    preparationId,
    targetReleaseId: target.releaseId,
  };
  const created = await new PostgresReleaseApprovalService(pool).createApproval(
    approverContext,
    command,
  );
  return {
    activationAttemptId: created.attempt.activationAttemptId,
    targetReleaseId: created.approval.targetReleaseId,
  };
}

async function releaseRoot(
  pool: pg.Pool,
  context: TrustedRequestContext,
  releaseId: MintedUuid,
): Promise<Uint8Array> {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    const result = await client.query<{ content_hash: string }>(
      'SELECT content_hash FROM platform.tenant_releases WHERE release_id = $1',
      [releaseId],
    );
    assert.ok(result.rows[0]);
    return Buffer.from(result.rows[0].content_hash, 'hex');
  });
}

function digest(...parts: readonly string[]): Uint8Array {
  return createHash('sha256').update(parts.join('\0')).digest();
}
function minted(value: string): MintedUuid {
  return value as MintedUuid;
}
