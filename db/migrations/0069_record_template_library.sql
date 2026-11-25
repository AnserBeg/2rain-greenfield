-- One company library shared by every declared collection. Business content
-- and its publication history outlive the release that admitted the binding.
CREATE TABLE platform.record_template_libraries (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, company_id uuid NOT NULL,
  library_id uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY(tenant_id,environment_id,company_id), UNIQUE(tenant_id,environment_id,library_id),
  FOREIGN KEY(tenant_id,environment_id) REFERENCES platform.environments(tenant_id,id)
);
CREATE TABLE platform.record_templates (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, library_id uuid NOT NULL,
  template_id uuid NOT NULL, form_id text NOT NULL, latest integer NOT NULL, retired boolean NOT NULL DEFAULT false,
  PRIMARY KEY(tenant_id,environment_id,template_id),
  FOREIGN KEY(tenant_id,environment_id,library_id) REFERENCES platform.record_template_libraries(tenant_id,environment_id,library_id)
);
CREATE TABLE platform.record_template_reviews (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, library_id uuid NOT NULL,
  review_id uuid NOT NULL DEFAULT gen_random_uuid(), principal_id uuid NOT NULL,
  release_id uuid NOT NULL, fence bigint NOT NULL, form_id text NOT NULL, binding_revision uuid NOT NULL,
  template_id uuid NOT NULL, predecessor integer NOT NULL CHECK (predecessor >= 0),
  content jsonb NOT NULL, digest text NOT NULL,
  PRIMARY KEY(tenant_id,environment_id,review_id),
  FOREIGN KEY(tenant_id,environment_id,library_id) REFERENCES platform.record_template_libraries(tenant_id,environment_id,library_id)
);
CREATE TABLE platform.record_template_revisions (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, template_id uuid NOT NULL,
  number integer NOT NULL, revision_id uuid NOT NULL DEFAULT gen_random_uuid(), review_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,environment_id,template_id,number), UNIQUE(tenant_id,environment_id,revision_id),
  FOREIGN KEY(tenant_id,environment_id,review_id) REFERENCES platform.record_template_reviews,
  FOREIGN KEY(tenant_id,environment_id,template_id) REFERENCES platform.record_templates
);
-- Append-only assignment versions are also the assignment audit. Publishing
-- and retirement describe their actor and exact release in the library audit.
CREATE TABLE platform.record_template_assignments (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, library_id uuid NOT NULL,
  form_id text NOT NULL, context_key text NOT NULL, version integer NOT NULL, revision_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,environment_id,library_id,form_id,context_key,version),
  FOREIGN KEY(tenant_id,environment_id,library_id) REFERENCES platform.record_template_libraries(tenant_id,environment_id,library_id),
  FOREIGN KEY(tenant_id,environment_id,revision_id) REFERENCES platform.record_template_revisions(tenant_id,environment_id,revision_id)
);
CREATE TABLE platform.record_template_audit (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, environment_id uuid NOT NULL,
  library_id uuid NOT NULL, principal_id uuid NOT NULL, release_id uuid NOT NULL, fence bigint NOT NULL,
  action text NOT NULL, details jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,environment_id,library_id) REFERENCES platform.record_template_libraries(tenant_id,environment_id,library_id)
);
DO $tables$ DECLARE tbl regclass; BEGIN
  FOREACH tbl IN ARRAY ARRAY['platform.record_template_libraries'::regclass,'platform.record_templates'::regclass,
    'platform.record_template_reviews'::regclass,'platform.record_template_revisions'::regclass,
    'platform.record_template_assignments'::regclass,'platform.record_template_audit'::regclass] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, north_star_runtime',tbl); END LOOP; END $tables$;

CREATE FUNCTION north_star_internal.template_access(company uuid, released uuid, expected_fence bigint,
  form text, privilege text, writing boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  app jsonb; binding jsonb; master jsonb; stored uuid; BEGIN
  IF writing AND current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'template.requiresReadCommitted'; END IF;
  IF writing THEN
    PERFORM FROM platform.active_release_pointers WHERE (tenant_id,environment_id,release_id,fence)=(t,e,released,expected_fence) FOR SHARE;
  ELSE
    PERFORM FROM platform.active_release_pointers WHERE (tenant_id,environment_id,release_id,fence)=(t,e,released,expected_fence); END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'template.staleRelease'; END IF;
  IF writing THEN PERFORM platform.lock_current_policy_epoch(t,e); END IF;
  IF NOT north_star_internal.address_member(company)
    OR NOT platform.document_granted(company::text,replace(form,':surface.',':permission.template_'||privilege||'_'),form)
    THEN RAISE EXCEPTION 'template.unavailable'; END IF;
  IF writing THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('record-template-library/'||t::text||'/'||e::text||'/'||company::text,0)); END IF;
  SELECT v INTO STRICT master FROM jsonb_array_elements(platform.document_storage(t,e)->'entities') v WHERE v ? 'legalEntityMaster';
  EXECUTE format('SELECT record_id FROM north_star_module.%I WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL AND %I=$4 %s',
    master->>'physicalTableName',master#>>'{legalEntityMaster,fieldColumns,status}',CASE WHEN writing THEN 'FOR SHARE' ELSE '' END) INTO stored USING t,e,company,master#>>'{legalEntityMaster,activeStatusValue}';
  IF stored IS NULL THEN RAISE EXCEPTION 'template.unavailable'; END IF;
  app:=platform.document_app(t,e,released);
  SELECT s->'recordTemplateBinding' INTO binding FROM jsonb_array_elements(app->'surfaces') s
    WHERE s->>'surfaceId'=form AND s->>'lifecycle'='active';
  IF binding IS NULL OR (writing AND binding->>'status'<>'active') THEN RAISE EXCEPTION 'template.bindingUnavailable'; END IF;
  RETURN binding; END $$;

-- Validate the exact selected columns and source cells under today's grants.
-- Each source identifies a line and its parent. Lock ALL source rows/parents
-- first in the existing descendant-before-ancestor order.
CREATE FUNCTION north_star_internal.template_content(company uuid, released uuid, binding jsonb, content jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  app jsonb:=platform.document_app(t,e,released); storage jsonb:=platform.document_storage(t,e);
  body jsonb:=binding->'body'; member jsonb; col jsonb; item record; field jsonb; typed text; actual text;
  line_spec jsonb; source_query jsonb; refs platform.communication_record[]; BEGIN
  IF (jsonb_typeof(content)='object' AND content-'version'-'label'-'columns'-'members'='{}'
      AND content->'version'='1' AND jsonb_typeof(content->'label')='string' AND length(trim(content->>'label')) BETWEEN 1 AND 120
      AND jsonb_typeof(content->'columns')='array' AND jsonb_array_length(content->'columns') BETWEEN 1 AND 24
      AND jsonb_typeof(content->'members')='array' AND jsonb_array_length(content->'members') BETWEEN 1 AND 100
      AND octet_length(content::text)<=65536) IS NOT TRUE THEN RAISE EXCEPTION 'template.invalidContent'; END IF;
  IF EXISTS (SELECT FROM jsonb_array_elements(content->'columns') c WHERE
    (c-'fieldId'-'caption'='{}' AND jsonb_typeof(c->'caption')='string' AND length(trim(c->>'caption')) BETWEEN 1 AND 120
      AND EXISTS(SELECT FROM jsonb_array_elements(body->'columns') b WHERE b->>'fieldId'=c->>'fieldId')) IS NOT TRUE)
    OR EXISTS(SELECT FROM jsonb_array_elements(content->'columns') c GROUP BY c->>'fieldId' HAVING count(*)>1)
    OR EXISTS(SELECT FROM jsonb_array_elements(content->'members') m GROUP BY m->>'key' HAVING count(*)>1)
    THEN RAISE EXCEPTION 'template.invalidSelection'; END IF;
  IF EXISTS(SELECT FROM jsonb_array_elements(body->'columns') b WHERE b->'required'='true' AND NOT EXISTS(
    SELECT FROM jsonb_array_elements(content->'columns') c WHERE c->>'fieldId'=b->>'fieldId')) THEN RAISE EXCEPTION 'template.requiredColumn'; END IF;
  SELECT v INTO STRICT line_spec FROM jsonb_array_elements(storage->'entities') v WHERE v->>'entityId'=body->>'lineEntityId';
  SELECT array_agg(DISTINCT ROW(x.entity,x.id)::platform.communication_record) INTO refs
    FROM jsonb_array_elements(content->'members') m CROSS JOIN LATERAL
    (VALUES(body->>'lineEntityId',(m#>>'{source,rowId}')::uuid),(body->>'entityId',(m#>>'{source,parentId}')::uuid)) x(entity,id)
    WHERE m ? 'source';
  IF refs IS NOT NULL THEN
    PERFORM north_star_internal.communication_check_records(company,storage,refs);
    source_query:=north_star_internal.communication_exact_query(app,body->>'lineEntityId');
    PERFORM north_star_internal.communication_check_read(company,company,app,source_query);
    PERFORM north_star_internal.communication_check_read(company,company,app,north_star_internal.communication_exact_query(app,body->>'entityId')); END IF;
  FOR member IN SELECT value FROM jsonb_array_elements(content->'members') LOOP
    IF (member-'key'-'kind'-'caption'-'cells'-'source'-'answer'-'help'='{}' AND jsonb_typeof(member->'key')='string'
      AND member->>'key' ~ '^[a-z][a-z0-9_-]{0,63}$' AND member->>'kind' IN ('question','row','section','instruction','member')
      AND jsonb_typeof(member->'caption')='string' AND length(trim(member->>'caption')) BETWEEN 1 AND 500
      AND jsonb_typeof(member->'cells')='object') IS NOT TRUE THEN RAISE EXCEPTION 'template.invalidMember'; END IF;
    IF member ? 'help' AND (jsonb_typeof(member->'help')<>'string' OR length(trim(member->>'help')) NOT BETWEEN 1 AND 1000)
      THEN RAISE EXCEPTION 'template.invalidHelp'; END IF;
    IF (member->>'kind'='question') IS DISTINCT FROM (member ? 'answer') THEN RAISE EXCEPTION 'template.answerRequired'; END IF;
    IF member ? 'answer' THEN
      SELECT b INTO col FROM jsonb_array_elements(body->'columns') b WHERE b->>'fieldId'=member#>>'{answer,fieldId}';
      IF (col IS NOT NULL AND (member->'answer')-'fieldId'-'required'-'choices'-'noteFieldId'='{}'
        AND jsonb_typeof(member#>'{answer,required}')='boolean'
        AND jsonb_typeof(member#>'{answer,choices}')='array'
        AND jsonb_array_length(member#>'{answer,choices}')<=64
        AND (col->>'fieldType'='enumFieldType')=(jsonb_array_length(member#>'{answer,choices}')>0)
        AND EXISTS(SELECT FROM jsonb_array_elements(content->'columns') c WHERE c->>'fieldId'=col->>'fieldId')
        AND NOT ((member->'cells') ? (col->>'fieldId'))) IS NOT TRUE THEN RAISE EXCEPTION 'template.invalidAnswer'; END IF;
      IF member->'answer' ? 'noteFieldId' AND NOT EXISTS(
        SELECT FROM jsonb_array_elements(body->'columns') b JOIN jsonb_array_elements(content->'columns') c
          ON b->>'fieldId'=c->>'fieldId' WHERE b->>'fieldId'=member#>>'{answer,noteFieldId}' AND b->>'fieldType'='textFieldType'
          AND b->>'fieldId'<>member#>>'{answer,fieldId}' AND NOT ((member->'cells') ? (b->>'fieldId')))
        THEN RAISE EXCEPTION 'template.invalidNote'; END IF;
      IF EXISTS(SELECT FROM jsonb_array_elements(member#>'{answer,choices}') opt WHERE (
          opt-'id'-'meaning'-'requiresNote'-'blocksTransition'='{}' AND jsonb_typeof(opt->'meaning')='string'
          AND length(trim(opt->>'meaning')) BETWEEN 1 AND 180 AND jsonb_typeof(opt->'requiresNote')='boolean'
          AND jsonb_typeof(opt->'blocksTransition')='boolean' AND (opt->'requiresNote'='false' OR member->'answer' ? 'noteFieldId')
          AND EXISTS(SELECT FROM jsonb_array_elements(app->'fields') f CROSS JOIN LATERAL jsonb_array_elements(f#>'{fieldType,options}') o
            WHERE f->>'fieldId'=col->>'fieldId' AND o->>'optionId'=opt->>'id' AND o->>'label'=opt->>'meaning')) IS NOT TRUE)
        OR EXISTS(SELECT FROM jsonb_array_elements(member#>'{answer,choices}') opt GROUP BY opt->>'id' HAVING count(*)>1)
        THEN RAISE EXCEPTION 'template.invalidChoice'; END IF; END IF;
    IF member->>'kind' IN ('row','member') AND EXISTS(SELECT FROM jsonb_array_elements(body->'columns') c
      WHERE c->'required'='true' AND NOT ((member->'cells') ? (c->>'fieldId'))) THEN RAISE EXCEPTION 'template.requiredDefault'; END IF;
    IF member ? 'source' AND ((member->'source')-'rowId'-'parentId'<>'{}' OR
      platform.document_record_revision(t,e,storage,body->>'lineEntityId',company::text,(member#>>'{source,rowId}')::uuid,
      body->>'parentRelationId',(member#>>'{source,parentId}')::uuid) IS NULL) THEN RAISE EXCEPTION 'template.sourceUnavailable'; END IF;
    FOR item IN SELECT key,value FROM jsonb_each(member->'cells') LOOP
      SELECT b INTO col FROM jsonb_array_elements(body->'columns') b WHERE b->>'fieldId'=item.key;
      IF col IS NULL OR col->'copyEligible' IS DISTINCT FROM 'true'::jsonb OR
        NOT EXISTS(SELECT FROM jsonb_array_elements(content->'columns') c WHERE c->>'fieldId'=item.key)
        THEN RAISE EXCEPTION 'template.copyIneligible'; END IF;
      SELECT v INTO STRICT field FROM jsonb_array_elements(app->'fields') v WHERE v->>'fieldId'=item.key;
      typed:=item.value#>>'{}';
      IF (CASE col->>'fieldType'
        WHEN 'textFieldType' THEN jsonb_typeof(item.value)='string' AND length(typed)<=(field#>>'{fieldType,maximumLength}')::int
        WHEN 'booleanFieldType' THEN jsonb_typeof(item.value)='boolean'
        WHEN 'integerFieldType' THEN jsonb_typeof(item.value)='string' AND typed ~ '^(0|-?[1-9][0-9]{0,17})$'
        WHEN 'dateFieldType' THEN jsonb_typeof(item.value)='string' AND typed ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND pg_input_is_valid(typed,'date')
        WHEN 'enumFieldType' THEN jsonb_typeof(item.value)='string' AND EXISTS (SELECT FROM jsonb_array_elements(field#>'{fieldType,options}') v WHERE v->>'optionId'=typed)
        ELSE false END) IS NOT TRUE THEN RAISE EXCEPTION 'template.invalidDefault'; END IF;
      IF (col ? 'audienceValues' AND NOT ((col->'audienceValues') ? typed)) OR NOT platform.document_granted(company::text,replace(item.key,':field.',':permission.template_disclose_'),item.key)
        THEN RAISE EXCEPTION 'template.audienceDenied'; END IF;
      IF member ? 'source' THEN
        IF NOT EXISTS(SELECT FROM jsonb_array_elements(source_query->'selections') s WHERE s#>>'{field,targetId}'=item.key)
          THEN RAISE EXCEPTION 'template.sourceUnavailable'; END IF;
        SELECT c->>'physicalName' INTO STRICT actual FROM jsonb_array_elements(line_spec->'columns') c WHERE c->>'canonicalFieldId'=item.key;
        EXECUTE format('SELECT %I::text FROM north_star_module.%I WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3',
          actual,line_spec->>'physicalTableName') INTO STRICT actual USING t,e,(member#>>'{source,rowId}')::uuid;
        IF actual IS DISTINCT FROM typed THEN RAISE EXCEPTION 'template.sourceChanged'; END IF; END IF; END LOOP; END LOOP; END $$;

CREATE FUNCTION platform.review_record_template(company uuid,released uuid,expected_fence bigint,form text,
  template uuid, predecessor integer, proposed jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  b jsonb; lib uuid; review platform.record_template_reviews; latest integer; BEGIN
  b:=north_star_internal.template_access(company,released,expected_fence,form,'publish',true);
  INSERT INTO platform.record_template_libraries(tenant_id,environment_id,company_id) VALUES(t,e,company) ON CONFLICT DO NOTHING;
  SELECT library_id INTO STRICT lib FROM platform.record_template_libraries WHERE (tenant_id,environment_id,company_id)=(t,e,company);
  IF template IS NULL THEN template:=gen_random_uuid(); latest:=0;
  ELSE
    SELECT x.latest INTO latest FROM platform.record_templates x
      WHERE (tenant_id,environment_id,library_id,template_id,form_id)=(t,e,lib,template,form) AND NOT retired; END IF;
  IF latest IS NULL OR latest IS DISTINCT FROM predecessor THEN RAISE EXCEPTION 'template.predecessorChanged'; END IF;
  PERFORM north_star_internal.template_content(company,released,b,proposed);
  INSERT INTO platform.record_template_reviews(tenant_id,environment_id,library_id,principal_id,release_id,fence,form_id,
      binding_revision,template_id,predecessor,content,digest)
    VALUES(t,e,lib,north_star_internal.address_principal(),released,expected_fence,form,(b->>'revisionId')::uuid,template,
      predecessor,proposed,encode(sha256(convert_to(proposed::text,'UTF8')),'hex')) RETURNING * INTO review;
  RETURN jsonb_build_object('reviewId',review.review_id,'digest',review.digest,'templateId',template,'content',proposed); END $$;

CREATE FUNCTION platform.publish_record_template(review_key uuid,reviewed_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  r platform.record_template_reviews; company uuid; b jsonb; revision uuid; BEGIN
  SELECT * INTO r FROM platform.record_template_reviews WHERE (tenant_id,environment_id,review_id,principal_id)=
    (t,e,review_key,north_star_internal.address_principal());
  IF NOT FOUND OR r.digest IS DISTINCT FROM reviewed_digest THEN RAISE EXCEPTION 'template.unavailable'; END IF;
  SELECT company_id INTO STRICT company FROM platform.record_template_libraries WHERE (tenant_id,environment_id,library_id)=(t,e,r.library_id);
  b:=north_star_internal.template_access(company,r.release_id,r.fence,r.form_id,'publish',true);
  IF b->>'revisionId' IS DISTINCT FROM r.binding_revision::text THEN RAISE EXCEPTION 'template.bindingChanged'; END IF;
  PERFORM north_star_internal.template_content(company,r.release_id,b,r.content);
  IF r.predecessor=0 THEN
    INSERT INTO platform.record_templates VALUES(t,e,r.library_id,r.template_id,r.form_id,0,false) ON CONFLICT DO NOTHING; END IF;
  UPDATE platform.record_templates SET latest=latest+1
    WHERE (tenant_id,environment_id,library_id,template_id,form_id,latest)=(t,e,r.library_id,r.template_id,r.form_id,r.predecessor) AND NOT retired;
  IF NOT FOUND THEN RAISE EXCEPTION 'template.predecessorChanged'; END IF;
  -- A retired key cannot return, and a key cannot change its meaning across member kinds.
  IF EXISTS (SELECT FROM jsonb_array_elements(r.content->'members') next
      JOIN platform.record_template_revisions v ON (v.tenant_id,v.environment_id,v.template_id)=(t,e,r.template_id)
      JOIN platform.record_template_reviews old USING(tenant_id,environment_id,review_id)
      CROSS JOIN LATERAL jsonb_array_elements(old.content->'members') prev
      WHERE next->>'key'=prev->>'key' AND (next->>'kind'<>prev->>'kind' OR NOT EXISTS(
        SELECT FROM platform.record_template_revisions last JOIN platform.record_template_reviews terms USING(tenant_id,environment_id,review_id)
        CROSS JOIN LATERAL jsonb_array_elements(terms.content->'members') m WHERE (last.tenant_id,last.environment_id,last.template_id,last.number)=(t,e,r.template_id,r.predecessor)
        AND m->>'key'=next->>'key'))) THEN RAISE EXCEPTION 'template.memberKeyReused'; END IF;
  INSERT INTO platform.record_template_revisions(tenant_id,environment_id,template_id,number,review_id)
    VALUES(t,e,r.template_id,r.predecessor+1,r.review_id) RETURNING revision_id INTO revision;
  INSERT INTO platform.record_template_audit(tenant_id,environment_id,library_id,principal_id,release_id,fence,action,details)
    VALUES(t,e,r.library_id,r.principal_id,r.release_id,r.fence,'publish',jsonb_build_object('revisionId',revision,'digest',r.digest));
  RETURN jsonb_build_object('revisionId',revision,'templateId',r.template_id,'number',r.predecessor+1); END $$;

-- Writers lock the linked context record; reads pass lock_row false and take no row lock.
CREATE FUNCTION north_star_internal.template_context(company uuid,released uuid,selector jsonb,ctx text,lock_row boolean DEFAULT true)
RETURNS text LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  app jsonb; storage jsonb; owner uuid; BEGIN
  app:=platform.document_app(t,e,released);
  CASE selector->>'kind'
  WHEN 'wholeType' THEN IF ctx IS DISTINCT FROM 'wholeType' THEN RAISE EXCEPTION 'template.invalidContext'; END IF;
  WHEN 'choice' THEN
    IF NOT EXISTS(SELECT FROM jsonb_array_elements(app->'fields') f CROSS JOIN LATERAL jsonb_array_elements(f#>'{fieldType,options}') o
      WHERE f->>'fieldId'=selector->>'fieldId' AND o->>'optionId'=ctx) THEN RAISE EXCEPTION 'template.invalidContext'; END IF;
  WHEN 'link' THEN
    storage:=platform.document_storage(t,e);
    owner:=north_star_internal.booking_endpoint(t,e,storage,selector->>'entityId',ctx::uuid,lock_row);
    IF owner IS DISTINCT FROM company THEN RAISE EXCEPTION 'template.invalidContext'; END IF;
    PERFORM north_star_internal.communication_check_read(company,owner,app,north_star_internal.communication_exact_query(app,selector->>'entityId',selector->>'getQueryId'));
    ctx:=(ctx::uuid)::text;
  ELSE RAISE EXCEPTION 'template.invalidContext'; END CASE;
  RETURN ctx; END $$;
REVOKE ALL ON FUNCTION north_star_internal.template_context(uuid,uuid,jsonb,text,boolean) FROM PUBLIC;

-- A stored application's linked context needs only today's read authority, no lock and no liveness.
-- A record stored without a context (a binding that is not required) needs none.
CREATE FUNCTION north_star_internal.template_context_read(company uuid,app jsonb,selector jsonb,ctx text) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF ctx IS NOT NULL AND selector->>'kind'='link' THEN
    PERFORM north_star_internal.communication_check_read(company,company,app,north_star_internal.communication_exact_query(app,selector->>'entityId',selector->>'getQueryId')); END IF; END $$;
REVOKE ALL ON FUNCTION north_star_internal.template_context_read(uuid,jsonb,jsonb,text) FROM PUBLIC;

CREATE FUNCTION platform.record_template_assignment_version(company uuid,released uuid,expected_fence bigint,form text,ctx text)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id(); b jsonb; current_version integer; BEGIN
  b:=north_star_internal.template_access(company,released,expected_fence,form,'assign',false);
  ctx:=north_star_internal.template_context(company,released,b#>'{body,context}',ctx,false);
  SELECT coalesce(max(a.version),0) INTO current_version FROM platform.record_template_assignments a JOIN platform.record_template_libraries l
    USING(tenant_id,environment_id,library_id) WHERE (a.tenant_id,a.environment_id,l.company_id,a.form_id,a.context_key)=(t,e,company,form,ctx);
  RETURN current_version; END $$;
REVOKE ALL ON FUNCTION platform.record_template_assignment_version(uuid,uuid,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.record_template_assignment_version(uuid,uuid,bigint,text,text) TO north_star_runtime;

CREATE FUNCTION platform.assign_record_template(company uuid,released uuid,expected_fence bigint,form text,
  ctx text, expected_version integer,revision uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  b jsonb; lib uuid; version_now integer; BEGIN
  b:=north_star_internal.template_access(company,released,expected_fence,form,'assign',true);
  SELECT l.library_id INTO lib FROM platform.record_template_revisions v JOIN platform.record_templates x USING(tenant_id,environment_id,template_id)
    JOIN platform.record_template_libraries l USING(tenant_id,environment_id,library_id) JOIN platform.record_template_reviews r ON (r.tenant_id,r.environment_id,r.review_id)=(v.tenant_id,v.environment_id,v.review_id)
    WHERE (v.tenant_id,v.environment_id,v.revision_id,l.company_id,x.form_id,r.binding_revision)=(t,e,revision,company,form,(b->>'revisionId')::uuid) AND NOT x.retired;
  IF lib IS NULL THEN RAISE EXCEPTION 'template.revisionUnavailable'; END IF;
  ctx:=north_star_internal.template_context(company,released,b#>'{body,context}',ctx);
  SELECT coalesce(max(version),0) INTO version_now FROM platform.record_template_assignments
    WHERE (tenant_id,environment_id,library_id,form_id,context_key)=(t,e,lib,form,ctx);
  IF version_now IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'template.assignmentChanged'; END IF;
  INSERT INTO platform.record_template_assignments VALUES(t,e,lib,form,ctx,version_now+1,revision);
  INSERT INTO platform.record_template_audit(tenant_id,environment_id,library_id,principal_id,release_id,fence,action,details)
    VALUES(t,e,lib,north_star_internal.address_principal(),released,expected_fence,'assign',
      jsonb_build_object('revisionId',revision,'context',ctx,'version',version_now+1));
  RETURN version_now+1; END $$;

CREATE FUNCTION platform.retire_record_template(released uuid,expected_fence bigint,template uuid,expected_latest integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  lib platform.record_template_libraries; form text; BEGIN
  SELECT * INTO lib FROM platform.record_template_libraries l WHERE (l.tenant_id,l.environment_id)=(t,e)
    AND EXISTS(SELECT FROM platform.record_templates x WHERE (x.tenant_id,x.environment_id,x.library_id,x.template_id)=(t,e,l.library_id,template));
  SELECT form_id INTO form FROM platform.record_templates WHERE (tenant_id,environment_id,template_id)=(t,e,template);
  PERFORM north_star_internal.template_access(lib.company_id,released,expected_fence,form,'publish',true);
  UPDATE platform.record_templates SET retired=true WHERE (tenant_id,environment_id,template_id,latest)=(t,e,template,expected_latest) AND NOT retired;
  IF NOT FOUND THEN RAISE EXCEPTION 'template.predecessorChanged'; END IF;
  INSERT INTO platform.record_template_audit(tenant_id,environment_id,library_id,principal_id,release_id,fence,action,details)
    VALUES(t,e,lib.library_id,north_star_internal.address_principal(),released,expected_fence,'retire',jsonb_build_object('templateId',template,'number',expected_latest)); END $$;

CREATE FUNCTION platform.record_template_history(company uuid,released uuid,expected_fence bigint,form text,revision uuid DEFAULT NULL)
RETURNS SETOF jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id(); b jsonb; app jsonb; BEGIN
  b:=north_star_internal.template_access(company,released,expected_fence,form,'read',false);
  app:=platform.document_app(t,e,released);
  PERFORM north_star_internal.communication_check_read(company,company,app,
    north_star_internal.communication_exact_query(app,b#>>'{body,lineEntityId}'));
  RETURN QUERY SELECT jsonb_build_object('templateId',x.template_id,'number',v.number,'revisionId',v.revision_id,'retired',x.retired,
    'digest',r.digest,'content',jsonb_set(r.content,'{members}',(SELECT jsonb_agg(m-'source' ORDER BY ord)
       FROM jsonb_array_elements(r.content->'members') WITH ORDINALITY AS a(m,ord))))
    FROM platform.record_template_libraries l JOIN platform.record_templates x USING(tenant_id,environment_id,library_id)
    JOIN platform.record_template_revisions v USING(tenant_id,environment_id,template_id)
    JOIN platform.record_template_reviews r ON (r.tenant_id,r.environment_id,r.review_id)=(v.tenant_id,v.environment_id,v.review_id)
    WHERE (l.tenant_id,l.environment_id,l.company_id,x.form_id)=(t,e,company,form) AND (revision IS NULL OR v.revision_id=revision)
      AND NOT EXISTS (SELECT FROM jsonb_array_elements(r.content->'members') m CROSS JOIN LATERAL jsonb_each(m->'cells') cell
        WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(b#>'{body,columns}') col
          WHERE col->>'fieldId'=cell.key AND col->'copyEligible'='true'
          AND (NOT col ? 'audienceValues' OR (col->'audienceValues') ? (cell.value#>>'{}'))))
    ORDER BY x.template_id,v.number DESC; END $$;

CREATE FUNCTION platform.record_template_author(company uuid,released uuid,expected_fence bigint,form text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DECLARE b jsonb; BEGIN
  b:=north_star_internal.template_access(company,released,expected_fence,form,'publish',false);
  IF b->>'status' IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'template.bindingUnavailable'; END IF; END $$;
REVOKE ALL ON FUNCTION platform.record_template_author(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.record_template_author(uuid,uuid,bigint,text) TO north_star_runtime;
REVOKE ALL ON FUNCTION north_star_internal.template_access(uuid,uuid,bigint,text,text,boolean),
  north_star_internal.template_content(uuid,uuid,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.review_record_template(uuid,uuid,bigint,text,uuid,integer,jsonb),
  platform.publish_record_template(uuid,text),platform.assign_record_template(uuid,uuid,bigint,text,text,integer,uuid),
  platform.retire_record_template(uuid,bigint,uuid,integer),platform.record_template_history(uuid,uuid,bigint,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.review_record_template(uuid,uuid,bigint,text,uuid,integer,jsonb),
  platform.publish_record_template(uuid,text),platform.assign_record_template(uuid,uuid,bigint,text,text,integer,uuid),
  platform.retire_record_template(uuid,bigint,uuid,integer),platform.record_template_history(uuid,uuid,bigint,text,uuid) TO north_star_runtime;

-- A reviewed create is bound to its exact request and actor. Applying it
-- pins the member-to-row identities alongside the normal operation receipt.
CREATE TABLE platform.record_template_creations (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, principal_id uuid NOT NULL,
  company_id uuid NOT NULL, operation_id text NOT NULL, request_key uuid NOT NULL,
  parent_id uuid NOT NULL, form_id text NOT NULL, release_id uuid NOT NULL, fence bigint NOT NULL,
  input_digest text NOT NULL, selection jsonb NOT NULL, probe boolean NOT NULL DEFAULT false,
  applied boolean NOT NULL DEFAULT false, member_rows jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(tenant_id,environment_id,principal_id,company_id,operation_id,request_key),
  FOREIGN KEY(tenant_id,environment_id,release_id) REFERENCES platform.tenant_releases(tenant_id,environment_id,release_id)
);
CREATE UNIQUE INDEX record_template_applied_parent ON platform.record_template_creations
  (tenant_id,environment_id,company_id,parent_id,form_id) WHERE applied;
ALTER TABLE platform.record_template_creations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.record_template_creations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform.record_template_creations FROM PUBLIC,north_star_runtime;

CREATE FUNCTION north_star_internal.template_worker(company uuid, released uuid, binding jsonb, content jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  app jsonb:=platform.document_app(t,e,released); body jsonb:=binding->'body'; entity text; op jsonb; field text; BEGIN
  IF NOT north_star_internal.address_member(company) OR NOT platform.document_granted(company::text,
     replace(body->>'formId',':surface.',':permission.template_apply_'),body->>'formId')
    OR NOT platform.document_granted(company::text,replace(body->>'formId',':surface.',':permission.template_read_'),body->>'formId')
    THEN RAISE EXCEPTION 'template.applyDenied'; END IF;
  FOREACH entity IN ARRAY ARRAY[body->>'entityId',body->>'lineEntityId'] LOOP
    SELECT o INTO STRICT op FROM jsonb_array_elements(app->'operations') o WHERE o->>'lifecycle'='active'
      AND o->>'tier'='o0' AND o#>>'{effect,kind}'='createRecordEffect' AND o#>>'{effect,entity,targetId}'=entity;
    IF NOT EXISTS(SELECT FROM jsonb_array_elements(app->'permissions') p WHERE p->>'permissionId'=op#>>'{permission,targetId}'
      AND p->>'lifecycle'='active' AND platform.document_granted(company::text,p->>'permissionId',p#>>'{resource,targetId}'))
      THEN RAISE EXCEPTION 'template.createDenied'; END IF;
    PERFORM north_star_internal.communication_check_read(company,company,app,north_star_internal.communication_exact_query(app,entity)); END LOOP;
  FOR field IN SELECT DISTINCT jsonb_object_keys(m->'cells') FROM jsonb_array_elements(content->'members') m LOOP
    IF NOT platform.document_granted(company::text,replace(field,':field.',':permission.template_seed_'),field)
      THEN RAISE EXCEPTION 'template.seedDenied'; END IF; END LOOP; END $$;

CREATE FUNCTION north_star_internal.template_selection(company uuid,released uuid,expected_fence bigint,form text,header jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  b jsonb; selector jsonb; ctx text; assignment record; selected jsonb; BEGIN
  b:=north_star_internal.template_access(company,released,expected_fence,form,'apply',true);
  selector:=b#>'{body,context}';
  ctx:=CASE selector->>'kind' WHEN 'wholeType' THEN 'wholeType' WHEN 'choice' THEN header->'values'->>(selector->>'fieldId')
                              WHEN 'link' THEN header->'relations'->>(selector->>'relationId') END;
  IF ctx IS NOT NULL THEN
    ctx:=north_star_internal.template_context(company,released,selector,ctx);
    SELECT a.version, a.revision_id,x.template_id,x.retired,r.binding_revision,r.digest,r.content INTO assignment
      FROM platform.record_template_assignments a JOIN platform.record_template_libraries l USING(tenant_id,environment_id,library_id)
      JOIN platform.record_template_revisions v USING(tenant_id,environment_id,revision_id)
      JOIN platform.record_templates x ON (x.tenant_id,x.environment_id,x.template_id,x.library_id,x.form_id)=(v.tenant_id,v.environment_id,v.template_id,l.library_id,form)
      JOIN platform.record_template_reviews r ON (r.tenant_id,r.environment_id,r.review_id)=(v.tenant_id,v.environment_id,v.review_id)
      WHERE (a.tenant_id,a.environment_id,l.company_id,a.form_id,a.context_key)=(t,e,company,form,ctx)
      ORDER BY a.version DESC LIMIT 1;
    IF FOUND THEN
      IF assignment.retired OR assignment.binding_revision IS DISTINCT FROM (b->>'revisionId')::uuid THEN RAISE EXCEPTION 'template.revisionUnavailable'; END IF;
      SELECT to_jsonb(assignment)-'retired'-'binding_revision'-'content' || jsonb_build_object('content',
        jsonb_set(assignment.content,'{members}',(SELECT jsonb_agg(m-'source' ORDER BY ord)
        FROM jsonb_array_elements(assignment.content->'members') WITH ORDINALITY a(m,ord)))) INTO selected; END IF; END IF;
  IF selected IS NULL AND b#>'{body,required}'='true' THEN RAISE EXCEPTION 'template.assignmentRequired'; END IF;
  PERFORM north_star_internal.template_worker(company,released,b,selected->'content');
  RETURN jsonb_build_object('binding',b,'context',ctx,'assignment',selected); END $$;

CREATE FUNCTION platform.review_record_template_create(released uuid,expected_fence bigint,form text,request_key uuid,header jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  company uuid:=(header->>'legalEntityId')::uuid; selected jsonb; digest text:=encode(sha256(convert_to(header::text,'UTF8')),'hex');
  actor uuid:=north_star_internal.address_principal(); prior platform.record_template_creations; BEGIN
  selected:=north_star_internal.template_selection(company,released,expected_fence,form,header);
  INSERT INTO platform.record_template_creations(tenant_id,environment_id,principal_id,company_id,operation_id,request_key,parent_id,form_id,release_id,fence,input_digest,selection)
    VALUES(t,e,actor,company,selected#>>'{binding,body,createOperationId}',request_key,(header->>'recordId')::uuid,form,released,expected_fence,digest,selected) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT prior FROM platform.record_template_creations c WHERE
    (c.tenant_id,c.environment_id,c.principal_id,c.company_id,c.operation_id,c.request_key)=(t,e,actor,company,selected#>>'{binding,body,createOperationId}',review_record_template_create.request_key);
  IF (prior.input_digest,prior.selection,prior.release_id,prior.fence) IS DISTINCT FROM (digest,selected,released,expected_fence) OR prior.probe OR prior.applied
    THEN RAISE EXCEPTION 'template.freshPreviewRequired'; END IF;
  RETURN selected; END $$;

-- Only the independent verification connection can arrange a candidate sample.
-- Its review is usable by precisely that actor, request, candidate and company.
CREATE FUNCTION platform.review_record_template_probe(released uuid,expected_fence bigint,form text,request_key uuid,header jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  b jsonb; company uuid:=(header->>'legalEntityId')::uuid; selected jsonb; BEGIN
  SELECT s->'recordTemplateBinding' INTO STRICT b FROM jsonb_array_elements(platform.document_app(t,e,released)->'surfaces') s
    WHERE s->>'surfaceId'=form AND s#>>'{recordTemplateBinding,status}'='active';
  selected:=jsonb_build_object('binding',b,'context','verification','assignment',jsonb_build_object('revision_id',gen_random_uuid(),
    'content',jsonb_build_object('version',1,'label','Verification section','columns','[]'::jsonb,
    'members',jsonb_build_array(jsonb_build_object('kind','section','key','verification','caption','Verification section','cells','{}'::jsonb)))));
  INSERT INTO platform.record_template_creations(tenant_id,environment_id,principal_id,company_id,operation_id,request_key,parent_id,form_id,release_id,fence,input_digest,selection,probe)
    VALUES(t,e,north_star_internal.address_principal(),company,b#>>'{body,createOperationId}',request_key,(header->>'recordId')::uuid,
           form,released,expected_fence,encode(sha256(convert_to(header::text,'UTF8')),'hex'),selected,true) ON CONFLICT DO NOTHING; END $$;

CREATE FUNCTION platform.open_record_template_create(released uuid,expected_fence bigint,op text,request_key uuid,header jsonb,verification boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id(); r platform.record_template_creations;
  company uuid:=(header->>'legalEntityId')::uuid; selected jsonb; BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'template.requiresReadCommitted'; END IF;
  SELECT * INTO r FROM platform.record_template_creations c WHERE
    (c.tenant_id,c.environment_id,c.principal_id,c.company_id,c.operation_id,c.request_key)=(t,e,north_star_internal.address_principal(),company,op,open_record_template_create.request_key) FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.input_digest<>encode(sha256(convert_to(header::text,'UTF8')),'hex') OR r.probe<>verification THEN RAISE EXCEPTION 'template.requestChanged'; END IF;
  IF NOT r.probe THEN
    PERFORM FROM platform.active_release_pointers p WHERE (p.tenant_id,p.environment_id,p.release_id,p.fence)=(t,e,released,expected_fence) FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'template.staleRelease'; END IF;
    PERFORM platform.lock_current_policy_epoch(t,e);
    IF r.applied THEN
      PERFORM north_star_internal.template_worker(company,released,r.selection->'binding',r.selection#>'{assignment,content}');
      PERFORM north_star_internal.template_context_read(company,platform.document_app(t,e,released),r.selection#>'{binding,body,context}',r.selection->>'context');
    ELSE
      selected:=north_star_internal.template_selection(company,released,expected_fence,r.form_id,header);
      IF selected IS DISTINCT FROM r.selection THEN RAISE EXCEPTION 'template.freshPreviewRequired'; END IF; END IF; END IF;
  IF NOT r.applied AND (r.release_id,r.fence) IS DISTINCT FROM (released,expected_fence) THEN RAISE EXCEPTION 'template.freshPreviewRequired'; END IF;
  RETURN r.selection || jsonb_build_object('applied',r.applied,'memberRows',r.member_rows); END $$;

REVOKE ALL ON FUNCTION north_star_internal.template_worker(uuid,uuid,jsonb,jsonb),north_star_internal.template_selection(uuid,uuid,bigint,text,jsonb),
  platform.review_record_template_probe(uuid,bigint,text,uuid,jsonb),platform.review_record_template_create(uuid,bigint,text,uuid,jsonb),
  platform.open_record_template_create(uuid,bigint,text,uuid,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.review_record_template_probe(uuid,bigint,text,uuid,jsonb) TO north_star_workflow_verifier;
GRANT EXECUTE ON FUNCTION platform.review_record_template_create(uuid,bigint,text,uuid,jsonb),platform.open_record_template_create(uuid,bigint,text,uuid,jsonb,boolean) TO north_star_runtime;

CREATE FUNCTION platform.finish_record_template_create(released uuid,expected_fence bigint,op text,request_key uuid,header jsonb,verification boolean,owned_rows jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  company uuid:=(header->>'legalEntityId')::uuid; parent uuid:=(header->>'recordId')::uuid;
  selection jsonb; storage jsonb; entity jsonb; line jsonb; edge jsonb; member jsonb; seen boolean; total integer:=0; BEGIN
  selection:=platform.open_record_template_create(released,expected_fence,op,request_key,header,verification);
  IF selection IS NULL OR selection->'applied'='true' THEN RAISE EXCEPTION 'template.invalidApplication'; END IF;
  SELECT convert_from(blob.canonical_bytes,'UTF8')::jsonb INTO STRICT storage FROM platform.tenant_release_projection_links p
    JOIN platform.tenant_release_chunk_links c USING(tenant_id,environment_id,release_id,projection_instance_id)
    JOIN platform.release_artifact_blobs blob ON (blob.content_hash,blob.artifact_kind)=(c.chunk_hash,'projectionChunk')
    WHERE (p.tenant_id,p.environment_id,p.release_id,p.projection_family_id)=(t,e,released,'northstar.compiler:projection-family.storage-target');
  SELECT v INTO STRICT entity FROM jsonb_array_elements(storage->'entities') v WHERE v->>'entityId'=selection#>>'{binding,body,entityId}';
  SELECT v INTO STRICT line FROM jsonb_array_elements(storage->'entities') v WHERE v->>'entityId'=selection#>>'{binding,body,lineEntityId}';
  SELECT v INTO STRICT edge FROM jsonb_array_elements(storage->'relations') v WHERE v->>'relationId'=selection#>>'{binding,body,parentRelationId}';
  EXECUTE format('SELECT true FROM north_star_module.%I WHERE (tenant_id,environment_id,record_id,%I) = ($1,$2,$3,$4) AND xmin=pg_current_xact_id()::xid',
    entity->>'physicalTableName',entity#>>'{legalEntity,column}') INTO seen USING t,e,parent,company;
  IF seen IS NOT TRUE THEN RAISE EXCEPTION 'template.parentNotCreated'; END IF;
  FOR member IN SELECT m FROM jsonb_array_elements(selection#>'{assignment,content,members}') m WHERE m->>'kind'<>'section' LOOP
    total:=total+1;
    EXECUTE format('SELECT true FROM north_star_module.%I WHERE (tenant_id,environment_id,record_id,%I,%I)=($1,$2,$3,$4,$5) AND xmin=pg_current_xact_id()::xid',
      line->>'physicalTableName',line#>>'{legalEntity,column}',edge#>>'{relationColumn,physicalName}')
      INTO seen USING t,e,(owned_rows->>(member->>'key'))::uuid,company,parent;
    IF seen IS NOT TRUE THEN RAISE EXCEPTION 'template.seedNotCreated'; END IF; END LOOP;
  IF (SELECT count(DISTINCT value) FROM jsonb_each_text(owned_rows))<>total OR
     (SELECT count(*) FROM jsonb_object_keys(owned_rows))<>total THEN RAISE EXCEPTION 'template.invalidMemberRows'; END IF;
  UPDATE platform.record_template_creations c SET applied=true,member_rows=owned_rows WHERE
    (c.tenant_id,c.environment_id,c.principal_id,c.company_id,c.operation_id,c.request_key)=(t,e,north_star_internal.address_principal(),company,op,finish_record_template_create.request_key); END $$;
REVOKE ALL ON FUNCTION platform.finish_record_template_create(uuid,bigint,text,uuid,jsonb,boolean,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.finish_record_template_create(uuid,bigint,text,uuid,jsonb,boolean,jsonb) TO north_star_runtime;

CREATE FUNCTION platform.record_template_application(company uuid,released uuid,expected_fence bigint,form text,parent uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid:=north_star_internal.trusted_tenant_id(); e uuid:=north_star_internal.trusted_environment_id();
  r platform.record_template_creations; app jsonb:=platform.document_app(t,e,released); BEGIN
  PERFORM FROM platform.active_release_pointers WHERE (tenant_id,environment_id,release_id,fence)=(t,e,released,expected_fence);
  IF NOT FOUND THEN RAISE EXCEPTION 'template.staleRelease'; END IF;
  IF NOT north_star_internal.address_member(company) OR NOT platform.document_granted(company::text,replace(form,':surface.',':permission.template_read_'),form)
    THEN RAISE EXCEPTION 'template.unavailable'; END IF;
  SELECT * INTO r FROM platform.record_template_creations c WHERE (c.tenant_id,c.environment_id,c.company_id,c.form_id,c.parent_id)=(t,e,company,form,parent)
    AND c.applied AND NOT c.probe;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM north_star_internal.communication_check_read(company,company,app,north_star_internal.communication_exact_query(app,r.selection#>>'{binding,body,entityId}'));
  PERFORM north_star_internal.communication_check_read(company,company,app,north_star_internal.communication_exact_query(app,r.selection#>>'{binding,body,lineEntityId}'));
  PERFORM north_star_internal.template_context_read(company,app,r.selection#>'{binding,body,context}',r.selection->>'context');
  RETURN r.selection || jsonb_build_object('memberRows',r.member_rows); END $$;
REVOKE ALL ON FUNCTION platform.record_template_application(uuid,uuid,bigint,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.record_template_application(uuid,uuid,bigint,text,uuid) TO north_star_runtime;
