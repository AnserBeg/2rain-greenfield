CREATE TABLE platform.saved_master_filters (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  filter_id uuid NOT NULL,
  name text NOT NULL,
  query_id text NOT NULL,
  criteria_canonical_json text NOT NULL,
  language_version text NOT NULL,
  normalization_profile_version text NOT NULL,
  position_profile_version text NOT NULL,
  authored_release_id uuid NOT NULL,
  authored_release_content_hash text NOT NULL,
  lifecycle text NOT NULL DEFAULT 'active',
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (
    tenant_id,
    environment_id,
    owner_principal_id,
    filter_id
  ),
  CONSTRAINT saved_master_filters_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT saved_master_filters_release_fkey
    FOREIGN KEY (tenant_id, environment_id, authored_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT saved_master_filters_shape CHECK (
    btrim(name) <> ''
    AND length(name) <= 120
    AND query_id ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(\.[a-z0-9_-]+)*$'
    AND octet_length(criteria_canonical_json) <= 4000
    AND criteria_canonical_json IS JSON OBJECT WITH UNIQUE KEYS
    AND btrim(language_version) <> ''
    AND btrim(normalization_profile_version) <> ''
    AND position_profile_version = 'northstar.predicate-position.saved-filter/v1'
    AND authored_release_content_hash ~ '^[0-9a-f]{64}$'
    AND lifecycle IN ('active', 'revoked')
    AND revision >= 1
  )
);

CREATE INDEX saved_master_filters_scope_query_idx
  ON platform.saved_master_filters (
    tenant_id,
    environment_id,
    owner_principal_id,
    query_id,
    lifecycle,
    filter_id
  );

CREATE RULE saved_master_filters_reject_delete
AS ON DELETE TO platform.saved_master_filters
DO INSTEAD
  INSERT INTO platform.trust_immutable_write_guard (attempted_relation)
  VALUES ('saved_master_filters');

ALTER TABLE platform.saved_master_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.saved_master_filters FORCE ROW LEVEL SECURITY;

CREATE POLICY saved_master_filters_select_trusted_scope
  ON platform.saved_master_filters
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND owner_principal_id = nullif(current_setting('north_star.principal_id', true), '')::uuid
  );

CREATE POLICY saved_master_filters_insert_trusted_scope
  ON platform.saved_master_filters
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND owner_principal_id = nullif(current_setting('north_star.principal_id', true), '')::uuid
  );

CREATE POLICY saved_master_filters_update_trusted_scope
  ON platform.saved_master_filters
  AS PERMISSIVE
  FOR UPDATE
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND owner_principal_id = nullif(current_setting('north_star.principal_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND owner_principal_id = nullif(current_setting('north_star.principal_id', true), '')::uuid
  );

REVOKE ALL ON platform.saved_master_filters FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON platform.saved_master_filters
  TO north_star_runtime;
