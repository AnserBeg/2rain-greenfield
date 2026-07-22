import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  ACTIVATION_HISTORY_VERSION,
  ACTIVATION_INVALIDATION_EVENT_CODE,
  ACTIVATION_INVALIDATION_EVENT_VERSION,
  ACTIVATION_OUTBOX_ENVELOPE_VERSION,
  ACTIVATION_OUTCOME_VERSION,
  ACTIVATION_PHASE_RECEIPT_VERSION,
  ACTIVATION_RECONCILIATION_ALARM_VERSION,
  ACTIVATION_SWAP_RECEIPT_VERSION,
  ACTIVATION_VERIFICATION_RECEIPT_VERSION,
  APPROVAL_EXPIRY_SKEW_MARGIN_MILLISECONDS,
  COMPILER_TRANSITION_FACTS_VERSION,
  EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
  RECONCILIATION_MAX_AGE_MILLISECONDS,
  RELEASE_ACTIVATION_CONTROL_POLICY_VERSION,
  RELEASE_EXECUTOR_AUTHORITY_POLICY_VERSION,
  ROLLOUT_CONTROL_POLICY_VERSION,
  SYSTEM_EXECUTION_PRINCIPAL,
  TRANSITION_COMPATIBILITY_POLICY_VERSION,
  type ActivateReleaseCommand,
  type ActivationKernelResult,
  type CancelReleaseActivationCommand,
  type DecisiveActivationOutcomeCode,
  type MintedUuid,
  type ReleaseActivationInvalidationEvent,
} from '@north-star/platform-runtime';
import {
  assertTrustedRequestContext,
  type TrustedRequestContext,
} from '@north-star/runtime';
import type { Pool, PoolClient } from 'pg';

import { withTrustedRequestTransaction } from './request-context.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ReleaseActivationError extends Error {
  override readonly name = 'ReleaseActivationError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ReleaseActivationServiceOptions {
  readonly monotonicNow?: () => number;
  readonly reconciliationMaxAgeMilliseconds?: number;
}

interface AttemptRecordRow {
  activation_attempt_id: MintedUuid;
  approval_id: MintedUuid;
  approving_human_id: string;
  authority_policy_version: string;
  binding_valid: boolean;
  compiler_attestation_digest: Uint8Array;
  compatibility_policy_version: string;
  environment_id: string;
  execution_principal_id: string;
  execution_principal_kind: 'SYSTEM';
  expires_at: Date;
  expected_fence: string;
  expected_pointer_id: MintedUuid;
  expected_release_id: MintedUuid | null;
  initiating_human_id: string;
  issuing_actor_id: string;
  preparation_id: MintedUuid;
  readiness_valid: boolean;
  rollout_id: MintedUuid | null;
  source_manifest_root: Uint8Array | null;
  target_artifact_count: string;
  target_manifest_root: Uint8Array;
  target_release_id: MintedUuid;
  tenant_id: string;
  transition_plan_digest: Uint8Array | null;
  transition_preparation_receipt_id: MintedUuid;
}

interface AuthorityEpochRow {
  approver_policy_version: string;
  control_policy_version: string;
  executor_policy_version: string;
}

interface PointerRow {
  fence: string;
  pointer_id: MintedUuid;
  release_id: MintedUuid | null;
}

interface OutcomeRow {
  outcome_code: DecisiveActivationOutcomeCode;
  pointer_outcome: string;
  terminal: boolean;
  workflow_status: string;
}

interface SwapReceiptRow {
  activated_release_id: MintedUuid;
  activation_attempt_id: MintedUuid;
  approval_id: MintedUuid;
  fence: string;
  history_id: MintedUuid;
  outbox_id: MintedUuid;
  pointer_id: MintedUuid;
  previous_release_id: MintedUuid | null;
  recorded_at: Date;
  swap_receipt_id: MintedUuid;
}

interface VerificationRow {
  activated_release_id: MintedUuid;
  fence: string;
  pointer_id: MintedUuid;
  status: 'SUPERSEDED' | 'SWAPPED_VERIFICATION_FAILED' | 'SWAPPED_VERIFIED';
}

interface ControlState {
  livePolicyDenied: boolean;
  rolloutPaused: boolean;
}

interface SwapTransactionResult {
  result: ActivationKernelResult;
  swapped: boolean;
}

/**
 * Trusted release activation kernel. The only mutation entry is an already
 * prebound attempt; target, base, approval, authority, and evidence are loaded
 * from canonical PostgreSQL records under the attempt/authority locks.
 */
export class PostgresReleaseActivationService {
  readonly #monotonicNow: () => number;
  readonly #reconciliationMaxAgeMilliseconds: number;
  readonly #reconciliationObservedAt = new Map<string, number>();

  constructor(
    private readonly pool: Pool,
    options: ReleaseActivationServiceOptions = {},
  ) {
    const maxAge =
      options.reconciliationMaxAgeMilliseconds ??
      RECONCILIATION_MAX_AGE_MILLISECONDS;
    if (!Number.isSafeInteger(maxAge) || maxAge <= 0) {
      throw new ReleaseActivationError(
        'RECONCILIATION_MAX_AGE_INVALID',
        'reconciliation max age must be a positive safe integer',
      );
    }
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#reconciliationMaxAgeMilliseconds = maxAge;
  }

  async activate(
    context: TrustedRequestContext,
    command: ActivateReleaseCommand,
  ): Promise<ActivationKernelResult> {
    assertTrustedRequestContext(context);
    assertAttemptIdentity(command.activationAttemptId);
    try {
      const swapped = await this.#executeSwapTransaction(context, command);
      if (!swapped.swapped) {
        return await this.#observeIfReconciling(context, swapped.result);
      }
      this.#reconciliationObservedAt.delete(command.activationAttemptId);
      return await this.verifyActivation(context, command);
    } catch (error) {
      if (error instanceof ReleaseActivationError) throw error;
      if (!isResumableDatabaseFailure(error)) throw error;
      return this.#databaseUnavailableResult(
        context,
        command.activationAttemptId,
      );
    }
  }

  async reconcileActivation(
    context: TrustedRequestContext,
    command: ActivateReleaseCommand,
  ): Promise<ActivationKernelResult> {
    assertTrustedRequestContext(context);
    assertAttemptIdentity(command.activationAttemptId);
    try {
      const inspected = await withTrustedRequestTransaction(
        this.pool,
        context,
        async (client) =>
          this.#inspectForReconciliation(client, context, command),
      );
      if (inspected.status === 'SWAPPED_VERIFY_PENDING') {
        this.#reconciliationObservedAt.delete(command.activationAttemptId);
        return await this.verifyActivation(context, command);
      }
      return await this.#observeIfReconciling(context, inspected);
    } catch (error) {
      if (error instanceof ReleaseActivationError) throw error;
      if (!isResumableDatabaseFailure(error)) throw error;
      return this.#databaseUnavailableResult(
        context,
        command.activationAttemptId,
      );
    }
  }

  async cancelActivation(
    context: TrustedRequestContext,
    command: CancelReleaseActivationCommand,
  ): Promise<ActivationKernelResult> {
    assertTrustedRequestContext(context);
    assertAttemptIdentity(command.activationAttemptId);
    try {
      const cancelled = await withTrustedRequestTransaction(
        this.pool,
        context,
        async (client) => {
          const record = await loadAttemptRecord(
            client,
            context,
            command.activationAttemptId,
          );
          assertExecutionPrincipal(context, record);
          const receipt = await loadSwapReceipt(
            client,
            command.activationAttemptId,
          );
          if (receipt) return resultFromReceipt(context, receipt);
          const existing = await loadOutcome(
            client,
            command.activationAttemptId,
          );
          if (existing) return resultFromOutcome(context, record, existing);
          return insertTerminalOutcome(client, context, record, 'CANCELLATION');
        },
      );
      if (cancelled.status === 'SWAPPED_VERIFY_PENDING') {
        return await this.verifyActivation(context, command);
      }
      return cancelled;
    } catch (error) {
      if (error instanceof ReleaseActivationError) throw error;
      if (!isResumableDatabaseFailure(error)) throw error;
      return this.#databaseUnavailableResult(
        context,
        command.activationAttemptId,
      );
    }
  }

  async verifyActivation(
    context: TrustedRequestContext,
    command: ActivateReleaseCommand,
  ): Promise<ActivationKernelResult> {
    assertTrustedRequestContext(context);
    assertAttemptIdentity(command.activationAttemptId);
    try {
      return await withTrustedRequestTransaction(
        this.pool,
        context,
        async (client) => {
          const record = await loadAttemptRecord(
            client,
            context,
            command.activationAttemptId,
          );
          assertExecutionPrincipal(context, record);
          const existing = await loadVerification(
            client,
            command.activationAttemptId,
          );
          if (existing)
            return resultFromVerification(context, record, existing);

          const receipt = await loadSwapReceipt(
            client,
            command.activationAttemptId,
          );
          if (!receipt) {
            const outcome = await loadOutcome(
              client,
              command.activationAttemptId,
            );
            if (outcome) return resultFromOutcome(context, record, outcome);
            return runningResult(context, record, 'RECONCILING');
          }

          const pointer = await lockPointerForVerification(
            client,
            context,
            receipt.pointer_id,
          );
          const pointerIsGeneration =
            pointer !== null &&
            pointer.pointer_id === receipt.pointer_id &&
            pointer.release_id === receipt.activated_release_id &&
            pointer.fence === receipt.fence;
          const verification = await loadVerificationFacts(
            client,
            receipt,
            record,
          );
          const status = !pointerIsGeneration
            ? 'SUPERSEDED'
            : verification.artifactsAvailable && verification.invariantsPassed
              ? 'SWAPPED_VERIFIED'
              : 'SWAPPED_VERIFICATION_FAILED';

          const inserted = await client.query<VerificationRow>(
            `INSERT INTO platform.release_activation_verification_receipts (
               tenant_id,
               environment_id,
               activation_attempt_id,
               verification_receipt_id,
               verification_version,
               pointer_id,
               activated_release_id,
               fence,
               pointer_read_back_passed,
               artifact_availability_passed,
               release_kernel_invariants_passed,
               warning_count,
               status
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8,
               $9, $10, $11, 0, $12
             )
             RETURNING pointer_id, activated_release_id, fence, status`,
            [
              context.tenantId,
              context.environmentId,
              command.activationAttemptId,
              randomUUID(),
              ACTIVATION_VERIFICATION_RECEIPT_VERSION,
              receipt.pointer_id,
              receipt.activated_release_id,
              receipt.fence,
              pointerIsGeneration,
              verification.artifactsAvailable,
              verification.invariantsPassed,
              status,
            ],
          );
          await insertPhaseReceipt(
            client,
            context,
            command.activationAttemptId,
            status,
            safeFence(receipt.fence),
          );
          return resultFromVerification(
            context,
            record,
            requiredRow(
              inserted.rows[0],
              'verification receipt was not inserted',
            ),
          );
        },
      );
    } catch (error) {
      if (error instanceof ReleaseActivationError) throw error;
      if (!isResumableDatabaseFailure(error)) throw error;
      return this.#databaseUnavailableResult(
        context,
        command.activationAttemptId,
      );
    }
  }

  async readInvalidationEvent(
    context: TrustedRequestContext,
    outboxId: MintedUuid,
  ): Promise<ReleaseActivationInvalidationEvent | null> {
    assertTrustedRequestContext(context);
    assertAttemptIdentity(outboxId);
    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      const result = await client.query<{
        activation_attempt_id: MintedUuid;
        deduplication_key: string;
        environment_id: string;
        event_code: typeof ACTIVATION_INVALIDATION_EVENT_CODE;
        event_schema_version: typeof ACTIVATION_INVALIDATION_EVENT_VERSION;
        fence: string;
        history_id: MintedUuid;
        new_release_id: MintedUuid;
        old_release_id: MintedUuid | null;
        outbox_id: MintedUuid;
        pointer_id: MintedUuid;
        tenant_id: string;
      }>(
        `SELECT tenant_id,
                environment_id,
                outbox_id,
                activation_attempt_id,
                event_code,
                event_schema_version,
                pointer_id,
                old_release_id,
                new_release_id,
                fence,
                history_id,
                deduplication_key
           FROM platform.release_activation_outbox
          WHERE tenant_id = $1
            AND environment_id = $2
            AND outbox_id = $3`,
        [context.tenantId, context.environmentId, outboxId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({
        activationAttemptId: row.activation_attempt_id,
        deduplicationKey: row.deduplication_key,
        environmentId: row.environment_id,
        eventCode: row.event_code,
        fence: safeFence(row.fence),
        historyId: row.history_id,
        newReleaseId: row.new_release_id,
        oldReleaseId: row.old_release_id,
        outboxId: row.outbox_id,
        pointerId: row.pointer_id,
        schemaVersion: row.event_schema_version,
        tenantId: row.tenant_id,
      });
    });
  }

  async #executeSwapTransaction(
    context: TrustedRequestContext,
    command: ActivateReleaseCommand,
  ): Promise<SwapTransactionResult> {
    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      const record = await loadAttemptRecord(
        client,
        context,
        command.activationAttemptId,
      );
      assertExecutionPrincipal(context, record);

      const existingReceipt = await loadSwapReceipt(
        client,
        command.activationAttemptId,
      );
      if (existingReceipt) {
        return {
          result: resultFromReceipt(context, existingReceipt),
          swapped: true,
        };
      }
      const existingOutcome = await loadOutcome(
        client,
        command.activationAttemptId,
      );
      if (existingOutcome) {
        return {
          result: resultFromOutcome(context, record, existingOutcome),
          swapped: existingOutcome.outcome_code === 'SWAPPED',
        };
      }

      const epoch = await lockAuthorityEpoch(client, context.tenantId);
      const approverEligible = await loadCurrentApproverEligibility(
        client,
        context.tenantId,
        record.approving_human_id,
      );
      if (!approverEligible) {
        return {
          result: await insertTerminalOutcome(
            client,
            context,
            record,
            'APPROVER_REVOCATION',
          ),
          swapped: false,
        };
      }
      const control = await loadControlState(
        client,
        context,
        record.rollout_id,
      );
      if (control.livePolicyDenied) {
        return {
          result: await insertTerminalOutcome(
            client,
            context,
            record,
            'PRE_CAS_POLICY_DENY',
          ),
          swapped: false,
        };
      }
      if (control.rolloutPaused) {
        await insertPhaseReceipt(
          client,
          context,
          command.activationAttemptId,
          'ROLLOUT_PAUSED',
          null,
        );
        return {
          result: runningResult(context, record, 'PAUSED'),
          swapped: false,
        };
      }
      const executorAuthorized = await loadCurrentExecutorAuthority(
        client,
        context.tenantId,
        record.execution_principal_id,
      );
      if (!executorAuthorized) {
        await insertPhaseReceipt(
          client,
          context,
          command.activationAttemptId,
          'EXECUTOR_UNAVAILABLE',
          null,
        );
        return {
          result: runningResult(context, record, 'EXECUTOR_UNAVAILABLE'),
          swapped: false,
        };
      }
      if (
        safeFence(epoch.approver_policy_version) !==
        safeFence(record.authority_policy_version)
      ) {
        return {
          result: await insertTerminalOutcome(
            client,
            context,
            record,
            'OBSOLETE_POLICY',
          ),
          swapped: false,
        };
      }

      const expiry = await client.query<{ expired: boolean }>(
        `SELECT clock_timestamp() >=
                  $1::timestamptz - ($2::text || ' milliseconds')::interval
                  AS expired`,
        [record.expires_at, APPROVAL_EXPIRY_SKEW_MARGIN_MILLISECONDS],
      );
      if (expiry.rows[0]?.expired !== false) {
        return {
          result: await insertTerminalOutcome(
            client,
            context,
            record,
            'EXPIRED_APPROVAL',
          ),
          swapped: false,
        };
      }
      if (!record.binding_valid) {
        return {
          result: await insertTerminalOutcome(
            client,
            context,
            record,
            'INVALID_BINDING',
          ),
          swapped: false,
        };
      }
      if (!record.readiness_valid || Number(record.target_artifact_count) < 1) {
        return {
          result: await insertTerminalOutcome(
            client,
            context,
            record,
            'DEFINITIVE_BLOCKING_FAILURE',
          ),
          swapped: false,
        };
      }

      const pointer = await loadPointer(client, context);
      if (
        pointer.pointer_id !== record.expected_pointer_id ||
        pointer.release_id !== record.expected_release_id ||
        pointer.fence !== record.expected_fence
      ) {
        return {
          result: await insertTerminalOutcome(
            client,
            context,
            record,
            'STALE_POINTER',
          ),
          swapped: false,
        };
      }

      const ids = {
        historyId: randomUUID() as MintedUuid,
        outboxId: randomUUID() as MintedUuid,
        swapReceiptId: randomUUID() as MintedUuid,
      };
      const newFence = safeFence(record.expected_fence) + 1;
      const cas = await client.query<PointerRow>(
        `UPDATE platform.active_release_pointers AS pointer
            SET release_id = $1,
                fence = pointer.fence + 1
           FROM platform.release_activation_authority_epochs AS epoch
          WHERE pointer.tenant_id = $2
            AND pointer.environment_id = $3
            AND pointer.pointer_id = $4
            AND pointer.release_id IS NOT DISTINCT FROM $5::uuid
            AND pointer.fence = $6
            AND epoch.tenant_id = pointer.tenant_id
            AND epoch.approver_policy_version = $7
            AND epoch.executor_policy_version = $11
            AND epoch.control_policy_version = $12
            AND clock_timestamp() <
                  $8::timestamptz - ($9::text || ' milliseconds')::interval
            AND (
              SELECT event.eligible
                FROM platform.release_approver_eligibility_events AS event
               WHERE event.tenant_id = pointer.tenant_id
                 AND event.principal_id = $10
               ORDER BY event.policy_version DESC
               LIMIT 1
            ) IS TRUE
            AND (
              SELECT event.authorized
                FROM platform.release_executor_authority_events AS event
               WHERE event.tenant_id = pointer.tenant_id
                 AND event.principal_id = $13
                 AND event.authority_policy_contract_version =
                       'northstar.release-executor-authority/v1'
               ORDER BY event.policy_version DESC
               LIMIT 1
            ) IS TRUE
            AND NOT EXISTS (
              SELECT 1
                FROM (
                  SELECT DISTINCT ON (control.rollout_id)
                         control.live_policy_denied,
                         control.rollout_paused,
                         control.control_policy_contract_version
                    FROM platform.release_activation_control_events AS control
                   WHERE control.tenant_id = pointer.tenant_id
                     AND control.environment_id = pointer.environment_id
                     AND (
                       control.rollout_id IS NULL
                       OR control.rollout_id IS NOT DISTINCT FROM $14::uuid
                     )
                   ORDER BY control.rollout_id, control.policy_version DESC
                ) AS current_control
               WHERE current_control.live_policy_denied
                  OR current_control.rollout_paused
                  OR current_control.control_policy_contract_version <>
                       'northstar.release-activation-control/v1'
            )
          RETURNING pointer.pointer_id, pointer.release_id, pointer.fence`,
        [
          record.target_release_id,
          context.tenantId,
          context.environmentId,
          record.expected_pointer_id,
          record.expected_release_id,
          record.expected_fence,
          record.authority_policy_version,
          record.expires_at,
          APPROVAL_EXPIRY_SKEW_MARGIN_MILLISECONDS,
          record.approving_human_id,
          epoch.executor_policy_version,
          epoch.control_policy_version,
          record.execution_principal_id,
          record.rollout_id,
        ],
      );
      if (cas.rowCount !== 1) {
        const current = await loadPointer(client, context);
        const latestEpoch = await loadAuthorityEpoch(client, context.tenantId);
        const nowExpired = await approvalExpired(client, record.expires_at);
        const code: DecisiveActivationOutcomeCode = nowExpired
          ? 'EXPIRED_APPROVAL'
          : latestEpoch.approver_policy_version !==
              record.authority_policy_version
            ? 'OBSOLETE_POLICY'
            : safeFence(current.fence) > safeFence(record.expected_fence)
              ? 'LOST_RACE'
              : 'STALE_POINTER';
        return {
          result: await insertTerminalOutcome(client, context, record, code),
          swapped: false,
        };
      }

      await insertCommittedSwapFacts(client, context, record, ids, newFence);
      return {
        result: Object.freeze({
          activationAttemptId: record.activation_attempt_id,
          alarmDue: false,
          decisiveOutcomeCode: 'SWAPPED',
          environmentId: context.environmentId,
          fence: newFence,
          pointerId: record.expected_pointer_id,
          releaseId: record.target_release_id,
          retryable: true,
          status: 'SWAPPED_VERIFY_PENDING',
          tenantId: context.tenantId,
          terminal: false,
        }),
        swapped: true,
      };
    });
  }

  async #inspectForReconciliation(
    client: PoolClient,
    context: TrustedRequestContext,
    command: ActivateReleaseCommand,
  ): Promise<ActivationKernelResult> {
    const record = await loadAttemptRecord(
      client,
      context,
      command.activationAttemptId,
    );
    assertExecutionPrincipal(context, record);
    const receipt = await loadSwapReceipt(client, command.activationAttemptId);
    if (receipt) {
      const verification = await loadVerification(
        client,
        command.activationAttemptId,
      );
      return verification
        ? resultFromVerification(context, record, verification)
        : resultFromReceipt(context, receipt);
    }
    const outcome = await loadOutcome(client, command.activationAttemptId);
    if (outcome) return resultFromOutcome(context, record, outcome);

    const pointer = await lockPointerForReconciliation(client, context);
    const receiptAfterLock = await loadSwapReceipt(
      client,
      command.activationAttemptId,
    );
    if (receiptAfterLock) return resultFromReceipt(context, receiptAfterLock);
    if (
      pointer.pointer_id === record.expected_pointer_id &&
      pointer.release_id === record.expected_release_id &&
      pointer.fence === record.expected_fence
    ) {
      await insertPhaseReceipt(
        client,
        context,
        command.activationAttemptId,
        'RECONCILING_RETRY',
        safeFence(pointer.fence),
      );
      return runningResult(context, record, 'RECONCILING');
    }
    if (safeFence(pointer.fence) > safeFence(record.expected_fence)) {
      return insertTerminalOutcome(client, context, record, 'LOST_RACE');
    }
    return insertTerminalOutcome(client, context, record, 'INVALID_BINDING');
  }

  async #observeIfReconciling(
    context: TrustedRequestContext,
    result: ActivationKernelResult,
  ): Promise<ActivationKernelResult> {
    if (
      result.status !== 'RECONCILING' &&
      result.status !== 'EXECUTOR_UNAVAILABLE' &&
      result.status !== 'PAUSED'
    ) {
      this.#reconciliationObservedAt.delete(result.activationAttemptId);
      return result;
    }
    const now = validMonotonicNow(this.#monotonicNow());
    const first =
      this.#reconciliationObservedAt.get(result.activationAttemptId) ?? now;
    this.#reconciliationObservedAt.set(result.activationAttemptId, first);
    if (now - first < this.#reconciliationMaxAgeMilliseconds) return result;

    try {
      await withTrustedRequestTransaction(
        this.pool,
        context,
        async (client) => {
          const locked = await client.query<{
            activation_attempt_id: MintedUuid;
          }>(
            `SELECT activation_attempt_id
               FROM platform.lock_release_activation_attempt($1, $2, $3)`,
            [
              context.tenantId,
              context.environmentId,
              result.activationAttemptId,
            ],
          );
          requiredRow(
            locked.rows[0],
            'activation attempt is not visible to the trusted request context',
          );
          await client.query(
            `INSERT INTO platform.release_activation_reconciliation_alarms (
             tenant_id,
             environment_id,
             activation_attempt_id,
             alarm_id,
             alarm_version,
             reason_code,
             max_age_milliseconds
           )
           SELECT $1, $2, attempt.activation_attempt_id, $4, $5,
                  'RECONCILIATION_OVERDUE', $6
             FROM platform.release_activation_attempts AS attempt
            WHERE attempt.tenant_id = $1
              AND attempt.environment_id = $2
              AND attempt.activation_attempt_id = $3
              AND NOT EXISTS (
                SELECT 1
                  FROM platform.release_activation_verification_receipts AS verification
                 WHERE verification.activation_attempt_id =
                       attempt.activation_attempt_id
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM platform.release_activation_attempt_outcomes AS outcome
                 WHERE outcome.activation_attempt_id = attempt.activation_attempt_id
                   AND outcome.terminal
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM platform.release_activation_reconciliation_alarms AS alarm
                 WHERE alarm.activation_attempt_id = attempt.activation_attempt_id
              )`,
            [
              context.tenantId,
              context.environmentId,
              result.activationAttemptId,
              randomUUID(),
              ACTIVATION_RECONCILIATION_ALARM_VERSION,
              this.#reconciliationMaxAgeMilliseconds,
            ],
          );
        },
      );
      return Object.freeze({ ...result, alarmDue: true });
    } catch (error) {
      if (!isResumableDatabaseFailure(error)) throw error;
      return Object.freeze({ ...result, alarmDue: true });
    }
  }

  #databaseUnavailableResult(
    context: TrustedRequestContext,
    activationAttemptId: MintedUuid,
  ): ActivationKernelResult {
    const now = validMonotonicNow(this.#monotonicNow());
    const first =
      this.#reconciliationObservedAt.get(activationAttemptId) ?? now;
    this.#reconciliationObservedAt.set(activationAttemptId, first);
    return Object.freeze({
      activationAttemptId,
      alarmDue: now - first >= this.#reconciliationMaxAgeMilliseconds,
      decisiveOutcomeCode: null,
      environmentId: context.environmentId,
      fence: null,
      pointerId: null,
      releaseId: null,
      retryable: true,
      status: 'RECONCILING',
      tenantId: context.tenantId,
      terminal: false,
    });
  }
}

async function loadAttemptRecord(
  client: PoolClient,
  context: TrustedRequestContext,
  activationAttemptId: MintedUuid,
): Promise<AttemptRecordRow> {
  const locked = await client.query<{ activation_attempt_id: MintedUuid }>(
    `SELECT activation_attempt_id
       FROM platform.lock_release_activation_attempt($1, $2, $3)`,
    [context.tenantId, context.environmentId, activationAttemptId],
  );
  requiredRow(
    locked.rows[0],
    'activation attempt is not visible to the trusted request context',
  );
  const result = await client.query<AttemptRecordRow>(
    `SELECT attempt.tenant_id,
            attempt.environment_id,
            attempt.activation_attempt_id,
            attempt.approval_id,
            attempt.execution_principal_kind,
            attempt.execution_principal_id,
            approval.approving_human_id,
            approval.issuing_actor_id,
            approval.initiating_human_id,
            approval.rollout_id,
            approval.preparation_id,
            approval.target_release_id,
            approval.target_manifest_root,
            approval.expected_pointer_id,
            approval.expected_release_id,
            approval.expected_fence,
            approval.source_manifest_root,
            approval.transition_plan_digest,
            approval.transition_preparation_receipt_id,
            approval.compatibility_policy_version,
            approval.compiler_attestation_digest,
            approval.authority_policy_version,
            approval.expires_at,
            (
              approval.preparation_id = preparation.preparation_id
              AND approval.target_release_id = preparation.target_release_id
              AND approval.target_manifest_root = preparation.target_manifest_root
              AND approval.expected_pointer_id = preparation.expected_pointer_id
              AND approval.expected_release_id IS NOT DISTINCT FROM
                    preparation.expected_release_id
              AND approval.expected_fence = preparation.expected_fence
              AND approval.source_manifest_root IS NOT DISTINCT FROM
                    preparation.source_manifest_root
              AND approval.diff_binding_kind = preparation.diff_binding_kind
              AND approval.diff_binding_version = preparation.diff_binding_version
              AND approval.release_diff_version IS NOT DISTINCT FROM
                    preparation.release_diff_version
              AND approval.release_diff_algorithm_version IS NOT DISTINCT FROM
                    preparation.release_diff_algorithm_version
              AND approval.canonical_diff_digest = preparation.canonical_diff_digest
              AND approval.transition_plan_digest IS NOT DISTINCT FROM
                    preparation.transition_plan_digest
              AND approval.compiler_attestation_digest =
                    preparation.compiler_attestation_digest
              AND approval.compiler_version = preparation.compiler_version
              AND approval.compiler_semantic_profile_version =
                    preparation.compiler_semantic_profile_version
              AND approval.compiler_output_protocol_version =
                    preparation.compiler_output_protocol_version
              AND approval.verification_evidence_id =
                    preparation.verification_evidence_id
              AND approval.verification_evidence_version =
                    preparation.verification_evidence_version
              AND approval.verification_evidence_digest =
                    preparation.verification_evidence_digest
              AND approval.capability_support_version =
                    preparation.capability_support_version
              AND approval.capability_support_digest =
                    preparation.capability_support_digest
              AND preparation.capability_support_result = 'SUPPORTED'
              AND approval.renderer_version = preparation.renderer_version
              AND approval.view_schema_version = preparation.view_schema_version
              AND approval.rendered_diff_evidence_digest =
                    preparation.rendered_diff_evidence_digest
              AND approval.transition_preparation_receipt_id = receipt.receipt_id
              AND approval.expected_release_id IS NOT DISTINCT FROM
                    receipt.source_release_id
              AND approval.source_manifest_root IS NOT DISTINCT FROM
                    receipt.source_manifest_root
              AND approval.target_release_id = receipt.target_release_id
              AND approval.target_manifest_root = receipt.target_manifest_root
              AND approval.compatibility_policy_version =
                    receipt.compatibility_policy_version
              AND approval.target_release_id = target.release_id
              AND approval.target_manifest_root = decode(target.content_hash, 'hex')
              AND approval.compiler_attestation_digest =
                    decode(target.compiler_attestation_digest, 'hex')
              AND approval.compiler_version = target.compiler_version
              AND approval.compiler_semantic_profile_version =
                    target.compiler_semantic_profile_version
              AND approval.compiler_output_protocol_version =
                    target.output_protocol_version
              AND approval.verification_evidence_id =
                    target.verification_evidence_id
            ) AS binding_valid,
            (
              receipt.receipt_version =
                'northstar.transition-preparation-receipt/v1'
              AND receipt.compiler_facts_version = $4
              AND receipt.compiler_transition_class = 'NO_STORAGE_TRANSITION'
              AND receipt.compiler_static_compatibility = 'SATISFIED'
              AND receipt.compiler_exact_pair
              AND receipt.executor_evidence_version = $5
              AND receipt.executor_applied_state = 'NOT_REQUIRED'
              AND receipt.executor_exact_pair
              AND receipt.compatibility_policy_version = $6
              AND receipt.compatibility_policy_verdict = 'ALLOW'
              AND receipt.recovery_mode = 'NO_STORAGE_RECOVERY_REQUIRED'
            ) AS readiness_valid,
            (
              SELECT count(*)
                FROM platform.read_tenant_release_artifacts(
                  approval.target_release_id
                )
            ) AS target_artifact_count
       FROM platform.release_activation_attempts AS attempt
       JOIN platform.release_approvals AS approval
         ON approval.tenant_id = attempt.tenant_id
        AND approval.environment_id = attempt.environment_id
        AND approval.approval_id = attempt.approval_id
        AND approval.activation_attempt_id = attempt.activation_attempt_id
       JOIN platform.release_activation_preparations AS preparation
         ON preparation.tenant_id = approval.tenant_id
        AND preparation.environment_id = approval.environment_id
        AND preparation.preparation_id = approval.preparation_id
       JOIN platform.transition_preparation_receipts AS receipt
         ON receipt.tenant_id = approval.tenant_id
        AND receipt.environment_id = approval.environment_id
        AND receipt.receipt_id = approval.transition_preparation_receipt_id
       JOIN platform.tenant_releases AS target
         ON target.tenant_id = approval.tenant_id
        AND target.environment_id = approval.environment_id
        AND target.release_id = approval.target_release_id
      WHERE attempt.tenant_id = $1
        AND attempt.environment_id = $2
        AND attempt.activation_attempt_id = $3`,
    [
      context.tenantId,
      context.environmentId,
      activationAttemptId,
      COMPILER_TRANSITION_FACTS_VERSION,
      EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
      TRANSITION_COMPATIBILITY_POLICY_VERSION,
    ],
  );
  return requiredRow(
    result.rows[0],
    'activation attempt and canonical approval binding are not visible',
  );
}

async function lockAuthorityEpoch(
  client: PoolClient,
  tenantId: string,
): Promise<AuthorityEpochRow> {
  const result = await client.query<AuthorityEpochRow>(
    `SELECT approver_policy_version,
            executor_policy_version,
            control_policy_version
       FROM platform.lock_release_activation_authority_epoch($1)`,
    [tenantId],
  );
  return requiredRow(
    result.rows[0],
    'activation authority epoch is unavailable',
  );
}

async function loadAuthorityEpoch(
  client: PoolClient,
  tenantId: string,
): Promise<AuthorityEpochRow> {
  const result = await client.query<AuthorityEpochRow>(
    `SELECT approver_policy_version,
            executor_policy_version,
            control_policy_version
       FROM platform.release_activation_authority_epochs
      WHERE tenant_id = $1`,
    [tenantId],
  );
  return requiredRow(
    result.rows[0],
    'activation authority epoch is unavailable',
  );
}

async function loadCurrentApproverEligibility(
  client: PoolClient,
  tenantId: string,
  principalId: string,
): Promise<boolean> {
  const result = await client.query<{ eligible: boolean }>(
    `SELECT eligible
       FROM platform.release_approver_eligibility_events
      WHERE tenant_id = $1 AND principal_id = $2
      ORDER BY policy_version DESC
      LIMIT 1`,
    [tenantId, principalId],
  );
  return result.rows[0]?.eligible === true;
}

async function loadCurrentExecutorAuthority(
  client: PoolClient,
  tenantId: string,
  principalId: string,
): Promise<boolean> {
  const result = await client.query<{
    authority_policy_contract_version: string;
    authorized: boolean;
  }>(
    `SELECT authorized, authority_policy_contract_version
       FROM platform.release_executor_authority_events
      WHERE tenant_id = $1 AND principal_id = $2
      ORDER BY policy_version DESC
      LIMIT 1`,
    [tenantId, principalId],
  );
  return (
    result.rows[0]?.authorized === true &&
    result.rows[0]?.authority_policy_contract_version ===
      RELEASE_EXECUTOR_AUTHORITY_POLICY_VERSION
  );
}

async function loadControlState(
  client: PoolClient,
  context: TrustedRequestContext,
  rolloutId: MintedUuid | null,
): Promise<ControlState> {
  const result = await client.query<{
    contract_valid: boolean;
    live_policy_denied: boolean;
    rollout_paused: boolean;
  }>(
    `WITH relevant AS (
       SELECT DISTINCT ON (rollout_id)
              rollout_id,
              live_policy_denied,
              rollout_paused,
              control_policy_contract_version
         FROM platform.release_activation_control_events
        WHERE tenant_id = $1
          AND environment_id = $2
          AND (rollout_id IS NULL OR rollout_id IS NOT DISTINCT FROM $3::uuid)
        ORDER BY rollout_id, policy_version DESC
     )
     SELECT COALESCE(bool_or(live_policy_denied), false) AS live_policy_denied,
            COALESCE(bool_or(rollout_paused), false) AS rollout_paused,
            COALESCE(
              bool_and(control_policy_contract_version = $4),
              true
            ) AS contract_valid
       FROM relevant`,
    [
      context.tenantId,
      context.environmentId,
      rolloutId,
      RELEASE_ACTIVATION_CONTROL_POLICY_VERSION,
    ],
  );
  const row = requiredRow(
    result.rows[0],
    'activation control state is unavailable',
  );
  return {
    livePolicyDenied: !row.contract_valid || row.live_policy_denied,
    rolloutPaused: row.rollout_paused,
  };
}

async function loadPointer(
  client: PoolClient,
  context: TrustedRequestContext,
): Promise<PointerRow> {
  const result = await client.query<PointerRow>(
    `SELECT pointer_id, release_id, fence
       FROM platform.active_release_pointers
      WHERE tenant_id = $1 AND environment_id = $2`,
    [context.tenantId, context.environmentId],
  );
  return requiredRow(result.rows[0], 'active release pointer is unavailable');
}

async function lockPointerForReconciliation(
  client: PoolClient,
  context: TrustedRequestContext,
): Promise<PointerRow> {
  const result = await client.query<PointerRow>(
    `SELECT pointer_id, release_id, fence
       FROM platform.active_release_pointers
      WHERE tenant_id = $1 AND environment_id = $2
      FOR UPDATE`,
    [context.tenantId, context.environmentId],
  );
  return requiredRow(result.rows[0], 'active release pointer is unavailable');
}

async function lockPointerForVerification(
  client: PoolClient,
  context: TrustedRequestContext,
  pointerId: MintedUuid,
): Promise<PointerRow | null> {
  const result = await client.query<PointerRow>(
    `SELECT pointer_id, release_id, fence
       FROM platform.active_release_pointers
      WHERE tenant_id = $1
        AND environment_id = $2
        AND pointer_id = $3
      FOR SHARE`,
    [context.tenantId, context.environmentId, pointerId],
  );
  return result.rows[0] ?? null;
}

async function loadOutcome(
  client: PoolClient,
  activationAttemptId: MintedUuid,
): Promise<OutcomeRow | null> {
  const result = await client.query<OutcomeRow>(
    `SELECT outcome_code, pointer_outcome, workflow_status, terminal
       FROM platform.release_activation_attempt_outcomes
      WHERE activation_attempt_id = $1`,
    [activationAttemptId],
  );
  return result.rows[0] ?? null;
}

async function loadSwapReceipt(
  client: PoolClient,
  activationAttemptId: MintedUuid,
): Promise<SwapReceiptRow | null> {
  const result = await client.query<SwapReceiptRow>(
    `SELECT activation_attempt_id,
            swap_receipt_id,
            approval_id,
            pointer_id,
            previous_release_id,
            activated_release_id,
            fence,
            history_id,
            outbox_id,
            recorded_at
       FROM platform.release_activation_swap_receipts
      WHERE activation_attempt_id = $1`,
    [activationAttemptId],
  );
  return result.rows[0] ?? null;
}

async function loadVerification(
  client: PoolClient,
  activationAttemptId: MintedUuid,
): Promise<VerificationRow | null> {
  const result = await client.query<VerificationRow>(
    `SELECT pointer_id, activated_release_id, fence, status
       FROM platform.release_activation_verification_receipts
      WHERE activation_attempt_id = $1`,
    [activationAttemptId],
  );
  return result.rows[0] ?? null;
}

async function loadVerificationFacts(
  client: PoolClient,
  receipt: SwapReceiptRow,
  record: AttemptRecordRow,
): Promise<{ artifactsAvailable: boolean; invariantsPassed: boolean }> {
  const result = await client.query<{
    artifacts_available: boolean;
    invariants_passed: boolean;
  }>(
    `SELECT EXISTS (
              SELECT 1
                FROM platform.read_tenant_release_artifacts($1)
               WHERE artifact_kind = 'releaseManifest'
                 AND content_hash = encode($2::bytea, 'hex')
            ) AS artifacts_available,
            EXISTS (
              SELECT 1
                FROM platform.tenant_releases AS release
               WHERE release.release_id = $1
                 AND release.content_hash = encode($2::bytea, 'hex')
                 AND release.compiler_attestation_digest =
                       encode($3::bytea, 'hex')
            )
            AND $4::uuid = $5::uuid
            AND $6::bigint > 0 AS invariants_passed`,
    [
      receipt.activated_release_id,
      record.target_manifest_root,
      record.compiler_attestation_digest,
      receipt.pointer_id,
      record.expected_pointer_id,
      receipt.fence,
    ],
  );
  const row = requiredRow(result.rows[0], 'verification facts are unavailable');
  return {
    artifactsAvailable: row.artifacts_available,
    invariantsPassed: row.invariants_passed,
  };
}

async function approvalExpired(
  client: PoolClient,
  expiresAt: Date,
): Promise<boolean> {
  const result = await client.query<{ expired: boolean }>(
    `SELECT clock_timestamp() >=
              $1::timestamptz - ($2::text || ' milliseconds')::interval
              AS expired`,
    [expiresAt, APPROVAL_EXPIRY_SKEW_MARGIN_MILLISECONDS],
  );
  return result.rows[0]?.expired !== false;
}

async function insertTerminalOutcome(
  client: PoolClient,
  context: TrustedRequestContext,
  record: AttemptRecordRow,
  outcomeCode: Exclude<DecisiveActivationOutcomeCode, 'SWAPPED'>,
): Promise<ActivationKernelResult> {
  const cancelled = outcomeCode === 'CANCELLATION';
  const result = await client.query<OutcomeRow>(
    `INSERT INTO platform.release_activation_attempt_outcomes (
       tenant_id,
       environment_id,
       activation_attempt_id,
       outcome_id,
       outcome_version,
       outcome_code,
       pointer_outcome,
       verification_outcome,
       workflow_disposition,
       workflow_status,
       terminal,
       outcome_digest
     )
     SELECT $1, $2, $3, $4, $5, $6,
            'NOT_SWAPPED', 'NOT_RUN', 'CONSUMED', $7, true, $8
      WHERE NOT EXISTS (
        SELECT 1
          FROM platform.release_activation_swap_receipts AS receipt
         WHERE receipt.activation_attempt_id = $3
      )
     RETURNING outcome_code, pointer_outcome, workflow_status, terminal`,
    [
      context.tenantId,
      context.environmentId,
      record.activation_attempt_id,
      randomUUID(),
      ACTIVATION_OUTCOME_VERSION,
      outcomeCode,
      cancelled ? 'CANCELLED' : 'FAILED',
      digestBytes(
        'terminal-outcome',
        record.activation_attempt_id,
        outcomeCode,
      ),
    ],
  );
  const inserted = result.rows[0];
  if (!inserted) {
    const receipt = await loadSwapReceipt(client, record.activation_attempt_id);
    if (receipt) return resultFromReceipt(context, receipt);
    const existing = await loadOutcome(client, record.activation_attempt_id);
    return resultFromOutcome(
      context,
      record,
      requiredRow(existing ?? undefined, 'decisive outcome was not inserted'),
    );
  }
  await insertPhaseReceipt(
    client,
    context,
    record.activation_attempt_id,
    outcomeCode,
    null,
  );
  return resultFromOutcome(context, record, inserted);
}

async function insertCommittedSwapFacts(
  client: PoolClient,
  context: TrustedRequestContext,
  record: AttemptRecordRow,
  ids: Readonly<{
    historyId: MintedUuid;
    outboxId: MintedUuid;
    swapReceiptId: MintedUuid;
  }>,
  fence: number,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.release_activation_history (
       tenant_id,
       environment_id,
       history_id,
       activation_attempt_id,
       history_version,
       pointer_id,
       approving_human_id,
       issuing_actor_id,
       initiating_human_id,
       execution_principal_kind,
       execution_principal_id,
       from_release_id,
       to_release_id,
       observed_fence,
       pointer_outcome,
       verification_outcome,
       workflow_disposition,
       workflow_status,
       terminal,
       approval_id,
       transition_preparation_receipt_id,
       transition_plan_digest,
       compatibility_policy_version
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       $12, $13, $14,
       'SWAPPED', 'NOT_RUN', 'CONSUMED', 'RUNNING', false,
       $15, $16, $17, $18
     )`,
    [
      context.tenantId,
      context.environmentId,
      ids.historyId,
      record.activation_attempt_id,
      ACTIVATION_HISTORY_VERSION,
      record.expected_pointer_id,
      record.approving_human_id,
      record.issuing_actor_id,
      record.initiating_human_id,
      SYSTEM_EXECUTION_PRINCIPAL.kind,
      record.execution_principal_id,
      record.expected_release_id,
      record.target_release_id,
      fence,
      record.approval_id,
      record.transition_preparation_receipt_id,
      record.transition_plan_digest,
      record.compatibility_policy_version,
    ],
  );

  const deduplicationKey = `northstar:release-activation:${record.activation_attempt_id}:${String(fence)}`;
  const payloadDigest = digestBytes(
    'invalidation-event',
    ACTIVATION_INVALIDATION_EVENT_VERSION,
    context.tenantId,
    context.environmentId,
    record.expected_pointer_id,
    record.expected_release_id ?? 'NULL',
    record.target_release_id,
    fence,
    record.activation_attempt_id,
    ids.historyId,
    ids.outboxId,
    deduplicationKey,
  );
  await client.query(
    `INSERT INTO platform.release_activation_outbox (
       tenant_id,
       environment_id,
       outbox_id,
       activation_attempt_id,
       envelope_version,
       event_code,
       payload_digest,
       pointer_id,
       old_release_id,
       new_release_id,
       fence,
       history_id,
       event_schema_version,
       deduplication_key
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13, $14
     )`,
    [
      context.tenantId,
      context.environmentId,
      ids.outboxId,
      record.activation_attempt_id,
      ACTIVATION_OUTBOX_ENVELOPE_VERSION,
      ACTIVATION_INVALIDATION_EVENT_CODE,
      payloadDigest,
      record.expected_pointer_id,
      record.expected_release_id,
      record.target_release_id,
      fence,
      ids.historyId,
      ACTIVATION_INVALIDATION_EVENT_VERSION,
      deduplicationKey,
    ],
  );

  await client.query(
    `INSERT INTO platform.release_activation_attempt_outcomes (
       tenant_id,
       environment_id,
       activation_attempt_id,
       outcome_id,
       outcome_version,
       outcome_code,
       pointer_outcome,
       verification_outcome,
       workflow_disposition,
       workflow_status,
       terminal,
       outcome_digest
     ) VALUES (
       $1, $2, $3, $4, $5, 'SWAPPED',
       'SWAPPED', 'NOT_RUN', 'CONSUMED', 'RUNNING', false, $6
     )`,
    [
      context.tenantId,
      context.environmentId,
      record.activation_attempt_id,
      randomUUID(),
      ACTIVATION_OUTCOME_VERSION,
      digestBytes(
        'swapped-outcome',
        record.activation_attempt_id,
        record.expected_pointer_id,
        fence,
      ),
    ],
  );

  await client.query(
    `INSERT INTO platform.release_activation_swap_receipts (
       tenant_id,
       environment_id,
       activation_attempt_id,
       swap_receipt_id,
       swap_receipt_version,
       approval_id,
       pointer_id,
       previous_release_id,
       activated_release_id,
       fence,
       history_id,
       outbox_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12
     )`,
    [
      context.tenantId,
      context.environmentId,
      record.activation_attempt_id,
      ids.swapReceiptId,
      ACTIVATION_SWAP_RECEIPT_VERSION,
      record.approval_id,
      record.expected_pointer_id,
      record.expected_release_id,
      record.target_release_id,
      fence,
      ids.historyId,
      ids.outboxId,
    ],
  );
}

async function insertPhaseReceipt(
  client: PoolClient,
  context: TrustedRequestContext,
  activationAttemptId: MintedUuid,
  phaseCode: string,
  fence: number | null,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.release_activation_phase_receipts (
       tenant_id,
       environment_id,
       phase_receipt_id,
       activation_attempt_id,
       receipt_version,
       phase_code,
       receipt_digest
     )
     SELECT $1, $2, $3, $4, $5, $6, $7
      WHERE NOT EXISTS (
        SELECT 1
          FROM platform.release_activation_phase_receipts AS existing
         WHERE existing.activation_attempt_id = $4
           AND existing.phase_code = $6
      )`,
    [
      context.tenantId,
      context.environmentId,
      randomUUID(),
      activationAttemptId,
      ACTIVATION_PHASE_RECEIPT_VERSION,
      phaseCode,
      digestBytes(
        'activation-phase',
        activationAttemptId,
        phaseCode,
        fence ?? 'NONE',
      ),
    ],
  );
}

function resultFromReceipt(
  context: TrustedRequestContext,
  receipt: SwapReceiptRow,
): ActivationKernelResult {
  return Object.freeze({
    activationAttemptId: receipt.activation_attempt_id,
    alarmDue: false,
    decisiveOutcomeCode: 'SWAPPED',
    environmentId: context.environmentId,
    fence: safeFence(receipt.fence),
    pointerId: receipt.pointer_id,
    releaseId: receipt.activated_release_id,
    retryable: true,
    status: 'SWAPPED_VERIFY_PENDING',
    tenantId: context.tenantId,
    terminal: false,
  });
}

function resultFromOutcome(
  context: TrustedRequestContext,
  record: AttemptRecordRow,
  outcome: OutcomeRow,
): ActivationKernelResult {
  return Object.freeze({
    activationAttemptId: record.activation_attempt_id,
    alarmDue: false,
    decisiveOutcomeCode: outcome.outcome_code,
    environmentId: context.environmentId,
    fence: null,
    pointerId: record.expected_pointer_id,
    releaseId:
      outcome.outcome_code === 'SWAPPED' ? record.target_release_id : null,
    retryable: outcome.outcome_code === 'SWAPPED',
    status:
      outcome.outcome_code === 'SWAPPED'
        ? 'SWAPPED_VERIFY_PENDING'
        : 'NO_SWAP_TERMINAL',
    tenantId: context.tenantId,
    terminal: outcome.terminal,
  });
}

function resultFromVerification(
  context: TrustedRequestContext,
  record: AttemptRecordRow,
  verification: VerificationRow,
): ActivationKernelResult {
  const status =
    verification.status === 'SUPERSEDED'
      ? 'SUPERSEDED'
      : verification.status === 'SWAPPED_VERIFICATION_FAILED'
        ? 'SWAPPED_VERIFICATION_FAILED'
        : 'SWAPPED_VERIFIED';
  return Object.freeze({
    activationAttemptId: record.activation_attempt_id,
    alarmDue: false,
    decisiveOutcomeCode: 'SWAPPED',
    environmentId: context.environmentId,
    fence: safeFence(verification.fence),
    pointerId: verification.pointer_id,
    releaseId: verification.activated_release_id,
    retryable: false,
    status,
    tenantId: context.tenantId,
    terminal: true,
  });
}

function runningResult(
  context: TrustedRequestContext,
  record: AttemptRecordRow,
  status: 'EXECUTOR_UNAVAILABLE' | 'PAUSED' | 'RECONCILING',
): ActivationKernelResult {
  return Object.freeze({
    activationAttemptId: record.activation_attempt_id,
    alarmDue: false,
    decisiveOutcomeCode: null,
    environmentId: context.environmentId,
    fence: safeFence(record.expected_fence),
    pointerId: record.expected_pointer_id,
    releaseId: record.expected_release_id,
    retryable: true,
    status,
    tenantId: context.tenantId,
    terminal: false,
  });
}

function assertExecutionPrincipal(
  context: TrustedRequestContext,
  record: AttemptRecordRow,
): void {
  if (
    record.execution_principal_kind !== SYSTEM_EXECUTION_PRINCIPAL.kind ||
    record.execution_principal_id !== SYSTEM_EXECUTION_PRINCIPAL.principalId ||
    context.principalId !== record.execution_principal_id
  ) {
    throw new ReleaseActivationError(
      'EXECUTION_PRINCIPAL_MISMATCH',
      'activation requires the trusted prebound SYSTEM execution principal',
    );
  }
}

function assertAttemptIdentity(value: string): asserts value is MintedUuid {
  if (!uuidPattern.test(value)) {
    throw new ReleaseActivationError(
      'ACTIVATION_ATTEMPT_ID_INVALID',
      'activation attempt identity must be a UUID',
    );
  }
}

function digestBytes(
  domain: string,
  ...parts: readonly (number | string | Uint8Array)[]
): Uint8Array {
  const hash = createHash('sha256');
  hash.update(domain);
  hash.update('\0');
  for (const part of parts) {
    const bytes =
      typeof part === 'number'
        ? Buffer.from(String(part))
        : typeof part === 'string'
          ? Buffer.from(part)
          : Buffer.from(part);
    hash.update(Buffer.from(String(bytes.byteLength)));
    hash.update(':');
    hash.update(bytes);
  }
  return hash.digest();
}

function safeFence(value: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new ReleaseActivationError(
      'FENCE_RANGE_INVALID',
      'pointer fence exceeds the safe contract range',
    );
  }
  return converted;
}

function validMonotonicNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ReleaseActivationError(
      'MONOTONIC_CLOCK_INVALID',
      'monotonic clock returned an invalid elapsed value',
    );
  }
  return value;
}

function requiredRow<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new ReleaseActivationError('CANONICAL_RECORD_NOT_FOUND', message);
  }
  return value;
}

const RESUMABLE_DATABASE_ERROR_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available / lock timeout
  '57014', // query_canceled / statement timeout
  '57P01', // admin_shutdown (including pg_terminate_backend)
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);

/**
 * Only failures that make commit visibility uncertain or are explicitly
 * retryable infrastructure/time failures enter reconciliation. SQL,
 * constraint, binding, and programming defects must remain visible.
 */
function isResumableDatabaseFailure(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some((nested) => isResumableDatabaseFailure(nested));
  }
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string') {
    if (code.startsWith('08') || RESUMABLE_DATABASE_ERROR_CODES.has(code)) {
      return true;
    }
  }
  return /(?:connection|socket) (?:ended|closed|lost|terminated|was terminated) unexpectedly/i.test(
    error.message,
  );
}

// Frozen name/ownership seam: G1-P5 supplies the dispatcher implementation.
export const ACTIVATION_INVALIDATION_DISPATCHER_OWNER =
  'G1-P5 activation-invalidation dispatcher (at-least-once delivery)' as const;

// Kept explicit so provider code cannot silently treat rollout state as grant.
export const ACTIVATION_ROLLOUT_CONTROL_CONTRACT = Object.freeze({
  authority: 'deny-only' as const,
  policyVersion: ROLLOUT_CONTROL_POLICY_VERSION,
});
