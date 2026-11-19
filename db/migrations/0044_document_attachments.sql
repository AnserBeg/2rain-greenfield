CREATE TABLE platform.document_blobs (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  owner_scope text NOT NULL,
  digest text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  bytes bytea NOT NULL,
  byte_length integer GENERATED ALWAYS AS (octet_length(bytes)) STORED,
  PRIMARY KEY (tenant_id, environment_id, owner_scope, digest),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments (tenant_id, id),
  CHECK (owner_scope = 'shared' OR owner_scope ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CHECK (octet_length(bytes) BETWEEN 1 AND 20971520),
  CHECK (digest = encode(sha256(bytes), 'hex'))
);

CREATE TABLE platform.document_upload_staging (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  owner_scope text NOT NULL,
  entity_id text NOT NULL,
  record_id uuid NOT NULL,
  field_id text,
  category_id text,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 180),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  digest text NOT NULL,
  bytes bytea NOT NULL,
  byte_length integer GENERATED ALWAYS AS (octet_length(bytes)) STORED,
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
  PRIMARY KEY (tenant_id, environment_id, upload_id),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments (tenant_id, id),
  CHECK (octet_length(bytes) BETWEEN 1 AND 20971520),
  CHECK (digest = encode(sha256(bytes), 'hex'))
);

CREATE TABLE platform.document_versions (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  link_id uuid NOT NULL,
  version_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  owner_scope text NOT NULL,
  digest text NOT NULL,
  entity_id text NOT NULL,
  record_id uuid NOT NULL,
  record_revision bigint NOT NULL CHECK (record_revision > 0),
  field_id text,
  category_id text,
  retention_class text,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 180),
  actor_id uuid NOT NULL,
  release_id uuid NOT NULL,
  scan_policy_version text NOT NULL CHECK (scan_policy_version <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, link_id),
  UNIQUE (tenant_id, environment_id, version_id),
  UNIQUE (tenant_id, environment_id, upload_id),
  FOREIGN KEY (tenant_id, environment_id, release_id)
    REFERENCES platform.tenant_releases (tenant_id, environment_id, release_id),
  FOREIGN KEY (tenant_id, environment_id, owner_scope, digest)
    REFERENCES platform.document_blobs (tenant_id, environment_id, owner_scope, digest),
  CHECK (category_id IS NULL OR (field_id IS NOT NULL AND retention_class IS NOT NULL))
);

CREATE INDEX document_versions_record
  ON platform.document_versions
    (tenant_id, environment_id, entity_id, record_id, owner_scope, field_id, link_id);

CREATE TABLE platform.document_attachment_audit (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  link_id uuid NOT NULL,
  operation_id text NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, link_id),
  FOREIGN KEY (tenant_id, environment_id, link_id)
    REFERENCES platform.document_versions (tenant_id, environment_id, link_id)
);

ALTER TABLE platform.document_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.document_blobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform.document_blobs FROM PUBLIC;
GRANT SELECT, INSERT ON platform.document_blobs TO north_star_runtime;
CREATE POLICY document_trusted_scope ON platform.document_blobs TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

ALTER TABLE platform.document_upload_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.document_upload_staging FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform.document_upload_staging FROM PUBLIC;
GRANT SELECT, INSERT ON platform.document_upload_staging TO north_star_runtime;
CREATE POLICY document_trusted_scope ON platform.document_upload_staging TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

ALTER TABLE platform.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.document_versions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform.document_versions FROM PUBLIC;
GRANT SELECT, INSERT ON platform.document_versions TO north_star_runtime;
CREATE POLICY document_trusted_scope ON platform.document_versions TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

ALTER TABLE platform.document_attachment_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.document_attachment_audit FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform.document_attachment_audit FROM PUBLIC;
GRANT SELECT, INSERT ON platform.document_attachment_audit TO north_star_runtime;
CREATE POLICY document_trusted_scope ON platform.document_attachment_audit TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
    AND nullif(current_setting('north_star.principal_id', true), '')::uuid IS NOT NULL
  );

-- Unpublished ingress is temporary. Published bytes, references and audit have no delete grant.
GRANT DELETE ON platform.document_upload_staging TO north_star_runtime;
