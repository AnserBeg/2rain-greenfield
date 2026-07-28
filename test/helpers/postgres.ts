import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
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
      await docker(['rm', '--force', containerName]);
    }
  }
}

async function waitUntilReady(
  connection: pg.PoolConfig,
  containerName: string,
): Promise<void> {
  let lastError: unknown;

  while (true) {
    const client = new pg.Client({
      ...connection,
      connectionTimeoutMillis: 500,
    });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
    }

    const state = await containerState(containerName);
    if (state !== 'running') {
      const { stdout, stderr } = await docker(['logs', containerName], true);
      throw new Error(
        `ephemeral PostgreSQL stopped before it was ready (${state}): ${String(lastError)}\n${stdout}${stderr}`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

async function containerState(containerName: string): Promise<string> {
  const { stdout } = await docker([
    'inspect',
    '--format',
    '{{.State.Status}}',
    containerName,
  ]);
  return stdout.trim();
}

async function docker(
  arguments_: readonly string[],
  tolerateFailure = false,
): Promise<{ stderr: string; stdout: string }> {
  try {
    return await execFileAsync('docker', [...arguments_], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    if (tolerateFailure) return { stderr: '', stdout: '' };
    throw new Error(`docker ${arguments_[0] ?? ''} failed`, { cause: error });
  }
}
