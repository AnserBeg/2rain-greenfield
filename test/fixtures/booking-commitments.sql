-- A released operation catalog and the two managed record types it binds.
-- Only fixture installation runs as the migration owner. Calls use north_star_runtime.
CREATE TABLE north_star_module.test_booking_parents (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, record_id uuid PRIMARY KEY, legal_entity_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1, archived_at timestamptz
);
CREATE TABLE north_star_module.test_booking_owners (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, record_id uuid PRIMARY KEY, legal_entity_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1, archived_at timestamptz
);
CREATE TABLE north_star_module.test_booking_resources (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, record_id uuid PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 1, archived_at timestamptz
);
ALTER TABLE north_star_module.test_booking_owners ADD COLUMN parent_id uuid;
GRANT SELECT, UPDATE ON north_star_module.test_booking_owners TO north_star_module_runtime;
CREATE TABLE public.booking_test_clock (instant timestamptz NOT NULL);
INSERT INTO public.booking_test_clock VALUES ('2030-02-10 18:00Z');
CREATE OR REPLACE FUNCTION north_star_internal.booking_now() RETURNS timestamptz LANGUAGE sql VOLATILE
SET search_path=pg_catalog,pg_temp AS $$ SELECT instant FROM public.booking_test_clock $$;

DO $fixture$
DECLARE
  t uuid := md5('tenant')::uuid; e uuid := md5('env')::uuid; p uuid := md5('staff')::uuid;
  r uuid := md5('release')::uuid; rev uuid := md5('package')::uuid; role uuid := md5('role')::uuid;
  owner_entity text := 'example.booking:entity.visit'; target_entity text := 'example.booking:entity.asset';
  ops jsonb := '[]'; op jsonb; payload jsonb; family text; chunk text; manifest text; permission text; scope text; verb text; kind text;
BEGIN
  INSERT INTO platform.tenants(id,slug) VALUES (t,'booking');
  INSERT INTO platform.environments(tenant_id,id,slug) VALUES (t,e,'booking');
  INSERT INTO platform.app_package_revisions(tenant_id,revision_id,schema_version,language_version,normalization_profile_version,
    canonicalization_profile_version,hash_algorithm,content_hash,desired_state,provenance,created_by)
    VALUES(t,rev,'v6','v6','v1','v1','sha256',repeat('d',64),convert_to('{}','UTF8'),'firstParty',p);
  INSERT INTO platform.release_artifact_blobs VALUES(repeat('a',64),'releaseManifest','fixture',
    'application/vnd.northstar.canonical+json',convert_to('{}','UTF8'),2);
  INSERT INTO platform.tenant_releases(tenant_id,environment_id,release_id,app_package_revision_id,compiler_version,
    compiler_semantic_profile_version,output_protocol_version,content_hash,compiler_attestation_digest,verification_evidence_id,created_by)
    VALUES(t,e,r,rev,'compiler/v1','profile/v1','protocol/v1',repeat('a',64),repeat('b',64),gen_random_uuid(),p);
  UPDATE platform.active_release_pointers SET release_id=r,fence=fence+1 WHERE tenant_id=t AND environment_id=e;
  INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key) VALUES(t,e,role,'dispatcher');
  INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id) VALUES(t,e,gen_random_uuid(),p,role);
  INSERT INTO platform.inventory_tenant_calendars(tenant_id,time_zone,business_day_boundary) VALUES(t,'America/Denver','08:00');
  INSERT INTO north_star_module.test_booking_owners(tenant_id,environment_id,record_id,legal_entity_id)
    SELECT t,e,md5('owner'||n)::uuid,md5('company'||(n%2))::uuid FROM generate_series(1,90) n;
  INSERT INTO north_star_module.test_booking_parents
    SELECT tenant_id,environment_id,record_id,legal_entity_id,revision,archived_at FROM north_star_module.test_booking_owners;
  UPDATE north_star_module.test_booking_owners SET parent_id=record_id;
  INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key)
    VALUES(t,e,md5('shared-reader')::uuid,'shared-reader');
  INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id)
    VALUES(t,e,gen_random_uuid(),md5('ordinary')::uuid,role,md5('company0')::uuid),
          (t,e,gen_random_uuid(),md5('ordinary')::uuid,md5('shared-reader')::uuid,NULL),
          (t,e,gen_random_uuid(),md5('scoped')::uuid,role,md5('company1')::uuid),
          (t,e,gen_random_uuid(),md5('scoped')::uuid,md5('shared-reader')::uuid,NULL);
  INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
    VALUES(t,e,md5('shared-reader')::uuid,'example.booking:permission.asset',target_entity);
  -- An archiver of company0 visits whose only grant names a different resource.
  INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key)
    VALUES(t,e,md5('visit-archiver')::uuid,'visit-archiver');
  INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id)
    VALUES(t,e,gen_random_uuid(),md5('archiver')::uuid,md5('visit-archiver')::uuid,md5('company0')::uuid);
  INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
    VALUES(t,e,md5('visit-archiver')::uuid,'example.booking:permission.archive_visit','example.booking:entity.account');
  INSERT INTO north_star_module.test_booking_resources(tenant_id,environment_id,record_id)
    SELECT t,e,md5('resource'||n)::uuid FROM generate_series(1,75) n;
  FOREACH kind IN ARRAY ARRAY['unit','pool'] LOOP
    FOREACH verb IN ARRAY ARRAY['hold','holdTracked','confirm','changeInterval','cancel','setCapacity','start','return','swap','pause','resume','noShow','changeQuantity','correctActuals','recordExisting'] LOOP
      IF verb='setCapacity' AND kind='unit' THEN CONTINUE; END IF;
      scope := CASE WHEN verb='setCapacity' THEN target_entity ELSE owner_entity END;
      permission := 'example.booking:permission.'||lower(verb)||'_'||kind;
      INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
        VALUES(t,e,role,permission,scope);
      op := jsonb_build_object('operationId','example.booking:operation.'||lower(verb)||'_'||kind,
        'permissionId',permission,'lifecycle','active','confirmation',CASE WHEN verb IN ('hold','holdTracked') THEN 'none' ELSE 'humanRequired' END,
        'effect',jsonb_build_object('kind','registeredCapabilityEffect','capability',jsonb_build_object('targetId','northstar.booking:capability.commitments')),
        'booking',jsonb_build_object('bindingVersion','booking.commitment/v1','declarationRevision','example.booking:revision.'||kind,
        'slotRevision',CASE WHEN verb='setCapacity' THEN 'example.booking:revision.capacity' WHEN verb='holdTracked' THEN 'example.booking:revision.tracked' ELSE 'example.booking:revision.slot' END,'slotId','example.booking:slot.visit','kind',kind,'operation',CASE WHEN verb='holdTracked' THEN 'hold' ELSE verb END,
        'fulfilmentMode',CASE WHEN verb IN ('holdTracked','recordExisting') THEN 'tracked' ELSE 'scheduled' END,'ownerEntity',scope,'resourceEntity',target_entity,
        'ownerReadPermission',CASE WHEN verb='setCapacity' THEN 'example.booking:permission.asset' ELSE 'example.booking:permission.visit' END,
        'resourceReadPermission','example.booking:permission.asset','unit','each','scale',CASE WHEN kind='unit' THEN 0 ELSE 2 END,
        'maxBackdateDays',1,'holdSeconds',900));
      IF verb IN ('start','return','swap','pause','resume','noShow','changeQuantity','correctActuals','recordExisting') THEN
        op:=jsonb_set(op,'{booking}',(op->'booking')||jsonb_build_object('bindingVersion','booking.fulfilment/v1',
          'stewardPermission','example.booking:permission.steward','maxCorrectionAgeDays',90)); END IF;
      ops := ops||jsonb_build_array(op);
    END LOOP;
  END LOOP;
  FOREACH verb IN ARRAY ARRAY['hold','confirm','cancel'] LOOP
    SELECT value INTO STRICT op FROM jsonb_array_elements(ops) WHERE value->>'operationId'='example.booking:operation.'||verb||'_unit';
    op:=jsonb_set(op,'{operationId}',to_jsonb('example.booking:operation.kit'||verb||'_unit'));
    op:=jsonb_set(op,'{booking}',(op->'booking')||jsonb_build_object('bindingVersion','booking.kit/v1',
      'memberOperations',jsonb_build_array('example.booking:operation.'||verb||'_unit','example.booking:operation.'||verb||'_pool')));
    ops:=ops||jsonb_build_array(op);
  END LOOP;
  INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
    VALUES(t,e,role,'example.booking:permission.visit',owner_entity),(t,e,role,'example.booking:permission.asset',target_entity);
  INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key) VALUES(t,e,md5('steward')::uuid,'steward');
  INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id)
    VALUES(t,e,gen_random_uuid(),p,md5('steward')::uuid);
  INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
    VALUES(t,e,md5('steward')::uuid,'example.booking:permission.steward',owner_entity);
  INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
    VALUES(t,e,role,'example.booking:permission.usage',owner_entity);
  INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
    VALUES(t,e,role,'example.booking:permission.account_detail','example.booking:entity.account'),
          (t,e,role,'example.booking:permission.account_usage','example.booking:entity.account');
  FOREACH family IN ARRAY ARRAY['operation-catalog','query-catalog','storage-target'] LOOP
    payload := CASE WHEN family='operation-catalog' THEN jsonb_build_object('kind','operationCatalogPayload','operations',ops)
      WHEN family='query-catalog' THEN jsonb_build_object('kind','queryCatalogPayload','queries',jsonb_build_array(
        jsonb_build_object('queryId','example.booking:query.owner','tier','q0','queryType','get','lifecycle','active','permissionId','example.booking:permission.visit','sourceEntityId',owner_entity),
        jsonb_build_object('queryId','example.booking:query.usage','tier','q2','queryType','get','lifecycle','active','permissionId','example.booking:permission.usage','sourceEntityId',owner_entity,
          'readModel',jsonb_build_object('capability',jsonb_build_object('targetId','northstar.booking:capability.owner_usage'),
          'binding','northstar.booking:protocol.owner_usage_v1','queries',jsonb_build_object('owner',jsonb_build_object('targetId','example.booking:query.owner'))))))
      ELSE jsonb_build_object('kind','storageTargetPayload','relations',jsonb_build_array(
        jsonb_build_object('relationId','example.booking:relation.account','sourceEntityId', owner_entity,'targetEntityId','example.booking:entity.account',
          'ownership','parentScopedChild','relationColumn',jsonb_build_object('physicalName','parent_id'))),
      'entities',jsonb_build_array(
        jsonb_build_object('entityId','example.booking:entity.account','lifecycle','active','legalEntity',jsonb_build_object('column','legal_entity_id'),'physicalTableName','test_booking_parents'),
        jsonb_build_object('entityId',owner_entity,'lifecycle','active','legalEntity',jsonb_build_object('column','legal_entity_id'),'physicalTableName','test_booking_owners'),
        jsonb_build_object('entityId',target_entity,'lifecycle','active','physicalTableName','test_booking_resources'))) END;
    IF family='query-catalog' THEN
      payload:=jsonb_set(payload,'{queries}',(payload->'queries')||jsonb_build_array(
        (payload#>'{queries,0}')||jsonb_build_object('queryId','example.booking:query.account_detail',
          'sourceEntityId','example.booking:entity.account','permissionId','example.booking:permission.account_detail'),
        jsonb_set((payload#>'{queries,1}')||jsonb_build_object('queryId','example.booking:query.account_usage',
          'sourceEntityId','example.booking:entity.account','permissionId','example.booking:permission.account_usage'),
          '{readModel,queries,owner,targetId}',to_jsonb('example.booking:query.account_detail'::text))));
    END IF;
    chunk := encode(sha256(convert_to(payload::text,'UTF8')),'hex');
    manifest := encode(sha256(convert_to(family,'UTF8')),'hex');
    INSERT INTO platform.release_artifact_blobs VALUES
      (manifest,'projectionManifest',family,'application/vnd.northstar.canonical+json',convert_to('{}','UTF8'),2),
      (chunk,'projectionChunk',family,'application/vnd.northstar.canonical+json',convert_to(payload::text,'UTF8'),octet_length(payload::text));
    INSERT INTO platform.tenant_release_artifact_links VALUES (t,e,r,manifest,'projectionManifest'),(t,e,r,chunk,'projectionChunk');
    INSERT INTO platform.tenant_release_projection_links (tenant_id,environment_id,release_id,projection_instance_id,projection_family_id,projection_manifest_hash)
      VALUES (t,e,r,family,'northstar.compiler:projection-family.'||family,manifest);
    INSERT INTO platform.tenant_release_chunk_links(tenant_id,environment_id,release_id,projection_instance_id,chunk_id,chunk_hash) VALUES(t,e,r,family,'payload',chunk);
  END LOOP;
END $fixture$;
