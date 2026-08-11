import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import { APPLICATION_IDS } from '../../../packages/domain/src/app/builder.js';

import { startComposedApplication } from './composition-root.js';

const execFileAsync = promisify(execFile);
const postgresImage =
  'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';

/**
 * NOT `north-star-*`, and the prefix is load-bearing rather than cosmetic.
 *
 * `scripts/guard-ephemeral-postgres.mjs` scans `name=^/north-star-` and is
 * invoked by `scripts/run-matrix.sh` AFTER the exclusive lock is taken. Any
 * `north-star-*` container it finds younger than an hour makes the matrix exit
 * 76 — burning the slot for whichever lane was queued — and any older one is
 * `docker rm --force`d with no check on whether its owner is alive. A dev
 * database is deliberately long-lived, so under that name it would both break
 * every lane's matrix and be destroyed mid-session. It is named out of that
 * namespace so the test guard's refusal keeps meaning what it says: a leftover
 * *test* container.
 *
 * The trade is stated rather than hidden: this container is invisible to the
 * matrix guard, so it carries its own lifecycle below.
 */
const containerName =
  process.env.NORTH_STAR_DEV_DATABASE_CONTAINER ?? 'dev-composed-app-postgres';
if (containerName.startsWith('north-star-')) {
  // Refused rather than warned: four packet records still carry
  // `NORTH_STAR_DATABASE_CONTAINER=north-star-g2-…` in their "Test it
  // yourself" steps, and a name that merely *should not* be used is one
  // copy-paste away from being used. The matrix cannot tell this container
  // from a leaked test one, so the name is made unavailable instead.
  throw new TypeError(
    `NORTH_STAR_DEV_DATABASE_CONTAINER must not start with "north-star-": ` +
      `that prefix is reserved for ephemeral test containers, and ` +
      `scripts/run-matrix.sh refuses to run while one is present. Got ${containerName}`,
  );
}
const dataVolume = `${containerName}-data`;
const databasePort = Number.parseInt(
  process.env.NORTH_STAR_DATABASE_PORT ?? '55432',
  10,
);
const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://postgres@127.0.0.1:${String(databasePort)}/postgres`;
const managesContainer = !process.env.DATABASE_URL;

if (managesContainer) await ensureLocalPostgres();

const application = await startComposedApplication({
  databaseUrl,
  host: process.env.HOST ?? '127.0.0.1',
  port: Number.parseInt(process.env.PORT ?? '4174', 10),
  ...(process.env.NORTH_STAR_ROLLBACK_RELEASE_ROOT !== undefined
    ? { rollbackReleaseRoot: process.env.NORTH_STAR_ROLLBACK_RELEASE_ROOT }
    : {}),
  seedProfile: 'distributor',
  tenantSlug:
    process.env.NORTH_STAR_TENANT_SLUG ?? 'local-composed-application',
});

process.stdout.write(
  `COMPOSED_APPLICATION_READY ${JSON.stringify({
    baseUrl: application.baseUrl,
    databaseContainer: managesContainer ? containerName : null,
    releaseRoot: application.runtime.releaseRoot,
    seededRecords: application.seededRecords.length,
    tenantId: application.runtime.identity.tenantId,
  })}\n`,
);
process.stdout.write(
  [
    '',
    `  The composed application is running at ${application.baseUrl}`,
    '',
    `  Items      ${surfaceUrl(APPLICATION_IDS.catalog.listSurfaceId)}`,
    `  Parties    ${surfaceUrl(APPLICATION_IDS.party.listSurfaceId)}`,
    `  Locations  ${surfaceUrl(APPLICATION_IDS.location.listSurfaceId)}`,
    '',
    '  Ctrl-C stops the server and its database container.',
    managesContainer
      ? `  If this process is killed outright, stop it with: docker stop ${containerName}`
      : '  DATABASE_URL was supplied, so no container is managed here.',
    '',
  ].join('\n'),
);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await application.close();
  // The container outliving its session is the defect `leak-guard-orphan`
  // records, so the session stops what it started. A single reused container
  // and one reused named volume is the bounded case: nothing accumulates
  // per-run the way ephemeral test containers and their volumes did.
  if (managesContainer) {
    await dockerSucceeds(['stop', containerName]);
  }
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

function surfaceUrl(surfaceId: string): string {
  return `${application.baseUrl}/?surface=${encodeURIComponent(surfaceId)}`;
}

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
      `${dataVolume}:/var/lib/postgresql/data`,
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
