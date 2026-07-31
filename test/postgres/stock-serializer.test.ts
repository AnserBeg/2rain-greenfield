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
  compileApplication,
  expectedActiveReleaseFrom,
  PROJECTION_FAMILY_IDS,
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
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { PostgresModuleStorageMaterializer } from '../../packages/postgres-provider/src/module-storage-materializer.js';
import {
  PostgresReleaseVerificationService,
  releaseVerificationBinding,
} from '../../packages/postgres-provider/src/release-verification-service.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import {
  acquireStockIdentityLocks,
  planStockIdentityLocks,
  STOCK_IDENTITY_LOCK_NAMESPACE,
  type ScopedStockIdentityV1,
} from '../../packages/postgres-provider/src/stock-serializer.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const checkedInMigrations = resolve('db/migrations');
const applicationBuilderImport = '../../packages/domain/src/app/builder.js';
const inventoryModuleImport =
  '../../packages/domain/src/inventory/definition.js';
const tenantId = '11000000-0000-4000-8000-000000000001';
const environmentId = '22000000-0000-4000-8000-000000000002';
const legalEntityId = '33000000-0000-4000-8000-000000000003';
const itemId = '44000000-0000-4000-8000-000000000004';
const locationA = '55000000-0000-4000-8000-000000000005';
const locationB = '66000000-0000-4000-8000-000000000006';
const principalId = '77000000-0000-4000-8000-000000000007';

const stockA = stockIdentity(locationA);
const stockB = stockIdentity(locationB);

test('stock lock plan is canonical, total, stable, and duplicate-free', () => {
  const forward = planStockIdentityLocks([stockA, stockB, stockA]);
  const reverse = planStockIdentityLocks([stockB, stockA]);

  assert.deepEqual(forward, reverse);
  assert.equal(forward.length, 2);
  assert.equal(forward[0]!.identityKey < forward[1]!.identityKey, true);
  const periodOne = { ...stockA, businessPeriod: '2026-07-01' };
  const periodTwo = { ...stockA, businessPeriod: '2026-08-01' };
  assert.deepEqual(
    planStockIdentityLocks([periodOne]),
    planStockIdentityLocks([periodTwo]),
  );
  for (const target of forward) {
    assert.equal(Number.isInteger(target.identityKey), true);
    assert.equal(
      target.identityKey >= -2_147_483_648 &&
        target.identityKey <= 2_147_483_647,
      true,
    );
  }

  assert.throws(
    () =>
      planStockIdentityLocks([
        { ...stockA, locationId: 'AA000000-0000-4000-8000-000000000005' },
      ]),
    /locationId must be a canonical lowercase UUID/u,
  );
});

test(
  'same-stock posting checks visibly wait for the transaction-scoped lock',
  { timeout: 30_000 },
  async (context) => {
    await withSerializerDatabase(
      'stock-lock-wait',
      async ({ movement, pool }) => {
        const holder = await pool.connect();
        const waiter = await pool.connect();
        const observer = await pool.connect();
        try {
          const holderPid = await backendPid(holder);
          const waiterPid = await backendPid(waiter);
          const target = planStockIdentityLocks([stockA])[0];
          assert.ok(target);

          await holder.query('BEGIN');
          await waiter.query('BEGIN');
          await acquireStockIdentityLocks(holder, [stockA]);
          assert.equal(await movementBalance(holder, movement, stockA), '0');

          const waitingAcquire = acquireStockIdentityLocks(waiter, [stockA]);
          void waitingAcquire.catch(() => undefined);
          const blocked = await waitForAdvisoryLock(
            observer,
            waiterPid,
            target.identityKey,
            false,
          );
          assert.deepEqual(blocked, {
            granted: false,
            identityKey: unsignedInt32(target.identityKey),
            namespace: STOCK_IDENTITY_LOCK_NAMESPACE,
            pid: waiterPid,
          });
          assert.deepEqual(
            await advisoryLock(observer, holderPid, target.identityKey, true),
            {
              granted: true,
              identityKey: unsignedInt32(target.identityKey),
              namespace: STOCK_IDENTITY_LOCK_NAMESPACE,
              pid: holderPid,
            },
          );
          context.diagnostic(
            `executed wait red: ${JSON.stringify({ holderPid, waitingLock: blocked })}`,
          );

          await holder.query('COMMIT');
          await waitingAcquire;
          assert.equal(await movementBalance(waiter, movement, stockA), '0');
          assert.equal(
            (await advisoryLock(observer, waiterPid, target.identityKey, true))
              ?.granted,
            true,
          );
          await waiter.query('COMMIT');

          assert.equal(
            await advisoryLock(observer, waiterPid, target.identityKey, true),
            undefined,
          );
        } finally {
          await rollbackQuietly(holder);
          await rollbackQuietly(waiter);
          holder.release();
          waiter.release();
          observer.release();
        }
      },
    );
  },
);

test(
  'unordered opposite transfers deadlock, while the serializer total order does not',
  { timeout: 30_000 },
  async (context) => {
    await withSerializerDatabase(
      'stock-lock-order',
      async ({ movement, pool }) => {
        const left = await pool.connect();
        const right = await pool.connect();
        const observer = await pool.connect();
        try {
          const leftPid = await backendPid(left);
          const rightPid = await backendPid(right);
          const orderedTargets = planStockIdentityLocks([stockA, stockB]);
          const targetA = orderedTargets.find(
            ({ identity }) => identity.locationId === locationA,
          );
          const targetB = orderedTargets.find(
            ({ identity }) => identity.locationId === locationB,
          );
          const firstTarget = orderedTargets[0];
          assert.ok(targetA);
          assert.ok(targetB);
          assert.ok(firstTarget);
          assert.notEqual(targetA.identityKey, targetB.identityKey);

          // Executed red: transfer A->B and transfer B->A each take their input
          // order directly. Once each holds its first lock, the second pair is a
          // real PostgreSQL deadlock, not a source-text proxy.
          await left.query('BEGIN');
          await right.query('BEGIN');
          await left.query("SET LOCAL deadlock_timeout = '20ms'");
          await right.query("SET LOCAL deadlock_timeout = '20ms'");
          await rawStockLock(left, targetA.identityKey);
          await rawStockLock(right, targetB.identityKey);
          const unordered = await Promise.allSettled([
            rawStockLock(left, targetB.identityKey),
            rawStockLock(right, targetA.identityKey),
          ]);
          assert.equal(
            unordered.filter(
              (result) =>
                result.status === 'rejected' &&
                postgresCode(result.reason) === '40P01',
            ).length,
            1,
          );
          assert.equal(
            unordered.filter((result) => result.status === 'fulfilled').length,
            1,
          );
          context.diagnostic(
            `ordering removed: ${JSON.stringify(
              unordered.map((result) =>
                result.status === 'rejected'
                  ? { code: postgresCode(result.reason), status: result.status }
                  : { status: result.status },
              ),
            )}`,
          );
          await rollbackQuietly(left);
          await rollbackQuietly(right);

          // Restored control: opposite caller order produces the same lock plan.
          // One transaction waits on the common first key, then proceeds after
          // the winner commits; PostgreSQL never reports a deadlock.
          await left.query('BEGIN');
          await right.query('BEGIN');
          await left.query("SET LOCAL deadlock_timeout = '20ms'");
          await right.query("SET LOCAL deadlock_timeout = '20ms'");
          const leftAcquire = trackedAcquire(left, [stockA, stockB]);
          const rightAcquire = trackedAcquire(right, [stockB, stockA]);
          const first = await Promise.race([
            leftAcquire.settled.then((result) => ({
              side: 'left' as const,
              result,
            })),
            rightAcquire.settled.then((result) => ({
              side: 'right' as const,
              result,
            })),
          ]);
          assert.equal(first.result.status, 'fulfilled');
          const winner = first.side === 'left' ? left : right;
          const loser = first.side === 'left' ? right : left;
          const loserPid = first.side === 'left' ? rightPid : leftPid;
          const loserAcquire =
            first.side === 'left' ? rightAcquire : leftAcquire;
          await waitForAdvisoryLock(
            observer,
            loserPid,
            firstTarget.identityKey,
            false,
          );
          assert.equal(await movementBalance(winner, movement, stockA), '0');
          assert.equal(await movementBalance(winner, movement, stockB), '0');
          await winner.query('COMMIT');

          const second = await loserAcquire.settled;
          assert.equal(second.status, 'fulfilled');
          if (second.status === 'fulfilled') {
            assert.deepEqual(
              second.value.map(({ identityKey }) => identityKey),
              orderedTargets.map(({ identityKey }) => identityKey),
            );
          }
          assert.equal(await movementBalance(loser, movement, stockA), '0');
          assert.equal(await movementBalance(loser, movement, stockB), '0');
          await loser.query('COMMIT');
          context.diagnostic(
            `ordering restored: ${JSON.stringify({
              firstIdentityKey: firstTarget.identityKey,
              loserPid,
              statuses: [first.result.status, second.status],
            })}`,
          );
        } finally {
          await rollbackQuietly(left);
          await rollbackQuietly(right);
          left.release();
          right.release();
          observer.release();
        }
      },
    );
  },
);

test(
  'the reserved two-key lock is real, transaction-only, and disjoint from bigint locks',
  { timeout: 30_000 },
  async (context) => {
    await withSerializerDatabase('stock-lock-control', async ({ pool }) => {
      const stockClient = await pool.connect();
      const bigintClient = await pool.connect();
      const generationClient = await pool.connect();
      const observer = await pool.connect();
      try {
        await assert.rejects(
          acquireStockIdentityLocks(stockClient, [stockA]),
          (error: unknown) => postgresCode(error) === '25P01',
        );

        const stockPid = await backendPid(stockClient);
        const bigintPid = await backendPid(bigintClient);
        const generationPid = await backendPid(generationClient);
        const target = planStockIdentityLocks([stockA])[0];
        assert.ok(target);
        await stockClient.query('BEGIN');
        await acquireStockIdentityLocks(stockClient, [stockA]);
        await bigintClient.query('BEGIN');
        await bigintClient.query("SET LOCAL statement_timeout = '2s'");
        await bigintClient.query('SELECT pg_advisory_xact_lock($1::bigint)', [
          packedBigintKey(STOCK_IDENTITY_LOCK_NAMESPACE, target.identityKey),
        ]);

        const generationNamespaceResult = await generationClient.query<{
          namespace: number;
        }>(
          `SELECT hashtext(
             'north-star:module-storage-generation:v1'
           ) AS namespace`,
        );
        const generationNamespace =
          generationNamespaceResult.rows[0]?.namespace;
        assert.equal(generationNamespace, -1_322_922_032);
        assert.notEqual(generationNamespace, STOCK_IDENTITY_LOCK_NAMESPACE);
        await generationClient.query('BEGIN');
        await generationClient.query("SET LOCAL statement_timeout = '2s'");
        // Reproduce the accepted materializer's first two-key namespace while
        // deliberately sharing the stock lock's second key. Simultaneous grant
        // proves the reserved NSST first key keeps the families disjoint.
        await generationClient.query(
          `SELECT pg_advisory_xact_lock(
             hashtext('north-star:module-storage-generation:v1'),
             $1::integer
           )`,
          [target.identityKey],
        );

        const locks = await observer.query<{
          granted: boolean;
          objsubid: number;
          pid: number;
        }>(
          `SELECT pid, objsubid, granted
             FROM pg_locks
            WHERE locktype = 'advisory'
              AND pid = ANY($1::integer[])
              AND classid::bigint = $2::bigint
              AND objid::bigint = $3::bigint
            ORDER BY pid`,
          [
            [stockPid, bigintPid],
            STOCK_IDENTITY_LOCK_NAMESPACE,
            unsignedInt32(target.identityKey),
          ],
        );
        assert.deepEqual(
          locks.rows,
          [
            { granted: true, objsubid: 2, pid: stockPid },
            { granted: true, objsubid: 1, pid: bigintPid },
          ].sort((left, right) => left.pid - right.pid),
        );
        context.diagnostic(
          `genuine lock control: ${JSON.stringify(locks.rows)}`,
        );
        const generationLock = await advisoryLock(
          observer,
          generationPid,
          target.identityKey,
          true,
          generationNamespace,
        );
        assert.deepEqual(generationLock, {
          granted: true,
          identityKey: unsignedInt32(target.identityKey),
          namespace: generationNamespace,
          pid: generationPid,
        });
        context.diagnostic(
          `existing two-key namespace control: ${JSON.stringify(generationLock)}`,
        );

        await stockClient.query('COMMIT');
        assert.equal(
          await advisoryLock(observer, stockPid, target.identityKey, true),
          undefined,
        );
        await bigintClient.query('COMMIT');
        await generationClient.query('COMMIT');
        assert.equal(
          await advisoryLock(
            observer,
            generationPid,
            target.identityKey,
            true,
            generationNamespace,
          ),
          undefined,
        );

        // Executed contract red: a caller savepoint created before the
        // serializer would let ROLLBACK TO release its lock without ending the
        // outer transaction. G3-P3 must therefore acquire immediately after
        // BEGIN; the production helper documents that placement explicitly.
        await stockClient.query('BEGIN');
        const transactionIdBefore = await currentTransactionId(stockClient);
        await stockClient.query('SAVEPOINT caller_scope');
        await acquireStockIdentityLocks(stockClient, [stockA]);
        assert.equal(
          (await advisoryLock(observer, stockPid, target.identityKey, true))
            ?.granted,
          true,
        );
        await stockClient.query('ROLLBACK TO SAVEPOINT caller_scope');
        const transactionIdAfter = await currentTransactionId(stockClient);
        assert.equal(transactionIdAfter, transactionIdBefore);
        assert.equal(
          await advisoryLock(observer, stockPid, target.identityKey, true),
          undefined,
        );
        context.diagnostic(
          `caller savepoint red: ${JSON.stringify({
            lockAfterRollback: false,
            lockBeforeRollback: true,
            outerTransactionId: transactionIdAfter,
          })}`,
        );
        await stockClient.query('COMMIT');
      } finally {
        await rollbackQuietly(stockClient);
        await rollbackQuietly(bigintClient);
        await rollbackQuietly(generationClient);
        stockClient.release();
        bigintClient.release();
        generationClient.release();
        observer.release();
      }
    });
  },
);

function stockIdentity(locationId: string): ScopedStockIdentityV1 {
  return { environmentId, itemId, legalEntityId, locationId, tenantId };
}

interface MovementStorageBinding {
  environmentColumn: string;
  itemColumn: string;
  legalEntityColumn: string;
  locationColumn: string;
  quantityColumn: string;
  schemaName: string;
  tableName: string;
  tenantColumn: string;
}

type EmittedInventoryFactEntity = StorageTargetPayloadV1['entities'][number] & {
  factStorage?: {
    fieldColumns: {
      itemId: string;
      locationId: string;
    };
  };
};

interface SerializerDatabase {
  movement: MovementStorageBinding;
  pool: Pool;
}

interface CompiledInventoryFixture {
  empty: CompileSuccess;
  emptyDefinition: Record<string, unknown>;
  inventory: CompileSuccess;
  inventoryDefinition: Record<string, unknown>;
  movement: MovementStorageBinding;
}

let compiledInventoryFixturePromise:
  Promise<CompiledInventoryFixture> | undefined;

async function withSerializerDatabase(
  label: string,
  run: (database: SerializerDatabase) => Promise<void>,
): Promise<void> {
  const fixture = await compiledInventoryFixture();
  await withEphemeralPostgres(label, async (database) => {
    await migrateAndSeed(database.pool, fixture.inventory.releaseRoot);
    const runtimePool = new pg.Pool({
      ...database.connection,
      max: 2,
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
      const sourceReleaseId = releases[0];
      const targetReleaseId = releases[1];
      assert.ok(sourceReleaseId);
      assert.ok(targetReleaseId);
      await setPointer(database.pool, sourceReleaseId);
      await grantExecutorAuthority(database.pool);
      const materializer = new PostgresModuleStorageMaterializer(
        materializerPool,
        moduleRuntimePool,
      );
      const prepared = await materializer.prepare({
        context,
        expiresAt: '2099-01-01T00:00:00.000Z',
        generationId: randomUuid(),
        initiatedBy: principalId,
        preparationId: randomUuid(),
        targetReleaseId,
      });
      assert.equal(prepared.schemaState, 'APPLIED');
      await assertMovementRelation(database.pool, fixture.movement);
      await run({ movement: fixture.movement, pool: database.pool });
    } finally {
      await Promise.all([
        runtimePool.end(),
        materializerPool.end(),
        moduleRuntimePool.end(),
      ]);
    }
  });
}

async function movementBalance(
  client: PoolClient,
  movement: MovementStorageBinding,
  identity: ScopedStockIdentityV1,
): Promise<string> {
  const table = `${quoted(movement.schemaName)}.${quoted(movement.tableName)}`;
  const result = await client.query<{ balance: string }>(
    `SELECT COALESCE(sum(${quoted(movement.quantityColumn)}), 0)::text AS balance
       FROM ${table}
      WHERE ${quoted(movement.tenantColumn)} = $1::uuid
        AND ${quoted(movement.environmentColumn)} = $2::uuid
        AND ${quoted(movement.legalEntityColumn)} = $3::uuid
        AND ${quoted(movement.itemColumn)} = $4::uuid
        AND ${quoted(movement.locationColumn)} = $5::uuid`,
    [
      identity.tenantId,
      identity.environmentId,
      identity.legalEntityId,
      identity.itemId,
      identity.locationId,
    ],
  );
  return result.rows[0]?.balance ?? 'missing';
}

async function compiledInventoryFixture(): Promise<CompiledInventoryFixture> {
  compiledInventoryFixturePromise ??= buildCompiledInventoryFixture();
  return compiledInventoryFixturePromise;
}

async function buildCompiledInventoryFixture(): Promise<CompiledInventoryFixture> {
  const definition = await loadInventoryDefinition();
  const emptyDefinition = emptyDefinitionFrom(definition);
  const empty = mustCompile(moduleInput(emptyDefinition));
  const inventory = mustCompile(
    moduleInput(definition, expectedActiveReleaseFrom(empty)),
  );
  const storage = compiledProjectionPayload<StorageTargetPayloadV1>(
    inventory,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  return {
    empty,
    emptyDefinition,
    inventory,
    inventoryDefinition: definition,
    movement: resolveMovementStorage(storage),
  };
}

async function loadInventoryDefinition(): Promise<Record<string, unknown>> {
  const [loaded, applicationBuilder]: unknown[] = await Promise.all([
    import(inventoryModuleImport),
    import(applicationBuilderImport),
  ]);
  if (!isRecord(loaded)) {
    throw new TypeError('inventory definition module did not load');
  }
  if (!isRecord(applicationBuilder)) {
    throw new TypeError('application definition module did not load');
  }
  const factory = loaded.inventoryModuleDefinition;
  if (typeof factory !== 'function') {
    throw new TypeError('inventory definition factory is unavailable');
  }
  const applicationFactory = applicationBuilder.composedApplicationDefinition;
  const applicationNamespace = applicationBuilder.APPLICATION_NAMESPACE;
  if (
    typeof applicationFactory !== 'function' ||
    typeof applicationNamespace !== 'string'
  ) {
    throw new TypeError('composed application definition is unavailable');
  }
  const definition: unknown = Reflect.apply(applicationFactory, undefined, []);
  const inventory: unknown = Reflect.apply(factory, undefined, [
    applicationNamespace,
  ]);
  if (!isRecord(definition) || !isRecord(inventory)) {
    throw new TypeError('inventory definition factory returned a non-object');
  }
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
    const applicationMembers: unknown = definition[collection];
    const inventoryMembers: unknown = inventory[collection];
    if (
      !Array.isArray(applicationMembers) ||
      !Array.isArray(inventoryMembers)
    ) {
      throw new TypeError(`module collection ${collection} is unavailable`);
    }
    const composedEntries: readonly unknown[] =
      applicationMembers as readonly unknown[];
    const inventoryEntries: readonly unknown[] =
      inventoryMembers as readonly unknown[];
    for (const inventoryMember of inventoryEntries) {
      assert.equal(
        composedEntries.filter(
          (candidate) =>
            canonicalize(candidate) === canonicalize(inventoryMember),
        ).length,
        1,
        `composed application must contain each inventory ${collection} entry exactly once`,
      );
    }
  }
  const applicationModules = definition.modules;
  const inventoryModules = inventory.modules;
  const packageDefinition = definition.package;
  if (
    !Array.isArray(applicationModules) ||
    !Array.isArray(inventoryModules) ||
    !isRecord(inventoryModules[0]) ||
    !isRecord(packageDefinition) ||
    typeof packageDefinition.packageId !== 'string'
  ) {
    throw new TypeError('inventory module ownership is unavailable');
  }
  const inventoryModuleId = inventoryModules[0].moduleId;
  assert.equal(
    applicationModules.filter(
      (candidate) =>
        isRecord(candidate) && candidate.moduleId === inventoryModuleId,
    ).length,
    1,
    'composed application must contain the inventory module exactly once',
  );
  return definition;
}

function resolveMovementStorage(
  storage: StorageTargetPayloadV1,
): MovementStorageBinding {
  const factEntities = storage.entities
    .map((entity) => entity as EmittedInventoryFactEntity)
    .filter((entity) => entity.factStorage !== undefined);
  assert.equal(factEntities.length, 1, 'compiled target must have one fact');
  const movement = factEntities[0];
  const factStorage = movement?.factStorage;
  assert.ok(factStorage, 'compiled target has no inventory fact');
  assert.deepEqual(movement.scopeKeyColumns, ['tenant_id', 'environment_id']);
  assert.ok(
    movement.legalEntity,
    'compiled movement lacks its derived legal-entity column',
  );
  const fieldColumn = (fieldSuffix: string): string => {
    const columns = movement.columns.filter((candidate) =>
      candidate.canonicalFieldId.endsWith(fieldSuffix),
    );
    assert.equal(
      columns.length,
      1,
      `compiled movement lacks unique field ${fieldSuffix}`,
    );
    return columns[0]!.physicalName;
  };
  return {
    environmentColumn: movement.scopeKeyColumns[1],
    itemColumn: factStorage.fieldColumns.itemId,
    legalEntityColumn: movement.legalEntity.column,
    locationColumn: factStorage.fieldColumns.locationId,
    quantityColumn: fieldColumn(':field.inventory_movement_quantity_delta'),
    schemaName: storage.providerAbi.managedSchema,
    tableName: movement.physicalTableName,
    tenantColumn: movement.scopeKeyColumns[0],
  };
}

async function assertMovementRelation(
  pool: Pool,
  movement: MovementStorageBinding,
): Promise<void> {
  const qualifiedName = `${movement.schemaName}.${movement.tableName}`;
  const relation = await pool.query<{ kind: string }>(
    `SELECT relation.relkind AS kind
       FROM pg_class AS relation
      WHERE relation.oid = to_regclass($1)`,
    [qualifiedName],
  );
  assert.deepEqual(relation.rows, [{ kind: 'p' }]);
  const columns = await pool.query<{ name: string }>(
    `SELECT attribute.attname AS name
       FROM pg_attribute AS attribute
      WHERE attribute.attrelid = to_regclass($1)
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND attribute.attname = ANY($2::text[])
      ORDER BY attribute.attname`,
    [
      qualifiedName,
      [
        movement.tenantColumn,
        movement.environmentColumn,
        movement.legalEntityColumn,
        movement.itemColumn,
        movement.locationColumn,
        movement.quantityColumn,
      ],
    ],
  );
  assert.deepEqual(
    columns.rows.map(({ name }) => name),
    [
      movement.tenantColumn,
      movement.environmentColumn,
      movement.legalEntityColumn,
      movement.itemColumn,
      movement.locationColumn,
      movement.quantityColumn,
    ].sort(compareCodeUnits),
  );
}

async function migrateAndSeed(
  pool: Pool,
  contractReleaseRoot: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    const migrations = await loadMigrations(checkedInMigrations);
    const result = await runMigrations(client, migrations);
    assert.equal(result.applied.length, migrations.length);
    assert.equal(result.verified.length, migrations.length);
    await client.query(
      'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
      [tenantId, 'stock-serializer'],
    );
    await client.query(
      `INSERT INTO platform.environments (tenant_id, id, slug)
       VALUES ($1,$2,'production')`,
      [tenantId, environmentId],
    );
    await client.query(
      `SELECT platform.provision_inventory_scope(
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9::smallint, $10, $11, $12, $13, $14, $15, $16,
         $17, $18, $19, $20, $21
       )`,
      [
        tenantId,
        environmentId,
        legalEntityId,
        'SERIALIZER',
        'Serializer control legal entity',
        'UTC',
        '00:00:00',
        contractReleaseRoot,
        1,
        'reject',
        0,
        'codeAndNarrative',
        'codeOnly',
        'codeAndNarrative',
        'codeAndNarrative',
        'codeAndNarrative',
        null,
        null,
        null,
        null,
        null,
      ],
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
  const entry = new AuthenticatedRequestEntryAdapter(async () => identity);
  return entry.enter({ headers: { authorization: 'stock-serializer' } });
}

async function persistSequence(
  runtimePool: Pool,
  context: TrustedRequestContext,
  entries: ReadonlyArray<readonly [CompileSuccess, Record<string, unknown>]>,
): Promise<MintedUuid[]> {
  const repository = new PostgresImmutableReleaseRepository(runtimePool);
  const releases: MintedUuid[] = [];
  for (const [compiled, definition] of entries) {
    const revisionId = minted(randomUuid());
    const releaseId = minted(randomUuid());
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

async function setPointer(pool: Pool, releaseId: MintedUuid): Promise<void> {
  await pool.query(
    'ALTER TABLE platform.active_release_pointers DISABLE TRIGGER active_release_pointer_exact_swap',
  );
  try {
    const result = await pool.query(
      `UPDATE platform.active_release_pointers
          SET release_id = $3, fence = fence + 1
        WHERE tenant_id = $1 AND environment_id = $2`,
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
    [tenantId, principalId, randomUuid()],
  );
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

function compiledProjectionPayload<T>(
  compiled: CompileSuccess,
  familyId: string,
): T {
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
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}

function randomUuid(): string {
  return randomUUID();
}

function quoted(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(identifier)) {
    throw new TypeError(`unsafe emitted PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>(
    'SELECT pg_backend_pid() AS pid',
  );
  const pid = result.rows[0]?.pid;
  assert.ok(pid);
  return pid;
}

async function currentTransactionId(client: PoolClient): Promise<string> {
  const result = await client.query<{ transactionId: string }>(
    'SELECT txid_current()::text AS "transactionId"',
  );
  const transactionId = result.rows[0]?.transactionId;
  assert.ok(transactionId);
  return transactionId;
}

interface ObservedAdvisoryLock {
  granted: boolean;
  identityKey: number;
  namespace: number;
  pid: number;
}

async function advisoryLock(
  observer: PoolClient,
  pid: number,
  identityKey: number,
  granted: boolean,
  namespace: number = STOCK_IDENTITY_LOCK_NAMESPACE,
): Promise<ObservedAdvisoryLock | undefined> {
  const result = await observer.query<ObservedAdvisoryLock>(
    `SELECT pid,
            classid::bigint AS namespace,
            objid::bigint AS "identityKey",
            granted
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND objsubid = 2
        AND pid = $1
        AND classid::bigint = $2::bigint
        AND objid::bigint = $3::bigint
        AND granted = $4`,
    [pid, unsignedInt32(namespace), unsignedInt32(identityKey), granted],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    granted: row.granted,
    identityKey: Number(row.identityKey),
    namespace: signedInt32(Number(row.namespace)),
    pid: row.pid,
  };
}

async function waitForAdvisoryLock(
  observer: PoolClient,
  pid: number,
  identityKey: number,
  granted: boolean,
): Promise<ObservedAdvisoryLock> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const lock = await advisoryLock(observer, pid, identityKey, granted);
    if (lock) return lock;
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  const activity = await observer.query(
    `SELECT state, wait_event_type, wait_event
       FROM pg_stat_activity
      WHERE pid = $1`,
    [pid],
  );
  throw new Error(
    `backend ${String(pid)} did not expose the expected advisory lock: ${JSON.stringify(activity.rows)}`,
  );
}

async function rawStockLock(
  client: PoolClient,
  identityKey: number,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [
    STOCK_IDENTITY_LOCK_NAMESPACE,
    identityKey,
  ]);
}

function trackedAcquire(
  client: PoolClient,
  identities: readonly ScopedStockIdentityV1[],
): {
  settled: Promise<
    | {
        status: 'fulfilled';
        value: Awaited<ReturnType<typeof acquireStockIdentityLocks>>;
      }
    | { reason: unknown; status: 'rejected' }
  >;
} {
  return {
    settled: acquireStockIdentityLocks(client, identities).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ reason, status: 'rejected' as const }),
    ),
  };
}

function packedBigintKey(namespace: number, identityKey: number): string {
  const packed =
    (BigInt(unsignedInt32(namespace)) << 32n) |
    BigInt(unsignedInt32(identityKey));
  return packed.toString();
}

function unsignedInt32(value: number): number {
  return value >>> 0;
}

function signedInt32(value: number): number {
  return value > 2_147_483_647 ? value - 4_294_967_296 : value;
}

function postgresCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Best-effort cleanup; the ephemeral database is destroyed after the test.
  }
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
