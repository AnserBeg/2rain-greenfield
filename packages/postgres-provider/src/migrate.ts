import { resolve } from 'node:path';

import pg from 'pg';

import { loadMigrations, runMigrations } from './migrations.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required; no default database is allowed');
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
try {
  const client = await pool.connect();
  try {
    const result = await runMigrations(
      client,
      await loadMigrations(resolve('db/migrations')),
    );
    process.stdout.write(
      `migrations: PASS (${result.applied.length} applied, ${result.verified.length} verified)\n`,
    );
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
