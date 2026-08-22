import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';

// The round-2 review's first specimen. Under the mutation this file throws
// BEFORE the test below registers, and Node reports that as a single `test:fail`
// named by the file's own relative path, with `details.type: "test"` and the
// message "test failed" — the same identity as the real test named here, which
// the admission rule deliberately credits. Only provenance separates them: the
// crashed file reports no `test:summary` at all, so there is nothing for the
// runner to reconcile its credited results against.
if (CONTROL_SENTINEL !== 'pristine') {
  throw new Error('the imported module exploded before registration');
}

test('test/fixtures/expected-red/impersonator.test.mjs', () => {
  assert.ok(true);
});
