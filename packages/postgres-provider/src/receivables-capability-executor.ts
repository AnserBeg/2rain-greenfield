import {
  settlementCapabilityExecutorFactory,
  type SettlementSpec,
} from './settlement-capability-executor.js';

/**
 * Receivables (owner ruling C): an internal invoice (INV-) for an order's
 * shipped and not yet invoiced quantities, a recorded payment (PAY-) and a
 * credit (CM-) against one invoice, and a balance per invoice. Every figure is
 * frozen when its document posts; an invoice is void only while nothing is
 * paid or credited on it, and an order with a live invoice is not reopened
 * (ruling F). No ledger, no provider, no other currency. The settlement
 * executor runs it; this spec names what is Sales'.
 */
export const RECEIVABLES_CAPABILITY_ID =
  'northstar.sales:capability.receivables' as const;
export const RECEIVABLES_CAPABILITY_VERSION = 1 as const;

export const RECEIVABLES_SETTLEMENT_SPEC: SettlementSpec = Object.freeze({
  capabilityId: RECEIVABLES_CAPABILITY_ID,
  eventSchemaVersion: 'northstar.receivables-event/v1',
  refusalReason: 'Only named receivables operations are admitted by this route',
  entities: Object.freeze({
    document: 'customer_invoice',
    line: 'customer_invoice_line',
    payment: 'customer_payment',
    credit: 'customer_credit',
    order: 'sales_order',
    orderLine: 'sales_order_line',
    progress: 'sales_order_shipped',
  }),
  relations: Object.freeze({
    documentOrder: 'customer_invoice_order',
    lineDocument: 'customer_invoice_line_invoice',
    lineOrderLine: 'customer_invoice_line_order_line',
    paymentDocument: 'customer_payment_invoice',
    creditDocument: 'customer_credit_invoice',
    orderLineOrder: 'sales_order_line_order',
    progressOrderLine: 'sales_order_shipped_order_line',
  }),
  fields: Object.freeze({
    documentDate: 'invoice_date',
    counterparty: 'customer_party_id',
    progressQuantity: 'shipped_quantity',
    unitFrom: 'orderLine' as const,
    deliverySide: 'sales' as const,
  }),
  actions: Object.freeze([
    ['sales_order_close', 'close', 'order'],
    ['customer_invoice_post', 'post', 'document'],
    ['customer_invoice_void', 'void', 'document'],
    ['customer_payment_post', 'pay', 'payment'],
    ['customer_credit_post', 'credit', 'credit'],
    ['sales_order_reopen', 'reopen', 'order'],
  ] as const),
  datedAtPost: false,
  codes: Object.freeze({
    documentState: 'RECEIVABLES_INVOICE_STATE_CONFLICT',
    orderNotReady: 'RECEIVABLES_ORDER_NOT_INVOICEABLE',
    lineUnpriced: 'RECEIVABLES_LINE_UNPRICED',
    nothingToSettle: 'RECEIVABLES_NOTHING_TO_INVOICE',
    settled: 'RECEIVABLES_INVOICE_SETTLED',
    amountInvalid: 'RECEIVABLES_AMOUNT_INVALID',
    amountExceedsBalance: 'RECEIVABLES_AMOUNT_EXCEEDS_BALANCE',
    orderNotReopenable: 'RECEIVABLES_ORDER_NOT_REOPENABLE',
  } as const),
  messages: Object.freeze({
    targetMissing: 'Receivables target is missing or archived',
    authorizationUnbound:
      'Receivables authorization is not bound to this execution',
    readBackInexact: 'Receivables change did not read back exactly',
    targetChanged: 'Receivables target changed after authorization',
    recordChanged: 'A receivables record changed during the operation',
    draftPosts: 'Only a draft invoice posts',
    orderNotReady: 'Only a confirmed or closed order is invoiced',
    linesWritten: "An invoice's lines are written when it posts",
    lineUnpriced:
      'Every shipped line needs a price, a discount of 0-100% and a stated tax rate before it is invoiced',
    nothingToSettle: 'Every shipped quantity of this order is already invoiced',
    chargesUnpriced:
      "The order's freight and other fee each need a stated tax rate before they are invoiced",
    voidState: 'Only a posted invoice with nothing settled on it is voided',
    voidSettled:
      'An invoice with a payment or a credit is not voided; credit it instead',
    settleDraft: (kind: 'payment' | 'credit') => `Only a draft ${kind} posts`,
    amountInvalid: 'An amount is a positive figure in whole cents',
    settleState: (kind: 'payment' | 'credit') =>
      `A ${kind} posts only against an invoice with a balance`,
    exceedsBalance: (kind: 'payment' | 'credit') =>
      `The ${kind} exceeds the invoice balance`,
    reopenState: 'Only a closed order reopens',
    reopenSettled: 'An invoiced order is not reopened; void its invoices first',
  }),
  metadataKeys: Object.freeze({
    lines: 'invoicedOrderLineIds',
    document: 'invoiceId',
  }),
});

export const RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY =
  settlementCapabilityExecutorFactory(RECEIVABLES_SETTLEMENT_SPEC);
