-- The shared writer is a composition API for governed channel operations.
-- Only their SQL definers may supply resolved record bindings and participants.
CREATE ROLE north_star_communication_operation NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA platform TO north_star_communication_operation;

CREATE TYPE platform.communication_record AS (entity_id text, record_id uuid);
CREATE TABLE platform.communication_discussion_anchors (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, company_id uuid NOT NULL,
  primary_entity text NOT NULL, primary_record uuid NOT NULL, requirements jsonb NOT NULL,
  PRIMARY KEY (tenant_id,environment_id,company_id,primary_entity,primary_record),
  FOREIGN KEY (tenant_id,environment_id) REFERENCES platform.environments(tenant_id,id)
);
CREATE TABLE platform.communication_threads (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, company_id uuid NOT NULL,
  thread_id uuid NOT NULL DEFAULT gen_random_uuid(), audience text NOT NULL,
  primary_entity text, primary_record uuid, linked_records platform.communication_record[],
  direct_pair uuid[],
  PRIMARY KEY (tenant_id,environment_id,company_id,thread_id),
  FOREIGN KEY (tenant_id,environment_id) REFERENCES platform.environments(tenant_id,id),
  CHECK ((audience='record' AND primary_entity IS NOT NULL AND primary_record IS NOT NULL
          AND linked_records IS NOT NULL AND direct_pair IS NULL)
      OR (audience='staffDirect' AND primary_entity IS NULL AND primary_record IS NULL
          AND linked_records IS NULL AND direct_pair IS NOT NULL AND cardinality(direct_pair)=2
          AND direct_pair[1]<direct_pair[2]))
);
CREATE UNIQUE INDEX communication_direct_pair ON platform.communication_threads
  (tenant_id,environment_id,company_id,direct_pair) WHERE audience='staffDirect';
CREATE INDEX communication_primary_record ON platform.communication_threads
  (tenant_id,environment_id,company_id,primary_entity,primary_record) WHERE audience='record';
CREATE TABLE platform.communication_record_links (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, company_id uuid NOT NULL,
  thread_id uuid NOT NULL, entity_id text NOT NULL, record_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,environment_id,company_id,thread_id,entity_id,record_id),
  FOREIGN KEY (tenant_id,environment_id,company_id,thread_id) REFERENCES platform.communication_threads
);
CREATE TABLE platform.communication_participants (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, company_id uuid NOT NULL,
  thread_id uuid NOT NULL, channel text NOT NULL, participant_kind text NOT NULL,
  entity_id text NOT NULL, subject_id uuid NOT NULL, participant_id uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (tenant_id,environment_id,company_id,thread_id,channel,participant_kind,entity_id,subject_id),
  UNIQUE (tenant_id,environment_id,company_id,thread_id,participant_id),
  FOREIGN KEY (tenant_id,environment_id,company_id,thread_id) REFERENCES platform.communication_threads,
  CHECK (channel IN ('email/v1','staffDiscussion/v1')),
  CHECK ((participant_kind='staff' AND entity_id='') OR
         (participant_kind='contact' AND entity_id<>'' AND channel='email/v1'))
);
-- RLS defaults to deny. No connection role reads or writes these relations directly.
ALTER TABLE platform.communication_discussion_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.communication_discussion_anchors FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.communication_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.communication_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.communication_record_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.communication_record_links FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.communication_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.communication_participants FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform.communication_discussion_anchors,platform.communication_threads,
  platform.communication_record_links,platform.communication_participants FROM PUBLIC,north_star_runtime,north_star_communication_operation;

CREATE FUNCTION north_star_internal.communication_admission_table() RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF to_regclass('pg_temp.communication_admissions') IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT FROM pg_class WHERE oid=to_regclass('pg_temp.communication_admissions')
    AND relowner=current_user::regrole AND relkind='r') THEN RAISE EXCEPTION 'communication.unavailable'; END IF;
  RETURN true; END $$;
CREATE FUNCTION north_star_internal.communication_before_threads() RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF north_star_internal.communication_admission_table() THEN
    IF EXISTS (SELECT FROM pg_temp.communication_admissions WHERE creation_locked OR thread_id IS NOT NULL)
      THEN RAISE EXCEPTION 'communication.lockOrder'; END IF; END IF; END $$;

-- Pre-R11. The channel operation validates its released bindings, exact reads,
-- field disclosure and action grants under these same fences before resolution.
CREATE FUNCTION platform.communication_fence(company uuid, released uuid, expected_fence bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id(); BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'communication.requiresReadCommitted'; END IF;
  PERFORM north_star_internal.communication_before_threads();
  PERFORM FROM platform.active_release_pointers WHERE (tenant_id,environment_id,release_id,fence)=(t,e,released,expected_fence) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'communication.staleRelease'; END IF;
  PERFORM platform.lock_current_policy_epoch(t,e);
  IF NOT north_star_internal.address_member(company) THEN RAISE EXCEPTION 'communication.unavailable'; END IF;
  RETURN north_star_internal.booking_projection(t,e,released,'storageTargetPayload'); END $$;

-- Lock all saved records (including contact endpoints and owning ancestors)
-- together, in the same order as the generic record and Booking writers.
CREATE FUNCTION north_star_internal.communication_check_records(company uuid, storage jsonb, refs platform.communication_record[])
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  closure jsonb; locked jsonb; node record; ref platform.communication_record; owner uuid; live boolean; BEGIN
  FOR pass IN 1..2 LOOP
    closure := '[]';
    FOR node IN SELECT DISTINCT n.entity_id,n.record_id,n.table_name,north_star_internal.booking_entity_height(storage,n.entity_id) AS height
      FROM unnest(refs) k CROSS JOIN LATERAL north_star_internal.booking_endpoint_tree(t,e,storage,k.entity_id,k.record_id) n
      ORDER BY height DESC,n.entity_id,n.record_id LOOP
      closure := closure || jsonb_build_array(to_jsonb(node));
      IF pass=1 THEN
        EXECUTE format('SELECT true FROM north_star_module.%I WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL FOR SHARE',node.table_name)
          INTO live USING t,e,node.record_id;
        IF live IS DISTINCT FROM true THEN RAISE EXCEPTION 'communication.unavailable'; END IF; END IF; END LOOP;
    IF pass=1 THEN locked:=closure;
    ELSIF closure<>locked THEN RAISE EXCEPTION 'communication.recordChanged' USING ERRCODE='40001'; END IF; END LOOP;
  FOREACH ref IN ARRAY refs LOOP
    owner:=north_star_internal.booking_endpoint(t,e,storage,ref.entity_id,ref.record_id,false);
    IF owner IS NOT NULL AND owner<>company THEN RAISE EXCEPTION 'communication.unavailable'; END IF; END LOOP; END $$;

-- Immutable binding ID -> saved target facts. The empty binding is the primary.
-- Producers derive other entries from the active declaration and saved relations.
CREATE TYPE platform.communication_admission AS (
  tenant_id uuid, environment_id uuid, company_id uuid, channel text,
  primary_entity text, primary_record uuid, requirements jsonb,
  links platform.communication_record[], contacts platform.communication_record[], staff uuid[], principal_id uuid
);
-- Tickets are private to the connection and transaction. Check ownership
-- before using the session's temp namespace, including on pooled connections.
CREATE FUNCTION north_star_internal.communication_ticket(a platform.communication_admission) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE ticket uuid:=gen_random_uuid(); BEGIN
  IF NOT north_star_internal.communication_admission_table() THEN
    CREATE TEMP TABLE communication_admissions (id uuid PRIMARY KEY, admission platform.communication_admission NOT NULL, thread_id uuid, creation_locked boolean NOT NULL DEFAULT false,
      participants_locked boolean NOT NULL DEFAULT false) ON COMMIT DROP;
    REVOKE ALL ON pg_temp.communication_admissions FROM PUBLIC; END IF;
  INSERT INTO pg_temp.communication_admissions (id,admission) VALUES (ticket,a);
  RETURN ticket; END $$;
CREATE FUNCTION north_star_internal.communication_admitted(ticket uuid) RETURNS platform.communication_admission
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE a platform.communication_admission; BEGIN
  IF NOT north_star_internal.communication_admission_table() THEN RAISE EXCEPTION 'communication.unavailable'; END IF;
  SELECT (admission).* INTO a FROM pg_temp.communication_admissions WHERE id=ticket;
  IF NOT FOUND OR (a.tenant_id,a.environment_id,a.principal_id) IS DISTINCT FROM
    (north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),north_star_internal.address_principal())
    THEN RAISE EXCEPTION 'communication.unavailable'; END IF;
  RETURN a; END $$;
CREATE FUNCTION north_star_internal.communication_check_staff(company uuid, staff uuid[]) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF EXISTS (SELECT FROM unnest(staff) s WHERE NOT EXISTS (
    SELECT FROM platform.current_policy_memberships m JOIN platform.current_policy_roles r USING (tenant_id,environment_id,role_id)
    WHERE (m.tenant_id,m.environment_id,m.principal_id)=(north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),s)
      AND m.revoked_at IS NULL AND r.revoked_at IS NULL AND (m.legal_entity_id IS NULL OR m.legal_entity_id=company)))
    THEN RAISE EXCEPTION 'communication.unavailable'; END IF; END $$;
-- Binding IDs come from the channel declaration. Target IDs come from the
-- stored primary row and the active release's physical relation mapping.
CREATE FUNCTION north_star_internal.communication_related(storage jsonb, entity text, id uuid, bindings text[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE table_name text; binding text; relation jsonb; target uuid; result jsonb:='{}'; BEGIN
  SELECT v->>'physicalTableName' INTO STRICT table_name FROM jsonb_array_elements(storage->'entities') v
    WHERE v->>'entityId'=entity AND v->>'lifecycle'='active';
  FOREACH binding IN ARRAY bindings LOOP
    SELECT v INTO STRICT relation FROM jsonb_array_elements(storage->'relations') v
      WHERE v->>'relationId'=binding AND v->>'sourceEntityId'=entity;
    EXECUTE format('SELECT %I FROM north_star_module.%I WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL',
      relation#>>'{relationColumn,physicalName}',table_name) INTO target
      USING north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),id;
    IF target IS NULL THEN RAISE EXCEPTION 'communication.unavailable'; END IF;
    result:=result || jsonb_build_object(binding,jsonb_build_object('entityId',relation->>'targetEntityId','recordId',target)); END LOOP;
  RETURN result;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'communication.unavailable'; END $$;

CREATE FUNCTION platform.communication_admit_record(company uuid, released uuid, expected_fence bigint, via text,
  primary_entity text, primary_record uuid, bindings text[], contacts platform.communication_record[], staff uuid[])
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a platform.communication_admission; storage jsonb; related jsonb; BEGIN
  storage:=platform.communication_fence(company,released,expected_fence);
  IF via IS NULL OR via NOT IN ('email/v1','staffDiscussion/v1') OR primary_entity IS NULL OR primary_record IS NULL
    OR bindings IS NULL OR contacts IS NULL OR staff IS NULL THEN RAISE EXCEPTION 'communication.invalidScope'; END IF;
  IF cardinality(bindings)>7 OR cardinality(staff)>32 OR cardinality(contacts)>32
    OR (via='staffDiscussion/v1' AND cardinality(contacts)>0) THEN RAISE EXCEPTION 'communication.invalidScope'; END IF;
  a.tenant_id:=north_star_internal.trusted_tenant_id(); a.environment_id:=north_star_internal.trusted_environment_id();
  a.company_id:=company; a.channel:=via; a.primary_entity:=primary_entity; a.primary_record:=primary_record;
  related:=north_star_internal.communication_related(storage,primary_entity,primary_record,bindings);
  a.requirements:=related;
  SELECT ARRAY(SELECT DISTINCT ROW(k.entity_id,k.record_id)::platform.communication_record FROM (
    SELECT primary_entity AS entity_id,primary_record AS record_id UNION ALL
    SELECT v->>'entityId',(v->>'recordId')::uuid FROM jsonb_each(related) AS b(id,v)) k ORDER BY 1) INTO a.links;
  a.contacts:=contacts; a.staff:=staff;
  PERFORM north_star_internal.communication_check_records(company,storage,a.links || contacts);
  IF related<>north_star_internal.communication_related(storage,primary_entity,primary_record,bindings)
    THEN RAISE EXCEPTION 'communication.recordChanged' USING ERRCODE='40001'; END IF;
  -- Independent communication action on the saved target. Contact disclosure
  -- and the binding's exact read remain obligations of the channel operation.
  IF EXISTS (SELECT FROM unnest(a.links) k WHERE (via='staffDiscussion/v1' OR k.entity_id=primary_entity AND k.record_id=primary_record)
    AND NOT platform.document_granted(company::text,replace(k.entity_id,':entity.',CASE via
      WHEN 'staffDiscussion/v1' THEN ':permission.discussion_post_' ELSE ':permission.prepare_email_' END),k.entity_id))
    THEN RAISE EXCEPTION 'communication.unavailable'; END IF;
  PERFORM north_star_internal.communication_check_staff(company,staff);
  a.principal_id:=north_star_internal.address_principal();
  RETURN north_star_internal.communication_ticket(a); END $$;

CREATE FUNCTION platform.communication_admit_direct(company uuid, released uuid, expected_fence bigint, peer uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a platform.communication_admission; BEGIN
  PERFORM platform.communication_fence(company,released,expected_fence);
  IF NOT platform.document_granted(company::text,'northstar.communication:permission.staff_chat_post','northstar.communication:resource.staff_chat')
    THEN RAISE EXCEPTION 'communication.unavailable'; END IF;
  a.principal_id:=north_star_internal.address_principal();
  IF peer IS NULL OR peer=a.principal_id THEN RAISE EXCEPTION 'communication.invalidScope'; END IF;
  a.tenant_id:=north_star_internal.trusted_tenant_id(); a.environment_id:=north_star_internal.trusted_environment_id();
  a.company_id:=company; a.channel:='staffDiscussion/v1';
  a.staff:=ARRAY[least(peer,a.principal_id),greatest(peer,a.principal_id)];
  PERFORM north_star_internal.communication_check_staff(company,a.staff);
  RETURN north_star_internal.communication_ticket(a); END $$;

CREATE FUNCTION platform.communication_register_discussion(ticket uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a platform.communication_admission:=north_star_internal.communication_admitted(ticket); BEGIN
  PERFORM north_star_internal.communication_before_threads();
  IF a.primary_record IS NULL OR a.channel IS DISTINCT FROM 'staffDiscussion/v1' THEN RAISE EXCEPTION 'communication.invalidScope'; END IF;
  INSERT INTO platform.communication_discussion_anchors VALUES
    (a.tenant_id,a.environment_id,a.company_id,a.primary_entity,a.primary_record,a.requirements)
    ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT FROM platform.communication_discussion_anchors
    WHERE (tenant_id,environment_id,company_id,primary_entity,primary_record,requirements)=
          (a.tenant_id,a.environment_id,a.company_id,a.primary_entity,a.primary_record,a.requirements))
    THEN RAISE EXCEPTION 'communication.unavailable'; END IF; END $$;

CREATE FUNCTION north_star_internal.communication_require_anchor(a platform.communication_admission) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF a.primary_record IS NOT NULL AND a.channel='staffDiscussion/v1' AND NOT EXISTS (SELECT FROM platform.communication_discussion_anchors
    WHERE (tenant_id,environment_id,company_id,primary_entity,primary_record,requirements)=
          (a.tenant_id,a.environment_id,a.company_id,a.primary_entity,a.primary_record,a.requirements))
    THEN RAISE EXCEPTION 'communication.unavailable'; END IF; END $$;

-- After any reminder occurrence lock, admit the complete batch before waiting
-- on anything. All callers sort the actual advisory keys, independent of channel.
CREATE FUNCTION platform.communication_lock_creations(tickets uuid[]) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ticket uuid; a platform.communication_admission; keys bigint[]:='{}'; key bigint; identity jsonb; BEGIN
  FOREACH ticket IN ARRAY tickets LOOP
    a:=north_star_internal.communication_admitted(ticket);
    PERFORM north_star_internal.communication_require_anchor(a);
    IF (SELECT creation_locked FROM pg_temp.communication_admissions WHERE id=ticket) THEN CONTINUE; END IF;
    identity:=CASE WHEN a.primary_record IS NULL THEN jsonb_build_array('staffDirect',a.staff)
      ELSE jsonb_build_array('record',a.primary_entity,a.primary_record) END;
    keys:=array_append(keys,hashtextextended(jsonb_build_array('communication.thread/v1',a.tenant_id,a.environment_id,a.company_id,identity)::text,0)); END LOOP;
  IF cardinality(keys)=0 THEN RETURN; END IF;
  PERFORM north_star_internal.communication_before_threads();
  FOR key IN SELECT DISTINCT k FROM unnest(keys) k ORDER BY k LOOP
    PERFORM pg_advisory_xact_lock(key); END LOOP;
  UPDATE pg_temp.communication_admissions SET creation_locked=true WHERE id=ANY(tickets); END $$;

-- Accept admissions only from a governed operation, within the admitting transaction.
-- Earlier fences (and the reminder occurrence if applicable) are already held.
CREATE FUNCTION platform.communication_resolve_thread(ticket uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a platform.communication_admission:=north_star_internal.communication_admitted(ticket); id_value uuid; BEGIN
  PERFORM platform.communication_lock_creations(ARRAY[ticket]);
  IF EXISTS (SELECT FROM pg_temp.communication_admissions WHERE participants_locked) THEN RAISE EXCEPTION 'communication.lockOrder'; END IF;
  IF a.primary_record IS NULL THEN
    SELECT thread_id INTO id_value FROM platform.communication_threads
      WHERE (tenant_id,environment_id,company_id,direct_pair)=(a.tenant_id,a.environment_id,a.company_id,a.staff) FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO platform.communication_threads (tenant_id,environment_id,company_id,audience,direct_pair)
        VALUES (a.tenant_id,a.environment_id,a.company_id,'staffDirect',a.staff) RETURNING thread_id INTO id_value; END IF;
    UPDATE pg_temp.communication_admissions SET thread_id=id_value WHERE communication_admissions.id=ticket;
    RETURN id_value; END IF;
  SELECT thread_id INTO id_value FROM platform.communication_threads
    WHERE (tenant_id,environment_id,company_id,primary_entity,primary_record,linked_records)=
          (a.tenant_id,a.environment_id,a.company_id,a.primary_entity,a.primary_record,a.links) FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO platform.communication_threads (tenant_id,environment_id,company_id,audience,primary_entity,primary_record,linked_records)
      VALUES (a.tenant_id,a.environment_id,a.company_id,'record',a.primary_entity,a.primary_record,a.links) RETURNING thread_id INTO id_value;
    INSERT INTO platform.communication_record_links
      SELECT a.tenant_id,a.environment_id,a.company_id,id_value,k.entity_id,k.record_id FROM unnest(a.links) k; END IF;
  UPDATE pg_temp.communication_admissions SET thread_id=id_value WHERE communication_admissions.id=ticket;
  RETURN id_value; END $$;

CREATE FUNCTION platform.communication_write_participants(ticket uuid, id uuid)
RETURNS SETOF uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a platform.communication_admission:=north_star_internal.communication_admitted(ticket); BEGIN
  IF NOT EXISTS (SELECT FROM pg_temp.communication_admissions t WHERE t.id=ticket AND t.thread_id=communication_write_participants.id)
    THEN RAISE EXCEPTION 'communication.unavailable'; END IF;
  INSERT INTO platform.communication_participants (tenant_id,environment_id,company_id,thread_id,channel,participant_kind,entity_id,subject_id)
    SELECT a.tenant_id,a.environment_id,a.company_id,id,a.channel,p.kind,p.entity,p.subject FROM (
      SELECT 'staff' AS kind,'' AS entity,s AS subject FROM unnest(a.staff) s UNION
      SELECT 'contact',k.entity_id,k.record_id FROM unnest(a.contacts) k) p ORDER BY p.kind,p.entity,p.subject
    ON CONFLICT DO NOTHING;
  UPDATE pg_temp.communication_admissions t SET participants_locked=true WHERE t.id=ticket;
  RETURN QUERY SELECT p.participant_id FROM platform.communication_participants p
    WHERE (p.tenant_id,p.environment_id,p.company_id,p.thread_id,p.channel)=(a.tenant_id,a.environment_id,a.company_id,id,a.channel)
      AND ((p.participant_kind='staff' AND p.subject_id=ANY(a.staff)) OR
           (p.participant_kind='contact' AND ROW(p.entity_id,p.subject_id)::platform.communication_record=ANY(a.contacts)))
    ORDER BY p.participant_kind,p.entity_id,p.subject_id FOR UPDATE; END $$;

-- Existing-thread consumers pass the channel after their channel-specific
-- admission. They never acquire a creation key while holding a thread row.
CREATE FUNCTION platform.communication_lock_thread(ticket uuid, id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a platform.communication_admission:=north_star_internal.communication_admitted(ticket); BEGIN
  PERFORM north_star_internal.communication_require_anchor(a);
  IF EXISTS (SELECT FROM pg_temp.communication_admissions WHERE participants_locked) THEN RAISE EXCEPTION 'communication.lockOrder'; END IF;
  -- By-ID operations can lock several threads; order their scoped IDs and
  -- refuse a backwards acquisition before touching the next row.
  IF EXISTS (SELECT FROM pg_temp.communication_admissions WHERE thread_id>communication_lock_thread.id)
    THEN RAISE EXCEPTION 'communication.lockOrder'; END IF;
  PERFORM FROM platform.communication_threads
    WHERE (tenant_id,environment_id,company_id,thread_id)=(a.tenant_id,a.environment_id,a.company_id,id)
      AND ((audience='record' AND (primary_entity,primary_record,linked_records)=(a.primary_entity,a.primary_record,a.links))
        OR (audience='staffDirect' AND a.primary_record IS NULL AND direct_pair=a.staff)) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'communication.unavailable'; END IF;
  UPDATE pg_temp.communication_admissions t SET thread_id=communication_lock_thread.id WHERE t.id=ticket; END $$;
REVOKE ALL ON FUNCTION north_star_internal.communication_before_threads(),north_star_internal.communication_admission_table(),
  north_star_internal.communication_related(jsonb,text,uuid,text[]),
  north_star_internal.communication_require_anchor(platform.communication_admission),
  north_star_internal.communication_ticket(platform.communication_admission),
  north_star_internal.communication_admitted(uuid),north_star_internal.communication_check_staff(uuid,uuid[]),
  north_star_internal.communication_check_records(uuid,jsonb,platform.communication_record[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.communication_fence(uuid,uuid,bigint) FROM PUBLIC;
DO $grants$ DECLARE fn regprocedure; BEGIN
  FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='platform' AND p.proname IN ('communication_admit_record','communication_admit_direct','communication_register_discussion',
      'communication_lock_creations','communication_resolve_thread','communication_write_participants','communication_lock_thread') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO north_star_communication_operation',fn); END LOOP; END $grants$;
