-- Only the database operator can change policy. All workers share one policy.
CREATE TABLE north_star_internal.workflow_start_limits (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  starts_per_hour integer NOT NULL DEFAULT 600 CHECK (starts_per_hour > 0),
  workflow_per_hour integer NOT NULL DEFAULT 120 CHECK (workflow_per_hour > 0),
  runnable integer NOT NULL DEFAULT 200 CHECK (runnable > 0),
  open_runs integer NOT NULL DEFAULT 10000 CHECK (open_runs > 0),
  deferred integer NOT NULL DEFAULT 10000 CHECK (deferred > 0)
);
INSERT INTO north_star_internal.workflow_start_limits DEFAULT VALUES;

-- The immutable instance already identifies the exact event/workflow pair.
-- Keep terminal rows as audit evidence. An overflow is never automatically retried.
CREATE TABLE platform.workflow_deferred_starts (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, instance_id uuid NOT NULL,
  workflow_id text NOT NULL, pointer_id uuid NOT NULL, fence bigint NOT NULL,
  disposition text NOT NULL CHECK (disposition IN
    ('deferred','rate-limit-overflow','started','dismissed','activation-discarded')),
  not_before timestamptz NOT NULL, overflowed_at timestamptz,
  discarded_at_fence bigint, operator_name name, operator_action text, operator_at timestamptz,
  PRIMARY KEY (tenant_id, environment_id, instance_id),
  FOREIGN KEY (tenant_id, environment_id, instance_id, workflow_id)
    REFERENCES platform.workflow_instances (tenant_id, environment_id, instance_id, workflow_id),
  FOREIGN KEY (tenant_id, environment_id, pointer_id, fence)
    REFERENCES platform.workflow_activation_watermarks (tenant_id, environment_id, pointer_id, fence),
  FOREIGN KEY (tenant_id, environment_id, pointer_id, discarded_at_fence)
    REFERENCES platform.workflow_activation_watermarks (tenant_id, environment_id, pointer_id, fence),
  CHECK ((discarded_at_fence IS NOT NULL) = (disposition = 'activation-discarded'))
);
ALTER TABLE platform.workflow_deferred_starts ENABLE ROW LEVEL SECURITY;
CREATE INDEX workflow_deferred_due_idx ON platform.workflow_deferred_starts
  (tenant_id, environment_id, not_before, instance_id) WHERE disposition = 'deferred';
CREATE INDEX workflow_deferred_alert_idx ON platform.workflow_deferred_starts
  (tenant_id, environment_id, instance_id) WHERE disposition = 'rate-limit-overflow';
CREATE INDEX workflow_starts_hour_idx ON platform.workflow_runs (tenant_id, environment_id, created_at);
CREATE INDEX workflow_open_runs_idx ON platform.workflow_runs (tenant_id, environment_id, status)
  WHERE status NOT IN ('COMPLETED','CANCELLED','QUARANTINED');

-- Capacity-wait is an already-started run whose sleep, decision or human retry
-- completed while all runnable slots were occupied. Its pins and journal survive.
ALTER TABLE platform.workflow_runs DROP CONSTRAINT workflow_runs_status_check;
ALTER TABLE platform.workflow_runs ADD CHECK (status IN
  ('RUNNABLE','WAITING','SUSPENDED','QUARANTINED','COMPLETED','CANCELLED','CAPACITY_WAIT'));

CREATE FUNCTION north_star_internal.workflow_limit_key(t uuid, e uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp
AS $$ SELECT hashtextextended('northstar.workflow-capacity/v1:' || t::text || '/' || e::text, 0) $$;
REVOKE ALL ON FUNCTION north_star_internal.workflow_limit_key(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION north_star_internal.workflow_limit_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  limits north_star_internal.workflow_start_limits%ROWTYPE;
  previous text;
  active integer;
  open_count integer;
  started integer;
  own_started integer;
  oldest timestamptz;
  own_oldest timestamptz;
  at_time timestamptz;
  retry_at timestamptz;
  overflow boolean;
  key bigint := north_star_internal.workflow_limit_key(NEW.tenant_id, NEW.environment_id); BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'workflow capacity requires read committed'; END IF;
  IF TG_OP = 'INSERT' AND (NEW.tenant_id, NEW.environment_id) IS DISTINCT FROM
     (north_star_internal.trusted_tenant_id(), north_star_internal.trusted_environment_id()) THEN
    RAISE EXCEPTION 'workflow capacity scope mismatch'; END IF;
  SELECT * INTO STRICT limits FROM north_star_internal.workflow_start_limits;
  IF TG_OP = 'UPDATE' THEN
    -- The waking writer already holds a run lock. Never wait here for the
    -- capacity lock held by a consumer promoting another ready run.
    IF NOT pg_try_advisory_xact_lock(key) THEN
      NEW.status := 'CAPACITY_WAIT'; RETURN NEW; END IF;
    -- A fresh READ COMMITTED snapshot after taking the lock sees the preceding wake.
    IF (SELECT count(*) FROM platform.workflow_runs WHERE
        (tenant_id, environment_id, status) = (NEW.tenant_id, NEW.environment_id, 'RUNNABLE')) >= limits.runnable
    THEN NEW.status := 'CAPACITY_WAIT'; END IF;
    RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(key);
  IF EXISTS (SELECT FROM platform.workflow_runs WHERE
      (tenant_id,environment_id,instance_id) = (NEW.tenant_id,NEW.environment_id,NEW.instance_id)) THEN
    -- Let the existing unique constraint reject a duplicate even at capacity.
    RETURN NEW; END IF;
  at_time := clock_timestamp();
  SELECT disposition INTO previous FROM platform.workflow_deferred_starts
    WHERE (tenant_id,environment_id,instance_id) = (NEW.tenant_id,NEW.environment_id,NEW.instance_id);
  IF previous IS NOT NULL AND NOT EXISTS (
    SELECT FROM platform.workflow_deferred_starts q
    WHERE (q.tenant_id,q.environment_id,q.instance_id,q.workflow_id,q.pointer_id,q.fence) =
      (NEW.tenant_id,NEW.environment_id,NEW.instance_id,NEW.workflow_id,NEW.pointer_id,NEW.initial_fence)
      AND q.disposition='deferred' AND q.not_before <= at_time
  ) THEN RETURN NULL; END IF;

  SELECT count(*), count(*) FILTER (WHERE status = 'RUNNABLE') INTO open_count, active
    FROM platform.workflow_runs WHERE (tenant_id,environment_id) = (NEW.tenant_id,NEW.environment_id)
      AND status NOT IN ('COMPLETED','CANCELLED','QUARANTINED');
  SELECT count(*), min(created_at), count(*) FILTER (WHERE workflow_id = NEW.workflow_id),
         min(created_at) FILTER (WHERE workflow_id = NEW.workflow_id)
    INTO started, oldest, own_started, own_oldest
    FROM platform.workflow_runs WHERE (tenant_id,environment_id) = (NEW.tenant_id,NEW.environment_id)
      AND created_at > at_time - interval '1 hour';
  IF active < limits.runnable AND open_count < limits.open_runs AND started < limits.starts_per_hour
     AND own_started < limits.workflow_per_hour THEN
    IF previous = 'deferred' THEN
      UPDATE platform.workflow_deferred_starts SET disposition = 'started'
        WHERE (tenant_id,environment_id,instance_id) = (NEW.tenant_id,NEW.environment_id,NEW.instance_id); END IF;
    NEW.created_at := at_time;
    RETURN NEW; END IF;
  retry_at := greatest(at_time + interval '1 second',
    CASE WHEN started >= limits.starts_per_hour THEN oldest + interval '1 hour' END,
    CASE WHEN own_started >= limits.workflow_per_hour THEN own_oldest + interval '1 hour' END);
  IF previous = 'deferred' THEN
    UPDATE platform.workflow_deferred_starts SET not_before = retry_at
      WHERE (tenant_id,environment_id,instance_id) = (NEW.tenant_id,NEW.environment_id,NEW.instance_id);
  ELSE
    SELECT count(*) >= limits.deferred INTO overflow FROM platform.workflow_deferred_starts
      WHERE (tenant_id,environment_id) = (NEW.tenant_id,NEW.environment_id) AND disposition = 'deferred';
    INSERT INTO platform.workflow_deferred_starts
      (tenant_id,environment_id,instance_id,workflow_id,pointer_id,fence,disposition,not_before,overflowed_at)
    VALUES (NEW.tenant_id,NEW.environment_id,NEW.instance_id,NEW.workflow_id,NEW.pointer_id,NEW.initial_fence,
      CASE WHEN overflow THEN 'rate-limit-overflow' ELSE 'deferred' END,retry_at,CASE WHEN overflow THEN at_time END); END IF;
  RETURN NULL; END $$;
REVOKE ALL ON FUNCTION north_star_internal.workflow_limit_run() FROM PUBLIC;
CREATE TRIGGER workflow_limit_start BEFORE INSERT ON platform.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION north_star_internal.workflow_limit_run();
CREATE TRIGGER workflow_limit_wake BEFORE UPDATE OF status ON platform.workflow_runs
  FOR EACH ROW WHEN (NEW.status = 'RUNNABLE' AND OLD.status <> 'RUNNABLE')
  EXECUTE FUNCTION north_star_internal.workflow_limit_run();

-- Called under the consumer's scope lock and shared pointer lock. Derive every
-- pin from the currently verified watermark, even after a worker restart.
CREATE FUNCTION platform.workflow_resume_capacity() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t uuid := north_star_internal.trusted_tenant_id();
  e uuid := north_star_internal.trusted_environment_id();
  p platform.active_release_pointers%ROWTYPE;
  started integer; BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'workflow capacity requires read committed'; END IF;
  SELECT * INTO p FROM platform.active_release_pointers WHERE (tenant_id,environment_id)=(t,e) FOR SHARE;
  IF NOT FOUND THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(north_star_internal.workflow_limit_key(t,e));
  WITH ready AS (
    SELECT run_id FROM platform.workflow_runs WHERE (tenant_id,environment_id,status)=(t,e,'CAPACITY_WAIT')
    ORDER BY poll_order,created_at,run_id LIMIT 16 FOR UPDATE SKIP LOCKED
  ) UPDATE platform.workflow_runs r SET
    status = CASE WHEN (r.pointer_id,r.execution_fence,r.release_id)=(p.pointer_id,p.fence,p.release_id)
             THEN 'RUNNABLE' ELSE 'SUSPENDED' END,
    reason = CASE WHEN (r.pointer_id,r.execution_fence,r.release_id)<>(p.pointer_id,p.fence,p.release_id)
             THEN 'stale-release-pin' END,
    poll_order = nextval('platform.workflow_run_poll_order')
    FROM ready WHERE (r.tenant_id,r.environment_id,r.run_id)=(t,e,ready.run_id);
  INSERT INTO platform.workflow_runs (tenant_id,environment_id,run_id,instance_id,workflow_id,
                                     pointer_id,release_id,release_root,initial_fence,execution_fence)
    SELECT t,e,gen_random_uuid(),q.instance_id,q.workflow_id,p.pointer_id,p.release_id,w.release_root,p.fence,p.fence
    FROM platform.workflow_deferred_starts q
    JOIN platform.workflow_activation_watermarks w USING (tenant_id,environment_id,pointer_id,fence)
    JOIN platform.workflow_definitions d USING (tenant_id,environment_id,release_id,workflow_id)
    WHERE (q.tenant_id,q.environment_id,q.pointer_id,q.fence)=(t,e,p.pointer_id,p.fence)
      AND w.release_id=p.release_id AND w.verified_approval_binding
      AND w.definition_bindings->q.workflow_id->>'digest'=platform.workflow_definition_digest(d)
      AND q.disposition='deferred' AND q.not_before <= statement_timestamp()
    ORDER BY q.not_before,q.instance_id LIMIT 64;
  GET DIAGNOSTICS started = ROW_COUNT;
  RETURN started; END $$;
REVOKE ALL ON FUNCTION platform.workflow_resume_capacity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_resume_capacity() TO north_star_workflow_worker;

-- Each discarded row names its verification fence. These rows are the exact
-- activation count, including activation of an empty workflow set.
CREATE FUNCTION north_star_internal.workflow_discard_starts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  UPDATE platform.workflow_deferred_starts SET disposition='activation-discarded',discarded_at_fence=NEW.fence
  WHERE (tenant_id,environment_id,pointer_id)=(NEW.tenant_id,NEW.environment_id,NEW.pointer_id)
    AND fence < NEW.fence AND disposition IN ('deferred','rate-limit-overflow');
  RETURN NEW; END $$;
REVOKE ALL ON FUNCTION north_star_internal.workflow_discard_starts() FROM PUBLIC;
CREATE TRIGGER workflow_discard_starts AFTER INSERT ON platform.workflow_activation_watermarks
  FOR EACH ROW EXECUTE FUNCTION north_star_internal.workflow_discard_starts();

CREATE FUNCTION platform.workflow_waiting_starts()
RETURNS TABLE (instance_id uuid,workflow_id text,disposition text,not_before timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT q.instance_id,q.workflow_id,q.disposition,q.not_before FROM platform.workflow_deferred_starts q
  WHERE (q.tenant_id,q.environment_id)=(north_star_internal.trusted_tenant_id(),north_star_internal.trusted_environment_id())
    AND q.disposition IN ('deferred','rate-limit-overflow')
  ORDER BY (q.disposition='rate-limit-overflow') DESC,q.not_before,q.instance_id LIMIT 100
$$;
REVOKE ALL ON FUNCTION platform.workflow_waiting_starts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.workflow_waiting_starts() TO north_star_workflow_worker;

-- A platform operator can requeue or dismiss an exact waiting start. Runtime
-- roles have no execute grant. Releasing still observes every budget at admission.
CREATE FUNCTION north_star_internal.workflow_manage_start(t uuid,e uuid,id uuid,action text) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE p platform.active_release_pointers%ROWTYPE; q platform.workflow_deferred_starts%ROWTYPE; BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'workflow capacity requires read committed'; END IF;
  IF action IS NULL OR action NOT IN ('release','dismiss') THEN RETURN false; END IF;
  SELECT * INTO STRICT p FROM platform.active_release_pointers WHERE (tenant_id,environment_id)=(t,e) FOR SHARE;
  PERFORM pg_advisory_xact_lock(north_star_internal.workflow_limit_key(t,e));
  SELECT * INTO q FROM platform.workflow_deferred_starts WHERE (tenant_id,environment_id,instance_id)=(t,e,id)
    AND (pointer_id,fence)=(p.pointer_id,p.fence) AND disposition IN ('deferred','rate-limit-overflow') FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF action='release' AND q.disposition='rate-limit-overflow' AND
    (SELECT count(*) FROM platform.workflow_deferred_starts WHERE (tenant_id,environment_id)=(t,e)
      AND disposition='deferred') >= (SELECT deferred FROM north_star_internal.workflow_start_limits)
    THEN RETURN false; END IF;
  UPDATE platform.workflow_deferred_starts SET disposition=CASE action WHEN 'release' THEN 'deferred' ELSE 'dismissed' END,
    not_before=clock_timestamp(),operator_name=session_user,operator_action=action,operator_at=clock_timestamp()
    WHERE (tenant_id,environment_id,instance_id)=(t,e,id);
  RETURN true; END $$;
REVOKE ALL ON FUNCTION north_star_internal.workflow_manage_start(uuid,uuid,uuid,text) FROM PUBLIC;
