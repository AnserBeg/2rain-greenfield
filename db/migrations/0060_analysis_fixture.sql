-- The fixture controller and operator are separate trusted hosts. The guest and
-- the ERP runtime have no credentials or table grants on the fixture stores.
CREATE ROLE north_star_analysis_controller LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE north_star_analysis_operator LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

CREATE TABLE platform.analysis_runs (
  job uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, environment_id uuid NOT NULL,
  company uuid NOT NULL, person uuid NOT NULL, request_key uuid NOT NULL,
  image text NOT NULL CHECK (image ~ '^sha256:[0-9a-f]{64}$'), host text NOT NULL,
  boot uuid NOT NULL, queued_tick bigint NOT NULL CHECK (queued_tick >= 0),
  queue_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE, dispatched_sequence bigint,
  status text NOT NULL CHECK (status IN ('queued','reserved','stopping','success','scriptFailure','hostFailure','refused','cancelled','expired')),
  receipt jsonb, UNIQUE(tenant_id,environment_id,request_key), UNIQUE(tenant_id,job),
  FOREIGN KEY(tenant_id,environment_id) REFERENCES platform.environments(tenant_id,id)
);
CREATE TABLE platform.analysis_leases (
  job uuid PRIMARY KEY, tenant_id uuid NOT NULL, host text NOT NULL,
  memory_bytes bigint NOT NULL CHECK (memory_bytes=2147483648), stop_generation bigint NOT NULL,
  released_at timestamptz, FOREIGN KEY(tenant_id,job) REFERENCES platform.analysis_runs(tenant_id,job)
);
CREATE TABLE platform.analysis_budget_counters (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, utc_day date NOT NULL, subject text NOT NULL,
  starts integer NOT NULL CHECK (starts >= 0), PRIMARY KEY(tenant_id,environment_id,utc_day,subject),
  FOREIGN KEY(tenant_id,environment_id) REFERENCES platform.environments(tenant_id,id)
);
CREATE TABLE platform.analysis_reservations (
  job uuid PRIMARY KEY, tenant_id uuid NOT NULL, utc_day date NOT NULL,
  disposition text NOT NULL CHECK(disposition IN ('held','charged','refunded')),
  FOREIGN KEY(tenant_id,job) REFERENCES platform.analysis_runs(tenant_id,job)
);
CREATE TABLE platform.analysis_run_controls (
  tenant_id uuid PRIMARY KEY REFERENCES platform.tenants(id), disabled boolean NOT NULL,
  generation bigint NOT NULL CHECK (generation>0)
);
CREATE TABLE north_star_internal.analysis_operator_controls (
  scope text PRIMARY KEY CHECK (scope='global' OR scope ~ '^image/sha256:[0-9a-f]{64}$'),
  disabled boolean NOT NULL, generation bigint NOT NULL CHECK (generation>0)
);
REVOKE ALL ON platform.analysis_runs,platform.analysis_leases,platform.analysis_budget_counters,
  platform.analysis_reservations,platform.analysis_run_controls,north_star_internal.analysis_operator_controls FROM PUBLIC,north_star_runtime;

-- One dispatch mutex orders host slots, tenant_id/environment_id counters, person
-- counters, reservations and leases across environments. Read committed sees
-- changes committed by a writer we waited for on the mutex.
CREATE FUNCTION north_star_internal.analysis_lock() RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'analysis.requiresReadCommitted'; END IF;
  PERFORM pg_advisory_xact_lock(167446105, 1); END $$;

CREATE FUNCTION north_star_internal.analysis_permitted(company uuid, permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT FROM platform.current_policy_memberships m
    JOIN platform.current_policy_roles r USING (tenant_id,environment_id,role_id)
    JOIN platform.current_policy_permission_grants g USING (tenant_id,environment_id,role_id)
    WHERE (m.tenant_id,m.environment_id,m.principal_id)=(north_star_internal.trusted_tenant_id(),
      north_star_internal.trusted_environment_id(),nullif(current_setting('north_star.principal_id',true),'')::uuid)
      AND (m.legal_entity_id IS NULL OR m.legal_entity_id=company)
      AND m.revoked_at IS NULL AND r.revoked_at IS NULL AND g.revoked_at IS NULL
      AND g.permission_id=permission AND g.resource_id='northstar.runtime:analysis.fixture')
$$;

CREATE FUNCTION north_star_internal.analysis_controls(t uuid, digest text,
  OUT disabled boolean, OUT generation bigint) LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(bool_or(c.disabled),false),coalesce(sum(c.generation),0)::bigint
    FROM (SELECT disabled,generation FROM platform.analysis_run_controls WHERE tenant_id=t
      UNION ALL SELECT disabled,generation FROM north_star_internal.analysis_operator_controls
        WHERE scope IN ('global','image/'||digest)) c
$$;

CREATE FUNCTION platform.analysis_enqueue(company_id uuid, key uuid, digest text, runner text, clock_boot uuid, tick bigint)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id();
  p uuid := nullif(current_setting('north_star.principal_id',true),'')::uuid; existing platform.analysis_runs; id uuid; BEGIN
  PERFORM north_star_internal.analysis_lock();
  IF NOT north_star_internal.analysis_permitted(company_id,'northstar.runtime:permission.analysis_run') THEN RAISE EXCEPTION 'analysis.denied'; END IF;
  SELECT * INTO existing FROM platform.analysis_runs WHERE (tenant_id,environment_id,request_key)=(t,e,key);
  IF FOUND THEN
    IF (existing.person,existing.company,existing.image,existing.host) IS DISTINCT FROM (p,company_id,digest,runner)
    THEN RAISE EXCEPTION 'analysis.denied'; END IF;
    RETURN existing.job; END IF;
  IF (SELECT disabled FROM north_star_internal.analysis_controls(t,digest)) THEN RAISE EXCEPTION 'analysis.stopped'; END IF;
  UPDATE platform.analysis_runs SET status='expired' WHERE host=runner AND status='queued'
    AND (boot<>clock_boot OR tick-queued_tick>=30000);
  IF (SELECT count(*) FROM platform.analysis_runs WHERE status='queued' AND host=runner)>=8
    OR (SELECT count(*) FROM platform.analysis_runs WHERE status='queued' AND host=runner AND tenant_id=t)>=2
  THEN RAISE EXCEPTION 'analysis.queueFull'; END IF;
  INSERT INTO platform.analysis_runs(tenant_id,environment_id,company,person,request_key,image,host,boot,queued_tick,status)
    VALUES(t,e,company_id,p,key,digest,runner,clock_boot,tick,'queued') RETURNING job INTO id;
  RETURN id; END $$;

CREATE FUNCTION platform.analysis_dispatch(runner text, clock_boot uuid, tick bigint, available bigint, slots integer, shared boolean)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE candidate platform.analysis_runs; day date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  gen bigint; consumption bigint; subject_id text; BEGIN
  PERFORM north_star_internal.analysis_lock();
  IF slots IS NULL OR shared IS NULL OR (shared AND slots<2) OR (NOT shared AND slots<>1)
    OR available IS NULL OR clock_boot IS NULL OR tick IS NULL THEN RAISE EXCEPTION 'analysis.hostConfiguration'; END IF;
  UPDATE platform.analysis_runs SET status='expired' WHERE host=runner AND status='queued'
    AND (boot<>clock_boot OR tick-queued_tick>=30000);
  SELECT coalesce(sum(memory_bytes),0) INTO consumption FROM platform.analysis_leases WHERE host=runner AND released_at IS NULL;
  IF (SELECT count(*) FROM platform.analysis_leases WHERE host=runner AND released_at IS NULL)>=slots OR
    available-consumption-2147483648 < 2147483648 THEN RETURN NULL; END IF;
  FOR candidate IN SELECT q.* FROM platform.analysis_runs q WHERE q.host=runner AND q.status='queued'
    AND NOT EXISTS(SELECT FROM platform.analysis_leases l JOIN platform.analysis_runs a USING(job)
      WHERE l.released_at IS NULL AND a.tenant_id=q.tenant_id AND (a.person=q.person OR (shared AND l.host=runner)))
    ORDER BY coalesce((SELECT max(a.dispatched_sequence) FROM platform.analysis_runs a
      WHERE a.host=runner AND a.tenant_id=q.tenant_id),0),q.queue_sequence LOOP
    IF (SELECT disabled FROM north_star_internal.analysis_controls(candidate.tenant_id,candidate.image)) THEN
      UPDATE platform.analysis_runs SET status='cancelled' WHERE job=candidate.job; CONTINUE; END IF;
    IF EXISTS (SELECT FROM platform.analysis_budget_counters b WHERE
      (b.tenant_id,b.environment_id,b.utc_day)=(candidate.tenant_id,candidate.environment_id,day)
      AND ((b.subject='tenant' AND b.starts>=90) OR (b.subject=candidate.person::text AND b.starts>=18))) THEN
      UPDATE platform.analysis_runs SET status='refused' WHERE job=candidate.job; CONTINUE; END IF;
    FOREACH subject_id IN ARRAY ARRAY['tenant',candidate.person::text] LOOP
      INSERT INTO platform.analysis_budget_counters VALUES(candidate.tenant_id,candidate.environment_id,day,subject_id,1)
        ON CONFLICT(tenant_id,environment_id,utc_day,subject) DO UPDATE SET starts=platform.analysis_budget_counters.starts+1; END LOOP;
    SELECT generation INTO gen FROM north_star_internal.analysis_controls(candidate.tenant_id,candidate.image);
    INSERT INTO platform.analysis_reservations(job,tenant_id,utc_day,disposition) VALUES(candidate.job,candidate.tenant_id,day,'held');
    UPDATE platform.analysis_runs SET status='reserved',dispatched_sequence=(
      SELECT coalesce(max(dispatched_sequence),0)+1 FROM platform.analysis_runs WHERE host=runner) WHERE job=candidate.job;
    INSERT INTO platform.analysis_leases(job,tenant_id,host,memory_bytes,stop_generation) VALUES(candidate.job,candidate.tenant_id,runner,2147483648,gen);
    RETURN candidate.job; END LOOP;
  RETURN NULL; END $$;

CREATE FUNCTION platform.analysis_settle(id uuid, outcome text, launched boolean, result jsonb)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r platform.analysis_runs; d date; gen bigint; held bigint; subject_id text; final_status text; BEGIN
  PERFORM north_star_internal.analysis_lock();
  SELECT * INTO STRICT r FROM platform.analysis_runs WHERE job=id;
  IF r.status NOT IN ('reserved','stopping') THEN RETURN r.status; END IF;
  IF outcome IS NULL OR launched IS NULL OR outcome NOT IN ('success','scriptFailure','hostFailure','refused','cancelled')
    OR (outcome='refused' AND launched) OR (outcome IN ('success','scriptFailure') AND NOT launched) OR (outcome='success' AND result IS NULL)
  THEN RAISE EXCEPTION 'analysis.badSettlement'; END IF;
  IF outcome='success' AND result->'run'->'profile'->>'image' IS DISTINCT FROM r.image THEN
    RAISE EXCEPTION 'analysis.imageMismatch'; END IF;
  SELECT generation INTO gen FROM north_star_internal.analysis_controls(r.tenant_id,r.image);
  SELECT stop_generation INTO STRICT held FROM platform.analysis_leases WHERE job=id AND released_at IS NULL;
  final_status := CASE WHEN r.status='stopping' OR gen<>held THEN 'cancelled' ELSE outcome END;
  IF NOT launched OR outcome='hostFailure' THEN
    SELECT utc_day INTO STRICT d FROM platform.analysis_reservations WHERE job=id AND disposition='held';
    FOREACH subject_id IN ARRAY ARRAY['tenant',r.person::text] LOOP
      UPDATE platform.analysis_budget_counters SET starts=starts-1 WHERE
        (tenant_id,environment_id,utc_day,subject)=(r.tenant_id,r.environment_id,d,subject_id);
      IF NOT FOUND THEN RAISE EXCEPTION 'analysis.missingCounter'; END IF; END LOOP;
    UPDATE platform.analysis_reservations SET disposition='refunded' WHERE job=id;
  ELSE UPDATE platform.analysis_reservations SET disposition='charged' WHERE job=id; END IF;
  UPDATE platform.analysis_runs SET status=final_status,receipt=CASE WHEN final_status='success' THEN result END WHERE job=id;
  UPDATE platform.analysis_leases SET released_at=clock_timestamp() WHERE job=id AND released_at IS NULL;
  RETURN final_status; END $$;

CREATE FUNCTION north_star_internal.analysis_switch(target text, stop boolean) RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  PERFORM north_star_internal.analysis_lock();
  IF target LIKE 'tenant/%' THEN
    INSERT INTO platform.analysis_run_controls(tenant_id,disabled,generation)
      SELECT substr(target,8)::uuid,stop,1 WHERE stop OR EXISTS
        (SELECT FROM platform.analysis_run_controls WHERE tenant_id=substr(target,8)::uuid)
      ON CONFLICT(tenant_id) DO UPDATE SET disabled=excluded.disabled,generation=platform.analysis_run_controls.generation+1
      WHERE platform.analysis_run_controls.disabled IS DISTINCT FROM excluded.disabled;
  ELSE
    INSERT INTO north_star_internal.analysis_operator_controls(scope,disabled,generation)
      SELECT target,stop,1 WHERE stop OR EXISTS (SELECT FROM north_star_internal.analysis_operator_controls WHERE scope=target)
      ON CONFLICT(scope) DO UPDATE SET disabled=excluded.disabled,generation=north_star_internal.analysis_operator_controls.generation+1
      WHERE north_star_internal.analysis_operator_controls.disabled IS DISTINCT FROM excluded.disabled;
  END IF;
  IF stop THEN
    UPDATE platform.analysis_runs SET status='cancelled' WHERE status='queued' AND target IN ('global','tenant/'||tenant_id,'image/'||image);
    RETURN QUERY UPDATE platform.analysis_runs SET status='stopping' WHERE status IN ('reserved','stopping')
      AND target IN ('global','tenant/'||tenant_id,'image/'||image) RETURNING job; END IF; END $$;

CREATE FUNCTION platform.analysis_operator_switch(target text, stop boolean) RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF target<>'global' AND target !~ '^image/sha256:[0-9a-f]{64}$' THEN RAISE EXCEPTION 'analysis.badSwitch'; END IF;
  RETURN QUERY SELECT * FROM north_star_internal.analysis_switch(target,stop); END $$;

CREATE FUNCTION platform.analysis_tenant_switch(stop boolean) RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  -- A company-limited membership cannot stop a whole tenant.
  IF NOT north_star_internal.analysis_permitted(NULL,'northstar.runtime:permission.analysis_admin') THEN RAISE EXCEPTION 'analysis.denied'; END IF;
  RETURN QUERY SELECT * FROM north_star_internal.analysis_switch('tenant/'||north_star_internal.trusted_tenant_id(),stop); END $$;

CREATE FUNCTION platform.analysis_result(id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('status',r.status,'receipt',r.receipt) FROM platform.analysis_runs r WHERE r.job=id
    AND (r.tenant_id,r.environment_id,r.person)=(north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id(),
       nullif(current_setting('north_star.principal_id',true),'')::uuid) AND north_star_internal.analysis_permitted(r.company,'northstar.runtime:permission.analysis_run')
$$;
CREATE FUNCTION platform.analysis_cancel(id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DECLARE s text; BEGIN
  PERFORM north_star_internal.analysis_lock();
  IF platform.analysis_result(id) IS NULL THEN RAISE EXCEPTION 'analysis.denied'; END IF;
  UPDATE platform.analysis_runs SET status=CASE status WHEN 'queued' THEN 'cancelled'
    WHEN 'reserved' THEN 'stopping' ELSE status END WHERE job=id RETURNING status INTO s;
  RETURN s; END $$;
CREATE FUNCTION platform.analysis_pending(runner text) RETURNS TABLE(job uuid,status text,image text) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$ SELECT l.job,r.status,r.image FROM platform.analysis_leases l
  JOIN platform.analysis_runs r USING (job) WHERE l.host=runner AND l.released_at IS NULL ORDER BY l.job $$;

REVOKE ALL ON FUNCTION north_star_internal.analysis_lock(),north_star_internal.analysis_permitted(uuid,text),
  north_star_internal.analysis_controls(uuid,text),north_star_internal.analysis_switch(text,boolean),
  platform.analysis_enqueue(uuid,uuid,text,text,uuid,bigint),platform.analysis_dispatch(text,uuid,bigint,bigint,integer,boolean),
  platform.analysis_settle(uuid,text,boolean,jsonb),platform.analysis_operator_switch(text,boolean),platform.analysis_tenant_switch(boolean),
  platform.analysis_result(uuid),platform.analysis_cancel(uuid),platform.analysis_pending(text) FROM PUBLIC,north_star_runtime;
GRANT USAGE ON SCHEMA platform TO north_star_analysis_controller,north_star_analysis_operator;
GRANT EXECUTE ON FUNCTION platform.analysis_enqueue(uuid,uuid,text,text,uuid,bigint),platform.analysis_dispatch(text,uuid,bigint,bigint,integer,boolean),
  platform.analysis_settle(uuid,text,boolean,jsonb),platform.analysis_tenant_switch(boolean),platform.analysis_result(uuid),platform.analysis_cancel(uuid),platform.analysis_pending(text)
  TO north_star_analysis_controller;
GRANT EXECUTE ON FUNCTION platform.analysis_operator_switch(text,boolean) TO north_star_analysis_operator;
