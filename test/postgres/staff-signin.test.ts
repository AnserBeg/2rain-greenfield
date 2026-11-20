import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {
  bootstrapStaff,
  StaffIdentity,
} from '../../apps/api/src/staff-identity.js';
import {
  assertPilotDatabase,
  digest,
  secret,
  type StaffRealm,
} from '../../apps/api/src/staff-protocol.js';
import {
  staffRequestEntry,
  withTrustedRequestTransaction,
} from '../../packages/postgres-provider/src/request-context.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

test('staff sessions derive one live scoped principal at entry and again at the protected write', async () => {
  await withEphemeralPostgres('staff-session', async ({ pool, connection }) => {
    const admin = await pool.connect();
    try {
      await runMigrations(admin, await loadMigrations('db/migrations'));
    } finally {
      admin.release();
    }
    const t = randomUUID(),
      e = randomUUID();
    const realm: StaffRealm = {
      tenantId: t,
      environmentId: e,
      rpId: 'localhost',
      identityOrigin: 'https://localhost:6100',
      erpOrigin: 'https://erp.localhost:6101',
    };
    await pool.query(
      'INSERT INTO platform.tenants(id,slug) VALUES($1,$1::uuid::text)',
      [t],
    );
    await pool.query(
      'INSERT INTO platform.environments(tenant_id,id,slug) VALUES($1,$2,$2::uuid::text)',
      [t, e],
    );
    const owner = { name: 'Owner', contact: 'attended-channel' };
    const starts = await Promise.allSettled([
      bootstrapStaff(pool, realm, owner),
      bootstrapStaff(pool, realm, owner),
    ]);
    assert.equal(starts.filter((row) => row.status === 'fulfilled').length, 1);
    const p = (
      await pool.query<{ principal_id: string }>(
        'SELECT principal_id FROM platform.staff_accounts',
      )
    ).rows[0]!.principal_id;
    const handle = secret(),
      idHandle = secret(),
      family = randomUUID();
    await pool.query(
      "UPDATE platform.staff_accounts SET status='active' WHERE principal_id=$1",
      [p],
    );
    await pool.query(
      `INSERT INTO platform.staff_sessions(tenant_id,environment_id,principal_id,family_id,method,assurance,authenticated_at,last_activity,absolute_deadline,
      identity_digest,application_digest,handoff_deadline,browser_binding) VALUES($1,$2,$3,$4,'webauthn','user-verified-passkey',now(),now(),now()+interval '12 hours',$5,$6,now(),$7)`,
      [t, e, p, family, digest(idHandle), digest(handle), randomBytes(32)],
    );
    const runtime = new pg.Pool({ ...connection, user: 'north_star_runtime' }),
      identity = new pg.Pool({ ...connection, user: 'north_star_identity' });
    try {
      await assertPilotDatabase(runtime, 'north_star_runtime', realm);
      const lastOwnerChanges = await Promise.allSettled(
        [0, 1].map(() =>
          identity.query(
            'SELECT platform.staff_disable_memberships($1,$2,$3,$4)',
            [t, e, p, p],
          ),
        ),
      );
      assert.ok(
        lastOwnerChanges.every(
          (result) =>
            result.status === 'rejected' &&
            /deactivation refused/u.test(String(result.reason)),
        ),
      );
      assert.equal(
        (
          await pool.query(
            'SELECT FROM platform.current_policy_memberships WHERE principal_id=$1 AND revoked_at IS NULL',
            [p],
          )
        ).rowCount,
        1,
      );
      const session = (scope = e, token = handle) =>
        staffRequestEntry(runtime, () => ({
          tenantId: t,
          environmentId: scope,
          digest: digest(token),
          foreground: false,
        }));
      const context = await session().enter({});
      assert.equal(context.principalId, p);
      await assert.rejects(
        session(randomUUID()).enter({}),
        /staff session required/,
        'a session crossed its environment',
      );
      await assert.rejects(
        session(e, secret()).enter({}),
        /staff session required/,
      );
      await assert.rejects(
        session().enter({ headers: { 'x-principal-id': randomUUID() } }),
        /caller-supplied/,
      );
      const write = () =>
        withTrustedRequestTransaction(runtime, context, (c) =>
          c.query(
            `INSERT INTO platform.tenant_fixture_records(tenant_id,environment_id,id,label)
        VALUES($1,$2,gen_random_uuid(),current_setting('north_star.principal_id'))`,
            [t, e],
          ),
        );
      await write();
      assert.equal(
        (await pool.query('SELECT label FROM platform.tenant_fixture_records'))
          .rows[0].label,
        p,
      );
      // Shared clock boundaries are established in the database, without sleeps.
      await pool.query(
        "UPDATE platform.staff_sessions SET authenticated_at=now()-interval '1 hour',last_activity=now()-interval '30 minutes',absolute_deadline=now()+interval '11 hours'-interval '1 second'",
      );
      await assert.rejects(
        write(),
        /session expired/,
        'an idle session reached the write',
      );
      await assert.rejects(session().enter({}), /staff session required/);
      await pool.query(
        "UPDATE platform.staff_sessions SET authenticated_at=now()-interval '12 hours',last_activity=now(),absolute_deadline=now()-interval '1 second'",
      );
      await assert.rejects(session().enter({}), /staff session required/);
      await pool.query(
        "UPDATE platform.staff_sessions SET authenticated_at=now(),last_activity=now()+interval '5 minutes',absolute_deadline=now()+interval '12 hours'",
      );
      await assert.rejects(session().enter({}), /staff session required/);
      await pool.query(
        "UPDATE platform.staff_sessions SET authenticated_at=now()-interval '5 minutes',last_activity=now()-interval '2 minutes',absolute_deadline=now()+interval '1 hour'",
      );
      const activity = async () =>
        String(
          (
            await pool.query(
              'SELECT last_activity::text FROM platform.staff_sessions',
            )
          ).rows[0].last_activity,
        );
      const initial = await activity();
      await write();
      assert.equal(await activity(), initial);
      const active = await staffRequestEntry(runtime, () => ({
        tenantId: t,
        environmentId: e,
        digest: digest(handle),
        foreground: true,
      })).enter({});
      const refresh = () =>
        withTrustedRequestTransaction(runtime, active, (c) =>
          c.query('SELECT 1'),
        );
      await refresh();
      const touched = await activity();
      assert.notEqual(touched, initial);
      await refresh();
      assert.equal(await activity(), touched);
      await pool.query(
        'UPDATE platform.current_policy_memberships SET revoked_at=now()',
      );
      await assert.rejects(write(), /session expired/);
      await pool.query(
        'UPDATE platform.current_policy_memberships SET revoked_at=NULL',
      );
      await pool.query('UPDATE platform.staff_sessions SET revoked_at=now()');
      await assert.rejects(
        write(),
        /session expired/,
        'a revoked session reached the write',
      );
      assert.equal(
        (await pool.query('SELECT FROM platform.tenant_fixture_records'))
          .rowCount,
        2,
      );
      await assert.rejects(
        runtime.query('SELECT * FROM platform.staff_credentials'),
        /permission denied/,
      );
      const relations = await pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='platform' AND left(table_name,6)='staff_'",
      );
      assert.equal(relations.rowCount, 8);
      for (const { table_name } of relations.rows) {
        assert.match(table_name, /^staff_[a-z_]+$/u);
        for (const role of [runtime, identity])
          await assert.rejects(
            role.query('TRUNCATE platform.' + table_name),
            /permission denied/,
          );
      }
      await assert.rejects(
        pool.query('TRUNCATE platform.staff_authentication_audit'),
        /append-only/,
      );
      const rateKey = randomBytes(32),
        one = new StaffIdentity(identity, realm, rateKey),
        two = new StaffIdentity(identity, realm, rateKey);
      const attempts = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? one : two).spend('test', 'one', 5),
        ),
      );
      assert.equal(
        attempts.filter((row) => row.status === 'fulfilled').length,
        5,
      );
      await pool.query('CREATE ROLE north_star_fixture_proof_issuer NOLOGIN');
      await assert.rejects(
        assertPilotDatabase(runtime, 'north_star_runtime', realm),
      );
    } finally {
      await Promise.all([runtime.end(), identity.end()]);
    }
  });
});
