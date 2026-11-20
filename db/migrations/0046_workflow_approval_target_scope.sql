-- Approvals bind the original event and exact operation input. Evaluate the
-- live action grant against the operation target's scope at both entry points.
CREATE FUNCTION platform.workflow_approval_target_scope(
  tenant uuid, environment uuid, target jsonb, effect_kind text, inputs jsonb
) RETURNS TABLE (company_id uuid)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  record_id_text text := inputs->>'recordId';
  company_text text := inputs->>'legalEntityId';
  owned boolean := target ? 'legalEntity'; BEGIN
  IF target->>'storageClass' IS DISTINCT FROM 'dedicatedTable'
     OR target #>> '{recordIdentity,column}' IS DISTINCT FROM 'record_id'
     OR target->>'physicalTableName' IS NULL
     OR (owned AND target #>> '{legalEntity,column}' IS DISTINCT FROM 'legal_entity_id')
     OR jsonb_typeof(inputs) IS DISTINCT FROM 'object'
  THEN RETURN; END IF;

  IF effect_kind = 'createRecordEffect' THEN
    IF owned AND pg_input_is_valid(company_text, 'uuid') THEN
      RETURN QUERY SELECT company_text::uuid;
    ELSIF NOT owned AND NOT (inputs ? 'legalEntityId') THEN
      RETURN QUERY SELECT NULL::uuid; END IF;
  ELSIF effect_kind IN ('updateRecordEffect', 'archiveRecordEffect', 'restoreRecordEffect', 'transitionStateEffect')
     AND pg_input_is_valid(record_id_text, 'uuid')
     AND NOT (inputs ? 'legalEntityId')
  THEN
    -- The request has no company operand. Refuse missing and ambiguous IDs.
    -- Storage only guarantees uniqueness within a company for owned records.
    RETURN QUERY EXECUTE format(
      'SELECT (array_agg(owner_company))[1] FROM (
         SELECT %s AS owner_company FROM north_star_module.%I
          WHERE tenant_id = $1 AND environment_id = $2 AND record_id = $3
          LIMIT 2
       ) AS matches HAVING count(*) = 1',
      CASE WHEN owned THEN 'legal_entity_id' ELSE 'NULL::uuid' END,
      target->>'physicalTableName'
    ) USING tenant, environment, record_id_text::uuid; END IF; END
$$;
REVOKE ALL ON FUNCTION platform.workflow_approval_target_scope(uuid, uuid, jsonb, text, jsonb) FROM PUBLIC;

-- Extend the worklist result with the resolved scope for display. The decision
-- function continues to call this worklist under its authority and run locks.
DROP FUNCTION platform.workflow_approval_worklist(uuid);
CREATE FUNCTION platform.workflow_approval_worklist(requested_run uuid DEFAULT NULL)
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
      event.payload #>> '{legalEntityId,value}' AS company
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
REVOKE ALL ON FUNCTION platform.workflow_approval_worklist(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_approval_worklist(uuid) TO north_star_runtime;
