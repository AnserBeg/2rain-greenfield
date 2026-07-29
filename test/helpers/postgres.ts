import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import pg from 'pg';

const execFileAsync = promisify(execFile);

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

export async function withEphemeralPostgres<T>(
  label: string,
  run: (database: EphemeralPostgres) => Promise<T>,
): Promise<T> {
  const safeLabel = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .slice(0, 24);
  const containerName = `north-star-${safeLabel}-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  let pool: pg.Pool | undefined;

  try {
    await docker([
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--publish',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
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
    return await run({ containerName, connection, pool });
  } finally {
    if (pool) await pool.end();
    if (started) {
      await removeEphemeralPostgresContainer(containerName);
    }
  }
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
    (stderr.includes(`No such container: ${containerName}`) ||
      stderr.includes(`No such object: ${containerName}`))
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
