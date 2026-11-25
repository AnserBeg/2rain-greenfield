-- A group is sealed by the successful writer's own outbox insert. Including
-- the top-level transaction ID in the FK prevents reuse of an older event.
CREATE TABLE platform.record_creation_batches (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, writer_xid xid8 NOT NULL,
  request_id uuid NOT NULL, action_id text NOT NULL, outbox_id uuid NOT NULL,
  domain_event_id uuid NOT NULL, record_count bigint NOT NULL CHECK (record_count > 0),
  PRIMARY KEY (tenant_id, environment_id, writer_xid, request_id, action_id),
  UNIQUE (tenant_id, environment_id, outbox_id),
  FOREIGN KEY (tenant_id, environment_id, outbox_id)
    REFERENCES platform.trust_outbox (tenant_id, environment_id, outbox_id),
  FOREIGN KEY (tenant_id, environment_id, domain_event_id)
    REFERENCES platform.trust_domain_events (tenant_id, environment_id, domain_event_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE platform.record_creation_occurrences (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, writer_xid xid8 NOT NULL,
  request_id uuid NOT NULL, action_id text NOT NULL,
  occurrence_id uuid NOT NULL DEFAULT gen_random_uuid(), record_type text NOT NULL,
  record_id uuid NOT NULL, company_id uuid NOT NULL, resolved boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, environment_id, occurrence_id),
  UNIQUE (tenant_id, environment_id, writer_xid, request_id, action_id, record_type, company_id, record_id),
  FOREIGN KEY (tenant_id, environment_id, writer_xid, request_id, action_id)
    REFERENCES platform.record_creation_batches DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE platform.record_creation_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.record_creation_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.record_creation_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.record_creation_occurrences FORCE ROW LEVEL SECURITY;

-- The governed writer names each company-owned record it inserted. The company
-- is read from the stored row, never from the caller, and a claimed record that
-- is not stored in the caller's tenant and environment refuses the write. No
-- managed table carries a trigger, so the managed catalog of a release without a
-- recordCreated workflow is unchanged and an older binary still verifies it.
CREATE FUNCTION north_star_internal.record_creations(
  physical_table text, identity_column text, record_type text, company uuid, record_ids uuid[]
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  action text := nullif(current_setting('north_star.creation_action', true), '');
  recorded integer; BEGIN
  -- A creation outside a governed write, or after its command was sealed,
  -- would never reach a subscriber: refuse it by name instead of recording 0.
  IF action IS NULL THEN
    RAISE EXCEPTION 'record creation outside a governed write' USING ERRCODE = 'P0001'; END IF;
  IF action = 'sealed' THEN
    RAISE EXCEPTION 'record creation after its command was sealed' USING ERRCODE = 'P0001'; END IF;
  IF record_type !~ '^[a-z][a-z0-9_.:-]{0,190}$' THEN
    RAISE EXCEPTION 'record creation type is not a canonical ID'; END IF;
  IF company IS NULL OR cardinality(record_ids) IS NULL THEN
    RAISE EXCEPTION 'record creation names no company or record'; END IF;
  -- Company-owned tables key on (tenant, environment, company, record): the
  -- same record ID may exist in another company and is not this creation.
  EXECUTE format(
    'INSERT INTO platform.record_creation_occurrences
       (tenant_id, environment_id, writer_xid, request_id, action_id, record_type, record_id, company_id)
     SELECT r.tenant_id, r.environment_id, pg_current_xact_id(),
            nullif(current_setting(''north_star.request_id'', true), '''')::uuid,
            $1, $2, r.%1$I, r.legal_entity_id
       FROM north_star_module.%2$I AS r
      WHERE r.tenant_id = north_star_internal.trusted_tenant_id()
        AND r.environment_id = north_star_internal.trusted_environment_id()
        AND r.legal_entity_id = $3
        AND r.%1$I = ANY($4)', identity_column, physical_table)
    USING action, record_type, company, record_ids;
  GET DIAGNOSTICS recorded = ROW_COUNT;
  IF recorded <> cardinality(record_ids) THEN
    RAISE EXCEPTION 'a claimed record creation is not stored in this scope'; END IF;
  RETURN recorded; END $$;
REVOKE ALL ON FUNCTION north_star_internal.record_creations(text, text, text, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION north_star_internal.record_creations(text, text, text, uuid, uuid[])
  TO north_star_runtime, north_star_module_runtime;

CREATE FUNCTION north_star_internal.seal_record_creations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NEW.action_id IS DISTINCT FROM nullif(current_setting('north_star.creation_action', true), '')
  THEN RETURN NULL; END IF;
  INSERT INTO platform.record_creation_batches
    (tenant_id, environment_id, writer_xid, request_id, action_id, outbox_id, domain_event_id, record_count)
  SELECT NEW.tenant_id, NEW.environment_id, pg_current_xact_id(), NEW.request_id, NEW.action_id,
         NEW.outbox_id, NEW.domain_event_id, count(*)
    FROM platform.record_creation_occurrences
   WHERE (tenant_id, environment_id, writer_xid, request_id, action_id) =
         (NEW.tenant_id, NEW.environment_id, pg_current_xact_id(), NEW.request_id, NEW.action_id)
  HAVING count(*) > 0;
  PERFORM set_config('north_star.creation_action', 'sealed', true);
  RETURN NULL; END $$;
REVOKE ALL ON FUNCTION north_star_internal.seal_record_creations() FROM PUBLIC;
CREATE TRIGGER seal_record_creations AFTER INSERT ON platform.trust_outbox
  FOR EACH ROW EXECUTE FUNCTION north_star_internal.seal_record_creations();

-- ADR-0073 A1: recordCreated is the first general trigger member. Its source
-- is the per-record occurrence above, never worker state.
CREATE INDEX record_creation_occurrences_pending_idx
  ON platform.record_creation_occurrences (tenant_id, environment_id, record_type, occurrence_id)
  WHERE NOT resolved;
REVOKE ALL ON platform.record_creation_occurrences, platform.record_creation_batches FROM PUBLIC;

ALTER TABLE platform.workflow_definitions ADD COLUMN record_type text
  CHECK (record_type ~ '^[a-z][a-z0-9_.:-]{0,190}$');
ALTER TABLE platform.workflow_definitions ADD CONSTRAINT workflow_definitions_record_trigger_shape
  CHECK ((event_type = 'northstar.runtime:event.record-created') = (record_type IS NOT NULL));

-- A receipt definition hashes exactly the bytes it hashed before this member.
CREATE OR REPLACE FUNCTION platform.workflow_definition_digest(definition platform.workflow_definitions)
RETURNS text LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT encode(sha256(convert_to((jsonb_build_array(
    definition.tenant_id, definition.environment_id, definition.release_id, definition.workflow_id,
    definition.event_type, definition.body_digest, definition.executable_digest, definition.sdk_digest,
    definition.engine_build, definition.host_version, definition.sdk_version,
    definition.automation_principal_id, definition.authored_by, definition.grants
  ) || CASE WHEN definition.record_type IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(definition.record_type) END)::text, 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION platform.workflow_bind_release_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ BEGIN
  SELECT jsonb_object_agg(d.workflow_id, jsonb_build_object(
           'digest', e.binding_digest, 'eventType', d.event_type,
           'unattendedOperations', e.unattended_operations
         ) || CASE WHEN d.record_type IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('recordType', d.record_type) END)
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

-- One disposition per occurrence, as the receipt source has one per outbox row.
CREATE TABLE platform.workflow_record_dispositions (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  pointer_id uuid NOT NULL,
  fence bigint NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('CLAIMED', 'INELIGIBLE', 'PRE_ACTIVATION')),
  PRIMARY KEY (tenant_id, environment_id, occurrence_id),
  FOREIGN KEY (tenant_id, environment_id, occurrence_id)
    REFERENCES platform.record_creation_occurrences (tenant_id, environment_id, occurrence_id),
  FOREIGN KEY (tenant_id, environment_id, pointer_id, fence)
    REFERENCES platform.workflow_activation_watermarks (tenant_id, environment_id, pointer_id, fence)
);
-- ADR-0073 A1 loops: a run's own write, or a chain deeper than three, starts nothing.
CREATE TABLE platform.workflow_record_start_skips (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  workflow_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('self-caused', 'depth-exceeded')),
  PRIMARY KEY (tenant_id, environment_id, occurrence_id, workflow_id),
  FOREIGN KEY (tenant_id, environment_id, occurrence_id)
    REFERENCES platform.workflow_record_dispositions (tenant_id, environment_id, occurrence_id)
);

CREATE FUNCTION north_star_internal.workflow_resolve_record_occurrence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ BEGIN
  UPDATE platform.record_creation_occurrences SET resolved = true
   WHERE (tenant_id, environment_id, occurrence_id) = (NEW.tenant_id, NEW.environment_id, NEW.occurrence_id);
  RETURN NEW; END
$$;
REVOKE ALL ON FUNCTION north_star_internal.workflow_resolve_record_occurrence() FROM PUBLIC;
CREATE TRIGGER workflow_resolve_record_occurrence AFTER INSERT ON platform.workflow_record_dispositions
  FOR EACH ROW EXECUTE FUNCTION north_star_internal.workflow_resolve_record_occurrence();

DO $$
DECLARE
  table_name text;
  scoped text := $scope$
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  $scope$; BEGIN
  FOREACH table_name IN ARRAY ARRAY['workflow_record_dispositions', 'workflow_record_start_skips'] LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON platform.%I FROM PUBLIC', table_name);
    EXECUTE format(
      'CREATE POLICY workflow_scoped_worker ON platform.%I TO north_star_workflow_worker USING (%s) WITH CHECK (%s)',
      table_name, scoped, scoped);
    EXECUTE format('GRANT SELECT, INSERT ON platform.%I TO north_star_workflow_worker', table_name);
    EXECUTE format(
      'CREATE RULE %I AS ON UPDATE TO platform.%I DO INSTEAD INSERT INTO platform.immutable_release_write_guard VALUES (%L)',
      table_name || '_reject_update', table_name, table_name);
    EXECUTE format(
      'CREATE RULE %I AS ON DELETE TO platform.%I DO INSTEAD INSERT INTO platform.immutable_release_write_guard VALUES (%L)',
      table_name || '_reject_delete', table_name, table_name); END LOOP; END $$;

-- An instance names its source: a receipt outbox row, or one creation occurrence.
-- The start key for a creation is the occurrence, so N records created by one
-- command start N runs. Pre-tenant (ADR-0066): no stored instance needs a backfill.
ALTER TABLE platform.workflow_instances
  DROP CONSTRAINT workflow_instances_tenant_id_environment_id_event_id_workfl_key,
  ALTER COLUMN outbox_id DROP NOT NULL,
  ALTER COLUMN receipt_id DROP NOT NULL,
  ADD COLUMN trigger_record_id uuid,
  ADD COLUMN record_type text,
  ADD COLUMN creation_occurrence_id uuid,
  ADD COLUMN causation_depth integer NOT NULL DEFAULT 0 CHECK (causation_depth BETWEEN 0 AND 3),
  ADD FOREIGN KEY (tenant_id, environment_id, creation_occurrence_id)
    REFERENCES platform.workflow_record_dispositions (tenant_id, environment_id, occurrence_id),
  ADD CONSTRAINT workflow_instances_trigger_source CHECK (
    trigger_record_id IS NOT NULL AND (
      (outbox_id IS NOT NULL AND receipt_id = trigger_record_id AND record_type IS NULL
        AND creation_occurrence_id IS NULL AND causation_depth = 0)
      OR (outbox_id IS NULL AND receipt_id IS NULL AND record_type IS NOT NULL
        AND creation_occurrence_id IS NOT NULL)));
-- A worker that predates this slice inserts a receipt instance without the
-- generic column; the receipt is its trigger record.
CREATE FUNCTION north_star_internal.workflow_default_trigger_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NEW.trigger_record_id IS NULL AND NEW.creation_occurrence_id IS NULL THEN
    NEW.trigger_record_id := NEW.receipt_id; END IF;
  RETURN NEW; END $$;
REVOKE ALL ON FUNCTION north_star_internal.workflow_default_trigger_record() FROM PUBLIC;
CREATE TRIGGER workflow_default_trigger_record BEFORE INSERT ON platform.workflow_instances
  FOR EACH ROW EXECUTE FUNCTION north_star_internal.workflow_default_trigger_record();
CREATE UNIQUE INDEX workflow_instances_event_start_key
  ON platform.workflow_instances (tenant_id, environment_id, event_id, workflow_id)
  WHERE creation_occurrence_id IS NULL;
CREATE UNIQUE INDEX workflow_instances_occurrence_start_key
  ON platform.workflow_instances (tenant_id, environment_id, creation_occurrence_id, workflow_id)
  WHERE creation_occurrence_id IS NOT NULL;

-- The worker cannot read the trust rows of an unsubscribed event type. These
-- definer functions return only the verified chain for subscribed record types.
CREATE FUNCTION platform.workflow_record_creation_page(page_size integer)
RETURNS TABLE (
  occurrence_id uuid, record_type text, record_id uuid, company_id uuid,
  event_id uuid, release_id uuid, release_content_hash text, trigger_principal_id uuid,
  cause_workflow_id text, cause_depth integer
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  WITH scope AS (
    SELECT nullif(current_setting('north_star.tenant_id', true), '')::uuid AS t,
           nullif(current_setting('north_star.environment_id', true), '')::uuid AS e
  ), subscribed AS (
    SELECT DISTINCT binding.value->>'recordType' AS record_type
      FROM scope
      JOIN platform.active_release_pointers AS p ON (p.tenant_id, p.environment_id) = (scope.t, scope.e)
      JOIN platform.workflow_activation_watermarks AS w
        ON (w.tenant_id, w.environment_id, w.pointer_id, w.fence, w.release_id) =
           (p.tenant_id, p.environment_id, p.pointer_id, p.fence, p.release_id)
      CROSS JOIN LATERAL jsonb_each(w.definition_bindings) AS binding(id, value)
     WHERE w.verified_approval_binding AND binding.value ? 'recordType'
  ), page AS MATERIALIZED (
    SELECT c.* FROM scope
      JOIN platform.record_creation_occurrences AS c ON (c.tenant_id, c.environment_id) = (scope.t, scope.e)
     WHERE NOT c.resolved AND c.record_type IN (SELECT s.record_type FROM subscribed AS s)
     ORDER BY c.occurrence_id
     LIMIT least(greatest(page_size, 1), 256)
  )
  SELECT page.occurrence_id, page.record_type, page.record_id, page.company_id,
         event.domain_event_id, event.release_id, event.release_content_hash,
         change.execution_principal_id, cause.workflow_id, cause.causation_depth
    FROM page
    LEFT JOIN platform.record_creation_batches AS b
      ON (b.tenant_id, b.environment_id, b.writer_xid, b.request_id, b.action_id) =
         (page.tenant_id, page.environment_id, page.writer_xid, page.request_id, page.action_id)
    LEFT JOIN platform.trust_outbox AS o
      ON (o.tenant_id, o.environment_id, o.outbox_id, o.domain_event_id, o.action_id) =
         (b.tenant_id, b.environment_id, b.outbox_id, b.domain_event_id, b.action_id)
    LEFT JOIN platform.trust_domain_events AS event
      ON (event.tenant_id, event.environment_id, event.domain_event_id, event.outbox_id, event.invocation_id,
          event.change_document_id, event.release_id, event.release_content_hash, event.action_id) =
         (o.tenant_id, o.environment_id, o.domain_event_id, o.outbox_id, o.invocation_id,
          o.change_document_id, o.release_id, o.release_content_hash, o.action_id)
    LEFT JOIN platform.trust_action_invocations AS invocation
      ON (invocation.tenant_id, invocation.environment_id, invocation.invocation_id, invocation.action_id) =
         (event.tenant_id, event.environment_id, event.invocation_id, event.action_id)
     AND invocation.outcome = 'SUCCEEDED'
    LEFT JOIN platform.trust_business_change_documents AS change
      ON (change.tenant_id, change.environment_id, change.change_document_id, change.invocation_id,
          change.domain_event_id, change.outbox_id, change.action_id) =
         (invocation.tenant_id, invocation.environment_id, event.change_document_id, invocation.invocation_id,
          event.domain_event_id, event.outbox_id, event.action_id)
    LEFT JOIN platform.workflow_runs AS cause_run
      ON (cause_run.tenant_id, cause_run.environment_id, cause_run.run_id) =
         (invocation.tenant_id, invocation.environment_id, invocation.causation_id)
    LEFT JOIN platform.workflow_instances AS cause
      ON (cause.tenant_id, cause.environment_id, cause.instance_id, cause.workflow_id) =
         (cause_run.tenant_id, cause_run.environment_id, cause_run.instance_id, cause_run.workflow_id)
   ORDER BY page.occurrence_id
$$;
REVOKE ALL ON FUNCTION platform.workflow_record_creation_page(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_record_creation_page(integer) TO north_star_workflow_worker;

-- A run re-derives its trigger scope from the source rows, never from its instance.
CREATE FUNCTION platform.workflow_record_trigger_scope(instance uuid)
RETURNS TABLE (
  legal_entity_id uuid, trigger_record_id uuid, record_type text, event_id uuid,
  trigger_principal_id uuid, release_id uuid, release_content_hash text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.company_id, c.record_id, c.record_type, event.domain_event_id,
         change.execution_principal_id, event.release_id, event.release_content_hash
    FROM platform.workflow_instances AS i
    JOIN platform.record_creation_occurrences AS c
      ON (c.tenant_id, c.environment_id, c.occurrence_id, c.record_type, c.record_id, c.company_id) =
         (i.tenant_id, i.environment_id, i.creation_occurrence_id, i.record_type, i.trigger_record_id, i.legal_entity_id)
    JOIN platform.record_creation_batches AS b
      ON (b.tenant_id, b.environment_id, b.writer_xid, b.request_id, b.action_id, b.domain_event_id) =
         (c.tenant_id, c.environment_id, c.writer_xid, c.request_id, c.action_id, i.event_id)
    JOIN platform.trust_domain_events AS event
      ON (event.tenant_id, event.environment_id, event.domain_event_id, event.outbox_id, event.action_id) =
         (b.tenant_id, b.environment_id, b.domain_event_id, b.outbox_id, b.action_id)
    JOIN platform.trust_action_invocations AS invocation
      ON (invocation.tenant_id, invocation.environment_id, invocation.invocation_id, invocation.action_id) =
         (event.tenant_id, event.environment_id, event.invocation_id, event.action_id)
     AND invocation.outcome = 'SUCCEEDED'
    JOIN platform.trust_business_change_documents AS change
      ON (change.tenant_id, change.environment_id, change.change_document_id, change.invocation_id,
          change.domain_event_id, change.outbox_id) =
         (event.tenant_id, event.environment_id, event.change_document_id, event.invocation_id,
          event.domain_event_id, event.outbox_id)
   WHERE i.tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND i.environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND i.instance_id = instance
$$;
REVOKE ALL ON FUNCTION platform.workflow_record_trigger_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_record_trigger_scope(uuid) TO north_star_workflow_worker;

-- The activation boundary now also covers creations of every record type the
-- incoming or outgoing release subscribes to. With no record subscription the
-- added statement inserts nothing, so a receipt-only activation is unchanged.
CREATE OR REPLACE FUNCTION platform.workflow_capture_watermark() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  incoming jsonb;
  outgoing jsonb;
  subscribed_types text[];
  subscribed_records text[]; BEGIN
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

  SELECT array_agg(DISTINCT subscription.value->>'eventType'),
         array_agg(DISTINCT subscription.value->>'recordType')
           FILTER (WHERE subscription.value ? 'recordType')
    INTO subscribed_types, subscribed_records
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

  INSERT INTO platform.workflow_record_dispositions (tenant_id, environment_id, occurrence_id, pointer_id, fence, disposition)
  SELECT c.tenant_id, c.environment_id, c.occurrence_id, NEW.pointer_id, NEW.fence, 'PRE_ACTIVATION'
    FROM platform.record_creation_occurrences AS c
   WHERE c.tenant_id = NEW.tenant_id AND c.environment_id = NEW.environment_id
     AND c.record_type = ANY(COALESCE(subscribed_records, '{}'::text[])) AND NOT c.resolved;

  RETURN NEW; END
$$;

-- ADR-0073 A1: approval and staff Retry read the company from the run's own
-- trigger source, so a recordCreated run can ask for approval and be retried.
-- A receipt instance reads exactly the chain it read before.
CREATE OR REPLACE FUNCTION platform.workflow_approval_worklist(requested_run uuid DEFAULT NULL)
RETURNS TABLE (run_id uuid, cursor integer, fence bigint, plan bytea, plan_digest text, company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.run_id, a.cursor, a.fence, a.plan, a.plan_digest, target_scope.company_id
    FROM platform.workflow_pending_approvals AS a
    JOIN platform.workflow_runs AS r USING (tenant_id, environment_id, run_id)
    JOIN platform.workflow_definitions AS d USING (tenant_id, environment_id, release_id, workflow_id)
    JOIN platform.workflow_instances AS i USING (tenant_id, environment_id, instance_id, workflow_id)
    JOIN platform.active_release_pointers AS p
      ON (p.tenant_id, p.environment_id, p.pointer_id, p.fence, p.release_id) =
         (r.tenant_id, r.environment_id, r.pointer_id, r.execution_fence, r.release_id)
    JOIN platform.workflow_activation_watermarks AS w
      ON (w.tenant_id, w.environment_id, w.pointer_id, w.fence, w.release_id, w.release_root) =
         (r.tenant_id, r.environment_id, r.pointer_id, r.execution_fence, r.release_id, r.release_root)
    JOIN platform.workflow_activation_watermarks AS initial
      ON (initial.tenant_id, initial.environment_id, initial.pointer_id, initial.fence, initial.release_id, initial.release_root) =
         (r.tenant_id, r.environment_id, r.pointer_id, r.initial_fence, r.release_id, r.release_root)
    JOIN platform.workflow_journal AS j
      ON (j.tenant_id, j.environment_id, j.run_id, j.cursor) =
         (a.tenant_id, a.environment_id, a.run_id, a.cursor)
    -- The trigger source names the company: the receipt event chain, or, for a
    -- creation instance, the verified occurrence chain (ADR-0073 A1).
    JOIN LATERAL (
      SELECT event.payload #>> '{legalEntityId,value}' AS company
        FROM platform.trust_domain_events AS event
        JOIN platform.trust_outbox AS source
          ON (source.tenant_id, source.environment_id, source.outbox_id, source.domain_event_id) =
             (event.tenant_id, event.environment_id, event.outbox_id, event.domain_event_id)
         AND (source.invocation_id, source.change_document_id, source.action_id) =
             (event.invocation_id, event.change_document_id, event.action_id)
         AND (source.release_id, source.release_content_hash, source.event_type, source.event_schema_version) =
             (event.release_id, event.release_content_hash, event.event_type, event.event_schema_version)
        JOIN platform.trust_action_invocations AS invocation
          ON (invocation.tenant_id, invocation.environment_id, invocation.invocation_id, invocation.action_id) =
             (event.tenant_id, event.environment_id, event.invocation_id, event.action_id)
         AND (invocation.release_id, invocation.release_content_hash) = (event.release_id, event.release_content_hash)
         AND invocation.outcome = 'SUCCEEDED'
         AND invocation.policy_inputs #>> '{legalEntityId,representation}' = 'VALUE'
         AND invocation.policy_inputs #>> '{legalEntityId,value}' = event.payload #>> '{legalEntityId,value}'
        JOIN platform.trust_business_change_documents AS change
          ON (change.tenant_id, change.environment_id, change.change_document_id) =
             (event.tenant_id, event.environment_id, event.change_document_id)
         AND (change.invocation_id, change.outbox_id, change.domain_event_id) =
             (event.invocation_id, event.outbox_id, event.domain_event_id)
         AND (change.release_id, change.release_content_hash, change.action_id) =
             (event.release_id, event.release_content_hash, event.action_id)
       WHERE i.creation_occurrence_id IS NULL
         AND (event.tenant_id, event.environment_id, event.domain_event_id, event.outbox_id) =
             (r.tenant_id, r.environment_id, i.event_id, i.outbox_id)
         AND (event.release_id, event.release_content_hash) = (r.release_id, r.release_root)
         AND event.event_type = d.event_type
         AND event.payload #>> '{legalEntityId,representation}' = 'VALUE'
      UNION ALL
      SELECT created.legal_entity_id::text
        FROM platform.workflow_record_trigger_scope(i.instance_id) AS created
       WHERE i.creation_occurrence_id IS NOT NULL
         AND (created.release_id, created.release_content_hash, created.record_type) =
             (r.release_id, r.release_root, d.record_type)
    ) AS source_scope ON true
    JOIN platform.tenant_releases AS release
      ON (release.tenant_id, release.environment_id, release.release_id, release.content_hash) =
         (r.tenant_id, r.environment_id, r.release_id, r.release_root)
    JOIN platform.app_package_revisions AS revision
      ON (revision.tenant_id, revision.revision_id) = (release.tenant_id, release.app_package_revision_id)
    JOIN platform.tenant_release_projection_links AS projection
      ON (projection.tenant_id, projection.environment_id, projection.release_id) =
         (r.tenant_id, r.environment_id, r.release_id)
     AND projection.projection_family_id = 'northstar.compiler:projection-family.operation-catalog'
    JOIN platform.tenant_release_chunk_links AS chunk
      ON (chunk.tenant_id, chunk.environment_id, chunk.release_id, chunk.projection_instance_id) =
         (projection.tenant_id, projection.environment_id, projection.release_id, projection.projection_instance_id)
    JOIN platform.release_artifact_blobs AS catalog
      ON catalog.content_hash = chunk.chunk_hash AND catalog.artifact_kind = 'projectionChunk'
    JOIN platform.tenant_release_projection_links AS storage_projection
      ON (storage_projection.tenant_id, storage_projection.environment_id, storage_projection.release_id) =
         (r.tenant_id, r.environment_id, r.release_id)
     AND storage_projection.projection_family_id = 'northstar.compiler:projection-family.storage-target'
    JOIN platform.tenant_release_chunk_links AS storage_chunk
      ON (storage_chunk.tenant_id, storage_chunk.environment_id, storage_chunk.release_id, storage_chunk.projection_instance_id) =
         (storage_projection.tenant_id, storage_projection.environment_id, storage_projection.release_id, storage_projection.projection_instance_id)
    JOIN platform.release_artifact_blobs AS storage
      ON storage.content_hash = storage_chunk.chunk_hash AND storage.artifact_kind = 'projectionChunk'
    CROSS JOIN LATERAL (SELECT
      nullif(current_setting('north_star.principal_id', true), '')::uuid AS principal,
      convert_from(j.canonical_bytes, 'UTF8')::jsonb AS request,
      source_scope.company AS company
    ) AS binding
    JOIN LATERAL jsonb_array_elements(convert_from(catalog.canonical_bytes, 'UTF8')::jsonb->'operations') AS operation(value)
      ON operation.value->>'lifecycle' = 'active'
     AND operation.value->>'tier' = 'o0'
     AND operation.value->>'operationId' = binding.request->>'operationId'
    JOIN LATERAL jsonb_array_elements(convert_from(storage.canonical_bytes, 'UTF8')::jsonb->'entities') AS target(value)
      ON target.value->>'entityId' = operation.value #>> '{effect,entity,targetId}'
    CROSS JOIN LATERAL platform.workflow_approval_target_scope(
      a.tenant_id, a.environment_id, target.value, operation.value #>> '{effect,kind}', binding.request->'input'
    ) AS target_scope
    CROSS JOIN LATERAL jsonb_array_elements(convert_from(revision.desired_state, 'UTF8')::jsonb->'permissions') AS permission(value)
   WHERE a.tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND a.environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND (requested_run IS NULL OR a.run_id = requested_run)
     AND a.status = 'PENDING' AND r.status = 'WAITING' AND a.fence = r.execution_fence
     AND binding.principal IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM platform.workflow_definitions AS automation
        WHERE automation.tenant_id = a.tenant_id AND automation.automation_principal_id = binding.principal
     )
     AND COALESCE((
       SELECT eligible FROM platform.release_approver_eligibility_events AS eligibility
        WHERE eligibility.tenant_id = a.tenant_id AND eligibility.principal_id = binding.principal
        ORDER BY eligibility.policy_version DESC LIMIT 1
     ), false)
     AND w.verified_approval_binding AND initial.verified_approval_binding
     AND w.definition_bindings->d.workflow_id->>'digest' = platform.workflow_definition_digest(d)
     AND initial.definition_bindings->d.workflow_id->>'digest' = w.definition_bindings->d.workflow_id->>'digest'
     AND j.kind = 'REQUEST' AND binding.request->>'kind' = 'requestApproval'
     AND jsonb_typeof(binding.request->'input') = 'object'
     AND binding.company IS NOT NULL
     AND (NOT (binding.request->'input' ? 'legalEntityId')
       OR binding.request #>> '{input,legalEntityId}' = binding.company)
     AND convert_from(a.plan, 'UTF8')::jsonb = jsonb_build_object(
       'companyId', binding.company, 'cursor', a.cursor, 'fence', a.fence::text,
       'pointerId', r.pointer_id, 'releaseId', r.release_id, 'releaseRoot', r.release_root,
       'request', binding.request, 'runId', r.run_id
     )
     AND d.grants->'operations' ? (binding.request->>'operationId')
     AND permission.value->>'permissionId' = operation.value->>'permissionId'
     AND permission.value->>'lifecycle' = 'active'
     AND EXISTS (
       SELECT 1 FROM platform.current_policy_memberships AS membership
       JOIN platform.current_policy_roles AS role USING (tenant_id, environment_id, role_id)
       JOIN platform.current_policy_permission_grants AS grant_row USING (tenant_id, environment_id, role_id)
        WHERE (membership.tenant_id, membership.environment_id, membership.principal_id) =
              (a.tenant_id, a.environment_id, binding.principal)
          AND membership.revoked_at IS NULL AND role.revoked_at IS NULL AND grant_row.revoked_at IS NULL
          AND grant_row.permission_id = 'northstar.runtime:permission.semantic-operation-boundary'
          AND grant_row.resource_id = 'northstar.runtime:gateway.semantic-operation'
     )
     AND EXISTS (
       SELECT 1 FROM platform.current_policy_memberships AS membership
       JOIN platform.current_policy_roles AS role USING (tenant_id, environment_id, role_id)
       JOIN platform.current_policy_permission_grants AS grant_row USING (tenant_id, environment_id, role_id)
        WHERE (membership.tenant_id, membership.environment_id, membership.principal_id) =
              (a.tenant_id, a.environment_id, binding.principal)
          AND membership.revoked_at IS NULL AND role.revoked_at IS NULL AND grant_row.revoked_at IS NULL
          AND (membership.legal_entity_id IS NULL OR membership.legal_entity_id = target_scope.company_id)
          AND grant_row.permission_id = operation.value->>'permissionId'
          AND grant_row.resource_id = permission.value #>> '{resource,targetId}'
          AND NOT COALESCE(operation.value->'excludedRoleKeys' ? role.role_key, false)
     )
   ORDER BY r.created_at, a.run_id, a.cursor
   LIMIT 100
$$;
CREATE OR REPLACE FUNCTION north_star_internal.staff_retry_terms(t uuid,e uuid,target uuid,company uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('run',r.run_id,'instance',i.instance_id,'occurrence',i.event_id,'workflow',r.workflow_id,
    'release',r.release_id,'root',r.release_root,'pointer',p.pointer_id,'originalFence',r.initial_fence::text,
    'previousFence',r.execution_fence::text,'fence',p.fence::text,'company',i.legal_entity_id,
    'body',d.body_digest,'executable',d.executable_digest,'sdk',d.sdk_digest,'sdkVersion',d.sdk_version,'host',d.host_version,'engine',d.engine_build,
    'definition',platform.workflow_definition_digest(d),'journal',(
      SELECT coalesce(jsonb_agg(jsonb_build_array(j.cursor,j.kind,j.journal_id,encode(sha256(j.canonical_bytes),'hex'))
        ORDER BY j.cursor,j.kind,j.journal_id),'[]'::jsonb) FROM platform.workflow_journal j
      WHERE (j.tenant_id,j.environment_id,j.run_id)=(r.tenant_id,r.environment_id,r.run_id)))
  FROM platform.workflow_runs r JOIN platform.workflow_instances i USING (tenant_id,environment_id,instance_id,workflow_id)
  JOIN platform.workflow_definitions d USING (tenant_id,environment_id,workflow_id,release_id)
  JOIN platform.active_release_pointers p USING (tenant_id,environment_id,release_id,pointer_id)
  JOIN platform.workflow_activation_watermarks w USING (tenant_id,environment_id,release_id,pointer_id,release_root)
  JOIN platform.workflow_activation_watermarks old ON (old.tenant_id,old.environment_id,old.pointer_id,old.fence,old.release_id,old.release_root)
    =(r.tenant_id,r.environment_id,r.pointer_id,r.initial_fence,r.release_id,r.release_root)
  JOIN LATERAL (
    SELECT event.payload #>> '{legalEntityId,value}' AS source_company
      FROM platform.trust_domain_events event
      JOIN platform.trust_action_invocations invocation ON (invocation.tenant_id,invocation.environment_id,invocation.invocation_id,invocation.action_id,
        invocation.release_id,invocation.release_content_hash)=(event.tenant_id,event.environment_id,event.invocation_id,event.action_id,r.release_id,r.release_root)
        AND invocation.outcome='SUCCEEDED'
     WHERE i.creation_occurrence_id IS NULL
       AND (event.tenant_id,event.environment_id,event.domain_event_id,event.outbox_id,
        event.release_id,event.release_content_hash,event.event_type)=(r.tenant_id,r.environment_id,i.event_id,i.outbox_id,r.release_id,r.release_root,d.event_type)
       AND invocation.policy_inputs #>> '{legalEntityId,representation}'='VALUE'
       AND invocation.policy_inputs #>> '{legalEntityId,value}'=event.payload #>> '{legalEntityId,value}'
    UNION ALL
    SELECT created.legal_entity_id::text FROM platform.workflow_record_trigger_scope(i.instance_id) created
     WHERE i.creation_occurrence_id IS NOT NULL
       AND (created.release_id,created.release_content_hash,created.record_type)=(r.release_id,r.release_root,d.record_type)
  ) source_scope ON true
  WHERE r.tenant_id=t AND r.environment_id=e AND r.run_id=target AND i.legal_entity_id=company
    AND source_scope.source_company=company::text
    AND r.status='SUSPENDED' AND r.reason='stale-release-pin' AND p.fence>r.execution_fence
    AND w.fence=p.fence AND old.verified_approval_binding AND w.verified_approval_binding
    AND w.definition_bindings->r.workflow_id->>'digest'=platform.workflow_definition_digest(d)
    AND old.definition_bindings->r.workflow_id=w.definition_bindings->r.workflow_id
$$;
