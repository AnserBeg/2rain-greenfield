import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withArchivedCustomizationRuntime } from '../helpers/archived-runtime-process.js';
import { seedBusinessCalendar } from '../helpers/business-calendar-seed.js';
import {
  bookingRelease,
  demoItem,
  usageQuery,
  withBookingApplication,
} from '../helpers/booking-release.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

// COMPANY-CALENDAR-1 slice 1: the upgrade keeps every stored row, and the
// preceding serving binary still answers on the migrated database (rule 13,
// no rung: nothing compiled or stored changes).

/** main at the packet base: the binary that serves before this migration. */
const precedingServingBinary = 'b6668f052517ebf38459728a023b81d544a44840';

const fixtureId = (label: string) =>
  createHash('md5')
    .update(label)
    .digest('hex')
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, '$1-$2-$3-$4-$5');

async function digests(client: pg.PoolClient, tables?: readonly string[]) {
  const names =
    tables ??
    (
      await client.query<{ name: string }>(
        `SELECT format('%I.%I', n.nspname, c.relname) AS name FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('platform', 'north_star_internal', 'north_star_module')
            AND c.relkind IN ('r', 'p')
            AND (n.nspname, c.relname) <> ('north_star_internal', 'schema_migrations')
          ORDER BY 1`,
      )
    ).rows.map((row) => row.name);
  const result = new Map<string, string>();
  for (const name of names)
    result.set(
      name,
      (
        await client.query<{ digest: string }>(
          `SELECT count(*) || ':' || md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS digest FROM ${name} t`,
        )
      ).rows[0]!.digest,
    );
  return result;
}

test('upgrading to the calendar resolver leaves every stored row byte-identical', async () => {
  await withEphemeralPostgres('calendar-upgrade', async ({ pool }) => {
    const admin = await pool.connect();
    const runtime = await pool.connect();
    try {
      const migrations = await loadMigrations('db/migrations');
      const index = migrations.findIndex((m) =>
        m.name.endsWith('_business_calendar.sql'),
      );
      assert.ok(index > 0, 'the calendar migration is missing');
      await runMigrations(admin, migrations.slice(0, index));
      // The preceding schema: a booking world, a provisioned stock scope and
      // a ledger company, with one booking that froze the tenant calendar.
      await admin.query(
        await readFile('test/fixtures/booking-commitments.sql', 'utf8'),
      );
      const tenant = fixtureId('tenant'),
        environment = fixtureId('env'),
        principal = fixtureId('staff'),
        release = fixtureId('release');
      await seedBusinessCalendar(admin, {
        tenantId: tenant,
        timeZone: 'America/Denver',
        boundary: '08:00',
      });
      await admin.query(
        `SELECT platform.provision_inventory_scope($1,$2,$3,'UP','UP','America/Denver','08:00',$4,1::smallint,'reject',0,'codeAndNarrative','codeOnly','codeAndNarrative','codeAndNarrative','codeAndNarrative',NULL,NULL,NULL,NULL,NULL)`,
        [tenant, environment, fixtureId('company0'), 'a'.repeat(64)],
      );
      const other = randomUUID();
      await admin.query(
        "INSERT INTO platform.tenants(id,slug) VALUES ($1,'other')",
        [other],
      );
      await admin.query(
        "INSERT INTO platform.environments(tenant_id,id,slug) VALUES ($1,$2,'other')",
        [other, randomUUID()],
      );
      await seedBusinessCalendar(admin, {
        tenantId: other,
        timeZone: 'Asia/Kolkata',
        boundary: '04:30',
      });
      await admin.query(
        "SELECT set_config('north_star.tenant_id',$1,false),set_config('north_star.environment_id',$2,false)",
        [tenant, environment],
      );
      await admin.query(
        'SELECT north_star_internal.ledger_provision_company($1)',
        [fixtureId('company0')],
      );
      const policy =
        'northstar.current-policy/' +
        String(
          (
            await admin.query<{ policy_version: string }>(
              'SELECT policy_version FROM platform.current_policy_epochs WHERE tenant_id=$1',
              [tenant],
            )
          ).rows[0]!.policy_version,
        );
      await runtime.query('SET ROLE north_star_runtime');
      const hold = async (owner: number, start: string, end: string) => {
        const requestId = randomUUID();
        await runtime.query(
          "SELECT set_config('north_star.tenant_id',$1,false),set_config('north_star.environment_id',$2,false),set_config('north_star.principal_id',$3,false),set_config('north_star.request_id',$4,false)",
          [tenant, environment, principal, requestId],
        );
        const { rows } = await runtime.query<{
          result: { state: string; bookingId: string };
        }>('SELECT platform.booking_apply($1,$6,$2,$3,$4,$5) AS result', [
          release,
          'example.booking:operation.hold_unit',
          randomUUID(),
          {
            recordId: fixtureId('owner' + String(owner)),
            expectedOwnerRevision: 1,
            resourceId: fixtureId('resource' + String(owner)),
            expectedRevision: 0,
            quantity: '1',
            interval: {
              kind: 'time',
              start: '2030-02-11T' + start,
              end: '2030-02-11T' + end,
            },
          },
          {
            executionPrincipal: { kind: 'HUMAN', principalId: principal },
            requestId,
            channel: 'UI',
            policyVersion: policy,
            approvalGrantId: null,
          },
          1,
        ]);
        return rows[0]!.result;
      };
      assert.equal((await hold(1, '09:00', '10:00')).state, 'hold');

      const before = await digests(admin);
      // Exactly the calendar migration: later migrations are not this upgrade.
      const applied = await runMigrations(
        admin,
        migrations.slice(0, index + 1),
      );
      assert.deepEqual(applied.applied, [migrations[index]!.name]);
      assert.deepEqual(
        await digests(admin, [...before.keys()]),
        before,
        'the calendar migration changed a stored row',
      );
      // The backfill copies each mirror row verbatim as the default's version 1.
      const backfill = await admin.query<{ mirrored: boolean }>(
        `SELECT (m.time_zone, m.business_day_boundary, m.created_at)
                  IS NOT DISTINCT FROM (v.time_zone, v.business_day_boundary, v.recorded_at)
                AND v.version = 1 AND v.effective_from = '-infinity' AND v.calendar_id = m.tenant_id AS mirrored
           FROM platform.inventory_tenant_calendars m
           LEFT JOIN platform.business_calendar_versions v ON v.calendar_id = m.tenant_id`,
      );
      assert.deepEqual(
        backfill.rows,
        [{ mirrored: true }, { mirrored: true }],
        'a tenant default differs from its mirror row',
      );
      // A booking after the upgrade freezes the same calendar as before it.
      assert.equal((await hold(2, '09:00', '10:00')).state, 'hold');
      const frozen = await admin.query<{ calendar: unknown }>(
        'SELECT DISTINCT calendar FROM platform.booking_commitments',
      );
      assert.deepEqual(frozen.rows, [
        {
          calendar: {
            id: tenant,
            zone: 'America/Denver',
            boundary: '08:00:00',
          },
        },
      ]);
    } finally {
      runtime.release();
      admin.release();
    }
  });
});

const archivedProbe = `
import { readFile } from 'node:fs/promises';
import { ObservabilityMetrics } from './packages/observability/src/index.ts';
import { AuthenticatedRequestEntryAdapter } from './packages/runtime/src/request-context.ts';
import { AuthenticatedRequestRuntimeEntryAdapter } from './packages/runtime/src/request-runtime-view.ts';
import { SEMANTIC_QUERY_REQUEST_VERSION } from './packages/runtime/src/semantic-query-gateway.ts';
import { rolePool, trustedContext } from './packages/postgres-provider/src/composed-application-runtime.ts';
import { reportHorizon } from './packages/postgres-provider/src/grouped-report.ts';
import { composeServingGateways, loadServingRelease } from './packages/postgres-provider/src/serving-gateways.ts';
import { PostgresRequestRuntimeViewService } from './packages/postgres-provider/src/request-runtime-view-service.ts';
const {databaseUrl,identity,recordId,queryId,at}=JSON.parse(await readFile(process.argv[2],'utf8'));
const pool=rolePool(databaseUrl,'north_star_runtime',2);
let phase='booking';
try {
  const loader=new PostgresRequestRuntimeViewService(pool), context=await trustedContext(identity);
  const definition=await loader.load(context);
  const serving=await loadServingRelease(pool,context,definition.release.releaseId);
  const {policy,queryGateway}=composeServingGateways(pool,pool,context,serving,new ObservabilityMetrics(),{providerErrorMappings:[],writeInvariants:[]});
  const entry=new AuthenticatedRequestRuntimeEntryAdapter(new AuthenticatedRequestEntryAdapter(async()=>identity),loader,policy);
  const dto=await entry.run({},view=>queryGateway.invoke(view,{schemaVersion:SEMANTIC_QUERY_REQUEST_VERSION,queryId,arguments:{recordId,usage:{from:'2030-02-10T00:00:00Z',until:'2030-02-20T00:00:00Z'}}}));
  phase='report';
  const client=await pool.connect();
  let horizon;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('north_star.tenant_id',$1,true),set_config('north_star.environment_id',$2,true)",[identity.tenantId,identity.environmentId]);
    horizon=await reportHorizon(client,identity.tenantId,new Date(at));
    await client.query('ROLLBACK');
  } finally { client.release(); }
  console.log(JSON.stringify({outcome:dto.outcome,id:dto.records[0]?.recordId,businessDate:horizon.businessDate}));
} catch(error){console.log(JSON.stringify({outcome:'refused',phase,code:error.code,message:error.message}));}
finally {await pool.end();}
`;

test(
  'the preceding serving binary answers a booking and a report on the migrated database',
  { skip: !process.env.CI, timeout: 1_200_000 },
  async () => {
    await withBookingApplication(bookingRelease('query'), async (f) => {
      const at = '2026-04-01T05:30:00.000Z';
      const admin = new pg.Pool({ connectionString: f.databaseUrl, max: 1 });
      let expected: string;
      try {
        expected = (
          await admin.query<{ day: string }>(
            'SELECT north_star_internal.business_day($1, NULL, NULL, $2)::text AS day',
            [f.app.runtime.identity.tenantId, at],
          )
        ).rows[0]!.day;
      } finally {
        await admin.end();
      }
      await withArchivedCustomizationRuntime(
        precedingServingBinary,
        async (run) => {
          const probe = await run(archivedProbe, {
            databaseUrl: f.databaseUrl,
            identity: f.app.runtime.identity,
            recordId: demoItem,
            queryId: usageQuery,
            at,
          });
          assert.deepEqual(
            probe,
            { outcome: 'exact', id: demoItem, businessDate: expected },
            'the preceding binary did not answer on the migrated database',
          );
        },
      );
    });
  },
);
