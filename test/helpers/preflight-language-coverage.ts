import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { buildModeSwitch } from '../../scripts/build-mode.mjs';

import { lowerStorageTargetV1 } from '../../packages/compiler/src/index.js';
import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { languageCoverageApplicationPackages } from './language-coverage-packages.js';
import {
  deriveLanguageCoverageLedger,
  encodeLanguageCoverageObservationSnapshot,
  observeLanguageCoverage,
} from './language-conformance-ledger.js';
import {
  regenerateCoverageDecisions,
  type CoverageDecisionsDocument,
} from './language-coverage-regenerate.js';

/**
 * Preflight (CI-8): the language-coverage ledger digest and the observation
 * snapshot, without the reachability evidence `check:language-coverage` needs.
 * It prints what is stale and the fresh values to put in
 * `test/fixtures/g2/language-conformance/coverage-decisions.json`.
 *
 * BUILD-MODE-1, switch `languageCoverageDigestRegeneration`: in build mode a
 * stale document whose obligation kinds are all reviewed is rewritten in place
 * (digests, decision identities, snapshot; never the rationale) and the step
 * passes, naming the file to commit. A new obligation kind still fails.
 */
const decisionsPath =
  process.env.PREFLIGHT_DECISIONS_PATH ??
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

if (buildModeSwitch('languageCoverageDigestRegeneration')) {
  const regeneration = regenerateCoverageDecisions(
    document as unknown as CoverageDecisionsDocument,
    ledger,
    observed,
  );
  if (!regeneration.ok) {
    console.error('LANGUAGE_COVERAGE_PREFLIGHT_NEW_OBLIGATION_KIND');
    console.error(`  ${regeneration.reason}`);
    for (const kind of regeneration.newKinds) console.error(`  - ${kind}`);
    process.exitCode = 1;
  } else if (regeneration.changed) {
    writeFileSync(
      resolve(repositoryRoot, decisionsPath),
      `${JSON.stringify(regeneration.document, null, 2)}\n`,
    );
    console.log(
      `language coverage (build mode): regenerated ${decisionsPath} for ledger ${ledger.digest}; rationale unchanged -- commit it`,
    );
  } else {
    console.log(`language coverage decisions match ledger ${ledger.digest}`);
  }
} else {
  strictCheck();
}

function strictCheck(): void {
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
}
