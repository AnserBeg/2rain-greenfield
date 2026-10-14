import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

// SUPPLY-WARNINGS against the composed application on PostgreSQL: the Sales
// orders List's Blocked by supply and Reserved tabs, each order's Short and
// "Post shipment" are stated by the list statement before the count, the page
// and the export, and equal an independent computation over the stored rows
// -- two lines of one order sharing the free stock, stock reserved for
// another order, stock and a reservation in a quarantined location -- and the
// order page's own Short, line by line (owner ruling R1: one formula). A
// principal without stock read keeps the List without the supply.

const ns = 'northstar.app';
const WITHHELD = '<span class="muted">—</span>';
const SHORT_MARK =
  ' <span class="status-pill" data-status-role="blocked" data-short-mark="true"><span aria-hidden="true">!</span><span class="sr-only">Short of stock</span></span>';

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

interface Seeded {
  readonly number: string;
  readonly recordId: string;
  readonly lines: readonly string[];
}
interface Scenario {
  readonly orders: {
    readonly elsewhere: Seeded;
    readonly held: Seeded;
    readonly part: Seeded;
    readonly short: Seeded;
    readonly fine: Seeded;
    readonly draft: Seeded;
  };
}

const view = (local: string) => `${ns}:list_view.sales_order_list_${local}`;

function salesUrl(
  fixture: Fixture,
  parameters: Record<string, string> = {},
): string {
  const target = new URL(fixture.app.baseUrl);
  target.searchParams.set('surface', `${ns}:surface.sales_order_list`);
  target.searchParams.set(
    `${ns}:parameter.sales_order_list_legal_entity_scope`,
    fixture.scope,
  );
  for (const [name, value] of Object.entries(parameters))
    target.searchParams.set(name, value);
  return target.href;
}

/** The served List, read the way a person reads it: tabs, rows, cells. */
async function page(target: string) {
  const response = await fetch(target, { redirect: 'manual' });
  const html = await response.text();
  const row = (recordId: string) =>
    new RegExp(
      `<tr data-compact-card="true" data-record-id="${recordId}">([\\s\\S]*?)</tr>`,
      'u',
    ).exec(html)?.[1] ?? '';
  return {
    html,
    status: response.status,
    total: Number(/data-list-total="(\d+)"/u.exec(html)?.[1] ?? Number.NaN),
    counts: Object.fromEntries(
      [
        ...html.matchAll(
          /data-view-id="([^"]+)"[^>]*>(?:<span>[^<]*<\/span>)(?:<span class="list-view__count" data-view-count="(\d+)")?/gu,
        ),
      ].map((match) => [
        match[1]!,
        match[2] === undefined ? null : Number(match[2]),
      ]),
    ),
    rows: [
      ...html.matchAll(
        /<tr data-compact-card="true" data-record-id="([^"]+)">/gu,
      ),
    ]
      .map((match) => match[1]!)
      .sort(),
    cell: (recordId: string, local: string) =>
      new RegExp(
        `data-column-id="${ns}:list_column\\.sales_order_list_${local}">([\\s\\S]*?)</td>`,
        'u',
      ).exec(row(recordId))?.[1],
    action: (recordId: string) => {
      const match =
        /<a class="secondary-action" href="([^"]+)" data-row-action="[^"]+" aria-label="[^"]+">([^<]+)<\/a>/u.exec(
          row(recordId),
        );
      return match
        ? { href: match[1]!.replaceAll('&amp;', '&'), label: match[2]! }
        : null;
    },
  };
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

/**
 * The stored truth, computed here in ONE independent statement and never
 * through the list statement or the read model under test: per active line,
 * what it has open (ordered less its active shipped rows) and what its own
 * live reservations' balances still hold; per item, free stock now -- posted
 * stock at usable locations less what reservations hold there; then each
 * line's share of the free stock in line order, by a running total, as the
 * order page allocates it. An order is short in the draft and confirmed
 * states only; covered counts each line at most for what it has open.
 */
async function storedTruth(fixture: Fixture) {
  const target = await governedStorageTarget();
  const entity = (local: string) =>
    target.entities.find(
      (value) => value.entityId === `${ns}:entity.${local}`,
    )!;
  const table = (local: string) => fulfillmentTable(entity(local));
  const column = (local: string, name: string) =>
    `"${fulfillmentColumn(entity(local), name)}"`;
  const relation = (local: string) =>
    `"${
      target.relations.find(
        (value) => value.relationId === `${ns}:relation.${local}`,
      )!.relationColumn.physicalName
    }"`;
  const live = (alias: string) =>
    `${alias}.tenant_id = $1 AND ${alias}.environment_id = $2 AND ${alias}.archived_at IS NULL`;
  const owned = (alias: string) =>
    `${live(alias)} AND ${alias}.legal_entity_id = $3`;
  const { rows } = await fixture.pool.query<{
    record_id: string;
    state: string;
    open: string;
    covered: string;
    short: string;
    lines: { record_id: string; short: string }[] | null;
  }>(
    `WITH orders AS (
       SELECT o.record_id, o.${column('sales_order', 'derived_state_field.machine.sales_order_lifecycle')}::text AS state
         FROM ${table('sales_order')} o WHERE ${owned('o')}
     ), lines AS (
       SELECT l.record_id, l.${relation('sales_order_line_order')} AS order_id,
              l.${column('sales_order_line', 'sales_order_line_item_id')}::text AS item,
              l.${column('sales_order_line', 'sales_order_line_line_number')} AS line_number,
              l.${column('sales_order_line', 'sales_order_line_ordered_quantity')}
                - coalesce((SELECT sum(s.${column('sales_order_shipped', 'sales_order_shipped_shipped_quantity')})
                              FROM ${table('sales_order_shipped')} s
                             WHERE ${owned('s')} AND s.${relation('sales_order_shipped_order_line')} = l.record_id), 0) AS open,
              coalesce((SELECT sum(b.${column('reservation_balance', 'reservation_balance_remaining_quantity')})
                          FROM ${table('reservation')} r
                          JOIN ${table('reservation_balance')} b
                            ON ${owned('b')} AND b.${relation('reservation_balance_reservation')} = r.record_id
                         WHERE ${owned('r')} AND r.${relation('reservation_order_line')} = l.record_id), 0) AS covered
         FROM ${table('sales_order_line')} l WHERE ${owned('l')}
     ), usable AS (
       SELECT p.record_id::text AS id FROM ${table('location')} p
        WHERE ${live('p')} AND p.${column('location', 'location_status')}::text = $4
     ), free AS (
       SELECT item, sum(quantity) AS free FROM (
         SELECT q.${column('posted_stock_balance', 'posted_stock_balance_item_id')}::text AS item,
                q.${column('posted_stock_balance', 'posted_stock_balance_posted_quantity')} AS quantity
           FROM ${table('posted_stock_balance')} q
          WHERE ${owned('q')} AND q.${column('posted_stock_balance', 'posted_stock_balance_location_id')}::text IN (SELECT id FROM usable)
         UNION ALL
         SELECT r.${column('reservation', 'reservation_item_id')}::text,
                -b.${column('reservation_balance', 'reservation_balance_remaining_quantity')}
           FROM ${table('reservation')} r
           JOIN ${table('reservation_balance')} b
             ON ${owned('b')} AND b.${relation('reservation_balance_reservation')} = r.record_id
          WHERE ${owned('r')} AND r.${column('reservation', 'reservation_location_id')}::text IN (SELECT id FROM usable)
       ) AS parts GROUP BY item
     ), allocated AS (
       SELECT lines.*, greatest(lines.open - lines.covered, 0) AS uncovered,
              greatest(coalesce(free.free, 0), 0) AS pool,
              coalesce(sum(greatest(lines.open - lines.covered, 0)) OVER (
                PARTITION BY lines.order_id, lines.item
                ORDER BY lines.line_number, lines.record_id
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
         FROM lines LEFT JOIN free ON free.item = lines.item
     ), judged AS (
       SELECT allocated.*, orders.state,
              CASE WHEN orders.state = ANY($5::text[])
                   THEN greatest(allocated.uncovered - greatest(allocated.pool - allocated.before, 0), 0)
                   ELSE 0 END AS short
         FROM allocated JOIN orders ON orders.record_id = allocated.order_id
     )
     SELECT o.record_id::text, o.state,
            coalesce(sum(j.open), 0)::text AS open,
            coalesce(sum(least(j.covered, greatest(j.open, 0))), 0)::text AS covered,
            coalesce(sum(j.short), 0)::text AS short,
            json_agg(json_build_object('record_id', j.record_id::text, 'short', j.short::text)) FILTER (WHERE j.record_id IS NOT NULL) AS lines
       FROM orders o LEFT JOIN judged j ON j.order_id = o.record_id
      GROUP BY o.record_id, o.state`,
    [
      fixture.app.runtime.identity.tenantId,
      fixture.app.runtime.identity.environmentId,
      fixture.scope,
      `${ns}:option.location_status_usable`,
      [`${ns}:state.sales_order_draft`, `${ns}:state.sales_order_released`],
    ],
  );
  return rows.map((row) => ({
    recordId: row.record_id,
    state: row.state.split(':state.sales_order_')[1]!,
    open: units(row.open),
    covered: units(row.covered),
    short: units(row.short),
    lines: new Map(
      (row.lines ?? []).map((line) => [line.record_id, units(line.short)]),
    ),
  }));
}

/** An order page's Fulfillment row's cell, by its column label. */
function pageCell(html: string, recordId: string, label: string) {
  const section =
    new RegExp(
      `<section id="${ns}:dataset\\.fulfillment_lines"[\\s\\S]*?</section>`,
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
  'SUPPLY-WARNINGS: the Sales orders List counts Blocked by supply and Reserved, states each order Short and links reserved work as the stored truth and the order page say, and serves without the supply current policy withholds',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const scenario = (await fixture.measure('supply')) as unknown as Scenario;
      const { elsewhere, held, part, short, fine, draft } = scenario.orders;
      const truth = await storedTruth(fixture);
      const of = (seeded: Seeded) =>
        truth.find((row) => row.recordId === seeded.recordId)!;
      // The scenario as designed: two lines share 17 free and are 9 short;
      // the draft is 13 short; reservations elsewhere, in quarantine and
      // part-shipped cover their own lines.
      assert.equal(of(short).short, units('9'));
      assert.equal(of(draft).short, units('13'));
      for (const seeded of [elsewhere, held, part, fine])
        assert.equal(of(seeded).short, 0n, seeded.number);
      assert.deepEqual(
        [elsewhere, held, part, short, fine].map((seeded) =>
          text(of(seeded).covered),
        ),
        ['2', '3', '1', '4', '0'],
      );

      // Every tab count equals the stored truth.
      const released = truth.filter((row) => row.state === 'released');
      const expected = {
        [view('all')]: truth.length,
        [view('to_ship')]: released.filter((row) => row.open > 0n).length,
        [view('blocked')]: released.filter((row) => row.short > 0n).length,
        [view('reserved')]: released.filter((row) => row.covered > 0n).length,
        [view('draft')]: truth.filter((row) => row.state === 'draft').length,
        [view('released')]: released.length,
        [view('closed')]: truth.filter((row) => row.state === 'closed').length,
        [view('cancelled')]: truth.filter((row) => row.state === 'cancelled')
          .length,
      };
      assert.deepEqual(
        [expected[view('blocked')], expected[view('reserved')]],
        [1, 4],
      );
      const list = await page(salesUrl(fixture));
      assert.equal(list.status, 200);
      assert.doesNotMatch(list.html, /data-diagnostic-code=|supply-withheld/u);
      assert.deepEqual(list.counts, expected);
      // Each row's Short is the stored truth, marked where anything is short;
      // its action is "Post shipment" exactly while reserved stock is still
      // to ship on a confirmed order.
      for (const row of truth) {
        const shown = text(row.short);
        assert.equal(
          list.cell(row.recordId, 'short'),
          row.short > 0n ? `${shown}${SHORT_MARK}` : shown,
          row.recordId,
        );
        assert.equal(
          list.action(row.recordId)?.label,
          row.state === 'released' && row.covered > 0n
            ? 'Post shipment'
            : row.state === 'released' && row.open > 0n
              ? 'Fulfill'
              : 'View',
          row.recordId,
        );
      }
      // Each supply tab lists exactly its set, and exports as many.
      for (const [local, keep] of [
        ['blocked', (row: (typeof truth)[number]) => row.short > 0n],
        ['reserved', (row: (typeof truth)[number]) => row.covered > 0n],
      ] as const) {
        const tab = await page(salesUrl(fixture, { view: view(local) }));
        const kept = released.filter(keep).map((row) => row.recordId);
        assert.equal(tab.total, kept.length, local);
        assert.deepEqual(tab.rows, [...kept].sort(), local);
        const exported = await fetch(
          `${salesUrl(fixture, { view: view(local) })}&export=csv`,
        );
        assert.equal(exported.status, 200);
        const csv = (await exported.text())
          .replace(/^\uFEFF/u, '')
          .trimEnd()
          .split('\r\n');
        assert.equal(
          csv[0],
          'Number,Customer,Salesperson,Order date,Requested,Status,Ordered,Shipped,Open,Short,On order,Currency',
        );
        assert.equal(csv.length - 1, kept.length, local);
      }

      // One formula: "Post shipment" opens the order at its fulfillment
      // section, whose Short states each line exactly as the stored truth
      // allocates it, adding up to the List's figure.
      const post = list.action(short.recordId)!;
      assert.equal(post.label, 'Post shipment');
      const target = new URL(post.href, fixture.app.baseUrl);
      assert.equal(target.hash, `#${ns}:dataset.fulfillment_lines`);
      const opened = await fetch(target.href, { redirect: 'manual' });
      assert.equal(opened.status, 200);
      const orderPage = await opened.text();
      let total = 0n;
      for (const line of short.lines) {
        const stated = pageCell(orderPage, line, 'Short');
        assert.equal(stated, text(of(short).lines.get(line)!), line);
        total += units(stated);
      }
      assert.deepEqual(
        short.lines.map((line) => text(of(short).lines.get(line)!)),
        ['0', '9'],
      );
      assert.equal(total, of(short).short);
      // The banner names exactly the short line.
      const banner =
        /<section class="composition-alert"[^>]*>([\s\S]*?)<\/section>/u.exec(
          orderPage,
        )?.[1] ?? '';
      assert.deepEqual(
        [...banner.matchAll(/<li data-record-id="([^"]+)">/gu)].map(
          (match) => match[1],
        ),
        [short.lines[1]],
      );

      // Without stock read the supply is supplementary: the List serves with
      // its progress, Short reads "—", the supply tabs are refused by name
      // and uncounted, and no row promises a shipment.
      await fixture.measure(
        'deny',
        undefined,
        undefined,
        'posted_stock_balance_read',
      );
      const withheld = await page(salesUrl(fixture));
      assert.equal(withheld.status, 200);
      assert.doesNotMatch(withheld.html, /data-diagnostic-code=/u);
      assert.equal(withheld.total, truth.length);
      assert.equal(withheld.cell(short.recordId, 'short'), WITHHELD);
      assert.equal(withheld.cell(short.recordId, 'open'), '30');
      assert.match(
        withheld.html,
        new RegExp(
          `data-list-supply-withheld="${ns}:query\\.workspace_stock"`,
          'u',
        ),
      );
      assert.deepEqual(withheld.counts, {
        ...expected,
        [view('blocked')]: null,
        [view('reserved')]: null,
      });
      assert.equal(withheld.action(short.recordId)?.label, 'Fulfill');
      const refused = await page(salesUrl(fixture, { view: view('blocked') }));
      assert.match(
        refused.html,
        /data-diagnostic-code="QUERY_PERMISSION_DENIED"/u,
      );
      assert.equal(refused.rows.length, 0);
      assert.equal(refused.counts[view('all')], truth.length);
      await fixture.measure(
        'allow',
        undefined,
        undefined,
        'posted_stock_balance_read',
      );
      assert.equal(
        (await page(salesUrl(fixture))).cell(short.recordId, 'short'),
        `9${SHORT_MARK}`,
      );
    });
  },
);
