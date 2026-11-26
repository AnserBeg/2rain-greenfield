/**
 * LINE-TOTALS slice 1 (ADR-0094): the evaluator (the one rounding site), the
 * binder's compile refusals and the compiled contracts and floors. Each
 * refusal names the one check whose removal reds it (rule 8;
 * test/evidence/LINE-TOTALS-s1.expected-red.json lists them).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import {
  bindLineTotals,
  evaluateDerivedField,
  LINE_TOTALS_OPERATION_READER,
  ROLLUP_QUERY_READER,
  type CompiledDerivedField,
  type DerivedTerm,
} from '../../packages/canonical-model/src/line-totals.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/protocol.js';
import {
  AMOUNT,
  amountDerivation,
  CONTRACT,
  compileRental,
  h,
  l,
  LINES,
  NS,
  patchedAuthored,
  rateNonNegative as rateRule,
  rentalContractAuthored,
  TOTAL,
  totalRollup,
  variantAuthored,
  type Authored,
} from '../helpers/line-totals-fixture.js';

const f = (fieldId: string): DerivedTerm => ({ kind: 'field', fieldId });
const lit = (value: string): DerivedTerm => ({ kind: 'decimalLiteral', value });
const op = (
  operator: 'add' | 'subtract' | 'multiply',
  left: DerivedTerm,
  right: DerivedTerm,
): DerivedTerm => ({ kind: 'arithmetic', operator, left, right });
const field = (
  expression: DerivedTerm,
  extra: Partial<CompiledDerivedField> = {},
): CompiledDerivedField => ({
  classification: 'INTERNAL',
  fieldId: AMOUNT,
  precision: 18,
  scale: 2,
  rounding: 'halfAwayFromZero',
  expression,
  ...extra,
});
const amountExpression = amountDerivation.expression as DerivedTerm;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rateNonNegative = rateRule as any;

test('LINE-TOTALS-s1 evaluator: 1.5 x 0.33 = 0.495 stores 0.50, rounded half away from zero', () => {
  const outcome = evaluateDerivedField(field(op('multiply', f('a'), f('b'))), {
    a: '1.5',
    b: '0.33',
  });
  assert.deepEqual(
    outcome,
    { kind: 'value', value: '0.5', coefficient: 50n },
    'a half-way amount was not rounded away from zero',
  );
});

test('LINE-TOTALS-s1 evaluator: -0.125 stores -0.13, away from zero on the negative side', () => {
  const outcome = evaluateDerivedField(
    field(op('multiply', f('a'), lit('1'))),
    { a: '-0.125' },
  );
  assert.deepEqual(
    outcome,
    { kind: 'value', value: '-0.13', coefficient: -13n },
    'a negative half-way amount was not rounded away from zero',
  );
});

test('LINE-TOTALS-s1 evaluator: 1 x 10.00 x (1 - 12.5 x 0.01) = 8.75', () => {
  const outcome = evaluateDerivedField(field(amountExpression), {
    [l('days')]: '1',
    [l('daily_rate')]: '10.00',
    [l('discount')]: '12.5',
  });
  assert.equal(
    outcome.kind === 'value' && outcome.value,
    '8.75',
    'the discount term was not subtracted exactly',
  );
});

test('LINE-TOTALS-s1 evaluator: a blank discount is priced by absentAs, and an absent operand makes the amount absent', () => {
  const values = { [l('days')]: '2', [l('daily_rate')]: '10' };
  const priced = evaluateDerivedField(
    field(amountExpression, { absentAs: { [l('discount')]: '0' } }),
    values,
  );
  assert.equal(
    priced.kind === 'value' && priced.value,
    '20',
    'a blank discount was not priced by its absence default',
  );
  assert.deepEqual(evaluateDerivedField(field(amountExpression), values), {
    kind: 'absent',
  });
  assert.deepEqual(
    evaluateDerivedField(
      field(amountExpression, { absentAs: { [l('discount')]: '0' } }),
      { [l('days')]: '2' },
    ),
    { kind: 'absent' },
  );
});

test('LINE-TOTALS-s1 evaluator: an amount whose integer part does not fit the target precision overflows by name', () => {
  assert.deepEqual(
    evaluateDerivedField(field(op('multiply', f('a'), f('b'))), {
      a: '999999999',
      b: '999999999',
    }),
    { kind: 'overflow' },
    'an overflowing amount was not refused',
  );
  assert.equal(
    evaluateDerivedField(field(op('multiply', f('a'), f('b'))), {
      a: '99999999',
      b: '99999999',
    }).kind,
    'value',
  );
});

// ---------------------------------------------------------------------------
// The binder and the compiler
// ---------------------------------------------------------------------------

function bind(authored: Authored) {
  return bindLineTotals(normalizeApplicationPackage(authored));
}
/** The binder refuses with exactly `message`; `reason` is the declared red. */
function refuses(authored: Authored, message: string | RegExp, reason: string) {
  const bound = bind(authored);
  assert.equal(bound.status, 'refused', reason);
  const actual = bound.status === 'refused' ? bound.message : '';
  if (typeof message === 'string') assert.equal(actual, message, reason);
  else assert.match(actual, message, reason);
}
const withDerivation = (authored: Authored, expression: DerivedTerm) => {
  const declaration: Authored = { ...amountDerivation, expression };
  delete declaration.absentAs;
  authored.derivedDecimals = [declaration];
  return authored;
};

test('LINE-TOTALS-s1 binder: the rental fixture binds a derived amount, an on-read total and a create-only currency', () => {
  const bound = bind(rentalContractAuthored());
  assert.ok(bound.status === 'bound', JSON.stringify(bound));
  assert.deepEqual(
    bound.binding.derived.get(LINES)?.map(({ fieldId }) => fieldId),
    [AMOUNT],
  );
  assert.deepEqual(bound.binding.rollups.get(CONTRACT), [
    {
      fieldId: TOTAL,
      lineEntityId: LINES,
      relationId: `${NS}:relation.custom_rental_contract_lines_parent`,
      aggregandFieldId: AMOUNT,
      precision: 22,
      scale: 2,
      lineQueryId: `${NS}:query.custom_rental_contract_lines_list`,
    },
  ]);
  assert.deepEqual(bound.binding.createOnly.get(CONTRACT), [h('currency')]);
});

test('LINE-TOTALS-s1 binder: money times money refuses', () => {
  refuses(
    withDerivation(
      rentalContractAuthored(),
      op('multiply', f(l('daily_rate')), f(l('daily_rate'))),
    ),
    'Money cannot be multiplied by money.',
    'money times money was admitted',
  );
});

const quantities = [
  { label: 'Hours', type: 'quantity', scale: 2, unit: 'h' },
  { label: 'Crew hours', type: 'quantity', scale: 2, unit: 'h' },
  {
    label: 'List price',
    type: 'money',
    currency: { kind: 'fixed', code: 'USD' },
  },
];
const variant = () => {
  const authored = variantAuthored(quantities);
  const injected = rentalContractAuthored();
  for (const key of ['createOnlyFields', 'rollups', 'formulaRules'])
    authored[key] = injected[key];
  return authored;
};

test('LINE-TOTALS-s1 binder: a quantity with a unit times a quantity with a unit refuses', () => {
  refuses(
    withDerivation(
      variant(),
      op('multiply', f(l('hours')), f(l('crew_hours'))),
    ),
    'A quantity cannot be multiplied by a quantity.',
    'a quantity times a quantity was admitted',
  );
});

test('LINE-TOTALS-s1 binder: a quantity with a unit times a header-currency rate is admitted (currency x unit)', () => {
  const bound = bind(
    withDerivation(
      variant(),
      op('multiply', f(l('hours')), f(l('daily_rate'))),
    ),
  );
  assert.equal(bound.status, 'bound', JSON.stringify(bound));
});

test('LINE-TOTALS-s1 binder: a fixed-USD price under a header-currency amount refuses', () => {
  refuses(
    withDerivation(variant(), op('multiply', f(l('days')), f(l('list_price')))),
    'The derivation and its target read their currency through the same field.',
    'a fixed-currency price was admitted under a header-currency amount',
  );
});

test('LINE-TOTALS-s1 binder: an operand that is another derived value or a total refuses (no chaining)', () => {
  const chained = rentalContractAuthored();
  chained.derivedDecimals = [
    amountDerivation,
    {
      ...amountDerivation,
      fieldId: l('discount'),
      expression: op('multiply', f(AMOUNT), lit('1')),
      absentAs: undefined,
    },
  ];
  delete chained.derivedDecimals[1].absentAs;
  refuses(
    chained,
    'A derivation reads stored inputs only: another derived value or a total is not an operand.',
    'a derived operand was admitted',
  );
  refuses(
    withDerivation(
      rentalContractAuthored(),
      op('multiply', f(TOTAL), f(l('daily_rate'))),
    ),
    'A derivation reads stored inputs only: another derived value or a total is not an operand.',
    'a total operand was admitted',
  );
});

const FROZEN =
  'The currency field this value reads must be declared create-only and required.';

test('LINE-TOTALS-s1 binder: a header currency that is not create-only refuses', () => {
  refuses(
    rentalContractAuthored({ createOnly: false }),
    FROZEN,
    'a currency that is not create-only was admitted',
  );
});

test('LINE-TOTALS-s1 binder: a header currency that is not required refuses', () => {
  const optional = rentalContractAuthored();
  optional.fields.find(
    (entry: { fieldId: string }) => entry.fieldId === h('currency'),
  ).presence = 'optional';
  refuses(optional, FROZEN, 'an optional currency was admitted');
});

test('LINE-TOTALS-s1 binder: a total over amounts in a currency other than its header refuses', () => {
  const lineCurrency = variantAuthored([
    { label: 'Line currency', type: 'currency', required: true },
    {
      label: 'Charge',
      type: 'money',
      currency: { kind: 'stored', fieldLabel: 'Line currency' },
    },
  ]);
  const injected = rentalContractAuthored();
  for (const key of ['createOnlyFields', 'derivedDecimals', 'formulaRules'])
    lineCurrency[key] = injected[key];
  lineCurrency.fields.find(
    (entry: { fieldId: string }) => entry.fieldId === l('charge'),
  ).presence = 'required';
  lineCurrency.rollups = [
    { ...totalRollup(1_000), aggregandFieldId: l('charge') },
  ];
  refuses(
    lineCurrency,
    "A total's amounts read their currency from a field of the totalled record, through the totalled relation.",
    'a total over amounts in another currency was admitted',
  );
});

test('LINE-TOTALS-s1 binder: a required derived target refuses', () => {
  const required = rentalContractAuthored();
  required.fields.find(
    (entry: { fieldId: string }) => entry.fieldId === AMOUNT,
  ).presence = 'required';
  refuses(
    required,
    'A derived value is optional: it is absent while an operand is absent.',
    'a required derived target was admitted',
  );
});

test('LINE-TOTALS-s1 binder: a derivation nested deeper than four levels refuses', () => {
  const deep = op(
    'multiply',
    op(
      'multiply',
      op('multiply', op('multiply', f(l('days')), lit('1')), lit('1')),
      lit('1'),
    ),
    f(l('daily_rate')),
  );
  refuses(
    withDerivation(rentalContractAuthored(), deep),
    'Nest a derivation at most four levels deep.',
    'a derivation deeper than four levels was admitted',
  );
});

test('LINE-TOTALS-s1 binder: a validation watching a derived value refuses', () => {
  const watched = rentalContractAuthored();
  watched.formulaRules = [
    ...watched.formulaRules,
    {
      ...rateNonNegative,
      ruleId: `${NS}:validation.custom_rental_contract_lines_amount_nonnegative`,
      fieldAnchors: [AMOUNT],
      predicate: {
        ...rateNonNegative.predicate,
        left: { ...rateNonNegative.predicate.left, fieldId: AMOUNT },
      },
    },
  ];
  refuses(
    watched,
    'Validate the operands of a derived value, not the derived value.',
    'a validation watching a derived value was admitted',
  );
});

test("LINE-TOTALS-s1 binder: a stored total refuses with slice 1's not-yet diagnostic", () => {
  const stored = rentalContractAuthored();
  stored.rollups = [{ ...totalRollup(1_000), materialize: 'stored' }];
  refuses(
    stored,
    /^A stored total is not available yet/u,
    'a stored total was admitted in slice 1',
  );
});

test('LINE-TOTALS-s1 binder: a total whose record and lines differ in company ownership refuses', () => {
  const mixed = rentalContractAuthored();
  mixed.entities.find(
    (entry: { entityId: string }) => entry.entityId === LINES,
  ).companyOwnership = 'tenantShared';
  refuses(
    mixed,
    'A record and the lines it totals have the same company ownership.',
    'a total over lines of another company ownership was admitted',
  );
});

test('LINE-TOTALS-s1 binder: a total wider than 38 digits refuses', () => {
  const wide = rentalContractAuthored();
  wide.fields.find(
    (entry: { fieldId: string }) => entry.fieldId === AMOUNT,
  ).fieldType.precision = 36;
  refuses(
    wide,
    'A total holds at most 38 digits: lower the line maximum or the amount precision.',
    'a total wider than 38 digits was admitted',
  );
});

test('LINE-TOTALS-s1 binder: create-only is refused on a numbered field, a derived value and a total', () => {
  const declare = (
    fieldId: string,
    entityId: string,
    message: string,
    reason: string,
  ) => {
    const authored = rentalContractAuthored();
    authored.createOnlyFields = [
      ...authored.createOnlyFields,
      { schemaVersion: 'v6', fieldId, entityId },
    ];
    refuses(authored, message, reason);
  };
  declare(
    `${NS}:field.sales_order_number`,
    `${NS}:entity.sales_order`,
    'A document number is assigned by the server, so it is not a create-only input.',
    'create-only was admitted on a numbered field',
  );
  declare(
    AMOUNT,
    LINES,
    'A derived value is written by the server, so it is not a create-only input.',
    'create-only was admitted on a derived value',
  );
  declare(
    TOTAL,
    CONTRACT,
    'A total is not a create-only field.',
    'create-only was admitted on a total',
  );
});

// ---------------------------------------------------------------------------
// The compiled contracts, floors and byte identity
// ---------------------------------------------------------------------------

type Compiled = Extract<
  ReturnType<typeof compileRental>,
  { status: 'compiled' }
>;
function compiled(authored: Authored): Compiled {
  const result = compileRental(authored);
  assert.ok(
    result.status === 'compiled',
    JSON.stringify(result.status === 'compiled' ? null : result.diagnostics),
  );
  return result;
}
function family(release: Compiled, familyId: string) {
  const reference = release.bundle.releaseManifest.projections.find(
    (entry) => entry.familyId === familyId,
  )!;
  return reference;
}
function payload(
  release: Compiled,
  familyId: string,
): {
  operations?: {
    operationId: string;
    inputContract?: Record<string, unknown>;
  }[];
  queries?: { queryId: string; rollups?: unknown }[];
} {
  const reference = family(release, familyId);
  const decode = (hash: string) =>
    JSON.parse(
      new TextDecoder().decode(
        release.bundle.artifacts.find((a) => a.contentHash === hash)!
          .canonicalBytes,
      ),
    ) as Record<string, unknown>;
  const manifest = decode(reference.artifactRoot);
  const chunks =
    (manifest.chunks as { contentHash: string }[] | undefined) ?? [];
  if (!chunks.length) return manifest;
  const parts = chunks.map(({ contentHash }) => decode(contentHash));
  return {
    operations: parts.flatMap((part) => (part.operations as never[]) ?? []),
    queries: parts.flatMap((part) => (part.queries as never[]) ?? []),
  };
}
const contractOf = (release: Compiled, local: string) =>
  payload(release, PROJECTION_FAMILY_IDS.operationCatalog).operations!.find(
    ({ operationId }) =>
      operationId === `${NS}:operation.custom_rental_contract_${local}`,
  )!.inputContract!;

test('LINE-TOTALS-s1 compiler: the line contracts strip and name the derived amount, the header update names its create-only currency, and the get carries the total', () => {
  const release = compiled(rentalContractAuthored());
  for (const local of ['lines_create', 'lines_update']) {
    const contract = contractOf(release, local);
    assert.ok(
      !(contract.writableFieldIds as string[]).includes(AMOUNT),
      `the ${local} contract offers the derived amount`,
    );
    assert.deepEqual(
      (contract.derivedFields as { fieldId: string }[]).map((d) => d.fieldId),
      [AMOUNT],
    );
  }
  const update = contractOf(release, 'update');
  assert.ok(
    !(update.writableFieldIds as string[]).includes(h('currency')),
    'the header update offers the create-only currency',
  );
  assert.deepEqual(update.createOnlyFieldIds, [h('currency')]);
  assert.ok(
    (contractOf(release, 'create').writableFieldIds as string[]).includes(
      h('currency'),
    ),
  );
  for (const local of [
    'lines_create',
    'lines_update',
    'lines_archive',
    'lines_restore',
  ])
    assert.deepEqual(contractOf(release, local).totalledRelations, [
      {
        maximumLines: 1_000,
        relationId: `${NS}:relation.custom_rental_contract_lines_parent`,
      },
    ]);
  const get = payload(
    release,
    PROJECTION_FAMILY_IDS.queryCatalog,
  ).queries!.find(
    ({ queryId }) => queryId === `${NS}:query.custom_rental_contract_get`,
  )!;
  assert.equal((get.rollups as { fieldId: string }[])[0]!.fieldId, TOTAL);
  assert.equal(
    family(release, PROJECTION_FAMILY_IDS.operationCatalog)
      .requiredRuntimeCapability.minimumVersion,
    LINE_TOTALS_OPERATION_READER,
  );
  assert.equal(
    family(release, PROJECTION_FAMILY_IDS.queryCatalog)
      .requiredRuntimeCapability.minimumVersion,
    ROLLUP_QUERY_READER,
  );
});

test('LINE-TOTALS-s1 compiler: a release without the keys emits none of them, and one rollup changes the operation and query chunks', () => {
  const plain = compiled(patchedAuthored());
  const operations = payload(plain, PROJECTION_FAMILY_IDS.operationCatalog);
  for (const operation of operations.operations!)
    for (const key of [
      'derivedFields',
      'createOnlyFieldIds',
      'totalledRelations',
    ])
      assert.ok(!(key in (operation.inputContract ?? {})), key);
  assert.ok(
    payload(plain, PROJECTION_FAMILY_IDS.queryCatalog).queries!.every(
      (query) => !('rollups' in query),
    ),
  );
  assert.ok(
    family(plain, PROJECTION_FAMILY_IDS.operationCatalog)
      .requiredRuntimeCapability.minimumVersion < LINE_TOTALS_OPERATION_READER,
  );
  // With one rollup added (and the derivation and currency it needs), the
  // byte-identity checks can see the change.
  const declaring = compiled(rentalContractAuthored({ validations: false }));
  for (const familyId of [
    PROJECTION_FAMILY_IDS.operationCatalog,
    PROJECTION_FAMILY_IDS.queryCatalog,
  ])
    assert.notEqual(
      family(declaring, familyId).artifactRoot,
      family(plain, familyId).artifactRoot,
      `${familyId} did not change`,
    );
});

test('LINE-TOTALS-s1 compiler: money compared with zero alone raises the operation floor; a non-zero bound still refuses', () => {
  const zeroOnly = patchedAuthored();
  zeroOnly.formulaRules = [...(zeroOnly.formulaRules ?? []), rateNonNegative];
  assert.equal(
    family(compiled(zeroOnly), PROJECTION_FAMILY_IDS.operationCatalog)
      .requiredRuntimeCapability.minimumVersion,
    LINE_TOTALS_OPERATION_READER,
  );
  const nonZero = patchedAuthored();
  nonZero.formulaRules = [
    ...(nonZero.formulaRules ?? []),
    {
      ...rateNonNegative,
      predicate: {
        ...rateNonNegative.predicate,
        right: {
          ...rateNonNegative.predicate.right,
          scalar: { ...rateNonNegative.predicate.right.scalar, value: '1' },
        },
      },
    },
  ];
  assert.throws(
    () => compileRental(nonZero),
    /CANON_VALIDATION_BINDING_UNSUPPORTED/u,
    'a non-zero bound on stored-currency money was admitted',
  );
});
