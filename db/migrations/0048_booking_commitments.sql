-- The UUID operator class and the range operator class must coexist in one
-- unpartitioned GiST index. Creating the constraint also verifies both classes.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE DOMAIN platform.booking_interval AS tstzrange
  CHECK (NOT isempty(VALUE) AND lower_inc(VALUE) AND NOT upper_inc(VALUE)
         AND NOT lower_inf(VALUE) AND NOT upper_inf(VALUE)
         AND isfinite(lower(VALUE)) AND isfinite(upper(VALUE)));

CREATE TABLE platform.booking_resources (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  resource_key uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id text NOT NULL,
  company_id uuid,
  record_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('unit','pool')),
  unit text NOT NULL CHECK (unit <> ''),
  quantity_scale integer NOT NULL CHECK (quantity_scale BETWEEN 0 AND 18),
  decision_floor timestamptz NOT NULL DEFAULT '-infinity',
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments (tenant_id,id),
  UNIQUE NULLS NOT DISTINCT (tenant_id,environment_id,entity_id,company_id,record_id),
  UNIQUE (tenant_id,environment_id,resource_key,kind),
  CHECK (kind <> 'unit' OR quantity_scale = 0)
);

CREATE TABLE platform.booking_owner_cursors (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  owner_key uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id text NOT NULL,
  company_id uuid,
  record_id uuid NOT NULL,
  cursor_value bigint NOT NULL DEFAULT 0 CHECK (cursor_value >= 0),
  UNIQUE NULLS NOT DISTINCT (tenant_id,environment_id,entity_id,company_id,record_id),
  UNIQUE (tenant_id,environment_id,owner_key),
  FOREIGN KEY (tenant_id,environment_id) REFERENCES platform.environments (tenant_id,id)
);

CREATE TABLE platform.booking_commitments (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  booking_id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_key uuid NOT NULL,
  slot_id text NOT NULL,
  resource_key uuid NOT NULL,
  kind text NOT NULL,
  assigned_unit_key uuid,
  group_id uuid,
  group_kind text,
  fulfilment_mode text NOT NULL CHECK (fulfilment_mode IN ('tracked','scheduled')),
  binding jsonb NOT NULL,
  calendar jsonb NOT NULL,
  entered_interval jsonb NOT NULL,
  agreed_interval platform.booking_interval NOT NULL,
  occupied_interval platform.booking_interval NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0 AND quantity < 'Infinity'),
  unit text NOT NULL,
  state text NOT NULL CHECK (state IN ('hold','confirmed','cancelled')),
  deadline timestamptz NOT NULL CHECK (isfinite(deadline)),
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (tenant_id,environment_id,booking_id),
  FOREIGN KEY (tenant_id,environment_id,resource_key,kind)
    REFERENCES platform.booking_resources (tenant_id,environment_id,resource_key,kind),
  FOREIGN KEY (tenant_id,environment_id,owner_key)
    REFERENCES platform.booking_owner_cursors (tenant_id,environment_id,owner_key),
  CHECK ((kind = 'unit' AND assigned_unit_key IS NOT NULL AND assigned_unit_key = resource_key AND quantity = 1)
       OR (kind = 'pool' AND assigned_unit_key IS NULL)),
  CHECK (group_id IS NULL AND group_kind IS NULL),
  CHECK (agreed_interval @> occupied_interval),
  EXCLUDE USING gist (resource_key WITH =, occupied_interval WITH &&)
    WHERE (kind = 'unit' AND state IN ('hold','confirmed'))
);
CREATE UNIQUE INDEX booking_live_owner_slot ON platform.booking_commitments (owner_key,slot_id)
  WHERE state IN ('hold','confirmed');
CREATE INDEX booking_due_holds ON platform.booking_commitments (resource_key,deadline) WHERE state='hold';

CREATE TABLE platform.booking_pool_capacity (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  resource_key uuid NOT NULL,
  kind text NOT NULL DEFAULT 'pool' CHECK (kind='pool'),
  revision integer NOT NULL CHECK (revision > 0),
  valid_from timestamptz NOT NULL CHECK (isfinite(valid_from)),
  valid_to timestamptz,
  quantity numeric NOT NULL CHECK (quantity >= 0 AND quantity < 'Infinity'),
  receipt_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,environment_id,resource_key,revision),
  FOREIGN KEY (tenant_id,environment_id,resource_key,kind)
    REFERENCES platform.booking_resources (tenant_id,environment_id,resource_key,kind),
  CHECK (valid_to IS NULL OR (isfinite(valid_to) AND valid_to >= valid_from)),
  EXCLUDE USING gist (resource_key WITH =, tstzrange(valid_from,valid_to,'[)') WITH &&)
);

CREATE TABLE platform.booking_history (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  revision integer NOT NULL,
  owner_key uuid NOT NULL,
  cursor_value bigint NOT NULL,
  before_fact jsonb,
  after_fact jsonb NOT NULL,
  operation text NOT NULL,
  reason text,
  effective_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  receipt_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,environment_id,booking_id,revision),
  UNIQUE (owner_key,cursor_value),
  FOREIGN KEY (tenant_id,environment_id,booking_id)
    REFERENCES platform.booking_commitments (tenant_id,environment_id,booking_id)
);
CREATE FUNCTION north_star_internal.booking_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  RAISE EXCEPTION 'booking.historyImmutable'; END $$;
CREATE TRIGGER booking_history_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.booking_history
  FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.booking_immutable();

-- The production time source is private. Tests replace this function only in their isolated database.
CREATE FUNCTION north_star_internal.booking_now() RETURNS timestamptz
LANGUAGE sql VOLATILE SET search_path = pg_catalog, pg_temp AS $$ SELECT clock_timestamp() $$;

-- Validate the actual local time after converting it back from each candidate
-- instant. A spring gap has zero candidates and an autumn fold has two.
CREATE FUNCTION north_star_internal.booking_boundary(local_value timestamp, zone_name text, offset_seconds integer)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE candidate timestamptz; matches integer; BEGIN
  IF local_value IS NULL OR NOT isfinite(local_value) OR NOT EXISTS
    (SELECT FROM pg_timezone_names WHERE name=zone_name) THEN RAISE EXCEPTION 'booking.invalidCalendar'; END IF;
  WITH offsets AS (
    SELECT DISTINCT extract(epoch FROM (probe AT TIME ZONE zone_name) - (probe AT TIME ZONE 'UTC'))::integer AS seconds
      FROM (VALUES ((local_value AT TIME ZONE zone_name) - interval '24 hours'),
                   (local_value AT TIME ZONE zone_name),
                   ((local_value AT TIME ZONE zone_name) + interval '24 hours')) AS probes(probe)
  ), candidates AS (
    SELECT (local_value AT TIME ZONE 'UTC') - make_interval(secs => seconds) AS instant
      FROM offsets WHERE offset_seconds IS NULL OR seconds=offset_seconds
  )
  SELECT count(*),min(instant) INTO matches,candidate FROM candidates WHERE instant AT TIME ZONE zone_name = local_value;
  IF matches <> 1 THEN RAISE EXCEPTION 'booking.unresolvedBoundary'; END IF;
  RETURN candidate; END $$;

CREATE FUNCTION north_star_internal.booking_resolve_window(
  entered jsonb, calendar jsonb, decision timestamptz, changing boolean,
  OUT agreed platform.booking_interval, OUT occupied platform.booking_interval
) LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  zone_name text := calendar->>'zone';
  boundary time := (calendar->>'boundary')::time;
  date_only boolean := entered->>'kind'='date';
  start_local timestamp;
  end_local timestamp;
  start_at timestamptz;
  end_at timestamptz;
  occupied_start timestamptz; BEGIN
  IF calendar->>'id' IS NULL OR boundary IS NULL OR entered->>'kind' IS NULL
     OR entered->>'kind' NOT IN ('date','time','now') THEN RAISE EXCEPTION 'booking.invalidInterval'; END IF;
  IF date_only THEN
    IF entered->>'start' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR entered->>'end' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'booking.invalidInterval'; END IF;
    start_local := (entered->>'start')::date + boundary;
    end_local := (entered->>'end')::date + boundary;
  ELSE
    IF entered->>'end' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?$'
       OR (entered->>'kind'='time' AND entered->>'start' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?$') THEN
      RAISE EXCEPTION 'booking.invalidInterval'; END IF;
    IF entered->>'kind'='time' THEN start_local := (entered->>'start')::timestamp; END IF;
    end_local := (entered->>'end')::timestamp; END IF;
  start_at := CASE WHEN entered->>'kind'='now' THEN decision ELSE
    north_star_internal.booking_boundary(start_local,zone_name,(entered->>'startOffsetSeconds')::integer) END;
  end_at := north_star_internal.booking_boundary(end_local,zone_name,(entered->>'endOffsetSeconds')::integer);
  IF end_at <= decision OR end_at <= start_at THEN RAISE EXCEPTION 'booking.elapsedInterval'; END IF;
  occupied_start := start_at;
  IF date_only AND start_local::date < (decision AT TIME ZONE zone_name)::date AND NOT changing THEN
    RAISE EXCEPTION 'booking.startInPast'; END IF;
  IF start_at < decision THEN
    IF NOT date_only THEN RAISE EXCEPTION 'booking.startInPast'; END IF;
    occupied_start := decision; END IF;
  agreed := tstzrange(start_at,end_at,'[)');
  occupied := tstzrange(occupied_start,end_at,'[)'); END $$;

CREATE FUNCTION north_star_internal.booking_check_capacity(diary uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  -- Sum simultaneous changes before looking at the next segment. Checking
  -- total overlapping demand would double count adjacent commitments.
  IF EXISTS (
    WITH changes AS (
      SELECT lower(occupied_interval) AS at, quantity AS demand, 0::numeric AS capacity
        FROM platform.booking_commitments WHERE resource_key=diary AND state IN ('hold','confirmed')
      UNION ALL SELECT upper(occupied_interval),-quantity,0
        FROM platform.booking_commitments WHERE resource_key=diary AND state IN ('hold','confirmed')
      UNION ALL SELECT valid_from,0,quantity FROM platform.booking_pool_capacity WHERE resource_key=diary
      UNION ALL SELECT valid_to,0,-quantity FROM platform.booking_pool_capacity WHERE resource_key=diary AND valid_to IS NOT NULL
    ), segments AS (
      SELECT at, sum(sum(capacity-demand)) OVER (ORDER BY at) AS remaining FROM changes GROUP BY at
    ) SELECT FROM segments WHERE remaining < 0
  ) THEN RAISE EXCEPTION 'booking.noLongerAvailable'; END IF; END $$;

-- Only the bounded facade looks up bindings. The caller supplies an operation
-- ID and record IDs. Physical names and permissions come from release bytes.
CREATE FUNCTION north_star_internal.booking_projection(t uuid,e uuid,r uuid,payload_kind text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (SELECT doc FROM platform.tenant_release_chunk_links c
    JOIN platform.tenant_release_projection_links p USING (tenant_id,environment_id,release_id,projection_instance_id)
    JOIN platform.release_artifact_blobs b ON b.content_hash=c.chunk_hash
      AND b.artifact_kind='projectionChunk'
    CROSS JOIN LATERAL (SELECT convert_from(b.canonical_bytes,'UTF8')::jsonb AS doc) payload
    WHERE (c.tenant_id,c.environment_id,c.release_id)=(t,e,r) AND doc->>'kind'=payload_kind
      AND p.projection_family_id=CASE payload_kind WHEN 'storageTargetPayload' THEN 'northstar.compiler:projection-family.storage-target'
        WHEN 'operationCatalogPayload' THEN 'northstar.compiler:projection-family.operation-catalog' END)
$$;

CREATE FUNCTION north_star_internal.booking_endpoint(
  t uuid,e uuid,storage jsonb,entity text,record uuid, lock_row boolean DEFAULT true
) RETURNS uuid LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE spec jsonb; relation jsonb; company uuid; live boolean; parent uuid; parent_company uuid; BEGIN
  SELECT value INTO STRICT spec FROM jsonb_array_elements(storage->'entities')
    WHERE value->>'entityId'=entity AND value->>'lifecycle'='active';
  EXECUTE format('SELECT %s,true FROM north_star_module.%I WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL %s',
    CASE WHEN spec ? 'legalEntity' THEN 'legal_entity_id' ELSE 'NULL::uuid' END,spec->>'physicalTableName',CASE WHEN lock_row THEN 'FOR UPDATE' ELSE '' END)
    INTO company,live USING t,e,record;
  IF live IS DISTINCT FROM true THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END IF;
  FOR relation IN SELECT value FROM jsonb_array_elements(storage->'relations')
    WHERE value->>'sourceEntityId'=entity AND value->>'ownership'='parentScopedChild'
  LOOP
    EXECUTE format('SELECT %I FROM north_star_module.%I WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3',
      relation->'relationColumn'->>'physicalName',spec->>'physicalTableName') INTO parent USING t,e,record;
    parent_company := north_star_internal.booking_endpoint(t,e,storage,relation->>'targetEntityId',parent,lock_row);
    IF company IS NOT NULL AND company IS DISTINCT FROM parent_company THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END IF;
    company := parent_company; END LOOP;
  RETURN company;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END $$;

CREATE FUNCTION north_star_internal.booking_require_permission(
  t uuid,e uuid,actor uuid,company uuid,permission text,resource text
) RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NOT EXISTS (SELECT FROM platform.current_policy_memberships m
    JOIN platform.current_policy_roles r USING (tenant_id,environment_id,role_id)
    JOIN platform.current_policy_permission_grants g USING (tenant_id,environment_id,role_id)
    WHERE (m.tenant_id,m.environment_id,m.principal_id)=(t,e,actor)
      AND m.revoked_at IS NULL AND r.revoked_at IS NULL AND g.revoked_at IS NULL
      AND (m.legal_entity_id IS NULL OR m.legal_entity_id=company)
      AND (g.permission_id,g.resource_id)=(permission,resource)) THEN
    RAISE EXCEPTION 'booking.endpointUnavailable'; END IF; END $$;

CREATE TABLE platform.booking_receipts (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, request_key uuid NOT NULL,
  actor_id uuid NOT NULL, operation_id text NOT NULL, input jsonb NOT NULL, release_id uuid NOT NULL,
  receipt_id uuid NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY (tenant_id,environment_id,request_key),
  UNIQUE (tenant_id,environment_id,receipt_id),
  FOREIGN KEY (tenant_id,environment_id,receipt_id)
    REFERENCES platform.trust_action_invocations (tenant_id,environment_id,invocation_id)
    DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE platform.booking_history ADD FOREIGN KEY (tenant_id,environment_id,receipt_id)
  REFERENCES platform.booking_receipts (tenant_id,environment_id,receipt_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE platform.booking_pool_capacity ADD FOREIGN KEY (tenant_id,environment_id,receipt_id)
  REFERENCES platform.booking_receipts (tenant_id,environment_id,receipt_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER booking_receipt_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.booking_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.booking_immutable();

-- Build the existing trust rows in the same transaction as each decision,
-- including a due hold owned by someone other than the initiating caller.
CREATE FUNCTION north_star_internal.booking_evidence(
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
    (tenant_id,environment_id,invocation_id,invocation_version,request_id,action_id,channel,outcome,correlation_id,release_id,
     release_content_hash,execution_principal_kind,execution_principal_id,subject_principal_kind,subject_principal_id,
     initiating_human_id,approving_human_id,delegation_id,delegating_principal_kind,delegating_principal_id,
     delegated_to_principal_kind,delegated_to_principal_id,policy_evidence_version,policy_decision,
     policy_version,policy_evaluator_version,policy_inputs,metadata,change_document_id,domain_event_id,outbox_id,recorded_at)
    VALUES (t,e,receipt,'northstar.action-invocation/v1',(actor->>'requestId')::uuid,action,channel,'SUCCEEDED',key,r,
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
     action,key,r,release_hash,event_type,event_type||'/v1','booking/'||key,at_time);
  receipt_result := result || jsonb_build_object('invocationId',receipt,'changeDocumentId',change_id,'domainEventId',event_id,'outboxId',outbox_id);
  INSERT INTO platform.booking_receipts VALUES (t,e,key,principal,action,input,r,receipt,receipt_result);
  INSERT INTO platform.semantic_operation_receipts
    (tenant_id,environment_id,principal_id,release_id,release_content_hash,action_id,idempotency_key,input_digest,mutation_result,
     invocation_id,correlation_id,change_document_id,domain_event_id,outbox_id,recorded_at)
    VALUES (t,e,principal,r,release_hash,action,key,encode(sha256(convert_to(input::text,'UTF8')),'hex'),receipt_result,
      receipt,key,change_id,event_id,outbox_id,at_time);
  RETURN receipt_result; END $$;

CREATE FUNCTION north_star_internal.booking_record_change(
  previous platform.booking_commitments, fact platform.booking_commitments, r uuid,actor jsonb,action text,
  key uuid,input jsonb,reason text,effective timestamptz,decision timestamptz
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE owner_row platform.booking_owner_cursors; receipt uuid := gen_random_uuid(); payload jsonb; BEGIN
  UPDATE platform.booking_owner_cursors SET cursor_value=cursor_value+1 WHERE owner_key=fact.owner_key RETURNING * INTO STRICT owner_row;
  INSERT INTO platform.booking_history VALUES (fact.tenant_id,fact.environment_id,fact.booking_id,fact.revision,fact.owner_key,
    owner_row.cursor_value,CASE WHEN previous.booking_id IS NOT NULL THEN to_jsonb(previous) END,to_jsonb(fact),
    action,reason,effective,decision,receipt);
  payload := jsonb_build_object('operation',action,'effectiveAt',effective,
    'ownerScope',CASE WHEN owner_row.company_id IS NULL THEN '{"kind":"shared"}'::jsonb
                  ELSE jsonb_build_object('kind','company','companyId',owner_row.company_id) END,
    'owners',jsonb_build_array(jsonb_build_object('ownerRef',jsonb_build_object('entityId',owner_row.entity_id,'recordId',owner_row.record_id),
      'previousCursor',(owner_row.cursor_value-1)::text,'cursor',owner_row.cursor_value::text,
      'bookings',jsonb_build_array(jsonb_build_object('bookingId',fact.booking_id,'revision',fact.revision)))));
  RETURN north_star_internal.booking_evidence(fact.tenant_id,fact.environment_id,r,actor,action,key,input,receipt,fact.booking_id,
    fact.revision,CASE WHEN previous.booking_id IS NOT NULL THEN to_jsonb(previous) END,to_jsonb(fact),decision,'booking.changed',payload,
    jsonb_build_object('bookingId',fact.booking_id,'revision',fact.revision,'state',fact.state,'deadline',fact.deadline)); END $$;

CREATE FUNCTION north_star_internal.booking_expire(diary uuid,decision timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE previous platform.booking_commitments; fact platform.booking_commitments; source platform.booking_receipts;
  actor jsonb; expiry_key uuid; BEGIN
  FOR previous IN SELECT * FROM platform.booking_commitments WHERE resource_key=diary AND state='hold' AND deadline<=decision ORDER BY owner_key,booking_id LOOP
    SELECT b.* INTO STRICT source FROM platform.booking_receipts b JOIN platform.booking_history h USING (tenant_id,environment_id,receipt_id)
      WHERE (h.tenant_id,h.environment_id,h.booking_id,h.revision)=(previous.tenant_id,previous.environment_id,previous.booking_id,1);
    expiry_key := md5('booking.expire/'||previous.booking_id||'/'||previous.revision)::uuid;
    actor := jsonb_build_object('executionPrincipal',jsonb_build_object('kind','SYSTEM','principalId',source.actor_id),
      'requestId',expiry_key,'channel','SYSTEM','policyVersion','acceptedHoldDeadline');
    UPDATE platform.booking_commitments SET state='cancelled',revision=revision+1
      WHERE tenant_id=previous.tenant_id AND environment_id=previous.environment_id AND booking_id=previous.booking_id RETURNING * INTO STRICT fact;
    PERFORM north_star_internal.booking_record_change(previous,fact,source.release_id,actor,'expireHold',expiry_key,
      jsonb_build_object('bookingId',fact.booking_id,'revision',previous.revision),'hold expired',previous.deadline,decision); END LOOP; END $$;

CREATE FUNCTION platform.booking_sweep_due(max_resources integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE diary platform.booking_resources; decision timestamptz; processed integer := 0; BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'booking.requiresReadCommitted'; END IF;
  IF max_resources IS NULL OR max_resources NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'booking.invalidLimit'; END IF;
  FOR diary IN SELECT d.* FROM platform.booking_resources d WHERE EXISTS
    (SELECT FROM platform.booking_commitments b WHERE b.resource_key=d.resource_key AND b.state='hold'
      AND b.deadline<=greatest(d.decision_floor,north_star_internal.booking_now()))
    ORDER BY d.resource_key LIMIT max_resources FOR UPDATE SKIP LOCKED LOOP
    decision := greatest(diary.decision_floor,north_star_internal.booking_now());
    PERFORM north_star_internal.booking_expire(diary.resource_key,decision);
    UPDATE platform.booking_resources SET decision_floor=decision WHERE resource_key=diary.resource_key;
    processed := processed+1; END LOOP;
  RETURN processed; END $$;

CREATE FUNCTION platform.booking_apply(r uuid,expected_fence bigint,action text,key uuid,input jsonb,actor jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET timezone='UTC' AS $$
DECLARE
  t uuid := north_star_internal.trusted_tenant_id();
  e uuid := north_star_internal.trusted_environment_id();
  principal uuid := nullif(current_setting('north_star.principal_id',true),'')::uuid;
  op jsonb; binding jsonb; storage jsonb; command text; calendar jsonb;
  target uuid := (input->>'resourceId')::uuid; owner_id uuid := (input->>'recordId')::uuid;
  target_company uuid; owner_company uuid; diary platform.booking_resources; owner_row platform.booking_owner_cursors;
  prior_receipt platform.booking_receipts; prior_fact platform.booking_commitments; fact platform.booking_commitments;
  decision timestamptz; amount numeric; term record; capacity platform.booking_pool_capacity;
  receipt uuid := gen_random_uuid(); result jsonb; expected_rev integer := (input->>'expectedRevision')::integer;
  latest integer; policy_version text; owner_table text; owner_revision bigint; BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'booking.requiresReadCommitted'; END IF;
  IF principal IS NULL OR (actor->'executionPrincipal'->>'principalId')::uuid IS DISTINCT FROM principal
    OR (actor->>'requestId')::uuid IS DISTINCT FROM nullif(current_setting('north_star.request_id',true),'')::uuid
    OR key IS NULL THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END IF;
  PERFORM 1 FROM platform.active_release_pointers WHERE (tenant_id,environment_id,release_id,fence)=(t,e,r,expected_fence) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking.staleRelease'; END IF;
  SELECT value INTO STRICT op FROM jsonb_array_elements(north_star_internal.booking_projection(t,e,r,'operationCatalogPayload')->'operations')
    WHERE value->>'operationId'=action AND value->>'lifecycle'='active' AND
      value->'effect'->'capability'->>'targetId'='northstar.booking:capability.commitments';
  binding := op->'booking'; command := binding->>'operation';
  IF binding->>'schemaVersion' IS DISTINCT FROM 'booking.commitment/v1'
    OR binding->>'kind' IS NULL OR binding->>'kind' NOT IN ('pool','unit')
    OR command IS NULL OR command NOT IN ('hold','confirm','cancel','changeInterval','setCapacity')
    OR (command <> 'hold' AND op->>'confirmation' IS DISTINCT FROM 'humanRequired')
    OR (actor->>'channel'='WORKFLOW' AND actor->>'approvingHumanId' IS NULL)
    THEN RAISE EXCEPTION 'booking.unsupportedBinding'; END IF;
  storage := north_star_internal.booking_projection(t,e,r,'storageTargetPayload');
  -- Discovery reads identities only. Recheck the endpoints, including parents, under locks below.
  IF command NOT IN ('hold','setCapacity') THEN
    SELECT d.record_id INTO STRICT target FROM platform.booking_commitments f
      JOIN platform.booking_resources d USING (tenant_id,environment_id,resource_key)
      JOIN platform.booking_owner_cursors o USING (tenant_id,environment_id,owner_key)
      WHERE (f.tenant_id,f.environment_id,f.booking_id)=(t,e,(input->>'bookingId')::uuid)
        AND o.record_id=owner_id AND o.entity_id=binding->>'ownerEntity' AND f.slot_id=binding->>'slotId'
        AND d.entity_id=binding->>'resourceEntity'; END IF;
  -- The initial row insert contends on its natural key. Once a diary exists, every writer takes it first.
  SELECT * INTO diary FROM platform.booking_resources WHERE (tenant_id,environment_id,entity_id,record_id)=(t,e,binding->>'resourceEntity',target) FOR UPDATE;
  IF NOT FOUND THEN
    target_company := north_star_internal.booking_endpoint(t,e,storage,binding->>'resourceEntity',target,false);
    INSERT INTO platform.booking_resources (tenant_id,environment_id,entity_id,record_id,company_id,kind,unit,quantity_scale)
      VALUES (t,e,binding->>'resourceEntity',target,target_company,binding->>'kind',binding->>'unit',(binding->>'scale')::integer)
      ON CONFLICT (tenant_id,environment_id,entity_id,company_id,record_id) DO NOTHING;
    SELECT * INTO STRICT diary FROM platform.booking_resources WHERE (tenant_id,environment_id,entity_id,record_id)=(t,e,binding->>'resourceEntity',target) FOR UPDATE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(t::text||e::text||key::text,0));
  IF (binding->>'ownerEntity',owner_id) < (binding->>'resourceEntity',target) THEN
    owner_company := north_star_internal.booking_endpoint(t,e,storage,binding->>'ownerEntity',owner_id);
    target_company := north_star_internal.booking_endpoint(t,e,storage,binding->>'resourceEntity',target);
  ELSE
    target_company := north_star_internal.booking_endpoint(t,e,storage,binding->>'resourceEntity',target);
    owner_company := north_star_internal.booking_endpoint(t,e,storage,binding->>'ownerEntity',owner_id); END IF;
  IF (diary.kind,diary.unit,diary.quantity_scale) IS DISTINCT FROM (binding->>'kind',binding->>'unit',(binding->>'scale')::integer)
    OR target_company IS DISTINCT FROM diary.company_id OR (target_company IS NOT NULL AND target_company IS DISTINCT FROM owner_company)
    THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END IF;
  policy_version := platform.lock_current_policy_epoch(t,e)::text;
  IF actor->>'policyVersion' IS DISTINCT FROM 'northstar.current-policy/'||policy_version THEN RAISE EXCEPTION 'booking.stalePolicy'; END IF;
  PERFORM north_star_internal.booking_require_permission(t,e,principal,owner_company,op->>'permissionId',binding->>'ownerEntity');
  PERFORM north_star_internal.booking_require_permission(t,e,principal,owner_company,binding->>'ownerReadPermission',binding->>'ownerEntity');
  PERFORM north_star_internal.booking_require_permission(t,e,principal,target_company,binding->>'resourceReadPermission',diary.entity_id);
  IF command='setCapacity' AND (owner_id<>target OR binding->>'ownerEntity'<>diary.entity_id OR diary.kind<>'pool') THEN RAISE EXCEPTION 'booking.invalidCapacity'; END IF;
  SELECT * INTO prior_receipt FROM platform.booking_receipts WHERE (tenant_id,environment_id,request_key)=(t,e,key);
  IF FOUND THEN
    IF (prior_receipt.actor_id,prior_receipt.operation_id,prior_receipt.input,prior_receipt.release_id)
      IS DISTINCT FROM (principal,action,input,r) THEN RAISE EXCEPTION 'booking.requestKeyConflict'; END IF;
    RETURN prior_receipt.result; END IF;
  SELECT value->>'physicalTableName' INTO STRICT owner_table FROM jsonb_array_elements(storage->'entities') WHERE value->>'entityId'=binding->>'ownerEntity';
  EXECUTE format('SELECT revision FROM north_star_module.%I WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3',owner_table)
    INTO STRICT owner_revision USING t,e,owner_id;
  IF owner_revision IS DISTINCT FROM (input->>'expectedOwnerRevision')::bigint THEN RAISE EXCEPTION 'booking.staleOwnerRevision'; END IF;
  -- Acquire all affected owner cursor locks in one order, including other companies' due holds.
  IF command<>'setCapacity' THEN
    INSERT INTO platform.booking_owner_cursors (tenant_id,environment_id,entity_id,company_id,record_id)
      VALUES (t,e,binding->>'ownerEntity',owner_company,owner_id) ON CONFLICT DO NOTHING;
    SELECT * INTO STRICT owner_row FROM platform.booking_owner_cursors WHERE (tenant_id,environment_id,entity_id,record_id)=(t,e,binding->>'ownerEntity',owner_id); END IF;
  PERFORM 1 FROM platform.booking_owner_cursors o WHERE o.owner_key=owner_row.owner_key OR EXISTS
    (SELECT FROM platform.booking_commitments f WHERE f.resource_key=diary.resource_key AND f.state='hold' AND f.owner_key=o.owner_key)
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
      SELECT * INTO term FROM north_star_internal.booking_resolve_window(input->'interval',calendar,decision,false);
      INSERT INTO platform.booking_commitments (tenant_id,environment_id,owner_key,slot_id,resource_key,kind,assigned_unit_key,
        fulfilment_mode,binding,calendar,entered_interval,agreed_interval,occupied_interval,quantity,unit,state,deadline,revision)
        VALUES (t,e,owner_row.owner_key,binding->>'slotId',diary.resource_key,diary.kind,
          CASE WHEN diary.kind='unit' THEN diary.resource_key END,binding->>'fulfilmentMode',binding,calendar,input->'interval',
          term.agreed,term.occupied,amount,diary.unit,'hold',least(upper(term.occupied),decision+make_interval(secs=>coalesce((binding->>'holdSeconds')::integer,900))),1)
        RETURNING * INTO STRICT fact;
    ELSE
      SELECT * INTO STRICT prior_fact FROM platform.booking_commitments WHERE (tenant_id,environment_id,booking_id,owner_key,resource_key)=
        (t,e,(input->>'bookingId')::uuid,owner_row.owner_key,diary.resource_key);
      IF prior_fact.state='cancelled' THEN RAISE EXCEPTION 'booking.closed'; END IF;
      IF expected_rev IS DISTINCT FROM prior_fact.revision THEN RAISE EXCEPTION 'booking.staleRevision'; END IF;
      IF command='confirm' AND prior_fact.state<>'hold' THEN RAISE EXCEPTION 'booking.invalidState'; END IF;
      IF command='changeInterval' THEN
        SELECT * INTO term FROM north_star_internal.booking_resolve_window(input->'interval',prior_fact.calendar,decision,true);
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
    WHEN raise_exception THEN IF SQLERRM LIKE 'booking.%' THEN RETURN jsonb_build_object('refused',SQLERRM); ELSE RAISE; END IF; END;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END $$;

DO $access$
DECLARE tab text; routine regprocedure; BEGIN
  FOREACH tab IN ARRAY ARRAY['booking_resources','booking_owner_cursors','booking_receipts','booking_pool_capacity','booking_history','booking_commitments'] LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('REVOKE ALL ON platform.%I FROM PUBLIC,north_star_runtime,north_star_module_runtime,north_star_module_materializer,north_star_workflow_worker',tab); END LOOP;
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
    WHERE n.nspname IN ('north_star_internal','platform') AND left(p.proname,8)='booking_' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine); END LOOP; END $access$;
GRANT EXECUTE ON FUNCTION platform.booking_apply(uuid,bigint,text,uuid,jsonb,jsonb) TO north_star_runtime;
GRANT EXECUTE ON FUNCTION platform.booking_sweep_due(integer) TO north_star_workflow_worker;
