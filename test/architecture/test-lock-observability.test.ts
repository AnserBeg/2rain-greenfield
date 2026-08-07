import assert from 'node:assert/strict';
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  cpSync,
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
import { setTimeout as delay } from 'node:timers/promises';
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

// Above any plausible /proc/sys/kernel/pid_max, so it can never collide with a
// live process and be exempted for the wrong reason.
const impossiblePid = '9999999';

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
      existsSync(recordFile(lockPath, ghostPid)),
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
      existsSync(recordFile(lockPath, ghostPid)),
      false,
      'an exclusive acquisition must sweep the stale record it reported',
    );
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill('SIGKILL');
    }
    removeLock(lockPath);
  }
});

test('a shared gate preserves the stale record of a still-held descriptor', async () => {
  // The nominated execution: kill a downgraded matrix shell while a child
  // retains fd 9, admit a shared gate, then prove a later exclusive refusal
  // still reports the stale matrix record. A shared acquisition succeeding
  // proves nothing about surviving descriptors, so it must not sweep.
  const lockPath = uniqueLockPath('downgraded-matrix');
  const sandbox = createMatrixSandbox();
  const survivorPidPath = join(sandbox, 'survivor.pid');
  const matrix = startMatrixRun(
    sandbox,
    lockPath,
    'MATRIX-DOWNGRADED',
    [
      `node scripts/test-lock-registry.mjs record --lock ${lockPath}`,
      '--pid $PPID --mode shared --state holding --label MATRIX-DOWNGRADED',
      '--command matrix-tail',
      `&& bash scripts/downgrade-test-lock.sh ${lockPath} 5 9`,
      `&& sh -c 'echo $$ > ${survivorPidPath}; exec sleep 300'`,
    ].join(' '),
  );
  const matrixPid = matrix.child.pid;
  assert.ok(matrixPid !== undefined);
  let survivorPid: number | undefined;

  try {
    await waitForFile(survivorPidPath, matrix.child);
    survivorPid = Number(readFileSync(survivorPidPath, 'utf8').trim());
    assert.ok(Number.isSafeInteger(survivorPid) && survivorPid > 0);

    // The shell dies; the descriptor it downgraded does not.
    matrix.child.kill('SIGKILL');
    await once(matrix.child, 'exit');
    assert.ok(
      existsSync(recordFile(lockPath, matrixPid)),
      'the killed matrix shell must leave its record behind',
    );

    const shared = runGate(lockPath, 'SHARED-TAIL', 'shared');
    assert.equal(
      shared.status,
      0,
      `a shared gate must still be admitted beside the surviving shared` +
        ` descriptor:\n${shared.stderr}`,
    );
    assert.match(
      shared.stderr,
      new RegExp(
        `STALE record, NOT the current holder .*pid=${matrixPid}\\b`,
        'u',
      ),
      `the shared gate did not report the stale matrix record:\n${shared.stderr}`,
    );
    assert.ok(
      existsSync(recordFile(lockPath, matrixPid)),
      'a shared gate must NOT sweep: the lock is still held by the descriptor' +
        ' the dead shell passed to its child, and this record is its only name',
    );

    const exclusive = runGate(lockPath, 'NEXT-MATRIX', 'exclusive');
    assert.equal(exclusive.status, 75, exclusive.stderr);
    const refusal = exclusive.stderr.slice(
      exclusive.stderr.indexOf('TEST_GATE_LOCK_BUSY'),
    );
    assert.match(
      refusal,
      new RegExp(
        `STALE record, NOT the current holder .*pid=${matrixPid}\\b` +
          `.*label=MATRIX-DOWNGRADED`,
        'u',
      ),
      `the exclusive refusal could not name what held the lock:\n${exclusive.stderr}`,
    );
  } finally {
    if (survivorPid !== undefined) killQuietly(survivorPid);
    if (matrix.child.exitCode === null && matrix.child.signalCode === null) {
      matrix.child.kill('SIGKILL');
    }
    matrix.cleanup();
    removeLock(lockPath);
  }
});

test('the recorder persists a real start tick, and a reused PID is not blamed', async () => {
  const lockPath = uniqueLockPath('recycled-pid');
  const sentinel = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  assert.ok(sentinel.pid !== undefined);
  try {
    // Drive the production recorder, not a hand-written fixture: if it stopped
    // persisting a real start tick there would be nothing to compare against.
    const recorded = runRegistry(lockPath, [
      'record',
      '--pid',
      String(sentinel.pid),
      '--mode',
      'exclusive',
      '--state',
      'holding',
      '--label',
      'RECORDED-BY-PRODUCTION',
      '--command',
      'a process that is still running',
    ]);
    assert.equal(recorded.status, 0, recorded.stderr);
    const record = JSON.parse(
      readFileSync(recordFile(lockPath, sentinel.pid), 'utf8'),
    ) as { processGroup: number | null; startTicks: string | null };
    assert.equal(
      record.startTicks,
      readStartTicks(sentinel.pid),
      'the recorder must persist the process start tick it read from /proc',
    );
    assert.equal(record.processGroup, Number(readProcessGroup(sentinel.pid)));

    const live = runRegistry(lockPath, ['report']);
    assert.match(
      live.stderr,
      new RegExp(`\\[test-lock\\] holder: pid=${sentinel.pid}\\b`, 'u'),
      `a live recorded holder must be named:\n${live.stderr}`,
    );

    // Advance only the start tick the recorder wrote. The PID stays live, so
    // this is the reuse case: same number, different process.
    writeFileSync(
      recordFile(lockPath, sentinel.pid),
      JSON.stringify({
        ...(JSON.parse(
          readFileSync(recordFile(lockPath, sentinel.pid), 'utf8'),
        ) as Record<string, unknown>),
        startTicks: String(Number(record.startTicks) + 1),
      }),
    );

    const reused = runRegistry(lockPath, ['report']);
    assert.equal(reused.status, 0, reused.stderr);
    assert.match(
      reused.stderr,
      new RegExp(
        `STALE record, NOT the current holder \\(the PID was reused by an` +
          ` unrelated process\\): pid=${sentinel.pid}\\b`,
        'u',
      ),
      `a reused PID was not reported stale:\n${reused.stderr}`,
    );
    assert.doesNotMatch(
      reused.stderr,
      new RegExp(`\\[test-lock\\] holder: pid=${sentinel.pid}\\b`, 'u'),
    );
  } finally {
    sentinel.kill('SIGKILL');
    await once(sentinel, 'exit');
    removeLock(lockPath);
  }
});

test('a record with no recorded identity is never live and vouches for nobody', async () => {
  // The recorder can no longer write this shape, so it is written by hand on
  // purpose: it is the degraded record a failed /proc read used to produce, and
  // the reader must refuse to treat it as a live participant.
  const lockPath = uniqueLockPath('unidentified');
  const sentinel = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  assert.ok(sentinel.pid !== undefined);
  try {
    mkdirSync(`${lockPath}.holders`, { recursive: true });
    writeFileSync(
      recordFile(lockPath, sentinel.pid),
      `${JSON.stringify({
        version: 1,
        pid: sentinel.pid,
        processGroup: null,
        startTicks: null,
        mode: 'exclusive',
        state: 'holding',
        label: 'NO-IDENTITY',
        command: 'a process of unknown identity',
      })}\n`,
    );

    const report = runRegistry(lockPath, ['report']);
    assert.equal(report.status, 0, report.stderr);
    assert.match(
      report.stderr,
      new RegExp(`UNIDENTIFIED record .*pid=${sentinel.pid}\\b`, 'u'),
      `an identity-less record was not reported unidentified:\n${report.stderr}`,
    );
    assert.doesNotMatch(
      report.stderr,
      new RegExp(`\\[test-lock\\] holder: pid=${sentinel.pid}\\b`, 'u'),
      'a record that cannot prove which process it names must not name a holder',
    );

    const coordinated = runRegistry(lockPath, ['coordinated-pids']);
    assert.equal(coordinated.status, 0, coordinated.stderr);
    assert.equal(
      coordinated.stdout.trim(),
      '',
      'an identity-less record must not exempt any process from the' +
        ` foreign-process check:\n${coordinated.stdout}`,
    );
  } finally {
    sentinel.kill('SIGKILL');
    await once(sentinel, 'exit');
    removeLock(lockPath);
  }
});

test('a second matrix run refuses by name instead of racing a live one', async () => {
  // The first holder is a real run-matrix.sh, so deleting its registry calls
  // makes this red. A generic wrapper standing in for it would prove only that
  // the wrapper records itself.
  const lockPath = uniqueLockPath('second-matrix');
  const sandbox = createMatrixSandbox();
  const holderPidPath = join(sandbox, 'holder.pid');
  const first = startMatrixRun(
    sandbox,
    lockPath,
    'MATRIX-ALPHA',
    `sh -c 'echo $$ > ${holderPidPath}; exec sleep 300'`,
  );
  const firstPid = first.child.pid;
  assert.ok(firstPid !== undefined);
  let survivorPid: number | undefined;

  try {
    await waitForFile(holderPidPath, first.child);
    survivorPid = Number(readFileSync(holderPidPath, 'utf8').trim());

    const second = runMatrixOnce(lockPath, 'MATRIX-BETA');
    assert.equal(second.status, 75, `${second.stdout}${second.stderr}`);
    assert.match(second.stderr, /TEST_GATE_LOCK_BUSY: exclusive access/u);
    const refusal = second.stderr.slice(
      second.stderr.indexOf('TEST_GATE_LOCK_BUSY'),
    );
    assert.match(
      refusal,
      new RegExp(
        `\\[test-lock\\] holder: pid=${firstPid}\\b.*label=MATRIX-ALPHA`,
        'u',
      ),
      `the refusal did not name the matrix that held the slot:\n${second.stderr}`,
    );
  } finally {
    if (survivorPid !== undefined) killQuietly(survivorPid);
    if (first.child.exitCode === null && first.child.signalCode === null) {
      first.child.kill('SIGKILL');
    }
    first.cleanup();
    removeLock(lockPath);
  }
});

test('the foreign-process wait blames only genuinely uncoordinated processes', async () => {
  const uncoordinatedLock = uniqueLockPath('foreign-uncoordinated');
  const uncoordinated = runMatrixWithFakeProcessTable(
    uncoordinatedLock,
    impossiblePid,
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
    new RegExp(`${impossiblePid}\\s+\\d+\\s+corepack pnpm test:compiler`, 'u'),
    `the refusal did not name the process it blamed:\n${uncoordinated.stderr}`,
  );

  await withQueuedWrapperDuringMatrix((matrix, queuedPid) => {
    assert.doesNotMatch(
      matrix.stderr,
      /TEST_GATE_LOCK_BUSY: a lock-unaware test process remained active/u,
      `queued lane ${queuedPid} was blamed as foreign:\n${matrix.stderr}`,
    );
    // Printed immediately after the foreign-process loop and before every
    // later check, so it isolates "got past the loop" from anything else the
    // matrix may refuse on.
    assert.match(
      matrix.stdout,
      /FOREIGN-COORDINATED starting\. Log:/u,
      `the matrix never cleared its foreign-process check:\n${matrix.stdout}${matrix.stderr}`,
    );
  });
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
  // A SOURCE-SHAPE RATCHET, NOT EXECUTION EVIDENCE. It reads the order of
  // commands in the runner; it does not observe the lock mode held while a
  // suite runs. It cannot catch a reordering expressed through indirection.
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

function recordFile(lockPath: string, pid: number): string {
  return join(`${lockPath}.holders`, `${pid}.json`);
}

function removeLock(lockPath: string): void {
  rmSync(lockPath, { force: true });
  rmSync(`${lockPath}.holders`, { force: true, recursive: true });
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

/**
 * A committed throwaway repository holding the production scripts, so
 * run-matrix.sh passes its own clean-tree and HEAD checks whatever state this
 * worktree is in. Without it a negative control that edits a script makes the
 * matrix exit 3 and the control fires for the wrong reason.
 */
function createMatrixSandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'north-star-matrix-sandbox-'));
  cpSync('scripts', join(root, 'scripts'), { recursive: true });
  const git = (...argv: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.email=lane@example.invalid',
        '-c',
        'user.name=lane',
        ...argv,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'matrix sandbox');
  return root;
}

function startMatrixRun(
  sandbox: string,
  lockPath: string,
  label: string,
  pre: string,
  // An empty process table by default. These runs are about the holder
  // registry, and a real `ps` lets unrelated lane activity trip the
  // foreign-process check and decide their verdict — the machine-load
  // dependence this repository refuses everywhere else.
  programs: Readonly<Record<string, string>> = {
    docker: 'exit 0\n',
    ps: 'exit 0\n',
  },
) {
  const fakeBin = createFakeBin(programs);
  const child = spawn(
    'bash',
    [join(sandbox, 'scripts/run-matrix.sh'), label, sandbox, pre],
    {
      cwd: sandbox,
      env: lockEnvironment(lockPath, {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  return {
    child,
    cleanup: () => {
      rmSync(fakeBin, { force: true, recursive: true });
      rmSync(sandbox, { force: true, recursive: true });
    },
  };
}

function runMatrixOnce(lockPath: string, label: string) {
  const fakeBin = createFakeBin({ docker: 'exit 0\n', ps: 'exit 0\n' });
  const sandbox = createMatrixSandbox();
  try {
    return spawnSync(
      'bash',
      [join(sandbox, 'scripts/run-matrix.sh'), label, sandbox, 'exit 7'],
      {
        cwd: sandbox,
        encoding: 'utf8',
        env: lockEnvironment(lockPath, {
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        }),
      },
    );
  } finally {
    rmSync(fakeBin, { force: true, recursive: true });
    rmSync(sandbox, { force: true, recursive: true });
  }
}

function runMatrixWithFakeProcessTable(lockPath: string, pid: string) {
  const fakeBin = createFakeBin({
    docker: 'exit 0\n',
    ps: `printf '${pid} ${pid} corepack pnpm test:compiler\\n'\n`,
  });
  const sandbox = createMatrixSandbox();
  try {
    return spawnSync(
      'bash',
      [
        join(sandbox, 'scripts/run-matrix.sh'),
        'FOREIGN-CONTROL',
        sandbox,
        'exit 7',
      ],
      {
        cwd: sandbox,
        encoding: 'utf8',
        env: lockEnvironment(lockPath, {
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        }),
      },
    );
  } finally {
    rmSync(fakeBin, { force: true, recursive: true });
    rmSync(sandbox, { force: true, recursive: true });
  }
}

/**
 * Runs a real matrix, and while it holds the lock starts a real queued wrapper
 * that writes its own waiting record, then lets the matrix reach its
 * foreign-process check with that wrapper visible in the process table. The
 * container guard is the synchronisation point: the fake docker blocks on its
 * second call, which is the post-lock guard, so the window is deterministic
 * rather than a race.
 *
 * Its coordination files live outside the sandbox. Writing them inside it made
 * the matrix refuse on a dirty tree, and the control then failed for a reason
 * that had nothing to do with foreign-process classification.
 */
async function withQueuedWrapperDuringMatrix(
  check: (
    matrix: { stderr: string; stdout: string },
    queuedPid: number,
  ) => Promise<void> | void,
): Promise<void> {
  const lockPath = uniqueLockPath('foreign-coordinated');
  const sandbox = createMatrixSandbox();
  const scratch = mkdtempSync(join(tmpdir(), 'north-star-foreign-scratch-'));
  const gate = join(scratch, 'docker-gate');
  const processTable = join(scratch, 'process-table');
  writeFileSync(processTable, '');

  const matrix = startMatrixRun(
    sandbox,
    lockPath,
    'FOREIGN-COORDINATED',
    'exit 7',
    {
      docker:
        `count=$(cat ${gate}.count 2>/dev/null || echo 0)\n` +
        `count=$((count + 1)); echo "$count" > ${gate}.count\n` +
        `if [ "$count" = "2" ]; then\n` +
        `  while [ ! -e ${gate}.release ]; do sleep 0.05; done\n` +
        `fi\nexit 0\n`,
      ps: `cat ${processTable}\n`,
    },
  );
  let stdout = '';
  let stderr = '';
  matrix.child.stdout.setEncoding('utf8');
  matrix.child.stderr.setEncoding('utf8');
  matrix.child.stdout.on('data', (chunk: string) => (stdout += chunk));
  matrix.child.stderr.on('data', (chunk: string) => (stderr += chunk));

  let queued: ChildProcess | undefined;
  try {
    await waitUntil(
      () => stdout.includes('ACQUIRED the lock.'),
      matrix.child,
      'the matrix never acquired the lock',
    );

    // A real wrapper, queued behind the matrix, writing its own waiting record.
    const queuedProcess = spawn(
      process.execPath,
      [
        lockRunnerPath,
        'exclusive',
        '--',
        process.execPath,
        '-e',
        'process.stdin.resume()',
      ],
      {
        env: lockEnvironment(lockPath, {
          NORTH_STAR_TEST_LOCK_LABEL: 'QUEUED-LANE',
          NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS: '120',
        }),
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    );
    queued = queuedProcess;
    const queuedPid = queuedProcess.pid;
    assert.ok(queuedPid !== undefined);
    await waitUntil(
      () => existsSync(recordFile(lockPath, queuedPid)),
      matrix.child,
      'the queued wrapper never recorded itself as waiting',
    );

    writeFileSync(
      processTable,
      `${queuedPid} ${readProcessGroup(queuedPid)} corepack pnpm test:compiler\n`,
    );
    writeFileSync(`${gate}.release`, '');

    await waitUntil(
      () => matrix.child.exitCode !== null,
      undefined,
      'the matrix never finished its foreign-process check',
    );
    await check({ stderr, stdout }, queuedPid);
  } finally {
    if (queued !== undefined) {
      queued.kill('SIGKILL');
      await once(queued, 'exit');
    }
    if (matrix.child.exitCode === null && matrix.child.signalCode === null) {
      matrix.child.kill('SIGKILL');
    }
    matrix.cleanup();
    rmSync(scratch, { force: true, recursive: true });
    removeLock(lockPath);
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

function killQuietly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
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

async function waitUntil(
  condition: () => boolean,
  child: ChildProcessWithoutNullStreams | undefined,
  failure: string,
  timeoutMilliseconds = 30_000,
): Promise<void> {
  for (
    let attempt = 0;
    attempt < timeoutMilliseconds / 25;
    attempt += 1 // bounded poll, never a measured interval
  ) {
    if (condition()) return;
    if (child !== undefined && child.exitCode !== null) break;
    await delay(25);
  }
  if (condition()) return;
  throw new Error(failure);
}

function waitForFile(
  path: string,
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  return waitUntil(
    () => existsSync(path),
    child,
    `${path} never appeared; the process exited with ${String(child.exitCode)}`,
  );
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
