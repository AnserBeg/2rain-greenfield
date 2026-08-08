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
//
// The registry is also the only way an inherited lease claim can be checked. No
// asking process can verify a descriptor it does not own — that is this
// packet's founding observation — so a claim is honoured only when the registry
// still says the named holder is live and holding a mode that covers the
// request.

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
const claimPattern = /^(shared|exclusive):(\d+):(\d+):(.+)$/u;
// Z is reaped-pending, X and x are fully dead but still enumerable. All three
// mean every descriptor the process held is already closed.
const terminalProcessStates = new Set(['Z', 'X', 'x']);

export function registryDirectory(lockPath) {
  return `${lockPath}.holders`;
}

function recordPath(lockPath, pid) {
  return join(registryDirectory(lockPath), `${pid}.json`);
}

/**
 * Process identity that survives PID reuse. Field 22 of /proc/<pid>/stat is the
 * process start time in clock ticks since boot: a stable identity token, not an
 * elapsed-time measurement, so it carries no wall-clock dependence. Field 3 is
 * the run state, which is what separates a live holder from an exited one whose
 * /proc entry has not been reaped away yet.
 */
export function readProcessIdentity(pid) {
  const fields = readProcessStatFields(pid);
  if (fields === undefined) return undefined;
  const state = fields[0];
  const parent = fields[1];
  const processGroup = fields[2];
  const startTicks = fields[19];
  if (
    state === undefined ||
    parent === undefined ||
    processGroup === undefined ||
    startTicks === undefined ||
    !/^[A-Za-z]$/u.test(state) ||
    !/^\d+$/u.test(parent) ||
    !/^\d+$/u.test(processGroup) ||
    !/^\d+$/u.test(startTicks)
  ) {
    return undefined;
  }
  return {
    parent: Number(parent),
    processGroup: Number(processGroup),
    startTicks,
    state,
  };
}

function readProcessStatFields(pid) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
  const closingParenthesis = stat.lastIndexOf(')');
  if (closingParenthesis < 0) return undefined;
  return stat.slice(closingParenthesis + 2).split(' ');
}

/**
 * Writes one record, or throws. Callers must fail rather than continue: a lease
 * whose mode cannot be written is a lease nobody can validate.
 */
export function recordLockUser({
  lockPath,
  mode,
  state,
  label,
  command,
  pid = process.pid,
}) {
  const identity = readProcessIdentity(pid);
  // An unreadable identity is persisted as null and classified UNIDENTIFIED,
  // never live. A record that cannot prove which process it names must not be
  // able to vouch for one.
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
  if (record.startTicks === null) {
    return {
      liveness: 'unidentified',
      unidentifiedReason: 'its process identity was unreadable when recorded',
    };
  }
  const identity = readProcessIdentity(record.pid);
  if (identity === undefined) {
    return { liveness: 'stale', staleReason: 'the process is gone' };
  }
  if (identity.startTicks !== record.startTicks) {
    return {
      liveness: 'stale',
      staleReason: 'the PID was reused by an unrelated process',
    };
  }
  if (terminalProcessStates.has(identity.state)) {
    return {
      liveness: 'stale',
      staleReason: `the process has exited but not been reaped (state ${identity.state})`,
    };
  }
  return { liveness: 'live', processGroup: identity.processGroup };
}

export function describeLockUsers(lockPath, { excludePid } = {}) {
  return describeLockUserList(
    readLockUsers(lockPath).filter((user) => user.pid !== excludePid),
    lockPath,
  );
}

export function describeLockUserList(users, lockPath) {
  if (users.length === 0) {
    return [
      `[test-lock] no participant is recorded for ${lockPath}: either the lock` +
        ' is held by a lock-unaware process, or it was released between the' +
        ' attempt and this report',
    ];
  }
  return users.map((user) => describeLockUser(user));
}

export function describeLockUser(user) {
  if (user.liveness === 'unreadable') {
    return `[test-lock] UNREADABLE record for pid=${user.pid}; it names nothing`;
  }
  const identity =
    `pid=${user.pid} pgid=${user.processGroup ?? 'unknown'}` +
    ` mode=${user.mode} state=${user.state} label=${user.label}` +
    ` command=${JSON.stringify(user.command)}`;
  if (user.liveness === 'unidentified') {
    return (
      `[test-lock] UNIDENTIFIED record (${user.unidentifiedReason}):` +
      ` ${identity}. It may or may not still hold the lock, so it neither` +
      ' names a holder nor vouches for any process.'
    );
  }
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
 * Removes the stale records in an already-classified snapshot. Callers report
 * before sweeping, so the evidence is printed before it is deleted, and pass
 * the same list they reported so the two never disagree.
 *
 * ONLY AN EXCLUSIVE ACQUISITION MAY SWEEP. A successful shared acquisition is
 * compatible with a surviving shared descriptor inherited from a dead holder,
 * so there a stale record can be the only remaining name for a lock that is
 * still held. Deleting it rebuilds the defect this registry exists to remove.
 */
export function sweepStaleLockUsers(lockPath, users) {
  let swept = 0;
  for (const user of users) {
    if (user.liveness !== 'stale') continue;
    releaseLockUser(lockPath, user.pid);
    swept += 1;
  }
  return swept;
}

/**
 * The lease claim a holder passes to its children. It names the lock path, the
 * holder, and the holder's start ticks, so a child can ask the registry whether
 * the claim is still true instead of trusting the environment variable.
 */
export function mintLockClaim(lockPath, mode, pid = process.pid) {
  const identity = readProcessIdentity(pid);
  if (identity === undefined) {
    throw new Error(`cannot read process identity for PID ${pid}`);
  }
  return `${mode}:${pid}:${identity.startTicks}:${lockPath}`;
}

export function lockModeCovers(recordedMode, requestedMode) {
  return recordedMode === 'exclusive' || recordedMode === requestedMode;
}

/**
 * Validates an inherited claim against the registry. All four facts must
 * resolve — path, holder PID, holder start ticks, and the holder's CURRENTLY
 * recorded mode — and the recorded mode must cover the request. A claim minted
 * for one lock cannot authorize another, and a descendant carrying an exclusive
 * claim is refused once the holder's record has been rewritten to shared.
 */
export function validateLockClaim(claim, lockPath, requestedMode) {
  const match = claimPattern.exec(claim);
  if (match === null) {
    return { honoured: false, reason: 'the inherited claim is unparseable' };
  }
  const [, claimedMode, claimedPid, claimedTicks, claimedPath] = match;
  if (claimedPath !== lockPath) {
    return {
      honoured: false,
      reason: `the inherited claim names ${claimedPath}, not ${lockPath}`,
    };
  }
  const holder = readLockUsers(lockPath).find(
    (user) => user.pid === Number(claimedPid),
  );
  if (holder === undefined) {
    return {
      honoured: false,
      reason: `no record remains for the claimed holder pid=${claimedPid}`,
    };
  }
  if (holder.liveness !== 'live') {
    return {
      honoured: false,
      reason: `the claimed holder pid=${claimedPid} is ${holder.liveness}`,
    };
  }
  if (holder.startTicks !== claimedTicks) {
    return {
      honoured: false,
      reason: `pid=${claimedPid} is a different process than the one claimed`,
    };
  }
  if (holder.state !== 'holding') {
    return {
      honoured: false,
      reason: `the claimed holder pid=${claimedPid} is ${holder.state}, not holding`,
    };
  }
  if (!lockModeCovers(holder.mode, requestedMode)) {
    return {
      honoured: false,
      reason:
        `the claim asserts ${claimedMode} but pid=${claimedPid} now records` +
        ` ${holder.mode}, which does not cover ${requestedMode}`,
    };
  }
  return { honoured: true, mode: holder.mode };
}

/**
 * PIDs that belong to a recorded participant's process lineage: the
 * participant, its ancestors, and its descendants. A same-process-group sibling
 * is NOT included — a shared group only means "launched from the same shell",
 * which is not evidence of participation, and exempting on it lets an unrelated
 * process inherit a participant's exemption.
 */
export function coordinatedProcesses(lockPath) {
  const participants = readLockUsers(lockPath)
    .filter((user) => user.liveness === 'live')
    .map((user) => user.pid);
  if (participants.length === 0) return [];

  const parents = readProcessParents();
  const children = new Map();
  for (const [pid, parent] of parents) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }

  const coordinated = new Set();
  for (const participant of participants) {
    for (
      let current = participant;
      current !== undefined && current > 0 && !coordinated.has(current);
      current = parents.get(current)
    ) {
      coordinated.add(current);
    }
    const pending = [participant];
    while (pending.length > 0) {
      const next = pending.pop();
      for (const child of children.get(next) ?? []) {
        if (coordinated.has(child)) continue;
        coordinated.add(child);
        pending.push(child);
      }
    }
  }
  return [...coordinated].sort((left, right) => left - right);
}

function readProcessParents() {
  const parents = new Map();
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return parents;
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const fields = readProcessStatFields(entry);
    const parent = fields?.[1];
    if (parent === undefined || !/^\d+$/u.test(parent)) continue;
    parents.set(Number(entry), Number(parent));
  }
  return parents;
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = runCommandLine(process.argv.slice(2));
}

function runCommandLine(argv) {
  const [subcommand, ...rest] = argv;
  const options = parseOptions(rest);
  if (options === undefined || options.lock === undefined) {
    process.stderr.write(
      'Usage: test-lock-registry.mjs' +
        ' <record|release|report|claim|coordinated-pids>' +
        ' --lock <path> [--pid <pid>] [--mode <mode>] [--state <state>]' +
        ' [--label <label>] [--command <command>] [--sweep <mode>]\n',
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
      // A record that cannot be written must stop the caller. Every downstream
      // decision — who holds the lock, whether an inherited claim is honoured —
      // reads what this writes.
      try {
        recordLockUser({
          lockPath: options.lock,
          mode: options.mode ?? 'unknown',
          state: options.state ?? 'holding',
          label: options.label ?? 'unlabelled',
          command: options.command ?? '',
          pid,
        });
      } catch (error) {
        process.stderr.write(
          `TEST_GATE_REGISTRY_WRITE_FAILED: cannot record pid=${pid} for` +
            ` ${options.lock}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 77;
      }
      return 0;
    }
    case 'release': {
      try {
        releaseLockUser(options.lock, pid);
      } catch (error) {
        process.stderr.write(
          `TEST_GATE_REGISTRY_WRITE_FAILED: cannot release pid=${pid} for` +
            ` ${options.lock}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 77;
      }
      return 0;
    }
    case 'claim': {
      if (options.mode !== 'shared' && options.mode !== 'exclusive') {
        process.stderr.write(`Invalid --mode: ${String(options.mode)}\n`);
        return 2;
      }
      try {
        process.stdout.write(
          `${mintLockClaim(options.lock, options.mode, pid)}\n`,
        );
      } catch (error) {
        process.stderr.write(
          `TEST_GATE_REGISTRY_WRITE_FAILED: cannot mint a lease claim for` +
            ` pid=${pid}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 77;
      }
      return 0;
    }
    case 'report': {
      const users = readLockUsers(options.lock).filter(
        (user) => user.pid !== pid,
      );
      for (const line of describeLockUserList(users, options.lock)) {
        process.stderr.write(`${line}\n`);
      }
      if (options.sweep === 'exclusive') {
        const swept = sweepStaleLockUsers(options.lock, users);
        if (swept > 0) {
          process.stderr.write(
            `[test-lock] swept ${swept} stale record(s) after reporting them\n`,
          );
        }
      }
      return 0;
    }
    case 'coordinated-pids': {
      for (const coordinated of coordinatedProcesses(options.lock)) {
        process.stdout.write(`${coordinated}\n`);
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
