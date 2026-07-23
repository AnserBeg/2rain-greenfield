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
  constraints: readonly QueryResultRow[];
  indexes: readonly QueryResultRow[];
  policies: readonly QueryResultRow[];
  relations: readonly QueryResultRow[];
  schemas: readonly string[];
  version: 2;
}

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
    left.name.localeCompare(right.name),
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
  const relations = await client.query(
    `SELECT n.nspname AS schema, c.relname AS relation, c.relkind AS kind,
            c.relrowsecurity AS row_level_security,
            c.relforcerowsecurity AS force_row_level_security
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r', 'p', 'v', 'm')
      ORDER BY n.nspname, c.relname`,
    [sortedSchemas],
  );
  const columns = await client.query(
    `SELECT table_schema AS schema, table_name AS relation,
            ordinal_position, column_name, data_type, udt_name,
            is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = ANY($1::text[])
      ORDER BY table_schema, table_name, ordinal_position`,
    [sortedSchemas],
  );
  const constraints = await client.query(
    `SELECT n.nspname AS schema, c.relname AS relation, con.conname AS name,
            con.contype AS type,
            pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
      ORDER BY n.nspname, c.relname, con.conname`,
    [sortedSchemas],
  );
  const indexes = await client.query(
    `SELECT schemaname AS schema, tablename AS relation, indexname AS name,
            indexdef AS definition
       FROM pg_catalog.pg_indexes
      WHERE schemaname = ANY($1::text[])
      ORDER BY schemaname, tablename, indexname`,
    [sortedSchemas],
  );
  const policies = await client.query(
    `SELECT schemaname AS schema, tablename AS relation,
            policyname AS name, permissive, roles, cmd,
            qual, with_check
       FROM pg_catalog.pg_policies
      WHERE schemaname = ANY($1::text[])
      ORDER BY schemaname, tablename, policyname`,
    [sortedSchemas],
  );

  return {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    policies: policies.rows,
    relations: relations.rows,
    schemas: sortedSchemas,
    version: 2,
  };
}

export function formatSchemaSnapshot(snapshot: SchemaSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
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
