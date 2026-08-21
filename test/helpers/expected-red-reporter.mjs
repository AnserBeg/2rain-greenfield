import { createNodeResultLedger } from './node-reporter-core.mjs';

/**
 * Emits the executed test results of a run, each with its provenance, plus the
 * per-file counts Node itself reported — so the expected-red runner can bind
 * the red it requires to the test that produced it AND reconcile what it
 * credited against what Node counted.
 *
 * WHY STATUS IS THREE-VALUED. A `test:fail` is not necessarily an executed
 * assertion failure. A child left pending when its parent ends arrives as
 * `test:fail` with `failureType: "cancelledByParent"`, and Node counts it under
 * `counts.cancelled`. Treating it as a failure let a cancelled child stand in
 * for a declared kill — the 2026-08-21 round-2 review's finding. Cancellation
 * is recorded as itself and is never a kill.
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
          : failureType === 'cancelledByParent'
            ? 'cancelled'
            : 'fail',
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
