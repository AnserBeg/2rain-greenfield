-- Scheduled appointments and unstarted tracked confirmations close only on a committed transition.
ALTER TABLE platform.booking_commitments DROP CONSTRAINT booking_commitments_state_check,
  ADD CONSTRAINT booking_commitments_state_check CHECK (state IN ('hold','confirmed','cancelled','completed','noShow'));

CREATE INDEX booking_due_confirmations ON platform.booking_commitments (resource_key,upper(agreed_interval))
  WHERE state='confirmed';

-- All three deadline actions use the system receipt and outbox namespace.
ALTER TABLE platform.booking_receipts DROP CONSTRAINT booking_receipts_pkey, DROP COLUMN system_expiry;
ALTER TABLE platform.booking_receipts ADD COLUMN system_expiry boolean GENERATED ALWAYS AS
  (operation_id IN ('expireHold','completeScheduled','markNoShow')) STORED,
  ADD PRIMARY KEY (tenant_id,environment_id,system_expiry,request_key);

CREATE OR REPLACE FUNCTION north_star_internal.booking_evidence(
  t uuid,e uuid,r uuid,actor jsonb,action text,key uuid,input jsonb,
  receipt uuid,changed_record uuid,rev integer,before_value jsonb,after_value jsonb,
  at_time timestamptz,event_type text,event_payload jsonb,result jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  release_hash text;
  principal uuid := (actor->'executionPrincipal'->>'principalId')::uuid;
  principal_kind text := actor->'executionPrincipal'->>'kind';
  change_id uuid := gen_random_uuid();
  event_id uuid := gen_random_uuid();
  outbox_id uuid := gen_random_uuid();
  classified jsonb;
  receipt_result jsonb;
  field_changes jsonb;
  channel text := actor->>'channel';
  record_type text := CASE WHEN event_type='booking.changed' THEN 'northstar.booking:entity.booking' ELSE 'northstar.booking:entity.capacity' END; BEGIN
  SELECT content_hash INTO STRICT release_hash FROM platform.tenant_releases WHERE (tenant_id,environment_id,release_id)=(t,e,r);
  SELECT jsonb_object_agg(k,jsonb_build_object('classification','INTERNAL','representation','VALUE','value',v))
    INTO classified FROM jsonb_each(event_payload) fields(k,v);
  field_changes := jsonb_build_array(jsonb_build_object('fieldId','northstar.booking:field.revision',
    'oldState',CASE WHEN before_value IS NULL THEN jsonb_build_object('state','ABSENT') ELSE
      jsonb_build_object('state','VALUE','representation','VALUE','value',rev-1) END,
    'classification','INTERNAL','newState',jsonb_build_object('state','VALUE','representation','VALUE','value',rev)));
  INSERT INTO platform.trust_action_invocations
    (tenant_id,environment_id,invocation_id,invocation_version,causation_id,request_id,action_id,channel,outcome,correlation_id,release_id,
     release_content_hash,execution_principal_kind,execution_principal_id,subject_principal_kind,subject_principal_id,
     initiating_human_id,approving_human_id,delegation_id,delegating_principal_kind,delegating_principal_id,
     delegated_to_principal_kind,delegated_to_principal_id,policy_evidence_version,policy_decision,
     policy_version,policy_evaluator_version,policy_inputs,metadata,change_document_id,domain_event_id,outbox_id,recorded_at)
    VALUES (t,e,receipt,'northstar.action-invocation/v1',(actor->>'cause')::uuid,(actor->>'requestId')::uuid,action,channel,'SUCCEEDED',key,r,
     release_hash,principal_kind,principal,actor->'subject'->>'kind',(actor->'subject'->>'principalId')::uuid,
     (actor->>'initiatingHumanId')::uuid,(actor->>'approvingHumanId')::uuid,(actor->'delegation'->>'delegationId')::uuid,
     actor->'delegation'->'delegatingPrincipal'->>'kind',(actor->'delegation'->'delegatingPrincipal'->>'principalId')::uuid,
     actor->'delegation'->'delegatedTo'->>'kind',(actor->'delegation'->'delegatedTo'->>'principalId')::uuid,
     'northstar.policy-decision-evidence/v1','ALLOW',actor->>'policyVersion','northstar.booking/v1','{}','{}',change_id,event_id,outbox_id,at_time);
  INSERT INTO platform.trust_business_change_documents
    (tenant_id,environment_id,change_document_id,document_version,invocation_id,request_id,action_id,correlation_id,
     release_id,release_content_hash,record_type,record_id,revision,changes,execution_principal_kind,execution_principal_id,
     subject_principal_kind,subject_principal_id,initiating_human_id,approving_human_id,delegation_id,delegating_principal_kind,
     delegating_principal_id,delegated_to_principal_kind,delegated_to_principal_id,domain_event_id,outbox_id,recorded_at)
    SELECT t,e,change_id,'northstar.business-change-document/v1',receipt,i.request_id,action,key,r,release_hash,
     record_type,changed_record,rev,field_changes,i.execution_principal_kind,i.execution_principal_id,i.subject_principal_kind,
     i.subject_principal_id,i.initiating_human_id,i.approving_human_id,i.delegation_id,i.delegating_principal_kind,
     i.delegating_principal_id,i.delegated_to_principal_kind,i.delegated_to_principal_id,i.domain_event_id,i.outbox_id,at_time
      FROM platform.trust_action_invocations i WHERE i.tenant_id=t AND i.environment_id=e AND i.invocation_id=receipt;
  INSERT INTO platform.trust_domain_events
    (tenant_id,environment_id,domain_event_id,domain_event_version,invocation_id,change_document_id,request_id,
     action_id,correlation_id,release_id,release_content_hash,event_type,event_schema_version,payload,outbox_id,occurred_at)
    VALUES (t,e,event_id,'northstar.trust-domain-event/v1',receipt,change_id,(actor->>'requestId')::uuid,
     action,key,r,release_hash,event_type,event_type||'/v1',classified,outbox_id,at_time);
  INSERT INTO platform.trust_outbox
    (tenant_id,environment_id,outbox_id,outbox_version,invocation_id,change_document_id,domain_event_id,request_id,
     action_id,correlation_id,release_id,release_content_hash,event_type,event_schema_version,deduplication_key,recorded_at)
    VALUES (t,e,outbox_id,'northstar.trust-outbox/v1',receipt,change_id,event_id,(actor->>'requestId')::uuid,
     action,key,r,release_hash,event_type,event_type||'/v1',CASE WHEN action IN ('expireHold','completeScheduled','markNoShow') THEN 'booking/system/' ELSE 'booking/command/' END||key,at_time);
  receipt_result := result || jsonb_build_object('invocationId',receipt,'changeDocumentId',change_id,'domainEventId',event_id,'outboxId',outbox_id);
  INSERT INTO platform.booking_receipts VALUES (t,e,key,principal,action,input,r,receipt,receipt_result);
  INSERT INTO platform.semantic_operation_receipts
    (tenant_id,environment_id,principal_id,release_id,release_content_hash,action_id,idempotency_key,input_digest,mutation_result,
     invocation_id,correlation_id,change_document_id,domain_event_id,outbox_id,recorded_at)
    VALUES (t,e,principal,r,release_hash,action,key,encode(sha256(convert_to(input::text,'UTF8')),'hex'),receipt_result,
      receipt,key,change_id,event_id,outbox_id,at_time);
  -- Read the links and public payload back after the inserts, including writes
  -- performed by triggers. A suppressed row must roll back the allocation.
  IF NOT EXISTS (
    SELECT FROM platform.booking_receipts b
    JOIN platform.trust_action_invocations i ON (i.tenant_id,i.environment_id,i.invocation_id)=(b.tenant_id,b.environment_id,b.receipt_id)
    JOIN platform.trust_business_change_documents c ON (c.tenant_id,c.environment_id,c.invocation_id,c.change_document_id)=(t,e,receipt,i.change_document_id)
    JOIN platform.trust_domain_events v ON (v.tenant_id,v.environment_id,v.invocation_id,v.change_document_id,v.domain_event_id)=(t,e,receipt,c.change_document_id,i.domain_event_id)
    JOIN platform.trust_outbox o ON (o.tenant_id,o.environment_id,o.invocation_id,o.change_document_id,o.domain_event_id,o.outbox_id)=(t,e,receipt,c.change_document_id,v.domain_event_id,i.outbox_id)
    JOIN platform.semantic_operation_receipts sr ON (sr.tenant_id,sr.environment_id,sr.invocation_id,sr.change_document_id,sr.domain_event_id,sr.outbox_id)=(t,e,receipt,c.change_document_id,v.domain_event_id,o.outbox_id)
    WHERE b.system_expiry=(action IN ('expireHold','completeScheduled','markNoShow')) AND (b.tenant_id,b.environment_id,b.request_key,b.actor_id,b.result)=(t,e,key,principal,receipt_result)
      AND (v.event_type,v.event_schema_version,v.payload)=(booking_evidence.event_type,booking_evidence.event_type||'/v1',classified)
      AND (o.event_type,o.event_schema_version)=(v.event_type,v.event_schema_version)
      AND sr.mutation_result=receipt_result
  ) THEN RAISE EXCEPTION 'booking.evidenceMismatch'; END IF;
  RETURN receipt_result; END $$;

-- Call with the diary and owner cursor locked. Recheck the condition on the
-- exact stored revision: a reschedule can change either the end or the state.
CREATE FUNCTION north_star_internal.booking_finalize_due(previous platform.booking_commitments,decision timestamptz)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  fact platform.booking_commitments;
  source platform.booking_receipts;
  effective timestamptz := upper(previous.agreed_interval);
  action text := CASE previous.fulfilment_mode WHEN 'scheduled' THEN 'completeScheduled' ELSE 'markNoShow' END;
  request_key uuid := md5('booking/'||action||'/'||previous.booking_id||'/'||previous.revision)::uuid;
  actor jsonb; BEGIN
  IF previous.state='hold' THEN
    IF previous.deadline<=decision THEN PERFORM north_star_internal.booking_expire_one(previous,decision); END IF;
    RETURN; END IF;
  UPDATE platform.booking_commitments SET
    state=CASE action WHEN 'completeScheduled' THEN 'completed' ELSE 'noShow' END,
    revision=revision+1
    WHERE (tenant_id,environment_id,booking_id,revision,state,fulfilment_mode) =
      (previous.tenant_id,previous.environment_id,previous.booking_id,previous.revision,'confirmed',previous.fulfilment_mode)
      AND upper(agreed_interval)=effective AND effective<=decision
    RETURNING * INTO fact;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT b.* INTO STRICT source FROM platform.booking_history h
    JOIN platform.booking_receipts b USING (tenant_id,environment_id,receipt_id)
    WHERE (h.tenant_id,h.environment_id,h.booking_id,h.revision) =
      (previous.tenant_id,previous.environment_id,previous.booking_id,previous.revision);
  actor := jsonb_build_object('executionPrincipal',jsonb_build_object('kind','SYSTEM',
    'principalId',md5('northstar.booking/timer/'||source.tenant_id||'/'||source.environment_id)::uuid),
    'requestId',request_key,'cause',source.receipt_id,'channel','SYSTEM','policyVersion','acceptedBookingEnd');
  PERFORM north_star_internal.booking_record_change(previous,fact,source.release_id,actor,action,request_key,
    jsonb_build_object('bookingId',fact.booking_id,'revision',previous.revision),action,effective,decision); END $$;
REVOKE ALL ON FUNCTION north_star_internal.booking_finalize_due(platform.booking_commitments,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION north_star_internal.booking_expire(diary uuid,decision timestamptz)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE due platform.booking_commitments; BEGIN
  FOR due IN SELECT * FROM platform.booking_commitments WHERE resource_key=diary AND
    ((state='hold' AND deadline<=decision) OR (state='confirmed' AND upper(agreed_interval)<=decision))
    ORDER BY owner_key,booking_id LOOP
    PERFORM north_star_internal.booking_finalize_due(due,decision); END LOOP; END $$;

CREATE OR REPLACE FUNCTION north_star_internal.booking_sweep_due(max_resources integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  diary platform.booking_resources; decision timestamptz; due platform.booking_commitments;
  processed integer := 0; BEGIN
  PERFORM north_star_internal.booking_require_isolation();
  IF max_resources IS NULL OR max_resources NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'booking.invalidLimit'; END IF;
  FOR diary IN SELECT d.* FROM platform.booking_resources d WHERE EXISTS
    (SELECT FROM platform.booking_commitments b WHERE b.resource_key=d.resource_key AND
      ((b.state='hold' AND b.deadline<=greatest(d.decision_floor,north_star_internal.booking_now())) OR
       (b.state='confirmed' AND upper(b.agreed_interval)<=greatest(d.decision_floor,north_star_internal.booking_now()))))
    ORDER BY d.resource_key LIMIT max_resources FOR UPDATE SKIP LOCKED LOOP
    decision := greatest(diary.decision_floor,north_star_internal.booking_now());
    FOR due IN SELECT * FROM platform.booking_commitments WHERE resource_key=diary.resource_key AND
      ((state='hold' AND deadline<=decision) OR (state='confirmed' AND upper(agreed_interval)<=decision))
      ORDER BY owner_key,booking_id LOOP BEGIN
        PERFORM FROM platform.booking_owner_cursors WHERE owner_key=due.owner_key FOR UPDATE NOWAIT;
        PERFORM north_star_internal.booking_finalize_due(due,decision);
      EXCEPTION WHEN lock_not_available THEN CONTINUE;
        WHEN unique_violation THEN RAISE WARNING 'booking.timerConflict for booking %',due.booking_id; END; END LOOP;
    UPDATE platform.booking_resources SET decision_floor=decision WHERE resource_key=diary.resource_key;
    processed := processed+1; END LOOP;
  RETURN processed; END $$;

COMMENT ON FUNCTION north_star_internal.require_record_archivable(text,uuid) IS
  'After archive authorization, checks allocation integrity. The module runtime role can directly learn whether an active allocation protects a given record in its tenant and environment.';

CREATE OR REPLACE FUNCTION north_star_internal.booking_apply(r uuid,expected_fence bigint,action text,key uuid,input jsonb,actor jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET timezone='UTC' AS $$
DECLARE
  t uuid := north_star_internal.trusted_tenant_id();
  e uuid := north_star_internal.trusted_environment_id();
  principal uuid := nullif(current_setting('north_star.principal_id',true),'')::uuid;
  op jsonb; released_binding jsonb; storage jsonb; command text; calendar jsonb;
  target uuid := (input->>'resourceId')::uuid; owner_id uuid := (input->>'recordId')::uuid;
  target_company uuid; owner_company uuid; diary platform.booking_resources; owner_row platform.booking_owner_cursors;
  prior_receipt platform.booking_receipts; prior_fact platform.booking_commitments; fact platform.booking_commitments;
  decision timestamptz; amount numeric; term record; capacity platform.booking_pool_capacity;
  receipt uuid := gen_random_uuid(); result jsonb; expected_rev integer := (input->>'expectedRevision')::integer;
  latest integer; policy_version text; owner_table text; owner_revision bigint; approval platform.booking_approval_grants; BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'booking.requiresReadCommitted'; END IF;
  IF principal IS NULL OR (actor->'executionPrincipal'->>'principalId')::uuid IS DISTINCT FROM principal
    OR (actor->>'requestId')::uuid IS DISTINCT FROM nullif(current_setting('north_star.request_id',true),'')::uuid
    OR key IS NULL THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END IF;
  PERFORM 1 FROM platform.active_release_pointers WHERE (tenant_id,environment_id,release_id,fence)=(t,e,r,expected_fence) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking.staleRelease'; END IF;
  SELECT value INTO STRICT op FROM jsonb_array_elements(north_star_internal.booking_projection(t,e,r,'operationCatalogPayload')->'operations')
    WHERE value->>'operationId'=action AND value->>'lifecycle'='active' AND
      value->'effect'->'capability'->>'targetId'='northstar.booking:capability.commitments';
  released_binding := op->'booking'; command := released_binding->>'operation';
  IF released_binding->>'bindingVersion' IS DISTINCT FROM 'booking.commitment/v1'
    OR released_binding->>'kind' IS NULL OR released_binding->>'kind' NOT IN ('pool','unit')
    OR command IS NULL OR command NOT IN ('hold','confirm','cancel','changeInterval','setCapacity')
    OR (command <> 'hold' AND op->>'confirmation' IS DISTINCT FROM 'humanRequired')
    THEN RAISE EXCEPTION 'booking.unsupportedBinding'; END IF;
  storage := north_star_internal.booking_projection(t,e,r,'storageTargetPayload');
  -- Discovery reads identities only. Recheck the endpoints, including parents, under locks below.
  IF command NOT IN ('hold','setCapacity') THEN
    SELECT d.record_id INTO STRICT target FROM platform.booking_commitments f
      JOIN platform.booking_resources d USING (tenant_id,environment_id,resource_key)
      JOIN platform.booking_owner_cursors o USING (tenant_id,environment_id,owner_key)
      WHERE (f.tenant_id,f.environment_id,f.booking_id)=(t,e,(input->>'bookingId')::uuid)
        AND o.record_id=owner_id AND o.entity_id=released_binding->>'ownerEntity' AND f.slot_id=released_binding->>'slotId'
        AND d.entity_id=released_binding->>'resourceEntity'; END IF;
  -- The initial row insert contends on its natural key. Once a diary exists, every writer takes it first.
  SELECT * INTO diary FROM platform.booking_resources WHERE (tenant_id,environment_id,entity_id,record_id)=(t,e,released_binding->>'resourceEntity',target) FOR UPDATE;
  IF NOT FOUND THEN
    target_company := north_star_internal.booking_endpoint(t,e,storage,released_binding->>'resourceEntity',target,false);
    INSERT INTO platform.booking_resources (tenant_id,environment_id,entity_id,record_id,company_id,kind,unit,quantity_scale)
      VALUES (t,e,released_binding->>'resourceEntity',target,target_company,released_binding->>'kind',released_binding->>'unit',(released_binding->>'scale')::integer)
      ON CONFLICT (tenant_id,environment_id,entity_id,company_id,record_id) DO NOTHING;
    SELECT * INTO STRICT diary FROM platform.booking_resources WHERE (tenant_id,environment_id,entity_id,record_id)=(t,e,released_binding->>'resourceEntity',target) FOR UPDATE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(t::text||e::text||key::text,0));
  PERFORM north_star_internal.booking_lock_endpoints(t,e,storage,released_binding->>'ownerEntity',owner_id,released_binding->>'resourceEntity',target);
  owner_company := north_star_internal.booking_endpoint(t,e,storage,released_binding->>'ownerEntity',owner_id,false);
  target_company := north_star_internal.booking_endpoint(t,e,storage,released_binding->>'resourceEntity',target,false);
  IF (diary.kind,diary.unit,diary.quantity_scale) IS DISTINCT FROM (released_binding->>'kind',released_binding->>'unit',(released_binding->>'scale')::integer)
    OR target_company IS DISTINCT FROM diary.company_id OR (target_company IS NOT NULL AND target_company IS DISTINCT FROM owner_company)
    THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END IF;
  policy_version := platform.lock_current_policy_epoch(t,e)::text;
  IF actor->>'policyVersion' IS DISTINCT FROM 'northstar.current-policy/'||policy_version THEN RAISE EXCEPTION 'booking.stalePolicy'; END IF;
  PERFORM north_star_internal.booking_require_permission(t,e,principal,owner_company,op->>'permissionId',released_binding->>'ownerEntity',coalesce(op->'excludedRoleKeys','[]'));
  PERFORM north_star_internal.booking_require_permission(t,e,principal,owner_company,released_binding->>'ownerReadPermission',released_binding->>'ownerEntity');
  PERFORM north_star_internal.booking_require_permission(t,e,principal,target_company,released_binding->>'resourceReadPermission',diary.entity_id);
  IF command='setCapacity' AND (owner_id<>target OR released_binding->>'ownerEntity'<>diary.entity_id OR diary.kind<>'pool') THEN RAISE EXCEPTION 'booking.invalidCapacity'; END IF;
  IF op->>'confirmation'='humanRequired' OR actor->>'channel'='WORKFLOW' THEN
    SELECT g.* INTO approval FROM platform.booking_approval_grants g
      WHERE g.grant_id=(actor->>'approvalGrantId')::uuid
        AND (g.tenant_id,g.environment_id,g.principal_id,g.release_id,g.fence,g.operation_id,g.request_key,g.input,g.channel)
          =(t,e,principal,r,expected_fence,action,key,booking_apply.input,actor->>'channel') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'booking.approvalRequired'; END IF;
    actor := actor || jsonb_build_object('approvingHumanId',approval.human_id); END IF;
  SELECT * INTO prior_receipt FROM platform.booking_receipts WHERE NOT system_expiry AND (tenant_id,environment_id,request_key)=(t,e,key);
  IF FOUND THEN
    IF (prior_receipt.actor_id,prior_receipt.operation_id,prior_receipt.input,prior_receipt.release_id)
      IS DISTINCT FROM (principal,action,input,r) THEN RAISE EXCEPTION 'booking.requestKeyConflict'; END IF;
    RETURN prior_receipt.result; END IF;
  IF approval.consumed THEN RAISE EXCEPTION 'booking.approvalSpent'; END IF;
  IF approval.grant_id IS NOT NULL THEN
    UPDATE platform.booking_approval_grants SET consumed=true WHERE grant_id=approval.grant_id; END IF;
  SELECT value->>'physicalTableName' INTO STRICT owner_table FROM jsonb_array_elements(storage->'entities') WHERE value->>'entityId'=released_binding->>'ownerEntity';
  EXECUTE format('SELECT revision FROM north_star_module.%I WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3',owner_table)
    INTO STRICT owner_revision USING t,e,owner_id;
  IF owner_revision IS DISTINCT FROM (input->>'expectedOwnerRevision')::bigint THEN RAISE EXCEPTION 'booking.staleOwnerRevision'; END IF;
  -- Acquire all affected owner cursor locks in one order, including other companies' due holds.
  IF command<>'setCapacity' THEN
    INSERT INTO platform.booking_owner_cursors (tenant_id,environment_id,entity_id,company_id,record_id)
      VALUES (t,e,released_binding->>'ownerEntity',owner_company,owner_id) ON CONFLICT DO NOTHING;
    SELECT * INTO STRICT owner_row FROM platform.booking_owner_cursors WHERE (tenant_id,environment_id,entity_id,record_id)=(t,e,released_binding->>'ownerEntity',owner_id); END IF;
  PERFORM 1 FROM platform.booking_owner_cursors o WHERE o.owner_key=owner_row.owner_key OR EXISTS
    (SELECT FROM platform.booking_commitments f WHERE f.resource_key=diary.resource_key AND f.state IN ('hold','confirmed') AND f.owner_key=o.owner_key)
    ORDER BY o.owner_key FOR UPDATE;
  decision := greatest(north_star_internal.booking_now(),diary.decision_floor);
  UPDATE platform.booking_resources SET decision_floor=decision WHERE resource_key=diary.resource_key;
  PERFORM north_star_internal.booking_expire(diary.resource_key,decision); BEGIN
  -- Refused decisions after expiry return a typed result, so due history commits even when a confirmation loses.
    IF command='setCapacity' THEN
      amount := (input->>'quantity')::numeric;
      IF amount IS NULL OR amount<0 OR amount>='Infinity' OR trunc(amount,diary.quantity_scale)<>amount OR
        nullif(trim(input->>'reason'),'') IS NULL THEN RAISE EXCEPTION 'booking.invalidCapacity'; END IF;
      SELECT * INTO capacity FROM platform.booking_pool_capacity WHERE resource_key=diary.resource_key AND valid_to IS NULL;
      latest := coalesce(capacity.revision,0);
      IF expected_rev IS DISTINCT FROM latest THEN RAISE EXCEPTION 'booking.staleRevision'; END IF;
      UPDATE platform.booking_pool_capacity SET valid_to=decision WHERE resource_key=diary.resource_key AND valid_to IS NULL;
      INSERT INTO platform.booking_pool_capacity (tenant_id,environment_id,resource_key,revision,valid_from,quantity,receipt_id)
        VALUES (t,e,diary.resource_key,latest+1,decision,amount,receipt);
      PERFORM north_star_internal.booking_check_capacity(diary.resource_key);
      RETURN north_star_internal.booking_evidence(t,e,r,actor,action,key,input,receipt,diary.resource_key,latest+1,
        to_jsonb(capacity),to_jsonb(amount),decision,'booking.capacityChanged',
        jsonb_build_object('resourceKey',diary.resource_key,'capacityRevision',latest+1,'validFrom',decision,'validTo',null),
        jsonb_build_object('resourceKey',diary.resource_key,'revision',latest+1)); END IF;
    IF command='hold' THEN
      amount := (input->>'quantity')::numeric;
      IF expected_rev IS DISTINCT FROM 0 OR amount IS NULL OR amount<=0 OR amount>='Infinity' OR trunc(amount,diary.quantity_scale)<>amount
        OR (diary.kind='unit' AND amount<>1) THEN RAISE EXCEPTION 'booking.invalidQuantity'; END IF;
      SELECT jsonb_build_object('id',tenant_id,'zone',time_zone,'boundary',business_day_boundary) INTO STRICT calendar
        FROM platform.inventory_tenant_calendars WHERE tenant_id=t;
      SELECT * INTO term FROM north_star_internal.booking_resolve_window(input->'interval',calendar,decision,NULL);
      INSERT INTO platform.booking_commitments (tenant_id,environment_id,owner_key,slot_id,resource_key,kind,assigned_unit_key,
        fulfilment_mode,binding,calendar,entered_interval,agreed_interval,occupied_interval,quantity,unit,state,deadline,revision)
        VALUES (t,e,owner_row.owner_key,released_binding->>'slotId',diary.resource_key,diary.kind,
          CASE WHEN diary.kind='unit' THEN diary.resource_key END,released_binding->>'fulfilmentMode',released_binding,calendar,input->'interval',
          term.agreed,term.occupied,amount,diary.unit,'hold',least(upper(term.occupied),decision+make_interval(secs=>coalesce((released_binding->>'holdSeconds')::integer,900))),1)
        RETURNING * INTO STRICT fact;
    ELSE
      SELECT * INTO STRICT prior_fact FROM platform.booking_commitments WHERE (tenant_id,environment_id,booking_id,owner_key,resource_key)=
        (t,e,(input->>'bookingId')::uuid,owner_row.owner_key,diary.resource_key);
      IF prior_fact.state IN ('cancelled','completed','noShow') THEN RAISE EXCEPTION 'booking.closed'; END IF;
      IF expected_rev IS DISTINCT FROM prior_fact.revision THEN RAISE EXCEPTION 'booking.staleRevision'; END IF;
      IF command='confirm' AND prior_fact.state<>'hold' THEN RAISE EXCEPTION 'booking.invalidState'; END IF;
      IF command='changeInterval' THEN
        SELECT * INTO term FROM north_star_internal.booking_resolve_window(input->'interval',prior_fact.calendar,decision,prior_fact.agreed_interval);
        UPDATE platform.booking_commitments SET agreed_interval=term.agreed,occupied_interval=term.occupied,entered_interval=input->'interval',
          deadline=least(deadline,upper(term.occupied)),revision=revision+1 WHERE (tenant_id,environment_id,booking_id)=(t,e,prior_fact.booking_id) RETURNING * INTO STRICT fact;
      ELSE
        UPDATE platform.booking_commitments SET state=CASE WHEN command='confirm' THEN 'confirmed' ELSE 'cancelled' END,
          revision=revision+1 WHERE (tenant_id,environment_id,booking_id)=(t,e,prior_fact.booking_id) RETURNING * INTO STRICT fact; END IF; END IF;
    IF diary.kind='pool' THEN PERFORM north_star_internal.booking_check_capacity(diary.resource_key); END IF;
    result := north_star_internal.booking_record_change(prior_fact,fact,r,actor,action,key,input,input->>'reason',decision,decision);
    RETURN result;
  EXCEPTION WHEN exclusion_violation THEN RETURN jsonb_build_object('refused','booking.noLongerAvailable');
    WHEN unique_violation THEN IF SQLERRM LIKE '%booking_live_owner_slot%' THEN RETURN jsonb_build_object('refused','booking.slotOccupied'); ELSE RAISE; END IF;
    WHEN raise_exception THEN IF SQLERRM LIKE 'booking.%' AND SQLERRM <> 'booking.evidenceMismatch' THEN RETURN jsonb_build_object('refused',SQLERRM); ELSE RAISE; END IF; END;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END $$;
