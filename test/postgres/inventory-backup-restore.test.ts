import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

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
import {
  INVENTORY_CONTRACT_V1,
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT as DECLARED_DEPENDENCY_ROOT,
} from '../../packages/domain/src/inventory/contracts.js';
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import {
  INVENTORY_POSTING_CAPABILITY_VERSION,
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  PostgresInventoryPostingService,
  type InventoryAdjustmentPostingCommandV1,
  type InventoryPostingRegistrationV1,
  type InventoryStockCountPostingCommandV1,
  type InventoryTransferPostingCommandV1,
} from '../../packages/postgres-provider/src/inventory-posting-service.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import {
  type AggregateCacheObservation,
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
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryGateway,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const execFileAsync = promisify(execFile);
const migrations = resolve('db/migrations');

const tenantId = '19000000-0000-4000-8000-000000000001';
const environmentId = '29000000-0000-4000-8000-000000000002';
const legalEntityId = '39000000-0000-4000-8000-000000000003';
const principalId = '79000000-0000-4000-8000-000000000007';
const itemStock = '49000000-0000-4000-8000-000000000004';
const itemMoved = '49000000-0000-4000-8000-000000000005';
const locationMain = '59000000-0000-4000-8000-000000000006';
const locationFrom = '59000000-0000-4000-8000-000000000007';
const locationTo = '59000000-0000-4000-8000-000000000008';

/**
 * Every movement in the seeded history is recorded at this instant, so the
 * business-period arithmetic the posting service applies is fixed rather than
 * sampled from the wall clock (AGENTS.md section 6).
 */
const recordedAt = '2026-08-04T13:00:00.000Z';
const recordedAtHorizon = '2026-08-05T00:00:00.000Z';
const maximumBackdateDays = 30;

const derivedStoreSchema = 'north_star_internal';

/**
 * The read models this packet rebuilds. Ordered for deletion: the discrepancy
 * table carries a RESTRICT foreign key onto the anchors it explains.
 * `assertDerivedStoreRosterIsComplete` refuses to run if a fourth
 * semantic-aggregate store ever lands, so the roster cannot silently
 * under-clear.
 */
const derivedStores = Object.freeze([
  'semantic_aggregate_anchor_discrepancies',
  'semantic_aggregate_anchors',
  'semantic_aggregate_generations',
]);

type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];

interface EntityBinding {
  readonly entity: StorageEntityTarget;
  readonly fields: ReadonlyMap<string, StorageEntityTarget['columns'][number]>;
  readonly legalEntityColumn: string | null;
  readonly recordIdColumn: string;
  readonly tableName: string;
}

interface StorageBinding {
  readonly item: EntityBinding;
  readonly legalEntity: EntityBinding;
  readonly location: EntityBinding;
  readonly movement: EntityBinding;
  readonly schemaName: string;
  readonly stockCount: EntityBinding;
  readonly stockCountLine: EntityBinding;
  readonly storageTarget: StorageTargetPayloadV1;
  readonly transaction: EntityBinding;
  readonly transactionLine: EntityBinding;
}

interface Fixture {
  readonly empty: CompileSuccess;
  readonly emptyDefinition: Record<string, unknown>;
  readonly inventory: CompileSuccess;
  readonly inventoryDefinition: Record<string, unknown>;
  readonly storage: StorageTargetPayloadV1;
  readonly storageContentHash: string;
}

interface BalanceProbe {
  readonly atTime: string;
  readonly id: string;
  readonly itemId: string;
  readonly locationId: string;
}

interface ServedBalance {
  readonly bytes: Uint8Array;
  readonly cacheKinds: readonly string[];
  readonly probeId: string;
  readonly queryId: string;
}

interface RelationCensus {
  readonly relation: string;
  readonly rows: string;
}

interface DockerOutcome {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface OnHandBinding {
  readonly atTime: string;
  readonly itemId: string;
  readonly legalEntityId: string;
  readonly locationId: string;
  readonly queryId: string;
  readonly recordedAtHorizon: string;
}

interface ReadSeat {
  readonly gateway: SemanticQueryGateway;
  readonly observations: AggregateCacheObservation[];
  readonly onHand: OnHandBinding;
  readonly runtimePool: Pool;
  readonly view: RequestRuntimeView;
}

/**
 * Effective-time horizons chosen so the adjustments, the transfer and the two
 * stock-count postings each move at least one probe. `empty-stock` is the
 * deliberate zero, and `assertSameBalances` refuses a comparison in which every
 * probe reads zero, so the zero probe cannot make the set vacuous.
 */
const balanceProbes: readonly BalanceProbe[] = Object.freeze([
  Object.freeze({
    atTime: '2026-07-24T00:00:00.000Z',
    id: 'main-early',
    itemId: itemStock,
    locationId: locationMain,
  }),
  Object.freeze({
    atTime: '2026-07-26T00:00:00.000Z',
    id: 'main-after-second-adjustment',
    itemId: itemStock,
    locationId: locationMain,
  }),
  Object.freeze({
    atTime: '2026-07-27T12:00:00.000Z',
    id: 'main-after-initial-count',
    itemId: itemStock,
    locationId: locationMain,
  }),
  Object.freeze({
    atTime: '2026-08-01T00:00:00.000Z',
    id: 'main-final',
    itemId: itemStock,
    locationId: locationMain,
  }),
  Object.freeze({
    atTime: '2026-08-01T00:00:00.000Z',
    id: 'transfer-source',
    itemId: itemMoved,
    locationId: locationFrom,
  }),
  Object.freeze({
    atTime: '2026-08-01T00:00:00.000Z',
    id: 'transfer-destination',
    itemId: itemMoved,
    locationId: locationTo,
  }),
  Object.freeze({
    atTime: '2026-08-01T00:00:00.000Z',
    id: 'empty-stock',
    itemId: itemStock,
    locationId: locationTo,
  }),
]);

/**
 * An independent oracle over the authored history, so the two sides of the
 * comparison are anchored to a stated expectation rather than only to each
 * other. A shared bug that moved both sides equally would still fail here.
 */
const expectedSourceBalances: readonly string[] = Object.freeze([
  '10.5',
  '14.75',
  '15',
  '14',
  '4',
  '3',
  '0',
]);

test(
  'a restored backup with the aggregate read models cleared and rebuilt serves byte-identical balances',
  { timeout: 600_000 },
  async (testContext) => {
    const fixture = await compiledFixture();
    const binding = storageBinding(fixture.storage);
    const movementRelation = `${binding.schemaName}.${binding.movement.tableName}`;
    const recordedReds: string[] = [];

    await withEphemeralPostgres('g3-r3-backup-restore', async (database) => {
      await migrateAndProvision(database.pool, fixture.inventory.releaseRoot);
      const sourceRuntimePool = new pg.Pool({
        ...database.connection,
        application_name: 'g3-r3-source',
        max: 4,
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
        const releases = await persistSequence(sourceRuntimePool, context, [
          [fixture.empty, fixture.emptyDefinition],
          [fixture.inventory, fixture.inventoryDefinition],
        ]);
        await setPointer(database.pool, releases[0]!);
        await grantExecutorAuthority(database.pool);
        const prepared = await new PostgresModuleStorageMaterializer(
          materializerPool,
          moduleRuntimePool,
        ).prepare({
          context,
          expiresAt: '2099-01-01T00:00:00.000Z',
          generationId: randomUUID(),
          initiatedBy: principalId,
          preparationId: randomUUID(),
          targetReleaseId: releases[1]!,
        });
        assert.equal(prepared.schemaState, 'APPLIED');
        await setPointer(database.pool, releases[1]!);
        await seedFoundation(sourceRuntimePool, context, binding);
        await assertDerivedStoreRosterIsComplete(database.pool);

        const registration: InventoryPostingRegistrationV1 = {
          capabilityId: INVENTORY_CONTRACT_V1.capabilityId,
          capabilityVersion: INVENTORY_POSTING_CAPABILITY_VERSION,
          dependencySetRoot: DECLARED_DEPENDENCY_ROOT,
          releaseContentHash: fixture.inventory.releaseRoot,
          releaseId: releases[1]!,
          storageTarget: fixture.storage,
          storageTargetContentHash: fixture.storageContentHash,
        };
        assert.equal(
          DECLARED_DEPENDENCY_ROOT,
          INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
        );
        const service = new PostgresInventoryPostingService(
          sourceRuntimePool,
          registration,
          { currentInstant: () => recordedAt },
        );
        const actor = await actorEnvelope(context);

        // Backup one: taken before any posting exists, so restoring it is a
        // genuine restore that carries no history at all.
        const beforeHistoryBackup = await backup(
          database.containerName,
          'before-history',
        );

        await postAdjustment(service, context, actor, {
          effectiveAt: '2026-07-20T09:00:00.000Z',
          itemId: itemStock,
          locationId: locationMain,
          quantityDelta: '10.5',
          sourceId: 'g3-r3-adjustment-1',
        });
        await postAdjustment(service, context, actor, {
          effectiveAt: '2026-07-21T09:00:00.000Z',
          itemId: itemMoved,
          locationId: locationFrom,
          quantityDelta: '7',
          sourceId: 'g3-r3-adjustment-2',
        });
        await postAdjustment(service, context, actor, {
          effectiveAt: '2026-07-25T09:00:00.000Z',
          itemId: itemStock,
          locationId: locationMain,
          quantityDelta: '4.25',
          sourceId: 'g3-r3-adjustment-3',
        });
        await postTransfer(service, context, actor, {
          effectiveAt: '2026-07-26T09:00:00.000Z',
          quantity: '3',
          sourceId: 'g3-r3-transfer-1',
        });
        const initialCount = await postStockCount(service, context, actor, {
          countedQuantity: '15',
          effectiveAt: '2026-07-27T09:00:00.000Z',
          expectedQuantity: '14.75',
          kind: 'initial',
          sequence: 1,
          supersedesStockCountId: null,
          varianceQuantity: '0.25',
        });
        assert.equal(initialCount.movements[0]?.postingRole, 'count');

        // Backup two: taken with the correction still unposted, so restoring
        // it is a restore that lost exactly one movement.
        const missingOneMovementBackup = await backup(
          database.containerName,
          'missing-one-movement',
        );

        // The correction's variance is a whole number because
        // `canonicalDecimalPattern` (inventory-posting-service.ts:52) admits no
        // negative value with a zero integer part: `-0.5` is refused as
        // non-canonical. Recorded as a finding; not this packet's to fix.
        const correction = await postStockCount(service, context, actor, {
          countedQuantity: '14',
          effectiveAt: '2026-07-28T09:00:00.000Z',
          expectedQuantity: '15',
          kind: 'correction',
          sequence: 2,
          supersedesStockCountId: initialCount.stockCountId,
          varianceQuantity: '-1',
        });
        assert.equal(correction.movements[0]?.postingRole, 'correction');
        assert.equal(correction.movements[0]?.quantityDelta, '-1');

        const sourceSeat = await openReadSeat(
          database.connection,
          'postgres',
          'g3-r3-source-read',
        );
        let sourceBalances: ServedBalance[];
        try {
          sourceBalances = await observeBalances(sourceSeat);
          assert.deepEqual(
            sourceBalances.map((entry) => decode(entry.bytes)),
            expectedSourceBalances,
            'the authored history must serve the independently stated balances before anything is backed up',
          );
          assertRebuiltFromLedger(sourceBalances, 'source');
          assertDerivedStoresPopulated(
            await derivedStoreCensus(database.pool),
            'source',
          );
        } finally {
          await sourceSeat.runtimePool.end();
        }

        // Backup three: the complete subject, taken after the balances above
        // were served, so it carries both the ledger and the read models.
        const completeBackup = await backup(database.containerName, 'complete');
        const sourceCensus = await relationCensus(database.pool);
        const sourceMovements = requiredRelation(
          sourceCensus,
          movementRelation,
        );

        recordRed(
          recordedReds,
          'empty-comparison',
          'G3_R3_ZERO_BALANCES_OBSERVED: the restore comparison requires at least one served balance on each side',
          () => {
            assertSameBalances([], []);
          },
        );
        recordRed(
          recordedReds,
          'numerically-equal-but-reformatted',
          'G3_R3_BALANCE_BYTES_CHANGED: main-early before=10.5 after=10.50',
          () => {
            assertSameBalances(sourceBalances, reformatFirst(sourceBalances));
          },
        );

        await withRestoredDatabase(
          database,
          beforeHistoryBackup,
          'g3_r3_restored_before_history',
          async (restored) => {
            const restoredCensus = await relationCensus(
              restored.administrativePool,
            );
            recordRed(
              recordedReds,
              'restore-restored-nothing',
              `G3_R3_RESTORE_RESTORED_NO_HISTORY: ${movementRelation} source=${sourceMovements.rows} restored=0`,
              () => {
                assertRestoreCarriedTheHistory(
                  sourceCensus,
                  restoredCensus,
                  movementRelation,
                );
              },
            );
            const seat = await openReadSeat(
              database.connection,
              'g3_r3_restored_before_history',
              'g3-r3-before-history-read',
            );
            try {
              const emptyBalances = await observeBalances(seat);
              recordRed(
                recordedReds,
                'every-balance-zero',
                'G3_R3_BALANCE_SET_DEGENERATE: every compared balance is zero, so agreement observes nothing',
                () => {
                  assertSameBalances(emptyBalances, emptyBalances);
                },
              );
            } finally {
              await seat.runtimePool.end();
            }
          },
        );

        await withRestoredDatabase(
          database,
          missingOneMovementBackup,
          'g3_r3_restored_missing_movement',
          async (restored) => {
            const damagedCensus = await relationCensus(
              restored.administrativePool,
            );
            assert.equal(
              Number(sourceMovements.rows) -
                Number(requiredRelation(damagedCensus, movementRelation).rows),
              1,
              'the damaged restore must be missing exactly one movement',
            );
            await rebuildDerivedStores(restored.administrativePool);
            const seat = await openReadSeat(
              database.connection,
              'g3_r3_restored_missing_movement',
              'g3-r3-missing-movement-read',
            );
            try {
              const damagedBalances = await observeBalances(seat);
              assertRebuiltFromLedger(damagedBalances, 'missing-one-movement');
              recordRed(
                recordedReds,
                'one-movement-dropped',
                'G3_R3_BALANCE_BYTES_CHANGED: main-final before=14 after=15',
                () => {
                  assertSameBalances(sourceBalances, damagedBalances);
                },
              );
            } finally {
              await seat.runtimePool.end();
            }
          },
        );

        await withRestoredDatabase(
          database,
          completeBackup,
          'g3_r3_restored_complete',
          async (restored) => {
            assertRestoreCarriedTheHistory(
              sourceCensus,
              await relationCensus(restored.administrativePool),
              movementRelation,
            );
            await assertDerivedStoreRosterIsComplete(
              restored.administrativePool,
            );

            const beforeClear = await derivedStoreCensus(
              restored.administrativePool,
            );
            assertDerivedStoresPopulated(beforeClear, 'restored');
            recordRed(
              recordedReds,
              'rebuild-did-not-clear',
              `G3_R3_DERIVED_STORE_NOT_EMPTY: ${derivedStoreSchema}.semantic_aggregate_anchors still holds rows where the rebuild requires none`,
              () => {
                assertDerivedStoresEmpty(beforeClear);
              },
            );

            const cachedSeat = await openReadSeat(
              database.connection,
              'g3_r3_restored_complete',
              'g3-r3-cached-read',
            );
            try {
              const cachedBalances = await observeBalances(cachedSeat);
              recordRed(
                recordedReds,
                'served-from-surviving-cache',
                'G3_R3_BALANCE_SERVED_FROM_SURVIVING_CACHE: restored-before-clear main-early observed cache-hit',
                () => {
                  assertRebuiltFromLedger(
                    cachedBalances,
                    'restored-before-clear',
                  );
                },
              );
            } finally {
              await cachedSeat.runtimePool.end();
            }

            await rebuildDerivedStores(restored.administrativePool);
            const afterClear = await derivedStoreCensus(
              restored.administrativePool,
            );
            assertDerivedStoresEmpty(afterClear);
            testContext.diagnostic(
              `G3-R3 derived stores between clear and read: ${afterClear
                .map((entry) => `${entry.relation}=${entry.rows}`)
                .join(' ')}`,
            );

            const rebuiltSeat = await openReadSeat(
              database.connection,
              'g3_r3_restored_complete',
              'g3-r3-rebuilt-read',
            );
            try {
              const rebuiltBalances = await observeBalances(rebuiltSeat);
              assertRebuiltFromLedger(rebuiltBalances, 'restored-and-rebuilt');
              assertDerivedStoresPopulated(
                await derivedStoreCensus(restored.administrativePool),
                'restored-and-rebuilt',
              );
              assertSameBalances(sourceBalances, rebuiltBalances);
              assert.deepEqual(
                rebuiltBalances.map((entry) => decode(entry.bytes)),
                expectedSourceBalances,
                'the rebuilt read models must also satisfy the independent oracle',
              );
            } finally {
              await rebuiltSeat.runtimePool.end();
            }
          },
        );
      } finally {
        await Promise.all([
          sourceRuntimePool.end(),
          materializerPool.end(),
          moduleRuntimePool.end(),
        ]);
      }
    });

    assert.equal(recordedReds.length, 7);
    for (const failure of recordedReds) {
      testContext.diagnostic(`G3-R3 EXECUTED RED: ${failure}`);
    }
  },
);

// ---------------------------------------------------------------------------
// The comparison instruments. Each throws one typed message, so each can be
// executed red on its own.
// ---------------------------------------------------------------------------

function assertSameBalances(
  before: readonly ServedBalance[],
  after: readonly ServedBalance[],
): void {
  if (before.length === 0 || after.length === 0) {
    fail(
      'G3_R3_ZERO_BALANCES_OBSERVED: the restore comparison requires at least one served balance on each side',
    );
  }
  if (
    before.length !== balanceProbes.length ||
    after.length !== before.length
  ) {
    fail(
      `G3_R3_BALANCE_OBSERVATION_COUNT_MISMATCH: expected ${String(balanceProbes.length)} before=${String(before.length)} after=${String(after.length)}`,
    );
  }
  if (before.every((entry) => decode(entry.bytes) === '0')) {
    fail(
      'G3_R3_BALANCE_SET_DEGENERATE: every compared balance is zero, so agreement observes nothing',
    );
  }
  for (const [index, probe] of balanceProbes.entries()) {
    const left = before[index]!;
    const right = after[index]!;
    if (left.probeId !== probe.id || right.probeId !== probe.id) {
      fail(`G3_R3_BALANCE_PROBE_MISMATCH: ${probe.id}`);
    }
    if (left.queryId !== right.queryId) {
      fail(
        `G3_R3_BALANCE_QUERY_MISMATCH: ${probe.id} before=${left.queryId} after=${right.queryId}`,
      );
    }
    // Victim, run: replacing this with a numeric comparison
    // (`Number(decode(left)) !== Number(decode(right))`) makes the
    // `numerically-equal-but-reformatted` red stop firing — 10.50 is the same
    // number as 10.5 and a different answer.
    if (!bytesEqual(left.bytes, right.bytes)) {
      fail(
        `G3_R3_BALANCE_BYTES_CHANGED: ${probe.id} before=${decode(left.bytes)} after=${decode(right.bytes)}`,
      );
    }
  }
}

/**
 * The provenance guard. Reading is itself what regenerates an anchor, so the
 * comparison cannot prove the rebuild by its own result. What it can observe is
 * where each served value came from: the interpreter reports `cache-hit` when a
 * surviving anchor answered, and `ledger-recomputation` when it summed the
 * movements. A rebuild that did not clear reports the former.
 *
 * Victim, run: clearing the derived stores BEFORE the pre-clear read makes the
 * `served-from-surviving-cache` red stop firing, because nothing survives to
 * answer it. Deleting the DELETE loop in `rebuildDerivedStores` instead makes
 * `assertDerivedStoresEmpty` fail after the clear.
 */
function assertRebuiltFromLedger(
  served: readonly ServedBalance[],
  label: string,
): void {
  if (served.length === 0) {
    fail(`G3_R3_BALANCE_PROVENANCE_UNOBSERVED: ${label} served no balance`);
  }
  for (const entry of served) {
    if (entry.cacheKinds.length === 0) {
      fail(
        `G3_R3_BALANCE_PROVENANCE_UNOBSERVED: ${label} ${entry.probeId} reported no aggregate-cache observation`,
      );
    }
    for (const kind of entry.cacheKinds) {
      if (kind !== 'ledger-recomputation') {
        fail(
          `G3_R3_BALANCE_SERVED_FROM_SURVIVING_CACHE: ${label} ${entry.probeId} observed ${kind}`,
        );
      }
    }
  }
}

function assertRestoreCarriedTheHistory(
  source: readonly RelationCensus[],
  restored: readonly RelationCensus[],
  movementRelation: string,
): void {
  const sourceMovements = source.find(
    (entry) => entry.relation === movementRelation,
  );
  if (!sourceMovements || sourceMovements.rows === '0') {
    fail(
      `G3_R3_SUBJECT_HAS_NO_HISTORY: ${movementRelation} holds no posted movement to restore`,
    );
  }
  const restoredMovements = restored.find(
    (entry) => entry.relation === movementRelation,
  );
  if (!restoredMovements || restoredMovements.rows === '0') {
    fail(
      `G3_R3_RESTORE_RESTORED_NO_HISTORY: ${movementRelation} source=${sourceMovements.rows} restored=${restoredMovements?.rows ?? 'absent'}`,
    );
  }
  if (source.length !== restored.length) {
    fail(
      `G3_R3_RESTORE_INCOMPLETE: relation count source=${String(source.length)} restored=${String(restored.length)}`,
    );
  }
  for (const [index, expected] of source.entries()) {
    const observed = restored[index]!;
    if (observed.relation !== expected.relation) {
      fail(
        `G3_R3_RESTORE_INCOMPLETE: expected relation ${expected.relation}, observed ${observed.relation}`,
      );
    }
    if (observed.rows !== expected.rows) {
      fail(
        `G3_R3_RESTORE_INCOMPLETE: ${expected.relation} source=${expected.rows} restored=${observed.rows}`,
      );
    }
  }
}

function assertDerivedStoresEmpty(census: readonly RelationCensus[]): void {
  if (census.length !== derivedStores.length) {
    fail(
      `G3_R3_DERIVED_STORE_ROSTER_MISMATCH: expected ${String(derivedStores.length)} stores, observed ${String(census.length)}`,
    );
  }
  for (const entry of census) {
    if (entry.rows !== '0') {
      fail(
        `G3_R3_DERIVED_STORE_NOT_EMPTY: ${entry.relation} still holds rows where the rebuild requires none`,
      );
    }
  }
}

function assertDerivedStoresPopulated(
  census: readonly RelationCensus[],
  label: string,
): void {
  const anchors = census.find((entry) =>
    entry.relation.endsWith('.semantic_aggregate_anchors'),
  );
  if (!anchors || anchors.rows === '0') {
    fail(
      `G3_R3_DERIVED_STORE_EMPTY: ${label} carries no aggregate anchor, so the rebuild subject does not exist`,
    );
  }
}

/**
 * Construction-time ratchet. The rebuild clears a named roster; this refuses to
 * proceed if the schema grows a semantic-aggregate store the roster does not
 * name, so silent under-clearing fails closed instead of passing quietly.
 */
async function assertDerivedStoreRosterIsComplete(pool: Pool): Promise<void> {
  const result = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'BASE TABLE'
        AND table_name LIKE 'semantic\\_aggregate%'
      ORDER BY table_name`,
    [derivedStoreSchema],
  );
  assert.deepEqual(
    result.rows.map((row) => row.table_name),
    [...derivedStores].toSorted(),
    'a new semantic-aggregate derived store must join the rebuild roster',
  );
}

// ---------------------------------------------------------------------------
// Backup, restore, and the derived-store rebuild.
// ---------------------------------------------------------------------------

async function backup(containerName: string, label: string): Promise<string> {
  const path = `/tmp/g3-r3-${label}.dump`;
  const outcome = await dockerExec([
    'exec',
    containerName,
    'pg_dump',
    '--username=postgres',
    '--format=custom',
    `--file=${path}`,
    'postgres',
  ]);
  if (outcome.code !== 0) {
    fail(`G3_R3_BACKUP_FAILED: ${label} ${outcome.stderr.trim()}`);
  }
  return path;
}

async function withRestoredDatabase(
  database: {
    readonly connection: PoolConfig;
    readonly containerName: string;
    readonly pool: Pool;
  },
  dumpPath: string,
  databaseName: string,
  run: (restored: { readonly administrativePool: Pool }) => Promise<void>,
): Promise<void> {
  await database.pool.query(
    `CREATE DATABASE ${quoted(databaseName)} TEMPLATE template0`,
  );
  const administrativePool = new pg.Pool({
    ...database.connection,
    database: databaseName,
    max: 2,
  });
  try {
    // Three passes, because a single-pass restore of this database FAILS.
    //
    // The movement fact table carries a CHECK constraint that calls
    // `north_star_internal.inventory_business_period`, which READS
    // `platform.inventory_tenant_calendars`. A CHECK that reads another table
    // is re-validated on every COPY row, so a single-pass restore raises
    // INVENTORY_TENANT_CALENDAR_UNDECLARED whenever the calendar has not
    // happened to load first. Detaching it around the data pass and
    // re-attaching it afterwards VALIDATES every restored business period
    // against the derivation, rather than leaving it unchecked.
    //
    // Splitting the passes also puts the data load before post-data, where the
    // fact table's effect trigger is created, so that trigger cannot re-derive
    // companion rows or re-advance the aggregate generation during COPY.
    // `--disable-triggers` is belt-and-braces for that and is NOT load-bearing:
    // removing it leaves this test green, because the trigger does not yet
    // exist when the data pass runs.
    await runRestorePass(database.containerName, databaseName, dumpPath, [
      '--section=pre-data',
    ]);
    const detached = await detachCalendarDependentChecks(administrativePool);
    assert.ok(
      detached.length > 0,
      'the movement fact table must carry the calendar-reading business-period check',
    );
    await runRestorePass(database.containerName, databaseName, dumpPath, [
      '--data-only',
      '--disable-triggers',
    ]);
    await reattachChecks(administrativePool, detached);
    await runRestorePass(database.containerName, databaseName, dumpPath, [
      '--section=post-data',
    ]);
    await run({ administrativePool });
  } finally {
    await administrativePool.end();
    // Released promptly: the ephemeral cluster keeps its data on a 256 MB
    // tmpfs, so three simultaneous restores would not fit.
    await database.pool.query(`DROP DATABASE ${quoted(databaseName)}`);
  }
}

async function runRestorePass(
  containerName: string,
  databaseName: string,
  dumpPath: string,
  passArguments: readonly string[],
): Promise<void> {
  const outcome = await dockerExec([
    'exec',
    containerName,
    'pg_restore',
    '--username=postgres',
    `--dbname=${databaseName}`,
    '--exit-on-error',
    ...passArguments,
    dumpPath,
  ]);
  if (outcome.code !== 0) {
    fail(
      `G3_R3_RESTORE_FAILED: ${databaseName} ${passArguments.join(' ')} exit=${String(outcome.code)} ${outcome.stderr.trim()}`,
    );
  }
}

interface DetachedCheck {
  readonly definition: string;
  readonly name: string;
  readonly relation: string;
  readonly schema: string;
}

async function detachCalendarDependentChecks(
  pool: Pool,
): Promise<DetachedCheck[]> {
  const result = await pool.query<DetachedCheck>(
    `SELECT pg_catalog.pg_get_constraintdef(constraint_record.oid) AS definition,
            constraint_record.conname AS name,
            relation.relname AS relation,
            namespace.nspname AS schema
       FROM pg_catalog.pg_constraint AS constraint_record
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = constraint_record.conrelid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      WHERE constraint_record.contype = 'c'
        -- Only the declaring relation: the fact table is partitioned, so its
        -- partitions carry inherited copies that follow the parent.
        AND constraint_record.coninhcount = 0
        AND pg_catalog.pg_get_constraintdef(constraint_record.oid)
              LIKE '%inventory\\_business\\_period%'
      ORDER BY namespace.nspname, relation.relname, constraint_record.conname`,
  );
  for (const check of result.rows) {
    await pool.query(
      `ALTER TABLE ${quoted(check.schema)}.${quoted(check.relation)} DROP CONSTRAINT ${quoted(check.name)}`,
    );
  }
  return result.rows;
}

async function reattachChecks(
  pool: Pool,
  checks: readonly DetachedCheck[],
): Promise<void> {
  for (const check of checks) {
    await pool.query(
      `ALTER TABLE ${quoted(check.schema)}.${quoted(check.relation)} ADD CONSTRAINT ${quoted(check.name)} ${check.definition}`,
    );
  }
}

async function rebuildDerivedStores(pool: Pool): Promise<void> {
  const rules = await pool.query<{ rulename: string; tablename: string }>(
    `SELECT rulename, tablename
       FROM pg_catalog.pg_rules
      WHERE schemaname = $1 AND tablename = ANY($2::text[])
      ORDER BY tablename, rulename`,
    [derivedStoreSchema, [...derivedStores]],
  );
  for (const rule of rules.rows) {
    await pool.query(
      `ALTER TABLE ${quoted(derivedStoreSchema)}.${quoted(rule.tablename)} DISABLE RULE ${quoted(rule.rulename)}`,
    );
  }
  try {
    for (const store of derivedStores) {
      await pool.query(
        `DELETE FROM ${quoted(derivedStoreSchema)}.${quoted(store)}`,
      );
    }
  } finally {
    for (const rule of rules.rows) {
      await pool.query(
        `ALTER TABLE ${quoted(derivedStoreSchema)}.${quoted(rule.tablename)} ENABLE RULE ${quoted(rule.rulename)}`,
      );
    }
  }
}

/**
 * Row counts for every base table in every non-system schema, read from the
 * catalogue rather than from a list this test maintains. Nothing here decides
 * which relations matter, so a relation the restore silently dropped cannot go
 * uncompared.
 */
async function relationCensus(pool: Pool): Promise<RelationCensus[]> {
  const result = await pool.query<RelationCensus>(
    `SELECT format('%I.%I', tables.table_schema, tables.table_name) AS relation,
            (xpath(
               '/row/count/text()',
               query_to_xml(
                 format(
                   'SELECT count(*) AS count FROM %I.%I',
                   tables.table_schema,
                   tables.table_name
                 ),
                 false,
                 true,
                 ''
               )
             ))[1]::text AS rows
       FROM information_schema.tables AS tables
      WHERE tables.table_type = 'BASE TABLE'
        AND tables.table_schema NOT IN ('information_schema', 'pg_catalog')
      ORDER BY tables.table_schema, tables.table_name`,
  );
  assert.ok(
    result.rows.length > 0,
    'the census must observe at least one relation',
  );
  return result.rows;
}

async function derivedStoreCensus(pool: Pool): Promise<RelationCensus[]> {
  const census = await relationCensus(pool);
  return derivedStores.map((store) =>
    requiredRelation(census, `${derivedStoreSchema}.${store}`),
  );
}

function requiredRelation(
  census: readonly RelationCensus[],
  relation: string,
): RelationCensus {
  const found = census.find((entry) => entry.relation === relation);
  assert.ok(found, `the census must observe ${relation}`);
  return found;
}

async function dockerExec(
  arguments_: readonly string[],
): Promise<DockerOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', [...arguments_], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stderr, stdout };
  } catch (error) {
    const cause = error as {
      code?: unknown;
      stderr?: unknown;
      stdout?: unknown;
    };
    return {
      code: typeof cause.code === 'number' ? cause.code : -1,
      stderr: typeof cause.stderr === 'string' ? cause.stderr : '',
      stdout: typeof cause.stdout === 'string' ? cause.stdout : '',
    };
  }
}

// ---------------------------------------------------------------------------
// The real read path: the same gateway, interpreter and runtime view on both
// sides of the restore.
// ---------------------------------------------------------------------------

async function openReadSeat(
  connection: PoolConfig,
  databaseName: string,
  applicationName: string,
): Promise<ReadSeat> {
  const runtimePool = new pg.Pool({
    ...connection,
    application_name: applicationName,
    database: databaseName,
    max: 2,
    user: 'north_star_runtime',
  });
  try {
    const policy = new AllowPolicy();
    const view = await new AuthenticatedRequestRuntimeEntryAdapter(
      new AuthenticatedRequestEntryAdapter(async () => identity()),
      new PostgresRequestRuntimeViewService(runtimePool),
      policy,
    ).run({}, async (issued) => issued);
    const observations: AggregateCacheObservation[] = [];
    const interpreter = new PostgresModuleRuntimeInterpreter(
      runtimePool,
      actorIssuer(),
      [],
      (observation) => observations.push(observation),
    );
    return {
      gateway: new SemanticQueryGateway(policy, interpreter),
      observations,
      onHand: onHandBinding(view),
      runtimePool,
      view,
    };
  } catch (error) {
    await runtimePool.end();
    throw error;
  }
}

async function observeBalances(seat: ReadSeat): Promise<ServedBalance[]> {
  const served: ServedBalance[] = [];
  for (const probe of balanceProbes) {
    seat.observations.length = 0;
    const result = await seat.gateway.invokeAggregate(seat.view, {
      arguments: onHandArguments(seat.onHand, probe),
      queryId: seat.onHand.queryId,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    });
    assert.equal(result.outcome, 'exact', probe.id);
    assert.equal(result.value.kind, 'exactDecimalResult', probe.id);
    served.push({
      bytes: new TextEncoder().encode(result.value.value),
      cacheKinds: seat.observations.map((observation) => observation.kind),
      probeId: probe.id,
      queryId: result.queryId,
    });
  }
  return served;
}

function onHandArguments(
  onHand: OnHandBinding,
  probe: BalanceProbe,
): Record<string, unknown> {
  return {
    [onHand.atTime]: probe.atTime,
    [onHand.itemId]: probe.itemId,
    [onHand.legalEntityId]: legalEntityId,
    [onHand.locationId]: probe.locationId,
    [onHand.recordedAtHorizon]: recordedAtHorizon,
  };
}

/**
 * The on-hand query identifier and its parameter identifiers are read out of
 * the release the database under test actually serves, so both sides of the
 * restore address the same declared query rather than a literal this test
 * carries.
 */
function onHandBinding(view: RequestRuntimeView): OnHandBinding {
  const payload = view.projections.query.payload as unknown as {
    queries: ReadonlyArray<Record<string, unknown>>;
  };
  const matches = payload.queries.filter(
    (query) =>
      typeof query.queryId === 'string' &&
      query.queryId.endsWith(':query.inventory_movement_on_hand'),
  );
  assert.equal(matches.length, 1, 'exactly one on-hand aggregate must exist');
  const query = matches[0]!;
  assert.ok(Array.isArray(query.parameters));
  const byLocalName = new Map<string, string>();
  for (const parameter of query.parameters) {
    assert.ok(isRecord(parameter));
    assert.equal(typeof parameter.parameterId, 'string');
    const parameterId = String(parameter.parameterId);
    byLocalName.set(parameterId.split(':parameter.').at(-1)!, parameterId);
  }
  assert.equal(
    byLocalName.size,
    5,
    'the on-hand aggregate must declare exactly its five operands',
  );
  const required = (local: string): string => {
    const found = byLocalName.get(local);
    assert.ok(found, `the on-hand aggregate must declare parameter ${local}`);
    return found;
  };
  return {
    atTime: required('on_hand_at_time'),
    itemId: required('on_hand_item_id'),
    legalEntityId: required('on_hand_legal_entity_id'),
    locationId: required('on_hand_location_id'),
    queryId: String(query.queryId),
    recordedAtHorizon: required('on_hand_recorded_at_horizon'),
  };
}

class AllowPolicy implements CurrentPolicyGateway {
  async authorize(_request: CurrentPolicyDecisionRequest) {
    void _request;
    return {
      decision: 'ALLOW' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'g3-r3-backup-restore-policy/v1',
    };
  }

  async readCurrentVersion(_subject: CurrentPolicySubject) {
    void _subject;
    return { policyVersion: 'g3-r3-backup-restore-policy/v1' };
  }
}

// ---------------------------------------------------------------------------
// Posting the history through the real capability.
// ---------------------------------------------------------------------------

type PostingActor = Awaited<ReturnType<TrustedActorEnvelopeIssuer['issue']>>;

async function postAdjustment(
  service: PostgresInventoryPostingService,
  context: TrustedRequestContext,
  actor: PostingActor,
  input: {
    readonly effectiveAt: string;
    readonly itemId: string;
    readonly locationId: string;
    readonly quantityDelta: string;
    readonly sourceId: string;
  },
): Promise<void> {
  const command: InventoryAdjustmentPostingCommandV1 = {
    authorization: {
      decision: 'ALLOW',
      evaluatorVersion: 'g3-r3-evaluator/v1',
      policyVersion: 'g3-r3-policy/v1',
    },
    channel: 'API',
    effectiveAt: input.effectiveAt,
    idempotencyKey: randomUUID(),
    legalEntityId,
    lines: [
      {
        itemId: input.itemId,
        locationId: input.locationId,
        quantityDelta: input.quantityDelta,
        sourceLine: '1',
        transactionLineId: randomUUID(),
        unitId: 'EA',
      },
    ],
    reason: {
      code: 'OPENING-BALANCE',
      narrative: 'Seeded restore-drill adjustment',
    },
    sourceId: input.sourceId,
    sourceRevision: 1,
    sourceType: 'adjustment',
    stockDimensionSetVersion: 'v1',
    transactionId: randomUUID(),
  };
  await seedDraft(context, command, 'adjustment');
  const posted = await service.postAdjustment(context, actor, command);
  assert.equal(posted.replayed, false, input.sourceId);
  assert.equal(posted.movements.length, 1, input.sourceId);
}

async function postTransfer(
  service: PostgresInventoryPostingService,
  context: TrustedRequestContext,
  actor: PostingActor,
  input: {
    readonly effectiveAt: string;
    readonly quantity: string;
    readonly sourceId: string;
  },
): Promise<void> {
  const command: InventoryTransferPostingCommandV1 = {
    authorization: {
      decision: 'ALLOW',
      evaluatorVersion: 'g3-r3-evaluator/v1',
      policyVersion: 'g3-r3-policy/v1',
    },
    channel: 'API',
    effectiveAt: input.effectiveAt,
    idempotencyKey: randomUUID(),
    legalEntityId,
    lines: [
      {
        fromLocationId: locationFrom,
        itemId: itemMoved,
        quantity: input.quantity,
        sourceLine: '1',
        toLocationId: locationTo,
        transactionLineId: randomUUID(),
        unitId: 'EA',
      },
    ],
    reason: { code: 'WAREHOUSE-TRANSFER', narrative: 'Seeded restore drill' },
    sourceId: input.sourceId,
    sourceRevision: 1,
    sourceType: 'transfer',
    stockDimensionSetVersion: 'v1',
    transactionId: randomUUID(),
  };
  await seedDraft(context, command, 'transfer');
  const posted = await service.postTransfer(context, actor, command);
  assert.equal(posted.replayed, false, input.sourceId);
  assert.equal(
    posted.movements.length,
    2,
    'a transfer must post the paired debit and credit',
  );
}

async function postStockCount(
  service: PostgresInventoryPostingService,
  context: TrustedRequestContext,
  actor: PostingActor,
  input: {
    readonly countedQuantity: string;
    readonly effectiveAt: string;
    readonly expectedQuantity: string;
    readonly kind: 'correction' | 'initial';
    readonly sequence: number;
    readonly supersedesStockCountId: string | null;
    readonly varianceQuantity: string;
  },
): Promise<{
  readonly movements: Awaited<
    ReturnType<PostgresInventoryPostingService['postStockCount']>
  >['movements'];
  readonly stockCountId: string;
}> {
  const suffix = String(input.sequence).padStart(2, '0');
  const stockCountId = `69000000-0000-4000-8000-0000000000${suffix}`;
  const command: InventoryStockCountPostingCommandV1 = {
    authorization: {
      decision: 'ALLOW',
      evaluatorVersion: 'g3-r3-evaluator/v1',
      policyVersion: 'g3-r3-policy/v1',
    },
    channel: 'API',
    effectiveAt: input.effectiveAt,
    idempotencyKey: `6a000000-0000-4000-8000-0000000000${suffix}`,
    kind: input.kind,
    legalEntityId,
    lines: [
      {
        countedQuantity: input.countedQuantity,
        expectedQuantity: input.expectedQuantity,
        itemId: itemStock,
        reversalOfMovementId: null,
        sourceLine: String(input.sequence),
        stockCountLineId: `6b000000-0000-4000-8000-0000000000${suffix}`,
        transactionLineId: `6c000000-0000-4000-8000-0000000000${suffix}`,
        unitId: 'EA',
        varianceQuantity: input.varianceQuantity,
      },
    ],
    locationId: locationMain,
    reason: { code: 'PHYSICAL_COUNT', narrative: 'Reviewed physical count' },
    sourceId: stockCountId,
    sourceRevision: 1,
    sourceType: 'stockCount',
    stockCountId,
    stockDimensionSetVersion: 'v1',
    supersedesStockCountId: input.supersedesStockCountId,
    transactionId: `6d000000-0000-4000-8000-0000000000${suffix}`,
  };
  await seedReviewedCount(context, command);
  const posted = await service.postStockCount(context, actor, command);
  assert.equal(posted.replayed, false, stockCountId);
  assert.equal(posted.movements.length, 1, stockCountId);
  return { movements: posted.movements, stockCountId };
}

// ---------------------------------------------------------------------------
// Draft seeding — the document side the posting service transitions.
// ---------------------------------------------------------------------------

let seedingPool: Pool | undefined;
let seedingBinding: StorageBinding | undefined;

async function seedDraft(
  context: TrustedRequestContext,
  command:
    InventoryAdjustmentPostingCommandV1 | InventoryTransferPostingCommandV1,
  transactionType: 'adjustment' | 'transfer',
): Promise<void> {
  const binding = requiredBinding();
  await withModuleRole(requiredSeedingPool(), context, async (client) => {
    await insertEntity(
      client,
      binding,
      binding.transaction,
      {
        inventory_transaction_actor_id: principalId,
        inventory_transaction_effective_at: command.effectiveAt,
        inventory_transaction_number: `G3R3-${command.transactionId.slice(0, 12)}`,
        inventory_transaction_reason_code: command.reason.code || null,
        inventory_transaction_reason_narrative: command.reason.narrative,
        inventory_transaction_recorded_at: recordedAt,
        inventory_transaction_source_id: command.sourceId,
        inventory_transaction_source_type: command.sourceType,
        inventory_transaction_state: enumOption(
          field(binding.transaction, 'inventory_transaction_state'),
          'draft',
        ),
        inventory_transaction_type: enumOption(
          field(binding.transaction, 'inventory_transaction_type'),
          transactionType,
        ),
      },
      command.transactionId,
      command.legalEntityId,
      {},
    );
    for (const line of command.lines) {
      const transfer = 'fromLocationId' in line;
      const negative = !transfer && line.quantityDelta.startsWith('-');
      await insertEntity(
        client,
        binding,
        binding.transactionLine,
        {
          inventory_transaction_line_from_location_id: transfer
            ? line.fromLocationId
            : negative
              ? line.locationId
              : null,
          inventory_transaction_line_item_id: line.itemId,
          inventory_transaction_line_line_number: Number(line.sourceLine),
          inventory_transaction_line_quantity: transfer
            ? line.quantity
            : line.quantityDelta,
          inventory_transaction_line_to_location_id: transfer
            ? line.toLocationId
            : negative
              ? null
              : line.locationId,
          inventory_transaction_line_unit_id: line.unitId,
        },
        line.transactionLineId,
        command.legalEntityId,
        { [binding.transaction.entity.entityId]: command.transactionId },
      );
    }
  });
}

async function seedReviewedCount(
  context: TrustedRequestContext,
  command: InventoryStockCountPostingCommandV1,
): Promise<void> {
  const binding = requiredBinding();
  await withModuleRole(requiredSeedingPool(), context, async (client) => {
    await insertEntity(
      client,
      binding,
      binding.transaction,
      {
        inventory_transaction_actor_id: principalId,
        inventory_transaction_effective_at: command.effectiveAt,
        inventory_transaction_number: `G3R3-COUNT-${command.lines[0]!.sourceLine}`,
        inventory_transaction_reason_code: command.reason.code,
        inventory_transaction_reason_narrative: command.reason.narrative,
        inventory_transaction_recorded_at: recordedAt,
        inventory_transaction_source_id: command.sourceId,
        inventory_transaction_source_type: command.sourceType,
        inventory_transaction_state: enumOption(
          field(binding.transaction, 'inventory_transaction_state'),
          'draft',
        ),
        inventory_transaction_type: enumOption(
          field(binding.transaction, 'inventory_transaction_type'),
          'count_correction',
        ),
      },
      command.transactionId,
      command.legalEntityId,
      {},
    );
    for (const line of command.lines) {
      const negative = line.varianceQuantity.startsWith('-');
      await insertEntity(
        client,
        binding,
        binding.transactionLine,
        {
          inventory_transaction_line_from_location_id: negative
            ? command.locationId
            : null,
          inventory_transaction_line_item_id: line.itemId,
          inventory_transaction_line_line_number: Number(line.sourceLine),
          inventory_transaction_line_quantity: line.varianceQuantity,
          inventory_transaction_line_to_location_id: negative
            ? null
            : command.locationId,
          inventory_transaction_line_unit_id: line.unitId,
        },
        line.transactionLineId,
        command.legalEntityId,
        { [binding.transaction.entity.entityId]: command.transactionId },
      );
    }
    await insertEntity(
      client,
      binding,
      binding.stockCount,
      {
        stock_count_actor_id: null,
        stock_count_counted_at: command.effectiveAt,
        stock_count_kind: enumOption(
          field(binding.stockCount, 'stock_count_kind'),
          command.kind,
        ),
        stock_count_location_id: command.locationId,
        stock_count_number: `G3R3-SESSION-${command.lines[0]!.sourceLine}`,
        stock_count_reason_code: command.reason.code,
        stock_count_reason_narrative: command.reason.narrative,
        stock_count_recorded_at: null,
        stock_count_state: enumOption(
          field(binding.stockCount, 'stock_count_state'),
          'reviewed',
        ),
      },
      command.stockCountId,
      command.legalEntityId,
      {
        [binding.stockCount.entity.entityId]:
          command.supersedesStockCountId ?? '',
        [binding.transaction.entity.entityId]: command.transactionId,
      },
    );
    for (const line of command.lines) {
      await insertEntity(
        client,
        binding,
        binding.stockCountLine,
        {
          stock_count_line_counted_quantity: line.countedQuantity,
          stock_count_line_expected_quantity: line.expectedQuantity,
          stock_count_line_item_id: line.itemId,
          stock_count_line_line_number: Number(line.sourceLine),
          stock_count_line_reversal_of_movement_id: line.reversalOfMovementId,
          stock_count_line_unit_id: line.unitId,
          stock_count_line_variance_quantity: line.varianceQuantity,
        },
        line.stockCountLineId,
        command.legalEntityId,
        {
          [binding.stockCount.entity.entityId]: command.stockCountId,
          [binding.transactionLine.entity.entityId]: line.transactionLineId,
        },
      );
    }
  });
}

async function seedFoundation(
  pool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
): Promise<void> {
  seedingBinding = binding;
  seedingPool = pool;
  await withModuleRole(pool, context, async (client) => {
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
          legal_entity_code: 'LE-R3',
          legal_entity_is_default: false,
          legal_entity_name: 'Restore drill legal entity',
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
    for (const [index, item] of [itemStock, itemMoved].entries()) {
      await insertEntity(
        client,
        binding,
        binding.item,
        {
          item_base_unit: 'EA',
          item_code: `ITEM-R3-${String(index + 1)}`,
          item_name: `Restore drill item ${String(index + 1)}`,
        },
        item,
        null,
        {},
      );
    }
    for (const [index, location] of [
      locationMain,
      locationFrom,
      locationTo,
    ].entries()) {
      await insertEntity(
        client,
        binding,
        binding.location,
        {
          location_code: `LOC-R3-${String(index + 1)}`,
          location_name: `Restore drill location ${String(index + 1)}`,
        },
        location,
        null,
        {},
      );
    }
  });
}

function requiredSeedingPool(): Pool {
  assert.ok(seedingPool, 'the seeding pool must be bound before posting');
  return seedingPool;
}

function requiredBinding(): StorageBinding {
  assert.ok(seedingBinding, 'the storage binding must be bound before posting');
  return seedingBinding;
}

// ---------------------------------------------------------------------------
// Fixture, release and provisioning plumbing.
// ---------------------------------------------------------------------------

let fixturePromise: Promise<Fixture> | undefined;

async function compiledFixture(): Promise<Fixture> {
  fixturePromise ??= buildFixture();
  return fixturePromise;
}

async function buildFixture(): Promise<Fixture> {
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

async function loadInventoryDefinition(): Promise<Record<string, unknown>> {
  const applicationBuilder: unknown =
    await import('../../packages/domain/src/app/builder.js');
  assert.ok(isRecord(applicationBuilder));
  assert.equal(
    typeof applicationBuilder.composedApplicationDefinition,
    'function',
  );
  const definition = (
    applicationBuilder.composedApplicationDefinition as () => unknown
  )();
  assert.ok(isRecord(definition));
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

/**
 * Version-from-artifact: compile the fixture at the version it declares rather
 * than at whichever version is currently adopted.
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
      : { normalizationProfileVersion: declared.normalizationProfileVersion }),
  };
}

async function migrateAndProvision(
  pool: Pool,
  contractReleaseRoot: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await runMigrations(client, await loadMigrations(migrations));
    await client.query(
      'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
      [tenantId, 'inventory-backup-restore'],
    );
    await client.query(
      `INSERT INTO platform.environments (tenant_id, id, slug)
       VALUES ($1,$2,'production')`,
      [tenantId, environmentId],
    );
    await client.query(
      `SELECT platform.provision_inventory_scope(
         $1,$2,$3,'LE-R3','Restore drill legal entity','UTC','00:00:00',$4,
         1::smallint,'reject',$5,'codeAndNarrative','codeOnly',
         'codeAndNarrative','codeAndNarrative','codeAndNarrative',
         NULL,NULL,NULL,NULL,NULL
       )`,
      [
        tenantId,
        environmentId,
        legalEntityId,
        contractReleaseRoot,
        maximumBackdateDays,
      ],
    );
  } finally {
    client.release();
  }
}

function identity(): AuthenticatedIdentity {
  return { environmentId, principalId, tenantId };
}

async function trustedContext(): Promise<TrustedRequestContext> {
  return new AuthenticatedRequestEntryAdapter(async () => identity()).enter({
    headers: { authorization: 'inventory-backup-restore' },
  });
}

function actorIssuer(): TrustedActorEnvelopeIssuer {
  return new TrustedActorEnvelopeIssuer({
    async resolve(context) {
      return {
        approvingHumanId: null,
        delegation: null,
        executionPrincipal: {
          kind: 'HUMAN',
          principalId: context.principalId,
        },
        initiatingHumanId: context.principalId,
        subject: null,
      };
    },
  });
}

async function actorEnvelope(
  context: TrustedRequestContext,
): Promise<PostingActor> {
  return actorIssuer().issue(context);
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

async function withModuleRole<T>(
  pool: Pool,
  context: TrustedRequestContext,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('lock_timeout',$1,true)", ['3s']);
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

async function insertEntity(
  client: PoolClient,
  binding: StorageBinding,
  entity: EntityBinding,
  overrides: Record<string, unknown>,
  recordId: string,
  scopedLegalEntityId: string | null,
  relationIds: Record<string, string>,
): Promise<void> {
  const relationColumns = binding.storageTarget.relations.filter(
    (relation) =>
      relation.sourceEntityId === entity.entity.entityId &&
      relation.relationColumn.origin !== 'field',
  );
  const columns = [
    'tenant_id',
    'environment_id',
    ...(entity.legalEntityColumn ? [entity.legalEntityColumn] : []),
    entity.recordIdColumn,
    ...entity.entity.columns.map((column) => column.physicalName),
    ...relationColumns.map((relation) => relation.relationColumn.physicalName),
  ];
  const values = [
    tenantId,
    environmentId,
    ...(entity.legalEntityColumn ? [scopedLegalEntityId] : []),
    recordId,
    ...entity.entity.columns.map((column) =>
      Object.hasOwn(overrides, localField(column))
        ? overrides[localField(column)]
        : defaultFieldValue(column, recordId),
    ),
    ...relationColumns.map((relation) => {
      const value = relationIds[relation.targetEntityId];
      if (value) return value;
      assert.equal(
        relation.relationColumn.nullable,
        true,
        `missing required relation ${relation.relationId}`,
      );
      return null;
    }),
  ];
  await client.query(
    `INSERT INTO ${table(binding, entity)} (${columns.map(quoted).join(',')})
     VALUES (${values.map((_, index) => `$${String(index + 1)}`).join(',')})`,
    values,
  );
}

function storageBinding(target: StorageTargetPayloadV1): StorageBinding {
  const bind = (suffix: string): EntityBinding => {
    const entity = target.entities.find((candidate) =>
      candidate.entityId.endsWith(`:entity.${suffix}`),
    );
    assert.ok(entity, `missing ${suffix}`);
    return {
      entity,
      fields: new Map(
        entity.columns.map((column) => [localField(column), column]),
      ),
      legalEntityColumn: entity.legalEntity?.column ?? null,
      recordIdColumn: entity.recordIdentity.column,
      tableName: entity.physicalTableName,
    };
  };
  return {
    item: bind('item'),
    legalEntity: bind('legal_entity'),
    location: bind('location'),
    movement: bind('inventory_movement'),
    schemaName: target.providerAbi.managedSchema,
    stockCount: bind('stock_count'),
    stockCountLine: bind('stock_count_line'),
    storageTarget: target,
    transaction: bind('inventory_transaction'),
    transactionLine: bind('inventory_transaction_line'),
  };
}

function field(
  entity: EntityBinding,
  localId: string,
): StorageEntityTarget['columns'][number] {
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
  assert.equal(options.length, 1, `missing enum option ${suffix}`);
  return options[0]!;
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
      return '2026-08-04';
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
      return `${localField(column)}-${recordId.slice(-8)}`.slice(0, maximum);
    }
    case 'timeFieldType':
      return '00:00:00';
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

function recordRed(
  recorded: string[],
  label: string,
  expectedMessage: string,
  run: () => void,
): void {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof Error, `${label} did not throw an Error`);
    assert.equal(error.message, expectedMessage, label);
    recorded.push(error.message);
    return;
  }
  assert.fail(`${label} did not execute red`);
}

/**
 * The byte-versus-number control: `10.50` is the same number as `10.5` and a
 * different answer. Comparing decoded numbers instead of bytes would accept it.
 */
function reformatFirst(source: readonly ServedBalance[]): ServedBalance[] {
  return source.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          bytes: new TextEncoder().encode(`${decode(entry.bytes)}0`),
        }
      : entry,
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function localField(column: StorageEntityTarget['columns'][number]): string {
  return column.canonicalFieldId.split(':field.').at(-1)!;
}

function table(binding: StorageBinding, entity: EntityBinding): string {
  return `${quoted(binding.schemaName)}.${quoted(entity.tableName)}`;
}

function quoted(identifier: string): string {
  assert.match(identifier, /^[a-z][a-z0-9_]{0,62}$/u);
  return `"${identifier}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}
