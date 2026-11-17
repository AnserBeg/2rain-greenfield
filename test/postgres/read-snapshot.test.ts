import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import {
  PostgresCurrentPolicyGateway,
  RECEIPT_AUTHORIZATION_DEPENDENCY_BINDINGS,
} from '../../packages/postgres-provider/src/current-policy.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import {
  ReadSnapshotIntegrityError,
  ReadSnapshotPolicyChangedError,
  withReadSnapshot,
  withTrustedRequestRead,
  withTrustedRequestTransaction,
} from '../../packages/postgres-provider/src/request-context.js';
import {
  meterPoolStatements,
  RequestWorkMeter,
  runWithRequestWorkMeter,
} from '../../packages/postgres-provider/src/request-work-meter.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  authorizeCurrentPolicy,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeProjectionFamily,
  type RuntimeProjection,
} from '../../packages/runtime/src/request-runtime-view.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

// SPEED-1 slice 2: one page's reads share one read-only REPEATABLE READ
// snapshot, and the guarantees around it hold: writes never join it, a policy
// change while it is held discards the page, a page never needs a second
// connection, and a failed read never poisons the reads after it.

const migrations = resolve('db/migrations');
const tenantId = 'b1000000-0000-4000-8000-000000000001';
const environmentId = 'b2000000-0000-4000-8000-000000000002';
const principalId = 'b3000000-0000-4000-8000-000000000003';
const otherPrincipalId = 'b3000000-0000-4000-8000-000000000004';
const roleId = 'b4000000-0000-4000-8000-000000000004';
const membershipId = 'b5000000-0000-4000-8000-000000000005';
const binding = RECEIPT_AUTHORIZATION_DEPENDENCY_BINDINGS.find(
  (candidate) =>
    candidate.permissionId === 'northstar.app:permission.goods_receipt_create',
)!;
const identity = Object.freeze({ environmentId, principalId, tenantId });

test('SPEED-1 read snapshot: one transaction per page, writes apart, policy changes discard the page', async () => {
  await withEphemeralPostgres(
    'read-snapshot',
    async ({ connection, pool: admin }) => {
      const migrationClient = await admin.connect();
      try {
        await runMigrations(migrationClient, await loadMigrations(migrations));
      } finally {
        migrationClient.release();
      }
      await seedPolicy(admin);
      // A table the runtime role may write, standing in for a denial row.
      await admin.query(
        `CREATE TABLE public.snapshot_probe (note text NOT NULL);
         GRANT SELECT, INSERT ON public.snapshot_probe TO north_star_runtime`,
      );
      const revoke = (revoked: boolean) =>
        admin.query(
          `UPDATE platform.current_policy_permission_grants
              SET revoked_at = ${revoked ? 'clock_timestamp()' : 'NULL'}
            WHERE tenant_id = $1 AND environment_id = $2
              AND role_id = $3 AND permission_id = $4`,
          [tenantId, environmentId, roleId, binding.permissionId],
        );

      // max 1: a page that needed a second connection would hang here.
      const runtime = meterPoolStatements(
        new pg.Pool({ ...connection, max: 1, user: 'north_star_runtime' }),
      );
      runtime.on('error', () => undefined);
      const policy = new PostgresCurrentPolicyGateway(
        runtime,
        RECEIPT_AUTHORIZATION_DEPENDENCY_BINDINGS,
      );
      const entry = requestEntry(identity, policy);
      const allows = async (
        view: Parameters<typeof authorizeCurrentPolicy>[1],
      ) =>
        (
          await authorizeCurrentPolicy(
            policy,
            view,
            binding.permissionId,
            Object.freeze({}),
          )
        ).decision;
      const page = <T>(work: (finish: () => Promise<void>) => Promise<T>) =>
        bounded(withReadSnapshot(runtime, work));
      try {
        // One page: the entry's epoch read and three decisions share one
        // snapshot; the live policy check after it is the second transaction.
        const meter = new RequestWorkMeter();
        const decisions = await runWithRequestWorkMeter(meter, () =>
          page(() =>
            entry.run({}, async (view) => [
              await allows(view),
              await allows(view),
              await allows(view),
            ]),
          ),
        );
        assert.deepEqual(decisions, ['ALLOW', 'ALLOW', 'ALLOW']);
        assert.equal(meter.counts().transactions, 2);

        // The snapshot is read-only REPEATABLE READ under the trusted
        // identity; a transaction of its own is neither.
        const context = await trustedContext(identity);
        const settings = await page(async () => {
          const joined = await withTrustedRequestRead(
            runtime,
            context,
            async (client) => (await client.query(settingsSql)).rows[0],
          );
          const own = await withTrustedRequestTransaction(
            runtime,
            context,
            async (client) => (await client.query(settingsSql)).rows[0],
          );
          return { joined, own };
        });
        assert.deepEqual(settings.joined, {
          isolation: 'repeatable read',
          principal: principalId,
          read_only: 'on',
        });
        assert.deepEqual(settings.own, {
          isolation: 'read committed',
          principal: principalId,
          read_only: 'off',
        });

        // A write sent through the read entry point fails at the database,
        // and the next read still succeeds on a fresh snapshot.
        const afterFailure = await page(async () => {
          await assert.rejects(
            withTrustedRequestRead(runtime, context, (client) =>
              client.query(`INSERT INTO public.snapshot_probe VALUES ('x')`),
            ),
            /read-only transaction/u,
          );
          return withTrustedRequestRead(
            runtime,
            context,
            async (client) =>
              (await client.query(settingsSql)).rows[0] as unknown,
          );
        });
        assert.deepEqual(afterFailure, {
          isolation: 'repeatable read',
          principal: principalId,
          read_only: 'on',
        });

        // A write of its own inside a page (a denial row) commits durably,
        // and the page's reads continue on one connection.
        await page(async () => {
          assert.equal(
            (await withTrustedRequestRead(runtime, context, readProbe)).length,
            0,
          );
          await withTrustedRequestTransaction(runtime, context, (client) =>
            client.query(`INSERT INTO public.snapshot_probe VALUES ('denial')`),
          );
          assert.equal(
            (await withTrustedRequestRead(runtime, context, readProbe)).length,
            1,
          );
        });
        assert.equal(
          (await admin.query(`SELECT note FROM public.snapshot_probe`)).rows
            .length,
          1,
        );

        // A joined read may not open a transaction of its own.
        await page(() =>
          assert.rejects(
            withTrustedRequestRead(runtime, context, () =>
              withTrustedRequestTransaction(runtime, context, async () => 1),
            ),
            ReadSnapshotIntegrityError,
          ),
        );

        // Another identity never reads under the open snapshot's settings.
        const other = await trustedContext({
          ...identity,
          principalId: otherPrincipalId,
        });
        const principals = await page(async () => [
          await withTrustedRequestRead(runtime, context, principalOf),
          await withTrustedRequestRead(runtime, other, principalOf),
        ]);
        assert.deepEqual(principals, [principalId, otherPrincipalId]);

        // Revoked mid-page: the frozen snapshot still allows, so the page is
        // discarded and assembled again under the live policy, which denies.
        let attempts = 0;
        const revokedMidPage = await page(() =>
          entry.run({}, async (view) => {
            attempts += 1;
            const before = await allows(view);
            if (attempts === 1) await revoke(true);
            return [before, await allows(view)];
          }),
        );
        assert.equal(attempts, 2);
        assert.deepEqual(revokedMidPage, ['DENY', 'DENY']);
        await revoke(false);

        // Changed during both attempts: the page is refused, never sent.
        let flips = 0;
        await assert.rejects(
          page(() =>
            entry.run({}, async (view) => {
              const decision = await allows(view);
              flips += 1;
              await revoke(flips % 2 === 1);
              return decision;
            }),
          ),
          ReadSnapshotPolicyChangedError,
        );
        assert.equal(flips, 2);
        await revoke(false);

        // Outside a page every read is live, as before.
        await entry.run({}, async (view) => {
          assert.equal(await allows(view), 'ALLOW');
          await revoke(true);
          assert.equal(await allows(view), 'DENY');
          await revoke(false);
        });
      } finally {
        await runtime.end();
      }
    },
  );
});

const settingsSql = `SELECT current_setting('transaction_isolation') AS isolation,
         current_setting('north_star.principal_id') AS principal,
         current_setting('transaction_read_only') AS read_only`;

const readProbe = async (client: pg.PoolClient) =>
  (await client.query(`SELECT note FROM public.snapshot_probe`)).rows;

const principalOf = async (client: pg.PoolClient) =>
  (
    await client.query<{ principal: string }>(
      `SELECT current_setting('north_star.principal_id') AS principal`,
    )
  ).rows[0]!.principal;

/** A hang (two connections from a pool of one) fails instead of waiting. */
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('the page waited for a second connection'));
        }, 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function seedPolicy(admin: pg.Pool): Promise<void> {
  await admin.query(
    `INSERT INTO platform.tenants (id, slug) VALUES ($1, 'read-snapshot')`,
    [tenantId],
  );
  await admin.query(
    `INSERT INTO platform.environments (tenant_id, id, slug)
     VALUES ($1, $2, 'production')`,
    [tenantId, environmentId],
  );
  await admin.query(
    `INSERT INTO platform.current_policy_roles (
       tenant_id, environment_id, role_id, role_key
     ) VALUES ($1,$2,$3,'reader')`,
    [tenantId, environmentId, roleId],
  );
  await admin.query(
    `INSERT INTO platform.current_policy_permission_grants (
       tenant_id, environment_id, role_id, permission_id, resource_id
     ) VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, environmentId, roleId, binding.permissionId, binding.resourceId],
  );
  await admin.query(
    `INSERT INTO platform.current_policy_memberships (
       tenant_id, environment_id, membership_id, principal_id, role_id
     ) VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, environmentId, membershipId, principalId, roleId],
  );
}

function trustedContext(
  value: AuthenticatedIdentity,
): Promise<TrustedRequestContext> {
  return new AuthenticatedRequestEntryAdapter(async () => value).enter({});
}

function requestEntry(
  value: AuthenticatedIdentity,
  policy: PostgresCurrentPolicyGateway,
): AuthenticatedRequestRuntimeEntryAdapter {
  return new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => value),
    Object.freeze({
      async load(): Promise<LoadedRequestRuntimeDefinition> {
        return loadedDefinition(value);
      },
    }),
    policy,
  );
}

function loadedDefinition(
  value: AuthenticatedIdentity,
): LoadedRequestRuntimeDefinition {
  const empty = Object.freeze([]) as readonly ImmutableJsonValue[];
  const family = REQUEST_RUNTIME_PROJECTION_FAMILIES;
  return {
    environmentId: value.environmentId,
    pointer: { fence: 1, pointerId: 'b7000000-0000-4000-8000-000000000007' },
    projections: {
      agent: projection(
        family.agent,
        'northstar.agent-discovery-payload/v0-provisional',
        {
          kind: 'agentDiscoveryPayload',
          operations: empty,
          queries: empty,
          schemaVersion: 'northstar.agent-discovery-payload/v0-provisional',
          surfaces: empty,
          toolIds: empty,
        },
      ),
      catalog: projection(
        family.catalog,
        'northstar.semantic-model-payload/v0-provisional',
        {
          constructs: empty,
          kind: 'semanticModelPayload',
          schemaVersion: 'northstar.semantic-model-payload/v0-provisional',
        },
      ),
      operation: projection(
        family.operation,
        'northstar.operation-catalog-payload/v0-provisional',
        {
          kind: 'operationCatalogPayload',
          operations: empty,
          schemaVersion: 'northstar.operation-catalog-payload/v0-provisional',
        },
      ),
      query: projection(
        family.query,
        'northstar.query-catalog-payload/v0-provisional',
        {
          kind: 'queryCatalogPayload',
          queries: empty,
          schemaVersion: 'northstar.query-catalog-payload/v0-provisional',
        },
      ),
      surface: projection(
        family.surface,
        'northstar.surface-manifest-payload/v0-provisional',
        {
          kind: 'surfaceManifestPayload',
          schemaVersion: 'northstar.surface-manifest-payload/v0-provisional',
          surfaces: empty,
        },
      ),
    },
    release: {
      contentHash: 'b'.repeat(64),
      releaseId: 'b8000000-0000-4000-8000-000000000008',
    },
    tenantId: value.tenantId,
  };
}

function projection<TFamily extends RequestRuntimeProjectionFamily>(
  familyId: TFamily,
  payloadSchemaVersion: string,
  payload: ImmutableJsonValue,
): RuntimeProjection<TFamily> {
  return {
    artifactRoot: 'c'.repeat(64),
    familyId,
    instanceId: `northstar.test:projection.${familyId.split('.').at(-1)}`,
    payload,
    payloadSchemaVersion,
    semanticDigest: 'd'.repeat(64),
  };
}
