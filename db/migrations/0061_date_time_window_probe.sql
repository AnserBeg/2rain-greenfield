-- ADR-0087 A4. A dateTime field added to an existing record type builds its
-- window index in the approved attempt only while the physical table is at or
-- under the deploy ceiling. Module tables force row-level security and the
-- materializer sees one tenant at a time, while generated tables are pooled
-- across tenants, so the count runs here and covers every tenant's rows. It
-- answers one boolean and reads nothing else; the caller already holds the
-- SHARE lock the build takes.
CREATE FUNCTION north_star_internal.module_table_exceeds(table_name text, ceiling integer)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
-- An owner that row security would filter errors here rather than counting
-- only one tenant, so the probe cannot pass a pooled table by undercounting.
SET row_security = off AS $$
DECLARE exceeds boolean; BEGIN
  IF ceiling IS NULL OR ceiling < 0 OR ceiling > 10000 THEN
    RAISE EXCEPTION 'module.invalidCeiling'; END IF;
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'north_star_module'
       AND relation.relname = table_name
       AND relation.relkind IN ('r', 'p')
  ) THEN
    RAISE EXCEPTION 'module.unknownTable'; END IF;
  EXECUTE format(
    'SELECT count(*) > %s FROM (SELECT FROM north_star_module.%I LIMIT %s) AS probe',
    ceiling, table_name, ceiling + 1
  ) INTO exceeds;
  RETURN exceeds; END $$;
REVOKE ALL ON FUNCTION north_star_internal.module_table_exceeds(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION north_star_internal.module_table_exceeds(text, integer)
  TO north_star_module_materializer;
