CREATE ROLE north_star_runtime
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS;

CREATE TABLE platform.tenant_fixture_records (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  id uuid NOT NULL,
  label text NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, id),
  CONSTRAINT tenant_fixture_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT tenant_fixture_label_not_blank CHECK (btrim(label) <> '')
);

ALTER TABLE platform.tenant_fixture_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_fixture_records FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_fixture_trusted_context
  ON platform.tenant_fixture_records
  AS PERMISSIVE
  FOR ALL
  TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

REVOKE ALL ON platform.tenant_fixture_records FROM PUBLIC;
GRANT USAGE ON SCHEMA platform TO north_star_runtime;
GRANT SELECT, INSERT ON platform.tenant_fixture_records TO north_star_runtime;
