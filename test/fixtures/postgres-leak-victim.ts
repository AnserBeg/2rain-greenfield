import { spawn } from 'node:child_process';

import { withEphemeralPostgres } from '../helpers/postgres.js';

const mode = process.argv[2] ?? 'worker';

async function main(): Promise<void> {
  if (mode === 'parent') {
    spawn(process.execPath, ['--import', 'tsx', __filename, 'worker'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    process.stdin.resume();
  } else if (mode === 'worker') {
    process.once('SIGUSR2', () => {
      setImmediate(() => {
        throw new Error('POSTGRES_LEAK_VICTIM_UNCAUGHT');
      });
    });

    await withEphemeralPostgres(
      'leak-guard-victim',
      async ({ containerName }) => {
        process.stdout.write(
          `POSTGRES_LEAK_VICTIM=${JSON.stringify({
            containerName,
            parentPid: process.ppid,
            pid: process.pid,
          })}\n`,
        );
        await new Promise<never>(() => {
          setInterval(() => undefined, 1_000);
        });
      },
    );
  } else {
    throw new Error(`unknown PostgreSQL leak victim mode: ${mode}`);
  }
}

void main().catch((error: unknown) => {
  setImmediate(() => {
    throw error;
  });
});
