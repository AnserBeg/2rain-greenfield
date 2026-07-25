import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';

import {
  assertUnfilteredNodeArguments,
  creditableNodeResultPath,
} from './node-reporter-core.mjs';

const reporterPath = fileURLToPath(import.meta.url);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export default async function* nodeTestEvidenceReporter(source) {
  const suiteId = process.env.REACHABILITY_SUITE_ID;
  const command = process.env.REACHABILITY_COMMAND;
  if (!suiteId || !/^[a-z][a-z0-9-]*$/u.test(suiteId)) {
    throw new Error('A valid REACHABILITY_SUITE_ID is required');
  }
  if (!command) throw new Error('REACHABILITY_COMMAND is required');
  assertUnfilteredNodeArguments(process.execArgv, {
    suiteId,
    workingDirectory: process.cwd(),
    reporterPath,
    repositoryRoot,
  });

  const counts = new Map();
  let suiteSucceeded;
  for await (const event of source) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const path = creditableNodeResultPath(event);
      if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    if (event.type === 'test:summary' && event.data.file === undefined) {
      suiteSucceeded = event.data.success;
    }
  }

  const evidence = {
    version: 1,
    suiteId,
    command,
    runner: 'node:test',
    suiteSucceeded: suiteSucceeded === true,
    files: [...counts]
      .map(([path, realResultCount]) => ({ path, realResultCount }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  yield `${JSON.stringify(evidence, null, 2)}\n`;
}
