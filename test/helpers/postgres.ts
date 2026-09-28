import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import pg from 'pg';

const execFileAsync = promisify(execFile);
const postgresGuardianPath = join(__dirname, 'postgres-container-guardian.mjs');

export const postgresTestImage =
  'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';

export interface EphemeralPostgres {
  containerName: string;
  connection: pg.PoolConfig;
  pool: pg.Pool;
}

interface DockerResult {
  stderr: string;
  stdout: string;
}

type DockerRunner = (arguments_: readonly string[]) => Promise<DockerResult>;

export interface EphemeralPostgresReadinessOptions {
  deadlineMilliseconds?: number;
  inspectContainer?: (containerName: string) => Promise<string>;
  isReadyInsideContainer?: (containerName: string) => Promise<boolean>;
  now?: () => number;
  pause?: (milliseconds: number) => Promise<void>;
  probePublished?: (connection: pg.PoolConfig) => Promise<unknown | undefined>;
  readContainerLogs?: (containerName: string) => Promise<DockerResult>;
}

const terminalContainerStates = new Set([
  'dead',
  'exited',
  'removed',
  'removing',
]);
const waitingContainerStates = new Set([
  'created',
  'paused',
  'restarting',
  'running',
]);

export interface EphemeralPostgresOptions {
  /** The data directory's tmpfs size; the default suits every test database. */
  dataSizeMegabytes?: number;
}

export async function withEphemeralPostgres<T>(
  label: string,
  run: (database: EphemeralPostgres) => Promise<T>,
  { dataSizeMegabytes = 256 }: EphemeralPostgresOptions = {},
): Promise<T> {
  if (!Number.isSafeInteger(dataSizeMegabytes) || dataSizeMegabytes < 1)
    throw new RangeError('dataSizeMegabytes must be a positive integer');
  const safeLabel = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .slice(0, 24);
  const containerName = `north-star-${safeLabel}-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  let pool: pg.Pool | undefined;
  const guardian = await startEphemeralPostgresGuardian(containerName);

  let outcome:
    | { readonly ok: true; readonly value: T }
    | {
        readonly error: unknown;
        readonly ok: false;
      };
  try {
    await docker([
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--label',
      'north-star.ephemeral-postgres=true',
      '--label',
      `north-star.owner-pid=${process.pid}`,
      '--publish',
      '127.0.0.1::5432',
      '--tmpfs',
      `/var/lib/postgresql/data:rw,noexec,nosuid,size=${String(dataSizeMegabytes)}m`,
      '--env',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '--env',
      'POSTGRES_INITDB_ARGS=--no-sync',
      postgresTestImage,
    ]);
    started = true;

    const { stdout } = await docker(['port', containerName, '5432/tcp']);
    const port = Number.parseInt(stdout.trim().split(':').at(-1) ?? '', 10);
    if (!Number.isInteger(port)) {
      throw new Error(
        `docker returned an invalid PostgreSQL port: ${stdout.trim()}`,
      );
    }

    const connection: pg.PoolConfig = {
      database: 'postgres',
      host: '127.0.0.1',
      max: 4,
      port,
      user: 'postgres',
    };
    await waitUntilReady(connection, containerName);
    pool = new pg.Pool(connection);
    outcome = {
      ok: true,
      value: await run({ containerName, connection, pool }),
    };
  } catch (error) {
    outcome = { error, ok: false };
  }

  const cleanupErrors: unknown[] = [];
  if (pool) {
    try {
      await pool.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  let containerRemoved = !started;
  if (started) {
    try {
      await removeEphemeralPostgresContainer(containerName);
      containerRemoved = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    if (containerRemoved) {
      guardian.kill('SIGTERM');
    } else {
      guardian.kill('SIGUSR1');
    }
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (!outcome.ok) {
    if (cleanupErrors.length === 0) throw outcome.error;
    throw new AggregateError(
      [outcome.error, ...cleanupErrors],
      `ephemeral PostgreSQL operation and cleanup failed: ${containerName}`,
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      `ephemeral PostgreSQL cleanup failed: ${containerName}`,
    );
  }
  return outcome.value;
}

function startEphemeralPostgresGuardian(
  containerName: string,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const guardian = spawn(
      process.execPath,
      [
        postgresGuardianPath,
        containerName,
        String(process.pid),
        readProcessStartTicks(process.pid),
        String(process.ppid),
        readProcessStartTicks(process.ppid),
      ],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    const onError = (error: Error) => {
      reject(
        new Error(`ephemeral PostgreSQL guardian failed to start`, {
          cause: error,
        }),
      );
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(
        new Error(
          `ephemeral PostgreSQL guardian exited before ready: code=${String(code)} signal=${String(signal)}`,
        ),
      );
    };
    guardian.once('error', onError);
    guardian.once('exit', onExit);
    guardian.once('message', (message: unknown) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('status' in message) ||
        message.status !== 'ready'
      ) {
        return;
      }
      guardian.off('error', onError);
      guardian.off('exit', onExit);
      guardian.unref();
      resolve(guardian);
    });
  });
}

function readProcessStartTicks(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const closingParenthesis = stat.lastIndexOf(')');
  if (closingParenthesis < 0) {
    throw new Error(`cannot read process identity for PID ${pid}`);
  }
  const startTicks = stat.slice(closingParenthesis + 2).split(' ')[19];
  if (startTicks === undefined || !/^\d+$/u.test(startTicks)) {
    throw new Error(`cannot read process identity for PID ${pid}`);
  }
  return startTicks;
}

export async function waitUntilReady(
  connection: pg.PoolConfig,
  containerName: string,
  options: EphemeralPostgresReadinessOptions = {},
): Promise<void> {
  const deadlineMilliseconds = options.deadlineMilliseconds ?? 30_000;
  const inspectContainer =
    options.inspectContainer ?? inspectEphemeralPostgresContainer;
  const isReadyInsideContainer =
    options.isReadyInsideContainer ?? isEphemeralPostgresReadyInsideContainer;
  const now = options.now ?? (() => performance.now());
  const pause =
    options.pause ??
    ((milliseconds: number) =>
      new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
  const probePublished = options.probePublished ?? probePublishedPostgres;
  const readContainerLogs = options.readContainerLogs ?? containerLogs;
  const startedAt = now();
  let lastError: unknown;
  let readyInsideContainer = false;

  while (now() - startedAt < deadlineMilliseconds) {
    lastError = await probePublished(connection);
    if (lastError === undefined) return;

    const state = await inspectContainer(containerName);
    if (classifyEphemeralPostgresContainerState(state) === 'terminal') {
      await throwStoppedBeforeReady(containerName, state, lastError);
    }

    if (state === 'running' && (await isReadyInsideContainer(containerName))) {
      readyInsideContainer = true;
      const finalError = await probePublished(connection);
      if (finalError === undefined) return;
      lastError = finalError;
    }
    await pause(100);
  }

  const { stdout, stderr } = await readContainerLogs(containerName);
  if (readyInsideContainer) {
    throw new Error(
      `ephemeral PostgreSQL is ready inside its container but its published endpoint is unavailable: ${String(lastError)}\n${stdout}${stderr}`,
    );
  }
  throw new Error(
    `ephemeral PostgreSQL was not ready within ${deadlineMilliseconds}ms: ${String(lastError)}\n${stdout}${stderr}`,
  );
}

async function probePublishedPostgres(
  connection: pg.PoolConfig,
): Promise<unknown | undefined> {
  const client = new pg.Client({
    ...connection,
    connectionTimeoutMillis: 500,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return undefined;
  } catch (error) {
    await client.end().catch(() => undefined);
    return error;
  }
}

async function throwStoppedBeforeReady(
  containerName: string,
  state: string,
  lastError: unknown,
): Promise<never> {
  const { stdout, stderr } = await containerLogs(containerName);
  throw new Error(
    `ephemeral PostgreSQL stopped before it was ready (${state}): ${String(lastError)}\n${stdout}${stderr}`,
  );
}

export function classifyEphemeralPostgresContainerState(
  state: string,
): 'terminal' | 'waiting' {
  if (terminalContainerStates.has(state)) return 'terminal';
  if (waitingContainerStates.has(state)) return 'waiting';
  throw new Error(`docker returned an unexpected container state: ${state}`);
}

export async function inspectEphemeralPostgresContainer(
  containerName: string,
  runDocker: DockerRunner = docker,
): Promise<string> {
  try {
    const { stdout } = await runDocker([
      'inspect',
      '--format',
      '{{.State.Status}}',
      containerName,
    ]);
    return stdout.trim();
  } catch (error) {
    if (isMissingDockerContainerError(error, containerName)) return 'removed';
    throw error;
  }
}

export async function isEphemeralPostgresReadyInsideContainer(
  containerName: string,
  runDocker: DockerRunner = docker,
): Promise<boolean> {
  try {
    await runDocker([
      'exec',
      containerName,
      'pg_isready',
      '--host',
      '127.0.0.1',
      '--port',
      '5432',
      '--username',
      'postgres',
      '--dbname',
      'postgres',
    ]);
    return true;
  } catch (error) {
    if (isPgIsReadyWaitingResult(error)) return false;
    throw error;
  }
}

export async function removeEphemeralPostgresContainer(
  containerName: string,
  runDocker: DockerRunner = docker,
): Promise<void> {
  try {
    await runDocker(['rm', '--force', containerName]);
  } catch (error) {
    if (!isMissingDockerContainerError(error, containerName)) throw error;
  }
}

async function containerLogs(containerName: string): Promise<DockerResult> {
  try {
    return await docker(['logs', containerName]);
  } catch (error) {
    if (isMissingDockerContainerError(error, containerName)) {
      return { stderr: '', stdout: '' };
    }
    throw error;
  }
}

function isMissingDockerContainerError(
  error: unknown,
  containerName: string,
): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause !== 'object' || cause === null || !('stderr' in cause)) {
    return false;
  }
  const stderr = cause.stderr;
  return (
    typeof stderr === 'string' &&
    (stderr.toLowerCase().includes(`no such container: ${containerName}`) ||
      stderr.toLowerCase().includes(`no such object: ${containerName}`))
  );
}

function isPgIsReadyWaitingResult(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause !== 'object' || cause === null) return false;
  const code = 'code' in cause ? cause.code : undefined;
  const stderr = 'stderr' in cause ? cause.stderr : undefined;
  return (
    (code === 1 || code === 2) &&
    (stderr === '' || (Buffer.isBuffer(stderr) && stderr.length === 0))
  );
}

async function docker(arguments_: readonly string[]): Promise<DockerResult> {
  try {
    return await execFileAsync('docker', [...arguments_], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`docker ${arguments_[0] ?? ''} failed`, { cause: error });
  }
}
