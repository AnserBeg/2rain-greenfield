import { servingPointersSql } from './verified-release-generation.js';
import pg from 'pg';
import { readCustomizationLineage } from './customization-lineage.js';

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
      tenant_id: string;
      environment_id: string;
      release_id: string;
      fence: string;
    }>(
      `SELECT pointer.tenant_id, pointer.environment_id, pointer.release_id, pointer.fence
         FROM platform.tenants AS tenant
         JOIN platform.environments AS env ON env.tenant_id = tenant.id AND env.slug = $2
         JOIN ${servingPointersSql} AS pointer ON pointer.tenant_id = tenant.id AND pointer.environment_id = env.id
        WHERE tenant.slug = $1 AND pointer.release_id IS NOT NULL`,
      [options.tenantSlug, options.environmentSlug ?? 'production'],
    );
    const pointer = result.rows[0];
    if (!pointer) return null;
    const chain = await readCustomizationLineage(pool, {
      tenantId: pointer.tenant_id,
      environmentId: pointer.environment_id,
      releaseId: pointer.release_id,
      beforeFence: String(BigInt(pointer.fence) + 1n),
    });
    return {
      releaseRoot: chain[0]!.content_hash,
      customized: chain[0]!.provenance === 'tenantAuthored',
      baseReleaseRoot: chain.at(-1)!.content_hash,
    };
  } finally {
    await pool.end();
  }
}
