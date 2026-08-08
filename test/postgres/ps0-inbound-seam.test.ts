/**
 * PS-0 PROBE ONLY — NOT FOR MERGE.
 *
 * The thin inbound vertical. One released-purchase-order-shaped aggregate posts
 * one receipt-shaped effect, appends one positive movement, advances the open
 * quantity atomically, and is corrected by a compensating effect — all through
 * the real `PostgresInventoryPostingService` against real PostgreSQL.
 *
 * What it is here to settle is narrow: whether a *foreign* source document can
 * be locked and transitioned inside ADR-0026's single top-level transaction, and
 * whether the race that preflight-then-post-then-mark would admit is actually
 * closed by doing so. Every guard is switchable, so each control is recorded red
 * for its own reason rather than asserted.
 *
 * It is not purchasing. There is no purchase-order entity, no module, no mount,
 * no UI, and no compiled release change.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { inventoryPostingFamilyCatalogPayload } from '../../packages/domain/src/inventory/posting-families.js';
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import {
  INVENTORY_POSTING_CAPABILITY_VERSION,
  PURCHASING_RECEIPT_POSTING_CAPABILITY_ID,
  PostgresInventoryPostingService,
  derivedIdentity,
  type InventoryAdjustmentPostingCommandV1,
  type InventoryGoodsReceiptPostingCommandV1,
  type InventoryPostingRegistrationV1,
} from '../../packages/postgres-provider/src/inventory-posting-service.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { PostgresModuleStorageMaterializer } from '../../packages/postgres-provider/src/module-storage-materializer.js';
import {
  PS0_ALL_GUARDS,
  Ps0GoodsReceiptSourceAggregate,
  Ps0SourceAggregateError,
  type Ps0Guards,
  type Ps0ReceiptPlan,
} from '../../packages/postgres-provider/src/ps0-goods-receipt-source-aggregate.js';
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
const tenantId = '12000000-0000-4000-8000-0000000000a1';
const environmentId = '23000000-0000-4000-8000-0000000000a2';
const legalEntityId = '34000000-0000-4000-8000-0000000000a3';
const principalId = '78000000-0000-4000-8000-0000000000a7';
const itemId = '45000000-0000-4000-8000-0000000000a4';
const locationId = '56000000-0000-4000-8000-0000000000a5';
const secondLocationId = '56000000-0000-4000-8000-0000000000a6';
const purchaseOrderId = '61000000-0000-4000-8000-0000000000b1';
const purchaseOrderLineId = '61000000-0000-4000-8000-0000000000b2';
const recordedAt = '2026-08-08T13:00:00.000Z';
const effectiveAt = '2026-08-08T12:00:00.000Z';

type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];

interface EntityBinding {
  entity: StorageEntityTarget;
  fields: ReadonlyMap<string, StorageEntityTarget['columns'][number]>;
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
  schemaName: string;
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

interface ReceiptFixture {
  companionTransactionId: string;
  companionTransactionLineId: string;
  goodsReceiptId: string;
  goodsReceiptLineId: string;
  idempotencyKey: string;
  locationId: string;
  quantity: string;
  sequence: number;
  supersedes: string | null;
  /** null records ADR-0017's declared absence rather than an unknown zero. */
  unitCost: string | null;
}

interface TraceEntry {
  text: string;
}

test('PS-0: an inbound receipt posts, advances open quantity, and compensates inside one transaction', async () => {
  const fixture = await compiledFixture();
  const binding = storageBinding(fixture.storage);
  await withEphemeralPostgres('ps0-inbound-seam', async (database) => {
    await migrateAndProvision(database.pool, fixture.inventory.releaseRoot);
    const runtimePool = new pg.Pool({
      ...database.connection,
      application_name: 'ps0-inbound-seam',
      max: 6,
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
      await seedFoundation(runtimePool, context, binding);
      await createProbeTables(database.pool);
      await seedReleasedPurchaseOrder(database.pool, '10');

      const registration: InventoryPostingRegistrationV1 = {
        capabilityId: INVENTORY_CONTRACT_V1.capabilityId,
        capabilityVersion: INVENTORY_POSTING_CAPABILITY_VERSION,
        dependencySetRoot: DECLARED_DEPENDENCY_ROOT,
        postingFamilyCatalog: inventoryPostingFamilyCatalogPayload(),
        postingFamilyCatalogContentHash:
          '0'.repeat(64),
        releaseContentHash: fixture.inventory.releaseRoot,
        releaseId: releases[1]!,
        storageTarget: fixture.storage,
        storageTargetContentHash: fixture.storageContentHash,
      };
      const actor = await new TrustedActorEnvelopeIssuer({
        resolve: async () => ({
          approvingHumanId: null,
          delegation: null,
          executionPrincipal: { kind: 'HUMAN', principalId },
          initiatingHumanId: principalId,
          subject: null,
        }),
      }).issue(context);
      const trace: TraceEntry[] = [];
      const post = async (
        receipt: ReceiptFixture,
        guards: Ps0Guards = PS0_ALL_GUARDS,
      ): Promise<unknown> => {
        await seedReceiptAndCompanion(
          database.pool,
          runtimePool,
          context,
          binding,
          receipt,
        );
        const service = new PostgresInventoryPostingService(
          tracingPool(runtimePool, trace),
          registration,
          { currentInstant: () => recordedAt },
          randomUUID,
          new Ps0GoodsReceiptSourceAggregate(receiptPlan(receipt), guards),
        );
        return await service.postAdjustment(
          context,
          actor,
          adjustmentCommand(receipt),
        );
      };

      // ---- 1. The vertical: receive 4 of 10 ------------------------------
      const first = receiptFixture({ quantity: '4', sequence: 1 });
      const posted = await post(first);
      assert.equal(movementsOf(posted).length, 1);
      assert.equal(movementsOf(posted)[0]?.quantityDelta, '4');
      assert.equal(movementsOf(posted)[0]?.sourceType, 'goodsReceipt');
      assert.equal(movementsOf(posted)[0]?.sourceId, first.goodsReceiptId);
      assert.deepEqual(await readPurchaseOrderLine(database.pool), {
        ordered: '10',
        received: '4',
      });
      assert.equal(await readReceiptState(database.pool, first), 'posted');
      assert.equal(await onHand(database.pool, binding, locationId), '4');
      assertLockOrder(trace.splice(0));

      // ---- 2. The compensating effect ------------------------------------
      const compensating = receiptFixture({
        quantity: '-4',
        sequence: 2,
        supersedes: first.goodsReceiptId,
      });
      const corrected = await post(compensating);
      assert.equal(movementsOf(corrected)[0]?.quantityDelta, '-4');
      assert.deepEqual(await readPurchaseOrderLine(database.pool), {
        ordered: '10',
        received: '0',
      });
      // The corrected receipt is never mutated; the compensation appends.
      assert.equal(await readReceiptState(database.pool, first), 'posted');
      assert.equal(await onHand(database.pool, binding, locationId), '0');
      trace.splice(0);

      // ---- 3. Control: over-receipt refuses -------------------------------
      const over = receiptFixture({ quantity: '11', sequence: 3 });
      await assert.rejects(
        post(over),
        (error: unknown) => {
          assert.ok(
            error instanceof Ps0SourceAggregateError,
            `expected a source-aggregate refusal, got ${String(error)}`,
          );
          assert.equal(error.code, 'PS0_RECEIPT_OPEN_QUANTITY_EXCEEDED');
          return true;
        },
        'removing the open-quantity check must make this succeed',
      );
      assert.equal((await readPurchaseOrderLine(database.pool)).received, '0');
      trace.splice(0);

      // ---- 4. Control: ADR-0017's cost-or-declared-absence gate -----------
      const uncosted = receiptFixture({ quantity: '1', sequence: 4 });
      await seedReceiptAndCompanion(
        database.pool,
        runtimePool,
        context,
        binding,
        uncosted,
      );
      await database.pool.query(
        `UPDATE north_star_module.ps0_goods_receipt_line
            SET unit_cost=NULL, currency=NULL, cost_absence=NULL
          WHERE goods_receipt_line_id=$1`,
        [uncosted.goodsReceiptLineId],
      );
      await assert.rejects(
        new PostgresInventoryPostingService(
          runtimePool,
          registration,
          { currentInstant: () => recordedAt },
          randomUUID,
          new Ps0GoodsReceiptSourceAggregate(receiptPlan(uncosted)),
        ).postAdjustment(context, actor, adjustmentCommand(uncosted)),
        (error: unknown) =>
          error instanceof Ps0SourceAggregateError &&
          error.code === 'PS0_RECEIPT_COST_EVIDENCE_MISSING',
        "ADR-0017's G4 gate must refuse a receipt line with neither cost nor declared absence",
      );

      // ---- 5. Control: stale expected revision refuses --------------------
      const stale = receiptFixture({ quantity: '1', sequence: 5 });
      await seedReceiptAndCompanion(
        database.pool,
        runtimePool,
        context,
        binding,
        stale,
      );
      await database.pool.query(
        `UPDATE north_star_module.ps0_goods_receipt
            SET revision=revision+1 WHERE goods_receipt_id=$1`,
        [stale.goodsReceiptId],
      );
      await assert.rejects(
        new PostgresInventoryPostingService(
          runtimePool,
          registration,
          { currentInstant: () => recordedAt },
          randomUUID,
          new Ps0GoodsReceiptSourceAggregate(receiptPlan(stale)),
        ).postAdjustment(context, actor, adjustmentCommand(stale)),
        (error: unknown) =>
          error instanceof Ps0SourceAggregateError &&
          error.code === 'PS0_RECEIPT_STATE_CONFLICT',
      );

      // ---- 6. Control: a failure after the movements rolls everything back -
      const before = await movementCount(database.pool, binding);
      const poisoned = receiptFixture({ quantity: '2', sequence: 6 });
      await assert.rejects(
        post(poisoned, { ...PS0_ALL_GUARDS, failAfterMovements: true }),
        (error: unknown) => error instanceof Ps0SourceAggregateError,
      );
      assert.equal(
        await movementCount(database.pool, binding),
        before,
        'a purchasing-side failure must leave no movement behind',
      );
      assert.equal((await readPurchaseOrderLine(database.pool)).received, '0');
      assert.equal(await readReceiptState(database.pool, poisoned), 'draft');
      trace.splice(0);

      // ---- 7. The central race, both directions --------------------------
      // Two receipts for the full open quantity at *different* locations, so
      // they take different stock identities and the stock serializer does not
      // serialize them. Only the purchasing-side lock can.
      // Four arms, so the ruling names the mechanism that actually closes the
      // race rather than the pair that happened to be on together.
      const arms: Array<
        [string, Ps0Guards, { received: string; succeeded: number }]
      > = [
        [
          'lock + compare-and-swap',
          PS0_ALL_GUARDS,
          { received: '10', succeeded: 1 },
        ],
        [
          'pessimistic lock only',
          { ...PS0_ALL_GUARDS, compareAndSwapReceived: false },
          { received: '10', succeeded: 1 },
        ],
        [
          'compare-and-swap only',
          { ...PS0_ALL_GUARDS, lockPurchaseOrder: false },
          { received: '10', succeeded: 1 },
        ],
        [
          'neither — the recorded red',
          {
            compareAndSwapReceived: false,
            failAfterMovements: false,
            lockPurchaseOrder: false,
          },
          { received: '20', succeeded: 2 },
        ],
      ];
      for (const [name, guards, expected] of arms) {
        await resetReceived(database.pool);
        const observed = await raceTwoReceipts(post, database.pool, guards);
        assert.deepEqual(observed, expected, `race arm: ${name}`);
        raceResults.push(`${name} -> ${JSON.stringify(observed)}`);
      }
      console.log(`PS-0 race arms:\n  ${raceResults.join('\n  ')}`);
      await resetReceived(database.pool);
      trace.splice(0);

      // ==== PS-2 =========================================================
      // Everything above is PS-0's vertical. Below is what the compiled
      // posting-family profile adds, and every claim here is an assertion
      // rather than a description.

      // ---- 8. Two profiles, two registrations, one kernel ----------------
      const purchasingRegistration: InventoryPostingRegistrationV1 = {
        ...registration,
        capabilityId: PURCHASING_RECEIPT_POSTING_CAPABILITY_ID,
      };

      // The compiled price of the receipt family: exactly two enum options.
      assert.deepEqual(probeEnumAdditions, [
        'northstar.app:option.inventory_transaction_type_goods_receipt',
        'northstar.app:option.inventory_movement_posting_role_receipt',
      ]);

      // ---- 9. A receipt posts as a RECEIPT, not as an adjustment ---------
      const receipt = receiptFixture({ quantity: '4', sequence: 8 });
      // No companion is staged. PS-0 staged one from the test, which is how its
      // ruling could name a companion without naming a writer.
      await seedReceiptRowsOnly(database.pool, receipt);
      assert.equal(
        await readCompanion(
          moduleRuntimePool,
          binding,
          derivedIdentity(
            'northstar.inventory-companion-transaction/v1',
            legalEntityId,
            'goodsReceipt',
            receipt.goodsReceiptId,
          ),
        ),
        undefined,
        'no companion exists before posting',
      );
      const receiptResult = await new PostgresInventoryPostingService(
        tracingPool(runtimePool, trace),
        purchasingRegistration,
        { currentInstant: () => recordedAt },
        randomUUID,
        new Ps0GoodsReceiptSourceAggregate(receiptPlan(receipt)),
      ).postGoodsReceipt(context, actor, goodsReceiptCommand(receipt));

      assert.equal(movementsOf(receiptResult).length, 1);
      assert.equal(movementsOf(receiptResult)[0]?.quantityDelta, '4');
      assert.equal(
        (receiptResult as { capabilityId: string }).capabilityId,
        PURCHASING_RECEIPT_POSTING_CAPABILITY_ID,
      );

      // The pair PS-1 recreated while claiming to forbid it. Read the columns
      // and assert them; PS-1's test read the type column and never asserted.
      const companionId = derivedIdentity(
        'northstar.inventory-companion-transaction/v1',
        legalEntityId,
        'goodsReceipt',
        receipt.goodsReceiptId,
      );
      const companion = await readCompanion(
        moduleRuntimePool,
        binding,
        companionId,
      );
      assert.ok(companion, 'the kernel wrote the companion');
      assert.match(
        String(companion.type),
        /inventory_transaction_type_goods_receipt$/u,
        'the companion must carry the goodsReceipt type, not adjustment',
      );
      assert.equal(companion.sourceType, 'goodsReceipt');
      assert.equal(companion.sourceId, receipt.goodsReceiptId);
      assert.match(
        String(await movementPostingRoleOf(moduleRuntimePool, binding, receipt)),
        /inventory_movement_posting_role_receipt$/u,
        'the movement must post under the receipt role, not adjustment',
      );
      assert.equal((await readPurchaseOrderLine(database.pool)).received, '4');
      assertLockOrder(trace.splice(0));

      // ---- 10. Admission: capability ownership of a profile ---------------
      await assert.rejects(
        new PostgresInventoryPostingService(
          runtimePool,
          registration,
          { currentInstant: () => recordedAt },
          randomUUID,
          new Ps0GoodsReceiptSourceAggregate(
            receiptPlan(receiptFixture({ quantity: '1', sequence: 9 })),
          ),
        ).postGoodsReceipt(
          context,
          actor,
          goodsReceiptCommand(receiptFixture({ quantity: '1', sequence: 10 })),
        ),
        (error: unknown) =>
          isRecord(error) &&
          error.code === 'INVENTORY_POSTING_COMMAND_FAMILY_NOT_ADMITTED',
        'Inventory owns the kernel but does not own the goodsReceipt profile',
      );

      // ---- 11. The reachability gate, over the COMPILED catalog -----------
      // Parameterized over the profiles, not over hard-coded labels, and it
      // carries both halves: companions unreachable, authored documents still
      // reachable. Deleting every generic path fails the positive half.
      const gate = await reachabilityOverCatalog(
        moduleRuntimePool,
        binding,
        fixture.inventory,
      );
      console.log(
        `PS-2 reachability gate:\n  ${gate.lines.join('\n  ')}`,
      );
      assert.ok(
        gate.authoredPathCount > 0,
        'the positive half: adjustments must remain generically authorable and readable',
      );
      companionReachability.push(...gate.companionOpenPaths);

      // ---- 12. A correction, with a governed predecessor chain -----------
      // The compensating receipt names its predecessor, mints its OWN companion
      // because it is a different source document, and leaves the corrected
      // receipt untouched. Reusing the predecessor's companion would mean
      // appending a line to a posted transaction whose line-set digest has
      // already been compare-and-swapped.
      const correction = receiptFixture({
        quantity: '-4',
        sequence: 12,
        supersedes: receipt.goodsReceiptId,
      });
      await seedReceiptRowsOnly(database.pool, correction);
      await new PostgresInventoryPostingService(
        runtimePool,
        purchasingRegistration,
        { currentInstant: () => recordedAt },
        randomUUID,
        new Ps0GoodsReceiptSourceAggregate(receiptPlan(correction)),
      ).postGoodsReceipt(context, actor, goodsReceiptCommand(correction));

      const correctionCompanionId = derivedIdentity(
        'northstar.inventory-companion-transaction/v1',
        legalEntityId,
        'goodsReceipt',
        correction.goodsReceiptId,
      );
      assert.notEqual(correctionCompanionId, companionId);
      const correctionCompanion = await readCompanion(
        moduleRuntimePool,
        binding,
        correctionCompanionId,
      );
      assert.ok(correctionCompanion, 'the correction minted its own companion');
      assert.match(
        String(correctionCompanion.type),
        /inventory_transaction_type_goods_receipt$/u,
      );
      assert.equal(
        await readPredecessor(database.pool, correction),
        receipt.goodsReceiptId,
        'the chain names its predecessor',
      );
      assert.equal((await readPurchaseOrderLine(database.pool)).received, '0');
      assert.equal(
        await readReceiptState(database.pool, receipt),
        'posted',
        'the corrected receipt is never mutated',
      );
      // The predecessor's companion is still exactly the row the first posting
      // left: same type, same provenance, same posted state. A correction that
      // reused it would have had to append a line to it.
      const predecessorAfter = await readCompanion(
        moduleRuntimePool,
        binding,
        companionId,
      );
      assert.deepEqual(predecessorAfter, companion);
      assert.equal(
        await companionLineCount(moduleRuntimePool, binding, companionId),
        1,
        'the corrected companion gained no line',
      );
    } finally {
      await Promise.all([
        runtimePool.end(),
        materializerPool.end(),
        moduleRuntimePool.end(),
      ]);
    }
  });
});

const raceResults: string[] = [];
const companionReachability: string[] = [];
let probeEnumAdditions: readonly string[] = [];

/** PS-2. The receipt's own source command — no transactionId, no sourceType. */
function goodsReceiptCommand(
  receipt: ReceiptFixture,
): InventoryGoodsReceiptPostingCommandV1 {
  return {
    authorization: {
      decision: 'ALLOW',
      evaluatorVersion: 'ps2-probe',
      policyVersion: 'ps2-probe',
    },
    channel: 'API',
    effectiveAt,
    goodsReceiptId: receipt.goodsReceiptId,
    idempotencyKey: receipt.idempotencyKey,
    legalEntityId,
    lines: [
      {
        goodsReceiptLineId: receipt.goodsReceiptLineId,
        itemId,
        locationId: receipt.locationId,
        quantity: receipt.quantity,
        sourceLine: String(receipt.sequence),
        unitId: 'EA',
      },
    ],
    purchaseOrderId,
    reason: { code: 'RECEIPT', narrative: 'PS-2 receipt family' },
    // The receipt's revision. The companion's is kernel-minted and has no slot.
    sourceExpectedRevision: 1,
    stockDimensionSetVersion: 'v1',
    supersedesGoodsReceiptId: receipt.supersedes,
  };
}

/** PS-2. Seeds the receipt aggregate only; the kernel writes the companion. */
async function seedReceiptRowsOnly(
  pool: Pool,
  receipt: ReceiptFixture,
): Promise<void> {
  await pool.query(
    `INSERT INTO north_star_module.ps0_goods_receipt
       (tenant_id, environment_id, legal_entity_id, goods_receipt_id,
        purchase_order_id, supersedes_goods_receipt_id, state)
     VALUES ($1,$2,$3,$4,$5,$6,'draft')
     ON CONFLICT DO NOTHING`,
    [
      tenantId,
      environmentId,
      legalEntityId,
      receipt.goodsReceiptId,
      purchaseOrderId,
      receipt.supersedes,
    ],
  );
  await pool.query(
    `INSERT INTO north_star_module.ps0_goods_receipt_line
       (tenant_id, environment_id, legal_entity_id, goods_receipt_line_id,
        goods_receipt_id, purchase_order_line_id, quantity,
        unit_cost, currency, cost_absence)
     VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9,$10)
     ON CONFLICT DO NOTHING`,
    [
      tenantId,
      environmentId,
      legalEntityId,
      receipt.goodsReceiptLineId,
      receipt.goodsReceiptId,
      purchaseOrderLineId,
      receipt.quantity,
      receipt.unitCost,
      receipt.unitCost === null ? null : 'CAD',
      receipt.unitCost === null ? 'unknownAtPosting' : null,
    ],
  );
}

/** PS-2. Lines hanging off one companion, so a reuse would be visible. */
async function companionLineCount(
  pool: Pool,
  binding: StorageBinding,
  transactionId: string,
): Promise<number> {
  const rows = await pool.query(
    `SELECT 1 FROM ${table(binding, binding.transactionLine)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${quoted(binding.transactionLine.entity.columns.find((column) => column.physicalName.includes('transaction') && column.physicalName.endsWith('_id'))?.physicalName ?? 'inventory_transaction_id')}=$3`,
    [tenantId, environmentId, transactionId],
  );
  return rows.rowCount ?? 0;
}

/** PS-2. The governed predecessor edge on the source document. */
async function readPredecessor(
  pool: Pool,
  receipt: ReceiptFixture,
): Promise<string | null> {
  const rows = await pool.query<{ supersedes: string | null }>(
    `SELECT supersedes_goods_receipt_id AS supersedes
       FROM north_star_module.ps0_goods_receipt
      WHERE goods_receipt_id=$1`,
    [receipt.goodsReceiptId],
  );
  return rows.rows[0]?.supersedes ?? null;
}

async function readCompanion(
  pool: Pool,
  binding: StorageBinding,
  transactionId: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await pool.query<Record<string, unknown>>(
    `SELECT ${quoted(localColumn(binding.transaction, 'inventory_transaction_type'))} AS "type",
            ${quoted(localColumn(binding.transaction, 'inventory_transaction_source_type'))} AS "sourceType",
            ${quoted(localColumn(binding.transaction, 'inventory_transaction_source_id'))} AS "sourceId",
            ${quoted(localColumn(binding.transaction, 'inventory_transaction_state'))} AS "state"
       FROM ${table(binding, binding.transaction)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${quoted(binding.transaction.recordIdColumn)}=$3`,
    [tenantId, environmentId, transactionId],
  );
  return rows.rows[0];
}

async function movementPostingRoleOf(
  pool: Pool,
  binding: StorageBinding,
  receipt: ReceiptFixture,
): Promise<string | undefined> {
  const rows = await pool.query<{ role: string }>(
    `SELECT ${quoted(localColumn(binding.movement, 'inventory_movement_posting_role'))} AS role
       FROM ${table(binding, binding.movement)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${quoted(localColumn(binding.movement, 'inventory_movement_source_id'))}=$3`,
    [tenantId, environmentId, receipt.goodsReceiptId],
  );
  return rows.rows[0]?.role;
}

/**
 * PS-2. The reachability gate, parameterized over the compiled operation and
 * query catalog rather than over a hard-coded list of path names.
 *
 * Both halves are reported. The negative half is every generic path that can
 * reach a companion-origin transaction. The positive half is every generic path
 * that must keep reaching an authored one — without it, deleting all generic
 * transaction paths would satisfy the rule while removing ordinary adjustment
 * authoring, which is the failure mode a labels-only gate cannot see.
 */
async function reachabilityOverCatalog(
  pool: Pool,
  binding: StorageBinding,
  compiled: CompileSuccess,
): Promise<{
  authoredPathCount: number;
  companionOpenPaths: string[];
  lines: string[];
}> {
  const catalog = projectionPayload<{
    operations?: { operationId: string }[];
    queries?: { queryId: string }[];
  }>(compiled, PROJECTION_FAMILY_IDS.operationCatalog).payload;
  const transactionEntities = ['inventory_transaction', 'inventory_transaction_line'];
  const genericPaths = [
    ...(catalog.operations ?? []).map((entry) => entry.operationId),
    ...(catalog.queries ?? []).map((entry) => entry.queryId),
  ].filter((id) =>
    transactionEntities.some(
      (entity) =>
        id.includes(`.${entity}_`) &&
        !id.endsWith('_post'),
    ),
  );

  const originOf = async (kind: 'companion' | 'authored'): Promise<number> => {
    const rows = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM ${table(binding, binding.transaction)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(localColumn(binding.transaction, 'inventory_transaction_source_type'))}
              ${kind === 'companion' ? 'IN' : 'NOT IN'} ('goodsReceipt','stockCount')
          AND ${quoted(binding.transaction.entity.archive?.archivedAtColumn ?? 'archived_at')} IS NULL`,
      [tenantId, environmentId],
    );
    return Number(rows.rows[0]?.total ?? '0');
  };

  const companions = await originOf('companion');
  const authored = await originOf('authored');
  const lines = [
    `compiled generic paths over the transaction pair: ${String(genericPaths.length)}`,
    `companion-origin rows visible to them: ${String(companions)}`,
    `authored-origin rows visible to them: ${String(authored)}`,
  ];
  return {
    authoredPathCount: authored > 0 ? genericPaths.length : 0,
    // Every generic path reaches the same unfiltered relation, so a visible
    // companion row is reachable through all of them. `get` by id bypasses any
    // list filter by construction.
    companionOpenPaths: companions > 0 ? genericPaths.toSorted() : [],
    lines,
  };
}

async function raceTwoReceipts(
  post: (receipt: ReceiptFixture, guards?: Ps0Guards) => Promise<unknown>,
  pool: Pool,
  guards: Ps0Guards,
): Promise<{ received: string; succeeded: number }> {
  const left = receiptFixture({ quantity: '10', sequence: 90 });
  const right = receiptFixture({
    location: secondLocationId,
    quantity: '10',
    sequence: 91,
  });
  const outcomes = await Promise.allSettled([
    post(left, guards),
    post(right, guards),
  ]);
  return {
    received: (await readPurchaseOrderLine(pool)).received,
    succeeded: outcomes.filter((outcome) => outcome.status === 'fulfilled')
      .length,
  };
}

/**
 * ADR-0026's step 2 must survive the extension: every stock identity is locked
 * before the first purchasing read, not after it.
 */
function assertLockOrder(trace: readonly TraceEntry[]): void {
  const begin = trace.findIndex((entry) => entry.text === 'BEGIN');
  const advisory = trace.findIndex((entry) =>
    entry.text.includes('pg_advisory_xact_lock'),
  );
  const firstPurchasingRead = trace.findIndex((entry) =>
    entry.text.includes('ps0_purchase_order'),
  );
  const savepoints = trace.filter((entry) =>
    entry.text.startsWith('SAVEPOINT inventory_posting_write'),
  );
  assert.ok(begin >= 0);
  assert.ok(advisory > begin);
  assert.ok(
    firstPurchasingRead > advisory,
    'a purchasing read before the stock lock has no authority',
  );
  assert.equal(
    savepoints.length,
    1,
    'carrying a foreign aggregate must not add a second savepoint',
  );
}

let receiptCounter = 0;

function receiptFixture(input: {
  location?: string;
  quantity: string;
  sequence: number;
  supersedes?: string | null;
}): ReceiptFixture {
  receiptCounter += 1;
  const suffix = String(receiptCounter).padStart(4, '0');
  return {
    companionTransactionId: `71000000-0000-4000-8000-00000000${suffix}`,
    companionTransactionLineId: `72000000-0000-4000-8000-00000000${suffix}`,
    goodsReceiptId: `73000000-0000-4000-8000-00000000${suffix}`,
    goodsReceiptLineId: `74000000-0000-4000-8000-00000000${suffix}`,
    idempotencyKey: `75000000-0000-4000-8000-00000000${suffix}`,
    locationId: input.location ?? locationId,
    quantity: input.quantity,
    sequence: input.sequence,
    supersedes: input.supersedes ?? null,
    unitCost: input.quantity.startsWith('-') ? null : '12.50',
  };
}

function receiptPlan(receipt: ReceiptFixture): Ps0ReceiptPlan {
  return {
    expectedReceiptRevision: 1,
    goodsReceiptId: receipt.goodsReceiptId,
    lines: [{ purchaseOrderLineId, quantity: receipt.quantity }],
    purchaseOrderId,
  };
}

function adjustmentCommand(
  receipt: ReceiptFixture,
): InventoryAdjustmentPostingCommandV1 {
  return {
    authorization: {
      decision: 'ALLOW',
      evaluatorVersion: 'ps0-probe',
      policyVersion: 'ps0-probe',
    },
    channel: 'API',
    effectiveAt,
    idempotencyKey: receipt.idempotencyKey,
    legalEntityId,
    lines: [
      {
        itemId,
        locationId: receipt.locationId,
        quantityDelta: receipt.quantity,
        sourceLine: String(receipt.sequence),
        transactionLineId: receipt.companionTransactionLineId,
        unitId: 'EA',
      },
    ],
    reason: { code: 'RECEIPT', narrative: 'PS-0 inbound probe' },
    // The movement's lineage names the receipt, while its required relations
    // still bind the companion transaction. Ruling 3, in the data.
    sourceId: receipt.goodsReceiptId,
    sourceRevision: 1,
    sourceType: 'goodsReceipt',
    stockDimensionSetVersion: 'v1',
    transactionId: receipt.companionTransactionId,
  };
}

function movementsOf(result: unknown): readonly {
  quantityDelta: string;
  sourceId: string;
  sourceType: string;
}[] {
  assert.ok(isRecord(result) && Array.isArray(result.movements));
  return result.movements as readonly {
    quantityDelta: string;
    sourceId: string;
    sourceType: string;
  }[];
}

async function createProbeTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE north_star_module.ps0_purchase_order (
      tenant_id uuid NOT NULL,
      environment_id uuid NOT NULL,
      legal_entity_id uuid NOT NULL,
      purchase_order_id uuid PRIMARY KEY,
      state text NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      archived_at timestamptz
    );
    CREATE TABLE north_star_module.ps0_purchase_order_line (
      tenant_id uuid NOT NULL,
      environment_id uuid NOT NULL,
      legal_entity_id uuid NOT NULL,
      purchase_order_line_id uuid PRIMARY KEY,
      purchase_order_id uuid NOT NULL,
      item_id uuid NOT NULL,
      unit_id text NOT NULL,
      ordered_quantity numeric(38,18) NOT NULL,
      received_quantity numeric(38,18) NOT NULL DEFAULT 0,
      revision integer NOT NULL DEFAULT 1,
      archived_at timestamptz
    );
    CREATE TABLE north_star_module.ps0_goods_receipt (
      tenant_id uuid NOT NULL,
      environment_id uuid NOT NULL,
      legal_entity_id uuid NOT NULL,
      goods_receipt_id uuid PRIMARY KEY,
      purchase_order_id uuid NOT NULL,
      supersedes_goods_receipt_id uuid,
      state text NOT NULL,
      recorded_at timestamptz,
      revision integer NOT NULL DEFAULT 1,
      archived_at timestamptz
    );
    CREATE TABLE north_star_module.ps0_goods_receipt_line (
      tenant_id uuid NOT NULL,
      environment_id uuid NOT NULL,
      legal_entity_id uuid NOT NULL,
      goods_receipt_line_id uuid PRIMARY KEY,
      goods_receipt_id uuid NOT NULL,
      purchase_order_line_id uuid NOT NULL,
      quantity numeric(38,18) NOT NULL,
      unit_cost numeric(38,18),
      currency text,
      cost_absence text,
      archived_at timestamptz
    );
    GRANT SELECT, INSERT, UPDATE
       ON north_star_module.ps0_purchase_order,
          north_star_module.ps0_purchase_order_line,
          north_star_module.ps0_goods_receipt,
          north_star_module.ps0_goods_receipt_line
       TO north_star_module_runtime;
  `);
}

async function seedReleasedPurchaseOrder(
  pool: Pool,
  ordered: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO north_star_module.ps0_purchase_order
       (tenant_id, environment_id, legal_entity_id, purchase_order_id, state)
     VALUES ($1,$2,$3,$4,'released')`,
    [tenantId, environmentId, legalEntityId, purchaseOrderId],
  );
  await pool.query(
    `INSERT INTO north_star_module.ps0_purchase_order_line
       (tenant_id, environment_id, legal_entity_id, purchase_order_line_id,
        purchase_order_id, item_id, unit_id, ordered_quantity)
     VALUES ($1,$2,$3,$4,$5,$6,'EA',$7::numeric)`,
    [
      tenantId,
      environmentId,
      legalEntityId,
      purchaseOrderLineId,
      purchaseOrderId,
      itemId,
      ordered,
    ],
  );
}

async function resetReceived(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE north_star_module.ps0_purchase_order_line
        SET received_quantity=0 WHERE purchase_order_line_id=$1`,
    [purchaseOrderLineId],
  );
}

async function seedReceiptAndCompanion(
  pool: Pool,
  runtimePool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
  receipt: ReceiptFixture,
): Promise<void> {
  const existing = await pool.query(
    'SELECT 1 FROM north_star_module.ps0_goods_receipt WHERE goods_receipt_id=$1',
    [receipt.goodsReceiptId],
  );
  if (existing.rowCount !== 0) return;
  await pool.query(
    `INSERT INTO north_star_module.ps0_goods_receipt
       (tenant_id, environment_id, legal_entity_id, goods_receipt_id,
        purchase_order_id, supersedes_goods_receipt_id, state)
     VALUES ($1,$2,$3,$4,$5,$6,'draft')`,
    [
      tenantId,
      environmentId,
      legalEntityId,
      receipt.goodsReceiptId,
      purchaseOrderId,
      receipt.supersedes,
    ],
  );
  await pool.query(
    `INSERT INTO north_star_module.ps0_goods_receipt_line
       (tenant_id, environment_id, legal_entity_id, goods_receipt_line_id,
        goods_receipt_id, purchase_order_line_id, quantity,
        unit_cost, currency, cost_absence)
     VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9,$10)`,
    [
      tenantId,
      environmentId,
      legalEntityId,
      receipt.goodsReceiptLineId,
      receipt.goodsReceiptId,
      purchaseOrderLineId,
      receipt.quantity,
      receipt.unitCost,
      receipt.unitCost === null ? null : 'CAD',
      receipt.unitCost === null ? 'unknownAtPosting' : null,
    ],
  );
  await seedCompanionTransaction(runtimePool, context, binding, receipt);
}

/**
 * `inventory_movement`'s relations to `inventory_transaction` and its line are
 * both required, so a receipt posting must supply a companion transaction. This
 * is PS-0 ruling 3 executing, not a convenience.
 */
async function seedCompanionTransaction(
  runtimePool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
  receipt: ReceiptFixture,
): Promise<void> {
  const negative = receipt.quantity.startsWith('-');
  await withModuleRole(runtimePool, context, async (client) => {
    await insertEntity(
      client,
      binding,
      binding.transaction,
      {
        inventory_transaction_actor_id: principalId,
        inventory_transaction_effective_at: effectiveAt,
        inventory_transaction_number: `PS0-RCPT-${String(receipt.sequence)}-${receipt.goodsReceiptId.slice(-4)}`,
        inventory_transaction_reason_code: 'RECEIPT',
        inventory_transaction_reason_narrative: 'PS-0 inbound probe',
        inventory_transaction_recorded_at: recordedAt,
        inventory_transaction_source_id: receipt.goodsReceiptId,
        inventory_transaction_source_type: 'goodsReceipt',
        inventory_transaction_state: enumOption(
          field(binding.transaction, 'inventory_transaction_state'),
          'draft',
        ),
        inventory_transaction_type: enumOption(
          field(binding.transaction, 'inventory_transaction_type'),
          'adjustment',
        ),
      },
      receipt.companionTransactionId,
      legalEntityId,
      {},
    );
    await insertEntity(
      client,
      binding,
      binding.transactionLine,
      {
        inventory_transaction_line_from_location_id: negative
          ? receipt.locationId
          : null,
        inventory_transaction_line_item_id: itemId,
        inventory_transaction_line_line_number: receipt.sequence,
        inventory_transaction_line_quantity: receipt.quantity,
        inventory_transaction_line_to_location_id: negative
          ? null
          : receipt.locationId,
        inventory_transaction_line_unit_id: 'EA',
      },
      receipt.companionTransactionLineId,
      legalEntityId,
      { [binding.transaction.entity.entityId]: receipt.companionTransactionId },
    );
  });
}

async function readPurchaseOrderLine(
  pool: Pool,
): Promise<{ ordered: string; received: string }> {
  const result = await pool.query<{ ordered: string; received: string }>(
    `SELECT ordered_quantity::text AS ordered, received_quantity::text AS received
       FROM north_star_module.ps0_purchase_order_line
      WHERE purchase_order_line_id=$1`,
    [purchaseOrderLineId],
  );
  return {
    ordered: normalizeDatabaseDecimal(result.rows[0]!.ordered),
    received: normalizeDatabaseDecimal(result.rows[0]!.received),
  };
}

async function readReceiptState(
  pool: Pool,
  receipt: ReceiptFixture,
): Promise<string> {
  const result = await pool.query<{ state: string }>(
    'SELECT state FROM north_star_module.ps0_goods_receipt WHERE goods_receipt_id=$1',
    [receipt.goodsReceiptId],
  );
  return result.rows[0]!.state;
}

async function movementCount(
  pool: Pool,
  binding: StorageBinding,
): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM ${table(binding, binding.movement)}`,
  );
  return Number(result.rows[0]!.total);
}

async function onHand(
  pool: Pool,
  binding: StorageBinding,
  location: string,
): Promise<string> {
  const result = await pool.query<{ total: string | null }>(
    `SELECT sum(${quoted(field(binding.movement, 'inventory_movement_quantity_delta').physicalName)})::text AS total
       FROM ${table(binding, binding.movement)}
      WHERE ${quoted(field(binding.movement, 'inventory_movement_location_id').physicalName)}=$1`,
    [location],
  );
  return normalizeDatabaseDecimal(result.rows[0]?.total ?? '0');
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
              trace.push({
                text:
                  typeof query === 'string'
                    ? query
                    : String((query as { text?: unknown }).text ?? ''),
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

// ---------------------------------------------------------------------------
// Scaffolding below is adapted from `inventory-stock-count.test.ts`.
// ---------------------------------------------------------------------------

let fixturePromise: Promise<Fixture> | undefined;

async function compiledFixture(): Promise<Fixture> {
  fixturePromise ??= buildFixture();
  return fixturePromise;
}

/**
 * PS-2. The compiled price of a receipt family, paid in the probe's own fixture
 * so the shipped release does not move.
 *
 * ADR-0049 §5 *estimated* a receipt posting role at eight code sites plus a
 * migration. This function is the measured part of that estimate: exactly two
 * compiled enum options. Everything else the role needs is now a profile
 * declaration rather than a code site, which is the difference the posting-family
 * concept makes. Each addition is returned so the vertical can assert the count
 * rather than the reader having to trust it.
 */
function extendProbeEnums(definition: Record<string, unknown>): readonly string[] {
  const added: string[] = [];
  const fields = definition.fields as Record<string, unknown>[];
  const add = (fieldSuffix: string, label: string, optionLocalId: string): void => {
    const field = fields.find(
      (candidate) => String(candidate.fieldId).endsWith(fieldSuffix),
    );
    assert.ok(field, `probe fixture lacks field ${fieldSuffix}`);
    const fieldType = field.fieldType as {
      options: Record<string, unknown>[];
    };
    const optionId = `northstar.app:option.${optionLocalId}`;
    assert.ok(
      !fieldType.options.some((option) => option.optionId === optionId),
      `${optionLocalId} already exists; the shipped release moved and this probe is stale`,
    );
    const highest = Math.max(
      ...fieldType.options.map((option) => Number(option.orderKey)),
    );
    fieldType.options = [
      ...fieldType.options,
      {
        kind: 'enumOption',
        label,
        optionId,
        orderKey: highest + 10,
        schemaVersion: 'v4',
      },
    ];
    added.push(optionId);
  };
  add(
    ':field.inventory_transaction_type',
    'goodsReceipt',
    'inventory_transaction_type_goods_receipt',
  );
  add(
    ':field.inventory_movement_posting_role',
    'receipt',
    'inventory_movement_posting_role_receipt',
  );
  return Object.freeze(added);
}

async function buildFixture(): Promise<Fixture> {
  const inventoryDefinition = await loadInventoryDefinition();
  probeEnumAdditions = extendProbeEnums(inventoryDefinition);
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

async function migrateAndProvision(
  pool: Pool,
  contractReleaseRoot: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await runMigrations(client, await loadMigrations(migrations));
    await client.query(
      'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
      [tenantId, 'ps0-inbound-seam'],
    );
    await client.query(
      `INSERT INTO platform.environments (tenant_id, id, slug)
       VALUES ($1,$2,'production')`,
      [tenantId, environmentId],
    );
    await client.query(
      `SELECT platform.provision_inventory_scope(
         $1,$2,$3,'LE-PS0','PS-0 legal entity','UTC','00:00:00',$4,
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
    headers: { authorization: 'ps0-inbound-seam' },
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
          legal_entity_code: 'LE-PS0',
          legal_entity_is_default: false,
          legal_entity_name: 'PS-0 legal entity',
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
      { item_base_unit: 'EA', item_code: 'PS0-ITEM', item_name: 'Probe item' },
      itemId,
      null,
      {},
    );
    await insertEntity(
      client,
      binding,
      binding.location,
      { location_code: 'PS0-LOC-A', location_name: 'Probe dock A' },
      locationId,
      null,
      {},
    );
    await insertEntity(
      client,
      binding,
      binding.location,
      { location_code: 'PS0-LOC-B', location_name: 'Probe dock B' },
      secondLocationId,
      null,
      {},
    );
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
    schemaName: target.providerAbi.managedSchema,
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
      return '2026-08-08';
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

/** PS-2. Physical column for a canonical local field id. */
function localColumn(entity: EntityBinding, localId: string): string {
  const column = entity.fields.get(localId);
  assert.ok(column, `binding is missing ${localId}`);
  return column.physicalName;
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
