#!/usr/bin/env node
/**
 * The expected-red runner: apply one named, one-property mutation to production,
 * run the focused suite, require the exact expected red, restore.
 *
 * This is `test/integration/scoped-create-operand-mutations.mjs` lifted out of
 * one packet. That file converged its packet in two rounds while its neighbours
 * took four to seven, and it was the only committed mutation runner in the tree;
 * every other packet's reds live in review-log prose and are executable never
 * again. The 2026-08-20 program review's R2 asked for exactly this generalization.
 *
 * WHAT THIS PROVES. For each manifest entry: the named production text was
 * present and unique; the focused suite passed with at least one executed test
 * before the mutation; the mutation changed the file on disk and the file was
 * still mutated when the run ended; the suite then failed; the set of tests that
 * stopped passing is EXACTLY the declared `kills`; and the failure text matches
 * `expected`, a pattern that does not match the same suite's green output.
 *
 * WHAT THIS DOES NOT PROVE. Nothing here chooses the mutations. A manifest
 * measures the seams its author thought to name, which `review-tiers` says is
 * evidence about the author's model and worth strictly less than an independent
 * replay. It is also not a mutation-testing platform: no generation, no coverage
 * score, no survival ratio. Mutation choice and fixture self-correlation stay
 * with a human on purpose.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

export const MANIFEST_GLOB = 'test/evidence/*.expected-red.json';
export const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const REPORTER = './test/helpers/expected-red-reporter.mjs';
const JOURNAL = 'test-results/expected-red/in-flight.json';

/**
 * A green node:test transcript. `expected` is refused when it matches any of
 * these, which is how `/./` and every other non-discriminating pattern is
 * rejected without a literal-character heuristic: a pattern that matches a
 * PASSING run is not the identity of a red.
 */
const GREEN_CANARIES = Object.freeze([
  '',
  'TAP version 13',
  'ok 1 - a test that passes',
  '# pass 1',
  '# fail 0',
  '1..1',
]);

// ---------------------------------------------------------------------------
// Manifest loading and static validation. No test is executed here: this half
// is cheap enough to run on every matrix and answers the one question that goes
// stale on its own — has the production text a manifest entry names drifted?
// ---------------------------------------------------------------------------

/**
 * `EXPECTED_RED_MANIFEST_GLOB` is injectable for the same reason
 * `check-review-record.sh` lets its branch be injected: the negative controls
 * need to point the real code at a deliberately broken manifest. It overrides
 * only WHICH manifests are read — entry paths still resolve against the
 * repository root — and nothing else should set it in normal use.
 */
export function manifestGlob() {
  const override = process.env.EXPECTED_RED_MANIFEST_GLOB;
  return override !== undefined && override.length > 0 ? override : MANIFEST_GLOB;
}

export function discoverManifestPaths(root = REPOSITORY_ROOT) {
  return globSync(manifestGlob(), { cwd: root }).sort();
}

export function loadManifests(root = REPOSITORY_ROOT) {
  const problems = [];
  const entries = [];
  const paths = discoverManifestPaths(root);

  // The check reading zero input is a vacuity vector in its own right: a glob
  // that matches nothing must fail, never report OK over an empty set.
  if (paths.length === 0) {
    problems.push({
      code: 'EXPECTED_RED_NO_MANIFESTS',
      where: manifestGlob(),
      detail: 'no manifest was discovered, so the gate would pass over nothing',
    });
    return { entries, paths, problems };
  }

  const seenNames = new Map();
  for (const path of paths) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
    } catch (error) {
      problems.push({
        code: 'EXPECTED_RED_MANIFEST_UNREADABLE',
        where: path,
        detail: String(error instanceof Error ? error.message : error),
      });
      continue;
    }
    for (const problem of validateManifestShape(manifest, path)) {
      problems.push(problem);
    }
    if (!Array.isArray(manifest?.entries)) continue;
    for (const [index, entry] of manifest.entries.entries()) {
      const where = `${path}#${entry?.name ?? index}`;
      const before = problems.length;
      for (const problem of validateEntry(entry, where, root)) {
        problems.push(problem);
      }
      if (typeof entry?.name === 'string') {
        const owner = seenNames.get(entry.name);
        if (owner !== undefined) {
          problems.push({
            code: 'EXPECTED_RED_DUPLICATE_NAME',
            where,
            detail: `${entry.name} is already declared by ${owner}`,
          });
        } else seenNames.set(entry.name, path);
      }
      if (problems.length === before) {
        entries.push({ ...entry, manifest: path, packet: manifest.packet });
      }
    }
  }
  return { entries, paths, problems };
}

function validateManifestShape(manifest, where) {
  const problems = [];
  const fail = (detail) =>
    problems.push({ code: 'EXPECTED_RED_MANIFEST_SHAPE', where, detail });
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('a manifest must be a JSON object');
    return problems;
  }
  if (manifest.version !== 1) fail('version must be 1');
  if (!isNonEmptyString(manifest.packet)) {
    fail('packet must name the packet that owns these entries');
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    fail('entries must be a non-empty array');
  }
  return problems;
}

function validateEntry(entry, where, root) {
  const problems = [];
  const fail = (code, detail) => problems.push({ code, where, detail });
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    fail('EXPECTED_RED_ENTRY_SHAPE', 'an entry must be a JSON object');
    return problems;
  }
  if (!isNonEmptyString(entry.name) || !/^[a-z][a-z0-9-]*$/u.test(entry.name)) {
    fail('EXPECTED_RED_ENTRY_SHAPE', 'name must be a kebab-case identifier');
  }
  // The seam sentence is what a reviewer reads to decide whether the mutation
  // matches the claim. An entry that names its file and not its claim measures
  // something nobody can check the relevance of.
  if (!isNonEmptyString(entry.claim) || entry.claim.trim().length < 20) {
    fail(
      'EXPECTED_RED_CLAIM_MISSING',
      'claim must state the production seam this entry holds',
    );
  }

  if (!isNonEmptyString(entry.file)) {
    fail('EXPECTED_RED_ENTRY_SHAPE', 'file must be a repository-relative path');
  } else if (!existsSync(resolve(root, entry.file))) {
    fail('EXPECTED_RED_FILE_MISSING', `${entry.file} does not exist`);
  } else if (!isNonEmptyString(entry.original)) {
    fail('EXPECTED_RED_ENTRY_SHAPE', 'original must be non-empty source text');
  } else {
    const source = readFileSync(resolve(root, entry.file), 'utf8');
    const found = occurrences(source, entry.original);
    // The most likely future failure, and the one a "no match, nothing to do"
    // runner would turn into a permanent green.
    if (found === 0) {
      fail(
        'EXPECTED_RED_VICTIM_ABSENT',
        `original is not present in ${entry.file} — the production text has drifted`,
      );
    } else if (found > 1) {
      fail(
        'EXPECTED_RED_VICTIM_AMBIGUOUS',
        `original occurs ${found} times in ${entry.file}; String.replace would mutate only the first`,
      );
    }
  }
  if (typeof entry.replacement !== 'string') {
    fail('EXPECTED_RED_ENTRY_SHAPE', 'replacement must be a string (empty deletes)');
  } else if (entry.replacement === entry.original) {
    fail('EXPECTED_RED_NO_MUTATION', 'replacement equals original, so nothing changes');
  }

  let expected;
  if (!isNonEmptyString(entry.expected)) {
    fail('EXPECTED_RED_ENTRY_SHAPE', 'expected must be a regular-expression source string');
  } else {
    try {
      expected = new RegExp(entry.expected, 'u');
    } catch (error) {
      fail(
        'EXPECTED_RED_PATTERN_INVALID',
        String(error instanceof Error ? error.message : error),
      );
    }
  }
  if (expected !== undefined) {
    const matched = GREEN_CANARIES.filter((canary) => expected.test(canary));
    if (matched.length > 0) {
      fail(
        'EXPECTED_RED_PATTERN_NOT_DISCRIMINATING',
        `expected matches green transcript text ${JSON.stringify(matched[0])}; a pattern that matches a passing run is not the identity of a red`,
      );
    }
  }

  const test = entry.test;
  if (test === null || typeof test !== 'object' || Array.isArray(test)) {
    fail('EXPECTED_RED_ENTRY_SHAPE', 'test must be an object naming files and an optional namePattern');
  } else {
    if (!Array.isArray(test.files) || test.files.length === 0) {
      fail('EXPECTED_RED_ENTRY_SHAPE', 'test.files must be a non-empty array');
    } else {
      for (const file of test.files) {
        if (!isNonEmptyString(file) || !existsSync(resolve(root, file))) {
          fail('EXPECTED_RED_TEST_MISSING', `test file ${String(file)} does not exist`);
        }
      }
    }
    if (test.namePattern !== undefined && !isNonEmptyString(test.namePattern)) {
      fail('EXPECTED_RED_ENTRY_SHAPE', 'test.namePattern must be a non-empty string when present');
    }
  }

  // A red count is not attribution. The declared kill set is what makes two
  // entries sharing one `expected` string tell themselves apart.
  if (!Array.isArray(entry.kills) || entry.kills.length === 0) {
    fail('EXPECTED_RED_KILLS_MISSING', 'kills must name the tests this mutation must break');
  } else if (!entry.kills.every((name) => isNonEmptyString(name))) {
    fail('EXPECTED_RED_ENTRY_SHAPE', 'every kills entry must be a non-empty test name');
  } else if (new Set(entry.kills).size !== entry.kills.length) {
    fail('EXPECTED_RED_ENTRY_SHAPE', 'kills must not repeat a test name');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

/**
 * Runs the selected entries. Throws on the first entry that fails to produce
 * its expected red; the tree is restored either way.
 */
export function runEntries(entries, { root = REPOSITORY_ROOT, log = process.stdout } = {}) {
  assertCleanTrackedTree(root);
  const baselines = new Map();
  const scratch = mkdtempSync(join(tmpdir(), 'expected-red-'));
  try {
    for (const entry of entries) {
      const key = commandKey(entry.test);
      if (!baselines.has(key)) {
        baselines.set(key, measureBaseline(entry, { root, scratch, log }));
      }
      runOneEntry(entry, baselines.get(key), { root, scratch, log });
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
  // The subject-repaired-before-measured vector, closed at the tree level: a
  // run that leaves any tracked byte changed did not restore what it mutated.
  assertCleanTrackedTree(root);
  return entries.length;
}

function measureBaseline(entry, { root, scratch, log }) {
  const run = runSuite(entry.test, { root, scratch, label: `${entry.name}:baseline` });
  assert.equal(
    run.spawnFailure,
    undefined,
    `${entry.name}: the baseline suite could not be started (${run.spawnFailure})`,
  );
  assert.equal(
    run.status,
    0,
    `${entry.name}: the suite is not green before the mutation, so no red it produces can be attributed to the mutation\n${tail(run.output)}`,
  );
  // The check reading zero input. A --test-name-pattern that matches nothing
  // exits 0, and without this the mutated run's non-zero exit would be the only
  // thing distinguishing "nothing ran" from "the seam held".
  assert.ok(
    run.results.length > 0,
    `${entry.name}: the baseline executed no test — the pattern or file selects nothing`,
  );
  const passing = passingIdentities(run.results);
  assert.equal(
    passing.size,
    run.results.length,
    `${entry.name}: the baseline is not wholly green`,
  );
  log.write(`EXPECTED_RED_BASELINE ${entry.name} ${passing.size} passing\n`);
  return { passing, output: run.output };
}

function runOneEntry(entry, baseline, { root, scratch, log }) {
  const expected = new RegExp(entry.expected, 'u');
  const path = resolve(root, entry.file);

  // Declared kills must be tests that actually pass at baseline. A kill naming
  // a test that never ran would be satisfied by its permanent absence.
  const missing = entry.kills.filter((name) => !identitiesNamed(baseline.passing, name));
  assert.deepEqual(
    missing,
    [],
    `${entry.name}: kills names ${JSON.stringify(missing)}, which did not pass at baseline`,
  );

  // Discrimination, measured rather than asserted: a pattern that already
  // matches this suite's GREEN output cannot be the identity of its red.
  assert.doesNotMatch(
    baseline.output,
    expected,
    `${entry.name}: expected matches the suite's own passing output, so it cannot identify a red`,
  );

  const originalSource = readFileSync(path, 'utf8');
  assert.equal(
    occurrences(originalSource, entry.original),
    1,
    `${entry.name}: production victim must be present exactly once in ${entry.file}`,
  );
  const mutatedSource = originalSource.replace(entry.original, entry.replacement);
  assert.notEqual(
    mutatedSource,
    originalSource,
    `${entry.name}: the mutation produced an identical file`,
  );
  const mutatedDigest = digest(mutatedSource);

  const observation = withMutation(
    { path, originalSource, mutatedSource, root },
    (subject) => {
      const run = runSuite(entry.test, { root, scratch, label: entry.name });
      // Read the subject back BEFORE the restore in withMutation's finally. If
      // anything had healed the file while the suite ran, the digests diverge
      // here and the run is refused rather than credited.
      return { ...run, observedDigest: subject.readBackDigest() };
    },
  );

  assert.equal(
    observation.observedDigest,
    mutatedDigest,
    `${entry.name}: ${entry.file} was not the mutated file when the suite finished — the subject was repaired before it was measured`,
  );
  assert.equal(
    observation.spawnFailure,
    undefined,
    `${entry.name}: the mutated suite could not be started (${observation.spawnFailure})`,
  );
  assert.ok(
    observation.results.length > 0,
    `${entry.name}: the mutated run executed no test, so its exit code says nothing`,
  );
  assert.notEqual(
    observation.status,
    0,
    `${entry.name}: SURVIVOR — the mutation stayed green`,
  );

  const stillPassing = passingIdentities(observation.results);
  const regressed = [...baseline.passing]
    .filter((identity) => !stillPassing.has(identity))
    .map((identity) => identity.split('::').slice(1).join('::'))
    .sort();
  const declared = [...entry.kills].sort();
  assert.deepEqual(
    regressed,
    declared,
    `${entry.name}: the red is not attributable — declared kills ${JSON.stringify(declared)} but the mutation stopped ${JSON.stringify(regressed)}`,
  );
  assert.match(
    observation.output,
    expected,
    `${entry.name}: the suite went red for a different reason than the one declared\n${tail(observation.output)}`,
  );
  log.write(`MUTATION_RED ${entry.name} ${declared.length} killed\n`);
}

/**
 * Applies the mutation, hands the measurer a read-only view of the subject, and
 * restores afterwards.
 *
 * The measurer receives no way to restore: `originalSource` and the writing
 * call are captured here and never passed on. That is the structural half of
 * AGENTS.md section 6's rule that a verifier must never share a code path with
 * the thing that heals what it verifies; the digest read-back is the observed
 * half.
 *
 * The journal exists for the case `finally` cannot cover. A SIGKILL mid-run
 * leaves the mutated file on disk, and the journal names it. Recovery is
 * `git checkout -- <file>`, which is lossless precisely because the runner
 * refuses to start on a dirty tracked tree.
 */
function withMutation({ path, originalSource, mutatedSource, root }, measure) {
  const journalPath = resolve(root, JOURNAL);
  mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, `${JSON.stringify({ mutated: [path] }, undefined, 2)}\n`);
  writeFileSync(path, mutatedSource);
  const restore = () => {
    writeFileSync(path, originalSource);
    rmSync(journalPath, { force: true });
  };
  const onSignal = () => {
    restore();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return measure({
      readBackDigest: () => digest(readFileSync(path, 'utf8')),
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    restore();
  }
}

/**
 * Builds the node argv itself rather than accepting one from the manifest. A
 * free-form argv is where a reporter gets dropped, a name pattern gets typoed
 * into matching nothing, or concurrency makes the kill set nondeterministic.
 */
export function suiteArguments(test, evidencePath) {
  return [
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=1',
    ...(test.namePattern === undefined
      ? []
      : [`--test-name-pattern=${test.namePattern}`]),
    `--test-reporter=${REPORTER}`,
    `--test-reporter-destination=${evidencePath}`,
    '--test-reporter=tap',
    '--test-reporter-destination=stdout',
    ...test.files,
  ];
}

function runSuite(test, { root, scratch, label }) {
  const evidencePath = join(scratch, `${label.replaceAll(/[^a-z0-9-]/giu, '_')}.json`);
  rmSync(evidencePath, { force: true });
  const result = spawnSync(process.execPath, suiteArguments(test, evidencePath), {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  // A spawn that never started, or a process killed by a signal, reports
  // status null — which `status !== 0` would happily read as a red.
  const spawnFailure =
    result.error !== undefined
      ? String(result.error.message)
      : result.status === null
        ? `terminated by signal ${String(result.signal)}`
        : undefined;
  return {
    output,
    results: readEvidence(evidencePath),
    signal: result.signal,
    spawnFailure,
    status: result.status,
  };
}

/**
 * The execution counter. An absent or unparseable artifact means the run
 * produced no evidence it executed anything, which is reported as zero results
 * and refused by the callers rather than being silently tolerated.
 */
function readEvidence(evidencePath) {
  if (!existsSync(evidencePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(evidencePath, 'utf8'));
    return Array.isArray(parsed?.results) ? parsed.results : [];
  } catch {
    return [];
  }
}

function passingIdentities(results) {
  return new Set(
    results
      .filter((result) => result.status === 'pass')
      .map((result) => `${result.file}::${result.name}`),
  );
}

function identitiesNamed(identities, name) {
  for (const identity of identities) {
    if (identity.split('::').slice(1).join('::') === name) return true;
  }
  return false;
}

function commandKey(test) {
  return JSON.stringify([test.files, test.namePattern ?? null]);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}

function tail(output, lines = 24) {
  return output.trimEnd().split('\n').slice(-lines).join('\n');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

export function assertCleanTrackedTree(root = REPOSITORY_ROOT) {
  const result = spawnSync('git', ['diff', '--quiet'], { cwd: root, encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    'expected-red evidence requires a clean tracked tree: a crashed run is recovered with `git checkout -- <file>`, which would otherwise eat uncommitted work',
  );
}

// ---------------------------------------------------------------------------
// CLI. `scripts/check-expected-red.sh` is the gate; this is the work it does.
// ---------------------------------------------------------------------------

function main(argv) {
  const [mode, ...selected] = argv;
  const { entries, paths, problems } = loadManifests();

  if (mode === 'list') {
    for (const entry of entries) {
      process.stdout.write(`${entry.name}\t${entry.file}\t${entry.manifest}\n`);
    }
    return problems.length === 0 ? 0 : 1;
  }

  if (problems.length > 0) {
    process.stderr.write('expected-red: FAIL\n\n');
    for (const problem of problems) {
      process.stderr.write(`  ${problem.code}\n    at ${problem.where}\n    ${problem.detail}\n\n`);
    }
    process.stderr.write(
      '  A manifest entry whose production text has drifted measures nothing, and a\n' +
        '  runner that treated a missing victim as "nothing to do" would report green\n' +
        '  forever. Re-point the entry at the current source, or delete it and say in\n' +
        '  the packet record which claim lost its executable evidence.\n',
    );
    return 1;
  }

  if (mode === 'validate') {
    process.stdout.write(
      `expected-red: OK (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in ${paths.length} manifest(s) still name live production text)\n`,
    );
    return 0;
  }

  if (mode !== 'run') {
    process.stderr.write('Usage: expected-red.mjs <validate|run|list> [entry-name...]\n');
    return 2;
  }

  const unknown = selected.filter((name) => !entries.some((entry) => entry.name === name));
  if (unknown.length > 0) {
    process.stderr.write(`expected-red: unknown entr(ies): ${unknown.join(', ')}\n`);
    return 2;
  }
  const chosen =
    selected.length === 0
      ? entries
      : entries.filter((entry) => selected.includes(entry.name));
  // Selecting nothing is not a green run over an empty set.
  if (chosen.length === 0) {
    process.stderr.write('expected-red: FAIL — no entry was selected, so nothing was measured\n');
    return 1;
  }
  runEntries(chosen);
  process.stdout.write(`expected-red: OK (${chosen.length} expected red(s) reproduced and restored)\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write('expected-red: FAIL\n\n');
    process.stderr.write(`  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
