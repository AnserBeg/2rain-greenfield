-- The runner reserves line-leading transaction keywords, so the PL/pgSQL block
-- keeps BEGIN/END on statement lines while the runner owns the transaction.
DO $archive_excluding_module_uniqueness$ DECLARE
  managed_index record; BEGIN FOR managed_index IN
    SELECT table_namespace.nspname AS schema_name,
           table_relation.relname AS table_name,
           table_owner.rolname AS table_owner,
           table_relation.relkind AS table_kind,
           index_relation.relname AS index_name,
           index_owner.rolname AS index_owner,
           access_method.amname AS access_method,
           constraint_record.conname AS constraint_name,
           index_record.indisready AS ready,
           index_record.indisvalid AS valid,
           index_record.indnkeyatts AS key_column_count,
           index_record.indnatts AS total_column_count,
           pg_get_indexdef(index_relation.oid, 1, true) AS first_column,
           pg_get_indexdef(index_relation.oid, 2, true) AS second_column,
           pg_get_indexdef(index_relation.oid, 3, true) AS third_column,
           third_attribute.attgenerated AS third_column_generation,
           pg_get_indexdef(index_relation.oid, 0, true) AS index_definition,
           pg_get_expr(index_record.indpred, index_record.indrelid, true) AS predicate
      FROM pg_index AS index_record
      JOIN pg_class AS table_relation
        ON table_relation.oid = index_record.indrelid
      JOIN pg_namespace AS table_namespace
        ON table_namespace.oid = table_relation.relnamespace
      JOIN pg_roles AS table_owner
        ON table_owner.oid = table_relation.relowner
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_record.indexrelid
      JOIN pg_namespace AS index_namespace
        ON index_namespace.oid = index_relation.relnamespace
      JOIN pg_roles AS index_owner
        ON index_owner.oid = index_relation.relowner
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      LEFT JOIN pg_constraint AS constraint_record
        ON constraint_record.conindid = index_relation.oid
      LEFT JOIN pg_attribute AS third_attribute
        ON third_attribute.attrelid = table_relation.oid
       AND third_attribute.attnum = index_record.indkey[2]
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
    IF managed_index.table_name !~ '^nsm_t_[a-z2-7]{52}$'
       OR managed_index.table_owner IS DISTINCT FROM 'north_star_module_materializer'
       OR managed_index.table_kind IS DISTINCT FROM 'r'
       OR managed_index.index_name !~ '^nsm_[ki]_[a-z2-7]{52}$'
       OR managed_index.index_owner IS DISTINCT FROM 'north_star_module_materializer'
       OR managed_index.access_method IS DISTINCT FROM 'btree'
       OR managed_index.constraint_name IS NOT NULL
       OR managed_index.ready IS DISTINCT FROM true
       OR managed_index.valid IS DISTINCT FROM true
       OR managed_index.key_column_count IS DISTINCT FROM 3
       OR managed_index.total_column_count IS DISTINCT FROM 3
       OR managed_index.first_column IS DISTINCT FROM 'tenant_id'
       OR managed_index.second_column IS DISTINCT FROM 'environment_id'
       OR managed_index.third_column IS NULL
       OR managed_index.third_column !~ '^nsm_c_[a-z2-7]{52}$'
       OR managed_index.third_column_generation IS DISTINCT FROM 's'
    THEN
      RAISE EXCEPTION
        'unique index %.% is not a generated managed business-key index',
        managed_index.schema_name,
        managed_index.index_name; END IF;

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
