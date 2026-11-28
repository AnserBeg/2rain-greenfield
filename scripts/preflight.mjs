#!/usr/bin/env node
/**
 * pnpm preflight (CI-8): every mechanical red a lane keeps meeting on CI, found
 * locally in a few minutes and without PostgreSQL. Mandatory before dispatching
 * any full run (docs/execution/packets/CI-8.md).
 *
 * It runs every step (no fail-fast), prints for each failure the output that
 * names the problem and EXACTLY what to regenerate or edit, and exits 1 if any
 * step failed. A step it cannot run without PostgreSQL is reduced to what git
 * can show (a migration changed and its schema snapshot did not).
 *
 * WHAT THIS CANNOT PROVE. That the full run is green: PostgreSQL, browser and
 * integration suites still run only on CI. It proves the cheap, deterministic
 * reds are absent, so the hour-long run is not spent on one of them.
 */
import { spawn, spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FORMATTABLE = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|css|html)$/u;
const LINTABLE = /\.(?:[cm]?[jt]sx?)$/u;

export function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : '';
}

function gitStrict(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`,
    );
  }
  return result.stdout;
}

/**
 * Files this branch changes against main, committed or not, that still exist.
 * A base that cannot be found is reported in `error` (preflight fails by name),
 * never as an empty change list that silently skips format and lint.
 */
export function changedFiles() {
  try {
    const mainRef = ['origin/main', 'main'].find(
      (ref) =>
        spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], {
          encoding: 'utf8',
        }).status === 0,
    );
    if (mainRef === undefined) {
      throw new Error('neither origin/main nor main exists in this repository');
    }
    const base = gitStrict('merge-base', mainRef, 'HEAD').trim();
    if (base === '')
      throw new Error(`no merge base between ${mainRef} and HEAD`);
    const names = new Set([
      ...gitStrict('diff', '--name-only', '--diff-filter=d', base).split('\n'),
      ...gitStrict('ls-files', '--others', '--exclude-standard').split('\n'),
    ]);
    return {
      base,
      files: [...names]
        .filter((name) => name !== '' && existsSync(name))
        .sort(),
      all: [...names].filter((name) => name !== '').sort(),
    };
  } catch (error) {
    return {
      base: 'main',
      files: [],
      all: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Pure: a migration changed and the schema snapshot did not. */
/** @param {string[]} changed */
export function migrationSnapshotProblem(changed) {
  const migration = changed.find((name) => name.startsWith('db/migrations/'));
  if (migration === undefined || changed.includes('db/schema.snapshot.json')) {
    return undefined;
  }
  return `${migration} changed but db/schema.snapshot.json did not. Regenerate the snapshot against PostgreSQL (two-space JSON first, then Prettier): node --import tsx test/helpers/regenerate-schema-snapshot.ts && corepack pnpm exec prettier --write db/schema.snapshot.json . Then check it with: corepack pnpm check:schema`;
}

/** Pure: a release or migration changed and the fresh-tenant replay snapshot did not (a warning, not a failure). */
/** @param {string[]} changed */
export function replaySnapshotWarning(changed) {
  const lineage = changed.find(
    (name) =>
      name.startsWith('apps/web/release/') || name.startsWith('db/migrations/'),
  );
  const snapshot =
    'test/postgres/fresh-tenant-full-replay-schema.snapshot.json';
  if (lineage === undefined || changed.includes(snapshot)) return undefined;
  return `${lineage} changed and ${snapshot} did not. If the release lineage changed, regenerate it: node --import tsx test/helpers/generate-fresh-tenant-full-replay-schema.ts (needs PostgreSQL), or add the regen-snapshot label to a pull request.`;
}

const node = process.execPath;
const tsx = ['--import', 'tsx'];

/**
 * @typedef {{ ok: boolean, output: string }} StepResult
 * @typedef {{
 *   id: string,
 *   title: string,
 *   remedy: string,
 *   skip?: boolean,
 *   command?: string[],
 *   check?: () => StepResult,
 *   namedFailures?: boolean,
 * }} Step
 */

/**
 * Every step: how to run it and what to do when it fails.
 *
 * @param {{ base: string, files: string[], all: string[], error?: string }} changed
 * @returns {Step[]}
 */
export function steps(changed) {
  const formattable = changed.files.filter((name) => FORMATTABLE.test(name));
  const lintable = changed.files.filter((name) => LINTABLE.test(name));
  const architecture = (id, title, files, remedy, extra = []) => ({
    id,
    title,
    command: [node, ...tsx, '--test', ...extra, ...files],
    remedy,
    namedFailures: true,
  });
  return [
    {
      id: 'base',
      title: 'the branch base (origin/main or main) can be found',
      check: () => ({
        ok: changed.error === undefined,
        output: changed.error ?? '',
      }),
      remedy:
        'git fetch origin main (or create a local main branch); without a base preflight cannot tell which files this branch changes, so it cannot check format, lint or the snapshot rules',
    },
    {
      id: 'format',
      title: 'prettier on changed files',
      skip: formattable.length === 0,
      command: [
        'corepack',
        'pnpm',
        'exec',
        'prettier',
        '--check',
        ...formattable,
      ],
      remedy: `corepack pnpm exec prettier --write ${formattable.join(' ')}`,
    },
    {
      id: 'lint',
      title: 'eslint on changed files',
      skip: lintable.length === 0,
      command: ['corepack', 'pnpm', 'exec', 'eslint', ...lintable],
      remedy: `corepack pnpm exec eslint --fix ${lintable.join(' ')} (then fix what --fix cannot)`,
    },
    {
      id: 'typecheck',
      title: 'typecheck',
      command: ['corepack', 'pnpm', 'typecheck'],
      remedy: 'fix the type errors printed above (corepack pnpm typecheck)',
    },
    {
      id: 'language-coverage',
      title: 'language-coverage ledger digest and decisions',
      command: [node, ...tsx, 'test/helpers/preflight-language-coverage.ts'],
      remedy:
        'update test/fixtures/g2/language-conformance/coverage-decisions.json: set ledgerDigest (the document and every decision) to the current digest printed above and observationSnapshot to the fresh one printed above; re-decide any decision whose obligation moved. In build mode (build-mode.json languageCoverageDigestRegeneration) preflight rewrites the digests itself and fails only on a NEW obligation kind: decide how that kind is covered, then add it to obligationKinds by hand',
    },
    {
      id: 'schema-snapshot',
      title: 'migrations carry their schema snapshot',
      check: () => {
        const problem = migrationSnapshotProblem(changed.all);
        const warning = replaySnapshotWarning(changed.all);
        return {
          ok: problem === undefined,
          output: [problem, warning && `WARNING: ${warning}`]
            .filter(Boolean)
            .join('\n'),
        };
      },
      remedy:
        'run the regeneration command printed in the line above (migration first, then the schema snapshot, then the replay snapshot)',
    },
    {
      id: 'records',
      title: 'packet records and CI tier line',
      command: ['bash', 'scripts/check-records.sh'],
      remedy:
        'a packet record under docs/execution/packets needs exactly one line "CI tier: pending <quick|full>" (on a packet/* branch; replace it with the run URL when the run exists), a record-claim block whose changedPaths equal the diff against its base, and symbols that exist in the head',
    },
    {
      id: 'app-release',
      title: 'check:app-release',
      command: ['corepack', 'pnpm', 'check:app-release'],
      remedy:
        'regenerate the release, never hand-merge it: corepack pnpm --filter @north-star/web build:app-release (add -- --pre-tenant-rebaseline when the lineage changes), then regenerate test/postgres/fresh-tenant-full-replay-schema.snapshot.json',
    },
    {
      id: 'expected-red',
      title: 'expected-red manifests name live production text',
      command: ['bash', 'scripts/check-expected-red.sh'],
      remedy:
        'commit first (the gate needs a tracked tree identical to HEAD), then fix the manifest entry whose "original" text no longer appears exactly once in its file',
    },
    architecture(
      'hygiene',
      'repository hygiene: test inventories, shard lists, PostgreSQL shard coverage',
      ['test/architecture/repository-hygiene.test.ts'],
      'a new unit or architecture file must be added to the list in package.json AND in test/architecture/repository-hygiene.test.ts; a new test/postgres file must be in exactly one shard (or the catch-all) in package.json AND test/helpers/reachability-producers.ts, identically (copy the catch-all glob from main, never hand-merge)',
      ['--test-skip-pattern=matrix lock and legacy-process waits'],
    ),
    architecture(
      'reachability',
      'reachability producers',
      ['test/architecture/test-reachability.test.ts'],
      'package.json and test/helpers/reachability-producers.ts must name the same files in the same order for every producer; add the file in both',
    ),
    architecture(
      'lock-observability',
      'test lock observability',
      ['test/architecture/test-lock-observability.test.ts'],
      'the shared test lock registry (scripts/test-lock-registry.mjs, scripts/run-with-test-lock.mjs) or its observability test changed: fix the registry or the case named above. If it failed with a process state other than Z it is a race in the test setup, so run it again alone before changing anything',
    ),
    architecture(
      'surface',
      'surface architecture rules (SURF-style)',
      [
        'test/architecture/surface-grammar-conformance.test.ts',
        'test/architecture/surface-runtime-seam.test.ts',
        'test/architecture/surface-data-binding.test.ts',
      ],
      'the surface rule named above failed: fix the surface, or re-measure the ratchet in test/architecture/surface-grammar-conformance.baseline.ts when the change is intended; never hand-edit a measured count',
    ),
    architecture(
      'ci-evidence',
      'CI workflows, tiers and evidence dispatch pins',
      [
        'test/architecture/evidence-on-demand.test.ts',
        'test/architecture/ci-tiers.test.ts',
        'test/architecture/preflight.test.ts',
      ],
      'a workflow or script under .github/ or scripts/ changed against its architecture pin: update the code or the pin it names, not both blindly',
    ),
  ];
}

function run(command) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => resolve({ ok: false, output: String(error) }));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

/** @param {string} output */
export function failedTestNames(output) {
  return [...output.matchAll(/^\s*not ok \d+ - (.+)$/gmu)].map(
    (match) => match[1],
  );
}

/** The failing part of a step's output: each `not ok` block for test runs, else the last 60 lines. */
export function excerpt(output, tests) {
  const lines = output.split('\n');
  const last = lines.slice(-60).join('\n');
  if (!tests) return last;
  const blocks = [];
  lines.forEach((line, index) => {
    if (/^\s*not ok \d+ - /u.test(line)) {
      blocks.push(lines.slice(index, index + 18).join('\n'));
    }
  });
  return blocks.length > 0 ? blocks.join('\n...\n') : last;
}

async function main() {
  const started = Date.now();
  const changed = changedFiles();
  console.log(
    `preflight: ${String(changed.all.length)} changed path(s) against ${changed.base.slice(0, 12)}`,
  );
  const all = steps(changed);
  const queue = all.filter((step) => step.skip !== true);
  const results = new Map();
  const concurrency = Number(process.env.PREFLIGHT_CONCURRENCY ?? 3);
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const step = queue[next++];
      const begin = Date.now();
      const result = step.check ? step.check() : await run(step.command);
      results.set(step.id, { ...result, seconds: (Date.now() - begin) / 1000 });
      console.log(
        `${result.ok ? 'ok  ' : 'FAIL'} ${step.id} (${results.get(step.id).seconds.toFixed(0)}s)`,
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  let failed = 0;
  for (const step of queue) {
    const result = results.get(step.id);
    if (result.ok) {
      if (result.output) console.log(`\n[${step.id}] ${result.output}`);
      continue;
    }
    failed += 1;
    const tail = excerpt(result.output, step.namedFailures === true);
    const names = step.namedFailures ? failedTestNames(result.output) : [];
    console.log(`\n=== PREFLIGHT FAILED: ${step.id} - ${step.title}`);
    if (names.length > 0) {
      console.log(`failing tests:\n${names.map((n) => `  - ${n}`).join('\n')}`);
    }
    console.log(tail);
    console.log(`--> TO FIX: ${step.remedy}`);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    failed === 0
      ? `\npreflight: OK (${String(queue.length)} steps, ${seconds}s)`
      : `\npreflight: ${String(failed)} of ${String(queue.length)} step(s) FAILED (${seconds}s). Do not dispatch a full run.`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
}
