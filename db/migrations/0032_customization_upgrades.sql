-- UPGRADE-1: replay intent is separate from the immutable authored patches.
-- The activation parent remains the prior live tenant revision.
CREATE TABLE platform.customization_upgrades (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  upgrade_id uuid NOT NULL,
  source_release_id uuid NOT NULL,
  base_release_id uuid NOT NULL,
  candidate_release_id uuid NOT NULL,
  candidate_revision_id uuid NOT NULL,
  payload bytea NOT NULL,
  payload_digest text NOT NULL,
  authored_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, upgrade_id),
  CONSTRAINT customization_upgrades_one_per_pair
    UNIQUE (tenant_id, environment_id, source_release_id, base_release_id),
  CONSTRAINT customization_upgrades_one_per_candidate
    UNIQUE (tenant_id, environment_id, candidate_revision_id),
  CONSTRAINT customization_upgrades_source_fkey
    FOREIGN KEY (tenant_id, environment_id, source_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT customization_upgrades_base_fkey
    FOREIGN KEY (tenant_id, environment_id, base_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT customization_upgrades_candidate_fkey
    FOREIGN KEY (tenant_id, environment_id, candidate_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT customization_upgrades_revision_fkey
    FOREIGN KEY (tenant_id, candidate_revision_id)
    REFERENCES platform.app_package_revisions (tenant_id, revision_id),
  CONSTRAINT customization_upgrades_binding CHECK ((
    octet_length(payload) BETWEEN 2 AND 65536
    AND payload_digest = encode(sha256(payload), 'hex')
    AND convert_from(payload, 'UTF8')::jsonb ->> 'version' = 'northstar.customization-upgrade/v1'
    AND convert_from(payload, 'UTF8')::jsonb ->> 'sourceReleaseId' = source_release_id::text
    AND convert_from(payload, 'UTF8')::jsonb ->> 'baseReleaseId' = base_release_id::text
    AND convert_from(payload, 'UTF8')::jsonb ->> 'candidateReleaseId' = candidate_release_id::text
    AND convert_from(payload, 'UTF8')::jsonb ->> 'candidateRevisionId' = candidate_revision_id::text
    AND jsonb_typeof(convert_from(payload, 'UTF8')::jsonb -> 'patchIds') = 'array'
    AND jsonb_array_length(convert_from(payload, 'UTF8')::jsonb -> 'patchIds') BETWEEN 1 AND 64
    AND source_release_id <> candidate_release_id
    AND base_release_id <> candidate_release_id
  ) IS TRUE)
);

CREATE RULE customization_upgrades_reject_update
AS ON UPDATE TO platform.customization_upgrades
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('customization_upgrades');

CREATE RULE customization_upgrades_reject_delete
AS ON DELETE TO platform.customization_upgrades
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('customization_upgrades');

ALTER TABLE platform.customization_upgrades ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.customization_upgrades FORCE ROW LEVEL SECURITY;

CREATE POLICY customization_upgrades_select_trusted_context
  ON platform.customization_upgrades
  FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE POLICY customization_upgrades_insert_trusted_context
  ON platform.customization_upgrades
  FOR INSERT TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND authored_by = nullif(current_setting('north_star.principal_id', true), '')::uuid
  );

GRANT SELECT, INSERT ON platform.customization_upgrades TO north_star_runtime;
