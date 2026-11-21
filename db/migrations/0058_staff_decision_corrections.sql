CREATE OR REPLACE FUNCTION platform.staff_consume_decision(t uuid,e uuid,company uuid,kind text,evidence uuid,request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE proof platform.staff_decision_proofs; s platform.staff_sessions; identity_key bytea; facts jsonb; observed timestamptz; target jsonb; journal_count integer; receipt jsonb; BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'staff decision consumption requires READ COMMITTED'; END IF;
  SELECT * INTO STRICT proof FROM platform.staff_decision_proofs WHERE proof_id=evidence FOR UPDATE;
  IF (proof.tenant_id,proof.environment_id,proof.company_id,proof.decision_kind) IS DISTINCT FROM (t,e,company,kind)
    OR t IS DISTINCT FROM nullif(current_setting('north_star.tenant_id',true),'')::uuid
    OR e IS DISTINCT FROM nullif(current_setting('north_star.environment_id',true),'')::uuid
    THEN RAISE EXCEPTION 'decision proof scope changed'; END IF;
  SELECT identity_digest INTO identity_key FROM platform.staff_sessions WHERE family_id=proof.family_id;
  s := north_star_internal.staff_decision_session(t,e,identity_key);
  IF s.principal_id IS DISTINCT FROM proof.principal_id OR sha256(s.identity_digest) IS DISTINCT FROM proof.session_generation
    THEN RAISE EXCEPTION 'decision session changed'; END IF;
  -- Serialize consumers on the immutable proof. A committed decision is a read
  -- of its original receipt, even after the reviewed target ceases to be pending.
  SELECT jsonb_build_object('receipt',jsonb_build_object(
    'reference',d.proof_id,'request',d.request_id,'decidedAt',d.decided_at,'attempts',coalesce((
      SELECT jsonb_agg(a.activation_attempt_id ORDER BY array_position(proof.target_ids,a.preparation_id))
      FROM platform.release_approvals a WHERE (a.tenant_id,a.environment_id,a.staff_proof_id)=(t,e,evidence)
    ),'[]'::jsonb))) INTO receipt
  FROM platform.staff_decision_receipts d
  WHERE (d.tenant_id,d.environment_id,d.proof_id)=(t,e,evidence) AND d.xmin<>pg_current_xact_id()::xid;
  IF FOUND THEN
    PERFORM north_star_internal.staff_require_decision_authority(t,e,proof.principal_id,company);
    RETURN receipt; END IF;
  observed := platform.staff_observed_time();
  IF observed IS NULL OR observed<proof.authenticated_at OR observed>=proof.expires_at THEN RAISE EXCEPTION 'decision proof expired'; END IF;
  -- Claim the proof before reading its pending target. Every subsequent refusal rolls this row back.
  INSERT INTO platform.staff_decision_receipts VALUES(t,e,evidence,request,observed);
  facts := north_star_internal.staff_decision_terms(t,e,proof.principal_id,proof.company_id,proof.decision_kind,proof.target_ids);
  IF sha256(convert_to(facts::text,'UTF8')) IS DISTINCT FROM proof.decision_digest THEN RAISE EXCEPTION 'reviewed decision changed'; END IF;
  IF kind='retry' THEN
    PERFORM set_config('north_star.principal_id',proof.principal_id::text,true);
    FOR target IN SELECT value FROM jsonb_array_elements(facts->'targets') LOOP
      SELECT count(*)::integer INTO journal_count FROM jsonb_array_elements(target->'journal') AS entry(value)
        WHERE entry.value->>1 IN ('REQUEST','RESULT');
      IF NOT platform.workflow_apply_remedy((target->>'run')::uuid,(target->>'previousFence')::bigint,
        (target->>'fence')::bigint,'retry',journal_count) THEN RAISE EXCEPTION 'reviewed workflow Retry is unavailable'; END IF; END LOOP; END IF;
  RETURN facts; END $$;

CREATE OR REPLACE FUNCTION north_star_internal.staff_guard_workflow_retry() RETURNS trigger
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
    THEN RAISE EXCEPTION 'workflow run advance requires its current staff Retry decision'; END IF;
  RETURN NEW; END $$;
