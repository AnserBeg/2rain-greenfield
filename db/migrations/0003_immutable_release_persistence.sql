CREATE TABLE platform.app_package_revisions (
  tenant_id uuid NOT NULL REFERENCES platform.tenants (id),
  revision_id uuid NOT NULL,
  parent_revision_id uuid,
  schema_version text NOT NULL,
  language_version text NOT NULL,
  normalization_profile_version text NOT NULL,
  canonicalization_profile_version text NOT NULL,
  hash_algorithm text NOT NULL,
  content_hash text NOT NULL,
  desired_state bytea NOT NULL,
  provenance text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, revision_id),
  CONSTRAINT app_package_revisions_revision_id_unique UNIQUE (revision_id),
  CONSTRAINT app_package_revisions_parent_fkey
    FOREIGN KEY (tenant_id, parent_revision_id)
    REFERENCES platform.app_package_revisions (tenant_id, revision_id),
  CONSTRAINT app_package_revisions_versions_not_blank CHECK (
    btrim(schema_version) <> ''
    AND btrim(language_version) <> ''
    AND btrim(normalization_profile_version) <> ''
    AND btrim(canonicalization_profile_version) <> ''
  ),
  CONSTRAINT app_package_revisions_sha256 CHECK (
    hash_algorithm = 'sha256'
    AND content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT app_package_revisions_desired_state_not_empty
    CHECK (octet_length(desired_state) > 0),
  CONSTRAINT app_package_revisions_provenance_not_blank
    CHECK (btrim(provenance) <> '')
);

CREATE TABLE platform.release_artifact_blobs (
  content_hash text PRIMARY KEY,
  artifact_kind text NOT NULL,
  domain_tag text NOT NULL,
  media_type text NOT NULL,
  canonical_bytes bytea NOT NULL,
  byte_length integer NOT NULL,
  CONSTRAINT release_artifact_blobs_identity_unique
    UNIQUE (content_hash, artifact_kind),
  CONSTRAINT release_artifact_blobs_sha256
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT release_artifact_blobs_kind CHECK (
    artifact_kind IN ('projectionChunk', 'projectionManifest', 'releaseManifest')
  ),
  CONSTRAINT release_artifact_blobs_domain_not_blank
    CHECK (btrim(domain_tag) <> ''),
  CONSTRAINT release_artifact_blobs_media_type CHECK (
    media_type = 'application/vnd.northstar.canonical+json'
  ),
  CONSTRAINT release_artifact_blobs_length CHECK (
    byte_length > 0 AND byte_length = octet_length(canonical_bytes)
  )
);

CREATE TABLE platform.immutable_release_write_guard (
  attempted_relation text NOT NULL,
  CONSTRAINT immutable_release_write_guard_reject CHECK (false)
);

CREATE TABLE platform.tenant_releases (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  release_id uuid NOT NULL,
  app_package_revision_id uuid NOT NULL,
  compiler_version text NOT NULL,
  compiler_semantic_profile_version text NOT NULL,
  output_protocol_version text NOT NULL,
  content_hash text NOT NULL,
  release_manifest_kind text NOT NULL DEFAULT 'releaseManifest',
  compiler_attestation_digest text NOT NULL,
  verification_evidence_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, release_id),
  CONSTRAINT tenant_releases_release_id_unique UNIQUE (release_id),
  CONSTRAINT tenant_releases_verification_evidence_id_unique
    UNIQUE (verification_evidence_id),
  CONSTRAINT tenant_releases_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT tenant_releases_revision_fkey
    FOREIGN KEY (tenant_id, app_package_revision_id)
    REFERENCES platform.app_package_revisions (tenant_id, revision_id),
  CONSTRAINT tenant_releases_manifest_blob_fkey
    FOREIGN KEY (content_hash, release_manifest_kind)
    REFERENCES platform.release_artifact_blobs (content_hash, artifact_kind),
  CONSTRAINT tenant_releases_manifest_kind
    CHECK (release_manifest_kind = 'releaseManifest'),
  CONSTRAINT tenant_releases_versions_not_blank CHECK (
    btrim(compiler_version) <> ''
    AND btrim(compiler_semantic_profile_version) <> ''
    AND btrim(output_protocol_version) <> ''
  ),
  CONSTRAINT tenant_releases_sha256 CHECK (
    content_hash ~ '^[0-9a-f]{64}$'
    AND compiler_attestation_digest ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE platform.tenant_release_artifact_links (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  release_id uuid NOT NULL,
  content_hash text NOT NULL,
  artifact_kind text NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, release_id, content_hash),
  CONSTRAINT tenant_release_artifact_links_identity_kind_unique
    UNIQUE (
      tenant_id,
      environment_id,
      release_id,
      content_hash,
      artifact_kind
    ),
  CONSTRAINT tenant_release_artifact_links_release_fkey
    FOREIGN KEY (tenant_id, environment_id, release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT tenant_release_artifact_links_blob_fkey
    FOREIGN KEY (content_hash, artifact_kind)
    REFERENCES platform.release_artifact_blobs (content_hash, artifact_kind),
  CONSTRAINT tenant_release_artifact_links_non_root CHECK (
    artifact_kind IN ('projectionChunk', 'projectionManifest')
  )
);

CREATE TABLE platform.tenant_release_projection_links (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  release_id uuid NOT NULL,
  projection_instance_id text NOT NULL,
  projection_family_id text NOT NULL,
  projection_manifest_hash text NOT NULL,
  artifact_kind text NOT NULL DEFAULT 'projectionManifest',
  PRIMARY KEY (
    tenant_id,
    environment_id,
    release_id,
    projection_instance_id
  ),
  CONSTRAINT tenant_release_projection_links_artifact_unique
    UNIQUE (
      tenant_id,
      environment_id,
      release_id,
      projection_manifest_hash
    ),
  CONSTRAINT tenant_release_projection_links_artifact_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      release_id,
      projection_manifest_hash,
      artifact_kind
    ) REFERENCES platform.tenant_release_artifact_links (
      tenant_id,
      environment_id,
      release_id,
      content_hash,
      artifact_kind
    ),
  CONSTRAINT tenant_release_projection_links_kind
    CHECK (artifact_kind = 'projectionManifest'),
  CONSTRAINT tenant_release_projection_links_names_not_blank CHECK (
    btrim(projection_instance_id) <> ''
    AND btrim(projection_family_id) <> ''
  )
);

CREATE TABLE platform.tenant_release_chunk_links (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  release_id uuid NOT NULL,
  projection_instance_id text NOT NULL,
  chunk_id text NOT NULL,
  chunk_hash text NOT NULL,
  artifact_kind text NOT NULL DEFAULT 'projectionChunk',
  PRIMARY KEY (
    tenant_id,
    environment_id,
    release_id,
    projection_instance_id,
    chunk_id
  ),
  CONSTRAINT tenant_release_chunk_links_projection_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      release_id,
      projection_instance_id
    ) REFERENCES platform.tenant_release_projection_links (
      tenant_id,
      environment_id,
      release_id,
      projection_instance_id
    ),
  CONSTRAINT tenant_release_chunk_links_artifact_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      release_id,
      chunk_hash,
      artifact_kind
    ) REFERENCES platform.tenant_release_artifact_links (
      tenant_id,
      environment_id,
      release_id,
      content_hash,
      artifact_kind
    ),
  CONSTRAINT tenant_release_chunk_links_kind
    CHECK (artifact_kind = 'projectionChunk'),
  CONSTRAINT tenant_release_chunk_links_id_not_blank
    CHECK (btrim(chunk_id) <> '')
);

CREATE RULE app_package_revisions_reject_update
AS ON UPDATE TO platform.app_package_revisions
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('app_package_revisions');

CREATE RULE app_package_revisions_reject_delete
AS ON DELETE TO platform.app_package_revisions
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('app_package_revisions');

CREATE RULE release_artifact_blobs_reject_update
AS ON UPDATE TO platform.release_artifact_blobs
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('release_artifact_blobs');

CREATE RULE release_artifact_blobs_reject_delete
AS ON DELETE TO platform.release_artifact_blobs
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('release_artifact_blobs');

CREATE RULE tenant_releases_reject_update
AS ON UPDATE TO platform.tenant_releases
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('tenant_releases');

CREATE RULE tenant_releases_reject_delete
AS ON DELETE TO platform.tenant_releases
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('tenant_releases');

CREATE RULE tenant_release_artifact_links_reject_update
AS ON UPDATE TO platform.tenant_release_artifact_links
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('tenant_release_artifact_links');

CREATE RULE tenant_release_artifact_links_reject_delete
AS ON DELETE TO platform.tenant_release_artifact_links
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('tenant_release_artifact_links');

CREATE RULE tenant_release_projection_links_reject_update
AS ON UPDATE TO platform.tenant_release_projection_links
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('tenant_release_projection_links');

CREATE RULE tenant_release_projection_links_reject_delete
AS ON DELETE TO platform.tenant_release_projection_links
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('tenant_release_projection_links');

CREATE RULE tenant_release_chunk_links_reject_update
AS ON UPDATE TO platform.tenant_release_chunk_links
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('tenant_release_chunk_links');

CREATE RULE tenant_release_chunk_links_reject_delete
AS ON DELETE TO platform.tenant_release_chunk_links
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('tenant_release_chunk_links');

CREATE FUNCTION platform.stage_release_artifact(
  staged_content_hash text,
  staged_artifact_kind text,
  staged_domain_tag text,
  staged_media_type text,
  staged_canonical_bytes bytea
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH artifact_lock AS MATERIALIZED (
    SELECT pg_advisory_xact_lock(hashtextextended(staged_content_hash, 0))
  ), collision_guard AS MATERIALIZED (
    SELECT 1 AS accepted
      FROM artifact_lock
     WHERE NOT EXISTS (
       SELECT 1
         FROM platform.release_artifact_blobs AS existing
        WHERE existing.content_hash = staged_content_hash
          AND (
            existing.artifact_kind IS DISTINCT FROM staged_artifact_kind
            OR existing.domain_tag IS DISTINCT FROM staged_domain_tag
            OR existing.media_type IS DISTINCT FROM staged_media_type
            OR existing.canonical_bytes IS DISTINCT FROM staged_canonical_bytes
            OR existing.byte_length IS DISTINCT FROM octet_length(staged_canonical_bytes)
          )
     )
    UNION ALL
    SELECT (staged_content_hash || ': content-address collision')::integer
      FROM artifact_lock
     WHERE EXISTS (
        SELECT 1
          FROM platform.release_artifact_blobs AS existing
         WHERE existing.content_hash = staged_content_hash
           AND (
             existing.artifact_kind IS DISTINCT FROM staged_artifact_kind
             OR existing.domain_tag IS DISTINCT FROM staged_domain_tag
             OR existing.media_type IS DISTINCT FROM staged_media_type
             OR existing.canonical_bytes IS DISTINCT FROM staged_canonical_bytes
             OR existing.byte_length IS DISTINCT FROM octet_length(staged_canonical_bytes)
           )
     )
  ), inserted AS (
    INSERT INTO platform.release_artifact_blobs (
      content_hash,
      artifact_kind,
      domain_tag,
      media_type,
      canonical_bytes,
      byte_length
    )
    SELECT staged_content_hash,
           staged_artifact_kind,
           staged_domain_tag,
           staged_media_type,
           staged_canonical_bytes,
           octet_length(staged_canonical_bytes)
      FROM collision_guard
     WHERE accepted = 1
       AND NOT EXISTS (
         SELECT 1
           FROM platform.release_artifact_blobs AS existing
          WHERE existing.content_hash = staged_content_hash
       )
    RETURNING content_hash
  )
  SELECT accepted = 1
    FROM collision_guard
$$;

CREATE FUNCTION platform.read_tenant_release_artifacts(requested_release_id uuid)
RETURNS TABLE (
  artifact_kind text,
  content_hash text,
  domain_tag text,
  media_type text,
  canonical_bytes bytea
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT blob.artifact_kind,
         blob.content_hash,
         blob.domain_tag,
         blob.media_type,
         blob.canonical_bytes
    FROM platform.release_artifact_blobs AS blob
    JOIN (
      SELECT release.content_hash
        FROM platform.tenant_releases AS release
       WHERE release.tenant_id =
               nullif(current_setting('north_star.tenant_id', true), '')::uuid
         AND release.environment_id =
               nullif(current_setting('north_star.environment_id', true), '')::uuid
         AND nullif(current_setting('north_star.principal_id', true), '')::uuid
               IS NOT NULL
         AND release.release_id = requested_release_id
      UNION
      SELECT link.content_hash
        FROM platform.tenant_release_artifact_links AS link
       WHERE link.tenant_id =
               nullif(current_setting('north_star.tenant_id', true), '')::uuid
         AND link.environment_id =
               nullif(current_setting('north_star.environment_id', true), '')::uuid
         AND nullif(current_setting('north_star.principal_id', true), '')::uuid
               IS NOT NULL
         AND link.release_id = requested_release_id
    ) AS visible ON visible.content_hash = blob.content_hash
   ORDER BY blob.content_hash
$$;

ALTER TABLE platform.app_package_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.app_package_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_release_artifact_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_release_artifact_links FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_release_projection_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_release_projection_links FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_release_chunk_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_release_chunk_links FORCE ROW LEVEL SECURITY;

CREATE POLICY app_package_revisions_select_trusted_context
  ON platform.app_package_revisions
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND nullif(current_setting('north_star.environment_id', true), '')::uuid IS NOT NULL
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY app_package_revisions_insert_trusted_context
  ON platform.app_package_revisions
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND nullif(current_setting('north_star.environment_id', true), '')::uuid IS NOT NULL
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY tenant_releases_select_trusted_context
  ON platform.tenant_releases
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY tenant_releases_insert_trusted_context
  ON platform.tenant_releases
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY tenant_release_artifact_links_select_trusted_context
  ON platform.tenant_release_artifact_links
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY tenant_release_artifact_links_insert_trusted_context
  ON platform.tenant_release_artifact_links
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY tenant_release_projection_links_select_trusted_context
  ON platform.tenant_release_projection_links
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY tenant_release_projection_links_insert_trusted_context
  ON platform.tenant_release_projection_links
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY tenant_release_chunk_links_select_trusted_context
  ON platform.tenant_release_chunk_links
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY tenant_release_chunk_links_insert_trusted_context
  ON platform.tenant_release_chunk_links
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

REVOKE ALL ON platform.app_package_revisions FROM PUBLIC;
REVOKE ALL ON platform.immutable_release_write_guard FROM PUBLIC;
REVOKE ALL ON platform.release_artifact_blobs FROM PUBLIC;
REVOKE ALL ON platform.tenant_releases FROM PUBLIC;
REVOKE ALL ON platform.tenant_release_artifact_links FROM PUBLIC;
REVOKE ALL ON platform.tenant_release_projection_links FROM PUBLIC;
REVOKE ALL ON platform.tenant_release_chunk_links FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.stage_release_artifact(text, text, text, text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.read_tenant_release_artifacts(uuid) FROM PUBLIC;

GRANT SELECT, INSERT ON platform.app_package_revisions TO north_star_runtime;
GRANT SELECT, INSERT ON platform.tenant_releases TO north_star_runtime;
GRANT SELECT, INSERT ON platform.tenant_release_artifact_links TO north_star_runtime;
GRANT SELECT, INSERT ON platform.tenant_release_projection_links TO north_star_runtime;
GRANT SELECT, INSERT ON platform.tenant_release_chunk_links TO north_star_runtime;
GRANT EXECUTE ON FUNCTION platform.stage_release_artifact(text, text, text, text, bytea)
  TO north_star_runtime;
GRANT EXECUTE ON FUNCTION platform.read_tenant_release_artifacts(uuid)
  TO north_star_runtime;
