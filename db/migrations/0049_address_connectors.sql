-- Address text and user pins live on the governed record. Provider coordinates
-- live only in expiring, company-owned enrichment rows.
CREATE TABLE platform.address_installations (
 tenant_id uuid NOT NULL, environment_id uuid NOT NULL, company_id uuid NOT NULL,
 installation_id uuid NOT NULL, account text NOT NULL CHECK (length(account) BETWEEN 1 AND 120),
 provider text NOT NULL CHECK(provider IN ('fake','google')), enabled boolean NOT NULL,
 enrichment boolean NOT NULL, period_calls integer NOT NULL CHECK (period_calls BETWEEN 1 AND 10000),
 period_budget_micros bigint NOT NULL CHECK(period_budget_micros BETWEEN 0 AND 1000000000),
 PRIMARY KEY(tenant_id,environment_id,company_id,installation_id),
 FOREIGN KEY (tenant_id,environment_id) REFERENCES platform.environments(tenant_id,id)
);
CREATE UNIQUE INDEX address_enabled_company ON platform.address_installations(tenant_id,environment_id,company_id) WHERE enabled;
CREATE TABLE platform.address_installation_history (
 tenant_id uuid NOT NULL, environment_id uuid NOT NULL, company_id uuid NOT NULL, installation_id uuid NOT NULL,
 event_id uuid NOT NULL DEFAULT gen_random_uuid(), principal_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 change text NOT NULL CHECK(change IN ('enabled','paused','rotated')),
 PRIMARY KEY(tenant_id,environment_id,event_id),
 FOREIGN KEY(tenant_id,environment_id,company_id,installation_id) REFERENCES platform.address_installations
);
CREATE TABLE platform.address_quota (
 tenant_id uuid NOT NULL, environment_id uuid NOT NULL, company_id uuid NOT NULL, installation_id uuid NOT NULL,
 period date NOT NULL, calls integer NOT NULL CHECK(calls >= 0), reserved_micros bigint NOT NULL CHECK(reserved_micros >= 0),
 PRIMARY KEY(tenant_id,environment_id,company_id,installation_id,period),
 FOREIGN KEY(tenant_id,environment_id,company_id,installation_id) REFERENCES platform.address_installations
);
CREATE TABLE platform.address_geocodes (
 tenant_id uuid NOT NULL, environment_id uuid NOT NULL, company_id uuid NOT NULL, installation_id uuid NOT NULL,
 outbox_id uuid NOT NULL, field_id text NOT NULL, entity_id text NOT NULL, record_id uuid NOT NULL, address_revision uuid NOT NULL,
 principal_id uuid NOT NULL, release_id uuid NOT NULL, release_root text NOT NULL, fence bigint NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','working','ready','failed','held')),
 attempts smallint NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 claim_id uuid, reason text CHECK(reason IN ('quota','unconfigured','unavailable','noMatch','invalidResult','superseded')),
 latitude numeric(11,8) CHECK(latitude BETWEEN -90 AND 90), longitude numeric(11,8) CHECK(longitude BETWEEN -180 AND 180),
 precision text CHECK(precision IN ('rooftop','interpolated','approximate','center')), expires_at timestamptz,
 PRIMARY KEY(tenant_id,environment_id,company_id,installation_id,outbox_id,field_id),
 UNIQUE(tenant_id,environment_id,company_id,installation_id,entity_id,record_id,field_id,address_revision),
 FOREIGN KEY(tenant_id,environment_id,company_id,installation_id) REFERENCES platform.address_installations,
 FOREIGN KEY(tenant_id,environment_id,outbox_id) REFERENCES platform.trust_outbox(tenant_id,environment_id,outbox_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,environment_id,release_id) REFERENCES platform.tenant_releases(tenant_id,environment_id,release_id),
 CHECK((latitude IS NULL AND longitude IS NULL AND precision IS NULL AND expires_at IS NULL)
       OR (latitude IS NOT NULL AND longitude IS NOT NULL AND precision IS NOT NULL AND expires_at IS NOT NULL AND state='ready'))
);
CREATE INDEX address_geocodes_work ON platform.address_geocodes(tenant_id,environment_id,principal_id,available_at) WHERE state IN ('queued','working');
CREATE FUNCTION platform.address_company_access(t uuid,e uuid,c uuid,manager boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog,pg_temp AS $$
  SELECT t=nullif(current_setting('north_star.tenant_id',true),'')::uuid AND
    e=nullif(current_setting('north_star.environment_id',true),'')::uuid AND EXISTS (
      SELECT 1 FROM platform.current_policy_memberships m JOIN platform.current_policy_roles r USING(tenant_id,environment_id,role_id)
      WHERE m.tenant_id=t AND m.environment_id=e AND m.principal_id=nullif(current_setting('north_star.principal_id',true),'')::uuid
      AND m.revoked_at IS NULL AND r.revoked_at IS NULL AND (m.legal_entity_id IS NULL OR m.legal_entity_id=c)
      AND (NOT manager OR r.role_key='local-demo-manager'))
$$;
REVOKE ALL ON FUNCTION platform.address_company_access(uuid,uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.address_company_access(uuid,uuid,uuid,boolean) TO north_star_runtime;
ALTER TABLE platform.address_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.address_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY address_installations_read ON platform.address_installations FOR SELECT TO north_star_runtime USING (platform.address_company_access(tenant_id,environment_id,company_id));
CREATE POLICY address_installations_insert ON platform.address_installations FOR INSERT TO north_star_runtime WITH CHECK (platform.address_company_access(tenant_id,environment_id,company_id,true));
CREATE POLICY address_installations_update ON platform.address_installations FOR UPDATE TO north_star_runtime USING (platform.address_company_access(tenant_id,environment_id,company_id,true)) WITH CHECK (platform.address_company_access(tenant_id,environment_id,company_id,true));
GRANT SELECT,INSERT ON platform.address_installations TO north_star_runtime;
ALTER TABLE platform.address_installation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.address_installation_history FORCE ROW LEVEL SECURITY;
CREATE POLICY address_installation_history_read ON platform.address_installation_history FOR SELECT TO north_star_runtime USING (platform.address_company_access(tenant_id,environment_id,company_id));
CREATE POLICY address_installation_history_insert ON platform.address_installation_history FOR INSERT TO north_star_runtime WITH CHECK (platform.address_company_access(tenant_id,environment_id,company_id,true));
GRANT SELECT,INSERT ON platform.address_installation_history TO north_star_runtime;
ALTER TABLE platform.address_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.address_quota FORCE ROW LEVEL SECURITY;
CREATE POLICY address_quota_read ON platform.address_quota FOR SELECT TO north_star_runtime USING (platform.address_company_access(tenant_id,environment_id,company_id));
CREATE POLICY address_quota_insert ON platform.address_quota FOR INSERT TO north_star_runtime WITH CHECK (platform.address_company_access(tenant_id,environment_id,company_id));
CREATE POLICY address_quota_update ON platform.address_quota FOR UPDATE TO north_star_runtime USING (platform.address_company_access(tenant_id,environment_id,company_id)) WITH CHECK (platform.address_company_access(tenant_id,environment_id,company_id));
GRANT SELECT,INSERT ON platform.address_quota TO north_star_runtime;
ALTER TABLE platform.address_geocodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.address_geocodes FORCE ROW LEVEL SECURITY;
CREATE POLICY address_geocodes_read ON platform.address_geocodes FOR SELECT TO north_star_runtime USING (platform.address_company_access(tenant_id,environment_id,company_id));
CREATE POLICY address_geocodes_insert ON platform.address_geocodes FOR INSERT TO north_star_runtime WITH CHECK (platform.address_company_access(tenant_id,environment_id,company_id));
CREATE POLICY address_geocodes_update ON platform.address_geocodes FOR UPDATE TO north_star_runtime USING (platform.address_company_access(tenant_id,environment_id,company_id)) WITH CHECK (platform.address_company_access(tenant_id,environment_id,company_id));
GRANT SELECT,INSERT ON platform.address_geocodes TO north_star_runtime;
GRANT UPDATE(enabled,enrichment,period_calls,period_budget_micros) ON platform.address_installations TO north_star_runtime;
GRANT UPDATE(calls,reserved_micros) ON platform.address_quota TO north_star_runtime;
GRANT UPDATE(state,attempts,available_at,claim_id,reason,latitude,longitude,precision,expires_at) ON platform.address_geocodes TO north_star_runtime;
