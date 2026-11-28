import type pg from 'pg';

/**
 * The one test path that declares or replaces a tenant's business calendar
 * (COMPANY-CALENDAR-1 s1, design read C1). It writes both stores: the
 * authoritative tenant default (platform.business_calendars and its version 1,
 * starting at -infinity) and the frozen mirror platform.inventory_tenant_calendars
 * that the preceding binary and three TypeScript readers still read.
 *
 * Production never rewrites a calendar: the versions are append-only and the
 * mirror refuses UPDATE and DELETE. A fixture that moves a tenant to another
 * zone mid-test is rewriting history on purpose, so it runs as the owner with
 * triggers off (session_replication_role = replica) inside one transaction.
 * On a database still at the preceding migration level (no new tables), only
 * the mirror is written.
 *
 * With `tenantId` null, every declared tenant is moved, as the old fixture's
 * unqualified UPDATE did; `boundary` null keeps each tenant's boundary.
 */
export async function seedBusinessCalendar(
  database: pg.Pool | pg.PoolClient,
  calendar: {
    readonly tenantId: string | null;
    readonly timeZone: string;
    readonly boundary?: string | null;
  },
): Promise<void> {
  const pooled = 'totalCount' in database;
  const client = pooled ? await database.connect() : database;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    if (calendar.tenantId !== null)
      await client.query(
        `INSERT INTO platform.inventory_tenant_calendars (tenant_id, time_zone, business_day_boundary)
         VALUES ($1, $2, coalesce($3::time, '00:00'))
         ON CONFLICT (tenant_id) DO UPDATE SET time_zone = EXCLUDED.time_zone,
           business_day_boundary = coalesce($3::time, inventory_tenant_calendars.business_day_boundary)`,
        [calendar.tenantId, calendar.timeZone, calendar.boundary ?? null],
      );
    else
      await client.query(
        `UPDATE platform.inventory_tenant_calendars SET time_zone = $1,
           business_day_boundary = coalesce($2::time, business_day_boundary)`,
        [calendar.timeZone, calendar.boundary ?? null],
      );
    const { rows } = await client.query<{ present: boolean }>(
      "SELECT to_regclass('platform.business_calendar_versions') IS NOT NULL AS present",
    );
    if (rows[0]?.present) {
      const scope = 'WHERE $1::uuid IS NULL OR mirror.tenant_id = $1::uuid';
      await client.query(
        `DELETE FROM platform.business_calendar_versions AS version
          USING platform.business_calendars AS calendar
          WHERE version.calendar_id = calendar.calendar_id AND calendar.company_id IS NULL
            AND ($1::uuid IS NULL OR calendar.tenant_id = $1::uuid)`,
        [calendar.tenantId],
      );
      await client.query(
        `INSERT INTO platform.business_calendars (calendar_id, tenant_id, created_at)
         SELECT mirror.tenant_id, mirror.tenant_id, mirror.created_at
           FROM platform.inventory_tenant_calendars AS mirror ${scope}
         ON CONFLICT DO NOTHING`,
        [calendar.tenantId],
      );
      await client.query(
        `INSERT INTO platform.business_calendar_versions (tenant_id, calendar_id, version,
           effective_from, time_zone, business_day_boundary, recorded_at)
         SELECT mirror.tenant_id, mirror.tenant_id, 1, '-infinity', mirror.time_zone,
                mirror.business_day_boundary, mirror.created_at
           FROM platform.inventory_tenant_calendars AS mirror ${scope}`,
        [calendar.tenantId],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (pooled) (client as pg.PoolClient).release();
  }
}
