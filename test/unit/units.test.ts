import assert from 'node:assert/strict';
import test from 'node:test';
import {
  convertUnitQuantity,
  positiveUnitInteger,
  resolveUnitFactor,
  unitDecimals,
  type UnitFactor,
} from '../../packages/runtime/src/unit-conversion.js';
import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';

const factor = (
  itemId: string | null,
  from: string,
  to: string,
  numerator: string,
  denominator = '1',
): UnitFactor => ({ itemId, from, to, numerator, denominator });
test('unit lookup retains direct item, direct company, reverse item, reverse company precedence', () => {
  const rules = [
    factor(null, 'BOX', 'EA', '12'),
    factor('item', 'BOX', 'EA', '24'),
    factor('item', 'EA', 'BOX', '1', '6'),
  ];
  assert.deepEqual(resolveUnitFactor('item', 'BOX', 'EA', rules), [24n, 1n]);
  assert.deepEqual(resolveUnitFactor('other', 'BOX', 'EA', rules), [12n, 1n]);
  assert.deepEqual(
    resolveUnitFactor(
      'item',
      'BOX',
      'EA',
      rules.slice(0, 1).concat(rules.slice(2)),
    ),
    [12n, 1n],
  );
  assert.deepEqual(resolveUnitFactor('item', 'BOX', 'EA', rules.slice(2)), [
    6n,
    1n,
  ]);
  assert.deepEqual(resolveUnitFactor('other', 'EA', 'BOX', rules.slice(0, 1)), [
    1n,
    12n,
  ]);
  assert.deepEqual(resolveUnitFactor('item', 'EA', 'EA', []), [1n, 1n]);
  assert.throws(() => resolveUnitFactor('item', 'BOX', 'EA', []), {
    code: 'UNIT_CONVERSION_MISSING',
  });
  assert.throws(
    () => resolveUnitFactor('item', 'BOX', 'EA', [rules[0]!, rules[0]!]),
    { code: 'UNIT_CONVERSION_AMBIGUOUS' },
  );
});
test('quantities use exact rationals, refuse non-exact base precision, and preserve zero/sign/large values', () => {
  assert.equal(convertUnitQuantity('2', 12n, 1n, 0, 'EA'), '24');
  assert.equal(convertUnitQuantity('0.1', 3n, 1n, 1, 'KG'), '0.3');
  assert.equal(convertUnitQuantity('6', 1n, 12n, 1, 'BOX'), '0.5');
  assert.equal(convertUnitQuantity('-2', 12n, 1n, 0, 'EA'), '-24');
  assert.equal(convertUnitQuantity('-0', 12n, 1n, 18, 'EA'), '0');
  assert.equal(
    convertUnitQuantity('9007199254740993', 3n, 1n, 0, 'EA'),
    '27021597764222979',
  );
  assert.throws(() => convertUnitQuantity('1', 1n, 3n, 18, 'EA'), {
    code: 'UNIT_CONVERSION_NON_EXACT',
  });
  assert.throws(() => convertUnitQuantity('0.5', 1n, 1n, 0, 'EA'), {
    code: 'UNIT_CONVERSION_NON_EXACT',
  });
  assert.throws(
    () => convertUnitQuantity('99999999999999999999', 2n, 1n, 0, 'EA'),
    { code: 'UNIT_QUANTITY_OVERFLOW' },
  );
  for (const value of ['1e2', 'NaN', '01', ' 1', 1])
    assert.throws(() => convertUnitQuantity(value, 1n, 1n, 0, 'EA'), {
      code: 'UNIT_QUANTITY_INVALID',
    });
  for (const value of ['0', '-1', '1.1', '1e2'])
    assert.throws(() => positiveUnitInteger(value), {
      code: 'UNIT_FACTOR_INVALID',
    });
  for (const value of ['19', '-1', '1.1'])
    assert.throws(() => unitDecimals(value), {
      code: 'UNIT_PRECISION_INVALID',
    });
  assert.equal(
    positiveUnitInteger('123456789012345678901234567890'),
    123456789012345678901234567890n,
  );
  assert.equal(unitDecimals('18'), 18);
});
test('unit setup compiles as Catalog metadata and leaves document quantities and base-unit identity intact', () => {
  const definition = normalizeApplicationPackage(
    composedApplicationDefinition(),
  );
  const unit = definition.entities.find(
    (entity) => entity.entityId === 'northstar.app:entity.unit',
  )!;
  const conversion = definition.entities.find(
    (entity) => entity.entityId === 'northstar.app:entity.unit_conversion',
  )!;
  assert.equal(unit.module.targetId, 'northstar.app:module.catalog');
  assert.equal(conversion.module.targetId, unit.module.targetId);
  const decimals = definition.fields.find(
    (field) => field.fieldId === 'northstar.app:field.unit_decimals',
  )!;
  assert.equal(decimals.fieldType.kind, 'enumFieldType');
  if (decimals.fieldType.kind !== 'enumFieldType')
    throw new Error('Missing precision choices');
  assert.deepEqual(
    decimals.fieldType.options.map((option) => option.label),
    Array.from({ length: 19 }, (_, index) => String(index)),
  );
  const base = definition.fields.find(
    (field) => field.fieldId === 'northstar.app:field.item_base_unit',
  )!;
  assert.equal(base.fieldType.kind, 'textFieldType');
  assert.equal(base.presence, 'required');
  assert.equal(
    definition.fields.some((field) =>
      field.fieldId.includes('entered_quantity'),
    ),
    false,
    'stopped slice must not expose an unnormalized quantity input',
  );
  assert.equal(
    definition.relations.find(
      (relation) =>
        relation.relationId === 'northstar.app:relation.unit_conversion_item',
    )?.required,
    false,
  );
  for (const query of definition.queries.filter(
    (query) => query.sourceEntity.targetId === conversion.entityId,
  )) {
    assert.ok('legalEntityScope' in query);
    if ('legalEntityScope' in query)
      assert.equal(
        (query as { legalEntityScope?: { cardinality: string } })
          .legalEntityScope?.cardinality,
        'exactlyOne',
      );
  }
});
