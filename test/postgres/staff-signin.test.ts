import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { erpTransport } from '../../apps/api/src/staff-erp-transport.js';
import { identityHandler } from '../../apps/api/src/staff-identity-http.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import {
  bootstrapStaff,
  scoped,
  StaffIdentity,
} from '../../apps/api/src/staff-identity.js';
import {
  csrf,
  assertPilotDatabase,
  digest,
  secret,
  type StaffRealm,
} from '../../apps/api/src/staff-protocol.js';
import {
  staffRequestEntry,
  withReadSnapshot,
  withTrustedRequestRead,
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
      await withReadSnapshot(runtime, async () => {
        const reader = await session().enter({});
        await withTrustedRequestRead(runtime, reader, async (c) => {
          await c.query('SAVEPOINT check_read_only');
          await assert.rejects(
            c.query(
              'INSERT INTO platform.tenant_fixture_records(tenant_id,environment_id,id,label) VALUES($1,$2,gen_random_uuid(),$3)',
              [t, e, 'read snapshot'],
            ),
            { code: '25006' },
          );
          await c.query('ROLLBACK TO SAVEPOINT check_read_only');
        });
      });
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
      assert.equal(relations.rowCount, 11);
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

test('staff sign-in integrity under the pilot database roles', async (suite) => {
  await withEphemeralPostgres(
    'staff-integrity',
    async ({ pool, connection, containerName }) => {
      const setup = await pool.connect();
      try {
        await runMigrations(setup, await loadMigrations('db/migrations'));
      } finally {
        setup.release();
      }
      const checkConnectorWrites = async (allowed: boolean) => {
        const grants = await pool.query(
          `SELECT has_table_privilege('north_star_runtime','platform.address_installations','INSERT') AS install,
                  has_column_privilege('north_star_runtime','platform.address_installations','enabled','UPDATE') AS enable,
                  has_table_privilege('north_star_runtime','platform.address_installation_history','INSERT') AS record`,
        );
        assert.deepEqual(grants.rows[0], {
          install: allowed,
          enable: allowed,
          record: allowed,
        });
      };
      await checkConnectorWrites(false);
      const t = randomUUID(),
        e = randomUUID();
      const realm: StaffRealm = {
        tenantId: t,
        environmentId: e,
        rpId: 'localhost',
        erpOrigin: 'https://erp.localhost',
        identityOrigin: 'https://localhost',
      };
      await pool.query(
        'INSERT INTO platform.tenants(id,slug) VALUES($1,$1::uuid::text)',
        [t],
      );
      await pool.query(
        'INSERT INTO platform.environments(tenant_id,id,slug) VALUES($1,$2,$2::uuid::text)',
        [t, e],
      );
      const owner = { name: 'Owner', contact: 'attended' };
      await bootstrapStaff(pool, realm, owner);
      await checkConnectorWrites(false);
      const verifier = 'north_star_activation_verifier';
      const authority = await pool.query(
        `SELECT pg_has_role($1,'north_star_runtime','MEMBER') AS runtime,
                has_table_privilege($1,'platform.address_geocodes','INSERT') AS maps,
                has_table_privilege($1,'platform.tenant_releases','INSERT') AS publish,
                has_column_privilege($1,'platform.active_release_pointers','fence','UPDATE') AS activate`,
        [verifier],
      );
      assert.deepEqual(authority.rows[0], {
        runtime: false,
        maps: false,
        publish: false,
        activate: true,
      });
      const p = (
        await pool.query<{ principal_id: string }>(
          "UPDATE platform.staff_accounts SET status='active' RETURNING principal_id",
        )
      ).rows[0]!.principal_id;
      const identity = new pg.Pool({
        ...connection,
        user: 'north_star_identity',
      });
      const runtime = new pg.Pool({
        ...connection,
        user: 'north_star_runtime',
      });
      const service = new StaffIdentity(identity, realm, randomBytes(32));
      const addSession = async (binding: Buffer) => {
        const handoff = secret(),
          erp = secret(),
          id = secret();
        await pool.query(
          `INSERT INTO platform.staff_sessions(tenant_id,environment_id,principal_id,family_id,method,assurance,
          authenticated_at,last_activity,absolute_deadline,identity_digest,application_digest,handoff_digest,handoff_deadline,browser_binding)
         VALUES($1,$2,$3,gen_random_uuid(),'webauthn','user-verified-passkey',now(),now(),now()+interval '12 hours',$4,$5,$6,now()+interval '1 minute',$7)`,
          [t, e, p, digest(id), digest(erp), digest(handoff), binding],
        );
        return { handoff, erp, id };
      };
      try {
        await suite.test(
          'bootstrap records one database-wide mode before either service can provision',
          async () => {
            const { createComposedApplicationRuntime } =
              await import('../../packages/postgres-provider/src/composed-application-runtime.js');
            const installer = await pool.connect();
            try {
              await installer.query('BEGIN');
              await installer.query(
                "SELECT pg_advisory_xact_lock(hashtext('staff-identity-deployment-v1'))",
              );
              const demo = createComposedApplicationRuntime({
                databaseUrl: `postgresql://postgres@127.0.0.1:${connection.port}/postgres?options=-c%20lock_timeout%3D250ms`,
                localDemoIdentity: true,
                migrationsDirectory: 'db/migrations',
                providerErrorMappings: [],
                tenantSlug: 'mode-check',
                compiledApplication: {},
              });
              await assert.rejects(demo, {
                code: '55P03',
                where: /claim_staff_store_mode/u,
              });
            } finally {
              await installer.query('ROLLBACK');
              installer.release();
            }
            const claim = (mode: string) =>
              pool.query('SELECT platform.claim_staff_store_mode($1)', [mode]);
            const outcomes = await Promise.allSettled([
              claim('demo'),
              claim('pilot'),
            ]);
            assert.deepEqual(
              outcomes.map((o) => o.status),
              ['rejected', 'fulfilled'],
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT mode FROM north_star_internal.staff_store_mode',
                )
              ).rows[0].mode,
              'pilot',
            );
            // On a fresh store the two concurrent first claims can elect only one mode.
            await pool.query('TRUNCATE north_star_internal.staff_store_mode');
            const race = await Promise.allSettled([
              claim('demo'),
              claim('pilot'),
            ]);
            assert.equal(
              race.filter((r) => r.status === 'fulfilled').length,
              1,
            );
            await pool.query('TRUNCATE north_star_internal.staff_store_mode');
            await claim('demo');
            // CONNECT-1: no store mode grants a direct connector write; the
            // demo claim is checked inside platform.address_configure.
            await checkConnectorWrites(false);
            const other = randomUUID();
            await pool.query(
              'INSERT INTO platform.environments(tenant_id,id,slug) VALUES($1,$2,$2::uuid::text)',
              [t, other],
            );
            await assert.rejects(
              bootstrapStaff(pool, { ...realm, environmentId: other }, owner),
              /dedicated pilot database/,
            );
            await pool.query('TRUNCATE north_star_internal.staff_store_mode');
            await claim('pilot');
            await checkConnectorWrites(false);
          },
        );
        await suite.test(
          'ERP landing reads and bounded login creation',
          async () => {
            const handler = erpTransport(realm, runtime, randomBytes(32), [
              '127.0.0.1',
            ]);
            const server = createServer((req, res) => {
              void handler(req, res).catch(() => {
                res.writeHead(403).end();
              });
            });
            try {
              await new Promise<void>((resolve) =>
                server.listen(0, '127.0.0.1', resolve),
              );
              const addr = server.address();
              assert.ok(addr && typeof addr === 'object');
              const send = (
                path: string,
                method: string,
                headers: Record<string, string> = {},
                body = '',
              ) =>
                new Promise<{
                  status: number | undefined;
                  cookie?: string;
                  html: string;
                }>((resolve, reject) => {
                  const req = request(
                    {
                      hostname: '127.0.0.1',
                      port: addr.port,
                      path,
                      method,
                      headers: {
                        host: new URL(realm.erpOrigin).host,
                        ...headers,
                      },
                    },
                    (res) => {
                      let html = '';
                      res.setEncoding('utf8').on('data', (chunk: string) => {
                        html += chunk;
                      });
                      res.on('end', () =>
                        resolve({
                          status: res.statusCode,
                          cookie:
                            res.headers['set-cookie']?.[0]?.split(';')[0] ?? '',
                          html,
                        }),
                      );
                    },
                  );
                  req.on('error', reject);
                  req.end(body);
                });
              const count = async () =>
                (
                  await pool.query(
                    'SELECT FROM platform.staff_login_transactions',
                  )
                ).rowCount;
              let landing = await send('/', 'GET');
              for (const path of ['/auth/signin', '/', '/auth/signin'])
                landing = await send(path, 'GET');
              assert.equal(
                await count(),
                0,
                'landing GET created a login transaction',
              );
              assert.equal(landing.status, 200);
              const token = landing.html.match(
                /name="_csrf" value="([\w-]+)"/u,
              )?.[1];
              assert.ok(landing.cookie && token);
              const headers = {
                origin: realm.erpOrigin,
                cookie: landing.cookie,
                'content-type': 'application/x-www-form-urlencoded',
                'x-real-ip': '192.0.2.10',
              };
              const form = new URLSearchParams({ _csrf: token }).toString();
              assert.equal(
                (
                  await send(
                    '/auth/signin',
                    'POST',
                    { ...headers, origin: realm.identityOrigin },
                    form,
                  )
                ).status,
                403,
              );
              assert.equal(
                (await send('/auth/signin', 'POST', headers, '')).status,
                403,
              );
              assert.equal(await count(), 0);
              const start = (source = '192.0.2.10') =>
                send(
                  '/auth/signin',
                  'POST',
                  { ...headers, 'x-real-ip': source },
                  form,
                );
              const oldBindings: Buffer[] = [];
              for (let i = 0; i < 2; i++) {
                const started = await start();
                assert.equal(started.status, 303);
                const verifier = started.cookie?.match(
                  /^__Host-erp-login=([\w-]+)$/u,
                )?.[1];
                assert.ok(verifier);
                oldBindings.push(digest(verifier));
              }
              await pool.query(
                'UPDATE platform.staff_login_transactions SET expires_at=now() WHERE binding=$1',
                [oldBindings[0]],
              );
              await pool.query(
                'UPDATE platform.staff_login_transactions SET consumed_at=now() WHERE binding=$1',
                [oldBindings[1]],
              );
              assert.equal((await start()).status, 303);
              assert.equal(
                await count(),
                1,
                'expired and consumed login transactions must be purged',
              );
              for (let i = 3; i < 30; i++)
                assert.equal((await start()).status, 303);
              assert.equal((await start()).status, 403);
              assert.equal((await start('192.0.2.11')).status, 303);
              assert.equal(await count(), 29);
            } finally {
              await new Promise<void>((resolve) =>
                server.close(() => resolve()),
              );
            }
          },
        );
        await suite.test(
          'only a current ERP login transaction can be consumed alongside its handoff',
          async () => {
            const verifier = secret(),
              binding = digest(verifier);
            const first = await addSession(binding),
              second = await addSession(binding);
            await assert.rejects(
              service.redeem(first.handoff, verifier),
              /Staff access could not be verified/,
              'a handoff alone cannot start an ERP session',
            );
            await runtime.query(
              'SELECT platform.staff_start_login($1,$2,$3,NULL,$4)',
              [t, e, binding, randomBytes(32)],
            );
            // A sequence in this temporary database witnesses the update even if its
            // transaction rolls back. An early lookup refusal cannot satisfy this proof.
            await pool.query(`CREATE SEQUENCE public.verifier_consumptions MINVALUE 0 START 0;
              CREATE FUNCTION public.observe_consumption() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
              BEGIN PERFORM nextval('public.verifier_consumptions'); RETURN NEW; END $$;
              CREATE TRIGGER witness_consumption AFTER UPDATE OF consumed_at ON platform.staff_login_transactions
              FOR EACH ROW EXECUTE FUNCTION public.observe_consumption()`);
            const expiredHandoff = await addSession(binding);
            await pool.query(
              'UPDATE platform.staff_sessions SET handoff_deadline=now() WHERE handoff_digest=$1',
              [digest(expiredHandoff.handoff)],
            );
            await assert.rejects(
              service.redeem(expiredHandoff.handoff, verifier),
              /Staff access could not be verified/,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT is_called FROM public.verifier_consumptions',
                )
              ).rows[0].is_called,
              true,
              'handoff refusal must follow verifier consumption',
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT consumed_at FROM platform.staff_login_transactions WHERE binding=$1',
                  [binding],
                )
              ).rows[0].consumed_at,
              null,
              'handoff refusal must roll back verifier consumption',
            );
            const outcomes = await Promise.allSettled(
              [first, second].map((row) =>
                service.redeem(row.handoff, verifier),
              ),
            );
            assert.equal(
              outcomes.filter((row) => row.status === 'fulfilled').length,
              1,
            );
            const prior = await addSession(randomBytes(32));
            const other = await addSession(randomBytes(32));
            const returning = secret();
            const exchange = await addSession(digest(returning));
            const { rows } = await runtime.query(
              'SELECT platform.staff_start_login($1,$2,$3,$4,$5) AS kept',
              [t, e, digest(returning), digest(prior.erp), randomBytes(32)],
            );
            assert.equal(rows[0].kept, true);
            await assert.rejects(
              service.redeem(exchange.handoff, returning, other.erp),
              /Staff access could not be verified/,
              'a different live ERP handle must be refused',
            );
            assert.ok(
              await service.redeem(exchange.handoff, returning, prior.erp),
            );
            const expired = secret();
            await runtime.query(
              'SELECT platform.staff_start_login($1,$2,$3,NULL,$4)',
              [t, e, digest(expired), randomBytes(32)],
            );
            const pending = await addSession(digest(expired));
            await pool.query(
              'UPDATE platform.staff_login_transactions SET expires_at=now() WHERE binding=$1',
              [digest(expired)],
            );
            await assert.rejects(service.redeem(pending.handoff, expired));
          },
        );
        await suite.test(
          'recovery authority includes live permission, resource and company under the policy epoch lock',
          async () => {
            const subject = randomUUID(),
              company = randomUUID(),
              other = randomUUID();
            await pool.query(
              `INSERT INTO platform.staff_accounts SELECT tenant_id,environment_id,$2,$3,'Member','attended','active',NULL
          FROM platform.staff_accounts WHERE principal_id=$1`,
              [p, subject, randomBytes(32)],
            );
            const role = randomUUID();
            await pool.query(
              "INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key) VALUES($1,$2,$3,'operations')",
              [t, e, role],
            );
            await pool.query(
              `INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id)
          VALUES($1,$2,gen_random_uuid(),$3,$4,$5)`,
              [t, e, subject, role, company],
            );
            await pool.query(
              `INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
          VALUES($1,$2,$3,'northstar.test:approve','northstar.test:invoice')`,
              [t, e, role],
            );
            const manage = () =>
              scoped(
                identity,
                realm,
                async (c) =>
                  (
                    await c.query(
                      'SELECT platform.staff_can_manage($1,$2,$3,$4) AS ok',
                      [t, e, p, subject],
                    )
                  ).rows[0].ok as boolean,
              );
            const disable = () =>
              scoped(identity, realm, (c) =>
                c.query(
                  'SELECT platform.staff_disable_memberships($1,$2,$3,$4)',
                  [t, e, subject, p],
                ),
              );
            await assert.rejects(
              disable(),
              /deactivation refused/,
              'the owner must cover the member’s permissions',
            );
            await pool.query(
              `INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id)
          VALUES($1,$2,gen_random_uuid(),$3,$4,$5)`,
              [t, e, p, role, other],
            );
            assert.equal(await manage(), false);
            await pool.query(
              'UPDATE platform.current_policy_memberships SET legal_entity_id=$1 WHERE principal_id=$2 AND role_id=$3',
              [company, p, role],
            );
            assert.equal(await manage(), true);
            await scoped(identity, realm, async (c) => {
              await c.query('SELECT platform.staff_can_manage($1,$2,$3,$4)', [
                t,
                e,
                p,
                subject,
              ]);
              const writer = await pool.connect();
              try {
                await writer.query('BEGIN');
                await assert.rejects(
                  writer.query(
                    'SELECT FROM platform.current_policy_epochs WHERE tenant_id=$1 AND environment_id=$2 FOR UPDATE NOWAIT',
                    [t, e],
                  ),
                  { code: '55P03' },
                );
              } finally {
                await writer.query('ROLLBACK');
                writer.release();
              }
            });
          },
        );
        await suite.test(
          'source allowances use the trusted ingress address or direct socket',
          async () => {
            const sources: string[] = [];
            class ObservedIdentity extends StaffIdentity {
              override async spend(
                category: string,
                source: string,
                limit: number,
              ) {
                await super.spend(category, source, limit);
                sources.push(source);
              }
            }
            const issuer = new ObservedIdentity(
              identity,
              realm,
              randomBytes(32),
            );
            const flow = secret();
            for (const trusted of [[], ['127.0.0.1']]) {
              const server = createServer(identityHandler(issuer, trusted));
              try {
                await new Promise<void>((resolve) =>
                  server.listen(0, '127.0.0.1', resolve),
                );
                const address = server.address();
                assert.ok(address && typeof address === 'object');
                for (const header of [
                  '192.0.2.1',
                  '192.0.2.2',
                  '192.0.2.1, 192.0.2.2',
                ]) {
                  await new Promise<void>((resolve, reject) => {
                    const req = request(
                      {
                        host: '127.0.0.1',
                        port: address.port,
                        path: '/begin',
                        method: 'POST',
                        headers: {
                          host: 'localhost',
                          origin: realm.identityOrigin,
                          'x-real-ip': header,
                          'content-type': 'application/json',
                          cookie: '__Host-identity-flow=' + flow,
                          'x-erp-csrf': csrf(flow),
                        },
                      },
                      (res) => {
                        res.resume();
                        res.on('end', resolve);
                      },
                    );
                    req.on('error', reject);
                    req.end('{}');
                  });
                }
              } finally {
                await new Promise<void>((resolve) =>
                  server.close(() => resolve()),
                );
              }
            }
            assert.deepEqual(sources, [
              '127.0.0.1',
              '127.0.0.1',
              '127.0.0.1',
              '192.0.2.1',
              '192.0.2.2',
            ]);
          },
        );
        await suite.test(
          'identity login has column grants for credential state and account lifecycle',
          async () => {
            for (const [table, allowed] of [
              ['staff_credentials', ['backed_up', 'revoked_at', 'sign_count']],
              ['staff_accounts', ['decisions_after', 'status']],
            ] as const) {
              const { rows } = await identity.query<{ name: string }>(
                `SELECT attname AS name FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped
             AND has_column_privilege(current_user,attrelid,attname,'UPDATE') ORDER BY attname`,
                ['platform.' + table],
              );
              assert.deepEqual(
                rows.map((row) => row.name),
                allowed,
              );
            }
          },
        );
        await suite.test(
          'duplicate enrollment logs an observable database error without credential or bind values',
          async () => {
            await pool.query(
              "ALTER ROLE north_star_identity SET log_statement='all'",
            );
            const logged = new pg.Pool({
              ...connection,
              user: 'north_star_identity',
            });
            const marker = 'synthetic-' + randomUUID();
            const key = randomBytes(32);
            const insert = () =>
              scoped(logged, realm, (c) =>
                c.query(
                  `/* staff-enrollment-log-check */ INSERT INTO platform.staff_credentials(tenant_id,environment_id,principal_id,credential_id,public_key,method,sign_count,backed_up,backup_eligible,transports)
           VALUES($1,$2,$3,$4,$5,'webauthn',0,false,false,'{}')`,
                  [t, e, p, marker, key],
                ),
              );
            try {
              await insert();
              await assert.rejects(insert(), { code: '23505' });
              const { stdout, stderr } = await promisify(execFile)('docker', [
                'logs',
                containerName,
              ]);
              const logs = stdout + stderr;
              assert.match(
                logs,
                /duplicate key value violates unique constraint "staff_credentials_pkey"/u,
              );
              assert.match(logs, /staff-enrollment-log-check/u);
              assert.ok(
                !logs.includes(marker) && !logs.includes(key.toString('hex')),
                'enrollment values appeared in database logs',
              );
            } finally {
              await logged.end();
            }
          },
        );
        await suite.test(
          'idle and absolute expiry survive clock rollback at another session entry',
          async () => {
            // Inject only the time source in this ephemeral database. Transactions, session
            // checks, rollbacks and clock sharing are the production implementations.
            await pool.query(
              'CREATE TABLE public.staff_test_clock(instant timestamptz NOT NULL)',
            );
            await pool.query(
              "INSERT INTO public.staff_test_clock VALUES('2080-01-01 00:00Z')",
            );
            const defs = await pool.query<{ definition: string }>(
              `SELECT pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='platform'::regnamespace
           AND proname IN ('staff_session_principal','staff_observed_time')`,
            );
            for (const { definition } of defs.rows)
              await pool.query(
                definition.replaceAll(
                  'clock_timestamp()',
                  '(SELECT instant FROM public.staff_test_clock)',
                ),
              );
            const checkEntry = (erp: string) =>
              runtime.query<{ principal: string | null }>(
                'SELECT platform.staff_session_principal($1,$2,$3,false,false) AS principal',
                [t, e, digest(erp)],
              );
            for (const [day, after, before, deadline] of [
              ['01', '00:31', '00:29', '12:00'],
              ['02', '00:21', '00:19', '00:20'],
            ]) {
              const date = '2080-01-' + day;
              const session = await addSession(randomBytes(32));
              await pool.query(
                `UPDATE platform.staff_sessions SET authenticated_at=$2,last_activity=$2,absolute_deadline=$3 WHERE identity_digest=$1`,
                [
                  digest(session.id),
                  date + ' 00:00Z',
                  date + ' ' + deadline + 'Z',
                ],
              );
              await pool.query(
                'UPDATE public.staff_test_clock SET instant=$1',
                [date + ' 00:01Z'],
              );
              assert.equal(
                (await checkEntry(session.erp)).rows[0]?.principal,
                p,
              );
              await pool.query(
                'UPDATE public.staff_test_clock SET instant=$1',
                [date + ' ' + after + 'Z'],
              );
              const expired = await runtime.connect();
              try {
                await expired.query('BEGIN');
                assert.equal(
                  (
                    await expired.query(
                      'SELECT platform.staff_session_principal($1,$2,$3,true,false) AS p',
                      [t, e, digest(session.erp)],
                    )
                  ).rows[0].p,
                  null,
                );
              } finally {
                await expired.query('ROLLBACK');
                expired.release();
              }
              await pool.query(
                'UPDATE public.staff_test_clock SET instant=$1',
                [date + ' ' + before + 'Z'],
              );
              assert.equal(
                (await checkEntry(session.erp)).rows[0]?.principal,
                null,
                'a rollback revived an expired session',
              );
              await assert.rejects(service.account(session.id));
            }
          },
        );
      } finally {
        await Promise.all([runtime.end(), identity.end()]);
      }
    },
  );
});
