-- Staff credentials are owned by the isolated identity process. The serving
-- role has a session check, and cannot read credentials or issue sessions.
CREATE ROLE north_star_identity LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS
  NOCREATEROLE NOCREATEDB NOREPLICATION;
GRANT USAGE ON SCHEMA platform TO north_star_identity;

CREATE TABLE platform.staff_relying_parties (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, rp_id text NOT NULL,
  identity_origin text NOT NULL, application_origin text NOT NULL,
  PRIMARY KEY (tenant_id,environment_id),
  FOREIGN KEY (tenant_id,environment_id) REFERENCES platform.environments(tenant_id,id)
);
CREATE FUNCTION platform.staff_realm_configured(t uuid,e uuid,rp text,id_origin text,expected_application_origin text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT FROM platform.staff_relying_parties WHERE tenant_id=t AND environment_id=e
    AND rp_id=rp AND identity_origin=id_origin AND application_origin=expected_application_origin)
$$;
REVOKE ALL ON FUNCTION platform.staff_realm_configured(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_realm_configured(uuid,uuid,text,text,text) TO north_star_identity,north_star_runtime;

CREATE TABLE platform.staff_accounts (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, principal_id uuid NOT NULL,
  user_handle bytea NOT NULL UNIQUE CHECK (octet_length(user_handle) = 32),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  recovery_contact text NOT NULL CHECK (length(recovery_contact) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('pending','active','inactive')),
  decisions_after timestamptz,
  PRIMARY KEY (tenant_id, environment_id, principal_id),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments(tenant_id,id)
);

CREATE TABLE platform.staff_credentials (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, principal_id uuid NOT NULL,
  key_ref uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE, method text NOT NULL, credential_id text NOT NULL, public_key bytea NOT NULL,
  sign_count bigint NOT NULL CHECK (sign_count >= 0),
  backup_eligible boolean NOT NULL, backed_up boolean NOT NULL,
  transports text[] NOT NULL, revoked_at timestamptz,
  PRIMARY KEY (method,credential_id),
  FOREIGN KEY (tenant_id,environment_id,principal_id) REFERENCES platform.staff_accounts,
  CHECK (NOT backed_up OR backup_eligible)
);

CREATE TABLE platform.staff_invitations (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, principal_id uuid NOT NULL,
  token_digest bytea PRIMARY KEY CHECK (octet_length(token_digest) = 32),
  kind text NOT NULL CHECK (kind IN ('bootstrap','invite','recover','spare')),
  issuer_id uuid, expires_at timestamptz NOT NULL, retired_at timestamptz,
  FOREIGN KEY (tenant_id,environment_id,principal_id) REFERENCES platform.staff_accounts,
  FOREIGN KEY (tenant_id,environment_id,issuer_id) REFERENCES platform.staff_accounts
);

CREATE TABLE platform.staff_ceremonies (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL,
  browser_digest bytea PRIMARY KEY CHECK (octet_length(browser_digest) = 32),
  kind text NOT NULL CHECK (kind IN ('registration','authentication')),
  challenge text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  invitation bytea REFERENCES platform.staff_invitations(token_digest),
  application_binding bytea, intent jsonb NOT NULL, consumed_at timestamptz,
  FOREIGN KEY (tenant_id,environment_id) REFERENCES platform.environments(tenant_id,id),
  CHECK ((kind = 'registration') = (invitation IS NOT NULL))
);

CREATE TABLE platform.staff_sessions (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, principal_id uuid NOT NULL,
  family_id uuid PRIMARY KEY, method text NOT NULL, assurance text NOT NULL,
  authenticated_at timestamptz NOT NULL, last_activity timestamptz NOT NULL,
  absolute_deadline timestamptz NOT NULL, revoked_at timestamptz,
  identity_digest bytea NOT NULL UNIQUE, application_digest bytea UNIQUE,
  handoff_digest bytea UNIQUE, handoff_deadline timestamptz NOT NULL, browser_binding bytea NOT NULL,
  FOREIGN KEY (tenant_id,environment_id,principal_id) REFERENCES platform.staff_accounts,
  CHECK (absolute_deadline <= authenticated_at + interval '12 hours'),
  CHECK (last_activity >= authenticated_at)
);
CREATE INDEX staff_sessions_account ON platform.staff_sessions(tenant_id,environment_id,principal_id);

CREATE TABLE platform.staff_attempts (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, bucket bytea NOT NULL,
  window_start timestamptz NOT NULL, attempts integer NOT NULL CHECK (attempts > 0),
  PRIMARY KEY (tenant_id,environment_id,bucket),
  FOREIGN KEY (tenant_id,environment_id) REFERENCES platform.environments(tenant_id,id)
);

CREATE TABLE platform.staff_authentication_audit (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN
    ('bootstrap','invite','enroll','signin','signout','signout-everywhere','deactivate','recover','spare','revoke-key')),
  actor_id uuid, subject_id uuid NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  method text NOT NULL, assurance text NOT NULL, reason text,
  FOREIGN KEY (tenant_id,environment_id,subject_id) REFERENCES platform.staff_accounts
);

DO $$
DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['staff_relying_parties','staff_accounts','staff_credentials','staff_invitations',
    'staff_ceremonies','staff_sessions','staff_attempts','staff_authentication_audit'] LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('REVOKE ALL ON platform.%I FROM PUBLIC',tab);
    EXECUTE format('CREATE POLICY identity_scope ON platform.%I TO north_star_identity
      USING (tenant_id = nullif(current_setting(''north_star.tenant_id'',true),'''')::uuid
        AND environment_id = nullif(current_setting(''north_star.environment_id'',true),'''')::uuid)',tab); END LOOP; END $$;
GRANT SELECT, INSERT, UPDATE ON platform.staff_accounts,platform.staff_credentials,
  platform.staff_invitations,platform.staff_ceremonies,platform.staff_sessions,
  platform.staff_attempts TO north_star_identity;
GRANT SELECT, INSERT ON platform.staff_authentication_audit TO north_star_identity;

CREATE FUNCTION platform.refuse_staff_audit_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RAISE EXCEPTION 'staff authentication evidence is append-only'; END $$;
REVOKE ALL ON FUNCTION platform.refuse_staff_audit_change() FROM PUBLIC;
CREATE TRIGGER staff_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON platform.staff_authentication_audit FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_staff_audit_change();

-- Only active accounts with live policy memberships can use a staff session.
-- The mutable path locks the account first, in the order used by recovery.
CREATE FUNCTION platform.staff_session_principal(t uuid,e uuid,handle bytea,protected_write boolean,foreground boolean)
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
  observed := clock_timestamp();
  IF NOT FOUND OR s.revoked_at IS NOT NULL OR observed < s.last_activity
      OR observed >= LEAST(s.absolute_deadline,s.last_activity + interval '30 minutes')
      OR NOT EXISTS (SELECT FROM platform.current_policy_memberships m JOIN platform.current_policy_roles r
        USING(tenant_id,environment_id,role_id) WHERE m.tenant_id=t AND m.environment_id=e
        AND m.principal_id=p AND m.revoked_at IS NULL AND r.revoked_at IS NULL) THEN RETURN NULL; END IF;
  IF protected_write AND foreground AND observed >= s.last_activity + interval '1 minute' THEN
    UPDATE platform.staff_sessions SET last_activity=observed WHERE family_id=s.family_id; END IF;
  RETURN p; END $$;
REVOKE ALL ON FUNCTION platform.staff_session_principal(uuid,uuid,bytea,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_session_principal(uuid,uuid,bytea,boolean,boolean) TO north_star_runtime;

-- The minimal attended lifecycle assigns preprovisioned policy roles. The
-- slice 1 owner can invite members; an installer alone bootstraps an owner.
CREATE FUNCTION platform.staff_has_role(t uuid,e uuid,p uuid,wanted text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT FROM platform.current_policy_memberships m JOIN platform.current_policy_roles r
    USING(tenant_id,environment_id,role_id) JOIN platform.staff_accounts a USING(tenant_id,environment_id,principal_id)
    WHERE m.tenant_id=t AND m.environment_id=e AND m.principal_id=p AND (wanted IS NULL OR (m.legal_entity_id IS NULL AND r.role_key=wanted)) AND r.revoked_at IS NULL AND m.revoked_at IS NULL AND a.status='active')
$$;
REVOKE ALL ON FUNCTION platform.staff_has_role(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_has_role(uuid,uuid,uuid,text) TO north_star_identity;

CREATE FUNCTION platform.staff_assign_member(t uuid,e uuid,p uuid,issuer uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NOT platform.staff_has_role(t,e,issuer,'staff-owner') THEN RAISE EXCEPTION 'staff invitation refused'; END IF;
  INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id)
    SELECT t,e,gen_random_uuid(),p,role_id FROM platform.current_policy_roles
    WHERE tenant_id=t AND environment_id=e AND role_key='staff-member' AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'staff member role unavailable'; END IF; END $$;
REVOKE ALL ON FUNCTION platform.staff_assign_member(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_assign_member(uuid,uuid,uuid,uuid) TO north_star_identity;

CREATE FUNCTION platform.staff_disable_memberships(t uuid,e uuid,p uuid,issuer uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF NOT platform.staff_has_role(t,e,issuer,'staff-owner') OR platform.staff_has_role(t,e,p,'staff-owner')
    THEN RAISE EXCEPTION 'staff deactivation refused'; END IF;
  UPDATE platform.current_policy_memberships SET revoked_at=clock_timestamp()
    WHERE tenant_id=t AND environment_id=e AND principal_id=p AND revoked_at IS NULL; END $$;
REVOKE ALL ON FUNCTION platform.staff_disable_memberships(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.staff_disable_memberships(uuid,uuid,uuid,uuid) TO north_star_identity;
