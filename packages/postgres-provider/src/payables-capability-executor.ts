import {
  settlementCapabilityExecutorFactory,
  type SettlementSpec,
} from './settlement-capability-executor.js';

/**
 * Payables (owner ruling PY-A, ruling C mirrored for suppliers): an internal
 * vendor bill (BILL-) for a purchase order's received and not yet billed
 * quantities (PY-B) at each line's frozen cost, discount and tax rate, the
 * order's freight and other fee on its first live bill (PY-C), dated when it
 * posts and due after the order's terms (PY-D); a recorded vendor payment
 * (VPAY-) and a vendor credit (VCM-) against one bill (PY-I), and a balance
 * per bill. A supplier's own invoice number appears on at most one of its
 * live bills (PY-F). No ledger, no provider, no other currency. The
 * settlement executor runs it; this spec names what is Purchasing's.
 */
export const PAYABLES_CAPABILITY_ID =
  'northstar.purchasing:capability.payables' as const;
export const PAYABLES_CAPABILITY_VERSION = 1 as const;

export const PAYABLES_SETTLEMENT_SPEC: SettlementSpec = Object.freeze({
  capabilityId: PAYABLES_CAPABILITY_ID,
  eventSchemaVersion: 'northstar.payables-event/v1',
  refusalReason: 'Only named payables operations are admitted by this route',
  entities: Object.freeze({
    document: 'vendor_bill',
    line: 'vendor_bill_line',
    payment: 'vendor_payment',
    credit: 'vendor_credit',
    order: 'purchase_order',
    orderLine: 'purchase_order_line',
    progress: 'purchase_order_received',
  }),
  relations: Object.freeze({
    documentOrder: 'vendor_bill_order',
    lineDocument: 'vendor_bill_line_bill',
    lineOrderLine: 'vendor_bill_line_order_line',
    paymentDocument: 'vendor_payment_bill',
    creditDocument: 'vendor_credit_bill',
    orderLineOrder: 'purchase_order_line_order',
    progressOrderLine: 'purchase_order_received_order_line',
  }),
  fields: Object.freeze({
    documentDate: 'bill_date',
    counterparty: 'supplier_party_id',
    progressQuantity: 'received_quantity',
    // A purchase order line carries no unit; the receipt recorded one.
    unitFrom: 'progress' as const,
    deliverySide: 'purchase' as const,
    uniqueReference: 'supplier_invoice_number',
  }),
  actions: Object.freeze([
    ['purchase_order_close', 'close', 'order'],
    ['vendor_bill_post', 'post', 'document'],
    ['vendor_bill_void', 'void', 'document'],
    ['vendor_payment_post', 'pay', 'payment'],
    ['vendor_credit_post', 'credit', 'credit'],
  ] as const),
  datedAtPost: true,
  codes: Object.freeze({
    documentState: 'PAYABLES_BILL_STATE_CONFLICT',
    orderNotReady: 'PAYABLES_ORDER_NOT_BILLABLE',
    lineUnpriced: 'PAYABLES_LINE_UNPRICED',
    nothingToSettle: 'PAYABLES_NOTHING_TO_BILL',
    settled: 'PAYABLES_BILL_SETTLED',
    amountInvalid: 'PAYABLES_AMOUNT_INVALID',
    amountExceedsBalance: 'PAYABLES_AMOUNT_EXCEEDS_BALANCE',
    duplicateReference: 'PAYABLES_DUPLICATE_SUPPLIER_INVOICE',
  } as const),
  messages: Object.freeze({
    targetMissing: 'Payables target is missing or archived',
    authorizationUnbound:
      'Payables authorization is not bound to this execution',
    readBackInexact: 'Payables change did not read back exactly',
    targetChanged: 'Payables target changed after authorization',
    recordChanged: 'A payables record changed during the operation',
    draftPosts: 'Only a draft bill posts',
    orderNotReady: 'Only a released or closed purchase order is billed',
    linesWritten: "A bill's lines are written when it posts",
    lineUnpriced:
      'Every received line needs a unit cost, a discount of 0-100% and a stated tax rate before it is billed',
    nothingToSettle: 'Every received quantity of this order is already billed',
    chargesUnpriced:
      "The order's freight and other fee each need a stated tax rate before they are billed",
    voidState: 'Only a posted bill with nothing settled on it is voided',
    voidSettled:
      'A bill with a payment or a credit is not voided; record a vendor credit instead',
    settleDraft: (kind: 'payment' | 'credit') => `Only a draft ${kind} posts`,
    amountInvalid: 'An amount is a positive figure in whole cents',
    settleState: (kind: 'payment' | 'credit') =>
      `A ${kind} posts only against a bill with a balance`,
    exceedsBalance: (kind: 'payment' | 'credit') =>
      `The ${kind} exceeds the bill balance`,
    duplicateReference:
      "This supplier invoice number is already on another of the vendor's bills",
    orderChanged:
      'The purchase order changed while its bill posted; post the bill again',
  }),
  metadataKeys: Object.freeze({
    lines: 'billedOrderLineIds',
    document: 'billId',
  }),
});

export const PAYABLES_CAPABILITY_EXECUTOR_FACTORY =
  settlementCapabilityExecutorFactory(PAYABLES_SETTLEMENT_SPEC);
