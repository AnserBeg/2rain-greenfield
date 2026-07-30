import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  type InventoryPostingRegistrationV1,
  type InventoryTransferLineV1,
  type InventoryTransferPostingCommandV1,
} from '../../packages/postgres-provider/src/inventory-posting-service.js';
import {
  planStockIdentityLocks,
  STOCK_IDENTITY_LOCK_NAMESPACE,
} from '../../packages/postgres-provider/src/stock-serializer.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { PostgresModuleStorageMaterializer } from '../../packages/postgres-provider/src/module-storage-materializer.js';
import {
  PostgresReleaseVerificationService,
  releaseVerificationBinding,
} from '../../packages/postgres-provider/src/release-verification-service.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { TrustedActorEnvelopeIssuer } from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

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
      await assertSameInstantMovementIdTieBreak(testContext, database);
      await assertQuantityOnlyEvidence(testContext, database, posted);
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
    transferApprovalThreshold: '1',
  });
  const approval = transferCommand({
    legalEntityId: legalApproval,
    quantity: '2',
    sourceId: '10-transfer-approval',
  });
  await seedTransferDraft(database, approval);
  await assert.rejects(
    database.service.postTransfer(database.context, database.actor, approval),
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
        approval,
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
  assert.ok(movement.entity.factStorage);
  const periodLock = bind('inventory_period_lock');
  assert.ok(periodLock.entity.periodLock);
  return {
    companionTableName: movement.entity.factStorage.companion.physicalTableName,
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
  result: Awaited<
    ReturnType<PostgresInventoryPostingService['postAdjustment']>
  >,
): Promise<void> {
  const movement = await database.adminPool.query<{ document: unknown }>(
    `SELECT to_jsonb(fact) AS document
       FROM ${table(database.binding, database.binding.movement)} AS fact
      WHERE record_id=$1`,
    [result.movements[0]!.movementId],
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
  for (const document of [
    movement.rows[0]?.document,
    result,
    audit.rows[0]?.document,
    event.rows[0]?.document,
    outbox.rows[0]?.document,
  ]) {
    assert.ok(document !== undefined);
    assertNoMonetaryKeys(document);
  }
  assert.throws(() => assertNoMonetaryKeys({ unitCost: '1.00' }), /unitCost/u);
  testContext.diagnostic(
    'quantity-only parser red: ERR_ASSERTION monetary keys: unitCost',
  );
}

function assertNoMonetaryKeys(document: unknown): void {
  const forbidden = objectKeys(document).filter((key) =>
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
    definition[collection] = [
      ...(definition[collection] as unknown[]),
      ...(inventory[collection] as unknown[]),
    ];
  }
  assert.ok(Array.isArray(definition.modules));
  assert.ok(Array.isArray(inventory.modules));
  assert.ok(isRecord(inventory.modules[0]));
  assert.ok(isRecord(definition.package));
  definition.modules.push({
    ...inventory.modules[0],
    orderKey: 40,
    ownerPackageId: definition.package.packageId,
  });
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
    profile: { ...MODULE_COMPILER_PROFILE },
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
