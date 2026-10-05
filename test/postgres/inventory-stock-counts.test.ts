import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { InventoryPostingError } from '../../packages/postgres-provider/src/inventory-posting-error.js';
import { ModuleRuntimeInterpreterError } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';
/** The demo seed's Vancouver warehouse: a second location holding stock. */
const VANCOUVER_WAREHOUSE = '71000000-0000-4000-8000-000000000023';

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

const countField = (local: string) => `${ns}:field.stock_count_${local}`;
const lineField = (local: string) => `${ns}:field.stock_count_line_${local}`;
const state = (local: string) => `${ns}:option.stock_count_state_${local}`;
const kind = (local: string) => `${ns}:option.stock_count_kind_${local}`;
const refusal = (code: string, message?: RegExp) => (error: unknown) => {
  assert.ok(
    error instanceof InventoryPostingError,
    `expected ${code}, got ${String(error)}`,
  );
  assert.equal(error.code, code);
  if (message) assert.match(error.message, message);
  return true;
};
const moduleRefusal = (code: string) => (error: unknown) => {
  assert.ok(
    error instanceof ModuleRuntimeInterpreterError,
    `expected ${code}, got ${String(error)}`,
  );
  assert.equal(error.code, code);
  return true;
};

/** A stored exact decimal as a person reads it: `-2`, not `-2.000…`. */
function canonical(value: unknown): string {
  const text = String(value);
  return /^-?\d+\.\d+$/u.test(text)
    ? text.replace(/(\.\d*?[1-9])0+$|\.0+$/u, '$1')
    : text;
}

/**
 * Independent facts, read from PostgreSQL directly: on-hand of an item at a
 * location, a count's state and lines, the movements naming a source, and
 * the companion transactions the kernel writes.
 */
async function storage(fixture: Fixture) {
  const target = await governedStorageTarget();
  const entity = (local: string) =>
    target.entities.find(
      (value) => value.entityId === `${ns}:entity.${local}`,
    )!;
  const column = (local: string, name: string) =>
    fulfillmentColumn(entity(local), name);
  const scope = [
    fixture.app.runtime.identity.tenantId,
    fixture.app.runtime.identity.environmentId,
    fixture.scope,
  ];
  const balance = entity('posted_stock_balance');
  const onHand = async (location: string) =>
    new Map(
      (
        await fixture.pool.query<{ item: string; quantity: string }>(
          `SELECT ${column('posted_stock_balance', 'posted_stock_balance_item_id')} AS item,
                  ${column('posted_stock_balance', 'posted_stock_balance_posted_quantity')}::text AS quantity
             FROM ${fulfillmentTable(balance)}
            WHERE tenant_id = $1 AND environment_id = $2
              AND ${balance.legalEntity!.column} = $3
              AND ${column('posted_stock_balance', 'posted_stock_balance_location_id')} = $4
              AND ${balance.archive.archivedAtColumn} IS NULL`,
          [...scope, location],
        )
      ).rows.map((row) => [row.item, canonical(row.quantity)]),
    );
  const count = entity('stock_count');
  const stored = async (recordId: string) =>
    (
      await fixture.pool.query<Record<string, unknown>>(
        `SELECT ${count.optimisticRevision.column}::integer AS revision,
                ${column('stock_count', 'stock_count_state')} AS state,
                ${column('stock_count', 'stock_count_number')} AS number,
                to_char(${column('stock_count', 'stock_count_counted_at')} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "countedAt"
           FROM ${fulfillmentTable(count)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${count.legalEntity!.column} = $3
            AND ${count.recordIdentity.column} = $4`,
        [...scope, recordId],
      )
    ).rows[0];
  const line = entity('stock_count_line');
  const session = target.relations.find(
    (value) => value.relationId === `${ns}:relation.stock_count_line_session`,
  )!.relationColumn.physicalName;
  const lines = async (recordId: string) =>
    (
      await fixture.pool.query<{
        recordId: string;
        revision: number;
        line: string;
        item: string;
        physical: string | null;
        expected: string;
        counted: string;
        variance: string;
        reversal: string | null;
      }>(
        `SELECT ${line.recordIdentity.column}::text AS "recordId",
                ${line.optimisticRevision.column}::integer AS revision,
                ${column('stock_count_line', 'stock_count_line_line_number')}::text AS line,
                ${column('stock_count_line', 'stock_count_line_item_id')} AS item,
                ${column('stock_count_line', 'stock_count_line_physical_quantity')}::text AS physical,
                ${column('stock_count_line', 'stock_count_line_expected_quantity')}::text AS expected,
                ${column('stock_count_line', 'stock_count_line_counted_quantity')}::text AS counted,
                ${column('stock_count_line', 'stock_count_line_variance_quantity')}::text AS variance,
                ${column('stock_count_line', 'stock_count_line_reversal_of_movement_id')} AS reversal
           FROM ${fulfillmentTable(line)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${line.legalEntity!.column} = $3
            AND ${session} = $4
            AND ${line.archive.archivedAtColumn} IS NULL
          ORDER BY ${column('stock_count_line', 'stock_count_line_line_number')}`,
        [...scope, recordId],
      )
    ).rows.map((row) => ({
      ...row,
      physical: row.physical === null ? null : canonical(row.physical),
      expected: canonical(row.expected),
      counted: canonical(row.counted),
      variance: canonical(row.variance),
    }));
  const movement = entity('inventory_movement');
  const movements = async (source: string) =>
    (
      await fixture.pool.query<{
        movementId: string;
        item: string;
        location: string;
        delta: string;
        role: string;
      }>(
        `SELECT ${movement.recordIdentity.column}::text AS "movementId",
                ${column('inventory_movement', 'inventory_movement_item_id')} AS item,
                ${column('inventory_movement', 'inventory_movement_location_id')} AS location,
                ${column('inventory_movement', 'inventory_movement_quantity_delta')}::text AS delta,
                ${column('inventory_movement', 'inventory_movement_posting_role')} AS role
           FROM ${fulfillmentTable(movement)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${movement.legalEntity!.column} = $3
            AND ${column('inventory_movement', 'inventory_movement_source_id')} = $4
          ORDER BY ${column('inventory_movement', 'inventory_movement_source_line')}`,
        [...scope, source],
      )
    ).rows.map((row) => ({
      ...row,
      delta: canonical(row.delta),
      role: row.role.split(':option.inventory_posting_role_')[1]!,
    }));
  const transaction = entity('inventory_transaction');
  const companions = async () =>
    (
      await fixture.pool.query<{ recordId: string; number: string }>(
        `SELECT ${transaction.recordIdentity.column}::text AS "recordId",
                ${column('inventory_transaction', 'inventory_transaction_number')} AS number
           FROM ${fulfillmentTable(transaction)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${transaction.legalEntity!.column} = $3
            AND ${column('inventory_transaction', 'inventory_transaction_number')} LIKE 'SC-%'`,
        scope,
      )
    ).rows;
  return { companions, lines, movements, onHand, stored };
}

/** One page of a declared list query, in the fixture's company. */
async function listed(
  fixture: Fixture,
  query: string,
  extra: Record<string, ImmutableJsonValue> = {},
) {
  return fixture.app.runtime.entry.run({ headers: {} }, (view) =>
    fixture.app.runtime.queryGateway.invoke(view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: `${ns}:query.${query}`,
      arguments: {
        includeArchived: false,
        [`${ns}:parameter.${query}_legal_entity_scope`]: fixture.scope,
        list: {
          cursor: null,
          matchMode: 'substring',
          pageSize: 100,
          relationLabels: [],
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          search: '',
          sort: [],
          ...extra,
        },
      },
    }),
  );
}

/**
 * The count as the editor and the record page drive it: the header with the
 * values its first save writes, each command on the posting route, each line
 * written as the editor writes one.
 */
function counts(fixture: Fixture) {
  const create = async (
    location: string,
    options: {
      readonly kind?: string;
      readonly narrative?: string;
      readonly state?: string;
      readonly supersedes?: string;
    } = {},
  ) =>
    fixture.create(
      'stock_count',
      {
        kind: kind(options.kind ?? 'initial'),
        state: state(options.state ?? 'draft'),
        location_id: location,
        counted_at: new Date().toISOString(),
        reason_code: 'PHYSICAL_COUNT',
        reason_narrative:
          options.narrative ?? 'Cycle count by the stock count test',
      },
      options.supersedes ? { supersedes: options.supersedes } : {},
    );
  const command = (
    action: 'post' | 'review' | 'start',
    recordId: string,
    expectedRevision: number,
    key = randomUUID(),
  ) =>
    fixture.invoke(
      `stock_count_${action}`,
      { recordId, expectedRevision },
      key,
    );
  const enter = (
    line: { readonly recordId: unknown; readonly revision: unknown },
    physical: string,
  ) =>
    fixture.invoke('stock_count_line_update', {
      recordId: String(line.recordId),
      expectedRevision: Number(line.revision),
      patch: { [lineField('physical_quantity')]: physical },
    });
  const found = (
    count: string,
    item: string,
    lineNumber: string,
    physical: string,
  ) =>
    fixture.create(
      'stock_count_line',
      {
        line_number: lineNumber,
        item_id: item,
        unit_id: 'EA',
        physical_quantity: physical,
        // The editor's line create values: Review replaces all three.
        expected_quantity: '0',
        counted_quantity: '0',
        variance_quantity: '0',
      },
      { session: count },
    );
  return { command, create, enter, found };
}

test(
  'STOCK-COUNTS: a count of one location starts from posted stock, takes what was found, reviews against the ledger and posts the difference',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const read = await storage(fixture);
      const count = counts(fixture);
      const main = fixture.location;
      const before = await read.onHand(main);
      const book = before.get(fixture.item);
      assert.ok(book !== undefined && book !== '0', 'Calgary holds the item');

      // A new count is numbered by the server, a draft, with no lines.
      const created = await count.create(main);
      const countId = created.recordId;
      assert.match(
        String(created.values[countField('number')]),
        /^CNT-\d{6}$/u,
      );
      assert.deepEqual(await read.lines(countId), []);

      // Start counting: one line for every product posted above zero here,
      // none counted yet.
      const started = await count.command('start', countId, created.revision);
      assert.equal(started.outcome, 'succeeded');
      assert.equal(
        started.readBack?.values[countField('state')],
        state('counting'),
      );
      const stocked = [...before.entries()]
        .filter(([, quantity]) => !quantity.startsWith('-') && quantity !== '0')
        .map(([item]) => item)
        .sort();
      const prefilled = await read.lines(countId);
      assert.deepEqual(
        prefilled.map((value) => value.item).sort(),
        stocked,
        'Start counting lists exactly the products posted here',
      );
      assert.ok(prefilled.every((value) => value.physical === null));

      // While counting, the record page's lines state the live book.
      const live = await listed(fixture, 'stock_count_count_lines', {
        parentScope: {
          relationId: `${ns}:relation.stock_count_line_session`,
          recordId: countId,
        },
      });
      const liveLine = live.records.find(
        (record) => record.values[lineField('item_id')] === fixture.item,
      )!;
      assert.equal(liveLine.values[`${ns}:metric.count_book`], book);
      assert.equal(liveLine.values[`${ns}:metric.count_variance`], null);

      // Review refuses a count with a line not counted yet.
      await assert.rejects(
        count.command('review', countId, started.readBack!.revision),
        refusal('INVENTORY_POSTING_INPUT_INVALID', /not counted yet/u),
      );

      // Count everything: one fewer of the demo item than its book, the rest
      // as booked, and a product found that the location did not list.
      for (const value of prefilled)
        await count.enter(
          value,
          value.item === fixture.item
            ? String(Number(book) - 1)
            : before.get(String(value.item))!,
        );
      const extra = await fixture.create(
        'item',
        { sku: 'COUNT-FOUND', name: 'Found during the count', base_unit: 'EA' },
        {},
        false,
      );
      await count.found(
        countId,
        extra.recordId,
        String(prefilled.length + 1),
        '2',
      );

      // Review: expected from the ledger, counted from what was entered.
      const reviewed = await count.command(
        'review',
        countId,
        started.readBack!.revision,
      );
      assert.equal(
        reviewed.readBack?.values[countField('state')],
        state('reviewed'),
      );
      const frozen = await read.lines(countId);
      const demoLine = frozen.find((value) => value.item === fixture.item)!;
      assert.deepEqual(
        [demoLine.expected, demoLine.counted, demoLine.variance],
        [book, String(Number(book) - 1), '-1'],
      );
      const foundLine = frozen.find((value) => value.item === extra.recordId)!;
      assert.deepEqual(
        [foundLine.expected, foundLine.counted, foundLine.variance],
        ['0', '2', '2'],
      );

      // C4: a reviewed count is frozen -- neither it nor its lines change
      // generically -- and the companion relations are in no generic input.
      await assert.rejects(
        fixture.invoke('stock_count_update', {
          recordId: countId,
          expectedRevision: reviewed.readBack!.revision,
          patch: { [countField('state')]: state('counting') },
        }),
        moduleRefusal('MODULE_OPERATION_PRECONDITION_REFUSED'),
      );
      await assert.rejects(
        count.enter(demoLine, '0'),
        moduleRefusal('MODULE_OPERATION_PRECONDITION_REFUSED'),
      );
      await assert.rejects(
        fixture.invoke('stock_count_create', {
          recordId: randomUUID(),
          legalEntityId: fixture.scope,
          values: {
            [countField('kind')]: kind('initial'),
            [countField('state')]: state('draft'),
            [countField('location_id')]: main,
            [countField('counted_at')]: new Date().toISOString(),
          },
          relations: {
            [`${ns}:relation.stock_count_transaction`]: randomUUID(),
          },
        }),
        (error: unknown) => error instanceof Error,
      );
      // ...nor can one be created already reviewed.
      await assert.rejects(
        count.create(main, { state: 'reviewed' }),
        moduleRefusal('MODULE_OPERATION_PRECONDITION_REFUSED'),
      );

      // Post: the kernel posts each line's variance at the count's instant.
      const posted = await count.command(
        'post',
        countId,
        reviewed.readBack!.revision,
      );
      assert.equal(
        posted.readBack?.values[countField('state')],
        state('posted'),
      );
      const after = await read.onHand(main);
      assert.equal(after.get(fixture.item), String(Number(book) - 1));
      assert.equal(after.get(extra.recordId), '2');
      const byItem = (left: readonly unknown[], right: readonly unknown[]) =>
        String(left[0]).localeCompare(String(right[0]));
      assert.deepEqual(
        (await read.movements(countId))
          .filter((value) => value.delta !== '0')
          .map((value) => [value.item, value.location, value.delta, value.role])
          .sort(byItem),
        [
          [fixture.item, main, '-1', 'count'],
          [extra.recordId, main, '2', 'count'],
        ].sort(byItem),
      );

      // ADR-0049 condition 3, proven by the List's query: the count's
      // companion is written, and the stock documents List does not show it.
      const [companion] = (await read.companions()).filter(Boolean);
      assert.ok(companion, 'the kernel wrote the count companion');
      const documents = await listed(fixture, 'inventory_document_list');
      assert.ok(
        documents.records.every(
          (record) =>
            !String(
              record.values[`${ns}:field.inventory_transaction_number`],
            ).startsWith('SC-'),
        ),
        'the stock documents List lists no posting companion',
      );
      const everything = await listed(fixture, 'inventory_transaction_list');
      assert.ok(
        everything.records.some(
          (record) => record.recordId === companion.recordId,
        ),
        'the entity list still holds it: the filter is the List’s',
      );

      // A stale count: reviewed, then a movement dated before its instant is
      // posted. Post refuses it whole and writes nothing.
      const second = await count.create(VANCOUVER_WAREHOUSE);
      const secondStarted = await count.command(
        'start',
        second.recordId,
        second.revision,
      );
      const vancouver = await read.onHand(VANCOUVER_WAREHOUSE);
      for (const value of await read.lines(second.recordId))
        await count.enter(value, vancouver.get(String(value.item))!);
      const secondReviewed = await count.command(
        'review',
        second.recordId,
        secondStarted.readBack!.revision,
      );
      const countedAt = String((await read.stored(second.recordId))!.countedAt);
      const adjustment = randomUUID();
      const header = await fixture.create(
        'inventory_transaction',
        {
          actor_id: 'stock-count-test',
          effective_at: new Date(Date.parse(countedAt) - 1000).toISOString(),
          recorded_at: new Date().toISOString(),
          reason_code: 'DAMAGED',
          reason_narrative: 'Damaged before the count was posted',
          source_type: 'inventoryTransaction',
          source_id: adjustment,
          state: `${ns}:option.inventory_transaction_state_draft`,
          type: `${ns}:option.inventory_transaction_type_adjustment`,
        },
        {},
        true,
        adjustment,
      );
      await fixture.create(
        'inventory_transaction_line',
        {
          from_location_id: VANCOUVER_WAREHOUSE,
          to_location_id: null,
          item_id: fixture.item,
          line_number: '1',
          quantity: '-1',
          unit_id: 'EA',
        },
        { transaction: adjustment },
      );
      await fixture.invoke('inventory_transaction_post', {
        recordId: adjustment,
        expectedRevision: header.revision,
      });
      await assert.rejects(
        count.command(
          'post',
          second.recordId,
          secondReviewed.readBack!.revision,
        ),
        refusal('INVENTORY_COUNT_EXPECTED_STALE'),
      );
      assert.equal(
        (await read.stored(second.recordId))!.state,
        state('reviewed'),
        'a stale count stays reviewed',
      );
      assert.deepEqual(await read.movements(second.recordId), []);

      // Correct: a correction of the posted count, at the same location,
      // started from the products it counted.
      const correction = await count.create(main, {
        kind: 'correction',
        supersedes: countId,
      });
      const correcting = await count.command(
        'start',
        correction.recordId,
        correction.revision,
      );
      const correctionLines = await read.lines(correction.recordId);
      assert.deepEqual(
        correctionLines.map((value) => value.item).sort(),
        frozen.map((value) => value.item).sort(),
        'a correction lists the products the corrected count named',
      );
      const now = await read.onHand(main);
      for (const value of correctionLines)
        await count.enter(
          value,
          value.item === fixture.item
            ? String(Number(now.get(fixture.item)) + 1)
            : now.get(String(value.item))!,
        );
      const correctionReviewed = await count.command(
        'review',
        correction.recordId,
        correcting.readBack!.revision,
      );
      await count.command(
        'post',
        correction.recordId,
        correctionReviewed.readBack!.revision,
      );
      assert.equal(
        (await read.onHand(main)).get(fixture.item),
        String(Number(now.get(fixture.item)) + 1),
        'a correction posts what is counted less what is posted now',
      );

      // Reverse the correction: its movements, exactly undone.
      const reversal = await count.create(main, {
        kind: 'reversal',
        state: 'counting',
        supersedes: correction.recordId,
        narrative: 'Correction entered against the wrong bay',
      });
      const reversed = await count.command(
        'review',
        reversal.recordId,
        reversal.revision,
      );
      const reversalLines = await read.lines(reversal.recordId);
      const correctionMovements = await read.movements(correction.recordId);
      assert.deepEqual(
        reversalLines.map((value) => [value.reversal, value.variance]).sort(),
        correctionMovements
          .map((value) => [value.movementId, canonical(-Number(value.delta))])
          .sort(),
        'each reversal line undoes one movement of the reversed count',
      );
      await count.command(
        'post',
        reversal.recordId,
        reversed.readBack!.revision,
      );
      assert.deepEqual(
        (await read.onHand(main)).get(fixture.item),
        now.get(fixture.item),
        'the reversal restores the stock the correction changed',
      );

      // The corrected count was compensated once; a second correction of it
      // is refused by the kernel at Post.
      const again = await count.create(main, {
        kind: 'correction',
        supersedes: countId,
      });
      const againStarted = await count.command(
        'start',
        again.recordId,
        again.revision,
      );
      const latest = await read.onHand(main);
      for (const value of await read.lines(again.recordId))
        await count.enter(value, latest.get(String(value.item)) ?? '0');
      const againReviewed = await count.command(
        'review',
        again.recordId,
        againStarted.readBack!.revision,
      );
      await assert.rejects(
        count.command('post', again.recordId, againReviewed.readBack!.revision),
        refusal(
          'INVENTORY_COUNT_COMPENSATION_CONFLICT',
          /already has a posted compensation/u,
        ),
      );
    });
  },
);
