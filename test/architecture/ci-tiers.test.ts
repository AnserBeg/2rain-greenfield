import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { quickSelection } from '../helpers/quick-ci.js';

// The selector and merge gate also run on a clean checkout before pnpm install.
function probe(module: string, expression: string, cwd = process.cwd()) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import * as m from '${pathToFileURL(resolve(module)).href}'; console.log(JSON.stringify(${expression}))`,
      ],
      { encoding: 'utf8', cwd },
    ),
  ) as unknown;
}
const selector = '.github/scripts/ci-selection.mjs';
const windowGate = 'scripts/check-merge-window.mjs';

test('unknown and shared files force full, including a rename or deletion', () => {
  for (const path of [
    'unowned/file.ts',
    '.github/workflows/ci.yml',
    'db/migrations/control.sql',
    'pnpm-lock.yaml',
    'apps/web/package.json',
    'packages/compiler/src/x.ts',
    'packages/canonical-model/src/x.ts',
    'packages/runtime/src/document-gateway.ts',
    'test/helpers/file.test.ts',
    'test/postgres/fixtures/example.test.ts',
    'scripts/run-suite.sh',
    'test/compiler/performance-budget.test.ts',
  ]) {
    assert.deepEqual(
      probe(
        selector,
        `m.selectPaths([{status:'M',path:${JSON.stringify(path)}}])`,
      ),
      { tier: 'full', reason: path },
    );
  }
  assert.deepEqual(
    probe(
      selector,
      "m.selectPaths([{status:'D',path:'docs/old.md'},{status:'A',path:'docs/new.md'}])",
    ),
    { tier: 'full', reason: 'docs/old.md' },
  );
});
test('quick contains changed tests and the direct coverage for mapped source', () => {
  const paths = [
    'docs/example.md',
    'packages/domain/src/billing/terms.ts',
    'test/postgres/new.test.ts',
    'apps/web/test/browser/sales.spec.ts',
  ];
  assert.deepEqual(
    probe(
      selector,
      `m.selectPaths(${JSON.stringify(paths)}.map(path => ({path,status:'A'})))`,
    ),
    {
      tier: 'quick',
      files: [
        'apps/web/test/browser/sales.spec.ts',
        'test/integration/billing-quote.test.ts',
        'test/postgres/billing-terms.test.ts',
        'test/postgres/new.test.ts',
      ],
    },
  );
  for (const path of probe(
    selector,
    '[...m.sourceCoverage].flatMap(([src, tests]) => [src, ...tests])',
  ) as string[])
    assert.ok(existsSync(path), path);
});
test('merge window requires a successful full reachability job on the candidate in the run attempt', () => {
  const run = {
    event: 'workflow_dispatch',
    status: 'completed',
    head_sha: 'candidate',
    conclusion: 'success',
  };
  for (const [name, conclusion, accepted] of [
    ['Executed-file reachability (full candidate)', 'success', true],
    ['Executed-file reachability (quick candidate)', 'success', false],
    ['Executed-file reachability (full previous)', 'success', false],
    ['Executed-file reachability (full candidate)', 'skipped', false],
  ]) {
    const jobs = [{ name, conclusion }];
    assert.equal(
      probe(
        windowGate,
        `m.exactFull(${JSON.stringify(run)},'candidate',${JSON.stringify(jobs)})`,
      ),
      accepted,
    );
  }
});
test('new queued main pushes and retries keep the preceding red visible', () => {
  for (const attempt of [1, 2])
    assert.equal(
      probe(
        windowGate,
        `m.lastMainConclusion([{status:'queued',run_attempt:${attempt}},{status:'completed',conclusion:'${attempt === 1 ? 'failure' : 'success'}'}],()=>({conclusion:'failure'})).conclusion`,
      ),
      'failure',
    );
});

test('the merge gate follows the accepted Critical definition and detects changes to embedded SQL on either side', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-3-critical-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  try {
    run('init', '--quiet');
    run('config', 'user.name', 'Fixture');
    run('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(dir, 'AGENTS.md'), readFileSync('AGENTS.md'));
    mkdirSync(join(dir, 'db/migrations'), { recursive: true });
    writeFileSync(join(dir, 'db/migrations', 'existing.sql'), 'SELECT 1;');
    writeFileSync(
      join(dir, 'read.ts'),
      'const permission = "GRANT SELECT ON x TO reader";',
    );
    run('add', 'AGENTS.md', 'db/migrations/existing.sql', 'read.ts');
    run('commit', '-qm', 'base');
    const base = run('rev-parse', 'HEAD').toString().trim();
    for (const [path, content, critical] of [
      ['normal.ts', 'export const n = 1;', false],
      ['db/migrations/existing.sql', 'SELECT 2;', true],
      ['read.ts', 'const permission = "";', true],
    ] as const) {
      writeFileSync(join(dir, path), content);
      run('add', path);
      run('commit', '-qm', path);
      assert.equal(
        probe(selector, "m.criticalDiff('HEAD^', 'HEAD')", dir),
        critical,
      );
    }
    // The packet cannot edit its own touched path out of the accepted set.
    writeFileSync(join(dir, 'AGENTS.md'), 'no paths');
    run('add', 'AGENTS.md');
    run('commit', '-qm', 'change doctrine');
    assert.equal(
      probe(selector, `m.criticalDiff('${base}','HEAD')`, dir),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-records rejects a new packet missing the tier attached to its CI run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-3-record-'));
  const record = join(dir, 'docs/execution/packets/new.md');
  const script = resolve('scripts/check-record-ci-tier.mjs');
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-qm',
        'baseline',
      ],
      { cwd: dir },
    );
    mkdirSync(join(dir, 'docs/execution/packets'), { recursive: true });
    const url = 'https://github.com/AnserBeg/2rain-greenfield/actions/runs/123';
    for (const tier of ['full', 'quick']) {
      writeFileSync(record, `CI tier: ${tier} ${url}\n`);
      execFileSync(process.execPath, [script], { cwd: dir });
    }
    writeFileSync(record, `CI passed at ${url}\n`);
    assert.throws(
      () =>
        execFileSync(process.execPath, [script], { cwd: dir, stdio: 'pipe' }),
      /expected one "CI tier/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the token command refuses red main and an integration without exact full evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-3-window-'));
  const repo = join(dir, 'repo');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    mkdirSync(repo);
    git('init', '--quiet', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(repo, 'AGENTS.md'), readFileSync('AGENTS.md'));
    git('add', 'AGENTS.md');
    git('commit', '-qm', 'main');
    git('init', '--quiet', '--bare', join(dir, 'origin.git'));
    git('remote', 'add', 'origin', join(dir, 'origin.git'));
    git('push', '--quiet', 'origin', 'main');
    git('switch', '-qc', 'packet/fixture');
    mkdirSync(join(repo, 'db/migrations'), { recursive: true });
    writeFileSync(join(repo, 'db/migrations/change.sql'), 'SELECT 1;');
    git('add', 'db/migrations/change.sql');
    git('commit', '-qm', 'packet');
    git('switch', '-q', 'main');
    git('merge', '--quiet', '--no-ff', 'packet/fixture', '-m', 'candidate');
    const candidate = git('rev-parse', 'HEAD');
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/sh
case "$2" in
  *branch=main*) printf '{"workflow_runs":[{"status":"completed","conclusion":"%s","html_url":"fixture"}]}' "$MAIN_RESULT" ;;
  *head_sha=*) echo '{"workflow_runs":[]}' ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o755 },
    );
    for (const [state, reason] of [
      ['failure', /Merge window closed by main CI/u],
      ['success', /Missing green full CI on exact integration commit/u],
    ] as const) {
      const check = spawnSync(
        process.execPath,
        [resolve(windowGate), 'fixture', candidate],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            MAIN_RESULT: state,
            PATH: `${dir}:${process.env.PATH}`,
          },
        },
      );
      assert.equal(check.status, 1);
      assert.match(check.stderr, reason);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a newly selected unit or compiler file outside the fixed argv is scheduled by name', () => {
  const paths = [
    'test/compiler/new.test.ts',
    'test/unit/new.test.ts',
    'test/architecture/new.test.ts',
    'test/unit/request-work-meter.test.ts',
  ];
  const old = process.env.CI_FILES;
  try {
    process.env.CI_FILES = JSON.stringify(paths);
    assert.deepEqual(quickSelection().nodeFiles, paths.slice(0, 2));
  } finally {
    if (old === undefined) delete process.env.CI_FILES;
    else process.env.CI_FILES = old;
  }
});

test('the promotion waits through an initial 404 and forwards the exact child conclusion', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const shell = workflow.match(
    /- name: Follow the dispatched run\n[\s\S]*?        run: \|\n((?:          [^\n]*\n)+)/u,
  )?.[1];
  assert.ok(shell);
  const dir = mkdtempSync(join(tmpdir(), 'ci-3-promotion-'));
  const calls = join(dir, 'calls');
  try {
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/sh
[ "$1" = api ] && [ "$2" = repos/fixture/repo/actions/runs/42 ] || exit 2
echo read >> "$CALLS"
[ "$(wc -l < "$CALLS")" -gt 1 ] && [ "$CHILD" != invisible ] || exit 1
printf 'completed\\t%s\\n' "$CHILD"
`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (const [conclusion, exit, count] of [
      ['success', 0, 2],
      ['failure', 1, 2],
      ['invisible', 1, 12],
    ] as const) {
      writeFileSync(calls, '');
      const child = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', shell], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          CALLS: calls,
          GH_REPO: 'fixture/repo',
          RUN_ID: '42',
          CHILD: conclusion,
        },
        timeout: 5000,
      });
      assert.equal(child.status, exit);
      assert.equal(
        readFileSync(calls, 'utf8').trim().split('\n').length,
        count,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
