import { createNodeResultLedger } from './node-reporter-core.mjs';

/**
 * How Node 22.22.2 classifies a `test:fail`, measured 2026-08-21. Two questions
 * are separate and were previously conflated:
 *
 *  1. **Does Node count it under `failed` or `cancelled`?** That decides what
 *     reconciliation must expect. `cancelledByParent`, `testTimeoutFailure` and
 *     an aborted test — which carries NO `failureType` at all — are counted
 *     under `cancelled`. Everything else, including `hookFailed` and
 *     `subtestsFailed`, is counted under `failed`.
 *  2. **Did the test's own body run and fail?** Only then may it satisfy a
 *     declared kill. A parent reported `subtestsFailed` passed its own body; a
 *     child reported `hookFailed` never entered one.
 *
 * Collapsing these made a parent whose subtest fails reconcile as `cancelled`
 * against a Node count of `failed` — a false REFUSAL on any ordinary suite with
 * a failing subtest. Hence four states rather than two.
 */
const CANCELLED_FAILURE_TYPES = new Set([
  'cancelledByParent',
  'testTimeoutFailure',
  'testAborted',
]);

/** Counted by Node under `failed`, AND the body ran and failed. */
const KILL_ELIGIBLE_FAILURE_TYPES = new Set([
  'testCodeFailure',
  'uncaughtException',
  'unhandledRejection',
  'callbackAndPromisePresent',
]);

function classify(event) {
  // A skipped or todo occupant still holds its {file, name}. It earns no
  // reachability credit, but it is part of the population identity uniqueness
  // must see — round 6 found a mutation adding a skipped duplicate of a passing
  // test and going uncounted.
  if (event.data.skip) return 'skipped';
  if (event.data.todo) return 'todo';
  if (event.type === 'test:pass') return 'pass';
  const failureType = event.data.details?.error?.failureType;
  // An aborted test carries no failureType and is counted under `cancelled`.
  if (failureType === undefined) return 'cancelled';
  if (CANCELLED_FAILURE_TYPES.has(String(failureType))) return 'cancelled';
  if (KILL_ELIGIBLE_FAILURE_TYPES.has(String(failureType))) return 'fail';
  // Counted by Node under `failed`, but not an executed body failure — and a
  // type this list has not met yet lands here too, so it reconciles without
  // ever becoming a kill.
  return 'aggregate';
}

export default async function* expectedRedReporter(source) {
  const ledger = createNodeResultLedger();
  for await (const event of source) ledger.observe(event);

  const results = ledger.selected().map(({ event, file }) => ({
    file,
    message: String(event.data.details?.error?.message ?? ''),
    name: String(event.data.name),
    // Carried so the runner can tell a parent that failed BECAUSE its child did
    // from a sibling whose hook threw. Both are `aggregate`; only the first may
    // be suppressed as a derived consequence.
    failureType: String(event.data.details?.error?.failureType ?? ''),
    status: classify(event),
  }));

  const files = [...ledger.summaries()].map(([file, counts]) => ({
    cancelled: Number(counts.cancelled ?? 0),
    failed: Number(counts.failed ?? 0),
    file,
    passed: Number(counts.passed ?? 0),
    skipped: Number(counts.skipped ?? 0),
    todo: Number(counts.todo ?? 0),
  }));

  yield `${JSON.stringify({ files, results, version: 3 }, undefined, 2)}\n`;
}
