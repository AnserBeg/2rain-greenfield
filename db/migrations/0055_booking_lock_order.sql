-- One global row-lock order for managed records: descendants before
-- ancestors. The generic module writer locks a child and then its parent
-- FOR SHARE, so a booking must never hold a parent while it waits for a child.
-- Height is the longest parentScopedChild path from an entity to a root. It is
-- a property of the entity in the pinned storage target, not of the booking
-- that reached it, so every writer agrees on it. A child is always strictly
-- higher than each of its parents.
CREATE FUNCTION north_star_internal.booking_entity_height(storage jsonb,entity text,visited text[] DEFAULT '{}')
RETURNS integer LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE height integer := 0; relation jsonb; BEGIN
  IF entity = ANY(visited) THEN RAISE EXCEPTION 'booking.ownershipCycle'; END IF;
  FOR relation IN SELECT value FROM jsonb_array_elements(storage->'relations')
    WHERE value->>'sourceEntityId'=entity AND value->>'ownership'='parentScopedChild' LOOP
    height := greatest(height,1+north_star_internal.booking_entity_height(storage,relation->>'targetEntityId',visited||entity)); END LOOP;
  RETURN height; END $$;
REVOKE ALL ON FUNCTION north_star_internal.booking_entity_height(jsonb,text,text[]) FROM PUBLIC;

-- Discover both endpoints and all owning ancestors without locking. Lock each
-- row once, highest entity first, then (entity, record). Compare the closure
-- again under those locks in case an ownership link moved during discovery.
CREATE OR REPLACE FUNCTION north_star_internal.booking_lock_endpoints(t uuid,e uuid,storage jsonb,owner_type text,owner_id uuid,target_type text,target_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE node record; closure jsonb; locked jsonb; pass integer; live boolean; BEGIN
  FOR pass IN 1..2 LOOP
    closure := '[]';
    FOR node IN
      SELECT n.entity_id,n.record_id,n.table_name FROM (
        SELECT * FROM north_star_internal.booking_endpoint_tree(t,e,storage,owner_type,owner_id)
        UNION SELECT * FROM north_star_internal.booking_endpoint_tree(t,e,storage,target_type,target_id)) n
      ORDER BY north_star_internal.booking_entity_height(storage,n.entity_id) DESC,n.entity_id,n.record_id LOOP
      closure := closure || jsonb_build_array(to_jsonb(node));
      IF pass=1 THEN
        EXECUTE format('SELECT true FROM north_star_module.%I WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL FOR UPDATE',node.table_name)
          INTO live USING t,e,node.record_id;
        IF live IS DISTINCT FROM true THEN RAISE EXCEPTION 'booking.endpointUnavailable'; END IF; END IF; END LOOP;
    IF pass=1 THEN locked := closure;
    ELSIF closure<>locked THEN RAISE EXCEPTION 'booking.endpointChanged' USING ERRCODE='40001'; END IF; END LOOP; END $$;

-- An active allocation prevents archiving either endpoint (ADR-0082). The
-- archive caller is already authorized for the record, so the guard does not
-- depend on what that caller can see. Both routines are reached only from the
-- generic archive path, and neither returns allocation detail.
CREATE OR REPLACE FUNCTION platform.lock_record_allocations(entity text,record uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  PERFORM north_star_internal.booking_require_isolation();
  PERFORM FROM platform.booking_resources d
   WHERE d.tenant_id=north_star_internal.trusted_tenant_id() AND d.environment_id=north_star_internal.trusted_environment_id()
     AND ((d.entity_id,d.record_id)=(entity,record) OR EXISTS
       (SELECT FROM platform.booking_owner_cursors o JOIN platform.booking_commitments f USING (tenant_id,environment_id,owner_key)
         WHERE (o.tenant_id,o.environment_id,o.entity_id,o.record_id)=(d.tenant_id,d.environment_id,entity,record)
           AND f.resource_key=d.resource_key AND f.state IN ('hold','confirmed')))
   ORDER BY d.resource_key FOR UPDATE OF d; END $$;

CREATE OR REPLACE FUNCTION north_star_internal.require_record_archivable(entity text,record uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  PERFORM north_star_internal.booking_require_isolation();
  IF EXISTS (SELECT FROM platform.booking_commitments f JOIN platform.booking_resources d USING (tenant_id,environment_id,resource_key)
    JOIN platform.booking_owner_cursors o USING (tenant_id,environment_id,owner_key)
    WHERE f.tenant_id=north_star_internal.trusted_tenant_id() AND f.environment_id=north_star_internal.trusted_environment_id()
      AND ((d.entity_id,d.record_id)=(entity,record) OR (o.entity_id,o.record_id)=(entity,record))
      AND f.state IN ('hold','confirmed')) THEN RAISE EXCEPTION 'booking.activeAllocation'; END IF; END $$;

DROP FUNCTION north_star_internal.booking_company_visible(uuid,uuid,uuid,text);

-- platform.attest_booking_approval is SECURITY DEFINER and trusts the issuer
-- role's tenant, environment and principal arguments. Scope is enforced at
-- consumption: booking_apply matches the grant on the trusted tenant,
-- environment and principal and then authorizes the company.
COMMENT ON FUNCTION platform.attest_booking_approval(uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid,jsonb,text) IS
  'Scope exception: no trusted-context scoping; booking_apply enforces tenant, environment, principal and company at consumption.';
