import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  dropShipBound,
  dropShipQuantity,
  dropShipQuantityText,
  dropShipRevision,
} from '../../packages/postgres-provider/src/drop-ship-support.js';

test('D-B: supplier delivery bounds are exact on both linked lines', () => {
  const amount = dropShipQuantity('0.000000000000000001');
  assert.equal(dropShipQuantityText(amount), '0.000000000000000001');
  assert.equal(
    dropShipQuantityText(dropShipQuantity('2.500000000000000000')),
    '2.5',
  );
  assert.equal(
    dropShipQuantityText(dropShipQuantity('5.000000000000000000')),
    '5',
  );
  dropShipBound(amount, amount, amount);
  for (const [delivered, sales, purchase] of [
    ['0', '1', '1'],
    ['2', '1', '3'],
    ['2', '3', '1'],
  ])
    assert.throws(
      () =>
        dropShipBound(
          dropShipQuantity(delivered),
          dropShipQuantity(sales),
          dropShipQuantity(purchase),
        ),
      /open sales or purchase quantity/u,
    );
  assert.throws(
    () => dropShipQuantity('0.0000000000000000001'),
    /exact non-negative/u,
  );
  assert.throws(() => dropShipQuantity('-1'), /exact non-negative/u);
});

test('drop-ship revisions normalize PostgreSQL bigint strings and reject unsafe values', () => {
  const stored = pg.types.getTypeParser(20)('3');
  assert.equal(typeof stored, 'string');
  assert.equal(dropShipRevision(stored), 3);
  assert.equal(dropShipRevision('3'), 3);
  assert.equal(dropShipRevision(3), 3);
  assert.equal(
    dropShipRevision(String(Number.MAX_SAFE_INTEGER)),
    Number.MAX_SAFE_INTEGER,
  );
  for (const value of [null, true, '', '0', '-1', '1.5', '9007199254740993'])
    assert.throws(() => dropShipRevision(value), /positive safe integer/u);
});

import {
  chargeAmounts,
  formatCents,
  lineAmounts,
  parseExact,
  sameExact,
  threeWayMatch,
  toCents,
} from '../../packages/postgres-provider/src/commercial-amounts.js';

const line = (
  quantity: string,
  unitPrice: string | null,
  discountPercent: string | null = null,
  taxRatePercent: string | null | undefined = undefined,
) => {
  const amounts = lineAmounts({
    quantity,
    unitPrice,
    discountPercent,
    taxRatePercent,
  });
  return amounts
    ? [formatCents(amounts.amountCents), formatCents(amounts.taxCents)]
    : null;
};

test('ruling B: a line is quantity × price less its discount, taxed on top, each rounded half up to cents', () => {
  // 3 × 12.50 = 37.50; 5% tax = 1.875 → 1.88 (half up).
  assert.deepEqual(line('3', '12.5', null, '5'), ['37.50', '1.88']);
  // A 10% discount: 37.50 × 0.9 = 33.75; tax 1.6875 → 1.69.
  assert.deepEqual(line('3', '12.5', '10', '5'), ['33.75', '1.69']);
  // The line is rounded before its tax: 1 × 0.335 → 0.34, 13% of 0.34 = 0.0442 → 0.04.
  assert.deepEqual(line('1', '0.335', null, '13'), ['0.34', '0.04']);
  // Exact decimals as the store returns them (scale 18) are the same values.
  assert.deepEqual(
    line(
      '3.000000000000000000',
      '12.500000000000000000',
      '10.000000000000000000',
      '5.000000000000000000',
    ),
    ['33.75', '1.69'],
  );
  // A fractional quantity: 2.5 × 3.99 = 9.975 → 9.98.
  assert.deepEqual(line('2.5', '3.99'), ['9.98', '0.00']);
  // No tax code: untaxed. A 100% discount: free, and untaxed by amount.
  assert.deepEqual(line('4', '2'), ['8.00', '0.00']);
  assert.deepEqual(line('4', '2', '100', '5'), ['0.00', '0.00']);
});

test('a figure that cannot be stated is null, never a guessed zero', () => {
  assert.equal(line('3', null), null, 'an unpriced line');
  assert.equal(line('3', '12.5', '101'), null, 'a discount above 100%');
  assert.equal(line('3', '12.5', '-1'), null, 'a negative discount');
  assert.equal(line('-3', '12.5'), null, 'a negative quantity');
  assert.equal(line('3', '-12.5'), null, 'a negative price');
  assert.equal(line('3', '12.5', null, null), null, 'a code without a rate');
  assert.equal(line('3', 'abc'), null, 'not a decimal');
});

test('charges are cents with their own tax; an absent charge is zero', () => {
  const charge = (amount: unknown, rate: string | null | undefined) => {
    const amounts = chargeAmounts(amount, rate);
    return amounts
      ? [formatCents(amounts.amountCents), formatCents(amounts.taxCents)]
      : null;
  };
  assert.deepEqual(charge('25', '5'), ['25.00', '1.25']);
  assert.deepEqual(charge('19.995', '12'), ['20.00', '2.40']);
  assert.deepEqual(charge(null, '5'), ['0.00', '0.00']);
  assert.deepEqual(charge('10', undefined), ['10.00', '0.00']);
  assert.equal(charge('-1', '5'), null);
  assert.equal(charge('10', null), null);
});

test('exact decimal helpers round half up and compare by value', () => {
  assert.deepEqual(parseExact('12.500'), { units: 12500n, scale: 3 });
  assert.equal(parseExact(' 1e3 '), null);
  assert.equal(toCents(12345n, 3), 1235n);
  assert.equal(toCents(12344n, 3), 1234n);
  assert.equal(toCents(-12345n, 3), -1235n);
  assert.equal(formatCents(5n), '0.05');
  assert.equal(formatCents(-1234n), '-12.34');
  assert.equal(sameExact('12.5', '12.500000000000000000'), true);
  assert.equal(sameExact('12.5', '12.51'), false);
  assert.equal(sameExact('12.5', null), false);
});

test('PAYABLES (PY-G): a purchase line three-way match compares what is billed with what was received, and states nothing for a withheld side', () => {
  const unit = 10n ** 18n;
  const match = (received: bigint | null, billed: bigint | null) => {
    const { toBill, status } = threeWayMatch(received, billed);
    return [toBill === null ? null : toBill / unit, status];
  };
  // Nothing received nor billed.
  assert.deepEqual(match(0n, 0n), [0n, 'Not received']);
  // Received and not yet (or not all) billed: the rest is left to bill.
  assert.deepEqual(match(3n * unit, 0n), [3n, 'Received, not billed']);
  assert.deepEqual(match(3n * unit, 2n * unit), [1n, 'Received, not billed']);
  // Billed exactly what was received.
  assert.deepEqual(match(2n * unit, 2n * unit), [0n, 'Matched']);
  // A receipt corrected after billing leaves the line billed above what was
  // received; nothing is left to bill and nothing is refused (PY-G).
  assert.deepEqual(match(unit, 2n * unit), [0n, 'Billed above received']);
  assert.deepEqual(match(0n, unit), [0n, 'Billed above received']);
  // A fraction of a unit counts as it is.
  assert.deepEqual(threeWayMatch(unit / 2n, 0n), {
    toBill: unit / 2n,
    status: 'Received, not billed',
  });
  // A withheld receipt or bill read is not a zero.
  assert.deepEqual(match(null, unit), [null, null]);
  assert.deepEqual(match(unit, null), [null, null]);
  assert.deepEqual(match(null, null), [null, null]);
});
