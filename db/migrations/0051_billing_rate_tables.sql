-- Published prices remain available by digest after a successor becomes effective.
CREATE TABLE platform.billing_rate_tables (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  company_id uuid NOT NULL,
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  version_id text NOT NULL,
  selector jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  release_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, company_id, plan_digest, version_id),
  UNIQUE (tenant_id, environment_id, company_id, plan_digest, selector, effective_from),
  FOREIGN KEY (tenant_id, environment_id, release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id)
);
ALTER TABLE platform.billing_rate_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.billing_rate_tables FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform.billing_rate_tables FROM PUBLIC;
GRANT SELECT, INSERT ON platform.billing_rate_tables TO north_star_runtime;
CREATE POLICY billing_terms_scope ON platform.billing_rate_tables TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

CREATE TABLE platform.billing_list_assignments (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  company_id uuid NOT NULL,
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  customer_id text NOT NULL,
  list_id text NOT NULL,
  revision_id text NOT NULL,
  effective_from timestamptz NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  release_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, company_id, plan_digest, customer_id, list_id, revision_id),
  UNIQUE (tenant_id, environment_id, company_id, plan_digest, customer_id, list_id, effective_from),
  FOREIGN KEY (tenant_id, environment_id, release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id)
);
ALTER TABLE platform.billing_list_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.billing_list_assignments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform.billing_list_assignments FROM PUBLIC;
GRANT SELECT, INSERT ON platform.billing_list_assignments TO north_star_runtime;
CREATE POLICY billing_assignment_scope ON platform.billing_list_assignments TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );
