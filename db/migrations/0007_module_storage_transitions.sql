CREATE ROLE north_star_module_materializer
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE north_star_module_runtime
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE SCHEMA north_star_module AUTHORIZATION north_star_module_materializer;
REVOKE ALL ON SCHEMA north_star_module FROM PUBLIC;
GRANT USAGE ON SCHEMA north_star_module TO north_star_module_runtime;

CREATE FUNCTION north_star_internal.trusted_tenant_id()
RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('north_star.tenant_id', true), '')::uuid $$;
CREATE FUNCTION north_star_internal.trusted_environment_id()
RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('north_star.environment_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION north_star_internal.trusted_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION north_star_internal.trusted_environment_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION north_star_internal.trusted_tenant_id(),
  north_star_internal.trusted_environment_id() TO north_star_module_runtime;
GRANT USAGE ON SCHEMA north_star_internal TO north_star_module_runtime;

CREATE TABLE north_star_internal.module_storage_generations (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  generation_number bigint NOT NULL,
  source_release_id uuid NOT NULL,
  source_manifest_root bytea NOT NULL,
  target_release_id uuid NOT NULL,
  target_manifest_root bytea NOT NULL,
  preparation_id uuid NOT NULL,
  prepared_subset_digest bytea NOT NULL,
  remaining_plan_digest bytea NOT NULL,
  transition_plan_digest bytea NOT NULL,
  transition_artifact_root text NOT NULL,
  target_artifact_root text NOT NULL,
  state text NOT NULL,
  expires_at timestamptz NOT NULL,
  tenant_lifecycle text NOT NULL DEFAULT 'ACTIVE',
  ancient_root_disposition text NOT NULL DEFAULT 'NONE',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, generation_id),
  CONSTRAINT module_storage_generations_id_unique UNIQUE (generation_id),
  CONSTRAINT module_storage_generations_preparation_unique UNIQUE (preparation_id),
  CONSTRAINT module_storage_generations_source_release_fkey
    FOREIGN KEY (tenant_id, environment_id, source_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT module_storage_generations_target_release_fkey
    FOREIGN KEY (tenant_id, environment_id, target_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT module_storage_generations_shape CHECK (
    generation_number > 0
    AND octet_length(source_manifest_root) = 32
    AND octet_length(target_manifest_root) = 32
    AND octet_length(prepared_subset_digest) = 32
    AND octet_length(remaining_plan_digest) = 32
    AND octet_length(transition_plan_digest) = 32
    AND transition_artifact_root ~ '^[0-9a-f]{64}$'
    AND target_artifact_root ~ '^[0-9a-f]{64}$'
    AND state IN ('PREPARING', 'PREPARED', 'IN_ATTEMPT', 'READY_TO_SWAP',
                  'SWAPPED', 'RECONCILING', 'FAILED', 'EXPIRED')
    AND tenant_lifecycle IN ('ACTIVE', 'SUSPENDED', 'DECOMMISSIONED')
    AND ancient_root_disposition IN ('NONE', 'MIGRATE', 'ISOLATE')
    AND expires_at > created_at
  )
);
CREATE UNIQUE INDEX module_storage_generations_number_idx
  ON north_star_internal.module_storage_generations (
    tenant_id, environment_id, generation_number
  );
ALTER TABLE north_star_internal.module_storage_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE north_star_internal.module_storage_generations FORCE ROW LEVEL SECURITY;
CREATE POLICY module_storage_generations_materializer
  ON north_star_internal.module_storage_generations
  FOR ALL TO north_star_module_materializer USING (true) WITH CHECK (true);
CREATE POLICY module_storage_generations_runtime_select
  ON north_star_internal.module_storage_generations
  FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE TABLE north_star_internal.module_storage_elements (
  element_id text PRIMARY KEY,
  element_kind text NOT NULL,
  physical_object_name text NOT NULL,
  shape_fingerprint text NOT NULL,
  first_generation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT module_storage_elements_generation_fkey FOREIGN KEY (first_generation_id)
    REFERENCES north_star_internal.module_storage_generations (generation_id),
  CONSTRAINT module_storage_elements_shape CHECK (
    btrim(element_id) <> ''
    AND element_kind IN ('addColumn', 'addForeignKey', 'addNotValidConstraint',
      'backfill', 'createIndex', 'createTable', 'duplicateScan',
      'tightenNotNull', 'validateConstraint')
    AND btrim(physical_object_name) <> ''
    AND shape_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE north_star_internal.module_storage_element_applications (
  application_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  element_id text NOT NULL,
  attempt_id uuid,
  application_state text NOT NULL,
  application_digest bytea NOT NULL,
  detail_code text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT module_storage_applications_generation_fkey
    FOREIGN KEY (tenant_id, environment_id, generation_id)
    REFERENCES north_star_internal.module_storage_generations (
      tenant_id, environment_id, generation_id
    ),
  CONSTRAINT module_storage_applications_element_fkey FOREIGN KEY (element_id)
    REFERENCES north_star_internal.module_storage_elements (element_id),
  CONSTRAINT module_storage_applications_shape CHECK (
    application_state IN ('STARTED', 'APPLIED', 'VERIFIED', 'FAILED', 'RECONCILING')
    AND octet_length(application_digest) = 32 AND btrim(detail_code) <> ''
  )
);
CREATE INDEX module_storage_element_applications_lookup_idx
  ON north_star_internal.module_storage_element_applications (
    tenant_id, environment_id, generation_id, element_id, recorded_at DESC
  );

CREATE TABLE north_star_internal.module_storage_root_membership (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  release_id uuid NOT NULL,
  release_root text NOT NULL,
  generation_id uuid NOT NULL,
  element_id text NOT NULL,
  provenance_artifact_root text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, release_id, element_id),
  CONSTRAINT module_storage_root_membership_release_fkey
    FOREIGN KEY (tenant_id, environment_id, release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT module_storage_root_membership_generation_fkey FOREIGN KEY (generation_id)
    REFERENCES north_star_internal.module_storage_generations (generation_id),
  CONSTRAINT module_storage_root_membership_element_fkey FOREIGN KEY (element_id)
    REFERENCES north_star_internal.module_storage_elements (element_id),
  CONSTRAINT module_storage_root_membership_hashes CHECK (
    release_root ~ '^[0-9a-f]{64}$'
    AND provenance_artifact_root ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE north_star_internal.module_storage_reference_counts (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  element_id text NOT NULL,
  live_root_count bigint NOT NULL,
  last_full_reconciliation_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, generation_id, element_id),
  CONSTRAINT module_storage_reference_counts_generation_fkey
    FOREIGN KEY (tenant_id, environment_id, generation_id)
    REFERENCES north_star_internal.module_storage_generations (
      tenant_id, environment_id, generation_id
    ),
  CONSTRAINT module_storage_reference_counts_element_fkey FOREIGN KEY (element_id)
    REFERENCES north_star_internal.module_storage_elements (element_id),
  CONSTRAINT module_storage_reference_counts_nonnegative CHECK (live_root_count >= 0)
);

CREATE TABLE north_star_internal.module_storage_tightening_debt (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  debt_id text NOT NULL,
  element_id text NOT NULL,
  owner_id text NOT NULL,
  prerequisites jsonb NOT NULL,
  blocking_root_ids jsonb NOT NULL,
  resolved_at timestamptz,
  PRIMARY KEY (tenant_id, environment_id, generation_id, debt_id),
  CONSTRAINT module_storage_tightening_debt_generation_fkey
    FOREIGN KEY (tenant_id, environment_id, generation_id)
    REFERENCES north_star_internal.module_storage_generations (
      tenant_id, environment_id, generation_id
    ),
  CONSTRAINT module_storage_tightening_debt_element_fkey FOREIGN KEY (element_id)
    REFERENCES north_star_internal.module_storage_elements (element_id),
  CONSTRAINT module_storage_tightening_debt_shape CHECK (
    btrim(debt_id) <> '' AND btrim(owner_id) <> ''
    AND jsonb_typeof(prerequisites) = 'array'
    AND jsonb_typeof(blocking_root_ids) = 'array'
  )
);

CREATE TABLE north_star_internal.module_storage_backfill_checkpoints (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  element_id text NOT NULL,
  activation_attempt_id uuid NOT NULL,
  last_record_id uuid,
  rows_applied bigint NOT NULL DEFAULT 0,
  complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, generation_id, element_id),
  CONSTRAINT module_storage_backfill_generation_fkey
    FOREIGN KEY (tenant_id, environment_id, generation_id)
    REFERENCES north_star_internal.module_storage_generations (
      tenant_id, environment_id, generation_id
    ),
  CONSTRAINT module_storage_backfill_element_fkey FOREIGN KEY (element_id)
    REFERENCES north_star_internal.module_storage_elements (element_id),
  CONSTRAINT module_storage_backfill_attempt_fkey
    FOREIGN KEY (tenant_id, environment_id, activation_attempt_id)
    REFERENCES platform.release_activation_attempts (
      tenant_id, environment_id, activation_attempt_id
    ),
  CONSTRAINT module_storage_backfill_rows_nonnegative CHECK (rows_applied >= 0)
);

CREATE TABLE north_star_internal.module_storage_attempt_claims (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  activation_attempt_id uuid NOT NULL,
  coordinator_id uuid NOT NULL,
  claim_state text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, activation_attempt_id),
  CONSTRAINT module_storage_attempt_claims_generation_unique
    UNIQUE (tenant_id, environment_id, generation_id),
  CONSTRAINT module_storage_attempt_claims_generation_fkey
    FOREIGN KEY (tenant_id, environment_id, generation_id)
    REFERENCES north_star_internal.module_storage_generations (
      tenant_id, environment_id, generation_id
    ),
  CONSTRAINT module_storage_attempt_claims_attempt_fkey
    FOREIGN KEY (tenant_id, environment_id, activation_attempt_id)
    REFERENCES platform.release_activation_attempts (
      tenant_id, environment_id, activation_attempt_id
    ),
  CONSTRAINT module_storage_attempt_claims_shape CHECK (
    claim_state IN ('CLAIMED', 'COMPLETED', 'FAILED', 'RECONCILING')
  )
);

CREATE TABLE north_star_internal.module_storage_catalog_receipts (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  receipt_id uuid PRIMARY KEY,
  receipt_version text NOT NULL,
  generation_id uuid NOT NULL,
  source_release_id uuid NOT NULL,
  source_manifest_root bytea NOT NULL,
  target_release_id uuid NOT NULL,
  target_manifest_root bytea NOT NULL,
  prepared_subset_digest bytea NOT NULL,
  remaining_plan_digest bytea NOT NULL,
  catalog_digest bytea NOT NULL,
  receipt_state text NOT NULL,
  catalog_verified boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT module_storage_catalog_receipts_generation_fkey
    FOREIGN KEY (tenant_id, environment_id, generation_id)
    REFERENCES north_star_internal.module_storage_generations (
      tenant_id, environment_id, generation_id
    ),
  CONSTRAINT module_storage_catalog_receipts_release_fkey
    FOREIGN KEY (tenant_id, environment_id, source_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT module_storage_catalog_receipts_target_release_fkey
    FOREIGN KEY (tenant_id, environment_id, target_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT module_storage_catalog_receipts_shape CHECK (
    receipt_version = 'northstar.module-storage-catalog-receipt/v1'
    AND octet_length(source_manifest_root) = 32
    AND octet_length(target_manifest_root) = 32
    AND octet_length(prepared_subset_digest) = 32
    AND octet_length(remaining_plan_digest) = 32
    AND octet_length(catalog_digest) = 32
    AND receipt_state IN ('PREPARED', 'READY_TO_SWAP', 'RECONCILED', 'DRIFT')
    AND (receipt_state = 'DRIFT' OR catalog_verified)
  )
);
CREATE UNIQUE INDEX module_storage_catalog_receipts_ready_idx
  ON north_star_internal.module_storage_catalog_receipts (
    tenant_id, environment_id, generation_id
  ) WHERE receipt_state = 'READY_TO_SWAP' AND catalog_verified;
ALTER TABLE north_star_internal.module_storage_catalog_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE north_star_internal.module_storage_catalog_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY module_storage_catalog_receipts_materializer
  ON north_star_internal.module_storage_catalog_receipts
  FOR ALL TO north_star_module_materializer USING (true) WITH CHECK (true);
CREATE POLICY module_storage_catalog_receipts_runtime_select
  ON north_star_internal.module_storage_catalog_receipts
  FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

CREATE RULE module_storage_element_applications_reject_update
AS ON UPDATE TO north_star_internal.module_storage_element_applications
DO INSTEAD NOTHING;
CREATE RULE module_storage_element_applications_reject_delete
AS ON DELETE TO north_star_internal.module_storage_element_applications
DO INSTEAD NOTHING;
CREATE RULE module_storage_catalog_receipts_reject_update
AS ON UPDATE TO north_star_internal.module_storage_catalog_receipts
DO INSTEAD NOTHING;
CREATE RULE module_storage_catalog_receipts_reject_delete
AS ON DELETE TO north_star_internal.module_storage_catalog_receipts
DO INSTEAD NOTHING;
CREATE RULE module_storage_root_membership_reject_delete
AS ON DELETE TO north_star_internal.module_storage_root_membership
DO INSTEAD NOTHING;

ALTER TABLE platform.transition_preparation_receipts
  ADD COLUMN generation_id uuid,
  ADD COLUMN prepared_subset_digest bytea,
  ADD COLUMN remaining_plan_digest bytea,
  ADD COLUMN executor_schema_state text,
  ADD COLUMN executor_data_state text,
  ADD CONSTRAINT transition_preparation_receipts_generation_fkey
    FOREIGN KEY (tenant_id, environment_id, generation_id)
    REFERENCES north_star_internal.module_storage_generations (
      tenant_id, environment_id, generation_id
    );
ALTER TABLE platform.transition_preparation_receipts
  DROP CONSTRAINT transition_preparation_receipts_versions,
  ADD CONSTRAINT transition_preparation_receipts_versions CHECK (
    (receipt_version = 'northstar.transition-preparation-receipt/v1'
      AND compiler_facts_version = 'northstar.compiler-transition-facts/v1'
      AND executor_evidence_version = 'northstar.executor-applied-state-evidence/v1'
      AND compatibility_policy_version = 'northstar.transition-compatibility-policy/v1'
      AND generation_id IS NULL AND prepared_subset_digest IS NULL
      AND remaining_plan_digest IS NULL AND executor_schema_state IS NULL
      AND executor_data_state IS NULL)
    OR
    (receipt_version = 'northstar.transition-preparation-receipt/v2'
      AND compiler_facts_version = 'northstar.compiler-transition-facts/v1'
      AND executor_evidence_version = 'northstar.executor-applied-state-evidence/v2'
      AND compatibility_policy_version = 'northstar.transition-compatibility-policy/v2'
      AND generation_id IS NOT NULL AND schema_generation > 0
      AND octet_length(prepared_subset_digest) = 32
      AND octet_length(remaining_plan_digest) = 32
      AND executor_schema_state IN ('APPLIED', 'NOT_REQUIRED')
      AND executor_data_state IN ('PENDING_IN_ATTEMPT', 'APPLIED', 'NOT_REQUIRED'))
  );

ALTER TABLE platform.release_approvals
  DROP CONSTRAINT release_approvals_contract_versions,
  ADD CONSTRAINT release_approvals_contract_versions CHECK (
    approval_contract_version = 'northstar.release-approval/v1'
    AND authority_policy_contract_version = 'northstar.release-approver-authority/v1'
    AND expiry_policy_version = 'northstar.release-approval-expiry/v1'
    AND compatibility_policy_version IN (
      'northstar.transition-compatibility-policy/v1',
      'northstar.transition-compatibility-policy/v2'
    )
  );

ALTER TABLE platform.release_activation_verification_receipts
  ADD COLUMN module_schema_conformance_passed boolean;
ALTER TABLE platform.release_activation_verification_receipts
  DROP CONSTRAINT release_activation_verification_receipts_shape,
  ADD CONSTRAINT release_activation_verification_receipts_shape CHECK (
    ((verification_version = 'northstar.release-activation-verification/v1'
       AND module_schema_conformance_passed IS NULL)
      OR (verification_version = 'northstar.release-activation-verification/v2'
       AND module_schema_conformance_passed IS NOT NULL))
    AND fence > 0 AND warning_count >= 0
    AND status IN ('SWAPPED_VERIFIED', 'SWAPPED_VERIFICATION_FAILED', 'SUPERSEDED')
    AND ((status = 'SWAPPED_VERIFIED' AND pointer_read_back_passed
          AND artifact_availability_passed AND release_kernel_invariants_passed
          AND coalesce(module_schema_conformance_passed, true) AND warning_count = 0)
      OR (status = 'SWAPPED_VERIFICATION_FAILED'
          AND (NOT pointer_read_back_passed OR NOT artifact_availability_passed
            OR NOT release_kernel_invariants_passed
            OR NOT coalesce(module_schema_conformance_passed, true)))
      OR status = 'SUPERSEDED')
  );

CREATE FUNCTION north_star_internal.module_storage_read_active_release_pointer(
  requested_tenant_id uuid,
  requested_environment_id uuid
)
RETURNS TABLE (fence bigint, release_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT pointer.fence, pointer.release_id
    FROM platform.active_release_pointers AS pointer
   WHERE requested_tenant_id IS NOT NULL
     AND requested_environment_id IS NOT NULL
     AND requested_tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND requested_environment_id =
           nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND pointer.tenant_id = requested_tenant_id
     AND pointer.environment_id = requested_environment_id
$$;

CREATE FUNCTION north_star_internal.module_storage_read_release_artifacts(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_release_id uuid
)
RETURNS TABLE (
  release_content_hash text,
  artifact_kind text,
  content_hash text,
  domain_tag text,
  canonical_bytes bytea
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH scoped_release AS MATERIALIZED (
    SELECT release.content_hash
      FROM platform.tenant_releases AS release
     WHERE requested_tenant_id IS NOT NULL
       AND requested_environment_id IS NOT NULL
       AND requested_release_id IS NOT NULL
       AND requested_tenant_id =
             nullif(current_setting('north_star.tenant_id', true), '')::uuid
       AND requested_environment_id =
             nullif(current_setting('north_star.environment_id', true), '')::uuid
       AND release.tenant_id = requested_tenant_id
       AND release.environment_id = requested_environment_id
       AND release.release_id = requested_release_id
  )
  SELECT release.content_hash,
         blob.artifact_kind,
         blob.content_hash,
         blob.domain_tag,
         blob.canonical_bytes
    FROM scoped_release AS release
    JOIN platform.release_artifact_blobs AS blob
      ON blob.content_hash = release.content_hash
  UNION ALL
  SELECT release.content_hash,
         blob.artifact_kind,
         blob.content_hash,
         blob.domain_tag,
         blob.canonical_bytes
    FROM scoped_release AS release
    JOIN platform.tenant_release_artifact_links AS link
      ON link.tenant_id = requested_tenant_id
     AND link.environment_id = requested_environment_id
     AND link.release_id = requested_release_id
    JOIN platform.release_artifact_blobs AS blob
      ON blob.content_hash = link.content_hash
     AND blob.artifact_kind = link.artifact_kind
   ORDER BY 3
$$;

CREATE FUNCTION north_star_internal.module_storage_read_preparation_authority(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_principal_id uuid
)
RETURNS TABLE (authorized boolean, denied boolean, paused boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT coalesce((
           SELECT event.authorized
             FROM platform.release_executor_authority_events AS event
            WHERE event.tenant_id = requested_tenant_id
              AND event.principal_id = requested_principal_id
            ORDER BY event.policy_version DESC
            LIMIT 1
         ), false),
         coalesce((
           SELECT event.live_policy_denied
             FROM platform.release_activation_control_events AS event
            WHERE event.tenant_id = requested_tenant_id
              AND event.environment_id = requested_environment_id
            ORDER BY event.policy_version DESC
            LIMIT 1
         ), false),
         coalesce((
           SELECT event.rollout_paused
             FROM platform.release_activation_control_events AS event
            WHERE event.tenant_id = requested_tenant_id
              AND event.environment_id = requested_environment_id
            ORDER BY event.policy_version DESC
            LIMIT 1
         ), false)
   WHERE requested_tenant_id IS NOT NULL
     AND requested_environment_id IS NOT NULL
     AND requested_principal_id IS NOT NULL
     AND requested_tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND requested_environment_id =
           nullif(current_setting('north_star.environment_id', true), '')::uuid
$$;

CREATE FUNCTION north_star_internal.module_storage_read_approved_attempt(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_activation_attempt_id uuid,
  requested_preparation_id uuid
)
RETURNS TABLE (approved boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$ BEGIN
  PERFORM 1
    FROM platform.release_activation_authority_epochs AS epoch
   WHERE epoch.tenant_id = requested_tenant_id
   FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM 1
    FROM platform.release_activation_attempts AS attempt
   WHERE attempt.tenant_id = requested_tenant_id
     AND attempt.environment_id = requested_environment_id
     AND attempt.activation_attempt_id = requested_activation_attempt_id
   FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT true AS approved
    FROM platform.release_activation_attempts AS attempt
    JOIN platform.release_approvals AS approval
      ON approval.tenant_id = attempt.tenant_id
     AND approval.environment_id = attempt.environment_id
     AND approval.approval_id = attempt.approval_id
     AND approval.activation_attempt_id = attempt.activation_attempt_id
    JOIN platform.release_activation_authority_epochs AS epoch
      ON epoch.tenant_id = attempt.tenant_id
   WHERE requested_tenant_id IS NOT NULL
     AND requested_environment_id IS NOT NULL
     AND requested_activation_attempt_id IS NOT NULL
     AND requested_preparation_id IS NOT NULL
     AND requested_tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND requested_environment_id =
           nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND attempt.tenant_id = requested_tenant_id
     AND attempt.environment_id = requested_environment_id
     AND attempt.activation_attempt_id = requested_activation_attempt_id
     AND attempt.attempt_contract_version =
           'northstar.release-activation-attempt/v1'
     AND attempt.execution_principal_kind = 'SYSTEM'
     AND attempt.execution_principal_id =
           '00000000-0000-4000-8000-000000000001'::uuid
     AND attempt.attempt_state = 'PREBOUND'
     AND approval.approval_contract_version = 'northstar.release-approval/v1'
     AND approval.authority_policy_contract_version =
           'northstar.release-approver-authority/v1'
     AND approval.expiry_policy_version = 'northstar.release-approval-expiry/v1'
     AND approval.compatibility_policy_version =
           'northstar.transition-compatibility-policy/v2'
     AND approval.preparation_id = requested_preparation_id
     AND approval.approving_human_id <> attempt.execution_principal_id
     AND clock_timestamp() < approval.expires_at - interval '3 seconds'
     AND epoch.approver_policy_version = approval.authority_policy_version
     AND (
       SELECT event.eligible
         FROM platform.release_approver_eligibility_events AS event
        WHERE event.tenant_id = attempt.tenant_id
          AND event.principal_id = approval.approving_human_id
          AND event.authority_policy_contract_version =
                'northstar.release-approver-authority/v1'
        ORDER BY event.policy_version DESC
        LIMIT 1
     ) IS TRUE
     AND (
       SELECT event.authorized
         FROM platform.release_executor_authority_events AS event
        WHERE event.tenant_id = attempt.tenant_id
          AND event.principal_id = attempt.execution_principal_id
          AND event.authority_policy_contract_version =
                'northstar.release-executor-authority/v1'
        ORDER BY event.policy_version DESC
        LIMIT 1
     ) IS TRUE
     AND NOT EXISTS (
       SELECT 1
         FROM (
           SELECT DISTINCT ON (control.rollout_id)
                  control.live_policy_denied,
                  control.rollout_paused,
                  control.control_policy_contract_version
             FROM platform.release_activation_control_events AS control
            WHERE control.tenant_id = attempt.tenant_id
              AND control.environment_id = attempt.environment_id
              AND (
                control.rollout_id IS NULL
                OR control.rollout_id IS NOT DISTINCT FROM approval.rollout_id
              )
            ORDER BY control.rollout_id, control.policy_version DESC
         ) AS current_control
        WHERE current_control.live_policy_denied
           OR current_control.rollout_paused
           OR current_control.control_policy_contract_version <>
                'northstar.release-activation-control/v1'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM platform.release_activation_attempt_outcomes AS outcome
        WHERE outcome.tenant_id = attempt.tenant_id
          AND outcome.environment_id = attempt.environment_id
          AND outcome.activation_attempt_id = attempt.activation_attempt_id
          AND (
            outcome.terminal
            OR outcome.workflow_disposition = 'CONSUMED'
            OR outcome.workflow_status IN ('PAUSED', 'FAILED', 'CANCELLED', 'SUCCEEDED')
          )
     )
     AND NOT EXISTS (
       SELECT 1
         FROM platform.release_activation_history AS history
        WHERE history.tenant_id = attempt.tenant_id
          AND history.environment_id = attempt.environment_id
          AND history.activation_attempt_id = attempt.activation_attempt_id
          AND (
            history.terminal
            OR history.workflow_disposition = 'CONSUMED'
            OR history.workflow_status IN ('PAUSED', 'FAILED', 'CANCELLED', 'SUCCEEDED')
          )
     ); END $$;

CREATE FUNCTION north_star_internal.module_storage_lock_backfill_attempt(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_activation_attempt_id uuid,
  requested_preparation_id uuid
)
RETURNS TABLE (authorized boolean)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT true
   WHERE EXISTS (
     SELECT approved
       FROM north_star_internal.module_storage_read_approved_attempt(
         requested_tenant_id,
         requested_environment_id,
         requested_activation_attempt_id,
         requested_preparation_id
       )
   )
$$;

CREATE FUNCTION north_star_internal.module_storage_read_kernel_live_roots(
  requested_tenant_id uuid,
  requested_environment_id uuid
)
RETURNS TABLE (release_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT pointer.release_id
    FROM platform.active_release_pointers AS pointer
   WHERE requested_tenant_id IS NOT NULL
     AND requested_environment_id IS NOT NULL
     AND requested_tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND requested_environment_id =
           nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND pointer.tenant_id = requested_tenant_id
     AND pointer.environment_id = requested_environment_id
     AND pointer.release_id IS NOT NULL
  UNION
  SELECT preparation.target_release_id
    FROM platform.release_activation_preparations AS preparation
    LEFT JOIN platform.release_approvals AS approval
      ON approval.tenant_id = preparation.tenant_id
     AND approval.environment_id = preparation.environment_id
     AND approval.preparation_id = preparation.preparation_id
    LEFT JOIN platform.release_activation_history AS history
      ON history.tenant_id = approval.tenant_id
     AND history.environment_id = approval.environment_id
     AND history.approval_id = approval.approval_id
     AND history.terminal
   WHERE requested_tenant_id IS NOT NULL
     AND requested_environment_id IS NOT NULL
     AND requested_tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND requested_environment_id =
           nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND preparation.tenant_id = requested_tenant_id
     AND preparation.environment_id = requested_environment_id
     AND history.approval_id IS NULL
$$;

REVOKE ALL ON FUNCTION
  north_star_internal.module_storage_read_active_release_pointer(uuid, uuid),
  north_star_internal.module_storage_read_release_artifacts(uuid, uuid, uuid),
  north_star_internal.module_storage_read_preparation_authority(uuid, uuid, uuid),
  north_star_internal.module_storage_read_approved_attempt(uuid, uuid, uuid, uuid),
  north_star_internal.module_storage_read_kernel_live_roots(uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  north_star_internal.module_storage_read_active_release_pointer(uuid, uuid),
  north_star_internal.module_storage_read_release_artifacts(uuid, uuid, uuid),
  north_star_internal.module_storage_read_preparation_authority(uuid, uuid, uuid),
  north_star_internal.module_storage_read_approved_attempt(uuid, uuid, uuid, uuid),
  north_star_internal.module_storage_read_kernel_live_roots(uuid, uuid)
  TO north_star_module_materializer;
REVOKE ALL ON FUNCTION
  north_star_internal.module_storage_lock_backfill_attempt(uuid, uuid, uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  north_star_internal.module_storage_lock_backfill_attempt(uuid, uuid, uuid, uuid)
  TO north_star_module_runtime;

REVOKE ALL ON ALL TABLES IN SCHEMA north_star_internal
  FROM north_star_module_materializer, north_star_module_runtime;
GRANT SELECT, INSERT, UPDATE ON north_star_internal.module_storage_generations,
  north_star_internal.module_storage_reference_counts,
  north_star_internal.module_storage_tightening_debt,
  north_star_internal.module_storage_backfill_checkpoints,
  north_star_internal.module_storage_attempt_claims TO north_star_module_materializer;
GRANT SELECT, INSERT ON north_star_internal.module_storage_elements,
  north_star_internal.module_storage_element_applications,
  north_star_internal.module_storage_root_membership,
  north_star_internal.module_storage_catalog_receipts TO north_star_module_materializer;
GRANT SELECT ON north_star_internal.module_storage_generations TO north_star_runtime;
GRANT SELECT ON north_star_internal.module_storage_catalog_receipts TO north_star_runtime;
GRANT USAGE ON SCHEMA north_star_internal TO north_star_runtime;
GRANT SELECT, INSERT, UPDATE ON north_star_internal.module_storage_backfill_checkpoints
  TO north_star_module_runtime;
GRANT USAGE ON SCHEMA north_star_internal TO north_star_module_materializer;
REVOKE SELECT ON platform.tenant_releases,
  platform.tenant_release_artifact_links, platform.release_artifact_blobs,
  platform.tenant_release_projection_links, platform.tenant_release_chunk_links,
  platform.active_release_pointers, platform.release_activation_preparations,
  platform.release_approvals, platform.release_activation_attempts,
  platform.release_activation_history, platform.release_executor_authority_events,
  platform.release_activation_control_events FROM north_star_module_materializer;

REVOKE ALL ON SCHEMA north_star_module FROM north_star_runtime;
