import assert from 'node:assert/strict';
import test from 'node:test';

import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { composedListSpecs } from '../../packages/domain/src/app/list-declarations.js';
import { partyModuleDefinition } from '../../packages/domain/src/party/definition.js';
import { RETURNABLES_CAPABILITY_ID } from '../../packages/domain/src/party/returnables.js';
import {
  applyReturnableEvent,
  custodyStatement,
  RETURNABLES_CAPABILITY_ID as PROVIDER_CAPABILITY_ID,
  type CustodyFigures,
} from '../../packages/postgres-provider/src/returnables-capability-executor.js';

const ns = 'northstar.app';
type Json = Record<string, unknown>;
const ids = (values: unknown, key: string) =>
  (values as Json[]).map((value) => String(value[key]));

test('Party declares returnables only behind its option, and only with the sales master data', () => {
  const plain = partyModuleDefinition(ns, { salesMasterData: true });
  const returnables = partyModuleDefinition(ns, {
    salesMasterData: true,
    returnables: true,
  });
  assert.equal(
    JSON.stringify(plain).includes('returnable'),
    false,
    'the Party the standalone harnesses compile names no returnable',
  );
  assert.deepEqual(
    ids(returnables.entities, 'entityId').filter((value) =>
      value.includes('returnable'),
    ),
    [
      `${ns}:entity.returnable_asset_type`,
      `${ns}:entity.returnable_custody`,
      `${ns}:entity.returnable_event`,
    ],
  );
  assert.throws(
    () => partyModuleDefinition(ns, { returnables: true }),
    /returnables require the sales master data/u,
  );
  // The provider and the declaration name one capability, a record mutation.
  assert.equal(PROVIDER_CAPABILITY_ID, RETURNABLES_CAPABILITY_ID);
  assert.deepEqual(
    (returnables.capabilityRequirements as Json[])
      .filter((value) => value.capabilityId === RETURNABLES_CAPABILITY_ID)
      .map((value) => value.declaredEffects),
    [['recordMutation']],
  );
});

test('a custody record is RTN-numbered and company-owned; its events post once from a draft through the capability', () => {
  const definition = partyModuleDefinition(ns, {
    salesMasterData: true,
    returnables: true,
  });
  const fields = definition.fields as Json[];
  const number = fields.find(
    (field) => field.fieldId === `${ns}:field.returnable_custody_number`,
  )!;
  assert.deepEqual(number.numbering, {
    kind: 'documentSequence',
    sequenceId: `${ns}:document_sequence.returnable_custody`,
    prefix: 'RTN',
    minimumDigits: 6,
    start: 1,
  });
  // Company-owned: the custody and event reads take exactly one company;
  // the returnable type is the tenant's, like an item.
  const queries = definition.queries as Json[];
  for (const local of ['returnable_custody', 'returnable_event'])
    for (const type of ['get', 'list', 'search', 'resolve'])
      assert.ok(
        queries.find(
          (query) => query.queryId === `${ns}:query.${local}_${type}`,
        )?.legalEntityScope,
        `${local}_${type} is company-scoped`,
      );
  assert.equal(
    queries.find(
      (query) => query.queryId === `${ns}:query.returnable_asset_type_list`,
    )?.legalEntityScope,
    undefined,
  );
  const operations = definition.operations as Json[];
  const operation = (local: string) =>
    operations.find(
      (value) => value.operationId === `${ns}:operation.${local}`,
    )!;
  const guardedOn = (local: string) =>
    JSON.stringify(
      (operation(local).precondition as Json | undefined)?.value ?? null,
    );
  // Generic writes only while a custody has posted nothing and while an
  // event is a draft, the create image included.
  for (const action of ['create', 'update', 'archive', 'restore']) {
    assert.match(
      guardedOn(`returnable_custody_${action}`),
      /returnable_custody_state_new/u,
    );
    assert.match(
      guardedOn(`returnable_event_${action}`),
      /returnable_event_state_draft/u,
    );
    assert.equal(
      operation(`returnable_asset_type_${action}`).precondition,
      undefined,
    );
  }
  const post = operation('returnable_event_post');
  assert.deepEqual(post.effect, {
    kind: 'registeredCapabilityEffect',
    schemaVersion: 'v6',
    capability: {
      kind: 'capabilityReference',
      schemaVersion: 'v6',
      targetId: RETURNABLES_CAPABILITY_ID,
    },
  });
  assert.equal(post.confirmation, 'humanRequired');
  assert.match(
    guardedOn('returnable_event_post'),
    /returnable_event_state_draft/u,
  );
  // A custody names its party; an event names its custody, which is no
  // owning parent: the custody takes events after it stops admitting writes.
  assert.deepEqual(
    (definition.relations as Json[])
      .filter((value) => String(value.relationId).includes('returnable'))
      .map((value) => [
        value.relationId,
        (value.targetEntity as Json).targetId,
        value.ownership,
      ]),
    [
      [
        `${ns}:relation.returnable_custody_party`,
        `${ns}:entity.party`,
        'reference',
      ],
      [
        `${ns}:relation.returnable_event_custody`,
        `${ns}:entity.returnable_custody`,
        'reference',
      ],
    ],
  );
});

test('Returnables out and Returnables held keep their direction in every view', () => {
  const specs = composedListSpecs(ns);
  for (const [local, direction] of [
    ['returnable_custody_list', 'out'],
    ['returnables_held_list', 'held'],
  ] as const) {
    const spec = specs[local]!;
    assert.deepEqual(
      spec.views.map((view) => view.label),
      ['Open', 'Awaiting refund', 'Closed', 'All'],
    );
    for (const view of spec.views)
      assert.equal(
        view.filters[`${ns}:field.returnable_custody_direction`],
        `${ns}:option.returnable_custody_direction_${direction}`,
        `${local} ${view.local}`,
      );
    assert.equal(
      spec.columns.find((column) => column.local === 'party')?.label,
      direction === 'out' ? 'Customer' : 'Supplier',
    );
  }
  // The held List is its own clone of the custody List, beside it in Party.
  const surfaces = composedApplicationDefinition().surfaces as Json[];
  const held = surfaces.find(
    (surface) => surface.surfaceId === `${ns}:surface.returnables_held_list`,
  )!;
  assert.equal(held.label, 'Returnables held');
  assert.equal(
    (held.dataSource as Json).targetId,
    `${ns}:query.returnables_held_list`,
  );
  assert.equal((held.module as Json).targetId, `${ns}:module.party`);
  const out = surfaces.find(
    (surface) => surface.surfaceId === `${ns}:surface.returnable_custody_list`,
  )!;
  assert.equal(out.label, 'Returnables out');
  // The party page enters a company for the custody records it lists.
  const party = surfaces.find(
    (surface) => surface.surfaceId === `${ns}:surface.party_detail`,
  )!;
  assert.equal(
    ((party.workspace as Json).entry as Json).authorizationQueryId,
    `${ns}:query.returnable_custody_list`,
  );
});

const none: CustodyFigures = {
  issued: 0n,
  returned: 0n,
  forfeited: 0n,
  taken: 0n,
  refunded: 0n,
  kept: 0n,
};

function applied(
  figures: CustodyFigures,
  event: Parameters<typeof applyReturnableEvent>[2],
  unit = 1500n,
) {
  const result = applyReturnableEvent(figures, unit, event);
  if ('refused' in result) throw new Error(result.refused);
  return result;
}

function refusal(
  figures: CustodyFigures,
  event: Parameters<typeof applyReturnableEvent>[2],
  unit = 1500n,
) {
  const result = applyReturnableEvent(figures, unit, event);
  return 'refused' in result ? result.refused : null;
}

test('an Issue takes the deposit at the unit deposit; Return and Forfeit never pass what was issued', () => {
  const issued = applied(none, { kind: 'issue', quantity: 6n, amount: null });
  assert.equal(issued.amount, 9000n);
  assert.deepEqual(issued.figures, { ...none, issued: 6n, taken: 9000n });
  const returned = applied(issued.figures, {
    kind: 'return',
    quantity: 4n,
    amount: null,
  });
  assert.equal(returned.amount, null);
  // Two outstanding: a third, returned or forfeited, is refused.
  for (const kind of ['return', 'forfeit'] as const)
    assert.equal(
      refusal(returned.figures, { kind, quantity: 3n, amount: null }),
      'RETURNABLES_QUANTITY_EXCEEDS_OUTSTANDING',
    );
  const forfeited = applied(returned.figures, {
    kind: 'forfeit',
    quantity: 2n,
    amount: null,
  });
  // The forfeited assets' deposit is kept.
  assert.equal(forfeited.amount, 3000n);
  assert.deepEqual(forfeited.figures, {
    issued: 6n,
    returned: 4n,
    forfeited: 2n,
    taken: 9000n,
    refunded: 0n,
    kept: 3000n,
  });
  assert.equal(
    refusal(forfeited.figures, { kind: 'return', quantity: 1n, amount: null }),
    'RETURNABLES_QUANTITY_EXCEEDS_OUTSTANDING',
  );
  // Quantities are positive whole assets; nothing is returned of nothing.
  for (const quantity of [0n, -1n, null])
    assert.equal(
      refusal(none, { kind: 'issue', quantity, amount: null }),
      'RETURNABLES_QUANTITY_INVALID',
    );
  assert.equal(
    refusal(none, { kind: 'return', quantity: 1n, amount: null }),
    'RETURNABLES_QUANTITY_EXCEEDS_OUTSTANDING',
  );
});

test('a refund never exceeds the deposit taken on what came back, less what was refunded', () => {
  const figures: CustodyFigures = {
    issued: 6n,
    returned: 4n,
    forfeited: 2n,
    taken: 9000n,
    refunded: 0n,
    kept: 3000n,
  };
  // Four returned at 15.00: 60.00 refundable.
  assert.equal(
    refusal(figures, { kind: 'refund', quantity: null, amount: 6001n }),
    'RETURNABLES_REFUND_EXCEEDS_DEPOSIT',
  );
  const part = applied(figures, {
    kind: 'refund',
    quantity: null,
    amount: 2500n,
  });
  assert.equal(part.figures.refunded, 2500n);
  assert.equal(
    refusal(part.figures, { kind: 'refund', quantity: null, amount: 3501n }),
    'RETURNABLES_REFUND_EXCEEDS_DEPOSIT',
  );
  const rest = applied(part.figures, {
    kind: 'refund',
    quantity: null,
    amount: 3500n,
  });
  assert.equal(rest.figures.refunded, 6000n);
  assert.equal(
    refusal(rest.figures, { kind: 'refund', quantity: null, amount: 1n }),
    'RETURNABLES_REFUND_EXCEEDS_DEPOSIT',
  );
  // A refund is an amount in whole cents, never a quantity.
  for (const amount of [0n, -1n, null])
    assert.equal(
      refusal(figures, { kind: 'refund', quantity: null, amount }),
      'RETURNABLES_AMOUNT_INVALID',
    );
  assert.equal(
    refusal(figures, { kind: 'refund', quantity: 1n, amount: 100n }),
    'RETURNABLES_QUANTITY_INVALID',
  );
  // Nothing returned, nothing refundable, whatever was taken.
  assert.equal(
    refusal(
      { ...none, issued: 2n, taken: 3000n },
      { kind: 'refund', quantity: null, amount: 1n },
    ),
    'RETURNABLES_REFUND_EXCEEDS_DEPOSIT',
  );
});

test('a custody states New, Open, Awaiting refund and Closed from its figures', () => {
  assert.equal(custodyStatement(none, null).state, 'new');
  const open = { ...none, issued: 6n, taken: 9000n };
  assert.deepEqual(custodyStatement(open, 1500n), {
    outstanding: 6n,
    held: 9000n,
    refundable: 0n,
    state: 'open',
  });
  const back = { ...open, returned: 6n };
  assert.deepEqual(custodyStatement(back, 1500n), {
    outstanding: 0n,
    held: 9000n,
    refundable: 9000n,
    state: 'awaiting_refund',
  });
  assert.deepEqual(custodyStatement({ ...back, refunded: 9000n }, 1500n), {
    outstanding: 0n,
    held: 0n,
    refundable: 0n,
    state: 'closed',
  });
  // Everything forfeited: the deposit is kept, nothing is owed back.
  assert.deepEqual(
    custodyStatement({ ...open, forfeited: 6n, kept: 9000n }, 1500n),
    { outstanding: 0n, held: 0n, refundable: 0n, state: 'closed' },
  );
  // A free type: the custody closes when everything is back.
  assert.equal(
    custodyStatement({ ...none, issued: 3n, returned: 3n }, 0n).state,
    'closed',
  );
});
