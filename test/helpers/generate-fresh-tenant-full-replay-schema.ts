import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type pg from 'pg';
import { format } from 'prettier';

import { COMPOSED_APPLICATION_INVENTORY_SCOPE } from '../../apps/api/src/composition-root.js';
import { createComposedApplicationRuntime } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { captureSchemaSnapshot } from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from './postgres.js';

const compiledArtifactPath = resolve('apps/web/release/app.compiled.json');
const migrationsDirectory = resolve('db/migrations');
const snapshotPath = resolve(
  'test/postgres/fresh-tenant-full-replay-schema.snapshot.json',
);

async function main(): Promise<void> {
  const compiledApplication = JSON.parse(
    await readFile(compiledArtifactPath, 'utf8'),
  ) as {
    applications: unknown[];
    bootstrap: unknown;
    schemaVersion: string;
  };

  await withEphemeralPostgres(
    'fresh-tenant-full-replay',
    async ({ connection, pool }) => {
      for (
        let index = 0;
        index < compiledApplication.applications.length;
        index += 1
      ) {
        const runtime = await createComposedApplicationRuntime({
          compiledApplication: {
            applications: compiledApplication.applications.slice(0, index + 1),
            bootstrap: compiledApplication.bootstrap,
            schemaVersion: compiledApplication.schemaVersion,
          },
          databaseUrl: connectionUrl(connection),
          inventoryScopeProvisioning: COMPOSED_APPLICATION_INVENTORY_SCOPE,
          migrationsDirectory,
          providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
          tenantSlug: 'fresh-tenant-full-replay',
        });
        await runtime.close();
      }
      const client = await pool.connect();
      try {
        const snapshot = await captureSchemaSnapshot(client, [
          'north_star_module',
        ]);
        await writeFile(
          snapshotPath,
          await format(JSON.stringify(snapshot), { parser: 'json' }),
        );
      } finally {
        client.release();
      }
    },
  );
}

function connectionUrl(connection: pg.PoolConfig): string {
  return `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
