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
// Only fixtures. A test file names other test files as inventory data — the
// repository-hygiene suite lists every postgres test by path — and it may also
// spawn something for an unrelated reason, so "contains a spawn call" is not
// enough to make a quoted path executable. Fixtures are the only repository
// paths tests actually run.
const spawnedSourcePattern =
  /'((?:apps|test)\/(?:[\w./-]*\/)?fixtures\/[\w./-]+\.ts)'/gu;
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
    assert.equal(
      existsSync(recordFile(lockPath, waiter.pid ?? 0)),
      false,
      'a wrapper that exits must remove its own record, or every later report' +
        ' names a participant that is not there',
    );
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

test('an exited-but-unreaped holder is not live and vouches for nobody', async () => {
  // A zombie keeps its /proc entry and its start ticks, so identity alone reads
  // it as the very process that was recorded. Every descriptor it held is
  // already closed, so it cannot be the holder — and it must not lend its
  // lineage to anything.
  const lockPath = uniqueLockPath('zombie-holder');
  const zombie = await startZombie();
  try {
    const recorded = runRegistry(lockPath, [
      'record',
      '--pid',
      String(zombie.zombiePid),
      '--mode',
      'exclusive',
      '--state',
      'holding',
      '--label',
      'ZOMBIE-HOLDER',
      '--command',
      'a process that exited without being reaped',
    ]);
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.equal(
      readProcessState(zombie.zombiePid),
      'Z',
      'the control did not actually produce a zombie',
    );

    const report = runRegistry(lockPath, ['report']);
    assert.match(
      report.stderr,
      new RegExp(
        `STALE record, NOT the current holder \\(the process has exited but` +
          ` not been reaped \\(state Z\\)\\): pid=${zombie.zombiePid}\\b`,
        'u',
      ),
      `a zombie was not reported exited:\n${report.stderr}`,
    );
    assert.doesNotMatch(
      report.stderr,
      new RegExp(`\\[test-lock\\] holder: pid=${zombie.zombiePid}\\b`, 'u'),
      'a zombie must never be named as the current holder',
    );
    assert.match(
      report.stderr,
      /a process that inherited its descriptor holds it/u,
      'the exited case carries the same inherited-descriptor qualification',
    );

    const coordinated = runRegistry(lockPath, ['coordinated-pids']);
    assert.equal(
      coordinated.stdout.trim(),
      '',
      `a zombie must not exempt anything from the foreign check:\n${coordinated.stdout}`,
    );
  } finally {
    await zombie.stop();
    removeLock(lockPath);
  }
});

test('an inherited claim is refused once its holder has released', async () => {
  // The review's nominated execution. Inherit an exclusive lease, let the
  // original holder exit and release, let a second process acquire, then have
  // the child attempt an exclusive nested lease. No descriptor can be checked
  // by an asking process, so the registry is the only authority: the claimed
  // holder no longer has a record, so the claim buys nothing.
  const lockPath = uniqueLockPath('released-claim');
  const scratch = createScratch();
  const claimPath = join(scratch, 'claim.txt');
  const markerPath = join(scratch, 'marker');
  try {
    const minted = spawnSync(
      process.execPath,
      [
        lockRunnerPath,
        'exclusive',
        '--',
        'sh',
        '-c',
        `printf %s "$NORTH_STAR_TEST_LOCK_HELD" > ${claimPath}`,
      ],
      {
        encoding: 'utf8',
        env: lockEnvironment(lockPath, {
          NORTH_STAR_TEST_LOCK_LABEL: 'FIRST-HOLDER',
        }),
      },
    );
    assert.equal(minted.status, 0, minted.stderr);
    const staleClaim = readFileSync(claimPath, 'utf8');
    assert.match(staleClaim, /^exclusive:\d+:\d+:/u, 'no claim was inherited');

    const second = startHolder(lockPath, 'SECOND-HOLDER', 'exclusive');
    assert.ok(second.pid !== undefined);
    try {
      await waitForOutput(second.stdout, 'LOCK_READY');
      const nested = spawnSync(
        process.execPath,
        [lockRunnerPath, 'exclusive', '--', 'touch', markerPath],
        {
          encoding: 'utf8',
          env: {
            ...lockEnvironment(lockPath, {
              NORTH_STAR_TEST_LOCK_LABEL: 'STALE-CLAIMANT',
            }),
            NORTH_STAR_TEST_LOCK_HELD: staleClaim,
          },
        },
      );

      assert.equal(nested.status, 75, `${nested.stdout}${nested.stderr}`);
      assert.match(
        nested.stderr,
        /inherited lease claim NOT honoured: no record remains for the claimed holder/u,
        `the stale claim was honoured:\n${nested.stderr}`,
      );
      const refusal = nested.stderr.slice(
        nested.stderr.indexOf('TEST_GATE_LOCK_BUSY'),
      );
      assert.match(
        refusal,
        new RegExp(
          `\\[test-lock\\] holder: pid=${second.pid}\\b.*label=SECOND-HOLDER`,
          'u',
        ),
        `the refusal did not name the second holder:\n${nested.stderr}`,
      );
      assert.equal(
        existsSync(markerPath),
        false,
        'the command ran under a claim its holder no longer backs',
      );
    } finally {
      await stopHolder(second);
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
    removeLock(lockPath);
  }
});

test('a claim minted for one lock cannot authorize another', async () => {
  const mintedLock = uniqueLockPath('claim-origin');
  const targetLock = uniqueLockPath('claim-target');
  const scratch = createScratch();
  const claimPath = join(scratch, 'claim.txt');
  const markerPath = join(scratch, 'marker');
  const holder = startHolder(targetLock, 'TARGET-HOLDER', 'exclusive');
  assert.ok(holder.pid !== undefined);
  try {
    await waitForOutput(holder.stdout, 'LOCK_READY');
    const minted = spawnSync(
      process.execPath,
      [
        lockRunnerPath,
        'exclusive',
        '--',
        'sh',
        '-c',
        `printf %s "$NORTH_STAR_TEST_LOCK_HELD" > ${claimPath}`,
      ],
      {
        encoding: 'utf8',
        env: lockEnvironment(mintedLock, {
          NORTH_STAR_TEST_LOCK_LABEL: 'OTHER-LOCK-HOLDER',
        }),
      },
    );
    assert.equal(minted.status, 0, minted.stderr);

    const crossed = spawnSync(
      process.execPath,
      [lockRunnerPath, 'exclusive', '--', 'touch', markerPath],
      {
        encoding: 'utf8',
        env: {
          ...lockEnvironment(targetLock, {
            NORTH_STAR_TEST_LOCK_LABEL: 'CROSS-LOCK-CLAIMANT',
          }),
          NORTH_STAR_TEST_LOCK_HELD: readFileSync(claimPath, 'utf8'),
        },
      },
    );

    assert.equal(crossed.status, 75, `${crossed.stdout}${crossed.stderr}`);
    assert.match(
      crossed.stderr,
      new RegExp(
        `inherited lease claim NOT honoured: the inherited claim names` +
          ` ${mintedLock}, not ${targetLock}`,
        'u',
      ),
      `a claim for another lock was honoured:\n${crossed.stderr}`,
    );
    assert.equal(existsSync(markerPath), false);
  } finally {
    await stopHolder(holder);
    rmSync(scratch, { force: true, recursive: true });
    removeLock(mintedLock);
    removeLock(targetLock);
  }
});

test('an exclusive claim stops covering once its holder records shared', async () => {
  // The matrix downgrades and rewrites its record. A descendant still carrying
  // the exclusive claim must be refused for exclusive work and admitted for
  // shared work — the recorded mode decides, not the claim.
  const lockPath = uniqueLockPath('narrowed-claim');
  const scratch = createScratch();
  const claimPath = join(scratch, 'claim.txt');
  const markerPath = join(scratch, 'marker');
  const holder = spawn(
    process.execPath,
    [
      lockRunnerPath,
      'exclusive',
      '--',
      'sh',
      '-c',
      `printf %s "$NORTH_STAR_TEST_LOCK_HELD" > ${claimPath}; echo LOCK_READY; exec sleep 300`,
    ],
    {
      // Detached: SIGKILLing the wrapper leaves its `exec sleep 300` holding
      // this process's pipes, which keeps the whole suite alive for five
      // minutes after its assertions are done.
      detached: true,
      env: lockEnvironment(lockPath, {
        NORTH_STAR_TEST_LOCK_LABEL: 'DOWNGRADING-HOLDER',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  assert.ok(holder.pid !== undefined);
  try {
    await waitForOutput(holder.stdout, 'LOCK_READY');
    const claim = readFileSync(claimPath, 'utf8');
    assert.match(claim, /^exclusive:/u);

    // The production recorder rewrites the holder's mode, exactly as the
    // matrix does at its downgrade.
    const rewritten = runRegistry(lockPath, [
      'record',
      '--pid',
      String(holder.pid),
      '--mode',
      'shared',
      '--state',
      'holding',
      '--label',
      'DOWNGRADING-HOLDER',
      '--command',
      'matrix tail',
    ]);
    assert.equal(rewritten.status, 0, rewritten.stderr);

    const nestedShared = spawnSync(
      process.execPath,
      [lockRunnerPath, 'shared', '--', 'sh', '-c', 'printf SHARED_RAN'],
      {
        encoding: 'utf8',
        env: {
          ...lockEnvironment(lockPath),
          NORTH_STAR_TEST_LOCK_HELD: claim,
        },
      },
    );
    assert.equal(nestedShared.status, 0, nestedShared.stderr);
    assert.equal(
      nestedShared.stdout,
      'SHARED_RAN',
      'a recorded shared mode still covers a shared request',
    );

    // The refusal must be immediate. An authenticated holder recording shared
    // is conclusive that an exclusive request is a nested upgrade, and real
    // acquisition would self-block against that holder's own descriptor for the
    // whole bound. A stub flock records any acquisition attempt, and the bound
    // is deliberately non-zero so that a regression to "acquire normally" could
    // not be mistaken for an immediate refusal.
    const flockMarker = join(scratch, 'flock-invoked');
    const stubBin = createFakeBin({
      flock: `touch ${flockMarker}\nexit 0\n`,
    });
    const nestedExclusive = spawnSync(
      process.execPath,
      [lockRunnerPath, 'exclusive', '--', 'touch', markerPath],
      {
        encoding: 'utf8',
        env: {
          ...lockEnvironment(lockPath, {
            NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS: '5',
            PATH: `${stubBin}:${process.env.PATH ?? ''}`,
          }),
          NORTH_STAR_TEST_LOCK_HELD: claim,
        },
      },
    );
    rmSync(stubBin, { force: true, recursive: true });
    assert.equal(
      nestedExclusive.status,
      2,
      `a nested upgrade must be refused outright:\n${nestedExclusive.stderr}`,
    );
    assert.match(
      nestedExclusive.stderr,
      /TEST_GATE_LOCK_UPGRADE_REFUSED: an exclusive gate cannot run inside a shared gate: the claim asserts exclusive but pid=\d+ now records shared, which does not cover exclusive/u,
      `a narrowed lease still authorized exclusive work:\n${nestedExclusive.stderr}`,
    );
    assert.equal(
      existsSync(flockMarker),
      false,
      'the refusal must precede acquisition; flock was invoked, so this run' +
        " would have blocked against the authenticated holder's own descriptor",
    );
    assert.equal(
      existsSync(markerPath),
      false,
      'exclusive work ran under a lease that had been downgraded',
    );
  } finally {
    if (holder.pid !== undefined) killGroupQuietly(holder.pid);
    holder.kill('SIGKILL');
    await once(holder, 'exit');
    holder.stdout.destroy();
    holder.stderr.destroy();
    rmSync(scratch, { force: true, recursive: true });
    removeLock(lockPath);
  }
});

test('an unrecognized recorded mode is not conclusive', async () => {
  // A live, identity-valid holding record whose mode this registry does not
  // recognize — the value its own CLI writes when --mode is omitted — with a
  // claim that names that PID, its start ticks and this lock. The record
  // authenticates but says nothing about coverage, so the claim must fall
  // through to real acquisition rather than being refused as a nested upgrade.
  const lockPath = uniqueLockPath('unrecognized-mode');
  const scratch = createScratch();
  const flockMarker = join(scratch, 'flock-invoked');
  const payloadMarker = join(scratch, 'payload-ran');
  const sentinel = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  assert.ok(sentinel.pid !== undefined);
  const stubBin = createFakeBin({
    flock: `touch ${flockMarker}\nexit 0\n`,
  });
  try {
    // --mode omitted on purpose: this is the production recorder's own default.
    const recorded = runRegistry(lockPath, [
      'record',
      '--pid',
      String(sentinel.pid),
      '--state',
      'holding',
      '--label',
      'UNRECOGNIZED-MODE',
      '--command',
      'a holder recorded without a mode',
    ]);
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.equal(
      (
        JSON.parse(
          readFileSync(recordFile(lockPath, sentinel.pid), 'utf8'),
        ) as {
          mode: string;
        }
      ).mode,
      'unknown',
      'the recorder no longer writes an unrecognized mode; the control is moot',
    );

    const claim = runRegistry(lockPath, [
      'claim',
      '--mode',
      'shared',
      '--pid',
      String(sentinel.pid),
    ]);
    assert.equal(claim.status, 0, claim.stderr);

    const nested = spawnSync(
      process.execPath,
      [lockRunnerPath, 'shared', '--', 'touch', payloadMarker],
      {
        encoding: 'utf8',
        env: {
          ...lockEnvironment(lockPath, {
            PATH: `${stubBin}:${process.env.PATH ?? ''}`,
          }),
          NORTH_STAR_TEST_LOCK_HELD: claim.stdout.trim(),
        },
      },
    );

    assert.doesNotMatch(
      nested.stderr,
      /TEST_GATE_LOCK_UPGRADE_REFUSED/u,
      `an unrecognized mode was treated as a nested upgrade:\n${nested.stderr}`,
    );
    assert.equal(nested.status, 0, `${nested.stdout}${nested.stderr}`);
    assert.match(
      nested.stderr,
      /inherited lease claim NOT honoured: pid=\d+ records mode "unknown", which is not a recognized lease mode/u,
      `the claim was not reported unhonoured for the right reason:\n${nested.stderr}`,
    );
    assert.ok(
      existsSync(flockMarker),
      'the run never attempted real acquisition',
    );
    assert.ok(existsSync(payloadMarker), 'the payload never ran');
  } finally {
    rmSync(stubBin, { force: true, recursive: true });
    sentinel.kill('SIGKILL');
    await once(sentinel, 'exit');
    rmSync(scratch, { force: true, recursive: true });
    removeLock(lockPath);
  }
});

test('the matrix refuses to run when it cannot record its lease', async () => {
  const lockPath = uniqueLockPath('unwritable-registry');
  const scratch = createScratch();
  const markerPath = join(scratch, 'pre-command-ran');
  // An unwritable registry directory: mkdir succeeds, the record write does not.
  mkdirSync(`${lockPath}.holders`, { recursive: true });
  chmodSync(`${lockPath}.holders`, 0o500);
  const matrix = startMiniatureMatrix(lockPath, 'UNWRITABLE', {
    pre: `touch ${markerPath}`,
  });
  try {
    const result = await matrix.finished;
    assert.equal(result.status, 77, `${result.stdout}${result.stderr}`);
    assert.match(
      result.stderr,
      /TEST_GATE_REGISTRY_WRITE_FAILED/u,
      `the matrix did not name the failed write:\n${result.stderr}`,
    );
    assert.equal(
      existsSync(markerPath),
      false,
      'the matrix ran its pre-command despite holding a lease it could not record',
    );
  } finally {
    chmodSync(`${lockPath}.holders`, 0o700);
    matrix.cleanup();
    rmSync(scratch, { force: true, recursive: true });
    removeLock(lockPath);
  }
});

test('a queued matrix records itself as waiting', async () => {
  const lockPath = uniqueLockPath('queued-matrix');
  const holder = startHolder(lockPath, 'SLOT-HOLDER', 'exclusive');
  assert.ok(holder.pid !== undefined);
  const matrix = startMiniatureMatrix(lockPath, 'QUEUED-MATRIX', {
    timeoutSeconds: '30',
  });
  try {
    await waitForOutput(holder.stdout, 'LOCK_READY');
    const matrixPid = matrix.child.pid;
    assert.ok(matrixPid !== undefined);
    await waitUntil(
      () => existsSync(recordFile(lockPath, matrixPid)),
      matrix.child,
      'the queued matrix never recorded itself',
    );
    const report = runRegistry(lockPath, ['report']);
    assert.match(
      report.stderr,
      new RegExp(
        `\\[test-lock\\] also queued: pid=${matrixPid}\\b.*mode=exclusive` +
          ` state=waiting label=QUEUED-MATRIX`,
        'u',
      ),
      `a queued matrix is invisible to everyone else:\n${report.stderr}`,
    );
  } finally {
    matrix.cleanup();
    await matrix.finished.catch(() => undefined);
    await stopHolder(holder);
    removeLock(lockPath);
  }
});

test('the matrix downgrade converts the lock and rewrites its record', async () => {
  // Drives run-matrix.sh's own downgrade sequence rather than re-enacting it:
  // deleting the runner's conversion or its shared-mode write must red this.
  // The observation runs from inside the matrix's own shared tail.
  const lockPath = uniqueLockPath('production-downgrade');
  const matrix = startMiniatureMatrix(lockPath, 'DOWNGRADE', { observe: true });
  try {
    const result = await matrix.finished;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /FULL_MATRIX_PASS_SHA=/u);

    const matrixPid = matrix.child.pid;
    assert.ok(matrixPid !== undefined);
    assert.equal(
      existsSync(recordFile(lockPath, matrixPid)),
      false,
      'a matrix that completes must clear its record on the way out',
    );

    const observed = matrix.readObservation();
    assert.match(
      observed.records,
      /"mode":"shared"/u,
      `the matrix did not rewrite its record at the downgrade:\n${observed.records}`,
    );
    assert.equal(
      observed.sharedProbeStatus,
      '0',
      `a shared gate was refused during the matrix tail, so the lock was never` +
        ` converted:\n${observed.sharedProbe}`,
    );
    assert.equal(
      observed.exclusiveProbeStatus,
      '75',
      `an exclusive gate was admitted during the matrix tail:\n${observed.exclusiveProbe}`,
    );
  } finally {
    matrix.cleanup();
    removeLock(lockPath);
  }
});

test('a shared gate preserves the stale record of a still-held descriptor', async () => {
  const lockPath = uniqueLockPath('downgraded-matrix');
  const sandbox = createMatrixSandbox();
  const scratch = createScratch();
  const survivorPidPath = join(scratch, 'survivor.pid');
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

    matrix.child.kill('SIGKILL');
    await once(matrix.child, 'exit');
    assert.ok(existsSync(recordFile(lockPath, matrixPid)));

    const shared = runGate(lockPath, 'SHARED-TAIL', 'shared');
    assert.equal(shared.status, 0, shared.stderr);
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
    assert.match(
      exclusive.stderr.slice(exclusive.stderr.indexOf('TEST_GATE_LOCK_BUSY')),
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
    rmSync(scratch, { force: true, recursive: true });
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
    assert.match(
      report.stderr,
      new RegExp(`UNIDENTIFIED record .*pid=${sentinel.pid}\\b`, 'u'),
      `an identity-less record was not reported unidentified:\n${report.stderr}`,
    );
    assert.doesNotMatch(
      report.stderr,
      new RegExp(`\\[test-lock\\] holder: pid=${sentinel.pid}\\b`, 'u'),
    );
    const coordinated = runRegistry(lockPath, ['coordinated-pids']);
    assert.equal(coordinated.stdout.trim(), '');
  } finally {
    sentinel.kill('SIGKILL');
    await once(sentinel, 'exit');
    removeLock(lockPath);
  }
});

test('a second matrix run refuses by name instead of racing a live one', async () => {
  const lockPath = uniqueLockPath('second-matrix');
  const sandbox = createMatrixSandbox();
  const scratch = createScratch();
  const holderPidPath = join(scratch, 'holder.pid');
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
    assert.match(
      second.stderr.slice(second.stderr.indexOf('TEST_GATE_LOCK_BUSY')),
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
    rmSync(scratch, { force: true, recursive: true });
    removeLock(lockPath);
  }
});

test('the foreign-process wait blames only genuinely uncoordinated processes', async () => {
  const uncoordinatedLock = uniqueLockPath('foreign-uncoordinated');
  const uncoordinated = runMatrixWithFakeProcessTable(uncoordinatedLock, [
    `${impossiblePid} ${impossiblePid} corepack pnpm test:compiler`,
  ]);
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

  // Three rows that discriminate. Participant-only logic would blame the
  // ancestor and the descendant; the deleted process-group rule would exempt
  // the sibling. Only lineage gets all three right.
  await withQueuedWrapperDuringMatrix((matrix, rows) => {
    assert.match(
      matrix.stderr,
      /TEST_GATE_LOCK_BUSY: a lock-unaware test process remained active/u,
      `the unrelated sibling was not blamed:\n${matrix.stderr}`,
    );
    const blamed = matrix.stderr.slice(
      matrix.stderr.indexOf('a lock-unaware test process remained active'),
    );
    assert.match(
      blamed,
      new RegExp(`^\\s*${rows.siblingPid}\\s`, 'mu'),
      `the sibling sharing the participant's PGID was not blamed:\n${blamed}`,
    );
    assert.doesNotMatch(
      blamed,
      new RegExp(`^\\s*${rows.ancestorPid}\\s`, 'mu'),
      `an ancestor of a recorded participant was blamed:\n${blamed}`,
    );
    assert.doesNotMatch(
      blamed,
      new RegExp(`^\\s*${rows.descendantPid}\\s`, 'mu'),
      `a descendant of a recorded participant was blamed:\n${blamed}`,
    );
  });
});

test('each derived container-bearing entry point takes the exclusive lease', () => {
  // PROVEN: for the root package.json test:*/check:* scripts, the mode matches
  // what the declared model above derives. NOT PROVEN: that the model finds
  // every container-bearing suite — see its declared limits — and workspace
  // manifests are not scanned here at all; apps/web's lease shape is asserted
  // in repository-hygiene.test.ts instead.
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

  assert.ok(bearing.length > 0, 'no container-bearing entry point was found');
  assert.ok(
    notBearing.length > 0,
    'the derivation classified every scanned entry point as container-bearing,' +
      ' so it is reading something other than call sites',
  );
  // The scanner reads code, never prose. This file's own comments name the
  // helper and test:architecture globs this file, so a scanner that matched raw
  // source would call the architecture suite container-bearing on the strength
  // of a sentence — while its real reason sits in tenant-completeness.
  assert.doesNotMatch(
    stripCommentsAndStrings(
      '// a comment naming withEphemeralPostgres(\n' +
        "const named = 'withEphemeralPostgres(';\n",
    ),
    containerCallPattern,
    'prose and string literals must not read as call sites',
  );
  assert.match(
    stripCommentsAndStrings('await withEphemeralPostgres("label", run);\n'),
    containerCallPattern,
    'a real call site must survive stripping',
  );
});

test('the matrix downgrades only after its last container-bearing suite', () => {
  // A SOURCE-SHAPE RATCHET, NOT EXECUTION EVIDENCE. It reads the runner's
  // executable command lines; it does not observe the lock mode held while a
  // suite runs. It cannot catch a reordering expressed through indirection.
  const commands = executableCommandLines(
    readFileSync(matrixRunnerPath, 'utf8'),
  );
  const downgradeAt = commands.findIndex((line) =>
    line.startsWith('bash scripts/downgrade-test-lock.sh'),
  );
  assert.notEqual(downgradeAt, -1, 'the matrix no longer downgrades at all');

  const bearing = governedScripts()
    .filter(([, command]) => standsUpContainers(command))
    .map(([script]) => script);
  assert.ok(bearing.length > 0);
  for (const script of bearing) {
    const invocations = commands
      .map((line, index) => ({ index, line }))
      .filter(({ line }) =>
        new RegExp(`^corepack pnpm ${script}(?:\\s|$)`, 'u').test(line),
      )
      .map(({ index }) => index);
    assert.equal(
      invocations.length,
      1,
      `the matrix runs ${script} ${invocations.length} times as an executable` +
        ' command; a duplicate makes position meaningless',
    );
    assert.ok(
      (invocations[0] ?? -1) < downgradeAt,
      `${script} stands up containers but runs after the shared downgrade`,
    );
  }

  const tail = commands.slice(downgradeAt);
  assert.ok(tail.some((line) => line.includes('check:reachability')));
  assert.ok(tail.some((line) => line.includes('run-security-scans.sh')));
});

test('a refused entry point has not touched its evidence', async () => {
  // Preparation deletes this suite's evidence file. If it runs before the lock
  // is acquired, a script that is refused has already destroyed the record of
  // the previous run.
  const lockPath = uniqueLockPath('evidence-untouched');
  const evidencePath = 'test-results/reachability/agent.json';
  const holder = startHolder(lockPath, 'EVIDENCE-HOLDER', 'exclusive');
  assert.ok(holder.pid !== undefined);
  mkdirSync(dirname(evidencePath), { recursive: true });
  const existed = existsSync(evidencePath);
  const before = existed ? readFileSync(evidencePath, 'utf8') : 'SENTINEL\n';
  if (!existed) writeFileSync(evidencePath, before);
  try {
    await waitForOutput(holder.stdout, 'LOCK_READY');
    const refused = spawnSync('corepack', ['pnpm', 'test:agent'], {
      encoding: 'utf8',
      env: lockEnvironment(lockPath),
    });
    assert.equal(refused.status, 75, `${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, /TEST_GATE_LOCK_BUSY/u);
    assert.ok(
      existsSync(evidencePath),
      'a refused entry point deleted its evidence before taking the lock',
    );
    assert.equal(
      readFileSync(evidencePath, 'utf8'),
      before,
      'a refused entry point rewrote its evidence before taking the lock',
    );
  } finally {
    if (!existed) rmSync(evidencePath, { force: true });
    await stopHolder(holder);
    removeLock(lockPath);
  }
});

test('the workspace-local contracts entry point locks before it prepares', async () => {
  // apps/web ran its evidence preparation before the wrapper, so a contracts
  // run that was refused the lock had already deleted the previous run's
  // evidence. Only contracts.json is a declared evidence path for this
  // producer; the other two are the preparation loop's remaining slots and are
  // undefined here, so they are seeded to prove nothing writes them either.
  const lockPath = uniqueLockPath('contracts-evidence');
  const evidencePaths = [
    'test-results/reachability/contracts.json',
    'test-results/reachability/contracts.raw.json',
    'test-results/reachability/contracts.argv.json',
  ];
  const holder = startHolder(lockPath, 'CONTRACTS-HOLDER', 'exclusive');
  assert.ok(holder.pid !== undefined);
  mkdirSync(dirname(evidencePaths[0] ?? ''), { recursive: true });
  const original = evidencePaths.map((path) =>
    existsSync(path) ? readFileSync(path, 'utf8') : undefined,
  );
  const sentinels = evidencePaths.map(
    (path, index) => `SENTINEL ${index} ${path}\n`,
  );
  try {
    for (const [index, path] of evidencePaths.entries()) {
      writeFileSync(path, sentinels[index] ?? '');
    }
    await waitForOutput(holder.stdout, 'LOCK_READY');

    const refused = spawnSync(
      'corepack',
      ['pnpm', '--filter', '@north-star/web', 'test:contracts'],
      { encoding: 'utf8', env: lockEnvironment(lockPath) },
    );
    assert.equal(refused.status, 75, `${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, /TEST_GATE_LOCK_BUSY/u);
    for (const [index, path] of evidencePaths.entries()) {
      assert.ok(
        existsSync(path),
        `${path} was deleted before the lock was taken`,
      );
      assert.equal(
        readFileSync(path, 'utf8'),
        sentinels[index],
        `${path} was rewritten before the lock was taken`,
      );
    }
  } finally {
    for (const [index, path] of evidencePaths.entries()) {
      const previous = original[index];
      if (previous === undefined) rmSync(path, { force: true });
      else writeFileSync(path, previous);
    }
    await stopHolder(holder);
    removeLock(lockPath);
  }
});

test('the wrapper refuses when it cannot record its own lease', async () => {
  // The matrix's checked writes are controlled through run-matrix.sh; this
  // drives the wrapper's own record() catch, which nothing else observes.
  const lockPath = uniqueLockPath('wrapper-unwritable');
  const scratch = createScratch();
  const markerPath = join(scratch, 'payload-ran');
  mkdirSync(`${lockPath}.holders`, { recursive: true });
  chmodSync(`${lockPath}.holders`, 0o500);
  try {
    const refused = spawnSync(
      process.execPath,
      [lockRunnerPath, 'exclusive', '--', 'touch', markerPath],
      { encoding: 'utf8', env: lockEnvironment(lockPath) },
    );
    assert.equal(
      refused.status,
      77,
      `the wrapper ran on with an unrecordable lease:\n${refused.stderr}`,
    );
    assert.match(
      refused.stderr,
      /TEST_GATE_REGISTRY_WRITE_FAILED: cannot record pid=\d+ as waiting for/u,
      `the wrapper did not name the failed write:\n${refused.stderr}`,
    );
    assert.equal(
      existsSync(markerPath),
      false,
      'the payload ran under a lease the wrapper could not record',
    );
  } finally {
    chmodSync(`${lockPath}.holders`, 0o700);
    rmSync(scratch, { force: true, recursive: true });
    removeLock(lockPath);
  }
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

/** Executable lines of a shell script: comments and blanks removed. */
function executableCommandLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Static reachability of a `withEphemeralPostgres(...)` CALL from the files a
 * script executes. Comments and string literals are removed before matching:
 * prose that names the helper is not a call, and the scanner's own explanation
 * of itself lives inside a suite it scans.
 *
 * DECLARED MODEL, not a repository fact. What is followed is: relative import
 * specifiers, and single-quoted `test/**\/fixtures/**` or `apps/**\/fixtures/**`
 * paths appearing anywhere in a file that also contains a `spawn(`/`spawnSync(`
 * token. It does NOT read process-call arguments, so co-location is the whole
 * of the association; `execFile`, `fork` and shell-string invocations are
 * outside it entirely; and a non-fixture repository path is never followed.
 *
 * So a shared suite that spawns a literal non-fixture repository file which
 * calls withEphemeralPostgres is invisible to this gate and would keep its
 * shared lease. Reading the actual call arguments is the fix, and it is out of
 * this packet's scope.
 */
function standsUpContainers(command: string): boolean {
  const pending = entryFiles(command);
  const seen = new Set<string>(pending);
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined) continue;
    const source = readFileSync(file, 'utf8');
    if (containerCallPattern.test(stripCommentsAndStrings(source))) return true;
    for (const next of referencedSourceFiles(file, source)) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }
  return false;
}

/**
 * Replaces comment and string-literal bodies with spaces, preserving offsets.
 * Deliberately conservative: it does not track regular-expression literals, so
 * a `withEphemeralPostgres(` inside one would still match. That direction is
 * safe — it over-reports rather than under-reports.
 */
export function stripCommentsAndStrings(source: string): string {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === '//') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      output += ' '.repeat(stop - index);
      index = stop;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      output += ' '.repeat(stop - index);
      index = stop;
      continue;
    }
    const quote = source[index];
    if (quote === "'" || quote === '"' || quote === '`') {
      output += ' ';
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          output += '  ';
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          output += ' ';
          index += 1;
          break;
        }
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    output += source[index];
    index += 1;
  }
  return output;
}

function entryFiles(command: string): string[] {
  const files = new Set<string>();
  addSourceTokens(files, command, '.');
  if (command.includes('playwright test')) {
    for (const path of globSync('apps/web/test/browser/**/*.spec.ts')) {
      files.add(resolve(path));
    }
  }
  const delegated = /--filter @north-star\/web ([\w:-]+)/u.exec(command);
  if (delegated?.[1] !== undefined) {
    const webManifest = JSON.parse(
      readFileSync('apps/web/package.json', 'utf8'),
    ) as { scripts?: Record<string, string> };
    addSourceTokens(
      files,
      webManifest.scripts?.[delegated[1]] ?? '',
      'apps/web',
    );
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
  // execute one: elsewhere a repository path is data.
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

function createScratch(): string {
  return mkdtempSync(join(tmpdir(), 'north-star-lock-obs-'));
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

async function startZombie() {
  const scratch = createScratch();
  const script = join(scratch, 'zombie.py');
  writeFileSync(
    script,
    [
      'import os, sys, time',
      'pid = os.fork()',
      'if pid == 0:',
      '    os._exit(0)',
      'sys.stdout.write(str(pid) + "\\n")',
      'sys.stdout.flush()',
      'time.sleep(300)',
      '',
    ].join('\n'),
  );
  const parent = spawn('python3', [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pidLine = await readLine(parent.stdout);
  const zombiePid = Number(pidLine.trim());
  assert.ok(Number.isSafeInteger(zombiePid) && zombiePid > 0, pidLine);
  return {
    zombiePid,
    stop: async () => {
      parent.kill('SIGKILL');
      await once(parent, 'exit');
      rmSync(scratch, { force: true, recursive: true });
    },
  };
}

/**
 * A committed throwaway repository holding the production scripts, so
 * run-matrix.sh passes its own clean-tree and HEAD checks whatever state this
 * worktree is in.
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
  programs: Readonly<Record<string, string>> = {
    docker: 'exit 0\n',
    ps: 'exit 0\n',
  },
  timeoutSeconds = '0',
) {
  const fakeBin = createFakeBin(programs);
  const child = spawn(
    'bash',
    [join(sandbox, 'scripts/run-matrix.sh'), label, sandbox, pre],
    {
      cwd: sandbox,
      detached: true,
      env: lockEnvironment(lockPath, {
        NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS: timeoutSeconds,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  return {
    child,
    cleanup: () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The group is already gone.
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      rmSync(fakeBin, { force: true, recursive: true });
      rmSync(sandbox, { force: true, recursive: true });
    },
  };
}

/**
 * Runs the real run-matrix.sh end to end against stubbed suites, so its whole
 * lease lifecycle executes: the waiting record, acquisition, the downgrade and
 * its shared-mode record, the tail, and the release trap. `corepack` is a
 * no-op; `node` is real only for the scripts under test.
 */
function startMiniatureMatrix(
  lockPath: string,
  label: string,
  {
    pre = 'true',
    observe = false,
    timeoutSeconds = '0',
  }: { observe?: boolean; pre?: string; timeoutSeconds?: string } = {},
) {
  const sandbox = createMatrixSandbox();
  // Outside the sandbox: anything written inside it dirties the frozen tree the
  // matrix checks, and the run refuses at the end for a reason that has nothing
  // to do with the lease.
  const observation = createScratch();
  mkdirSync(join(sandbox, '.github/scripts'), { recursive: true });
  writeFileSync(
    join(sandbox, '.github/scripts/run-security-scans.sh'),
    observe
      ? [
          '#!/usr/bin/env bash',
          `cat "${lockPath}.holders"/*.json > ${observation}/records.json 2>/dev/null`,
          `env -u NORTH_STAR_TEST_LOCK_HELD ${process.execPath} ${resolve(lockRunnerPath)} shared -- true > ${observation}/shared.out 2>&1`,
          `echo $? > ${observation}/shared.rc`,
          `env -u NORTH_STAR_TEST_LOCK_HELD ${process.execPath} ${resolve(lockRunnerPath)} exclusive -- true > ${observation}/exclusive.out 2>&1`,
          `echo $? > ${observation}/exclusive.rc`,
          'exit 0',
          '',
        ].join('\n')
      : '#!/usr/bin/env bash\nexit 0\n',
  );
  chmodSync(join(sandbox, '.github/scripts/run-security-scans.sh'), 0o755);
  execFileSync(
    'git',
    [
      '-C',
      sandbox,
      '-c',
      'user.email=lane@example.invalid',
      '-c',
      'user.name=lane',
      'add',
      '-A',
    ],
    { stdio: 'pipe' },
  );
  execFileSync(
    'git',
    [
      '-C',
      sandbox,
      '-c',
      'user.email=lane@example.invalid',
      '-c',
      'user.name=lane',
      'commit',
      '-q',
      '-m',
      'miniature matrix',
    ],
    { stdio: 'pipe' },
  );

  const run = startMatrixRun(
    sandbox,
    lockPath,
    label,
    pre,
    {
      corepack: 'exit 0\n',
      docker: 'exit 0\n',
      node:
        'case "$*" in\n' +
        `  *scripts/test-lock-registry.mjs*|*scripts/guard-ephemeral-postgres.mjs*) exec ${process.execPath} "$@" ;;\n` +
        '  *) exit 0 ;;\n' +
        'esac\n',
      ps: 'exit 0\n',
    },
    timeoutSeconds,
  );

  let stdout = '';
  let stderr = '';
  run.child.stdout.setEncoding('utf8');
  run.child.stderr.setEncoding('utf8');
  run.child.stdout.on('data', (chunk: string) => (stdout += chunk));
  run.child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const finished = once(run.child, 'exit').then(([code]) => ({
    status: code as number | null,
    stderr,
    stdout,
  }));

  return {
    child: run.child,
    cleanup: () => {
      run.cleanup();
      rmSync(observation, { force: true, recursive: true });
    },
    finished,
    readObservation: () => ({
      exclusiveProbe: readIfPresent(join(observation, 'exclusive.out')),
      exclusiveProbeStatus: readIfPresent(
        join(observation, 'exclusive.rc'),
      ).trim(),
      records: readIfPresent(join(observation, 'records.json')),
      sharedProbe: readIfPresent(join(observation, 'shared.out')),
      sharedProbeStatus: readIfPresent(join(observation, 'shared.rc')).trim(),
    }),
  };
}

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
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

function runMatrixWithFakeProcessTable(
  lockPath: string,
  rows: readonly string[],
) {
  const fakeBin = createFakeBin({
    docker: 'exit 0\n',
    ps: `cat <<'ROWS'\n${rows.join('\n')}\nROWS\n`,
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
 * Runs a real matrix and, while it holds the lock, queues a real wrapper behind
 * it. The process table it then sees carries three rows: an ancestor of the
 * queued wrapper, a descendant of it, and an unrelated sibling that shares the
 * wrapper's process group. Only the sibling may be blamed.
 */
async function withQueuedWrapperDuringMatrix(
  check: (
    matrix: { stderr: string; stdout: string },
    rows: {
      ancestorPid: number;
      descendantPid: number;
      siblingPid: number;
    },
  ) => Promise<void> | void,
): Promise<void> {
  const lockPath = uniqueLockPath('foreign-coordinated');
  const sandbox = createMatrixSandbox();
  const scratch = createScratch();
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
        // Bounded: an orphaned stub left behind by an interrupted control must
        // not spin forever on a release file whose directory is already gone.
        `  for _ in $(seq 1 600); do\n` +
        `    [ -e ${gate}.release ] && break\n` +
        `    sleep 0.05\n` +
        `  done\n` +
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
  let sibling: ChildProcess | undefined;
  try {
    await waitUntil(
      () => stdout.includes('ACQUIRED the lock.'),
      matrix.child,
      'the matrix never acquired the lock',
    );

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

    // Its flock child: a descendant of a recorded participant.
    let descendantPid: number | undefined;
    await waitUntil(
      () => (descendantPid = firstChildOf(queuedPid)) !== undefined,
      matrix.child,
      'the queued wrapper never spawned its flock child',
    );
    assert.ok(descendantPid !== undefined);

    // A sibling of the participant, sharing its process group but in no part of
    // its lineage.
    const siblingProcess = spawn(
      process.execPath,
      ['-e', 'process.stdin.resume()'],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
    sibling = siblingProcess;
    const siblingPid = siblingProcess.pid;
    assert.ok(siblingPid !== undefined);
    const ancestorPid = process.pid;
    assert.equal(
      readProcessGroup(siblingPid),
      readProcessGroup(queuedPid),
      'the sibling row must share the participant process group',
    );

    writeFileSync(
      processTable,
      [
        `${ancestorPid} ${readProcessGroup(ancestorPid)} corepack pnpm test:compiler`,
        `${descendantPid} ${readProcessGroup(descendantPid)} corepack pnpm test:unit`,
        `${siblingPid} ${readProcessGroup(siblingPid)} corepack pnpm test:agent`,
        '',
      ].join('\n'),
    );
    writeFileSync(`${gate}.release`, '');

    await waitUntil(
      () => matrix.child.exitCode !== null,
      undefined,
      'the matrix never finished its foreign-process check',
    );
    await check({ stderr, stdout }, { ancestorPid, descendantPid, siblingPid });
  } finally {
    for (const child of [queued, sibling]) {
      if (child === undefined) continue;
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    if (matrix.child.exitCode === null && matrix.child.signalCode === null) {
      matrix.child.kill('SIGKILL');
    }
    matrix.cleanup();
    rmSync(scratch, { force: true, recursive: true });
    removeLock(lockPath);
  }
}

function firstChildOf(pid: number): number | undefined {
  try {
    const children = readFileSync(
      `/proc/${pid}/task/${pid}/children`,
      'utf8',
    ).trim();
    if (children.length === 0) return undefined;
    const first = Number(children.split(/\s+/u)[0]);
    return Number.isSafeInteger(first) && first > 0 ? first : undefined;
  } catch {
    return undefined;
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

function killGroupQuietly(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone.
  }
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

function readProcessState(pid: number): string {
  const value = readProcessStatFields(pid)[0];
  assert.ok(value !== undefined);
  return value;
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

function readLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    stream.setEncoding('utf8');
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error('no line was emitted within 10000ms'));
    }, 10_000);
    const onData = (chunk: string) => {
      output += chunk;
      if (!output.includes('\n')) return;
      cleanup();
      resolvePromise(output.slice(0, output.indexOf('\n')));
    };
    function cleanup(): void {
      clearTimeout(deadline);
      stream.off('data', onData);
    }
    stream.on('data', onData);
  });
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
