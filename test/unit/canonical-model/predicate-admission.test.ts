import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LANGUAGE_VERSIONS,
  PREDICATE_POSITION_PROFILE_VERSION,
  admitPredicateForExecution,
  inspectPredicateForExecution,
} from '../../../packages/canonical-model/src/index.js';

const version = LANGUAGE_VERSIONS.v3;

const literalTrue = {
  kind: 'booleanPredicate',
  schemaVersion: version,
  value: true,
};
const literalFalse = {
  kind: 'booleanPredicate',
  schemaVersion: version,
  value: false,
};
const notPosted = {
  kind: 'notPredicate',
  schemaVersion: version,
  term: {
    field: {
      kind: 'fieldReference',
      schemaVersion: version,
      targetId: 'northstar.inventory:field.stock_count_state',
    },
    kind: 'fieldComparisonPredicate',
    operator: 'equals',
    schemaVersion: version,
    value: {
      kind: 'textValue',
      schemaVersion: version,
      value: 'northstar.inventory:option.stock_count_state_posted',
    },
  },
};

/**
 * The admission entry answers ONLY "can this platform execute this predicate at
 * all". It must never answer whether the predicate holds — that belongs to the
 * evaluator, against a record image this caller does not have.
 */
test('admission parses an executable predicate without evaluating it', () => {
  for (const predicate of [literalTrue, literalFalse, notPosted]) {
    const receipt = admitPredicateForExecution(
      predicate,
      'operationPrecondition',
    );
    assert.deepEqual(receipt, {
      kind: 'predicateKernelReceipt',
      outcome: 'admitted',
      position: 'operationPrecondition',
      positionProfileVersion: PREDICATE_POSITION_PROFILE_VERSION,
      reason: 'parsed-expression',
      schemaVersion: 'northstar.predicate-kernel-receipt/v1',
    });
  }

  // Load-bearing: `false` and `true` admit IDENTICALLY. An admission receipt
  // that varied with truth would be an evaluation, and the caller would start
  // reading a verdict this entry point has no authority to give.
  assert.deepEqual(
    admitPredicateForExecution(literalTrue, 'operationPrecondition'),
    admitPredicateForExecution(literalFalse, 'operationPrecondition'),
  );
});

/**
 * THE FAIL-OPEN DIRECTION. This is the one thing the gateway half can get
 * wrong on its own: admitting a predicate nothing can execute, which would
 * then reach an evaluator that cannot read it.
 *
 * Victim: the `parsed.outcome === 'rejected'` early return in
 * `admitPredicateForExecution` (predicate-kernel.ts). Deleting it admits every
 * shape below.
 */
test('admission refuses everything unparseable, and says why', () => {
  for (const [value, reason] of [
    [null, 'invalid-node-shape'],
    ['true', 'invalid-node-shape'],
    [
      { kind: 'booleanPredicate', schemaVersion: version },
      'invalid-node-shape',
    ],
    // A non-Boolean literal is a shape failure to the structural parser; the
    // one-argument fence calls the same input 'unsupported-literal'. Both
    // refuse — only the reason differs by entry point.
    [
      { kind: 'booleanPredicate', schemaVersion: version, value: 'yes' },
      'invalid-node-shape',
    ],
    [
      { kind: 'sqlPredicate', schemaVersion: version, value: true },
      'unsupported-node-kind',
    ],
    [
      { kind: 'booleanPredicate', schemaVersion: 'v9', value: true },
      'unsupported-node-version',
    ],
  ] as const) {
    const receipt = admitPredicateForExecution(value, 'operationPrecondition');
    assert.equal(receipt.outcome, 'rejected', JSON.stringify(value));
    assert.equal(
      receipt.outcome === 'rejected' ? receipt.reason : null,
      reason,
      JSON.stringify(value),
    );
  }

  // An unknown binding position is refused too, so a caller cannot admit a
  // predicate into a position whose falsity semantics are undefined.
  const receipt = admitPredicateForExecution(
    literalTrue,
    'notAPosition' as 'guard',
  );
  assert.equal(receipt.outcome, 'rejected');
  assert.equal(
    receipt.outcome === 'rejected' ? receipt.reason : null,
    'invalid-binding-position',
  );
});

/**
 * `admitted` must not be mistaken for `accepted`. Every pre-existing caller
 * tests `outcome !== 'accepted'`, so an admitted receipt refuses there — the
 * fail-closed direction. Opening a fence has to be an explicit opt-in.
 */
test('admission is not acceptance, so unmigrated callers still refuse', () => {
  const admitted = admitPredicateForExecution(
    notPosted,
    'operationPrecondition',
  );
  assert.notEqual(admitted.outcome, 'accepted');

  // The v0 one-argument fence is untouched: it still admits only literal true.
  assert.equal(inspectPredicateForExecution(literalTrue).outcome, 'accepted');
  assert.equal(inspectPredicateForExecution(literalFalse).outcome, 'rejected');
  assert.equal(inspectPredicateForExecution(notPosted).outcome, 'rejected');
});
