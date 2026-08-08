/**
 * PS-2 PROBE ONLY — NOT FOR MERGE.
 *
 * Regenerates `db/schema.snapshot.json` after a migration changes the physical
 * schema. `check:schema` asserts the snapshot; nothing in the repository wrote
 * it, so a migration lands with no way to update the file it invalidates except
 * by hand-editing captured catalog output.
 *
 * That is itself a finding: the snapshot is a required, generated artefact with
 * no generator, which is why `PS-2` measured a "six-line migration" as six lines
 * plus a matrix failure a lane cannot resolve locally without writing this.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  captureSchemaSnapshot,
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from './postgres.js';

async function main(): Promise<void> {
  await withEphemeralPostgres('schema-snapshot', async ({ pool }) => {
    const client = await pool.connect();
    try {
      const result = await runMigrations(
        client,
        await loadMigrations(resolve('db/migrations')),
      );
      const snapshot = await captureSchemaSnapshot(client);
      await writeFile(
        resolve('db/schema.snapshot.json'),
        `${JSON.stringify(snapshot, null, 2)}\n`,
        'utf8',
      );
      process.stdout.write(
        `schema-snapshot: WROTE (${String(result.applied.length)} migrations applied)\n`,
      );
    } finally {
      client.release();
    }
  });
}

void main();
