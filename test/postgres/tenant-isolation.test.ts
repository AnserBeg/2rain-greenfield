import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import {
  AuthenticatedRequestEntryAdapter,
  AuthenticationRequiredError,
  UntrustedIdentityInputError,
} from '../../packages/runtime/src/request-context.js';
import type {
  AuthenticatedIdentity,
  TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import {
  UnsafeDatabaseRoleError,
  withTrustedRequestTransaction,
} from '../../packages/postgres-provider/src/request-context.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const checkedInMigrations = resolve('db/migrations');
const tenantA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const environmentA = 'a1000000-0000-4000-8000-000000000001';
const environmentA2 = 'a2000000-0000-4000-8000-000000000002';
const environmentB = 'b1000000-0000-4000-8000-000000000001';
const principalA = 'aa000000-0000-4000-8000-000000000001';
const principalB = 'bb000000-0000-4000-8000-000000000001';
const recordA = 'a0000000-0000-4000-8000-000000000001';
const recordA2 = 'a0000000-0000-4000-8000-000000000002';
const recordB = 'b0000000-0000-4000-8000-000000000001';

const identities = new Map<string, AuthenticatedIdentity>([
  [
    'Bearer session-a',
    {
      environmentId: environmentA,
      principalId: principalA,
      tenantId: tenantA,
    },
  ],
  [
    'Bearer session-b',
    {
      environmentId: environmentB,
      principalId: principalB,
      tenantId: tenantB,
    },
  ],
]);

function requestEntry(): AuthenticatedRequestEntryAdapter {
  return new AuthenticatedRequestEntryAdapter(async (request) => {
    const authorization = request.headers?.authorization;
    return typeof authorization === 'string'
      ? (identities.get(authorization) ?? null)
      : null;
  });
}

test('request entry accepts only authenticated identity and rejects caller identity', async () => {
  const entry = requestEntry();
  const context = await entry.enter({
    arguments: { operation: 'fixture.read' },
    headers: { authorization: 'Bearer session-a' },
  });

  assert.equal(context.tenantId, tenantA);
  assert.equal(context.environmentId, environmentA);
  assert.equal(context.principalId, principalA);
  assert.match(context.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(Object.isFrozen(context), true);

  await assert.rejects(
    entry.enter({
      headers: {
        authorization: 'Bearer session-a',
        'X-Tenant-ID': tenantB,
      },
    }),
    UntrustedIdentityInputError,
  );
  await assert.rejects(
    entry.enter({
      arguments: { environmentId: environmentB, principalId: principalB },
      headers: { authorization: 'Bearer session-a' },
    }),
    UntrustedIdentityInputError,
  );
  await assert.rejects(
    entry.enter({ headers: { authorization: 'Bearer unknown' } }),
    AuthenticationRequiredError,
  );
});

test('two tenants and environments remain isolated across one reused pooled connection', async () => {
  await withEphemeralPostgres(
    'tenant-pool-isolation',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        await runMigrations(admin, await loadMigrations(checkedInMigrations));
        const runtimeRole = await admin.query<{
          rolbypassrls: boolean;
          rolcanlogin: boolean;
          rolinherit: boolean;
          rolpassword: string | null;
          rolsuper: boolean;
        }>(`
          SELECT rolbypassrls, rolcanlogin, rolinherit, rolpassword, rolsuper
          FROM pg_catalog.pg_authid
          WHERE rolname = 'north_star_runtime'
        `);
        assert.deepEqual(runtimeRole.rows[0], {
          rolbypassrls: false,
          rolcanlogin: true,
          rolinherit: false,
          rolpassword: null,
          rolsuper: false,
        });
        await seedFixture(admin);
      } finally {
        admin.release();
      }

      const singleConnectionPool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_runtime',
      });
      try {
        const entry = requestEntry();
        const contextA = await entry.enter({
          headers: { authorization: 'Bearer session-a' },
        });
        const contextB = await entry.enter({
          headers: { authorization: 'Bearer session-b' },
        });

        await assert.rejects(
          withTrustedRequestTransaction(pool, contextA, async () => undefined),
          UnsafeDatabaseRoleError,
        );

        const first = await readVisibleFixture(singleConnectionPool, contextA);
        assert.deepEqual(first.labels, ['tenant-a']);
        assert.equal(first.tenantId, tenantA);
        assert.equal(first.environmentId, environmentA);
        assert.equal(first.principalId, principalA);
        assert.equal(first.role, 'north_star_runtime');
        assert.equal(first.sessionRole, 'north_star_runtime');
        await assertConnectionCleared(singleConnectionPool, first.backendPid);

        await assert.rejects(
          withTrustedRequestTransaction(
            singleConnectionPool,
            contextA,
            async (client) => {
              await client.query(
                `INSERT INTO platform.tenant_fixture_records
                   (tenant_id, environment_id, id, label)
                 VALUES ($1, $2, $3, $4)`,
                [tenantB, environmentB, recordB, 'cross-tenant-write'],
              );
            },
          ),
          /row-level security policy/,
        );
        await assertConnectionCleared(singleConnectionPool, first.backendPid);

        const second = await readVisibleFixture(singleConnectionPool, contextB);
        assert.deepEqual(second.labels, ['tenant-b']);
        assert.equal(second.tenantId, tenantB);
        assert.equal(second.environmentId, environmentB);
        assert.equal(second.principalId, principalB);
        assert.equal(second.sessionRole, 'north_star_runtime');
        assert.equal(second.backendPid, first.backendPid);
        await assertConnectionCleared(singleConnectionPool, first.backendPid);

        const noContext = await singleConnectionPool.connect();
        try {
          const hidden = await noContext.query<{ count: string }>(
            'SELECT count(*) FROM platform.tenant_fixture_records',
          );
          assert.equal(hidden.rows[0]?.count, '0');
        } finally {
          noContext.release();
        }

        const forged = {
          environmentId: environmentB,
          principalId: principalB,
          requestId: 'b0000000-0000-4000-8000-000000000099',
          tenantId: tenantB,
        } as TrustedRequestContext;
        await assert.rejects(
          withTrustedRequestTransaction(
            singleConnectionPool,
            forged,
            async () => undefined,
          ),
          /must be issued by AuthenticatedRequestEntryAdapter/,
        );
      } finally {
        await singleConnectionPool.end();
      }
    },
  );
});

interface VisibleFixture {
  backendPid: number;
  environmentId: string;
  labels: string[];
  principalId: string;
  role: string;
  sessionRole: string;
  tenantId: string;
}

async function readVisibleFixture(
  pool: pg.Pool,
  context: TrustedRequestContext,
): Promise<VisibleFixture> {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    const rows = await client.query<{ label: string }>(
      'SELECT label FROM platform.tenant_fixture_records ORDER BY label',
    );
    const state = await client.query<{
      backend_pid: number;
      environment_id: string;
      principal_id: string;
      role: string;
      session_role: string;
      tenant_id: string;
    }>(`
      SELECT pg_backend_pid() AS backend_pid,
             current_user AS role,
             session_user AS session_role,
             current_setting('north_star.tenant_id') AS tenant_id,
             current_setting('north_star.environment_id') AS environment_id,
             current_setting('north_star.principal_id') AS principal_id
    `);
    const current = state.rows[0];
    assert.ok(current);
    return {
      backendPid: current.backend_pid,
      environmentId: current.environment_id,
      labels: rows.rows.map(({ label }) => label),
      principalId: current.principal_id,
      role: current.role,
      sessionRole: current.session_role,
      tenantId: current.tenant_id,
    };
  });
}

async function assertConnectionCleared(
  pool: pg.Pool,
  expectedBackendPid: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      backend_pid: number;
      environment_id: string | null;
      principal_id: string | null;
      request_id: string | null;
      role: string;
      session_role: string;
      tenant_id: string | null;
    }>(`
      SELECT pg_backend_pid() AS backend_pid,
             current_user AS role,
             session_user AS session_role,
             nullif(current_setting('north_star.tenant_id', true), '') AS tenant_id,
             nullif(current_setting('north_star.environment_id', true), '') AS environment_id,
             nullif(current_setting('north_star.principal_id', true), '') AS principal_id,
             nullif(current_setting('north_star.request_id', true), '') AS request_id
    `);
    assert.deepEqual(result.rows[0], {
      backend_pid: expectedBackendPid,
      environment_id: null,
      principal_id: null,
      request_id: null,
      role: 'north_star_runtime',
      session_role: 'north_star_runtime',
      tenant_id: null,
    });
  } finally {
    client.release();
  }
}

async function seedFixture(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO platform.tenants (id, slug)
     VALUES ($1, 'tenant-a'), ($2, 'tenant-b')`,
    [tenantA, tenantB],
  );
  await client.query(
    `INSERT INTO platform.environments (tenant_id, id, slug)
     VALUES ($1, $2, 'production'),
            ($1, $3, 'preview'),
            ($4, $5, 'production')`,
    [tenantA, environmentA, environmentA2, tenantB, environmentB],
  );
  await client.query(
    `INSERT INTO platform.tenant_fixture_records
       (tenant_id, environment_id, id, label)
     VALUES ($1, $2, $3, 'tenant-a'),
            ($1, $4, $5, 'tenant-a-preview'),
            ($6, $7, $8, 'tenant-b')`,
    [
      tenantA,
      environmentA,
      recordA,
      environmentA2,
      recordA2,
      tenantB,
      environmentB,
      recordB,
    ],
  );
}
