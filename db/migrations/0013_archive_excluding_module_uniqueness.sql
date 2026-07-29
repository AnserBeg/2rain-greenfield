-- The runner reserves line-leading transaction keywords, so the PL/pgSQL block
-- keeps BEGIN/END on statement lines while the runner owns the transaction.
DO $archive_excluding_module_uniqueness$ DECLARE
  managed_index record; BEGIN FOR managed_index IN
    SELECT index_namespace.nspname AS schema_name,
           index_relation.relname AS index_name,
           pg_get_indexdef(index_relation.oid, 0, true) AS index_definition,
           pg_get_expr(index_record.indpred, index_record.indrelid, true) AS predicate
      FROM pg_index AS index_record
      JOIN pg_class AS table_relation
        ON table_relation.oid = index_record.indrelid
      JOIN pg_namespace AS table_namespace
        ON table_namespace.oid = table_relation.relnamespace
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_record.indexrelid
      JOIN pg_namespace AS index_namespace
        ON index_namespace.oid = index_relation.relnamespace
     WHERE table_namespace.nspname = 'north_star_module'
       AND index_namespace.nspname = 'north_star_module'
       AND index_record.indisunique
       AND NOT index_record.indisprimary
       AND EXISTS (
         SELECT 1
           FROM pg_attribute AS archived_column
          WHERE archived_column.attrelid = table_relation.oid
            AND archived_column.attname = 'archived_at'
            AND archived_column.attnum > 0
            AND NOT archived_column.attisdropped
       )
     ORDER BY index_relation.relname
  LOOP
    IF managed_index.predicate IS NOT NULL THEN
      IF managed_index.predicate = 'archived_at IS NULL' THEN
        CONTINUE; END IF;
      RAISE EXCEPTION
        'managed unique index %.% has unsupported predicate %',
        managed_index.schema_name,
        managed_index.index_name,
        managed_index.predicate; END IF;

    EXECUTE format(
      'DROP INDEX %I.%I',
      managed_index.schema_name,
      managed_index.index_name
    );
    EXECUTE managed_index.index_definition || ' WHERE (archived_at IS NULL)'; END LOOP; END
$archive_excluding_module_uniqueness$;
