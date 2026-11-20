-- Release and Customize decisions apply to the entire environment (company_id NULL).
-- Workflow Retry takes its company from the recorded event instance.
CREATE ROLE north_star_activation_verifier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT north_star_runtime TO north_star_activation_verifier WITH INHERIT TRUE, SET FALSE;

ALTER TABLE platform.release_activation_preparations ADD COLUMN reviewed_diff text
  CHECK (octet_length(reviewed_diff) <= 1048576 AND rendered_diff_evidence_digest =
    sha256(convert_to('northstar.customization-rendered-diff/v1','UTF8') || decode('00','hex') || convert_to(reviewed_diff,'UTF8')));

CREATE TABLE platform.staff_decision_proofs (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, company_id uuid,
  proof_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), principal_id uuid NOT NULL,
  family_id uuid NOT NULL REFERENCES platform.staff_sessions, session_generation bytea NOT NULL,
  decision_kind text NOT NULL CHECK (decision_kind IN ('release','customize','retry')),
  outcome text NOT NULL CHECK (outcome IN ('approve','retry')),
  target_ids uuid[] NOT NULL CHECK (cardinality(target_ids) BETWEEN 1 AND 32),
  terms jsonb NOT NULL, decision_digest bytea NOT NULL CHECK (octet_length(decision_digest)=32),
  actor_type text NOT NULL DEFAULT 'staff' CHECK (actor_type='staff'),
  method text NOT NULL CHECK (method='webauthn'), assurance text NOT NULL CHECK (assurance='user-verified-passkey'),
  authenticated_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id,environment_id,principal_id) REFERENCES platform.staff_accounts,
  CHECK (expires_at > authenticated_at AND expires_at <= authenticated_at + interval '5 minutes'),
  CHECK ((company_id IS NOT NULL) = (decision_kind='retry')),
  CHECK ((outcome='retry') = (decision_kind='retry'))
);
CREATE TABLE platform.staff_decision_receipts (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, proof_id uuid PRIMARY KEY REFERENCES platform.staff_decision_proofs,
  request_id uuid NOT NULL, decided_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id,environment_id) REFERENCES platform.environments(tenant_id,id)
);

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['staff_decision_proofs','staff_decision_receipts'] LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('REVOKE ALL ON platform.%I FROM PUBLIC,north_star_runtime,north_star_workflow_worker,north_star_identity',tab);
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.%I
      FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_staff_audit_change()',tab); END LOOP; END $$;

CREATE FUNCTION north_star_internal.staff_release_terms(t uuid,e uuid,target uuid,kind text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('preparation',p.preparation_id,'candidate',r.release_id,'root',r.content_hash,
    'maker',r.created_by,'source',a.release_id,'pointer',a.pointer_id,'fence',a.fence::text,
    'verification',v.verification_evidence_id,'verificationDigest',v.result_set_digest,
    'transition',p.transition_preparation_receipt_id,'diffDigest',encode(p.canonical_diff_digest,'hex'),
    'renderedDiffDigest',encode(p.rendered_diff_evidence_digest,'hex'),'diff',p.reviewed_diff,
    'workflowDefinitions',(SELECT jsonb_object_agg(d.workflow_id, jsonb_build_object('digest',we.binding_digest,
      'eventType',d.event_type,'unattendedOperations',we.unattended_operations)) FROM platform.workflow_verification_evidence we
      JOIN platform.workflow_definitions d ON (d.tenant_id,d.environment_id,d.release_id,d.workflow_id) =
        (we.tenant_id,we.environment_id,we.verified_release_id,we.workflow_id) AND we.binding_digest=platform.workflow_definition_digest(d)
      WHERE (we.tenant_id,we.environment_id,we.verification_evidence_id,we.verified_release_id,we.verified_release_root) =
        (r.tenant_id,r.environment_id,r.verification_evidence_id,r.release_id,r.content_hash)),
    'patches',x.terms,'upgrade',u.upgrade_id,'base',u.base_release_id,'upgradePatchIds',convert_from(u.payload,'UTF8')::jsonb->'patchIds')
  FROM platform.release_activation_preparations p
  JOIN platform.active_release_pointers a ON (a.tenant_id,a.environment_id,a.pointer_id,a.fence)
    =(p.tenant_id,p.environment_id,p.expected_pointer_id,p.expected_fence) AND a.release_id IS NOT DISTINCT FROM p.expected_release_id
  JOIN platform.tenant_releases r ON (r.tenant_id,r.environment_id,r.release_id,r.content_hash,r.verification_evidence_id)
    =(p.tenant_id,p.environment_id,p.target_release_id,encode(p.target_manifest_root,'hex'),p.verification_evidence_id)
  JOIN platform.release_verification_evidence v ON (v.tenant_id,v.environment_id,v.verification_evidence_id,v.release_root,v.result_set_digest)
    =(r.tenant_id,r.environment_id,r.verification_evidence_id,r.content_hash,encode(p.verification_evidence_digest,'hex'))
  LEFT JOIN platform.customization_upgrades u ON (u.tenant_id,u.environment_id,u.source_release_id,u.candidate_release_id)
    =(p.tenant_id,p.environment_id,p.expected_release_id,p.target_release_id)
  CROSS JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('patch',k.patch_id,'digest',k.payload_digest,
    'change',convert_from(k.payload,'UTF8')::jsonb,'base',k.base_release_root,'parent',k.parent_revision_id,'author',k.authored_by)
    ORDER BY k.patch_id) AS terms FROM platform.customization_patches k
    WHERE (k.tenant_id,k.environment_id,k.resulting_release_id)=(p.tenant_id,p.environment_id,p.target_release_id)
      OR ((k.tenant_id,k.environment_id)=(u.tenant_id,u.environment_id) AND
        convert_from(u.payload,'UTF8')::jsonb->'patchIds' ? k.patch_id::text)) x
  WHERE p.tenant_id=t AND p.environment_id=e AND p.preparation_id=target AND p.reviewed_diff IS NOT NULL
    AND ((kind='customize')=(x.terms IS NOT NULL OR u.upgrade_id IS NOT NULL))
$$;
REVOKE ALL ON FUNCTION north_star_internal.staff_release_terms(uuid,uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION north_star_internal.staff_retry_terms(t uuid,e uuid,target uuid,company uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('run',r.run_id,'instance',i.instance_id,'occurrence',i.event_id,'workflow',r.workflow_id,
    'release',r.release_id,'root',r.release_root,'pointer',p.pointer_id,'originalFence',r.initial_fence::text,
    'previousFence',r.execution_fence::text,'fence',p.fence::text,'company',i.legal_entity_id,
    'body',d.body_digest,'executable',d.executable_digest,'sdk',d.sdk_digest,'host',d.host_version,'engine',d.engine_build,
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
  JOIN platform.trust_domain_events event ON (event.tenant_id,event.environment_id,event.domain_event_id,event.outbox_id,
    event.release_id,event.release_content_hash,event.event_type)=(r.tenant_id,r.environment_id,i.event_id,i.outbox_id,r.release_id,r.release_root,d.event_type)
  JOIN platform.trust_action_invocations invocation ON (invocation.tenant_id,invocation.environment_id,invocation.invocation_id,invocation.action_id,
    invocation.release_id,invocation.release_content_hash)=(event.tenant_id,event.environment_id,event.invocation_id,event.action_id,r.release_id,r.release_root)
    AND invocation.outcome='SUCCEEDED'
  WHERE r.tenant_id=t AND r.environment_id=e AND r.run_id=target AND i.legal_entity_id=company
    AND event.payload #>> '{legalEntityId,value}'=company::text
    AND invocation.policy_inputs #>> '{legalEntityId,representation}'='VALUE'
    AND invocation.policy_inputs #>> '{legalEntityId,value}'=company::text
    AND r.status='SUSPENDED' AND r.reason='stale-release-pin' AND p.fence>r.execution_fence
    AND w.fence=p.fence AND old.verified_approval_binding AND w.verified_approval_binding
    AND w.definition_bindings->r.workflow_id->>'digest'=platform.workflow_definition_digest(d)
    AND old.definition_bindings->r.workflow_id=w.definition_bindings->r.workflow_id
$$;
REVOKE ALL ON FUNCTION north_star_internal.staff_retry_terms(uuid,uuid,uuid,uuid) FROM PUBLIC;


-- All three readers and the consuming writer use the same projection. The ordered
-- list includes the scope and outcome even when two environments share release bytes.
CREATE FUNCTION north_star_internal.staff_require_decision_authority(t uuid,e uuid,p uuid,company uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('northstar.release-approval-authority:'||t::text,0));
  PERFORM 1 FROM platform.current_policy_epochs WHERE tenant_id=t AND environment_id=e FOR SHARE;
  IF NOT EXISTS (SELECT FROM platform.current_policy_memberships m JOIN platform.current_policy_roles role
      USING(tenant_id,environment_id,role_id) WHERE m.tenant_id=t AND m.environment_id=e AND m.principal_id=p
      AND m.revoked_at IS NULL AND role.revoked_at IS NULL AND (m.legal_entity_id IS NULL OR m.legal_entity_id=company))
    OR (SELECT eligible FROM platform.release_approver_eligibility_events WHERE tenant_id=t AND principal_id=p
        ORDER BY policy_version DESC LIMIT 1) IS DISTINCT FROM true
    OR EXISTS (SELECT FROM platform.workflow_definitions WHERE tenant_id=t AND automation_principal_id=p)
    THEN RAISE EXCEPTION 'decision authority refused'; END IF; END $$;
REVOKE ALL ON FUNCTION north_star_internal.staff_require_decision_authority(uuid,uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION north_star_internal.staff_decision_terms(t uuid,e uuid,p uuid,company uuid,kind text,ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE target uuid; item jsonb; items jsonb := '[]'; BEGIN
  IF t IS DISTINCT FROM nullif(current_setting('north_star.tenant_id',true),'')::uuid
    OR e IS DISTINCT FROM nullif(current_setting('north_star.environment_id',true),'')::uuid
    OR kind IS NULL OR kind NOT IN ('release','customize','retry') OR (company IS NOT NULL) <> (kind='retry')
    OR ids IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 32 OR cardinality(ids)<>(SELECT count(DISTINCT id) FROM unnest(ids) id)
    THEN RAISE EXCEPTION 'decision scope refused'; END IF;
  PERFORM north_star_internal.staff_require_decision_authority(t,e,p,company);
  PERFORM 1 FROM platform.active_release_pointers WHERE tenant_id=t AND environment_id=e FOR SHARE;
  FOREACH target IN ARRAY ids LOOP
    IF kind='retry' THEN
      PERFORM 1 FROM platform.workflow_runs WHERE tenant_id=t AND environment_id=e AND run_id=target FOR UPDATE;
      item := north_star_internal.staff_retry_terms(t,e,target,company);
    ELSE
      item := north_star_internal.staff_release_terms(t,e,target,kind);
      IF item->>'maker'=p::text OR EXISTS (SELECT FROM jsonb_array_elements(NULLIF(item->'patches','null')) patch
          WHERE patch->>'author'=p::text) THEN RAISE EXCEPTION 'decision requires a separate approver'; END IF; END IF;
    IF item IS NULL THEN RAISE EXCEPTION 'decision target unavailable'; END IF;
    item := item || jsonb_build_object('targetDigest',encode(sha256(convert_to(
      jsonb_build_array(1,t,e,company,kind,target,item)::text,'UTF8')),'hex'));
    items := items || jsonb_build_array(item); END LOOP;
  RETURN jsonb_build_object('version',1,'tenant',t,'environment',e,'company',company,'principal',p,'kind',kind,
    'outcome',CASE WHEN kind='retry' THEN 'retry' ELSE 'approve' END,'targets',items); END $$;
REVOKE ALL ON FUNCTION north_star_internal.staff_decision_terms(uuid,uuid,uuid,uuid,text,uuid[]) FROM PUBLIC;

CREATE FUNCTION north_star_internal.staff_decision_session(t uuid,e uuid,identity_key bytea)
RETURNS platform.staff_sessions LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE s platform.staff_sessions; observed timestamptz; actor uuid; BEGIN
  SELECT principal_id INTO actor FROM platform.staff_sessions WHERE tenant_id=t AND environment_id=e AND identity_digest=identity_key;
  PERFORM 1 FROM platform.staff_accounts WHERE tenant_id=t AND environment_id=e AND principal_id=actor AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'decision account unavailable'; END IF;
  SELECT * INTO s FROM platform.staff_sessions WHERE tenant_id=t AND environment_id=e AND principal_id=actor
    AND identity_digest=identity_key AND revoked_at IS NULL FOR UPDATE;
  observed := platform.staff_observed_time();
  IF s.family_id IS NULL OR observed IS NULL OR observed<s.last_activity OR observed>=least(s.absolute_deadline,s.last_activity+interval '30 minutes')
    OR EXISTS (SELECT FROM platform.staff_accounts WHERE tenant_id=t AND environment_id=e AND principal_id=actor AND decisions_after>observed)
    THEN RAISE EXCEPTION 'decision session unavailable'; END IF;
  RETURN s; END $$;
REVOKE ALL ON FUNCTION north_star_internal.staff_decision_session(uuid,uuid,bytea) FROM PUBLIC;

CREATE FUNCTION north_star_internal.staff_review_decision(t uuid,e uuid,identity_key bytea,company uuid,kind text,ids uuid[])
RETURNS TABLE (terms jsonb,digest text) LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE s platform.staff_sessions; BEGIN
  s := north_star_internal.staff_decision_session(t,e,identity_key);
  terms := north_star_internal.staff_decision_terms(t,e,s.principal_id,company,kind,ids);
  digest := encode(sha256(convert_to(terms::text,'UTF8')),'hex');
  RETURN NEXT; END $$;
REVOKE ALL ON FUNCTION north_star_internal.staff_review_decision(uuid,uuid,bytea,uuid,text,uuid[]) FROM PUBLIC;

CREATE FUNCTION platform.staff_review_release(t uuid,e uuid,identity_key bytea,company uuid,ids uuid[])
RETURNS TABLE (terms jsonb,digest text) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM north_star_internal.staff_review_decision(t,e,identity_key,company,'release',ids)
$$;
REVOKE ALL ON FUNCTION platform.staff_review_release(uuid,uuid,bytea,uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_review_release(uuid,uuid,bytea,uuid,uuid[]) TO north_star_identity;

CREATE FUNCTION platform.staff_review_customize(t uuid,e uuid,identity_key bytea,company uuid,ids uuid[])
RETURNS TABLE (terms jsonb,digest text) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM north_star_internal.staff_review_decision(t,e,identity_key,company,'customize',ids)
$$;
REVOKE ALL ON FUNCTION platform.staff_review_customize(uuid,uuid,bytea,uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_review_customize(uuid,uuid,bytea,uuid,uuid[]) TO north_star_identity;

CREATE FUNCTION platform.staff_review_retry(t uuid,e uuid,identity_key bytea,company uuid,ids uuid[])
RETURNS TABLE (terms jsonb,digest text) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM north_star_internal.staff_review_decision(t,e,identity_key,company,'retry',ids)
$$;
REVOKE ALL ON FUNCTION platform.staff_review_retry(uuid,uuid,bytea,uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_review_retry(uuid,uuid,bytea,uuid,uuid[]) TO north_star_identity;

CREATE FUNCTION platform.staff_issue_decision(t uuid,e uuid,identity_key bytea,actor uuid,company uuid,kind text,ids uuid[],reviewed text,ceremony_deadline timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s platform.staff_sessions; facts jsonb; binding bytea; observed timestamptz; issued uuid; BEGIN
  s := north_star_internal.staff_decision_session(t,e,identity_key);
  IF s.principal_id IS DISTINCT FROM actor THEN RAISE EXCEPTION 'decision actor changed'; END IF;
  facts := north_star_internal.staff_decision_terms(t,e,actor,company,kind,ids);
  binding := sha256(convert_to(facts::text,'UTF8'));
  IF encode(binding,'hex') IS DISTINCT FROM reviewed THEN RAISE EXCEPTION 'reviewed decision changed'; END IF;
  observed := platform.staff_observed_time();
  IF ceremony_deadline IS NULL OR observed IS NULL OR observed>=ceremony_deadline THEN RAISE EXCEPTION 'decision ceremony expired'; END IF;
  INSERT INTO platform.staff_decision_proofs(tenant_id,environment_id,company_id,principal_id,family_id,session_generation,
    decision_kind,outcome,target_ids,terms,decision_digest,method,assurance,authenticated_at,expires_at)
    VALUES(t,e,company,actor,s.family_id,sha256(identity_key),kind,facts->>'outcome',ids,facts,binding,s.method,s.assurance,
      observed,least(observed+interval '5 minutes',ceremony_deadline,s.absolute_deadline)) RETURNING proof_id INTO issued;
  RETURN issued; END $$;
REVOKE ALL ON FUNCTION platform.staff_issue_decision(uuid,uuid,bytea,uuid,uuid,text,uuid[],text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_issue_decision(uuid,uuid,bytea,uuid,uuid,text,uuid[],text,timestamptz) TO north_star_identity;

CREATE FUNCTION platform.staff_consume_decision(t uuid,e uuid,company uuid,kind text,evidence uuid,request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE proof platform.staff_decision_proofs; s platform.staff_sessions; identity_key bytea; facts jsonb; observed timestamptz; BEGIN
  SELECT * INTO STRICT proof FROM platform.staff_decision_proofs WHERE proof_id=evidence;
  IF (proof.tenant_id,proof.environment_id,proof.company_id,proof.decision_kind) IS DISTINCT FROM (t,e,company,kind)
    THEN RAISE EXCEPTION 'decision proof scope changed'; END IF;
  SELECT identity_digest INTO identity_key FROM platform.staff_sessions WHERE family_id=proof.family_id;
  s := north_star_internal.staff_decision_session(t,e,identity_key);
  IF s.principal_id IS DISTINCT FROM proof.principal_id OR sha256(s.identity_digest) IS DISTINCT FROM proof.session_generation
    THEN RAISE EXCEPTION 'decision session changed'; END IF;
  facts := north_star_internal.staff_decision_terms(t,e,proof.principal_id,proof.company_id,proof.decision_kind,proof.target_ids);
  observed := platform.staff_observed_time();
  IF observed IS NULL OR observed<proof.authenticated_at OR observed>=proof.expires_at THEN RAISE EXCEPTION 'decision proof expired'; END IF;
  IF sha256(convert_to(facts::text,'UTF8')) IS DISTINCT FROM proof.decision_digest THEN RAISE EXCEPTION 'reviewed decision changed'; END IF;
  -- The primary key serializes even concurrent consumers. Rollback releases the proof.
  INSERT INTO platform.staff_decision_receipts VALUES(t,e,evidence,request,observed);
  RETURN facts; END $$;
REVOKE ALL ON FUNCTION platform.staff_consume_decision(uuid,uuid,uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_consume_decision(uuid,uuid,uuid,text,uuid,uuid) TO north_star_activation_verifier;

-- Choosing pilot mode removes the legacy provisioning writers in this database.
-- This also applies to an existing pilot upgrading from slice 1.
CREATE FUNCTION north_star_internal.staff_restrict_pilot_writers() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  REVOKE INSERT ON platform.release_approvals,platform.release_activation_attempts,platform.release_activation_phase_receipts,
    platform.release_activation_history,platform.release_activation_swap_receipts,platform.release_activation_attempt_outcomes,
    platform.release_activation_outbox,platform.release_activation_verification_receipts,platform.release_activation_reconciliation_starts,
    platform.release_activation_reconciliation_alarms,platform.customization_patches FROM north_star_runtime;
  REVOKE UPDATE (execution_fence,status,reason) ON platform.workflow_runs FROM north_star_workflow_worker;
  REVOKE UPDATE ON platform.active_release_pointers FROM north_star_runtime;
  REVOKE EXECUTE ON FUNCTION platform.workflow_decide_approval(uuid,integer,bigint,text,text) FROM north_star_runtime;
  GRANT INSERT ON platform.release_approvals,platform.release_activation_attempts,platform.release_activation_phase_receipts,
    platform.release_activation_history,platform.release_activation_swap_receipts,platform.release_activation_attempt_outcomes,
    platform.release_activation_outbox,platform.release_activation_verification_receipts,platform.release_activation_reconciliation_starts,
    platform.release_activation_reconciliation_alarms TO north_star_activation_verifier;
  GRANT UPDATE ON platform.active_release_pointers TO north_star_activation_verifier; END $$;
REVOKE ALL ON FUNCTION north_star_internal.staff_restrict_pilot_writers() FROM PUBLIC;
CREATE FUNCTION north_star_internal.staff_pilot_writers_trigger() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  PERFORM north_star_internal.staff_restrict_pilot_writers(); RETURN NEW; END $$;
REVOKE ALL ON FUNCTION north_star_internal.staff_pilot_writers_trigger() FROM PUBLIC;
CREATE TRIGGER staff_pilot_writers AFTER INSERT ON north_star_internal.staff_store_mode
  FOR EACH ROW WHEN (NEW.mode='pilot') EXECUTE FUNCTION north_star_internal.staff_pilot_writers_trigger();
DO $$ BEGIN
  IF EXISTS (SELECT FROM north_star_internal.staff_store_mode WHERE mode='pilot') THEN
    PERFORM north_star_internal.staff_restrict_pilot_writers(); END IF; END $$;

ALTER TABLE platform.release_approvals ADD COLUMN staff_proof_id uuid REFERENCES platform.staff_decision_proofs;
CREATE UNIQUE INDEX staff_approval_per_target ON platform.release_approvals(staff_proof_id,preparation_id) WHERE staff_proof_id IS NOT NULL;
CREATE FUNCTION north_star_internal.staff_bind_approval() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  IF EXISTS (SELECT FROM north_star_internal.staff_store_mode WHERE mode='pilot') THEN
    SELECT proof.proof_id INTO STRICT NEW.staff_proof_id
    FROM platform.staff_decision_proofs proof JOIN platform.staff_decision_receipts receipt USING (tenant_id,environment_id,proof_id)
    CROSS JOIN LATERAL jsonb_array_elements(proof.terms->'targets') item
    WHERE proof.proof_id=NEW.staff_proof_id AND (proof.tenant_id,proof.environment_id)=(NEW.tenant_id,NEW.environment_id)
      AND proof.decision_kind IN ('release','customize') AND proof.outcome='approve' AND proof.company_id IS NULL
      AND proof.principal_id=NEW.approving_human_id AND proof.principal_id=NEW.issuing_actor_id
      AND item->>'preparation'=NEW.preparation_id::text AND item->>'candidate'=NEW.target_release_id::text
      AND item->>'root'=encode(NEW.target_manifest_root,'hex') AND item->>'verification'=NEW.verification_evidence_id::text
      AND item->>'diffDigest'=encode(NEW.canonical_diff_digest,'hex') AND item->>'fence'=NEW.expected_fence::text
      AND item->>'upgrade' IS NOT DISTINCT FROM NEW.customization_upgrade_id::text
      AND NEW.source_decision_id=coalesce(NEW.customization_upgrade_id,proof.proof_id)
      AND nullif(item->'workflowDefinitions','null'::jsonb) IS NOT DISTINCT FROM NEW.workflow_definition_bindings
      AND receipt.xmin=pg_current_xact_id()::xid;
  ELSE NEW.staff_proof_id := NULL; END IF;
  RETURN NEW; END $$;
REVOKE ALL ON FUNCTION north_star_internal.staff_bind_approval() FROM PUBLIC;
CREATE TRIGGER zz_staff_bind_approval BEFORE INSERT ON platform.release_approvals FOR EACH ROW EXECUTE FUNCTION north_star_internal.staff_bind_approval();

CREATE FUNCTION platform.staff_activation_approved(t uuid,e uuid,approval uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS (SELECT FROM platform.release_approvals a JOIN platform.staff_decision_receipts d
    ON (d.tenant_id,d.environment_id,d.proof_id)=(a.tenant_id,a.environment_id,a.staff_proof_id)
    WHERE (a.tenant_id,a.environment_id,a.approval_id)=(t,e,approval)
    AND t=nullif(current_setting('north_star.tenant_id',true),'')::uuid AND e=nullif(current_setting('north_star.environment_id',true),'')::uuid)
$$;
REVOKE ALL ON FUNCTION platform.staff_activation_approved(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_activation_approved(uuid,uuid,uuid) TO north_star_runtime;

-- The kernel holds the release authority epoch and verifies the approver's live
-- eligibility at CAS. Serialize the separate staff membership check there too.
CREATE FUNCTION platform.staff_activation_member(t uuid,e uuid,actor uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  IF t IS DISTINCT FROM nullif(current_setting('north_star.tenant_id',true),'')::uuid
    OR e IS DISTINCT FROM nullif(current_setting('north_star.environment_id',true),'')::uuid THEN RETURN false; END IF;
  PERFORM 1 FROM platform.staff_accounts WHERE tenant_id=t AND environment_id=e AND principal_id=actor
    AND status='active' AND (decisions_after IS NULL OR decisions_after<=platform.staff_observed_time()) FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM platform.current_policy_epochs WHERE tenant_id=t AND environment_id=e FOR SHARE;
  RETURN EXISTS (SELECT FROM platform.current_policy_memberships m JOIN platform.current_policy_roles r USING(tenant_id,environment_id,role_id)
    WHERE m.tenant_id=t AND m.environment_id=e AND m.principal_id=actor AND m.legal_entity_id IS NULL
    AND m.revoked_at IS NULL AND r.revoked_at IS NULL); END $$;
REVOKE ALL ON FUNCTION platform.staff_activation_member(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_activation_member(uuid,uuid,uuid) TO north_star_runtime;

ALTER TABLE platform.release_activation_verification_receipts ADD COLUMN verifier_login name;
CREATE FUNCTION north_star_internal.staff_verification_provenance() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  NEW.verifier_login := session_user; RETURN NEW; END $$;
REVOKE ALL ON FUNCTION north_star_internal.staff_verification_provenance() FROM PUBLIC;
CREATE TRIGGER staff_verifier_login BEFORE INSERT ON platform.release_activation_verification_receipts
  FOR EACH ROW EXECUTE FUNCTION north_star_internal.staff_verification_provenance();

-- Pending work discovery only returns identifiers. Authority is resolved again on consumption.
CREATE FUNCTION platform.staff_pending_decisions(t uuid,e uuid)
RETURNS TABLE (proof_id uuid, decision_kind text,company_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT p.proof_id,p.decision_kind,p.company_id FROM platform.staff_decision_proofs p
  WHERE p.tenant_id=t AND p.environment_id=e AND t=nullif(current_setting('north_star.tenant_id',true),'')::uuid
    AND e=nullif(current_setting('north_star.environment_id',true),'')::uuid AND clock_timestamp()<p.expires_at
    AND NOT EXISTS (SELECT FROM platform.staff_decision_receipts d WHERE d.proof_id=p.proof_id)
  ORDER BY p.authenticated_at,p.proof_id LIMIT 100
$$;
REVOKE ALL ON FUNCTION platform.staff_pending_decisions(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_pending_decisions(uuid,uuid) TO north_star_activation_verifier;

-- The proposal's payload uses the existing patch table's checks and references.
-- The database supplies its scope, author and time from the verified ERP session.
CREATE FUNCTION platform.staff_propose_customization(t uuid,e uuid,handle bytea,proposal jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; patch platform.customization_patches; BEGIN
  actor := platform.staff_session_principal(t,e,handle,true,false);
  IF actor IS NULL OR t IS DISTINCT FROM nullif(current_setting('north_star.tenant_id',true),'')::uuid
    OR e IS DISTINCT FROM nullif(current_setting('north_star.environment_id',true),'')::uuid
    THEN RAISE EXCEPTION 'customization proposal refused'; END IF;
  PERFORM set_config('north_star.principal_id',actor::text,true);
  PERFORM platform.lock_current_policy_epoch(t,e);
  IF NOT EXISTS (SELECT FROM platform.customization_permission_roles()) THEN RAISE EXCEPTION 'customization author grant required'; END IF;
  patch := jsonb_populate_record(NULL::platform.customization_patches,proposal);
  patch.patch_id := gen_random_uuid(); patch.tenant_id := t; patch.environment_id := e;
  patch.authored_by := actor; patch.created_at := platform.staff_observed_time();
  INSERT INTO platform.customization_patches SELECT patch.*;
  RETURN patch.patch_id; END $$;
REVOKE ALL ON FUNCTION platform.staff_propose_customization(uuid,uuid,bytea,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_propose_customization(uuid,uuid,bytea,jsonb) TO north_star_runtime;

-- Immutable per-run evidence for the Retry writer. Scope is checked at read.
CREATE FUNCTION platform.staff_retry_decision_record(t uuid,e uuid,requested uuid)
RETURNS TABLE (run_id uuid,fence bigint,previous_fence bigint,company_id uuid,decided_by uuid,request_id uuid,
  decided_at timestamptz,proof_id uuid,decision_digest bytea,target_digest text,method text,assurance text,authenticated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT (item->>'run')::uuid,(item->>'fence')::bigint,(item->>'previousFence')::bigint,p.company_id,p.principal_id,
    d.request_id,d.decided_at,p.proof_id,p.decision_digest,item->>'targetDigest',p.method,p.assurance,p.authenticated_at
  FROM platform.staff_decision_receipts d JOIN platform.staff_decision_proofs p USING(tenant_id,environment_id,proof_id)
  CROSS JOIN LATERAL jsonb_array_elements(p.terms->'targets') item
  WHERE (p.tenant_id,p.environment_id,p.proof_id,p.decision_kind)=(t,e,requested,'retry')
    AND t=nullif(current_setting('north_star.tenant_id',true),'')::uuid AND e=nullif(current_setting('north_star.environment_id',true),'')::uuid
$$;
REVOKE ALL ON FUNCTION platform.staff_retry_decision_record(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_retry_decision_record(uuid,uuid,uuid) TO north_star_activation_verifier;

CREATE FUNCTION platform.staff_review_choices(t uuid,e uuid,identity_key bytea)
RETURNS TABLE (kind text,target uuid,company uuid,label text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
DECLARE s platform.staff_sessions; choice record; facts jsonb; BEGIN
  s := north_star_internal.staff_decision_session(t,e,identity_key);
  FOR choice IN
    SELECT * FROM (
      SELECT k.kind,p.preparation_id AS id,NULL::uuid AS company,p.created_at
      FROM platform.release_activation_preparations p CROSS JOIN (VALUES('release'),('customize')) k(kind)
      JOIN platform.active_release_pointers a ON a.tenant_id=t AND a.environment_id=e
      WHERE p.tenant_id=t AND p.environment_id=e AND p.expected_fence=a.fence AND p.reviewed_diff IS NOT NULL
      UNION ALL
      SELECT 'retry',r.run_id,i.legal_entity_id,r.created_at FROM platform.workflow_runs r JOIN platform.workflow_instances i
        USING(tenant_id,environment_id,instance_id,workflow_id) WHERE r.tenant_id=t AND r.environment_id=e AND r.status='SUSPENDED'
    ) candidates ORDER BY candidates.created_at DESC,candidates.id,candidates.kind LIMIT 64
  LOOP BEGIN
    facts := north_star_internal.staff_decision_terms(t,e,s.principal_id,choice.company,choice.kind,ARRAY[choice.id]);
    kind := choice.kind; target := choice.id; company := choice.company;
    label := left(coalesce(facts #>> '{targets,0,diff}',facts #>> '{targets,0,workflow}'),160);
    RETURN NEXT;
  EXCEPTION WHEN raise_exception THEN NULL; END; END LOOP; END $$;
REVOKE ALL ON FUNCTION platform.staff_review_choices(uuid,uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_review_choices(uuid,uuid,bytea) TO north_star_identity;

CREATE FUNCTION platform.staff_read_decision_receipt(t uuid,e uuid,identity_key bytea,evidence uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE s platform.staff_sessions; p platform.staff_decision_proofs; d platform.staff_decision_receipts; BEGIN
  s := north_star_internal.staff_decision_session(t,e,identity_key);
  SELECT * INTO STRICT p FROM platform.staff_decision_proofs WHERE proof_id=evidence AND
    (tenant_id,environment_id,principal_id)=(t,e,s.principal_id);
  PERFORM north_star_internal.staff_require_decision_authority(t,e,s.principal_id,p.company_id);
  SELECT * INTO d FROM platform.staff_decision_receipts WHERE proof_id=evidence;
  RETURN jsonb_build_object('decision',p.decision_kind,'reference',p.proof_id,'company',p.company_id,'method',p.method,'assurance',p.assurance,
    'authenticatedAt',p.authenticated_at,'decidedAt',d.decided_at,'expired',coalesce(platform.staff_observed_time()>=p.expires_at,true),'request',d.request_id,'attempts',coalesce((
      SELECT jsonb_agg(a.activation_attempt_id ORDER BY array_position(p.target_ids,a.preparation_id))
        FROM platform.release_approvals a WHERE (a.tenant_id,a.environment_id,a.staff_proof_id)=(t,e,evidence)),'[]'::jsonb)); END $$;
REVOKE ALL ON FUNCTION platform.staff_read_decision_receipt(uuid,uuid,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_read_decision_receipt(uuid,uuid,bytea,uuid) TO north_star_identity;

-- WORKFLOW-1 can join inside its remedy transaction. A new writer grant alone
-- cannot resume a suspended pilot run or change its admitted execution fence.
CREATE FUNCTION north_star_internal.staff_guard_workflow_retry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  IF NOT EXISTS (SELECT FROM north_star_internal.staff_store_mode WHERE mode='pilot') THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT FROM platform.staff_decision_receipts d JOIN platform.staff_decision_proofs p USING (tenant_id,environment_id,proof_id)
    CROSS JOIN LATERAL jsonb_array_elements(p.terms->'targets') item
    WHERE d.xmin=pg_current_xact_id()::xid AND p.decision_kind='retry' AND d.tenant_id=OLD.tenant_id AND d.environment_id=OLD.environment_id
      AND p.principal_id=nullif(current_setting('north_star.principal_id',true),'')::uuid
      AND d.request_id=nullif(current_setting('north_star.request_id',true),'')::uuid
      AND item->>'run'=OLD.run_id::text AND item->>'release'=OLD.release_id::text AND item->>'root'=OLD.release_root
      AND item->>'previousFence'=OLD.execution_fence::text AND item->>'fence'=NEW.execution_fence::text
      AND OLD.status='SUSPENDED' AND NEW.status='RUNNABLE' AND NEW.execution_fence>OLD.execution_fence)
    THEN RAISE EXCEPTION 'workflow Retry requires its current staff decision'; END IF;
  RETURN NEW; END $$;
REVOKE ALL ON FUNCTION north_star_internal.staff_guard_workflow_retry() FROM PUBLIC;
CREATE TRIGGER staff_workflow_retry BEFORE UPDATE OF execution_fence,status ON platform.workflow_runs
  FOR EACH ROW WHEN (OLD.execution_fence<>NEW.execution_fence OR (OLD.status='SUSPENDED' AND NEW.status='RUNNABLE'))
  EXECUTE FUNCTION north_star_internal.staff_guard_workflow_retry();
