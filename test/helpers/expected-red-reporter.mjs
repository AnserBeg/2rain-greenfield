import { createNodeResultLedger } from './node-reporter-core.mjs';

/**
 * Emits one record per real test result — file, name, status, and, for a
 * failure, the message Node reported — so the expected-red runner can bind the
 * red it requires to the test that produced it.
 *
 * WHY THE MESSAGE IS HERE. The 2026-08-21 review found that matching `expected`
 * against the whole transcript while computing the kill set from a separate
 * pass/absent comparison is a Cartesian conjunction, not an identity: a
 * declared victim can vanish without failing while an unrelated failure
 * supplies the expected text, and both checks pass. Carrying the failure
 * message on the failing result is what lets the runner join them.
 *
 * `createNodeResultLedger` decides creditability from the event stream rather
 * than the test title, so a file whose filter matched nothing cannot contribute
 * a synthetic pass and a real test named after its own path is not discarded.
 */
export default async function* expectedRedReporter(source) {
  const ledger = createNodeResultLedger();
  const results = [];
  for await (const event of source) {
    const file = ledger.observe(event);
    if (file === undefined) continue;
    const failed = event.type === 'test:fail';
    results.push({
      file,
      message: failed ? String(event.data.details?.error?.message ?? '') : '',
      name: String(event.data.name),
      status: failed ? 'fail' : 'pass',
    });
  }
  yield `${JSON.stringify({ results, version: 2 }, undefined, 2)}\n`;
}
