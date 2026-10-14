import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { JSONReport, JSONReportSuite } from '@playwright/test/reporter';

import type { SuiteEvidence } from './reachability-evidence.js';
import { getPlaywrightReachabilityProducer } from './reachability-producers.js';
import { resolveReachabilityRunId } from './reachability-run.mjs';

// The suite id run-suite.sh prepared this run's evidence under; each
// Playwright producer normalizes only its own raw report and invocation.
const suiteId = process.argv[2];
if (!suiteId) {
  throw new Error('Usage: normalize-playwright-evidence.ts <suite-id>');
}
const producer = getPlaywrightReachabilityProducer(suiteId);
const repositoryRoot = resolve('.');
const currentRunId = resolveReachabilityRunId({ repositoryRoot });
const invocation = parseObservedInvocation(
  readFileSync(resolve(producer.invocationEvidencePath), 'utf8'),
);
if (invocation.runId !== currentRunId) {
  throw new Error(
    `Stale Playwright invocation evidence: expected run ${currentRunId}, received ${invocation.runId}`,
  );
}
const rawReport = JSON.parse(
  readFileSync(resolve(producer.rawEvidencePath), 'utf8'),
) as JSONReport;
const counts = new Map<string, number>();

for (const suite of rawReport.suites)
  collectSuiteResults(suite, rawReport, counts);

const evidence: SuiteEvidence = {
  version: 2,
  suiteId: producer.id,
  runId: currentRunId,
  argv: invocation.argv,
  runner: producer.runner,
  suiteSucceeded:
    rawReport.errors.length === 0 && rawReport.stats.unexpected === 0,
  files: [...counts]
    .map(([path, realResultCount]) => ({ path, realResultCount }))
    .sort((left, right) => left.path.localeCompare(right.path)),
};

function parseObservedInvocation(serialized: string): {
  readonly runId: string;
  readonly argv: readonly string[];
} {
  const value: unknown = JSON.parse(serialized);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('runId' in value) ||
    typeof value.runId !== 'string' ||
    !('argv' in value) ||
    !Array.isArray(value.argv) ||
    value.argv.some((argument) => typeof argument !== 'string')
  ) {
    throw new Error('Invalid observed Playwright invocation evidence');
  }
  return { runId: value.runId, argv: value.argv };
}

mkdirSync(dirname(resolve(producer.evidencePath)), { recursive: true });
writeFileSync(
  resolve(producer.evidencePath),
  `${JSON.stringify(evidence, null, 2)}\n`,
);

function collectSuiteResults(
  suite: JSONReportSuite,
  report: JSONReport,
  counts: Map<string, number>,
): void {
  for (const spec of suite.specs) {
    let realResultCount = 0;
    for (const test of spec.tests) {
      if (test.status === 'skipped' || test.expectedStatus === 'skipped')
        continue;
      realResultCount += test.results.filter(
        (result) => result.status && result.status !== 'skipped',
      ).length;
    }
    if (realResultCount > 0) {
      const path = resolve(report.config.rootDir, spec.file);
      counts.set(path, (counts.get(path) ?? 0) + realResultCount);
    }
  }
  for (const child of suite.suites ?? [])
    collectSuiteResults(child, report, counts);
}
