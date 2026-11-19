import { verifiedGenerationsSql } from './verified-release-generation.js';
import type { MintedUuid } from '@north-star/platform-runtime';
import type { Pool, PoolClient } from 'pg';

export interface CustomizationLineageStep {
  readonly release_id: MintedUuid;
  readonly revision_id: MintedUuid;
  readonly content_hash: string;
  readonly provenance: string;
  /** The upgrade crossed to reach this step, if any. */
  readonly via_upgrade: MintedUuid | null;
  readonly fence_limit: string | null;
  readonly cycle: boolean;
  readonly ambiguous: boolean;
}

export class CustomizationLineageError extends Error {
  readonly code = 'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE';
  constructor(
    message: string,
    readonly active: CustomizationLineageStep | undefined,
  ) {
    super(message);
  }
}

/** Follow the forward activation that actually selected each release, even
 * after a rollback restored it. At an upgrade the approved base release is
 * exact, including across compiler-profile-only edges sharing a revision. */
export async function readCustomizationLineage(
  client: Pool | PoolClient,
  origin: {
    tenantId: string;
    environmentId: string;
    releaseId: string;
    beforeFence?: string | null;
  },
): Promise<readonly CustomizationLineageStep[]> {
  const result = await client.query<CustomizationLineageStep>(
    `WITH RECURSIVE chain(release_id, via_upgrade, fence_limit, depth, ambiguous) AS (
       SELECT $3::uuid, NULL::uuid, $4::bigint, 0, false
       UNION ALL
       SELECT COALESCE(u.base_release_id, forward.previous_release_id),
              forward.customization_upgrade_id, forward.fence, chain.depth + 1, forward.customization_reconciliation_required
         FROM chain
         JOIN platform.tenant_releases AS r
           ON r.tenant_id = $1 AND r.environment_id = $2 AND r.release_id = chain.release_id
         JOIN platform.app_package_revisions AS revision
           ON revision.tenant_id = r.tenant_id AND revision.revision_id = r.app_package_revision_id
         JOIN LATERAL (
           SELECT swap.previous_release_id, approval.customization_upgrade_id, approval.customization_reconciliation_required, swap.fence
             FROM ${verifiedGenerationsSql} AS swap
             JOIN platform.release_approvals AS approval
               ON approval.tenant_id = swap.tenant_id AND approval.environment_id = swap.environment_id
              AND approval.approval_id = swap.approval_id
             JOIN platform.tenant_releases AS source
               ON source.tenant_id = swap.tenant_id AND source.environment_id = swap.environment_id
              AND source.release_id = swap.previous_release_id
            WHERE swap.tenant_id = r.tenant_id AND swap.environment_id = r.environment_id
              AND swap.activated_release_id = r.release_id
              AND source.app_package_revision_id = revision.parent_revision_id
              AND (chain.fence_limit IS NULL OR swap.fence < chain.fence_limit)
            ORDER BY swap.fence DESC LIMIT 1
         ) AS forward ON true
         LEFT JOIN platform.customization_upgrades AS u
           ON u.tenant_id = r.tenant_id AND u.environment_id = r.environment_id
          AND u.upgrade_id = forward.customization_upgrade_id
        WHERE revision.provenance = 'tenantAuthored' AND NOT chain.ambiguous
     ) CYCLE release_id SET cycle USING path
     SELECT chain.release_id, chain.via_upgrade, chain.fence_limit, chain.cycle, chain.ambiguous,
            r.app_package_revision_id AS revision_id, r.content_hash, revision.provenance
       FROM chain JOIN platform.tenant_releases AS r
         ON r.tenant_id = $1 AND r.environment_id = $2 AND r.release_id = chain.release_id
       JOIN platform.app_package_revisions AS revision
         ON revision.tenant_id = r.tenant_id AND revision.revision_id = r.app_package_revision_id
      ORDER BY chain.depth`,
    [
      origin.tenantId,
      origin.environmentId,
      origin.releaseId,
      origin.beforeFence ?? null,
    ],
  );
  if (result.rows.some((step) => step.ambiguous))
    throw new CustomizationLineageError(
      'The original approval action requires reconciliation before replay.',
      result.rows[0],
    );
  if (result.rows.some((step) => step.cycle))
    throw new CustomizationLineageError(
      'the customization lineage contains a cycle',
      result.rows[0],
    );
  if (
    result.rows.some(
      (step) => step.via_upgrade && step.provenance !== 'firstParty',
    ) ||
    result.rows.at(-1)?.provenance !== 'firstParty'
  )
    throw new CustomizationLineageError(
      'the customization lineage does not reach a first-party base',
      result.rows[0],
    );
  return result.rows;
}
