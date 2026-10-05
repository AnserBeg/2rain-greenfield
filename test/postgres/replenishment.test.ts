import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';
const STOCK = `${ns}:surface.item_stock_list`;
const BUYING = `${ns}:surface.item_buying_list`;
const parameter = (list: string) =>
  `${ns}:parameter.${list}_legal_entity_scope`;

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

interface Scenario {
  readonly notebook: string;
  readonly pens: string;
  readonly lamp: string;
  readonly labels: string;
  readonly location: string;
}

const escaped = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function listUrl(
  fixture: Fixture,
  surfaceId: string,
  company: string,
  extra: Record<string, string> = {},
): string {
  const url = new URL(fixture.app.baseUrl);
  url.searchParams.set('surface', surfaceId);
  url.searchParams.set(parameter(surfaceId.split(':surface.')[1]!), company);
  for (const [key, value] of Object.entries(extra))
    url.searchParams.set(key, value);
  return url.href;
}

/** The served List, read the way a person reads it: tabs, rows, cells. */
async function listPage(url: string) {
  const response = await fetch(url, { redirect: 'manual' });
  const html = await response.text();
  const rows = [
    ...html.matchAll(
      /<tr data-compact-card="true" data-record-id="([^"]+)">([\s\S]*?)<\/tr>/gu,
    ),
  ].map((match) => ({
    recordId: match[1]!,
    cells: Object.fromEntries(
      [
        ...match[2]!.matchAll(
          /<td data-column-label="([^"]+)"[^>]*>([\s\S]*?)<\/td>/gu,
        ),
      ].map((cell) => [cell[1]!, cell[2]!.replace(/<[^>]+>/gu, '').trim()]),
    ),
  }));
  const tabs = Object.fromEntries(
    [
      ...html.matchAll(
        /data-view-id="[^"]+"[^>]*><span>([^<]*)<\/span><span class="list-view__count" data-view-count="(\d+)"/gu,
      ),
    ].map((match) => [match[1]!, Number(match[2]!)]),
  );
  const total = /data-list-total="(\d+)"/u.exec(html)?.[1];
  return {
    html,
    status: response.status,
    rows,
    tabs,
    total: total === undefined ? null : Number(total),
  };
}

/** Exact decimals as units of 10^-18, the scale every quantity column has. */
function units(value: unknown): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(String(value));
  assert.ok(match, `not an exact decimal: ${String(value)}`);
  const magnitude = BigInt(`${match[2]!}${(match[3] ?? '').padEnd(18, '0')}`);
  return match[1] ? -magnitude : magnitude;
}
function decimal(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(19, '0');
  const fraction = digits.slice(-18).replace(/0+$/u, '');
  return `${negative ? '-' : ''}${digits.slice(0, -18)}${fraction ? `.${fraction}` : ''}`;
}
const max = (left: bigint, right: bigint) => (left > right ? left : right);

/**
 * Independent figures: every stored row each figure reads, selected from
 * PostgreSQL directly in one company and added up here -- never through the
 * list statement under test. Returned per item, as the List shows them.
 */
async function truth(fixture: Fixture, company: string) {
  const target = await governedStorageTarget();
  const entity = (local: string) =>
    target.entities.find(
      (value) => value.entityId === `${ns}:entity.${local}`,
    )!;
  const relation = (local: string) =>
    target.relations.find(
      (value) => value.relationId === `${ns}:relation.${local}`,
    )!.relationColumn.physicalName;
  const read = async (local: string, columns: Record<string, string>) => {
    const definition = entity(local);
    const scoped = definition.legalEntity
      ? ` AND "${definition.legalEntity.column}" = $3`
      : '';
    return (
      await fixture.pool.query<Record<string, unknown>>(
        `SELECT record_id::text AS record_id, ${Object.entries(columns)
          .map(([name, column]) => `"${column}"::text AS "${name}"`)
          .join(', ')}
           FROM ${fulfillmentTable(definition)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND archived_at IS NULL${scoped}`,
        [
          fixture.app.runtime.identity.tenantId,
          fixture.app.runtime.identity.environmentId,
          ...(definition.legalEntity ? [company] : []),
        ],
      )
    ).rows;
  };
  const column = (local: string, name: string) =>
    fulfillmentColumn(entity(local), name);
  const items = await read('item', {
    sku: column('item', 'item_sku'),
    reorder_point: column('item', 'item_reorder_point'),
    reorder_up_to: column('item', 'item_reorder_up_to'),
  });
  const balances = await read('posted_stock_balance', {
    item: column('posted_stock_balance', 'posted_stock_balance_item_id'),
    quantity: column(
      'posted_stock_balance',
      'posted_stock_balance_posted_quantity',
    ),
  });
  const reservations = await read('reservation', {
    item: column('reservation', 'reservation_item_id'),
  });
  const remaining = await read('reservation_balance', {
    reservation: relation('reservation_balance_reservation'),
    quantity: column(
      'reservation_balance',
      'reservation_balance_remaining_quantity',
    ),
  });
  const documents = async (document: 'purchase_order' | 'sales_order') => ({
    headers: await read(document, {
      state: column(
        document,
        `derived_state_field.machine.${document}_lifecycle`,
      ),
      ...(document === 'purchase_order'
        ? {
            ordered: column(document, 'purchase_order_order_date'),
            supplier: column(document, 'purchase_order_supplier_party_id'),
          }
        : {}),
    }),
    lines: await read(`${document}_line`, {
      order: relation(`${document}_line_order`),
      item: column(`${document}_line`, `${document}_line_item_id`),
      quantity: column(`${document}_line`, `${document}_line_ordered_quantity`),
    }),
    done:
      document === 'purchase_order'
        ? await read('purchase_order_received', {
            line: relation('purchase_order_received_order_line'),
            quantity: column(
              'purchase_order_received',
              'purchase_order_received_received_quantity',
            ),
          })
        : await read('sales_order_shipped', {
            line: relation('sales_order_shipped_order_line'),
            quantity: column(
              'sales_order_shipped',
              'sales_order_shipped_shipped_quantity',
            ),
          }),
  });
  const purchases = await documents('purchase_order');
  const sales = await documents('sales_order');
  const parties = await read('party', {
    name: column('party', 'party_name'),
  });
  const state = (document: string, local: string) =>
    `${ns}:state.${document}_${local}`;
  // Per line, what is still open on an order in one of these states.
  const open = (
    documented: Awaited<ReturnType<typeof documents>>,
    item: string,
    states: readonly string[],
  ) =>
    documented.lines
      .filter((line) => line.item === item)
      .filter((line) =>
        documented.headers.some(
          (header) =>
            header.record_id === line.order &&
            states.includes(String(header.state)),
        ),
      )
      .reduce(
        (total, line) =>
          total +
          max(
            units(line.quantity) -
              documented.done
                .filter((entry) => entry.line === line.record_id)
                .reduce((sum, entry) => sum + units(entry.quantity), 0n),
            0n,
          ),
        0n,
      );
  return new Map(
    items.map((item) => {
      const id = String(item.record_id);
      const onHand = balances
        .filter((row) => row.item === id)
        .reduce((total, row) => total + units(row.quantity), 0n);
      const reserved = reservations
        .filter((row) => row.item === id)
        .reduce(
          (total, row) =>
            total +
            remaining
              .filter((entry) => entry.reservation === row.record_id)
              .reduce((sum, entry) => sum + units(entry.quantity), 0n),
          0n,
        );
      const incoming = open(purchases, id, [
        state('purchase_order', 'released'),
      ]);
      const demand = open(sales, id, [state('sales_order', 'released')]);
      const projected = onHand + incoming - demand;
      const point =
        item.reorder_point === null ? null : units(item.reorder_point);
      const upTo =
        item.reorder_up_to === null ? null : units(item.reorder_up_to);
      const latest = purchases.headers
        .filter(
          (header) =>
            [
              state('purchase_order', 'released'),
              state('purchase_order', 'closed'),
            ].includes(String(header.state)) &&
            purchases.lines.some(
              (line) => line.order === header.record_id && line.item === id,
            ),
        )
        .sort(
          (left, right) =>
            Date.parse(String(right.ordered)) -
              Date.parse(String(left.ordered)) ||
            (String(right.record_id) < String(left.record_id) ? -1 : 1),
        )[0];
      const supplier = latest
        ? parties.find((party) => party.record_id === latest.supplier)
        : undefined;
      return [
        id,
        {
          sku: String(item.sku),
          onHand: decimal(onHand),
          reserved: decimal(reserved),
          available: decimal(onHand - reserved),
          incoming: decimal(incoming),
          demand: decimal(demand),
          projected: decimal(projected),
          reorderPoint: point === null ? '—' : decimal(point),
          reorderUpTo: upTo === null ? '—' : decimal(upTo),
          // A missing point is never due; a missing level leaves no
          // suggestion.
          status:
            projected < 0n
              ? 'Shortage'
              : point !== null && projected <= point
                ? 'Reorder'
                : 'Healthy',
          due: point !== null && projected <= point,
          suggested: upTo === null ? '—' : decimal(max(upTo - projected, 0n)),
          lastSupplier: supplier === undefined ? '—' : String(supplier.name),
        },
      ] as const;
    }),
  );
}

async function setLevels(
  fixture: Fixture,
  itemId: string,
  values: Record<string, ImmutableJsonValue>,
) {
  const target = await governedStorageTarget();
  const item = target.entities.find(
    (value) => value.entityId === `${ns}:entity.item`,
  )!;
  const revision = (
    await fixture.pool.query<{ revision: number }>(
      `SELECT revision FROM ${fulfillmentTable(item)} WHERE record_id = $1`,
      [itemId],
    )
  ).rows[0]!.revision;
  const updated = await fixture.invoke('item_update', {
    recordId: itemId,
    expectedRevision: Number(revision),
    patch: Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        `${ns}:field.item_${name}`,
        value,
      ]),
    ),
  });
  assert.equal(updated.outcome, 'succeeded');
}

test(
  'REPLENISHMENT: Stock by item and the Buying worklist state the stored figures of one company, count each tab in the statement and refuse a revoked stock read by name',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const scenario = (await fixture.measure(
        'replenishment',
      )) as unknown as Scenario;
      await setLevels(fixture, scenario.notebook, {
        reorder_point: '20',
        reorder_up_to: '30',
        preferred_location_id: scenario.location,
        standard_cost_cad: '4.5',
      });
      const company = fixture.scope;
      const expected = await truth(fixture, company);

      // Stock by item: every item, each figure equal to the stored rows.
      const stock = await listPage(listUrl(fixture, STOCK, company));
      assert.equal(stock.status, 200);
      assert.equal(stock.total, expected.size);
      assert.deepEqual(
        new Map(
          stock.rows.map((row) => [
            row.recordId,
            [
              row.cells['On hand'],
              row.cells.Reserved,
              row.cells.Available,
              row.cells.Incoming,
              row.cells['Open demand'],
              row.cells.Projected,
              row.cells['Reorder point'],
              row.cells.Status,
            ],
          ]),
        ),
        new Map(
          [...expected].map(([id, value]) => [
            id,
            [
              value.onHand,
              value.reserved,
              value.available,
              value.incoming,
              value.demand,
              value.projected,
              value.reorderPoint,
              value.status,
            ],
          ]),
        ),
      );
      // The scenario as a person reads it: the notebook's 10 opening + 3
      // received - 1 shipped, 3 still reserved, 5 + 4 still to arrive, 5
      // still to ship (the drafts add nothing): projected 16, at or below
      // its reorder point of 20.
      const notebook = stock.rows.find(
        (row) => row.recordId === scenario.notebook,
      )!;
      assert.deepEqual(
        [
          notebook.cells.SKU,
          notebook.cells['On hand'],
          notebook.cells.Reserved,
          notebook.cells.Available,
          notebook.cells.Incoming,
          notebook.cells['Open demand'],
          notebook.cells.Projected,
          notebook.cells.Status,
        ],
        ['OFF-100', '12', '3', '9', '9', '5', '16', 'Reorder'],
      );
      assert.equal(
        stock.rows.find((row) => row.recordId === scenario.lamp)!.cells.Status,
        'Shortage',
      );
      // Each tab is the statement's own count of its band.
      const count = (status: string) =>
        [...expected.values()].filter((value) => value.status === status)
          .length;
      assert.deepEqual(stock.tabs, {
        All: expected.size,
        Shortage: count('Shortage'),
        Reorder: count('Reorder'),
      });
      assert.deepEqual(stock.tabs, { All: 4, Shortage: 1, Reorder: 2 });
      for (const status of ['Shortage', 'Reorder'] as const) {
        const tab = await listPage(
          listUrl(fixture, STOCK, company, {
            view: `${ns}:list_view.item_stock_list_${status.toLowerCase()}`,
          }),
        );
        assert.equal(tab.total, count(status));
        assert.deepEqual(
          tab.rows.map((row) => row.recordId).sort(),
          [...expected]
            .filter(([, value]) => value.status === status)
            .map(([id]) => id)
            .sort(),
        );
      }

      // The Buying worklist: what is due, back up to its level, from whom.
      const buying = await listPage(listUrl(fixture, BUYING, company));
      assert.equal(buying.status, 200);
      const due = [...expected].filter(([, value]) => value.due);
      assert.equal(buying.total, due.length);
      assert.deepEqual(buying.tabs, { 'To buy': 3 });
      assert.deepEqual(
        new Map(
          buying.rows.map((row) => [
            row.recordId,
            [
              row.cells.Projected,
              row.cells['Reorder up to'],
              row.cells.Suggested,
              row.cells['Last supplier'],
            ],
          ]),
        ),
        new Map(
          due.map(([id, value]) => [
            id,
            [
              value.projected,
              value.reorderUpTo,
              value.suggested,
              value.lastSupplier,
            ],
          ]),
        ),
      );
      assert.deepEqual(
        buying.rows.find((row) => row.recordId === scenario.notebook)!.cells
          .Suggested,
        '14',
      );
      // The newest released order names the supplier, not the draft.
      assert.equal(
        buying.rows.find((row) => row.recordId === scenario.notebook)!.cells[
          'Last supplier'
        ],
        'Summit Industrial',
      );

      // The export reads the same statement: every item, bands by label.
      const exported = await fetch(
        listUrl(fixture, STOCK, company, { export: 'csv' }),
      );
      assert.equal(exported.status, 200);
      const lines = (await exported.text())
        .replace(/^\uFEFF/u, '')
        .trimEnd()
        .split('\r\n');
      assert.equal(
        lines[0],
        'SKU,Item,Unit,On hand,Reserved,Available,Incoming,Open demand,Projected,Reorder point,Status',
      );
      assert.equal(lines.length - 1, expected.size);
      assert.ok(
        lines.includes('OFF-100,Field notebook,EA,12,3,9,9,5,16,20,Reorder'),
      );

      // A second company with its own stock of the notebook: neither List
      // counts it here, and its own List counts only it.
      const second = randomUUID();
      await fixture.pool.query(
        `SELECT platform.provision_inventory_scope($1,$2,$3,'REPL-B','REPL B','UTC','00:00:00',$4,1::smallint,'reject',0,'codeAndNarrative','codeOnly','codeAndNarrative','codeAndNarrative','codeAndNarrative',NULL,NULL,NULL,NULL,NULL)`,
        [
          fixture.app.runtime.identity.tenantId,
          fixture.app.runtime.identity.environmentId,
          second,
          fixture.app.runtime.releaseRoot,
        ],
      );
      const master = await fixture.invoke('legal_entity_create', {
        recordId: second,
        values: {
          [`${ns}:field.legal_entity_code`]: 'REPL-B',
          [`${ns}:field.legal_entity_name`]: 'Replenishment B company',
          [`${ns}:field.legal_entity_is_default`]: false,
          [`${ns}:field.legal_entity_status`]: `${ns}:option.legal_entity_status_active`,
        },
      });
      assert.equal(master.outcome, 'succeeded');
      const openingId = randomUUID();
      const now = new Date().toISOString();
      const opening = await fixture.invoke('inventory_transaction_create', {
        recordId: openingId,
        legalEntityId: second,
        values: Object.fromEntries(
          Object.entries({
            actor_id: 'replenishment-test',
            effective_at: now,
            reason_code: 'SETUP-B',
            reason_narrative: 'Second company stock',
            recorded_at: now,
            source_id: openingId,
            source_type: 'inventoryTransaction',
            state: `${ns}:option.inventory_transaction_state_draft`,
            type: `${ns}:option.inventory_transaction_type_adjustment`,
          }).map(([name, value]) => [
            `${ns}:field.inventory_transaction_${name}`,
            value,
          ]),
        ),
        relations: {},
      });
      assert.equal(opening.outcome, 'succeeded');
      const line = await fixture.invoke('inventory_transaction_line_create', {
        recordId: randomUUID(),
        legalEntityId: second,
        values: Object.fromEntries(
          Object.entries({
            from_location_id: null,
            to_location_id: scenario.location,
            item_id: scenario.notebook,
            line_number: '1',
            quantity: '7',
            unit_id: 'EA',
          }).map(([name, value]) => [
            `${ns}:field.inventory_transaction_line_${name}`,
            value,
          ]),
        ),
        relations: {
          [`${ns}:relation.inventory_transaction_line_transaction`]: openingId,
        },
      });
      assert.equal(line.outcome, 'succeeded');
      const posted = await fixture.invoke('inventory_transaction_post', {
        recordId: openingId,
        expectedRevision: opening.readBack!.revision,
      });
      assert.equal(posted.outcome, 'succeeded');
      const here = await listPage(listUrl(fixture, STOCK, company));
      assert.equal(
        here.rows.find((row) => row.recordId === scenario.notebook)!.cells[
          'On hand'
        ],
        '12',
      );
      const other = await listPage(listUrl(fixture, STOCK, second));
      assert.equal(other.status, 200);
      const otherTruth = await truth(fixture, second);
      assert.deepEqual(
        new Map(
          other.rows.map((row) => [
            row.recordId,
            [row.cells['On hand'], row.cells.Projected, row.cells.Status],
          ]),
        ),
        new Map(
          [...otherTruth].map(([id, value]) => [
            id,
            [value.onHand, value.projected, value.status],
          ]),
        ),
      );
      assert.equal(
        other.rows.find((row) => row.recordId === scenario.notebook)!.cells[
          'On hand'
        ],
        '7',
      );

      // Current authority: without the posted stock read the List is refused
      // by that query's name -- never shown as no stock.
      await fixture.measure(
        'deny',
        undefined,
        undefined,
        'posted_stock_balance_read',
      );
      const denied = await listPage(listUrl(fixture, STOCK, company));
      assert.equal(denied.rows.length, 0);
      assert.match(denied.html, /data-diagnostic-code="/u);
      const refused = await fixture.app.runtime.entry.run(
        { headers: {} },
        (issued) =>
          fixture.app.runtime.queryGateway
            .invoke(issued, {
              schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
              queryId: `${ns}:query.item_stock_list`,
              arguments: {
                includeArchived: false,
                [parameter('item_stock_list')]: company,
                list: {
                  cursor: null,
                  figures: {
                    sums: [
                      {
                        figureId: `${ns}:list_figure.item_stock_list_on_hand`,
                        rows: {
                          matchFieldId: `${ns}:field.posted_stock_balance_item_id`,
                          queryId: `${ns}:query.posted_stock_balance_list`,
                          quantityFieldId: `${ns}:field.posted_stock_balance_posted_quantity`,
                        },
                        sum: 'rows',
                      },
                    ],
                  },
                  matchMode: 'substring',
                  pageSize: 10,
                  relationLabels: [],
                  schemaVersion: SHARED_LIST_QUERY_VERSION,
                  search: '',
                  sort: [],
                },
              },
            })
            .then(
              () => null,
              (error: unknown) => error,
            ),
      );
      assert.ok(refused instanceof SemanticQueryPolicyDeniedError);
      assert.equal(refused.queryId, `${ns}:query.posted_stock_balance_list`);
      await fixture.measure(
        'allow',
        undefined,
        undefined,
        'posted_stock_balance_read',
      );
      const restored = await listPage(listUrl(fixture, STOCK, company));
      assert.equal(restored.total, expected.size);
      assert.match(
        restored.html,
        new RegExp(escaped(`data-record-id="${scenario.notebook}"`), 'u'),
      );
    });
  },
);
