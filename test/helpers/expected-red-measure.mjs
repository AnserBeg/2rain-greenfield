/**
 * Running a suite and reading what it produced. Nothing else.
 *
 * THIS MODULE IMPORTS NO WRITE CAPABILITY, AND THAT IS THE POINT. AGENTS.md
 * section 6 says a verifier must never share a code path with the thing that
 * heals what it verifies. The previous arrangement claimed that separation
 * because `withMutation` handed its measurer a narrow parameter object — but
 * the measurer was a closure declared beside `path`, `originalSource` and an
 * imported `writeFileSync`, so it retained every restoration capability it was
 * supposedly denied. The 2026-08-21 review said so, and it was right.
 *
 * The separation is now a fact about this file's import list: no
 * `writeFileSync`, no `rmSync`, no `spawnSync('git', …)`. A reviewer checks it
 * by reading six lines rather than by tracing a scope. Evidence paths are
 * unique per run so nothing here needs to delete anything either.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const REPORTER = './test/helpers/expected-red-reporter.mjs';

/**
 * Builds the node argv itself rather than accepting one from a manifest. A
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

export function digestOf(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Reads a file and digests it. Read-only, by construction. */
export function digestOfFile(path) {
  return digestOf(readFileSync(path, 'utf8'));
}

/**
 * The complete observation: run the suite, then read the subject back — both
 * inside this module, from plain data arguments. Nothing here closes over the
 * caller's scope, so the observation cannot reach `originalSource` or any write.
 *
 * The round-2 review was right that the earlier arrangement did not establish
 * this: the observation was a thunk DECLARED in the writer-capable module, beside
 * `path` and `originalSource`. Moving the two called primitives was not the same
 * as moving the operation.
 */
export function observeMutatedRun({ test, root, scratch, label, subjectPath }) {
  const measured = measureSuiteRun(test, { root, scratch, label });
  // Read back BEFORE the caller restores. If anything healed the subject while
  // the suite ran, the digest diverges and the run is refused.
  return { ...measured, observedDigest: digestOfFile(subjectPath) };
}

export function measureSuiteRun(test, { root, scratch, label }) {
  const evidencePath = join(
    scratch,
    `${label.replaceAll(/[^a-z0-9-]/giu, '_')}.json`,
  );
  const result = spawnSync(
    process.execPath,
    suiteArguments(test, evidencePath),
    {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  // A spawn that never started, or a process killed by a signal, reports status
  // null — which a bare `status !== 0` would happily read as a red.
  const spawnFailure =
    result.error !== undefined
      ? String(result.error.message)
      : result.status === null
        ? `terminated by signal ${String(result.signal)}`
        : undefined;
  const evidence = readEvidence(evidencePath);
  return {
    files: evidence.files,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    results: evidence.results,
    spawnFailure,
    status: result.status,
  };
}

/**
 * The execution record. An absent or unparseable artifact means the run
 * produced no evidence that it executed anything, which is reported as zero
 * results and refused by the caller rather than silently tolerated.
 */
function readEvidence(evidencePath) {
  const empty = { files: [], results: [] };
  if (!existsSync(evidencePath)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(evidencePath, 'utf8'));
    return {
      files: Array.isArray(parsed?.files) ? parsed.files : [],
      results: Array.isArray(parsed?.results) ? parsed.results : [],
    };
  } catch {
    return empty;
  }
}
