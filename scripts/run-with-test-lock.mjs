#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import process from 'node:process';

import {
  describeLockUsers,
  recordLockUser,
  releaseLockUser,
  sweepStaleLockUsers,
} from './test-lock-registry.mjs';

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
  const label =
    process.env.NORTH_STAR_TEST_LOCK_LABEL ??
    process.env.npm_lifecycle_event ??
    'unlabelled';
  const commandText = command.join(' ');
  // The kernel will not name an flock holder, so this process holds the lock on
  // its own descriptor and records itself. A dead record is left behind on
  // purpose: the registry reports it as stale rather than blaming it.
  const lockDescriptor = openSync(
    LOCK_PATH,
    constants.O_RDONLY | constants.O_CREAT,
    0o666,
  );
  try {
    recordLockUser({
      lockPath: LOCK_PATH,
      mode,
      state: 'waiting',
      label,
      command: commandText,
    });
    process.stderr.write(
      `[test-lock] waiting for ${mode} access to ${LOCK_PATH}\n`,
    );
    reportOtherParticipants();

    const acquisitionCode = await run(
      [
        'flock',
        mode === 'shared' ? '--shared' : '--exclusive',
        '--conflict-exit-code',
        '75',
        '--timeout',
        String(timeoutSeconds),
        '3',
      ],
      process.env,
      ['inherit', 'inherit', 'inherit', lockDescriptor],
    );
    if (acquisitionCode !== 0) {
      if (acquisitionCode === 75) {
        process.stderr.write(
          `TEST_GATE_LOCK_BUSY: ${mode} access to ${LOCK_PATH} was unavailable for ${timeoutSeconds}s\n`,
        );
        reportOtherParticipants();
      }
      process.exitCode = acquisitionCode;
    } else {
      // flock locked the open file description this process owns, so the lock
      // outlives the flock child and is released when this process exits.
      recordLockUser({
        lockPath: LOCK_PATH,
        mode,
        state: 'holding',
        label,
        command: commandText,
      });
      reportStaleParticipants();
      process.exitCode = await run(command, {
        ...process.env,
        NORTH_STAR_TEST_LOCK_HELD: mode,
      });
    }
  } finally {
    releaseLockUser(LOCK_PATH);
    closeSync(lockDescriptor);
  }
}

function reportOtherParticipants() {
  for (const line of describeLockUsers(LOCK_PATH, {
    excludePid: process.pid,
  })) {
    process.stderr.write(`${line}\n`);
  }
}

function reportStaleParticipants() {
  const stale = describeLockUsers(LOCK_PATH, {
    excludePid: process.pid,
  }).filter((line) => line.includes('STALE record'));
  for (const line of stale) {
    process.stderr.write(`${line}\n`);
  }
  sweepStaleLockUsers(LOCK_PATH);
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

function run(
  [executable, ...arguments_],
  environment,
  stdio = ['inherit', 'inherit', 'inherit'],
) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      env: environment,
      stdio,
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
