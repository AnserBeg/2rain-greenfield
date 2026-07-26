CREATE TABLE north_star_internal.module_fold_function_ddl_witnesses (
  function_identity text PRIMARY KEY,
  function_definition text NOT NULL,
  witnessed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT module_fold_function_ddl_witnesses_identity CHECK (
    function_identity = 'north_star_module.nsm_unicode_case_fold_v1(value text)'
  )
);

REVOKE ALL ON north_star_internal.module_fold_function_ddl_witnesses FROM PUBLIC;

INSERT INTO north_star_internal.module_fold_function_ddl_witnesses (
  function_identity,
  function_definition
)
SELECT
  'north_star_module.nsm_unicode_case_fold_v1(value text)',
  pg_catalog.pg_get_functiondef(routine.oid)
FROM pg_catalog.pg_proc AS routine
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = routine.pronamespace
WHERE namespace.nspname = 'north_star_module'
  AND routine.proname = 'nsm_unicode_case_fold_v1'
  AND pg_catalog.pg_get_function_identity_arguments(routine.oid) = 'value text';

CREATE FUNCTION north_star_internal.witness_module_fold_function_ddl()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
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

REVOKE ALL ON FUNCTION north_star_internal.witness_module_fold_function_ddl()
  FROM PUBLIC;

CREATE EVENT TRIGGER module_fold_function_ddl_witness
ON ddl_command_end
WHEN TAG IN ('CREATE FUNCTION')
EXECUTE FUNCTION north_star_internal.witness_module_fold_function_ddl();
