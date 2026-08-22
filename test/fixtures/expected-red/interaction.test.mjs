import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';
import { POISON_MARKER } from './poison-marker.mjs';

// The round-4 review's counterexample to A/B/A, and the reason the mutation is
// measured before anything else has run.
//
// This suite fails only when BOTH its own marker is present AND the source is
// mutated. Baseline-first, every check passes: baseline green (and it writes the
// marker), mutated red with the declared token, restored green, identical pass
// sets. Yet the mutation ALONE, from a clean start, is a survivor — the marker
// the baseline left is a necessary co-cause. Green-then-red cannot tell a cause
// from a co-cause, and neither can green-red-green.
test('a victim that needs both the marker and the mutation', () => {
  const poisonedByAnEarlierRun = existsSync(POISON_MARKER);
  try {
    assert.equal(
      poisonedByAnEarlierRun && CONTROL_SENTINEL !== 'pristine',
      false,
      'INTERACTION_TOKEN',
    );
  } finally {
    mkdirSync(dirname(POISON_MARKER), { recursive: true });
    writeFileSync(POISON_MARKER, 'seen');
  }
});
