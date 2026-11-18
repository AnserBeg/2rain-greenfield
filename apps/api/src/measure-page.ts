import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  parsePinnedOperationCatalog,
  SEMANTIC_OPERATION_REQUEST_VERSION,
} from '../../../packages/runtime/src/semantic-operation-gateway.js';
import type { ImmutableJsonValue } from '../../../packages/runtime/src/request-runtime-view.js';

import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  startComposedApplication,
} from './composition-root.js';

/**
 * SPEED-1 slice 6: the purchase order detail page's wall and CPU time, the
 * same way under tsx and compiled, on one machine:
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/postgres \
 *     node --import tsx apps/api/src/measure-page.ts
 *   DATABASE_URL=... node scripts/start-production.mjs dist/apps/api/src/measure-page.js
 *
 * It installs the demo seed into a fresh database, creates one released
 * purchase order with two lines through the governed operations, loads its
 * detail page `MEASURE_WARMUP` times (default 5), then `MEASURE_RUNS` times
 * (default 20), and prints one JSON line: median and p95 wall per request at
 * the client, the server's own `app` duration, and this process's CPU per
 * request (server and client share the process). The database must be empty.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write('MEASURE_PAGE_FAILED DATABASE_URL is required\n');
  process.exit(1);
}
const warmup = Number(process.env.MEASURE_WARMUP ?? 5);
const runs = Number(process.env.MEASURE_RUNS ?? 20);
const ns = 'northstar.app';
const scope = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
const supplier = '71000000-0000-4000-8000-000000000001';
const item = '71000000-0000-4000-8000-000000000011';
const location = '71000000-0000-4000-8000-000000000021';

const app = await startComposedApplication({
  databaseUrl,
  port: 0,
  seedProfile: 'demo',
  tenantSlug: 'measure-page',
});
try {
  const invoke = (local: string, input: ImmutableJsonValue) =>
    app.runtime.entry.run(
      { headers: { cookie: 'northstar-demo-actor=buyer' } },
      (view) => {
        const operationId = `${ns}:operation.${local}`;
        const operation = parsePinnedOperationCatalog(
          view.projections.operation.payload,
        ).find((value) => value.operationId === operationId)!;
        return app.runtime.operationGateway.invoke(
          view,
          {
            schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
            operationId,
            input,
            idempotencyKey: randomUUID(),
            confirmationGrant:
              operation.confirmation === 'humanRequired'
                ? app.runtime.operationMediation.issueConfirmationGrant(
                    view,
                    operationId,
                    input,
                  )
                : null,
          },
          app.runtime.operationMediation.issueInvocation(view, 'UI'),
        );
      },
    );
  const create = async (
    local: string,
    values: Record<string, ImmutableJsonValue>,
    relations: Record<string, string> = {},
    scoped = true,
  ) => {
    const result = await invoke(`${local}_create`, {
      recordId: randomUUID(),
      ...(scoped ? { legalEntityId: scope } : {}),
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
    if (!result.readBack) throw new Error(`${local} create withheld`);
    return result.readBack;
  };
  await create(
    'party_role',
    { kind: `${ns}:option.supplier`, status: `${ns}:option.active` },
    { party: supplier },
    false,
  );
  const order = await create('purchase_order', {
    supplier_party_id: supplier,
    order_date: new Date().toISOString(),
    expected_date: null,
    currency: 'CAD',
    notes: null,
    receiving_location_id: location,
  });
  for (const [index, ordered] of ['6', '3'].entries())
    await create(
      'purchase_order_line',
      {
        line_number: String(index + 1),
        item_id: item,
        ordered_quantity: ordered,
        unit_price: '2.5',
      },
      { order: order.recordId },
    );
  const released = await invoke('purchase_order_release', {
    recordId: order.recordId,
    expectedRevision: order.revision,
  });
  if (released.outcome !== 'succeeded') throw new Error('release refused');

  const page = new URL(app.baseUrl);
  page.searchParams.set('surface', `${ns}:surface.purchase_order_detail`);
  page.searchParams.set(
    `${ns}:parameter.commercial_purchase_order_get_legal_entity_scope`,
    scope,
  );
  page.searchParams.set('record', order.recordId);
  const load = async () => {
    const started = performance.now();
    const response = await fetch(page, { redirect: 'manual' });
    const html = await response.text();
    const wall = performance.now() - started;
    if (response.status !== 200 || !html.includes(order.recordId))
      throw new Error(`the detail page did not render (${response.status})`);
    const server = /(?:^|,\s*)app;dur=([\d.]+)/u.exec(
      response.headers.get('server-timing') ?? '',
    );
    return { server: server ? Number(server[1]) : Number.NaN, wall };
  };
  for (let index = 0; index < warmup; index += 1) await load();
  const walls: number[] = [];
  const servers: number[] = [];
  const cpu = process.cpuUsage();
  for (let index = 0; index < runs; index += 1) {
    const sample = await load();
    walls.push(sample.wall);
    servers.push(sample.server);
  }
  const used = process.cpuUsage(cpu);
  const quantile = (values: number[], q: number) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  };
  process.stdout.write(
    `MEASURE_PAGE ${JSON.stringify({
      cpuMillisecondsPerRequest: Number(
        ((used.user + used.system) / 1000 / runs).toFixed(1),
      ),
      node: process.version,
      runs,
      serverMedianMilliseconds: Number(quantile(servers, 0.5).toFixed(1)),
      wallMedianMilliseconds: Number(quantile(walls, 0.5).toFixed(1)),
      wallP95Milliseconds: Number(quantile(walls, 0.95).toFixed(1)),
    })}\n`,
  );
} finally {
  await app.close();
}
