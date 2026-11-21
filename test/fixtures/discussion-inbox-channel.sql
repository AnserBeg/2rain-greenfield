-- COMMS-2's channel side of the boundary. The stored parent, mention revision
-- and visibility rows can change independently of a committed inbox lease.
CREATE TABLE public.fixture_discussion_messages (
  tenant_id uuid, environment_id uuid, company_id uuid, thread_id uuid, message_id uuid,
  author_id uuid NOT NULL, mentions uuid[] NOT NULL DEFAULT '{}', parent_id uuid,
  visible_to uuid[] NOT NULL, tombstone boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id,environment_id,company_id,thread_id,message_id)
);
CREATE FUNCTION north_star_internal.discussion_notice_source_v1(t uuid,e uuid,c uuid,th uuid,msg uuid)
RETURNS platform.discussion_notice_source LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT m.author_id,m.mentions,p.message_id,p.author_id FROM public.fixture_discussion_messages m
    LEFT JOIN public.fixture_discussion_messages p ON
      (p.tenant_id,p.environment_id,p.company_id,p.thread_id,p.message_id)=(t,e,c,th,m.parent_id)
  WHERE (m.tenant_id,m.environment_id,m.company_id,m.thread_id,m.message_id)=(t,e,c,th,msg) AND NOT m.tombstone
$$;
CREATE FUNCTION north_star_internal.discussion_can_read_message_v1(t uuid,e uuid,c uuid,th uuid,msg uuid,person uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS (SELECT FROM public.fixture_discussion_messages m WHERE
    (m.tenant_id,m.environment_id,m.company_id,m.thread_id,m.message_id)=(t,e,c,th,msg)
    AND person=ANY(m.visible_to) AND NOT m.tombstone)
$$;
CREATE FUNCTION north_star_internal.discussion_notice_fence_v1(t uuid,e uuid,c uuid,th uuid,msg uuid)
RETURNS void LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
  SELECT FROM platform.current_policy_epochs WHERE (tenant_id,environment_id)=(t,e) FOR SHARE
$$;
REVOKE ALL ON FUNCTION north_star_internal.discussion_notice_source_v1(uuid,uuid,uuid,uuid,uuid),
  north_star_internal.discussion_can_read_message_v1(uuid,uuid,uuid,uuid,uuid,uuid),
  north_star_internal.discussion_notice_fence_v1(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
