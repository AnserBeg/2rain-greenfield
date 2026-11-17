/**
 * Governed arrange steps for the agent's tasks: each is the operation sequence
 * the screens run, invoked through the operation gateway on channel `UI` as
 * the demo manager. None of them goes through the agent.
 */
import { randomUUID } from 'node:crypto';

import type { SemanticRecordDto } from '../../packages/runtime/src/semantic-query-gateway.js';

import { NS, seededId, type AgentWorld } from './agent-world.js';

export const f = (local: string) => `${NS}:field.${local}`;
export const rel = (local: string) => `${NS}:relation.${local}`;
export const q = (local: string) => `${NS}:query.${local}`;
export const op = (local: string) => `${NS}:operation.${local}`;

export const NAMES = {
  notebook: 'Field notebook',
  calgary: 'Calgary warehouse',
  vancouver: 'Vancouver warehouse',
  cascade: 'Cascade Fastener Works',
  lethbridge: 'Lethbridge Millwork',
} as const;

export const ids = () => ({
  notebook: seededId(NAMES.notebook),
  calgary: seededId(NAMES.calgary),
  vancouver: seededId(NAMES.vancouver),
  cascade: seededId(NAMES.cascade),
  lethbridge: seededId(NAMES.lethbridge),
});

export const SHIP_TO = {
  ship_to_name: 'Lethbridge Millwork receiving',
  ship_to_street: '400 Mayor Magrath Dr',
  ship_to_city: 'Lethbridge',
  ship_to_region: 'AB',
  ship_to_postal_code: 'T1J 0A1',
  ship_to_country: 'Canada',
};

const now = () => new Date().toISOString();

async function succeed(
  world: AgentWorld,
  local: string,
  record: { recordId: string },
): Promise<SemanticRecordDto> {
  const current = await world.read(
    local.replace(/_[a-z]+$/u, ''),
    record.recordId,
  );
  const result = await world.invoke(local, {
    recordId: record.recordId,
    expectedRevision: current.revision,
  });
  if (result.outcome !== 'succeeded' || !result.readBack)
    throw new Error(`arrange ${local} withheld`);
  return result.readBack;
}

export async function openingStock(
  world: AgentWorld,
  item: string,
  location: string,
  quantity: string,
): Promise<void> {
  const id = randomUUID();
  const document = await world.create(
    'inventory_transaction',
    {
      actor_id: 'agent-arrange',
      recorded_at: now(),
      source_id: id,
      source_type: 'inventoryTransaction',
      state: `${NS}:option.inventory_transaction_state_draft`,
      effective_at: now(),
      reason_code: 'SETUP',
      reason_narrative: 'Arranged opening stock',
      type: `${NS}:option.inventory_transaction_type_adjustment`,
    },
    {},
    id,
  );
  await world.create(
    'inventory_transaction_line',
    {
      from_location_id: null,
      to_location_id: location,
      item_id: item,
      line_number: '1',
      quantity,
      unit_id: 'EA',
    },
    { transaction: document.recordId },
  );
  await succeed(world, 'inventory_transaction_post', document);
}

export interface Arranged {
  readonly recordId: string;
  readonly number: string;
  readonly lines: readonly string[];
}

export async function purchaseOrder(
  world: AgentWorld,
  supplier: string,
  lines: readonly { item: string; quantity: string; price: string }[],
  place = true,
  location = seededId(NAMES.calgary),
): Promise<Arranged> {
  const order = await world.create('purchase_order', {
    supplier_party_id: supplier,
    order_date: now(),
    currency: 'CAD',
    receiving_location_id: location,
  });
  const lineIds: string[] = [];
  for (const [index, line] of lines.entries())
    lineIds.push(
      (
        await world.create(
          'purchase_order_line',
          {
            line_number: String(index + 1),
            item_id: line.item,
            ordered_quantity: line.quantity,
            unit_price: line.price,
          },
          { order: order.recordId },
        )
      ).recordId,
    );
  if (place) await succeed(world, 'purchase_order_release', order);
  return {
    recordId: order.recordId,
    number: String(order.values[f('purchase_order_number')]),
    lines: lineIds,
  };
}

export async function salesOrder(
  world: AgentWorld,
  customer: string,
  lines: readonly { item: string; quantity: string; price: string }[],
  confirm = true,
): Promise<Arranged> {
  const order = await world.create('sales_order', {
    customer_party_id: customer,
    order_date: now(),
    requested_date: now(),
    currency: 'CAD',
    ...SHIP_TO,
  });
  const lineIds: string[] = [];
  for (const [index, line] of lines.entries())
    lineIds.push(
      (
        await world.create(
          'sales_order_line',
          {
            line_number: String(index + 1),
            item_id: line.item,
            ordered_quantity: line.quantity,
            unit_id: 'EA',
            unit_price: line.price,
          },
          { order: order.recordId },
        )
      ).recordId,
    );
  if (confirm) await succeed(world, 'sales_order_release', order);
  return {
    recordId: order.recordId,
    number: String(order.values[f('sales_order_number')]),
    lines: lineIds,
  };
}

/** Reserve and ship one order line in full from one location. */
export async function ship(
  world: AgentWorld,
  order: Arranged,
  item: string,
  quantity: string,
  location: string,
): Promise<void> {
  const reservation = await world.create(
    'reservation',
    {
      item_id: item,
      location_id: location,
      number: `RSV-${randomUUID().slice(0, 8)}`,
      quantity,
      reason: 'Arranged',
      state: `${NS}:option.reservation_state_draft`,
      unit_id: 'EA',
    },
    { order_line: order.lines[0]! },
  );
  await succeed(world, 'reservation_reserve', reservation);
  const shipment = await world.create(
    'shipment',
    {
      state: `${NS}:option.shipment_state_draft`,
      kind: `${NS}:option.shipment_kind_initial`,
      effective_at: now(),
      location_id: location,
      external_reference: null,
      reason_code: 'SHIP',
      reason_narrative: 'Arranged',
      carrier: 'Northline Freight',
      shipping_reference_kind: `${NS}:option.shipment_shipping_reference_kind_tracking`,
      shipping_reference: `TRK-${randomUUID().slice(0, 8)}`,
      ...SHIP_TO,
    },
    { order: order.recordId },
  );
  await world.create(
    'shipment_line',
    {
      line_number: '1',
      item_id: item,
      quantity,
      unit_id: 'EA',
      reversal_of_movement_id: null,
    },
    {
      shipment: shipment.recordId,
      order_line: order.lines[0]!,
      reservation: reservation.recordId,
    },
  );
  await succeed(world, 'shipment_post', shipment);
}

export async function invoice(
  world: AgentWorld,
  orderId: string,
): Promise<{ recordId: string; number: string; total: string }> {
  const draft = await world.create(
    'customer_invoice',
    {
      state: `${NS}:option.customer_invoice_state_draft`,
      invoice_date: now(),
    },
    { order: orderId },
  );
  const posted = await succeed(world, 'customer_invoice_post', draft);
  return {
    recordId: posted.recordId,
    number: String(posted.values[f('customer_invoice_number')]),
    total: canonical(String(posted.values[f('customer_invoice_total')])),
  };
}

export async function pay(
  world: AgentWorld,
  invoiceId: string,
  amount: string,
): Promise<void> {
  const payment = await world.create(
    'customer_payment',
    {
      state: `${NS}:option.customer_payment_state_draft`,
      payment_date: now(),
      amount,
      method: `${NS}:option.customer_payment_method_cash`,
      reference: null,
    },
    { invoice: invoiceId },
  );
  await succeed(world, 'customer_payment_post', payment);
}

export function canonical(value: string): string {
  return /^-?\d+\.\d+$/u.test(value)
    ? value.replace(/0+$/u, '').replace(/\.$/u, '')
    : value;
}

/** Row counts of every document list a task could write to. */
export const WATCHED_LISTS = [
  'purchase_order_list',
  'purchase_order_line_list',
  'goods_receipt_list',
  'sales_order_list',
  'sales_order_line_list',
  'reservation_list',
  'shipment_list',
  'customer_invoice_list',
  'customer_payment_list',
  'inventory_movement_list',
  'inventory_transaction_list',
] as const;

export async function snapshot(
  world: AgentWorld,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const list of WATCHED_LISTS)
    counts[list] = (await world.list(q(list))).length;
  return counts;
}

export async function onHand(
  world: AgentWorld,
  item: string,
  location: string,
): Promise<number> {
  const rows = await world.list(q('posted_stock_balance_list'), {
    fieldFilters: [
      { fieldId: f('posted_stock_balance_item_id'), value: item },
      { fieldId: f('posted_stock_balance_location_id'), value: location },
    ],
  });
  return rows.reduce(
    (sum, row) =>
      sum + Number(row.values[f('posted_stock_balance_posted_quantity')]),
    0,
  );
}

/** Another seeded customer, for invoices that must not be counted. */
export const seededCustomer = () => seededId('Ponoka Livestock Equipment');
