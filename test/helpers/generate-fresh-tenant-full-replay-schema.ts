import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type pg from 'pg';
import { format } from 'prettier';

import { COMPOSED_APPLICATION_INVENTORY_SCOPE } from '../../apps/api/src/composition-root.js';
import { createComposedApplicationRuntime } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/inventory-posting-capability-executor.js';
import { FULFILLMENT_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/fulfillment-capability-executor.js';
import { RECEIVING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receiving-capability-executor.js';
import { RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receivables-capability-executor.js';
import { PAYABLES_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/payables-capability-executor.js';
import { RETURNABLES_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/returnables-capability-executor.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { captureSchemaSnapshot } from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from './postgres.js';

const compiledArtifactPath = resolve('apps/web/release/app.compiled.json');
const migrationsDirectory = resolve('db/migrations');
const snapshotPath = resolve(
  'test/postgres/fresh-tenant-full-replay-schema.snapshot.json',
);
// ADR-0066: the disposable application now starts at its current baseline.
const servingFloorIndex = 0;

async function main(): Promise<void> {
  const compiledApplication = JSON.parse(
    await readFile(compiledArtifactPath, 'utf8'),
  ) as {
    applications: { releaseRoot?: string }[];
    application?: { releaseRoot?: string };
    bootstrap: unknown;
    schemaVersion: string;
  };
  compiledApplication.applications ??= [compiledApplication.application!];
  compiledApplication.schemaVersion =
    'northstar.web:compiled-application-release/v2';

  await withEphemeralPostgres(
    'fresh-tenant-full-replay',
    async ({ connection, pool }) => {
      for (
        let index = servingFloorIndex;
        index < compiledApplication.applications.length;
        index += 1
      ) {
        const runtime = await createComposedApplicationRuntime({
          capabilityOperationExecutorFactories: [
            INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
            RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
            FULFILLMENT_CAPABILITY_EXECUTOR_FACTORY,
            RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY,
            PAYABLES_CAPABILITY_EXECUTOR_FACTORY,
            RETURNABLES_CAPABILITY_EXECUTOR_FACTORY,
          ],
          compiledApplication: {
            applications: compiledApplication.applications.slice(0, index + 1),
            bootstrap: compiledApplication.bootstrap,
            schemaVersion: compiledApplication.schemaVersion,
          },
          databaseUrl: connectionUrl(connection),
          inventoryScopeProvisioning: COMPOSED_APPLICATION_INVENTORY_SCOPE,
          localDemoIdentity: true,
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
    // Every lineage entry's install keeps its release artifacts and their
    // write-ahead log; nineteen entries overflow the default 256 MB.
    { dataSizeMegabytes: 1024 },
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
