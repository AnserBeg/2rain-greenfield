import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type pg from 'pg';

import {
  createRequestWorkProbe,
  meterPoolStatements,
  parseServerTiming,
  RequestWorkMeter,
  serverTimingValue,
} from '../../packages/postgres-provider/src/request-work-meter.js';

const roleCheck = `SELECT current_user AS role FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;
const identity = `SELECT set_config('north_star.tenant_id', $1, true)`;
const epoch = `SELECT policy_version FROM platform.current_policy_epochs WHERE tenant_id = $1`;
const read = `SELECT record_id FROM north_star_module.t WHERE record_id = $1`;

/** One trusted request transaction, as request-context.ts sends it. */
function envelope(meter: RequestWorkMeter, client: object, body: () => void) {
  meter.observe(client, 'BEGIN', undefined);
  meter.observe(client, roleCheck, undefined);
  meter.observe(client, identity, ['tenant']);
  body();
  meter.observe(client, 'COMMIT', undefined);
  meter.observe(client, 'RESET ROLE', undefined);
  meter.observe(client, 'RESET ALL', undefined);
}

test('SPEED-1 meter: a transaction is a BEGIN, never the cleanup after its COMMIT', () => {
  const meter = new RequestWorkMeter();
  const client = {};
  envelope(meter, client, () => {
    meter.observe(client, epoch, ['tenant']);
    meter.observe(
      client,
      'SET LOCAL ROLE north_star_module_runtime',
      undefined,
    );
    meter.observe(client, read, ['a']);
  });
  assert.deepEqual(meter.counts(), {
    authorization: 1,
    repeats: 0,
    statements: 9,
    transactions: 1,
  });
  // A statement outside BEGIN is its own (implicit) transaction.
  meter.observe(client, read, ['b']);
  assert.equal(meter.counts().transactions, 2);
});

test('SPEED-1 meter: an identical statement repeats only with identical parameters, and the envelope never counts', () => {
  const meter = new RequestWorkMeter();
  const first = {};
  const second = {};
  envelope(meter, first, () => {
    meter.observe(first, read, ['a']);
    meter.observe(first, read, ['b']);
  });
  envelope(meter, second, () => {
    meter.observe(second, read, ['a']);
    meter.observe(second, epoch, ['tenant']);
    meter.observe(second, epoch, ['tenant']);
  });
  const counts = meter.counts();
  assert.equal(counts.transactions, 2);
  assert.equal(counts.repeats, 2, 'read(a) again and the epoch again');
  assert.equal(counts.authorization, 2);
});

test('SPEED-1 meter: a metered pool counts only inside a probe, and Server-Timing round-trips', async () => {
  const sent: string[] = [];
  const pool = new EventEmitter() as unknown as pg.Pool;
  meterPoolStatements(pool);
  const client = {
    query(text: string) {
      sent.push(text);
      return Promise.resolve({ rows: [] });
    },
  };
  (pool as unknown as EventEmitter).emit('connect', client);

  await client.query('BEGIN');
  const probe = createRequestWorkProbe();
  const header = await probe.measure(async (serverTiming) => {
    await client.query('BEGIN');
    await client.query(read);
    await client.query('COMMIT');
    return serverTiming();
  });
  await client.query('COMMIT');
  assert.equal(sent.length, 5, 'every call still reaches the client');
  const parsed = parseServerTiming(header);
  assert.ok(parsed, header);
  assert.deepEqual(
    { ...parsed, milliseconds: 0 },
    {
      authorization: 0,
      milliseconds: 0,
      repeats: 0,
      statements: 3,
      transactions: 1,
    },
  );
  assert.equal(
    parseServerTiming(
      serverTimingValue(
        { authorization: 4, repeats: 3, statements: 2, transactions: 1 },
        12.5,
      ),
    )?.repeats,
    3,
  );
  assert.equal(parseServerTiming(null), null);
});
