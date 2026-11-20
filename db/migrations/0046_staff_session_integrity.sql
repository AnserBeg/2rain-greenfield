-- Only the installer chooses the store mode. The same lock covers both roots.
CREATE TABLE north_star_internal.staff_store_mode (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL CHECK (mode IN ('demo','pilot'))
);
CREATE FUNCTION platform.claim_staff_store_mode(wanted text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('staff-identity-deployment-v1'));
  INSERT INTO north_star_internal.staff_store_mode(mode) VALUES(wanted) ON CONFLICT DO NOTHING;
  IF (SELECT mode FROM north_star_internal.staff_store_mode) IS DISTINCT FROM wanted THEN
    RAISE EXCEPTION 'staff identity requires a dedicated % database', wanted; END IF; END $$;
REVOKE ALL ON FUNCTION platform.claim_staff_store_mode(text) FROM PUBLIC;
-- Adopt existing stores, refusing a store with both kinds of identity.
DO $$ BEGIN
  IF EXISTS (SELECT FROM platform.staff_relying_parties) THEN
    PERFORM platform.claim_staff_store_mode('pilot'); END IF;
  IF EXISTS (SELECT FROM platform.current_policy_roles WHERE role_key LIKE 'local-demo-%') THEN
    PERFORM platform.claim_staff_store_mode('demo'); END IF; END $$;

REVOKE UPDATE ON platform.staff_credentials, platform.staff_accounts FROM north_star_identity;
GRANT UPDATE (sign_count,backed_up,revoked_at) ON platform.staff_credentials TO north_star_identity;
GRANT UPDATE (status,decisions_after) ON platform.staff_accounts TO north_star_identity;
ALTER ROLE north_star_identity SET log_error_verbosity = 'terse';
ALTER ROLE north_star_identity SET log_parameter_max_length_on_error = 0;
ALTER ROLE north_star_identity SET log_parameter_max_length = 0;

-- A refused operation may roll back. Sequence updates survive that rollback
-- and are visible across snapshots. Serialize just the sampling operation.
CREATE SEQUENCE north_star_internal.staff_clock_microseconds;
CREATE FUNCTION platform.staff_observed_time() RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  guard bigint := hashtextextended('staff-clock-v1', 0);
  sample timestamptz;
  micros bigint;
  floor_us bigint; BEGIN
  PERFORM pg_advisory_lock(guard); BEGIN
    sample := clock_timestamp();
    micros := (extract(epoch FROM sample) * 1000000)::bigint;
    SELECT last_value INTO floor_us FROM north_star_internal.staff_clock_microseconds;
    IF micros < floor_us THEN
      sample := NULL;
    ELSE
      PERFORM setval('north_star_internal.staff_clock_microseconds', micros); END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    PERFORM pg_advisory_unlock(guard);
    RAISE; END;
  PERFORM pg_advisory_unlock(guard);
  RETURN sample; END $$;
REVOKE ALL ON FUNCTION platform.staff_observed_time() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_observed_time() TO north_star_identity,north_star_runtime;

CREATE OR REPLACE FUNCTION platform.staff_session_principal(t uuid,e uuid,handle bytea,protected_write boolean,foreground boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE p uuid; s platform.staff_sessions%ROWTYPE; observed timestamptz; BEGIN
  SELECT principal_id INTO p FROM platform.staff_sessions
    WHERE tenant_id=t AND environment_id=e AND application_digest=handle;
  IF protected_write THEN
    PERFORM 1 FROM platform.staff_accounts WHERE tenant_id=t AND environment_id=e AND principal_id=p
      AND status='active' FOR SHARE;
  ELSE
    PERFORM 1 FROM platform.staff_accounts WHERE tenant_id=t AND environment_id=e AND principal_id=p
      AND status='active'; END IF;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF protected_write THEN
    SELECT * INTO s FROM platform.staff_sessions WHERE tenant_id=t AND environment_id=e AND application_digest=handle FOR UPDATE;
  ELSE
    SELECT * INTO s FROM platform.staff_sessions WHERE tenant_id=t AND environment_id=e AND application_digest=handle; END IF;
  observed := platform.staff_observed_time();
  IF NOT FOUND OR s.revoked_at IS NOT NULL OR observed IS NULL OR observed < s.last_activity
      OR observed >= LEAST(s.absolute_deadline,s.last_activity + interval '30 minutes')
      OR NOT EXISTS (SELECT FROM platform.current_policy_memberships m JOIN platform.current_policy_roles r
        USING(tenant_id,environment_id,role_id) WHERE m.tenant_id=t AND m.environment_id=e
        AND m.principal_id=p AND m.revoked_at IS NULL AND r.revoked_at IS NULL) THEN RETURN NULL; END IF;
  IF protected_write AND foreground AND observed >= s.last_activity + interval '1 minute' THEN
    UPDATE platform.staff_sessions SET last_activity=observed WHERE family_id=s.family_id; END IF;
  RETURN p; END $$;

CREATE TABLE platform.staff_login_transactions (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL,
  binding bytea PRIMARY KEY CHECK (octet_length(binding)=32),
  prior_application_digest bytea, expires_at timestamptz NOT NULL, consumed_at timestamptz,
  FOREIGN KEY (tenant_id,environment_id) REFERENCES platform.environments(tenant_id,id)
);
ALTER TABLE platform.staff_login_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.staff_login_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_scope ON platform.staff_login_transactions TO north_star_identity
  USING (tenant_id=nullif(current_setting('north_star.tenant_id',true),'')::uuid
    AND environment_id=nullif(current_setting('north_star.environment_id',true),'')::uuid);
GRANT SELECT, UPDATE (consumed_at) ON platform.staff_login_transactions TO north_star_identity;

CREATE FUNCTION platform.staff_start_login(t uuid,e uuid,b bytea,prior bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE observed timestamptz; BEGIN
  IF NOT EXISTS (SELECT FROM platform.staff_relying_parties WHERE tenant_id=t AND environment_id=e) THEN
    RAISE EXCEPTION 'staff realm unavailable'; END IF;
  IF prior IS NOT NULL AND platform.staff_session_principal(t,e,prior,false,false) IS NULL THEN
    prior := NULL; END IF;
  observed := platform.staff_observed_time();
  INSERT INTO platform.staff_login_transactions(tenant_id,environment_id,binding,prior_application_digest,expires_at)
    VALUES(t,e,b,prior,observed + interval '5 minutes');
  RETURN prior IS NOT NULL; END $$;
REVOKE ALL ON FUNCTION platform.staff_start_login(uuid,uuid,bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_start_login(uuid,uuid,bytea,bytea) TO north_star_runtime;

-- Compare the live permission/resource pairs at their effective company scope.
-- A global grant covers a company grant. The policy epoch fences changes until commit.
CREATE FUNCTION platform.staff_can_manage(t uuid,e uuid,actor uuid,subject uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF actor=subject THEN RETURN false; END IF;
  IF platform.lock_current_policy_epoch(t,e)='0' THEN RETURN false; END IF;
  IF NOT platform.staff_has_role(t,e,actor,'staff-owner') OR EXISTS (
    SELECT FROM platform.current_policy_memberships m JOIN platform.current_policy_roles r
    USING(tenant_id,environment_id,role_id)
    WHERE m.tenant_id=t AND m.environment_id=e AND m.principal_id=subject AND r.role_key='staff-owner'
      AND m.revoked_at IS NULL AND r.revoked_at IS NULL
  ) THEN RETURN false; END IF;
  PERFORM 1 FROM platform.release_activation_authority_epochs WHERE tenant_id=t FOR SHARE;
  RETURN NOT EXISTS (
    WITH grants AS (
      SELECT m.principal_id,m.legal_entity_id,g.permission_id,g.resource_id
      FROM platform.current_policy_memberships m JOIN platform.current_policy_roles r USING(tenant_id,environment_id,role_id)
      JOIN platform.current_policy_permission_grants g USING(tenant_id,environment_id,role_id)
      WHERE m.tenant_id=t AND m.environment_id=e AND m.principal_id IN (actor,subject)
        AND m.revoked_at IS NULL AND r.revoked_at IS NULL AND g.revoked_at IS NULL)
    SELECT FROM grants s WHERE s.principal_id=subject AND NOT EXISTS (
      SELECT FROM grants a WHERE a.principal_id=actor AND a.permission_id=s.permission_id
        AND a.resource_id=s.resource_id AND (a.legal_entity_id IS NULL OR a.legal_entity_id=s.legal_entity_id))
  ) AND NOT EXISTS (
    WITH latest AS (
      SELECT DISTINCT ON (principal_id) principal_id,eligible FROM platform.release_approver_eligibility_events
      WHERE tenant_id=t AND principal_id IN (actor,subject) ORDER BY principal_id,policy_version DESC)
    SELECT FROM latest WHERE principal_id=subject AND eligible AND NOT EXISTS (
      SELECT FROM latest WHERE principal_id=actor AND eligible)
  ) AND NOT EXISTS (
    WITH latest AS (
      SELECT DISTINCT ON (principal_id) principal_id,authorized FROM platform.release_executor_authority_events
      WHERE tenant_id=t AND principal_id IN (actor,subject) ORDER BY principal_id,policy_version DESC)
    SELECT FROM latest WHERE principal_id=subject AND authorized AND NOT EXISTS (
      SELECT FROM latest WHERE principal_id=actor AND authorized)
  ); END $$;
REVOKE ALL ON FUNCTION platform.staff_can_manage(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_can_manage(uuid,uuid,uuid,uuid) TO north_star_identity;
CREATE OR REPLACE FUNCTION platform.staff_disable_memberships(t uuid,e uuid,p uuid,issuer uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NOT platform.staff_can_manage(t,e,issuer,p) THEN RAISE EXCEPTION 'staff deactivation refused'; END IF;
  UPDATE platform.current_policy_memberships SET revoked_at=clock_timestamp()
    WHERE tenant_id=t AND environment_id=e AND principal_id=p AND revoked_at IS NULL; END $$;
