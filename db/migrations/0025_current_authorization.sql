CREATE TABLE platform.current_policy_epochs (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  policy_version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id),
  CONSTRAINT current_policy_epochs_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT current_policy_epochs_version_positive CHECK (policy_version > 0)
);

CREATE TABLE platform.current_policy_roles (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  role_id uuid NOT NULL,
  role_key text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, role_id),
  CONSTRAINT current_policy_roles_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT current_policy_roles_key_nonblank CHECK (btrim(role_key) <> ''),
  CONSTRAINT current_policy_roles_key_unique
    UNIQUE (tenant_id, environment_id, role_key)
);

CREATE TABLE platform.current_policy_permission_grants (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_id text NOT NULL,
  resource_id text NOT NULL,
  revoked_at timestamptz,
  granted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, role_id, permission_id),
  CONSTRAINT current_policy_permission_grants_role_fkey
    FOREIGN KEY (tenant_id, environment_id, role_id)
    REFERENCES platform.current_policy_roles (tenant_id, environment_id, role_id),
  CONSTRAINT current_policy_permission_grants_shape CHECK (
    permission_id ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*([._-][a-z0-9]+)*$'
    AND resource_id ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*([._-][a-z0-9]+)*$'
  )
);

CREATE TABLE platform.current_policy_memberships (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  role_id uuid NOT NULL,
  legal_entity_id uuid,
  revoked_at timestamptz,
  granted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, membership_id),
  CONSTRAINT current_policy_memberships_role_fkey
    FOREIGN KEY (tenant_id, environment_id, role_id)
    REFERENCES platform.current_policy_roles (tenant_id, environment_id, role_id)
);
CREATE UNIQUE INDEX current_policy_memberships_scope_unique
  ON platform.current_policy_memberships (
    tenant_id, environment_id, principal_id, role_id, legal_entity_id
  ) NULLS NOT DISTINCT;

CREATE FUNCTION platform.bump_current_policy_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $$ DECLARE
  scope_tenant uuid;
  scope_environment uuid; BEGIN
  IF TG_OP = 'DELETE' THEN
    scope_tenant := OLD.tenant_id;
    scope_environment := OLD.environment_id; ELSE
    scope_tenant := NEW.tenant_id;
    scope_environment := NEW.environment_id; END IF;
  INSERT INTO platform.current_policy_epochs (
    tenant_id, environment_id, policy_version
  ) VALUES (scope_tenant, scope_environment, 1)
  ON CONFLICT (tenant_id, environment_id)
  DO UPDATE SET policy_version = current_policy_epochs.policy_version + 1,
                updated_at = transaction_timestamp();
  IF TG_OP = 'DELETE' THEN
    RETURN OLD; END IF;
  RETURN NEW; END $$;

CREATE TRIGGER current_policy_roles_epoch
AFTER INSERT OR UPDATE OR DELETE ON platform.current_policy_roles
FOR EACH ROW EXECUTE FUNCTION platform.bump_current_policy_epoch();
CREATE TRIGGER current_policy_permission_grants_epoch
AFTER INSERT OR UPDATE OR DELETE ON platform.current_policy_permission_grants
FOR EACH ROW EXECUTE FUNCTION platform.bump_current_policy_epoch();
CREATE TRIGGER current_policy_memberships_epoch
AFTER INSERT OR UPDATE OR DELETE ON platform.current_policy_memberships
FOR EACH ROW EXECUTE FUNCTION platform.bump_current_policy_epoch();

ALTER TABLE platform.current_policy_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.current_policy_epochs FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.current_policy_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.current_policy_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.current_policy_permission_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.current_policy_permission_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.current_policy_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.current_policy_memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY current_policy_epochs_runtime_select
  ON platform.current_policy_epochs FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );
CREATE POLICY current_policy_roles_runtime_select
  ON platform.current_policy_roles FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
        FROM platform.current_policy_memberships AS membership
       WHERE membership.tenant_id = current_policy_roles.tenant_id
         AND membership.environment_id = current_policy_roles.environment_id
         AND membership.role_id = current_policy_roles.role_id
         AND membership.principal_id = nullif(current_setting('north_star.principal_id', true), '')::uuid
         AND membership.revoked_at IS NULL
    )
  );
CREATE POLICY current_policy_permission_grants_runtime_select
  ON platform.current_policy_permission_grants FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
        FROM platform.current_policy_memberships AS membership
       WHERE membership.tenant_id = current_policy_permission_grants.tenant_id
         AND membership.environment_id = current_policy_permission_grants.environment_id
         AND membership.role_id = current_policy_permission_grants.role_id
         AND membership.principal_id = nullif(current_setting('north_star.principal_id', true), '')::uuid
         AND membership.revoked_at IS NULL
    )
  );
CREATE POLICY current_policy_memberships_runtime_select
  ON platform.current_policy_memberships FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND principal_id = nullif(current_setting('north_star.principal_id', true), '')::uuid
  );

REVOKE ALL ON platform.current_policy_epochs,
  platform.current_policy_roles,
  platform.current_policy_permission_grants,
  platform.current_policy_memberships FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.bump_current_policy_epoch() FROM PUBLIC;
GRANT SELECT ON platform.current_policy_epochs,
  platform.current_policy_roles,
  platform.current_policy_permission_grants,
  platform.current_policy_memberships TO north_star_runtime;

ALTER TABLE north_star_internal.module_storage_backfill_checkpoints
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE north_star_internal.module_storage_backfill_checkpoints
  FORCE ROW LEVEL SECURITY;
CREATE POLICY module_storage_backfill_checkpoints_materializer
  ON north_star_internal.module_storage_backfill_checkpoints
  FOR ALL TO north_star_module_materializer
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );
CREATE POLICY module_storage_backfill_checkpoints_runtime
  ON north_star_internal.module_storage_backfill_checkpoints
  FOR ALL TO north_star_module_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );
