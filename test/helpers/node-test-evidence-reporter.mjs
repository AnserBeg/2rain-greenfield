import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';

import {
  assertUnfilteredNodeArguments,
  createNodeResultLedger,
} from './node-reporter-core.mjs';
import { resolveReachabilityRunId } from './reachability-run.mjs';

const reporterPath = fileURLToPath(import.meta.url);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export default async function* nodeTestEvidenceReporter(source) {
  const suiteId = process.env.REACHABILITY_SUITE_ID;
  if (!suiteId || !/^[a-z][a-z0-9-]*$/u.test(suiteId)) {
    throw new Error('A valid REACHABILITY_SUITE_ID is required');
  }
  assertUnfilteredNodeArguments(process.execArgv, {
    suiteId,
    workingDirectory: process.cwd(),
    reporterPath,
    repositoryRoot,
  });
  const runId = resolveReachabilityRunId({ repositoryRoot });
  const argv = process.argv.slice(1);

  const counts = new Map();
  // One authority with the expected-red reporter. The ledger decides
  // creditability from the event stream — a file that reported zero executed
  // tests cannot then contribute a synthetic pass — rather than from the shape
  // of a test's title, which a real test can coincidentally match.
  const executed = createNodeResultLedger();
  let suiteSucceeded;
  for await (const event of source) {
    const path = executed.observe(event);
    if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
    if (event.type === 'test:summary' && event.data.file === undefined) {
      suiteSucceeded = event.data.success;
    }
  }

  const evidence = {
    version: 2,
    suiteId,
    runId,
    argv,
    runner: 'node:test',
    suiteSucceeded: suiteSucceeded === true,
    files: [...counts]
      .map(([path, realResultCount]) => ({ path, realResultCount }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  yield `${JSON.stringify(evidence, null, 2)}\n`;
}
