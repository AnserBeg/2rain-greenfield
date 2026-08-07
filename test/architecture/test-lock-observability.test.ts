import assert from 'node:assert/strict';
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const lockRunnerPath = 'scripts/run-with-test-lock.mjs';
const registryPath = 'scripts/test-lock-registry.mjs';
const matrixRunnerPath = 'scripts/run-matrix.sh';

/**
 * `test:performance` is exclusive for a reason no import graph can show: it
 * asserts on wall-clock, so it needs a quiet machine rather than a free
 * container slot. Every other exclusive lease must be earned by standing up an
 * ephemeral PostgreSQL container.
 */
const timingSensitiveScripts = new Set(['test:performance']);

const containerCallPattern = /\bwithEphemeralPostgres\s*\(/u;
const importSpecifierPattern =
  /(?:from|import)\s*\(?\s*'([^']+)'|require\s*\(\s*'([^']+)'/gu;
const spawnedSourcePattern = /'((?:apps|test)\/[\w./-]+\.ts)'/gu;
const processSpawnPattern = /\bspawn(?:Sync)?\s*\(/u;
const lockModePattern = /run-with-test-lock\.mjs (shared|exclusive) --/u;

test('a waiting gate names the live holder it is waiting for', async () => {
  const lockPath = uniqueLockPath('named-holder');
  const holder = startHolder(lockPath, 'HOLDER-ALPHA', 'exclusive');
  assert.ok(holder.pid !== undefined);
  try {
    await waitForOutput(holder.stdout, 'LOCK_READY');
    const waiter = runGate(lockPath, 'WAITER-BETA', 'shared');

    assert.equal(waiter.status, 75, waiter.stderr);
    assert.match(waiter.stderr, /TEST_GATE_LOCK_BUSY: shared access/u);
    // The refusal itself must name the holder. A report emitted only before
    // the wait began describes whoever held the lock 300s ago, which is a
    // different and possibly wrong process.
    const refusal = waiter.stderr.slice(
      waiter.stderr.indexOf('TEST_GATE_LOCK_BUSY'),
    );
    assert.match(
      refusal,
      new RegExp(`\\[test-lock\\] holder: pid=${holder.pid}\\b`, 'u'),
      `the refusal did not name the holder:\n${waiter.stderr}`,
    );
    assert.match(refusal, /mode=exclusive state=holding label=HOLDER-ALPHA/u);
    // A live holder must never be described as stale, and the waiter must not
    // report its own record back to itself.
    assert.doesNotMatch(waiter.stderr, /STALE/u);
    assert.doesNotMatch(waiter.stderr, /label=WAITER-BETA/u);
  } finally {
    await stopHolder(holder);
    removeLock(lockPath);
  }
});

test('a killed holder is reported stale and never named as the holder', async () => {
  const lockPath = uniqueLockPath('stale-holder');
  const holder = startHolder(lockPath, 'HOLDER-GHOST', 'exclusive');
  const ghostPid = holder.pid;
  assert.ok(ghostPid !== undefined);
  try {
    await waitForOutput(holder.stdout, 'LOCK_READY');
    holder.kill('SIGKILL');
    await once(holder, 'exit');
    assert.ok(
      existsSync(join(`${lockPath}.holders`, `${ghostPid}.json`)),
      'a killed holder must leave its record behind; that is the signal',
    );

    const successor = runGate(lockPath, 'SUCCESSOR', 'exclusive');
    assert.equal(successor.status, 0, successor.stderr);
    assert.match(
      successor.stderr,
      new RegExp(
        `STALE record, NOT the current holder \\(the process is gone\\):` +
          ` pid=${ghostPid}\\b`,
        'u',
      ),
      `the dead holder was not reported stale:\n${successor.stderr}`,
    );
    assert.doesNotMatch(
      successor.stderr,
      new RegExp(`\\[test-lock\\] holder: pid=${ghostPid}\\b`, 'u'),
      'a dead recorded holder must never be blamed as the current holder',
    );
    assert.equal(
      existsSync(join(`${lockPath}.holders`, `${ghostPid}.json`)),
      false,
      'the stale record must be swept once it has been reported',
    );
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill('SIGKILL');
    }
    removeLock(lockPath);
  }
});

test('a record whose PID was reused is stale, not blamed on the live process', async () => {
  const lockPath = uniqueLockPath('recycled-pid');
  const sentinel = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  assert.ok(sentinel.pid !== undefined);
  try {
    writeFileSync(
      ensureRegistryDirectory(lockPath, sentinel.pid),
      `${JSON.stringify({
        version: 1,
        pid: sentinel.pid,
        processGroup: null,
        // The same PID, a different process: the recorded start time cannot
        // match, which is exactly how PID reuse is caught.
        startTicks: String(Number(readStartTicks(sentinel.pid)) + 1),
        mode: 'exclusive',
        state: 'holding',
        label: 'RECYCLED-PID',
        command: 'a process that no longer exists',
      })}\n`,
    );

    const report = runRegistry(lockPath, ['report']);
    assert.equal(report.status, 0, report.stderr);
    assert.match(
      report.stderr,
      new RegExp(
        `STALE record, NOT the current holder \\(the PID was reused by an` +
          ` unrelated process\\): pid=${sentinel.pid}\\b`,
        'u',
      ),
      `a reused PID was not reported stale:\n${report.stderr}`,
    );
    assert.doesNotMatch(
      report.stderr,
      new RegExp(`\\[test-lock\\] holder: pid=${sentinel.pid}\\b`, 'u'),
    );
  } finally {
    sentinel.kill('SIGKILL');
    await once(sentinel, 'exit');
    removeLock(lockPath);
  }
});

test('a second matrix run refuses by name instead of racing a live one', async () => {
  const lockPath = uniqueLockPath('second-matrix');
  const fakeBin = createFakeBin({ docker: 'exit 0\n' });
  const holder = startHolder(lockPath, 'MATRIX-ALPHA', 'exclusive');
  assert.ok(holder.pid !== undefined);
  try {
    await waitForOutput(holder.stdout, 'LOCK_READY');
    const second = spawnSync(
      'bash',
      [matrixRunnerPath, 'MATRIX-BETA', process.cwd()],
      {
        encoding: 'utf8',
        env: lockEnvironment(lockPath, {
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        }),
      },
    );

    assert.equal(second.status, 75, `${second.stdout}${second.stderr}`);
    assert.match(second.stderr, /TEST_GATE_LOCK_BUSY: exclusive access/u);
    const refusal = second.stderr.slice(
      second.stderr.indexOf('TEST_GATE_LOCK_BUSY'),
    );
    assert.match(
      refusal,
      new RegExp(
        `\\[test-lock\\] holder: pid=${holder.pid}\\b.*label=MATRIX-ALPHA`,
        'u',
      ),
      `the refusal did not name the holder:\n${second.stderr}`,
    );
  } finally {
    await stopHolder(holder);
    rmSync(fakeBin, { force: true, recursive: true });
    removeLock(lockPath);
  }
});

test('the foreign-process wait blames only genuinely uncoordinated processes', async () => {
  const uncoordinatedLock = uniqueLockPath('foreign-uncoordinated');
  const uncoordinated = runMatrixWithFakeProcessTable(
    uncoordinatedLock,
    '9999999',
  );
  removeLock(uncoordinatedLock);
  assert.equal(
    uncoordinated.status,
    75,
    `${uncoordinated.stdout}${uncoordinated.stderr}`,
  );
  assert.match(
    uncoordinated.stderr,
    /TEST_GATE_LOCK_BUSY: a lock-unaware test process remained active/u,
  );
  assert.match(
    uncoordinated.stderr,
    /99999\s+9999999\s+corepack pnpm test:compiler/u,
    `the refusal did not name the process it blamed:\n${uncoordinated.stderr}`,
  );

  const coordinatedLock = uniqueLockPath('foreign-coordinated');
  // Detached so the sentinel leads its own process group; sharing this shell's
  // group would let the matrix's own record vouch for it and the case would
  // pass for the wrong reason.
  const sentinel = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  assert.ok(sentinel.pid !== undefined);
  try {
    const recorded = runRegistry(coordinatedLock, [
      'record',
      '--pid',
      String(sentinel.pid),
      '--mode',
      'shared',
      '--state',
      'waiting',
      '--label',
      'COORDINATED-LANE',
      '--command',
      'corepack pnpm test:compiler',
    ]);
    assert.equal(recorded.status, 0, recorded.stderr);
    const sentinelGroup = readProcessGroup(sentinel.pid);

    const coordinated = runMatrixWithFakeProcessTable(
      coordinatedLock,
      sentinelGroup,
    );
    assert.doesNotMatch(
      coordinated.stderr,
      /TEST_GATE_LOCK_BUSY: a lock-unaware test process remained active/u,
      `a queued lane was blamed as foreign:\n${coordinated.stderr}`,
    );
    assert.match(
      coordinated.stdout,
      /FOREIGN-CONTROL starting\. Log:/u,
      `the matrix never reached its start marker:\n${coordinated.stdout}${coordinated.stderr}`,
    );
  } finally {
    sentinel.kill('SIGKILL');
    await once(sentinel, 'exit');
    removeLock(coordinatedLock);
  }
});

test('every container-bearing entry point takes the exclusive lease', () => {
  const scripts = governedScripts();
  const bearing: string[] = [];
  const notBearing: string[] = [];

  for (const [script, command] of scripts) {
    const mode = lockModePattern.exec(command)?.[1];
    if (standsUpContainers(command)) {
      bearing.push(script);
      assert.equal(
        mode,
        'exclusive',
        `${script} stands up ephemeral PostgreSQL containers but takes ` +
          `${String(mode)} access; two container-bearing runs then starve ` +
          "each other's readiness deadline",
      );
      continue;
    }
    notBearing.push(script);
    if (!script.startsWith('test:')) continue;
    assert.equal(
      mode,
      timingSensitiveScripts.has(script) ? 'exclusive' : 'shared',
      `${script} takes ${String(mode)} access without needing it`,
    );
  }

  // Neither list may be empty: a derivation that reaches nothing would satisfy
  // every assertion above by reading zero input.
  assert.ok(bearing.length > 0, 'no container-bearing entry point was found');
  assert.ok(
    notBearing.length > 0,
    'every entry point looked container-bearing',
  );
});

test('the matrix downgrades only after its last container-bearing suite', () => {
  const runner = readFileSync(matrixRunnerPath, 'utf8');
  const downgradeAt = runner.indexOf('bash scripts/downgrade-test-lock.sh');
  assert.ok(downgradeAt > 0, 'the matrix no longer downgrades at all');

  const bearing = governedScripts()
    .filter(([, command]) => standsUpContainers(command))
    .map(([script]) => script);
  assert.ok(bearing.length > 0);
  for (const script of bearing) {
    const invokedAt = runner.indexOf(`corepack pnpm ${script}`);
    assert.notEqual(invokedAt, -1, `the matrix never runs ${script}`);
    assert.ok(
      invokedAt < downgradeAt,
      `${script} stands up containers but runs after the shared downgrade`,
    );
  }

  // The downgrade must still buy something, or it has been deleted in effect.
  const tail = runner.slice(downgradeAt);
  assert.match(tail, /corepack pnpm check:reachability/u);
  assert.match(tail, /run-security-scans\.sh/u);
});

function governedScripts(): readonly (readonly [string, string])[] {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return Object.entries(manifest.scripts ?? {}).filter(
    ([script]) =>
      script !== 'test' &&
      (script.startsWith('test:') || script.startsWith('check:')),
  );
}

/**
 * Static reachability of a `withEphemeralPostgres(...)` call from the files a
 * script executes. It is a proxy for "this command starts a container": it
 * observes a call site rather than a running container, so a suite that reached
 * the helper only through a dynamic path would be missed.
 */
function standsUpContainers(command: string): boolean {
  const pending = entryFiles(command);
  const seen = new Set<string>(pending);
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined) continue;
    const source = readFileSync(file, 'utf8');
    if (containerCallPattern.test(source)) return true;
    for (const next of referencedSourceFiles(file, source)) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }
  return false;
}

function entryFiles(command: string): string[] {
  const files = new Set<string>();
  addSourceTokens(files, command, '.');
  if (command.includes('playwright test')) {
    // Playwright takes its files from the config's testDir, never from argv.
    for (const path of globSync('apps/web/test/browser/**/*.spec.ts')) {
      files.add(resolve(path));
    }
  }
  const delegated = /--filter @north-star\/web ([\w:-]+)/u.exec(command);
  if (delegated?.[1] !== undefined) {
    const webManifest = JSON.parse(
      readFileSync('apps/web/package.json', 'utf8'),
    ) as { scripts?: Record<string, string> };
    const delegatedCommand = webManifest.scripts?.[delegated[1]] ?? '';
    addSourceTokens(files, delegatedCommand, 'apps/web');
  }
  return [...files];
}

function addSourceTokens(
  files: Set<string>,
  command: string,
  base: string,
): void {
  for (const rawToken of command.split(/\s+/u)) {
    const token = rawToken.replaceAll('"', '').replaceAll("'", '');
    if (token.startsWith('--') || !/\.(?:ts|mts)$/u.test(token)) continue;
    const candidate = join(base, token);
    for (const path of token.includes('*')
      ? globSync(candidate)
      : [candidate]) {
      if (isReadableFile(path)) files.add(resolve(path));
    }
  }
}

function referencedSourceFiles(file: string, source: string): string[] {
  const referenced: string[] = [];
  for (const match of source.matchAll(importSpecifierPattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier === undefined || !specifier.startsWith('.')) continue;
    const resolved = resolveSourceFile(dirname(file), specifier);
    if (resolved !== undefined) referenced.push(resolved);
  }
  // Browser specs reach their PostgreSQL harnesses by spawning a repository
  // path, not by importing it. Only a file that actually spawns a process can
  // execute one: elsewhere a repository path is data, and following it would
  // make every file that merely names a suite look container-bearing.
  if (processSpawnPattern.test(source)) {
    for (const match of source.matchAll(spawnedSourcePattern)) {
      const path = match[1];
      if (path !== undefined && isReadableFile(path))
        referenced.push(resolve(path));
    }
  }
  return referenced;
}

function resolveSourceFile(
  directory: string,
  specifier: string,
): string | undefined {
  const base = resolve(directory, specifier);
  const candidates = base.endsWith('.js')
    ? [base.replace(/\.js$/u, '.ts'), base]
    : base.endsWith('.mjs')
      ? [base.replace(/\.mjs$/u, '.mts'), base]
      : [`${base}.ts`, base];
  return candidates.find((candidate) => isReadableFile(candidate));
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function uniqueLockPath(name: string): string {
  return `/tmp/north-star-lock-obs-${name}-${process.pid}`;
}

function removeLock(lockPath: string): void {
  rmSync(lockPath, { force: true });
  rmSync(`${lockPath}.holders`, { force: true, recursive: true });
}

function ensureRegistryDirectory(lockPath: string, pid: number): string {
  const directory = `${lockPath}.holders`;
  mkdirSync(directory, { recursive: true });
  return join(directory, `${pid}.json`);
}

function lockEnvironment(
  lockPath: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.NORTH_STAR_TEST_LOCK_HELD;
  delete environment.NORTH_STAR_TEST_LOCK_LABEL;
  return {
    ...environment,
    NORTH_STAR_TEST_LOCK_PATH: lockPath,
    NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS: '0',
    ...extra,
  };
}

function startHolder(
  lockPath: string,
  label: string,
  mode: 'exclusive' | 'shared',
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      lockRunnerPath,
      mode,
      '--',
      process.execPath,
      '-e',
      "process.stdout.write('LOCK_READY\\n'); process.stdin.resume()",
    ],
    {
      env: lockEnvironment(lockPath, { NORTH_STAR_TEST_LOCK_LABEL: label }),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

async function stopHolder(holder: ChildProcessWithoutNullStreams) {
  if (holder.exitCode !== null || holder.signalCode !== null) return;
  holder.stdin.end();
  await once(holder, 'exit');
}

function runGate(
  lockPath: string,
  label: string,
  mode: 'exclusive' | 'shared',
) {
  return spawnSync(
    process.execPath,
    [
      lockRunnerPath,
      mode,
      '--',
      process.execPath,
      '-e',
      "process.stdout.write('GATE_RAN')",
    ],
    {
      encoding: 'utf8',
      env: lockEnvironment(lockPath, { NORTH_STAR_TEST_LOCK_LABEL: label }),
    },
  );
}

function runRegistry(lockPath: string, argv: readonly string[]) {
  return spawnSync(
    process.execPath,
    [registryPath, ...argv, '--lock', lockPath],
    { encoding: 'utf8', env: process.env },
  );
}

function runMatrixWithFakeProcessTable(lockPath: string, processGroup: string) {
  const fakeBin = createFakeBin({
    docker: 'exit 0\n',
    ps: `printf '99999 ${processGroup} corepack pnpm test:compiler\\n'\n`,
  });
  try {
    return spawnSync(
      'bash',
      [matrixRunnerPath, 'FOREIGN-CONTROL', process.cwd(), 'exit 7'],
      {
        encoding: 'utf8',
        env: lockEnvironment(lockPath, {
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        }),
      },
    );
  } finally {
    rmSync(fakeBin, { force: true, recursive: true });
  }
}

function createFakeBin(programs: Readonly<Record<string, string>>): string {
  const directory = mkdtempSync(join(tmpdir(), 'north-star-fake-bin-'));
  for (const [name, body] of Object.entries(programs)) {
    const path = join(directory, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}`);
    chmodSync(path, 0o755);
  }
  return directory;
}

function readProcessStatFields(pid: number): readonly string[] {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const closingParenthesis = stat.lastIndexOf(')');
  assert.ok(closingParenthesis > 0, `unreadable /proc/${pid}/stat`);
  return stat.slice(closingParenthesis + 2).split(' ');
}

function readProcessGroup(pid: number): string {
  const value = readProcessStatFields(pid)[2];
  assert.ok(value !== undefined && /^\d+$/u.test(value));
  return value;
}

function readStartTicks(pid: number): string {
  const value = readProcessStatFields(pid)[19];
  assert.ok(value !== undefined && /^\d+$/u.test(value));
  return value;
}

function waitForOutput(
  stream: NodeJS.ReadableStream,
  expected: string,
  timeoutMilliseconds = 15_000,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    stream.setEncoding('utf8');
    const deadline = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `stream did not emit ${expected} within ${timeoutMilliseconds}ms`,
        ),
      );
    }, timeoutMilliseconds);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`stream ended before emitting ${expected}: ${output}`));
    };
    const onData = (chunk: string) => {
      output += chunk;
      if (!output.includes(expected)) return;
      cleanup();
      resolvePromise();
    };
    function cleanup(): void {
      clearTimeout(deadline);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    }
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}
