#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import process from 'node:process';

import {
  describeLockUser,
  describeLockUsers,
  mintLockClaim,
  readLockUsers,
  recordLockUser,
  releaseLockUser,
  sweepStaleLockUsers,
  validateLockClaim,
} from './test-lock-registry.mjs';

const LOCK_PATH =
  process.env.NORTH_STAR_TEST_LOCK_PATH ?? '/tmp/north-star-matrix.lock';
const inheritedClaim = process.env.NORTH_STAR_TEST_LOCK_HELD;
const [mode, separator, ...command] = process.argv.slice(2);
const label =
  process.env.NORTH_STAR_TEST_LOCK_LABEL ??
  process.env.npm_lifecycle_event ??
  'unlabelled';
const commandText = command.join(' ');

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

// An inherited claim is a statement, not proof. No asking process can inspect
// a descriptor it does not own, so the claim is checked against the registry:
// the lock path it names, the holder it names, that holder's start ticks, and
// the mode that holder records RIGHT NOW. Anything short of all four resolving
// means acquiring for real.
const bypass =
  inheritedClaim === undefined
    ? { honoured: false, reason: 'no lease claim was inherited' }
    : validateLockClaim(inheritedClaim, LOCK_PATH, mode);

if (bypass.honoured) {
  process.exitCode = await run(command, process.env);
} else {
  if (inheritedClaim !== undefined) {
    process.stderr.write(
      `[test-lock] inherited lease claim NOT honoured: ${bypass.reason};` +
        ` acquiring ${mode} access for real\n`,
    );
  }
  const timeoutSeconds = parseTimeout(
    process.env.NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS,
  );
  // The kernel will not name an flock holder, so this process holds the lock on
  // its own descriptor and records itself. A dead record is left behind on
  // purpose: the registry reports it as stale rather than blaming it.
  const lockDescriptor = openSync(
    LOCK_PATH,
    constants.O_RDONLY | constants.O_CREAT,
    0o666,
  );
  try {
    record('waiting');
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
      // outlives the flock child and is released when this process exits. The
      // record is written before the claim is minted: a child that validates
      // the claim must find the holder already recorded.
      record('holding');
      reportStaleParticipants();
      process.exitCode = await run(command, {
        ...process.env,
        NORTH_STAR_TEST_LOCK_HELD: mintLockClaim(LOCK_PATH, mode),
      });
    }
  } finally {
    try {
      releaseLockUser(LOCK_PATH);
    } catch (error) {
      process.stderr.write(
        `TEST_GATE_REGISTRY_WRITE_FAILED: cannot release pid=${process.pid}` +
          ` for ${LOCK_PATH}: ${describeError(error)}\n`,
      );
      process.exitCode = 77;
    }
    closeSync(lockDescriptor);
  }
}

// A record that cannot be written makes every later decision untrustworthy —
// who holds the lock, and whether a child's inherited claim may be honoured.
// Fail here rather than run a suite nobody can account for.
function record(state) {
  try {
    recordLockUser({
      lockPath: LOCK_PATH,
      mode,
      state,
      label,
      command: commandText,
    });
  } catch (error) {
    process.stderr.write(
      `TEST_GATE_REGISTRY_WRITE_FAILED: cannot record pid=${process.pid}` +
        ` as ${state} for ${LOCK_PATH}: ${describeError(error)}\n`,
    );
    process.exit(77);
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function reportOtherParticipants() {
  for (const line of describeLockUsers(LOCK_PATH, {
    excludePid: process.pid,
  })) {
    process.stderr.write(`${line}\n`);
  }
}

// Report and sweep from ONE classified snapshot, so the records that are
// deleted are exactly the records that were printed.
//
// Only an exclusive acquisition sweeps. A shared acquisition succeeding proves
// nothing about surviving descriptors: the matrix downgrades fd 9 and its
// children inherit it, so a dead matrix shell leaves a stale record beside a
// lock that a child still holds. Sweeping there would delete the only name the
// next exclusive refusal could report.
function reportStaleParticipants() {
  const users = readLockUsers(LOCK_PATH).filter(
    (user) => user.pid !== process.pid,
  );
  for (const user of users) {
    if (user.liveness !== 'stale') continue;
    process.stderr.write(`${describeLockUser(user)}\n`);
  }
  if (mode === 'exclusive') sweepStaleLockUsers(LOCK_PATH, users);
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
