-- COMMS-2 publishes a locator in the message transaction. No text, grant,
-- recipient list or decision belongs to the queue.
CREATE TABLE platform.discussion_notice_occurrences (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, company_id uuid NOT NULL,
  thread_id uuid NOT NULL, message_id uuid NOT NULL, occurrence_id uuid NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid, available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reconciled_at timestamptz,
  PRIMARY KEY (tenant_id,environment_id,company_id,occurrence_id),
  FOREIGN KEY (tenant_id,environment_id,company_id,thread_id) REFERENCES platform.communication_threads
);
CREATE INDEX discussion_notice_due ON platform.discussion_notice_occurrences
  (tenant_id,environment_id,available_at,enqueued_at,occurrence_id) WHERE reconciled_at IS NULL;
CREATE UNIQUE INDEX discussion_notice_lease ON platform.discussion_notice_occurrences(lease_token)
  WHERE lease_token IS NOT NULL;

CREATE TABLE platform.personal_inbox (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, company_id uuid NOT NULL,
  recipient_id uuid NOT NULL, entry_id uuid NOT NULL DEFAULT gen_random_uuid(),
  entry_number bigint GENERATED ALWAYS AS IDENTITY,
  channel text NOT NULL CHECK (channel='staffDiscussion/v1'),
  thread_id uuid NOT NULL, message_id uuid NOT NULL,
  reasons text[] NOT NULL, read_at timestamptz, archived_at timestamptz,
  PRIMARY KEY (tenant_id,environment_id,company_id,recipient_id,entry_id),
  UNIQUE (tenant_id,environment_id,company_id,channel,thread_id,message_id,recipient_id),
  FOREIGN KEY (tenant_id,environment_id,company_id,thread_id) REFERENCES platform.communication_threads,
  FOREIGN KEY (tenant_id,environment_id,recipient_id) REFERENCES platform.staff_accounts
);
CREATE INDEX personal_inbox_recipient_page ON platform.personal_inbox
  (tenant_id,environment_id,company_id,recipient_id,channel,entry_number DESC) WHERE archived_at IS NULL;
ALTER TABLE platform.personal_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.personal_inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.discussion_notice_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.discussion_notice_occurrences FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform.personal_inbox,platform.discussion_notice_occurrences FROM PUBLIC,north_star_runtime,north_star_workflow_worker,north_star_communication_operation;

CREATE FUNCTION north_star_internal.inbox_require_writer() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inbox.requiresReadCommitted'; END IF; END $$;

-- The first channel supplies two ordinary reads with the same scope. Its
-- migration installs these private functions alongside its message store.
-- They are resolved only in the owned schema. An absent channel cannot serve.
CREATE TYPE platform.discussion_notice_source AS (
  author_id uuid, mentioned_ids uuid[], parent_id uuid, parent_author_id uuid
);
CREATE FUNCTION north_star_internal.inbox_source(c uuid, th uuid, msg uuid)
RETURNS platform.discussion_notice_source LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF to_regprocedure('north_star_internal.discussion_notice_source_v1(uuid,uuid,uuid,uuid,uuid)') IS NULL THEN RETURN NULL; END IF;
  RETURN north_star_internal.discussion_notice_source_v1(north_star_internal.trusted_tenant_id(),
    north_star_internal.trusted_environment_id(),c,th,msg); END $$;
CREATE FUNCTION north_star_internal.inbox_member(c uuid, person uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT FROM platform.staff_accounts s
    JOIN platform.current_policy_memberships m USING (tenant_id,environment_id,principal_id)
    JOIN platform.current_policy_roles r USING (tenant_id,environment_id,role_id)
    WHERE (s.tenant_id,s.environment_id,s.principal_id)=(north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),person)
      AND s.status='active' AND m.revoked_at IS NULL AND r.revoked_at IS NULL
      AND (m.legal_entity_id IS NULL OR m.legal_entity_id=c))
$$;
CREATE FUNCTION north_star_internal.inbox_can_read(c uuid, th uuid, msg uuid, person uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NOT north_star_internal.inbox_member(c,person) OR
     to_regprocedure('north_star_internal.discussion_can_read_message_v1(uuid,uuid,uuid,uuid,uuid,uuid)') IS NULL
    THEN RETURN false; END IF;
  RETURN north_star_internal.discussion_can_read_message_v1(north_star_internal.trusted_tenant_id(),
    north_star_internal.trusted_environment_id(),c,th,msg,person) IS TRUE; END $$;
CREATE FUNCTION north_star_internal.inbox_reasons(c uuid, th uuid, msg uuid, person uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE s platform.discussion_notice_source; result text[]:='{}'; BEGIN
  s:=north_star_internal.inbox_source(c,th,msg);
  IF s.author_id IS NULL OR s.author_id=person OR NOT north_star_internal.inbox_can_read(c,th,msg,person)
    THEN RETURN result; END IF;
  IF person=ANY(s.mentioned_ids) THEN result:=array_append(result,'mention'); END IF;
  IF s.parent_author_id=person AND north_star_internal.inbox_can_read(c,th,s.parent_id,person)
    THEN result:=array_append(result,'reply'); END IF;
  RETURN result; END $$;

CREATE FUNCTION platform.enqueue_discussion_notice(c uuid, th uuid, msg uuid, occurrence uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id(); BEGIN
  PERFORM north_star_internal.inbox_require_writer();
  INSERT INTO platform.discussion_notice_occurrences(tenant_id,environment_id,company_id,thread_id,message_id,occurrence_id)
    VALUES(t,e,c,th,msg,occurrence) ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT FROM platform.discussion_notice_occurrences WHERE
    (tenant_id,environment_id,company_id,occurrence_id,thread_id,message_id)=(t,e,c,occurrence,th,msg))
    THEN RAISE EXCEPTION 'inbox.occurrenceConflict'; END IF; END $$;
CREATE FUNCTION platform.claim_discussion_notice()
RETURNS TABLE(company_id uuid,thread_id uuid,message_id uuid,lease_token uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  PERFORM north_star_internal.inbox_require_writer();
  RETURN QUERY WITH next AS (
    SELECT o.ctid FROM platform.discussion_notice_occurrences o
    WHERE (o.tenant_id,o.environment_id)=(north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id())
      AND o.reconciled_at IS NULL AND o.available_at<=statement_timestamp()
    ORDER BY o.available_at,o.enqueued_at,o.occurrence_id LIMIT 1 FOR UPDATE SKIP LOCKED
  ) UPDATE platform.discussion_notice_occurrences o SET lease_token=gen_random_uuid(),available_at=clock_timestamp()+interval '30 seconds'
    FROM next WHERE o.ctid=next.ctid RETURNING o.company_id,o.thread_id,o.message_id,o.lease_token; END $$;
CREATE FUNCTION platform.acknowledge_discussion_notice(c uuid, th uuid, msg uuid, token uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  PERFORM north_star_internal.inbox_require_writer();
  UPDATE platform.discussion_notice_occurrences SET reconciled_at=clock_timestamp(),lease_token=NULL WHERE
    (tenant_id,environment_id,company_id,thread_id,message_id,lease_token)=
    (north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),c,th,msg,token);
  RETURN FOUND; END $$;

-- The channel fences saved records and membership before the shared R11 thread
-- lock. A missing adapter leaves the committed lease retryable, including for
-- a tombstone. The thread serializes revisions, membership and reconciliation.
CREATE FUNCTION platform.lock_discussion_notice(c uuid, th uuid, msg uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id(); BEGIN
  PERFORM north_star_internal.inbox_require_writer();
  -- Only the definer owns this transaction-local ticket. Multiple calls for
  -- one message reuse the held fences. A second message needs a fresh transaction.
  IF to_regclass('pg_temp.personal_inbox_lock') IS NOT NULL THEN
    IF EXISTS (SELECT FROM pg_class WHERE oid=to_regclass('pg_temp.personal_inbox_lock')
      AND relowner=current_user::regrole AND relkind='r') THEN
      IF EXISTS (SELECT FROM pg_temp.personal_inbox_lock l WHERE
        (l.tenant_id,l.environment_id,l.company_id,l.thread_id,l.message_id)=(t,e,c,th,msg)) THEN RETURN; END IF; END IF;
    RAISE EXCEPTION 'inbox.lockOrder'; END IF;
  IF to_regprocedure('north_star_internal.discussion_notice_fence_v1(uuid,uuid,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('north_star_internal.discussion_notice_source_v1(uuid,uuid,uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('north_star_internal.discussion_can_read_message_v1(uuid,uuid,uuid,uuid,uuid,uuid)') IS NULL
    THEN RAISE EXCEPTION 'inbox.channelUnavailable'; END IF;
  PERFORM north_star_internal.discussion_notice_fence_v1(t,e,c,th,msg);
  PERFORM FROM platform.communication_threads WHERE (tenant_id,environment_id,company_id,thread_id)=(t,e,c,th) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inbox.unavailable'; END IF;
  CREATE TEMP TABLE personal_inbox_lock ON COMMIT DROP AS
    SELECT t AS tenant_id,e AS environment_id,c AS company_id,th AS thread_id,msg AS message_id;
  REVOKE ALL ON pg_temp.personal_inbox_lock FROM PUBLIC; END $$;

CREATE FUNCTION platform.discussion_notice_source(c uuid, th uuid, msg uuid) RETURNS platform.discussion_notice_source
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT north_star_internal.inbox_source(c,th,msg)
$$;
CREATE FUNCTION platform.discussion_notice_readable(c uuid, th uuid, msg uuid, person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT north_star_internal.inbox_can_read(c,th,msg,person)
$$;
CREATE FUNCTION platform.reconcile_discussion_notice(c uuid, th uuid, msg uuid, expected jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  s platform.discussion_notice_source; candidates uuid[]; decision jsonb; person uuid; reasons text[]; BEGIN
  -- Enforce the lock even for callers entering the writer directly. The host
  -- already holds it when it submits the decisions from the published port.
  PERFORM platform.lock_discussion_notice(c,th,msg);
  s:=north_star_internal.inbox_source(c,th,msg);
  candidates:=ARRAY(SELECT DISTINCT p FROM unnest(array_append(s.mentioned_ids,s.parent_author_id)) p WHERE p IS NOT NULL ORDER BY p);
  IF cardinality(candidates)>11 THEN RAISE EXCEPTION 'inbox.recipientLimit'; END IF;
  decision:='{}';
  FOREACH person IN ARRAY candidates LOOP
    reasons:=north_star_internal.inbox_reasons(c,th,msg,person);
    IF cardinality(reasons)>0 THEN decision:=decision || jsonb_build_object(person,reasons); END IF; END LOOP;
  IF decision IS DISTINCT FROM expected THEN RAISE EXCEPTION 'inbox.recipientsChanged'; END IF;
  UPDATE platform.personal_inbox SET reasons='{}' WHERE
    (tenant_id,environment_id,company_id,channel,thread_id,message_id)=(t,e,c,'staffDiscussion/v1',th,msg)
    AND cardinality(personal_inbox.reasons)>0 AND NOT decision ? recipient_id::text;
  INSERT INTO platform.personal_inbox (tenant_id,environment_id,company_id,channel,thread_id,message_id,recipient_id,reasons)
    SELECT t,e,c,'staffDiscussion/v1',th,msg,key::uuid,ARRAY(SELECT jsonb_array_elements_text(value))
    FROM jsonb_each(decision) ORDER BY key
    ON CONFLICT (tenant_id,environment_id,company_id,channel,thread_id,message_id,recipient_id) DO UPDATE
    SET reasons=excluded.reasons WHERE personal_inbox.reasons<>excluded.reasons; END $$;

-- A locator is meaningful only to its own recipient. Every query, including a
-- copied ID and the count, rechecks the exact current message and reply parent.
CREATE FUNCTION north_star_internal.personal_inbox_rows(c uuid, via text, before_id uuid, exact_id uuid, unread_only boolean, row_limit integer)
RETURNS TABLE(entry_id uuid,thread_id uuid,message_id uuid,reasons text[],unread boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT n.entry_id,n.thread_id,n.message_id,r.reasons,n.read_at IS NULL
  FROM platform.personal_inbox n
  CROSS JOIN LATERAL (SELECT north_star_internal.inbox_reasons(c,n.thread_id,n.message_id,n.recipient_id) AS reasons OFFSET 0) r
  WHERE (n.tenant_id,n.environment_id,n.company_id,n.recipient_id,n.channel)=(north_star_internal.trusted_tenant_id(),
    north_star_internal.trusted_environment_id(),c,north_star_internal.address_principal(),via)
    AND (before_id IS NULL OR n.entry_number<(SELECT b.entry_number FROM platform.personal_inbox b
      WHERE (b.tenant_id,b.environment_id,b.company_id,b.recipient_id,b.channel,b.entry_id)=
        (n.tenant_id,n.environment_id,n.company_id,n.recipient_id,n.channel,before_id))) AND (exact_id IS NULL OR n.entry_id=exact_id)
    AND (NOT unread_only OR n.read_at IS NULL)
    AND via='staffDiscussion/v1' AND n.archived_at IS NULL AND cardinality(n.reasons)>0 AND cardinality(r.reasons)>0
  ORDER BY n.entry_number DESC LIMIT row_limit
$$;
CREATE FUNCTION platform.personal_inbox_page(c uuid, via text, before_id uuid DEFAULT NULL)
RETURNS TABLE(entry_id uuid,thread_id uuid,message_id uuid,reasons text[],unread boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM north_star_internal.personal_inbox_rows(c,via,before_id,NULL,false,25)
$$;
CREATE FUNCTION platform.personal_inbox_entry(c uuid, via text, id uuid)
RETURNS TABLE(entry_id uuid,thread_id uuid,message_id uuid,reasons text[],unread boolean)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM north_star_internal.personal_inbox_rows(c,via,NULL,id,false,1)
$$;
CREATE FUNCTION platform.personal_inbox_unread(c uuid, via text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*)::integer FROM north_star_internal.personal_inbox_rows(c,via,NULL,NULL,true,100)
$$;
CREATE FUNCTION platform.personal_inbox_mark(c uuid, via text, id uuid, action text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  person uuid:=north_star_internal.address_principal(); n record; BEGIN
  PERFORM north_star_internal.inbox_require_writer();
  IF action NOT IN ('read','archive') OR action IS NULL THEN RAISE EXCEPTION 'inbox.invalidAction'; END IF;
  SELECT * INTO n FROM platform.personal_inbox_entry(c,via,id);
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM platform.lock_discussion_notice(c,n.thread_id,n.message_id);
  IF NOT EXISTS (SELECT FROM platform.personal_inbox_entry(c,via,id)) THEN RETURN false; END IF;
  UPDATE platform.personal_inbox SET
    read_at=CASE WHEN action='read' THEN coalesce(read_at,clock_timestamp()) ELSE read_at END,
    archived_at=CASE WHEN action='archive' THEN coalesce(archived_at,clock_timestamp()) ELSE archived_at END
    WHERE (tenant_id,environment_id,company_id,recipient_id,entry_id)=(t,e,c,person,id);
  RETURN FOUND; END $$;
REVOKE ALL ON FUNCTION north_star_internal.inbox_require_writer(),north_star_internal.inbox_source(uuid,uuid,uuid),
  north_star_internal.inbox_member(uuid,uuid),north_star_internal.inbox_can_read(uuid,uuid,uuid,uuid),
  north_star_internal.inbox_reasons(uuid,uuid,uuid,uuid),north_star_internal.personal_inbox_rows(uuid,text,uuid,uuid,boolean,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.enqueue_discussion_notice(uuid,uuid,uuid,uuid),platform.claim_discussion_notice(),
  platform.acknowledge_discussion_notice(uuid,uuid,uuid,uuid),platform.lock_discussion_notice(uuid,uuid,uuid),
  platform.discussion_notice_source(uuid,uuid,uuid),platform.discussion_notice_readable(uuid,uuid,uuid,uuid),
  platform.reconcile_discussion_notice(uuid,uuid,uuid,jsonb),platform.personal_inbox_page(uuid,text,uuid),
  platform.personal_inbox_entry(uuid,text,uuid),platform.personal_inbox_unread(uuid,text),platform.personal_inbox_mark(uuid,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.enqueue_discussion_notice(uuid,uuid,uuid,uuid) TO north_star_communication_operation;
GRANT EXECUTE ON FUNCTION platform.claim_discussion_notice(),platform.acknowledge_discussion_notice(uuid,uuid,uuid,uuid),
  platform.lock_discussion_notice(uuid,uuid,uuid),platform.discussion_notice_source(uuid,uuid,uuid),
  platform.discussion_notice_readable(uuid,uuid,uuid,uuid),platform.reconcile_discussion_notice(uuid,uuid,uuid,jsonb) TO north_star_workflow_worker;
GRANT EXECUTE ON FUNCTION platform.personal_inbox_page(uuid,text,uuid),platform.personal_inbox_entry(uuid,text,uuid),
  platform.personal_inbox_unread(uuid,text),platform.personal_inbox_mark(uuid,text,uuid,text) TO north_star_runtime;
