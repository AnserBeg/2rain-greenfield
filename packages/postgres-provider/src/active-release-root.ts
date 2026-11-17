import pg from 'pg';

/**
 * What the database is serving, read without changing anything: the content
 * hash (release root) of the release the tenant's active pointer names. It
 * never migrates, installs, activates or writes, so a caller can compare it
 * with the release it would otherwise open a runtime on. `null` means the
 * database has no such tenant, no pointer, or has never been installed.
 */
export async function readActiveReleaseRoot(options: {
  readonly databaseUrl: string;
  readonly tenantSlug: string;
  readonly environmentSlug?: string;
}): Promise<string | null> {
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: 5000,
    max: 1,
  });
  pool.on('error', () => undefined);
  try {
    const present = await pool.query<{ ready: boolean }>(
      `SELECT to_regclass('platform.active_release_pointers') IS NOT NULL
              AND to_regclass('platform.tenant_releases') IS NOT NULL
              AND to_regclass('platform.tenants') IS NOT NULL
              AND to_regclass('platform.environments') IS NOT NULL AS ready`,
    );
    if (present.rows[0]?.ready !== true) return null;
    const result = await pool.query<{ content_hash: string }>(
      `SELECT release.content_hash
         FROM platform.tenants AS tenant
         JOIN platform.environments AS environment
           ON environment.tenant_id = tenant.id AND environment.slug = $2
         JOIN platform.active_release_pointers AS pointer
           ON pointer.tenant_id = tenant.id
          AND pointer.environment_id = environment.id
         JOIN platform.tenant_releases AS release
           ON release.tenant_id = pointer.tenant_id
          AND release.environment_id = pointer.environment_id
          AND release.release_id = pointer.release_id
        WHERE tenant.slug = $1`,
      [options.tenantSlug, options.environmentSlug ?? 'production'],
    );
    return result.rows[0]?.content_hash ?? null;
  } finally {
    await pool.end();
  }
}
