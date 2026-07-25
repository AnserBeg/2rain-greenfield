import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

interface PackageScripts {
  readonly cwd: string;
  readonly scripts: Readonly<Record<string, string>>;
}

interface ScriptCatalog {
  readonly root: PackageScripts;
  readonly web: PackageScripts;
}

interface ShellWord {
  readonly quoted: boolean;
  readonly value: string;
}

interface ReachabilityState {
  readonly catalog: ScriptCatalog;
  readonly ciRootScripts: Set<string>;
  readonly reachableTests: Set<string>;
  readonly resolvingScripts: Set<string>;
}

const workflowPath = '.github/workflows/ci.yml';
const repositoryGlobExcludes = [
  '.git/**',
  'dist/**',
  '**/dist/**',
  'node_modules/**',
  '**/node_modules/**',
] as const;
const rootScriptCiAllowlist = {
  'check:boundaries':
    'transitively enforced by test/architecture/dependency-boundaries.test.ts',
  test: 'developer aggregate for running the CI test commands locally',
} as const;
const knownNonTestScriptCommands = new Set([
  'eslint .',
  'node --import tsx scripts/compile-demo-release.ts --check',
  'node --import tsx test/helpers/check-schema.ts',
  'prettier --check .',
  'tsc --project tsconfig.build.json',
  'tsc --project tsconfig.json --noEmit',
]);
const repositoryCleanlinessBlock = [
  'if [[ -n "$BASE_SHA" ]]; then',
  'git diff --check "$BASE_SHA...HEAD"',
  'else',
  'git show --check --format= HEAD',
  'fi',
  'git diff --exit-code',
  'test -z "$(git status --porcelain --untracked-files=all)"',
].join('\n');

test('comparison canary reports exactly an unreachable synthetic test', () => {
  const unreachable = findUnreachableTests(
    new Set(['test/reachable.test.ts', 'test/orphan-demo/orphan.test.ts']),
    new Set(['test/reachable.test.ts']),
  );

  assert.deepEqual(unreachable, ['test/orphan-demo/orphan.test.ts']);
});

test('parser canary fails closed on an unknown script body', () => {
  const state = createState(loadScriptCatalog());

  assert.throws(
    () =>
      parseScriptBody(
        'future-test-runner --all',
        '',
        'synthetic script body',
        state,
      ),
    /Unparsed synthetic script body: future-test-runner --all/u,
  );
});

test('every repository test file is reachable from a CI-invoked command', () => {
  const discoveredTests = discoverRepositoryTests();
  const { reachableTests } = deriveCiReachability(
    readFileSync(workflowPath, 'utf8'),
    loadScriptCatalog(),
  );
  const unreachable = findUnreachableTests(discoveredTests, reachableTests);

  assert.ok(discoveredTests.size > 0, 'repository discovery found no tests');
  assert.deepEqual(
    unreachable,
    [],
    `Test files not reachable from CI: ${unreachable.join(', ')}`,
  );
});

test('every root test/check script is CI-invoked or explicitly justified', () => {
  const catalog = loadScriptCatalog();
  const { ciRootScripts } = deriveCiReachability(
    readFileSync(workflowPath, 'utf8'),
    catalog,
  );
  const governedScripts = Object.keys(catalog.root.scripts)
    .filter(
      (script) =>
        script === 'test' ||
        script.startsWith('test:') ||
        script.startsWith('check:'),
    )
    .sort();
  const scriptsOutsideCi = governedScripts
    .filter((script) => !ciRootScripts.has(script))
    .sort();

  assert.deepEqual(scriptsOutsideCi, Object.keys(rootScriptCiAllowlist).sort());
  for (const [script, justification] of Object.entries(rootScriptCiAllowlist)) {
    assert.ok(
      catalog.root.scripts[script],
      `allowlisted script is absent: ${script}`,
    );
    assert.ok(
      justification.length > 0,
      `allowlisted script lacks a reason: ${script}`,
    );
  }
});

test('root test aggregate includes every CI-invoked test command and demo check', () => {
  const catalog = loadScriptCatalog();
  const { ciRootScripts } = deriveCiReachability(
    readFileSync(workflowPath, 'utf8'),
    catalog,
  );
  const requiredAggregateScripts = [...ciRootScripts]
    .filter(
      (script) => script.startsWith('test:') || script === 'check:demo-release',
    )
    .sort();
  const aggregate = catalog.root.scripts.test;
  assert.ok(aggregate, 'package.json is missing the root test aggregate');

  assert.deepEqual(parseAggregateScripts(aggregate), requiredAggregateScripts);
});

export function findUnreachableTests(
  discoveredTests: ReadonlySet<string>,
  reachableTests: ReadonlySet<string>,
): string[] {
  return [...discoveredTests]
    .filter((path) => !reachableTests.has(path))
    .sort();
}

function discoverRepositoryTests(): Set<string> {
  return new Set(
    [
      ...globSync('**/*.test.ts', { exclude: repositoryGlobExcludes }),
      ...globSync('**/*.spec.ts', { exclude: repositoryGlobExcludes }),
    ]
      .map(normalizeRepositoryPath)
      .sort(),
  );
}

function loadScriptCatalog(): ScriptCatalog {
  return {
    root: loadPackageScripts('package.json', ''),
    web: loadPackageScripts('apps/web/package.json', 'apps/web'),
  };
}

function loadPackageScripts(path: string, cwd: string): PackageScripts {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.ok(manifest.scripts, `${path} is missing scripts`);
  return { cwd, scripts: manifest.scripts };
}

function createState(catalog: ScriptCatalog): ReachabilityState {
  return {
    catalog,
    ciRootScripts: new Set(),
    reachableTests: new Set(),
    resolvingScripts: new Set(),
  };
}

function deriveCiReachability(
  workflow: string,
  catalog: ScriptCatalog,
): Pick<ReachabilityState, 'ciRootScripts' | 'reachableTests'> {
  const state = createState(catalog);
  const runBodies = extractWorkflowRunBodies(workflow);
  assert.ok(runBodies.length > 0, 'CI workflow declares no run steps');

  for (const body of runBodies) parseCiRunBody(body, state);
  return state;
}

function extractWorkflowRunBodies(workflow: string): string[] {
  const lines = workflow.split(/\r?\n/u);
  const bodies: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /^(\s*)run:\s*(.*)$/u.exec(line);
    if (!match) continue;
    const indentation = match[1]?.length ?? 0;
    const value = match[2] ?? '';
    if (value === '') {
      const nested = lines[index + 1] ?? '';
      const nestedIndentation = /^\s*/u.exec(nested)?.[0].length ?? 0;
      if (nested.trim() !== 'shell: bash' || nestedIndentation <= indentation) {
        failUnparsed('CI run mapping', line.trim());
      }
      index += 1;
      continue;
    }
    if (value && value !== '|') {
      bodies.push(value.trim());
      continue;
    }

    const block: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? '';
      const nextIndentation = /^\s*/u.exec(next)?.[0].length ?? 0;
      if (next.trim() && nextIndentation <= indentation) break;
      index += 1;
      block.push(next.slice(indentation + 2).trimEnd());
    }
    bodies.push(block.join('\n').trim());
  }

  return bodies;
}

function parseCiRunBody(body: string, state: ReachabilityState): void {
  const logicalLines = joinShellContinuations(body);
  const normalizedBody = logicalLines.join('\n');
  if (logicalLines[0]?.startsWith('if [[')) {
    if (normalizedBody !== repositoryCleanlinessBlock) {
      failUnparsed('CI run block', normalizedBody);
    }
    return;
  }

  for (const line of logicalLines) {
    if (
      line === 'corepack enable' ||
      line ===
        'corepack pnpm install --frozen-lockfile --reporter=append-only' ||
      line === 'corepack pnpm exec playwright install --with-deps chromium' ||
      line === 'mkdir -p test-results/observability' ||
      line === '.github/scripts/run-security-scans.sh'
    ) {
      continue;
    }
    if (line.startsWith('corepack pnpm ')) {
      parsePnpmInvocation(line, 'CI pnpm invocation', state);
      continue;
    }
    const inlineTest =
      /^(node --import tsx --test .+?)(?: \| tee ([\w./-]+))?$/u.exec(line);
    if (inlineTest?.[1]) {
      parseNodeTestCommand(inlineTest[1], '', 'CI inline Node test', state);
      continue;
    }
    failUnparsed('CI command', line);
  }
}

function joinShellContinuations(body: string): string[] {
  const logicalLines: string[] = [];
  let pending = '';

  for (const sourceLine of body.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line) continue;
    if (line.endsWith('\\')) {
      pending += `${line.slice(0, -1).trimEnd()} `;
      continue;
    }
    logicalLines.push(`${pending}${line}`);
    pending = '';
  }
  if (pending) failUnparsed('continued CI command', pending.trim());
  return logicalLines;
}

function parsePnpmInvocation(
  command: string,
  context: string,
  state: ReachabilityState,
): void {
  const words = tokenizeShell(command).map((word) => word.value);
  if (words[0] !== 'corepack' || words[1] !== 'pnpm') {
    failUnparsed(context, command);
  }
  if (
    words.length === 5 &&
    words[2] === '--filter' &&
    words[3] === '@north-star/web' &&
    words[4]
  ) {
    resolvePackageScript('web', words[4], state);
    return;
  }
  if (words.length === 3 && words[2]) {
    state.ciRootScripts.add(words[2]);
    resolvePackageScript('root', words[2], state);
    return;
  }
  failUnparsed(context, command);
}

function resolvePackageScript(
  packageName: keyof ScriptCatalog,
  scriptName: string,
  state: ReachabilityState,
): void {
  const key = `${packageName}:${scriptName}`;
  if (state.resolvingScripts.has(key)) {
    throw new Error(`Recursive package script: ${key}`);
  }
  const packageScripts = state.catalog[packageName];
  const body = packageScripts.scripts[scriptName];
  if (!body) throw new Error(`Missing package script: ${key}`);

  state.resolvingScripts.add(key);
  try {
    parseScriptBody(body, packageScripts.cwd, `${key} script body`, state);
  } finally {
    state.resolvingScripts.delete(key);
  }
}

function parseScriptBody(
  body: string,
  cwd: string,
  context: string,
  state: ReachabilityState,
): void {
  if (body.includes('\n') || body.includes(';') || body.includes('||')) {
    failUnparsed(context, body);
  }
  for (const command of body.split(' && ')) {
    if (knownNonTestScriptCommands.has(command)) continue;
    if (command.startsWith('corepack pnpm ')) {
      parsePnpmInvocation(command, context, state);
      continue;
    }
    if (command.startsWith('node --import tsx --test ')) {
      parseNodeTestCommand(command, cwd, context, state);
      continue;
    }
    if (command.startsWith('playwright test ')) {
      parsePlaywrightCommand(command, cwd, context, state);
      continue;
    }
    failUnparsed(context, command);
  }
}

function parseNodeTestCommand(
  command: string,
  cwd: string,
  context: string,
  state: ReachabilityState,
): void {
  const words = tokenizeShell(command);
  if (
    words[0]?.value !== 'node' ||
    words[1]?.value !== '--import' ||
    words[2]?.value !== 'tsx' ||
    words[3]?.value !== '--test'
  ) {
    failUnparsed(context, command);
  }

  let targetCount = 0;
  for (const word of words.slice(4)) {
    if (word.value.startsWith('--test-name-pattern=')) continue;
    if (!/\.(?:spec|test)\.ts$/u.test(word.value)) {
      failUnparsed(`${context} argument`, word.value);
    }
    if (containsGlob(word.value) && !word.quoted) {
      failUnparsed(`${context} unquoted glob`, word.value);
    }
    for (const path of resolveTestTarget(word.value, cwd, context)) {
      state.reachableTests.add(path);
      targetCount += 1;
    }
  }
  if (targetCount === 0) failUnparsed(context, command);
}

function parsePlaywrightCommand(
  command: string,
  cwd: string,
  context: string,
  state: ReachabilityState,
): void {
  const words = tokenizeShell(command).map((word) => word.value);
  if (
    words.length !== 4 ||
    words[0] !== 'playwright' ||
    words[1] !== 'test' ||
    words[2] !== '--config' ||
    !words[3]
  ) {
    failUnparsed(context, command);
  }
  const configPath = normalizeRepositoryPath(join(cwd, words[3]));
  const config = readFileSync(configPath, 'utf8');
  if (/\b(?:projects|testIgnore|testMatch)\s*:/u.test(config)) {
    failUnparsed('Playwright selection option', configPath);
  }
  const testDirectories = [
    ...config.matchAll(/\btestDir\s*:\s*['"]([^'"]+)['"]/gu),
  ];
  if (testDirectories.length !== 1 || !testDirectories[0]?.[1]) {
    failUnparsed('Playwright testDir', configPath);
  }
  const testRoot = normalizeRepositoryPath(
    join(dirname(configPath), testDirectories[0][1]),
  );
  const selected = [
    ...globSync(`${testRoot}/**/*.test.ts`),
    ...globSync(`${testRoot}/**/*.spec.ts`),
  ].map(normalizeRepositoryPath);
  if (selected.length === 0) {
    throw new Error(`Playwright config reaches no tests: ${configPath}`);
  }
  for (const path of selected) state.reachableTests.add(path);
}

function resolveTestTarget(
  target: string,
  cwd: string,
  context: string,
): string[] {
  const repositoryTarget = normalizeRepositoryPath(join(cwd, target));
  if (!containsGlob(target)) {
    if (!existsSync(repositoryTarget)) {
      throw new Error(`Missing test target in ${context}: ${repositoryTarget}`);
    }
    return [repositoryTarget];
  }
  const matches = globSync(repositoryTarget)
    .map(normalizeRepositoryPath)
    .sort();
  if (matches.length === 0) {
    throw new Error(`Test glob matches nothing in ${context}: ${target}`);
  }
  return matches;
}

function parseAggregateScripts(command: string): string[] {
  const scripts: string[] = [];
  for (const child of command.split(' && ')) {
    const words = tokenizeShell(child).map((word) => word.value);
    if (
      words.length !== 3 ||
      words[0] !== 'corepack' ||
      words[1] !== 'pnpm' ||
      !words[2]
    ) {
      failUnparsed('root test aggregate command', child);
    }
    scripts.push(words[2]);
  }
  return scripts.sort();
}

function tokenizeShell(command: string): ShellWord[] {
  const words: ShellWord[] = [];
  let value = '';
  let quote: 'single' | 'double' | null = null;
  let quoted = false;

  const flush = (): void => {
    if (!value) return;
    words.push({ quoted, value });
    value = '';
    quoted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? '';
    if (quote) {
      const closing = quote === 'single' ? "'" : '"';
      if (character === closing) {
        quote = null;
      } else {
        value += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character === "'" ? 'single' : 'double';
      quoted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    if (character === '\\') {
      const escaped = command[index + 1];
      if (!escaped) failUnparsed('shell escape', command);
      value += escaped;
      index += 1;
      continue;
    }
    value += character;
  }
  if (quote) failUnparsed('unterminated shell quote', command);
  flush();
  return words;
}

function containsGlob(value: string): boolean {
  return value.includes('*') || value.includes('?') || value.includes('[');
}

function normalizeRepositoryPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function failUnparsed(context: string, text: string): never {
  throw new Error(`Unparsed ${context}: ${text}`);
}
