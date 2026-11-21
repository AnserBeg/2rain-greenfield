-- Select historical occupation on the affected diary, including bookings later swapped away.
CREATE INDEX booking_history_resource ON platform.booking_history
  (tenant_id,environment_id,(after_fact->>'resource_key'),recorded_at);

CREATE OR REPLACE FUNCTION north_star_internal.booking_check_use(f platform.booking_commitments,d platform.booking_resources,
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
    -- Inside its original allocation the booking already held this capacity.
    -- A timed absence also releases the diary after the occupied end.
    planned_windows AS (
      SELECT s.window * tstzrange(NULL,lower(f.occupied_interval),'[)') AS win FROM span s
      WHERE from_time<lower(f.occupied_interval)
      UNION ALL
      SELECT s.window * tstzrange(upper(f.occupied_interval),NULL,'[)') FROM span s
      WHERE f.state='noShow' AND upper(f.occupied_interval)<until_time),
    demands AS (
      SELECT a.booking_id,a.win*s.window AS win,a.qty FROM actual a,span s WHERE a.win && s.window
      UNION ALL
      SELECT h.booking_id,(h.after_fact->>'occupied_interval')::tstzrange * w.win *
          tstzrange(h.recorded_at,successor.recorded_at,'[)'),
        coalesce((h.after_fact->>'out_quantity')::numeric,(h.after_fact->>'quantity')::numeric)
      FROM planned_windows w
      JOIN platform.booking_history h ON h.tenant_id=f.tenant_id AND h.environment_id=f.environment_id
        AND h.after_fact->>'resource_key'=d.resource_key::text AND h.booking_id<>f.booking_id
        AND h.after_fact->>'state' IN ('confirmed','hold','inUse') AND h.recorded_at<upper(w.win)
      -- A swap can move the next revision onto a different diary.
      LEFT JOIN platform.booking_history successor ON
        (successor.tenant_id,successor.environment_id,successor.booking_id,successor.revision)=
        (h.tenant_id,h.environment_id,h.booking_id,h.revision+1)),
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
    THEN
      IF f.state='noShow' THEN RAISE EXCEPTION 'booking.capacityTaken'; END IF;
      RAISE EXCEPTION 'booking.historicalOverlap'; END IF; END $$;

CREATE OR REPLACE FUNCTION north_star_internal.booking_fulfil(previous platform.booking_commitments,d platform.booking_resources,
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
    PERFORM north_star_internal.booking_check_use(previous,d,NULL,effective,decision,f.out_quantity);
    IF previous.state='noShow' THEN
      SELECT * INTO STRICT ev FROM north_star_internal.booking_current_evidence(previous) attendance
        WHERE attendance.evidence_kind='attendance' AND attendance.reason='noShow' AND NOT attendance.voided;
      ev.voided:=true;
      PERFORM north_star_internal.booking_write_evidence(f,ev,decision); END IF;
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

CREATE OR REPLACE FUNCTION platform.booking_owner_usage(r uuid,fence_number bigint,qid text,id uuid,from_time timestamptz,until_time timestamptz,
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
       FROM evidence ev JOIN relevant USING (booking_id)
       WHERE ev.evidence_kind<>'attendance' OR NOT ev.voided) INTO bookings,use_rows;
    changes:='[]'; END IF;
  IF octet_length((coalesce(bookings,'[]')||coalesce(use_rows,'[]')||changes)::text)>1048576 OR jsonb_array_length(coalesce(bookings,'[]'))>512
    THEN RAISE EXCEPTION 'booking.usageLimit'; END IF;
  RETURN jsonb_build_object('schemaVersion','booking.ownerUsage/v1','asOf',as_of,'ownerRef',jsonb_build_object('entityId',own.entity_id,'recordId',own.record_id),
    'ownerScope',CASE WHEN own.company_id IS NULL THEN '{"kind":"shared"}'::jsonb ELSE jsonb_build_object('kind','company','companyId',own.company_id) END,
    'cursor',delivered::text,'highWater',pinned::text,'hasMore',delivered<pinned,'changes',changes,
    'bookings',coalesce(bookings,'[]'),'evidence',coalesce(use_rows,'[]')); END $$;

CREATE OR REPLACE FUNCTION north_star_internal.booking_expire_kit(t uuid,e uuid,kit uuid,decision timestamptz)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE source platform.booking_receipts; key uuid; actor jsonb; due timestamptz; count_members integer; BEGIN
  -- Foreground callers already hold the closure. A sweeper skips the whole kit
  -- when another writer holds any member diary or owner cursor.
  PERFORM FROM platform.booking_resources d WHERE EXISTS(SELECT FROM platform.booking_commitments f WHERE
    (f.tenant_id,f.environment_id,f.group_id,f.resource_key)=(t,e,kit,d.resource_key)) ORDER BY resource_key FOR UPDATE NOWAIT;
  PERFORM FROM platform.booking_owner_cursors o WHERE EXISTS(SELECT FROM platform.booking_commitments f WHERE
    (f.tenant_id,f.environment_id,f.group_id,f.owner_key)=(t,e,kit,o.owner_key)) ORDER BY owner_key FOR UPDATE NOWAIT;
  SELECT greatest(coalesce(decision,north_star_internal.booking_now()),max(d.decision_floor)) INTO decision FROM platform.booking_resources d
    JOIN platform.booking_commitments f USING(resource_key) WHERE (f.tenant_id,f.environment_id,f.group_id)=(t,e,kit);
  SELECT max(deadline),count(*) INTO due,count_members FROM platform.booking_commitments WHERE (tenant_id,environment_id,group_id)=(t,e,kit)
    HAVING bool_and(state='hold' AND deadline<=decision) AND min(deadline)=max(deadline);
  IF due IS NULL THEN RETURN; END IF;
  SELECT DISTINCT b.* INTO STRICT source FROM platform.booking_commitments f
    JOIN platform.booking_history h USING (tenant_id,environment_id,booking_id)
    JOIN platform.booking_receipts b USING (tenant_id,environment_id,receipt_id)
    WHERE (f.tenant_id,f.environment_id,f.group_id)=(t,e,kit) AND h.revision=1;
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
    UPDATE platform.booking_resources SET decision_floor=greatest(decision_floor,decision) WHERE resource_key=diary.resource_key;
    processed := processed+1; END LOOP;
  RETURN processed; END $$;

CREATE OR REPLACE FUNCTION north_star_internal.booking_apply_kit(t uuid,e uuid,r uuid,fence_number bigint,group_op jsonb,key uuid,input jsonb,actor jsonb)
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
  FOR plan IN SELECT value FROM jsonb_array_elements(plans) ORDER BY value#>>'{binding,ownerEntity}',(value#>>'{member,recordId}')::uuid LOOP
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

CREATE OR REPLACE FUNCTION platform.booking_apply(r uuid,expected_fence bigint,action text,key uuid,input jsonb,actor jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET timezone='UTC' AS $$
DECLARE prior numeric := north_star_internal.booking_module_writes(); answer jsonb; BEGIN
  answer := north_star_internal.booking_apply(r,expected_fence,action,key,input,actor);
  IF north_star_internal.booking_module_writes() <> prior THEN RAISE EXCEPTION 'booking.unexpectedModuleWrite'; END IF;
  RETURN answer;
EXCEPTION WHEN serialization_failure THEN
  IF SQLERRM='booking.endpointChanged' THEN RETURN jsonb_build_object('refused','booking.tryAgain'); END IF;
  RAISE; END $$;
