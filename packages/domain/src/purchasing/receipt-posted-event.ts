/** The existing versioned event written by receipt posting. */
export const RECEIPT_POSTED_EVENT = Object.freeze({
  postingAction: 'northstar.purchasing:capability.receiving',
  eventType: 'northstar.purchasing:event.receipt_posted',
  schemaVersion: 'northstar.purchasing-receipt-posted/v1',
  recordType: 'northstar.purchasing:record.goods_receipt',
});
