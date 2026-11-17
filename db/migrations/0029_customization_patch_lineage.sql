-- ADR-0013: a tenant customization keeps the typed semantic patch it was made
-- of, append-only, beside the revision it produced. The patch is data-plane
-- intent, never runtime authority: no release manifest, projection or pointer
-- reads this table, and it is not a canonical family.
--
-- Each row binds the typed payload (with a digest the database checks), the
-- trusted tenant and environment, the authoring actor and channel (plan §5.6's
-- five), the first-party base it was authored against, the parent and the
-- resulting revision, the language and normalization profile versions it was
-- interpreted under, and the trusted creation time. There is no update or
-- delete path: a superseding patch is a new row.
CREATE TABLE platform.customization_patches (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  patch_id uuid NOT NULL,
  patch_version text NOT NULL,
  patch_kind text NOT NULL,
  payload bytea NOT NULL,
  payload_digest text NOT NULL,
  channel text NOT NULL,
  authored_by uuid NOT NULL,
  base_package_id text NOT NULL,
  base_package_version text NOT NULL,
  base_revision_id uuid NOT NULL,
  base_release_root text NOT NULL,
  parent_revision_id uuid NOT NULL,
  resulting_revision_id uuid NOT NULL,
  resulting_release_id uuid NOT NULL,
  language_version text NOT NULL,
  normalization_profile_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, patch_id),
  CONSTRAINT customization_patches_id_unique UNIQUE (patch_id),
  CONSTRAINT customization_patches_one_per_draft
    UNIQUE (tenant_id, environment_id, parent_revision_id, payload_digest),
  CONSTRAINT customization_patches_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT customization_patches_base_revision_fkey
    FOREIGN KEY (tenant_id, base_revision_id)
    REFERENCES platform.app_package_revisions (tenant_id, revision_id),
  CONSTRAINT customization_patches_parent_revision_fkey
    FOREIGN KEY (tenant_id, parent_revision_id)
    REFERENCES platform.app_package_revisions (tenant_id, revision_id),
  CONSTRAINT customization_patches_resulting_revision_fkey
    FOREIGN KEY (tenant_id, resulting_revision_id)
    REFERENCES platform.app_package_revisions (tenant_id, revision_id),
  CONSTRAINT customization_patches_resulting_release_fkey
    FOREIGN KEY (tenant_id, environment_id, resulting_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT customization_patches_shape CHECK (
    patch_version = 'northstar.customization-patch/v1'
    AND patch_kind IN (
      'addRecordType', 'addField', 'addChoice', 'arrangeLayout'
    )
    AND octet_length(payload) BETWEEN 2 AND 65536
    AND payload_digest = encode(sha256(payload), 'hex')
    AND channel IN (
      'firstPartyAuthoring',
      'visualBuilder',
      'conversationalAi',
      'importTemplate',
      'declarativeEditor'
    )
    AND btrim(base_package_id) <> ''
    AND base_package_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    AND base_release_root ~ '^[0-9a-f]{64}$'
    AND parent_revision_id <> resulting_revision_id
    AND btrim(language_version) <> ''
    AND btrim(normalization_profile_version) <> ''
  )
);

CREATE INDEX customization_patches_resulting_revision_idx
  ON platform.customization_patches (tenant_id, resulting_revision_id);

CREATE RULE customization_patches_reject_update
AS ON UPDATE TO platform.customization_patches
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('customization_patches');

CREATE RULE customization_patches_reject_delete
AS ON DELETE TO platform.customization_patches
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('customization_patches');

ALTER TABLE platform.customization_patches ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.customization_patches FORCE ROW LEVEL SECURITY;

CREATE POLICY customization_patches_select_trusted_context
  ON platform.customization_patches
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id =
      nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE POLICY customization_patches_insert_trusted_context
  ON platform.customization_patches
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id =
      nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND authored_by =
      nullif(current_setting('north_star.principal_id', true), '')::uuid
  );

GRANT SELECT, INSERT ON platform.customization_patches TO north_star_runtime;
