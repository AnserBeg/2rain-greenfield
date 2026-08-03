import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const [
  containerName,
  ownerPidText,
  ownerStartTicks,
  parentPidText,
  parentStartTicks,
] = process.argv.slice(2);

if (
  !containerName?.startsWith('north-star-') ||
  !/^\d+$/u.test(ownerPidText ?? '') ||
  !/^\d+$/u.test(ownerStartTicks ?? '') ||
  !/^\d+$/u.test(parentPidText ?? '') ||
  !/^\d+$/u.test(parentStartTicks ?? '')
) {
  throw new Error('invalid ephemeral PostgreSQL guardian arguments');
}

const ownerPid = Number(ownerPidText);
const parentPid = Number(parentPidText);
let forceCleanup = false;
process.once('SIGUSR1', () => {
  forceCleanup = true;
});
if (process.send) {
  await new Promise((resolve) => {
    process.send({ status: 'ready' }, () => {
      if (process.connected) process.disconnect();
      resolve();
    });
  });
}

let observedContainer = false;
let absentAfterOwnerDeath = 0;
const maximumAbsentChecksAfterOwnerDeath = 1_200;

for (;;) {
  const ownerAlive = await processIdentityMatches(ownerPid, ownerStartTicks);
  const parentAlive = await processIdentityMatches(parentPid, parentStartTicks);
  const containerState = await inspectContainer(containerName);
  const cleanupRequired = forceCleanup || !ownerAlive || !parentAlive;

  if (containerState === 'present') {
    observedContainer = true;
    absentAfterOwnerDeath = 0;
    if (cleanupRequired && (await removeContainer(containerName))) break;
  } else if (containerState === 'absent') {
    if (observedContainer || forceCleanup) break;
    if (!ownerAlive || !parentAlive) {
      absentAfterOwnerDeath += 1;
      if (absentAfterOwnerDeath >= maximumAbsentChecksAfterOwnerDeath) break;
    }
  }

  await delay(250);
}

async function processIdentityMatches(pid, expectedStartTicks) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const closingParenthesis = stat.lastIndexOf(')');
    if (closingParenthesis < 0) return false;
    const fieldsAfterCommand = stat.slice(closingParenthesis + 2).split(' ');
    return fieldsAfterCommand[19] === expectedStartTicks;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return false;
  }
}

async function inspectContainer(name) {
  try {
    await execFileAsync('docker', ['inspect', name], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    return 'present';
  } catch (error) {
    if (missingContainer(error, name)) return 'absent';
    return 'unknown';
  }
}

async function removeContainer(name) {
  try {
    await execFileAsync('docker', ['rm', '--force', name], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    if (!missingContainer(error, name)) return false;
  }
  return (await inspectContainer(name)) === 'absent';
}

function missingContainer(error, name) {
  const stderr = error?.stderr;
  return (
    typeof stderr === 'string' &&
    (stderr.toLowerCase().includes(`no such container: ${name}`) ||
      stderr.toLowerCase().includes(`no such object: ${name}`))
  );
}
