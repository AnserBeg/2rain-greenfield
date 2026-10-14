import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

// ORDER-PARITY increment B against the composed application on PostgreSQL:
// the truck receipt posts one receipt of exactly the lines entered; reversing
// the latest receipt gives back exactly what it received; an order page's
// shortage equals an independent computation from the stored stock,
// reservations and lines; an invoice links to the order it bills. Pages and
// Tasks are driven over HTTP, as a browser without script drives them.

const ns = 'northstar.app';
type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

interface Scenario {
  readonly truck: { number: string; recordId: string; lines: string[] };
  readonly delivered: {
    number: string;
    recordId: string;
    lines: string[];
    receipt: { number: string; recordId: string; lines: string[] };
  };
  readonly short: { number: string; recordId: string; lines: string[] };
  readonly invoice: {
    number: string;
    recordId: string;
    order: { number: string; recordId: string };
  };
  readonly location: string;
}

function pageUrl(
  fixture: Fixture,
  surface: string,
  scopeQuery: string,
  parameters: Record<string, string>,
): string {
  const target = new URL(fixture.app.baseUrl);
  target.searchParams.set('surface', `${ns}:surface.${surface}`);
  target.searchParams.set(
    `${ns}:parameter.${scopeQuery}_legal_entity_scope`,
    fixture.scope,
  );
  for (const [name, value] of Object.entries(parameters))
    target.searchParams.set(name, value);
  return target.href;
}
async function read(target: string) {
  const response = await fetch(target, { redirect: 'manual' });
  return { status: response.status, html: await response.text() };
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

/** Exact decimals as units of 10^-18, the scale every quantity column has. */
function units(value: unknown): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(String(value));
  assert.ok(match, `not an exact decimal: ${String(value)}`);
  const magnitude = BigInt(`${match[2]!}${(match[3] ?? '').padEnd(18, '0')}`);
  return match[1] ? -magnitude : magnitude;
}
const text = (value: bigint) => {
  const scale = 10n ** 18n;
  const magnitude = value < 0n ? -value : value;
  const fraction = (magnitude % scale)
    .toString()
    .padStart(18, '0')
    .replace(/0+$/u, '');
  return `${value < 0n ? '-' : ''}${String(magnitude / scale)}${fraction ? `.${fraction}` : ''}`;
};

/** Stored rows of one entity in the fixture's company, read directly. */
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
const movements = (fixture: Fixture) =>
  stored(fixture, 'inventory_movement', {
    source_type: 'source_type',
    source_id: 'source_id',
    source_line: 'source_line',
    quantity: 'quantity_delta',
    reversal_of: 'reversal_of_movement_id',
  });
const onHand = async (fixture: Fixture, item: string) =>
  (
    await stored(fixture, 'posted_stock_balance', {
      item: 'item_id',
      quantity: 'posted_quantity',
    })
  )
    .filter((row) => row.item === item)
    .reduce((total, row) => total + units(row.quantity), 0n);
const received = async (fixture: Fixture, line: string) => {
  const [row] = (
    await stored(fixture, 'purchase_order_received', {
      line: 'relation.purchase_order_received_order_line',
      quantity: 'received_quantity',
    })
  ).filter((value) => value.line === line);
  return row ? units(row.quantity) : 0n;
};

/**
 * What each line of an order is short, computed here from the stored rows and
 * never through the read model under test (owner ruling of 2026-09-30): the
 * open quantity its own live reservations do not cover, beyond the item's
 * free stock now -- on hand at every location less every live reservation's
 * remainder -- allocated to the order's lines in line order.
 */
async function expectedShort(fixture: Fixture, orderId: string) {
  const lines = (
    await stored(fixture, 'sales_order_line', {
      order: 'relation.sales_order_line_order',
      number: 'line_number',
      item: 'item_id',
      ordered: 'ordered_quantity',
    })
  )
    .filter((row) => row.order === orderId)
    .sort((left, right) => Number(left.number) - Number(right.number));
  const shipped = await stored(fixture, 'sales_order_shipped', {
    line: 'relation.sales_order_shipped_order_line',
    quantity: 'shipped_quantity',
  });
  const reservations = await stored(fixture, 'reservation', {
    line: 'relation.reservation_order_line',
    item: 'item_id',
  });
  const balances = await stored(fixture, 'reservation_balance', {
    reservation: 'relation.reservation_balance_reservation',
    remaining: 'remaining_quantity',
  });
  const remaining = (reservationId: string) =>
    balances
      .filter((row) => row.reservation === reservationId)
      .reduce((total, row) => total + units(row.remaining), 0n);
  const left = new Map<string, bigint>();
  const result = new Map<string, bigint>();
  for (const line of lines) {
    const item = line.item!;
    if (!left.has(item)) {
      const held = reservations
        .filter((row) => row.item === item)
        .reduce((total, row) => total + remaining(row.record_id!), 0n);
      const free = (await onHand(fixture, item)) - held;
      left.set(item, free > 0n ? free : 0n);
    }
    const covered = reservations
      .filter((row) => row.line === line.record_id)
      .reduce((total, row) => total + remaining(row.record_id!), 0n);
    const done = shipped
      .filter((row) => row.line === line.record_id)
      .reduce((total, row) => total + units(row.quantity), 0n);
    let short = units(line.ordered) - done - covered;
    if (short < 0n) short = 0n;
    const allocated = short < left.get(item)! ? short : left.get(item)!;
    left.set(item, left.get(item)! - allocated);
    result.set(line.record_id!, short - allocated);
  }
  return result;
}
/** A presented dataset row's cell, by its dataset and column label. */
function cell(html: string, local: string, recordId: string, label: string) {
  const section =
    new RegExp(
      `<section id="${ns}:dataset\\.${local}"[\\s\\S]*?</section>`,
      'u',
    ).exec(html)?.[0] ?? '';
  const row =
    new RegExp(
      `<tr data-compact-card="true" data-presented-row="true" data-record-id="${recordId}"[^>]*>([\\s\\S]*?)</tr>`,
      'u',
    ).exec(section)?.[1] ?? '';
  return new RegExp(
    `<td data-column-label="${label}"[^>]*>([^<]*)</td>`,
    'u',
  ).exec(row)?.[1];
}

test(
  'ORDER-PARITY: a truck receipt posts exactly the lines entered, a reversal gives back exactly what the latest receipt received, a shortage equals its stored truth, and an invoice opens its order',
  { timeout: 600_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const scenario = (await fixture.measure(
        'order_pages',
      )) as unknown as Scenario;
      const item = fixture.item;
      const input = (local: string) => `${ns}:input.${local}`;

      // The truck: 5 of line 1 and 3 of line 3 arrive; line 2 is left empty.
      const truckPage = pageUrl(
        fixture,
        'purchase_order_detail',
        'commercial_purchase_order_get',
        { record: scenario.truck.recordId },
      );
      const [first, second, third] = scenario.truck.lines as [
        string,
        string,
        string,
      ];
      const stockBefore = await onHand(fixture, item);
      const truck = await runTask(
        truckPage,
        `${ns}:action.receive_lines_known`,
        {
          [input('receive_lines_location')]: scenario.location,
          [input('receive_lines_currency')]: 'CAD',
          [input('receive_lines_packing_slip')]: 'PS-TRUCK',
          [input('receive_lines_notes')]: '',
          [`${input('receive_lines_quantity')}@${first}`]: '5',
          [`${input('receive_lines_cost')}@${first}`]: '2.40',
          [`${input('receive_lines_quantity')}@${third}`]: '3',
          [`${input('receive_lines_cost')}@${third}`]: '2.5',
        },
      );
      // Rows start empty, one per line with something still to arrive.
      assert.equal(
        (truck.started.html.match(/data-task-row="/gu) ?? []).length,
        3,
      );
      assert.match(truck.done.html, /Receive lines with actual cost: done/u);
      // One receipt of this order, posted, with exactly the two lines entered.
      const receipts = (
        await stored(fixture, 'goods_receipt', {
          order: 'relation.goods_receipt_order',
          state: 'state',
          kind: 'kind',
          number: 'number',
          packing_slip: 'packing_slip',
          location: 'location_id',
        })
      ).filter((row) => row.order === scenario.truck.recordId);
      assert.equal(receipts.length, 1);
      const [receipt] = receipts;
      assert.deepEqual(
        [
          receipt!.state,
          receipt!.kind,
          receipt!.packing_slip,
          receipt!.location,
        ],
        [
          `${ns}:option.goods_receipt_state_posted`,
          `${ns}:option.goods_receipt_kind_initial`,
          'PS-TRUCK',
          scenario.location,
        ],
      );
      assert.match(receipt!.number!, /^RCV-\d{6}$/u);
      const lines = (
        await stored(fixture, 'goods_receipt_line', {
          receipt: 'relation.goods_receipt_line_receipt',
          order_line: 'relation.goods_receipt_line_order_line',
          quantity: 'quantity',
          unit_cost: 'unit_cost',
          number: 'line_number',
        })
      )
        .filter((row) => row.receipt === receipt!.record_id)
        .sort((left, right) => Number(left.number) - Number(right.number));
      assert.deepEqual(
        lines.map((row) => [
          row.order_line,
          text(units(row.quantity)),
          text(units(row.unit_cost)),
          row.number,
        ]),
        [
          [first, '5', '2.4', '1'],
          [third, '3', '2.5', '3'],
        ],
      );
      // One movement per line, each exactly its quantity; nothing on line 2.
      const truckMovements = (await movements(fixture)).filter(
        (row) => row.source_id === receipt!.record_id,
      );
      assert.deepEqual(
        truckMovements
          .map((row) => [row.source_line, text(units(row.quantity))])
          .sort(),
        lines.map((row) => [row.record_id, text(units(row.quantity))]).sort(),
      );
      assert.equal(await received(fixture, first), units('5'));
      assert.equal(await received(fixture, second), 0n);
      assert.equal(await received(fixture, third), units('3'));
      assert.equal(await onHand(fixture, item), stockBefore + units('8'));

      // The order short of stock: each line's Short is the stored truth, and
      // the banner names exactly the lines that are short.
      const salesPage = pageUrl(
        fixture,
        'sales_order_detail',
        'commercial_order_get',
        { record: scenario.short.recordId },
      );
      const assertShortage = async () => {
        const truth = await expectedShort(fixture, scenario.short.recordId);
        const page = await read(salesPage);
        assert.equal(page.status, 200);
        for (const line of scenario.short.lines)
          assert.equal(
            cell(page.html, 'fulfillment_lines', line, 'Short'),
            text(truth.get(line)!),
            line,
          );
        const banner =
          /<section class="composition-alert"[^>]*>([\s\S]*?)<\/section>/u.exec(
            page.html,
          )?.[1] ?? '';
        assert.deepEqual(
          [...banner.matchAll(/<li data-record-id="([^"]+)">/gu)].map(
            (match) => match[1],
          ),
          scenario.short.lines.filter((line) => truth.get(line)! > 0n),
        );
        return truth;
      };
      const shortBefore = await assertShortage();
      assert.ok([...shortBefore.values()].some((value) => value > 0n));

      // Reversing the delivered order's latest receipt: every line of it,
      // each at exactly what it received, compensating its own movement.
      const delivered = scenario.delivered;
      const receiptsDataset = `${ns}:dataset.purchasing_receipts`;
      const reversalPage = pageUrl(
        fixture,
        'purchase_order_detail',
        'commercial_purchase_order_get',
        {
          record: delivered.recordId,
          dataset: receiptsDataset,
          selected: delivered.receipt.recordId,
          [`select:${receiptsDataset}`]: delivered.receipt.recordId,
        },
      );
      const original = (await movements(fixture)).filter(
        (row) => row.source_id === delivered.receipt.recordId,
      );
      assert.equal(original.length, 2);
      const opened = await read(reversalPage);
      for (const line of delivered.receipt.lines) {
        const movement = original.find((row) => row.source_line === line)!;
        assert.equal(
          cell(opened.html, 'purchasing_receipt_lines', line, 'Reversible'),
          text(units(movement.quantity)),
        );
      }
      const stockBeforeReversal = await onHand(fixture, item);
      const reversal = await runTask(
        reversalPage,
        `${ns}:action.reverse_receipt`,
        { [input('reverse_receipt_reason')]: 'Delivered to the wrong dock' },
      );
      assert.match(reversal.done.html, /Reverse receipt: done/u);
      const reversals = (
        await stored(fixture, 'goods_receipt', {
          order: 'relation.goods_receipt_order',
          supersedes: 'relation.goods_receipt_supersedes',
          state: 'state',
          kind: 'kind',
        })
      ).filter((row) => row.supersedes === delivered.receipt.recordId);
      assert.equal(reversals.length, 1);
      assert.deepEqual(
        [reversals[0]!.kind, reversals[0]!.state, reversals[0]!.order],
        [
          `${ns}:option.goods_receipt_kind_reversal`,
          `${ns}:option.goods_receipt_state_posted`,
          delivered.recordId,
        ],
      );
      // Each compensating movement names its original, at exactly minus it.
      const compensating = (await movements(fixture)).filter(
        (row) => row.source_id === reversals[0]!.record_id,
      );
      assert.deepEqual(
        compensating
          .map((row) => [row.reversal_of, text(units(row.quantity))])
          .sort(),
        original
          .map((row) => [row.record_id, text(-units(row.quantity))])
          .sort(),
      );
      for (const line of delivered.lines)
        assert.equal(await received(fixture, line), 0n);
      assert.equal(
        await onHand(fixture, item),
        stockBeforeReversal - units('7'),
      );
      // Nothing is left to reverse, so nothing is offered.
      const after = await read(reversalPage);
      for (const line of delivered.receipt.lines)
        assert.equal(
          cell(after.html, 'purchasing_receipt_lines', line, 'Reversible'),
          '0',
        );
      assert.doesNotMatch(
        after.html,
        new RegExp(`value="${ns}:action\\.reverse_receipt"`, 'u'),
      );
      // Less stock now: the order is shorter, and still matches its truth.
      const shortAfter = await assertShortage();
      assert.ok(
        [...shortAfter.values()].reduce((total, value) => total + value, 0n) >
          [...shortBefore.values()].reduce((total, value) => total + value, 0n),
      );

      // The invoice names the order it bills and opens it; without order
      // read, the invoice still serves and the fact reads "—".
      const invoicePage = pageUrl(
        fixture,
        'customer_invoice_detail',
        'customer_invoice_get',
        { record: scenario.invoice.recordId },
      );
      const fact = (html: string) =>
        /<div><dt>Sales order<\/dt><dd>([^<]*)<\/dd><\/div>/u.exec(html)?.[1];
      const invoice = await read(invoicePage);
      assert.equal(invoice.status, 200);
      assert.equal(fact(invoice.html), scenario.invoice.order.number);
      const href =
        /<a class="button" href="([^"]+)">Open sales order<\/a>/u
          .exec(invoice.html)?.[1]
          ?.replaceAll('&amp;', '&') ?? '';
      const order = await read(new URL(href, fixture.app.baseUrl).href);
      assert.equal(order.status, 200);
      assert.match(
        order.html,
        new RegExp(`<h1>${scenario.invoice.order.number}</h1>`, 'u'),
      );
      await fixture.measure('deny', undefined, undefined, 'sales_order_read');
      try {
        const withheld = await read(invoicePage);
        assert.equal(withheld.status, 200);
        assert.equal(fact(withheld.html), '—');
        assert.match(withheld.html, new RegExp(scenario.invoice.number, 'u'));
      } finally {
        await fixture.measure(
          'allow',
          undefined,
          undefined,
          'sales_order_read',
        );
      }
      assert.equal(
        fact((await read(invoicePage)).html),
        scenario.invoice.order.number,
      );
    });
  },
);
