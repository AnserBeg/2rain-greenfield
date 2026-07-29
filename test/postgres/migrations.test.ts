import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  assertSchemaMatchesSnapshot,
  loadMigrations,
  MigrationDriftError,
  runMigrations,
  SchemaDriftError,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const checkedInMigrations = resolve('db/migrations');
const checkedInSnapshot = resolve('db/schema.snapshot.json');
const execFileAsync = promisify(execFile);

test('empty, concurrent, and previously migrated databases converge', async () => {
  await withEphemeralPostgres(
    'migration-convergence',
    async ({ connection, pool }) => {
      const migrations = await loadMigrations(checkedInMigrations);
      const left = await pool.connect();
      const right = await pool.connect();
      try {
        const results = await Promise.all([
          runMigrations(left, migrations),
          runMigrations(right, migrations),
        ]);
        assert.equal(
          results.reduce((count, result) => count + result.applied.length, 0),
          migrations.length,
        );
        assert.deepEqual(
          results.map((result) => result.verified),
          [
            migrations.map(({ name }) => name),
            migrations.map(({ name }) => name),
          ],
        );

        const repeated = await runMigrations(left, migrations);
        assert.deepEqual(repeated.applied, []);
        await assertSchemaMatchesSnapshot(left, checkedInSnapshot);

        const history = await left.query<{ count: string }>(
          'SELECT count(*) FROM north_star_internal.schema_migrations',
        );
        assert.equal(history.rows[0]?.count, String(migrations.length));

        const cli = await execFileAsync(
          'node',
          ['--import', 'tsx', 'packages/postgres-provider/src/migrate.ts'],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: {
              ...process.env,
              DATABASE_URL: `postgresql://postgres@127.0.0.1:${String(connection.port)}/postgres`,
            },
          },
        );
        assert.match(
          cli.stdout,
          new RegExp(
            `migrations: PASS \\(0 applied, ${String(migrations.length)} verified\\)`,
          ),
        );
      } finally {
        left.release();
        right.release();
      }
    },
  );
});

test('archive uniqueness migration replaces both legacy indexes without renaming them', async () => {
  await withEphemeralPostgres(
    'archive-unique-index-migration',
    async ({ pool }) => {
      const client = await pool.connect();
      try {
        const migrations = await loadMigrations(checkedInMigrations);
        const replacement = migrations.at(-1);
        assert.equal(
          replacement?.name,
          '0014_archive_excluding_module_uniqueness.sql',
        );
        await runMigrations(client, migrations.slice(0, -1));
        await client.query(`
          CREATE TABLE north_star_module.archive_unique_probe (
            tenant_id uuid NOT NULL,
            environment_id uuid NOT NULL,
            record_id uuid NOT NULL,
            archived_at timestamptz,
            code text NOT NULL,
            PRIMARY KEY (tenant_id, environment_id, record_id)
          );
          CREATE UNIQUE INDEX legacy_semantic_unique
            ON north_star_module.archive_unique_probe
            (tenant_id, environment_id, lower(code));
          CREATE UNIQUE INDEX legacy_case_insensitive_unique
            ON north_star_module.archive_unique_probe
            (tenant_id, environment_id, lower(code));
          ALTER TABLE north_star_module.archive_unique_probe
            OWNER TO north_star_module_materializer;
        `);
        const before = await client.query<{
          name: string;
          predicate: string | null;
        }>(
          `SELECT index_relation.relname AS name,
                  pg_get_expr(index_record.indpred, index_record.indrelid, true) AS predicate
             FROM pg_index AS index_record
             JOIN pg_class AS index_relation
               ON index_relation.oid = index_record.indexrelid
             JOIN pg_class AS table_relation
               ON table_relation.oid = index_record.indrelid
             JOIN pg_namespace AS namespace
               ON namespace.oid = table_relation.relnamespace
            WHERE namespace.nspname = 'north_star_module'
              AND table_relation.relname = 'archive_unique_probe'
              AND NOT index_record.indisprimary
            ORDER BY index_relation.relname`,
        );
        assert.deepEqual(before.rows, [
          { name: 'legacy_case_insensitive_unique', predicate: null },
          { name: 'legacy_semantic_unique', predicate: null },
        ]);

        const upgraded = await runMigrations(client, migrations);
        assert.deepEqual(upgraded.applied, [replacement.name]);
        const after = await client.query<{
          name: string;
          owner: string;
          predicate: string | null;
        }>(
          `SELECT index_relation.relname AS name,
                  pg_get_userbyid(index_relation.relowner) AS owner,
                  pg_get_expr(index_record.indpred, index_record.indrelid, true) AS predicate
             FROM pg_index AS index_record
             JOIN pg_class AS index_relation
               ON index_relation.oid = index_record.indexrelid
             JOIN pg_class AS table_relation
               ON table_relation.oid = index_record.indrelid
             JOIN pg_namespace AS namespace
               ON namespace.oid = table_relation.relnamespace
            WHERE namespace.nspname = 'north_star_module'
              AND table_relation.relname = 'archive_unique_probe'
              AND NOT index_record.indisprimary
            ORDER BY index_relation.relname`,
        );
        assert.deepEqual(after.rows, [
          {
            name: 'legacy_case_insensitive_unique',
            owner: 'north_star_module_materializer',
            predicate: 'archived_at IS NULL',
          },
          {
            name: 'legacy_semantic_unique',
            owner: 'north_star_module_materializer',
            predicate: 'archived_at IS NULL',
          },
        ]);

        const scope = [
          '10000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000002',
        ] as const;
        await client.query(
          `INSERT INTO north_star_module.archive_unique_probe
             (tenant_id, environment_id, record_id, archived_at, code)
           VALUES ($1,$2,$3,clock_timestamp(),'WH-A'),
                  ($1,$2,$4,clock_timestamp(),'wh-a'),
                  ($1,$2,$5,NULL,'WH-A')`,
          [
            ...scope,
            '10000000-0000-4000-8000-000000000003',
            '10000000-0000-4000-8000-000000000004',
            '10000000-0000-4000-8000-000000000005',
          ],
        );
        await assert.rejects(
          client.query(
            `INSERT INTO north_star_module.archive_unique_probe
               (tenant_id, environment_id, record_id, code)
             VALUES ($1,$2,$3,'wh-a')`,
            [...scope, '10000000-0000-4000-8000-000000000006'],
          ),
          (error: unknown) =>
            error instanceof Error &&
            (error as Error & { code?: string }).code === '23505',
        );
      } finally {
        client.release();
      }
    },
  );
});

test('edited and missing applied migrations fail deterministically', async () => {
  await withMigrationDirectory(async (directory) => {
    const original = 'CREATE SCHEMA fixture;\n';
    const path = join(directory, '0001_fixture.sql');
    await writeFile(path, original);

    await withEphemeralPostgres('migration-history-drift', async ({ pool }) => {
      const client = await pool.connect();
      try {
        await runMigrations(client, await loadMigrations(directory));

        await writeFile(path, `${original}-- edited after apply\n`);
        await assert.rejects(
          runMigrations(client, await loadMigrations(directory)),
          (error: unknown) =>
            error instanceof MigrationDriftError &&
            /differs from its checked-in file/.test(error.message),
        );

        await unlink(path);
        await assert.rejects(
          runMigrations(client, await loadMigrations(directory)),
          (error: unknown) =>
            error instanceof MigrationDriftError &&
            /no checked-in file exists/.test(error.message),
        );
      } finally {
        client.release();
      }
    });
  });
});

test('gapped and self-transactional migration streams are rejected', async () => {
  await withMigrationDirectory(async (directory) => {
    await writeFile(join(directory, '0002_gap.sql'), 'SELECT 1;\n');
    await assert.rejects(
      loadMigrations(directory),
      (error: unknown) =>
        error instanceof MigrationDriftError &&
        /must be contiguous/.test(error.message),
    );
  });

  await withMigrationDirectory(async (directory) => {
    await writeFile(
      join(directory, '0001_transaction.sql'),
      'BEGIN;\nSELECT 1;\nCOMMIT;\n',
    );
    await assert.rejects(
      loadMigrations(directory),
      (error: unknown) =>
        error instanceof MigrationDriftError &&
        /runner owns the transaction/.test(error.message),
    );
  });

  await withMigrationDirectory(async (directory) => {
    await writeFile(join(directory, '0001_end_alias.sql'), 'SELECT 1;\nEND;\n');
    await assert.rejects(
      loadMigrations(directory),
      (error: unknown) =>
        error instanceof MigrationDriftError &&
        /runner owns the transaction/.test(error.message),
    );
  });

  await withMigrationDirectory(async (directory) => {
    await writeFile(
      join(directory, '0001_abort_alias.sql'),
      'SELECT 1;\nABORT;\n',
    );
    await assert.rejects(
      loadMigrations(directory),
      (error: unknown) =>
        error instanceof MigrationDriftError &&
        /runner owns the transaction/.test(error.message),
    );
  });

  await withMigrationDirectory(async (directory) => {
    await writeFile(
      join(directory, '0001_start_alias.sql'),
      'START TRANSACTION;\nSELECT 1;\n',
    );
    await assert.rejects(
      loadMigrations(directory),
      (error: unknown) =>
        error instanceof MigrationDriftError &&
        /runner owns the transaction/.test(error.message),
    );
  });
});

test('a failed stream rolls back schema and migration history together', async () => {
  await withMigrationDirectory(async (directory) => {
    await writeFile(
      join(directory, '0001_fixture.sql'),
      'CREATE SCHEMA fixture;\nCREATE TABLE fixture.example (id integer PRIMARY KEY);\n',
    );
    await writeFile(
      join(directory, '0002_broken.sql'),
      'ALTER TABLE fixture.missing ADD COLUMN value text;\n',
    );

    await withEphemeralPostgres('migration-rollback', async ({ pool }) => {
      const client = await pool.connect();
      try {
        await assert.rejects(
          runMigrations(client, await loadMigrations(directory)),
        );
        const state = await client.query<{
          history: string | null;
          schema: string | null;
        }>(`
          SELECT to_regclass('north_star_internal.schema_migrations')::text AS history,
                 to_regnamespace('fixture')::text AS schema
        `);
        assert.deepEqual(state.rows[0], { history: null, schema: null });
      } finally {
        client.release();
      }
    });
  });
});

test('plain physical schema drift fails the checked-in snapshot', async () => {
  await withEphemeralPostgres('physical-schema-drift', async ({ pool }) => {
    const client = await pool.connect();
    try {
      await runMigrations(client, await loadMigrations(checkedInMigrations));
      await assertSchemaMatchesSnapshot(client, checkedInSnapshot);
      await client.query(
        'ALTER TABLE platform.tenants ADD COLUMN ambient_tenant text',
      );
      await assert.rejects(
        assertSchemaMatchesSnapshot(client, checkedInSnapshot),
        (error: unknown) =>
          error instanceof SchemaDriftError &&
          /physical schema differs/.test(error.message),
      );
    } finally {
      client.release();
    }
  });
});

test('dropping the fold-function DDL witness fails the checked-in snapshot', async () => {
  await withEphemeralPostgres('event-trigger-drift', async ({ pool }) => {
    const client = await pool.connect();
    try {
      await runMigrations(client, await loadMigrations(checkedInMigrations));
      await assertSchemaMatchesSnapshot(client, checkedInSnapshot);
      const witness = await client.query<{
        enabled: string;
        event: string;
        owner: string;
      }>(
        `SELECT evtenabled AS enabled, evtevent AS event,
                pg_get_userbyid(evtowner) AS owner
           FROM pg_event_trigger
          WHERE evtname = 'module_fold_function_ddl_witness'`,
      );
      assert.deepEqual(witness.rows, [
        { enabled: 'O', event: 'ddl_command_end', owner: 'postgres' },
      ]);

      await client.query('DROP EVENT TRIGGER module_fold_function_ddl_witness');
      await assert.rejects(
        assertSchemaMatchesSnapshot(client, checkedInSnapshot),
        (error: unknown) =>
          error instanceof SchemaDriftError &&
          /physical schema differs/.test(error.message),
      );
    } finally {
      client.release();
    }
  });
});

test('a failing callback still removes its ephemeral container', async () => {
  let containerName = '';
  await assert.rejects(
    withEphemeralPostgres('failure-cleanup', async (database) => {
      containerName = database.containerName;
      throw new Error('intentional fixture failure');
    }),
    /intentional fixture failure/,
  );
  assert.notEqual(containerName, '');
  await assert.rejects(execFileAsync('docker', ['inspect', containerName]));
});

async function withMigrationDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'north-star-migrations-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
