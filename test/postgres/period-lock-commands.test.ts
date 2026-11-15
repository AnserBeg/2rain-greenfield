import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  fulfillmentColumn,
  fulfillmentTable,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { InventoryPostingError } from '../../packages/postgres-provider/src/inventory-posting-error.js';
import { ModuleRuntimeInterpreterError } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';
const closedThrough = `${ns}:field.inventory_period_lock_closed_through`;
const HOUR = 3_600_000;

const refused = (code: string) => (error: unknown) => {
  assert.ok(
    error instanceof ModuleRuntimeInterpreterError ||
      error instanceof InventoryPostingError,
    `expected ${code}, got ${String(error)}`,
  );
  assert.equal(error.code, code);
  return true;
};

/**
 * WAREHOUSE-MODE: the period lock page's two commands are the lock's own two
 * operations, and the module runtime holds each to its direction -- an
 * advance never reopens and a reopen never closes -- whatever calls them. A
 * closed period refuses postings inside the posting transaction, as before.
 */
test(
  'WAREHOUSE-MODE: a period lock closes only later and reopens only earlier, each through its own operation, and a closed period refuses postings',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      // The company's one lock, provisioned with the company, read directly.
      const target = await governedStorageTarget();
      const entity = target.entities.find(
        (value) => value.entityId === `${ns}:entity.inventory_period_lock`,
      )!;
      assert.ok(entity.periodLock && entity.legalEntity);
      const stored = async () => {
        const { rows } = await fixture.pool.query<{
          closed_through: Date | null;
          record_id: string;
          revision: string;
        }>(
          `SELECT ${entity.recordIdentity.column} AS record_id,
                  ${entity.optimisticRevision.column}::text AS revision,
                  ${entity.periodLock!.closedThroughColumn} AS closed_through
             FROM ${fulfillmentTable(entity)}
            WHERE tenant_id = $1 AND environment_id = $2
              AND ${entity.legalEntity!.column} = $3`,
          [
            fixture.app.runtime.identity.tenantId,
            fixture.app.runtime.identity.environmentId,
            fixture.scope,
          ],
        );
        assert.equal(rows.length, 1, 'one lock per company');
        return {
          recordId: rows[0]!.record_id,
          revision: Number(rows[0]!.revision),
          closedThrough: rows[0]!.closed_through?.toISOString() ?? null,
        };
      };
      const lock = await stored();
      assert.equal(lock.closedThrough, null);
      const move = async (
        operation: 'advance_period_lock' | 'reopen_period',
        instant: string | null,
      ) => {
        const current = await stored();
        return fixture.invoke(operation, {
          recordId: current.recordId,
          expectedRevision: current.revision,
          patch: { [closedThrough]: instant },
        });
      };
      const moved = async (
        operation: 'advance_period_lock' | 'reopen_period',
        instant: string | null,
      ) => {
        const before = await stored();
        const result = await move(operation, instant);
        assert.equal(result.outcome, 'succeeded');
        // Every move is a governed change with its trust receipt.
        assert.ok(result.trust);
        assert.deepEqual(await stored(), {
          recordId: before.recordId,
          revision: before.revision + 1,
          closedThrough: instant,
        });
      };
      const unmoved = async (
        operation: 'advance_period_lock' | 'reopen_period',
        instant: string | null,
      ) => {
        const before = await stored();
        await assert.rejects(
          move(operation, instant),
          refused('MODULE_PERIOD_LOCK_DIRECTION_INVALID'),
        );
        assert.deepEqual(await stored(), before);
      };
      const now = Date.now();
      const at = (offset: number) => new Date(now + offset).toISOString();

      // Nothing is closed: there is nothing to reopen, and an advance closes
      // through any instant -- but never through none.
      await unmoved('reopen_period', at(-24 * HOUR));
      await unmoved('advance_period_lock', null);
      await moved('advance_period_lock', at(-24 * HOUR));
      // An advance moves only later: neither back nor in place.
      await unmoved('advance_period_lock', at(-25 * HOUR));
      await unmoved('advance_period_lock', at(-24 * HOUR));
      // A reopen moves only earlier: never later, never in place.
      await unmoved('reopen_period', at(-23 * HOUR));
      await unmoved('reopen_period', at(-24 * HOUR));

      // Closed through an hour from now, a stock document dated now is
      // refused inside the posting transaction and posts nothing.
      await moved('advance_period_lock', at(HOUR));
      const recordId = randomUUID();
      const header = await fixture.create(
        'inventory_transaction',
        {
          actor_id: 'period-lock-test',
          effective_at: new Date().toISOString(),
          recorded_at: new Date().toISOString(),
          reason_code: 'FOUND',
          reason_narrative: 'Found while the period was closed',
          source_type: 'inventoryTransaction',
          source_id: recordId,
          state: `${ns}:option.inventory_transaction_state_draft`,
          type: `${ns}:option.inventory_transaction_type_adjustment`,
        } satisfies Record<string, ImmutableJsonValue>,
        {},
        true,
        recordId,
      );
      await fixture.create(
        'inventory_transaction_line',
        {
          from_location_id: null,
          to_location_id: fixture.location,
          item_id: fixture.item,
          line_number: '1',
          quantity: '1',
          unit_id: 'EA',
        },
        { transaction: recordId },
      );
      const post = () =>
        fixture.invoke('inventory_transaction_post', {
          recordId,
          expectedRevision: header.revision,
        });
      await assert.rejects(post(), refused('INVENTORY_PERIOD_CLOSED'));
      const movements = async () => {
        const movement = target.entities.find(
          (value) => value.entityId === `${ns}:entity.inventory_movement`,
        )!;
        const { rows } = await fixture.pool.query(
          `SELECT 1 FROM ${fulfillmentTable(movement)}
            WHERE tenant_id = $1 AND environment_id = $2
              AND ${fulfillmentColumn(movement, 'inventory_movement_source_id')} = $3`,
          [
            fixture.app.runtime.identity.tenantId,
            fixture.app.runtime.identity.environmentId,
            recordId,
          ],
        );
        return rows.length;
      };
      assert.equal(await movements(), 0);

      // Reopened to yesterday, the same document posts.
      await moved('reopen_period', at(-24 * HOUR));
      const posted = await post();
      assert.equal(posted.outcome, 'succeeded');
      assert.equal(await movements(), 1);

      // A reopen may open the period entirely; then it is open.
      await moved('reopen_period', null);
      await unmoved('reopen_period', at(-48 * HOUR));
    });
  },
);
