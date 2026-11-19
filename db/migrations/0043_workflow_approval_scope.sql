-- A release approver can decide only a plan within their live operation and
-- company grants. The plan and its eligibility come from the same scoped read.
WITH suspended AS (
  UPDATE platform.workflow_runs AS r
     SET status = 'SUSPENDED', reason = 'approval-action-or-company-refused'
    FROM platform.workflow_pending_approvals AS a
   WHERE (a.tenant_id, a.environment_id, a.run_id, a.fence) =
         (r.tenant_id, r.environment_id, r.run_id, r.execution_fence)
     AND a.status = 'PENDING' AND r.status = 'WAITING'
  RETURNING r.tenant_id, r.environment_id, r.run_id, r.execution_fence, r.reason
)
INSERT INTO platform.workflow_journal (tenant_id, environment_id, run_id, cursor, kind, canonical_bytes)
SELECT tenant_id, environment_id, run_id, 0, 'CONTROL',
       convert_to(jsonb_build_object('fence', execution_fence::text, 'operator', NULL, 'reason', reason)::text, 'UTF8')
  FROM suspended;

UPDATE platform.workflow_pending_approvals
   SET status = 'STALE'
 WHERE status <> 'STALE';

CREATE FUNCTION platform.workflow_approval_worklist(requested_run uuid DEFAULT NULL)
RETURNS TABLE (run_id uuid, cursor integer, fence bigint, plan bytea, plan_digest text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.run_id, a.cursor, a.fence, a.plan, a.plan_digest
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
    JOIN platform.trust_domain_events AS event
      ON (event.tenant_id, event.environment_id, event.domain_event_id, event.outbox_id) =
         (r.tenant_id, r.environment_id, i.event_id, i.outbox_id)
     AND (event.release_id, event.release_content_hash) = (r.release_id, r.release_root)
     AND event.event_type = d.event_type
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
    CROSS JOIN LATERAL (SELECT
      nullif(current_setting('north_star.principal_id', true), '')::uuid AS principal,
      convert_from(j.canonical_bytes, 'UTF8')::jsonb AS request,
      event.payload #>> '{legalEntityId,value}' AS company
    ) AS binding
    CROSS JOIN LATERAL jsonb_array_elements(convert_from(catalog.canonical_bytes, 'UTF8')::jsonb->'operations') AS operation(value)
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
     AND event.payload #>> '{legalEntityId,representation}' = 'VALUE'
     AND binding.company IS NOT NULL
     AND (NOT (binding.request->'input' ? 'legalEntityId')
       OR binding.request #>> '{input,legalEntityId}' = binding.company)
     AND convert_from(a.plan, 'UTF8')::jsonb = jsonb_build_object(
       'companyId', binding.company, 'cursor', a.cursor, 'fence', a.fence::text,
       'pointerId', r.pointer_id, 'releaseId', r.release_id, 'releaseRoot', r.release_root,
       'request', binding.request, 'runId', r.run_id
     )
     AND d.grants->'operations' ? (binding.request->>'operationId')
     AND operation.value->>'lifecycle' = 'active'
     AND operation.value->>'tier' = 'o0'
     AND operation.value->>'operationId' = binding.request->>'operationId'
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
          AND (membership.legal_entity_id IS NULL OR membership.legal_entity_id::text = binding.company)
          AND grant_row.permission_id = operation.value->>'permissionId'
          AND grant_row.resource_id = permission.value #>> '{resource,targetId}'
          AND NOT COALESCE(operation.value->'excludedRoleKeys' ? role.role_key, false)
     )
   ORDER BY r.created_at, a.run_id, a.cursor
   LIMIT 100
$$;
REVOKE ALL ON FUNCTION platform.workflow_approval_worklist(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_approval_worklist(uuid) TO north_star_runtime;

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
  SELECT p.pointer_id, p.release_id INTO active_pointer, active_release
    FROM platform.active_release_pointers AS p
   WHERE p.tenant_id = tenant AND p.environment_id = environment AND p.fence = requested_fence
   FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM platform.lock_current_policy_epoch(tenant, environment);
  PERFORM 1 FROM platform.workflow_runs AS r
   WHERE r.tenant_id = tenant AND r.environment_id = environment AND r.run_id = requested_run
     AND r.pointer_id = active_pointer AND r.release_id = active_release
     AND r.execution_fence = requested_fence AND r.status = 'WAITING'
   FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM platform.workflow_approval_worklist(requested_run) AS candidate
     WHERE candidate.cursor = requested_cursor AND candidate.fence = requested_fence
       AND candidate.plan_digest = requested_plan_digest
  ) THEN RETURN false; END IF;
  UPDATE platform.workflow_pending_approvals AS a
     SET status = decision, decided_by = principal, decided_at = clock_timestamp(),
         decision_request_id = current_setting('north_star.request_id')::uuid
   WHERE a.tenant_id = tenant AND a.environment_id = environment AND a.run_id = requested_run
     AND a.cursor = requested_cursor AND a.fence = requested_fence
     AND a.plan_digest = requested_plan_digest AND a.status = 'PENDING';
  IF NOT FOUND THEN RETURN false; END IF;
  -- The run lock serializes the decision with journal completion and wakeup.
  INSERT INTO platform.workflow_journal (tenant_id, environment_id, run_id, cursor, kind, canonical_bytes)
  SELECT tenant, environment, requested_run, requested_cursor, 'RESULT',
         convert_to((decision = 'APPROVED')::text, 'UTF8')
   WHERE NOT EXISTS (
     SELECT 1 FROM platform.workflow_journal AS j
      WHERE (j.tenant_id, j.environment_id, j.run_id, j.cursor, j.kind) =
            (tenant, environment, requested_run, requested_cursor, 'RESULT')
   );
  UPDATE platform.workflow_runs SET status = 'RUNNABLE', reason = NULL
   WHERE tenant_id = tenant AND environment_id = environment AND run_id = requested_run;
  RETURN true; END
$$;
