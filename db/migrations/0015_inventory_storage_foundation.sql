CREATE TABLE platform.inventory_tenant_calendars (
  tenant_id uuid PRIMARY KEY REFERENCES platform.tenants (id),
  time_zone text NOT NULL,
  business_day_boundary time without time zone NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT inventory_tenant_calendars_zone_not_blank
    CHECK (btrim(time_zone) <> '')
);

CREATE TABLE platform.inventory_posting_configurations (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  contract_release_root text NOT NULL,
  configuration_version smallint NOT NULL,
  negative_stock text NOT NULL,
  maximum_backdate_days integer NOT NULL,
  adjustment_reason_requirement text NOT NULL,
  transfer_reason_requirement text NOT NULL,
  count_reason_requirement text NOT NULL,
  correction_reason_requirement text NOT NULL,
  rebaseline_reason_requirement text NOT NULL,
  adjustment_approval_threshold numeric(38,18),
  transfer_approval_threshold numeric(38,18),
  count_approval_threshold numeric(38,18),
  correction_approval_threshold numeric(38,18),
  rebaseline_approval_threshold numeric(38,18),
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, legal_entity_id),
  CONSTRAINT inventory_posting_configurations_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT inventory_posting_configurations_shape CHECK (
    legal_entity_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND contract_release_root ~ '^[0-9a-f]{64}$'
    AND configuration_version = 1
    AND negative_stock IN ('reject', 'allowWithFlag', 'allow')
    AND maximum_backdate_days BETWEEN 0 AND 3650
    AND adjustment_reason_requirement IN ('codeOnly', 'codeAndNarrative')
    AND transfer_reason_requirement IN ('codeOnly', 'codeAndNarrative')
    AND count_reason_requirement IN ('codeOnly', 'codeAndNarrative')
    AND correction_reason_requirement IN ('codeOnly', 'codeAndNarrative')
    AND rebaseline_reason_requirement IN ('codeOnly', 'codeAndNarrative')
    AND (adjustment_approval_threshold IS NULL
      OR adjustment_approval_threshold >= 0)
    AND (transfer_approval_threshold IS NULL
      OR transfer_approval_threshold >= 0)
    AND (count_approval_threshold IS NULL
      OR count_approval_threshold >= 0)
    AND (correction_approval_threshold IS NULL
      OR correction_approval_threshold >= 0)
    AND (rebaseline_approval_threshold IS NULL
      OR rebaseline_approval_threshold >= 0)
    AND revision > 0
  )
);

ALTER TABLE north_star_internal.module_storage_elements
  DROP CONSTRAINT module_storage_elements_shape;
ALTER TABLE north_star_internal.module_storage_elements
  ADD CONSTRAINT module_storage_elements_shape CHECK (
    btrim(element_id) <> ''
    AND element_kind IN (
      'addAbiFunctionCheck',
      'addColumn',
      'addForeignKey',
      'addNotValidConstraint',
      'backfill',
      'createCompanionTable',
      'createIndex',
      'createPartition',
      'createRejectMutationTrigger',
      'createTable',
      'duplicateScan',
      'tightenNotNull',
      'validateConstraint'
    )
    AND btrim(physical_object_name) <> ''
    AND shape_fingerprint ~ '^[0-9a-f]{64}$'
  );

CREATE FUNCTION north_star_internal.inventory_business_period(
  requested_tenant_id uuid,
  requested_effective_at timestamptz
) RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, platform
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
  SELECT calendar.business_day_boundary, calendar.time_zone
    INTO declared_boundary, declared_zone
    FROM platform.inventory_tenant_calendars AS calendar
   WHERE calendar.tenant_id = requested_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVENTORY_TENANT_CALENDAR_UNDECLARED'
      USING ERRCODE = 'P0001',
            DETAIL = format('tenantId=%s', requested_tenant_id); END IF;
  RETURN (
    requested_effective_at AT TIME ZONE declared_zone
    - make_interval(
        secs => extract(epoch FROM declared_boundary)::double precision
      )
  )::date; END
$inventory_business_period$;

CREATE FUNCTION north_star_internal.reject_inventory_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $reject_inventory_fact_mutation$ BEGIN
  RAISE EXCEPTION 'INVENTORY_MOVEMENT_IMMUTABLE'
    USING ERRCODE = 'P0001',
          DETAIL = format(
            'relation=%s operation=%s movementId=%s',
            TG_TABLE_NAME,
            TG_OP,
            COALESCE(OLD.record_id::text, 'unknown')
          ); END
$reject_inventory_fact_mutation$;

CREATE FUNCTION north_star_internal.reserve_inventory_movement_effect()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $reserve_inventory_movement_effect$ DECLARE
  companion_columns text;
  companion_relation regclass;
  companion_values text; BEGIN
  companion_relation := TG_ARGV[0]::regclass;
  SELECT
    string_agg(format('%I', attribute.attname), ', ' ORDER BY attribute.attnum),
    string_agg(
      format(
        '(to_jsonb($1)->>%L)::%s',
        attribute.attname,
        format_type(attribute.atttypid, attribute.atttypmod)
      ),
      ', ' ORDER BY attribute.attnum
    )
    INTO companion_columns, companion_values
    FROM pg_attribute AS attribute
   WHERE attribute.attrelid = companion_relation
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped;
  IF companion_columns IS NULL OR companion_values IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_MOVEMENT_EFFECT_TARGET_INVALID'
      USING ERRCODE = 'P0001'; END IF;
  EXECUTE format(
    'INSERT INTO %s (%s) SELECT %s',
    companion_relation,
    companion_columns,
    companion_values
  ) USING NEW;
  RETURN NEW; END
$reserve_inventory_movement_effect$;

CREATE FUNCTION north_star_internal.provision_inventory_period_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $provision_inventory_period_lock$ DECLARE
  lock_relation regclass;
  relation_owner text;
  relation_schema text; BEGIN
  lock_relation := TG_ARGV[0]::regclass;
  SELECT namespace.nspname, pg_get_userbyid(relation.relowner)
    INTO relation_schema, relation_owner
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = lock_relation
     AND relation.relkind = 'r';
  IF relation_schema IS DISTINCT FROM 'north_star_module'
     OR relation_owner IS DISTINCT FROM 'north_star_module_materializer'
  THEN
    RAISE EXCEPTION 'INVENTORY_PERIOD_LOCK_RELATION_UNTRUSTED'
      USING ERRCODE = 'P0001'; END IF;
  EXECUTE format(
    'INSERT INTO %s (tenant_id, environment_id, legal_entity_id, record_id) '
    || 'VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING',
    lock_relation
  ) USING NEW.tenant_id, NEW.environment_id, NEW.record_id;
  RETURN NEW; END
$provision_inventory_period_lock$;

CREATE FUNCTION north_star_internal.inventory_base_unit_change_allowed(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_item_id uuid,
  requested_unit_id text,
  requested_movement_table regclass,
  movement_item_column name,
  movement_unit_column name,
  movement_recorded_at_column name,
  movement_record_id_column name
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $inventory_base_unit_change_allowed$ DECLARE
  binding_movement_id uuid;
  binding_unit_id text;
  movement_owner text;
  movement_schema text; BEGIN
  IF session_user = 'north_star_module_runtime'
     AND (
       requested_tenant_id IS DISTINCT FROM
         nullif(current_setting('north_star.tenant_id', true), '')::uuid
       OR requested_environment_id IS DISTINCT FROM
         nullif(current_setting('north_star.environment_id', true), '')::uuid
     )
  THEN
    RAISE EXCEPTION 'INVENTORY_TRUSTED_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001',
            DETAIL = format(
              'tenantId=%s environmentId=%s',
              requested_tenant_id,
              requested_environment_id
            ); END IF;
  SELECT namespace.nspname, pg_get_userbyid(relation.relowner)
    INTO movement_schema, movement_owner
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE relation.oid = requested_movement_table
     AND relation.relkind = 'p';
  IF movement_schema IS DISTINCT FROM 'north_star_module'
     OR movement_owner IS DISTINCT FROM 'north_star_module_materializer'
  THEN
    RAISE EXCEPTION 'INVENTORY_MOVEMENT_RELATION_UNTRUSTED'
      USING ERRCODE = 'P0001'; END IF;
  EXECUTE format(
    'SELECT %1$I, %2$I::text FROM %3$s ' ||
    'WHERE tenant_id = $1 AND environment_id = $2 ' ||
    'AND %4$I::text = $3::text ' ||
    'ORDER BY %5$I, %1$I LIMIT 1',
    movement_record_id_column,
    movement_unit_column,
    requested_movement_table,
    movement_item_column,
    movement_recorded_at_column
  ) INTO binding_movement_id, binding_unit_id
    USING requested_tenant_id, requested_environment_id, requested_item_id;
  IF binding_movement_id IS NULL OR binding_unit_id = requested_unit_id THEN
    RETURN true; END IF;
  RAISE EXCEPTION 'INVENTORY_BASE_UNIT_IMMUTABLE'
    USING ERRCODE = 'P0001',
          DETAIL = format(
            'itemId=%s bindingMovementId=%s bindingUnitId=%s requestedUnitId=%s',
            requested_item_id,
            binding_movement_id,
            binding_unit_id,
            requested_unit_id
          ); END
$inventory_base_unit_change_allowed$;

CREATE FUNCTION north_star_internal.inventory_provisioned_legal_entity_id(
  requested_tenant_id uuid,
  requested_environment_id uuid
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $inventory_provisioned_legal_entity_id$ DECLARE
  provisioned_legal_entity_id uuid; BEGIN
  IF requested_tenant_id IS DISTINCT FROM
       nullif(current_setting('north_star.tenant_id', true), '')::uuid
     OR requested_environment_id IS DISTINCT FROM
       nullif(current_setting('north_star.environment_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'INVENTORY_TRUSTED_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001',
            DETAIL = format(
              'tenantId=%s environmentId=%s',
              requested_tenant_id,
              requested_environment_id
            ); END IF;
  SELECT configuration.legal_entity_id
    INTO provisioned_legal_entity_id
    FROM platform.inventory_posting_configurations AS configuration
   WHERE configuration.tenant_id = requested_tenant_id
     AND configuration.environment_id = requested_environment_id
   ORDER BY configuration.updated_at, configuration.legal_entity_id
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVENTORY_LEGAL_ENTITY_PROVISIONING_UNDECLARED'
      USING ERRCODE = 'P0001',
            DETAIL = format(
              'tenantId=%s environmentId=%s',
              requested_tenant_id,
              requested_environment_id
            ); END IF;
  RETURN provisioned_legal_entity_id; END
$inventory_provisioned_legal_entity_id$;

CREATE FUNCTION platform.load_inventory_posting_configuration(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_legal_entity_id uuid
) RETURNS TABLE (
  contract_release_root text,
  configuration_version smallint,
  negative_stock text,
  maximum_backdate_days integer,
  adjustment_reason_requirement text,
  transfer_reason_requirement text,
  count_reason_requirement text,
  correction_reason_requirement text,
  rebaseline_reason_requirement text,
  adjustment_approval_threshold numeric,
  transfer_approval_threshold numeric,
  count_approval_threshold numeric,
  correction_approval_threshold numeric,
  rebaseline_approval_threshold numeric,
  revision bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, platform
AS $load_inventory_posting_configuration$
  SELECT configuration.contract_release_root,
         configuration.configuration_version,
         configuration.negative_stock,
         configuration.maximum_backdate_days,
         configuration.adjustment_reason_requirement,
         configuration.transfer_reason_requirement,
         configuration.count_reason_requirement,
         configuration.correction_reason_requirement,
         configuration.rebaseline_reason_requirement,
         configuration.adjustment_approval_threshold,
         configuration.transfer_approval_threshold,
         configuration.count_approval_threshold,
         configuration.correction_approval_threshold,
         configuration.rebaseline_approval_threshold,
         configuration.revision
    FROM platform.inventory_posting_configurations AS configuration
   WHERE configuration.tenant_id = requested_tenant_id
     AND configuration.environment_id = requested_environment_id
     AND configuration.legal_entity_id = requested_legal_entity_id
$load_inventory_posting_configuration$;

CREATE FUNCTION platform.provision_inventory_scope(
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
SET search_path = pg_catalog, platform
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
  IF NOT EXISTS (
    SELECT 1 FROM platform.inventory_posting_configurations AS configuration
     WHERE configuration.tenant_id = requested_tenant_id
       AND configuration.environment_id = requested_environment_id
       AND configuration.legal_entity_id = requested_legal_entity_id
       AND configuration.contract_release_root = requested_contract_release_root
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
            ); END IF; END
$provision_inventory_scope$;

ALTER TABLE platform.inventory_tenant_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_tenant_calendars FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_posting_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_posting_configurations FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_tenant_calendars_select_trusted_context
  ON platform.inventory_tenant_calendars
  FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
  );
CREATE POLICY inventory_posting_configurations_select_trusted_context
  ON platform.inventory_posting_configurations
  FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );
REVOKE ALL ON platform.inventory_tenant_calendars FROM PUBLIC;
REVOKE ALL ON platform.inventory_posting_configurations FROM PUBLIC;
GRANT SELECT ON platform.inventory_tenant_calendars TO north_star_runtime;
GRANT SELECT ON platform.inventory_posting_configurations TO north_star_runtime;

REVOKE ALL ON FUNCTION
  north_star_internal.inventory_business_period(uuid, timestamptz),
  north_star_internal.inventory_base_unit_change_allowed(
    uuid, uuid, uuid, text, regclass, name, name, name, name
  ),
  north_star_internal.inventory_provisioned_legal_entity_id(uuid, uuid),
  north_star_internal.provision_inventory_period_lock(),
  north_star_internal.reserve_inventory_movement_effect(),
  north_star_internal.reject_inventory_fact_mutation(),
  platform.load_inventory_posting_configuration(uuid, uuid, uuid),
  platform.provision_inventory_scope(
    uuid, uuid, uuid, text, text, text, time without time zone, text,
    smallint, text, integer, text, text, text, text, text,
    numeric, numeric, numeric, numeric, numeric
  ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  north_star_internal.inventory_business_period(uuid, timestamptz)
  TO north_star_module_materializer, north_star_module_runtime,
     north_star_runtime;
GRANT EXECUTE ON FUNCTION
  north_star_internal.inventory_base_unit_change_allowed(
    uuid, uuid, uuid, text, regclass, name, name, name, name
  ) TO north_star_module_materializer, north_star_module_runtime;
GRANT EXECUTE ON FUNCTION
  north_star_internal.inventory_provisioned_legal_entity_id(uuid, uuid)
  TO north_star_module_materializer;
GRANT EXECUTE ON FUNCTION
  north_star_internal.provision_inventory_period_lock()
  TO north_star_module_materializer, north_star_module_runtime;
GRANT EXECUTE ON FUNCTION
  north_star_internal.reserve_inventory_movement_effect()
  TO north_star_module_materializer, north_star_module_runtime;
GRANT EXECUTE ON FUNCTION
  north_star_internal.reject_inventory_fact_mutation()
  TO north_star_module_materializer, north_star_module_runtime;
GRANT EXECUTE ON FUNCTION
  platform.load_inventory_posting_configuration(uuid, uuid, uuid)
  TO north_star_runtime;
