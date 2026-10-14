import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { InventoryPostingError } from '../../packages/postgres-provider/src/inventory-posting-error.js';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/inventory-posting-capability-executor.js';
import { ModuleRuntimeInterpreterError } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';
/** The demo seed's locations: Calgary warehouse holds the opening stock. */
const EDMONTON_STORE = '71000000-0000-4000-8000-000000000022';
const VANCOUVER_WAREHOUSE = '71000000-0000-4000-8000-000000000023';
const BELTLINE_STORE = '71000000-0000-4000-8000-000000000024';

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];
type Line = readonly [from: string | null, to: string | null, quantity: string];
interface StockDocument {
  readonly recordId: string;
  readonly revision: number;
  readonly number: ImmutableJsonValue | undefined;
}

const field = (local: string) => `${ns}:field.inventory_transaction_${local}`;
const option = (local: string) => `${ns}:option.inventory_transaction_${local}`;
const refusal = (code: string, message?: string) => (error: unknown) => {
  assert.ok(
    error instanceof InventoryPostingError,
    `expected ${code}, got ${String(error)}`,
  );
  assert.equal(error.code, code);
  if (message !== undefined) assert.equal(error.message, `${code}: ${message}`);
  return true;
};

/**
 * Independent facts, read from PostgreSQL directly: the posted quantity of an
 * item at a location in the fixture's company, the movements a document
 * posted, and the stored document itself.
 */
async function storage(fixture: Fixture) {
  const target = await governedStorageTarget();
  const entity = (local: string) =>
    target.entities.find(
      (value) => value.entityId === `${ns}:entity.${local}`,
    )!;
  const column = (local: string, name: string) =>
    fulfillmentColumn(entity(local), name);
  const balance = entity('posted_stock_balance');
  const movement = entity('inventory_movement');
  const transaction = entity('inventory_transaction');
  const scope = [
    fixture.app.runtime.identity.tenantId,
    fixture.app.runtime.identity.environmentId,
    fixture.scope,
  ];
  const onHand = async (location: string, item = fixture.item) =>
    (
      await fixture.pool.query<{ quantity: string }>(
        `SELECT ${column('posted_stock_balance', 'posted_stock_balance_posted_quantity')}::text AS quantity
           FROM ${fulfillmentTable(balance)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${balance.legalEntity!.column} = $3
            AND ${column('posted_stock_balance', 'posted_stock_balance_item_id')} = $4
            AND ${column('posted_stock_balance', 'posted_stock_balance_location_id')} = $5
            AND ${balance.archive.archivedAtColumn} IS NULL`,
        [...scope, item, location],
      )
    ).rows.map((row) => canonical(row.quantity))[0] ?? null;
  const movements = async (document: string) =>
    (
      await fixture.pool.query<Record<string, string>>(
        `SELECT ${column('inventory_movement', 'inventory_movement_location_id')} AS location,
                ${column('inventory_movement', 'inventory_movement_quantity_delta')}::text AS delta,
                ${column('inventory_movement', 'inventory_movement_posting_role')} AS role,
                ${column('inventory_movement', 'inventory_movement_reason_code')} AS reason,
                ${column('inventory_movement', 'inventory_movement_source_type')} AS source
           FROM ${fulfillmentTable(movement)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${movement.legalEntity!.column} = $3
            AND ${column('inventory_movement', 'inventory_movement_source_id')} = $4
          ORDER BY ${column('inventory_movement', 'inventory_movement_quantity_delta')}`,
        [...scope, document],
      )
    ).rows.map((row) => ({
      ...row,
      delta: canonical(row.delta),
      role: row.role!.split(':option.inventory_posting_role_')[1]!,
    }));
  const stored = async (document: string) =>
    (
      await fixture.pool.query<Record<string, unknown>>(
        `SELECT ${transaction.optimisticRevision.column}::integer AS revision,
                ${column('inventory_transaction', 'inventory_transaction_state')} AS state
           FROM ${fulfillmentTable(transaction)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${transaction.legalEntity!.column} = $3
            AND ${transaction.recordIdentity.column} = $4`,
        [...scope, document],
      )
    ).rows[0];
  const numbers = async () =>
    (
      await fixture.pool.query<{ number: string }>(
        `SELECT ${column('inventory_transaction', 'inventory_transaction_number')} AS number
           FROM ${fulfillmentTable(transaction)}
          WHERE tenant_id = $1 AND environment_id = $2
          ORDER BY 1`,
        scope.slice(0, 2),
      )
    ).rows.map((row) => row.number);
  return { movements, numbers, onHand, stored };
}

/** A stored exact decimal as a person reads it: `-2`, not `-2.000…`. */
function canonical(value: unknown): string {
  const text = String(value);
  return /^-?\d+\.\d+$/u.test(text)
    ? text.replace(/(\.\d*?[1-9])0+$|\.0+$/u, '$1')
    : text;
}

test(
  'INVENTORY-PARITY: a stock document is numbered by the server and posts as itself: an adjustment, a transfer and opening stock, each refused by name when wrong',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const read = await storage(fixture);
      const main = fixture.location;

      /**
       * A stock document as the editor saves one: the header with the values
       * its first save writes -- the draft state and the document as its own
       * posting source -- then each line, From and To by the sign.
       */
      const document = async (
        type: string,
        reason: string,
        lines: readonly Line[],
        options: {
          readonly narrative?: string | null;
          readonly source?: readonly [type: string, id: string];
        } = {},
      ): Promise<StockDocument> => {
        const recordId = randomUUID();
        const header = await fixture.create(
          'inventory_transaction',
          {
            actor_id: 'stock-document-test',
            effective_at: new Date().toISOString(),
            recorded_at: new Date().toISOString(),
            reason_code: reason,
            reason_narrative:
              options.narrative === undefined
                ? `${reason} by the stock document test`
                : options.narrative,
            source_type: options.source?.[0] ?? 'inventoryTransaction',
            source_id: options.source?.[1] ?? recordId,
            state: option('state_draft'),
            type: option(`type_${type}`),
          },
          {},
          true,
          recordId,
        );
        for (const [index, [from, to, quantity]] of lines.entries())
          await fixture.create(
            'inventory_transaction_line',
            {
              from_location_id: from,
              to_location_id: to,
              item_id: fixture.item,
              line_number: String(index + 1),
              quantity,
              unit_id: 'EA',
            },
            { transaction: recordId },
          );
        return {
          recordId,
          revision: header.revision,
          number: header.values[field('number')],
        };
      };
      const post = (draft: StockDocument, key = randomUUID()) =>
        fixture.invoke(
          'inventory_transaction_post',
          { recordId: draft.recordId, expectedRevision: draft.revision },
          key,
        );
      /** A refused Post changes nothing: no movement, still a draft. */
      const unchanged = async (draft: StockDocument) => {
        assert.deepEqual(await read.movements(draft.recordId), []);
        assert.deepEqual(await read.stored(draft.recordId), {
          revision: draft.revision,
          state: option('state_draft'),
        });
      };

      // Receipts, shipments and a reservation first: their companion
      // transactions carry `GR-`/`SH-` numbers in the same column, and the
      // item page's shipment leaves 1 of 3 reserved at Calgary.
      await fixture.measure('item_stock');
      assert.equal(await read.onHand(main), '13');
      assert.equal(await read.onHand(VANCOUVER_WAREHOUSE), '6');
      const before = await read.numbers();
      assert.deepEqual(
        before.filter((number) => number.startsWith('STK-')),
        ['STK-000001', 'STK-000002'],
      );
      assert.ok(before.some((number) => /^GR-/u.test(number)));
      assert.ok(before.some((number) => /^SH-/u.test(number)));

      // Numbered by the server, in sequence, past every companion number.
      const damaged = await document('adjustment', 'DAMAGED', [
        [main, null, '-2'],
      ]);
      assert.equal(damaged.number, 'STK-000003');
      const foreign = await document('adjustment', 'DAMAGED', [
        [main, null, '-1'],
      ]);
      assert.equal(foreign.number, 'STK-000004');
      // A typed number is refused by name and writes nothing.
      const typed = randomUUID();
      await assert.rejects(
        fixture.invoke('inventory_transaction_create', {
          recordId: typed,
          legalEntityId: fixture.scope,
          values: {
            [field('number')]: 'STK-999999',
            [field('actor_id')]: 'stock-document-test',
            [field('effective_at')]: new Date().toISOString(),
            [field('recorded_at')]: new Date().toISOString(),
            [field('source_id')]: typed,
            [field('source_type')]: 'inventoryTransaction',
            [field('state')]: option('state_draft'),
            [field('type')]: option('type_adjustment'),
          },
          relations: {},
        }),
        (error: unknown) => {
          assert.ok(error instanceof ModuleRuntimeInterpreterError);
          assert.equal(error.code, 'MODULE_FIELD_UNSUPPORTED');
          assert.equal(error.subjectId, field('number'));
          return true;
        },
      );
      assert.equal(await read.stored(typed), undefined);

      // An adjustment: two damaged units leave Calgary, and the movement
      // carries the reason and names the document as its source.
      const posted = await post(damaged);
      assert.equal(posted.outcome, 'succeeded');
      assert.equal(posted.readBack?.revision, damaged.revision + 1);
      assert.equal(
        posted.readBack?.values[field('state')],
        option('state_posted'),
      );
      assert.equal(await read.onHand(main), '11');
      assert.deepEqual(await read.movements(damaged.recordId), [
        {
          location: main,
          delta: '-2',
          role: 'adjustment',
          reason: 'DAMAGED',
          source: 'inventoryTransaction',
        },
      ]);

      // A draft naming another source is refused by name, not as a state
      // conflict deep in the posting.
      const misnamed = await document(
        'adjustment',
        'DAMAGED',
        [[main, null, '-1']],
        { source: ['test', randomUUID()] },
      );
      await assert.rejects(
        post(misnamed),
        refusal(
          'INVENTORY_POSTING_INPUT_INVALID',
          'the draft does not name itself as its posting source',
        ),
      );
      await unchanged(misnamed);

      // The line's columns follow its sign.
      const addedInFrom = await document('adjustment', 'FOUND', [
        [main, null, '3'],
      ]);
      await assert.rejects(
        post(addedInFrom),
        refusal(
          'INVENTORY_POSTING_INPUT_INVALID',
          'line 1: a positive adjustment adds stock at its To location and names no From location',
        ),
      );
      await unchanged(addedInFrom);
      const takenFromTo = await document('adjustment', 'LOST', [
        [null, main, '-3'],
      ]);
      await assert.rejects(
        post(takenFromTo),
        refusal(
          'INVENTORY_POSTING_INPUT_INVALID',
          'line 1: a negative adjustment takes stock from its From location and names no To location',
        ),
      );
      await unchanged(takenFromTo);

      // More than is on hand: the kernel's own refusal, unchanged.
      const tooMany = await document('adjustment', 'LOST', [
        [main, null, '-999'],
      ]);
      await assert.rejects(post(tooMany), refusal('INVENTORY_STOCK_NEGATIVE'));
      await unchanged(tooMany);
      assert.equal(await read.onHand(main), '11');

      // A transfer: five unreserved units move from Vancouver to Edmonton in
      // one posting -- out of one location, into the other, both as
      // transfers, under this one document.
      const moved = await document(
        'transfer',
        'RELOCATION',
        [[VANCOUVER_WAREHOUSE, EDMONTON_STORE, '5']],
        { narrative: null },
      );
      const transferKey = randomUUID();
      const transferred = await post(moved, transferKey);
      assert.equal(transferred.outcome, 'succeeded');
      assert.equal(await read.onHand(VANCOUVER_WAREHOUSE), '1');
      assert.equal(await read.onHand(EDMONTON_STORE), '5');
      assert.deepEqual(await read.movements(moved.recordId), [
        {
          location: VANCOUVER_WAREHOUSE,
          delta: '-5',
          role: 'transfer',
          reason: 'RELOCATION',
          source: 'inventoryTransaction',
        },
        {
          location: EDMONTON_STORE,
          delta: '5',
          role: 'transfer',
          reason: 'RELOCATION',
          source: 'inventoryTransaction',
        },
      ]);
      assert.deepEqual(await read.stored(moved.recordId), {
        revision: moved.revision + 1,
        state: option('state_posted'),
      });
      // The same request again returns what it did, and moves nothing more.
      const transferRetried = await post(moved, transferKey);
      assert.deepEqual(transferRetried.trust, transferred.trust);
      assert.equal(await read.onHand(VANCOUVER_WAREHOUSE), '1');
      assert.equal((await read.movements(moved.recordId)).length, 2);

      // Reserved stock does not move: Calgary holds 11 with 1 reserved, so
      // moving all 11 is refused and nothing is written.
      const reserved = await document(
        'transfer',
        'RELOCATION',
        [[main, BELTLINE_STORE, '11']],
        { narrative: null },
      );
      await assert.rejects(
        post(reserved),
        refusal('FULFILLMENT_RESERVATION_SHORTAGE'),
      );
      await unchanged(reserved);
      assert.equal(await read.onHand(main), '11');
      assert.equal(await read.onHand(BELTLINE_STORE), null);
      // A transfer names two different locations and moves a quantity.
      const inPlace = await document(
        'transfer',
        'RELOCATION',
        [[main, main, '1']],
        { narrative: null },
      );
      await assert.rejects(
        post(inPlace),
        refusal(
          'INVENTORY_POSTING_INPUT_INVALID',
          'line 1: a transfer takes stock from its From location to a different To location',
        ),
      );
      await unchanged(inPlace);

      // Every other stored type gets the route's declared refusal, byte for
      // byte what release verification compares.
      const declared =
        INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY.verificationRefusal;
      for (const type of ['count_correction', 'goods_receipt']) {
        const other = await document(type, 'COUNT_ERROR', [[null, main, '1']]);
        await assert.rejects(post(other), (error: unknown) => {
          assert.ok(error instanceof InventoryPostingError);
          assert.equal(error.code, declared.code);
          assert.equal(error.message, declared.reason);
          return true;
        });
        await unchanged(other);
      }

      // Opening stock: an adjustment that only adds, and only where the item
      // has none yet.
      const opening = await document('adjustment', 'OPENING', [
        [null, BELTLINE_STORE, '20'],
      ]);
      const openingKey = randomUUID();
      const opened = await post(opening, openingKey);
      assert.equal(opened.outcome, 'succeeded');
      assert.equal(await read.onHand(BELTLINE_STORE), '20');
      assert.deepEqual(await read.movements(opening.recordId), [
        {
          location: BELTLINE_STORE,
          delta: '20',
          role: 'adjustment',
          reason: 'OPENING',
          source: 'inventoryTransaction',
        },
      ]);
      // A retry of the posted opening is not judged against its own stock:
      // it returns the original result.
      const openingRetried = await post(opening, openingKey);
      assert.deepEqual(openingRetried.trust, opened.trust);
      assert.equal(await read.onHand(BELTLINE_STORE), '20');
      assert.equal((await read.movements(opening.recordId)).length, 1);
      const openingTaken = await document('adjustment', 'OPENING', [
        [main, null, '-1'],
      ]);
      await assert.rejects(
        post(openingTaken),
        refusal(
          'INVENTORY_POSTING_INPUT_INVALID',
          'line 1: opening stock only adds stock',
        ),
      );
      await unchanged(openingTaken);
      const openingOver = await document('adjustment', 'OPENING', [
        [null, main, '5'],
      ]);
      await assert.rejects(
        post(openingOver),
        refusal(
          'INVENTORY_POSTING_INPUT_INVALID',
          'line 1: opening stock goes only where the item has none yet',
        ),
      );
      await unchanged(openingOver);
      const openingMoved = await document(
        'transfer',
        'OPENING',
        [[main, BELTLINE_STORE, '1']],
        { narrative: null },
      );
      await assert.rejects(
        post(openingMoved),
        refusal(
          'INVENTORY_POSTING_INPUT_INVALID',
          'opening stock is recorded as an adjustment',
        ),
      );
      await unchanged(openingMoved);
      assert.equal(await read.onHand(main), '11');
    });
  },
);
