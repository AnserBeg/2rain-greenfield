import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

import { resolveDevContainer } from './dev-container.js';

/**
 * `dev:stop` and `dev:reset` go through the SAME resolver the dev server uses.
 * Hard-coding the default name in the package scripts meant a configured
 * container was started under one name while `dev:stop` targeted another.
 */
const execFileAsync = promisify(execFile);
const action = process.argv[2];
if (action !== 'stop' && action !== 'reset') {
  process.stderr.write('usage: dev-container-cli.ts <stop|reset>\n');
  process.exit(2);
}

const container = resolveDevContainer(process.env);

if (action === 'stop') {
  await run(['stop', container.name]);
} else {
  await run(['rm', '--force', container.name]);
  await run(['volume', 'rm', '--force', container.volume]);
}

/**
 * Reports what did and did not happen. A reset that cannot remove the volume
 * has not reset anything, and saying so is the point of the command.
 */
async function run(argv: readonly string[]): Promise<void> {
  try {
    await execFileAsync('docker', [...argv], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 45_000,
    });
    process.stdout.write(`docker ${argv.join(' ')}: ok\n`);
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '')
        : '';
    if (/no such (container|volume|object)/iu.test(stderr)) {
      process.stdout.write(`docker ${argv.join(' ')}: already absent\n`);
      return;
    }
    process.stderr.write(`docker ${argv.join(' ')} failed: ${stderr.trim()}\n`);
    process.exitCode = 1;
  }
}
