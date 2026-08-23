import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';

// The round-3 review's first specimen. Both tests fail under the mutation, both
// are declared kills, the regression set is exact and Node's counts reconcile —
// but only A fails for the declared reason. One pattern applied to the two
// messages joined together is satisfied by A alone, so B may die for anything.
test('a declared kill that fails for its declared reason', () => {
  if (CONTROL_SENTINEL !== 'pristine') assert.fail('DECLARED_TOKEN');
});

test('a declared kill that fails for something else entirely', () => {
  if (CONTROL_SENTINEL !== 'pristine') assert.fail('AN_UNRELATED_FAILURE');
});
