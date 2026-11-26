-- COMPANY-CALENDAR-1 slice 1: the business calendar resolver.
--
-- One business calendar per owning scope: the tenant default (environment and
-- company null) or one company's override. Each calendar is a list of
-- append-only, effective-dated versions. A company with no override, or an
-- instant before its override's first version, resolves to the tenant default,
-- so a past instant always gets the same business day.
--
-- The new tables are authoritative. platform.inventory_tenant_calendars stays
-- as a frozen mirror of each tenant default's version 1 (design read C1): the
-- preceding binary and three TypeScript readers still read it, provisioning
-- writes both stores in one transaction, and an UPDATE, DELETE or TRUNCATE on it
-- refuses. While the mirror exists a tenant default keeps exactly one version.
-- Company overrides at provisioning come in slice 2 (C2); here the override
-- branch is reachable only through the internal setter, which nothing grants.
--
-- This migration changes no existing row (C5): the backfill only inserts.
-- inventory_business_period keeps its signature, STABLE, definer, search path,
-- grants, scope check, both error names and their DETAIL, its arithmetic, and
-- NULL in gives NULL out (C3). ledger_business_day changes only its last line
-- (C6).

CREATE TABLE platform.business_calendars (
  calendar_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants (id),
  environment_id uuid,
  company_id uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT business_calendars_scope CHECK ((environment_id IS NULL) = (company_id IS NULL)),
  -- The tenant default's id is the tenant id, so a frozen {id: tenant_id}
  -- calendar reference stays byte-identical.
  CONSTRAINT business_calendars_default_id CHECK (company_id IS NOT NULL OR calendar_id = tenant_id),
  CONSTRAINT business_calendars_owner UNIQUE NULLS NOT DISTINCT (tenant_id, environment_id, company_id),
  CONSTRAINT business_calendars_tenant_calendar UNIQUE (tenant_id, calendar_id),
  CONSTRAINT business_calendars_environment FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id)
);

CREATE TABLE platform.business_calendar_versions (
  tenant_id uuid NOT NULL,
  calendar_id uuid NOT NULL,
  version integer NOT NULL,
  effective_from timestamptz NOT NULL,
  time_zone text NOT NULL,
  business_day_boundary time without time zone NOT NULL,
  week_start smallint NOT NULL DEFAULT 1,
  fiscal_year_start_month smallint NOT NULL DEFAULT 1,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (calendar_id, version),
  CONSTRAINT business_calendar_versions_start_unique UNIQUE (calendar_id, effective_from),
  CONSTRAINT business_calendar_versions_owner FOREIGN KEY (tenant_id, calendar_id)
    REFERENCES platform.business_calendars (tenant_id, calendar_id),
  CONSTRAINT business_calendar_versions_version_positive CHECK (version >= 1),
  CONSTRAINT business_calendar_versions_start_bounded CHECK (effective_from <> 'infinity'::timestamptz),
  CONSTRAINT business_calendar_versions_unbounded_first CHECK (effective_from <> '-infinity'::timestamptz OR version = 1),
  CONSTRAINT business_calendar_versions_zone_not_blank CHECK (btrim(time_zone) <> ''),
  CONSTRAINT business_calendar_versions_week_start CHECK (week_start BETWEEN 1 AND 7),
  CONSTRAINT business_calendar_versions_fiscal_month CHECK (fiscal_year_start_month BETWEEN 1 AND 12)
);

-- Backfill: each tenant default copies the mirror row verbatim, starting at
-- -infinity, recorded when the mirror row was created. No pg_timezone_names
-- check applies to these rows.
INSERT INTO platform.business_calendars (calendar_id, tenant_id, created_at)
  SELECT mirror.tenant_id, mirror.tenant_id, mirror.created_at
    FROM platform.inventory_tenant_calendars AS mirror;
INSERT INTO platform.business_calendar_versions (
  tenant_id, calendar_id, version, effective_from, time_zone, business_day_boundary, recorded_at
) SELECT mirror.tenant_id, mirror.tenant_id, 1, '-infinity'::timestamptz, mirror.time_zone,
         mirror.business_day_boundary, mirror.created_at
    FROM platform.inventory_tenant_calendars AS mirror;

ALTER TABLE platform.business_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.business_calendars FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.business_calendar_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.business_calendar_versions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform.business_calendars, platform.business_calendar_versions FROM PUBLIC;

CREATE FUNCTION north_star_internal.business_calendar_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  RAISE EXCEPTION 'calendar.appendOnly'; END $$;
CREATE TRIGGER business_calendars_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.business_calendars
  FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.business_calendar_append_only();
CREATE TRIGGER business_calendar_versions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.business_calendar_versions
  FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.business_calendar_append_only();

CREATE FUNCTION north_star_internal.business_calendar_mirror_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN
  RAISE EXCEPTION 'calendar.mirrorFrozen'; END $$;
CREATE TRIGGER inventory_tenant_calendars_frozen BEFORE UPDATE OR DELETE OR TRUNCATE ON platform.inventory_tenant_calendars
  FOR EACH STATEMENT EXECUTE FUNCTION north_star_internal.business_calendar_mirror_frozen();

-- Every writer, the setter or the owner, appends in order: the next version
-- number, a strictly later start, a tenant default's first version unbounded.
-- An override may start unbounded only while its company has no dated facts
-- (C5): no ledger company and no stock posting configuration.
CREATE FUNCTION north_star_internal.business_calendar_version_admit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE owner_company uuid; owner_environment uuid; latest_version integer; latest_start timestamptz; BEGIN
  SELECT calendar.company_id, calendar.environment_id INTO owner_company, owner_environment
    FROM platform.business_calendars AS calendar
   WHERE calendar.tenant_id = NEW.tenant_id AND calendar.calendar_id = NEW.calendar_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'calendar.undeclared'; END IF;
  SELECT max(version.version), max(version.effective_from) INTO latest_version, latest_start
    FROM platform.business_calendar_versions AS version WHERE version.calendar_id = NEW.calendar_id;
  IF NEW.version <> coalesce(latest_version, 0) + 1 OR NEW.effective_from <= latest_start THEN
    RAISE EXCEPTION 'calendar.versionOutOfOrder'; END IF;
  IF owner_company IS NULL AND NEW.version = 1 AND NEW.effective_from <> '-infinity'::timestamptz THEN
    RAISE EXCEPTION 'calendar.defaultStartsUnbounded'; END IF;
  IF owner_company IS NOT NULL AND NEW.effective_from = '-infinity'::timestamptz AND (
      EXISTS (SELECT FROM platform.ledger_companies AS company
               WHERE (company.tenant_id, company.environment_id, company.company_id)
                     = (NEW.tenant_id, owner_environment, owner_company))
      OR EXISTS (SELECT FROM platform.inventory_posting_configurations AS configuration
                  WHERE (configuration.tenant_id, configuration.environment_id, configuration.legal_entity_id)
                        = (NEW.tenant_id, owner_environment, owner_company))) THEN
    RAISE EXCEPTION 'calendar.overrideBackdated'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER business_calendar_versions_admit BEFORE INSERT ON platform.business_calendar_versions
  FOR EACH ROW EXECUTE FUNCTION north_star_internal.business_calendar_version_admit();

-- The version in force for (tenant, environment, company) at an instant: the
-- company's override version with the greatest start at or before the
-- instant, else the tenant default's. No row when nothing is declared.
CREATE FUNCTION north_star_internal.business_calendar_at(
  requested_tenant_id uuid, requested_environment_id uuid, requested_company_id uuid, requested_at timestamptz
) RETURNS TABLE (calendar_id uuid, version integer, effective_from timestamptz, time_zone text,
  business_day_boundary time without time zone, week_start smallint, fiscal_year_start_month smallint)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT v.calendar_id, v.version, v.effective_from, v.time_zone, v.business_day_boundary, v.week_start,
         v.fiscal_year_start_month
    FROM platform.business_calendars AS c
    JOIN platform.business_calendar_versions AS v ON v.tenant_id = c.tenant_id AND v.calendar_id = c.calendar_id
   WHERE c.tenant_id = requested_tenant_id
     AND ((c.environment_id = requested_environment_id AND c.company_id = requested_company_id)
          OR (c.company_id IS NULL))
     AND v.effective_from <= requested_at
   ORDER BY c.company_id IS NULL, v.effective_from DESC
   LIMIT 1
$$;

-- THE business-day arithmetic, unchanged from 0015: the local wall time minus
-- the day boundary, as a date. Interval subtraction keeps today's DST answers.
CREATE FUNCTION north_star_internal.business_day_of(
  requested_time_zone text, requested_boundary time without time zone, requested_at timestamptz
) RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (
    requested_at AT TIME ZONE requested_time_zone
    - make_interval(
        secs => extract(epoch FROM requested_boundary)::double precision
      )
  )::date
$$;

-- The business day of an instant for an owning scope. An undeclared calendar
-- refuses; there is no UTC default. NULL in gives NULL out once declared.
CREATE FUNCTION north_star_internal.business_day(
  requested_tenant_id uuid, requested_environment_id uuid, requested_company_id uuid, requested_at timestamptz
) RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE declared_zone text; declared_boundary time without time zone; BEGIN
  SELECT version.time_zone, version.business_day_boundary INTO declared_zone, declared_boundary
    FROM north_star_internal.business_calendar_at(requested_tenant_id, requested_environment_id,
      requested_company_id, coalesce(requested_at, '-infinity'::timestamptz)) AS version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'calendar.undeclared'
      USING ERRCODE = 'P0001', DETAIL = format('tenantId=%s', requested_tenant_id); END IF;
  RETURN north_star_internal.business_day_of(declared_zone, declared_boundary, requested_at); END $$;

-- The tenant default through the resolver. A NULL instant resolves the
-- default's first version (which always starts at -infinity) only to keep the
-- undeclared refusal of 0033; the arithmetic then returns NULL.
CREATE OR REPLACE FUNCTION north_star_internal.inventory_business_period(
  requested_tenant_id uuid,
  requested_effective_at timestamptz
) RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, platform, pg_temp
AS $inventory_business_period$ DECLARE
  declared_boundary time without time zone;
  declared_zone text; BEGIN
  IF session_user IN ('north_star_runtime', 'north_star_module_runtime')
     AND requested_tenant_id IS DISTINCT FROM
       nullif(current_setting('north_star.tenant_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'INVENTORY_TRUSTED_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001',
            DETAIL = format('tenantId=%s', requested_tenant_id); END IF;
  SELECT version.business_day_boundary, version.time_zone
    INTO declared_boundary, declared_zone
    FROM north_star_internal.business_calendar_at(
      requested_tenant_id, NULL, NULL,
      coalesce(requested_effective_at, '-infinity'::timestamptz)
    ) AS version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVENTORY_TENANT_CALENDAR_UNDECLARED'
      USING ERRCODE = 'P0001',
            DETAIL = format('tenantId=%s', requested_tenant_id); END IF;
  RETURN north_star_internal.business_day_of(
    declared_zone, declared_boundary, requested_effective_at
  ); END
$inventory_business_period$;

CREATE OR REPLACE FUNCTION north_star_internal.ledger_business_day(company uuid, instant timestamptz) RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id(); BEGIN
  IF instant IS NULL OR NOT isfinite(instant) OR NOT EXISTS (SELECT FROM platform.ledger_companies
      WHERE (tenant_id, environment_id, company_id) = (t, e, company)) THEN
    RAISE EXCEPTION 'ledger.companyUnavailable'; END IF;
  RETURN north_star_internal.business_day(t, e, company, instant); END $$;

-- The one writer. Granted to no one: provisioning reaches it for a tenant
-- default; slice 3 adds a confirmation-class operation. It locks the one
-- calendar row it appends to. A version after the first starts a FUTURE
-- business day under the version in force there before it, so no stored
-- business day ever moves and readers take no lock.
CREATE FUNCTION north_star_internal.business_calendar_put(
  requested_tenant_id uuid, requested_environment_id uuid, requested_company_id uuid,
  requested_effective_from timestamptz, requested_time_zone text,
  requested_boundary time without time zone, requested_week_start smallint,
  requested_fiscal_year_start_month smallint
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE calendar uuid; next_version integer; prior_zone text; prior_boundary time without time zone;
  start_day date; BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'calendar.requiresReadCommitted'; END IF;
  IF requested_tenant_id IS NULL OR requested_effective_from IS NULL
     OR (requested_environment_id IS NULL) <> (requested_company_id IS NULL) THEN
    RAISE EXCEPTION 'calendar.scopeInvalid'; END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_timezone_names WHERE name = requested_time_zone) THEN
    RAISE EXCEPTION 'calendar.timeZoneUnknown'
      USING ERRCODE = 'P0001', DETAIL = format('timeZone=%s', requested_time_zone); END IF;
  SELECT owner.calendar_id INTO calendar FROM platform.business_calendars AS owner
   WHERE owner.tenant_id = requested_tenant_id
     AND owner.environment_id IS NOT DISTINCT FROM requested_environment_id
     AND owner.company_id IS NOT DISTINCT FROM requested_company_id
     FOR UPDATE;
  IF FOUND AND requested_company_id IS NULL THEN
    -- C1: the tenant default keeps one version while its frozen mirror exists.
    RAISE EXCEPTION 'calendar.defaultVersionClosed'; END IF;
  IF requested_effective_from <> '-infinity'::timestamptz THEN
    SELECT version.time_zone, version.business_day_boundary INTO prior_zone, prior_boundary
      FROM north_star_internal.business_calendar_at(requested_tenant_id, requested_environment_id,
        requested_company_id, requested_effective_from) AS version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'calendar.undeclared'
        USING ERRCODE = 'P0001', DETAIL = format('tenantId=%s', requested_tenant_id); END IF;
    start_day := north_star_internal.business_day_of(prior_zone, prior_boundary, requested_effective_from);
    IF ((start_day + prior_boundary) AT TIME ZONE prior_zone) IS DISTINCT FROM requested_effective_from
       OR start_day <= north_star_internal.business_day_of(prior_zone, prior_boundary, transaction_timestamp()) THEN
      RAISE EXCEPTION 'calendar.changeNotFutureDayStart'; END IF;
  END IF;
  IF calendar IS NULL THEN
    calendar := CASE WHEN requested_company_id IS NULL THEN requested_tenant_id ELSE gen_random_uuid() END;
    INSERT INTO platform.business_calendars (calendar_id, tenant_id, environment_id, company_id)
      VALUES (calendar, requested_tenant_id, requested_environment_id, requested_company_id);
  END IF;
  SELECT coalesce(max(version.version), 0) + 1 INTO next_version
    FROM platform.business_calendar_versions AS version WHERE version.calendar_id = calendar;
  INSERT INTO platform.business_calendar_versions (
    tenant_id, calendar_id, version, effective_from, time_zone, business_day_boundary, week_start,
    fiscal_year_start_month
  ) VALUES (
    requested_tenant_id, calendar, next_version, requested_effective_from, requested_time_zone,
    requested_boundary, requested_week_start, requested_fiscal_year_start_month
  );
  RETURN next_version; END $$;

-- A company's calendar in force now, for a principal whose membership covers
-- that company (tenant-wide or scoped to it).
CREATE FUNCTION platform.business_calendar_read(company uuid)
RETURNS TABLE (calendar_id uuid, version integer, effective_from timestamptz, time_zone text,
  business_day_boundary time without time zone, week_start smallint, fiscal_year_start_month smallint,
  business_day date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t uuid := north_star_internal.trusted_tenant_id(); e uuid := north_star_internal.trusted_environment_id();
  read_at timestamptz := transaction_timestamp(); BEGIN
  IF company IS NULL OR NOT EXISTS (SELECT FROM platform.current_policy_memberships AS m
      JOIN platform.current_policy_roles AS r
        ON (r.tenant_id, r.environment_id, r.role_id) = (m.tenant_id, m.environment_id, m.role_id)
      WHERE (m.tenant_id, m.environment_id, m.principal_id)
            = (t, e, nullif(current_setting('north_star.principal_id', true), '')::uuid)
        AND m.revoked_at IS NULL AND r.revoked_at IS NULL
        AND (m.legal_entity_id IS NULL OR m.legal_entity_id = company)) THEN
    RAISE EXCEPTION 'calendar.readUnavailable'; END IF;
  RETURN QUERY SELECT v.calendar_id, v.version, v.effective_from, v.time_zone, v.business_day_boundary,
      v.week_start, v.fiscal_year_start_month,
      north_star_internal.business_day_of(v.time_zone, v.business_day_boundary, read_at)
    FROM north_star_internal.business_calendar_at(t, e, company, read_at) AS v; END $$;

REVOKE ALL ON FUNCTION
  north_star_internal.business_calendar_append_only(),
  north_star_internal.business_calendar_mirror_frozen(),
  north_star_internal.business_calendar_version_admit(),
  north_star_internal.business_calendar_at(uuid, uuid, uuid, timestamptz),
  north_star_internal.business_day_of(text, time without time zone, timestamptz),
  north_star_internal.business_day(uuid, uuid, uuid, timestamptz),
  north_star_internal.business_calendar_put(uuid, uuid, uuid, timestamptz, text, time without time zone, smallint, smallint),
  platform.business_calendar_read(uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.business_calendar_read(uuid) TO north_star_runtime;

-- Provisioning (0033) with one change: a first declaration also writes the
-- tenant default through the setter, in the same transaction. The conflict
-- branch is unchanged (C2), so an existing calendar never reaches the setter.
CREATE OR REPLACE FUNCTION platform.provision_inventory_scope(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_legal_entity_id uuid,
  requested_entity_code text,
  requested_entity_name text,
  requested_time_zone text,
  requested_business_day_boundary time without time zone,
  requested_contract_release_root text,
  requested_configuration_version smallint,
  requested_negative_stock text,
  requested_maximum_backdate_days integer,
  requested_adjustment_reason_requirement text,
  requested_transfer_reason_requirement text,
  requested_count_reason_requirement text,
  requested_correction_reason_requirement text,
  requested_rebaseline_reason_requirement text,
  requested_adjustment_approval_threshold numeric,
  requested_transfer_approval_threshold numeric,
  requested_count_approval_threshold numeric,
  requested_correction_approval_threshold numeric,
  requested_rebaseline_approval_threshold numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, platform, pg_temp
AS $provision_inventory_scope$ DECLARE
  existing_boundary time without time zone;
  existing_zone text; BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names
     WHERE name = requested_time_zone
  ) THEN
    RAISE EXCEPTION 'INVENTORY_TENANT_TIME_ZONE_UNKNOWN'
      USING ERRCODE = 'P0001',
            DETAIL = format('timeZone=%s', requested_time_zone); END IF;
  IF requested_legal_entity_id =
       '00000000-0000-0000-0000-000000000000'::uuid
     OR btrim(requested_entity_code) = ''
     OR btrim(requested_entity_name) = ''
     OR requested_contract_release_root !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'INVENTORY_PROVISIONING_INPUT_INVALID'
      USING ERRCODE = 'P0001'; END IF;
  SELECT calendar.business_day_boundary, calendar.time_zone
    INTO existing_boundary, existing_zone
    FROM platform.inventory_tenant_calendars AS calendar
   WHERE calendar.tenant_id = requested_tenant_id;
  IF FOUND THEN
    IF existing_boundary IS DISTINCT FROM requested_business_day_boundary
       OR existing_zone IS DISTINCT FROM requested_time_zone
    THEN
      RAISE EXCEPTION 'INVENTORY_TENANT_CALENDAR_CONFLICT'
        USING ERRCODE = 'P0001',
              DETAIL = format('tenantId=%s', requested_tenant_id); END IF;
  ELSE
    INSERT INTO platform.inventory_tenant_calendars (
      tenant_id, time_zone, business_day_boundary
    ) VALUES (
      requested_tenant_id,
      requested_time_zone,
      requested_business_day_boundary
    );
    PERFORM north_star_internal.business_calendar_put(
      requested_tenant_id, NULL, NULL, '-infinity'::timestamptz,
      requested_time_zone, requested_business_day_boundary, 1::smallint, 1::smallint
    ); END IF;
  INSERT INTO platform.inventory_posting_configurations (
    tenant_id,
    environment_id,
    legal_entity_id,
    contract_release_root,
    configuration_version,
    negative_stock,
    maximum_backdate_days,
    adjustment_reason_requirement,
    transfer_reason_requirement,
    count_reason_requirement,
    correction_reason_requirement,
    rebaseline_reason_requirement,
    adjustment_approval_threshold,
    transfer_approval_threshold,
    count_approval_threshold,
    correction_approval_threshold,
    rebaseline_approval_threshold
  ) VALUES (
    requested_tenant_id,
    requested_environment_id,
    requested_legal_entity_id,
    requested_contract_release_root,
    requested_configuration_version,
    requested_negative_stock,
    requested_maximum_backdate_days,
    requested_adjustment_reason_requirement,
    requested_transfer_reason_requirement,
    requested_count_reason_requirement,
    requested_correction_reason_requirement,
    requested_rebaseline_reason_requirement,
    requested_adjustment_approval_threshold,
    requested_transfer_approval_threshold,
    requested_count_approval_threshold,
    requested_correction_approval_threshold,
    requested_rebaseline_approval_threshold
  ) ON CONFLICT (tenant_id, environment_id, legal_entity_id) DO NOTHING;
  -- Policy stays assert-identical. `contract_release_root` is deliberately
  -- absent from this set; it is advanced below instead.
  IF NOT EXISTS (
    SELECT 1 FROM platform.inventory_posting_configurations AS configuration
     WHERE configuration.tenant_id = requested_tenant_id
       AND configuration.environment_id = requested_environment_id
       AND configuration.legal_entity_id = requested_legal_entity_id
       AND configuration.configuration_version = requested_configuration_version
       AND configuration.negative_stock = requested_negative_stock
       AND configuration.maximum_backdate_days = requested_maximum_backdate_days
       AND configuration.adjustment_reason_requirement = requested_adjustment_reason_requirement
       AND configuration.transfer_reason_requirement = requested_transfer_reason_requirement
       AND configuration.count_reason_requirement = requested_count_reason_requirement
       AND configuration.correction_reason_requirement = requested_correction_reason_requirement
       AND configuration.rebaseline_reason_requirement = requested_rebaseline_reason_requirement
       AND configuration.adjustment_approval_threshold IS NOT DISTINCT FROM requested_adjustment_approval_threshold
       AND configuration.transfer_approval_threshold IS NOT DISTINCT FROM requested_transfer_approval_threshold
       AND configuration.count_approval_threshold IS NOT DISTINCT FROM requested_count_approval_threshold
       AND configuration.correction_approval_threshold IS NOT DISTINCT FROM requested_correction_approval_threshold
       AND configuration.rebaseline_approval_threshold IS NOT DISTINCT FROM requested_rebaseline_approval_threshold
  ) THEN
    RAISE EXCEPTION 'INVENTORY_POSTING_CONFIGURATION_CONFLICT'
      USING ERRCODE = 'P0001',
            DETAIL = format(
              'tenantId=%s environmentId=%s legalEntityId=%s',
              requested_tenant_id,
              requested_environment_id,
              requested_legal_entity_id
            ); END IF;
  UPDATE platform.inventory_posting_configurations AS configuration
     SET contract_release_root = requested_contract_release_root
   WHERE configuration.tenant_id = requested_tenant_id
     AND configuration.environment_id = requested_environment_id
     AND configuration.legal_entity_id = requested_legal_entity_id
     AND configuration.contract_release_root
           IS DISTINCT FROM requested_contract_release_root; END
$provision_inventory_scope$;
