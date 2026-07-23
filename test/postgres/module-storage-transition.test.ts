import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  canonicalize,
  canonicalizeAndHash,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  compileApplication,
  expectedActiveReleaseFrom,
  type CompileSuccess,
  type CompilerInput,
} from '../../packages/compiler/src/index.js';
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import {
  COMPILER_TRANSITION_FACTS_VERSION,
  EXECUTOR_APPLIED_STATE_EVIDENCE_V2_VERSION,
  RELEASE_DIFF_BINDING_VERSION,
  SYSTEM_EXECUTION_PRINCIPAL,
  TRANSITION_COMPATIBILITY_POLICY_V2_VERSION,
  TRANSITION_PREPARATION_RECEIPT_V2_VERSION,
} from '../../packages/platform-runtime/src/index.js';
import { PostgresReleaseActivationService } from '../../packages/postgres-provider/src/release-activation-service.js';
import { PostgresReleaseApprovalService } from '../../packages/postgres-provider/src/release-approval-service.js';
import {
  ModuleStorageMaterializationError,
  PostgresModuleStorageMaterializer,
} from '../../packages/postgres-provider/src/module-storage-materializer.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import {
  AuthenticatedRequestEntryAdapter,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import {
  FIXTURE_IDS,
  ordinaryModuleV1,
  ordinaryModuleV2,
} from '../fixtures/g2/module-conformance/definitions.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const migrations = resolve('db/migrations');
const tenantA = 'a1000000-0000-4000-8000-000000000001';
const tenantB = 'b1000000-0000-4000-8000-000000000001';
const environmentA = 'a2000000-0000-4000-8000-000000000002';
const environmentB = 'b2000000-0000-4000-8000-000000000002';
const principalA = 'a3000000-0000-4000-8000-000000000003';
const principalB = 'b3000000-0000-4000-8000-000000000003';
const approverA = 'a4000000-0000-4000-8000-000000000004';

test('compiled module materialization is isolated, convergent, and provenance-closed', async (t) => {
  const emptyDefinition = emptyModuleDefinition();
  const source = mustCompile(moduleInput(emptyDefinition));
  const targetBytes = definitionBytes(ordinaryModuleV1());
  const target = mustCompile(
    moduleInput(ordinaryModuleV1(), expectedActiveReleaseFrom(source)),
  );

  await withEphemeralPostgres(
    'module-storage-transition',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        const allMigrations = await loadMigrations(migrations);
        const acceptedG1 = await runMigrations(
          admin,
          allMigrations.slice(0, 6),
        );
        assert.equal(acceptedG1.applied.length, 6);
        const migrationResult = await runMigrations(admin, allMigrations);
        assert.deepEqual(migrationResult.applied, [
          '0007_module_storage_transitions.sql',
        ]);
        assert.equal(migrationResult.verified.length, 7);
        await seedScope(admin);
      } finally {
        admin.release();
      }

      const runtimePool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_runtime',
      });
      const materializerPool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_module_materializer',
      });
      const moduleRuntimePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_module_runtime',
      });
      try {
        const contexts = await trustedContexts();
        const releases = await persistPairForBothTenants(
          runtimePool,
          contexts,
          source,
          definitionBytes(emptyDefinition),
          target,
          targetBytes,
        );
        await installSourcePointers(pool, releases);
        await grantExecutorAuthority(pool);

        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          moduleRuntimePool,
        );
        const firstGenerationId = randomUUID();
        const firstPreparationId = randomUUID();
        const first = await materializer.prepare({
          context: contexts.a,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generationId: firstGenerationId,
          initiatedBy: principalA,
          preparationId: firstPreparationId,
          targetReleaseId: releases.a.target,
        });
        assert.equal(first.schemaState, 'APPLIED');
        assert.equal(first.receipt.state, 'PREPARED');
        assert.ok(
          first.diff.elements.some(
            (element) => element.disposition === 'APPLIED',
          ),
        );
        assert.ok(first.preparedSubsetDigest.some((octet) => octet !== 0));
        assert.ok(first.remainingPlanDigest.some((octet) => octet !== 0));

        await t.test(
          'READY_TO_SWAP is fresh provider evidence and the real CAS gate',
          async () => {
            const attemptId = await createV2Approval(
              runtimePool,
              pool,
              contexts,
              releases.a,
              target,
              first,
              firstPreparationId,
            );
            const executed = await materializer.executeApprovedAttempt({
              activationAttemptId: attemptId,
              context: contexts.a,
              coordinatorId: randomUUID(),
              generationId: firstGenerationId,
            });
            assert.equal(executed.disposition, 'READY_TO_SWAP');
            assert.equal(executed.receipt?.state, 'READY_TO_SWAP');

            const beforeSwap = await pool.query<{ release_id: string }>(
              `SELECT release_id FROM platform.active_release_pointers
              WHERE tenant_id = $1 AND environment_id = $2`,
              [tenantA, environmentA],
            );
            assert.equal(beforeSwap.rows[0]?.release_id, releases.a.source);

            const activation = new PostgresReleaseActivationService(
              runtimePool,
            );
            const activated = await activation.activate(contexts.system, {
              activationAttemptId: minted(attemptId),
            });
            assert.equal(activated.status, 'SWAPPED_VERIFIED');
            const verification = await pool.query<{
              module_schema_conformance_passed: boolean;
              verification_version: string;
            }>(
              `SELECT verification_version, module_schema_conformance_passed
               FROM platform.release_activation_verification_receipts
              WHERE activation_attempt_id = $1`,
              [attemptId],
            );
            assert.deepEqual(verification.rows[0], {
              module_schema_conformance_passed: true,
              verification_version:
                'northstar.release-activation-verification/v2',
            });
          },
        );

        await t.test(
          'backfill is in-attempt, checkpointed, resumable, and uniquely claimed',
          async () => {
            const admissible = ordinaryModuleV2() as {
              fields: Array<Record<string, unknown>>;
            };
            const field = admissible.fields.find(
              (candidate) =>
                candidate.fieldId === FIXTURE_IDS.fieldIds.parentNotes,
            )!;
            field.defaultSemantics = 'coalesceAtRead';
            field.defaultValue = {
              kind: 'textValue',
              schemaVersion: 'v1',
              value: '',
            };
            field.storageEvolution = {
              kind: 'backfillEvolution',
              residualReadSemantics: 'coalesceAtRead',
              schemaVersion: 'v1',
            };
            const compiled = mustCompile(
              moduleInput(admissible, expectedActiveReleaseFrom(target)),
            );
            const next = await persistNextRelease(
              runtimePool,
              contexts.a,
              releases.a.target,
              compiled,
              definitionBytes(admissible),
            );
            const generationId = randomUUID();
            const preparationId = randomUUID();
            const prepared = await materializer.prepare({
              context: contexts.a,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              generationId,
              initiatedBy: principalA,
              preparationId,
              targetReleaseId: next.target,
            });
            assert.equal(prepared.dataState, 'PENDING_IN_ATTEMPT');
            const attemptId = await createV2Approval(
              runtimePool,
              pool,
              contexts,
              next,
              compiled,
              prepared,
              preparationId,
            );
            const attempts = await Promise.allSettled([
              materializer.executeApprovedAttempt({
                activationAttemptId: attemptId,
                context: contexts.a,
                coordinatorId: randomUUID(),
                generationId,
              }),
              materializer.executeApprovedAttempt({
                activationAttemptId: attemptId,
                context: contexts.a,
                coordinatorId: randomUUID(),
                generationId,
              }),
            ]);
            assert.equal(
              attempts.filter(
                (result) =>
                  result.status === 'fulfilled' &&
                  result.value.disposition === 'READY_TO_SWAP',
              ).length,
              1,
            );
            assert.equal(
              attempts.filter((result) => result.status === 'rejected').length,
              1,
            );
            const checkpoint = await pool.query<{
              complete: boolean;
              rows_applied: string;
            }>(
              `SELECT complete, rows_applied
               FROM north_star_internal.module_storage_backfill_checkpoints
              WHERE generation_id = $1`,
              [generationId],
            );
            assert.deepEqual(checkpoint.rows[0], {
              complete: true,
              rows_applied: '0',
            });
          },
        );

        await t.test(
          'two tenants and two roots converge on shared tables',
          async () => {
            const second = await materializer.prepare({
              context: contexts.b,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              generationId: randomUUID(),
              initiatedBy: principalB,
              preparationId: randomUUID(),
              targetReleaseId: releases.b.target,
            });
            assert.deepEqual(
              second.preparedSubsetDigest,
              first.preparedSubsetDigest,
            );
            const tableCount = await pool.query<{ count: string }>(
              `SELECT count(*) FROM pg_tables WHERE schemaname = 'north_star_module'`,
            );
            assert.equal(tableCount.rows[0]?.count, '2');
            const membership = await pool.query<{ tenants: string }>(
              `SELECT count(DISTINCT tenant_id)::text AS tenants
               FROM north_star_internal.module_storage_root_membership`,
            );
            assert.equal(membership.rows[0]?.tenants, '2');
          },
        );

        await t.test(
          'DDL and destructive DML are unreachable from runtime roles',
          async () => {
            const roleFacts = await pool.query<{
              bypassrls: boolean;
              createrole: boolean;
              superuser: boolean;
            }>(
              `SELECT rolsuper AS superuser, rolbypassrls AS bypassrls,
                    rolcreaterole AS createrole
               FROM pg_roles WHERE rolname = 'north_star_module_materializer'`,
            );
            assert.deepEqual(roleFacts.rows[0], {
              bypassrls: false,
              createrole: false,
              superuser: false,
            });
            await assert.rejects(
              runtimePool.query(
                'CREATE TABLE north_star_module.forbidden(id uuid)',
              ),
              /permission denied/,
            );
            await assert.rejects(
              moduleRuntimePool.query(
                `DELETE FROM north_star_module.${await firstManagedTable(pool)}`,
              ),
              /permission denied/,
            );
            await assert.rejects(
              runtimePool.query(
                'SELECT * FROM north_star_internal.module_storage_element_applications',
              ),
              /permission denied/,
            );
          },
        );

        await t.test(
          'live-set reconciliation recomputes bytes and fails closed on rogue objects',
          async () => {
            const verification = await materializer.verifyLiveCatalog(
              contexts.a,
            );
            assert.deepEqual(verification.drift, []);
            await pool.query(
              'CREATE TABLE public.rogue_module_object(id uuid)',
            );
            await assert.rejects(
              materializer.verifyLiveCatalog(contexts.a),
              (error: unknown) =>
                error instanceof ModuleStorageMaterializationError &&
                error.code === 'CATALOG_DRIFT' &&
                /0 verifiers/.test(error.message),
            );
          },
        );

        await t.test(
          'stored provenance is exact and ledger evidence is append-only',
          async () => {
            const evidence = await pool.query<{
              applications: string;
              generations: string;
              memberships: string;
            }>(
              `SELECT
              (SELECT count(*) FROM north_star_internal.module_storage_element_applications)::text AS applications,
              (SELECT count(*) FROM north_star_internal.module_storage_generations)::text AS generations,
              (SELECT count(*) FROM north_star_internal.module_storage_root_membership)::text AS memberships`,
            );
            assert.equal(evidence.rows[0]?.generations, '3');
            assert.ok(Number(evidence.rows[0]?.applications) > 0);
            assert.ok(Number(evidence.rows[0]?.memberships) > 0);
            const before = evidence.rows[0]?.applications;
            await pool.query(
              `UPDATE north_star_internal.module_storage_element_applications
                SET detail_code = 'TAMPERED'`,
            );
            const after = await pool.query<{ count: string }>(
              'SELECT count(*) FROM north_star_internal.module_storage_element_applications',
            );
            assert.equal(after.rows[0]?.count, before);
          },
        );
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          moduleRuntimePool.end(),
        ]);
      }
    },
  );
});

function emptyModuleDefinition(): Record<string, unknown> {
  const definition = ordinaryModuleV1();
  for (const family of [
    'assertions',
    'entities',
    'fields',
    'operations',
    'permissions',
    'queries',
    'relations',
    'stateMachines',
    'storageMappings',
    'surfaces',
  ]) {
    definition[family] = [];
  }
  return definition;
}

function definitionBytes(definition: unknown): Uint8Array {
  return new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(definition)),
  );
}

function moduleInput(
  definition: unknown,
  expectedActiveRelease: CompilerInput['expectedActiveRelease'] = null,
): CompilerInput {
  return {
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: definitionBytes(definition),
    profile: { ...MODULE_COMPILER_PROFILE },
  };
}

function mustCompile(input: CompilerInput): CompileSuccess {
  const result = compileApplication(input);
  if (result.status !== 'compiled')
    throw new Error(JSON.stringify(result.diagnostics));
  return result;
}

async function trustedContexts(): Promise<{
  a: TrustedRequestContext;
  approver: TrustedRequestContext;
  b: TrustedRequestContext;
  system: TrustedRequestContext;
}> {
  const entry = new AuthenticatedRequestEntryAdapter(async (request) => {
    if (request.headers?.authorization === 'a') {
      return {
        environmentId: environmentA,
        principalId: principalA,
        tenantId: tenantA,
      };
    }
    if (request.headers?.authorization === 'b') {
      return {
        environmentId: environmentB,
        principalId: principalB,
        tenantId: tenantB,
      };
    }
    if (request.headers?.authorization === 'approver') {
      return {
        environmentId: environmentA,
        principalId: approverA,
        tenantId: tenantA,
      };
    }
    if (request.headers?.authorization === 'system') {
      return {
        environmentId: environmentA,
        principalId: SYSTEM_EXECUTION_PRINCIPAL.principalId,
        tenantId: tenantA,
      };
    }
    return null;
  });
  return {
    a: await entry.enter({ headers: { authorization: 'a' } }),
    approver: await entry.enter({ headers: { authorization: 'approver' } }),
    b: await entry.enter({ headers: { authorization: 'b' } }),
    system: await entry.enter({ headers: { authorization: 'system' } }),
  };
}

async function seedScope(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO platform.tenants (id, slug) VALUES ($1,'module-a'),($2,'module-b')`,
    [tenantA, tenantB],
  );
  await client.query(
    `INSERT INTO platform.environments (tenant_id, id, slug)
     VALUES ($1,$2,'production'),($3,$4,'production')`,
    [tenantA, environmentA, tenantB, environmentB],
  );
}

async function persistPairForBothTenants(
  runtimePool: pg.Pool,
  contexts: { a: TrustedRequestContext; b: TrustedRequestContext },
  source: CompileSuccess,
  sourceBytes: Uint8Array,
  target: CompileSuccess,
  targetBytes: Uint8Array,
): Promise<{ a: ReleasePair; b: ReleasePair }> {
  const repository = new PostgresImmutableReleaseRepository(runtimePool);
  const persist = async (
    context: TrustedRequestContext,
  ): Promise<ReleasePair> => {
    const sourceRevision = minted(randomUUID());
    const targetRevision = minted(randomUUID());
    const sourceRelease = minted(randomUUID());
    const targetRelease = minted(randomUUID());
    const targetEvidence = minted(randomUUID());
    await repository.storeAppPackageRevision(
      context,
      revisionCommand(context, sourceRevision, sourceBytes),
    );
    await repository.storeAppPackageRevision(
      context,
      revisionCommand(context, targetRevision, targetBytes),
    );
    await repository.registerTenantRelease(
      context,
      releaseCommand(
        context,
        sourceRelease,
        sourceRevision,
        minted(randomUUID()),
        source,
      ),
    );
    await repository.registerTenantRelease(
      context,
      releaseCommand(
        context,
        targetRelease,
        targetRevision,
        targetEvidence,
        target,
      ),
    );
    return { source: sourceRelease, target: targetRelease, targetEvidence };
  };
  return { a: await persist(contexts.a), b: await persist(contexts.b) };
}

async function persistNextRelease(
  runtimePool: pg.Pool,
  context: TrustedRequestContext,
  sourceRelease: MintedUuid,
  compiled: CompileSuccess,
  bytes: Uint8Array,
): Promise<ReleasePair> {
  const repository = new PostgresImmutableReleaseRepository(runtimePool);
  const revision = minted(randomUUID());
  const target = minted(randomUUID());
  const targetEvidence = minted(randomUUID());
  await repository.storeAppPackageRevision(
    context,
    revisionCommand(context, revision, bytes),
  );
  await repository.registerTenantRelease(
    context,
    releaseCommand(context, target, revision, targetEvidence, compiled),
  );
  return { source: sourceRelease, target, targetEvidence };
}

interface ReleasePair {
  source: MintedUuid;
  target: MintedUuid;
  targetEvidence: MintedUuid;
}

function revisionCommand(
  context: TrustedRequestContext,
  revisionId: MintedUuid,
  desiredState: Uint8Array,
): StoreAppPackageRevisionCommand {
  const digest = canonicalizeAndHash(
    JSON.parse(new TextDecoder().decode(desiredState)) as unknown,
  );
  return {
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    contentHash: digest.contentHash,
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
  revisionId: MintedUuid,
  verificationEvidenceId: MintedUuid,
  compiledRelease: CompileSuccess,
): RegisterTenantReleaseCommand<CompileSuccess> {
  return {
    appPackageRevisionId: revisionId,
    compiledRelease,
    createdBy: context.principalId,
    environmentId: context.environmentId,
    releaseId,
    tenantId: context.tenantId,
    verificationEvidenceId,
  };
}

async function installSourcePointers(
  pool: pg.Pool,
  releases: { a: ReleasePair; b: ReleasePair },
): Promise<void> {
  await pool.query(
    'ALTER TABLE platform.active_release_pointers DISABLE TRIGGER active_release_pointer_exact_swap',
  );
  try {
    await pool.query(
      `UPDATE platform.active_release_pointers SET release_id = CASE tenant_id
         WHEN $1 THEN $2::uuid WHEN $3 THEN $4::uuid END
       WHERE tenant_id IN ($1,$3)`,
      [tenantA, releases.a.source, tenantB, releases.b.source],
    );
  } finally {
    await pool.query(
      'ALTER TABLE platform.active_release_pointers ENABLE TRIGGER active_release_pointer_exact_swap',
    );
  }
}

async function grantExecutorAuthority(pool: pg.Pool): Promise<void> {
  await pool.query(
    `SELECT platform.set_release_executor_authority($1,$2,true,$2,$3),
            platform.set_release_executor_authority($4,$5,true,$5,$6),
            platform.set_release_executor_authority($1,$7,true,$7,$8),
            platform.set_release_approver_eligibility($1,$9,true,$9,$10)`,
    [
      tenantA,
      principalA,
      randomUUID(),
      tenantB,
      principalB,
      randomUUID(),
      SYSTEM_EXECUTION_PRINCIPAL.principalId,
      randomUUID(),
      approverA,
      randomUUID(),
    ],
  );
}

async function createV2Approval(
  runtimePool: pg.Pool,
  adminPool: pg.Pool,
  contexts: {
    a: TrustedRequestContext;
    approver: TrustedRequestContext;
  },
  releases: ReleasePair,
  target: CompileSuccess,
  prepared: Awaited<ReturnType<PostgresModuleStorageMaterializer['prepare']>>,
  preparationId: string,
): Promise<string> {
  const pointer = await adminPool.query<{
    fence: string;
    pointer_id: MintedUuid;
  }>(
    `SELECT fence, pointer_id FROM platform.active_release_pointers
      WHERE tenant_id = $1 AND environment_id = $2`,
    [tenantA, environmentA],
  );
  const receiptId = minted(randomUUID());
  const digest = (label: string) => createHash('sha256').update(label).digest();
  await withTrustedRequestTransaction(
    runtimePool,
    contexts.a,
    async (client) => {
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
         recovery_mode, generation_id, prepared_subset_digest,
         remaining_plan_digest, executor_schema_state, executor_data_state
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,'sharedDatabase','north_star_module',$9,
         $10,$11,'REVERSIBLE','SATISFIED',true,$12,$13,'APPLIED',true,
         $14,'ALLOW','REVERSIBLE',$15,$16,$17,'APPLIED',$18
       )`,
        [
          tenantA,
          environmentA,
          receiptId,
          TRANSITION_PREPARATION_RECEIPT_V2_VERSION,
          releases.source,
          Buffer.from(prepared.sourceManifestRoot),
          releases.target,
          Buffer.from(prepared.targetManifestRoot),
          prepared.generationNumber,
          COMPILER_TRANSITION_FACTS_VERSION,
          digest('compiler-facts'),
          EXECUTOR_APPLIED_STATE_EVIDENCE_V2_VERSION,
          digest('executor-evidence'),
          TRANSITION_COMPATIBILITY_POLICY_V2_VERSION,
          prepared.generationId,
          Buffer.from(prepared.preparedSubsetDigest),
          Buffer.from(prepared.remainingPlanDigest),
          prepared.dataState,
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
         $1,$2,$3,'northstar.release-activation-preparation/v1',$4,$5,$6,$7,$8,$9,
         'RELEASE_DIFF',$10,'northstar.release-diff/v0-experimental',
         'northstar.release-diff-algorithm/v1',$11,$12,$13,$14,$15,$16,$17,
         'northstar.verification-evidence/v1',$18,
         'northstar.capability-support/v1',$19,'SUPPORTED',
         'northstar.release-diff-renderer/v1','northstar.release-diff-view/v1',$20,$21
       )`,
        [
          tenantA,
          environmentA,
          preparationId,
          pointer.rows[0]!.pointer_id,
          releases.source,
          pointer.rows[0]!.fence,
          Buffer.from(prepared.sourceManifestRoot),
          releases.target,
          Buffer.from(prepared.targetManifestRoot),
          RELEASE_DIFF_BINDING_VERSION,
          digest('canonical-diff'),
          Buffer.from(prepared.transitionPlanDigest),
          Buffer.from(target.attestation.attestationDigest, 'hex'),
          target.bundle.releaseManifest.compilerVersion,
          target.bundle.releaseManifest.compilerSemanticProfileVersion,
          target.bundle.releaseManifest.outputProtocolVersion,
          releases.targetEvidence,
          digest('verification-evidence'),
          digest('capability-support'),
          digest('rendered-diff'),
          receiptId,
        ],
      );
    },
  );
  const activationAttemptId = minted(randomUUID());
  const approval = await new PostgresReleaseApprovalService(
    runtimePool,
  ).createApproval(contexts.approver, {
    activationAttemptId,
    approvalId: minted(randomUUID()),
    approvingHumanId: approverA,
    initiatingHumanId: principalA,
    issuingActorId: approverA,
    preparationId: minted(preparationId),
    targetReleaseId: releases.target,
  });
  return approval.attempt.activationAttemptId;
}

async function firstManagedTable(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'north_star_module' ORDER BY tablename LIMIT 1`,
  );
  return `"${result.rows[0]!.tablename}"`;
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}
