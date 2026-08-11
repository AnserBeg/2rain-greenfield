import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import { APPLICATION_IDS } from '../../../packages/domain/src/app/builder.js';

import { resolveDevContainer } from './dev-container.js';
import { runShutdown } from './dev-lifecycle.js';
import {
  startComposedApplication,
  type RunningComposedApplication,
} from './composition-root.js';

const execFileAsync = promisify(execFile);
const postgresImage =
  'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';

// Resolved BEFORE anything fallible runs, so a refused name never reaches the
// point of creating a container. See dev-container.ts for why the prefix and
// the retired variable are refused rather than warned about.
const container = resolveDevContainer(process.env);
const databasePort = Number.parseInt(
  process.env.NORTH_STAR_DATABASE_PORT ?? '55432',
  10,
);
const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://postgres@127.0.0.1:${String(databasePort)}/postgres`;
const managesContainer = !process.env.DATABASE_URL;

/**
 * `containerAttempted` records that a create/start command was ISSUED, not
 * that it succeeded, and it is set synchronously before the command is
 * launched. `pendingContainerCommand` is that command.
 *
 * Ownership cannot be recorded after the await: a signal arriving while
 * `docker run --detach` is in flight would then find no container recorded,
 * skip cleanup, exit, and let the Docker child finish creating an orphan.
 * Recording it before the await is necessary but not sufficient — shutdown
 * must also WAIT for the command to settle, or the stop races ahead of the
 * creation it is meant to undo. Both halves live here and in `runShutdown`.
 */
let containerAttempted = false;
let pendingContainerCommand: Promise<unknown> = Promise.resolve();
let application: RunningComposedApplication | undefined;
let shuttingDown = false;

// Installed BEFORE the container starts. Registering them after startup left
// every failure between `docker run` and `listen()` — a Ctrl-C during the
// seed, an occupied port, a migration error — leaking the container.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(0);
  });
}

try {
  if (managesContainer) await ensureLocalPostgres();
  application = await startComposedApplication({
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
} catch (error) {
  process.stderr.write(
    `COMPOSED_APPLICATION_START_FAILED ${String(error instanceof Error ? error.stack : error)}\n`,
  );
  await shutdown(1);
}

announce(application!);

function announce(running: RunningComposedApplication): void {
  process.stdout.write(
    `COMPOSED_APPLICATION_READY ${JSON.stringify({
      baseUrl: running.baseUrl,
      databaseContainer: managesContainer ? container.name : null,
      releaseRoot: running.runtime.releaseRoot,
      seededRecords: running.seededRecords.length,
      tenantId: running.runtime.identity.tenantId,
    })}\n`,
  );
  const surface = (surfaceId: string): string =>
    `${running.baseUrl}/?surface=${encodeURIComponent(surfaceId)}`;
  process.stdout.write(
    [
      '',
      `  The composed application is running at ${running.baseUrl}`,
      '',
      `  Items      ${surface(APPLICATION_IDS.catalog.listSurfaceId)}`,
      `  Parties    ${surface(APPLICATION_IDS.party.listSurfaceId)}`,
      `  Locations  ${surface(APPLICATION_IDS.location.listSurfaceId)}`,
      '',
      '  Ctrl-C stops the server and its database container.',
      managesContainer
        ? `  If this process is killed outright: pnpm --filter @north-star/api dev:stop`
        : '  DATABASE_URL was supplied, so no container is managed here.',
      '',
    ].join('\n'),
  );
}

/**
 * Each step runs independently and every failure is collected, because the
 * previous shape skipped `docker stop` whenever `application.close()` rejected
 * and then exited 0 anyway — reporting success while leaking the container.
 */
async function shutdown(code: number): Promise<never> {
  if (shuttingDown) return await never();
  shuttingDown = true;
  const { failures } = await runShutdown({
    closeApplication: application
      ? async () => {
          await application?.close();
        }
      : undefined,
    settleContainerCommand: async () => {
      await pendingContainerCommand;
    },
    stopContainer: containerAttempted ? stopContainer : undefined,
  });
  for (const failure of failures) {
    process.stderr.write(
      `COMPOSED_APPLICATION_SHUTDOWN_FAILED ${String(
        failure instanceof Error ? failure.stack : failure,
      )}\n`,
    );
  }
  if (failures.length > 0 && containerAttempted) {
    process.stderr.write(
      `The database container may still be running. Stop it with: ` +
        `pnpm --filter @north-star/api dev:stop\n`,
    );
  }
  process.exit(failures.length > 0 ? 1 : code);
}

/** Keeps the `never` return honest for the re-entrant call. */
function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}

async function ensureLocalPostgres(): Promise<void> {
  if (
    !Number.isInteger(databasePort) ||
    databasePort < 1 ||
    databasePort > 65_535
  ) {
    throw new TypeError('NORTH_STAR_DATABASE_PORT must be a valid TCP port');
  }
  const exists = await dockerSucceeds(['container', 'inspect', container.name]);
  // These two statements are adjacent and synchronous on purpose. A signal
  // handler is a macrotask and cannot interleave between them, so there is no
  // window in which the command is running but unrecorded.
  containerAttempted = true;
  pendingContainerCommand = exists
    ? docker(['start', container.name])
    : docker([
        'run',
        '--detach',
        '--name',
        container.name,
        '--publish',
        `127.0.0.1:${String(databasePort)}:5432`,
        '--volume',
        `${container.volume}:/var/lib/postgresql/data`,
        '--env',
        'POSTGRES_HOST_AUTH_METHOD=trust',
        postgresImage,
      ]);
  await pendingContainerCommand;

  const startedAt = performance.now();
  while (performance.now() - startedAt < 30_000) {
    if (
      await dockerSucceeds([
        'exec',
        container.name,
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

/**
 * A container that was never created is not a cleanup failure. Anything else
 * is, and it must reach the exit code rather than being swallowed.
 */
async function stopContainer(): Promise<void> {
  try {
    await docker(['stop', container.name]);
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '')
        : '';
    if (/no such (container|object)/iu.test(stderr)) return;
    throw error;
  }
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
