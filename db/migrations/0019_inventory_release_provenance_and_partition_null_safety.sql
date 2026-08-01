-- Inventory scope provisioning separates provenance from policy, and the
-- exact-partition CHECK stops admitting a NULL expression.
--
-- 1. `platform.provision_inventory_scope` was provision-or-assert-identical
--    across every column. That is correct for business POLICY (negative stock,
--    backdate window, reason requirements, approval thresholds): changing one
--    must be a deliberate act, never a side effect of shipping a release. It is
--    wrong for `contract_release_root`, which is PROVENANCE -- it names the
--    compiled contract the scope runs against and advances whenever the product
--    advances. Asserting it made release advancement impossible for an
--    already-provisioned tenant. It is now removed from the assert-identical set
--    and UPDATEd to the requested value instead, so the stored row stays
--    truthful by advancing. No policy field gains an update path, the requested
--    root is still format-validated, and INVENTORY_POSTING_CONFIGURATION_CONFLICT
--    keeps its errcode and DETAIL. The assertion runs BEFORE the advancement, so
--    a conflicting request raises with the stored provenance untouched.
--
-- 2. `release_verification_evidence_exact_partition` compared
--    `jsonb_typeof(impact_analysis_derivation)` without first establishing that
--    the column is non-NULL. With version v2 and scope EXACT_PARTITION the v1
--    arm is FALSE and the v2 arm evaluates to NULL, and a SQL CHECK admits NULL.
--    An EXACT_PARTITION header with no derivation document therefore stored
--    cleanly. The v2 arm now opens with an IS NOT NULL test, so the arm is FALSE
--    rather than NULL and the row is rejected. The v1 arm is unchanged.

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

ALTER TABLE platform.release_verification_evidence
  DROP CONSTRAINT release_verification_evidence_exact_partition;

ALTER TABLE platform.release_verification_evidence
  ADD CONSTRAINT release_verification_evidence_exact_partition CHECK (
    result_count >= 0
    AND provider = 'realPostgresql'
    AND btrim(provider_run_id) <> ''
    AND executed_evidence_id IS NOT NULL
    AND skipped_scenario_ids = '[]'::jsonb
    AND (
      (
        evidence_version = 'northstar.verification-result-set/v1'
        AND execution_scope = 'FULL'
        AND impact_analysis_derivation IS NULL
      )
      OR
      (
        impact_analysis_derivation IS NOT NULL
        AND evidence_version = 'northstar.verification-result-set/v2'
        AND execution_scope = 'EXACT_PARTITION'
        AND jsonb_typeof(impact_analysis_derivation) = 'object'
        AND impact_analysis_derivation ? 'schemaVersion'
        AND impact_analysis_derivation ? 'derivations'
        AND impact_analysis_derivation - 'schemaVersion' - 'derivations' =
          '{}'::jsonb
        AND impact_analysis_derivation ->> 'schemaVersion' =
          'northstar.verification-impact-analysis/v1'
        AND jsonb_typeof(
          impact_analysis_derivation -> 'derivations'
        ) = 'array'
        AND jsonb_array_length(
          impact_analysis_derivation -> 'derivations'
        ) > 0
      )
    )
  );
