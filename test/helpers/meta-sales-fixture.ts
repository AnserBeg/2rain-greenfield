import assert from 'node:assert/strict';
import { FULFILLMENT_CAPABILITY_ID } from '../../packages/domain/src/sales/definition.js';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  startComposedApplication,
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
} from '../../apps/api/src/composition-root.js';
import { withEphemeralPostgres } from './postgres.js';
import {
  parsePinnedOperationCatalog,
  SEMANTIC_OPERATION_REQUEST_VERSION,
  type TrustedInvocationChannel,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';

export async function withMetaSalesFixture(
  run: (fixture: Awaited<ReturnType<typeof seed>>) => Promise<void>,
): Promise<void> {
  await withEphemeralPostgres('meta-sales', async ({ connection, pool }) => {
    const app = await startComposedApplication({
      databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
      port: 0,
      tenantSlug: 'meta-sales',
    });
    try {
      await run(await seed(app, pool));
    } finally {
      await app.close();
    }
  });
}
async function seed(
  app: Awaited<ReturnType<typeof startComposedApplication>>,
  pool: Pool,
) {
  const ns = 'northstar.app';
  const scope = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
  const item = '71000000-0000-4000-8000-000000000011';
  const location = '71000000-0000-4000-8000-000000000021';
  const customer = '71000000-0000-4000-8000-000000000001';
  const invoke = (
    local: string,
    input: ImmutableJsonValue,
    key = randomUUID(),
    channel: TrustedInvocationChannel = 'UI',
  ) =>
    app.runtime.entry.run({ headers: {} }, (view) => {
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
          idempotencyKey: key,
          confirmationGrant:
            operation.confirmation === 'humanRequired'
              ? app.runtime.operationMediation.issueConfirmationGrant(
                  view,
                  operationId,
                  input,
                )
              : null,
        },
        app.runtime.operationMediation.issueInvocation(view, channel),
      );
    });
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
    if (!result.readBack) throw new Error('Fixture create has no read-back');
    return result.readBack;
  };
  const now = new Date().toISOString();
  const stock = await create('inventory_transaction', {
    actor_id: 'meta-sales-fixture',
    effective_at: now,
    number: `ADJ-${randomUUID()}`,
    reason_code: 'SETUP',
    reason_narrative: 'Isolated metadata workspace fixture',
    recorded_at: now,
    source_id: randomUUID(),
    source_type: 'test',
    state: `${ns}:option.inventory_transaction_state_draft`,
    type: `${ns}:option.inventory_transaction_type_adjustment`,
  });
  await create(
    'inventory_transaction_line',
    {
      from_location_id: null,
      item_id: item,
      line_number: '1',
      quantity: '10',
      to_location_id: location,
      unit_id: 'EA',
    },
    { transaction: stock.recordId },
  );
  await invoke('inventory_transaction_post', {
    recordId: stock.recordId,
    expectedRevision: stock.revision,
  });
  await create(
    'party_role',
    {
      kind: `${ns}:option.customer`,
      status: `${ns}:option.active`,
    },
    { party: customer },
    false,
  );
  const order = await create('sales_order', {
    customer_party_id: customer,
    order_date: now,
    requested_date: now,
    currency: 'CAD',
    notes: 'Metadata-rendered fulfillment',
    // Confirm needs a complete ship-to (ruling E); the shipment copies it.
    ship_to_name: 'Receiving dock',
    ship_to_street: '100 Industrial Way',
    ship_to_city: 'Calgary',
    ship_to_region: 'AB',
    ship_to_postal_code: 'T2P 0A1',
    ship_to_country: 'Canada',
  });
  const line = await create(
    'sales_order_line',
    {
      line_number: '1',
      item_id: item,
      unit_id: 'EA',
      ordered_quantity: '10',
      unit_price: '12.5',
    },
    { order: order.recordId },
  );
  await invoke('sales_order_release', {
    recordId: order.recordId,
    expectedRevision: order.revision,
  });
  const url = new URL(app.baseUrl);
  url.searchParams.set('surface', `${ns}:surface.sales_order_detail`);
  url.searchParams.set('record', order.recordId);
  // The order workspace reads through the commercial order query (its
  // totals), so the scope operand is that query's parameter.
  url.searchParams.set(
    `${ns}:parameter.commercial_order_get_legal_entity_scope`,
    scope,
  );
  return {
    app,
    pool,
    invoke,
    create,
    order,
    line,
    url: url.href,
    scope,
    item,
    location,
    customer,
  };
}
if (process.argv.includes('--serve')) {
  void withMetaSalesFixture(async (fixture) => {
    console.log(`META_SALES_URL=${fixture.url}`);
    await new Promise<void>((resolve) => {
      process.once('SIGTERM', () => resolve());
      process.once('SIGINT', () => resolve());
    });
    if (process.argv.includes('--verify')) {
      // Lifecycle receipts use operation IDs; shipment posting is receipted by
      // the accepted kernel under its capability ID, linked to its trust document.
      const expected = [
        'northstar.app:operation.reservation_release',
        'northstar.app:operation.reservation_reserve',
        FULFILLMENT_CAPABILITY_ID,
      ].sort();
      const { rows } = await fixture.pool.query(
        `SELECT receipt.action_id FROM platform.semantic_operation_receipts receipt
         JOIN platform.trust_business_change_documents document
           ON document.tenant_id=receipt.tenant_id AND document.environment_id=receipt.environment_id
          AND document.change_document_id=receipt.change_document_id
         WHERE receipt.action_id=ANY($1::text[])`,
        [expected],
      );
      assert.deepEqual(rows.map((row) => row.action_id).sort(), expected);
      await fixture.app.runtime.entry.run({ headers: {} }, async (view) => {
        const discovery = view.projections.agent.payload as {
          readonly queries: readonly {
            readonly queryId: string;
            readonly fieldIds: readonly string[];
          }[];
          readonly operations: readonly {
            readonly operationId: string;
            readonly readBackQueryId: string;
          }[];
        };
        assert.ok(
          discovery.queries
            .find(
              (query) =>
                query.queryId === 'northstar.app:query.sales_order_line_list',
            )
            ?.fieldIds.includes('northstar.app:metric.shipped'),
        );
        assert.equal(
          discovery.operations.find(
            (operation) =>
              operation.operationId ===
              'northstar.app:operation.reservation_reserve',
          )?.readBackQueryId,
          'northstar.app:query.reservation_get',
        );
      });
      const extra = await fixture.create(
        'reservation',
        {
          number: 'AGENT-PARITY',
          state: 'northstar.app:option.reservation_state_draft',
          item_id: fixture.item,
          location_id: fixture.location,
          quantity: '1',
          unit_id: 'EA',
          reason: 'Agent gateway parity',
        },
        { order_line: fixture.line.recordId },
      );
      const key = randomUUID();
      const input = {
        recordId: extra.recordId,
        expectedRevision: extra.revision,
      };
      const reserved = await fixture.invoke(
        'reservation_reserve',
        input,
        key,
        'AGENT',
      );
      assert.ok(reserved.readBack);
      const replay = await fixture.invoke(
        'reservation_reserve',
        input,
        key,
        'AGENT',
      );
      assert.deepEqual(replay.trust, reserved.trust);
      await fixture.invoke(
        'reservation_release',
        {
          recordId: extra.recordId,
          expectedRevision: reserved.readBack.revision,
        },
        randomUUID(),
        'AGENT',
      );
      console.log('META_SALES_VERIFIED');
    }
  });
}
