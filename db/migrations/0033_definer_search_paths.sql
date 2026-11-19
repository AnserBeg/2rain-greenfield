-- Put the temporary schema last for all migration-owned security definers.
-- Replacing each function in place retains its identity, owner and grants.

CREATE OR REPLACE FUNCTION north_star_internal.advance_semantic_aggregate_generation(
  requested_tenant_id uuid,
  requested_environment_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, north_star_internal, pg_temp
AS $advance_semantic_aggregate_generation$ BEGIN
  IF session_user IN (
       'north_star_runtime',
       'north_star_module_runtime',
       'north_star_module_materializer'
     )
     AND (
       requested_tenant_id IS DISTINCT FROM
         nullif(current_setting('north_star.tenant_id', true), '')::uuid
       OR requested_environment_id IS DISTINCT FROM
         nullif(current_setting('north_star.environment_id', true), '')::uuid
     )
  THEN
    RAISE EXCEPTION 'SEMANTIC_AGGREGATE_GENERATION_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001',
            DETAIL = format(
              'tenantId=%s environmentId=%s',
              requested_tenant_id,
              requested_environment_id
            ); END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      format(
        'northstar.semantic-aggregate-generation/v1:%s:%s',
        requested_tenant_id,
        requested_environment_id
      ),
      0
    )
  );

  INSERT INTO north_star_internal.semantic_aggregate_generations AS generation (
    tenant_id,
    environment_id,
    movement_generation
  ) VALUES (
    requested_tenant_id,
    requested_environment_id,
    1
  )
  ON CONFLICT (tenant_id, environment_id) DO UPDATE
    SET movement_generation = generation.movement_generation + 1; END
$advance_semantic_aggregate_generation$;

CREATE OR REPLACE FUNCTION north_star_internal.inventory_base_unit_change_allowed(
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
SET search_path = pg_catalog, platform, pg_temp
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

CREATE OR REPLACE FUNCTION north_star_internal.inventory_provisioned_legal_entity_id(
  requested_tenant_id uuid,
  requested_environment_id uuid
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, platform, pg_temp
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

CREATE OR REPLACE FUNCTION north_star_internal.module_storage_lock_backfill_attempt(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_activation_attempt_id uuid,
  requested_preparation_id uuid
)
RETURNS TABLE (authorized boolean)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT true
   WHERE EXISTS (
     SELECT approved
       FROM north_star_internal.module_storage_read_approved_attempt(
         requested_tenant_id,
         requested_environment_id,
         requested_activation_attempt_id,
         requested_preparation_id
       )
   )
$$;

CREATE OR REPLACE FUNCTION north_star_internal.module_storage_read_active_release_pointer(
  requested_tenant_id uuid,
  requested_environment_id uuid
)
RETURNS TABLE (fence bigint, release_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pointer.fence, pointer.release_id
    FROM platform.active_release_pointers AS pointer
   WHERE requested_tenant_id IS NOT NULL
     AND requested_environment_id IS NOT NULL
     AND requested_tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND requested_environment_id =
           nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND pointer.tenant_id = requested_tenant_id
     AND pointer.environment_id = requested_environment_id
$$;

CREATE OR REPLACE FUNCTION north_star_internal.module_storage_read_approved_attempt(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_activation_attempt_id uuid,
  requested_preparation_id uuid
)
RETURNS TABLE (approved boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ BEGIN
  PERFORM 1
    FROM platform.release_activation_authority_epochs AS epoch
   WHERE epoch.tenant_id = requested_tenant_id
   FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM 1
    FROM platform.release_activation_attempts AS attempt
   WHERE attempt.tenant_id = requested_tenant_id
     AND attempt.environment_id = requested_environment_id
     AND attempt.activation_attempt_id = requested_activation_attempt_id
   FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT true AS approved
    FROM platform.release_activation_attempts AS attempt
    JOIN platform.release_approvals AS approval
      ON approval.tenant_id = attempt.tenant_id
     AND approval.environment_id = attempt.environment_id
     AND approval.approval_id = attempt.approval_id
     AND approval.activation_attempt_id = attempt.activation_attempt_id
    JOIN platform.release_activation_authority_epochs AS epoch
      ON epoch.tenant_id = attempt.tenant_id
   WHERE requested_tenant_id IS NOT NULL
     AND requested_environment_id IS NOT NULL
     AND requested_activation_attempt_id IS NOT NULL
     AND requested_preparation_id IS NOT NULL
     AND requested_tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND requested_environment_id =
           nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND attempt.tenant_id = requested_tenant_id
     AND attempt.environment_id = requested_environment_id
     AND attempt.activation_attempt_id = requested_activation_attempt_id
     AND attempt.attempt_contract_version =
           'northstar.release-activation-attempt/v1'
     AND attempt.execution_principal_kind = 'SYSTEM'
     AND attempt.execution_principal_id =
           '00000000-0000-4000-8000-000000000001'::uuid
     AND attempt.attempt_state = 'PREBOUND'
     AND approval.approval_contract_version = 'northstar.release-approval/v1'
     AND approval.authority_policy_contract_version =
           'northstar.release-approver-authority/v1'
     AND approval.expiry_policy_version = 'northstar.release-approval-expiry/v1'
     AND approval.compatibility_policy_version =
           'northstar.transition-compatibility-policy/v2'
     AND approval.preparation_id = requested_preparation_id
     AND approval.approving_human_id <> attempt.execution_principal_id
     AND clock_timestamp() < approval.expires_at - interval '3 seconds'
     AND epoch.approver_policy_version = approval.authority_policy_version
     AND (
       SELECT event.eligible
         FROM platform.release_approver_eligibility_events AS event
        WHERE event.tenant_id = attempt.tenant_id
          AND event.principal_id = approval.approving_human_id
          AND event.authority_policy_contract_version =
                'northstar.release-approver-authority/v1'
        ORDER BY event.policy_version DESC
        LIMIT 1
     ) IS TRUE
     AND (
       SELECT event.authorized
         FROM platform.release_executor_authority_events AS event
        WHERE event.tenant_id = attempt.tenant_id
          AND event.principal_id = attempt.execution_principal_id
          AND event.authority_policy_contract_version =
                'northstar.release-executor-authority/v1'
        ORDER BY event.policy_version DESC
        LIMIT 1
     ) IS TRUE
     AND NOT EXISTS (
       SELECT 1
         FROM (
           SELECT DISTINCT ON (control.rollout_id)
                  control.live_policy_denied,
                  control.rollout_paused,
                  control.control_policy_contract_version
             FROM platform.release_activation_control_events AS control
            WHERE control.tenant_id = attempt.tenant_id
              AND control.environment_id = attempt.environment_id
              AND (
                control.rollout_id IS NULL
                OR control.rollout_id IS NOT DISTINCT FROM approval.rollout_id
              )
            ORDER BY control.rollout_id, control.policy_version DESC
         ) AS current_control
        WHERE current_control.live_policy_denied
           OR current_control.rollout_paused
           OR current_control.control_policy_contract_version <>
                'northstar.release-activation-control/v1'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM platform.release_activation_attempt_outcomes AS outcome
        WHERE outcome.tenant_id = attempt.tenant_id
          AND outcome.environment_id = attempt.environment_id
          AND outcome.activation_attempt_id = attempt.activation_attempt_id
          AND (
            outcome.terminal
            OR outcome.workflow_disposition = 'CONSUMED'
            OR outcome.workflow_status IN ('PAUSED', 'FAILED', 'CANCELLED', 'SUCCEEDED')
          )
     )
     AND NOT EXISTS (
       SELECT 1
         FROM platform.release_activation_history AS history
        WHERE history.tenant_id = attempt.tenant_id
          AND history.environment_id = attempt.environment_id
          AND history.activation_attempt_id = attempt.activation_attempt_id
          AND (
            history.terminal
            OR history.workflow_disposition = 'CONSUMED'
            OR history.workflow_status IN ('PAUSED', 'FAILED', 'CANCELLED', 'SUCCEEDED')
          )
     ); END $$;

CREATE OR REPLACE FUNCTION north_star_internal.module_storage_read_kernel_live_roots(
  requested_tenant_id uuid,
  requested_environment_id uuid
)
RETURNS TABLE (release_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pointer.release_id
    FROM platform.active_release_pointers AS pointer
   WHERE requested_tenant_id IS NOT NULL
     AND requested_environment_id IS NOT NULL
     AND requested_tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND requested_environment_id =
           nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND pointer.tenant_id = requested_tenant_id
     AND pointer.environment_id = requested_environment_id
     AND pointer.release_id IS NOT NULL
  UNION
  SELECT preparation.target_release_id
    FROM platform.release_activation_preparations AS preparation
   WHERE requested_tenant_id IS NOT NULL
     AND requested_environment_id IS NOT NULL
     AND requested_tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND requested_environment_id =
           nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND preparation.tenant_id = requested_tenant_id
     AND preparation.environment_id = requested_environment_id
     AND (
       NOT EXISTS (
         SELECT 1
           FROM platform.release_approvals AS approval
          WHERE approval.tenant_id = preparation.tenant_id
            AND approval.environment_id = preparation.environment_id
            AND approval.preparation_id = preparation.preparation_id
       )
       OR EXISTS (
         SELECT 1
           FROM platform.release_approvals AS approval
          WHERE approval.tenant_id = preparation.tenant_id
            AND approval.environment_id = preparation.environment_id
            AND approval.preparation_id = preparation.preparation_id
            AND NOT EXISTS (
              SELECT 1
                FROM platform.release_activation_attempt_outcomes AS outcome
               WHERE outcome.tenant_id = approval.tenant_id
                 AND outcome.environment_id = approval.environment_id
                 AND outcome.activation_attempt_id =
                       approval.activation_attempt_id
                 AND (
                   outcome.terminal
                   OR outcome.workflow_disposition = 'CONSUMED'
                 )
            )
            AND NOT EXISTS (
              SELECT 1
                FROM platform.release_activation_history AS history
               WHERE history.tenant_id = approval.tenant_id
                 AND history.environment_id = approval.environment_id
                 AND (
                   history.approval_id = approval.approval_id
                   OR history.activation_attempt_id =
                        approval.activation_attempt_id
                 )
                 AND (
                   history.terminal
                   OR history.workflow_disposition = 'CONSUMED'
                 )
            )
       )
     )
$$;

CREATE OR REPLACE FUNCTION north_star_internal.module_storage_read_preparation_authority(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_principal_id uuid
)
RETURNS TABLE (authorized boolean, denied boolean, paused boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce((
           SELECT event.authorized
             FROM platform.release_executor_authority_events AS event
            WHERE event.tenant_id = requested_tenant_id
              AND event.principal_id = requested_principal_id
            ORDER BY event.policy_version DESC
            LIMIT 1
         ), false),
         coalesce((
           SELECT event.live_policy_denied
             FROM platform.release_activation_control_events AS event
            WHERE event.tenant_id = requested_tenant_id
              AND event.environment_id = requested_environment_id
            ORDER BY event.policy_version DESC
            LIMIT 1
         ), false),
         coalesce((
           SELECT event.rollout_paused
             FROM platform.release_activation_control_events AS event
            WHERE event.tenant_id = requested_tenant_id
              AND event.environment_id = requested_environment_id
            ORDER BY event.policy_version DESC
            LIMIT 1
         ), false)
   WHERE requested_tenant_id IS NOT NULL
     AND requested_environment_id IS NOT NULL
     AND requested_principal_id IS NOT NULL
     AND requested_tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND requested_environment_id =
           nullif(current_setting('north_star.environment_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION north_star_internal.module_storage_read_release_artifacts(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_release_id uuid
)
RETURNS TABLE (
  release_content_hash text,
  artifact_kind text,
  content_hash text,
  domain_tag text,
  canonical_bytes bytea
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH scoped_release AS MATERIALIZED (
    SELECT release.content_hash
      FROM platform.tenant_releases AS release
     WHERE requested_tenant_id IS NOT NULL
       AND requested_environment_id IS NOT NULL
       AND requested_release_id IS NOT NULL
       AND requested_tenant_id =
             nullif(current_setting('north_star.tenant_id', true), '')::uuid
       AND requested_environment_id =
             nullif(current_setting('north_star.environment_id', true), '')::uuid
       AND release.tenant_id = requested_tenant_id
       AND release.environment_id = requested_environment_id
       AND release.release_id = requested_release_id
  )
  SELECT release.content_hash,
         blob.artifact_kind,
         blob.content_hash,
         blob.domain_tag,
         blob.canonical_bytes
    FROM scoped_release AS release
    JOIN platform.release_artifact_blobs AS blob
      ON blob.content_hash = release.content_hash
  UNION ALL
  SELECT release.content_hash,
         blob.artifact_kind,
         blob.content_hash,
         blob.domain_tag,
         blob.canonical_bytes
    FROM scoped_release AS release
    JOIN platform.tenant_release_artifact_links AS link
      ON link.tenant_id = requested_tenant_id
     AND link.environment_id = requested_environment_id
     AND link.release_id = requested_release_id
    JOIN platform.release_artifact_blobs AS blob
      ON blob.content_hash = link.content_hash
     AND blob.artifact_kind = link.artifact_kind
   ORDER BY 3
$$;

CREATE OR REPLACE FUNCTION north_star_internal.provision_inventory_period_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
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

CREATE OR REPLACE FUNCTION north_star_internal.witness_module_fold_function_ddl()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $witness$ DECLARE
  command_record record;
  current_definition text;
  witnessed_definition text; BEGIN
  FOR command_record IN
    SELECT command.classid, command.objid
    FROM pg_catalog.pg_event_trigger_ddl_commands() AS command
  LOOP
    IF command_record.classid <> 'pg_catalog.pg_proc'::pg_catalog.regclass THEN
      CONTINUE; END IF;

    SELECT pg_catalog.pg_get_functiondef(routine.oid)
      INTO current_definition
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = routine.pronamespace
     WHERE routine.oid = command_record.objid
       AND namespace.nspname = 'north_star_module'
       AND routine.proname = 'nsm_unicode_case_fold_v1'
       AND pg_catalog.pg_get_function_identity_arguments(routine.oid) = 'value text';

    IF NOT FOUND THEN
      CONTINUE; END IF;

    INSERT INTO north_star_internal.module_fold_function_ddl_witnesses (
      function_identity,
      function_definition
    ) VALUES (
      'north_star_module.nsm_unicode_case_fold_v1(value text)',
      current_definition
    )
    ON CONFLICT (function_identity) DO NOTHING;

    SELECT witness.function_definition
      INTO STRICT witnessed_definition
      FROM north_star_internal.module_fold_function_ddl_witnesses AS witness
     WHERE witness.function_identity =
       'north_star_module.nsm_unicode_case_fold_v1(value text)';

    IF witnessed_definition IS DISTINCT FROM current_definition THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE =
          'north_star_module.nsm_unicode_case_fold_v1(value text) is versioned and immutable',
        HINT = 'Mint a new function name and an accounted storage transition.'; END IF; END LOOP; END;
$witness$;

CREATE OR REPLACE FUNCTION platform.bump_current_policy_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, platform, pg_temp
AS $$ DECLARE
  first_tenant uuid;
  first_environment uuid;
  second_tenant uuid;
  second_environment uuid; BEGIN
  IF TG_OP = 'INSERT' THEN
    first_tenant := NEW.tenant_id;
    first_environment := NEW.environment_id;
  ELSIF TG_OP = 'DELETE' OR (
    NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id AND
    NEW.environment_id IS NOT DISTINCT FROM OLD.environment_id
  ) THEN
    first_tenant := OLD.tenant_id;
    first_environment := OLD.environment_id;
  ELSIF (OLD.tenant_id, OLD.environment_id) <
        (NEW.tenant_id, NEW.environment_id) THEN
    first_tenant := OLD.tenant_id;
    first_environment := OLD.environment_id;
    second_tenant := NEW.tenant_id;
    second_environment := NEW.environment_id;
  ELSE
    first_tenant := NEW.tenant_id;
    first_environment := NEW.environment_id;
    second_tenant := OLD.tenant_id;
    second_environment := OLD.environment_id; END IF;
  INSERT INTO platform.current_policy_epochs (
    tenant_id, environment_id, policy_version
  ) VALUES (first_tenant, first_environment, 1)
  ON CONFLICT (tenant_id, environment_id)
  DO UPDATE SET policy_version = current_policy_epochs.policy_version + 1,
                updated_at = transaction_timestamp();
  IF second_tenant IS NOT NULL THEN
    INSERT INTO platform.current_policy_epochs (
      tenant_id, environment_id, policy_version
    ) VALUES (second_tenant, second_environment, 1)
    ON CONFLICT (tenant_id, environment_id)
    DO UPDATE SET policy_version = current_policy_epochs.policy_version + 1,
                  updated_at = transaction_timestamp(); END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD; END IF;
  RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION platform.create_active_release_pointer_for_environment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ BEGIN
  INSERT INTO platform.active_release_pointers (
    tenant_id,
    environment_id,
    pointer_id,
    release_id,
    fence
  ) VALUES (NEW.tenant_id, NEW.id, gen_random_uuid(), NULL, 0);
  RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION platform.create_release_activation_authority_epoch_for_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ BEGIN
  INSERT INTO platform.release_activation_authority_epochs (tenant_id)
  VALUES (NEW.id);
  RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION platform.lock_current_policy_epoch(
  requested_tenant_id uuid,
  requested_environment_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, platform, pg_temp
AS $$ DECLARE
  locked_version text; BEGIN
  IF nullif(current_setting('north_star.principal_id', true), '')::uuid IS NULL OR
     requested_tenant_id IS DISTINCT FROM
       nullif(current_setting('north_star.tenant_id', true), '')::uuid OR
     requested_environment_id IS DISTINCT FROM
       nullif(current_setting('north_star.environment_id', true), '')::uuid THEN
    RAISE EXCEPTION 'current policy epoch scope must be the trusted session scope'
      USING ERRCODE = '42501'; END IF;
  SELECT epoch.policy_version::text INTO locked_version
    FROM platform.current_policy_epochs AS epoch
   WHERE epoch.tenant_id = requested_tenant_id
     AND epoch.environment_id = requested_environment_id
   FOR SHARE;
  RETURN coalesce(locked_version, '0'); END $$;

CREATE OR REPLACE FUNCTION platform.lock_release_activation_attempt(
  requested_tenant_id uuid,
  requested_environment_id uuid,
  requested_activation_attempt_id uuid
)
RETURNS TABLE (activation_attempt_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT attempt.activation_attempt_id
    FROM platform.release_activation_attempts AS attempt
   WHERE attempt.tenant_id = requested_tenant_id
     AND attempt.environment_id = requested_environment_id
     AND attempt.activation_attempt_id = requested_activation_attempt_id
     AND attempt.tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND attempt.environment_id =
           nullif(current_setting('north_star.environment_id', true), '')::uuid
     AND nullif(current_setting('north_star.principal_id', true), '')::uuid
           IS NOT NULL
   FOR UPDATE
$$;

CREATE OR REPLACE FUNCTION platform.lock_release_activation_authority_epoch(
  requested_tenant_id uuid
)
RETURNS TABLE (
  approver_policy_version bigint,
  executor_policy_version bigint,
  control_policy_version bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT epoch.approver_policy_version,
         epoch.executor_policy_version,
         epoch.control_policy_version
    FROM platform.release_activation_authority_epochs AS epoch
   WHERE epoch.tenant_id = requested_tenant_id
     AND epoch.tenant_id =
           nullif(current_setting('north_star.tenant_id', true), '')::uuid
     AND nullif(current_setting('north_star.environment_id', true), '')::uuid
           IS NOT NULL
     AND nullif(current_setting('north_star.principal_id', true), '')::uuid
           IS NOT NULL
   FOR SHARE
$$;

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

CREATE OR REPLACE FUNCTION platform.read_tenant_release_artifacts(requested_release_id uuid)
RETURNS TABLE (
  artifact_kind text,
  content_hash text,
  domain_tag text,
  media_type text,
  canonical_bytes bytea
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT blob.artifact_kind,
         blob.content_hash,
         blob.domain_tag,
         blob.media_type,
         blob.canonical_bytes
    FROM platform.release_artifact_blobs AS blob
    JOIN (
      SELECT release.content_hash
        FROM platform.tenant_releases AS release
       WHERE release.tenant_id =
               nullif(current_setting('north_star.tenant_id', true), '')::uuid
         AND release.environment_id =
               nullif(current_setting('north_star.environment_id', true), '')::uuid
         AND nullif(current_setting('north_star.principal_id', true), '')::uuid
               IS NOT NULL
         AND release.release_id = requested_release_id
      UNION
      SELECT link.content_hash
        FROM platform.tenant_release_artifact_links AS link
       WHERE link.tenant_id =
               nullif(current_setting('north_star.tenant_id', true), '')::uuid
         AND link.environment_id =
               nullif(current_setting('north_star.environment_id', true), '')::uuid
         AND nullif(current_setting('north_star.principal_id', true), '')::uuid
               IS NOT NULL
         AND link.release_id = requested_release_id
    ) AS visible ON visible.content_hash = blob.content_hash
   ORDER BY blob.content_hash
$$;

CREATE OR REPLACE FUNCTION platform.record_fresh_tenant_install_evidence(
  requested_install_id uuid,
  requested_serving_release_id uuid,
  requested_serving_release_root text,
  requested_serving_scenario_count integer,
  requested_document jsonb
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, platform, pg_temp
AS $$ DECLARE
  trusted_tenant_id uuid :=
    nullif(current_setting('north_star.tenant_id', true), '')::uuid;
  trusted_environment_id uuid :=
    nullif(current_setting('north_star.environment_id', true), '')::uuid;
  trusted_principal_id uuid :=
    nullif(current_setting('north_star.principal_id', true), '')::uuid;
  intermediate_count integer;
  intermediate_chain_exact boolean;
  intermediate_activation_count integer;
  intermediate_semantic_count integer;
  serving_partition_count integer;
  expected_document jsonb;
  expected_digest text;
  stored_digest text;
  stored_document jsonb; BEGIN
  IF trusted_tenant_id IS NULL
     OR trusted_environment_id IS NULL
     OR trusted_principal_id IS NULL THEN
    RAISE EXCEPTION 'trusted fresh-tenant evidence context is required'
      USING ERRCODE = '42501'; END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      format(
        'northstar.fresh-tenant-install/v1:%s:%s:%s',
        trusted_tenant_id,
        trusted_environment_id,
        requested_install_id
      ),
      0
    )
  );

  WITH ordered AS (
    SELECT intermediate.*,
           row_number() OVER (ORDER BY lineage_ordinal) - 1 AS expected_ordinal,
           lag(release_id) OVER (ORDER BY lineage_ordinal) AS prior_release_id,
           lag(release_root) OVER (ORDER BY lineage_ordinal) AS prior_root
      FROM platform.fresh_tenant_intermediate_release_admissions AS intermediate
     WHERE tenant_id = trusted_tenant_id
       AND environment_id = trusted_environment_id
       AND install_id = requested_install_id
  )
  SELECT count(*)::integer,
         coalesce(
           bool_and(
             lineage_ordinal = expected_ordinal
             AND (
               (lineage_ordinal = 0 AND source_release_root IS NULL)
               OR (
                 lineage_ordinal > 0
                 AND source_release_root = prior_root
               )
             )
           ),
           false
         ),
         count(*) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM platform.release_activation_swap_receipts AS swap
              WHERE swap.tenant_id = ordered.tenant_id
                AND swap.environment_id = ordered.environment_id
                AND swap.previous_release_id IS NOT DISTINCT FROM
                    ordered.prior_release_id
                AND swap.activated_release_id = ordered.release_id
           )
         )::integer,
         count(*) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM platform.tenant_release_admissions AS semantic
              WHERE semantic.tenant_id = ordered.tenant_id
                AND semantic.environment_id = ordered.environment_id
                AND semantic.release_id = ordered.release_id
           )
         )::integer
    INTO intermediate_count,
         intermediate_chain_exact,
         intermediate_activation_count,
         intermediate_semantic_count
    FROM ordered;

  IF intermediate_count = 0
     OR NOT intermediate_chain_exact
     OR intermediate_activation_count <> intermediate_count
     OR intermediate_semantic_count <> 0 THEN
    RAISE EXCEPTION 'fresh-tenant intermediate lineage is incomplete or semantically admitted'
      USING ERRCODE = '23514'; END IF;

  SELECT evidence.result_count +
         CASE
           WHEN evidence.impact_analysis_derivation IS NULL THEN 0
           ELSE jsonb_array_length(
             evidence.impact_analysis_derivation -> 'derivations'
           ) END
    INTO serving_partition_count
    FROM platform.tenant_release_admissions AS admission
    JOIN platform.release_verification_evidence AS evidence
      ON evidence.tenant_id = admission.tenant_id
     AND evidence.environment_id = admission.environment_id
     AND evidence.verification_evidence_id = admission.verification_evidence_id
    JOIN platform.tenant_releases AS release
      ON release.tenant_id = admission.tenant_id
     AND release.environment_id = admission.environment_id
     AND release.release_id = admission.release_id
    JOIN platform.active_release_pointers AS pointer
      ON pointer.tenant_id = admission.tenant_id
     AND pointer.environment_id = admission.environment_id
     AND pointer.release_id = admission.release_id
   WHERE admission.tenant_id = trusted_tenant_id
     AND admission.environment_id = trusted_environment_id
     AND admission.release_id = requested_serving_release_id
     AND release.content_hash = requested_serving_release_root
     AND evidence.release_root = requested_serving_release_root
     AND EXISTS (
       SELECT 1
         FROM platform.release_activation_swap_receipts AS swap
        WHERE swap.tenant_id = trusted_tenant_id
          AND swap.environment_id = trusted_environment_id
          AND swap.previous_release_id = (
            SELECT release_id
              FROM platform.fresh_tenant_intermediate_release_admissions
             WHERE tenant_id = trusted_tenant_id
               AND environment_id = trusted_environment_id
               AND install_id = requested_install_id
             ORDER BY lineage_ordinal DESC
             LIMIT 1
          )
          AND swap.activated_release_id = requested_serving_release_id
     );

  IF serving_partition_count IS DISTINCT FROM requested_serving_scenario_count THEN
    RAISE EXCEPTION 'fresh-tenant serving release lacks its exact semantic partition'
      USING ERRCODE = '23514'; END IF;

  WITH intermediate AS (
    SELECT *
      FROM platform.fresh_tenant_intermediate_release_admissions
     WHERE tenant_id = trusted_tenant_id
       AND environment_id = trusted_environment_id
       AND install_id = requested_install_id
  ), transition_rows AS (
    SELECT lineage_ordinal,
           jsonb_build_object(
             'sourceReleaseRoot', source_release_root,
             'targetReleaseRoot', release_root
           ) AS transition
      FROM intermediate
     WHERE lineage_ordinal > 0
    UNION ALL
    SELECT max(lineage_ordinal) + 1,
           jsonb_build_object(
             'sourceReleaseRoot',
             (array_agg(release_root ORDER BY lineage_ordinal DESC))[1],
             'targetReleaseRoot', requested_serving_release_root
           )
      FROM intermediate
  )
  SELECT jsonb_build_object(
           'schemaVersion', 'northstar.fresh-tenant-install-evidence/v1',
           'nonServingReleasesWithoutScenarioExecution',
           (
             SELECT jsonb_agg(
                      jsonb_build_object(
                        'releaseId', release_id,
                        'releaseRoot', release_root
                      )
                      ORDER BY lineage_ordinal
                    )
               FROM intermediate
           ),
           'appliedTransitions',
           (
             SELECT jsonb_agg(transition ORDER BY lineage_ordinal)
               FROM transition_rows
           ),
           'servingRelease',
           jsonb_build_object(
             'releaseId', requested_serving_release_id,
             'releaseRoot', requested_serving_release_root,
             'scenarioCount', requested_serving_scenario_count
           )
         )
    INTO expected_document;

  IF requested_document IS DISTINCT FROM expected_document THEN
    RAISE EXCEPTION 'fresh-tenant evidence document does not equal durable install facts'
      USING ERRCODE = '23514'; END IF;

  expected_digest := encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        'northstar.fresh-tenant-install-evidence/v1',
        'UTF8'
      ) || decode('00', 'hex') ||
      pg_catalog.convert_to(expected_document::text, 'UTF8')
    ),
    'hex'
  );

  INSERT INTO platform.fresh_tenant_install_evidence (
    tenant_id, environment_id, install_id, serving_release_id,
    serving_release_root, serving_scenario_count, evidence_version,
    evidence_document, evidence_digest, created_by
  ) SELECT
    trusted_tenant_id, trusted_environment_id, requested_install_id,
    requested_serving_release_id, requested_serving_release_root,
    requested_serving_scenario_count,
    'northstar.fresh-tenant-install-evidence/v1', expected_document,
    expected_digest, trusted_principal_id
  WHERE NOT EXISTS (
    SELECT 1
      FROM platform.fresh_tenant_install_evidence
     WHERE tenant_id = trusted_tenant_id
       AND environment_id = trusted_environment_id
       AND install_id = requested_install_id
  );

  SELECT evidence_digest, evidence_document
    INTO stored_digest, stored_document
    FROM platform.fresh_tenant_install_evidence
   WHERE tenant_id = trusted_tenant_id
     AND environment_id = trusted_environment_id
     AND install_id = requested_install_id;

  IF stored_digest IS DISTINCT FROM expected_digest
     OR stored_document IS DISTINCT FROM expected_document THEN
    RAISE EXCEPTION 'stored fresh-tenant evidence differs from durable install facts'
      USING ERRCODE = '23514'; END IF;

  RETURN expected_digest; END;
$$;

CREATE OR REPLACE FUNCTION platform.set_release_activation_control(
  changed_tenant_id uuid,
  changed_environment_id uuid,
  changed_rollout_id uuid,
  changed_live_policy_denied boolean,
  changed_rollout_paused boolean,
  changed_by uuid,
  changed_event_id uuid
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO platform.release_activation_control_events (
    tenant_id,
    environment_id,
    policy_version,
    control_event_id,
    rollout_id,
    live_policy_denied,
    rollout_paused,
    changed_by
  ) VALUES (
    changed_tenant_id,
    changed_environment_id,
    NULL,
    changed_event_id,
    changed_rollout_id,
    changed_live_policy_denied,
    changed_rollout_paused,
    changed_by
  )
  RETURNING policy_version
$$;

CREATE OR REPLACE FUNCTION platform.set_release_approver_eligibility(
  changed_tenant_id uuid,
  changed_principal_id uuid,
  changed_eligible boolean,
  changed_by uuid,
  changed_event_id uuid
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO platform.release_approver_eligibility_events (
    tenant_id,
    policy_version,
    authority_event_id,
    principal_id,
    eligible,
    changed_by
  ) VALUES (
    changed_tenant_id,
    NULL,
    changed_event_id,
    changed_principal_id,
    changed_eligible,
    changed_by
  )
  RETURNING policy_version
$$;

CREATE OR REPLACE FUNCTION platform.set_release_executor_authority(
  changed_tenant_id uuid,
  changed_principal_id uuid,
  changed_authorized boolean,
  changed_by uuid,
  changed_event_id uuid
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO platform.release_executor_authority_events (
    tenant_id,
    policy_version,
    authority_event_id,
    principal_id,
    authorized,
    changed_by
  ) VALUES (
    changed_tenant_id,
    NULL,
    changed_event_id,
    changed_principal_id,
    changed_authorized,
    changed_by
  )
  RETURNING policy_version
$$;

CREATE OR REPLACE FUNCTION platform.stage_release_artifact(
  staged_content_hash text,
  staged_artifact_kind text,
  staged_domain_tag text,
  staged_media_type text,
  staged_canonical_bytes bytea
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH artifact_lock AS MATERIALIZED (
    SELECT pg_advisory_xact_lock(hashtextextended(staged_content_hash, 0))
  ), collision_guard AS MATERIALIZED (
    SELECT 1 AS accepted
      FROM artifact_lock
     WHERE NOT EXISTS (
       SELECT 1
         FROM platform.release_artifact_blobs AS existing
        WHERE existing.content_hash = staged_content_hash
          AND (
            existing.artifact_kind IS DISTINCT FROM staged_artifact_kind
            OR existing.domain_tag IS DISTINCT FROM staged_domain_tag
            OR existing.media_type IS DISTINCT FROM staged_media_type
            OR existing.canonical_bytes IS DISTINCT FROM staged_canonical_bytes
            OR existing.byte_length IS DISTINCT FROM octet_length(staged_canonical_bytes)
          )
     )
    UNION ALL
    SELECT (staged_content_hash || ': content-address collision')::integer
      FROM artifact_lock
     WHERE EXISTS (
        SELECT 1
          FROM platform.release_artifact_blobs AS existing
         WHERE existing.content_hash = staged_content_hash
           AND (
             existing.artifact_kind IS DISTINCT FROM staged_artifact_kind
             OR existing.domain_tag IS DISTINCT FROM staged_domain_tag
             OR existing.media_type IS DISTINCT FROM staged_media_type
             OR existing.canonical_bytes IS DISTINCT FROM staged_canonical_bytes
             OR existing.byte_length IS DISTINCT FROM octet_length(staged_canonical_bytes)
           )
     )
  ), inserted AS (
    INSERT INTO platform.release_artifact_blobs (
      content_hash,
      artifact_kind,
      domain_tag,
      media_type,
      canonical_bytes,
      byte_length
    )
    SELECT staged_content_hash,
           staged_artifact_kind,
           staged_domain_tag,
           staged_media_type,
           staged_canonical_bytes,
           octet_length(staged_canonical_bytes)
      FROM collision_guard
     WHERE accepted = 1
       AND NOT EXISTS (
         SELECT 1
           FROM platform.release_artifact_blobs AS existing
          WHERE existing.content_hash = staged_content_hash
       )
    RETURNING content_hash
  )
  SELECT accepted = 1
    FROM collision_guard
$$;
