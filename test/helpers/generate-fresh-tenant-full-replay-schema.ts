import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type pg from 'pg';
import { format } from 'prettier';

import { COMPOSED_APPLICATION_INVENTORY_SCOPE } from '../../apps/api/src/composition-root.js';
import { createComposedApplicationRuntime } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/inventory-posting-capability-executor.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { captureSchemaSnapshot } from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from './postgres.js';

const compiledArtifactPath = resolve('apps/web/release/app.compiled.json');
const migrationsDirectory = resolve('db/migrations');
const snapshotPath = resolve(
  'test/postgres/fresh-tenant-full-replay-schema.snapshot.json',
);
// The first release whose registered search queries remain serviceable under
// the current runtime. Starting here still applies every earlier physical
// transition through the bounded fresh-install path; every successor is then
// activated individually so the resulting snapshot observes full transition
// replay without claiming obsolete pre-search heads can still serve.
const FULL_REPLAY_SERVING_FLOOR_ROOT =
  'd726ad313780bc595c97a0ecb30c9eaec84984e4a19fa28c2e8f5361e7edf12e';

async function main(): Promise<void> {
  const compiledApplication = JSON.parse(
    await readFile(compiledArtifactPath, 'utf8'),
  ) as {
    applications: { releaseRoot?: string }[];
    bootstrap: unknown;
    schemaVersion: string;
  };
  const servingFloorIndex = compiledApplication.applications.findIndex(
    (application) => application.releaseRoot === FULL_REPLAY_SERVING_FLOOR_ROOT,
  );
  if (servingFloorIndex < 0) {
    throw new Error(
      `recorded lineage no longer contains full-replay serving floor ${FULL_REPLAY_SERVING_FLOOR_ROOT}`,
    );
  }

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
