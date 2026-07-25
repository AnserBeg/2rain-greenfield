import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { observabilityTestFiles } from '../helpers/reachability-producers.js';

test('CI captures focused observability evidence after other heavy jobs', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

  assert.match(workflow, /^ {2}observability:$/mu);
  assert.match(workflow, /^ {4}needs:\n {6}- browser\n {6}- postgres$/mu);
  assert.ok(workflow.includes('OBSERVABILITY_EVIDENCE_DIR'));
  assert.ok(
    workflow.includes(
      'node --import tsx test/helpers/run-observability-producer.ts',
    ),
  );
  assert.deepEqual(observabilityTestFiles, [
    'test/unit/observability.test.ts',
    'test/integration/observability-ci-contract.test.ts',
    'test/postgres/observability-health.test.ts',
  ]);
  assert.ok(workflow.includes('test-results/observability/tests.tap'));
  assert.ok(
    workflow.includes('name: observability-evidence-${{ github.sha }}'),
  );
  assert.ok(workflow.includes('if: always()'));
});
