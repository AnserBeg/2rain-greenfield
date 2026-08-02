CREATE TABLE platform.fresh_tenant_intermediate_release_admissions (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  release_id uuid NOT NULL,
  release_evidence_id uuid NOT NULL,
  install_id uuid NOT NULL,
  lineage_ordinal integer NOT NULL,
  release_root text NOT NULL,
  source_release_root text,
  evidence_version text NOT NULL,
  evidence_digest text NOT NULL,
  admitted_by uuid NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, release_id),
  CONSTRAINT fresh_tenant_intermediate_release_admissions_evidence_unique
    UNIQUE (tenant_id, environment_id, release_evidence_id),
  CONSTRAINT fresh_tenant_intermediate_release_admissions_ordinal_unique
    UNIQUE (tenant_id, environment_id, install_id, lineage_ordinal),
  CONSTRAINT fresh_tenant_intermediate_release_admissions_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT fresh_tenant_intermediate_release_admissions_candidate_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      release_id,
      release_evidence_id
    ) REFERENCES platform.tenant_releases (
      tenant_id,
      environment_id,
      release_id,
      verification_evidence_id
    ),
  CONSTRAINT fresh_tenant_intermediate_release_admissions_shape CHECK (
    evidence_version =
      'northstar.fresh-tenant-intermediate-release-admission/v1'
    AND lineage_ordinal >= 0
    AND release_root ~ '^[0-9a-f]{64}$'
    AND (
      source_release_root IS NULL
      OR source_release_root ~ '^[0-9a-f]{64}$'
    )
    AND evidence_digest ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE platform.fresh_tenant_install_evidence (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  install_id uuid NOT NULL,
  serving_release_id uuid NOT NULL,
  serving_release_root text NOT NULL,
  serving_scenario_count integer NOT NULL,
  evidence_version text NOT NULL,
  evidence_document jsonb NOT NULL,
  evidence_digest text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, install_id),
  CONSTRAINT fresh_tenant_install_evidence_serving_release_fkey
    FOREIGN KEY (tenant_id, environment_id, serving_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT fresh_tenant_install_evidence_shape CHECK (
    serving_release_root ~ '^[0-9a-f]{64}$'
    AND serving_scenario_count >= 0
    AND evidence_version = 'northstar.fresh-tenant-install-evidence/v1'
    AND evidence_digest ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(evidence_document) = 'object'
    AND evidence_document ->> 'schemaVersion' =
      'northstar.fresh-tenant-install-evidence/v1'
    AND jsonb_typeof(
      evidence_document -> 'nonServingReleasesWithoutScenarioExecution'
    ) = 'array'
    AND jsonb_typeof(evidence_document -> 'appliedTransitions') = 'array'
    AND jsonb_typeof(evidence_document -> 'servingRelease') = 'object'
    AND evidence_document - ARRAY[
      'schemaVersion',
      'nonServingReleasesWithoutScenarioExecution',
      'appliedTransitions',
      'servingRelease'
    ]::text[] = '{}'::jsonb
  )
);

CREATE RULE fresh_tenant_intermediate_release_admissions_reject_update
AS ON UPDATE TO platform.fresh_tenant_intermediate_release_admissions
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('fresh_tenant_intermediate_release_admissions');

CREATE RULE fresh_tenant_intermediate_release_admissions_reject_delete
AS ON DELETE TO platform.fresh_tenant_intermediate_release_admissions
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('fresh_tenant_intermediate_release_admissions');

CREATE RULE fresh_tenant_install_evidence_reject_update
AS ON UPDATE TO platform.fresh_tenant_install_evidence
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('fresh_tenant_install_evidence');

CREATE RULE fresh_tenant_install_evidence_reject_delete
AS ON DELETE TO platform.fresh_tenant_install_evidence
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('fresh_tenant_install_evidence');

ALTER TABLE platform.fresh_tenant_intermediate_release_admissions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.fresh_tenant_intermediate_release_admissions
  FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.fresh_tenant_install_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.fresh_tenant_install_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY fresh_tenant_intermediate_admissions_select_trusted_context
  ON platform.fresh_tenant_intermediate_release_admissions
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id =
      nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE POLICY fresh_tenant_intermediate_admissions_insert_trusted_context
  ON platform.fresh_tenant_intermediate_release_admissions
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id =
      nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND admitted_by =
      nullif(current_setting('north_star.principal_id', true), '')::uuid
  );

CREATE POLICY fresh_tenant_install_evidence_select_trusted_context
  ON platform.fresh_tenant_install_evidence
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id =
      nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE POLICY fresh_tenant_install_evidence_insert_trusted_context
  ON platform.fresh_tenant_install_evidence
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id =
      nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND created_by =
      nullif(current_setting('north_star.principal_id', true), '')::uuid
  );

REVOKE ALL ON platform.fresh_tenant_intermediate_release_admissions FROM PUBLIC;
REVOKE ALL ON platform.fresh_tenant_install_evidence FROM PUBLIC;
GRANT SELECT, INSERT ON platform.fresh_tenant_intermediate_release_admissions
  TO north_star_runtime;
GRANT SELECT, INSERT ON platform.fresh_tenant_install_evidence
  TO north_star_runtime;
