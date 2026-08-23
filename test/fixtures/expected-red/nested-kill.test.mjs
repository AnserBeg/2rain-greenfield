import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';

// The ADMISSION twin for the aggregate bucket. Under the mutation the child's
// body fails, and Node additionally reports the parent as `subtestsFailed` —
// counted under `failed`, not `cancelled`. Classifying that parent as cancelled
// makes this ordinary suite shape fail reconciliation, which is a false REFUSAL
// on a perfectly good entry. The parent is not a kill and is not a regression in
// its own right; the child is both.
test('a parent whose child the mutation breaks', async (t) => {
  await t.test('the child the mutation breaks', () => {
    assert.equal(CONTROL_SENTINEL, 'pristine', 'NESTED_TOKEN');
  });
});
