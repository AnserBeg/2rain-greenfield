-- Workflow definitions and journal entries are runtime proposals. Only the
-- verification connection can publish release-bound workflow evidence.
CREATE ROLE north_star_workflow_verifier
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA platform TO north_star_workflow_verifier;
REVOKE ALL ON platform.workflow_verification_evidence FROM north_star_runtime;
DROP POLICY workflow_scoped_release_author ON platform.workflow_verification_evidence;
ALTER TABLE platform.workflow_verification_evidence
  ADD COLUMN verified_release_id uuid,
  ADD COLUMN verified_release_root text,
  ADD FOREIGN KEY (tenant_id, environment_id, verified_release_id, verification_evidence_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id, verification_evidence_id),
  ADD CHECK ((verified_release_id IS NULL AND verified_release_root IS NULL)
    OR (verified_release_id IS NOT NULL AND verified_release_root IS NOT NULL
      AND verified_release_root ~ '^[0-9a-f]{64}$'));
CREATE POLICY workflow_verifier_evidence ON platform.workflow_verification_evidence
  FOR INSERT TO north_star_workflow_verifier
  WITH CHECK (tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND verified_release_id IS NOT NULL AND verified_release_root IS NOT NULL);
GRANT INSERT ON platform.workflow_verification_evidence TO north_star_workflow_verifier;

ALTER TABLE platform.release_approvals
  ADD COLUMN workflow_definition_bindings jsonb CHECK (jsonb_typeof(workflow_definition_bindings) = 'object');
ALTER TABLE platform.workflow_activation_watermarks
  ADD COLUMN verified_approval_binding boolean NOT NULL DEFAULT false;

-- Freeze the verifier's exact set at the human approval. Existing approvals
-- have no set. The trigger owns the column even for an explicit INSERT value.
CREATE FUNCTION platform.workflow_bind_release_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ BEGIN
  SELECT jsonb_object_agg(d.workflow_id, jsonb_build_object(
           'digest', e.binding_digest, 'eventType', d.event_type,
           'unattendedOperations', e.unattended_operations
         ))
    INTO NEW.workflow_definition_bindings
    FROM platform.workflow_verification_evidence AS e
    JOIN platform.workflow_definitions AS d
      ON (d.tenant_id, d.environment_id, d.release_id, d.workflow_id) =
         (e.tenant_id, e.environment_id, e.verified_release_id, e.workflow_id)
     AND e.binding_digest = platform.workflow_definition_digest(d)
    JOIN platform.tenant_releases AS r
      ON (r.tenant_id, r.environment_id, r.release_id, r.verification_evidence_id, r.content_hash) =
         (e.tenant_id, e.environment_id, e.verified_release_id, e.verification_evidence_id, e.verified_release_root)
   WHERE (e.tenant_id, e.environment_id, e.verification_evidence_id, e.verified_release_id, e.verified_release_root) =
         (NEW.tenant_id, NEW.environment_id, NEW.verification_evidence_id,
           NEW.target_release_id, encode(NEW.target_manifest_root, 'hex'));
  RETURN NEW; END
$$;
REVOKE ALL ON FUNCTION platform.workflow_bind_release_approval() FROM PUBLIC;
CREATE TRIGGER workflow_bind_release_approval BEFORE INSERT ON platform.release_approvals
  FOR EACH ROW EXECUTE FUNCTION platform.workflow_bind_release_approval();

-- Rotate selected runs before dispatch. Infrastructure failures stay retryable
-- without holding every slot in the next batch.
CREATE SEQUENCE platform.workflow_run_poll_order AS bigint;
GRANT USAGE ON SEQUENCE platform.workflow_run_poll_order TO north_star_workflow_worker;
ALTER TABLE platform.workflow_runs ADD COLUMN poll_order bigint NOT NULL DEFAULT 0;
GRANT UPDATE (poll_order) ON platform.workflow_runs TO north_star_workflow_worker;
DROP INDEX platform.workflow_runs_runnable_idx;
CREATE INDEX workflow_runs_runnable_idx
  ON platform.workflow_runs (tenant_id, environment_id, poll_order, created_at, run_id)
  WHERE status = 'RUNNABLE';

-- Older decisions lacked a link to the exact journal request.
UPDATE platform.workflow_pending_approvals SET status = 'STALE' WHERE status IN ('APPROVED', 'DECLINED');

CREATE OR REPLACE FUNCTION platform.workflow_subscribed_at_active_fence(
  requested_tenant uuid, requested_environment uuid, requested_event text
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform.active_release_pointers AS p
    JOIN platform.workflow_activation_watermarks AS w USING (tenant_id, environment_id, pointer_id, fence, release_id)
    CROSS JOIN LATERAL jsonb_each(w.definition_bindings) AS binding(id, value)
    WHERE p.tenant_id = requested_tenant AND p.environment_id = requested_environment
      AND w.verified_approval_binding
      AND binding.value->>'eventType' = requested_event
  )
  AND requested_tenant = nullif(current_setting('north_star.tenant_id', true), '')::uuid
  AND requested_environment = nullif(current_setting('north_star.environment_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION platform.workflow_subscribed_at_active_fence(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_subscribed_at_active_fence(uuid, uuid, text)
  TO north_star_workflow_worker;

CREATE OR REPLACE FUNCTION platform.workflow_lock_runnable_effect(
  requested_run uuid, requested_pointer uuid, requested_release uuid,
  requested_fence bigint, requested_effect uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ BEGIN
  PERFORM 1
    FROM platform.workflow_runs AS r
    JOIN platform.workflow_effect_outbox AS e USING (tenant_id, environment_id, run_id)
    JOIN platform.workflow_definitions AS d USING (tenant_id, environment_id, release_id, workflow_id)
    JOIN platform.workflow_activation_watermarks AS w
      ON (w.tenant_id, w.environment_id, w.pointer_id, w.fence) =
         (r.tenant_id, r.environment_id, r.pointer_id, r.initial_fence)
    JOIN platform.workflow_activation_watermarks AS active
      ON (active.tenant_id, active.environment_id, active.pointer_id, active.fence, active.release_id, active.release_root) =
         (r.tenant_id, r.environment_id, r.pointer_id, r.execution_fence, r.release_id, r.release_root)
   WHERE r.tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND r.environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND d.automation_principal_id = nullif(current_setting('north_star.principal_id', true), '')::uuid
     AND r.run_id = requested_run AND r.pointer_id = requested_pointer AND r.release_id = requested_release
     AND r.execution_fence = requested_fence AND r.status = 'RUNNABLE'
     AND e.idempotency_key = requested_effect
     AND w.verified_approval_binding AND active.verified_approval_binding
     AND w.definition_bindings->d.workflow_id->>'digest' = platform.workflow_definition_digest(d)
     AND active.definition_bindings->d.workflow_id->>'digest' = w.definition_bindings->d.workflow_id->>'digest'
   FOR UPDATE OF r;
  RETURN FOUND; END
$$;
REVOKE ALL ON FUNCTION platform.workflow_lock_runnable_effect(uuid, uuid, uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_lock_runnable_effect(uuid, uuid, uuid, bigint, uuid)
  TO north_star_runtime;

CREATE OR REPLACE FUNCTION platform.workflow_decide_approval(
  requested_run uuid, requested_cursor integer, requested_fence bigint,
  requested_plan_digest text, decision text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant uuid := nullif(current_setting('north_star.tenant_id', true), '')::uuid;
  environment uuid := nullif(current_setting('north_star.environment_id', true), '')::uuid;
  principal uuid := nullif(current_setting('north_star.principal_id', true), '')::uuid;
  active_pointer uuid;
  active_release uuid; BEGIN
  IF decision NOT IN ('APPROVED', 'DECLINED') OR decision IS NULL OR principal IS NULL
     OR nullif(current_setting('north_star.request_id', true), '') IS NULL
  THEN RETURN false; END IF;
  PERFORM 1 FROM platform.release_activation_authority_epochs AS epoch WHERE epoch.tenant_id = tenant FOR SHARE;
  IF NOT COALESCE((
    SELECT e.eligible FROM platform.release_approver_eligibility_events AS e
     WHERE e.tenant_id = tenant AND e.principal_id = principal
     ORDER BY e.policy_version DESC LIMIT 1
  ), false) THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM platform.workflow_definitions AS d
     WHERE d.tenant_id = tenant AND d.automation_principal_id = principal
  ) THEN RETURN false; END IF;
  SELECT p.pointer_id, p.release_id INTO active_pointer, active_release
    FROM platform.active_release_pointers AS p
   WHERE p.tenant_id = tenant AND p.environment_id = environment AND p.fence = requested_fence
   FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM platform.workflow_runs AS r
    JOIN platform.workflow_definitions AS d USING (tenant_id, environment_id, release_id, workflow_id)
    JOIN platform.workflow_activation_watermarks AS w
      ON (w.tenant_id, w.environment_id, w.pointer_id, w.fence, w.release_id, w.release_root) =
         (r.tenant_id, r.environment_id, r.pointer_id, r.execution_fence, r.release_id, r.release_root)
    JOIN platform.workflow_journal AS j ON (j.tenant_id, j.environment_id, j.run_id) = (r.tenant_id, r.environment_id, r.run_id)
   WHERE r.tenant_id = tenant AND r.environment_id = environment AND r.run_id = requested_run
     AND r.pointer_id = active_pointer AND r.release_id = active_release
     AND r.execution_fence = requested_fence AND r.status = 'WAITING'
     AND w.verified_approval_binding
     AND w.definition_bindings->d.workflow_id->>'digest' = platform.workflow_definition_digest(d)
     AND j.cursor = requested_cursor AND j.kind = 'REQUEST'
     AND encode(sha256(j.canonical_bytes), 'hex') = requested_plan_digest
     AND convert_from(j.canonical_bytes, 'UTF8')::jsonb->>'kind' = 'requestApproval'
     AND d.automation_principal_id <> principal
   FOR UPDATE OF r;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE platform.workflow_pending_approvals AS a
     SET status = decision, decided_by = principal, decided_at = clock_timestamp(),
         decision_request_id = current_setting('north_star.request_id')::uuid
   WHERE a.tenant_id = tenant AND a.environment_id = environment AND a.run_id = requested_run
     AND a.cursor = requested_cursor AND a.fence = requested_fence
     AND a.plan_digest = requested_plan_digest AND a.status = 'PENDING';
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO platform.workflow_journal (tenant_id, environment_id, run_id, cursor, kind, canonical_bytes)
    VALUES (tenant, environment, requested_run, requested_cursor, 'RESULT',
            convert_to((decision = 'APPROVED')::text, 'UTF8'))
    ON CONFLICT DO NOTHING;
  UPDATE platform.workflow_runs SET status = 'RUNNABLE', reason = NULL
   WHERE tenant_id = tenant AND environment_id = environment AND run_id = requested_run;
  RETURN true; END
$$;
REVOKE ALL ON FUNCTION platform.workflow_decide_approval(uuid, integer, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_decide_approval(uuid, integer, bigint, text, text)
  TO north_star_runtime;

CREATE OR REPLACE FUNCTION platform.workflow_capture_watermark() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  incoming jsonb;
  outgoing jsonb;
  subscribed_types text[]; BEGIN
  SELECT a.workflow_definition_bindings
    INTO incoming
    FROM platform.release_activation_swap_receipts AS swap
    JOIN platform.release_approvals AS a
      ON (a.tenant_id, a.environment_id, a.approval_id, a.activation_attempt_id) =
         (swap.tenant_id, swap.environment_id, swap.approval_id, swap.activation_attempt_id)
    JOIN platform.active_release_pointers AS p
      ON (p.tenant_id, p.environment_id, p.pointer_id, p.fence, p.release_id) =
         (swap.tenant_id, swap.environment_id, swap.pointer_id, swap.fence, swap.activated_release_id)
   WHERE (swap.tenant_id, swap.environment_id, swap.activation_attempt_id, swap.pointer_id,
          swap.fence, swap.activated_release_id) =
         (NEW.tenant_id, NEW.environment_id, NEW.activation_attempt_id, NEW.pointer_id,
          NEW.fence, NEW.activated_release_id)
     AND a.expected_pointer_id = NEW.pointer_id AND a.expected_fence + 1 = NEW.fence
     AND a.target_release_id = NEW.activated_release_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  incoming := COALESCE(incoming, '{}'::jsonb);

  SELECT w.definition_bindings INTO outgoing
    FROM platform.workflow_activation_watermarks AS w
   WHERE w.tenant_id = NEW.tenant_id AND w.environment_id = NEW.environment_id
     AND w.pointer_id = NEW.pointer_id AND w.fence = NEW.fence - 1
     AND w.verified_approval_binding;

  SELECT array_agg(DISTINCT subscription.value->>'eventType') INTO subscribed_types
    FROM (
      SELECT value FROM jsonb_each(incoming)
      UNION ALL
      SELECT value FROM jsonb_each(outgoing)
    ) AS subscription;
  IF subscribed_types IS NULL THEN RETURN NEW; END IF;

  INSERT INTO platform.workflow_activation_watermarks (
    tenant_id, environment_id, pointer_id, fence, release_id, release_root,
    activation_attempt_id, approver_id, approver_grants, definition_bindings, verified_approval_binding
  )
  SELECT NEW.tenant_id, NEW.environment_id, NEW.pointer_id, NEW.fence, NEW.activated_release_id,
         r.content_hash, NEW.activation_attempt_id, a.approving_human_id,
         COALESCE((
           SELECT jsonb_agg(DISTINCT jsonb_build_array(g.permission_id, g.resource_id, m.legal_entity_id))
             FROM platform.current_policy_memberships AS m
             JOIN platform.current_policy_roles AS role USING (tenant_id, environment_id, role_id)
             JOIN platform.current_policy_permission_grants AS g USING (tenant_id, environment_id, role_id)
            WHERE m.tenant_id = NEW.tenant_id AND m.environment_id = NEW.environment_id
              AND m.principal_id = a.approving_human_id
              AND m.revoked_at IS NULL AND role.revoked_at IS NULL AND g.revoked_at IS NULL
         ), '[]'::jsonb), incoming, true
    FROM platform.release_activation_swap_receipts AS swap
    JOIN platform.release_approvals AS a USING (tenant_id, environment_id, approval_id)
    JOIN platform.tenant_releases AS r
      ON r.tenant_id = swap.tenant_id AND r.environment_id = swap.environment_id
     AND r.release_id = swap.activated_release_id
   WHERE swap.tenant_id = NEW.tenant_id AND swap.environment_id = NEW.environment_id
     AND swap.activation_attempt_id = NEW.activation_attempt_id;

  -- This statement's snapshot is the activation boundary. A later commit with
  -- an earlier UUID or recorded time is still visible to a subsequent sweep.
  INSERT INTO platform.workflow_event_occurrences (tenant_id, environment_id, outbox_id, pointer_id, fence, disposition)
  SELECT o.tenant_id, o.environment_id, o.outbox_id, NEW.pointer_id, NEW.fence, 'PRE_ACTIVATION'
    FROM platform.workflow_event_sources AS o
   WHERE o.tenant_id = NEW.tenant_id AND o.environment_id = NEW.environment_id
     AND o.event_type = ANY(subscribed_types) AND NOT o.resolved;

  RETURN NEW; END
$$;
