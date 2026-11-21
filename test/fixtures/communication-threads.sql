-- Extend the booking fixture with the shipped PO Record, supplier picker and Party
-- get from the compiled first-party release. Use their actual storage mappings.
DO $fixture$
DECLARE
  t uuid:=md5('tenant')::uuid; e uuid:=md5('env')::uuid; r uuid:=md5('thread-release')::uuid;
  rev uuid:=md5('thread-package')::uuid; actor uuid:=md5('staff')::uuid; role uuid:=md5('role')::uuid;
  app jsonb; storage jsonb; shipped jsonb; spec jsonb; supplier_col text; query jsonb; h text; manifest text;
  source text; perm text;
BEGIN
  SELECT definition,mapping INTO STRICT app,shipped FROM pg_temp.communication_release_fixture;
  storage:=north_star_internal.booking_projection(t,e,md5('release')::uuid,'storageTargetPayload');
  -- Keep every competing Record/get for these entities while bounding fixture work.
  app:=jsonb_build_object('permissions',app->'permissions','queries',(SELECT jsonb_agg(q) FROM jsonb_array_elements(app->'queries') q
      WHERE q#>>'{sourceEntity,targetId}' IN ('northstar.app:entity.purchase_order','northstar.app:entity.party') OR q->>'queryId' IN ('northstar.app:query.commercial_purchase_lines','northstar.app:query.purchase_order_line_list')),
    'surfaces',(SELECT jsonb_agg(s) FROM jsonb_array_elements(app->'surfaces') s WHERE s->>'surfaceRole'='record'
      AND s#>>'{dataSource,targetId}' IN (SELECT q->>'queryId' FROM jsonb_array_elements(app->'queries') q
        WHERE q#>>'{sourceEntity,targetId}' IN ('northstar.app:entity.purchase_order','northstar.app:entity.party'))),
    'relations',(SELECT jsonb_agg(v) FROM jsonb_array_elements(app->'relations') v
      WHERE v#>>'{targetEntity,targetId}'='northstar.app:entity.purchase_order')||jsonb_build_array(jsonb_build_object('relationId','example.booking:relation.account','lifecycle','active','joinEligibility','query',
      'sourceEntity',jsonb_build_object('targetId','example.booking:entity.visit'),'targetEntity',jsonb_build_object('targetId','example.booking:entity.account'))));
  FOR source,perm IN VALUES ('visit','visit'),('account','account_detail'),('asset','asset') LOOP
    query:=jsonb_build_object('queryId','example.booking:query.'||source,'tier','q0','lifecycle','active','queryType','get',
      'maximumResultCount',1,'filter',jsonb_build_object('kind','booleanPredicate','value',true),
      'sourceEntity',jsonb_build_object('targetId','example.booking:entity.'||source),
      'permission',jsonb_build_object('targetId','example.booking:permission.'||perm));
    app:=jsonb_set(app,'{permissions}',(app->'permissions')||jsonb_build_array(jsonb_build_object('lifecycle','active',
      'permissionId',query#>>'{permission,targetId}','resource',query->'sourceEntity')));
    app:=jsonb_set(app,'{queries}',(app->'queries')||jsonb_build_array(query));
  END LOOP;
  FOR spec IN SELECT value FROM jsonb_array_elements(shipped->'entities') WHERE value->>'entityId' IN
    ('northstar.app:entity.purchase_order','northstar.app:entity.party') LOOP
    storage:=jsonb_set(storage,'{entities}',(storage->'entities')||jsonb_build_array(spec));
    IF spec->>'entityId'='northstar.app:entity.purchase_order' THEN
      SELECT c->>'physicalName' INTO STRICT supplier_col FROM jsonb_array_elements(spec->'columns') c
        WHERE c->>'canonicalFieldId'='northstar.app:field.purchase_order_supplier_party_id';
      EXECUTE format('CREATE TABLE north_star_module.%I(tenant_id uuid,environment_id uuid,record_id uuid,archived_at timestamptz,legal_entity_id uuid,%I text)',spec->>'physicalTableName',supplier_col);
      EXECUTE format('INSERT INTO north_star_module.%I VALUES ($1,$2,md5(''order'')::uuid,NULL,md5(''company0'')::uuid,$3),
        ($1,$2,md5(''bad-order'')::uuid,NULL,md5(''company0'')::uuid,''not a record'')',spec->>'physicalTableName')
        USING t,e,md5('supplier')::uuid::text;
    ELSE
      EXECUTE format('CREATE TABLE north_star_module.%I(tenant_id uuid,environment_id uuid,record_id uuid,archived_at timestamptz)',spec->>'physicalTableName');
      EXECUTE format('INSERT INTO north_star_module.%I VALUES ($1,$2,md5(''supplier'')::uuid,NULL)',spec->>'physicalTableName') USING t,e;
    END IF;
  END LOOP;
  INSERT INTO platform.app_package_revisions(tenant_id,revision_id,schema_version,language_version,normalization_profile_version,
    canonicalization_profile_version,hash_algorithm,content_hash,desired_state,provenance,created_by)
    VALUES(t,rev,'v6','v6','v1','v1','sha256',encode(sha256(convert_to(app::text,'UTF8')),'hex'),convert_to(app::text,'UTF8'),'firstParty',actor);
  INSERT INTO platform.tenant_releases(tenant_id,environment_id,release_id,app_package_revision_id,compiler_version,
    compiler_semantic_profile_version,output_protocol_version,content_hash,compiler_attestation_digest,verification_evidence_id,created_by)
    VALUES(t,e,r,rev,'compiler/v1','profile/v1','protocol/v1',repeat('a',64),repeat('b',64),gen_random_uuid(),actor);
  manifest:=encode(sha256(convert_to('storage-target','UTF8')),'hex');
  h:=encode(sha256(convert_to(storage::text,'UTF8')),'hex');
  INSERT INTO platform.release_artifact_blobs VALUES (h,'projectionChunk','storage-target','application/vnd.northstar.canonical+json',
    convert_to(storage::text,'UTF8'),octet_length(storage::text));
  INSERT INTO platform.tenant_release_artifact_links VALUES (t,e,r,manifest,'projectionManifest'),(t,e,r,h,'projectionChunk');
  INSERT INTO platform.tenant_release_projection_links (tenant_id,environment_id,release_id,projection_instance_id,projection_family_id,projection_manifest_hash)
    VALUES(t,e,r,'storage-target','northstar.compiler:projection-family.storage-target',manifest);
  INSERT INTO platform.tenant_release_chunk_links(tenant_id,environment_id,release_id,projection_instance_id,chunk_id,chunk_hash)
    VALUES(t,e,r,'storage-target','payload',h);
  UPDATE platform.active_release_pointers SET release_id=r,fence=fence+1 WHERE tenant_id=t AND environment_id=e;

  INSERT INTO platform.staff_accounts(tenant_id,environment_id,principal_id,user_handle,display_name,recovery_contact,status)
    SELECT t,e,md5(p)::uuid,sha256(convert_to(p,'UTF8')),p,p,'active' FROM unnest(ARRAY['staff','west','east']) p;
  INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
    SELECT t,e,role,g.* FROM (VALUES
      ('northstar.runtime:permission.semantic-query-boundary','northstar.runtime:gateway.semantic-query'),
      ('example.booking:permission.read_relation_account','example.booking:relation.account'),
      ('example.booking:permission.disclose_contact_account','example.booking:entity.account'),
      ('northstar.runtime:permission.legal-entity-read-scope','northstar.runtime:scope.legal-entity'),
      ('northstar.app:permission.read_reference_purchase_order_supplier_party_id','northstar.app:field.purchase_order_supplier_party_id'),
      ('northstar.app:permission.purchase_order_line_read','northstar.app:entity.purchase_order_line'),
      ('northstar.app:permission.purchase_order_read','northstar.app:entity.purchase_order'),
      ('northstar.app:permission.party_read','northstar.app:entity.party'),
      ('northstar.app:permission.discussion_post_purchase_order','northstar.app:entity.purchase_order'),
      ('northstar.app:permission.discussion_post_party','northstar.app:entity.party')) g;
END $fixture$;
