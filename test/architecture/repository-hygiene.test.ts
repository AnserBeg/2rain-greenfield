import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import test from 'node:test';

const workflowPath = '.github/workflows/ci.yml';
const packagePath = 'package.json';
const expectedUnitTestFiles = [
  'test/unit/canonical-model/diagnostic-ordering.test.ts',
  'test/unit/canonical-model/negative-contracts.test.ts',
  'test/unit/canonical-model/normalization.test.ts',
  'test/unit/observability.test.ts',
  'test/unit/party-definition.test.ts',
  'test/unit/workspace-contract.test.ts',
] as const;

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

test('unit test command explicitly covers the complete discovered file set', () => {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const unitCommand = packageJson.scripts?.['test:unit'];
  assert.ok(unitCommand, 'package.json is missing test:unit');

  const discoveredFiles = globSync('test/unit/**/*.test.ts').sort();
  const commandFiles = [
    ...unitCommand.matchAll(/test\/unit\/[^\s"]+\.test\.ts/gu),
  ]
    .map((match) => match[0])
    .sort();

  assert.equal(discoveredFiles.length, 6);
  assert.deepEqual(discoveredFiles, [...expectedUnitTestFiles]);
  assert.deepEqual(commandFiles, discoveredFiles);
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
    'corepack pnpm check:schema',
    'corepack pnpm test:postgres',
    'corepack pnpm test:locale',
    'corepack pnpm test:browser',
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
