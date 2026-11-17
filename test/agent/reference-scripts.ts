/**
 * Scripted reference solutions for the ten tasks: the fake model CI runs.
 * Each one solves its task through the five tools only, reading ids and
 * figures from earlier tool results, so the tools, the plan/approve/execute/
 * verify path and the harness's own checks are proved end to end without a
 * real model. They never read the database directly.
 */
import {
  lastToolResult,
  type ScriptStep,
} from '../../packages/operations-agent/src/index.js';

import { f, NAMES, op, q, rel, SHIP_TO } from './arrange.js';

// Scripts read loosely shaped JSON tool results, as a model would.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Bag = Record<string, any>;
type Step = (
  state: Bag,
  last: Bag,
) => { text?: string; toolCalls?: { name: string; input: unknown }[] };

const call = (name: string, input: unknown) => ({
  toolCalls: [{ name, input }],
});
const resolve = (entity: string, search: string) =>
  call('erp_discover', { mode: 'resolve', canonicalIds: [entity], search });
const firstId = (last: Bag): string => {
  const id = last.candidates?.[0]?.recordId as string | undefined;
  if (!id)
    throw new Error(
      `reference script expected a resolved record: ${JSON.stringify(last)}`,
    );
  return id;
};
const values = (bag: Record<string, unknown>, local: string) =>
  Object.fromEntries(
    Object.entries(bag).map(([key, value]) => [f(`${local}_${key}`), value]),
  );
const relations = (bag: Record<string, unknown>, local: string) =>
  Object.fromEntries(
    Object.entries(bag).map(([key, value]) => [rel(`${local}_${key}`), value]),
  );
const now = () => new Date().toISOString();

function script(steps: readonly Step[]): ScriptStep[] {
  const state: Bag = {};
  return steps.map(
    (step) => (conversation) => step(state, lastToolResult(conversation)),
  );
}

/** Plan, then execute, then verify, then report: four steps. */
function writeSteps(
  intents: (state: Bag, last: Bag) => unknown[],
  key: string,
  report: (state: Bag, verify: Bag) => string,
): Step[] {
  return [
    (s, last) => call('erp_plan', { intents: intents(s, last) }),
    (s, last) => {
      if (!last.planId || !String(last.approval).startsWith('approved'))
        throw new Error(`plan not approved: ${JSON.stringify(last)}`);
      s.planId = last.planId;
      return call('erp_execute', {
        planId: last.planId,
        executionIdempotencyKey: key,
      });
    },
    (s, last) => {
      s.execution = last;
      return call('erp_verify', { operationSessionId: s.planId });
    },
    (s, last) => ({
      text: last.verified
        ? report(s, last)
        : `Not verified: ${JSON.stringify(last)}`,
    }),
  ];
}

export const REFERENCE_SCRIPTS: Readonly<Record<number, () => ScriptStep[]>> = {
  1: () =>
    script([
      () => resolve('item', NAMES.notebook),
      (s, last) => (
        (s.item = firstId(last)),
        resolve('location', NAMES.calgary)
      ),
      (s, last) => (
        (s.location = firstId(last)),
        call('erp_query', {
          queryId: q('posted_stock_balance_list'),
          arguments: {
            filters: [
              { fieldId: f('posted_stock_balance_item_id'), value: s.item },
              {
                fieldId: f('posted_stock_balance_location_id'),
                value: s.location,
              },
            ],
          },
        })
      ),
      (_s, last) => ({
        text: `${String(last.records?.[0]?.values?.[f('posted_stock_balance_posted_quantity')] ?? 0)} Field notebooks are on hand at Calgary warehouse.`,
      }),
    ]),
  2: () =>
    script([
      () =>
        call('erp_query', {
          queryId: q('purchase_order_list'),
          arguments: {
            filters: [
              {
                fieldId:
                  'northstar.app:derived_state_field.machine.purchase_order_lifecycle',
                value: 'northstar.app:state.purchase_order_released',
              },
            ],
          },
        }),
      (_s, last) => ({
        text: `Waiting to be received: ${(last.records as Bag[]).map((r) => r.values[f('purchase_order_number')]).join(', ')}.`,
      }),
    ]),
  3: () =>
    script([
      () => resolve('party', NAMES.lethbridge),
      (_s, last) =>
        call('erp_query', {
          queryId: q('customer_invoice_list'),
          arguments: {
            filters: [
              {
                fieldId: f('customer_invoice_customer_party_id'),
                value: firstId(last),
              },
            ],
          },
        }),
      (_s, last) => {
        const unpaid = (last.records as Bag[]).filter(
          (r) => Number(r.values[f('customer_invoice_balance')]) > 0,
        );
        const total = unpaid.reduce(
          (sum, r) => sum + Number(r.values[f('customer_invoice_balance')]),
          0,
        );
        return {
          text: `Unpaid: ${unpaid.map((r) => r.values[f('customer_invoice_number')]).join(', ')}; total balance ${String(total)}.`,
        };
      },
    ]),
  4: () =>
    script([
      () => resolve('party', NAMES.cascade),
      (s, last) => (
        (s.supplier = firstId(last)),
        resolve('item', NAMES.notebook)
      ),
      (s, last) => (
        (s.item = firstId(last)),
        resolve('location', NAMES.calgary)
      ),
      ...writeSteps(
        (s, last) => [
          {
            operationId: op('purchase_order_create'),
            values: values(
              {
                supplier_party_id: s.supplier,
                order_date: now(),
                currency: 'CAD',
                receiving_location_id: firstId(last),
              },
              'purchase_order',
            ),
          },
          {
            operationId: op('purchase_order_line_create'),
            values: values(
              {
                line_number: '1',
                item_id: s.item,
                ordered_quantity: '10',
                unit_price: '5.00',
              },
              'purchase_order_line',
            ),
            relations: relations(
              { order: { fromStep: 1 } },
              'purchase_order_line',
            ),
          },
          {
            operationId: op('purchase_order_release'),
            target: { fromStep: 1 },
          },
        ],
        'reference-4',
        (s) =>
          `Placed ${String(s.execution.steps[0].values[f('purchase_order_number')])}.`,
      ),
    ]),
  5: () =>
    script([
      (s) => resolve('purchase_order', s.number ?? ''),
      (s, last) => (
        (s.order = firstId(last)),
        call('erp_query', {
          queryId: q('purchase_order_line_list'),
          arguments: {
            parent: {
              relationId: rel('purchase_order_line_order'),
              recordId: s.order,
            },
          },
        })
      ),
      (s, last) => (
        (s.lines = last.records),
        resolve('location', NAMES.calgary)
      ),
      (s, last) => {
        s.location = firstId(last);
        return call('erp_plan', {
          intents: [
            {
              operationId: op('goods_receipt_create'),
              values: values(
                {
                  state: 'northstar.app:option.goods_receipt_state_draft',
                  kind: 'northstar.app:option.goods_receipt_kind_initial',
                  effective_at: now(),
                  location_id: s.location,
                  reason_code: 'RECEIVE',
                  reason_narrative: 'Received in full',
                },
                'goods_receipt',
              ),
              relations: relations({ order: s.order }, 'goods_receipt'),
            },
            ...(s.lines as Bag[]).map((line, index) => ({
              operationId: op('goods_receipt_line_create'),
              values: values(
                {
                  line_number: String(index + 1),
                  item_id: line.values[f('purchase_order_line_item_id')],
                  quantity:
                    line.values[f('purchase_order_line_ordered_quantity')],
                  unit_id: 'EA',
                  cost_status:
                    'northstar.app:option.goods_receipt_line_cost_status_known',
                  unit_cost: line.values[f('purchase_order_line_unit_price')],
                  currency: 'CAD',
                },
                'goods_receipt_line',
              ),
              relations: relations(
                { receipt: { fromStep: 1 }, order_line: line.recordId },
                'goods_receipt_line',
              ),
            })),
            { operationId: op('goods_receipt_post'), target: { fromStep: 1 } },
          ],
        });
      },
      ...writeSteps(
        () => [],
        'reference-5',
        () => 'Received in full.',
      ).slice(1),
    ]),
  6: () =>
    script([
      () => resolve('party', NAMES.lethbridge),
      (s, last) => (
        (s.customer = firstId(last)),
        resolve('item', NAMES.notebook)
      ),
      (s, last) => {
        s.item = firstId(last);
        return call('erp_plan', {
          intents: [
            {
              operationId: op('sales_order_create'),
              values: values(
                {
                  customer_party_id: s.customer,
                  order_date: now(),
                  requested_date: now(),
                  currency: 'CAD',
                  ...SHIP_TO,
                },
                'sales_order',
              ),
            },
            {
              operationId: op('sales_order_line_create'),
              values: values(
                {
                  line_number: '1',
                  item_id: s.item,
                  ordered_quantity: '5',
                  unit_id: 'EA',
                  unit_price: '12.50',
                },
                'sales_order_line',
              ),
              relations: relations(
                { order: { fromStep: 1 } },
                'sales_order_line',
              ),
            },
            { operationId: op('sales_order_release'), target: { fromStep: 1 } },
          ],
        });
      },
      ...writeSteps(
        () => [],
        'reference-6',
        () => 'Sales order confirmed.',
      ).slice(1),
    ]),
  7: () =>
    script([
      (s) => resolve('sales_order', s.number ?? ''),
      (s, last) => (
        (s.order = firstId(last)),
        call('erp_query', {
          queryId: q('sales_order_line_list'),
          arguments: {
            parent: {
              relationId: rel('sales_order_line_order'),
              recordId: s.order,
            },
          },
        })
      ),
      (s, last) => (
        (s.line = last.records[0]),
        resolve('location', NAMES.calgary)
      ),
      (s, last) => {
        const location = firstId(last);
        const item = s.line.values[f('sales_order_line_item_id')];
        return call('erp_plan', {
          intents: [
            {
              operationId: op('reservation_create'),
              values: values(
                {
                  item_id: item,
                  location_id: location,
                  number: 'RSV-AGENT-7',
                  quantity: '4',
                  reason: 'Agent request',
                  state: 'northstar.app:option.reservation_state_draft',
                  unit_id: 'EA',
                },
                'reservation',
              ),
              relations: relations(
                { order_line: s.line.recordId },
                'reservation',
              ),
            },
            { operationId: op('reservation_reserve'), target: { fromStep: 1 } },
            {
              operationId: op('shipment_create'),
              values: values(
                {
                  state: 'northstar.app:option.shipment_state_draft',
                  kind: 'northstar.app:option.shipment_kind_initial',
                  effective_at: now(),
                  location_id: location,
                  reason_code: 'SHIP',
                  reason_narrative: 'Agent request',
                  carrier: 'Northline Freight',
                  shipping_reference_kind:
                    'northstar.app:option.shipment_shipping_reference_kind_tracking',
                  shipping_reference: 'TRK-AGENT-7',
                  ...SHIP_TO,
                },
                'shipment',
              ),
              relations: relations({ order: s.order }, 'shipment'),
            },
            {
              operationId: op('shipment_line_create'),
              values: values(
                {
                  line_number: '1',
                  item_id: item,
                  quantity: '4',
                  unit_id: 'EA',
                },
                'shipment_line',
              ),
              relations: relations(
                {
                  shipment: { fromStep: 3 },
                  order_line: s.line.recordId,
                  reservation: { fromStep: 1 },
                },
                'shipment_line',
              ),
            },
            { operationId: op('shipment_post'), target: { fromStep: 3 } },
          ],
        });
      },
      ...writeSteps(
        () => [],
        'reference-7',
        () => 'Reserved and shipped 4.',
      ).slice(1),
    ]),
  8: () =>
    script([
      (s) => resolve('sales_order', s.number ?? ''),
      (s, last) => {
        s.order = firstId(last);
        return call('erp_plan', {
          intents: [
            {
              operationId: op('customer_invoice_create'),
              values: values(
                {
                  state: 'northstar.app:option.customer_invoice_state_draft',
                  invoice_date: now(),
                },
                'customer_invoice',
              ),
              relations: relations({ order: s.order }, 'customer_invoice'),
            },
            {
              operationId: op('customer_invoice_post'),
              target: { fromStep: 1 },
            },
          ],
        });
      },
      ...writeSteps(
        () => [],
        'reference-8a',
        () => '',
      ).slice(1, 3),
      (s, last) => {
        const posted = (last.steps as Bag[])[1]!;
        s.invoice = posted.recordId;
        return call('erp_plan', {
          intents: [
            {
              operationId: op('customer_payment_create'),
              values: values(
                {
                  state: 'northstar.app:option.customer_payment_state_draft',
                  payment_date: now(),
                  amount: posted.observed[f('customer_invoice_balance')],
                  method: 'northstar.app:option.customer_payment_method_cash',
                },
                'customer_payment',
              ),
              relations: relations({ invoice: s.invoice }, 'customer_payment'),
            },
            {
              operationId: op('customer_payment_post'),
              target: { fromStep: 1 },
            },
          ],
        });
      },
      ...writeSteps(
        () => [],
        'reference-8b',
        () => 'Invoiced and paid in full.',
      ).slice(1),
    ]),
  9: () =>
    script([
      (s) => resolve('sales_order', s.number ?? ''),
      () => resolve('item', NAMES.notebook),
      (s, last) => (
        (s.item = firstId(last)),
        resolve('location', NAMES.calgary)
      ),
      (s, last) =>
        call('erp_query', {
          queryId: q('posted_stock_balance_list'),
          arguments: {
            filters: [
              { fieldId: f('posted_stock_balance_item_id'), value: s.item },
              {
                fieldId: f('posted_stock_balance_location_id'),
                value: firstId(last),
              },
            ],
          },
        }),
      (_s, last) => ({
        text: `Only ${String(last.records?.[0]?.values?.[f('posted_stock_balance_posted_quantity')] ?? 0)} are on hand, so 100 cannot be shipped. Nothing was changed.`,
      }),
    ]),
  10: () =>
    script([
      () =>
        call('erp_discover', {
          mode: 'search',
          search: 'delete purchase order',
        }),
      () => ({
        text: 'Purchase orders cannot be deleted; no operation does that. Nothing was changed.',
      }),
    ]),
};

/** Scripts that need the arranged document number read it from here. */
export function referenceScript(
  taskId: number,
  context: Record<string, unknown>,
): ScriptStep[] {
  const steps = REFERENCE_SCRIPTS[taskId]!();
  return steps.map((step, index) =>
    index === 0 ? (conversation) => primed(step, context)(conversation) : step,
  );
}

function primed(
  step: ScriptStep,
  context: Record<string, unknown>,
): ScriptStep {
  return (conversation) => {
    const result = step(conversation);
    const calls = result.toolCalls?.map((entry) => {
      const input = entry.input as Bag;
      return input.mode === 'resolve' && input.search === ''
        ? { ...entry, input: { ...input, search: String(context.number) } }
        : entry;
    });
    return { ...result, ...(calls ? { toolCalls: calls } : {}) };
  };
}
