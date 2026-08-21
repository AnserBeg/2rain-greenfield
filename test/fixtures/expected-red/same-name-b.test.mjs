import assert from 'node:assert/strict';
import { test } from 'node:test';

// Shares its test NAME with same-name-a.test.mjs and is untouched by the
// sentinel mutation.
test('a name two files share', () => {
  assert.ok(true);
});
