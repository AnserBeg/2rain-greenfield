import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import pg from 'pg';
import type { Pool, PoolClient, PoolConfig } from 'pg';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  canonicalize,
  canonicalizeAndHash,
  normalizeApplicationPackage,
  parseNormalizedApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  expectedActiveReleaseFrom,
  type CompileSuccess,
  type CompilerInput,
  type StorageTargetPayloadV1,
} from '../../packages/compiler/src/index.js';
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import {
  INVENTORY_CONTRACT_V1,
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT as DECLARED_POSTING_DEPENDENCY_SET_ROOT,
} from '../../packages/domain/src/inventory/contracts.js';
import {
  INVENTORY_POSTING_CAPABILITY_VERSION,
  INVENTORY_POSTING_CAPABILITY_ID,
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  InventoryPostingError,
  compareInventoryMovementOrderEntries,
  planInventoryPostingRequestLock,
  PostgresInventoryPostingService,
  translateInventoryPostingError,
  type InventoryAdjustmentLineV1,
  type InventoryAdjustmentPostingCommandV1,
  type InventoryMovementOrderEntryV1,
  type InventoryPostingResultV1,
  type InventoryPostingRegistrationV1,
  type InventoryTransferLineV1,
  type InventoryTransferPostingCommandV1,
} from '../../packages/postgres-provider/src/inventory-posting-service.js';
import { COMMERCIAL_CAPABILITY_ID } from '../../packages/domain/src/sales/definition.js';
import { commercialReadModel } from '../../packages/postgres-provider/src/commercial-read-model.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import {
  planStockIdentityLocks,
  STOCK_IDENTITY_LOCK_NAMESPACE,
} from '../../packages/postgres-provider/src/stock-serializer.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import {
  aggregateGenerationLockKey,
  ModuleRuntimeInterpreterError,
  PostgresModuleRuntimeInterpreter,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { PostgresModuleStorageMaterializer } from '../../packages/postgres-provider/src/module-storage-materializer.js';
import {
  PostgresReleaseVerificationService,
  releaseVerificationBinding,
} from '../../packages/postgres-provider/src/release-verification-service.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { PostgresRequestRuntimeViewService } from '../../packages/postgres-provider/src/request-runtime-view-service.js';
import { TrustedActorEnvelopeIssuer } from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
} from '../../packages/runtime/src/request-runtime-view.js';
import { assertComposedInventoryCollection } from '../helpers/assert-composed-inventory.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';
import {
  amendOrderedQuantity,
  changePurchaseOrderState,
} from '../../packages/postgres-provider/src/purchasing-order-lifecycle.js';
import {
  compareReceivedQuantityRows,
  rebuildReceivedQuantitiesOnClient,
  reconcileReceivedQuantities,
} from '../../packages/postgres-provider/src/received-quantity-projection.js';
import { RECEIVING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receiving-capability-executor.js';
import { PAYABLES_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/payables-capability-executor.js';
import type { RegisteredCapabilityOperationExecutionRequest } from '../../packages/runtime/src/semantic-operation-gateway.js';
import { SemanticQueryGateway } from '../../packages/runtime/src/semantic-query-gateway.js';
import { PostgresInventoryReconciliationService } from '../../packages/postgres-provider/src/inventory-reconciliation-service.js';
import { renderSurfaceRuntimeWithData } from '../../apps/web/src/surface-runtime.js';
import {
  loadReceivingSection,
  RECEIVING_SURFACE_RUNTIME_EXTENSION,
} from '../../apps/web/src/receiving-section.js';
import {
  RECEIVING_CAPABILITY_ID,
  receiptBinding,
  receiptColumn,
  receiptOption,
  receiptRelation,
  receiptTable,
  receivedIdentity,
  type GoodsReceiptCommand,
} from '../../packages/postgres-provider/src/goods-receipt.js';

const migrations = resolve('db/migrations');
const applicationBuilderImport = '../../packages/domain/src/app/builder.js';
const inventoryModuleImport =
  '../../packages/domain/src/inventory/definition.js';
const tenantId = '11000000-0000-4000-8000-000000000001';
const environmentId = '22000000-0000-4000-8000-000000000002';
const legalReject = '33000000-0000-4000-8000-000000000001';
const legalFlag = '33000000-0000-4000-8000-000000000002';
const legalAllow = '33000000-0000-4000-8000-000000000003';
const legalApproval = '33000000-0000-4000-8000-000000000004';
const principalId = '77000000-0000-4000-8000-000000000007';
const approvingHumanId = '88000000-0000-4000-8000-000000000008';
const itemId = '44000000-0000-4000-8000-000000000004';
const sameInstantTieBreakItemId = '44000000-0000-4000-8000-000000000005';
const locationPrimary = '55000000-0000-4000-8000-000000000001';
const locationTie = '55000000-0000-4000-8000-000000000002';
const locationRace = '55000000-0000-4000-8000-000000000003';
const transferItemId = '46000000-0000-4000-8000-000000000006';
const orderDecisiveItemId = '47000000-0000-4000-8000-000000000007';
const transferLocationA = '56000000-0000-4000-8000-000000000006';
const transferLocationB = '57000000-0000-4000-8000-000000000007';
const firstInsertedTieBreakMovementId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
const laterInsertedTieBreakMovementId = '00000000-0000-4000-8000-000000000000';
const businessPeriod = '2026-07-29';
const recordedAt = '2026-07-29T13:00:00.000Z';
const effectiveAt = '2026-07-29T12:00:00.000Z';
const postingCapabilityId = INVENTORY_CONTRACT_V1.capabilityId;
const postingApplicationName = 'g3p3-inventory-posting';
const concurrencyControlLockTimeout = '3s';
const lineRaceLockNamespace = 0x47335033;
const lineRaceLockKey = 1;
const requestKeyRaceIdempotencyKey = '99000000-0000-4000-8000-000000000009';
const requestKeyRaceExpectedKey = -364_379_365;
const transferAtomicitySourceId = 'transfer-atomic-rollback';

type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];

interface PostingFixture {
  empty: CompileSuccess;
  emptyDefinition: Record<string, unknown>;
  inventory: CompileSuccess;
  inventoryDefinition: Record<string, unknown>;
  storage: StorageTargetPayloadV1;
  storageContentHash: string;
}

interface PostingDatabase {
  actor: Awaited<ReturnType<TrustedActorEnvelopeIssuer['issue']>>;
  adminPool: Pool;
  approvedActor: Awaited<ReturnType<TrustedActorEnvelopeIssuer['issue']>>;
  binding: TestStorageBinding;
  connection: PoolConfig;
  context: TrustedRequestContext;
  runtimePool: Pool;
  registration: InventoryPostingRegistrationV1;
  service: PostgresInventoryPostingService;
}

interface TestEntityBinding {
  archiveColumn: string;
  entity: StorageEntityTarget;
  fields: Map<string, StorageEntityTarget['columns'][number]>;
  legalEntityColumn: string | null;
  recordIdColumn: string;
  revisionColumn: string;
  tableName: string;
}

interface TestStorageBinding {
  companionMovementIdColumn: string;
  companionTableName: string;
  item: TestEntityBinding;
  legalEntity: TestEntityBinding;
  location: TestEntityBinding;
  movement: TestEntityBinding;
  periodLock: TestEntityBinding;
  periodLockClosedThroughColumn: string;
  schemaName: string;
  storageTarget: StorageTargetPayloadV1;
  transaction: TestEntityBinding;
  transactionLine: TestEntityBinding;
}

test('the global same-instant order reaches its movementId tie-break', () => {
  const shared = {
    effectiveAt,
    postingRole: 'transfer',
    recordedAt,
    sourceId: 'same-instant-movement-id-only',
    sourceLine: '1:out',
    sourceType: 'transfer',
  } as const;
  const laterId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  const earlierId = '00000000-0000-4000-8000-000000000000';
  const entries: InventoryMovementOrderEntryV1[] = [
    { ...shared, movementId: laterId },
    { ...shared, movementId: earlierId },
  ];
  assert.deepEqual(
    entries
      .toSorted(compareInventoryMovementOrderEntries)
      .map((entry) => entry.movementId),
    [earlierId, laterId],
    'removing the production comparator movementId branch must reverse this verdict',
  );
});

test('RECEIPT comparison preserves same record ids across legal-entity scope in either read order', () => {
  const recordId = '99000000-0000-4000-8000-000000000001';
  const orderLineId = '99000000-0000-4000-8000-000000000002';
  const expected = [
    {
      legalEntityId: legalReject,
      orderLineId,
      quantity: '3',
      recordId,
      unitId: 'EA',
    },
  ];
  const stored = [
    {
      environmentId,
      legalEntityId: legalReject,
      orderLineId,
      quantity: '3',
      raw: { legal_entity_id: legalReject, marker: 'A' },
      recordId,
      tenantId,
      unitId: 'EA',
    },
    {
      environmentId,
      legalEntityId: legalFlag,
      orderLineId,
      quantity: '999',
      raw: { legal_entity_id: legalFlag, marker: 'B' },
      recordId,
      tenantId,
      unitId: 'EA',
    },
  ];
  for (const rows of [stored, [...stored].reverse()]) {
    const discrepancies = compareReceivedQuantityRows(
      { environmentId, tenantId },
      expected,
      rows,
    );
    assert.deepEqual(
      discrepancies.map((entry) => [
        entry.subjectIdentity,
        entry.stored?.marker,
        entry.recomputed,
      ]),
      [[[tenantId, environmentId, legalFlag, recordId], 'B', null]],
      'same-id entity-B corruption remains visible in either input order',
    );
  }
});

test('posting error translation: a non-SQLSTATE code keeps its own error identity', () => {
  for (const code of [
    'ECONNREFUSED',
    'ERR_STREAM_DESTROYED',
    'PS0_RECEIPT_OPEN_QUANTITY_EXCEEDED',
  ]) {
    const failure = postingFailure(code);
    assert.equal(
      translateInventoryPostingError(failure),
      failure,
      `${code} must pass through untranslated: a non-SQLSTATE code is not a PostgreSQL rejection`,
    );
  }
});

test('posting error translation: a five-character non-SQLSTATE code keeps its own error identity', () => {
  // One property varied from the admitted twin '23503': the final character
  // leaves the [0-9A-Z] alphabet while the length stays five.
  const failure = postingFailure('2350x');
  assert.equal(
    translateInventoryPostingError(failure),
    failure,
    '2350x must pass through untranslated: five characters outside [0-9A-Z] are not a SQLSTATE',
  );
});

test('posting error translation: a SQLSTATE-shaped code is relabelled as a storage rejection', () => {
  const failure = postingFailure('23503');
  const translated = translateInventoryPostingError(failure);
  assert.ok(
    translated instanceof InventoryPostingError,
    'a real SQLSTATE must still be classified as a storage rejection',
  );
  assert.equal(translated.code, 'INVENTORY_POSTING_STORAGE_REJECTED');
  assert.equal(
    translated.message,
    'INVENTORY_POSTING_STORAGE_REJECTED: PostgreSQL rejected inventory posting (23503)',
  );
  assert.equal(translated.details.sqlstate, '23503');
});

test(
  'posting error replay: a genuine duplicate-key error reaches the 23505 replay branch',
  { timeout: 180_000 },
  async () => {
    await withPostingDatabase(async (database) => {
      const claim = command({
        legalEntityId: legalReject,
        locationId: locationPrimary,
        quantityDelta: '1',
        sourceId: 'raced-natural-claim',
      });
      await seedDraft(database, claim);
      const claimMovementId = randomUUID();
      let raced: Promise<InventoryPostingResultV1> | undefined;
      await withModuleRole(
        database.runtimePool,
        database.context,
        async (client) => {
          // Claim the natural effect identity on this still-open transaction.
          // The posting's pre-read cannot see the uncommitted claim, so it
          // proceeds to its own insert, where the companion primary key makes
          // it wait on this transaction — the only construction that lands a
          // committed claim between the pre-read and the insert, which is the
          // window the 23505 catch exists for.
          await insertNaturalClaimMovement(
            client,
            database,
            claim,
            claimMovementId,
          );
          raced = database.service.postAdjustment(
            database.context,
            database.actor,
            claim,
          );
          const outcome = await Promise.race([
            raced.then(
              () => 'settled-early' as const,
              () => 'settled-early' as const,
            ),
            observeClaimWaiter(database),
          ]);
          if (outcome === 'settled-early') {
            const early = await raced;
            assert.fail(
              `the posting settled without blocking on the uncommitted claim (replayed=${String(early.replayed)}); the raced window was not constructed`,
            );
          }
          assert.equal(
            outcome,
            'observed',
            'the posting never blocked on the uncommitted natural claim; the raced window was not constructed',
          );
        },
      );
      // The commit above releases the posting, whose companion insert now
      // raises a genuine 23505. A blocked-then-released posting has already
      // passed its pre-read, so only the catch branch can produce this typed
      // refusal; the raw claim carries no receipt, which is the branch's one
      // deterministically reachable outcome.
      assert.ok(raced, 'the posting was never started');
      await assert.rejects(raced, (error: unknown) => {
        assert.ok(
          error instanceof InventoryPostingError,
          `a genuine duplicate-key error must resolve through the 23505 replay branch, not surface raw: ${String(error)}`,
        );
        assert.equal(
          error.code,
          'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
          'a genuine 23505 must be resolved by the replay branch, not relabelled as a storage rejection',
        );
        assert.equal(
          error.message,
          'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT: existing natural effects have no accepted posting receipt',
        );
        return true;
      });
      assert.equal(await movementCount(database), 1);
    });
  },
);

function postingFailure(code: string): Error {
  return Object.assign(new Error('posting failed mid-flight'), { code });
}

async function observeClaimWaiter(
  database: PostingDatabase,
): Promise<'exhausted' | 'observed'> {
  // Attempt-bounded observation of the posting's wait on the uncommitted
  // claim: a unique-index conflict with an in-flight row parks the inserter
  // on the claimant's transaction id, which pg_locks reports as an ungranted
  // transactionid lock. The ephemeral database runs nothing else.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const waiting = await database.adminPool.query<{ waiting: string }>(
      `SELECT count(*)::text AS waiting
         FROM pg_locks
        WHERE locktype = 'transactionid' AND NOT granted`,
    );
    if (Number(waiting.rows[0]?.waiting ?? '0') > 0) return 'observed';
    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 25);
    });
  }
  return 'exhausted';
}

async function insertNaturalClaimMovement(
  client: PoolClient,
  database: PostingDatabase,
  input: InventoryAdjustmentPostingCommandV1,
  movementId: string,
): Promise<void> {
  assert.equal(input.lines.length, 1);
  const postingLine = input.lines[0]!;
  await insertEntity(
    client,
    database.binding,
    database.binding.movement,
    {
      inventory_movement_actor_id: principalId,
      inventory_movement_effective_at: input.effectiveAt,
      inventory_movement_item_id: postingLine.itemId,
      inventory_movement_location_id: postingLine.locationId,
      inventory_movement_posting_role: enumOption(
        field(database.binding.movement, 'inventory_movement_posting_role'),
        'adjustment',
      ),
      inventory_movement_quantity_delta: postingLine.quantityDelta,
      inventory_movement_reason_code: input.reason.code,
      inventory_movement_reason_narrative: input.reason.narrative,
      inventory_movement_recorded_at: recordedAt,
      inventory_movement_reversal_of_movement_id: null,
      inventory_movement_source_id: input.sourceId,
      inventory_movement_source_line: postingLine.sourceLine,
      inventory_movement_source_revision: input.sourceRevision,
      inventory_movement_source_type: input.sourceType,
      inventory_movement_stock_dimension_set_version: enumOption(
        field(
          database.binding.movement,
          'inventory_movement_stock_dimension_set_version',
        ),
        'v1',
      ),
      inventory_movement_unit_id: postingLine.unitId,
    },
    movementId,
    input.legalEntityId,
    {
      [database.binding.transaction.entity.entityId]: input.transactionId,
      [database.binding.transactionLine.entity.entityId]:
        postingLine.transactionLineId,
    },
    businessPeriod,
  );
}

test(
  'the Inventory posting capability closes the first-movement one-way doors',
  { timeout: 180_000 },
  async (testContext) => {
    await withPostingDatabase(async (database) => {
      assert.equal(INVENTORY_POSTING_CAPABILITY_ID, postingCapabilityId);
      await assertRegistrationHardening(testContext, database);
      await assertDraftBinding(testContext, database);
      await assertProtectedReadRaces(testContext, database);

      const first = command({
        legalEntityId: legalReject,
        locationId: locationPrimary,
        quantityDelta: '5',
        sourceId: 'adjustment-first',
      });
      await seedDraft(database, first);
      const posted = await database.service.postAdjustment(
        database.context,
        database.actor,
        first,
      );
      assert.equal(posted.replayed, false);
      assert.equal(posted.recordedAt, recordedAt);
      assert.equal(posted.movements.length, 1);
      assert.equal(posted.movements[0]?.quantityDelta, '5');
      assert.equal(posted.movements[0]?.recordedAt, recordedAt);
      assert.equal(await movementCount(database), 1);
      assert.equal(await companionCount(database), 1);
      assert.equal(
        await receiptInputDigestVersion(database, first.idempotencyKey),
        2,
      );

      const sameRequestReplay = await database.service.postAdjustment(
        database.context,
        database.actor,
        first,
      );
      assert.equal(sameRequestReplay.replayed, true);
      assert.deepEqual(sameRequestReplay.movements, posted.movements);
      assert.deepEqual(sameRequestReplay.trust, posted.trust);
      assert.equal(await movementCount(database), 1);

      const naturalEffectReplay = await database.service.postAdjustment(
        database.context,
        database.actor,
        { ...first, idempotencyKey: randomUUID() },
      );
      assert.equal(naturalEffectReplay.replayed, true);
      assert.deepEqual(naturalEffectReplay.movements, posted.movements);
      assert.equal(await movementCount(database), 1);
      assert.equal(await companionCount(database), 1);

      const legacyReplayCommand = {
        ...first,
        idempotencyKey: randomUUID(),
      };
      await cloneLegacyAdjustmentReceipt(
        database,
        first.idempotencyKey,
        legacyReplayCommand,
      );
      const legacyReplay = await database.service.postAdjustment(
        database.context,
        database.actor,
        legacyReplayCommand,
      );
      assert.equal(legacyReplay.replayed, true);
      assert.deepEqual(legacyReplay.movements, posted.movements);
      assert.deepEqual(
        legacyReplay.movements.map((movement) => movement.postingRole),
        ['adjustment'],
      );

      await assert.rejects(
        database.service.postAdjustment(database.context, database.actor, {
          ...first,
          lines: [line('6', '1', locationPrimary)],
        }),
        (error: unknown) =>
          observePostingError(
            testContext,
            'same-key/different-input',
            error,
            'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
          ),
      );
      assert.equal(await movementCount(database), 1);
      await assertConcurrentRequestKeyConflict(testContext, database);

      await assertBaseUnitBound(testContext, database);
      await assertCatalogItemUpdateReportsBoundBaseUnit(database);
      await assertSameInstantMovementIdTieBreak(testContext, database);
      await assertQuantityOnlyEvidence(testContext, database, posted, 1);
      await assert.rejects(
        database.service.postAdjustment(database.context, database.actor, {
          ...first,
          recordedAt,
        } as InventoryAdjustmentPostingCommandV1),
        (error: unknown) =>
          observePostingError(
            testContext,
            'caller-recordedAt',
            error,
            'INVENTORY_POSTING_INPUT_INVALID',
          ),
      );
      await assertMovementCannotUpdate(
        testContext,
        database,
        posted.movements[0]!.movementId,
      );

      const revisedDraft = command({
        legalEntityId: legalReject,
        locationId: locationPrimary,
        quantityDelta: '1',
        sourceId: 'revised-draft',
      });
      await seedDraft(database, revisedDraft);
      await incrementTransactionRevision(database, revisedDraft.transactionId);
      await assert.rejects(
        database.service.postAdjustment(
          database.context,
          database.actor,
          revisedDraft,
        ),
        (error: unknown) =>
          observePostingError(
            testContext,
            'stale-draft-revision',
            error,
            'INVENTORY_TRANSACTION_STATE_CONFLICT',
          ),
      );
      const revisedPosted = await database.service.postAdjustment(
        database.context,
        database.actor,
        { ...revisedDraft, sourceRevision: 2 },
      );
      assert.equal(
        await recordedTransactionRevision(
          database,
          revisedPosted.trust.changeDocumentId,
        ),
        3,
      );

      const forcedRollback = command({
        legalEntityId: legalReject,
        locationId: locationPrimary,
        quantityDelta: '1',
        sourceId: 'forced-rollback',
      });
      await seedDraft(database, forcedRollback);
      await installLateRollbackProbe(database, forcedRollback.transactionId);
      const trustBeforeRollback = await trustCountByRequest(
        database,
        database.context.requestId,
      );
      const companionBeforeRollback = await companionCount(database);
      await assert.rejects(
        database.service.postAdjustment(
          database.context,
          database.actor,
          forcedRollback,
        ),
        (error: unknown) => {
          testContext.diagnostic(
            `forced-rollback: ${postingCode(error) ?? 'unknown'} sqlstate=${postingDetail(error, 'sqlstate') ?? 'unknown'} ${String(error)}`,
          );
          return (
            postingCode(error) === 'INVENTORY_POSTING_STORAGE_REJECTED' &&
            postingDetail(error, 'sqlstate') === 'P0001'
          );
        },
      );
      assert.equal(await rollbackProbeCount(database), 1);
      assert.equal(await movementCountBySource(database, 'forced-rollback'), 0);
      assert.equal(await companionCount(database), companionBeforeRollback);
      assert.equal(
        await trustCountByRequest(database, database.context.requestId),
        trustBeforeRollback,
      );

      const rejectedNegative = command({
        legalEntityId: legalReject,
        locationId: locationTie,
        quantityDelta: '-1',
        sourceId: 'negative-reject',
      });
      await seedDraft(database, rejectedNegative);
      await assert.rejects(
        database.service.postAdjustment(
          database.context,
          database.actor,
          rejectedNegative,
        ),
        (error: unknown) =>
          observePostingError(
            testContext,
            'negative-stock-reject',
            error,
            'INVENTORY_STOCK_NEGATIVE',
          ),
      );
      assert.equal(await movementCountBySource(database, 'negative-reject'), 0);

      const missingReason = command({
        legalEntityId: legalReject,
        locationId: locationPrimary,
        quantityDelta: '1',
        reason: { code: '', narrative: 'Controlled inventory adjustment' },
        sourceId: 'missing-reason',
      });
      await seedDraft(database, missingReason);
      await assert.rejects(
        database.service.postAdjustment(
          database.context,
          database.actor,
          missingReason,
        ),
        (error: unknown) =>
          observePostingError(
            testContext,
            'reason-dial',
            error,
            'INVENTORY_ADJUSTMENT_REASON_REQUIRED',
          ),
      );
      assert.equal(await movementCountBySource(database, 'missing-reason'), 0);

      assert.deepEqual(
        await adjustmentReasonConfiguration(database, legalReject),
        {
          contractReleaseRoot: database.registration.releaseContentHash,
          reasonRequirement: 'codeAndNarrative',
        },
      );
      const missingReasonNarrative = command({
        legalEntityId: legalReject,
        locationId: locationPrimary,
        quantityDelta: '1',
        reason: { code: 'COUNT-CORRECTION', narrative: null },
        sourceId: 'missing-reason-narrative',
      });
      await seedDraft(database, missingReasonNarrative);
      await assert.rejects(
        database.service.postAdjustment(
          database.context,
          database.actor,
          missingReasonNarrative,
        ),
        (error: unknown) =>
          observePostingError(
            testContext,
            'reason-narrative-dial',
            error,
            'INVENTORY_ADJUSTMENT_REASON_REQUIRED',
          ),
      );
      assert.equal(
        await movementCountBySource(database, 'missing-reason-narrative'),
        0,
      );

      await updatePostingConfiguration(database, legalAllow, {
        adjustmentReasonRequirement: 'codeOnly',
      });
      const codeOnlyReason = command({
        legalEntityId: legalAllow,
        locationId: locationPrimary,
        quantityDelta: '1',
        reason: { code: 'CODE-ONLY', narrative: null },
        sourceId: 'reason-code-only',
      });
      await seedDraft(database, codeOnlyReason);
      assert.equal(
        (
          await database.service.postAdjustment(
            database.context,
            database.actor,
            codeOnlyReason,
          )
        ).replayed,
        false,
      );

      const staleEffective = command({
        effectiveAt: '2026-07-28T12:00:00.000Z',
        legalEntityId: legalReject,
        locationId: locationPrimary,
        quantityDelta: '1',
        sourceId: 'backdate-reject',
      });
      await seedDraft(database, staleEffective);
      await assert.rejects(
        database.service.postAdjustment(
          database.context,
          database.actor,
          staleEffective,
        ),
        (error: unknown) =>
          observePostingError(
            testContext,
            'backdate-dial',
            error,
            'INVENTORY_BACKDATE_LIMIT_EXCEEDED',
          ),
      );

      for (const [sourceId, quantityDelta] of [
        ['approval-below-threshold', '0.5'],
        ['approval-at-threshold', '1'],
      ] as const) {
        const withinThreshold = command({
          legalEntityId: legalApproval,
          locationId: locationPrimary,
          quantityDelta,
          sourceId,
        });
        await seedDraft(database, withinThreshold);
        assert.equal(
          (
            await database.service.postAdjustment(
              database.context,
              database.actor,
              withinThreshold,
            )
          ).replayed,
          false,
        );
      }

      const approval = command({
        legalEntityId: legalApproval,
        locationId: locationPrimary,
        quantityDelta: '2',
        sourceId: 'approval-threshold',
      });
      await seedDraft(database, approval);
      await assert.rejects(
        database.service.postAdjustment(
          database.context,
          database.actor,
          approval,
        ),
        (error: unknown) =>
          observePostingError(
            testContext,
            'approval-dial',
            error,
            'INVENTORY_ADJUSTMENT_APPROVAL_REQUIRED',
          ),
      );
      const approved = await database.service.postAdjustment(
        database.context,
        database.approvedActor,
        approval,
      );
      assert.equal(approved.replayed, false);

      const flagged = command({
        legalEntityId: legalFlag,
        locationId: locationPrimary,
        quantityDelta: '-2',
        sourceId: 'negative-flag',
      });
      await seedDraft(database, flagged);
      const flaggedResult = await database.service.postAdjustment(
        database.context,
        database.actor,
        flagged,
      );
      assert.equal(flaggedResult.negativeStockFlag, true);

      const allowed = command({
        legalEntityId: legalAllow,
        locationId: locationPrimary,
        quantityDelta: '-2',
        sourceId: 'negative-allow',
      });
      await seedDraft(database, allowed);
      const allowedResult = await database.service.postAdjustment(
        database.context,
        database.actor,
        allowed,
      );
      assert.equal(allowedResult.negativeStockFlag, false);

      await assertTransferPosting(testContext, database);

      const entityOneEffect = command({
        legalEntityId: legalReject,
        locationId: locationPrimary,
        quantityDelta: '1',
        sourceId: 'shared-natural-effect',
      });
      const entityTwoEffect = command({
        legalEntityId: legalAllow,
        locationId: locationPrimary,
        quantityDelta: '1',
        sourceId: 'shared-natural-effect',
      });
      await seedDraft(database, entityOneEffect);
      await seedDraft(database, entityTwoEffect);
      await database.service.postAdjustment(
        database.context,
        database.actor,
        entityOneEffect,
      );
      const entityTwoPosted = await database.service.postAdjustment(
        database.context,
        database.actor,
        entityTwoEffect,
      );
      assert.equal(
        (
          await database.service.postAdjustment(
            database.context,
            database.actor,
            { ...entityTwoEffect, idempotencyKey: randomUUID() },
          )
        ).replayed,
        true,
      );
      assert.equal(
        await movementCountBySource(database, 'shared-natural-effect'),
        2,
      );
      assert.equal(entityTwoPosted.replayed, false);

      const mixedCase = uppercaseUuidCommand(
        command({
          legalEntityId: legalAllow,
          locationId: locationTie,
          quantityDelta: '1',
          sourceId: 'uppercase-uuid-replay',
        }),
      );
      await seedDraft(database, mixedCase);
      const mixedCasePosted = await database.service.postAdjustment(
        database.context,
        database.actor,
        mixedCase,
      );
      const normalizedReplay = await database.service.postAdjustment(
        database.context,
        database.actor,
        {
          ...lowercaseUuidCommand(mixedCase),
          idempotencyKey: randomUUID(),
        },
      );
      assert.equal(normalizedReplay.replayed, true);
      assert.deepEqual(normalizedReplay.movements, mixedCasePosted.movements);

      const tie = command({
        legalEntityId: legalReject,
        lines: [line('-1', '2', locationTie), line('1', '1', locationTie)],
        sourceId: 'same-instant-order',
      });
      await seedDraft(database, tie);
      const tieResult = await database.service.postAdjustment(
        database.context,
        database.actor,
        tie,
      );
      assert.deepEqual(
        tieResult.movements.map((movement) => movement.sourceLine),
        ['1', '2'],
      );
      assert.equal(await stockBalance(database, legalReject, locationTie), '0');

      const raceSeed = command({
        legalEntityId: legalReject,
        locationId: locationRace,
        quantityDelta: '1',
        sourceId: 'race-0-seed',
      });
      await seedDraft(database, raceSeed);
      await database.service.postAdjustment(
        database.context,
        database.actor,
        raceSeed,
      );
      const issueA = command({
        legalEntityId: legalReject,
        locationId: locationRace,
        quantityDelta: '-1',
        sourceId: 'race-1-issue',
      });
      const issueB = command({
        legalEntityId: legalReject,
        locationId: locationRace,
        quantityDelta: '-1',
        sourceId: 'race-2-issue',
      });
      await seedDraft(database, issueA);
      await seedDraft(database, issueB);
      const raced = await Promise.allSettled([
        database.service.postAdjustment(
          database.context,
          database.actor,
          issueA,
        ),
        database.service.postAdjustment(
          database.context,
          database.actor,
          issueB,
        ),
      ]);
      const raceSummary = raced.map((result) =>
        result.status === 'fulfilled'
          ? 'fulfilled'
          : `${postingCode(result.reason) ?? postgresCode(result.reason) ?? 'unknown'}:${String(result.reason)}`,
      );
      assert.equal(
        raced.filter((result) => result.status === 'fulfilled').length,
        1,
        raceSummary.join('\n'),
      );
      const rejected = raced.find((result) => result.status === 'rejected');
      assert.ok(rejected?.status === 'rejected');
      assert.equal(
        observePostingError(
          testContext,
          'serialized-concurrent-issue',
          rejected.reason,
          'INVENTORY_STOCK_NEGATIVE',
        ),
        true,
      );
      assert.equal(
        await stockBalance(database, legalReject, locationRace),
        '0',
      );

      await setPeriodLock(database, legalReject, effectiveAt);
      const trustBeforeClosed = await trustCountByRequest(
        database,
        database.context.requestId,
      );
      const closed = command({
        legalEntityId: legalReject,
        locationId: locationPrimary,
        quantityDelta: '1',
        sourceId: 'closed-period',
      });
      await seedDraft(database, closed);
      await assert.rejects(
        database.service.postAdjustment(
          database.context,
          database.actor,
          closed,
        ),
        (error: unknown) =>
          observePostingError(
            testContext,
            'period-lock',
            error,
            'INVENTORY_PERIOD_CLOSED',
          ),
      );
      assert.equal(await movementCountBySource(database, 'closed-period'), 0);
      assert.equal(
        await trustCountByRequest(database, database.context.requestId),
        trustBeforeClosed,
      );
      await assertPostingLockTimeoutScopeMechanism(testContext, database);
      await assertPostingLockTimeoutDoesNotLeakToNextBorrower(
        testContext,
        database,
      );
    });
  },
);

function command(
  overrides: Partial<InventoryAdjustmentPostingCommandV1> & {
    legalEntityId: string;
    locationId?: string;
    quantityDelta?: string;
    sourceId: string;
  },
): InventoryAdjustmentPostingCommandV1 {
  const {
    locationId = locationPrimary,
    quantityDelta = '1',
    ...specified
  } = overrides;
  return {
    authorization: specified.authorization ?? {
      decision: 'ALLOW',
      evaluatorVersion: 'northstar.test-policy-evaluator/v1',
      policyVersion: 'northstar.test-policy/v1',
    },
    channel: specified.channel ?? 'API',
    effectiveAt: specified.effectiveAt ?? effectiveAt,
    idempotencyKey: specified.idempotencyKey ?? randomUUID(),
    legalEntityId: specified.legalEntityId,
    lines: specified.lines ?? [line(quantityDelta, '1', locationId)],
    reason: specified.reason ?? {
      code: 'COUNT-CORRECTION',
      narrative: 'Controlled inventory adjustment',
    },
    sourceId: specified.sourceId,
    sourceRevision: specified.sourceRevision ?? 1,
    sourceType: specified.sourceType ?? 'adjustment',
    stockDimensionSetVersion: specified.stockDimensionSetVersion ?? 'v1',
    transactionId: specified.transactionId ?? randomUUID(),
  };
}

function line(quantityDelta: string, sourceLine: string, locationId: string) {
  return {
    itemId,
    locationId,
    quantityDelta,
    sourceLine,
    transactionLineId: randomUUID(),
    unitId: 'EA',
  } as const;
}

function transferCommand(
  overrides: Partial<InventoryTransferPostingCommandV1> & {
    fromLocationId?: string;
    legalEntityId: string;
    quantity?: string;
    sourceId: string;
    toLocationId?: string;
  },
): InventoryTransferPostingCommandV1 {
  const {
    fromLocationId = transferLocationA,
    quantity = '1',
    toLocationId = transferLocationB,
    ...specified
  } = overrides;
  return {
    authorization: specified.authorization ?? {
      decision: 'ALLOW',
      evaluatorVersion: 'northstar.test-policy-evaluator/v1',
      policyVersion: 'northstar.test-policy/v1',
    },
    channel: specified.channel ?? 'API',
    effectiveAt: specified.effectiveAt ?? effectiveAt,
    idempotencyKey: specified.idempotencyKey ?? randomUUID(),
    legalEntityId: specified.legalEntityId,
    lines: specified.lines ?? [
      transferLine(quantity, '1', fromLocationId, toLocationId),
    ],
    reason: specified.reason ?? {
      code: 'WAREHOUSE-TRANSFER',
      narrative: null,
    },
    sourceId: specified.sourceId,
    sourceRevision: specified.sourceRevision ?? 1,
    sourceType: specified.sourceType ?? 'transfer',
    stockDimensionSetVersion: specified.stockDimensionSetVersion ?? 'v1',
    transactionId: specified.transactionId ?? randomUUID(),
  };
}

function transferLine(
  quantity: string,
  sourceLine: string,
  fromLocationId: string,
  toLocationId: string,
): InventoryTransferLineV1 {
  return {
    fromLocationId,
    itemId: transferItemId,
    quantity,
    sourceLine,
    toLocationId,
    transactionLineId: randomUUID(),
    unitId: 'EA',
  };
}

async function assertRegistrationHardening(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  assert.throws(
    () =>
      new PostgresInventoryPostingService(
        database.runtimePool,
        {
          ...database.registration,
          capabilityId: 'northstar.fake:capability.posting',
        } as unknown as InventoryPostingRegistrationV1,
        { currentInstant: () => recordedAt },
      ),
    (error: unknown) =>
      observePostingError(
        testContext,
        'capability-id-mismatch',
        error,
        'INVENTORY_POSTING_CAPABILITY_MISMATCH',
      ),
  );
  assert.throws(
    () =>
      new PostgresInventoryPostingService(
        database.runtimePool,
        {
          ...database.registration,
          dependencySetRoot:
            '7ef50e86732818a0ec4ec2a03a001066ac59408ea260c65bf018646e4377a63d',
        } as unknown as InventoryPostingRegistrationV1,
        { currentInstant: () => recordedAt },
      ),
    (error: unknown) =>
      observePostingError(
        testContext,
        'dependency-root-mismatch',
        error,
        'INVENTORY_POSTING_CAPABILITY_MISMATCH',
      ),
  );

  const tamperedStorage = {
    ...structuredClone(database.registration.storageTarget),
    reviewTamper: true,
  } as unknown as StorageTargetPayloadV1;
  const tamperedService = new PostgresInventoryPostingService(
    database.runtimePool,
    { ...database.registration, storageTarget: tamperedStorage },
    { currentInstant: () => recordedAt },
  );
  const artifactMismatch = command({
    legalEntityId: legalReject,
    sourceId: 'storage-artifact-mismatch',
  });
  await seedDraft(database, artifactMismatch);
  await assert.rejects(
    tamperedService.postAdjustment(
      database.context,
      database.actor,
      artifactMismatch,
    ),
    (error: unknown) =>
      observePostingError(
        testContext,
        'storage-artifact-mismatch',
        error,
        'INVENTORY_POSTING_RELEASE_MISMATCH',
      ),
  );
}

async function assertDraftBinding(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  const draftA = command({
    legalEntityId: legalReject,
    sourceId: 'draft-a',
  });
  const draftB = command({
    legalEntityId: legalReject,
    sourceId: 'draft-b',
  });
  await seedDraft(database, draftA);
  await seedDraft(database, draftB);
  await assert.rejects(
    database.service.postAdjustment(database.context, database.actor, {
      ...draftA,
      lines: [
        {
          ...draftA.lines[0]!,
          transactionLineId: draftB.lines[0]!.transactionLineId,
        },
      ],
    }),
    (error: unknown) =>
      observePostingError(
        testContext,
        'foreign-draft-line',
        error,
        'INVENTORY_TRANSACTION_STATE_CONFLICT',
      ),
  );

  const changedValue = command({
    legalEntityId: legalReject,
    sourceId: 'draft-value-mismatch',
  });
  await seedDraft(database, changedValue);
  await assert.rejects(
    database.service.postAdjustment(database.context, database.actor, {
      ...changedValue,
      lines: [{ ...changedValue.lines[0]!, quantityDelta: '2' }],
    }),
    (error: unknown) =>
      observePostingError(
        testContext,
        'draft-line-value-mismatch',
        error,
        'INVENTORY_TRANSACTION_STATE_CONFLICT',
      ),
  );

  const incomplete = command({
    legalEntityId: legalReject,
    lines: [line('1', '1', locationPrimary), line('1', '2', locationPrimary)],
    sourceId: 'draft-line-omitted',
  });
  await seedDraft(database, incomplete);
  await assert.rejects(
    database.service.postAdjustment(database.context, database.actor, {
      ...incomplete,
      lines: [incomplete.lines[0]!],
    }),
    (error: unknown) =>
      observePostingError(
        testContext,
        'draft-line-set-incomplete',
        error,
        'INVENTORY_TRANSACTION_STATE_CONFLICT',
      ),
  );
}

async function assertTransferPosting(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  await seedAdjustmentBalance(
    database,
    legalReject,
    transferItemId,
    transferLocationA,
    '5',
    '00-transfer-balance-a',
  );
  const balanced = transferCommand({
    legalEntityId: legalReject,
    quantity: '2',
    sourceId: '10-transfer-balanced',
  });
  await seedTransferDraft(database, balanced);
  const posted = await database.service.postTransfer(
    database.context,
    database.actor,
    balanced,
  );
  assert.equal(posted.replayed, false);
  assert.equal(posted.recordedAt, recordedAt);
  assert.equal(posted.movements.length, 2);
  assert.deepEqual(
    posted.movements.map((movement) => movement.quantityDelta).toSorted(),
    ['-2', '2'],
  );
  assert.deepEqual(
    [...new Set(posted.movements.map((movement) => movement.postingRole))],
    ['transfer'],
  );
  assert.deepEqual(
    [...new Set(posted.movements.map((movement) => movement.unitId))],
    ['EA'],
  );
  assert.deepEqual(
    posted.movements.map((movement) => movement.sourceLine).toSorted(),
    ['1:in', '1:out'],
  );
  assert.equal(
    await stockBalance(
      database,
      legalReject,
      transferLocationA,
      transferItemId,
    ),
    '3',
  );
  assert.equal(
    await stockBalance(
      database,
      legalReject,
      transferLocationB,
      transferItemId,
    ),
    '2',
  );
  assert.deepEqual(await transactionState(database, balanced.transactionId), {
    revision: 2,
    state: enumOption(
      field(database.binding.transaction, 'inventory_transaction_state'),
      'posted',
    ),
  });
  assert.deepEqual(await transferMovementRows(database, balanced.sourceId), [
    {
      locationId: transferLocationB,
      postingRole: enumOption(
        field(database.binding.movement, 'inventory_movement_posting_role'),
        'transfer',
      ),
      quantityDelta: '2',
      sourceLine: '1:in',
    },
    {
      locationId: transferLocationA,
      postingRole: enumOption(
        field(database.binding.movement, 'inventory_movement_posting_role'),
        'transfer',
      ),
      quantityDelta: '-2',
      sourceLine: '1:out',
    },
  ]);
  await assertQuantityOnlyEvidence(testContext, database, posted, 2);

  const requestReplay = await database.service.postTransfer(
    database.context,
    database.actor,
    balanced,
  );
  const naturalReplay = await database.service.postTransfer(
    database.context,
    database.actor,
    { ...balanced, idempotencyKey: randomUUID() },
  );
  assert.equal(requestReplay.replayed, true);
  assert.equal(naturalReplay.replayed, true);
  assert.deepEqual(requestReplay.movements, posted.movements);
  assert.deepEqual(naturalReplay.trust, posted.trust);
  assert.equal(await movementCountBySource(database, balanced.sourceId), 2);
  await assert.rejects(
    database.service.postTransfer(database.context, database.actor, {
      ...balanced,
      lines: [{ ...balanced.lines[0]!, quantity: '3' }],
    }),
    (error: unknown) =>
      observePostingError(
        testContext,
        'transfer-same-key-different-input',
        error,
        'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
      ),
  );

  const missingCode = transferCommand({
    legalEntityId: legalReject,
    reason: { code: '', narrative: null },
    sourceId: 'transfer-reason-code-required',
  });
  await seedTransferDraft(database, missingCode);
  await assert.rejects(
    database.service.postTransfer(
      database.context,
      database.actor,
      missingCode,
    ),
    (error: unknown) =>
      observePostingError(
        testContext,
        'transfer-code-only-reason',
        error,
        'INVENTORY_TRANSFER_REASON_REQUIRED',
      ),
  );

  await seedAdjustmentBalance(
    database,
    legalApproval,
    transferItemId,
    transferLocationA,
    '1',
    '00-transfer-approval-seed-a',
  );
  await seedAdjustmentBalance(
    database,
    legalApproval,
    transferItemId,
    transferLocationA,
    '1',
    '00-transfer-approval-seed-b',
  );
  await updatePostingConfiguration(database, legalApproval, {
    transferApprovalThreshold: '3',
  });
  const belowTransferApproval = transferCommand({
    legalEntityId: legalApproval,
    quantity: '2',
    sourceId: '10-transfer-below-approval',
  });
  await seedTransferDraft(database, belowTransferApproval);
  assert.equal(
    (
      await database.service.postTransfer(
        database.context,
        database.actor,
        belowTransferApproval,
      )
    ).replayed,
    false,
  );
  for (const sourceId of [
    '11-transfer-approval-seed-a',
    '11-transfer-approval-seed-b',
    '11-transfer-approval-seed-c',
    '11-transfer-approval-seed-d',
  ]) {
    await seedAdjustmentBalance(
      database,
      legalApproval,
      transferItemId,
      transferLocationA,
      '1',
      sourceId,
    );
  }
  const approvalRequired = transferCommand({
    legalEntityId: legalApproval,
    quantity: '4',
    sourceId: '12-transfer-approval-required',
  });
  await seedTransferDraft(database, approvalRequired);
  await assert.rejects(
    database.service.postTransfer(
      database.context,
      database.actor,
      approvalRequired,
    ),
    (error: unknown) =>
      observePostingError(
        testContext,
        'transfer-approval-dial',
        error,
        'INVENTORY_TRANSFER_APPROVAL_REQUIRED',
      ),
  );
  assert.equal(
    (
      await database.service.postTransfer(
        database.context,
        database.approvedActor,
        approvalRequired,
      )
    ).replayed,
    false,
  );

  await setPeriodLock(database, legalReject, effectiveAt);
  const closed = transferCommand({
    legalEntityId: legalReject,
    sourceId: 'transfer-closed-period',
  });
  await seedTransferDraft(database, closed);
  await assert.rejects(
    database.service.postTransfer(database.context, database.actor, closed),
    (error: unknown) =>
      observePostingError(
        testContext,
        'transfer-period-lock',
        error,
        'INVENTORY_PERIOD_CLOSED',
      ),
  );
  assert.equal(await movementCountBySource(database, closed.sourceId), 0);
  await setPeriodLock(database, legalReject, null);

  await assertTransferRollbackIsAtomic(testContext, database);
  await assertConcurrentOppositeTransfers(testContext, database);
  await assertPersistedPlannedOrderIsDecisive(testContext, database);
}

async function seedAdjustmentBalance(
  database: PostingDatabase,
  legalEntityId: string,
  requestedItemId: string,
  locationId: string,
  quantityDelta: string,
  sourceId: string,
  sourceType = 'adjustment',
): Promise<void> {
  const posting = command({
    legalEntityId,
    lines: [
      {
        ...line(quantityDelta, '1', locationId),
        itemId: requestedItemId,
      },
    ],
    sourceId,
    sourceType,
  });
  await seedDraft(database, posting);
  await database.service.postAdjustment(
    database.context,
    database.actor,
    posting,
  );
}

async function cloneLegacyAdjustmentReceipt(
  database: PostingDatabase,
  sourceIdempotencyKey: string,
  command: InventoryAdjustmentPostingCommandV1,
): Promise<void> {
  const { idempotencyKey, ...semanticInput } = command;
  const inputDigest = createHash('sha256')
    .update(canonicalize(semanticInput))
    .digest('hex');
  const inserted = await database.adminPool.query(
    `INSERT INTO platform.semantic_operation_receipts (
       tenant_id, environment_id, principal_id, release_id,
       release_content_hash, action_id, idempotency_key, input_digest,
       input_digest_version, mutation_result, invocation_id, correlation_id,
       change_document_id, domain_event_id, outbox_id, recorded_at
     )
     SELECT receipt.tenant_id, receipt.environment_id, receipt.principal_id,
            receipt.release_id, receipt.release_content_hash, receipt.action_id,
            $5, $6, 1,
            jsonb_set(
              receipt.mutation_result,
              '{movements}',
              (
                SELECT jsonb_agg(movement - 'postingRole')
                  FROM jsonb_array_elements(
                    receipt.mutation_result->'movements'
                  ) AS movement
              ),
              false
            ),
            receipt.invocation_id, receipt.correlation_id,
            receipt.change_document_id, receipt.domain_event_id,
            receipt.outbox_id, receipt.recorded_at
       FROM platform.semantic_operation_receipts AS receipt
      WHERE receipt.tenant_id=$1 AND receipt.environment_id=$2
        AND receipt.action_id=$3 AND receipt.idempotency_key=$4`,
    [
      tenantId,
      environmentId,
      postingCapabilityId,
      sourceIdempotencyKey,
      idempotencyKey,
      inputDigest,
    ],
  );
  assert.equal(inserted.rowCount, 1);
  const stored = await database.adminPool.query<{
    inputDigest: string;
    inputDigestVersion: number;
    movementRoleCount: number;
  }>(
    `SELECT input_digest AS "inputDigest",
            input_digest_version AS "inputDigestVersion",
            (
              SELECT count(*)::integer
                FROM jsonb_array_elements(
                  receipt.mutation_result->'movements'
                ) AS movement
               WHERE movement ? 'postingRole'
            ) AS "movementRoleCount"
       FROM platform.semantic_operation_receipts AS receipt
      WHERE receipt.tenant_id=$1 AND receipt.environment_id=$2
        AND receipt.action_id=$3 AND receipt.idempotency_key=$4`,
    [tenantId, environmentId, postingCapabilityId, idempotencyKey],
  );
  assert.deepEqual(stored.rows, [
    {
      inputDigest,
      inputDigestVersion: 1,
      movementRoleCount: 0,
    },
  ]);
}

async function assertTransferRollbackIsAtomic(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  const posting = transferCommand({
    legalEntityId: legalReject,
    sourceId: transferAtomicitySourceId,
  });
  await seedTransferDraft(database, posting);
  await installTransferRollbackProbe(database);
  const companionBefore = await companionCount(database);
  const trustBefore = await trustCountByRequest(
    database,
    database.context.requestId,
  );
  try {
    await assert.rejects(
      database.service.postTransfer(database.context, database.actor, posting),
      (error: unknown) => {
        testContext.diagnostic(
          `transfer-atomic-rollback: ${postingCode(error) ?? 'unknown'} ${String(error)}`,
        );
        return (
          postingCode(error) === 'INVENTORY_POSTING_STORAGE_REJECTED' &&
          postingDetail(error, 'sqlstate') === 'P0001'
        );
      },
    );
    assert.equal(await transferRollbackProbeCount(database), 1);
    assert.equal(await movementCountBySource(database, posting.sourceId), 0);
    assert.equal(await companionCount(database), companionBefore);
    assert.equal(
      await trustCountByRequest(database, database.context.requestId),
      trustBefore,
    );
    assert.deepEqual(await transactionState(database, posting.transactionId), {
      revision: 1,
      state: enumOption(
        field(database.binding.transaction, 'inventory_transaction_state'),
        'draft',
      ),
    });
  } finally {
    await removeTransferRollbackProbe(database);
  }
}

async function assertConcurrentOppositeTransfers(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  await seedAdjustmentBalance(
    database,
    legalReject,
    transferItemId,
    transferLocationB,
    '5',
    '00-transfer-balance-b',
  );
  const transferA = transferCommand({
    fromLocationId: transferLocationA,
    legalEntityId: legalReject,
    sourceId: '20-opposite-transfer-a',
    toLocationId: transferLocationB,
  });
  const transferB = transferCommand({
    fromLocationId: transferLocationB,
    legalEntityId: legalReject,
    sourceId: '20-opposite-transfer-b',
    toLocationId: transferLocationA,
  });
  await seedTransferDraft(database, transferA);
  await seedTransferDraft(database, transferB);

  const pool = new pg.Pool({
    ...database.connection,
    application_name: `${postingApplicationName}-opposite-transfers`,
    max: 2,
    user: 'north_star_runtime',
  });
  const arrivals: number[] = [];
  let releaseFirstAcquisitions = (): void => undefined;
  const acquisitionGate = new Promise<void>((resolveGate) => {
    releaseFirstAcquisitions = resolveGate;
  });
  let resolveTwoArrivals = (): void => undefined;
  const twoArrivals = new Promise<void>((resolveArrivals) => {
    resolveTwoArrivals = resolveArrivals;
  });
  const seenClients = new WeakSet<PoolClient>();
  const connect = pool.connect.bind(pool);
  const instrumentedPool = new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'connect') {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (): Promise<PoolClient> => {
        const client = await connect();
        client.query = new Proxy(client.query, {
          apply: async (queryTarget, thisArgument, argumentsList) => {
            const text =
              typeof argumentsList[0] === 'string' ? argumentsList[0] : '';
            const values = Array.isArray(argumentsList[1])
              ? (argumentsList[1] as unknown[])
              : [];
            const result: unknown = await Reflect.apply(
              queryTarget,
              thisArgument,
              argumentsList,
            );
            if (
              !seenClients.has(client) &&
              text.includes('pg_advisory_xact_lock') &&
              values[0] === STOCK_IDENTITY_LOCK_NAMESPACE
            ) {
              seenClients.add(client);
              arrivals.push(Number(values[1]));
              if (arrivals.length === 2) resolveTwoArrivals();
              await acquisitionGate;
            }
            return result;
          },
        });
        return client;
      };
    },
  });
  const service = new PostgresInventoryPostingService(
    instrumentedPool,
    database.registration,
    { currentInstant: () => recordedAt },
  );
  const lockKeys = planStockIdentityLocks([
    {
      environmentId,
      itemId: transferItemId,
      legalEntityId: legalReject,
      locationId: transferLocationA,
      tenantId,
    },
    {
      environmentId,
      itemId: transferItemId,
      legalEntityId: legalReject,
      locationId: transferLocationB,
      tenantId,
    },
  ]).map((target) => target.identityKey);
  const abortWait = new AbortController();
  let outcomesPromise: Promise<PostingOutcome[]> | undefined;
  try {
    outcomesPromise = Promise.all([
      settlePosting(
        service.postTransfer(database.context, database.actor, transferA),
      ),
      settlePosting(
        service.postTransfer(database.context, database.actor, transferB),
      ),
    ]);
    const acquisitionShape = await Promise.race([
      twoArrivals.then(() => 'opposite-first-locks' as const),
      waitForAnyStockLockWait(
        database.adminPool,
        lockKeys,
        abortWait.signal,
      ).then(() => 'shared-first-lock' as const),
    ]);
    abortWait.abort();
    releaseFirstAcquisitions();
    const outcomes = await outcomesPromise;
    assert.equal(
      acquisitionShape,
      'shared-first-lock',
      `opposite callers acquired different first stock keys: ${arrivals.join(',')}`,
    );
    assert.equal(arrivals.length, 2);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      2,
      outcomes
        .map((outcome) =>
          outcome.status === 'fulfilled'
            ? 'fulfilled'
            : `${postingCode(outcome.reason) ?? postgresCode(outcome.reason) ?? 'unknown'}:${String(outcome.reason)}`,
        )
        .join('\n'),
    );
    assert.equal(
      outcomes.some(
        (outcome) =>
          outcome.status === 'rejected' &&
          (postgresCode(outcome.reason) === '40P01' ||
            postingDetail(outcome.reason, 'sqlstate') === '40P01'),
      ),
      false,
    );
    testContext.diagnostic(
      `opposite-transfer-order: both callers converged on first key ${String(arrivals[0])}; the waiter exposed the same ungranted NSST key and both transfers committed without 40P01`,
    );
  } finally {
    abortWait.abort();
    releaseFirstAcquisitions();
    if (outcomesPromise) await outcomesPromise;
    await pool.end();
  }
}

async function assertPersistedPlannedOrderIsDecisive(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  await seedAdjustmentBalance(
    database,
    legalReject,
    orderDecisiveItemId,
    transferLocationA,
    '1',
    'z-persisted-credit',
    'same-instant-order',
  );
  const posting = transferCommand({
    legalEntityId: legalReject,
    lines: [
      {
        ...transferLine('1', '1', transferLocationA, transferLocationB),
        itemId: orderDecisiveItemId,
      },
    ],
    sourceId: 'a-planned-debit',
    sourceType: 'same-instant-order',
  });
  await seedTransferDraft(database, posting);
  await assert.rejects(
    database.service.postTransfer(database.context, database.actor, posting),
    (error: unknown) =>
      observePostingError(
        testContext,
        'persisted-planned-global-order',
        error,
        'INVENTORY_STOCK_NEGATIVE',
      ),
  );
  assert.equal(await movementCountBySource(database, posting.sourceId), 0);
  assert.deepEqual(await transactionState(database, posting.transactionId), {
    revision: 1,
    state: enumOption(
      field(database.binding.transaction, 'inventory_transaction_state'),
      'draft',
    ),
  });
  testContext.diagnostic(
    'persisted-planned-global-order: planned debit sourceId=a sorts before persisted credit sourceId=z at the same effectiveAt/recordedAt; removing the production persisted-plus-planned sort changes rejection to commit',
  );
}

type PostingResult = Awaited<
  ReturnType<PostgresInventoryPostingService['postAdjustment']>
>;
type PostingOutcome =
  | { status: 'fulfilled'; value: PostingResult }
  | { reason: unknown; status: 'rejected' };

async function assertProtectedReadRaces(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  await assertBoundedConcurrencyControl(testContext, database);
  await assertHeldStockLockTimeout(testContext, database);
  await assertConcurrentBaseUnitChange(testContext, database);
  await assertConcurrentPeriodClose(testContext, database);
  await assertConcurrentChildInsert(testContext, database);
}

async function assertPostingLockTimeoutScopeMechanism(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  const posting = command({
    legalEntityId: legalAllow,
    sourceId: 'posting-lock-timeout-transaction-local',
  });
  await seedDraft(database, posting);
  const singleConnectionPool = new pg.Pool({
    ...database.connection,
    application_name: `${postingApplicationName}-lock-timeout-mechanism`,
    max: 1,
    user: 'north_star_runtime',
  });
  try {
    const mechanismClient = await singleConnectionPool.connect();
    let sessionScopeNeedsReset = false;
    let transactionOpen = false;
    let mechanismBackendPid = -1;
    try {
      const before = await readLockTimeoutSetting(mechanismClient);
      assert.equal(before.milliseconds, '0');
      mechanismBackendPid = before.backendPid;

      await mechanismClient.query('BEGIN');
      transactionOpen = true;
      await mechanismClient.query(
        "SELECT set_config('lock_timeout', '15000', true)",
      );
      const localInside = await readLockTimeoutSetting(mechanismClient);
      assert.equal(localInside.backendPid, mechanismBackendPid);
      assert.equal(localInside.milliseconds, '15000');
      await mechanismClient.query('COMMIT');
      transactionOpen = false;
      const localAfterCommit = await readLockTimeoutSetting(mechanismClient);
      assert.equal(localAfterCommit.backendPid, mechanismBackendPid);
      assert.equal(localAfterCommit.milliseconds, '0');

      await mechanismClient.query('BEGIN');
      transactionOpen = true;
      await mechanismClient.query(
        "SELECT set_config('lock_timeout', '15000', false)",
      );
      sessionScopeNeedsReset = true;
      const sessionInside = await readLockTimeoutSetting(mechanismClient);
      assert.equal(sessionInside.backendPid, mechanismBackendPid);
      assert.equal(sessionInside.milliseconds, '15000');
      await mechanismClient.query('COMMIT');
      transactionOpen = false;
      const sessionAfterCommit = await readLockTimeoutSetting(mechanismClient);
      assert.equal(sessionAfterCommit.backendPid, mechanismBackendPid);
      assert.equal(sessionAfterCommit.milliseconds, '15000');
      testContext.diagnostic(
        `posting-lock-timeout-mechanism: backend ${String(mechanismBackendPid)} local=true reverted 15000ms to 0ms at COMMIT; local=false retained 15000ms`,
      );

      await mechanismClient.query('RESET lock_timeout');
      sessionScopeNeedsReset = false;
      const afterCleanup = await readLockTimeoutSetting(mechanismClient);
      assert.equal(afterCleanup.backendPid, mechanismBackendPid);
      assert.equal(afterCleanup.milliseconds, '0');
    } finally {
      if (transactionOpen) {
        await mechanismClient.query('ROLLBACK').catch(() => undefined);
      }
      if (sessionScopeNeedsReset) {
        await mechanismClient
          .query('RESET lock_timeout')
          .catch(() => undefined);
      }
      mechanismClient.release();
    }

    const instrumentedClient = await singleConnectionPool.connect();
    const serviceBackend = await readLockTimeoutSetting(instrumentedClient);
    assert.equal(serviceBackend.backendPid, mechanismBackendPid);
    let serviceInsideTransaction: LockTimeoutSetting | undefined;
    let serviceAfterCommit: LockTimeoutSetting | undefined;
    instrumentedClient.query = new Proxy(instrumentedClient.query, {
      apply: async (target, thisArgument, argumentsList) => {
        const queryText =
          typeof argumentsList[0] === 'string' ? argumentsList[0] : null;
        const result: unknown = await Reflect.apply(
          target,
          thisArgument,
          argumentsList,
        );
        if (queryText?.includes("set_config('lock_timeout'")) {
          serviceInsideTransaction =
            await readLockTimeoutSetting(instrumentedClient);
        } else if (queryText === 'COMMIT') {
          serviceAfterCommit = await readLockTimeoutSetting(instrumentedClient);
        }
        return result;
      },
    });
    instrumentedClient.release();

    const service = new PostgresInventoryPostingService(
      singleConnectionPool,
      database.registration,
      { currentInstant: () => recordedAt },
    );
    const posted = await service.postAdjustment(
      database.context,
      database.actor,
      posting,
    );
    assert.equal(posted.replayed, false);

    assert.equal(
      serviceInsideTransaction?.backendPid,
      mechanismBackendPid,
      'the service lock_timeout call was not observed on its posting backend',
    );
    assert.equal(serviceInsideTransaction?.milliseconds, '15000');
    assert.equal(serviceAfterCommit?.backendPid, mechanismBackendPid);
    assert.equal(
      serviceAfterCommit?.milliseconds,
      '0',
      'the service lock_timeout did not revert at COMMIT before RESET ALL',
    );
    testContext.diagnostic(
      `posting-lock-timeout-service-scope: backend ${String(mechanismBackendPid)} observed 15000ms inside the service transaction and 0ms immediately after COMMIT before RESET ALL`,
    );
  } finally {
    await singleConnectionPool.end();
  }
}

async function assertPostingLockTimeoutDoesNotLeakToNextBorrower(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  const posting = command({
    legalEntityId: legalAllow,
    sourceId: 'posting-lock-timeout-no-leak',
  });
  await seedDraft(database, posting);
  const singleConnectionPool = new pg.Pool({
    ...database.connection,
    application_name: `${postingApplicationName}-lock-timeout-no-leak`,
    max: 1,
    user: 'north_star_runtime',
  });
  try {
    const before = await borrowLockTimeoutSetting(singleConnectionPool);
    assert.equal(before.milliseconds, '0');
    const preexistingSessionSetting = await setSessionLockTimeout(
      singleConnectionPool,
      '7000',
    );
    assert.equal(preexistingSessionSetting.backendPid, before.backendPid);
    assert.equal(preexistingSessionSetting.milliseconds, '7000');

    const service = new PostgresInventoryPostingService(
      singleConnectionPool,
      database.registration,
      { currentInstant: () => recordedAt },
    );
    const posted = await service.postAdjustment(
      database.context,
      database.actor,
      posting,
    );
    assert.equal(posted.replayed, false);

    const after = await borrowLockTimeoutSetting(singleConnectionPool);
    assert.equal(after.backendPid, before.backendPid);
    assert.equal(after.milliseconds, '0');
    testContext.diagnostic(
      `posting-lock-timeout-no-leak: backend ${String(after.backendPid)} entered posting with a 7000ms session setting and the next borrower observed the default ${after.milliseconds}ms after service cleanup`,
    );
  } finally {
    await singleConnectionPool.end();
  }
}

async function assertBoundedConcurrencyControl(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  const holder = await database.adminPool.connect();
  const waiter = await database.adminPool.connect();
  let holderOpen = false;
  let waiterOpen = false;
  let waitingAcquire: Promise<unknown> | undefined;
  try {
    await beginBoundedControlTransaction(holder);
    holderOpen = true;
    await beginBoundedControlTransaction(waiter);
    waiterOpen = true;
    const waiterPid = await backendPid(waiter);
    await holder.query(
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
      [lineRaceLockNamespace, lineRaceLockKey],
    );
    waitingAcquire = waiter.query(
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
      [lineRaceLockNamespace, lineRaceLockKey],
    );
    void waitingAcquire.catch(() => undefined);
    assert.equal(
      await waitForExactAdvisoryLock(
        database.adminPool,
        waiterPid,
        lineRaceLockNamespace,
        lineRaceLockKey,
        false,
      ),
      true,
    );
    await assert.rejects(waitingAcquire, (error: unknown) =>
      observePostgresError(
        testContext,
        'bounded-concurrency-control',
        error,
        '55P03',
      ),
    );
  } finally {
    if (waiterOpen) await waiter.query('ROLLBACK');
    if (holderOpen) await holder.query('ROLLBACK');
    waiter.release();
    holder.release();
  }
}

async function assertHeldStockLockTimeout(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  const posting = command({
    legalEntityId: legalReject,
    sourceId: 'held-stock-lock-timeout',
  });
  await seedDraft(database, posting);
  const trustBefore = await trustCountByRequest(
    database,
    database.context.requestId,
  );
  const target = planStockIdentityLocks([
    {
      environmentId,
      itemId,
      legalEntityId: posting.legalEntityId,
      locationId: posting.lines[0]!.locationId,
      tenantId,
    },
  ])[0];
  assert.ok(target);
  const holder = await database.adminPool.connect();
  let holderOpen = false;
  let outcomePromise: Promise<PostingOutcome> | undefined;
  try {
    await beginBoundedControlTransaction(holder);
    holderOpen = true;
    const holderPid = await backendPid(holder);
    await holder.query(
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
      [STOCK_IDENTITY_LOCK_NAMESPACE, target.identityKey],
    );
    outcomePromise = settlePosting(
      database.service.postAdjustment(
        database.context,
        database.actor,
        posting,
      ),
    );
    const blocked = await waitForPostingBlockedBy(
      database.adminPool,
      holderPid,
      'held stock identity',
    );
    assert.equal(blocked.waitEvent, 'advisory');
    assert.equal(
      await holdsExactAdvisoryLock(
        database.adminPool,
        blocked.pid,
        STOCK_IDENTITY_LOCK_NAMESPACE,
        target.identityKey,
        false,
      ),
      true,
    );
    const outcome = await outcomePromise;
    assertRejectedPosting(
      testContext,
      'held-stock-lock-timeout',
      outcome,
      'INVENTORY_POSTING_LOCK_TIMEOUT',
    );
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') {
      assert.equal(postingDetail(outcome.reason, 'sqlstate'), '55P03');
      assert.equal(
        postingDetail(outcome.reason, 'lockTimeoutMilliseconds'),
        '15000',
      );
    }
    assert.equal(
      await holdsExactAdvisoryLock(
        database.adminPool,
        holderPid,
        STOCK_IDENTITY_LOCK_NAMESPACE,
        target.identityKey,
        true,
      ),
      true,
    );
    assert.equal(await movementCountBySource(database, posting.sourceId), 0);
    assert.equal(
      await trustCountByRequest(database, database.context.requestId),
      trustBefore,
    );
  } finally {
    if (holderOpen) await holder.query('ROLLBACK');
    holder.release();
    if (outcomePromise) await outcomePromise;
  }
}

async function assertConcurrentBaseUnitChange(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  const posting = command({
    legalEntityId: legalReject,
    sourceId: 'concurrent-base-unit-change',
  });
  await seedDraft(database, posting);
  const trustBefore = await trustCountByRequest(
    database,
    database.context.requestId,
  );
  const mutator = await beginModuleTransaction(database);
  let mutatorOpen = true;
  let outcomePromise: Promise<PostingOutcome> | undefined;
  try {
    const blockerPid = await backendPid(mutator);
    await mutator.query(
      `UPDATE ${table(database.binding, database.binding.item)}
          SET ${quoted(field(database.binding.item, 'item_base_unit').physicalName)}='BOX',
              ${quoted(database.binding.item.revisionColumn)}=${quoted(database.binding.item.revisionColumn)}+1
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(database.binding.item.recordIdColumn)}=$3`,
      [tenantId, environmentId, itemId],
    );
    outcomePromise = settlePosting(
      database.service.postAdjustment(
        database.context,
        database.actor,
        posting,
      ),
    );
    const blocked = await waitForPostingBlockedBy(
      database.adminPool,
      blockerPid,
      'base-unit row',
    );
    await assertStockLockHeld(database.adminPool, blocked.pid, [posting]);
    await mutator.query('COMMIT');
    mutatorOpen = false;
    const outcome = await outcomePromise;
    assertRejectedPosting(
      testContext,
      'concurrent-base-unit-change',
      outcome,
      'INVENTORY_ITEM_UNIT_MISMATCH',
    );
    assert.equal(await movementCountBySource(database, posting.sourceId), 0);
    assert.equal(
      await trustCountByRequest(database, database.context.requestId),
      trustBefore,
    );
  } finally {
    if (mutatorOpen) await mutator.query('ROLLBACK');
    mutator.release();
    if (outcomePromise) await outcomePromise;
  }
  await withModuleRole(
    database.runtimePool,
    database.context,
    async (client) => {
      await client.query(
        `UPDATE ${table(database.binding, database.binding.item)}
          SET ${quoted(field(database.binding.item, 'item_base_unit').physicalName)}='EA',
              ${quoted(database.binding.item.revisionColumn)}=${quoted(database.binding.item.revisionColumn)}+1
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(database.binding.item.recordIdColumn)}=$3`,
        [tenantId, environmentId, itemId],
      );
    },
  );
}

async function assertConcurrentPeriodClose(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  const posting = command({
    legalEntityId: legalReject,
    sourceId: 'concurrent-period-close',
  });
  await seedDraft(database, posting);
  const trustBefore = await trustCountByRequest(
    database,
    database.context.requestId,
  );
  const mutator = await beginModuleTransaction(database);
  let mutatorOpen = true;
  let outcomePromise: Promise<PostingOutcome> | undefined;
  try {
    const blockerPid = await backendPid(mutator);
    await mutator.query(
      `UPDATE ${table(database.binding, database.binding.periodLock)}
          SET ${quoted(database.binding.periodLockClosedThroughColumn)}=$4,
              ${quoted(database.binding.periodLock.revisionColumn)}=${quoted(database.binding.periodLock.revisionColumn)}+1
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(database.binding.periodLock.legalEntityColumn!)}=$3`,
      [tenantId, environmentId, legalReject, effectiveAt],
    );
    outcomePromise = settlePosting(
      database.service.postAdjustment(
        database.context,
        database.actor,
        posting,
      ),
    );
    const blocked = await waitForPostingBlockedBy(
      database.adminPool,
      blockerPid,
      'period-lock row',
    );
    await assertStockLockHeld(database.adminPool, blocked.pid, [posting]);
    await mutator.query('COMMIT');
    mutatorOpen = false;
    const outcome = await outcomePromise;
    assertRejectedPosting(
      testContext,
      'concurrent-period-close',
      outcome,
      'INVENTORY_PERIOD_CLOSED',
    );
    assert.equal(await movementCountBySource(database, posting.sourceId), 0);
    assert.equal(
      await trustCountByRequest(database, database.context.requestId),
      trustBefore,
    );
  } finally {
    if (mutatorOpen) await mutator.query('ROLLBACK');
    mutator.release();
    if (outcomePromise) await outcomePromise;
  }
  await setPeriodLock(database, legalReject, null);
}

async function assertConcurrentChildInsert(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  const posting = command({
    legalEntityId: legalReject,
    sourceId: 'concurrent-child-insert',
  });
  const insertedLine = line('1', '2', locationPrimary);
  await seedDraft(database, posting);
  await installLineRaceBlocker(database, posting.sourceId);
  const preparedChildInsert = prepareDraftLineInsert(
    database,
    posting,
    insertedLine,
  );
  const trustBefore = await trustCountByRequest(
    database,
    database.context.requestId,
  );
  const blocker = await database.adminPool.connect();
  let blockerOpen = false;
  let childInserter: PoolClient | undefined;
  let childInserterOpen = false;
  let outcomePromise: Promise<PostingOutcome> | undefined;
  try {
    // Resolve the INSERT and establish the module-role transaction before
    // taking the barrier. Once posting is parked, the child mutation needs
    // exactly one INSERT and its COMMIT before the barrier can be released.
    childInserter = await beginModuleTransaction(database);
    childInserterOpen = true;
    await beginBoundedControlTransaction(blocker);
    blockerOpen = true;
    const blockerPid = await backendPid(blocker);
    await blocker.query(
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
      [lineRaceLockNamespace, lineRaceLockKey],
    );
    outcomePromise = settlePosting(
      database.service.postAdjustment(
        database.context,
        database.actor,
        posting,
      ),
    );
    const blocked = await waitForPostingBlockedBy(
      database.adminPool,
      blockerPid,
      'test movement-insert barrier',
    );
    await assertStockLockHeld(database.adminPool, blocked.pid, [posting]);
    await childInserter.query(
      preparedChildInsert.text,
      preparedChildInsert.values,
    );
    await childInserter.query('COMMIT');
    childInserterOpen = false;
    testContext.diagnostic(
      'concurrent-child-insert residual: the generic child insert committed while the draft header was row-locked; the posting digest must abort the transition',
    );
    await blocker.query('COMMIT');
    blockerOpen = false;
    assert.equal(await activeTransactionLineCount(database, posting), 2);
    const outcome = await outcomePromise;
    assertRejectedPosting(
      testContext,
      'concurrent-child-insert',
      outcome,
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
    );
    assert.equal(await movementCountBySource(database, posting.sourceId), 0);
    assert.equal(
      await trustCountByRequest(database, database.context.requestId),
      trustBefore,
    );
    assert.deepEqual(await transactionState(database, posting.transactionId), {
      revision: 1,
      state: enumOption(
        field(database.binding.transaction, 'inventory_transaction_state'),
        'draft',
      ),
    });
  } finally {
    if (childInserterOpen && childInserter) {
      await childInserter.query('ROLLBACK');
    }
    childInserter?.release();
    if (blockerOpen) await blocker.query('ROLLBACK');
    blocker.release();
    if (outcomePromise) await outcomePromise;
    await removeLineRaceBlocker(database);
  }
}

async function assertConcurrentRequestKeyConflict(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  const idempotencyKey = requestKeyRaceIdempotencyKey;
  const requestLock = planInventoryPostingRequestLock(
    database.context,
    database.registration.capabilityId,
    idempotencyKey,
  );
  assert.deepEqual(requestLock, {
    namespace: STOCK_IDENTITY_LOCK_NAMESPACE,
    requestKey: requestKeyRaceExpectedKey,
  });
  const commandA = command({
    idempotencyKey,
    legalEntityId: legalAllow,
    locationId: locationPrimary,
    sourceId: 'request-key-race-a',
  });
  const commandB = command({
    idempotencyKey,
    legalEntityId: legalAllow,
    locationId: locationTie,
    sourceId: 'request-key-race-b',
  });
  await seedDraft(database, commandA);
  await seedDraft(database, commandB);
  const trustBefore = await trustCountByRequest(
    database,
    database.context.requestId,
  );
  const blocker = await beginModuleTransaction(database);
  let blockerOpen = true;
  let outcomesPromise: Promise<PostingOutcome[]> | undefined;
  try {
    await blocker.query(
      `UPDATE ${table(database.binding, database.binding.item)}
          SET ${quoted(field(database.binding.item, 'item_base_unit').physicalName)}=${quoted(field(database.binding.item, 'item_base_unit').physicalName)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(database.binding.item.recordIdColumn)}=$3`,
      [tenantId, environmentId, itemId],
    );
    outcomesPromise = Promise.all([
      settlePosting(
        database.service.postAdjustment(
          database.context,
          database.actor,
          commandA,
        ),
      ),
      settlePosting(
        database.service.postAdjustment(
          database.context,
          database.actor,
          commandB,
        ),
      ),
    ]);
    const waiters = await waitForPostingLockWaiters(database.adminPool, 2);
    const requestWaiters: number[] = [];
    const requestHolders: number[] = [];
    for (const waiter of waiters) {
      if (
        waiter.waitEvent === 'advisory' &&
        (await holdsExactAdvisoryLock(
          database.adminPool,
          waiter.pid,
          requestLock.namespace,
          requestLock.requestKey,
          false,
        ))
      ) {
        requestWaiters.push(waiter.pid);
      }
      if (
        await holdsExactAdvisoryLock(
          database.adminPool,
          waiter.pid,
          requestLock.namespace,
          requestLock.requestKey,
          true,
        )
      ) {
        requestHolders.push(waiter.pid);
      }
      await assertStockLockHeld(database.adminPool, waiter.pid, [
        commandA,
        commandB,
      ]);
    }
    assert.equal(requestWaiters.length, 1, JSON.stringify(waiters));
    assert.equal(requestHolders.length, 1, JSON.stringify(waiters));
    assert.notEqual(requestLock.requestKey, lineRaceLockKey);
    testContext.diagnostic(
      `request-key derivation: ${JSON.stringify({
        derivation:
          'sha256(v1\\0tenant\\0environment\\0capability\\0idempotencyKey)[0..4]::int32be',
        namespace: requestLock.namespace,
        requestKey: requestLock.requestKey,
      })}`,
    );
    await blocker.query('ROLLBACK');
    blockerOpen = false;
    const outcomes = await outcomesPromise;
    const fulfilled = outcomes.filter(
      (outcome): outcome is Extract<PostingOutcome, { status: 'fulfilled' }> =>
        outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome): outcome is Extract<PostingOutcome, { status: 'rejected' }> =>
        outcome.status === 'rejected',
    );
    assert.equal(fulfilled.length, 1, JSON.stringify(outcomes));
    assert.equal(fulfilled[0]!.value.replayed, false);
    assert.equal(rejected.length, 1, JSON.stringify(outcomes));
    assertRejectedPosting(
      testContext,
      'concurrent-request-key-conflict',
      rejected[0]!,
      'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
    );
    assert.equal(
      (await movementCountBySource(database, commandA.sourceId)) +
        (await movementCountBySource(database, commandB.sourceId)),
      1,
    );
    assert.equal(await receiptCountByKey(database, idempotencyKey), 1);
    assert.equal(
      await trustCountByRequest(database, database.context.requestId),
      trustBefore + 1,
    );
  } finally {
    if (blockerOpen) await blocker.query('ROLLBACK');
    blocker.release();
    if (outcomesPromise) await outcomesPromise;
  }
}

function settlePosting(
  promise: Promise<PostingResult>,
): Promise<PostingOutcome> {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ reason, status: 'rejected' as const }),
  );
}

function assertRejectedPosting(
  testContext: TestContext,
  label: string,
  outcome: PostingOutcome,
  expectedCode: string,
): void {
  assert.equal(outcome.status, 'rejected', JSON.stringify(outcome));
  if (outcome.status !== 'rejected') return;
  assert.equal(
    observePostingError(testContext, label, outcome.reason, expectedCode),
    true,
  );
}

function uppercaseUuidCommand(
  input: InventoryAdjustmentPostingCommandV1,
): InventoryAdjustmentPostingCommandV1 {
  return {
    ...input,
    idempotencyKey: input.idempotencyKey.toUpperCase(),
    legalEntityId: input.legalEntityId.toUpperCase(),
    lines: input.lines.map((entry) => ({
      ...entry,
      itemId: entry.itemId.toUpperCase(),
      locationId: entry.locationId.toUpperCase(),
      transactionLineId: entry.transactionLineId.toUpperCase(),
    })),
    transactionId: input.transactionId.toUpperCase(),
  };
}

function lowercaseUuidCommand(
  input: InventoryAdjustmentPostingCommandV1,
): InventoryAdjustmentPostingCommandV1 {
  return {
    ...input,
    idempotencyKey: input.idempotencyKey.toLowerCase(),
    legalEntityId: input.legalEntityId.toLowerCase(),
    lines: input.lines.map((entry) => ({
      ...entry,
      itemId: entry.itemId.toLowerCase(),
      locationId: entry.locationId.toLowerCase(),
      transactionLineId: entry.transactionLineId.toLowerCase(),
    })),
    transactionId: input.transactionId.toLowerCase(),
  };
}

let fixturePromise: Promise<PostingFixture> | undefined;

test('RECEIPT posts atomically, refuses over-receipt across locations, and preserves correction history', async (t) => {
  await withPostingDatabase(async (database) => {
    const binding = receiptBinding(database.registration.storageTarget)!;
    assert.ok(binding);
    const service = new PostgresInventoryPostingService(
      database.runtimePool,
      {
        ...database.registration,
        capabilityId: RECEIVING_CAPABILITY_ID,
        capabilityVersion: 1,
      },
      { currentInstant: () => recordedAt },
    );
    const orderId = randomUUID(),
      orderLineId = randomUUID();
    const policy = new AllowRuntimePolicy();
    const issuer = new TrustedActorEnvelopeIssuer({
      resolve: async () => ({
        approvingHumanId: null,
        delegation: null,
        executionPrincipal: { kind: 'HUMAN', principalId },
        initiatingHumanId: principalId,
        subject: null,
      }),
    });
    const interpreter = new PostgresModuleRuntimeInterpreter(
      database.runtimePool,
      issuer,
      INVENTORY_PROVIDER_ERROR_MAPPINGS,
    );
    // The order page reads its totals query (PURCHASING-PARITY), a
    // commercial read model.
    const queryGateway = new SemanticQueryGateway(
      policy,
      interpreter,
      undefined,
      undefined,
      undefined,
      undefined,
      { [COMMERCIAL_CAPABILITY_ID]: commercialReadModel },
    );
    const fixture = await compiledFixture();
    const capabilityContext = {
      actorIssuer: issuer,
      pool: database.runtimePool,
      currentInstant: () => recordedAt,
      queryGateway,
      releaseId: database.registration.releaseId,
      releaseContentHash: database.registration.releaseContentHash,
      projection: (familyId: string) => {
        const projection = projectionPayload<unknown>(
          fixture.inventory,
          familyId,
        );
        return {
          payload: projection.payload,
          contentHash: projection.contentHash,
        };
      },
    };
    const executor =
      RECEIVING_CAPABILITY_EXECUTOR_FACTORY.create(capabilityContext);
    const mediation = new SemanticOperationMediationAuthority();
    let tamperReceivingExecution:
      | ((
          request: RegisteredCapabilityOperationExecutionRequest,
        ) => RegisteredCapabilityOperationExecutionRequest)
      | undefined;
    const gateway = new SemanticOperationGateway(
      policy,
      interpreter,
      mediation,
      undefined,
      [
        {
          capabilityId: executor.capabilityId,
          prepareAuthorization: (request) =>
            executor.prepareAuthorization(request),
          execute: async (request) => {
            try {
              return await executor.execute(
                tamperReceivingExecution
                  ? tamperReceivingExecution(request)
                  : request,
              );
            } catch (error) {
              t.diagnostic(
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
              );
              throw error;
            }
          },
        },
        PAYABLES_CAPABILITY_EXECUTOR_FACTORY.create(capabilityContext),
      ],
    );
    const entry = new AuthenticatedRequestRuntimeEntryAdapter(
      new AuthenticatedRequestEntryAdapter(async () => ({
        environmentId,
        principalId,
        tenantId,
      })),
      new PostgresRequestRuntimeViewService(database.runtimePool),
      policy,
    );
    const invoke = (
      local: string,
      recordId: string,
      expectedRevision: number,
    ) =>
      entry.run({ headers: {} }, (view) => {
        const operationId = `northstar.app:operation.${local}`,
          input = { recordId, expectedRevision };
        return gateway.invoke(
          view,
          {
            schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
            operationId,
            input,
            idempotencyKey: randomUUID(),
            confirmationGrant: mediation.issueConfirmationGrant(
              view,
              operationId,
              input,
            ),
          },
          mediation.issueInvocation(view, 'UI'),
        );
      });
    const insert = async (
      entity: StorageEntityTarget,
      id: string,
      values: Record<string, unknown>,
      relations: Record<string, string | null> = {},
    ) => {
      const row: Record<string, unknown> = {
        tenant_id: tenantId,
        environment_id: environmentId,
        legal_entity_id: legalReject,
        record_id: id,
        revision: 1,
        archived_at: null,
      };
      for (const column of entity.columns) {
        const local = column.canonicalFieldId.split(':').at(-1)!;
        row[column.physicalName] = values[local] ?? null;
      }
      for (const [relation, value] of Object.entries(relations))
        row[receiptRelation(binding, entity, relation)] = value;
      await database.adminPool.query(
        `INSERT INTO ${receiptTable(entity)} (${Object.keys(row).map(quoted).join(',')}) VALUES (${Object.keys(
          row,
        )
          .map((_, index) => `$${index + 1}`)
          .join(',')})`,
        Object.values(row),
      );
    };
    await insert(binding.order, orderId, {
      'field.purchase_order_number': 'RECEIPT-ORDER',
      'field.purchase_order_supplier_party_id': randomUUID(),
      'field.purchase_order_order_date': businessPeriod,
      'field.purchase_order_expected_date': businessPeriod,
      'field.purchase_order_currency': 'CAD',
      'field.purchase_order_notes': 'Receipt kernel control',
      'derived_state_field.machine.purchase_order_lifecycle':
        'northstar.app:state.purchase_order_released',
    });
    await insert(
      binding.orderLine,
      orderLineId,
      {
        'field.purchase_order_line_line_number': 1,
        'field.purchase_order_line_item_id': itemId,
        'field.purchase_order_line_ordered_quantity': '10',
        'field.purchase_order_line_unit_price': null,
      },
      { purchase_order_line_order: orderId },
    );
    const staged = async (
      quantity: string,
      locationId = locationPrimary,
      correction?: { original: string; movement: string },
    ): Promise<GoodsReceiptCommand> => {
      const sourceId = randomUUID(),
        receiptLineId = randomUUID();
      const kind = correction ? 'correction' : 'initial';
      const receiptEffectiveAt = correction
        ? '2026-07-29T12:30:00.000Z'
        : effectiveAt;
      const number = `GR-${sourceId}`;
      await insert(
        binding.receipt,
        sourceId,
        {
          'field.goods_receipt_number': number,
          'field.goods_receipt_state': receiptOption(
            binding.receipt,
            'goods_receipt_state',
            'draft',
          ),
          'field.goods_receipt_kind': receiptOption(
            binding.receipt,
            'goods_receipt_kind',
            kind,
          ),
          'field.goods_receipt_effective_at': receiptEffectiveAt,
          'field.goods_receipt_location_id': locationId,
          'field.goods_receipt_reason_code': 'COUNT-CORRECTION',
          'field.goods_receipt_reason_narrative': 'Controlled receipt',
        },
        {
          goods_receipt_order: orderId,
          goods_receipt_supersedes: correction?.original ?? null,
        },
      );
      await insert(
        binding.line,
        receiptLineId,
        {
          'field.goods_receipt_line_line_number': 1,
          'field.goods_receipt_line_item_id': itemId,
          'field.goods_receipt_line_quantity': quantity,
          'field.goods_receipt_line_unit_id': 'EA',
          'field.goods_receipt_line_cost_status': receiptOption(
            binding.line,
            'goods_receipt_line_cost_status',
            'absent',
          ),
          'field.goods_receipt_line_unit_cost': null,
          'field.goods_receipt_line_currency': null,
          'field.goods_receipt_line_reversal_of_movement_id':
            correction?.movement ?? null,
        },
        {
          goods_receipt_line_receipt: sourceId,
          goods_receipt_line_order_line: orderLineId,
        },
      );
      return {
        authorization: {
          decision: 'ALLOW',
          evaluatorVersion: 'northstar.test-policy-evaluator/v1',
          policyVersion: 'northstar.test-policy/v1',
        },
        channel: 'API',
        effectiveAt: receiptEffectiveAt,
        idempotencyKey: randomUUID(),
        legalEntityId: legalReject,
        sourceId,
        sourceRevision: 1,
        sourceType: 'goodsReceipt',
        stockDimensionSetVersion: 'v1',
        kind,
        receiptNumber: number,
        orderId,
        locationId,
        supersedesReceiptId: correction?.original ?? null,
        reason: { code: 'COUNT-CORRECTION', narrative: 'Controlled receipt' },
        lines: [
          {
            receiptLineId,
            orderLineId,
            sourceLine: '1',
            itemId,
            unitId: 'EA',
            quantityDelta: quantity,
            costStatus: 'absent',
            unitCost: null,
            currency: null,
            reversalOfMovementId: correction?.movement ?? null,
          },
        ],
      };
    };
    const received = async () => {
      const result = await database.adminPool.query(
        `SELECT ${quoted(receiptColumn(binding.received, 'purchase_order_received_received_quantity'))}::text AS quantity FROM ${receiptTable(binding.received)} WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3 AND record_id=$4`,
        [
          tenantId,
          environmentId,
          legalReject,
          receivedIdentity(database.context, legalReject, orderLineId),
        ],
      );
      return result.rows[0]?.quantity as string | undefined;
    };
    const allEffects = async () => {
      const tables = [
        ...database.registration.storageTarget.entities.map(receiptTable),
        ...[
          'semantic_operation_receipts',
          'trust_action_invocations',
          'trust_business_change_documents',
          'trust_domain_events',
          'trust_outbox',
        ].map((name) => `platform.${quoted(name)}`),
      ];
      return Object.fromEntries(
        await Promise.all(
          tables.map(async (name) => [
            name,
            (
              await database.adminPool.query(
                `SELECT row_to_json(t)::text AS row FROM ${name} t ORDER BY row_to_json(t)::text`,
              )
            ).rows,
          ]),
        ),
      );
    };
    const over = await staged('11');
    const beforeOver = await allEffects();
    await assert.rejects(
      () => service.postGoodsReceipt(database.context, database.actor, over),
      (error: unknown) => {
        assert.ok(error instanceof InventoryPostingError);
        assert.equal(error.code, 'RECEIPT_QUANTITY_OUT_OF_BOUNDS');
        assert.deepEqual(
          error.details,
          {
            orderLineId,
            orderedQuantity: '10',
            receivedBefore: '0',
            attemptedQuantity: '11',
          },
          'receipt refusal exposes all four quantity operands',
        );
        return true;
      },
      'over-receipt is refused before any write',
    );
    assert.deepEqual(
      await allEffects(),
      beforeOver,
      'refused receipt leaves every business and trust relation unchanged',
    );
    const futureDraft = await staged('1');
    const future = { ...futureDraft, effectiveAt: '2026-07-30T12:00:00.000Z' };
    await database.adminPool.query(
      `UPDATE ${receiptTable(binding.receipt)} SET ${quoted(receiptColumn(binding.receipt, 'goods_receipt_effective_at'))}=$2 WHERE record_id=$1`,
      [future.sourceId, future.effectiveAt],
    );
    const beforeFuture = await allEffects();
    await assert.rejects(
      () => service.postGoodsReceipt(database.context, database.actor, future),
      { code: 'RECEIPT_FORWARD_DATE_REFUSED' },
      'receipt default disallows the next tenant business day',
    );
    assert.deepEqual(await allEffects(), beforeFuture);
    const costDraft = await staged('1');
    const missingCost = {
      ...costDraft,
      lines: costDraft.lines.map((line) => ({
        ...line,
        costStatus: 'known' as const,
      })),
    };
    await database.adminPool.query(
      `UPDATE ${receiptTable(binding.line)} SET ${quoted(receiptColumn(binding.line, 'goods_receipt_line_cost_status'))}=$2 WHERE record_id=$1`,
      [
        missingCost.lines[0]!.receiptLineId,
        receiptOption(binding.line, 'goods_receipt_line_cost_status', 'known'),
      ],
    );
    const beforeCost = await allEffects();
    await assert.rejects(
      () =>
        service.postGoodsReceipt(database.context, database.actor, missingCost),
      { code: 'RECEIPT_COST_REQUIRED' },
      'known actual cost requires a value and currency',
    );
    assert.deepEqual(await allEffects(), beforeCost);
    const lateFailure = await staged('1');
    const beforeLateFailure = await allEffects();
    await database.adminPool.query(`CREATE SEQUENCE public.receipt_late_probe`);
    await database.adminPool.query(
      'GRANT USAGE ON SEQUENCE public.receipt_late_probe TO north_star_receipt_projection_writer',
    );
    await database.adminPool.query(
      `CREATE FUNCTION public.receipt_late_probe_fn() RETURNS trigger LANGUAGE plpgsql AS $probe$ BEGIN PERFORM nextval('public.receipt_late_probe'); NEW.${quoted(receiptColumn(binding.received, 'purchase_order_received_received_quantity'))}:=NEW.${quoted(receiptColumn(binding.received, 'purchase_order_received_received_quantity'))}+1; RETURN NEW; END $probe$`,
    );
    await database.adminPool.query(
      `CREATE TRIGGER receipt_late_probe BEFORE INSERT ON ${receiptTable(binding.received)} FOR EACH ROW EXECUTE FUNCTION public.receipt_late_probe_fn()`,
    );
    try {
      await assert.rejects(
        () =>
          service.postGoodsReceipt(
            database.context,
            database.actor,
            lateFailure,
          ),
        { code: 'RECEIPT_PROJECTION_DIVERGED' },
      );
      assert.equal(
        (
          await database.adminPool.query(
            'SELECT is_called FROM public.receipt_late_probe',
          )
        ).rows[0]!.is_called,
        true,
        'late control reached the received writer after movements and companions',
      );
      assert.deepEqual(
        await allEffects(),
        beforeLateFailure,
        'late received verification failure rolls back source, companions, movements, projection, idempotency and trust',
      );
    } finally {
      await database.adminPool.query(
        `DROP TRIGGER receipt_late_probe ON ${receiptTable(binding.received)}`,
      );
      await database.adminPool.query(
        'DROP FUNCTION public.receipt_late_probe_fn()',
      );
      await database.adminPool.query('DROP SEQUENCE public.receipt_late_probe');
    }
    const firstDraft = await staged('6');
    const first = {
      ...firstDraft,
      lines: firstDraft.lines.map((line) => ({
        ...line,
        costStatus: 'known' as const,
        unitCost: '7.25',
        currency: 'CAD',
      })),
    };
    await database.adminPool.query(
      `UPDATE ${receiptTable(binding.line)} SET ${quoted(receiptColumn(binding.line, 'goods_receipt_line_cost_status'))}=$2,${quoted(receiptColumn(binding.line, 'goods_receipt_line_unit_cost'))}=$3,${quoted(receiptColumn(binding.line, 'goods_receipt_line_currency'))}=$4 WHERE record_id=$1`,
      [
        first.lines[0]!.receiptLineId,
        receiptOption(binding.line, 'goods_receipt_line_cost_status', 'known'),
        '7.25',
        'CAD',
      ],
    );
    const posted = await service.postGoodsReceipt(
      database.context,
      database.actor,
      first,
    );
    assert.equal(Number(await received()), 6);
    await assert.rejects(
      () =>
        entry.run({ headers: {} }, (view) =>
          gateway.invoke(
            view,
            {
              schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
              operationId: 'northstar.app:operation.goods_receipt_line_update',
              input: {
                recordId: first.lines[0]!.receiptLineId,
                expectedRevision: 1,
                patch: {
                  'northstar.app:field.goods_receipt_line_unit_cost': '8',
                },
              },
              idempotencyKey: randomUUID(),
              confirmationGrant: null,
            },
            mediation.issueInvocation(view, 'UI'),
          ),
        ),
      { code: 'MODULE_OPERATION_PRECONDITION_REFUSED' },
      'posted actual unit cost and receipt attribution are not ordinarily editable',
    );
    const firstMovement = (
      await database.adminPool.query(
        `SELECT record_id FROM ${receiptTable(binding.movement)} WHERE ${quoted(receiptColumn(binding.movement, 'inventory_movement_source_id'))}=$1`,
        [first.sourceId],
      )
    ).rows[0]!.record_id as string;
    const belowZero = await staged('-7', locationPrimary, {
      original: first.sourceId,
      movement: firstMovement,
    });
    const beforeBelowZero = await allEffects();
    await assert.rejects(
      () =>
        service.postGoodsReceipt(database.context, database.actor, belowZero),
      { code: 'RECEIPT_QUANTITY_OUT_OF_BOUNDS' },
      'correction cannot reduce received below zero',
    );
    assert.deepEqual(
      await allEffects(),
      beforeBelowZero,
      'below-zero correction writes nothing',
    );
    assert.deepEqual(
      await service.postGoodsReceipt(database.context, database.actor, first),
      { ...posted, replayed: true },
      'same request replays exactly',
    );
    await assert.rejects(
      () =>
        service.postGoodsReceipt(database.context, database.actor, {
          ...first,
          reason: { ...first.reason, narrative: 'changed' },
        }),
      { code: 'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT' },
    );
    const races = await Promise.all([
      staged('3', locationPrimary),
      staged('3', locationTie),
    ]);
    const receiptBlocker = await database.adminPool.connect();
    await beginBoundedControlTransaction(receiptBlocker);
    await receiptBlocker.query(
      `SELECT record_id FROM ${receiptTable(binding.order)} WHERE record_id=$1 FOR NO KEY UPDATE`,
      [orderId],
    );
    const postingRace = Promise.allSettled(
      races.map((receipt) =>
        service.postGoodsReceipt(database.context, database.actor, receipt),
      ),
    );
    let outcomes: Awaited<typeof postingRace>;
    try {
      const parked = await waitForPostingLockWaiters(database.adminPool, 2);
      assert.equal(
        parked.length,
        2,
        'both distinct-location receipts reach the common order lock',
      );
      assert.ok(
        parked.every((row) =>
          row.query.includes(binding.order.physicalTableName),
        ),
        'both receiving writers are blocked on the common order, not stock identity',
      );
      await receiptBlocker.query('ROLLBACK');
      outcomes = await postingRace;
    } finally {
      await receiptBlocker.query('ROLLBACK');
      await postingRace;
      receiptBlocker.release();
    }
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
      'order-line lock serializes distinct stock locations',
    );
    assert.equal(Number(await received()), 9);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.equal(
      refused?.status === 'rejected' && refused.reason.code,
      'RECEIPT_QUANTITY_OUT_OF_BOUNDS',
    );
    const original = await database.adminPool.query(
      `SELECT record_id FROM ${receiptTable(binding.movement)} WHERE ${quoted(receiptColumn(binding.movement, 'inventory_movement_source_id'))}=$1`,
      [first.sourceId],
    );
    const correction = await staged('-2', locationPrimary, {
      original: first.sourceId,
      movement: String(original.rows[0]!.record_id),
    });
    const businessAndAcceptedEffects = async () =>
      Object.fromEntries(
        Object.entries(await allEffects()).filter(
          ([table]) => table !== 'platform."trust_action_invocations"',
        ),
      );
    const beforeTampering = await businessAndAcceptedEffects();
    const tampering: readonly ((
      request: RegisteredCapabilityOperationExecutionRequest,
    ) => RegisteredCapabilityOperationExecutionRequest)[] = [
      (request) => ({ ...request, inputDigest: 'different-input-digest' }),
      (request) => ({ ...request, definition: { ...request.definition } }),
      (request) => ({
        ...request,
        readBackDefinition: { ...request.readBackDefinition },
      }),
      (request) => ({ ...request, view: { ...request.view } }),
      (request) => ({ ...request, context: { ...request.context } }),
      (request) => ({
        ...request,
        input: { recordId: correction.sourceId, expectedRevision: 1 },
      }),
      (request) => ({
        ...request,
        authorization: { ...request.authorization },
      }),
    ];
    try {
      for (const tamper of tampering) {
        tamperReceivingExecution = tamper;
        await assert.rejects(
          invoke('goods_receipt_post', correction.sourceId, 1),
          { code: 'INVENTORY_POSTING_INPUT_INVALID' },
          'preparation is bound to exact definitions, view, context, input and opaque authorization',
        );
        assert.deepEqual(await businessAndAcceptedEffects(), beforeTampering);
      }
    } finally {
      tamperReceivingExecution = undefined;
    }
    const corrected = await invoke(
      'goods_receipt_post',
      correction.sourceId,
      1,
    );
    assert.equal(
      corrected.outcome,
      'succeeded',
      'receipt correction uses the real operation gateway and registered executor',
    );
    assert.equal(Number(await received()), 7);
    await entry.run({ headers: {} }, async (view) => {
      const order = await queryGateway.invoke(view, {
        schemaVersion: 'northstar.semantic-query-request/v1',
        queryId: 'northstar.app:query.purchase_order_get',
        arguments: {
          recordId: orderId,
          'northstar.app:parameter.purchase_order_get_legal_entity_scope':
            legalReject,
        },
      });
      assert.ok(order.records[0]);
      const progress = await loadReceivingSection(
        view,
        queryGateway,
        order.records[0],
        legalReject,
      );
      assert.deepEqual(
        progress.lines.map((row) => [row.ordered, row.received, row.remaining]),
        [['10', '7', '3']],
      );
    });
    const orderPage = await entry.run({ headers: {} }, (view) =>
      renderSurfaceRuntimeWithData(
        view,
        `/?${new URLSearchParams({ surface: 'northstar.app:surface.purchase_order_detail', record: orderId, 'northstar.app:parameter.commercial_purchase_order_get_legal_entity_scope': legalReject, dataset: 'northstar.app:dataset.purchasing_lines', selected: orderLineId, 'select:northstar.app:dataset.purchasing_lines': orderLineId })}`,
        {
          applicationExtension: RECEIVING_SURFACE_RUNTIME_EXTENSION,
          queryGateway,
          operationGateway: gateway,
          operationMediation: mediation,
        },
      ),
    );
    assert.equal(orderPage.statusCode, 200);
    assert.match(
      orderPage.html,
      /data-composition-dataset="northstar\.app:dataset\.purchasing_lines"/u,
      'purchase order exposes its lines in the actual Record surface',
    );
    assert.match(
      orderPage.html,
      /<td[^>]*data-column-label="Ordered"[^>]*>10<\/td>/u,
      'the selected order line retains its exact ordered quantity',
    );
    assert.match(orderPage.html, /Receive with actual cost/u);
    assert.match(orderPage.html, /Receive with cost explicitly absent/u);
    assert.match(orderPage.html, /Connected receipts/u);
    const originalAfter = await database.adminPool.query(
      `SELECT ${quoted(receiptColumn(binding.receipt, 'goods_receipt_state'))} AS state FROM ${receiptTable(binding.receipt)} WHERE record_id=$1`,
      [first.sourceId],
    );
    assert.equal(
      originalAfter.rows[0]!.state,
      receiptOption(binding.receipt, 'goods_receipt_state', 'posted'),
    );
    const immutableBefore = (
      await database.adminPool.query(
        `SELECT * FROM ${receiptTable(binding.movement)} ORDER BY record_id`,
      )
    ).rows;
    await assert.rejects(
      () =>
        withModuleRole(database.runtimePool, database.context, (client) =>
          changePurchaseOrderState(
            client,
            binding,
            database.context,
            legalReject,
            orderId,
            1,
            'close',
          ),
        ),
      { code: 'RECEIPT_QUANTITY_OUT_OF_BOUNDS' },
    );
    await assert.rejects(
      () =>
        withModuleRole(database.runtimePool, database.context, (client) =>
          amendOrderedQuantity(
            client,
            binding,
            database.context,
            legalReject,
            orderLineId,
            1,
            '6',
          ),
        ),
      { code: 'RECEIPT_QUANTITY_OUT_OF_BOUNDS' },
    );
    const progressBeforeAmendment = (
      await database.adminPool.query(
        `SELECT * FROM ${receiptTable(binding.received)} ORDER BY record_id`,
      )
    ).rows;
    const amendmentEntity = binding.target.entities.find((row) =>
      row.entityId.endsWith(':entity.purchase_order_amendment'),
    )!;
    const amendmentId = randomUUID();
    await insert(
      amendmentEntity,
      amendmentId,
      {
        'field.purchase_order_amendment_number': 'AMEND-RECEIPT',
        'field.purchase_order_amendment_line_revision': 1,
        'field.purchase_order_amendment_quantity': '7',
        'field.purchase_order_amendment_reason':
          'Correct ordered intent to actual agreed quantity',
      },
      { purchase_order_amendment_order_line: orderLineId },
    );
    assert.equal(
      (await invoke('purchase_order_line_amend', orderLineId, 1)).outcome,
      'succeeded',
      'amendment runs through the registered gateway with staged intent',
    );
    assert.notEqual(
      (
        await database.adminPool.query(
          `SELECT archived_at FROM ${receiptTable(amendmentEntity)} WHERE record_id=$1`,
          [amendmentId],
        )
      ).rows[0]!.archived_at,
      null,
      'applied amendment request is retained and consumed',
    );
    assert.equal(
      Number(await received()),
      7,
      'amendment changes intent, not receipts',
    );
    assert.deepEqual(
      (
        await database.adminPool.query(
          `SELECT * FROM ${receiptTable(binding.received)} ORDER BY record_id`,
        )
      ).rows,
      progressBeforeAmendment,
      'amendment leaves received row bytes and revision unchanged',
    );
    assert.equal(
      (await invoke('purchase_order_close', orderId, 1)).outcome,
      'succeeded',
    );
    await assert.rejects(
      () =>
        withModuleRole(database.runtimePool, database.context, (client) =>
          amendOrderedQuantity(
            client,
            binding,
            database.context,
            legalReject,
            orderLineId,
            2,
            '8',
          ),
        ),
      { code: 'RECEIPT_ORDER_NOT_RELEASED' },
    );
    const closedCorrection = await staged('-1', locationPrimary, {
      original: first.sourceId,
      movement: String(original.rows[0]!.record_id),
    });
    await assert.rejects(
      () =>
        service.postGoodsReceipt(
          database.context,
          database.actor,
          closedCorrection,
        ),
      { code: 'RECEIPT_ORDER_NOT_RELEASED' },
    );
    assert.equal(
      (await invoke('purchase_order_reopen', orderId, 2)).outcome,
      'succeeded',
    );
    assert.deepEqual(
      (
        await database.adminPool.query(
          `SELECT * FROM ${receiptTable(binding.movement)} ORDER BY record_id`,
        )
      ).rows,
      immutableBefore,
      'closing, reopening and quantity amendments leave receipt facts unchanged',
    );
    await database.adminPool.query(
      `UPDATE ${receiptTable(binding.received)} SET ${quoted(receiptColumn(binding.received, 'purchase_order_received_received_quantity'))}=999 WHERE record_id=$1`,
      [receivedIdentity(database.context, legalReject, orderLineId)],
    );
    const comparison = await withModuleRole(
      database.runtimePool,
      database.context,
      (client) =>
        reconcileReceivedQuantities(client, binding, database.context),
    );
    assert.equal(
      comparison.discrepancies.length,
      1,
      'received corruption produces one observed discrepancy',
    );
    assert.equal(comparison.repaired, 0);
    const reconciler = new PostgresInventoryReconciliationService(
      database.runtimePool,
      {
        storageTarget: database.registration.storageTarget,
        aggregateQueryId: 'northstar.app:query.inventory_movement_on_hand',
        aggregateParameterIds: {
          atTime: 'northstar.app:parameter.on_hand_at_time',
          recordedAtHorizon:
            'northstar.app:parameter.on_hand_recorded_at_horizon',
          itemId: 'northstar.app:parameter.on_hand_item_id',
          locationId: 'northstar.app:parameter.on_hand_location_id',
          legalEntityId: 'northstar.app:parameter.on_hand_legal_entity_id',
        },
      },
    );
    const report = await reconciler.reconcile(database.context, {
      legalEntityIds: [legalReject],
      scopeId: 'receipt-corruption-control',
    });
    assert.equal(report.transactionReadOnly, 'on');
    assert.equal(report.repairedSubjectCount, 0);
    assert.ok(
      report.findings.some(
        (finding) =>
          finding.code === 'RECEIVED_QUANTITY_LEDGER_DIVERGED' &&
          finding.subjectId ===
            JSON.stringify([
              tenantId,
              environmentId,
              legalReject,
              receivedIdentity(database.context, legalReject, orderLineId),
            ]),
      ),
      'read-only reconciliation reports the corrupt received subject',
    );
    assert.equal(
      Number(await received()),
      999,
      'received reconciliation does not heal',
    );
    const materializerPool = new pg.Pool({
      ...database.connection,
      user: 'north_star_module_materializer',
    });
    const modulePool = new pg.Pool({
      ...database.connection,
      user: 'north_star_module_runtime',
    });
    try {
      assert.equal(
        await new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        ).rebuildReceivedQuantities(database.context),
        1,
      );
      assert.deepEqual(
        (
          await database.adminPool.query(
            `SELECT record_id FROM ${receiptTable(binding.received)} WHERE archived_at IS NULL ORDER BY record_id`,
          )
        ).rows,
        progressBeforeAmendment.map((row) => ({ record_id: row.record_id })),
        'rebuild preserves the original deterministic received identity',
      );
      assert.equal(
        Number(await received()),
        7,
        'rebuild reproduces received from persisted movement attribution',
      );
      assert.equal(
        (
          await withModuleRole(
            database.runtimePool,
            database.context,
            (client) =>
              reconcileReceivedQuantities(client, binding, database.context),
          )
        ).discrepancies.length,
        0,
        'independent verifier accepts the separately reconstructed projection',
      );
      assert.deepEqual(
        (
          await database.adminPool.query(
            `SELECT * FROM ${receiptTable(binding.movement)} ORDER BY record_id`,
          )
        ).rows,
        immutableBefore,
      );
      const identitiesBefore = (
        await database.adminPool.query(
          `SELECT record_id,legal_entity_id,${quoted(receiptRelation(binding, binding.received, 'purchase_order_received_order_line'))},${quoted(receiptColumn(binding.received, 'purchase_order_received_received_quantity'))},${quoted(receiptColumn(binding.received, 'purchase_order_received_unit_id'))} FROM ${receiptTable(binding.received)} WHERE archived_at IS NULL ORDER BY record_id`,
        )
      ).rows;
      await database.adminPool.query(
        `UPDATE ${receiptTable(binding.received)} SET archived_at=transaction_timestamp()`,
      );
      await new PostgresModuleStorageMaterializer(
        materializerPool,
        modulePool,
      ).rebuildReceivedQuantities(database.context);
      assert.deepEqual(
        (
          await database.adminPool.query(
            `SELECT record_id,legal_entity_id,${quoted(receiptRelation(binding, binding.received, 'purchase_order_received_order_line'))},${quoted(receiptColumn(binding.received, 'purchase_order_received_received_quantity'))},${quoted(receiptColumn(binding.received, 'purchase_order_received_unit_id'))} FROM ${receiptTable(binding.received)} WHERE archived_at IS NULL ORDER BY record_id`,
          )
        ).rows,
        identitiesBefore,
        'rebuild from empty active projection preserves identities and quantities',
      );
      const reversalDraft = await staged('-4', locationPrimary, {
        original: first.sourceId,
        movement: firstMovement,
      });
      await database.adminPool.query(
        `UPDATE ${receiptTable(binding.receipt)} SET ${quoted(receiptColumn(binding.receipt, 'goods_receipt_kind'))}=$2 WHERE record_id=$1`,
        [
          reversalDraft.sourceId,
          receiptOption(binding.receipt, 'goods_receipt_kind', 'reversal'),
        ],
      );
      assert.equal(
        (await invoke('goods_receipt_post', reversalDraft.sourceId, 1)).outcome,
        'succeeded',
        'reversal compensates the remaining original quantity after partial correction',
      );
      assert.equal(Number(await received()), 3);
      assert.deepEqual(
        (
          await database.adminPool.query(
            `SELECT * FROM ${receiptTable(binding.movement)} WHERE record_id=ANY($1::uuid[]) ORDER BY record_id`,
            [immutableBefore.map((row) => row.record_id)],
          )
        ).rows,
        immutableBefore,
        'reversal preserves every previous movement byte',
      );

      const scopedRecordId = receivedIdentity(
        database.context,
        legalReject,
        orderLineId,
      );
      const corruptionClient = await database.adminPool.connect();
      try {
        await corruptionClient.query('SET session_replication_role=replica');
        await corruptionClient.query(
          `INSERT INTO ${receiptTable(binding.received)}
            (tenant_id,environment_id,${quoted(binding.received.legalEntity!.column)},record_id,revision,archived_at,
             ${quoted(receiptRelation(binding, binding.received, 'purchase_order_received_order_line'))},
             ${quoted(receiptColumn(binding.received, 'purchase_order_received_received_quantity'))},
             ${quoted(receiptColumn(binding.received, 'purchase_order_received_unit_id'))})
           VALUES ($1,$2,$3,$4,1,NULL,$5,999,'EA')`,
          [tenantId, environmentId, legalFlag, scopedRecordId, orderLineId],
        );
      } finally {
        await corruptionClient.query('SET session_replication_role=origin');
        corruptionClient.release();
      }
      const entityBRow = async () =>
        (
          await database.adminPool.query(
            `SELECT * FROM ${receiptTable(binding.received)} WHERE tenant_id=$1 AND environment_id=$2 AND ${quoted(binding.received.legalEntity!.column)}=$3 AND record_id=$4`,
            [tenantId, environmentId, legalFlag, scopedRecordId],
          )
        ).rows[0] as Record<string, unknown>;
      const entityBBefore = await entityBRow();
      const broadComparison = await withModuleRole(
        database.runtimePool,
        database.context,
        (client) =>
          reconcileReceivedQuantities(client, binding, database.context),
      );
      assert.deepEqual(
        broadComparison.discrepancies.map((entry) => [
          entry.subjectIdentity,
          entry.recomputed,
        ]),
        [[[tenantId, environmentId, legalFlag, scopedRecordId], null]],
        'broad comparison preserves the unexpected entity-B scope despite the shared record id',
      );
      assert.equal(broadComparison.repaired, 0);
      const scopedReport = await reconciler.reconcile(database.context, {
        legalEntityIds: [legalReject, legalFlag],
        scopeId: 'same-id-cross-entity-corruption',
      });
      assert.equal(scopedReport.transactionReadOnly, 'on');
      assert.equal(scopedReport.repairedSubjectCount, 0);
      assert.ok(
        scopedReport.findings.some(
          (finding) =>
            finding.code === 'RECEIVED_QUANTITY_LEDGER_DIVERGED' &&
            finding.subjectId ===
              JSON.stringify([
                tenantId,
                environmentId,
                legalFlag,
                scopedRecordId,
              ]),
        ),
        'operator reconciliation names the complete unexpected entity-B identity',
      );
      assert.deepEqual(
        await entityBRow(),
        entityBBefore,
        'read-only scoped reconciliation leaves the malformed row unchanged',
      );

      const scopedRebuild = async (legalEntityIds: readonly string[]) => {
        const client = await materializerPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `SELECT set_config('north_star.tenant_id',$1,true),
                    set_config('north_star.environment_id',$2,true)`,
            [tenantId, environmentId],
          );
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            [aggregateGenerationLockKey(tenantId, environmentId)],
          );
          const count = await rebuildReceivedQuantitiesOnClient(
            client,
            database.registration.storageTarget,
            { ...database.context, legalEntityIds },
          );
          await client.query('COMMIT');
          return count;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };
      const scopedDiscrepancyCount = async () =>
        Number(
          (
            await database.adminPool.query(
              `SELECT count(*)::integer AS count
                 FROM north_star_internal.inventory_projection_discrepancies
                WHERE tenant_id=$1 AND environment_id=$2
                  AND projection_entity_id=$3
                  AND subject_identity=$4::jsonb`,
              [
                tenantId,
                environmentId,
                binding.received.entityId,
                JSON.stringify([
                  tenantId,
                  environmentId,
                  legalFlag,
                  scopedRecordId,
                ]),
              ],
            )
          ).rows[0]!.count,
        );
      const discrepanciesBeforeScopedRebuild = await scopedDiscrepancyCount();
      assert.equal(await scopedRebuild([legalReject]), 1);
      assert.deepEqual(
        await entityBRow(),
        entityBBefore,
        'an entity-A-only rebuild leaves the same-id entity-B row byte-for-byte unchanged',
      );
      assert.equal(
        await scopedDiscrepancyCount(),
        discrepanciesBeforeScopedRebuild,
        'an A-only rebuild neither repairs nor captures out-of-scope B',
      );

      assert.equal(
        await new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        ).rebuildReceivedQuantities(database.context),
        1,
      );
      assert.equal(
        await scopedDiscrepancyCount(),
        discrepanciesBeforeScopedRebuild + 1,
        'broad rebuild captures the fully scoped unexpected row before repair',
      );
      const capturedEntityB = (
        await database.adminPool.query(
          `SELECT subject_identity,stored_row,recomputed_row
             FROM north_star_internal.inventory_projection_discrepancies
            WHERE tenant_id=$1 AND environment_id=$2
              AND projection_entity_id=$3
              AND subject_identity=$4::jsonb
            ORDER BY detected_at DESC,discrepancy_id DESC LIMIT 1`,
          [
            tenantId,
            environmentId,
            binding.received.entityId,
            JSON.stringify([
              tenantId,
              environmentId,
              legalFlag,
              scopedRecordId,
            ]),
          ],
        )
      ).rows[0]!;
      assert.deepEqual(capturedEntityB.subject_identity, [
        tenantId,
        environmentId,
        legalFlag,
        scopedRecordId,
      ]);
      assert.equal(capturedEntityB.stored_row.legal_entity_id, legalFlag);
      assert.equal(capturedEntityB.recomputed_row, null);
      assert.notEqual(
        (await entityBRow()).archived_at,
        null,
        'broad rebuild retires rather than deletes the captured malformed row',
      );
    } finally {
      await materializerPool.end();
      await modulePool.end();
    }
  });
});

async function compiledFixture(): Promise<PostingFixture> {
  fixturePromise ??= buildFixture();
  return fixturePromise;
}

async function buildFixture(): Promise<PostingFixture> {
  const inventoryDefinition = await loadInventoryDefinition();
  const emptyDefinition = emptyDefinitionFrom(inventoryDefinition);
  const empty = mustCompile(moduleInput(emptyDefinition));
  const inventory = mustCompile(
    moduleInput(inventoryDefinition, expectedActiveReleaseFrom(empty)),
  );
  const storage = projectionPayload<StorageTargetPayloadV1>(
    inventory,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  return {
    empty,
    emptyDefinition,
    inventory,
    inventoryDefinition,
    storage: storage.payload,
    storageContentHash: storage.contentHash,
  };
}

async function withPostingDatabase(
  run: (database: PostingDatabase) => Promise<void>,
): Promise<void> {
  const fixture = await compiledFixture();
  const binding = testStorageBinding(fixture.storage);
  await withEphemeralPostgres('inventory-posting', async (database) => {
    await migrateAndProvision(database.pool, fixture.inventory.releaseRoot);
    const runtimePool = new pg.Pool({
      ...database.connection,
      application_name: postingApplicationName,
      max: 8,
      user: 'north_star_runtime',
    });
    const materializerPool = new pg.Pool({
      ...database.connection,
      max: 1,
      user: 'north_star_module_materializer',
    });
    const moduleRuntimePool = new pg.Pool({
      ...database.connection,
      max: 1,
      user: 'north_star_module_runtime',
    });
    try {
      const context = await trustedContext();
      const releases = await persistSequence(runtimePool, context, [
        [fixture.empty, fixture.emptyDefinition],
        [fixture.inventory, fixture.inventoryDefinition],
      ]);
      const sourceReleaseId = releases[0]!;
      const targetReleaseId = releases[1]!;
      await setPointer(database.pool, sourceReleaseId);
      await grantExecutorAuthority(database.pool);
      const materializer = new PostgresModuleStorageMaterializer(
        materializerPool,
        moduleRuntimePool,
      );
      const prepared = await materializer.prepare({
        context,
        expiresAt: '2099-01-01T00:00:00.000Z',
        generationId: randomUUID(),
        initiatedBy: principalId,
        preparationId: randomUUID(),
        targetReleaseId,
      });
      assert.equal(prepared.schemaState, 'APPLIED');
      await setPointer(database.pool, targetReleaseId);
      await seedManagedFoundation(runtimePool, context, binding);
      const actor = await actorEnvelope(context, null);
      const approvedActor = await actorEnvelope(context, approvingHumanId);
      const registration: InventoryPostingRegistrationV1 = {
        capabilityId: postingCapabilityId,
        capabilityVersion: INVENTORY_POSTING_CAPABILITY_VERSION,
        dependencySetRoot: DECLARED_POSTING_DEPENDENCY_SET_ROOT,
        releaseContentHash: fixture.inventory.releaseRoot,
        releaseId: targetReleaseId,
        storageTarget: fixture.storage,
        storageTargetContentHash: fixture.storageContentHash,
      };
      assert.equal(
        DECLARED_POSTING_DEPENDENCY_SET_ROOT,
        INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
      );
      const service = new PostgresInventoryPostingService(
        runtimePool,
        registration,
        { currentInstant: () => recordedAt },
      );
      await run({
        actor,
        adminPool: database.pool,
        approvedActor,
        binding,
        connection: database.connection,
        context,
        registration,
        runtimePool,
        service,
      });
    } finally {
      await Promise.all([
        runtimePool.end(),
        materializerPool.end(),
        moduleRuntimePool.end(),
      ]);
    }
  });
}

async function migrateAndProvision(
  pool: Pool,
  contractReleaseRoot: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    const loaded = await loadMigrations(migrations);
    await runMigrations(client, loaded);
    await client.query(
      'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
      [tenantId, 'inventory-posting'],
    );
    await client.query(
      `INSERT INTO platform.environments (tenant_id, id, slug)
       VALUES ($1,$2,'production')`,
      [tenantId, environmentId],
    );
    for (const provision of [
      { id: legalReject, mode: 'reject', threshold: null },
      { id: legalFlag, mode: 'allowWithFlag', threshold: null },
      { id: legalAllow, mode: 'allow', threshold: null },
      { id: legalApproval, mode: 'reject', threshold: '1' },
    ] as const) {
      await client.query(
        `SELECT platform.provision_inventory_scope(
           $1,$2,$3,$4,$5,'UTC','00:00:00',$6,1::smallint,$7,0,
           'codeAndNarrative','codeOnly','codeAndNarrative',
           'codeAndNarrative','codeAndNarrative',$8,NULL,NULL,NULL,NULL
         )`,
        [
          tenantId,
          environmentId,
          provision.id,
          `LE-${provision.id.at(-1)}`,
          `Legal entity ${provision.id.at(-1)}`,
          contractReleaseRoot,
          provision.mode,
          provision.threshold,
        ],
      );
    }
  } finally {
    client.release();
  }
}

async function seedManagedFoundation(
  pool: Pool,
  context: TrustedRequestContext,
  binding: TestStorageBinding,
): Promise<void> {
  await withModuleRole(pool, context, async (client) => {
    for (const [index, legalEntityId] of [
      legalReject,
      legalFlag,
      legalAllow,
      legalApproval,
    ].entries()) {
      const present = await client.query(
        `SELECT 1 FROM ${table(binding, binding.legalEntity)}
          WHERE tenant_id=$1 AND environment_id=$2
            AND ${quoted(binding.legalEntity.recordIdColumn)}=$3`,
        [tenantId, environmentId, legalEntityId],
      );
      if (present.rowCount === 0) {
        await insertEntity(
          client,
          binding,
          binding.legalEntity,
          {
            legal_entity_code: `LE-${String(index + 1)}`,
            legal_entity_is_default: false,
            legal_entity_name: `Legal entity ${String(index + 1)}`,
            legal_entity_status: enumOption(
              field(binding.legalEntity, 'legal_entity_status'),
              'active',
            ),
          },
          legalEntityId,
          null,
          {},
        );
      }
    }
    await insertEntity(
      client,
      binding,
      binding.item,
      {
        item_base_unit: 'EA',
        item_code: 'ITEM-POST',
        item_name: 'Posting item',
      },
      itemId,
      null,
      {},
    );
    await insertEntity(
      client,
      binding,
      binding.item,
      {
        item_base_unit: 'EA',
        item_code: 'ITEM-TRANSFER',
        item_name: 'Transfer posting item',
      },
      transferItemId,
      null,
      {},
    );
    await insertEntity(
      client,
      binding,
      binding.item,
      {
        item_base_unit: 'EA',
        item_code: 'ITEM-ORDER-DECISIVE',
        item_name: 'Order-decisive posting item',
      },
      orderDecisiveItemId,
      null,
      {},
    );
    for (const [index, locationId] of [
      locationPrimary,
      locationTie,
      locationRace,
      transferLocationA,
      transferLocationB,
    ].entries()) {
      await insertEntity(
        client,
        binding,
        binding.location,
        {
          location_code: `LOC-${String(index + 1)}`,
          location_name: `Location ${String(index + 1)}`,
        },
        locationId,
        null,
        {},
      );
    }
  });
}

async function seedDraft(
  database: PostingDatabase,
  input: InventoryAdjustmentPostingCommandV1,
): Promise<void> {
  await withModuleRole(
    database.runtimePool,
    database.context,
    async (client) => {
      await insertEntity(
        client,
        database.binding,
        database.binding.transaction,
        {
          inventory_transaction_actor_id: principalId,
          inventory_transaction_effective_at: input.effectiveAt,
          inventory_transaction_number: `ADJ-${input.transactionId.slice(0, 12)}`,
          inventory_transaction_reason_code: input.reason.code || null,
          inventory_transaction_reason_narrative: input.reason.narrative,
          inventory_transaction_recorded_at: recordedAt,
          inventory_transaction_source_id: input.sourceId,
          inventory_transaction_source_type: input.sourceType,
          inventory_transaction_state: enumOption(
            field(database.binding.transaction, 'inventory_transaction_state'),
            'draft',
          ),
          inventory_transaction_type: enumOption(
            field(database.binding.transaction, 'inventory_transaction_type'),
            'adjustment',
          ),
        },
        input.transactionId,
        input.legalEntityId,
        {},
      );
      for (const postingLine of input.lines) {
        await insertDraftLine(client, database, input, postingLine);
      }
    },
  );
}

async function seedTransferDraft(
  database: PostingDatabase,
  input: InventoryTransferPostingCommandV1,
): Promise<void> {
  await withModuleRole(
    database.runtimePool,
    database.context,
    async (client) => {
      await insertEntity(
        client,
        database.binding,
        database.binding.transaction,
        {
          inventory_transaction_actor_id: principalId,
          inventory_transaction_effective_at: input.effectiveAt,
          inventory_transaction_number: `TRF-${input.transactionId.slice(0, 12)}`,
          inventory_transaction_reason_code: input.reason.code || null,
          inventory_transaction_reason_narrative: input.reason.narrative,
          inventory_transaction_recorded_at: recordedAt,
          inventory_transaction_source_id: input.sourceId,
          inventory_transaction_source_type: input.sourceType,
          inventory_transaction_state: enumOption(
            field(database.binding.transaction, 'inventory_transaction_state'),
            'draft',
          ),
          inventory_transaction_type: enumOption(
            field(database.binding.transaction, 'inventory_transaction_type'),
            'transfer',
          ),
        },
        input.transactionId,
        input.legalEntityId,
        {},
      );
      for (const postingLine of input.lines) {
        await insertTransferDraftLine(client, database, input, postingLine);
      }
    },
  );
}

async function insertTransferDraftLine(
  client: PoolClient,
  database: PostingDatabase,
  input: InventoryTransferPostingCommandV1,
  postingLine: InventoryTransferLineV1,
): Promise<void> {
  const prepared = prepareEntityInsert(
    database.binding,
    database.binding.transactionLine,
    {
      inventory_transaction_line_from_location_id: postingLine.fromLocationId,
      inventory_transaction_line_item_id: postingLine.itemId,
      inventory_transaction_line_line_number: Number(postingLine.sourceLine),
      inventory_transaction_line_quantity: postingLine.quantity,
      inventory_transaction_line_to_location_id: postingLine.toLocationId,
      inventory_transaction_line_unit_id: postingLine.unitId,
    },
    postingLine.transactionLineId,
    input.legalEntityId,
    {
      [database.binding.transaction.entity.entityId]: input.transactionId,
    },
  );
  await client.query(prepared.text, prepared.values);
}

async function insertDraftLine(
  client: PoolClient,
  database: PostingDatabase,
  input: InventoryAdjustmentPostingCommandV1,
  postingLine: InventoryAdjustmentLineV1,
): Promise<void> {
  const prepared = prepareDraftLineInsert(database, input, postingLine);
  await client.query(prepared.text, prepared.values);
}

function prepareDraftLineInsert(
  database: PostingDatabase,
  input: InventoryAdjustmentPostingCommandV1,
  postingLine: InventoryAdjustmentLineV1,
): { text: string; values: unknown[] } {
  const negative = postingLine.quantityDelta.startsWith('-');
  return prepareEntityInsert(
    database.binding,
    database.binding.transactionLine,
    {
      inventory_transaction_line_from_location_id: negative
        ? postingLine.locationId
        : null,
      inventory_transaction_line_item_id: postingLine.itemId,
      inventory_transaction_line_line_number: Number(postingLine.sourceLine),
      inventory_transaction_line_quantity: postingLine.quantityDelta,
      inventory_transaction_line_to_location_id: negative
        ? null
        : postingLine.locationId,
      inventory_transaction_line_unit_id: postingLine.unitId,
    },
    postingLine.transactionLineId,
    input.legalEntityId,
    {
      [database.binding.transaction.entity.entityId]: input.transactionId,
    },
  );
}

async function insertEntity(
  client: PoolClient,
  binding: TestStorageBinding,
  entity: TestEntityBinding,
  overrides: Record<string, unknown>,
  recordId: string,
  legalEntityId: string | null,
  relationIds: Record<string, string>,
  factBusinessPeriod: string | null = null,
): Promise<void> {
  const prepared = prepareEntityInsert(
    binding,
    entity,
    overrides,
    recordId,
    legalEntityId,
    relationIds,
    factBusinessPeriod,
  );
  await client.query(prepared.text, prepared.values);
}

function prepareEntityInsert(
  binding: TestStorageBinding,
  entity: TestEntityBinding,
  overrides: Record<string, unknown>,
  recordId: string,
  legalEntityId: string | null,
  relationIds: Record<string, string>,
  factBusinessPeriod: string | null = null,
): { text: string; values: unknown[] } {
  const relationColumns = bindingRelations(binding, entity).filter(
    (relation) => relation.relationColumn.origin !== 'field',
  );
  const businessPeriodColumn = entity.entity.factStorage?.businessPeriod.column;
  if (businessPeriodColumn) {
    assert.ok(factBusinessPeriod, `missing business period for ${recordId}`);
  }
  const columns = [
    'tenant_id',
    'environment_id',
    ...(entity.legalEntityColumn ? [entity.legalEntityColumn] : []),
    ...(businessPeriodColumn ? [businessPeriodColumn] : []),
    entity.recordIdColumn,
    ...entity.entity.columns.map((column) => column.physicalName),
    ...relationColumns.map((relation) => relation.relationColumn.physicalName),
  ];
  const values = [
    tenantId,
    environmentId,
    ...(entity.legalEntityColumn ? [legalEntityId] : []),
    ...(businessPeriodColumn ? [factBusinessPeriod] : []),
    recordId,
    ...entity.entity.columns.map((column) =>
      Object.hasOwn(overrides, localField(column))
        ? overrides[localField(column)]
        : defaultFieldValue(column, recordId),
    ),
    ...relationColumns.map((relation) => {
      const value = relationIds[relation.targetEntityId];
      assert.ok(value, `missing relation ${relation.relationId}`);
      return value;
    }),
  ];
  return {
    text: `INSERT INTO ${table(binding, entity)} (${columns.map(quoted).join(',')})
     VALUES (${values.map((_, index) => `$${String(index + 1)}`).join(',')})`,
    values,
  };
}

function bindingRelations(
  binding: TestStorageBinding,
  entity: TestEntityBinding,
) {
  return binding.storageTarget.relations.filter(
    (relation) => relation.sourceEntityId === entity.entity.entityId,
  );
}

function testStorageBinding(
  target: StorageTargetPayloadV1,
): TestStorageBinding {
  const bind = (suffix: string): TestEntityBinding => {
    const entity = target.entities.find((candidate) =>
      candidate.entityId.endsWith(`:entity.${suffix}`),
    );
    assert.ok(entity, `missing ${suffix}`);
    const fields = new Map(
      entity.columns.map((column) => [localField(column), column]),
    );
    const bound = {
      archiveColumn: entity.archive.archivedAtColumn,
      entity,
      fields,
      legalEntityColumn: entity.legalEntity?.column ?? null,
      recordIdColumn: entity.recordIdentity.column,
      revisionColumn: entity.optimisticRevision.column,
      tableName: entity.physicalTableName,
    };
    return bound;
  };
  const item = bind('item');
  const movement = bind('inventory_movement');
  const factStorage = movement.entity.factStorage;
  assert.ok(factStorage);
  const companionMovementIdIndex =
    factStorage.companion.movementForeignKey.targetColumns.indexOf(
      movement.recordIdColumn,
    );
  assert.notEqual(companionMovementIdIndex, -1);
  const companionMovementIdColumn =
    factStorage.companion.movementForeignKey.sourceColumns[
      companionMovementIdIndex
    ];
  assert.ok(companionMovementIdColumn);
  const periodLock = bind('inventory_period_lock');
  assert.ok(periodLock.entity.periodLock);
  return {
    companionMovementIdColumn,
    companionTableName: factStorage.companion.physicalTableName,
    item,
    legalEntity: bind('legal_entity'),
    location: bind('location'),
    movement,
    periodLock,
    periodLockClosedThroughColumn:
      periodLock.entity.periodLock.closedThroughColumn,
    schemaName: target.providerAbi.managedSchema,
    storageTarget: target,
    transaction: bind('inventory_transaction'),
    transactionLine: bind('inventory_transaction_line'),
  };
}

function defaultFieldValue(
  column: StorageEntityTarget['columns'][number],
  recordId: string,
): unknown {
  if (!column.fieldContract.required) return null;
  switch (column.fieldContract.fieldKind) {
    case 'booleanFieldType':
      return false;
    case 'dateFieldType':
      return '2026-07-29';
    case 'dateTimeFieldType':
      return recordedAt;
    case 'enumFieldType':
      return (
        column.fieldContract.enumOptionIds.find((option) =>
          option.endsWith('_active'),
        ) ?? column.fieldContract.enumOptionIds[0]
      );
    case 'exactDecimalFieldType':
    case 'moneyFieldType':
    case 'quantityFieldType':
      return '1';
    case 'integerFieldType':
      return 1;
    case 'textFieldType': {
      const maximum = column.fieldContract.bounds.maximumLength ?? 80;
      return `${localField(column)}-${recordId.slice(0, 8)}`.slice(0, maximum);
    }
    case 'timeFieldType':
      return '00:00:00';
  }
}

async function assertBaseUnitBound(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  const movements = await bindingMovementsForItem(database, itemId);
  assert.ok(movements.length > 0, `no binding movement for item ${itemId}`);
  const expectedBinding = movements.toSorted(compareBindingMovements)[0]!;
  await assert.rejects(
    withModuleRole(database.runtimePool, database.context, async (client) => {
      await client.query(
        `UPDATE ${table(database.binding, database.binding.item)}
            SET ${quoted(field(database.binding.item, 'item_base_unit').physicalName)}='BOX',
                ${quoted(database.binding.item.revisionColumn)}=${quoted(database.binding.item.revisionColumn)}+1
          WHERE tenant_id=$1 AND environment_id=$2
            AND ${quoted(database.binding.item.recordIdColumn)}=$3`,
        [tenantId, environmentId, itemId],
      );
    }).catch((error: unknown) => {
      throw translateInventoryPostingError(error);
    }),
    (error: unknown) => {
      const details =
        error instanceof InventoryPostingError ? error.details : {};
      testContext.diagnostic(
        `base-unit-after-post: ${postingCode(error) ?? 'unknown'} ${String(error)} details=${JSON.stringify(details)}`,
      );
      return (
        error instanceof InventoryPostingError &&
        error.code === 'INVENTORY_BASE_UNIT_IMMUTABLE' &&
        error.details.itemId === itemId &&
        error.details.bindingMovementId === expectedBinding.movementId &&
        error.details.bindingUnitId === 'EA' &&
        error.details.requestedUnitId === 'BOX'
      );
    },
  );
}

async function assertCatalogItemUpdateReportsBoundBaseUnit(
  database: PostingDatabase,
): Promise<void> {
  const expectedBinding = (
    await bindingMovementsForItem(database, itemId)
  ).toSorted(compareBindingMovements)[0];
  assert.ok(expectedBinding);
  const currentRevision = await database.adminPool.query<{ revision: string }>(
    `SELECT ${quoted(database.binding.item.revisionColumn)}::text AS revision
       FROM ${table(database.binding, database.binding.item)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${quoted(database.binding.item.recordIdColumn)}=$3`,
    [tenantId, environmentId, itemId],
  );
  const currentItem = currentRevision.rows[0];
  assert.ok(currentItem);
  const policy = new AllowRuntimePolicy();
  const interpreter = new PostgresModuleRuntimeInterpreter(
    database.runtimePool,
    new TrustedActorEnvelopeIssuer({
      resolve: async () => ({
        approvingHumanId: null,
        delegation: null,
        executionPrincipal: { kind: 'HUMAN', principalId },
        initiatingHumanId: principalId,
        subject: null,
      }),
    }),
    INVENTORY_PROVIDER_ERROR_MAPPINGS,
  );
  const mediation = new SemanticOperationMediationAuthority();
  const gateway = new SemanticOperationGateway(policy, interpreter, mediation);
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => ({
      environmentId,
      principalId,
      tenantId,
    })),
    new PostgresRequestRuntimeViewService(database.runtimePool),
    policy,
  );

  await assert.rejects(
    entry.run(
      { headers: { authorization: 'catalog-base-unit-control' } },
      (view) =>
        gateway.invoke(
          view,
          {
            confirmationGrant: null,
            idempotencyKey: randomUUID(),
            input: {
              expectedRevision: Number(currentItem.revision),
              patch: { 'northstar.app:field.item_base_unit': 'BOX' },
              recordId: itemId,
            },
            operationId: 'northstar.app:operation.item_update',
            schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
          },
          mediation.issueInvocation(view, 'UI'),
        ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ModuleRuntimeInterpreterError);
      assert.equal(error.code, 'INVENTORY_BASE_UNIT_IMMUTABLE');
      assert.deepEqual(error.details, {
        bindingMovementId: expectedBinding.movementId,
        bindingUnitId: 'EA',
        itemId,
        requestedUnitId: 'BOX',
      });
      return true;
    },
  );
}

class AllowRuntimePolicy implements CurrentPolicyGateway {
  async authorize(_request: CurrentPolicyDecisionRequest): Promise<{
    decision: 'ALLOW';
    decisionVersion: typeof CURRENT_POLICY_DECISION_VERSION;
    policyVersion: string;
  }> {
    void _request;
    return {
      decision: 'ALLOW',
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'inventory-provider-error-control/v1',
    };
  }

  async readCurrentVersion(
    _subject: CurrentPolicySubject,
  ): Promise<{ policyVersion: string }> {
    void _subject;
    return { policyVersion: 'inventory-provider-error-control/v1' };
  }
}

async function assertSameInstantMovementIdTieBreak(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  assert.ok(
    laterInsertedTieBreakMovementId < firstInsertedTieBreakMovementId,
    'the later-inserted movement must have the smaller UUID',
  );
  await withModuleRole(
    database.runtimePool,
    database.context,
    async (client) => {
      await insertEntity(
        client,
        database.binding,
        database.binding.item,
        {
          item_base_unit: 'EA',
          item_name: 'Same-instant tie-break item',
          item_sku: 'SKU-SAME-INSTANT-TIE-BREAK',
        },
        sameInstantTieBreakItemId,
        null,
        {},
      );
    },
  );
  const insertions = [
    {
      command: command({
        legalEntityId: legalAllow,
        lines: [
          {
            ...line('1', '1', locationPrimary),
            itemId: sameInstantTieBreakItemId,
          },
        ],
        sourceId: 'same-instant-id-tie-first',
      }),
      movementId: firstInsertedTieBreakMovementId,
    },
    {
      command: command({
        legalEntityId: legalAllow,
        lines: [
          {
            ...line('1', '1', locationPrimary),
            itemId: sameInstantTieBreakItemId,
          },
        ],
        sourceId: 'same-instant-id-tie-later',
      }),
      movementId: laterInsertedTieBreakMovementId,
    },
  ] as const;
  for (const insertion of insertions) {
    await seedDraft(database, insertion.command);
    await insertTieBreakMovement(
      database,
      insertion.command,
      insertion.movementId,
    );
  }

  const movements = await bindingMovementsForItem(
    database,
    sameInstantTieBreakItemId,
  );
  assert.equal(movements.length, 2);
  assert.equal(
    new Set(movements.map((movement) => movement.recordedAt.getTime())).size,
    1,
    'the chosen movements must share one recorded instant',
  );
  const expectedBinding = movements.toSorted(compareBindingMovements)[0]!;
  assert.equal(expectedBinding.movementId, laterInsertedTieBreakMovementId);

  await assert.rejects(
    withModuleRole(database.runtimePool, database.context, async (client) => {
      await client.query(
        `UPDATE ${table(database.binding, database.binding.item)}
            SET ${quoted(field(database.binding.item, 'item_base_unit').physicalName)}='BOX',
                ${quoted(database.binding.item.revisionColumn)}=${quoted(database.binding.item.revisionColumn)}+1
          WHERE tenant_id=$1 AND environment_id=$2
            AND ${quoted(database.binding.item.recordIdColumn)}=$3`,
        [tenantId, environmentId, sameInstantTieBreakItemId],
      );
    }).catch((error: unknown) => {
      throw translateInventoryPostingError(error);
    }),
    (error: unknown) => {
      const details =
        error instanceof InventoryPostingError ? error.details : {};
      testContext.diagnostic(
        `same-instant-id-tie: later-inserted ${laterInsertedTieBreakMovementId} sorts before first-inserted ${firstInsertedTieBreakMovementId}; ${postingCode(error) ?? 'unknown'} details=${JSON.stringify(details)}`,
      );
      return (
        error instanceof InventoryPostingError &&
        error.code === 'INVENTORY_BASE_UNIT_IMMUTABLE' &&
        error.details.itemId === sameInstantTieBreakItemId &&
        error.details.bindingMovementId === expectedBinding.movementId &&
        error.details.bindingUnitId === 'EA' &&
        error.details.requestedUnitId === 'BOX'
      );
    },
  );
}

async function insertTieBreakMovement(
  database: PostingDatabase,
  input: InventoryAdjustmentPostingCommandV1,
  movementId: string,
): Promise<void> {
  assert.equal(input.lines.length, 1);
  const postingLine = input.lines[0]!;
  await withModuleRole(
    database.runtimePool,
    database.context,
    async (client) => {
      await insertEntity(
        client,
        database.binding,
        database.binding.movement,
        {
          inventory_movement_actor_id: principalId,
          inventory_movement_effective_at: input.effectiveAt,
          inventory_movement_item_id: postingLine.itemId,
          inventory_movement_location_id: postingLine.locationId,
          inventory_movement_posting_role: enumOption(
            field(database.binding.movement, 'inventory_movement_posting_role'),
            'adjustment',
          ),
          inventory_movement_quantity_delta: postingLine.quantityDelta,
          inventory_movement_reason_code: input.reason.code,
          inventory_movement_reason_narrative: input.reason.narrative,
          inventory_movement_recorded_at: recordedAt,
          inventory_movement_reversal_of_movement_id: null,
          inventory_movement_source_id: input.sourceId,
          inventory_movement_source_line: postingLine.sourceLine,
          inventory_movement_source_revision: input.sourceRevision,
          inventory_movement_source_type: input.sourceType,
          inventory_movement_stock_dimension_set_version: enumOption(
            field(
              database.binding.movement,
              'inventory_movement_stock_dimension_set_version',
            ),
            'v1',
          ),
          inventory_movement_unit_id: postingLine.unitId,
        },
        movementId,
        input.legalEntityId,
        {
          [database.binding.transaction.entity.entityId]: input.transactionId,
          [database.binding.transactionLine.entity.entityId]:
            postingLine.transactionLineId,
        },
        businessPeriod,
      );
    },
  );
}

interface BindingMovement {
  movementId: string;
  recordedAt: Date;
}

async function bindingMovementsForItem(
  database: PostingDatabase,
  requestedItemId: string,
): Promise<BindingMovement[]> {
  const result = await database.adminPool.query<BindingMovement>(
    `SELECT ${quoted(database.binding.movement.recordIdColumn)}::text AS "movementId",
            ${quoted(field(database.binding.movement, 'inventory_movement_recorded_at').physicalName)} AS "recordedAt"
       FROM ${table(database.binding, database.binding.movement)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${quoted(field(database.binding.movement, 'inventory_movement_item_id').physicalName)}::text=$3::text`,
    [tenantId, environmentId, requestedItemId],
  );
  for (const movement of result.rows) {
    assert.ok(
      movement.recordedAt instanceof Date &&
        Number.isFinite(movement.recordedAt.getTime()),
      `movement ${movement.movementId} has an invalid recorded instant`,
    );
  }
  return result.rows;
}

function compareBindingMovements(
  left: BindingMovement,
  right: BindingMovement,
): number {
  const leftRecordedAt = left.recordedAt.getTime();
  const rightRecordedAt = right.recordedAt.getTime();
  if (leftRecordedAt !== rightRecordedAt) {
    return leftRecordedAt < rightRecordedAt ? -1 : 1;
  }
  if (left.movementId === right.movementId) return 0;
  return left.movementId < right.movementId ? -1 : 1;
}

async function assertMovementCannotUpdate(
  testContext: TestContext,
  database: PostingDatabase,
  movementId: string,
): Promise<void> {
  await assert.rejects(
    withModuleRole(database.runtimePool, database.context, async (client) => {
      await client.query(
        `UPDATE ${table(database.binding, database.binding.movement)}
            SET ${quoted(field(database.binding.movement, 'inventory_movement_recorded_at').physicalName)}='2099-01-01T00:00:00.000Z'
          WHERE tenant_id=$1 AND environment_id=$2
            AND ${quoted(database.binding.movement.recordIdColumn)}=$3`,
        [tenantId, environmentId, movementId],
      );
    }),
    (error: unknown) =>
      observePostgresError(testContext, 'recordedAt-update', error, '42501'),
  );
  await assert.rejects(
    withModuleRole(database.runtimePool, database.context, async (client) => {
      await client.query(
        `DELETE FROM ${table(database.binding, database.binding.movement)}
          WHERE tenant_id=$1 AND environment_id=$2
            AND ${quoted(database.binding.movement.recordIdColumn)}=$3`,
        [tenantId, environmentId, movementId],
      );
    }),
    (error: unknown) =>
      observePostgresError(testContext, 'movement-delete', error, '42501'),
  );
}

async function assertQuantityOnlyEvidence(
  testContext: TestContext,
  database: PostingDatabase,
  result: InventoryPostingResultV1,
  expectedMovementCount: number,
): Promise<void> {
  assert.equal(result.movements.length, expectedMovementCount);
  const movementIds = result.movements.map((movement) => movement.movementId);
  const movements = await database.adminPool.query<{ document: unknown }>(
    `SELECT to_jsonb(fact) AS document
       FROM ${table(database.binding, database.binding.movement)} AS fact
      WHERE ${quoted(database.binding.movement.recordIdColumn)}=ANY($1::uuid[])`,
    [movementIds],
  );
  const companions = await database.adminPool.query<{ document: unknown }>(
    `SELECT to_jsonb(companion) AS document
       FROM ${quoted(database.binding.schemaName)}.${quoted(database.binding.companionTableName)} AS companion
      WHERE ${quoted(database.binding.companionMovementIdColumn)}=ANY($1::uuid[])`,
    [movementIds],
  );
  const audit = await database.adminPool.query<{ document: unknown }>(
    `SELECT changes AS document
       FROM platform.trust_business_change_documents
      WHERE change_document_id=$1`,
    [result.trust.changeDocumentId],
  );
  const event = await database.adminPool.query<{ document: unknown }>(
    `SELECT payload AS document FROM platform.trust_domain_events
      WHERE domain_event_id=$1`,
    [result.trust.domainEventId],
  );
  const outbox = await database.adminPool.query<{ document: unknown }>(
    `SELECT to_jsonb(entry) AS document FROM platform.trust_outbox AS entry
      WHERE outbox_id=$1`,
    [result.trust.outboxId],
  );
  assert.equal(movements.rows.length, expectedMovementCount);
  assert.equal(companions.rows.length, expectedMovementCount);
  assert.equal(audit.rows.length, 1);
  assert.equal(event.rows.length, 1);
  assert.equal(outbox.rows.length, 1);
  const evidenceDocuments = [
    ...movements.rows.map((row) => row.document),
    ...companions.rows.map((row) => row.document),
    result,
    audit.rows[0]?.document,
    event.rows[0]?.document,
    outbox.rows[0]?.document,
  ];
  assert.equal(evidenceDocuments.length, expectedMovementCount * 2 + 4);
  for (const document of evidenceDocuments) {
    assert.ok(document !== undefined);
    assertNoMonetaryKeys(document);
  }
  assert.throws(() => assertNoMonetaryKeys({ unitCost: '1.00' }), /unitCost/u);
  assert.throws(
    () =>
      assertNoMonetaryKeys({
        classification: 'INTERNAL',
        fieldId: 'unitCost',
        newState: { state: 'VALUE', value: '1.00' },
        oldState: { state: 'ABSENT' },
      }),
    /unitCost/u,
  );
  testContext.diagnostic(
    'quantity-only parser reds: key and business-change fieldId both reject unitCost',
  );
}

function assertNoMonetaryKeys(document: unknown): void {
  const forbidden = [
    ...objectKeys(document),
    ...semanticFieldIds(document),
  ].filter((key) =>
    /(?:amount|money|cost|price|currency|valuation)/iu.test(key),
  );
  assert.deepEqual(forbidden, [], `monetary keys: ${forbidden.join(',')}`);
}

async function setPeriodLock(
  database: PostingDatabase,
  legalEntityId: string,
  closedThrough: string | null,
): Promise<void> {
  await withModuleRole(
    database.runtimePool,
    database.context,
    async (client) => {
      await client.query(
        `UPDATE ${table(database.binding, database.binding.periodLock)}
          SET ${quoted(database.binding.periodLockClosedThroughColumn)}=$4,
              ${quoted(database.binding.periodLock.revisionColumn)}=${quoted(database.binding.periodLock.revisionColumn)}+1
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(database.binding.periodLock.legalEntityColumn!)}=$3`,
        [tenantId, environmentId, legalEntityId, closedThrough],
      );
    },
  );
}

async function incrementTransactionRevision(
  database: PostingDatabase,
  transactionId: string,
): Promise<void> {
  await withModuleRole(
    database.runtimePool,
    database.context,
    async (client) => {
      await client.query(
        `UPDATE ${table(database.binding, database.binding.transaction)}
          SET ${quoted(database.binding.transaction.revisionColumn)}=${quoted(database.binding.transaction.revisionColumn)}+1
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(database.binding.transaction.recordIdColumn)}=$3`,
        [tenantId, environmentId, transactionId],
      );
    },
  );
}

async function recordedTransactionRevision(
  database: PostingDatabase,
  changeDocumentId: string,
): Promise<number> {
  const result = await database.adminPool.query<{ revision: number }>(
    `SELECT revision
       FROM platform.trust_business_change_documents
      WHERE tenant_id=$1 AND environment_id=$2 AND change_document_id=$3`,
    [tenantId, environmentId, changeDocumentId],
  );
  return Number(result.rows[0]?.revision ?? -1);
}

async function updatePostingConfiguration(
  database: PostingDatabase,
  legalEntityId: string,
  values: {
    adjustmentReasonRequirement?: 'codeOnly' | 'codeAndNarrative';
    transferApprovalThreshold?: string | null;
  },
): Promise<void> {
  await database.adminPool.query(
    `UPDATE platform.inventory_posting_configurations
        SET adjustment_reason_requirement = COALESCE($4, adjustment_reason_requirement),
            transfer_approval_threshold = COALESCE($5, transfer_approval_threshold),
            revision = revision + 1,
            updated_at = transaction_timestamp()
      WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3`,
    [
      tenantId,
      environmentId,
      legalEntityId,
      values.adjustmentReasonRequirement ?? null,
      values.transferApprovalThreshold ?? null,
    ],
  );
}

async function adjustmentReasonConfiguration(
  database: PostingDatabase,
  legalEntityId: string,
): Promise<{
  contractReleaseRoot: string;
  reasonRequirement: string;
}> {
  const result = await database.adminPool.query<{
    contractReleaseRoot: string;
    reasonRequirement: string;
  }>(
    `SELECT contract_release_root AS "contractReleaseRoot",
            adjustment_reason_requirement AS "reasonRequirement"
       FROM platform.inventory_posting_configurations
      WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3`,
    [tenantId, environmentId, legalEntityId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function installLateRollbackProbe(
  database: PostingDatabase,
  transactionId: string,
): Promise<void> {
  await database.adminPool.query(
    `CREATE SEQUENCE public.g3p3_movement_insert_probe MINVALUE 0 START 0;
     CREATE FUNCTION public.g3p3_observe_movement_insert()
       RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
       SET search_path = pg_catalog, public AS $probe$
       BEGIN
         PERFORM nextval('public.g3p3_movement_insert_probe');
         RETURN NEW;
       END
       $probe$;
     CREATE TRIGGER g3p3_observe_movement_insert
       AFTER INSERT ON ${table(database.binding, database.binding.movement)}
       FOR EACH ROW EXECUTE FUNCTION public.g3p3_observe_movement_insert();
     CREATE FUNCTION public.g3p3_reject_target_transition()
       RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
       SET search_path = pg_catalog, public AS $reject$
       BEGIN
         IF NEW.${quoted(database.binding.transaction.recordIdColumn)} = TG_ARGV[0]::uuid THEN
           RAISE EXCEPTION 'G3P3_INJECTED_LATE_FAILURE' USING ERRCODE='P0001';
         END IF;
         RETURN NEW;
       END
       $reject$;
     CREATE TRIGGER g3p3_reject_target_transition
       BEFORE UPDATE ON ${table(database.binding, database.binding.transaction)}
       FOR EACH ROW EXECUTE FUNCTION public.g3p3_reject_target_transition('${transactionId}')`,
  );
}

async function installTransferRollbackProbe(
  database: PostingDatabase,
): Promise<void> {
  const sourceIdColumn = field(
    database.binding.movement,
    'inventory_movement_source_id',
  ).physicalName;
  const quantityColumn = field(
    database.binding.movement,
    'inventory_movement_quantity_delta',
  ).physicalName;
  await database.adminPool.query(
    `CREATE SEQUENCE public.g3p4_transfer_insert_probe MINVALUE 0 START 0;
     CREATE FUNCTION public.g3p4_reject_transfer_second_side()
       RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
       SET search_path = pg_catalog, public AS $reject$
       BEGIN
         IF NEW.${quoted(sourceIdColumn)} = '${transferAtomicitySourceId}'
            AND NEW.${quoted(quantityColumn)} < 0
         THEN
           RAISE EXCEPTION 'G3P4_INJECTED_SECOND_SIDE_FAILURE'
             USING ERRCODE='P0001';
         END IF;
         RETURN NEW;
       END
       $reject$;
     CREATE FUNCTION public.g3p4_observe_transfer_first_side()
       RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
       SET search_path = pg_catalog, public AS $observe$
       BEGIN
         IF NEW.${quoted(sourceIdColumn)} = '${transferAtomicitySourceId}' THEN
           PERFORM nextval('public.g3p4_transfer_insert_probe');
         END IF;
         RETURN NEW;
       END
       $observe$;
     CREATE TRIGGER g3p4_reject_transfer_second_side
       BEFORE INSERT ON ${table(database.binding, database.binding.movement)}
       FOR EACH ROW EXECUTE FUNCTION public.g3p4_reject_transfer_second_side();
     CREATE TRIGGER g3p4_observe_transfer_first_side
       AFTER INSERT ON ${table(database.binding, database.binding.movement)}
       FOR EACH ROW EXECUTE FUNCTION public.g3p4_observe_transfer_first_side()`,
  );
}

async function transferRollbackProbeCount(
  database: PostingDatabase,
): Promise<number> {
  const result = await database.adminPool.query<{
    is_called: boolean;
    last_value: string;
  }>(
    `SELECT last_value::text, is_called
       FROM public.g3p4_transfer_insert_probe`,
  );
  const row = result.rows[0];
  return row?.is_called ? Number(row.last_value) + 1 : 0;
}

async function removeTransferRollbackProbe(
  database: PostingDatabase,
): Promise<void> {
  await database.adminPool.query(
    `DROP TRIGGER IF EXISTS g3p4_reject_transfer_second_side
       ON ${table(database.binding, database.binding.movement)};
     DROP TRIGGER IF EXISTS g3p4_observe_transfer_first_side
       ON ${table(database.binding, database.binding.movement)};
     DROP FUNCTION IF EXISTS public.g3p4_reject_transfer_second_side();
     DROP FUNCTION IF EXISTS public.g3p4_observe_transfer_first_side();
     DROP SEQUENCE IF EXISTS public.g3p4_transfer_insert_probe`,
  );
}

async function rollbackProbeCount(database: PostingDatabase): Promise<number> {
  const result = await database.adminPool.query<{
    is_called: boolean;
    last_value: string;
  }>(
    `SELECT last_value::text, is_called
       FROM public.g3p3_movement_insert_probe`,
  );
  const row = result.rows[0];
  return row?.is_called ? Number(row.last_value) + 1 : 0;
}

async function movementCount(database: PostingDatabase): Promise<number> {
  const result = await database.adminPool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table(database.binding, database.binding.movement)}`,
  );
  return Number(result.rows[0]?.count ?? '-1');
}

// ---------------------------------------------------------------------------
// posting-kernel-admission (5g3-prog R1 + R3). The cross-layer admission map
// for the posting kernel: the version a release DECLARES is checked against
// the version the provider IMPLEMENTS on every posting, and the verifiers that
// EXECUTED are compared exactly with the relations the transaction WROTE.
// ---------------------------------------------------------------------------

/**
 * The admission twin for everything below: an unchanged kernel admits a
 * posting whose every written relation was observed by an executed verifier,
 * and whose active release declares exactly the version the provider
 * implements. Every mutation in the packet's expected-red manifest that turns
 * a green posting red kills THIS test, so its name is the manifest's pattern.
 */
test('posting kernel admission: the unchanged kernel admits a posting whose every written relation an executed verifier observed', async () => {
  await withPostingDatabase(async (database) => {
    const posting = command({
      legalEntityId: legalReject,
      sourceId: 'admission-twin',
    });
    await seedDraft(database, posting);
    const outcome = await settlePosting(
      database.service.postAdjustment(
        database.context,
        database.actor,
        posting,
      ),
    );
    assert.equal(
      outcome.status,
      'fulfilled',
      `the unchanged kernel must admit an ordinary posting: ${
        outcome.status === 'rejected' ? String(outcome.reason) : ''
      } ${JSON.stringify(outcome)}`,
    );
    if (outcome.status !== 'fulfilled') return;
    assert.equal(outcome.value.movements.length, 1);
    assert.equal(
      outcome.value.capabilityVersion,
      INVENTORY_POSTING_CAPABILITY_VERSION,
    );
    assert.equal(await movementCountBySource(database, posting.sourceId), 1);
    assert.equal(await receiptCountByKey(database, posting.idempotencyKey), 1);
  });
});

/**
 * R3, the survivor the review named. `assertObservedWriteSetIsDerived` asks
 * only whether a written relation is DERIVED, and construction asks only
 * whether a derived relation has a verifier REGISTERED. A relation that is
 * derived and registered but written on a path whose verifier does not run
 * satisfies both. The transaction LINE is exactly that on the adjustment path:
 * its registered verifier is `assertCompanionIdentitiesPersisted`, which runs
 * only for a companion-origin family. A trigger the target knows nothing about
 * writes it on the movement insert, and the posting must refuse before commit,
 * naming the relation.
 */
test(
  'posting kernel admission: a derived relation written on a path whose verifier did not run is refused before commit, naming the relation',
  { timeout: 180_000 },
  async (testContext) => {
    await withPostingDatabase(async (database) => {
      const posting = command({
        legalEntityId: legalReject,
        sourceId: 'unverified-line-writer',
      });
      await seedDraft(database, posting);
      const lineTable = table(
        database.binding,
        database.binding.transactionLine,
      );
      const revision = quoted(database.binding.transactionLine.revisionColumn);
      await database.adminPool.query(
        `CREATE FUNCTION public.pka_unverified_line_writer()
           RETURNS trigger LANGUAGE plpgsql AS $body$
           BEGIN
             UPDATE ${lineTable} SET ${revision} = ${revision}
              WHERE tenant_id = NEW.tenant_id
                AND environment_id = NEW.environment_id;
             RETURN NEW;
           END
           $body$;
         CREATE TRIGGER pka_unverified_line_writer
           AFTER INSERT ON ${table(database.binding, database.binding.movement)}
           FOR EACH ROW EXECUTE FUNCTION public.pka_unverified_line_writer()`,
      );
      let outcome: PostingOutcome;
      try {
        outcome = await settlePosting(
          database.service.postAdjustment(
            database.context,
            database.actor,
            posting,
          ),
        );
      } finally {
        await database.adminPool.query(
          `DROP TRIGGER IF EXISTS pka_unverified_line_writer
             ON ${table(database.binding, database.binding.movement)};
           DROP FUNCTION IF EXISTS public.pka_unverified_line_writer()`,
        );
      }
      assert.equal(
        outcome.status,
        'rejected',
        `a written relation no executed verifier observed must refuse the posting before commit: ${JSON.stringify(outcome)}`,
      );
      assertRejectedPosting(
        testContext,
        'unverified-line-writer',
        outcome,
        'INVENTORY_POSTING_STORAGE_REJECTED',
      );
      const reason = String(
        outcome.status === 'rejected' ? outcome.reason : '',
      );
      assert.match(
        reason,
        /wrote module relations no executed verifier observed/u,
      );
      // Named, so an operator learns WHICH relation rather than that one exists.
      assert.match(
        reason,
        new RegExp(database.binding.transactionLine.tableName, 'u'),
      );
      // Nothing committed: refused before the trust document and the receipt.
      assert.equal(await movementCountBySource(database, posting.sourceId), 0);
      assert.equal(
        await receiptCountByKey(database, posting.idempotencyKey),
        0,
      );
    });
  },
);

/**
 * R1, the refusing direction. A release compiled from a definition that
 * declares the posting capability at version 1 -- consistent with itself, so
 * the compiler admits it -- is refused by a provider implementing version 2,
 * on the first posting, before configuration is even loaded. The admitting
 * direction is every other posting test in this file: the fixture release
 * declares what the provider implements, because both read the contract.
 */
test(
  'posting kernel admission: a release declaring a posting capability version the provider does not implement is refused on posting',
  { timeout: 180_000 },
  async (testContext) => {
    await withPostingDatabase(async (database) => {
      const service = await serveDeclaredVersionOneRelease(database);
      const draft = command({
        legalEntityId: legalReject,
        sourceId: 'declared-version-one',
      });
      await seedDraft(database, draft);
      const outcome = await settlePosting(
        service.postAdjustment(database.context, database.actor, draft),
      );
      assert.equal(
        outcome.status,
        'rejected',
        `a release declaring version 1 must be refused by a provider implementing ${String(INVENTORY_POSTING_CAPABILITY_VERSION)}: ${JSON.stringify(outcome)}`,
      );
      assertRejectedPosting(
        testContext,
        'declared-version-one',
        outcome,
        'INVENTORY_POSTING_CAPABILITY_MISMATCH',
      );
      const reason = String(
        outcome.status === 'rejected' ? outcome.reason : '',
      );
      assert.match(
        reason,
        new RegExp(
          `declares posting capability version 1 while the registered provider implements version ${String(INVENTORY_POSTING_CAPABILITY_VERSION)}`,
          'u',
        ),
      );
      assert.equal(await movementCountBySource(database, draft.sourceId), 0);
      assert.equal(await receiptCountByKey(database, draft.idempotencyKey), 0);
    });
  },
);

/**
 * R1, the shipped artifact. The head release the runtime loads must declare
 * the version this provider implements. This is the deterministic half of the
 * admission map: the runtime check above refuses a stale artifact on the first
 * posting, and this reds the matrix the moment the artifact is stale, before
 * anything is deployed. PUR-2b measured the head release saying 1 while the
 * provider said 2, and every gate stayed green.
 */
test('posting kernel admission: the shipped head release declares the posting capability version the provider implements', async () => {
  type ReleaseHead = {
    releaseManifest: {
      capabilityFacts: Array<{
        capabilityId: string;
        capabilityVersion: number;
      }>;
    };
  };
  const artifact = JSON.parse(
    await readFile(resolve('apps/web/release/app.compiled.json'), 'utf8'),
  ) as {
    application?: ReleaseHead;
    applications?: ReleaseHead[];
  };
  const head = artifact.applications?.at(-1) ?? artifact.application;
  assert.ok(head, 'the compiled artifact has a head release');
  const facts = head.releaseManifest.capabilityFacts.filter(
    (fact) => fact.capabilityId === postingCapabilityId,
  );
  assert.equal(
    facts.length,
    1,
    'the head release declares the posting capability exactly once',
  );
  assert.equal(
    facts[0]!.capabilityVersion,
    INVENTORY_POSTING_CAPABILITY_VERSION,
    'the shipped head release must declare the posting capability version the provider implements; regenerate apps/web/release/** when the contract moves',
  );
});

/**
 * Compile, persist, activate and serve a release that declares the posting
 * capability at version 1 while the provider implements what the contract
 * says. The definition is the live one with a single field changed, so the
 * release is internally consistent and the compiler admits it -- which is what
 * makes it the right specimen: nothing but the provider's own check stands
 * between it and a posting.
 *
 * The scope configuration is re-pointed at it too, so a kernel with the
 * capability check removed is not refused one step later by the
 * configuration's release-root comparison; the control would then observe
 * nothing.
 */
/**
 * `5g3-prog` A2, second entry, given a test of its OWN.
 *
 * `assertPersistedPlannedOrderIsDecisive` already ran inside the composite
 * one-way-doors test, and that is where its kill evidence lived as prose.
 * Measured while writing the control: removing the combined sort reds that
 * composite test through an EARLIER, unrelated spurious refusal, so the
 * mutation could not be attributed to the property it is about. Here the
 * property stands alone -- a planned debit that must sort before a persisted
 * credit at an identical instant -- so the mutation's red is the missing
 * rejection and nothing else.
 */
test(
  'posting kernel admission: the negative-stock check orders persisted and planned movements together',
  { timeout: 180_000 },
  async (testContext) => {
    await withPostingDatabase(async (database) => {
      await assertPersistedPlannedOrderIsDecisive(testContext, database);
    });
  },
);

/**
 * `5g3-prog` A3. THE MONOTONIC FLOOR ON `recordedAt`, per stock identity.
 *
 * `recordedAt` is a wall-clock sample and `AGENTS.md` section 7 records that
 * this machine steps its clock backward under load. The comparator orders by
 * `effectiveAt` FIRST, so a backward step is invisible to the negative-stock
 * check: the two postings below sort as (+10, -5) by effective time and never
 * project a negative prefix, so admission is satisfied. But their RECORDED
 * times run backward, and an as-of read whose recorded-time horizon falls
 * between them sees only the -5 -- a negative balance under `reject`, which the
 * kernel never admitted and which nothing surfaces until someone reads history.
 *
 * The clock is INJECTED, never slept on (`AGENTS.md` section 6). The first
 * posting is what makes the second one's sample a regression, so the pair is
 * the specimen; a single posting cannot express this.
 *
 * SCOPE, NARROWED ON ROUND-3 REVIEW: the subject is a posting that APPENDS
 * movements. Each posting here carries its own `sourceId`, so neither matches
 * an already-accepted natural effect and neither returns through
 * `findNaturalReplay`, which sits above the floor. A natural-effect replay
 * under a regressed clock is NOT refused, and is harmless for the reason
 * stated beside the floor: it appends nothing and its receipt carries the
 * original posting's `recordedAt`.
 */
test(
  'posting kernel admission: a posting that appends movements with a recorded time running backward against the same stock identity is refused',
  { timeout: 180_000 },
  async (testContext) => {
    await withPostingDatabase(async (database) => {
      const laterRecordedAt = '2026-07-29T13:00:05.000Z';
      const earlierRecordedAt = '2026-07-29T13:00:03.000Z';
      let currentInstant = laterRecordedAt;
      const service = new PostgresInventoryPostingService(
        database.runtimePool,
        database.registration,
        { currentInstant: () => currentInstant },
      );

      // Recorded LATER, effective EARLIER.
      const credit = command({
        effectiveAt: '2026-07-29T12:00:00.000Z',
        legalEntityId: legalReject,
        locationId: locationRace,
        quantityDelta: '10',
        sourceId: 'recorded-at-floor-credit',
      });
      await seedDraft(database, credit);
      const first = await settlePosting(
        service.postAdjustment(database.context, database.actor, credit),
      );
      assert.equal(
        first.status,
        'fulfilled',
        `the first posting must succeed: ${
          first.status === 'rejected' ? String(first.reason) : ''
        }`,
      );

      // The clock steps BACK. Recorded EARLIER, effective LATER: by effective
      // time this is (+10, -5) and never negative, so only the floor refuses it.
      currentInstant = earlierRecordedAt;
      const debit = command({
        effectiveAt: '2026-07-29T12:30:00.000Z',
        legalEntityId: legalReject,
        locationId: locationRace,
        quantityDelta: '-5',
        sourceId: 'recorded-at-floor-debit',
      });
      await seedDraft(database, debit);
      const outcome = await settlePosting(
        service.postAdjustment(database.context, database.actor, debit),
      );
      assert.equal(
        outcome.status,
        'rejected',
        `a posting recorded earlier than the same stock identity's latest movement must be refused: ${JSON.stringify(outcome)}`,
      );
      assertRejectedPosting(
        testContext,
        'recorded-at-floor',
        outcome,
        'INVENTORY_RECORDED_AT_REGRESSION',
      );
      const reason = String(
        outcome.status === 'rejected' ? outcome.reason : '',
      );
      // Both instants are named, so an operator reads the clock regression
      // rather than a bare refusal.
      assert.match(reason, new RegExp(earlierRecordedAt, 'u'));
      assert.match(reason, new RegExp(laterRecordedAt, 'u'));
      assert.equal(await movementCountBySource(database, debit.sourceId), 0);
      assert.equal(await receiptCountByKey(database, debit.idempotencyKey), 0);

      // EQUALITY IS ADMITTED, and this half is what keeps the refusal from
      // being a blunt "any repeat posting fails": the same instant as the
      // floor still posts, which is the ordinary case for two postings inside
      // one clock tick and for every fixed-clock test in this suite.
      currentInstant = laterRecordedAt;
      const equal = command({
        effectiveAt: '2026-07-29T12:30:00.000Z',
        legalEntityId: legalReject,
        locationId: locationRace,
        quantityDelta: '-5',
        sourceId: 'recorded-at-floor-equal',
      });
      await seedDraft(database, equal);
      const admitted = await settlePosting(
        service.postAdjustment(database.context, database.actor, equal),
      );
      assert.equal(
        admitted.status,
        'fulfilled',
        `a posting recorded at exactly the floor must be admitted: ${
          admitted.status === 'rejected' ? String(admitted.reason) : ''
        }`,
      );
    });
  },
);

async function serveDeclaredVersionOneRelease(
  database: PostingDatabase,
): Promise<PostgresInventoryPostingService> {
  const fixture = await compiledFixture();
  const declaredVersionOne = structuredClone(fixture.inventoryDefinition);
  const requirements = declaredVersionOne.capabilityRequirements;
  assert.ok(Array.isArray(requirements));
  const posting = requirements.find(
    (requirement) =>
      isRecord(requirement) && requirement.capabilityId === postingCapabilityId,
  );
  assert.ok(isRecord(posting), 'the fixture declares the posting capability');
  assert.equal(
    posting.capabilityVersion,
    INVENTORY_POSTING_CAPABILITY_VERSION,
    'the fixture definition must declare what the provider implements, because both read the contract',
  );
  posting.capabilityVersion = 1;
  const compiled = mustCompile(
    moduleInput(
      declaredVersionOne,
      expectedActiveReleaseFrom(fixture.inventory),
    ),
  );
  const declaredFact = compiled.bundle.releaseManifest.capabilityFacts.find(
    (fact) => fact.capabilityId === postingCapabilityId,
  );
  assert.equal(declaredFact?.capabilityVersion, 1);
  const [releaseId] = await persistSequence(
    database.runtimePool,
    database.context,
    [[compiled, declaredVersionOne]],
  );
  assert.ok(releaseId);
  await setPointer(database.adminPool, releaseId);
  const repointed = await database.adminPool.query(
    `UPDATE platform.inventory_posting_configurations
        SET contract_release_root = $4
      WHERE tenant_id = $1 AND environment_id = $2 AND legal_entity_id = $3`,
    [tenantId, environmentId, legalReject, compiled.releaseRoot],
  );
  assert.equal(repointed.rowCount, 1);
  return new PostgresInventoryPostingService(
    database.runtimePool,
    {
      ...database.registration,
      releaseContentHash: compiled.releaseRoot,
      releaseId,
    },
    { currentInstant: () => recordedAt },
  );
}

/**
 * ROUND-1 REVIEW FINDING, and the reason the first candidate was BLOCKed: a
 * STORED RECEIPT RETURNS BEFORE `assertActiveRelease`.
 *
 * `findReceipt` keys on tenant, environment, capability and idempotency key
 * only -- never on the release the receipt was recorded under -- and
 * `validateReceiptReplay` compares the principal and the digest. So with the
 * capability check placed inside `assertActiveRelease`, an operator on a
 * release declaring version 1 could replay a key recorded under version 2 and
 * receive that version-2 result, with no mismatch announced. The packet's own
 * claim was that the check runs on EVERY posting; on this path it did not.
 *
 * The check is now made before the receipt is looked up, so this replay
 * refuses. The recorded result must not be served, and the receipt must not be
 * disturbed.
 */
test(
  'posting kernel admission: a stored receipt is not replayed across a release that declares a different capability version',
  { timeout: 180_000 },
  async (testContext) => {
    await withPostingDatabase(async (database) => {
      // 1. An ordinary posting under the release that declares what the
      //    provider implements. This records the receipt.
      const posting = command({
        legalEntityId: legalReject,
        sourceId: 'cross-release-replay',
      });
      await seedDraft(database, posting);
      const first = await settlePosting(
        database.service.postAdjustment(
          database.context,
          database.actor,
          posting,
        ),
      );
      assert.equal(
        first.status,
        'fulfilled',
        `the first posting must succeed: ${
          first.status === 'rejected' ? String(first.reason) : ''
        }`,
      );
      assert.equal(
        await receiptCountByKey(database, posting.idempotencyKey),
        1,
        'the first posting recorded exactly one receipt to replay',
      );

      // 2. The same key, replayed by a provider registered against a release
      //    that declares version 1. Under the reviewed candidate this returned
      //    the recorded version-2 result.
      const service = await serveDeclaredVersionOneRelease(database);
      const outcome = await settlePosting(
        service.postAdjustment(database.context, database.actor, posting),
      );
      assert.equal(
        outcome.status,
        'rejected',
        `a recorded result must not be replayed under a release declaring a different capability version: ${JSON.stringify(outcome)}`,
      );
      assertRejectedPosting(
        testContext,
        'cross-release-replay',
        outcome,
        'INVENTORY_POSTING_CAPABILITY_MISMATCH',
      );
      const reason = String(
        outcome.status === 'rejected' ? outcome.reason : '',
      );
      assert.match(
        reason,
        new RegExp(
          `declares posting capability version 1 while the registered provider implements version ${String(INVENTORY_POSTING_CAPABILITY_VERSION)}`,
          'u',
        ),
      );
      // The refusal is a refusal, not a rewrite: the recorded receipt and the
      // movement it names are untouched.
      assert.equal(
        await receiptCountByKey(database, posting.idempotencyKey),
        1,
      );
      assert.equal(await movementCountBySource(database, posting.sourceId), 1);
    });
  },
);

async function companionCount(database: PostingDatabase): Promise<number> {
  const result = await database.adminPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM ${quoted(database.binding.schemaName)}.${quoted(database.binding.companionTableName)}`,
  );
  return Number(result.rows[0]?.count ?? '-1');
}

async function movementCountBySource(
  database: PostingDatabase,
  sourceId: string,
): Promise<number> {
  const result = await database.adminPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM ${table(database.binding, database.binding.movement)}
      WHERE ${quoted(field(database.binding.movement, 'inventory_movement_source_id').physicalName)}=$1`,
    [sourceId],
  );
  return Number(result.rows[0]?.count ?? '-1');
}

async function receiptInputDigestVersion(
  database: PostingDatabase,
  idempotencyKey: string,
): Promise<number> {
  const result = await database.adminPool.query<{
    inputDigestVersion: number;
  }>(
    `SELECT input_digest_version AS "inputDigestVersion"
       FROM platform.semantic_operation_receipts
      WHERE tenant_id=$1 AND environment_id=$2
        AND action_id=$3 AND idempotency_key=$4`,
    [tenantId, environmentId, postingCapabilityId, idempotencyKey],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.inputDigestVersion;
}

async function transferMovementRows(
  database: PostingDatabase,
  sourceId: string,
): Promise<
  Array<{
    locationId: string;
    postingRole: string;
    quantityDelta: string;
    sourceLine: string;
  }>
> {
  const result = await database.adminPool.query<{
    locationId: string;
    postingRole: string;
    quantityDelta: string;
    sourceLine: string;
  }>(
    `SELECT ${quoted(field(database.binding.movement, 'inventory_movement_location_id').physicalName)}::text AS "locationId",
            ${quoted(field(database.binding.movement, 'inventory_movement_posting_role').physicalName)} AS "postingRole",
            ${quoted(field(database.binding.movement, 'inventory_movement_quantity_delta').physicalName)}::text AS "quantityDelta",
            ${quoted(field(database.binding.movement, 'inventory_movement_source_line').physicalName)} AS "sourceLine"
       FROM ${table(database.binding, database.binding.movement)}
      WHERE ${quoted(field(database.binding.movement, 'inventory_movement_source_id').physicalName)}=$1
      ORDER BY ${quoted(field(database.binding.movement, 'inventory_movement_source_line').physicalName)}`,
    [sourceId],
  );
  return result.rows.map((row) => ({
    ...row,
    quantityDelta: row.quantityDelta
      .replace(/(\.[0-9]*?)0+$/u, '$1')
      .replace(/\.$/u, ''),
  }));
}

async function stockBalance(
  database: PostingDatabase,
  legalEntityId: string,
  locationId: string,
  requestedItemId = itemId,
): Promise<string> {
  const result = await database.adminPool.query<{ balance: string }>(
    `SELECT COALESCE(sum(${quoted(field(database.binding.movement, 'inventory_movement_quantity_delta').physicalName)}),0)::text AS balance
       FROM ${table(database.binding, database.binding.movement)}
      WHERE legal_entity_id=$1
        AND ${quoted(field(database.binding.movement, 'inventory_movement_item_id').physicalName)}=$2
        AND ${quoted(field(database.binding.movement, 'inventory_movement_location_id').physicalName)}=$3`,
    [legalEntityId, requestedItemId, locationId],
  );
  const balance = result.rows[0]?.balance;
  if (balance === undefined) return 'missing';
  return balance.replace(/(\.[0-9]*?)0+$/u, '$1').replace(/\.$/u, '');
}

async function trustCountByRequest(
  database: PostingDatabase,
  requestId: string,
): Promise<number> {
  const result = await database.adminPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.trust_action_invocations
      WHERE request_id=$1 AND action_id=$2`,
    [requestId, postingCapabilityId],
  );
  return Number(result.rows[0]?.count ?? '-1');
}

async function receiptCountByKey(
  database: PostingDatabase,
  idempotencyKey: string,
): Promise<number> {
  const result = await database.adminPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.semantic_operation_receipts
      WHERE tenant_id=$1 AND environment_id=$2
        AND action_id=$3 AND idempotency_key=$4`,
    [tenantId, environmentId, postingCapabilityId, idempotencyKey],
  );
  return Number(result.rows[0]?.count ?? '-1');
}

async function activeTransactionLineCount(
  database: PostingDatabase,
  command: InventoryAdjustmentPostingCommandV1,
): Promise<number> {
  const result = await database.adminPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM ${table(database.binding, database.binding.transactionLine)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${quoted(database.binding.transactionLine.legalEntityColumn!)}=$3
        AND ${quoted(bindingRelationToTransaction(database.binding))}=$4
        AND ${quoted(database.binding.transactionLine.archiveColumn)} IS NULL`,
    [tenantId, environmentId, command.legalEntityId, command.transactionId],
  );
  return Number(result.rows[0]?.count ?? '-1');
}

async function transactionState(
  database: PostingDatabase,
  transactionId: string,
): Promise<{ revision: number; state: string }> {
  const result = await database.adminPool.query<{
    revision: number;
    state: string;
  }>(
    `SELECT ${quoted(database.binding.transaction.revisionColumn)}::integer AS revision,
            ${quoted(field(database.binding.transaction, 'inventory_transaction_state').physicalName)} AS state
       FROM ${table(database.binding, database.binding.transaction)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${quoted(database.binding.transaction.recordIdColumn)}=$3`,
    [tenantId, environmentId, transactionId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

function bindingRelationToTransaction(binding: TestStorageBinding): string {
  const relations = bindingRelations(binding, binding.transactionLine).filter(
    (relation) =>
      relation.targetEntityId === binding.transaction.entity.entityId &&
      relation.relationColumn.origin !== 'field',
  );
  assert.equal(relations.length, 1);
  return relations[0]!.relationColumn.physicalName;
}

function requiredTargetEntity(
  target: StorageTargetPayloadV1,
  suffix: string,
): StorageEntityTarget {
  const matches = target.entities.filter((candidate) =>
    candidate.entityId.endsWith(`:entity.${suffix}`),
  );
  assert.equal(matches.length, 1, `expected exactly one ${suffix} entity`);
  return matches[0]!;
}

function movementFactStorage(
  database: PostingDatabase,
): NonNullable<StorageEntityTarget['factStorage']> {
  const fact = requiredTargetEntity(
    database.binding.storageTarget,
    'inventory_movement',
  ).factStorage;
  assert.ok(fact, 'the compiled movement entity carries no fact storage');
  return fact;
}

async function activeBalanceCount(database: PostingDatabase): Promise<number> {
  const balance = requiredTargetEntity(
    database.binding.storageTarget,
    'posted_stock_balance',
  );
  const result = await database.adminPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM ${quoted(database.binding.schemaName)}.${quoted(balance.physicalTableName)}
      WHERE ${quoted(balance.archive.archivedAtColumn)} IS NULL`,
  );
  return Number(result.rows[0]?.count ?? '-1');
}

test(
  'posting writer inventory: a relation the compiled target reaches with no registered read-back refuses at construction',
  { timeout: 180_000 },
  async (testContext) => {
    await withPostingDatabase(async (database) => {
      // The real target constructs. Every relation the derivation names --
      // each written entity's table, the movement's partitions, its
      // effect-reservation companion, and the balance the declared projection
      // trigger writes -- carries a registered read-back.
      assert.doesNotThrow(
        () =>
          new PostgresInventoryPostingService(
            database.runtimePool,
            database.registration,
            { currentInstant: () => recordedAt },
          ),
      );

      // OBSERVE THE DERIVATION ITSELF, not only the refusal it produces. A
      // control that proves an unverified relation is refused says nothing
      // about whether the derivation reaches anything in the first place: an
      // inventory that derived only entity tables would pass that control and
      // still miss every writer PUR-2a's rounds found.
      const derived = new PostgresInventoryPostingService(
        database.runtimePool,
        database.registration,
        { currentInstant: () => recordedAt },
      ).writerInventory;
      const fact = movementFactStorage(database);
      const balance = requiredTargetEntity(
        database.binding.storageTarget,
        'posted_stock_balance',
      );
      const periodLock = requiredTargetEntity(
        database.binding.storageTarget,
        'inventory_period_lock',
      );
      // The movement's own table, every partition the target declares, the
      // effect-reservation companion, and the projection whose trigger the
      // target declares on the movement.
      assert.equal(
        derived.get(database.binding.movement.tableName)?.origin,
        'entityTable',
      );
      for (const partition of fact.partitioning.partitions) {
        assert.equal(
          derived.get(partition.physicalTableName)?.origin,
          'factPartition',
          `partition ${partition.physicalTableName} is not derived`,
        );
      }
      assert.equal(
        derived.get(fact.companion.physicalTableName)?.origin,
        'factCompanion',
      );
      assert.equal(
        derived.get(balance.physicalTableName)?.origin,
        'triggerProjection',
      );
      // The period-lock table is EXCLUDED, and by derivation rather than by
      // assumption: its provisioning trigger is declared exactly like the
      // projection trigger above and is installed on the legal-entity master,
      // which a posting never inserts.
      assert.equal(derived.has(periodLock.physicalTableName), false);
      assert.equal(
        derived.has(database.binding.legalEntity.tableName),
        false,
        'a posting reads the legal-entity master and must not claim to write it',
      );
      // All four origins are reached on the real compiled target, so no origin
      // branch of the derivation is dead.
      assert.deepEqual(
        [...new Set([...derived.values()].map((entry) => entry.origin))].sort(),
        ['entityTable', 'factCompanion', 'factPartition', 'triggerProjection'],
      );

      // Now declare append-only fact storage on a SECOND entity this posting
      // writes, carrying physical names of its own. Nothing in the kernel
      // changes. The compiled target now says that writing an
      // `inventory_transaction` also reaches partitions and an
      // effect-reservation companion, and no read-back observes any of them.
      //
      // This is the whole claim of the packet, exercised: the inventory is
      // DERIVED from the compiled declaration, so a writer the target grows
      // is refused without anyone remembering to add it to a list.
      const target = structuredClone(
        database.registration.storageTarget,
      ) as StorageTargetPayloadV1;
      const movement = requiredTargetEntity(target, 'inventory_movement');
      const transaction = requiredTargetEntity(target, 'inventory_transaction');
      const injected = structuredClone(movement.factStorage!);
      injected.companion.physicalTableName = 'nsm_t_pwi_unverified_companion';
      injected.partitioning = {
        ...injected.partitioning,
        partitions: injected.partitioning.partitions.map(
          (partition, index) => ({
            ...partition,
            physicalTableName: `nsm_t_pwi_unverified_partition_${String(index)}`,
          }),
        ),
      };
      transaction.factStorage = injected;

      // CHAINED REACHABILITY, required by round 1's F1. The balance is reached
      // only THROUGH the projection trigger installed on the movement; it is
      // not one of the kernel's declared write roots. Giving the BALANCE its
      // own fact storage means the posting reaches those partitions and that
      // companion at two removes -- movement -> balance -> reservation.
      //
      // The first version of the traversal tested each edge against the
      // ORIGINAL root set in one pass, so it reached the balance and then
      // stopped, and every relation behind it was invisible. A control that
      // only injects storage onto an existing ROOT cannot tell the two
      // traversals apart, which is why this case is separate.
      const chained = structuredClone(
        database.registration.storageTarget,
      ) as StorageTargetPayloadV1;
      const chainedMovement = requiredTargetEntity(
        chained,
        'inventory_movement',
      );
      const chainedBalance = requiredTargetEntity(
        chained,
        'posted_stock_balance',
      );
      const chainedFact = structuredClone(chainedMovement.factStorage!);
      chainedFact.companion.physicalTableName = 'nsm_t_pwi_chained_companion';
      chainedFact.partitioning = {
        ...chainedFact.partitioning,
        partitions: chainedFact.partitioning.partitions.map(
          (partition, index) => ({
            ...partition,
            physicalTableName: `nsm_t_pwi_chained_partition_${String(index)}`,
          }),
        ),
      };
      chainedBalance.factStorage = chainedFact;
      assert.throws(
        () =>
          new PostgresInventoryPostingService(
            database.runtimePool,
            { ...database.registration, storageTarget: chained },
            { currentInstant: () => recordedAt },
          ),
        (error: unknown) => {
          assert.equal(
            observePostingError(
              testContext,
              'writer-inventory-chained-relation',
              error,
              'INVENTORY_POSTING_STORAGE_INVALID',
            ),
            true,
          );
          assert.match(
            String(error),
            /reaches physical relations no read-back verifies/u,
          );
          assert.match(String(error), /nsm_t_pwi_chained_companion/u);
          assert.match(String(error), /nsm_t_pwi_chained_partition_0/u);
          return true;
        },
      );

      assert.throws(
        () =>
          new PostgresInventoryPostingService(
            database.runtimePool,
            { ...database.registration, storageTarget: target },
            { currentInstant: () => recordedAt },
          ),
        (error: unknown) => {
          assert.equal(
            observePostingError(
              testContext,
              'writer-inventory-unverified-relation',
              error,
              'INVENTORY_POSTING_STORAGE_INVALID',
            ),
            true,
          );
          assert.match(
            String(error),
            /reaches physical relations no read-back verifies/u,
          );
          // Named individually, because an operator reading the refusal needs
          // to know WHICH relation is unobserved, not merely that one is.
          assert.match(String(error), /nsm_t_pwi_unverified_companion/u);
          assert.match(String(error), /nsm_t_pwi_unverified_partition_0/u);
          return true;
        },
      );
    });
  },
);

test(
  'posting writer inventory: the movement effect reservation is observed before the posting commits',
  { timeout: 300_000 },
  async (testContext) => {
    await withPostingDatabase(async (database) => {
      await assertAbsentEffectReservationRefuses(testContext, database);
      await assertWrongEffectReservationRefuses(testContext, database);
    });
  },
);

/**
 * Install a REPLACEMENT reservation writer through the admin pool -- the
 * pattern `installLineRaceBlocker` already uses -- and disable the real one.
 *
 * WHY A REPLACEMENT RATHER THAN SIMPLY DISABLING THE REAL TRIGGER, and this was
 * measured rather than predicted. `reserve_inventory_movement_effect` does TWO
 * things on every movement insert: it writes the effect reservation, and it
 * calls `north_star_internal.advance_semantic_aggregate_generation`. The
 * posted-stock balance trigger fires later on the same insert and RAISES
 * `POSTED_STOCK_BALANCE_GENERATION_MISSING` when that generation row is absent.
 *
 * So disabling the real trigger removes both effects at once, and the posting
 * refuses from the balance trigger before the reservation read-back is ever
 * reached -- a red for the wrong reason, which certifies nothing. The
 * replacement keeps the generation advance and varies exactly ONE property:
 * what, if anything, gets reserved.
 *
 * IT IS SPLIT ACROSS TWO TRIGGERS ON PURPOSE, and this was also measured. The
 * real reservation trigger is named `nsm_g_...` and the balance trigger
 * `nsm_z_...`, so the real one wins on the name ordering PostgreSQL fires
 * same-event triggers in. A replacement named anything else may not, and the
 * first version of this helper lost that race and reproduced the same
 * wrong-reason red it was written to remove. The generation advance therefore
 * runs `BEFORE INSERT`, which precedes every `AFTER INSERT` trigger BY
 * CONSTRUCTION rather than by sorting late enough; only the companion write,
 * which needs the movement row to exist for its foreign key, stays `AFTER`.
 */
async function installReplacementReservation(
  database: PostingDatabase,
  reserve: 'nothing' | 'theWrongEffect',
): Promise<void> {
  const fact = movementFactStorage(database);
  const companion = fact.companion;
  const columns = companion.columns.map((column) => column.name);
  const values = columns.map((column) =>
    column === fact.fieldColumns.sourceLine
      ? `'reserved-wrong-line'`
      : `NEW.${quoted(column)}`,
  );
  await database.adminPool.query(
    `ALTER TABLE ${table(database.binding, database.binding.movement)}
       DISABLE TRIGGER ${quoted(companion.reservationTriggerName)};
     CREATE FUNCTION public.pwi_replacement_generation()
       RETURNS trigger LANGUAGE plpgsql AS $body$
       BEGIN
         PERFORM north_star_internal.advance_semantic_aggregate_generation(
           NEW.tenant_id, NEW.environment_id);
         RETURN NEW;
       END
       $body$;
     CREATE TRIGGER pwi_replacement_generation
       BEFORE INSERT ON ${table(database.binding, database.binding.movement)}
       FOR EACH ROW EXECUTE FUNCTION public.pwi_replacement_generation()`,
  );
  if (reserve === 'nothing') return;
  // THE WRONG-EFFECT ROW IS NOT REACHABLE WHILE THE COMPILED FOREIGN KEY
  // STANDS, and that is a finding rather than an inconvenience. The companion
  // -> movement foreign key covers ALL TEN companion columns and targets
  // exactly `effectIdentityUnique`, so a reservation whose effect tuple
  // differs from its movement's has no referent and PostgreSQL refuses it with
  // 23503. Suspending the constraint is therefore the only way to construct
  // the row at all, and this control's claim is scoped to match: it proves the
  // read-back is INDEPENDENT of that constraint, not that a wrong effect can
  // be written today.
  const foreignKey = companion.movementForeignKey;
  await database.adminPool.query(
    `ALTER TABLE ${quoted(database.binding.schemaName)}.${quoted(companion.physicalTableName)}
       DROP CONSTRAINT ${quoted(foreignKey.physicalName)}`,
  );
  await database.adminPool.query(
    `CREATE FUNCTION public.pwi_replacement_reservation()
       RETURNS trigger LANGUAGE plpgsql AS $body$
       BEGIN
         INSERT INTO ${quoted(database.binding.schemaName)}.${quoted(companion.physicalTableName)}
           (${columns.map((column) => quoted(column)).join(', ')})
         VALUES (${values.join(', ')});
         RETURN NEW;
       END
       $body$;
     CREATE TRIGGER pwi_replacement_reservation
       AFTER INSERT ON ${table(database.binding, database.binding.movement)}
       FOR EACH ROW EXECUTE FUNCTION public.pwi_replacement_reservation()`,
  );
}

async function removeReplacementReservation(
  database: PostingDatabase,
): Promise<unknown> {
  const companion = movementFactStorage(database).companion;
  await database.adminPool.query(
    `DROP TRIGGER IF EXISTS pwi_replacement_reservation
       ON ${table(database.binding, database.binding.movement)};
     DROP TRIGGER IF EXISTS pwi_replacement_generation
       ON ${table(database.binding, database.binding.movement)};
     DROP FUNCTION IF EXISTS public.pwi_replacement_reservation();
     DROP FUNCTION IF EXISTS public.pwi_replacement_generation();
     ALTER TABLE ${table(database.binding, database.binding.movement)}
       ENABLE TRIGGER ${quoted(companion.reservationTriggerName)}`,
  );
  // Restore the composite foreign key from the COMPILED declaration rather than
  // from a local copy.
  //
  // THE CLEANUP IS NOT OPTIONAL, and leaving it out made a committed expected-red
  // entry unattributable. When a mutation REMOVES the refusal this control
  // exists to observe, the posting succeeds and its wrong reservation row
  // COMMITS -- so re-adding the foreign key fails validation, and it fails
  // inside `finally`, before the test's own rejection assertion ever runs. The
  // control then reds for a foreign-key violation instead of for its declared
  // reason, which is precisely the failure `review-tiers` calls out in "Verify
  // why a red fired, not just that it fired".
  //
  // So orphaned reservations are swept first. Under normal operation the
  // refused posting rolled its row back and this deletes nothing; when it
  // deletes something, that IS the signal the refusal did not happen, and it is
  // reported rather than swallowed.
  const foreignKey = companion.movementForeignKey;
  const present = await database.adminPool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = $1
     ) AS present`,
    [foreignKey.physicalName],
  );
  if (present.rows[0]?.present === true) return;
  const orphans = await database.adminPool.query(
    `ALTER TABLE ${quoted(database.binding.schemaName)}.${quoted(companion.physicalTableName)}
       DISABLE TRIGGER ${quoted(companion.rejectMutationTriggerName)};
     DELETE FROM ${quoted(database.binding.schemaName)}.${quoted(companion.physicalTableName)} AS reservation
      WHERE NOT EXISTS (
        SELECT 1 FROM ${table(database.binding, database.binding.movement)} AS movement
         WHERE ${foreignKey.sourceColumns
           .map(
             (column, index) =>
               `movement.${quoted(foreignKey.targetColumns[index]!)} = reservation.${quoted(column)}`,
           )
           .join('\n           AND ')}
      );
     ALTER TABLE ${quoted(database.binding.schemaName)}.${quoted(companion.physicalTableName)}
       ENABLE TRIGGER ${quoted(companion.rejectMutationTriggerName)}`,
  );
  await database.adminPool.query(
    `ALTER TABLE ${quoted(database.binding.schemaName)}.${quoted(companion.physicalTableName)}
       ADD CONSTRAINT ${quoted(foreignKey.physicalName)}
       FOREIGN KEY (${foreignKey.sourceColumns.map((column) => quoted(column)).join(', ')})
       REFERENCES ${table(database.binding, database.binding.movement)}
         (${foreignKey.targetColumns.map((column) => quoted(column)).join(', ')})
       ON DELETE RESTRICT ON UPDATE RESTRICT`,
  );
  return orphans;
}

/**
 * A reservation writer that reserves NOTHING. The movement inserts, the
 * generation advances, the balance projects — and no natural effect is
 * reserved. The foreign key runs companion -> movement ON DELETE RESTRICT, so
 * a movement with no reservation row violates no constraint: without this
 * read-back the posting COMMITS, and the 23505 raced-replay refusal that
 * depends on the reservation is silently unreachable for that effect.
 */
async function assertAbsentEffectReservationRefuses(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  const posting = command({
    legalEntityId: legalReject,
    sourceId: 'reservation-absent',
  });
  await seedDraft(database, posting);
  const trustBefore = await trustCountByRequest(
    database,
    database.context.requestId,
  );
  const balanceBefore = await activeBalanceCount(database);
  await installReplacementReservation(database, 'nothing');
  let outcome: PostingOutcome;
  try {
    outcome = await settlePosting(
      database.service.postAdjustment(
        database.context,
        database.actor,
        posting,
      ),
    );
  } finally {
    await removeReplacementReservation(database);
  }
  // Named before the shared helper runs. A mutation that REMOVES this refusal
  // makes the posting succeed, and the manifest entry that kills this control
  // must be able to declare a message that actually appears -- not the refusal
  // text, which by then is exactly what is missing.
  assert.equal(
    outcome.status,
    'rejected',
    `a movement that reserved no natural effect must refuse the posting: ${JSON.stringify(outcome)}`,
  );
  assertRejectedPosting(
    testContext,
    'reservation-absent',
    outcome,
    'INVENTORY_POSTING_STORAGE_REJECTED',
  );
  assert.match(
    String(outcome.status === 'rejected' ? outcome.reason : ''),
    /did not reserve exactly one natural effect for each movement/u,
  );
  // The refusal rolls the whole posting back: no movement, no reservation, no
  // balance, no document transition, no trust evidence and no receipt.
  assert.equal(await movementCountBySource(database, posting.sourceId), 0);
  assert.equal(await companionCount(database), 0);
  assert.equal(await activeBalanceCount(database), balanceBefore);
  assert.deepEqual(await transactionState(database, posting.transactionId), {
    revision: 1,
    state: enumOption(
      field(database.binding.transaction, 'inventory_transaction_state'),
      'draft',
    ),
  });
  assert.equal(
    await trustCountByRequest(database, database.context.requestId),
    trustBefore,
  );
  assert.equal(await receiptCountByKey(database, posting.idempotencyKey), 0);
}

/**
 * A reservation writer that reserves the WRONG natural effect: the replacement
 * copies the movement faithfully except for one column of the five-column
 * effect tuple.
 *
 * SCOPE, narrowed after measurement rather than asserted. The compiled
 * companion -> movement foreign key covers ALL TEN companion columns and
 * targets exactly `effectIdentityUnique`, so a reservation carrying a wrong
 * effect tuple has no referent and the database refuses it with 23503. This
 * control must SUSPEND that constraint to construct the row at all.
 *
 * So it does NOT prove a live defect. It proves the read-back does not depend
 * on the compiled foreign key remaining exactly this wide -- if that
 * declaration ever narrows, the comparison is what still catches a reservation
 * that reserves an effect the posting did not claim. What the read-back adds
 * over the database TODAY is the reservation's EXISTENCE and its one-to-one
 * pairing with this posting's movements, which no constraint requires; that is
 * held by `assertAbsentEffectReservationRefuses`.
 */
async function assertWrongEffectReservationRefuses(
  testContext: TestContext,
  database: PostingDatabase,
): Promise<void> {
  const posting = command({
    legalEntityId: legalReject,
    sourceId: 'reservation-wrong',
  });
  await seedDraft(database, posting);
  const trustBefore = await trustCountByRequest(
    database,
    database.context.requestId,
  );
  const balanceBefore = await activeBalanceCount(database);
  await installReplacementReservation(database, 'theWrongEffect');
  let outcome: PostingOutcome;
  try {
    outcome = await settlePosting(
      database.service.postAdjustment(
        database.context,
        database.actor,
        posting,
      ),
    );
  } finally {
    await removeReplacementReservation(database);
  }
  assert.equal(
    outcome.status,
    'rejected',
    `a reservation of the wrong natural effect must refuse the posting: ${JSON.stringify(outcome)}`,
  );
  assertRejectedPosting(
    testContext,
    'reservation-wrong-effect',
    outcome,
    'INVENTORY_POSTING_STORAGE_REJECTED',
  );
  assert.match(
    String(outcome.status === 'rejected' ? outcome.reason : ''),
    /does not reserve the natural effect this posting claimed/u,
  );
  assert.equal(await movementCountBySource(database, posting.sourceId), 0);
  assert.equal(await companionCount(database), 0);
  assert.equal(await activeBalanceCount(database), balanceBefore);
  assert.equal(
    await trustCountByRequest(database, database.context.requestId),
    trustBefore,
  );
  assert.equal(await receiptCountByKey(database, posting.idempotencyKey), 0);
}

const effectRaceLockKey = 2;

/**
 * A hold point the existing `installLineRaceBlocker` cannot provide. That one
 * is `BEFORE INSERT` on the movement, which parks a posting BEFORE its
 * reservation row exists -- so a second posting finds nothing reserved and the
 * collision under measurement never happens.
 *
 * This one fires `AFTER INSERT` on the effect-reservation companion itself, so
 * the paused posting holds BOTH its movement and its reservation, uncommitted.
 * Installing it on the companion rather than on the movement makes the hold
 * point independent of trigger firing ORDER: it is reached by construction
 * when the reservation row is written, not by a name that sorts late enough.
 */
async function installEffectReservationBlocker(
  database: PostingDatabase,
  sourceId: string,
): Promise<void> {
  const fact = movementFactStorage(database);
  await database.adminPool.query(
    `CREATE FUNCTION public.pwi_wait_for_effect_race()
       RETURNS trigger LANGUAGE plpgsql AS $body$
       BEGIN
         IF NEW.${quoted(fact.fieldColumns.sourceId)} = TG_ARGV[0] THEN
           PERFORM pg_advisory_xact_lock(${String(lineRaceLockNamespace)}, ${String(effectRaceLockKey)});
         END IF;
         RETURN NEW;
       END
       $body$;
     CREATE TRIGGER pwi_wait_for_effect_race
       AFTER INSERT ON ${quoted(database.binding.schemaName)}.${quoted(fact.companion.physicalTableName)}
       FOR EACH ROW EXECUTE FUNCTION public.pwi_wait_for_effect_race('${sourceId}')`,
  );
}

async function removeEffectReservationBlocker(
  database: PostingDatabase,
): Promise<void> {
  const fact = movementFactStorage(database);
  await database.adminPool.query(
    `DROP TRIGGER IF EXISTS pwi_wait_for_effect_race
       ON ${quoted(database.binding.schemaName)}.${quoted(fact.companion.physicalTableName)};
     DROP FUNCTION IF EXISTS public.pwi_wait_for_effect_race()`,
  );
}

/**
 * The limit that has stood since PUR-2a round 1, measured rather than reasoned.
 *
 * Two authored documents claim ONE natural effect at the same instant. They
 * share neither lock the posting takes -- the stock serializer keys on
 * tenant/environment/legal entity/item/location and these carry different
 * locations, and the request lock derives from the idempotency key and these
 * carry different keys -- so nothing serialises them before the write. What
 * they collide on is the effect reservation's primary key, which omits
 * `business_period` and `record_id` and is the only natural-effect guard in the
 * system.
 *
 * The standing disclosure was worse than disclosed: round 9 found the reasoning
 * had named the movement's own `effectIdentityUnique`, which carries a freshly
 * minted `record_id` and therefore cannot collide between two postings at all.
 */
/**
 * THE OBSERVER, PROVED TO OBSERVE.
 *
 * The derivation cannot be complete on its own: the compiled target declares
 * nothing about the movement -> balance projection edge, so a writer grown by a
 * new materializer convention would appear in no target shape this service
 * reads. Round 1 was right that this is the same omission generator one level
 * up.
 *
 * The backstop is to stop asking the target what was written and ask
 * PostgreSQL. This control builds exactly the case the derivation cannot see: a
 * module relation nothing declares, written by a trigger the target knows
 * nothing about, on the movement insert. The posting must refuse and name it.
 *
 * It also closes the vacuity vector the green suite could not distinguish -- an
 * observer that sees nothing passes everything -- because a write set that
 * failed to observe this table would let the posting commit.
 */
test(
  'posting writer inventory: a module relation nothing declares is caught by observing what the posting wrote',
  { timeout: 180_000 },
  async (testContext) => {
    await withPostingDatabase(async (database) => {
      const undeclared = 'nsm_t_pwi_undeclared_writer';
      const posting = command({
        legalEntityId: legalReject,
        sourceId: 'undeclared-writer',
      });
      await seedDraft(database, posting);
      await database.adminPool.query(
        `CREATE TABLE ${quoted(database.binding.schemaName)}.${quoted(undeclared)} (
           tenant_id uuid NOT NULL, record_id uuid NOT NULL);
         GRANT INSERT ON ${quoted(database.binding.schemaName)}.${quoted(undeclared)}
           TO north_star_module_runtime;
         CREATE FUNCTION public.pwi_undeclared_writer()
           RETURNS trigger LANGUAGE plpgsql AS $body$
           BEGIN
             INSERT INTO ${quoted(database.binding.schemaName)}.${quoted(undeclared)}
               (tenant_id, record_id) VALUES (NEW.tenant_id, NEW.record_id);
             RETURN NEW;
           END
           $body$;
         CREATE TRIGGER pwi_undeclared_writer
           AFTER INSERT ON ${table(database.binding, database.binding.movement)}
           FOR EACH ROW EXECUTE FUNCTION public.pwi_undeclared_writer()`,
      );
      let outcome: PostingOutcome;
      try {
        outcome = await settlePosting(
          database.service.postAdjustment(
            database.context,
            database.actor,
            posting,
          ),
        );
      } finally {
        await database.adminPool.query(
          `DROP TRIGGER IF EXISTS pwi_undeclared_writer
             ON ${table(database.binding, database.binding.movement)};
           DROP FUNCTION IF EXISTS public.pwi_undeclared_writer();
           DROP TABLE IF EXISTS ${quoted(database.binding.schemaName)}.${quoted(undeclared)}`,
        );
      }
      assert.equal(
        outcome.status,
        'rejected',
        `a module relation no read-back verifies must refuse the posting: ${JSON.stringify(outcome)}`,
      );
      assertRejectedPosting(
        testContext,
        'undeclared-module-writer',
        outcome,
        'INVENTORY_POSTING_STORAGE_REJECTED',
      );
      const reason = String(
        outcome.status === 'rejected' ? outcome.reason : '',
      );
      assert.match(
        reason,
        /wrote module relations the compiled writer inventory does not derive/u,
      );
      // Named, so an operator learns WHICH relation rather than that one exists.
      assert.match(reason, new RegExp(undeclared, 'u'));
      // Nothing committed: the undeclared write is refused before the trust
      // document and the receipt, not reconciled afterwards.
      assert.equal(await movementCountBySource(database, posting.sourceId), 0);
      assert.equal(await companionCount(database), 0);
      assert.equal(
        await receiptCountByKey(database, posting.idempotencyKey),
        0,
      );
    });
  },
);

test(
  'posting writer inventory: two simultaneous postings of one natural effect accept exactly one',
  { timeout: 300_000 },
  async (testContext) => {
    await withPostingDatabase(async (database) => {
      const sharedSourceId = 'simultaneous-natural-effect';
      const first = command({
        legalEntityId: legalReject,
        locationId: locationPrimary,
        sourceId: sharedSourceId,
      });
      const second = command({
        legalEntityId: legalReject,
        locationId: locationRace,
        sourceId: sharedSourceId,
      });
      const firstLine = first.lines[0]!;
      const secondLine = second.lines[0]!;
      // One natural effect: the five-column tuple the reservation's primary
      // key carries is identical across the two requests.
      assert.equal(first.sourceType, second.sourceType);
      assert.equal(first.sourceId, second.sourceId);
      assert.equal(first.sourceRevision, second.sourceRevision);
      assert.equal(firstLine.sourceLine, secondLine.sourceLine);
      // Two stock identities, and therefore two disjoint serializer lock sets.
      const stockKeys = (
        input: InventoryAdjustmentPostingCommandV1,
      ): readonly number[] =>
        planStockIdentityLocks(
          input.lines.map((postingLine) => ({
            environmentId,
            itemId: postingLine.itemId,
            legalEntityId: input.legalEntityId,
            locationId: postingLine.locationId,
            tenantId,
          })),
        ).map((target) => target.identityKey);
      const firstKeys = new Set(stockKeys(first));
      assert.equal(
        stockKeys(second).some((key) => firstKeys.has(key)),
        false,
        'the two requests must not share a stock-identity lock',
      );
      // Two request keys, and therefore two disjoint request locks.
      assert.notEqual(first.idempotencyKey, second.idempotencyKey);
      assert.notEqual(
        planInventoryPostingRequestLock(
          database.context,
          postingCapabilityId,
          first.idempotencyKey,
        ).requestKey,
        planInventoryPostingRequestLock(
          database.context,
          postingCapabilityId,
          second.idempotencyKey,
        ).requestKey,
      );

      await seedDraft(database, first);
      await seedDraft(database, second);
      await installEffectReservationBlocker(database, sharedSourceId);
      const blocker = await database.adminPool.connect();
      let blockerOpen = false;
      let firstOutcome: Promise<PostingOutcome> | undefined;
      let secondOutcome: Promise<PostingOutcome> | undefined;
      try {
        await beginBoundedControlTransaction(blocker);
        blockerOpen = true;
        const blockerPid = await backendPid(blocker);
        await blocker.query(
          'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
          [lineRaceLockNamespace, effectRaceLockKey],
        );
        // The first posting parks INSIDE its reservation trigger: its movement
        // row and its reservation row both exist and neither is committed.
        firstOutcome = settlePosting(
          database.service.postAdjustment(
            database.context,
            database.actor,
            first,
          ),
        );
        const parked = await waitForPostingBlockedBy(
          database.adminPool,
          blockerPid,
          'test effect-reservation barrier',
        );
        testContext.diagnostic(
          `simultaneous-natural-effect: backend ${String(parked.pid)} holds an uncommitted movement and its uncommitted effect reservation`,
        );
        // The second posting now runs concurrently. Its pre-read cannot see
        // the uncommitted claim, so it proceeds to its own insert, where the
        // reservation primary key parks it on the first posting's transaction.
        secondOutcome = settlePosting(
          database.service.postAdjustment(
            database.context,
            database.actor,
            second,
          ),
        );
        assert.equal(
          await observeClaimWaiter(database),
          'observed',
          'the second posting never blocked on the uncommitted effect reservation; the simultaneous window was not constructed',
        );
        await blocker.query('COMMIT');
        blockerOpen = false;

        const accepted = await firstOutcome;
        assert.equal(
          accepted.status,
          'fulfilled',
          `the first posting must be accepted: ${JSON.stringify(accepted)}`,
        );
        const contested = await secondOutcome;
        // EXACTLY ONE semantic effect is accepted. The second must reach
        // replay/conflict handling; which of the two it reaches depends on
        // whether the winner's receipt is visible when the loser re-reads, and
        // both are correct outcomes. What is NOT admissible is a second
        // committed movement for the same natural effect.
        if (contested.status === 'fulfilled') {
          assert.equal(
            contested.value.replayed,
            true,
            'a second acceptance of one natural effect is not admissible',
          );
          assert.deepEqual(
            contested.value.movements.map((movement) => movement.movementId),
            accepted.value.movements.map((movement) => movement.movementId),
            'a replay must return the accepted posting movements',
          );
        } else {
          assert.equal(
            observePostingError(
              testContext,
              'simultaneous-natural-effect-conflict',
              contested.reason,
              'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
            ),
            true,
          );
        }
        testContext.diagnostic(
          `simultaneous-natural-effect: the contested posting settled as ${contested.status}`,
        );
        // One effect, one movement, one reservation.
        assert.equal(await movementCountBySource(database, sharedSourceId), 1);
        assert.equal(await companionCount(database), 1);
      } finally {
        if (blockerOpen) await blocker.query('ROLLBACK');
        blocker.release();
        if (firstOutcome) await firstOutcome;
        if (secondOutcome) await secondOutcome;
        await removeEffectReservationBlocker(database);
      }
    });
  },
);

async function installLineRaceBlocker(
  database: PostingDatabase,
  sourceId: string,
): Promise<void> {
  const sourceIdColumn = field(
    database.binding.movement,
    'inventory_movement_source_id',
  ).physicalName;
  await database.adminPool.query(
    `CREATE FUNCTION public.g3p3_wait_for_line_race()
       RETURNS trigger LANGUAGE plpgsql AS $body$
       BEGIN
         IF NEW.${quoted(sourceIdColumn)} = TG_ARGV[0] THEN
           PERFORM pg_advisory_xact_lock(${String(lineRaceLockNamespace)}, ${String(lineRaceLockKey)});
         END IF;
         RETURN NEW;
       END
       $body$;
     CREATE TRIGGER g3p3_wait_for_line_race
       BEFORE INSERT ON ${table(database.binding, database.binding.movement)}
       FOR EACH ROW EXECUTE FUNCTION public.g3p3_wait_for_line_race('${sourceId}')`,
  );
}

async function removeLineRaceBlocker(database: PostingDatabase): Promise<void> {
  await database.adminPool.query(
    `DROP TRIGGER IF EXISTS g3p3_wait_for_line_race
       ON ${table(database.binding, database.binding.movement)};
     DROP FUNCTION IF EXISTS public.g3p3_wait_for_line_race()`,
  );
}

async function beginModuleTransaction(
  database: PostingDatabase,
): Promise<PoolClient> {
  const client = await database.runtimePool.connect();
  try {
    await beginBoundedControlTransaction(client);
    await client.query(
      `SELECT set_config('north_star.tenant_id',$1,true),
              set_config('north_star.environment_id',$2,true),
              set_config('north_star.principal_id',$3,true),
              set_config('north_star.request_id',$4,true)`,
      [
        database.context.tenantId,
        database.context.environmentId,
        database.context.principalId,
        database.context.requestId,
      ],
    );
    await client.query('SET LOCAL ROLE north_star_module_runtime');
    return client;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    throw error;
  }
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>(
    'SELECT pg_backend_pid() AS pid',
  );
  const pid = result.rows[0]?.pid;
  assert.ok(Number.isInteger(pid));
  return pid!;
}

async function waitForPostingBlockedBy(
  observer: Pool,
  blockerPid: number,
  subject: string,
): Promise<{ pid: number; query: string; waitEvent: string }> {
  const deadline = process.hrtime.bigint() + 10_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    const result = await observer.query<{
      pid: number;
      query: string;
      waitEvent: string;
    }>(
      `SELECT activity.pid, activity.query,
              activity.wait_event AS "waitEvent"
         FROM pg_catalog.pg_stat_activity AS activity
        WHERE activity.application_name=$1
          AND activity.wait_event_type='Lock'
          AND $2::integer = ANY(pg_catalog.pg_blocking_pids(activity.pid))
        ORDER BY activity.pid
        LIMIT 1`,
      [postingApplicationName, blockerPid],
    );
    if (result.rows[0]) return result.rows[0];
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  throw new Error(`posting did not block on ${subject}`);
}

async function waitForPostingLockWaiters(
  observer: Pool,
  expected: number,
): Promise<Array<{ pid: number; query: string; waitEvent: string }>> {
  const deadline = process.hrtime.bigint() + 10_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    const result = await observer.query<{
      pid: number;
      query: string;
      waitEvent: string;
    }>(
      `SELECT activity.pid, activity.query,
              activity.wait_event AS "waitEvent"
         FROM pg_catalog.pg_stat_activity AS activity
        WHERE activity.application_name=$1
          AND activity.wait_event_type='Lock'
        ORDER BY activity.pid`,
      [postingApplicationName],
    );
    if (result.rows.length >= expected) return result.rows;
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  throw new Error(
    `expected ${String(expected)} concurrent posting lock waiters`,
  );
}

async function waitForExactAdvisoryLock(
  observer: Pool,
  pid: number,
  namespace: number,
  key: number,
  granted: boolean,
): Promise<boolean> {
  const deadline = process.hrtime.bigint() + 10_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    if (await holdsExactAdvisoryLock(observer, pid, namespace, key, granted)) {
      return true;
    }
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  throw new Error(
    `backend ${String(pid)} did not expose advisory lock ${String(namespace)}/${String(key)} granted=${String(granted)}`,
  );
}

async function waitForAnyStockLockWait(
  observer: Pool,
  identityKeys: readonly number[],
  signal: AbortSignal,
): Promise<void> {
  const deadline = process.hrtime.bigint() + 10_000_000_000n;
  const unsignedKeys = identityKeys.map(unsignedInt32);
  while (process.hrtime.bigint() < deadline) {
    if (signal.aborted) throw new Error('stock-lock wait observation aborted');
    const result = await observer.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_locks
          WHERE locktype='advisory' AND NOT granted AND objsubid=2
            AND classid::bigint=$1::bigint
            AND objid::bigint=ANY($2::bigint[])
       ) AS present`,
      [unsignedInt32(STOCK_IDENTITY_LOCK_NAMESPACE), unsignedKeys],
    );
    if (result.rows[0]?.present) return;
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  throw new Error('opposite transfers did not expose a shared first-lock wait');
}

async function assertStockLockHeld(
  observer: Pool,
  postingPid: number,
  commands: readonly InventoryAdjustmentPostingCommandV1[],
): Promise<void> {
  const expectedKeys = planStockIdentityLocks(
    commands.flatMap((command) =>
      command.lines.map((postingLine) => ({
        environmentId,
        itemId: postingLine.itemId,
        legalEntityId: command.legalEntityId,
        locationId: postingLine.locationId,
        tenantId,
      })),
    ),
  ).map((target) => unsignedInt32(target.identityKey));
  const result = await observer.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_catalog.pg_locks
      WHERE pid=$1 AND locktype='advisory' AND granted
        AND objsubid=2 AND classid::bigint=$2::bigint
        AND objid::bigint=ANY($3::bigint[])`,
    [postingPid, unsignedInt32(STOCK_IDENTITY_LOCK_NAMESPACE), expectedKeys],
  );
  assert.ok(Number(result.rows[0]?.count ?? 0) >= 1);
}

async function holdsExactAdvisoryLock(
  observer: Pool,
  postingPid: number,
  namespace: number,
  key: number,
  granted: boolean,
): Promise<boolean> {
  const result = await observer.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_catalog.pg_locks
        WHERE pid=$1 AND locktype='advisory' AND granted=$2
          AND objsubid=2 AND classid::bigint=$3::bigint
          AND objid::bigint=$4::bigint
     ) AS present`,
    [postingPid, granted, unsignedInt32(namespace), unsignedInt32(key)],
  );
  return result.rows[0]?.present ?? false;
}

function unsignedInt32(value: number): number {
  return value < 0 ? value + 2 ** 32 : value;
}

interface LockTimeoutSetting {
  backendPid: number;
  lockTimeout: string;
  milliseconds: string;
}

async function readLockTimeoutSetting(
  client: PoolClient,
): Promise<LockTimeoutSetting> {
  const result = await client.query<LockTimeoutSetting>(
    `SELECT pg_backend_pid() AS "backendPid",
            current_setting('lock_timeout') AS "lockTimeout",
            setting AS milliseconds
       FROM pg_catalog.pg_settings
      WHERE name='lock_timeout'`,
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function borrowLockTimeoutSetting(
  pool: Pool,
): Promise<LockTimeoutSetting> {
  const client = await pool.connect();
  try {
    return await readLockTimeoutSetting(client);
  } finally {
    client.release();
  }
}

async function setSessionLockTimeout(
  pool: Pool,
  milliseconds: string,
): Promise<LockTimeoutSetting> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('lock_timeout', $1::text, false)", [
      milliseconds,
    ]);
    return await readLockTimeoutSetting(client);
  } finally {
    client.release();
  }
}

async function beginBoundedControlTransaction(
  client: PoolClient,
): Promise<void> {
  await client.query('BEGIN');
  await client.query("SELECT set_config('lock_timeout', $1::text, true)", [
    concurrencyControlLockTimeout,
  ]);
}

async function withModuleRole<T>(
  pool: Pool,
  context: TrustedRequestContext,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await beginBoundedControlTransaction(client);
    await client.query(
      `SELECT set_config('north_star.tenant_id',$1,true),
              set_config('north_star.environment_id',$2,true),
              set_config('north_star.principal_id',$3,true),
              set_config('north_star.request_id',$4,true)`,
      [
        context.tenantId,
        context.environmentId,
        context.principalId,
        context.requestId,
      ],
    );
    await client.query('SET LOCAL ROLE north_star_module_runtime');
    const value = await run(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function actorEnvelope(
  context: TrustedRequestContext,
  approver: string | null,
) {
  return new TrustedActorEnvelopeIssuer({
    resolve: async () => ({
      approvingHumanId: approver,
      delegation: null,
      executionPrincipal: { kind: 'HUMAN', principalId },
      initiatingHumanId: principalId,
      subject: null,
    }),
  }).issue(context);
}

async function trustedContext(): Promise<TrustedRequestContext> {
  const identity: AuthenticatedIdentity = {
    environmentId,
    principalId,
    tenantId,
  };
  return new AuthenticatedRequestEntryAdapter(async () => identity).enter({
    headers: { authorization: 'inventory-posting' },
  });
}

async function loadInventoryDefinition(): Promise<Record<string, unknown>> {
  const [loaded, applicationBuilder]: unknown[] = await Promise.all([
    import(inventoryModuleImport),
    import(applicationBuilderImport),
  ]);
  assert.ok(isRecord(loaded));
  assert.ok(isRecord(applicationBuilder));
  assert.equal(typeof loaded.inventoryModuleDefinition, 'function');
  assert.equal(
    typeof applicationBuilder.composedApplicationDefinition,
    'function',
  );
  assert.equal(typeof applicationBuilder.APPLICATION_NAMESPACE, 'string');
  const definition = (
    applicationBuilder.composedApplicationDefinition as () => unknown
  )();
  const inventory = (
    loaded.inventoryModuleDefinition as (namespace: string) => unknown
  )(String(applicationBuilder.APPLICATION_NAMESPACE));
  assert.ok(isRecord(definition));
  assert.ok(isRecord(inventory));
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
  ]) {
    assert.ok(Array.isArray(definition[collection]));
    assert.ok(Array.isArray(inventory[collection]));
    const composedEntries = definition[collection] as unknown[];
    const inventoryEntries: readonly unknown[] = inventory[
      collection
    ] as readonly unknown[];
    assertComposedInventoryCollection(
      collection,
      composedEntries,
      inventoryEntries,
      String(applicationBuilder.APPLICATION_NAMESPACE),
    );
  }
  assert.ok(Array.isArray(definition.modules));
  assert.ok(Array.isArray(inventory.modules));
  const inventoryModules = inventory.modules as unknown[];
  const inventoryModule = inventoryModules[0];
  assert.ok(isRecord(inventoryModule));
  assert.ok(isRecord(definition.package));
  assert.equal(
    definition.modules.filter(
      (candidate) =>
        isRecord(candidate) && candidate.moduleId === inventoryModule.moduleId,
    ).length,
    1,
    'composed application must contain the inventory module exactly once',
  );
  return definition;
}

function emptyDefinitionFrom(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const definition = structuredClone(source);
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
    profile: profileForNormalizedBytes(definitionBytes(definition)),
  };
}

function mustCompile(input: CompilerInput): CompileSuccess {
  const result = compileApplication(input);
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function projectionPayload<T>(
  compiled: CompileSuccess,
  familyId: string,
): { contentHash: string; payload: T } {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === reference.artifactRoot,
  );
  assert.ok(manifestArtifact);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as { chunks: Array<{ contentHash: string }> };
  const chunk = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === manifest.chunks[0]?.contentHash,
  );
  assert.ok(chunk);
  return {
    contentHash: chunk.contentHash,
    payload: JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T,
  };
}

async function persistSequence(
  runtimePool: Pool,
  context: TrustedRequestContext,
  entries: ReadonlyArray<readonly [CompileSuccess, Record<string, unknown>]>,
): Promise<MintedUuid[]> {
  const repository = new PostgresImmutableReleaseRepository(runtimePool);
  const releases: MintedUuid[] = [];
  for (const [compiled, definition] of entries) {
    const revisionId = randomUUID() as MintedUuid;
    const releaseId = randomUUID() as MintedUuid;
    const desiredState = definitionBytes(definition);
    await repository.storeAppPackageRevision(
      context,
      revisionCommand(context, revisionId, desiredState),
    );
    const staged = await repository.stageTenantReleaseCandidate(context, {
      appPackageRevisionId: revisionId,
      compiledRelease: compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId,
      tenantId: context.tenantId,
    });
    if (releaseVerificationBinding(compiled).plan.scenarios.length === 0) {
      await new PostgresReleaseVerificationService(
        runtimePool,
      ).executeSemanticCandidateAndPersist(context, {
        compiledRelease: compiled,
        evidenceId: staged.verificationEvidenceId,
        releaseId,
      });
      await repository.registerTenantRelease(
        context,
        releaseCommand(
          context,
          releaseId,
          revisionId,
          staged.verificationEvidenceId,
          compiled,
        ),
      );
    }
    releases.push(releaseId);
  }
  return releases;
}

function revisionCommand(
  context: TrustedRequestContext,
  revisionId: MintedUuid,
  desiredState: Uint8Array,
): StoreAppPackageRevisionCommand {
  const normalized = parseNormalizedApplicationPackageJson(desiredState);
  const digest = canonicalizeAndHash(normalized);
  return {
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    contentHash: digest.contentHash,
    createdBy: context.principalId,
    desiredState,
    hashAlgorithm: CONTENT_HASH_ALGORITHM,
    languageVersion: normalized.languageVersion,
    normalizationProfileVersion: normalized.normalizationProfileVersion,
    parentRevisionId: null,
    provenance: 'firstParty',
    revisionId,
    schemaVersion: normalized.schemaVersion,
    tenantId: context.tenantId,
  };
}

function releaseCommand(
  context: TrustedRequestContext,
  releaseId: MintedUuid,
  revisionId: MintedUuid,
  evidenceId: MintedUuid,
  compiledRelease: CompileSuccess,
): RegisterTenantReleaseCommand<CompileSuccess> {
  return {
    appPackageRevisionId: revisionId,
    compiledRelease,
    createdBy: context.principalId,
    environmentId: context.environmentId,
    releaseId,
    tenantId: context.tenantId,
    verificationEvidenceId: evidenceId,
  };
}

async function setPointer(pool: Pool, releaseId: MintedUuid): Promise<void> {
  await pool.query(
    'ALTER TABLE platform.active_release_pointers DISABLE TRIGGER active_release_pointer_exact_swap',
  );
  try {
    const result = await pool.query(
      `UPDATE platform.active_release_pointers SET release_id=$3, fence=fence+1
        WHERE tenant_id=$1 AND environment_id=$2`,
      [tenantId, environmentId, releaseId],
    );
    assert.equal(result.rowCount, 1);
  } finally {
    await pool.query(
      'ALTER TABLE platform.active_release_pointers ENABLE TRIGGER active_release_pointer_exact_swap',
    );
  }
}

async function grantExecutorAuthority(pool: Pool): Promise<void> {
  await pool.query(
    'SELECT platform.set_release_executor_authority($1,$2,true,$2,$3)',
    [tenantId, principalId, randomUUID()],
  );
}

function field(entity: TestEntityBinding, localId: string) {
  const value = entity.fields.get(localId);
  assert.ok(value, `missing field ${localId}`);
  return value;
}

function enumOption(
  column: StorageEntityTarget['columns'][number],
  suffix: string,
): string {
  const options = column.fieldContract.enumOptionIds.filter((option) =>
    option.endsWith(`_${suffix}`),
  );
  assert.equal(options.length, 1);
  return options[0]!;
}

function localField(column: StorageEntityTarget['columns'][number]): string {
  return column.canonicalFieldId.split(':field.').at(-1)!;
}

function table(binding: TestStorageBinding, entity: TestEntityBinding): string {
  return `${quoted(binding.schemaName)}.${quoted(entity.tableName)}`;
}

function quoted(identifier: string): string {
  assert.match(identifier, /^[a-z][a-z0-9_]{0,62}$/u);
  return `"${identifier}"`;
}

function objectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeys);
  if (!isRecord(value)) return [];
  return [...Object.keys(value), ...Object.values(value).flatMap(objectKeys)];
}

function semanticFieldIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(semanticFieldIds);
  if (!isRecord(value)) return [];
  return [
    ...(typeof value.fieldId === 'string' ? [value.fieldId] : []),
    ...Object.values(value).flatMap(semanticFieldIds),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function postingCode(error: unknown): string | undefined {
  return error instanceof InventoryPostingError ? error.code : undefined;
}

function postingDetail(error: unknown, key: string): string | undefined {
  if (!(error instanceof InventoryPostingError)) return undefined;
  return error.details[key];
}

function observePostingError(
  testContext: TestContext,
  label: string,
  error: unknown,
  expectedCode: string,
): boolean {
  const code = postingCode(error);
  testContext.diagnostic(`${label}: ${code ?? 'unknown'} ${String(error)}`);
  return code === expectedCode;
}

function observePostgresError(
  testContext: TestContext,
  label: string,
  error: unknown,
  expectedCode: string,
): boolean {
  const code = postgresCode(error);
  testContext.diagnostic(`${label}: ${code ?? 'unknown'} ${String(error)}`);
  return code === expectedCode;
}

function postgresCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
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
