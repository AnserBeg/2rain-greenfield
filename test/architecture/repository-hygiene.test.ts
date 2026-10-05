import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  globSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

const workflowPath = '.github/workflows/ci.yml';
const packagePath = 'package.json';
const testLockRunnerPath = 'scripts/run-with-test-lock.mjs';
const testLockDowngradePath = 'scripts/downgrade-test-lock.sh';
const suiteDefinitions = [
  {
    discoveryPattern: 'test/unit/**/*.test.ts',
    expectedFiles: [
      'test/unit/canonical-model/diagnostic-ordering.test.ts',
      'test/unit/canonical-model/disclosure-tier.test.ts',
      'test/unit/canonical-model/field-numbering.test.ts',
      'test/unit/canonical-model/negative-contracts.test.ts',
      'test/unit/canonical-model/normalization.test.ts',
      'test/unit/canonical-model/predicate-admission.test.ts',
      'test/unit/canonical-model/surface-composition.test.ts',
      'test/unit/canonical-model/surface-launcher.test.ts',
      'test/unit/canonical-model/surface-list.test.ts',
      'test/unit/catalog-definition.test.ts',
      'test/unit/catalog-extras.test.ts',
      'test/unit/commercial-amounts.test.ts',
      'test/unit/dev-environment.test.ts',
      'test/unit/inventory-definition.test.ts',
      'test/unit/inventory-valuation.test.ts',
      'test/unit/language-conformance-ledger.test.ts',
      'test/unit/location-definition.test.ts',
      'test/unit/module-provider-error-mappings.test.ts',
      'test/unit/observability.test.ts',
      'test/unit/party-definition.test.ts',
      'test/unit/purchasing-definition.test.ts',
      'test/unit/sales-definition.test.ts',
      'test/unit/web-surface-hex-literal-ratchet.test.ts',
      'test/unit/workspace-contract.test.ts',
    ],
    script: 'test:unit',
  },
  {
    discoveryPattern: 'test/compiler/**/*.test.ts',
    excludedFiles: ['test/compiler/performance-budget.test.ts'],
    expectedFiles: [
      'test/compiler/adopted-language-shape.test.ts',
      'test/compiler/compiler-semantic-profile.test.ts',
      'test/compiler/determinism.test.ts',
      'test/compiler/disclosure-tier-projection.test.ts',
      'test/compiler/field-kind-projection.test.ts',
      'test/compiler/freeze-b.test.ts',
      'test/compiler/g2-module-conformance.test.ts',
      'test/compiler/g2-module-storage.test.ts',
      'test/compiler/golden-vectors.test.ts',
      'test/compiler/legal-entity-query-scope.test.ts',
      'test/compiler/predicate-lowering.test.ts',
      'test/compiler/publish-path-breadth-envelope.test.ts',
      'test/compiler/relation-target-projection.test.ts',
    ],
    script: 'test:compiler',
  },
  {
    discoveryPattern: 'test/compiler/performance-budget.test.ts',
    expectedFiles: ['test/compiler/performance-budget.test.ts'],
    script: 'test:performance',
  },
  {
    discoveryPattern: 'test/integration/**/*.test.ts',
    expectedFiles: [
      'test/integration/catalog-runtime.test.ts',
      'test/integration/disclosure-tier-round-trip.test.ts',
      'test/integration/field-kind-round-trip.test.ts',
      'test/integration/location-runtime.test.ts',
      'test/integration/module-runtime.test.ts',
      'test/integration/module-storage-transition.test.ts',
      'test/integration/observability-ci-contract.test.ts',
      'test/integration/party-runtime.test.ts',
      'test/integration/security-scan-contract.test.ts',
      'test/integration/semantic-gateways.test.ts',
      'test/integration/semantic-query-legal-entity-scope.test.ts',
      'test/integration/surface-data-binding.test.ts',
      'test/integration/table-behavior.test.ts',
      'test/integration/toolchain-contract.test.ts',
      'test/integration/trust-substrate.test.ts',
    ],
    script: 'test:integration',
  },
  {
    discoveryPattern: 'test/architecture/**/*.test.ts',
    expectedFiles: [
      'test/architecture/canonical-contracts-purity.test.ts',
      'test/architecture/compiler-hermeticity.test.ts',
      'test/architecture/dependency-boundaries.test.ts',
      'test/architecture/evidence-on-demand.test.ts',
      'test/architecture/module-conformance-runtime.test.ts',
      'test/architecture/module-press-law.test.ts',
      'test/architecture/record-claim-fidelity.test.ts',
      'test/architecture/release-activation-boundary.test.ts',
      'test/architecture/release-persistence-boundary.test.ts',
      'test/architecture/repository-hygiene.test.ts',
      'test/architecture/request-runtime-view-boundary.test.ts',
      'test/architecture/surface-data-binding.test.ts',
      'test/architecture/surface-grammar-conformance.test.ts',
      'test/architecture/surface-runtime-seam.test.ts',
      'test/architecture/tenant-completeness.test.ts',
      'test/architecture/test-lock-observability.test.ts',
      'test/architecture/test-reachability.test.ts',
      'test/architecture/ux-grammar-skill.test.ts',
    ],
    script: 'test:architecture',
  },
  {
    discoveryPattern: 'test/agent/**/*.test.ts',
    expectedFiles: [
      'test/agent/catalog-discovery.test.ts',
      'test/agent/location-discovery.test.ts',
      'test/agent/party-discovery.test.ts',
    ],
    script: 'test:agent',
  },
  {
    discoveryPattern: 'test/postgres/**/*.test.ts',
    excludedFiles: [
      'test/postgres/composed-application.test.ts',
      'test/postgres/commercial-totals.test.ts',
      'test/postgres/expected-receipts.test.ts',
      'test/postgres/fulfillment.test.ts',
      'test/postgres/order-lists-supply.test.ts',
      'test/postgres/order-lists.test.ts',
      'test/postgres/order-pages.test.ts',
      'test/postgres/packing-retrieval.test.ts',
      'test/postgres/payables.test.ts',
      'test/postgres/purchase-order-ending.test.ts',
      'test/postgres/receivables.test.ts',
      'test/postgres/receiving-authorization.test.ts',
    ],
    expectedFiles: [
      'test/postgres/catalog-extras.test.ts',
      'test/postgres/catalog-runtime.test.ts',
      'test/postgres/current-policy.test.ts',
      'test/postgres/declared-list.test.ts',
      'test/postgres/document-numbering.test.ts',
      'test/postgres/inventory-backdate-policy.test.ts',
      'test/postgres/inventory-backup-restore.test.ts',
      'test/postgres/inventory-dimension-set-replay.test.ts',
      'test/postgres/inventory-documents.test.ts',
      'test/postgres/inventory-onhand.test.ts',
      'test/postgres/inventory-posting.test.ts',
      'test/postgres/inventory-reconciliation.test.ts',
      'test/postgres/inventory-stock-count.test.ts',
      'test/postgres/inventory-storage.test.ts',
      'test/postgres/inventory-terminal-state.test.ts',
      'test/postgres/inventory-valuation.test.ts',
      'test/postgres/item-stock.test.ts',
      'test/postgres/location-runtime.test.ts',
      'test/postgres/locations.test.ts',
      'test/postgres/migrations.test.ts',
      'test/postgres/module-index-conformance.test.ts',
      'test/postgres/module-runtime.test.ts',
      'test/postgres/module-storage-transition.test.ts',
      'test/postgres/observability-health.test.ts',
      'test/postgres/party-runtime.test.ts',
      'test/postgres/period-lock-commands.test.ts',
      'test/postgres/predicate-absent-semantics.test.ts',
      'test/postgres/predicate-parity-corpus.test.ts',
      'test/postgres/query-aggregate-semantics.test.ts',
      'test/postgres/query-filter-lowering.test.ts',
      'test/postgres/release-activation.test.ts',
      'test/postgres/release-approval.test.ts',
      'test/postgres/releases.test.ts',
      'test/postgres/replenishment.test.ts',
      'test/postgres/request-runtime-view.test.ts',
      'test/postgres/saved-filter.test.ts',
      'test/postgres/stock-serializer.test.ts',
      'test/postgres/storage-payload-family.test.ts',
      'test/postgres/table-behavior.test.ts',
      'test/postgres/tenant-isolation.test.ts',
      'test/postgres/trust-substrate.test.ts',
    ],
    script: 'test:postgres',
  },
  {
    discoveryPattern: 'test/postgres/composed-application.test.ts',
    expectedFiles: ['test/postgres/composed-application.test.ts'],
    script: 'test:postgres:composed',
  },
  {
    discoveryPattern:
      'test/postgres/**/@(commercial-totals|expected-receipts|fulfillment|order-lists|order-lists-supply|order-pages|packing-retrieval|payables|purchase-order-ending|receivables|receiving-authorization).test.ts',
    expectedFiles: [
      'test/postgres/commercial-totals.test.ts',
      'test/postgres/expected-receipts.test.ts',
      'test/postgres/fulfillment.test.ts',
      'test/postgres/order-lists-supply.test.ts',
      'test/postgres/order-lists.test.ts',
      'test/postgres/order-pages.test.ts',
      'test/postgres/packing-retrieval.test.ts',
      'test/postgres/payables.test.ts',
      'test/postgres/purchase-order-ending.test.ts',
      'test/postgres/receivables.test.ts',
      'test/postgres/receiving-authorization.test.ts',
    ],
    script: 'test:postgres:commercial',
  },
] as const;

interface ShellToken {
  readonly quoted: boolean;
  readonly value: string;
}

function gitFiles(arguments_: readonly string[]): string[] {
  return execFileSync('git', [...arguments_], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .sort();
}

test('tracked files exclude local, generated, and alternate-toolchain artifacts', () => {
  const trackedFiles = gitFiles(['ls-files', '-z']);
  const forbiddenDirectories = new Set([
    'build',
    'coverage',
    'dist',
    'node_modules',
    'playwright-report',
    'test-results',
    'tmp',
  ]);
  const alternateLockfiles = new Set([
    'bun.lock',
    'bun.lockb',
    'npm-shrinkwrap.json',
    'package-lock.json',
    'yarn.lock',
  ]);

  const forbidden = trackedFiles.filter((path) => {
    const segments = path.split('/');
    const basename = segments.at(-1) ?? '';
    if (segments.some((segment) => forbiddenDirectories.has(segment))) {
      return true;
    }
    if (alternateLockfiles.has(basename)) return true;
    if (/^\.env(?:\.|$)/u.test(basename)) {
      return !/^\.env\.(?:example|template)$/u.test(basename);
    }
    return (
      basename === '.DS_Store' ||
      basename.endsWith('.local') ||
      basename.endsWith('.log') ||
      basename.endsWith('.db') ||
      basename.endsWith('.db-shm') ||
      basename.endsWith('.db-wal') ||
      basename.endsWith('.tsbuildinfo')
    );
  });

  assert.deepEqual(forbidden, []);
});

test('no ignored artifact is force-added to the repository', () => {
  const ignoredTrackedFiles = gitFiles([
    'ls-files',
    '--cached',
    '--ignored',
    '--exclude-standard',
    '-z',
  ]);

  assert.deepEqual(ignoredTrackedFiles, []);
});

test('suite commands exactly cover all independently discovered test files', () => {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = packageJson.scripts ?? {};

  for (const suite of suiteDefinitions) {
    const command = scripts[suite.script];
    assert.ok(command, `package.json is missing ${suite.script}`);

    const excludedFiles = new Set<string>(
      'excludedFiles' in suite ? suite.excludedFiles : [],
    );
    const discoveredFiles = globSync(suite.discoveryPattern)
      .filter((path) => !excludedFiles.has(path))
      .sort();
    assert.ok(
      discoveredFiles.length > 0,
      `${suite.discoveryPattern} discovered no tests`,
    );
    assert.deepEqual(
      discoveredFiles,
      [...suite.expectedFiles],
      `${suite.discoveryPattern} diverges from its reviewed inventory`,
    );

    const commandFiles = shellTokens(command)
      .filter((token) => /\.(?:spec|test)\.ts$/u.test(token.value))
      .flatMap((token) =>
        containsGlob(token.value) ? globSync(token.value) : [token.value],
      )
      .sort();
    assert.ok(commandFiles.length > 0, `${suite.script} reaches no tests`);
    assert.deepEqual(
      [...new Set(commandFiles)],
      discoveredFiles,
      `${suite.script} diverges from ${suite.discoveryPattern}`,
    );
  }
});

test('every test-script glob is quoted before the shell can expand it', () => {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    scripts?: Record<string, string>;
  };

  // globSync sees the intended pattern, but an unquoted shell glob is mangled
  // before Node starts. The raw script string is the only place to catch it.
  for (const [script, command] of Object.entries(packageJson.scripts ?? {})) {
    if (!script.startsWith('test:')) continue;
    for (const token of shellTokens(command).filter((candidate) =>
      containsGlob(candidate.value),
    )) {
      assert.equal(
        token.quoted,
        true,
        `${script} has an unquoted glob: ${token.value}`,
      );
    }
  }
});

test('test entry points participate in the shared/exclusive gate lock', () => {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const webPackageJson = JSON.parse(
    readFileSync('apps/web/package.json', 'utf8'),
  ) as { scripts?: Record<string, string> };
  const rootScripts = packageJson.scripts ?? {};
  // Which mode each entry point is entitled to is derived from whether it
  // stands up containers, in test-lock-observability.test.ts. This asserts the
  // WHOLE entry point is inside the lease. The previous regex accepted a
  // wrapper anywhere, which admitted exactly the prefixes and suffixes that
  // were running unleased: evidence preparation, which deletes the files, and
  // playwright normalization, which rewrites them.
  for (const [script, command] of Object.entries(rootScripts)) {
    if (!script.startsWith('test:')) continue;
    assert.match(
      command,
      new RegExp(
        `^node ${testLockRunnerPath.replaceAll('.', '\\.')}` +
          ` (?:shared|exclusive) -- `,
        'u',
      ),
      `${script} runs work before it acquires the test lock`,
    );
    if (command.includes('scripts/run-suite.sh')) {
      assert.match(
        command,
        /-- bash scripts\/run-suite\.sh \S+(?: --normalize-playwright)? -- \S/u,
        `${script} does not run its whole suite through the leased runner`,
      );
    }
  }
  // Anchored for the same reason as the root scripts: an unanchored match
  // accepted a wrapper anywhere in the string, and this entry point ran its
  // evidence preparation — which deletes the files — before it.
  assert.match(
    webPackageJson.scripts?.['test:contracts'] ?? '',
    /^node \.\.\/\.\.\/scripts\/run-with-test-lock\.mjs shared -- /u,
    'the workspace-local contracts entry point runs work before it locks',
  );

  const matrixRunner = readFileSync('scripts/run-matrix.sh', 'utf8');
  // The lease a child inherits is a minted claim, not a bare mode word: the
  // child validates it against the registry before honouring it.
  assert.match(
    matrixRunner,
    /mint_claim exclusive\nexport NORTH_STAR_TEST_LOCK_HELD="\$MATRIX_CLAIM"/u,
  );
  assert.match(
    matrixRunner,
    /bash scripts\/downgrade-test-lock\.sh "\$LOCK" "\$LOCK_TIMEOUT_SECONDS" 9/u,
  );
  assert.match(
    matrixRunner,
    /mint_claim shared\nexport NORTH_STAR_TEST_LOCK_HELD="\$MATRIX_CLAIM"/u,
  );
  assert.ok(
    matrixRunner.indexOf('corepack pnpm test:performance') <
      matrixRunner.indexOf('# The main matrix deliberately excludes'),
    'the exclusive performance gate must run before the main matrix',
  );
  assert.equal(
    matrixRunner.match(/corepack pnpm test:performance/gu)?.length,
    1,
    'the matrix runner must invoke the separated performance gate exactly once',
  );
  assert.doesNotMatch(
    matrixRunner,
    /^\s*corepack pnpm test\s*(?:&&|$)/mu,
    'the main matrix must not re-enter the aggregate that includes performance',
  );
});

test('shared gate holders coexist and exclude an exclusive gate', async () => {
  const lockPath = `/tmp/north-star-test-lock-control-${process.pid}`;
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.NORTH_STAR_TEST_LOCK_HELD;
  const environment = {
    ...baseEnvironment,
    NORTH_STAR_TEST_LOCK_PATH: lockPath,
    NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS: '0',
  };
  const holder = spawn(
    process.execPath,
    [
      testLockRunnerPath,
      'shared',
      '--',
      process.execPath,
      '-e',
      "process.stdout.write('LOCK_READY\\n'); process.stdin.resume()",
    ],
    { env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let holderError = '';
  holder.stderr.setEncoding('utf8');
  holder.stderr.on('data', (chunk: string) => {
    holderError += chunk;
  });
  await waitForOutput(holder.stdout, 'LOCK_READY');

  try {
    const sharedOutput = execFileSync(
      process.execPath,
      [
        testLockRunnerPath,
        'shared',
        '--',
        process.execPath,
        '-e',
        "process.stdout.write('SHARED_ADMITTED')",
      ],
      { encoding: 'utf8', env: environment },
    );
    assert.equal(sharedOutput, 'SHARED_ADMITTED');
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            testLockRunnerPath,
            'exclusive',
            '--',
            process.execPath,
            '-e',
            "process.stdout.write('EXCLUSIVE_WRONGLY_ADMITTED')",
          ],
          { encoding: 'utf8', env: environment },
        ),
      (error: unknown) =>
        error instanceof Error &&
        'stderr' in error &&
        String(error.stderr).includes('TEST_GATE_LOCK_BUSY'),
    );
  } finally {
    holder.stdin.end();
    const [exitCode] = (await once(holder, 'exit')) as [number | null];
    assert.equal(exitCode, 0, holderError);
  }

  const exclusiveOutput = execFileSync(
    process.execPath,
    [
      testLockRunnerPath,
      'exclusive',
      '--',
      process.execPath,
      '-e',
      "process.stdout.write('EXCLUSIVE_ADMITTED')",
    ],
    { encoding: 'utf8', env: environment },
  );
  assert.equal(exclusiveOutput, 'EXCLUSIVE_ADMITTED');
});

test('matrix lock and legacy-process waits fail busy at their bounded deadline', () => {
  const lockPath = `/tmp/north-star-matrix-lock-control-${process.pid}`;
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.NORTH_STAR_TEST_LOCK_HELD;
  const environment = {
    ...baseEnvironment,
    NORTH_STAR_TEST_LOCK_PATH: lockPath,
    NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS: '0',
  };
  const holder = spawn(
    process.execPath,
    [
      testLockRunnerPath,
      'shared',
      '--',
      process.execPath,
      '-e',
      "process.stdout.write('LOCK_READY\\n'); process.stdin.resume()",
    ],
    { env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  return waitForOutput(holder.stdout, 'LOCK_READY')
    .then(() => {
      assert.throws(
        () =>
          execFileSync(
            'bash',
            ['scripts/run-matrix.sh', 'LOCK-CONTROL', process.cwd()],
            { encoding: 'utf8', env: environment },
          ),
        (error: unknown) =>
          commandFailedWith(error, 'TEST_GATE_LOCK_BUSY: exclusive access'),
      );
    })
    .finally(async () => {
      holder.stdin.end();
      const [exitCode] = (await once(holder, 'exit')) as [number | null];
      assert.equal(exitCode, 0);
      rmSync(lockPath, { force: true });
    })
    .then(() => {
      const fakeBin = mkdtempSync(join(tmpdir(), 'north-star-fake-ps-'));
      try {
        const fakePs = join(fakeBin, 'ps');
        writeFileSync(
          fakePs,
          "#!/usr/bin/env bash\nprintf '9999999 9999999 corepack pnpm test:compiler\\n'\n",
        );
        chmodSync(fakePs, 0o755);
        assert.throws(
          () =>
            execFileSync(
              'bash',
              ['scripts/run-matrix.sh', 'FOREIGN-CONTROL', process.cwd()],
              {
                encoding: 'utf8',
                env: { ...environment, PATH: `${fakeBin}:${process.env.PATH}` },
              },
            ),
          (error: unknown) =>
            commandFailedWith(
              error,
              'TEST_GATE_LOCK_BUSY: a lock-unaware test process remained active',
            ),
        );
      } finally {
        rmSync(fakeBin, { force: true, recursive: true });
        rmSync(lockPath, { force: true });
      }
    });
});

test('matrix lock conversion fails busy at its bounded deadline', async () => {
  const lockPath = `/tmp/north-star-matrix-conversion-control-${process.pid}`;
  const owner = spawn(
    'bash',
    [
      '-c',
      [
        'exec 9>"$1"',
        'flock --exclusive 9',
        "printf 'CONVERSION_OWNER_READY\\n'",
        'IFS= read -r _',
        'flock --unlock 9',
        "printf 'CONVERSION_WINDOW_OPEN\\n'",
        'IFS= read -r _',
        'exec bash "$2" "$1" 0 9',
      ].join('; '),
      'matrix-conversion-owner',
      lockPath,
      testLockDowngradePath,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let ownerError = '';
  owner.stderr.setEncoding('utf8');
  owner.stderr.on('data', (chunk: string) => {
    ownerError += chunk;
  });
  let contender: typeof owner | undefined;

  try {
    await waitForOutput(owner.stdout, 'CONVERSION_OWNER_READY');
    contender = spawn(
      'flock',
      [
        '--no-fork',
        '--exclusive',
        lockPath,
        process.execPath,
        '-e',
        "process.stdout.write('CONTENDER_ACQUIRED\\n'); process.stdin.resume()",
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    assert.ok(contender.pid !== undefined);
    await waitForKernelLockWait(contender.pid);

    const conversionWindow = waitForOutput(
      owner.stdout,
      'CONVERSION_WINDOW_OPEN',
    );
    const contenderAcquired = waitForOutput(
      contender.stdout,
      'CONTENDER_ACQUIRED',
    );
    owner.stdin.write('RELEASE\n');
    await Promise.all([conversionWindow, contenderAcquired]);

    const ownerClosed = waitForProcessClose(owner, 1_000);
    owner.stdin.end('CONVERT\n');
    const [exitCode, signal] = await ownerClosed;
    assert.equal(signal, null);
    assert.equal(exitCode, 75);
    assert.match(
      ownerError,
      /TEST_GATE_LOCK_BUSY: shared conversion .* was unavailable for 0s/u,
    );
  } finally {
    owner.stdin.destroy();
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill('SIGTERM');
    }
    if (contender !== undefined) {
      const contenderClosed = waitForProcessClose(contender, 1_000);
      contender.stdin.end();
      const [exitCode] = await contenderClosed;
      assert.equal(exitCode, 0);
    }
    rmSync(lockPath, { force: true });
  }
});

test('lock-holder readiness has a bounded failure instead of hanging', async () => {
  const silentStream = new PassThrough();
  await assert.rejects(
    waitForOutput(silentStream, 'NEVER_EMITTED', 0),
    /stream did not emit NEVER_EMITTED within 0ms/u,
  );
  silentStream.destroy();
});

test('CI runs every scaffold gate from a frozen install', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const requiredCommands = [
    'corepack pnpm install --frozen-lockfile --reporter=append-only',
    'corepack pnpm format',
    'corepack pnpm lint',
    'corepack pnpm typecheck',
    'corepack pnpm build',
    'corepack pnpm test:unit',
    'corepack pnpm test:compiler',
    'corepack pnpm test:performance',
    'corepack pnpm test:integration',
    'corepack pnpm test:agent',
    'corepack pnpm test:architecture',
    'corepack pnpm check:demo-release',
    'corepack pnpm test:contracts',
    'corepack pnpm check:schema',
    'corepack pnpm test:postgres',
    'corepack pnpm test:postgres:composed',
    'corepack pnpm test:postgres:commercial',
    'corepack pnpm test:locale',
    'corepack pnpm test:browser',
    'corepack pnpm test:browser:operations',
    'corepack pnpm test:browser:composed',
    'corepack pnpm check:reachability',
  ];

  for (const command of requiredCommands) {
    assert.ok(workflow.includes(command), `CI is missing: ${command}`);
  }
  assert.match(workflow, /^permissions:\n {2}contents: read$/mu);
  assert.match(workflow, /^ {2}quality:$/mu);
  assert.match(workflow, /^ {2}performance:$/mu);
  assert.match(workflow, /^ {2}postgres:$/mu);
  assert.match(workflow, /^ {2}postgres-composed:$/mu);
  assert.match(workflow, /^ {2}postgres-commercial:$/mu);
  assert.match(workflow, /^ {2}browser:$/mu);
  assert.match(workflow, /^ {2}browser-operations:$/mu);
  assert.match(workflow, /^ {2}browser-composed:$/mu);
  assert.match(workflow, /uses: actions\/upload-artifact@/u);
  assert.match(workflow, /retention-days: 7/u);
});

function shellTokens(command: string): readonly ShellToken[] {
  return [...command.matchAll(/"([^"]+)"|'([^']+)'|([^\s"';&|]+)/gu)].map(
    (match) => ({
      quoted: match[1] !== undefined || match[2] !== undefined,
      value: match[1] ?? match[2] ?? match[3] ?? '',
    }),
  );
}

function containsGlob(value: string): boolean {
  return value.includes('*') || value.includes('?') || value.includes('[');
}

function waitForOutput(
  stream: NodeJS.ReadableStream,
  expected: string,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
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
      reject(new Error(`stream ended before emitting ${expected}`));
    };
    const onData = (chunk: string) => {
      output += chunk;
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(deadline);
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('end', onEnd);
    };
    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('end', onEnd);
  });
}

function waitForKernelLockWait(
  processId: number,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(poll);
      reject(
        new Error(
          `process ${processId} did not enter the kernel lock wait within ${timeoutMilliseconds}ms`,
        ),
      );
    }, timeoutMilliseconds);
    const poll = setInterval(() => {
      let waitChannel = '';
      try {
        waitChannel = readFileSync(`/proc/${processId}/wchan`, 'utf8').trim();
      } catch {
        // The deadline reports a process that exits before reaching the wait.
      }
      if (waitChannel === 'locks_lock_inode_wait') {
        clearTimeout(deadline);
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });
}

function waitForProcessClose(
  child: ReturnType<typeof spawn>,
  timeoutMilliseconds: number,
): Promise<readonly [number | null, NodeJS.Signals | null]> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `process ${child.pid ?? 'unknown'} did not close within ${timeoutMilliseconds}ms`,
        ),
      );
    }, timeoutMilliseconds);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve([code, signal] as const);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(deadline);
      child.off('close', onClose);
      child.off('error', onError);
    };
    child.once('close', onClose);
    child.once('error', onError);
  });
}

function commandFailedWith(error: unknown, expected: string): boolean {
  return (
    error instanceof Error &&
    'status' in error &&
    error.status === 75 &&
    'stderr' in error &&
    String(error.stderr).includes(expected)
  );
}

test('CI third-party actions use immutable commit refs', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const actionUses = [
    ...workflow.matchAll(/^\s*uses:\s*([^@\s]+)@([^\s#]+)/gmu),
  ];

  assert.ok(actionUses.length > 0, 'CI declares no third-party actions');
  for (const use of actionUses) {
    const action = use[1] ?? 'unknown action';
    const ref = use[2] ?? '';
    assert.match(ref, /^[0-9a-f]{40}$/u, `${action} must use a commit SHA`);
  }
});
