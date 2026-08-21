import { creditableNodeResultPath } from './node-reporter-core.mjs';

/**
 * Emits one record per real test result so the expected-red runner can compare
 * the passing set before and after a mutation.
 *
 * WHY A REPORTER RATHER THAN THE TAP TEXT. AGENTS.md section 6 calls parsing a
 * tool's output a proxy and reading a produced artifact an observation. The
 * runner's attribution question — *which tests stopped passing* — is answered
 * here from the structured event stream, not from counting `not ok` lines.
 *
 * `creditableNodeResultPath` is reused rather than re-derived because it already
 * refuses the synthetic pass Node emits for a file whose `--test-name-pattern`
 * matched nothing. That synthetic pass is exactly the "the check read zero
 * input" vacuity vector, and a second copy of the rule would drift away from it.
 */
export default async function* expectedRedReporter(source) {
  const results = [];
  for await (const event of source) {
    const file = creditableNodeResultPath(event);
    if (file === undefined) continue;
    results.push({
      file,
      name: String(event.data.name),
      status: event.type === 'test:pass' ? 'pass' : 'fail',
    });
  }
  yield `${JSON.stringify({ version: 1, results }, undefined, 2)}\n`;
}
