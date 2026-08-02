import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { lowerStorageTargetV1 } from '../../packages/compiler/src/index.js';
import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { platformModuleDefinition } from '../../packages/domain/src/platform/definition.js';

import {
  deriveLanguageCoverageLedger,
  evaluateLanguageCoverage,
  observeLanguageCoverage,
  type LanguageCoverageDecision,
  type LanguageCoverageReceipt,
  type LanguageCoverageReceiptClaim,
} from './language-conformance-ledger.js';
import { resolveReachabilityRunId } from './reachability-run.mjs';

const decisionsPath =
  'test/fixtures/g2/language-conformance/coverage-decisions.json';
const claimsPath = 'test/fixtures/g2/language-conformance/receipt-claims.json';
const receiptPattern = 'test-results/language-coverage/*.json';

try {
  const repositoryRoot = findRepositoryRoot(process.cwd());
  const ledger = deriveLanguageCoverageLedger(repositoryRoot);
  const applicationPackages = [
    composedApplicationDefinition(),
    platformModuleDefinition(),
  ];
  const storageTargets = applicationPackages.map((definition) =>
    lowerStorageTargetV1(
      normalizeApplicationPackage(definition) as Parameters<
        typeof lowerStorageTargetV1
      >[0],
    ),
  );
  const observedObligationIds = observeLanguageCoverage(ledger, {
    applicationPackages,
    storageTargets,
  });
  const decisionsDocument = readObject(resolve(repositoryRoot, decisionsPath));
  if (decisionsDocument.ledgerDigest !== ledger.digest) {
    throw new Error(
      `LANGUAGE_COVERAGE_STALE_DECISION_DOCUMENT: ${decisionsPath} names ${String(decisionsDocument.ledgerDigest)}, current ledger is ${ledger.digest}`,
    );
  }
  const decisions = readArray(
    decisionsDocument.decisions,
    `${decisionsPath}#decisions`,
  ) as unknown as LanguageCoverageDecision[];
  const claims = readArray(
    readObject(resolve(repositoryRoot, claimsPath)).claims,
    `${claimsPath}#claims`,
  ) as unknown as LanguageCoverageReceiptClaim[];
  const receipts = globSync(receiptPattern, { cwd: repositoryRoot }).map(
    (path) =>
      readObject(
        resolve(repositoryRoot, path),
      ) as unknown as LanguageCoverageReceipt,
  );
  const result = evaluateLanguageCoverage({
    creditedTestFiles: creditedTestFiles(repositoryRoot),
    decisions,
    ledger,
    observedObligationIds,
    receiptClaims: claims,
    receipts,
    runId: resolveReachabilityRunId({ repositoryRoot }),
  });
  process.stdout.write(
    `language coverage: PASS (${String(result.obligationCount)} obligations; ${String(result.receiptCount)} receipts; ${String(result.decisionCount)} explicit decisions; ${String(observedObligationIds.size)} first-party observations)\n`,
  );
} catch (error) {
  process.stderr.write(
    `language coverage: FAIL\n${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

function creditedTestFiles(repositoryRoot: string): ReadonlySet<string> {
  const credited = new Set<string>();
  for (const path of globSync('test-results/reachability/*.json', {
    cwd: repositoryRoot,
  })) {
    const evidence = readObject(resolve(repositoryRoot, path));
    if (evidence.suiteSucceeded !== true || !Array.isArray(evidence.files)) {
      continue;
    }
    for (const file of evidence.files) {
      if (
        typeof file === 'object' &&
        file !== null &&
        'path' in file &&
        typeof file.path === 'string' &&
        'realResultCount' in file &&
        typeof file.realResultCount === 'number' &&
        file.realResultCount > 0
      ) {
        credited.add(file.path);
      }
    }
  }
  return credited;
}

function readObject(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`LANGUAGE_COVERAGE_INVALID_JSON_OBJECT: ${path}`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, source: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`LANGUAGE_COVERAGE_INVALID_JSON_ARRAY: ${source}`);
  }
  return value;
}

function findRepositoryRoot(start: string): string {
  let candidate = resolve(start);
  for (;;) {
    if (existsSync(resolve(candidate, '.git'))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Could not locate repository root from ${start}`);
    }
    candidate = parent;
  }
}
