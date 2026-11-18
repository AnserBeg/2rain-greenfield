/** Child collections an operation consumes for its target. Scope is the
 * declared storage relation's ownership, also used by the query gateway. */
export interface ChildRead {
  query: string;
  relation: string;
  scope: 'parentScope' | 'referenceScope';
}
const child = (
  entity: string,
  relation: string,
  scope: ChildRead['scope'] = 'parentScope',
): ChildRead => ({ query: entity + '_list', relation, scope });
const purchaseLines = child('purchase_order_line', 'purchase_order_line_order');
const approvals = child(
  'purchase_order_approval',
  'purchase_order_approval_order',
  'referenceScope',
);
const salesLines = child('sales_order_line', 'sales_order_line_order');
const invoiceLines = child(
  'customer_invoice_line',
  'customer_invoice_line_invoice',
);
const billLines = child('vendor_bill_line', 'vendor_bill_line_bill');
const reads: Record<string, readonly ChildRead[]> = {
  goods_receipt_post: [
    child('goods_receipt_line', 'goods_receipt_line_receipt'),
  ],
  inventory_transaction_post: [
    child(
      'inventory_transaction_line',
      'inventory_transaction_line_transaction',
    ),
  ],
  shipment_post: [child('shipment_line', 'shipment_line_shipment')],
  purchase_order_submit: [purchaseLines, approvals],
  purchase_order_release: [purchaseLines, approvals],
  purchase_order_line_amend: [
    child(
      'purchase_order_amendment',
      'purchase_order_amendment_order_line',
      'referenceScope',
    ),
  ],
  purchase_order_cancel: [purchaseLines],
  purchase_order_close: [purchaseLines],
  purchase_order_reopen: [purchaseLines],
  purchase_order_approval_approve: [],
  purchase_order_approval_reject: [],
  sales_order_release: [salesLines],
  sales_order_close: [salesLines],
  sales_order_cancel: [salesLines],
  sales_order_reopen: [salesLines],
  customer_invoice_post: [invoiceLines],
  customer_invoice_void: [invoiceLines],
  vendor_bill_post: [billLines],
  vendor_bill_void: [billLines],
  customer_credit_post: [],
  customer_payment_post: [],
  vendor_credit_post: [],
  vendor_payment_post: [],
  reservation_reserve: [],
  reservation_release: [],
};
export function capabilityChildren(operation: string): readonly ChildRead[] {
  const declared = reads[operation];
  if (!declared)
    throw new Error('Child read coverage is not declared for this capability');
  return declared;
}
