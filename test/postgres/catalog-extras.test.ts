import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { ModuleRuntimeInterpreterError } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
  type SemanticRecordDto,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  requireSharedListResult,
  SHARED_LIST_QUERY_VERSION,
} from '../../packages/runtime/src/list-behavior/index.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

/**
 * CATALOG-EXTRAS on real PostgreSQL, through the served pages and the real
 * gateway: an item found by an alias in the Items List and a picker's
 * search, an alias unique across the business and keeping its item from
 * being archived, a duplicate merged by retiring it, and Stock by item and
 * the Buying worklist judging the company rule and the inventory policy --
 * every figure checked against the stored rows, never against the list
 * statement under test.
 */
const ns = 'northstar.app';
const STOCK = `${ns}:surface.item_stock_list`;
const BUYING = `${ns}:surface.item_buying_list`;
const ITEMS = `${ns}:surface.item_list`;
const ALIAS_SEARCH = [
  {
    fieldId: `${ns}:field.item_alias_value`,
    queryId: `${ns}:query.item_alias_list`,
    relationId: `${ns}:relation.item_alias_item`,
  },
];
const parameter = (list: string) =>
  `${ns}:parameter.${list}_legal_entity_scope`;

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

interface Scenario {
  readonly notebook: string;
  readonly pens: string;
  readonly labels: string;
  readonly duplicate: string;
  readonly barcode: string;
  readonly supplierCode: string;
}

function pageUrl(
  fixture: Fixture,
  surfaceId: string,
  company: string | null,
  extra: Record<string, string> = {},
): string {
  const url = new URL(fixture.app.baseUrl);
  url.searchParams.set('surface', surfaceId);
  if (company)
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
  return { html, status: response.status, rows, tabs };
}

/** Exact decimals as units of 10^-18, the scale every level is kept at. */
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
 * Independent figures, per item, in one company: every stored row selected
 * from PostgreSQL directly and added up here. The reorder point is the
 * item's own, or under the company rule the company's percentage of its
 * level (half away from zero at 18 places); a non-stocked item is "Not
 * stocked" before any range.
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
    policy: column('item', 'item_inventory_policy'),
    rule: column('item', 'item_reorder_rule'),
  });
  const companies = await read('legal_entity', {
    percent: column('legal_entity', 'legal_entity_reorder_point_percent'),
  });
  const percentText = companies.find((row) => row.record_id === company)
    ?.percent as string | null | undefined;
  const balances = await read('posted_stock_balance', {
    item: column('posted_stock_balance', 'posted_stock_balance_item_id'),
    quantity: column(
      'posted_stock_balance',
      'posted_stock_balance_posted_quantity',
    ),
  });
  const documents = async (document: 'purchase_order' | 'sales_order') => ({
    headers: await read(document, {
      state: column(
        document,
        `derived_state_field.machine.${document}_lifecycle`,
      ),
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
  const open = (
    documented: Awaited<ReturnType<typeof documents>>,
    item: string,
    state: string,
  ) =>
    documented.lines
      .filter((line) => line.item === item)
      .filter((line) =>
        documented.headers.some(
          (header) => header.record_id === line.order && header.state === state,
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
  // percent / 100 of a level, at 18 places, half away from zero.
  const share = (level: bigint, percent: bigint) => {
    const scaled = level * percent;
    const denominator = 100n * 10n ** 18n;
    const quotient = scaled / denominator;
    const remainder = scaled % denominator;
    const twice = (remainder < 0n ? -remainder : remainder) * 2n;
    return twice >= denominator
      ? quotient + (scaled < 0n ? -1n : 1n)
      : quotient;
  };
  return new Map(
    items.map((item) => {
      const id = String(item.record_id);
      const onHand = balances
        .filter((row) => row.item === id)
        .reduce((total, row) => total + units(row.quantity), 0n);
      const incoming = open(
        purchases,
        id,
        `${ns}:state.purchase_order_released`,
      );
      const demand = open(sales, id, `${ns}:state.sales_order_released`);
      const projected = onHand + incoming - demand;
      const upTo =
        item.reorder_up_to === null ? null : units(item.reorder_up_to);
      const point =
        item.rule === `${ns}:option.item_reorder_rule_company`
          ? upTo === null || percentText === null || percentText === undefined
            ? null
            : share(upTo, units(percentText))
          : item.reorder_point === null
            ? null
            : units(item.reorder_point);
      const stocked =
        item.policy !== `${ns}:option.item_inventory_policy_non_stocked`;
      const status = !stocked
        ? 'Not stocked'
        : projected < 0n
          ? 'Shortage'
          : point !== null && projected <= point
            ? 'Reorder'
            : 'Healthy';
      return [
        id,
        {
          sku: String(item.sku),
          projected: decimal(projected),
          reorderPoint: point === null ? '—' : decimal(point),
          status,
          due: stocked && point !== null && projected <= point,
          suggested: upTo === null ? '—' : decimal(max(upTo - projected, 0n)),
        },
      ] as const;
    }),
  );
}

async function revisionOf(fixture: Fixture, local: string, recordId: string) {
  const target = await governedStorageTarget();
  const definition = target.entities.find(
    (value) => value.entityId === `${ns}:entity.${local}`,
  )!;
  return Number(
    (
      await fixture.pool.query<{ revision: number }>(
        `SELECT revision FROM ${fulfillmentTable(definition)} WHERE record_id = $1`,
        [recordId],
      )
    ).rows[0]!.revision,
  );
}

async function update(
  fixture: Fixture,
  local: string,
  recordId: string,
  values: Record<string, ImmutableJsonValue>,
) {
  const updated = await fixture.invoke(`${local}_update`, {
    recordId,
    expectedRevision: await revisionOf(fixture, local, recordId),
    patch: Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        `${ns}:field.${local}_${name}`,
        value,
      ]),
    ),
  });
  assert.equal(updated.outcome, 'succeeded');
}

/** A picker's own search: the item list query, one page, through the gateway. */
async function pickerSearch(
  fixture: Fixture,
  search: string,
  searchChildren?: typeof ALIAS_SEARCH,
): Promise<readonly SemanticRecordDto[]> {
  return fixture.app.runtime.entry.run(
    { headers: {} },
    async (view) =>
      requireSharedListResult<SemanticRecordDto>(
        await fixture.app.runtime.queryGateway.invoke(view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId: `${ns}:query.item_list`,
          arguments: {
            includeArchived: false,
            list: {
              cursor: null,
              matchMode: 'substring',
              pageSize: 20,
              relationLabels: [],
              schemaVersion: SHARED_LIST_QUERY_VERSION,
              search,
              ...(searchChildren ? { searchChildren } : {}),
              sort: [],
            },
          },
        }),
      ).records,
  );
}

function refusedBy(code: string, subjectId: string) {
  return (error: unknown) =>
    error instanceof ModuleRuntimeInterpreterError &&
    error.code === code &&
    error.subjectId === subjectId;
}

test(
  'CATALOG-EXTRAS: an alias finds its item, stays unique and keeps its item from being archived, a duplicate merges by retiring it, and the stock Lists judge the company rule and the inventory policy',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      await fixture.measure('replenishment');
      await update(fixture, 'item', fixture.item, {
        reorder_point: '20',
        reorder_up_to: '30',
      });
      const scenario = (await fixture.measure(
        'catalog_extras',
      )) as unknown as Scenario;
      const company = fixture.scope;

      // The Items List finds an item by an alias, whole or in part, in any
      // case -- and by its own SKU and name as before.
      const items = async (q: string) =>
        (await listPage(pageUrl(fixture, ITEMS, null, { q }))).rows.map(
          (row) => row.recordId,
        );
      for (const term of ['0012345678905', 'alp-nb', 'ALP-NB-80', 'OFF-100'])
        assert.deepEqual(
          (await items(term)).filter((value) => value !== scenario.duplicate),
          [scenario.notebook],
          term,
        );
      assert.deepEqual(await items('OFF-100-DUP'), [scenario.duplicate]);
      // A picker's search finds it the same way, and only with the children
      // it declares: without them the barcode names nothing.
      assert.deepEqual(
        (await pickerSearch(fixture, '0012345678905', ALIAS_SEARCH)).map(
          (record) => record.recordId,
        ),
        [scenario.notebook],
      );
      assert.deepEqual(await pickerSearch(fixture, '0012345678905'), []);

      // An alias names one item across the business, whatever its case.
      await assert.rejects(
        fixture.invoke('item_alias_create', {
          recordId: randomUUID(),
          values: {
            [`${ns}:field.item_alias_value`]: 'alp-nb-80',
            [`${ns}:field.item_alias_kind`]: `${ns}:option.item_alias_kind_supplier_code`,
          },
          relations: { [`${ns}:relation.item_alias_item`]: scenario.pens },
        }),
        refusedBy('MODULE_UNIQUE_VIOLATION', `${ns}:field.item_alias_value`),
      );
      // An item is archived only once no active alias names it.
      await assert.rejects(
        fixture.invoke('item_archive', {
          recordId: scenario.notebook,
          expectedRevision: await revisionOf(
            fixture,
            'item',
            scenario.notebook,
          ),
        }),
        refusedBy(
          'MODULE_ARCHIVE_RESTRICTED',
          `${ns}:relation.item_alias_item`,
        ),
      );
      // A removed alias finds nothing, and its value is free again.
      const removed = await fixture.invoke('item_alias_archive', {
        recordId: scenario.supplierCode,
        expectedRevision: await revisionOf(
          fixture,
          'item_alias',
          scenario.supplierCode,
        ),
      });
      assert.equal(removed.outcome, 'succeeded');
      assert.deepEqual(await items('ALP-NB'), []);
      const reused = await fixture.invoke('item_alias_create', {
        recordId: randomUUID(),
        values: {
          [`${ns}:field.item_alias_value`]: 'ALP-NB-80',
          [`${ns}:field.item_alias_kind`]: `${ns}:option.item_alias_kind_supplier_code`,
        },
        relations: { [`${ns}:relation.item_alias_item`]: scenario.pens },
      });
      assert.equal(reused.outcome, 'succeeded');
      assert.deepEqual(await items('ALP-NB'), [scenario.pens]);

      // Stock by item and the Buying worklist in the company: every figure
      // the stored rows give. The pens follow the company rule (40% of 50 =
      // 20, with nothing on hand: Reorder); the labels are not stocked.
      const expected = await truth(fixture, company);
      const stock = await listPage(pageUrl(fixture, STOCK, company));
      assert.equal(stock.status, 200);
      assert.deepEqual(
        new Map(
          stock.rows.map((row) => [
            row.recordId,
            [row.cells.Projected, row.cells['Reorder point'], row.cells.Status],
          ]),
        ),
        new Map(
          [...expected].map(([id, value]) => [
            id,
            [value.projected, value.reorderPoint, value.status],
          ]),
        ),
      );
      const cells = (recordId: string) =>
        stock.rows.find((row) => row.recordId === recordId)!.cells;
      assert.deepEqual(
        [cells(scenario.pens)['Reorder point'], cells(scenario.pens).Status],
        ['20', 'Reorder'],
      );
      assert.equal(cells(scenario.labels).Status, 'Not stocked');
      const count = (status: string) =>
        [...expected.values()].filter((value) => value.status === status)
          .length;
      assert.deepEqual(stock.tabs, {
        All: expected.size,
        Shortage: count('Shortage'),
        Reorder: count('Reorder'),
      });
      for (const status of ['Shortage', 'Reorder'] as const) {
        const tab = await listPage(
          pageUrl(fixture, STOCK, company, {
            view: `${ns}:list_view.item_stock_list_${status.toLowerCase()}`,
          }),
        );
        assert.deepEqual(
          tab.rows.map((row) => row.recordId).sort(),
          [...expected]
            .filter(([, value]) => value.status === status)
            .map(([id]) => id)
            .sort(),
        );
        assert.ok(
          !tab.rows.some((row) => row.recordId === scenario.labels),
          `${status} never keeps a non-stocked item`,
        );
      }
      const buying = await listPage(pageUrl(fixture, BUYING, company));
      const due = [...expected].filter(([, value]) => value.due);
      assert.deepEqual(
        new Map(
          buying.rows.map((row) => [
            row.recordId,
            [row.cells['Reorder point'], row.cells.Suggested],
          ]),
        ),
        new Map(
          due.map(([id, value]) => [id, [value.reorderPoint, value.suggested]]),
        ),
      );
      assert.ok(due.some(([id]) => id === scenario.pens));
      assert.ok(!buying.rows.some((row) => row.recordId === scenario.labels));
      assert.equal(
        buying.rows.find((row) => row.recordId === scenario.pens)!.cells
          .Suggested,
        '50',
      );

      // Another company has its own rule: unset, the pens have no reorder
      // point there; at 10% they reorder at 5. The item is the same record.
      const second = randomUUID();
      await fixture.pool.query(
        `SELECT platform.provision_inventory_scope($1,$2,$3,'CAT-B','CAT B','UTC','00:00:00',$4,1::smallint,'reject',0,'codeAndNarrative','codeOnly','codeAndNarrative','codeAndNarrative','codeAndNarrative',NULL,NULL,NULL,NULL,NULL)`,
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
          [`${ns}:field.legal_entity_code`]: 'CAT-B',
          [`${ns}:field.legal_entity_name`]: 'Catalog B company',
          [`${ns}:field.legal_entity_is_default`]: false,
          [`${ns}:field.legal_entity_status`]: `${ns}:option.legal_entity_status_active`,
        },
      });
      assert.equal(master.outcome, 'succeeded');
      const pensIn = async (legalEntity: string) =>
        (await listPage(pageUrl(fixture, STOCK, legalEntity))).rows.find(
          (row) => row.recordId === scenario.pens,
        )!.cells;
      assert.deepEqual(
        [
          (await pensIn(second))['Reorder point'],
          (await pensIn(second)).Status,
        ],
        ['—', 'Healthy'],
      );
      await update(fixture, 'legal_entity', second, {
        reorder_point_percent: '10',
      });
      assert.deepEqual(
        [
          (await pensIn(second))['Reorder point'],
          (await pensIn(second)).Status,
        ],
        ['5', 'Reorder'],
      );
      assert.equal((await pensIn(company))['Reorder point'], '20');

      // Merging the duplicate: its SKU becomes the notebook's merged alias,
      // then it is archived; nothing it posted moves.
      const merged = await fixture.invoke('item_alias_create', {
        recordId: randomUUID(),
        values: {
          [`${ns}:field.item_alias_value`]: 'OFF-100-DUP',
          [`${ns}:field.item_alias_kind`]: `${ns}:option.item_alias_kind_merged_sku`,
        },
        relations: { [`${ns}:relation.item_alias_item`]: scenario.notebook },
      });
      assert.equal(merged.outcome, 'succeeded');
      const retired = await fixture.invoke('item_archive', {
        recordId: scenario.duplicate,
        expectedRevision: await revisionOf(fixture, 'item', scenario.duplicate),
      });
      assert.equal(retired.outcome, 'succeeded');
      assert.deepEqual(await items('OFF-100-DUP'), [scenario.notebook]);
      assert.ok(
        !(await listPage(pageUrl(fixture, STOCK, company))).rows.some(
          (row) => row.recordId === scenario.duplicate,
        ),
      );

      // Current authority: without the alias read, the search through them
      // is refused by that query's name -- never answered without them --
      // while the unsearched List, which reads no alias, still serves.
      await fixture.measure('deny', undefined, undefined, 'item_alias_read');
      const unsearched = await listPage(pageUrl(fixture, ITEMS, null));
      assert.equal(unsearched.status, 200);
      assert.ok(
        unsearched.rows.some((row) => row.recordId === scenario.notebook),
      );
      const refused = await pickerSearch(
        fixture,
        '0012345678905',
        ALIAS_SEARCH,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(refused instanceof SemanticQueryPolicyDeniedError);
      assert.equal(refused.queryId, `${ns}:query.item_alias_list`);
      const deniedPage = await listPage(
        pageUrl(fixture, ITEMS, null, { q: '0012345678905' }),
      );
      assert.equal(deniedPage.rows.length, 0);
      assert.match(deniedPage.html, /data-diagnostic-code="/u);
      await fixture.measure('allow', undefined, undefined, 'item_alias_read');
      assert.deepEqual(await items('0012345678905'), [scenario.notebook]);
    });
  },
);
