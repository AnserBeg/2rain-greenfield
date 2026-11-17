import pg from 'pg';

/**
 * What the database is serving, read without changing anything: the release
 * root of the release the tenant's active pointer names and, when that is a
 * tenant customization, the first-party release its parent chain starts from
 * (the same walk the runtime's `tenantDescendantOfLineageTip` makes). It
 * never migrates, installs, activates or writes, so a caller can compare it
 * with the release it would otherwise open a runtime on. `null` means the
 * database has no such tenant, no pointer, or has never been installed.
 */
export interface ActiveRelease {
  /** The release root the active pointer names. */
  readonly releaseRoot: string;
  /** True when that release is a tenantAuthored customization. */
  readonly customized: boolean;
  /**
   * The first-party release the customization chain starts from (the active
   * release itself when it is not customized); null if it cannot be found.
   */
  readonly baseReleaseRoot: string | null;
}

export async function readActiveRelease(options: {
  readonly databaseUrl: string;
  readonly tenantSlug: string;
  readonly environmentSlug?: string;
}): Promise<ActiveRelease | null> {
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
    const result = await pool.query<{
      content_hash: string;
      customized: boolean;
      base_root: string | null;
    }>(
      `WITH RECURSIVE active AS (
         SELECT release.tenant_id, release.release_id, release.content_hash,
                release.app_package_revision_id
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
          WHERE tenant.slug = $1
       ), chain(revision_id, provenance, parent_revision_id) AS (
         SELECT revision.revision_id, revision.provenance,
                revision.parent_revision_id
           FROM active
           JOIN platform.app_package_revisions AS revision
             ON revision.tenant_id = active.tenant_id
            AND revision.revision_id = active.app_package_revision_id
         UNION ALL
         SELECT parent.revision_id, parent.provenance,
                parent.parent_revision_id
           FROM chain
           JOIN platform.app_package_revisions AS parent
             ON parent.tenant_id = (SELECT tenant_id FROM active)
            AND parent.revision_id = chain.parent_revision_id
          WHERE chain.provenance = 'tenantAuthored'
       )
       SELECT active.content_hash,
              COALESCE((SELECT bool_or(provenance = 'tenantAuthored')
                          FROM chain), false) AS customized,
              (SELECT base.content_hash
                 FROM platform.tenant_releases AS base
                WHERE base.tenant_id = active.tenant_id
                  AND base.app_package_revision_id = (
                        SELECT revision_id FROM chain
                         WHERE provenance <> 'tenantAuthored' LIMIT 1)
                ORDER BY base.created_at LIMIT 1) AS base_root
         FROM active`,
      [options.tenantSlug, options.environmentSlug ?? 'production'],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      releaseRoot: row.content_hash,
      customized: row.customized,
      baseReleaseRoot: row.customized ? row.base_root : row.content_hash,
    };
  } finally {
    await pool.end();
  }
}
