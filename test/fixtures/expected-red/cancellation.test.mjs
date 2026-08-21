import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';

// The round-2 review's second specimen, and the two-kill case that holds the
// `notFailed` check on its own.
//
// At baseline the parent awaits its child and both pass. Under the mutation the
// parent abandons the child and fails carrying the token, so Node reports the
// child as `test:fail` with `failureType: "cancelledByParent"` — counted under
// `counts.cancelled`, never executed, and not a kill. Declaring both as kills
// then gives an exact regression set, and the parent's message satisfies
// `expected` for the pair. Only refusing cancellation as a kill catches it.
test('a parent that abandons its child under the mutation', async (t) => {
  if (CONTROL_SENTINEL === 'pristine') {
    await t.test('a child that finishes at baseline', () => {
      assert.ok(true);
    });
    return;
  }
  void t.test('a child that finishes at baseline', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  });
  assert.fail('CANCELLATION_PARENT_TOKEN');
});
