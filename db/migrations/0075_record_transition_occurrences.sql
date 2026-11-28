-- WORKFLOW-3 slice 1 (ADR-0073 A1 recordTransitioned; owner O1, 2026-11-27).
--
-- A record occurrence is now a committed fact about a record of one of two
-- kinds: its creation, or one move of its declared state machine. The generic
-- transition writer names each move it makes, as the create writer names each
-- creation, under the same governed-write marker and the same seal. Every
-- consumer of 0070's occurrence (the page, the dispositions, the activation
-- capture, the start key, the trigger scope, approval and staff Retry) is
-- reused; the trigger scope now also matches the occurrence's kind and states
-- with the run's own definition (B7), in one place.
--
-- A recordCreated definition hashes and binds exactly the bytes it did before
-- (B4): the state columns are appended only when present.
--
-- B1: one occurrence per (command, kind, record). A generic command runs one
-- operation, one effect, on one record (module-runtime-interpreter.ts
-- executeMutationOnClient), so a create and a transition of one record are
-- distinct kinds, and two transitions of one record in one command cannot
-- arise. A writer that tried would be refused by this key, never collapsed.

ALTER TABLE platform.record_creation_occurrences
  ADD COLUMN kind text NOT NULL DEFAULT 'created' CHECK (kind IN ('created', 'transitioned')),
  ADD COLUMN from_state text CHECK (from_state ~ '^[a-z][a-z0-9_.:-]{0,190}$'),
  ADD COLUMN to_state text CHECK (to_state ~ '^[a-z][a-z0-9_.:-]{0,190}$'),
  ADD CONSTRAINT record_occurrences_kind_shape CHECK (
    CASE kind
      WHEN 'created' THEN from_state IS NULL AND to_state IS NULL
      ELSE from_state IS NOT NULL AND to_state IS NOT NULL AND from_state <> to_state END);
DO $$
DECLARE
  existing text; BEGIN
  SELECT conname INTO STRICT existing FROM pg_constraint
   WHERE conrelid = 'platform.record_creation_occurrences'::regclass AND contype = 'u';
  EXECUTE format('ALTER TABLE platform.record_creation_occurrences DROP CONSTRAINT %I', existing); END $$;
ALTER TABLE platform.record_creation_occurrences
  ADD CONSTRAINT record_occurrences_command_key UNIQUE
    (tenant_id, environment_id, writer_xid, request_id, action_id, kind, record_type, company_id, record_id);

-- The generic transition writer names the move it just made, inside its own
-- governed write and after its UPDATE, which still holds the row lock. The
-- company is the one the writer wrote (UPDATE ... RETURNING, B2); the stored
-- row is re-read by (tenant, environment, company, record) and must already be
-- in the target state, exactly one row. The from-state is the compiled
-- constant the writer pinned in that UPDATE's WHERE (B3).
CREATE FUNCTION north_star_internal.record_transitions(
  physical_table text, identity_column text, state_column text, record_type text,
  company uuid, record uuid, from_state text, to_state text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  action text := nullif(current_setting('north_star.creation_action', true), '');
  recorded integer; BEGIN
  IF action IS NULL THEN
    RAISE EXCEPTION 'record transition outside a governed write' USING ERRCODE = 'P0001'; END IF;
  IF action = 'sealed' THEN
    RAISE EXCEPTION 'record transition after its command was sealed' USING ERRCODE = 'P0001'; END IF;
  IF record_type !~ '^[a-z][a-z0-9_.:-]{0,190}$' OR from_state !~ '^[a-z][a-z0-9_.:-]{0,190}$'
     OR to_state !~ '^[a-z][a-z0-9_.:-]{0,190}$' THEN
    RAISE EXCEPTION 'record transition names a non-canonical ID'; END IF;
  IF company IS NULL OR record IS NULL OR from_state = to_state THEN
    RAISE EXCEPTION 'record transition names no company, record or move'; END IF;
  EXECUTE format(
    'INSERT INTO platform.record_creation_occurrences
       (tenant_id, environment_id, writer_xid, request_id, action_id, kind, record_type,
        record_id, company_id, from_state, to_state)
     SELECT r.tenant_id, r.environment_id, pg_current_xact_id(),
            nullif(current_setting(''north_star.request_id'', true), '''')::uuid,
            $1, ''transitioned'', $2, r.%1$I, r.legal_entity_id, $5, $6
       FROM north_star_module.%2$I AS r
      WHERE r.tenant_id = north_star_internal.trusted_tenant_id()
        AND r.environment_id = north_star_internal.trusted_environment_id()
        AND r.legal_entity_id = $3
        AND r.%1$I = $4
        AND r.%3$I = $6', identity_column, physical_table, state_column)
    USING action, record_type, company, record, from_state, to_state;
  GET DIAGNOSTICS recorded = ROW_COUNT;
  IF recorded <> 1 THEN
    RAISE EXCEPTION 'a claimed record transition is not stored in this scope'; END IF;
  RETURN recorded; END $$;
REVOKE ALL ON FUNCTION north_star_internal.record_transitions(text, text, text, text, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION north_star_internal.record_transitions(text, text, text, text, uuid, uuid, text, text)
  TO north_star_runtime, north_star_module_runtime;

-- A definition names its source: a receipt event, a record type's creations,
-- or a record type's moves into one state (optionally from one state).
ALTER TABLE platform.workflow_definitions
  ADD COLUMN to_state text CHECK (to_state ~ '^[a-z][a-z0-9_.:-]{0,190}$'),
  ADD COLUMN from_state text CHECK (from_state ~ '^[a-z][a-z0-9_.:-]{0,190}$'),
  DROP CONSTRAINT workflow_definitions_record_trigger_shape,
  ADD CONSTRAINT workflow_definitions_record_trigger_shape CHECK (
    CASE event_type
      WHEN 'northstar.runtime:event.record-created'
        THEN record_type IS NOT NULL AND to_state IS NULL AND from_state IS NULL
      WHEN 'northstar.runtime:event.record-transitioned'
        THEN record_type IS NOT NULL AND to_state IS NOT NULL AND from_state IS DISTINCT FROM to_state
      ELSE record_type IS NULL AND to_state IS NULL AND from_state IS NULL END);

-- A receipt and a recordCreated definition hash exactly the bytes they hashed
-- before this member (B4).
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
            ELSE jsonb_build_array(definition.record_type) END
    || CASE WHEN definition.to_state IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(definition.to_state, definition.from_state) END)::text, 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION platform.workflow_bind_release_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ BEGIN
  SELECT jsonb_object_agg(d.workflow_id, jsonb_build_object(
           'digest', e.binding_digest, 'eventType', d.event_type,
           'unattendedOperations', e.unattended_operations
         ) || CASE WHEN d.record_type IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('recordType', d.record_type) END
           || CASE WHEN d.to_state IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('toState', d.to_state)
                        || CASE WHEN d.from_state IS NULL THEN '{}'::jsonb
                                ELSE jsonb_build_object('fromState', d.from_state) END END)
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

-- B5: the page stays keyed by subscribed record type, so a move that matches
-- no definition is still paged and resolved INELIGIBLE by the consumer rather
-- than rescanned on every claim. It now returns the kind and both states.
DROP FUNCTION platform.workflow_record_creation_page(integer);
CREATE FUNCTION platform.workflow_record_creation_page(page_size integer)
RETURNS TABLE (
  occurrence_id uuid, record_type text, record_id uuid, company_id uuid,
  event_id uuid, release_id uuid, release_content_hash text, trigger_principal_id uuid,
  cause_workflow_id text, cause_depth integer, kind text, from_state text, to_state text
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
         change.execution_principal_id, cause.workflow_id, cause.causation_depth,
         page.kind, page.from_state, page.to_state
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

-- B7: a run's scope is its occurrence chain AND the occurrence matches the
-- definition of the release its event was written under: the record type, the
-- kind (a definition with a target state is a transition), the target state
-- and, when the definition names one, the from-state. loadRun, the approval
-- worklist and staff Retry all re-derive through this one function.
DROP FUNCTION platform.workflow_record_trigger_scope(uuid);
CREATE FUNCTION platform.workflow_record_trigger_scope(instance uuid)
RETURNS TABLE (
  legal_entity_id uuid, trigger_record_id uuid, record_type text, event_id uuid,
  trigger_principal_id uuid, release_id uuid, release_content_hash text,
  kind text, from_state text, to_state text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.company_id, c.record_id, c.record_type, event.domain_event_id,
         change.execution_principal_id, event.release_id, event.release_content_hash,
         c.kind, c.from_state, c.to_state
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
    JOIN platform.workflow_definitions AS d
      ON (d.tenant_id, d.environment_id, d.release_id, d.workflow_id, d.record_type) =
         (i.tenant_id, i.environment_id, event.release_id, i.workflow_id, c.record_type)
     AND c.kind = CASE WHEN d.to_state IS NULL THEN 'created' ELSE 'transitioned' END
     AND c.to_state IS NOT DISTINCT FROM d.to_state
     AND (d.from_state IS NULL OR c.from_state = d.from_state)
   WHERE i.tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND i.environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND i.instance_id = instance
$$;
REVOKE ALL ON FUNCTION platform.workflow_record_trigger_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_record_trigger_scope(uuid) TO north_star_workflow_worker;
