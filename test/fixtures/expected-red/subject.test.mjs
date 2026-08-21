import assert from 'node:assert/strict';
import { test } from 'node:test';

import { admitQuantity } from './subject.mjs';

test('the fixture subject refuses a non-positive quantity', () => {
  assert.throws(() => admitQuantity(0), /SUBJECT_NOT_POSITIVE/u);
});

test('the fixture subject refuses a fractional quantity', () => {
  assert.throws(() => admitQuantity(1.5), /SUBJECT_NOT_AN_INTEGER/u);
});

test('the fixture subject admits a positive integer', () => {
  assert.equal(admitQuantity(3), 3);
});
