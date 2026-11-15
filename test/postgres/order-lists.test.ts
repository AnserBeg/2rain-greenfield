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
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';
const WITHHELD = '<span class="muted">—</span>';

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

interface Seeded {
  readonly number: string;
  readonly recordId: string;
  readonly total?: string;
}
interface Scenario {
  readonly sales: { readonly shipping: Seeded; readonly draft: Seeded };
  readonly purchases: {
    readonly receiving: Seeded;
    readonly complete: Seeded;
  };
}

function url(
  fixture: Fixture,
  surface: string,
  scopeParameter: string,
  parameters: Record<string, string> = {},
): string {
  const target = new URL(fixture.app.baseUrl);
  target.searchParams.set('surface', `${ns}:surface.${surface}`);
  target.searchParams.set(
    `${ns}:parameter.${scopeParameter}_legal_entity_scope`,
    fixture.scope,
  );
  for (const [name, value] of Object.entries(parameters))
    target.searchParams.set(name, value);
  return target.href;
}
const salesUrl = (fixture: Fixture, parameters?: Record<string, string>) =>
  url(fixture, 'sales_order_list', 'sales_order_list', parameters);
// The Purchase orders List reads the commercial clone of its query, whose
// company parameter is its own.
const purchaseUrl = (fixture: Fixture, parameters?: Record<string, string>) =>
  url(
    fixture,
    'purchase_order_list',
    'commercial_purchase_order_list',
    parameters,
  );

/** The served page, read the way a person reads it: tabs, rows, figures. */
async function page(target: string, list: string) {
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
    ].map((match) => match[1]!),
    cell: (recordId: string, local: string) =>
      new RegExp(
        `data-column-id="${ns}:list_column\\.${list}_${local}">([\\s\\S]*?)</td>`,
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

/**
 * Independent facts: every sales order, line and shipped row read from
 * PostgreSQL directly and added up here, never through the list statement
 * under test. An order has something to ship when it is confirmed (released)
 * and its active lines order more than their active shipped rows record.
 */
async function storedSales(fixture: Fixture) {
  const target = await governedStorageTarget();
  const entity = (local: string) =>
    target.entities.find(
      (value) => value.entityId === `${ns}:entity.${local}`,
    )!;
  const relation = (local: string) =>
    target.relations.find(
      (value) => value.relationId === `${ns}:relation.${local}`,
    )!.relationColumn.physicalName;
  const read = async (local: string, columns: string) =>
    (
      await fixture.pool.query<Record<string, unknown>>(
        `SELECT record_id::text AS record_id, archived_at, ${columns}
           FROM ${fulfillmentTable(entity(local))}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${entity(local).legalEntity!.column} = $3`,
        [
          fixture.app.runtime.identity.tenantId,
          fixture.app.runtime.identity.environmentId,
          fixture.scope,
        ],
      )
    ).rows;
  const orders = await read(
    'sales_order',
    `${fulfillmentColumn(entity('sales_order'), 'derived_state_field.machine.sales_order_lifecycle')} AS state`,
  );
  const lines = await read(
    'sales_order_line',
    `${relation('sales_order_line_order')}::text AS order_id,
     ${fulfillmentColumn(entity('sales_order_line'), 'sales_order_line_ordered_quantity')}::text AS quantity`,
  );
  const shipped = await read(
    'sales_order_shipped',
    `${relation('sales_order_shipped_order_line')}::text AS line_id,
     ${fulfillmentColumn(entity('sales_order_shipped'), 'sales_order_shipped_shipped_quantity')}::text AS quantity`,
  );
  return orders
    .filter((row) => row.archived_at === null)
    .map((row) => {
      const active = lines.filter(
        (entry) =>
          entry.order_id === row.record_id && entry.archived_at === null,
      );
      const ordered = active.reduce(
        (total, entry) => total + units(entry.quantity),
        0n,
      );
      const done = shipped
        .filter(
          (entry) =>
            entry.archived_at === null &&
            active.some((value) => value.record_id === entry.line_id),
        )
        .reduce((total, entry) => total + units(entry.quantity), 0n);
      const state = String(row.state).split(':state.sales_order_')[1]!;
      return {
        recordId: String(row.record_id),
        state,
        toShip: state === 'released' && ordered - done > 0n,
      };
    });
}

/** A purchase order's page, read with its totals, and its Total fact. */
async function orderPageTotal(fixture: Fixture, recordId: string) {
  const response = await fetch(
    url(fixture, 'purchase_order_detail', 'commercial_purchase_order_get', {
      record: recordId,
    }),
    { redirect: 'manual' },
  );
  assert.equal(response.status, 200);
  return /<dt>Total<\/dt><dd>([^<]*)<\/dd>/u.exec(await response.text())?.[1];
}

test(
  'ORDER-PARITY: the order Lists count their work tabs against stored lines, total each order as its page does, and serve without figures current policy withholds',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const scenario = (await fixture.measure(
        'order_lists',
      )) as unknown as Scenario;
      // More states beside the scenario: a cancelled draft and an order
      // confirmed with nothing shipped at all.
      const now = new Date().toISOString();
      const shipTo = {
        ship_to_name: 'Receiving dock',
        ship_to_street: '100 Industrial Way',
        ship_to_city: 'Calgary',
        ship_to_region: 'AB',
        ship_to_postal_code: 'T2P 0A1',
        ship_to_country: 'Canada',
      };
      const order = (quantity: string) =>
        fixture
          .create('sales_order', {
            customer_party_id: fixture.customer,
            order_date: now,
            requested_date: now,
            currency: 'CAD',
            notes: null,
            ...shipTo,
          })
          .then(async (created) => {
            await fixture.create(
              'sales_order_line',
              {
                item_id: fixture.item,
                line_number: '1',
                ordered_quantity: quantity,
                unit_id: 'EA',
                unit_price: null,
              },
              { order: created.recordId },
            );
            return created;
          });
      const cancelled = await order('4');
      assert.equal(
        (
          await fixture.invoke('sales_order_draft_cancel', {
            recordId: cancelled.recordId,
            expectedRevision: cancelled.revision,
          })
        ).outcome,
        'succeeded',
      );
      const untouched = await order('6');
      assert.equal(
        (
          await fixture.invoke('sales_order_release', {
            recordId: untouched.recordId,
            expectedRevision: untouched.revision,
          })
        ).outcome,
        'succeeded',
      );

      // Every tab count equals the stored truth.
      const truth = await storedSales(fixture);
      const salesView = (local: string) =>
        `${ns}:list_view.sales_order_list_${local}`;
      const byState = (state: string) =>
        truth.filter((row) => row.state === state).length;
      const toShip = truth.filter((row) => row.toShip);
      assert.equal(toShip.length, 2);
      const sales = await page(salesUrl(fixture), 'sales_order_list');
      assert.equal(sales.status, 200);
      // SUPPLY-WARNINGS: the shipping order still holds 1 of its reserved 4
      // for its open line, and free stock (10 on hand less 3 shipped less
      // that 1) covers everything open, so one order is reserved and none
      // is blocked (order-lists-supply.test.ts judges the supply itself).
      assert.deepEqual(sales.counts, {
        [salesView('all')]: truth.length,
        [salesView('to_ship')]: toShip.length,
        [salesView('blocked')]: 0,
        [salesView('reserved')]: 1,
        [salesView('draft')]: byState('draft'),
        [salesView('released')]: byState('released'),
        [salesView('closed')]: byState('closed'),
        [salesView('cancelled')]: byState('cancelled'),
      });
      // 5 + 3 ordered, 3 of the first line shipped: 5 still to ship.
      const shipping = scenario.sales.shipping.recordId;
      assert.equal(sales.cell(shipping, 'ordered'), '8');
      assert.equal(sales.cell(shipping, 'shipped'), '3');
      assert.equal(sales.cell(shipping, 'open'), '5');
      assert.equal(sales.cell(scenario.sales.draft.recordId, 'open'), '0');
      // The row's work: its order's fulfillment section -- "Post shipment"
      // while reserved stock is still to ship, else "Fulfill".
      assert.equal(sales.action(untouched.recordId)?.label, 'Fulfill');
      const fulfill = sales.action(shipping)!;
      assert.equal(fulfill.label, 'Post shipment');
      const target = new URL(fulfill.href, fixture.app.baseUrl);
      assert.equal(target.searchParams.get('record'), shipping);
      assert.equal(target.hash, `#${ns}:dataset.fulfillment_lines`);
      const opened = await fetch(target.href, { redirect: 'manual' });
      assert.equal(opened.status, 200);
      assert.match(
        await opened.text(),
        new RegExp(`<section id="${ns}:dataset\\.fulfillment_lines"`, 'u'),
      );
      assert.equal(sales.action(scenario.sales.draft.recordId)?.label, 'View');
      // The To ship tab lists exactly those orders, and exports as many.
      const tab = await page(
        salesUrl(fixture, { view: salesView('to_ship') }),
        'sales_order_list',
      );
      assert.equal(tab.total, toShip.length);
      assert.deepEqual(
        [...tab.rows].sort(),
        toShip.map((row) => row.recordId).sort(),
      );
      const exported = await fetch(
        `${salesUrl(fixture, { view: salesView('to_ship') })}&export=csv`,
      );
      assert.equal(exported.status, 200);
      const csv = (await exported.text())
        .replace(/^\uFEFF/u, '')
        .trimEnd()
        .split('\r\n');
      assert.equal(
        csv[0],
        'Number,Customer,Salesperson,Order date,Requested,Status,Ordered,Shipped,Open,Short,Currency',
      );
      assert.equal(csv.length - 1, toShip.length);

      // Purchasing: each order's Total is the figure its own page states.
      const purchaseView = (local: string) =>
        `${ns}:list_view.purchase_order_list_${local}`;
      const purchases = await page(purchaseUrl(fixture), 'purchase_order_list');
      assert.equal(purchases.status, 200);
      for (const seeded of [
        scenario.purchases.receiving,
        scenario.purchases.complete,
      ]) {
        assert.equal(purchases.cell(seeded.recordId, 'total'), seeded.total);
        assert.equal(
          await orderPageTotal(fixture, seeded.recordId),
          seeded.total,
        );
      }
      const receiving = scenario.purchases.receiving.recordId;
      assert.equal(purchases.cell(receiving, 'ordered'), '15');
      assert.equal(purchases.cell(receiving, 'received'), '4');
      assert.equal(purchases.cell(receiving, 'open'), '11');
      assert.equal(purchases.counts[purchaseView('to_receive')], 1);
      const receive = purchases.action(receiving)!;
      assert.equal(receive.label, 'Receive');
      assert.equal(
        new URL(receive.href, fixture.app.baseUrl).hash,
        `#${ns}:dataset.purchasing_lines`,
      );
      assert.equal(
        purchases.action(scenario.purchases.complete.recordId)?.label,
        'View',
      );
      // The same figure through the gateway: the List's read model and the
      // order's get state one total.
      const stated = await fixture.app.runtime.entry.run(
        { headers: {} },
        async (view) => {
          const read = (
            queryId: string,
            args: Record<string, ImmutableJsonValue>,
          ) => {
            const definition = registeredSemanticQueryFromPinnedView(
              view,
              `${ns}:query.${queryId}`,
            )!;
            return fixture.app.runtime.queryGateway.invoke(view, {
              schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
              queryId: definition.queryId,
              arguments: {
                ...args,
                [definition.legalEntityScope!.operand.parameterId]:
                  fixture.scope,
              },
            });
          };
          const listed = await read('commercial_purchase_order_list', {
            includeArchived: false,
            list: {
              cursor: null,
              matchMode: 'substring',
              pageSize: 100,
              relationLabels: [],
              schemaVersion: SHARED_LIST_QUERY_VERSION,
              search: '',
              sort: [],
            },
          });
          const single = await read('commercial_purchase_order_get', {
            recordId: receiving,
            includeArchived: false,
          });
          return [
            listed.records.find((value) => value.recordId === receiving)
              ?.values[`${ns}:metric.order_total`],
            single.records[0]?.values[`${ns}:metric.order_total`],
          ];
        },
      );
      assert.deepEqual(stated, ['31.00', '31.00']);

      // Without shipped-quantity read the Sales List still serves: its
      // figures read "—", To ship is refused by name and uncounted, and the
      // other tabs keep their counts.
      await fixture.measure(
        'deny',
        undefined,
        undefined,
        'sales_order_shipped_read',
      );
      const withheld = await page(salesUrl(fixture), 'sales_order_list');
      assert.equal(withheld.status, 200);
      assert.doesNotMatch(withheld.html, /data-diagnostic-code=/u);
      assert.equal(withheld.total, truth.length);
      for (const local of ['ordered', 'shipped', 'open', 'short'])
        assert.equal(withheld.cell(shipping, local), WITHHELD, local);
      assert.match(
        withheld.html,
        new RegExp(
          `data-list-progress-withheld="${ns}:query\\.sales_order_shipped_list"`,
          'u',
        ),
      );
      assert.equal(withheld.counts[salesView('to_ship')], null);
      assert.equal(withheld.counts[salesView('blocked')], null);
      assert.equal(withheld.counts[salesView('reserved')], null);
      assert.equal(withheld.counts[salesView('released')], byState('released'));
      assert.equal(withheld.action(shipping)?.label, 'View');
      const refused = await page(
        salesUrl(fixture, { view: salesView('to_ship') }),
        'sales_order_list',
      );
      assert.match(
        refused.html,
        /data-diagnostic-code="QUERY_PERMISSION_DENIED"/u,
      );
      assert.equal(refused.rows.length, 0);
      assert.equal(refused.counts[salesView('all')], truth.length);
      await fixture.measure(
        'allow',
        undefined,
        undefined,
        'sales_order_shipped_read',
      );

      // Without line read the Purchase orders List still serves, with neither
      // figures nor totals: nothing is computed from lines it may not read.
      await fixture.measure(
        'deny',
        undefined,
        undefined,
        'purchase_order_line_read',
      );
      const linesWithheld = await page(
        purchaseUrl(fixture),
        'purchase_order_list',
      );
      assert.equal(linesWithheld.status, 200);
      assert.doesNotMatch(linesWithheld.html, /data-diagnostic-code=/u);
      for (const local of ['ordered', 'received', 'open', 'total'])
        assert.equal(linesWithheld.cell(receiving, local), WITHHELD, local);
      assert.equal(linesWithheld.counts[purchaseView('to_receive')], null);
      assert.equal(linesWithheld.counts[purchaseView('late')], null);
      await fixture.measure(
        'allow',
        undefined,
        undefined,
        'purchase_order_line_read',
      );
      assert.equal(
        (await page(purchaseUrl(fixture), 'purchase_order_list')).cell(
          receiving,
          'total',
        ),
        '31.00',
      );
    });
  },
);
