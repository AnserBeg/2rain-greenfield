import { resolve } from 'node:path';

import {
  assertSchemaMatchesSnapshot,
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from './postgres.js';

async function main(): Promise<void> {
  await withEphemeralPostgres('schema-check', async ({ pool }) => {
    const client = await pool.connect();
    try {
      const result = await runMigrations(
        client,
        await loadMigrations(resolve('db/migrations')),
      );
      await assertSchemaMatchesSnapshot(
        client,
        resolve('db/schema.snapshot.json'),
      );
      process.stdout.write(
        `migrations: PASS (${result.applied.length} applied, ${result.verified.length} verified)\n` +
          'schema-drift: PASS\n',
      );
    } finally {
      client.release();
    }
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
