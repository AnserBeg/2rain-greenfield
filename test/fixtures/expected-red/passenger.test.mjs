import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';

// The Fable arm's specimen. The mutation kills its declared victim AND brings a
// new test into existence that simply passes. It cannot fake a kill, hide one,
// or disturb the set arithmetic — but it is an outcome the entry did not
// declare, and the claim says every outcome is accounted for.
test('the declared victim beside a passenger', () => {
  assert.equal(CONTROL_SENTINEL, 'pristine', 'PASSENGER_VICTIM_TOKEN');
});

if (CONTROL_SENTINEL !== 'pristine') {
  test('a passenger that exists only under the mutation and passes', () => {
    assert.ok(true);
  });
}
