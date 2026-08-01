import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import pg from 'pg';

import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
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
  type VerificationPlanPayloadV1,
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
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { PostgresReleaseActivationService } from '../../packages/postgres-provider/src/release-activation-service.js';
import { PostgresReleaseApprovalService } from '../../packages/postgres-provider/src/release-approval-service.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { ReleaseReverseTransitionRefusal } from '../../packages/postgres-provider/src/release-reverse-transition-policy.js';
import {
  PostgresReleaseVerificationService,
  releaseVerificationBinding,
  type DurableReleaseVerificationEvidence,
} from '../../packages/postgres-provider/src/release-verification-service.js';
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

// Harness limit, not a product budget. The compiled application carries eight
// immutable application releases. Each of the two fresh tenants replays all
// eight, and the approval control verifies the active release once more. A
// quiet pre-cache profile took 249.6s, including 224.3s of semantic
// verification and 4,739 repeated pinned-artifact loads. The validated
// per-release cache reduced that to 17 verification loads; two quiet runs of
// this unchanged parent took 80.3s and 96.4s. The append-only lineage cost is
// tracked separately from this eliminated per-invocation reload tax.
test(
  'composed product activates through the kernel and persists tenant-scoped gateway data',
  { timeout: 300_000 },
  async (context) => {
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
          await context.test(
            'semantic verification keeps constrained-domain probes outside compiled partial uniqueness',
            () =>
              assertConstrainedDomainVerificationCompleted(
                pool,
                connection,
                tenantA,
                compiledApplication,
              ),
          );

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
          await context.test(
            'materializer seeding survives a second tenant without a blanket insert',
            () =>
              assertMaterializerSeedingIsNarrowlyScoped(
                pool,
                connection,
                tenantA,
                tenantB as ComposedApplicationRuntime,
                compiledApplication,
              ),
          );
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

// Same harness limit for the same measured reason: this test brought up its
// tenant and advanced the lineage in 98.5s under the round-1 matrix, inside a
// 120_000ms limit it no longer clears reliably.
test(
  'composed product advances an existing deployment to an exact compiled successor',
  { timeout: 300_000 },
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
    assert.equal(surfaces.length, 32);
    assert.ok(surfaces.includes(APPLICATION_IDS.party.listSurfaceId));
    assert.ok(surfaces.includes(APPLICATION_IDS.catalog.listSurfaceId));
    assert.ok(surfaces.includes(APPLICATION_IDS.location.listSurfaceId));
    // Inventory only reaches a mounted runtime once its emitted-but-
    // unarrangeable verification scenarios are recorded as derivations.
    for (const inventorySurfaceId of [
      'northstar.app:surface.inventory_movement_list',
      'northstar.app:surface.inventory_on_hand_lookup',
      'northstar.app:surface.inventory_period_lock_list',
      'northstar.app:surface.inventory_transaction_list',
      'northstar.app:surface.legal_entity_list',
      'northstar.app:surface.stock_count_list',
    ]) {
      assert.ok(
        surfaces.includes(inventorySurfaceId),
        `the composed product mounts ${inventorySurfaceId}`,
      );
    }
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
  return projectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
}

function projectionPayload<T>(compiled: CompileSuccess, familyId: string): T {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (projection) => projection.familyId === familyId,
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
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
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

/**
 * Row-level security is a table property, so the tenant that first materializes
 * a seeded table seeds it before RLS is enabled and every later tenant does not.
 * The materializer therefore needs a real INSERT policy, and that policy must
 * stay as narrow as the SELECT policy it mirrors: only the two seeded table
 * classes, only the trusted tenant and environment.
 */
async function assertMaterializerSeedingIsNarrowlyScoped(
  pool: pg.Pool,
  connection: pg.PoolConfig,
  tenantA: ComposedApplicationRuntime,
  tenantB: ComposedApplicationRuntime,
  compiledApplication: unknown,
): Promise<void> {
  const storage = storageTarget(
    parseCompiledApplication(compiledApplication).application.compiled,
  );
  const master = storage.entities.find(
    (candidate) => candidate.legalEntityMaster !== undefined,
  );
  const periodLock = storage.entities.find(
    (candidate) => candidate.periodLock !== undefined,
  );
  const ordinary = storage.entities.find(
    (candidate) => candidate.entityId === 'northstar.app:entity.party',
  );
  assert.ok(master?.legalEntityMaster);
  assert.ok(periodLock?.periodLock);
  assert.ok(ordinary);

  // The second tenant reached the same seeded state as the first.
  const periodLockScope = periodLock.legalEntity;
  assert.ok(periodLockScope);
  for (const [runtime, tenantLabel] of [
    [tenantA, 'first'],
    [tenantB, 'second'],
  ] as const) {
    const seeded: pg.QueryResult<{ record_id: string }> = await pool.query(
      `SELECT "${master.recordIdentity.column}"::text AS record_id
         FROM north_star_module.${master.physicalTableName}
        WHERE tenant_id = $1 AND environment_id = $2
          AND "${master.legalEntityMaster.fieldColumns.code}" = 'DEFAULT'
          AND "${master.legalEntityMaster.fieldColumns.isDefault}" IS TRUE
          AND "${master.archive.archivedAtColumn}" IS NULL`,
      [runtime.identity.tenantId, runtime.identity.environmentId],
    );
    assert.equal(
      seeded.rows.length,
      1,
      `the ${tenantLabel} tenant carries its seeded default legal entity`,
    );
    const seededLegalEntityId = seeded.rows[0]?.record_id;
    const locks: pg.QueryResult<{ count: string }> = await pool.query(
      `SELECT count(*)::text AS count
         FROM north_star_module.${periodLock.physicalTableName}
        WHERE tenant_id = $1 AND environment_id = $2
          AND "${periodLockScope.column}" = $3`,
      [
        runtime.identity.tenantId,
        runtime.identity.environmentId,
        seededLegalEntityId,
      ],
    );
    assert.equal(
      locks.rows[0]?.count,
      '1',
      `the ${tenantLabel} tenant carries its seeded period-lock row`,
    );
  }

  // The insert policy exists for exactly the two seeded table classes.
  const insertPolicies = await pool.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_catalog.pg_policies
      WHERE schemaname = 'north_star_module'
        AND cmd = 'INSERT'
        AND 'north_star_module_materializer' = ANY (roles::text[])
      ORDER BY tablename`,
  );
  assert.deepEqual(
    insertPolicies.rows.map((row) => row.tablename),
    [master.physicalTableName, periodLock.physicalTableName].toSorted(),
    'only the seeded table classes carry a materializer insert policy',
  );

  const materializerPool = new pg.Pool({
    ...connection,
    max: 1,
    user: 'north_star_module_materializer',
  });
  try {
    const client = await materializerPool.connect();
    try {
      const legalEntityMaster = master.legalEntityMaster;
      const seedColumns = [
        'tenant_id',
        'environment_id',
        master.recordIdentity.column,
        master.optimisticRevision.column,
        legalEntityMaster.fieldColumns.code,
        legalEntityMaster.fieldColumns.name,
        legalEntityMaster.fieldColumns.status,
        legalEntityMaster.fieldColumns.isDefault,
      ]
        .map((column) => `"${column}"`)
        .join(', ');
      const seedInsert = `INSERT INTO north_star_module.${master.physicalTableName}
           (${seedColumns})
         VALUES ($1, $2, $3, 1, 'CONTROL', 'Control legal entity', $4, false)`;

      // The predicate binds: the trusted pair is accepted and the other
      // tenant's pair is refused by the same statement in the same session.
      await client.query('BEGIN');
      await setTrustedScope(client, tenantB);
      await client.query(seedInsert, [
        tenantB.identity.tenantId,
        tenantB.identity.environmentId,
        randomUUID(),
        legalEntityMaster.activeStatusValue,
      ]);
      await assertRefusedByRowLevelSecurity(
        client.query(seedInsert, [
          tenantA.identity.tenantId,
          tenantA.identity.environmentId,
          randomUUID(),
          legalEntityMaster.activeStatusValue,
        ]),
        'a seed row for another tenant is refused',
      );
      await client.query('ROLLBACK');

      // The policy is not blanket: an ordinary business entity table stays
      // closed to the materializer even for its own trusted tenant. The row is
      // built from the physical catalog so no NOT NULL or CHECK violation can
      // stand in for the refusal under test.
      await client.query('BEGIN');
      await setTrustedScope(client, tenantB);
      await assertRefusedByRowLevelSecurity(
        satisfiableInsert(client, ordinary.physicalTableName, {
          environment_id: tenantB.identity.environmentId,
          tenant_id: tenantB.identity.tenantId,
        }),
        'an ordinary business entity table refuses the materializer',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await materializerPool.end();
  }
}

/**
 * Inserts one row whose every mandatory physical column is populated, so the
 * only thing left that can refuse it is a policy.
 */
async function satisfiableInsert(
  client: pg.PoolClient,
  tableName: string,
  overrides: Readonly<Record<string, string>>,
): Promise<unknown> {
  const columns = await client.query<{
    column_name: string;
    data_type: string;
  }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'north_star_module'
        AND table_name = $1
        AND is_nullable = 'NO'
        AND column_default IS NULL
        AND is_generated = 'NEVER'
      ORDER BY ordinal_position`,
    [tableName],
  );
  assert.ok(columns.rows.length > 0);
  const names: string[] = [];
  const expressions: string[] = [];
  const values: string[] = [];
  for (const [index, column] of columns.rows.entries()) {
    names.push(`"${column.column_name}"`);
    const override = overrides[column.column_name];
    if (override !== undefined) {
      values.push(override);
      expressions.push(`$${String(values.length)}`);
      continue;
    }
    expressions.push(defaultLiteral(column.data_type, index));
  }
  return client.query(
    `INSERT INTO north_star_module.${tableName} (${names.join(', ')})
     VALUES (${expressions.join(', ')})`,
    values,
  );
}

function defaultLiteral(dataType: string, seed: number): string {
  const unique = String(seed).padStart(2, '0');
  switch (dataType) {
    case 'boolean':
      return 'false';
    case 'bigint':
    case 'double precision':
    case 'integer':
    case 'numeric':
    case 'smallint':
      return '1';
    case 'character varying':
    case 'text':
      return `'control-${unique}'`;
    case 'date':
      return 'current_date';
    case 'time without time zone':
      return `'00:00:00'::time`;
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      return 'now()';
    case 'uuid':
      return `'000000${unique}-0000-4000-8000-000000000000'::uuid`;
    default:
      throw new Error(`unhandled physical column type ${dataType}`);
  }
}

async function setTrustedScope(
  client: pg.PoolClient,
  runtime: ComposedApplicationRuntime,
): Promise<void> {
  await client.query(
    `SELECT set_config('north_star.tenant_id', $1, true),
            set_config('north_star.environment_id', $2, true)`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
}

async function assertRefusedByRowLevelSecurity(
  attempt: Promise<unknown>,
  message: string,
): Promise<void> {
  await assert.rejects(
    attempt,
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === '42501' &&
      /row-level security policy/u.test(error.message),
    message,
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

async function assertConstrainedDomainVerificationCompleted(
  pool: pg.Pool,
  connection: pg.PoolConfig,
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
): Promise<void> {
  const compiled =
    parseCompiledApplication(compiledApplication).application.compiled;
  const storage = storageTarget(compiled);
  const entity = storage.entities.find(
    (candidate) => candidate.legalEntityMaster !== undefined,
  );
  assert.ok(entity?.legalEntityMaster);
  const constrainedColumn = entity.columns.find(
    (column) =>
      column.physicalName === entity.legalEntityMaster?.fieldColumns.isDefault,
  );
  assert.ok(constrainedColumn);
  const scenario = releaseVerificationBinding(compiled).plan.scenarios.find(
    (candidate) =>
      candidate.kind === 'searchableExclusion' &&
      candidate.entityId === entity.entityId &&
      candidate.subjectId === constrainedColumn.canonicalFieldId,
  );
  assert.ok(
    scenario,
    'the compiled plan contains the partial-unique boolean exclusion probe',
  );
  const constructibilityFindings =
    releaseVerificationBinding(compiled).findings;
  const operations = projectionPayload<{
    operations: readonly {
      effect: { entity: { targetId: string }; kind: string };
      inputContract: {
        fields: readonly {
          fieldId: string;
          fieldKind: string;
          writable: boolean;
        }[];
      };
      operationId: string;
    }[];
  }>(compiled, PROJECTION_FAMILY_IDS.operationCatalog).operations;
  const queries = projectionPayload<{
    queries: readonly {
      queryType: string;
      selections: readonly { fieldId: string }[];
      sourceEntityId: string;
    }[];
  }>(compiled, PROJECTION_FAMILY_IDS.queryCatalog).queries;
  const createOperations = new Map(
    operations
      .filter((operation) => operation.effect.kind === 'createRecordEffect')
      .map((operation) => [operation.effect.entity.targetId, operation]),
  );
  const excludedFields = new Map<string, Set<string>>();
  for (const excludedScenario of releaseVerificationBinding(compiled).plan
    .scenarios) {
    if (excludedScenario.kind !== 'searchableExclusion') continue;
    const fields = excludedFields.get(excludedScenario.entityId) ?? new Set();
    fields.add(excludedScenario.subjectId);
    excludedFields.set(excludedScenario.entityId, fields);
  }
  const searchQueries = queries.filter((query) => query.queryType === 'search');
  assert.ok(
    searchQueries.some((query) => !createOperations.has(query.sourceEntityId)),
    'the compiled product includes an append-only searchable source without a generic create operation',
  );
  assert.ok(
    constructibilityFindings.some(
      (finding) =>
        finding.code === 'VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE' &&
        finding.operationId ===
          'northstar.app:operation.inventory_transaction_create' &&
        finding.requiredStorageColumn === 'legal_entity_id' &&
        finding.message ===
          'verification could not construct inputs for operation northstar.app:operation.inventory_transaction_create because required storage column legal_entity_id has no declared input',
    ),
    'the unconstructable entity-owned create operation surfaces an exact finding',
  );
  const unconstructableOperationIds = new Set(
    constructibilityFindings.map((finding) => finding.operationId),
  );
  const constructiblePositiveCandidate = searchQueries
    .flatMap((query) => {
      const createOperation = createOperations.get(query.sourceEntityId);
      if (
        !createOperation ||
        unconstructableOperationIds.has(createOperation.operationId)
      ) {
        return [];
      }
      return query.selections.map((selection) => ({
        entityId: query.sourceEntityId,
        field: createOperation.inputContract.fields.find(
          (field) =>
            field.fieldId === selection.fieldId &&
            field.fieldKind === 'textFieldType' &&
            !excludedFields.get(query.sourceEntityId)?.has(field.fieldId),
        ),
      }));
    })
    .find((candidate) => candidate.field);
  assert.ok(
    constructiblePositiveCandidate?.field,
    'the compiled product retains a constructible searchable source for the positive witness',
  );
  for (const identifier of [
    entity.physicalTableName,
    entity.archive.archivedAtColumn,
    constrainedColumn.physicalName,
  ]) {
    assert.match(identifier, /^[a-z][a-z0-9_]{0,62}$/u);
  }
  const rows = await pool.query<{
    active_constrained_rows: string;
    archived_unconstrained_probes: string;
  }>(
    `SELECT count(*) FILTER (
              WHERE ${constrainedColumn.physicalName} IS TRUE
                AND ${entity.archive.archivedAtColumn} IS NULL
            )::text AS active_constrained_rows,
            count(*) FILTER (
              WHERE ${constrainedColumn.physicalName} IS FALSE
                AND ${entity.archive.archivedAtColumn} IS NOT NULL
            )::text AS archived_unconstrained_probes
       FROM north_star_module.${entity.physicalTableName}
      WHERE tenant_id = $1 AND environment_id = $2`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  assert.equal(
    rows.rows[0]?.active_constrained_rows,
    '1',
    'the legitimate seeded member remains the only active row inside the partial-unique predicate',
  );
  assert.ok(
    Number(rows.rows[0]?.archived_unconstrained_probes) > 0,
    'semantic verification generated and archived a boolean probe outside the partial-unique predicate',
  );
  const result = await pool.query<{ positive_probe_digest: string }>(
    `SELECT result.positive_probe_digest
       FROM platform.tenant_release_admissions AS admission
       JOIN platform.release_verification_results AS result
         ON result.tenant_id = admission.tenant_id
        AND result.environment_id = admission.environment_id
        AND result.verification_evidence_id = admission.verification_evidence_id
      WHERE admission.tenant_id = $1
        AND admission.environment_id = $2
        AND admission.release_id = $3
        AND result.scenario_id = $4`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      runtime.activeReleaseId,
      scenario.scenarioId,
    ],
  );
  const expectedPositiveProbeDigest = createHash('sha256')
    .update('northstar.verification-proof/v1', 'utf8')
    .update(Uint8Array.of(0))
    .update(
      canonicalize({
        constructibilityFindings,
        searchWitness: {
          entityId: constructiblePositiveCandidate.entityId,
          fieldId: constructiblePositiveCandidate.field.fieldId,
          recordObserved: true,
        },
      }),
      'utf8',
    )
    .digest('hex');
  assert.equal(
    result.rows[0]?.positive_probe_digest,
    expectedPositiveProbeDigest,
    'the executed searchable-exclusion proof binds every constructibility finding rather than silently skipping an unconstructable operation',
  );
  const admission = await pool.query<{ verification_evidence_id: string }>(
    `SELECT verification_evidence_id
       FROM platform.tenant_release_admissions
      WHERE tenant_id = $1 AND environment_id = $2 AND release_id = $3`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      runtime.activeReleaseId,
    ],
  );
  const evidenceId = admission.rows[0]?.verification_evidence_id;
  assert.ok(evidenceId);
  const context = await new AuthenticatedRequestEntryAdapter(
    async () => runtime.identity,
  ).enter({});
  // The durable reader runs inside a trusted request transaction, which refuses
  // any login role other than the unprivileged runtime role.
  const runtimePool = new pg.Pool({
    ...connection,
    max: 2,
    user: 'north_star_runtime',
  });
  runtimePool.on('error', () => undefined);
  let evidence: DurableReleaseVerificationEvidence | null;
  try {
    evidence = await new PostgresReleaseVerificationService(runtimePool).read(
      context,
      evidenceId as MintedUuid,
      compiled,
    );
  } finally {
    await runtimePool.end();
  }
  assert.deepEqual(
    evidence?.findings,
    constructibilityFindings,
    'durable verification evidence reports every witness-selection constructibility finding',
  );
  assert.ok(evidence);
  await assertExactPartitionEvidence(pool, runtime, evidenceId, evidence, {
    compiled,
    plan: releaseVerificationBinding(compiled).plan,
  });
}

/**
 * ADR-0033: the admitted composed product records an exact partition of the
 * compiler-emitted plan. Executed results and derivations are separate durable
 * counters, and their union is complete and disjoint.
 */
async function assertExactPartitionEvidence(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  evidenceId: string,
  evidence: DurableReleaseVerificationEvidence,
  binding: Readonly<{
    compiled: CompileSuccess;
    plan: VerificationPlanPayloadV1;
  }>,
): Promise<void> {
  assert.equal(evidence.schemaVersion, 'northstar.verification-result-set/v2');
  assert.ok(
    'derivations' in evidence,
    'admitted composed evidence carries a derivation array',
  );
  const derivations = evidence.derivations;
  const executedScenarioIds = evidence.results.map(
    (result) => result.scenarioId,
  );
  const derivedScenarioIds = derivations.map(
    (derivation) => derivation.scenarioId,
  );
  assert.ok(evidence.results.length > 0, 'real PostgreSQL probes still ran');
  assert.ok(derivations.length > 0);
  assert.deepEqual(
    [...executedScenarioIds, ...derivedScenarioIds].toSorted(),
    binding.plan.scenarios.map((scenario) => scenario.scenarioId).toSorted(),
    'executed results and derivations partition the emitted plan exactly',
  );
  assert.equal(
    new Set([...executedScenarioIds, ...derivedScenarioIds]).size,
    binding.plan.scenarios.length,
    'no scenario is both executed and derived',
  );
  assertIndependentConstructibilityPartition(
    binding.compiled,
    binding.plan,
    evidence,
  );
  const constructibleResult = evidence.results[0];
  const derivationTemplate = derivations[0];
  assert.ok(constructibleResult);
  assert.ok(derivationTemplate);
  const constructibleScenario = binding.plan.scenarios.find(
    (scenario) => scenario.scenarioId === constructibleResult.scenarioId,
  );
  assert.ok(constructibleScenario);
  const mislabelledPartition = {
    derivations: [
      ...derivations,
      {
        reason: {
          code: 'VERIFICATION_NO_GENERIC_CREATE_OPERATION' as const,
          entityId: constructibleScenario.entityId,
          message: 'well-formed but false no-create derivation',
        },
        scenarioFingerprint: constructibleScenario.scenarioFingerprint,
        scenarioId: constructibleScenario.scenarioId,
        schemaVersion: derivationTemplate.schemaVersion,
      },
    ],
    results: evidence.results.filter(
      (result) => result.scenarioId !== constructibleScenario.scenarioId,
    ),
  };
  assert.throws(
    () =>
      assertIndependentConstructibilityPartition(
        binding.compiled,
        binding.plan,
        mislabelledPartition,
      ),
    new RegExp(
      `constructible scenario ${constructibleScenario.scenarioId} was recorded as derived`,
      'u',
    ),
    'the independent oracle rejects a structurally valid derivation that mislabels a constructible scenario',
  );
  assert.ok(
    derivations.some(
      (derivation) =>
        derivation.reason.code ===
          'VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE' &&
        derivation.reason.entityId ===
          'northstar.app:entity.inventory_transaction' &&
        derivation.reason.requiredStorageColumn === 'legal_entity_id',
    ),
    'the compiler-derived legal-entity column is recorded as an unconstructable-input derivation, not as a passing probe',
  );
  assert.ok(
    derivations.some(
      (derivation) =>
        derivation.reason.code === 'VERIFICATION_NO_GENERIC_CREATE_OPERATION' &&
        derivation.reason.entityId ===
          'northstar.app:entity.inventory_movement',
    ),
    'the append-only fact without a generic create operation is recorded as a derivation',
  );
  const header = await pool.query<{
    closed_document: boolean;
    derived_count: number;
    evidence_version: string;
    execution_scope: string;
    impact_analysis_version: string;
    result_count: number;
    skipped_scenario_ids: unknown;
    stored_results: string;
  }>(
    `SELECT evidence.evidence_version,
            evidence.execution_scope,
            evidence.skipped_scenario_ids,
            evidence.result_count,
            evidence.impact_analysis_derivation ->> 'schemaVersion'
              AS impact_analysis_version,
            jsonb_array_length(
              evidence.impact_analysis_derivation -> 'derivations'
            ) AS derived_count,
            evidence.impact_analysis_derivation
              - 'schemaVersion' - 'derivations' = '{}'::jsonb
              AS closed_document,
            (
              SELECT count(*)::text
                FROM platform.release_verification_results AS stored
               WHERE stored.tenant_id = evidence.tenant_id
                 AND stored.environment_id = evidence.environment_id
                 AND stored.verification_evidence_id =
                     evidence.verification_evidence_id
            ) AS stored_results
       FROM platform.release_verification_evidence AS evidence
      WHERE evidence.tenant_id = $1
        AND evidence.environment_id = $2
        AND evidence.verification_evidence_id = $3`,
    [runtime.identity.tenantId, runtime.identity.environmentId, evidenceId],
  );
  assert.deepEqual(header.rows[0], {
    closed_document: true,
    derived_count: derivations.length,
    evidence_version: 'northstar.verification-result-set/v2',
    execution_scope: 'EXACT_PARTITION',
    impact_analysis_version: 'northstar.verification-impact-analysis/v1',
    result_count: evidence.results.length,
    skipped_scenario_ids: [],
    stored_results: String(evidence.results.length),
  });
  assert.notEqual(
    header.rows[0]?.result_count,
    header.rows[0]?.derived_count,
    'the executed counter and the derivation count are separate durable facts',
  );
}

interface ConstructibilityPartition {
  readonly derivations?: readonly {
    readonly reason: {
      readonly code: string;
      readonly entityId: string;
      readonly operationId?: string;
      readonly requiredStorageColumn?: string;
    };
    readonly scenarioId: string;
  }[];
  readonly results: readonly { readonly scenarioId: string }[];
}

type IndependentUnconstructibleReason =
  | Readonly<{ kind: 'noCreateOperation' }>
  | Readonly<{
      kind: 'unconstructableInput';
      missingStorageColumns: ReadonlySet<string>;
      operationId: string;
    }>;

/**
 * Test-owned oracle for ADR-0020 derivations. It deliberately recomputes from
 * storage and operation contracts instead of calling the provider's findings
 * or scenario deriver, so the producer cannot certify its own exclusions.
 */
function assertIndependentConstructibilityPartition(
  compiled: CompileSuccess,
  plan: VerificationPlanPayloadV1,
  partition: ConstructibilityPartition,
): void {
  const storage = storageTarget(compiled);
  const operations = projectionPayload<{
    readonly operations: readonly {
      readonly effect: {
        readonly entity: { readonly targetId: string };
        readonly kind: string;
      };
      readonly inputContract: {
        readonly fields: readonly { readonly fieldId: string }[];
        readonly relationInputs: readonly {
          readonly relationId: string;
        }[];
      };
      readonly operationId: string;
    }[];
  }>(compiled, PROJECTION_FAMILY_IDS.operationCatalog).operations;
  const createOperations = new Map(
    operations
      .filter((operation) => operation.effect.kind === 'createRecordEffect')
      .map((operation) => [operation.effect.entity.targetId, operation]),
  );
  const unconstructibleByEntity = new Map<
    string,
    IndependentUnconstructibleReason
  >();
  for (const entity of storage.entities) {
    const createOperation = createOperations.get(entity.entityId);
    if (!createOperation) {
      unconstructibleByEntity.set(entity.entityId, {
        kind: 'noCreateOperation',
      });
      continue;
    }
    const constructibleColumns = new Set<string>();
    for (const field of createOperation.inputContract.fields) {
      const column = entity.columns.find(
        (candidate) => candidate.canonicalFieldId === field.fieldId,
      );
      if (column) constructibleColumns.add(column.physicalName);
    }
    for (const relationInput of createOperation.inputContract.relationInputs) {
      const relation = storage.relations.find(
        (candidate) =>
          candidate.sourceEntityId === entity.entityId &&
          candidate.relationId === relationInput.relationId,
      );
      if (relation) {
        constructibleColumns.add(relation.relationColumn.physicalName);
      }
    }
    const requiredColumns = new Set(
      entity.columns
        .filter(
          (column) => !column.nullable && column.defaultSemantics === 'none',
        )
        .map((column) => column.physicalName),
    );
    for (const relation of storage.relations) {
      if (
        relation.sourceEntityId === entity.entityId &&
        !relation.relationColumn.nullable
      ) {
        requiredColumns.add(relation.relationColumn.physicalName);
      }
    }
    if (entity.legalEntity) requiredColumns.add(entity.legalEntity.column);
    const missingStorageColumns = new Set(
      [...requiredColumns].filter(
        (column) => !constructibleColumns.has(column),
      ),
    );
    if (missingStorageColumns.size > 0) {
      unconstructibleByEntity.set(entity.entityId, {
        kind: 'unconstructableInput',
        missingStorageColumns,
        operationId: createOperation.operationId,
      });
    }
  }

  const resultById = new Map(
    partition.results.map((result) => [result.scenarioId, result]),
  );
  const derivationById = new Map(
    (partition.derivations ?? []).map((derivation) => [
      derivation.scenarioId,
      derivation,
    ]),
  );
  const expectedDerivedScenarioIds: string[] = [];
  const expectedExecutedScenarioIds: string[] = [];
  for (const scenario of plan.scenarios) {
    const reason = unconstructibleByEntity.get(scenario.entityId);
    const result = resultById.get(scenario.scenarioId);
    const derivation = derivationById.get(scenario.scenarioId);
    if (!reason) {
      assert.equal(
        derivation,
        undefined,
        `constructible scenario ${scenario.scenarioId} was recorded as derived`,
      );
      assert.ok(
        result,
        `constructible scenario ${scenario.scenarioId} was not executed`,
      );
      expectedExecutedScenarioIds.push(scenario.scenarioId);
      continue;
    }
    assert.equal(
      result,
      undefined,
      `underivable scenario ${scenario.scenarioId} was reported as executed`,
    );
    assert.ok(
      derivation,
      `underivable scenario ${scenario.scenarioId} has no derivation`,
    );
    assert.equal(derivation.reason.entityId, scenario.entityId);
    if (reason.kind === 'noCreateOperation') {
      assert.equal(
        derivation.reason.code,
        'VERIFICATION_NO_GENERIC_CREATE_OPERATION',
      );
    } else {
      assert.equal(
        derivation.reason.code,
        'VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE',
      );
      assert.equal(derivation.reason.operationId, reason.operationId);
      assert.ok(
        derivation.reason.requiredStorageColumn !== undefined &&
          reason.missingStorageColumns.has(
            derivation.reason.requiredStorageColumn,
          ),
        `derivation for ${scenario.scenarioId} does not name an independently missing storage column`,
      );
    }
    expectedDerivedScenarioIds.push(scenario.scenarioId);
  }
  assert.deepEqual(
    [...derivationById.keys()].toSorted(),
    expectedDerivedScenarioIds.toSorted(),
    'every and only independently underivable scenarios are derived',
  );
  assert.deepEqual(
    [...resultById.keys()].toSorted(),
    expectedExecutedScenarioIds.toSorted(),
    'every and only independently constructible scenarios execute',
  );
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
    inventoryScopeProvisioning: COMPOSED_APPLICATION_INVENTORY_SCOPE,
    migrationsDirectory,
    providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
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
