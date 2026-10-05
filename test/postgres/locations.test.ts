import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';
const option = (local: string) => `${ns}:option.${local}`;
const status = (local: string) => option(`location_status_${local}`);

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

interface Scenario {
  readonly notebook: string;
  readonly warehouse: string;
  readonly hold: string;
  readonly order: string;
  readonly line: string;
}

function url(
  fixture: Fixture,
  surface: string,
  parameters: Record<string, string> = {},
): string {
  const target = new URL(fixture.app.baseUrl);
  target.searchParams.set('surface', `${ns}:surface.${surface}`);
  for (const [name, value] of Object.entries(parameters))
    target.searchParams.set(name, value);
  return target.href;
}
const scoped = (fixture: Fixture, query: string) => ({
  [`${ns}:parameter.${query}_legal_entity_scope`]: fixture.scope,
});

async function read(target: string) {
  const response = await fetch(target, { redirect: 'manual' });
  return { status: response.status, html: await response.text() };
}
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

/** A declared List's rows, or a page dataset's, read as a person reads them. */
function rows(html: string, dataset?: string) {
  const section = dataset
    ? (new RegExp(
        `<section id="${ns}:dataset\\.${dataset}"[\\s\\S]*?</section>`,
        'u',
      ).exec(html)?.[0] ?? '')
    : html;
  return new Map(
    [
      ...section.matchAll(
        /<tr data-compact-card="true"(?: data-presented-row="true")? data-record-id="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gu,
      ),
    ].map((match) => [
      match[1]!,
      Object.fromEntries(
        [
          ...match[2]!.matchAll(
            /<td data-column-label="([^"]+)"[^>]*>([\s\S]*?)<\/td>/gu,
          ),
        ].map((cell) => [cell[1]!, cell[2]!.replace(/<[^>]+>/gu, '').trim()]),
      ) as Record<string, string>,
    ]),
  );
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

/** Stored rows of one entity, read directly, never through a List. */
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
      : fulfillmentColumn(entity, name);
  return (
    await fixture.pool.query<Record<string, string | null>>(
      `SELECT record_id::text AS record_id, ${Object.entries(columns)
        .map(([alias, name]) => `"${column(name)}"::text AS "${alias}"`)
        .join(', ')}
         FROM ${fulfillmentTable(entity)}
        WHERE tenant_id = $1 AND environment_id = $2
          AND archived_at IS NULL${entity.legalEntity ? ` AND "${entity.legalEntity.column}" = $3` : ''}`,
      [
        fixture.app.runtime.identity.tenantId,
        fixture.app.runtime.identity.environmentId,
        ...(entity.legalEntity ? [fixture.scope] : []),
      ],
    )
  ).rows;
}

/**
 * Independent figures for one item: on hand everywhere, and usable and
 * available only at a live location whose stored status is usable --
 * computed here from stored rows, never through the list statement.
 */
async function truth(fixture: Fixture, item: string) {
  const usableLocations = new Set(
    (await stored(fixture, 'location', { status: 'location_status' }))
      .filter((row) => row.status === status('usable'))
      .map((row) => row.record_id!),
  );
  const balances = (
    await stored(fixture, 'posted_stock_balance', {
      item: 'posted_stock_balance_item_id',
      location: 'posted_stock_balance_location_id',
      quantity: 'posted_stock_balance_posted_quantity',
    })
  ).filter((row) => row.item === item);
  const reservations = (
    await stored(fixture, 'reservation', {
      item: 'reservation_item_id',
      location: 'reservation_location_id',
    })
  ).filter((row) => row.item === item);
  const remaining = await stored(fixture, 'reservation_balance', {
    reservation: 'relation.reservation_balance_reservation',
    quantity: 'reservation_balance_remaining_quantity',
  });
  const sum = (values: readonly bigint[]) =>
    values.reduce((total, value) => total + value, 0n);
  const held = (rows: typeof reservations) =>
    sum(
      rows.flatMap((row) =>
        remaining
          .filter((entry) => entry.reservation === row.record_id)
          .map((entry) => units(entry.quantity)),
      ),
    );
  const usable = sum(
    balances
      .filter((row) => usableLocations.has(row.location!))
      .map((row) => units(row.quantity)),
  );
  return {
    onHand: decimal(sum(balances.map((row) => units(row.quantity)))),
    usable: decimal(usable),
    reserved: decimal(held(reservations)),
    available: decimal(
      usable -
        held(reservations.filter((row) => usableLocations.has(row.location!))),
    ),
  };
}

test(
  'LOCATIONS: a quarantined location holds stock that is on hand but neither usable nor available, until its status changes back through its page with a reason',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const scenario = (await fixture.measure(
        'locations',
      )) as unknown as Scenario;
      // Stored: the location the seed created reads usable, the declared
      // default of a location released before its status existed; the hold
      // states its status, reason and instant.
      const locations = new Map(
        (
          await stored(fixture, 'location', {
            code: 'location_code',
            type: 'location_type',
            status: 'location_status',
            reason: 'location_status_reason',
            changed: 'location_status_changed_at',
          })
        ).map((row) => [row.record_id, row]),
      );
      assert.equal(locations.get(scenario.warehouse)!.status, status('usable'));
      assert.equal(locations.get(scenario.warehouse)!.reason, null);
      assert.deepEqual(
        [
          locations.get(scenario.hold)!.type,
          locations.get(scenario.hold)!.status,
          locations.get(scenario.hold)!.reason,
        ],
        [
          option('location_type_quarantine'),
          status('quarantine'),
          'Water damage on an inbound pallet',
        ],
      );
      assert.notEqual(locations.get(scenario.hold)!.changed, null);

      // Stock by item: the notebook's 10 on hand, 6 of them usable at
      // CAL-WH; nothing reserved, so 6 available; 8 still to ship, so
      // projected 6 - 8 = -2: a shortage the quarantined 4 does not hide.
      const stockList = async () =>
        rows(
          (
            await read(
              url(
                fixture,
                'item_stock_list',
                scoped(fixture, 'item_stock_list'),
              ),
            )
          ).html,
        ).get(scenario.notebook)!;
      const before = await truth(fixture, scenario.notebook);
      assert.deepEqual(before, {
        onHand: '10',
        usable: '6',
        reserved: '0',
        available: '6',
      });
      const stock = await stockList();
      assert.deepEqual(
        [
          stock['On hand'],
          stock.Usable,
          stock.Reserved,
          stock.Available,
          stock['Open demand'],
          stock.Projected,
          stock.Status,
        ],
        [
          before.onHand,
          before.usable,
          before.reserved,
          before.available,
          '8',
          '-2',
          'Shortage',
        ],
      );
      const buying = rows(
        (
          await read(
            url(
              fixture,
              'item_buying_list',
              scoped(fixture, 'item_buying_list'),
            ),
          )
        ).html,
      ).get(scenario.notebook);
      // The notebook has no reorder point: it is never on the worklist.
      assert.equal(buying, undefined);

      // The Location List: its status filter keeps the hold alone, with its
      // type, status and reason.
      const quarantined = rows(
        (
          await read(
            url(fixture, 'location_list', {
              [`${ns}:list_filter.location_list_status`]: status('quarantine'),
            }),
          )
        ).html,
      );
      assert.deepEqual([...quarantined.keys()], [scenario.hold]);
      const held = quarantined.get(scenario.hold)!;
      assert.deepEqual(
        [
          held.Code,
          held.Name,
          held.Type,
          held['Inventory status'],
          held['Status reason'],
        ],
        [
          'QA-HOLD',
          'Quality hold',
          'Quarantine',
          'Quarantine',
          'Water damage on an inbound pallet',
        ],
      );

      // The item page: each location's status beside its stock, and nothing
      // available at the hold.
      const itemStock = async () =>
        rows(
          (
            await read(
              url(fixture, 'item_detail', {
                record: scenario.notebook,
                ...scoped(fixture, 'posted_stock_balance_list'),
              }),
            )
          ).html,
          'item_stock',
        );
      const pageRows = [...(await itemStock()).values()].map((row) => [
        row.Location,
        row.Status,
        row['On hand'],
        row.Reserved,
        row.Available,
      ]);
      assert.deepEqual(pageRows, [
        ['CAL-WH', 'Usable', '6', '0', '6'],
        ['QA-HOLD', 'Quarantine', '4', '0', '0'],
      ]);

      // The order's line: free stock now is the usable 6, so it is short 2.
      const orderLine = async () =>
        rows(
          (
            await read(
              url(fixture, 'sales_order_detail', {
                record: scenario.order,
                ...scoped(fixture, 'commercial_order_get'),
              }),
            )
          ).html,
          'fulfillment_lines',
        ).get(scenario.line)!;
      assert.deepEqual(
        [(await orderLine()).Short, (await orderLine())['Free stock now']],
        ['2', '6'],
      );

      // "Change status" on the hold's page: inspected and released, with a
      // reason, through the real served Task.
      const page = url(fixture, 'location_detail', { record: scenario.hold });
      const shown = await read(page);
      assert.equal(shown.status, 200);
      assert.match(
        shown.html,
        /<span class="composition-business-status">Quarantine<\/span>/u,
      );
      const action = `${ns}:action.location_change_status`;
      const started = await post(page, { compositionAction: action });
      const token = hidden(started.html, 'taskToken');
      const review = await post(page, {
        taskToken: token,
        compositionAction: action,
        taskStage: 'prepare',
        [`${ns}:input.location_status`]: status('usable'),
        [`${ns}:input.location_status_reason`]: 'Inspected and released',
      });
      assert.match(review.html, /name="preparedId"/u, review.html.slice(-4000));
      await post(page, {
        taskToken: token,
        compositionAction: action,
        taskStage: 'confirm',
        preparedId: hidden(review.html, 'preparedId'),
      });
      const released = (
        await stored(fixture, 'location', {
          status: 'location_status',
          reason: 'location_status_reason',
          changed: 'location_status_changed_at',
        })
      ).find((row) => row.record_id === scenario.hold)!;
      assert.equal(released.status, status('usable'));
      assert.equal(released.reason, 'Inspected and released');
      assert.ok(
        Date.parse(String(released.changed)) >=
          Date.parse(String(locations.get(scenario.hold)!.changed)),
      );

      // Every figure follows: all 10 usable and available, no longer short.
      const after = await truth(fixture, scenario.notebook);
      assert.deepEqual(after, {
        onHand: '10',
        usable: '10',
        reserved: '0',
        available: '10',
      });
      const restocked = await stockList();
      assert.deepEqual(
        [restocked.Usable, restocked.Available, restocked.Projected],
        [after.usable, after.available, '2'],
      );
      assert.deepEqual(
        [...(await itemStock()).values()].map((row) => [
          row.Location,
          row.Status,
          row.Available,
        ]),
        [
          ['CAL-WH', 'Usable', '6'],
          ['QA-HOLD', 'Usable', '4'],
        ],
      );
      assert.deepEqual(
        [(await orderLine()).Short, (await orderLine())['Free stock now']],
        ['0', '10'],
      );

      // The generic form leaves the status to the page, and a location it
      // creates reads usable; a widened type is admitted by the released
      // constraint.
      const form = await read(url(fixture, 'location_form'));
      assert.match(
        form.html,
        new RegExp(`name="value:${ns}:field\\.location_code"`, 'u'),
      );
      assert.doesNotMatch(form.html, /name="value:[^"]*location_status/u);
      const yard = await fixture.create(
        'location',
        {
          code: 'YARD-1',
          name: 'Outdoor yard',
          type: option('location_type_yard'),
        },
        {},
        false,
      );
      const created = (
        await stored(fixture, 'location', {
          type: 'location_type',
          status: 'location_status',
        })
      ).find((row) => row.record_id === yard.recordId)!;
      assert.deepEqual(
        [created.type, created.status],
        [option('location_type_yard'), status('usable')],
      );
    });
  },
);
