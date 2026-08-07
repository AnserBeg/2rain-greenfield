#!/usr/bin/env node
// Records who holds the matrix test lock, so a waiter can name what it waits for.
//
// flock is a kernel file-descriptor lock and the kernel will not name the
// holder. The only process that can record the holder's identity is the holder
// itself, so every participant writes one record beside the lock file when it
// acquires and removes it when it releases.
//
// A record whose process is gone is reported STALE and never blamed. That case
// is the interesting signal rather than the answer: the lock can only still be
// held by a process that inherited the dead holder's descriptor.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const RECORD_VERSION = 1;
const recordFileNamePattern = /^(\d+)\.json$/u;

export function registryDirectory(lockPath) {
  return `${lockPath}.holders`;
}

function recordPath(lockPath, pid) {
  return join(registryDirectory(lockPath), `${pid}.json`);
}

/**
 * Process identity that survives PID reuse. Field 22 of /proc/<pid>/stat is the
 * process start time in clock ticks since boot: a stable identity token, not an
 * elapsed-time measurement, so it carries no wall-clock dependence.
 */
export function readProcessIdentity(pid) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
  const closingParenthesis = stat.lastIndexOf(')');
  if (closingParenthesis < 0) return undefined;
  const fields = stat.slice(closingParenthesis + 2).split(' ');
  const processGroup = fields[2];
  const startTicks = fields[19];
  if (
    processGroup === undefined ||
    startTicks === undefined ||
    !/^\d+$/u.test(processGroup) ||
    !/^\d+$/u.test(startTicks)
  ) {
    return undefined;
  }
  return { processGroup: Number(processGroup), startTicks };
}

export function recordLockUser({
  lockPath,
  mode,
  state,
  label,
  command,
  pid = process.pid,
}) {
  const identity = readProcessIdentity(pid);
  const record = {
    version: RECORD_VERSION,
    pid,
    processGroup: identity?.processGroup ?? null,
    startTicks: identity?.startTicks ?? null,
    mode,
    state,
    label,
    command,
  };
  const destination = recordPath(lockPath, pid);
  const staging = `${destination}.${process.pid}.tmp`;
  mkdirSync(registryDirectory(lockPath), { recursive: true });
  writeFileSync(staging, `${JSON.stringify(record)}\n`);
  // Rename is atomic within a directory, so a concurrent reader never observes
  // a half-written record and mistakes it for a corrupt one.
  renameSync(staging, destination);
}

export function releaseLockUser(lockPath, pid = process.pid) {
  rmSync(recordPath(lockPath, pid), { force: true });
}

export function readLockUsers(lockPath) {
  let entries;
  try {
    entries = readdirSync(registryDirectory(lockPath));
  } catch {
    return [];
  }
  const users = [];
  for (const entry of entries.sort()) {
    const match = recordFileNamePattern.exec(entry);
    if (match === null) continue;
    const recordedPid = Number(match[1]);
    let record;
    try {
      record = JSON.parse(
        readFileSync(join(registryDirectory(lockPath), entry), 'utf8'),
      );
    } catch {
      users.push({ liveness: 'unreadable', pid: recordedPid });
      continue;
    }
    if (
      record === null ||
      typeof record !== 'object' ||
      record.version !== RECORD_VERSION ||
      record.pid !== recordedPid
    ) {
      users.push({ liveness: 'unreadable', pid: recordedPid });
      continue;
    }
    users.push({ ...record, ...classify(record) });
  }
  return users.sort((left, right) => left.pid - right.pid);
}

function classify(record) {
  const identity = readProcessIdentity(record.pid);
  if (identity === undefined) {
    return { liveness: 'stale', staleReason: 'the process is gone' };
  }
  if (record.startTicks !== null && identity.startTicks !== record.startTicks) {
    return {
      liveness: 'stale',
      staleReason: 'the PID was reused by an unrelated process',
    };
  }
  return { liveness: 'live', processGroup: identity.processGroup };
}

export function describeLockUsers(lockPath, { excludePid } = {}) {
  const users = readLockUsers(lockPath).filter(
    (user) => user.pid !== excludePid,
  );
  if (users.length === 0) {
    return [
      `[test-lock] no participant is recorded for ${lockPath}: either the lock` +
        ' is held by a lock-unaware process, or it was released between the' +
        ' attempt and this report',
    ];
  }
  return users.map((user) => describeLockUser(user));
}

function describeLockUser(user) {
  if (user.liveness === 'unreadable') {
    return `[test-lock] UNREADABLE record for pid=${user.pid}; it names nothing`;
  }
  const identity =
    `pid=${user.pid} pgid=${user.processGroup ?? 'unknown'}` +
    ` mode=${user.mode} state=${user.state} label=${user.label}` +
    ` command=${JSON.stringify(user.command)}`;
  if (user.liveness === 'stale') {
    return (
      `[test-lock] STALE record, NOT the current holder (${user.staleReason}):` +
      ` ${identity}. If the lock is still held, a process that inherited its` +
      ' descriptor holds it.'
    );
  }
  return `[test-lock] ${user.state === 'holding' ? 'holder' : 'also queued'}: ${identity}`;
}

/**
 * Removes records whose process is provably gone. Callers report before
 * sweeping, so the evidence is printed before it is deleted.
 */
export function sweepStaleLockUsers(lockPath) {
  let swept = 0;
  for (const user of readLockUsers(lockPath)) {
    if (user.liveness !== 'stale') continue;
    releaseLockUser(lockPath, user.pid);
    swept += 1;
  }
  return swept;
}

/**
 * Process groups of every live participant. A process sharing one of these is
 * queued or running under the lock — coordinated, not lock-unaware.
 */
export function liveLockUserProcessGroups(lockPath) {
  const groups = new Set();
  for (const user of readLockUsers(lockPath)) {
    if (user.liveness !== 'live' || user.processGroup === null) continue;
    groups.add(user.processGroup);
  }
  return [...groups].sort((left, right) => left - right);
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = runCommandLine(process.argv.slice(2));
}

function runCommandLine(argv) {
  const [subcommand, ...rest] = argv;
  const options = parseOptions(rest);
  if (options === undefined || options.lock === undefined) {
    process.stderr.write(
      'Usage: test-lock-registry.mjs <record|release|report|sweep|pgids>' +
        ' --lock <path> [--pid <pid>] [--mode <mode>] [--state <state>]' +
        ' [--label <label>] [--command <command>]\n',
    );
    return 2;
  }
  const pid = options.pid === undefined ? process.pid : Number(options.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    process.stderr.write(`Invalid --pid: ${String(options.pid)}\n`);
    return 2;
  }
  switch (subcommand) {
    case 'record': {
      recordLockUser({
        lockPath: options.lock,
        mode: options.mode ?? 'unknown',
        state: options.state ?? 'holding',
        label: options.label ?? 'unlabelled',
        command: options.command ?? '',
        pid,
      });
      return 0;
    }
    case 'release': {
      releaseLockUser(options.lock, pid);
      return 0;
    }
    case 'report': {
      for (const line of describeLockUsers(options.lock, { excludePid: pid })) {
        process.stderr.write(`${line}\n`);
      }
      return 0;
    }
    case 'sweep': {
      const swept = sweepStaleLockUsers(options.lock);
      if (swept > 0) {
        process.stderr.write(
          `[test-lock] swept ${swept} stale record(s) after reporting them\n`,
        );
      }
      return 0;
    }
    case 'pgids': {
      for (const group of liveLockUserProcessGroups(options.lock)) {
        process.stdout.write(`${group}\n`);
      }
      return 0;
    }
    default: {
      process.stderr.write(`Unknown subcommand: ${String(subcommand)}\n`);
      return 2;
    }
  }
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      return undefined;
    }
    options[flag.slice(2)] = value;
  }
  return options;
}
