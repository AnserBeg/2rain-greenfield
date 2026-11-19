CREATE ROLE north_star_workflow_worker
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA platform TO north_star_workflow_worker;

CREATE TABLE platform.workflow_body_blobs (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  body_digest text NOT NULL,
  bundle bytea NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, body_digest),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments (tenant_id, id),
  CHECK (octet_length(bundle) BETWEEN 2 AND 1048576
    AND body_digest = encode(sha256(bundle), 'hex'))
);

CREATE TABLE platform.workflow_definitions (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  release_id uuid NOT NULL,
  workflow_id text NOT NULL CHECK (workflow_id ~ '^[a-z][a-z0-9_.:-]{0,159}$'),
  event_type text NOT NULL CHECK (event_type = 'northstar.inventory:event.receipt_posted'),
  body_digest text NOT NULL,
  executable bytea NOT NULL CHECK (octet_length(executable) BETWEEN 1 AND 1048576),
  executable_digest text NOT NULL CHECK (executable_digest = encode(sha256(executable), 'hex')),
  sdk_digest text NOT NULL CHECK (sdk_digest ~ '^[0-9a-f]{64}$'),
  engine_build text NOT NULL CHECK (btrim(engine_build) <> ''),
  host_version text NOT NULL CHECK (btrim(host_version) <> ''),
  sdk_version text NOT NULL CHECK (btrim(sdk_version) <> ''),
  automation_principal_id uuid NOT NULL,
  authored_by uuid NOT NULL,
  grants jsonb NOT NULL CHECK (
    jsonb_typeof(grants) = 'object'
    AND grants ?& ARRAY['queries', 'operations']
    AND jsonb_typeof(grants->'queries') = 'array'
    AND jsonb_typeof(grants->'operations') = 'array'
    AND octet_length(grants::text) <= 65536
  ),
  PRIMARY KEY (tenant_id, environment_id, release_id, workflow_id),
  FOREIGN KEY (tenant_id, environment_id, release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  FOREIGN KEY (tenant_id, environment_id, body_digest)
    REFERENCES platform.workflow_body_blobs (tenant_id, environment_id, body_digest)
);

CREATE TABLE platform.workflow_verification_evidence (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  verification_evidence_id uuid NOT NULL,
  workflow_id text NOT NULL CHECK (workflow_id ~ '^[a-z][a-z0-9_.:-]{0,159}$'),
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
  result_bytes bytea NOT NULL CHECK (octet_length(result_bytes) BETWEEN 2 AND 1048576),
  PRIMARY KEY (tenant_id, environment_id, verification_evidence_id, workflow_id),
  FOREIGN KEY (tenant_id, environment_id, verification_evidence_id)
    REFERENCES platform.release_verification_evidence (tenant_id, environment_id, verification_evidence_id)
);

CREATE TABLE platform.workflow_activation_watermarks (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  pointer_id uuid NOT NULL,
  fence bigint NOT NULL CHECK (fence > 0),
  release_id uuid NOT NULL,
  release_root text NOT NULL CHECK (release_root ~ '^[0-9a-f]{64}$'),
  activation_attempt_id uuid NOT NULL,
  approver_id uuid NOT NULL,
  approver_grants jsonb NOT NULL CHECK (jsonb_typeof(approver_grants) = 'array'),
  PRIMARY KEY (tenant_id, environment_id, pointer_id, fence),
  UNIQUE (tenant_id, environment_id, pointer_id, fence, release_id, release_root),
  FOREIGN KEY (tenant_id, environment_id, activation_attempt_id)
    REFERENCES platform.release_activation_verification_receipts (tenant_id, environment_id, activation_attempt_id),
  FOREIGN KEY (tenant_id, environment_id, pointer_id)
    REFERENCES platform.active_release_pointers (tenant_id, environment_id, pointer_id),
  FOREIGN KEY (tenant_id, environment_id, release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id)
);

CREATE TABLE platform.workflow_event_occurrences (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  pointer_id uuid NOT NULL,
  fence bigint NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('PRE_ACTIVATION', 'INELIGIBLE', 'CLAIMED')),
  PRIMARY KEY (tenant_id, environment_id, outbox_id),
  FOREIGN KEY (tenant_id, environment_id, outbox_id)
    REFERENCES platform.trust_outbox (tenant_id, environment_id, outbox_id),
  FOREIGN KEY (tenant_id, environment_id, pointer_id, fence)
    REFERENCES platform.workflow_activation_watermarks (tenant_id, environment_id, pointer_id, fence)
);

CREATE TABLE platform.workflow_instances (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  event_id uuid NOT NULL,
  workflow_id text NOT NULL,
  legal_entity_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  trigger_principal_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, instance_id),
  UNIQUE (tenant_id, environment_id, event_id, workflow_id),
  UNIQUE (tenant_id, environment_id, instance_id, workflow_id),
  FOREIGN KEY (tenant_id, environment_id, outbox_id)
    REFERENCES platform.workflow_event_occurrences (tenant_id, environment_id, outbox_id),
  FOREIGN KEY (tenant_id, environment_id, event_id)
    REFERENCES platform.trust_domain_events (tenant_id, environment_id, domain_event_id)
);

CREATE TABLE platform.workflow_runs (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  run_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  workflow_id text NOT NULL,
  pointer_id uuid NOT NULL,
  release_id uuid NOT NULL,
  release_root text NOT NULL,
  initial_fence bigint NOT NULL,
  execution_fence bigint NOT NULL CHECK (execution_fence >= initial_fence),
  status text NOT NULL DEFAULT 'RUNNABLE'
    CHECK (status IN ('RUNNABLE', 'WAITING', 'SUSPENDED', 'QUARANTINED', 'COMPLETED', 'CANCELLED')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, run_id),
  UNIQUE (tenant_id, environment_id, instance_id),
  FOREIGN KEY (tenant_id, environment_id, instance_id, workflow_id)
    REFERENCES platform.workflow_instances (tenant_id, environment_id, instance_id, workflow_id),
  FOREIGN KEY (tenant_id, environment_id, release_id, workflow_id)
    REFERENCES platform.workflow_definitions (tenant_id, environment_id, release_id, workflow_id),
  FOREIGN KEY (tenant_id, environment_id, pointer_id, initial_fence, release_id, release_root)
    REFERENCES platform.workflow_activation_watermarks (tenant_id, environment_id, pointer_id, fence, release_id, release_root),
  FOREIGN KEY (tenant_id, environment_id, pointer_id, execution_fence, release_id, release_root)
    REFERENCES platform.workflow_activation_watermarks (tenant_id, environment_id, pointer_id, fence, release_id, release_root),
  CHECK ((status IN ('SUSPENDED', 'QUARANTINED', 'CANCELLED')) = (reason IS NOT NULL))
);

CREATE TABLE platform.workflow_journal (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  run_id uuid NOT NULL,
  journal_id uuid NOT NULL DEFAULT gen_random_uuid(),
  cursor integer NOT NULL CHECK (cursor BETWEEN 0 AND 64),
  kind text NOT NULL CHECK (kind IN ('REQUEST', 'RESULT', 'CONTROL')),
  canonical_bytes bytea NOT NULL CHECK (octet_length(canonical_bytes) BETWEEN 1 AND 16384),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, run_id, journal_id),
  FOREIGN KEY (tenant_id, environment_id, run_id)
    REFERENCES platform.workflow_runs (tenant_id, environment_id, run_id),
  CHECK (kind = 'CONTROL' OR cursor < 64)
);
CREATE UNIQUE INDEX workflow_journal_effect_once_idx
  ON platform.workflow_journal (tenant_id, environment_id, run_id, cursor, kind)
  WHERE kind IN ('REQUEST', 'RESULT');

CREATE TABLE platform.workflow_timers (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  run_id uuid NOT NULL,
  cursor integer NOT NULL CHECK (cursor BETWEEN 0 AND 63),
  due_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, run_id, cursor),
  FOREIGN KEY (tenant_id, environment_id, run_id)
    REFERENCES platform.workflow_runs (tenant_id, environment_id, run_id)
);

CREATE TABLE platform.workflow_event_waits (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  run_id uuid NOT NULL,
  cursor integer NOT NULL CHECK (cursor BETWEEN 0 AND 63),
  event_type text NOT NULL CHECK (event_type = 'northstar.inventory:event.receipt_posted'),
  correlation jsonb NOT NULL CHECK (jsonb_typeof(correlation) = 'object'),
  visible_baseline jsonb NOT NULL CHECK (jsonb_typeof(visible_baseline) = 'array'),
  PRIMARY KEY (tenant_id, environment_id, run_id, cursor),
  FOREIGN KEY (tenant_id, environment_id, run_id, cursor)
    REFERENCES platform.workflow_timers (tenant_id, environment_id, run_id, cursor)
);

CREATE TABLE platform.workflow_effect_outbox (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  run_id uuid NOT NULL,
  cursor integer NOT NULL CHECK (cursor BETWEEN 0 AND 63),
  request_journal_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, run_id, cursor),
  UNIQUE (tenant_id, environment_id, idempotency_key),
  FOREIGN KEY (tenant_id, environment_id, run_id, request_journal_id)
    REFERENCES platform.workflow_journal (tenant_id, environment_id, run_id, journal_id)
);

CREATE TABLE platform.workflow_pending_approvals (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  run_id uuid NOT NULL,
  cursor integer NOT NULL CHECK (cursor BETWEEN 0 AND 63),
  fence bigint NOT NULL CHECK (fence > 0),
  plan bytea NOT NULL CHECK (octet_length(plan) BETWEEN 2 AND 65536),
  plan_digest text NOT NULL CHECK (plan_digest = encode(sha256(plan), 'hex')),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'STALE')),
  decided_by uuid,
  decided_at timestamptz,
  PRIMARY KEY (tenant_id, environment_id, run_id, cursor, fence),
  FOREIGN KEY (tenant_id, environment_id, run_id)
    REFERENCES platform.workflow_runs (tenant_id, environment_id, run_id),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL)
    AND (status NOT IN ('APPROVED', 'DECLINED') OR decided_by IS NOT NULL)
    AND (status <> 'PENDING' OR decided_by IS NULL))
);

CREATE INDEX workflow_runs_runnable_idx
  ON platform.workflow_runs (tenant_id, environment_id, created_at, run_id)
  WHERE status = 'RUNNABLE';
CREATE INDEX workflow_timers_due_idx
  ON platform.workflow_timers (tenant_id, environment_id, due_at, run_id, cursor);
CREATE INDEX workflow_receipt_outbox_scan_idx
  ON platform.trust_outbox (tenant_id, environment_id, event_type, outbox_id);

DO $workflow_policies$
DECLARE
  table_name text;
  scoped text := $scope$
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  $scope$; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workflow_body_blobs', 'workflow_definitions', 'workflow_verification_evidence',
    'workflow_activation_watermarks', 'workflow_event_occurrences', 'workflow_instances',
    'workflow_runs', 'workflow_journal', 'workflow_timers', 'workflow_event_waits',
    'workflow_effect_outbox', 'workflow_pending_approvals'
  ] LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON platform.%I FROM PUBLIC', table_name);
    EXECUTE format(
      'CREATE POLICY workflow_scoped_worker ON platform.%I TO north_star_workflow_worker USING (%s) WITH CHECK (%s)',
      table_name, scoped, scoped
    ); END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'workflow_body_blobs', 'workflow_definitions', 'workflow_verification_evidence',
    'workflow_activation_watermarks', 'workflow_event_occurrences', 'workflow_instances',
    'workflow_journal', 'workflow_timers', 'workflow_event_waits', 'workflow_effect_outbox'
  ] LOOP
    EXECUTE format(
      'CREATE RULE %I AS ON UPDATE TO platform.%I DO INSTEAD INSERT INTO platform.immutable_release_write_guard VALUES (%L)',
      table_name || '_reject_update', table_name, table_name
    );
    EXECUTE format(
      'CREATE RULE %I AS ON DELETE TO platform.%I DO INSTEAD INSERT INTO platform.immutable_release_write_guard VALUES (%L)',
      table_name || '_reject_delete', table_name, table_name
    ); END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'trust_outbox', 'trust_domain_events', 'trust_business_change_documents'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY workflow_scoped_source ON platform.%I FOR SELECT TO north_star_workflow_worker USING (%s)',
      table_name, scoped
    ); END LOOP; END
$workflow_policies$;

GRANT SELECT ON platform.workflow_definitions, platform.workflow_activation_watermarks
  TO north_star_workflow_worker;
GRANT SELECT, INSERT ON platform.workflow_event_occurrences, platform.workflow_instances,
  platform.workflow_runs, platform.workflow_journal, platform.workflow_effect_outbox
  TO north_star_workflow_worker;
GRANT UPDATE (execution_fence, status, reason) ON platform.workflow_runs
  TO north_star_workflow_worker;
GRANT SELECT ON platform.trust_outbox, platform.trust_domain_events,
  platform.trust_business_change_documents TO north_star_workflow_worker;

CREATE FUNCTION platform.workflow_environment_ids()
RETURNS TABLE (tenant_id uuid, environment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e.tenant_id, e.id FROM platform.environments AS e ORDER BY e.tenant_id, e.id
$$;
REVOKE ALL ON FUNCTION platform.workflow_environment_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_environment_ids() TO north_star_workflow_worker;

-- The worker may serialize against the pointer but cannot change it.
CREATE FUNCTION platform.workflow_lock_pointer()
RETURNS TABLE (pointer_id uuid, fence bigint, release_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p.pointer_id, p.fence, p.release_id
    FROM platform.active_release_pointers AS p
   WHERE p.tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND p.environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
   FOR SHARE
$$;
REVOKE ALL ON FUNCTION platform.workflow_lock_pointer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_lock_pointer() TO north_star_workflow_worker;

CREATE FUNCTION platform.workflow_capture_watermark() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  previous_id uuid;
  subscribed_types text[]; BEGIN
  SELECT swap.previous_release_id INTO STRICT previous_id
    FROM platform.release_activation_swap_receipts AS swap
   WHERE swap.tenant_id = NEW.tenant_id AND swap.environment_id = NEW.environment_id
     AND swap.activation_attempt_id = NEW.activation_attempt_id
     AND swap.pointer_id = NEW.pointer_id AND swap.fence = NEW.fence
     AND swap.activated_release_id = NEW.activated_release_id;

  SELECT array_agg(DISTINCT d.event_type) INTO subscribed_types
    FROM platform.workflow_definitions AS d
   WHERE d.tenant_id = NEW.tenant_id AND d.environment_id = NEW.environment_id
     AND d.release_id IN (NEW.activated_release_id, previous_id);
  IF subscribed_types IS NULL THEN RETURN NEW; END IF;

  INSERT INTO platform.workflow_activation_watermarks (
    tenant_id, environment_id, pointer_id, fence, release_id, release_root,
    activation_attempt_id, approver_id, approver_grants
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
         ), '[]'::jsonb)
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
    FROM platform.trust_outbox AS o
   WHERE o.tenant_id = NEW.tenant_id AND o.environment_id = NEW.environment_id
     AND o.event_type = ANY(subscribed_types)
     AND NOT EXISTS (
       SELECT 1 FROM platform.workflow_event_occurrences AS e
        WHERE e.tenant_id = o.tenant_id AND e.environment_id = o.environment_id
          AND e.outbox_id = o.outbox_id
     );

  RETURN NEW; END
$$;
REVOKE ALL ON FUNCTION platform.workflow_capture_watermark() FROM PUBLIC;
CREATE TRIGGER workflow_verified_activation_watermark
  AFTER INSERT ON platform.release_activation_verification_receipts
  FOR EACH ROW WHEN (NEW.status = 'SWAPPED_VERIFIED')
  EXECUTE FUNCTION platform.workflow_capture_watermark();
