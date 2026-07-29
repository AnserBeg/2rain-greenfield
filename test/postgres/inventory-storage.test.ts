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
  'c65517349623a30f3ddce75e57dca0af404646e82f27e73ce0b6586b4c1d17fb';

const tenantA = 'a1000000-1000-4000-8000-000000000001';
const environmentA = 'a2000000-2000-4000-8000-000000000002';
const legalEntityA = 'a3000000-3000-4000-8000-000000000003';
const actorA = 'a4000000-4000-4000-8000-000000000004';
const itemA = 'a5000000-5000-4000-8000-000000000005';
const locationA = 'a6000000-6000-4000-8000-000000000006';

const tenantB = 'b1000000-1000-4000-8000-000000000001';
const environmentB = 'b2000000-2000-4000-8000-000000000002';
const legalEntityB = 'b3000000-3000-4000-8000-000000000003';
const actorB = 'b4000000-4000-4000-8000-000000000004';
const itemB = 'b5000000-5000-4000-8000-000000000005';
const locationB = 'b6000000-6000-4000-8000-000000000006';

interface Scope {
  actorId: string;
  environmentId: string;
  itemId: string;
  legalEntityId: string;
  locationId: string;
  tenantId: string;
}

test('inventory storage freezes quantity facts, entity scope, and recorded horizons', async (t) => {
  await withEphemeralPostgres(
    'inventory-storage',
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
          '0015_inventory_storage_foundation.sql',
        );
        assert.equal(migrated.verified.length, 15);
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
          'movement shape is quantity-only and v1 members are required real values',
          async () => {
            const columns = await admin.query<{
              column_name: string;
              is_nullable: boolean;
            }>(
              `SELECT attribute.attname AS column_name,
                      NOT attribute.attnotnull AS is_nullable
                 FROM pg_attribute AS attribute
                 JOIN pg_class AS relation
                   ON relation.oid = attribute.attrelid
                 JOIN pg_namespace AS namespace
                   ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = 'platform'
                  AND relation.relname = 'inventory_movements'
                  AND attribute.attnum > 0
                  AND NOT attribute.attisdropped
                ORDER BY attribute.attnum`,
            );
            const names = columns.rows.map(({ column_name }) => column_name);
            assert.deepEqual(names, [
              'tenant_id',
              'environment_id',
              'legal_entity_id',
              'business_period',
              'movement_id',
              'transaction_id',
              'transaction_line_id',
              'stock_dimension_set_version',
              'item_id',
              'location_id',
              'quantity_delta',
              'unit_id',
              'effective_at',
              'recorded_at',
              'source_type',
              'source_id',
              'source_line',
              'revision',
              'posting_role',
              'reason_code',
              'reason_narrative',
              'actor_id',
              'reversal_of_movement_id',
            ]);
            assert.equal(
              names.some((name) =>
                /(?:amount|cost|currency|money|price|value|lot|serial|bin)/iu.test(
                  name,
                ),
              ),
              false,
            );
            for (const required of [
              'legal_entity_id',
              'stock_dimension_set_version',
              'item_id',
              'location_id',
              'quantity_delta',
              'effective_at',
              'recorded_at',
            ]) {
              assert.equal(
                columns.rows.find(({ column_name }) => column_name === required)
                  ?.is_nullable,
                false,
              );
            }
          },
        );

        await t.test(
          'partitioning observes tenant business period and prunes to one leaf',
          async () => {
            const partition = await admin.query<{
              leaves: string;
              partition_key: string;
            }>(
              `SELECT pg_get_partkeydef('platform.inventory_movements'::regclass)
                        AS partition_key,
                      count(*) FILTER (WHERE isleaf)::text AS leaves
                 FROM pg_partition_tree('platform.inventory_movements')
                GROUP BY partition_key`,
            );
            assert.deepEqual(partition.rows, [
              {
                leaves: '8',
                partition_key: 'HASH (tenant_id, business_period)',
              },
            ]);
            const plan = await admin.query<{ 'QUERY PLAN': unknown }>(
              `EXPLAIN (FORMAT JSON, COSTS FALSE)
               SELECT movement_id
                 FROM platform.inventory_movements
                WHERE tenant_id = $1
                  AND business_period = DATE '2026-07-29'`,
              [tenantA],
            );
            const relationNames = collectRelationNames(
              plan.rows[0]?.['QUERY PLAN'],
            ).filter((name) => name.startsWith('inventory_movements_p'));
            assert.equal(relationNames.length, 1);
          },
        );

        await t.test(
          'provisioning creates one default master, entity lock, and typed release configuration',
          async () => {
            const masters = await admin.query<{
              count: string;
              defaults: string;
            }>(
              `SELECT count(*)::text AS count,
                      count(*) FILTER (WHERE is_default)::text AS defaults
                 FROM platform.legal_entities
                WHERE tenant_id = $1 AND environment_id = $2`,
              [tenantA, environmentA],
            );
            assert.deepEqual(masters.rows[0], {
              count: '1',
              defaults: '1',
            });
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
                adjustment: null,
                transfer: null,
                count: null,
                correction: null,
                reBaseline: null,
              },
              contractReleaseRoot,
              maximumBackdateDays: 0,
              negativeStock: 'reject',
              reasonRequirements: {
                adjustment: 'codeAndNarrative',
                transfer: 'codeOnly',
                count: 'codeAndNarrative',
                correction: 'codeAndNarrative',
                reBaseline: 'codeAndNarrative',
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
          'unknown IANA zone and unknown legal-entity references fail closed',
          async () => {
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
            await assert.rejects(
              insertTransaction(admin, {
                actorId: actorA,
                environmentId: environmentA,
                itemId: itemA,
                legalEntityId: randomUUID(),
                locationId: locationA,
                tenantId: tenantA,
              }),
              hasPostgresCode('23503'),
            );
          },
        );

        const scopeA = {
          actorId: actorA,
          environmentId: environmentA,
          itemId: itemA,
          legalEntityId: legalEntityA,
          locationId: locationA,
          tenantId: tenantA,
        } satisfies Scope;
        const scopeB = {
          actorId: actorB,
          environmentId: environmentB,
          itemId: itemB,
          legalEntityId: legalEntityB,
          locationId: locationB,
          tenantId: tenantB,
        } satisfies Scope;
        const transactionA = await insertTransaction(admin, scopeA);
        const transactionB = await insertTransaction(admin, scopeB);
        const earlyA = await insertMovement(admin, {
          effectiveAt: '2026-07-29T12:00:00.000Z',
          recordedAt: '2026-07-29T13:00:00.000Z',
          scope: scopeA,
          sourceLine: '1',
          transaction: transactionA,
        });
        const lateA = await insertMovement(admin, {
          effectiveAt: '2026-07-29T12:30:00.000Z',
          recordedAt: '2026-07-29T15:00:00.000Z',
          scope: scopeA,
          sourceLine: '2',
          transaction: transactionA,
        });
        const earlyB = await insertMovement(admin, {
          effectiveAt: '2026-07-29T10:00:00.000Z',
          recordedAt: '2026-07-29T12:30:00.000Z',
          scope: scopeB,
          sourceLine: '1',
          transaction: transactionB,
        });

        await t.test(
          'missing and unknown dimension versions and v1 unspecified members are rejected',
          async () => {
            await assert.rejects(
              insertMovement(admin, {
                effectiveAt: '2026-07-30T12:00:00.000Z',
                recordedAt: '2026-07-30T13:00:00.000Z',
                scope: scopeA,
                sourceLine: 'missing-version',
                stockDimensionSetVersion: null,
                transaction: transactionA,
              }),
              hasPostgresCode('23502'),
            );
            await assert.rejects(
              insertMovement(admin, {
                effectiveAt: '2026-07-30T12:00:00.000Z',
                recordedAt: '2026-07-30T13:00:00.000Z',
                scope: scopeA,
                sourceLine: 'unknown-version',
                stockDimensionSetVersion: 'v2',
                transaction: transactionA,
              }),
              hasPostgresCode('23514'),
            );
            await assert.rejects(
              insertMovement(admin, {
                effectiveAt: '2026-07-30T12:00:00.000Z',
                itemId: '00000000-0000-0000-0000-000000000000',
                recordedAt: '2026-07-30T13:00:00.000Z',
                scope: scopeA,
                sourceLine: 'unspecified-item',
                transaction: transactionA,
              }),
              hasPostgresCode('23514'),
            );
          },
        );

        await t.test(
          'natural effect identity remains unique across business periods',
          async () => {
            await admin.query('BEGIN');
            try {
              const duplicate = await insertMovement(admin, {
                effectiveAt: '2026-08-02T12:00:00.000Z',
                recordedAt: '2026-08-02T13:00:00.000Z',
                scope: scopeA,
                sourceId: earlyA.sourceId,
                sourceLine: earlyA.sourceLine,
                transaction: transactionA,
                writeEffect: false,
              });
              await assert.rejects(
                insertEffect(admin, {
                  ...duplicate,
                  sourceId: earlyA.sourceId,
                  sourceLine: earlyA.sourceLine,
                }),
                hasPostgresCode('23505'),
              );
            } finally {
              await admin.query('ROLLBACK');
            }
          },
        );

        await t.test(
          'movement and effect rows reject update/delete and runtime has no write grant',
          async () => {
            for (const statement of [
              `UPDATE platform.inventory_movements
                  SET quantity_delta = quantity_delta + 1
                WHERE movement_id = $1`,
              `DELETE FROM platform.inventory_movements
                WHERE movement_id = $1`,
              `UPDATE platform.inventory_movement_effects
                  SET revision = revision + 1
                WHERE movement_id = $1`,
              `DELETE FROM platform.inventory_movement_effects
                WHERE movement_id = $1`,
            ]) {
              await assert.rejects(
                admin.query(statement, [earlyA.movementId]),
                (error: unknown) =>
                  error instanceof Error &&
                  (error as Error & { code?: string }).code === 'P0001' &&
                  error.message === 'INVENTORY_MOVEMENT_IMMUTABLE',
              );
            }
            const grants = await admin.query<{
              privilege_type: string;
              table_name: string;
            }>(
              `SELECT table_name, privilege_type
                 FROM information_schema.role_table_grants
                WHERE grantee = 'north_star_runtime'
                  AND table_schema = 'platform'
                  AND table_name IN (
                    'inventory_movements', 'inventory_movement_effects'
                  )
                ORDER BY table_name, privilege_type`,
            );
            assert.deepEqual(grants.rows, [
              {
                privilege_type: 'SELECT',
                table_name: 'inventory_movement_effects',
              },
              {
                privilege_type: 'SELECT',
                table_name: 'inventory_movements',
              },
            ]);
            const retained = await admin.query<{ count: string }>(
              `SELECT count(*)::text AS count
                 FROM platform.inventory_movements
                WHERE movement_id = $1`,
              [earlyA.movementId],
            );
            assert.equal(retained.rows[0]?.count, '1');
          },
        );

        await t.test(
          'base-unit binding rejection names the first recorded movement',
          async () => {
            await assert.rejects(
              admin.query(
                `SELECT north_star_internal.inventory_base_unit_change_allowed(
                  $1, $2, $3, 'BOX'
                )`,
                [tenantA, environmentA, itemA],
              ),
              (error: unknown) =>
                error instanceof Error &&
                (error as Error & { code?: string; detail?: string }).code ===
                  'P0001' &&
                error.message === 'INVENTORY_BASE_UNIT_IMMUTABLE' &&
                (error as Error & { detail?: string }).detail?.includes(
                  `bindingMovementId=${earlyA.movementId}`,
                ) === true,
            );
            const allowed = await admin.query<{ allowed: boolean }>(
              `SELECT north_star_internal.inventory_base_unit_change_allowed(
                $1, $2, $3, 'EA'
              ) AS allowed`,
              [tenantA, environmentA, itemA],
            );
            assert.equal(allowed.rows[0]?.allowed, true);
          },
        );

        await t.test(
          'two-tenant extract respects RLS and the recorded-time horizon',
          async () => {
            assert.deepEqual(
              await extractAtRecordedHorizon(
                runtimePool,
                scopeA,
                '2026-07-29T14:00:00.000Z',
              ),
              [earlyA.movementId],
            );
            assert.deepEqual(
              await extractAtRecordedHorizon(
                runtimePool,
                scopeB,
                '2026-07-29T14:00:00.000Z',
              ),
              [earlyB.movementId],
            );
            assert.notEqual(lateA.movementId, earlyA.movementId);
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
): Promise<void> {
  await client.query(
    `SELECT platform.provision_inventory_scope(
       $1, $2, $3, $4, $5, $6, $7, $8
     )`,
    [
      tenantId,
      environmentId,
      legalEntityId,
      entityCode,
      `${entityCode} Legal Entity`,
      timeZone,
      boundary,
      contractReleaseRoot,
    ],
  );
}

async function insertTransaction(
  client: pg.PoolClient,
  scope: Scope,
): Promise<{ lineId: string; transactionId: string }> {
  const transactionId = randomUUID();
  const lineId = randomUUID();
  await client.query(
    `INSERT INTO platform.inventory_transactions (
       tenant_id,
       environment_id,
       legal_entity_id,
       transaction_id,
       transaction_number,
       transaction_type,
       state,
       source_type,
       source_id,
       effective_at,
       recorded_at,
       actor_id
     ) VALUES ($1,$2,$3,$4,$5,'adjustment','posted','adjustment',$6,$7,$8,$9)`,
    [
      scope.tenantId,
      scope.environmentId,
      scope.legalEntityId,
      transactionId,
      `ADJ-${transactionId}`,
      randomUUID(),
      '2026-07-29T12:00:00.000Z',
      '2026-07-29T13:00:00.000Z',
      scope.actorId,
    ],
  );
  await client.query(
    `INSERT INTO platform.inventory_transaction_lines (
       tenant_id,
       environment_id,
       legal_entity_id,
       transaction_line_id,
       transaction_id,
       line_number,
       item_id,
       to_location_id,
       quantity,
       unit_id
     ) VALUES ($1,$2,$3,$4,$5,1,$6,$7,10,'EA')`,
    [
      scope.tenantId,
      scope.environmentId,
      scope.legalEntityId,
      lineId,
      transactionId,
      scope.itemId,
      scope.locationId,
    ],
  );
  return { lineId, transactionId };
}

interface InsertedMovement {
  businessPeriod: string;
  movementId: string;
  sourceId: string;
  sourceLine: string;
}

async function insertMovement(
  client: pg.PoolClient,
  input: {
    effectiveAt: string;
    itemId?: string;
    recordedAt: string;
    scope: Scope;
    sourceId?: string;
    sourceLine: string;
    stockDimensionSetVersion?: string | null;
    transaction: { lineId: string; transactionId: string };
    writeEffect?: boolean;
  },
): Promise<InsertedMovement> {
  const movementId = randomUUID();
  const sourceId = input.sourceId ?? randomUUID();
  const period = await client.query<{ business_period: string }>(
    `SELECT north_star_internal.inventory_business_period($1, $2)
       AS business_period`,
    [input.scope.tenantId, input.effectiveAt],
  );
  const businessPeriod = period.rows[0]!.business_period;
  await client.query(
    `INSERT INTO platform.inventory_movements (
       tenant_id,
       environment_id,
       legal_entity_id,
       business_period,
       movement_id,
       transaction_id,
       transaction_line_id,
       stock_dimension_set_version,
       item_id,
       location_id,
       quantity_delta,
       unit_id,
       effective_at,
       recorded_at,
       source_type,
       source_id,
       source_line,
       revision,
       posting_role,
       actor_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,2,'EA',$11,$12,
       'adjustment',$13,$14,1,'adjustment',$15
     )`,
    [
      input.scope.tenantId,
      input.scope.environmentId,
      input.scope.legalEntityId,
      businessPeriod,
      movementId,
      input.transaction.transactionId,
      input.transaction.lineId,
      input.stockDimensionSetVersion === undefined
        ? 'v1'
        : input.stockDimensionSetVersion,
      input.itemId ?? input.scope.itemId,
      input.scope.locationId,
      input.effectiveAt,
      input.recordedAt,
      sourceId,
      input.sourceLine,
      input.scope.actorId,
    ],
  );
  const inserted = {
    businessPeriod,
    movementId,
    sourceId,
    sourceLine: input.sourceLine,
  };
  if (input.writeEffect !== false)
    await insertEffect(client, inserted, input.scope);
  return inserted;
}

async function insertEffect(
  client: pg.PoolClient,
  movement: InsertedMovement,
  scope?: Scope,
): Promise<void> {
  const resolvedScope = scope ?? {
    actorId: actorA,
    environmentId: environmentA,
    itemId: itemA,
    legalEntityId: legalEntityA,
    locationId: locationA,
    tenantId: tenantA,
  };
  await client.query(
    `INSERT INTO platform.inventory_movement_effects (
       tenant_id,
       environment_id,
       legal_entity_id,
       source_type,
       source_id,
       source_line,
       revision,
       posting_role,
       business_period,
       movement_id
     ) VALUES ($1,$2,$3,'adjustment',$4,$5,1,'adjustment',$6,$7)`,
    [
      resolvedScope.tenantId,
      resolvedScope.environmentId,
      resolvedScope.legalEntityId,
      movement.sourceId,
      movement.sourceLine,
      movement.businessPeriod,
      movement.movementId,
    ],
  );
}

async function extractAtRecordedHorizon(
  pool: pg.Pool,
  scope: Scope,
  recordedHorizon: string,
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
    const rows = await client.query<{ movement_id: string }>(
      `SELECT movement_id
         FROM platform.inventory_movements
        WHERE recorded_at <= $1
        ORDER BY recorded_at, movement_id`,
      [recordedHorizon],
    );
    await client.query('COMMIT');
    return rows.rows.map(({ movement_id }) => movement_id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function collectRelationNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectRelationNames);
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record['Relation Name'] === 'string'
      ? [record['Relation Name']]
      : []),
    ...Object.values(record).flatMap(collectRelationNames),
  ];
}

function hasPostgresCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    (error as Error & { code?: string }).code === code;
}
