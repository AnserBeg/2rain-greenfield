import type { AgentWorld } from '../agent/agent-world.js';

export * from './inspection-definition.js';

export async function inspectionLinkRecords(
  create: AgentWorld['create'],
  seededId: (name: string) => string,
) {
  const supplier = seededId('Cascade Fastener Works');
  const item = seededId('Field notebook');
  const location = seededId('Calgary warehouse');
  const order = await create('purchase_order', {
    supplier_party_id: supplier,
    order_date: '2026-11-18T00:00:00.000Z',
    currency: 'CAD',
  });
  const receipt = await create(
    'goods_receipt',
    {
      state: 'northstar.app:option.goods_receipt_state_draft',
      kind: 'northstar.app:option.goods_receipt_kind_initial',
      effective_at: '2026-11-18T00:00:00.000Z',
      location_id: location,
      reason_code: 'RECEIVE',
      reason_narrative: 'Incoming lot to inspect',
    },
    { order: order.recordId },
  );
  return { receipt, supplier, item, location };
}
