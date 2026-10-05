import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { InventoryPostingError } from '../../packages/postgres-provider/src/inventory-posting-error.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticRecordDto,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';
const shipTo = {
  ship_to_name: 'Receiving dock',
  ship_to_street: '100 Industrial Way',
  ship_to_city: 'Calgary',
  ship_to_region: 'AB',
  ship_to_postal_code: 'T2P 0A1',
  ship_to_country: 'Canada',
};

function refusedWith(code: string, message?: RegExp) {
  return (error: unknown) => {
    assert.ok(
      error instanceof InventoryPostingError,
      `expected ${code}, got ${String(error)}`,
    );
    assert.equal(error.code, code, String(error));
    if (message) assert.match(error.message, message);
    return true;
  };
}

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

/** Orders, their flow and the credit figures their pages read, over one fixture. */
function creditKit(fixture: Fixture) {
  const operate = async (
    operation: string,
    record: { recordId: string; revision: number },
  ) => {
    const result = await fixture.invoke(operation, {
      recordId: record.recordId,
      expectedRevision: record.revision,
    });
    assert.equal(result.outcome, 'succeeded', operation);
    return result.readBack!;
  };
  const readParty = () => read('party', fixture.customer, false);
  /** Sets the customer's limit and hold through its governed update. */
  const setCredit = async (patch: Record<string, ImmutableJsonValue>) => {
    const current = await readParty();
    const result = await fixture.invoke('party_update', {
      recordId: fixture.customer,
      expectedRevision: current.revision,
      patch: Object.fromEntries(
        Object.entries(patch).map(([name, value]) => [
          `${ns}:field.party_${name}`,
          value,
        ]),
      ),
    });
    assert.equal(result.outcome, 'succeeded');
  };
  /** A draft order of `quantity` EA at 10.00, taxed 5%: 10.50 each. */
  const draft = async (quantity: string, currency = 'CAD', price = '10') => {
    const header = await fixture.create('sales_order', {
      customer_party_id: fixture.customer,
      order_date: new Date().toISOString(),
      requested_date: null,
      currency,
      notes: null,
      ...shipTo,
    });
    const line = await fixture.create(
      'sales_order_line',
      {
        item_id: fixture.item,
        unit_id: 'EA',
        line_number: '1',
        ordered_quantity: quantity,
        unit_price: price === '' ? null : price,
        list_price: price === '' ? null : price,
        discount_percent: null,
        tax_code_id: fixture.taxCode,
        tax_rate_percent: '5',
      },
      { order: header.recordId },
    );
    return { header, line };
  };
  const confirm = (order: { header: { recordId: string; revision: number } }) =>
    operate('sales_order_release', order.header);
  async function read(
    local: string,
    recordId: string,
    scoped = true,
  ): Promise<SemanticRecordDto> {
    const result = await fixture.app.runtime.entry.run(
      { headers: {} },
      (view) => {
        const definition = registeredSemanticQueryFromPinnedView(
          view,
          `${ns}:query.${local}_get`,
        )!;
        return fixture.app.runtime.queryGateway.invoke(view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId: definition.queryId,
          arguments: {
            recordId,
            includeArchived: false,
            ...(scoped
              ? {
                  [definition.legalEntityScope!.operand.parameterId]:
                    fixture.scope,
                }
              : {}),
          },
        });
      },
    );
    assert.equal(result.outcome, 'exact', `${local} ${recordId}`);
    return result.records[0]!;
  }
  /** What a page states of the customer's credit. */
  const credit = (record: SemanticRecordDto) =>
    Object.fromEntries(
      [
        'customer_credit_limit',
        'customer_open_balance',
        'customer_on_order',
        'customer_available_credit',
        'customer_credit_status',
      ].map((name) => [
        name.replace('customer_', ''),
        record.values[`${ns}:metric.${name}`] ?? null,
      ]),
    );
  const orderCredit = async (orderId: string) =>
    credit(await read('commercial_order', orderId));
  const customerCredit = async () =>
    credit(await read('party_credit', fixture.customer, false));
  const ship = async (
    order: { header: { recordId: string }; line: { recordId: string } },
    quantity: string,
  ) => {
    const reservation = await operate(
      'reservation_reserve',
      await fixture.create(
        'reservation',
        {
          number: randomUUID(),
          state: `${ns}:option.reservation_state_draft`,
          item_id: fixture.item,
          location_id: fixture.location,
          quantity,
          unit_id: 'EA',
          reason: 'Credit proof',
        },
        { order_line: order.line.recordId },
      ),
    );
    const shipment = await fixture.create(
      'shipment',
      {
        state: `${ns}:option.shipment_state_draft`,
        kind: `${ns}:option.shipment_kind_initial`,
        effective_at: new Date().toISOString(),
        location_id: fixture.location,
        external_reference: null,
        reason_code: 'SHIP',
        reason_narrative: 'Credit proof',
        carrier: 'Purolator',
        shipping_reference_kind: `${ns}:option.shipment_shipping_reference_kind_tracking`,
        shipping_reference: randomUUID(),
        ...shipTo,
      },
      { order: order.header.recordId },
    );
    await fixture.create(
      'shipment_line',
      {
        line_number: '1',
        item_id: fixture.item,
        quantity,
        unit_id: 'EA',
        reversal_of_movement_id: null,
      },
      {
        shipment: shipment.recordId,
        order_line: order.line.recordId,
        reservation: reservation.recordId,
      },
    );
    return operate('shipment_post', shipment);
  };
  const invoice = async (orderId: string) =>
    operate(
      'customer_invoice_post',
      await fixture.create(
        'customer_invoice',
        {
          state: `${ns}:option.customer_invoice_state_draft`,
          invoice_date: new Date().toISOString(),
        },
        { order: orderId },
      ),
    );
  const pay = async (invoiceId: string, amount: string) =>
    operate(
      'customer_payment_post',
      await fixture.create(
        'customer_payment',
        {
          state: `${ns}:option.customer_payment_state_draft`,
          payment_date: new Date().toISOString(),
          amount,
          method: `${ns}:option.customer_payment_method_cash`,
          reference: null,
        },
        { invoice: invoiceId },
      ),
    );
  const state = async (orderId: string) =>
    String(
      (await read('sales_order', orderId)).values[
        `${ns}:derived_state_field.machine.sales_order_lifecycle`
      ],
    ).split(':state.')[1];
  return {
    setCredit,
    draft,
    confirm,
    orderCredit,
    customerCredit,
    ship,
    invoice,
    pay,
    state,
  };
}

test(
  'credit control: a customer on hold or over its limit has no order confirmed; payments free headroom; both pages state the figures',
  { timeout: 480_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const kit = creditKit(fixture);

      // No limit: the customer's orders confirm as before, and both pages
      // say so.
      assert.deepEqual(await kit.customerCredit(), {
        credit_limit: null,
        open_balance: '0.00',
        on_order: '0.00',
        available_credit: null,
        credit_status: 'No limit',
      });

      // A limit of 100.00 in the customer's currency (CAD).
      await kit.setCredit({ credit_limit: '100' });
      const a = await kit.draft('4'); // 42.00
      assert.deepEqual(await kit.orderCredit(a.header.recordId), {
        credit_limit: '100.00',
        open_balance: '0.00',
        on_order: '0.00',
        available_credit: '100.00',
        credit_status: 'Within limit',
      });
      await kit.confirm(a);
      assert.equal(await kit.state(a.header.recordId), 'sales_order_released');

      // 42.00 confirmed and not invoiced, plus 63.00, is over by 5.00.
      const b = await kit.draft('6'); // 63.00
      await assert.rejects(
        kit.confirm(b),
        refusedWith('CREDIT_LIMIT_EXCEEDED', /by 5\.00 CAD/u),
      );
      assert.equal(await kit.state(b.header.recordId), 'sales_order_draft');
      assert.deepEqual(await kit.orderCredit(b.header.recordId), {
        credit_limit: '100.00',
        open_balance: '0.00',
        on_order: '42.00',
        available_credit: '58.00',
        credit_status: 'Within limit',
      });

      // Shipping and invoicing half of A moves 21.00 from on order to the
      // open balance; paying it frees the headroom B needs.
      await kit.ship(a, '2');
      const invoiceA = await kit.invoice(a.header.recordId);
      assert.deepEqual(await kit.customerCredit(), {
        credit_limit: '100.00',
        open_balance: '21.00',
        on_order: '21.00',
        available_credit: '58.00',
        credit_status: 'Within limit',
      });
      await assert.rejects(
        kit.confirm(b),
        refusedWith('CREDIT_LIMIT_EXCEEDED', /by 5\.00 CAD/u),
      );
      await kit.pay(invoiceA.recordId, '21');
      await kit.confirm(b);
      assert.deepEqual(await kit.orderCredit(b.header.recordId), {
        credit_limit: '100.00',
        open_balance: '0.00',
        on_order: '84.00',
        available_credit: '16.00',
        credit_status: 'Within limit',
      });

      // A hold refuses any confirmation, whatever the headroom; releasing
      // it lets the order through.
      await kit.setCredit({ credit_hold: true });
      const c = await kit.draft('1'); // 10.50
      await assert.rejects(kit.confirm(c), refusedWith('CREDIT_HOLD'));
      assert.equal(
        (await kit.orderCredit(c.header.recordId)).credit_status,
        'On hold',
      );
      await kit.setCredit({ credit_hold: false });
      await kit.confirm(c);

      // The limit is in CAD; nothing is converted, so a USD order is refused
      // by name rather than compared.
      const usd = await kit.draft('1', 'USD');
      await assert.rejects(
        kit.confirm(usd),
        refusedWith('CREDIT_CURRENCY_MISMATCH', /in CAD/u),
      );
      assert.equal(
        (await kit.orderCredit(usd.header.recordId)).credit_status,
        'Limit in another currency',
      );

      // An order whose total cannot be stated is not checked as zero.
      const unpriced = await kit.draft('1', 'CAD', '');
      await assert.rejects(
        kit.confirm(unpriced),
        refusedWith('CREDIT_EXPOSURE_UNSTATED'),
      );

      // Two orders that fit alone but not together: confirmed at once,
      // exactly one is (the customer's lock serializes them). Headroom is
      // 100 - (21 + 63 + 10.50) = 5.50.
      const one = await kit.draft('0.5'); // 5.25
      const two = await kit.draft('0.5'); // 5.25
      const outcomes = await Promise.allSettled([
        kit.confirm(one),
        kit.confirm(two),
      ]);
      assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [
        'fulfilled',
        'rejected',
      ]);
      const rejected = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === 'rejected',
      )!;
      assert.ok(refusedWith('CREDIT_LIMIT_EXCEEDED')(rejected.reason));

      // A limit of zero sets none.
      await kit.setCredit({ credit_limit: '0' });
      await kit.confirm(await kit.draft('50'));
      assert.equal((await kit.customerCredit()).credit_status, 'No limit');
    });
  },
);
