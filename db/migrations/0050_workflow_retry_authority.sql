-- Role IDs are part of the activation authority. Legacy snapshots lack the
-- provenance needed to authorize dispatch and cannot be backfilled from live grants.
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
           SELECT jsonb_agg(DISTINCT jsonb_build_array(g.permission_id, g.resource_id, m.legal_entity_id, m.role_id))
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

REVOKE UPDATE (execution_fence, status, reason) ON platform.workflow_runs FROM north_star_workflow_worker;

CREATE TABLE platform.workflow_retry_decisions (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  run_id uuid NOT NULL,
  fence bigint NOT NULL,
  previous_fence bigint NOT NULL CHECK (previous_fence < fence),
  decided_by uuid NOT NULL,
  request_id uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, run_id, fence),
  FOREIGN KEY (tenant_id, environment_id, run_id)
    REFERENCES platform.workflow_runs (tenant_id, environment_id, run_id)
);

ALTER TABLE platform.workflow_retry_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_scoped_retry_decisions ON platform.workflow_retry_decisions
  FOR SELECT TO north_star_workflow_worker USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );
GRANT SELECT ON platform.workflow_retry_decisions TO north_star_workflow_worker;

CREATE FUNCTION platform.workflow_set_worker_status(
  requested_run uuid, requested_fence bigint, next_status text, next_reason text
) RETURNS boolean LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH changed AS (
    UPDATE platform.workflow_runs
       SET status = next_status, reason = next_reason
     WHERE tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
       AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
       AND run_id = requested_run AND execution_fence = requested_fence
       AND (
         (status = 'RUNNABLE' AND next_status IN ('WAITING', 'SUSPENDED', 'QUARANTINED', 'COMPLETED'))
         OR (status = 'WAITING' AND next_status = 'SUSPENDED')
         OR (status = 'SUSPENDED' AND reason = 'stale-release-pin'
             AND next_status = 'SUSPENDED' AND next_reason = 'oversized-effect-result')
         OR (status = 'WAITING' AND next_status = 'RUNNABLE' AND EXISTS (
           SELECT 1 FROM platform.workflow_timers AS timer
            WHERE (timer.tenant_id, timer.environment_id, timer.run_id) =
                  (workflow_runs.tenant_id, workflow_runs.environment_id, workflow_runs.run_id)
              AND NOT EXISTS (
                SELECT 1 FROM platform.workflow_journal AS j
                 WHERE (j.tenant_id, j.environment_id, j.run_id, j.cursor) =
                       (timer.tenant_id, timer.environment_id, timer.run_id, timer.cursor)
                   AND j.kind = 'RESULT'
              )
         ))
       )
     RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM changed)
$$;
REVOKE ALL ON FUNCTION platform.workflow_set_worker_status(uuid, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_set_worker_status(uuid, bigint, text, text)
  TO north_star_workflow_worker;

CREATE FUNCTION platform.workflow_apply_remedy(
  requested_run uuid, old_fence bigint, new_fence bigint, requested_action text, expected_journal_count integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  tenant uuid := nullif(current_setting('north_star.tenant_id', true), '')::uuid;
  environment uuid := nullif(current_setting('north_star.environment_id', true), '')::uuid;
  principal uuid := nullif(current_setting('north_star.principal_id', true), '')::uuid;
  request uuid := nullif(current_setting('north_star.request_id', true), '')::uuid;
  active platform.active_release_pointers%ROWTYPE;
  run platform.workflow_runs%ROWTYPE; BEGIN
  IF requested_action IS NULL OR requested_action NOT IN ('retry', 'cancel')
     OR principal IS NULL OR request IS NULL
  THEN RETURN false; END IF;
  PERFORM 1 FROM platform.release_activation_authority_epochs WHERE tenant_id = tenant FOR SHARE;
  IF NOT COALESCE((
    SELECT eligible FROM platform.release_approver_eligibility_events
     WHERE tenant_id = tenant AND principal_id = principal
     ORDER BY policy_version DESC LIMIT 1
  ), false) OR EXISTS (
    SELECT 1 FROM platform.workflow_definitions
     WHERE tenant_id = tenant AND automation_principal_id = principal
  ) THEN RETURN false; END IF;
  SELECT * INTO active FROM platform.active_release_pointers
   WHERE tenant_id = tenant AND environment_id = environment FOR SHARE;
  SELECT * INTO run FROM platform.workflow_runs
   WHERE tenant_id = tenant AND environment_id = environment AND run_id = requested_run
     AND status = 'SUSPENDED' AND execution_fence = old_fence FOR UPDATE;
  IF NOT FOUND OR expected_journal_count IS DISTINCT FROM (
    SELECT count(*)::int FROM platform.workflow_journal
     WHERE tenant_id = tenant AND environment_id = environment AND run_id = requested_run
       AND kind IN ('REQUEST', 'RESULT')
  ) THEN RETURN false; END IF;

  IF requested_action = 'retry' THEN
    IF run.reason <> 'stale-release-pin' OR new_fence IS NULL OR new_fence <= old_fence
       OR (active.pointer_id, active.release_id, active.fence) IS DISTINCT FROM
          (run.pointer_id, run.release_id, new_fence)
       OR NOT EXISTS (
         SELECT 1
           FROM platform.workflow_definitions AS d
           JOIN platform.workflow_activation_watermarks AS previous USING (tenant_id, environment_id, release_id)
           JOIN platform.workflow_activation_watermarks AS incoming USING (tenant_id, environment_id, release_id)
          WHERE (d.tenant_id, d.environment_id, d.release_id, d.workflow_id) =
                (tenant, environment, run.release_id, run.workflow_id)
            AND (previous.pointer_id, previous.fence, previous.release_root) =
                (run.pointer_id, run.initial_fence, run.release_root)
            AND (incoming.pointer_id, incoming.fence, incoming.release_root) =
                (run.pointer_id, new_fence, run.release_root)
            AND previous.verified_approval_binding AND incoming.verified_approval_binding
            AND previous.definition_bindings->d.workflow_id->>'digest' = platform.workflow_definition_digest(d)
            AND incoming.definition_bindings->d.workflow_id = previous.definition_bindings->d.workflow_id
       )
    THEN RETURN false; END IF;
    INSERT INTO platform.workflow_retry_decisions (
      tenant_id, environment_id, run_id, fence, previous_fence, decided_by, request_id
    ) VALUES (tenant, environment, requested_run, new_fence, old_fence, principal, request);
    UPDATE platform.workflow_runs SET status = 'RUNNABLE', reason = NULL, execution_fence = new_fence
     WHERE tenant_id = tenant AND environment_id = environment AND run_id = requested_run;
  ELSE
    UPDATE platform.workflow_runs SET status = 'CANCELLED', reason = 'operator-cancelled'
     WHERE tenant_id = tenant AND environment_id = environment AND run_id = requested_run;
  END IF;
  INSERT INTO platform.workflow_journal (tenant_id, environment_id, run_id, cursor, kind, canonical_bytes)
  VALUES (tenant, environment, requested_run, 0, 'CONTROL', convert_to(format(
    '{"fence":"%s","operator":"%s","reason":"%s"}',
    CASE WHEN requested_action = 'retry' THEN new_fence ELSE old_fence END,
    principal,
    CASE WHEN requested_action = 'retry' THEN 'same-pin-retry' ELSE 'operator-cancelled' END
  ), 'UTF8'));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION platform.workflow_apply_remedy(uuid, bigint, bigint, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_apply_remedy(uuid, bigint, bigint, text, integer)
  TO north_star_runtime;

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
     AND (r.execution_fence = r.initial_fence OR EXISTS (
       SELECT 1 FROM platform.workflow_retry_decisions AS retry
        WHERE (retry.tenant_id, retry.environment_id, retry.run_id, retry.fence) =
              (r.tenant_id, r.environment_id, r.run_id, r.execution_fence)
     ))
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
