import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticRecordDto,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

// RECEIVING-EXTRAS against the composed application on PostgreSQL, through
// the governed operations the receive and correct Tasks bind:
// - a receipt is dated the day goods arrived, within the posting window the
//   kernel keeps (seven business days back, never after today, never inside
//   a closed period), and a refused date leaves no movement;
// - a posted receipt is corrected for only some of its lines and part of a
//   line, never beyond what each still adds to stock, and two corrections
//   racing for the same remainder admit exactly one;
// - an item short of free stock but already on a placed purchase order reads
//   "On order" rather than short, on the Sales orders List and the order
//   page alike, as an independent computation over the stored rows says.

const ns = 'northstar.app';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LAMP = '71000000-0000-4000-8000-000000000013';
const SHORT_MARK =
  ' <span class="status-pill" data-status-role="blocked" data-short-mark="true"><span aria-hidden="true">!</span><span class="sr-only">Short of stock</span></span>';

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

const refusedWith = (code: string) => (error: unknown) => {
  assert.equal(
    (error as { code?: unknown }).code,
    code,
    `expected ${code}, got ${String(error)}`,
  );
  return true;
};

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

function governed(fixture: Fixture) {
  const query = (local: string, args: Record<string, ImmutableJsonValue>) =>
    fixture.app.runtime.entry.run({ headers: {} }, (view) => {
      const definition = registeredSemanticQueryFromPinnedView(
        view,
        `${ns}:query.${local}`,
      )!;
      return fixture.app.runtime.queryGateway.invoke(view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: definition.queryId,
        arguments: {
          ...args,
          ...(definition.legalEntityScope
            ? {
                [definition.legalEntityScope.operand.parameterId]:
                  fixture.scope,
              }
            : {}),
        },
      });
    });
  const children = async (
    local: string,
    relation: string,
    recordId: string,
  ): Promise<readonly SemanticRecordDto[]> =>
    (
      await query(local, {
        includeArchived: false,
        list: {
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          cursor: null,
          matchMode: 'substring',
          pageSize: 100,
          search: '',
          sort: [],
          relationLabels: [],
          parentScope: { relationId: `${ns}:relation.${relation}`, recordId },
        },
      })
    ).records;
  /** A placed order: created, its lines added, then Place order (release). */
  const placed = async (item: string, quantities: readonly string[]) => {
    const order = await fixture.create('purchase_order', {
      supplier_party_id: fixture.customer,
      order_date: new Date().toISOString(),
      expected_date: null,
      currency: 'CAD',
      notes: null,
    });
    const lines = [];
    for (const [index, quantity] of quantities.entries())
      lines.push(
        await fixture.create(
          'purchase_order_line',
          {
            line_number: String(index + 1),
            item_id: item,
            ordered_quantity: quantity,
            unit_price: null,
          },
          { order: order.recordId },
        ),
      );
    const release = await fixture.invoke('purchase_order_release', {
      recordId: order.recordId,
      expectedRevision: order.revision,
    });
    assert.equal(release.outcome, 'succeeded');
    return { order, lines };
  };
  /**
   * A draft receipt as the receive Tasks write one: its received date is the
   * entered one; then each line. Correction lines compensate a movement.
   */
  const receipt = async (
    orderId: string,
    effectiveAt: string,
    lines: readonly {
      orderLine: string;
      item: string;
      quantity: string;
      cost?: string;
      reversalOf?: string;
    }[],
    supersedes?: string,
  ) => {
    const header = await fixture.create(
      'goods_receipt',
      {
        state: `${ns}:option.goods_receipt_state_draft`,
        kind: `${ns}:option.goods_receipt_kind_${supersedes ? 'correction' : 'initial'}`,
        effective_at: effectiveAt,
        location_id: fixture.location,
        reason_code: supersedes ? 'CORRECT' : 'RECEIVE',
        reason_narrative: supersedes
          ? 'Counted short at the dock'
          : 'Receive from purchase order',
      },
      { order: orderId, ...(supersedes ? { supersedes } : {}) },
    );
    const created = [];
    for (const [index, line] of lines.entries())
      created.push(
        await fixture.create(
          'goods_receipt_line',
          {
            line_number: String(index + 1),
            item_id: line.item,
            quantity: line.quantity,
            unit_id: 'EA',
            cost_status: `${ns}:option.goods_receipt_line_cost_status_${line.cost ? 'known' : 'absent'}`,
            unit_cost: line.cost ?? null,
            currency: line.cost ? 'CAD' : null,
            reversal_of_movement_id: line.reversalOf ?? null,
          },
          { receipt: header.recordId, order_line: line.orderLine },
        ),
      );
    return { header, lines: created };
  };
  const post = (header: { recordId: string; revision: number }) =>
    fixture.invoke('goods_receipt_post', {
      recordId: header.recordId,
      expectedRevision: header.revision,
    });
  return { query, children, placed, receipt, post };
}

/** The stored movements a receipt posted, and its stored state. */
async function stored(fixture: Fixture, receiptId: string) {
  const target = await governedStorageTarget();
  const entity = (local: string) =>
    target.entities.find(
      (value) => value.entityId === `${ns}:entity.${local}`,
    )!;
  const movement = entity('inventory_movement');
  const receipt = entity('goods_receipt');
  const column = (definition: typeof movement, name: string) =>
    `"${fulfillmentColumn(definition, name)}"`;
  const scoped = [
    fixture.app.runtime.identity.tenantId,
    fixture.app.runtime.identity.environmentId,
    receiptId,
  ];
  const movements = await fixture.pool.query<{
    quantity: string;
    effective_at: Date;
    reversal_of: string | null;
  }>(
    `SELECT ${column(movement, 'inventory_movement_quantity_delta')}::text AS quantity,
            ${column(movement, 'inventory_movement_effective_at')} AS effective_at,
            ${column(movement, 'inventory_movement_reversal_of_movement_id')}::text AS reversal_of
       FROM ${fulfillmentTable(movement)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${column(movement, 'inventory_movement_source_id')} = $3
        AND archived_at IS NULL
      ORDER BY record_id`,
    scoped,
  );
  const header = await fixture.pool.query<{ state: string }>(
    `SELECT ${column(receipt, 'goods_receipt_state')}::text AS state
       FROM ${fulfillmentTable(receipt)}
      WHERE tenant_id = $1 AND environment_id = $2 AND record_id = $3`,
    scoped,
  );
  return {
    movements: movements.rows,
    state: header.rows[0]!.state.split('goods_receipt_state_')[1],
  };
}

test(
  'RECEIVING-EXTRAS: a receipt is dated within the posting window, corrected for only some of its lines, and a placed purchase order covers a shortage on the List and the order page alike',
  { timeout: 300_000 },
  async (t) => {
    await withOrderEntryFixture(async (fixture) => {
      const { children, placed, receipt, post } = governed(fixture);
      const receivedOf = async (orderId: string) =>
        [
          ...(await children(
            'commercial_purchase_order_lines',
            'purchase_order_line_order',
            orderId,
          )),
        ]
          .sort((a, b) =>
            String(
              a.values[`${ns}:field.purchase_order_line_line_number`],
            ).localeCompare(
              String(b.values[`${ns}:field.purchase_order_line_line_number`]),
            ),
          )
          .map((line) => line.values[`${ns}:metric.received`]);

      await t.test(
        'the received date is the day goods arrived: up to seven business days back, never after today, never in a closed period',
        async () => {
          const { order, lines } = await placed(fixture.item, ['20']);
          const now = Date.now();
          const at = (offset: number) => new Date(now + offset).toISOString();
          const dated = async (effectiveAt: string) =>
            receipt(order.recordId, effectiveAt, [
              {
                orderLine: lines[0]!.recordId,
                item: fixture.item,
                quantity: '1',
              },
            ]);
          // Admitted: yesterday, and six and a half days back.
          for (const effectiveAt of [at(-DAY), at(-6.5 * DAY)]) {
            const { header } = await dated(effectiveAt);
            assert.equal((await post(header)).outcome, 'succeeded');
            const { movements, state } = await stored(fixture, header.recordId);
            assert.equal(state, 'posted');
            // The movement carries the entered date, to the millisecond.
            assert.deepEqual(
              movements.map((row) => [
                text(units(row.quantity)),
                row.effective_at.toISOString(),
              ]),
              [['1', effectiveAt]],
            );
          }
          // Refused before any write, each by the kernel's own code: a day
          // after today, and past the seven-day window. The draft stays one.
          for (const [effectiveAt, code] of [
            [at(30 * HOUR), 'RECEIPT_FORWARD_DATE_REFUSED'],
            [at(-8.5 * DAY), 'INVENTORY_BACKDATE_LIMIT_EXCEEDED'],
          ] as const) {
            const { header } = await dated(effectiveAt);
            await assert.rejects(post(header), refusedWith(code));
            assert.deepEqual(await stored(fixture, header.recordId), {
              movements: [],
              state: 'draft',
            });
          }
          // A closed period refuses a date inside it, and admits one after.
          const target = await governedStorageTarget();
          const lockEntity = target.entities.find(
            (value) => value.entityId === `${ns}:entity.inventory_period_lock`,
          )!;
          const lock = async () =>
            (
              await fixture.pool.query<{ record_id: string; revision: string }>(
                `SELECT record_id, revision::text FROM ${fulfillmentTable(lockEntity)}
                  WHERE tenant_id = $1 AND environment_id = $2 AND ${lockEntity.legalEntity!.column} = $3`,
                [
                  fixture.app.runtime.identity.tenantId,
                  fixture.app.runtime.identity.environmentId,
                  fixture.scope,
                ],
              )
            ).rows[0]!;
          const moveLock = async (
            operation: 'advance_period_lock' | 'reopen_period',
            instant: string | null,
          ) => {
            const current = await lock();
            const moved = await fixture.invoke(operation, {
              recordId: current.record_id,
              expectedRevision: Number(current.revision),
              patch: {
                [`${ns}:field.inventory_period_lock_closed_through`]: instant,
              },
            });
            assert.equal(moved.outcome, 'succeeded');
          };
          await moveLock('advance_period_lock', at(-3 * DAY));
          try {
            const inside = await dated(at(-4 * DAY));
            await assert.rejects(
              post(inside.header),
              refusedWith('INVENTORY_PERIOD_CLOSED'),
            );
            assert.deepEqual(await stored(fixture, inside.header.recordId), {
              movements: [],
              state: 'draft',
            });
            const after = await dated(at(-DAY));
            assert.equal((await post(after.header)).outcome, 'succeeded');
          } finally {
            await moveLock('reopen_period', null);
          }
          // Three of the twenty arrived: the refused drafts received nothing.
          assert.deepEqual(await receivedOf(order.recordId), ['3']);
        },
      );

      await t.test(
        'a posted receipt is corrected for only some of its lines, never beyond what each still adds, and two racing corrections admit one',
        async () => {
          const { order, lines } = await placed(fixture.item, ['10', '6']);
          const original = await receipt(
            order.recordId,
            new Date().toISOString(),
            [
              {
                orderLine: lines[0]!.recordId,
                item: fixture.item,
                quantity: '4',
                cost: '2.5',
              },
              {
                orderLine: lines[1]!.recordId,
                item: fixture.item,
                quantity: '3',
              },
            ],
          );
          assert.equal((await post(original.header)).outcome, 'succeeded');
          const originalMovements = (
            await stored(fixture, original.header.recordId)
          ).movements;
          // What each line can still give back, as the receipt page reads it.
          const reversible = async () =>
            new Map(
              (
                await children(
                  'receiving_receipt_lines',
                  'goods_receipt_line_receipt',
                  original.header.recordId,
                )
              ).map((line) => [
                line.recordId,
                {
                  movement: String(line.values[`${ns}:metric.movement`]),
                  reversible: String(line.values[`${ns}:metric.reversible`]),
                  orderLine: String(line.values[`${ns}:metric.order_line`]),
                },
              ]),
            );
          const before = await reversible();
          const [first, second] = original.lines.map((line) =>
            before.get(line.recordId)!,
          );
          assert.deepEqual([first!.reversible, second!.reversible], ['4', '3']);
          assert.deepEqual(
            [first!.orderLine, second!.orderLine],
            [lines[0]!.recordId, lines[1]!.recordId],
          );
          const correction = (
            line: typeof first,
            quantity: string,
            cost?: string,
          ) =>
            receipt(
              order.recordId,
              new Date().toISOString(),
              [
                {
                  orderLine: line!.orderLine,
                  item: fixture.item,
                  quantity,
                  ...(cost ? { cost } : {}),
                  reversalOf: line!.movement,
                },
              ],
              original.header.recordId,
            );
          // One of four is taken back from the first line alone; the second
          // line and the original receipt are untouched.
          const partial = await correction(first, '-1', '2.5');
          assert.equal((await post(partial.header)).outcome, 'succeeded');
          assert.deepEqual(await receivedOf(order.recordId), ['3', '3']);
          const afterPartial = await reversible();
          assert.deepEqual(
            original.lines.map(
              (line) => afterPartial.get(line.recordId)!.reversible,
            ),
            ['3', '3'],
          );
          assert.deepEqual(
            (await stored(fixture, partial.header.recordId)).movements.map(
              (row) => [text(units(row.quantity)), row.reversal_of],
            ),
            [['-1', first!.movement]],
          );
          assert.deepEqual(
            (await stored(fixture, original.header.recordId)).movements,
            originalMovements,
          );
          // More than a line still adds is refused, and writes nothing.
          const beyond = await correction(second, '-4');
          await assert.rejects(
            post(beyond.header),
            refusedWith('RECEIPT_CORRECTION_INVALID'),
          );
          assert.deepEqual(await stored(fixture, beyond.header.recordId), {
            movements: [],
            state: 'draft',
          });
          // Two corrections each taking back the first line's remaining three,
          // posted at once: one is admitted, the other refused, and the line
          // is never taken below nothing.
          const racers = [
            await correction(first, '-3', '2.5'),
            await correction(first, '-3', '2.5'),
          ];
          const settled = await Promise.allSettled(
            racers.map((racer) => post(racer.header)),
          );
          assert.deepEqual(settled.map((outcome) => outcome.status).sort(), [
            'fulfilled',
            'rejected',
          ]);
          const lost = settled.find(
            (outcome): outcome is PromiseRejectedResult =>
              outcome.status === 'rejected',
          )!;
          assert.ok(
            [
              'RECEIPT_CORRECTION_INVALID',
              'INVENTORY_TRANSACTION_STATE_CONFLICT',
            ].includes(String((lost.reason as { code?: unknown }).code)),
            String(lost.reason),
          );
          assert.deepEqual(await receivedOf(order.recordId), ['0', '3']);
          const settledLines = await reversible();
          assert.deepEqual(
            original.lines.map(
              (line) => settledLines.get(line.recordId)!.reversible,
            ),
            ['0', '3'],
          );
          // Reversing the rest still takes every line that adds to stock.
          const rest = settledLines.get(original.lines[1]!.recordId)!;
          const reversal = await fixture.create(
            'goods_receipt',
            {
              state: `${ns}:option.goods_receipt_state_draft`,
              kind: `${ns}:option.goods_receipt_kind_reversal`,
              effective_at: new Date().toISOString(),
              location_id: fixture.location,
              reason_code: 'REVERSE',
              reason_narrative: 'Wrong dock',
            },
            {
              order: order.recordId,
              supersedes: original.header.recordId,
            },
          );
          await fixture.create(
            'goods_receipt_line',
            {
              line_number: '2',
              item_id: fixture.item,
              quantity: '-3',
              unit_id: 'EA',
              cost_status: `${ns}:option.goods_receipt_line_cost_status_absent`,
              unit_cost: null,
              currency: null,
              reversal_of_movement_id: rest.movement,
            },
            { receipt: reversal.recordId, order_line: rest.orderLine },
          );
          assert.equal((await post(reversal)).outcome, 'succeeded');
          assert.deepEqual(await receivedOf(order.recordId), ['0', '0']);
        },
      );

      await t.test(
        'an item short of free stock but on a placed purchase order reads On order, not short, on the List and the order page',
        async () => {
          // The fixture's scenario (its `incoming_supply` phase): the lamp,
          // with nothing on hand; a placed order for 6, 2 of which arrived (2
          // free, 4 still on order); a draft order for 50 and a placed order
          // cancelled before anything arrived, which count nothing; and sales
          // orders of 9 and 6 (confirmed) and 20 (a draft).
          const scenario = (await fixture.measure(
            'incoming_supply',
          )) as unknown as {
            lamp: string;
            orders: Record<
              'nine' | 'six' | 'twenty',
              { number: string; recordId: string; line: string }
            >;
          };
          assert.equal(scenario.lamp, LAMP);
          const { nine, six, twenty } = scenario.orders;

          // The stored truth for the lamp, computed here in one statement and
          // never through the list statement or the read model under test.
          const truth = await lampTruth(fixture);
          assert.deepEqual(
            [truth.free, truth.incoming].map(text),
            ['2', '4'],
            'the scenario as designed',
          );
          const expected = new Map([
            [nine.recordId, { name: 'nine', short: '3', onOrder: '4' }],
            [six.recordId, { name: 'six', short: '0', onOrder: '4' }],
            [twenty.recordId, { name: 'twenty', short: '14', onOrder: '4' }],
          ]);
          for (const [recordId, { short, onOrder }] of expected)
            assert.deepEqual(
              truth.orders.get(recordId),
              { short, onOrder },
              'the oracle agrees with the design',
            );

          // The List: Short net of what is on order, On order beside it, and
          // Blocked by supply keeps only the confirmed order still short.
          const list = await listPage(salesUrl(fixture));
          assert.equal(list.status, 200);
          assert.doesNotMatch(list.html, /supply-withheld/u);
          for (const [recordId, figures] of expected) {
            assert.equal(
              list.cell(recordId, 'short'),
              figures.short === '0' ? '0' : `${figures.short}${SHORT_MARK}`,
              `${figures.name} reads its Short on the List`,
            );
            assert.equal(
              list.cell(recordId, 'incoming'),
              figures.onOrder,
              `${figures.name} reads On order on the List`,
            );
          }
          const blocked = await listPage(
            salesUrl(fixture, {
              view: `${ns}:list_view.sales_order_list_blocked`,
            }),
          );
          assert.ok(blocked.rows.includes(nine.recordId));
          assert.ok(!blocked.rows.includes(six.recordId));
          const exported = await fetch(`${salesUrl(fixture)}&export=csv`);
          assert.equal(
            (await exported.text()).replace(/^\uFEFF/u, '').split('\r\n')[0],
            'Number,Customer,Salesperson,Order date,Requested,Status,Ordered,Shipped,Open,Short,On order,Currency',
          );

          // One formula: each order page states the line exactly so.
          for (const [recordId, figures] of expected) {
            const pageHtml = await (
              await fetch(orderUrl(fixture, recordId), { redirect: 'manual' })
            ).text();
            const line = [nine, six, twenty].find(
              (value) => value.recordId === recordId,
            )!.line;
            assert.equal(
              pageCell(pageHtml, line, 'Short'),
              figures.short,
              `${figures.name} reads its Short on its page`,
            );
            assert.equal(
              pageCell(pageHtml, line, 'On order'),
              figures.onOrder,
              `${figures.name} reads On order on its page`,
            );
          }

          // Without purchase order line read, the supply is withheld whole:
          // the List keeps its progress, and the page states no shortage
          // rather than one that ignores what is on order.
          await fixture.measure(
            'deny',
            undefined,
            undefined,
            'purchase_order_line_read',
          );
          try {
            const withheld = await listPage(salesUrl(fixture));
            assert.equal(withheld.status, 200);
            assert.match(
              withheld.html,
              new RegExp(
                `data-list-supply-withheld="${ns}:query\\.purchase_order_line_list"`,
                'u',
              ),
            );
            assert.equal(
              withheld.cell(nine.recordId, 'short'),
              '<span class="muted">—</span>',
            );
            const pageHtml = await (
              await fetch(orderUrl(fixture, nine.recordId), {
                redirect: 'manual',
              })
            ).text();
            assert.equal(pageCell(pageHtml, nine.line, 'Short'), '—');
            assert.equal(pageCell(pageHtml, nine.line, 'On order'), '—');
          } finally {
            await fixture.measure(
              'allow',
              undefined,
              undefined,
              'purchase_order_line_read',
            );
          }
        },
      );
    });
  },
);

function salesUrl(fixture: Fixture, parameters: Record<string, string> = {}) {
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

function orderUrl(fixture: Fixture, recordId: string) {
  const target = new URL(fixture.app.baseUrl);
  target.searchParams.set('surface', `${ns}:surface.sales_order_detail`);
  target.searchParams.set('record', recordId);
  target.searchParams.set(
    `${ns}:parameter.commercial_order_get_legal_entity_scope`,
    fixture.scope,
  );
  return target.href;
}

/** The served List, read the way a person reads it: rows and cells. */
async function listPage(target: string) {
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
    rows: [
      ...html.matchAll(
        /<tr data-compact-card="true" data-record-id="([^"]+)">/gu,
      ),
    ].map((match) => match[1]!),
    cell: (recordId: string, local: string) =>
      new RegExp(
        `data-column-id="${ns}:list_column\\.sales_order_list_${local}">([\\s\\S]*?)</td>`,
        'u',
      ).exec(row(recordId))?.[1],
  };
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

/**
 * The lamp's stored truth: free stock (its posted stock -- all of it at the
 * fixture's usable warehouse -- less what live reservations hold), what
 * placed purchase orders still have to receive (each released order's active
 * line, ordered less its received projection, never below zero), and per
 * sales order in the draft and confirmed states -- none shipped or reserved
 * -- what free stock, then that, leave short and what that covers.
 */
async function lampTruth(fixture: Fixture) {
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
  const owned = (alias: string) =>
    `${alias}.tenant_id = $1 AND ${alias}.environment_id = $2 AND ${alias}.archived_at IS NULL AND ${alias}.legal_entity_id = $3`;
  const { rows } = await fixture.pool.query<{
    free: string;
    incoming: string;
    orders: { record_id: string; short: string; on_order: string }[] | null;
  }>(
    `WITH free AS (
       SELECT coalesce(sum(q.${column('posted_stock_balance', 'posted_stock_balance_posted_quantity')}), 0)
              - coalesce((SELECT sum(b.${column('reservation_balance', 'reservation_balance_remaining_quantity')})
                            FROM ${table('reservation')} r
                            JOIN ${table('reservation_balance')} b
                              ON ${owned('b')} AND b.${relation('reservation_balance_reservation')} = r.record_id
                           WHERE ${owned('r')} AND r.${column('reservation', 'reservation_item_id')}::text = $4), 0) AS free
         FROM ${table('posted_stock_balance')} q
        WHERE ${owned('q')} AND q.${column('posted_stock_balance', 'posted_stock_balance_item_id')}::text = $4
     ), incoming AS (
       SELECT coalesce(sum(greatest(l.${column('purchase_order_line', 'purchase_order_line_ordered_quantity')}
                - coalesce((SELECT sum(p.${column('purchase_order_received', 'purchase_order_received_received_quantity')})
                              FROM ${table('purchase_order_received')} p
                             WHERE ${owned('p')} AND p.${relation('purchase_order_received_order_line')} = l.record_id), 0), 0)), 0) AS incoming
         FROM ${table('purchase_order_line')} l
         JOIN ${table('purchase_order')} o
           ON ${owned('o')} AND o.record_id = l.${relation('purchase_order_line_order')}
        WHERE ${owned('l')} AND l.${column('purchase_order_line', 'purchase_order_line_item_id')}::text = $4
          AND o.${column('purchase_order', 'derived_state_field.machine.purchase_order_lifecycle')}::text = $5
     ), demand AS (
       SELECT o.record_id,
              sum(l.${column('sales_order_line', 'sales_order_line_ordered_quantity')}) AS uncovered
         FROM ${table('sales_order')} o
         JOIN ${table('sales_order_line')} l
           ON ${owned('l')} AND l.${relation('sales_order_line_order')} = o.record_id
        WHERE ${owned('o')} AND l.${column('sales_order_line', 'sales_order_line_item_id')}::text = $4
          AND o.${column('sales_order', 'derived_state_field.machine.sales_order_lifecycle')}::text = ANY($6::text[])
        GROUP BY o.record_id
     )
     SELECT (SELECT free FROM free)::text AS free,
            (SELECT incoming FROM incoming)::text AS incoming,
            (SELECT json_agg(json_build_object(
                'record_id', d.record_id::text,
                'short', greatest(d.uncovered - greatest((SELECT free FROM free), 0) - greatest((SELECT incoming FROM incoming), 0), 0)::text,
                'on_order', least(greatest(d.uncovered - greatest((SELECT free FROM free), 0), 0), greatest((SELECT incoming FROM incoming), 0))::text))
               FROM demand d) AS orders`,
    [
      fixture.app.runtime.identity.tenantId,
      fixture.app.runtime.identity.environmentId,
      fixture.scope,
      LAMP,
      `${ns}:state.purchase_order_released`,
      [`${ns}:state.sales_order_draft`, `${ns}:state.sales_order_released`],
    ],
  );
  const row = rows[0]!;
  return {
    free: units(row.free),
    incoming: units(row.incoming),
    orders: new Map(
      (row.orders ?? []).map((value) => [
        value.record_id,
        {
          short: text(units(value.short)),
          onOrder: text(units(value.on_order)),
        },
      ]),
    ),
  };
}
