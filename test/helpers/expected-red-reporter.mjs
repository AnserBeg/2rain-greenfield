import { createNodeResultLedger } from './node-reporter-core.mjs';

/**
 * Failure types that mean a test ran and its body failed. Anything else — known
 * cancellation, or a type a future Node adds — is not an executed failure and
 * therefore cannot satisfy a declared kill.
 */
const EXECUTED_FAILURE_TYPES = new Set([
  'testCodeFailure',
  'uncaughtException',
  'unhandledRejection',
]);

/**
 * Emits the executed test results of a run, each with its provenance, plus the
 * per-file counts Node itself reported — so the expected-red runner can bind
 * the red it requires to the test that produced it AND reconcile what it
 * credited against what Node counted.
 *
 * WHY STATUS IS AN ALLOWLIST, NOT A DENYLIST. A `test:fail` is not necessarily
 * an executed assertion failure, and Node has at least three ways of saying so:
 * a child left pending when its parent ends is `cancelledByParent`, a test that
 * exceeds its deadline is `testTimeoutFailure`, and an aborted one is
 * `testAborted`. **Node counts all of them under `counts.cancelled`, not
 * `counts.failed`** — measured on 22.22.2, 2026-08-21.
 *
 * Denylisting the ones we know would fail open on the next one Node adds, so
 * only failure types on the executed allowlist can be a kill; everything else is
 * `cancelled`. That is `review-tiers`' prefer-unrepresentable rule: an unknown
 * failure type cannot be misused because it cannot become a kill.
 */
export default async function* expectedRedReporter(source) {
  const ledger = createNodeResultLedger();
  for await (const event of source) ledger.observe(event);

  const results = ledger.credited().map(({ event, file }) => {
    const failureType = event.data.details?.error?.failureType;
    return {
      file,
      message: String(event.data.details?.error?.message ?? ''),
      name: String(event.data.name),
      status:
        event.type === 'test:pass'
          ? 'pass'
          : EXECUTED_FAILURE_TYPES.has(String(failureType))
            ? 'fail'
            : 'cancelled',
    };
  });

  const files = [...ledger.summaries()].map(([file, counts]) => ({
    cancelled: Number(counts.cancelled ?? 0),
    failed: Number(counts.failed ?? 0),
    file,
    passed: Number(counts.passed ?? 0),
  }));

  yield `${JSON.stringify({ files, results, version: 3 }, undefined, 2)}\n`;
}
