import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { lowerStorageTargetV1 } from '../../packages/compiler/src/index.js';
import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { languageCoverageApplicationPackages } from './language-coverage-packages.js';
import {
  deriveLanguageCoverageLedger,
  encodeLanguageCoverageObservationSnapshot,
  observeLanguageCoverage,
} from './language-conformance-ledger.js';

/**
 * Preflight (CI-8): the language-coverage ledger digest and the observation
 * snapshot, without the reachability evidence `check:language-coverage` needs.
 * It prints what is stale and the fresh values to put in
 * `test/fixtures/g2/language-conformance/coverage-decisions.json`.
 */
const decisionsPath =
  'test/fixtures/g2/language-conformance/coverage-decisions.json';

function root(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error('repository root not found');
    current = parent;
  }
}

const repositoryRoot = root(process.cwd());
const ledger = deriveLanguageCoverageLedger(repositoryRoot);
const applicationPackages = languageCoverageApplicationPackages();
const storageTargets = applicationPackages.map((definition) =>
  lowerStorageTargetV1(
    normalizeApplicationPackage(definition) as Parameters<
      typeof lowerStorageTargetV1
    >[0],
  ),
);
const observed = observeLanguageCoverage(ledger, {
  applicationPackages,
  storageTargets,
});
const fresh = encodeLanguageCoverageObservationSnapshot(ledger, observed);
const document = JSON.parse(
  readFileSync(resolve(repositoryRoot, decisionsPath), 'utf8'),
) as {
  ledgerDigest?: string;
  decisions?: { decisionId?: string; ledgerDigest?: string }[];
  observationSnapshot?: Record<string, unknown>;
};

const problems: string[] = [];
if (document.ledgerDigest !== ledger.digest) {
  problems.push(
    `${decisionsPath}: ledgerDigest is ${String(document.ledgerDigest)}`,
  );
}
const staleDecisions = (document.decisions ?? []).filter(
  (decision) => decision.ledgerDigest !== ledger.digest,
);
if (staleDecisions.length > 0) {
  problems.push(
    `${String(staleDecisions.length)} decision(s) name an older ledger digest (first: ${String(staleDecisions[0]?.decisionId)})`,
  );
}
if (JSON.stringify(document.observationSnapshot) !== JSON.stringify(fresh)) {
  problems.push('observationSnapshot differs from what the packages observe');
}
if (problems.length > 0) {
  console.error('LANGUAGE_COVERAGE_PREFLIGHT_STALE');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`  current ledger digest: ${ledger.digest}`);
  console.error(`  fresh observationSnapshot: ${JSON.stringify(fresh)}`);
  process.exitCode = 1;
} else {
  console.log(`language coverage decisions match ledger ${ledger.digest}`);
}
