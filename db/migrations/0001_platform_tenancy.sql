CREATE SCHEMA platform;

CREATE TABLE platform.tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT tenants_slug_not_blank CHECK (btrim(slug) <> ''),
  CONSTRAINT tenants_slug_unique UNIQUE (slug)
);

CREATE TABLE platform.environments (
  tenant_id uuid NOT NULL REFERENCES platform.tenants (id),
  id uuid NOT NULL,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT environments_slug_not_blank CHECK (btrim(slug) <> ''),
  CONSTRAINT environments_tenant_slug_unique UNIQUE (tenant_id, slug)
);
