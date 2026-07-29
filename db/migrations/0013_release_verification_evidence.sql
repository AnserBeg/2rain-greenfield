ALTER TABLE platform.tenant_releases
  ADD CONSTRAINT tenant_releases_admission_identity_unique
  UNIQUE (
    tenant_id,
    environment_id,
    release_id,
    verification_evidence_id
  );

CREATE TABLE platform.release_verification_evidence (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  verification_evidence_id uuid NOT NULL,
  evidence_version text NOT NULL,
  release_root text NOT NULL,
  artifact_closure_digest text NOT NULL,
  verification_plan_artifact_root text NOT NULL,
  verification_plan_semantic_digest text NOT NULL,
  verification_plan_digest text NOT NULL,
  result_set_digest text NOT NULL,
  result_count integer NOT NULL,
  provider text NOT NULL,
  provider_run_id text NOT NULL,
  executed_tenant_id uuid NOT NULL,
  executed_environment_id uuid NOT NULL,
  executed_evidence_id uuid NOT NULL,
  execution_scope text NOT NULL,
  skipped_scenario_ids jsonb NOT NULL,
  impact_analysis_derivation jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, verification_evidence_id),
  CONSTRAINT release_verification_evidence_identity_unique
    UNIQUE (verification_evidence_id),
  CONSTRAINT release_verification_evidence_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT release_verification_evidence_executed_environment_fkey
    FOREIGN KEY (executed_tenant_id, executed_environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT release_verification_evidence_execution_source_fkey
    FOREIGN KEY (
      executed_tenant_id,
      executed_environment_id,
      executed_evidence_id
    ) REFERENCES platform.release_verification_evidence (
      tenant_id,
      environment_id,
      verification_evidence_id
    ),
  CONSTRAINT release_verification_evidence_version CHECK (
    evidence_version = 'northstar.verification-result-set/v1'
  ),
  CONSTRAINT release_verification_evidence_digests CHECK (
    release_root ~ '^[0-9a-f]{64}$'
    AND artifact_closure_digest ~ '^[0-9a-f]{64}$'
    AND verification_plan_artifact_root ~ '^[0-9a-f]{64}$'
    AND verification_plan_semantic_digest ~ '^[0-9a-f]{64}$'
    AND verification_plan_digest ~ '^[0-9a-f]{64}$'
    AND result_set_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT release_verification_evidence_full_execution CHECK (
    result_count >= 0
    AND provider = 'realPostgresql'
    AND btrim(provider_run_id) <> ''
    AND executed_evidence_id IS NOT NULL
    AND execution_scope = 'FULL'
    AND skipped_scenario_ids = '[]'::jsonb
    AND impact_analysis_derivation IS NULL
  )
);

CREATE TABLE platform.release_verification_results (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  verification_evidence_id uuid NOT NULL,
  scenario_id text NOT NULL,
  scenario_fingerprint text NOT NULL,
  result_version text NOT NULL,
  positive_probe_digest text NOT NULL,
  negative_probe_digest text,
  provider text NOT NULL,
  provider_run_id text NOT NULL,
  PRIMARY KEY (
    tenant_id,
    environment_id,
    verification_evidence_id,
    scenario_id
  ),
  CONSTRAINT release_verification_results_evidence_fkey
    FOREIGN KEY (tenant_id, environment_id, verification_evidence_id)
    REFERENCES platform.release_verification_evidence (
      tenant_id,
      environment_id,
      verification_evidence_id
    ),
  CONSTRAINT release_verification_results_shape CHECK (
    btrim(scenario_id) <> ''
    AND scenario_fingerprint ~ '^[0-9a-f]{64}$'
    AND result_version = 'northstar.verification-result/v1'
    AND positive_probe_digest ~ '^[0-9a-f]{64}$'
    AND (
      negative_probe_digest IS NULL
      OR negative_probe_digest ~ '^[0-9a-f]{64}$'
    )
    AND provider = 'realPostgresql'
    AND btrim(provider_run_id) <> ''
  )
);

CREATE TABLE platform.tenant_release_admissions (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  release_id uuid NOT NULL,
  verification_evidence_id uuid NOT NULL,
  admitted_by uuid NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, release_id),
  CONSTRAINT tenant_release_admissions_evidence_unique
    UNIQUE (tenant_id, environment_id, verification_evidence_id),
  CONSTRAINT tenant_release_admissions_candidate_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      release_id,
      verification_evidence_id
    ) REFERENCES platform.tenant_releases (
      tenant_id,
      environment_id,
      release_id,
      verification_evidence_id
    ),
  CONSTRAINT tenant_release_admissions_evidence_fkey
    FOREIGN KEY (tenant_id, environment_id, verification_evidence_id)
    REFERENCES platform.release_verification_evidence (
      tenant_id,
      environment_id,
      verification_evidence_id
    )
);

CREATE RULE release_verification_evidence_reject_update
AS ON UPDATE TO platform.release_verification_evidence
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('release_verification_evidence');

CREATE RULE release_verification_evidence_reject_delete
AS ON DELETE TO platform.release_verification_evidence
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('release_verification_evidence');

CREATE RULE release_verification_results_reject_update
AS ON UPDATE TO platform.release_verification_results
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('release_verification_results');

CREATE RULE release_verification_results_reject_delete
AS ON DELETE TO platform.release_verification_results
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('release_verification_results');

CREATE RULE tenant_release_admissions_reject_update
AS ON UPDATE TO platform.tenant_release_admissions
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('tenant_release_admissions');

CREATE RULE tenant_release_admissions_reject_delete
AS ON DELETE TO platform.tenant_release_admissions
DO INSTEAD
  INSERT INTO platform.immutable_release_write_guard (attempted_relation)
  VALUES ('tenant_release_admissions');

ALTER TABLE platform.release_verification_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_verification_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_verification_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_verification_results FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_release_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_release_admissions FORCE ROW LEVEL SECURITY;

CREATE POLICY release_verification_evidence_select_trusted_context
  ON platform.release_verification_evidence
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE POLICY release_verification_evidence_insert_trusted_context
  ON platform.release_verification_evidence
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND created_by = nullif(current_setting('north_star.principal_id', true), '')::uuid
  );

CREATE POLICY release_verification_results_select_trusted_context
  ON platform.release_verification_results
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE POLICY release_verification_results_insert_trusted_context
  ON platform.release_verification_results
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE POLICY tenant_release_admissions_select_trusted_context
  ON platform.tenant_release_admissions
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE POLICY tenant_release_admissions_insert_trusted_context
  ON platform.tenant_release_admissions
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND admitted_by = nullif(current_setting('north_star.principal_id', true), '')::uuid
  );

REVOKE ALL ON platform.release_verification_evidence FROM PUBLIC;
REVOKE ALL ON platform.release_verification_results FROM PUBLIC;
REVOKE ALL ON platform.tenant_release_admissions FROM PUBLIC;
GRANT SELECT, INSERT ON platform.release_verification_evidence
  TO north_star_runtime;
GRANT SELECT, INSERT ON platform.release_verification_results
  TO north_star_runtime;
GRANT SELECT, INSERT ON platform.tenant_release_admissions
  TO north_star_runtime;
