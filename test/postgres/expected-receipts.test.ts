import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  SHARED_LIST_QUERY_VERSION,
  SharedListContractError,
} from '../../packages/runtime/src/list-behavior/index.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';
const LIST = `${ns}:surface.expected_receipt_list`;
const SCOPE = `${ns}:parameter.expected_receipt_list_legal_entity_scope`;
const RELEASED = `${ns}:state.purchase_order_released`;
const view = (local: string) =>
  `${ns}:list_view.expected_receipt_list_${local}`;
const column = (local: string) =>
  `${ns}:list_column.expected_receipt_list_${local}`;
const output = (local: string) =>
  `${ns}:list_output.expected_receipt_list_${local}`;
const DAY = 86_400_000;
/** Open released orders beyond one page of 50, so paging crosses a boundary. */
const VOLUME = 52;

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

function listUrl(
  fixture: Fixture,
  parameters: Record<string, string> = {},
  surface = LIST,
  scope = SCOPE,
): string {
  const url = new URL(fixture.app.baseUrl);
  url.searchParams.set('surface', surface);
  url.searchParams.set(scope, fixture.scope);
  for (const [name, value] of Object.entries(parameters))
    url.searchParams.set(name, value);
  return url.href;
}

/** The served page, read the way a person reads it: tabs, rows, figures. */
async function page(url: string) {
  const response = await fetch(url, { redirect: 'manual' });
  const html = await response.text();
  const rows = [
    ...html.matchAll(
      /<tr data-compact-card="true" data-record-id="([^"]+)">([\s\S]*?)<\/tr>/gu,
    ),
  ].map((match) => {
    const cell = (local: string) =>
      new RegExp(
        `data-column-id="${column(local)}">([\\s\\S]*?)</td>`,
        'u',
      ).exec(match[2]!)?.[1] ?? '';
    return {
      recordId: match[1]!,
      number: />([^<]+)<\/a>/u.exec(cell('number'))?.[1],
      ordered: cell('ordered'),
      received: cell('received'),
      open: cell('open'),
      late: /data-overdue-days="(\d+)"/u.exec(cell('expected_date'))?.[1],
    };
  });
  return {
    html,
    status: response.status,
    total: Number(/data-list-total="(\d+)"/u.exec(html)?.[1] ?? Number.NaN),
    anchor: /data-list-anchor="([^"]+)"/u.exec(html)?.[1],
    counts: Object.fromEntries(
      [
        ...html.matchAll(
          /data-view-id="([^"]+)"[^>]*>(?:<span>[^<]*<\/span>)<span class="list-view__count" data-view-count="(\d+)"/gu,
        ),
      ].map((match) => [match[1]!, Number(match[2]!)]),
    ),
    pageStatus: /data-list-page="(\d+)" data-list-page-count="(\d+)"/u.exec(
      html,
    ),
    rows,
  };
}

/** Exact decimals as units of 10^-18, the scale every quantity column has. */
const SCALE = 18;
function units(value: unknown): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(String(value));
  assert.ok(match, `not an exact decimal: ${String(value)}`);
  const fraction = (match[3] ?? '').padEnd(SCALE, '0');
  assert.equal(fraction.length, SCALE);
  const magnitude = BigInt(`${match[2]!}${fraction}`);
  return match[1] ? -magnitude : magnitude;
}
function decimal(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(SCALE + 1, '0');
  const whole = digits.slice(0, -SCALE);
  const fraction = digits.slice(-SCALE).replace(/0+$/u, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Independent facts: every order, line and received row read from PostgreSQL
 * directly and added up here, never through the list statement under test.
 */
async function stored(fixture: Fixture) {
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
  const order = entity('purchase_order');
  const line = entity('purchase_order_line');
  const received = entity('purchase_order_received');
  const orders = await read(
    'purchase_order',
    `${fulfillmentColumn(order, 'purchase_order_number')} AS number,
     ${fulfillmentColumn(order, 'derived_state_field.machine.purchase_order_lifecycle')} AS state,
     ${fulfillmentColumn(order, 'purchase_order_expected_date')} AS expected`,
  );
  const lines = await read(
    'purchase_order_line',
    `${relation('purchase_order_line_order')}::text AS order_id,
     ${fulfillmentColumn(line, 'purchase_order_line_ordered_quantity')}::text AS quantity`,
  );
  const receipts = await read(
    'purchase_order_received',
    `${relation('purchase_order_received_order_line')}::text AS line_id,
     ${fulfillmentColumn(received, 'purchase_order_received_received_quantity')}::text AS quantity`,
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
      const done = receipts
        .filter(
          (entry) =>
            entry.archived_at === null &&
            active.some((value) => value.record_id === entry.line_id),
        )
        .reduce((total, entry) => total + units(entry.quantity), 0n);
      const released = row.state === RELEASED;
      return {
        recordId: String(row.record_id),
        number: String(row.number),
        released,
        expected: row.expected === null ? null : (row.expected as Date),
        ordered: decimal(ordered),
        received: decimal(done),
        open: decimal(released ? ordered - done : 0n),
        hasOpen: released && ordered - done > 0n,
      };
    });
}

type Truth = Awaited<ReturnType<typeof stored>>;
const toReceive = (truth: Truth) => truth.filter((row) => row.hasOpen);
const lateAt = (truth: Truth, anchor: string) =>
  toReceive(truth).filter(
    (row) =>
      row.expected !== null && row.expected.getTime() < Date.parse(anchor),
  );
/** The declared default order: expected date ascending, undated last. */
const byExpected = (rows: Truth) =>
  [...rows].sort(
    (left, right) =>
      (left.expected?.getTime() ?? Number.POSITIVE_INFINITY) -
        (right.expected?.getTime() ?? Number.POSITIVE_INFINITY) ||
      (left.recordId < right.recordId ? -1 : 1),
  );
const daysLate = (expected: Date, anchor: string) =>
  Math.round(
    (Date.parse(anchor) -
      Date.UTC(
        expected.getUTCFullYear(),
        expected.getUTCMonth(),
        expected.getUTCDate(),
      )) /
      DAY,
  );

test(
  'PURCHASING-PARITY: Expected receipts counts, pages, marks late and exports what is still to arrive, from the list statement',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const orderGet = (recordId: string) =>
        fixture.app.runtime.entry.run({ headers: {} }, (issued) => {
          const definition = registeredSemanticQueryFromPinnedView(
            issued,
            `${ns}:query.purchase_order_get`,
          )!;
          return fixture.app.runtime.queryGateway.invoke(issued, {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId: definition.queryId,
            arguments: {
              recordId,
              includeArchived: false,
              [definition.legalEntityScope!.operand.parameterId]: fixture.scope,
            },
          });
        });
      const revision = async (recordId: string) =>
        (await orderGet(recordId)).records[0]!.revision;
      const today = new Date();
      const midnight = Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate(),
      );
      const at = (offset: number) => new Date(midnight + offset).toISOString();
      // A released order with its lines and what has arrived against them;
      // an archived line adds nothing.
      const order = async (
        expected: string | null,
        lines: readonly (readonly [ordered: string, received: string])[],
        end: 'released' | 'draft' | 'closed' | 'cancelled' = 'released',
        archivedLine?: string,
      ) => {
        const created = await fixture.create('purchase_order', {
          supplier_party_id: fixture.customer,
          order_date: at(-40 * DAY),
          expected_date: expected,
          currency: 'CAD',
          notes: null,
        });
        const made = [];
        for (const [index, [ordered]] of lines.entries())
          made.push(
            await fixture.create(
              'purchase_order_line',
              {
                line_number: String(index + 1),
                item_id: fixture.item,
                ordered_quantity: ordered,
                unit_price: null,
              },
              { order: created.recordId },
            ),
          );
        if (archivedLine !== undefined) {
          const extra = await fixture.create(
            'purchase_order_line',
            {
              line_number: String(lines.length + 1),
              item_id: fixture.item,
              ordered_quantity: archivedLine,
              unit_price: null,
            },
            { order: created.recordId },
          );
          const archived = await fixture.invoke('purchase_order_line_archive', {
            recordId: extra.recordId,
            expectedRevision: extra.revision,
          });
          assert.equal(archived.outcome, 'succeeded');
        }
        if (end === 'draft')
          return String(created.values[`${ns}:field.purchase_order_number`]);
        if (end === 'cancelled') {
          const cancelled = await fixture.invoke(
            'purchase_order_draft_cancel',
            { recordId: created.recordId, expectedRevision: created.revision },
          );
          assert.equal(cancelled.outcome, 'succeeded');
          return String(created.values[`${ns}:field.purchase_order_number`]);
        }
        const release = await fixture.invoke('purchase_order_release', {
          recordId: created.recordId,
          expectedRevision: created.revision,
        });
        assert.equal(release.outcome, 'succeeded');
        for (const [index, [, received]] of lines.entries()) {
          if (received === '0') continue;
          const receipt = await fixture.create(
            'goods_receipt',
            {
              state: `${ns}:option.goods_receipt_state_draft`,
              kind: `${ns}:option.goods_receipt_kind_initial`,
              effective_at: new Date().toISOString(),
              location_id: fixture.location,
              reason_code: 'RECEIVE',
              reason_narrative: 'Expected receipts delivery',
            },
            { order: created.recordId },
          );
          await fixture.create(
            'goods_receipt_line',
            {
              line_number: '1',
              item_id: fixture.item,
              quantity: received,
              unit_id: 'EA',
              cost_status: `${ns}:option.goods_receipt_line_cost_status_absent`,
              unit_cost: null,
              currency: null,
              reversal_of_movement_id: null,
            },
            { receipt: receipt.recordId, order_line: made[index]!.recordId },
          );
          const posted = await fixture.invoke('goods_receipt_post', {
            recordId: receipt.recordId,
            expectedRevision: receipt.revision,
          });
          assert.equal(posted.outcome, 'succeeded');
        }
        if (end === 'closed') {
          const closed = await fixture.invoke('purchase_order_close', {
            recordId: created.recordId,
            expectedRevision: await revision(created.recordId),
          });
          assert.equal(closed.outcome, 'succeeded');
        }
        return String(created.values[`${ns}:field.purchase_order_number`]);
      };

      // Ordered 10 + 5 with 4 received, four days late: 15 / 4 / 11.
      const partly = await order(at(-4 * DAY + 12 * 3_600_000), [
        ['10', '4'],
        ['5', '0'],
      ]);
      // Exact decimals: 2.5 ordered, 1 received, 1.5 still open.
      const fractional = await order(at(-1 * DAY), [['2.5', '1']]);
      // Everything arrived: released, nothing open, in no open tab.
      const complete = await order(at(-10 * DAY - 3 * 3_600_000), [['3', '3']]);
      // An archived line adds nothing to what is ordered.
      const trimmed = await order(at(2 * DAY), [['8', '0']], 'released', '2');
      const undated = await order(null, [['1', '0']]);
      // Nothing is open outside released: a draft, a closed and a cancelled order.
      const draft = await order(at(-9 * DAY), [['7', '0']], 'draft');
      const closed = await order(at(-8 * DAY), [['2', '2']], 'closed');
      const cancelled = await order(at(-7 * DAY), [['6', '0']], 'cancelled');
      for (let index = 0; index < VOLUME; index++)
        await order(at((index - 26) * 20 * 3_600_000), [['1', '0']]);

      const truth = await stored(fixture);
      const open = toReceive(truth);
      assert.equal(open.length, VOLUME + 4);

      // Tabs: one server count per view, each equal to the stored facts.
      const first = await page(listUrl(fixture));
      assert.equal(first.status, 200);
      // The page names the day it compared with; the facts use the same one,
      // so a run across midnight UTC stays exact.
      assert.ok(first.anchor);
      const late = lateAt(truth, first.anchor);
      assert.ok(late.length > 2);
      assert.deepEqual(first.counts, {
        [view('to_receive')]: open.length,
        [view('late')]: late.length,
        [view('all_released')]: truth.filter((row) => row.released).length,
      });
      assert.equal(first.total, open.length);
      assert.deepEqual(
        [first.pageStatus?.[1], first.pageStatus?.[2]],
        ['1', '2'],
      );

      // Paging crosses the boundary exactly: every open order once, in the
      // declared order (expected date ascending, undated last).
      const second = await page(listUrl(fixture, { page: '2' }));
      const paged = [...first.rows, ...second.rows].map((row) => row.number);
      assert.equal(first.rows.length, 50);
      assert.deepEqual(
        paged,
        byExpected(open).map((row) => row.number),
      );
      assert.equal(new Set(paged).size, paged.length);
      for (const absent of [complete, draft, closed, cancelled])
        assert.ok(!paged.includes(absent), `${absent} has nothing open`);

      // Figures: order-level units across active lines, as exact decimals.
      const shown = new Map(
        [...first.rows, ...second.rows].map((row) => [row.number!, row]),
      );
      for (const row of open) {
        const cells = shown.get(row.number)!;
        assert.deepEqual(
          [cells.ordered, cells.received, cells.open],
          [row.ordered, row.received, row.open],
          row.number,
        );
      }
      assert.deepEqual(
        [
          shown.get(partly)!.ordered,
          shown.get(partly)!.received,
          shown.get(partly)!.open,
        ],
        ['15', '4', '11'],
      );
      assert.deepEqual(
        [shown.get(fractional)!.ordered, shown.get(fractional)!.open],
        ['2.5', '1.5'],
      );
      assert.equal(shown.get(trimmed)!.ordered, '8');
      assert.ok(shown.has(undated));
      // The marker judges the Late view's own conditions on each row.
      for (const row of open)
        assert.equal(
          shown.get(row.number)!.late,
          late.includes(row)
            ? String(daysLate(row.expected!, first.anchor))
            : undefined,
          row.number,
        );
      if (first.anchor === new Date(midnight).toISOString())
        assert.equal(shown.get(partly)!.late, '4');

      // The Late tab is the before-today set, every row marked.
      const lateTab = await page(listUrl(fixture, { view: view('late') }));
      const lateTruth = lateAt(truth, lateTab.anchor!);
      assert.equal(lateTab.total, lateTruth.length);
      assert.deepEqual(
        lateTab.rows.map((row) => row.number),
        byExpected(lateTruth).map((row) => row.number),
      );
      assert.ok(lateTab.rows.every((row) => row.late !== undefined));
      const released = await page(
        listUrl(fixture, { view: view('all_released') }),
      );
      assert.equal(released.total, truth.filter((row) => row.released).length);

      // Export: one statement, the tab's count, the figures as stored decimals.
      const exported = await fetch(`${listUrl(fixture)}&export=csv`);
      assert.equal(exported.status, 200);
      assert.match(
        exported.headers.get('content-disposition') ?? '',
        /^attachment; filename="expected-receipts-\d{4}-\d{2}-\d{2}\.csv"$/u,
      );
      const csv = (await exported.text())
        .replace(/^\uFEFF/u, '')
        .trimEnd()
        .split('\r\n');
      assert.equal(
        csv[0],
        'Number,Supplier,Expected,Ordered,Received,Open,Currency',
      );
      assert.equal(csv.length - 1, open.length);
      assert.ok(
        csv.some(
          (row) =>
            row.startsWith(`${fractional},`) && row.endsWith(',2.5,1,1.5,CAD'),
        ),
      );

      // The agent path: the published preset under a fixed anchor, answered
      // by the same gateway and statement.
      const fixed = at(-2 * DAY);
      const counted = await fixture.app.runtime.entry.run(
        { headers: {} },
        async (issued) => {
          const preset = (
            issued.projections.agent.payload as {
              listPresets: Array<{
                surfaceId: string;
                queryId: string;
                progress: ImmutableJsonValue;
                views: Array<{
                  viewId: string;
                  open?: true;
                  before?: { fieldId: string; anchor: string };
                  fieldFilters: Array<{ fieldId: string; value: string }>;
                }>;
              }>;
            }
          ).listPresets.find((value) => value.surfaceId === LIST)!;
          const lateView = preset.views.find(
            (value) => value.viewId === view('late'),
          )!;
          assert.equal(lateView.before?.anchor, 'startOfTodayUtc');
          const invoke = (list: Record<string, ImmutableJsonValue>) =>
            fixture.app.runtime.queryGateway.invoke(issued, {
              arguments: {
                includeArchived: false,
                list: {
                  cursor: null,
                  fieldFilters: lateView.fieldFilters,
                  matchMode: 'substring',
                  pageSize: 1,
                  relationLabels: [],
                  schemaVersion: SHARED_LIST_QUERY_VERSION,
                  search: '',
                  sort: [],
                  ...list,
                },
                [SCOPE]: fixture.scope,
              },
              queryId: preset.queryId,
              schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            });
          const result = await invoke({
            progress: {
              ...(preset.progress as Record<string, ImmutableJsonValue>),
              ...(lateView.open ? { openOnly: true } : {}),
            },
            beforeFilters: [
              { before: fixed, fieldId: lateView.before!.fieldId },
            ],
          });
          // A figure is shown, never a sort key.
          await assert.rejects(
            invoke({
              progress: preset.progress,
              sort: [{ direction: 'ascending', fieldId: output('open') }],
            }),
            (error: unknown) =>
              error instanceof SharedListContractError &&
              error.code === 'LIST_FIELD_NOT_AUTHORIZED',
          );
          return result.listCoverage?.totalCount;
        },
      );
      assert.equal(counted, lateAt(truth, fixed).length);

      // Current authority: without received-quantity read the List is refused
      // by the progress query's name -- no figure is guessed -- while the
      // Purchase orders List, which does not read it, still serves.
      await fixture.measure(
        'deny',
        undefined,
        undefined,
        'purchase_order_received_read',
      );
      const denied = await page(listUrl(fixture));
      assert.match(
        denied.html,
        /data-diagnostic-code="QUERY_PERMISSION_DENIED"/u,
      );
      assert.equal(denied.rows.length, 0);
      const refused = await fixture.app.runtime.entry.run(
        { headers: {} },
        (issued) =>
          fixture.app.runtime.queryGateway
            .invoke(issued, {
              arguments: {
                includeArchived: false,
                list: {
                  cursor: null,
                  matchMode: 'substring',
                  pageSize: 1,
                  progress: {
                    done: {
                      fieldId: `${ns}:field.purchase_order_received_received_quantity`,
                      queryId: `${ns}:query.purchase_order_received_list`,
                      relationId: `${ns}:relation.purchase_order_received_order_line`,
                    },
                    lines: {
                      fieldId: `${ns}:field.purchase_order_line_ordered_quantity`,
                      queryId: `${ns}:query.purchase_order_line_list`,
                      relationId: `${ns}:relation.purchase_order_line_order`,
                    },
                    outputs: {
                      done: output('received'),
                      open: output('open'),
                      ordered: output('ordered'),
                    },
                  },
                  relationLabels: [],
                  schemaVersion: SHARED_LIST_QUERY_VERSION,
                  search: '',
                  sort: [],
                },
                [SCOPE]: fixture.scope,
              },
              queryId: `${ns}:query.expected_receipt_list`,
              schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            })
            .then(
              () => null,
              (error: unknown) => error,
            ),
      );
      assert.ok(refused instanceof SemanticQueryPolicyDeniedError);
      assert.equal(refused.queryId, `${ns}:query.purchase_order_received_list`);
      // The Purchase orders List reads its commercial clone (ORDER-PARITY),
      // whose company parameter is its own; its figures are supplementary.
      const orders = await page(
        listUrl(
          fixture,
          {},
          `${ns}:surface.purchase_order_list`,
          `${ns}:parameter.commercial_purchase_order_list_legal_entity_scope`,
        ),
      );
      assert.equal(orders.status, 200);
      assert.doesNotMatch(orders.html, /QUERY_PERMISSION_DENIED/u);
      assert.equal(orders.total, truth.length);
      await fixture.measure(
        'allow',
        undefined,
        undefined,
        'purchase_order_received_read',
      );
      assert.equal((await page(listUrl(fixture))).total, open.length);
    });
  },
);
