ALTER TABLE platform.document_versions
  ADD COLUMN generated_source jsonb,
  ADD CONSTRAINT generated_document_source_shape CHECK (
    generated_source IS NULL OR (
      field_id IS NULL AND category_id IS NULL
      AND jsonb_typeof(generated_source) = 'object'
      AND generated_source ?& ARRAY['templateId', 'revisionId', 'issuedIdentity',
        'releaseRoot', 'renderer', 'brandRevision', 'recordId', 'companyBrandSource', 'queries', 'logo', 'inputDigest']
      AND jsonb_typeof(generated_source->'brandRevision') = 'string'
      AND length(generated_source->>'brandRevision') BETWEEN 1 AND 180
      AND generated_source->>'recordId' = record_id::text
      AND generated_source->>'inputDigest' ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(generated_source->'queries') = 'array'
      AND jsonb_array_length(generated_source->'queries') BETWEEN 1 AND 25
    ) IS TRUE
  );

ALTER TABLE platform.document_upload_staging ADD COLUMN generated_source jsonb;

-- Internal helpers are reachable only by the definer functions. Resolve physical
-- names from the verified release and qualify every relation.
CREATE FUNCTION platform.document_storage(t uuid, e uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT convert_from(blob.canonical_bytes, 'UTF8')::jsonb
  FROM platform.active_release_pointers p
  JOIN platform.tenant_release_projection_links projection USING (tenant_id, environment_id, release_id)
  JOIN platform.tenant_release_chunk_links chunk USING (tenant_id, environment_id, release_id, projection_instance_id)
  JOIN platform.release_artifact_blobs blob ON blob.content_hash = chunk.chunk_hash
    AND blob.artifact_kind = 'projectionChunk'
  WHERE (p.tenant_id, p.environment_id) = (t, e)
    AND projection.projection_family_id = 'northstar.compiler:projection-family.storage-target'
$$;

CREATE FUNCTION platform.document_record_revision(t uuid, e uuid, storage jsonb, entity text,
  scope text, record_key uuid, parent_relation text DEFAULT NULL, parent_key uuid DEFAULT NULL,
  lock_row boolean DEFAULT false)
RETURNS bigint LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE target jsonb; relation jsonb; revision bigint; BEGIN
  SELECT value INTO target FROM jsonb_array_elements(storage->'entities')
    WHERE value->>'entityId' = entity AND value->>'lifecycle' = 'active';
  IF target->>'storageClass' IS DISTINCT FROM 'dedicatedTable'
     OR scope IS NULL OR (target ? 'legalEntity') IS DISTINCT FROM (scope <> 'shared')
     OR (scope <> 'shared' AND NOT pg_input_is_valid(scope, 'uuid'))
  THEN RETURN NULL; END IF;
  IF parent_relation IS NOT NULL THEN
    SELECT value INTO relation FROM jsonb_array_elements(storage->'relations')
      WHERE value->>'relationId' = parent_relation AND value->>'sourceEntityId' = entity
        AND value->>'ownership' = 'parentScopedChild';
    IF relation IS NULL OR parent_key IS NULL THEN RETURN NULL; END IF; END IF;
  EXECUTE format('SELECT %I FROM north_star_module.%I
    WHERE tenant_id = $1 AND environment_id = $2 AND %I = $3 AND %I IS NULL%s%s%s',
    target #>> '{optimisticRevision,column}', target->>'physicalTableName',
    target #>> '{recordIdentity,column}', target #>> '{archive,archivedAtColumn}',
    CASE WHEN scope = 'shared' THEN '' ELSE format(' AND %I = $4::uuid', target #>> '{legalEntity,column}') END,
    CASE WHEN relation IS NULL THEN '' ELSE format(' AND %I = $5', relation #>> '{relationColumn,physicalName}') END,
    CASE WHEN lock_row THEN ' FOR SHARE' ELSE '' END)
    INTO STRICT revision USING t, e, record_key, scope, parent_key;
  RETURN revision;
EXCEPTION WHEN no_data_found OR too_many_rows OR undefined_table OR undefined_column THEN RETURN NULL; END $$;

CREATE FUNCTION platform.document_app(t uuid, e uuid, release_key uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT convert_from(revision.desired_state, 'UTF8')::jsonb
  FROM platform.tenant_releases r
  JOIN platform.app_package_revisions revision ON (revision.tenant_id,revision.revision_id) =
    (r.tenant_id,r.app_package_revision_id)
  WHERE (r.tenant_id,r.environment_id) = (t,e)
    AND r.release_id = coalesce(release_key, (
      SELECT p.release_id FROM platform.active_release_pointers p
      WHERE (p.tenant_id,p.environment_id) = (t,e)))
$$;

CREATE FUNCTION platform.document_query_boundary()
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT platform.document_granted('shared', 'northstar.runtime:permission.semantic-query-boundary',
    'northstar.runtime:gateway.semantic-query')
$$;

-- Compare the pinned source authority to the current release, then resolve
-- each referenced record under the current tenant, environment and company.
CREATE FUNCTION platform.document_source_allowed(app jsonb, issued_app jsonb, storage jsonb,
  source jsonb, scope text, entity text, record_key uuid, verify_revision boolean)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE i record; q jsonb; issued_query jsonb; field jsonb; stored bigint;
  source_row jsonb; parent text := source->>'parentRelationId';
  source_entity text := source->>'entityId'; BEGIN
  SELECT * INTO i FROM platform.document_identity();
  SELECT value INTO q FROM jsonb_array_elements(app->'queries') WHERE value->>'queryId' = source->>'queryId';
  SELECT value INTO issued_query FROM jsonb_array_elements(issued_app->'queries')
    WHERE value->>'queryId' = source->>'queryId';
  IF q IS NULL OR (q - 'selections') IS DISTINCT FROM (issued_query - 'selections')
     OR q #>> '{sourceEntity,targetId}' IS DISTINCT FROM source_entity
     OR q->>'lifecycle' IS DISTINCT FROM 'active' OR q->>'tier' IS DISTINCT FROM 'q0'
     OR q ? 'readModel'
     OR coalesce(source->>'companyId','shared') IS DISTINCT FROM scope
     OR NOT EXISTS (
       SELECT FROM jsonb_array_elements(app->'permissions') perm
       WHERE perm->>'permissionId' = q #>> '{permission,targetId}'
         AND perm->>'lifecycle' = 'active'
         AND platform.document_granted(scope, perm->>'permissionId', perm #>> '{resource,targetId}'))
     OR (scope <> 'shared' AND NOT platform.document_granted(scope,
       'northstar.runtime:permission.legal-entity-read-scope', 'northstar.runtime:scope.legal-entity'))
     OR jsonb_typeof(source->'rows') IS DISTINCT FROM 'array'
     OR jsonb_array_length(source->'rows') > 100
     OR jsonb_typeof(source->'fields') IS DISTINCT FROM 'array'
  THEN RETURN false; END IF;
  IF parent IS NULL THEN
    IF source_entity IS DISTINCT FROM entity OR q->>'queryType' IS DISTINCT FROM 'get'
       OR jsonb_array_length(source->'rows') <> 1
       OR source #>> '{rows,0,recordId}' IS DISTINCT FROM record_key::text
    THEN RETURN false; END IF;
  ELSIF q->>'queryType' IS DISTINCT FROM 'list' OR NOT EXISTS (
    SELECT FROM jsonb_array_elements(storage->'relations') rel
    WHERE rel->>'relationId' = parent AND rel->>'sourceEntityId' = source_entity
      AND rel->>'targetEntityId' = entity AND rel->>'ownership' = 'parentScopedChild')
  THEN RETURN false; END IF;
  FOR field IN SELECT * FROM jsonb_array_elements(source->'fields') LOOP
    IF NOT EXISTS (
      SELECT FROM jsonb_array_elements(app->'fields') f
      WHERE f->>'fieldId' = field->>'fieldId'
        AND f->>'lifecycle' = 'active'
        AND f #>> '{entity,targetId}' = source_entity
        AND f->>'classification' IN ('public','internal')
        AND f->>'classification' = field->>'classification'
        AND f #>> '{fieldType,kind}' = field->>'fieldKind'
        AND EXISTS (SELECT FROM jsonb_array_elements(q->'selections') selection
          WHERE selection #>> '{field,targetId}' = field->>'fieldId'))
    THEN RETURN false; END IF; END LOOP;
  FOR source_row IN SELECT * FROM jsonb_array_elements(source->'rows') ORDER BY value->>'recordId' LOOP
    stored := platform.document_record_revision(i.tenant_id, i.environment_id, storage, source_entity,
      scope, (source_row->>'recordId')::uuid, parent, record_key, verify_revision);
    IF stored IS NULL OR (verify_revision AND stored IS DISTINCT FROM (source_row->>'revision')::bigint)
    THEN RETURN false; END IF; END LOOP;
  RETURN true; END $$;

CREATE FUNCTION platform.document_generated_allowed(source jsonb, issued_release uuid, scope text,
  entity text, record_key uuid, verify_revision boolean)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE i record; app jsonb; issued_app jsonb; storage jsonb; binding jsonb; brand jsonb; template jsonb;
  block jsonb; binding_index integer := 1; required_field text; BEGIN
  IF source IS NULL THEN RETURN true; END IF;
  SELECT * INTO i FROM platform.document_identity();
  app := platform.document_app(i.tenant_id, i.environment_id);
  issued_app := platform.document_app(i.tenant_id, i.environment_id, issued_release);
  storage := platform.document_storage(i.tenant_id, i.environment_id);
  IF source->>'renderer' IS DISTINCT FROM 'pdfkit-0.17.2/quickjs/v1'
     OR source->>'brandRevision' IS DISTINCT FROM 'platform-default'
     OR source->'logo' IS DISTINCT FROM 'null'::jsonb
     OR source->>'recordId' IS DISTINCT FROM record_key::text
     OR (source->>'inputDigest' ~ '^[0-9a-f]{64}$') IS DISTINCT FROM true
     OR jsonb_typeof(source->'queries') IS DISTINCT FROM 'array'
     OR jsonb_array_length(source->'queries') NOT BETWEEN 1 AND 25
     OR NOT EXISTS (SELECT FROM platform.tenant_releases r WHERE
       (r.tenant_id,r.environment_id,r.release_id,r.content_hash) =
       (i.tenant_id,i.environment_id,issued_release,source->>'releaseRoot'))
  THEN RETURN false; END IF;
  SELECT value INTO template FROM jsonb_array_elements(issued_app->'documentTemplateRevisions')
    WHERE value->>'templateId' = source->>'templateId' AND value->>'revisionId' = source->>'revisionId'
      AND value->>'entityId' = entity;
  IF template IS NULL OR NOT EXISTS (
    SELECT FROM jsonb_array_elements(issued_app->'documentTemplatePointers') pointer
    WHERE pointer->>'templateId' = source->>'templateId'
      AND pointer->>'activeRevisionId' = source->>'revisionId')
    OR source #>> '{queries,0,queryId}' IS DISTINCT FROM template->>'headerQueryId'
    OR source #>> '{queries,0,parentRelationId}' IS NOT NULL
  THEN RETURN false; END IF;
  binding := source #> '{queries,0}';
  FOR required_field IN
    SELECT template->>'identityFieldId'
    UNION SELECT template->>'currencyFieldId'
    UNION SELECT value->>'fieldId' FROM jsonb_array_elements(template->'layout') WHERE value->>'kind' = 'field'
  LOOP
    IF required_field IS NOT NULL
       AND (binding->'fields' @> jsonb_build_array(jsonb_build_object('fieldId',required_field))) IS DISTINCT FROM true
    THEN RETURN false; END IF; END LOOP;
  FOR block IN SELECT * FROM jsonb_array_elements(template->'layout') WHERE value->>'kind' = 'table' LOOP
    binding := source->'queries'->binding_index;
    IF binding->>'queryId' IS DISTINCT FROM block->>'queryId'
       OR binding->>'parentRelationId' IS DISTINCT FROM block->>'parentRelationId'
    THEN RETURN false; END IF;
    FOR required_field IN
      SELECT block->>'currencyFieldId'
      UNION SELECT value->>'fieldId' FROM jsonb_array_elements(block->'columns')
    LOOP
      IF required_field IS NOT NULL
        AND (binding->'fields' @> jsonb_build_array(jsonb_build_object('fieldId',required_field))) IS DISTINCT FROM true
      THEN RETURN false; END IF; END LOOP;
    binding_index := binding_index + 1; END LOOP;
  IF binding_index <> jsonb_array_length(source->'queries') THEN RETURN false; END IF;
  FOR binding IN SELECT * FROM jsonb_array_elements(source->'queries') LOOP
    IF NOT platform.document_source_allowed(app, issued_app, storage, binding, scope, entity, record_key, verify_revision)
    THEN RETURN false; END IF; END LOOP;
  brand := source->'companyBrandSource';
  IF scope = 'shared' THEN RETURN brand = 'null'::jsonb; END IF;
  RETURN (brand->>'queryId' = 'northstar.app:query.legal_entity_get'
    AND brand->>'parentRelationId' IS NULL
    AND brand->'fields' @> '[{"fieldId":"northstar.app:field.legal_entity_name"}]'::jsonb
    AND platform.document_source_allowed(app, issued_app, storage, brand, 'shared',
      'northstar.app:entity.legal_entity', scope::uuid, verify_revision)) IS TRUE; END $$;

REVOKE ALL ON FUNCTION platform.document_storage(uuid,uuid),
  platform.document_record_revision(uuid,uuid,jsonb,text,text,uuid,text,uuid,boolean),
  platform.document_app(uuid,uuid,uuid), platform.document_query_boundary(),
  platform.document_source_allowed(jsonb,jsonb,jsonb,jsonb,text,text,uuid,boolean),
  platform.document_generated_allowed(jsonb,uuid,text,text,uuid,boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.document_fields(scope text, entity text, action text, active_release uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH definition AS MATERIALIZED (
    SELECT convert_from(revision.desired_state, 'UTF8')::jsonb AS app,
      (SELECT convert_from(blob.canonical_bytes, 'UTF8')::jsonb->'bindings'
       FROM platform.tenant_release_projection_links projection
       JOIN platform.tenant_release_chunk_links chunk USING (tenant_id, environment_id, release_id, projection_instance_id)
       JOIN platform.release_artifact_blobs blob ON blob.content_hash = chunk.chunk_hash
         AND blob.artifact_kind = 'projectionChunk'
       WHERE (projection.tenant_id, projection.environment_id, projection.release_id) =
         (ptr.tenant_id, ptr.environment_id, ptr.release_id)
         AND projection.projection_family_id = 'northstar.compiler:projection-family.documents') AS bindings
    FROM platform.document_identity() i
    JOIN platform.active_release_pointers ptr USING (tenant_id, environment_id)
    JOIN platform.tenant_releases r USING (tenant_id, environment_id, release_id)
    JOIN platform.app_package_revisions revision ON revision.tenant_id = r.tenant_id
      AND revision.revision_id = r.app_package_revision_id
    WHERE active_release IS NULL OR ptr.release_id = active_release
  )
  SELECT coalesce((SELECT jsonb_agg(f) FROM jsonb_array_elements(app->'documentFields') f
                   WHERE f->>'entityId' = entity), '[]'::jsonb)
  -- A compiled binding can select a Record read model. Its query governs
  -- permissions, and the stored record still supplies scope and revision.
  FROM definition LEFT JOIN LATERAL (
    SELECT b->>'queryId' AS query_id
    FROM jsonb_array_elements(bindings) b WHERE b->>'entityId' = entity
  ) binding ON true
  CROSS JOIN LATERAL (
    SELECT q FROM jsonb_array_elements(app->'queries') q
    WHERE q #>> '{sourceEntity,targetId}' = entity AND q->>'queryType' = 'get'
      AND q->>'tier' = 'q0' AND q->>'lifecycle' = 'active'
      AND CASE WHEN binding.query_id IS NULL THEN q->>'readModel' IS NULL
               ELSE q->>'queryId' = binding.query_id END
      AND EXISTS (SELECT FROM jsonb_array_elements(app->'surfaces') s WHERE s->>'surfaceRole' = 'record'
        AND s->>'lifecycle' = 'active' AND s #>> '{dataSource,targetId}' = q->>'queryId')
    ORDER BY q->>'queryId' COLLATE "C" LIMIT 1
  ) governing
  JOIN LATERAL jsonb_array_elements(app->'permissions') perm
    ON perm->>'permissionId' = q #>> '{permission,targetId}'
  WHERE platform.document_query_boundary()
    AND q #>> '{filter,kind}' = 'booleanPredicate' AND q #>> '{filter,value}' = 'true'
    AND (q ? 'legalEntityScope') = (scope <> 'shared')
    AND jsonb_array_length(coalesce(q->'parameters','[]'::jsonb)) = CASE WHEN scope = 'shared' THEN 0 ELSE 1 END
    AND perm->>'lifecycle' = 'active'
    AND platform.document_granted(scope, perm->>'permissionId', perm #>> '{resource,targetId}')
    AND (scope = 'shared' OR platform.document_granted(scope,
      'northstar.runtime:permission.legal-entity-read-scope', 'northstar.runtime:scope.legal-entity'))
    AND platform.document_granted(scope, 'northstar.documents:permission.view', 'northstar.documents:resource.attachments')
    AND platform.document_granted(scope, 'northstar.documents:permission.' || action, 'northstar.documents:resource.attachments')
    AND (action <> 'upload' OR (
      platform.document_granted('shared', 'northstar.runtime:permission.semantic-operation-boundary',
        'northstar.runtime:gateway.semantic-operation')
      AND platform.document_granted(scope, replace(entity, ':entity.', ':permission.document_attach_'), entity)))
$$;

CREATE OR REPLACE FUNCTION platform.list_document_versions(scope text, entity text, record_key uuid, after_link uuid, page_size integer)
RETURNS TABLE(metadata jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH allowed AS MATERIALIZED (
    SELECT i.*, platform.document_fields(scope, entity, 'view') AS fields
    FROM platform.document_identity() i
    WHERE platform.document_record_revision(i.tenant_id, i.environment_id,
      platform.document_storage(i.tenant_id, i.environment_id), entity, scope, record_key) IS NOT NULL
  )
  SELECT platform.document_metadata(v,b.content_type,b.byte_length) FROM allowed JOIN platform.document_versions v USING (tenant_id, environment_id)
  JOIN platform.document_blobs b USING (tenant_id, environment_id, owner_scope, digest)
  WHERE fields IS NOT NULL
    AND platform.document_generated_allowed(v.generated_source,v.release_id,scope,entity,record_key,false) AND (v.owner_scope,v.entity_id,v.record_id) = (scope,entity,record_key)
    AND (v.field_id IS NULL OR fields @> jsonb_build_array(jsonb_build_object('fieldId',v.field_id)))
    AND (after_link IS NULL OR v.link_id > after_link)
  ORDER BY v.link_id LIMIT greatest(1, least(page_size, 100))
$$;

CREATE OR REPLACE FUNCTION platform.read_document_version(scope text, entity text, record_key uuid, link uuid, version uuid)
RETURNS TABLE(metadata jsonb, bytes bytea) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH allowed AS MATERIALIZED (
    SELECT i.*, platform.document_fields(scope, entity, 'download') AS fields
    FROM platform.document_identity() i
    WHERE platform.document_record_revision(i.tenant_id, i.environment_id,
      platform.document_storage(i.tenant_id, i.environment_id), entity, scope, record_key) IS NOT NULL
  )
  SELECT platform.document_metadata(v,b.content_type,b.byte_length), b.bytes FROM allowed JOIN platform.document_versions v USING (tenant_id, environment_id)
  JOIN platform.document_blobs b USING (tenant_id, environment_id, owner_scope, digest)
  WHERE fields IS NOT NULL
    AND platform.document_generated_allowed(v.generated_source,v.release_id,scope,entity,record_key,false) AND (v.owner_scope,v.entity_id,v.record_id,v.link_id,v.version_id) = (scope,entity,record_key,link,version)
    AND (v.field_id IS NULL OR fields @> jsonb_build_array(jsonb_build_object('fieldId',v.field_id)))
$$;

DROP FUNCTION platform.stage_document_upload(text,text,uuid,uuid,text,text,text,text,bytea);

CREATE FUNCTION platform.stage_document_upload(scope text, entity text, record_key uuid, upload uuid, field text,
  category text, filename text, mime text, payload bytea, source jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DECLARE
  i record; s platform.document_upload_staging; fields jsonb; receipt jsonb;
  hash text := encode(sha256(payload), 'hex'); BEGIN
  SELECT * INTO i FROM platform.document_identity();
  PERFORM FROM platform.active_release_pointers
    WHERE (tenant_id,environment_id) = (i.tenant_id,i.environment_id) FOR SHARE;
  PERFORM platform.lock_current_policy_epoch(i.tenant_id,i.environment_id);
  IF platform.document_record_revision(i.tenant_id, i.environment_id,
      platform.document_storage(i.tenant_id, i.environment_id), entity, scope, record_key,
      lock_row => true) IS NULL THEN
    RAISE EXCEPTION 'Unavailable document record' USING ERRCODE = 'D0404'; END IF;
  fields := platform.document_fields(scope, entity, 'upload');
  IF fields IS NULL OR (field IS NOT NULL AND NOT fields @> jsonb_build_array(jsonb_build_object('fieldId',field))) THEN
    RAISE EXCEPTION 'Unavailable file field' USING ERRCODE = 'D0404'; END IF;
  IF source IS NOT NULL AND (field IS NOT NULL OR category IS NOT NULL OR mime IS DISTINCT FROM 'application/pdf'
    OR platform.document_generated_allowed(source,
      (SELECT release_id FROM platform.active_release_pointers WHERE (tenant_id,environment_id) = (i.tenant_id,i.environment_id)),
      scope,entity,record_key,true) IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'Unavailable PDF source' USING ERRCODE = 'D0404'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('documents:' || i.tenant_id || ':' || i.environment_id, 0));
  SELECT * INTO s FROM platform.document_upload_staging
    WHERE (tenant_id,environment_id,upload_id) = (i.tenant_id,i.environment_id,upload);
  IF FOUND THEN
    IF (s.principal_id,s.owner_scope,s.entity_id,s.record_id,s.field_id,s.category_id,s.file_name,s.digest,s.content_type)
       IS DISTINCT FROM (i.principal_id,scope,entity,record_key,field,category,filename,hash,mime)
       OR (s.generated_source->>'inputDigest') IS DISTINCT FROM (source->>'inputDigest') THEN
      RAISE EXCEPTION 'This upload ID already has different input.' USING ERRCODE = 'D0409'; END IF;
    SELECT platform.document_metadata(v,b.content_type,b.byte_length) INTO receipt FROM platform.document_versions v
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
    entity_id,record_id,field_id,category_id,file_name,content_type,digest,bytes,generated_source)
  VALUES (i.tenant_id,i.environment_id,upload,i.principal_id,scope,entity,record_key,field,category,filename,mime,hash,payload,source);
  RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION platform.lock_document_scan(t uuid,e uuid,p uuid,upload uuid,hash text,policy text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DECLARE
  s platform.document_upload_staging; BEGIN
  SELECT * INTO STRICT s FROM platform.document_upload_staging WHERE
    (tenant_id,environment_id,principal_id,upload_id,digest) = (t,e,p,upload,hash) FOR UPDATE;
  IF NOT (platform.document_record_revision(t,e,platform.document_storage(t,e),
      s.entity_id,s.owner_scope,s.record_id) IS NOT NULL) THEN
    RAISE EXCEPTION 'Unavailable stage' USING ERRCODE = 'D0409'; END IF;
  IF s.scan_clean IS FALSE THEN RETURN false; END IF;
  IF s.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'This staged upload expired.' USING ERRCODE = 'D0409'; END IF;
  IF s.scan_policy = policy THEN RETURN s.scan_clean; END IF;
  IF s.retired_at IS NOT NULL THEN RAISE EXCEPTION 'This staged upload expired.' USING ERRCODE = 'D0409'; END IF;
  RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION platform.record_document_scan(t uuid,e uuid,p uuid,upload uuid,hash text,policy text,clean boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  UPDATE platform.document_upload_staging AS s SET scan_clean = clean, scan_digest = hash, scan_policy = policy
    WHERE (tenant_id,environment_id,principal_id,upload_id,digest) = (t,e,p,upload,hash)
      AND platform.document_record_revision(t,e,platform.document_storage(t,e),
      s.entity_id,s.owner_scope,s.record_id) IS NOT NULL
      AND clean IS NOT NULL AND scan_clean IS DISTINCT FROM false AND retired_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unavailable stage' USING ERRCODE = 'D0409'; END IF; END $$;

CREATE OR REPLACE FUNCTION platform.publish_document_upload(upload uuid, hash text, policy text, active_release uuid,
  revision bigint, category_limit integer, retention text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DECLARE
  i record; s platform.document_upload_staging; fields jsonb; field_limit integer; receipt jsonb;
  published platform.document_versions; stored_revision bigint; BEGIN
  SELECT * INTO i FROM platform.document_identity();
  PERFORM FROM platform.active_release_pointers
    WHERE (tenant_id,environment_id) = (i.tenant_id,i.environment_id) FOR SHARE;
  PERFORM platform.lock_current_policy_epoch(i.tenant_id,i.environment_id);
  SELECT * INTO STRICT s FROM platform.document_upload_staging
    WHERE (tenant_id,environment_id,principal_id,upload_id,digest) = (i.tenant_id,i.environment_id,i.principal_id,upload,hash);
  stored_revision := platform.document_record_revision(i.tenant_id, i.environment_id,
    platform.document_storage(i.tenant_id, i.environment_id), s.entity_id,s.owner_scope,s.record_id,
    lock_row => true);
  IF stored_revision IS NULL THEN
    RAISE EXCEPTION 'Unavailable document record' USING ERRCODE = 'D0404'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('documents:' || i.tenant_id || ':' || i.environment_id, 0));
  SELECT * INTO STRICT s FROM platform.document_upload_staging
    WHERE (tenant_id,environment_id,principal_id,upload_id,digest) = (i.tenant_id,i.environment_id,i.principal_id,upload,hash) FOR UPDATE;
  fields := platform.document_fields(s.owner_scope, s.entity_id, 'upload', active_release);
  IF fields IS NULL OR (s.field_id IS NOT NULL AND NOT fields @> jsonb_build_array(jsonb_build_object('fieldId',s.field_id))) THEN
    RAISE EXCEPTION 'Unavailable file field' USING ERRCODE = 'D0404'; END IF;
  SELECT platform.document_metadata(v,b.content_type,b.byte_length) INTO receipt FROM platform.document_versions v
    JOIN platform.document_blobs b USING (tenant_id,environment_id,owner_scope,digest)
    WHERE (v.tenant_id,v.environment_id,v.upload_id) = (i.tenant_id,i.environment_id,upload)
      AND platform.document_generated_allowed(v.generated_source,v.release_id,s.owner_scope,s.entity_id,s.record_id,false);
  IF FOUND THEN RETURN receipt; END IF;
  IF stored_revision IS DISTINCT FROM revision THEN
    RAISE EXCEPTION 'The document record changed.' USING ERRCODE = 'D0409'; END IF;
  IF platform.document_generated_allowed(s.generated_source,active_release,s.owner_scope,s.entity_id,s.record_id,true)
       IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Unavailable PDF source' USING ERRCODE = 'D0404'; END IF;
  IF s.retired_at IS NOT NULL OR s.expires_at <= clock_timestamp() OR s.scan_clean IS DISTINCT FROM true
    OR (s.scan_digest,s.scan_policy) IS DISTINCT FROM (hash,policy) THEN
    RAISE EXCEPTION 'This staged upload has no current clean verdict.' USING ERRCODE = 'D0409'; END IF;
  IF (SELECT coalesce(sum(b.byte_length),0) FROM platform.document_versions v
      JOIN platform.document_blobs b USING (tenant_id,environment_id,owner_scope,digest)
      WHERE (v.tenant_id,v.environment_id) = (i.tenant_id,i.environment_id))
    + (SELECT coalesce(sum(b.byte_length),0) FROM platform.document_blobs b
      WHERE (b.tenant_id,b.environment_id) = (i.tenant_id,i.environment_id) AND b.unversioned_reserve)
    + s.byte_length > 104857600 THEN
    RAISE EXCEPTION 'The stored file quota is full.' USING ERRCODE = 'D0413'; END IF;
  IF s.field_id IS NOT NULL THEN
    SELECT (f->>'maxCount')::integer INTO STRICT field_limit FROM jsonb_array_elements(fields) f WHERE f->>'fieldId' = s.field_id;
    IF (SELECT count(*) >= field_limit OR count(*) FILTER (WHERE category_id = s.category_id) >= category_limit
        FROM platform.document_versions WHERE (tenant_id,environment_id,owner_scope,entity_id,record_id,field_id)
        = (i.tenant_id,i.environment_id,s.owner_scope,s.entity_id,s.record_id,s.field_id)) THEN
      RAISE EXCEPTION 'This file field or category is full.' USING ERRCODE = 'D0409'; END IF; END IF;
  -- Both paths write the complete admitted payload. The unique key retains one logical blob.
  INSERT INTO platform.document_blobs (tenant_id,environment_id,owner_scope,digest,content_type,bytes,unversioned_reserve)
    VALUES (i.tenant_id,i.environment_id,s.owner_scope,hash,s.content_type,s.bytes,false)
    ON CONFLICT (tenant_id,environment_id,owner_scope,digest) DO UPDATE SET bytes = excluded.bytes;
  INSERT INTO platform.document_versions (tenant_id,environment_id,link_id,version_id,upload_id,owner_scope,
    digest,entity_id,record_id,record_revision,field_id,category_id,retention_class,file_name,actor_id,release_id,scan_policy_version,generated_source)
    VALUES (i.tenant_id,i.environment_id,gen_random_uuid(),gen_random_uuid(),upload,s.owner_scope,
      hash,s.entity_id,s.record_id,stored_revision,s.field_id,s.category_id,retention,s.file_name,i.principal_id,active_release,s.scan_policy,s.generated_source)
    RETURNING * INTO published;
  INSERT INTO platform.document_attachment_audit (tenant_id,environment_id,link_id,operation_id)
    VALUES (i.tenant_id,i.environment_id,published.link_id,replace(s.entity_id, ':entity.',
      CASE WHEN s.generated_source IS NULL THEN ':operation.document_attach_' ELSE ':operation.document_generate_' END));
  PERFORM platform.retire_document_upload_staging(upload);
  RETURN platform.document_metadata(published,s.content_type,s.byte_length); END $$;

REVOKE ALL ON FUNCTION platform.stage_document_upload(text,text,uuid,uuid,text,text,text,text,bytea,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.stage_document_upload(text,text,uuid,uuid,text,text,text,text,bytea,jsonb) TO north_star_runtime;
