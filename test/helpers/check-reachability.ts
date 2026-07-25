import { aggregateEvidence } from './reachability-evidence.js';
import { reachabilityProducers } from './reachability-producers.js';

try {
  const result = aggregateEvidence();
  process.stdout.write(
    `reachability: PASS (${result.executedCount}/${result.discoveredCount} test files executed; ${reachabilityProducers.length} producer artifacts)\n`,
  );
} catch (error) {
  process.stderr.write(
    `reachability: FAIL\n${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
