import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import type { Pool, PoolClient } from 'pg';

import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import {
  acquireStockIdentityLocks,
  planStockIdentityLocks,
  STOCK_IDENTITY_LOCK_NAMESPACE,
  type ScopedStockIdentityV1,
} from '../../packages/postgres-provider/src/stock-serializer.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const checkedInMigrations = resolve('db/migrations');
const tenantId = '11000000-0000-4000-8000-000000000001';
const environmentId = '22000000-0000-4000-8000-000000000002';
const legalEntityId = '33000000-0000-4000-8000-000000000003';
const itemId = '44000000-0000-4000-8000-000000000004';
const locationA = '55000000-0000-4000-8000-000000000005';
const locationB = '66000000-0000-4000-8000-000000000006';

const stockA = stockIdentity(locationA);
const stockB = stockIdentity(locationB);

test('stock lock plan is canonical, total, stable, and duplicate-free', () => {
  const forward = planStockIdentityLocks([stockA, stockB, stockA]);
  const reverse = planStockIdentityLocks([stockB, stockA]);

  assert.deepEqual(forward, reverse);
  assert.equal(forward.length, 2);
  assert.equal(forward[0]!.identityKey < forward[1]!.identityKey, true);
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
  async () => {
    await withSerializerDatabase('stock-lock-wait', async (pool) => {
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
        assert.equal(await movementBalance(holder, stockA), '0');

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

        await holder.query('COMMIT');
        await waitingAcquire;
        assert.equal(await movementBalance(waiter, stockA), '0');
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
    });
  },
);

test(
  'unordered opposite transfers deadlock, while the serializer total order does not',
  { timeout: 30_000 },
  async () => {
    await withSerializerDatabase('stock-lock-order', async (pool) => {
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
        const loserAcquire = first.side === 'left' ? rightAcquire : leftAcquire;
        await waitForAdvisoryLock(
          observer,
          loserPid,
          firstTarget.identityKey,
          false,
        );
        assert.equal(await movementBalance(winner, stockA), '0');
        assert.equal(await movementBalance(winner, stockB), '0');
        await winner.query('COMMIT');

        const second = await loserAcquire.settled;
        assert.equal(second.status, 'fulfilled');
        if (second.status === 'fulfilled') {
          assert.deepEqual(
            second.value.map(({ identityKey }) => identityKey),
            orderedTargets.map(({ identityKey }) => identityKey),
          );
        }
        assert.equal(await movementBalance(loser, stockA), '0');
        assert.equal(await movementBalance(loser, stockB), '0');
        await loser.query('COMMIT');
      } finally {
        await rollbackQuietly(left);
        await rollbackQuietly(right);
        left.release();
        right.release();
        observer.release();
      }
    });
  },
);

test(
  'the reserved two-key lock is real, transaction-only, and disjoint from bigint locks',
  { timeout: 30_000 },
  async () => {
    await withSerializerDatabase('stock-lock-control', async (pool) => {
      const stockClient = await pool.connect();
      const bigintClient = await pool.connect();
      const observer = await pool.connect();
      try {
        await assert.rejects(
          acquireStockIdentityLocks(stockClient, [stockA]),
          (error: unknown) => postgresCode(error) === '25P01',
        );

        const stockPid = await backendPid(stockClient);
        const bigintPid = await backendPid(bigintClient);
        const target = planStockIdentityLocks([stockA])[0];
        assert.ok(target);
        await stockClient.query('BEGIN');
        await acquireStockIdentityLocks(stockClient, [stockA]);
        await bigintClient.query('BEGIN');
        await bigintClient.query("SET LOCAL statement_timeout = '2s'");
        await bigintClient.query('SELECT pg_advisory_xact_lock($1::bigint)', [
          packedBigintKey(STOCK_IDENTITY_LOCK_NAMESPACE, target.identityKey),
        ]);

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

        await stockClient.query('COMMIT');
        assert.equal(
          await advisoryLock(observer, stockPid, target.identityKey, true),
          undefined,
        );
        await bigintClient.query('COMMIT');
      } finally {
        await rollbackQuietly(stockClient);
        await rollbackQuietly(bigintClient);
        stockClient.release();
        bigintClient.release();
        observer.release();
      }
    });
  },
);

function stockIdentity(locationId: string): ScopedStockIdentityV1 {
  return { environmentId, itemId, legalEntityId, locationId, tenantId };
}

async function withSerializerDatabase(
  label: string,
  run: (pool: Pool) => Promise<void>,
): Promise<void> {
  await withEphemeralPostgres(label, async (database) => {
    const client = await database.pool.connect();
    try {
      await runMigrations(client, await loadMigrations(checkedInMigrations));
      const movementRelation = await client.query<{ kind: string }>(
        `SELECT relation.relkind AS kind
           FROM pg_class AS relation
           JOIN pg_namespace AS namespace
             ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'platform'
            AND relation.relname = 'inventory_movements'`,
      );
      assert.deepEqual(movementRelation.rows, [{ kind: 'p' }]);
    } finally {
      client.release();
    }
    await run(database.pool);
  });
}

async function movementBalance(
  client: PoolClient,
  identity: ScopedStockIdentityV1,
): Promise<string> {
  const result = await client.query<{ balance: string }>(
    `SELECT COALESCE(sum(quantity_delta), 0)::text AS balance
       FROM platform.inventory_movements
      WHERE tenant_id = $1::uuid
        AND environment_id = $2::uuid
        AND legal_entity_id = $3::uuid
        AND item_id = $4::uuid
        AND location_id = $5::uuid`,
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

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>(
    'SELECT pg_backend_pid() AS pid',
  );
  const pid = result.rows[0]?.pid;
  assert.ok(pid);
  return pid;
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
): Promise<ObservedAdvisoryLock | undefined> {
  const result = await observer.query<ObservedAdvisoryLock>(
    `SELECT pid,
            classid::bigint::integer AS namespace,
            objid::bigint AS "identityKey",
            granted
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND objsubid = 2
        AND pid = $1
        AND classid::bigint = $2::bigint
        AND objid::bigint = $3::bigint
        AND granted = $4`,
    [pid, STOCK_IDENTITY_LOCK_NAMESPACE, unsignedInt32(identityKey), granted],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    granted: row.granted,
    identityKey: Number(row.identityKey),
    namespace: Number(row.namespace),
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
