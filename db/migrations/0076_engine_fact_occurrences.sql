-- WORKFLOW-3 slice 1b (ADR-0073 A1 engineFactChanged). Number provisional.
--
-- A third occurrence kind: an engine fact changing value on a subject the
-- engine keeps, owned by a company-owned record. The engine's own definer SQL
-- names each change, in the writer's transaction, through engine_facts below.
-- It takes tenant, environment and company from the engine's own stored rows,
-- never from session settings: an engine sweep runs with no tenant scope over
-- every tenant (E2), so the scoped re-read record_creations uses would find
-- nothing there. The occurrence reuses 0070's page, dispositions, activation
-- capture, start key, trigger scope, approval and staff Retry.
--
-- Seal: a fact carries the invocation its engine writes in the same
-- transaction, by a deferred FK, so a fact whose receipt is never written
-- refuses commit and a rollback removes both. Exactly once: one occurrence per
-- (fact, subject, subject revision); a replayed command writes no revision.
--
-- created and transitioned rows keep their writer columns and seal (the source
-- shape CHECK); their definitions keep their digest and binding bytes (the
-- fact ID is appended only when present, E6).

ALTER TABLE platform.record_creation_occurrences
  ALTER COLUMN writer_xid DROP NOT NULL,
  ALTER COLUMN request_id DROP NOT NULL,
  ALTER COLUMN action_id DROP NOT NULL,
  ADD COLUMN fact_id text CHECK (fact_id ~ '^[a-z][a-z0-9_.:-]{0,190}$'),
  ADD COLUMN subject_id uuid,
  ADD COLUMN subject_revision integer CHECK (subject_revision > 0),
  ADD COLUMN invocation_id uuid,
  DROP CONSTRAINT record_creation_occurrences_kind_check,
  ADD CONSTRAINT record_occurrences_kind_check CHECK (kind IN ('created', 'transitioned', 'engineFact')),
  ADD CONSTRAINT record_occurrences_source_shape CHECK (
    CASE kind
      WHEN 'engineFact' THEN writer_xid IS NULL AND request_id IS NULL AND action_id IS NULL
        AND fact_id IS NOT NULL AND subject_id IS NOT NULL AND subject_revision IS NOT NULL
        AND invocation_id IS NOT NULL
      ELSE writer_xid IS NOT NULL AND request_id IS NOT NULL AND action_id IS NOT NULL
        AND fact_id IS NULL AND subject_id IS NULL AND subject_revision IS NULL
        AND invocation_id IS NULL END),
  ADD CONSTRAINT record_occurrences_fact_key UNIQUE
    (tenant_id, environment_id, fact_id, subject_id, subject_revision),
  ADD CONSTRAINT record_occurrences_fact_invocation FOREIGN KEY (tenant_id, environment_id, invocation_id)
    REFERENCES platform.trust_action_invocations (tenant_id, environment_id, invocation_id)
    DEFERRABLE INITIALLY DEFERRED;

-- The owner row is re-read by (tenant, environment, company, record) in the
-- engine-supplied scope and must be exactly one row: a fact never names a
-- record of another company. Only engine definer SQL owned by the migration
-- role calls this: no runtime role is granted EXECUTE.
CREATE FUNCTION north_star_internal.engine_facts(
  tenant uuid, environment uuid, fact text, invocation uuid,
  physical_table text, identity_column text, record_type text, company uuid, record uuid,
  subject uuid, subject_revision_number integer, from_value text, to_value text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  recorded integer; BEGIN
  IF fact !~ '^[a-z][a-z0-9_.:-]{0,190}$' OR record_type !~ '^[a-z][a-z0-9_.:-]{0,190}$'
     OR from_value !~ '^[a-z][a-z0-9_.:-]{0,190}$' OR to_value !~ '^[a-z][a-z0-9_.:-]{0,190}$' THEN
    RAISE EXCEPTION 'engine fact names a non-canonical ID'; END IF;
  IF tenant IS NULL OR environment IS NULL OR invocation IS NULL OR company IS NULL OR record IS NULL
     OR subject IS NULL OR subject_revision_number IS NULL OR from_value = to_value THEN
    RAISE EXCEPTION 'engine fact names no scope, record, subject or change'; END IF;
  EXECUTE format(
    'INSERT INTO platform.record_creation_occurrences
       (tenant_id, environment_id, kind, record_type, record_id, company_id, from_state, to_state,
        fact_id, subject_id, subject_revision, invocation_id)
     SELECT r.tenant_id, r.environment_id, ''engineFact'', $1, r.%1$I, r.legal_entity_id, $2, $3,
            $4, $5, $6, $7
       FROM north_star_module.%2$I AS r
      WHERE r.tenant_id = $8
        AND r.environment_id = $9
        AND r.legal_entity_id = $10
        AND r.%1$I = $11', identity_column, physical_table)
    USING record_type, from_value, to_value, fact, subject, subject_revision_number, invocation,
          tenant, environment, company, record;
  GET DIAGNOSTICS recorded = ROW_COUNT;
  IF recorded <> 1 THEN
    RAISE EXCEPTION 'a claimed engine fact owner is not stored in this company'; END IF;
  RETURN recorded; END $$;
REVOKE ALL ON FUNCTION north_star_internal.engine_facts(
  uuid, uuid, text, uuid, text, text, text, uuid, uuid, uuid, integer, text, text) FROM PUBLIC;

-- A definition names its source; an engine fact definition also names the
-- fact, and keeps its values in the state columns.
ALTER TABLE platform.workflow_definitions
  ADD COLUMN fact_id text CHECK (fact_id ~ '^[a-z][a-z0-9_.:-]{0,190}$'),
  DROP CONSTRAINT workflow_definitions_record_trigger_shape,
  ADD CONSTRAINT workflow_definitions_record_trigger_shape CHECK (
    CASE event_type
      WHEN 'northstar.runtime:event.record-created'
        THEN record_type IS NOT NULL AND to_state IS NULL AND from_state IS NULL AND fact_id IS NULL
      WHEN 'northstar.runtime:event.record-transitioned'
        THEN record_type IS NOT NULL AND to_state IS NOT NULL AND from_state IS DISTINCT FROM to_state
          AND fact_id IS NULL
      WHEN 'northstar.runtime:event.engine-fact-changed'
        THEN record_type IS NOT NULL AND fact_id IS NOT NULL AND to_state IS NOT NULL
          AND from_state IS DISTINCT FROM to_state
      ELSE record_type IS NULL AND to_state IS NULL AND from_state IS NULL AND fact_id IS NULL END);

-- E6: earlier members hash exactly the bytes they hashed before.
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
            ELSE jsonb_build_array(definition.to_state, definition.from_state) END
    || CASE WHEN definition.fact_id IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(definition.fact_id) END)::text, 'UTF8')), 'hex')
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
                                ELSE jsonb_build_object('fromState', d.from_state) END END
           || CASE WHEN d.fact_id IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('factId', d.fact_id) END)
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

-- E5: the page reaches a fact's event through its own invocation (the writer
-- columns are NULL), with the same equalities: a SUCCEEDED invocation whose
-- event, outbox and change document are its own. It also returns the fact.
DROP FUNCTION platform.workflow_record_creation_page(integer);
CREATE FUNCTION platform.workflow_record_creation_page(page_size integer)
RETURNS TABLE (
  occurrence_id uuid, record_type text, record_id uuid, company_id uuid,
  event_id uuid, release_id uuid, release_content_hash text, trigger_principal_id uuid,
  cause_workflow_id text, cause_depth integer, kind text, from_state text, to_state text,
  fact_id text
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
         page.kind, page.from_state, page.to_state, page.fact_id
    FROM page
    LEFT JOIN platform.record_creation_batches AS b
      ON (b.tenant_id, b.environment_id, b.writer_xid, b.request_id, b.action_id) =
         (page.tenant_id, page.environment_id, page.writer_xid, page.request_id, page.action_id)
    LEFT JOIN platform.trust_action_invocations AS fact_source
      ON (fact_source.tenant_id, fact_source.environment_id, fact_source.invocation_id) =
         (page.tenant_id, page.environment_id, page.invocation_id)
    LEFT JOIN platform.trust_outbox AS o
      ON (o.tenant_id, o.environment_id, o.outbox_id, o.domain_event_id, o.action_id) =
         (page.tenant_id, page.environment_id,
          COALESCE(b.outbox_id, fact_source.outbox_id),
          COALESCE(b.domain_event_id, fact_source.domain_event_id),
          COALESCE(b.action_id, fact_source.action_id))
     AND (page.invocation_id IS NULL OR o.invocation_id = page.invocation_id)
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

-- E4/E5: the scope reaches a fact's event through its own invocation, and
-- matches the kind by the definition's event type and the fact by
-- IS NOT DISTINCT FROM (NULL for every created and transitioned run).
DROP FUNCTION platform.workflow_record_trigger_scope(uuid);
CREATE FUNCTION platform.workflow_record_trigger_scope(instance uuid)
RETURNS TABLE (
  legal_entity_id uuid, trigger_record_id uuid, record_type text, event_id uuid,
  trigger_principal_id uuid, release_id uuid, release_content_hash text,
  kind text, from_state text, to_state text, fact_id text, subject_id uuid
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.company_id, c.record_id, c.record_type, event.domain_event_id,
         change.execution_principal_id, event.release_id, event.release_content_hash,
         c.kind, c.from_state, c.to_state, c.fact_id, c.subject_id
    FROM platform.workflow_instances AS i
    JOIN platform.record_creation_occurrences AS c
      ON (c.tenant_id, c.environment_id, c.occurrence_id, c.record_type, c.record_id, c.company_id) =
         (i.tenant_id, i.environment_id, i.creation_occurrence_id, i.record_type, i.trigger_record_id, i.legal_entity_id)
    LEFT JOIN platform.record_creation_batches AS b
      ON (b.tenant_id, b.environment_id, b.writer_xid, b.request_id, b.action_id, b.domain_event_id) =
         (c.tenant_id, c.environment_id, c.writer_xid, c.request_id, c.action_id, i.event_id)
    LEFT JOIN platform.trust_action_invocations AS fact_source
      ON (fact_source.tenant_id, fact_source.environment_id, fact_source.invocation_id, fact_source.domain_event_id) =
         (c.tenant_id, c.environment_id, c.invocation_id, i.event_id)
    JOIN platform.trust_domain_events AS event
      ON (event.tenant_id, event.environment_id, event.domain_event_id, event.outbox_id, event.action_id) =
         (c.tenant_id, c.environment_id, i.event_id,
          COALESCE(b.outbox_id, fact_source.outbox_id), COALESCE(b.action_id, fact_source.action_id))
    JOIN platform.trust_action_invocations AS invocation
      ON (invocation.tenant_id, invocation.environment_id, invocation.invocation_id, invocation.action_id) =
         (event.tenant_id, event.environment_id, event.invocation_id, event.action_id)
     AND invocation.outcome = 'SUCCEEDED'
     AND (c.invocation_id IS NULL OR invocation.invocation_id = c.invocation_id)
    JOIN platform.trust_business_change_documents AS change
      ON (change.tenant_id, change.environment_id, change.change_document_id, change.invocation_id,
          change.domain_event_id, change.outbox_id) =
         (event.tenant_id, event.environment_id, event.change_document_id, event.invocation_id,
          event.domain_event_id, event.outbox_id)
    JOIN platform.workflow_definitions AS d
      ON (d.tenant_id, d.environment_id, d.release_id, d.workflow_id, d.record_type) =
         (i.tenant_id, i.environment_id, event.release_id, i.workflow_id, c.record_type)
     AND c.kind = CASE d.event_type
                    WHEN 'northstar.runtime:event.record-created' THEN 'created'
                    WHEN 'northstar.runtime:event.record-transitioned' THEN 'transitioned'
                    WHEN 'northstar.runtime:event.engine-fact-changed' THEN 'engineFact' END
     AND c.fact_id IS NOT DISTINCT FROM d.fact_id
     AND c.to_state IS NOT DISTINCT FROM d.to_state
     AND (d.from_state IS NULL OR c.from_state = d.from_state)
   WHERE i.tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND i.environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND i.instance_id = instance
$$;
REVOKE ALL ON FUNCTION platform.workflow_record_trigger_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_record_trigger_scope(uuid) TO north_star_workflow_worker;
