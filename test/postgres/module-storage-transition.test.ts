import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import {
  APPLICATION_NAMESPACE,
  composedApplicationDefinition,
} from '../../packages/domain/src/app/builder.js';
import { inventoryModuleDefinition } from '../../packages/domain/src/inventory/definition.js';
import { purchasingModuleDefinition } from '../../packages/domain/src/purchasing/definition.js';
import { salesModuleDefinition } from '../../packages/domain/src/sales/definition.js';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  UNICODE_CASE_FOLD_EXPANSIONS,
  UNICODE_CASE_FOLD_SIMPLE_SOURCES,
  canonicalize,
  canonicalizeAndHash,
  normalizeApplicationPackage,
  parseNormalizedApplicationPackageJson,
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
import { buildFoldedMatchPredicate } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
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
import { PostgresReleaseVerificationService } from '../../packages/postgres-provider/src/release-verification-service.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import {
  AuthenticatedRequestEntryAdapter,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import {
  FIXTURE_IDS,
  FIXTURE_LANGUAGE_VERSION,
  ordinaryModuleV1,
  ordinaryModuleV2,
} from '../fixtures/g2/module-conformance/definitions.js';
import { assertComposedInventoryCollection } from '../helpers/assert-composed-inventory.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const migrations = resolve('db/migrations');
const checkedInSnapshot = resolve('db/schema.snapshot.json');
const tenantA = 'a1000000-0000-4000-8000-000000000001';
const tenantB = 'b1000000-0000-4000-8000-000000000001';
const environmentA = 'a2000000-0000-4000-8000-000000000002';
const environmentB = 'b2000000-0000-4000-8000-000000000002';
const principalA = 'a3000000-0000-4000-8000-000000000003';
const principalB = 'b3000000-0000-4000-8000-000000000003';
const inventoryContractReleaseRoot =
  'bd977ff0a00db745e79b7d8e158cb55863319f9f37f7674d77b618e85272d116';
const approverA = 'a4000000-0000-4000-8000-000000000004';
const demonstrateFoldFunctionDrift =
  process.env.PR6B_DEMONSTRATE_FOLD_FUNCTION_DRIFT;
const demonstrateMissingSearchOnlyIndex =
  process.env.PR6D_DEMONSTRATE_MISSING_SEARCH_ONLY_INDEX;
const pr6cMeasurementRows = Number(
  process.env.PR6C_MEASUREMENT_ROWS ?? '10000',
);

if (
  demonstrateFoldFunctionDrift !== undefined &&
  demonstrateFoldFunctionDrift !== '1'
) {
  throw new Error(
    `unsupported PR6B_DEMONSTRATE_FOLD_FUNCTION_DRIFT value: ${demonstrateFoldFunctionDrift}`,
  );
}
if (
  demonstrateMissingSearchOnlyIndex !== undefined &&
  demonstrateMissingSearchOnlyIndex !== 'search-only'
) {
  throw new Error(
    `unsupported PR6D_DEMONSTRATE_MISSING_SEARCH_ONLY_INDEX value: ${demonstrateMissingSearchOnlyIndex}`,
  );
}
if (
  !Number.isInteger(pr6cMeasurementRows) ||
  pr6cMeasurementRows < 1 ||
  pr6cMeasurementRows > 500_000
) {
  throw new Error(
    `PR6C_MEASUREMENT_ROWS must be an integer from 1 through 500000; received ${String(process.env.PR6C_MEASUREMENT_ROWS)}`,
  );
}

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
          '0011_module_fold_function_ddl_witness.sql',
          '0012_saved_master_filters.sql',
          '0013_release_verification_evidence.sql',
          '0014_archive_excluding_module_uniqueness.sql',
          '0015_inventory_storage_foundation.sql',
          '0016_inventory_posting_receipt_digest_version.sql',
          '0017_inventory_stock_count_receipt_digest_version.sql',
          '0018_release_verification_derivations.sql',
          '0019_inventory_release_provenance_and_partition_null_safety.sql',
          '0020_semantic_aggregate_anchors.sql',
          '0021_bounded_fresh_tenant_install_evidence.sql',
          '0022_module_storage_relation_requiredness_relaxation.sql',
          '0023_inventory_stock_count_companion_digest_version.sql',
          '0024_module_storage_enum_domain_widening.sql',
          '0025_current_authorization.sql',
          '0026_inventory_projection_discrepancies.sql',
          '0027_receipt_posting.sql',
          '0028_sale_fulfillment.sql',
        ]);
        assert.equal(migrationResult.verified.length, allMigrations.length);
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
        assert.equal(
          await readUnicodeCaseFoldFunction(pool),
          null,
          'fresh schema must exercise the absent-function creation path',
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
        const installedFoldFunction = await readUnicodeCaseFoldFunction(pool);
        assert.ok(
          installedFoldFunction,
          'materialization must create the absent versioned fold function',
        );
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
                assert.match(
                  definition.indexdef,
                  /WHERE \(?archived_at IS NULL\)?$/,
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
            assert.equal(executed.deferredOnlineFamilyElementsProcessed, 0);
            await admitPreparedTarget(runtimePool, contexts.a, releases.a);
            console.log(
              'PR-6c deferredOnlineFamily elements processed: 0 (fresh-table plan)',
            );

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

            assert.deepEqual(
              (await materializer.verifyLiveCatalog(contexts.a)).drift,
              [],
              'the drift verifier must accept archive-excluding indexes',
            );
            const parent = freshStorage.entities.find(
              (entity) => entity.entityId === FIXTURE_IDS.entityIds.parent,
            );
            assert.ok(parent);
            const managedUnique = parent.uniqueKeys[0];
            assert.ok(managedUnique);
            const declaredIndex = await pool.query<{ indexdef: string }>(
              `SELECT indexdef
                 FROM pg_indexes
                WHERE schemaname = 'north_star_module'
                  AND indexname = $1`,
              [managedUnique.physicalName],
            );
            assert.equal(declaredIndex.rowCount, 1);
            await pool.query(
              `DROP INDEX north_star_module.${quoteTestIdentifier(managedUnique.physicalName)}`,
            );
            await assertCatalogDrift(
              materializer,
              contexts.a,
              new RegExp(
                `missing managed index ${parent.physicalTableName}\\.${managedUnique.physicalName}`,
              ),
            );
            await pool.query(declaredIndex.rows[0]!.indexdef);
            assert.deepEqual(
              (await materializer.verifyLiveCatalog(contexts.a)).drift,
              [],
            );
          },
        );

        await t.test(
          'backfill claims survive connection loss and coordinators converge',
          async () => {
            const admissible = ordinaryModuleV2() as {
              fields: Array<Record<string, unknown>>;
              languageVersion: unknown;
            };
            const schemaVersion = String(admissible.languageVersion);
            const field = admissible.fields.find(
              (candidate) =>
                candidate.fieldId === FIXTURE_IDS.fieldIds.parentNotes,
            )!;
            field.defaultSemantics = 'coalesceAtRead';
            field.defaultValue = {
              kind: 'textValue',
              schemaVersion,
              value: '',
            };
            field.storageEvolution = {
              kind: 'backfillEvolution',
              residualReadSemantics: 'coalesceAtRead',
              schemaVersion,
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
              await admitPreparedTarget(runtimePool, contexts.a, next);
              await assertBackfillCheckpoint(
                pool,
                scenario.generationId,
                planted.expectedBackfillRows,
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
              await assertBackfillCheckpointRoleIsolation(
                materializerPool,
                moduleRuntimePool,
                contexts.a,
                contexts.b,
                scenario.generationId,
              );

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
                planted.expectedBackfillRows,
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
                planted.expectedBackfillRows,
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
                planted.expectedBackfillRows,
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
                planted.expectedBackfillRows,
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
          'DDL witness prevents fold replacement and two tenants converge on shared tables',
          async () => {
            const replaceFoldFunction = () =>
              pool.query(
                `CREATE OR REPLACE FUNCTION north_star_module.nsm_unicode_case_fold_v1(value text)
                   RETURNS text
                   LANGUAGE sql
                   IMMUTABLE STRICT PARALLEL SAFE
                   SET search_path = pg_catalog
                   AS $case_fold$ SELECT value $case_fold$`,
              );
            const driftedPreparation = {
              context: contexts.b,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              generationId: randomUUID(),
              initiatedBy: principalB,
              preparationId: randomUUID(),
              targetReleaseId: releases.b.target,
            };
            if (demonstrateFoldFunctionDrift === '1') {
              await pool.query(
                'ALTER EVENT TRIGGER module_fold_function_ddl_witness DISABLE',
              );
              await replaceFoldFunction();
              await pool.query(
                'ALTER EVENT TRIGGER module_fold_function_ddl_witness ENABLE',
              );
              await materializer.prepare(driftedPreparation);
              assert.fail(
                'materialization accepted a changed versioned fold body',
              );
            }
            await assert.rejects(
              replaceFoldFunction(),
              (error: unknown) =>
                error instanceof Error &&
                (error as Error & { code?: string }).code === '55000' &&
                /versioned and immutable/.test(error.message),
            );
            assert.deepEqual(
              await readUnicodeCaseFoldFunction(pool),
              installedFoldFunction,
              'the event trigger must roll back the replacement itself',
            );
            const second = await materializer.prepare(driftedPreparation);
            assert.ok(
              second.diff.elements.some(
                (element) =>
                  element.disposition === 'APPLIED' &&
                  (element.kind === 'createTable' ||
                    element.kind === 'createIndex'),
              ),
              'second materialization must exercise the existing-function path',
            );
            assert.deepEqual(
              await readUnicodeCaseFoldFunction(pool),
              installedFoldFunction,
              'an expected existing function must be verified without replacement DDL',
            );
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

test('ABI function checks compose additively across live roots and conflicting duplicate names fail closed', async () => {
  const emptyDefinition = emptyModuleDefinition();
  const empty = mustCompile(moduleInput(emptyDefinition));
  const priorDefinition = composedApplicationWithoutInventoryForTransition();
  const prior = mustCompile(
    moduleInput(priorDefinition, expectedActiveReleaseFrom(empty)),
  );
  const priorStorage = projectionPayload<StorageTargetPayloadV1>(
    prior,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.deepEqual(
    priorStorage.entities
      .filter((entity) => entity.legalEntity !== undefined)
      .map((entity) => entity.entityId),
    [],
    'the Inventory-free prior retains no entity-owned family that requires the removed legal-entity master',
  );
  const mountedDefinition = composedApplicationDefinition();
  const mounted = mustCompile(
    moduleInput(mountedDefinition, expectedActiveReleaseFrom(prior)),
  );
  const conflicting = withConflictingAbiFunctionCheck(mounted);
  const mountedStorage = projectionPayload<StorageTargetPayloadV1>(
    mounted,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const item = mountedStorage.entities.find((entity) =>
    entity.entityId.endsWith(':entity.item'),
  );
  const baseUnitCheck = item?.abiFunctionChecks?.[0];
  assert.ok(item);
  assert.ok(baseUnitCheck);

  await withEphemeralPostgres(
    'module-storage-additive-abi-check',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        await runMigrations(admin, await loadMigrations(migrations));
        await seedScope(admin);
        await admin.query(
          `SELECT platform.provision_inventory_scope(
             $1, $2, $3, 'LE-A', 'Legal Entity A', 'America/Edmonton',
             '06:00:00', $4, 1::smallint, 'reject', 0,
             'codeAndNarrative', 'codeOnly', 'codeAndNarrative',
             'codeAndNarrative', 'codeAndNarrative',
             NULL, NULL, NULL, NULL, NULL
           )`,
          [tenantA, environmentA, randomUUID(), inventoryContractReleaseRoot],
        );
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
          empty,
          definitionBytes(emptyDefinition),
          prior,
          definitionBytes(priorDefinition),
        );
        const mountedRelease = await persistNextRelease(
          runtimePool,
          contexts.a,
          releases.a.target,
          mounted,
          definitionBytes(mountedDefinition),
        );
        const conflictingRelease = await persistNextRelease(
          runtimePool,
          contexts.a,
          releases.a.target,
          conflicting,
          definitionBytes(mountedDefinition),
        );
        await installSourcePointers(pool, releases);
        await grantExecutorAuthority(pool);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          moduleRuntimePool,
        );

        const priorPreparation = await materializer.prepare({
          context: contexts.a,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generationId: randomUUID(),
          initiatedBy: principalA,
          preparationId: randomUUID(),
          targetReleaseId: releases.a.target,
        });
        assert.equal(priorPreparation.schemaState, 'APPLIED');
        await setActiveReleasePointer(pool, releases.a.target);

        const mountedGenerationId = randomUUID();
        const mountedPreparationId = randomUUID();
        const mountedPreparation = await materializer.prepare({
          context: contexts.a,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generationId: mountedGenerationId,
          initiatedBy: principalA,
          preparationId: mountedPreparationId,
          targetReleaseId: mountedRelease.target,
        });
        assert.equal(mountedPreparation.schemaState, 'APPLIED');
        assert.equal(mountedPreparation.dataState, 'PENDING_IN_ATTEMPT');
        assert.equal(
          mountedPreparation.diff.elements.find(
            (element) =>
              element.kind === 'addAbiFunctionCheck' &&
              element.physicalObjectName === baseUnitCheck.physicalName,
          )?.disposition,
          'PENDING_IN_ATTEMPT',
        );
        const constraintPresent = async () =>
          (
            await pool.query<{ present: boolean }>(
              `SELECT EXISTS (
                 SELECT 1
                   FROM pg_constraint AS constraint_record
                   JOIN pg_class AS relation
                     ON relation.oid = constraint_record.conrelid
                   JOIN pg_namespace AS namespace
                     ON namespace.oid = relation.relnamespace
                  WHERE namespace.nspname = 'north_star_module'
                    AND relation.relname = $1
                    AND constraint_record.conname = $2
               ) AS present`,
              [item.physicalTableName, baseUnitCheck.physicalName],
            )
          ).rows[0]?.present;
        assert.equal(await constraintPresent(), false);
        const attemptId = await createV2Approval(
          runtimePool,
          pool,
          contexts,
          mountedRelease,
          mounted,
          mountedPreparation,
          mountedPreparationId,
        );
        const executed = await materializer.executeApprovedAttempt({
          activationAttemptId: attemptId,
          context: contexts.a,
          coordinatorId: randomUUID(),
          generationId: mountedGenerationId,
        });
        assert.equal(executed.disposition, 'READY_TO_SWAP');
        assert.equal(await constraintPresent(), true);
        assert.deepEqual(
          (await materializer.verifyLiveCatalog(contexts.a)).drift,
          [],
        );
        await assert.rejects(
          materializer.prepare({
            context: contexts.a,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            generationId: randomUUID(),
            initiatedBy: principalA,
            preparationId: randomUUID(),
            targetReleaseId: conflictingRelease.target,
          }),
          (error: unknown) =>
            error instanceof ModuleStorageMaterializationError &&
            error.code === 'LIVE_SET_SHAPE_CONFLICT' &&
            error.message.includes(
              `${item.physicalTableName}.${baseUnitCheck.physicalName}`,
            ),
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

test('standalone inventory materialization fails closed when Item and Location targets are absent', async () => {
  const legalEntityA = randomUUID();
  const legalEntityB = randomUUID();
  const emptyDefinition = emptyModuleDefinition();
  const source = mustCompile(moduleInput(emptyDefinition));
  const targetDefinition = inventoryModuleDefinition();
  const target = mustCompile(
    moduleInput(targetDefinition, expectedActiveReleaseFrom(source)),
  );
  const storage = projectionPayload<StorageTargetPayloadV1>(
    target,
    PROJECTION_FAMILY_IDS.storageTarget,
  );

  await withEphemeralPostgres(
    'module-storage-inventory-missing-references',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        await runMigrations(admin, await loadMigrations(migrations));
        await seedScope(admin);
        await admin.query(
          `SELECT platform.provision_inventory_scope(
             $1, $2, $3, 'LE-A', 'Legal Entity A', 'America/Edmonton',
             '06:00:00', $4, 1::smallint, 'reject', 0,
             'codeAndNarrative', 'codeOnly', 'codeAndNarrative',
             'codeAndNarrative', 'codeAndNarrative',
             NULL, NULL, NULL, NULL, NULL
           )`,
          [tenantA, environmentA, legalEntityA, inventoryContractReleaseRoot],
        );
        await admin.query(
          `SELECT platform.provision_inventory_scope(
             $1, $2, $3, 'LE-B', 'Legal Entity B', 'America/Toronto',
             '04:00:00', $4, 1::smallint, 'reject', 0,
             'codeAndNarrative', 'codeOnly', 'codeAndNarrative',
             'codeAndNarrative', 'codeAndNarrative',
             NULL, NULL, NULL, NULL, NULL
           )`,
          [tenantB, environmentB, legalEntityB, inventoryContractReleaseRoot],
        );
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
          definitionBytes(targetDefinition),
        );
        await installSourcePointers(pool, releases);
        await grantExecutorAuthority(pool);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          moduleRuntimePool,
        );
        await assert.rejects(
          materializer.prepare({
            context: contexts.a,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            generationId: randomUUID(),
            initiatedBy: principalA,
            preparationId: randomUUID(),
            targetReleaseId: releases.a.target,
          }),
          (error: unknown) =>
            error instanceof ModuleStorageMaterializationError &&
            error.code === 'ENTITY_TARGET_MISSING',
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

  const externalTargets = storage.relations
    .filter((relation) => relation.relationColumn.origin === 'field')
    .map((relation) => relation.targetEntityId)
    .toSorted();
  assert.deepEqual(externalTargets, [
    'northstar.inventory:entity.item',
    'northstar.inventory:entity.item',
    'northstar.inventory:entity.item',
    'northstar.inventory:entity.location',
    'northstar.inventory:entity.location',
    'northstar.inventory:entity.location',
    'northstar.inventory:entity.location',
  ]);
});

test('inventory v3 targets materialize the compiled legal master, fact partitions, and base-unit binding', async () => {
  const legalEntityId = randomUUID();
  const legalEntityB = randomUUID();
  const emptyDefinition = emptyModuleDefinition();
  const source = mustCompile(moduleInput(emptyDefinition));
  const targetDefinition = inventoryOwnedModuleDefinition();
  const target = mustCompile(
    moduleInput(targetDefinition, expectedActiveReleaseFrom(source)),
  );
  const storage = projectionPayload<StorageTargetPayloadV1>(
    target,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.equal(storage.schemaVersion, 'northstar.storage-target-payload/v3');
  const item = storage.entities.find((entity) =>
    entity.entityId.endsWith(':entity.item'),
  );
  const location = storage.entities.find((entity) =>
    entity.entityId.endsWith(':entity.location'),
  );
  const transaction = storage.entities.find((entity) =>
    entity.entityId.endsWith(':entity.inventory_transaction'),
  );
  const transactionLine = storage.entities.find((entity) =>
    entity.entityId.endsWith(':entity.inventory_transaction_line'),
  );
  const periodLock = storage.entities.find((entity) =>
    entity.entityId.endsWith(':entity.inventory_period_lock'),
  );
  const movement = storage.entities.find((entity) =>
    entity.entityId.endsWith(':entity.inventory_movement'),
  );
  const legalEntity = storage.entities.find(
    (entity) => entity.legalEntityMaster !== undefined,
  );
  assert.ok(item);
  assert.ok(location);
  assert.ok(transaction);
  assert.ok(transactionLine);
  assert.ok(periodLock?.periodLock);
  const periodLockStorage = periodLock.periodLock;
  assert.deepEqual(periodLock.consumerWriterRoots.writerOperationIds, [
    `${APPLICATION_NAMESPACE}:operation.advance_period_lock`,
    `${APPLICATION_NAMESPACE}:operation.reopen_period`,
  ]);
  assert.deepEqual(
    {
      advanceOperationId: periodLockStorage.advanceOperationId,
      reopenOperationId: periodLockStorage.reopenOperationId,
      scope: periodLockStorage.scopeUniqueIndex.columns,
    },
    {
      advanceOperationId: `${APPLICATION_NAMESPACE}:operation.advance_period_lock`,
      reopenOperationId: `${APPLICATION_NAMESPACE}:operation.reopen_period`,
      scope: ['tenant_id', 'environment_id', 'legal_entity_id'],
    },
  );
  assert.equal(item.legalEntity, undefined);
  assert.ok(movement?.legalEntity);
  assert.ok(movement.factStorage);
  assert.ok(legalEntity?.legalEntityMaster);
  const transition = projectionPayload<StorageTransitionEnvelope>(
    target,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  const legalEntityTable = transition.elements.find(
    (element) =>
      element.kind === 'createTable' &&
      element.subjectId === legalEntity.entityId,
  );
  assert.ok(legalEntityTable);
  for (const entity of storage.entities.filter(
    (candidate) => candidate.legalEntity !== undefined,
  )) {
    const table = transition.elements.find(
      (element) =>
        element.kind === 'createTable' && element.subjectId === entity.entityId,
    );
    assert.ok(table);
    assert.ok(
      table.declaredDependencyIds.includes(legalEntityTable.elementId),
      `${entity.entityId} must depend on the legal-entity master table`,
    );
  }
  const factStorage = movement.factStorage;
  const legalEntityMaster = legalEntity.legalEntityMaster;
  const baseUnit = item.columns.find((column) =>
    column.canonicalFieldId.endsWith(':field.item_base_unit'),
  );
  assert.ok(baseUnit);
  const movementRelations = storage.relations.filter(
    (relation) => relation.sourceEntityId === movement.entityId,
  );
  const movementTransaction = movementRelations.find(
    (relation) => relation.targetEntityId === transaction.entityId,
  );
  const movementTransactionLine = movementRelations.find(
    (relation) => relation.targetEntityId === transactionLine.entityId,
  );
  const lineTransaction = storage.relations.find(
    (relation) =>
      relation.sourceEntityId === transactionLine.entityId &&
      relation.targetEntityId === transaction.entityId,
  );
  assert.ok(movementTransaction);
  assert.ok(movementTransactionLine);
  assert.ok(lineTransaction);
  for (const relation of [
    movementTransaction,
    movementTransactionLine,
    lineTransaction,
  ]) {
    assert.deepEqual(relation.foreignKey.sourceColumns.slice(0, 3), [
      'tenant_id',
      'environment_id',
      'legal_entity_id',
    ]);
  }

  await withEphemeralPostgres(
    'module-storage-entity-owned',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        await runMigrations(admin, await loadMigrations(migrations));
        await seedScope(admin);
        await admin.query(
          `SELECT platform.provision_inventory_scope(
             $1, $2, $3, 'LE-A', 'Legal Entity A', 'America/Edmonton',
             '06:00:00', $4, 1::smallint, 'reject', 0,
             'codeAndNarrative', 'codeOnly', 'codeAndNarrative',
             'codeAndNarrative', 'codeAndNarrative',
             NULL, NULL, NULL, NULL, NULL
           )`,
          [tenantA, environmentA, legalEntityId, inventoryContractReleaseRoot],
        );
        await admin.query(
          `SELECT platform.provision_inventory_scope(
             $1, $2, $3, 'LE-B', 'Legal Entity B', 'America/Toronto',
             '04:00:00', $4, 1::smallint, 'reject', 0,
             'codeAndNarrative', 'codeOnly', 'codeAndNarrative',
             'codeAndNarrative', 'codeAndNarrative',
             NULL, NULL, NULL, NULL, NULL
           )`,
          [tenantB, environmentB, legalEntityB, inventoryContractReleaseRoot],
        );
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
          definitionBytes(targetDefinition),
        );
        await installSourcePointers(pool, releases);
        await grantExecutorAuthority(pool);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          moduleRuntimePool,
        );
        const prepared = await materializer.prepare({
          context: contexts.a,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generationId: randomUUID(),
          initiatedBy: principalA,
          preparationId: randomUUID(),
          targetReleaseId: releases.a.target,
        });
        assert.equal(prepared.schemaState, 'APPLIED');

        const legalEntityBValues = legalEntity.columns.map((column) => {
          if (column.physicalName === legalEntityMaster.fieldColumns.code)
            return 'LE-B';
          if (column.physicalName === legalEntityMaster.fieldColumns.name)
            return 'Legal Entity B';
          if (column.physicalName === legalEntityMaster.fieldColumns.status)
            return legalEntityMaster.activeStatusValue;
          if (column.physicalName === legalEntityMaster.fieldColumns.isDefault)
            return true;
          if (column.nullable) return null;
          throw new Error(
            `unmapped legal-entity field ${column.canonicalFieldId}`,
          );
        });
        await pool.query(
          `INSERT INTO north_star_module.${quoteTestIdentifier(legalEntity.physicalTableName)} (
             tenant_id, environment_id,
             ${quoteTestIdentifier(legalEntity.recordIdentity.column)},
             ${legalEntity.columns
               .map((column) => quoteTestIdentifier(column.physicalName))
               .join(', ')}
           ) VALUES (${[
             tenantB,
             environmentB,
             legalEntityB,
             ...legalEntityBValues,
           ]
             .map((_, index) => `$${String(index + 1)}`)
             .join(', ')})`,
          [tenantB, environmentB, legalEntityB, ...legalEntityBValues],
        );

        const secondDefaultId = randomUUID();
        const secondDefaultValues = legalEntity.columns.map((column) => {
          if (column.physicalName === legalEntityMaster.fieldColumns.code)
            return 'LE-SECOND';
          if (column.physicalName === legalEntityMaster.fieldColumns.name)
            return 'Second default';
          if (column.physicalName === legalEntityMaster.fieldColumns.status)
            return legalEntityMaster.activeStatusValue;
          if (column.physicalName === legalEntityMaster.fieldColumns.isDefault)
            return true;
          if (column.nullable) return null;
          throw new Error(
            `unmapped legal-entity field ${column.canonicalFieldId}`,
          );
        });
        await assert.rejects(
          pool.query(
            `INSERT INTO north_star_module.${quoteTestIdentifier(legalEntity.physicalTableName)} (
               tenant_id, environment_id,
               ${quoteTestIdentifier(legalEntity.recordIdentity.column)},
               ${legalEntity.columns
                 .map((column) => quoteTestIdentifier(column.physicalName))
                 .join(', ')}
             ) VALUES (${[
               tenantA,
               environmentA,
               secondDefaultId,
               ...secondDefaultValues,
             ]
               .map((_, index) => `$${String(index + 1)}`)
               .join(', ')})`,
            [tenantA, environmentA, secondDefaultId, ...secondDefaultValues],
          ),
          (error: unknown) =>
            error instanceof Error &&
            (error as Error & { code?: string; constraint?: string }).code ===
              '23505' &&
            (error as Error & { code?: string; constraint?: string })
              .constraint === legalEntityMaster.defaultUniqueIndex.physicalName,
        );

        const legalColumn = await pool.query<{
          is_nullable: boolean;
          postgresql_type: string;
        }>(
          `SELECT NOT attribute.attnotnull AS is_nullable,
                  format_type(attribute.atttypid, attribute.atttypmod)
                    AS postgresql_type
             FROM pg_attribute AS attribute
             JOIN pg_class AS relation
               ON relation.oid = attribute.attrelid
             JOIN pg_namespace AS namespace
               ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'north_star_module'
              AND relation.relname = $1
              AND attribute.attname = 'legal_entity_id'
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped`,
          [movement.physicalTableName],
        );
        assert.deepEqual(legalColumn.rows, [
          { is_nullable: false, postgresql_type: 'uuid' },
        ]);

        const companion = factStorage.companion;
        const stockVersionColumn = movement.columns.find((column) =>
          column.canonicalFieldId.endsWith(
            ':field.inventory_movement_stock_dimension_set_version',
          ),
        );
        assert.ok(stockVersionColumn);
        const movementColumns = await pool.query<{
          is_nullable: boolean;
          name: string;
        }>(
          `SELECT attribute.attname AS name,
                  NOT attribute.attnotnull AS is_nullable
             FROM pg_attribute AS attribute
             JOIN pg_class AS relation ON relation.oid = attribute.attrelid
             JOIN pg_namespace AS namespace
               ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'north_star_module'
              AND relation.relname = $1
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
            ORDER BY attribute.attnum`,
          [movement.physicalTableName],
        );
        assert.equal(
          movementColumns.rows.some(({ name }) =>
            /(?:amount|cost|currency|money|price|value|lot|serial|bin)/iu.test(
              name,
            ),
          ),
          false,
        );
        for (const required of [
          'legal_entity_id',
          'business_period',
          stockVersionColumn.physicalName,
          factStorage.fieldColumns.itemId,
          factStorage.fieldColumns.locationId,
          factStorage.fieldColumns.recordedAt,
        ]) {
          assert.equal(
            movementColumns.rows.find(({ name }) => name === required)
              ?.is_nullable,
            false,
          );
        }

        const partitionShape = await pool.query<{
          leaves: string;
          partition_key: string;
        }>(
          `SELECT pg_get_partkeydef($1::regclass) AS partition_key,
                  count(*) FILTER (WHERE isleaf)::text AS leaves
             FROM pg_partition_tree($1::regclass)
            GROUP BY partition_key`,
          [`north_star_module.${movement.physicalTableName}`],
        );
        assert.deepEqual(partitionShape.rows, [
          {
            leaves: '8',
            partition_key: 'HASH (tenant_id, business_period)',
          },
        ]);

        const constraints = await pool.query<{
          definition: string | null;
          name: string;
          referenced_schema: string | null;
          referenced_table: string | null;
          table_name: string;
          type: string;
        }>(
          `SELECT source.relname AS table_name,
                  constraint_record.conname AS name,
                  constraint_record.contype AS type,
                  pg_get_expr(
                    constraint_record.conbin,
                    constraint_record.conrelid,
                    true
                  ) AS definition,
                  target_namespace.nspname AS referenced_schema,
                  target.relname AS referenced_table
             FROM pg_constraint AS constraint_record
             JOIN pg_class AS source
               ON source.oid = constraint_record.conrelid
             JOIN pg_namespace AS source_namespace
               ON source_namespace.oid = source.relnamespace
             LEFT JOIN pg_class AS target
               ON target.oid = constraint_record.confrelid
             LEFT JOIN pg_namespace AS target_namespace
               ON target_namespace.oid = target.relnamespace
            WHERE source_namespace.nspname = 'north_star_module'
              AND source.relname = ANY($1::text[])
            ORDER BY source.relname, constraint_record.conname`,
          [
            [
              item.physicalTableName,
              movement.physicalTableName,
              companion.physicalTableName,
            ],
          ],
        );
        assert.ok(
          constraints.rows.some(
            (constraint) =>
              constraint.table_name === movement.physicalTableName &&
              constraint.type === 'f' &&
              constraint.referenced_schema === 'north_star_module' &&
              constraint.referenced_table === legalEntity.physicalTableName,
          ),
        );
        assert.ok(
          constraints.rows.some(
            (constraint) =>
              constraint.table_name === item.physicalTableName &&
              constraint.type === 'c' &&
              constraint.definition?.includes(
                'inventory_base_unit_change_allowed',
              ),
          ),
        );
        assert.ok(
          constraints.rows.some(
            (constraint) =>
              constraint.table_name === movement.physicalTableName &&
              constraint.name ===
                factStorage.businessPeriod.checkConstraintName,
          ),
        );
        assert.ok(
          constraints.rows.some(
            (constraint) =>
              constraint.table_name === companion.physicalTableName &&
              constraint.name === companion.movementForeignKey.physicalName &&
              constraint.referenced_table === movement.physicalTableName,
          ),
        );

        const tableGrants = await pool.query<{
          grantee: string;
          privilege_type: string;
          table_name: string;
        }>(
          `SELECT grantee, table_name, privilege_type
             FROM information_schema.role_table_grants
            WHERE table_schema = 'north_star_module'
              AND table_name = ANY($1::text[])
              AND grantee IN (
                'north_star_module_materializer', 'north_star_module_runtime'
              )
            ORDER BY table_name, grantee, privilege_type`,
          [[movement.physicalTableName, companion.physicalTableName]],
        );
        assert.equal(tableGrants.rows.length, 9);
        assert.equal(
          tableGrants.rows
            .filter(({ grantee }) => grantee === 'north_star_module_runtime')
            .every(({ privilege_type }) =>
              ['INSERT', 'SELECT'].includes(privilege_type),
            ),
          true,
        );
        assert.equal(
          tableGrants.rows.some(
            ({ grantee, privilege_type, table_name }) =>
              grantee === 'north_star_module_materializer' &&
              privilege_type === 'UPDATE' &&
              table_name === movement.physicalTableName,
          ),
          true,
        );

        const insertRequiredEntity = async (input: {
          entity: (typeof storage.entities)[number];
          environmentId: string;
          legalEntityId?: string;
          localValues?: Readonly<Record<string, unknown>>;
          recordId: string;
          relationRecordIds?: Readonly<Record<string, string>>;
          tenantId: string;
        }): Promise<void> => {
          const requiredColumns = input.entity.columns.filter(
            (column) => !column.nullable && column.defaultSemantics === 'none',
          );
          const requiredRelations = storage.relations.filter(
            (relation) =>
              relation.sourceEntityId === input.entity.entityId &&
              relation.relationColumn.origin !== 'field' &&
              !relation.relationColumn.nullable,
          );
          const columnValue = (
            column: (typeof storage.entities)[number]['columns'][number],
          ): unknown => {
            const localId = column.canonicalFieldId.split(':field.').at(-1)!;
            if (Object.hasOwn(input.localValues ?? {}, localId)) {
              return input.localValues?.[localId];
            }
            if (column.fieldContract.enumOptionIds.length > 0) {
              return column.fieldContract.enumOptionIds[0];
            }
            if (column.postgresqlType === 'uuid') return randomUUID();
            if (/^(?:bigint|integer|numeric)/u.test(column.postgresqlType)) {
              return '1';
            }
            if (column.postgresqlType.startsWith('timestamp')) {
              return '2026-07-29T12:00:00.000Z';
            }
            if (column.postgresqlType === 'boolean') return false;
            return `inventory-${input.recordId.slice(0, 8)}`;
          };
          const names = [
            'tenant_id',
            'environment_id',
            ...(input.entity.legalEntity ? ['legal_entity_id'] : []),
            input.entity.recordIdentity.column,
            ...requiredColumns.map((column) => column.physicalName),
            ...requiredRelations.map(
              (relation) => relation.relationColumn.physicalName,
            ),
          ];
          const values: unknown[] = [
            input.tenantId,
            input.environmentId,
            ...(input.entity.legalEntity ? [input.legalEntityId] : []),
            input.recordId,
            ...requiredColumns.map(columnValue),
            ...requiredRelations.map((relation) => {
              const value = input.relationRecordIds?.[relation.targetEntityId];
              if (!value) {
                throw new Error(
                  `missing relation value ${relation.relationId}`,
                );
              }
              return value;
            }),
          ];
          await pool.query(
            `INSERT INTO north_star_module.${quoteTestIdentifier(input.entity.physicalTableName)} (
               ${names.map(quoteTestIdentifier).join(', ')}
             ) VALUES (${values.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
            values,
          );
        };

        const seedInventoryReferences = async (scope: {
          environmentId: string;
          itemId: string;
          legalEntityId: string;
          locationId: string;
          tenantId: string;
          transactionId: string;
          transactionLineId: string;
        }): Promise<void> => {
          await insertRequiredEntity({
            entity: item,
            environmentId: scope.environmentId,
            localValues: { item_base_unit: 'EA' },
            recordId: scope.itemId,
            tenantId: scope.tenantId,
          });
          await insertRequiredEntity({
            entity: location,
            environmentId: scope.environmentId,
            recordId: scope.locationId,
            tenantId: scope.tenantId,
          });
          await insertRequiredEntity({
            entity: transaction,
            environmentId: scope.environmentId,
            legalEntityId: scope.legalEntityId,
            recordId: scope.transactionId,
            tenantId: scope.tenantId,
          });
          await insertRequiredEntity({
            entity: transactionLine,
            environmentId: scope.environmentId,
            legalEntityId: scope.legalEntityId,
            localValues: {
              inventory_transaction_line_item_id: scope.itemId,
            },
            recordId: scope.transactionLineId,
            relationRecordIds: {
              [transaction.entityId]: scope.transactionId,
            },
            tenantId: scope.tenantId,
          });
        };

        const itemId = randomUUID();
        const movementId = randomUUID();
        const sourceId = randomUUID();
        const locationId = randomUUID();
        const transactionId = randomUUID();
        const transactionLineId = randomUUID();
        await seedInventoryReferences({
          environmentId: environmentA,
          itemId,
          legalEntityId,
          locationId,
          tenantId: tenantA,
          transactionId,
          transactionLineId,
        });
        const effectiveAt = '2026-07-29T12:00:00.000Z';
        const recordedAt = '2026-07-29T13:00:00.000Z';
        const period = await pool.query<{ business_period: string }>(
          `SELECT north_star_internal.inventory_business_period($1, $2)
             AS business_period`,
          [tenantA, effectiveAt],
        );
        const movementValue = (
          column: (typeof movement.columns)[number],
          input: {
            effectiveAt: string;
            itemId: string;
            locationId: string;
            recordedAt: string;
            sourceId: string;
            sourceLine: string;
            stockVersion?: string | null;
          },
        ): unknown => {
          const localId = column.canonicalFieldId.split(':field.').at(-1);
          switch (localId) {
            case 'inventory_movement_actor_id':
              return randomUUID();
            case 'inventory_movement_stock_dimension_set_version':
              return input.stockVersion === undefined
                ? column.fieldContract.enumOptionIds.find((id) =>
                    id.endsWith('_v1'),
                  )
                : input.stockVersion;
            case 'inventory_movement_item_id':
              return input.itemId;
            case 'inventory_movement_location_id':
              return input.locationId;
            case 'inventory_movement_quantity_delta':
              return '2';
            case 'inventory_movement_unit_id':
              return 'EA';
            case 'inventory_movement_effective_at':
              return input.effectiveAt;
            case 'inventory_movement_recorded_at':
              return input.recordedAt;
            case 'inventory_movement_source_type':
              return 'adjustment';
            case 'inventory_movement_source_id':
              return input.sourceId;
            case 'inventory_movement_source_line':
              return input.sourceLine;
            case 'inventory_movement_source_revision':
              return '1';
            case 'inventory_movement_posting_role':
              return column.fieldContract.enumOptionIds.find((id) =>
                id.endsWith('_adjustment'),
              );
            case 'inventory_movement_reason_code':
            case 'inventory_movement_reason_narrative':
            case 'inventory_movement_reversal_of_movement_id':
              return null;
            default:
              throw new Error(`unmapped movement field ${String(localId)}`);
          }
        };
        const insertMovement = async (input: {
          businessPeriod: string;
          effectiveAt: string;
          environmentId: string;
          itemId: string;
          legalEntityId: string;
          locationId: string;
          movementId: string;
          recordedAt: string;
          sourceId: string;
          sourceLine: string;
          stockVersion?: string | null;
          tenantId: string;
          transactionId: string;
          transactionLineId: string;
        }): Promise<void> => {
          const declaredRelations = movementRelations.filter(
            (relation) => relation.relationColumn.origin !== 'field',
          );
          const values = [
            input.tenantId,
            input.environmentId,
            input.legalEntityId,
            input.businessPeriod,
            input.movementId,
            ...movement.columns.map((column) => movementValue(column, input)),
            ...declaredRelations.map((relation) =>
              relation.targetEntityId === transaction.entityId
                ? input.transactionId
                : input.transactionLineId,
            ),
          ];
          await pool.query(
            `INSERT INTO north_star_module.${quoteTestIdentifier(movement.physicalTableName)} (
               tenant_id, environment_id, legal_entity_id, business_period,
               ${quoteTestIdentifier(movement.recordIdentity.column)},
               ${movement.columns
                 .map((column) => quoteTestIdentifier(column.physicalName))
                 .join(', ')},
               ${declaredRelations
                 .map((relation) =>
                   quoteTestIdentifier(relation.relationColumn.physicalName),
                 )
                 .join(', ')}
             ) VALUES (${values.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
            values,
          );
        };
        const movementInput = {
          businessPeriod: period.rows[0]!.business_period,
          effectiveAt,
          environmentId: environmentA,
          itemId,
          legalEntityId,
          locationId,
          movementId,
          recordedAt,
          sourceId,
          sourceLine: '1',
          tenantId: tenantA,
          transactionId,
          transactionLineId,
        };
        await assert.rejects(
          insertMovement({
            ...movementInput,
            businessPeriod: '2000-01-01',
            movementId: randomUUID(),
            sourceLine: 'wrong-period',
          }),
          hasPostgresErrorCode('23514'),
        );
        await assert.rejects(
          insertMovement({
            ...movementInput,
            movementId: randomUUID(),
            sourceLine: 'missing-version',
            stockVersion: null,
          }),
          hasPostgresErrorCode('23502'),
        );
        await assert.rejects(
          insertMovement({
            ...movementInput,
            movementId: randomUUID(),
            sourceLine: 'unknown-version',
            stockVersion: 'v2',
          }),
          hasPostgresErrorCode('23514'),
        );
        for (const member of ['itemId', 'locationId'] as const) {
          await assert.rejects(
            insertMovement({
              ...movementInput,
              [member]: '00000000-0000-0000-0000-000000000000',
              movementId: randomUUID(),
              sourceLine: `unspecified-${member}`,
            }),
            hasPostgresErrorCode('23514'),
          );
        }
        await insertMovement(movementInput);

        await assert.rejects(
          insertMovement({
            ...movementInput,
            itemId: randomUUID(),
            movementId: randomUUID(),
            sourceLine: 'missing-item-reference',
          }),
          hasPostgresErrorCode('23503'),
        );
        await assert.rejects(
          insertMovement({
            ...movementInput,
            movementId: randomUUID(),
            sourceLine: 'missing-transaction-reference',
            transactionId: randomUUID(),
          }),
          hasPostgresErrorCode('23503'),
        );
        const otherLegalEntityId = randomUUID();
        const otherTransactionId = randomUUID();
        await insertRequiredEntity({
          entity: legalEntity,
          environmentId: environmentA,
          recordId: otherLegalEntityId,
          tenantId: tenantA,
        });
        const provisionedOtherLock = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM north_star_module.${quoteTestIdentifier(periodLock.physicalTableName)}
            WHERE tenant_id = $1 AND environment_id = $2
              AND legal_entity_id = $3`,
          [tenantA, environmentA, otherLegalEntityId],
        );
        assert.equal(provisionedOtherLock.rows[0]?.count, '1');
        await insertRequiredEntity({
          entity: transaction,
          environmentId: environmentA,
          legalEntityId: otherLegalEntityId,
          recordId: otherTransactionId,
          tenantId: tenantA,
        });
        await assert.rejects(
          insertMovement({
            ...movementInput,
            movementId: randomUUID(),
            sourceLine: 'cross-entity-transaction',
            transactionId: otherTransactionId,
          }),
          hasPostgresErrorCode('23503'),
        );

        const plan = await pool.query<{ 'QUERY PLAN': unknown }>(
          `EXPLAIN (FORMAT JSON, COSTS FALSE)
           SELECT ${quoteTestIdentifier(movement.recordIdentity.column)}
             FROM north_star_module.${quoteTestIdentifier(movement.physicalTableName)}
            WHERE tenant_id = $1 AND business_period = $2`,
          [tenantA, period.rows[0]!.business_period],
        );
        assert.equal(
          collectPlanRelationNames(plan.rows[0]?.['QUERY PLAN']).filter(
            (name) =>
              factStorage.partitioning.partitions.some(
                (partition) => partition.physicalTableName === name,
              ),
          ).length,
          1,
        );

        const effectValues = companion.columns.map((column) => {
          if (column.name === 'tenant_id') return tenantA;
          if (column.name === 'environment_id') return environmentA;
          if (column.name === 'legal_entity_id') return legalEntityId;
          if (column.name === 'business_period')
            return period.rows[0]!.business_period;
          if (column.name === 'record_id') return movementId;
          if (column.name === factStorage.fieldColumns.sourceType)
            return 'adjustment';
          if (column.name === factStorage.fieldColumns.sourceId)
            return sourceId;
          if (column.name === factStorage.fieldColumns.sourceLine) return '1';
          if (column.name === factStorage.fieldColumns.sourceRevision)
            return '1';
          if (column.name === factStorage.fieldColumns.postingRole) {
            const postingRole = movement.columns.find(
              (candidate) => candidate.physicalName === column.name,
            );
            return postingRole?.fieldContract.enumOptionIds.find((id) =>
              id.endsWith('_adjustment'),
            );
          }
          throw new Error(`unmapped companion column ${column.name}`);
        });
        const queryAsModuleRuntime = async (
          statement: string,
          values: readonly unknown[],
        ): Promise<pg.QueryResult> => {
          const client = await moduleRuntimePool.connect();
          try {
            await client.query('BEGIN');
            await client.query(
              `SELECT set_config('north_star.tenant_id', $1, true),
                      set_config('north_star.environment_id', $2, true),
                      set_config('north_star.principal_id', $3, true)`,
              [tenantA, environmentA, principalA],
            );
            const result = await client.query(statement, [...values]);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        };
        const lockRows = await queryAsModuleRuntime(
          `SELECT record_id
             FROM north_star_module.${quoteTestIdentifier(periodLock.physicalTableName)}
            WHERE legal_entity_id = $1`,
          [legalEntityId],
        );
        assert.deepEqual(lockRows.rows, [{ record_id: legalEntityId }]);
        await assert.rejects(
          pool.query(
            `INSERT INTO north_star_module.${quoteTestIdentifier(periodLock.physicalTableName)} (
               tenant_id, environment_id, legal_entity_id, record_id
             ) VALUES ($1, $2, $3, $4)`,
            [tenantA, environmentA, legalEntityId, randomUUID()],
          ),
          hasPostgresErrorCode('23505'),
        );
        await assert.rejects(
          queryAsModuleRuntime(
            `INSERT INTO north_star_module.${quoteTestIdentifier(periodLock.physicalTableName)} (
               tenant_id, environment_id, legal_entity_id, record_id
             ) VALUES ($1, $2, $3, $4)`,
            [tenantA, environmentA, legalEntityId, randomUUID()],
          ),
          hasPostgresErrorCode('42501'),
        );
        await queryAsModuleRuntime(
          `UPDATE north_star_module.${quoteTestIdentifier(periodLock.physicalTableName)}
              SET ${quoteTestIdentifier(periodLockStorage.closedThroughColumn)} = $1
            WHERE legal_entity_id = $2`,
          ['2026-07-28T23:59:59.999Z', legalEntityId],
        );
        await queryAsModuleRuntime(
          `UPDATE north_star_module.${quoteTestIdentifier(periodLock.physicalTableName)}
              SET revision = revision + 1
            WHERE legal_entity_id = $1`,
          [legalEntityId],
        );
        await assert.rejects(
          queryAsModuleRuntime(
            `UPDATE north_star_module.${quoteTestIdentifier(periodLock.physicalTableName)}
                SET archived_at = clock_timestamp()
              WHERE legal_entity_id = $1`,
            [legalEntityId],
          ),
          hasPostgresErrorCode('42501'),
        );
        const reservedEffect = await queryAsModuleRuntime(
          `SELECT count(*)::text AS count
             FROM north_star_module.${quoteTestIdentifier(companion.physicalTableName)}
            WHERE record_id = $1`,
          [movementId],
        );
        assert.equal(reservedEffect.rows[0]?.count, '1');
        await assert.rejects(
          queryAsModuleRuntime(
            `INSERT INTO north_star_module.${quoteTestIdentifier(companion.physicalTableName)} (
               ${companion.columns
                 .map((column) => quoteTestIdentifier(column.name))
                 .join(', ')}
             ) VALUES (${effectValues.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
            effectValues,
          ),
          hasPostgresErrorCode('23505'),
        );

        const secondEffectiveAt = '2026-08-01T12:00:00.000Z';
        const secondPeriod = await pool.query<{ business_period: string }>(
          `SELECT north_star_internal.inventory_business_period($1, $2)
             AS business_period`,
          [tenantA, secondEffectiveAt],
        );
        const secondMovementId = randomUUID();
        await assert.rejects(
          insertMovement({
            ...movementInput,
            businessPeriod: secondPeriod.rows[0]!.business_period,
            effectiveAt: secondEffectiveAt,
            movementId: secondMovementId,
            recordedAt: '2026-08-01T13:00:00.000Z',
          }),
          hasPostgresErrorCode('23505'),
        );
        const rejectedMovement = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM north_star_module.${quoteTestIdentifier(movement.physicalTableName)}
            WHERE record_id = $1`,
          [secondMovementId],
        );
        assert.equal(rejectedMovement.rows[0]?.count, '0');
        const movementB = randomUUID();
        const itemB = randomUUID();
        const locationB = randomUUID();
        const transactionB = randomUUID();
        const transactionLineB = randomUUID();
        await seedInventoryReferences({
          environmentId: environmentB,
          itemId: itemB,
          legalEntityId: legalEntityB,
          locationId: locationB,
          tenantId: tenantB,
          transactionId: transactionB,
          transactionLineId: transactionLineB,
        });
        const effectiveAtB = '2026-07-29T10:00:00.000Z';
        const periodB = await pool.query<{ business_period: string }>(
          `SELECT north_star_internal.inventory_business_period($1, $2)
             AS business_period`,
          [tenantB, effectiveAtB],
        );
        await insertMovement({
          businessPeriod: periodB.rows[0]!.business_period,
          effectiveAt: effectiveAtB,
          environmentId: environmentB,
          itemId: itemB,
          legalEntityId: legalEntityB,
          locationId: locationB,
          movementId: movementB,
          recordedAt: '2026-07-29T12:30:00.000Z',
          sourceId: randomUUID(),
          sourceLine: 'tenant-b',
          tenantId: tenantB,
          transactionId: transactionB,
          transactionLineId: transactionLineB,
        });
        const extractAtHorizon = async (
          context: TrustedRequestContext,
        ): Promise<string[]> => {
          const client = await moduleRuntimePool.connect();
          try {
            await client.query('BEGIN');
            await client.query(
              `SELECT set_config('north_star.tenant_id', $1, true),
                      set_config('north_star.environment_id', $2, true),
                      set_config('north_star.principal_id', $3, true)`,
              [context.tenantId, context.environmentId, context.principalId],
            );
            const rows = await client.query<{ record_id: string }>(
              `SELECT ${quoteTestIdentifier(movement.recordIdentity.column)} AS record_id
                 FROM north_star_module.${quoteTestIdentifier(movement.physicalTableName)}
                WHERE ${quoteTestIdentifier(factStorage.fieldColumns.recordedAt)} <= $1
                ORDER BY ${quoteTestIdentifier(factStorage.fieldColumns.recordedAt)},
                         ${quoteTestIdentifier(movement.recordIdentity.column)}`,
              ['2026-07-29T14:00:00.000Z'],
            );
            await client.query('COMMIT');
            return rows.rows.map(({ record_id }) => record_id);
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        };
        assert.deepEqual(await extractAtHorizon(contexts.a), [movementId]);
        assert.deepEqual(await extractAtHorizon(contexts.b), [movementB]);

        const mismatchedEffectValues = effectValues.map((value, index) => {
          const column = companion.columns[index];
          if (column?.name === 'record_id') return randomUUID();
          if (column?.name === factStorage.fieldColumns.sourceId)
            return randomUUID();
          if (column?.name === factStorage.fieldColumns.sourceLine)
            return 'not-the-movement-source-line';
          return value;
        });
        await assert.rejects(
          queryAsModuleRuntime(
            `INSERT INTO north_star_module.${quoteTestIdentifier(companion.physicalTableName)} (
               ${companion.columns
                 .map((column) => quoteTestIdentifier(column.name))
                 .join(', ')}
             ) VALUES (${mismatchedEffectValues.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
            mismatchedEffectValues,
          ),
          hasPostgresErrorCode('23503'),
        );

        for (const statement of [
          `UPDATE north_star_module.${quoteTestIdentifier(movement.physicalTableName)}
              SET revision = revision + 1
            WHERE record_id = $1`,
          `DELETE FROM north_star_module.${quoteTestIdentifier(movement.physicalTableName)}
            WHERE record_id = $1`,
          `UPDATE north_star_module.${quoteTestIdentifier(companion.physicalTableName)}
              SET business_period = business_period
            WHERE record_id = $1`,
          `DELETE FROM north_star_module.${quoteTestIdentifier(companion.physicalTableName)}
            WHERE record_id = $1`,
        ]) {
          await assert.rejects(
            pool.query(statement, [movementId]),
            (error: unknown) =>
              error instanceof Error &&
              (error as Error & { code?: string }).code === 'P0001' &&
              error.message === 'INVENTORY_MOVEMENT_IMMUTABLE',
          );
        }

        await assert.rejects(
          pool.query(
            `UPDATE north_star_module.${quoteTestIdentifier(item.physicalTableName)}
                SET ${quoteTestIdentifier(baseUnit.physicalName)} = 'BOX'
              WHERE tenant_id = $1
                AND environment_id = $2
                AND ${quoteTestIdentifier(item.recordIdentity.column)} = $3`,
            [tenantA, environmentA, itemId],
          ),
          (error: unknown) =>
            error instanceof Error &&
            (error as Error & { code?: string; detail?: string }).code ===
              'P0001' &&
            error.message === 'INVENTORY_BASE_UNIT_IMMUTABLE' &&
            (error as Error & { detail?: string }).detail?.includes(
              `bindingMovementId=${movementId}`,
            ) === true,
        );
        await pool.query(
          'ALTER TABLE platform.active_release_pointers DISABLE TRIGGER active_release_pointer_exact_swap',
        );
        try {
          await pool.query(
            `UPDATE platform.active_release_pointers
                SET release_id = $1
              WHERE tenant_id = $2 AND environment_id = $3`,
            [releases.a.target, tenantA, environmentA],
          );
          await pool.query(
            `DROP TRIGGER ${quoteTestIdentifier(companion.reservationTriggerName)}
               ON north_star_module.${quoteTestIdentifier(movement.physicalTableName)}`,
          );
          await assertCatalogDrift(
            materializer,
            contexts.a,
            new RegExp(
              `missing managed trigger [^.]+\\.${companion.reservationTriggerName}`,
            ),
          );
        } finally {
          await pool.query(
            'ALTER TABLE platform.active_release_pointers ENABLE TRIGGER active_release_pointer_exact_swap',
          );
        }
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

test('fold-function drift surfaces the specific diagnostic before a terminal claim mismatch', async () => {
  const emptyDefinition = emptyModuleDefinition();
  const source = mustCompile(moduleInput(emptyDefinition));
  const currentDefinition = ordinaryModuleV1();
  const target = mustCompile(
    moduleInput(currentDefinition, expectedActiveReleaseFrom(source)),
  );

  await withEphemeralPostgres(
    'module-fold-diagnostic-precedence',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        const loaded = await loadMigrations(migrations);
        const migrationResult = await runMigrations(admin, loaded);
        assert.equal(migrationResult.verified.length, loaded.length);
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
          definitionBytes(currentDefinition),
        );
        await installSourcePointers(pool, releases);
        await grantExecutorAuthority(pool);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          moduleRuntimePool,
        );
        const generationId = randomUUID();
        const preparationId = randomUUID();
        const prepared = await materializer.prepare({
          context: contexts.a,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generationId,
          initiatedBy: principalA,
          preparationId,
          targetReleaseId: releases.a.target,
        });
        const installedFoldFunction = await readUnicodeCaseFoldFunction(pool);
        assert.ok(installedFoldFunction);
        const attemptId = await createV2Approval(
          runtimePool,
          pool,
          contexts,
          releases.a,
          target,
          prepared,
          preparationId,
        );
        await pool.query(
          `INSERT INTO north_star_internal.module_storage_attempt_claims (
             tenant_id, environment_id, generation_id,
             activation_attempt_id, coordinator_id, claim_state
           ) VALUES ($1,$2,$3,$4,$5,'COMPLETED')`,
          [tenantA, environmentA, generationId, attemptId, randomUUID()],
        );

        await pool.query(
          'ALTER EVENT TRIGGER module_fold_function_ddl_witness DISABLE',
        );
        await pool.query(
          `CREATE OR REPLACE FUNCTION north_star_module.nsm_unicode_case_fold_v1(value text)
             RETURNS text
             LANGUAGE sql
             IMMUTABLE STRICT PARALLEL SAFE
             SET search_path = pg_catalog
             AS $case_fold$ SELECT value $case_fold$`,
        );
        await pool.query(
          'ALTER EVENT TRIGGER module_fold_function_ddl_witness ENABLE',
        );
        try {
          await assert.rejects(
            materializer.executeApprovedAttempt({
              activationAttemptId: attemptId,
              context: contexts.a,
              coordinatorId: randomUUID(),
              generationId,
            }),
            (error: unknown) =>
              error instanceof ModuleStorageMaterializationError &&
              error.code === 'CASE_FOLD_FUNCTION_DEFINITION_MISMATCH' &&
              !error.message.includes('ATTEMPT_CLAIM_MISMATCH'),
          );
          const claim = await pool.query<{ claim_state: string }>(
            `SELECT claim_state
               FROM north_star_internal.module_storage_attempt_claims
              WHERE activation_attempt_id = $1`,
            [attemptId],
          );
          assert.deepEqual(claim.rows, [{ claim_state: 'COMPLETED' }]);
        } finally {
          await pool.query(installedFoldFunction.definition);
        }
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

test('a pre-existing relation index executes as atomic locking DDL and rejects invalid declared shape', async () => {
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
  const relationIndexElement = upgradeTransition.elements.find(
    (element) =>
      element.kind === 'createIndex' &&
      element.physicalObjectName === relationIndex.physicalName,
  );
  assert.ok(relationIndexElement);
  assert.equal(
    relationIndexElement.classification.preparationValidity,
    'deferredOnlineFamily',
  );

  await withEphemeralPostgres(
    'module-relation-index-upgrade',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        const loaded = await loadMigrations(migrations);
        const migrationResult = await runMigrations(admin, loaded);
        assert.equal(migrationResult.verified.length, loaded.length);
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
        const prepared = await materializer.prepare({
          context: contexts.a,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generationId,
          initiatedBy: principalA,
          preparationId,
          targetReleaseId: next.target,
        });
        assert.equal(prepared.dataState, 'PENDING_IN_ATTEMPT');
        assert.equal(
          prepared.diff.elements.find(
            (element) => element.elementId === relationIndexElement.elementId,
          )?.disposition,
          'PENDING_IN_ATTEMPT',
        );
        await assertIndexPresence(pool, relationIndex.physicalName, false);

        const attemptId = await createV2Approval(
          runtimePool,
          pool,
          contexts,
          next,
          upgrade,
          prepared,
          preparationId,
        );
        const tableName = sourceEntityName(upgradeStorage, relationIndex);
        const readStepApplications = async () =>
          (
            await pool.query<{ count: string }>(
              `SELECT count(*)::text AS count
                 FROM north_star_internal.module_storage_element_applications
                WHERE generation_id = $1 AND element_id = $2
                  AND attempt_id = $3`,
              [generationId, relationIndexElement.elementId, attemptId],
            )
          ).rows[0]?.count;

        await pool.query(
          `ALTER TABLE north_star_module.${quoteTestIdentifier(tableName)} OWNER TO postgres`,
        );
        await assert.rejects(
          materializer.executeApprovedAttempt({
            activationAttemptId: attemptId,
            context: contexts.a,
            coordinatorId: randomUUID(),
            generationId,
          }),
          (error: unknown) =>
            error instanceof Error &&
            (error as Error & { code?: string }).code === '42501',
        );
        assert.equal(await readStepApplications(), '0');
        await assertIndexPresence(pool, relationIndex.physicalName, false);
        await pool.query(
          `ALTER TABLE north_star_module.${quoteTestIdentifier(tableName)} OWNER TO north_star_module_materializer`,
        );

        const receiptFailureConstraint = 'pr6c_reject_applied_step_receipt';
        await pool.query(
          `ALTER TABLE north_star_internal.module_storage_element_applications
             ADD CONSTRAINT ${receiptFailureConstraint}
             CHECK (NOT (
               generation_id = '${generationId}'::uuid
               AND element_id = '${relationIndexElement.elementId}'
               AND application_state = 'APPLIED'
             ))`,
        );
        await assert.rejects(
          materializer.executeApprovedAttempt({
            activationAttemptId: attemptId,
            context: contexts.a,
            coordinatorId: randomUUID(),
            generationId,
          }),
          (error: unknown) =>
            error instanceof Error &&
            (error as Error & { code?: string }).code === '23514',
        );
        assert.equal(await readStepApplications(), '0');
        await assertIndexPresence(pool, relationIndex.physicalName, false);
        await pool.query(
          `ALTER TABLE north_star_internal.module_storage_element_applications
             DROP CONSTRAINT ${receiptFailureConstraint}`,
        );

        const executed = await materializer.executeApprovedAttempt({
          activationAttemptId: attemptId,
          context: contexts.a,
          coordinatorId: randomUUID(),
          generationId,
        });
        assert.equal(executed.disposition, 'READY_TO_SWAP');
        assert.equal(executed.deferredOnlineFamilyElementsProcessed, 1);
        assert.equal(await readStepApplications(), '2');
        await assertIndexPresence(pool, relationIndex.physicalName, true);
        const declaredShape = await pool.query<{
          ready: boolean;
          valid: boolean;
        }>(
          `SELECT index_record.indisready AS ready,
                  index_record.indisvalid AS valid
             FROM pg_index AS index_record
             JOIN pg_class AS index_relation
               ON index_relation.oid = index_record.indexrelid
             JOIN pg_namespace AS namespace
               ON namespace.oid = index_relation.relnamespace
            WHERE namespace.nspname = 'north_star_module'
              AND index_relation.relname = $1`,
          [relationIndex.physicalName],
        );
        assert.deepEqual(declaredShape.rows, [{ ready: true, valid: true }]);

        const notReady = await pool.query(
          `UPDATE pg_index AS index_record
              SET indisready = false
             FROM pg_class AS index_relation
             JOIN pg_namespace AS namespace
               ON namespace.oid = index_relation.relnamespace
            WHERE index_record.indexrelid = index_relation.oid
              AND index_record.indisvalid
              AND namespace.nspname = 'north_star_module'
              AND index_relation.relname = $1`,
          [relationIndex.physicalName],
        );
        assert.equal(notReady.rowCount, 1);
        await assert.rejects(
          materializer.verifyLiveCatalog(contexts.a),
          (error: unknown) =>
            error instanceof ModuleStorageMaterializationError &&
            error.code === 'CATALOG_DRIFT' &&
            error.message.includes(
              `altered managed index ${tableName}.${relationIndex.physicalName}`,
            ),
        );
        const readinessRestored = await pool.query(
          `UPDATE pg_index AS index_record
              SET indisready = true
             FROM pg_class AS index_relation
             JOIN pg_namespace AS namespace
               ON namespace.oid = index_relation.relnamespace
            WHERE index_record.indexrelid = index_relation.oid
              AND NOT index_record.indisready
              AND index_record.indisvalid
              AND namespace.nspname = 'north_star_module'
              AND index_relation.relname = $1`,
          [relationIndex.physicalName],
        );
        assert.equal(readinessRestored.rowCount, 1);

        const invalidated = await pool.query(
          `UPDATE pg_index AS index_record
              SET indisvalid = false
             FROM pg_class AS index_relation
             JOIN pg_namespace AS namespace
               ON namespace.oid = index_relation.relnamespace
            WHERE index_record.indexrelid = index_relation.oid
              AND namespace.nspname = 'north_star_module'
              AND index_relation.relname = $1`,
          [relationIndex.physicalName],
        );
        assert.equal(invalidated.rowCount, 1);
        await assert.rejects(
          materializer.verifyLiveCatalog(contexts.a),
          (error: unknown) =>
            error instanceof ModuleStorageMaterializationError &&
            error.code === 'CATALOG_DRIFT' &&
            error.message.includes(
              `altered managed index ${tableName}.${relationIndex.physicalName}`,
            ),
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

test('a released required relation is widened by executed DDL, and a mixed live-root set is tolerated', async () => {
  // Round-1 finding F2. Before this test, BOTH new provider behaviours were
  // unobserved: deleting the whole `case 'relaxNotNull'` from `applyDdlElement`
  // left every gate green (the switch is not exhaustiveness-checked), and so
  // did deleting the widening branch from `mergeExpectedRelations`, because no
  // suite supplied the mixed old/new root set that branch exists for. This test
  // observes the CATALOG, not the plan.
  const emptyDefinition = emptyModuleDefinition();
  const requiredDefinition = ordinaryModuleV1() as {
    relations: Array<Record<string, unknown>>;
  };
  requiredDefinition.relations.push(widenableRelation(true));
  const optionalDefinition = ordinaryModuleV1() as {
    relations: Array<Record<string, unknown>>;
  };
  optionalDefinition.relations.push(widenableRelation(false));

  const source = mustCompile(moduleInput(emptyDefinition));
  const required = mustCompile(
    moduleInput(requiredDefinition, expectedActiveReleaseFrom(source)),
  );
  const optional = mustCompile(
    moduleInput(optionalDefinition, expectedActiveReleaseFrom(required)),
  );

  const requiredStorage = projectionPayload<StorageTargetPayloadV1>(
    required,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const relationId = `${FIXTURE_IDS.namespace}:relation.master_role_widenable`;
  const relation = requiredStorage.relations.find(
    (entry) => entry.relationId === relationId,
  );
  assert.ok(relation);
  assert.equal(relation.relationColumn.nullable, false);
  const columnName = relation.relationColumn.physicalName;
  const tableName = requiredStorage.entities.find(
    (entity) => entity.entityId === relation.sourceEntityId,
  )!.physicalTableName;

  const transition = projectionPayload<StorageTransitionEnvelope>(
    optional,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  const widening = transition.elements.find(
    (element) => element.kind === 'relaxNotNull',
  );
  assert.ok(widening);
  assert.equal(widening.physicalObjectName, columnName);
  assert.equal(widening.classification.preparationValidity, 'preApprovalInert');

  const readNullability = async (pool: pg.Pool): Promise<string | undefined> =>
    (
      await pool.query<{ is_nullable: string }>(
        `SELECT is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'north_star_module'
            AND table_name = $1
            AND column_name = $2`,
        [tableName, columnName],
      )
    ).rows[0]?.is_nullable;

  await withEphemeralPostgres(
    'module-relation-requiredness-relaxation',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        const loaded = await loadMigrations(migrations);
        const migrationResult = await runMigrations(admin, loaded);
        assert.equal(migrationResult.verified.length, loaded.length);
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
        // BOTH tenants are accounted on the REQUIRED root. That is what makes
        // the live-root set mixed once tenant A advances, and it is the whole
        // point of using `persistPairForBothTenants` here.
        const releases = await persistPairForBothTenants(
          runtimePool,
          contexts,
          source,
          definitionBytes(emptyDefinition),
          required,
          definitionBytes(requiredDefinition),
        );
        const next = await persistNextRelease(
          runtimePool,
          contexts.a,
          releases.a.target,
          optional,
          definitionBytes(optionalDefinition),
        );
        await installSourcePointers(pool, releases);
        await grantExecutorAuthority(pool);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          moduleRuntimePool,
        );

        // Tenant A materializes the REQUIRED release. The column is created
        // NOT NULL, and that pre-state is asserted so the flip below cannot be
        // read from a column that was already nullable.
        await materializer.prepare({
          context: contexts.a,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generationId: randomUUID(),
          initiatedBy: principalA,
          preparationId: randomUUID(),
          targetReleaseId: releases.a.target,
        });
        assert.equal(await readNullability(pool), 'NO');

        // Tenant B materializes the SAME required release and STAYS there, so
        // its root remains accounted while A moves on.
        await materializer.prepare({
          context: contexts.b,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generationId: randomUUID(),
          initiatedBy: principalB,
          preparationId: randomUUID(),
          targetReleaseId: releases.b.target,
        });
        assert.equal(await readNullability(pool), 'NO');

        await setActiveReleasePointer(pool, releases.a.target);
        const generationId = randomUUID();
        const prepared = await materializer.prepare({
          context: contexts.a,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generationId,
          initiatedBy: principalA,
          preparationId: randomUUID(),
          targetReleaseId: next.target,
        });

        // 1. The element is APPLIED at PREPARE, not deferred to an attempt.
        assert.equal(
          prepared.diff.elements.find(
            (element) => element.elementId === widening.elementId,
          )?.disposition,
          'APPLIED',
        );
        assert.equal(prepared.dataState, 'NOT_REQUIRED');

        // 2. The element is PERSISTED under its new kind, which is what
        //    migration 0022's CHECK constraint has to admit.
        const persisted = await pool.query<{
          element_kind: string;
          physical_object_name: string;
        }>(
          `SELECT element_kind, physical_object_name
             FROM north_star_internal.module_storage_elements
            WHERE element_id = $1`,
          [widening.elementId],
        );
        assert.deepEqual(persisted.rows, [
          { element_kind: 'relaxNotNull', physical_object_name: columnName },
        ]);
        const applied = await pool.query<{ application_state: string }>(
          `SELECT application_state
             FROM north_star_internal.module_storage_element_applications
            WHERE element_id = $1 AND generation_id = $2
            ORDER BY application_state`,
          [widening.elementId, generationId],
        );
        assert.deepEqual(
          applied.rows.map((row) => row.application_state),
          ['APPLIED'],
        );

        // 3. THE OBSERVATION. The catalog moved, so the DDL actually ran.
        //    Deleting `case 'relaxNotNull'` from `applyDdlElement` fails here
        //    and nowhere else in the matrix.
        assert.equal(await readNullability(pool), 'YES');

        // 4. Reaching this line at all proves `mergeExpectedRelations`
        //    tolerated the mixed set: tenant B is still accounted on the
        //    REQUIRED root while A now holds the OPTIONAL one, and catalog
        //    verification runs inside `prepare` over the union of both.
        //    Without the widening branch this throws LIVE_SET_SHAPE_CONFLICT.
        const accounted = await pool.query<{ count: string }>(
          `SELECT count(DISTINCT tenant_id)::text AS count
             FROM north_star_internal.module_storage_generations`,
        );
        assert.equal(accounted.rows[0]?.count, '2');

        // 5. A SECOND root pairing, by construction rather than permutation --
        //    and the round-2 review was right that the earlier wording here
        //    overstated it. Tenant B advances too, so its prepare presents
        //    (required, optional) as `initial` while tenant A's accounted root
        //    is already optional: the reverse of the pairing A saw. What this
        //    does NOT do is deterministically permute the scope order
        //    `loadAccountedLiveTargets` reads from
        //    `SELECT DISTINCT tenant_id ...`, so full order-independence rests
        //    on the predicate being tried in both directions, which is read
        //    from the source rather than executed here.
        const nextB = await persistNextRelease(
          runtimePool,
          contexts.b,
          releases.b.target,
          optional,
          definitionBytes(optionalDefinition),
        );
        await setActiveReleasePointerFor(pool, tenantB, releases.b.target);
        await materializer.prepare({
          context: contexts.b,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generationId: randomUUID(),
          initiatedBy: principalB,
          preparationId: randomUUID(),
          targetReleaseId: nextB.target,
        });
        assert.equal(await readNullability(pool), 'YES');

        // 6. The residue ADR-0061 declares, observed rather than argued: the
        //    constraint is gone at PREPARE, before any approval or attempt, and
        //    nothing in this system reverses a prepared element.
        const attempts = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM north_star_internal.module_storage_attempt_claims`,
        );
        assert.equal(attempts.rows[0]?.count, '0');
        assert.equal(await readNullability(pool), 'YES');
      } finally {
        await moduleRuntimePool.end();
        await materializerPool.end();
        await runtimePool.end();
      }
    },
  );
});

test('an enum-domain CHECK replacement is one statement under ACCESS EXCLUSIVE and leaves no unconstrained window', async () => {
  // Stop-condition 1 of the ENUM-WIDEN charter, committed rather than left in
  // a scratch probe. PostgreSQL has no ALTER CONSTRAINT for a CHECK
  // expression, so replacement is DROP plus ADD -- as two sub-commands of ONE
  // ALTER TABLE, exactly the statement `widenEnumDomainCheck` renders. This
  // measures PostgreSQL's transactional DDL under that statement shape against
  // a populated table: what lock it takes, what concurrent writers of the OLD
  // and the NEW value observe, what a third session sees in the catalog, and
  // what a backend killed mid-transaction leaves behind.
  const oldExpression = `v = ANY (ARRAY['a'::text, 'b'::text])`;
  const newExpression = `v = ANY (ARRAY['a'::text, 'b'::text, 'c'::text])`;
  await withEphemeralPostgres(
    'enum-check-replacement-window',
    async ({ connection, pool }) => {
      await pool.query('CREATE TABLE t (id int PRIMARY KEY, v text NOT NULL)');
      await pool.query(
        `ALTER TABLE t ADD CONSTRAINT k CHECK (${oldExpression}) NOT VALID`,
      );
      await pool.query(
        `INSERT INTO t
           SELECT g, CASE WHEN g % 2 = 0 THEN 'a' ELSE 'b' END
             FROM generate_series(1, 200000) AS g`,
      );
      // A lock-free catalog read: `pg_get_constraintdef` opens the relation
      // and would block behind the replacement, which is itself the lock doing
      // its job; this reads pg_constraint alone.
      const catalog = async () =>
        (
          await pool.query<{ n: string; oid: string; validated: boolean }>(
            `SELECT oid::text AS oid, convalidated AS validated,
                    (SELECT count(*)::text FROM pg_constraint WHERE conname = 'k') AS n
               FROM pg_constraint WHERE conname = 'k'`,
          )
        ).rows;
      const definition = async () =>
        (
          await pool.query<{ definition: string }>(
            `SELECT pg_get_expr(conbin, conrelid, true) AS definition
               FROM pg_constraint WHERE conname = 'k'`,
          )
        ).rows[0]?.definition;
      const before = await catalog();
      assert.equal(before.length, 1);
      assert.equal(before[0]?.validated, false);

      const replacer = new pg.Client(connection);
      const oldWriter = new pg.Client(connection);
      const newWriter = new pg.Client(connection);
      await Promise.all([
        replacer.connect(),
        oldWriter.connect(),
        newWriter.connect(),
      ]);
      try {
        await replacer.query('BEGIN');
        const started = performance.now();
        await replacer.query(
          `ALTER TABLE t DROP CONSTRAINT k,
             ADD CONSTRAINT k CHECK (${newExpression}) NOT VALID`,
        );
        const statementMilliseconds = performance.now() - started;
        const replacerPid = (
          await replacer.query<{ pid: number }>(
            'SELECT pg_backend_pid() AS pid',
          )
        ).rows[0]!.pid;
        // 1. The lock, read from pg_locks while the transaction is open.
        const locks = await pool.query<{ granted: boolean; mode: string }>(
          `SELECT l.mode, l.granted
             FROM pg_locks AS l
             JOIN pg_class AS r ON r.oid = l.relation
            WHERE r.relname = 't' AND l.pid = $1`,
          [replacerPid],
        );
        assert.deepEqual(locks.rows, [
          { granted: true, mode: 'AccessExclusiveLock' },
        ]);
        // 2. A third session sees exactly ONE constraint, the old OID, for the
        //    whole life of the transaction.
        assert.deepEqual(await catalog(), before);
        // 3. Writers of the OLD value and of the NEW value both wait on the
        //    relation lock. Their wait is observed from pg_stat_activity, not
        //    inferred from elapsed time.
        const settled = { new: 'pending', old: 'pending' };
        const newInsert = newWriter
          .query(`INSERT INTO t VALUES (900001, 'c')`)
          .then(
            () => {
              settled.new = 'succeeded';
            },
            (error: { code?: string }) => {
              settled.new = `failed ${String(error.code)}`;
            },
          );
        const oldInsert = oldWriter
          .query(`INSERT INTO t VALUES (900002, 'a')`)
          .then(
            () => {
              settled.old = 'succeeded';
            },
            (error: { code?: string }) => {
              settled.old = `failed ${String(error.code)}`;
            },
          );
        const waitForRelationLockWaiters = async (): Promise<number> => {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const waiting = await pool.query<{ count: string }>(
              `SELECT count(*)::text AS count
                 FROM pg_stat_activity
                WHERE wait_event_type = 'Lock' AND wait_event = 'relation'
                  AND query LIKE 'INSERT INTO t VALUES (90000%'`,
            );
            if (waiting.rows[0]?.count === '2') return 2;
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
          }
          return 0;
        };
        assert.equal(await waitForRelationLockWaiters(), 2);
        assert.deepEqual(settled, { new: 'pending', old: 'pending' });
        assert.deepEqual(await catalog(), before);
        await replacer.query('COMMIT');
        await Promise.all([newInsert, oldInsert]);
        // 4. After COMMIT both writers succeed -- the new value against the new
        //    definition, the old value against either -- and the catalog holds
        //    exactly one constraint again, under a NEW OID, still NOT VALID.
        assert.deepEqual(settled, { new: 'succeeded', old: 'succeeded' });
        const after = await catalog();
        assert.equal(after.length, 1);
        assert.notEqual(after[0]?.oid, before[0]?.oid);
        assert.equal(after[0]?.validated, false);
        assert.equal(await definition(), newExpression);
        console.log(
          `enum-widen: CHECK replacement over 200000 rows took ${statementMilliseconds.toFixed(1)} ms under AccessExclusiveLock`,
        );

        // 5. Crash safety: a backend killed mid-transaction leaves the
        //    constraint it was replacing, with its OID, and the value it did
        //    not admit still refused.
        const doomed = new pg.Client(connection);
        doomed.on('error', () => undefined);
        await doomed.connect();
        await doomed.query('BEGIN');
        await doomed.query(
          `ALTER TABLE t DROP CONSTRAINT k,
             ADD CONSTRAINT k CHECK (v = ANY (ARRAY['a'::text, 'b'::text, 'c'::text, 'd'::text])) NOT VALID`,
        );
        const doomedPid = (
          await doomed.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0]!.pid;
        await pool.query('SELECT pg_terminate_backend($1)', [doomedPid]);
        await doomed.end().catch(() => undefined);
        assert.deepEqual(await catalog(), after);
        const refused = await pool
          .query(`INSERT INTO t VALUES (900003, 'd')`)
          .then(
            () => null,
            (error: { code?: string; constraint?: string }) => ({
              code: error.code,
              constraint: error.constraint,
            }),
          );
        assert.deepEqual(refused, { code: '23514', constraint: 'k' });

        // 6. Behind a long-open reader the replacement WAITS rather than
        //    proceeding, and a lock_timeout bounds the wait with 55P03. The
        //    materializer sets no lock_timeout today; this records what one
        //    would do.
        const reader = new pg.Client(connection);
        await reader.connect();
        await reader.query('BEGIN');
        await reader.query('SELECT count(*) FROM t');
        const bounded = new pg.Client(connection);
        await bounded.connect();
        await bounded.query(`SET lock_timeout = '250ms'`);
        const timedOut = await bounded
          .query(
            `ALTER TABLE t DROP CONSTRAINT k,
               ADD CONSTRAINT k CHECK (v = ANY (ARRAY['a'::text, 'b'::text, 'c'::text, 'e'::text])) NOT VALID`,
          )
          .then(
            () => null,
            (error: { code?: string }) => error.code,
          );
        assert.equal(timedOut, '55P03');
        await reader.query('COMMIT');
        assert.deepEqual(await catalog(), after);
        await Promise.all([reader.end(), bounded.end()]);
      } finally {
        await Promise.all([replacer.end(), oldWriter.end(), newWriter.end()]);
      }
    },
  );
});

test('an enum-domain widening plans exactly one widenEnumDomain element, and every adjacent option-list change stays refused', () => {
  // Group 1 of the ENUM-WIDEN charter, without a database. `PUR-2c` measured
  // that ANY option-list change presented to the planner as a retype, because
  // `lowerColumn` fingerprints `fieldType` wholesale and an enum's `fieldType`
  // carries its options. The physical column is `text` before and after. The
  // predicate admits exactly the monotonic superset; everything adjacent to it
  // keeps the refusal it had, and each adjacent case varies ONE property.
  const previous = mustCompile(moduleInput(ordinaryModuleV2()));
  const widened = mustCompile(
    moduleInput(tierModule('widened'), expectedActiveReleaseFrom(previous)),
  );
  const target = projectionPayload<StorageTargetPayloadV1>(
    widened,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const parent = target.entities.find(
    (entity) => entity.entityId === FIXTURE_IDS.entityIds.parent,
  );
  assert.ok(parent);
  const check = parent.checkConstraints.find(
    (candidate) =>
      candidate.canonicalFieldId === FIXTURE_IDS.fieldIds.parentTier,
  );
  assert.ok(check);
  // The storage contract SORTS option ids, so the new option sorts first here.
  assert.deepEqual(check.enumOptionIds, [
    ENUM_WIDEN_OPTION_ID,
    FIXTURE_IDS.optionIds.premium,
    FIXTURE_IDS.optionIds.standard,
  ]);
  const transition = projectionPayload<StorageTransitionEnvelope>(
    widened,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  // ONE element, and it is the whole plan: no addColumn, no
  // addNotValidConstraint under the same name, no debt. The count is asserted
  // first so a planner that emits nothing dies on this message rather than on
  // the expected object below reading an element that is not there.
  assert.equal(
    transition.elements.length,
    1,
    'the widening plans one element and nothing else',
  );
  assert.deepEqual(
    transition.elements.map(({ elementId, ...entry }) => {
      void elementId;
      return entry;
    }),
    [
      {
        classification: {
          dataEffect: 'catalogOnly',
          operationalRisk: 'boundedCatalogLock',
          preparationValidity: 'preApprovalInert',
          semanticEffect: 'additive',
        },
        coexistence: {
          admission: 'additive',
          newRead: 'compatible',
          newWrite: 'compatible',
          oldRead: 'requiresReadFallback',
          oldWrite: 'compatible',
        },
        coexistenceImpact: 'requiresReadFallback',
        declaredDependencyIds: [],
        fieldId: FIXTURE_IDS.fieldIds.parentTier,
        kind: 'widenEnumDomain',
        physicalObjectName: check.physicalName,
        schemaVersion: transition.elements[0]!.schemaVersion,
        scope: {
          keyColumns: ['tenant_id', 'environment_id'],
          kind: 'tenantEnvironment',
        },
        storageDomain: 'managedModule',
        storageGeneration: 'dedicatedTyped/v1',
        subjectId: FIXTURE_IDS.entityIds.parent,
      },
    ],
    'the widening plans one element and nothing else',
  );
  assert.deepEqual(transition.tighteningDebt, []);

  // The preserved refusals. `narrowed` removes one option; `rebound` replaces
  // one option id with another at constant count; `relabelled` changes a label
  // and no id (equal sets are not a widening); `widenedAndRelabelled` and
  // `widenedAndReordered` widen AND change an existing option's label or
  // orderKey; `widenedAndSearchable` widens AND flips search mapping, so
  // neither additive exception alone matches; `widenedAndRetype` widens AND
  // retypes an unrelated column.
  // `widenedAndRelabelled` and `widenedAndReordered` are the round-1 finding:
  // a strict id superset whose EXISTING option records also moved. They come
  // before `widenedAndSearchable` so the exactness mutation dies on them.
  for (const variant of [
    'narrowed',
    'rebound',
    'relabelled',
    'widenedAndRelabelled',
    'widenedAndReordered',
    'widenedAndSearchable',
  ] as const) {
    const result = compileApplication(
      moduleInput(tierModule(variant), expectedActiveReleaseFrom(previous)),
    );
    assert.equal(result.status, 'failed', variant);
    if (result.status !== 'failed') return;
    assert.deepEqual(
      result.diagnostics.map(({ code, path, subjectId }) => ({
        code,
        path,
        subjectId,
      })),
      [
        {
          code: 'COMPILER_STORAGE_RETYPE_UNSUPPORTED',
          path: '$.fields.fieldType',
          subjectId: FIXTURE_IDS.fieldIds.parentTier,
        },
      ],
      variant,
    );
  }
  const retyped = compileApplication(
    moduleInput(
      tierModule('widenedAndRetype'),
      expectedActiveReleaseFrom(previous),
    ),
  );
  assert.equal(retyped.status, 'failed');
  if (retyped.status !== 'failed') return;
  assert.deepEqual(
    retyped.diagnostics.map(({ code, path }) => ({ code, path })),
    [
      {
        code: 'COMPILER_STORAGE_RETYPE_UNSUPPORTED',
        path: '$.fields.fieldType',
      },
    ],
  );
  assert.equal(
    retyped.diagnostics[0]?.subjectId,
    FIXTURE_IDS.fieldIds.parentName,
  );
});

test('a released enum domain is widened by one atomic CHECK replacement, observed through preparation, activation and the live business table', async () => {
  // Groups 2 and 3 of the ENUM-WIDEN charter: the nine assertions `PUR-2c`
  // §2.4b left as the specification, each made DIRECTLY against the catalog,
  // the receipts, the activation facts, SQLSTATE, and the real business table.
  const emptyDefinition = emptyModuleDefinition();
  const previousDefinition = ordinaryModuleV2();
  const widenedDefinition = tierModule('widened');
  const widenedPlusColumnDefinition = tierModule('widenedPlusColumn');

  const source = mustCompile(moduleInput(emptyDefinition));
  const previous = mustCompile(
    moduleInput(previousDefinition, expectedActiveReleaseFrom(source)),
  );
  const widened = mustCompile(
    moduleInput(widenedDefinition, expectedActiveReleaseFrom(previous)),
  );
  const widenedPlusColumn = mustCompile(
    moduleInput(
      widenedPlusColumnDefinition,
      expectedActiveReleaseFrom(previous),
    ),
  );
  // The tampered transition: the storage target still advertises the new
  // option, the envelope no longer carries the element that installs it. This
  // is `PUR-2c` §2.4's observed failure reconstructed as an artifact.
  const tampered = withoutWidenEnumDomainElement(widenedPlusColumn);

  const previousTarget = projectionPayload<StorageTargetPayloadV1>(
    previous,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const widenedTarget = projectionPayload<StorageTargetPayloadV1>(
    widened,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const parent = widenedTarget.entities.find(
    (entity) => entity.entityId === FIXTURE_IDS.entityIds.parent,
  );
  assert.ok(parent);
  const check = parent.checkConstraints.find(
    (candidate) =>
      candidate.canonicalFieldId === FIXTURE_IDS.fieldIds.parentTier,
  );
  assert.ok(check);
  const previousCheck = previousTarget.entities
    .find((entity) => entity.entityId === FIXTURE_IDS.entityIds.parent)
    ?.checkConstraints.find(
      (candidate) =>
        candidate.canonicalFieldId === FIXTURE_IDS.fieldIds.parentTier,
    );
  assert.ok(previousCheck);
  // Assertion 1: the candidate carries the new option and the previous does
  // not, under ONE physical constraint name derived from the field id alone.
  assert.equal(previousCheck.physicalName, check.physicalName);
  assert.deepEqual(previousCheck.enumOptionIds, [
    FIXTURE_IDS.optionIds.premium,
    FIXTURE_IDS.optionIds.standard,
  ]);
  assert.deepEqual(check.enumOptionIds, [
    ENUM_WIDEN_OPTION_ID,
    FIXTURE_IDS.optionIds.premium,
    FIXTURE_IDS.optionIds.standard,
  ]);
  const tierColumn = parent.columns.find(
    (column) => column.canonicalFieldId === FIXTURE_IDS.fieldIds.parentTier,
  );
  assert.ok(tierColumn);
  const tableName = parent.physicalTableName;
  const widening = projectionPayload<StorageTransitionEnvelope>(
    widened,
    PROJECTION_FAMILY_IDS.storageTransition,
  ).elements.find((element) => element.kind === 'widenEnumDomain');
  assert.ok(widening);
  assert.equal(widening.physicalObjectName, check.physicalName);

  await withEphemeralPostgres(
    'module-enum-domain-widening',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        const loaded = await loadMigrations(migrations);
        const migrationResult = await runMigrations(admin, loaded);
        assert.equal(migrationResult.verified.length, loaded.length);
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
          previous,
          definitionBytes(previousDefinition),
        );
        await installSourcePointers(pool, releases);
        await grantExecutorAuthority(pool);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          moduleRuntimePool,
        );

        // Both tenants materialize the PREVIOUS release, so the live-root set
        // is mixed the moment tenant A widens.
        for (const [context, release] of [
          [contexts.a, releases.a.target],
          [contexts.b, releases.b.target],
        ] as const) {
          await materializer.prepare({
            context,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            generationId: randomUUID(),
            initiatedBy: context.principalId,
            preparationId: randomUUID(),
            targetReleaseId: release,
          });
        }

        // Existing rows, in the REAL business table, under the previous
        // release's option set.
        const client = await pool.connect();
        const insertTier = async (
          context: TrustedRequestContext,
          tier: string,
        ): Promise<{
          code: string | undefined;
          constraint: string | undefined;
          table: string | undefined;
        } | null> =>
          insertModuleRecord(client, context, widenedTarget, parent.entityId, {
            [tierColumn.physicalName]: tier,
          }).then(
            () => null,
            (error: unknown) => {
              const shape = error as {
                code?: string;
                constraint?: string;
                table?: string;
              };
              return {
                code: shape.code,
                constraint: shape.constraint,
                table: shape.table,
              };
            },
          );
        try {
          assert.equal(
            await insertTier(contexts.a, FIXTURE_IDS.optionIds.standard),
            null,
          );
          assert.equal(
            await insertTier(contexts.a, FIXTURE_IDS.optionIds.premium),
            null,
          );

          // Assertions 7 and 9, the repair-before-measure control: the previous
          // release's CHECK must REJECT the option it does not declare, as
          // SQLSTATE 23514 from THAT constraint on THAT table. If the constraint
          // had already been widened -- or never constrained -- the acceptance
          // measured after the transition would prove nothing. This is asserted
          // on the captured error rather than through `assert.rejects`, so a
          // silent success fails on the message below and not on node's own,
          // and it is asserted BEFORE the definition is read, so a constraint
          // that constrains nothing dies here rather than on an option count.
          const rejection = await insertTier(contexts.a, ENUM_WIDEN_OPTION_ID);
          assert.equal(
            rejection?.code,
            '23514',
            'the previous release CHECK must reject the option it does not declare',
          );
          assert.equal(rejection?.constraint, check.physicalName);
          assert.equal(rejection?.table, tableName);

          // Assertion 6, before: the constraint, identified by table, name and
          // OID, with its definition read back from the catalog.
          const before = await readEnumDomainCheck(
            pool,
            tableName,
            check.physicalName,
          );
          assert.ok(before);
          assert.equal(before.validated, false);
          assert.deepEqual(before.optionIds, previousCheck.enumOptionIds);

          // `PUR-2c`'s residual, measured. Candidate verification's enumReject
          // witness is `enumOptionIds[0]` of the OPERATION CATALOG, which lists
          // options in declaration order -- not the storage contract's sorted
          // list `PUR-2c` read. This candidate declares the new option FIRST,
          // so the witness IS the new option, and verification run against the
          // stale CHECK -- before any transition is prepared -- does not admit
          // the candidate. Verification is not the gap; the missing element
          // was.
          await setActiveReleasePointer(pool, releases.a.target);
          const next = await persistNextRelease(
            runtimePool,
            contexts.a,
            releases.a.target,
            widened,
            definitionBytes(widenedDefinition),
          );
          const verificationAgainstStaleCheck =
            await new PostgresReleaseVerificationService(runtimePool)
              .executeSemanticCandidateAndPersist(contexts.a, {
                compiledRelease: widened,
                evidenceId: next.targetEvidence,
                releaseId: next.target,
              })
              .then(
                () => null,
                (error: unknown) => error,
              );
          assert.ok(
            verificationAgainstStaleCheck instanceof Error,
            'candidate verification must not admit the widened release against the stale CHECK',
          );
          assert.match(
            verificationAgainstStaleCheck.message,
            /VERIFICATION_OPERATION_FAILED|did not succeed|23514/u,
          );
          console.log(
            `enum-widen: verification against the stale CHECK refused with ${
              (verificationAgainstStaleCheck as { code?: string }).code ??
              verificationAgainstStaleCheck.name
            }: ${verificationAgainstStaleCheck.message}`,
          );
          // Verification's probe rows are archived, not removed, so the table
          // still carries rows -- and the CHECK is unchanged.
          assert.equal(
            (await readEnumDomainCheck(pool, tableName, check.physicalName))
              ?.oid,
            before.oid,
          );

          // The tampered-transition control, on tenant B, BEFORE the physical
          // constraint has moved: the target advertises three options, the
          // envelope installs none of them, and the addColumn it still carries
          // is what gets preparation as far as catalog verification. Expected
          // is the merged superset; actual is the untouched two-option CHECK.
          await setActiveReleasePointerFor(pool, tenantB, releases.b.target);
          const tamperedB = await persistNextRelease(
            runtimePool,
            contexts.b,
            releases.b.target,
            tampered,
            definitionBytes(widenedPlusColumnDefinition),
          );
          await assert.rejects(
            materializer.prepare({
              context: contexts.b,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              generationId: randomUUID(),
              initiatedBy: principalB,
              preparationId: randomUUID(),
              targetReleaseId: tamperedB.target,
            }),
            (error: unknown) =>
              error instanceof ModuleStorageMaterializationError &&
              error.code === 'CATALOG_DRIFT' &&
              new RegExp(
                `altered managed constraint ${tableName}\\.${check.physicalName}`,
                'u',
              ).test(error.message),
          );
          assert.equal(
            (await readEnumDomainCheck(pool, tableName, check.physicalName))
              ?.oid,
            before.oid,
          );

          // Recovery: a preparation that fails AFTER the widening DDL has run
          // rolls the DDL back with it. A stray index makes catalog
          // verification refuse the prepared catalog; the constraint must come
          // back with its ORIGINAL OID, and the retry must then succeed.
          await pool.query(
            `CREATE INDEX enum_widen_recovery_probe
               ON north_star_module.${quoteTestIdentifier(tableName)} (${quoteTestIdentifier(tierColumn.physicalName)})`,
          );
          await assert.rejects(
            materializer.prepare({
              context: contexts.a,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              generationId: randomUUID(),
              initiatedBy: principalA,
              preparationId: randomUUID(),
              targetReleaseId: next.target,
            }),
            (error: unknown) =>
              error instanceof ModuleStorageMaterializationError &&
              error.code === 'CATALOG_DRIFT',
          );
          const afterRollback = await readEnumDomainCheck(
            pool,
            tableName,
            check.physicalName,
          );
          assert.equal(afterRollback?.oid, before.oid);
          assert.deepEqual(
            afterRollback?.optionIds,
            previousCheck.enumOptionIds,
          );
          assert.equal(
            (await insertTier(contexts.a, ENUM_WIDEN_OPTION_ID))?.code,
            '23514',
          );
          await pool.query(
            'DROP INDEX north_star_module.enum_widen_recovery_probe',
          );

          // THE TRANSITION. Tenant A prepares the widened release while tenant
          // B is still accounted on the previous root -- and while a business
          // writer holds an open transaction on the table. This is the lock
          // measured through the COMPOSED prepare path rather than on a raw
          // statement (round-1 finding): the materializer is observed in
          // pg_stat_activity waiting on the relation lock behind that writer,
          // the prepare does not resolve until the writer commits, and the
          // widening lands afterwards.
          const generationId = randomUUID();
          const preparationId = randomUUID();
          const writerAhead = await pool.connect();
          let preparedState: 'pending' | 'resolved' = 'pending';
          let prepared: Awaited<
            ReturnType<PostgresModuleStorageMaterializer['prepare']>
          >;
          try {
            await writerAhead.query('BEGIN');
            await insertModuleRecord(
              writerAhead,
              contexts.a,
              widenedTarget,
              parent.entityId,
              { [tierColumn.physicalName]: FIXTURE_IDS.optionIds.premium },
            );
            const preparing = materializer
              .prepare({
                context: contexts.a,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                generationId,
                initiatedBy: principalA,
                preparationId,
                targetReleaseId: next.target,
              })
              .then((result) => {
                preparedState = 'resolved';
                return result;
              });
            const waitForMaterializerLockWait = async (): Promise<boolean> => {
              for (let attempt = 0; attempt < 400; attempt += 1) {
                const waiting = await pool.query<{ count: string }>(
                  `SELECT count(*)::text AS count
                     FROM pg_stat_activity
                    WHERE usename = 'north_star_module_materializer'
                      AND wait_event_type = 'Lock'
                      AND wait_event = 'relation'`,
                );
                if (waiting.rows[0]?.count === '1') return true;
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
              }
              return false;
            };
            assert.equal(
              await waitForMaterializerLockWait(),
              true,
              'the composed prepare must be observed waiting on the relation lock behind an open writer',
            );
            assert.equal(preparedState, 'pending');
            // Lock-free: `pg_get_expr` would open the relation and queue
            // behind the materializer's pending ACCESS EXCLUSIVE request,
            // deadlocking this test against its own writer.
            const oidWhileWaiting = await pool.query<{ oid: string }>(
              `SELECT constraint_record.oid::text AS oid
                 FROM pg_constraint AS constraint_record
                 JOIN pg_class AS relation_record
                   ON relation_record.oid = constraint_record.conrelid
                WHERE relation_record.relname = $1
                  AND constraint_record.conname = $2`,
              [tableName, check.physicalName],
            );
            assert.equal(oidWhileWaiting.rows[0]?.oid, before.oid);
            await writerAhead.query('COMMIT');
            prepared = await preparing;
          } finally {
            writerAhead.release();
          }
          assert.equal(preparedState, 'resolved');
          // Assertion 3: the preparation receipt is for THIS candidate and the
          // element is APPLIED at PREPARE, before any approval exists.
          assert.equal(prepared.targetReleaseId, next.target);
          assert.equal(prepared.receipt.state, 'PREPARED');
          assert.equal(prepared.dataState, 'NOT_REQUIRED');
          assert.equal(
            prepared.diff.elements.find(
              (element) => element.elementId === widening.elementId,
            )?.disposition,
            'APPLIED',
          );
          const persisted = await pool.query<{
            element_kind: string;
            physical_object_name: string;
          }>(
            `SELECT element_kind, physical_object_name
               FROM north_star_internal.module_storage_elements
              WHERE element_id = $1`,
            [widening.elementId],
          );
          // Migration 0024's CHECK is what admits this row.
          assert.deepEqual(persisted.rows, [
            {
              element_kind: 'widenEnumDomain',
              physical_object_name: check.physicalName,
            },
          ]);
          const receipt = await pool.query<{
            catalog_verified: boolean;
            receipt_state: string;
            target_release_id: string;
          }>(
            `SELECT catalog_verified, receipt_state, target_release_id
               FROM north_star_internal.module_storage_catalog_receipts
              WHERE generation_id = $1`,
            [generationId],
          );
          assert.deepEqual(receipt.rows, [
            {
              catalog_verified: true,
              receipt_state: 'PREPARED',
              target_release_id: next.target,
            },
          ]);

          // Assertion 6, after: same table, same name, NEW OID (the constraint
          // was replaced, not edited), three options, still NOT VALID because
          // no row was scanned.
          const after = await readEnumDomainCheck(
            pool,
            tableName,
            check.physicalName,
          );
          assert.ok(after);
          assert.notEqual(after.oid, before.oid);
          assert.equal(after.validated, false);
          assert.deepEqual(after.optionIds, check.enumOptionIds);

          // Assertion 8: the same statement, two values differing only in the
          // enum value, both accepted by the REAL business table now.
          assert.equal(
            await insertTier(contexts.a, FIXTURE_IDS.optionIds.standard),
            null,
          );
          assert.equal(
            await insertTier(contexts.a, ENUM_WIDEN_OPTION_ID),
            null,
          );
          const stored = await pool.query<{ tier: string; count: string }>(
            `SELECT ${quoteTestIdentifier(tierColumn.physicalName)} AS tier, count(*)::text AS count
               FROM north_star_module.${quoteTestIdentifier(tableName)}
              WHERE tenant_id = $1 AND ${quoteTestIdentifier(tierColumn.physicalName)} IS NOT NULL
              GROUP BY 1 ORDER BY 1`,
            [tenantA],
          );
          assert.deepEqual(
            stored.rows.map((row) => row.tier),
            [
              ENUM_WIDEN_OPTION_ID,
              FIXTURE_IDS.optionIds.premium,
              FIXTURE_IDS.optionIds.standard,
            ],
          );
          // A value NO release declares is still refused -- the constraint was
          // widened, not removed.
          assert.equal(
            (
              await insertTier(
                contexts.a,
                `${FIXTURE_IDS.namespace}:option.undeclared`,
              )
            )?.code,
            '23514',
          );

          // Approval, attempt, and activation. Assertion 4: the activation
          // facts record a module transition, and conformance is reported from
          // the catalog receipt that observed the widened definition.
          const attemptId = await createV2Approval(
            runtimePool,
            pool,
            contexts,
            next,
            widened,
            prepared,
            preparationId,
          );
          assert.deepEqual(
            await readApprovedAttempt(
              materializerPool,
              contexts.a,
              attemptId,
              preparationId,
            ),
            [{ approved: true }],
          );
          const executed = await materializer.executeApprovedAttempt({
            activationAttemptId: attemptId,
            context: contexts.a,
            coordinatorId: randomUUID(),
            generationId,
          });
          assert.equal(executed.disposition, 'READY_TO_SWAP');
          assert.equal(executed.receipt?.state, 'READY_TO_SWAP');
          // Candidate verification AFTER the widening: the same first-declared
          // witness, now admitted by the physical constraint.
          await admitPreparedTarget(runtimePool, contexts.a, next);
          const activated = await new PostgresReleaseActivationService(
            runtimePool,
          ).activate(contexts.system, {
            activationAttemptId: minted(attemptId),
          });
          assert.equal(activated.status, 'SWAPPED_VERIFIED');
          const facts = await pool.query<{
            module_schema_conformance_passed: boolean;
            verification_version: string;
          }>(
            `SELECT verification_version, module_schema_conformance_passed
               FROM platform.release_activation_verification_receipts
              WHERE activation_attempt_id = $1`,
            [attemptId],
          );
          assert.deepEqual(facts.rows, [
            {
              module_schema_conformance_passed: true,
              verification_version:
                'northstar.release-activation-verification/v2',
            },
          ]);
          const pointer = await pool.query<{ release_id: string }>(
            `SELECT release_id FROM platform.active_release_pointers
              WHERE tenant_id = $1 AND environment_id = $2`,
            [tenantA, environmentA],
          );
          assert.equal(pointer.rows[0]?.release_id, next.target);
          assert.deepEqual(
            (await materializer.verifyLiveCatalog(contexts.a)).drift,
            [],
          );

          // Idempotent replay, from the other side of the mixed live set:
          // tenant B prepares the same widened release against a constraint
          // that is ALREADY wide enough. The element is APPLIED with no DDL --
          // the OID does not move -- and the mixed-root catalog verification
          // tolerates B's previous root beside A's widened one.
          const nextB = await persistNextRelease(
            runtimePool,
            contexts.b,
            releases.b.target,
            widened,
            definitionBytes(widenedDefinition),
          );
          const preparedB = await materializer.prepare({
            context: contexts.b,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            generationId: randomUUID(),
            initiatedBy: principalB,
            preparationId: randomUUID(),
            targetReleaseId: nextB.target,
          });
          assert.equal(
            preparedB.diff.elements.find(
              (element) => element.elementId === widening.elementId,
            )?.disposition,
            'APPLIED',
          );
          const replayed = await readEnumDomainCheck(
            pool,
            tableName,
            check.physicalName,
          );
          assert.equal(
            replayed?.oid,
            after.oid,
            'a replay against an already-wide constraint must not reissue the DDL',
          );
          assert.deepEqual(replayed?.optionIds, check.enumOptionIds);
          assert.deepEqual(
            (await materializer.verifyLiveCatalog(contexts.b)).drift,
            [],
          );

          // The element NEVER narrows. A forged target whose option set
          // diverges from the live constraint -- one option swapped for another
          // it does not carry -- is refused before any DDL runs, and the
          // constraint keeps the OID the widening gave it. The compiler cannot
          // emit this target; the guard is the provider's own fence against a
          // target it did not compile.
          const forgedB = await persistNextRelease(
            runtimePool,
            contexts.b,
            releases.b.target,
            withDivergentEnumDomain(widened),
            definitionBytes(widenedDefinition),
          );
          await assert.rejects(
            materializer.prepare({
              context: contexts.b,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              generationId: randomUUID(),
              initiatedBy: principalB,
              preparationId: randomUUID(),
              targetReleaseId: forgedB.target,
            }),
            (error: unknown) =>
              error instanceof ModuleStorageMaterializationError &&
              error.code === 'ENUM_DOMAIN_NARROWING_REJECTED',
          );
          assert.equal(
            (await readEnumDomainCheck(pool, tableName, check.physicalName))
              ?.oid,
            after.oid,
          );

          // Round-1 finding: an ABSENT released CHECK is catalog drift, not a
          // widening. Adding the target constraint NOT VALID would be a
          // pre-approval tightening -- the table admitted everything while
          // the constraint was gone -- and it would repair the drift before
          // catalog verification measured it. The element refuses, and the
          // constraint stays absent for the verifier to find.
          await pool.query(
            `ALTER TABLE north_star_module.${quoteTestIdentifier(tableName)}
               DROP CONSTRAINT ${quoteTestIdentifier(check.physicalName)}`,
          );
          await assert.rejects(
            materializer.prepare({
              context: contexts.b,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              generationId: randomUUID(),
              initiatedBy: principalB,
              preparationId: randomUUID(),
              targetReleaseId: nextB.target,
            }),
            (error: unknown) =>
              error instanceof ModuleStorageMaterializationError &&
              error.code === 'ENUM_DOMAIN_CHECK_MISSING',
          );
          assert.equal(
            await readEnumDomainCheck(pool, tableName, check.physicalName),
            null,
          );
          await assertCatalogDrift(
            materializer,
            contexts.b,
            /missing managed constraint/u,
          );
        } finally {
          client.release();
        }
      } finally {
        await moduleRuntimePool.end();
        await materializerPool.end();
        await runtimePool.end();
      }
    },
  );
});

test('a pre-existing generated fold and prefix index record their measured locking window', async () => {
  const emptyDefinition = emptyModuleDefinition();
  const source = mustCompile(moduleInput(emptyDefinition));
  const currentDefinition = ordinaryModuleV2() as {
    fields: Array<Record<string, unknown>>;
    queries: Array<{
      resolveMatchKeys?: Array<{
        field?: { targetId?: unknown };
      }>;
    }>;
  } & Record<string, unknown>;
  const searchableNotes = currentDefinition.fields.find(
    (field) => field.fieldId === FIXTURE_IDS.fieldIds.parentNotes,
  );
  assert.ok(searchableNotes);
  searchableNotes.searchable = true;
  assert.equal('businessKey' in searchableNotes, false);
  assert.equal(
    currentDefinition.queries.some((query) =>
      query.resolveMatchKeys?.some(
        (key) => key.field?.targetId === FIXTURE_IDS.fieldIds.parentNotes,
      ),
    ),
    false,
    'the notes fixture must remain outside resolve-match authority',
  );
  const currentBytes = definitionBytes(currentDefinition);
  const originallyCompiled = mustCompile(
    moduleInput(currentDefinition, expectedActiveReleaseFrom(source)),
  );
  const legacy = withoutFoldedColumn(
    originallyCompiled,
    FIXTURE_IDS.fieldIds.parentNotes,
  );
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
    (column) => column.canonicalFieldId === FIXTURE_IDS.fieldIds.parentNotes,
  );
  assert.ok(foldedColumn);
  const foldedIndex = parent.indexes.find(
    (index) =>
      index.indexKind === 'foldedAccess' &&
      index.columnNames.includes(foldedColumn.physicalName),
  );
  assert.ok(foldedIndex, 'search-only folded columns require a prefix btree');
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
  const addIndex = upgradeTransition.elements.find(
    (element) =>
      element.kind === 'createIndex' &&
      element.physicalObjectName === foldedIndex.physicalName,
  );
  assert.ok(addIndex);
  assert.deepEqual(addIndex.declaredDependencyIds, [addColumn.elementId]);
  assert.equal(
    addColumn.classification.preparationValidity,
    'deferredOnlineFamily',
  );
  assert.equal(addColumn.classification.dataEffect, 'rowMutation');
  assert.equal(
    upgradeTransition.elements.filter(
      (element) =>
        element.classification.preparationValidity === 'deferredOnlineFamily',
    ).length,
    2,
  );

  await withEphemeralPostgres(
    'module-folded-column-upgrade',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        const loaded = await loadMigrations(migrations);
        const migrationResult = await runMigrations(admin, loaded);
        assert.equal(migrationResult.verified.length, loaded.length);
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
        application_name: 'pr6c-materializer',
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
        await assertIndexPresence(pool, foldedIndex.physicalName, false);

        const numberColumn = parent.columns.find(
          (column) =>
            column.canonicalFieldId === FIXTURE_IDS.fieldIds.parentNumber,
        );
        const nameColumn = parent.columns.find(
          (column) =>
            column.canonicalFieldId === FIXTURE_IDS.fieldIds.parentName,
        );
        const notesColumn = parent.columns.find(
          (column) =>
            column.canonicalFieldId === FIXTURE_IDS.fieldIds.parentNotes,
        );
        assert.ok(numberColumn);
        assert.ok(nameColumn);
        assert.ok(notesColumn);
        assert.equal(notesColumn.searchMapping, 'normalizedTextIndex');
        assert.equal(
          parent.uniqueKeys.some((uniqueKey) =>
            uniqueKey.columns.includes(notesColumn.physicalName),
          ),
          false,
          'the notes fixture must remain outside unique-key authority',
        );
        await pool.query(
          `INSERT INTO north_star_module.${quoteTestIdentifier(parent.physicalTableName)} (
             tenant_id, environment_id,
             ${quoteTestIdentifier(parent.recordIdentity.column)},
             ${quoteTestIdentifier(numberColumn.physicalName)},
             ${quoteTestIdentifier(nameColumn.physicalName)},
             ${quoteTestIdentifier(notesColumn.physicalName)}
           )
           SELECT $1, $2,
                  ('10000000-0000-4000-8000-' || lpad(row_number::text, 12, '0'))::uuid,
                  'MEASURE-' || row_number::text,
                  'Measured party ' || row_number::text,
                  'Measured notes ' || row_number::text
             FROM generate_series(1, $3::integer) AS row_number`,
          [tenantA, environmentA, pr6cMeasurementRows],
        );

        await setActiveReleasePointer(pool, releases.a.target);
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
        assert.equal(
          prepared.diff.elements.find(
            (element) => element.elementId === addColumn.elementId,
          )?.disposition,
          'PENDING_IN_ATTEMPT',
        );
        assert.equal(
          prepared.diff.elements.find(
            (element) => element.elementId === addIndex.elementId,
          )?.disposition,
          'PENDING_IN_ATTEMPT',
        );
        const attemptId = await createV2Approval(
          runtimePool,
          pool,
          contexts,
          next,
          upgrade,
          prepared,
          preparationId,
        );

        const blocker = await pool.connect();
        const writer = await pool.connect();
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            `LOCK TABLE north_star_module.${quoteTestIdentifier(parent.physicalTableName)} IN ROW EXCLUSIVE MODE`,
          );
          const execution = materializer.executeApprovedAttempt({
            activationAttemptId: attemptId,
            context: contexts.a,
            coordinatorId: randomUUID(),
            generationId,
          });
          await waitForTableLock(
            pool,
            'pr6c-materializer',
            parent.physicalTableName,
            'AccessExclusiveLock',
            false,
          );

          await writer.query('BEGIN');
          await writer.query(
            "SELECT set_config('application_name', 'pr6c-writer', false)",
          );
          const writerUpdate = writer
            .query(
              `UPDATE north_star_module.${quoteTestIdentifier(parent.physicalTableName)}
                  SET ${quoteTestIdentifier(parent.archive.archivedAtColumn)} =
                      ${quoteTestIdentifier(parent.archive.archivedAtColumn)}
                WHERE tenant_id = $1 AND environment_id = $2
                  AND ${quoteTestIdentifier(parent.recordIdentity.column)} = $3`,
              [tenantA, environmentA, '10000000-0000-4000-8000-000000000001'],
            )
            .then(async () => writer.query('COMMIT'));
          await waitForTableLock(
            pool,
            'pr6c-writer',
            parent.physicalTableName,
            'RowExclusiveLock',
            false,
          );

          const blockingStarted = performance.now();
          await blocker.query('COMMIT');
          await writerUpdate;
          const blockingWindowMilliseconds =
            performance.now() - blockingStarted;
          const executed = await execution;
          assert.equal(executed.disposition, 'READY_TO_SWAP');
          assert.equal(executed.deferredOnlineFamilyElementsProcessed, 2);
          assert.ok(
            Number.isFinite(blockingWindowMilliseconds) &&
              blockingWindowMilliseconds >= 0,
          );
          console.log(
            `PR-6c locking DDL measurement rows=${String(pr6cMeasurementRows)} writer_block_ms=${blockingWindowMilliseconds.toFixed(3)}`,
          );
        } catch (error) {
          await blocker.query('ROLLBACK').catch(() => undefined);
          await writer.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          blocker.release();
          writer.release();
        }

        await assertManagedColumnPresence(
          pool,
          parent.physicalTableName,
          foldedColumn.physicalName,
          true,
        );
        await assertIndexPresence(pool, foldedIndex.physicalName, true);
        const generatedValues = await pool.query<{
          mismatches: string;
          observed: string;
        }>(
          `SELECT count(*)::text AS observed,
                  count(*) FILTER (
                    WHERE ${quoteTestIdentifier(foldedColumn.physicalName)}
                      IS DISTINCT FROM
                      north_star_module.nsm_unicode_case_fold_v1(
                        ${quoteTestIdentifier(notesColumn.physicalName)}::text
                      )
                  )::text AS mismatches
             FROM north_star_module.${quoteTestIdentifier(parent.physicalTableName)}
            WHERE tenant_id = $1 AND environment_id = $2`,
          [tenantA, environmentA],
        );
        assert.deepEqual(generatedValues.rows[0], {
          mismatches: '0',
          observed: String(pr6cMeasurementRows),
        });
        await pool.query(
          `ANALYZE north_star_module.${quoteTestIdentifier(parent.physicalTableName)}`,
        );
        if (demonstrateMissingSearchOnlyIndex === 'search-only') {
          await pool.query(
            `DROP INDEX north_star_module.${quoteTestIdentifier(foldedIndex.physicalName)}`,
          );
          await pool.query(
            `ANALYZE north_star_module.${quoteTestIdentifier(parent.physicalTableName)}`,
          );
        }
        await assertSearchOnlyPrefixIndexExecution({
          context: contexts.a,
          entity: parent,
          expectedIndexName: foldedIndex.physicalName,
          pool,
          runtimePool,
          searchColumns: [nameColumn, notesColumn],
          text: `Measured notes ${String(Math.min(7_000, pr6cMeasurementRows))}`,
        });
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

function inventoryOwnedModuleDefinition(): Record<string, unknown> {
  const application = composedApplicationDefinition();
  const inventory = inventoryModuleDefinition(APPLICATION_NAMESPACE);
  for (const collection of [
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
  ] as const) {
    const target = application[collection];
    const source = inventory[collection];
    assert.ok(Array.isArray(target));
    assert.ok(Array.isArray(source));
    assertComposedInventoryCollection(
      collection,
      target,
      source,
      APPLICATION_NAMESPACE,
    );
  }
  const modules = application.modules;
  const inventoryModules = inventory.modules;
  assert.ok(Array.isArray(modules));
  assert.ok(Array.isArray(inventoryModules));
  const inventoryModule = inventoryModules[0];
  assert.ok(inventoryModule && typeof inventoryModule === 'object');
  assert.ok('moduleId' in inventoryModule);
  assert.equal(
    modules.filter(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        'moduleId' in candidate &&
        candidate.moduleId === inventoryModule.moduleId,
    ).length,
    1,
    'composed application must contain the inventory module exactly once',
  );
  return application;
}

/**
 * Removes one module's declared entries from a composed application, asserting
 * each is removed EXACTLY ONCE so a silently-absent module cannot masquerade as
 * a removed one.
 */
function withoutModuleForTransition(
  application: Record<string, unknown>,
  module: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  for (const collection of [
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
  ] as const) {
    const target = application[collection];
    const source = module[collection];
    assert.ok(Array.isArray(target));
    assert.ok(Array.isArray(source));
    const idKey = {
      assertions: 'assertionId',
      entities: 'entityId',
      fields: 'fieldId',
      operations: 'operationId',
      permissions: 'permissionId',
      queries: 'queryId',
      relations: 'relationId',
      stateMachines: 'machineId',
      storageMappings: 'storageMappingId',
      surfaces: 'surfaceId',
    }[collection];
    const ids = new Set(source.map((entry) => entry[idKey]));
    for (const id of ids)
      assert.equal(
        target.filter((candidate) => candidate[idKey] === id).length,
        1,
        `transition fixture must identify each ${label} ${collection} entry exactly once`,
      );
    // Composition may change presentation/query bodies and add module-owned dependencies.
    // Remove by canonical identity and declared module ownership, never byte equality.
    application[collection] = target.filter(
      (candidate) =>
        !ids.has(candidate[idKey]) &&
        candidate.module?.targetId !==
          `${APPLICATION_NAMESPACE}:module.${label}`,
    );
  }
  const modules = application.modules;
  const sourceModules = module.modules;
  assert.ok(Array.isArray(modules));
  assert.ok(Array.isArray(sourceModules));
  const sourceModule = sourceModules[0];
  assert.ok(sourceModule && typeof sourceModule === 'object');
  assert.ok('moduleId' in sourceModule);
  application.modules = modules.filter(
    (candidate) =>
      candidate === null ||
      typeof candidate !== 'object' ||
      !('moduleId' in candidate) ||
      candidate.moduleId !== sourceModule.moduleId,
  );
  assert.equal(
    modules.length - (application.modules as unknown[]).length,
    1,
    `transition fixture must remove the ${label} module exactly once`,
  );
  if (label === 'sales') {
    const delivery = `${APPLICATION_NAMESPACE}:entity.drop_ship_delivery`;
    const targetsDelivery = (value: unknown) =>
      value !== null &&
      typeof value === 'object' &&
      (value as { targetId?: unknown }).targetId === delivery;
    const belongsToDelivery = (entry: Record<string, unknown>) =>
      entry.entityId === delivery ||
      targetsDelivery(entry.entity) ||
      targetsDelivery(entry.sourceEntity) ||
      targetsDelivery(entry.resource) ||
      String(entry.operationId ?? entry.surfaceId ?? '').includes(
        ':operation.drop_ship_delivery_',
      ) ||
      String(entry.surfaceId ?? '').includes(':surface.drop_ship_delivery_');
    for (const collection of [
      'entities',
      'fields',
      'queries',
      'permissions',
      'operations',
      'surfaces',
      'stateMachines',
      'storageMappings',
    ])
      application[collection] = (
        application[collection] as Record<string, unknown>[]
      ).filter((entry) => !belongsToDelivery(entry));
  }
  const entities = new Set(
    (application.entities as { entityId: string }[]).map(
      (entry) => entry.entityId,
    ),
  );
  application.relations = (
    application.relations as {
      sourceEntity: { targetId: string };
      targetEntity: { targetId: string };
    }[]
  ).filter(
    (entry) =>
      entities.has(entry.sourceEntity.targetId) &&
      entities.has(entry.targetEntity.targetId),
  );
  const queries = application.queries as {
    queryId: string;
    readModel?: { queries: Record<string, { targetId: string }> };
  }[];
  const queryIds = new Set(queries.map((entry) => entry.queryId));
  for (const query of queries)
    if (
      query.readModel &&
      Object.values(query.readModel.queries).some(
        (entry) => !queryIds.has(entry.targetId),
      )
    )
      delete query.readModel;
  // These predecessors judge storage installation, not cross-module page grammar.
  for (const surface of application.surfaces as Record<string, unknown>[]) {
    delete surface.composition;
    delete surface.list;
  }
  return application;
}

/**
 * The composed application with neither Inventory nor a module whose retained
 * families require Inventory's legal-entity master.
 *
 * Purchasing and Sales are stripped too, and the reason is structural rather
 * than cosmetic: their families are `entityOwned`, and `createManagedTable`
 * requires exactly one compiled legal-entity master for any entity-owned table
 * -- but `legal_entity` is declared by the Inventory module. A composition
 * retaining either dependent module without Inventory therefore fails closed
 * with `LEGAL_ENTITY_MASTER_TARGET_INVALID: expected one compiled legal-entity
 * master, received 0`, which is the gate working.
 */
function composedApplicationWithoutInventoryForTransition(): Record<
  string,
  unknown
> {
  const application = withoutModuleForTransition(
    withoutModuleForTransition(
      structuredClone(inventoryOwnedModuleDefinition()),
      // As the product application composes it, commercial terms and
      // payables included, so none of its purchase order fields or bill
      // documents outlives the removal.
      purchasingModuleDefinition(APPLICATION_NAMESPACE, {
        commercialTerms: true,
        payables: true,
      }),
      'purchasing',
    ),
    salesModuleDefinition(APPLICATION_NAMESPACE),
    'sales',
  );
  return withoutModuleForTransition(
    application,
    inventoryModuleDefinition(APPLICATION_NAMESPACE),
    'inventory',
  );
}

function collectPlanRelationNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectPlanRelationNames);
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record['Relation Name'] === 'string'
      ? [record['Relation Name']]
      : []),
    ...Object.values(record).flatMap(collectPlanRelationNames),
  ];
}

function hasPostgresErrorCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    (error as Error & { code?: string }).code === code;
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
    profile: profileForNormalizedBytes(definitionBytes(definition)),
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

function withConflictingAbiFunctionCheck(
  compiled: CompileSuccess,
): CompileSuccess {
  const clone = structuredClone(compiled);
  const storage = projectionPayload<StorageTargetPayloadV1>(
    clone,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const item = storage.entities.find((entity) =>
    entity.entityId.endsWith(':entity.item'),
  );
  const check = item?.abiFunctionChecks?.[0];
  assert.ok(check);
  check.movementRecordIdColumn = check.movementItemIdColumn;
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
    (element) => element.classification.preparationValidity === 'inAttemptOnly',
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

function withoutFoldedColumn(
  compiled: CompileSuccess,
  canonicalFieldId: string,
): CompileSuccess {
  const clone = structuredClone(compiled);
  const storage = projectionPayload<StorageTargetPayloadV1>(
    clone,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const removedPhysicalNames = new Set<string>();
  for (const entity of storage.entities) {
    const removedColumns = entity.foldedColumns.filter(
      (column) => column.canonicalFieldId === canonicalFieldId,
    );
    for (const column of removedColumns) {
      removedPhysicalNames.add(column.physicalName);
      for (const index of entity.indexes.filter((candidate) =>
        candidate.columnNames.includes(column.physicalName),
      )) {
        removedPhysicalNames.add(index.physicalName);
      }
    }
    entity.foldedColumns = entity.foldedColumns.filter(
      (column) => column.canonicalFieldId !== canonicalFieldId,
    );
    entity.indexes = entity.indexes.filter(
      (index) => !removedPhysicalNames.has(index.physicalName),
    );
  }
  assert.ok(
    removedPhysicalNames.size > 0,
    `compiled storage has no folded column for ${canonicalFieldId}`,
  );
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

interface SearchOnlyPlanNode {
  readonly 'Index Name'?: unknown;
  readonly 'Node Type'?: unknown;
  readonly Plans?: unknown;
  readonly 'Rows Removed by Filter'?: unknown;
}

async function assertSearchOnlyPrefixIndexExecution(input: {
  context: TrustedRequestContext;
  entity: StorageTargetPayloadV1['entities'][number];
  expectedIndexName: string;
  pool: pg.Pool;
  runtimePool: pg.Pool;
  searchColumns: readonly StorageTargetPayloadV1['entities'][number]['columns'][number][];
  text: string;
}): Promise<void> {
  const before = await readIndexScanCount(input.pool, input.expectedIndexName);
  const match = buildFoldedMatchPredicate(
    input.entity,
    input.searchColumns,
    input.text,
    'prefix',
  );
  const values = [...match.values, 100];
  const selectedColumns = [
    input.entity.recordIdentity.column,
    input.entity.optimisticRevision.column,
    input.entity.archive.archivedAtColumn,
    ...input.entity.columns.map((column) => column.physicalName),
  ];
  const root = await withTrustedRequestTransaction(
    input.runtimePool,
    input.context,
    async (client) => {
      await client.query('SET LOCAL ROLE north_star_module_runtime');
      try {
        const explained = await client.query<{ 'QUERY PLAN': unknown }>(
          `EXPLAIN (ANALYZE, FORMAT JSON)
           SELECT ${selectedColumns.map(quoteTestIdentifier).join(', ')}
             FROM north_star_module.${quoteTestIdentifier(input.entity.physicalTableName)}
            WHERE ${quoteTestIdentifier(input.entity.archive.archivedAtColumn)} IS NULL
              AND ${match.sql}
            ORDER BY ${quoteTestIdentifier(input.entity.recordIdentity.column)}
            LIMIT $${String(values.length)}`,
          values,
        );
        await client.query('SELECT pg_stat_force_next_flush()');
        const envelope = explained.rows[0]?.['QUERY PLAN'];
        assert.ok(Array.isArray(envelope) && envelope.length === 1);
        const entry = envelope[0];
        assert.ok(
          isSearchOnlyPlanRecord(entry) && isSearchOnlyPlanRecord(entry.Plan),
        );
        return entry.Plan as SearchOnlyPlanNode;
      } finally {
        await client.query('RESET ROLE');
      }
    },
  );
  const after = await readIndexScanCount(input.pool, input.expectedIndexName);
  const scanDelta = before === null || after === null ? null : after - before;
  const rowsRemovedByFilter = totalRowsRemovedByFilter(root);
  assert.equal(
    rowsRemovedByFilter,
    0,
    `search-only prefix predicate removed ${String(rowsRemovedByFilter)} rows by post-filter while expecting index ${input.expectedIndexName}`,
  );
  assert.ok(
    scanDelta !== null && scanDelta >= 1n,
    `search-only prefix predicate did not increment expected index usage counter ${input.expectedIndexName}; delta ${String(scanDelta ?? 'missing')}`,
  );
  console.log(
    `PR-6d search-only prefix index=${input.expectedIndexName} idx_scan_delta=${String(scanDelta)} rows_removed_by_filter=${String(rowsRemovedByFilter)}`,
  );
}

async function readIndexScanCount(
  pool: pg.Pool,
  indexName: string,
): Promise<bigint | null> {
  const result = await pool.query<{ scan_count: string }>(
    `SELECT idx_scan::text AS scan_count
       FROM pg_stat_user_indexes
      WHERE schemaname = 'north_star_module'
        AND indexrelname = $1`,
    [indexName],
  );
  return result.rows[0] ? BigInt(result.rows[0].scan_count) : null;
}

function totalRowsRemovedByFilter(root: SearchOnlyPlanNode): number {
  let total = 0;
  const visit = (node: SearchOnlyPlanNode): void => {
    const rowsRemoved = node['Rows Removed by Filter'];
    assert.ok(
      rowsRemoved === undefined ||
        (typeof rowsRemoved === 'number' &&
          Number.isFinite(rowsRemoved) &&
          rowsRemoved >= 0),
      `unrecognized EXPLAIN rows removed by filter: ${String(rowsRemoved)}`,
    );
    total += rowsRemoved ?? 0;
    if (node.Plans === undefined) return;
    assert.ok(
      Array.isArray(node.Plans) && node.Plans.every(isSearchOnlyPlanRecord),
      'unrecognized EXPLAIN child plan collection',
    );
    for (const child of node.Plans) visit(child as SearchOnlyPlanNode);
  };
  visit(root);
  return total;
}

function isSearchOnlyPlanRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function waitForTableLock(
  pool: pg.Pool,
  applicationName: string,
  tableName: string,
  mode: string,
  granted: boolean,
): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < 15_000) {
    const result = await pool.query<{ observed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_locks AS lock_record
           JOIN pg_stat_activity AS activity
             ON activity.pid = lock_record.pid
           JOIN pg_class AS relation
             ON relation.oid = lock_record.relation
           JOIN pg_namespace AS namespace
             ON namespace.oid = relation.relnamespace
          WHERE activity.application_name = $1
            AND namespace.nspname = 'north_star_module'
            AND relation.relname = $2
            AND lock_record.mode = $3
            AND lock_record.granted = $4
       ) AS observed`,
      [applicationName, tableName, mode, granted],
    );
    if (result.rows[0]?.observed) return;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(
    `did not observe ${applicationName} ${granted ? 'holding' : 'waiting for'} ${mode} on ${tableName}`,
  );
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

/**
 * `setActiveReleasePointer` is hard-wired to tenant A. The relaxation test needs
 * tenant B moved too, to present the merge with the reverse root pairing.
 */
async function setActiveReleasePointerFor(
  pool: pg.Pool,
  tenantId: string,
  releaseId: MintedUuid,
): Promise<void> {
  await pool.query(
    'ALTER TABLE platform.active_release_pointers DISABLE TRIGGER active_release_pointer_exact_swap',
  );
  try {
    await pool.query(
      `UPDATE platform.active_release_pointers
          SET release_id = $2
        WHERE tenant_id = $1`,
      [tenantId, releaseId],
    );
  } finally {
    await pool.query(
      'ALTER TABLE platform.active_release_pointers ENABLE TRIGGER active_release_pointer_exact_swap',
    );
  }
}

/**
 * A second `child -> parent` reference relation whose requiredness the
 * relaxation test moves. It is a distinct relation from the fixture's own
 * `master_role_parent` so that widening it leaves every other relation in the
 * module byte-identical, which is what makes the resulting transition envelope
 * a single element.
 */
function widenableRelation(required: boolean): Record<string, unknown> {
  return {
    archiveBehavior: 'retainReference',
    cardinality: 'manyToOne',
    foreignKeyActions: {
      onDelete: 'restrict',
      onUpdate: 'restrict',
      schemaVersion: FIXTURE_LANGUAGE_VERSION,
    },
    joinEligibility: 'query',
    kind: 'relationDefinition',
    orderKey: 20,
    ownership: 'reference',
    relationId: `${FIXTURE_IDS.namespace}:relation.master_role_widenable`,
    required,
    schemaVersion: FIXTURE_LANGUAGE_VERSION,
    sourceEntity: {
      kind: 'entityReference',
      schemaVersion: FIXTURE_LANGUAGE_VERSION,
      targetId: FIXTURE_IDS.entityIds.child,
    },
    targetEntity: {
      kind: 'entityReference',
      schemaVersion: FIXTURE_LANGUAGE_VERSION,
      targetId: FIXTURE_IDS.entityIds.parent,
    },
  };
}

const ENUM_WIDEN_OPTION_ID = `${FIXTURE_IDS.namespace}:option.basic`;

/**
 * `ordinaryModuleV2` with its `master_tier` enumeration varied by exactly one
 * property per variant. The new option is declared FIRST, deliberately: the
 * candidate-verification witness is the first DECLARED option, so `widened`
 * is the case where verification writes the new option itself.
 */
function tierModule(
  variant:
    | 'narrowed'
    | 'rebound'
    | 'relabelled'
    | 'widened'
    | 'widenedAndRelabelled'
    | 'widenedAndReordered'
    | 'widenedAndRetype'
    | 'widenedAndSearchable'
    | 'widenedPlusColumn',
): Record<string, unknown> {
  const definition = ordinaryModuleV2() as {
    fields: Array<{
      fieldId: string;
      fieldType: {
        maximumLength?: number;
        options?: Array<{
          label?: string;
          optionId?: string;
          orderKey?: number;
        }>;
      };
      searchable?: boolean;
    }>;
  };
  const tier = definition.fields.find(
    (field) => field.fieldId === FIXTURE_IDS.fieldIds.parentTier,
  );
  assert.ok(tier?.fieldType.options);
  const options = tier.fieldType.options;
  const basic = {
    kind: 'enumOption',
    label: 'Basic',
    optionId: ENUM_WIDEN_OPTION_ID,
    orderKey: 5,
    schemaVersion: FIXTURE_LANGUAGE_VERSION,
  };
  switch (variant) {
    case 'widened':
      options.unshift(basic);
      break;
    case 'narrowed':
      options.pop();
      break;
    case 'rebound':
      options[1]!.optionId = `${FIXTURE_IDS.namespace}:option.vendor`;
      break;
    case 'relabelled':
      options[1]!.label = 'Premium plus';
      break;
    case 'widenedAndRelabelled':
      // Round-1 finding: labels live only inside the column fingerprint, so a
      // predicate that excludes the fingerprint let this through.
      options[1]!.label = 'Premium plus';
      options.unshift(basic);
      break;
    case 'widenedAndReordered':
      options[1]!.orderKey = 30;
      options.unshift(basic);
      break;
    case 'widenedAndSearchable':
      options.unshift(basic);
      tier.searchable = true;
      break;
    case 'widenedAndRetype': {
      options.unshift(basic);
      const name = definition.fields.find(
        (field) => field.fieldId === FIXTURE_IDS.fieldIds.parentName,
      );
      assert.ok(name?.fieldType.maximumLength);
      name.fieldType.maximumLength += 1;
      break;
    }
    case 'widenedPlusColumn':
      options.unshift(basic);
      definition.fields.push({
        classification: 'internal',
        collation: 'binary',
        defaultSemantics: 'nullable',
        entity: {
          kind: 'entityReference',
          schemaVersion: FIXTURE_LANGUAGE_VERSION,
          targetId: FIXTURE_IDS.entityIds.parent,
        },
        fieldId: `${FIXTURE_IDS.namespace}:field.master_memo`,
        fieldType: {
          kind: 'textFieldType',
          maximumLength: 120,
          schemaVersion: FIXTURE_LANGUAGE_VERSION,
        },
        kind: 'fieldDefinition',
        label: 'Memo',
        orderKey: 35,
        presence: 'optional',
        reportable: true,
        schemaVersion: FIXTURE_LANGUAGE_VERSION,
        searchable: false,
      } as never);
      break;
  }
  return definition;
}

/** The compiled release with its `widenEnumDomain` element removed and every
 *  root recomputed, so the artifact verifies while the plan installs nothing. */
function withoutWidenEnumDomainElement(
  compiled: CompileSuccess,
): CompileSuccess {
  const clone = structuredClone(compiled);
  const transition = projectionPayload<StorageTransitionEnvelope>(
    clone,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  const before = transition.elements.length;
  transition.elements = transition.elements.filter(
    (element) => element.kind !== 'widenEnumDomain',
  );
  assert.equal(transition.elements.length, before - 1);
  assert.ok(transition.elements.length > 0);
  rewriteProjectionPayload(
    clone,
    PROJECTION_FAMILY_IDS.storageTransition,
    transition,
  );
  rebuildReleaseRoot(clone);
  return clone;
}

/** The compiled release with ONE option of the widened set swapped for an
 *  option no release declares, in both the CHECK and the column contract, with
 *  every root recomputed -- a target the compiler cannot emit. */
function withDivergentEnumDomain(compiled: CompileSuccess): CompileSuccess {
  const clone = structuredClone(compiled);
  const storage = projectionPayload<StorageTargetPayloadV1>(
    clone,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const parent = storage.entities.find(
    (entity) => entity.entityId === FIXTURE_IDS.entityIds.parent,
  );
  assert.ok(parent);
  const check = parent.checkConstraints.find(
    (candidate) =>
      candidate.canonicalFieldId === FIXTURE_IDS.fieldIds.parentTier,
  );
  const column = parent.columns.find(
    (candidate) =>
      candidate.canonicalFieldId === FIXTURE_IDS.fieldIds.parentTier,
  );
  assert.ok(check);
  assert.ok(column);
  const divergent = check.enumOptionIds
    .map((optionId) =>
      optionId === FIXTURE_IDS.optionIds.standard
        ? `${FIXTURE_IDS.namespace}:option.vendor`
        : optionId,
    )
    .toSorted();
  check.enumOptionIds = divergent;
  column.fieldContract.enumOptionIds = divergent;
  rewriteProjectionPayload(clone, PROJECTION_FAMILY_IDS.storageTarget, storage);
  const storageReference = clone.bundle.releaseManifest.projections.find(
    (reference) => reference.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.ok(storageReference);
  const transition = projectionPayload<StorageTransitionEnvelope>(
    clone,
    PROJECTION_FAMILY_IDS.storageTransition,
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

async function readEnumDomainCheck(
  pool: pg.Pool,
  tableName: string,
  constraintName: string,
): Promise<{ oid: string; optionIds: string[]; validated: boolean } | null> {
  const result = await pool.query<{
    definition: string;
    oid: string;
    validated: boolean;
  }>(
    `SELECT constraint_record.oid::text AS oid,
            pg_get_expr(constraint_record.conbin, constraint_record.conrelid, true) AS definition,
            constraint_record.convalidated AS validated
       FROM pg_constraint AS constraint_record
       JOIN pg_class AS relation_record ON relation_record.oid = constraint_record.conrelid
       JOIN pg_namespace AS namespace_record ON namespace_record.oid = relation_record.relnamespace
      WHERE namespace_record.nspname = 'north_star_module'
        AND relation_record.relname = $1
        AND constraint_record.conname = $2`,
    [tableName, constraintName],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    oid: row.oid,
    optionIds: [...row.definition.matchAll(/'((?:[^']|'')*)'::text/gu)].map(
      (match) => match[1]!.replaceAll("''", "'"),
    ),
    validated: row.validated,
  };
}

/** A direct INSERT into a managed business table, every required column
 *  supplied, with the named columns overridden. Returns the record id. */
async function insertModuleRecord(
  client: pg.PoolClient,
  context: TrustedRequestContext,
  target: StorageTargetPayloadV1,
  entityId: string,
  overrides: Readonly<Record<string, string>>,
): Promise<string> {
  const entity = target.entities.find(
    (candidate) => candidate.entityId === entityId,
  );
  assert.ok(entity);
  await client.query(
    `SELECT set_config('north_star.tenant_id', $1, true),
            set_config('north_star.environment_id', $2, true)`,
    [context.tenantId, context.environmentId],
  );
  const recordId = randomUUID();
  const columns = ['tenant_id', 'environment_id', entity.recordIdentity.column];
  const values: unknown[] = [context.tenantId, context.environmentId, recordId];
  for (const column of entity.columns) {
    const override = overrides[column.physicalName];
    if (
      override === undefined &&
      (column.nullable || column.defaultSemantics !== 'none')
    ) {
      continue;
    }
    columns.push(column.physicalName);
    values.push(
      override ??
        (column.postgresqlType === 'uuid'
          ? randomUUID()
          : column.postgresqlType === 'boolean'
            ? false
            : /^(?:bigint|numeric)/.test(column.postgresqlType)
              ? '1'
              : `record-${recordId.slice(0, 8)}`),
    );
  }
  for (const relation of target.relations) {
    if (
      relation.sourceEntityId !== entityId ||
      relation.relationColumn.nullable ||
      relation.relationColumn.origin === 'field'
    ) {
      continue;
    }
    const override = overrides[relation.relationColumn.physicalName];
    assert.ok(
      override !== undefined,
      `relation ${relation.relationId} needs a target`,
    );
    columns.push(relation.relationColumn.physicalName);
    values.push(override);
  }
  await client.query(
    `INSERT INTO north_star_module.${quoteTestIdentifier(entity.physicalTableName)}
         (${columns.map(quoteTestIdentifier).join(', ')})
       VALUES (${values.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    values,
  );
  return recordId;
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
    await repository.storeAppPackageRevision(
      context,
      revisionCommand(context, sourceRevision, sourceBytes),
    );
    await repository.storeAppPackageRevision(
      context,
      revisionCommand(context, targetRevision, targetBytes),
    );
    const stagedSource = await repository.stageTenantReleaseCandidate(context, {
      appPackageRevisionId: sourceRevision,
      compiledRelease: source,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId: sourceRelease,
      tenantId: context.tenantId,
    });
    await new PostgresReleaseVerificationService(
      runtimePool,
    ).executeSemanticCandidateAndPersist(context, {
      compiledRelease: source,
      evidenceId: stagedSource.verificationEvidenceId,
      releaseId: sourceRelease,
    });
    await repository.registerTenantRelease(
      context,
      releaseCommand(
        context,
        sourceRelease,
        sourceRevision,
        stagedSource.verificationEvidenceId,
        source,
      ),
    );
    const stagedTarget = await repository.stageTenantReleaseCandidate(context, {
      appPackageRevisionId: targetRevision,
      compiledRelease: target,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId: targetRelease,
      tenantId: context.tenantId,
    });
    return {
      compiled: target,
      revisionId: targetRevision,
      source: sourceRelease,
      target: targetRelease,
      targetEvidence: stagedTarget.verificationEvidenceId,
    };
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
  await repository.storeAppPackageRevision(
    context,
    revisionCommand(context, revision, bytes),
  );
  const staged = await repository.stageTenantReleaseCandidate(context, {
    appPackageRevisionId: revision,
    compiledRelease: compiled,
    createdBy: context.principalId,
    environmentId: context.environmentId,
    releaseId: target,
    tenantId: context.tenantId,
  });
  return {
    compiled,
    revisionId: revision,
    source: sourceRelease,
    target,
    targetEvidence: staged.verificationEvidenceId,
  };
}

interface ReleasePair {
  compiled: CompileSuccess;
  revisionId: MintedUuid;
  source: MintedUuid;
  target: MintedUuid;
  targetEvidence: MintedUuid;
}

function revisionCommand(
  context: TrustedRequestContext,
  revisionId: MintedUuid,
  desiredState: Uint8Array,
): StoreAppPackageRevisionCommand {
  const normalizedDefinition =
    parseNormalizedApplicationPackageJson(desiredState);
  const digest = canonicalizeAndHash(normalizedDefinition);
  return {
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    contentHash: digest.contentHash,
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
  assert.equal(target.releaseRoot, releases.compiled.releaseRoot);
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

async function admitPreparedTarget(
  runtimePool: pg.Pool,
  context: TrustedRequestContext,
  release: ReleasePair,
): Promise<void> {
  const repository = new PostgresImmutableReleaseRepository(runtimePool);
  if (await repository.getTenantRelease(context, release.target)) return;
  await new PostgresReleaseVerificationService(
    runtimePool,
  ).executeSemanticCandidateAndPersist(context, {
    compiledRelease: release.compiled,
    evidenceId: release.targetEvidence,
    releaseId: release.target,
  });
  await repository.registerTenantRelease(
    context,
    releaseCommand(
      context,
      release.target,
      release.revisionId,
      release.targetEvidence,
      release.compiled,
    ),
  );
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
  expectedBackfillRows: number;
  recordIds: string[];
  tableName: string;
}

interface UnicodeCaseFoldFunctionCatalogState {
  readonly catalogVersion: string;
  readonly definition: string;
  readonly source: string;
}

async function readUnicodeCaseFoldFunction(
  pool: pg.Pool,
): Promise<UnicodeCaseFoldFunctionCatalogState | null> {
  const result = await pool.query<{
    catalog_version: string;
    definition: string;
    source: string;
  }>(
    `SELECT routine.xmin::text AS catalog_version,
            pg_get_functiondef(routine.oid) AS definition,
            routine.prosrc AS source
       FROM pg_proc AS routine
       JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'north_star_module'
        AND routine.proname = 'nsm_unicode_case_fold_v1'
        AND pg_get_function_identity_arguments(routine.oid) = 'value text'`,
  );
  assert.ok(
    result.rows.length <= 1,
    'versioned fold function identity must be unique',
  );
  const row = result.rows[0];
  return row
    ? {
        catalogVersion: row.catalog_version,
        definition: row.definition,
        source: row.source,
      }
    : null;
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
  const existing = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM north_star_module.${quoteTestIdentifier(located.table_name)}
      WHERE ${quoteTestIdentifier(located.column_name)} IS NULL`,
  );
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
    expectedBackfillRows: Number(existing.rows[0]?.count ?? '0') + count,
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
    completed: String(planted.recordIds.length),
    total: String(planted.recordIds.length),
  });
}

async function assertBackfillCheckpointRoleIsolation(
  materializerPool: pg.Pool,
  moduleRuntimePool: pg.Pool,
  ownerContext: TrustedRequestContext,
  otherContext: TrustedRequestContext,
  generationId: string,
): Promise<void> {
  const sameTenantOtherEnvironmentContext = Object.freeze({
    ...ownerContext,
    environmentId: otherContext.environmentId,
  });
  for (const rolePool of [materializerPool, moduleRuntimePool]) {
    const visible = await withInternalRoleScope(
      rolePool,
      ownerContext,
      (client) =>
        client.query<{
          activation_attempt_id: string;
          element_id: string;
          rows_applied: string;
        }>(
          `SELECT activation_attempt_id::text AS activation_attempt_id,
                  element_id, rows_applied::text AS rows_applied
             FROM north_star_internal.module_storage_backfill_checkpoints
            WHERE generation_id = $1`,
          [generationId],
        ),
    );
    assert.deepEqual(
      visible.rows,
      [
        {
          activation_attempt_id: visible.rows[0]?.activation_attempt_id,
          element_id: visible.rows[0]?.element_id,
          rows_applied: '100',
        },
      ],
      'the non-admin internal role must retain legitimate checkpoint access',
    );
    assert.ok(visible.rows[0]?.activation_attempt_id);
    assert.ok(visible.rows[0]?.element_id);

    const hidden = await withInternalRoleScope(
      rolePool,
      otherContext,
      (client) =>
        client.query(
          `UPDATE north_star_internal.module_storage_backfill_checkpoints
              SET rows_applied = rows_applied + 1
            WHERE generation_id = $1
          RETURNING generation_id`,
          [generationId],
        ),
    );
    assert.equal(
      hidden.rowCount,
      0,
      'another tenant cannot discover or mutate the checkpoint through an actual internal role',
    );

    const otherEnvironmentHidden = await withInternalRoleScope(
      rolePool,
      sameTenantOtherEnvironmentContext,
      (client) =>
        client.query(
          `UPDATE north_star_internal.module_storage_backfill_checkpoints
              SET rows_applied = rows_applied + 1
            WHERE generation_id = $1
          RETURNING generation_id`,
          [generationId],
        ),
    );
    assert.equal(
      otherEnvironmentHidden.rowCount,
      0,
      'another environment in the same tenant cannot discover or mutate the checkpoint',
    );

    await assert.rejects(
      withInternalRoleScope(rolePool, ownerContext, (client) =>
        client.query(
          `UPDATE north_star_internal.module_storage_backfill_checkpoints
              SET environment_id = $2
            WHERE generation_id = $1`,
          [generationId, otherContext.environmentId],
        ),
      ),
      (error: unknown) => (error as Error & { code?: string }).code === '42501',
      'a visible checkpoint cannot be rewritten into a foreign scope',
    );

    await assert.rejects(
      withInternalRoleScope(rolePool, otherContext, (client) =>
        client.query(
          `INSERT INTO north_star_internal.module_storage_backfill_checkpoints (
             tenant_id, environment_id, generation_id, element_id,
             activation_attempt_id, rows_applied, complete
           ) VALUES ($1, $2, $3, $4, $5, 0, false)`,
          [
            ownerContext.tenantId,
            ownerContext.environmentId,
            randomUUID(),
            visible.rows[0]!.element_id,
            visible.rows[0]!.activation_attempt_id,
          ],
        ),
      ),
      (error: unknown) => (error as Error & { code?: string }).code === '42501',
      'a foreign-scoped checkpoint insert is rejected by the actual internal role',
    );
  }
}

async function withInternalRoleScope<T>(
  pool: pg.Pool,
  context: TrustedRequestContext,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('north_star.tenant_id', $1, true),
              set_config('north_star.environment_id', $2, true),
              set_config('north_star.principal_id', $3, true)`,
      [context.tenantId, context.environmentId, context.principalId],
    );
    const result = await work(client);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
