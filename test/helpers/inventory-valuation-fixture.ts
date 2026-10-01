import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import type { SemanticRecordDto } from '../../packages/runtime/src/semantic-query-gateway.js';
import type { SemanticOperationResultEnvelope } from '../../packages/runtime/src/semantic-operation-gateway.js';
interface Fixture {
  readonly item: string;
  readonly scope: string;
  readonly customer: string;
  readonly location: string;
  create(
    local: string,
    values: Record<string, ImmutableJsonValue>,
    relations?: Record<string, string>,
    scoped?: boolean,
  ): Promise<SemanticRecordDto>;
  invoke(
    local: string,
    input: ImmutableJsonValue,
  ): Promise<SemanticOperationResultEnvelope>;
}

/** Two actual-cost receipts. The existing 10 opening units stay explicitly unvalued. */
export async function seedInventoryValuation(
  f: Fixture,
  options: {
    readonly costs?: readonly string[];
    readonly effectiveAt?: string;
  } = {},
) {
  const ns = 'northstar.app';
  const receipts = [];
  const effectiveAt = options.effectiveAt ?? new Date().toISOString();
  for (const cost of options.costs ?? ['5', '15']) {
    const order = await f.create('purchase_order', {
      supplier_party_id: f.customer,
      order_date: new Date().toISOString(),
      expected_date: null,
      currency: 'CAD',
      notes: null,
      freight_amount: '10',
      other_fee_amount: '5',
    });
    const line = await f.create(
      'purchase_order_line',
      {
        line_number: '1',
        item_id: f.item,
        ordered_quantity: '10',
        // The estimate differs deliberately from the captured actual cost.
        unit_price: '99',
      },
      { order: order.recordId },
    );
    const confirmed = await f.invoke('purchase_order_release', {
      recordId: order.recordId,
      expectedRevision: order.revision,
    });
    assert.equal(confirmed.outcome, 'succeeded');
    const receipt = await f.create(
      'goods_receipt',
      {
        state: `${ns}:option.goods_receipt_state_draft`,
        kind: `${ns}:option.goods_receipt_kind_initial`,
        effective_at: effectiveAt,
        location_id: f.location,
        reason_code: 'RECEIVE',
        reason_narrative: 'Actual-cost valuation proof',
      },
      { order: order.recordId },
    );
    const receiptLine = await f.create(
      'goods_receipt_line',
      {
        line_number: '1',
        item_id: f.item,
        quantity: '10',
        unit_id: 'EA',
        cost_status: `${ns}:option.goods_receipt_line_cost_status_known`,
        unit_cost: cost,
        currency: 'CAD',
        reversal_of_movement_id: null,
      },
      { receipt: receipt.recordId, order_line: line.recordId },
    );
    const posted = await f.invoke('goods_receipt_post', {
      recordId: receipt.recordId,
      expectedRevision: receipt.revision,
    });
    assert.equal(posted.outcome, 'succeeded');
    receipts.push({ order, line, receipt, receiptLine });
  }
  return { item: f.item, company: f.scope, receipts, effectiveAt };
}

/** Fully costed stock, four shipped/invoiced units, then a later cost-changing receipt. */
export async function seedInventoryShipmentValuation(f: Fixture) {
  const ns = 'northstar.app';
  const item = await f.create(
    'item',
    {
      sku: `VAL-COST-${randomUUID().slice(0, 8)}`,
      name: 'Costed notebook',
      description: null,
      base_unit: 'EA',
      price_cad: '25',
    },
    {},
    false,
  );
  const costed = { ...f, item: item.recordId };
  // Business effective instants distinguish the later receipt even if recorded times tie.
  const initialAt = new Date(Date.now() - 1000).toISOString();
  const received = await seedInventoryValuation(costed, {
    effectiveAt: initialAt,
  });
  const shipTo = {
    ship_to_name: 'Receiving dock',
    ship_to_street: '100 Industrial Way',
    ship_to_city: 'Calgary',
    ship_to_region: 'AB',
    ship_to_postal_code: 'T2P 0A1',
    ship_to_country: 'Canada',
  };
  const order = await f.create('sales_order', {
    customer_party_id: f.customer,
    order_date: new Date().toISOString(),
    requested_date: null,
    currency: 'CAD',
    notes: null,
    payment_terms: `${ns}:option.sales_order_payment_terms_net_30`,
    freight_amount: '10',
    other_fee_amount: '5',
    ...shipTo,
  });
  const orderLine = await f.create(
    'sales_order_line',
    {
      line_number: '1',
      item_id: item.recordId,
      unit_id: 'EA',
      ordered_quantity: '4',
      unit_price: '25',
      list_price: '25',
      discount_percent: null,
    },
    { order: order.recordId },
  );
  const release = await f.invoke('sales_order_release', {
    recordId: order.recordId,
    expectedRevision: order.revision,
  });
  assert.equal(release.outcome, 'succeeded');
  const reservation = await f.create(
    'reservation',
    {
      number: randomUUID(),
      state: `${ns}:option.reservation_state_draft`,
      item_id: item.recordId,
      location_id: f.location,
      quantity: '4',
      unit_id: 'EA',
      reason: 'Valuation proof',
    },
    { order_line: orderLine.recordId },
  );
  assert.equal(
    (
      await f.invoke('reservation_reserve', {
        recordId: reservation.recordId,
        expectedRevision: reservation.revision,
      })
    ).outcome,
    'succeeded',
  );
  const shipment = await f.create(
    'shipment',
    {
      state: `${ns}:option.shipment_state_draft`,
      kind: `${ns}:option.shipment_kind_initial`,
      effective_at: new Date(Date.parse(initialAt) + 1).toISOString(),
      location_id: f.location,
      external_reference: null,
      reason_code: 'SHIP',
      reason_narrative: 'Derived shipment cost proof',
      carrier: 'Northline',
      shipping_reference_kind: `${ns}:option.shipment_shipping_reference_kind_tracking`,
      shipping_reference: 'VAL-COST',
      ...shipTo,
    },
    { order: order.recordId },
  );
  const shipmentLine = await f.create(
    'shipment_line',
    {
      line_number: '1',
      item_id: item.recordId,
      quantity: '4',
      unit_id: 'EA',
      reversal_of_movement_id: null,
    },
    {
      shipment: shipment.recordId,
      order_line: orderLine.recordId,
      reservation: reservation.recordId,
    },
  );
  assert.equal(
    (
      await f.invoke('shipment_post', {
        recordId: shipment.recordId,
        expectedRevision: shipment.revision,
      })
    ).outcome,
    'succeeded',
  );
  const invoice = await f.create(
    'customer_invoice',
    {
      state: `${ns}:option.customer_invoice_state_draft`,
      invoice_date: new Date().toISOString(),
    },
    { order: order.recordId },
  );
  assert.equal(
    (
      await f.invoke('customer_invoice_post', {
        recordId: invoice.recordId,
        expectedRevision: invoice.revision,
      })
    ).outcome,
    'succeeded',
  );
  const later = await seedInventoryValuation(costed, {
    costs: ['30'],
    effectiveAt: new Date(Date.parse(initialAt) + 2).toISOString(),
  });
  return {
    item: item.recordId,
    company: f.scope,
    order: order.recordId,
    orderLine: orderLine.recordId,
    shipment: shipment.recordId,
    shipmentLine: shipmentLine.recordId,
    invoice: invoice.recordId,
    receipts: [...received.receipts, ...later.receipts],
  };
}
