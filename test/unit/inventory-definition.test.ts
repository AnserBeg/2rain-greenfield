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
  // Only the transaction's number differs between the two.
  const composed = fields(
    inventoryModuleDefinition(ns, { documentEntry: true }),
  );
  const differing = [...composed.keys()].filter(
    (fieldId) =>
      JSON.stringify(composed.get(fieldId)) !==
      JSON.stringify(declared.get(fieldId)),
  );
  assert.deepEqual(differing, [transaction('number')]);
});
