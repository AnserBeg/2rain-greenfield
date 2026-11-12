/**
 * The purchasing workspace, rendered by the real SurfaceRuntime from the real
 * compiled release over in-memory storage (see `purchasing-fixture.ts`).
 *
 * These assert what a purchasing clerk can read and do on the two screens —
 * not markup for its own sake — plus the arithmetic and escaping rules the
 * primitives promise. Posting a receipt is NOT covered here: that runs through
 * the receiving capability against PostgreSQL and is exercised by
 * `browser/receiving.composed-application.spec.ts`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  renderSurfaceRuntimeWithData,
  submitSurfaceRuntimeIntent,
} from '../src/surface-runtime.js';
import {
  formatAmount,
  formatDate,
  formatQuantity,
  formatUnitPrice,
  multiplyDecimal,
  parseDecimal,
  percentOf,
} from '../src/ui/format.js';
import {
  actionMenu,
  dataTable,
  disclosure,
  statusBadge,
} from '../src/ui/primitives.js';
import { PRIMITIVE_STYLES } from '../src/ui/primitives-styles.js';
import {
  createPurchasingFixture,
  FIXTURE_NAMESPACE,
  seedPurchasing,
  type PurchasingFixture,
} from './purchasing-fixture.js';

const NOW = new Date();

function seeded() {
  const fixture = createPurchasingFixture();
  return { fixture, ids: seedPurchasing(fixture.executor, NOW) };
}

async function get(fixture: PurchasingFixture, url: string): Promise<string> {
  const response = await fixture.entry.run({ headers: {} }, (view) =>
    renderSurfaceRuntimeWithData(view, url, fixture.gateways),
  );
  assert.equal(response.statusCode, 200);
  return response.html;
}

/** The inner HTML of the first element carrying `attribute="value"`. */
function row(html: string, attribute: string, value: string): string {
  const start = html.indexOf(`${attribute}="${value}"`);
  assert.notEqual(start, -1, `no element with ${attribute}="${value}"`);
  return html.slice(start, html.indexOf('</tr>', start));
}

function cells(rowHtml: string, attribute: string): string[] {
  return [
    ...rowHtml.matchAll(new RegExp(`${attribute}="[^"]*"[^>]*>([^<]*)<`, 'gu')),
  ].map((match) => match[1]!);
}

test('exact decimals: totals never pass through floating point', () => {
  const quantity = parseDecimal('25')!;
  const price = parseDecimal('12.495')!;
  assert.equal(formatAmount(multiplyDecimal(quantity, price)), '312.38');
  assert.equal(formatUnitPrice(price), '12.495');
  assert.equal(
    formatAmount(parseDecimal('0.1')! + parseDecimal('0.2')!),
    '0.30',
  );
  assert.equal(formatQuantity(parseDecimal('1500')!), '1,500');
  assert.equal(formatQuantity(parseDecimal('2.50')!), '2.5');
  assert.equal(parseDecimal('1e3'), null);
  assert.equal(parseDecimal(null), null);
  assert.equal(percentOf(parseDecimal('80')!, parseDecimal('200')!), 40);
  assert.equal(formatDate(new Date('2026-07-30T23:59:00.000Z')), '30 Jul 2026');
});

test('primitives escape text, and render nothing rather than an empty control', () => {
  assert.match(
    statusBadge({ label: '<b>Draft</b>', role: 'attention' }),
    /&lt;b&gt;Draft&lt;\/b&gt;/u,
  );
  assert.equal(
    actionMenu({ describedAs: 'More', items: [], label: 'More' }),
    '',
  );
  assert.equal(
    dataTable({
      caption: 'Nothing',
      columns: [],
      emptyHtml: '<p>empty</p>',
      rows: [],
    }),
    '<p>empty</p>',
  );
  assert.match(
    disclosure({ bodyHtml: '<p>x</p>', summary: 'Notes' }),
    /^<details class="ui-disclosure">/u,
  );
  assert.match(
    disclosure({ bodyHtml: '', open: true, summary: 'Notes' }),
    /^<details class="ui-disclosure" open>/u,
  );
  // Colour is tokens only; the hex-literal ratchet reads this file too.
  assert.doesNotMatch(PRIMITIVE_STYLES, /#[0-9a-f]{3,8}\b/iu);
});

test('worklist: each order shows status, supplier, receiving progress and value', async () => {
  const { fixture, ids } = seeded();
  const html = await get(fixture, fixture.url('purchase_order_list'));
  assert.match(html, /data-purchase-order-worklist="6"/u);
  assert.match(html, /data-list-coverage="1–6 of 6"/u);

  const released = row(html, 'data-record-id', ids.releasedOrderId);
  assert.match(released, /Open Purchase order PO-2038/u);
  assert.match(released, /Northwind Building Supply/u);
  assert.match(released, /data-status-kind="lifecycle">Released</u);
  assert.match(released, /data-status-kind="receiving">Partially received</u);
  assert.match(released, /128 of 273 received/u);
  assert.match(released, /1,627\.98/u);
  assert.match(released, /data-row-action="receive"/u);

  const overdue = row(html, 'data-record-id', ids.overdueOrderId);
  assert.match(overdue, /5 days overdue/u);
  // A supplier reference that matches no party is shown exactly as stored.
  assert.match(overdue, /unlisted-local-supplier/u);

  // Receiving is offered only where goods can actually be received.
  for (const id of [
    ids.draftOrderId,
    ids.closedOrderId,
    ids.cancelledOrderId,
  ]) {
    assert.match(row(html, 'data-record-id', id), /data-row-action="open"/u);
  }
  assert.match(
    row(html, 'data-record-id', ids.cancelledOrderId),
    /data-status-role="blocked" data-status-kind="lifecycle">Cancelled</u,
  );
  // No checkboxes are rendered, so no bulk bar invites a selection.
  assert.doesNotMatch(html, /data-bulk-selection-form/u);
});

test('worklist: search narrows the list and an empty result says why', async () => {
  const { fixture } = seeded();
  const found = await get(
    fixture,
    fixture.url('purchase_order_list', { q: 'PO-2031' }),
  );
  assert.match(found, /data-purchase-order-worklist="1"/u);
  assert.match(found, /value="PO-2031"/u);
  assert.match(found, />Clear</u);

  const none = await get(
    fixture,
    fixture.url('purchase_order_list', { q: 'no-such-order' }),
  );
  assert.match(none, /No matching purchase orders/u);
  assert.doesNotMatch(none, /<table/u);
});

test('worklist: with no orders at all, the empty state offers the first one', async () => {
  const fixture = createPurchasingFixture();
  const html = await get(fixture, fixture.url('purchase_order_list'));
  assert.match(html, /No purchase orders yet/u);
  assert.match(html, /New purchase order/u);
});

test('record: lines, quantities and the financial breakdown agree', async () => {
  const { fixture, ids } = seeded();
  const html = await get(
    fixture,
    fixture.url('purchase_order_detail', { record: ids.releasedOrderId }),
  );
  assert.match(html, /<h1>PO-2038<\/h1>/u);
  assert.match(html, /Purchase order · Revision 1/u);
  assert.match(html, /data-purchase-order-summary="released"/u);

  const partial = row(html, 'data-order-line', ids.partialLineId);
  assert.deepEqual(cells(partial, 'data-quantity'), ['200', '80', '120']);
  assert.match(partial, /HW-0410 · Butt hinge/u);
  assert.match(partial, /970\.00/u);

  // 200×4.85 + 48×7.2 + 25×12.495 = 1,627.975, shown to the cent.
  assert.match(html, /data-total="total"[\s\S]*?1,627\.98/u);
  assert.match(html, /data-total="received"[\s\S]*?733\.60/u);
  assert.match(html, /data-total="open"[\s\S]*?894\.38/u);
  assert.match(html, />Create goods receipt</u);
  assert.match(html, /View receipts and corrections/u);
  // Supplementary detail is present but collapsed.
  assert.match(
    html,
    /<details class="ui-disclosure" data-record-fields="supplementary">/u,
  );
});

test('record: a draft offers lines, not receiving, and shows its notes', async () => {
  const { fixture, ids } = seeded();
  const html = await get(
    fixture,
    fixture.url('purchase_order_detail', { record: ids.draftOrderId }),
  );
  assert.match(html, />Add line</u);
  assert.doesNotMatch(html, />Create goods receipt</u);
  assert.match(html, /1 unpriced line excluded/u);
  assert.match(
    html,
    /<details class="ui-disclosure" open data-purchase-order-notes="">/u,
  );
  assert.match(html, /Confirm lead time with the supplier/u);

  const empty = await get(
    fixture,
    fixture.url('purchase_order_detail', { record: ids.emptyDraftOrderId }),
  );
  assert.match(empty, /data-purchase-order-notice="no-lines"/u);
  assert.match(empty, /Add the first line/u);

  const cancelled = await get(
    fixture,
    fixture.url('purchase_order_detail', { record: ids.cancelledOrderId }),
  );
  assert.match(cancelled, /data-purchase-order-notice="cancelled"/u);
  assert.match(cancelled, /data-step-state="stopped"/u);
});

test('record: releasing a draft moves it through the real operation gateway', async () => {
  const { fixture, ids } = seeded();
  const url = fixture.url('purchase_order_detail', {
    record: ids.draftOrderId,
  });
  const response = await fixture.entry.run({ headers: {} }, (view) =>
    submitSurfaceRuntimeIntent(
      view,
      url,
      {
        expectedRevision: '1',
        idempotencyKey: randomUUID(),
        operationId: `${FIXTURE_NAMESPACE}:operation.purchase_order_release`,
        recordId: ids.draftOrderId,
      },
      fixture.gateways,
    ),
  );
  assert.equal(response.statusCode, 200);
  assert.match(response.html, /Release complete/u);
  assert.match(response.html, /data-purchase-order-summary="released"/u);
  assert.match(response.html, /Purchase order · Revision 2/u);
  assert.match(response.html, />Create goods receipt</u);
  assert.doesNotMatch(response.html, />Add line</u);
});

test('other lists and records keep the generic rendering', async () => {
  const { fixture } = seeded();
  const parties = await get(
    fixture,
    `/?surface=${encodeURIComponent(`${FIXTURE_NAMESPACE}:surface.party_list`)}`,
  );
  assert.match(
    parties,
    /data-list-result="northstar\.shared-list-result\/v1"/u,
  );
  assert.match(parties, /data-bulk-selection-form/u);
  assert.doesNotMatch(parties, /data-purchase-order-worklist/u);

  const lines = await get(fixture, fixture.url('purchase_order_line_list'));
  assert.match(lines, /data-list-result=/u);
});
