import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { inventoryModuleDefinition } from '../../packages/domain/src/inventory/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { assertComposedInventoryCollection } from '../helpers/assert-composed-inventory.js';

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

test('INTERACT-1: composed stock tasks retain the governed posting operation', () => {
  const application = composedApplicationDefinition();
  const inventory = inventoryModuleDefinition(ns, {
    companyReorderRule: true,
    documentEntry: true,
  });
  const surfaces = application.surfaces as Record<string, unknown>[];
  const check = (candidate: readonly unknown[]) =>
    assertComposedInventoryCollection(
      'surfaces',
      candidate,
      inventory.surfaces as unknown[],
      ns,
    );
  assert.doesNotThrow(() => check(surfaces));
  const changed = structuredClone(surfaces);
  const document = changed.find(
    (surface) =>
      surface.surfaceId === `${ns}:surface.inventory_transaction_detail`,
  )!;
  const composition = document.composition as {
    actions: { steps: { operation: { targetId: string } }[] }[];
  };
  composition.actions[0]!.steps[0]!.operation.targetId = `${ns}:operation.inventory_transaction_update`;
  assert.throws(() => check(changed), /stock task is one governed Post/u);
});
