import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  enumerateTenantTables,
  parseTenantCompletenessManifest,
  verifyTenantCompleteness,
} from '../../packages/dev-tooling/src/tenant-completeness.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

async function main(): Promise<void> {
  const manifest = parseTenantCompletenessManifest(
    JSON.parse(
      await readFile(
        resolve('test/architecture/tenant-completeness.manifest.json'),
        'utf8',
      ),
    ) as unknown,
  );
  await withEphemeralPostgres('tenant-manifest-red', async ({ pool }) => {
    const client = await pool.connect();
    try {
      await runMigrations(
        client,
        await loadMigrations(resolve('db/migrations')),
      );
      await client.query(
        `CREATE TABLE platform.g3_p2a_unclassified_probe (
           tenant_id uuid NOT NULL,
           record_id uuid NOT NULL PRIMARY KEY
         )`,
      );
      verifyTenantCompleteness(manifest, await enumerateTenantTables(client));
    } finally {
      client.release();
    }
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
