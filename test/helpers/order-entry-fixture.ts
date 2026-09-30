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
  /**
   * Extra parties named "Paging match NNN", created through the governed
   * create, so a picker's bounded lookup can be judged against more matches
   * than it displays. Masters only; zero by default.
   */
  lookupVolume = 0,
  /**
   * Prerequisite Sales orders for judging a List (views, counts, paging, sort,
   * search by customer name, export), created through the governed create,
   * release and cancel operations after the no-orders assertion. The order a
   * browser proof is about is still created in the browser; zero by default.
   */
  orderVolume = 0,
  /** A compiled release to serve instead of the checked-in one. */
  compiledApplication?: unknown,
) {
  await withEphemeralPostgres('order-entry', async ({ connection, pool }) => {
    const app = await startComposedApplication({
      ...(compiledApplication === undefined ? {} : { compiledApplication }),
      databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
      port: 0,
      seedProfile,
      tenantSlug: 'order-entry',
    });
    try {
      await run(await seed(app, pool, lookupVolume, orderVolume));
    } finally {
      await app.close();
    }
  });
}
async function seed(
  app: Awaited<ReturnType<typeof startComposedApplication>>,
  pool: Pool,
  lookupVolume = 0,
  orderVolume = 0,
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
    recordId: string = randomUUID(),
  ) => {
    const result = await invoke(`${local}_create`, {
      recordId,
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
  for (let index = 1; index <= lookupVolume; index++)
    await create(
      'party',
      {
        number: `PM-${String(index).padStart(3, '0')}`,
        name: `Paging match ${String(index).padStart(3, '0')}`,
      },
      {},
      false,
    );
  // Ruling E: the demo customer carries order defaults -- a salesperson, Net
  // 30, CAD and a default ship-to from its address book -- so choosing it in
  // the editor fills them, and Confirm finds a complete ship-to.
  const salesperson = await create(
    'party',
    {
      number: 'SP-TEST',
      name: 'Morgan Lee',
      contact_summary: 'Salesperson · morgan@rain-distribution.example',
    },
    {},
    false,
  );
  await create(
    'party_role',
    { kind: `${ns}:option.salesperson`, status: `${ns}:option.active` },
    { party: salesperson.recordId },
    false,
  );
  const shipToAddress = await create(
    'party_address',
    {
      label: 'Main delivery',
      recipient: 'Alpine receiving',
      street: '100 Industrial Way',
      city: 'Calgary',
      region: 'AB',
      postal_code: 'T2P 0A1',
      country: 'Canada',
    },
    { party: customer },
    false,
  );
  // Ruling B: a fixed-rate tax code the customer's orders are taxed by, and
  // the product's selling price in each order currency.
  const taxCode = await create(
    'tax_code',
    { code: 'GST-AB', name: 'GST 5% (Alberta)', rate_percent: '5' },
    {},
    false,
  );
  const priced = await invoke('item_update', {
    recordId: item,
    expectedRevision: 1,
    patch: {
      // Exact decimals are canonical: no trailing zeros.
      [`${ns}:field.item_price_cad`]: '12.5',
      [`${ns}:field.item_price_usd`]: '9.25',
      [`${ns}:field.item_price_eur`]: '8.5',
    },
  });
  assert.equal(priced.outcome, 'succeeded');
  const defaulted = await invoke('party_update', {
    recordId: customer,
    expectedRevision: 1,
    patch: {
      [`${ns}:field.party_default_tax_code_id`]: taxCode.recordId,
      [`${ns}:field.party_default_currency`]: `${ns}:option.party_default_currency_cad`,
      [`${ns}:field.party_payment_terms`]: `${ns}:option.party_payment_terms_net_30`,
      [`${ns}:field.party_default_salesperson_party_id`]: salesperson.recordId,
      [`${ns}:field.party_default_ship_to_address_id`]: shipToAddress.recordId,
    },
  });
  assert.equal(defaulted.outcome, 'succeeded');
  /** A complete ship-to, which Confirm requires (ruling E). */
  const shipTo = {
    ship_to_name: 'Receiving dock',
    ship_to_street: '100 Industrial Way',
    ship_to_city: 'Calgary',
    ship_to_region: 'AB',
    ship_to_postal_code: 'T2P 0A1',
    ship_to_country: 'Canada',
  };
  const now = new Date().toISOString();
  /**
   * A stock document as the editor saves one (INVENTORY-PARITY): the server
   * numbers it, and it is a draft naming itself as its posting source, with
   * when and by whom it was recorded.
   */
  const stockDocument = (
    values: Record<string, ImmutableJsonValue>,
    recordId: string = randomUUID(),
  ) =>
    create(
      'inventory_transaction',
      {
        ...values,
        actor_id: 'order-entry-fixture',
        recorded_at: new Date().toISOString(),
        source_id: recordId,
        source_type: 'inventoryTransaction',
        state: `${ns}:option.inventory_transaction_state_draft`,
      },
      {},
      true,
      recordId,
    );
  const stock = await stockDocument({
    effective_at: now,
    reason_code: 'SETUP',
    reason_narrative: 'Isolated opening stock',
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
  const listOrders = await createListOrders(orderVolume);
  async function createListOrders(count: number) {
    if (count === 0) return [];
    const kind = entity('party_role').columns.find((column) =>
      column.canonicalFieldId.endsWith('party_role_kind'),
    )!.physicalName;
    const partyColumn = target.relations.find(
      (relation) => relation.relationId === `${ns}:relation.party_role_party`,
    )!.relationColumn.physicalName;
    const customers = [
      ...new Set(
        (await stored('party_role'))
          .filter((row) => row[kind] === `${ns}:option.customer`)
          .map((row) => String(row[partyColumn])),
      ),
    ].sort();
    const created = [];
    for (let index = 1; index <= count; index++) {
      const day = new Date(Date.UTC(2026, 8, 1 + (index % 27), 12));
      const order = await create('sales_order', {
        customer_party_id: customers[index % customers.length]!,
        order_date: day.toISOString(),
        requested_date: new Date(day.getTime() + 21 * 86_400_000).toISOString(),
        currency: index % 5 === 0 ? 'EUR' : index % 4 === 0 ? 'USD' : 'CAD',
        notes: null,
        ...shipTo,
      });
      if (index % 3 === 0)
        await invoke('sales_order_release', {
          recordId: order.recordId,
          expectedRevision: order.revision,
        });
      else if (index % 7 === 0)
        await invoke('sales_order_draft_cancel', {
          recordId: order.recordId,
          expectedRevision: order.revision,
        });
      created.push(order.recordId);
    }
    return created;
  }
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
      // Order numbers are assigned by the server on create.
      const order = () =>
        create('sales_order', {
          customer_party_id: customer,
          order_date: now,
          requested_date: now,
          currency: 'CAD',
          notes: 'Catalog real-path fixture',
          ...shipTo,
        });
      catalogConflict = await order();
      const locked = await order();
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
    if (phase === 'expected_receipts') {
      // PURCHASING-PARITY: released purchase orders with something still to
      // arrive -- one late -- beside a fully received order and a draft, for
      // the Expected receipts List. Dates are relative to today (UTC).
      const today = new Date();
      const midnight = Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate(),
      );
      const at = (days: number) =>
        new Date(midnight + days * 86_400_000 + 12 * 3_600_000).toISOString();
      const purchase = async (
        expected: string,
        lines: readonly (readonly [ordered: string, received: string])[],
        release = true,
      ) => {
        const created = await create('purchase_order', {
          supplier_party_id: customer,
          order_date: at(-30),
          expected_date: expected,
          currency: 'CAD',
          notes: null,
        });
        const made = [];
        for (const [index, [ordered]] of lines.entries())
          made.push(
            await create(
              'purchase_order_line',
              {
                line_number: String(index + 1),
                item_id: item,
                ordered_quantity: ordered,
                unit_price: null,
              },
              { order: created.recordId },
            ),
          );
        if (release) {
          const released = await invoke('purchase_order_release', {
            recordId: created.recordId,
            expectedRevision: created.revision,
          });
          assert.equal(released.outcome, 'succeeded');
          for (const [index, [, quantity]] of lines.entries()) {
            if (quantity === '0') continue;
            const receipt = await create(
              'goods_receipt',
              {
                state: `${ns}:option.goods_receipt_state_draft`,
                kind: `${ns}:option.goods_receipt_kind_initial`,
                effective_at: new Date().toISOString(),
                location_id: location,
                reason_code: 'RECEIVE',
                reason_narrative: 'Expected receipts delivery',
              },
              { order: created.recordId },
            );
            await create(
              'goods_receipt_line',
              {
                line_number: '1',
                item_id: item,
                quantity,
                unit_id: 'EA',
                cost_status: `${ns}:option.goods_receipt_line_cost_status_absent`,
                unit_cost: null,
                currency: null,
                reversal_of_movement_id: null,
              },
              { receipt: receipt.recordId, order_line: made[index]!.recordId },
            );
            const posted = await invoke('goods_receipt_post', {
              recordId: receipt.recordId,
              expectedRevision: receipt.revision,
            });
            assert.equal(posted.outcome, 'succeeded');
          }
        }
        return {
          expected,
          number: String(created.values[`${ns}:field.purchase_order_number`]),
          recordId: created.recordId,
        };
      };
      return {
        phase,
        late: await purchase(at(-4), [
          ['10', '4'],
          ['5', '0'],
        ]),
        future: await purchase(at(10), [['6', '0']]),
        complete: await purchase(at(-2), [['3', '3']]),
        draft: await purchase(at(-3), [['7', '0']], false),
        observed: true,
      };
    }
    if (phase === 'order_lists') {
      // ORDER-PARITY: a confirmed sales order with part of one line shipped
      // and a draft beside it; a released purchase order with priced lines and
      // part of one received, and one received in full -- for the order Lists'
      // Ordered/Shipped/Received/Open columns, their work tabs, row actions and
      // the purchase order total. Everything goes through the governed
      // operations, as the order pages' own Tasks do.
      const now = new Date().toISOString();
      const number = (
        record: { values: Readonly<Record<string, unknown>> },
        local: string,
      ) => String(record.values[`${ns}:field.${local}_number`]);
      const salesOrder = async (quantities: readonly string[]) => {
        const order = await create('sales_order', {
          customer_party_id: customer,
          order_date: now,
          requested_date: now,
          currency: 'CAD',
          notes: null,
          ...shipTo,
        });
        const lines = [];
        for (const [index, quantity] of quantities.entries())
          lines.push(
            await create(
              'sales_order_line',
              {
                item_id: item,
                line_number: String(index + 1),
                ordered_quantity: quantity,
                unit_id: 'EA',
                unit_price: null,
              },
              { order: order.recordId },
            ),
          );
        return { order, lines };
      };
      const shipping = await salesOrder(['5', '3']);
      const confirmed = await invoke('sales_order_release', {
        recordId: shipping.order.recordId,
        expectedRevision: shipping.order.revision,
      });
      assert.equal(confirmed.outcome, 'succeeded');
      const reservation = await create(
        'reservation',
        {
          item_id: item,
          location_id: location,
          number: `RSV-${randomUUID()}`,
          quantity: '4',
          reason: 'Order Lists fixture',
          state: `${ns}:option.reservation_state_draft`,
          unit_id: 'EA',
        },
        { order_line: shipping.lines[0]!.recordId },
      );
      const reserved = await invoke('reservation_reserve', {
        recordId: reservation.recordId,
        expectedRevision: reservation.revision,
      });
      assert.equal(reserved.outcome, 'succeeded');
      const shipment = await create(
        'shipment',
        {
          carrier: 'Northline Freight',
          shipping_reference_kind: `${ns}:option.shipment_shipping_reference_kind_tracking`,
          shipping_reference: 'TRK-ORDER-LISTS',
          state: `${ns}:option.shipment_state_draft`,
          kind: `${ns}:option.shipment_kind_initial`,
          effective_at: now,
          location_id: location,
          external_reference: null,
          reason_code: 'SHIP',
          reason_narrative: 'Order Lists fixture',
          ...shipTo,
        },
        { order: shipping.order.recordId },
      );
      await create(
        'shipment_line',
        {
          line_number: '1',
          item_id: item,
          quantity: '3',
          unit_id: 'EA',
          reversal_of_movement_id: null,
        },
        {
          shipment: shipment.recordId,
          order_line: shipping.lines[0]!.recordId,
          reservation: reservation.recordId,
        },
      );
      const shipped = await invoke('shipment_post', {
        recordId: shipment.recordId,
        expectedRevision: shipment.revision,
      });
      assert.equal(shipped.outcome, 'succeeded');
      const drafted = await salesOrder(['2']);
      const purchase = async (
        lines: readonly (readonly [
          ordered: string,
          price: string,
          received: string,
        ])[],
      ) => {
        const order = await create('purchase_order', {
          supplier_party_id: customer,
          order_date: now,
          expected_date: null,
          currency: 'CAD',
          notes: null,
        });
        const made = [];
        for (const [index, [ordered, price]] of lines.entries())
          made.push(
            await create(
              'purchase_order_line',
              {
                line_number: String(index + 1),
                item_id: item,
                ordered_quantity: ordered,
                unit_price: price,
              },
              { order: order.recordId },
            ),
          );
        const released = await invoke('purchase_order_release', {
          recordId: order.recordId,
          expectedRevision: order.revision,
        });
        assert.equal(released.outcome, 'succeeded');
        for (const [index, [, , quantity]] of lines.entries()) {
          if (quantity === '0') continue;
          const receipt = await create(
            'goods_receipt',
            {
              state: `${ns}:option.goods_receipt_state_draft`,
              kind: `${ns}:option.goods_receipt_kind_initial`,
              effective_at: new Date().toISOString(),
              location_id: location,
              reason_code: 'RECEIVE',
              reason_narrative: 'Order Lists fixture',
            },
            { order: order.recordId },
          );
          await create(
            'goods_receipt_line',
            {
              line_number: '1',
              item_id: item,
              quantity,
              unit_id: 'EA',
              cost_status: `${ns}:option.goods_receipt_line_cost_status_absent`,
              unit_cost: null,
              currency: null,
              reversal_of_movement_id: null,
            },
            { receipt: receipt.recordId, order_line: made[index]!.recordId },
          );
          const posted = await invoke('goods_receipt_post', {
            recordId: receipt.recordId,
            expectedRevision: receipt.revision,
          });
          assert.equal(posted.outcome, 'succeeded');
        }
        return order;
      };
      // 10 × 2.50 + 5 × 1.20, untaxed and with no charges: 31.00.
      const receiving = await purchase([
        ['10', '2.5', '4'],
        ['5', '1.2', '0'],
      ]);
      // 3 × 4.00 = 12.00, all of it received.
      const complete = await purchase([['3', '4', '3']]);
      return {
        phase,
        sales: {
          shipping: {
            number: number(shipping.order, 'sales_order'),
            recordId: shipping.order.recordId,
          },
          draft: {
            number: number(drafted.order, 'sales_order'),
            recordId: drafted.order.recordId,
          },
        },
        purchases: {
          receiving: {
            number: number(receiving, 'purchase_order'),
            recordId: receiving.recordId,
            total: '31.00',
          },
          complete: {
            number: number(complete, 'purchase_order'),
            recordId: complete.recordId,
            total: '12.00',
          },
        },
        observed: true,
      };
    }
    if (phase === 'item_stock') {
      // INVENTORY-PARITY: Field notebook's stock moves at two locations. The
      // opening 10 at CAL-WH, 6 more at VAN-WH, a receipt of 5 and a shipment
      // of 2 against a reservation of 3 at CAL-WH, each through its governed
      // operation. Its page then shows CAL-WH 13 / 1 / 12 and VAN-WH 6 / 0 / 6.
      const overflow = '71000000-0000-4000-8000-000000000023';
      const at = () => new Date().toISOString();
      const done = async (local: string, recordId: string, revision: number) =>
        assert.equal(
          (await invoke(local, { recordId, expectedRevision: revision }))
            .outcome,
          'succeeded',
        );
      const adjustment = await stockDocument({
        effective_at: at(),
        reason_code: 'SETUP',
        reason_narrative: 'Item page overflow stock',
        type: `${ns}:option.inventory_transaction_type_adjustment`,
      });
      await create(
        'inventory_transaction_line',
        {
          from_location_id: null,
          to_location_id: overflow,
          item_id: item,
          line_number: '1',
          quantity: '6',
          unit_id: 'EA',
        },
        { transaction: adjustment.recordId },
      );
      await done(
        'inventory_transaction_post',
        adjustment.recordId,
        adjustment.revision,
      );
      // Receive 5 at CAL-WH on a confirmed purchase order.
      const purchase = await create('purchase_order', {
        supplier_party_id: customer,
        order_date: at(),
        expected_date: at(),
        currency: 'CAD',
        notes: null,
      });
      const purchaseLine = await create(
        'purchase_order_line',
        {
          line_number: '1',
          item_id: item,
          ordered_quantity: '5',
          unit_price: null,
        },
        { order: purchase.recordId },
      );
      await done(
        'purchase_order_release',
        purchase.recordId,
        purchase.revision,
      );
      const receipt = await create(
        'goods_receipt',
        {
          state: `${ns}:option.goods_receipt_state_draft`,
          kind: `${ns}:option.goods_receipt_kind_initial`,
          effective_at: at(),
          location_id: location,
          reason_code: 'RECEIVE',
          reason_narrative: 'Item page receipt',
        },
        { order: purchase.recordId },
      );
      await create(
        'goods_receipt_line',
        {
          line_number: '1',
          item_id: item,
          quantity: '5',
          unit_id: 'EA',
          cost_status: `${ns}:option.goods_receipt_line_cost_status_absent`,
          unit_cost: null,
          currency: null,
          reversal_of_movement_id: null,
        },
        { receipt: receipt.recordId, order_line: purchaseLine.recordId },
      );
      await done('goods_receipt_post', receipt.recordId, receipt.revision);
      // Reserve 3 at CAL-WH on a confirmed sales order, then ship 2 of them.
      const order = await create('sales_order', {
        customer_party_id: customer,
        order_date: at(),
        requested_date: at(),
        currency: 'CAD',
        notes: 'Item page order',
        ...shipTo,
      });
      const orderLine = await create(
        'sales_order_line',
        {
          item_id: item,
          line_number: '1',
          ordered_quantity: '5',
          unit_id: 'EA',
          unit_price: null,
        },
        { order: order.recordId },
      );
      await done('sales_order_release', order.recordId, order.revision);
      const reservation = await create(
        'reservation',
        {
          item_id: item,
          location_id: location,
          number: `RSV-${randomUUID()}`,
          quantity: '3',
          reason: 'Item page reservation',
          state: `${ns}:option.reservation_state_draft`,
          unit_id: 'EA',
        },
        { order_line: orderLine.recordId },
      );
      await done(
        'reservation_reserve',
        reservation.recordId,
        reservation.revision,
      );
      const shipment = await create(
        'shipment',
        {
          effective_at: at(),
          external_reference: randomUUID(),
          kind: `${ns}:option.shipment_kind_initial`,
          location_id: location,
          reason_code: 'SHIP',
          reason_narrative: 'Item page shipment',
          state: `${ns}:option.shipment_state_draft`,
          ...shipTo,
        },
        { order: order.recordId },
      );
      await create(
        'shipment_line',
        {
          item_id: item,
          line_number: '1',
          quantity: '2',
          reversal_of_movement_id: null,
          unit_id: 'EA',
        },
        {
          order_line: orderLine.recordId,
          reservation: reservation.recordId,
          shipment: shipment.recordId,
        },
      );
      await done('shipment_post', shipment.recordId, shipment.revision);
      return {
        phase,
        itemId: item,
        main: location,
        overflow,
        shipmentId: shipment.recordId,
        observed: true,
      };
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
    listOrders,
    measure,
    taxCode: taxCode.recordId,
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
    Number(
      process.argv
        .find((value) => value.startsWith('--lookup-volume='))
        ?.slice('--lookup-volume='.length) ?? 0,
    ),
    Number(
      process.argv
        .find((value) => value.startsWith('--order-volume='))
        ?.slice('--order-volume='.length) ?? 0,
    ),
  );
}
