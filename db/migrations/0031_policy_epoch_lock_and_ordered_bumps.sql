-- SPEED-1 fix read (orchestrator-approved; Critical set).
--
-- 1. A moved policy row bumps its two scopes in one canonical order, so two
--    opposite moves (A to B and B to A) cannot each hold one epoch row while
--    waiting for the other's. Inserts, deletes and same-scope updates bump
--    once, as before; a move bumps both.
-- 2. platform.lock_current_policy_epoch: the session's own scope's epoch,
--    read under FOR SHARE, so a write that must not outlive its policy (an
--    aggregate's cached anchor) holds the epoch row until it commits and a
--    concurrent policy change waits behind it. It refuses any scope but the
--    session's trusted one. EXECUTE is granted to north_star_runtime only.
CREATE OR REPLACE FUNCTION platform.bump_current_policy_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $$ DECLARE
  first_tenant uuid;
  first_environment uuid;
  second_tenant uuid;
  second_environment uuid; BEGIN
  IF TG_OP = 'INSERT' THEN
    first_tenant := NEW.tenant_id;
    first_environment := NEW.environment_id;
  ELSIF TG_OP = 'DELETE' OR (
    NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id AND
    NEW.environment_id IS NOT DISTINCT FROM OLD.environment_id
  ) THEN
    first_tenant := OLD.tenant_id;
    first_environment := OLD.environment_id;
  ELSIF (OLD.tenant_id, OLD.environment_id) <
        (NEW.tenant_id, NEW.environment_id) THEN
    first_tenant := OLD.tenant_id;
    first_environment := OLD.environment_id;
    second_tenant := NEW.tenant_id;
    second_environment := NEW.environment_id;
  ELSE
    first_tenant := NEW.tenant_id;
    first_environment := NEW.environment_id;
    second_tenant := OLD.tenant_id;
    second_environment := OLD.environment_id; END IF;
  INSERT INTO platform.current_policy_epochs (
    tenant_id, environment_id, policy_version
  ) VALUES (first_tenant, first_environment, 1)
  ON CONFLICT (tenant_id, environment_id)
  DO UPDATE SET policy_version = current_policy_epochs.policy_version + 1,
                updated_at = transaction_timestamp();
  IF second_tenant IS NOT NULL THEN
    INSERT INTO platform.current_policy_epochs (
      tenant_id, environment_id, policy_version
    ) VALUES (second_tenant, second_environment, 1)
    ON CONFLICT (tenant_id, environment_id)
    DO UPDATE SET policy_version = current_policy_epochs.policy_version + 1,
                  updated_at = transaction_timestamp(); END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD; END IF;
  RETURN NEW; END $$;

REVOKE ALL ON FUNCTION platform.bump_current_policy_epoch() FROM PUBLIC;

CREATE FUNCTION platform.lock_current_policy_epoch(
  requested_tenant_id uuid,
  requested_environment_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $$ DECLARE
  locked_version text; BEGIN
  IF requested_tenant_id IS DISTINCT FROM
       nullif(current_setting('north_star.tenant_id', true), '')::uuid OR
     requested_environment_id IS DISTINCT FROM
       nullif(current_setting('north_star.environment_id', true), '')::uuid THEN
    RAISE EXCEPTION 'current policy epoch scope must be the trusted session scope'
      USING ERRCODE = '42501'; END IF;
  SELECT epoch.policy_version::text INTO locked_version
    FROM platform.current_policy_epochs AS epoch
   WHERE epoch.tenant_id = requested_tenant_id
     AND epoch.environment_id = requested_environment_id
   FOR SHARE;
  RETURN coalesce(locked_version, '0'); END $$;

REVOKE ALL ON FUNCTION platform.lock_current_policy_epoch(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.lock_current_policy_epoch(uuid, uuid)
  TO north_star_runtime;
