import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, connect, type Server } from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import pg from 'pg';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  canonicalizeAndHash,
} from '../../packages/canonical-model/src/index.js';
import {
  compileApplication,
  type CompileSuccess,
} from '../../packages/compiler/src/index.js';
import {
  ACTIVATION_INVALIDATION_EVENT_CODE,
  ACTIVATION_INVALIDATION_EVENT_VERSION,
  COMPILER_TRANSITION_FACTS_VERSION,
  EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
  INITIAL_ACTIVATION_BINDING_VERSION,
  RELEASE_DIFF_BINDING_VERSION,
  ReleaseInvalidationFenceState,
  SYSTEM_EXECUTION_PRINCIPAL,
  TRANSITION_COMPATIBILITY_POLICY_VERSION,
  TRANSITION_PREPARATION_RECEIPT_VERSION,
  type ActivationKernelResult,
  type CreateReleaseApprovalCommand,
  type MintedUuid,
  type RegisterTenantReleaseCommand,
  type StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import {
  PostgresReleaseActivationService,
  ReleaseActivationError,
} from '../../packages/postgres-provider/src/release-activation-service.js';
import { PostgresReleaseApprovalService } from '../../packages/postgres-provider/src/release-approval-service.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { verificationEvidenceIdForCandidate } from '../../packages/postgres-provider/src/release-verification-service.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import {
  AuthenticatedRequestEntryAdapter,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import { compilerInput, fixtureBytes } from '../compiler/helpers.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';
import {
  admitEmptyPlanRelease,
  definitionWithoutAssertions,
} from './release-verification-fixture.js';

const execFileAsync = promisify(execFile);
const checkedInMigrations = resolve('db/migrations');

const tenantA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const environmentA = 'a1000000-0000-4000-8000-000000000001';
const environmentA2 = 'a1000000-0000-4000-8000-000000000002';
const environmentB = 'b1000000-0000-4000-8000-000000000001';
const makerA = 'aa000000-0000-4000-8000-000000000001';
const approverA = 'ac000000-0000-4000-8000-000000000002';
const makerB = 'ba000000-0000-4000-8000-000000000001';
const approverB = 'bc000000-0000-4000-8000-000000000002';
const authorityOperator = 'a9000000-0000-4000-8000-000000000009';

interface ReleaseFixture {
  compiled: CompileSuccess;
  evidenceId: MintedUuid;
  releaseId: MintedUuid;
  revisionId: MintedUuid;
}

interface AttemptFixture {
  activationAttemptId: MintedUuid;
  approvalId: MintedUuid;
  expectedFence: number;
  pointerId: MintedUuid;
  targetReleaseId: MintedUuid;
}

interface PointerFixture {
  fence: number;
  pointerId: MintedUuid;
  releaseId: MintedUuid | null;
}

test('G1-P4b atomic activation, reconciliation, rollback, and invalidation', async (t) => {
  const bootstrapBytes = fixtureBytes('bootstrap');
  const verticalBytes = definitionWithoutAssertions(bootstrapBytes, '1.0.1');
  const bootstrap = mustCompile(bootstrapBytes);
  const vertical = mustCompile(verticalBytes);

  await withEphemeralPostgres(
    'release-activation',
    async ({ connection, containerName, pool }) => {
      const admin = await pool.connect();
      try {
        await runMigrations(admin, await loadMigrations(checkedInMigrations));
        await seedScopes(admin);
      } finally {
        admin.release();
      }

      const webPool = runtimePool(connection, 4);
      const workerPool = runtimePool(connection, 4);
      const makerContextA = await trustedContext(tenantA, environmentA, makerA);
      const makerContextA2 = await trustedContext(
        tenantA,
        environmentA2,
        makerA,
      );
      const approverContextA = await trustedContext(
        tenantA,
        environmentA,
        approverA,
      );
      const approverContextA2 = await trustedContext(
        tenantA,
        environmentA2,
        approverA,
      );
      const systemContextA = await trustedContext(
        tenantA,
        environmentA,
        SYSTEM_EXECUTION_PRINCIPAL.principalId,
      );
      const systemContextA2 = await trustedContext(
        tenantA,
        environmentA2,
        SYSTEM_EXECUTION_PRINCIPAL.principalId,
      );
      const makerContextB = await trustedContext(tenantB, environmentB, makerB);
      const approverContextB = await trustedContext(
        tenantB,
        environmentB,
        approverB,
      );
      const systemContextB = await trustedContext(
        tenantB,
        environmentB,
        SYSTEM_EXECUTION_PRINCIPAL.principalId,
      );

      try {
        const releasesA = await seedReleases(
          webPool,
          makerContextA,
          bootstrapBytes,
          verticalBytes,
          bootstrap,
          vertical,
          7,
        );
        const releasesA2 = await seedEnvironmentReleases(
          webPool,
          makerContextA2,
          releasesA[0]!.revisionId,
          releasesA[1]!.revisionId,
          bootstrap,
          vertical,
          2,
        );
        const releasesB = await seedReleases(
          webPool,
          makerContextB,
          bootstrapBytes,
          verticalBytes,
          bootstrap,
          vertical,
          2,
        );

        await changeApproverEligibility(pool, tenantA, approverA, true);
        await changeApproverEligibility(pool, tenantB, approverB, true);
        await changeExecutorAuthority(pool, tenantA, true);
        await changeExecutorAuthority(pool, tenantB, true);

        const webService = new PostgresReleaseActivationService(webPool);
        const workerService = new PostgresReleaseActivationService(workerPool);

        t.beforeEach(async () => {
          await ensureApproverEligibility(pool, tenantA, approverA, true);
          await ensureApproverEligibility(pool, tenantB, approverB, true);
          await ensureExecutorAuthority(pool, tenantA, true);
          await ensureExecutorAuthority(pool, tenantB, true);
          await ensureControlState(pool, tenantA, environmentA, false, false);
          await ensureControlState(pool, tenantA, environmentA2, false, false);
          await ensureControlState(pool, tenantB, environmentB, false, false);
        });

        await t.test(
          'null-base activation and concurrent retries commit one complete generation',
          async () => {
            const attempt = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              releasesA[0]!,
            );
            const before = await pointer(pool, tenantA, environmentA);
            assert.equal(before.releaseId, null);
            assert.equal(attempt.expectedFence, 0);
            const readOnlyReconciliation = await webService.reconcileActivation(
              systemContextA,
              attempt,
            );
            assert.equal(readOnlyReconciliation.status, 'RECONCILING');
            assert.deepEqual(
              await pointer(pool, tenantA, environmentA),
              before,
            );

            const results = await Promise.all([
              webService.activate(systemContextA, attempt),
              workerService.activate(systemContextA, attempt),
            ]);
            assert.ok(
              results.every((result) => result.status === 'SWAPPED_VERIFIED'),
            );
            assert.equal(
              (await webService.reconcileActivation(systemContextA, attempt))
                .status,
              'SWAPPED_VERIFIED',
            );
            await assertOneAtomicGeneration(pool, before, [
              attempt.activationAttemptId,
            ]);
          },
        );

        let zombieAttempt: AttemptFixture | undefined;
        await t.test(
          'different targets and same-target approvals race with one winner',
          async () => {
            const before = await pointer(pool, tenantA, environmentA);
            const attempts = await Promise.all([
              prepareApproval(
                webPool,
                approverContextA,
                makerContextA,
                releasesA[1]!,
              ),
              prepareApproval(
                webPool,
                approverContextA,
                makerContextA,
                releasesA[1]!,
              ),
              prepareApproval(
                webPool,
                approverContextA,
                makerContextA,
                releasesA[2]!,
              ),
            ]);
            const results = await Promise.all(
              attempts.map((attempt, index) =>
                (index % 2 === 0 ? webService : workerService).activate(
                  systemContextA,
                  attempt,
                ),
              ),
            );
            assert.equal(
              results.filter(
                (result) => result.decisiveOutcomeCode === 'SWAPPED',
              ).length,
              1,
            );
            assert.ok(
              results
                .filter((result) => result.decisiveOutcomeCode !== 'SWAPPED')
                .every(
                  (result) =>
                    result.decisiveOutcomeCode === 'LOST_RACE' ||
                    result.decisiveOutcomeCode === 'STALE_POINTER',
                ),
            );
            zombieAttempt = attempts.find(
              (_, index) => results[index]?.decisiveOutcomeCode !== 'SWAPPED',
            );
            await assertOneAtomicGeneration(
              pool,
              before,
              attempts.map((attempt) => attempt.activationAttemptId),
            );
          },
        );

        await t.test(
          'no-receipt attempt records LOST_RACE only after a later fence',
          async () => {
            const before = await pointer(pool, tenantA, environmentA);
            const targetA = releaseOtherThan(releasesA, before.releaseId, 3);
            const attemptA = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              targetA,
            );
            const pending = await webService.reconcileActivation(
              systemContextA,
              attemptA,
            );
            assert.equal(pending.status, 'RECONCILING');
            assert.deepEqual(
              await attemptFactCounts(pool, [attemptA.activationAttemptId]),
              {
                histories: 0,
                outboxRows: 0,
                outcomes: 0,
                receipts: 0,
                swappedOutcomes: 0,
              },
            );

            const targetB = releaseOtherThan(releasesA, before.releaseId, 4);
            const attemptB = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              targetB,
            );
            assert.equal(
              (await workerService.activate(systemContextA, attemptB)).status,
              'SWAPPED_VERIFIED',
            );
            const generationB = await pointer(pool, tenantA, environmentA);
            assert.equal(generationB.fence, before.fence + 1);

            const lost = await webService.reconcileActivation(
              systemContextA,
              attemptA,
            );
            assert.equal(lost.decisiveOutcomeCode, 'LOST_RACE');
            assert.equal(lost.status, 'NO_SWAP_TERMINAL');
            assert.equal(lost.terminal, true);
            assert.deepEqual(
              await attemptFactCounts(pool, [attemptA.activationAttemptId]),
              {
                histories: 0,
                outboxRows: 0,
                outcomes: 1,
                receipts: 0,
                swappedOutcomes: 0,
              },
            );
            assert.deepEqual(
              await pointer(pool, tenantA, environmentA),
              generationB,
            );
          },
        );

        await t.test(
          'overdue recovery completion is derivable without its alarm projection',
          async () => {
            const before = await pointer(pool, tenantA, environmentA);
            const attemptA = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              releaseOtherThan(releasesA, before.releaseId, 5),
            );
            const attemptB = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              releaseOtherThan(releasesA, before.releaseId, 6),
            );
            const maxAgeMilliseconds = 2_000;
            const boundedService = new PostgresReleaseActivationService(
              webPool,
              { reconciliationMaxAgeMilliseconds: maxAgeMilliseconds },
            );
            assert.equal(
              (
                await boundedService.reconcileActivation(
                  systemContextA,
                  attemptA,
                )
              ).status,
              'RECONCILING',
            );
            const pending = await boundedService.inspectReconciliationState(
              systemContextA,
              attemptA,
            );
            assert.equal(
              pending.activationAttemptId,
              attemptA.activationAttemptId,
            );
            assert.equal(pending.tenantId, tenantA);
            assert.equal(pending.environmentId, environmentA);
            assert.equal(pending.state, 'PENDING');
            assert.equal(pending.overdue, false);
            assert.equal(pending.alarmRecorded, false);
            assert.equal(pending.completionAt, null);
            assert.equal(pending.maxAgeMilliseconds, maxAgeMilliseconds);
            assert.ok(pending.startedAt);
            assert.ok(pending.deadlineAt);
            assert.ok(pending.observedAt);

            assert.equal(
              (await boundedService.activate(systemContextA, attemptB)).status,
              'SWAPPED_VERIFIED',
            );
            const generationB = await pointer(pool, tenantA, environmentA);

            await withCommitDroppingProxy(
              connection,
              async (proxyPort) => {
                const faultPool = runtimePool(
                  { ...connection, host: '127.0.0.1', port: proxyPort },
                  1,
                );
                faultPool.on('error', () => undefined);
                faultPool.on('connect', (client) => {
                  client.on('error', () => undefined);
                });
                try {
                  const faultingWorker = new PostgresReleaseActivationService(
                    faultPool,
                  );
                  const ambiguous = await faultingWorker.reconcileActivation(
                    systemContextA,
                    attemptA,
                  );
                  assert.equal(ambiguous.status, 'RECONCILING');
                  assert.equal(ambiguous.alarmDue, false);
                } finally {
                  await faultPool.end();
                }
              },
              {
                delayCommitResponse: {
                  commitNumber: 1,
                  milliseconds: maxAgeMilliseconds + 200,
                },
                dropCommitResponseNumber: 2,
              },
            );

            const alarm = await pool.query<{ count: string }>(
              `SELECT count(*)
                 FROM platform.release_activation_reconciliation_alarms
                WHERE activation_attempt_id = $1`,
              [attemptA.activationAttemptId],
            );
            assert.equal(alarm.rows[0]?.count, '0');
            const completion = await pool.query<{
              outcome_code: string;
              recorded_at: Date;
            }>(
              `SELECT outcome_code, recorded_at
                 FROM platform.release_activation_attempt_outcomes
                WHERE activation_attempt_id = $1`,
              [attemptA.activationAttemptId],
            );
            assert.equal(completion.rows.length, 1);
            assert.equal(completion.rows[0]?.outcome_code, 'LOST_RACE');
            assert.deepEqual(
              await attemptFactCounts(pool, [attemptA.activationAttemptId]),
              {
                histories: 0,
                outboxRows: 0,
                outcomes: 1,
                receipts: 0,
                swappedOutcomes: 0,
              },
            );
            assert.deepEqual(
              await pointer(pool, tenantA, environmentA),
              generationB,
            );

            const observerPool = runtimePool(connection, 1);
            try {
              const freshObserver = new PostgresReleaseActivationService(
                observerPool,
              );
              const overdue = await freshObserver.inspectReconciliationState(
                systemContextA,
                attemptA,
              );
              assert.equal(overdue.state, 'OVERDUE_COMPLETED');
              assert.equal(overdue.overdue, true);
              assert.equal(overdue.alarmRecorded, false);
              assert.ok(overdue.completionAt);
              assert.ok(overdue.deadlineAt);
              assert.ok(overdue.completionAt >= overdue.deadlineAt);
              assert.equal(
                overdue.completionAt,
                completion.rows[0]?.recorded_at.toISOString(),
              );

              const prompt = await freshObserver.inspectReconciliationState(
                systemContextA,
                attemptB,
              );
              assert.equal(prompt.state, 'COMPLETED_WITHIN_MAX_AGE');
              assert.equal(prompt.overdue, false);
              assert.equal(prompt.alarmRecorded, false);
              assert.ok(prompt.deadlineAt);
              assert.ok(prompt.observedAt >= prompt.deadlineAt);
            } finally {
              await observerPool.end();
            }
            assert.equal(
              (
                await pool.query<{ count: string }>(
                  `SELECT count(*)
                     FROM platform.release_activation_reconciliation_alarms
                    WHERE activation_attempt_id = $1`,
                  [attemptA.activationAttemptId],
                )
              ).rows[0]?.count,
              '0',
            );
          },
        );

        await t.test(
          'blocked recovery records completion at statement time after its deadline',
          async () => {
            const before = await pointer(pool, tenantA, environmentA);
            const attemptA = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              releaseOtherThan(releasesA, before.releaseId, 0),
            );
            const attemptB = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              releaseOtherThan(releasesA, before.releaseId, 1),
            );
            const maxAgeMilliseconds = 3_000;
            const boundedService = new PostgresReleaseActivationService(
              webPool,
              { reconciliationMaxAgeMilliseconds: maxAgeMilliseconds },
            );
            assert.equal(
              (
                await boundedService.reconcileActivation(
                  systemContextA,
                  attemptA,
                )
              ).status,
              'RECONCILING',
            );
            const pending = await boundedService.inspectReconciliationState(
              systemContextA,
              attemptA,
            );
            assert.equal(pending.state, 'PENDING');
            assert.ok(pending.deadlineAt);

            assert.equal(
              (await boundedService.activate(systemContextA, attemptB)).status,
              'SWAPPED_VERIFIED',
            );
            const generationB = await pointer(pool, tenantA, environmentA);
            const applicationName = `g1-p4b-blocked-${randomUUID()}`;
            const recoveryPool = runtimePool(
              { ...connection, application_name: applicationName },
              1,
            );
            const blocker = await pool.connect();
            let blockerTransactionOpen = false;
            let recovery: Promise<ActivationKernelResult> | undefined =
              undefined;
            try {
              await blocker.query('BEGIN');
              blockerTransactionOpen = true;
              const blockerIdentity = await blocker.query<{ pid: number }>(
                `SELECT pg_backend_pid() AS pid`,
              );
              const blockerPid = blockerIdentity.rows[0]?.pid;
              assert.ok(blockerPid);
              await blocker.query(
                `SELECT pointer_id
                   FROM platform.active_release_pointers
                  WHERE tenant_id = $1
                    AND environment_id = $2
                    AND pointer_id = $3
                  FOR UPDATE`,
                [tenantA, environmentA, generationB.pointerId],
              );

              const recoveryService = new PostgresReleaseActivationService(
                recoveryPool,
              );
              recovery = recoveryService.reconcileActivation(
                systemContextA,
                attemptA,
              );
              const blocked = await waitForBlockedRecoveryTransaction(
                pool,
                applicationName,
                blockerPid,
                pending.deadlineAt,
              );
              assert.equal(blocked.beganBeforeDeadline, true);
              assert.equal(blocked.blockedBeforeDeadline, true);
              assert.ok(blocked.transactionStartedAt < pending.deadlineAt);
              assert.ok(blocked.observedAt < pending.deadlineAt);

              const crossedAt = await waitForPostgresDeadline(
                blocker,
                pending.deadlineAt,
              );
              assert.ok(crossedAt >= pending.deadlineAt);
              await blocker.query('COMMIT');
              blockerTransactionOpen = false;

              const recovered = await recovery;
              assert.equal(recovered.decisiveOutcomeCode, 'LOST_RACE');
              assert.equal(recovered.status, 'NO_SWAP_TERMINAL');
              assert.deepEqual(
                await pointer(pool, tenantA, environmentA),
                generationB,
              );

              const completion = await pool.query<{
                after_deadline: boolean;
                outcome_code: string;
                recorded_at: Date;
              }>(
                `SELECT outcome_code,
                        recorded_at,
                        recorded_at >= $2::timestamptz AS after_deadline
                   FROM platform.release_activation_attempt_outcomes
                  WHERE activation_attempt_id = $1`,
                [attemptA.activationAttemptId, pending.deadlineAt],
              );
              assert.equal(completion.rows.length, 1);
              assert.equal(completion.rows[0]?.outcome_code, 'LOST_RACE');
              assert.equal(completion.rows[0]?.after_deadline, true);
              assert.ok(completion.rows[0]);
              assert.ok(
                completion.rows[0].recorded_at.toISOString() >
                  blocked.transactionStartedAt,
              );

              const observerPool = runtimePool(connection, 1);
              try {
                const freshObserver = new PostgresReleaseActivationService(
                  observerPool,
                );
                const overdue = await freshObserver.inspectReconciliationState(
                  systemContextA,
                  attemptA,
                );
                assert.equal(overdue.state, 'OVERDUE_COMPLETED');
                assert.equal(overdue.overdue, true);
                assert.equal(
                  overdue.completionAt,
                  completion.rows[0].recorded_at.toISOString(),
                );
              } finally {
                await observerPool.end();
              }
            } finally {
              if (blockerTransactionOpen) await blocker.query('ROLLBACK');
              if (recovery) await recovery.catch(() => undefined);
              blocker.release();
              await recoveryPool.end();
            }
          },
        );

        await t.test(
          'same tenant/different environments and two tenants activate independently',
          async () => {
            const beforeA2 = await pointer(pool, tenantA, environmentA2);
            const beforeB = await pointer(pool, tenantB, environmentB);
            const attemptA2 = await prepareApproval(
              webPool,
              approverContextA2,
              makerContextA2,
              releasesA2[0]!,
            );
            const attemptB = await prepareApproval(
              webPool,
              approverContextB,
              makerContextB,
              releasesB[0]!,
            );
            const [resultA2, resultB] = await Promise.all([
              webService.activate(systemContextA2, attemptA2),
              workerService.activate(systemContextB, attemptB),
            ]);
            assert.equal(resultA2.status, 'SWAPPED_VERIFIED');
            assert.equal(resultB.status, 'SWAPPED_VERIFIED');
            await assertOneAtomicGeneration(pool, beforeA2, [
              attemptA2.activationAttemptId,
            ]);
            await assertOneAtomicGeneration(pool, beforeB, [
              attemptB.activationAttemptId,
            ]);
          },
        );

        await t.test(
          'rollback is a fresh approval on the same path and races a forward activation',
          async () => {
            const before = await pointer(pool, tenantA, environmentA);
            assert.notEqual(before.releaseId, releasesA[0]!.releaseId);
            const rollback = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              releasesA[0]!,
            );
            const forward = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              releasesA[3]!,
            );
            const results = await Promise.all([
              webService.activate(systemContextA, rollback),
              workerService.activate(systemContextA, forward),
            ]);
            assert.equal(
              results.filter(
                (result) => result.decisiveOutcomeCode === 'SWAPPED',
              ).length,
              1,
            );
            await assertOneAtomicGeneration(pool, before, [
              rollback.activationAttemptId,
              forward.activationAttemptId,
            ]);

            assert.ok(zombieAttempt);
            const afterRace = await pointer(pool, tenantA, environmentA);
            const zombie = await workerService.reconcileActivation(
              systemContextA,
              zombieAttempt,
            );
            assert.equal(zombie.status, 'NO_SWAP_TERMINAL');
            assert.deepEqual(
              await pointer(pool, tenantA, environmentA),
              afterRace,
            );
          },
        );

        await t.test(
          'cancellation and terminal expiry serialize against CAS',
          async () => {
            const before = await pointer(pool, tenantA, environmentA);
            const target = releaseOtherThan(releasesA, before.releaseId, 4);
            const attempt = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              target,
            );
            const [activated, cancelled] = await Promise.all([
              webService.activate(systemContextA, attempt),
              workerService.cancelActivation(systemContextA, attempt),
            ]);
            const after = await pointer(pool, tenantA, environmentA);
            const facts = await attemptFactCounts(pool, [
              attempt.activationAttemptId,
            ]);
            if (facts.receipts === 1) {
              assert.equal(after.fence, before.fence + 1);
              assert.deepEqual(facts, {
                histories: 1,
                outboxRows: 1,
                outcomes: 1,
                receipts: 1,
                swappedOutcomes: 1,
              });
            } else {
              assert.equal(after.fence, before.fence);
              assert.deepEqual(facts, {
                histories: 0,
                outboxRows: 0,
                outcomes: 1,
                receipts: 0,
                swappedOutcomes: 0,
              });
            }
            assert.equal(
              activated.decisiveOutcomeCode,
              cancelled.decisiveOutcomeCode,
            );

            const current = await pointer(pool, tenantA, environmentA);
            const expiredTarget = releaseOtherThan(
              releasesA,
              current.releaseId,
              5,
            );
            const past = new Date(Date.now() - 60_000);
            const expiredAttempt = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              expiredTarget,
              {
                approvalNow: past,
                expiresAt: new Date(past.getTime() + 10_000).toISOString(),
              },
            );
            const expired = await webService.activate(
              systemContextA,
              expiredAttempt,
            );
            assert.equal(expired.decisiveOutcomeCode, 'EXPIRED_APPROVAL');
            assert.equal(expired.status, 'NO_SWAP_TERMINAL');
            assert.deepEqual(
              await webService.activate(systemContextA, expiredAttempt),
              expired,
            );
          },
        );

        await t.test(
          'executor denial and rollout pause stay resumable; live deny consumes',
          async () => {
            let current = await pointer(pool, tenantA, environmentA);
            if (current.releaseId === null) {
              const baselineAttempt = await prepareApproval(
                webPool,
                approverContextA,
                makerContextA,
                releasesA[0]!,
              );
              assert.equal(
                (await webService.activate(systemContextA, baselineAttempt))
                  .status,
                'SWAPPED_VERIFIED',
              );
              current = await pointer(pool, tenantA, environmentA);
            }
            let target = releaseOtherThan(releasesA, current.releaseId, 6);
            const unsupportedTransition = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              target,
              { readiness: 'UNSUPPORTED_TRANSITION' },
            );
            const blocked = await webService.activate(
              systemContextA,
              unsupportedTransition,
            );
            assert.equal(
              blocked.decisiveOutcomeCode,
              'DEFINITIVE_BLOCKING_FAILURE',
            );
            assert.deepEqual(
              await pointer(pool, tenantA, environmentA),
              current,
            );

            const executorAttempt = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              target,
            );
            await changeExecutorAuthority(pool, tenantA, false);
            const unavailable = await webService.activate(
              systemContextA,
              executorAttempt,
            );
            assert.equal(unavailable.status, 'EXECUTOR_UNAVAILABLE');
            assert.equal(unavailable.decisiveOutcomeCode, null);
            await changeExecutorAuthority(pool, tenantA, true);
            assert.equal(
              (await webService.activate(systemContextA, executorAttempt))
                .status,
              'SWAPPED_VERIFIED',
            );

            current = await pointer(pool, tenantA, environmentA);
            target = releaseOtherThan(releasesA, current.releaseId, 0);
            const pausedAttempt = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              target,
            );
            await changeControl(pool, tenantA, environmentA, false, true);
            const paused = await webService.activate(
              systemContextA,
              pausedAttempt,
            );
            assert.equal(paused.status, 'PAUSED');
            assert.equal(paused.decisiveOutcomeCode, null);
            await changeControl(pool, tenantA, environmentA, false, false);
            assert.equal(
              (await webService.activate(systemContextA, pausedAttempt)).status,
              'SWAPPED_VERIFIED',
            );

            current = await pointer(pool, tenantA, environmentA);
            target = releaseOtherThan(releasesA, current.releaseId, 1);
            const deniedAttempt = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              target,
            );
            await changeControl(pool, tenantA, environmentA, true, false);
            const denied = await webService.activate(
              systemContextA,
              deniedAttempt,
            );
            assert.equal(denied.decisiveOutcomeCode, 'PRE_CAS_POLICY_DENY');
            assert.equal(denied.status, 'NO_SWAP_TERMINAL');
            await changeControl(pool, tenantA, environmentA, false, false);
          },
        );

        await t.test(
          'approver revocation and unrelated P4a policy bump win real lock races',
          async () => {
            let current = await pointer(pool, tenantA, environmentA);
            let target = releaseOtherThan(releasesA, current.releaseId, 2);
            const revokedAttempt = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              target,
            );
            const revocation = await pool.connect();
            try {
              await revocation.query('BEGIN');
              await setApproverEligibility(
                revocation,
                tenantA,
                approverA,
                false,
              );
              const activation = webService.activate(
                systemContextA,
                revokedAttempt,
              );
              await revocation.query('COMMIT');
              const result = await activation;
              assert.equal(result.decisiveOutcomeCode, 'APPROVER_REVOCATION');
            } finally {
              revocation.release();
            }
            await changeApproverEligibility(pool, tenantA, approverA, true);

            current = await pointer(pool, tenantA, environmentA);
            target = releaseOtherThan(releasesA, current.releaseId, 3);
            const obsoleteAttempt = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              target,
            );
            const bump = await pool.connect();
            try {
              await bump.query('BEGIN');
              await setApproverEligibility(bump, tenantA, randomUUID(), true);
              const activation = workerService.activate(
                systemContextA,
                obsoleteAttempt,
              );
              await bump.query('COMMIT');
              const result = await activation;
              assert.equal(result.decisiveOutcomeCode, 'OBSOLETE_POLICY');
            } finally {
              bump.release();
            }
          },
        );

        await t.test(
          'commit-response loss reconciles by receipt and verification supersession',
          async () => {
            const before = await pointer(pool, tenantA, environmentA);
            const target = releaseOtherThan(releasesA, before.releaseId, 4);
            const ambiguousAttempt = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              target,
            );

            await withCommitDroppingProxy(connection, async (proxyPort) => {
              const ambiguousPool = runtimePool(
                { ...connection, host: '127.0.0.1', port: proxyPort },
                1,
              );
              ambiguousPool.on('error', () => undefined);
              ambiguousPool.on('connect', (client) => {
                client.on('error', () => undefined);
              });
              try {
                const ambiguousService = new PostgresReleaseActivationService(
                  ambiguousPool,
                );
                const result = await ambiguousService.activate(
                  systemContextA,
                  ambiguousAttempt,
                );
                assert.equal(result.status, 'RECONCILING');
              } finally {
                await ambiguousPool.end();
              }
            });

            await waitForReceipt(pool, ambiguousAttempt.activationAttemptId);
            const afterCommit = await pointer(pool, tenantA, environmentA);
            assert.equal(afterCommit.fence, before.fence + 1);
            assert.equal(afterCommit.releaseId, target.releaseId);

            const supersedingTarget = releaseOtherThan(
              releasesA,
              afterCommit.releaseId,
              5,
            );
            const superseding = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              supersedingTarget,
            );
            assert.equal(
              (await webService.activate(systemContextA, superseding)).status,
              'SWAPPED_VERIFIED',
            );
            const reconciled = await workerService.reconcileActivation(
              systemContextA,
              ambiguousAttempt,
            );
            assert.equal(reconciled.status, 'SUPERSEDED');
            assert.equal(reconciled.decisiveOutcomeCode, 'SWAPPED');
          },
        );

        await t.test(
          'actual child process and parent pool concurrently resume one attempt',
          async () => {
            const before = await pointer(pool, tenantA, environmentA);
            const target = releaseOtherThan(releasesA, before.releaseId, 6);
            const attempt = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              target,
            );
            const child = activateInChildProcess(
              connection,
              systemContextA,
              attempt,
            );
            const parent = workerService.activate(systemContextA, attempt);
            const [childResult, parentResult] = await Promise.all([
              child,
              parent,
            ]);
            assert.equal(childResult.decisiveOutcomeCode, 'SWAPPED');
            assert.equal(parentResult.decisiveOutcomeCode, 'SWAPPED');
            await assertOneAtomicGeneration(pool, before, [
              attempt.activationAttemptId,
            ]);
          },
        );

        await t.test(
          'reconciliation age survives a backward clock step, outage, and fresh coordinator',
          async () => {
            const current = await pointer(pool, tenantA, environmentA);
            const target = releaseOtherThan(releasesA, current.releaseId, 0);
            const attempt = await prepareApproval(
              webPool,
              approverContextA,
              makerContextA,
              target,
            );
            const beforeInstruction = await pool.query<{ count: string }>(
              `SELECT count(*)
                 FROM platform.release_activation_reconciliation_starts
                WHERE activation_attempt_id = $1`,
              [attempt.activationAttemptId],
            );
            assert.equal(beforeInstruction.rows[0]?.count, '0');
            const wallClock = await pool.query<{ observed_at: Date }>(
              'SELECT clock_timestamp() AS observed_at',
            );
            const startedAt = wallClock.rows[0]?.observed_at;
            assert.ok(startedAt);
            let clockSample = {
              monotonicMilliseconds: 10_000,
              origin: 'g1-p4b-test-boot',
              wallTime: startedAt,
            };
            const reconciliationClock = {
              sample: () => clockSample,
            };
            await changeExecutorAuthority(pool, tenantA, false);
            try {
              const firstPool = runtimePool(connection, 1);
              try {
                const firstCoordinator = new PostgresReleaseActivationService(
                  firstPool,
                  {
                    reconciliationClock,
                    reconciliationMaxAgeMilliseconds: 100,
                  },
                );
                const started = await firstCoordinator.activate(
                  systemContextA,
                  attempt,
                );
                assert.equal(started.status, 'EXECUTOR_UNAVAILABLE');
                assert.equal(started.alarmDue, false);
              } finally {
                await firstPool.end();
              }

              const start = await pool.query<{
                count: string;
                max_age_milliseconds: string;
              }>(
                `SELECT count(*) AS count,
                        max(max_age_milliseconds)::text AS max_age_milliseconds
                   FROM platform.release_activation_reconciliation_starts
                  WHERE activation_attempt_id = $1`,
                [attempt.activationAttemptId],
              );
              assert.deepEqual(start.rows[0], {
                count: '1',
                max_age_milliseconds: '100',
              });

              clockSample = {
                monotonicMilliseconds: 10_099,
                origin: 'g1-p4b-test-boot',
                wallTime: new Date(startedAt.getTime() - 2_000),
              };
              const steppedPool = runtimePool(connection, 1);
              try {
                const steppedCoordinator = new PostgresReleaseActivationService(
                  steppedPool,
                  {
                    reconciliationClock,
                  },
                );
                const beforeDeadline =
                  await steppedCoordinator.reconcileActivation(
                    systemContextA,
                    attempt,
                  );
                assert.equal(beforeDeadline.status, 'RECONCILING');
                assert.equal(beforeDeadline.alarmDue, false);
                const pending =
                  await steppedCoordinator.inspectReconciliationState(
                    systemContextA,
                    attempt,
                  );
                assert.equal(pending.state, 'PENDING');
                assert.equal(pending.overdue, false);
                assert.equal(
                  pending.observedAt,
                  new Date(startedAt.getTime() + 99).toISOString(),
                );
              } finally {
                await steppedPool.end();
              }

              await execFileAsync('docker', ['pause', containerName]);
              try {
                clockSample = {
                  monotonicMilliseconds: 10_101,
                  origin: 'g1-p4b-test-boot',
                  wallTime: new Date(startedAt.getTime() - 2_000),
                };
                const outagePool = new pg.Pool({
                  ...connection,
                  connectionTimeoutMillis: 100,
                  max: 1,
                  user: 'north_star_runtime',
                });
                outagePool.on('error', () => undefined);
                try {
                  const outageCoordinator =
                    new PostgresReleaseActivationService(outagePool, {
                      reconciliationClock,
                    });
                  const unavailable =
                    await outageCoordinator.reconcileActivation(
                      systemContextA,
                      attempt,
                    );
                  assert.equal(unavailable.status, 'RECONCILING');
                  assert.equal(unavailable.alarmDue, false);
                } finally {
                  await outagePool.end();
                }
              } finally {
                await execFileAsync('docker', ['unpause', containerName]);
              }
              await pool.query('SELECT 1');

              const recoveredPool = runtimePool(connection, 1);
              try {
                const recoveredCoordinator =
                  new PostgresReleaseActivationService(recoveredPool, {
                    reconciliationClock,
                  });
                const recovered =
                  await recoveredCoordinator.reconcileActivation(
                    systemContextA,
                    attempt,
                  );
                assert.equal(recovered.status, 'RECONCILING');
                assert.equal(recovered.alarmDue, true);
                const alarm = await pool.query<{
                  count: string;
                  max_age_milliseconds: string;
                }>(
                  `SELECT count(*) AS count,
                          max(max_age_milliseconds)::text AS max_age_milliseconds
                     FROM platform.release_activation_reconciliation_alarms
                    WHERE activation_attempt_id = $1`,
                  [attempt.activationAttemptId],
                );
                assert.deepEqual(alarm.rows[0], {
                  count: '1',
                  max_age_milliseconds: '100',
                });
                const anchor = await pool.query<{
                  count: string;
                  phase_code: string;
                }>(
                  `SELECT count(*) AS count,
                          min(phase_code) AS phase_code
                     FROM platform.release_activation_phase_receipts
                    WHERE activation_attempt_id = $1
                      AND phase_code LIKE
                        'RECONCILIATION_MONOTONIC_ANCHOR_V1:%'`,
                  [attempt.activationAttemptId],
                );
                assert.equal(anchor.rows[0]?.count, '1');
                assert.equal(
                  anchor.rows[0]?.phase_code,
                  'RECONCILIATION_MONOTONIC_ANCHOR_V1:g1-p4b-test-boot:10000',
                );

                await changeExecutorAuthority(pool, tenantA, true);
                const finished = await recoveredCoordinator.activate(
                  systemContextA,
                  attempt,
                );
                assert.equal(finished.status, 'SWAPPED_VERIFIED');
                assert.equal(finished.alarmDue, true);
                const stillOneAlarm = await pool.query<{ count: string }>(
                  `SELECT count(*)
                     FROM platform.release_activation_reconciliation_alarms
                    WHERE activation_attempt_id = $1`,
                  [attempt.activationAttemptId],
                );
                assert.equal(stillOneAlarm.rows[0]?.count, '1');
              } finally {
                await recoveredPool.end();
              }
              await assert.rejects(
                pool.query(
                  `UPDATE platform.release_activation_reconciliation_starts
                      SET max_age_milliseconds = max_age_milliseconds + 1
                    WHERE activation_attempt_id = $1`,
                  [attempt.activationAttemptId],
                ),
                /release_activation_write_guard_reject|violates check constraint/,
              );

              const crossingBase = await pointer(pool, tenantA, environmentA);
              const crossingAttempt = await prepareApproval(
                webPool,
                approverContextA,
                makerContextA,
                releaseOtherThan(releasesA, crossingBase.releaseId, 1),
              );
              const competingAttempt = await prepareApproval(
                webPool,
                approverContextA,
                makerContextA,
                releaseOtherThan(releasesA, crossingBase.releaseId, 2),
              );
              const crossingWall = await pool.query<{ observed_at: Date }>(
                'SELECT clock_timestamp() AS observed_at',
              );
              const crossingStartedAt = crossingWall.rows[0]?.observed_at;
              assert.ok(crossingStartedAt);
              let crossingClockSample = {
                monotonicMilliseconds: 20_000,
                origin: 'g1-p4b-crossing-boot',
                wallTime: crossingStartedAt,
              };
              const crossingClock = {
                sample: () => crossingClockSample,
              };
              await changeExecutorAuthority(pool, tenantA, false);
              const crossingStartPool = runtimePool(connection, 1);
              try {
                const crossingStartCoordinator =
                  new PostgresReleaseActivationService(crossingStartPool, {
                    reconciliationClock: crossingClock,
                    reconciliationMaxAgeMilliseconds: 100,
                  });
                const crossingStart = await crossingStartCoordinator.activate(
                  systemContextA,
                  crossingAttempt,
                );
                assert.equal(crossingStart.status, 'EXECUTOR_UNAVAILABLE');
                assert.equal(crossingStart.alarmDue, false);
              } finally {
                await crossingStartPool.end();
              }
              await changeExecutorAuthority(pool, tenantA, true);
              assert.equal(
                (await workerService.activate(systemContextA, competingAttempt))
                  .status,
                'SWAPPED_VERIFIED',
              );

              const crossingSamples = [
                {
                  monotonicMilliseconds: 20_099,
                  origin: 'g1-p4b-crossing-boot',
                  wallTime: new Date(crossingStartedAt.getTime() - 2_000),
                },
                {
                  monotonicMilliseconds: 20_101,
                  origin: 'g1-p4b-crossing-boot',
                  wallTime: new Date(crossingStartedAt.getTime() - 2_000),
                },
              ] as const;
              let crossingSampleIndex = 0;
              const crossingCompletionClock = {
                sample: () =>
                  crossingSamples[
                    Math.min(crossingSampleIndex++, crossingSamples.length - 1)
                  ]!,
              };
              await withCommitDroppingProxy(
                connection,
                async (proxyPort) => {
                  const faultPool = runtimePool(
                    { ...connection, host: '127.0.0.1', port: proxyPort },
                    1,
                  );
                  faultPool.on('error', () => undefined);
                  faultPool.on('connect', (client) => {
                    client.on('error', () => undefined);
                  });
                  try {
                    const faultingCoordinator =
                      new PostgresReleaseActivationService(faultPool, {
                        reconciliationClock: crossingCompletionClock,
                      });
                    const ambiguous =
                      await faultingCoordinator.reconcileActivation(
                        systemContextA,
                        crossingAttempt,
                      );
                    assert.equal(ambiguous.status, 'RECONCILING');
                    assert.equal(ambiguous.alarmDue, false);
                  } finally {
                    await faultPool.end();
                  }
                },
                { dropCommitResponseNumber: 2 },
              );
              assert.equal(crossingSampleIndex, 2);

              const crossingFacts = await pool.query<{
                alarms: string;
                completion_anchors: string;
                outcomes: string;
              }>(
                `SELECT (
                          SELECT count(*)
                            FROM platform.release_activation_attempt_outcomes
                           WHERE activation_attempt_id = $1
                             AND terminal
                        )::text AS outcomes,
                        (
                          SELECT count(*)
                            FROM platform.release_activation_reconciliation_alarms
                           WHERE activation_attempt_id = $1
                        )::text AS alarms,
                        (
                          SELECT count(*)
                            FROM platform.release_activation_phase_receipts
                           WHERE activation_attempt_id = $1
                             AND phase_code LIKE
                               'RECONCILIATION_MONOTONIC_COMPLETION_V1:%'
                        )::text AS completion_anchors`,
                [crossingAttempt.activationAttemptId],
              );
              assert.deepEqual(crossingFacts.rows[0], {
                alarms: '0',
                completion_anchors: '1',
                outcomes: '1',
              });

              crossingClockSample = crossingSamples[1];
              const crossingObserverPool = runtimePool(connection, 1);
              try {
                const crossingObserver = new PostgresReleaseActivationService(
                  crossingObserverPool,
                  {
                    reconciliationClock: crossingClock,
                  },
                );
                const overdueCompletion =
                  await crossingObserver.inspectReconciliationState(
                    systemContextA,
                    crossingAttempt,
                  );
                assert.equal(overdueCompletion.state, 'OVERDUE_COMPLETED');
                assert.equal(overdueCompletion.overdue, true);
                assert.equal(overdueCompletion.alarmRecorded, false);
                assert.ok(overdueCompletion.completionAt);
                assert.ok(overdueCompletion.deadlineAt);
                assert.ok(
                  overdueCompletion.completionAt < overdueCompletion.deadlineAt,
                );

                const alarmed = await crossingObserver.reconcileActivation(
                  systemContextA,
                  crossingAttempt,
                );
                assert.equal(alarmed.decisiveOutcomeCode, 'LOST_RACE');
                assert.equal(alarmed.alarmDue, true);
              } finally {
                await crossingObserverPool.end();
              }
            } finally {
              await ensureExecutorAuthority(pool, tenantA, true);
            }

            await assert.rejects(
              webService.activate(
                {
                  ...systemContextA,
                  environmentId: environmentA2,
                },
                attempt,
              ),
              (error: unknown) =>
                error instanceof TypeError ||
                (error instanceof ReleaseActivationError &&
                  error.code === 'CANONICAL_RECORD_NOT_FOUND'),
            );
            await assert.rejects(
              webService.activate(systemContextA2, attempt),
              (error: unknown) =>
                error instanceof ReleaseActivationError &&
                error.code === 'CANONICAL_RECORD_NOT_FOUND',
            );
          },
        );

        await t.test(
          'outbox envelope and duplicate/reordered consumer delivery are frozen',
          async () => {
            const rows = await pool.query<{
              activation_attempt_id: MintedUuid;
              outbox_id: MintedUuid;
              tenant_id: string;
              environment_id: string;
            }>(
              `SELECT tenant_id,
                      environment_id,
                      activation_attempt_id,
                      outbox_id
                 FROM platform.release_activation_outbox
                WHERE event_code = $1
                ORDER BY fence DESC
                LIMIT 2`,
              [ACTIVATION_INVALIDATION_EVENT_CODE],
            );
            assert.equal(rows.rows.length, 2);
            const entry = await trustedContext(
              rows.rows[0]!.tenant_id,
              rows.rows[0]!.environment_id,
              SYSTEM_EXECUTION_PRINCIPAL.principalId,
            );
            const newest = await webService.readInvalidationEvent(
              entry,
              rows.rows[0]!.outbox_id,
            );
            assert.ok(newest);
            assert.equal(
              newest.schemaVersion,
              ACTIVATION_INVALIDATION_EVENT_VERSION,
            );
            assert.equal(newest.eventCode, ACTIVATION_INVALIDATION_EVENT_CODE);
            const state = new ReleaseInvalidationFenceState();
            assert.equal(
              state.consume(newest).decision,
              newest.fence === 1
                ? 'ACCEPTED_CONTIGUOUS'
                : 'ACCEPTED_GAP_REREAD_REQUIRED',
            );
            assert.equal(
              state.consume(newest).decision,
              'REJECTED_STALE_OR_DUPLICATE',
            );
            const olderContext = await trustedContext(
              rows.rows[1]!.tenant_id,
              rows.rows[1]!.environment_id,
              SYSTEM_EXECUTION_PRINCIPAL.principalId,
            );
            const older = await webService.readInvalidationEvent(
              olderContext,
              rows.rows[1]!.outbox_id,
            );
            assert.ok(older);
            if (older.pointerId === newest.pointerId) {
              assert.equal(
                state.consume(older).decision,
                'REJECTED_STALE_OR_DUPLICATE',
              );
            }
          },
        );
      } finally {
        await Promise.all([webPool.end(), workerPool.end()]);
      }
    },
  );
});

async function seedScopes(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO platform.tenants (id, slug)
     VALUES ($1, 'activation-a'), ($2, 'activation-b')`,
    [tenantA, tenantB],
  );
  await client.query(
    `INSERT INTO platform.environments (tenant_id, id, slug)
     VALUES ($1, $2, 'production'),
            ($1, $3, 'preview'),
            ($4, $5, 'production')`,
    [tenantA, environmentA, environmentA2, tenantB, environmentB],
  );
}

async function seedReleases(
  pool: pg.Pool,
  context: TrustedRequestContext,
  bootstrapBytes: Uint8Array,
  verticalBytes: Uint8Array,
  bootstrap: CompileSuccess,
  vertical: CompileSuccess,
  count: number,
): Promise<ReleaseFixture[]> {
  const repository = new PostgresImmutableReleaseRepository(pool);
  const bootstrapRevision = minted(randomUUID());
  const verticalRevision = minted(randomUUID());
  await repository.storeAppPackageRevision(
    context,
    revisionCommand(context, bootstrapRevision, bootstrapBytes),
  );
  await repository.storeAppPackageRevision(
    context,
    revisionCommand(context, verticalRevision, verticalBytes),
  );
  return seedEnvironmentReleases(
    pool,
    context,
    bootstrapRevision,
    verticalRevision,
    bootstrap,
    vertical,
    count,
  );
}

async function seedEnvironmentReleases(
  pool: pg.Pool,
  context: TrustedRequestContext,
  bootstrapRevision: MintedUuid,
  verticalRevision: MintedUuid,
  bootstrap: CompileSuccess,
  vertical: CompileSuccess,
  count: number,
): Promise<ReleaseFixture[]> {
  const repository = new PostgresImmutableReleaseRepository(pool);
  const releases: ReleaseFixture[] = [];
  for (let index = 0; index < count; index += 1) {
    const compiled = index % 2 === 0 ? bootstrap : vertical;
    const revisionId = index % 2 === 0 ? bootstrapRevision : verticalRevision;
    const releaseId = minted(randomUUID());
    const evidenceId = verificationEvidenceIdForCandidate(
      context,
      releaseId,
      compiled.releaseRoot,
    );
    await admitEmptyPlanRelease(
      pool,
      repository,
      context,
      releaseCommand(context, releaseId, revisionId, evidenceId, compiled),
    );
    releases.push({ compiled, evidenceId, releaseId, revisionId });
  }
  return releases;
}

async function prepareApproval(
  pool: pg.Pool,
  approverContext: TrustedRequestContext,
  preparationContext: TrustedRequestContext,
  target: ReleaseFixture,
  options: Readonly<{
    approvalNow?: Date;
    expiresAt?: string;
    readiness?: 'NO_STORAGE_TRANSITION' | 'UNSUPPORTED_TRANSITION';
  }> = {},
): Promise<AttemptFixture> {
  const current = await visiblePointer(pool, preparationContext);
  const preparationId = minted(randomUUID());
  const receiptId = minted(randomUUID());
  const targetRoot = Buffer.from(target.compiled.releaseRoot, 'hex');
  const sourceRoot =
    current.releaseId === null
      ? null
      : await releaseRoot(pool, preparationContext, current.releaseId);
  const noStorage = options.readiness !== 'UNSUPPORTED_TRANSITION';

  await withTrustedRequestTransaction(
    pool,
    preparationContext,
    async (client) => {
      await client.query(
        `INSERT INTO platform.transition_preparation_receipts (
         tenant_id,
         environment_id,
         receipt_id,
         receipt_version,
         source_release_id,
         source_manifest_root,
         target_release_id,
         target_manifest_root,
         transition_scope,
         storage_domain_id,
         schema_generation,
         compiler_facts_version,
         compiler_facts_digest,
         compiler_transition_class,
         compiler_static_compatibility,
         compiler_exact_pair,
         executor_evidence_version,
         executor_evidence_digest,
         executor_applied_state,
         executor_exact_pair,
         compatibility_policy_version,
         compatibility_policy_verdict,
         recovery_mode
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         'tenantLocal', 'tenant-primary-storage', $9,
         $10, $11, $15, 'SATISFIED', true,
         $12, $13, $16, true,
         $14, 'ALLOW', $17
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
          noStorage ? 'NO_STORAGE_TRANSITION' : 'REVERSIBLE',
          noStorage ? 'NOT_REQUIRED' : 'APPLIED',
          noStorage ? 'NO_STORAGE_RECOVERY_REQUIRED' : 'REVERSIBLE',
        ],
      );

      const initial = current.releaseId === null;
      await client.query(
        `INSERT INTO platform.release_activation_preparations (
         tenant_id,
         environment_id,
         preparation_id,
         preparation_version,
         expected_pointer_id,
         expected_release_id,
         expected_fence,
         source_manifest_root,
         target_release_id,
         target_manifest_root,
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
         capability_support_result,
         renderer_version,
         view_schema_version,
         rendered_diff_evidence_digest,
         transition_preparation_receipt_id
       ) VALUES (
         $1, $2, $3,
         'northstar.release-activation-preparation/v1',
         $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, NULL,
         $15, $16, $17, $18, $19,
         'northstar.verification-evidence/v1', $20,
         'northstar.capability-support/v1', $21, 'SUPPORTED',
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
          Buffer.from(target.compiled.attestation.attestationDigest, 'hex'),
          target.compiled.bundle.releaseManifest.compilerVersion,
          target.compiled.bundle.releaseManifest.compilerSemanticProfileVersion,
          target.compiled.bundle.releaseManifest.outputProtocolVersion,
          target.evidenceId,
          digest('verification-evidence', target.evidenceId),
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
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    initiatingHumanId: approverContext.principalId,
    issuingActorId: approverContext.principalId,
    preparationId,
    targetReleaseId: target.releaseId,
  };
  const approvalService = new PostgresReleaseApprovalService(
    pool,
    options.approvalNow ? { now: () => options.approvalNow! } : {},
  );
  const created = await approvalService.createApproval(
    approverContext,
    command,
  );
  return {
    activationAttemptId: created.attempt.activationAttemptId,
    approvalId: created.approval.approvalId,
    expectedFence: created.approval.expectedFence,
    pointerId: created.approval.expectedPointerId,
    targetReleaseId: created.approval.targetReleaseId,
  };
}

async function changeApproverEligibility(
  pool: pg.Pool,
  tenantId: string,
  principalId: string,
  eligible: boolean,
): Promise<void> {
  await setApproverEligibility(pool, tenantId, principalId, eligible);
}

async function ensureApproverEligibility(
  pool: pg.Pool,
  tenantId: string,
  principalId: string,
  eligible: boolean,
): Promise<void> {
  const current = await pool.query<{ eligible: boolean }>(
    `SELECT eligible
       FROM platform.release_approver_eligibility_events
      WHERE tenant_id = $1 AND principal_id = $2
      ORDER BY policy_version DESC
      LIMIT 1`,
    [tenantId, principalId],
  );
  if (current.rows[0]?.eligible !== eligible) {
    await changeApproverEligibility(pool, tenantId, principalId, eligible);
  }
}

async function setApproverEligibility(
  queryable: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>,
  tenantId: string,
  principalId: string,
  eligible: boolean,
): Promise<void> {
  await queryable.query(
    `SELECT platform.set_release_approver_eligibility($1, $2, $3, $4, $5)`,
    [tenantId, principalId, eligible, authorityOperator, randomUUID()],
  );
}

async function changeExecutorAuthority(
  pool: pg.Pool,
  tenantId: string,
  authorized: boolean,
): Promise<void> {
  await pool.query(
    `SELECT platform.set_release_executor_authority($1, $2, $3, $4, $5)`,
    [
      tenantId,
      SYSTEM_EXECUTION_PRINCIPAL.principalId,
      authorized,
      authorityOperator,
      randomUUID(),
    ],
  );
}

async function ensureExecutorAuthority(
  pool: pg.Pool,
  tenantId: string,
  authorized: boolean,
): Promise<void> {
  const current = await pool.query<{ authorized: boolean }>(
    `SELECT authorized
       FROM platform.release_executor_authority_events
      WHERE tenant_id = $1 AND principal_id = $2
      ORDER BY policy_version DESC
      LIMIT 1`,
    [tenantId, SYSTEM_EXECUTION_PRINCIPAL.principalId],
  );
  if (current.rows[0]?.authorized !== authorized) {
    await changeExecutorAuthority(pool, tenantId, authorized);
  }
}

async function changeControl(
  pool: pg.Pool,
  tenantId: string,
  environmentId: string,
  livePolicyDenied: boolean,
  rolloutPaused: boolean,
): Promise<void> {
  await pool.query(
    `SELECT platform.set_release_activation_control(
       $1, $2, NULL, $3, $4, $5, $6
     )`,
    [
      tenantId,
      environmentId,
      livePolicyDenied,
      rolloutPaused,
      authorityOperator,
      randomUUID(),
    ],
  );
}

async function ensureControlState(
  pool: pg.Pool,
  tenantId: string,
  environmentId: string,
  livePolicyDenied: boolean,
  rolloutPaused: boolean,
): Promise<void> {
  const current = await pool.query<{
    live_policy_denied: boolean;
    rollout_paused: boolean;
  }>(
    `SELECT live_policy_denied, rollout_paused
       FROM platform.release_activation_control_events
      WHERE tenant_id = $1
        AND environment_id = $2
        AND rollout_id IS NULL
      ORDER BY policy_version DESC
      LIMIT 1`,
    [tenantId, environmentId],
  );
  const row = current.rows[0];
  if (
    row?.live_policy_denied !== livePolicyDenied ||
    row?.rollout_paused !== rolloutPaused
  ) {
    await changeControl(
      pool,
      tenantId,
      environmentId,
      livePolicyDenied,
      rolloutPaused,
    );
  }
}

async function visiblePointer(
  pool: pg.Pool,
  context: TrustedRequestContext,
): Promise<PointerFixture> {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    const result = await client.query<{
      fence: string;
      pointer_id: MintedUuid;
      release_id: MintedUuid | null;
    }>(
      `SELECT pointer_id, release_id, fence
         FROM platform.active_release_pointers
        WHERE tenant_id = $1 AND environment_id = $2`,
      [context.tenantId, context.environmentId],
    );
    const row = result.rows[0];
    assert.ok(row);
    return {
      fence: Number(row.fence),
      pointerId: row.pointer_id,
      releaseId: row.release_id,
    };
  });
}

async function pointer(
  pool: pg.Pool,
  tenantId: string,
  environmentId: string,
): Promise<PointerFixture> {
  const result = await pool.query<{
    fence: string;
    pointer_id: MintedUuid;
    release_id: MintedUuid | null;
  }>(
    `SELECT pointer_id, release_id, fence
       FROM platform.active_release_pointers
      WHERE tenant_id = $1 AND environment_id = $2`,
    [tenantId, environmentId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return {
    fence: Number(row.fence),
    pointerId: row.pointer_id,
    releaseId: row.release_id,
  };
}

async function releaseRoot(
  pool: pg.Pool,
  context: TrustedRequestContext,
  releaseId: MintedUuid,
): Promise<Uint8Array> {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    const result = await client.query<{ content_hash: string }>(
      `SELECT content_hash
         FROM platform.tenant_releases
        WHERE release_id = $1`,
      [releaseId],
    );
    assert.ok(result.rows[0]);
    return Buffer.from(result.rows[0].content_hash, 'hex');
  });
}

async function assertOneAtomicGeneration(
  pool: pg.Pool,
  before: PointerFixture,
  attemptIds: readonly MintedUuid[],
): Promise<void> {
  const after = await pool.query<{
    fence: string;
    pointer_id: MintedUuid;
  }>(
    `SELECT pointer_id, fence
       FROM platform.active_release_pointers
      WHERE pointer_id = $1`,
    [before.pointerId],
  );
  assert.equal(Number(after.rows[0]?.fence), before.fence + 1);
  const counts = await attemptFactCounts(pool, attemptIds);
  assert.deepEqual(counts, {
    histories: 1,
    outboxRows: 1,
    receipts: 1,
    swappedOutcomes: 1,
    outcomes: attemptIds.length,
  });
}

async function attemptFactCounts(
  pool: pg.Pool,
  attemptIds: readonly MintedUuid[],
): Promise<{
  histories: number;
  outboxRows: number;
  outcomes: number;
  receipts: number;
  swappedOutcomes: number;
}> {
  const result = await pool.query<{
    histories: string;
    outbox_rows: string;
    outcomes: string;
    receipts: string;
    swapped_outcomes: string;
  }>(
    `SELECT (
              SELECT count(*)
                FROM platform.release_activation_swap_receipts
               WHERE activation_attempt_id = ANY($1::uuid[])
            ) AS receipts,
            (
              SELECT count(*)
                FROM platform.release_activation_history
               WHERE activation_attempt_id = ANY($1::uuid[])
                 AND pointer_outcome = 'SWAPPED'
            ) AS histories,
            (
              SELECT count(*)
                FROM platform.release_activation_outbox
               WHERE activation_attempt_id = ANY($1::uuid[])
            ) AS outbox_rows,
            (
              SELECT count(*)
                FROM platform.release_activation_attempt_outcomes
               WHERE activation_attempt_id = ANY($1::uuid[])
            ) AS outcomes,
            (
              SELECT count(*)
                FROM platform.release_activation_attempt_outcomes
               WHERE activation_attempt_id = ANY($1::uuid[])
                 AND outcome_code = 'SWAPPED'
            ) AS swapped_outcomes`,
    [attemptIds],
  );
  const row = result.rows[0]!;
  return {
    histories: Number(row.histories),
    outboxRows: Number(row.outbox_rows),
    outcomes: Number(row.outcomes),
    receipts: Number(row.receipts),
    swappedOutcomes: Number(row.swapped_outcomes),
  };
}

async function waitForReceipt(
  pool: pg.Pool,
  activationAttemptId: MintedUuid,
): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    const result = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM platform.release_activation_swap_receipts
          WHERE activation_attempt_id = $1
       ) AS present`,
      [activationAttemptId],
    );
    if (result.rows[0]?.present) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.fail('swap receipt did not become visible after commit-response loss');
}

async function waitForBlockedRecoveryTransaction(
  pool: pg.Pool,
  applicationName: string,
  blockerPid: number,
  deadlineAt: string,
): Promise<{
  beganBeforeDeadline: boolean;
  blockedBeforeDeadline: boolean;
  observedAt: string;
  transactionStartedAt: string;
}> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 5_000) {
    const result = await pool.query<{
      began_before_deadline: boolean;
      blocked_before_deadline: boolean;
      observed_at: Date;
      transaction_started_at: Date;
    }>(
      `SELECT activity.xact_start AS transaction_started_at,
              clock_timestamp() AS observed_at,
              activity.xact_start < $3::timestamptz AS began_before_deadline,
              clock_timestamp() < $3::timestamptz AS blocked_before_deadline
         FROM pg_catalog.pg_stat_activity AS activity
        WHERE activity.application_name = $1
          AND activity.wait_event_type = 'Lock'
          AND $2::integer = ANY(pg_catalog.pg_blocking_pids(activity.pid))
        ORDER BY activity.xact_start
        LIMIT 1`,
      [applicationName, blockerPid, deadlineAt],
    );
    const row = result.rows[0];
    if (row) {
      return {
        beganBeforeDeadline: row.began_before_deadline,
        blockedBeforeDeadline: row.blocked_before_deadline,
        observedAt: row.observed_at.toISOString(),
        transactionStartedAt: row.transaction_started_at.toISOString(),
      };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.fail('recovery transaction did not block on the pointer row');
}

async function waitForPostgresDeadline(
  client: pg.PoolClient,
  deadlineAt: string,
): Promise<string> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 10_000) {
    const result = await client.query<{
      crossed: boolean;
      observed_at: Date;
    }>(
      `SELECT clock_timestamp() AS observed_at,
              clock_timestamp() >= $1::timestamptz AS crossed`,
      [deadlineAt],
    );
    const observed = result.rows[0];
    if (observed?.crossed) return observed.observed_at.toISOString();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.fail('PostgreSQL clock did not cross the reconciliation deadline');
}

async function withCommitDroppingProxy<T>(
  connection: pg.PoolConfig,
  run: (port: number) => Promise<T>,
  options: Readonly<{
    delayCommitResponse?: Readonly<{
      commitNumber: number;
      milliseconds: number;
    }>;
    dropCommitResponseNumber?: number;
  }> = {},
): Promise<T> {
  const targetHost = String(connection.host ?? '127.0.0.1');
  const targetPort = Number(connection.port);
  let armed = true;
  let commitCount = 0;
  const server = createServer((downstream) => {
    const upstream = connect(targetPort, targetHost);
    const delayedChunks: Buffer[] = [];
    let delayCommitResponse = false;
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    let dropCommitResponse = false;
    downstream.on('data', (chunk: Buffer) => {
      const hasCommit = chunk.includes(Buffer.from('COMMIT'));
      if (armed && hasCommit) commitCount += 1;
      if (
        armed &&
        hasCommit &&
        commitCount === options.delayCommitResponse?.commitNumber
      ) {
        delayCommitResponse = true;
      }
      const isCommitToDrop =
        armed &&
        hasCommit &&
        commitCount === (options.dropCommitResponseNumber ?? 2);
      if (isCommitToDrop) {
        armed = false;
        dropCommitResponse = true;
      }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (dropCommitResponse) {
        downstream.end();
        upstream.end();
      } else if (delayCommitResponse) {
        delayedChunks.push(chunk);
        delayTimer ??= setTimeout(() => {
          delayCommitResponse = false;
          if (!downstream.destroyed) {
            for (const delayed of delayedChunks) downstream.write(delayed);
          }
          delayedChunks.length = 0;
        }, options.delayCommitResponse?.milliseconds ?? 0);
      } else if (!downstream.destroyed) {
        downstream.write(chunk);
      }
    });
    downstream.on('close', () => {
      if (delayTimer !== undefined) clearTimeout(delayTimer);
      if (!dropCommitResponse) upstream.destroy();
    });
    downstream.on('error', () => undefined);
    upstream.on('error', () => downstream.destroy());
  });
  const port = await listen(server);
  try {
    return await run(port);
  } finally {
    await closeServer(server);
  }
}

async function activateInChildProcess(
  connection: pg.PoolConfig,
  context: TrustedRequestContext,
  attempt: AttemptFixture,
): Promise<ActivationKernelResult> {
  const script = `
    import pg from 'pg';
    import { PostgresReleaseActivationService } from './packages/postgres-provider/src/release-activation-service.js';
    import { AuthenticatedRequestEntryAdapter } from './packages/runtime/src/request-context.js';
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const entry = new AuthenticatedRequestEntryAdapter(async () => ({
      tenantId: process.env.TEST_TENANT_ID,
      environmentId: process.env.TEST_ENVIRONMENT_ID,
      principalId: process.env.TEST_PRINCIPAL_ID,
    }));
    try {
      const context = await entry.enter({ headers: { authorization: 'worker' } });
      const service = new PostgresReleaseActivationService(pool);
      const result = await service.activate(context, {
        activationAttemptId: process.env.TEST_ATTEMPT_ID,
      });
      process.stdout.write(JSON.stringify(result));
    } finally {
      await pool.end();
    }
  `;
  const databaseUrl = `postgresql://north_star_runtime@127.0.0.1:${String(connection.port)}/postgres`;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_ATTEMPT_ID: attempt.activationAttemptId,
        TEST_DATABASE_URL: databaseUrl,
        TEST_ENVIRONMENT_ID: context.environmentId,
        TEST_PRINCIPAL_ID: context.principalId,
        TEST_TENANT_ID: context.tenantId,
      },
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    },
  );
  return JSON.parse(stdout) as ActivationKernelResult;
}

function runtimePool(connection: pg.PoolConfig, max: number): pg.Pool {
  return new pg.Pool({ ...connection, max, user: 'north_star_runtime' });
}

async function trustedContext(
  tenantId: string,
  environmentId: string,
  principalId: string,
): Promise<TrustedRequestContext> {
  const entry = new AuthenticatedRequestEntryAdapter(async () => ({
    environmentId,
    principalId,
    tenantId,
  }));
  return entry.enter({ headers: { authorization: 'fixture' } });
}

function revisionCommand(
  context: TrustedRequestContext,
  revisionId: MintedUuid,
  desiredState: Uint8Array,
): StoreAppPackageRevisionCommand {
  const normalized = canonicalizeAndHash(
    JSON.parse(new TextDecoder().decode(desiredState)) as unknown,
  );
  return {
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    contentHash: normalized.contentHash,
    createdBy: context.principalId,
    desiredState,
    hashAlgorithm: CONTENT_HASH_ALGORITHM,
    languageVersion: LANGUAGE_VERSION,
    normalizationProfileVersion: NORMALIZATION_PROFILE_VERSION,
    parentRevisionId: null,
    provenance: 'firstParty',
    revisionId,
    schemaVersion: LANGUAGE_VERSION,
    tenantId: context.tenantId,
  };
}

function releaseCommand(
  context: TrustedRequestContext,
  releaseId: MintedUuid,
  appPackageRevisionId: MintedUuid,
  verificationEvidenceId: MintedUuid,
  compiledRelease: CompileSuccess,
): RegisterTenantReleaseCommand<CompileSuccess> {
  return {
    appPackageRevisionId,
    compiledRelease,
    createdBy: context.principalId,
    environmentId: context.environmentId,
    releaseId,
    tenantId: context.tenantId,
    verificationEvidenceId,
  };
}

function mustCompile(bytes: Uint8Array): CompileSuccess {
  const compiled = compileApplication(compilerInput(bytes));
  if (compiled.status !== 'compiled') {
    throw new Error(JSON.stringify(compiled.diagnostics));
  }
  return compiled;
}

function releaseOtherThan(
  releases: readonly ReleaseFixture[],
  currentReleaseId: MintedUuid | null,
  preferredIndex: number,
): ReleaseFixture {
  const preferred = releases[preferredIndex];
  const selected =
    preferred?.releaseId !== currentReleaseId
      ? preferred
      : releases.find((release) => release.releaseId !== currentReleaseId);
  assert.ok(selected, 'fixture requires a release distinct from the pointer');
  return selected;
}

function digest(...parts: readonly string[]): Uint8Array {
  return createHash('sha256').update(parts.join('\0')).digest();
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectListen(new Error('TCP proxy did not expose a numeric port'));
        return;
      }
      resolveListen(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}
