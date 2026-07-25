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
  UNICODE_CASE_FOLD_EXPANSIONS,
  UNICODE_CASE_FOLD_SIMPLE_SOURCES,
  canonicalize,
  canonicalizeAndHash,
  normalizeApplicationPackage,
  unicodeCaseFold,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  HASH_DOMAINS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  expectedActiveReleaseFrom,
  type CompileSuccess,
  type CompilerInput,
  type ContentAddressedArtifact,
  type ProjectionManifestEnvelope,
  type StorageTargetPayloadV1,
  type StorageTransitionEnvelope,
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
  assertSchemaMatchesSnapshot,
  loadMigrations,
  runMigrations,
  SchemaDriftError,
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
const checkedInSnapshot = resolve('db/schema.snapshot.json');
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
          '0008_module_runtime_role_assumption.sql',
          '0009_semantic_operation_receipts.sql',
          '0010_semantic_operation_receipt_scope.sql',
        ]);
        assert.equal(migrationResult.verified.length, 10);
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
      materializerPool.on('error', () => undefined);
      moduleRuntimePool.on('error', () => undefined);
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
        const freshStorage = projectionPayload<StorageTargetPayloadV1>(
          target,
          PROJECTION_FAMILY_IDS.storageTarget,
        );
        await assertIndexPresence(
          pool,
          requiredRelationIndex(freshStorage).physicalName,
          true,
        );

        await t.test(
          'unicode case-folded unique keys are storage-enforced and match the application fold',
          async () => {
            const storage = projectionPayload<StorageTargetPayloadV1>(
              target,
              PROJECTION_FAMILY_IDS.storageTarget,
            );
            const entity = storage.entities.find(
              (candidate) =>
                candidate.entityId === FIXTURE_IDS.entityIds.parent,
            );
            assert.ok(entity);
            const unique = entity.uniqueKeys[0];
            assert.ok(unique);
            const valueColumn = unique.columns.find(
              (column) => !entity.scopeKeyColumns.includes(column as never),
            );
            assert.ok(valueColumn);
            const client = await moduleRuntimePool.connect();
            try {
              await client.query('BEGIN');
              const foldInputs = [
                ...Array.from(UNICODE_CASE_FOLD_SIMPLE_SOURCES),
                ...UNICODE_CASE_FOLD_EXPANSIONS.map(([source]) => source),
                'P-001',
                'Straße-003',
                'Σ-004',
              ];
              const databaseFold = await client.query<{
                folded: string;
                ordinal: string;
              }>(
                `SELECT north_star_module.nsm_unicode_case_fold_v1(input.value) AS folded,
                        input.ordinal::text AS ordinal
                   FROM unnest($1::text[]) WITH ORDINALITY AS input(value, ordinal)
                  ORDER BY input.ordinal`,
                [foldInputs],
              );
              assert.equal(databaseFold.rows.length, foldInputs.length);
              for (const row of databaseFold.rows) {
                const input = foldInputs[Number(row.ordinal) - 1];
                assert.ok(input);
                assert.equal(row.folded, unicodeCaseFold(input), input);
              }

              const pairs = [
                ['P-001', 'P-001'],
                ['Å-002', 'å-002'],
                ['Straße-003', 'STRASSE-003'],
              ] as const;
              for (const [original, duplicate] of pairs) {
                assert.equal(
                  unicodeCaseFold(original),
                  unicodeCaseFold(duplicate),
                );
                await insertUniqueKeyRecord(
                  client,
                  contexts.a,
                  entity,
                  valueColumn,
                  original,
                );
                await client.query('SAVEPOINT duplicate_probe');
                await assert.rejects(
                  insertUniqueKeyRecord(
                    client,
                    contexts.a,
                    entity,
                    valueColumn,
                    duplicate,
                  ),
                  (error: unknown) =>
                    error instanceof Error &&
                    (error as Error & { code?: string }).code === '23505',
                );
                await client.query('ROLLBACK TO SAVEPOINT duplicate_probe');
              }

              await insertUniqueKeyRecord(
                client,
                contexts.b,
                entity,
                valueColumn,
                'p-001',
              );
              const definitions = await pool.query<{ indexdef: string }>(
                `SELECT indexdef
                   FROM pg_indexes
                  WHERE schemaname = 'north_star_module'
                    AND tablename = $1
                    AND indexname = ANY($2::text[])
                  ORDER BY indexname`,
                [
                  entity.physicalTableName,
                  [
                    unique.physicalName,
                    ...entity.indexes
                      .filter(
                        (index) => index.indexKind === 'caseInsensitiveUnique',
                      )
                      .map((index) => index.physicalName),
                  ],
                ],
              );
              assert.equal(definitions.rows.length, 2);
              const foldedColumn = entity.foldedColumns.find(
                (column) => column.sourceColumn === valueColumn,
              );
              assert.ok(foldedColumn);
              for (const definition of definitions.rows) {
                assert.match(
                  definition.indexdef,
                  new RegExp(foldedColumn.physicalName),
                );
                assert.doesNotMatch(
                  definition.indexdef,
                  /nsm_unicode_case_fold_v1/,
                );
                assert.doesNotMatch(definition.indexdef, /\blower\s*\(/i);
              }
            } finally {
              await client.query('ROLLBACK');
              client.release();
            }
          },
        );
        await t.test(
          'a populated-table folded uniqueness transition refuses duplicates without deleting rows',
          async () => {
            await assertPopulatedFoldUniquenessRefusal(pool);
          },
        );
        let firstAttemptId: string | undefined;
        let tenantIsolatedTableName: string | undefined;
        let obsoleteRoot: {
          columnName: string;
          elementId: string;
          generationId: string;
          tableName: string;
        } | null = null;
        let obsoleteRoots: Array<{
          columnName: string;
          elementId: string;
          generationId: string;
          tableName: string;
        }> = [];
        let obsoleteAttemptIds: string[] = [];
        let liveSetSiblingEvidence: {
          pausedAttemptId: string;
          preparationId: string;
          targetReleaseId: string;
          terminalAttemptId: string;
        } | null = null;

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
            firstAttemptId = attemptId;
            const validReader = await readApprovedAttempt(
              materializerPool,
              contexts.a,
              attemptId,
              firstPreparationId,
            );
            assert.deepEqual(validReader, [{ approved: true }]);
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
          'backfill claims survive connection loss and coordinators converge',
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
              schemaVersion: LANGUAGE_VERSION,
              value: '',
            };
            field.storageEvolution = {
              kind: 'backfillEvolution',
              residualReadSemantics: 'coalesceAtRead',
              schemaVersion: LANGUAGE_VERSION,
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
            const prepareScenario = async () => {
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
              return { attemptId, generationId, preparationId, prepared };
            };

            {
              // Loss after the durable claim must resume rather than strand it.
              const scenario = await prepareScenario();
              const planted = await seedBackfillRows(
                pool,
                scenario.generationId,
                125,
              );
              tenantIsolatedTableName = planted.tableName;
              const faulting = new PostgresModuleStorageMaterializer(
                materializerPool,
                moduleRuntimePool,
                {
                  afterClaimCommitted: () => {
                    throw Object.assign(
                      new Error('connection terminated unexpectedly'),
                      { code: 'EPIPE' },
                    );
                  },
                },
              );
              const lost = await faulting.executeApprovedAttempt({
                activationAttemptId: scenario.attemptId,
                context: contexts.a,
                coordinatorId: randomUUID(),
                generationId: scenario.generationId,
              });
              assert.equal(lost.disposition, 'RECONCILING');

              const resumed = await new PostgresModuleStorageMaterializer(
                materializerPool,
                moduleRuntimePool,
              ).executeApprovedAttempt({
                activationAttemptId: scenario.attemptId,
                context: contexts.a,
                coordinatorId: randomUUID(),
                generationId: scenario.generationId,
              });
              assert.equal(resumed.disposition, 'READY_TO_SWAP');
              await assertBackfillCheckpoint(
                pool,
                scenario.generationId,
                125,
                planted,
              );
              const compiledStorage = projectionPayload<StorageTargetPayloadV1>(
                compiled,
                PROJECTION_FAMILY_IDS.storageTarget,
              );
              const parent = compiledStorage.entities.find(
                (entity) => entity.entityId === FIXTURE_IDS.entityIds.parent,
              );
              assert.ok(parent);
              const tierCheck = parent.checkConstraints.find(
                (check) =>
                  check.canonicalFieldId === FIXTURE_IDS.fieldIds.parentTier,
              );
              assert.ok(tierCheck);
              const tierColumn = parent.columns.find(
                (column) =>
                  column.canonicalFieldId === FIXTURE_IDS.fieldIds.parentTier,
              );
              assert.ok(tierColumn);
              const installedCheck = await pool.query<{
                convalidated: boolean;
              }>(
                `SELECT constraint_record.convalidated
                   FROM pg_catalog.pg_constraint AS constraint_record
                   JOIN pg_catalog.pg_class AS relation_record
                     ON relation_record.oid = constraint_record.conrelid
                   JOIN pg_catalog.pg_namespace AS namespace_record
                     ON namespace_record.oid = relation_record.relnamespace
                  WHERE namespace_record.nspname = 'north_star_module'
                    AND relation_record.relname = $1
                    AND constraint_record.conname = $2`,
                [parent.physicalTableName, tierCheck.physicalName],
              );
              assert.deepEqual(installedCheck.rows, [{ convalidated: false }]);
              await assert.rejects(
                pool.query(
                  `UPDATE north_star_module.${quoteTestIdentifier(parent.physicalTableName)}
                      SET ${quoteTestIdentifier(tierColumn.physicalName)} = $1
                    WHERE record_id = $2`,
                  ['not-a-declared-option', planted.recordIds[0]],
                ),
                (error: unknown) =>
                  error instanceof Error &&
                  (error as Error & { code?: string }).code === '23514',
              );
            }

            {
              // A committed mid-backfill checkpoint is the retry cursor.
              const scenario = await prepareScenario();
              const planted = await seedBackfillRows(
                pool,
                scenario.generationId,
                250,
              );
              let injected = false;
              const faulting = new PostgresModuleStorageMaterializer(
                materializerPool,
                moduleRuntimePool,
                {
                  afterBackfillCheckpointCommitted: () => {
                    if (injected) return;
                    injected = true;
                    throw Object.assign(
                      new Error('socket closed unexpectedly'),
                      { code: 'ECONNRESET' },
                    );
                  },
                },
              );
              const lost = await faulting.executeApprovedAttempt({
                activationAttemptId: scenario.attemptId,
                context: contexts.a,
                coordinatorId: randomUUID(),
                generationId: scenario.generationId,
              });
              assert.equal(lost.disposition, 'RECONCILING');
              const partial = await pool.query<{
                complete: boolean;
                rows_applied: string;
              }>(
                `SELECT complete, rows_applied
                   FROM north_star_internal.module_storage_backfill_checkpoints
                  WHERE generation_id = $1`,
                [scenario.generationId],
              );
              assert.deepEqual(partial.rows[0], {
                complete: false,
                rows_applied: '100',
              });

              const resumed = await new PostgresModuleStorageMaterializer(
                materializerPool,
                moduleRuntimePool,
              ).executeApprovedAttempt({
                activationAttemptId: scenario.attemptId,
                context: contexts.a,
                coordinatorId: randomUUID(),
                generationId: scenario.generationId,
              });
              assert.equal(resumed.disposition, 'READY_TO_SWAP');
              await assertBackfillCheckpoint(
                pool,
                scenario.generationId,
                250,
                planted,
              );
            }

            {
              // Concurrent coordinators converge on one durable READY receipt.
              const scenario = await prepareScenario();
              const planted = await seedBackfillRows(
                pool,
                scenario.generationId,
                225,
              );
              const attempts = await Promise.all([
                materializer.executeApprovedAttempt({
                  activationAttemptId: scenario.attemptId,
                  context: contexts.a,
                  coordinatorId: randomUUID(),
                  generationId: scenario.generationId,
                }),
                materializer.executeApprovedAttempt({
                  activationAttemptId: scenario.attemptId,
                  context: contexts.a,
                  coordinatorId: randomUUID(),
                  generationId: scenario.generationId,
                }),
              ]);
              assert.ok(
                attempts.every(
                  (attempt) => attempt.disposition === 'READY_TO_SWAP',
                ),
              );
              assert.equal(
                attempts[0]!.receipt?.receiptId,
                attempts[1]!.receipt?.receiptId,
              );
              await assertBackfillCheckpoint(
                pool,
                scenario.generationId,
                225,
                planted,
              );
              const evidence = await pool.query<{ count: string }>(
                `SELECT count(*)::text AS count
                   FROM north_star_internal.module_storage_element_applications AS application
                   JOIN north_star_internal.module_storage_elements AS element
                     ON element.element_id = application.element_id
                  WHERE application.generation_id = $1
                    AND application.attempt_id = $2
                    AND application.application_state = 'APPLIED'
                    AND element.element_kind = 'backfill'`,
                [scenario.generationId, scenario.attemptId],
              );
              assert.equal(evidence.rows[0]?.count, '1');
              const receipts = await pool.query<{ count: string }>(
                `SELECT count(*)::text AS count
                   FROM north_star_internal.module_storage_catalog_receipts
                  WHERE generation_id = $1
                    AND receipt_state = 'READY_TO_SWAP'
                    AND catalog_verified`,
                [scenario.generationId],
              );
              assert.equal(receipts.rows[0]?.count, '1');
            }

            {
              // Authority is revalidated for every mutation batch.
              const scenario = await prepareScenario();
              const planted = await seedBackfillRows(
                pool,
                scenario.generationId,
                125,
              );
              let revoked = false;
              const revoking = new PostgresModuleStorageMaterializer(
                materializerPool,
                moduleRuntimePool,
                {
                  afterBackfillCheckpointCommitted: async () => {
                    if (revoked) return;
                    revoked = true;
                    await setSystemExecutorAuthority(pool, false);
                  },
                },
              );
              await assert.rejects(
                revoking.executeApprovedAttempt({
                  activationAttemptId: scenario.attemptId,
                  context: contexts.a,
                  coordinatorId: randomUUID(),
                  generationId: scenario.generationId,
                }),
                (error: unknown) =>
                  error instanceof ModuleStorageMaterializationError &&
                  error.code === 'ATTEMPT_NOT_AUTHORIZED',
              );
              const partial = await pool.query<{
                complete: boolean;
                rows_applied: string;
              }>(
                `SELECT complete, rows_applied
                   FROM north_star_internal.module_storage_backfill_checkpoints
                  WHERE generation_id = $1`,
                [scenario.generationId],
              );
              assert.deepEqual(partial.rows[0], {
                complete: false,
                rows_applied: '100',
              });
              await setSystemExecutorAuthority(pool, true);
              const resumed = await materializer.executeApprovedAttempt({
                activationAttemptId: scenario.attemptId,
                context: contexts.a,
                coordinatorId: randomUUID(),
                generationId: scenario.generationId,
              });
              assert.equal(resumed.disposition, 'READY_TO_SWAP');
              await assertBackfillCheckpoint(
                pool,
                scenario.generationId,
                125,
                planted,
              );
            }

            {
              // A completed backfill cannot commit READY after authority changes.
              const scenario = await prepareScenario();
              const planted = await seedBackfillRows(
                pool,
                scenario.generationId,
                1,
              );
              let revoked = false;
              const revoking = new PostgresModuleStorageMaterializer(
                materializerPool,
                moduleRuntimePool,
                {
                  afterBackfillCheckpointCommitted: async () => {
                    if (revoked) return;
                    revoked = true;
                    await setSystemExecutorAuthority(pool, false);
                  },
                },
              );
              await assert.rejects(
                revoking.executeApprovedAttempt({
                  activationAttemptId: scenario.attemptId,
                  context: contexts.a,
                  coordinatorId: randomUUID(),
                  generationId: scenario.generationId,
                }),
                (error: unknown) =>
                  error instanceof ModuleStorageMaterializationError &&
                  error.code === 'ATTEMPT_NOT_AUTHORIZED',
              );
              const readyBeforeRestore = await pool.query<{ count: string }>(
                `SELECT count(*)::text AS count
                   FROM north_star_internal.module_storage_catalog_receipts
                  WHERE generation_id = $1
                    AND receipt_state = 'READY_TO_SWAP'`,
                [scenario.generationId],
              );
              assert.equal(readyBeforeRestore.rows[0]?.count, '0');
              await setSystemExecutorAuthority(pool, true);
              const resumed = await materializer.executeApprovedAttempt({
                activationAttemptId: scenario.attemptId,
                context: contexts.a,
                coordinatorId: randomUUID(),
                generationId: scenario.generationId,
              });
              assert.equal(resumed.disposition, 'READY_TO_SWAP');
              await assertBackfillCheckpoint(
                pool,
                scenario.generationId,
                1,
                planted,
              );
            }

            {
              // Invalid attempts cannot claim, mutate a batch, or commit READY.
              const scenario = await prepareScenario();
              const rejectAttempt = async (attemptId: string) => {
                await assert.rejects(
                  materializer.executeApprovedAttempt({
                    activationAttemptId: attemptId,
                    context: contexts.a,
                    coordinatorId: randomUUID(),
                    generationId: scenario.generationId,
                  }),
                  (error: unknown) =>
                    error instanceof ModuleStorageMaterializationError &&
                    error.code === 'ATTEMPT_NOT_AUTHORIZED',
                );
                const claim = await pool.query<{ count: string }>(
                  `SELECT count(*)::text AS count
                     FROM north_star_internal.module_storage_attempt_claims
                    WHERE activation_attempt_id = $1`,
                  [attemptId],
                );
                assert.equal(claim.rows[0]?.count, '0');
              };

              await expireApproval(pool, scenario.attemptId);
              await rejectAttempt(scenario.attemptId);

              const cancelled = await createAdditionalV2Approval(
                runtimePool,
                contexts,
                next.target,
                scenario.preparationId,
              );
              await new PostgresReleaseActivationService(
                runtimePool,
              ).cancelActivation(contexts.system, {
                activationAttemptId: minted(cancelled),
              });
              await rejectAttempt(cancelled);

              const revokedApprover = await createAdditionalV2Approval(
                runtimePool,
                contexts,
                next.target,
                scenario.preparationId,
              );
              await setApproverEligibility(pool, false);
              await rejectAttempt(revokedApprover);
              await setApproverEligibility(pool, true);

              const revokedExecutor = await createAdditionalV2Approval(
                runtimePool,
                contexts,
                next.target,
                scenario.preparationId,
              );
              await setSystemExecutorAuthority(pool, false);
              await rejectAttempt(revokedExecutor);
              await setSystemExecutorAuthority(pool, true);

              const paused = await createAdditionalV2Approval(
                runtimePool,
                contexts,
                next.target,
                scenario.preparationId,
              );
              await setActivationControl(pool, false, true);
              try {
                const pausedResult = await new PostgresReleaseActivationService(
                  runtimePool,
                ).activate(contexts.system, {
                  activationAttemptId: minted(paused),
                });
                assert.equal(pausedResult.status, 'PAUSED');
                assert.equal(pausedResult.terminal, false);
                assert.equal(pausedResult.decisiveOutcomeCode, null);
                await rejectAttempt(paused);
              } finally {
                await setActivationControl(pool, false, false);
              }
              liveSetSiblingEvidence = {
                pausedAttemptId: paused,
                preparationId: scenario.preparationId,
                targetReleaseId: next.target,
                terminalAttemptId: cancelled,
              };

              const denied = await createAdditionalV2Approval(
                runtimePool,
                contexts,
                next.target,
                scenario.preparationId,
              );
              await setActivationControl(pool, true, false);
              await rejectAttempt(denied);
              await setActivationControl(pool, false, false);
            }

            assert.ok(liveSetSiblingEvidence);
            const openAttempts = await pool.query<{
              activation_attempt_id: string;
            }>(
              `SELECT approval.activation_attempt_id
                 FROM platform.release_approvals AS approval
                WHERE approval.tenant_id = $1
                  AND approval.environment_id = $2
                  AND approval.target_release_id = $3
                  AND NOT EXISTS (
                    SELECT 1
                      FROM platform.release_activation_attempt_outcomes AS outcome
                     WHERE outcome.tenant_id = approval.tenant_id
                       AND outcome.environment_id = approval.environment_id
                       AND outcome.activation_attempt_id =
                             approval.activation_attempt_id
                       AND (
                         outcome.terminal
                         OR outcome.workflow_disposition = 'CONSUMED'
                       )
                  )
                  AND NOT EXISTS (
                    SELECT 1
                      FROM platform.release_activation_history AS history
                     WHERE history.tenant_id = approval.tenant_id
                       AND history.environment_id = approval.environment_id
                       AND (
                         history.approval_id = approval.approval_id
                         OR history.activation_attempt_id =
                              approval.activation_attempt_id
                       )
                       AND (
                         history.terminal
                         OR history.workflow_disposition = 'CONSUMED'
                       )
                  )
                ORDER BY approval.activation_attempt_id`,
              [tenantA, environmentA, next.target],
            );
            const activation = new PostgresReleaseActivationService(
              runtimePool,
            );
            for (const attempt of openAttempts.rows) {
              if (
                attempt.activation_attempt_id ===
                liveSetSiblingEvidence.pausedAttemptId
              ) {
                continue;
              }
              await activation.cancelActivation(contexts.system, {
                activationAttemptId: minted(attempt.activation_attempt_id),
              });
            }
            const siblingEvidence = await pool.query<{
              paused_phase: boolean;
              paused_retired: boolean;
              terminal_retired: boolean;
            }>(
              `SELECT
                 EXISTS (
                   SELECT 1
                     FROM platform.release_activation_phase_receipts AS phase
                    WHERE phase.activation_attempt_id = $1
                      AND phase.phase_code = 'ROLLOUT_PAUSED'
                 ) AS paused_phase,
                 EXISTS (
                   SELECT 1
                     FROM platform.release_activation_attempt_outcomes AS outcome
                    WHERE outcome.activation_attempt_id = $1
                      AND (
                        outcome.terminal
                        OR outcome.workflow_disposition = 'CONSUMED'
                      )
                   UNION ALL
                   SELECT 1
                     FROM platform.release_activation_history AS history
                    WHERE (
                            history.approval_id = (
                              SELECT approval_id
                                FROM platform.release_approvals
                               WHERE activation_attempt_id = $1
                            )
                            OR history.activation_attempt_id = $1
                          )
                      AND (
                        history.terminal
                        OR history.workflow_disposition = 'CONSUMED'
                      )
                 ) AS paused_retired,
                 EXISTS (
                   SELECT 1
                     FROM platform.release_activation_attempt_outcomes AS outcome
                    WHERE outcome.activation_attempt_id = $2
                      AND (
                        outcome.terminal
                        OR outcome.workflow_disposition = 'CONSUMED'
                      )
                   UNION ALL
                   SELECT 1
                     FROM platform.release_activation_history AS history
                    WHERE (
                            history.approval_id = (
                              SELECT approval_id
                                FROM platform.release_approvals
                               WHERE activation_attempt_id = $2
                            )
                            OR history.activation_attempt_id = $2
                          )
                      AND (
                        history.terminal
                        OR history.workflow_disposition = 'CONSUMED'
                      )
                 ) AS terminal_retired`,
              [
                liveSetSiblingEvidence.pausedAttemptId,
                liveSetSiblingEvidence.terminalAttemptId,
              ],
            );
            assert.deepEqual(siblingEvidence.rows[0], {
              paused_phase: true,
              paused_retired: false,
              terminal_retired: true,
            });
            const mixedSiblingRoots = await readKernelLiveRoots(
              materializerPool,
              contexts.a,
            );
            assert.ok(
              mixedSiblingRoots.includes(
                liveSetSiblingEvidence.targetReleaseId,
              ),
            );

            await materializer.verifyLiveCatalog(contexts.a);
            const accounted = await pool.query<{
              element_id: string;
              generation_id: string;
              live_root_count: string;
              physical_object_name: string;
            }>(
              `SELECT generation.generation_id, element.element_id,
                      element.physical_object_name,
                      reference.live_root_count::text
                 FROM north_star_internal.module_storage_generations AS generation
                 JOIN north_star_internal.module_storage_root_membership AS membership
                   ON membership.tenant_id = generation.tenant_id
                  AND membership.environment_id = generation.environment_id
                  AND membership.generation_id = generation.generation_id
                 JOIN north_star_internal.module_storage_elements AS element
                   ON element.element_id = membership.element_id
                 JOIN north_star_internal.module_storage_reference_counts AS reference
                   ON reference.tenant_id = generation.tenant_id
                  AND reference.environment_id = generation.environment_id
                  AND reference.generation_id = generation.generation_id
                  AND reference.element_id = element.element_id
                WHERE generation.tenant_id = $1
                  AND generation.environment_id = $2
                  AND generation.target_release_id = $3
                  AND element.element_kind = 'addColumn'
                ORDER BY generation.generation_number,
                         element.physical_object_name`,
              [tenantA, environmentA, next.target],
            );
            assert.ok(accounted.rows.length > 0);
            obsoleteRoots = [];
            for (const row of accounted.rows) {
              assert.ok(Number(row.live_root_count) > 0);
              const containingTable = await pool.query<{
                table_name: string;
              }>(
                `SELECT relation.relname AS table_name
                   FROM pg_catalog.pg_attribute AS attribute
                   JOIN pg_catalog.pg_class AS relation
                     ON relation.oid = attribute.attrelid
                   JOIN pg_catalog.pg_namespace AS namespace
                     ON namespace.oid = relation.relnamespace
                  WHERE namespace.nspname = 'north_star_module'
                    AND attribute.attname = $1
                    AND attribute.attnum > 0
                    AND NOT attribute.attisdropped`,
                [row.physical_object_name],
              );
              assert.equal(containingTable.rowCount, 1);
              obsoleteRoots.push({
                columnName: row.physical_object_name,
                elementId: row.element_id,
                generationId: row.generation_id,
                tableName: containingTable.rows[0]!.table_name,
              });
            }
            obsoleteRoot = obsoleteRoots[0] ?? null;

            const attempts = await pool.query<{
              activation_attempt_id: string;
            }>(
              `SELECT approval.activation_attempt_id
                 FROM platform.release_approvals AS approval
                WHERE approval.tenant_id = $1
                  AND approval.environment_id = $2
                  AND approval.target_release_id = $3
                  AND NOT EXISTS (
                    SELECT 1
                      FROM platform.release_activation_attempt_outcomes AS outcome
                     WHERE outcome.tenant_id = approval.tenant_id
                       AND outcome.environment_id = approval.environment_id
                       AND outcome.activation_attempt_id =
                             approval.activation_attempt_id
                  )
                  AND NOT EXISTS (
                    SELECT 1
                      FROM platform.release_activation_history AS history
                     WHERE history.tenant_id = approval.tenant_id
                       AND history.environment_id = approval.environment_id
                       AND history.activation_attempt_id =
                             approval.activation_attempt_id
                       AND (
                         history.terminal
                         OR history.workflow_disposition = 'CONSUMED'
                       )
                  )
                ORDER BY approval.activation_attempt_id`,
              [tenantA, environmentA, next.target],
            );
            obsoleteAttemptIds = attempts.rows.map(
              (attempt) => attempt.activation_attempt_id,
            );
            assert.deepEqual(obsoleteAttemptIds, [
              liveSetSiblingEvidence.pausedAttemptId,
            ]);
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
          'DDL, evidence, and scoped kernel readers stay role-isolated',
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
            assert.ok(tenantIsolatedTableName);
            const managedTable = quoteTestIdentifier(tenantIsolatedTableName);
            const seededRows = await pool.query<{ count: string }>(
              `SELECT count(*)::text AS count
                 FROM north_star_module.${managedTable}
                WHERE tenant_id = $1 AND environment_id = $2`,
              [tenantA, environmentA],
            );
            assert.ok(Number(seededRows.rows[0]?.count) > 0);

            const tenantBClient = await moduleRuntimePool.connect();
            try {
              await tenantBClient.query('BEGIN');
              await tenantBClient.query(
                `SELECT set_config('north_star.tenant_id', $1, true),
                        set_config('north_star.environment_id', $2, true)`,
                [tenantB, environmentB],
              );
              const crossTenantRows = await tenantBClient.query<{
                count: string;
              }>(
                `SELECT count(*)::text AS count
                   FROM north_star_module.${managedTable}`,
              );
              assert.equal(crossTenantRows.rows[0]?.count, '0');
              await tenantBClient.query('COMMIT');
            } catch (error) {
              await tenantBClient.query('ROLLBACK');
              throw error;
            } finally {
              tenantBClient.release();
            }

            const ddlClient = await materializerPool.connect();
            try {
              await ddlClient.query('BEGIN');
              await ddlClient.query(
                `SELECT set_config('north_star.tenant_id', $1, true),
                        set_config('north_star.environment_id', $2, true)`,
                [tenantA, environmentA],
              );
              const ddlVisibleRows = await ddlClient.query<{ count: string }>(
                `SELECT count(*)::text AS count
                   FROM north_star_module.${managedTable}`,
              );
              assert.equal(ddlVisibleRows.rows[0]?.count, '0');
              await ddlClient.query('COMMIT');
            } catch (error) {
              await ddlClient.query('ROLLBACK');
              throw error;
            } finally {
              ddlClient.release();
            }

            await assert.rejects(
              runtimePool.query(
                'CREATE TABLE north_star_module.forbidden(id uuid)',
              ),
              /permission denied/,
            );
            await assert.rejects(
              moduleRuntimePool.query(
                `DELETE FROM north_star_module.${managedTable}`,
              ),
              /permission denied/,
            );
            await assert.rejects(
              runtimePool.query(
                'SELECT * FROM north_star_internal.module_storage_element_applications',
              ),
              /permission denied/,
            );
            await assert.rejects(
              runtimePool.query(
                `UPDATE north_star_internal.module_storage_generations
                    SET state = state WHERE false`,
              ),
              /permission denied/,
            );
            await assert.rejects(
              runtimePool.query(
                `SELECT *
                   FROM north_star_internal.module_storage_read_active_release_pointer($1, $2)`,
                [tenantA, environmentA],
              ),
              /permission denied/,
            );
            await assert.rejects(
              moduleRuntimePool.query(
                `SELECT *
                   FROM north_star_internal.module_storage_read_kernel_live_roots($1, $2)`,
                [tenantA, environmentA],
              ),
              /permission denied/,
            );
            assert.ok(firstAttemptId);
            const policies = await pool.query<{
              policyname: string;
              tablename: string;
            }>(
              `SELECT tablename, policyname
                 FROM pg_policies
                WHERE schemaname = 'platform'
                  AND 'north_star_module_materializer' = ANY(roles::text[])
                ORDER BY tablename, policyname`,
            );
            assert.deepEqual(policies.rows, []);

            const directPlatformReads = await pool.query<{
              relation: string;
            }>(
              `SELECT relation.relname AS relation
                 FROM pg_class AS relation
                 JOIN pg_namespace AS namespace
                   ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = 'platform'
                  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
                  AND has_table_privilege(
                    'north_star_module_materializer', relation.oid, 'SELECT'
                  )
                ORDER BY relation.relname`,
            );
            assert.deepEqual(directPlatformReads.rows, []);

            const functions = await pool.query<{
              materializer_execute: boolean;
              module_runtime_execute: boolean;
              name: string;
              runtime_execute: boolean;
              search_path: string[] | null;
              security_definer: boolean;
            }>(
              `SELECT routine.proname AS name,
                      routine.prosecdef AS security_definer,
                      routine.proconfig AS search_path,
                      has_function_privilege(
                        'north_star_module_materializer', routine.oid, 'EXECUTE'
                      ) AS materializer_execute,
                      has_function_privilege(
                        'north_star_runtime', routine.oid, 'EXECUTE'
                      ) AS runtime_execute,
                      has_function_privilege(
                        'north_star_module_runtime', routine.oid, 'EXECUTE'
                      ) AS module_runtime_execute
                 FROM pg_proc AS routine
                 JOIN pg_namespace AS namespace
                   ON namespace.oid = routine.pronamespace
                WHERE namespace.nspname = 'north_star_internal'
                  AND routine.proname LIKE 'module_storage_read_%'
                ORDER BY routine.proname`,
            );
            assert.equal(functions.rows.length, 5);
            for (const reader of functions.rows) {
              assert.equal(reader.security_definer, true, reader.name);
              assert.deepEqual(reader.search_path, ['search_path=pg_catalog']);
              assert.equal(reader.materializer_execute, true, reader.name);
              assert.equal(reader.runtime_execute, false, reader.name);
              assert.equal(reader.module_runtime_execute, false, reader.name);
            }
            const mutationGate = await pool.query<{
              materializer_execute: boolean;
              module_runtime_execute: boolean;
              runtime_execute: boolean;
              search_path: string[] | null;
              security_definer: boolean;
            }>(
              `SELECT routine.prosecdef AS security_definer,
                      routine.proconfig AS search_path,
                      has_function_privilege(
                        'north_star_module_materializer', routine.oid, 'EXECUTE'
                      ) AS materializer_execute,
                      has_function_privilege(
                        'north_star_runtime', routine.oid, 'EXECUTE'
                      ) AS runtime_execute,
                      has_function_privilege(
                        'north_star_module_runtime', routine.oid, 'EXECUTE'
                      ) AS module_runtime_execute
                 FROM pg_proc AS routine
                 JOIN pg_namespace AS namespace
                   ON namespace.oid = routine.pronamespace
                WHERE namespace.nspname = 'north_star_internal'
                  AND routine.proname =
                        'module_storage_lock_backfill_attempt'`,
            );
            assert.deepEqual(mutationGate.rows[0], {
              materializer_execute: false,
              module_runtime_execute: true,
              runtime_execute: false,
              search_path: ['search_path=pg_catalog'],
              security_definer: true,
            });
            await assert.rejects(
              runtimePool.query(
                `SELECT authorized
                   FROM north_star_internal.module_storage_lock_backfill_attempt($1,$2,$3,$4)`,
                [tenantA, environmentA, firstAttemptId, firstPreparationId],
              ),
              /permission denied/,
            );
            const consumedMutationGate = await moduleRuntimePool.query(
              `SELECT authorized
                 FROM north_star_internal.module_storage_lock_backfill_attempt($1,$2,$3,$4)`,
              [tenantA, environmentA, firstAttemptId, firstPreparationId],
            );
            assert.deepEqual(consumedMutationGate.rows, []);

            const client = await materializerPool.connect();
            try {
              await client.query('BEGIN');
              await client.query(
                `SELECT set_config('north_star.tenant_id', $1, true),
                        set_config('north_star.environment_id', $2, true)`,
                [tenantA, environmentA],
              );
              const pointer = await client.query<{ release_id: string }>(
                `SELECT release_id
                   FROM north_star_internal.module_storage_read_active_release_pointer($1, $2)`,
                [tenantA, environmentA],
              );
              assert.equal(pointer.rowCount, 1);
              const crossTenantPointer = await client.query(
                `SELECT *
                   FROM north_star_internal.module_storage_read_active_release_pointer($1, $2)`,
                [tenantB, environmentB],
              );
              assert.equal(crossTenantPointer.rowCount, 0);

              const artifacts = await client.query<{
                release_content_hash: string;
              }>(
                `SELECT release_content_hash
                   FROM north_star_internal.module_storage_read_release_artifacts($1, $2, $3)`,
                [tenantA, environmentA, releases.a.source],
              );
              assert.ok((artifacts.rowCount ?? 0) > 0);
              assert.ok(
                artifacts.rows.every(
                  (row) =>
                    row.release_content_hash ===
                    Buffer.from(first.sourceManifestRoot).toString('hex'),
                ),
              );
              const crossTenantArtifacts = await client.query(
                `SELECT *
                   FROM north_star_internal.module_storage_read_release_artifacts($1, $2, $3)`,
                [tenantB, environmentB, releases.b.source],
              );
              assert.equal(crossTenantArtifacts.rowCount, 0);

              const authority = await client.query<{ authorized: boolean }>(
                `SELECT authorized
                   FROM north_star_internal.module_storage_read_preparation_authority($1, $2, $3)`,
                [tenantA, environmentA, principalA],
              );
              assert.deepEqual(authority.rows, [{ authorized: true }]);
              const crossTenantAuthority = await client.query(
                `SELECT *
                   FROM north_star_internal.module_storage_read_preparation_authority($1, $2, $3)`,
                [tenantB, environmentB, principalB],
              );
              assert.equal(crossTenantAuthority.rowCount, 0);

              const approvedAttempt = await client.query(
                `SELECT approved
                   FROM north_star_internal.module_storage_read_approved_attempt($1, $2, $3, $4)`,
                [tenantA, environmentA, firstAttemptId, firstPreparationId],
              );
              assert.deepEqual(approvedAttempt.rows, []);
              const crossTenantAttempt = await client.query(
                `SELECT *
                   FROM north_star_internal.module_storage_read_approved_attempt($1, $2, $3, $4)`,
                [tenantB, environmentB, firstAttemptId, firstPreparationId],
              );
              assert.equal(crossTenantAttempt.rowCount, 0);

              const roots = await client.query<{ release_id: string }>(
                `SELECT release_id
                   FROM north_star_internal.module_storage_read_kernel_live_roots($1, $2)`,
                [tenantA, environmentA],
              );
              assert.ok((roots.rowCount ?? 0) > 0);
              const crossTenantRoots = await client.query(
                `SELECT *
                   FROM north_star_internal.module_storage_read_kernel_live_roots($1, $2)`,
                [tenantB, environmentB],
              );
              assert.equal(crossTenantRoots.rowCount, 0);
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          },
        );

        await t.test(
          'live-set reconciliation rejects altered, surplus, unknown, and destructive objects',
          async () => {
            assert.ok(obsoleteRoot);
            assert.ok(obsoleteRoots.length > 0);
            assert.ok(obsoleteAttemptIds.length > 0);
            assert.ok(liveSetSiblingEvidence);
            const liveSet = liveSetSiblingEvidence;
            const activation = new PostgresReleaseActivationService(
              runtimePool,
            );
            for (const attemptId of obsoleteAttemptIds) {
              await activation.cancelActivation(contexts.system, {
                activationAttemptId: minted(attemptId),
              });
            }
            const retiredSiblings = await pool.query<{
              approval_count: string;
              retired_count: string;
            }>(
              `SELECT count(*)::text AS approval_count,
                      count(*) FILTER (
                        WHERE EXISTS (
                          SELECT 1
                            FROM platform.release_activation_attempt_outcomes AS outcome
                           WHERE outcome.tenant_id = approval.tenant_id
                             AND outcome.environment_id = approval.environment_id
                             AND outcome.activation_attempt_id =
                                   approval.activation_attempt_id
                             AND (
                               outcome.terminal
                               OR outcome.workflow_disposition = 'CONSUMED'
                             )
                        )
                        OR EXISTS (
                          SELECT 1
                            FROM platform.release_activation_history AS history
                           WHERE history.tenant_id = approval.tenant_id
                             AND history.environment_id = approval.environment_id
                             AND (
                               history.approval_id = approval.approval_id
                               OR history.activation_attempt_id =
                                    approval.activation_attempt_id
                             )
                             AND (
                               history.terminal
                               OR history.workflow_disposition = 'CONSUMED'
                             )
                        )
                      )::text AS retired_count
                 FROM platform.release_approvals AS approval
                WHERE approval.tenant_id = $1
                  AND approval.environment_id = $2
                  AND approval.preparation_id = $3`,
              [tenantA, environmentA, liveSet.preparationId],
            );
            assert.ok(
              Number(retiredSiblings.rows[0]?.approval_count) > 1,
              'the retirement proof requires multiple approval siblings',
            );
            assert.equal(
              retiredSiblings.rows[0]?.retired_count,
              retiredSiblings.rows[0]?.approval_count,
            );
            const retiredRoots = await readKernelLiveRoots(
              materializerPool,
              contexts.a,
            );
            assert.ok(!retiredRoots.includes(liveSet.targetReleaseId));
            await assertCatalogDrift(
              materializer,
              contexts.a,
              new RegExp(
                `surplus managed column ${obsoleteRoot.tableName}\\.${obsoleteRoot.columnName}`,
              ),
            );
            const staleReference = await pool.query<{
              live_root_count: string;
            }>(
              `SELECT live_root_count::text
                 FROM north_star_internal.module_storage_reference_counts
                WHERE tenant_id = $1 AND environment_id = $2
                  AND generation_id = $3 AND element_id = $4`,
              [
                tenantA,
                environmentA,
                obsoleteRoot.generationId,
                obsoleteRoot.elementId,
              ],
            );
            assert.ok(Number(staleReference.rows[0]?.live_root_count) > 0);
            for (const root of obsoleteRoots) {
              await pool.query(
                `ALTER TABLE north_star_module.${quoteTestIdentifier(root.tableName)}
                   DROP COLUMN ${quoteTestIdentifier(root.columnName)}`,
              );
            }
            const verification = await materializer.verifyLiveCatalog(
              contexts.a,
            );
            assert.deepEqual(verification.drift, []);
            const reconciledReference = await pool.query<{
              live_root_count: string;
            }>(
              `SELECT live_root_count::text
                 FROM north_star_internal.module_storage_reference_counts
                WHERE tenant_id = $1 AND environment_id = $2
                  AND generation_id = $3 AND element_id = $4`,
              [
                tenantA,
                environmentA,
                obsoleteRoot.generationId,
                obsoleteRoot.elementId,
              ],
            );
            assert.equal(reconciledReference.rows[0]?.live_root_count, '0');
            const tableName = await firstManagedTableName(pool);

            await pool.query(
              `ALTER TABLE north_star_module."${tableName}"
                 ALTER COLUMN revision DROP DEFAULT`,
            );
            await assertCatalogDrift(
              materializer,
              contexts.a,
              /altered managed column/,
            );
            await pool.query(
              `ALTER TABLE north_star_module."${tableName}"
                 ALTER COLUMN revision SET DEFAULT 1`,
            );

            await pool.query(
              `ALTER TABLE north_star_module."${tableName}"
                 NO FORCE ROW LEVEL SECURITY`,
            );
            await assertCatalogDrift(
              materializer,
              contexts.a,
              /altered managed relation/,
            );
            await pool.query(
              `ALTER TABLE north_star_module."${tableName}"
                 FORCE ROW LEVEL SECURITY`,
            );

            await pool.query(
              `CREATE INDEX rogue_index
                 ON north_star_module."${tableName}" (revision)`,
            );
            await assertCatalogDrift(
              materializer,
              contexts.a,
              /surplus managed index/,
            );
            await pool.query('DROP INDEX north_star_module.rogue_index');

            await pool.query(
              `ALTER TABLE north_star_module."${tableName}"
                 ADD CONSTRAINT rogue_constraint CHECK (revision > 0)`,
            );
            await assertCatalogDrift(
              materializer,
              contexts.a,
              /surplus managed constraint/,
            );
            await pool.query(
              `ALTER TABLE north_star_module."${tableName}"
                 DROP CONSTRAINT rogue_constraint`,
            );

            await pool.query(
              `CREATE POLICY rogue_policy
                 ON north_star_module."${tableName}"
                 FOR SELECT TO north_star_module_runtime USING (true)`,
            );
            await assertCatalogDrift(
              materializer,
              contexts.a,
              /surplus managed policy/,
            );
            await pool.query(
              `DROP POLICY rogue_policy
                 ON north_star_module."${tableName}"`,
            );

            await pool.query(
              'CREATE SEQUENCE north_star_module.rogue_sequence',
            );
            await assertCatalogDrift(
              materializer,
              contexts.a,
              /surplus managed relation/,
            );
            await pool.query('DROP SEQUENCE north_star_module.rogue_sequence');

            await pool.query(`
              CREATE FUNCTION north_star_module.rogue_function()
              RETURNS integer LANGUAGE sql SET search_path = pg_catalog
              AS $$ SELECT 1 $$;
            `);
            await assertCatalogDrift(
              materializer,
              contexts.a,
              /surplus managed function/,
            );
            await pool.query(
              'DROP FUNCTION north_star_module.rogue_function()',
            );

            const foldFunctionDefinition = await pool.query<{
              definition: string;
            }>(
              `SELECT pg_get_functiondef(routine.oid) AS definition
                 FROM pg_proc AS routine
                 JOIN pg_namespace AS namespace
                   ON namespace.oid = routine.pronamespace
                WHERE namespace.nspname = 'north_star_module'
                  AND routine.proname = 'nsm_unicode_case_fold_v1'
                  AND pg_get_function_identity_arguments(routine.oid) =
                        'value text'`,
            );
            assert.equal(foldFunctionDefinition.rows.length, 1);
            await pool.query(
              `CREATE OR REPLACE FUNCTION north_star_module.nsm_unicode_case_fold_v1(value text)
                 RETURNS text
                 LANGUAGE sql
                 IMMUTABLE STRICT PARALLEL SAFE
                 SET search_path = pg_catalog
                 AS $case_fold$ SELECT value $case_fold$`,
            );
            await assertCatalogDrift(
              materializer,
              contexts.a,
              /managed function source digest nsm_unicode_case_fold_v1\(value text\)/,
            );
            await pool.query(foldFunctionDefinition.rows[0]!.definition);

            await pool.query(
              `CREATE TYPE north_star_module.rogue_type AS ENUM ('rogue')`,
            );
            await assertCatalogDrift(
              materializer,
              contexts.a,
              /surplus managed standalone type/,
            );
            await pool.query('DROP TYPE north_star_module.rogue_type');

            await pool.query(`
              CREATE FUNCTION platform.snapshot_probe()
              RETURNS integer LANGUAGE sql SET search_path = pg_catalog
              AS $$ SELECT 1 $$;
            `);
            await assertKernelSnapshotDrift(pool);
            await pool.query('DROP FUNCTION platform.snapshot_probe()');

            await pool.query(
              'GRANT USAGE ON SCHEMA platform TO north_star_module_runtime',
            );
            await assertKernelSnapshotDrift(pool);
            await pool.query(
              'REVOKE USAGE ON SCHEMA platform FROM north_star_module_runtime',
            );

            await pool.query(
              `ALTER DEFAULT PRIVILEGES IN SCHEMA platform
                 GRANT SELECT ON TABLES TO north_star_module_runtime`,
            );
            await assertKernelSnapshotDrift(pool);
            await pool.query(
              `ALTER DEFAULT PRIVILEGES IN SCHEMA platform
                 REVOKE SELECT ON TABLES FROM north_star_module_runtime`,
            );

            await pool.query(
              'CREATE SEQUENCE platform.snapshot_probe_sequence',
            );
            await assertKernelSnapshotDrift(pool);
            await pool.query('DROP SEQUENCE platform.snapshot_probe_sequence');

            await pool.query(
              `CREATE TYPE platform.snapshot_probe_type AS ENUM ('probe')`,
            );
            await assertKernelSnapshotDrift(pool);
            await pool.query('DROP TYPE platform.snapshot_probe_type');
            await assertKernelSnapshotMatches(pool);

            await pool.query('CREATE ROLE arbitrary_destructive_grantee');
            try {
              await pool.query(
                `ALTER SCHEMA north_star_module
                   OWNER TO arbitrary_destructive_grantee`,
              );
              await assertCatalogDrift(
                materializer,
                contexts.a,
                /altered schema/,
              );
              await pool.query(
                `ALTER SCHEMA north_star_module
                   OWNER TO north_star_module_materializer`,
              );

              await pool.query(
                `GRANT DELETE ON north_star_module."${tableName}"
                   TO arbitrary_destructive_grantee`,
              );
              await assertCatalogDrift(
                materializer,
                contexts.a,
                /destructive table privilege DELETE.*arbitrary_destructive_grantee/,
              );
              await pool.query(
                `REVOKE DELETE ON north_star_module."${tableName}"
                   FROM arbitrary_destructive_grantee`,
              );
              await pool.query(
                `GRANT SELECT (record_id)
                   ON north_star_module."${tableName}"
                   TO arbitrary_destructive_grantee`,
              );
              await assertCatalogDrift(
                materializer,
                contexts.a,
                /surplus managed column grant/,
              );
              await pool.query(
                `REVOKE SELECT (record_id)
                   ON north_star_module."${tableName}"
                   FROM arbitrary_destructive_grantee`,
              );
            } finally {
              await pool.query(
                'DROP ROLE IF EXISTS arbitrary_destructive_grantee',
              );
            }

            await pool.query(`
              CREATE FUNCTION north_star_module.rogue_trigger_function()
              RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
              AS $$ BEGIN RETURN OLD; END $$;
              CREATE TRIGGER rogue_delete_trigger
                BEFORE DELETE ON north_star_module."${tableName}"
                FOR EACH ROW EXECUTE FUNCTION
                  north_star_module.rogue_trigger_function();
            `);
            await assertCatalogDrift(
              materializer,
              contexts.a,
              /surplus managed trigger/,
            );
            await pool.query(
              `DROP TRIGGER rogue_delete_trigger
                 ON north_star_module."${tableName}";
               DROP FUNCTION north_star_module.rogue_trigger_function()`,
            );

            await pool.query(
              `CREATE RULE rogue_delete_rule AS
                 ON DELETE TO north_star_module."${tableName}"
                 DO INSTEAD NOTHING`,
            );
            await assertCatalogDrift(
              materializer,
              contexts.a,
              /surplus managed rule/,
            );
            await pool.query(
              `DROP RULE rogue_delete_rule
                 ON north_star_module."${tableName}"`,
            );

            await pool.query(
              'CREATE TABLE public.rogue_module_object(id uuid)',
            );
            await assertCatalogDrift(materializer, contexts.a, /0 verifiers/);
            await pool.query('DROP TABLE public.rogue_module_object');
            assert.deepEqual(
              (await materializer.verifyLiveCatalog(contexts.a)).drift,
              [],
            );
          },
        );

        await t.test(
          'stored provenance is append-only and missing objects fail closed',
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
            assert.ok(Number(evidence.rows[0]?.generations) >= 3);
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

            const tableName = await firstManagedTableName(pool);
            await pool.query(
              `DROP TABLE north_star_module."${tableName}" CASCADE`,
            );
            await assertCatalogDrift(
              materializer,
              contexts.a,
              new RegExp(`missing managed relation ${tableName}`),
            );
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

test('a pre-existing relation-index upgrade is declared but deferred-online execution is unavailable', async () => {
  const emptyDefinition = emptyModuleDefinition();
  const source = mustCompile(moduleInput(emptyDefinition));
  const currentDefinition = ordinaryModuleV1();
  const currentBytes = definitionBytes(currentDefinition);
  const originallyCompiled = mustCompile(
    moduleInput(currentDefinition, expectedActiveReleaseFrom(source)),
  );
  const legacy = withoutRelationIndexes(originallyCompiled);
  const upgrade = mustCompile(
    moduleInput(currentDefinition, expectedActiveReleaseFrom(legacy)),
  );
  const upgradeStorage = projectionPayload<StorageTargetPayloadV1>(
    upgrade,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const relationIndex = requiredRelationIndex(upgradeStorage);
  const upgradeTransition = projectionPayload<StorageTransitionEnvelope>(
    upgrade,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  assert.ok(
    upgradeTransition.elements.some(
      (element) =>
        element.kind === 'createIndex' &&
        element.physicalObjectName === relationIndex.physicalName,
    ),
  );

  await withEphemeralPostgres(
    'module-relation-index-upgrade',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        const migrationResult = await runMigrations(
          admin,
          await loadMigrations(migrations),
        );
        assert.equal(migrationResult.verified.length, 10);
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
      materializerPool.on('error', () => undefined);
      moduleRuntimePool.on('error', () => undefined);
      try {
        const contexts = await trustedContexts();
        const releases = await persistPairForBothTenants(
          runtimePool,
          contexts,
          source,
          definitionBytes(emptyDefinition),
          legacy,
          currentBytes,
        );
        const next = await persistNextRelease(
          runtimePool,
          contexts.a,
          releases.a.target,
          upgrade,
          currentBytes,
        );
        await installSourcePointers(pool, releases);
        await grantExecutorAuthority(pool);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          moduleRuntimePool,
        );

        const legacyGenerationId = randomUUID();
        const legacyPreparationId = randomUUID();
        const legacyPreparation = await materializer.prepare({
          context: contexts.a,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generationId: legacyGenerationId,
          initiatedBy: principalA,
          preparationId: legacyPreparationId,
          targetReleaseId: releases.a.target,
        });
        assert.equal(legacyPreparation.schemaState, 'APPLIED');
        await assertIndexPresence(pool, relationIndex.physicalName, false);

        await setActiveReleasePointer(pool, releases.a.target);
        const generationId = randomUUID();
        const preparationId = randomUUID();
        await assert.rejects(
          materializer.prepare({
            context: contexts.a,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            generationId,
            initiatedBy: principalA,
            preparationId,
            targetReleaseId: next.target,
          }),
          (error: unknown) =>
            error instanceof ModuleStorageMaterializationError &&
            error.code === 'CATALOG_DRIFT' &&
            error.message.includes(
              `missing managed index ${sourceEntityName(upgradeStorage, relationIndex)}.${relationIndex.physicalName}`,
            ),
        );
        await assertIndexPresence(pool, relationIndex.physicalName, false);
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

test('a pre-existing folded-column upgrade is declared but remains at the catalog-drift boundary', async () => {
  const emptyDefinition = emptyModuleDefinition();
  const source = mustCompile(moduleInput(emptyDefinition));
  const currentDefinition = ordinaryModuleV1();
  const currentBytes = definitionBytes(currentDefinition);
  const originallyCompiled = mustCompile(
    moduleInput(currentDefinition, expectedActiveReleaseFrom(source)),
  );
  const legacy = withoutFoldedAccess(originallyCompiled);
  const upgrade = mustCompile(
    moduleInput(currentDefinition, expectedActiveReleaseFrom(legacy)),
  );
  const upgradeStorage = projectionPayload<StorageTargetPayloadV1>(
    upgrade,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const parent = upgradeStorage.entities.find(
    (entity) => entity.entityId === FIXTURE_IDS.entityIds.parent,
  );
  assert.ok(parent);
  const foldedColumn = parent.foldedColumns.find(
    (column) => column.canonicalFieldId === FIXTURE_IDS.fieldIds.parentName,
  );
  assert.ok(foldedColumn);
  const foldedIndex = parent.indexes.find(
    (index) =>
      index.indexKind === 'foldedAccess' &&
      index.columnNames.includes(foldedColumn.physicalName),
  );
  assert.ok(foldedIndex);
  const upgradeTransition = projectionPayload<StorageTransitionEnvelope>(
    upgrade,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  const addColumn = upgradeTransition.elements.find(
    (element) =>
      element.kind === 'addColumn' &&
      element.physicalObjectName === foldedColumn.physicalName,
  );
  assert.ok(addColumn);
  assert.equal(
    addColumn.classification.preparationValidity,
    'deferredOnlineFamily',
  );
  assert.equal(addColumn.classification.dataEffect, 'rowMutation');
  assert.ok(
    upgradeTransition.elements.some(
      (element) =>
        element.kind === 'createIndex' &&
        element.physicalObjectName === foldedIndex.physicalName &&
        element.declaredDependencyIds.includes(addColumn.elementId),
    ),
  );

  await withEphemeralPostgres(
    'module-folded-column-upgrade',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        const migrationResult = await runMigrations(
          admin,
          await loadMigrations(migrations),
        );
        assert.equal(migrationResult.verified.length, 10);
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
      materializerPool.on('error', () => undefined);
      moduleRuntimePool.on('error', () => undefined);
      try {
        const contexts = await trustedContexts();
        const releases = await persistPairForBothTenants(
          runtimePool,
          contexts,
          source,
          definitionBytes(emptyDefinition),
          legacy,
          currentBytes,
        );
        const next = await persistNextRelease(
          runtimePool,
          contexts.a,
          releases.a.target,
          upgrade,
          currentBytes,
        );
        await installSourcePointers(pool, releases);
        await grantExecutorAuthority(pool);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          moduleRuntimePool,
        );

        await materializer.prepare({
          context: contexts.a,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generationId: randomUUID(),
          initiatedBy: principalA,
          preparationId: randomUUID(),
          targetReleaseId: releases.a.target,
        });
        await assertManagedColumnPresence(
          pool,
          parent.physicalTableName,
          foldedColumn.physicalName,
          false,
        );

        await setActiveReleasePointer(pool, releases.a.target);
        let boundaryError: unknown;
        try {
          await materializer.prepare({
            context: contexts.a,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            generationId: randomUUID(),
            initiatedBy: principalA,
            preparationId: randomUUID(),
            targetReleaseId: next.target,
          });
        } catch (error) {
          boundaryError = error;
        }
        assert.ok(boundaryError instanceof ModuleStorageMaterializationError);
        assert.equal(boundaryError.code, 'CATALOG_DRIFT');
        assert.match(
          boundaryError.message,
          new RegExp(
            `missing managed column ${parent.physicalTableName}\\.${foldedColumn.physicalName}`,
          ),
        );
        console.log(
          `PR-6b pre-existing folded-column boundary:\nerror: ${boundaryError.message}\ncode: ${boundaryError.code}`,
        );
        await assertManagedColumnPresence(
          pool,
          parent.physicalTableName,
          foldedColumn.physicalName,
          false,
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

async function assertPopulatedFoldUniquenessRefusal(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query(
      `CREATE TEMPORARY TABLE pr6b_fold_transition_probe (
         tenant_id uuid NOT NULL,
         environment_id uuid NOT NULL,
         value text NOT NULL
       )`,
    );
    await client.query(
      `INSERT INTO pr6b_fold_transition_probe
         (tenant_id, environment_id, value)
       VALUES ($1, $2, 'Straße-001'), ($1, $2, 'STRASSE-001')`,
      [tenantA, environmentA],
    );
    const before = await client.query<{ value: string }>(
      `SELECT value FROM pr6b_fold_transition_probe ORDER BY value COLLATE "C"`,
    );
    await client.query(
      `ALTER TABLE pr6b_fold_transition_probe
         ADD COLUMN value_folded text COLLATE "C"
         GENERATED ALWAYS AS (
           north_star_module.nsm_unicode_case_fold_v1(value)
         ) STORED`,
    );
    await assert.rejects(
      client.query(
        `CREATE UNIQUE INDEX pr6b_fold_transition_probe_unique
           ON pr6b_fold_transition_probe
           (tenant_id, environment_id, value_folded)`,
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === '23505',
    );
    const after = await client.query<{ value: string }>(
      `SELECT value FROM pr6b_fold_transition_probe ORDER BY value COLLATE "C"`,
    );
    assert.deepEqual(after.rows, before.rows);
    assert.equal(after.rows.length, 2);
    const index = await client.query<{ present: boolean }>(
      `SELECT to_regclass('pg_temp.pr6b_fold_transition_probe_unique') IS NOT NULL AS present`,
    );
    assert.equal(index.rows[0]?.present, false);
  } finally {
    client.release();
  }
}

async function assertManagedColumnPresence(
  pool: pg.Pool,
  tableName: string,
  columnName: string,
  expected: boolean,
): Promise<void> {
  const result = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_attribute AS attribute
         JOIN pg_class AS relation ON relation.oid = attribute.attrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'north_star_module'
          AND relation.relname = $1
          AND attribute.attname = $2
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
     ) AS present`,
    [tableName, columnName],
  );
  assert.equal(result.rows[0]?.present, expected);
}

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

function projectionPayload<T>(compiled: CompileSuccess, familyId: string): T {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (entry) => entry.familyId === familyId,
  );
  assert.ok(reference);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (entry) => entry.contentHash === reference.artifactRoot,
  );
  assert.ok(manifestArtifact);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  const chunk = compiled.bundle.artifacts.find(
    (entry) => entry.contentHash === manifest.chunks[0]?.contentHash,
  );
  assert.ok(chunk);
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
}

function requiredRelationIndex(
  storage: StorageTargetPayloadV1,
): StorageTargetPayloadV1['entities'][number]['indexes'][number] {
  const relation = storage.relations[0];
  assert.ok(relation);
  const source = storage.entities.find(
    (entity) => entity.entityId === relation.sourceEntityId,
  );
  assert.ok(source);
  const index = source.indexes.find(
    (candidate) =>
      candidate.indexKind === 'relation' &&
      candidate.columnNames.includes(relation.relationColumn.physicalName),
  );
  assert.ok(index);
  return index;
}

function sourceEntityName(
  storage: StorageTargetPayloadV1,
  index: StorageTargetPayloadV1['entities'][number]['indexes'][number],
): string {
  const entity = storage.entities.find((candidate) =>
    candidate.indexes.some(
      (candidateIndex) => candidateIndex.physicalName === index.physicalName,
    ),
  );
  assert.ok(entity);
  return entity.physicalTableName;
}

function withoutRelationIndexes(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  const storage = projectionPayload<StorageTargetPayloadV1>(
    clone,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const relationIndexNames = new Set(
    storage.entities.flatMap((entity) =>
      entity.indexes
        .filter((index) => index.indexKind === 'relation')
        .map((index) => index.physicalName),
    ),
  );
  assert.ok(relationIndexNames.size > 0);
  for (const entity of storage.entities) {
    entity.indexes = entity.indexes.filter(
      (index) => !relationIndexNames.has(index.physicalName),
    );
  }
  storage.physicalMapping.records = storage.physicalMapping.records.filter(
    (record) => !relationIndexNames.has(record.physicalName),
  );
  rewriteProjectionPayload(clone, PROJECTION_FAMILY_IDS.storageTarget, storage);

  const storageReference = clone.bundle.releaseManifest.projections.find(
    (reference) => reference.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.ok(storageReference);
  const transition = projectionPayload<StorageTransitionEnvelope>(
    clone,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  transition.elements = transition.elements.filter(
    (element) =>
      element.kind !== 'createIndex' ||
      !relationIndexNames.has(element.physicalObjectName),
  );
  transition.toStorageTargetArtifactRoot = storageReference.artifactRoot;
  transition.toStorageTargetSemanticDigest = storageReference.semanticDigest;
  rewriteProjectionPayload(
    clone,
    PROJECTION_FAMILY_IDS.storageTransition,
    transition,
  );
  rebuildReleaseRoot(clone);
  return clone;
}

function withoutFoldedAccess(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  const storage = projectionPayload<StorageTargetPayloadV1>(
    clone,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const removedPhysicalNames = new Set<string>();
  for (const entity of storage.entities) {
    for (const column of entity.foldedColumns) {
      removedPhysicalNames.add(column.physicalName);
    }
    for (const index of entity.indexes.filter(
      (candidate) => candidate.indexKind === 'foldedAccess',
    )) {
      removedPhysicalNames.add(index.physicalName);
    }
    delete (entity as Partial<typeof entity>).foldedColumns;
    entity.indexes = entity.indexes.filter(
      (index) => index.indexKind !== 'foldedAccess',
    );
  }
  storage.physicalMapping.records = storage.physicalMapping.records.filter(
    (record) => !removedPhysicalNames.has(record.physicalName),
  );
  rewriteProjectionPayload(clone, PROJECTION_FAMILY_IDS.storageTarget, storage);

  const storageReference = clone.bundle.releaseManifest.projections.find(
    (reference) => reference.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.ok(storageReference);
  const transition = projectionPayload<StorageTransitionEnvelope>(
    clone,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  transition.elements = transition.elements.filter(
    (element) => !removedPhysicalNames.has(element.physicalObjectName),
  );
  transition.toStorageTargetArtifactRoot = storageReference.artifactRoot;
  transition.toStorageTargetSemanticDigest = storageReference.semanticDigest;
  rewriteProjectionPayload(
    clone,
    PROJECTION_FAMILY_IDS.storageTransition,
    transition,
  );
  rebuildReleaseRoot(clone);
  return clone;
}

function rewriteProjectionPayload(
  compiled: CompileSuccess,
  familyId: string,
  payload: unknown,
): void {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  const priorManifestHash = reference.artifactRoot;
  const priorManifestArtifact = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === priorManifestHash,
  );
  assert.ok(priorManifestArtifact);
  const manifest = JSON.parse(
    new TextDecoder().decode(priorManifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  const descriptor = manifest.chunks[0];
  assert.ok(descriptor);
  const priorChunkHash = descriptor.contentHash;
  const payloadBytes = new TextEncoder().encode(canonicalize(payload));
  const chunkDomain = `${HASH_DOMAINS.projectionChunk}/${familyId}`;
  const semanticDomain = `${HASH_DOMAINS.projectionSemantic}/${familyId}`;
  const manifestDomain = `${HASH_DOMAINS.projectionManifest}/${familyId}`;
  const chunkHash = compilerHash(chunkDomain, payloadBytes);
  const semanticDigest = compilerHash(semanticDomain, payloadBytes);
  const chunkArtifact: ContentAddressedArtifact = {
    artifactKind: 'projectionChunk',
    canonicalBytes: payloadBytes,
    contentHash: chunkHash,
    domainTag: chunkDomain,
    kind: 'contentAddressedArtifact',
    mediaType: 'application/vnd.northstar.canonical+json',
  };
  descriptor.byteLength = payloadBytes.byteLength;
  descriptor.contentHash = chunkHash;
  manifest.semanticDigest = semanticDigest;
  const manifestBytes = new TextEncoder().encode(canonicalize(manifest));
  const manifestHash = compilerHash(manifestDomain, manifestBytes);
  const manifestArtifact: ContentAddressedArtifact = {
    artifactKind: 'projectionManifest',
    canonicalBytes: manifestBytes,
    contentHash: manifestHash,
    domainTag: manifestDomain,
    kind: 'contentAddressedArtifact',
    mediaType: 'application/vnd.northstar.canonical+json',
  };
  reference.artifactRoot = manifestHash;
  reference.semanticDigest = semanticDigest;
  compiled.bundle.releaseManifest.artifactClosure =
    compiled.bundle.releaseManifest.artifactClosure
      .map((hash) => {
        if (hash === priorChunkHash) return chunkHash;
        if (hash === priorManifestHash) return manifestHash;
        return hash;
      })
      .toSorted();
  compiled.bundle.artifacts = replaceArtifacts(
    compiled.bundle.artifacts,
    new Map([
      [priorChunkHash, chunkArtifact],
      [priorManifestHash, manifestArtifact],
    ]),
  );
  compiled.stagedArtifacts = replaceArtifacts(
    compiled.stagedArtifacts,
    new Map([
      [priorChunkHash, chunkArtifact],
      [priorManifestHash, manifestArtifact],
    ]),
  );
}

function rebuildReleaseRoot(compiled: CompileSuccess): void {
  const bytes = new TextEncoder().encode(
    canonicalize(compiled.bundle.releaseManifest),
  );
  const root = compilerHash(HASH_DOMAINS.releaseManifest, bytes);
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
  compiled.bundle.artifacts = compiled.bundle.artifacts.map((artifact) =>
    artifact.artifactKind === 'releaseManifest' ? replacement : artifact,
  );
  compiled.stagedArtifacts = compiled.stagedArtifacts.map((artifact) =>
    artifact.artifactKind === 'releaseManifest' ? replacement : artifact,
  );
  compiled.attestation.releaseRoot = root;
  const body: Record<string, unknown> = { ...compiled.attestation };
  delete body.attestationDigest;
  compiled.attestation.attestationDigest = compilerHash(
    HASH_DOMAINS.compilerAttestation,
    new TextEncoder().encode(canonicalize(body)),
  );
}

function replaceArtifacts(
  artifacts: ContentAddressedArtifact[],
  replacements: ReadonlyMap<string, ContentAddressedArtifact>,
): ContentAddressedArtifact[] {
  return artifacts.map(
    (artifact) => replacements.get(artifact.contentHash) ?? artifact,
  );
}

function compilerHash(domain: string, bytes: Uint8Array): string {
  return createHash(CONTENT_HASH_ALGORITHM)
    .update(domain, 'utf8')
    .update(Uint8Array.of(0))
    .update(bytes)
    .digest('hex');
}

async function assertIndexPresence(
  pool: pg.Pool,
  indexName: string,
  expected: boolean,
): Promise<void> {
  const result = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_indexes
        WHERE schemaname = 'north_star_module'
          AND indexname = $1
     ) AS present`,
    [indexName],
  );
  assert.equal(result.rows[0]?.present, expected);
}

async function setActiveReleasePointer(
  pool: pg.Pool,
  releaseId: MintedUuid,
): Promise<void> {
  await pool.query(
    'ALTER TABLE platform.active_release_pointers DISABLE TRIGGER active_release_pointer_exact_swap',
  );
  try {
    await pool.query(
      `UPDATE platform.active_release_pointers
          SET release_id = $3
        WHERE tenant_id = $1 AND environment_id = $2`,
      [tenantA, environmentA, releaseId],
    );
  } finally {
    await pool.query(
      'ALTER TABLE platform.active_release_pointers ENABLE TRIGGER active_release_pointer_exact_swap',
    );
  }
}

async function insertUniqueKeyRecord(
  client: pg.PoolClient,
  context: TrustedRequestContext,
  entity: StorageTargetPayloadV1['entities'][number],
  uniqueValueColumn: string,
  uniqueValue: string,
): Promise<void> {
  await client.query(
    `SELECT set_config('north_star.tenant_id', $1, true),
            set_config('north_star.environment_id', $2, true)`,
    [context.tenantId, context.environmentId],
  );
  const requiredColumns = entity.columns.filter(
    (column) => !column.nullable && column.defaultSemantics === 'none',
  );
  const columns = [
    'tenant_id',
    'environment_id',
    entity.recordIdentity.column,
    ...requiredColumns.map((column) => column.physicalName),
  ];
  const recordId = randomUUID();
  const values: unknown[] = [context.tenantId, context.environmentId, recordId];
  for (const column of requiredColumns) {
    if (column.physicalName === uniqueValueColumn) {
      values.push(uniqueValue);
    } else if (column.postgresqlType === 'uuid') {
      values.push(randomUUID());
    } else if (column.postgresqlType === 'boolean') {
      values.push(false);
    } else if (/^(?:bigint|numeric)/.test(column.postgresqlType)) {
      values.push('1');
    } else {
      values.push(`case-fold-${recordId.slice(0, 8)}`);
    }
  }
  await client.query(
    `INSERT INTO north_star_module.${quoteTestIdentifier(entity.physicalTableName)}
         (${columns.map(quoteTestIdentifier).join(', ')})
       VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})`,
    values,
  );
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

async function createAdditionalV2Approval(
  runtimePool: pg.Pool,
  contexts: { approver: TrustedRequestContext },
  targetReleaseId: MintedUuid,
  preparationId: string,
): Promise<string> {
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
    targetReleaseId,
  });
  return approval.attempt.activationAttemptId;
}

async function readApprovedAttempt(
  materializerPool: pg.Pool,
  context: TrustedRequestContext,
  attemptId: string,
  preparationId: string,
): Promise<Array<{ approved: boolean }>> {
  const client = await materializerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('north_star.tenant_id', $1, true),
              set_config('north_star.environment_id', $2, true)`,
      [context.tenantId, context.environmentId],
    );
    const result = await client.query<{ approved: boolean }>(
      `SELECT approved
         FROM north_star_internal.module_storage_read_approved_attempt($1,$2,$3,$4)`,
      [context.tenantId, context.environmentId, attemptId, preparationId],
    );
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function readKernelLiveRoots(
  materializerPool: pg.Pool,
  context: TrustedRequestContext,
): Promise<string[]> {
  const client = await materializerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('north_star.tenant_id', $1, true),
              set_config('north_star.environment_id', $2, true)`,
      [context.tenantId, context.environmentId],
    );
    const result = await client.query<{ release_id: string }>(
      `SELECT release_id
         FROM north_star_internal.module_storage_read_kernel_live_roots($1,$2)
        ORDER BY release_id`,
      [context.tenantId, context.environmentId],
    );
    await client.query('COMMIT');
    return result.rows.map((row) => row.release_id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface PlantedBackfillRows {
  columnName: string;
  recordIds: string[];
  tableName: string;
}

async function seedBackfillRows(
  pool: pg.Pool,
  generationId: string,
  count: number,
): Promise<PlantedBackfillRows> {
  const target = await pool.query<{ column_name: string; table_name: string }>(
    `SELECT element.physical_object_name AS column_name,
            column_record.table_name
       FROM north_star_internal.module_storage_generations AS generation
       JOIN north_star_internal.module_storage_root_membership AS membership
         ON membership.tenant_id = generation.tenant_id
        AND membership.environment_id = generation.environment_id
        AND membership.release_id = generation.target_release_id
       JOIN north_star_internal.module_storage_elements AS element
         ON element.element_id = membership.element_id
       JOIN information_schema.columns AS column_record
         ON column_record.table_schema = 'north_star_module'
        AND column_record.column_name = element.physical_object_name
      WHERE generation.generation_id = $1 AND element.element_kind = 'backfill'
      LIMIT 1`,
    [generationId],
  );
  const located = target.rows[0];
  assert.ok(located, 'compiled backfill target must be visible');
  const columns = await pool.query<{
    column_name: string;
    data_type: string;
  }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'north_star_module' AND table_name = $1
        AND is_nullable = 'NO' AND column_default IS NULL
      ORDER BY ordinal_position`,
    [located.table_name],
  );
  const recordIds = Array.from({ length: count }, () => randomUUID());
  const values: unknown[] = [];
  const tuples = recordIds.map((recordId, rowIndex) => {
    const placeholders = columns.rows.map((column) => {
      const value =
        column.column_name === 'tenant_id'
          ? tenantA
          : column.column_name === 'environment_id'
            ? environmentA
            : column.column_name === 'record_id'
              ? recordId
              : column.data_type === 'uuid'
                ? randomUUID()
                : column.data_type === 'boolean'
                  ? false
                  : column.data_type === 'numeric' ||
                      column.data_type === 'bigint'
                    ? rowIndex + 1
                    : `s${generationId.slice(0, 6)}-${rowIndex}-${column.column_name.slice(-4)}`;
      values.push(value);
      return `$${values.length}`;
    });
    return `(${placeholders.join(',')})`;
  });
  await pool.query(
    `INSERT INTO north_star_module.${quoteTestIdentifier(located.table_name)}
       (${columns.rows.map((column) => quoteTestIdentifier(column.column_name)).join(',')})
     VALUES ${tuples.join(',')}`,
    values,
  );
  return {
    columnName: located.column_name,
    recordIds,
    tableName: located.table_name,
  };
}

async function assertBackfillCheckpoint(
  pool: pg.Pool,
  generationId: string,
  expectedRows: number,
  planted: PlantedBackfillRows,
): Promise<void> {
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
    rows_applied: String(expectedRows),
  });
  const rows = await pool.query<{ completed: string; total: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (
              WHERE ${quoteTestIdentifier(planted.columnName)} = ''
            )::text AS completed
       FROM north_star_module.${quoteTestIdentifier(planted.tableName)}
      WHERE record_id = ANY($1::uuid[])`,
    [planted.recordIds],
  );
  assert.deepEqual(rows.rows[0], {
    completed: String(expectedRows),
    total: String(expectedRows),
  });
}

async function expireApproval(pool: pg.Pool, attemptId: string): Promise<void> {
  await pool.query(
    'ALTER TABLE platform.release_approvals DISABLE RULE release_approvals_reject_update',
  );
  try {
    await pool.query(
      `UPDATE platform.release_approvals
          SET decided_at = clock_timestamp() - interval '2 minutes',
              expires_at = clock_timestamp() - interval '1 minute'
        WHERE activation_attempt_id = $1`,
      [attemptId],
    );
  } finally {
    await pool.query(
      'ALTER TABLE platform.release_approvals ENABLE RULE release_approvals_reject_update',
    );
  }
}

async function setApproverEligibility(
  pool: pg.Pool,
  eligible: boolean,
): Promise<void> {
  await pool.query(
    `SELECT platform.set_release_approver_eligibility($1,$2,$3,$2,$4)`,
    [tenantA, approverA, eligible, randomUUID()],
  );
}

async function setSystemExecutorAuthority(
  pool: pg.Pool,
  authorized: boolean,
): Promise<void> {
  await pool.query(
    `SELECT platform.set_release_executor_authority($1,$2,$3,$2,$4)`,
    [tenantA, SYSTEM_EXECUTION_PRINCIPAL.principalId, authorized, randomUUID()],
  );
}

async function setActivationControl(
  pool: pg.Pool,
  denied: boolean,
  paused: boolean,
): Promise<void> {
  await pool.query(
    `SELECT platform.set_release_activation_control($1,$2,NULL,$3,$4,$5,$6)`,
    [tenantA, environmentA, denied, paused, approverA, randomUUID()],
  );
}

async function assertCatalogDrift(
  materializer: PostgresModuleStorageMaterializer,
  context: TrustedRequestContext,
  message: RegExp,
): Promise<void> {
  await assert.rejects(
    materializer.verifyLiveCatalog(context),
    (error: unknown) =>
      error instanceof ModuleStorageMaterializationError &&
      error.code === 'CATALOG_DRIFT' &&
      message.test(error.message),
  );
}

async function assertKernelSnapshotDrift(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await assert.rejects(
      assertSchemaMatchesSnapshot(client, checkedInSnapshot),
      (error: unknown) =>
        error instanceof SchemaDriftError &&
        /physical schema differs/.test(error.message),
    );
  } finally {
    client.release();
  }
}

async function assertKernelSnapshotMatches(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await assertSchemaMatchesSnapshot(client, checkedInSnapshot);
  } finally {
    client.release();
  }
}

async function firstManagedTableName(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'north_star_module' ORDER BY tablename LIMIT 1`,
  );
  return result.rows[0]!.tablename;
}

function quoteTestIdentifier(value: string): string {
  assert.match(value, /^[a-z][a-z0-9_]{0,62}$/);
  return `"${value}"`;
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}
