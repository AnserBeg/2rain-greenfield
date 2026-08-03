import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { lowerStorageTargetV1 } from '../../packages/compiler/src/index.js';
import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { platformModuleDefinition } from '../../packages/domain/src/platform/definition.js';

import {
  deriveLanguageCoverageLedger,
  decodeLanguageCoverageObservationSnapshot,
  evaluateLanguageCoverage,
  observeLanguageCoverage,
  type LanguageCoverageDecision,
  type LanguageCoverageReceipt,
  type LanguageCoverageReceiptClaim,
  type LanguageCoverageObservationSnapshot,
  languageCoverageProducerFileKey,
} from './language-conformance-ledger.js';
import {
  normalizeEvidencePath,
  parseReachabilityEvidence,
} from './reachability-evidence.js';
import { reachabilityProducers } from './reachability-producers.js';
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
  const acceptedButUnhonoredEntries = readStringArray(
    decisionsDocument.acceptedButUnhonoredObligationIds,
    `${decisionsPath}#acceptedButUnhonoredObligationIds`,
  );
  const acceptedButUnhonoredObligationIds = new Set(
    acceptedButUnhonoredEntries,
  );
  if (
    acceptedButUnhonoredObligationIds.size !==
    acceptedButUnhonoredEntries.length
  ) {
    throw new Error('LANGUAGE_COVERAGE_DUPLICATE_DEFECT_INVENTORY_ENTRY');
  }
  const decisionObservedObligationIds =
    decodeLanguageCoverageObservationSnapshot(
      ledger,
      decisionsDocument.observationSnapshot as LanguageCoverageObservationSnapshot,
    );
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
  const runId = resolveReachabilityRunId({ repositoryRoot });
  const result = evaluateLanguageCoverage({
    acceptedButUnhonoredObligationIds,
    creditedProducerFiles: creditedProducerFiles(repositoryRoot, runId),
    decisionObservedObligationIds,
    decisions,
    ledger,
    observedObligationIds,
    receiptClaims: claims,
    receipts,
    runId,
  });
  process.stdout.write(
    `language coverage: PASS (${String(result.obligationCount)} obligations; ${String(result.receiptCount)} receipts; ${String(result.decisionCount)} decision-covered obligations; ${String(observedObligationIds.size)} first-party observations)\n`,
  );
  process.stdout.write(
    `language coverage relation partition: ${String(result.relationObligationCount)} = ${String(result.supportedAndExercisedCount)} supported-and-exercised + ${String(result.supportedButUnexercisedCount)} supported-but-unexercised + ${String(result.acceptedButUnhonoredCount)} accepted-but-unhonored\n`,
  );
  process.stdout.write(
    `language coverage meaning: ${String(result.receiptCount)}/${String(result.obligationCount)} obligations have execution/refusal receipts; green proves the derived specification choices, observed partition, and exact decision identities match their reviewed records, not that decision-covered shapes execute; changing a decision record requires a new identity\n`,
  );
} catch (error) {
  process.stderr.write(
    `language coverage: FAIL\n${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

function creditedProducerFiles(
  repositoryRoot: string,
  runId: string,
): ReadonlySet<string> {
  const credited = new Set<string>();
  for (const producer of reachabilityProducers) {
    const artifactPath = resolve(repositoryRoot, producer.evidencePath);
    if (!existsSync(artifactPath)) continue;
    const serialized = readFileSync(artifactPath, 'utf8');
    if (serialized.trim().length === 0) {
      throw new Error(
        `LANGUAGE_COVERAGE_EMPTY_REACHABILITY_EVIDENCE: ${producer.id}`,
      );
    }
    const evidence = parseReachabilityEvidence(serialized, producer, runId);
    if (!evidence.suiteSucceeded) {
      throw new Error(
        `LANGUAGE_COVERAGE_UNSUCCESSFUL_REACHABILITY_EVIDENCE: ${producer.id}`,
      );
    }
    if (evidence.files.length === 0) {
      throw new Error(
        `LANGUAGE_COVERAGE_ZERO_FILE_REACHABILITY_EVIDENCE: ${producer.id}`,
      );
    }
    for (const file of evidence.files) {
      if (
        !Number.isSafeInteger(file.realResultCount) ||
        file.realResultCount <= 0
      ) {
        throw new Error(
          `LANGUAGE_COVERAGE_INVALID_REAL_RESULT_COUNT: ${producer.id}:${String(file.realResultCount)}`,
        );
      }
      const testFile = normalizeEvidencePath(repositoryRoot, file.path);
      credited.add(
        languageCoverageProducerFileKey({ suiteId: producer.id, testFile }),
      );
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

function readStringArray(value: unknown, source: string): string[] {
  const entries = readArray(value, source);
  if (!entries.every((entry): entry is string => typeof entry === 'string')) {
    throw new Error(`LANGUAGE_COVERAGE_INVALID_STRING_ARRAY: ${source}`);
  }
  return entries;
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
