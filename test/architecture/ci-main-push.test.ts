import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

const selector = resolve('.github/scripts/ci-selection.mjs');
const windowGate = resolve('scripts/check-merge-window.mjs');
const doctrine = readFileSync('AGENTS.md', 'utf8');
const policy = 'scripts/non-executable-pathspec.json';

function repository(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-4-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (path: string, body: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
    git('add', '--', path);
    git('commit', '-qm', path);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const fixtureSelector = join(repo, '.github/scripts/ci-selection.mjs');
  mkdirSync(dirname(fixtureSelector), { recursive: true });
  copyFileSync(selector, fixtureSelector);
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(policy, join(repo, policy));
  git('add', '--', '.github/scripts/ci-selection.mjs', policy);
  const base = commit('AGENTS.md', doctrine);
  git('update-ref', 'refs/remotes/origin/main', base);
  const select = (event: object, ref = 'main', name = 'push') => {
    const eventFile = join(dir, 'event.json');
    writeFileSync(eventFile, JSON.stringify(event));
    const result = execFileSync(process.execPath, [fixtureSelector], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_EVENT_NAME: name,
        GITHUB_REF: `refs/heads/${ref}`,
        GITHUB_REF_NAME: ref,
        GITHUB_SHA: git('rev-parse', 'HEAD'),
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        GITHUB_OUTPUT: join(dir, 'output'),
      },
    });
    return JSON.parse(result) as {
      tier: string;
      promote: boolean;
      files?: string[];
    };
  };
  const requiresFull = (before: string, tip: string) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import { requiresFull } from './.github/scripts/ci-selection.mjs'; console.log(requiresFull(process.argv[1], process.argv[2]));",
          before,
          tip,
        ],
        { cwd: repo, encoding: 'utf8' },
      ),
    ) as boolean;
  return { dir, repo, git, commit, base, select, requiresFull };
}

test('a change to the docs pathspec cannot exempt its own push or merge window', (t) => {
  const { repo, git, commit, base, select, requiresFull } = repository(t);
  const paths: string[] = JSON.parse(readFileSync(join(repo, policy), 'utf8'));
  writeFileSync(
    join(repo, policy),
    JSON.stringify([...paths, ':!scripts', ':!packages']),
  );
  git('add', '--', policy);
  const tip = commit('packages/x.ts', 'export {};');
  assert.deepEqual(
    [select({ before: base }).tier, requiresFull(base, tip)],
    ['full', true],
    'changing the docs pathspec must require full in both gates',
  );
});

test('both gates use the docs pathspec committed at the range base', (t) => {
  const { repo, commit, base, select, requiresFull } = repository(t);
  const tip = commit('docs/record.md', 'record');
  writeFileSync(join(repo, policy), '[]');
  assert.deepEqual(
    [select({ before: base }).tier, requiresFull(base, tip)],
    ['quick', false],
  );
});

for (const path of [
  'docs/run.ts',
  '.agents/skills/s/tool.sh',
  'docs/contracts/fixture.json',
]) {
  test(`both gates require full for ${path}`, (t) => {
    const { commit, base, select, requiresFull } = repository(t);
    const tip = commit(path, 'fixture');
    assert.deepEqual(
      [select({ before: base }).tier, requiresFull(base, tip)],
      ['full', true],
    );
  });
}

test('both gates require full for a Markdown symlink on either side of the change', (t) => {
  const { repo, git, base, select, requiresFull } = repository(t);
  mkdirSync(join(repo, 'docs'));
  symlinkSync(
    '../.github/scripts/ci-selection.mjs',
    join(repo, 'docs/reader.md'),
  );
  git('add', '--', 'docs/reader.md');
  git('commit', '-qm', 'link');
  const linked = git('rev-parse', 'HEAD');
  assert.deepEqual(
    [select({ before: base }).tier, requiresFull(base, linked)],
    ['full', true],
  );
  git('rm', '--', 'docs/reader.md');
  git('commit', '-qm', 'remove link');
  assert.deepEqual(
    [select({ before: linked }).tier, requiresFull(linked, 'HEAD')],
    ['full', true],
  );
});

test('a main push containing code followed by a record runs full on the push itself', (t) => {
  const { commit, base, select } = repository(t);
  commit('test/unit/changed.test.ts', 'export {};');
  commit('docs/record.md', 'merge and run');
  const plan = select({ before: base });
  assert.equal(plan.tier, 'full', 'code earlier in the push needs full');
  assert.equal(plan.promote, false);
});

test('a main range that undoes an executable change still runs full', (t) => {
  const { commit, git, base, select } = repository(t);
  commit('temporary.ts', 'export {};');
  git('revert', '--no-edit', 'HEAD');
  assert.equal(
    select({ before: base }).tier,
    'full',
    'an executable change inside the range needs full',
  );
});

test('a docs-only main range runs quick and retains the affected document reader', (t) => {
  const { commit, base, select } = repository(t);
  commit('docs/decisions/archive.md', 'decision');
  commit('.agents/skills/fixture/SKILL.md', 'doctrine');
  const plan = select({ before: base });
  assert.equal(plan.tier, 'quick', 'ordinary documentation should run quick');
  assert.equal(plan.promote, false);
  assert.deepEqual(plan.files, ['test/integration/trust-substrate.test.ts']);
});

test('a docs-only edit to the Critical definition runs full', (t) => {
  const { commit, base, select } = repository(t);
  commit(
    'AGENTS.md',
    doctrine.replace('`db/migrations/**`', '`db/narrower/**`'),
  );
  assert.equal(
    select({ before: base }).tier,
    'full',
    'changing the Critical block needs full',
  );
});

test('a main push with a missing, zero or unavailable before runs full', (t) => {
  const { commit, base, select } = repository(t);
  commit('docs/record.md', 'documentation');
  for (const event of [
    {},
    { forced: true, before: '0'.repeat(40) },
    { forced: true, before: '1'.repeat(40) },
    { created: true, before: base },
  ]) {
    assert.equal(select(event).tier, 'full', 'an unbound range needs full');
  }
});

test('a Critical packet change with selectable tests stays quick', (t) => {
  const { commit, base, select } = repository(t);
  const path = 'test/postgres/scoped-reader.test.ts';
  commit(path, "export const sql = 'GRANT SELECT ON x TO reader';");
  const packet = select({}, 'packet/fixture', 'workflow_dispatch');
  assert.equal(packet.tier, 'quick', 'the packet should run its selected test');
  assert.equal(packet.promote, false);
  assert.deepEqual(packet.files, [path]);
  const pr = select(
    {
      pull_request: {
        base: { sha: base },
        head: {
          ref: 'packet/fixture',
          repo: { full_name: process.env.GITHUB_REPOSITORY },
        },
      },
    },
    'pull/1/merge',
    'pull_request',
  );
  assert.equal(pr.tier, 'quick');
  assert.equal(
    select({}, 'candidate/fixture', 'workflow_dispatch').tier,
    'full',
  );
});

function train(t: TestContext) {
  const { dir, repo, git, base, commit } = repository(t);
  // This file first enters main with the new one-row-per-merge rule.
  const start = commit('test/evidence/CI-4.expected-red.json', '{}');
  git('init', '-q', '--bare', join(dir, 'origin.git'));
  git('remote', 'add', 'origin', join(dir, 'origin.git'));
  git('push', '-q', 'origin', 'main');
  const packet = (path: string) => {
    git('switch', '-q', '--detach', start);
    return commit(path, path);
  };
  const merge = (parent: string, ...tips: string[]) => {
    git('switch', '-q', '--detach', parent);
    git('merge', '--no-ff', '-qm', 'integration', ...tips);
    return git('rev-parse', 'HEAD');
  };
  writeFileSync(join(dir, 'token'), 'TRAIN-fixture');
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/sh
case "$2" in
 *branch=main*) echo '{"workflow_runs":[{"id":1,"run_attempt":1,"status":"completed","conclusion":"success","head_sha":"base"}]}' ;;
 */runs/1/attempts/1/jobs*) echo '{"jobs":[{"name":"Executed-file reachability (full base)","conclusion":"success"}]}' ;;
 *head_sha="$GREEN_SHA&"*) printf '{"workflow_runs":[{"id":2,"run_attempt":1,"event":"workflow_dispatch","head_sha":"%s","status":"completed","conclusion":"success"}]}' "$GREEN_SHA" ;;
 *head_sha=*) echo '{"workflow_runs":[]}' ;;
 */runs/2/attempts/1/jobs*) printf '{"jobs":[{"name":"Executed-file reachability (full %s)","conclusion":"success"}]}' "$GREEN_SHA" ;;
 *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  const check = (tip: string, green = tip) =>
    spawnSync(process.execPath, [windowGate, 'TRAIN-fixture', tip], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GREEN_SHA: green,
        MERGE_WINDOW_FILE: join(dir, 'token'),
      },
    });
  return { base, start, repo, git, commit, packet, merge, check };
}

test('a train refuses a plain commit between merges', (t) => {
  const { start, packet, merge, commit, check } = train(t);
  const b = packet('b.ts');
  merge(start, packet('a.ts'));
  const plain = commit('renumber.ts', 'plain commit');
  const result = check(merge(plain, b));
  assert.equal(result.status, 1, 'plain commit admitted');
  assert.match(result.stderr, /two-parent merge/u);
});

test('a train refuses a stale first parent even with current main as second parent', (t) => {
  const { base, start, git, commit, merge, check } = train(t);
  git('switch', '-q', '--detach', base);
  const stale = commit('stale.ts', 'stale line');
  // Use a merge-only first-parent range off an older ancestor.
  const oldMerge = merge(base, stale);
  const result = check(merge(oldMerge, start));
  assert.equal(result.status, 1, 'stale first parent admitted');
  assert.match(result.stderr, /end at current origin\/main/u);
});

test('a train refuses a fourth merge', (t) => {
  const { start, packet, merge, check } = train(t);
  let tip = start;
  for (const path of ['a', 'b', 'c', 'd']) tip = merge(tip, packet(path));
  const result = check(tip);
  assert.equal(result.status, 1, 'fourth merge admitted');
  assert.match(result.stderr, /at most three/u);
});

test('an octopus is refused even with a full green', (t) => {
  const { start, packet, merge, check } = train(t);
  const result = check(merge(start, packet('a'), packet('b')));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /two-parent merge/u);
});

test('three merges use one exact full on the tip and one row per packet tip', (t) => {
  const { start, repo, packet, merge, check } = train(t);
  const tips = [
    packet('code.ts'),
    packet('docs/b.md'),
    packet('docs/c.md'),
  ] as const;
  const first = merge(start, tips[0]);
  const last = merge(merge(first, tips[1]), tips[2]);
  const wrong = check(last, first);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /Missing green full CI/u);
  const green = check(last);
  assert.equal(green.status, 0, green.stderr);
  const log = join(repo, 'docs/execution/review-log.md');
  mkdirSync(dirname(log), { recursive: true });
  const records = (rows: readonly string[]) => {
    writeFileSync(
      log,
      rows
        .map(
          (sha) =>
            `| \`${sha}\` | packet | integration | merged — unread | today | ${last} |\n`,
        )
        .join(''),
    );
    return spawnSync('bash', [resolve('scripts/check-review-record.sh')], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        REVIEW_RECORD_BASELINE: start,
        REVIEW_RECORD_BRANCH: last,
      },
    });
  };
  assert.equal(records(tips).status, 0);
  for (const omitted of tips)
    assert.equal(
      records(tips.filter((sha) => sha !== omitted)).status,
      1,
      'missing packet row admitted',
    );
});
