import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { languageCoverageProducerFileKey } from './language-conformance-ledger.js';
import {
  normalizeEvidencePath,
  parseReachabilityEvidence,
  StaleReachabilityEvidenceError,
} from './reachability-evidence.js';
import type { ReachabilityProducer } from './reachability-producers.js';

/**
 * The producer files whose executed-file evidence this run credits to the
 * language-coverage receipts.
 *
 * Evidence from another run, or written under an older definition of the
 * producer (the argv a shard list had before it changed), is stale. It fails
 * here with a message that says so and says how to regenerate it, not with a
 * bare argv comparison that reads like a code defect.
 */
export function creditedProducerFiles(
  repositoryRoot: string,
  runId: string,
  producers: readonly ReachabilityProducer[],
): ReadonlySet<string> {
  const credited = new Set<string>();
  for (const producer of producers) {
    const artifactPath = resolve(repositoryRoot, producer.evidencePath);
    if (!existsSync(artifactPath)) continue;
    const serialized = readFileSync(artifactPath, 'utf8');
    if (serialized.trim().length === 0) {
      throw new Error(
        `LANGUAGE_COVERAGE_EMPTY_REACHABILITY_EVIDENCE: ${producer.id}`,
      );
    }
    let evidence;
    try {
      evidence = parseReachabilityEvidence(serialized, producer, runId);
    } catch (error) {
      if (error instanceof StaleReachabilityEvidenceError) {
        throw new Error(
          `LANGUAGE_COVERAGE_STALE_REACHABILITY_EVIDENCE: ${producer.id} (${producer.evidencePath}) was not produced by this run under the current definition of the producer.\n` +
            `${error.message}\n` +
            `Regenerate it: run \`node --import tsx test/helpers/begin-reachability-run.ts\`, then \`${producer.command}\`; or delete test-results/reachability and run the whole matrix.`,
          { cause: error },
        );
      }
      throw error;
    }
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
