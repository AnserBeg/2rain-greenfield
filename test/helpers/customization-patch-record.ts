import assert from 'node:assert/strict';
import type pg from 'pg';

export async function recordedPatch(pool: pg.Pool, patchId: string) {
  const result = await pool.query<{
    active_revision_id: string;
    authored_by: string;
    base_release_root: string;
    channel: string;
    parent_revision_id: string;
    patch_kind: string;
    payload: Buffer;
    payload_digest: string;
    resulting_parent_revision_id: string;
    resulting_provenance: string;
    resulting_release_id: string;
    resulting_release_root: string;
    resulting_revision_id: string;
  }>(
    `SELECT patch.patch_kind, patch.channel, patch.authored_by,
            patch.base_release_root, patch.payload, patch.payload_digest,
            patch.parent_revision_id, patch.resulting_revision_id,
            patch.resulting_release_id,
            revision.provenance AS resulting_provenance,
            revision.parent_revision_id AS resulting_parent_revision_id,
            release.content_hash AS resulting_release_root,
            active.app_package_revision_id AS active_revision_id
       FROM platform.customization_patches AS patch
       JOIN platform.app_package_revisions AS revision
         ON revision.revision_id = patch.resulting_revision_id
       JOIN platform.tenant_releases AS release
         ON release.release_id = patch.resulting_release_id
       JOIN platform.active_release_pointers AS pointer
         ON pointer.tenant_id = patch.tenant_id
        AND pointer.environment_id = patch.environment_id
       JOIN platform.tenant_releases AS active
         ON active.release_id = pointer.release_id
      WHERE patch.patch_id = $1`,
    [patchId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}
