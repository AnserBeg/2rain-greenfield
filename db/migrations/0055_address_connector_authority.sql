-- CONNECT-1 fix round. The runtime role keeps no direct grant on the address
-- tables. Every read and write goes through a SECURITY DEFINER function below.
-- Tenant, environment and principal come from the trusted request context, and
-- company membership is checked against the live policy rows. Enabling or
-- configuring a provider also needs the declared configure permission, held in
-- a membership scoped to that company.
DROP POLICY address_installations_read ON platform.address_installations;
DROP POLICY address_installations_insert ON platform.address_installations;
DROP POLICY address_installations_update ON platform.address_installations;
DROP POLICY address_installation_history_read ON platform.address_installation_history;
DROP POLICY address_installation_history_insert ON platform.address_installation_history;
DROP POLICY address_quota_read ON platform.address_quota;
DROP POLICY address_quota_insert ON platform.address_quota;
DROP POLICY address_quota_update ON platform.address_quota;
DROP POLICY address_geocodes_read ON platform.address_geocodes;
DROP POLICY address_geocodes_insert ON platform.address_geocodes;
DROP POLICY address_geocodes_update ON platform.address_geocodes;
DROP FUNCTION platform.address_company_access(uuid,uuid,uuid,boolean);
REVOKE ALL ON platform.address_installations, platform.address_installation_history,
  platform.address_quota, platform.address_geocodes FROM PUBLIC, north_star_runtime;

-- The sweeper scrubs expired provider coordinates and records why.
ALTER TABLE platform.address_geocodes DROP CONSTRAINT address_geocodes_reason_check,
  ADD CONSTRAINT address_geocodes_reason_check CHECK (reason IN
    ('quota','unconfigured','unavailable','noMatch','invalidResult','superseded','expired'));
CREATE INDEX address_geocodes_expiry ON platform.address_geocodes(tenant_id,environment_id,expires_at)
  WHERE latitude IS NOT NULL;

CREATE FUNCTION north_star_internal.address_principal() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
AS $$ SELECT nullif(current_setting('north_star.principal_id', true), '')::uuid $$;

-- Any live membership whose company scope covers the company.
CREATE FUNCTION north_star_internal.address_member(scope_company uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT scope_company IS NOT NULL AND EXISTS (
    SELECT FROM platform.current_policy_memberships m
    JOIN platform.current_policy_roles r USING (tenant_id,environment_id,role_id)
    WHERE (m.tenant_id,m.environment_id,m.principal_id) = (north_star_internal.trusted_tenant_id(),
          north_star_internal.trusted_environment_id(), north_star_internal.address_principal())
      AND m.revoked_at IS NULL AND r.revoked_at IS NULL
      AND (m.legal_entity_id IS NULL OR m.legal_entity_id = scope_company))
$$;

-- The declared write permission, live, in a membership that covers the company.
CREATE FUNCTION north_star_internal.address_may_configure(scope_company uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT scope_company IS NOT NULL AND EXISTS (
    SELECT FROM platform.current_policy_memberships m
    JOIN platform.current_policy_roles r USING (tenant_id,environment_id,role_id)
    JOIN platform.current_policy_permission_grants g USING (tenant_id,environment_id,role_id)
    WHERE (m.tenant_id,m.environment_id,m.principal_id) = (north_star_internal.trusted_tenant_id(),
          north_star_internal.trusted_environment_id(), north_star_internal.address_principal())
      AND m.revoked_at IS NULL AND r.revoked_at IS NULL AND g.revoked_at IS NULL
      AND g.permission_id = 'northstar.runtime:permission.connector_configure'
      AND g.resource_id = 'northstar.runtime:connector.address'
      AND (m.legal_entity_id IS NULL OR m.legal_entity_id = scope_company))
$$;

CREATE FUNCTION north_star_internal.address_require_read_committed() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'address.requiresReadCommitted'; END IF; END $$;

CREATE FUNCTION platform.address_installations()
RETURNS TABLE (company_id uuid, installation_id uuid, account text, provider text, enrichment boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT i.company_id, i.installation_id, i.account, i.provider, i.enrichment
    FROM platform.address_installations i
   WHERE i.tenant_id = north_star_internal.trusted_tenant_id()
     AND i.environment_id = north_star_internal.trusted_environment_id()
     AND i.enabled AND north_star_internal.address_member(i.company_id)
   ORDER BY i.account, i.company_id
$$;

-- The company's enabled installation, share-locked until the caller commits so a
-- concurrent configure waits for in-flight work. Any member may read it.
CREATE FUNCTION platform.address_installation(scope_company uuid)
RETURNS TABLE (installation_id uuid, account text, provider text, enrichment boolean,
  period_calls integer, period_budget_micros bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NOT north_star_internal.address_member(scope_company) THEN RETURN; END IF;
  RETURN QUERY SELECT i.installation_id, i.account, i.provider, i.enrichment, i.period_calls, i.period_budget_micros
    FROM platform.address_installations i
   WHERE i.tenant_id = north_star_internal.trusted_tenant_id()
     AND i.environment_id = north_star_internal.trusted_environment_id()
     AND i.company_id = scope_company AND i.enabled
     FOR SHARE; END $$;

-- The single entry point that enables, reconfigures, switches or pauses a
-- company's provider. SIGNIN-1 slice 2b joins its passkey decision proof here.
-- Lock order: the company's advisory key, then its installation rows.
CREATE FUNCTION platform.address_configure(scope_company uuid, requested_provider text,
  requested_account text, requested_enrichment boolean, requested_calls integer,
  requested_budget bigint, requested_enabled boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  tenant uuid := north_star_internal.trusted_tenant_id();
  environment uuid := north_star_internal.trusted_environment_id();
  principal uuid := north_star_internal.address_principal();
  current_id uuid;
  target_id uuid;
  target_enabled boolean;
  chosen uuid; BEGIN
  PERFORM north_star_internal.address_require_read_committed();
  IF tenant IS NULL OR environment IS NULL OR principal IS NULL
     OR NOT north_star_internal.address_may_configure(scope_company) THEN
    RAISE EXCEPTION 'address.configureDenied' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'north_star.address_installation:' || tenant || ':' || environment || ':' || scope_company, 0));
  SELECT i.installation_id INTO current_id FROM platform.address_installations i
   WHERE (i.tenant_id,i.environment_id,i.company_id) = (tenant,environment,scope_company) AND i.enabled
     FOR UPDATE;
  IF NOT requested_enabled THEN
    IF current_id IS NULL THEN RETURN NULL; END IF;
    UPDATE platform.address_installations SET enabled = false
     WHERE (tenant_id,environment_id,company_id,installation_id) = (tenant,environment,scope_company,current_id);
    INSERT INTO platform.address_installation_history(tenant_id,environment_id,company_id,installation_id,principal_id,change)
    VALUES (tenant,environment,scope_company,current_id,principal,'paused');
    RETURN current_id; END IF;
  -- One identity per provider account: its quota and key-file entry survive a
  -- pause, or a switch to another account and back.
  SELECT i.installation_id, i.enabled INTO target_id, target_enabled FROM platform.address_installations i
   WHERE (i.tenant_id,i.environment_id,i.company_id) = (tenant,environment,scope_company)
     AND i.provider = requested_provider AND i.account = requested_account
   ORDER BY i.enabled DESC, (SELECT max(h.recorded_at) FROM platform.address_installation_history h
     WHERE (h.tenant_id,h.environment_id,h.company_id,h.installation_id) =
           (i.tenant_id,i.environment_id,i.company_id,i.installation_id)) DESC NULLS LAST, i.installation_id
   LIMIT 1 FOR UPDATE;
  IF current_id IS NOT NULL AND current_id IS DISTINCT FROM target_id THEN
    UPDATE platform.address_installations SET enabled = false
     WHERE (tenant_id,environment_id,company_id,installation_id) = (tenant,environment,scope_company,current_id);
    INSERT INTO platform.address_installation_history(tenant_id,environment_id,company_id,installation_id,principal_id,change)
    VALUES (tenant,environment,scope_company,current_id,principal,'paused'); END IF;
  IF target_id IS NULL THEN
    chosen := gen_random_uuid();
    INSERT INTO platform.address_installations(tenant_id,environment_id,company_id,installation_id,account,provider,
      enabled,enrichment,period_calls,period_budget_micros)
    VALUES (tenant,environment,scope_company,chosen,requested_account,requested_provider,true,
      requested_enrichment,requested_calls,requested_budget);
  ELSE
    chosen := target_id;
    UPDATE platform.address_installations SET enabled = true, enrichment = requested_enrichment,
      period_calls = requested_calls, period_budget_micros = requested_budget
     WHERE (tenant_id,environment_id,company_id,installation_id) = (tenant,environment,scope_company,chosen); END IF;
  INSERT INTO platform.address_installation_history(tenant_id,environment_id,company_id,installation_id,principal_id,change)
  VALUES (tenant,environment,scope_company,chosen,principal,
    CASE WHEN coalesce(target_enabled, false) THEN 'rotated' ELSE 'enabled' END);
  RETURN chosen; END $$;

-- Queue a geocode for a revision the caller just committed in this transaction.
-- The release, fence and root must be the active pointer's.
CREATE FUNCTION platform.address_enqueue(scope_company uuid, scope_installation uuid, scope_outbox uuid,
  scope_field text, scope_entity text, scope_record uuid, scope_revision uuid, pinned_release uuid, pinned_root text,
  pinned_fence bigint, digest text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF north_star_internal.address_principal() IS NULL
     OR NOT north_star_internal.address_member(scope_company)
     OR NOT EXISTS (SELECT FROM platform.active_release_pointers p
       JOIN platform.tenant_releases r ON (r.tenant_id,r.environment_id,r.release_id) = (p.tenant_id,p.environment_id,p.release_id)
      WHERE (p.tenant_id,p.environment_id) = (north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id())
        AND p.release_id = pinned_release AND p.fence = pinned_fence AND r.content_hash = pinned_root)
  THEN RETURN false; END IF;
  INSERT INTO platform.address_geocodes(tenant_id,environment_id,company_id,installation_id,outbox_id,field_id,entity_id,
    record_id,address_revision,principal_id,release_id,release_root,fence,source_digest)
  SELECT i.tenant_id,i.environment_id,i.company_id,i.installation_id,scope_outbox,scope_field,scope_entity,
    scope_record,scope_revision,north_star_internal.address_principal(),pinned_release,pinned_root,pinned_fence,digest
    FROM platform.address_installations i
   WHERE (i.tenant_id,i.environment_id,i.company_id,i.installation_id) =
         (north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),scope_company,scope_installation)
     AND i.enabled AND i.enrichment;
  RETURN FOUND; END $$;

-- Reserve one call and its cost against the installation's period limits.
CREATE FUNCTION platform.address_reserve(scope_company uuid, scope_installation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  installed platform.address_installations%ROWTYPE;
  cost bigint; BEGIN
  IF NOT north_star_internal.address_member(scope_company) THEN RETURN false; END IF;
  SELECT * INTO installed FROM platform.address_installations i
   WHERE (i.tenant_id,i.environment_id,i.company_id,i.installation_id) =
         (north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),scope_company,scope_installation)
     AND i.enabled FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  cost := CASE installed.provider WHEN 'google' THEN 100000 ELSE 0 END;
  IF cost > installed.period_budget_micros THEN RETURN false; END IF;
  INSERT INTO platform.address_quota AS q (tenant_id,environment_id,company_id,installation_id,period,calls,reserved_micros)
  VALUES (installed.tenant_id,installed.environment_id,installed.company_id,installed.installation_id,
    date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, 1, cost)
  ON CONFLICT (tenant_id,environment_id,company_id,installation_id,period) DO UPDATE
    SET calls = q.calls + 1, reserved_micros = q.reserved_micros + excluded.reserved_micros
  WHERE q.calls < installed.period_calls
    AND q.reserved_micros + excluded.reserved_micros <= installed.period_budget_micros;
  RETURN FOUND; END $$;

CREATE FUNCTION platform.address_usage(scope_company uuid)
RETURNS TABLE (installation_id uuid, period date, calls integer, reserved_micros bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT q.installation_id, q.period, q.calls, q.reserved_micros FROM platform.address_quota q
   WHERE (q.tenant_id,q.environment_id,q.company_id) =
         (north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),scope_company)
     AND north_star_internal.address_member(scope_company)
   ORDER BY q.period, q.installation_id
$$;

-- The caller's own queued jobs only. SKIP LOCKED keeps workers off each other.
CREATE FUNCTION platform.address_claim(scope_claim uuid)
RETURNS TABLE (company_id uuid, installation_id uuid, revision uuid, release_id uuid, entity_id text,
  release_root text, source_digest text, fence bigint, record_id uuid, field_id text, outbox uuid,
  attempts smallint, claim_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH next AS (
    SELECT g.tenant_id,g.environment_id,g.company_id,g.installation_id,g.outbox_id,g.field_id
      FROM platform.address_geocodes g
     WHERE (g.tenant_id,g.environment_id,g.principal_id) = (north_star_internal.trusted_tenant_id(),
           north_star_internal.trusted_environment_id(),north_star_internal.address_principal())
       AND g.state IN ('queued','working') AND g.available_at <= clock_timestamp()
     ORDER BY g.available_at, g.outbox_id FOR UPDATE SKIP LOCKED LIMIT 1)
  UPDATE platform.address_geocodes g SET state = 'working', claim_id = scope_claim,
    available_at = clock_timestamp() + interval '30 seconds'
    FROM next
   WHERE (g.tenant_id,g.environment_id,g.company_id,g.installation_id,g.outbox_id,g.field_id) =
         (next.tenant_id,next.environment_id,next.company_id,next.installation_id,next.outbox_id,next.field_id)
  RETURNING g.company_id,g.installation_id,g.address_revision,g.release_id,g.entity_id,g.release_root,
    g.source_digest,g.fence,g.record_id,g.field_id,g.outbox_id,g.attempts,g.claim_id
$$;

CREATE FUNCTION north_star_internal.address_claimed(scope_company uuid, scope_installation uuid, scope_outbox uuid,
  scope_field text, scope_claim uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT FROM platform.address_geocodes g
   WHERE (g.tenant_id,g.environment_id,g.company_id,g.installation_id,g.outbox_id,g.field_id,g.claim_id,g.principal_id) =
         (north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),scope_company,
          scope_installation,scope_outbox,scope_field,scope_claim,north_star_internal.address_principal()))
$$;

CREATE FUNCTION platform.address_attempt(scope_company uuid, scope_installation uuid, scope_outbox uuid,
  scope_field text, scope_claim uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NOT north_star_internal.address_claimed(scope_company,scope_installation,scope_outbox,scope_field,scope_claim) THEN RETURN false; END IF;
  UPDATE platform.address_geocodes g SET attempts = g.attempts + 1
   WHERE (g.tenant_id,g.environment_id,g.company_id,g.installation_id,g.outbox_id,g.field_id,g.claim_id) =
         (north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),scope_company,
          scope_installation,scope_outbox,scope_field,scope_claim)
     AND g.attempts < 4;
  RETURN FOUND; END $$;

-- Provider coordinates expire 30 days after the job was queued (ADR-0080).
CREATE FUNCTION platform.address_complete(scope_company uuid, scope_installation uuid, scope_outbox uuid,
  scope_field text, scope_claim uuid, located_latitude numeric, located_longitude numeric, located_precision text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NOT north_star_internal.address_claimed(scope_company,scope_installation,scope_outbox,scope_field,scope_claim) THEN RETURN false; END IF;
  UPDATE platform.address_geocodes g SET state = 'ready', claim_id = NULL, reason = NULL,
    latitude = located_latitude, longitude = located_longitude, precision = located_precision,
    expires_at = g.created_at + interval '30 days'
   WHERE (g.tenant_id,g.environment_id,g.company_id,g.installation_id,g.outbox_id,g.field_id,g.claim_id) =
         (north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),scope_company,
          scope_installation,scope_outbox,scope_field,scope_claim);
  RETURN FOUND; END $$;

CREATE FUNCTION platform.address_settle(scope_company uuid, scope_installation uuid, scope_outbox uuid,
  scope_field text, scope_claim uuid, next_state text, next_reason text, next_attempts smallint, delay_seconds integer) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF next_state NOT IN ('queued','held','failed')
     OR NOT north_star_internal.address_claimed(scope_company,scope_installation,scope_outbox,scope_field,scope_claim) THEN RETURN false; END IF;
  UPDATE platform.address_geocodes g SET state = next_state, reason = next_reason, claim_id = NULL,
    attempts = greatest(g.attempts, next_attempts),
    available_at = clock_timestamp() + delay_seconds * interval '1 second'
   WHERE (g.tenant_id,g.environment_id,g.company_id,g.installation_id,g.outbox_id,g.field_id,g.claim_id) =
         (north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),scope_company,
          scope_installation,scope_outbox,scope_field,scope_claim);
  RETURN FOUND; END $$;

-- A pin belongs to its record, field, address revision and installation. A later
-- activation that keeps the field does not hide it; a retired field has no binding.
CREATE FUNCTION platform.address_pin(scope_company uuid, scope_installation uuid, scope_entity text,
  scope_record uuid, scope_field text, scope_revision uuid)
RETURNS TABLE (state text, latitude text, longitude text, usable boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT g.state, g.latitude::text, g.longitude::text, coalesce(g.expires_at > clock_timestamp(), false)
    FROM platform.address_geocodes g
   WHERE g.tenant_id = north_star_internal.trusted_tenant_id()
     AND g.environment_id = north_star_internal.trusted_environment_id()
     AND g.company_id = scope_company
     AND g.installation_id = scope_installation
     AND g.entity_id = scope_entity AND g.record_id = scope_record AND g.field_id = scope_field
     AND g.address_revision = scope_revision
     AND north_star_internal.address_member(scope_company)
$$;

-- Bounded: at most max_rows expired coordinate sets per call, skipping rows a
-- worker holds. The row stays as the job's record, without coordinates.
CREATE FUNCTION platform.address_sweep(max_rows integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE swept integer; BEGIN
  PERFORM north_star_internal.address_require_read_committed();
  IF north_star_internal.trusted_tenant_id() IS NULL OR north_star_internal.trusted_environment_id() IS NULL THEN
    RETURN 0; END IF;
  WITH due AS (
    SELECT g.company_id,g.installation_id,g.outbox_id,g.field_id FROM platform.address_geocodes g
     WHERE (g.tenant_id,g.environment_id) = (north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id())
       AND g.latitude IS NOT NULL
       AND g.expires_at <= clock_timestamp()
     ORDER BY g.expires_at
     LIMIT greatest(least(max_rows, 1000), 0)
     FOR UPDATE SKIP LOCKED)
  UPDATE platform.address_geocodes g SET state = 'failed', reason = 'expired',
    latitude = NULL, longitude = NULL, precision = NULL, expires_at = NULL
    FROM due
   WHERE (g.tenant_id,g.environment_id,g.company_id,g.installation_id,g.outbox_id,g.field_id) =
         (north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),
          due.company_id,due.installation_id,due.outbox_id,due.field_id);
  GET DIAGNOSTICS swept = ROW_COUNT;
  RETURN swept; END $$;

DO $access$
DECLARE routine regprocedure; BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname IN ('north_star_internal','platform') AND left(p.proname,8) = 'address_' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine); END LOOP; END $access$;
GRANT EXECUTE ON FUNCTION platform.address_installations(), platform.address_installation(uuid),
  platform.address_configure(uuid,text,text,boolean,integer,bigint,boolean),
  platform.address_enqueue(uuid,uuid,uuid,text,text,uuid,uuid,uuid,text,bigint,text),
  platform.address_reserve(uuid,uuid), platform.address_usage(uuid), platform.address_claim(uuid),
  platform.address_attempt(uuid,uuid,uuid,text,uuid),
  platform.address_complete(uuid,uuid,uuid,text,uuid,numeric,numeric,text),
  platform.address_settle(uuid,uuid,uuid,text,uuid,text,text,smallint,integer),
  platform.address_pin(uuid,uuid,text,uuid,text,uuid), platform.address_sweep(integer)
  TO north_star_runtime;
