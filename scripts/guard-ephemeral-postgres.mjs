#!/usr/bin/env node
import { execFile } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let staleSeconds = 0;

try {
  const mode = process.argv[2];
  staleSeconds = readNonnegativeInteger(
    'NORTH_STAR_CONTAINER_STALE_SECONDS',
    3_600,
  );
  const postLockGraceAttempts = readNonnegativeInteger(
    'NORTH_STAR_CONTAINER_POST_LOCK_GRACE_ATTEMPTS',
    20,
  );
  if (mode !== 'pre-lock' && mode !== 'post-lock') {
    throw new Error('usage: guard-ephemeral-postgres.mjs <pre-lock|post-lock>');
  }
  let containers = await listContainers();
  containers = await sweepStale(containers);

  if (mode === 'pre-lock') {
    for (const container of containers) {
      process.stdout.write(
        `postgres-container-guard: left recent ${container.name} age_seconds=${container.ageSeconds} for its owning lane\n`,
      );
    }
  } else {
    for (
      let attempt = 0;
      containers.length > 0 && attempt < postLockGraceAttempts;
      attempt += 1
    ) {
      await delay(100);
      containers = await listContainers();
      containers = await sweepStale(containers);
    }
    if (containers.length > 0) {
      process.stderr.write(
        'POSTGRES_CONTAINER_CONTAMINATION: refusing to start with north-star-* containers present after exclusive lock acquisition.\n',
      );
      for (const container of containers) {
        process.stderr.write(
          `  ${container.name} age_seconds=${container.ageSeconds}\n  docker rm --force ${container.name}\n`,
        );
      }
      process.exitCode = 76;
    }
  }
} catch (error) {
  process.stderr.write(
    `POSTGRES_CONTAINER_GUARD_FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 74;
}

async function sweepStale(containers) {
  const recent = [];
  for (const container of containers) {
    if (container.ageSeconds < staleSeconds) {
      recent.push(container);
      continue;
    }
    try {
      await docker(['rm', '--force', container.id]);
    } catch (error) {
      if (!isMissingContainer(error, container.id)) throw error;
    }
    if (await containerExists(container.id)) {
      throw new Error(
        `stale container survived docker rm --force: ${container.name}`,
      );
    }
    process.stdout.write(
      `postgres-container-guard: swept stale ${container.name} age_seconds=${container.ageSeconds}\n`,
    );
  }
  return recent;
}

async function listContainers() {
  const { stdout } = await docker([
    'ps',
    '--all',
    '--filter',
    'name=^/north-star-',
    '--format',
    '{{json .ID}}\t{{json .Names}}',
  ]);
  if (stdout.trim() === '') return [];

  const containers = [];
  for (const line of stdout.trimEnd().split('\n')) {
    const fields = line.split('\t');
    if (fields.length !== 2) {
      throw new Error(`unrecognized docker ps row: ${JSON.stringify(line)}`);
    }
    const id = parseJsonString(fields[0], 'container ID');
    const name = parseJsonString(fields[1], 'container name');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(id)) {
      throw new Error(
        `unrecognized Docker container ID: ${JSON.stringify(id)}`,
      );
    }
    if (!/^north-star-[a-zA-Z0-9_.-]+$/u.test(name)) {
      throw new Error(
        `unrecognized north-star container name: ${JSON.stringify(name)}`,
      );
    }
    let createdOutput;
    try {
      ({ stdout: createdOutput } = await docker([
        'inspect',
        '--format',
        '{{json .Created}}',
        id,
      ]));
    } catch (error) {
      if (isMissingContainer(error, id)) continue;
      throw error;
    }
    const created = parseJsonString(createdOutput.trim(), 'creation time');
    const createdMilliseconds = Date.parse(created);
    if (!Number.isFinite(createdMilliseconds)) {
      throw new Error(
        `unrecognized Docker creation time for ${name}: ${JSON.stringify(created)}`,
      );
    }
    containers.push({
      ageSeconds: Math.max(
        0,
        Math.floor((Date.now() - createdMilliseconds) / 1_000),
      ),
      id,
      name,
    });
  }
  return containers;
}

async function containerExists(id) {
  try {
    await docker(['inspect', id]);
    return true;
  } catch (error) {
    if (isMissingContainer(error, id)) return false;
    throw error;
  }
}

async function docker(arguments_) {
  try {
    return await execFileAsync('docker', arguments_, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`docker ${arguments_[0] ?? ''} failed`, { cause: error });
  }
}

function isMissingContainer(error, id) {
  const cause = error instanceof Error ? error.cause : undefined;
  const stderr = cause?.stderr;
  return (
    typeof stderr === 'string' &&
    (stderr.toLowerCase().includes(`no such container: ${id}`) ||
      stderr.toLowerCase().includes(`no such object: ${id}`))
  );
}

function parseJsonString(value, field) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`unrecognized Docker ${field}: ${JSON.stringify(value)}`);
  }
  if (typeof parsed !== 'string' || parsed === '') {
    throw new Error(`unrecognized Docker ${field}: ${JSON.stringify(value)}`);
  }
  return parsed;
}

function readNonnegativeInteger(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return Number(raw);
}
