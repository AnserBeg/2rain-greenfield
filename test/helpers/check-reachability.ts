import { fixedQuickFile, quickSelection } from './quick-ci.js';
import {
  aggregateEvidence,
  discoverRepositoryTests,
} from './reachability-evidence.js';
import { reachabilityProducers } from './reachability-producers.js';

try {
  const quick = process.env.CI_TIER === 'quick' ? quickSelection() : undefined;
  const producers = quick?.producers ?? reachabilityProducers;
  const required = quick
    ? new Set(
        [...discoverRepositoryTests()]
          .filter(fixedQuickFile)
          .concat(quick.files),
      )
    : undefined;
  const result = aggregateEvidence(
    process.cwd(),
    producers,
    required ? { requiredFiles: required } : {},
  );
  if (quick) {
    const skipped = reachabilityProducers.filter(
      (p) => !producers.some((active) => active.id === p.id),
    );
    process.stdout.write(
      `Expected skipped producers: ${skipped.map((p) => p.id).join(', ')}\n`,
    );
  }
  process.stdout.write(
    `reachability: PASS (${result.executedCount}/${result.discoveredCount} test files executed; ${producers.length} producer artifacts)\n`,
  );
} catch (error) {
  process.stderr.write(
    `reachability: FAIL\n${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
