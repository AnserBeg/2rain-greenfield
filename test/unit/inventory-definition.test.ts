import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { inventoryModuleDefinition } from '../../packages/domain/src/inventory/index.js';

type Field = Record<string, unknown> & {
  fieldId: string;
  presence: string;
  defaultSemantics: string;
  numbering?: Record<string, unknown>;
  fieldType: { kind: string; options?: { optionId: string }[] };
};
const ns = 'northstar.app';
const fields = (definition: Record<string, unknown>) =>
  new Map(
    (definition.fields as Field[]).map((value) => [value.fieldId, value]),
  );
const transaction = (name: string) =>
  `${ns}:field.inventory_transaction_${name}`;
/**
 * The four fields a stock document never has typed (owner ruling R5'). They
 * stay required: the editor's first save writes them, because a released
 * field's NOT NULL is not a storage transition the planner admits.
 */
const WRITTEN_AT_FIRST_SAVE = [
  'source_type',
  'source_id',
  'recorded_at',
  'actor_id',
];

test('INVENTORY-PARITY: the product mounts stock documents numbered STK-000001, their source, recorded time and actor still required', () => {
  const composed = inventoryModuleDefinition(ns, { documentEntry: true });
  assert.doesNotThrow(() => normalizeApplicationPackage(composed));
  const declared = fields(composed);
  assert.deepEqual(declared.get(transaction('number'))!.numbering, {
    kind: 'documentSequence',
    sequenceId: `${ns}:document_sequence.inventory_transaction`,
    prefix: 'STK',
    minimumDigits: 6,
    start: 1,
  });
  for (const name of WRITTEN_AT_FIRST_SAVE) {
    assert.equal(declared.get(transaction(name))!.presence, 'required', name);
    assert.equal(
      declared.get(transaction(name))!.defaultSemantics,
      'none',
      name,
    );
  }
  // Release verification's probe draft takes the first type option, a goods
  // receipt, so the route's declared refusal is the first one it meets.
  assert.equal(
    declared.get(transaction('type'))!.fieldType.options?.[0]?.optionId,
    `${ns}:option.inventory_transaction_type_goods_receipt`,
  );
});

test('INVENTORY-PARITY: the standalone kernel harness keeps the module it has always compiled', () => {
  const standalone = inventoryModuleDefinition(ns);
  assert.deepEqual(inventoryModuleDefinition(ns, {}), standalone);
  const declared = fields(standalone);
  assert.equal(declared.get(transaction('number'))!.numbering, undefined);
  // Only the two documents' numbers differ between the two: the stock
  // document's STK- and the stock count's CNT- (STOCK-COUNTS).
  const composed = fields(
    inventoryModuleDefinition(ns, { documentEntry: true }),
  );
  const differing = [...composed.keys()].filter(
    (fieldId) =>
      JSON.stringify(composed.get(fieldId)) !==
      JSON.stringify(declared.get(fieldId)),
  );
  assert.deepEqual(differing, [
    transaction('number'),
    `${ns}:field.stock_count_number`,
  ]);
});

test('STOCK-COUNTS: the product mounts stock counts numbered CNT-000001 with Start counting, Review, Post, Return to counting and Cancel count on the posting route; a reviewed or cancelled count is frozen and the companion relations are retired', () => {
  type Operation = Record<string, unknown> & {
    operationId: string;
    label?: string;
    tier: string;
    confirmation: string;
    effect: { kind: string; capability?: { targetId: string } };
    precondition?: Record<string, unknown>;
  };
  const composed = inventoryModuleDefinition(ns, { documentEntry: true });
  assert.doesNotThrow(() => normalizeApplicationPackage(composed));
  assert.deepEqual(
    fields(composed).get(`${ns}:field.stock_count_number`)!.numbering,
    {
      kind: 'documentSequence',
      sequenceId: `${ns}:document_sequence.stock_count`,
      prefix: 'CNT',
      minimumDigits: 6,
      start: 1,
    },
  );
  const state = (local: string) => ({
    field: {
      kind: 'fieldReference',
      schemaVersion: 'v6',
      targetId: `${ns}:field.stock_count_state`,
    },
    kind: 'fieldComparisonPredicate',
    operator: 'equals',
    schemaVersion: 'v6',
    value: {
      kind: 'textValue',
      schemaVersion: 'v6',
      value: `${ns}:option.stock_count_state_${local}`,
    },
  });
  const operations = composed.operations as Operation[];
  const operation = (local: string) =>
    operations.find(
      (value) => value.operationId === `${ns}:operation.${local}`,
    );
  // Each command acts in its states, on the posting capability's route.
  const either = (...locals: string[]) => ({
    kind: 'anyPredicate',
    schemaVersion: 'v6',
    terms: locals.map(state),
  });
  // A reversal is never returned to counting (review round 1, SC-6).
  const notReversal = {
    kind: 'notPredicate',
    schemaVersion: 'v6',
    term: {
      field: {
        kind: 'fieldReference',
        schemaVersion: 'v6',
        targetId: `${ns}:field.stock_count_kind`,
      },
      kind: 'fieldComparisonPredicate',
      operator: 'equals',
      schemaVersion: 'v6',
      value: {
        kind: 'textValue',
        schemaVersion: 'v6',
        value: `${ns}:option.stock_count_kind_reversal`,
      },
    },
  };
  assert.deepEqual(
    operation('stock_count_reopen')!.precondition,
    {
      kind: 'allPredicate',
      schemaVersion: 'v6',
      terms: [state('reviewed'), notReversal],
    },
    'Return to counting is declared for a reviewed count that is not a reversal (SC-6)',
  );
  assert.deepEqual(
    ['start', 'review', 'post', 'reopen', 'cancel'].map((action) => {
      const value = operation(`stock_count_${action}`)!;
      return [
        value.label,
        value.tier,
        value.effect.kind,
        value.effect.capability?.targetId,
        value.confirmation,
        value.precondition,
      ];
    }),
    (
      [
        ['Start counting', state('draft'), 'none'],
        ['Review', state('counting'), 'none'],
        ['Post', state('reviewed'), 'humanRequired'],
        [
          'Return to counting',
          {
            kind: 'allPredicate',
            schemaVersion: 'v6',
            terms: [state('reviewed'), notReversal],
          },
          'none',
        ],
        [
          'Cancel count',
          either('draft', 'counting', 'reviewed'),
          'humanRequired',
        ],
      ] as const
    ).map(([label, precondition, confirmation]) => [
      label,
      'o1',
      'registeredCapabilityEffect',
      'northstar.inventory:capability.posting',
      confirmation,
      precondition,
    ]),
  );
  // The standalone kernel harness has no count route.
  assert.equal(
    (inventoryModuleDefinition(ns).operations as Operation[]).some((value) =>
      /:operation\.stock_count_(start|review|post|reopen|cancel)$/u.test(
        value.operationId,
      ),
    ),
    false,
  );
  // A count and its lines change generically only while a draft or counting.
  for (const action of ['create', 'update', 'archive', 'restore'])
    assert.deepEqual(operation(`stock_count_${action}`)!.precondition, {
      kind: 'allPredicate',
      schemaVersion: 'v6',
      terms: ['reviewed', 'posted', 'cancelled'].map((local) => ({
        kind: 'notPredicate',
        schemaVersion: 'v6',
        term: state(local),
      })),
    });
  // The posting kernel's companions are retired from every generic input.
  const relations = composed.relations as (Record<string, unknown> & {
    relationId: string;
  })[];
  for (const local of [
    'stock_count_transaction',
    'stock_count_line_transaction_line',
  ])
    assert.equal(
      relations.find((value) => value.relationId === `${ns}:relation.${local}`)!
        .lifecycle,
      'retired',
      local,
    );
});
