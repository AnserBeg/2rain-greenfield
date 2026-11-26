import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import pg from 'pg';

import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { seedBusinessCalendar } from '../helpers/business-calendar-seed.js';
import {
  type EphemeralPostgres,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

// COMPANY-CALENDAR-1 slice 1: the business calendar resolver. One migrated
// database; every test declares its own tenant, so each red stays alone.

let database: Promise<EphemeralPostgres>;
let finish: () => void = () => undefined;
let finished: Promise<void> = Promise.resolve();
before(() => {
  database = new Promise((resolve, reject) => {
    finished = withEphemeralPostgres('business-calendar', async (opened) => {
      const client = await opened.pool.connect();
      try {
        await runMigrations(client, await loadMigrations('db/migrations'));
      } finally {
        client.release();
      }
      resolve(opened);
      await new Promise<void>((done) => {
        finish = done;
      });
    }).catch(reject);
  });
});
after(async () => {
  finish();
  await finished;
});

const admin = async () => (await database).pool;
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> =>
  ((await (await admin()).query(sql, values)).rows[0] as T | undefined)!;

/** A tenant and environment whose default calendar the seeding helper declares. */
async function tenant(timeZone: string | null, boundary = '00:00') {
  const id = randomUUID(),
    environment = randomUUID();
  const pool = await admin();
  await pool.query(
    'INSERT INTO platform.tenants(id,slug) VALUES ($1,$1::text)',
    [id],
  );
  await pool.query(
    "INSERT INTO platform.environments(tenant_id,id,slug) VALUES ($1,$2,'cal')",
    [id, environment],
  );
  if (timeZone)
    await seedBusinessCalendar(pool, { tenantId: id, timeZone, boundary });
  return { id, environment };
}

/** A company override inserted by the test as owner (design read C2). */
async function override(
  scope: { id: string; environment: string },
  company: string,
  versions: readonly (readonly [string, string, string])[],
) {
  const calendar = randomUUID();
  const pool = await admin();
  await pool.query(
    'INSERT INTO platform.business_calendars(calendar_id,tenant_id,environment_id,company_id) VALUES ($1,$2,$3,$4)',
    [calendar, scope.id, scope.environment, company],
  );
  for (const [index, [from, zone, boundary]] of versions.entries())
    await pool.query(
      'INSERT INTO platform.business_calendar_versions(tenant_id,calendar_id,version,effective_from,time_zone,business_day_boundary) VALUES ($1,$2,$3,$4,$5,$6)',
      [scope.id, calendar, index + 1, from, zone, boundary],
    );
  return calendar;
}

const resolved = (
  scope: { id: string; environment: string },
  company: string,
  at: string,
) =>
  one<{ calendar_id: string; version: number; time_zone: string } | undefined>(
    'SELECT calendar_id, version, time_zone FROM north_star_internal.business_calendar_at($1,$2,$3,$4)',
    [scope.id, scope.environment, company, at],
  );

const put = (
  scope: { id: string; environment: string | null },
  company: string | null,
  from: string,
  zone = 'UTC',
) =>
  one<{ version: number }>(
    'SELECT north_star_internal.business_calendar_put($1,$2,$3,$4,$5,$6,1::smallint,1::smallint) AS version',
    [scope.id, scope.environment, company, from, zone, '00:00'],
  );

test('business period is unchanged by the calendar resolver', async () => {
  const pool = await admin();
  // The 0033 body, verbatim, under a test name: the oracle.
  const migration = await readFile(
    'db/migrations/0033_definer_search_paths.sql',
    'utf8',
  );
  const body =
    /CREATE OR REPLACE FUNCTION north_star_internal\.inventory_business_period\([\s\S]*?\$inventory_business_period\$;/u.exec(
      migration,
    )?.[0];
  assert.ok(body, 'the 0033 business-period body was not found');
  await pool.query(
    body.replace(
      'north_star_internal.inventory_business_period(',
      'public.business_period_0033(',
    ),
  );
  const tenants: string[] = [];
  for (const zone of [
    'America/Vancouver',
    'America/Denver',
    'America/St_Johns',
    'Asia/Kolkata',
    'UTC',
  ])
    for (const boundary of ['00:00', '04:00', '08:00', '23:59:59'])
      tenants.push((await tenant(zone, boundary)).id);
  const compared = await pool.query<{
    compared: number;
    differing: number;
    sample: string | null;
  }>(
    `WITH instants AS (
       SELECT g AS at FROM generate_series('2026-03-07T00:00Z'::timestamptz, '2026-03-10T00:00Z', '15 minutes') g
       UNION ALL SELECT g FROM generate_series('2026-10-31T00:00Z'::timestamptz, '2026-11-03T00:00Z', '15 minutes') g
       UNION ALL SELECT g FROM generate_series('2026-12-30T00:00Z'::timestamptz, '2027-01-02T00:00Z', '15 minutes') g
       UNION ALL SELECT g FROM generate_series('2026-06-30T23:59:58Z'::timestamptz, '2026-07-01T00:00:02Z', '1 second') g
       UNION ALL SELECT 'infinity'::timestamptz UNION ALL SELECT '-infinity'::timestamptz
       UNION ALL SELECT NULL::timestamptz)
     SELECT count(*)::int AS compared,
            count(*) FILTER (WHERE x.now IS DISTINCT FROM x.was)::int AS differing,
            min(t.id::text || ' ' || coalesce(i.at::text, 'NULL')) FILTER (WHERE x.now IS DISTINCT FROM x.was) AS sample
       FROM unnest($1::uuid[]) AS t(id) CROSS JOIN instants AS i
       CROSS JOIN LATERAL (SELECT north_star_internal.inventory_business_period(t.id, i.at) AS now,
                                  public.business_period_0033(t.id, i.at) AS was) AS x`,
    [tenants],
  );
  assert.deepEqual(
    compared.rows[0],
    { compared: 20 * (3 * 289 + 5 + 3), differing: 0, sample: null },
    'the resolver dates an instant differently from the 0033 business period',
  );
  // An undeclared tenant refuses identically, with and without an instant.
  const undeclared = randomUUID();
  for (const at of ['2026-07-01T00:00Z', null])
    for (const fn of [
      'north_star_internal.inventory_business_period',
      'public.business_period_0033',
    ])
      await assert.rejects(
        pool.query(`SELECT ${fn}($1, $2)`, [undeclared, at]),
        (error: { message: string; detail: string }) =>
          error.message === 'INVENTORY_TENANT_CALENDAR_UNDECLARED' &&
          error.detail === `tenantId=${undeclared}`,
        `${fn} accepted an undeclared tenant`,
      );
  // The catalog shape is the 0033 one.
  assert.deepEqual(
    (
      await pool.query(`SELECT p.provolatile, p.prosecdef, p.proconfig,
          pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result,
          has_function_privilege('north_star_module_materializer', p.oid, 'EXECUTE') AS materializer,
          has_function_privilege('north_star_module_runtime', p.oid, 'EXECUTE') AS module_runtime,
          has_function_privilege('north_star_runtime', p.oid, 'EXECUTE') AS runtime,
          EXISTS (SELECT FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
        FROM pg_proc p WHERE p.oid = 'north_star_internal.inventory_business_period(uuid,timestamptz)'::regprocedure`)
    ).rows,
    [
      {
        provolatile: 's',
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, platform, pg_temp'],
        args: 'requested_tenant_id uuid, requested_effective_at timestamp with time zone',
        result: 'date',
        materializer: true,
        module_runtime: true,
        runtime: true,
        public: false,
      },
    ],
    'the business-period function changed its catalog shape',
  );
});

test('company B on its override and company A on the tenant default date one instant apart', async () => {
  const scope = await tenant('America/Vancouver');
  const [a, b] = [randomUUID(), randomUUID()];
  await override(scope, b, [
    ['2026-01-01T06:00Z', 'America/Winnipeg', '00:00'],
  ]);
  const at = '2026-04-01T05:30Z';
  const days = await one<{ a: string; b: string }>(
    `SELECT north_star_internal.business_day($1,$2,$3,$5)::text AS a,
            north_star_internal.business_day($1,$2,$4,$5)::text AS b`,
    [scope.id, scope.environment, a, b, at],
  );
  assert.deepEqual(
    days,
    { a: '2026-03-31', b: '2026-04-01' },
    'company B was dated by the tenant default',
  );
  // The ledger dates an entry by the company stored on it.
  const client = await (await admin()).connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('north_star.tenant_id',$1,true),set_config('north_star.environment_id',$2,true)",
      [scope.id, scope.environment],
    );
    for (const company of [a, b])
      await client.query(
        'SELECT north_star_internal.ledger_provision_company($1)',
        [company],
      );
    const ledger = await client.query<{ a: string; b: string }>(
      `SELECT north_star_internal.ledger_business_day($1,$3)::text AS a,
              north_star_internal.ledger_business_day($2,$3)::text AS b`,
      [a, b, at],
    );
    assert.deepEqual(
      ledger.rows[0],
      { a: '2026-03-31', b: '2026-04-01' },
      'the ledger dated company B by the tenant default',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('a calendar version applies only from its effective start', async () => {
  const scope = await tenant('UTC');
  const company = randomUUID();
  await override(scope, company, [
    ['2026-01-01T06:00Z', 'America/Winnipeg', '00:00'],
    ['2026-06-01T04:00Z', 'America/Toronto', '00:00'],
  ]);
  const may = await resolved(scope, company, '2026-05-15T12:00Z');
  const june = await resolved(scope, company, '2026-06-15T12:00Z');
  assert.deepEqual(
    [may?.version, may?.time_zone, june?.version, june?.time_zone],
    [1, 'America/Winnipeg', 2, 'America/Toronto'],
    'a version answered an instant before its effective start',
  );
});

test("an instant before an override's first version resolves the tenant default", async () => {
  const scope = await tenant('America/Vancouver');
  const company = randomUUID();
  const calendar = await override(scope, company, [
    ['2026-01-01T06:00Z', 'America/Winnipeg', '00:00'],
  ]);
  const before = await resolved(scope, company, '2025-12-15T12:00Z');
  const later = await resolved(scope, company, '2026-02-15T12:00Z');
  assert.deepEqual(
    [before?.calendar_id, before?.time_zone, later?.calendar_id],
    [scope.id, 'America/Vancouver', calendar],
    'an instant before the override did not fall back to the tenant default',
  );
});

test('calendar versions and calendars are append-only', async () => {
  const scope = await tenant('UTC');
  const pool = await admin();
  for (const [sql, label] of [
    [
      "UPDATE platform.business_calendar_versions SET time_zone='Asia/Tokyo' WHERE tenant_id=$1",
      'a version was rewritten',
    ],
    [
      'DELETE FROM platform.business_calendar_versions WHERE tenant_id=$1',
      'a version was deleted',
    ],
    [
      'DELETE FROM platform.business_calendars WHERE tenant_id=$1',
      'a calendar was deleted',
    ],
  ] as const)
    await assert.rejects(
      pool.query(sql, [scope.id]),
      { message: 'calendar.appendOnly' },
      label,
    );
});

test('the frozen mirror refuses UPDATE and DELETE', async () => {
  const scope = await tenant('UTC');
  const pool = await admin();
  for (const [sql, label] of [
    [
      "UPDATE platform.inventory_tenant_calendars SET time_zone='Asia/Tokyo' WHERE tenant_id=$1",
      'the mirror was rewritten',
    ],
    [
      'DELETE FROM platform.inventory_tenant_calendars WHERE tenant_id=$1',
      'the mirror lost a row',
    ],
  ] as const)
    await assert.rejects(
      pool.query(sql, [scope.id]),
      { message: 'calendar.mirrorFrozen' },
      label,
    );
});

test('provisioning declares the tenant default in both stores', async () => {
  const scope = await tenant(null);
  const pool = await admin();
  const provision = (zone: string, boundary: string) =>
    pool.query(
      `SELECT platform.provision_inventory_scope($1,$2,$3,'CAL','CAL',$5,$6,$4,1::smallint,'reject',0,'codeAndNarrative','codeOnly','codeAndNarrative','codeAndNarrative','codeAndNarrative',NULL,NULL,NULL,NULL,NULL)`,
      [
        scope.id,
        scope.environment,
        randomUUID(),
        'a'.repeat(64),
        zone,
        boundary,
      ],
    );
  await provision('America/Regina', '05:00');
  await provision('America/Regina', '05:00');
  const stores = await one<{ mirror: unknown; versions: unknown }>(
    `SELECT (SELECT jsonb_agg(jsonb_build_object('zone', m.time_zone, 'boundary', m.business_day_boundary::text,
                'at', m.created_at::text)) FROM platform.inventory_tenant_calendars m WHERE m.tenant_id=$1) AS mirror,
            (SELECT jsonb_agg(jsonb_build_object('calendar', v.calendar_id, 'version', v.version,
                'from', v.effective_from::text, 'zone', v.time_zone, 'boundary', v.business_day_boundary::text,
                'week', v.week_start, 'month', v.fiscal_year_start_month, 'at', v.recorded_at::text))
               FROM platform.business_calendar_versions v WHERE v.tenant_id=$1) AS versions`,
    [scope.id],
  );
  const mirror = (stores.mirror as { at: string }[] | null)?.[0];
  assert.deepEqual(
    stores.versions,
    [
      {
        calendar: scope.id,
        version: 1,
        from: '-infinity',
        zone: 'America/Regina',
        boundary: '05:00:00',
        week: 1,
        month: 1,
        at: mirror?.at,
      },
    ],
    'provisioning wrote the mirror without the authoritative default',
  );
  await assert.rejects(provision('America/Regina', '06:00'), {
    message: 'INVENTORY_TENANT_CALENDAR_CONFLICT',
  });
});

test('an undeclared calendar refuses with no UTC default', async () => {
  const scope = { id: randomUUID(), environment: randomUUID() };
  await assert.rejects(
    one('SELECT north_star_internal.business_day($1,$2,$3,$4)', [
      scope.id,
      scope.environment,
      randomUUID(),
      '2026-07-01T00:00Z',
    ]),
    { message: 'calendar.undeclared' },
    'an undeclared calendar dated an instant',
  );
});

test("a runtime session cannot read another tenant's business period", async () => {
  const [mine, theirs] = [await tenant('UTC'), await tenant('UTC')];
  const runtime = new pg.Pool({
    ...(await database).connection,
    user: 'north_star_runtime',
    max: 1,
  });
  try {
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('north_star.tenant_id',$1,true)", [
        mine.id,
      ]);
      await assert.rejects(
        client.query(
          'SELECT north_star_internal.inventory_business_period($1, now())',
          [theirs.id],
        ),
        { message: 'INVENTORY_TRUSTED_SCOPE_MISMATCH' },
        "a runtime session dated another tenant's instant",
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    await runtime.end();
  }
});

test('a declared tenant dates a NULL instant as NULL', async () => {
  const scope = await tenant('UTC');
  assert.deepEqual(
    await one(
      `SELECT north_star_internal.inventory_business_period($1, NULL) AS period,
              north_star_internal.business_day($1, NULL, NULL, NULL) AS day`,
      [scope.id],
    ),
    { period: null, day: null },
    'a NULL instant was not dated NULL',
  );
});

test('the calendar setter refuses outside READ COMMITTED', async () => {
  const scope = await tenant(null);
  const client = await (await admin()).connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await assert.rejects(
      client.query(
        "SELECT north_star_internal.business_calendar_put($1,NULL,NULL,'-infinity','UTC','00:00',1::smallint,1::smallint)",
        [scope.id],
      ),
      { message: 'calendar.requiresReadCommitted' },
      'the setter wrote under REPEATABLE READ',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('a calendar change starts a future business day', async () => {
  const scope = await tenant('UTC');
  const company = randomUUID();
  const { today } = await one<{ today: string }>(
    "SELECT date_trunc('day', now() AT TIME ZONE 'UTC')::date::text AS today",
  );
  const start = (days: number, hours = 0) =>
    new Date(
      Date.parse(`${today}T00:00:00Z`) + (days * 24 + hours) * 3_600_000,
    ).toISOString();
  await assert.rejects(
    put(scope, company, start(2, 12)),
    { message: 'calendar.changeNotFutureDayStart' },
    'a mid-day change was accepted',
  );
  await assert.rejects(
    put(scope, company, start(0)),
    { message: 'calendar.changeNotFutureDayStart' },
    'a change effective today was accepted',
  );
  assert.equal(
    (await put(scope, company, start(1))).version,
    1,
    "tomorrow's start was refused",
  );
  assert.equal(
    (await put(scope, company, start(3))).version,
    2,
    'a later day start was refused',
  );
});

test('a tenant default keeps one version while its mirror exists', async () => {
  const scope = await tenant('UTC');
  const { tomorrow } = await one<{ tomorrow: string }>(
    "SELECT ((date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC')::text AS tomorrow",
  );
  await assert.rejects(
    put({ id: scope.id, environment: null }, null, tomorrow),
    { message: 'calendar.defaultVersionClosed' },
    'a second tenant-default version was written beside the mirror',
  );
});

test('an override cannot start unbounded once its company has dated facts', async () => {
  const scope = await tenant('UTC');
  const [dated, fresh] = [randomUUID(), randomUUID()];
  const pool = await admin();
  await pool.query(
    'INSERT INTO platform.ledger_companies(tenant_id,environment_id,company_id) VALUES ($1,$2,$3)',
    [scope.id, scope.environment, dated],
  );
  await assert.rejects(
    override(scope, dated, [['-infinity', 'America/Winnipeg', '00:00']]),
    { message: 'calendar.overrideBackdated' },
    'an override re-dated a company with ledger facts',
  );
  await override(scope, fresh, [['-infinity', 'America/Winnipeg', '00:00']]);
});

test('no runtime role holds a calendar table or an internal calendar function', async () => {
  const granted = await (
    await admin()
  ).query<{ role: string; object: string }>(
    `SELECT r.rolname AS role, o.name AS object
       FROM pg_roles r CROSS JOIN (VALUES
         ('platform.business_calendars', 'table'), ('platform.business_calendar_versions', 'table'),
         ('north_star_internal.business_calendar_at(uuid,uuid,uuid,timestamptz)', 'function'),
         ('north_star_internal.business_day(uuid,uuid,uuid,timestamptz)', 'function'),
         ('north_star_internal.business_day_of(text,time,timestamptz)', 'function'),
         ('north_star_internal.business_calendar_put(uuid,uuid,uuid,timestamptz,text,time,smallint,smallint)', 'function'),
         ('platform.business_calendar_read(uuid)', 'function')) AS o(name, kind)
      WHERE r.rolname LIKE 'north\\_star\\_%'
        AND CASE o.kind
          WHEN 'table' THEN has_table_privilege(r.oid, o.name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          ELSE has_function_privilege(r.oid, o.name, 'EXECUTE') END
      ORDER BY 1, 2`,
  );
  assert.deepEqual(
    granted.rows,
    [
      {
        role: 'north_star_runtime',
        object: 'platform.business_calendar_read(uuid)',
      },
    ],
    'a runtime role holds a calendar privilege',
  );
});

test("a principal scoped to company A is refused company B's calendar", async () => {
  const scope = await tenant('America/Vancouver');
  const [a, b, principal, role] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const pool = await admin();
  await pool.query(
    "INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key) VALUES ($1,$2,$3,'calendar-reader')",
    [scope.id, scope.environment, role],
  );
  await pool.query(
    'INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id) VALUES ($1,$2,gen_random_uuid(),$3,$4,$5)',
    [scope.id, scope.environment, principal, role, a],
  );
  const runtime = new pg.Pool({
    ...(await database).connection,
    user: 'north_star_runtime',
    max: 1,
  });
  try {
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('north_star.tenant_id',$1,true),set_config('north_star.environment_id',$2,true),set_config('north_star.principal_id',$3,true)",
        [scope.id, scope.environment, principal],
      );
      const own = await client.query<{
        calendar_id: string;
        time_zone: string;
      }>(
        'SELECT calendar_id, time_zone FROM platform.business_calendar_read($1)',
        [a],
      );
      assert.deepEqual(
        own.rows,
        [{ calendar_id: scope.id, time_zone: 'America/Vancouver' }],
        "company A's principal could not read its own calendar",
      );
      await client.query('SAVEPOINT other');
      await assert.rejects(
        client.query('SELECT * FROM platform.business_calendar_read($1)', [b]),
        { message: 'calendar.readUnavailable' },
        "a principal scoped to company A read company B's calendar",
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    await runtime.end();
  }
});
