-- Bind work to the exact definitions captured by a verified activation.
ALTER TABLE platform.workflow_verification_evidence
  ADD COLUMN unattended_operations jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(unattended_operations) = 'object' AND octet_length(unattended_operations::text) <= 65536);
ALTER TABLE platform.workflow_activation_watermarks
  ADD COLUMN definition_bindings jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(definition_bindings) = 'object');

CREATE FUNCTION platform.workflow_definition_digest(definition platform.workflow_definitions)
RETURNS text LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    definition.tenant_id, definition.environment_id, definition.release_id, definition.workflow_id,
    definition.event_type, definition.body_digest, definition.executable_digest, definition.sdk_digest,
    definition.engine_build, definition.host_version, definition.sdk_version,
    definition.automation_principal_id, definition.authored_by, definition.grants
  )::text, 'UTF8')), 'hex')
$$;
REVOKE ALL ON FUNCTION platform.workflow_definition_digest(platform.workflow_definitions) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_definition_digest(platform.workflow_definitions)
  TO north_star_workflow_worker;

-- This projection contains only unresolved source keys. The trust rows and
-- their append-only dispositions remain the audit record.
CREATE TABLE platform.workflow_unresolved_receipts (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, outbox_id),
  FOREIGN KEY (tenant_id, environment_id, outbox_id)
    REFERENCES platform.trust_outbox (tenant_id, environment_id, outbox_id)
);
CREATE TABLE platform.workflow_receipt_scan_positions (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  pointer_id uuid NOT NULL,
  fence bigint NOT NULL,
  next_outbox_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, environment_id),
  FOREIGN KEY (tenant_id, environment_id, pointer_id, fence)
    REFERENCES platform.workflow_activation_watermarks (tenant_id, environment_id, pointer_id, fence)
);

LOCK TABLE platform.trust_outbox, platform.workflow_event_occurrences IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO platform.workflow_unresolved_receipts (tenant_id, environment_id, outbox_id)
SELECT o.tenant_id, o.environment_id, o.outbox_id
  FROM platform.trust_outbox AS o
 WHERE o.event_type = 'northstar.purchasing:event.receipt_posted'
   AND NOT EXISTS (
     SELECT 1 FROM platform.workflow_event_occurrences AS e
      WHERE (e.tenant_id, e.environment_id, e.outbox_id) =
            (o.tenant_id, o.environment_id, o.outbox_id)
   );

CREATE FUNCTION platform.workflow_index_unresolved_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO platform.workflow_unresolved_receipts VALUES (NEW.tenant_id, NEW.environment_id, NEW.outbox_id);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION platform.workflow_index_unresolved_receipt() FROM PUBLIC;
CREATE TRIGGER workflow_index_unresolved_receipt
  AFTER INSERT ON platform.trust_outbox
  FOR EACH ROW WHEN (NEW.event_type = 'northstar.purchasing:event.receipt_posted')
  EXECUTE FUNCTION platform.workflow_index_unresolved_receipt();

CREATE FUNCTION platform.workflow_resolve_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM platform.workflow_unresolved_receipts
   WHERE (tenant_id, environment_id, outbox_id) = (NEW.tenant_id, NEW.environment_id, NEW.outbox_id);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION platform.workflow_resolve_receipt() FROM PUBLIC;
CREATE TRIGGER workflow_resolve_receipt AFTER INSERT ON platform.workflow_event_occurrences
  FOR EACH ROW EXECUTE FUNCTION platform.workflow_resolve_receipt();

CREATE FUNCTION platform.workflow_subscribed_at_active_fence(
  requested_tenant uuid, requested_environment uuid, requested_event text
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform.active_release_pointers AS p
    JOIN platform.workflow_activation_watermarks AS w USING (tenant_id, environment_id, pointer_id, fence, release_id)
    CROSS JOIN LATERAL jsonb_each(w.definition_bindings) AS binding(id, value)
    WHERE p.tenant_id = requested_tenant AND p.environment_id = requested_environment
      AND binding.value->>'eventType' = requested_event
  )
  AND requested_tenant = nullif(current_setting('north_star.tenant_id', true), '')::uuid
  AND requested_environment = nullif(current_setting('north_star.environment_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION platform.workflow_subscribed_at_active_fence(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_subscribed_at_active_fence(uuid, uuid, text)
  TO north_star_workflow_worker;

ALTER TABLE platform.workflow_unresolved_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.workflow_unresolved_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_worker_pending_sources ON platform.workflow_unresolved_receipts
  FOR SELECT TO north_star_workflow_worker
  USING (platform.workflow_subscribed_at_active_fence(tenant_id, environment_id, 'northstar.purchasing:event.receipt_posted'));
GRANT SELECT ON platform.workflow_unresolved_receipts TO north_star_workflow_worker;

ALTER TABLE platform.workflow_receipt_scan_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.workflow_receipt_scan_positions FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_worker_scan_position ON platform.workflow_receipt_scan_positions
  TO north_star_workflow_worker
  USING (tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid);
GRANT SELECT, INSERT ON platform.workflow_receipt_scan_positions TO north_star_workflow_worker;
GRANT UPDATE (pointer_id, fence, next_outbox_id) ON platform.workflow_receipt_scan_positions TO north_star_workflow_worker;

DROP POLICY workflow_scoped_source ON platform.trust_outbox;
DROP POLICY workflow_scoped_source ON platform.trust_domain_events;
DROP POLICY workflow_scoped_source ON platform.trust_business_change_documents;
DROP POLICY workflow_scoped_source ON platform.trust_action_invocations;

REVOKE SELECT ON platform.trust_outbox, platform.trust_domain_events,
  platform.trust_business_change_documents FROM north_star_workflow_worker;
GRANT SELECT (tenant_id, environment_id, outbox_id, invocation_id, change_document_id, domain_event_id,
  action_id, release_id, release_content_hash, event_type, event_schema_version)
  ON platform.trust_outbox TO north_star_workflow_worker;
GRANT SELECT (tenant_id, environment_id, domain_event_id, outbox_id, invocation_id, change_document_id,
  release_id, release_content_hash, event_type, event_schema_version, action_id, payload)
  ON platform.trust_domain_events TO north_star_workflow_worker;
GRANT SELECT (tenant_id, environment_id, change_document_id, invocation_id, release_id, release_content_hash,
  domain_event_id, outbox_id, action_id, record_type, record_id, execution_principal_id)
  ON platform.trust_business_change_documents TO north_star_workflow_worker;

CREATE POLICY workflow_scoped_source ON platform.trust_outbox FOR SELECT TO north_star_workflow_worker
  USING (platform.workflow_subscribed_at_active_fence(tenant_id, environment_id, event_type));
CREATE POLICY workflow_scoped_source ON platform.trust_domain_events FOR SELECT TO north_star_workflow_worker
  USING (platform.workflow_subscribed_at_active_fence(tenant_id, environment_id, event_type));
CREATE POLICY workflow_scoped_source ON platform.trust_business_change_documents FOR SELECT TO north_star_workflow_worker
  USING (EXISTS (
    SELECT 1 FROM platform.trust_outbox AS o
     WHERE (o.tenant_id, o.environment_id, o.outbox_id, o.change_document_id) =
           (trust_business_change_documents.tenant_id, trust_business_change_documents.environment_id,
            trust_business_change_documents.outbox_id, trust_business_change_documents.change_document_id)
  ));
CREATE POLICY workflow_scoped_source ON platform.trust_action_invocations FOR SELECT TO north_star_workflow_worker
  USING (EXISTS (
    SELECT 1 FROM platform.trust_domain_events AS e
     WHERE (e.tenant_id, e.environment_id, e.invocation_id) =
           (trust_action_invocations.tenant_id, trust_action_invocations.environment_id,
            trust_action_invocations.invocation_id)
  ));

ALTER TABLE platform.workflow_pending_approvals ADD COLUMN decision_request_id uuid;
UPDATE platform.workflow_pending_approvals SET status = 'STALE' WHERE status IN ('APPROVED', 'DECLINED');
ALTER TABLE platform.workflow_pending_approvals ADD CHECK (
  status NOT IN ('APPROVED', 'DECLINED') OR decision_request_id IS NOT NULL
);
REVOKE INSERT, UPDATE (status, decided_by, decided_at)
  ON platform.workflow_pending_approvals FROM north_star_workflow_worker;
GRANT INSERT (tenant_id, environment_id, run_id, cursor, fence, plan, plan_digest)
  ON platform.workflow_pending_approvals TO north_star_workflow_worker;

CREATE FUNCTION platform.workflow_lock_runnable_effect(
  requested_run uuid, requested_pointer uuid, requested_release uuid,
  requested_fence bigint, requested_effect uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM 1
    FROM platform.workflow_runs AS r
    JOIN platform.workflow_effect_outbox AS e USING (tenant_id, environment_id, run_id)
    JOIN platform.workflow_definitions AS d USING (tenant_id, environment_id, release_id, workflow_id)
    JOIN platform.workflow_activation_watermarks AS w
      ON (w.tenant_id, w.environment_id, w.pointer_id, w.fence) =
         (r.tenant_id, r.environment_id, r.pointer_id, r.initial_fence)
   WHERE r.tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND r.environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND d.automation_principal_id = nullif(current_setting('north_star.principal_id', true), '')::uuid
     AND r.run_id = requested_run AND r.pointer_id = requested_pointer AND r.release_id = requested_release
     AND r.execution_fence = requested_fence AND r.status = 'RUNNABLE'
     AND e.idempotency_key = requested_effect
     AND w.definition_bindings->d.workflow_id->>'digest' = platform.workflow_definition_digest(d)
   FOR UPDATE OF r;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION platform.workflow_lock_runnable_effect(uuid, uuid, uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_lock_runnable_effect(uuid, uuid, uuid, bigint, uuid)
  TO north_star_runtime;

CREATE FUNCTION platform.workflow_decide_approval(
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
  active_release uuid;
BEGIN
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
   WHERE r.tenant_id = tenant AND r.environment_id = environment AND r.run_id = requested_run
     AND r.pointer_id = active_pointer AND r.release_id = active_release
     AND r.execution_fence = requested_fence AND r.status = 'WAITING'
     AND d.automation_principal_id <> principal
   FOR UPDATE OF r;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE platform.workflow_pending_approvals AS a
     SET status = decision, decided_by = principal, decided_at = clock_timestamp(),
         decision_request_id = current_setting('north_star.request_id')::uuid
   WHERE a.tenant_id = tenant AND a.environment_id = environment AND a.run_id = requested_run
     AND a.cursor = requested_cursor AND a.fence = requested_fence
     AND a.plan_digest = requested_plan_digest AND a.status = 'PENDING';
  RETURN FOUND;
END
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
BEGIN
  SELECT COALESCE(jsonb_object_agg(d.workflow_id, jsonb_build_object(
           'digest', e.binding_digest, 'eventType', d.event_type,
           'unattendedOperations', e.unattended_operations
         )), '{}'::jsonb)
    INTO incoming
    FROM platform.release_activation_swap_receipts AS swap
    JOIN platform.release_approvals AS approval USING (tenant_id, environment_id, approval_id)
    JOIN platform.workflow_verification_evidence AS e
      ON (e.tenant_id, e.environment_id, e.verification_evidence_id) =
         (approval.tenant_id, approval.environment_id, approval.verification_evidence_id)
    JOIN platform.workflow_definitions AS d
      ON (d.tenant_id, d.environment_id, d.release_id, d.workflow_id) =
         (swap.tenant_id, swap.environment_id, swap.activated_release_id, e.workflow_id)
     AND e.binding_digest = platform.workflow_definition_digest(d)
   WHERE swap.tenant_id = NEW.tenant_id AND swap.environment_id = NEW.environment_id
     AND swap.activation_attempt_id = NEW.activation_attempt_id;

  SELECT w.definition_bindings INTO outgoing
    FROM platform.workflow_activation_watermarks AS w
   WHERE w.tenant_id = NEW.tenant_id AND w.environment_id = NEW.environment_id
     AND w.pointer_id = NEW.pointer_id AND w.fence = NEW.fence - 1;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_each(incoming) AS b WHERE b.value->>'eventType' = 'northstar.purchasing:event.receipt_posted'
    UNION ALL
    SELECT 1 FROM jsonb_each(outgoing) AS b WHERE b.value->>'eventType' = 'northstar.purchasing:event.receipt_posted'
  ) THEN RETURN NEW; END IF;

  INSERT INTO platform.workflow_activation_watermarks (
    tenant_id, environment_id, pointer_id, fence, release_id, release_root,
    activation_attempt_id, approver_id, approver_grants, definition_bindings
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
         ), '[]'::jsonb), incoming
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
    FROM platform.workflow_unresolved_receipts AS o
   WHERE o.tenant_id = NEW.tenant_id AND o.environment_id = NEW.environment_id;

  RETURN NEW; END
$$;

CREATE FUNCTION platform.workflow_read_pointer()
RETURNS TABLE (pointer_id uuid, fence bigint, release_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p.pointer_id, p.fence, p.release_id
    FROM platform.active_release_pointers AS p
   WHERE p.tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND p.environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION platform.workflow_read_pointer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_read_pointer() TO north_star_workflow_worker;
