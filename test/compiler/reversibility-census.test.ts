/**
 * AI-UNDO-1 slice 2 (partial): the reversibility declaration derived from the
 * first-party release, measured. The compiler does not emit it yet: adding a
 * key to the agent-discovery chunk fails historical reproduction (ADR-0047),
 * so emission waits for a compiler semantic profile adoption. This census is
 * what the orchestrator decides that adoption, and the widened act-at-once
 * set, from.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { normalizeApplicationPackage } from '../../packages/canonical-model/src/normalize.js';
import { parseReversibilityDeclaration } from '../../packages/canonical-model/src/reversibility.js';
import {
  deriveReversibility,
  type ReversibilitySource,
} from '../../packages/compiler/src/reversibility.js';
import { compiledAppView } from '../agent/compiled-view.js';

const NS = 'northstar.app';

function firstPartyDeclaration() {
  const view = compiledAppView();
  const release = normalizeApplicationPackage(
    JSON.parse(readFileSync('apps/web/release/app.authored.json', 'utf8')),
  );
  const agent = view.projections.agent.payload as {
    confirmationRequiredFor?: string[];
  };
  return deriveReversibility(
    (
      view.projections.operation.payload as unknown as {
        operations: Parameters<typeof deriveReversibility>[0];
      }
    ).operations,
    release as unknown as ReversibilitySource,
    new Set(agent.confirmationRequiredFor ?? []),
  );
}

const local = (id: string) => id.split(/[.:]/u).pop()!;

test('every first-party operation carries a declaration, and the canonical reader parses it', () => {
  const declaration = firstPartyDeclaration();
  assert.equal(declaration.operations.length, 170);
  assert.deepEqual(parseReversibilityDeclaration(declaration), declaration);
  const classes: Record<string, number> = {};
  for (const operation of declaration.operations) {
    const key = `${operation.undo}/${operation.reach}`;
    classes[key] = (classes[key] ?? 0) + 1;
  }
  assert.deepEqual(classes, {
    'exact/internal': 35,
    'exact/record': 69,
    'none/internal': 2,
    'none/outward': 30,
    'residue/record': 34,
  });
  // A capability declares nothing yet, so it is the worst case.
  for (const operation of declaration.operations)
    if (operation.because.includes('capabilityUndeclared'))
      assert.equal(`${operation.undo}/${operation.reach}`, 'none/outward');
});

test('the lifecycle an edit depends on comes from the release, not from a name', () => {
  const byOperation = new Map(
    firstPartyDeclaration().operations.map((entry) => [
      local(entry.operationId),
      entry,
    ]),
  );
  const state = (id: string) => {
    const condition = byOperation.get(id)?.holdsWhile;
    return [
      condition?.state
        ? `${local(condition.state.stateFieldId)}=${condition.state.stateIds.map(local).join('|')}`
        : '',
      ...(condition?.parents ?? []).map(
        (parent) =>
          `${local(parent.relationId)}:${local(parent.stateFieldId)}=${parent.stateIds.map(local).join('|')}`,
      ),
    ].join(' ');
  };
  // A state machine's derived state field (no `_state` suffix) and its
  // initial state.
  assert.equal(
    state('sales_order_update'),
    'sales_order_lifecycle=sales_order_draft',
  );
  assert.equal(
    state('sales_order_line_update'),
    ' sales_order_line_order:sales_order_lifecycle=sales_order_draft',
  );
  // An enum the update's own precondition compares at its top level, rather
  // than one nested under a disjunction (shipment kind).
  assert.equal(state('shipment_update'), 'shipment_state=shipment_state_draft');
  // The parent a count line belongs to (replaces parentEditApprovals).
  assert.equal(
    state('stock_count_line_update'),
    ' stock_count_line_session:stock_count_state=stock_count_state_draft',
  );
  assert.equal(state('party_update'), '');
});

test('census: the plain edits the derivation alone would let act at once, per operation', () => {
  const declaration = firstPartyDeclaration();
  const act = new Map<string, string[]>();
  for (const operation of declaration.operations)
    for (const field of operation.fields ?? [])
      if (
        operation.undo === 'exact' &&
        operation.reach === 'record' &&
        field.undo === 'exact' &&
        field.reach === 'record'
      )
        act.set(local(operation.operationId), [
          ...(act.get(local(operation.operationId)) ?? []),
          local(field.fieldId),
        ]);
  const total = [...act.values()].reduce((sum, list) => sum + list.length, 0);
  assert.equal(total, 233);
  // Today's eleven pairs are all inside it.
  for (const [operation, field] of [
    ['item_update', 'item_description'],
    ['item_update', 'item_name'],
    ['legal_entity_update', 'legal_entity_name'],
    ['location_update', 'location_name'],
    ['party_update', 'party_contact_summary'],
    ['party_update', 'party_name'],
    ['party_update', 'party_payment_terms'],
    ['purchase_order_update', 'purchase_order_notes'],
    ['sales_order_update', 'sales_order_notes'],
    ['stock_count_line_update', 'stock_count_line_counted_quantity'],
    ['tax_code_update', 'tax_code_name'],
  ] as const)
    assert.ok(act.get(operation)?.includes(field), `${operation} ${field}`);
  // The declared gates stay out (slice 1, AGENT-5).
  for (const field of [
    'party_credit_hold',
    'tax_code_rate_percent',
    'legal_entity_is_default',
  ])
    assert.ok(![...act.values()].some((list) => list.includes(field)), field);
  // What capability code reads but the release does not declare: these are
  // A2's shape and need a ruling before any act at once (see the record).
  for (const field of ['party_credit_limit', 'item_base_unit'])
    assert.ok(
      act
        .get(field.startsWith('party') ? 'party_update' : 'item_update')
        ?.includes(field),
      field,
    );
  void NS;
});
