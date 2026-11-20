-- Runtime callers may quote scoped terms. Publication requires the matching
-- accepted operation, change, event, outbox and receipt in the same transaction.
REVOKE ALL ON platform.billing_rate_tables, platform.billing_list_assignments FROM north_star_runtime;

DROP POLICY billing_terms_scope ON platform.billing_rate_tables;
DROP POLICY billing_assignment_scope ON platform.billing_list_assignments;

-- Recover when each old version was known from its accepted publication.
-- An unaudited or ambiguously attributed price must never enter a quote.
DO $migration$
DECLARE tab text; uq name; BEGIN
  FOREACH tab IN ARRAY ARRAY['billing_rate_tables','billing_list_assignments'] LOOP
    EXECUTE format('ALTER TABLE platform.%I ADD COLUMN published_at timestamptz, ADD COLUMN invocation_id uuid', tab);
    EXECUTE format('UPDATE platform.%I b SET (published_at,invocation_id) = (
      SELECT i.recorded_at,i.invocation_id FROM platform.trust_action_invocations i
      JOIN platform.semantic_operation_receipts r USING (tenant_id,environment_id,invocation_id)
      JOIN platform.trust_domain_events v USING (tenant_id,environment_id,invocation_id)
      WHERE (i.tenant_id,i.environment_id,i.execution_principal_id,i.release_id) =
        (b.tenant_id,b.environment_id,b.actor_id,b.release_id)
        AND i.metadata->''tableDigest''->>''value''=b.content_digest
        AND i.metadata->''companyId''->>''value''=b.company_id::text
        AND v.event_type=$1)',tab)
      USING CASE tab WHEN 'billing_rate_tables' THEN 'northstar.billing:event.rate_table_published' ELSE 'northstar.billing:event.list_assigned' END;
    EXECUTE format('ALTER TABLE platform.%I ALTER published_at SET NOT NULL, ALTER invocation_id SET NOT NULL,
      ADD UNIQUE (tenant_id,environment_id,invocation_id),
      ADD FOREIGN KEY (tenant_id,environment_id,invocation_id) REFERENCES platform.trust_action_invocations',tab);
    SELECT conname INTO STRICT uq FROM pg_constraint WHERE conrelid=format('platform.%I',tab)::regclass
      AND contype='u' AND pg_get_constraintdef(oid) LIKE '%effective_from%';
    EXECUTE format('ALTER TABLE platform.%I DROP CONSTRAINT %I',tab,uq); END LOOP; END $migration$;

CREATE FUNCTION north_star_internal.billing_has_grant(company uuid,permission text,resource text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT FROM platform.current_policy_memberships m
    JOIN platform.current_policy_roles r USING (tenant_id,environment_id,role_id)
    JOIN platform.current_policy_permission_grants g USING (tenant_id,environment_id,role_id)
    WHERE m.tenant_id=north_star_internal.trusted_tenant_id() AND m.environment_id=north_star_internal.trusted_environment_id()
      AND m.principal_id=nullif(current_setting('north_star.principal_id',true),'')::uuid
      AND m.revoked_at IS NULL AND r.revoked_at IS NULL AND g.revoked_at IS NULL
      AND (m.legal_entity_id IS NULL OR m.legal_entity_id=company)
      AND (g.permission_id,g.resource_id)=(permission,resource))
$$;

CREATE FUNCTION north_star_internal.billing_digest(canonical text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(sha256(convert_to('northstar.app-package.normalized/v0-experimental','UTF8') ||
    decode('00','hex') || convert_to(canonical,'UTF8')),'hex')
$$;

-- The release supplies permission IDs, record types and physical column names.
CREATE FUNCTION north_star_internal.billing_projection(released uuid,family text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (SELECT convert_from(b.canonical_bytes,'UTF8')::jsonb FROM platform.tenant_release_chunk_links l
    JOIN platform.tenant_release_projection_links p USING (tenant_id,environment_id,release_id,projection_instance_id)
    JOIN platform.release_artifact_blobs b ON b.content_hash=l.chunk_hash AND b.artifact_kind='projectionChunk'
    JOIN platform.active_release_pointers a USING (tenant_id,environment_id,release_id)
    WHERE (l.tenant_id,l.environment_id,l.release_id)=(north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),released)
      AND p.projection_family_id='northstar.compiler:projection-family.'||family)
$$;

CREATE FUNCTION platform.billing_publish(action text, request_key uuid, canonical_body text,canonical_plan text) RETURNS void
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
      AND r.xmin=pg_current_xact_id()::text::xid AND i.execution_principal_id=actor AND i.policy_decision='ALLOW'
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

CREATE FUNCTION platform.billing_quote_terms(released uuid,company uuid,canonical_plan text,customer text)
RETURNS TABLE(tables jsonb[],assignments jsonb[],as_of timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t uuid := north_star_internal.trusted_tenant_id();
  e uuid := north_star_internal.trusted_environment_id();
  plan jsonb := canonical_plan::jsonb;
  plan_hash text := north_star_internal.billing_digest(canonical_plan);
  permitted integer; BEGIN
  -- Resolve both read grants from the actual plan in the pinned release.
  WITH bound AS (
    SELECT value AS p FROM jsonb_array_elements(north_star_internal.billing_projection(released,'surface-manifest')->'billingPlans')
      WHERE value=plan
  )
  SELECT count(DISTINCT q->>'queryId') INTO permitted FROM bound,jsonb_array_elements(north_star_internal.billing_projection(released,'query-catalog')->'queries') q
    WHERE q->>'queryId' IN (p->'bindings'->>'quoteQueryId',p->'bindings'->>'evidenceQueryId')
      AND north_star_internal.billing_has_grant(company,q->>'permissionId',q->>'sourceEntityId');
  IF permitted <> 2 OR NOT north_star_internal.billing_has_grant(company,'northstar.runtime:permission.legal-entity-read-scope','northstar.runtime:scope.legal-entity') THEN RAISE insufficient_privilege; END IF;
  RETURN QUERY WITH lists AS (
    SELECT l.list_id,l.body || jsonb_build_object('publishedAt',to_char(l.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS entry
    FROM platform.billing_list_assignments l WHERE (l.tenant_id,l.environment_id,l.company_id,l.plan_digest,l.customer_id)=(t,e,company,plan_hash,customer)
    ORDER BY l.effective_from,l.revision_id LIMIT 129
  ), prices AS (
    SELECT p.body || jsonb_build_object('publishedAt',to_char(p.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS entry
    FROM platform.billing_rate_tables p WHERE (p.tenant_id,p.environment_id,p.company_id,p.plan_digest)=(t,e,company,plan_hash)
      AND (p.selector->>'kind'='base' OR (p.selector->>'kind'='customer' AND p.selector->>'customerId'=customer)
        OR (p.selector->>'kind'='priceList' AND p.selector->>'listId' IN (SELECT list_id FROM lists)))
    ORDER BY p.effective_from,p.version_id LIMIT 257
  ) SELECT ARRAY(SELECT entry FROM prices),ARRAY(SELECT entry FROM lists),statement_timestamp(); END $$;
REVOKE ALL ON FUNCTION north_star_internal.billing_projection(uuid,text),north_star_internal.billing_has_grant(uuid,text,text),north_star_internal.billing_digest(text),
  platform.billing_publish(text,uuid,text,text),platform.billing_quote_terms(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.billing_publish(text,uuid,text,text),platform.billing_quote_terms(uuid,uuid,text,text) TO north_star_runtime;
