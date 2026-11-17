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
