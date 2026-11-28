-- WORKFLOW-3 slice 1b (ADR-0073 A1 engineFactChanged): Booking names each
-- commitment state change as the engine fact northstar.booking:fact.commitment-state.
-- Number provisional.
--
-- Every state change ends in one of the two history writers (single:
-- booking_record_change; kit: booking_record_kit, one history row per member),
-- so the emit sits there, once per (commitment, revision), in the writer's own
-- transaction and under the receipt (invocation) booking_evidence writes next.
-- The timer sweep (booking_sweep_due) reaches the same writers with no tenant
-- scope, over every tenant, and catches only lock_not_available and
-- unique_violation, so nothing here reads a session setting (E2):
--   * tenant, environment and the commitment come from the stored fact row;
--   * the owner record and its company come from booking_owner_cursors;
--   * the owner's table comes from the storage target of the release the
--     writer was handed (the arming command's release on the timer path),
--     whose physical table name is a function of the entity ID alone.
-- A create (a new hold, or an import of a confirmed or in-use commitment), a
-- change that keeps the state, a shared owner (company NULL) and an owner type
-- without its own company column name nothing; admission refuses a trigger on
-- such a type.

-- Total over the seven states the commitment CHECK admits (0059).
CREATE FUNCTION north_star_internal.booking_state_value(state text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT 'northstar.booking:value.' || CASE state WHEN 'inUse' THEN 'in-use' WHEN 'noShow' THEN 'no-show'
                                                  ELSE state END
$$;

CREATE FUNCTION north_star_internal.booking_emit_state_fact(
  previous_state text, fact platform.booking_commitments, owner_row platform.booking_owner_cursors,
  r uuid, receipt uuid
) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE spec jsonb; BEGIN
  IF previous_state IS NULL OR previous_state = fact.state OR owner_row.company_id IS NULL THEN RETURN; END IF;
  SELECT value INTO spec
    FROM jsonb_array_elements(north_star_internal.booking_projection(
      fact.tenant_id, fact.environment_id, r, 'storageTargetPayload')->'entities')
   WHERE value->>'entityId' = owner_row.entity_id;
  -- The release r ran a command on this commitment, so it stores the owner
  -- type; a type with no company column of its own cannot be a trigger record.
  IF spec IS NULL OR NOT spec ? 'legalEntity' THEN RETURN; END IF;
  PERFORM north_star_internal.engine_facts(
    fact.tenant_id, fact.environment_id, 'northstar.booking:fact.commitment-state', receipt,
    spec->>'physicalTableName', coalesce(spec->'recordIdentity'->>'column', 'record_id'),
    owner_row.entity_id, owner_row.company_id, owner_row.record_id,
    fact.booking_id, fact.revision,
    north_star_internal.booking_state_value(previous_state), north_star_internal.booking_state_value(fact.state)); END $$;

CREATE OR REPLACE FUNCTION north_star_internal.booking_record_change(
  previous platform.booking_commitments, fact platform.booking_commitments, r uuid,actor jsonb,action text,
  key uuid,input jsonb,reason text,effective timestamptz,decision timestamptz
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE owner_row platform.booking_owner_cursors; receipt uuid := gen_random_uuid(); payload jsonb; BEGIN
  UPDATE platform.booking_owner_cursors SET cursor_value=cursor_value+1 WHERE owner_key=fact.owner_key RETURNING * INTO STRICT owner_row;
  INSERT INTO platform.booking_history VALUES (fact.tenant_id,fact.environment_id,fact.booking_id,fact.revision,fact.owner_key,
    owner_row.cursor_value,CASE WHEN previous.booking_id IS NOT NULL THEN to_jsonb(previous) END,to_jsonb(fact),
    action,reason,effective,decision,receipt);
  PERFORM north_star_internal.booking_emit_state_fact(previous.state,fact,owner_row,r,receipt);
  payload := jsonb_build_object('operation',action,'effectiveAt',effective,
    'ownerScope',CASE WHEN owner_row.company_id IS NULL THEN '{"kind":"shared"}'::jsonb
                  ELSE jsonb_build_object('kind','company','companyId',owner_row.company_id) END,
    'owners',jsonb_build_array(jsonb_build_object('ownerRef',jsonb_build_object('entityId',owner_row.entity_id,'recordId',owner_row.record_id),
      'previousCursor',(owner_row.cursor_value-1)::text,'cursor',owner_row.cursor_value::text,
      'bookings',jsonb_build_array(jsonb_build_object('bookingId',fact.booking_id,'revision',fact.revision)))));
  IF NOT EXISTS (SELECT FROM platform.booking_history h JOIN platform.booking_commitments f USING (tenant_id,environment_id,booking_id,revision)
    JOIN platform.booking_owner_cursors o ON (o.tenant_id,o.environment_id,o.owner_key,o.cursor_value)=(h.tenant_id,h.environment_id,h.owner_key,h.cursor_value)
    WHERE (h.tenant_id,h.environment_id,h.receipt_id,h.after_fact)=(fact.tenant_id,fact.environment_id,receipt,to_jsonb(f))
    AND h.after_fact=to_jsonb(fact)) THEN RAISE EXCEPTION 'booking.evidenceMismatch'; END IF;
  RETURN north_star_internal.booking_evidence(fact.tenant_id,fact.environment_id,r,actor,action,key,input,receipt,fact.booking_id,
    fact.revision,CASE WHEN previous.booking_id IS NOT NULL THEN to_jsonb(previous) END,to_jsonb(fact),decision,'booking.changed',payload,
    jsonb_build_object('bookingId',fact.booking_id,'revision',fact.revision,'state',fact.state,'deadline',fact.deadline)); END $$;

CREATE OR REPLACE FUNCTION north_star_internal.booking_record_kit(t uuid,e uuid,kit uuid,r uuid,actor jsonb,action text,key uuid,input jsonb,
  decision timestamptz,effective timestamptz) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE own platform.booking_owner_cursors; f platform.booking_commitments; lead_fact platform.booking_commitments;
  previous jsonb; members jsonb; owners jsonb:='[]'; receipt uuid:=gen_random_uuid(); scope jsonb; BEGIN
  FOR own IN SELECT o.* FROM platform.booking_owner_cursors o WHERE EXISTS(SELECT FROM platform.booking_commitments b WHERE
    (b.tenant_id,b.environment_id,b.group_id,b.owner_key)=(t,e,kit,o.owner_key)) ORDER BY o.owner_key LOOP
    UPDATE platform.booking_owner_cursors SET cursor_value=cursor_value+1 WHERE owner_key=own.owner_key RETURNING * INTO STRICT own;
    members:='[]';
    FOR f IN SELECT * FROM platform.booking_commitments WHERE (tenant_id,environment_id,group_id,owner_key)=(t,e,kit,own.owner_key) ORDER BY booking_id LOOP
      previous:=NULL;
      IF f.revision>1 THEN SELECT after_fact INTO STRICT previous FROM platform.booking_history
        WHERE (tenant_id,environment_id,booking_id,revision)=(t,e,f.booking_id,f.revision-1); END IF;
      INSERT INTO platform.booking_history VALUES(t,e,f.booking_id,f.revision,own.owner_key,own.cursor_value,previous,to_jsonb(f),
        action,input->>'reason',effective,decision,receipt);
      IF NOT EXISTS(SELECT FROM platform.booking_history h WHERE
        (h.booking_id,h.revision,h.cursor_value,h.receipt_id,h.after_fact)=(f.booking_id,f.revision,own.cursor_value,receipt,to_jsonb(f))
        AND h.before_fact IS NOT DISTINCT FROM previous) THEN RAISE EXCEPTION 'booking.evidenceMismatch'; END IF;
      PERFORM north_star_internal.booking_emit_state_fact(previous->>'state',f,own,r,receipt);
      members:=members||jsonb_build_array(jsonb_build_object('bookingId',f.booking_id,'revision',f.revision));
      IF lead_fact.booking_id IS NULL THEN lead_fact:=f; END IF; END LOOP;
    owners:=owners||jsonb_build_array(jsonb_build_object('ownerRef',jsonb_build_object('entityId',own.entity_id,'recordId',own.record_id),
      'previousCursor',(own.cursor_value-1)::text,'cursor',own.cursor_value::text,'bookings',members));
    scope:=CASE WHEN own.company_id IS NULL THEN '{"kind":"shared"}'::jsonb ELSE jsonb_build_object('kind','company','companyId',own.company_id) END; END LOOP;
  IF lead_fact.booking_id IS NULL THEN RAISE EXCEPTION 'booking.evidenceMismatch'; END IF;
  RETURN north_star_internal.booking_evidence(t,e,r,actor,action,key,input,receipt,lead_fact.booking_id,lead_fact.revision,
    CASE WHEN lead_fact.revision>1 THEN jsonb_build_object('groupId',kit) END,to_jsonb(lead_fact),decision,'booking.changed',
    jsonb_build_object('operation',action,'effectiveAt',effective,'ownerScope',scope,'owners',owners),
    jsonb_build_object('groupId',kit,'bookingId',lead_fact.booking_id,'revision',lead_fact.revision,'state',lead_fact.state,'deadline',lead_fact.deadline)); END $$;

REVOKE ALL ON FUNCTION north_star_internal.booking_state_value(text),
  north_star_internal.booking_emit_state_fact(text,platform.booking_commitments,platform.booking_owner_cursors,uuid,uuid)
  FROM PUBLIC;
