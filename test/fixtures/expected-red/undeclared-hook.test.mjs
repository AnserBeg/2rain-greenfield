import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';

// The round-5 review's specimen for undeclared consequences.
//
// A is the declared kill: its body fails under the mutation. B's `beforeEach`
// throws under the SAME mutation, so Node reports B as `hookFailed` — counted
// under `failed`, so reconciliation is satisfied, and formerly excluded from the
// regression set as an `aggregate`, so it vanished from the comparison. B also
// stopped passing, and the entry does not say so.
test('the declared victim', () => {
  assert.equal(CONTROL_SENTINEL, 'pristine', 'DECLARED_VICTIM_TOKEN');
});

test('an undeclared sibling whose hook throws', async (t) => {
  t.beforeEach(() => {
    assert.equal(CONTROL_SENTINEL, 'pristine', 'SIBLING_HOOK_TOKEN');
  });
  await t.test('the sibling body that never runs', () => {});
});
