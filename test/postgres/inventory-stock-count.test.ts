import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

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
  INVENTORY_POSTING_CAPABILITY_ID,
  INVENTORY_POSTING_CAPABILITY_VERSION,
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  InventoryPostingError,
  PostgresInventoryPostingService,
  deriveInventoryPostingCompanionId,
  type InventoryPostingErrorCode,
  type InventoryPostingRegistrationV1,
  type InventoryStockCountPostingCommandV2,
} from '../../packages/postgres-provider/src/inventory-posting-service.js';
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
import { assertComposedInventoryCollection } from '../helpers/assert-composed-inventory.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const migrations = resolve('db/migrations');
const tenantId = '12000000-0000-4000-8000-000000000001';
const environmentId = '23000000-0000-4000-8000-000000000002';
const legalEntityId = '34000000-0000-4000-8000-000000000003';
const principalId = '78000000-0000-4000-8000-000000000007';
const itemId = '45000000-0000-4000-8000-000000000004';
const locationId = '56000000-0000-4000-8000-000000000005';
const otherLocationId = '56000000-0000-4000-8000-000000000006';
const recordedAt = '2026-07-30T13:00:00.000Z';
const effectiveAt = '2026-07-30T12:00:00.000Z';
const postedStockNegativeControl =
  process.env.POSTED_STOCK_BALANCE_NEGATIVE_CONTROL ?? null;

type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];

interface EntityBinding {
  entity: StorageEntityTarget;
  fields: Map<string, StorageEntityTarget['columns'][number]>;
  legalEntityColumn: string | null;
  recordIdColumn: string;
  revisionColumn: string;
  tableName: string;
}

interface StorageBinding {
  item: EntityBinding;
  legalEntity: EntityBinding;
  location: EntityBinding;
  movement: EntityBinding;
  postedStockBalance: EntityBinding;
  schemaName: string;
  stockCount: EntityBinding;
  stockCountLine: EntityBinding;
  storageTarget: StorageTargetPayloadV1;
  transaction: EntityBinding;
  transactionLine: EntityBinding;
}

interface Fixture {
  empty: CompileSuccess;
  emptyDefinition: Record<string, unknown>;
  inventory: CompileSuccess;
  inventoryDefinition: Record<string, unknown>;
  storage: StorageTargetPayloadV1;
  storageContentHash: string;
}

interface TraceEntry {
  text: string;
  values: readonly unknown[];
}

test('stock-count posting preserves three-value evidence and appends correction and exact reversal through the shared protocol', async () => {
  assert.ok(
    postedStockNegativeControl === null ||
      [
        'initial-maintenance',
        'correction-maintenance',
        'rebuild-arithmetic',
      ].includes(postedStockNegativeControl),
    `unknown posted-stock negative control ${String(postedStockNegativeControl)}`,
  );
  const fixture = await compiledFixture();
  const binding = storageBinding(fixture.storage);
  await withEphemeralPostgres('inventory-stock-count', async (database) => {
    await migrateAndProvision(database.pool, fixture.inventory.releaseRoot);
    const runtimePool = new pg.Pool({
      ...database.connection,
      application_name: 'g3-p4b-stock-count',
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
      const releases = await persistSequence(runtimePool, context, [
        [fixture.empty, fixture.emptyDefinition],
        [fixture.inventory, fixture.inventoryDefinition],
      ]);
      await setPointer(database.pool, releases[0]!);
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
        targetReleaseId: releases[1]!,
      });
      assert.equal(prepared.schemaState, 'APPLIED');
      await setPointer(database.pool, releases[1]!);
      await seedFoundation(runtimePool, context, binding);

      const trace: TraceEntry[] = [];
      const tracedPool = tracingPool(runtimePool, trace);
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
        tracedPool,
        registration,
        { currentInstant: () => recordedAt },
      );
      const actor = await new TrustedActorEnvelopeIssuer({
        resolve: async () => ({
          approvingHumanId: null,
          delegation: null,
          executionPrincipal: { kind: 'HUMAN', principalId },
          initiatingHumanId: principalId,
          subject: null,
        }),
      }).issue(context);

      const initial = countCommand({
        countedQuantity: '5',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 1,
        supersedesStockCountId: null,
        varianceQuantity: '5',
      });
      await seedReviewedCount(runtimePool, context, binding, initial);
      if (postedStockNegativeControl === 'initial-maintenance') {
        await disablePostedStockTrigger(database.pool, binding);
      }
      const initialResult = await service.postStockCount(
        context,
        actor,
        initial,
      );
      assertThreeValues(initialResult.stockCountEvidence, '0', '5', '5');
      assert.equal(initialResult.movements[0]?.quantityDelta, '5');
      assert.equal(
        initialResult.movements[0]?.postingRole,
        'count',
        "hardcoding the initial stock-count role to 'correction' must fail here",
      );
      assert.equal(
        await readPostedStockQuantity(runtimePool, context, binding),
        '5.000000000000000000',
        'the browsable row must observe real posted movement arithmetic',
      );
      const initialBalanceRecordId = await readPostedStockRecordId(
        runtimePool,
        context,
        binding,
      );
      assert.match(
        initialBalanceRecordId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
        'the deterministic projection identity must be a canonical UUIDv4',
      );
      const directUpdate = await withModuleRole(
        runtimePool,
        context,
        (client) =>
          client.query(
            `UPDATE ${table(binding, binding.postedStockBalance)}
                SET ${quoted(field(binding.postedStockBalance, 'posted_stock_balance_posted_quantity').physicalName)} = '999'
              WHERE tenant_id = $1 AND environment_id = $2`,
            [context.tenantId, context.environmentId],
          ),
      );
      assert.equal(
        directUpdate.rowCount,
        0,
        'ordinary runtime writes must not reach the provider-owned projection',
      );
      assertProtocolTrace(trace.splice(0), binding);

      const correction = countCommand({
        countedQuantity: '7',
        expectedQuantity: '5',
        kind: 'correction',
        sequence: 2,
        supersedesStockCountId: initial.stockCountId,
        varianceQuantity: '2',
      });
      await seedReviewedCount(runtimePool, context, binding, correction);
      if (postedStockNegativeControl === 'correction-maintenance') {
        await disablePostedStockTrigger(database.pool, binding);
      }
      const correctionResult = await service.postStockCount(
        context,
        actor,
        correction,
      );
      assertThreeValues(correctionResult.stockCountEvidence, '5', '7', '2');
      assert.equal(correctionResult.movements[0]?.quantityDelta, '2');
      assert.equal(
        correctionResult.stockCountEvidence?.supersedesStockCountId,
        initial.stockCountId,
      );
      assert.equal(
        await readPostedStockQuantity(runtimePool, context, binding),
        '7.000000000000000000',
        'a posted correction must move the same browsable row',
      );
      assertProtocolTrace(trace.splice(0), binding);

      const destroyed = await database.pool.query(
        `DELETE FROM ${table(binding, binding.postedStockBalance)}
          WHERE tenant_id = $1 AND environment_id = $2`,
        [context.tenantId, context.environmentId],
      );
      assert.equal(destroyed.rowCount, 1);
      assert.equal(
        await readPostedStockQuantity(runtimePool, context, binding),
        null,
        'the rebuild control must actually destroy the derived row first',
      );
      const rebuilt = await materializer.rebuildPostedStockBalances(context);
      assert.deepEqual(rebuilt, { movementCount: 2, rowCount: 1 });
      if (postedStockNegativeControl === 'rebuild-arithmetic') {
        await database.pool.query(
          `UPDATE ${table(binding, binding.postedStockBalance)}
              SET ${quoted(field(binding.postedStockBalance, 'posted_stock_balance_posted_quantity').physicalName)} = '8'
            WHERE tenant_id = $1 AND environment_id = $2`,
          [context.tenantId, context.environmentId],
        );
      }
      assert.equal(
        await readPostedStockQuantity(runtimePool, context, binding),
        '7.000000000000000000',
        'rebuild must recover the posted ledger sum after projection loss',
      );
      assert.equal(
        await readPostedStockRecordId(runtimePool, context, binding),
        initialBalanceRecordId,
        'rebuild must reproduce the posting-maintained row identity',
      );

      const reversal = countCommand({
        countedQuantity: '5',
        expectedQuantity: '7',
        kind: 'reversal',
        reversalOfMovementId: correctionResult.movements[0]!.movementId,
        sequence: 3,
        supersedesStockCountId: correction.stockCountId,
        varianceQuantity: '-2',
      });
      await seedReviewedCount(runtimePool, context, binding, reversal);
      const reversalResult = await service.postStockCount(
        context,
        actor,
        reversal,
      );
      assertThreeValues(reversalResult.stockCountEvidence, '7', '5', '-2');
      assert.equal(reversalResult.movements[0]?.quantityDelta, '-2');
      assert.equal(
        reversalResult.stockCountEvidence?.lines[0]?.reversalOfMovementId,
        correctionResult.movements[0]!.movementId,
      );
      assertProtocolTrace(trace.splice(0), binding);

      const replay = await service.postStockCount(context, actor, reversal);
      assert.equal(replay.replayed, true);
      assert.deepEqual(
        replay.stockCountEvidence,
        reversalResult.stockCountEvidence,
      );
      const receipt = await database.pool.query<{
        input_digest_version: number;
        mutation_result: Record<string, unknown>;
      }>(
        `SELECT input_digest_version, mutation_result
             FROM platform.semantic_operation_receipts
            WHERE tenant_id=$1 AND environment_id=$2
              AND idempotency_key=$3`,
        [tenantId, environmentId, reversal.idempotencyKey],
      );
      // PUR-2b. Version 4: the caller's semantic input, without the companion
      // identities the kernel derives.
      assert.equal(receipt.rows[0]?.input_digest_version, 4);

      const persisted = await readPersistedCountChain(
        runtimePool,
        context,
        binding,
      );
      assert.equal(persisted.sessions.length, 3);
      assert.equal(persisted.lines.length, 3);
      assert.deepEqual(
        persisted.lines.map((line) => [
          normalizeDatabaseDecimal(String(line.expected)),
          normalizeDatabaseDecimal(String(line.counted)),
          normalizeDatabaseDecimal(String(line.variance)),
        ]),
        [
          ['0', '5', '5'],
          ['5', '7', '2'],
          ['7', '5', '-2'],
        ],
      );
      assert.equal(persisted.movements.length, 3);
      assert.equal(
        String(persisted.movements[2]?.reversal).toLowerCase(),
        correctionResult.movements[0]!.movementId,
      );

      for (const entity of [binding.stockCount, binding.stockCountLine]) {
        await assert.rejects(
          withModuleRole(runtimePool, context, (client) =>
            client.query(
              `DELETE FROM ${table(binding, entity)}
                WHERE tenant_id=$1 AND environment_id=$2`,
              [tenantId, environmentId],
            ),
          ),
          'removing the no-hard-delete protection must make this DELETE succeed',
        );
      }
      const retained = await readPersistedCountChain(
        runtimePool,
        context,
        binding,
      );
      assert.equal(retained.sessions.length, 3);
      assert.equal(retained.lines.length, 3);
      assert.equal(retained.movements.length, 3);

      const trust = await database.pool.query<{
        changes: unknown;
        payload: unknown;
      }>(
        `SELECT change.changes, event.payload
             FROM platform.trust_business_change_documents AS change
             JOIN platform.trust_domain_events AS event
               ON event.tenant_id=change.tenant_id
              AND event.environment_id=change.environment_id
              AND event.change_document_id=change.change_document_id
            WHERE change.tenant_id=$1 AND change.environment_id=$2
              AND change.action_id=$3`,
        [tenantId, environmentId, INVENTORY_CONTRACT_V1.capabilityId],
      );
      assert.ok(trust.rows.length >= 3);
      const observedEvidence = [
        initialResult.stockCountEvidence,
        correctionResult.stockCountEvidence,
        reversalResult.stockCountEvidence,
        receipt.rows[0]?.mutation_result,
        ...trust.rows.flatMap((row) => [row.changes, row.payload]),
      ];
      assert.deepEqual(monetaryMembers(observedEvidence), []);
      assert.deepEqual(
        monetaryMembers({
          fieldId: 'unitCost',
          newState: { value: '1.00' },
        }),
        ['unitCost'],
        'the scan must inspect semantic fieldId values, not only property names',
      );
      await assertRejectedStockCountCommands({
        actor,
        adminPool: database.pool,
        binding,
        context,
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
});

// STOCK-COUNTS C1. A count posts only the expected the ledger holds at its
// location as of its own instant, so on-hand afterwards is what was counted;
// one reviewed before a posting it does not know about is refused whole.
test('stock-count expected: a stale expected is refused and posts nothing, and a count names each item once', async () => {
  await withCompanionEnvironment(
    'count-expected-stale',
    async ({ actor, binding, context, runtimePool, service }) => {
      const first = countCommand({
        countedQuantity: '5',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 31,
        supersedesStockCountId: null,
        varianceQuantity: '5',
      });
      await seedReviewedCount(runtimePool, context, binding, first);
      await service.postStockCount(context, actor, first);

      // Reviewed while nothing was on hand; 5 have been posted since.
      const stale = countCommand({
        countedQuantity: '3',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 32,
        supersedesStockCountId: null,
        varianceQuantity: '3',
      });
      await seedReviewedCount(runtimePool, context, binding, stale);
      const victim =
        'deleting the expected-is-ledger check must make this stale count post';
      await assert.rejects(
        () => service.postStockCount(context, actor, stale),
        (error: unknown) => {
          assert.ok(error instanceof InventoryPostingError, victim);
          assert.equal(error.code, 'INVENTORY_COUNT_EXPECTED_STALE', victim);
          assert.deepEqual(
            error.details,
            {
              expectedQuantity: '0',
              itemId,
              locationId,
              postedQuantity: '5',
              stockCountLineId: stale.lines[0]!.stockCountLineId,
            },
            victim,
          );
          return true;
        },
        victim,
      );
      assert.equal(
        await readPostedStockQuantity(runtimePool, context, binding),
        '5.000000000000000000',
        'a refused count must leave on-hand where it was',
      );
      assert.deepEqual(
        await readCountOutcome(runtimePool, context, binding, stale),
        { movements: 0, state: 'reviewed' },
        'a refused count stays reviewed and writes no movement',
      );

      // Reviewed against the ledger, the same count leaves 3 on hand.
      const fresh = countCommand({
        countedQuantity: '3',
        expectedQuantity: '5',
        kind: 'initial',
        sequence: 33,
        supersedesStockCountId: null,
        varianceQuantity: '-2',
      });
      await seedReviewedCount(runtimePool, context, binding, fresh);
      const posted = await service.postStockCount(context, actor, fresh);
      assert.equal(posted.movements[0]?.quantityDelta, '-2');
      assert.equal(
        await readPostedStockQuantity(runtimePool, context, binding),
        '3.000000000000000000',
        'a posted count leaves on-hand at what was counted',
      );

      // Each line's expected is the whole ledger for its item, so a second
      // line for the same item would post its variance twice. Reviewed and
      // stored like any count, so only the rule stands between it and Post.
      const single = countCommand({
        countedQuantity: '3',
        expectedQuantity: '3',
        kind: 'initial',
        sequence: 34,
        supersedesStockCountId: null,
        varianceQuantity: '0',
      });
      const twice = {
        ...single,
        lines: [
          single.lines[0]!,
          {
            ...single.lines[0]!,
            countedQuantity: '4',
            sourceLine: '35',
            stockCountLineId: '63000000-0000-4000-8000-000000000035',
            varianceQuantity: '1',
          },
        ],
      };
      await seedReviewedCount(runtimePool, context, binding, twice);
      await assertCountPostingRejected(
        () => service.postStockCount(context, actor, twice),
        'INVENTORY_POSTING_INPUT_INVALID',
        /a stock count names each item once/u,
        'deleting the one-line-per-item rule must let one item be counted twice',
      );
      assert.equal(
        await readPostedStockQuantity(runtimePool, context, binding),
        '3.000000000000000000',
        'a count naming one item twice posts nothing',
      );
    },
  );
});

// STOCK-COUNTS C2. Expected is read as of the count's own instant: a movement
// dated after it is not part of what was counted, and one at that instant is.
test('stock-count expected: a movement dated after the count does not make it stale, and one at its instant counts before it', async () => {
  await withCompanionEnvironment(
    'count-expected-as-of',
    async ({ actor, binding, context, runtimePool, service }) => {
      // Counted at 12:30: 4 found where the ledger held nothing.
      const later = {
        ...countCommand({
          countedQuantity: '4',
          expectedQuantity: '0',
          kind: 'initial',
          sequence: 41,
          supersedesStockCountId: null,
          varianceQuantity: '4',
        }),
        effectiveAt: '2026-07-30T12:30:00.000Z',
      };
      await seedReviewedCount(runtimePool, context, binding, later);
      await service.postStockCount(context, actor, later);

      // Counted at 12:00, before those 4 were: its expected is still 0.
      const earlier = countCommand({
        countedQuantity: '2',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 42,
        supersedesStockCountId: null,
        varianceQuantity: '2',
      });
      await seedReviewedCount(runtimePool, context, binding, earlier);
      const posted = await service.postStockCount(context, actor, earlier);
      assert.equal(
        posted.movements[0]?.quantityDelta,
        '2',
        'a movement dated after the count must not make its expected stale',
      );

      // Counted at 12:30 again: both movements are at or before that instant,
      // the one at 12:30 itself included.
      const atInstant = {
        ...countCommand({
          countedQuantity: '6',
          expectedQuantity: '6',
          kind: 'initial',
          sequence: 43,
          supersedesStockCountId: null,
          varianceQuantity: '0',
        }),
        effectiveAt: '2026-07-30T12:30:00.000Z',
      };
      await seedReviewedCount(runtimePool, context, binding, atInstant);
      const confirmed = await service.postStockCount(context, actor, atInstant);
      assert.equal(confirmed.movements[0]?.quantityDelta, '0');
      assert.equal(
        await readPostedStockQuantity(runtimePool, context, binding),
        '6.000000000000000000',
      );
    },
  );
});

// STOCK-COUNTS C3. A correction supersedes exactly one posted count at the same
// location, and posts what is counted less what the ledger holds now.
test('stock-count correction: a correction at another location is refused, and one posted count takes one correction', async () => {
  await withCompanionEnvironment(
    'count-correction-location',
    async ({ actor, binding, context, runtimePool, service }) => {
      await withModuleRole(runtimePool, context, (client) =>
        insertEntity(
          client,
          binding,
          binding.location,
          {
            location_code: 'LOC-COUNT-OTHER',
            location_name: 'Another count location',
          },
          otherLocationId,
          null,
          {},
        ),
      );
      const original = countCommand({
        countedQuantity: '5',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 51,
        supersedesStockCountId: null,
        varianceQuantity: '5',
      });
      await seedReviewedCount(runtimePool, context, binding, original);
      await service.postStockCount(context, actor, original);

      // A true count of the other location, filed as this count's correction.
      const elsewhere = {
        ...countCommand({
          countedQuantity: '1',
          expectedQuantity: '0',
          kind: 'correction',
          sequence: 52,
          supersedesStockCountId: original.stockCountId,
          varianceQuantity: '1',
        }),
        locationId: otherLocationId,
      };
      await seedReviewedCount(runtimePool, context, binding, elsewhere);
      await assertCountPostingRejected(
        () => service.postStockCount(context, actor, elsewhere),
        'INVENTORY_COUNT_COMPENSATION_CONFLICT',
        /must supersede one posted count at the same location/u,
        'deleting the same-location comparison must let a correction supersede a count of another location',
      );

      const here = countCommand({
        countedQuantity: '4',
        expectedQuantity: '5',
        kind: 'correction',
        sequence: 53,
        supersedesStockCountId: original.stockCountId,
        varianceQuantity: '-1',
      });
      await seedReviewedCount(runtimePool, context, binding, here);
      const corrected = await service.postStockCount(context, actor, here);
      assert.equal(corrected.movements[0]?.postingRole, 'correction');
      assert.equal(corrected.movements[0]?.quantityDelta, '-1');
      assert.equal(
        await readPostedStockQuantity(runtimePool, context, binding),
        '4.000000000000000000',
      );

      const again = countCommand({
        countedQuantity: '3',
        expectedQuantity: '4',
        kind: 'correction',
        sequence: 54,
        supersedesStockCountId: original.stockCountId,
        varianceQuantity: '-1',
      });
      await seedReviewedCount(runtimePool, context, binding, again);
      await assertCountPostingRejected(
        () => service.postStockCount(context, actor, again),
        'INVENTORY_COUNT_COMPENSATION_CONFLICT',
        /already has a posted compensation/u,
        'deleting the one-compensation rule must let a count be corrected twice',
      );
    },
  );
});

/**
 * PUR-2a ACCEPTANCE CONTROL, named by `purchasing-sales-v1-plan.md` section
 * 7.16: create and review a stock-count source with NO pre-staged transaction
 * or transaction lines, post it through the compiled family-execution binding,
 * and prove the kernel derives and writes both companion IDs and both
 * revisions.
 */
test('stock-count companion derivation: a source with no pre-staged transaction posts and the kernel writes both companion identities', async () => {
  await withCompanionEnvironment(
    'companion-derivation',
    async ({ actor, binding, context, runtimePool, service }) => {
      const command = countCommand({
        countedQuantity: '5',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 1,
        supersedesStockCountId: null,
        varianceQuantity: '5',
      });
      await seedReviewedCount(runtimePool, context, binding, command);

      // The source exists and its companion does not. Both halves matter: a
      // fixture that quietly staged a transaction would make everything below
      // pass while proving nothing.
      const before = await readCompanionState(runtimePool, context, binding);
      assert.equal(
        before.sessions.length,
        1,
        'the reviewed stock-count source must exist before posting',
      );
      assert.equal(
        before.sessions[0]?.companionId,
        null,
        'a reviewed stock count must not name a companion transaction',
      );
      assert.deepEqual(
        before.lines.map((line) => line.companionId),
        [null],
        'a reviewed stock-count line must not name a companion transaction line',
      );
      assert.equal(
        before.transactions.length,
        0,
        'nothing may pre-stage the companion transaction: staging one here is the shape three design passes assumed',
      );
      assert.equal(
        before.transactionLines.length,
        0,
        'nothing may pre-stage companion transaction lines',
      );

      const result = await service.postStockCount(context, actor, command);

      // Recomputed from the source ids alone, not read out of the result.
      const derivedTransactionId = expectedCompanionTransactionId(
        command.stockCountId,
      );
      const derivedLineId = expectedCompanionTransactionLineId(
        command.lines[0]!.stockCountLineId,
      );
      assert.notEqual(
        derivedTransactionId,
        derivedLineId,
        'the transaction and line derivations must not collide',
      );
      assert.equal(
        result.transactionId,
        derivedTransactionId,
        'the posting result must name the derived companion transaction',
      );

      const after = await readCompanionState(runtimePool, context, binding);
      assert.deepEqual(
        {
          line: after.lines.map((line) => line.companionId),
          session: after.sessions[0]?.companionId,
        },
        { line: [derivedLineId], session: derivedTransactionId },
        'the kernel must write both derived companion identities onto the source',
      );
      assert.equal(
        after.transactions.length,
        1,
        'the kernel must write exactly one companion transaction',
      );
      assert.equal(
        after.transactions[0]?.recordId,
        derivedTransactionId,
        'the companion transaction identity must be the derived one',
      );
      // Every fact the source transition writes, on the row it writes it to.
      // Round 3 found the actor and instant escaping observation entirely: the
      // companion header carried the right values while the source could carry
      // wrong ones, and the trust documents recorded the expected in-memory
      // values either way.
      assert.deepEqual(
        {
          actorId: after.sessions[0]?.actorId,
          recordedAt: after.sessions[0]?.recordedAt,
          state: after.sessions[0]?.state,
        },
        {
          actorId: principalId,
          recordedAt,
          state: enumOption(
            field(binding.stockCount, 'stock_count_state'),
            'posted',
          ),
        },
        'the posted source must carry the actor, instant and state its transition wrote',
      );

      // Both revisions, and the fact that they are the SAME derived revision.
      // Corrected on review. The companion is a CREATE, so it takes the
      // compiled optimistic-revision contract's initial value; it does not
      // inherit the source's post-transition revision. The source-to-companion
      // join is the derived identity, not revision equality.
      // Every revision the posting touches, compared as one value. The
      // companion header and line are CREATES and take the contract's initial
      // revision; the source header and line were MUTATED and must each have
      // advanced by exactly one from the revision 1 they were seeded at.
      assert.deepEqual(
        {
          companionHeader: after.transactions[0]?.revision,
          companionLine: after.transactionLines[0]?.revision,
          sourceHeader: after.sessions[0]?.revision,
          sourceLine: after.lines[0]?.revision,
        },
        {
          companionHeader: 1,
          companionLine: 1,
          sourceHeader: 2,
          sourceLine: 2,
        },
        'creates take the contract initial revision and mutated rows advance by one',
      );
      assert.equal(
        after.transactions[0]?.state,
        enumOption(
          field(binding.transaction, 'inventory_transaction_state'),
          'posted',
        ),
        'the kernel-written companion is created posted',
      );

      // Determinism: the same source derives the same companion, and a
      // different source does not.
      assert.equal(
        expectedCompanionTransactionId(command.stockCountId),
        derivedTransactionId,
        'companion derivation must be deterministic',
      );
      // STABILITY, which determinism alone does not give. Every assertion
      // above compares the kernel against `deriveInventoryPostingCompanionId`,
      // so a derivation that changed but stayed deterministic would move both
      // sides together and pass -- including the kernel's own read-back, which
      // recomputes with the same function. These two literals were computed by
      // a separate implementation of the construction and are the only thing
      // here that does not share the algorithm under test. A companion
      // identity that moves is a reconciliation predicate that silently stops
      // matching every already-posted count.
      // Compared as ONE value so neither half masks the other. Two sequential
      // equality assertions would stop at the transaction and never observe
      // the line, which is a claim wider than the evidence.
      assert.deepEqual(
        { line: derivedLineId, transaction: derivedTransactionId },
        {
          line: 'f11c5615-3db4-85b4-826a-f6827441cbb4',
          transaction: 'a2cdba01-9fed-8821-b202-0c2739d6cbe6',
        },
        'both companion derivations must be stable across releases',
      );
      assert.notEqual(
        expectedCompanionTransactionId('61000000-0000-4000-8000-000000000099'),
        derivedTransactionId,
        'companion derivation must separate distinct sources',
      );
    },
  );
});

test('stock-count companion derivation: the companion transaction and its lines are the kernel projection of the count', async () => {
  await withCompanionEnvironment(
    'companion-projection',
    async ({ actor, binding, context, runtimePool, service }) => {
      // A positive initial count, then a negative correction, so the
      // sign-dependent from/to projection is observed in both directions.
      const opening = countCommand({
        countedQuantity: '6',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 3,
        supersedesStockCountId: null,
        varianceQuantity: '6',
      });
      await seedReviewedCount(runtimePool, context, binding, opening);
      await service.postStockCount(context, actor, opening);

      const command = countCommand({
        countedQuantity: '2',
        expectedQuantity: '6',
        kind: 'correction',
        sequence: 5,
        supersedesStockCountId: opening.stockCountId,
        varianceQuantity: '-4',
      });
      await seedReviewedCount(runtimePool, context, binding, command);
      await service.postStockCount(context, actor, command);

      const derivedTransactionId = expectedCompanionTransactionId(
        command.stockCountId,
      );
      const openingTransactionId = expectedCompanionTransactionId(
        opening.stockCountId,
      );
      const after = await readCompanionState(runtimePool, context, binding);
      const header = after.transactions.find(
        (candidate) => candidate.recordId === derivedTransactionId,
      )!;
      assert.ok(header, 'the correction companion must exist');
      const openingLine = after.transactionLines.find(
        (candidate) => candidate.transactionId === openingTransactionId,
      )!;
      assert.ok(openingLine, 'the opening companion line must exist');
      assert.equal(
        openingLine.toLocationId,
        locationId,
        'a positive variance is a move INTO the counted location',
      );
      assert.equal(openingLine.fromLocationId, null);
      const openingHeader = after.transactions.find(
        (candidate) => candidate.recordId === openingTransactionId,
      )!;
      assert.ok(openingHeader, 'the opening companion must exist');
      // BOTH roles the stock_count family declares, compared as one value so
      // neither masks the other: the opening posts under `count` and the
      // correction under `correction`, and each takes its companion type from
      // its own role binding in the roster.
      const expectedCountCorrectionType = enumOption(
        field(binding.transaction, 'inventory_transaction_type'),
        'count_correction',
      );
      assert.deepEqual(
        { correction: header.type, count: openingHeader.type },
        {
          correction: expectedCountCorrectionType,
          count: expectedCountCorrectionType,
        },
        'each role companion type comes from its own family role binding',
      );
      assert.equal(
        header.number,
        `SC-${derivedTransactionId}`,
        'the companion business key must be derived from the companion identity',
      );
      assert.equal(
        header.sourceType,
        command.sourceType,
        'the companion must record the family source type',
      );
      assert.equal(
        header.sourceId,
        command.stockCountId,
        'the companion must point back at the source it was derived from',
      );
      assert.equal(header.reasonCode, command.reason.code);
      assert.equal(header.reasonNarrative, command.reason.narrative);

      assert.equal(after.transactionLines.length, 2);
      const line = after.transactionLines.find(
        (candidate) => candidate.transactionId === derivedTransactionId,
      )!;
      assert.ok(line, 'the correction companion line must exist');
      assert.equal(
        line.recordId,
        expectedCompanionTransactionLineId(command.lines[0]!.stockCountLineId),
      );
      assert.equal(
        line.transactionId,
        derivedTransactionId,
        'the companion line must belong to the companion transaction',
      );
      assert.equal(
        line.quantity,
        '-4.000000000000000000',
        'the companion line quantity is the count variance',
      );
      // A negative variance leaves the location, so it is a from-location move.
      assert.equal(
        line.fromLocationId,
        locationId,
        'a negative variance is a move OUT of the counted location',
      );
      assert.equal(line.toLocationId, null);
      assert.equal(line.itemId, command.lines[0]!.itemId);
      assert.equal(line.unitId, command.lines[0]!.unitId);
    },
  );
});

/**
 * PUR-2a, round 8. The seventh writer.
 *
 * A movement insert fires an `AFTER INSERT` trigger that maintains the
 * browsable posted-stock balance in the same transaction. Nothing observed
 * that write: the trigger checked its own `ROW_COUNT`, and a wrong-but-valid
 * balance committed silently until reconciliation independently recomputed it.
 *
 * This is the test that makes the observation load-bearing. Both halves are
 * needed. The first proves a balance that was ALREADY divergent before this
 * posting refuses the posting that adds to it -- a correct delta applied to a
 * wrong base is still a wrong browsable row. The second proves a projection
 * that did not maintain itself at all refuses too. A verifier removed, or a
 * projection binding that resolves to nothing, fails here.
 */
test('stock-count posted-stock projection: a balance that does not equal the movement ledger refuses the posting', async () => {
  await withCompanionEnvironment(
    'posted-stock-refusal',
    async ({ actor, binding, context, databasePool, runtimePool, service }) => {
      const initial = countCommand({
        countedQuantity: '5',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 5,
        supersedesStockCountId: null,
        varianceQuantity: '5',
      });
      await seedReviewedCount(runtimePool, context, binding, initial);
      await service.postStockCount(context, actor, initial);
      assert.equal(
        await readPostedStockQuantity(runtimePool, context, binding),
        '5.000000000000000000',
        'the projection must carry the posted ledger before anything is corrupted',
      );

      const correction = countCommand({
        countedQuantity: '7',
        expectedQuantity: '5',
        kind: 'correction',
        sequence: 6,
        supersedesStockCountId: initial.stockCountId,
        varianceQuantity: '2',
      });
      await seedReviewedCount(runtimePool, context, binding, correction);

      const quantityColumn = quoted(
        field(
          binding.postedStockBalance,
          'posted_stock_balance_posted_quantity',
        ).physicalName,
      );
      const divergence = await databasePool.query(
        `UPDATE ${table(binding, binding.postedStockBalance)}
            SET ${quantityColumn} = ${quantityColumn} + 1
          WHERE tenant_id = $1 AND environment_id = $2`,
        [context.tenantId, context.environmentId],
      );
      assert.equal(
        divergence.rowCount,
        1,
        'the control must actually diverge the browsable row first',
      );
      await assertCountPostingRejected(
        () => service.postStockCount(context, actor, correction),
        'INVENTORY_POSTING_STORAGE_REJECTED',
        /does not equal the movement ledger it projects/u,
        'a balance already divergent from the ledger must refuse the posting that adds to it',
      );
      const afterDivergence = await readCompanionState(
        runtimePool,
        context,
        binding,
      );
      assert.equal(
        afterDivergence.transactions.length,
        1,
        'the refused posting must leave no companion transaction behind',
      );
      assert.equal(
        afterDivergence.movements.length,
        1,
        'the refused posting must leave no movement behind',
      );

      const repaired = await databasePool.query(
        `UPDATE ${table(binding, binding.postedStockBalance)}
            SET ${quantityColumn} = ${quantityColumn} - 1
          WHERE tenant_id = $1 AND environment_id = $2`,
        [context.tenantId, context.environmentId],
      );
      assert.equal(
        repaired.rowCount,
        1,
        'the second half must measure an unmaintained projection, not the first half leftover',
      );

      await disablePostedStockTrigger(databasePool, binding);
      await assertCountPostingRejected(
        () => service.postStockCount(context, actor, correction),
        'INVENTORY_POSTING_STORAGE_REJECTED',
        /does not equal the movement ledger it projects/u,
        'a posting whose projection trigger did not maintain the balance must refuse',
      );
      assert.equal(
        await readPostedStockQuantity(runtimePool, context, binding),
        '5.000000000000000000',
        'the refused posting must leave the projection exactly as it found it',
      );
      const afterUnmaintained = await readCompanionState(
        runtimePool,
        context,
        binding,
      );
      assert.equal(
        afterUnmaintained.movements.length,
        1,
        'the refused posting must not commit its movement',
      );
    },
  );
});

/**
 * PUR-2a gate-invisible deliverable, named as an acceptance criterion: the
 * binding makes an operator-visible refusal possible that did not exist
 * before. The kernel writes the companion identity at post time, so a reviewed
 * source that already names one was written by something else, and posting it
 * refuses rather than adopting whatever is stored.
 */
test('stock-count companion derivation: a reviewed count that already names a companion transaction is refused', async () => {
  await withCompanionEnvironment(
    'companion-refusal',
    async ({ actor, binding, context, runtimePool, service }) => {
      const command = countCommand({
        countedQuantity: '5',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 4,
        supersedesStockCountId: null,
        varianceQuantity: '5',
      });
      await seedReviewedCount(runtimePool, context, binding, command);
      const foreignTransactionId = '68000000-0000-4000-8000-000000000068';
      await withModuleRole(runtimePool, context, async (client) => {
        await insertEntity(
          client,
          binding,
          binding.transaction,
          {
            inventory_transaction_actor_id: principalId,
            inventory_transaction_effective_at: command.effectiveAt,
            inventory_transaction_number: 'FOREIGN-COUNT-TXN',
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
          foreignTransactionId,
          command.legalEntityId,
          {},
        );
        const written = await client.query(
          `UPDATE ${table(binding, binding.stockCount)}
              SET ${quoted(relationColumn(binding, binding.stockCount, binding.transaction))} = $4::uuid
            WHERE tenant_id = $1 AND environment_id = $2
              AND ${quoted(binding.stockCount.recordIdColumn)} = $3`,
          [
            context.tenantId,
            context.environmentId,
            command.stockCountId,
            foreignTransactionId,
          ],
        );
        assert.equal(
          written.rowCount,
          1,
          'the control must actually pre-write a companion identity',
        );
      });

      const refusal = await service
        .postStockCount(context, actor, command)
        .then(
          () => null,
          (reason: unknown) => reason,
        );
      assert.ok(
        refusal instanceof InventoryPostingError,
        'a reviewed count carrying a companion identity the kernel did not write must be refused',
      );
      assert.equal(
        refusal.code,
        'INVENTORY_COUNT_EVIDENCE_CONFLICT',
        'the refusal must be an evidence conflict',
      );
      // Which refusal it is matters. Without the reviewed-must-be-null fence
      // the kernel adopts the foreign companion and the posting is refused
      // further down, at the LINE check, for a reason that sends an operator
      // to the wrong record. The message also has to name the COMPANION
      // specifically: this is the refusal every pre-derivation stock count
      // meets, and "does not match the reviewed evidence" would send someone
      // to compare quantities that are correct.
      assert.match(
        refusal.message,
        /already names a companion transaction/u,
        'the refusal must name the companion, not the reviewed evidence at large',
      );

      const after = await readCompanionState(runtimePool, context, binding);
      assert.equal(
        after.sessions[0]?.companionId,
        foreignTransactionId,
        'the refusal must leave the stored state alone',
      );
      assert.equal(
        after.movements.length,
        0,
        'a refused posting must write no movement',
      );
    },
  );
});

test("PUR-2b: the version-4 digest covers the caller's semantic input and not the identities the kernel derives", async () => {
  await withCompanionEnvironment(
    'companion-digest-version',
    async ({ actor, binding, context, databasePool, runtimePool, service }) => {
      const command = countCommand({
        countedQuantity: '5',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 5,
        supersedesStockCountId: null,
        varianceQuantity: '5',
      });
      await seedReviewedCount(runtimePool, context, binding, command);
      const posted = await service.postStockCount(context, actor, command);

      const receipt = await readReceipt(databasePool, command.idempotencyKey);
      assert.equal(
        receipt.inputDigestVersion,
        4,
        'a stock-count posting must write the version migration 0023 admits',
      );

      // PUR-2b. The capability version, asserted as a LITERAL on both sides it
      // reaches. Every one of its 21 references is symbolic, so a bump is
      // invisible to every other gate in the matrix: without this the constant
      // could be moved, or moved back, with nothing observing it. The trust
      // metadata is the durable half -- an operator auditing a posting reads
      // the recorded version, not the constant.
      assert.equal(
        posted.capabilityVersion,
        2,
        'a posting result must declare the capability version that produced it',
      );
      assert.equal(
        await readInvocationCapabilityVersion(
          databasePool,
          posted.trust.invocationId,
        ),
        2,
        'the persisted trust invocation must record the capability version',
      );

      // The expected digest is built from the CALLER's command -- the object
      // this test authored -- and not from anything the service returned. The
      // kernel-derived identities are absent because a caller cannot send
      // them: `exactKeys` refuses both keys outright. posting-kernel-admission
      // (5g3-prog R2): the derived posting role is absent too. It is
      // `count` for kind `initial` and `correction` otherwise -- a pure
      // function of the `kind` the input already covers -- so the digest is
      // exactly the caller's command minus its key, and nothing else.
      const { idempotencyKey, ...callerInput } = command;
      void idempotencyKey;
      const callerDigest = createHash('sha256')
        .update(canonicalize(callerInput))
        .digest('hex');

      // The role twin, asserted FIRST so that restoring the role produces its
      // own red rather than the caller's-input one: what the digest would be
      // had the derived role been kept. It must differ from the caller digest
      // -- or this discriminates nothing -- and the stored digest must not be
      // it.
      const digestWithDerivedRole = createHash('sha256')
        .update(canonicalize({ postingRole: 'count', ...callerInput }))
        .digest('hex');
      assert.notEqual(
        digestWithDerivedRole,
        callerDigest,
        'the role twin must differ from the caller digest, or this test discriminates nothing',
      );
      assert.notEqual(
        receipt.inputDigest,
        digestWithDerivedRole,
        'the stored digest must not cover the posting role the kernel derives from the kind',
      );
      assert.equal(
        receipt.inputDigest,
        callerDigest,
        "the version-4 digest must be the digest of the caller's semantic input",
      );

      // The other half, and without it the assertion above is satisfied by any
      // implementation that happens to hash something: this is what the digest
      // would have been had the derived identities been kept and merely
      // renumbered, and it must NOT be what was stored.
      const digestWithDerivedIdentities = createHash('sha256')
        .update(
          canonicalize({
            postingRole: 'count',
            ...callerInput,
            lines: callerInput.lines.map((line) => ({
              ...line,
              transactionLineId: expectedCompanionTransactionLineId(
                line.stockCountLineId,
              ),
            })),
            transactionId: expectedCompanionTransactionId(command.stockCountId),
          }),
        )
        .digest('hex');
      assert.notEqual(
        digestWithDerivedIdentities,
        callerDigest,
        'the two candidate digests must differ, or this test discriminates nothing',
      );
      assert.notEqual(
        receipt.inputDigest,
        digestWithDerivedIdentities,
        'the stored digest must not cover the identities the kernel derived',
      );

      // Replay still works, which is the point of a digest: the same caller
      // input under the same key returns the recorded result rather than
      // conflicting with it.
      const replay = await service.postStockCount(context, actor, command);
      assert.equal(
        replay.replayed,
        true,
        'an unchanged stock-count command must replay under version 4',
      );
    },
  );
});

test('PUR-2b: a pre-derivation version-3 receipt is refused as unreconstructible, not as a reused idempotency key', async () => {
  await withCompanionEnvironment(
    'companion-digest-legacy',
    async ({ actor, binding, context, databasePool, runtimePool, service }) => {
      const command = countCommand({
        countedQuantity: '5',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 6,
        supersedesStockCountId: null,
        varianceQuantity: '5',
      });
      await seedReviewedCount(runtimePool, context, binding, command);
      const posted = await service.postStockCount(context, actor, command);

      // A specimen of the shape every stock-count receipt had before PUR-2a:
      // version 3, recording capability version 1, over a command whose
      // companion identities the CALLER supplied. No migration can recompute
      // such a row -- the receipt stores the digest and the result, never the
      // input -- which is the fact the refusal below rests on.
      const legacyKey = '62000000-0000-4000-8000-0000000000ff';
      // ROUND 2 SUGGESTED COHERENCE HERE AND IT IS THE WRONG TRADE ON THIS
      // ROUTE, which the expected-red gate caught rather than a reviewer.
      //
      // Computing this digest over the identities the posting actually DERIVED
      // makes the row internally coherent, and it is what the natural-replay
      // specimens do, because there the digest is never read. On THIS route it
      // destroys the control: `legacy-version-three-recomputes-a-fresh-digest`
      // restores a fresh version-3 recomputation, and a fresh recomputation
      // over the derived command produces exactly that coherent digest -- so
      // the digests MATCH, the replay succeeds, and the mutation stops
      // producing a refusal at all.
      //
      // The caller-chosen identities therefore DIFFER from the derivation here,
      // which is also the realistic legacy case: a caller whose ids coincided
      // with a derivation that did not yet exist is the one case that needs no
      // refusal. The residual incoherence is stated rather than removed -- the
      // cloned effects carry derived ids while this digest is over different
      // ones -- and it is immaterial on this route, which refuses on the
      // VERSION before reading either.
      const callerChosenTransactionId = '64000000-0000-4000-8000-000000000064';
      const callerChosenLineId = '65000000-0000-4000-8000-000000000065';
      assert.notEqual(
        callerChosenTransactionId,
        posted.transactionId,
        'the specimen must be the case that needs the refusal: caller-chosen ids UNREACHABLE from the derivation',
      );
      const { idempotencyKey, ...callerInput } = command;
      void idempotencyKey;
      const legacyDigest = createHash('sha256')
        .update(
          canonicalize({
            postingRole: 'count',
            ...callerInput,
            lines: callerInput.lines.map((line) => ({
              ...line,
              transactionLineId: callerChosenLineId,
            })),
            transactionId: callerChosenTransactionId,
          }),
        )
        .digest('hex');
      await cloneReceiptAsPreDerivationVersion3(
        databasePool,
        command.idempotencyKey,
        legacyKey,
        legacyDigest,
      );

      const refusal = await service
        .postStockCount(context, actor, {
          ...command,
          idempotencyKey: legacyKey,
        })
        .then(
          () => null,
          (reason: unknown) => reason,
        );
      assert.ok(
        refusal instanceof InventoryPostingError,
        'a version-3 stock-count receipt must be refused rather than replayed unverified',
      );
      assert.equal(refusal.code, 'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT');
      // WHICH refusal it is, is the whole finding. Recomputing version 3 over a
      // derived command cannot match a caller-chosen one, so the untreated code
      // reports `already names another posting` -- an accusation that the
      // caller reused a key for DIFFERENT input. The input is identical and the
      // kernel changed underneath it, so that message sends an operator to
      // audit a caller that did nothing wrong.
      assert.match(
        refusal.message,
        /cannot be reconstructed from a kernel-derived command/u,
        'the refusal must name the derivation change as the reason',
      );
      assert.doesNotMatch(
        refusal.message,
        /already names another posting/u,
        'the refusal must not accuse the caller of reusing the key for other input',
      );
      assert.equal(
        refusal.details?.inputDigestVersion,
        '3',
        'the refusal must name the version it could not reconstruct',
      );

      // The stored row is untouched: a transition that carried released data by
      // rewriting or removing a trust record would be a hard delete of business
      // data, which the platform forbids outright.
      const stored = await readReceipt(databasePool, legacyKey);
      assert.deepEqual(
        {
          inputDigest: stored.inputDigest,
          inputDigestVersion: stored.inputDigestVersion,
        },
        { inputDigest: legacyDigest, inputDigestVersion: 3 },
        'the refused receipt must be left exactly as it was found',
      );
    },
  );
});
// PUR-2b, ROUND-2 REVIEW FINDING. The version-3 decoder is a 2x2, not a
// switch, and the round-1 correction only covered half of it.
//
// `requiredRecordedPostingRole` decodes {version 3, version 4} x {count,
// correction}, and `postStockCount` maps kind `initial` to role `count` while
// mapping BOTH `correction` and `reversal` to role `correction`. Every PUR-2b
// specimen was an `initial` count, so no control reached the version-3 x
// `correction` cell: a mutation withdrawing only that cell left all six green
// while a legitimate correction or reversal receipt stopped decoding.
//
// These are THREE tests rather than one parameterised test on purpose. The
// expected-red runner accounts for every regression a mutation produces, so
// separate tests give the two decoder mutations DIFFERENT kill sets --
// withdrawing all of version 3 kills all three, withdrawing only the
// `correction` cell kills two and must leave the `initial` one GREEN. One
// combined test would make the narrower mutation indistinguishable from the
// broader one, since both raise the same message.
test('PUR-2b: a version-3 INITIAL count decodes through natural replay, with no digest reconstructed', async () => {
  await withCompanionEnvironment(
    'companion-digest-natural-initial',
    async (environment) => {
      const command = countCommand({
        countedQuantity: '5',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 7,
        supersedesStockCountId: null,
        varianceQuantity: '5',
      });
      await seedReviewedCount(
        environment.runtimePool,
        environment.context,
        environment.binding,
        command,
      );
      const posted = await environment.service.postStockCount(
        environment.context,
        environment.actor,
        command,
      );
      await assertVersionThreeDecodesThroughNaturalReplay({
        command,
        environment,
        expectedRole: 'count',
        freshKey: '62000000-0000-4000-8000-0000000000fd',
        legacyKey: '62000000-0000-4000-8000-0000000000fe',
        posted,
      });
    },
  );
});

test('PUR-2b: a version-3 CORRECTION decodes through natural replay, with no digest reconstructed', async () => {
  await withCompanionEnvironment(
    'companion-digest-natural-correction',
    async (environment) => {
      const opening = countCommand({
        countedQuantity: '6',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 8,
        supersedesStockCountId: null,
        varianceQuantity: '6',
      });
      await seedReviewedCount(
        environment.runtimePool,
        environment.context,
        environment.binding,
        opening,
      );
      await environment.service.postStockCount(
        environment.context,
        environment.actor,
        opening,
      );

      const command = countCommand({
        countedQuantity: '2',
        expectedQuantity: '6',
        kind: 'correction',
        sequence: 9,
        supersedesStockCountId: opening.stockCountId,
        varianceQuantity: '-4',
      });
      await seedReviewedCount(
        environment.runtimePool,
        environment.context,
        environment.binding,
        command,
      );
      const posted = await environment.service.postStockCount(
        environment.context,
        environment.actor,
        command,
      );
      // The cell round 2 found unreachable. A correction records role
      // `correction`, so this is the specimen that dies when version 3 loses
      // that cell alone.
      assert.equal(
        posted.movements[0]?.postingRole,
        'correction',
        'a correction must post under the correction role, or this specimen tests the wrong cell',
      );
      await assertVersionThreeDecodesThroughNaturalReplay({
        command,
        environment,
        expectedRole: 'correction',
        freshKey: '62000000-0000-4000-8000-0000000000fb',
        legacyKey: '62000000-0000-4000-8000-0000000000fc',
        posted,
      });
    },
  );
});

test('PUR-2b: a version-3 REVERSAL decodes through natural replay, with no digest reconstructed', async () => {
  await withCompanionEnvironment(
    'companion-digest-natural-reversal',
    async (environment) => {
      const opening = countCommand({
        countedQuantity: '6',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 10,
        supersedesStockCountId: null,
        varianceQuantity: '6',
      });
      await seedReviewedCount(
        environment.runtimePool,
        environment.context,
        environment.binding,
        opening,
      );
      const openingResult = await environment.service.postStockCount(
        environment.context,
        environment.actor,
        opening,
      );

      // A reversal must be the EXACT inverse of the movement it reverses, so
      // the opening's +6 forces -6 here.
      const command = countCommand({
        countedQuantity: '0',
        expectedQuantity: '6',
        kind: 'reversal',
        reversalOfMovementId: openingResult.movements[0]!.movementId,
        sequence: 11,
        supersedesStockCountId: opening.stockCountId,
        varianceQuantity: '-6',
      });
      await seedReviewedCount(
        environment.runtimePool,
        environment.context,
        environment.binding,
        command,
      );
      const posted = await environment.service.postStockCount(
        environment.context,
        environment.actor,
        command,
      );
      // A reversal shares the `correction` ROLE with a correction but carries a
      // distinct evidence KIND, so it exercises
      // `requiredRecordedStockCountEvidence`'s kind vocabulary as well as the
      // role cell. Round 2 asked for all three kinds for exactly this reason.
      assert.deepEqual(
        {
          kind: posted.stockCountEvidence?.kind,
          role: posted.movements[0]?.postingRole,
        },
        { kind: 'reversal', role: 'correction' },
        'a reversal must post under the correction role with reversal evidence',
      );
      await assertVersionThreeDecodesThroughNaturalReplay({
        command,
        environment,
        expectedRole: 'correction',
        freshKey: '62000000-0000-4000-8000-0000000000f9',
        legacyKey: '62000000-0000-4000-8000-0000000000fa',
        posted,
      });
    },
  );
});

/**
 * One version-3 natural replay, for one stock-count kind.
 *
 * THE SPECIMEN'S SHAPE IS FORCED, NOT CHOSEN. Receipts are immutable --
 * migration 0009 rejects UPDATE and DELETE by RULE -- so a version-3 row cannot
 * be made by rewriting the accepted one. It is added BESIDE it with an earlier
 * `recorded_at`, which is what `findNaturalReplay`'s
 * `ORDER BY receipt.recorded_at LIMIT 1` selects. Two receipts under one
 * `outbox_id` is the mechanism's own shape: `persistAdditionalReceipt` writes
 * exactly that on every natural replay, `insertReceipt` persists
 * `result.trust.outboxId`, and the schema neither makes `outbox_id` unique nor
 * admits an update.
 *
 * WHERE IT IS STILL NOT A REAL LEGACY RECEIPT, stated because round 2 caught
 * the earlier version claiming more than it was. The clone carries the CURRENT
 * posting's effects, whose companion identities are kernel-derived. The legacy
 * digest is therefore computed over THOSE identities -- an old caller whose
 * chosen ids happened to coincide with the derivation -- rather than over
 * unrelated ids, which would combine the digest of one command with the effects
 * of another. The realistic legacy case, where the ids DIFFER, is not
 * representable in a cloned row without fabricating the whole result, and it
 * does not need to be: neither route under test reads the digest. Natural
 * replay never inspects it, and the explicit-key refusal fires on the VERSION
 * before any comparison. The clone also rewrites the recorded capability
 * version to 1, because a version-3 writer recorded 1, and that difference is
 * asserted below rather than left implicit.
 */
async function assertVersionThreeDecodesThroughNaturalReplay(input: {
  readonly command: InventoryStockCountPostingCommandV2;
  readonly environment: CompanionEnvironment;
  readonly expectedRole: 'correction' | 'count';
  readonly freshKey: string;
  readonly legacyKey: string;
  readonly posted: Awaited<
    ReturnType<PostgresInventoryPostingService['postStockCount']>
  >;
}): Promise<void> {
  const { command, environment, expectedRole, freshKey, legacyKey, posted } =
    input;
  const { actor, binding, context, databasePool, runtimePool, service } =
    environment;

  const legacyDigest = preDerivationDigestOf(command, posted);
  await cloneReceiptAsPreDerivationVersion3(
    databasePool,
    command.idempotencyKey,
    legacyKey,
    legacyDigest,
    { earlier: true },
  );

  // A DIFFERENT idempotency key, so the explicit-key lookup finds nothing and
  // the posting reaches `findNaturalReplay`. That route proves equivalence from
  // the recorded principal and the complete persisted effects, so it must NOT
  // reconstruct a digest -- and a version-3 receipt must still decode.
  const replay = await service.postStockCount(context, actor, {
    ...command,
    idempotencyKey: freshKey,
  });

  assert.equal(
    replay.replayed,
    true,
    'an identical count under a new key must replay from its natural effects',
  );
  // THE ASSERTIONS THAT CARRY THE CLAIM. Decoding a version-3 receipt passes
  // through the stock-count version predicate once per recorded movement role
  // and once for the count evidence. Withdraw version 3 from either -- wholly,
  // or only for this role -- and these throw instead of returning.
  assert.deepEqual(
    replay.movements.map((movement) => movement.postingRole),
    posted.movements.map(() => expectedRole),
    'a version-3 receipt must still decode its recorded posting roles',
  );
  assert.deepEqual(
    replay.stockCountEvidence,
    posted.stockCountEvidence,
    'a version-3 receipt must still decode its stored count evidence',
  );
  // Reconstructing a digest here would raise the unreconstructible refusal, so
  // returning the recorded movements at all is the observation that no
  // reconstruction happened.
  assert.deepEqual(
    replay.movements.map((movement) => movement.movementId),
    posted.movements.map((movement) => movement.movementId),
    'natural replay must return the recorded movements, not new ones',
  );
  // History is not rewritten: the replay reports the capability version that
  // PRODUCED the receipt, not the one running now.
  assert.equal(
    replay.capabilityVersion,
    1,
    'a version-3 receipt must replay under the capability version it recorded',
  );

  const after = await readCompanionState(runtimePool, context, binding);
  assert.equal(
    after.movements.filter(
      (movement) =>
        String(movement.transactionId).toLowerCase() ===
        String(posted.transactionId).toLowerCase(),
    ).length,
    posted.movements.length,
    'a replay must not post a second time',
  );

  // The carry-forward receipt for the new key is written at the CURRENT
  // version, so the transition moves forward without touching the old row.
  assert.equal(
    (await readReceipt(databasePool, freshKey)).inputDigestVersion,
    4,
    'the receipt a natural replay adds must be written at version 4',
  );
  const specimen = await readReceipt(databasePool, legacyKey);
  assert.deepEqual(
    {
      inputDigest: specimen.inputDigest,
      inputDigestVersion: specimen.inputDigestVersion,
    },
    { inputDigest: legacyDigest, inputDigestVersion: 3 },
    'the version-3 receipt must be left exactly as it was found',
  );
}

/**
 * The version-3 digest of a command, computed the way the pre-PUR-2a writer
 * computed it: over the caller's command with the companion identities spread
 * in. The identities used are the ones the accepted posting actually wrote, so
 * the digest and the cloned effects describe ONE command rather than two.
 */
function preDerivationDigestOf(
  command: InventoryStockCountPostingCommandV2,
  posted: Awaited<
    ReturnType<PostgresInventoryPostingService['postStockCount']>
  >,
): string {
  const { idempotencyKey, ...callerInput } = command;
  void idempotencyKey;
  const lineIdBySourceLine = new Map(
    posted.movements.map((movement) => [
      movement.sourceLine,
      movement.transactionLineId,
    ]),
  );
  return createHash('sha256')
    .update(
      canonicalize({
        postingRole: posted.movements[0]!.postingRole,
        ...callerInput,
        lines: callerInput.lines.map((line) => ({
          ...line,
          transactionLineId: lineIdBySourceLine.get(line.sourceLine)!,
        })),
        transactionId: posted.transactionId,
      }),
    )
    .digest('hex');
}

async function readInvocationCapabilityVersion(
  pool: Pool,
  invocationId: string,
): Promise<number> {
  const result = await pool.query<{ capabilityVersion: number }>(
    `SELECT (metadata -> 'capabilityVersion' ->> 'value')::integer
              AS "capabilityVersion"
       FROM platform.trust_action_invocations
      WHERE tenant_id = $1 AND environment_id = $2 AND invocation_id = $3`,
    [tenantId, environmentId, invocationId],
  );
  assert.equal(result.rows.length, 1, `no trust invocation ${invocationId}`);
  return result.rows[0]!.capabilityVersion;
}

async function readReceipt(
  pool: Pool,
  idempotencyKey: string,
): Promise<{ inputDigest: string; inputDigestVersion: number }> {
  const result = await pool.query<{
    inputDigest: string;
    inputDigestVersion: number;
  }>(
    `SELECT input_digest AS "inputDigest",
            input_digest_version AS "inputDigestVersion"
       FROM platform.semantic_operation_receipts
      WHERE tenant_id = $1 AND environment_id = $2
        AND action_id = $3 AND idempotency_key = $4`,
    [tenantId, environmentId, INVENTORY_POSTING_CAPABILITY_ID, idempotencyKey],
  );
  assert.equal(result.rows.length, 1, `no receipt for ${idempotencyKey}`);
  return result.rows[0]!;
}

/**
 * Clones an accepted receipt into a second idempotency key, stamped as the
 * pre-derivation version 3 and carrying the capability version a version-3
 * writer recorded.
 *
 * Cloning rather than hand-building keeps every trust reference valid. Round 2
 * corrected the claim this comment used to make -- that the row "differs from a
 * real legacy receipt in exactly the two columns under test" -- which was false:
 * the clone carries the CURRENT posting's effects, so its companion identities
 * are kernel-derived. The callers compute the legacy digest over those same
 * identities so the digest and the effects describe one command, and
 * `capabilityVersion` is rewritten to 1 here rather than left at the current 2.
 * What remains is that a real pre-PUR-2a receipt's caller-chosen ids would
 * generally DIFFER from the derivation; that is not representable in a cloned
 * row, and neither route under test reads the digest.
 */
async function cloneReceiptAsPreDerivationVersion3(
  pool: Pool,
  sourceIdempotencyKey: string,
  targetIdempotencyKey: string,
  legacyDigest: string,
  { earlier = false }: { earlier?: boolean } = {},
): Promise<void> {
  const inserted = await pool.query(
    `INSERT INTO platform.semantic_operation_receipts (
       tenant_id, environment_id, principal_id, release_id,
       release_content_hash, action_id, idempotency_key, input_digest,
       input_digest_version, mutation_result, invocation_id, correlation_id,
       change_document_id, domain_event_id, outbox_id, recorded_at
     )
     SELECT receipt.tenant_id, receipt.environment_id, receipt.principal_id,
            receipt.release_id, receipt.release_content_hash, receipt.action_id,
            $5, $6, 3,
            jsonb_set(
              receipt.mutation_result,
              '{capabilityVersion}',
              '1'::jsonb,
              false
            ),
            receipt.invocation_id, receipt.correlation_id,
            receipt.change_document_id, receipt.domain_event_id,
            receipt.outbox_id,
            receipt.recorded_at - $7::interval
       FROM platform.semantic_operation_receipts AS receipt
      WHERE receipt.tenant_id = $1 AND receipt.environment_id = $2
        AND receipt.action_id = $3 AND receipt.idempotency_key = $4`,
    [
      tenantId,
      environmentId,
      INVENTORY_POSTING_CAPABILITY_ID,
      sourceIdempotencyKey,
      targetIdempotencyKey,
      legacyDigest,
      earlier ? '1 second' : '0 seconds',
    ],
  );
  assert.equal(
    inserted.rowCount,
    1,
    'the specimen must actually be written, or the test proves nothing',
  );
}

interface CompanionEnvironment {
  actor: StockCountActor;
  binding: StorageBinding;
  context: TrustedRequestContext;
  // PUR-2a, round 8. The owner connection. Corrupting the provider-owned
  // posted-stock projection, or disabling the trigger that maintains it, is
  // exactly what ordinary runtime writes are forbidden to do -- so the control
  // that proves the posting observes that projection needs this pool.
  databasePool: Pool;
  runtimePool: Pool;
  service: PostgresInventoryPostingService;
}

async function withCompanionEnvironment(
  label: string,
  run: (environment: CompanionEnvironment) => Promise<void>,
): Promise<void> {
  const fixture = await compiledFixture();
  const binding = storageBinding(fixture.storage);
  await withEphemeralPostgres(label, async (database) => {
    await migrateAndProvision(database.pool, fixture.inventory.releaseRoot);
    const runtimePool = new pg.Pool({
      ...database.connection,
      application_name: `pur-2a-${label}`,
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
      const releases = await persistSequence(runtimePool, context, [
        [fixture.empty, fixture.emptyDefinition],
        [fixture.inventory, fixture.inventoryDefinition],
      ]);
      await setPointer(database.pool, releases[0]!);
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
        targetReleaseId: releases[1]!,
      });
      assert.equal(prepared.schemaState, 'APPLIED');
      await setPointer(database.pool, releases[1]!);
      await seedFoundation(runtimePool, context, binding);
      const service = new PostgresInventoryPostingService(
        runtimePool,
        {
          capabilityId: INVENTORY_CONTRACT_V1.capabilityId,
          capabilityVersion: INVENTORY_POSTING_CAPABILITY_VERSION,
          dependencySetRoot: DECLARED_DEPENDENCY_ROOT,
          releaseContentHash: fixture.inventory.releaseRoot,
          releaseId: releases[1]!,
          storageTarget: fixture.storage,
          storageTargetContentHash: fixture.storageContentHash,
        },
        { currentInstant: () => recordedAt },
      );
      const actor = await new TrustedActorEnvelopeIssuer({
        resolve: async () => ({
          approvingHumanId: null,
          delegation: null,
          executionPrincipal: { kind: 'HUMAN', principalId },
          initiatingHumanId: principalId,
          subject: null,
        }),
      }).issue(context);
      await run({
        actor,
        binding,
        context,
        databasePool: database.pool,
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

function relationColumn(
  binding: StorageBinding,
  source: EntityBinding,
  target: EntityBinding,
): string {
  const matches = binding.storageTarget.relations.filter(
    (relation) =>
      relation.sourceEntityId === source.entity.entityId &&
      relation.targetEntityId === target.entity.entityId &&
      relation.relationColumn.origin !== 'field',
  );
  assert.equal(
    matches.length,
    1,
    `expected exactly one relation from ${source.entity.entityId} to ${target.entity.entityId}`,
  );
  return matches[0]!.relationColumn.physicalName;
}

interface CompanionState {
  lines: Array<{
    companionId: string | null;
    recordId: string;
    revision: number;
  }>;
  movements: Array<{ transactionId: string; transactionLineId: string }>;
  sessions: Array<{
    actorId: string | null;
    companionId: string | null;
    recordedAt: string | null;
    revision: number;
    state: string;
  }>;
  transactionLines: Array<{
    fromLocationId: string | null;
    itemId: string;
    quantity: string;
    recordId: string;
    revision: number;
    toLocationId: string | null;
    transactionId: string;
    unitId: string;
  }>;
  transactions: Array<{
    number: string;
    reasonCode: string | null;
    reasonNarrative: string | null;
    recordId: string;
    revision: number;
    sourceId: string;
    sourceType: string;
    state: string;
    type: string;
  }>;
}

async function readCompanionState(
  pool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
): Promise<CompanionState> {
  return withModuleRole(pool, context, async (client) => {
    const scope = [context.tenantId, context.environmentId];
    const sessions = await client.query<Record<string, unknown>>(
      `SELECT ${quoted(relationColumn(binding, binding.stockCount, binding.transaction))}::text AS "companionId",
              ${quoted(binding.stockCount.revisionColumn)}::integer AS revision,
              ${quoted(field(binding.stockCount, 'stock_count_state').physicalName)} AS state,
              ${quoted(field(binding.stockCount, 'stock_count_actor_id').physicalName)} AS "actorId",
              to_char(${quoted(field(binding.stockCount, 'stock_count_recorded_at').physicalName)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
         FROM ${table(binding, binding.stockCount)}
        WHERE tenant_id=$1 AND environment_id=$2 AND archived_at IS NULL
        ORDER BY ${quoted(binding.stockCount.recordIdColumn)}`,
      scope,
    );
    const lines = await client.query<Record<string, unknown>>(
      `SELECT ${quoted(binding.stockCountLine.recordIdColumn)}::text AS "recordId",
              ${quoted(binding.stockCountLine.revisionColumn)}::integer AS revision,
              ${quoted(relationColumn(binding, binding.stockCountLine, binding.transactionLine))}::text AS "companionId"
         FROM ${table(binding, binding.stockCountLine)}
        WHERE tenant_id=$1 AND environment_id=$2 AND archived_at IS NULL
        ORDER BY ${quoted(binding.stockCountLine.recordIdColumn)}`,
      scope,
    );
    const transactions = await client.query<Record<string, unknown>>(
      `SELECT ${quoted(binding.transaction.recordIdColumn)}::text AS "recordId",
              ${quoted(binding.transaction.revisionColumn)}::integer AS revision,
              ${quoted(field(binding.transaction, 'inventory_transaction_number').physicalName)} AS number,
              ${quoted(field(binding.transaction, 'inventory_transaction_state').physicalName)} AS state,
              ${quoted(field(binding.transaction, 'inventory_transaction_type').physicalName)} AS type,
              ${quoted(field(binding.transaction, 'inventory_transaction_source_type').physicalName)} AS "sourceType",
              ${quoted(field(binding.transaction, 'inventory_transaction_source_id').physicalName)} AS "sourceId",
              ${quoted(field(binding.transaction, 'inventory_transaction_reason_code').physicalName)} AS "reasonCode",
              ${quoted(field(binding.transaction, 'inventory_transaction_reason_narrative').physicalName)} AS "reasonNarrative"
         FROM ${table(binding, binding.transaction)}
        WHERE tenant_id=$1 AND environment_id=$2 AND archived_at IS NULL
        ORDER BY ${quoted(binding.transaction.recordIdColumn)}`,
      scope,
    );
    const transactionLines = await client.query<Record<string, unknown>>(
      `SELECT ${quoted(binding.transactionLine.recordIdColumn)}::text AS "recordId",
              ${quoted(binding.transactionLine.revisionColumn)}::integer AS revision,
              ${quoted(relationColumn(binding, binding.transactionLine, binding.transaction))}::text AS "transactionId",
              ${quoted(field(binding.transactionLine, 'inventory_transaction_line_item_id').physicalName)}::text AS "itemId",
              ${quoted(field(binding.transactionLine, 'inventory_transaction_line_quantity').physicalName)}::text AS quantity,
              ${quoted(field(binding.transactionLine, 'inventory_transaction_line_unit_id').physicalName)} AS "unitId",
              ${quoted(field(binding.transactionLine, 'inventory_transaction_line_from_location_id').physicalName)}::text AS "fromLocationId",
              ${quoted(field(binding.transactionLine, 'inventory_transaction_line_to_location_id').physicalName)}::text AS "toLocationId"
         FROM ${table(binding, binding.transactionLine)}
        WHERE tenant_id=$1 AND environment_id=$2 AND archived_at IS NULL
        ORDER BY ${quoted(binding.transactionLine.recordIdColumn)}`,
      scope,
    );
    const movements = await client.query<Record<string, unknown>>(
      `SELECT ${quoted(relationColumn(binding, binding.movement, binding.transaction))}::text AS "transactionId",
              ${quoted(relationColumn(binding, binding.movement, binding.transactionLine))}::text AS "transactionLineId"
         FROM ${table(binding, binding.movement)}
        WHERE tenant_id=$1 AND environment_id=$2`,
      scope,
    );
    return {
      lines: lines.rows as CompanionState['lines'],
      movements: movements.rows as CompanionState['movements'],
      sessions: sessions.rows as CompanionState['sessions'],
      transactionLines:
        transactionLines.rows as CompanionState['transactionLines'],
      transactions: transactions.rows as CompanionState['transactions'],
    };
  });
}

function countCommand(input: {
  countedQuantity: string;
  expectedQuantity: string;
  kind: 'correction' | 'initial' | 'reversal';
  reversalOfMovementId?: string;
  sequence: number;
  supersedesStockCountId: string | null;
  varianceQuantity: string;
}): InventoryStockCountPostingCommandV2 {
  const suffix = String(input.sequence).padStart(2, '0');
  const stockCountId = `61000000-0000-4000-8000-0000000000${suffix}`;
  return {
    authorization: {
      decision: 'ALLOW',
      evaluatorVersion: 'stock-count-policy/v1',
      policyVersion: 'stock-count-policy/v1',
    },
    channel: 'API',
    effectiveAt,
    idempotencyKey: `62000000-0000-4000-8000-0000000000${suffix}`,
    kind: input.kind,
    legalEntityId,
    lines: [
      {
        countedQuantity: input.countedQuantity,
        expectedQuantity: input.expectedQuantity,
        itemId,
        reversalOfMovementId: input.reversalOfMovementId ?? null,
        sourceLine: String(input.sequence),
        stockCountLineId: `63000000-0000-4000-8000-0000000000${suffix}`,
        unitId: 'EA',
        varianceQuantity: input.varianceQuantity,
      },
    ],
    locationId,
    reason: { code: 'PHYSICAL_COUNT', narrative: 'Reviewed physical count' },
    sourceId: stockCountId,
    sourceRevision: 1,
    sourceType: 'stockCount',
    stockCountId,
    stockDimensionSetVersion: 'v1',
    supersedesStockCountId: input.supersedesStockCountId,
  };
}

// PUR-2a. The companion identities the kernel must derive, recomputed here by
// the test from the SOURCE ids alone. This is deliberately an independent
// recomputation through the exported reconciliation entry point rather than a
// value read back out of the command, so a kernel that mints a companion id
// some other way fails here.
function expectedCompanionTransactionId(stockCountId: string): string {
  return deriveInventoryPostingCompanionId({
    capabilityId: INVENTORY_POSTING_CAPABILITY_ID,
    companionFamilyId: 'northstar.app:entity.inventory_transaction',
    familyId: 'stock_count',
    sourceRecordId: stockCountId,
  });
}

function expectedCompanionTransactionLineId(stockCountLineId: string): string {
  return deriveInventoryPostingCompanionId({
    capabilityId: INVENTORY_POSTING_CAPABILITY_ID,
    companionFamilyId: 'northstar.app:entity.inventory_transaction_line',
    familyId: 'stock_count',
    sourceRecordId: stockCountLineId,
  });
}

function assertThreeValues(
  evidence: Awaited<
    ReturnType<PostgresInventoryPostingService['postStockCount']>
  >['stockCountEvidence'],
  expected: string,
  counted: string,
  variance: string,
): void {
  assert.ok(evidence);
  assert.equal(evidence.lines.length, 1);
  assert.equal(
    evidence.lines[0]?.expectedQuantity,
    expected,
    'deleting the expectedQuantity persistence/read-back line must fail here',
  );
  assert.equal(
    evidence.lines[0]?.countedQuantity,
    counted,
    'deleting the countedQuantity persistence/read-back line must fail here',
  );
  assert.equal(
    evidence.lines[0]?.varianceQuantity,
    variance,
    'deleting the varianceQuantity persistence/read-back line must fail here',
  );
}

type StockCountActor = Awaited<
  ReturnType<InstanceType<typeof TrustedActorEnvelopeIssuer>['issue']>
>;

async function assertRejectedStockCountCommands(input: {
  actor: StockCountActor;
  adminPool: Pool;
  binding: StorageBinding;
  context: TrustedRequestContext;
  runtimePool: Pool;
  service: PostgresInventoryPostingService;
}): Promise<void> {
  const { actor, adminPool, binding, context, runtimePool, service } = input;

  const inconsistentVariance = countCommand({
    countedQuantity: '5',
    expectedQuantity: '0',
    kind: 'initial',
    sequence: 4,
    supersedesStockCountId: null,
    varianceQuantity: '4',
  });
  await seedReviewedCount(runtimePool, context, binding, inconsistentVariance);
  await assertCountPostingRejected(
    () => service.postStockCount(context, actor, inconsistentVariance),
    'INVENTORY_POSTING_INPUT_INVALID',
    /varianceQuantity must equal counted minus expected/u,
    'deleting the counted-minus-expected comparison must make this command post',
  );

  // STOCK-COUNTS. Every count below that posts, or must reach a refusal the
  // expected check precedes, expects what the ledger holds at its instant:
  // the chain above left 5 on hand.
  const firstPrior = countCommand({
    countedQuantity: '6',
    expectedQuantity: '5',
    kind: 'initial',
    sequence: 5,
    supersedesStockCountId: null,
    varianceQuantity: '1',
  });
  const secondPrior = countCommand({
    countedQuantity: '7',
    expectedQuantity: '6',
    kind: 'initial',
    sequence: 6,
    supersedesStockCountId: null,
    varianceQuantity: '1',
  });
  for (const prior of [firstPrior, secondPrior]) {
    await seedReviewedCount(runtimePool, context, binding, prior);
    await service.postStockCount(context, actor, prior);
  }
  const persistedSupersedes = countCommand({
    countedQuantity: '8',
    expectedQuantity: '7',
    kind: 'correction',
    sequence: 7,
    supersedesStockCountId: firstPrior.stockCountId,
    varianceQuantity: '1',
  });
  await seedReviewedCount(runtimePool, context, binding, persistedSupersedes);
  await assertCountPostingRejected(
    () =>
      service.postStockCount(context, actor, {
        ...persistedSupersedes,
        supersedesStockCountId: secondPrior.stockCountId,
      }),
    'INVENTORY_COUNT_EVIDENCE_CONFLICT',
    /does not exactly match the reviewed evidence/u,
    'deleting the persisted supersedes comparison must move this command past evidence validation',
  );

  const reviewedPrior = countCommand({
    countedQuantity: '8',
    expectedQuantity: '7',
    kind: 'initial',
    sequence: 8,
    supersedesStockCountId: null,
    varianceQuantity: '1',
  });
  await seedReviewedCount(runtimePool, context, binding, reviewedPrior);
  const correctionOfUnposted = countCommand({
    countedQuantity: '8',
    expectedQuantity: '7',
    kind: 'correction',
    sequence: 9,
    supersedesStockCountId: reviewedPrior.stockCountId,
    varianceQuantity: '1',
  });
  await seedReviewedCount(runtimePool, context, binding, correctionOfUnposted);
  await assertCountPostingRejected(
    () => service.postStockCount(context, actor, correctionOfUnposted),
    'INVENTORY_COUNT_COMPENSATION_CONFLICT',
    /must supersede one posted count at the same location/u,
    'deleting the posted-prior state comparison must make this correction post',
  );

  const inversePrior = countCommand({
    countedQuantity: '10',
    expectedQuantity: '7',
    kind: 'initial',
    sequence: 10,
    supersedesStockCountId: null,
    varianceQuantity: '3',
  });
  await seedReviewedCount(runtimePool, context, binding, inversePrior);
  await service.postStockCount(context, actor, inversePrior);
  const inverseCorrection = countCommand({
    countedQuantity: '12',
    expectedQuantity: '10',
    kind: 'correction',
    sequence: 11,
    supersedesStockCountId: inversePrior.stockCountId,
    varianceQuantity: '2',
  });
  await seedReviewedCount(runtimePool, context, binding, inverseCorrection);
  const inverseCorrectionResult = await service.postStockCount(
    context,
    actor,
    inverseCorrection,
  );
  const inexactReversal = countCommand({
    countedQuantity: '11',
    expectedQuantity: '12',
    kind: 'reversal',
    reversalOfMovementId: inverseCorrectionResult.movements[0]!.movementId,
    sequence: 12,
    supersedesStockCountId: inverseCorrection.stockCountId,
    varianceQuantity: '-1',
  });
  await seedReviewedCount(runtimePool, context, binding, inexactReversal);
  await assertCountPostingRejected(
    () => service.postStockCount(context, actor, inexactReversal),
    'INVENTORY_COUNT_COMPENSATION_CONFLICT',
    /is not the exact inverse of its superseded movement/u,
    'deleting the exact-inverse comparison must make this reversal post',
  );

  const missingNarrative = {
    ...countCommand({
      countedQuantity: '13',
      expectedQuantity: '12',
      kind: 'initial',
      sequence: 13,
      supersedesStockCountId: null,
      varianceQuantity: '1',
    }),
    reason: { code: 'PHYSICAL_COUNT', narrative: null },
  };
  await seedReviewedCount(runtimePool, context, binding, missingNarrative);
  await assertCountPostingRejected(
    () => service.postStockCount(context, actor, missingNarrative),
    'INVENTORY_COUNT_REASON_REQUIRED',
    /count requires codeAndNarrative/u,
    'deleting the stock-count reason arm must make this reasonless count post',
  );

  const configured = await adminPool.query(
    `UPDATE platform.inventory_posting_configurations
        SET count_approval_threshold = 10,
            correction_approval_threshold = 1,
            revision = revision + 1
      WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3`,
    [tenantId, environmentId, legalEntityId],
  );
  assert.equal(configured.rowCount, 1);
  const belowCountThreshold = countCommand({
    countedQuantity: '17',
    expectedQuantity: '12',
    kind: 'initial',
    sequence: 14,
    supersedesStockCountId: null,
    varianceQuantity: '5',
  });
  await seedReviewedCount(runtimePool, context, binding, belowCountThreshold);
  assert.equal(
    (await service.postStockCount(context, actor, belowCountThreshold))
      .replayed,
    false,
    'the count role must read its distinct threshold of 10, not correction threshold 1',
  );
  const negativeCorrectionAboveThreshold = countCommand({
    countedQuantity: '15',
    expectedQuantity: '17',
    kind: 'correction',
    sequence: 15,
    supersedesStockCountId: belowCountThreshold.stockCountId,
    varianceQuantity: '-2',
  });
  await seedReviewedCount(
    runtimePool,
    context,
    binding,
    negativeCorrectionAboveThreshold,
  );
  await assertCountPostingRejected(
    () =>
      service.postStockCount(context, actor, negativeCorrectionAboveThreshold),
    'INVENTORY_COUNT_APPROVAL_REQUIRED',
    /correction exceeds approval threshold 1/u,
    'deleting absolute variance or reading the count threshold for correction must make this unapproved correction post',
  );
}

async function assertCountPostingRejected(
  action: () => Promise<unknown>,
  expectedCode: InventoryPostingErrorCode,
  expectedMessage: RegExp,
  victim: string,
): Promise<void> {
  // The victim is passed as the third argument as well as inside the
  // validator, because the validator never runs when the action does not
  // reject at all -- and "the posting succeeded where it must refuse" is
  // exactly the shape a control that REMOVES a refusal has to produce.
  await assert.rejects(
    action,
    (error: unknown) => {
      assert.ok(error instanceof InventoryPostingError, victim);
      assert.equal(error.code, expectedCode, victim);
      assert.match(error.message, expectedMessage, victim);
      return true;
    },
    victim,
  );
}

function tracingPool(pool: Pool, trace: TraceEntry[]): Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'connect') {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(clientTarget, clientProperty, clientReceiver) {
            if (clientProperty !== 'query') {
              const value = Reflect.get(
                clientTarget,
                clientProperty,
                clientReceiver,
              ) as unknown;
              return typeof value === 'function'
                ? value.bind(clientTarget)
                : value;
            }
            return (...arguments_: unknown[]) => {
              const query = arguments_[0];
              const values = Array.isArray(arguments_[1])
                ? (arguments_[1] as readonly unknown[])
                : [];
              trace.push({
                text:
                  typeof query === 'string'
                    ? query
                    : String((query as { text?: unknown }).text ?? ''),
                values,
              });
              return Reflect.apply(
                clientTarget.query,
                clientTarget,
                arguments_,
              );
            };
          },
        });
      };
    },
  });
}

function assertProtocolTrace(
  trace: readonly TraceEntry[],
  binding: StorageBinding,
): void {
  const begin = trace.findIndex((entry) => entry.text === 'BEGIN');
  const timeout = trace.findIndex((entry) =>
    entry.text.includes("set_config('lock_timeout', $1::text, true)"),
  );
  const advisories = trace
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.text.includes('pg_advisory_xact_lock'));
  const firstBusinessRead = trace.findIndex((entry) =>
    entry.text.includes(table(binding, binding.stockCount)),
  );
  const savepoints = trace.filter((entry) =>
    entry.text.startsWith('SAVEPOINT inventory_posting_write'),
  );
  assert.ok(begin >= 0);
  assert.ok(timeout > begin);
  assert.equal(trace[timeout]?.values[0], '15000ms');
  assert.equal(advisories.length >= 2, true);
  assert.ok(advisories[0]!.index > timeout);
  assert.ok(advisories[1]!.index > advisories[0]!.index);
  assert.ok(firstBusinessRead > advisories[1]!.index);
  assert.equal(
    savepoints.length,
    1,
    'forking stock-count posting or adding a second savepoint must fail here',
  );
}

function monetaryMembers(value: unknown): string[] {
  const money = /(?:amount|money|monetary|valuation|cost|price|currency)/iu;
  const found: string[] = [];
  const inspect = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(inspect);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (money.test(key)) found.push(key);
      if (
        key === 'fieldId' &&
        typeof nested === 'string' &&
        money.test(nested)
      ) {
        found.push(nested);
      }
      inspect(nested);
    }
  };
  inspect(value);
  return found.toSorted();
}

/** One count's state and how many movements name it as their source. */
async function readCountOutcome(
  pool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
  command: InventoryStockCountPostingCommandV2,
): Promise<{ movements: number; state: string }> {
  return withModuleRole(pool, context, async (client) => {
    const count = await client.query<{ state: string }>(
      `SELECT ${quoted(field(binding.stockCount, 'stock_count_state').physicalName)} AS state
         FROM ${table(binding, binding.stockCount)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(binding.stockCount.recordIdColumn)}=$3`,
      [tenantId, environmentId, command.stockCountId],
    );
    const movements = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM ${table(binding, binding.movement)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(field(binding.movement, 'inventory_movement_source_id').physicalName)}=$3`,
      [tenantId, environmentId, command.stockCountId],
    );
    assert.equal(count.rowCount, 1);
    return {
      movements: movements.rows[0]!.count,
      state: String(count.rows[0]!.state).split('_').at(-1)!,
    };
  });
}

async function readPersistedCountChain(
  pool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
): Promise<{
  lines: Array<Record<string, unknown>>;
  movements: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
}> {
  return withModuleRole(pool, context, async (client) => {
    const sessions = await client.query<Record<string, unknown>>(
      `SELECT * FROM ${table(binding, binding.stockCount)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(binding.stockCount.legalEntityColumn!)}=$3
          AND archived_at IS NULL
        ORDER BY ${quoted(binding.stockCount.recordIdColumn)}`,
      [tenantId, environmentId, legalEntityId],
    );
    const lines = await client.query<Record<string, unknown>>(
      `SELECT ${quoted(field(binding.stockCountLine, 'stock_count_line_expected_quantity').physicalName)} AS expected,
              ${quoted(field(binding.stockCountLine, 'stock_count_line_counted_quantity').physicalName)} AS counted,
              ${quoted(field(binding.stockCountLine, 'stock_count_line_variance_quantity').physicalName)} AS variance
         FROM ${table(binding, binding.stockCountLine)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(binding.stockCountLine.legalEntityColumn!)}=$3
          AND archived_at IS NULL
        ORDER BY ${quoted(field(binding.stockCountLine, 'stock_count_line_line_number').physicalName)}`,
      [tenantId, environmentId, legalEntityId],
    );
    const movements = await client.query<Record<string, unknown>>(
      `SELECT ${quoted(field(binding.movement, 'inventory_movement_reversal_of_movement_id').physicalName)} AS reversal
         FROM ${table(binding, binding.movement)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(binding.movement.legalEntityColumn!)}=$3
        ORDER BY ${quoted(field(binding.movement, 'inventory_movement_source_line').physicalName)}`,
      [tenantId, environmentId, legalEntityId],
    );
    return {
      lines: lines.rows,
      movements: movements.rows,
      sessions: sessions.rows,
    };
  });
}

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
  const [loaded, applicationBuilder]: unknown[] = await Promise.all([
    import('../../packages/domain/src/inventory/definition.js'),
    import('../../packages/domain/src/app/builder.js'),
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
  // As the product mounts it: with stock documents (INVENTORY-PARITY).
  const inventory = (
    loaded.inventoryModuleDefinition as (
      namespace: string,
      options: { readonly documentEntry: boolean },
    ) => unknown
  )(String(applicationBuilder.APPLICATION_NAMESPACE), { documentEntry: true });
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
  assert.ok(isRecord(inventory.modules[0]));
  assert.ok(isRecord(definition.package));
  const inventoryModuleId = inventory.modules[0].moduleId;
  assert.equal(
    definition.modules.filter(
      (candidate) =>
        isRecord(candidate) && candidate.moduleId === inventoryModuleId,
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

async function migrateAndProvision(
  pool: Pool,
  contractReleaseRoot: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await runMigrations(client, await loadMigrations(migrations));
    await client.query(
      'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
      [tenantId, 'inventory-stock-count'],
    );
    await client.query(
      `INSERT INTO platform.environments (tenant_id, id, slug)
       VALUES ($1,$2,'production')`,
      [tenantId, environmentId],
    );
    await client.query(
      `SELECT platform.provision_inventory_scope(
         $1,$2,$3,'LE-COUNT','Count legal entity','UTC','00:00:00',$4,
         1::smallint,'reject',0,'codeAndNarrative','codeOnly',
         'codeAndNarrative','codeAndNarrative','codeAndNarrative',
         NULL,NULL,NULL,NULL,NULL
       )`,
      [tenantId, environmentId, legalEntityId, contractReleaseRoot],
    );
  } finally {
    client.release();
  }
}

async function trustedContext(): Promise<TrustedRequestContext> {
  const identity: AuthenticatedIdentity = {
    environmentId,
    principalId,
    tenantId,
  };
  return new AuthenticatedRequestEntryAdapter(async () => identity).enter({
    headers: { authorization: 'inventory-stock-count' },
  });
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

async function seedFoundation(
  pool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
): Promise<void> {
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
          legal_entity_code: 'LE-COUNT',
          legal_entity_is_default: false,
          legal_entity_name: 'Count legal entity',
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
    await insertEntity(
      client,
      binding,
      binding.item,
      {
        item_base_unit: 'EA',
        item_code: 'ITEM-COUNT-UNIQUE',
        item_name: 'Physical count item',
      },
      itemId,
      null,
      {},
    );
    await insertEntity(
      client,
      binding,
      binding.location,
      {
        location_code: 'LOC-COUNT-UNIQUE',
        location_name: 'Physical count location',
      },
      locationId,
      null,
      {},
    );
  });
}

async function seedReviewedCount(
  pool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
  command: InventoryStockCountPostingCommandV2,
): Promise<void> {
  // PUR-2a ACCEPTANCE CONTROL. Nothing here stages an inventory transaction or
  // its lines. A reviewed stock count is created with NO companion at all; the
  // posting kernel derives and writes both companion identities. Reinstating a
  // pre-staged transaction here is the shape three design passes assumed and
  // it is exactly what this fixture must not do.
  await withModuleRole(pool, context, async (client) => {
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
        stock_count_number: `COUNT-SESSION-${command.lines[0]!.sourceLine}`,
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
        },
      );
    }
  });
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
      revisionColumn: entity.optimisticRevision.column,
      tableName: entity.physicalTableName,
    };
  };
  return {
    item: bind('item'),
    legalEntity: bind('legal_entity'),
    location: bind('location'),
    movement: bind('inventory_movement'),
    postedStockBalance: bind('posted_stock_balance'),
    schemaName: target.providerAbi.managedSchema,
    stockCount: bind('stock_count'),
    stockCountLine: bind('stock_count_line'),
    storageTarget: target,
    transaction: bind('inventory_transaction'),
    transactionLine: bind('inventory_transaction_line'),
  };
}

async function readPostedStockQuantity(
  pool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
): Promise<string | null> {
  return withModuleRole(pool, context, async (client) => {
    const result = await client.query<{ quantity: string }>(
      `SELECT ${quoted(field(binding.postedStockBalance, 'posted_stock_balance_posted_quantity').physicalName)}::text AS quantity
         FROM ${table(binding, binding.postedStockBalance)}
        WHERE tenant_id = $1 AND environment_id = $2
          AND ${quoted(binding.postedStockBalance.legalEntityColumn!)} = $3
          AND ${quoted(field(binding.postedStockBalance, 'posted_stock_balance_item_id').physicalName)} = $4
          AND ${quoted(field(binding.postedStockBalance, 'posted_stock_balance_location_id').physicalName)} = $5`,
      [
        context.tenantId,
        context.environmentId,
        legalEntityId,
        itemId,
        locationId,
      ],
    );
    assert.ok(result.rowCount === 0 || result.rowCount === 1);
    return result.rows[0]?.quantity ?? null;
  });
}

async function readPostedStockRecordId(
  pool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
): Promise<string> {
  return withModuleRole(pool, context, async (client) => {
    const result = await client.query<{ recordId: string }>(
      `SELECT ${quoted(binding.postedStockBalance.recordIdColumn)}::text AS "recordId"
         FROM ${table(binding, binding.postedStockBalance)}
        WHERE tenant_id = $1 AND environment_id = $2
          AND ${quoted(binding.postedStockBalance.legalEntityColumn!)} = $3
          AND ${quoted(field(binding.postedStockBalance, 'posted_stock_balance_item_id').physicalName)} = $4
          AND ${quoted(field(binding.postedStockBalance, 'posted_stock_balance_location_id').physicalName)} = $5`,
      [
        context.tenantId,
        context.environmentId,
        legalEntityId,
        itemId,
        locationId,
      ],
    );
    assert.equal(result.rowCount, 1);
    return result.rows[0]!.recordId;
  });
}

async function disablePostedStockTrigger(
  pool: Pool,
  binding: StorageBinding,
): Promise<void> {
  const suffix = /^nsm_t_([a-z2-7]{52})$/u.exec(
    binding.postedStockBalance.tableName,
  )?.[1];
  assert.ok(suffix);
  await pool.query(
    `ALTER TABLE ${table(binding, binding.movement)}
       DISABLE TRIGGER ${quoted(`nsm_z_${suffix}`)}`,
  );
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
      return '2026-07-30';
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

function normalizeDatabaseDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed === '-0' ? '0' : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
