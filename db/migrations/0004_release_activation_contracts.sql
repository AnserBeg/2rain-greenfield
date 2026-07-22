CREATE TABLE platform.active_release_pointers (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  pointer_id uuid NOT NULL,
  release_id uuid,
  fence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id),
  CONSTRAINT active_release_pointers_pointer_id_unique UNIQUE (pointer_id),
  CONSTRAINT active_release_pointers_scoped_identity_unique
    UNIQUE (tenant_id, environment_id, pointer_id),
  CONSTRAINT active_release_pointers_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT active_release_pointers_release_fkey
    FOREIGN KEY (tenant_id, environment_id, release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT active_release_pointers_fence_nonnegative CHECK (fence >= 0)
);

INSERT INTO platform.active_release_pointers (
  tenant_id,
  environment_id,
  pointer_id,
  release_id,
  fence
)
SELECT environment.tenant_id,
       environment.id,
       gen_random_uuid(),
       NULL,
       0
  FROM platform.environments AS environment;

CREATE TABLE platform.release_activation_write_guard (
  attempted_relation text NOT NULL,
  CONSTRAINT release_activation_write_guard_reject CHECK (false)
);

CREATE TABLE platform.release_approver_eligibility_events (
  tenant_id uuid NOT NULL REFERENCES platform.tenants (id),
  policy_version bigint NOT NULL,
  authority_event_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  eligible boolean NOT NULL,
  changed_by uuid NOT NULL,
  authority_policy_contract_version text NOT NULL
    DEFAULT 'northstar.release-approver-authority/v1',
  changed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, policy_version),
  CONSTRAINT release_approver_events_event_id_unique
    UNIQUE (authority_event_id),
  CONSTRAINT release_approver_events_version_positive
    CHECK (policy_version > 0),
  CONSTRAINT release_approver_events_contract_version
    CHECK (
      authority_policy_contract_version =
        'northstar.release-approver-authority/v1'
    )
);

CREATE TABLE platform.transition_preparation_receipts (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  receipt_version text NOT NULL,
  source_release_id uuid,
  source_manifest_root bytea,
  target_release_id uuid NOT NULL,
  target_manifest_root bytea NOT NULL,
  transition_scope text NOT NULL,
  storage_domain_id text NOT NULL,
  schema_generation bigint NOT NULL,
  compiler_facts_version text NOT NULL,
  compiler_facts_digest bytea NOT NULL,
  compiler_transition_class text NOT NULL,
  compiler_static_compatibility text NOT NULL,
  compiler_exact_pair boolean NOT NULL,
  executor_evidence_version text NOT NULL,
  executor_evidence_digest bytea NOT NULL,
  executor_applied_state text NOT NULL,
  executor_exact_pair boolean NOT NULL,
  compatibility_policy_version text NOT NULL,
  compatibility_policy_verdict text NOT NULL,
  recovery_mode text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, receipt_id),
  CONSTRAINT transition_preparation_receipts_receipt_id_unique
    UNIQUE (receipt_id),
  CONSTRAINT transition_preparation_receipts_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT transition_preparation_receipts_source_release_fkey
    FOREIGN KEY (tenant_id, environment_id, source_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT transition_preparation_receipts_target_release_fkey
    FOREIGN KEY (tenant_id, environment_id, target_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT transition_preparation_receipts_versions CHECK (
    receipt_version = 'northstar.transition-preparation-receipt/v1'
    AND compiler_facts_version = 'northstar.compiler-transition-facts/v1'
    AND executor_evidence_version =
      'northstar.executor-applied-state-evidence/v1'
    AND compatibility_policy_version =
      'northstar.transition-compatibility-policy/v1'
  ),
  CONSTRAINT transition_preparation_receipts_roots CHECK (
    octet_length(target_manifest_root) = 32
    AND (
      (source_release_id IS NULL AND source_manifest_root IS NULL)
      OR (
        source_release_id IS NOT NULL
        AND octet_length(source_manifest_root) = 32
      )
    )
  ),
  CONSTRAINT transition_preparation_receipts_scope CHECK (
    transition_scope IN ('tenantLocal', 'sharedDatabase')
    AND btrim(storage_domain_id) <> ''
    AND schema_generation >= 0
  ),
  CONSTRAINT transition_preparation_receipts_digest_lengths CHECK (
    octet_length(compiler_facts_digest) = 32
    AND octet_length(executor_evidence_digest) = 32
  ),
  CONSTRAINT transition_preparation_receipts_contributor_codes CHECK (
    compiler_transition_class IN (
      'NO_STORAGE_TRANSITION',
      'REVERSIBLE',
      'IRREVERSIBLE'
    )
    AND compiler_static_compatibility IN ('SATISFIED', 'BLOCKED')
    AND executor_applied_state IN (
      'NOT_REQUIRED',
      'APPLIED',
      'NOT_APPLIED',
      'UNKNOWN'
    )
    AND compatibility_policy_verdict IN ('ALLOW', 'DENY')
    AND recovery_mode IN (
      'NO_STORAGE_RECOVERY_REQUIRED',
      'REVERSIBLE',
      'FORWARD_RECOVERY_ONLY'
    )
  ),
  CONSTRAINT transition_preparation_receipts_recovery_class CHECK (
    (compiler_transition_class = 'NO_STORAGE_TRANSITION'
      AND recovery_mode = 'NO_STORAGE_RECOVERY_REQUIRED')
    OR (compiler_transition_class = 'REVERSIBLE'
      AND recovery_mode = 'REVERSIBLE')
    OR (compiler_transition_class = 'IRREVERSIBLE'
      AND recovery_mode = 'FORWARD_RECOVERY_ONLY')
  ),
  CONSTRAINT transition_preparation_receipts_initial_no_storage CHECK (
    source_release_id IS NOT NULL
    OR (
      compiler_transition_class = 'NO_STORAGE_TRANSITION'
      AND executor_applied_state = 'NOT_REQUIRED'
    )
  )
);

CREATE TABLE platform.release_activation_preparations (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  preparation_version text NOT NULL,
  expected_pointer_id uuid NOT NULL,
  expected_release_id uuid,
  expected_fence bigint NOT NULL,
  source_manifest_root bytea,
  target_release_id uuid NOT NULL,
  target_manifest_root bytea NOT NULL,
  diff_binding_kind text NOT NULL,
  diff_binding_version text NOT NULL,
  release_diff_version text,
  release_diff_algorithm_version text,
  canonical_diff_digest bytea NOT NULL,
  transition_plan_digest bytea,
  compiler_attestation_digest bytea NOT NULL,
  compiler_version text NOT NULL,
  compiler_semantic_profile_version text NOT NULL,
  compiler_output_protocol_version text NOT NULL,
  verification_evidence_id uuid NOT NULL,
  verification_evidence_version text NOT NULL,
  verification_evidence_digest bytea NOT NULL,
  capability_support_version text NOT NULL,
  capability_support_digest bytea NOT NULL,
  capability_support_result text NOT NULL,
  renderer_version text NOT NULL,
  view_schema_version text NOT NULL,
  rendered_diff_evidence_digest bytea NOT NULL,
  transition_preparation_receipt_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, preparation_id),
  CONSTRAINT release_activation_preparations_preparation_id_unique
    UNIQUE (preparation_id),
  CONSTRAINT release_activation_preparations_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT release_activation_preparations_pointer_fkey
    FOREIGN KEY (tenant_id, environment_id, expected_pointer_id)
    REFERENCES platform.active_release_pointers (
      tenant_id,
      environment_id,
      pointer_id
    ),
  CONSTRAINT release_activation_preparations_source_release_fkey
    FOREIGN KEY (tenant_id, environment_id, expected_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT release_activation_preparations_target_release_fkey
    FOREIGN KEY (tenant_id, environment_id, target_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT release_activation_preparations_verification_evidence_fkey
    FOREIGN KEY (verification_evidence_id)
    REFERENCES platform.tenant_releases (verification_evidence_id),
  CONSTRAINT release_activation_preparations_receipt_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      transition_preparation_receipt_id
    ) REFERENCES platform.transition_preparation_receipts (
      tenant_id,
      environment_id,
      receipt_id
    ),
  CONSTRAINT release_activation_preparations_fence_nonnegative
    CHECK (expected_fence >= 0),
  CONSTRAINT release_activation_preparations_versions_not_blank CHECK (
    btrim(preparation_version) <> ''
    AND btrim(compiler_version) <> ''
    AND btrim(compiler_semantic_profile_version) <> ''
    AND btrim(compiler_output_protocol_version) <> ''
    AND btrim(verification_evidence_version) <> ''
    AND btrim(capability_support_version) <> ''
    AND btrim(renderer_version) <> ''
    AND btrim(view_schema_version) <> ''
  ),
  CONSTRAINT release_activation_preparations_hash_lengths CHECK (
    octet_length(target_manifest_root) = 32
    AND octet_length(canonical_diff_digest) = 32
    AND (
      transition_plan_digest IS NULL
      OR octet_length(transition_plan_digest) = 32
    )
    AND octet_length(compiler_attestation_digest) = 32
    AND octet_length(verification_evidence_digest) = 32
    AND octet_length(capability_support_digest) = 32
    AND octet_length(rendered_diff_evidence_digest) = 32
  ),
  CONSTRAINT release_activation_preparations_capability_result
    CHECK (capability_support_result IN ('SUPPORTED', 'UNSUPPORTED')),
  CONSTRAINT release_activation_preparations_diff_binding CHECK (
    (
      diff_binding_kind = 'INITIAL_ACTIVATION'
      AND diff_binding_version = 'northstar.initial-activation-binding/v1'
      AND expected_release_id IS NULL
      AND source_manifest_root IS NULL
      AND release_diff_version IS NULL
      AND release_diff_algorithm_version IS NULL
      AND transition_plan_digest IS NULL
    )
    OR (
      diff_binding_kind = 'RELEASE_DIFF'
      AND diff_binding_version = 'northstar.release-diff-binding/v1'
      AND expected_release_id IS NOT NULL
      AND octet_length(source_manifest_root) = 32
      AND btrim(release_diff_version) <> ''
      AND btrim(release_diff_algorithm_version) <> ''
    )
  )
);

CREATE TABLE platform.release_approvals (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  approval_contract_version text NOT NULL,
  activation_attempt_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  target_release_id uuid NOT NULL,
  target_manifest_root bytea NOT NULL,
  expected_pointer_id uuid NOT NULL,
  expected_release_id uuid,
  expected_fence bigint NOT NULL,
  source_manifest_root bytea,
  diff_binding_kind text NOT NULL,
  diff_binding_version text NOT NULL,
  release_diff_version text,
  release_diff_algorithm_version text,
  canonical_diff_digest bytea NOT NULL,
  transition_plan_digest bytea,
  compiler_attestation_digest bytea NOT NULL,
  compiler_version text NOT NULL,
  compiler_semantic_profile_version text NOT NULL,
  compiler_output_protocol_version text NOT NULL,
  verification_evidence_id uuid NOT NULL,
  verification_evidence_version text NOT NULL,
  verification_evidence_digest bytea NOT NULL,
  capability_support_version text NOT NULL,
  capability_support_digest bytea NOT NULL,
  renderer_version text NOT NULL,
  view_schema_version text NOT NULL,
  rendered_diff_evidence_digest bytea NOT NULL,
  transition_preparation_receipt_id uuid NOT NULL,
  compatibility_policy_version text NOT NULL,
  authority_policy_version bigint NOT NULL,
  authority_policy_contract_version text NOT NULL,
  approving_human_id uuid NOT NULL,
  issuing_actor_id uuid NOT NULL,
  initiating_human_id uuid NOT NULL,
  source_decision_id uuid,
  rollout_id uuid,
  decided_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  expiry_policy_version text NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, approval_id),
  CONSTRAINT release_approvals_approval_id_unique UNIQUE (approval_id),
  CONSTRAINT release_approvals_activation_attempt_id_unique
    UNIQUE (activation_attempt_id),
  CONSTRAINT release_approvals_attempt_binding_unique
    UNIQUE (tenant_id, environment_id, approval_id, activation_attempt_id),
  CONSTRAINT release_approvals_preparation_fkey
    FOREIGN KEY (tenant_id, environment_id, preparation_id)
    REFERENCES platform.release_activation_preparations (
      tenant_id,
      environment_id,
      preparation_id
    ),
  CONSTRAINT release_approvals_target_release_fkey
    FOREIGN KEY (tenant_id, environment_id, target_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT release_approvals_pointer_fkey
    FOREIGN KEY (tenant_id, environment_id, expected_pointer_id)
    REFERENCES platform.active_release_pointers (
      tenant_id,
      environment_id,
      pointer_id
    ),
  CONSTRAINT release_approvals_source_release_fkey
    FOREIGN KEY (tenant_id, environment_id, expected_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT release_approvals_receipt_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      transition_preparation_receipt_id
    ) REFERENCES platform.transition_preparation_receipts (
      tenant_id,
      environment_id,
      receipt_id
    ),
  CONSTRAINT release_approvals_authority_version_fkey
    FOREIGN KEY (tenant_id, authority_policy_version)
    REFERENCES platform.release_approver_eligibility_events (
      tenant_id,
      policy_version
    ),
  CONSTRAINT release_approvals_contract_versions CHECK (
    approval_contract_version = 'northstar.release-approval/v1'
    AND authority_policy_contract_version =
      'northstar.release-approver-authority/v1'
    AND expiry_policy_version = 'northstar.release-approval-expiry/v1'
    AND compatibility_policy_version =
      'northstar.transition-compatibility-policy/v1'
  ),
  CONSTRAINT release_approvals_expiry CHECK (expires_at > decided_at),
  CONSTRAINT release_approvals_fence_nonnegative CHECK (expected_fence >= 0),
  CONSTRAINT release_approvals_compiler_versions_not_blank CHECK (
    btrim(compiler_version) <> ''
    AND btrim(compiler_semantic_profile_version) <> ''
    AND btrim(compiler_output_protocol_version) <> ''
  ),
  CONSTRAINT release_approvals_hash_lengths CHECK (
    octet_length(target_manifest_root) = 32
    AND octet_length(canonical_diff_digest) = 32
    AND (
      transition_plan_digest IS NULL
      OR octet_length(transition_plan_digest) = 32
    )
    AND octet_length(compiler_attestation_digest) = 32
    AND octet_length(verification_evidence_digest) = 32
    AND octet_length(capability_support_digest) = 32
    AND octet_length(rendered_diff_evidence_digest) = 32
  ),
  CONSTRAINT release_approvals_diff_binding CHECK (
    (
      diff_binding_kind = 'INITIAL_ACTIVATION'
      AND diff_binding_version = 'northstar.initial-activation-binding/v1'
      AND expected_release_id IS NULL
      AND source_manifest_root IS NULL
      AND release_diff_version IS NULL
      AND release_diff_algorithm_version IS NULL
      AND transition_plan_digest IS NULL
    )
    OR (
      diff_binding_kind = 'RELEASE_DIFF'
      AND diff_binding_version = 'northstar.release-diff-binding/v1'
      AND expected_release_id IS NOT NULL
      AND octet_length(source_manifest_root) = 32
      AND btrim(release_diff_version) <> ''
      AND btrim(release_diff_algorithm_version) <> ''
    )
  )
);

CREATE TABLE platform.release_activation_attempts (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  activation_attempt_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  attempt_contract_version text NOT NULL,
  execution_principal_kind text NOT NULL,
  execution_principal_id uuid NOT NULL,
  attempt_state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, activation_attempt_id),
  CONSTRAINT release_activation_attempts_attempt_id_unique
    UNIQUE (activation_attempt_id),
  CONSTRAINT release_activation_attempts_approval_unique UNIQUE (approval_id),
  CONSTRAINT release_activation_attempts_approval_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      approval_id,
      activation_attempt_id
    ) REFERENCES platform.release_approvals (
      tenant_id,
      environment_id,
      approval_id,
      activation_attempt_id
    ),
  CONSTRAINT release_activation_attempts_prebound_contract CHECK (
    attempt_contract_version = 'northstar.release-activation-attempt/v1'
    AND execution_principal_kind = 'SYSTEM'
    AND execution_principal_id = '00000000-0000-4000-8000-000000000001'::uuid
    AND attempt_state = 'PREBOUND'
  )
);

CREATE TABLE platform.release_activation_phase_receipts (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  phase_receipt_id uuid NOT NULL,
  activation_attempt_id uuid NOT NULL,
  receipt_version text NOT NULL,
  phase_code text NOT NULL,
  receipt_digest bytea NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, phase_receipt_id),
  CONSTRAINT release_activation_phase_receipts_id_unique
    UNIQUE (phase_receipt_id),
  CONSTRAINT release_activation_phase_receipts_phase_unique
    UNIQUE (activation_attempt_id, phase_code),
  CONSTRAINT release_activation_phase_receipts_attempt_fkey
    FOREIGN KEY (tenant_id, environment_id, activation_attempt_id)
    REFERENCES platform.release_activation_attempts (
      tenant_id,
      environment_id,
      activation_attempt_id
    ),
  CONSTRAINT release_activation_phase_receipts_shape CHECK (
    receipt_version = 'northstar.release-activation-phase-receipt/v1'
    AND btrim(phase_code) <> ''
    AND octet_length(receipt_digest) = 32
  )
);

CREATE TABLE platform.release_activation_history (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  history_id uuid NOT NULL,
  activation_attempt_id uuid NOT NULL,
  history_version text NOT NULL,
  pointer_id uuid NOT NULL,
  approving_human_id uuid NOT NULL,
  issuing_actor_id uuid NOT NULL,
  initiating_human_id uuid NOT NULL,
  execution_principal_kind text NOT NULL,
  execution_principal_id uuid NOT NULL,
  from_release_id uuid,
  to_release_id uuid NOT NULL,
  observed_fence bigint NOT NULL,
  pointer_outcome text NOT NULL,
  verification_outcome text NOT NULL,
  workflow_disposition text NOT NULL,
  workflow_status text NOT NULL,
  terminal boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, history_id),
  CONSTRAINT release_activation_history_id_unique UNIQUE (history_id),
  CONSTRAINT release_activation_history_attempt_fkey
    FOREIGN KEY (tenant_id, environment_id, activation_attempt_id)
    REFERENCES platform.release_activation_attempts (
      tenant_id,
      environment_id,
      activation_attempt_id
    ),
  CONSTRAINT release_activation_history_pointer_fkey
    FOREIGN KEY (tenant_id, environment_id, pointer_id)
    REFERENCES platform.active_release_pointers (
      tenant_id,
      environment_id,
      pointer_id
    ),
  CONSTRAINT release_activation_history_from_release_fkey
    FOREIGN KEY (tenant_id, environment_id, from_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT release_activation_history_to_release_fkey
    FOREIGN KEY (tenant_id, environment_id, to_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT release_activation_history_fence_nonnegative
    CHECK (observed_fence >= 0),
  CONSTRAINT release_activation_history_dimensions CHECK (
    history_version = 'northstar.release-activation-history/v1'
    AND execution_principal_kind = 'SYSTEM'
    AND execution_principal_id =
      '00000000-0000-4000-8000-000000000001'::uuid
    AND pointer_outcome IN (
      'NOT_ATTEMPTED',
      'NOT_SWAPPED',
      'SWAPPED',
      'SWAPPED_THEN_SUPERSEDED',
      'AMBIGUOUS'
    )
    AND verification_outcome IN ('NOT_RUN', 'PASSED', 'FAILED', 'UNKNOWN')
    AND workflow_disposition IN ('RETAINED', 'CONSUMED')
    AND workflow_status IN (
      'RUNNING',
      'PAUSED',
      'RECONCILING',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED'
    )
    AND terminal = (workflow_status IN ('SUCCEEDED', 'FAILED', 'CANCELLED'))
    AND (workflow_status <> 'PAUSED' OR workflow_disposition = 'RETAINED')
    AND (workflow_status <> 'CANCELLED' OR workflow_disposition = 'CONSUMED')
  )
);

CREATE TABLE platform.release_activation_attempt_outcomes (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  activation_attempt_id uuid NOT NULL,
  outcome_id uuid NOT NULL,
  outcome_version text NOT NULL,
  outcome_code text NOT NULL,
  pointer_outcome text NOT NULL,
  verification_outcome text NOT NULL,
  workflow_disposition text NOT NULL,
  workflow_status text NOT NULL,
  terminal boolean NOT NULL,
  outcome_digest bytea NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, activation_attempt_id),
  CONSTRAINT release_activation_attempt_outcomes_id_unique UNIQUE (outcome_id),
  CONSTRAINT release_activation_attempt_outcomes_attempt_fkey
    FOREIGN KEY (tenant_id, environment_id, activation_attempt_id)
    REFERENCES platform.release_activation_attempts (
      tenant_id,
      environment_id,
      activation_attempt_id
    ),
  CONSTRAINT release_activation_attempt_outcomes_codes CHECK (
    outcome_version = 'northstar.release-activation-outcome/v1'
    AND outcome_code IN (
      'SWAPPED',
      'STALE_POINTER',
      'EXPIRED_APPROVAL',
      'INVALID_BINDING',
      'OBSOLETE_POLICY',
      'DEFINITIVE_BLOCKING_FAILURE',
      'CANCELLATION',
      'APPROVER_REVOCATION',
      'PRE_CAS_POLICY_DENY'
    )
    AND pointer_outcome IN (
      'NOT_ATTEMPTED',
      'NOT_SWAPPED',
      'SWAPPED',
      'SWAPPED_THEN_SUPERSEDED',
      'AMBIGUOUS'
    )
    AND verification_outcome IN ('NOT_RUN', 'PASSED', 'FAILED', 'UNKNOWN')
    AND workflow_disposition IN ('RETAINED', 'CONSUMED')
    AND workflow_status IN (
      'RUNNING',
      'PAUSED',
      'RECONCILING',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED'
    )
    AND terminal = (workflow_status IN ('SUCCEEDED', 'FAILED', 'CANCELLED'))
    AND (
      (
        outcome_code = 'SWAPPED'
        AND pointer_outcome = 'SWAPPED'
        AND verification_outcome = 'NOT_RUN'
        AND workflow_disposition = 'CONSUMED'
        AND workflow_status = 'RUNNING'
        AND NOT terminal
      )
      OR (
        outcome_code = 'CANCELLATION'
        AND pointer_outcome = 'NOT_SWAPPED'
        AND verification_outcome = 'NOT_RUN'
        AND workflow_disposition = 'CONSUMED'
        AND workflow_status = 'CANCELLED'
        AND terminal
      )
      OR (
        outcome_code IN (
          'STALE_POINTER',
          'EXPIRED_APPROVAL',
          'INVALID_BINDING',
          'OBSOLETE_POLICY',
          'DEFINITIVE_BLOCKING_FAILURE',
          'APPROVER_REVOCATION',
          'PRE_CAS_POLICY_DENY'
        )
        AND pointer_outcome = 'NOT_SWAPPED'
        AND verification_outcome = 'NOT_RUN'
        AND workflow_disposition = 'CONSUMED'
        AND workflow_status = 'FAILED'
        AND terminal
      )
    )
    AND octet_length(outcome_digest) = 32
  )
);

CREATE TABLE platform.release_activation_outbox (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  activation_attempt_id uuid NOT NULL,
  envelope_version text NOT NULL,
  event_code text NOT NULL,
  payload_digest bytea NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, outbox_id),
  CONSTRAINT release_activation_outbox_id_unique UNIQUE (outbox_id),
  CONSTRAINT release_activation_outbox_attempt_event_unique
    UNIQUE (activation_attempt_id, event_code),
  CONSTRAINT release_activation_outbox_attempt_fkey
    FOREIGN KEY (tenant_id, environment_id, activation_attempt_id)
    REFERENCES platform.release_activation_attempts (
      tenant_id,
      environment_id,
      activation_attempt_id
    ),
  CONSTRAINT release_activation_outbox_envelope CHECK (
    envelope_version = 'northstar.release-activation-outbox/v1'
    AND btrim(event_code) <> ''
    AND octet_length(payload_digest) = 32
  )
);

CREATE FUNCTION platform.create_active_release_pointer_for_environment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$ BEGIN
  INSERT INTO platform.active_release_pointers (
    tenant_id,
    environment_id,
    pointer_id,
    release_id,
    fence
  ) VALUES (NEW.tenant_id, NEW.id, gen_random_uuid(), NULL, 0);
  RETURN NEW; END $$;

CREATE TRIGGER environments_create_active_release_pointer
AFTER INSERT ON platform.environments
FOR EACH ROW
EXECUTE FUNCTION platform.create_active_release_pointer_for_environment();

CREATE FUNCTION platform.guard_active_release_pointer_swap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
    OR NEW.pointer_id IS DISTINCT FROM OLD.pointer_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.release_id IS NULL
    OR NEW.release_id IS NOT DISTINCT FROM OLD.release_id
    OR NEW.fence IS DISTINCT FROM OLD.fence + 1
  THEN
    RAISE EXCEPTION 'active release pointer updates require one exact release swap and fence + 1'
      USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW; END $$;

CREATE TRIGGER active_release_pointer_exact_swap
BEFORE UPDATE ON platform.active_release_pointers
FOR EACH ROW
EXECUTE FUNCTION platform.guard_active_release_pointer_swap();

CREATE FUNCTION platform.assign_release_approver_policy_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ DECLARE prior_eligibility boolean; BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'northstar.release-approval-authority:' || NEW.tenant_id::text,
      0
    )
  );
  SELECT event.eligible
    INTO prior_eligibility
    FROM platform.release_approver_eligibility_events AS event
   WHERE event.tenant_id = NEW.tenant_id
     AND event.principal_id = NEW.principal_id
   ORDER BY event.policy_version DESC
   LIMIT 1;
  IF FOUND AND prior_eligibility IS NOT DISTINCT FROM NEW.eligible THEN
    RAISE EXCEPTION 'release approver eligibility event must change current eligibility'
      USING ERRCODE = 'check_violation'; END IF;
  SELECT COALESCE(max(event.policy_version), 0) + 1
    INTO NEW.policy_version
    FROM platform.release_approver_eligibility_events AS event
   WHERE event.tenant_id = NEW.tenant_id;
  RETURN NEW; END $$;

CREATE TRIGGER release_approver_event_assign_policy_version
BEFORE INSERT ON platform.release_approver_eligibility_events
FOR EACH ROW
EXECUTE FUNCTION platform.assign_release_approver_policy_version();

CREATE FUNCTION platform.set_release_approver_eligibility(
  changed_tenant_id uuid,
  changed_principal_id uuid,
  changed_eligible boolean,
  changed_by uuid,
  changed_event_id uuid
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  INSERT INTO platform.release_approver_eligibility_events (
    tenant_id,
    policy_version,
    authority_event_id,
    principal_id,
    eligible,
    changed_by
  ) VALUES (
    changed_tenant_id,
    NULL,
    changed_event_id,
    changed_principal_id,
    changed_eligible,
    changed_by
  )
  RETURNING policy_version
$$;

CREATE RULE active_release_pointers_reject_delete
AS ON DELETE TO platform.active_release_pointers
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('active_release_pointers');

CREATE RULE release_approver_eligibility_events_reject_update
AS ON UPDATE TO platform.release_approver_eligibility_events
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_approver_eligibility_events');

CREATE RULE release_approver_eligibility_events_reject_delete
AS ON DELETE TO platform.release_approver_eligibility_events
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_approver_eligibility_events');

CREATE RULE transition_preparation_receipts_reject_update
AS ON UPDATE TO platform.transition_preparation_receipts
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('transition_preparation_receipts');

CREATE RULE transition_preparation_receipts_reject_delete
AS ON DELETE TO platform.transition_preparation_receipts
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('transition_preparation_receipts');

CREATE RULE release_activation_preparations_reject_update
AS ON UPDATE TO platform.release_activation_preparations
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_preparations');

CREATE RULE release_activation_preparations_reject_delete
AS ON DELETE TO platform.release_activation_preparations
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_preparations');

CREATE RULE release_approvals_reject_update
AS ON UPDATE TO platform.release_approvals
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_approvals');

CREATE RULE release_approvals_reject_delete
AS ON DELETE TO platform.release_approvals
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_approvals');

CREATE RULE release_activation_attempts_reject_update
AS ON UPDATE TO platform.release_activation_attempts
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_attempts');

CREATE RULE release_activation_attempts_reject_delete
AS ON DELETE TO platform.release_activation_attempts
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_attempts');

CREATE RULE release_activation_phase_receipts_reject_update
AS ON UPDATE TO platform.release_activation_phase_receipts
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_phase_receipts');

CREATE RULE release_activation_phase_receipts_reject_delete
AS ON DELETE TO platform.release_activation_phase_receipts
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_phase_receipts');

CREATE RULE release_activation_history_reject_update
AS ON UPDATE TO platform.release_activation_history
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_history');

CREATE RULE release_activation_history_reject_delete
AS ON DELETE TO platform.release_activation_history
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_history');

CREATE RULE release_activation_attempt_outcomes_reject_update
AS ON UPDATE TO platform.release_activation_attempt_outcomes
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_attempt_outcomes');

CREATE RULE release_activation_attempt_outcomes_reject_delete
AS ON DELETE TO platform.release_activation_attempt_outcomes
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_attempt_outcomes');

CREATE RULE release_activation_outbox_reject_update
AS ON UPDATE TO platform.release_activation_outbox
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_outbox');

CREATE RULE release_activation_outbox_reject_delete
AS ON DELETE TO platform.release_activation_outbox
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_outbox');

ALTER TABLE platform.active_release_pointers ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.active_release_pointers FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_approver_eligibility_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_approver_eligibility_events FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.transition_preparation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.transition_preparation_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_preparations FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_phase_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_phase_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_history FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_attempt_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_attempt_outcomes FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY active_release_pointers_select_trusted_context
  ON platform.active_release_pointers
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY active_release_pointers_update_trusted_context
  ON platform.active_release_pointers
  AS PERMISSIVE
  FOR UPDATE
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_approver_events_select_trusted_context
  ON platform.release_approver_eligibility_events
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND nullif(current_setting('north_star.environment_id', true), '')::uuid IS NOT NULL
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY transition_preparation_receipts_select_trusted_context
  ON platform.transition_preparation_receipts
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY transition_preparation_receipts_insert_trusted_context
  ON platform.transition_preparation_receipts
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_preparations_select_trusted_context
  ON platform.release_activation_preparations
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_preparations_insert_trusted_context
  ON platform.release_activation_preparations
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_approvals_select_trusted_context
  ON platform.release_approvals
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_approvals_insert_trusted_context
  ON platform.release_approvals
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_attempts_select_trusted_context
  ON platform.release_activation_attempts
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_attempts_insert_trusted_context
  ON platform.release_activation_attempts
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_phase_receipts_select_trusted_context
  ON platform.release_activation_phase_receipts
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_phase_receipts_insert_trusted_context
  ON platform.release_activation_phase_receipts
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_history_select_trusted_context
  ON platform.release_activation_history
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_history_insert_trusted_context
  ON platform.release_activation_history
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_attempt_outcomes_select_trusted_context
  ON platform.release_activation_attempt_outcomes
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_outbox_select_trusted_context
  ON platform.release_activation_outbox
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

REVOKE ALL ON platform.active_release_pointers FROM PUBLIC;
REVOKE ALL ON platform.release_activation_write_guard FROM PUBLIC;
REVOKE ALL ON platform.release_approver_eligibility_events FROM PUBLIC;
REVOKE ALL ON platform.transition_preparation_receipts FROM PUBLIC;
REVOKE ALL ON platform.release_activation_preparations FROM PUBLIC;
REVOKE ALL ON platform.release_approvals FROM PUBLIC;
REVOKE ALL ON platform.release_activation_attempts FROM PUBLIC;
REVOKE ALL ON platform.release_activation_phase_receipts FROM PUBLIC;
REVOKE ALL ON platform.release_activation_history FROM PUBLIC;
REVOKE ALL ON platform.release_activation_attempt_outcomes FROM PUBLIC;
REVOKE ALL ON platform.release_activation_outbox FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.create_active_release_pointer_for_environment() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_active_release_pointer_swap() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assign_release_approver_policy_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.set_release_approver_eligibility(uuid, uuid, boolean, uuid, uuid) FROM PUBLIC;

GRANT SELECT ON platform.active_release_pointers TO north_star_runtime;
GRANT SELECT ON platform.release_approver_eligibility_events TO north_star_runtime;
GRANT SELECT, INSERT ON platform.transition_preparation_receipts TO north_star_runtime;
GRANT SELECT, INSERT ON platform.release_activation_preparations TO north_star_runtime;
GRANT SELECT, INSERT ON platform.release_approvals TO north_star_runtime;
GRANT SELECT, INSERT ON platform.release_activation_attempts TO north_star_runtime;
GRANT SELECT, INSERT ON platform.release_activation_phase_receipts TO north_star_runtime;
GRANT SELECT, INSERT ON platform.release_activation_history TO north_star_runtime;
GRANT SELECT ON platform.release_activation_attempt_outcomes TO north_star_runtime;
GRANT SELECT ON platform.release_activation_outbox TO north_star_runtime;
