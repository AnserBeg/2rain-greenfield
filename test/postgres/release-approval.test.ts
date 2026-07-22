import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

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
  APPROVAL_DEFAULT_EXPIRY_MILLISECONDS,
  INITIAL_ACTIVATION_BINDING_VERSION,
  SYSTEM_EXECUTION_PRINCIPAL,
  type CreateReleaseApprovalCommand,
  type MintedUuid,
  type RegisterTenantReleaseCommand,
  type StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import {
  PostgresReleaseApprovalService,
  ReleaseApprovalError,
} from '../../packages/postgres-provider/src/release-approval-service.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import { compilerInput, fixtureBytes } from '../compiler/helpers.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const checkedInMigrations = resolve('db/migrations');
const tenantA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const environmentA = 'a1000000-0000-4000-8000-000000000001';
const environmentANew = 'a2000000-0000-4000-8000-000000000002';
const environmentB = 'b1000000-0000-4000-8000-000000000001';
const makerA = 'aa000000-0000-4000-8000-000000000001';
const approverA = 'ac000000-0000-4000-8000-000000000002';
const revokedApproverA = 'ad000000-0000-4000-8000-000000000003';
const secondApproverA = 'ae000000-0000-4000-8000-000000000004';
const noneligibleA = 'af000000-0000-4000-8000-000000000005';
const principalB = 'bb000000-0000-4000-8000-000000000001';
const authorityOperator = 'a9000000-0000-4000-8000-000000000009';

const revisionOne = minted('a3000000-0000-4000-8000-000000000001');
const revisionTwo = minted('a3000000-0000-4000-8000-000000000002');
const releaseOne = minted('a4000000-0000-4000-8000-000000000001');
const releaseTwo = minted('a4000000-0000-4000-8000-000000000002');
const evidenceOne = minted('a5000000-0000-4000-8000-000000000001');
const evidenceTwo = minted('a5000000-0000-4000-8000-000000000002');
const preparationOne = minted('a6000000-0000-4000-8000-000000000001');
const receiptOne = minted('a7000000-0000-4000-8000-000000000001');
const badPreparation = minted('a6000000-0000-4000-8000-000000000002');
const badReceipt = minted('a7000000-0000-4000-8000-000000000002');

const fixedNow = new Date('2026-07-22T12:00:00.000Z');

const identities = new Map<string, AuthenticatedIdentity>([
  ['maker-a', identity(tenantA, environmentA, makerA)],
  ['approver-a', identity(tenantA, environmentA, approverA)],
  ['revoked-approver-a', identity(tenantA, environmentA, revokedApproverA)],
  ['second-approver-a', identity(tenantA, environmentA, secondApproverA)],
  ['noneligible-a', identity(tenantA, environmentA, noneligibleA)],
  ['new-environment-a', identity(tenantA, environmentANew, approverA)],
  ['tenant-b', identity(tenantB, environmentB, principalB)],
]);

test('G1-P4a PostgreSQL contracts and trusted approval service', async (t) => {
  const bootstrapBytes = fixtureBytes('bootstrap');
  const verticalBytes = fixtureBytes('vertical-v1');
  const bootstrap = mustCompile(bootstrapBytes);
  const vertical = mustCompile(verticalBytes);

  await withEphemeralPostgres(
    'release-approval',
    async ({ connection, pool }) => {
      const migrations = await loadMigrations(checkedInMigrations);
      const admin = await pool.connect();
      try {
        await runMigrations(admin, migrations.slice(0, 3));
        await seedExistingEnvironments(admin);
        await runMigrations(admin, migrations);
      } finally {
        admin.release();
      }

      const runtimePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_runtime',
      });
      try {
        const entry = requestEntry();
        const makerContext = await contextFor(entry, 'maker-a');
        const approverContext = await contextFor(entry, 'approver-a');
        const revokedContext = await contextFor(entry, 'revoked-approver-a');
        const secondApproverContext = await contextFor(
          entry,
          'second-approver-a',
        );
        const noneligibleContext = await contextFor(entry, 'noneligible-a');
        const newEnvironmentContext = await contextFor(
          entry,
          'new-environment-a',
        );
        const tenantBContext = await contextFor(entry, 'tenant-b');

        await t.test(
          'backfills existing environments and covers every future environment',
          async () => {
            const existing = await pool.query<{
              environment_id: string;
              fence: string;
              pointer_id: string;
              release_id: string | null;
              tenant_id: string;
            }>(`
              SELECT tenant_id, environment_id, pointer_id, release_id, fence
                FROM platform.active_release_pointers
               ORDER BY tenant_id, environment_id
            `);
            assert.deepEqual(
              existing.rows.map((row) => ({
                environmentId: row.environment_id,
                fence: row.fence,
                hasPointerId: /^[0-9a-f-]{36}$/i.test(row.pointer_id),
                releaseId: row.release_id,
                tenantId: row.tenant_id,
              })),
              [
                {
                  environmentId: environmentA,
                  fence: '0',
                  hasPointerId: true,
                  releaseId: null,
                  tenantId: tenantA,
                },
                {
                  environmentId: environmentB,
                  fence: '0',
                  hasPointerId: true,
                  releaseId: null,
                  tenantId: tenantB,
                },
              ],
            );

            await pool.query(
              `INSERT INTO platform.environments (tenant_id, id, slug)
               VALUES ($1, $2, 'preview')`,
              [tenantA, environmentANew],
            );
            const future = await pool.query<{
              count: string;
              fence: string;
              release_id: string | null;
            }>(
              `
              SELECT count(*) OVER () AS count, fence, release_id
                FROM platform.active_release_pointers
               WHERE tenant_id = $1 AND environment_id = $2
            `,
              [tenantA, environmentANew],
            );
            assert.deepEqual(future.rows[0], {
              count: '1',
              fence: '0',
              release_id: null,
            });
          },
        );

        const repository = new PostgresImmutableReleaseRepository(runtimePool);
        await repository.storeAppPackageRevision(
          makerContext,
          revisionCommand(makerContext, revisionOne, bootstrapBytes),
        );
        await repository.storeAppPackageRevision(
          makerContext,
          revisionCommand(makerContext, revisionTwo, verticalBytes),
        );
        await repository.registerTenantRelease(
          makerContext,
          releaseCommand(
            makerContext,
            releaseOne,
            revisionOne,
            evidenceOne,
            bootstrap,
          ),
        );
        await repository.registerTenantRelease(
          makerContext,
          releaseCommand(
            makerContext,
            releaseTwo,
            revisionTwo,
            evidenceTwo,
            vertical,
          ),
        );

        await t.test(
          'real grant and revocation events advance one tenant policy version',
          async () => {
            assert.equal(
              await changeEligibility(pool, approverA, true, 1),
              '1',
            );
            assert.equal(
              await changeEligibility(pool, revokedApproverA, true, 2),
              '2',
            );
            assert.equal(
              await changeEligibility(pool, revokedApproverA, false, 3),
              '3',
            );
            assert.equal(await changeEligibility(pool, makerA, true, 4), '4');
            assert.equal(
              await changeEligibility(pool, secondApproverA, true, 5),
              '5',
            );

            await assert.rejects(
              changeEligibility(pool, secondApproverA, true, 6),
              /must change current eligibility/,
            );
            const events = await pool.query<{
              eligible: boolean;
              policy_version: string;
              principal_id: string;
            }>(
              `
              SELECT policy_version, principal_id, eligible
                FROM platform.release_approver_eligibility_events
               WHERE tenant_id = $1
               ORDER BY policy_version
            `,
              [tenantA],
            );
            assert.deepEqual(
              events.rows.map((row) => ({
                eligible: row.eligible,
                policyVersion: row.policy_version,
                principalId: row.principal_id,
              })),
              [
                { eligible: true, policyVersion: '1', principalId: approverA },
                {
                  eligible: true,
                  policyVersion: '2',
                  principalId: revokedApproverA,
                },
                {
                  eligible: false,
                  policyVersion: '3',
                  principalId: revokedApproverA,
                },
                { eligible: true, policyVersion: '4', principalId: makerA },
                {
                  eligible: true,
                  policyVersion: '5',
                  principalId: secondApproverA,
                },
              ],
            );
          },
        );

        const pointer = await visiblePointer(runtimePool, makerContext);
        await insertInitialPreparation(runtimePool, makerContext, {
          compiled: bootstrap,
          evidenceId: evidenceOne,
          pointer,
          preparationId: preparationOne,
          receiptId: receiptOne,
          releaseId: releaseOne,
          targetRootOverride: null,
        });
        await insertInitialPreparation(runtimePool, makerContext, {
          compiled: bootstrap,
          evidenceId: evidenceOne,
          pointer,
          preparationId: badPreparation,
          receiptId: badReceipt,
          releaseId: releaseOne,
          targetRootOverride: digest('not-the-release-root'),
        });

        const service = new PostgresReleaseApprovalService(runtimePool, {
          now: () => fixedNow,
        });
        let firstAttemptId: MintedUuid | undefined;

        await t.test(
          'createApproval recomputes a null-base binding and mandatory expiry',
          async () => {
            const command = approvalCommand(
              approverContext,
              preparationOne,
              releaseOne,
              1,
            );
            const created = await service.createApproval(
              approverContext,
              command,
            );
            firstAttemptId = created.attempt.activationAttemptId;

            assert.equal(created.approval.authorityPolicyVersion, 5);
            assert.equal(created.approval.approvingHumanId, approverA);
            assert.equal(created.approval.issuingActorId, approverA);
            assert.equal(created.approval.initiatingHumanId, approverA);
            assert.equal(created.approval.expectedPointerId, pointer.pointerId);
            assert.equal(created.approval.expectedFence, 0);
            assert.equal(created.approval.targetReleaseId, releaseOne);
            assert.deepEqual(
              [...created.approval.targetManifestRoot],
              [...Buffer.from(bootstrap.releaseRoot, 'hex')],
            );
            assert.deepEqual(created.approval.binding, {
              bindingKind: 'INITIAL_ACTIVATION',
              bindingVersion: INITIAL_ACTIVATION_BINDING_VERSION,
              canonicalDiffDigest: Uint8Array.from(digest('initial-diff')),
              releaseDiffAlgorithmVersion: null,
              releaseDiffVersion: null,
              sourceManifestRoot: null,
              sourceReleaseId: null,
              transitionPlanDigest: null,
            });
            assert.equal(
              new Date(created.approval.expiresAt).getTime() -
                new Date(created.approval.decidedAt).getTime(),
              APPROVAL_DEFAULT_EXPIRY_MILLISECONDS,
            );
            assert.equal(created.attempt.state, 'PREBOUND');
            assert.equal(created.attempt.executionPrincipalKind, 'SYSTEM');
            assert.equal(
              created.attempt.executionPrincipalId,
              SYSTEM_EXECUTION_PRINCIPAL.principalId,
            );
            assert.notEqual(
              created.approval.approvingHumanId,
              created.attempt.executionPrincipalId,
            );

            const persisted = await withTrustedRequestTransaction(
              runtimePool,
              approverContext,
              async (client) =>
                client.query<{
                  attempt_count: string;
                  expires_at: Date;
                  source_manifest_root: Uint8Array | null;
                  target_manifest_root: Uint8Array;
                }>(
                  `
                  SELECT approval.expires_at,
                         approval.source_manifest_root,
                         approval.target_manifest_root,
                         (
                           SELECT count(*)
                             FROM platform.release_activation_attempts AS attempt
                            WHERE attempt.approval_id = approval.approval_id
                         ) AS attempt_count
                    FROM platform.release_approvals AS approval
                   WHERE approval.approval_id = $1
                `,
                  [created.approval.approvalId],
                ),
            );
            assert.equal(persisted.rows[0]?.attempt_count, '1');
            assert.equal(persisted.rows[0]?.source_manifest_root, null);
            assert.equal(
              persisted.rows[0]?.expires_at.toISOString(),
              created.approval.expiresAt,
            );
          },
        );

        await t.test(
          'explicit expiry is bounded and canonical substitutions stay server-side',
          async () => {
            const explicitExpiry = new Date(
              fixedNow.getTime() + 2 * 60 * 60 * 1000,
            ).toISOString();
            const created = await service.createApproval(approverContext, {
              ...approvalCommand(
                approverContext,
                preparationOne,
                releaseOne,
                2,
              ),
              expiresAt: explicitExpiry,
              rolloutId: minted('a8500000-0000-4000-8000-000000000002'),
              sourceDecisionId: minted('a8600000-0000-4000-8000-000000000002'),
            });
            assert.equal(created.approval.expiresAt, explicitExpiry);
            assert.equal(
              created.approval.sourceDecisionId,
              'a8600000-0000-4000-8000-000000000002',
            );
            assert.equal(
              created.approval.rolloutId,
              'a8500000-0000-4000-8000-000000000002',
            );

            await assertApprovalError(
              service.createApproval(approverContext, {
                ...approvalCommand(
                  approverContext,
                  preparationOne,
                  releaseOne,
                  3,
                ),
                expiresAt: fixedNow.toISOString(),
              }),
              'EXPIRY_NOT_FUTURE',
            );
            await assertApprovalError(
              service.createApproval(approverContext, {
                ...approvalCommand(
                  approverContext,
                  preparationOne,
                  releaseOne,
                  4,
                ),
                expiresAt: new Date(
                  fixedNow.getTime() + 8 * 24 * 60 * 60 * 1000,
                ).toISOString(),
              }),
              'EXPIRY_EXCEEDS_POLICY',
            );
            await assertApprovalError(
              service.createApproval(
                approverContext,
                approvalCommand(approverContext, badPreparation, releaseOne, 5),
              ),
              'PREPARATION_TARGET_MISMATCH',
            );
          },
        );

        await t.test(
          'live authority and maker-checker reject revoked, absent, maker, and forged actors',
          async () => {
            await assertApprovalError(
              service.createApproval(
                revokedContext,
                approvalCommand(revokedContext, preparationOne, releaseOne, 6),
              ),
              'APPROVER_REVOKED',
            );
            await assertApprovalError(
              service.createApproval(
                noneligibleContext,
                approvalCommand(
                  noneligibleContext,
                  preparationOne,
                  releaseOne,
                  7,
                ),
              ),
              'APPROVER_NOT_ELIGIBLE',
            );
            await assertApprovalError(
              service.createApproval(
                makerContext,
                approvalCommand(makerContext, preparationOne, releaseOne, 8),
              ),
              'MAKER_CHECKER_VIOLATION',
            );
            await assertApprovalError(
              service.createApproval(approverContext, {
                ...approvalCommand(
                  approverContext,
                  preparationOne,
                  releaseOne,
                  9,
                ),
                issuingActorId: secondApproverContext.principalId,
              }),
              'UNTRUSTED_ACTOR_IDENTITY',
            );
          },
        );

        await t.test(
          'append-only privileges, reject rules, and decisive outcome uniqueness hold',
          async () => {
            assert.ok(firstAttemptId);
            const privilege = await pool.query<{
              authority_function_execute: boolean;
              guard_select: boolean;
              history_delete: boolean;
              history_insert: boolean;
              history_select: boolean;
              history_update: boolean;
              outcome_insert: boolean;
              outcome_select: boolean;
              phase_receipt_delete: boolean;
              phase_receipt_insert: boolean;
              phase_receipt_select: boolean;
              phase_receipt_update: boolean;
              pointer_delete: boolean;
              pointer_insert: boolean;
              pointer_select: boolean;
              pointer_update: boolean;
              preparation_insert: boolean;
            }>(`
              SELECT has_table_privilege(
                       'north_star_runtime',
                       'platform.active_release_pointers',
                       'SELECT'
                     ) AS pointer_select,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.active_release_pointers',
                       'UPDATE'
                     ) AS pointer_update,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.active_release_pointers',
                       'INSERT'
                     ) AS pointer_insert,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.active_release_pointers',
                       'DELETE'
                     ) AS pointer_delete,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.release_activation_preparations',
                       'INSERT'
                     ) AS preparation_insert,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.release_activation_phase_receipts',
                       'SELECT'
                     ) AS phase_receipt_select,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.release_activation_phase_receipts',
                       'INSERT'
                     ) AS phase_receipt_insert,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.release_activation_phase_receipts',
                       'UPDATE'
                     ) AS phase_receipt_update,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.release_activation_phase_receipts',
                       'DELETE'
                     ) AS phase_receipt_delete,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.release_activation_history',
                       'SELECT'
                     ) AS history_select,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.release_activation_history',
                       'INSERT'
                     ) AS history_insert,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.release_activation_history',
                       'UPDATE'
                     ) AS history_update,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.release_activation_history',
                       'DELETE'
                     ) AS history_delete,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.release_activation_attempt_outcomes',
                       'SELECT'
                     ) AS outcome_select,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.release_activation_attempt_outcomes',
                       'INSERT'
                     ) AS outcome_insert,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.release_activation_write_guard',
                       'SELECT'
                     ) AS guard_select,
                     has_function_privilege(
                       'north_star_runtime',
                       'platform.set_release_approver_eligibility(uuid,uuid,boolean,uuid,uuid)',
                       'EXECUTE'
                     ) AS authority_function_execute
            `);
            assert.deepEqual(privilege.rows[0], {
              authority_function_execute: false,
              guard_select: false,
              history_delete: false,
              history_insert: true,
              history_select: true,
              history_update: false,
              outcome_insert: false,
              outcome_select: true,
              phase_receipt_delete: false,
              phase_receipt_insert: true,
              phase_receipt_select: true,
              phase_receipt_update: false,
              pointer_delete: false,
              pointer_insert: false,
              pointer_select: true,
              pointer_update: true,
              preparation_insert: true,
            });

            const policies = await pool.query<{
              command: string;
              relation: string;
            }>(`
              SELECT tablename AS relation, cmd AS command
                FROM pg_catalog.pg_policies
               WHERE schemaname = 'platform'
                 AND tablename IN (
                   'release_activation_phase_receipts',
                   'release_activation_history'
                 )
               ORDER BY tablename, cmd
            `);
            assert.deepEqual(policies.rows, [
              {
                command: 'INSERT',
                relation: 'release_activation_history',
              },
              {
                command: 'SELECT',
                relation: 'release_activation_history',
              },
              {
                command: 'INSERT',
                relation: 'release_activation_phase_receipts',
              },
              {
                command: 'SELECT',
                relation: 'release_activation_phase_receipts',
              },
            ]);

            await withTrustedRequestTransaction(
              runtimePool,
              approverContext,
              async (client) => {
                await client.query(
                  `INSERT INTO platform.release_activation_phase_receipts (
                     tenant_id,
                     environment_id,
                     phase_receipt_id,
                     activation_attempt_id,
                     receipt_version,
                     phase_code,
                     receipt_digest
                   ) VALUES (
                     $1, $2, $3, $4,
                     'northstar.release-activation-phase-receipt/v1',
                     'PREPARATION_CONTRACT_PROOF',
                     $5
                   )`,
                  [
                    tenantA,
                    environmentA,
                    'a8900000-0000-4000-8000-000000000001',
                    firstAttemptId,
                    digest('phase-receipt-contract-proof'),
                  ],
                );
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
                     terminal
                   ) VALUES (
                     $1, $2, $3, $4,
                     'northstar.release-activation-history/v1',
                     $5, $6, $6, $6,
                     'SYSTEM', $7,
                     NULL, $8, 0,
                     'NOT_ATTEMPTED',
                     'NOT_RUN',
                     'RETAINED',
                     'RUNNING',
                     false
                   )`,
                  [
                    tenantA,
                    environmentA,
                    'a8a00000-0000-4000-8000-000000000001',
                    firstAttemptId,
                    pointer.pointerId,
                    approverA,
                    SYSTEM_EXECUTION_PRINCIPAL.principalId,
                    releaseOne,
                  ],
                );
              },
            );

            await assert.rejects(
              withTrustedRequestTransaction(
                runtimePool,
                approverContext,
                async (client) =>
                  client.query(
                    `UPDATE platform.release_approvals
                        SET renderer_version = 'changed'
                      WHERE activation_attempt_id = $1`,
                    [firstAttemptId],
                  ),
              ),
              /permission denied/,
            );
            await assert.rejects(
              withTrustedRequestTransaction(
                runtimePool,
                approverContext,
                async (client) =>
                  client.query(
                    `UPDATE platform.release_activation_phase_receipts
                        SET phase_code = 'CHANGED'
                      WHERE activation_attempt_id = $1`,
                    [firstAttemptId],
                  ),
              ),
              /permission denied/,
            );
            await assert.rejects(
              withTrustedRequestTransaction(
                runtimePool,
                approverContext,
                async (client) =>
                  client.query(
                    `DELETE FROM platform.release_activation_history
                      WHERE activation_attempt_id = $1`,
                    [firstAttemptId],
                  ),
              ),
              /permission denied/,
            );
            await assert.rejects(
              withTrustedRequestTransaction(
                runtimePool,
                approverContext,
                async (client) =>
                  client.query(
                    `DELETE FROM platform.release_activation_attempts
                      WHERE activation_attempt_id = $1`,
                    [firstAttemptId],
                  ),
              ),
              /permission denied/,
            );

            await assert.rejects(
              pool.query(
                `DELETE FROM platform.active_release_pointers
                  WHERE pointer_id = $1`,
                [pointer.pointerId],
              ),
              /release_activation_write_guard_reject|violates check constraint/,
            );

            for (const statement of [
              `UPDATE platform.release_activation_preparations
                  SET renderer_version = 'changed'
                WHERE preparation_id = '${preparationOne}'`,
              `DELETE FROM platform.release_approvals
                WHERE activation_attempt_id = '${firstAttemptId}'`,
              `UPDATE platform.release_approver_eligibility_events
                  SET eligible = false
                WHERE tenant_id = '${tenantA}' AND policy_version = 1`,
              `UPDATE platform.release_activation_phase_receipts
                  SET phase_code = 'CHANGED'
                WHERE activation_attempt_id = '${firstAttemptId}'`,
              `DELETE FROM platform.release_activation_history
                WHERE activation_attempt_id = '${firstAttemptId}'`,
            ]) {
              await assert.rejects(
                pool.query(statement),
                /release_activation_write_guard_reject|violates check constraint/,
              );
            }
            const rules = await pool.query<{ count: string }>(`
              SELECT count(*)
                FROM pg_catalog.pg_rewrite AS rewrite
                JOIN pg_catalog.pg_class AS relation
                  ON relation.oid = rewrite.ev_class
                JOIN pg_catalog.pg_namespace AS namespace
                  ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'platform'
                 AND rewrite.rulename ~ '_reject_(update|delete)$'
                 AND relation.relname IN (
                   'release_approver_eligibility_events',
                   'transition_preparation_receipts',
                   'release_activation_preparations',
                   'release_approvals',
                   'release_activation_attempts',
                   'release_activation_phase_receipts',
                   'release_activation_history',
                   'release_activation_attempt_outcomes',
                   'release_activation_outbox'
                 )
            `);
            assert.equal(rules.rows[0]?.count, '18');

            await pool.query(
              `INSERT INTO platform.release_activation_attempt_outcomes (
                 tenant_id,
                 environment_id,
                 activation_attempt_id,
                 outcome_id,
                 outcome_version,
                 condition_code,
                 pointer_outcome,
                 verification_outcome,
                 workflow_disposition,
                 workflow_status,
                 terminal,
                 outcome_digest
               ) VALUES (
                 $1, $2, $3, $4,
                 'northstar.release-activation-outcome/v1',
                 'CANCELLATION',
                 'NOT_ATTEMPTED',
                 'NOT_RUN',
                 'CONSUMED',
                 'CANCELLED',
                 true,
                 $5
               )`,
              [
                tenantA,
                environmentA,
                firstAttemptId,
                'a8700000-0000-4000-8000-000000000001',
                digest('first-decisive-outcome'),
              ],
            );
            await assert.rejects(
              pool.query(
                `INSERT INTO platform.release_activation_attempt_outcomes (
                   tenant_id,
                   environment_id,
                   activation_attempt_id,
                   outcome_id,
                   outcome_version,
                   condition_code,
                   pointer_outcome,
                   verification_outcome,
                   workflow_disposition,
                   workflow_status,
                   terminal,
                   outcome_digest
                 ) VALUES (
                   $1, $2, $3, $4,
                   'northstar.release-activation-outcome/v1',
                   'CANCELLATION',
                   'NOT_ATTEMPTED',
                   'NOT_RUN',
                   'CONSUMED',
                   'CANCELLED',
                   true,
                   $5
                 )`,
                [
                  tenantA,
                  environmentA,
                  firstAttemptId,
                  'a8700000-0000-4000-8000-000000000002',
                  digest('second-decisive-outcome'),
                ],
              ),
              /duplicate key/,
            );
          },
        );

        await t.test(
          'pointer UPDATE RLS enforces USING and WITH CHECK independently',
          async () => {
            const policy = await pool.query<{
              qual: string | null;
              with_check: string | null;
            }>(`
              SELECT qual, with_check
                FROM pg_catalog.pg_policies
               WHERE schemaname = 'platform'
                 AND tablename = 'active_release_pointers'
                 AND cmd = 'UPDATE'
            `);
            assert.match(policy.rows[0]?.qual ?? '', /tenant_id/);
            assert.match(policy.rows[0]?.qual ?? '', /environment_id/);
            assert.match(policy.rows[0]?.qual ?? '', /principal_id/);
            assert.match(policy.rows[0]?.with_check ?? '', /tenant_id/);
            assert.match(policy.rows[0]?.with_check ?? '', /environment_id/);
            assert.match(policy.rows[0]?.with_check ?? '', /principal_id/);

            const crossTenant = await withTrustedRequestTransaction(
              runtimePool,
              tenantBContext,
              async (client) =>
                client.query(
                  `UPDATE platform.active_release_pointers
                      SET release_id = $1, fence = fence + 1
                    WHERE pointer_id = $2`,
                  [releaseOne, pointer.pointerId],
                ),
            );
            assert.equal(crossTenant.rowCount, 0);
            const crossEnvironment = await withTrustedRequestTransaction(
              runtimePool,
              newEnvironmentContext,
              async (client) =>
                client.query(
                  `UPDATE platform.active_release_pointers
                      SET release_id = $1, fence = fence + 1
                    WHERE pointer_id = $2`,
                  [releaseOne, pointer.pointerId],
                ),
            );
            assert.equal(crossEnvironment.rowCount, 0);

            await assert.rejects(
              withTrustedRequestTransaction(
                runtimePool,
                approverContext,
                async (client) =>
                  client.query(
                    `UPDATE platform.active_release_pointers
                        SET release_id = $1,
                            fence = fence +
                              CASE
                                WHEN set_config(
                                  'north_star.principal_id',
                                  '',
                                  true
                                ) = '' THEN 1
                                ELSE 1
                              END
                      WHERE pointer_id = $2`,
                    [releaseOne, pointer.pointerId],
                  ),
              ),
              /row-level security policy/,
            );
          },
        );

        await t.test(
          'pointer trigger permits one +1 release swap and rejects every other shape',
          async () => {
            const valid = await withTrustedRequestTransaction(
              runtimePool,
              approverContext,
              async (client) =>
                client.query(
                  `UPDATE platform.active_release_pointers
                      SET release_id = $1, fence = fence + 1
                    WHERE pointer_id = $2`,
                  [releaseOne, pointer.pointerId],
                ),
            );
            assert.equal(valid.rowCount, 1);
            const swapped = await pool.query<{
              fence: string;
              release_id: string;
            }>(
              `
              SELECT release_id, fence
                FROM platform.active_release_pointers
               WHERE pointer_id = $1
            `,
              [pointer.pointerId],
            );
            assert.deepEqual(swapped.rows[0], {
              fence: '1',
              release_id: releaseOne,
            });

            for (const [name, statement, values] of [
              [
                'repeated fence',
                `UPDATE platform.active_release_pointers
                    SET release_id = $1, fence = 1
                  WHERE pointer_id = $2`,
                [releaseTwo, pointer.pointerId],
              ],
              [
                'skipped fence',
                `UPDATE platform.active_release_pointers
                    SET release_id = $1, fence = 3
                  WHERE pointer_id = $2`,
                [releaseTwo, pointer.pointerId],
              ],
              [
                'fence-only mutation',
                `UPDATE platform.active_release_pointers
                    SET fence = 2
                  WHERE pointer_id = $1`,
                [pointer.pointerId],
              ],
              [
                'null release',
                `UPDATE platform.active_release_pointers
                    SET release_id = NULL, fence = 2
                  WHERE pointer_id = $1`,
                [pointer.pointerId],
              ],
              [
                'pointer identity mutation',
                `UPDATE platform.active_release_pointers
                    SET pointer_id = $1, release_id = $2, fence = 2
                  WHERE pointer_id = $3`,
                [
                  'a8800000-0000-4000-8000-000000000001',
                  releaseTwo,
                  pointer.pointerId,
                ],
              ],
              [
                'scope mutation',
                `UPDATE platform.active_release_pointers
                    SET environment_id = $1, release_id = $2, fence = 2
                  WHERE pointer_id = $3`,
                [environmentANew, releaseTwo, pointer.pointerId],
              ],
              [
                'unrelated column mutation',
                `UPDATE platform.active_release_pointers
                    SET created_at = created_at + interval '1 second',
                        release_id = $1,
                        fence = 2
                  WHERE pointer_id = $2`,
                [releaseTwo, pointer.pointerId],
              ],
            ] as const) {
              await assert.rejects(
                pool.query(statement, [...values]),
                (error: unknown) =>
                  error instanceof Error &&
                  error.message.includes(
                    'updates require one exact release swap and fence + 1',
                  ) &&
                  name.length > 0,
              );
            }
            const unchanged = await pool.query<{
              fence: string;
              release_id: string;
            }>(
              `
              SELECT release_id, fence
                FROM platform.active_release_pointers
               WHERE pointer_id = $1
            `,
              [pointer.pointerId],
            );
            assert.deepEqual(unchanged.rows[0], {
              fence: '1',
              release_id: releaseOne,
            });
          },
        );
      } finally {
        await runtimePool.end();
      }
    },
  );
});

function identity(
  tenantId: string,
  environmentId: string,
  principalId: string,
): AuthenticatedIdentity {
  return { environmentId, principalId, tenantId };
}

function requestEntry(): AuthenticatedRequestEntryAdapter {
  return new AuthenticatedRequestEntryAdapter(async (request) => {
    const authorization = request.headers?.authorization;
    return typeof authorization === 'string'
      ? (identities.get(authorization) ?? null)
      : null;
  });
}

async function contextFor(
  entry: AuthenticatedRequestEntryAdapter,
  session: string,
): Promise<TrustedRequestContext> {
  return entry.enter({ headers: { authorization: session } });
}

async function seedExistingEnvironments(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO platform.tenants (id, slug)
     VALUES ($1, 'tenant-a'), ($2, 'tenant-b')`,
    [tenantA, tenantB],
  );
  await client.query(
    `INSERT INTO platform.environments (tenant_id, id, slug)
     VALUES ($1, $2, 'production'), ($3, $4, 'production')`,
    [tenantA, environmentA, tenantB, environmentB],
  );
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

async function changeEligibility(
  pool: pg.Pool,
  principalId: string,
  eligible: boolean,
  eventOrdinal: number,
): Promise<string> {
  const result = await pool.query<{ policy_version: string }>(
    `SELECT platform.set_release_approver_eligibility(
       $1, $2, $3, $4, $5
     ) AS policy_version`,
    [
      tenantA,
      principalId,
      eligible,
      authorityOperator,
      `a9100000-0000-4000-8000-${String(eventOrdinal).padStart(12, '0')}`,
    ],
  );
  return result.rows[0]!.policy_version;
}

interface PointerFixture {
  fence: number;
  pointerId: MintedUuid;
  releaseId: MintedUuid | null;
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
      `
      SELECT pointer_id, release_id, fence
        FROM platform.active_release_pointers
       WHERE tenant_id = $1 AND environment_id = $2
    `,
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

interface InitialPreparationFixture {
  compiled: CompileSuccess;
  evidenceId: MintedUuid;
  pointer: PointerFixture;
  preparationId: MintedUuid;
  receiptId: MintedUuid;
  releaseId: MintedUuid;
  targetRootOverride: Uint8Array | null;
}

async function insertInitialPreparation(
  pool: pg.Pool,
  context: TrustedRequestContext,
  fixture: InitialPreparationFixture,
): Promise<void> {
  const targetRoot =
    fixture.targetRootOverride ??
    Buffer.from(fixture.compiled.releaseRoot, 'hex');
  await withTrustedRequestTransaction(pool, context, async (client) => {
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
         $1, $2, $3,
         'northstar.transition-preparation-receipt/v1',
         NULL, NULL, $4, $5,
         'tenantLocal',
         'tenant-primary-storage',
         0,
         'northstar.compiler-transition-facts/v1',
         $6,
         'NO_STORAGE_TRANSITION',
         'SATISFIED',
         true,
         'northstar.executor-applied-state-evidence/v1',
         $7,
         'NOT_REQUIRED',
         true,
         'northstar.transition-compatibility-policy/v1',
         'ALLOW',
         'NO_STORAGE_RECOVERY_REQUIRED'
       )`,
      [
        context.tenantId,
        context.environmentId,
        fixture.receiptId,
        fixture.releaseId,
        targetRoot,
        digest('compiler-no-storage-facts'),
        digest('executor-not-required-evidence'),
      ],
    );
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
         $4, NULL, $5, NULL, $6, $7,
         'INITIAL_ACTIVATION',
         'northstar.initial-activation-binding/v1',
         NULL, NULL, $8, NULL, $9, $10, $11, $12, $13,
         'northstar.verification-evidence/v1',
         $14,
         'northstar.capability-support/v1',
         $15,
         'SUPPORTED',
         'northstar.release-diff-renderer/v1',
         'northstar.release-diff-view/v1',
         $16,
         $17
       )`,
      [
        context.tenantId,
        context.environmentId,
        fixture.preparationId,
        fixture.pointer.pointerId,
        fixture.pointer.fence,
        fixture.releaseId,
        targetRoot,
        digest('initial-diff'),
        Buffer.from(fixture.compiled.attestation.attestationDigest, 'hex'),
        fixture.compiled.bundle.releaseManifest.compilerVersion,
        fixture.compiled.bundle.releaseManifest.compilerSemanticProfileVersion,
        fixture.compiled.bundle.releaseManifest.outputProtocolVersion,
        fixture.evidenceId,
        digest('verification-evidence'),
        digest('capability-supported'),
        digest('rendered-diff-evidence'),
        fixture.receiptId,
      ],
    );
  });
}

function approvalCommand(
  context: TrustedRequestContext,
  preparationId: MintedUuid,
  targetReleaseId: MintedUuid,
  ordinal: number,
): CreateReleaseApprovalCommand {
  const suffix = String(ordinal).padStart(12, '0');
  return {
    activationAttemptId: minted(`a8200000-0000-4000-8000-${suffix}`),
    approvalId: minted(`a8100000-0000-4000-8000-${suffix}`),
    approvingHumanId: context.principalId,
    initiatingHumanId: context.principalId,
    issuingActorId: context.principalId,
    preparationId,
    targetReleaseId,
  };
}

async function assertApprovalError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof ReleaseApprovalError && error.code === code,
  );
}

function digest(value: string): Uint8Array {
  return createHash('sha256').update(value).digest();
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}
