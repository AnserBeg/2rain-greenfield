import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { JSONReport, JSONReportSuite } from '@playwright/test/reporter';

import type { SuiteEvidence } from './reachability-evidence.js';
import { getReachabilityProducer } from './reachability-producers.js';

const producer = getReachabilityProducer('browser');
if (!producer.rawEvidencePath) {
  throw new Error('Browser producer is missing its raw JSON evidence path');
}
const rawReport = JSON.parse(
  readFileSync(resolve(producer.rawEvidencePath), 'utf8'),
) as JSONReport;
const counts = new Map<string, number>();

for (const suite of rawReport.suites)
  collectSuiteResults(suite, rawReport, counts);

const evidence: SuiteEvidence = {
  version: 1,
  suiteId: producer.id,
  command: producer.command,
  runner: producer.runner,
  suiteSucceeded:
    rawReport.errors.length === 0 && rawReport.stats.unexpected === 0,
  files: [...counts]
    .map(([path, realResultCount]) => ({ path, realResultCount }))
    .sort((left, right) => left.path.localeCompare(right.path)),
};

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
