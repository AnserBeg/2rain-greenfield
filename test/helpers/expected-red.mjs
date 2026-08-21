#!/usr/bin/env node
/**
 * The expected-red runner: apply one named, one-property mutation to production,
 * run the focused suite, require the exact expected red from the exact test that
 * must produce it, restore.
 *
 * This is `test/integration/scoped-create-operand-mutations.mjs` lifted out of
 * one packet. That file converged its packet in two rounds while its neighbours
 * took four to seven, and it was the only committed mutation runner in the tree;
 * every other packet's reds live in review-log prose and are executable never
 * again. The 2026-08-20 program review's R2 asked for this generalization.
 *
 * WHAT THIS PROVES. For each manifest entry: the named production text was
 * present and unique; the focused suite passed with at least one executed test
 * before the mutation; the mutation changed the file on disk and the file was
 * still mutated when the run ended; the suite then failed; the set of tests that
 * stopped passing is EXACTLY the declared `kills`, compared file-qualified; each
 * declared kill is present in the mutated run as an explicit FAILURE rather than
 * merely absent; and `expected` matches the failure message of those killed
 * tests — not the transcript at large.
 *
 * THE LAST TWO CLAUSES ARE THE 2026-08-21 REVIEW'S FIRST FINDING. Comparing a
 * pass-set difference and separately grepping the whole transcript is a
 * Cartesian conjunction: a declared victim can vanish without failing while an
 * unrelated failure supplies the expected text, and both checks pass. Binding
 * the message to the failing identity is what makes the pair one observation.
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

import {
  digestOf,
  digestOfFile,
  measureSuiteRun,
} from './expected-red-measure.mjs';

export const MANIFEST_GLOB = 'test/evidence/*.expected-red.json';
export const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
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
  return override !== undefined && override.length > 0
    ? override
    : MANIFEST_GLOB;
}

/**
 * The files a mutation run has deliberately changed and not yet restored.
 *
 * Validation reads the WORKING TREE, so a validate run racing a --run run would
 * report the live mutation as drift — a FAIL naming a real absence for an unreal
 * reason. That is the `gate-reads-a-different-thing-than-its-name` class, so it
 * is refused with "cannot determine" rather than answered wrongly.
 *
 * READ BEFORE THE MANIFESTS, not after. The 2026-08-21 review found the earlier
 * ordering unreachable in practice: a real in-flight mutation REMOVES the
 * `original` text a manifest names, so validation reported
 * EXPECTED_RED_VICTIM_ABSENT before it ever consulted the journal, and the
 * control that claimed to cover the race only ever exercised a journal with no
 * mutation behind it.
 */
export function inFlightMutation(root = REPOSITORY_ROOT) {
  const journalPath = resolve(root, JOURNAL);
  if (!existsSync(journalPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(journalPath, 'utf8'));
    return Array.isArray(parsed?.mutated) && parsed.mutated.length > 0
      ? parsed.mutated
      : undefined;
  } catch {
    return undefined;
  }
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
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest)
  ) {
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
    fail(
      'EXPECTED_RED_ENTRY_SHAPE',
      'replacement must be a string (empty deletes)',
    );
  } else if (entry.replacement === entry.original) {
    fail(
      'EXPECTED_RED_NO_MUTATION',
      'replacement equals original, so nothing changes',
    );
  }

  let expected;
  if (!isNonEmptyString(entry.expected)) {
    fail(
      'EXPECTED_RED_ENTRY_SHAPE',
      'expected must be a regular-expression source string',
    );
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
  const declaredFiles = new Set();
  if (test === null || typeof test !== 'object' || Array.isArray(test)) {
    fail(
      'EXPECTED_RED_ENTRY_SHAPE',
      'test must be an object naming files and an optional namePattern',
    );
  } else {
    if (!Array.isArray(test.files) || test.files.length === 0) {
      fail('EXPECTED_RED_ENTRY_SHAPE', 'test.files must be a non-empty array');
    } else {
      for (const file of test.files) {
        if (!isNonEmptyString(file) || !existsSync(resolve(root, file))) {
          fail(
            'EXPECTED_RED_TEST_MISSING',
            `test file ${String(file)} does not exist`,
          );
        } else declaredFiles.add(file);
      }
    }
    if (test.namePattern !== undefined && !isNonEmptyString(test.namePattern)) {
      fail(
        'EXPECTED_RED_ENTRY_SHAPE',
        'test.namePattern must be a non-empty string when present',
      );
    }
  }

  // A red count is not attribution, and a bare test NAME is not attribution
  // either: two files may legitimately carry the same test name, so killing
  // either one would satisfy a name-only declaration. Kills are file-qualified.
  if (!Array.isArray(entry.kills) || entry.kills.length === 0) {
    fail(
      'EXPECTED_RED_KILLS_MISSING',
      'kills must name the tests this mutation must break, as {file, name}',
    );
  } else {
    const seen = new Set();
    for (const kill of entry.kills) {
      if (
        kill === null ||
        typeof kill !== 'object' ||
        Array.isArray(kill) ||
        !isNonEmptyString(kill.file) ||
        !isNonEmptyString(kill.name)
      ) {
        fail(
          'EXPECTED_RED_ENTRY_SHAPE',
          'every kills entry must be {file, name} with non-empty strings',
        );
        continue;
      }
      if (declaredFiles.size > 0 && !declaredFiles.has(kill.file)) {
        fail(
          'EXPECTED_RED_KILL_FILE_UNRUN',
          `kills names ${kill.file}, which test.files does not run`,
        );
      }
      const key = `${kill.file}::${kill.name}`;
      if (seen.has(key)) {
        fail('EXPECTED_RED_ENTRY_SHAPE', `kills repeats ${key}`);
      }
      seen.add(key);
    }
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
export function runEntries(
  entries,
  { root = REPOSITORY_ROOT, log = process.stdout } = {},
) {
  // The ENTRY precondition. It carries its own code because the review found
  // that sharing one message with the exit postcondition made the control for
  // this check pass after the check itself was deleted: the run proceeded on
  // dirty bytes, restored them, and the exit assertion produced the same words.
  assertFrozenTree(root, 'EXPECTED_RED_TREE_NOT_FROZEN');
  // The tree matches HEAD, so any surviving journal is a crashed run's litter
  // whose subject has already been recovered. Clearing it keeps validate
  // answerable.
  rmSync(resolve(root, JOURNAL), { force: true });
  const baselines = new Map();
  const scratch = mkdtempSync(join(tmpdir(), 'expected-red-'));
  let run = 0;
  try {
    for (const entry of entries) {
      const key = commandKey(entry.test);
      if (!baselines.has(key)) {
        baselines.set(
          key,
          measureBaseline(entry, { root, scratch, log, run: (run += 1) }),
        );
      }
      runOneEntry(entry, baselines.get(key), {
        root,
        scratch,
        log,
        run: (run += 1),
      });
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
  // The EXIT postcondition, with its own code: a run that leaves any tracked
  // byte changed did not restore what it mutated.
  assertFrozenTree(root, 'EXPECTED_RED_TREE_NOT_RESTORED');
  return entries.length;
}

function measureBaseline(entry, { root, scratch, log, run }) {
  const measured = measureSuiteRun(entry.test, {
    root,
    scratch,
    label: `${run}-${entry.name}-baseline`,
  });
  assert.equal(
    measured.spawnFailure,
    undefined,
    `${entry.name}: the baseline suite could not be started (${measured.spawnFailure})`,
  );
  assert.equal(
    measured.status,
    0,
    `${entry.name}: the suite is not green before the mutation, so no red it produces can be attributed to the mutation\n${tail(measured.output)}`,
  );
  // The check reading zero input. A --test-name-pattern that matches nothing
  // exits 0, and without this the mutated run's non-zero exit would be the only
  // thing distinguishing "nothing ran" from "the seam held".
  assert.ok(
    measured.results.length > 0,
    `${entry.name}: the baseline executed no test — the pattern or file selects nothing`,
  );
  const passing = identitiesOf(measured.results, 'pass', root);
  assert.equal(
    passing.size,
    measured.results.length,
    `${entry.name}: the baseline is not wholly green, or reports two results under one file-qualified identity`,
  );
  log.write(`EXPECTED_RED_BASELINE ${entry.name} ${passing.size} passing\n`);
  return { passing };
}

function runOneEntry(entry, baseline, { root, scratch, log, run }) {
  const expected = new RegExp(entry.expected, 'u');
  const path = resolve(root, entry.file);
  const declared = entry.kills
    .map((kill) => identityOf(resolve(root, kill.file), kill.name))
    .sort();

  // Declared kills must be tests that actually pass at baseline. A kill naming
  // a test that never ran would be satisfied by its permanent absence.
  const missing = declared.filter(
    (identity) => !baseline.passing.has(identity),
  );
  assert.deepEqual(
    missing,
    [],
    `${entry.name}: kills names ${JSON.stringify(missing.map(readableIdentity))}, which did not pass at baseline`,
  );

  const originalSource = readFileSync(path, 'utf8');
  assert.equal(
    occurrences(originalSource, entry.original),
    1,
    `${entry.name}: production victim must be present exactly once in ${entry.file}`,
  );
  const mutatedSource = originalSource.replace(
    entry.original,
    entry.replacement,
  );
  assert.notEqual(
    mutatedSource,
    originalSource,
    `${entry.name}: the mutation produced an identical file`,
  );
  const mutatedDigest = digestOf(mutatedSource);

  const observation = withMutation(
    { path, originalSource, mutatedSource, root },
    () => {
      const measured = measureSuiteRun(entry.test, {
        root,
        scratch,
        label: `${run}-${entry.name}`,
      });
      // Read the subject back BEFORE the restore in withMutation's finally. If
      // anything healed the file while the suite ran, the digests diverge here
      // and the run is refused rather than credited. measureSuiteRun and
      // digestOfFile both come from a module that imports no write capability,
      // so this measurement genuinely cannot be the thing that healed it.
      return { ...measured, observedDigest: digestOfFile(path) };
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

  const stillPassing = identitiesOf(observation.results, 'pass', root);
  const regressed = [...baseline.passing]
    .filter((identity) => !stillPassing.has(identity))
    .sort();
  assert.deepEqual(
    regressed.map(readableIdentity),
    declared.map(readableIdentity),
    `${entry.name}: the red is not attributable — declared kills ${JSON.stringify(declared.map(readableIdentity))} but the mutation stopped ${JSON.stringify(regressed.map(readableIdentity))}`,
  );

  // THE JOIN. A test stops passing when it fails, and also when it is skipped,
  // never registered, or dropped after a parent's failure. Only the first is a
  // kill, and only the first carries a message that can be required to be the
  // declared one. Both halves are asserted against the same identities.
  const failuresByIdentity = new Map(
    observation.results
      .filter((result) => result.status === 'fail')
      .map((result) => [identityOf(result.file, result.name), result.message]),
  );
  const notFailed = declared.filter(
    (identity) => !failuresByIdentity.has(identity),
  );
  assert.deepEqual(
    notFailed.map(readableIdentity),
    [],
    `${entry.name}: ${JSON.stringify(notFailed.map(readableIdentity))} stopped passing without failing — absent, skipped or never registered is not a kill`,
  );
  const declaredFailureText = declared
    .map((identity) => failuresByIdentity.get(identity) ?? '')
    .join('\n');
  assert.match(
    declaredFailureText,
    expected,
    `${entry.name}: the declared test failed for a different reason than the one declared\n${tail(declaredFailureText)}`,
  );
  log.write(`MUTATION_RED ${entry.name} ${declared.length} killed\n`);
}

/**
 * Applies the mutation, runs the measurer, and restores afterwards.
 *
 * The measurer is a thunk: it receives nothing, and everything it can reach
 * comes from `expected-red-measure.mjs`, which imports no write capability. The
 * earlier version passed a narrow parameter object while the callback's own
 * closure still held `path`, `originalSource` and `writeFileSync` — a claimed
 * separation that did not exist, as the 2026-08-21 review pointed out.
 *
 * The journal exists for the case `finally` cannot cover. A SIGKILL mid-run
 * leaves the mutated file on disk, and the journal names it. Recovery is
 * `git checkout -- <file>`, which is lossless precisely because the runner
 * refuses to start unless the tree matches HEAD.
 */
function withMutation({ path, originalSource, mutatedSource, root }, measure) {
  const journalPath = resolve(root, JOURNAL);
  mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(
    journalPath,
    `${JSON.stringify({ mutated: [path] }, undefined, 2)}\n`,
  );
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
    return measure();
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    restore();
  }
}

function identitiesOf(results, status, root) {
  return new Set(
    results
      .filter((result) => result.status === status)
      .map((result) => identityOf(resolve(root, result.file), result.name)),
  );
}

function identityOf(file, name) {
  return JSON.stringify([file, name]);
}

function readableIdentity(identity) {
  const [file, name] = JSON.parse(identity);
  return `${file}::${name}`;
}

function commandKey(test) {
  return JSON.stringify([test.files, test.namePattern ?? null]);
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

/**
 * Compares the tracked tree with HEAD, staged changes included.
 *
 * `git diff --quiet` alone compares the working tree with the INDEX, so a
 * staged-only modification passed it. Evidence could then be produced against
 * bytes that are not the frozen candidate's while the runner reported that it
 * had required a clean tree. Found by the 2026-08-21 review and confirmed
 * against git directly.
 */
export function assertFrozenTree(root = REPOSITORY_ROOT, code) {
  const result = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `${code}: expected-red evidence requires a tracked tree identical to HEAD, staged changes included. A crashed run is recovered with \`git checkout -- <file>\`, and the measurement must come from the committed candidate.`,
  );
}

// ---------------------------------------------------------------------------
// CLI. `scripts/check-expected-red.sh` is the gate; this is the work it does.
// ---------------------------------------------------------------------------

function main(argv) {
  const [mode, ...selected] = argv;

  // Before the manifests, not after: a real in-flight mutation removes the
  // `original` a manifest names, so loading first made this branch unreachable.
  const inFlight = inFlightMutation();
  if (inFlight !== undefined && mode !== 'run') {
    process.stderr.write(
      'expected-red: CANNOT VALIDATE\n\n' +
        `  A mutation run is in flight and has deliberately changed:\n    ${inFlight.join('\n    ')}\n\n` +
        '  Validation reads the working tree, so anything reported now would be that\n' +
        '  mutation rather than drift. Re-run when it finishes.\n\n' +
        '  If nothing is running, the run was killed. Recover the named file with\n' +
        `    git checkout -- <file>\n  and delete ${JOURNAL}.\n`,
    );
    return 2;
  }

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
      process.stderr.write(
        `  ${problem.code}\n    at ${problem.where}\n    ${problem.detail}\n\n`,
      );
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
    process.stderr.write(
      'Usage: expected-red.mjs <validate|run|list> [entry-name...]\n',
    );
    return 2;
  }

  const unknown = selected.filter(
    (name) => !entries.some((entry) => entry.name === name),
  );
  if (unknown.length > 0) {
    process.stderr.write(
      `expected-red: unknown entr(ies): ${unknown.join(', ')}\n`,
    );
    return 2;
  }
  const chosen =
    selected.length === 0
      ? entries
      : entries.filter((entry) => selected.includes(entry.name));
  runEntries(chosen);
  process.stdout.write(
    `expected-red: OK (${chosen.length} expected red(s) reproduced and restored)\n`,
  );
  return 0;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write('expected-red: FAIL\n\n');
    process.stderr.write(
      `  ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
