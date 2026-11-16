/**
 * The purchasing workflow, walked the way a person walks it: over HTTP, one
 * page at a time, reading each form from the page it was served on and
 * posting it back exactly as a browser would.
 *
 *   create order → add line → release → receive part → receive rest → close
 *   → reopen, and separately: cancel a draft.
 *
 * At every step it asserts what the purchasing employee would SEE — the
 * status, the quantities, which actions are offered, which list tab the order
 * sits under.
 *
 * SCOPE, stated plainly: the pages, forms, confirmation steps, list views and
 * state transitions are the real ones. Posting a receipt, Close and Reopen run
 * against `SimulatedReceiving` (see `purchasing-fixture.ts`), so this proves
 * the SCREENS carry the workflow, not that the posting kernel is correct.
 * `browser/receiving.composed-application.spec.ts` covers that on PostgreSQL.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createSurfaceRuntimeServer } from '../src/app-server.js';
import {
  createPurchasingFixture,
  FIXTURE_NAMESPACE,
  seedPurchasing,
  type PurchasingFixture,
} from './purchasing-fixture.js';

const NS = FIXTURE_NAMESPACE;

function unescape(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(tag);
  return match ? unescape(match[1]!) : undefined;
}

/** The fields a browser would submit for one `<form>`, with their defaults. */
function formFields(formHtml: string): URLSearchParams {
  const fields = new URLSearchParams();
  for (const [tag] of formHtml.matchAll(/<input\b[^>]*>/gu)) {
    const name = attribute(tag, 'name');
    if (name) fields.set(name, attribute(tag, 'value') ?? '');
  }
  for (const [whole, tag] of formHtml.matchAll(
    /(<select\b[^>]*>)[\s\S]*?<\/select>/gu,
  )) {
    const name = attribute(tag!, 'name');
    if (!name) continue;
    const options = [...whole.matchAll(/<option\b[^>]*>/gu)].map(([o]) => o);
    const chosen =
      options.find((option) => /\sselected(?:[\s>])/u.test(option)) ??
      options[0];
    fields.set(name, chosen ? (attribute(chosen, 'value') ?? '') : '');
  }
  return fields;
}

class Session {
  constructor(
    private readonly baseUrl: string,
    private readonly fixture: PurchasingFixture,
  ) {}

  async get(path: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}${path}`);
    assert.equal(response.status, 200, `GET ${path}`);
    return response.text();
  }

  async post(action: string, fields: URLSearchParams): Promise<string> {
    const response = await fetch(`${this.baseUrl}${action}`, {
      body: fields.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    });
    return response.text();
  }

  /** Opens a create form, fills it and saves; returns the new record id. */
  async create(
    entity: string,
    values: Readonly<Record<string, string>>,
    relations: Readonly<Record<string, string>> = {},
  ): Promise<string> {
    const page = await this.get(this.fixture.url(`${entity}_form`));
    const form = /<form id="surface-record-form"[\s\S]*?<\/form>/u.exec(page);
    assert.ok(form, `${entity} form is offered`);
    const fields = formFields(form[0]);
    for (const [name, value] of Object.entries(values)) {
      const key = `value:${NS}:field.${entity}_${name}`;
      assert.ok(fields.has(key), `${entity} form has a ${name} input`);
      fields.set(key, value);
    }
    for (const [name, recordId] of Object.entries(relations)) {
      const key = `relation:${NS}:relation.${name}`;
      assert.ok(fields.has(key), `${entity} form offers a ${name} picker`);
      // The picker must actually list the record the user is about to choose.
      assert.match(form[0], new RegExp(`<option value="${recordId}"`, 'u'));
      fields.set(key, recordId);
    }
    const saved = await this.post(
      attribute(
        /<form id="surface-record-form"[^>]*>/u.exec(page)![0],
        'action',
      )!,
      fields,
    );
    assert.match(saved, /Create complete/u, `${entity} saves`);
    return fields.get('recordId')!;
  }

  /** Presses a command button on a record page, confirming when asked. */
  async command(recordPath: string, label: string): Promise<string> {
    const page = await this.get(recordPath);
    const form = [
      ...page.matchAll(/<form class="capability-command"[\s\S]*?<\/form>/gu),
    ]
      .map(([html]) => html)
      .find((html) => html.includes(`<button type="submit">${label}</button>`));
    assert.ok(form, `"${label}" is offered`);
    const action = attribute(/<form\b[^>]*>/u.exec(form)![0], 'action')!;
    let result = await this.post(action, formFields(form));
    if (result.includes('data-confirmation-step="preview"')) {
      assert.match(result, new RegExp(`Confirm ${label}`, 'u'));
      const confirm = /<form method="post"[\s\S]*?<\/form>/u.exec(result)!;
      result = await this.post(
        attribute(/<form\b[^>]*>/u.exec(confirm[0])![0], 'action')!,
        formFields(confirm[0]),
      );
    }
    return result;
  }
}

function tabCounts(html: string): Record<string, number> {
  return Object.fromEntries(
    [
      ...html.matchAll(
        /data-view="([A-Za-z]+)"[^>]*><span>[^<]*<\/span><span class="ui-tabs__count">(\d+)/gu,
      ),
    ].map((match) => [match[1]!, Number(match[2])]),
  );
}

function quantities(html: string, orderLineId: string): string[] {
  const start = html.indexOf(`data-order-line="${orderLineId}"`);
  assert.notEqual(start, -1, 'the order line is listed');
  const row = html.slice(start, html.indexOf('</tr>', start));
  return [...row.matchAll(/data-quantity="[a-z]+">([^<]*)</gu)].map(
    (match) => match[1]!,
  );
}

async function withServer(
  run: (session: Session, fixture: PurchasingFixture) => Promise<void>,
): Promise<void> {
  const fixture = createPurchasingFixture();
  const server: Server = createSurfaceRuntimeServer(
    fixture.entry,
    fixture.gateways,
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(
      new Session(`http://127.0.0.1:${String(port)}`, fixture),
      fixture,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('workflow: an order is raised, released, received in two deliveries and closed', async () => {
  await withServer(async (session, fixture) => {
    const item = fixture.executor.seed('item', {
      base_unit: 'each',
      description: 'Walkthrough item',
      name: 'Deck screw #8',
      sku: 'FS-0808',
    });
    const location = fixture.executor.seed('location', {
      code: 'MAIN',
      name: 'Main warehouse',
      type: 'warehouse',
    });
    const list = fixture.url('purchase_order_list');

    // 1. Raise the order.
    const orderId = await session.create('purchase_order', {
      currency: 'CAD',
      expected_date: '2099-01-10T00:00:00.000Z',
      number: 'PO-3001',
      order_date: '2026-11-15T00:00:00.000Z',
      supplier_party_id: 'walkthrough-supplier',
    });
    const order = fixture.url('purchase_order_detail', { record: orderId });
    let page = await session.get(order);
    assert.match(page, /data-purchase-order-summary="draft"/u);
    assert.match(page, /data-purchase-order-notice="no-lines"/u);
    assert.deepEqual(tabCounts(await session.get(list)), {
      all: 1,
      cancelled: 0,
      closed: 0,
      draft: 1,
      overdue: 0,
      toClose: 0,
      toReceive: 0,
    });

    // 2. Add a line; the line form lets the user pick the order just raised.
    const lineId = await session.create(
      'purchase_order_line',
      {
        item_id: item,
        line_number: '1',
        ordered_quantity: '10',
        unit_price: '2.5',
      },
      { purchase_order_line_order: orderId },
    );
    page = await session.get(order);
    assert.deepEqual(quantities(page, lineId), ['10', '0', '10']);
    assert.match(page, /FS-0808 · Deck screw #8/u);
    assert.match(page, /data-total="total"[\s\S]*?25\.00/u);
    assert.match(page, />Add line</u);
    assert.doesNotMatch(page, />Create goods receipt</u);

    // 3. Release it: lines lock, receiving opens, the order changes tab.
    page = await session.command(order, 'Release');
    assert.match(page, /Release complete/u);
    assert.match(page, /data-purchase-order-summary="released"/u);
    assert.match(page, />Create goods receipt</u);
    assert.doesNotMatch(page, />Add line</u);
    assert.doesNotMatch(page, />Edit</u);
    let tabs = tabCounts(await session.get(list));
    assert.equal(tabs.draft, 0);
    assert.equal(tabs.toReceive, 1);

    // 4. First delivery: 4 of 10.
    const receive = async (number: string, quantity: string) => {
      const receiptId = await session.create(
        'goods_receipt',
        {
          effective_at: '2026-11-16T09:00:00.000Z',
          kind: `${NS}:option.goods_receipt_kind_initial`,
          location_id: location,
          number,
          reason_code: 'DELIVERY',
          reason_narrative: 'Supplier delivery',
          state: `${NS}:option.goods_receipt_state_draft`,
        },
        { goods_receipt_order: orderId },
      );
      await session.create(
        'goods_receipt_line',
        {
          cost_status: `${NS}:option.goods_receipt_line_cost_status_absent`,
          item_id: item,
          line_number: '1',
          quantity,
          unit_id: 'each',
        },
        {
          goods_receipt_line_order_line: lineId,
          goods_receipt_line_receipt: receiptId,
        },
      );
      const posted = await session.command(
        fixture.url('goods_receipt_detail', { record: receiptId }),
        'Post',
      );
      assert.match(posted, /Post complete/u);
    };
    await receive('GR-3001', '4');
    page = await session.get(order);
    assert.deepEqual(quantities(page, lineId), ['10', '4', '6']);
    assert.match(page, /data-status-kind="receiving">Partially received</u);
    assert.match(page, /data-total="received"[\s\S]*?10\.00/u);
    assert.match(page, /data-total="open"[\s\S]*?15\.00/u);

    // Closing with goods outstanding is refused, and the order is unchanged.
    const refused = await session.command(order, 'Close');
    assert.match(refused, /data-diagnostic-code=/u);
    assert.match(await session.get(order), /summary="released"/u);

    // 5. Second delivery: the remaining 6. The order moves to "Ready to close".
    await receive('GR-3002', '6');
    page = await session.get(order);
    assert.deepEqual(quantities(page, lineId), ['10', '10', '0']);
    assert.match(page, /data-status-kind="receiving">Fully received</u);
    assert.doesNotMatch(page, />Create goods receipt</u);
    tabs = tabCounts(await session.get(list));
    assert.equal(tabs.toReceive, 0);
    assert.equal(tabs.toClose, 1);
    assert.match(
      await session.get(`${list}&view=toClose`),
      /Open Purchase order PO-3001/u,
    );

    // 6. Close it.
    page = await session.command(order, 'Close');
    assert.match(page, /Close complete/u);
    assert.match(page, /data-purchase-order-summary="closed"/u);
    tabs = tabCounts(await session.get(list));
    assert.equal(tabs.toClose, 0);
    assert.equal(tabs.closed, 1);

    // 7. Reopen returns it to released.
    page = await session.command(order, 'Reopen');
    assert.match(page, /Reopen complete/u);
    assert.match(page, /data-purchase-order-summary="released"/u);
  });
});

test('workflow: a draft is cancelled behind a confirmation and then offers nothing further', async () => {
  await withServer(async (session, fixture) => {
    const { draftOrderId } = seedPurchasing(fixture.executor, new Date());
    const order = fixture.url('purchase_order_detail', {
      record: draftOrderId,
    });
    const page = await session.command(order, 'Cancel');
    assert.match(page, /Cancel complete/u);
    assert.match(page, /data-purchase-order-summary="cancelled"/u);
    assert.match(page, /data-purchase-order-notice="cancelled"/u);
    for (const label of ['Release', 'Cancel', 'Edit']) {
      assert.doesNotMatch(page, new RegExp(`>${label}</(?:button|a)>`, 'u'));
    }
    const cancelled = await session.get(
      `${fixture.url('purchase_order_list')}&view=cancelled`,
    );
    assert.match(cancelled, /Open Purchase order PO-2041/u);
  });
});
