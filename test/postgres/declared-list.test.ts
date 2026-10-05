import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const execFileAsync = promisify(execFile);
const ns = 'northstar.app';
const scopeParameter = (local: string) =>
  `${ns}:parameter.${local}_list_legal_entity_scope`;
const salesView = (local: string) =>
  `${ns}:list_view.sales_order_list_${local}`;
const ORDERS = 60;

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

function listUrl(
  fixture: Fixture,
  local: string,
  parameters: Record<string, string> = {},
): string {
  const url = new URL(fixture.app.baseUrl);
  url.searchParams.set('surface', `${ns}:surface.${local}_list`);
  url.searchParams.set(scopeParameter(local), fixture.scope);
  for (const [name, value] of Object.entries(parameters))
    url.searchParams.set(name, value);
  return url.href;
}

async function page(url: string) {
  const response = await fetch(url, { redirect: 'manual' });
  const html = await response.text();
  const attribute = (name: string) =>
    [...html.matchAll(new RegExp(`${name}="([^"]*)"`, 'gu'))].map(
      (match) => match[1]!,
    );
  const cells = (columnLocal: string, list = 'sales_order_list') =>
    [
      ...html.matchAll(
        new RegExp(
          `data-column-id="${ns}:list_column\\.${list}_${columnLocal}">(?:<span[^>]*>)?(?:<a[^>]*>)?([^<]*)`,
          'gu',
        ),
      ),
    ].map((match) => match[1]!.replaceAll('&amp;', '&'));
  return {
    html,
    status: response.status,
    total: Number(attribute('data-list-total')[0] ?? NaN),
    counts: Object.fromEntries(
      [
        ...html.matchAll(
          /data-view-id="([^"]+)"[^>]*>(?:<span>[^<]*<\/span>)<span class="list-view__count" data-view-count="(\d+)"/gu,
        ),
      ].map((match) => [match[1]!, Number(match[2]!)]),
    ),
    currentView: /data-view-id="([^"]+)" aria-current="page"/u.exec(html)?.[1],
    pageStatus: /data-list-page="(\d+)" data-list-page-count="(\d+)"/u.exec(
      html,
    ),
    cells,
  };
}

/** Independent facts: the stored rows, read from PostgreSQL directly. */
async function storedOrders(fixture: Fixture) {
  const target = await governedStorageTarget();
  const entity = (local: string) =>
    target.entities.find(
      (value) => value.entityId === `${ns}:entity.${local}`,
    )!;
  const order = entity('sales_order');
  const party = entity('party');
  const { rows } = await fixture.pool.query<{
    state: string;
    currency: string;
    customer: string | null;
  }>(
    `SELECT o.${fulfillmentColumn(order, `derived_state_field.machine.sales_order_lifecycle`)} AS state,
            o.${fulfillmentColumn(order, 'sales_order_currency')} AS currency,
            p.${fulfillmentColumn(party, 'party_name')} AS customer
       FROM ${fulfillmentTable(order)} AS o
       LEFT JOIN ${fulfillmentTable(party)} AS p
         ON p.tenant_id = o.tenant_id AND p.environment_id = o.environment_id
        AND p.record_id::text = o.${fulfillmentColumn(order, 'sales_order_customer_party_id')}
      WHERE o.tenant_id = $1 AND o.environment_id = $2 AND o.archived_at IS NULL`,
    [
      fixture.app.runtime.identity.tenantId,
      fixture.app.runtime.identity.environmentId,
    ],
  );
  return rows;
}

/** Stored active sales order lines of the fixture's company. */
async function storedLineCount(fixture: Fixture) {
  const target = await governedStorageTarget();
  const line = target.entities.find(
    (value) => value.entityId === `${ns}:entity.sales_order_line`,
  )!;
  const { rows } = await fixture.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${fulfillmentTable(line)}
      WHERE tenant_id = $1 AND environment_id = $2 AND archived_at IS NULL`,
    [
      fixture.app.runtime.identity.tenantId,
      fixture.app.runtime.identity.environmentId,
    ],
  );
  return Number(rows[0]!.count);
}

test(
  'a declared List pages, counts, searches by label, sorts, filters and exports through the query gateway',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(
      async (fixture) => {
        const stored = await storedOrders(fixture);
        assert.equal(stored.length, ORDERS);
        const byState = (local: string) =>
          stored.filter(
            (row) => row.state === `${ns}:state.sales_order_${local}`,
          ).length;

        // Tabs: one server count per view, equal to the stored rows by state.
        // The List orders carry no lines, so nothing is left to ship: the
        // stored lines say so (order-lists.test.ts counts shipped work).
        assert.equal(await storedLineCount(fixture), 0);
        const first = await page(listUrl(fixture, 'sales_order'));
        assert.equal(first.status, 200);
        assert.equal(first.currentView, salesView('all'));
        assert.deepEqual(first.counts, {
          [salesView('all')]: ORDERS,
          [salesView('to_ship')]: 0,
          [salesView('draft')]: byState('draft'),
          [salesView('released')]: byState('released'),
          [salesView('closed')]: byState('closed'),
          [salesView('cancelled')]: byState('cancelled'),
        });
        assert.ok(byState('draft') > 0 && byState('released') > 0);
        // Customers are named through the party list, never shown as ids.
        const shownCustomers = first.cells('counterparty');
        assert.equal(shownCustomers.length, 50);
        assert.ok(
          shownCustomers.every((name) => !/^[0-9a-f-]{36}$/u.test(name)),
        );
        assert.equal(first.pageStatus?.[1], '1');
        assert.equal(first.pageStatus?.[2], '2');

        // A view is a server filter: every row and the count agree with storage.
        const drafts = await page(
          listUrl(fixture, 'sales_order', { view: salesView('draft') }),
        );
        assert.equal(drafts.total, byState('draft'));
        assert.ok(drafts.cells('status').every((value) => value === 'Draft'));

        // Search by the customer's NAME matches the label join, counted server-side.
        const name = stored.find((row) => row.customer)!.customer!;
        const term = name.split(' ')[0]!;
        const searched = await page(
          listUrl(fixture, 'sales_order', { q: term }),
        );
        const expected = stored.filter((row) =>
          row.customer?.toLowerCase().includes(term.toLowerCase()),
        ).length;
        assert.ok(expected > 0);
        assert.equal(searched.total, expected);
        // Each tab under the same search counts its share of the same set.
        assert.equal(
          searched.counts[salesView('draft')]! +
            searched.counts[salesView('released')]! +
            searched.counts[salesView('closed')]! +
            searched.counts[salesView('cancelled')]!,
          searched.counts[salesView('all')],
        );

        // Sort by the label, descending, across the page.
        const sorted = await page(
          listUrl(fixture, 'sales_order', {
            sort: `${ns}:list_column.sales_order_list_counterparty`,
            dir: 'desc',
          }),
        );
        const names = sorted.cells('counterparty');
        assert.deepEqual(
          names,
          [...names].sort((left, right) =>
            left < right ? 1 : left > right ? -1 : 0,
          ),
        );
        assert.match(sorted.html, /aria-sort="descending"/u);

        // A declared filter narrows with the gateway's exact filter.
        const usd = await page(
          listUrl(fixture, 'sales_order', {
            [`${ns}:list_filter.sales_order_list_currency`]: 'USD',
          }),
        );
        assert.equal(
          usd.total,
          stored.filter((row) => row.currency === 'USD').length,
        );
        assert.ok(usd.cells('currency').every((value) => value === 'USD'));

        // Paging: page 2 holds the remainder; a page past the end is the last page.
        const second = await page(
          listUrl(fixture, 'sales_order', { page: '2' }),
        );
        assert.equal(second.cells('number').length, ORDERS - 50);
        const beyond = await page(
          listUrl(fixture, 'sales_order', { page: '9' }),
        );
        assert.equal(beyond.pageStatus?.[1], '2');
        assert.equal(beyond.cells('number').length, ORDERS - 50);

        // Export: one CSV of the whole view, labels presented, no page limit.
        const exported = await fetch(
          `${listUrl(fixture, 'sales_order', { view: salesView('draft') })}&export=csv`,
        );
        assert.equal(exported.status, 200);
        assert.match(exported.headers.get('content-type') ?? '', /^text\/csv/u);
        assert.match(
          exported.headers.get('content-disposition') ?? '',
          /^attachment; filename="sales-orders-\d{4}-\d{2}-\d{2}\.csv"$/u,
        );
        const csv = (await exported.text())
          .replace(/^\uFEFF/u, '')
          .trimEnd()
          .split('\r\n');
        // Ruling E adds the salesperson, named like the customer; ORDER-PARITY
        // the units each order's lines order, ship and leave open.
        assert.equal(
          csv[0],
          'Number,Customer,Salesperson,Order date,Requested,Status,Ordered,Shipped,Open,Currency',
        );
        assert.equal(csv.length - 1, byState('draft'));
        assert.ok(csv.slice(1).every((row) => row.includes(',Draft,')));
        assert.ok(
          csv
            .slice(1)
            .some((row) =>
              stored.some(
                (value) => value.customer && row.includes(value.customer),
              ),
            ),
        );

        // The agent path: the published presets are ordinary query arguments,
        // answered by the same gateway with the same counts as the screen.
        const counted = await fixture.app.runtime.entry.run(
          { headers: {} },
          async (view) => {
            const agent = view.projections.agent.payload as {
              listPresets: Array<{
                surfaceId: string;
                queryId: string;
                views: Array<{
                  viewId: string;
                  fieldFilters: Array<{ fieldId: string; value: string }>;
                }>;
              }>;
            };
            const preset = agent.listPresets.find(
              (value) => value.surfaceId === `${ns}:surface.sales_order_list`,
            )!;
            const draftPreset = preset.views.find(
              (value) => value.viewId === salesView('draft'),
            )!;
            const result = await fixture.app.runtime.queryGateway.invoke(view, {
              arguments: {
                includeArchived: false,
                list: {
                  cursor: null,
                  fieldFilters: draftPreset.fieldFilters,
                  matchMode: 'substring',
                  pageSize: 1,
                  relationLabels: [],
                  schemaVersion: SHARED_LIST_QUERY_VERSION,
                  search: '',
                  sort: [],
                },
                [scopeParameter('sales_order')]: fixture.scope,
              },
              queryId: preset.queryId,
              schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            });
            return result.listCoverage?.totalCount;
          },
        );
        assert.equal(counted, byState('draft'));

        // Current authority: without party read, no customer name is disclosed.
        await fixture.measure('deny', undefined, undefined, 'party_read');
        const denied = await page(listUrl(fixture, 'sales_order'));
        assert.ok(
          !stored.some(
            (row) => row.customer && denied.html.includes(row.customer),
          ),
        );
        await fixture.measure('allow', undefined, undefined, 'party_read');
        const allowed = await page(listUrl(fixture, 'sales_order'));
        assert.equal(allowed.total, ORDERS);

        // A genuinely different List reuses the same runtime: posted stock names
        // its item and location through their own lists and exports them.
        const stock = await page(listUrl(fixture, 'posted_stock_balance'));
        assert.equal(stock.status, 200);
        const sku = stock.cells('sku', 'posted_stock_balance_list');
        assert.ok(
          sku.length > 0 &&
            sku.every((value) => !/^[0-9a-f-]{36}$/u.test(value)),
        );
        assert.ok(
          stock
            .cells('location', 'posted_stock_balance_list')
            .every((value) => !/^[0-9a-f-]{36}$/u.test(value)),
        );
        const stockCsv = await (
          await fetch(`${listUrl(fixture, 'posted_stock_balance')}&export=csv`)
        ).text();
        assert.ok(stockCsv.includes(sku[0]!));
      },
      'distributor',
      0,
      ORDERS,
    );
  },
);

test(
  'a metadata-only List variation changes views, order, page size and export limit with no runtime change',
  { timeout: 300_000 },
  async () => {
    const release = resolve('apps/web/release');
    const authored = JSON.parse(
      await readFile(resolve(release, 'app.authored.json'), 'utf8'),
    ) as {
      package: { version: string };
      queries: Array<Record<string, unknown>>;
      surfaces: Array<Record<string, unknown>>;
    };
    authored.package.version = '1.0.1';
    const sales = authored.surfaces.find(
      (surface) => surface.surfaceId === `${ns}:surface.sales_order_list`,
    )!;
    const list = sales.list as {
      pageSize: number;
      views: Array<{ viewId: string; orderKey: number }>;
      defaultSort: Array<{ columnId: string; direction: string }>;
    };
    list.pageSize = 10;
    list.views = list.views
      .filter((view) =>
        [salesView('released'), salesView('draft')].includes(view.viewId),
      )
      .map((view) => ({
        ...view,
        orderKey: view.viewId === salesView('released') ? 1 : 2,
      }));
    list.defaultSort = [
      {
        columnId: `${ns}:list_column.sales_order_list_counterparty`,
        direction: 'ascending',
      },
    ];
    // WAREHOUSE-MODE: the Warehouse's Pick and ship tile opens the To ship
    // view this variant drops, and the compiler refuses a tile whose view its
    // List no longer declares; the variation stays metadata-only by pointing
    // that tile at a view the List keeps.
    const warehouse = authored.surfaces.find(
      (surface) => surface.surfaceId === `${ns}:surface.inventory_warehouse`,
    )!;
    for (const tile of (
      warehouse.launcher as {
        tiles: Array<{ surface: string; view?: string }>;
      }
    ).tiles)
      if (tile.surface === `${ns}:surface.sales_order_list`)
        tile.view = salesView('released');
    authored.queries.find(
      (query) => query.queryId === `${ns}:query.sales_order_list`,
    )!.exportMaximumResultCount = 5;

    const directory = await mkdtemp(
      resolve(tmpdir(), 'northstar-list-variant-'),
    );
    let compiled: unknown;
    try {
      await writeFile(
        resolve(directory, 'app.authored.json'),
        JSON.stringify(authored),
      );
      for (const file of [
        'app.compiled.json',
        'current-policy-bindings.json',
        'unbound-permission-acknowledgement.json',
      ])
        await copyFile(resolve(release, file), resolve(directory, file));
      await execFileAsync(
        process.execPath,
        ['--import', 'tsx', resolve('apps/web/scripts/compile-app-release.ts')],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            NORTH_STAR_APP_AUTHORED_PATH: resolve(
              directory,
              'app.authored.json',
            ),
            NORTH_STAR_APP_COMPILED_PATH: resolve(
              directory,
              'app.compiled.json',
            ),
          },
          maxBuffer: 4 * 1024 * 1024,
          timeout: 120_000,
        },
      );
      compiled = JSON.parse(
        await readFile(resolve(directory, 'app.compiled.json'), 'utf8'),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
    await withOrderEntryFixture(
      async (fixture) => {
        const served = await page(listUrl(fixture, 'sales_order'));
        assert.equal(served.status, 200);
        // The first declared view is now Released, and only two views exist.
        assert.equal(served.currentView, salesView('released'));
        assert.deepEqual(Object.keys(served.counts), [
          salesView('released'),
          salesView('draft'),
        ]);
        // Page size 10 and customer-name order come from the declaration.
        const numbers = served.cells('number');
        assert.equal(numbers.length, 10);
        const names = served.cells('counterparty');
        assert.deepEqual(names, [...names].sort());
        // An export larger than the declared limit is refused, never cut short.
        const refused = await fetch(
          `${listUrl(fixture, 'sales_order')}&export=csv`,
        );
        assert.equal(refused.status, 422);
        assert.match(refused.headers.get('content-type') ?? '', /^text\/html/u);
        assert.match(await refused.text(), /Export limit exceeded/u);
        // The agent projection publishes the variant's own presets and limit.
        const agent = await fixture.app.runtime.entry.run(
          { headers: {} },
          (view) => Promise.resolve(view.projections.agent.payload),
        );
        const payload = agent as {
          listPresets: Array<{
            surfaceId: string;
            views: Array<{ viewId: string }>;
          }>;
          queries: Array<{
            queryId: string;
            exportMaximumResultCount?: number;
          }>;
        };
        assert.deepEqual(
          payload.listPresets
            .find(
              (preset) => preset.surfaceId === `${ns}:surface.sales_order_list`,
            )!
            .views.map((view) => view.viewId)
            .sort(),
          [salesView('draft'), salesView('released')],
        );
        assert.equal(
          payload.queries.find(
            (query) => query.queryId === `${ns}:query.sales_order_list`,
          )?.exportMaximumResultCount,
          5,
        );
      },
      'distributor',
      0,
      30,
      compiled,
    );
  },
);
