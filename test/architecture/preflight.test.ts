import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  failedTestNames,
  migrationSnapshotProblem,
  replaySnapshotWarning,
  steps,
} from '../../scripts/preflight.mjs';

/**
 * CI-8. `pnpm preflight` finds, without PostgreSQL, the mechanical reds lanes
 * kept meeting on CI. These cases pin the decisions it makes in pure code and
 * the list of checks it runs, so a check cannot be dropped, or lose its
 * remedy, without a red here. Each check also has a red in the packet record
 * (CI-8.md) that was run against the real repository.
 *
 * WHAT THIS CANNOT PROVE. That each step fails on every instance of its class:
 * the steps run the same tests and scripts CI runs, and are as strong as those.
 */
interface Step {
  id: string;
  remedy: string;
  skip?: boolean;
  command?: string[];
  check?: unknown;
}
const plan = (files: string[], all: string[] = files): Step[] =>
  steps({ base: 'x', files, all }) as Step[];
const changed = (...names: string[]) => names;

test('a migration without its schema snapshot is named, with the regeneration command', () => {
  const problem = migrationSnapshotProblem(
    changed('db/migrations/0042_x.sql', 'package.json'),
  );
  assert.match(
    problem ?? '',
    /db\/migrations\/0042_x\.sql changed but db\/schema\.snapshot\.json did not/u,
  );
  assert.match(problem ?? '', /regenerate-schema-snapshot/u);
  // Red that dies alone: carrying the snapshot clears it; no migration needs none.
  assert.equal(
    migrationSnapshotProblem(
      changed('db/migrations/0042_x.sql', 'db/schema.snapshot.json'),
    ),
    undefined,
  );
  assert.equal(migrationSnapshotProblem(changed('package.json')), undefined);
});

test('a release or migration change without the replay snapshot warns with the regeneration command', () => {
  const snapshot =
    'test/postgres/fresh-tenant-full-replay-schema.snapshot.json';
  assert.match(
    replaySnapshotWarning(changed('apps/web/release/app.compiled.json')) ?? '',
    /generate-fresh-tenant-full-replay-schema/u,
  );
  assert.equal(
    replaySnapshotWarning(
      changed('apps/web/release/app.compiled.json', snapshot),
    ),
    undefined,
  );
  assert.equal(replaySnapshotWarning(changed('README.md')), undefined);
});

test('failing test names are read from TAP output', () => {
  assert.deepEqual(
    failedTestNames(
      'ok 1 - fine\nnot ok 2 - the shard lists differ\n  ---\n    not ok 3 - nested\n',
    ),
    ['the shard lists differ', 'nested'],
  );
});

test('preflight runs every check the lanes keep failing on, each with a remedy', () => {
  const list = plan(['a.ts'], ['a.ts']);
  assert.deepEqual(
    list.map((step) => step.id),
    [
      'format',
      'lint',
      'typecheck',
      'language-coverage',
      'schema-snapshot',
      'records',
      'app-release',
      'expected-red',
      'hygiene',
      'reachability',
      'surface',
      'ci-evidence',
    ],
  );
  for (const step of list) {
    assert.ok(step.remedy.length > 20, `${step.id} says what to do`);
    assert.ok(
      step.command !== undefined || step.check !== undefined,
      `${step.id} runs something`,
    );
  }
  const commands = new Map(
    list.map((step) => [step.id, (step.command ?? []).join(' ')]),
  );
  assert.match(commands.get('records') ?? '', /scripts\/check-records\.sh$/u);
  assert.match(commands.get('app-release') ?? '', /check:app-release$/u);
  assert.match(
    commands.get('expected-red') ?? '',
    /scripts\/check-expected-red\.sh$/u,
  );
  assert.match(commands.get('hygiene') ?? '', /repository-hygiene\.test\.ts/u);
  assert.match(
    commands.get('reachability') ?? '',
    /test-reachability\.test\.ts/u,
  );
  assert.match(
    commands.get('surface') ?? '',
    /surface-grammar-conformance\.test\.ts/u,
  );
  assert.match(
    commands.get('surface') ?? '',
    /surface-runtime-seam\.test\.ts/u,
  );
  assert.match(
    commands.get('language-coverage') ?? '',
    /preflight-language-coverage\.ts/u,
  );
  // Each family runs the exact thing CI runs, so each is pinned by what it runs.
  const commandOf = (id: string) => commands.get(id) ?? '';
  assert.match(commandOf('format'), /prettier --check a\.ts$/u);
  assert.match(commandOf('typecheck'), /pnpm typecheck$/u);
  assert.match(commandOf('reachability'), /test-lock-observability\.test\.ts/u);
  assert.match(commandOf('surface'), /surface-data-binding\.test\.ts/u);
  for (const pin of ['evidence-on-demand', 'ci-tiers', 'preflight']) {
    assert.match(
      commandOf('ci-evidence'),
      new RegExp(`${pin}\\.test\\.ts`, 'u'),
    );
  }
  // The hygiene step skips only the one lock case, never a whole file.
  assert.match(
    commandOf('hygiene'),
    /--test-skip-pattern=matrix lock and legacy-process waits/u,
  );
});

test('a changed file list that holds nothing formattable skips format and lint', () => {
  const list = plan([], []);
  assert.equal(list.find((step) => step.id === 'format')?.skip, true);
  assert.equal(list.find((step) => step.id === 'lint')?.skip, true);
  const some = plan(['a.ts', 'b.json'], []);
  assert.equal(some.find((step) => step.id === 'format')?.skip, false);
  assert.match(
    (some.find((step) => step.id === 'lint')?.command ?? []).join(' '),
    /eslint a\.ts$/u,
  );
});

test('the preflight command is a package script and the packet record makes it mandatory', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(manifest.scripts.preflight, 'node scripts/preflight.mjs');
  assert.match(
    readFileSync('docs/execution/packets/CI-8.md', 'utf8'),
    /`pnpm preflight` is mandatory before any full-run dispatch/u,
  );
});

test('a stale language-coverage digest, decision or observation snapshot is named, each alone', () => {
  const decisionsPath =
    'test/fixtures/g2/language-conformance/coverage-decisions.json';
  const original = JSON.parse(readFileSync(decisionsPath, 'utf8')) as {
    ledgerDigest: string;
    decisions: { ledgerDigest: string }[];
    observationSnapshot: Record<string, unknown>;
  };
  const dir = mkdtempSync(join(tmpdir(), 'ci-8-coverage-'));
  const run = (edit: (document: typeof original) => void) => {
    const document = structuredClone(original);
    edit(document);
    const path = join(dir, 'decisions.json');
    writeFileSync(path, JSON.stringify(document));
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', 'test/helpers/preflight-language-coverage.ts'],
      {
        encoding: 'utf8',
        env: { ...process.env, PREFLIGHT_DECISIONS_PATH: path },
      },
    );
  };
  try {
    const clean = run(() => undefined);
    assert.equal(clean.status, 0, clean.stderr);
    const document = run((value) => {
      value.ledgerDigest = 'sha256:stale';
    });
    assert.equal(document.status, 1);
    assert.match(document.stderr, /LANGUAGE_COVERAGE_PREFLIGHT_STALE/u);
    assert.match(document.stderr, /ledgerDigest is sha256:stale/u);
    assert.doesNotMatch(document.stderr, /decision\(s\) name an older/u);
    assert.doesNotMatch(document.stderr, /observationSnapshot differs/u);
    const decision = run((value) => {
      if (value.decisions[0] === undefined) throw new Error('no decisions');
      value.decisions[0].ledgerDigest = 'sha256:stale';
    });
    assert.equal(decision.status, 1);
    assert.match(decision.stderr, /decision\(s\) name an older ledger digest/u);
    assert.doesNotMatch(decision.stderr, /ledgerDigest is /u);
    const snapshot = run((value) => {
      value.observationSnapshot = { stale: true };
    });
    assert.equal(snapshot.status, 1);
    assert.match(snapshot.stderr, /observationSnapshot differs/u);
    assert.match(snapshot.stderr, /fresh observationSnapshot: /u);
    assert.doesNotMatch(snapshot.stderr, /ledgerDigest is /u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
