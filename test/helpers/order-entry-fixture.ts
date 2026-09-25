import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import type { Pool } from 'pg';
import {
  startComposedApplication,
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
} from '../../apps/api/src/composition-root.js';
import type { ComposedApplicationSeedProfile } from '../../packages/domain/src/app/seed.js';
import { withEphemeralPostgres } from './postgres.js';
import {
  parsePinnedOperationCatalog,
  SEMANTIC_OPERATION_REQUEST_VERSION,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from './governed-storage-target.js';
import {
  fulfillmentTable,
  fulfillmentColumn,
  quoteFulfillmentIdentifier as q,
} from '../../packages/postgres-provider/src/fulfillment.js';

/**
 * Masters, authorized development identity and opening stock only. Orders are
 * browser-created. `distributor` adds master volume only -- enough parties and
 * products that a picker's first page cannot show them all.
 */
export async function withOrderEntryFixture(
  run: (fixture: Awaited<ReturnType<typeof seed>>) => Promise<void>,
  seedProfile: ComposedApplicationSeedProfile = 'demo',
) {
  await withEphemeralPostgres('order-entry', async ({ connection, pool }) => {
    const app = await startComposedApplication({
      databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
      port: 0,
      seedProfile,
      tenantSlug: 'order-entry',
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
  const customer = '71000000-0000-4000-8000-000000000001';
  const item = '71000000-0000-4000-8000-000000000011';
  const location = '71000000-0000-4000-8000-000000000021';
  const invoke = (
    local: string,
    input: ImmutableJsonValue,
    key = randomUUID(),
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
        app.runtime.operationMediation.issueInvocation(view, 'UI'),
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
    if (!result.readBack) throw new Error('Fixture create withheld');
    return result.readBack;
  };
  for (const kind of ['customer', 'supplier'])
    await create(
      'party_role',
      { kind: `${ns}:option.${kind}`, status: `${ns}:option.active` },
      { party: customer },
      false,
    );
  const now = new Date().toISOString();
  const stock = await create('inventory_transaction', {
    actor_id: 'order-entry-fixture',
    effective_at: now,
    recorded_at: now,
    number: `ADJ-${randomUUID()}`,
    reason_code: 'SETUP',
    reason_narrative: 'Isolated opening stock',
    source_id: randomUUID(),
    source_type: 'test',
    state: `${ns}:option.inventory_transaction_state_draft`,
    type: `${ns}:option.inventory_transaction_type_adjustment`,
  });
  await create(
    'inventory_transaction_line',
    {
      from_location_id: null,
      to_location_id: location,
      item_id: item,
      line_number: '1',
      quantity: '10',
      unit_id: 'EA',
    },
    { transaction: stock.recordId },
  );
  await invoke('inventory_transaction_post', {
    recordId: stock.recordId,
    expectedRevision: stock.revision,
  });
  const target = await governedStorageTarget();
  const entity = (local: string) =>
    target.entities.find(
      (value) => value.entityId === `${ns}:entity.${local}`,
    )!;
  const stored = async (local: string) => {
    const definition = entity(local);
    const { rows } = await pool.query(
      `SELECT * FROM ${fulfillmentTable(definition)} WHERE tenant_id=$1 AND environment_id=$2${definition.legalEntity ? ` AND ${q(definition.legalEntity.column)}=$3` : ''}`,
      [
        app.runtime.identity.tenantId,
        app.runtime.identity.environmentId,
        ...(definition.legalEntity ? [scope] : []),
      ],
    );
    return rows;
  };
  const stockSnapshot = async () => ({
    movement: await stored('inventory_movement'),
    balance: await stored('posted_stock_balance'),
  });
  const initialStock = await stockSnapshot();
  assert.equal((await stored('sales_order')).length, 0);
  assert.equal((await stored('purchase_order')).length, 0);
  let catalogConflict: Awaited<ReturnType<typeof create>> | null = null;
  const measure = async (
    phase: string,
    orderId?: string,
    purchaseId?: string,
    subject?: string,
  ) => {
    if (phase === 'deny' || phase === 'allow') {
      // One named permission, revoked or restored for the development role, so
      // a browser proof can observe a refusal and then the same flow succeeding.
      assert.match(subject ?? '', /^[a-z_]+$/);
      const changed = await pool.query(
        `UPDATE platform.current_policy_permission_grants
            SET revoked_at=${phase === 'deny' ? 'transaction_timestamp()' : 'NULL'}
          WHERE tenant_id=$1 AND environment_id=$2 AND permission_id=$3
            AND revoked_at IS ${phase === 'deny' ? 'NULL' : 'NOT NULL'}
          RETURNING permission_id`,
        [
          app.runtime.identity.tenantId,
          app.runtime.identity.environmentId,
          `${ns}:permission.${subject!}`,
        ],
      );
      assert.ok(changed.rows.length > 0);
      return { phase, subject, changed: changed.rows.length, observed: true };
    }
    if (phase === 'masters') {
      // Stored masters named exactly `subject`, with the roles attached to them.
      const named = async (local: string, field: string) =>
        (await stored(local)).filter(
          (row) => row[fulfillmentColumn(entity(local), field)] === subject,
        );
      const parties = await named('party', 'party_name');
      const relation = target.relations.find(
        (value) => value.relationId === `${ns}:relation.party_role_party`,
      )!.relationColumn.physicalName;
      const ids = new Set(parties.map((row) => row.record_id));
      const roles = (await stored('party_role')).filter((row) =>
        ids.has(row[relation]),
      );
      return {
        phase,
        subject,
        parties: parties.length,
        roles: roles.map((row) =>
          String(
            row[fulfillmentColumn(entity('party_role'), 'party_role_kind')],
          ),
        ),
        items: (await named('item', 'item_name')).length,
        observed: true,
      };
    }
    if (phase === 'catalog_setup') {
      const now = new Date().toISOString();
      const order = (number: string) =>
        create('sales_order', {
          customer_party_id: customer,
          order_date: now,
          requested_date: now,
          currency: 'CAD',
          notes: 'Catalog real-path fixture',
          number,
        });
      catalogConflict = await order('SO-CATALOG-CONFLICT');
      const locked = await order('SO-CATALOG-LOCKED');
      const released = await invoke('sales_order_release', {
        recordId: locked.recordId,
        expectedRevision: locked.revision,
      });
      assert.equal(released.outcome, 'succeeded');
      return {
        phase,
        conflictId: catalogConflict.recordId,
        lockedId: locked.recordId,
        scope,
        observed: true,
      };
    }
    if (phase === 'catalog_advance') {
      assert.ok(catalogConflict);
      assert.equal(orderId, catalogConflict.recordId);
      const changed = await invoke('sales_order_update', {
        recordId: catalogConflict.recordId,
        expectedRevision: catalogConflict.revision,
        patch: {
          [`${ns}:field.sales_order_notes`]:
            'Changed after the browser opened its draft',
        },
      });
      assert.equal(changed.outcome, 'succeeded');
      return { phase, orderId, observed: true };
    }
    if (phase === 'revoke_sales_read') {
      const revoked = await pool.query(
        `UPDATE platform.current_policy_permission_grants SET revoked_at=transaction_timestamp()
         WHERE tenant_id=$1 AND environment_id=$2 AND permission_id=$3 AND resource_id=$4 AND revoked_at IS NULL
         RETURNING permission_id, revoked_at`,
        [
          app.runtime.identity.tenantId,
          app.runtime.identity.environmentId,
          `${ns}:permission.sales_order_read`,
          `${ns}:entity.sales_order`,
        ],
      );
      assert.ok(revoked.rows.length > 0);
      assert.ok(revoked.rows.every((row) => row.revoked_at !== null));
      return { phase, revokedCount: revoked.rows.length, observed: true };
    }
    if (phase === 'second_company') {
      const company = await create(
        'legal_entity',
        {
          code: 'ENTRY-SECOND',
          name: 'Second company',
          status: `${ns}:option.legal_entity_status_active`,
          is_default: false,
        },
        {},
        false,
      );
      return { phase, companyId: company.recordId, observed: true };
    }
    if (phase === 'drafts') {
      for (const [local, id] of [
        ['sales_order', orderId],
        ['purchase_order', purchaseId],
      ] as const) {
        const headers = await stored(local);
        assert.equal(headers.length, 1);
        assert.equal(headers[0]!.record_id, id);
        assert.equal(headers[0]![entity(local).legalEntity!.column], scope);
        const lines = await stored(`${local}_line`);
        assert.equal(lines.length, 2);
        const relation = target.relations.find(
          (value) => value.relationId === `${ns}:relation.${local}_line_order`,
        )!.relationColumn.physicalName;
        assert.ok(
          lines.every(
            (row) =>
              row[relation] === id &&
              row[entity(`${local}_line`).legalEntity!.column] === scope &&
              row.archived_at === null,
          ),
        );
        const values = lines.sort(
          (a, b) =>
            Number(
              a[
                fulfillmentColumn(
                  entity(`${local}_line`),
                  `${local}_line_line_number`,
                )
              ],
            ) -
            Number(
              b[
                fulfillmentColumn(
                  entity(`${local}_line`),
                  `${local}_line_line_number`,
                )
              ],
            ),
        );
        assert.deepEqual(
          values.map((row) => [
            row[
              fulfillmentColumn(
                entity(`${local}_line`),
                `${local}_line_item_id`,
              )
            ],
            String(
              row[
                fulfillmentColumn(
                  entity(`${local}_line`),
                  `${local}_line_ordered_quantity`,
                )
              ],
            ),
          ]),
          [
            [item, '10.000000000000000000'],
            ['71000000-0000-4000-8000-000000000012', '3.000000000000000000'],
          ],
        );
      }
      assert.deepEqual(await stockSnapshot(), initialStock);
    } else {
      const expected =
        phase === 'reserved'
          ? ['10', '8', '2']
          : phase === 'shipped'
            ? ['5', '3', '2']
            : phase === 'released'
              ? ['5', '0', '5']
              : phase === 'received'
                ? ['7', '0', '7']
                : null;
      assert.ok(expected, 'Unknown measurement phase');
      const balance = await stored('posted_stock_balance');
      const qty = fulfillmentColumn(
        entity('posted_stock_balance'),
        'posted_stock_balance_posted_quantity',
      );
      assert.equal(Number(balance[0]![qty]), Number(expected[0]));
      // Read through the accepted projection; no reconciliation/healing is invoked.
      const reservations = await stored('reservation_balance');
      assert.equal(reservations.length, 1);
      assert.equal(
        reservations[0]![
          fulfillmentColumn(
            entity('reservation_balance'),
            'reservation_balance_unit_id',
          )
        ],
        'EA',
      );
      const reserved = Number(
        reservations[0]![
          fulfillmentColumn(
            entity('reservation_balance'),
            'reservation_balance_remaining_quantity',
          )
        ],
      );
      assert.equal(reserved, Number(expected[1]));
      assert.equal(Number(balance[0]![qty]) - reserved, Number(expected[2]));
      if (phase === 'released' || phase === 'received') {
        const packed = await stored('shipment_line');
        assert.equal(packed.length, 1);
        assert.equal(
          Number(
            packed[0]![
              fulfillmentColumn(
                entity('shipment_line'),
                'shipment_line_quantity',
              )
            ],
          ),
          5,
        );
      }
      if (phase === 'received') {
        const received = await stored('goods_receipt_line');
        assert.equal(received.length, 1);
        assert.equal(
          Number(
            received[0]![
              fulfillmentColumn(
                entity('goods_receipt_line'),
                'goods_receipt_line_quantity',
              )
            ],
          ),
          2,
        );
        assert.equal(
          String(
            received[0]![
              fulfillmentColumn(
                entity('goods_receipt_line'),
                'goods_receipt_line_unit_cost',
              )
            ],
          ),
          '2.450000000000000000',
        );
        assert.equal(
          received[0]![
            fulfillmentColumn(
              entity('goods_receipt_line'),
              'goods_receipt_line_currency',
            )
          ],
          'CAD',
        );
      }
    }
    return { phase, orderId, purchaseId, observed: true };
  };
  return {
    app,
    pool,
    invoke,
    create,
    scope,
    item,
    location,
    customer,
    measure,
  };
}
if (process.argv.includes('--serve')) {
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const sourceHasTrackedChanges =
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
    }).trim().length > 0;
  void withOrderEntryFixture(
    async (fixture) => {
      const served = await fixture.app.runtime.entry.run(
        { headers: {} },
        (view) => ({
          releaseId: view.release.releaseId,
          releaseRoot: view.release.contentHash,
          fence: view.pointer.fence,
        }),
      );
      console.log(
        `ORDER_ENTRY_SERVING=${JSON.stringify({ sourceRevision, sourceHasTrackedChanges, pid: process.pid, worktree: process.cwd(), ...served })}`,
      );
      console.log(
        `ORDER_ENTRY_URL=${fixture.app.baseUrl}/?surface=northstar.app%3Asurface.sales_order_list`,
      );
      const input = process.argv.includes('--verify')
        ? createInterface({ input: process.stdin })
        : null;
      if (input) {
        input.on(
          'line',
          (line) =>
            void (async () => {
              const request = JSON.parse(line) as {
                phase: string;
                orderId?: string;
                purchaseId?: string;
                subject?: string;
              };
              const observed = await fixture.measure(
                request.phase,
                request.orderId,
                request.purchaseId,
                request.subject,
              );
              console.log(`ORDER_ENTRY_MEASURED=${JSON.stringify(observed)}`);
            })().catch((error) => {
              console.error(error);
              process.exitCode = 1;
              process.kill(process.pid, 'SIGTERM');
            }),
        );
      }
      await new Promise<void>((resolve) => {
        const stop = () => {
          input?.close();
          process.stdin.destroy();
          resolve();
        };
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
      });
    },
    process.argv.includes('--distributor') ? 'distributor' : 'demo',
  );
}
