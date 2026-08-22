import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';

// The round-6 review's specimen. Under the mutation this file reports THREE
// results: the shared name passing, the shared name failing, and the declared
// victim failing.
//
// Every other check is satisfied. The shared identity stays out of the
// regression set because one occurrence still passes; the undeclared failure is
// admitted because `reference.has(identity)` is true; Node's counts reconcile;
// and the declared victim carries its expected message. Only refusing to
// adjudicate an ambiguous identity catches it.
test('a name that appears twice under the mutation', () => {
  assert.ok(true);
});

if (CONTROL_SENTINEL !== 'pristine') {
  test('a name that appears twice under the mutation', () => {
    assert.fail('DUPLICATE_TOKEN');
  });
}

test('the declared victim beside the duplicate', () => {
  assert.equal(CONTROL_SENTINEL, 'pristine', 'DUPLICATE_VICTIM_TOKEN');
});
