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
const ITEM_PAGE = `${ns}:surface.item_detail`;
/** The item page carries its company under the Posted stock List's operand. */
const COMPANY = `${ns}:parameter.posted_stock_balance_list_legal_entity_scope`;

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

interface Scenario {
  readonly itemId: string;
  readonly main: string;
  readonly overflow: string;
  readonly shipmentId: string;
}

function itemUrl(fixture: Fixture, itemId: string, company?: string): string {
  const url = new URL(fixture.app.baseUrl);
  url.searchParams.set('surface', ITEM_PAGE);
  url.searchParams.set('record', itemId);
  if (company) url.searchParams.set(COMPANY, company);
  return url.href;
}

const escaped = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The served page, read the way a person reads it: sections, rows, cells. */
async function itemPage(url: string) {
  const response = await fetch(url, { redirect: 'manual' });
  const html = await response.text();
  const section = (local: string) =>
    new RegExp(
      `<section id="${escaped(`${ns}:dataset.item_${local}`)}"[\\s\\S]*?</section>`,
      'u',
    ).exec(html)?.[0] ?? '';
  const rows = (local: string) =>
    [
      ...section(local).matchAll(
        /<tr data-compact-card="true" data-presented-row="true" data-record-id="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gu,
      ),
    ].map((match) => ({
      recordId: match[1]!,
      cells: Object.fromEntries(
        [
          ...match[2]!.matchAll(
            /<td data-column-label="([^"]+)"[^>]*>([\s\S]*?)<\/td>/gu,
          ),
        ].map((cell) => [cell[1]!, cell[2]!.replace(/<[^>]+>/gu, '')]),
      ),
    }));
  return {
    html,
    status: response.status,
    location: response.headers.get('location'),
    section,
    stock: rows('stock'),
    movements: rows('movements'),
  };
}

/** A stored exact decimal as the page shows it: no trailing zeros. */
function shown(value: unknown): string {
  const text = String(value);
  return /^-?\d+\.\d+$/u.test(text)
    ? text.replace(/(\.\d*?[1-9])0+$|\.0+$/u, '$1')
    : text;
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

/**
 * Independent facts: every balance, reservation balance and movement of the
 * item in one company, read from PostgreSQL directly and added up here, never
 * through the read model or the list statement under test.
 */
async function stored(fixture: Fixture, company: string, itemId: string) {
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
        `SELECT record_id::text AS record_id, ${columns}
           FROM ${fulfillmentTable(entity(local))}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${entity(local).legalEntity!.column} = $3
            AND archived_at IS NULL`,
        [
          fixture.app.runtime.identity.tenantId,
          fixture.app.runtime.identity.environmentId,
          company,
        ],
      )
    ).rows;
  const column = (local: string, name: string) =>
    fulfillmentColumn(entity(local), name);
  const balances = (
    await read(
      'posted_stock_balance',
      `${column('posted_stock_balance', 'posted_stock_balance_item_id')} AS item,
       ${column('posted_stock_balance', 'posted_stock_balance_location_id')} AS location,
       ${column('posted_stock_balance', 'posted_stock_balance_posted_quantity')}::text AS quantity`,
    )
  ).filter((row) => row.item === itemId);
  const reservations = await read(
    'reservation',
    `${column('reservation', 'reservation_item_id')} AS item,
     ${column('reservation', 'reservation_location_id')} AS location`,
  );
  const remaining = await read(
    'reservation_balance',
    `${relation('reservation_balance_reservation')}::text AS reservation,
     ${column('reservation_balance', 'reservation_balance_remaining_quantity')}::text AS quantity`,
  );
  const movements = (
    await read(
      'inventory_movement',
      `${column('inventory_movement', 'inventory_movement_item_id')} AS item,
       ${column('inventory_movement', 'inventory_movement_location_id')} AS location,
       ${column('inventory_movement', 'inventory_movement_effective_at')} AS effective,
       ${column('inventory_movement', 'inventory_movement_recorded_at')} AS recorded,
       ${column('inventory_movement', 'inventory_movement_quantity_delta')}::text AS delta,
       ${column('inventory_movement', 'inventory_movement_source_type')} AS source,
       ${column('inventory_movement', 'inventory_movement_reason_code')} AS reason`,
    )
  )
    .filter((row) => row.item === itemId)
    .sort(
      (left, right) =>
        (right.effective as Date).getTime() -
          (left.effective as Date).getTime() ||
        (right.recorded as Date).getTime() - (left.recorded as Date).getTime(),
    );
  return {
    stock: balances.map((row) => {
      const reserved = reservations
        .filter(
          (entry) => entry.item === itemId && entry.location === row.location,
        )
        .reduce(
          (total, entry) =>
            total +
            remaining
              .filter((value) => value.reservation === entry.record_id)
              .reduce((sum, value) => sum + units(value.quantity), 0n),
          0n,
        );
      return {
        recordId: String(row.record_id),
        location: String(row.location),
        onHand: shown(row.quantity),
        reserved: decimal(reserved),
        available: decimal(units(row.quantity) - reserved),
      };
    }),
    movements: movements.map((row) => ({
      recordId: String(row.record_id),
      location: String(row.location),
      change: shown(row.delta),
      source: String(row.source),
      reason: row.reason === null ? '—' : String(row.reason),
    })),
  };
}

test(
  'INVENTORY-PARITY: the item page shows each location of one company with on hand, reserved and available, and its movements newest first',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const scenario = (await fixture.measure(
        'item_stock',
      )) as unknown as Scenario;
      const item = scenario.itemId;
      const codes: Record<string, string> = {
        [scenario.main]: 'CAL-WH',
        [scenario.overflow]: 'VAN-WH',
      };

      // One authorized company: the page picks it, keeping the item.
      const entered = await itemPage(itemUrl(fixture, item));
      assert.equal(entered.status, 303);
      const redirected = new URL(entered.location!, fixture.app.baseUrl);
      assert.equal(redirected.searchParams.get(COMPANY), fixture.scope);
      assert.equal(redirected.searchParams.get('record'), item);
      assert.equal(redirected.searchParams.get('surface'), ITEM_PAGE);

      // Two locations: on hand, what the reservation still holds after the
      // shipment, and what is left -- equal to the stored facts.
      const page = await itemPage(redirected.href);
      assert.equal(page.status, 200);
      assert.match(page.html, /<h1>Field notebook<\/h1>/u);
      const truth = await stored(fixture, fixture.scope, item);
      assert.deepEqual(
        page.stock.map((row) => ({
          recordId: row.recordId,
          location: row.cells.Location,
          onHand: row.cells['On hand'],
          reserved: row.cells.Reserved,
          available: row.cells.Available,
        })),
        [...truth.stock]
          .sort((left, right) =>
            Number(units(right.onHand) - units(left.onHand)),
          )
          .map((row) => ({ ...row, location: codes[row.location] })),
      );
      assert.deepEqual(
        page.stock.map((row) => [
          row.cells.Location,
          row.cells['On hand'],
          row.cells.Reserved,
          row.cells.Available,
          row.cells.Unit,
        ]),
        [
          ['CAL-WH', '13', '1', '12', 'EA'],
          ['VAN-WH', '6', '0', '6', 'EA'],
        ],
      );
      // Every movement of the item in this company, newest first: the
      // shipment, the receipt, the overflow stock and the opening stock.
      assert.deepEqual(
        page.movements.map((row) => ({
          recordId: row.recordId,
          location: row.cells.Location,
          change: row.cells.Change,
          source: row.cells.Source,
          reason: row.cells.Reason,
        })),
        truth.movements.map((row) => ({
          ...row,
          location: codes[row.location],
        })),
      );
      assert.deepEqual(
        page.movements.map((row) => [
          row.cells.Role,
          row.cells.Location,
          row.cells.Change,
          row.cells.Source,
        ]),
        [
          ['shipment', 'CAL-WH', '-2', 'shipment'],
          ['receipt', 'CAL-WH', '5', 'goodsReceipt'],
          ['adjustment', 'VAN-WH', '6', 'inventoryTransaction'],
          ['adjustment', 'CAL-WH', '10', 'inventoryTransaction'],
        ],
      );

      // A second company with its own stock of the same item at CAL-WH.
      const second = randomUUID();
      await fixture.pool.query(
        `SELECT platform.provision_inventory_scope($1,$2,$3,'ITEM-B','ITEM B','UTC','00:00:00',$4,1::smallint,'reject',0,'codeAndNarrative','codeOnly','codeAndNarrative','codeAndNarrative','codeAndNarrative',NULL,NULL,NULL,NULL,NULL)`,
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
          [`${ns}:field.legal_entity_code`]: 'ITEM-B',
          [`${ns}:field.legal_entity_name`]: 'Item B company',
          [`${ns}:field.legal_entity_is_default`]: false,
          [`${ns}:field.legal_entity_status`]: `${ns}:option.legal_entity_status_active`,
        },
      });
      assert.equal(master.outcome, 'succeeded');
      const createIn = async (
        local: string,
        values: Record<string, ImmutableJsonValue>,
        relations: Record<string, string> = {},
        recordId: string = randomUUID(),
      ) => {
        const created = await fixture.invoke(`${local}_create`, {
          recordId,
          legalEntityId: second,
          values: Object.fromEntries(
            Object.entries(values).map(([name, value]) => [
              `${ns}:field.${local}_${name}`,
              value,
            ]),
          ),
          relations: Object.fromEntries(
            Object.entries(relations).map(([name, value]) => [
              `${ns}:relation.${local}_${name}`,
              value,
            ]),
          ),
        });
        assert.equal(created.outcome, 'succeeded');
        return created.readBack!;
      };
      const now = new Date().toISOString();
      // A stock document as the editor saves one: numbered by the server, a
      // draft naming itself as its posting source.
      const openingId = randomUUID();
      const opening = await createIn(
        'inventory_transaction',
        {
          effective_at: now,
          reason_code: 'SETUP-B',
          reason_narrative: 'Second company stock',
          source_id: openingId,
          source_type: 'inventoryTransaction',
          state: `${ns}:option.inventory_transaction_state_draft`,
          type: `${ns}:option.inventory_transaction_type_adjustment`,
        },
        {},
        openingId,
      );
      await createIn(
        'inventory_transaction_line',
        {
          from_location_id: null,
          to_location_id: scenario.main,
          item_id: item,
          line_number: '1',
          quantity: '7',
          unit_id: 'EA',
        },
        { transaction: opening.recordId },
      );
      const posted = await fixture.invoke('inventory_transaction_post', {
        recordId: opening.recordId,
        expectedRevision: opening.revision,
      });
      assert.equal(posted.outcome, 'succeeded');

      // Each company shows its own rows and nothing of the other's.
      const other = await itemPage(itemUrl(fixture, item, second));
      assert.equal(other.status, 200);
      const otherTruth = await stored(fixture, second, item);
      assert.deepEqual(
        other.stock.map((row) => [
          row.recordId,
          row.cells.Location,
          row.cells['On hand'],
          row.cells.Reserved,
          row.cells.Available,
        ]),
        otherTruth.stock.map((row) => [
          row.recordId,
          codes[row.location],
          row.onHand,
          row.reserved,
          row.available,
        ]),
      );
      assert.deepEqual(
        other.stock.map((row) => row.cells['On hand']),
        ['7'],
      );
      assert.deepEqual(
        other.movements.map((row) => [row.recordId, row.cells.Reason]),
        otherTruth.movements.map((row) => [row.recordId, row.reason]),
      );
      assert.equal(other.movements.length, 1);
      const own = await itemPage(itemUrl(fixture, item, fixture.scope));
      assert.deepEqual(
        own.stock.map((row) => row.cells['On hand']),
        ['13', '6'],
      );
      assert.deepEqual(
        own.movements.map((row) => row.recordId),
        truth.movements.map((row) => row.recordId),
      );
      // The company bar offers both on this same item.
      for (const company of [fixture.scope, second])
        assert.match(
          own.html,
          new RegExp(
            `href="/\\?record=${item}&surface=${escaped(encodeURIComponent(ITEM_PAGE))}&${escaped(encodeURIComponent(COMPANY))}=${company}" data-legal-entity-id="${company}"`,
            'u',
          ),
        );
      // Without a choice, the last company chosen is the default.
      const remembered = await itemPage(itemUrl(fixture, item));
      assert.equal(remembered.status, 303);
      assert.equal(
        new URL(remembered.location!, fixture.app.baseUrl).searchParams.get(
          COMPANY,
        ),
        fixture.scope,
      );

      // Current authority: without reservation read, the stock is refused by
      // the reservation query's name -- never shown as unreserved -- while
      // the movements still show.
      await fixture.measure('deny', undefined, undefined, 'reservation_read');
      const denied = await itemPage(itemUrl(fixture, item, fixture.scope));
      assert.equal(denied.status, 200);
      assert.match(
        denied.section('stock'),
        /data-resolution="failed"[\s\S]*data-message="COMPOSITION_CHILD_FAILED"/u,
      );
      assert.equal(denied.stock.length, 0);
      assert.equal(denied.movements.length, truth.movements.length);
      const refused = await fixture.app.runtime.entry.run(
        { headers: {} },
        (issued) =>
          fixture.app.runtime.queryGateway
            .invoke(issued, {
              schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
              queryId: `${ns}:query.item_stock_positions`,
              arguments: {
                includeArchived: false,
                [`${ns}:parameter.item_stock_positions_legal_entity_scope`]:
                  fixture.scope,
                list: {
                  cursor: null,
                  fieldFilters: [
                    {
                      fieldId: `${ns}:field.posted_stock_balance_item_id`,
                      value: item,
                    },
                  ],
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
      assert.equal(refused.queryId, `${ns}:query.workspace_stock_reservations`);
      await fixture.measure('allow', undefined, undefined, 'reservation_read');
      const restored = await itemPage(itemUrl(fixture, item, fixture.scope));
      assert.deepEqual(
        restored.stock.map((row) => row.cells.Reserved),
        ['1', '0'],
      );
    });
  },
);
