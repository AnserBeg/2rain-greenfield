-- Only the scanner login can attest to a staged digest. The serving login
-- reaches attachment data through the scoped entry points below.
CREATE ROLE north_star_document_scanner LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS
  NOCREATEROLE NOCREATEDB NOREPLICATION;
GRANT USAGE ON SCHEMA platform TO north_star_document_scanner;
REVOKE ALL ON platform.document_versions, platform.document_blobs,
  platform.document_attachment_audit, platform.document_upload_staging FROM north_star_runtime;
REVOKE EXECUTE ON FUNCTION platform.retire_document_upload_staging(uuid) FROM north_star_runtime;

ALTER TABLE platform.document_upload_staging
  ADD COLUMN scan_clean boolean,
  ADD COLUMN scan_digest text,
  ADD COLUMN scan_policy text,
  ADD CONSTRAINT document_verdict_binding CHECK (
    (scan_clean IS NULL AND scan_digest IS NULL AND scan_policy IS NULL) OR
    (scan_clean IS NOT NULL AND scan_digest IS NOT NULL AND scan_digest = digest
      AND scan_policy IS NOT NULL AND scan_policy <> '')
  );

CREATE FUNCTION platform.reject_document_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  RAISE EXCEPTION 'Published attachment evidence is immutable' USING ERRCODE = '55000'; END $$;
CREATE TRIGGER document_versions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON platform.document_versions FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_document_mutation();
CREATE TRIGGER document_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON platform.document_attachment_audit FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_document_mutation();

CREATE FUNCTION platform.document_identity(OUT tenant_id uuid, OUT environment_id uuid, OUT principal_id uuid)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT nullif(current_setting('north_star.tenant_id', true), '')::uuid,
         nullif(current_setting('north_star.environment_id', true), '')::uuid,
         nullif(current_setting('north_star.principal_id', true), '')::uuid
$$;

CREATE FUNCTION platform.document_granted(scope text, permission text, resource text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT FROM platform.document_identity() i
    JOIN platform.current_policy_memberships m USING (tenant_id, environment_id, principal_id)
    JOIN platform.current_policy_roles r USING (tenant_id, environment_id, role_id)
    JOIN platform.current_policy_permission_grants g USING (tenant_id, environment_id, role_id)
    WHERE m.revoked_at IS NULL AND r.revoked_at IS NULL AND g.revoked_at IS NULL
      AND (m.legal_entity_id IS NULL OR m.legal_entity_id::text = scope)
      AND g.permission_id = permission AND g.resource_id = resource
  )
$$;

-- Resolve the governing get and live field declarations from the active release.
-- An empty field array admits uncategorized files; NULL means the target is denied.
CREATE FUNCTION platform.document_fields(scope text, entity text, action text, active_release uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH definition AS MATERIALIZED (
    SELECT convert_from(revision.desired_state, 'UTF8')::jsonb AS app
    FROM platform.document_identity() i
    JOIN platform.active_release_pointers ptr USING (tenant_id, environment_id)
    JOIN platform.tenant_releases r USING (tenant_id, environment_id, release_id)
    JOIN platform.app_package_revisions revision ON revision.tenant_id = r.tenant_id
      AND revision.revision_id = r.app_package_revision_id
    WHERE active_release IS NULL OR ptr.release_id = active_release
  )
  SELECT coalesce((SELECT jsonb_agg(f) FROM jsonb_array_elements(app->'documentFields') f
                   WHERE f->>'entityId' = entity), '[]'::jsonb)
  FROM definition CROSS JOIN LATERAL (
    SELECT q FROM jsonb_array_elements(app->'queries') q
    WHERE q #>> '{sourceEntity,targetId}' = entity AND q->>'queryType' = 'get'
      AND q->>'tier' = 'q0' AND q->>'lifecycle' = 'active' AND q->>'readModel' IS NULL
      AND EXISTS (SELECT FROM jsonb_array_elements(app->'surfaces') s WHERE s->>'surfaceRole' = 'record'
        AND s->>'lifecycle' = 'active' AND s #>> '{dataSource,targetId}' = q->>'queryId')
    ORDER BY q->>'queryId' COLLATE "C" LIMIT 1
  ) governing
  JOIN LATERAL jsonb_array_elements(app->'permissions') perm
    ON perm->>'permissionId' = q #>> '{permission,targetId}'
  WHERE platform.document_granted(scope, perm->>'permissionId', perm #>> '{resource,targetId}')
    AND (scope = 'shared' OR platform.document_granted(scope,
      'northstar.runtime:permission.legal-entity-read-scope', 'northstar.runtime:scope.legal-entity'))
    AND platform.document_granted(scope, 'northstar.documents:permission.view', 'northstar.documents:resource.attachments')
    AND platform.document_granted(scope, 'northstar.documents:permission.' || action, 'northstar.documents:resource.attachments')
    AND (action <> 'upload' OR platform.document_granted(scope, replace(entity, ':entity.', ':permission.document_attach_'), entity))
$$;

CREATE FUNCTION platform.document_metadata(v platform.document_versions, b platform.document_blobs)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('linkId', v.link_id, 'versionId', v.version_id, 'fieldId', v.field_id,
    'categoryId', v.category_id, 'fileName', v.file_name, 'contentType', b.content_type, 'byteLength', b.byte_length)
$$;

CREATE INDEX document_versions_page ON platform.document_versions
  (tenant_id, environment_id, entity_id, record_id, owner_scope, link_id);

CREATE FUNCTION platform.list_document_versions(scope text, entity text, record_key uuid, after_link uuid, page_size integer)
RETURNS TABLE(metadata jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH allowed AS MATERIALIZED (SELECT platform.document_fields(scope, entity, 'view') AS fields)
  SELECT platform.document_metadata(v,b) FROM allowed, platform.document_identity() i
  JOIN platform.document_versions v USING (tenant_id, environment_id)
  JOIN platform.document_blobs b USING (tenant_id, environment_id, owner_scope, digest)
  WHERE fields IS NOT NULL AND (v.owner_scope,v.entity_id,v.record_id) = (scope,entity,record_key)
    AND (v.field_id IS NULL OR fields @> jsonb_build_array(jsonb_build_object('fieldId',v.field_id)))
    AND (after_link IS NULL OR v.link_id > after_link)
  ORDER BY v.link_id LIMIT greatest(1, least(page_size, 100))
$$;

CREATE FUNCTION platform.read_document_version(scope text, entity text, record_key uuid, link uuid, version uuid)
RETURNS TABLE(metadata jsonb, bytes bytea) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH allowed AS MATERIALIZED (SELECT platform.document_fields(scope, entity, 'download') AS fields)
  SELECT platform.document_metadata(v,b), b.bytes FROM allowed, platform.document_identity() i
  JOIN platform.document_versions v USING (tenant_id, environment_id)
  JOIN platform.document_blobs b USING (tenant_id, environment_id, owner_scope, digest)
  WHERE fields IS NOT NULL AND (v.owner_scope,v.entity_id,v.record_id,v.link_id,v.version_id) = (scope,entity,record_key,link,version)
    AND (v.field_id IS NULL OR fields @> jsonb_build_array(jsonb_build_object('fieldId',v.field_id)))
$$;

CREATE FUNCTION platform.stage_document_upload(scope text, entity text, record_key uuid, upload uuid, field text,
  category text, filename text, mime text, payload bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DECLARE
  i record; s platform.document_upload_staging; fields jsonb; receipt jsonb;
  hash text := encode(sha256(payload), 'hex'); BEGIN
  SELECT * INTO i FROM platform.document_identity();
  fields := platform.document_fields(scope, entity, 'upload');
  IF fields IS NULL OR (field IS NOT NULL AND NOT fields @> jsonb_build_array(jsonb_build_object('fieldId',field))) THEN
    RAISE EXCEPTION 'Unavailable file field' USING ERRCODE = 'D0404'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('documents:' || i.tenant_id || ':' || i.environment_id, 0));
  SELECT * INTO s FROM platform.document_upload_staging
    WHERE (tenant_id,environment_id,upload_id) = (i.tenant_id,i.environment_id,upload);
  IF FOUND THEN
    IF (s.principal_id,s.owner_scope,s.entity_id,s.record_id,s.field_id,s.category_id,s.file_name,s.digest,s.content_type)
       IS DISTINCT FROM (i.principal_id,scope,entity,record_key,field,category,filename,hash,mime) THEN
      RAISE EXCEPTION 'This upload ID already has different input.' USING ERRCODE = 'D0409'; END IF;
    SELECT platform.document_metadata(v,b) INTO receipt FROM platform.document_versions v
      JOIN platform.document_blobs b USING (tenant_id,environment_id,owner_scope,digest)
      WHERE (v.tenant_id,v.environment_id,v.upload_id) = (i.tenant_id,i.environment_id,upload);
    IF FOUND THEN RETURN receipt; END IF;
    IF s.scan_clean IS FALSE THEN RAISE EXCEPTION 'The file did not pass content screening.' USING ERRCODE = 'D0422'; END IF;
    IF s.retired_at IS NOT NULL OR s.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'This staged upload expired.' USING ERRCODE = 'D0409'; END IF;
    RETURN NULL; END IF;
  PERFORM platform.retire_document_upload_staging(NULL);
  IF (SELECT coalesce(sum(byte_length),0) FROM platform.document_upload_staging
      WHERE (tenant_id,environment_id) = (i.tenant_id,i.environment_id)) + octet_length(payload) > 41943040 THEN
    RAISE EXCEPTION 'The upload staging quota is full.' USING ERRCODE = 'D0413'; END IF;
  INSERT INTO platform.document_upload_staging (tenant_id,environment_id,upload_id,principal_id,owner_scope,
    entity_id,record_id,field_id,category_id,file_name,content_type,digest,bytes)
  VALUES (i.tenant_id,i.environment_id,upload,i.principal_id,scope,entity,record_key,field,category,filename,mime,hash,payload);
  RETURN NULL; END $$;

-- Lock just this stage across scanning, so concurrent retries share one decision.
CREATE FUNCTION platform.lock_document_scan(t uuid,e uuid,p uuid,upload uuid,hash text,policy text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DECLARE
  s platform.document_upload_staging; BEGIN
  SELECT * INTO STRICT s FROM platform.document_upload_staging WHERE
    (tenant_id,environment_id,principal_id,upload_id,digest) = (t,e,p,upload,hash) FOR UPDATE;
  IF s.scan_clean IS FALSE THEN RETURN false; END IF;
  IF s.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'This staged upload expired.' USING ERRCODE = 'D0409'; END IF;
  IF s.scan_policy = policy THEN RETURN s.scan_clean; END IF;
  IF s.retired_at IS NOT NULL THEN RAISE EXCEPTION 'This staged upload expired.' USING ERRCODE = 'D0409'; END IF;
  RETURN NULL; END $$;

CREATE FUNCTION platform.record_document_scan(t uuid,e uuid,p uuid,upload uuid,hash text,policy text,clean boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  UPDATE platform.document_upload_staging SET scan_clean = clean, scan_digest = hash, scan_policy = policy
    WHERE (tenant_id,environment_id,principal_id,upload_id,digest) = (t,e,p,upload,hash)
      AND clean IS NOT NULL AND scan_clean IS DISTINCT FROM false AND retired_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unavailable stage' USING ERRCODE = 'D0409'; END IF; END $$;

CREATE FUNCTION platform.publish_document_upload(upload uuid, hash text, policy text, active_release uuid,
  revision bigint, category_limit integer, retention text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DECLARE
  i record; s platform.document_upload_staging; fields jsonb; field_limit integer; receipt jsonb;
  published platform.document_versions; blob platform.document_blobs; BEGIN
  SELECT * INTO i FROM platform.document_identity();
  PERFORM pg_advisory_xact_lock(hashtextextended('documents:' || i.tenant_id || ':' || i.environment_id, 0));
  SELECT * INTO STRICT s FROM platform.document_upload_staging
    WHERE (tenant_id,environment_id,principal_id,upload_id,digest) = (i.tenant_id,i.environment_id,i.principal_id,upload,hash) FOR UPDATE;
  fields := platform.document_fields(s.owner_scope, s.entity_id, 'upload', active_release);
  IF fields IS NULL OR (s.field_id IS NOT NULL AND NOT fields @> jsonb_build_array(jsonb_build_object('fieldId',s.field_id))) THEN
    RAISE EXCEPTION 'Unavailable file field' USING ERRCODE = 'D0404'; END IF;
  SELECT platform.document_metadata(v,b) INTO receipt FROM platform.document_versions v
    JOIN platform.document_blobs b USING (tenant_id,environment_id,owner_scope,digest)
    WHERE (v.tenant_id,v.environment_id,v.upload_id) = (i.tenant_id,i.environment_id,upload);
  IF FOUND THEN RETURN receipt; END IF;
  IF s.retired_at IS NOT NULL OR s.expires_at <= clock_timestamp() OR s.scan_clean IS DISTINCT FROM true
    OR (s.scan_digest,s.scan_policy) IS DISTINCT FROM (hash,policy) THEN
    RAISE EXCEPTION 'This staged upload has no current clean verdict.' USING ERRCODE = 'D0409'; END IF;
  IF greatest(
    (SELECT coalesce(sum(b.byte_length),0) FROM platform.document_versions v
     JOIN platform.document_blobs b USING (tenant_id,environment_id,owner_scope,digest)
     WHERE (v.tenant_id,v.environment_id) = (i.tenant_id,i.environment_id)),
    (SELECT coalesce(sum(b.byte_length),0) FROM platform.document_blobs b
     WHERE (b.tenant_id,b.environment_id) = (i.tenant_id,i.environment_id))
  ) + s.byte_length > 104857600 THEN
    RAISE EXCEPTION 'The stored file quota is full.' USING ERRCODE = 'D0413'; END IF;
  IF s.field_id IS NOT NULL THEN
    SELECT (f->>'maxCount')::integer INTO STRICT field_limit FROM jsonb_array_elements(fields) f WHERE f->>'fieldId' = s.field_id;
    IF (SELECT count(*) >= field_limit OR count(*) FILTER (WHERE category_id = s.category_id) >= category_limit
        FROM platform.document_versions WHERE (tenant_id,environment_id,owner_scope,entity_id,record_id,field_id)
        = (i.tenant_id,i.environment_id,s.owner_scope,s.entity_id,s.record_id,s.field_id)) THEN
      RAISE EXCEPTION 'This file field or category is full.' USING ERRCODE = 'D0409'; END IF; END IF;
  -- Both paths write the complete admitted payload. The unique key retains one logical blob.
  INSERT INTO platform.document_blobs (tenant_id,environment_id,owner_scope,digest,content_type,bytes)
    VALUES (i.tenant_id,i.environment_id,s.owner_scope,hash,s.content_type,s.bytes)
    ON CONFLICT (tenant_id,environment_id,owner_scope,digest) DO UPDATE SET bytes = excluded.bytes
    RETURNING * INTO blob;
  INSERT INTO platform.document_versions (tenant_id,environment_id,link_id,version_id,upload_id,owner_scope,
    digest,entity_id,record_id,record_revision,field_id,category_id,retention_class,file_name,actor_id,release_id,scan_policy_version)
    VALUES (i.tenant_id,i.environment_id,gen_random_uuid(),gen_random_uuid(),upload,s.owner_scope,
      hash,s.entity_id,s.record_id,revision,s.field_id,s.category_id,retention,s.file_name,i.principal_id,active_release,s.scan_policy)
    RETURNING * INTO published;
  INSERT INTO platform.document_attachment_audit (tenant_id,environment_id,link_id,operation_id)
    VALUES (i.tenant_id,i.environment_id,published.link_id,replace(s.entity_id, ':entity.', ':operation.document_attach_'));
  PERFORM platform.retire_document_upload_staging(upload);
  RETURN platform.document_metadata(published,blob); END $$;

REVOKE ALL ON FUNCTION platform.reject_document_mutation(), platform.document_identity(),
  platform.document_granted(text,text,text), platform.document_fields(text,text,text,uuid),
  platform.document_metadata(platform.document_versions,platform.document_blobs),
  platform.list_document_versions(text,text,uuid,uuid,integer), platform.read_document_version(text,text,uuid,uuid,uuid),
  platform.stage_document_upload(text,text,uuid,uuid,text,text,text,text,bytea),
  platform.lock_document_scan(uuid,uuid,uuid,uuid,text,text), platform.record_document_scan(uuid,uuid,uuid,uuid,text,text,boolean),
  platform.publish_document_upload(uuid,text,text,uuid,bigint,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.list_document_versions(text,text,uuid,uuid,integer),
  platform.read_document_version(text,text,uuid,uuid,uuid), platform.stage_document_upload(text,text,uuid,uuid,text,text,text,text,bytea),
  platform.publish_document_upload(uuid,text,text,uuid,bigint,integer,text) TO north_star_runtime;
GRANT EXECUTE ON FUNCTION platform.lock_document_scan(uuid,uuid,uuid,uuid,text,text),
  platform.record_document_scan(uuid,uuid,uuid,uuid,text,text,boolean) TO north_star_document_scanner;
