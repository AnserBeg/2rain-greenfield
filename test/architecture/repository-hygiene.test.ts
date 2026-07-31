import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import test from 'node:test';

const workflowPath = '.github/workflows/ci.yml';
const packagePath = 'package.json';
const suiteDefinitions = [
  {
    discoveryPattern: 'test/unit/**/*.test.ts',
    expectedFiles: [
      'test/unit/canonical-model/diagnostic-ordering.test.ts',
      'test/unit/canonical-model/negative-contracts.test.ts',
      'test/unit/canonical-model/normalization.test.ts',
      'test/unit/canonical-model/predicate-admission.test.ts',
      'test/unit/catalog-definition.test.ts',
      'test/unit/location-definition.test.ts',
      'test/unit/observability.test.ts',
      'test/unit/party-definition.test.ts',
      'test/unit/workspace-contract.test.ts',
    ],
    script: 'test:unit',
  },
  {
    discoveryPattern: 'test/compiler/**/*.test.ts',
    expectedFiles: [
      'test/compiler/determinism.test.ts',
      'test/compiler/freeze-b.test.ts',
      'test/compiler/g2-module-conformance.test.ts',
      'test/compiler/g2-module-storage.test.ts',
      'test/compiler/golden-vectors.test.ts',
      'test/compiler/legal-entity-query-scope.test.ts',
      'test/compiler/performance-budget.test.ts',
      'test/compiler/predicate-lowering.test.ts',
      'test/compiler/publish-path-breadth-envelope.test.ts',
    ],
    script: 'test:compiler',
  },
  {
    discoveryPattern: 'test/integration/**/*.test.ts',
    expectedFiles: [
      'test/integration/catalog-runtime.test.ts',
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
      'test/architecture/module-conformance-runtime.test.ts',
      'test/architecture/module-press-law.test.ts',
      'test/architecture/release-activation-boundary.test.ts',
      'test/architecture/release-persistence-boundary.test.ts',
      'test/architecture/repository-hygiene.test.ts',
      'test/architecture/request-runtime-view-boundary.test.ts',
      'test/architecture/surface-data-binding.test.ts',
      'test/architecture/surface-grammar-conformance.test.ts',
      'test/architecture/surface-runtime-seam.test.ts',
      'test/architecture/tenant-completeness.test.ts',
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
    expectedFiles: [
      'test/postgres/catalog-runtime.test.ts',
      'test/postgres/composed-application.test.ts',
      'test/postgres/inventory-posting.test.ts',
      'test/postgres/inventory-stock-count.test.ts',
      'test/postgres/inventory-storage.test.ts',
      'test/postgres/inventory-terminal-state.test.ts',
      'test/postgres/location-runtime.test.ts',
      'test/postgres/migrations.test.ts',
      'test/postgres/module-index-conformance.test.ts',
      'test/postgres/module-runtime.test.ts',
      'test/postgres/module-storage-transition.test.ts',
      'test/postgres/observability-health.test.ts',
      'test/postgres/party-runtime.test.ts',
      'test/postgres/predicate-absent-semantics.test.ts',
      'test/postgres/predicate-parity-corpus.test.ts',
      'test/postgres/query-aggregate-semantics.test.ts',
      'test/postgres/query-filter-lowering.test.ts',
      'test/postgres/release-activation.test.ts',
      'test/postgres/release-approval.test.ts',
      'test/postgres/releases.test.ts',
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

    const discoveredFiles = globSync(suite.discoveryPattern).sort();
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
    'corepack pnpm test:integration',
    'corepack pnpm test:agent',
    'corepack pnpm test:architecture',
    'corepack pnpm check:demo-release',
    'corepack pnpm test:contracts',
    'corepack pnpm check:schema',
    'corepack pnpm test:postgres',
    'corepack pnpm test:locale',
    'corepack pnpm test:browser',
    'corepack pnpm check:reachability',
  ];

  for (const command of requiredCommands) {
    assert.ok(workflow.includes(command), `CI is missing: ${command}`);
  }
  assert.match(workflow, /^permissions:\n {2}contents: read$/mu);
  assert.match(workflow, /^ {2}quality:$/mu);
  assert.match(workflow, /^ {2}postgres:$/mu);
  assert.match(workflow, /^ {2}browser:$/mu);
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
