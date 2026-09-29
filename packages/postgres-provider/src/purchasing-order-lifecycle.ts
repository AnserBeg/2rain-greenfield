import type { PoolClient } from 'pg';
import type { TrustedRequestContext } from '@north-star/runtime';
import {
  receiptColumn,
  receiptDecimal,
  receiptError,
  receiptQuantity,
  receiptRelation,
  receiptRow,
  receiptTable,
  receivedLedger,
  quoteReceiptIdentifier as q,
  type ReceiptBinding,
} from './goods-receipt.js';

/** Shared with receiving: order first, then order lines in canonical order.
 * Caller owns the gateway's trust/idempotency transaction; this never commits.
 *
 * A close needs nothing open on any line: a line's open remainder is closed
 * first by amending its ordered quantity down to what was received, with a
 * reason. A cancel of a released order is refused after any net receipt
 * (PURCHASING-PARITY), as a sales order's is after any net shipment.
 */
export async function changePurchaseOrderState(
  client: PoolClient,
  binding: ReceiptBinding,
  context: TrustedRequestContext,
  legalEntityId: string,
  orderId: string,
  expectedRevision: number,
  action: 'close' | 'reopen' | 'cancel',
) {
  const order = await receiptRow(
    client,
    binding.order,
    context,
    legalEntityId,
    orderId,
    true,
  );
  const stateColumn = receiptColumn(
    binding.order,
    'derived_state_field.machine.purchase_order_lifecycle',
  );
  const namespace = binding.order.entityId.split(':')[0]!;
  const [fromState, toState] =
    action === 'close'
      ? ['released', 'closed']
      : action === 'reopen'
        ? ['closed', 'released']
        : ['released', 'cancelled'];
  const from = `${namespace}:state.purchase_order_${fromState}`;
  const to = `${namespace}:state.purchase_order_${toState}`;
  if (
    order.archived_at !== null ||
    Number(order.revision) !== expectedRevision ||
    order[stateColumn] !== from
  )
    throw receiptError(
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
      'Order state or revision changed',
    );
  const lines = await client.query(
    `SELECT * FROM ${receiptTable(binding.orderLine)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(binding.orderLine.legalEntity!.column)}=$3 AND ${q(receiptRelation(binding, binding.orderLine, 'purchase_order_line_order'))}=$4 AND archived_at IS NULL ORDER BY record_id FOR NO KEY UPDATE`,
    [context.tenantId, context.environmentId, legalEntityId, orderId],
  );
  if (action !== 'reopen')
    for (const line of lines.rows) {
      const ledger = await receivedLedger(
        client,
        binding,
        context,
        legalEntityId,
        String(line.record_id),
      );
      if (action === 'cancel') {
        if (receiptQuantity(ledger.quantity) !== 0n)
          throw receiptError(
            'RECEIPT_QUANTITY_OUT_OF_BOUNDS',
            "Cancellation is refused after any net receipt; close each line's open remainder with a reason, then close the order",
            {
              orderLineId: String(line.record_id),
              receivedBefore: ledger.quantity,
            },
          );
        continue;
      }
      const ordered = receiptQuantity(
        String(
          line[
            receiptColumn(
              binding.orderLine,
              'purchase_order_line_ordered_quantity',
            )
          ],
        ),
      );
      const open = ordered - receiptQuantity(ledger.quantity);
      if (open !== 0n)
        throw receiptError(
          'RECEIPT_QUANTITY_OUT_OF_BOUNDS',
          "Receive or correct every active line to zero open-to-receive before closing, or close a line's open remainder with a reason",
          {
            orderLineId: String(line.record_id),
            orderedQuantity: receiptDecimal(ordered),
            receivedBefore: ledger.quantity,
            openToReceive: receiptDecimal(open),
          },
        );
    }
  await client.query(
    `UPDATE ${receiptTable(binding.order)} SET ${q(stateColumn)}=$5, revision=revision+1 WHERE tenant_id=$1 AND environment_id=$2 AND ${q(binding.order.legalEntity!.column)}=$3 AND record_id=$4`,
    [context.tenantId, context.environmentId, legalEntityId, orderId, to],
  );
  const after = await receiptRow(
    client,
    binding.order,
    context,
    legalEntityId,
    orderId,
  );
  if (
    after[stateColumn] !== to ||
    Number(after.revision) !== expectedRevision + 1
  )
    throw receiptError(
      'RECEIPT_PROJECTION_DIVERGED',
      'Order state transition failed read-back',
    );
  return {
    before: from,
    after: to,
    revision: expectedRevision + 1,
    fieldId: binding.order.columns.find(
      (column) => column.physicalName === stateColumn,
    )!.canonicalFieldId,
  };
}

/**
 * Quantity is intent, never a rewrite of received facts. Same lock order as
 * posting. `'received'` closes the line's open remainder: the new ordered
 * quantity is what is received when this runs, read under the same locks.
 */
export async function amendOrderedQuantity(
  client: PoolClient,
  binding: ReceiptBinding,
  context: TrustedRequestContext,
  legalEntityId: string,
  orderLineId: string,
  expectedRevision: number,
  quantity: string | 'received',
) {
  const initial = await receiptRow(
    client,
    binding.orderLine,
    context,
    legalEntityId,
    orderLineId,
  );
  const orderId = String(
    initial[
      receiptRelation(binding, binding.orderLine, 'purchase_order_line_order')
    ],
  );
  const order = await receiptRow(
    client,
    binding.order,
    context,
    legalEntityId,
    orderId,
    true,
  );
  if (
    order.archived_at !== null ||
    !String(
      order[
        receiptColumn(
          binding.order,
          'derived_state_field.machine.purchase_order_lifecycle',
        )
      ],
    ).endsWith(':state.purchase_order_released')
  )
    throw receiptError(
      'RECEIPT_ORDER_NOT_RELEASED',
      'Reopen a closed order before amending ordered quantity',
    );
  const line = await receiptRow(
    client,
    binding.orderLine,
    context,
    legalEntityId,
    orderLineId,
    true,
  );
  if (
    line.archived_at !== null ||
    Number(line.revision) !== expectedRevision ||
    line[
      receiptRelation(binding, binding.orderLine, 'purchase_order_line_order')
    ] !== orderId
  )
    throw receiptError(
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
      'Order line changed',
    );
  const ledger = await receivedLedger(
    client,
    binding,
    context,
    legalEntityId,
    orderLineId,
  );
  const ordered =
    quantity === 'received'
      ? receiptQuantity(ledger.quantity)
      : receiptQuantity(quantity);
  if (ordered < 0n || ordered < receiptQuantity(ledger.quantity))
    throw receiptError(
      'RECEIPT_QUANTITY_OUT_OF_BOUNDS',
      'Ordered quantity cannot be below received quantity',
      {
        orderLineId,
        orderedQuantity: receiptDecimal(ordered),
        receivedBefore: ledger.quantity,
      },
    );
  const column = receiptColumn(
    binding.orderLine,
    'purchase_order_line_ordered_quantity',
  );
  await client.query(
    `UPDATE ${receiptTable(binding.orderLine)} SET ${q(column)}=$5,revision=revision+1 WHERE tenant_id=$1 AND environment_id=$2 AND ${q(binding.orderLine.legalEntity!.column)}=$3 AND record_id=$4`,
    [
      context.tenantId,
      context.environmentId,
      legalEntityId,
      orderLineId,
      receiptDecimal(ordered),
    ],
  );
  const after = await receiptRow(
    client,
    binding.orderLine,
    context,
    legalEntityId,
    orderLineId,
  );
  if (
    receiptQuantity(String(after[column])) !== ordered ||
    Number(after.revision) !== expectedRevision + 1
  )
    throw receiptError(
      'RECEIPT_PROJECTION_DIVERGED',
      'Amendment failed read-back',
    );
  return {
    before: String(line[column]),
    after: receiptDecimal(ordered),
    revision: expectedRevision + 1,
    fieldId: binding.orderLine.columns.find(
      (field) => field.physicalName === column,
    )!.canonicalFieldId,
  };
}
