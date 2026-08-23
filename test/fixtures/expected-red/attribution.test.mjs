import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTROL_SENTINEL } from './subject.mjs';

// The 2026-08-21 review's own specimen for the attribution join.
//
// Under the mutation the declared victim is never REGISTERED, so it stops
// passing without ever failing; the witness still passes, so the kill set is
// exactly the declared one; and a test that exists only under the mutation
// fails carrying the declared token, so a transcript-wide grep is satisfied.
//
// Every separate check the runner makes is green. Only binding the message to
// the failing identity refuses it.
if (CONTROL_SENTINEL === 'pristine') {
  test('a declared victim that vanishes rather than failing', () => {
    assert.ok(true);
  });
} else {
  test('a test that exists only under the mutation', () => {
    assert.fail('CONTROL_ATTRIBUTION_TOKEN');
  });
}

test('a witness that keeps passing either way', () => {
  assert.ok(true);
});
