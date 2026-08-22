import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';

// Round 6's second specimen: the ambiguity class one population narrower. The
// duplicate under the mutation is SKIPPED, so it earns no reachability credit —
// and it was therefore dropped before uniqueness ever saw it, while still
// occupying its {file, name}.
test('a shared identity whose duplicate is skipped', () => {
  assert.ok(true);
});

if (CONTROL_SENTINEL !== 'pristine') {
  test.skip('a shared identity whose duplicate is skipped', () => {});
}

test('the declared victim beside the skipped duplicate', () => {
  assert.equal(CONTROL_SENTINEL, 'pristine', 'SKIPPED_VICTIM_TOKEN');
});
