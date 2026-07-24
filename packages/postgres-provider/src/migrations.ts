import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import type { PoolClient, QueryResultRow } from 'pg';

export interface Migration {
  checksum: string;
  name: string;
  sql: string;
}

export interface MigrationResult {
  applied: readonly string[];
  verified: readonly string[];
}

export interface SchemaSnapshot {
  columns: readonly QueryResultRow[];
  columnPrivileges: readonly QueryResultRow[];
  constraints: readonly QueryResultRow[];
  defaultPrivileges: readonly QueryResultRow[];
  indexes: readonly QueryResultRow[];
  policies: readonly QueryResultRow[];
  relations: readonly QueryResultRow[];
  relationPrivileges: readonly QueryResultRow[];
  routines: readonly QueryResultRow[];
  routinePrivileges: readonly QueryResultRow[];
  rules: readonly QueryResultRow[];
  schemas: readonly QueryResultRow[];
  schemaPrivileges: readonly QueryResultRow[];
  sequences: readonly QueryResultRow[];
  sequencePrivileges: readonly QueryResultRow[];
  triggers: readonly QueryResultRow[];
  types: readonly QueryResultRow[];
  typePrivileges: readonly QueryResultRow[];
  version: typeof SCHEMA_SNAPSHOT_VERSION;
}

export const SCHEMA_SNAPSHOT_VERSION = 3 as const;

export class MigrationDriftError extends Error {
  override readonly name = 'MigrationDriftError';
}

export class SchemaDriftError extends Error {
  override readonly name = 'SchemaDriftError';
}

const migrationFilePattern = /^(\d{4})_[a-z0-9_]+\.sql$/;
const transactionControlPattern =
  /^\s*(?:ABORT|BEGIN|COMMIT|END|ROLLBACK|START\s+TRANSACTION)\b/im;
const migrationLockKey = 'north-star:platform-migrations:v1';

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const migrationDirectory = resolve(directory);
  const entries = await readdir(migrationDirectory, { withFileTypes: true });
  const sqlEntries = entries.filter((entry) => entry.name.endsWith('.sql'));

  for (const entry of sqlEntries) {
    if (!entry.isFile() || !migrationFilePattern.test(entry.name)) {
      throw new MigrationDriftError(
        `invalid migration entry ${entry.name}; expected a regular file named NNNN_description.sql`,
      );
    }
  }

  const ordered = sqlEntries.toSorted((left, right) =>
    compareCodeUnits(left.name, right.name),
  );
  const migrations: Migration[] = [];

  for (const [index, entry] of ordered.entries()) {
    const match = migrationFilePattern.exec(entry.name);
    const expectedOrdinal = String(index + 1).padStart(4, '0');
    if (match?.[1] !== expectedOrdinal) {
      throw new MigrationDriftError(
        `migration stream must be contiguous: expected ${expectedOrdinal}, found ${entry.name}`,
      );
    }

    const sql = await readFile(resolve(migrationDirectory, entry.name), 'utf8');
    if (sql.trim().length === 0) {
      throw new MigrationDriftError(`migration ${entry.name} is empty`);
    }
    if (transactionControlPattern.test(sql)) {
      throw new MigrationDriftError(
        `migration ${entry.name} contains transaction control; the runner owns the transaction`,
      );
    }

    migrations.push({
      checksum: createHash('sha256').update(sql).digest('hex'),
      name: entry.name,
      sql,
    });
  }

  return migrations;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function runMigrations(
  client: PoolClient,
  migrations: readonly Migration[],
): Promise<MigrationResult> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      migrationLockKey,
    ]);
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS north_star_internal;
      CREATE TABLE IF NOT EXISTS north_star_internal.schema_migrations (
        ordinal bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name text NOT NULL UNIQUE,
        checksum text NOT NULL CHECK (length(checksum) = 64),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
    `);

    const appliedResult = await client.query<{
      checksum: string;
      name: string;
    }>(`
      SELECT name, checksum
      FROM north_star_internal.schema_migrations
      ORDER BY ordinal
    `);

    for (const [index, applied] of appliedResult.rows.entries()) {
      const local = migrations[index];
      if (!local) {
        throw new MigrationDriftError(
          `database records migration ${applied.name}, but no checked-in file exists`,
        );
      }
      if (local.name !== applied.name) {
        throw new MigrationDriftError(
          `migration order drift at position ${index + 1}: database has ${applied.name}, files have ${local.name}`,
        );
      }
      if (local.checksum !== applied.checksum) {
        throw new MigrationDriftError(
          `applied migration ${local.name} differs from its checked-in file`,
        );
      }
    }

    const pending = migrations.slice(appliedResult.rows.length);
    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO north_star_internal.schema_migrations (name, checksum)
         VALUES ($1, $2)`,
        [migration.name, migration.checksum],
      );
    }

    await client.query('COMMIT');
    return {
      applied: pending.map((migration) => migration.name),
      verified: migrations.map((migration) => migration.name),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function captureSchemaSnapshot(
  client: PoolClient,
  schemas: readonly string[] = ['north_star_internal', 'platform'],
): Promise<SchemaSnapshot> {
  const sortedSchemas = [...schemas].toSorted();
  const schemaRecords = await client.query(
    `SELECT namespace.nspname AS schema,
            pg_catalog.pg_get_userbyid(namespace.nspowner) AS owner
       FROM pg_catalog.pg_namespace AS namespace
      WHERE namespace.nspname = ANY($1::text[])
      ORDER BY namespace.nspname`,
    [sortedSchemas],
  );
  const schemaPrivileges = await client.query(
    `SELECT namespace.nspname AS schema,
            CASE privilege.grantor WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END AS grantor,
            CASE privilege.grantee WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END AS grantee,
            privilege.privilege_type, privilege.is_grantable
       FROM pg_catalog.pg_namespace AS namespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           namespace.nspacl,
           pg_catalog.acldefault('n', namespace.nspowner)
         )
       ) AS privilege
      WHERE namespace.nspname = ANY($1::text[])
      ORDER BY namespace.nspname, grantor, grantee,
               privilege.privilege_type, privilege.is_grantable`,
    [sortedSchemas],
  );
  const relations = await client.query(
    `SELECT n.nspname AS schema, c.relname AS relation, c.relkind AS kind,
            pg_catalog.pg_get_userbyid(c.relowner) AS owner,
            c.relpersistence AS persistence,
            c.relrowsecurity AS row_level_security,
            c.relforcerowsecurity AS force_row_level_security,
            c.relispartition AS is_partition,
            c.relreplident AS replica_identity,
            access_method.amname AS access_method,
            tablespace.spcname AS tablespace,
            COALESCE(
              ARRAY(
                SELECT option
                  FROM unnest(c.reloptions) AS option
                 ORDER BY option
              ),
              ARRAY[]::text[]
            ) AS options,
            pg_catalog.pg_get_partkeydef(c.oid) AS partition_key,
            pg_catalog.pg_get_expr(c.relpartbound, c.oid, true)
              AS partition_bound,
            CASE WHEN c.relkind IN ('v', 'm')
              THEN pg_catalog.pg_get_viewdef(c.oid, true)
              ELSE NULL END AS view_definition,
            foreign_server.srvname AS foreign_server,
            COALESCE(
              ARRAY(
                SELECT option
                  FROM unnest(foreign_table.ftoptions) AS option
                 ORDER BY option
              ),
              ARRAY[]::text[]
            ) AS foreign_options
       FROM pg_catalog.pg_class AS c
       JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_am AS access_method
         ON access_method.oid = c.relam
       LEFT JOIN pg_catalog.pg_tablespace AS tablespace
         ON tablespace.oid = c.reltablespace
       LEFT JOIN pg_catalog.pg_foreign_table AS foreign_table
         ON foreign_table.ftrelid = c.oid
       LEFT JOIN pg_catalog.pg_foreign_server AS foreign_server
         ON foreign_server.oid = foreign_table.ftserver
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r', 'p', 'v', 'm', 'c', 'f')
      ORDER BY n.nspname, c.relkind, c.relname`,
    [sortedSchemas],
  );
  const relationPrivileges = await client.query(
    `SELECT namespace.nspname AS schema, relation.relname AS relation,
            CASE privilege.grantor WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END AS grantor,
            CASE privilege.grantee WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END AS grantee,
            privilege.privilege_type, privilege.is_grantable
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           relation.relacl,
           pg_catalog.acldefault('r', relation.relowner)
         )
       ) AS privilege
      WHERE namespace.nspname = ANY($1::text[])
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      ORDER BY namespace.nspname, relation.relname, grantor, grantee,
               privilege.privilege_type, privilege.is_grantable`,
    [sortedSchemas],
  );
  const columns = await client.query(
    `SELECT namespace.nspname AS schema, relation.relname AS relation,
            attribute.attnum AS ordinal_position,
            attribute.attname AS column_name,
            pg_catalog.format_type(
              attribute.atttypid,
              attribute.atttypmod
            ) AS data_type,
            NOT attribute.attnotnull AS is_nullable,
            pg_catalog.pg_get_expr(
              default_value.adbin,
              default_value.adrelid,
              true
            ) AS column_default,
            attribute.attidentity AS identity_kind,
            attribute.attgenerated AS generated_kind,
            attribute.attstorage AS storage_kind,
            attribute.attcompression AS compression,
            CASE WHEN attribute.attcollation = 0 THEN NULL
              ELSE collation_namespace.nspname || '.' ||
                   collation_record.collname
              END AS collation
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_attribute AS attribute
         ON attribute.attrelid = relation.oid
       LEFT JOIN pg_catalog.pg_attrdef AS default_value
         ON default_value.adrelid = relation.oid
        AND default_value.adnum = attribute.attnum
       LEFT JOIN pg_catalog.pg_collation AS collation_record
         ON collation_record.oid = attribute.attcollation
       LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
         ON collation_namespace.oid = collation_record.collnamespace
      WHERE namespace.nspname = ANY($1::text[])
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'c', 'f')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY namespace.nspname, relation.relname, attribute.attnum`,
    [sortedSchemas],
  );
  const columnPrivileges = await client.query(
    `SELECT namespace.nspname AS schema, relation.relname AS relation,
            attribute.attname AS column_name,
            CASE privilege.grantor WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END AS grantor,
            CASE privilege.grantee WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END AS grantee,
            privilege.privilege_type, privilege.is_grantable
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_attribute AS attribute
         ON attribute.attrelid = relation.oid
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      WHERE namespace.nspname = ANY($1::text[])
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'c', 'f')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY namespace.nspname, relation.relname, attribute.attname,
               grantor, grantee, privilege.privilege_type,
               privilege.is_grantable`,
    [sortedSchemas],
  );
  const constraints = await client.query(
    `SELECT namespace.nspname AS schema, relation.relname AS relation,
            domain_type.typname AS domain, con.conname AS name,
            con.contype AS type,
            pg_catalog.pg_get_constraintdef(con.oid, true) AS definition,
            con.condeferrable AS deferrable,
            con.condeferred AS initially_deferred,
            con.convalidated AS validated,
            con.connoinherit AS no_inherit,
            con.conislocal AS is_local,
            con.coninhcount AS inheritance_count
       FROM pg_catalog.pg_constraint AS con
       LEFT JOIN pg_catalog.pg_class AS relation
         ON relation.oid = con.conrelid
       LEFT JOIN pg_catalog.pg_type AS domain_type
         ON domain_type.oid = con.contypid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = con.connamespace
      WHERE namespace.nspname = ANY($1::text[])
      ORDER BY namespace.nspname, relation.relname, domain_type.typname,
               con.conname`,
    [sortedSchemas],
  );
  const indexes = await client.query(
    `SELECT namespace.nspname AS schema, source.relname AS relation,
            index_relation.relname AS name,
            pg_catalog.pg_get_userbyid(index_relation.relowner) AS owner,
            access_method.amname AS access_method,
            pg_catalog.pg_get_indexdef(index_relation.oid) AS definition,
            index_record.indisunique AS is_unique,
            index_record.indisprimary AS is_primary,
            index_record.indisexclusion AS is_exclusion,
            index_record.indimmediate AS is_immediate,
            index_record.indisclustered AS is_clustered,
            index_record.indisvalid AS is_valid,
            index_record.indisready AS is_ready,
            index_record.indislive AS is_live,
            index_record.indisreplident AS is_replica_identity,
            pg_catalog.pg_get_expr(
              index_record.indexprs,
              index_record.indrelid,
              true
            ) AS expressions,
            pg_catalog.pg_get_expr(
              index_record.indpred,
              index_record.indrelid,
              true
            ) AS predicate
       FROM pg_catalog.pg_index AS index_record
       JOIN pg_catalog.pg_class AS source
         ON source.oid = index_record.indrelid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = source.relnamespace
       JOIN pg_catalog.pg_class AS index_relation
         ON index_relation.oid = index_record.indexrelid
       JOIN pg_catalog.pg_am AS access_method
         ON access_method.oid = index_relation.relam
      WHERE namespace.nspname = ANY($1::text[])
      ORDER BY namespace.nspname, source.relname, index_relation.relname`,
    [sortedSchemas],
  );
  const policies = await client.query(
    `SELECT namespace.nspname AS schema, relation.relname AS relation,
            policy.polname AS name, policy.polpermissive AS permissive,
            ARRAY(
              SELECT CASE role_oid WHEN 0 THEN 'PUBLIC'
                ELSE pg_catalog.pg_get_userbyid(role_oid) END
                FROM unnest(policy.polroles) AS role_oid
               ORDER BY 1
            )::text[] AS roles,
            policy.polcmd AS command,
            pg_catalog.pg_get_expr(
              policy.polqual,
              policy.polrelid,
              true
            ) AS using_expression,
            pg_catalog.pg_get_expr(
              policy.polwithcheck,
              policy.polrelid,
              true
            ) AS check_expression
       FROM pg_catalog.pg_policy AS policy
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = policy.polrelid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY($1::text[])
      ORDER BY namespace.nspname, relation.relname, policy.polname`,
    [sortedSchemas],
  );
  const routines = await client.query(
    `SELECT namespace.nspname AS schema, routine.proname AS name,
            pg_catalog.pg_get_function_identity_arguments(routine.oid)
              AS identity_arguments,
            routine.prokind AS kind,
            language.lanname AS language,
            pg_catalog.pg_get_userbyid(routine.proowner) AS owner,
            pg_catalog.pg_get_function_result(routine.oid) AS result_type,
            CASE WHEN routine.prokind IN ('f', 'p')
              THEN pg_catalog.pg_get_functiondef(routine.oid)
              ELSE NULL END AS definition,
            routine.prosecdef AS security_definer,
            routine.proleakproof AS leakproof,
            routine.proisstrict AS strict,
            routine.proretset AS returns_set,
            routine.provolatile AS volatility,
            routine.proparallel AS parallel_safety,
            routine.procost AS cost,
            routine.prorows AS estimated_rows,
            COALESCE(
              ARRAY(
                SELECT setting
                  FROM unnest(routine.proconfig) AS setting
                 ORDER BY setting
              ),
              ARRAY[]::text[]
            ) AS configuration
       FROM pg_catalog.pg_proc AS routine
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = routine.pronamespace
       JOIN pg_catalog.pg_language AS language
         ON language.oid = routine.prolang
      WHERE namespace.nspname = ANY($1::text[])
      ORDER BY namespace.nspname, routine.proname,
               pg_catalog.pg_get_function_identity_arguments(routine.oid)`,
    [sortedSchemas],
  );
  const routinePrivileges = await client.query(
    `SELECT namespace.nspname AS schema, routine.proname AS name,
            pg_catalog.pg_get_function_identity_arguments(routine.oid)
              AS identity_arguments,
            CASE privilege.grantor WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END AS grantor,
            CASE privilege.grantee WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END AS grantee,
            privilege.privilege_type, privilege.is_grantable
       FROM pg_catalog.pg_proc AS routine
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = routine.pronamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           routine.proacl,
           pg_catalog.acldefault('f', routine.proowner)
         )
       ) AS privilege
      WHERE namespace.nspname = ANY($1::text[])
      ORDER BY namespace.nspname, routine.proname,
               pg_catalog.pg_get_function_identity_arguments(routine.oid),
               grantor, grantee, privilege.privilege_type,
               privilege.is_grantable`,
    [sortedSchemas],
  );
  const triggers = await client.query(
    `SELECT namespace.nspname AS schema, relation.relname AS relation,
            trigger_record.tgname AS name,
            pg_catalog.pg_get_triggerdef(trigger_record.oid, true)
              AS definition,
            trigger_record.tgenabled AS enabled,
            trigger_record.tgdeferrable AS deferrable,
            trigger_record.tginitdeferred AS initially_deferred
       FROM pg_catalog.pg_trigger AS trigger_record
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = trigger_record.tgrelid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY($1::text[])
        AND NOT trigger_record.tgisinternal
      ORDER BY namespace.nspname, relation.relname, trigger_record.tgname`,
    [sortedSchemas],
  );
  const rules = await client.query(
    `SELECT namespace.nspname AS schema, relation.relname AS relation,
            rule.rulename AS name,
            pg_catalog.pg_get_ruledef(rule.oid, true) AS definition,
            rule.ev_enabled AS enabled,
            rule.is_instead AS is_instead,
            rule.ev_type AS event_type
       FROM pg_catalog.pg_rewrite AS rule
       JOIN pg_catalog.pg_class AS relation ON relation.oid = rule.ev_class
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY($1::text[])
      ORDER BY namespace.nspname, relation.relname, rule.rulename`,
    [sortedSchemas],
  );
  const sequences = await client.query(
    `SELECT namespace.nspname AS schema, relation.relname AS name,
            pg_catalog.pg_get_userbyid(relation.relowner) AS owner,
            pg_catalog.format_type(sequence_record.seqtypid, NULL) AS data_type,
            sequence_record.seqstart AS start_value,
            sequence_record.seqincrement AS increment,
            sequence_record.seqmax AS maximum_value,
            sequence_record.seqmin AS minimum_value,
            sequence_record.seqcache AS cache_size,
            sequence_record.seqcycle AS cycles,
            owned_namespace.nspname AS owned_by_schema,
            owned_relation.relname AS owned_by_relation,
            owned_attribute.attname AS owned_by_column
       FROM pg_catalog.pg_sequence AS sequence_record
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = sequence_record.seqrelid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       LEFT JOIN pg_catalog.pg_depend AS ownership
         ON ownership.classid = 'pg_catalog.pg_class'::regclass
        AND ownership.objid = relation.oid
        AND ownership.objsubid = 0
        AND ownership.refclassid = 'pg_catalog.pg_class'::regclass
        AND ownership.deptype IN ('a', 'i')
       LEFT JOIN pg_catalog.pg_class AS owned_relation
         ON owned_relation.oid = ownership.refobjid
       LEFT JOIN pg_catalog.pg_namespace AS owned_namespace
         ON owned_namespace.oid = owned_relation.relnamespace
       LEFT JOIN pg_catalog.pg_attribute AS owned_attribute
         ON owned_attribute.attrelid = ownership.refobjid
        AND owned_attribute.attnum = ownership.refobjsubid
      WHERE namespace.nspname = ANY($1::text[])
      ORDER BY namespace.nspname, relation.relname`,
    [sortedSchemas],
  );
  const sequencePrivileges = await client.query(
    `SELECT namespace.nspname AS schema, relation.relname AS name,
            CASE privilege.grantor WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END AS grantor,
            CASE privilege.grantee WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END AS grantee,
            privilege.privilege_type, privilege.is_grantable
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           relation.relacl,
           pg_catalog.acldefault('S', relation.relowner)
         )
       ) AS privilege
      WHERE namespace.nspname = ANY($1::text[])
        AND relation.relkind = 'S'
      ORDER BY namespace.nspname, relation.relname, grantor, grantee,
               privilege.privilege_type, privilege.is_grantable`,
    [sortedSchemas],
  );
  const types = await client.query(
    `SELECT namespace.nspname AS schema, type_record.typname AS name,
            type_record.typtype AS kind,
            pg_catalog.pg_get_userbyid(type_record.typowner) AS owner,
            type_record.typcategory AS category,
            type_record.typnotnull AS domain_not_null,
            type_record.typdefault AS domain_default,
            CASE WHEN type_record.typbasetype = 0 THEN NULL
              ELSE pg_catalog.format_type(
                type_record.typbasetype,
                type_record.typtypmod
              ) END AS domain_base_type,
            CASE WHEN type_record.typcollation = 0 THEN NULL
              ELSE collation_namespace.nspname || '.' ||
                   collation_record.collname
              END AS collation,
            composite_relation.relname AS composite_relation,
            COALESCE(
              ARRAY(
                SELECT enum_record.enumlabel
                  FROM pg_catalog.pg_enum AS enum_record
                 WHERE enum_record.enumtypid = type_record.oid
                 ORDER BY enum_record.enumsortorder, enum_record.enumlabel
              ),
              ARRAY[]::text[]
            ) AS enum_labels,
            CASE WHEN range_record.rngsubtype = 0 THEN NULL
              ELSE pg_catalog.format_type(range_record.rngsubtype, NULL)
              END AS range_subtype,
            CASE WHEN range_record.rngcollation = 0 THEN NULL
              ELSE range_collation_namespace.nspname || '.' ||
                   range_collation.collname END AS range_collation,
            CASE WHEN range_record.rngsubopc = 0 THEN NULL
              ELSE operator_namespace.nspname || '.' || operator_class.opcname
              END AS range_operator_class,
            CASE WHEN range_record.rngcanonical = 0 THEN NULL
              ELSE canonical_namespace.nspname || '.' || canonical.proname ||
                   '(' || pg_catalog.pg_get_function_identity_arguments(
                     canonical.oid
                   ) || ')' END AS range_canonical_function,
            CASE WHEN range_record.rngsubdiff = 0 THEN NULL
              ELSE subtype_diff_namespace.nspname || '.' ||
                   subtype_diff.proname || '(' ||
                   pg_catalog.pg_get_function_identity_arguments(
                     subtype_diff.oid
                   ) || ')' END AS range_subtype_diff_function
       FROM pg_catalog.pg_type AS type_record
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = type_record.typnamespace
       LEFT JOIN pg_catalog.pg_class AS composite_relation
         ON composite_relation.oid = type_record.typrelid
       LEFT JOIN pg_catalog.pg_collation AS collation_record
         ON collation_record.oid = type_record.typcollation
       LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
         ON collation_namespace.oid = collation_record.collnamespace
       LEFT JOIN pg_catalog.pg_range AS range_record
         ON range_record.rngtypid = type_record.oid
         OR range_record.rngmultitypid = type_record.oid
       LEFT JOIN pg_catalog.pg_collation AS range_collation
         ON range_collation.oid = range_record.rngcollation
       LEFT JOIN pg_catalog.pg_namespace AS range_collation_namespace
         ON range_collation_namespace.oid = range_collation.collnamespace
       LEFT JOIN pg_catalog.pg_opclass AS operator_class
         ON operator_class.oid = range_record.rngsubopc
       LEFT JOIN pg_catalog.pg_namespace AS operator_namespace
         ON operator_namespace.oid = operator_class.opcnamespace
       LEFT JOIN pg_catalog.pg_proc AS canonical
         ON canonical.oid = range_record.rngcanonical
       LEFT JOIN pg_catalog.pg_namespace AS canonical_namespace
         ON canonical_namespace.oid = canonical.pronamespace
       LEFT JOIN pg_catalog.pg_proc AS subtype_diff
         ON subtype_diff.oid = range_record.rngsubdiff
       LEFT JOIN pg_catalog.pg_namespace AS subtype_diff_namespace
         ON subtype_diff_namespace.oid = subtype_diff.pronamespace
      WHERE namespace.nspname = ANY($1::text[])
        AND type_record.typelem = 0
        AND type_record.typtype IN ('c', 'd', 'e', 'm', 'r')
        AND (
          type_record.typrelid = 0
          OR composite_relation.relkind = 'c'
        )
      ORDER BY namespace.nspname, type_record.typname`,
    [sortedSchemas],
  );
  const typePrivileges = await client.query(
    `SELECT namespace.nspname AS schema, type_record.typname AS name,
            CASE privilege.grantor WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END AS grantor,
            CASE privilege.grantee WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END AS grantee,
            privilege.privilege_type, privilege.is_grantable
       FROM pg_catalog.pg_type AS type_record
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = type_record.typnamespace
       LEFT JOIN pg_catalog.pg_class AS composite_relation
         ON composite_relation.oid = type_record.typrelid
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           type_record.typacl,
           pg_catalog.acldefault('T', type_record.typowner)
         )
       ) AS privilege
      WHERE namespace.nspname = ANY($1::text[])
        AND type_record.typelem = 0
        AND type_record.typtype IN ('c', 'd', 'e', 'm', 'r')
        AND (
          type_record.typrelid = 0
          OR composite_relation.relkind = 'c'
        )
      ORDER BY namespace.nspname, type_record.typname, grantor, grantee,
               privilege.privilege_type, privilege.is_grantable`,
    [sortedSchemas],
  );
  const defaultPrivileges = await client.query(
    `SELECT pg_catalog.pg_get_userbyid(default_acl.defaclrole) AS owner,
            namespace.nspname AS schema,
            default_acl.defaclobjtype AS object_type,
            CASE privilege.grantor WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END AS grantor,
            CASE privilege.grantee WHEN 0 THEN 'PUBLIC'
              ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END AS grantee,
            privilege.privilege_type, privilege.is_grantable
       FROM pg_catalog.pg_default_acl AS default_acl
       LEFT JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = default_acl.defaclnamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl)
         AS privilege
      WHERE default_acl.defaclnamespace = 0
         OR namespace.nspname = ANY($1::text[])
      ORDER BY owner, namespace.nspname NULLS FIRST,
               default_acl.defaclobjtype, grantor, grantee,
               privilege.privilege_type, privilege.is_grantable`,
    [sortedSchemas],
  );

  return {
    columns: columns.rows,
    columnPrivileges: columnPrivileges.rows,
    constraints: constraints.rows,
    defaultPrivileges: defaultPrivileges.rows,
    indexes: indexes.rows,
    policies: policies.rows,
    relations: relations.rows,
    relationPrivileges: relationPrivileges.rows,
    routines: routines.rows,
    routinePrivileges: routinePrivileges.rows,
    rules: rules.rows,
    schemas: schemaRecords.rows,
    schemaPrivileges: schemaPrivileges.rows,
    sequences: sequences.rows,
    sequencePrivileges: sequencePrivileges.rows,
    triggers: triggers.rows,
    types: types.rows,
    typePrivileges: typePrivileges.rows,
    version: SCHEMA_SNAPSHOT_VERSION,
  };
}

export function formatSchemaSnapshot(snapshot: SchemaSnapshot): string {
  return `${formatSnapshotJson(snapshot, 0)}\n`;
}

function formatSnapshotJson(value: unknown, depth: number): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  const indentation = '  '.repeat(depth);
  const childIndentation = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inline = JSON.stringify(value);
    if (
      value.every((item) => item === null || typeof item !== 'object') &&
      childIndentation.length + inline.length <= 80
    ) {
      return inline;
    }
    return `[\n${value
      .map(
        (item) => `${childIndentation}${formatSnapshotJson(item, depth + 1)}`,
      )
      .join(',\n')}\n${indentation}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return `{\n${entries
    .map(
      ([key, item]) =>
        `${childIndentation}${JSON.stringify(key)}: ${formatSnapshotJson(
          item,
          depth + 1,
        )}`,
    )
    .join(',\n')}\n${indentation}}`;
}

export async function assertSchemaMatchesSnapshot(
  client: PoolClient,
  snapshotPath: string,
  schemas: readonly string[] = ['north_star_internal', 'platform'],
): Promise<void> {
  const expected = JSON.parse(
    await readFile(resolve(snapshotPath), 'utf8'),
  ) as unknown;
  const actual = await captureSchemaSnapshot(client, schemas);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new SchemaDriftError(
      `physical schema differs from ${basename(snapshotPath)}; run checked-in migrations and review the snapshot diff`,
    );
  }
}
