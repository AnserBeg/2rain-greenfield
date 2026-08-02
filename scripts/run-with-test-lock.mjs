#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';

const LOCK_PATH =
  process.env.NORTH_STAR_TEST_LOCK_PATH ?? '/tmp/north-star-matrix.lock';
const inheritedMode = process.env.NORTH_STAR_TEST_LOCK_HELD;
const [mode, separator, ...command] = process.argv.slice(2);

if (
  (mode !== 'shared' && mode !== 'exclusive') ||
  separator !== '--' ||
  command.length === 0
) {
  process.stderr.write(
    'Usage: run-with-test-lock.mjs <shared|exclusive> -- <command> [args...]\n',
  );
  process.exit(2);
}

if (inheritedMode === 'exclusive' || inheritedMode === mode) {
  process.exitCode = await run(command, process.env);
} else if (inheritedMode === 'shared') {
  process.stderr.write(
    'TEST_GATE_LOCK_UPGRADE_REFUSED: an exclusive gate cannot run inside a shared gate\n',
  );
  process.exitCode = 2;
} else {
  const timeoutSeconds = parseTimeout(
    process.env.NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS,
  );
  process.stderr.write(
    `[test-lock] waiting for ${mode} access to ${LOCK_PATH}\n`,
  );
  const environment = {
    ...process.env,
    NORTH_STAR_TEST_LOCK_HELD: mode,
  };
  const flockArguments = [
    mode === 'shared' ? '--shared' : '--exclusive',
    '--conflict-exit-code',
    '75',
    '--timeout',
    String(timeoutSeconds),
    LOCK_PATH,
    ...command,
  ];
  const exitCode = await run(['flock', ...flockArguments], environment);
  if (exitCode === 75) {
    process.stderr.write(
      `TEST_GATE_LOCK_BUSY: ${mode} access to ${LOCK_PATH} was unavailable for ${timeoutSeconds}s\n`,
    );
  }
  process.exitCode = exitCode;
}

function parseTimeout(value) {
  if (value === undefined) return 300;
  if (!/^\d+$/u.test(value)) {
    process.stderr.write(
      `Invalid NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS: ${JSON.stringify(value)}\n`,
    );
    process.exit(2);
  }
  return Number(value);
}

function run([executable, ...arguments_], environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      env: environment,
      stdio: 'inherit',
    });
    const forwardInterrupt = () => child.kill('SIGINT');
    const forwardTermination = () => child.kill('SIGTERM');
    process.once('SIGINT', forwardInterrupt);
    process.once('SIGTERM', forwardTermination);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.off('SIGINT', forwardInterrupt);
      process.off('SIGTERM', forwardTermination);
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
