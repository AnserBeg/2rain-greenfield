import assert from 'node:assert/strict';
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
  ): Promise<SemanticRecordDto>;
  invoke(
    local: string,
    input: ImmutableJsonValue,
  ): Promise<SemanticOperationResultEnvelope>;
}

/** Two actual-cost receipts. The existing 10 opening units stay explicitly unvalued. */
export async function seedInventoryValuation(f: Fixture) {
  const ns = 'northstar.app';
  const receipts = [];
  for (const cost of ['5', '15']) {
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
        effective_at: new Date().toISOString(),
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
  return { item: f.item, company: f.scope, receipts };
}
