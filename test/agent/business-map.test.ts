import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentPreamble,
  businessMapStructure,
  OperationsAgentSession,
  renderBusinessMap,
  systemPrompt,
} from '../../packages/operations-agent/src/index.js';
import {
  matchId,
  pinnedCatalog,
} from '../../packages/operations-agent/src/catalog.js';
import type { RequestRuntimeView } from '../../packages/runtime/src/request-runtime-view.js';

import { compiledAppView } from './compiled-view.js';

const NS = 'northstar.app';

function everything(view: RequestRuntimeView) {
  const catalog = pinnedCatalog(view);
  return {
    operations: new Set(catalog.operations.map((op) => op.operationId)),
    queries: new Set(catalog.queries.map((query) => query.queryId)),
  };
}

test('the map names record types, states, operations with fields, queries and screen recipes, within its bound', () => {
  const view = compiledAppView();
  const text = renderBusinessMap(businessMapStructure(view), everything(view));
  assert.ok(text.length < 60_000, `map is ${String(text.length)} characters`);
  assert.match(
    text,
    /^## sales_order "Sales orders" states: Draft, Released/mu,
  );
  assert.match(
    text,
    /- sales_order_create: create; values customer_party_id\*, order_date\*:datetime/u,
  );
  assert.match(text, /sales_order_resolve\[resolve\] by number/u);
  assert.match(text, /to_ship="To ship"/u);
  assert.match(
    text,
    /screen "Reserve stock": reservation_create\(.*\) > reservation_reserve/u,
  );
  // O1 operations are grouped under their record type, not lost.
  assert.match(text, /- goods_receipt_post!: runs receiving/u);
  // No delete exists, so none is offered.
  assert.doesNotMatch(text, /delete|purge/iu);
});

test('the map keeps only what the person may use, and drops a recipe naming anything else', () => {
  const view = compiledAppView();
  const all = everything(view);
  const withoutReserve = {
    operations: new Set(
      [...all.operations].filter(
        (id) => id !== `${NS}:operation.reservation_reserve`,
      ),
    ),
    queries: new Set(
      [...all.queries].filter((id) => !id.includes('customer_invoice')),
    ),
  };
  const text = renderBusinessMap(businessMapStructure(view), withoutReserve);
  assert.doesNotMatch(text, /reservation_reserve/u);
  assert.doesNotMatch(text, /screen "Reserve stock"/u);
  assert.doesNotMatch(text, /customer_invoice_list/u);
  assert.match(text, /reservation_create/u);
  // Nothing at all: no map.
  assert.equal(
    renderBusinessMap(businessMapStructure(view), {
      operations: new Set(),
      queries: new Set(),
    }),
    '',
  );
});

test('the structure is cached by release root; another root (a customized release) gets its own', () => {
  const view = compiledAppView();
  assert.equal(businessMapStructure(view), businessMapStructure(view));
  // A tenant-authored release adds a record type: a different root and
  // different projections. Its map shows the new type.
  const operationPayload = structuredClone(
    view.projections.operation.payload,
  ) as { operations: Record<string, unknown>[] };
  const create = operationPayload.operations.find(
    (op) => op.operationId === `${NS}:operation.tax_code_create`,
  )!;
  operationPayload.operations.push({
    ...structuredClone(create),
    operationId: `${NS}:operation.custom_equipment_create`,
    effect: {
      ...(create.effect as object),
      entity: {
        kind: 'entityReference',
        schemaVersion: 'v6',
        targetId: `${NS}:entity.custom_equipment`,
      },
    },
  });
  const agentPayload = structuredClone(view.projections.agent.payload) as {
    operations: { operationId: string }[];
  };
  agentPayload.operations.push({
    operationId: `${NS}:operation.custom_equipment_create`,
  });
  const customized = {
    ...view,
    release: { contentHash: 'f'.repeat(64), releaseId: 'customized' },
    projections: {
      ...view.projections,
      agent: { payload: agentPayload },
      operation: { payload: operationPayload },
    },
  } as unknown as RequestRuntimeView;
  const structure = businessMapStructure(customized);
  assert.notEqual(structure, businessMapStructure(view));
  const text = renderBusinessMap(structure, everything(customized));
  assert.match(text, /## custom_equipment/u);
  assert.match(text, /custom_equipment_create: create/u);
  assert.doesNotMatch(
    renderBusinessMap(businessMapStructure(view), everything(view)),
    /custom_equipment/u,
  );
});

/** A session over the compiled release whose gateways allow per person. */
function personSession(
  person: string,
  allowed: (id: string) => boolean,
  asked: string[],
) {
  const view = compiledAppView(person);
  return new OperationsAgentSession({
    runtime: {
      entry: {
        run: (_request: unknown, work: (v: unknown) => unknown) => work(view),
      },
      operationGateway: {
        previewTaskEligibility: (_v: unknown, ids: string[]) => {
          asked.push(`${person}:${ids[0]!}`);
          return Promise.resolve(allowed(ids[0]!) ? 'eligible' : 'denied');
        },
      },
      queryGateway: {
        previewEligibility: (_v: unknown, id: string) => {
          asked.push(`${person}:${id}`);
          return Promise.resolve(allowed(id) ? 'eligible' : 'denied');
        },
      },
    } as never,
    personHeaders: {},
    companyId: 'c',
    approve: () => Promise.resolve(false),
  });
}

test('each person gets their own filtered map through one cached structure, and eligibility is asked for each', async () => {
  const asked: string[] = [];
  const buyer = await personSession(
    'buyer',
    (id) => !id.includes('sales_order'),
    asked,
  ).businessMap();
  const manager = await personSession(
    'manager',
    () => true,
    asked,
  ).businessMap();
  assert.doesNotMatch(buyer, /sales_order_create/u);
  assert.match(manager, /sales_order_create/u);
  assert.ok(asked.some((entry) => entry.startsWith('buyer:')));
  assert.ok(asked.some((entry) => entry.startsWith('manager:')));
});

test('the turn context names a declared screen and never an unknown one', async () => {
  const session = personSession('buyer', () => true, []);
  const known = await session.turnContext({
    surfaceId: `${NS}:surface.sales_order_detail`,
    recordId: '0d9c6f2e-3a1b-4c5d-8e7f-001122334455',
  });
  assert.match(known, /Screen: the person is on "Sales order detail"/u);
  assert.match(known, /showing record 0d9c6f2e-3a1b-4c5d-8e7f-001122334455/u);
  const unknown = await session.turnContext({
    surfaceId: `${NS}:surface.made_up`,
    recordId: 'not-a-uuid',
  });
  assert.doesNotMatch(unknown, /Screen:/u);
  const preamble = await agentPreamble(session);
  assert.match(systemPrompt(preamble), /# Business map/u);
  assert.match(preamble.turnContext, /"today"/u);
});

test('a short name stands for exactly one id or for none', () => {
  const ids = [
    `${NS}:field.sales_order_currency`,
    `${NS}:field.sales_order_notes`,
    `${NS}:field.purchase_order_notes`,
  ];
  assert.equal(matchId('currency', ids, 'sales_order'), ids[0]);
  assert.equal(matchId('sales_order_notes', ids), ids[1]);
  assert.equal(matchId(ids[2]!, ids), ids[2]);
  assert.equal(matchId('notes', ids), undefined);
  assert.equal(matchId('other:field.currency', ids, 'sales_order'), undefined);
  const view = compiledAppView();
  assert.equal(
    pinnedCatalog(view).operation('sales_order_create')?.operationId,
    `${NS}:operation.sales_order_create`,
  );
});

test('the risk class comes from contract facts: O0 creates and updates are reversible, everything else needs a yes', async () => {
  const { operationRisk } =
    await import('../../packages/operations-agent/src/risk.js');
  const catalog = pinnedCatalog(compiledAppView());
  const risk = (local: string) =>
    operationRisk(catalog, catalog.operation(local)!);
  assert.deepEqual(risk('party_create').inverse, {
    kind: 'archive',
    operationId: `${NS}:operation.party_archive`,
  });
  assert.deepEqual(risk('sales_order_update').inverse, {
    kind: 'restorePriorValues',
    operationId: `${NS}:operation.sales_order_update`,
  });
  for (const local of [
    'party_archive',
    'party_restore',
    'goods_receipt_post',
    'shipment_post',
    'customer_payment_post',
    'purchase_order_release',
    'purchase_order_draft_cancel',
    // Its field is one reopen_period changes only with confirmation.
    'advance_period_lock',
  ])
    assert.equal(risk(local).riskClass, 'needsYes', local);
  // An unknown family is never reversible.
  const strange = {
    ...catalog.operation('party_create')!,
    tier: 'o9',
  } as never;
  assert.equal(operationRisk(catalog, strange).riskClass, 'needsYes');
});

// ------------------------------------------------ plan guards (audit A1, A2)

const PARTY = '0d9c6f2e-3a1b-4c5d-8e7f-001122334455';

/** A session over the compiled release whose release and record a test moves. */
function guardedSession(deny: ReadonlySet<string> = new Set()) {
  const base = compiledAppView('manager');
  const state = {
    release: { ...base.release },
    record: {
      recordId: PARTY,
      revision: 1,
      archived: false,
      values: {
        [`${NS}:field.party_number`]: 'P-2016',
        [`${NS}:field.party_contact_summary`]: 'Old',
      } as Record<string, string>,
    },
    invoked: [] as string[],
    afterInvoke: () => {},
    denyReads: false,
  };
  const session = new OperationsAgentSession({
    runtime: {
      entry: {
        run: (_request: unknown, work: (v: unknown) => unknown) =>
          Promise.resolve(work({ ...base, release: { ...state.release } })),
      },
      operationGateway: {
        previewTaskEligibility: (_view: unknown, ids: string[]) =>
          Promise.resolve(deny.has(ids[0]!) ? 'denied' : 'eligible'),
        invoke: (_view: unknown, request: { operationId: string }) => {
          state.invoked.push(request.operationId);
          state.record = {
            ...state.record,
            revision: state.record.revision + 1,
          };
          state.afterInvoke();
          return Promise.resolve({
            outcome: 'succeeded',
            readBack: state.record,
          });
        },
      },
      operationMediation: {
        issueInvocation: () => ({}),
        issueConfirmationGrant: () => ({}),
      },
      queryGateway: {
        previewEligibility: () => Promise.resolve('eligible'),
        invoke: () =>
          state.denyReads
            ? Promise.reject(new Error('QUERY_PERMISSION_DENIED'))
            : Promise.resolve({ outcome: 'exact', records: [state.record] }),
      },
    } as never,
    personHeaders: {},
    companyId: 'c',
    approve: () => Promise.resolve(true),
  });
  return { session, state };
}

async function plannedUpdate(
  session: OperationsAgentSession,
  patches: readonly Record<string, string>[],
): Promise<string> {
  await session.call('erp_query', {
    queryId: 'party_get',
    arguments: { recordId: PARTY },
  });
  const planned = await session.call('erp_plan', {
    intents: patches.map((patch) => ({
      operationId: 'party_update',
      target: PARTY,
      patch,
    })),
  });
  const planId = (planned.content as { planId?: string }).planId;
  assert.equal(typeof planId, 'string', JSON.stringify(planned.content));
  return planId!;
}

test('A1: a plan made on one release never runs on another; the result asks for a replan', async () => {
  const { session, state } = guardedSession();
  const planId = await plannedUpdate(session, [{ contact_summary: 'New' }]);
  state.release = { ...state.release, contentHash: 'e'.repeat(64) };
  const executed = await session.call('erp_execute', {
    planId,
    executionIdempotencyKey: 'k',
  });
  const content = executed.content as {
    outcome: string;
    committed: unknown[];
  };
  assert.equal(content.outcome, 'replan');
  assert.deepEqual(content.committed, []);
  assert.deepEqual(state.invoked, []);
});

test('A1: a release change between two steps stops the plan before the second; the result says what committed', async () => {
  const { session, state } = guardedSession();
  const planId = await plannedUpdate(session, [
    { contact_summary: 'First' },
    { name: 'Second' },
  ]);
  state.afterInvoke = () => {
    state.release = { ...state.release, releaseId: 'activated-between' };
  };
  const executed = await session.call('erp_execute', {
    planId,
    executionIdempotencyKey: 'k',
  });
  const content = executed.content as {
    outcome: string;
    committed: { step: number }[];
  };
  assert.equal(content.outcome, 'replan');
  assert.deepEqual(
    content.committed.map((entry) => entry.step),
    [1],
  );
  assert.equal(state.invoked.length, 1);
});

test('A2: verify compares a patched field; one that did not take is named', async () => {
  for (const [readBack, verified] of [
    ['New', true],
    ['Old', false],
  ] as const) {
    const { session, state } = guardedSession();
    const planId = await plannedUpdate(session, [{ contact_summary: 'New' }]);
    await session.call('erp_execute', { planId, executionIdempotencyKey: 'k' });
    state.record = {
      ...state.record,
      values: {
        ...state.record.values,
        [`${NS}:field.party_contact_summary`]: readBack,
      },
    };
    const checked = (
      await session.call('erp_verify', { operationSessionId: planId })
    ).content as { verified: boolean; steps: { mismatches?: string[] }[] };
    assert.equal(checked.verified, verified, readBack);
    if (!verified)
      assert.deepEqual(checked.steps[0]!.mismatches, [
        `${NS}:field.party_contact_summary reads back differently`,
      ]);
  }
});

test('a contract asked for by its short name loads, as the map writes it', async () => {
  const { session } = guardedSession();
  const loaded = (
    await session.call('erp_discover', {
      mode: 'contracts',
      canonicalIds: ['party_update', 'party_get'],
    })
  ).content as {
    contracts: { operationId?: string; queryId?: string; outcome?: string }[];
  };
  assert.deepEqual(
    loaded.contracts.map(
      (entry) => entry.operationId ?? entry.queryId ?? entry.outcome,
    ),
    [`${NS}:operation.party_update`, `${NS}:query.party_get`],
  );
});

test('a replayed execute returns the receipt; values only from a read allowed now', async () => {
  const { session, state } = guardedSession();
  const planId = await plannedUpdate(session, [{ contact_summary: 'New' }]);
  const first = (
    await session.call('erp_execute', { planId, executionIdempotencyKey: 'k' })
  ).content as { steps: { values?: unknown; recordId?: string }[] };
  assert.ok(first.steps[0]!.values, 'the execution shows its read-back');
  // The person loses read access: a replay under the same key shows the
  // receipt (record id, outcome) and no stored business values.
  state.denyReads = true;
  const replay = (
    await session.call('erp_execute', { planId, executionIdempotencyKey: 'k' })
  ).content as {
    steps: { values?: unknown; recordId?: string; outcome: string }[];
  };
  assert.equal(replay.steps[0]!.recordId, PARTY);
  assert.equal(replay.steps[0]!.outcome, 'succeeded');
  assert.equal(replay.steps[0]!.values, undefined);
  assert.doesNotMatch(JSON.stringify(replay), /New|P-2016/u);
  // Allowed again: values come back from a fresh read, not from memory.
  state.denyReads = false;
  state.record = {
    ...state.record,
    values: {
      ...state.record.values,
      [`${NS}:field.party_contact_summary`]: 'Changed since',
    },
  };
  const again = (
    await session.call('erp_execute', { planId, executionIdempotencyKey: 'k' })
  ).content as { steps: { values?: Record<string, string> }[] };
  assert.equal(
    again.steps[0]!.values?.[`${NS}:field.party_contact_summary`],
    'Changed since',
  );
});

test('X6: without the host option a reversible change is asked like any plan', async () => {
  const asked: string[] = [];
  const base = compiledAppView('manager');
  const session = new OperationsAgentSession({
    runtime: {
      entry: {
        run: (_r: unknown, work: (v: unknown) => unknown) =>
          Promise.resolve(work(base)),
      },
      operationGateway: {
        previewTaskEligibility: () => Promise.resolve('eligible'),
      },
      queryGateway: { previewEligibility: () => Promise.resolve('eligible') },
    } as never,
    personHeaders: {},
    companyId: 'c',
    approve: (plan) => {
      asked.push(plan.planId);
      return Promise.resolve(false);
    },
  });
  const planned = (
    await session.call('erp_plan', {
      intents: [
        {
          operationId: 'party_create',
          values: { number: 'P-9', name: 'Asked first' },
        },
      ],
    })
  ).content as { approval: string };
  assert.equal(asked.length, 1);
  assert.equal(planned.approval, 'declined by the person');
  assert.deepEqual(
    session.approvals.map((entry) => [entry.by, entry.riskClass]),
    [['person', 'reversible']],
  );
});

// ------------------------------------------------ end review X12 (provenance)

test('X12: an id the model typed and a result echoed, or one in free text, is not provenance', async () => {
  const { session, state } = guardedSession();
  const typed = '11111111-2222-4333-8444-555555555555';
  const inNote = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  await session.call('erp_discover', {
    mode: 'contracts',
    canonicalIds: [typed],
  });
  await session.call('erp_query', { queryId: typed, arguments: {} });
  state.record = {
    ...state.record,
    values: {
      ...state.record.values,
      [`${NS}:field.party_contact_summary`]: `see ${inNote}`,
    },
  };
  await session.call('erp_query', {
    queryId: 'party_get',
    arguments: { recordId: PARTY },
  });
  for (const target of [typed, inNote]) {
    const planned = (
      await session.call('erp_plan', {
        intents: [
          { operationId: 'party_update', target, patch: { name: 'X' } },
        ],
      })
    ).content as { outcome?: string; reason?: string };
    assert.equal(planned.outcome, 'refused', target);
    assert.match(String(planned.reason), /did not come from a lookup/u);
  }
});

test('X12: a reference position refuses any unlooked-up value, a nested argument, an odd currency, and a currency named in an earlier request', async () => {
  const { session } = guardedSession();
  await session.call('erp_query', {
    queryId: 'party_get',
    arguments: { recordId: PARTY },
  });
  const order = (values: Record<string, unknown>) =>
    session.call('erp_plan', {
      intents: [
        {
          operationId: 'purchase_order_create',
          values: {
            supplier_party_id: PARTY,
            order_date: '2026-11-18T00:00:00.000Z',
            currency: 'CAD',
            ...values,
          },
        },
      ],
    });
  const reason = async (values: Record<string, unknown>) =>
    String(
      ((await order(values)).content as { reason?: string }).reason ??
        'planned',
    );
  assert.match(
    await reason({ supplier_party_id: 'Cascade' }),
    /did not come from a lookup/u,
  );
  assert.match(await reason({ currency: 'usd' }), /currency USD is not/u);
  assert.match(
    await reason({ currency: 'dollars' }),
    /is not a currency code/u,
  );
  session.noteRequest('Order it in EUR');
  assert.equal(await reason({ currency: 'EUR' }), 'planned');
  session.noteRequest('Now something else');
  assert.match(await reason({ currency: 'EUR' }), /currency EUR is not/u);
  const nested = (
    await session.call('erp_plan', {
      intents: [
        {
          operationId: 'purchase_order_release',
          target: PARTY,
          arguments: { lines: [{ quantity: '5' }] },
        },
      ],
    })
  ).content;
  assert.match(JSON.stringify(nested), /flat object of plain values/u);
});

test('X14: a list page never makes a record "this"; only a record page with its own get does', async () => {
  const session = personSession('buyer', () => true, []);
  const list = await session.turnContext({
    surfaceId: `${NS}:surface.party_list`,
    recordId: PARTY,
  });
  assert.match(list, /Screen: the person is on "[^"]+" \(list/u);
  assert.doesNotMatch(list, /showing record|read just now/u);
});

// ------------------------------------------------ end review X5 (risk class)

test('X5: a status or state change, a settings update, and a create its maker cannot archive all need a yes', async () => {
  const classOf = async (
    intent: Record<string, unknown>,
    values: Record<string, string> = {},
    deny: ReadonlySet<string> = new Set(),
  ) => {
    const { session, state } = guardedSession(deny);
    state.record = {
      ...state.record,
      values: { ...state.record.values, ...values },
    };
    await session.call('erp_query', {
      queryId: 'party_get',
      arguments: { recordId: PARTY },
    });
    const planned = await session.call('erp_plan', { intents: [intent] });
    assert.equal(planned.isError, false, JSON.stringify(planned.content));
    return session.approvals.at(-1)?.riskClass;
  };
  // Archiving the company through its status field.
  assert.equal(
    await classOf({
      operationId: 'legal_entity_update',
      target: PARTY,
      patch: { status: 'archived' },
    }),
    'needsYes',
  );
  // Sending a reviewed count back to draft.
  assert.equal(
    await classOf(
      {
        operationId: 'stock_count_update',
        target: PARTY,
        patch: { state: 'draft' },
      },
      {
        [`${NS}:field.stock_count_state`]: `${NS}:option.stock_count_state_reviewed`,
      },
    ),
    'needsYes',
  );
  // Switching purchase approvals off.
  assert.equal(
    await classOf({
      operationId: 'purchasing_settings_update',
      target: PARTY,
      patch: { require_approval: false },
    }),
    'needsYes',
  );
  // A create the person could not archive again.
  assert.equal(
    await classOf(
      { operationId: 'party_create', values: { number: 'P-9', name: 'N' } },
      {},
      new Set([`${NS}:operation.party_archive`]),
    ),
    'needsYes',
  );
  // A master field edit stays reversible (charter): Undo puts it back.
  assert.equal(
    await classOf({
      operationId: 'party_update',
      target: PARTY,
      patch: { credit_hold: true },
    }),
    'reversible',
  );
});
