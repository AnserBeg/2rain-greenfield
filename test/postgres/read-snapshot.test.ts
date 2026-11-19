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
  ReadSnapshotScopeError,
  withoutReadSnapshot,
  withReadSnapshot,
  withTrustedRequestRead,
  withTrustedRequestTransaction,
  type ReadSnapshotHandle,
  type SnapshotRoleSwitch,
} from '../../packages/postgres-provider/src/request-context.js';
import {
  ReleaseRoutingOperationGateway,
  ReleaseRoutingQueryGateway,
  releaseServingRoute,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import {
  assertScopePolicyCurrent,
  identicalReadKey,
  MODULE_RUNTIME_READ_ROLE,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { SemanticOperationMediationAuthority } from '../../packages/runtime/src/semantic-operation-gateway.js';
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
const scopedMembershipId = 'b5000000-0000-4000-8000-000000000006';
const legalEntityId = 'b6000000-0000-4000-8000-000000000006';
const foreignLegalEntityId = 'b6000000-0000-4000-8000-000000000007';
const binding = RECEIPT_AUTHORIZATION_DEPENDENCY_BINDINGS.find(
  (candidate) =>
    candidate.permissionId === 'northstar.app:permission.goods_receipt_create',
)!;
const identity = Object.freeze({ environmentId, principalId, tenantId });
const otherEnvironmentId = 'b2000000-0000-4000-8000-000000000003';

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
      /** A page's read decision: reusable within the page's snapshot. */
      const allows = async (
        view: Parameters<typeof authorizeCurrentPolicy>[1],
        legalEntityId?: string,
      ) =>
        (
          await authorizeCurrentPolicy(
            policy,
            view,
            binding.permissionId,
            Object.freeze({
              kind: 'semanticQueryPolicyInput',
              ...(legalEntityId ? { input: { legalEntityId } } : {}),
            }),
          )
        ).decision;
      /** An invocation's decision: live per call, never from the snapshot. */
      const invokes = async (
        view: Parameters<typeof authorizeCurrentPolicy>[1],
      ) =>
        (
          await authorizeCurrentPolicy(
            policy,
            view,
            binding.permissionId,
            Object.freeze({ kind: 'semanticOperationPolicyInput' }),
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
        // The snapshot's epoch, its one grants read, the live epoch after.
        assert.deepEqual(
          [meter.counts().transactions, meter.counts().authorization],
          [2, 3],
        );

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

        // An invocation's decision inside a page is live: a revocation is seen
        // at once, while the page's read decisions keep the snapshot's (and
        // the page itself is then discarded).
        const invoked: string[] = [];
        await assert.rejects(
          page(() =>
            entry.run({}, async (view) => {
              const read = await allows(view);
              await admin.query(
                `UPDATE platform.current_policy_roles
                    SET revoked_at = clock_timestamp()
                  WHERE tenant_id = $1 AND environment_id = $2 AND role_id = $3`,
                [tenantId, environmentId, roleId],
              );
              invoked.push(`${read}/${await invokes(view)}`);
            }),
          ),
          ReadSnapshotPolicyChangedError,
        );
        assert.equal(invoked[0], 'ALLOW/DENY');

        // Revoked role, revoked membership: a fresh page's snapshot denies.
        assert.equal(
          await page(() => entry.run({}, (view) => allows(view))),
          'DENY',
        );
        await admin.query(
          `UPDATE platform.current_policy_roles SET revoked_at = NULL
            WHERE tenant_id = $1 AND environment_id = $2 AND role_id = $3`,
          [tenantId, environmentId, roleId],
        );
        await admin.query(
          `UPDATE platform.current_policy_memberships SET revoked_at = clock_timestamp()
            WHERE tenant_id = $1 AND environment_id = $2 AND membership_id = $3`,
          [tenantId, environmentId, membershipId],
        );
        assert.equal(
          await page(() => entry.run({}, (view) => allows(view))),
          'DENY',
        );

        // A membership scoped to one company admits that company only.
        await admin.query(
          `INSERT INTO platform.current_policy_memberships (
             tenant_id, environment_id, membership_id, principal_id, role_id,
             legal_entity_id
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            tenantId,
            environmentId,
            scopedMembershipId,
            principalId,
            roleId,
            legalEntityId,
          ],
        );
        assert.deepEqual(
          await page(() =>
            entry.run({}, async (view) => [
              await allows(view, legalEntityId),
              await allows(view, foreignLegalEntityId),
              await allows(view),
            ]),
          ),
          ['ALLOW', 'DENY', 'DENY'],
        );
        await admin.query(
          `UPDATE platform.current_policy_memberships SET revoked_at = NULL
            WHERE tenant_id = $1 AND environment_id = $2 AND membership_id = $3`,
          [tenantId, environmentId, membershipId],
        );

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

test('SPEED-1 security fixes: one scope per page, both scopes of a moved grant, denials after the reads, one connection per request, invocations live', async () => {
  await withEphemeralPostgres(
    'read-snapshot-fixes',
    async ({ connection, pool: admin }) => {
      const migrationClient = await admin.connect();
      try {
        await runMigrations(migrationClient, await loadMigrations(migrations));
      } finally {
        migrationClient.release();
      }
      await seedPolicy(admin);
      // A second environment of the tenant, with the same role id.
      await admin.query(
        `INSERT INTO platform.environments (tenant_id, id, slug)
         VALUES ($1, $2, 'staging')`,
        [tenantId, otherEnvironmentId],
      );
      await admin.query(
        `INSERT INTO platform.current_policy_roles (
           tenant_id, environment_id, role_id, role_key
         ) VALUES ($1,$2,$3,'reader')`,
        [tenantId, otherEnvironmentId, roleId],
      );
      await admin.query(
        `CREATE TABLE public.snapshot_probe (note text NOT NULL);
         GRANT SELECT, INSERT ON public.snapshot_probe TO north_star_runtime`,
      );
      const runtime = meterPoolStatements(
        new pg.Pool({ ...connection, max: 2, user: 'north_star_runtime' }),
      );
      runtime.on('error', () => undefined);
      const policy = new PostgresCurrentPolicyGateway(
        runtime,
        RECEIPT_AUTHORIZATION_DEPENDENCY_BINDINGS,
      );
      const entry = requestEntry(identity, policy);
      const decide = async (
        view: Parameters<typeof authorizeCurrentPolicy>[1],
      ) =>
        (
          await authorizeCurrentPolicy(
            policy,
            view,
            binding.permissionId,
            Object.freeze({ kind: 'semanticQueryPolicyInput' }),
          )
        ).decision;
      const page = <T>(
        work: (finish: () => Promise<void>) => Promise<T>,
        options?: { retry?: boolean },
      ) => bounded(withReadSnapshot(runtime, work, options));
      const context = await trustedContext(identity);
      try {
        // S4: a page reads one tenant and environment.
        const elsewhere = await trustedContext({
          ...identity,
          environmentId: otherEnvironmentId,
        });
        await assert.rejects(
          page(async () => {
            await withTrustedRequestRead(runtime, context, principalOf);
            await withTrustedRequestRead(runtime, elsewhere, principalOf);
          }),
          ReadSnapshotScopeError,
        );

        // S3: moving the membership from this environment to another bumps
        // this environment's epoch too, so the page holding its grants is
        // discarded and assembled again, now denied.
        const epochOf = async (environment: string) =>
          Number(
            (
              await admin.query<{ v: string }>(
                `SELECT policy_version::text AS v
                   FROM platform.current_policy_epochs
                  WHERE tenant_id = $1 AND environment_id = $2`,
                [tenantId, environment],
              )
            ).rows[0]?.v ?? 0,
          );
        const destinationBefore = await epochOf(otherEnvironmentId);
        let moved = false;
        const afterMove = await page(() =>
          entry.run({}, async (view) => {
            const before = await decide(view);
            if (!moved) {
              moved = true;
              await admin.query(
                `UPDATE platform.current_policy_memberships
                    SET environment_id = $3
                  WHERE tenant_id = $1 AND environment_id = $2
                    AND membership_id = $4`,
                [tenantId, environmentId, otherEnvironmentId, membershipId],
              );
            }
            return [before, await decide(view)];
          }),
        );
        assert.deepEqual(afterMove, ['DENY', 'DENY']);
        // ...and the destination's epoch too: authority arrived there.
        assert.equal(await epochOf(otherEnvironmentId), destinationBefore + 1);
        await admin.query(
          `UPDATE platform.current_policy_memberships SET environment_id = $2
            WHERE tenant_id = $1 AND membership_id = $3`,
          [tenantId, environmentId, membershipId],
        );

        // Fix read 5 (S3): two opposite moves bump the two scopes' epochs in
        // one canonical order, so neither holds one epoch while waiting for
        // the other's. A third session holds the destination's epoch so the
        // two moves queue: the first (B to A) waits for it, the second (A to
        // B) behind; when it is released, both commit. Bumped OLD first, the
        // first holds B and waits for A, which the second holds: 40P01.
        const [scopeA, scopeB] = [environmentId, otherEnvironmentId].sort() as [
          string,
          string,
        ];
        assert.equal(scopeA, environmentId, 'the seeded membership is in A');
        await admin.query(
          `INSERT INTO platform.current_policy_epochs (
             tenant_id, environment_id, policy_version
           ) VALUES ($1, $2, 1), ($1, $3, 1)
           ON CONFLICT (tenant_id, environment_id) DO NOTHING`,
          [tenantId, scopeA, scopeB],
        );
        const otherMembershipId = 'b5000000-0000-4000-8000-0000000000b5';
        await admin.query(
          `INSERT INTO platform.current_policy_memberships (
             tenant_id, environment_id, membership_id, principal_id, role_id
           ) VALUES ($1, $2, $3, 'b3000000-0000-4000-8000-0000000000b3', $4)`,
          [tenantId, scopeB, otherMembershipId, roleId],
        );
        const [holder, first, second] = await Promise.all([
          admin.connect(),
          admin.connect(),
          admin.connect(),
        ]);
        const waiting = async (client: pg.PoolClient) => {
          const pid = (
            await client.query<{ pid: number }>(
              `SELECT pg_backend_pid() AS pid`,
            )
          ).rows[0]!.pid;
          return async () => {
            for (let attempt = 0; attempt < 400; attempt += 1) {
              const row = await admin.query<{ w: string | null }>(
                `SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1`,
                [pid],
              );
              if (row.rows[0]?.w === 'Lock') return;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error(`backend ${String(pid)} never waited`);
          };
        };
        const move = (
          client: pg.PoolClient,
          membership: string,
          from: string,
          to: string,
        ) =>
          client.query(
            `UPDATE platform.current_policy_memberships SET environment_id = $3
              WHERE tenant_id = $1 AND environment_id = $2
                AND membership_id = $4`,
            [tenantId, from, to, membership],
          );
        const firstWaits = await waiting(first);
        const secondWaits = await waiting(second);
        try {
          await holder.query('BEGIN');
          await holder.query(
            `SELECT 1 FROM platform.current_policy_epochs
              WHERE tenant_id = $1 AND environment_id = $2 FOR UPDATE`,
            [tenantId, scopeB],
          );
          await first.query('BEGIN');
          await second.query('BEGIN');
          const firstMove = move(first, otherMembershipId, scopeB, scopeA);
          firstMove.catch(() => undefined);
          await firstWaits();
          const secondMove = move(second, membershipId, scopeA, scopeB);
          secondMove.catch(() => undefined);
          await secondWaits();
          await holder.query('COMMIT');
          const outcome = async (
            client: pg.PoolClient,
            statement: Promise<unknown>,
          ) => {
            try {
              await statement;
              await client.query('COMMIT');
              return 'moved';
            } catch (error) {
              return String((error as { code?: string }).code);
            }
          };
          assert.deepEqual(
            [
              await outcome(first, firstMove),
              await outcome(second, secondMove),
            ],
            ['moved', 'moved'],
          );
        } finally {
          for (const client of [holder, first, second]) {
            await client.query('ROLLBACK').catch(() => undefined);
            client.release();
          }
        }
        // Back where they were.
        await admin.query(
          `UPDATE platform.current_policy_memberships SET environment_id = $2
            WHERE tenant_id = $1 AND membership_id = $3`,
          [tenantId, environmentId, membershipId],
        );
        await admin.query(
          `DELETE FROM platform.current_policy_memberships
            WHERE tenant_id = $1 AND membership_id = $2`,
          [tenantId, otherMembershipId],
        );

        // ADR-0071 (amended): a task step's snapshot is READ ONLY too, so a
        // write attempted inside it fails; writes go through the live
        // invocation path, outside the snapshot.
        await assert.rejects(
          page(
            () =>
              withTrustedRequestRead(runtime, context, (client) =>
                client.query(
                  `INSERT INTO public.snapshot_probe VALUES ('in snapshot')`,
                ),
              ),
            { retry: false },
          ),
          (error: unknown) => (error as { code?: unknown }).code === '25006',
        );
        assert.equal(
          (
            await admin.query(
              `SELECT 1 FROM public.snapshot_probe WHERE note = 'in snapshot'`,
            )
          ).rowCount,
          0,
        );

        // retry: false refuses at once.
        let tries = 0;
        await assert.rejects(
          page(
            () =>
              entry.run({}, async (view) => {
                tries += 1;
                await decide(view);
                await admin.query(
                  `UPDATE platform.current_policy_roles SET role_key = role_key
                    WHERE tenant_id = $1 AND environment_id = $2`,
                  [tenantId, environmentId],
                );
              }),
            { retry: false },
          ),
          ReadSnapshotPolicyChangedError,
        );
        assert.equal(tries, 1);

        // S8: parallel reads beside a write of its own never need a second
        // connection: two pages, a pool of two, each page's write in parallel
        // with its reads.
        const busy = () =>
          page(() =>
            Promise.all([
              withTrustedRequestRead(runtime, context, principalOf),
              withTrustedRequestTransaction(runtime, context, (client) =>
                client.query(`INSERT INTO public.snapshot_probe VALUES ('w')`),
              ),
              withTrustedRequestRead(runtime, context, principalOf),
              withTrustedRequestRead(runtime, context, principalOf),
            ]),
          );
        await Promise.all([busy(), busy()]);

        // S1: work outside the snapshot decides live: a reusable decision
        // after a revocation denies, though the page's grants still allow.
        const observed: string[][] = [];
        await page(() =>
          entry.run({}, async (view) => {
            const read = await decide(view);
            await admin.query(
              `UPDATE platform.current_policy_permission_grants
                  SET revoked_at = clock_timestamp()
                WHERE tenant_id = $1 AND environment_id = $2
                  AND permission_id = $3`,
              [tenantId, environmentId, binding.permissionId],
            );
            observed.push([
              read,
              await withoutReadSnapshot(() => decide(view)),
            ]);
          }),
        ).catch(() => undefined);
        assert.deepEqual(observed[0], ['ALLOW', 'DENY']);
        await admin.query(
          `UPDATE platform.current_policy_permission_grants SET revoked_at = NULL
            WHERE tenant_id = $1 AND environment_id = $2 AND permission_id = $3`,
          [tenantId, environmentId, binding.permissionId],
        );
        const insideInvoke: (string | null)[] = [];
        const route = () =>
          Object.freeze({
            operationGateway: {
              invoke: async () => {
                insideInvoke.push(
                  await withTrustedRequestRead(
                    runtime,
                    context,
                    async (_c, held) => (held === null ? 'live' : 'snapshot'),
                  ),
                );
                return {} as never;
              },
            },
            policy,
            queryGateway: {},
          }) as never;
        const operations = new ReleaseRoutingOperationGateway(
          route,
          policy,
          new SemanticOperationMediationAuthority(),
        );
        await page(async () => {
          await withTrustedRequestRead(runtime, context, principalOf);
          await operations.invoke(
            { release: { releaseId: 'r' } } as never,
            {} as never,
            {} as never,
          );
        });
        assert.deepEqual(insideInvoke, ['live']);

        // S9: a release still loading is awaited outside the snapshot: with
        // one connection left, the loader (another request) gets it.
        let release!: () => void;
        const loader = new Promise<void>((resolve) => {
          release = resolve;
        }).then(() =>
          withTrustedRequestTransaction(
            runtime,
            context,
            async () => undefined,
          ),
        );
        const pending = loader.then(() =>
          Object.freeze({
            operationGateway: {},
            policy,
            queryGateway: { invoke: async () => 'answered' },
          }),
        );
        const queries = new ReleaseRoutingQueryGateway(
          () => pending as never,
          policy,
        );
        const blocker = await runtime.connect();
        try {
          const answer = page(async () => {
            await withTrustedRequestRead(runtime, context, principalOf);
            release();
            return queries.invoke(
              { release: { releaseId: 'r' } } as never,
              {} as never,
            );
          });
          assert.equal(await answer, 'answered');
        } finally {
          blocker.release();
        }

        // Fix read 4: an invocation and a sibling read of one cold release in
        // one page, the invocation first, the release's real route loading it
        // (with a connection of its own) while the page holds the other.
        const coldRoute = releaseServingRoute(
          async () => {
            await withTrustedRequestTransaction(runtime, context, (client) =>
              client.query(`SELECT 1`),
            );
            return 'loaded';
          },
          () =>
            Object.freeze({
              operationGateway: {
                invoke: async () => 'invoked' as never,
              },
              policy,
              queryGateway: { invoke: async () => 'answered' },
            }) as never,
        );
        const coldOperations = new ReleaseRoutingOperationGateway(
          coldRoute as never,
          policy,
          new SemanticOperationMediationAuthority(),
        );
        const coldQueries = new ReleaseRoutingQueryGateway(
          coldRoute as never,
          policy,
        );
        const cold = { release: { releaseId: 'cold' } } as never;
        const occupied = await runtime.connect();
        try {
          assert.deepEqual(
            await page(async () => {
              await withTrustedRequestRead(runtime, context, principalOf);
              return Promise.all([
                coldOperations.invoke(cold, {} as never, {} as never),
                coldQueries.invoke(cold, {} as never),
              ]);
            }),
            ['invoked', 'answered'],
          );
        } finally {
          occupied.release();
        }

        // Fix read 2: the anchor's epoch lock is scope-checked, and a policy
        // change waits behind a transaction holding it.
        await assert.rejects(
          withTrustedRequestTransaction(runtime, context, (client) =>
            client.query(`SELECT platform.lock_current_policy_epoch($1, $2)`, [
              tenantId,
              otherEnvironmentId,
            ]),
          ),
          /trusted session scope/u,
        );
        await assert.rejects(
          withTrustedRequestTransaction(runtime, context, async (client) => {
            await client.query(
              "SELECT set_config('north_star.principal_id', '', true)",
            );
            await client.query(
              'SELECT platform.lock_current_policy_epoch($1, $2)',
              [tenantId, environmentId],
            );
          }),
          { code: '42501' },
          'epoch lock requires a principal',
        );
        const epochNow = async () =>
          `northstar.current-policy/${String(await epochOf(environmentId))}`;
        let revoked = false;
        let revocation: Promise<unknown> | undefined;
        await withTrustedRequestTransaction(
          runtime,
          context,
          async (client) => {
            await assertScopePolicyCurrent(client, {
              context,
              definition: { queryId: 'northstar.test:query.x' },
              legalEntityReadScope: { policyVersion: await epochNow() },
            } as never);
            revocation = admin
              .query(
                `UPDATE platform.current_policy_roles SET role_key = role_key
                WHERE tenant_id = $1 AND environment_id = $2`,
                [tenantId, environmentId],
              )
              .then(() => {
                revoked = true;
              });
            await new Promise((resolve) => setTimeout(resolve, 750));
            // Still waiting: the anchor transaction holds the epoch row.
            assert.equal(revoked, false);
          },
        );
        await revocation;
        assert.equal(revoked, true);

        // Module role: a module read runs as the module role, verified the
        // first time each way; a runtime read after it runs as the login role.
        const verified: string[] = [];
        const spy: SnapshotRoleSwitch = {
          async assume(client, verify) {
            verified.push(`assume:${String(verify)}`);
            await MODULE_RUNTIME_READ_ROLE.assume(client, verify);
          },
          async restore(client, verify) {
            verified.push(`restore:${String(verify)}`);
            await MODULE_RUNTIME_READ_ROLE.restore(client, verify);
          },
        };
        const whoAmI = async (client: pg.PoolClient) =>
          (await client.query<{ who: string }>(`SELECT current_user AS who`))
            .rows[0]!.who;
        const roles = await page(async () => [
          await withTrustedRequestRead(runtime, context, whoAmI, spy),
          await withTrustedRequestRead(runtime, context, whoAmI),
          await withTrustedRequestRead(runtime, context, whoAmI, spy),
          await withTrustedRequestRead(runtime, context, whoAmI),
        ]);
        assert.deepEqual(roles, [
          'north_star_module_runtime',
          'north_star_runtime',
          'north_star_module_runtime',
          'north_star_runtime',
        ]);
        assert.deepEqual(verified, [
          'assume:true',
          'restore:true',
          'assume:false',
          'restore:false',
        ]);

        // A memo lives as long as one snapshot: after a write ends it, the
        // next snapshot loads again.
        let loads = 0;
        await page(async () => {
          const memoised = (
            client: pg.PoolClient,
            held: ReadSnapshotHandle | null,
          ) =>
            held!.memo('k', async () => {
              loads += 1;
              return principalOf(client);
            });
          await withTrustedRequestRead(runtime, context, memoised);
          await withTrustedRequestRead(runtime, context, memoised);
          await withTrustedRequestTransaction(
            runtime,
            context,
            async () => undefined,
          );
          await withTrustedRequestRead(runtime, context, memoised);
        });
        assert.equal(loads, 2);

        // After a failed read the connection returns clean: no role, no identity.
        await page(async () => {
          await assert.rejects(
            withTrustedRequestRead(runtime, context, (client) =>
              client.query(`SELECT 1/0`),
            ),
          );
        });
        const clean = await runtime.connect();
        try {
          assert.deepEqual(
            (
              await clean.query<{ who: string; principal: string | null }>(
                `SELECT current_user AS who,
                        nullif(current_setting('north_star.principal_id', true), '') AS principal`,
              )
            ).rows[0],
            { principal: null, who: 'north_star_runtime' },
          );
        } finally {
          clean.release();
        }

        // S5: a scoped read's anchor transaction refuses a moved epoch.
        const scoped = (version: string) =>
          ({
            context,
            definition: { queryId: 'northstar.test:query.x' },
            legalEntityReadScope: { policyVersion: version },
          }) as never;
        const current = await withTrustedRequestTransaction(
          runtime,
          context,
          (client) =>
            client.query<{ v: string }>(
              `SELECT policy_version::text AS v FROM platform.current_policy_epochs
              WHERE tenant_id = $1 AND environment_id = $2`,
              [tenantId, environmentId],
            ),
        );
        const now = `northstar.current-policy/${current.rows[0]!.v}`;
        await withTrustedRequestTransaction(runtime, context, (client) =>
          assertScopePolicyCurrent(client, scoped(now)),
        );
        // A version another policy gateway issued names no epoch here.
        await withTrustedRequestTransaction(runtime, context, (client) =>
          assertScopePolicyCurrent(client, scoped('a-test-policy/v1')),
        );
        await assert.rejects(
          withTrustedRequestTransaction(runtime, context, (client) =>
            assertScopePolicyCurrent(
              client,
              scoped('northstar.current-policy/1'),
            ),
          ),
          /MODULE_READ_SCOPE_POLICY_CHANGED|policy changed after this read/u,
        );
      } finally {
        await runtime.end();
      }
    },
  );
});

test('SPEED-1 identical-read keys: release, query, arguments, plans and company scope each separate two reads', () => {
  const base = {
    arguments: { recordId: 'a' },
    definition: { queryId: 'q' },
    filterPlans: [],
    legalEntityReadScope: { legalEntityIds: ['c1'] },
    list: null,
    parameterValues: {},
    view: { release: { contentHash: 'h', releaseId: 'r' } },
  };
  const key = (change: object) =>
    identicalReadKey({ ...base, ...change } as never);
  const keys = [
    key({}),
    key({ view: { release: { contentHash: 'h', releaseId: 'r2' } } }),
    key({ view: { release: { contentHash: 'h2', releaseId: 'r' } } }),
    key({ definition: { queryId: 'q2' } }),
    key({ arguments: { recordId: 'b' } }),
    key({ legalEntityReadScope: { legalEntityIds: ['c2'] } }),
    key({ legalEntityReadScope: null }),
    key({ list: { cursor: 'x' } }),
    key({ parameterValues: { p: 1 } }),
  ];
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(key({}), keys[0]);
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
