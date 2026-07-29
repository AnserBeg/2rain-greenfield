import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import { startComposedApplication } from './composition-root.js';

const execFileAsync = promisify(execFile);
const postgresImage =
  'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
const containerName =
  process.env.NORTH_STAR_DATABASE_CONTAINER ?? 'north-star-composed-app';
const databasePort = Number.parseInt(
  process.env.NORTH_STAR_DATABASE_PORT ?? '55432',
  10,
);
const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://postgres@127.0.0.1:${String(databasePort)}/postgres`;

if (!process.env.DATABASE_URL) await ensureLocalPostgres();

const application = await startComposedApplication({
  databaseUrl,
  host: process.env.HOST ?? '127.0.0.1',
  port: Number.parseInt(process.env.PORT ?? '4174', 10),
  ...(process.env.NORTH_STAR_ROLLBACK_RELEASE_ROOT
    ? { rollbackReleaseRoot: process.env.NORTH_STAR_ROLLBACK_RELEASE_ROOT }
    : {}),
  tenantSlug:
    process.env.NORTH_STAR_TENANT_SLUG ?? 'local-composed-application',
});

process.stdout.write(
  `COMPOSED_APPLICATION_READY ${JSON.stringify({
    baseUrl: application.baseUrl,
    databaseContainer: process.env.DATABASE_URL ? null : containerName,
    releaseRoot: application.runtime.releaseRoot,
    tenantId: application.runtime.identity.tenantId,
  })}\n`,
);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await application.close();
};
process.once('SIGINT', () => void stop().then(() => process.exit(0)));
process.once('SIGTERM', () => void stop().then(() => process.exit(0)));

async function ensureLocalPostgres(): Promise<void> {
  if (
    !Number.isInteger(databasePort) ||
    databasePort < 1 ||
    databasePort > 65_535
  ) {
    throw new TypeError('NORTH_STAR_DATABASE_PORT must be a valid TCP port');
  }
  const exists = await dockerSucceeds(['container', 'inspect', containerName]);
  if (!exists) {
    await docker([
      'run',
      '--detach',
      '--name',
      containerName,
      '--publish',
      `127.0.0.1:${String(databasePort)}:5432`,
      '--volume',
      `${containerName}-data:/var/lib/postgresql/data`,
      '--env',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      postgresImage,
    ]);
  } else {
    await docker(['start', containerName]);
  }

  const startedAt = performance.now();
  while (performance.now() - startedAt < 30_000) {
    if (
      await dockerSucceeds([
        'exec',
        containerName,
        'pg_isready',
        '--username',
        'postgres',
      ])
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('local PostgreSQL was not ready within 30 seconds');
}

async function docker(arguments_: readonly string[]): Promise<void> {
  await execFileAsync('docker', [...arguments_], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 45_000,
  });
}

async function dockerSucceeds(arguments_: readonly string[]): Promise<boolean> {
  try {
    await docker(arguments_);
    return true;
  } catch {
    return false;
  }
}
