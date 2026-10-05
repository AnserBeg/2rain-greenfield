import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  assertSpecialOrderBound,
  withSpecialOrderGate,
} from '../../packages/postgres-provider/src/special-order-support.js';
import {
  normalizeApplicationPackage,
  SurfaceCompositionSchema,
} from '../../packages/canonical-model/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';

test('special-order bounds count shipped and live reserved quantities, including fractional arrivals', () => {
  assert.doesNotThrow(() => assertSpecialOrderBound(125n, 50n, 25n, 50n));
  assert.throws(
    () => assertSpecialOrderBound(125n, 50n, 25n, 51n),
    /SPECIAL_ORDER_ARRIVAL_LIMIT/u,
  );
  assert.throws(
    () => assertSpecialOrderBound(0n, 0n, 0n, 1n),
    /SPECIAL_ORDER_ARRIVAL_LIMIT/u,
  );
  assert.throws(
    () => assertSpecialOrderBound(49n, 50n, 0n, 0n),
    /SPECIAL_ORDER_ARRIVAL_LIMIT/u,
  );
});

test('allocation gate keeps writer transactions on the locked session and cleans up on failure', async () => {
  for (const fail of [false, true]) {
    const events: string[] = [];
    const client = {
      query: async (sql: string) => {
        events.push(sql);
        return { rows: [{ unlocked: true }] };
      },
      release: () => events.push('released'),
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const scope = {
      tenantId: 'tenant',
      environmentId: 'environment',
      legalEntityId: 'company',
    };
    const run = withSpecialOrderGate(pool, scope, async (borrowed) => {
      const writer = await borrowed.connect();
      await writer.query('BEGIN');
      writer.release();
      assert.equal(events.includes('released'), false);
      await writer.query(fail ? 'ROLLBACK' : 'COMMIT');
      if (fail) throw new Error('writer refused');
      return 7;
    });
    if (fail) await assert.rejects(run, /writer refused/u);
    else assert.equal(await run, 7);
    assert.deepEqual(events, [
      'SELECT pg_advisory_lock($1::bigint)',
      'BEGIN',
      fail ? 'ROLLBACK' : 'COMMIT',
      'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
      'released',
    ]);
  }
});

test('special-order metadata reuses the commercial link and declares receipt-backed reserve operations', () => {
  const app = normalizeApplicationPackage(composedApplicationDefinition());
  const route = app.fields.find((field) =>
    field.fieldId.endsWith('sales_order_line_fulfillment_route'),
  )!;
  assert.equal(route.fieldType.kind, 'enumFieldType');
  assert.ok(JSON.stringify(route).includes('fulfillment_route_special_order'));
  const surface = app.surfaces.find((surface) =>
    surface.surfaceId.endsWith('.sales_order_detail'),
  )!;
  assert.ok('composition' in surface && surface.composition);
  const composition = SurfaceCompositionSchema.parse(surface.composition);
  const task = composition.actions.find(
    (action) => action.label === 'Reserve for the special order',
  )!;
  assert.equal(task.inputs.length, 1);
  assert.deepEqual(
    task.steps.map((step) => step.operation.targetId),
    [
      'northstar.app:operation.reservation_create',
      'northstar.app:operation.reservation_reserve',
    ],
  );
  assert.ok(JSON.stringify(task).includes('special_reservable'));
  assert.equal(
    app.relations.filter((link) =>
      link.relationId.endsWith('.sales_order_line_purchase_line'),
    ).length,
    1,
  );
});

test('a rejected borrowed session is destroyed instead of returning to the pool', async () => {
  const rejected = new Error('role cleanup failed');
  let released: Error | boolean | undefined;
  const client = {
    query: async () => ({ rows: [{ unlocked: true }] }),
    release: (error?: Error | boolean) => {
      released = error;
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  await assert.rejects(
    withSpecialOrderGate(
      pool,
      {
        tenantId: 'tenant',
        environmentId: 'environment',
        legalEntityId: 'company',
      },
      async (borrowed) => {
        (await borrowed.connect()).release(rejected);
        return 1;
      },
    ),
    (error) => error === rejected,
  );
  assert.equal(released, rejected);
});
