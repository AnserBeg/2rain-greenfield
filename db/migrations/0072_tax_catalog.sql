-- TAX-EVIDENCE-1 slice 1: the tax catalog (design note B, Fable amendments T1-T7).
-- The number is provisional; the integrator assigns the next free one at merge.
-- Platform-owned (plan §5.13, §10.6). Nothing here names a declared record type:
-- tax attaches to documents by declaration in slice 2.
--
-- Global, migration-only (no tenant column, no grants, read only through the
-- functions below): jurisdictions and the starter template. Tenant-scoped
-- (forced RLS, no policy, no grants, written only by the setters): components,
-- codes, append-only code versions and their components, per-company
-- registrations, single-use reviews and append-only receipts.
--
-- Lock order for every principal write: the active release pointer FOR SHARE,
-- then the policy epoch FOR SHARE, then the review row FOR UPDATE, then the
-- catalog rows (a code row, or a registration row) FOR UPDATE. Provisioning
-- takes only the catalog rows.

CREATE TABLE platform.tax_jurisdictions (
  jurisdiction_id text PRIMARY KEY CHECK (jurisdiction_id ~ '^[a-z]{2}(-[a-z0-9]{1,3})?$'),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  subdivision_code text CHECK (subdivision_code ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120)
);
INSERT INTO platform.tax_jurisdictions VALUES
  ('ca', 'CA', NULL, 'Canada (federal)'),
  ('ca-bc', 'CA', 'CA-BC', 'British Columbia'),
  ('ca-sk', 'CA', 'CA-SK', 'Saskatchewan'),
  ('ca-mb', 'CA', 'CA-MB', 'Manitoba');

-- The starter template (T3). Component IDs are fixed text, copied verbatim into
-- every tenant: they are ledger qualifiers. Every rate row cites its statute
-- and stays 'pendingOwner' until the owner verifies it (a later migration).
CREATE TABLE platform.tax_starter_codes (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  jurisdiction_id text NOT NULL REFERENCES platform.tax_jurisdictions,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120)
);
CREATE TABLE platform.tax_starter_components (
  component_id text PRIMARY KEY CHECK (component_id ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  jurisdiction_id text NOT NULL REFERENCES platform.tax_jurisdictions,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120)
);
CREATE TABLE platform.tax_starter_rates (
  code text NOT NULL REFERENCES platform.tax_starter_codes,
  effective_from date NOT NULL,
  component_id text NOT NULL REFERENCES platform.tax_starter_components,
  rate_percent numeric(9,6) NOT NULL,
  recoverable_percent numeric(9,6) NOT NULL,
  statute text NOT NULL CHECK (length(btrim(statute)) > 0),
  verification text NOT NULL DEFAULT 'pendingOwner' CHECK (verification IN ('pendingOwner', 'ownerVerified')),
  PRIMARY KEY (code, effective_from, component_id)
);
INSERT INTO platform.tax_starter_codes VALUES
  ('GST', 'ca', 'GST'),
  ('GST-PST-BC', 'ca-bc', 'GST + BC PST'),
  ('GST-PST-SK', 'ca-sk', 'GST + SK PST'),
  ('GST-RST-MB', 'ca-mb', 'GST + MB RST');
INSERT INTO platform.tax_starter_components VALUES
  ('ca.gst', 'ca', 'GST'),
  ('ca-bc.pst', 'ca-bc', 'BC PST'),
  ('ca-sk.pst', 'ca-sk', 'SK PST'),
  ('ca-mb.rst', 'ca-mb', 'MB RST');
INSERT INTO platform.tax_starter_rates(code, effective_from, component_id, rate_percent, recoverable_percent, statute) VALUES
  ('GST', '2008-01-01', 'ca.gst', 5, 100,
   'Excise Tax Act, R.S.C. 1985, c. E-15, s. 165(1): 5% from 2008-01-01 (S.C. 2007, c. 35, s. 184)'),
  ('GST-PST-BC', '2013-04-01', 'ca.gst', 5, 100,
   'Excise Tax Act, R.S.C. 1985, c. E-15, s. 165(1): 5% from 2008-01-01 (S.C. 2007, c. 35, s. 184)'),
  ('GST-PST-BC', '2013-04-01', 'ca-bc.pst', 7, 0,
   'Provincial Sales Tax Act, S.B.C. 2012, c. 35, s. 34(1) (rate) and s. 37(1) (charge): 7% from 2013-04-01'),
  ('GST-PST-SK', '2017-03-23', 'ca.gst', 5, 100,
   'Excise Tax Act, R.S.C. 1985, c. E-15, s. 165(1): 5% from 2008-01-01 (S.C. 2007, c. 35, s. 184)'),
  ('GST-PST-SK', '2017-03-23', 'ca-sk.pst', 6, 0,
   'The Provincial Sales Tax Act, R.S.S. 1978, c. P-34.1, s. 5: 6% from 2017-03-23 (2017-18 budget)'),
  ('GST-RST-MB', '2019-07-01', 'ca.gst', 5, 100,
   'Excise Tax Act, R.S.C. 1985, c. E-15, s. 165(1): 5% from 2008-01-01 (S.C. 2007, c. 35, s. 184)'),
  ('GST-RST-MB', '2019-07-01', 'ca-mb.rst', 7, 0,
   'The Retail Sales Tax Act, C.C.S.M. c. R130, s. 1(1) "general sales tax rate" (c) and s. 2(1): 7% after 2019-06-30');

CREATE TABLE platform.tax_components (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL,
  component_id text NOT NULL CHECK (component_id ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  jurisdiction_id text NOT NULL REFERENCES platform.tax_jurisdictions,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  PRIMARY KEY (tenant_id, environment_id, component_id),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments (tenant_id, id)
);
CREATE TABLE platform.tax_catalog_receipts (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, receipt_id uuid NOT NULL,
  principal_id uuid NOT NULL, release_id uuid, fence bigint,
  action text NOT NULL CHECK (action IN ('putCode', 'putRegistration', 'starter')),
  digest text NOT NULL, details jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, receipt_id),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments (tenant_id, id)
);
-- A code is shared by every company of the tenant. Its label and active flag
-- may change; its rates live only in append-only versions.
CREATE TABLE platform.tax_catalog_codes (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, code_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  active boolean NOT NULL,
  latest_version integer NOT NULL CHECK (latest_version >= 0),
  PRIMARY KEY (tenant_id, environment_id, code_id),
  UNIQUE (tenant_id, environment_id, code),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments (tenant_id, id)
);
CREATE TABLE platform.tax_catalog_versions (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, code_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  effective_from date NOT NULL,
  receipt_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, code_id, version),
  CONSTRAINT tax_catalog_versions_one_per_day UNIQUE (tenant_id, environment_id, code_id, effective_from),
  FOREIGN KEY (tenant_id, environment_id, code_id) REFERENCES platform.tax_catalog_codes (tenant_id, environment_id, code_id),
  FOREIGN KEY (tenant_id, environment_id, receipt_id) REFERENCES platform.tax_catalog_receipts (tenant_id, environment_id, receipt_id)
);
-- A version may have no components (T6: an exempt or zero-rated code).
CREATE TABLE platform.tax_catalog_version_components (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, code_id uuid NOT NULL,
  version integer NOT NULL, component_id text NOT NULL,
  rate_percent numeric(9,6) NOT NULL CONSTRAINT tax_rate_range CHECK (rate_percent >= 0 AND rate_percent <= 100),
  recoverable_percent numeric(9,6) NOT NULL CONSTRAINT tax_recoverable_range CHECK (recoverable_percent >= 0 AND recoverable_percent <= 100),
  PRIMARY KEY (tenant_id, environment_id, code_id, version, component_id),
  FOREIGN KEY (tenant_id, environment_id, code_id, version) REFERENCES platform.tax_catalog_versions (tenant_id, environment_id, code_id, version),
  FOREIGN KEY (tenant_id, environment_id, component_id) REFERENCES platform.tax_components (tenant_id, environment_id, component_id)
);
-- A company's registration in a jurisdiction over a half-open day range.
CREATE TABLE platform.tax_registrations (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, registration_id uuid NOT NULL,
  company_id uuid NOT NULL,
  jurisdiction_id text NOT NULL REFERENCES platform.tax_jurisdictions,
  registration_number text NOT NULL CHECK (length(btrim(registration_number)) BETWEEN 1 AND 64),
  effective_from date NOT NULL,
  effective_to date,
  receipt_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, registration_id),
  CONSTRAINT tax_registrations_range CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT tax_registrations_finite CHECK (isfinite(effective_from) AND (effective_to IS NULL OR isfinite(effective_to))),
  CONSTRAINT tax_registrations_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, environment_id WITH =, company_id WITH =, jurisdiction_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&),
  FOREIGN KEY (tenant_id, environment_id, receipt_id) REFERENCES platform.tax_catalog_receipts (tenant_id, environment_id, receipt_id)
);
-- A principal's reviewed proposal, bound to the release and fence it was
-- reviewed under and to its digest. Confirming consumes it once.
CREATE TABLE platform.tax_catalog_reviews (
  tenant_id uuid NOT NULL, environment_id uuid NOT NULL, review_id uuid NOT NULL,
  principal_id uuid NOT NULL, release_id uuid NOT NULL, fence bigint NOT NULL,
  action text NOT NULL CHECK (action IN ('putCode', 'putRegistration')),
  proposal jsonb NOT NULL, digest text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id, environment_id, review_id),
  FOREIGN KEY (tenant_id, environment_id) REFERENCES platform.environments (tenant_id, id)
);

CREATE FUNCTION north_star_internal.tax_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  RAISE EXCEPTION 'tax.appendOnly' USING ERRCODE = '55000'; END $$;
CREATE TRIGGER tax_catalog_versions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON platform.tax_catalog_versions FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.tax_append_only();
CREATE TRIGGER tax_catalog_version_components_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON platform.tax_catalog_version_components FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.tax_append_only();
CREATE TRIGGER tax_components_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON platform.tax_components FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.tax_append_only();
CREATE TRIGGER tax_catalog_receipts_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON platform.tax_catalog_receipts FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.tax_append_only();

CREATE FUNCTION north_star_internal.tax_require_writer() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'tax.requiresReadCommitted'; END IF; END $$;

-- Live authority. scope 'any': any live membership (tenant-shared reads);
-- 'tenant': a tenant-wide membership only (T2: shared codes); 'company': a
-- membership that covers the company. The grant and the scope are on the SAME
-- membership.
CREATE FUNCTION north_star_internal.tax_granted(company uuid, permission text, scope text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT FROM platform.current_policy_memberships m
    JOIN platform.current_policy_roles r USING (tenant_id, environment_id, role_id)
    JOIN platform.current_policy_permission_grants g USING (tenant_id, environment_id, role_id)
    WHERE (m.tenant_id, m.environment_id, m.principal_id) = (north_star_internal.trusted_tenant_id(),
          north_star_internal.trusted_environment_id(), nullif(current_setting('north_star.principal_id', true), '')::uuid)
      AND m.revoked_at IS NULL AND r.revoked_at IS NULL AND g.revoked_at IS NULL
      AND (g.permission_id, g.resource_id) = (permission, 'northstar.tax:capability.tax_catalog')
      AND CASE scope WHEN 'any' THEN true
        WHEN 'tenant' THEN m.legal_entity_id IS NULL
        ELSE (m.legal_entity_id IS NULL OR m.legal_entity_id = company) END)
$$;

-- Whether a company is a live legal entity (ADR-0015): an unarchived row of
-- the entity the ACTIVE release marks legalEntityMaster, in its active status.
-- Resolved by the marker in the storage-target projection, never by name.
CREATE FUNCTION north_star_internal.tax_company_live(company uuid, lock_row boolean) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id();
  masters jsonb; master jsonb; stored uuid; BEGIN
  IF company IS NULL THEN RETURN false; END IF;
  SELECT jsonb_agg(v) INTO masters FROM jsonb_array_elements((
    SELECT convert_from(blob.canonical_bytes, 'UTF8')::jsonb
      FROM platform.active_release_pointers p
      JOIN platform.tenant_release_projection_links projection USING (tenant_id, environment_id, release_id)
      JOIN platform.tenant_release_chunk_links chunk USING (tenant_id, environment_id, release_id, projection_instance_id)
      JOIN platform.release_artifact_blobs blob ON blob.content_hash = chunk.chunk_hash AND blob.artifact_kind = 'projectionChunk'
     WHERE (p.tenant_id, p.environment_id) = (t, e)
       AND projection.projection_family_id = 'northstar.compiler:projection-family.storage-target')->'entities') v
    WHERE v ? 'legalEntityMaster';
  IF jsonb_array_length(coalesce(masters, '[]'::jsonb)) <> 1 THEN RETURN false; END IF;
  master := masters->0;
  EXECUTE format('SELECT record_id FROM north_star_module.%I WHERE tenant_id = $1 AND environment_id = $2 AND record_id = $3
      AND archived_at IS NULL AND %I = $4 %s', master->>'physicalTableName',
      master#>>'{legalEntityMaster,fieldColumns,status}', CASE WHEN lock_row THEN 'FOR SHARE' ELSE '' END)
    INTO stored USING t, e, company, master#>>'{legalEntityMaster,activeStatusValue}';
  RETURN stored IS NOT NULL; END $$;

-- T3/T4: create a code or append a version. Granted to no one. The caller
-- supplies the trusted scope and a receipt it has already written.
-- proposal: {code, label, active, version?: {effectiveFrom, components: [
--   {componentId, jurisdictionId, label, ratePercent, recoverablePercent}]}}
CREATE FUNCTION north_star_internal.tax_put_code(t uuid, e uuid, proposal jsonb, receipt uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  spec jsonb := proposal->'version'; code_key text := proposal->>'code';
  held_code platform.tax_catalog_codes; created boolean; latest date; start_day date; next_version integer; part jsonb;
  held platform.tax_components; BEGIN
  PERFORM north_star_internal.tax_require_writer();
  IF (jsonb_typeof(proposal) = 'object' AND proposal - 'code' - 'label' - 'active' - 'version' = '{}'::jsonb
      AND jsonb_typeof(proposal->'code') = 'string' AND jsonb_typeof(proposal->'label') = 'string'
      AND jsonb_typeof(proposal->'active') = 'boolean'
      AND (spec IS NULL OR (jsonb_typeof(spec) = 'object' AND spec - 'effectiveFrom' - 'components' = '{}'::jsonb
        AND jsonb_typeof(spec->'effectiveFrom') = 'string' AND spec->>'effectiveFrom' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND pg_input_is_valid(spec->>'effectiveFrom', 'date')
        AND jsonb_typeof(spec->'components') = 'array' AND jsonb_array_length(spec->'components') <= 8))) IS NOT TRUE
    THEN RAISE EXCEPTION 'tax.invalidCode'; END IF;
  INSERT INTO platform.tax_catalog_codes(tenant_id, environment_id, code_id, code, label, active, latest_version)
    VALUES (t, e, gen_random_uuid(), code_key, btrim(proposal->>'label'), (proposal->>'active')::boolean, 0)
    ON CONFLICT (tenant_id, environment_id, code) DO NOTHING RETURNING true INTO created;
  SELECT * INTO STRICT held_code FROM platform.tax_catalog_codes
    WHERE (tenant_id, environment_id, code) = (t, e, code_key) FOR UPDATE;
  IF created IS NULL THEN
    UPDATE platform.tax_catalog_codes SET label = btrim(proposal->>'label'), active = (proposal->>'active')::boolean
      WHERE (tenant_id, environment_id, code_id) = (t, e, held_code.code_id);
  ELSIF spec IS NULL THEN RAISE EXCEPTION 'tax.versionRequired'; END IF;
  next_version := held_code.latest_version;
  IF spec IS NOT NULL THEN
    start_day := (spec->>'effectiveFrom')::date;
    SELECT max(v.effective_from) INTO latest FROM platform.tax_catalog_versions v
      WHERE (v.tenant_id, v.environment_id, v.code_id) = (t, e, held_code.code_id);
    -- T4: strictly increasing; a past or same day refuses. No future-only rule.
    IF latest IS NOT NULL AND start_day <= latest THEN RAISE EXCEPTION 'tax.versionNotAfterLatest'; END IF;
    next_version := held_code.latest_version + 1;
    INSERT INTO platform.tax_catalog_versions(tenant_id, environment_id, code_id, version, effective_from, receipt_id)
      VALUES (t, e, held_code.code_id, next_version, start_day, receipt);
    FOR part IN SELECT value FROM jsonb_array_elements(spec->'components') ORDER BY value->>'componentId' LOOP
      IF (jsonb_typeof(part) = 'object'
          AND part - 'componentId' - 'jurisdictionId' - 'label' - 'ratePercent' - 'recoverablePercent' = '{}'::jsonb
          AND jsonb_typeof(part->'componentId') = 'string' AND jsonb_typeof(part->'jurisdictionId') = 'string'
          AND jsonb_typeof(part->'label') = 'string'
          AND jsonb_typeof(part->'ratePercent') = 'string' AND part->>'ratePercent' ~ '^[0-9]{1,3}(\.[0-9]{1,6})?$'
          AND jsonb_typeof(part->'recoverablePercent') = 'string'
          AND part->>'recoverablePercent' ~ '^[0-9]{1,3}(\.[0-9]{1,6})?$') IS NOT TRUE
        THEN RAISE EXCEPTION 'tax.invalidComponent'; END IF;
      INSERT INTO platform.tax_components(tenant_id, environment_id, component_id, jurisdiction_id, label)
        VALUES (t, e, part->>'componentId', part->>'jurisdictionId', btrim(part->>'label')) ON CONFLICT DO NOTHING;
      SELECT * INTO STRICT held FROM platform.tax_components
        WHERE (tenant_id, environment_id, component_id) = (t, e, part->>'componentId');
      IF held.jurisdiction_id <> part->>'jurisdictionId' THEN RAISE EXCEPTION 'tax.componentJurisdiction'; END IF;
      INSERT INTO platform.tax_catalog_version_components(tenant_id, environment_id, code_id, version, component_id,
          rate_percent, recoverable_percent)
        VALUES (t, e, held_code.code_id, next_version, held.component_id, (part->>'ratePercent')::numeric,
          (part->>'recoverablePercent')::numeric); END LOOP;
    UPDATE platform.tax_catalog_codes SET latest_version = next_version
      WHERE (tenant_id, environment_id, code_id) = (t, e, held_code.code_id); END IF;
  RETURN jsonb_build_object('codeId', held_code.code_id, 'version', next_version); END $$;

-- Register a company, or end its open registration. Granted to no one.
-- proposal: {companyId, jurisdictionId, registrationNumber, effectiveFrom, effectiveTo?}
--        or {registrationId, effectiveTo}
CREATE FUNCTION north_star_internal.tax_put_registration(t uuid, e uuid, proposal jsonb, receipt uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE chosen uuid; BEGIN
  PERFORM north_star_internal.tax_require_writer();
  IF jsonb_typeof(proposal) = 'object' AND proposal ? 'registrationId' THEN
    IF (proposal - 'registrationId' - 'effectiveTo' = '{}'::jsonb AND jsonb_typeof(proposal->'effectiveTo') = 'string'
        AND pg_input_is_valid(proposal->>'registrationId', 'uuid')
        AND proposal->>'effectiveTo' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND pg_input_is_valid(proposal->>'effectiveTo', 'date')) IS NOT TRUE THEN RAISE EXCEPTION 'tax.invalidRegistration'; END IF;
    UPDATE platform.tax_registrations SET effective_to = (proposal->>'effectiveTo')::date, receipt_id = receipt
      WHERE (tenant_id, environment_id, registration_id) = (t, e, (proposal->>'registrationId')::uuid) AND effective_to IS NULL
      RETURNING registration_id INTO chosen;
    IF chosen IS NULL THEN RAISE EXCEPTION 'tax.registrationNotOpen'; END IF;
    RETURN jsonb_build_object('registrationId', chosen); END IF;
  IF (jsonb_typeof(proposal) = 'object'
      AND proposal - 'companyId' - 'jurisdictionId' - 'registrationNumber' - 'effectiveFrom' - 'effectiveTo' = '{}'::jsonb
      AND pg_input_is_valid(proposal->>'companyId', 'uuid') AND jsonb_typeof(proposal->'jurisdictionId') = 'string'
      AND jsonb_typeof(proposal->'registrationNumber') = 'string'
      AND jsonb_typeof(proposal->'effectiveFrom') = 'string' AND proposal->>'effectiveFrom' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND pg_input_is_valid(proposal->>'effectiveFrom', 'date')
      AND (NOT proposal ? 'effectiveTo' OR (jsonb_typeof(proposal->'effectiveTo') = 'string'
        AND proposal->>'effectiveTo' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND pg_input_is_valid(proposal->>'effectiveTo', 'date')))) IS NOT TRUE
    THEN RAISE EXCEPTION 'tax.invalidRegistration'; END IF;
  -- The company must be a live legal entity of the active release, share-locked
  -- until commit (taken after the pointer, epoch and review locks).
  IF NOT north_star_internal.tax_company_live((proposal->>'companyId')::uuid, true) THEN
    RAISE EXCEPTION 'tax.companyUnavailable'; END IF;
  chosen := gen_random_uuid();
  INSERT INTO platform.tax_registrations(tenant_id, environment_id, registration_id, company_id, jurisdiction_id,
      registration_number, effective_from, effective_to, receipt_id)
    VALUES (t, e, chosen, (proposal->>'companyId')::uuid, proposal->>'jurisdictionId', btrim(proposal->>'registrationNumber'),
      (proposal->>'effectiveFrom')::date, (proposal->>'effectiveTo')::date, receipt);
  RETURN jsonb_build_object('registrationId', chosen); END $$;

-- T3: apply the starter for the chosen jurisdictions at provisioning. Owner
-- only. A code the tenant already has is never touched, so a re-apply changes
-- nothing and an edited code is never overwritten.
CREATE FUNCTION platform.tax_provision_starter(t uuid, e uuid, jurisdictions text[]) RETURNS integer
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE starter record; version record; receipt uuid; applied integer := 0; BEGIN
  IF jurisdictions IS NULL OR EXISTS (SELECT FROM unnest(jurisdictions) j
      WHERE NOT EXISTS (SELECT FROM platform.tax_jurisdictions x WHERE x.jurisdiction_id = j)) THEN
    RAISE EXCEPTION 'tax.unknownJurisdiction'; END IF;
  FOR starter IN SELECT * FROM platform.tax_starter_codes s WHERE s.jurisdiction_id = ANY(jurisdictions) ORDER BY s.code LOOP
    CONTINUE WHEN EXISTS (SELECT FROM platform.tax_catalog_codes c
      WHERE (c.tenant_id, c.environment_id, c.code) = (t, e, starter.code));
    FOR version IN SELECT r.effective_from, jsonb_agg(jsonb_build_object('componentId', r.component_id,
        'jurisdictionId', k.jurisdiction_id, 'label', k.label, 'ratePercent', r.rate_percent::text,
        'recoverablePercent', r.recoverable_percent::text) ORDER BY r.component_id) AS components
      FROM platform.tax_starter_rates r JOIN platform.tax_starter_components k USING (component_id)
      WHERE r.code = starter.code GROUP BY r.effective_from ORDER BY r.effective_from LOOP
      receipt := gen_random_uuid();
      INSERT INTO platform.tax_catalog_receipts(tenant_id, environment_id, receipt_id, principal_id, action, digest, details)
        VALUES (t, e, receipt, '00000000-0000-4000-8000-000000000001', 'starter',
          encode(sha256(convert_to(starter.code || chr(10) || version.components::text, 'UTF8')), 'hex'),
          jsonb_build_object('code', starter.code, 'effectiveFrom', version.effective_from));
      PERFORM north_star_internal.tax_put_code(t, e, jsonb_build_object('code', starter.code, 'label', starter.label,
        'active', true, 'version', jsonb_build_object('effectiveFrom', version.effective_from::text,
        'components', version.components)), receipt); END LOOP;
    applied := applied + 1; END LOOP;
  RETURN applied; END $$;

-- The live WRITE authority for one reviewed action, used by review and again
-- by confirm. A registration named by ID takes its company from the stored row,
-- never from the proposal; a new registration's company is the one it names.
CREATE FUNCTION north_star_internal.tax_may_write(requested_action text, proposal jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE company uuid; BEGIN
  IF requested_action = 'putCode' THEN
    RETURN north_star_internal.tax_granted(NULL, 'northstar.tax:permission.tax_catalog_write', 'tenant'); END IF;
  IF proposal ? 'registrationId' THEN
    IF pg_input_is_valid(proposal->>'registrationId', 'uuid') THEN
      SELECT g.company_id INTO company FROM platform.tax_registrations g
        WHERE (g.tenant_id, g.environment_id, g.registration_id) = (north_star_internal.trusted_tenant_id(),
          north_star_internal.trusted_environment_id(), (proposal->>'registrationId')::uuid); END IF;
  ELSIF pg_input_is_valid(proposal->>'companyId', 'uuid') THEN company := (proposal->>'companyId')::uuid; END IF;
  RETURN company IS NOT NULL
    AND north_star_internal.tax_granted(company, 'northstar.tax:permission.registration_write', 'company'); END $$;

-- A confirmation-class change, step 1: record exactly what the principal saw,
-- bound to the active release and fence it was reviewed under. Only a principal
-- who could confirm it may record it, and a proposal is at most 16 KiB.
CREATE FUNCTION platform.tax_review(released uuid, expected_fence bigint, requested_action text, proposal jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id();
  p uuid := nullif(current_setting('north_star.principal_id', true), '')::uuid;
  review uuid := gen_random_uuid(); digest text; BEGIN
  IF (t IS NOT NULL AND e IS NOT NULL AND p IS NOT NULL AND requested_action IN ('putCode', 'putRegistration')
      AND jsonb_typeof(proposal) = 'object' AND octet_length(proposal::text) <= 16384) IS NOT TRUE
    THEN RAISE EXCEPTION 'tax.unavailable'; END IF;
  PERFORM FROM platform.active_release_pointers
    WHERE (tenant_id, environment_id, release_id, fence) = (t, e, released, expected_fence);
  IF NOT FOUND THEN RAISE EXCEPTION 'tax.staleRelease'; END IF;
  IF NOT north_star_internal.tax_may_write(requested_action, proposal) THEN
    RAISE EXCEPTION 'tax.writeDenied' USING ERRCODE = '42501'; END IF;
  IF requested_action = 'putRegistration' AND NOT proposal ? 'registrationId'
     AND NOT north_star_internal.tax_company_live((proposal->>'companyId')::uuid, false) THEN
    RAISE EXCEPTION 'tax.companyUnavailable'; END IF;
  digest := encode(sha256(convert_to(requested_action || chr(10) || proposal::text, 'UTF8')), 'hex');
  INSERT INTO platform.tax_catalog_reviews(tenant_id, environment_id, review_id, principal_id, release_id, fence,
      action, proposal, digest)
    VALUES (t, e, review, p, released, expected_fence, requested_action, proposal, digest);
  RETURN jsonb_build_object('reviewId', review, 'digest', digest, 'action', requested_action, 'proposal', proposal); END $$;

-- Step 2: confirm the reviewed digest. The release and fence must still be
-- active, the review unused, and the WRITE grant live NOW (a grant revoked after
-- the review refuses).
CREATE FUNCTION platform.tax_confirm(review uuid, reviewed_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id();
  p uuid := nullif(current_setting('north_star.principal_id', true), '')::uuid;
  r platform.tax_catalog_reviews; receipt uuid := gen_random_uuid(); BEGIN
  SELECT * INTO r FROM platform.tax_catalog_reviews
    WHERE (tenant_id, environment_id, review_id, principal_id) = (t, e, review, p);
  IF NOT FOUND OR r.digest IS DISTINCT FROM reviewed_digest THEN RAISE EXCEPTION 'tax.reviewUnavailable'; END IF;
  PERFORM FROM platform.active_release_pointers
    WHERE (tenant_id, environment_id, release_id, fence) = (t, e, r.release_id, r.fence) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tax.staleRelease'; END IF;
  PERFORM platform.lock_current_policy_epoch(t, e);
  SELECT * INTO r FROM platform.tax_catalog_reviews
    WHERE (tenant_id, environment_id, review_id) = (t, e, review) AND consumed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tax.reviewUnavailable'; END IF;
  IF r.proposal ? 'registrationId' AND pg_input_is_valid(r.proposal->>'registrationId', 'uuid') THEN
    PERFORM FROM platform.tax_registrations g
      WHERE (g.tenant_id, g.environment_id, g.registration_id) = (t, e, (r.proposal->>'registrationId')::uuid) FOR UPDATE; END IF;
  IF NOT north_star_internal.tax_may_write(r.action, r.proposal) THEN
    RAISE EXCEPTION 'tax.writeDenied' USING ERRCODE = '42501'; END IF;
  UPDATE platform.tax_catalog_reviews SET consumed_at = clock_timestamp()
    WHERE (tenant_id, environment_id, review_id) = (t, e, review);
  INSERT INTO platform.tax_catalog_receipts(tenant_id, environment_id, receipt_id, principal_id, release_id, fence,
      action, digest, details)
    VALUES (t, e, receipt, p, r.release_id, r.fence, r.action, r.digest, r.proposal);
  IF r.action = 'putCode' THEN
    RETURN north_star_internal.tax_put_code(t, e, r.proposal, receipt) || jsonb_build_object('receiptId', receipt); END IF;
  RETURN north_star_internal.tax_put_registration(t, e, r.proposal, receipt) || jsonb_build_object('receiptId', receipt); END $$;

-- The active codes in force on a day, each with its version and components (an
-- exempt code has none). Tenant-shared: any live membership with the read grant.
CREATE FUNCTION platform.tax_read_codes(at date)
RETURNS TABLE (code_id uuid, code text, label text, version integer, effective_from date, components jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id(); BEGIN
  IF at IS NULL OR NOT north_star_internal.tax_granted(NULL, 'northstar.tax:permission.tax_catalog_read', 'any') THEN
    RAISE EXCEPTION 'tax.readUnavailable' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT c.code_id, c.code, c.label, v.version, v.effective_from,
      coalesce((SELECT jsonb_agg(jsonb_build_object('componentId', k.component_id, 'jurisdictionId', x.jurisdiction_id,
          'ratePercent', k.rate_percent::text, 'recoverablePercent', k.recoverable_percent::text) ORDER BY k.component_id)
        FROM platform.tax_catalog_version_components k JOIN platform.tax_components x USING (tenant_id, environment_id, component_id)
        WHERE (k.tenant_id, k.environment_id, k.code_id, k.version) = (c.tenant_id, c.environment_id, c.code_id, v.version)),
        '[]'::jsonb)
    FROM platform.tax_catalog_codes c
    CROSS JOIN LATERAL (SELECT w.version, w.effective_from FROM platform.tax_catalog_versions w
      WHERE (w.tenant_id, w.environment_id, w.code_id) = (c.tenant_id, c.environment_id, c.code_id)
        AND w.effective_from <= at ORDER BY w.effective_from DESC LIMIT 1) v
    WHERE c.tenant_id = t AND c.environment_id = e AND c.active
    ORDER BY c.code; END $$;

-- One code's version in force on a day. An inactive code, or a day before its
-- first version, refuses by name (slice 2 resolves a chosen code through this).
CREATE FUNCTION platform.tax_read_code(chosen uuid, at date)
RETURNS TABLE (code_id uuid, code text, label text, version integer, effective_from date, components jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id();
  held platform.tax_catalog_codes; BEGIN
  IF NOT north_star_internal.tax_granted(NULL, 'northstar.tax:permission.tax_catalog_read', 'any') OR at IS NULL THEN
    RAISE EXCEPTION 'tax.readUnavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO held FROM platform.tax_catalog_codes c WHERE (c.tenant_id, c.environment_id, c.code_id) = (t, e, chosen);
  IF NOT FOUND THEN RAISE EXCEPTION 'tax.codeUnavailable'; END IF;
  IF NOT held.active THEN RAISE EXCEPTION 'tax.codeInactive'; END IF;
  RETURN QUERY SELECT held.code_id, held.code, held.label, v.version, v.effective_from,
      coalesce((SELECT jsonb_agg(jsonb_build_object('componentId', k.component_id, 'jurisdictionId', x.jurisdiction_id,
          'ratePercent', k.rate_percent::text, 'recoverablePercent', k.recoverable_percent::text) ORDER BY k.component_id)
        FROM platform.tax_catalog_version_components k JOIN platform.tax_components x USING (tenant_id, environment_id, component_id)
        WHERE (k.tenant_id, k.environment_id, k.code_id, k.version) = (t, e, held.code_id, v.version)), '[]'::jsonb)
    FROM platform.tax_catalog_versions v
    WHERE (v.tenant_id, v.environment_id, v.code_id) = (t, e, held.code_id) AND v.effective_from <= at
    ORDER BY v.effective_from DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'tax.noVersionInForce'; END IF; END $$;

-- A company's registrations. Refuses (never answers empty) for a company the
-- principal's membership does not cover.
CREATE FUNCTION platform.tax_read_registrations(company uuid)
RETURNS TABLE (registration_id uuid, jurisdiction_id text, registration_number text, effective_from date, effective_to date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  IF company IS NULL OR NOT north_star_internal.tax_granted(company, 'northstar.tax:permission.registration_read', 'company') THEN
    RAISE EXCEPTION 'tax.readUnavailable' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT g.registration_id, g.jurisdiction_id, g.registration_number, g.effective_from, g.effective_to
    FROM platform.tax_registrations g
    WHERE g.tenant_id = north_star_internal.trusted_tenant_id() AND g.environment_id = north_star_internal.trusted_environment_id()
      AND g.company_id = company
    ORDER BY g.jurisdiction_id, g.effective_from; END $$;

DO $access$ DECLARE tab text; routine text; BEGIN
  FOREACH tab IN ARRAY ARRAY['tax_jurisdictions', 'tax_starter_codes', 'tax_starter_components', 'tax_starter_rates',
      'tax_components', 'tax_catalog_receipts', 'tax_catalog_codes', 'tax_catalog_versions',
      'tax_catalog_version_components', 'tax_registrations', 'tax_catalog_reviews'] LOOP
    EXECUTE format('REVOKE ALL ON platform.%I FROM PUBLIC, north_star_runtime', tab); END LOOP;
  FOREACH tab IN ARRAY ARRAY['tax_components', 'tax_catalog_receipts', 'tax_catalog_codes', 'tax_catalog_versions',
      'tax_catalog_version_components', 'tax_registrations', 'tax_catalog_reviews'] LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY', tab); END LOOP;
  FOREACH routine IN ARRAY ARRAY['north_star_internal.tax_append_only()', 'north_star_internal.tax_require_writer()',
      'north_star_internal.tax_granted(uuid,text,text)', 'north_star_internal.tax_may_write(text,jsonb)',
      'north_star_internal.tax_company_live(uuid,boolean)',
      'north_star_internal.tax_put_code(uuid,uuid,jsonb,uuid)',
      'north_star_internal.tax_put_registration(uuid,uuid,jsonb,uuid)', 'platform.tax_provision_starter(uuid,uuid,text[])',
      'platform.tax_review(uuid,bigint,text,jsonb)', 'platform.tax_confirm(uuid,text)', 'platform.tax_read_codes(date)',
      'platform.tax_read_code(uuid,date)', 'platform.tax_read_registrations(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine); END LOOP; END $access$;
GRANT EXECUTE ON FUNCTION platform.tax_review(uuid,bigint,text,jsonb), platform.tax_confirm(uuid,text),
  platform.tax_read_codes(date), platform.tax_read_code(uuid,date), platform.tax_read_registrations(uuid)
  TO north_star_runtime;
