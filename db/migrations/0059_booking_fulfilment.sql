-- Scheduled appointments and unstarted tracked confirmations close only on a committed transition.
ALTER TABLE platform.booking_commitments DROP CONSTRAINT booking_commitments_state_check,
  ADD CONSTRAINT booking_commitments_state_check CHECK (state IN ('hold','confirmed','cancelled','completed','noShow','returned','inUse'));

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

-- Keep agreed quantity on the booking. Pool returns change only the quantity
-- still allocated. The original requested target survives a unit transfer.
ALTER TABLE platform.booking_commitments
  ADD COLUMN requested_resource_key uuid REFERENCES platform.booking_resources(resource_key),
  ADD COLUMN out_quantity numeric CHECK (out_quantity>0 AND out_quantity<'Infinity' AND out_quantity<=quantity),
  ADD CONSTRAINT booking_live_possession CHECK ((state='inUse')=(out_quantity IS NOT NULL));
ALTER TABLE platform.booking_commitments DROP CONSTRAINT booking_commitments_resource_key_occupied_interval_excl,
  ADD EXCLUDE USING gist (resource_key WITH =,occupied_interval WITH &&)
    WHERE (kind='unit' AND state IN ('hold','confirmed','inUse'));
DROP INDEX platform.booking_live_owner_slot;
CREATE UNIQUE INDEX booking_live_owner_slot ON platform.booking_commitments (owner_key,slot_id)
  WHERE state IN ('hold','confirmed','inUse');
CREATE UNIQUE INDEX booking_open_unit ON platform.booking_commitments (assigned_unit_key) WHERE state='inUse' AND kind='unit';

CREATE TABLE platform.booking_use_revisions (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, booking_id uuid NOT NULL, booking_revision integer NOT NULL,
  evidence_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0), supersedes integer,
  evidence_kind text NOT NULL CHECK(evidence_kind IN ('use','assignment','pause','attendance')),
  resource_key uuid REFERENCES platform.booking_resources(resource_key),
  quantity numeric CHECK(quantity>0 AND quantity<'Infinity'), unit text,
  effective_start timestamptz NOT NULL CHECK(isfinite(effective_start)),
  effective_end timestamptz CHECK(isfinite(effective_end) AND effective_end>=effective_start),
  recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND effective_start<=recorded_at AND
    (effective_end IS NULL OR effective_end<=recorded_at)),
  reason text, voided boolean NOT NULL DEFAULT false,
  PRIMARY KEY(tenant_id,environment_id,booking_id,evidence_id,revision),
  FOREIGN KEY(tenant_id,environment_id,booking_id,booking_revision)
    REFERENCES platform.booking_history(tenant_id,environment_id,booking_id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(tenant_id,environment_id,booking_id,evidence_id,supersedes)
    REFERENCES platform.booking_use_revisions(tenant_id,environment_id,booking_id,evidence_id,revision),
  CHECK ((revision=1 AND supersedes IS NULL) OR (revision>1 AND supersedes IS NOT NULL AND supersedes=revision-1)),
  CHECK ((evidence_kind IN ('use','assignment'))=(resource_key IS NOT NULL)),
  CHECK ((evidence_kind='use')=(quantity IS NOT NULL) AND (evidence_kind='use')=(unit IS NOT NULL)),
  CHECK (evidence_kind<>'pause' OR (reason IS NOT NULL AND reason IN ('operatorRequested','serviceInterrupted'))),
  CHECK (evidence_kind<>'attendance' OR (reason IS NOT NULL AND reason IN ('noShow','completed')))
);
ALTER TABLE platform.booking_use_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.booking_use_revisions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform.booking_use_revisions FROM PUBLIC,north_star_runtime,north_star_module_runtime,
  north_star_module_materializer,north_star_workflow_worker;
CREATE TRIGGER booking_use_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.booking_use_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.booking_immutable();
CREATE INDEX booking_evidence_resource ON platform.booking_use_revisions(resource_key,effective_start) WHERE resource_key IS NOT NULL;

CREATE FUNCTION north_star_internal.booking_current_evidence(f platform.booking_commitments)
RETURNS SETOF platform.booking_use_revisions LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT DISTINCT ON (u.evidence_id) u.* FROM platform.booking_use_revisions u
    WHERE (u.tenant_id,u.environment_id,u.booking_id)=(f.tenant_id,f.environment_id,f.booking_id)
    ORDER BY u.evidence_id,u.revision DESC
$$;

CREATE FUNCTION north_star_internal.booking_write_evidence(f platform.booking_commitments,ev platform.booking_use_revisions,
  at_time timestamptz) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE stored platform.booking_use_revisions; BEGIN
  ev.tenant_id:=f.tenant_id; ev.environment_id:=f.environment_id; ev.booking_id:=f.booking_id;
  ev.booking_revision:=f.revision; ev.recorded_at:=at_time;
  ev.evidence_id:=coalesce(ev.evidence_id,gen_random_uuid()); ev.supersedes:=ev.revision;
  ev.revision:=coalesce(ev.revision,0)+1; ev.voided:=coalesce(ev.voided,false);
  INSERT INTO platform.booking_use_revisions SELECT (ev).*;
  SELECT * INTO stored FROM platform.booking_use_revisions u WHERE
    (u.tenant_id,u.environment_id,u.booking_id,u.evidence_id,u.revision)=(ev.tenant_id,ev.environment_id,ev.booking_id,ev.evidence_id,ev.revision);
  IF stored IS DISTINCT FROM ev THEN RAISE EXCEPTION 'booking.evidenceMismatch'; END IF; END $$;

CREATE FUNCTION north_star_internal.booking_open_use(f platform.booking_commitments,effective timestamptz,decision timestamptz)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE ev platform.booking_use_revisions; BEGIN
  ev.evidence_kind:='use'; ev.resource_key:=f.resource_key; ev.effective_start:=effective;
  ev.quantity:=f.out_quantity; ev.unit:=f.unit;
  PERFORM north_star_internal.booking_write_evidence(f,ev,decision);
  IF f.kind='unit' THEN
    ev.evidence_kind:='assignment'; ev.quantity:=NULL; ev.unit:=NULL;
    PERFORM north_star_internal.booking_write_evidence(f,ev,decision); END IF; END $$;

CREATE FUNCTION north_star_internal.booking_close_evidence(f platform.booking_commitments,kinds text[],effective timestamptz,decision timestamptz)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE ev platform.booking_use_revisions; BEGIN
  FOR ev IN SELECT * FROM north_star_internal.booking_current_evidence(f)
    WHERE evidence_kind=ANY(kinds) AND effective_end IS NULL AND NOT voided LOOP
    IF effective<ev.effective_start THEN RAISE EXCEPTION 'booking.inconsistentTimeline'; END IF;
    ev.effective_end:=effective; PERFORM north_star_internal.booking_write_evidence(f,ev,decision); END LOOP; END $$;

CREATE FUNCTION north_star_internal.booking_effective_instant(raw text,decision timestamptz,zone_name text,days integer,reason text)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE instant timestamptz; BEGIN
  IF raw IS NULL THEN RETURN decision; END IF;
  IF raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
    THEN RAISE EXCEPTION 'booking.invalidEffectiveTime'; END IF;
  instant:=raw::timestamptz;
  IF NOT isfinite(instant) OR instant>decision OR days IS NULL OR days<0 OR
    (decision AT TIME ZONE zone_name)::date-(instant AT TIME ZONE zone_name)::date>days
    THEN RAISE EXCEPTION 'booking.effectiveTimeOutsideBound'; END IF;
  IF instant<decision AND nullif(trim(reason),'') IS NULL THEN RAISE EXCEPTION 'booking.backdateReasonRequired'; END IF;
  RETURN instant; END $$;

-- A finite planned claim and the same booking's open quantity count once.
-- A pre-existing later commitment remains valid when another booking overruns.
CREATE FUNCTION north_star_internal.booking_check_handover(d platform.booking_resources, f platform.booking_commitments,
  decision timestamptz,planned boolean) RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE limit_now numeric; others numeric; BEGIN
  IF d.kind='unit' THEN limit_now:=1;
  ELSE SELECT quantity INTO limit_now FROM platform.booking_pool_capacity WHERE resource_key=d.resource_key
    AND tstzrange(valid_from,valid_to,'[)') @> decision; END IF;
  SELECT coalesce(sum(CASE WHEN b.state='inUse' THEN b.out_quantity ELSE b.quantity END),0) INTO others FROM platform.booking_commitments b
    WHERE b.resource_key=d.resource_key AND b.booking_id<>f.booking_id AND
      ((b.state='inUse' AND (NOT planned OR upper(b.occupied_interval)<=decision)) OR
       (NOT planned AND b.state IN ('hold','confirmed') AND NOT (f.occupied_interval @> decision) AND b.occupied_interval @> decision));
  IF others+coalesce(f.out_quantity,f.quantity)>coalesce(limit_now,0) THEN RAISE EXCEPTION 'booking.capacityTaken'; END IF; END $$;

-- Include the current revision of every use. For a backdated handover before
-- its allocation, include what other bookings actually occupied in that past
-- interval, clipped to the time each revision was in force.
CREATE FUNCTION north_star_internal.booking_check_use(f platform.booking_commitments,d platform.booking_resources,
  checked_id uuid,from_time timestamptz,until_time timestamptz,amount numeric)
RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF from_time=until_time THEN RETURN; END IF;
  IF EXISTS (
    WITH span AS (SELECT tstzrange(from_time,until_time,'[)') AS window),
    actual AS (
      SELECT u.booking_id,u.evidence_id,tstzrange(u.effective_start,u.effective_end,'[)') AS win,u.quantity AS qty
      FROM platform.booking_use_revisions u
      WHERE u.resource_key=d.resource_key AND u.evidence_kind='use' AND NOT u.voided AND u.evidence_id IS DISTINCT FROM checked_id
        AND NOT EXISTS (SELECT FROM platform.booking_use_revisions newer WHERE
          (newer.tenant_id,newer.environment_id,newer.booking_id,newer.evidence_id)=(u.tenant_id,u.environment_id,u.booking_id,u.evidence_id)
          AND newer.revision>u.revision)),
    historical AS (
      SELECT h.*,lead(recorded_at) OVER (PARTITION BY h.booking_id ORDER BY revision) AS superseded_at
      FROM platform.booking_history h WHERE h.tenant_id=f.tenant_id AND h.environment_id=f.environment_id AND h.booking_id<>f.booking_id),
    demands AS (
      SELECT a.booking_id,a.win*s.window AS win,a.qty FROM actual a,span s WHERE a.win && s.window
      UNION ALL SELECT h.booking_id,(h.after_fact->>'occupied_interval')::tstzrange *
        tstzrange(h.recorded_at,h.superseded_at,'[)') * s.window * tstzrange(NULL,lower(f.occupied_interval),'[)'),
        coalesce((h.after_fact->>'out_quantity')::numeric,(h.after_fact->>'quantity')::numeric)
      FROM historical h,span s WHERE h.after_fact->>'state' IN ('confirmed','hold','inUse') AND
        h.after_fact->>'resource_key'=d.resource_key::text AND from_time<lower(f.occupied_interval)),
    boundaries AS (
      SELECT from_time AS at UNION SELECT lower(win) FROM demands WHERE NOT isempty(win)
      UNION SELECT upper(win) FROM demands WHERE NOT isempty(win)
      UNION SELECT valid_from FROM platform.booking_pool_capacity WHERE resource_key=d.resource_key AND valid_from>=from_time AND valid_from<until_time
      UNION SELECT valid_to FROM platform.booking_pool_capacity WHERE resource_key=d.resource_key AND valid_to>=from_time AND valid_to<until_time)
    SELECT FROM boundaries b WHERE b.at>=from_time AND b.at<until_time AND
      amount+coalesce((SELECT sum(per_booking.qty) FROM
        (SELECT max(x.qty) AS qty FROM demands x WHERE x.win @> b.at GROUP BY x.booking_id) per_booking),0)>
        CASE WHEN d.kind='unit' THEN 1 ELSE coalesce((SELECT capacity.quantity FROM platform.booking_pool_capacity capacity
          WHERE capacity.resource_key=d.resource_key AND tstzrange(capacity.valid_from,capacity.valid_to,'[)') @> b.at),0) END)
    THEN RAISE EXCEPTION 'booking.historicalOverlap'; END IF; END $$;

REVOKE ALL ON FUNCTION north_star_internal.booking_current_evidence(platform.booking_commitments),
  north_star_internal.booking_write_evidence(platform.booking_commitments,platform.booking_use_revisions,timestamptz),
  north_star_internal.booking_open_use(platform.booking_commitments,timestamptz,timestamptz),
  north_star_internal.booking_close_evidence(platform.booking_commitments,text[],timestamptz,timestamptz),
  north_star_internal.booking_effective_instant(text,timestamptz,text,integer,text),
  north_star_internal.booking_check_handover(platform.booking_resources,platform.booking_commitments,timestamptz,boolean),
  north_star_internal.booking_check_use(platform.booking_commitments,platform.booking_resources,uuid,timestamptz,timestamptz,numeric) FROM PUBLIC;

ALTER TABLE platform.booking_commitments DROP CONSTRAINT booking_commitments_check1,
  ADD CONSTRAINT booking_group_pair CHECK ((group_id IS NULL AND group_kind IS NULL) OR
    (group_id IS NOT NULL AND group_kind IS NOT DISTINCT FROM 'kit'));
CREATE INDEX booking_kit_members ON platform.booking_commitments(tenant_id,environment_id,group_id) WHERE group_id IS NOT NULL;
ALTER TABLE platform.booking_history DROP CONSTRAINT booking_history_owner_key_cursor_value_key,
  ADD UNIQUE(owner_key,cursor_value,booking_id);

-- A due held kit connects diaries. Discover the complete connected set before
-- taking diary locks, then check again against a fresh READ COMMITTED snapshot.
CREATE FUNCTION north_star_internal.booking_diaries(keys uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH RECURSIVE closure(key) AS (SELECT unnest(keys) UNION
    SELECT m.resource_key FROM closure c JOIN platform.booking_commitments f ON f.resource_key=c.key AND f.state='hold'
    JOIN platform.booking_commitments m USING (tenant_id,environment_id,group_id) WHERE m.state='hold')
  SELECT array_agg(key ORDER BY key) FROM closure
$$;
CREATE FUNCTION north_star_internal.booking_lock_diaries(keys uuid[]) RETURNS uuid[]
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE closure uuid[]:=north_star_internal.booking_diaries(keys); BEGIN
  IF cardinality(closure)>256 THEN RAISE EXCEPTION 'booking.lockSetLimit'; END IF;
  PERFORM FROM platform.booking_resources WHERE resource_key=ANY(closure) ORDER BY resource_key FOR UPDATE;
  IF closure IS DISTINCT FROM north_star_internal.booking_diaries(keys) THEN RAISE EXCEPTION 'booking.endpointChanged' USING ERRCODE='40001'; END IF;
  RETURN closure; END $$;

CREATE FUNCTION north_star_internal.booking_lock_kit_endpoints(t uuid,e uuid,storage jsonb,plans jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE closure jsonb; locked jsonb; node record; pass integer; live boolean; BEGIN
  FOR pass IN 1..2 LOOP
    closure:='[]';
    FOR node IN WITH endpoints AS (
      SELECT p->'binding'->>'ownerEntity' AS entity,(p->'member'->>'recordId')::uuid AS id FROM jsonb_array_elements(plans) p
      UNION SELECT p->'binding'->>'resourceEntity',(p->>'target')::uuid FROM jsonb_array_elements(plans) p),
      nodes AS (SELECT DISTINCT tree.* FROM endpoints ep CROSS JOIN LATERAL
        north_star_internal.booking_endpoint_tree(t,e,storage,ep.entity,ep.id) tree)
      SELECT * FROM nodes ORDER BY north_star_internal.booking_entity_height(storage,entity_id) DESC,entity_id,record_id LOOP
      closure:=closure||jsonb_build_array(to_jsonb(node));
      IF pass=1 THEN
        EXECUTE format('SELECT true FROM north_star_module.%I WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL FOR UPDATE',node.table_name)
          INTO live USING t,e,node.record_id;
        IF live IS DISTINCT FROM true THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END IF; END IF; END LOOP;
    IF pass=1 THEN locked:=closure; ELSIF closure<>locked THEN RAISE EXCEPTION 'booking.endpointChanged' USING ERRCODE='40001'; END IF; END LOOP; END $$;

CREATE FUNCTION north_star_internal.booking_record_kit(t uuid,e uuid,kit uuid,r uuid,actor jsonb,action text,key uuid,input jsonb,
  decision timestamptz,effective timestamptz) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE own platform.booking_owner_cursors; f platform.booking_commitments; lead_fact platform.booking_commitments;
  previous jsonb; members jsonb; owners jsonb:='[]'; receipt uuid:=gen_random_uuid(); scope jsonb; BEGIN
  FOR own IN SELECT o.* FROM platform.booking_owner_cursors o WHERE EXISTS(SELECT FROM platform.booking_commitments b WHERE
    (b.tenant_id,b.environment_id,b.group_id,b.owner_key)=(t,e,kit,o.owner_key)) ORDER BY o.owner_key LOOP
    UPDATE platform.booking_owner_cursors SET cursor_value=cursor_value+1 WHERE owner_key=own.owner_key RETURNING * INTO STRICT own;
    members:='[]';
    FOR f IN SELECT * FROM platform.booking_commitments WHERE (tenant_id,environment_id,group_id,owner_key)=(t,e,kit,own.owner_key) ORDER BY booking_id LOOP
      previous:=NULL;
      IF f.revision>1 THEN SELECT after_fact INTO STRICT previous FROM platform.booking_history
        WHERE (tenant_id,environment_id,booking_id,revision)=(t,e,f.booking_id,f.revision-1); END IF;
      INSERT INTO platform.booking_history VALUES(t,e,f.booking_id,f.revision,own.owner_key,own.cursor_value,previous,to_jsonb(f),
        action,input->>'reason',effective,decision,receipt);
      IF NOT EXISTS(SELECT FROM platform.booking_history h WHERE
        (h.booking_id,h.revision,h.cursor_value,h.receipt_id,h.after_fact)=(f.booking_id,f.revision,own.cursor_value,receipt,to_jsonb(f))
        AND h.before_fact IS NOT DISTINCT FROM previous) THEN RAISE EXCEPTION 'booking.evidenceMismatch'; END IF;
      members:=members||jsonb_build_array(jsonb_build_object('bookingId',f.booking_id,'revision',f.revision));
      IF lead_fact.booking_id IS NULL THEN lead_fact:=f; END IF; END LOOP;
    owners:=owners||jsonb_build_array(jsonb_build_object('ownerRef',jsonb_build_object('entityId',own.entity_id,'recordId',own.record_id),
      'previousCursor',(own.cursor_value-1)::text,'cursor',own.cursor_value::text,'bookings',members));
    scope:=CASE WHEN own.company_id IS NULL THEN '{"kind":"shared"}'::jsonb ELSE jsonb_build_object('kind','company','companyId',own.company_id) END; END LOOP;
  IF lead_fact.booking_id IS NULL THEN RAISE EXCEPTION 'booking.evidenceMismatch'; END IF;
  RETURN north_star_internal.booking_evidence(t,e,r,actor,action,key,input,receipt,lead_fact.booking_id,lead_fact.revision,
    CASE WHEN lead_fact.revision>1 THEN jsonb_build_object('groupId',kit) END,to_jsonb(lead_fact),decision,'booking.changed',
    jsonb_build_object('operation',action,'effectiveAt',effective,'ownerScope',scope,'owners',owners),
    jsonb_build_object('groupId',kit,'bookingId',lead_fact.booking_id,'revision',lead_fact.revision,'state',lead_fact.state,'deadline',lead_fact.deadline)); END $$;

CREATE FUNCTION north_star_internal.booking_expire_kit(t uuid,e uuid,kit uuid,decision timestamptz)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE source platform.booking_receipts; key uuid; actor jsonb; due timestamptz; count_members integer; BEGIN
  -- Foreground callers already hold the closure. A sweeper skips the whole kit
  -- when another writer holds any member diary or owner cursor.
  PERFORM FROM platform.booking_resources d WHERE EXISTS(SELECT FROM platform.booking_commitments f WHERE
    (f.tenant_id,f.environment_id,f.group_id,f.resource_key)=(t,e,kit,d.resource_key)) ORDER BY resource_key FOR UPDATE NOWAIT;
  PERFORM FROM platform.booking_owner_cursors o WHERE EXISTS(SELECT FROM platform.booking_commitments f WHERE
    (f.tenant_id,f.environment_id,f.group_id,f.owner_key)=(t,e,kit,o.owner_key)) ORDER BY owner_key FOR UPDATE NOWAIT;
  SELECT greatest(decision,max(d.decision_floor),north_star_internal.booking_now()) INTO decision FROM platform.booking_resources d
    JOIN platform.booking_commitments f USING(resource_key) WHERE (f.tenant_id,f.environment_id,f.group_id)=(t,e,kit);
  SELECT max(deadline),count(*) INTO due,count_members FROM platform.booking_commitments WHERE (tenant_id,environment_id,group_id)=(t,e,kit)
    HAVING bool_and(state='hold' AND deadline<=decision) AND min(deadline)=max(deadline);
  IF due IS NULL THEN RETURN; END IF;
  SELECT DISTINCT b.* INTO STRICT source FROM platform.booking_receipts b JOIN platform.booking_history h USING (tenant_id,environment_id,receipt_id)
    WHERE (h.tenant_id,h.environment_id)=(t,e) AND h.revision=1 AND h.after_fact->>'group_id'=kit::text;
  key:=md5('booking.expireKit/'||kit||'/'||source.receipt_id)::uuid;
  actor:=jsonb_build_object('executionPrincipal',jsonb_build_object('kind','SYSTEM','principalId',md5('northstar.booking/expiry/'||t||'/'||e)::uuid),
    'requestId',key,'cause',source.receipt_id,'channel','SYSTEM','policyVersion','acceptedHoldDeadline');
  UPDATE platform.booking_resources d SET decision_floor=decision WHERE EXISTS(SELECT FROM platform.booking_commitments f
    WHERE (f.tenant_id,f.environment_id,f.group_id,f.resource_key)=(t,e,kit,d.resource_key));
  UPDATE platform.booking_commitments SET state='cancelled',revision=revision+1 WHERE (tenant_id,environment_id,group_id)=(t,e,kit);
  IF (SELECT count(*) FROM platform.booking_commitments WHERE (tenant_id,environment_id,group_id,state)=(t,e,kit,'cancelled'))<>count_members
    THEN RAISE EXCEPTION 'booking.evidenceMismatch'; END IF;
  PERFORM north_star_internal.booking_record_kit(t,e,kit,source.release_id,actor,'expireHold',key,
    jsonb_build_object('groupId',kit,'reason','hold expired'),decision,due); END $$;
REVOKE ALL ON FUNCTION north_star_internal.booking_diaries(uuid[]),north_star_internal.booking_lock_diaries(uuid[]),
  north_star_internal.booking_lock_kit_endpoints(uuid,uuid,jsonb,jsonb),
  north_star_internal.booking_record_kit(uuid,uuid,uuid,uuid,jsonb,text,uuid,jsonb,timestamptz,timestamptz),
  north_star_internal.booking_expire_kit(uuid,uuid,uuid,timestamptz) FROM PUBLIC;

CREATE FUNCTION north_star_internal.booking_finalize_due(previous platform.booking_commitments,decision timestamptz)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  fact platform.booking_commitments;
  source platform.booking_receipts;
  effective timestamptz := upper(previous.agreed_interval);
  action text := CASE previous.fulfilment_mode WHEN 'scheduled' THEN 'completeScheduled' ELSE 'markNoShow' END;
  request_key uuid := md5('booking/'||action||'/'||previous.booking_id||'/'||previous.revision)::uuid;
  actor jsonb; attendance platform.booking_use_revisions; BEGIN
  IF previous.state='hold' THEN
    IF previous.deadline<=decision THEN
      IF previous.group_id IS NULL THEN PERFORM north_star_internal.booking_expire_one(previous,decision);
      ELSE PERFORM north_star_internal.booking_expire_kit(previous.tenant_id,previous.environment_id,previous.group_id,decision); END IF; END IF;
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
  attendance.evidence_kind:='attendance'; attendance.reason:=fact.state;
  attendance.effective_start:=effective; attendance.effective_end:=effective;
  PERFORM north_star_internal.booking_write_evidence(fact,attendance,decision);
  PERFORM north_star_internal.booking_record_change(previous,fact,source.release_id,actor,action,request_key,
    jsonb_build_object('bookingId',fact.booking_id,'revision',previous.revision),action,effective,decision); END $$;
REVOKE ALL ON FUNCTION north_star_internal.booking_finalize_due(platform.booking_commitments,timestamptz) FROM PUBLIC;

CREATE FUNCTION north_star_internal.booking_fulfil(previous platform.booking_commitments,d platform.booking_resources,
  dest platform.booking_resources,command text,input jsonb,binding jsonb,decision timestamptz,effective timestamptz)
RETURNS platform.booking_commitments LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  f platform.booking_commitments:=previous;
  ev platform.booking_use_revisions; prev_ev platform.booking_use_revisions; matched platform.booking_use_revisions;
  amount numeric; end_at timestamptz; reason text:=input->>'reason';
  actual_day_limit integer:=(binding->>'maxCorrectionAgeDays')::integer;
  zone_name text:=f.calendar->>'zone'; BEGIN
  f.revision:=f.revision+1;
  IF command IN ('start','return','pause','resume') AND f.fulfilment_mode<>'tracked' THEN RAISE EXCEPTION 'booking.invalidState'; END IF;
  IF command IN ('return','pause','resume') AND f.state<>'inUse' THEN RAISE EXCEPTION 'booking.invalidState'; END IF;
  CASE command
  WHEN 'start' THEN
    IF f.state NOT IN ('confirmed','noShow') OR NOT (f.agreed_interval @> effective) THEN RAISE EXCEPTION 'booking.invalidStart'; END IF;
    f.state:='inUse'; f.out_quantity:=f.quantity;
    PERFORM north_star_internal.booking_check_handover(d,f,decision,false);
    IF previous.state='noShow' AND NOT EXISTS (SELECT FROM platform.booking_history h WHERE h.booking_id=f.booking_id AND
      h.revision=previous.revision AND h.operation='markNoShow') THEN RAISE EXCEPTION 'booking.closed'; END IF;
    /* Recheck history for a recovered missed handover. */ BEGIN PERFORM north_star_internal.booking_check_use(f,d,NULL,effective,decision,f.out_quantity);
    EXCEPTION WHEN raise_exception THEN
      IF previous.state='noShow' AND SQLERRM='booking.historicalOverlap' THEN RAISE EXCEPTION 'booking.capacityTaken'; END IF; RAISE; END;
    PERFORM north_star_internal.booking_open_use(f,effective,decision);
  WHEN 'return' THEN
    amount:=CASE WHEN input ? 'returnedQuantity' THEN (input->>'returnedQuantity')::numeric ELSE f.out_quantity END;
    IF amount IS NULL OR amount<=0 OR amount>f.out_quantity OR trunc(amount,d.quantity_scale)<>amount THEN RAISE EXCEPTION 'booking.invalidQuantity'; END IF;
    PERFORM north_star_internal.booking_close_evidence(f,ARRAY['use','assignment'],effective,decision);
    IF amount=f.out_quantity THEN
      PERFORM north_star_internal.booking_close_evidence(f,ARRAY['pause'],effective,decision);
      f.state:='returned'; f.out_quantity:=NULL;
      IF decision>lower(f.occupied_interval) AND decision<upper(f.occupied_interval) THEN
        f.occupied_interval:=tstzrange(lower(f.occupied_interval),decision,'[)'); END IF;
    ELSE
      f.out_quantity:=f.out_quantity-amount;
      PERFORM north_star_internal.booking_check_use(f,d,NULL,effective,decision,f.out_quantity);
      PERFORM north_star_internal.booking_open_use(f,effective,decision); END IF;
  WHEN 'swap' THEN
    IF f.kind<>'unit' OR f.state NOT IN ('hold','confirmed','inUse') OR dest.resource_key IS NULL OR dest.resource_key=d.resource_key
      THEN RAISE EXCEPTION 'booking.invalidSwap'; END IF;
    f.requested_resource_key:=coalesce(f.requested_resource_key,d.resource_key);
    f.resource_key:=dest.resource_key; f.assigned_unit_key:=dest.resource_key;
    IF decision>lower(f.occupied_interval) AND decision<upper(f.occupied_interval) THEN
      f.occupied_interval:=tstzrange(decision,upper(f.occupied_interval),'[)'); END IF;
    IF f.state='inUse' THEN
      PERFORM north_star_internal.booking_close_evidence(f,ARRAY['use','assignment'],effective,decision);
      PERFORM north_star_internal.booking_check_handover(dest,f,decision,false);
      PERFORM north_star_internal.booking_check_use(f,dest,NULL,effective,decision,f.out_quantity);
      PERFORM north_star_internal.booking_open_use(f,effective,decision); END IF;
  WHEN 'pause','resume' THEN
    SELECT * INTO ev FROM north_star_internal.booking_current_evidence(f) WHERE evidence_kind='pause' AND effective_end IS NULL AND NOT voided;
    IF command='pause' THEN
      IF FOUND OR input->>'pauseReason' IS NULL OR input->>'pauseReason' NOT IN ('operatorRequested','serviceInterrupted')
        THEN RAISE EXCEPTION 'booking.invalidPause'; END IF;
      ev.evidence_kind:='pause'; ev.reason:=input->>'pauseReason'; ev.effective_start:=effective;
    ELSE
      IF NOT FOUND OR effective<ev.effective_start THEN RAISE EXCEPTION 'booking.invalidPause'; END IF;
      ev.effective_end:=effective; END IF;
    PERFORM north_star_internal.booking_write_evidence(f,ev,decision);
  WHEN 'noShow' THEN
    IF f.state<>'confirmed' OR decision<lower(f.agreed_interval) THEN RAISE EXCEPTION 'booking.invalidState'; END IF;
    f.state:='noShow'; ev.evidence_kind:='attendance'; ev.reason:='noShow'; ev.effective_start:=decision; ev.effective_end:=decision;
    PERFORM north_star_internal.booking_write_evidence(f,ev,decision);
  WHEN 'changeQuantity' THEN
    amount:=(input->>'quantity')::numeric;
    IF f.state NOT IN ('hold','confirmed') OR f.kind<>'pool' THEN RAISE EXCEPTION 'booking.invalidState'; END IF;
    IF amount IS NULL OR amount<=0 OR amount>='Infinity' OR trunc(amount,d.quantity_scale)<>amount THEN RAISE EXCEPTION 'booking.invalidQuantity'; END IF;
    f.quantity:=amount;
  WHEN 'correctActuals' THEN
    IF nullif(trim(reason),'') IS NULL OR actual_day_limit IS NULL THEN RAISE EXCEPTION 'booking.correctionReasonRequired'; END IF;
    SELECT * INTO ev FROM north_star_internal.booking_current_evidence(f) WHERE evidence_id=(input->>'evidenceId')::uuid;
    IF NOT FOUND OR ev.voided OR ev.revision IS DISTINCT FROM (input->>'evidenceRevision')::integer THEN RAISE EXCEPTION 'booking.staleEvidence'; END IF;
    prev_ev:=ev;
    IF (decision AT TIME ZONE zone_name)::date-(ev.effective_start AT TIME ZONE zone_name)::date>actual_day_limit THEN RAISE EXCEPTION 'booking.effectiveTimeOutsideBound'; END IF;
    IF input ? 'start' THEN
      IF input->>'start' IS NULL THEN RAISE EXCEPTION 'booking.invalidEffectiveTime'; END IF;
      ev.effective_start:=north_star_internal.booking_effective_instant(input->>'start',decision,zone_name,actual_day_limit,reason); END IF;
    IF input ? 'end' THEN
      ev.effective_end:=CASE WHEN input->>'end' IS NOT NULL THEN
        north_star_internal.booking_effective_instant(input->>'end',decision,zone_name,actual_day_limit,reason) END; END IF;
    IF ev.effective_end<ev.effective_start OR ((prev_ev.effective_end IS NULL)<>(ev.effective_end IS NULL))
      THEN RAISE EXCEPTION 'booking.inconsistentTimeline'; END IF;
    IF input ? 'void' THEN
      IF ev.evidence_kind<>'pause' OR ev.effective_end IS NULL OR input->'void'<>'true'::jsonb THEN RAISE EXCEPTION 'booking.invalidCorrection'; END IF;
      ev.voided:=true; END IF;
    IF input ? 'outcome' THEN
      IF ev.evidence_kind<>'attendance' OR input->>'outcome' NOT IN ('completed','noShow') THEN RAISE EXCEPTION 'booking.invalidCorrection'; END IF;
      ev.reason:=input->>'outcome';
      IF f.state IN ('completed','noShow') THEN f.state:=ev.reason; END IF; END IF;
    IF ev IS NOT DISTINCT FROM prev_ev THEN RAISE EXCEPTION 'booking.invalidCorrection'; END IF;
    IF ev.evidence_kind IN ('assignment','use') THEN
      IF dest.resource_key IS DISTINCT FROM ev.resource_key THEN RAISE EXCEPTION 'booking.staleEvidence'; END IF;
      IF f.kind='unit' THEN
        SELECT * INTO STRICT matched FROM north_star_internal.booking_current_evidence(f) WHERE
          evidence_kind=CASE WHEN ev.evidence_kind='use' THEN 'assignment' ELSE 'use' END AND resource_key=ev.resource_key
          AND effective_start=prev_ev.effective_start AND effective_end IS NOT DISTINCT FROM prev_ev.effective_end AND NOT voided;
        matched.effective_start:=ev.effective_start; matched.effective_end:=ev.effective_end;
        PERFORM north_star_internal.booking_write_evidence(f,matched,decision); END IF;
      PERFORM north_star_internal.booking_check_use(f,dest,CASE WHEN ev.evidence_kind='use' THEN ev.evidence_id ELSE matched.evidence_id END,
        ev.effective_start,coalesce(ev.effective_end,decision),coalesce(ev.quantity,matched.quantity)); END IF;
    PERFORM north_star_internal.booking_write_evidence(f,ev,decision);
  ELSE RAISE EXCEPTION 'booking.unsupportedBinding'; END CASE;
  IF EXISTS (WITH evidence AS (SELECT * FROM north_star_internal.booking_current_evidence(f) WHERE NOT voided)
    SELECT FROM evidence a JOIN evidence b ON a.evidence_id<b.evidence_id AND a.evidence_kind=b.evidence_kind
      AND a.evidence_kind IN ('pause','use','assignment') AND tstzrange(a.effective_start,a.effective_end,'[)') && tstzrange(b.effective_start,b.effective_end,'[)')
    UNION ALL SELECT FROM evidence p WHERE p.evidence_kind='pause' AND NOT coalesce(
      (SELECT range_agg(tstzrange(u.effective_start,u.effective_end,'[)')) @> tstzrange(p.effective_start,p.effective_end,'[)')
       FROM evidence u WHERE u.evidence_kind='use'),false))
    THEN RAISE EXCEPTION 'booking.inconsistentTimeline'; END IF;
  UPDATE platform.booking_commitments SET
    (state,revision,quantity,out_quantity,resource_key,requested_resource_key,assigned_unit_key,occupied_interval)=
    (f.state,f.revision,f.quantity,f.out_quantity,f.resource_key,f.requested_resource_key,f.assigned_unit_key,f.occupied_interval)
    WHERE (tenant_id,environment_id,booking_id)=(f.tenant_id,f.environment_id,f.booking_id);
  IF NOT EXISTS (SELECT FROM platform.booking_commitments saved WHERE saved IS NOT DISTINCT FROM f)
    THEN RAISE EXCEPTION 'booking.evidenceMismatch'; END IF;
  RETURN f; END $$;
REVOKE ALL ON FUNCTION north_star_internal.booking_fulfil(platform.booking_commitments,platform.booking_resources,
  platform.booking_resources,text,jsonb,jsonb,timestamptz,timestamptz) FROM PUBLIC;

CREATE FUNCTION north_star_internal.booking_lock_resource_endpoints(t uuid,e uuid,storage jsonb,owner_type text,owner_id uuid,keys uuid[])
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE closure jsonb; locked jsonb; node record; live boolean; pass integer; BEGIN
  FOR pass IN 1..2 LOOP
    closure:='[]';
    FOR node IN SELECT n.* FROM (
      SELECT * FROM north_star_internal.booking_endpoint_tree(t,e,storage,owner_type,owner_id)
      UNION SELECT tree.* FROM platform.booking_resources d CROSS JOIN LATERAL
        north_star_internal.booking_endpoint_tree(t,e,storage,d.entity_id,d.record_id) tree WHERE d.resource_key=ANY(keys)) n
      ORDER BY north_star_internal.booking_entity_height(storage,n.entity_id) DESC,n.entity_id,n.record_id LOOP
      closure:=closure||jsonb_build_array(to_jsonb(node));
      IF pass=1 THEN
        EXECUTE format('SELECT true FROM north_star_module.%I WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL FOR UPDATE',node.table_name)
          INTO live USING t,e,node.record_id;
        IF live IS DISTINCT FROM true THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END IF; END IF; END LOOP;
    IF pass=1 THEN locked:=closure; ELSIF locked<>closure THEN RAISE EXCEPTION 'booking.endpointChanged' USING ERRCODE='40001'; END IF; END LOOP; END $$;
REVOKE ALL ON FUNCTION north_star_internal.booking_lock_resource_endpoints(uuid,uuid,jsonb,text,uuid,uuid[]) FROM PUBLIC;

CREATE FUNCTION north_star_internal.booking_register_resource(t uuid,e uuid,storage jsonb,binding jsonb,id uuid)
RETURNS platform.booking_resources LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE d platform.booking_resources; company uuid; BEGIN
  SELECT * INTO d FROM platform.booking_resources WHERE (tenant_id,environment_id,entity_id,record_id)=(t,e,binding->>'resourceEntity',id);
  IF NOT FOUND THEN
    company:=north_star_internal.booking_endpoint(t,e,storage,binding->>'resourceEntity',id,false);
    INSERT INTO platform.booking_resources(tenant_id,environment_id,entity_id,record_id,company_id,kind,unit,quantity_scale)
      VALUES(t,e,binding->>'resourceEntity',id,company,binding->>'kind',binding->>'unit',(binding->>'scale')::integer)
      ON CONFLICT (tenant_id,environment_id,entity_id,company_id,record_id) DO NOTHING;
    SELECT * INTO STRICT d FROM platform.booking_resources WHERE
      (tenant_id,environment_id,entity_id,record_id)=(t,e,binding->>'resourceEntity',id); END IF;
  RETURN d; END $$;
REVOKE ALL ON FUNCTION north_star_internal.booking_register_resource(uuid,uuid,jsonb,jsonb,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION north_star_internal.booking_check_capacity(diary uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  -- Sum simultaneous changes before looking at the next segment. Checking
  -- total overlapping demand would double count adjacent commitments.
  IF EXISTS (
    WITH changes AS (
      SELECT lower(occupied_interval) AS at, coalesce(out_quantity,quantity) AS demand, 0::numeric AS capacity
        FROM platform.booking_commitments WHERE resource_key=diary AND state IN ('hold','confirmed','inUse')
      UNION ALL SELECT upper(occupied_interval),-coalesce(out_quantity,quantity),0
        FROM platform.booking_commitments WHERE resource_key=diary AND state IN ('hold','confirmed','inUse')
      UNION ALL SELECT valid_from,0,quantity FROM platform.booking_pool_capacity WHERE resource_key=diary
      UNION ALL SELECT valid_to,0,-quantity FROM platform.booking_pool_capacity WHERE resource_key=diary AND valid_to IS NOT NULL
    ), segments AS (
      SELECT at, sum(sum(capacity-demand)) OVER (ORDER BY at) AS remaining FROM changes GROUP BY at
    ) SELECT FROM segments WHERE remaining < 0
  ) THEN RAISE EXCEPTION 'booking.noLongerAvailable'; END IF; END $$;

CREATE OR REPLACE FUNCTION platform.lock_record_allocations(entity text,record uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  PERFORM north_star_internal.booking_require_isolation();
  PERFORM FROM platform.booking_resources d
   WHERE d.tenant_id=north_star_internal.trusted_tenant_id() AND d.environment_id=north_star_internal.trusted_environment_id()
     AND ((d.entity_id,d.record_id)=(entity,record) OR EXISTS
       (SELECT FROM platform.booking_owner_cursors o JOIN platform.booking_commitments f USING (tenant_id,environment_id,owner_key)
         WHERE (o.tenant_id,o.environment_id,o.entity_id,o.record_id)=(d.tenant_id,d.environment_id,entity,record)
           AND f.resource_key=d.resource_key AND f.state IN ('hold','confirmed','inUse')))
   ORDER BY d.resource_key FOR UPDATE OF d; END $$;

CREATE OR REPLACE FUNCTION north_star_internal.require_record_archivable(entity text,record uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  PERFORM north_star_internal.booking_require_isolation();
  IF EXISTS (SELECT FROM platform.booking_commitments f JOIN platform.booking_resources d USING (tenant_id,environment_id,resource_key)
    JOIN platform.booking_owner_cursors o USING (tenant_id,environment_id,owner_key)
    WHERE f.tenant_id=north_star_internal.trusted_tenant_id() AND f.environment_id=north_star_internal.trusted_environment_id()
      AND ((d.entity_id,d.record_id)=(entity,record) OR (o.entity_id,o.record_id)=(entity,record))
      AND f.state IN ('hold','confirmed','inUse')) THEN RAISE EXCEPTION 'booking.activeAllocation'; END IF; END $$;

-- Charge overdue possession throughout the proposed window. An overrun can
-- block new work without invalidating a later commitment that was already made.
CREATE FUNCTION north_star_internal.booking_check_remaining(d platform.booking_resources,decision timestamptz,proposed tstzrange)
RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NOT EXISTS (SELECT FROM platform.booking_commitments WHERE resource_key=d.resource_key AND state='inUse'
    AND upper(occupied_interval)<=decision) THEN RETURN; END IF;
  IF EXISTS (
    WITH demands AS (
      SELECT CASE WHEN state='inUse' AND upper(occupied_interval)<=decision THEN tstzrange(decision,NULL,'[)')
        ELSE occupied_interval END AS win,coalesce(out_quantity,quantity) AS qty FROM platform.booking_commitments
      WHERE resource_key=d.resource_key AND state IN ('hold','confirmed','inUse')),
    boundaries AS (
      SELECT lower(proposed) AS at UNION SELECT lower(win) FROM demands WHERE proposed @> lower(win)
      UNION SELECT upper(win) FROM demands WHERE proposed @> upper(win)
      UNION SELECT valid_from FROM platform.booking_pool_capacity WHERE resource_key=d.resource_key AND proposed @> valid_from
      UNION SELECT valid_to FROM platform.booking_pool_capacity WHERE resource_key=d.resource_key AND proposed @> valid_to)
    SELECT FROM boundaries b WHERE (SELECT coalesce(sum(qty),0) FROM demands WHERE win @> b.at)>
      CASE WHEN d.kind='unit' THEN 1 ELSE coalesce((SELECT quantity FROM platform.booking_pool_capacity WHERE
        resource_key=d.resource_key AND tstzrange(valid_from,valid_to,'[)') @> b.at),0) END)
    THEN RAISE EXCEPTION 'booking.capacityTaken'; END IF; END $$;
REVOKE ALL ON FUNCTION north_star_internal.booking_check_remaining(platform.booking_resources,timestamptz,tstzrange) FROM PUBLIC;

ALTER TABLE platform.booking_commitments ADD COLUMN import_source_key text;
CREATE UNIQUE INDEX booking_import_source ON platform.booking_commitments(owner_key,slot_id,import_source_key)
  WHERE import_source_key IS NOT NULL;

CREATE FUNCTION north_star_internal.booking_import(own platform.booking_owner_cursors,d platform.booking_resources,binding jsonb,
  input jsonb,calendar jsonb,decision timestamptz)
RETURNS platform.booking_commitments LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE f platform.booking_commitments; term record; minimum_time timestamptz;
  ev platform.booking_use_revisions; source jsonb; leg_diary platform.booking_resources; live_diary platform.booking_resources:=d; qty numeric; open_count integer:=0;
  previous_end timestamptz; started boolean:=false; BEGIN
  IF input->>'sourceKey' IS NULL OR length(trim(input->>'sourceKey')) NOT BETWEEN 1 AND 240 OR
    nullif(trim(input->>'evidence'),'') IS NULL OR input->>'state' IS NULL OR input->>'state' NOT IN ('confirmed','inUse')
    OR input->>'earliestEvidenceAt' IS NULL OR input->'interval'->>'kind' NOT IN ('date','time') OR
    jsonb_typeof(input->'actuals') IS DISTINCT FROM 'array' OR jsonb_array_length(input->'actuals')>128
    THEN RAISE EXCEPTION 'booking.invalidImport'; END IF;
  minimum_time:=north_star_internal.booking_effective_instant(input->>'earliestEvidenceAt',decision,calendar->>'zone',2147483647,'reviewed import');
  SELECT * INTO term FROM north_star_internal.booking_resolve_window(input->'interval',calendar,'-infinity',NULL);
  qty:=(input->>'quantity')::numeric;
  IF qty IS NULL OR qty<=0 OR qty>='Infinity' OR trunc(qty,d.quantity_scale)<>qty OR (d.kind='unit' AND qty<>1) OR
    (input->>'state'='confirmed' AND upper(term.agreed)<=decision) OR
    (input->>'state'='inUse' AND binding->>'fulfilmentMode'<>'tracked') THEN RAISE EXCEPTION 'booking.invalidImport'; END IF;
  f.booking_id:=gen_random_uuid(); f.tenant_id:=own.tenant_id; f.environment_id:=own.environment_id;
  f.owner_key:=own.owner_key; f.slot_id:=binding->>'slotId'; f.binding:=binding; f.resource_key:=d.resource_key; f.kind:=d.kind;
  f.assigned_unit_key:=CASE WHEN d.kind='unit' THEN d.resource_key END; f.fulfilment_mode:=binding->>'fulfilmentMode';
  f.agreed_interval:=term.agreed; f.occupied_interval:=CASE WHEN lower(term.agreed)<decision AND decision<upper(term.agreed)
    THEN tstzrange(decision,upper(term.agreed),'[)') ELSE term.agreed END;
  f.calendar:=calendar; f.entered_interval:=input->'interval'; f.quantity:=qty; f.unit:=d.unit;
  f.state:=input->>'state'; f.deadline:=upper(term.agreed); f.revision:=1; f.import_source_key:=input->>'sourceKey';
  FOR source IN SELECT value FROM jsonb_array_elements(input->'actuals') ORDER BY (value->>'start')::timestamptz LOOP
    IF source->>'start' IS NULL OR NOT(source ? 'end') OR source->>'kind' IS NULL OR source->>'kind' NOT IN ('use','pause') OR
      f.fulfilment_mode<>'tracked' THEN RAISE EXCEPTION 'booking.invalidImport'; END IF;
    ev:=NULL; ev.evidence_kind:=source->>'kind';
    ev.effective_start:=north_star_internal.booking_effective_instant(source->>'start',decision,calendar->>'zone',2147483647,'reviewed import');
    ev.effective_end:=CASE WHEN source->>'end' IS NOT NULL THEN
      north_star_internal.booking_effective_instant(source->>'end',decision,calendar->>'zone',2147483647,'reviewed import') END;
    IF ev.effective_start<minimum_time OR ev.effective_end<ev.effective_start THEN RAISE EXCEPTION 'booking.invalidImport'; END IF;
    IF ev.evidence_kind='use' THEN
      IF (started AND (previous_end IS NULL OR previous_end>ev.effective_start)) THEN RAISE EXCEPTION 'booking.inconsistentTimeline'; END IF;
      leg_diary:=d;
      IF source ? 'resourceId' THEN
        SELECT * INTO STRICT leg_diary FROM platform.booking_resources WHERE (tenant_id,environment_id,entity_id,record_id)=
          (d.tenant_id,d.environment_id,d.entity_id,(source->>'resourceId')::uuid);
        IF d.kind='pool' AND leg_diary.resource_key<>d.resource_key THEN RAISE EXCEPTION 'booking.invalidImport'; END IF; END IF;
      ev.quantity:=(source->>'quantity')::numeric; ev.unit:=leg_diary.unit; ev.resource_key:=leg_diary.resource_key;
      IF ev.quantity IS NULL OR ev.quantity<=0 OR ev.quantity>qty OR trunc(ev.quantity,d.quantity_scale)<>ev.quantity OR
        (d.kind='unit' AND ev.quantity<>1) THEN RAISE EXCEPTION 'booking.invalidQuantity'; END IF;
      PERFORM north_star_internal.booking_check_use(f,leg_diary,NULL,ev.effective_start,coalesce(ev.effective_end,decision),ev.quantity);
      IF ev.effective_end IS NULL THEN open_count:=open_count+1; f.out_quantity:=ev.quantity; live_diary:=leg_diary; END IF;
      PERFORM north_star_internal.booking_write_evidence(f,ev,decision);
      IF d.kind='unit' THEN ev.evidence_kind:='assignment'; ev.unit:=NULL; ev.quantity:=NULL;
        PERFORM north_star_internal.booking_write_evidence(f,ev,decision); END IF;
      started:=true; previous_end:=ev.effective_end;
    ELSE
      ev.reason:=source->>'pauseReason';
      IF ev.reason IS NULL OR ev.reason NOT IN ('operatorRequested','serviceInterrupted') THEN RAISE EXCEPTION 'booking.invalidPause'; END IF;
      PERFORM north_star_internal.booking_write_evidence(f,ev,decision); END IF; END LOOP;
  IF (f.state='inUse' AND open_count<>1) OR (f.state='confirmed' AND started) THEN RAISE EXCEPTION 'booking.invalidImport'; END IF;
  IF EXISTS (WITH evidence AS (SELECT * FROM north_star_internal.booking_current_evidence(f))
    SELECT FROM evidence p WHERE p.evidence_kind='pause' AND (NOT coalesce((SELECT
      range_agg(tstzrange(u.effective_start,u.effective_end,'[)')) @> tstzrange(p.effective_start,p.effective_end,'[)')
      FROM evidence u WHERE u.evidence_kind='use'),false) OR EXISTS (SELECT FROM evidence other
        WHERE other.evidence_kind='pause' AND other.evidence_id<>p.evidence_id AND
        tstzrange(other.effective_start,other.effective_end,'[)') && tstzrange(p.effective_start,p.effective_end,'[)'))))
    THEN RAISE EXCEPTION 'booking.inconsistentTimeline'; END IF;
  IF f.state='inUse' THEN
    f.requested_resource_key:=d.resource_key; f.resource_key:=live_diary.resource_key;
    f.assigned_unit_key:=CASE WHEN d.kind='unit' THEN live_diary.resource_key END;
    PERFORM north_star_internal.booking_check_handover(live_diary,f,decision,false); END IF;
  INSERT INTO platform.booking_commitments SELECT (f).*;
  RETURN f; END $$;
REVOKE ALL ON FUNCTION north_star_internal.booking_import(platform.booking_owner_cursors,platform.booking_resources,jsonb,jsonb,jsonb,timestamptz) FROM PUBLIC;

CREATE FUNCTION north_star_internal.booking_apply_kit(t uuid,e uuid,r uuid,fence_number bigint,group_op jsonb,key uuid,input jsonb,actor jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp SET timezone='UTC' AS $$
DECLARE
  binding jsonb:=group_op->'booking'; command text:=binding->>'operation'; action text:=group_op->>'operationId';
  principal uuid:=nullif(current_setting('north_star.principal_id',true),'')::uuid;
  catalog jsonb:=north_star_internal.booking_projection(t,e,r,'operationCatalogPayload');
  storage jsonb:=north_star_internal.booking_projection(t,e,r,'storageTargetPayload');
  m jsonb; member_op jsonb; slot jsonb; plans jsonb:='[]'; plan jsonb; prepared jsonb:='[]';
  group_id_arg uuid:=CASE WHEN command='hold' THEN gen_random_uuid() ELSE (input->>'groupId')::uuid END;
  d platform.booking_resources; f platform.booking_commitments; o platform.booking_owner_cursors;
  diary_keys uuid[]:='{}'; cursors uuid[]:='{}'; company uuid; group_company uuid; company_set boolean:=false;
  root_found boolean:=false; target_id uuid; owner_id uuid; owner_revision bigint; owner_table text;
  previous_receipt platform.booking_receipts; approval platform.booking_approval_grants;
  policy_version text; decision timestamptz; kit_deadline timestamptz; term record; qty numeric; calendar jsonb;
  member_count integer; n integer; expected jsonb; inserted platform.booking_commitments; BEGIN
  PERFORM north_star_internal.booking_require_isolation();
  IF jsonb_typeof(input->'members') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'booking.invalidGroup'; END IF;
  member_count:=jsonb_array_length(input->'members');
  IF member_count NOT BETWEEN 2 AND 20 OR group_id_arg IS NULL OR (command='hold' AND input ? 'groupId')
    OR command NOT IN ('hold','confirm','cancel') THEN RAISE EXCEPTION 'booking.invalidGroup'; END IF;
  FOR m IN SELECT value FROM jsonb_array_elements(input->'members')
    ORDER BY value->>'resourceId',value->>'operationId',value->>'recordId' LOOP
    IF NOT coalesce((binding->'memberOperations') ? (m->>'operationId'),false) THEN RAISE EXCEPTION 'booking.invalidGroup'; END IF;
    SELECT value INTO STRICT member_op FROM jsonb_array_elements(catalog->'operations') WHERE value->>'operationId'=m->>'operationId'
      AND value->>'lifecycle'='active' AND value#>>'{effect,capability,targetId}'='northstar.booking:capability.commitments'
      AND value#>>'{booking,bindingVersion}'='booking.commitment/v1' AND value#>>'{booking,operation}'=command;
    slot:=member_op->'booking'; owner_id:=(m->>'recordId')::uuid;
    IF command='hold' THEN
      target_id:=(m->>'resourceId')::uuid;
    ELSE
      SELECT d1.record_id INTO STRICT target_id FROM platform.booking_commitments c JOIN platform.booking_resources d1 USING(resource_key)
        JOIN platform.booking_owner_cursors o1 USING(owner_key) WHERE (c.tenant_id,c.environment_id,c.group_id,c.booking_id)=(t,e,group_id_arg,(m->>'bookingId')::uuid)
        AND (c.slot_id,d1.entity_id,o1.entity_id,o1.record_id)=(slot->>'slotId',slot->>'resourceEntity',slot->>'ownerEntity',owner_id); END IF;
    d:=north_star_internal.booking_register_resource(t,e,storage,slot,target_id); diary_keys:=array_append(diary_keys,d.resource_key);
    plans:=plans||jsonb_build_array(jsonb_build_object('member',m,'binding',slot,'target',target_id,'diary',d.resource_key,
      'permission',member_op->'permissionId','excludedRoles',coalesce(member_op->'excludedRoleKeys','[]'))); END LOOP;
  diary_keys:=north_star_internal.booking_lock_diaries(diary_keys);
  PERFORM pg_advisory_xact_lock(hashtextextended(t::text||e::text||key::text,0));
  PERFORM north_star_internal.booking_lock_kit_endpoints(t,e,storage,plans);
  policy_version:=platform.lock_current_policy_epoch(t,e)::text;
  IF actor->>'policyVersion' IS DISTINCT FROM 'northstar.current-policy/'||policy_version THEN RAISE EXCEPTION 'booking.stalePolicy'; END IF;
  FOR plan IN SELECT value FROM jsonb_array_elements(plans) ORDER BY value#>>'{binding,ownerEntity}',value#>>'{member,recordId}' LOOP
    m:=plan->'member'; slot:=plan->'binding'; owner_id:=(m->>'recordId')::uuid;
    SELECT * INTO STRICT d FROM platform.booking_resources WHERE resource_key=(plan->>'diary')::uuid;
    company:=north_star_internal.booking_endpoint(t,e,storage,slot->>'ownerEntity',owner_id,false);
    IF (company_set AND company IS DISTINCT FROM group_company) OR (d.company_id IS NOT NULL AND d.company_id IS DISTINCT FROM company)
      OR north_star_internal.booking_endpoint(t,e,storage,d.entity_id,d.record_id,false) IS DISTINCT FROM d.company_id
      OR (d.kind,d.unit,d.quantity_scale) IS DISTINCT FROM (slot->>'kind',slot->>'unit',(slot->>'scale')::integer)
      THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END IF;
    IF (m->>'recordId',slot->>'ownerEntity')=(input->>'recordId',binding->>'ownerEntity') THEN
      IF m->'expectedOwnerRevision' IS DISTINCT FROM input->'expectedOwnerRevision' THEN RAISE EXCEPTION 'booking.staleOwnerRevision'; END IF;
      root_found:=true; END IF;
    group_company:=company; company_set:=true;
    PERFORM north_star_internal.booking_require_permission(t,e,principal,company,plan->>'permission',slot->>'ownerEntity',plan->'excludedRoles');
    PERFORM north_star_internal.booking_require_permission(t,e,principal,company,slot->>'ownerReadPermission',slot->>'ownerEntity');
    PERFORM north_star_internal.booking_require_permission(t,e,principal,d.company_id,slot->>'resourceReadPermission',d.entity_id);
    INSERT INTO platform.booking_owner_cursors(tenant_id,environment_id,company_id,entity_id,record_id)
      VALUES(t,e,company,slot->>'ownerEntity',owner_id) ON CONFLICT DO NOTHING;
    SELECT * INTO STRICT o FROM platform.booking_owner_cursors WHERE (tenant_id,environment_id,entity_id,record_id)=(t,e,slot->>'ownerEntity',owner_id)
      AND company_id IS NOT DISTINCT FROM company;
    cursors:=array_append(cursors,o.owner_key); prepared:=prepared||jsonb_build_array(plan||jsonb_build_object('ownerKey',o.owner_key)); END LOOP;
  IF NOT root_found OR (SELECT count(DISTINCT (p->>'ownerKey',p#>>'{binding,slotId}')) FROM jsonb_array_elements(prepared) p)<>member_count
    THEN RAISE EXCEPTION 'booking.invalidGroup'; END IF;
  PERFORM north_star_internal.booking_require_permission(t,e,principal,group_company,group_op->>'permissionId',binding->>'ownerEntity',coalesce(group_op->'excludedRoleKeys','[]'));
  PERFORM north_star_internal.booking_require_permission(t,e,principal,group_company,binding->>'ownerReadPermission',binding->>'ownerEntity');
  IF group_op->>'confirmation'='humanRequired' OR actor->>'channel'='WORKFLOW' THEN
    SELECT g.* INTO approval FROM platform.booking_approval_grants g WHERE g.grant_id=(actor->>'approvalGrantId')::uuid
      AND (g.tenant_id,g.environment_id,g.principal_id,g.release_id,g.fence,g.operation_id,g.request_key,g.input,g.channel)=
        (t,e,principal,r,fence_number,action,key,booking_apply_kit.input,actor->>'channel') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'booking.approvalRequired'; END IF;
    actor:=actor||jsonb_build_object('approvingHumanId',approval.human_id); END IF;
  SELECT * INTO previous_receipt FROM platform.booking_receipts WHERE NOT system_expiry AND (tenant_id,environment_id,request_key)=(t,e,key);
  IF FOUND THEN
    IF (previous_receipt.actor_id,previous_receipt.release_id,previous_receipt.operation_id,previous_receipt.input) IS DISTINCT FROM (principal,r,action,input)
      THEN RAISE EXCEPTION 'booking.requestKeyConflict'; END IF;
    RETURN previous_receipt.result; END IF;
  IF approval.consumed THEN RAISE EXCEPTION 'booking.approvalSpent'; END IF;
  IF approval.grant_id IS NOT NULL THEN UPDATE platform.booking_approval_grants SET consumed=true WHERE grant_id=approval.grant_id; END IF;
  PERFORM FROM platform.booking_owner_cursors oc WHERE oc.owner_key=ANY(cursors) OR EXISTS(SELECT FROM platform.booking_commitments b
    WHERE b.resource_key=ANY(diary_keys) AND b.state IN ('hold','confirmed') AND b.owner_key=oc.owner_key) ORDER BY oc.owner_key FOR UPDATE;
  SELECT greatest(north_star_internal.booking_now(),max(decision_floor)) INTO decision FROM platform.booking_resources WHERE resource_key=ANY(diary_keys);
  UPDATE platform.booking_resources SET decision_floor=decision WHERE resource_key=ANY(diary_keys);
  FOR d IN SELECT * FROM platform.booking_resources WHERE resource_key=ANY(diary_keys) ORDER BY resource_key LOOP
    PERFORM north_star_internal.booking_expire(d.resource_key,decision); END LOOP;
  /* A failed last member rolls back every proposed change, after committing any independently due history. */ BEGIN
    IF command<>'hold' AND (SELECT count(*) FROM platform.booking_commitments c WHERE
      (c.tenant_id,c.environment_id,c.group_id)=(t,e,group_id_arg))<>member_count THEN RAISE EXCEPTION 'booking.invalidGroup'; END IF;
    SELECT jsonb_build_object('id',tenant_id,'zone',time_zone,'boundary',business_day_boundary) INTO STRICT calendar
      FROM platform.inventory_tenant_calendars WHERE tenant_id=t;
    FOR plan IN SELECT value FROM jsonb_array_elements(prepared) LOOP
      m:=plan->'member'; slot:=plan->'binding';
      SELECT value->>'physicalTableName' INTO STRICT owner_table FROM jsonb_array_elements(storage->'entities') WHERE value->>'entityId'=slot->>'ownerEntity';
      EXECUTE format('SELECT revision FROM north_star_module.%I WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3',owner_table)
        INTO STRICT owner_revision USING t,e,(m->>'recordId')::uuid;
      IF owner_revision IS DISTINCT FROM (m->>'expectedOwnerRevision')::bigint THEN RAISE EXCEPTION 'booking.staleOwnerRevision'; END IF;
      IF command='hold' THEN
        SELECT * INTO STRICT d FROM platform.booking_resources WHERE resource_key=(plan->>'diary')::uuid;
        qty:=(m->>'quantity')::numeric;
        IF qty IS NULL OR qty<=0 OR qty>='Infinity' OR trunc(qty,d.quantity_scale)<>qty OR (d.kind='unit' AND qty<>1) THEN RAISE EXCEPTION 'booking.invalidQuantity'; END IF;
        SELECT * INTO term FROM north_star_internal.booking_resolve_window(m->'interval',calendar,decision,NULL);
        kit_deadline:=least(kit_deadline,upper(term.occupied),decision+make_interval(secs=>(slot->>'holdSeconds')::integer));
        INSERT INTO platform.booking_commitments(tenant_id,environment_id,owner_key,slot_id,resource_key,kind,assigned_unit_key,
          group_id,group_kind,fulfilment_mode,binding,calendar,entered_interval,agreed_interval,occupied_interval,quantity,unit,state,deadline,revision)
        VALUES(t,e,(plan->>'ownerKey')::uuid,slot->>'slotId',d.resource_key,d.kind,CASE WHEN d.kind='unit' THEN d.resource_key END,
          group_id_arg,'kit',slot->>'fulfilmentMode',slot,calendar,m->'interval',term.agreed,term.occupied,qty,d.unit,'hold',kit_deadline,1)
          RETURNING * INTO STRICT inserted;
        IF (inserted.tenant_id,inserted.environment_id,inserted.owner_key,inserted.slot_id,inserted.resource_key,inserted.kind,
          inserted.group_id,inserted.group_kind,inserted.fulfilment_mode,inserted.binding,inserted.calendar,inserted.entered_interval,
          inserted.agreed_interval,inserted.occupied_interval,inserted.quantity,inserted.unit,inserted.state,inserted.deadline,inserted.revision)
          IS DISTINCT FROM (t,e,(plan->>'ownerKey')::uuid,slot->>'slotId',d.resource_key,d.kind,group_id_arg,'kit'::text,
          slot->>'fulfilmentMode',slot,calendar,m->'interval',term.agreed,term.occupied,qty,d.unit,'hold'::text,kit_deadline,1)
          OR inserted.assigned_unit_key IS DISTINCT FROM (CASE WHEN d.kind='unit' THEN d.resource_key END)
          THEN RAISE EXCEPTION 'booking.evidenceMismatch'; END IF;
      ELSE
        SELECT h.after_fact||jsonb_build_object('revision',h.revision+1,'state',CASE command WHEN 'confirm' THEN 'confirmed' ELSE 'cancelled' END)
          INTO expected FROM platform.booking_history h WHERE (h.tenant_id,h.environment_id,h.booking_id,h.revision)=
            (t,e,(m->>'bookingId')::uuid,(m->>'bookingRevision')::integer);
        UPDATE platform.booking_commitments c SET state=CASE command WHEN 'confirm' THEN 'confirmed' ELSE 'cancelled' END,revision=c.revision+1
          WHERE (c.tenant_id,c.environment_id,c.group_id,c.booking_id,c.owner_key,c.resource_key,c.revision)=
            (t,e,group_id_arg,(m->>'bookingId')::uuid,(plan->>'ownerKey')::uuid,(plan->>'diary')::uuid,(m->>'bookingRevision')::integer)
            AND (c.state='hold' OR (command='cancel' AND c.state='confirmed')) RETURNING * INTO inserted;
        IF NOT FOUND THEN RAISE EXCEPTION 'booking.staleRevision'; END IF;
        IF to_jsonb(inserted) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'booking.evidenceMismatch'; END IF; END IF; END LOOP;
    IF command='hold' THEN
      UPDATE platform.booking_commitments c SET deadline=kit_deadline WHERE (c.tenant_id,c.environment_id,c.group_id)=(t,e,group_id_arg);
      GET DIAGNOSTICS n=ROW_COUNT;
      IF n<>member_count OR EXISTS(SELECT FROM platform.booking_commitments c WHERE
        (c.tenant_id,c.environment_id,c.group_id)=(t,e,group_id_arg) AND c.deadline IS DISTINCT FROM kit_deadline)
        THEN RAISE EXCEPTION 'booking.evidenceMismatch'; END IF;
      FOR f IN SELECT * FROM platform.booking_commitments c WHERE (c.tenant_id,c.environment_id,c.group_id)=(t,e,group_id_arg) LOOP
        SELECT * INTO STRICT d FROM platform.booking_resources WHERE resource_key=f.resource_key;
        IF d.kind='pool' THEN PERFORM north_star_internal.booking_check_capacity(d.resource_key); END IF;
        PERFORM north_star_internal.booking_check_remaining(d,decision,f.occupied_interval); END LOOP; END IF;
    RETURN north_star_internal.booking_record_kit(t,e,group_id_arg,r,actor,action,key,input,decision,decision);
  EXCEPTION WHEN exclusion_violation THEN RETURN jsonb_build_object('refused','booking.noLongerAvailable');
    WHEN unique_violation THEN IF SQLERRM LIKE '%booking_live_owner_slot%' THEN RETURN jsonb_build_object('refused','booking.slotOccupied'); ELSE RAISE; END IF;
    WHEN raise_exception THEN IF SQLERRM LIKE 'booking.%' AND SQLERRM<>'booking.evidenceMismatch' THEN RETURN jsonb_build_object('refused',SQLERRM); ELSE RAISE; END IF; END;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END $$;
REVOKE ALL ON FUNCTION north_star_internal.booking_apply_kit(uuid,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb) FROM PUBLIC;

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
  latest integer; policy_version text; owner_table text; owner_revision bigint; approval platform.booking_approval_grants;
  dest platform.booking_resources; keys uuid[]; endpoint_keys uuid[]; imported_target uuid; locked_diary platform.booking_resources; effective timestamptz; BEGIN
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
  IF released_binding->>'bindingVersion'='booking.kit/v1' THEN
    IF command<>'hold' AND op->>'confirmation' IS DISTINCT FROM 'humanRequired' THEN RAISE EXCEPTION 'booking.unsupportedBinding'; END IF;
    RETURN north_star_internal.booking_apply_kit(t,e,r,expected_fence,op,key,input,actor); END IF;
  IF released_binding->>'kind' IS NULL OR released_binding->>'kind' NOT IN ('pool','unit') OR command IS NULL OR
    (CASE released_binding->>'bindingVersion'
      WHEN 'booking.commitment/v1' THEN command NOT IN ('hold','confirm','cancel','changeInterval','setCapacity')
      WHEN 'booking.fulfilment/v1' THEN command NOT IN ('start','return','pause','resume','changeQuantity','noShow','swap','correctActuals','recordExisting')
      ELSE true END) OR (command<>'hold' AND op->>'confirmation' IS DISTINCT FROM 'humanRequired')
    THEN RAISE EXCEPTION 'booking.unsupportedBinding'; END IF;
  storage := north_star_internal.booking_projection(t,e,r,'storageTargetPayload');
  -- Discovery reads identities only. Recheck the endpoints, including parents, under locks below.
  IF command NOT IN ('hold','setCapacity','recordExisting') THEN
    SELECT d.record_id INTO STRICT target FROM platform.booking_commitments f
      JOIN platform.booking_resources d USING (tenant_id,environment_id,resource_key)
      JOIN platform.booking_owner_cursors o USING (tenant_id,environment_id,owner_key)
      WHERE (f.tenant_id,f.environment_id,f.booking_id)=(t,e,(input->>'bookingId')::uuid)
        AND o.record_id=owner_id AND o.entity_id=released_binding->>'ownerEntity' AND f.slot_id=released_binding->>'slotId'
        AND d.entity_id=released_binding->>'resourceEntity'; END IF;
  IF command='recordExisting' THEN
    IF jsonb_typeof(input->'actuals') IS DISTINCT FROM 'array' OR jsonb_array_length(input->'actuals')>128 THEN RAISE EXCEPTION 'booking.invalidImport'; END IF;
    FOR imported_target IN SELECT target UNION SELECT (value->>'resourceId')::uuid FROM jsonb_array_elements(input->'actuals')
      WHERE value ? 'resourceId' ORDER BY 1 LOOP
      locked_diary:=north_star_internal.booking_register_resource(t,e,storage,released_binding,imported_target);
      keys:=array_append(keys,locked_diary.resource_key); END LOOP; END IF;
  diary:=north_star_internal.booking_register_resource(t,e,storage,released_binding,target);
  IF command='swap' THEN
    dest:=north_star_internal.booking_register_resource(t,e,storage,released_binding,(input->>'replacementResourceId')::uuid);
  ELSIF command='correctActuals' THEN
    SELECT d.* INTO dest FROM platform.booking_use_revisions u JOIN platform.booking_resources d ON d.resource_key=u.resource_key
      WHERE (u.tenant_id,u.environment_id,u.booking_id,u.evidence_id,u.revision)=
        (t,e,(input->>'bookingId')::uuid,(input->>'evidenceId')::uuid,(input->>'evidenceRevision')::integer); END IF;
  keys:=array_remove(keys||ARRAY[diary.resource_key,dest.resource_key],NULL);
  endpoint_keys:=keys; keys:=north_star_internal.booking_lock_diaries(keys);
  PERFORM pg_advisory_xact_lock(hashtextextended(t::text||e::text||key::text,0));
  IF cardinality(endpoint_keys)=1 THEN
    PERFORM north_star_internal.booking_lock_endpoints(t,e,storage,released_binding->>'ownerEntity',owner_id,released_binding->>'resourceEntity',target);
  ELSE PERFORM north_star_internal.booking_lock_resource_endpoints(t,e,storage,released_binding->>'ownerEntity',owner_id,endpoint_keys); END IF;
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
  IF command IN ('correctActuals','recordExisting') THEN
    PERFORM north_star_internal.booking_require_permission(t,e,principal,owner_company,released_binding->>'stewardPermission',released_binding->>'ownerEntity'); END IF;
  FOR locked_diary IN SELECT * FROM platform.booking_resources WHERE resource_key=ANY(endpoint_keys) AND resource_key<>diary.resource_key LOOP
    target_company:=north_star_internal.booking_endpoint(t,e,storage,locked_diary.entity_id,locked_diary.record_id,false);
    IF (locked_diary.kind,locked_diary.unit,locked_diary.quantity_scale) IS DISTINCT FROM (diary.kind,diary.unit,diary.quantity_scale)
      OR target_company IS DISTINCT FROM locked_diary.company_id OR (target_company IS NOT NULL AND target_company IS DISTINCT FROM owner_company)
      THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END IF;
    PERFORM north_star_internal.booking_require_permission(t,e,principal,target_company,released_binding->>'resourceReadPermission',locked_diary.entity_id); END LOOP;
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
    (SELECT FROM platform.booking_commitments f WHERE f.resource_key=ANY(keys) AND f.state IN ('hold','confirmed') AND f.owner_key=o.owner_key)
    ORDER BY o.owner_key FOR UPDATE;
  SELECT greatest(north_star_internal.booking_now(),max(decision_floor)) INTO decision FROM platform.booking_resources WHERE resource_key=ANY(keys);
  UPDATE platform.booking_resources SET decision_floor=decision WHERE resource_key=ANY(keys);
  FOR locked_diary IN SELECT * FROM platform.booking_resources WHERE resource_key=ANY(keys) ORDER BY resource_key LOOP
    PERFORM north_star_internal.booking_expire(locked_diary.resource_key,decision); END LOOP;
  effective:=decision; BEGIN
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
      IF capacity.revision IS NOT NULL AND amount<capacity.quantity THEN
        PERFORM north_star_internal.booking_check_remaining(diary,decision,tstzrange(decision,NULL,'[)'));
        IF amount<(SELECT coalesce(sum(out_quantity),0) FROM platform.booking_commitments WHERE resource_key=diary.resource_key AND state='inUse')
          THEN RAISE EXCEPTION 'booking.capacityTaken'; END IF; END IF;
      RETURN north_star_internal.booking_evidence(t,e,r,actor,action,key,input,receipt,diary.resource_key,latest+1,
        to_jsonb(capacity),to_jsonb(amount),decision,'booking.capacityChanged',
        jsonb_build_object('resourceKey',diary.resource_key,'capacityRevision',latest+1,'validFrom',decision,'validTo',null),
        jsonb_build_object('resourceKey',diary.resource_key,'revision',latest+1)); END IF;
    IF command='recordExisting' THEN
      IF expected_rev IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'booking.staleRevision'; END IF;
      SELECT b.* INTO prior_receipt FROM platform.booking_commitments f JOIN platform.booking_history h USING (tenant_id,environment_id,booking_id)
        JOIN platform.booking_receipts b USING (tenant_id,environment_id,receipt_id)
        WHERE f.owner_key=owner_row.owner_key AND f.slot_id=released_binding->>'slotId' AND f.import_source_key=booking_apply.input->>'sourceKey' AND h.revision=1;
      IF FOUND THEN
        IF (prior_receipt.actor_id,prior_receipt.release_id,prior_receipt.operation_id,prior_receipt.input) IS DISTINCT FROM (principal,r,action,input)
          THEN RAISE EXCEPTION 'booking.sourceConflict'; END IF;
        RETURN prior_receipt.result; END IF;
      SELECT jsonb_build_object('id',tenant_id,'zone',time_zone,'boundary',business_day_boundary) INTO STRICT calendar
        FROM platform.inventory_tenant_calendars WHERE tenant_id=t;
      fact:=north_star_internal.booking_import(owner_row,diary,released_binding,input,calendar,decision);
    ELSIF command='hold' THEN
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
      IF prior_fact.group_id IS NOT NULL AND command IN ('confirm','cancel','changeInterval') THEN RAISE EXCEPTION 'booking.groupOperationRequired'; END IF;
      IF prior_fact.state IN ('cancelled','completed','noShow','returned') AND command<>'correctActuals'
        AND NOT (prior_fact.state='noShow' AND prior_fact.fulfilment_mode='tracked' AND command='start')
        THEN RAISE EXCEPTION 'booking.closed'; END IF;
      IF expected_rev IS DISTINCT FROM prior_fact.revision THEN RAISE EXCEPTION 'booking.staleRevision'; END IF;
      IF command='confirm' AND prior_fact.state<>'hold' THEN RAISE EXCEPTION 'booking.invalidState'; END IF;
      IF released_binding->>'bindingVersion'='booking.fulfilment/v1' THEN
        effective:=north_star_internal.booking_effective_instant(input->>'effectiveAt',decision,prior_fact.calendar->>'zone',(prior_fact.binding->>'maxBackdateDays')::integer,input->>'reason');
        fact:=north_star_internal.booking_fulfil(prior_fact,diary,dest,command,input,released_binding,decision,effective);
      ELSIF command='changeInterval' THEN
        SELECT * INTO term FROM north_star_internal.booking_resolve_window(input->'interval',prior_fact.calendar,decision,prior_fact.agreed_interval);
        UPDATE platform.booking_commitments SET agreed_interval=term.agreed,occupied_interval=term.occupied,entered_interval=input->'interval',
          deadline=least(deadline,upper(term.occupied)),revision=revision+1 WHERE (tenant_id,environment_id,booking_id)=(t,e,prior_fact.booking_id) RETURNING * INTO STRICT fact;
      ELSE
        IF command='cancel' AND prior_fact.state NOT IN ('hold','confirmed') THEN RAISE EXCEPTION 'booking.invalidState'; END IF;
        UPDATE platform.booking_commitments SET state=CASE WHEN command='confirm' THEN 'confirmed' ELSE 'cancelled' END,
          revision=revision+1 WHERE (tenant_id,environment_id,booking_id)=(t,e,prior_fact.booking_id) RETURNING * INTO STRICT fact; END IF; END IF;
    IF command IN ('hold','changeQuantity','changeInterval','swap','recordExisting') AND upper(fact.occupied_interval)>decision THEN
      PERFORM north_star_internal.booking_check_remaining(CASE WHEN command='swap' THEN dest ELSE diary END,
        decision,tstzrange(greatest(decision,lower(fact.occupied_interval)),upper(fact.occupied_interval),'[)')); END IF;
    IF diary.kind='pool' THEN PERFORM north_star_internal.booking_check_capacity(diary.resource_key); END IF;
    result := north_star_internal.booking_record_change(prior_fact,fact,r,actor,action,key,input,input->>'reason',effective,decision);
    RETURN result;
  EXCEPTION WHEN exclusion_violation THEN IF command='start' THEN RETURN jsonb_build_object('refused','booking.capacityTaken'); END IF; RETURN jsonb_build_object('refused','booking.noLongerAvailable');
    WHEN unique_violation THEN IF SQLERRM LIKE '%booking_open_unit%' THEN RETURN jsonb_build_object('refused','booking.capacityTaken'); END IF; IF SQLERRM LIKE '%booking_live_owner_slot%' THEN RETURN jsonb_build_object('refused','booking.slotOccupied'); ELSE RAISE; END IF;
    WHEN raise_exception THEN IF SQLERRM LIKE 'booking.%' AND SQLERRM <> 'booking.evidenceMismatch' THEN RETURN jsonb_build_object('refused',SQLERRM); ELSE RAISE; END IF; END;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END $$;

-- The release binds two independently granted reads on the same stored owner:
-- access to its detail and access to its complete service evidence.
CREATE FUNCTION north_star_internal.booking_usage_owner(r uuid,fence_number bigint,qid text,id uuid)
RETURNS platform.booking_owner_cursors LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  principal uuid:=nullif(current_setting('north_star.principal_id',true),'')::uuid;
  catalog jsonb; usage_query jsonb; owner_query jsonb; owner_row platform.booking_owner_cursors; company uuid; BEGIN
  IF principal IS NULL OR NOT EXISTS (SELECT FROM platform.active_release_pointers
    WHERE (tenant_id,environment_id,release_id,fence)=(t,e,r,fence_number)) THEN RAISE EXCEPTION 'booking.staleRelease'; END IF;
  SELECT convert_from(b.canonical_bytes,'UTF8')::jsonb INTO STRICT catalog
    FROM platform.tenant_release_chunk_links c JOIN platform.tenant_release_projection_links p USING (tenant_id,environment_id,release_id,projection_instance_id)
    JOIN platform.release_artifact_blobs b ON b.content_hash=c.chunk_hash AND b.artifact_kind='projectionChunk'
    WHERE (c.tenant_id,c.environment_id,c.release_id)=(t,e,r) AND p.projection_family_id='northstar.compiler:projection-family.query-catalog'
      AND convert_from(b.canonical_bytes,'UTF8')::jsonb->>'kind'='queryCatalogPayload';
  SELECT value INTO STRICT usage_query FROM jsonb_array_elements(catalog->'queries') WHERE value->>'queryId'=qid AND value->>'lifecycle'='active'
    AND value->>'queryType'='get' AND value->>'tier'='q2' AND value->'readModel'->'capability'->>'targetId'='northstar.booking:capability.owner_usage'
    AND value->'readModel'->>'binding'='northstar.booking:protocol.owner_usage_v1';
  SELECT value INTO STRICT owner_query FROM jsonb_array_elements(catalog->'queries') WHERE
    value->>'queryId'=usage_query#>>'{readModel,queries,owner,targetId}' AND value->>'lifecycle'='active' AND value->>'queryType'='get'
    AND value->>'tier'='q0' AND value->>'sourceEntityId'=usage_query->>'sourceEntityId' AND NOT (value ? 'readModel')
    AND value->>'permissionId'<>usage_query->>'permissionId';
  company:=north_star_internal.booking_endpoint(t,e,north_star_internal.booking_projection(t,e,r,'storageTargetPayload'),owner_query->>'sourceEntityId',id,false);
  PERFORM north_star_internal.booking_require_permission(t,e,principal,company,owner_query->>'permissionId',owner_query->>'sourceEntityId');
  PERFORM north_star_internal.booking_require_permission(t,e,principal,company,usage_query->>'permissionId',owner_query->>'sourceEntityId');
  SELECT * INTO owner_row FROM platform.booking_owner_cursors WHERE (tenant_id,environment_id,entity_id,record_id)=(t,e,owner_query->>'sourceEntityId',id);
  IF FOUND THEN
    IF owner_row.company_id IS DISTINCT FROM company THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END IF;
  ELSE
    owner_row.tenant_id:=t; owner_row.environment_id:=e; owner_row.entity_id:=owner_query->>'sourceEntityId';
    owner_row.company_id:=company; owner_row.record_id:=id; owner_row.cursor_value:=0; END IF;
  RETURN owner_row;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END $$;
REVOKE ALL ON FUNCTION north_star_internal.booking_usage_owner(uuid,bigint,text,uuid) FROM PUBLIC;

CREATE FUNCTION north_star_internal.booking_usage_terms(body jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp SET timezone='UTC' AS $$
  SELECT jsonb_build_object('bookingId',body->'booking_id','revision',body->'revision','slotId',body->'slot_id',
    'groupId',body->'group_id','groupKind',body->'group_kind','state',body->'state','fulfilmentMode',body->'fulfilment_mode',
    'requestedTarget',jsonb_build_object('kind',body->'kind','key',coalesce(body->>'requested_resource_key',body->>'resource_key')),
    'assignedUnitKey',body->'assigned_unit_key','agreed',jsonb_build_object('start',lower((body->>'agreed_interval')::tstzrange),
      'end',upper((body->>'agreed_interval')::tstzrange),'entered',body->'entered_interval','calendar',body->'calendar'),
    'occupied',jsonb_build_object('start',lower((body->>'occupied_interval')::tstzrange),'end',upper((body->>'occupied_interval')::tstzrange)),
    'quantity',body->>'quantity','unit',body->'unit')
$$;

CREATE FUNCTION north_star_internal.booking_usage_evidence(ev platform.booking_use_revisions)
RETURNS jsonb LANGUAGE sql STABLE STRICT SET search_path = pg_catalog, pg_temp SET timezone='UTC' AS $$
  SELECT jsonb_build_object('id',ev.evidence_id,'kind',ev.evidence_kind,'revision',ev.revision,'supersedes',ev.supersedes,
    'bookingId',ev.booking_id,'resourceKey',ev.resource_key,'effectiveStart',ev.effective_start,'effectiveEnd',ev.effective_end,
    'effectiveAt',coalesce(ev.effective_end,ev.effective_start),'recordedAt',ev.recorded_at,'quantity',ev.quantity::text,
    'unit',ev.unit,'reason',ev.reason,'voided',ev.voided)
$$;
REVOKE ALL ON FUNCTION north_star_internal.booking_usage_terms(jsonb),north_star_internal.booking_usage_evidence(platform.booking_use_revisions) FROM PUBLIC;

CREATE FUNCTION platform.booking_owner_usage(r uuid,fence_number bigint,qid text,id uuid,from_time timestamptz,until_time timestamptz,
  after_cursor bigint,high_water bigint,page_size integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET timezone='UTC' AS $$
DECLARE
  own platform.booking_owner_cursors; pinned bigint; delivered bigint; changes jsonb; bookings jsonb; use_rows jsonb;
  horizon tstzrange; as_of timestamptz:=statement_timestamp(); BEGIN
  own:=north_star_internal.booking_usage_owner(r,fence_number,qid,id);
  pinned:=coalesce(high_water,own.cursor_value);
  IF until_time IS NULL OR from_time IS NULL OR NOT isfinite(until_time) OR NOT isfinite(from_time) OR until_time<=from_time
    OR page_size IS NULL OR page_size NOT BETWEEN 1 AND 128 OR pinned NOT BETWEEN 0 AND own.cursor_value OR after_cursor NOT BETWEEN 0 AND pinned
    THEN RAISE EXCEPTION 'booking.invalidUsageWindow'; END IF;
  horizon:=tstzrange(from_time,until_time,'[)');
  -- Incremental corrections are delivered even when both boundaries precede the horizon.
  IF after_cursor IS NOT NULL THEN
    WITH page AS (SELECT DISTINCT h.cursor_value FROM platform.booking_history h WHERE h.owner_key=own.owner_key
      AND h.cursor_value>after_cursor AND h.cursor_value<=pinned ORDER BY h.cursor_value LIMIT page_size),
    events AS (SELECT h.* FROM platform.booking_history h JOIN page USING (cursor_value) WHERE h.owner_key=own.owner_key)
    SELECT coalesce(jsonb_agg(jsonb_build_object('cursor',h.cursor_value::text,'operation',h.operation,'receiptId',h.receipt_id,
      'before',north_star_internal.booking_usage_terms(h.before_fact),'after',north_star_internal.booking_usage_terms(h.after_fact),
      'effectiveAt',h.effective_at,'recordedAt',h.recorded_at,'evidence',coalesce((
        SELECT jsonb_agg(jsonb_build_object('before',north_star_internal.booking_usage_evidence(prev),
          'after',north_star_internal.booking_usage_evidence(ev)) ORDER BY ev.evidence_id) FROM platform.booking_use_revisions ev
        LEFT JOIN platform.booking_use_revisions prev ON (prev.tenant_id,prev.environment_id,prev.booking_id,prev.evidence_id,prev.revision)=
          (ev.tenant_id,ev.environment_id,ev.booking_id,ev.evidence_id,ev.supersedes)
        WHERE (ev.tenant_id,ev.environment_id,ev.booking_id,ev.booking_revision)=(h.tenant_id,h.environment_id,h.booking_id,h.revision)
      ),'[]'::jsonb)) ORDER BY h.cursor_value,h.booking_id),'[]'::jsonb),coalesce(max(h.cursor_value),after_cursor)
      INTO changes,delivered FROM events h;
  ELSE
    delivered:=pinned;
    IF (SELECT count(*) FROM (SELECT FROM platform.booking_history h WHERE h.owner_key=own.owner_key
        AND h.cursor_value<=pinned LIMIT 4097) bounded)>4096 THEN RAISE EXCEPTION 'booking.usageLimit'; END IF;
    -- Read immutable revisions at the high water. An open leg extends into the
    -- requested horizon even when the booking's finite agreement has ended.
    WITH history AS MATERIALIZED (SELECT h.* FROM platform.booking_history h WHERE h.owner_key=own.owner_key AND h.cursor_value<=pinned),
    evidence AS MATERIALIZED (SELECT DISTINCT ON (ev.booking_id,ev.evidence_id) ev.* FROM platform.booking_use_revisions ev
      JOIN history h ON (h.tenant_id,h.environment_id,h.booking_id,h.revision)=(ev.tenant_id,ev.environment_id,ev.booking_id,ev.booking_revision)
      ORDER BY ev.booking_id,ev.evidence_id,ev.revision DESC),
    relevant AS (SELECT booking_id FROM history WHERE (after_fact->>'agreed_interval')::tstzrange && horizon OR
      (after_fact->>'occupied_interval')::tstzrange && horizon UNION SELECT booking_id FROM evidence
      WHERE tstzrange(effective_start,effective_end,'[)') && horizon OR horizon @> effective_start),
    latest AS (SELECT DISTINCT ON (h.booking_id) h.* FROM history h JOIN relevant USING (booking_id) ORDER BY h.booking_id,h.revision DESC)
    SELECT (SELECT coalesce(jsonb_agg(north_star_internal.booking_usage_terms(l.after_fact)||jsonb_build_object('terms',(
      SELECT jsonb_agg(jsonb_build_object('terms',north_star_internal.booking_usage_terms(h.after_fact),'effectiveAt',h.effective_at,
        'recordedAt',h.recorded_at) ORDER BY h.revision) FROM history h WHERE h.booking_id=l.booking_id)) ORDER BY l.booking_id),'[]'::jsonb) FROM latest l),
      (SELECT coalesce(jsonb_agg(north_star_internal.booking_usage_evidence(ev) ORDER BY ev.booking_id,ev.evidence_id),'[]'::jsonb)
       FROM evidence ev JOIN relevant USING (booking_id)) INTO bookings,use_rows;
    changes:='[]'; END IF;
  IF octet_length((coalesce(bookings,'[]')||coalesce(use_rows,'[]')||changes)::text)>1048576 OR jsonb_array_length(coalesce(bookings,'[]'))>512
    THEN RAISE EXCEPTION 'booking.usageLimit'; END IF;
  RETURN jsonb_build_object('schemaVersion','booking.ownerUsage/v1','asOf',as_of,'ownerRef',jsonb_build_object('entityId',own.entity_id,'recordId',own.record_id),
    'ownerScope',CASE WHEN own.company_id IS NULL THEN '{"kind":"shared"}'::jsonb ELSE jsonb_build_object('kind','company','companyId',own.company_id) END,
    'cursor',delivered::text,'highWater',pinned::text,'hasMore',delivered<pinned,'changes',changes,
    'bookings',coalesce(bookings,'[]'),'evidence',coalesce(use_rows,'[]')); END $$;

CREATE FUNCTION platform.booking_owner_cursor_fence(r uuid,fence_number bigint,owners jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE own platform.booking_owner_cursors; entry jsonb; keys uuid[]:='{}'; result jsonb:='[]'; BEGIN
  PERFORM north_star_internal.booking_require_isolation();
  IF jsonb_typeof(owners) IS DISTINCT FROM 'array' OR jsonb_array_length(owners) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'booking.invalidLimit'; END IF;
  PERFORM FROM platform.active_release_pointers WHERE
    (tenant_id,environment_id,release_id,fence)=(north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),r,fence_number) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking.staleRelease'; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(owners) ORDER BY value->>'recordId',value->>'queryId' LOOP
    own:=north_star_internal.booking_usage_owner(r,fence_number,entry->>'queryId',(entry->>'recordId')::uuid);
    IF own.owner_key IS NULL THEN
      INSERT INTO platform.booking_owner_cursors(tenant_id,environment_id,company_id,entity_id,record_id) VALUES
        (own.tenant_id,own.environment_id,own.company_id,own.entity_id,own.record_id) ON CONFLICT DO NOTHING;
      SELECT owner_key INTO STRICT own.owner_key FROM platform.booking_owner_cursors o WHERE
        (o.tenant_id,o.environment_id,o.entity_id,o.record_id)=(own.tenant_id,own.environment_id,own.entity_id,own.record_id)
        AND o.company_id IS NOT DISTINCT FROM own.company_id; END IF;
    keys:=array_append(keys,own.owner_key); END LOOP;
  FOR own IN SELECT * FROM platform.booking_owner_cursors WHERE owner_key=ANY(keys) ORDER BY owner_key FOR UPDATE LOOP
    result:=result||jsonb_build_array(jsonb_build_object('ownerRef',jsonb_build_object('entityId',own.entity_id,'recordId',own.record_id),
      'cursor',own.cursor_value::text)); END LOOP;
  RETURN jsonb_build_object('schemaVersion','booking.ownerCursorFence/v1','owners',result); END $$;
REVOKE ALL ON FUNCTION platform.booking_owner_usage(uuid,bigint,text,uuid,timestamptz,timestamptz,bigint,bigint,integer),
  platform.booking_owner_cursor_fence(uuid,bigint,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.booking_owner_usage(uuid,bigint,text,uuid,timestamptz,timestamptz,bigint,bigint,integer),
  platform.booking_owner_cursor_fence(uuid,bigint,jsonb) TO north_star_runtime;
