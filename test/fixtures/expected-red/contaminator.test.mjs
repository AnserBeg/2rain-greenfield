import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';
import { POISON_MARKER } from './poison-marker.mjs';

// Leaves state behind but is not itself affected by it, so its own A/B/A passes.
test('a suite that leaves state behind for a later entry', () => {
  mkdirSync(dirname(POISON_MARKER), { recursive: true });
  writeFileSync(POISON_MARKER, 'seen');
  assert.equal(CONTROL_SENTINEL, 'pristine', 'CONTAMINATOR_TOKEN');
});
