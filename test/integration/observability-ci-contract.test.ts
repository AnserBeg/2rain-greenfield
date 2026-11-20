import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { observabilityTestFiles } from '../helpers/reachability-producers.js';

test('CI captures focused observability evidence from its own checkout', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

  const job = workflow.match(
    /^ {2}observability:\n([\s\S]*?)(?=^ {2}[\w-]+:)/mu,
  )?.[1];
  assert.ok(job);
  assert.match(job, /^ {4}needs: select$/mu);
  assert.doesNotMatch(job, /uses: actions\/download-artifact/u);
  assert.ok(job.includes('OBSERVABILITY_EVIDENCE_DIR'));
  assert.ok(
    job.includes(
      'node --import tsx test/helpers/run-observability-producer.ts',
    ),
  );
  assert.deepEqual(observabilityTestFiles, [
    'test/unit/observability.test.ts',
    'test/integration/observability-ci-contract.test.ts',
    'test/postgres/observability-health.test.ts',
  ]);
  assert.ok(job.includes('test-results/observability/tests.tap'));
  assert.ok(job.includes('name: observability-evidence-${{ github.sha }}'));
  assert.ok(job.includes('if: always()'));
});
