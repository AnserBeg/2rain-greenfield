CREATE TABLE platform.release_activation_authority_epochs (
  tenant_id uuid PRIMARY KEY REFERENCES platform.tenants (id),
  approver_policy_version bigint NOT NULL DEFAULT 0,
  executor_policy_version bigint NOT NULL DEFAULT 0,
  control_policy_version bigint NOT NULL DEFAULT 0,
  CONSTRAINT release_activation_authority_epochs_nonnegative CHECK (
    approver_policy_version >= 0
    AND executor_policy_version >= 0
    AND control_policy_version >= 0
  )
);

INSERT INTO platform.release_activation_authority_epochs (
  tenant_id,
  approver_policy_version
)
SELECT tenant.id,
       COALESCE(max(event.policy_version), 0)
  FROM platform.tenants AS tenant
  LEFT JOIN platform.release_approver_eligibility_events AS event
    ON event.tenant_id = tenant.id
 GROUP BY tenant.id;

CREATE TABLE platform.release_executor_authority_events (
  tenant_id uuid NOT NULL REFERENCES platform.tenants (id),
  policy_version bigint NOT NULL,
  authority_event_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  authorized boolean NOT NULL,
  changed_by uuid NOT NULL,
  authority_policy_contract_version text NOT NULL
    DEFAULT 'northstar.release-executor-authority/v1',
  changed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, policy_version),
  CONSTRAINT release_executor_authority_events_event_id_unique
    UNIQUE (authority_event_id),
  CONSTRAINT release_executor_authority_events_version_positive
    CHECK (policy_version > 0),
  CONSTRAINT release_executor_authority_events_contract_version CHECK (
    authority_policy_contract_version =
      'northstar.release-executor-authority/v1'
  )
);

CREATE INDEX release_executor_authority_events_current_principal_idx
  ON platform.release_executor_authority_events (
    tenant_id,
    principal_id,
    policy_version DESC
  );

CREATE TABLE platform.release_activation_control_events (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  policy_version bigint NOT NULL,
  control_event_id uuid NOT NULL,
  rollout_id uuid,
  live_policy_denied boolean NOT NULL,
  rollout_paused boolean NOT NULL,
  changed_by uuid NOT NULL,
  control_policy_contract_version text NOT NULL
    DEFAULT 'northstar.release-activation-control/v1',
  changed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, policy_version),
  CONSTRAINT release_activation_control_events_event_id_unique
    UNIQUE (control_event_id),
  CONSTRAINT release_activation_control_events_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT release_activation_control_events_version_positive
    CHECK (policy_version > 0),
  CONSTRAINT release_activation_control_events_contract_version CHECK (
    control_policy_contract_version =
      'northstar.release-activation-control/v1'
  )
);

CREATE INDEX release_activation_control_events_current_scope_idx
  ON platform.release_activation_control_events (
    tenant_id,
    environment_id,
    rollout_id,
    policy_version DESC
  );

ALTER TABLE platform.release_activation_history
  ADD COLUMN approval_id uuid,
  ADD COLUMN transition_preparation_receipt_id uuid,
  ADD COLUMN transition_plan_digest bytea,
  ADD COLUMN compatibility_policy_version text;

ALTER TABLE platform.release_activation_history
  ADD CONSTRAINT release_activation_history_approval_fkey
    FOREIGN KEY (tenant_id, environment_id, approval_id)
    REFERENCES platform.release_approvals (
      tenant_id,
      environment_id,
      approval_id
    ),
  ADD CONSTRAINT release_activation_history_transition_receipt_fkey
    FOREIGN KEY (
      tenant_id,
      environment_id,
      transition_preparation_receipt_id
    ) REFERENCES platform.transition_preparation_receipts (
      tenant_id,
      environment_id,
      receipt_id
    ),
  ADD CONSTRAINT release_activation_history_transition_digest CHECK (
    transition_plan_digest IS NULL
    OR octet_length(transition_plan_digest) = 32
  );

ALTER TABLE platform.release_activation_outbox
  ADD COLUMN pointer_id uuid,
  ADD COLUMN old_release_id uuid,
  ADD COLUMN new_release_id uuid,
  ADD COLUMN fence bigint,
  ADD COLUMN history_id uuid,
  ADD COLUMN event_schema_version text,
  ADD COLUMN deduplication_key text;

ALTER TABLE platform.release_activation_outbox
  ADD CONSTRAINT release_activation_outbox_pointer_fkey
    FOREIGN KEY (tenant_id, environment_id, pointer_id)
    REFERENCES platform.active_release_pointers (
      tenant_id,
      environment_id,
      pointer_id
    ),
  ADD CONSTRAINT release_activation_outbox_old_release_fkey
    FOREIGN KEY (tenant_id, environment_id, old_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  ADD CONSTRAINT release_activation_outbox_new_release_fkey
    FOREIGN KEY (tenant_id, environment_id, new_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  ADD CONSTRAINT release_activation_outbox_history_fkey
    FOREIGN KEY (tenant_id, environment_id, history_id)
    REFERENCES platform.release_activation_history (
      tenant_id,
      environment_id,
      history_id
    ),
  ADD CONSTRAINT release_activation_outbox_deduplication_key_unique
    UNIQUE (deduplication_key),
  ADD CONSTRAINT release_activation_outbox_generation_shape CHECK (
    (
      pointer_id IS NULL
      AND new_release_id IS NULL
      AND fence IS NULL
      AND history_id IS NULL
      AND event_schema_version IS NULL
      AND deduplication_key IS NULL
    )
    OR (
      pointer_id IS NOT NULL
      AND new_release_id IS NOT NULL
      AND fence > 0
      AND history_id IS NOT NULL
      AND event_schema_version =
        'northstar.release-activation-invalidation/v1'
      AND btrim(deduplication_key) <> ''
      AND event_code = 'ACTIVE_RELEASE_POINTER_CHANGED'
    )
  );

ALTER TABLE platform.release_activation_attempt_outcomes
  DROP CONSTRAINT release_activation_attempt_outcomes_codes;

ALTER TABLE platform.release_activation_attempt_outcomes
  ADD CONSTRAINT release_activation_attempt_outcomes_codes CHECK (
    outcome_version = 'northstar.release-activation-outcome/v1'
    AND outcome_code IN (
      'SWAPPED',
      'STALE_POINTER',
      'EXPIRED_APPROVAL',
      'INVALID_BINDING',
      'LOST_RACE',
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
          'LOST_RACE',
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
  );

CREATE TABLE platform.release_activation_swap_receipts (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  activation_attempt_id uuid NOT NULL,
  swap_receipt_id uuid NOT NULL,
  swap_receipt_version text NOT NULL,
  approval_id uuid NOT NULL,
  pointer_id uuid NOT NULL,
  previous_release_id uuid,
  activated_release_id uuid NOT NULL,
  fence bigint NOT NULL,
  history_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, activation_attempt_id),
  CONSTRAINT release_activation_swap_receipts_id_unique
    UNIQUE (swap_receipt_id),
  CONSTRAINT release_activation_swap_receipts_attempt_fkey
    FOREIGN KEY (tenant_id, environment_id, activation_attempt_id)
    REFERENCES platform.release_activation_attempts (
      tenant_id,
      environment_id,
      activation_attempt_id
    ),
  CONSTRAINT release_activation_swap_receipts_approval_fkey
    FOREIGN KEY (tenant_id, environment_id, approval_id)
    REFERENCES platform.release_approvals (
      tenant_id,
      environment_id,
      approval_id
    ),
  CONSTRAINT release_activation_swap_receipts_pointer_fkey
    FOREIGN KEY (tenant_id, environment_id, pointer_id)
    REFERENCES platform.active_release_pointers (
      tenant_id,
      environment_id,
      pointer_id
    ),
  CONSTRAINT release_activation_swap_receipts_previous_release_fkey
    FOREIGN KEY (tenant_id, environment_id, previous_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT release_activation_swap_receipts_activated_release_fkey
    FOREIGN KEY (tenant_id, environment_id, activated_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT release_activation_swap_receipts_history_fkey
    FOREIGN KEY (tenant_id, environment_id, history_id)
    REFERENCES platform.release_activation_history (
      tenant_id,
      environment_id,
      history_id
    ),
  CONSTRAINT release_activation_swap_receipts_outbox_fkey
    FOREIGN KEY (tenant_id, environment_id, outbox_id)
    REFERENCES platform.release_activation_outbox (
      tenant_id,
      environment_id,
      outbox_id
    ),
  CONSTRAINT release_activation_swap_receipts_shape CHECK (
    swap_receipt_version =
      'northstar.release-activation-swap-receipt/v1'
    AND fence > 0
  )
);

CREATE TABLE platform.release_activation_verification_receipts (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  activation_attempt_id uuid NOT NULL,
  verification_receipt_id uuid NOT NULL,
  verification_version text NOT NULL,
  pointer_id uuid NOT NULL,
  activated_release_id uuid NOT NULL,
  fence bigint NOT NULL,
  pointer_read_back_passed boolean NOT NULL,
  artifact_availability_passed boolean NOT NULL,
  release_kernel_invariants_passed boolean NOT NULL,
  warning_count integer NOT NULL,
  status text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, activation_attempt_id),
  CONSTRAINT release_activation_verification_receipts_id_unique
    UNIQUE (verification_receipt_id),
  CONSTRAINT release_activation_verification_receipts_attempt_fkey
    FOREIGN KEY (tenant_id, environment_id, activation_attempt_id)
    REFERENCES platform.release_activation_swap_receipts (
      tenant_id,
      environment_id,
      activation_attempt_id
    ),
  CONSTRAINT release_activation_verification_receipts_pointer_fkey
    FOREIGN KEY (tenant_id, environment_id, pointer_id)
    REFERENCES platform.active_release_pointers (
      tenant_id,
      environment_id,
      pointer_id
    ),
  CONSTRAINT release_activation_verification_receipts_release_fkey
    FOREIGN KEY (tenant_id, environment_id, activated_release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  CONSTRAINT release_activation_verification_receipts_shape CHECK (
    verification_version = 'northstar.release-activation-verification/v1'
    AND fence > 0
    AND warning_count >= 0
    AND status IN (
      'SWAPPED_VERIFIED',
      'SWAPPED_VERIFICATION_FAILED',
      'SUPERSEDED'
    )
    AND (
      (
        status = 'SWAPPED_VERIFIED'
        AND pointer_read_back_passed
        AND artifact_availability_passed
        AND release_kernel_invariants_passed
        AND warning_count = 0
      )
      OR (
        status = 'SWAPPED_VERIFICATION_FAILED'
        AND (
          NOT pointer_read_back_passed
          OR NOT artifact_availability_passed
          OR NOT release_kernel_invariants_passed
        )
      )
      OR status = 'SUPERSEDED'
    )
  )
);

CREATE TABLE platform.release_activation_reconciliation_starts (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  activation_attempt_id uuid NOT NULL,
  start_receipt_id uuid NOT NULL,
  start_receipt_version text NOT NULL,
  max_age_milliseconds bigint NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, activation_attempt_id),
  CONSTRAINT release_activation_reconciliation_starts_id_unique
    UNIQUE (start_receipt_id),
  CONSTRAINT release_activation_reconciliation_starts_attempt_fkey
    FOREIGN KEY (tenant_id, environment_id, activation_attempt_id)
    REFERENCES platform.release_activation_attempts (
      tenant_id,
      environment_id,
      activation_attempt_id
    ),
  CONSTRAINT release_activation_reconciliation_starts_shape CHECK (
    start_receipt_version =
      'northstar.release-activation-reconciliation-start/v1'
    AND max_age_milliseconds > 0
  )
);

CREATE TABLE platform.release_activation_reconciliation_alarms (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  activation_attempt_id uuid NOT NULL,
  alarm_id uuid NOT NULL,
  alarm_version text NOT NULL,
  reason_code text NOT NULL,
  max_age_milliseconds bigint NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, activation_attempt_id),
  CONSTRAINT release_activation_reconciliation_alarms_id_unique
    UNIQUE (alarm_id),
  CONSTRAINT release_activation_reconciliation_alarms_start_fkey
    FOREIGN KEY (tenant_id, environment_id, activation_attempt_id)
    REFERENCES platform.release_activation_reconciliation_starts (
      tenant_id,
      environment_id,
      activation_attempt_id
    ),
  CONSTRAINT release_activation_reconciliation_alarms_shape CHECK (
    alarm_version =
      'northstar.release-activation-reconciliation-alarm/v1'
    AND reason_code = 'RECONCILIATION_OVERDUE'
    AND max_age_milliseconds > 0
  )
);

CREATE FUNCTION platform.validate_release_activation_swap_fact_set()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ DECLARE facts_valid boolean; BEGIN
  IF NEW.activation_attempt_id IS NULL THEN
    RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1
      FROM platform.release_activation_swap_receipts AS receipt
     WHERE receipt.activation_attempt_id = NEW.activation_attempt_id
  ) OR EXISTS (
    SELECT 1
      FROM platform.release_activation_attempt_outcomes AS outcome
     WHERE outcome.activation_attempt_id = NEW.activation_attempt_id
       AND outcome.outcome_code = 'SWAPPED'
  ) OR EXISTS (
    SELECT 1
      FROM platform.release_activation_history AS history
     WHERE history.activation_attempt_id = NEW.activation_attempt_id
       AND history.pointer_outcome = 'SWAPPED'
       AND history.approval_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1
      FROM platform.release_activation_outbox AS outbox
     WHERE outbox.activation_attempt_id = NEW.activation_attempt_id
       AND outbox.event_code = 'ACTIVE_RELEASE_POINTER_CHANGED'
  ) THEN
    SELECT count(*) = 1
           AND count(DISTINCT history.history_id) = 1
           AND count(DISTINCT outbox.outbox_id) = 1
           AND count(DISTINCT outcome.activation_attempt_id) = 1
           AND bool_and(
             history.activation_attempt_id = receipt.activation_attempt_id
             AND history.history_id = receipt.history_id
             AND history.approval_id = receipt.approval_id
             AND history.pointer_id = receipt.pointer_id
             AND history.from_release_id IS NOT DISTINCT FROM
                   receipt.previous_release_id
             AND history.to_release_id = receipt.activated_release_id
             AND history.observed_fence = receipt.fence
             AND history.pointer_outcome = 'SWAPPED'
             AND outbox.activation_attempt_id = receipt.activation_attempt_id
             AND outbox.outbox_id = receipt.outbox_id
             AND outbox.history_id = receipt.history_id
             AND outbox.pointer_id = receipt.pointer_id
             AND outbox.old_release_id IS NOT DISTINCT FROM
                   receipt.previous_release_id
             AND outbox.new_release_id = receipt.activated_release_id
             AND outbox.fence = receipt.fence
             AND outbox.event_code = 'ACTIVE_RELEASE_POINTER_CHANGED'
             AND outbox.event_schema_version =
                   'northstar.release-activation-invalidation/v1'
             AND outcome.outcome_code = 'SWAPPED'
             AND outcome.pointer_outcome = 'SWAPPED'
           )
      INTO facts_valid
      FROM platform.release_activation_swap_receipts AS receipt
      JOIN platform.release_activation_history AS history
        ON history.activation_attempt_id = receipt.activation_attempt_id
       AND history.pointer_outcome = 'SWAPPED'
       AND history.approval_id IS NOT NULL
      JOIN platform.release_activation_outbox AS outbox
        ON outbox.activation_attempt_id = receipt.activation_attempt_id
       AND outbox.event_code = 'ACTIVE_RELEASE_POINTER_CHANGED'
      JOIN platform.release_activation_attempt_outcomes AS outcome
        ON outcome.activation_attempt_id = receipt.activation_attempt_id
       AND outcome.outcome_code = 'SWAPPED'
     WHERE receipt.activation_attempt_id = NEW.activation_attempt_id;
    IF facts_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'release activation swap requires one matching receipt, history, outcome, and outbox fact set'
        USING ERRCODE = 'integrity_constraint_violation'; END IF; END IF;
  RETURN NULL; END $$;

CREATE CONSTRAINT TRIGGER release_activation_history_swap_fact_set
AFTER INSERT ON platform.release_activation_history
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_release_activation_swap_fact_set();

CREATE CONSTRAINT TRIGGER release_activation_outbox_swap_fact_set
AFTER INSERT ON platform.release_activation_outbox
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_release_activation_swap_fact_set();

CREATE CONSTRAINT TRIGGER release_activation_outcome_swap_fact_set
AFTER INSERT ON platform.release_activation_attempt_outcomes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_release_activation_swap_fact_set();

CREATE CONSTRAINT TRIGGER release_activation_receipt_swap_fact_set
AFTER INSERT ON platform.release_activation_swap_receipts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION platform.validate_release_activation_swap_fact_set();

CREATE FUNCTION platform.create_release_activation_authority_epoch_for_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$ BEGIN
  INSERT INTO platform.release_activation_authority_epochs (tenant_id)
  VALUES (NEW.id);
  RETURN NEW; END $$;

CREATE TRIGGER tenants_create_release_activation_authority_epoch
AFTER INSERT ON platform.tenants
FOR EACH ROW
EXECUTE FUNCTION platform.create_release_activation_authority_epoch_for_tenant();

CREATE OR REPLACE FUNCTION platform.assign_release_approver_policy_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ DECLARE prior_eligibility boolean; next_version bigint; BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'northstar.release-approval-authority:' || NEW.tenant_id::text,
      0
    )
  );
  SELECT epoch.approver_policy_version + 1
    INTO next_version
    FROM platform.release_activation_authority_epochs AS epoch
   WHERE epoch.tenant_id = NEW.tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'release activation authority epoch is unavailable'
      USING ERRCODE = 'foreign_key_violation'; END IF;
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
  NEW.policy_version := next_version;
  UPDATE platform.release_activation_authority_epochs
     SET approver_policy_version = next_version
   WHERE tenant_id = NEW.tenant_id;
  RETURN NEW; END $$;

CREATE FUNCTION platform.assign_release_executor_policy_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ DECLARE prior_authorized boolean; next_version bigint; BEGIN
  SELECT epoch.executor_policy_version + 1
    INTO next_version
    FROM platform.release_activation_authority_epochs AS epoch
   WHERE epoch.tenant_id = NEW.tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'release activation authority epoch is unavailable'
      USING ERRCODE = 'foreign_key_violation'; END IF;
  SELECT event.authorized
    INTO prior_authorized
    FROM platform.release_executor_authority_events AS event
   WHERE event.tenant_id = NEW.tenant_id
     AND event.principal_id = NEW.principal_id
   ORDER BY event.policy_version DESC
   LIMIT 1;
  IF FOUND AND prior_authorized IS NOT DISTINCT FROM NEW.authorized THEN
    RAISE EXCEPTION 'release executor authority event must change current authority'
      USING ERRCODE = 'check_violation'; END IF;
  NEW.policy_version := next_version;
  UPDATE platform.release_activation_authority_epochs
     SET executor_policy_version = next_version
   WHERE tenant_id = NEW.tenant_id;
  RETURN NEW; END $$;

CREATE TRIGGER release_executor_event_assign_policy_version
BEFORE INSERT ON platform.release_executor_authority_events
FOR EACH ROW
EXECUTE FUNCTION platform.assign_release_executor_policy_version();

CREATE FUNCTION platform.set_release_executor_authority(
  changed_tenant_id uuid,
  changed_principal_id uuid,
  changed_authorized boolean,
  changed_by uuid,
  changed_event_id uuid
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  INSERT INTO platform.release_executor_authority_events (
    tenant_id,
    policy_version,
    authority_event_id,
    principal_id,
    authorized,
    changed_by
  ) VALUES (
    changed_tenant_id,
    NULL,
    changed_event_id,
    changed_principal_id,
    changed_authorized,
    changed_by
  )
  RETURNING policy_version
$$;

CREATE FUNCTION platform.assign_release_activation_control_policy_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ DECLARE prior_denied boolean; prior_paused boolean; next_version bigint; BEGIN
  SELECT epoch.control_policy_version + 1
    INTO next_version
    FROM platform.release_activation_authority_epochs AS epoch
   WHERE epoch.tenant_id = NEW.tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'release activation authority epoch is unavailable'
      USING ERRCODE = 'foreign_key_violation'; END IF;
  SELECT event.live_policy_denied, event.rollout_paused
    INTO prior_denied, prior_paused
    FROM platform.release_activation_control_events AS event
   WHERE event.tenant_id = NEW.tenant_id
     AND event.environment_id = NEW.environment_id
     AND event.rollout_id IS NOT DISTINCT FROM NEW.rollout_id
   ORDER BY event.policy_version DESC
   LIMIT 1;
  IF FOUND
    AND prior_denied IS NOT DISTINCT FROM NEW.live_policy_denied
    AND prior_paused IS NOT DISTINCT FROM NEW.rollout_paused
  THEN
    RAISE EXCEPTION 'release activation control event must change current control state'
      USING ERRCODE = 'check_violation'; END IF;
  NEW.policy_version := next_version;
  UPDATE platform.release_activation_authority_epochs
     SET control_policy_version = next_version
   WHERE tenant_id = NEW.tenant_id;
  RETURN NEW; END $$;

CREATE TRIGGER release_activation_control_event_assign_policy_version
BEFORE INSERT ON platform.release_activation_control_events
FOR EACH ROW
EXECUTE FUNCTION platform.assign_release_activation_control_policy_version();

CREATE FUNCTION platform.set_release_activation_control(
  changed_tenant_id uuid,
  changed_environment_id uuid,
  changed_rollout_id uuid,
  changed_live_policy_denied boolean,
  changed_rollout_paused boolean,
  changed_by uuid,
  changed_event_id uuid
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  INSERT INTO platform.release_activation_control_events (
    tenant_id,
    environment_id,
    policy_version,
    control_event_id,
    rollout_id,
    live_policy_denied,
    rollout_paused,
    changed_by
  ) VALUES (
    changed_tenant_id,
    changed_environment_id,
    NULL,
    changed_event_id,
    changed_rollout_id,
    changed_live_policy_denied,
    changed_rollout_paused,
    changed_by
  )
  RETURNING policy_version
$$;

CREATE FUNCTION platform.lock_release_activation_authority_epoch(
  requested_tenant_id uuid
)
RETURNS TABLE (
  approver_policy_version bigint,
  executor_policy_version bigint,
  control_policy_version bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT epoch.approver_policy_version,
         epoch.executor_policy_version,
         epoch.control_policy_version
    FROM platform.release_activation_authority_epochs AS epoch
   WHERE epoch.tenant_id = requested_tenant_id
     AND epoch.tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND nullif(current_setting('north_star.environment_id', true), '')::uuid
           IS NOT NULL
     AND nullif(current_setting('north_star.principal_id', true), '')::uuid
           IS NOT NULL
   FOR SHARE
$$;

CREATE FUNCTION platform.lock_release_activation_attempt(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_activation_attempt_id uuid
)
RETURNS TABLE (activation_attempt_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT attempt.activation_attempt_id
    FROM platform.release_activation_attempts AS attempt
   WHERE attempt.tenant_id = requested_tenant_id
     AND attempt.environment_id = requested_environment_id
     AND attempt.activation_attempt_id = requested_activation_attempt_id
     AND attempt.tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND attempt.environment_id =
           nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND nullif(current_setting('north_star.principal_id', true), '')::uuid
           IS NOT NULL
   FOR UPDATE
$$;

CREATE RULE release_executor_authority_events_reject_update
AS ON UPDATE TO platform.release_executor_authority_events
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_executor_authority_events');

CREATE RULE release_executor_authority_events_reject_delete
AS ON DELETE TO platform.release_executor_authority_events
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_executor_authority_events');

CREATE RULE release_activation_control_events_reject_update
AS ON UPDATE TO platform.release_activation_control_events
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_control_events');

CREATE RULE release_activation_control_events_reject_delete
AS ON DELETE TO platform.release_activation_control_events
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_control_events');

CREATE RULE release_activation_swap_receipts_reject_update
AS ON UPDATE TO platform.release_activation_swap_receipts
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_swap_receipts');

CREATE RULE release_activation_swap_receipts_reject_delete
AS ON DELETE TO platform.release_activation_swap_receipts
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_swap_receipts');

CREATE RULE release_activation_verification_receipts_reject_update
AS ON UPDATE TO platform.release_activation_verification_receipts
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_verification_receipts');

CREATE RULE release_activation_verification_receipts_reject_delete
AS ON DELETE TO platform.release_activation_verification_receipts
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_verification_receipts');

CREATE RULE release_activation_reconciliation_starts_reject_update
AS ON UPDATE TO platform.release_activation_reconciliation_starts
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_reconciliation_starts');

CREATE RULE release_activation_reconciliation_starts_reject_delete
AS ON DELETE TO platform.release_activation_reconciliation_starts
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_reconciliation_starts');

CREATE RULE release_activation_reconciliation_alarms_reject_update
AS ON UPDATE TO platform.release_activation_reconciliation_alarms
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_reconciliation_alarms');

CREATE RULE release_activation_reconciliation_alarms_reject_delete
AS ON DELETE TO platform.release_activation_reconciliation_alarms
DO INSTEAD
  INSERT INTO platform.release_activation_write_guard (attempted_relation)
  VALUES ('release_activation_reconciliation_alarms');

ALTER TABLE platform.release_activation_authority_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_authority_epochs FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_executor_authority_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_executor_authority_events FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_control_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_control_events FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_swap_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_swap_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_verification_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_verification_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_reconciliation_starts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_reconciliation_starts FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_reconciliation_alarms ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.release_activation_reconciliation_alarms FORCE ROW LEVEL SECURITY;

CREATE POLICY release_activation_authority_epochs_select_trusted_context
  ON platform.release_activation_authority_epochs
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND nullif(current_setting('north_star.environment_id', true), '')::uuid IS NOT NULL
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_executor_authority_events_select_trusted_context
  ON platform.release_executor_authority_events
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND nullif(current_setting('north_star.environment_id', true), '')::uuid IS NOT NULL
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_control_events_select_trusted_context
  ON platform.release_activation_control_events
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_swap_receipts_select_trusted_context
  ON platform.release_activation_swap_receipts
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_swap_receipts_insert_trusted_context
  ON platform.release_activation_swap_receipts
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_verification_receipts_select_trusted_context
  ON platform.release_activation_verification_receipts
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_verification_receipts_insert_trusted_context
  ON platform.release_activation_verification_receipts
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_reconciliation_starts_select_trusted_context
  ON platform.release_activation_reconciliation_starts
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid =
          '00000000-0000-4000-8000-000000000001'::uuid
  );

CREATE POLICY release_activation_reconciliation_starts_insert_trusted_context
  ON platform.release_activation_reconciliation_starts
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid =
          '00000000-0000-4000-8000-000000000001'::uuid
    AND EXISTS (
      SELECT 1
        FROM platform.release_activation_attempts AS attempt
       WHERE attempt.tenant_id = release_activation_reconciliation_starts.tenant_id
         AND attempt.environment_id = release_activation_reconciliation_starts.environment_id
         AND attempt.activation_attempt_id =
               release_activation_reconciliation_starts.activation_attempt_id
         AND attempt.execution_principal_kind = 'SYSTEM'
         AND attempt.execution_principal_id =
               nullif(current_setting('north_star.principal_id', true), '')::uuid
    )
  );

CREATE POLICY release_activation_reconciliation_alarms_select_trusted_context
  ON platform.release_activation_reconciliation_alarms
  AS PERMISSIVE
  FOR SELECT
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid =
          '00000000-0000-4000-8000-000000000001'::uuid
  );

CREATE POLICY release_activation_reconciliation_alarms_insert_trusted_context
  ON platform.release_activation_reconciliation_alarms
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid =
          '00000000-0000-4000-8000-000000000001'::uuid
  );

CREATE POLICY release_activation_attempt_outcomes_insert_trusted_context
  ON platform.release_activation_attempt_outcomes
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE POLICY release_activation_outbox_insert_trusted_context
  ON platform.release_activation_outbox
  AS PERMISSIVE
  FOR INSERT
  TO north_star_runtime
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

REVOKE ALL ON platform.release_activation_authority_epochs FROM PUBLIC;
REVOKE ALL ON platform.release_executor_authority_events FROM PUBLIC;
REVOKE ALL ON platform.release_activation_control_events FROM PUBLIC;
REVOKE ALL ON platform.release_activation_swap_receipts FROM PUBLIC;
REVOKE ALL ON platform.release_activation_verification_receipts FROM PUBLIC;
REVOKE ALL ON platform.release_activation_reconciliation_starts FROM PUBLIC;
REVOKE ALL ON platform.release_activation_reconciliation_alarms FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.create_release_activation_authority_epoch_for_tenant() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.validate_release_activation_swap_fact_set() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assign_release_executor_policy_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.set_release_executor_authority(uuid, uuid, boolean, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assign_release_activation_control_policy_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.set_release_activation_control(uuid, uuid, uuid, boolean, boolean, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.lock_release_activation_authority_epoch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.lock_release_activation_attempt(uuid, uuid, uuid) FROM PUBLIC;

GRANT SELECT ON platform.release_activation_authority_epochs TO north_star_runtime;
GRANT SELECT ON platform.release_executor_authority_events TO north_star_runtime;
GRANT SELECT ON platform.release_activation_control_events TO north_star_runtime;
GRANT SELECT, INSERT ON platform.release_activation_swap_receipts TO north_star_runtime;
GRANT SELECT, INSERT ON platform.release_activation_verification_receipts TO north_star_runtime;
GRANT SELECT, INSERT ON platform.release_activation_reconciliation_starts TO north_star_runtime;
GRANT SELECT, INSERT ON platform.release_activation_reconciliation_alarms TO north_star_runtime;
GRANT UPDATE ON platform.active_release_pointers TO north_star_runtime;
GRANT INSERT ON platform.release_activation_attempt_outcomes TO north_star_runtime;
GRANT INSERT ON platform.release_activation_outbox TO north_star_runtime;
GRANT EXECUTE ON FUNCTION platform.lock_release_activation_authority_epoch(uuid)
  TO north_star_runtime;
GRANT EXECUTE ON FUNCTION platform.lock_release_activation_attempt(uuid, uuid, uuid)
  TO north_star_runtime;
