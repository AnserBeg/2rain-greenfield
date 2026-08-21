import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { POISON_MARKER } from './poison-marker.mjs';

// A later entry in the same manifest. Its own fresh baseline is red once the
// earlier entry has run, which is what a reused baseline would have hidden.
test('a victim of the earlier entry', () => {
  assert.equal(existsSync(POISON_MARKER), false, 'CONTAMINATED_TOKEN');
});
