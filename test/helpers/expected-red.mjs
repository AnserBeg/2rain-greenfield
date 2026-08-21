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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

import {
  digestOf,
  measureSuiteRun,
  observeMutatedRun,
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
 * The manifest glob. Overridable ONLY by an explicit `--manifest` argument, which
 * the self-test passes; there is no environment override.
 *
 * There used to be one, and it was honoured in every mode. An inherited
 * `EXPECTED_RED_MANIFEST_GLOB` could therefore redirect the real
 * `check:expected-red` away from the whole committed evidence population and
 * report OK over a single fixture — the 2026-08-21 round-4 review's first
 * finding. An env var is inherited silently; an argument is visible at the call
 * site. The variable is now refused outright rather than ignored, so a stale one
 * fails loudly instead of quietly redirecting the gate.
 */
function manifestGlobFrom(override) {
  return override !== undefined && override.length > 0
    ? override
    : MANIFEST_GLOB;
}

export function assertNoInheritedOverride() {
  assert.equal(
    process.env.EXPECTED_RED_MANIFEST_GLOB,
    undefined,
    'EXPECTED_RED_OVERRIDE_REFUSED: EXPECTED_RED_MANIFEST_GLOB is set. The manifest population is a property of the frozen candidate, not of the environment; pass --manifest explicitly if you mean to point the self-test at a fixture.',
  );
}

/**
 * Every path the gate reads or mutates must belong to the frozen candidate.
 *
 * `existsSync` admitted absolute paths, `../` escapes, untracked files and
 * symlinks, while `git diff --quiet HEAD --` ignores untracked files entirely —
 * so the runner could mutate and certify bytes that are in no commit. Round 4
 * found it. Membership is checked against `git ls-files`, and a symlink is
 * refused because its target is not what the tracked entry names.
 */
function trackedFiles(root) {
  // `git ls-files` describes the INDEX, so a staged-but-uncommitted file counts
  // as tracked. The candidate is the commit, so membership is read from the
  // HEAD tree. Found by the round-5 review.
  const listed = spawnSync(
    'git',
    ['ls-tree', '-r', '-z', '--name-only', 'HEAD'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(
    listed.status,
    0,
    'EXPECTED_RED_TRACKED_LIST_FAILED: git ls-tree HEAD did not run',
  );
  return new Set(
    listed.stdout
      .split('\0')
      .filter(Boolean)
      .map((path) => resolve(root, path)),
  );
}

function pathProblem(candidate, root, tracked) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return 'must be a non-empty repository-relative path';
  }
  if (isAbsolute(candidate)) return 'must be repository-relative, not absolute';
  const resolved = resolve(root, candidate);
  if (
    resolved !== join(root, candidate) ||
    relative(root, resolved).startsWith('..')
  ) {
    return 'resolves outside the repository';
  }
  if (!existsSync(resolved)) return 'does not exist';
  const stats = lstatSync(resolved);
  if (stats.isSymbolicLink())
    return 'is a symlink, so its bytes are not the tracked entry';
  if (!stats.isFile()) return 'is not a regular file';
  if (!tracked.has(resolved)) {
    return 'is not tracked by git, so it is not part of the frozen candidate';
  }
  return undefined;
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

export function discoverManifestPaths(root = REPOSITORY_ROOT, override) {
  return globSync(manifestGlobFrom(override), { cwd: root }).sort();
}

export function loadManifests(root = REPOSITORY_ROOT, override) {
  const problems = [];
  const entries = [];
  const tracked = trackedFiles(root);
  const paths = discoverManifestPaths(root, override);

  // The check reading zero input is a vacuity vector in its own right: a glob
  // that matches nothing must fail, never report OK over an empty set.
  if (paths.length === 0) {
    problems.push({
      code: 'EXPECTED_RED_NO_MANIFESTS',
      where: manifestGlobFrom(override),
      detail: 'no manifest was discovered, so the gate would pass over nothing',
    });
    return { entries, paths, problems };
  }

  const seenNames = new Map();
  for (const path of paths) {
    const manifestProblem = pathProblem(path, root, tracked);
    if (manifestProblem !== undefined) {
      problems.push({
        code: 'EXPECTED_RED_PATH_NOT_IN_CANDIDATE',
        where: path,
        detail: `the manifest ${manifestProblem}`,
      });
      continue;
    }
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
      for (const problem of validateEntry(entry, where, root, tracked)) {
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

function validateEntry(entry, where, root, tracked) {
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

  const subjectProblem = pathProblem(entry.file, root, tracked);
  if (subjectProblem !== undefined) {
    fail(
      'EXPECTED_RED_PATH_NOT_IN_CANDIDATE',
      `the mutation subject ${String(entry.file)} ${subjectProblem}`,
    );
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

  // `expected` belongs to each KILL, not to the entry. One pattern applied to
  // the concatenation of every declared failure's message is satisfied when any
  // one of them carries it — the round-3 review's finding, and the same
  // Cartesian conjunction this ADR exists to close, moved inside the kill set.
  if (entry.expected !== undefined) {
    fail(
      'EXPECTED_RED_ENTRY_EXPECTED_MOVED',
      'expected is declared per kill, not per entry: each declared kill states the reason it must die for',
    );
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
        const problem = pathProblem(file, root, tracked);
        if (problem !== undefined) {
          fail(
            'EXPECTED_RED_PATH_NOT_IN_CANDIDATE',
            `test file ${String(file)} ${problem}`,
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
      if (!isNonEmptyString(kill.expected)) {
        fail(
          'EXPECTED_RED_KILL_EXPECTED_MISSING',
          `kills entry ${kill.name} states no expected failure reason`,
        );
      } else {
        let pattern;
        try {
          pattern = new RegExp(kill.expected, 'u');
        } catch (error) {
          fail(
            'EXPECTED_RED_PATTERN_INVALID',
            String(error instanceof Error ? error.message : error),
          );
        }
        if (pattern !== undefined) {
          const matched = GREEN_CANARIES.filter((canary) =>
            pattern.test(canary),
          );
          if (matched.length > 0) {
            fail(
              'EXPECTED_RED_PATTERN_NOT_DISCRIMINATING',
              `the expected reason for ${kill.name} matches green transcript text ${JSON.stringify(matched[0])}; a pattern that matches a passing run is not the identity of a red`,
            );
          }
        }
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
  const scratch = mkdtempSync(join(tmpdir(), 'expected-red-'));
  let run = 0;
  try {
    for (const entry of entries) {
      // Mutated first, then restored — an ORDERING, and nothing more.
      //
      // It stops this invocation from manufacturing its own co-cause: a suite
      // that leaves state behind cannot have its baseline's leavings be the
      // reason its mutated run reds, because there is no baseline before it.
      //
      // IT DOES NOT ESTABLISH A CLEAN START, AND THE GATE DOES NOT CLAIM ONE.
      // State left by a previous invocation, another suite, a database or a
      // container is still ambient, and control K1 pins that the gate certifies
      // exactly such a red. Closing it needs a per-entry isolation contract,
      // which is routed rather than pretended — see
      // `expected-red-needs-an-initial-state-contract` in current-plan.md.
      runOneEntry(entry, { root, scratch, log, run: (run += 1) });
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
  // The EXIT postcondition, with its own code: a run that leaves any tracked
  // byte changed did not restore what it mutated.
  assertFrozenTree(root, 'EXPECTED_RED_TREE_NOT_RESTORED');
  return entries.length;
}

function measurePhase(entry, { root, scratch, run, phase }) {
  const measured = measureSuiteRun(entry.test, {
    root,
    scratch,
    label: `${run}-${entry.name}-${phase}`,
  });
  assert.equal(
    measured.spawnFailure,
    undefined,
    `${entry.name}: the ${phase} suite could not be started (${measured.spawnFailure})`,
  );
  assert.ok(
    measured.results.length > 0,
    `${entry.name}: the ${phase} run executed no test — the pattern or file selects nothing`,
  );
  assertEvidenceReconciles(entry, measured, root, phase);
  return measured;
}

function runOneEntry(entry, { root, scratch, log, run }) {
  const path = resolve(root, entry.file);
  const declared = entry.kills
    .map((kill) => identityOf(resolve(root, kill.file), kill.name))
    .sort();

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

  // PHASE B — the mutation, measured before anything else has run.
  const observation = withMutation(
    { path, originalSource, mutatedSource, root },
    observeMutatedRun,
    {
      label: `${run}-${entry.name}-mutated`,
      root,
      scratch,
      subjectPath: path,
      test: entry.test,
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
  assertEvidenceReconciles(entry, observation, root, 'mutated');

  // PHASE A — the restored suite. It must be wholly green, and it is the
  // reference the kill set is computed against.
  const restored = measurePhase(entry, {
    root,
    scratch,
    run,
    phase: 'restored',
  });
  const reference = identitiesOf(restored.results, 'pass', root);
  assert.equal(
    reference.size,
    restored.results.length,
    `${entry.name}: the restored suite is not wholly green, so it cannot serve as the reference the kill set is measured against`,
  );
  log.write(`EXPECTED_RED_RESTORED ${entry.name} ${reference.size} passing\n`);

  const missing = declared.filter((identity) => !reference.has(identity));
  assert.deepEqual(
    missing.map(readableIdentity),
    [],
    `${entry.name}: kills names ${JSON.stringify(missing.map(readableIdentity))}, which does not pass with production restored`,
  );

  // EVERY outcome the mutation produced is accounted for, not only the declared
  // ones. Round 5: excluding every `aggregate` identity from the regression set
  // meant a sibling whose `beforeEach` threw under the same mutation vanished
  // from the comparison, and a test registered only under the mutation was never
  // looked at at all. Both are consequences the entry did not declare.
  const stillPassing = identitiesOf(observation.results, 'pass', root);
  const resultByIdentity = new Map(
    observation.results.map((result) => [
      identityOf(resolve(root, result.file), result.name),
      result,
    ]),
  );
  const declaredSet = new Set(declared);
  const regressed = [...reference]
    .filter((identity) => !stillPassing.has(identity))
    .sort();

  const keptPassing = declared.filter(
    (identity) => !regressed.includes(identity),
  );
  assert.deepEqual(
    keptPassing.map(readableIdentity),
    [],
    `${entry.name}: declared kills ${JSON.stringify(keptPassing.map(readableIdentity))} kept passing under the mutation`,
  );

  // An undeclared regression is admissible ONLY as a parent Node reported
  // `subtestsFailed` in a file where a declared kill lives: that parent failed
  // because its descendant did, and the descendant IS declared. A `hookFailed`
  // sibling, a cancellation, or a failure type this classifier has not met is an
  // undeclared consequence and refuses.
  for (const identity of regressed.filter((id) => !declaredSet.has(id))) {
    const result = resultByIdentity.get(identity);
    const derivedFromADeclaredKill =
      result?.status === 'aggregate' &&
      result?.failureType === 'subtestsFailed' &&
      declared.some((kill) => JSON.parse(kill)[0] === JSON.parse(identity)[0]);
    assert.ok(
      derivedFromADeclaredKill,
      `${entry.name}: ${readableIdentity(identity)} also stopped passing and the entry does not declare it — every outcome the mutation produces must be accounted for`,
    );
  }

  // A non-passing result the restored run never produced is a consequence too:
  // a suite may register a test only under the mutation.
  for (const result of observation.results) {
    if (result.status === 'pass') continue;
    const identity = identityOf(resolve(root, result.file), result.name);
    assert.ok(
      reference.has(identity),
      `${entry.name}: ${readableIdentity(identity)} exists only under the mutation and is not accounted for`,
    );
  }

  // Only `status === 'fail'` — a body that ran and failed. A cancelled child, a
  // timeout, an abort, a parent reported `subtestsFailed` and a child reported
  // `hookFailed` all arrive as `test:fail` and none of them is that.
  const failuresByIdentity = new Map(
    observation.results
      .filter((result) => result.status === 'fail')
      .map((result) => [
        identityOf(resolve(root, result.file), result.name),
        result.message,
      ]),
  );
  const notFailed = declared.filter(
    (identity) => !failuresByIdentity.has(identity),
  );
  assert.deepEqual(
    notFailed.map(readableIdentity),
    [],
    `${entry.name}: ${JSON.stringify(notFailed.map(readableIdentity))} stopped passing without its body failing — absent, skipped, cancelled, timed out or failed in a hook is not a kill`,
  );

  // Each declared kill must fail for ITS OWN declared reason.
  for (const kill of entry.kills) {
    const identity = identityOf(resolve(root, kill.file), kill.name);
    assert.match(
      failuresByIdentity.get(identity) ?? '',
      new RegExp(kill.expected, 'u'),
      `${entry.name}: ${kill.name} failed for a different reason than the one declared for it\n${tail(failuresByIdentity.get(identity) ?? '')}`,
    );
  }
  log.write(`MUTATION_RED ${entry.name} ${declared.length} killed\n`);
}

/**
 * Applies the mutation, runs the measurer, and restores afterwards.
 *
 * `observe` is a FUNCTION DEFINED ELSEWHERE — `observeMutatedRun`, in
 * `expected-red-measure.mjs`, which imports no write capability — and it is
 * called with plain data. It is not a closure declared here, which would carry
 * `path`, `originalSource` and this module's `writeFileSync` whatever its
 * parameter list said. Two weaker arrangements were refuted in review: a narrow
 * parameter object handed to exactly such a closure, and then moving the two
 * called primitives while the operation stayed here.
 *
 * The journal exists for the case `finally` cannot cover. A SIGKILL mid-run
 * leaves the mutated file on disk, and the journal names it. Recovery is
 * `git checkout -- <file>`, which is lossless precisely because the runner
 * refuses to start unless the tree matches HEAD.
 */
function withMutation(
  { path, originalSource, mutatedSource, root },
  observe,
  observeArguments,
) {
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
    return observe(observeArguments);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    restore();
  }
}

/**
 * What the runner credited must equal what Node counted, per file.
 *
 * This is the round-1 correction the lane skipped and round 2 required: without
 * it, a record the reporter invented or omitted is invisible. It is also what
 * refuses Node's file-level wrapper independently of the ledger — a file that
 * throws at import reports no summary, so there is nothing to reconcile against.
 */
function assertEvidenceReconciles(entry, measured, root, phase) {
  const byFile = new Map(
    measured.files.map((file) => [resolve(root, file.file), file]),
  );
  for (const file of entry.test.files) {
    const resolved = resolve(root, file);
    const summary = byFile.get(resolved);
    assert.ok(
      summary !== undefined,
      `${entry.name}: ${file} reported no summary in the ${phase} run — the file did not complete, so any result attributed to it is Node's own wrapper rather than an executed test`,
    );
    const credited = measured.results.filter(
      (result) => resolve(root, result.file) === resolved,
    );
    const tally = (status) =>
      credited.filter((result) => result.status === status).length;
    // `fail` and `aggregate` are both counted by Node under `failed`; only
    // `fail` may ever satisfy a kill. Collapsing them made a parent whose
    // subtest fails reconcile as cancelled against a Node count of failed.
    assert.deepEqual(
      {
        cancelled: tally('cancelled'),
        failed: tally('fail') + tally('aggregate'),
        passed: tally('pass'),
      },
      {
        cancelled: summary.cancelled,
        failed: summary.failed,
        passed: summary.passed,
      },
      `${entry.name}: the ${phase} evidence for ${file} does not reconcile with Node's own counts`,
    );
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
  // The manifest population belongs to the frozen candidate. An inherited
  // environment override could silently redirect the real gate; it is refused.
  assertNoInheritedOverride();
  // EVERY mode, not only `run`. `validate` and `list` read manifests, subjects
  // and test files from the filesystem, so an uncommitted repair could make the
  // gate answer OK while the committed candidate was still stale. Asserting the
  // tree equals HEAD first is what makes a filesystem read a read of the
  // candidate. Found by the round-5 review.
  let override;
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--manifest') {
      override = argv[index + 1];
      index += 1;
      continue;
    }
    rest.push(argv[index]);
  }
  const [mode, ...selected] = rest;

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

  // EVERY mode, not only `run`. `validate` and `list` read manifests, subjects
  // and test files from the filesystem, so an uncommitted repair could make the
  // gate answer OK while the committed candidate was still stale. Asserting the
  // tree equals HEAD first is what makes a filesystem read a read of the
  // candidate. Found by the round-5 review. It runs AFTER the in-flight check so
  // a live mutation still reports the message that names the held file.
  assertFrozenTree(REPOSITORY_ROOT, 'EXPECTED_RED_TREE_NOT_FROZEN');

  const { entries, paths, problems } = loadManifests(REPOSITORY_ROOT, override);

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
      'Usage: expected-red.mjs <validate|run|list> [--manifest <glob>] [entry-name...]\n',
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
