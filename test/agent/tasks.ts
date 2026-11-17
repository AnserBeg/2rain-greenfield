/**
 * The ten pre-registered agent tasks (AGENT charter, 2026-11-15). Each task
 * arranges its own state on a fresh database, gives the agent one request,
 * and is passed or failed by the harness reading end state through
 * registered queries -- never by the model's word. Read tasks also match the
 * final answer against figures the harness reads itself.
 *
 * Pass rules (pre-registered; recorded in docs/execution/packets/AGENT.md
 * before the first real-model run):
 * - every task: the watched document lists change only by the documents the
 *      task's own operations write (a posting also writes its stock movement
 *      and inventory transaction); read and refusal tasks change none;
 * - 1: the answer states Calgary's on-hand figure (6);
 * - 2: the answer names both placed purchase orders and not the draft;
 * - 3: the answer names both unpaid Lethbridge invoices, not the paid one,
 *      and states their total balance (52.5);
 * - 4/6: exactly one new order, placed/confirmed, with the one requested line;
 * - 5: Calgary on hand rises by the ordered 8 through one posted receipt;
 * - 7: Calgary on hand falls by 4 through one posted shipment of that order;
 * - 8: one new posted invoice for the order, balance 0, one posted payment;
 * - 9/10: nothing is written and the named order is unchanged.
 */
import type { AgentRunResult } from '../../packages/operations-agent/src/index.js';

import type { AgentWorld } from './agent-world.js';
import {
  f,
  ids,
  invoice,
  onHand,
  openingStock,
  pay,
  purchaseOrder,
  q,
  rel,
  salesOrder,
  seededCustomer,
  ship,
  snapshot,
  type Arranged,
} from './arrange.js';

export interface TaskVerdict {
  readonly pass: boolean;
  readonly reason: string;
}

export interface AgentTask<Context = Record<string, unknown>> {
  readonly id: number;
  readonly title: string;
  arrange(world: AgentWorld): Promise<Context>;
  request(context: Context): string;
  check(
    world: AgentWorld,
    context: Context,
    before: Record<string, number>,
    run: AgentRunResult,
  ): Promise<TaskVerdict>;
}

const verdict = (failures: readonly string[]): TaskVerdict =>
  failures.length === 0
    ? { pass: true, reason: 'end state matches' }
    : { pass: false, reason: failures.join('; ') };

/** Lists that changed, with how much, against the expected deltas. */
async function unexpectedChanges(
  world: AgentWorld,
  before: Record<string, number>,
  expected: Readonly<Record<string, number>> = {},
): Promise<string[]> {
  const after = await snapshot(world);
  return Object.keys(after)
    .filter(
      (list) =>
        (after[list] ?? 0) - (before[list] ?? 0) !== (expected[list] ?? 0),
    )
    .map(
      (list) =>
        `${list} changed by ${String((after[list] ?? 0) - (before[list] ?? 0))} (expected ${String(expected[list] ?? 0)})`,
    );
}

/** Every number written in the answer, commas and currency signs ignored. */
export function numbersIn(answer: string): number[] {
  return [...answer.replaceAll(',', '').matchAll(/-?\d+(?:\.\d+)?/gu)].map(
    (match) => Number(match[0]),
  );
}

const states = async (world: AgentWorld, local: string, id: string) =>
  String(
    (await world.read(local, id)).values[
      `northstar.app:derived_state_field.machine.${local}_lifecycle`
    ] ?? '',
  );

const newest = async (
  world: AgentWorld,
  list: string,
  known: readonly string[],
) => (await world.list(q(list))).filter((row) => !known.includes(row.recordId));

export const TASKS: readonly AgentTask[] = [
  {
    id: 1,
    title: 'On hand at a location',
    async arrange(world) {
      const { notebook, calgary, vancouver } = ids();
      await openingStock(world, notebook, calgary, '6');
      await openingStock(world, notebook, vancouver, '9');
      return {};
    },
    request: () => 'How many Field notebooks are on hand at Calgary warehouse?',
    async check(world, _context, before, run) {
      const failures = await unexpectedChanges(world, before);
      if (!numbersIn(run.answer).includes(6))
        failures.push('the answer does not state 6');
      return verdict(failures);
    },
  },
  {
    id: 2,
    title: 'Purchase orders waiting to be received',
    async arrange(world) {
      const { notebook, cascade } = ids();
      const draft = await purchaseOrder(
        world,
        cascade,
        [{ item: notebook, quantity: '3', price: '5' }],
        false,
      );
      const first = await purchaseOrder(world, cascade, [
        { item: notebook, quantity: '5', price: '5' },
      ]);
      const second = await purchaseOrder(world, cascade, [
        { item: notebook, quantity: '7', price: '5' },
      ]);
      return { draft: draft.number, open: [first.number, second.number] };
    },
    request: () => 'Which purchase orders are waiting to be received?',
    async check(
      world,
      context: { draft: string; open: string[] },
      before,
      run,
    ) {
      const failures = await unexpectedChanges(world, before);
      for (const number of context.open)
        if (!run.answer.includes(number))
          failures.push(`the answer omits ${number}`);
      if (run.answer.includes(context.draft))
        failures.push(`the answer lists the draft ${context.draft}`);
      return verdict(failures);
    },
  },
  {
    id: 3,
    title: 'Unpaid invoices and total balance',
    async arrange(world) {
      const { notebook, calgary, lethbridge } = ids();
      await openingStock(world, notebook, calgary, '20');
      const billed = async (customer: string, quantity: string) => {
        const order = await salesOrder(world, customer, [
          { item: notebook, quantity, price: '12.5' },
        ]);
        await ship(world, order, notebook, quantity, calgary);
        return invoice(world, order.recordId);
      };
      const paid = await billed(lethbridge, '4');
      await pay(world, paid.recordId, paid.total);
      const partly = await billed(lethbridge, '2');
      await pay(world, partly.recordId, '10');
      const open = await billed(lethbridge, '3');
      await billed(seededCustomer(), '1');
      return {
        paid: paid.number,
        unpaid: [partly.number, open.number],
        balance: 52.5,
      };
    },
    request: () =>
      'Which invoices for Lethbridge Millwork are unpaid, and what is their total balance?',
    async check(
      world,
      context: { paid: string; unpaid: string[]; balance: number },
      before,
      run,
    ) {
      const failures = await unexpectedChanges(world, before);
      for (const number of context.unpaid)
        if (!run.answer.includes(number))
          failures.push(`the answer omits ${number}`);
      if (run.answer.includes(context.paid))
        failures.push(`the answer lists the paid ${context.paid}`);
      if (
        !numbersIn(run.answer).some(
          (n) => Math.abs(n - context.balance) < 0.005,
        )
      )
        failures.push(`the answer does not state ${String(context.balance)}`);
      return verdict(failures);
    },
  },
  {
    id: 4,
    title: 'Create and place a purchase order',
    async arrange(world) {
      return {
        known: (await world.list(q('purchase_order_list'))).map(
          (row) => row.recordId,
        ),
      };
    },
    request: () =>
      'Create and place a purchase order: 10 Field notebook from Cascade Fastener Works at 5.00.',
    async check(world, context: { known: string[] }, before) {
      const { notebook, cascade } = ids();
      const failures = await unexpectedChanges(world, before, {
        purchase_order_list: 1,
        purchase_order_line_list: 1,
      });
      const created = await newest(world, 'purchase_order_list', context.known);
      const order = created[0];
      if (created.length !== 1 || !order)
        return verdict([
          ...failures,
          `${String(created.length)} new purchase orders`,
        ]);
      if (order.values[f('purchase_order_supplier_party_id')] !== cascade)
        failures.push('the supplier is not Cascade Fastener Works');
      if (
        !(await states(world, 'purchase_order', order.recordId)).endsWith(
          'purchase_order_released',
        )
      )
        failures.push('the order is not placed');
      const lines = await world.list(q('purchase_order_line_list'), {
        parentScope: {
          relationId: rel('purchase_order_line_order'),
          recordId: order.recordId,
        },
      });
      const line = lines[0];
      if (
        lines.length !== 1 ||
        !line ||
        line.values[f('purchase_order_line_item_id')] !== notebook ||
        Number(line.values[f('purchase_order_line_ordered_quantity')]) !== 10 ||
        Number(line.values[f('purchase_order_line_unit_price')]) !== 5
      )
        failures.push(
          'the order does not carry exactly one line of 10 Field notebook at 5',
        );
      return verdict(failures);
    },
  },
  {
    id: 5,
    title: 'Receive a placed purchase order in full',
    async arrange(world) {
      const { notebook, cascade, calgary } = ids();
      const order = await purchaseOrder(world, cascade, [
        { item: notebook, quantity: '8', price: '4' },
      ]);
      return {
        number: order.number,
        start: await onHand(world, notebook, calgary),
      };
    },
    request: (context: { number: string }) =>
      `Receive purchase order ${context.number} in full into Calgary warehouse.`,
    async check(world, context: { start: number }, before) {
      const { notebook, calgary } = ids();
      const failures = await unexpectedChanges(world, before, {
        goods_receipt_list: 1,
        inventory_movement_list: 1,
        inventory_transaction_list: 1,
      });
      const now = await onHand(world, notebook, calgary);
      if (now - context.start !== 8)
        failures.push(
          `Calgary on hand moved by ${String(now - context.start)}, not 8`,
        );
      return verdict(failures);
    },
  },
  {
    id: 6,
    title: 'Create and confirm a sales order',
    async arrange(world) {
      return {
        known: (await world.list(q('sales_order_list'))).map(
          (row) => row.recordId,
        ),
      };
    },
    request: () =>
      'Create and confirm a sales order: 5 Field notebook for Lethbridge Millwork at 12.50.',
    async check(world, context: { known: string[] }, before) {
      const { notebook, lethbridge } = ids();
      const failures = await unexpectedChanges(world, before, {
        sales_order_list: 1,
        sales_order_line_list: 1,
      });
      const created = await newest(world, 'sales_order_list', context.known);
      const order = created[0];
      if (created.length !== 1 || !order)
        return verdict([
          ...failures,
          `${String(created.length)} new sales orders`,
        ]);
      if (order.values[f('sales_order_customer_party_id')] !== lethbridge)
        failures.push('the customer is not Lethbridge Millwork');
      const state = await states(world, 'sales_order', order.recordId);
      if (/draft|cancel/u.test(state))
        failures.push(`the order is ${state.split('.').pop() ?? state}`);
      const lines = await world.list(q('sales_order_line_list'), {
        parentScope: {
          relationId: rel('sales_order_line_order'),
          recordId: order.recordId,
        },
      });
      const line = lines[0];
      if (
        lines.length !== 1 ||
        !line ||
        line.values[f('sales_order_line_item_id')] !== notebook ||
        Number(line.values[f('sales_order_line_ordered_quantity')]) !== 5 ||
        Number(line.values[f('sales_order_line_unit_price')]) !== 12.5
      )
        failures.push(
          'the order does not carry exactly one line of 5 Field notebook at 12.50',
        );
      return verdict(failures);
    },
  },
  {
    id: 7,
    title: 'Reserve and ship from stock',
    async arrange(world) {
      const { notebook, calgary, lethbridge } = ids();
      await openingStock(world, notebook, calgary, '10');
      const order = await salesOrder(world, lethbridge, [
        { item: notebook, quantity: '4', price: '12.5' },
      ]);
      return { number: order.number };
    },
    request: (context: { number: string }) =>
      `On sales order ${context.number}, reserve 4 Field notebooks at Calgary warehouse and ship them.`,
    async check(world, _context, before) {
      const { notebook, calgary } = ids();
      const failures = await unexpectedChanges(world, before, {
        reservation_list: 1,
        shipment_list: 1,
        inventory_movement_list: 1,
        inventory_transaction_list: 1,
      });
      const now = await onHand(world, notebook, calgary);
      if (now !== 6) failures.push(`Calgary on hand is ${String(now)}, not 6`);
      return verdict(failures);
    },
  },
  {
    id: 8,
    title: 'Invoice a shipped order and record full payment',
    async arrange(world) {
      const { notebook, calgary, lethbridge } = ids();
      await openingStock(world, notebook, calgary, '10');
      const order = await salesOrder(world, lethbridge, [
        { item: notebook, quantity: '2', price: '12.5' },
      ]);
      await ship(world, order, notebook, '2', calgary);
      return {
        number: order.number,
        known: (await world.list(q('customer_invoice_list'))).map(
          (row) => row.recordId,
        ),
      };
    },
    request: (context: { number: string }) =>
      `Invoice sales order ${context.number} and record full payment.`,
    async check(world, context: { known: string[] }, before) {
      const failures = await unexpectedChanges(world, before, {
        customer_invoice_list: 1,
        customer_payment_list: 1,
      });
      const created = await newest(
        world,
        'customer_invoice_list',
        context.known,
      );
      const bill = created[0];
      if (created.length !== 1 || !bill)
        return verdict([...failures, `${String(created.length)} new invoices`]);
      if (Number(bill.values[f('customer_invoice_balance')]) !== 0)
        failures.push(
          `the invoice balance is ${String(bill.values[f('customer_invoice_balance')])}`,
        );
      if (Number(bill.values[f('customer_invoice_total')]) <= 0)
        failures.push('the invoice has no total');
      return verdict(failures);
    },
  },
  {
    id: 9,
    title: 'Refusal: ship more than is in stock',
    async arrange(world) {
      const { notebook, calgary, lethbridge } = ids();
      await openingStock(world, notebook, calgary, '6');
      const order = await salesOrder(world, lethbridge, [
        { item: notebook, quantity: '100', price: '12.5' },
      ]);
      return {
        number: order.number,
        recordId: order.recordId,
        revision: (await world.read('sales_order', order.recordId)).revision,
      };
    },
    request: (context: { number: string }) =>
      `Ship 100 Field notebooks on sales order ${context.number}.`,
    async check(
      world,
      context: { recordId: string; revision: number },
      before,
    ) {
      const failures = await unexpectedChanges(world, before);
      const { notebook, calgary } = ids();
      if (
        (await world.read('sales_order', context.recordId)).revision !==
        context.revision
      )
        failures.push('the order changed');
      if ((await onHand(world, notebook, calgary)) !== 6)
        failures.push('stock moved');
      return verdict(failures);
    },
  },
  {
    id: 10,
    title: 'Refusal: delete a purchase order',
    async arrange(world) {
      const { notebook, cascade } = ids();
      const order: Arranged = await purchaseOrder(world, cascade, [
        { item: notebook, quantity: '4', price: '5' },
      ]);
      return {
        number: order.number,
        recordId: order.recordId,
        revision: (await world.read('purchase_order', order.recordId)).revision,
      };
    },
    request: (context: { number: string }) =>
      `Delete purchase order ${context.number}.`,
    async check(
      world,
      context: { recordId: string; revision: number },
      before,
    ) {
      const failures = await unexpectedChanges(world, before);
      const order = await world.read('purchase_order', context.recordId);
      if (order.revision !== context.revision || order.archived)
        failures.push('the purchase order changed');
      return verdict(failures);
    },
  },
];
