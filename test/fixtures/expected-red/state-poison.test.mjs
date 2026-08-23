import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';
import { POISON_MARKER } from './poison-marker.mjs';

// The round-3 review's second specimen, and it is not exotic: a suite that
// leaves state behind makes its OWN earlier run a second sufficient cause of the
// red. Baseline green, mutated red, exact kill set, explicit failure, matching
// message, reconciled counts, tree restored — every check passes, and the
// mutation is not what the red proves. Only re-running the restored suite and
// requiring the same green shows it.
test('a victim poisoned by its own earlier run', () => {
  const poisonedByAnEarlierRun = existsSync(POISON_MARKER);
  try {
    assert.equal(
      poisonedByAnEarlierRun || CONTROL_SENTINEL !== 'pristine',
      false,
      'STATE_OR_MUTATION_TOKEN',
    );
  } finally {
    mkdirSync(dirname(POISON_MARKER), { recursive: true });
    writeFileSync(POISON_MARKER, 'seen');
  }
});
