import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  canonicalize,
  canonicalizeAndHash,
  parseNormalizedApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import {
  HASH_ALGORITHM,
  HASH_DOMAINS,
  PROJECTION_FAMILY_IDS,
  VERIFICATION_PLAN_PAYLOAD_VERSION,
  VERIFICATION_SCENARIO_VERSION,
  compileApplication,
  executeVerificationPlan,
  validateExecutedVerificationPlan,
  type CompileSuccess,
  type ContentAddressedArtifact,
  type ProjectionManifestEnvelope,
  type ProjectionReference,
  type VerificationPlanPayloadV1,
} from '../../packages/compiler/src/index.js';
import type {
  PartitionedVerificationResultSet,
  VerificationExecutionCommand,
} from '../../packages/compiler/src/verification.js';
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  ReleaseActivationAttemptIdentity,
  ReleaseApprovalIdentity,
  StoreAppPackageRevisionCommand,
  VerificationEvidenceIdentity,
} from '../../packages/platform-runtime/src/index.js';
import {
  PostgresImmutableReleaseRepository,
  ReleasePersistenceIdentityError,
  ReleasePersistenceIntegrityError,
} from '../../packages/postgres-provider/src/release-repository.js';
import {
  PostgresReleaseVerificationService,
  ReleaseVerificationIntegrityError,
  verificationEvidenceIdForCandidate,
} from '../../packages/postgres-provider/src/release-verification-service.js';
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
const environmentAPreview = 'a2000000-0000-4000-8000-000000000002';
const environmentB = 'b1000000-0000-4000-8000-000000000001';
const principalA = 'aa000000-0000-4000-8000-000000000001';
const principalB = 'bb000000-0000-4000-8000-000000000001';

const revisionA = minted('a3000000-0000-4000-8000-000000000003');
const revisionB = minted('b3000000-0000-4000-8000-000000000003');
const verticalRevisionA = minted('a3000000-0000-4000-8000-000000000004');
const releaseA = minted('a4000000-0000-4000-8000-000000000004');
const releaseB = minted('b4000000-0000-4000-8000-000000000004');
const verticalReleaseA = minted('a4000000-0000-4000-8000-000000000005');
const identities = new Map<string, AuthenticatedIdentity>([
  [
    'session-a',
    {
      environmentId: environmentA,
      principalId: principalA,
      tenantId: tenantA,
    },
  ],
  [
    'session-a-preview',
    {
      environmentId: environmentAPreview,
      principalId: principalA,
      tenantId: tenantA,
    },
  ],
  [
    'session-b',
    {
      environmentId: environmentB,
      principalId: principalB,
      tenantId: tenantB,
    },
  ],
]);

test('verification results admit an exact executed-and-derived partition while full execution stays v1', async () => {
  const plan = partitionVerificationPlan();
  const command = partitionVerificationCommand();
  const executedScenarioIds: string[] = [];
  const partitioned = await executeVerificationPlan(
    plan,
    command,
    (scenario) => {
      executedScenarioIds.push(scenario.scenarioId);
      return {
        negativeProbe: { observed: 'negative' },
        positiveProbe: { observed: 'positive' },
      };
    },
    (scenario) => {
      if (scenario.entityId === 'fixture:entity.fact') {
        return {
          code: 'VERIFICATION_NO_GENERIC_CREATE_OPERATION' as const,
          entityId: scenario.entityId,
          message: 'append-only fact has no generic create operation',
        };
      }
      if (scenario.entityId === 'fixture:entity.transaction') {
        return {
          code: 'VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE' as const,
          entityId: scenario.entityId,
          message:
            'create input cannot construct required storage column legal_entity_id',
          operationId: 'fixture:operation.transaction_create',
          requiredStorageColumn: 'legal_entity_id',
        };
      }
      return null;
    },
  );

  assert.deepEqual(executedScenarioIds, [
    'fixture:verification-scenario.executable',
  ]);
  assert.equal(partitioned.results.length, 1);
  assert.equal(partitioned.derivations.length, 2);
  assert.equal(
    partitioned.results.length + partitioned.derivations.length,
    plan.scenarios.length,
  );
  assert.deepEqual(
    partitioned.derivations.map((derivation) => derivation.reason),
    [
      {
        code: 'VERIFICATION_NO_GENERIC_CREATE_OPERATION',
        entityId: 'fixture:entity.fact',
        message: 'append-only fact has no generic create operation',
      },
      {
        code: 'VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE',
        entityId: 'fixture:entity.transaction',
        message:
          'create input cannot construct required storage column legal_entity_id',
        operationId: 'fixture:operation.transaction_create',
        requiredStorageColumn: 'legal_entity_id',
      },
    ],
  );
  assert.deepEqual(validateExecutedVerificationPlan(plan, partitioned), {
    diagnostics: [],
    status: 'passed',
  });

  const full = await executeVerificationPlan(plan, command, (scenario) => ({
    negativeProbe: { observed: 'negative', scenarioId: scenario.scenarioId },
    positiveProbe: { observed: 'positive', scenarioId: scenario.scenarioId },
  }));
  assert.equal(full.schemaVersion, 'northstar.verification-result-set/v1');
  assert.equal(Object.hasOwn(full, 'derivations'), false);
  assert.deepEqual(validateExecutedVerificationPlan(plan, full), {
    diagnostics: [],
    status: 'passed',
  });

  const missing = resignPartitionedResultSet({
    ...partitioned,
    derivations: partitioned.derivations.slice(1),
  });
  assert.deepEqual(validateExecutedVerificationPlan(plan, missing), {
    diagnostics: [
      {
        code: 'VERIFICATION_SCENARIO_DISPOSITION_MISSING',
        scenarioId: 'fixture:verification-scenario.fact',
      },
    ],
    status: 'failed',
  });

  const factResult = full.results.find(
    (result) => result.scenarioId === 'fixture:verification-scenario.fact',
  );
  assert.ok(factResult);
  const overlap = resignPartitionedResultSet({
    ...partitioned,
    results: [...partitioned.results, factResult].toSorted((left, right) =>
      left.scenarioId.localeCompare(right.scenarioId),
    ),
  });
  assert.deepEqual(validateExecutedVerificationPlan(plan, overlap), {
    diagnostics: [
      {
        code: 'VERIFICATION_SCENARIO_DISPOSITION_OVERLAP',
        scenarioId: 'fixture:verification-scenario.fact',
      },
    ],
    status: 'failed',
  });

  const unreasoned = resignPartitionedResultSet({
    ...partitioned,
    derivations: partitioned.derivations.map((derivation) =>
      derivation.reason.code === 'VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE'
        ? {
            ...derivation,
            reason: {
              ...derivation.reason,
              requiredStorageColumn: '',
            },
          }
        : derivation,
    ),
  });
  assert.deepEqual(validateExecutedVerificationPlan(plan, unreasoned), {
    diagnostics: [
      {
        code: 'VERIFICATION_DERIVATION_INVALID',
        scenarioId: 'fixture:verification-scenario.transaction',
      },
    ],
    status: 'failed',
  });
});

for (const forbidden of [
  {
    key: 'skipVerification',
    label: 'skip flag',
    value: true,
  },
  {
    key: 'sampleSize',
    label: 'sampling parameter',
    value: 1,
  },
  {
    key: 'timeBoxMs',
    label: 'time-box parameter',
    value: 1,
  },
] as const) {
  test(`verification execution rejects a ${forbidden.label} before any scenario runs`, async () => {
    const plan = partitionVerificationPlan();
    let executionCount = 0;
    await assert.rejects(
      executeVerificationPlan(
        plan,
        {
          ...partitionVerificationCommand(),
          [forbidden.key]: forbidden.value,
        } as VerificationExecutionCommand,
        () => {
          executionCount += 1;
          return { positiveProbe: true };
        },
      ),
      /verification execution command is closed/,
    );
    assert.equal(executionCount, 0);
  });
}

test('migration 0019 durably admits full execution and exact executed-derived evidence only', async () => {
  await withEphemeralPostgres(
    'release-verification-derived-evidence',
    async ({ pool }) => {
      const admin = await pool.connect();
      try {
        await runMigrations(admin, await loadMigrations(checkedInMigrations));
        await seedTenants(admin);
        const insertEvidence = (
          evidenceId: string,
          evidenceVersion: string,
          executionScope: string,
          skippedScenarioIds: readonly string[],
          impactAnalysisDerivation: unknown,
        ) =>
          admin.query(
            `INSERT INTO platform.release_verification_evidence (
               tenant_id, environment_id, verification_evidence_id,
               evidence_version, release_root, artifact_closure_digest,
               verification_plan_artifact_root,
               verification_plan_semantic_digest, verification_plan_digest,
               result_set_digest, result_count, provider, provider_run_id,
               executed_tenant_id, executed_environment_id,
               executed_evidence_id, execution_scope,
               skipped_scenario_ids, impact_analysis_derivation, created_by
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'realPostgresql',$11,
               $1,$2,$3,$12,$13::jsonb,$14::jsonb,$15
             )`,
            [
              tenantA,
              environmentA,
              evidenceId,
              evidenceVersion,
              'a'.repeat(64),
              'b'.repeat(64),
              'c'.repeat(64),
              'd'.repeat(64),
              'e'.repeat(64),
              'f'.repeat(64),
              `postgres-verification:${evidenceId}`,
              executionScope,
              JSON.stringify(skippedScenarioIds),
              impactAnalysisDerivation === null
                ? null
                : JSON.stringify(impactAnalysisDerivation),
              principalA,
            ],
          );

        const fullEvidenceId = 'a5000000-0000-4000-8000-000000000091';
        await insertEvidence(
          fullEvidenceId,
          'northstar.verification-result-set/v1',
          'FULL',
          [],
          null,
        );

        const derivedEvidenceId = 'a5000000-0000-4000-8000-000000000092';
        const impactAnalysisDerivation = {
          derivations: [
            {
              reason: {
                code: 'VERIFICATION_NO_GENERIC_CREATE_OPERATION',
                entityId: 'northstar.inventory:entity.inventory_movement',
                message: 'append-only fact has no generic create operation',
              },
              scenarioFingerprint: '1'.repeat(64),
              scenarioId: 'northstar.inventory:verification-scenario.fixture',
              schemaVersion: 'northstar.verification-derivation/v1',
            },
          ],
          schemaVersion: 'northstar.verification-impact-analysis/v1',
        };
        await insertEvidence(
          derivedEvidenceId,
          'northstar.verification-result-set/v2',
          'EXACT_PARTITION',
          [],
          impactAnalysisDerivation,
        );

        const stored = await admin.query<{
          derived_count: number;
          evidence_version: string;
          execution_scope: string;
          skipped_scenario_ids: unknown;
        }>(
          `SELECT evidence_version, execution_scope, skipped_scenario_ids,
                  jsonb_array_length(
                    impact_analysis_derivation -> 'derivations'
                  ) AS derived_count
             FROM platform.release_verification_evidence
            WHERE verification_evidence_id = $1`,
          [derivedEvidenceId],
        );
        assert.deepEqual(stored.rows[0], {
          derived_count: 1,
          evidence_version: 'northstar.verification-result-set/v2',
          execution_scope: 'EXACT_PARTITION',
          skipped_scenario_ids: [],
        });

        await assert.rejects(
          insertEvidence(
            'a5000000-0000-4000-8000-000000000093',
            'northstar.verification-result-set/v2',
            'EXACT_PARTITION',
            [],
            { ...impactAnalysisDerivation, derivations: [] },
          ),
          (error: unknown) =>
            error instanceof Error &&
            (error as Error & { code?: string }).code === '23514' &&
            /release_verification_evidence_exact_partition/u.test(
              error.message,
            ),
        );
        await assert.rejects(
          insertEvidence(
            'a5000000-0000-4000-8000-000000000094',
            'northstar.verification-result-set/v2',
            'EXACT_PARTITION',
            ['northstar.inventory:verification-scenario.silently-skipped'],
            impactAnalysisDerivation,
          ),
          (error: unknown) =>
            error instanceof Error &&
            (error as Error & { code?: string }).code === '23514' &&
            /release_verification_evidence_exact_partition/u.test(
              error.message,
            ),
        );
      } finally {
        admin.release();
      }
    },
  );
});

test('release admission rejects a staged candidate with missing executed results', async () => {
  const bootstrapBytes = fixtureBytes('bootstrap');
  const bootstrap = mustCompile(bootstrapBytes);

  await withEphemeralPostgres(
    'release-verification-missing-results-red',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        await runMigrations(admin, await loadMigrations(checkedInMigrations));
        await seedTenants(admin);
      } finally {
        admin.release();
      }

      const runtimePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_runtime',
      });
      try {
        const repository = new PostgresImmutableReleaseRepository(runtimePool);
        const context = await contextFor(requestEntry(), 'session-a');
        const revisionId = minted('a3000000-0000-4000-8000-000000000097');
        const releaseId = minted('a4000000-0000-4000-8000-000000000097');
        await repository.storeAppPackageRevision(
          context,
          revisionCommand(context, revisionId, bootstrapBytes),
        );
        const staged = await repository.stageTenantReleaseCandidate(context, {
          appPackageRevisionId: revisionId,
          compiledRelease: bootstrap,
          createdBy: context.principalId,
          environmentId: context.environmentId,
          releaseId,
          tenantId: context.tenantId,
        });

        await assert.rejects(
          repository.registerTenantRelease(
            context,
            releaseCommand(
              context,
              releaseId,
              revisionId,
              staged.verificationEvidenceId,
              bootstrap,
            ),
          ),
          (error: unknown) => {
            assert.ok(error instanceof ReleasePersistenceIntegrityError);
            assert.equal(error.code, 'VERIFICATION_EVIDENCE_NOT_FOUND');
            return true;
          },
        );

        const verification = new PostgresReleaseVerificationService(
          runtimePool,
        );
        assert.equal(
          (
            verification as unknown as {
              executeAndPersist?: unknown;
            }
          ).executeAndPersist,
          undefined,
          'raw callback persistence is not a public runtime surface',
        );
        const exactCommand = {
          compiledRelease: bootstrap,
          evidenceId: staged.verificationEvidenceId,
          releaseId,
        };
        const callerLabeledCommand = {
          ...exactCommand,
          providerRunId: 'caller-invented-run',
        };
        await assert.rejects(
          verification.executeSemanticCandidateAndPersist(
            context,
            callerLabeledCommand,
          ),
          /command is closed/,
        );
        await assert.rejects(
          verification.executeSemanticCandidateAndPersist(context, {
            ...exactCommand,
            compiledRelease:
              doctoredRuntimeProjectionWithoutChangingContentAddress(bootstrap),
          }),
          (error: unknown) => {
            assert.ok(error instanceof ReleaseVerificationIntegrityError);
            assert.equal(
              error.code,
              'VERIFICATION_CANDIDATE_ARTIFACT_MISMATCH',
            );
            return true;
          },
        );
        const transient =
          await verification.executeSemanticCandidateWithExecutor(
            context,
            exactCommand,
            {} as Parameters<
              typeof verification.executeSemanticCandidateWithExecutor
            >[2],
          );
        assert.equal(transient.results.length, 0);
        const persisted = await pool.query<{
          admissions: string;
          evidence: string;
        }>(
          `SELECT
             (SELECT count(*) FROM platform.release_verification_evidence)::text
               AS evidence,
             (SELECT count(*) FROM platform.tenant_release_admissions)::text
               AS admissions`,
        );
        assert.deepEqual(persisted.rows[0], {
          admissions: '0',
          evidence: '0',
        });
        await assert.rejects(
          repository.registerTenantRelease(
            context,
            releaseCommand(
              context,
              releaseId,
              revisionId,
              staged.verificationEvidenceId,
              bootstrap,
            ),
          ),
          (error: unknown) => {
            assert.ok(error instanceof ReleasePersistenceIntegrityError);
            assert.equal(error.code, 'VERIFICATION_EVIDENCE_NOT_FOUND');
            return true;
          },
        );
      } finally {
        await runtimePool.end();
      }
    },
  );
});

test('release admission rejects a fabricated verification evidence identity', async () => {
  const bootstrapBytes = fixtureBytes('bootstrap');
  const bootstrap = mustCompile(bootstrapBytes);

  await withEphemeralPostgres(
    'release-verification-fabricated-red',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        await runMigrations(admin, await loadMigrations(checkedInMigrations));
        await seedTenants(admin);
      } finally {
        admin.release();
      }

      const runtimePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_runtime',
      });
      try {
        const repository = new PostgresImmutableReleaseRepository(runtimePool);
        const context = await contextFor(requestEntry(), 'session-a');
        const revisionId = minted('a3000000-0000-4000-8000-000000000098');
        const releaseId = minted('a4000000-0000-4000-8000-000000000098');
        const fabricatedEvidenceId = minted(
          'a5000000-0000-4000-8000-000000000098',
        );
        await repository.storeAppPackageRevision(
          context,
          revisionCommand(context, revisionId, bootstrapBytes),
        );

        await assert.rejects(
          repository.registerTenantRelease(
            context,
            releaseCommand(
              context,
              releaseId,
              revisionId,
              fabricatedEvidenceId,
              bootstrap,
            ),
          ),
          (error: unknown) => {
            assert.ok(error instanceof ReleasePersistenceIntegrityError);
            assert.equal(error.code, 'VERIFICATION_EVIDENCE_NOT_FOUND');
            return true;
          },
        );
      } finally {
        await runtimePool.end();
      }
    },
  );
});

test('immutable release persistence verifies bytes, identities, links, RLS, and deduplication', async (t) => {
  const bootstrapBytes = fixtureBytes('bootstrap');
  const verticalBytes = emptyRevisionBytes(bootstrapBytes, '1.0.1');
  const bootstrap = mustCompile(bootstrapBytes);
  const vertical = mustCompile(verticalBytes);
  const evidenceA = verificationEvidenceIdForCandidate(
    { environmentId: environmentA, tenantId: tenantA },
    releaseA,
    bootstrap.releaseRoot,
  );
  const evidenceB = verificationEvidenceIdForCandidate(
    { environmentId: environmentB, tenantId: tenantB },
    releaseB,
    bootstrap.releaseRoot,
  );
  const verticalEvidenceA = verificationEvidenceIdForCandidate(
    { environmentId: environmentA, tenantId: tenantA },
    verticalReleaseA,
    vertical.releaseRoot,
  );

  await withEphemeralPostgres(
    'release-persistence',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        await runMigrations(admin, await loadMigrations(checkedInMigrations));
        await seedTenants(admin);
      } finally {
        admin.release();
      }

      const runtimePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_runtime',
      });
      try {
        const repository = new PostgresImmutableReleaseRepository(runtimePool);
        const entry = requestEntry();
        const contextA = await contextFor(entry, 'session-a');
        const contextAPreview = await contextFor(entry, 'session-a-preview');
        const contextB = await contextFor(entry, 'session-b');

        await t.test(
          'round trips bootstrap and vertical bytes exactly',
          async () => {
            await repository.storeAppPackageRevision(
              contextA,
              revisionCommand(contextA, revisionA, bootstrapBytes),
            );
            await repository.storeAppPackageRevision(
              contextB,
              revisionCommand(contextB, revisionB, bootstrapBytes),
            );
            await repository.storeAppPackageRevision(
              contextA,
              revisionCommand(contextA, verticalRevisionA, verticalBytes),
            );

            const storedA = await admitEmptyRelease(
              runtimePool,
              repository,
              contextA,
              releaseCommand(
                contextA,
                releaseA,
                revisionA,
                evidenceA,
                bootstrap,
              ),
            );
            const storedB = await admitEmptyRelease(
              runtimePool,
              repository,
              contextB,
              releaseCommand(
                contextB,
                releaseB,
                revisionB,
                evidenceB,
                bootstrap,
              ),
            );
            const storedVertical = await admitEmptyRelease(
              runtimePool,
              repository,
              contextA,
              releaseCommand(
                contextA,
                verticalReleaseA,
                verticalRevisionA,
                verticalEvidenceA,
                vertical,
              ),
            );

            assertReleaseBytes(storedA.artifacts, bootstrap);
            assertReleaseBytes(storedB.artifacts, bootstrap);
            assertReleaseBytes(storedVertical.artifacts, vertical);
            assert.equal(storedA.release.contentHash, bootstrap.releaseRoot);
            assert.equal(
              storedVertical.release.contentHash,
              vertical.releaseRoot,
            );
            assert.equal(
              storedA.release.compilerAttestationDigest,
              bootstrap.attestation.attestationDigest,
            );
            assert.deepEqual(
              [
                ...(await repository.getAppPackageRevision(
                  contextA,
                  revisionA,
                ))!.desiredState,
              ],
              [...bootstrapBytes],
            );
          },
        );

        await t.test(
          'two-tenant collision matrix mints identities and shares only policy-free blobs',
          async () => {
            assert.notEqual(revisionA, revisionB);
            assert.notEqual(releaseA, releaseB);
            assert.notEqual(evidenceA, evidenceB);
            assert.notEqual(releaseA, bootstrap.releaseRoot);
            assert.notEqual(releaseB, bootstrap.releaseRoot);
            assert.equal(releaseA.length, 36);
            assert.equal(bootstrap.releaseRoot.length, 64);

            const approvalA: ReleaseApprovalIdentity = {
              approvalId: minted('a6000000-0000-4000-8000-000000000006'),
              environmentId: environmentA,
              releaseId: releaseA,
              tenantId: tenantA,
              verificationEvidenceId: evidenceA,
            };
            const approvalB: ReleaseApprovalIdentity = {
              approvalId: minted('b6000000-0000-4000-8000-000000000006'),
              environmentId: environmentB,
              releaseId: releaseB,
              tenantId: tenantB,
              verificationEvidenceId: evidenceB,
            };
            const attemptA: ReleaseActivationAttemptIdentity = {
              activationAttemptId: minted(
                'a7000000-0000-4000-8000-000000000007',
              ),
              approvalId: approvalA.approvalId,
              environmentId: environmentA,
              tenantId: tenantA,
            };
            const verificationA: VerificationEvidenceIdentity = {
              environmentId: environmentA,
              releaseId: releaseA,
              tenantId: tenantA,
              verificationEvidenceId: evidenceA,
            };
            assert.notEqual(approvalA.approvalId, approvalB.approvalId);
            assert.notEqual(attemptA.activationAttemptId, approvalA.approvalId);
            assert.equal(verificationA.verificationEvidenceId, evidenceA);

            await assert.rejects(
              repository.storeAppPackageRevision(
                contextB,
                revisionCommand(contextB, revisionA, bootstrapBytes),
              ),
              /duplicate key/,
            );
            await assert.rejects(
              repository.registerTenantRelease(
                contextB,
                releaseCommand(
                  contextB,
                  releaseA,
                  revisionB,
                  minted('b5000000-0000-4000-8000-000000000099'),
                  bootstrap,
                ),
              ),
              /duplicate key/,
            );

            const admin = await pool.connect();
            try {
              const physical = await admin.query<{ count: string }>(
                'SELECT count(*) FROM platform.release_artifact_blobs',
              );
              const expected = new Set(
                [
                  ...bootstrap.bundle.artifacts,
                  ...vertical.bundle.artifacts,
                ].map((artifact) => artifact.contentHash),
              );
              assert.equal(physical.rows[0]?.count, String(expected.size));
              const tenantColumns = await admin.query<{ count: string }>(`
              SELECT count(*)
                FROM information_schema.columns
               WHERE table_schema = 'platform'
                 AND table_name = 'release_artifact_blobs'
                 AND column_name IN (
                   'tenant_id',
                   'environment_id',
                   'principal_id',
                   'coordinator_id'
                 )
            `);
              assert.equal(tenantColumns.rows[0]?.count, '0');
            } finally {
              admin.release();
            }
          },
        );

        await t.test(
          'tenant and environment reads fail closed on one reused connection',
          async () => {
            assert.equal(
              await repository.getAppPackageRevision(contextA, revisionB),
              null,
            );
            assert.equal(
              await repository.getTenantRelease(contextA, releaseB),
              null,
            );
            assert.equal(
              await repository.getTenantRelease(contextB, releaseA),
              null,
            );
            assert.equal(
              await repository.getTenantRelease(contextAPreview, releaseA),
              null,
            );

            const backendA = await backendPid(runtimePool, contextA);
            const backendB = await backendPid(runtimePool, contextB);
            assert.equal(backendA, backendB);

            const noContext = await runtimePool.connect();
            try {
              const settings = await noContext.query<{
                environment_id: string | null;
                principal_id: string | null;
                tenant_id: string | null;
              }>(`
              SELECT nullif(current_setting('north_star.tenant_id', true), '') AS tenant_id,
                     nullif(current_setting('north_star.environment_id', true), '') AS environment_id,
                     nullif(current_setting('north_star.principal_id', true), '') AS principal_id
            `);
              assert.deepEqual(settings.rows[0], {
                environment_id: null,
                principal_id: null,
                tenant_id: null,
              });
              const hidden = await noContext.query<{ count: string }>(
                'SELECT count(*) FROM platform.tenant_releases',
              );
              assert.equal(hidden.rows[0]?.count, '0');
              await assert.rejects(
                noContext.query(
                  'SELECT count(*) FROM platform.release_artifact_blobs',
                ),
                /permission denied/,
              );
            } finally {
              noContext.release();
            }
          },
        );

        await t.test(
          'corrupt, missing, mislinked, unsupported frozen, attestation, and scope inputs register no root',
          async () => {
            const initialRoots = await releaseCount(pool);
            const cases: Array<{ code: string; compiled: CompileSuccess }> = [
              {
                code: 'ARTIFACT_CONTENT_HASH_MISMATCH',
                compiled: corruptArtifactByte(bootstrap),
              },
              {
                code: 'PROJECTION_CHUNK_MISSING',
                compiled: removeArtifact(bootstrap),
              },
              {
                code: 'PROJECTION_MANIFEST_MISSING',
                compiled: wrongProjectionLink(bootstrap),
              },
              {
                code: 'ARTIFACT_CONTENT_HASH_MISMATCH',
                compiled: wrongArtifactDomain(bootstrap),
              },
              {
                code: 'ARTIFACT_CLOSURE_MISMATCH',
                compiled: wrongArtifactClosure(bootstrap),
              },
              {
                code: 'COMPILER_ATTESTATION_MISMATCH',
                compiled: wrongAttestation(bootstrap),
              },
              {
                code: 'RELEASE_MANIFEST_ENVELOPE_MISMATCH',
                compiled: wrongReleaseManifestIdentity(
                  bootstrap,
                  'manifestVersion',
                ),
              },
              {
                code: 'RELEASE_MANIFEST_ENVELOPE_MISMATCH',
                compiled: wrongReleaseManifestIdentity(
                  bootstrap,
                  'policyModelVersion',
                ),
              },
              {
                code: 'RELEASE_MANIFEST_ENVELOPE_MISMATCH',
                compiled: missingReleaseManifestEnvelopeFields(bootstrap),
              },
              {
                code: 'PROJECTION_MANIFEST_LINK_MISMATCH',
                compiled: wrongProjectionVersion(
                  bootstrap,
                  'chunkingSchemeVersion',
                ),
              },
              {
                code: 'PROJECTION_MANIFEST_LINK_MISMATCH',
                compiled: wrongProjectionVersion(bootstrap, 'manifestVersion'),
              },
              {
                code: 'PROJECTION_MANIFEST_LINK_MISMATCH',
                compiled: wrongProjectionVersion(
                  bootstrap,
                  'outputProtocolVersion',
                ),
              },
              {
                code: 'PROJECTION_MANIFEST_LINK_MISMATCH',
                compiled: wrongProjectionReaderProtocolVersion(bootstrap),
              },
              {
                code: 'PROJECTION_MANIFEST_LINK_MISMATCH',
                compiled: wrongProjectionSemanticDigest(bootstrap),
              },
              {
                code: 'PROJECTION_CHUNK_LINK_MISMATCH',
                compiled: wrongChunkDescriptorVersion(bootstrap),
              },
              {
                code: 'COMPILER_ATTESTATION_MISMATCH',
                compiled: wrongAttestationIdentity(bootstrap, 'compileMode'),
              },
              {
                code: 'COMPILER_ATTESTATION_MISMATCH',
                compiled: wrongAttestationIdentity(
                  bootstrap,
                  'incrementalEquivalenceInvariant',
                ),
              },
              {
                code: 'COMPILE_RESULT_NOT_SUCCESSFUL',
                compiled: wrongCompiledBundleKind(bootstrap),
              },
              {
                code: 'COMPILE_RESULT_NOT_SUCCESSFUL',
                compiled: wrongSuccessfulDiagnostics(bootstrap),
              },
            ];

            for (const [index, fixture] of cases.entries()) {
              await assert.rejects(
                repository.registerTenantRelease(
                  contextA,
                  releaseCommand(
                    contextA,
                    minted(
                      `c4000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                    ),
                    revisionA,
                    minted(
                      `c5000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                    ),
                    fixture.compiled,
                  ),
                ),
                (error: unknown) =>
                  error instanceof ReleasePersistenceIntegrityError &&
                  error.code === fixture.code,
              );
              assert.equal(await releaseCount(pool), initialRoots);
            }

            await assert.rejects(
              repository.registerTenantRelease(contextA, {
                ...releaseCommand(
                  contextA,
                  minted('c4000000-0000-4000-8000-000000000010'),
                  revisionA,
                  minted('c5000000-0000-4000-8000-000000000010'),
                  bootstrap,
                ),
                environmentId: environmentAPreview,
              }),
              ReleasePersistenceIdentityError,
            );
            await assert.rejects(
              repository.registerTenantRelease(
                contextA,
                releaseCommand(
                  contextA,
                  minted('c4000000-0000-4000-8000-000000000011'),
                  revisionB,
                  minted('c5000000-0000-4000-8000-000000000011'),
                  bootstrap,
                ),
              ),
              (error: unknown) =>
                error instanceof ReleasePersistenceIntegrityError &&
                error.code === 'REVISION_NOT_FOUND',
            );
            assert.equal(await releaseCount(pool), initialRoots);
          },
        );

        await t.test(
          'database privileges and rules deny mutation and hash-oracle reads',
          async () => {
            await assert.rejects(
              withTrustedRequestTransaction(
                runtimePool,
                contextA,
                async (client) =>
                  client.query(
                    `UPDATE platform.tenant_releases
                      SET compiler_version = 'changed'
                    WHERE release_id = $1`,
                    [releaseA],
                  ),
              ),
              /permission denied/,
            );
            await assert.rejects(
              withTrustedRequestTransaction(
                runtimePool,
                contextA,
                async (client) =>
                  client.query(
                    'DELETE FROM platform.tenant_releases WHERE release_id = $1',
                    [releaseA],
                  ),
              ),
              /permission denied/,
            );

            const admin = await pool.connect();
            try {
              const privileges = await admin.query<{
                blob_select: boolean;
                release_delete: boolean;
                release_insert: boolean;
                release_select: boolean;
                release_update: boolean;
              }>(`
              SELECT has_table_privilege(
                       'north_star_runtime',
                       'platform.release_artifact_blobs',
                       'SELECT'
                     ) AS blob_select,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.tenant_releases',
                       'SELECT'
                     ) AS release_select,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.tenant_releases',
                       'INSERT'
                     ) AS release_insert,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.tenant_releases',
                       'UPDATE'
                     ) AS release_update,
                     has_table_privilege(
                       'north_star_runtime',
                       'platform.tenant_releases',
                       'DELETE'
                     ) AS release_delete
            `);
              assert.deepEqual(privileges.rows[0], {
                blob_select: false,
                release_delete: false,
                release_insert: true,
                release_select: true,
                release_update: false,
              });
              const policyCommands = await admin.query<{
                command: string;
              }>(`
              SELECT cmd AS command
                FROM pg_catalog.pg_policies
               WHERE schemaname = 'platform'
                 AND tablename IN (
                   'app_package_revisions',
                   'tenant_releases',
                   'tenant_release_artifact_links',
                   'tenant_release_projection_links',
                   'tenant_release_chunk_links'
                 )
               ORDER BY tablename, policyname
            `);
              assert.deepEqual(
                policyCommands.rows.map(({ command }) => command),
                [
                  'INSERT',
                  'SELECT',
                  'INSERT',
                  'SELECT',
                  'INSERT',
                  'SELECT',
                  'INSERT',
                  'SELECT',
                  'INSERT',
                  'SELECT',
                ],
              );

              for (const statement of [
                `UPDATE platform.app_package_revisions
                  SET provenance = 'changed'
                WHERE revision_id = '${revisionA}'`,
                `DELETE FROM platform.tenant_releases
                WHERE release_id = '${releaseA}'`,
                `UPDATE platform.release_artifact_blobs
                  SET domain_tag = 'changed'
                WHERE content_hash = '${bootstrap.releaseRoot}'`,
                `DELETE FROM platform.tenant_release_artifact_links
                WHERE release_id = '${releaseA}'`,
              ]) {
                await assert.rejects(
                  admin.query(statement),
                  /immutable_release_write_guard_reject|violates check constraint/,
                );
              }
              const rules = await admin.query<{ count: string }>(`
              SELECT count(*)
                FROM pg_catalog.pg_rewrite rewrite
                JOIN pg_catalog.pg_class relation
                  ON relation.oid = rewrite.ev_class
                JOIN pg_catalog.pg_namespace namespace
                  ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'platform'
                 AND rewrite.rulename ~ '_reject_(update|delete)$'
                 AND relation.relname IN (
                   'app_package_revisions',
                   'release_artifact_blobs',
                   'tenant_releases',
                   'tenant_release_artifact_links',
                   'tenant_release_projection_links',
                   'tenant_release_chunk_links'
                 )
            `);
              assert.equal(rules.rows[0]?.count, '12');
            } finally {
              admin.release();
            }
          },
        );

        await t.test(
          'database collision guard compares bytes and metadata',
          async () => {
            const artifact = bootstrap.bundle.artifacts[0];
            assert.ok(artifact);
            await assert.rejects(
              withTrustedRequestTransaction(
                runtimePool,
                contextA,
                async (client) =>
                  client.query(
                    'SELECT platform.stage_release_artifact($1, $2, $3, $4, $5)',
                    [
                      artifact.contentHash,
                      artifact.artifactKind,
                      artifact.domainTag,
                      artifact.mediaType,
                      Buffer.from([...artifact.canonicalBytes, 0]),
                    ],
                  ),
              ),
              /content-address collision/,
            );
          },
        );
      } finally {
        await runtimePool.end();
      }
    },
  );
});

function partitionVerificationPlan(): VerificationPlanPayloadV1 {
  return Object.freeze({
    kind: 'verificationPlanPayload',
    scenarios: Object.freeze([
      Object.freeze({
        entityId: 'fixture:entity.executable',
        kind: 'searchableExclusion' as const,
        probePolarity: 'positiveAndNegative' as const,
        provider: 'realPostgresql' as const,
        scenarioFingerprint: 'a'.repeat(64),
        scenarioId: 'fixture:verification-scenario.executable',
        schemaVersion: VERIFICATION_SCENARIO_VERSION,
        subjectId: 'fixture:field.executable_notes',
      }),
      Object.freeze({
        entityId: 'fixture:entity.fact',
        kind: 'searchableExclusion' as const,
        probePolarity: 'positiveAndNegative' as const,
        provider: 'realPostgresql' as const,
        scenarioFingerprint: 'b'.repeat(64),
        scenarioId: 'fixture:verification-scenario.fact',
        schemaVersion: VERIFICATION_SCENARIO_VERSION,
        subjectId: 'fixture:field.fact_recorded_at',
      }),
      Object.freeze({
        entityId: 'fixture:entity.transaction',
        kind: 'searchableExclusion' as const,
        probePolarity: 'positiveAndNegative' as const,
        provider: 'realPostgresql' as const,
        scenarioFingerprint: 'c'.repeat(64),
        scenarioId: 'fixture:verification-scenario.transaction',
        schemaVersion: VERIFICATION_SCENARIO_VERSION,
        subjectId: 'fixture:field.transaction_legal_entity',
      }),
    ]),
    schemaVersion: VERIFICATION_PLAN_PAYLOAD_VERSION,
  });
}

function partitionVerificationCommand(): VerificationExecutionCommand {
  return Object.freeze({
    artifactClosureDigest: 'd'.repeat(64),
    providerRunId: 'postgres-verification:partition-control',
    releaseRoot: 'e'.repeat(64),
    verificationPlanArtifactRoot: 'f'.repeat(64),
    verificationPlanSemanticDigest: '1'.repeat(64),
  });
}

function resignPartitionedResultSet(
  value: PartitionedVerificationResultSet,
): PartitionedVerificationResultSet {
  const { resultSetDigest: priorDigest, ...payload } = value;
  void priorDigest;
  const resultSetDigest = createHash('sha256')
    .update(payload.schemaVersion, 'utf8')
    .update(Uint8Array.of(0))
    .update(canonicalize(payload), 'utf8')
    .digest('hex');
  return Object.freeze({ ...payload, resultSetDigest });
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

function revisionCommand(
  context: TrustedRequestContext,
  revisionId: MintedUuid,
  desiredState: Uint8Array,
): StoreAppPackageRevisionCommand {
  const normalizedDefinition =
    parseNormalizedApplicationPackageJson(desiredState);
  const normalized = canonicalizeAndHash(normalizedDefinition);
  return {
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    contentHash: normalized.contentHash,
    createdBy: context.principalId,
    desiredState,
    hashAlgorithm: CONTENT_HASH_ALGORITHM,
    languageVersion: normalizedDefinition.languageVersion,
    normalizationProfileVersion:
      normalizedDefinition.normalizationProfileVersion,
    parentRevisionId: null,
    provenance: 'firstParty',
    revisionId,
    schemaVersion: normalizedDefinition.schemaVersion,
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

async function admitEmptyRelease(
  pool: pg.Pool,
  repository: PostgresImmutableReleaseRepository,
  context: TrustedRequestContext,
  command: RegisterTenantReleaseCommand<CompileSuccess>,
) {
  const staged = await repository.stageTenantReleaseCandidate(context, {
    appPackageRevisionId: command.appPackageRevisionId,
    compiledRelease: command.compiledRelease,
    createdBy: command.createdBy,
    environmentId: command.environmentId,
    releaseId: command.releaseId,
    tenantId: command.tenantId,
  });
  assert.equal(staged.verificationEvidenceId, command.verificationEvidenceId);
  await new PostgresReleaseVerificationService(
    pool,
  ).executeSemanticCandidateAndPersist(context, {
    compiledRelease: command.compiledRelease,
    evidenceId: staged.verificationEvidenceId,
    releaseId: command.releaseId,
  });
  return repository.registerTenantRelease(context, command);
}

function emptyRevisionBytes(
  bootstrapBytes: Uint8Array,
  version: string,
): Uint8Array {
  const definition = JSON.parse(
    new TextDecoder().decode(bootstrapBytes),
  ) as Record<string, unknown>;
  assert.ok(
    typeof definition.package === 'object' && definition.package !== null,
  );
  (definition.package as Record<string, unknown>).version = version;
  return new TextEncoder().encode(canonicalize(definition));
}

function assertReleaseBytes(
  stored: readonly {
    artifactKind: string;
    canonicalBytes: Uint8Array;
    contentHash: string;
    domainTag: string;
    mediaType: string;
  }[],
  compiled: CompileSuccess,
): void {
  const summary = (
    artifacts: readonly {
      artifactKind: string;
      canonicalBytes: Uint8Array;
      contentHash: string;
      domainTag: string;
      mediaType: string;
    }[],
  ) =>
    artifacts
      .map((artifact) => ({
        artifactKind: artifact.artifactKind,
        canonicalBytes: [...artifact.canonicalBytes],
        contentHash: artifact.contentHash,
        domainTag: artifact.domainTag,
        mediaType: artifact.mediaType,
      }))
      .toSorted((left, right) =>
        left.contentHash.localeCompare(right.contentHash),
      );
  assert.deepEqual(summary(stored), summary(compiled.bundle.artifacts));
}

function corruptArtifactByte(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  const artifact = clone.bundle.artifacts.find(
    (candidate) => candidate.artifactKind === 'projectionChunk',
  );
  assert.ok(artifact);
  artifact.canonicalBytes[0] = (artifact.canonicalBytes[0] ?? 0) ^ 1;
  return clone;
}

function removeArtifact(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  const removed = clone.bundle.artifacts.find(
    (artifact) => artifact.artifactKind === 'projectionChunk',
  );
  assert.ok(removed);
  clone.bundle.artifacts = clone.bundle.artifacts.filter(
    (artifact) => artifact.contentHash !== removed.contentHash,
  );
  clone.stagedArtifacts = clone.stagedArtifacts.filter(
    (artifact) => artifact.contentHash !== removed.contentHash,
  );
  return clone;
}

function wrongProjectionLink(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  const projection = clone.bundle.releaseManifest.projections[0];
  assert.ok(projection);
  projection.artifactRoot = '0'.repeat(64);
  return rebuildReleaseRoot(clone);
}

function wrongArtifactDomain(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  const artifact = clone.bundle.artifacts.find(
    (candidate) => candidate.artifactKind === 'projectionManifest',
  );
  assert.ok(artifact);
  artifact.domainTag = HASH_DOMAINS.projectionChunk;
  return clone;
}

function wrongArtifactClosure(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  clone.bundle.releaseManifest.artifactClosure.pop();
  return rebuildReleaseRoot(clone);
}

function wrongAttestation(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  clone.attestation.inputDefinitionDigest = '0'.repeat(64);
  return clone;
}

function wrongReleaseManifestIdentity(
  compiled: CompileSuccess,
  field: 'manifestVersion' | 'policyModelVersion',
): CompileSuccess {
  const clone = structuredClone(compiled);
  const manifest = clone.bundle.releaseManifest as unknown as Record<
    string,
    unknown
  >;
  manifest[field] = `northstar.unsupported/${field}`;
  return rebuildReleaseRoot(clone);
}

function missingReleaseManifestEnvelopeFields(
  compiled: CompileSuccess,
): CompileSuccess {
  const clone = structuredClone(compiled);
  const manifest = clone.bundle.releaseManifest as unknown as Record<
    string,
    unknown
  >;
  delete manifest.capabilityFacts;
  delete manifest.semanticProfileDigest;
  return rebuildReleaseRoot(clone);
}

function wrongProjectionVersion(
  compiled: CompileSuccess,
  field: 'chunkingSchemeVersion' | 'manifestVersion' | 'outputProtocolVersion',
): CompileSuccess {
  return rebuildProjectionManifest(compiled, (reference, manifest) => {
    const mutableReference = reference as unknown as Record<string, unknown>;
    const mutableManifest = manifest as unknown as Record<string, unknown>;
    const unsupported = `northstar.unsupported/${field}`;
    mutableReference[field] = unsupported;
    mutableManifest[field] = unsupported;
  });
}

function wrongProjectionReaderProtocolVersion(
  compiled: CompileSuccess,
): CompileSuccess {
  return rebuildProjectionManifest(compiled, (reference, manifest) => {
    const referenceCompatibility = reference.compatibility as unknown as Record<
      string,
      unknown
    >;
    const manifestCompatibility = manifest.compatibility as unknown as Record<
      string,
      unknown
    >;
    const unsupported = 'northstar.unsupported/minimumReaderProtocolVersion';
    referenceCompatibility.minimumReaderProtocolVersion = unsupported;
    manifestCompatibility.minimumReaderProtocolVersion = unsupported;
  });
}

function wrongProjectionSemanticDigest(
  compiled: CompileSuccess,
): CompileSuccess {
  return rebuildProjectionManifest(compiled, (reference, manifest) => {
    const incorrectDigest = '0'.repeat(64);
    reference.semanticDigest = incorrectDigest;
    manifest.semanticDigest = incorrectDigest;
  });
}

function wrongChunkDescriptorVersion(compiled: CompileSuccess): CompileSuccess {
  return rebuildProjectionManifest(compiled, (_reference, manifest) => {
    const descriptor = manifest.chunks[0];
    assert.ok(descriptor);
    const mutableDescriptor = descriptor as unknown as Record<string, unknown>;
    mutableDescriptor.chunkDescriptorVersion =
      'northstar.unsupported/chunkDescriptorVersion';
  });
}

function rebuildProjectionManifest(
  compiled: CompileSuccess,
  mutate: (
    reference: ProjectionReference,
    manifest: ProjectionManifestEnvelope,
  ) => void,
): CompileSuccess {
  const clone = structuredClone(compiled);
  const reference = clone.bundle.releaseManifest.projections[0];
  assert.ok(reference);
  const priorRoot = reference.artifactRoot;
  const artifact = clone.bundle.artifacts.find(
    (candidate) => candidate.contentHash === priorRoot,
  );
  assert.ok(artifact);
  assert.equal(artifact.artifactKind, 'projectionManifest');
  const manifest = JSON.parse(
    new TextDecoder().decode(artifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  mutate(reference, manifest);
  const bytes = new TextEncoder().encode(canonicalize(manifest));
  const replacement: ContentAddressedArtifact = {
    ...artifact,
    canonicalBytes: bytes,
    contentHash: hashBytes(artifact.domainTag, bytes),
  };
  reference.artifactRoot = replacement.contentHash;
  clone.bundle.releaseManifest.artifactClosure =
    clone.bundle.releaseManifest.artifactClosure
      .map((contentHash) =>
        contentHash === priorRoot ? replacement.contentHash : contentHash,
      )
      .toSorted();
  clone.bundle.artifacts = replaceArtifact(
    clone.bundle.artifacts,
    priorRoot,
    replacement,
  );
  clone.stagedArtifacts = replaceArtifact(
    clone.stagedArtifacts,
    priorRoot,
    replacement,
  );
  return rebuildReleaseRoot(clone);
}

function wrongAttestationIdentity(
  compiled: CompileSuccess,
  field: 'compileMode' | 'incrementalEquivalenceInvariant',
): CompileSuccess {
  const clone = structuredClone(compiled);
  const attestation = clone.attestation as unknown as Record<string, unknown>;
  attestation[field] = `northstar.unsupported/${field}`;
  return rehashAttestation(clone);
}

function wrongCompiledBundleKind(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  const bundle = clone.bundle as unknown as Record<string, unknown>;
  bundle.kind = 'unsupportedCompiledReleaseBundle';
  return clone;
}

function wrongSuccessfulDiagnostics(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  const success = clone as unknown as { diagnostics: unknown[] };
  success.diagnostics = [{ code: 'unexpected-success-diagnostic' }];
  return clone;
}

function doctoredRuntimeProjectionWithoutChangingContentAddress(
  compiled: CompileSuccess,
): CompileSuccess {
  const clone = structuredClone(compiled);
  const reference = clone.bundle.releaseManifest.projections.find(
    (projection) => projection.familyId === PROJECTION_FAMILY_IDS.queryCatalog,
  );
  assert.ok(reference);
  const manifestArtifact = clone.bundle.artifacts.find(
    (artifact) => artifact.contentHash === reference.artifactRoot,
  );
  assert.ok(manifestArtifact);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  const chunkHash = manifest.chunks[0]?.contentHash;
  assert.ok(chunkHash);
  const chunk = clone.bundle.artifacts.find(
    (artifact) => artifact.contentHash === chunkHash,
  );
  const stagedChunk = clone.stagedArtifacts.find(
    (artifact) => artifact.contentHash === chunkHash,
  );
  assert.ok(chunk);
  assert.ok(stagedChunk);
  const payload = JSON.parse(
    new TextDecoder().decode(chunk.canonicalBytes),
  ) as Record<string, unknown>;
  const doctoredBytes = new TextEncoder().encode(
    canonicalize({ ...payload, doctoredAfterStaging: true }),
  );
  chunk.canonicalBytes = doctoredBytes;
  stagedChunk.canonicalBytes = doctoredBytes;
  return clone;
}

function rebuildReleaseRoot(compiled: CompileSuccess): CompileSuccess {
  const bytes = new TextEncoder().encode(
    canonicalize(compiled.bundle.releaseManifest),
  );
  const root = hashBytes(HASH_DOMAINS.releaseManifest, bytes);
  const replacement: ContentAddressedArtifact = {
    artifactKind: 'releaseManifest',
    canonicalBytes: bytes,
    contentHash: root,
    domainTag: HASH_DOMAINS.releaseManifest,
    kind: 'contentAddressedArtifact',
    mediaType: 'application/vnd.northstar.canonical+json',
  };
  compiled.bundle.releaseManifestBytes = bytes;
  compiled.releaseRoot = root;
  compiled.bundle.artifacts = replaceRootArtifact(
    compiled.bundle.artifacts,
    replacement,
  );
  compiled.stagedArtifacts = replaceRootArtifact(
    compiled.stagedArtifacts,
    replacement,
  );
  compiled.attestation.releaseRoot = root;
  return rehashAttestation(compiled);
}

function rehashAttestation(compiled: CompileSuccess): CompileSuccess {
  const attestationBody: Record<string, unknown> = {
    ...compiled.attestation,
  };
  delete attestationBody.attestationDigest;
  compiled.attestation.attestationDigest = hashBytes(
    HASH_DOMAINS.compilerAttestation,
    new TextEncoder().encode(canonicalize(attestationBody)),
  );
  return compiled;
}

function replaceArtifact(
  artifacts: ContentAddressedArtifact[],
  priorHash: string,
  replacement: ContentAddressedArtifact,
): ContentAddressedArtifact[] {
  return artifacts.map((artifact) =>
    artifact.contentHash === priorHash ? replacement : artifact,
  );
}

function replaceRootArtifact(
  artifacts: ContentAddressedArtifact[],
  replacement: ContentAddressedArtifact,
): ContentAddressedArtifact[] {
  return artifacts.map((artifact) =>
    artifact.artifactKind === 'releaseManifest' ? replacement : artifact,
  );
}

function hashBytes(domain: string, bytes: Uint8Array): string {
  return createHash(HASH_ALGORITHM)
    .update(domain, 'utf8')
    .update(Uint8Array.of(0))
    .update(bytes)
    .digest('hex');
}

async function backendPid(
  pool: pg.Pool,
  context: TrustedRequestContext,
): Promise<number> {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    const result = await client.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    return result.rows[0]!.pid;
  });
}

async function releaseCount(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*) FROM platform.tenant_releases',
  );
  return result.rows[0]!.count;
}

async function seedTenants(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO platform.tenants (id, slug)
     VALUES ($1, 'tenant-a'), ($2, 'tenant-b')`,
    [tenantA, tenantB],
  );
  await client.query(
    `INSERT INTO platform.environments (tenant_id, id, slug)
     VALUES ($1, $2, 'production'),
            ($1, $3, 'preview'),
            ($4, $5, 'production')`,
    [tenantA, environmentA, environmentAPreview, tenantB, environmentB],
  );
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}
