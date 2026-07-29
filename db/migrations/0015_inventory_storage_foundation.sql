CREATE TABLE platform.inventory_tenant_calendars (
  tenant_id uuid PRIMARY KEY REFERENCES platform.tenants (id),
  time_zone text NOT NULL,
  business_day_boundary time without time zone NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT inventory_tenant_calendars_zone_not_blank
    CHECK (btrim(time_zone) <> '')
);

CREATE TABLE platform.legal_entities (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  entity_code text NOT NULL,
  entity_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  is_default boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, legal_entity_id),
  CONSTRAINT legal_entities_environment_fkey
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES platform.environments (tenant_id, id),
  CONSTRAINT legal_entities_identity CHECK (
    legal_entity_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND btrim(entity_code) <> ''
    AND btrim(entity_name) <> ''
    AND status IN ('active', 'archived')
    AND ((status = 'active' AND archived_at IS NULL)
      OR (status = 'archived' AND archived_at IS NOT NULL))
  )
);
CREATE UNIQUE INDEX legal_entities_active_code_idx
  ON platform.legal_entities (
    tenant_id, environment_id, lower(entity_code)
  ) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX legal_entities_default_idx
  ON platform.legal_entities (tenant_id, environment_id)
  WHERE is_default AND archived_at IS NULL;

CREATE TABLE platform.inventory_period_locks (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  closed_through timestamptz,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, legal_entity_id),
  CONSTRAINT inventory_period_locks_legal_entity_fkey
    FOREIGN KEY (tenant_id, environment_id, legal_entity_id)
    REFERENCES platform.legal_entities (
      tenant_id, environment_id, legal_entity_id
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT inventory_period_locks_revision_positive CHECK (revision > 0)
);

CREATE TABLE platform.inventory_posting_configurations (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  contract_release_root text NOT NULL,
  configuration_version smallint NOT NULL DEFAULT 1,
  negative_stock text NOT NULL DEFAULT 'reject',
  maximum_backdate_days integer NOT NULL DEFAULT 0,
  adjustment_reason_requirement text NOT NULL DEFAULT 'codeAndNarrative',
  transfer_reason_requirement text NOT NULL DEFAULT 'codeOnly',
  count_reason_requirement text NOT NULL DEFAULT 'codeAndNarrative',
  correction_reason_requirement text NOT NULL DEFAULT 'codeAndNarrative',
  rebaseline_reason_requirement text NOT NULL DEFAULT 'codeAndNarrative',
  adjustment_approval_threshold numeric(38,18),
  transfer_approval_threshold numeric(38,18),
  count_approval_threshold numeric(38,18),
  correction_approval_threshold numeric(38,18),
  rebaseline_approval_threshold numeric(38,18),
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, environment_id, legal_entity_id),
  CONSTRAINT inventory_posting_configurations_legal_entity_fkey
    FOREIGN KEY (tenant_id, environment_id, legal_entity_id)
    REFERENCES platform.legal_entities (
      tenant_id, environment_id, legal_entity_id
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT inventory_posting_configurations_shape CHECK (
    contract_release_root ~ '^[0-9a-f]{64}$'
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

CREATE TABLE platform.inventory_transactions (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  transaction_number text NOT NULL,
  transaction_type text NOT NULL,
  state text NOT NULL DEFAULT 'draft',
  reason_code text,
  reason_narrative text,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  effective_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  actor_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (
    tenant_id, environment_id, legal_entity_id, transaction_id
  ),
  CONSTRAINT inventory_transactions_legal_entity_fkey
    FOREIGN KEY (tenant_id, environment_id, legal_entity_id)
    REFERENCES platform.legal_entities (
      tenant_id, environment_id, legal_entity_id
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT inventory_transactions_shape CHECK (
    transaction_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND source_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND actor_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND btrim(transaction_number) <> ''
    AND transaction_type IN (
      'opening', 'adjustment', 'transfer', 'countCorrection', 'reBaseline'
    )
    AND state IN ('draft', 'posted', 'reversed')
    AND btrim(source_type) <> ''
    AND (reason_code IS NULL OR btrim(reason_code) <> '')
    AND (reason_narrative IS NULL OR btrim(reason_narrative) <> '')
    AND revision > 0
  )
);
CREATE UNIQUE INDEX inventory_transactions_number_idx
  ON platform.inventory_transactions (
    tenant_id, environment_id, legal_entity_id, transaction_number
  );

CREATE TABLE platform.inventory_transaction_lines (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  transaction_line_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  line_number integer NOT NULL,
  item_id uuid NOT NULL,
  from_location_id uuid,
  to_location_id uuid,
  quantity numeric(38,18) NOT NULL,
  unit_id text NOT NULL,
  PRIMARY KEY (
    tenant_id, environment_id, legal_entity_id, transaction_line_id
  ),
  CONSTRAINT inventory_transaction_lines_transaction_fkey
    FOREIGN KEY (
      tenant_id, environment_id, legal_entity_id, transaction_id
    ) REFERENCES platform.inventory_transactions (
      tenant_id, environment_id, legal_entity_id, transaction_id
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT inventory_transaction_lines_shape CHECK (
    transaction_line_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND item_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND (from_location_id IS NULL
      OR from_location_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    AND (to_location_id IS NULL
      OR to_location_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    AND (from_location_id IS NOT NULL OR to_location_id IS NOT NULL)
    AND from_location_id IS DISTINCT FROM to_location_id
    AND line_number > 0
    AND quantity > 0
    AND btrim(unit_id) <> ''
  ),
  CONSTRAINT inventory_transaction_lines_number_unique UNIQUE (
    tenant_id, environment_id, legal_entity_id, transaction_id, line_number
  )
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
  IF session_user = 'north_star_runtime'
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
            COALESCE(OLD.movement_id::text, 'unknown')
          ); END
$reject_inventory_fact_mutation$;

CREATE TABLE platform.inventory_movements (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  business_period date NOT NULL,
  movement_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  transaction_line_id uuid NOT NULL,
  stock_dimension_set_version text NOT NULL,
  item_id uuid NOT NULL,
  location_id uuid NOT NULL,
  quantity_delta numeric(38,18) NOT NULL,
  unit_id text NOT NULL,
  effective_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  source_line text NOT NULL,
  revision bigint NOT NULL,
  posting_role text NOT NULL,
  reason_code text,
  reason_narrative text,
  actor_id uuid NOT NULL,
  reversal_of_movement_id uuid,
  PRIMARY KEY (
    tenant_id,
    business_period,
    environment_id,
    legal_entity_id,
    movement_id
  ),
  CONSTRAINT inventory_movements_effect_identity_unique UNIQUE (
    tenant_id,
    business_period,
    environment_id,
    legal_entity_id,
    movement_id,
    source_type,
    source_id,
    source_line,
    revision,
    posting_role
  ),
  CONSTRAINT inventory_movements_transaction_fkey
    FOREIGN KEY (
      tenant_id, environment_id, legal_entity_id, transaction_id
    ) REFERENCES platform.inventory_transactions (
      tenant_id, environment_id, legal_entity_id, transaction_id
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT inventory_movements_transaction_line_fkey
    FOREIGN KEY (
      tenant_id, environment_id, legal_entity_id, transaction_line_id
    ) REFERENCES platform.inventory_transaction_lines (
      tenant_id, environment_id, legal_entity_id, transaction_line_id
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT inventory_movements_shape CHECK (
    movement_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND item_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND location_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND source_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND actor_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND stock_dimension_set_version = 'v1'
    AND quantity_delta <> 0
    AND btrim(unit_id) <> ''
    AND btrim(source_type) <> ''
    AND btrim(source_line) <> ''
    AND revision > 0
    AND posting_role IN (
      'adjustment', 'transfer', 'count', 'correction', 'reBaseline'
    )
    AND (reason_code IS NULL OR btrim(reason_code) <> '')
    AND (reason_narrative IS NULL OR btrim(reason_narrative) <> '')
    AND (reversal_of_movement_id IS NULL
      OR reversal_of_movement_id <>
        '00000000-0000-0000-0000-000000000000'::uuid)
    AND business_period = north_star_internal.inventory_business_period(
      tenant_id, effective_at
    )
  )
) PARTITION BY HASH (tenant_id, business_period);

CREATE TABLE platform.inventory_movements_p0
  PARTITION OF platform.inventory_movements
  FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE platform.inventory_movements_p1
  PARTITION OF platform.inventory_movements
  FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE platform.inventory_movements_p2
  PARTITION OF platform.inventory_movements
  FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE platform.inventory_movements_p3
  PARTITION OF platform.inventory_movements
  FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE platform.inventory_movements_p4
  PARTITION OF platform.inventory_movements
  FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE platform.inventory_movements_p5
  PARTITION OF platform.inventory_movements
  FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE platform.inventory_movements_p6
  PARTITION OF platform.inventory_movements
  FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE platform.inventory_movements_p7
  PARTITION OF platform.inventory_movements
  FOR VALUES WITH (MODULUS 8, REMAINDER 7);

CREATE INDEX inventory_movements_stock_horizon_idx
  ON platform.inventory_movements (
    tenant_id,
    environment_id,
    legal_entity_id,
    item_id,
    location_id,
    effective_at,
    recorded_at
  );

CREATE TRIGGER inventory_movements_reject_mutation
BEFORE UPDATE OR DELETE ON platform.inventory_movements
FOR EACH ROW EXECUTE FUNCTION
  north_star_internal.reject_inventory_fact_mutation();

CREATE TABLE platform.inventory_movement_effects (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  source_line text NOT NULL,
  revision bigint NOT NULL,
  posting_role text NOT NULL,
  business_period date NOT NULL,
  movement_id uuid NOT NULL,
  PRIMARY KEY (
    tenant_id,
    environment_id,
    legal_entity_id,
    source_type,
    source_id,
    source_line,
    revision,
    posting_role
  ),
  CONSTRAINT inventory_movement_effects_movement_unique UNIQUE (
    tenant_id, environment_id, legal_entity_id, movement_id
  ),
  CONSTRAINT inventory_movement_effects_movement_fkey
    FOREIGN KEY (
      tenant_id,
      business_period,
      environment_id,
      legal_entity_id,
      movement_id,
      source_type,
      source_id,
      source_line,
      revision,
      posting_role
    ) REFERENCES platform.inventory_movements (
      tenant_id,
      business_period,
      environment_id,
      legal_entity_id,
      movement_id,
      source_type,
      source_id,
      source_line,
      revision,
      posting_role
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT inventory_movement_effects_shape CHECK (
    btrim(source_type) <> ''
    AND source_id <> '00000000-0000-0000-0000-000000000000'::uuid
    AND btrim(source_line) <> ''
    AND revision > 0
    AND posting_role IN (
      'adjustment', 'transfer', 'count', 'correction', 'reBaseline'
    )
  )
);

CREATE TRIGGER inventory_movement_effects_reject_mutation
BEFORE UPDATE OR DELETE ON platform.inventory_movement_effects
FOR EACH ROW EXECUTE FUNCTION
  north_star_internal.reject_inventory_fact_mutation();

CREATE FUNCTION north_star_internal.inventory_base_unit_change_allowed(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_item_id uuid,
  requested_unit_id text
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $inventory_base_unit_change_allowed$ DECLARE
  binding_movement_id uuid;
  binding_unit_id text; BEGIN
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
  SELECT movement.movement_id, movement.unit_id
    INTO binding_movement_id, binding_unit_id
    FROM platform.inventory_movements AS movement
   WHERE movement.tenant_id = requested_tenant_id
     AND movement.environment_id = requested_environment_id
     AND movement.item_id = requested_item_id
   ORDER BY movement.recorded_at, movement.movement_id
   LIMIT 1;
  IF NOT FOUND OR binding_unit_id = requested_unit_id THEN
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

-- Upgrade already-materialized Catalog item tables. New item tables receive
-- the same named constraint from the module storage materializer.
DO $inventory_base_unit_constraints$ DECLARE
  base_unit_column text;
  constraint_name text;
  storage_entity jsonb;
  storage_payload jsonb;
  table_name text; BEGIN
  FOR storage_payload IN
    SELECT convert_from(blob.canonical_bytes, 'UTF8')::jsonb
      FROM platform.release_artifact_blobs AS blob
     WHERE blob.artifact_kind = 'projectionChunk'
       AND convert_from(blob.canonical_bytes, 'UTF8')::jsonb ->> 'kind'
         = 'storageTargetPayload'
  LOOP
    FOR storage_entity IN
      SELECT entity
        FROM jsonb_array_elements(storage_payload -> 'entities') AS entity
       WHERE entity ->> 'entityId' LIKE '%:entity.item'
    LOOP
      SELECT column_record ->> 'physicalName'
        INTO base_unit_column
        FROM jsonb_array_elements(storage_entity -> 'columns') AS column_record
       WHERE column_record ->> 'canonicalFieldId'
         LIKE '%:field.item_base_unit';
      table_name := storage_entity ->> 'physicalTableName';
      IF base_unit_column IS NULL
         OR table_name !~ '^nsm_t_[a-z2-7]{52}$'
         OR to_regclass(format('north_star_module.%I', table_name)) IS NULL
      THEN
        CONTINUE; END IF;
      constraint_name := 'nsm_b_' || substring(table_name FROM 7);
      IF EXISTS (
        SELECT 1
          FROM pg_constraint AS constraint_record
          JOIN pg_class AS relation
            ON relation.oid = constraint_record.conrelid
          JOIN pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'north_star_module'
           AND relation.relname = table_name
           AND constraint_record.conname = constraint_name
      ) THEN
        CONTINUE; END IF;
      EXECUTE format(
        'ALTER TABLE north_star_module.%I ADD CONSTRAINT %I CHECK (' ||
        'north_star_internal.inventory_base_unit_change_allowed(' ||
        'tenant_id, environment_id, record_id, %I))',
        table_name,
        constraint_name,
        base_unit_column
      ); END LOOP; END LOOP; END
$inventory_base_unit_constraints$;

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
  requested_contract_release_root text
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

  INSERT INTO platform.legal_entities (
    tenant_id,
    environment_id,
    legal_entity_id,
    entity_code,
    entity_name,
    status,
    is_default
  ) VALUES (
    requested_tenant_id,
    requested_environment_id,
    requested_legal_entity_id,
    requested_entity_code,
    requested_entity_name,
    'active',
    true
  ) ON CONFLICT (tenant_id, environment_id, legal_entity_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM platform.legal_entities AS entity
     WHERE entity.tenant_id = requested_tenant_id
       AND entity.environment_id = requested_environment_id
       AND entity.legal_entity_id = requested_legal_entity_id
       AND entity.entity_code = requested_entity_code
       AND entity.entity_name = requested_entity_name
       AND entity.status = 'active'
       AND entity.is_default
       AND entity.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'INVENTORY_LEGAL_ENTITY_PROVISIONING_CONFLICT'
      USING ERRCODE = 'P0001',
            DETAIL = format(
              'tenantId=%s environmentId=%s legalEntityId=%s',
              requested_tenant_id,
              requested_environment_id,
              requested_legal_entity_id
            ); END IF;

  INSERT INTO platform.inventory_period_locks (
    tenant_id, environment_id, legal_entity_id, closed_through
  ) VALUES (
    requested_tenant_id,
    requested_environment_id,
    requested_legal_entity_id,
    NULL
  ) ON CONFLICT (tenant_id, environment_id, legal_entity_id) DO NOTHING;

  INSERT INTO platform.inventory_posting_configurations (
    tenant_id,
    environment_id,
    legal_entity_id,
    contract_release_root
  ) VALUES (
    requested_tenant_id,
    requested_environment_id,
    requested_legal_entity_id,
    requested_contract_release_root
  ) ON CONFLICT (tenant_id, environment_id, legal_entity_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM platform.inventory_posting_configurations AS configuration
     WHERE configuration.tenant_id = requested_tenant_id
       AND configuration.environment_id = requested_environment_id
       AND configuration.legal_entity_id = requested_legal_entity_id
       AND configuration.contract_release_root = requested_contract_release_root
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
ALTER TABLE platform.legal_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.legal_entities FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_period_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_period_locks FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_posting_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_posting_configurations FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_transaction_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_transaction_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_movement_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.inventory_movement_effects FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_tenant_calendars_select_trusted_context
  ON platform.inventory_tenant_calendars
  FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
  );
CREATE POLICY legal_entities_select_trusted_context
  ON platform.legal_entities
  FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );
CREATE POLICY inventory_period_locks_select_trusted_context
  ON platform.inventory_period_locks
  FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );
CREATE POLICY inventory_posting_configurations_select_trusted_context
  ON platform.inventory_posting_configurations
  FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );
CREATE POLICY inventory_transactions_select_trusted_context
  ON platform.inventory_transactions
  FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );
CREATE POLICY inventory_transaction_lines_select_trusted_context
  ON platform.inventory_transaction_lines
  FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );
CREATE POLICY inventory_movements_select_trusted_context
  ON platform.inventory_movements
  FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );
CREATE POLICY inventory_movement_effects_select_trusted_context
  ON platform.inventory_movement_effects
  FOR SELECT TO north_star_runtime
  USING (
    tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
  );

REVOKE ALL ON platform.inventory_tenant_calendars FROM PUBLIC;
REVOKE ALL ON platform.legal_entities FROM PUBLIC;
REVOKE ALL ON platform.inventory_period_locks FROM PUBLIC;
REVOKE ALL ON platform.inventory_posting_configurations FROM PUBLIC;
REVOKE ALL ON platform.inventory_transactions FROM PUBLIC;
REVOKE ALL ON platform.inventory_transaction_lines FROM PUBLIC;
REVOKE ALL ON platform.inventory_movements FROM PUBLIC;
REVOKE ALL ON platform.inventory_movement_effects FROM PUBLIC;
GRANT SELECT ON platform.inventory_tenant_calendars TO north_star_runtime;
GRANT SELECT ON platform.legal_entities TO north_star_runtime;
GRANT SELECT ON platform.inventory_period_locks TO north_star_runtime;
GRANT SELECT ON platform.inventory_posting_configurations TO north_star_runtime;
GRANT SELECT ON platform.inventory_transactions TO north_star_runtime;
GRANT SELECT ON platform.inventory_transaction_lines TO north_star_runtime;
GRANT SELECT ON platform.inventory_movements TO north_star_runtime;
GRANT SELECT ON platform.inventory_movement_effects TO north_star_runtime;

REVOKE ALL ON FUNCTION
  north_star_internal.inventory_business_period(uuid, timestamptz),
  north_star_internal.inventory_base_unit_change_allowed(uuid, uuid, uuid, text),
  north_star_internal.reject_inventory_fact_mutation(),
  platform.load_inventory_posting_configuration(uuid, uuid, uuid),
  platform.provision_inventory_scope(
    uuid, uuid, uuid, text, text, text, time without time zone, text
  ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  north_star_internal.inventory_business_period(uuid, timestamptz)
  TO north_star_runtime;
GRANT EXECUTE ON FUNCTION
  north_star_internal.inventory_base_unit_change_allowed(uuid, uuid, uuid, text)
  TO north_star_module_materializer, north_star_module_runtime;
GRANT EXECUTE ON FUNCTION
  platform.load_inventory_posting_configuration(uuid, uuid, uuid)
  TO north_star_runtime;

GRANT USAGE ON SCHEMA platform TO north_star_module_materializer;
GRANT REFERENCES ON platform.legal_entities TO north_star_module_materializer;
