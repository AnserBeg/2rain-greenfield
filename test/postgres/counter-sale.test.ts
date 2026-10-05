import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

// SALES-EXTRAS counter sales against the composed application on PostgreSQL:
// one Task on a draft order confirms it, reserves and ships every line in
// full from the chosen location -- the shipment posts through the fulfillment
// route, so stock moves exactly as for any shipment -- invoices it and, when
// paid at the counter, records the payment of the whole balance. On account
// leaves the balance open; a customer on credit hold stops at Confirm with
// nothing reserved, shipped or invoiced. Driven over HTTP, as a browser
// without script drives a Task.

const ns = 'northstar.app';
type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

const shipTo = {
  ship_to_name: 'Picked up at the counter',
  ship_to_street: '100 Industrial Way',
  ship_to_city: 'Calgary',
  ship_to_region: 'AB',
  ship_to_postal_code: 'T2P 0A1',
  ship_to_country: 'Canada',
};

function orderPage(fixture: Fixture, recordId: string): string {
  const target = new URL(fixture.app.baseUrl);
  target.searchParams.set('surface', `${ns}:surface.sales_order_detail`);
  target.searchParams.set(
    `${ns}:parameter.commercial_order_get_legal_entity_scope`,
    fixture.scope,
  );
  target.searchParams.set('record', recordId);
  return target.href;
}
/** A form submission, as a browser without script posts it. */
async function post(target: string, form: Record<string, string>) {
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
  });
  return { status: response.status, html: await response.text() };
}
function hidden(html: string, name: string): string {
  const value = new RegExp(`name="${name}" value="([^"]+)"`, 'u').exec(
    html,
  )?.[1];
  assert.ok(value, `no ${name}`);
  return value;
}
/** A Task driven to its result: started, reviewed, confirmed. */
async function runTask(
  target: string,
  action: string,
  inputs: Record<string, string>,
) {
  const started = await post(target, { compositionAction: action });
  assert.equal(started.status, 200, started.html.slice(0, 2000));
  const token = hidden(started.html, 'taskToken');
  const review = await post(target, {
    taskToken: token,
    compositionAction: action,
    taskStage: 'prepare',
    ...inputs,
  });
  assert.match(review.html, /name="preparedId"/u, review.html.slice(-4000));
  const done = await post(target, {
    taskToken: token,
    compositionAction: action,
    taskStage: 'confirm',
    preparedId: hidden(review.html, 'preparedId'),
  });
  return { started, review, done };
}

/** Exact decimals as units of 10^-18, the scale every amount column has. */
function units(value: unknown): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(String(value));
  assert.ok(match, `not an exact decimal: ${String(value)}`);
  const magnitude = BigInt(`${match[2]!}${(match[3] ?? '').padEnd(18, '0')}`);
  return match[1] ? -magnitude : magnitude;
}

/**
 * Stored rows of one entity in the fixture's company, read directly and
 * never through the read models under test. A column is a field of the
 * entity, `relation.<id>`, or `state` for the order's lifecycle.
 */
async function stored(
  fixture: Fixture,
  local: string,
  columns: Record<string, string>,
) {
  const target = await governedStorageTarget();
  const entity = target.entities.find(
    (value) => value.entityId === `${ns}:entity.${local}`,
  )!;
  const column = (name: string) =>
    name.startsWith('relation.')
      ? target.relations.find((value) => value.relationId === `${ns}:${name}`)!
          .relationColumn.physicalName
      : name === 'lifecycle'
        ? fulfillmentColumn(
            entity,
            `derived_state_field.machine.${local}_lifecycle`,
          )
        : fulfillmentColumn(entity, `${local}_${name}`);
  const selected = Object.entries(columns)
    .map(([alias, name]) => `"${column(name)}"::text AS "${alias}"`)
    .join(', ');
  return (
    await fixture.pool.query<Record<string, string | null>>(
      `SELECT record_id::text AS record_id, ${selected}
         FROM ${fulfillmentTable(entity)}
        WHERE tenant_id = $1 AND environment_id = $2
          AND ${entity.legalEntity!.column} = $3 AND archived_at IS NULL`,
      [
        fixture.app.runtime.identity.tenantId,
        fixture.app.runtime.identity.environmentId,
        fixture.scope,
      ],
    )
  ).rows;
}

test(
  'SALES-EXTRAS counter sale: one Task confirms, ships every line from the chosen location through the fulfillment route, invoices and takes the whole balance; on account leaves it open; a held customer stops at Confirm',
  { timeout: 600_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const input = (local: string) => `${ns}:input.${local}`;
      /** A draft order of the demo item at 12.50 untaxed, one line per quantity. */
      const draft = async (quantities: readonly string[]) => {
        const order = await fixture.create('sales_order', {
          customer_party_id: fixture.customer,
          order_date: new Date().toISOString(),
          requested_date: null,
          currency: 'CAD',
          notes: null,
          ...shipTo,
        });
        const lines = [];
        for (const [index, quantity] of quantities.entries())
          lines.push(
            (
              await fixture.create(
                'sales_order_line',
                {
                  item_id: fixture.item,
                  unit_id: 'EA',
                  line_number: String(index + 1),
                  ordered_quantity: quantity,
                  unit_price: '12.5',
                },
                { order: order.recordId },
              )
            ).recordId,
          );
        return { order: order.recordId, lines };
      };
      const onHand = async () =>
        (
          await stored(fixture, 'posted_stock_balance', {
            item: 'item_id',
            location: 'location_id',
            quantity: 'posted_quantity',
          })
        )
          .filter(
            (row) =>
              row.item === fixture.item && row.location === fixture.location,
          )
          .reduce((total, row) => total + units(row.quantity), 0n);
      const orders = () =>
        stored(fixture, 'sales_order', {
          state: 'lifecycle',
          counter: 'counter_sale',
        });
      const reservations = () =>
        stored(fixture, 'reservation', {
          line: 'relation.reservation_order_line',
          location: 'location_id',
          quantity: 'quantity',
        });
      const shipments = () =>
        stored(fixture, 'shipment', {
          order: 'relation.shipment_order',
          state: 'state',
          carrier: 'carrier',
          location: 'location_id',
          recipient: 'ship_to_name',
        });
      const shipmentLines = () =>
        stored(fixture, 'shipment_line', {
          shipment: 'relation.shipment_line_shipment',
          line: 'relation.shipment_line_order_line',
          reservation: 'relation.shipment_line_reservation',
          quantity: 'quantity',
        });
      const invoices = () =>
        stored(fixture, 'customer_invoice', {
          order: 'relation.customer_invoice_order',
          state: 'state',
          total: 'total',
          balance: 'balance',
        });
      const payments = () =>
        stored(fixture, 'customer_payment', {
          invoice: 'relation.customer_payment_invoice',
          state: 'state',
          amount: 'amount',
          method: 'method',
          reference: 'reference',
        });

      // Paid by cheque: 3 and 2 at 12.50, 62.50.
      const paid = await draft(['3', '2']);
      const before = await onHand();
      const sale = await runTask(
        orderPage(fixture, paid.order),
        `${ns}:action.counter_sale_paid`,
        {
          [input('counter_location')]: fixture.location,
          [input('counter_method')]:
            `${ns}:option.customer_payment_method_cheque`,
          [input('counter_reference')]: 'CHQ-1042',
        },
      );
      // Every line of the order is a row of the sale.
      assert.equal(
        (sale.started.html.match(/data-task-row="/gu) ?? []).length,
        2,
      );
      assert.match(sale.done.html, /Counter sale: take payment: done/u);
      // The order is confirmed, and marked a counter sale.
      assert.deepEqual(
        (await orders())
          .filter((row) => row.record_id === paid.order)
          .map((row) => [row.state, row.counter]),
        [[`${ns}:state.sales_order_released`, 'true']],
      );
      // Each line reserved its own ordered quantity at the chosen location,
      // and the one posted shipment ships each line from its own reservation.
      const reserved = (await reservations()).filter((row) =>
        paid.lines.includes(row.line!),
      );
      assert.deepEqual(
        paid.lines.map((line) => {
          const own = reserved.filter((row) => row.line === line);
          return own.map((row) => [row.location, units(row.quantity)]);
        }),
        [[[fixture.location, units('3')]], [[fixture.location, units('2')]]],
      );
      const shipped = (await shipments()).filter(
        (row) => row.order === paid.order,
      );
      assert.deepEqual(
        shipped.map((row) => [
          row.state,
          row.carrier,
          row.location,
          row.recipient,
        ]),
        [
          [
            `${ns}:option.shipment_state_posted`,
            'Counter',
            fixture.location,
            shipTo.ship_to_name,
          ],
        ],
      );
      const shippedLines = (await shipmentLines()).filter(
        (row) => row.shipment === shipped[0]!.record_id,
      );
      assert.deepEqual(
        paid.lines.map((line) =>
          shippedLines
            .filter((row) => row.line === line)
            .map((row) => [row.reservation, units(row.quantity)]),
        ),
        paid.lines.map((line, index) => [
          [
            reserved.find((row) => row.line === line)!.record_id,
            units(['3', '2'][index]!),
          ],
        ]),
      );
      // The fulfillment route moved exactly the 5 sold out of that location.
      assert.equal(await onHand(), before - units('5'));
      // One invoice of the order, paid in full by the one posted payment.
      const billed = (await invoices()).filter(
        (row) => row.order === paid.order,
      );
      assert.deepEqual(
        billed.map((row) => [row.state, units(row.total), units(row.balance)]),
        [[`${ns}:option.customer_invoice_state_paid`, units('62.5'), 0n]],
      );
      assert.deepEqual(
        (await payments())
          .filter((row) => row.invoice === billed[0]!.record_id)
          .map((row) => [
            row.state,
            units(row.amount),
            row.method,
            row.reference,
          ]),
        [
          [
            `${ns}:option.customer_payment_state_posted`,
            units('62.5'),
            `${ns}:option.customer_payment_method_cheque`,
            'CHQ-1042',
          ],
        ],
      );

      // On account: the invoice posts and its balance stays open.
      const account = await draft(['1']);
      const charged = await runTask(
        orderPage(fixture, account.order),
        `${ns}:action.counter_sale_account`,
        { [input('counter_location')]: fixture.location },
      );
      assert.match(charged.done.html, /Counter sale: on account: done/u);
      const open = (await invoices()).filter(
        (row) => row.order === account.order,
      );
      assert.deepEqual(
        open.map((row) => [row.state, units(row.balance)]),
        [[`${ns}:option.customer_invoice_state_open`, units('12.5')]],
      );
      assert.deepEqual(
        (await payments()).filter((row) => row.invoice === open[0]!.record_id),
        [],
      );
      assert.equal(await onHand(), before - units('6'));

      // On credit hold: Confirm refuses by name; nothing is reserved, shipped
      // or invoiced, and the order stays a draft (marked a counter sale).
      const held = await draft(['1']);
      const hold = await fixture.invoke('party_update', {
        recordId: fixture.customer,
        expectedRevision: await partyRevision(fixture),
        patch: { [`${ns}:field.party_credit_hold`]: true },
      });
      assert.equal(hold.outcome, 'succeeded');
      const refused = await runTask(
        orderPage(fixture, held.order),
        `${ns}:action.counter_sale_paid`,
        {
          [input('counter_location')]: fixture.location,
          [input('counter_method')]:
            `${ns}:option.customer_payment_method_cash`,
          [input('counter_reference')]: '',
        },
      );
      assert.match(refused.done.html, /CREDIT_HOLD/u);
      assert.doesNotMatch(
        refused.done.html,
        /Counter sale: take payment: done/u,
      );
      assert.deepEqual(
        (await orders())
          .filter((row) => row.record_id === held.order)
          .map((row) => [row.state, row.counter]),
        [[`${ns}:state.sales_order_draft`, 'true']],
      );
      assert.equal(
        (await reservations()).filter((row) => held.lines.includes(row.line!))
          .length,
        0,
      );
      assert.equal(
        (await shipments()).filter((row) => row.order === held.order).length,
        0,
      );
      assert.equal(
        (await invoices()).filter((row) => row.order === held.order).length,
        0,
      );
      assert.equal(await onHand(), before - units('6'));

      // The Sales orders List counts the three counter orders on their tab.
      const list = new URL(fixture.app.baseUrl);
      list.searchParams.set('surface', `${ns}:surface.sales_order_list`);
      list.searchParams.set(
        `${ns}:parameter.sales_order_list_legal_entity_scope`,
        fixture.scope,
      );
      const listed = await (await fetch(list.href)).text();
      assert.equal(
        new RegExp(
          `data-view-id="${ns}:list_view\\.sales_order_list_counter"[^>]*>(?:<span>[^<]*</span>)<span class="list-view__count" data-view-count="(\\d+)"`,
          'u',
        ).exec(listed)?.[1],
        '3',
      );
    });
  },
);

/** The customer's current revision, through its governed read. */
async function partyRevision(fixture: Fixture): Promise<number> {
  const result = await fixture.app.runtime.entry.run(
    { headers: {} },
    (view) => {
      const definition = registeredSemanticQueryFromPinnedView(
        view,
        `${ns}:query.party_get`,
      )!;
      return fixture.app.runtime.queryGateway.invoke(view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: definition.queryId,
        arguments: { recordId: fixture.customer, includeArchived: false },
      });
    },
  );
  assert.equal(result.outcome, 'exact');
  return result.records[0]!.revision;
}
