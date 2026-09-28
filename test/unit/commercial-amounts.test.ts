import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chargeAmounts,
  formatCents,
  lineAmounts,
  parseExact,
  sameExact,
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
