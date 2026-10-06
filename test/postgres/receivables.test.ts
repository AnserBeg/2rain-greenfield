import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  formatCents,
  parseExact,
  toCents,
} from '../../packages/postgres-provider/src/commercial-amounts.js';
import {
  fulfillmentBinding,
  fulfillmentColumn,
  fulfillmentTable,
  quoteFulfillmentIdentifier as q,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { InventoryPostingError } from '../../packages/postgres-provider/src/inventory-posting-error.js';
import { RECEIVABLES_SETTLEMENT_SPEC } from '../../packages/postgres-provider/src/receivables-capability-executor.js';
import {
  progressByOrderLine,
  settlementBinding,
} from '../../packages/postgres-provider/src/settlement-capability-executor.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticRecordDto,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
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

/** A stored exact decimal as money: `22.500000000000000000` -> `22.50`. */
function money(value: ImmutableJsonValue | undefined): string | null {
  const parsed = parseExact(value);
  return parsed ? formatCents(toCents(parsed.units, parsed.scale)) : null;
}

function refusedWith(code: string) {
  return (error: unknown) =>
    error instanceof InventoryPostingError && error.code === code;
}

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

/** The receivables documents and the order flow they settle, over one fixture. */
function receivablesKit(fixture: Fixture) {
  const now = new Date().toISOString();
  const value = (record: SemanticRecordDto, local: string, name: string) =>
    record.values[`${ns}:field.${local}_${name}`];
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
  const order = async (
    lines: readonly { quantity: string; price: string }[],
  ) => {
    const header = await fixture.create('sales_order', {
      customer_party_id: fixture.customer,
      order_date: now,
      requested_date: null,
      currency: 'CAD',
      notes: null,
      payment_terms: `${ns}:option.sales_order_payment_terms_net_30`,
      // Freight taxed at its frozen 5%; an untaxed other fee.
      freight_amount: '25',
      freight_tax_code_id: fixture.taxCode,
      freight_tax_rate_percent: '5',
      other_fee_amount: '10',
      other_fee_tax_code_id: null,
      other_fee_tax_rate_percent: null,
      ...shipTo,
    });
    const created = [];
    for (const [index, line] of lines.entries())
      created.push(
        await fixture.create(
          'sales_order_line',
          {
            item_id: fixture.item,
            unit_id: 'EA',
            line_number: String(index + 1),
            ordered_quantity: line.quantity,
            unit_price: line.price,
            list_price: line.price,
            discount_percent: '10',
            tax_code_id: fixture.taxCode,
            tax_rate_percent: '5',
          },
          { order: header.recordId },
        ),
      );
    const released = await operate('sales_order_release', header);
    return { header: released, lines: created };
  };
  const reserve = async (orderLineId: string, quantity: string) => {
    const draft = await fixture.create(
      'reservation',
      {
        number: randomUUID(),
        state: `${ns}:option.reservation_state_draft`,
        item_id: fixture.item,
        location_id: fixture.location,
        quantity,
        unit_id: 'EA',
        reason: 'Receivables proof',
      },
      { order_line: orderLineId },
    );
    return operate('reservation_reserve', draft);
  };
  const ship = async (
    orderId: string,
    orderLineId: string,
    reservationId: string,
    quantity: string,
  ) => {
    const header = await fixture.create(
      'shipment',
      {
        state: `${ns}:option.shipment_state_draft`,
        kind: `${ns}:option.shipment_kind_initial`,
        effective_at: new Date().toISOString(),
        location_id: fixture.location,
        external_reference: null,
        reason_code: 'SHIP',
        reason_narrative: 'Receivables proof',
        carrier: 'Purolator',
        shipping_reference_kind: `${ns}:option.shipment_shipping_reference_kind_tracking`,
        shipping_reference: randomUUID(),
        ...shipTo,
      },
      { order: orderId },
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
        shipment: header.recordId,
        order_line: orderLineId,
        reservation: reservationId,
      },
    );
    return operate('shipment_post', header);
  };
  const draftInvoice = (orderId: string) =>
    fixture.create(
      'customer_invoice',
      {
        state: `${ns}:option.customer_invoice_state_draft`,
        invoice_date: new Date().toISOString(),
      },
      { order: orderId },
    );
  const invoice = async (orderId: string) =>
    operate('customer_invoice_post', await draftInvoice(orderId));
  const settle = async (
    kind: 'payment' | 'credit',
    invoiceId: string,
    amount: string,
  ) =>
    fixture.invoke(
      `customer_${kind}_post`,
      await (async () => {
        const draft = await fixture.create(
          `customer_${kind}`,
          kind === 'payment'
            ? {
                state: `${ns}:option.customer_payment_state_draft`,
                payment_date: new Date().toISOString(),
                amount,
                method: `${ns}:option.customer_payment_method_eft`,
                reference: `EFT-${randomUUID().slice(0, 8)}`,
              }
            : {
                state: `${ns}:option.customer_credit_state_draft`,
                credit_date: new Date().toISOString(),
                amount,
                reason: 'Damaged in transit',
              },
          { invoice: invoiceId },
        );
        return {
          recordId: draft.recordId,
          expectedRevision: draft.revision,
        };
      })(),
    );
  const reread = async (local: string, recordId: string) => {
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
            [definition.legalEntityScope!.operand.parameterId]: fixture.scope,
          },
        });
      },
    );
    return result.records[0]!;
  };
  // What the order offers to invoice (the commercial read model).
  const toInvoice = async (orderId: string) =>
    (await reread('commercial_order', orderId)).values[
      `${ns}:metric.order_to_invoice`
    ];
  const figures = (record: SemanticRecordDto) =>
    Object.fromEntries(
      [
        'subtotal',
        'charges',
        'tax',
        'total',
        'paid_amount',
        'credited_amount',
        'balance',
      ].map((name) => [name, money(value(record, 'customer_invoice', name))]),
    );
  const state = (record: SemanticRecordDto, local: string) =>
    String(value(record, local, 'state')).split(`${local}_state_`)[1];
  return {
    now,
    value,
    operate,
    order,
    reserve,
    ship,
    draftInvoice,
    invoice,
    settle,
    reread,
    toInvoice,
    figures,
    state,
  };
}

test(
  'ruling C: invoices take shipped, not yet invoiced quantities at frozen figures; payments and credits never exceed the balance; void only while unsettled; an invoiced order is not reopened',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const {
        value,
        operate,
        order,
        reserve,
        ship,
        invoice,
        settle,
        reread,
        toInvoice,
        figures,
        state,
      } = receivablesKit(fixture);

      const a = await order([{ quantity: '3', price: '12.5' }]);
      const [lineA] = a.lines;

      // Nothing is shipped yet, so there is nothing to invoice.
      await assert.rejects(
        invoice(a.header.recordId),
        refusedWith('RECEIVABLES_NOTHING_TO_INVOICE'),
      );
      assert.equal(await toInvoice(a.header.recordId), '0');
      const reservation = await reserve(lineA!.recordId, '3');
      await ship(a.header.recordId, lineA!.recordId, reservation.recordId, '2');
      assert.equal(await toInvoice(a.header.recordId), '2');

      // 2 × 12.50 less 10% = 22.50, tax 1.125 → 1.13; the order's charges go
      // on its first invoice: freight 25 (+1.25 tax) and an untaxed fee of 10.
      const first = await invoice(a.header.recordId);
      assert.match(
        String(value(first, 'customer_invoice', 'number')),
        /^INV-\d{6}$/u,
      );
      assert.equal(state(first, 'customer_invoice'), 'open');
      assert.deepEqual(figures(first), {
        subtotal: '22.50',
        charges: '35.00',
        tax: '2.38',
        total: '59.88',
        paid_amount: '0.00',
        credited_amount: '0.00',
        balance: '59.88',
      });
      assert.equal(value(first, 'customer_invoice', 'currency'), 'CAD');
      assert.equal(
        value(first, 'customer_invoice', 'customer_party_id'),
        fixture.customer,
      );
      // Net 30 from the order: due thirty days after the invoice date.
      assert.equal(
        Date.parse(String(value(first, 'customer_invoice', 'due_date'))) -
          Date.parse(String(value(first, 'customer_invoice', 'invoice_date'))),
        30 * 86_400_000,
      );

      assert.equal(await toInvoice(a.header.recordId), '0');
      // The same shipped quantity is never invoiced twice.
      await assert.rejects(
        invoice(a.header.recordId),
        refusedWith('RECEIVABLES_NOTHING_TO_INVOICE'),
      );
      // A later shipment is invoiced on its own, without the charges again:
      // 1 × 12.50 less 10% = 11.25, tax 0.5625 → 0.56.
      await ship(a.header.recordId, lineA!.recordId, reservation.recordId, '1');
      const second = await invoice(a.header.recordId);
      assert.deepEqual(figures(second), {
        subtotal: '11.25',
        charges: '0.00',
        tax: '0.56',
        total: '11.81',
        paid_amount: '0.00',
        credited_amount: '0.00',
        balance: '11.81',
      });

      // A payment may not exceed the balance, nor be a fraction of a cent.
      await assert.rejects(
        settle('payment', first.recordId, '60'),
        refusedWith('RECEIVABLES_AMOUNT_EXCEEDS_BALANCE'),
      );
      await assert.rejects(
        settle('payment', first.recordId, '0.001'),
        refusedWith('RECEIVABLES_AMOUNT_INVALID'),
      );
      const paid = await settle('payment', first.recordId, '20');
      assert.equal(paid.outcome, 'succeeded');
      assert.match(
        String(value(paid.readBack!, 'customer_payment', 'number')),
        /^PAY-\d{6}$/u,
      );
      assert.equal(state(paid.readBack!, 'customer_payment'), 'posted');
      let current = await reread('customer_invoice', first.recordId);
      assert.equal(state(current, 'customer_invoice'), 'partially_paid');
      assert.equal(figures(current).balance, '39.88');

      // A credit reduces the same balance.
      const credited = await settle('credit', first.recordId, '9.88');
      assert.match(
        String(value(credited.readBack!, 'customer_credit', 'number')),
        /^CM-\d{6}$/u,
      );
      current = await reread('customer_invoice', first.recordId);
      assert.deepEqual(
        [figures(current).credited_amount, figures(current).balance],
        ['9.88', '30.00'],
      );

      // Two payments racing for one balance: the invoice row serializes
      // them, so exactly one posts and the other is refused.
      const race = await Promise.allSettled([
        settle('payment', first.recordId, '20'),
        settle('payment', first.recordId, '20'),
      ]);
      assert.equal(
        race.filter((outcome) => outcome.status === 'fulfilled').length,
        1,
      );
      assert.ok(
        race.some(
          (outcome) =>
            outcome.status === 'rejected' &&
            refusedWith('RECEIVABLES_AMOUNT_EXCEEDS_BALANCE')(outcome.reason),
        ),
      );
      current = await reread('customer_invoice', first.recordId);
      assert.deepEqual(
        [figures(current).paid_amount, figures(current).balance],
        ['40.00', '10.00'],
      );
      await settle('payment', first.recordId, '10');
      current = await reread('customer_invoice', first.recordId);
      assert.equal(state(current, 'customer_invoice'), 'paid');
      assert.equal(figures(current).balance, '0.00');
      await assert.rejects(
        settle('payment', first.recordId, '1'),
        refusedWith('RECEIVABLES_INVOICE_STATE_CONFLICT'),
      );

      // Void only while nothing is settled: a paid invoice stays; an open
      // one is voided and its quantity can be invoiced again.
      await assert.rejects(
        operate('customer_invoice_void', current),
        refusedWith('RECEIVABLES_INVOICE_SETTLED'),
      );
      const voided = await operate('customer_invoice_void', second);
      assert.equal(state(voided, 'customer_invoice'), 'void');
      assert.equal(figures(voided).balance, '0.00');
      assert.equal(await toInvoice(a.header.recordId), '1');
      const reinvoiced = await invoice(a.header.recordId);
      assert.deepEqual(
        [figures(reinvoiced).subtotal, figures(reinvoiced).total],
        ['11.25', '11.81'],
      );

      // A generic write cannot change a posted invoice or its lines.
      await assert.rejects(
        fixture.invoke('customer_invoice_update', {
          recordId: reinvoiced.recordId,
          expectedRevision: reinvoiced.revision,
          patch: { [`${ns}:field.customer_invoice_total`]: '0' },
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code ===
          'MODULE_OPERATION_PRECONDITION_REFUSED',
      );

      // Ruling F: a closed order reopens only while no invoice counts.
      const b = await order([{ quantity: '1', price: '5' }]);
      const reservationB = await reserve(b.lines[0]!.recordId, '1');
      await ship(
        b.header.recordId,
        b.lines[0]!.recordId,
        reservationB.recordId,
        '1',
      );
      const closed = await operate(
        'sales_order_close',
        await reread('sales_order', b.header.recordId),
      );
      const reopened = await operate('sales_order_reopen', closed);
      assert.match(
        String(
          reopened.values[
            `${ns}:derived_state_field.machine.sales_order_lifecycle`
          ],
        ),
        /:state\.sales_order_released$/u,
      );
      const invoicedB = await invoice(b.header.recordId);
      const closedAgain = await operate(
        'sales_order_close',
        await reread('sales_order', b.header.recordId),
      );
      await assert.rejects(
        operate('sales_order_reopen', closedAgain),
        refusedWith('RECEIVABLES_ORDER_NOT_REOPENABLE'),
      );
      await operate('customer_invoice_void', invoicedB);
      await operate(
        'sales_order_reopen',
        await reread('sales_order', b.header.recordId),
      );
    });
  },
);

test(
  "the offer and the post settle each line on its own: a correction on one line hides no other line's uninvoiced quantity, and posting reads only its order's shipped rows",
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const { operate, order, reserve, ship, invoice, toInvoice, figures } =
        receivablesKit(fixture);
      // Another order of the same company ships first, so the company holds
      // shipped rows that are not the order under test's.
      const other = await order([{ quantity: '1', price: '3' }]);
      const otherReservation = await reserve(other.lines[0]!.recordId, '1');
      await ship(
        other.header.recordId,
        other.lines[0]!.recordId,
        otherReservation.recordId,
        '1',
      );

      const c = await order([
        { quantity: '2', price: '10' },
        { quantity: '2', price: '4' },
      ]);
      const [first, second] = c.lines;
      const firstReservation = await reserve(first!.recordId, '2');
      const secondReservation = await reserve(second!.recordId, '2');
      const shippedFirst = await ship(
        c.header.recordId,
        first!.recordId,
        firstReservation.recordId,
        '2',
      );
      await ship(
        c.header.recordId,
        second!.recordId,
        secondReservation.recordId,
        '1',
      );
      // Invoiced: the first line's 2 and the second line's 1.
      await invoice(c.header.recordId);
      assert.equal(await toInvoice(c.header.recordId), '0');

      // A correction takes one unit back from the first line's shipment, so
      // that line is now invoiced above what shipped (2 over 1).
      const target = await governedStorageTarget();
      const binding = fulfillmentBinding(target)!;
      const movement = await fixture.pool.query<{ record_id: string }>(
        `SELECT record_id::text FROM ${fulfillmentTable(binding.movement)}
          WHERE tenant_id=$1 AND environment_id=$2
            AND ${q(binding.movement.legalEntity!.column)}=$3
            AND ${q(fulfillmentColumn(binding.movement, 'inventory_movement_source_type'))}='shipment'
            AND ${q(fulfillmentColumn(binding.movement, 'inventory_movement_source_id'))}=$4`,
        [
          fixture.app.runtime.identity.tenantId,
          fixture.app.runtime.identity.environmentId,
          fixture.scope,
          shippedFirst.recordId,
        ],
      );
      assert.equal(movement.rows.length, 1);
      const correction = await fixture.create(
        'shipment',
        {
          state: `${ns}:option.shipment_state_draft`,
          kind: `${ns}:option.shipment_kind_correction`,
          effective_at: new Date().toISOString(),
          location_id: fixture.location,
          external_reference: null,
          reason_code: 'CORRECT',
          reason_narrative: 'One unit was not shipped',
          carrier: null,
          shipping_reference_kind: null,
          shipping_reference: null,
          ...shipTo,
        },
        { order: c.header.recordId, supersedes: shippedFirst.recordId },
      );
      await fixture.create(
        'shipment_line',
        {
          line_number: '1',
          item_id: fixture.item,
          quantity: '1',
          unit_id: 'EA',
          reversal_of_movement_id: movement.rows[0]!.record_id,
        },
        {
          shipment: correction.recordId,
          order_line: first!.recordId,
          reservation: firstReservation.recordId,
        },
      );
      await operate('shipment_post', correction);
      // The second line ships its last unit, not yet invoiced. Across the
      // order shipped (1 + 2) equals invoiced (2 + 1), so a netted offer read
      // zero; per line, the second line still has 1 to invoice.
      await ship(
        c.header.recordId,
        second!.recordId,
        secondReservation.recordId,
        '1',
      );
      assert.equal(await toInvoice(c.header.recordId), '1');

      // Posting reads this order's shipped rows and no other's: the progress
      // read returns exactly its two lines, although the company holds the
      // other order's shipped row too.
      const client = await fixture.pool.connect();
      try {
        const progressed = await progressByOrderLine(
          client,
          RECEIVABLES_SETTLEMENT_SPEC,
          settlementBinding(RECEIVABLES_SETTLEMENT_SPEC, target),
          {
            tenantId: fixture.app.runtime.identity.tenantId,
            environmentId: fixture.app.runtime.identity.environmentId,
            legalEntityId: fixture.scope,
          },
          [first!.recordId, second!.recordId],
        );
        assert.deepEqual(
          [...progressed.entries()]
            .map(([line, { quantity }]) => [line, quantity])
            .sort(([left], [right]) =>
              String(left).localeCompare(String(right)),
            ),
          [
            [first!.recordId, 10n ** 18n],
            [second!.recordId, 2n * 10n ** 18n],
          ].sort(([left], [right]) =>
            String(left).localeCompare(String(right)),
          ),
        );
        const companyShipped = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${fulfillmentTable(binding.shipped)}
            WHERE tenant_id=$1 AND environment_id=$2
              AND ${q(binding.shipped.legalEntity!.column)}=$3`,
          [
            fixture.app.runtime.identity.tenantId,
            fixture.app.runtime.identity.environmentId,
            fixture.scope,
          ],
        );
        assert.ok(Number(companyShipped.rows[0]!.count) > 2);
      } finally {
        client.release();
      }

      // The post takes the second line's unit alone, without the charges the
      // first invoice carried: 1 × 4 less 10% = 3.60, tax 0.18.
      const corrected = await invoice(c.header.recordId);
      assert.deepEqual(figures(corrected), {
        subtotal: '3.60',
        charges: '0.00',
        tax: '0.18',
        total: '3.78',
        paid_amount: '0.00',
        credited_amount: '0.00',
        balance: '3.78',
      });
      assert.equal(await toInvoice(c.header.recordId), '0');
    });
  },
);
