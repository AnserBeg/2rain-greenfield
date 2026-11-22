-- Compare xmin to the low 32 bits of the active transaction ID directly.
CREATE OR REPLACE FUNCTION platform.billing_publish(action text, request_key uuid, canonical_body text,canonical_plan text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t uuid := north_star_internal.trusted_tenant_id();
  e uuid := north_star_internal.trusted_environment_id();
  actor uuid := nullif(current_setting('north_star.principal_id',true),'')::uuid;
  plan jsonb; operation jsonb; entity jsonb; proposal_column text; matches boolean;
  publication record; body jsonb := canonical_body::jsonb; hash text := north_star_internal.billing_digest(canonical_body); BEGIN
  SELECT r.release_id,r.invocation_id,r.recorded_at,r.mutation_result->>'planDigest' AS plan,
    (i.metadata->'companyId'->>'value')::uuid AS company, v.event_type,c.record_type,c.record_id,c.revision
    INTO STRICT publication FROM platform.semantic_operation_receipts r
    JOIN platform.trust_action_invocations i USING (tenant_id,environment_id,invocation_id,action_id,release_id)
    JOIN platform.trust_business_change_documents c ON (c.tenant_id,c.environment_id,c.invocation_id,c.change_document_id)=(r.tenant_id,r.environment_id,r.invocation_id,r.change_document_id)
    JOIN platform.trust_domain_events v ON (v.tenant_id,v.environment_id,v.invocation_id,v.domain_event_id)=(r.tenant_id,r.environment_id,r.invocation_id,r.domain_event_id)
    JOIN platform.trust_outbox o ON (o.tenant_id,o.environment_id,o.invocation_id,o.outbox_id)=(r.tenant_id,r.environment_id,r.invocation_id,r.outbox_id)
    WHERE (r.tenant_id,r.environment_id,r.principal_id,r.action_id,r.idempotency_key)=(t,e,actor,action,request_key)
      AND r.xmin=pg_current_xact_id()::xid AND i.execution_principal_id=actor AND i.policy_decision='ALLOW'
      AND i.metadata->'tableDigest'->>'value'=hash AND r.mutation_result->>'recordId'=c.record_id;
  SELECT value INTO STRICT plan FROM jsonb_array_elements(north_star_internal.billing_projection(publication.release_id,'surface-manifest')->'billingPlans')
    WHERE value=canonical_plan::jsonb AND publication.plan=north_star_internal.billing_digest(canonical_plan)
      AND value->'bindings'->>(CASE WHEN publication.event_type='northstar.billing:event.list_assigned' THEN 'assignmentOperationId'
        WHEN body->'selector'->>'kind'='base' THEN 'publishOperationId' ELSE 'overrideOperationId' END)=action;
  SELECT value INTO STRICT operation FROM jsonb_array_elements(north_star_internal.billing_projection(publication.release_id,'operation-catalog')->'operations')
    WHERE value->>'operationId'=action AND value->>'readBackQueryId'=plan->'bindings'->>'termsQueryId'
      AND value->'effect'->'capability'->>'targetId'='northstar.billing:capability.terms';
  IF NOT north_star_internal.billing_has_grant(publication.company,operation->>'permissionId',publication.record_type)
    THEN RAISE insufficient_privilege; END IF;
  SELECT value INTO STRICT entity FROM jsonb_array_elements(north_star_internal.billing_projection(publication.release_id,'storage-target')->'entities')
    WHERE value->>'entityId'=publication.record_type;
  SELECT value->>'physicalName' INTO STRICT proposal_column FROM jsonb_array_elements(entity->'columns')
    WHERE value->>'canonicalFieldId'=plan->'bindings'->>'termsFieldId';
  EXECUTE format('SELECT %I::jsonb=$1 FROM north_star_module.%I WHERE (tenant_id,environment_id,record_id,revision,%I)=($2,$3,$4,$5,$6)
    AND archived_at IS NULL FOR SHARE',proposal_column,entity->>'physicalTableName',entity->'legalEntity'->>'column')
    INTO matches USING body,t,e,publication.record_id::uuid,publication.revision,publication.company;
  IF matches IS DISTINCT FROM true THEN RAISE EXCEPTION 'BILLING_TERMS_INVALID'; END IF;
  IF publication.event_type='northstar.billing:event.list_assigned' AND body->>'schemaVersion'='northstar.billing-list-assignment/v1' THEN
    INSERT INTO platform.billing_list_assignments
      (tenant_id,environment_id,company_id,plan_digest,customer_id,list_id,revision_id,effective_from,content_digest,body,release_id,actor_id,published_at,invocation_id)
      VALUES(t,e,publication.company,publication.plan,body->>'customerId',body->>'listId',body->>'revision',(body->>'effectiveFrom')::timestamptz,
        hash,body,publication.release_id,actor,publication.recorded_at,publication.invocation_id);
  ELSIF publication.event_type='northstar.billing:event.rate_table_published' AND body->>'schemaVersion'='northstar.billing-rate-table/v1'
     AND body->>'planDigest'=publication.plan THEN
    INSERT INTO platform.billing_rate_tables
      (tenant_id,environment_id,company_id,plan_digest,version_id,selector,effective_from,content_digest,body,release_id,actor_id,published_at,invocation_id)
      VALUES(t,e,publication.company,publication.plan,body->>'version',body->'selector',(body->>'effectiveFrom')::timestamptz,
        hash,body,publication.release_id,actor,publication.recorded_at,publication.invocation_id);
  ELSE RAISE EXCEPTION 'BILLING_TERMS_INVALID'; END IF; END $$;
