-- SPEED-1 S3 (orchestrator-approved): a policy row moved between scopes bumps
-- both. An UPDATE that changes a role, grant or membership's tenant or
-- environment removed authority from the OLD scope as well as adding it to
-- the NEW one; until now only NEW's epoch moved, so a page holding OLD's
-- grants could pass its live epoch check. Every other branch is unchanged.
CREATE OR REPLACE FUNCTION platform.bump_current_policy_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $$ BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    INSERT INTO platform.current_policy_epochs (
      tenant_id, environment_id, policy_version
    ) VALUES (OLD.tenant_id, OLD.environment_id, 1)
    ON CONFLICT (tenant_id, environment_id)
    DO UPDATE SET policy_version = current_policy_epochs.policy_version + 1,
                  updated_at = transaction_timestamp(); END IF;
  IF TG_OP = 'INSERT' OR (
    TG_OP = 'UPDATE' AND (
      NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
      NEW.environment_id IS DISTINCT FROM OLD.environment_id
    )
  ) THEN
    INSERT INTO platform.current_policy_epochs (
      tenant_id, environment_id, policy_version
    ) VALUES (NEW.tenant_id, NEW.environment_id, 1)
    ON CONFLICT (tenant_id, environment_id)
    DO UPDATE SET policy_version = current_policy_epochs.policy_version + 1,
                  updated_at = transaction_timestamp(); END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD; END IF;
  RETURN NEW; END $$;

REVOKE ALL ON FUNCTION platform.bump_current_policy_epoch() FROM PUBLIC;
