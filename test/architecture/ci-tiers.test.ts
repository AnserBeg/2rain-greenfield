import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { existsSync } from 'node:fs';

// The selector and merge gate also run on a clean checkout before pnpm install.
function probe(module: string, expression: string) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import * as m from './${module}'; console.log(JSON.stringify(${expression}))`,
      ],
      { encoding: 'utf8' },
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
        `m.lastMainConclusion([{status:'queued',run_attempt:${attempt}},{status:'completed',conclusion:'failure'}],()=>({conclusion:'failure'})).conclusion`,
      ),
      'failure',
    );
});
