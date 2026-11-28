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
import { buildModeSwitch } from '../../scripts/build-mode.mjs';

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
      'base',
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
      'lock-observability',
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
  assert.match(
    commandOf('lock-observability'),
    /test-lock-observability\.test\.ts/u,
  );
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
  const path = join(dir, 'decisions.json');
  const run = (
    edit: (document: typeof original) => void,
    buildMode: 'off' | 'on' = 'off',
  ) => {
    const document = structuredClone(original);
    edit(document);
    writeFileSync(path, JSON.stringify(document));
    const env: Record<string, string | undefined> = {
      ...process.env,
      PREFLIGHT_DECISIONS_PATH: path,
    };
    // BUILD-MODE-1: the strict behaviour is what this test pins.
    if (buildMode === 'off') env.NORTH_STAR_BUILD_MODE = 'off';
    else delete env.NORTH_STAR_BUILD_MODE;
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', 'test/helpers/preflight-language-coverage.ts'],
      { encoding: 'utf8', env },
    );
  };
  try {
    // BUILD-MODE-1 (languageCoverageDigestRegeneration on, as build-mode.json
    // ships): a stale digest is regenerated in place, rationale unchanged;
    // an obligation kind outside the reviewed list still fails.
    if (buildModeSwitch('languageCoverageDigestRegeneration')) {
      const regenerated = run((value) => {
        value.ledgerDigest = 'sha256:stale';
        if (value.decisions[0] === undefined) throw new Error('no decisions');
        value.decisions[0].ledgerDigest = 'sha256:stale';
        value.observationSnapshot = { stale: true };
      }, 'on');
      assert.equal(regenerated.status, 0, regenerated.stderr);
      assert.match(regenerated.stdout, /\(build mode\): regenerated/u);
      const rewritten = JSON.parse(
        readFileSync(path, 'utf8'),
      ) as typeof original & {
        decisions: { rationale: string }[];
      };
      assert.deepEqual(rewritten, original);
      const newKind = run((value) => {
        (value as unknown as { obligationKinds: string[] }).obligationKinds = (
          value as unknown as { obligationKinds: string[] }
        ).obligationKinds.slice(1);
      }, 'on');
      assert.equal(newKind.status, 1);
      assert.match(
        newKind.stderr,
        /LANGUAGE_COVERAGE_PREFLIGHT_NEW_OBLIGATION_KIND/u,
      );
    }
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

test('the schema-snapshot step fails on a migration alone and only warns on a release alone', () => {
  const run = (all: string[]) => {
    const step = steps({ base: 'x', files: [], all }).find(
      (candidate: { id: string }) => candidate.id === 'schema-snapshot',
    ) as { check: () => { ok: boolean; output: string } };
    return step.check();
  };
  const migration = run(['db/migrations/0042_x.sql']);
  assert.equal(migration.ok, false);
  assert.match(migration.output, /db\/schema\.snapshot\.json did not/u);
  const release = run(['apps/web/release/app.compiled.json']);
  assert.equal(release.ok, true);
  assert.match(release.output, /^WARNING: /u);
  assert.deepEqual(run(['README.md']), { ok: true, output: '' });
});

test('a base that cannot be found is a failed step with a remedy, not a silent skip', () => {
  const list = steps({
    base: 'main',
    files: [],
    all: [],
    error: 'neither origin/main nor main exists in this repository',
  }) as unknown as {
    id: string;
    remedy: string;
    check: () => { ok: boolean; output: string };
  }[];
  const base = list.find((step) => step.id === 'base');
  assert.ok(base);
  const result = base.check();
  assert.equal(result.ok, false);
  assert.match(result.output, /neither origin\/main nor main/u);
  assert.match(base.remedy, /git fetch origin main/u);
  // With a base the same step passes.
  const found = steps({ base: 'abc', files: [], all: [] }) as unknown as {
    id: string;
    check: () => { ok: boolean };
  }[];
  assert.equal(found.find((step) => step.id === 'base')?.check().ok, true);
});

test('changedFiles reports a missing base', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-8-nobase-'));
  const previous = process.cwd();
  try {
    spawnSync('git', ['init', '-q', '-b', 'topic'], { cwd: dir });
    process.chdir(dir);
    const { changedFiles } = await import('../../scripts/preflight.mjs');
    const result = changedFiles() as { files: string[]; error?: string };
    assert.deepEqual(result.files, []);
    assert.match(result.error ?? '', /neither origin\/main nor main/u);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
