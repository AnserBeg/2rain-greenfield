import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';

// Shares its test NAME with same-name-b.test.mjs. Only this one dies under the
// sentinel mutation, so a kill declared against the other file must be refused.
test('a name two files share', () => {
  assert.equal(CONTROL_SENTINEL, 'pristine');
});
