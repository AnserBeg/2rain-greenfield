import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

/**
 * `.github/workflows/evidence.yml` runs two heavy local steps on GitHub's
 * runners when a pull request carries a label: the expected-red controls
 * (`run-controls`) and the fresh-tenant full-replay schema snapshot
 * (`regen-snapshot`). The workflow is pinned here the way
 * repository-hygiene pins ci.yml, and its selection and outcome script runs
 * against a scratch repository.
 *
 * WHAT THIS CANNOT PROVE. That GitHub honours the gates, or that a control job
 * reproduces a red: that is observed only on a real run, which the packet
 * record cites by URL.
 */
const workflowPath = '.github/workflows/evidence.yml';
const script = resolve('scripts/expected-red-on-demand.mjs');

test('the evidence workflow is label-gated, read-only and pinned', () => {
  const workflow = readFileSync(workflowPath, 'utf8');

  assert.match(
    workflow,
    /^on:\n {2}pull_request:\n {4}types: \[labeled, synchronize, opened, reopened\]\n\n/mu,
  );
  assert.doesNotMatch(
    workflow,
    /^ {2}(?:push|pull_request_target|schedule|workflow_dispatch|workflow_run):/mu,
    'only a labelled pull request may start it',
  );
  assert.match(workflow, /^permissions:\n {2}contents: read$/mu);
  assert.equal(
    workflow.match(/^\s*permissions:/gmu)?.length,
    1,
    'no job may widen the token',
  );
  assert.doesNotMatch(workflow, /:\s*write\b/u);

  const uses = [
    ...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*([^@\s]+)@(\S+)/gmu),
  ];
  assert.ok(uses.length > 0, 'the workflow declares no action');
  for (const [, action, ref] of uses) {
    assert.match(
      ref ?? '',
      /^[0-9a-f]{40}$/u,
      `${action} must use a commit SHA`,
    );
  }
  // The pull request's head, never the merge commit GitHub synthesizes: the
  // evidence names a SHA its author can cite.
  assert.equal(
    workflow.match(
      /uses: actions\/checkout@[0-9a-f]{40} # v4\n {8}with:\n {10}ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}\n/gu,
    )?.length,
    workflow.match(/uses: actions\/checkout@/gu)?.length,
  );

  assert.deepEqual(jobNames(workflow), [
    'select-controls',
    'control',
    'regen-snapshot',
  ]);
  const select = workflowJob(workflow, 'select-controls');
  const control = workflowJob(workflow, 'control');
  const snapshot = workflowJob(workflow, 'regen-snapshot');

  assert.ok(select.includes(labelGate('run-controls')));
  assert.ok(
    select.includes('node scripts/expected-red-on-demand.mjs select \\'),
  );
  assert.ok(select.includes('PR_BODY: ${{ github.event.pull_request.body }}'));

  assert.match(control, /^ {4}needs: select-controls$/mu);
  assert.match(
    control,
    /^ {4}if: needs\.select-controls\.outputs\.count != '0'$/mu,
  );
  assert.match(control, /^ {4}timeout-minutes: 45$/mu);
  assert.match(control, /^ {6}fail-fast: false$/mu);
  assert.match(control, /^ {6}max-parallel: 4$/mu);
  assert.match(
    control,
    /^ {8}control: \$\{\{ fromJSON\(needs\.select-controls\.outputs\.names\) \}\}$/mu,
  );
  assert.ok(
    control.includes(
      'corepack pnpm install --frozen-lockfile --reporter=append-only',
    ),
  );
  assert.ok(
    control.includes('bash scripts/check-expected-red.sh --run "$CONTROL"'),
  );
  assert.ok(
    control.includes('node scripts/expected-red-on-demand.mjs outcome \\'),
  );
  assert.match(control, /^ {8}if: success\(\) \|\| failure\(\)$/mu);

  assert.ok(snapshot.includes(labelGate('regen-snapshot')));
  assert.match(snapshot, /^ {4}timeout-minutes: 30$/mu);
  assert.ok(
    snapshot.includes(
      'run: node --import tsx test/helpers/generate-fresh-tenant-full-replay-schema.ts',
    ),
  );
  assert.ok(
    snapshot.includes(
      'name: full-replay-schema-snapshot-${{ github.event.pull_request.head.sha }}',
    ),
  );
  assert.ok(
    snapshot.includes(
      'path: test/postgres/fresh-tenant-full-replay-schema.snapshot.json',
    ),
  );
});

test('controls are the entries the head adds or changes since the merge base', () => {
  const sandbox = createSandbox();
  try {
    const entry = (name: string, replacement = 'b') => ({
      name,
      original: 'a',
      replacement,
    });
    const fork = sandbox.commit('fork point', {
      'test/evidence/alpha.expected-red.json': manifest([
        entry('kept'),
        entry('edited'),
        entry('removed'),
        entry('rekeyed'),
      ]),
      'test/evidence/beta.expected-red.json': manifest([entry('moved')]),
    });

    // The base moves on after the fork. Diffing the head against the base TIP
    // would read `kept` as changed by this pull request; it is not.
    sandbox.git('checkout', '-q', '-b', 'base-branch');
    const base = sandbox.commit('base moves on', {
      'test/evidence/alpha.expected-red.json': manifest([
        entry('kept', 'z'),
        entry('edited'),
        entry('removed'),
        entry('rekeyed'),
      ]),
      'test/evidence/beta.expected-red.json': manifest([
        entry('moved'),
        entry('base-only'),
      ]),
    });

    sandbox.git('checkout', '-q', '-b', 'head-branch', fork);
    const head = sandbox.commit('head', {
      'test/evidence/alpha.expected-red.json': manifest([
        entry('kept'),
        entry('edited', 'c'),
        { replacement: 'b', original: 'a', name: 'rekeyed' },
        entry('added'),
      ]),
      'test/evidence/beta.expected-red.json': null,
      'test/evidence/gamma.expected-red.json': manifest([entry('moved')]),
      // Neither is a manifest the runner discovers.
      'test/evidence/nested/deep.expected-red.json': manifest([
        entry('nested'),
      ]),
      'test/evidence/notes.json': manifest([entry('not-a-manifest')]),
    });

    const output = join(sandbox.root, 'github-output');
    const summary = join(sandbox.root, 'step-summary');
    const result = runScript(
      [
        'select',
        '--base',
        base,
        '--head',
        head,
        '--output',
        output,
        '--summary',
        summary,
      ],
      { cwd: sandbox.root },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      source: 'diff',
      head,
      mergeBase: fork,
      names: ['edited', 'added'],
      added: ['added'],
      changed: ['edited'],
      count: 2,
    });
    assert.equal(
      readFileSync(output, 'utf8'),
      'names=["edited","added"]\ncount=2\n',
    );
    const written = readFileSync(summary, 'utf8');
    assert.ok(written.includes('- `edited` (changed)'), written);
    assert.ok(written.includes('- `added` (added)'), written);

    // Nothing added or changed selects nothing, says so, and warns on GitHub.
    const empty = join(sandbox.root, 'empty-output');
    const none = runScript(
      ['select', '--base', head, '--head', head, '--output', empty],
      { cwd: sandbox.root, githubActions: true },
    );
    assert.equal(none.status, 0, none.stderr);
    assert.equal(readFileSync(empty, 'utf8'), 'names=[]\ncount=0\n');
    assert.match(
      none.stdout,
      /^::warning title=expected-red selection::run-controls selected no control/mu,
    );
  } finally {
    sandbox.remove();
  }
});

test('a controls: line in the body runs exactly the entries it names', () => {
  const sandbox = createSandbox();
  try {
    const head = sandbox.commit('head', {
      'test/evidence/alpha.expected-red.json': manifest([
        { name: 'kept', original: 'a', replacement: 'b' },
        { name: 'other', original: 'a', replacement: 'b' },
      ]),
    });
    const select = (body: string) =>
      runScript(['select', '--head', head], { body, cwd: sandbox.root });

    // A body edited in GitHub's web editor arrives with CRLF line endings.
    const named = select(
      'Why this pull request exists.\r\ncontrols: `other`, kept other\r\nMore prose.\r\n',
    );
    assert.equal(named.status, 0, named.stderr);
    assert.deepEqual(JSON.parse(named.stdout), {
      source: 'override',
      head,
      mergeBase: null,
      names: ['other', 'kept'],
      added: [],
      changed: [],
      count: 2,
    });

    for (const [body, refusal] of [
      [
        'controls: kept missing',
        /names missing, which no test\/evidence manifest declares/u,
      ],
      ['controls: kept\ncontrols: other', /has 2 "controls:" lines/u],
      ['controls:   ', /names no control/u],
      ['controls: Kept!', /holds "Kept!", which is not an entry name/u],
    ] as const) {
      const refused = select(body);
      assert.equal(refused.status, 2, body);
      assert.match(refused.stderr, refusal);
      assert.equal(refused.stdout, '', 'a refused selection selects nothing');
    }
    // Prose that merely mentions controls is not an override.
    const prose = runScript(['select', '--base', head, '--head', head], {
      body: 'Controls: three new reds.\nThe controls: are listed below.',
      cwd: sandbox.root,
    });
    assert.equal(prose.status, 0, prose.stderr);
    assert.equal(JSON.parse(prose.stdout).source, 'diff');
  } finally {
    sandbox.remove();
  }
});

test('a control counts only when the log shows its red and its restored green', () => {
  const sandbox = createSandbox();
  try {
    const logPath = join(sandbox.root, 'control.log');
    const summary = join(sandbox.root, 'step-summary');
    const outcome = (status: string, log: string | undefined) => {
      if (log === undefined) rmSync(logPath, { force: true });
      else writeFileSync(logPath, log);
      return runScript(
        [
          'outcome',
          '--name',
          'edited',
          '--status',
          status,
          '--log',
          logPath,
          '--sha',
          '0123456789abcdef0123456789abcdef01234567',
          '--summary',
          summary,
        ],
        { githubActions: true },
      );
    };
    const reproduced = [
      'EXPECTED_RED_RESTORED edited 3 passing',
      'MUTATION_RED edited 1 killed',
      'expected-red: OK (1 expected red(s) reproduced and restored)',
      '',
    ].join('\n');

    const passed = outcome('0', reproduced);
    assert.equal(passed.status, 0, passed.stderr);
    const line =
      '`edited` at 0123456789ab: killed with the declared reason (1 declared kill(s) failed as declared) and restored green (3 passing).';
    assert.equal(
      passed.stdout,
      `${line}\n::notice title=expected-red edited::${line}\n`,
    );
    assert.equal(readFileSync(summary, 'utf8'), `${line}\n`);

    const refusals = [
      // An exit code is not evidence.
      [
        '0',
        reproduced.replace('MUTATION_RED edited', 'MUTATION_RED other'),
        /exited 0 without printing/u,
      ],
      [
        '0',
        reproduced.replace(/^EXPECTED_RED_RESTORED.*\n/mu, ''),
        /exited 0 without printing/u,
      ],
      [
        '0',
        reproduced.replace(/^expected-red: OK.*\n/mu, ''),
        /exited 0 without printing/u,
      ],
      ['0', '', /exited 0 without printing/u],
      // A red the runner refused is reported as its first line.
      [
        '1',
        'expected-red: FAIL\n\n  edited: SURVIVOR — the mutation stayed green\n',
        /FAILED \(exit 1\) — edited: SURVIVOR — the mutation stayed green$/mu,
      ],
      [
        '1',
        'expected-red: FAIL\n\n  EXPECTED_RED_VICTIM_ABSENT\n    at test/evidence/alpha.expected-red.json#edited\n    original is not present\n',
        /— EXPECTED_RED_VICTIM_ABSENT at test\/evidence\/alpha\.expected-red\.json#edited original is not present$/mu,
      ],
      [
        '2',
        'expected-red: unknown entr(ies): edited\n',
        /FAILED \(exit 2\) — expected-red: unknown entr\(ies\): edited$/mu,
      ],
      // The control step timed out, so it left no status and maybe no log.
      [
        'none',
        undefined,
        /FAILED \(exit none\) — the control step did not finish/u,
      ],
    ] as const;
    for (const [status, log, refusal] of refusals) {
      const failed = outcome(status, log);
      assert.equal(failed.status, 1, `${status}: ${String(log)}`);
      assert.match(failed.stdout, refusal);
      assert.match(failed.stdout, /^::error title=expected-red edited::/mu);
    }

    // An annotation cannot be cut short by the text it carries.
    const escaped = outcome(
      '1',
      'expected-red: FAIL\n\n  edited: 100% wrong\n',
    );
    assert.match(
      escaped.stdout,
      /^::error title=expected-red edited::.*100%25 wrong$/mu,
    );
  } finally {
    sandbox.remove();
  }
});

function labelGate(label: string): string {
  return [
    '    if: >-',
    `      (github.event.action == 'labeled' && github.event.label.name == '${label}') ||`,
    `      (github.event.action != 'labeled' && contains(github.event.pull_request.labels.*.name, '${label}'))`,
  ].join('\n');
}

function jobNames(workflow: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.indexOf('jobs:');
  assert.notEqual(start, -1, `${workflowPath} declares no jobs`);
  return lines
    .slice(start + 1)
    .map((line) => /^ {2}([a-z][\w-]*):$/u.exec(line)?.[1])
    .filter((name) => name !== undefined);
}

function workflowJob(workflow: string, job: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${job}:`);
  assert.notEqual(start, -1, `${workflowPath} has no ${job} job`);
  const end = lines.findIndex(
    (line, index) => index > start && /^ {0,2}\S/u.test(line),
  );
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

function manifest(entries: readonly object[]): string {
  return `${JSON.stringify({ version: 1, packet: 'fixture', entries }, undefined, 2)}\n`;
}

interface Sandbox {
  readonly root: string;
  git(...argv: string[]): string;
  /** Writes (or, for null, deletes) the files, commits, and returns the SHA. */
  commit(
    message: string,
    files: Readonly<Record<string, string | null>>,
  ): string;
  remove(): void;
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'north-star-evidence-on-demand-'));
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
        '-c',
        'commit.gpgsign=false',
        ...argv,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );
  git('init', '-q', '-b', 'main');
  return {
    root,
    git,
    commit(message, files) {
      for (const [path, content] of Object.entries(files)) {
        const absolute = join(root, path);
        if (content === null) {
          git('rm', '-q', '--', path);
          continue;
        }
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, content);
        git('add', '--', path);
      }
      git('commit', '-q', '--allow-empty', '-m', message);
      return git('rev-parse', 'HEAD').trim();
    },
    remove() {
      rmSync(root, { force: true, recursive: true });
    },
  };
}

function runScript(
  argv: readonly string[],
  options: { body?: string; cwd?: string; githubActions?: boolean } = {},
): { status: number | null; stderr: string; stdout: string } {
  // CI itself runs with GITHUB_ACTIONS set; the script must see only what
  // each case sets.
  const environment = { ...process.env };
  delete environment.PR_BODY;
  delete environment.GITHUB_ACTIONS;
  if (options.body !== undefined) environment.PR_BODY = options.body;
  if (options.githubActions === true) environment.GITHUB_ACTIONS = 'true';
  const result = spawnSync(process.execPath, [script, ...argv], {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    env: environment,
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}
