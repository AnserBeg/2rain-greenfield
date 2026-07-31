import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import pg from 'pg';

import { startComposedApplication } from '../../apps/api/src/composition-root.js';
import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  expectedActiveReleaseFrom,
  type CompileSuccess,
  type StorageTargetPayloadV1,
} from '../../packages/compiler/src/index.js';
import {
  APPLICATION_IDS,
  composedApplicationDefinition,
} from '../../packages/domain/src/app/builder.js';
import {
  COMPILER_TRANSITION_FACTS_VERSION,
  EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
  RELEASE_DIFF_BINDING_VERSION,
  SYSTEM_EXECUTION_PRINCIPAL,
  TRANSITION_COMPATIBILITY_POLICY_VERSION,
  TRANSITION_PREPARATION_RECEIPT_VERSION,
  type MintedUuid,
} from '../../packages/platform-runtime/src/index.js';
import {
  createComposedApplicationRuntime,
  parseCompiledApplication,
  type ComposedApplicationRuntime,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { PostgresReleaseActivationService } from '../../packages/postgres-provider/src/release-activation-service.js';
import { PostgresReleaseApprovalService } from '../../packages/postgres-provider/src/release-approval-service.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { ReleaseReverseTransitionRefusal } from '../../packages/postgres-provider/src/release-reverse-transition-policy.js';
import { PostgresReleaseVerificationService } from '../../packages/postgres-provider/src/release-verification-service.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import {
  AuthenticatedRequestEntryAdapter,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import { SEMANTIC_OPERATION_REQUEST_VERSION } from '../../packages/runtime/src/semantic-operation-gateway.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import type { RequestRuntimeView } from '../../packages/runtime/src/request-runtime-view.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const compiledArtifactPath = resolve('apps/web/release/app.compiled.json');
const authoredArtifactPath = resolve('apps/web/release/app.authored.json');
const compileScriptPath = resolve('apps/web/scripts/compile-app-release.ts');
const migrationsDirectory = resolve('db/migrations');
const execFileAsync = promisify(execFile);
const rollbackFieldId = 'northstar.app:field.party_rollback_note';

test('composed product does not invent a verification evidence identity', async () => {
  const source = await readFile(
    resolve('packages/postgres-provider/src/composed-application-runtime.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /evidenceId\s*=\s*minted\(randomUUID\(\)\)/u);
});

test(
  'composed product activates through the kernel and persists tenant-scoped gateway data',
  { timeout: 120_000 },
  async () => {
    await withEphemeralPostgres(
      'g2-p5e-composed-application',
      async ({ connection, pool }) => {
        const compiledApplication = JSON.parse(
          await readFile(compiledArtifactPath, 'utf8'),
        ) as unknown;
        const authoredApplication = JSON.parse(
          await readFile(authoredArtifactPath, 'utf8'),
        ) as unknown;
        assert.deepEqual(
          authoredApplication,
          composedApplicationDefinition(),
          'the checked-in authored artifact is generated from the shared module factories',
        );
        const databaseUrl = connectionUrl(connection);
        let tenantA = await createRuntime(
          compiledApplication,
          databaseUrl,
          'composed-tenant-a',
        );
        let tenantB: ComposedApplicationRuntime | undefined;
        try {
          assert.equal(tenantA.triggerEnabledDuringActivation, true);
          await assertExactSwapTriggerEnabled(pool);
          await assertRealProductDefinition(tenantA);
          await assertDurableProductEvidence(pool, tenantA);

          const recordId = randomUUID();
          const created = await tenantA.entry.run(
            { headers: { authorization: 'local' } },
            (view) =>
              tenantA.operationGateway.invoke(
                view,
                {
                  confirmationGrant: null,
                  idempotencyKey: randomUUID(),
                  input: {
                    recordId,
                    values: {
                      [APPLICATION_IDS.party.fieldIds.contactSummary]:
                        'persisted@example.test',
                      [APPLICATION_IDS.party.fieldIds.name]:
                        'Persistent Browser Party',
                      [APPLICATION_IDS.party.fieldIds.number]: 'P-REAL-001',
                    },
                  },
                  operationId: APPLICATION_IDS.party.createOperationId,
                  schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
                },
                tenantA.operationMediation.issueInvocation(view, 'UI'),
              ),
          );
          assert.equal(created.outcome, 'succeeded');

          const separateRequest = await listParty(tenantA);
          assert.deepEqual(
            separateRequest.records.map((record) => record.recordId),
            [recordId],
            'a separate gateway request reads the committed PostgreSQL row',
          );

          await tenantA.close();
          tenantA = await createRuntime(
            compiledApplication,
            databaseUrl,
            'composed-tenant-a',
          );
          const afterRestart = await listParty(tenantA);
          assert.deepEqual(
            afterRestart.records.map((record) => record.recordId),
            [recordId],
            'the row survives composition-root reconstruction',
          );

          tenantB = await createRuntime(
            compiledApplication,
            databaseUrl,
            'composed-tenant-b',
          );
          const isolated = await listParty(tenantB);
          assert.equal(isolated.listCoverage?.totalCount, 0);
          assert.deepEqual(isolated.records, []);
          await assertApprovalEnforcementAndApprovedActivation(
            tenantA,
            compiledApplication,
            connection,
            pool,
          );
          await assertExactSwapTriggerEnabled(pool);
        } finally {
          await Promise.all([
            tenantA.close(),
            tenantB?.close() ?? Promise.resolve(),
          ]);
        }
      },
    );
  },
);

test(
  'composed product advances an existing deployment to an exact compiled successor',
  { timeout: 120_000 },
  async () => {
    await withEphemeralPostgres(
      'g2-1g-release-advancement',
      async ({ connection, pool }) => {
        const compiledApplication = JSON.parse(
          await readFile(compiledArtifactPath, 'utf8'),
        ) as unknown;
        const authoredApplication = JSON.parse(
          await readFile(authoredArtifactPath, 'utf8'),
        ) as Record<string, unknown>;
        const databaseUrl = connectionUrl(connection);
        let runtime = await createRuntime(
          compiledApplication,
          databaseUrl,
          'advancing-tenant',
        );
        try {
          await assertExactSwapTriggerEnabled(pool);
          const sourceReleaseId = runtime.activeReleaseId;
          const recordId = randomUUID();
          const created = await createParty(runtime, recordId, 'P-UPGRADE-001');
          assert.equal(created.outcome, 'succeeded');
          const before = await partyRowSnapshot(
            pool,
            runtime,
            compiledApplication,
            recordId,
          );
          const approvalCandidate = await compileCandidateEnvelope(
            compiledApplication,
            authoredApplication,
            false,
          );
          const candidate = await compileCandidateEnvelope(
            compiledApplication,
            authoredApplication,
            true,
          );
          const mismatched = compileMismatchedEnvelope(
            compiledApplication,
            authoredApplication,
          );
          await runtime.close();

          await assert.rejects(
            createRuntime(mismatched, databaseUrl, 'advancing-tenant'),
            /transition does not match its declared previous release/,
          );
          assert.equal(
            await activeReleaseId(pool, runtime.identity),
            sourceReleaseId,
          );

          await pool.query(
            `ALTER TABLE platform.active_release_pointers
               DISABLE TRIGGER active_release_pointer_exact_swap`,
          );
          try {
            await assert.rejects(
              createRuntime(approvalCandidate, databaseUrl, 'advancing-tenant'),
              /active_release_pointer_exact_swap is not enabled/,
            );
          } finally {
            await pool.query(
              `ALTER TABLE platform.active_release_pointers
                 ENABLE TRIGGER active_release_pointer_exact_swap`,
            );
          }
          await assertExactSwapTriggerEnabled(pool);
          assert.equal(
            await activeReleaseId(pool, runtime.identity),
            sourceReleaseId,
          );

          await assertApprovalRequiredForAdvancement(
            runtime,
            approvalCandidate,
            connection,
            pool,
          );
          assert.equal(
            await activeReleaseId(pool, runtime.identity),
            sourceReleaseId,
          );
          await assertExactSwapTriggerEnabled(pool);

          runtime = await createRuntime(
            candidate,
            databaseUrl,
            'advancing-tenant',
          );
          await assertExactSwapTriggerEnabled(pool);
          assert.notEqual(
            runtime.releaseRoot,
            parseCompiledApplication(compiledApplication).application.compiled
              .releaseRoot,
          );
          const after = await partyRowSnapshot(
            pool,
            runtime,
            candidate,
            recordId,
          );
          assert.deepEqual(
            { ctid: after.ctid, xmin: after.xmin },
            { ctid: before.ctid, xmin: before.xmin },
            'the storage-changing forward transition does not rewrite the existing tuple',
          );
          assertRowRetainsPriorValues(before.row, after.row);
          const rollbackColumn = partyFieldColumn(candidate, rollbackFieldId);
          assert.equal(after.row[rollbackColumn], null);
          const listed = await listParty(runtime);
          assert.deepEqual(
            listed.records.map((record) => record.recordId),
            [recordId],
            'the row written under release A is readable under release B',
          );
          await assertApprovedActivationRecorded(
            pool,
            runtime,
            sourceReleaseId,
          );
          const candidateReleaseId = runtime.activeReleaseId;
          await assertMaterializedReversibleForwardTransition(
            pool,
            sourceReleaseId,
            candidateReleaseId,
          );
          await runtime.close();
          await setLatestForwardTransitionRecoveryMode(
            pool,
            sourceReleaseId,
            candidateReleaseId,
            'forwardOnly',
          );
          try {
            await assert.rejects(
              createRuntime(candidate, databaseUrl, 'advancing-tenant', {
                kind: 'rollback',
                targetReleaseRoot:
                  parseCompiledApplication(compiledApplication).application
                    .compiled.releaseRoot,
              }),
              (error: unknown) => {
                assert.ok(error instanceof ReleaseReverseTransitionRefusal);
                assert.equal(
                  error.code,
                  'ROLLBACK_FORWARD_TRANSITION_NOT_REVERSIBLE',
                );
                return true;
              },
            );
          } finally {
            await setLatestForwardTransitionRecoveryMode(
              pool,
              sourceReleaseId,
              candidateReleaseId,
              'reversible',
            );
          }
          assert.equal(
            await activeReleaseId(pool, runtime.identity),
            candidateReleaseId,
          );
          await assertNoReverseApprovalRecorded(
            pool,
            runtime,
            candidateReleaseId,
            sourceReleaseId,
          );
          await assertReleaseServicesRejectNonExactReversePairs(
            runtime,
            compiledApplication,
            connection,
            pool,
            candidateReleaseId,
            sourceReleaseId,
          );
          await assertExactSwapTriggerEnabled(pool);
          runtime = await createRuntime(
            candidate,
            databaseUrl,
            'advancing-tenant',
            {
              kind: 'rollback',
              targetReleaseRoot:
                parseCompiledApplication(compiledApplication).application
                  .compiled.releaseRoot,
            },
          );
          assert.equal(
            runtime.releaseRoot,
            parseCompiledApplication(compiledApplication).application.compiled
              .releaseRoot,
            'an explicit reverse transition selects the prior immutable release',
          );
          await assertExactSwapTriggerEnabled(pool);
          const afterRollback = await partyRowSnapshot(
            pool,
            runtime,
            candidate,
            recordId,
          );
          assert.deepEqual(
            afterRollback,
            after,
            'rollback leaves the physical tuple and additive storage unchanged',
          );
          assert.deepEqual(
            (await listParty(runtime)).records.map((record) => record.recordId),
            [recordId],
            'release A reads its original row after reversal',
          );
          await assertApprovedReverseActivationRecorded(
            pool,
            runtime,
            candidateReleaseId,
          );
          await assertEmptyRollbackSelectorFailsClosed(
            runtime,
            databaseUrl,
            pool,
          );

          await runtime.close();
          runtime = await createRuntime(
            candidate,
            databaseUrl,
            'advancing-tenant',
          );
          assert.equal(
            runtime.releaseRoot,
            parseCompiledApplication(candidate).application.compiled
              .releaseRoot,
            'the unchanged v2 lineage replays A -> B after rollback',
          );
          await assertExactSwapTriggerEnabled(pool);
          assert.deepEqual(
            await partyRowSnapshot(pool, runtime, candidate, recordId),
            after,
            'fresh v2 replay converges without rewriting the physical tuple',
          );
        } finally {
          await runtime.close();
        }
      },
    );
  },
);

async function assertEmptyRollbackSelectorFailsClosed(
  runtime: ComposedApplicationRuntime,
  databaseUrl: string,
  adminPool: pg.Pool,
): Promise<void> {
  const pointerBefore = await activePointerSnapshot(adminPool, runtime);
  const approvalCountBefore = await totalApprovalCount(adminPool, runtime);
  let unexpectedlyStarted:
    Awaited<ReturnType<typeof startComposedApplication>> | undefined;
  try {
    await assert.rejects(
      async () => {
        unexpectedlyStarted = await startComposedApplication({
          databaseUrl,
          host: '127.0.0.1',
          port: 0,
          rollbackReleaseRoot: '',
          tenantSlug: 'advancing-tenant',
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof ReleaseReverseTransitionRefusal);
        assert.equal(error.code, 'ROLLBACK_TARGET_NOT_IMMEDIATE_PREDECESSOR');
        return true;
      },
    );
  } finally {
    await unexpectedlyStarted?.close();
  }
  assert.deepEqual(
    await activePointerSnapshot(adminPool, runtime),
    pointerBefore,
    'an explicitly empty rollback selector leaves the persisted pointer unchanged',
  );
  assert.equal(
    await totalApprovalCount(adminPool, runtime),
    approvalCountBefore,
    'an explicitly empty rollback selector creates no approval',
  );
}

async function activePointerSnapshot(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
): Promise<Readonly<{ fence: string; releaseId: MintedUuid }>> {
  const result = await pool.query<{
    fence: string;
    release_id: MintedUuid;
  }>(
    `SELECT fence::text AS fence, release_id
       FROM platform.active_release_pointers
      WHERE tenant_id = $1 AND environment_id = $2`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return Object.freeze({ fence: row.fence, releaseId: row.release_id });
}

async function totalApprovalCount(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.release_approvals
      WHERE tenant_id = $1 AND environment_id = $2`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function assertRealProductDefinition(
  runtime: ComposedApplicationRuntime,
): Promise<void> {
  await runtime.entry.run({ headers: { authorization: 'local' } }, (view) => {
    const surfaces = (
      view.projections.surface.payload as {
        surfaces: readonly { surfaceId: string }[];
      }
    ).surfaces.map((surface) => surface.surfaceId);
    assert.equal(surfaces.length, 12);
    assert.ok(surfaces.includes(APPLICATION_IDS.party.listSurfaceId));
    assert.ok(surfaces.includes(APPLICATION_IDS.catalog.listSurfaceId));
    assert.ok(surfaces.includes(APPLICATION_IDS.location.listSurfaceId));
  });
}

async function assertApprovalEnforcementAndApprovedActivation(
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
  connection: pg.PoolConfig,
  adminPool: pg.Pool,
): Promise<void> {
  const runtimePool = new pg.Pool({
    ...connection,
    max: 2,
    user: 'north_star_runtime',
  });
  runtimePool.on('error', () => undefined);
  try {
    const context = await new AuthenticatedRequestEntryAdapter(
      async () => runtime.identity,
    ).enter({});
    const revision = await adminPool.query<{ revision_id: MintedUuid }>(
      `SELECT app_package_revision_id AS revision_id
         FROM platform.tenant_releases
        WHERE release_id = $1`,
      [runtime.activeReleaseId],
    );
    const revisionId = revision.rows[0]?.revision_id;
    assert.ok(revisionId);
    const candidateReleaseId = randomUUID() as MintedUuid;
    const application =
      parseCompiledApplication(compiledApplication).application;
    const repository = new PostgresImmutableReleaseRepository(runtimePool);
    const staged = await repository.stageTenantReleaseCandidate(context, {
      appPackageRevisionId: revisionId,
      compiledRelease: application.compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId: candidateReleaseId,
      tenantId: context.tenantId,
    });
    await new PostgresReleaseVerificationService(
      runtimePool,
    ).executeSemanticCandidateAndPersist(context, {
      compiledRelease: application.compiled,
      evidenceId: staged.verificationEvidenceId,
      releaseId: candidateReleaseId,
    });
    await repository.registerTenantRelease(context, {
      appPackageRevisionId: revisionId,
      compiledRelease: application.compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId: candidateReleaseId,
      tenantId: context.tenantId,
      verificationEvidenceId: staged.verificationEvidenceId,
    });
    const approverPrincipalId = await currentApproverPrincipal(
      adminPool,
      context.tenantId,
    );
    const approverContext = await new AuthenticatedRequestEntryAdapter(
      async () => ({
        environmentId: context.environmentId,
        principalId: approverPrincipalId,
        tenantId: context.tenantId,
      }),
    ).enter({});
    const target = {
      compiled: application.compiled,
      evidenceId: staged.verificationEvidenceId,
      releaseId: candidateReleaseId,
    };
    const rejectedAttemptId = await prepareAndApproveCandidate(
      runtimePool,
      context,
      approverContext,
      target,
    );
    await assertAttemptTargetsCandidate(
      adminPool,
      rejectedAttemptId,
      candidateReleaseId,
    );
    await assertExactSwapTriggerEnabled(adminPool);

    const systemContext = await new AuthenticatedRequestEntryAdapter(
      async () => ({
        environmentId: runtime.identity.environmentId,
        principalId: SYSTEM_EXECUTION_PRINCIPAL.principalId,
        tenantId: runtime.identity.tenantId,
      }),
    ).enter({});
    const activation = new PostgresReleaseActivationService(runtimePool);
    await setApproverEligibility(
      adminPool,
      context.tenantId,
      approverPrincipalId,
      false,
    );
    const rejected = await activation.activate(systemContext, {
      activationAttemptId: rejectedAttemptId,
    });
    assert.equal(rejected.decisiveOutcomeCode, 'APPROVER_REVOCATION');
    assert.equal(rejected.status, 'NO_SWAP_TERMINAL');
    assert.equal(rejected.releaseId, null);
    assert.equal(
      await activeReleaseId(adminPool, runtime.identity),
      runtime.activeReleaseId,
    );
    await assertExactSwapTriggerEnabled(adminPool);

    await setApproverEligibility(
      adminPool,
      context.tenantId,
      approverPrincipalId,
      true,
    );
    const approvedAttemptId = await prepareAndApproveCandidate(
      runtimePool,
      context,
      approverContext,
      target,
    );
    assert.notEqual(approvedAttemptId, rejectedAttemptId);
    await assertAttemptTargetsCandidate(
      adminPool,
      approvedAttemptId,
      candidateReleaseId,
    );
    await assertExactSwapTriggerEnabled(adminPool);
    const activated = await activation.activate(systemContext, {
      activationAttemptId: approvedAttemptId,
    });
    assert.equal(activated.decisiveOutcomeCode, 'SWAPPED');
    assert.equal(activated.status, 'SWAPPED_VERIFIED');
    assert.equal(activated.releaseId, candidateReleaseId);
    assert.equal(
      await activeReleaseId(adminPool, runtime.identity),
      candidateReleaseId,
    );
    await assertExactSwapTriggerEnabled(adminPool);
  } finally {
    await runtimePool.end();
  }
}

async function assertApprovalRequiredForAdvancement(
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
  connection: pg.PoolConfig,
  adminPool: pg.Pool,
): Promise<void> {
  const runtimePool = new pg.Pool({
    ...connection,
    max: 2,
    user: 'north_star_runtime',
  });
  runtimePool.on('error', () => undefined);
  try {
    const context = await new AuthenticatedRequestEntryAdapter(
      async () => runtime.identity,
    ).enter({});
    const application =
      parseCompiledApplication(compiledApplication).application;
    const candidate = await adminPool.query<{
      app_package_revision_id: MintedUuid;
      release_id: MintedUuid;
      verification_evidence_id: MintedUuid;
    }>(
      `SELECT app_package_revision_id, release_id, verification_evidence_id
         FROM platform.tenant_releases
        WHERE tenant_id = $1
          AND environment_id = $2
          AND content_hash = $3`,
      [
        context.tenantId,
        context.environmentId,
        application.compiled.releaseRoot,
      ],
    );
    const target = candidate.rows[0];
    assert.ok(target, 'the trigger-negative startup staged the real candidate');
    const repository = new PostgresImmutableReleaseRepository(runtimePool);
    if (!(await repository.getTenantRelease(context, target.release_id))) {
      await new PostgresReleaseVerificationService(
        runtimePool,
      ).executeSemanticCandidateAndPersist(context, {
        compiledRelease: application.compiled,
        evidenceId: target.verification_evidence_id,
        releaseId: target.release_id,
      });
      await repository.registerTenantRelease(context, {
        appPackageRevisionId: target.app_package_revision_id,
        compiledRelease: application.compiled,
        createdBy: context.principalId,
        environmentId: context.environmentId,
        releaseId: target.release_id,
        tenantId: context.tenantId,
        verificationEvidenceId: target.verification_evidence_id,
      });
    }
    const approverPrincipalId = await currentApproverPrincipal(
      adminPool,
      context.tenantId,
    );
    const approverContext = await new AuthenticatedRequestEntryAdapter(
      async () => ({
        environmentId: context.environmentId,
        principalId: approverPrincipalId,
        tenantId: context.tenantId,
      }),
    ).enter({});
    const rejectedAttemptId = await prepareAndApproveCandidate(
      runtimePool,
      context,
      approverContext,
      {
        compiled: application.compiled,
        evidenceId: target.verification_evidence_id,
        releaseId: target.release_id,
      },
    );
    await assertAttemptTargetsCandidate(
      adminPool,
      rejectedAttemptId,
      target.release_id,
    );
    await setApproverEligibility(
      adminPool,
      context.tenantId,
      approverPrincipalId,
      false,
    );
    const systemContext = await new AuthenticatedRequestEntryAdapter(
      async () => ({
        environmentId: context.environmentId,
        principalId: SYSTEM_EXECUTION_PRINCIPAL.principalId,
        tenantId: context.tenantId,
      }),
    ).enter({});
    const rejected = await new PostgresReleaseActivationService(
      runtimePool,
    ).activate(systemContext, {
      activationAttemptId: rejectedAttemptId,
    });
    assert.equal(rejected.decisiveOutcomeCode, 'APPROVER_REVOCATION');
    assert.equal(rejected.status, 'NO_SWAP_TERMINAL');
    assert.equal(rejected.releaseId, null);
    await assertExactSwapTriggerEnabled(adminPool);
    await setApproverEligibility(
      adminPool,
      context.tenantId,
      approverPrincipalId,
      true,
    );
  } finally {
    await runtimePool.end();
  }
}

async function assertReleaseServicesRejectNonExactReversePairs(
  runtime: ComposedApplicationRuntime,
  previousCompiledApplication: unknown,
  connection: pg.PoolConfig,
  adminPool: pg.Pool,
  sourceReleaseId: MintedUuid,
  immediateTargetReleaseId: MintedUuid,
): Promise<void> {
  const runtimePool = new pg.Pool({
    ...connection,
    max: 2,
    user: 'north_star_runtime',
  });
  runtimePool.on('error', () => undefined);
  try {
    const context = await new AuthenticatedRequestEntryAdapter(
      async () => runtime.identity,
    ).enter({});
    const approverPrincipalId = await currentApproverPrincipal(
      adminPool,
      context.tenantId,
    );
    const approverContext = await new AuthenticatedRequestEntryAdapter(
      async () => ({
        environmentId: context.environmentId,
        principalId: approverPrincipalId,
        tenantId: context.tenantId,
      }),
    ).enter({});
    const systemContext = await new AuthenticatedRequestEntryAdapter(
      async () => ({
        environmentId: context.environmentId,
        principalId: SYSTEM_EXECUTION_PRINCIPAL.principalId,
        tenantId: context.tenantId,
      }),
    ).enter({});
    const previous = parseCompiledApplication(previousCompiledApplication);
    const immediateTarget = await releaseTarget(
      adminPool,
      context,
      immediateTargetReleaseId,
      previous.application.compiled,
    );
    const bootstrapRelease = await releaseTargetForRoot(
      adminPool,
      context,
      previous.bootstrap.compiled.releaseRoot,
      previous.bootstrap.compiled,
    );

    const skippedApprovalCount = await approvalCountForPair(
      adminPool,
      context,
      sourceReleaseId,
      bootstrapRelease.releaseId,
    );
    await assert.rejects(
      prepareAndApproveCandidate(
        runtimePool,
        context,
        approverContext,
        bootstrapRelease,
      ),
      (error: unknown) =>
        assertReverseRefusal(
          error,
          'RELEASE_TRANSITION_NOT_EXACT_LINEAGE_EDGE',
        ),
    );
    assert.equal(
      await approvalCountForPair(
        adminPool,
        context,
        sourceReleaseId,
        bootstrapRelease.releaseId,
      ),
      skippedApprovalCount,
      'approval refuses a skipped B-to-bootstrap lineage edge before writing an approval',
    );

    const outsideReleaseId = randomUUID() as MintedUuid;
    const repository = new PostgresImmutableReleaseRepository(runtimePool);
    const staged = await repository.stageTenantReleaseCandidate(context, {
      appPackageRevisionId: immediateTarget.revisionId,
      compiledRelease: immediateTarget.compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId: outsideReleaseId,
      tenantId: context.tenantId,
    });
    await new PostgresReleaseVerificationService(
      runtimePool,
    ).executeSemanticCandidateAndPersist(context, {
      compiledRelease: immediateTarget.compiled,
      evidenceId: staged.verificationEvidenceId,
      releaseId: outsideReleaseId,
    });
    await repository.registerTenantRelease(context, {
      appPackageRevisionId: immediateTarget.revisionId,
      compiledRelease: immediateTarget.compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId: outsideReleaseId,
      tenantId: context.tenantId,
      verificationEvidenceId: staged.verificationEvidenceId,
    });
    const outsideTarget = {
      compiled: immediateTarget.compiled,
      evidenceId: staged.verificationEvidenceId,
      releaseId: outsideReleaseId,
      revisionId: immediateTarget.revisionId,
    };
    await assert.rejects(
      prepareAndApproveCandidate(
        runtimePool,
        context,
        approverContext,
        outsideTarget,
      ),
      (error: unknown) =>
        assertReverseRefusal(error, 'ROLLBACK_FORWARD_ACTIVATION_NOT_VERIFIED'),
    );
    assert.equal(
      await approvalCountForPair(
        adminPool,
        context,
        sourceReleaseId,
        outsideReleaseId,
      ),
      0,
      'approval refuses an admitted release identity outside the activated lineage',
    );

    const activationAttemptId = await prepareAndApproveCandidate(
      runtimePool,
      context,
      approverContext,
      immediateTarget,
    );
    const sourceRevision = await adminPool.query<{
      parent_revision_id: MintedUuid | null;
      revision_id: MintedUuid;
    }>(
      `SELECT revision.revision_id, revision.parent_revision_id
         FROM platform.tenant_releases AS release
         JOIN platform.app_package_revisions AS revision
           ON revision.tenant_id = release.tenant_id
          AND revision.revision_id = release.app_package_revision_id
        WHERE release.tenant_id = $1
          AND release.environment_id = $2
          AND release.release_id = $3`,
      [context.tenantId, context.environmentId, sourceReleaseId],
    );
    const sourceRevisionRow = sourceRevision.rows[0];
    assert.ok(sourceRevisionRow);
    assert.equal(
      sourceRevisionRow.parent_revision_id,
      immediateTarget.revisionId,
      'the activation control starts from the real immediate reverse edge',
    );
    const skippedAncestorRevisionId = randomUUID() as MintedUuid;
    const insertedAncestor = await adminPool.query(
      `INSERT INTO platform.app_package_revisions (
         tenant_id, revision_id, parent_revision_id, schema_version,
         language_version, normalization_profile_version,
         canonicalization_profile_version, hash_algorithm, content_hash,
         desired_state, provenance, created_by
       )
       SELECT tenant_id, $3, revision_id, schema_version, language_version,
              normalization_profile_version,
              canonicalization_profile_version, hash_algorithm, content_hash,
              desired_state, provenance, $4
         FROM platform.app_package_revisions
        WHERE tenant_id = $1 AND revision_id = $2`,
      [
        context.tenantId,
        immediateTarget.revisionId,
        skippedAncestorRevisionId,
        context.principalId,
      ],
    );
    assert.equal(insertedAncestor.rowCount, 1);
    await adminPool.query(
      `ALTER TABLE platform.app_package_revisions
         DISABLE RULE app_package_revisions_reject_update`,
    );
    try {
      const changed = await adminPool.query(
        `UPDATE platform.app_package_revisions
            SET parent_revision_id = $3
          WHERE tenant_id = $1 AND revision_id = $2`,
        [
          context.tenantId,
          sourceRevisionRow.revision_id,
          skippedAncestorRevisionId,
        ],
      );
      assert.equal(changed.rowCount, 1);
      await assert.rejects(
        new PostgresReleaseActivationService(runtimePool).activate(
          systemContext,
          { activationAttemptId },
        ),
        (error: unknown) =>
          assertReverseRefusal(
            error,
            'RELEASE_TRANSITION_NOT_EXACT_LINEAGE_EDGE',
          ),
      );
    } finally {
      await adminPool.query(
        `UPDATE platform.app_package_revisions
            SET parent_revision_id = $3
          WHERE tenant_id = $1 AND revision_id = $2`,
        [
          context.tenantId,
          sourceRevisionRow.revision_id,
          immediateTarget.revisionId,
        ],
      );
      await adminPool.query(
        `ALTER TABLE platform.app_package_revisions
           ENABLE RULE app_package_revisions_reject_update`,
      );
    }
    const immutableRule = await adminPool.query<{ enabled: string }>(
      `SELECT ev_enabled AS enabled
         FROM pg_catalog.pg_rewrite
        WHERE ev_class = 'platform.app_package_revisions'::regclass
          AND rulename = 'app_package_revisions_reject_update'`,
    );
    assert.equal(
      immutableRule.rows[0]?.enabled,
      'O',
      'the immutable revision update rule is restored after the activation control',
    );
    assert.equal(
      await activeReleaseId(adminPool, runtime.identity),
      sourceReleaseId,
      'activation refuses the no-longer-exact pair before swapping the pointer',
    );
    const outcome = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM platform.release_activation_attempt_outcomes
        WHERE activation_attempt_id = $1`,
      [activationAttemptId],
    );
    assert.equal(
      outcome.rows[0]?.count,
      '0',
      'the activation boundary refuses before recording a decisive outcome',
    );
  } finally {
    await runtimePool.end();
  }
}

async function releaseTarget(
  pool: pg.Pool,
  context: TrustedRequestContext,
  releaseId: MintedUuid,
  compiled: ReturnType<
    typeof parseCompiledApplication
  >['application']['compiled'],
): Promise<{
  compiled: ReturnType<
    typeof parseCompiledApplication
  >['application']['compiled'];
  evidenceId: MintedUuid;
  releaseId: MintedUuid;
  revisionId: MintedUuid;
}> {
  const result = await pool.query<{
    app_package_revision_id: MintedUuid;
    release_id: MintedUuid;
    verification_evidence_id: MintedUuid;
  }>(
    `SELECT app_package_revision_id, release_id, verification_evidence_id
       FROM platform.tenant_releases
      WHERE tenant_id = $1
        AND environment_id = $2
        AND release_id = $3`,
    [context.tenantId, context.environmentId, releaseId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return {
    compiled,
    evidenceId: row.verification_evidence_id,
    releaseId: row.release_id,
    revisionId: row.app_package_revision_id,
  };
}

async function releaseTargetForRoot(
  pool: pg.Pool,
  context: TrustedRequestContext,
  releaseRoot: string,
  compiled: ReturnType<
    typeof parseCompiledApplication
  >['application']['compiled'],
): ReturnType<typeof releaseTarget> {
  const result = await pool.query<{ release_id: MintedUuid }>(
    `SELECT release_id
       FROM platform.tenant_releases
      WHERE tenant_id = $1
        AND environment_id = $2
        AND content_hash = $3
      ORDER BY created_at, release_id
      LIMIT 1`,
    [context.tenantId, context.environmentId, releaseRoot],
  );
  const releaseId = result.rows[0]?.release_id;
  assert.ok(releaseId);
  return releaseTarget(pool, context, releaseId, compiled);
}

async function approvalCountForPair(
  pool: pg.Pool,
  context: TrustedRequestContext,
  sourceReleaseId: MintedUuid,
  targetReleaseId: MintedUuid,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.release_approvals
      WHERE tenant_id = $1
        AND environment_id = $2
        AND expected_release_id = $3
        AND target_release_id = $4`,
    [context.tenantId, context.environmentId, sourceReleaseId, targetReleaseId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

function assertReverseRefusal(
  error: unknown,
  code:
    | 'RELEASE_TRANSITION_NOT_EXACT_LINEAGE_EDGE'
    | 'ROLLBACK_FORWARD_ACTIVATION_NOT_VERIFIED',
): true {
  assert.ok(error instanceof ReleaseReverseTransitionRefusal);
  assert.equal(error.code, code);
  return true;
}

async function prepareAndApproveCandidate(
  pool: pg.Pool,
  context: TrustedRequestContext,
  approverContext: TrustedRequestContext,
  target: Readonly<{
    compiled: ReturnType<
      typeof parseCompiledApplication
    >['application']['compiled'];
    evidenceId: MintedUuid;
    releaseId: MintedUuid;
  }>,
): Promise<MintedUuid> {
  const pointer = await withTrustedRequestTransaction(
    pool,
    context,
    async (client) => {
      const result = await client.query<{
        content_hash: string;
        fence: string;
        pointer_id: MintedUuid;
        release_id: MintedUuid;
      }>(
        `SELECT pointer.pointer_id,
                pointer.release_id,
                pointer.fence,
                release.content_hash
           FROM platform.active_release_pointers AS pointer
           JOIN platform.tenant_releases AS release
             ON release.tenant_id = pointer.tenant_id
            AND release.environment_id = pointer.environment_id
            AND release.release_id = pointer.release_id
          WHERE pointer.tenant_id = $1 AND pointer.environment_id = $2`,
        [context.tenantId, context.environmentId],
      );
      const row = result.rows[0];
      assert.ok(row);
      return row;
    },
  );
  const preparationId = randomUUID() as MintedUuid;
  const receiptId = randomUUID() as MintedUuid;
  const sourceRoot = Buffer.from(pointer.content_hash, 'hex');
  const targetRoot = Buffer.from(target.compiled.releaseRoot, 'hex');

  await withTrustedRequestTransaction(pool, context, async (client) => {
    const evidence = await client.query<{
      evidence_version: string;
      result_set_digest: string;
    }>(
      `SELECT evidence_version, result_set_digest
         FROM platform.release_verification_evidence
        WHERE verification_evidence_id = $1`,
      [target.evidenceId],
    );
    const verified = evidence.rows[0];
    assert.ok(verified);
    await client.query(
      `INSERT INTO platform.transition_preparation_receipts (
         tenant_id, environment_id, receipt_id, receipt_version,
         source_release_id, source_manifest_root, target_release_id,
         target_manifest_root, transition_scope, storage_domain_id,
         schema_generation, compiler_facts_version, compiler_facts_digest,
         compiler_transition_class, compiler_static_compatibility,
         compiler_exact_pair, executor_evidence_version,
         executor_evidence_digest, executor_applied_state, executor_exact_pair,
         compatibility_policy_version, compatibility_policy_verdict,
         recovery_mode
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,'tenantLocal','tenant-primary-storage',$9,
         $10,$11,'NO_STORAGE_TRANSITION','SATISFIED',true,$12,$13,
         'NOT_REQUIRED',true,$14,'ALLOW','NO_STORAGE_RECOVERY_REQUIRED'
       )`,
      [
        context.tenantId,
        context.environmentId,
        receiptId,
        TRANSITION_PREPARATION_RECEIPT_VERSION,
        pointer.release_id,
        sourceRoot,
        target.releaseId,
        targetRoot,
        pointer.fence,
        COMPILER_TRANSITION_FACTS_VERSION,
        digest('candidate-compiler-facts', target.releaseId),
        EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
        digest('candidate-executor-evidence', target.releaseId),
        TRANSITION_COMPATIBILITY_POLICY_VERSION,
      ],
    );
    await client.query(
      `INSERT INTO platform.release_activation_preparations (
         tenant_id, environment_id, preparation_id, preparation_version,
         expected_pointer_id, expected_release_id, expected_fence,
         source_manifest_root, target_release_id, target_manifest_root,
         diff_binding_kind, diff_binding_version, release_diff_version,
         release_diff_algorithm_version, canonical_diff_digest,
         transition_plan_digest, compiler_attestation_digest, compiler_version,
         compiler_semantic_profile_version, compiler_output_protocol_version,
         verification_evidence_id, verification_evidence_version,
         verification_evidence_digest, capability_support_version,
         capability_support_digest, capability_support_result, renderer_version,
         view_schema_version, rendered_diff_evidence_digest,
         transition_preparation_receipt_id
       ) VALUES (
         $1,$2,$3,'northstar.release-activation-preparation/v1',$4,$5,$6,$7,$8,
         $9,'RELEASE_DIFF',$10,'northstar.release-diff/v0-experimental',
         'northstar.release-diff-algorithm/v1',$11,NULL,$12,$13,$14,$15,$16,
         $17,$18,
         'northstar.capability-support/v1',$19,'SUPPORTED',
         'northstar.release-diff-renderer/v1','northstar.release-diff-view/v1',
         $20,$21
       )`,
      [
        context.tenantId,
        context.environmentId,
        preparationId,
        pointer.pointer_id,
        pointer.release_id,
        pointer.fence,
        sourceRoot,
        target.releaseId,
        targetRoot,
        RELEASE_DIFF_BINDING_VERSION,
        digest('candidate-canonical-diff', target.releaseId),
        Buffer.from(target.compiled.attestation.attestationDigest, 'hex'),
        target.compiled.bundle.releaseManifest.compilerVersion,
        target.compiled.bundle.releaseManifest.compilerSemanticProfileVersion,
        target.compiled.bundle.releaseManifest.outputProtocolVersion,
        target.evidenceId,
        verified.evidence_version,
        Buffer.from(verified.result_set_digest, 'hex'),
        digest('candidate-capability-support', target.releaseId),
        digest('candidate-rendered-diff', target.releaseId),
        receiptId,
      ],
    );
  });

  const activationAttemptId = randomUUID() as MintedUuid;
  const created = await new PostgresReleaseApprovalService(pool).createApproval(
    approverContext,
    {
      activationAttemptId,
      approvalId: randomUUID() as MintedUuid,
      approvingHumanId: approverContext.principalId,
      initiatingHumanId: context.principalId,
      issuingActorId: approverContext.principalId,
      preparationId,
      targetReleaseId: target.releaseId,
    },
  );
  assert.equal(created.approval.targetReleaseId, target.releaseId);
  return created.attempt.activationAttemptId;
}

async function currentApproverPrincipal(
  pool: pg.Pool,
  tenantId: string,
): Promise<string> {
  const result = await pool.query<{ principal_id: string }>(
    `SELECT principal_id
       FROM (
         SELECT DISTINCT ON (principal_id) principal_id, eligible
           FROM platform.release_approver_eligibility_events
          WHERE tenant_id = $1
          ORDER BY principal_id, policy_version DESC
       ) AS current_approver
      WHERE eligible
      ORDER BY principal_id
      LIMIT 1`,
    [tenantId],
  );
  const principalId = result.rows[0]?.principal_id;
  assert.ok(principalId);
  return principalId;
}

async function setApproverEligibility(
  pool: pg.Pool,
  tenantId: string,
  principalId: string,
  eligible: boolean,
): Promise<void> {
  await pool.query(
    'SELECT platform.set_release_approver_eligibility($1,$2,$3,$4,$5)',
    [tenantId, principalId, eligible, randomUUID(), randomUUID()],
  );
}

async function assertAttemptTargetsCandidate(
  pool: pg.Pool,
  activationAttemptId: MintedUuid,
  candidateReleaseId: MintedUuid,
): Promise<void> {
  const result = await pool.query<{
    activation_attempt_id: MintedUuid;
    target_release_id: MintedUuid;
  }>(
    `SELECT attempt.activation_attempt_id, approval.target_release_id
       FROM platform.release_activation_attempts AS attempt
       JOIN platform.release_approvals AS approval
         ON approval.tenant_id = attempt.tenant_id
        AND approval.environment_id = attempt.environment_id
        AND approval.approval_id = attempt.approval_id
        AND approval.activation_attempt_id = attempt.activation_attempt_id
      WHERE attempt.activation_attempt_id = $1`,
    [activationAttemptId],
  );
  assert.deepEqual(result.rows[0], {
    activation_attempt_id: activationAttemptId,
    target_release_id: candidateReleaseId,
  });
}

async function activeReleaseId(
  pool: pg.Pool,
  identity: ComposedApplicationRuntime['identity'],
): Promise<MintedUuid> {
  const result = await pool.query<{ release_id: MintedUuid }>(
    `SELECT release_id
       FROM platform.active_release_pointers
      WHERE tenant_id = $1 AND environment_id = $2`,
    [identity.tenantId, identity.environmentId],
  );
  const releaseId = result.rows[0]?.release_id;
  assert.ok(releaseId);
  return releaseId;
}

function digest(label: string, ...values: string[]): Buffer {
  const hash = createHash('sha256').update(
    'northstar.composed-application-review-control/v1\0',
  );
  hash.update(label);
  for (const value of values) hash.update('\0').update(value);
  return hash.digest();
}

function listParty(runtime: ComposedApplicationRuntime) {
  return runtime.entry.run(
    { headers: { authorization: 'local' } },
    (view: RequestRuntimeView) =>
      runtime.queryGateway.invoke(view, {
        arguments: {
          includeArchived: false,
          list: {
            cursor: null,
            matchMode: 'substring',
            pageSize: 100,
            relationLabels: [],
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            search: '',
            sort: [],
          },
        },
        queryId: APPLICATION_IDS.party.listQueryId,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      }),
  );
}

function createParty(
  runtime: ComposedApplicationRuntime,
  recordId: string,
  number: string,
) {
  return runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
    runtime.operationGateway.invoke(
      view,
      {
        confirmationGrant: null,
        idempotencyKey: randomUUID(),
        input: {
          recordId,
          values: {
            [APPLICATION_IDS.party.fieldIds.contactSummary]:
              'upgrade@example.test',
            [APPLICATION_IDS.party.fieldIds.name]: 'Upgrade-safe Party',
            [APPLICATION_IDS.party.fieldIds.number]: number,
          },
        },
        operationId: APPLICATION_IDS.party.createOperationId,
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      },
      runtime.operationMediation.issueInvocation(view, 'UI'),
    ),
  );
}

async function partyRowSnapshot(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
  recordId: string,
): Promise<
  Readonly<{ ctid: string; row: Record<string, unknown>; xmin: string }>
> {
  const storage = storageTarget(
    parseCompiledApplication(compiledApplication).application.compiled,
  );
  const party = storage.entities.find(
    (entity) => entity.entityId === 'northstar.app:entity.party',
  );
  assert.ok(party);
  assert.match(party.physicalTableName, /^nsm_t_[a-z2-7]+$/);
  const result = await pool.query<{
    ctid: string;
    row: Record<string, unknown>;
    xmin: string;
  }>(
    `SELECT ctid::text AS ctid,
            to_jsonb(stored_row) AS row,
            xmin::text AS xmin
       FROM north_star_module.${party.physicalTableName} AS stored_row
      WHERE tenant_id = $1 AND environment_id = $2 AND record_id = $3`,
    [runtime.identity.tenantId, runtime.identity.environmentId, recordId],
  );
  const snapshot = result.rows[0];
  assert.ok(snapshot);
  return snapshot;
}

function assertRowRetainsPriorValues(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): void {
  assert.deepEqual(
    Object.fromEntries(Object.keys(before).map((key) => [key, after[key]])),
    before,
    'every pre-transition physical column retains its exact value',
  );
}

function partyFieldColumn(
  compiledApplication: unknown,
  fieldId: string,
): string {
  const party = storageTarget(
    parseCompiledApplication(compiledApplication).application.compiled,
  ).entities.find((entity) => entity.entityId === 'northstar.app:entity.party');
  assert.ok(party);
  const column = party.columns.find(
    (candidate) => candidate.canonicalFieldId === fieldId,
  );
  assert.ok(column);
  return column.physicalName;
}

function storageTarget(compiled: CompileSuccess): StorageTargetPayloadV1 {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (projection) => projection.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.ok(reference);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (artifact) =>
      artifact.artifactKind === 'projectionManifest' &&
      artifact.contentHash === reference.artifactRoot,
  );
  assert.ok(manifestArtifact);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as { chunks: readonly { contentHash: string }[] };
  assert.equal(manifest.chunks.length, 1);
  const chunk = compiled.bundle.artifacts.find(
    (artifact) =>
      artifact.artifactKind === 'projectionChunk' &&
      artifact.contentHash === manifest.chunks[0]?.contentHash,
  );
  assert.ok(chunk);
  return JSON.parse(
    new TextDecoder().decode(chunk.canonicalBytes),
  ) as StorageTargetPayloadV1;
}

async function assertApprovedActivationRecorded(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  sourceReleaseId: MintedUuid,
): Promise<void> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.release_activation_attempts AS attempt
       JOIN platform.release_approvals AS approval
         ON approval.tenant_id = attempt.tenant_id
        AND approval.environment_id = attempt.environment_id
        AND approval.approval_id = attempt.approval_id
        AND approval.activation_attempt_id = attempt.activation_attempt_id
       JOIN platform.release_activation_attempt_outcomes AS outcome
         ON outcome.tenant_id = attempt.tenant_id
        AND outcome.environment_id = attempt.environment_id
        AND outcome.activation_attempt_id = attempt.activation_attempt_id
      WHERE approval.tenant_id = $1
        AND approval.environment_id = $2
        AND approval.expected_release_id = $3
        AND approval.target_release_id = $4
        AND outcome.outcome_code = 'SWAPPED'`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      sourceReleaseId,
      runtime.activeReleaseId,
    ],
  );
  assert.equal(
    result.rows[0]?.count,
    '1',
    'the successful advancement is bound to a persisted human approval',
  );
}

async function assertApprovedReverseActivationRecorded(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  sourceReleaseId: MintedUuid,
): Promise<void> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.release_activation_attempts AS attempt
       JOIN platform.release_approvals AS approval
         ON approval.tenant_id = attempt.tenant_id
        AND approval.environment_id = attempt.environment_id
        AND approval.approval_id = attempt.approval_id
        AND approval.activation_attempt_id = attempt.activation_attempt_id
       JOIN platform.release_activation_attempt_outcomes AS outcome
         ON outcome.tenant_id = attempt.tenant_id
        AND outcome.environment_id = attempt.environment_id
        AND outcome.activation_attempt_id = attempt.activation_attempt_id
      WHERE approval.tenant_id = $1
        AND approval.environment_id = $2
        AND approval.expected_release_id = $3
        AND approval.target_release_id = $4
        AND outcome.outcome_code = 'SWAPPED'`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      sourceReleaseId,
      runtime.activeReleaseId,
    ],
  );
  assert.equal(
    result.rows[0]?.count,
    '1',
    'the reverse transition is bound to a fresh persisted human approval',
  );
}

async function assertMaterializedReversibleForwardTransition(
  pool: pg.Pool,
  sourceReleaseId: MintedUuid,
  targetReleaseId: MintedUuid,
): Promise<void> {
  const result = await pool.query<{
    compiler_transition_class: string;
    generation_id: MintedUuid | null;
    receipt_version: string;
    recovery_mode: string;
  }>(
    `SELECT receipt.receipt_version,
            receipt.generation_id,
            receipt.compiler_transition_class,
            receipt.recovery_mode
       FROM platform.release_activation_swap_receipts AS swap
       JOIN platform.release_approvals AS approval
         ON approval.tenant_id = swap.tenant_id
        AND approval.environment_id = swap.environment_id
        AND approval.approval_id = swap.approval_id
        AND approval.activation_attempt_id = swap.activation_attempt_id
       JOIN platform.transition_preparation_receipts AS receipt
         ON receipt.tenant_id = approval.tenant_id
        AND receipt.environment_id = approval.environment_id
        AND receipt.receipt_id = approval.transition_preparation_receipt_id
      WHERE swap.previous_release_id = $1
        AND swap.activated_release_id = $2`,
    [sourceReleaseId, targetReleaseId],
  );
  const receipt = result.rows[0];
  assert.ok(receipt);
  assert.equal(
    receipt.receipt_version,
    'northstar.transition-preparation-receipt/v2',
  );
  assert.ok(receipt.generation_id);
  assert.equal(receipt.compiler_transition_class, 'REVERSIBLE');
  assert.equal(receipt.recovery_mode, 'REVERSIBLE');
}

async function assertNoReverseApprovalRecorded(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  sourceReleaseId: MintedUuid,
  targetReleaseId: MintedUuid,
): Promise<void> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.release_approvals
      WHERE tenant_id = $1
        AND environment_id = $2
        AND expected_release_id = $3
        AND target_release_id = $4`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      sourceReleaseId,
      targetReleaseId,
    ],
  );
  assert.equal(
    result.rows[0]?.count,
    '0',
    'a refused reverse transition does not reach approval creation',
  );
}

async function setLatestForwardTransitionRecoveryMode(
  pool: pg.Pool,
  sourceReleaseId: MintedUuid,
  targetReleaseId: MintedUuid,
  mode: 'forwardOnly' | 'reversible',
): Promise<void> {
  await pool.query(
    `ALTER TABLE platform.transition_preparation_receipts
       DISABLE RULE transition_preparation_receipts_reject_update`,
  );
  try {
    const result = await pool.query(
      `UPDATE platform.transition_preparation_receipts AS receipt
          SET compiler_transition_class = $3,
              recovery_mode = $4
         FROM platform.release_approvals AS approval
         JOIN platform.release_activation_swap_receipts AS swap
           ON swap.tenant_id = approval.tenant_id
          AND swap.environment_id = approval.environment_id
          AND swap.approval_id = approval.approval_id
          AND swap.activation_attempt_id = approval.activation_attempt_id
        WHERE receipt.tenant_id = approval.tenant_id
          AND receipt.environment_id = approval.environment_id
          AND receipt.receipt_id = approval.transition_preparation_receipt_id
          AND swap.previous_release_id = $1
          AND swap.activated_release_id = $2`,
      [
        sourceReleaseId,
        targetReleaseId,
        mode === 'forwardOnly' ? 'IRREVERSIBLE' : 'REVERSIBLE',
        mode === 'forwardOnly' ? 'FORWARD_RECOVERY_ONLY' : 'REVERSIBLE',
      ],
    );
    assert.equal(result.rowCount, 1);
  } finally {
    await pool.query(
      `ALTER TABLE platform.transition_preparation_receipts
         ENABLE RULE transition_preparation_receipts_reject_update`,
    );
  }
  const rule = await pool.query<{ enabled: string }>(
    `SELECT ev_enabled AS enabled
       FROM pg_catalog.pg_rewrite
      WHERE ev_class = 'platform.transition_preparation_receipts'::regclass
        AND rulename = 'transition_preparation_receipts_reject_update'`,
  );
  assert.equal(
    rule.rows[0]?.enabled,
    'O',
    'the immutable receipt update rule is restored after the control',
  );
}

async function assertExactSwapTriggerEnabled(pool: pg.Pool): Promise<void> {
  const trigger = await pool.query<{ enabled: string }>(
    `SELECT tgenabled AS enabled
       FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'platform.active_release_pointers'::regclass
        AND tgname = 'active_release_pointer_exact_swap'
        AND NOT tgisinternal`,
  );
  assert.equal(trigger.rows[0]?.enabled, 'O');
}

async function assertDurableProductEvidence(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
): Promise<void> {
  const result = await pool.query<{
    executed_environment_id: string;
    executed_evidence_id: string;
    executed_tenant_id: string;
    release_root: string;
    result_count: string;
    result_rows: string;
    verification_evidence_id: string;
  }>(
    `SELECT evidence.verification_evidence_id,
            evidence.release_root,
            evidence.executed_tenant_id,
            evidence.executed_environment_id,
            evidence.executed_evidence_id,
            evidence.result_count::text,
            count(result.scenario_id)::text AS result_rows
       FROM platform.tenant_release_admissions AS admission
       JOIN platform.release_verification_evidence AS evidence
         ON evidence.tenant_id = admission.tenant_id
        AND evidence.environment_id = admission.environment_id
        AND evidence.verification_evidence_id =
            admission.verification_evidence_id
       LEFT JOIN platform.release_verification_results AS result
         ON result.tenant_id = evidence.tenant_id
        AND result.environment_id = evidence.environment_id
        AND result.verification_evidence_id =
            evidence.verification_evidence_id
      WHERE admission.tenant_id = $1
        AND admission.environment_id = $2
        AND admission.release_id = $3
      GROUP BY evidence.tenant_id, evidence.environment_id,
               evidence.verification_evidence_id`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      runtime.activeReleaseId,
    ],
  );
  const evidence = result.rows[0];
  assert.ok(evidence, 'the active product release has a durable admission');
  assert.equal(evidence.release_root, runtime.releaseRoot);
  assert.equal(evidence.executed_tenant_id, runtime.identity.tenantId);
  assert.equal(
    evidence.executed_environment_id,
    runtime.identity.environmentId,
  );
  assert.equal(
    evidence.executed_evidence_id,
    evidence.verification_evidence_id,
  );
  assert.ok(Number(evidence.result_count) > 0);
  assert.equal(evidence.result_rows, evidence.result_count);
}

function createRuntime(
  compiledApplication: unknown,
  databaseUrl: string,
  tenantSlug: string,
  releaseSelection?: Readonly<{
    kind: 'rollback';
    targetReleaseRoot: string;
  }>,
) {
  return createComposedApplicationRuntime({
    compiledApplication,
    databaseUrl,
    migrationsDirectory,
    ...(releaseSelection ? { releaseSelection } : {}),
    tenantSlug,
  });
}

function connectionUrl(connection: pg.PoolConfig): string {
  return `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
}

async function compileCandidateEnvelope(
  compiledApplication: unknown,
  authoredApplication: Record<string, unknown>,
  storageChange: boolean,
): Promise<unknown> {
  const candidateDefinition = structuredClone(authoredApplication);
  const packageDefinition = candidateDefinition.package as Record<
    string,
    unknown
  >;
  packageDefinition.version = storageChange ? '1.0.2' : '1.0.1';
  if (storageChange) {
    // Version-from-artifact: a node spliced into this candidate must declare
    // the candidate's own version, not a literal.
    const candidateNodeVersion = (
      candidateDefinition as unknown as { languageVersion: string }
    ).languageVersion;
    const fields = candidateDefinition.fields as Array<Record<string, unknown>>;
    fields.push({
      classification: 'internal',
      collation: 'unicodeCaseInsensitive',
      defaultSemantics: 'nullable',
      entity: {
        kind: 'entityReference',
        schemaVersion: candidateNodeVersion,
        targetId: 'northstar.app:entity.party',
      },
      fieldId: rollbackFieldId,
      fieldType: {
        kind: 'textFieldType',
        maximumLength: 160,
        schemaVersion: candidateNodeVersion,
      },
      kind: 'fieldDefinition',
      label: 'Rollback note',
      orderKey: 40,
      presence: 'optional',
      reportable: true,
      schemaVersion: candidateNodeVersion,
      searchable: false,
    });
  }
  const directory = await mkdtemp(
    resolve(tmpdir(), 'northstar-app-release-advancement-'),
  );
  const authoredPath = resolve(directory, 'app.authored.json');
  const compiledPath = resolve(directory, 'app.compiled.json');
  try {
    await Promise.all([
      writeFile(authoredPath, JSON.stringify(candidateDefinition)),
      writeFile(compiledPath, JSON.stringify(compiledApplication)),
    ]);
    const environment = {
      ...process.env,
      NORTH_STAR_APP_AUTHORED_PATH: authoredPath,
      NORTH_STAR_APP_COMPILED_PATH: compiledPath,
    };
    for (const arguments_ of [
      ['--import', 'tsx', compileScriptPath],
      ['--import', 'tsx', compileScriptPath, '--check'],
    ]) {
      await execFileAsync(process.execPath, arguments_, {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: environment,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      });
    }
    const candidate = JSON.parse(
      await readFile(compiledPath, 'utf8'),
    ) as unknown;
    const previous = parseCompiledApplication(compiledApplication);
    assert.equal(
      parseCompiledApplication(candidate).applications.length,
      previous.applications.length + 1,
      'the rebuild appends one immutable successor to the compiled lineage',
    );
    return candidate;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function compileMismatchedEnvelope(
  compiledApplication: unknown,
  authoredApplication: Record<string, unknown>,
): unknown {
  const previous = parseCompiledApplication(compiledApplication);
  const decoyBytes = normalizedDefinitionVersion(authoredApplication, '1.0.8');
  const decoy = compileSuccessor(previous.application.compiled, decoyBytes);
  const mismatchedBytes = normalizedDefinitionVersion(
    authoredApplication,
    '1.0.9',
  );
  const mismatched = compileSuccessor(decoy, mismatchedBytes);
  return {
    applications: [
      ...previous.applications.map((release) =>
        serializedRelease(release.normalizedDefinitionBytes, release.compiled),
      ),
      serializedRelease(mismatchedBytes, mismatched),
    ],
    bootstrap: serializedRelease(
      previous.bootstrap.normalizedDefinitionBytes,
      previous.bootstrap.compiled,
    ),
    schemaVersion: 'northstar.web:compiled-application-release/v2',
  };
}

function normalizedDefinitionVersion(
  authoredApplication: Record<string, unknown>,
  version: string,
): Uint8Array {
  const candidateDefinition = structuredClone(authoredApplication);
  const packageDefinition = candidateDefinition.package as Record<
    string,
    unknown
  >;
  packageDefinition.version = version;
  return new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(candidateDefinition)),
  );
}

function compileSuccessor(
  previous: CompileSuccess,
  normalizedDefinitionBytes: Uint8Array,
): CompileSuccess {
  const result = compileApplication({
    dependencies: [],
    expectedActiveRelease: expectedActiveReleaseFrom(previous),
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes,
    profile: profileForNormalizedBytes(normalizedDefinitionBytes),
  });
  assert.equal(result.status, 'compiled');
  return result as CompileSuccess;
}

function serializedRelease(
  normalizedDefinitionBytes: Uint8Array,
  compiled: CompileSuccess,
): unknown {
  return {
    attestation: compiled.attestation,
    artifacts: compiled.bundle.artifacts.map((artifact) => ({
      ...artifact,
      canonicalBytesBase64: Buffer.from(artifact.canonicalBytes).toString(
        'base64',
      ),
      canonicalBytes: undefined,
    })),
    nodeContracts: compiled.bundle.nodeContracts,
    normalizedDefinitionBytesBase64: Buffer.from(
      normalizedDefinitionBytes,
    ).toString('base64'),
    outputProtocolVersion: compiled.bundle.outputProtocolVersion,
    releaseManifest: compiled.bundle.releaseManifest,
    releaseManifestBytesBase64: Buffer.from(
      compiled.bundle.releaseManifestBytes,
    ).toString('base64'),
    releaseRoot: compiled.releaseRoot,
    stagedArtifactHashes: compiled.stagedArtifacts.map(
      (artifact) => artifact.contentHash,
    ),
  };
}

/**
 * Version-from-artifact: compile a fixture at the version it declares rather
 * than at whichever version is currently adopted. A pinned profile makes every
 * control here fail the moment adoption moves, for reasons unrelated to what
 * they measure.
 */
function profileForNormalizedBytes(
  bytes: Uint8Array,
): typeof MODULE_COMPILER_PROFILE {
  const declared = JSON.parse(new TextDecoder().decode(bytes)) as {
    languageVersion?: (typeof MODULE_COMPILER_PROFILE)['languageVersion'];
    normalizationProfileVersion?: (typeof MODULE_COMPILER_PROFILE)['normalizationProfileVersion'];
  };
  return {
    ...MODULE_COMPILER_PROFILE,
    ...(declared.languageVersion === undefined
      ? {}
      : { languageVersion: declared.languageVersion }),
    ...(declared.normalizationProfileVersion === undefined
      ? {}
      : {
          normalizationProfileVersion: declared.normalizationProfileVersion,
        }),
  };
}
