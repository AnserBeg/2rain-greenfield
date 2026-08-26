import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import {
  InventoryPersistenceError,
  loadInventoryPostingConfiguration,
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const checkedInMigrations = resolve('db/migrations');
const contractReleaseRoot =
  'bd977ff0a00db745e79b7d8e158cb55863319f9f37f7674d77b618e85272d116';
const successorReleaseRoot =
  '4f2c1d0e9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d';
const thirdReleaseRoot =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const tenantA = 'a1000000-1000-4000-8000-000000000001';
const environmentA = 'a2000000-2000-4000-8000-000000000002';
const legalEntityA = 'a3000000-3000-4000-8000-000000000003';
const actorA = 'a4000000-4000-4000-8000-000000000004';
const tenantB = 'b1000000-1000-4000-8000-000000000001';
const environmentB = 'b2000000-2000-4000-8000-000000000002';
const legalEntityB = 'b3000000-3000-4000-8000-000000000003';
const actorB = 'b4000000-4000-4000-8000-000000000004';

test('inventory platform authority is limited to calendars and release-recorded configuration', async (t) => {
  await withEphemeralPostgres(
    'inventory-platform-authority',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      const runtimePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_runtime',
      });
      try {
        const migrations = await loadMigrations(checkedInMigrations);
        const migrated = await runMigrations(admin, migrations);
        assert.equal(
          migrated.applied.at(-1),
          '0022_module_storage_relation_requiredness_relaxation.sql',
        );
        assert.equal(migrated.verified.length, 22);
        await seedTenant(admin, tenantA, environmentA, 'tenant-a');
        await seedTenant(admin, tenantB, environmentB, 'tenant-b');
        await provision(
          admin,
          tenantA,
          environmentA,
          legalEntityA,
          'LE-A',
          'America/Edmonton',
          '06:00:00',
        );
        await provision(
          admin,
          tenantB,
          environmentB,
          legalEntityB,
          'LE-B',
          'America/Toronto',
          '04:00:00',
        );

        await t.test(
          'migration owns exactly two inventory platform tables',
          async () => {
            const relations = await admin.query<{ relation: string }>(
              `SELECT relation.relname AS relation
               FROM pg_class AS relation
               JOIN pg_namespace AS namespace
                 ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = 'platform'
                AND relation.relname LIKE 'inventory_%'
                AND relation.relkind IN ('r', 'p')
              ORDER BY relation.relname`,
            );
            assert.deepEqual(relations.rows, [
              { relation: 'inventory_posting_configurations' },
              { relation: 'inventory_tenant_calendars' },
            ]);
            const managedRelations = await admin.query<{ count: string }>(
              `SELECT count(*)::text AS count
               FROM pg_class AS relation
               JOIN pg_namespace AS namespace
                 ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = 'north_star_module'
                AND relation.relkind IN ('r', 'p')`,
            );
            assert.equal(managedRelations.rows[0]?.count, '0');
          },
        );

        await t.test(
          'configuration is typed, release-recorded, and has no ambient default',
          async () => {
            const configuration = await loadInventoryPostingConfiguration(
              admin,
              {
                environmentId: environmentA,
                legalEntityId: legalEntityA,
                tenantId: tenantA,
              },
            );
            assert.deepEqual(configuration, {
              approvalThresholds: {
                adjustment: '100',
                transfer: null,
                count: '250.5',
                correction: '10',
                reBaseline: '1000',
              },
              contractReleaseRoot,
              maximumBackdateDays: 31,
              negativeStock: 'allowWithFlag',
              reasonRequirements: {
                adjustment: 'codeOnly',
                transfer: 'codeAndNarrative',
                count: 'codeAndNarrative',
                correction: 'codeOnly',
                reBaseline: 'codeOnly',
              },
              revision: '1',
              version: 1,
            });
            await assert.rejects(
              loadInventoryPostingConfiguration(admin, {
                environmentId: environmentA,
                legalEntityId: randomUUID(),
                tenantId: tenantA,
              }),
              (error: unknown) =>
                error instanceof InventoryPersistenceError &&
                error.code === 'INVENTORY_POSTING_CONFIGURATION_UNDECLARED',
            );
            await assert.rejects(
              provision(
                admin,
                tenantA,
                environmentA,
                legalEntityA,
                'LE-A',
                'America/Edmonton',
                '06:00:00',
                { negativeStock: 'allow' },
              ),
              (error: unknown) =>
                error instanceof Error &&
                (error as Error & { code?: string }).code === 'P0001' &&
                error.message === 'INVENTORY_POSTING_CONFIGURATION_CONFLICT',
            );
            await assert.rejects(
              admin.query(
                `INSERT INTO platform.inventory_posting_configurations (
                   tenant_id, environment_id, legal_entity_id,
                   contract_release_root
                 ) VALUES ($1, $2, $3, $4)`,
                [tenantA, environmentA, randomUUID(), contractReleaseRoot],
              ),
              hasPostgresCode('23502'),
            );
            await assert.rejects(
              admin.query(
                `UPDATE platform.inventory_posting_configurations
                  SET negative_stock = 'ambientDefault'
                WHERE tenant_id = $1 AND environment_id = $2
                  AND legal_entity_id = $3`,
                [tenantA, environmentA, legalEntityA],
              ),
              hasPostgresCode('23514'),
            );
          },
        );

        await t.test(
          'release provenance advances while policy stays assert-identical',
          async () => {
            const storedRoot = async (): Promise<string | undefined> => {
              const row = await admin.query<{ root: string }>(
                `SELECT contract_release_root AS root
                   FROM platform.inventory_posting_configurations
                  WHERE tenant_id = $1 AND environment_id = $2
                    AND legal_entity_id = $3`,
                [tenantA, environmentA, legalEntityA],
              );
              return row.rows[0]?.root;
            };
            assert.equal(await storedRoot(), contractReleaseRoot);

            // Provenance, not policy: an already-provisioned tenant advancing
            // to a newly compiled contract must succeed, and the stored row
            // must actually carry the new root. Reading the stored value back
            // and re-requesting it would satisfy "no throw" while leaving the
            // row stale, so the row itself is the assertion.
            await provision(
              admin,
              tenantA,
              environmentA,
              legalEntityA,
              'LE-A',
              'America/Edmonton',
              '06:00:00',
              { releaseRoot: successorReleaseRoot },
            );
            assert.equal(await storedRoot(), successorReleaseRoot);

            // Policy drift under a further-advanced root still conflicts, and
            // the failed call advances nothing: the update path is confined to
            // provenance.
            for (const drift of [
              { negativeStock: 'allow' as const },
              { countApprovalThreshold: '999.5' },
            ]) {
              await assert.rejects(
                provision(
                  admin,
                  tenantA,
                  environmentA,
                  legalEntityA,
                  'LE-A',
                  'America/Edmonton',
                  '06:00:00',
                  { ...drift, releaseRoot: thirdReleaseRoot },
                ),
                (error: unknown) =>
                  error instanceof Error &&
                  (error as Error & { code?: string }).code === 'P0001' &&
                  error.message === 'INVENTORY_POSTING_CONFIGURATION_CONFLICT',
              );
              assert.equal(await storedRoot(), successorReleaseRoot);
            }

            // The requested root is still format-validated.
            await assert.rejects(
              provision(
                admin,
                tenantA,
                environmentA,
                legalEntityA,
                'LE-A',
                'America/Edmonton',
                '06:00:00',
                { releaseRoot: 'not-a-release-root' },
              ),
              (error: unknown) =>
                error instanceof Error &&
                (error as Error & { code?: string }).code === 'P0001' &&
                error.message === 'INVENTORY_PROVISIONING_INPUT_INVALID',
            );
            assert.equal(await storedRoot(), successorReleaseRoot);

            // Restore the provisioned root so later subtests read the value
            // the rest of this file was written against.
            await provision(
              admin,
              tenantA,
              environmentA,
              legalEntityA,
              'LE-A',
              'America/Edmonton',
              '06:00:00',
            );
            assert.equal(await storedRoot(), contractReleaseRoot);
          },
        );

        await t.test(
          'calendar derives the tenant business period without a UTC fallback',
          async () => {
            const periods = await admin.query<{
              period_a: string;
              period_b: string;
            }>(
              `SELECT
               north_star_internal.inventory_business_period(
                 $1, '2026-07-29T09:00:00.000Z'
               )::text AS period_a,
               north_star_internal.inventory_business_period(
                 $2, '2026-07-29T09:00:00.000Z'
               )::text AS period_b`,
              [tenantA, tenantB],
            );
            assert.deepEqual(periods.rows, [
              { period_a: '2026-07-28', period_b: '2026-07-29' },
            ]);

            const tenant = randomUUID();
            const environment = randomUUID();
            await seedTenant(admin, tenant, environment, 'invalid-zone');
            await assert.rejects(
              provision(
                admin,
                tenant,
                environment,
                randomUUID(),
                'LE-X',
                'Mars/Olympus_Mons',
                '00:00:00',
              ),
              (error: unknown) =>
                error instanceof Error &&
                (error as Error & { code?: string }).code === 'P0001' &&
                error.message === 'INVENTORY_TENANT_TIME_ZONE_UNKNOWN',
            );
          },
        );

        await t.test(
          'runtime reads are tenant-scoped and forged calendar scope fails closed',
          async () => {
            assert.deepEqual(
              await readRuntimeConfiguration(runtimePool, {
                actorId: actorA,
                environmentId: environmentA,
                tenantId: tenantA,
              }),
              [legalEntityA],
            );
            assert.deepEqual(
              await readRuntimeConfiguration(runtimePool, {
                actorId: actorB,
                environmentId: environmentB,
                tenantId: tenantB,
              }),
              [legalEntityB],
            );
            await assertTrustedScopeRejected(runtimePool);
          },
        );
      } finally {
        admin.release();
        await runtimePool.end();
      }
    },
  );
});

async function seedTenant(
  client: pg.PoolClient,
  tenantId: string,
  environmentId: string,
  slug: string,
): Promise<void> {
  await client.query(
    'INSERT INTO platform.tenants (id, slug) VALUES ($1, $2)',
    [tenantId, slug],
  );
  await client.query(
    `INSERT INTO platform.environments (tenant_id, id, slug)
     VALUES ($1, $2, 'production')`,
    [tenantId, environmentId],
  );
}

async function provision(
  client: pg.PoolClient,
  tenantId: string,
  environmentId: string,
  legalEntityId: string,
  entityCode: string,
  timeZone: string,
  boundary: string,
  overrides: {
    countApprovalThreshold?: string | null;
    negativeStock?: 'allow' | 'allowWithFlag' | 'reject';
    releaseRoot?: string;
  } = {},
): Promise<void> {
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
      entityCode,
      `${entityCode} Legal Entity`,
      timeZone,
      boundary,
      overrides.releaseRoot ?? contractReleaseRoot,
      1,
      overrides.negativeStock ??
        (entityCode === 'LE-A' ? 'allowWithFlag' : 'reject'),
      entityCode === 'LE-A' ? 31 : 0,
      'codeOnly',
      entityCode === 'LE-A' ? 'codeAndNarrative' : 'codeOnly',
      'codeAndNarrative',
      'codeOnly',
      'codeOnly',
      entityCode === 'LE-A' ? '100' : null,
      null,
      overrides.countApprovalThreshold !== undefined
        ? overrides.countApprovalThreshold
        : entityCode === 'LE-A'
          ? '250.5'
          : null,
      entityCode === 'LE-A' ? '10' : null,
      entityCode === 'LE-A' ? '1000' : null,
    ],
  );
}

async function readRuntimeConfiguration(
  pool: pg.Pool,
  scope: { actorId: string; environmentId: string; tenantId: string },
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('north_star.tenant_id', $1, true),
              set_config('north_star.environment_id', $2, true),
              set_config('north_star.principal_id', $3, true)`,
      [scope.tenantId, scope.environmentId, scope.actorId],
    );
    const rows = await client.query<{ legal_entity_id: string }>(
      `SELECT legal_entity_id
         FROM platform.inventory_posting_configurations
        ORDER BY legal_entity_id`,
    );
    await client.query('COMMIT');
    return rows.rows.map(({ legal_entity_id }) => legal_entity_id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function assertTrustedScopeRejected(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('north_star.tenant_id', $1, true),
              set_config('north_star.environment_id', $2, true),
              set_config('north_star.principal_id', $3, true)`,
      [tenantA, environmentA, actorA],
    );
    await assert.rejects(
      client.query(
        `SELECT north_star_internal.inventory_business_period(
           $1, '2026-07-29T12:00:00.000Z'
         )`,
        [tenantB],
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === 'P0001' &&
        error.message === 'INVENTORY_TRUSTED_SCOPE_MISMATCH',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

function hasPostgresCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    (error as Error & { code?: string }).code === code;
}
