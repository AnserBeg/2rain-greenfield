import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type pg from 'pg';

import { startComposedApplication } from '../../../api/src/composition-root.js';
import {
  fulfillmentBinding,
  fulfillmentColumn,
  fulfillmentOption,
  fulfillmentRelation,
  fulfillmentTable,
  quoteFulfillmentIdentifier as q,
} from '../../../../packages/postgres-provider/src/fulfillment.js';
import { governedStorageTarget } from '../../../../test/helpers/governed-storage-target.js';
import { withEphemeralPostgres } from '../../../../test/helpers/postgres.js';

const namespace = 'northstar.app';
const legalEntityId = '74000000-0000-4000-8000-000000000001';
const customerPartyId = '71000000-0000-4000-8000-000000000001';
const itemId = '71000000-0000-4000-8000-000000000011';
const locationId = '71000000-0000-4000-8000-000000000021';

test('SALE-FULFILLMENT reserves exactly, ships partially, corrects without resurrection and cancels safely', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await withEphemeralPostgres(
    'sale-fulfillment-browser',
    async ({ connection, pool }) => {
      const application = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        port: 0,
        tenantSlug: 'sale-fulfillment-browser',
      });
      try {
        await journey(page, application.baseUrl, pool);
      } finally {
        await application.close();
      }
    },
  );
});

async function journey(page: Page, baseUrl: string, pool: pg.Pool) {
  page.setDefaultTimeout(12_000);
  const suffix = randomUUID().slice(0, 8);
  const instant = new Date().toISOString();
  const url = (
    local: string,
    role: 'detail' | 'form' | 'list',
    recordId?: string,
  ) => {
    const type = role === 'list' ? 'list' : 'get';
    const parameters = new URLSearchParams({
      surface: `${namespace}:surface.${local}_${role}`,
    });
    if (!['party', 'party_role', 'item', 'location'].includes(local))
      parameters.set(
        `${namespace}:parameter.${local}_${type}_legal_entity_scope`,
        legalEntityId,
      );
    if (recordId) parameters.set('record', recordId);
    return `${baseUrl}/?${parameters}`;
  };
  const fill = async (local: string, name: string, value: string) => {
    await page
      .locator(`[name="value:${namespace}:field.${local}_${name}"]`)
      .fill(value);
  };
  const choose = async (local: string, name: string, label: string) => {
    await page
      .locator(`[name="value:${namespace}:field.${local}_${name}"]`)
      .selectOption({ label });
  };
  const relate = async (relation: string, recordId: string) => {
    await page
      .locator(`[name="relation:${namespace}:relation.${relation}"]`)
      .selectOption(recordId);
  };
  const save = async () => {
    const id = await page
      .locator('form#surface-record-form input[name="recordId"]')
      .inputValue();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Create complete');
    return id;
  };
  const command = async (label: string, confirmed = true) => {
    await page.getByRole('button', { name: label, exact: true }).click();
    if (confirmed) {
      await expect(
        page.getByRole('heading', { name: `Confirm ${label}`, exact: true }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: `Confirm ${label}`, exact: true })
        .click();
    }
    await expect(page.getByRole('status')).toContainText(`${label} complete`);
  };

  // Put stock on hand through the existing authored Inventory document and
  // its registered posting command; fulfillment receives no setup shortcut.
  await page.goto(url('inventory_transaction', 'form'));
  await fill('inventory_transaction', 'number', `ADJ-FUL-${suffix}`);
  await page
    .locator(`[name="value:${namespace}:field.inventory_transaction_type"]`)
    .fill(`${namespace}:option.inventory_transaction_type_adjustment`);
  await choose('inventory_transaction', 'state', 'draft');
  await fill('inventory_transaction', 'reason_code', 'fulfillment-setup');
  await fill(
    'inventory_transaction',
    'reason_narrative',
    'Stock for fulfillment walkthrough',
  );
  await fill('inventory_transaction', 'source_type', 'walkthrough');
  await fill('inventory_transaction', 'source_id', `setup-${suffix}`);
  await fill('inventory_transaction', 'effective_at', instant);
  await fill('inventory_transaction', 'recorded_at', instant);
  await fill('inventory_transaction', 'actor_id', 'walkthrough-user');
  const transactionId = await save();
  await page.goto(url('inventory_transaction_line', 'form'));
  await fill('inventory_transaction_line', 'line_number', '1');
  await fill('inventory_transaction_line', 'item_id', itemId);
  await fill('inventory_transaction_line', 'to_location_id', locationId);
  await fill('inventory_transaction_line', 'quantity', '10');
  await fill('inventory_transaction_line', 'unit_id', 'EA');
  await relate('inventory_transaction_line_transaction', transactionId);
  await save();
  await page.goto(url('inventory_transaction', 'detail', transactionId));
  await command('Post');

  await page.goto(url('sales_order', 'form'));
  await fill('sales_order', 'number', `SO-FUL-${suffix}`);
  await fill('sales_order', 'customer_party_id', customerPartyId);
  await fill('sales_order', 'order_date', instant);
  await fill('sales_order', 'requested_date', instant);
  await fill('sales_order', 'currency', 'CAD');
  await fill('sales_order', 'notes', 'Partial shipment and correction');
  const orderId = await save();
  await page.goto(url('sales_order_line', 'form'));
  await fill('sales_order_line', 'line_number', '1');
  await fill('sales_order_line', 'item_id', itemId);
  await fill('sales_order_line', 'unit_id', 'EA');
  await fill('sales_order_line', 'ordered_quantity', '10');
  await fill('sales_order_line', 'unit_price', '12.5');
  await relate('sales_order_line_order', orderId);
  const orderLineId = await save();
  await page.goto(url('sales_order', 'detail', orderId));
  await command('Release', false);

  // Eligibility is checked from current persisted party-role facts when the
  // reservation is activated. The released order deliberately predates this
  // role so historical orders cannot bypass the same server-side check.
  await page.goto(url('party_role', 'form'));
  await choose('party_role', 'kind', 'Customer');
  await choose('party_role', 'status', 'Active');
  await relate('party_role_party', customerPartyId);
  await save();

  await page.goto(url('reservation', 'form'));
  await fill('reservation', 'number', `RSV-${suffix}`);
  await choose('reservation', 'state', 'draft');
  await fill('reservation', 'item_id', itemId);
  await fill('reservation', 'location_id', locationId);
  await fill('reservation', 'quantity', '8');
  await fill('reservation', 'unit_id', 'EA');
  await fill('reservation', 'reason', 'Release any unused remainder');
  await relate('reservation_order_line', orderLineId);
  const reservationId = await save();
  await page.goto(url('reservation', 'detail', reservationId));
  await command('Reserve');
  await page.goto(url('sales_order', 'detail', orderId));
  await expectFulfillmentRow(page, ['10', '8', '0', '10']);
  await expectStockRow(page, ['10', '8', '2']);

  // Exact-or-refuse: a competing reservation cannot take three units because
  // only two remain physically available after eight are committed.
  await page.goto(url('reservation', 'form'));
  await fill('reservation', 'number', `RSV-SHORT-${suffix}`);
  await choose('reservation', 'state', 'draft');
  await fill('reservation', 'item_id', itemId);
  await fill('reservation', 'location_id', locationId);
  await fill('reservation', 'quantity', '3');
  await fill('reservation', 'unit_id', 'EA');
  await fill('reservation', 'reason', 'Not expected to activate');
  await relate('reservation_order_line', orderLineId);
  const shortageId = await save();
  await page.goto(url('reservation', 'detail', shortageId));
  await page.getByRole('button', { name: 'Reserve', exact: true }).click();
  await page
    .getByRole('button', { name: 'Confirm Reserve', exact: true })
    .click();
  await expect(page.locator('[data-message-subject]')).toHaveText(
    'FULFILLMENT_RESERVATION_SHORTAGE',
  );

  const initialShipment = await createShipment({
    kind: 'initial',
    number: `SHP-${suffix}`,
    quantity: '5',
    reservationId,
  });
  await seedPackingNoise(pool, {
    orderId,
    orderLineId,
    reservationId,
  });
  await page.goto(url('shipment', 'detail', initialShipment.shipmentId));
  const committedRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.postData()?.includes('confirmationGrant=') === true,
  );
  await command('Post');
  const committedPayload = new URLSearchParams(
    (await committedRequest).postData() ?? '',
  );
  await expect(
    page.locator('[data-platform-slot="record:sections"] .record-fields'),
  ).toContainText(`SHP-${suffix}`);
  await expect(
    page.locator(
      '[data-composition-dataset$="dataset.packing_lines"] tbody tr',
    ),
  ).toHaveCount(1);
  await page.goto(url('shipment', 'detail', initialShipment.shipmentId));
  await expect(
    page.locator('[data-platform-slot="record:sections"] .record-fields'),
  ).toContainText(`SHP-${suffix}`);
  await expect(
    page.locator(
      '[data-composition-dataset$="dataset.packing_lines"] tbody tr',
    ),
  ).toHaveCount(1);
  const replay = await page.request.post(
    url('shipment', 'detail', initialShipment.shipmentId),
    { form: Object.fromEntries(committedPayload) },
  );
  expect(replay.status()).toBe(200);
  expect(await replay.text()).toContain('Post complete');

  await page.goto(url('sales_order', 'detail', orderId));
  await expectFulfillmentRow(page, ['10', '3', '5', '5']);
  await expectStockRow(page, ['5', '3', '2']);

  await page.goto(url('reservation', 'detail', reservationId));
  await command('Release');
  await page.goto(url('sales_order', 'detail', orderId));
  await expectFulfillmentRow(page, ['10', '0', '5', '5']);
  await expectStockRow(page, ['5', '0', '5']);

  const target = await governedStorageTarget();
  const movement = target.entities.find((entity) =>
    entity.entityId.endsWith(':entity.inventory_movement'),
  )!;
  const scope = await pool.query<{ tenant_id: string; environment_id: string }>(
    `SELECT tenant_id,environment_id FROM platform.current_policy_roles
      WHERE role_key='local-demo-full-release' AND revoked_at IS NULL`,
  );
  const originalMovement = await pool.query<{ record_id: string }>(
    `SELECT record_id FROM ${fulfillmentTable(movement)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${q(movement.legalEntity!.column)}=$3
        AND ${q(fulfillmentColumn(movement, 'inventory_movement_source_type'))}='shipment'
        AND ${q(fulfillmentColumn(movement, 'inventory_movement_source_id'))}=$4`,
    [
      scope.rows[0]!.tenant_id,
      scope.rows[0]!.environment_id,
      legalEntityId,
      initialShipment.shipmentId,
    ],
  );
  expect(originalMovement.rows).toHaveLength(1);
  const movementId = originalMovement.rows[0]!.record_id;

  const correction = await createShipment({
    kind: 'correction',
    number: `SHP-COR-${suffix}`,
    quantity: '2',
    reservationId,
    supersedes: initialShipment.shipmentId,
    reversalOfMovementId: movementId,
  });
  await page.goto(url('shipment', 'detail', correction.shipmentId));
  await command('Post');
  await page.goto(url('sales_order', 'detail', orderId));
  await expectFulfillmentRow(page, ['10', '0', '3', '7']);
  await expectStockRow(page, ['7', '0', '7']);

  // A correction against an explicitly released reservation restores stock
  // and net shipped only; it does not silently restore reservation coverage.
  await page.goto(url('reservation', 'detail', reservationId));
  await expect(page.getByText(/reservation_state_released/)).toBeVisible();

  const reversal = await createShipment({
    kind: 'reversal',
    number: `SHP-REV-${suffix}`,
    quantity: '3',
    reservationId,
    supersedes: initialShipment.shipmentId,
    reversalOfMovementId: movementId,
  });
  await page.goto(url('shipment', 'detail', reversal.shipmentId));
  await command('Post');
  await page.goto(url('sales_order', 'detail', orderId));
  await expectFulfillmentRow(page, ['10', '0', '0', '10']);
  await expectStockRow(page, ['10', '0', '10']);
  await command('Cancel');

  // A second, fully shipped order demonstrates explicit closure independently
  // of the cancelled-and-reversed order above.
  await page.goto(url('sales_order', 'form'));
  await fill('sales_order', 'number', `SO-CLOSE-${suffix}`);
  await fill('sales_order', 'customer_party_id', customerPartyId);
  await fill('sales_order', 'order_date', instant);
  await fill('sales_order', 'requested_date', instant);
  await fill('sales_order', 'currency', 'CAD');
  const closureOrderId = await save();
  await page.goto(url('sales_order_line', 'form'));
  await fill('sales_order_line', 'line_number', '1');
  await fill('sales_order_line', 'item_id', itemId);
  await fill('sales_order_line', 'unit_id', 'EA');
  await fill('sales_order_line', 'ordered_quantity', '2');
  await fill('sales_order_line', 'unit_price', '12.5');
  await relate('sales_order_line_order', closureOrderId);
  const closureLineId = await save();
  await page.goto(url('sales_order', 'detail', closureOrderId));
  await command('Release', false);
  await page.goto(url('reservation', 'form'));
  await fill('reservation', 'number', `RSV-CLOSE-${suffix}`);
  await choose('reservation', 'state', 'draft');
  await fill('reservation', 'item_id', itemId);
  await fill('reservation', 'location_id', locationId);
  await fill('reservation', 'quantity', '2');
  await fill('reservation', 'unit_id', 'EA');
  await fill('reservation', 'reason', 'Fully ship before closure');
  await relate('reservation_order_line', closureLineId);
  const closureReservationId = await save();
  await page.goto(url('reservation', 'detail', closureReservationId));
  await command('Reserve');
  const closureShipment = await createShipment({
    kind: 'initial',
    number: `SHP-CLOSE-${suffix}`,
    order: closureOrderId,
    orderLine: closureLineId,
    quantity: '2',
    reservationId: closureReservationId,
  });
  await page.goto(url('shipment', 'detail', closureShipment.shipmentId));
  await command('Post');
  await page.goto(url('sales_order', 'detail', closureOrderId));
  await command('Close');
  await expect(page.getByText(/sales_order_closed/)).toBeVisible();

  console.log(
    `SALE_FULFILLMENT_WALKTHROUGH ${JSON.stringify({ closureOrderId, closureShipmentId: closureShipment.shipmentId, correctionShipmentId: correction.shipmentId, initialShipmentId: initialShipment.shipmentId, movementId, orderId, orderLineId, packingDocument: true, partialShipment: '5', reservationId, reserveSequence: ['10/8/2', '5/3/2', '5/0/5'], shortageRefused: true, silentReservationResurrection: false })}`,
  );

  async function createShipment(input: {
    kind: 'initial' | 'correction' | 'reversal';
    number: string;
    order?: string;
    orderLine?: string;
    quantity: string;
    reservationId: string;
    supersedes?: string;
    reversalOfMovementId?: string;
  }) {
    await page.goto(url('shipment', 'form'));
    await fill('shipment', 'number', input.number);
    await choose('shipment', 'state', 'draft');
    await choose('shipment', 'kind', input.kind);
    await fill('shipment', 'effective_at', instant);
    await fill('shipment', 'location_id', locationId);
    await fill('shipment', 'external_reference', `PICK-${suffix}`);
    await fill('shipment', 'reason_code', input.kind);
    await fill('shipment', 'reason_narrative', `${input.kind} walkthrough`);
    await relate('shipment_order', input.order ?? orderId);
    if (input.supersedes) await relate('shipment_supersedes', input.supersedes);
    const shipmentId = await save();
    await page.goto(url('shipment_line', 'form'));
    await fill('shipment_line', 'line_number', '1');
    await fill('shipment_line', 'item_id', itemId);
    await fill('shipment_line', 'quantity', input.quantity);
    await fill('shipment_line', 'unit_id', 'EA');
    if (input.reversalOfMovementId)
      await fill(
        'shipment_line',
        'reversal_of_movement_id',
        input.reversalOfMovementId,
      );
    await relate('shipment_line_shipment', shipmentId);
    await relate('shipment_line_order_line', input.orderLine ?? orderLineId);
    await relate('shipment_line_reservation', input.reservationId);
    const shipmentLineId = await save();
    return { shipmentId, shipmentLineId };
  }
}

async function seedPackingNoise(
  pool: pg.Pool,
  input: {
    readonly orderId: string;
    readonly orderLineId: string;
    readonly reservationId: string;
  },
): Promise<void> {
  const binding = fulfillmentBinding(await governedStorageTarget())!;
  const shipment = binding.shipment;
  const line = binding.shipmentLine;
  const tenant = await pool.query<{
    environment_id: string;
    tenant_id: string;
  }>(
    `SELECT tenant_id,environment_id FROM platform.current_policy_roles
      WHERE role_key='local-demo-full-release' AND revoked_at IS NULL`,
  );
  expect(tenant.rows).toHaveLength(1);
  const identity = tenant.rows[0]!;
  const noiseShipmentId = '00000000-0000-4000-8000-000000000001';
  await pool.query(
    `INSERT INTO ${fulfillmentTable(shipment)}
       (tenant_id,environment_id,${q(shipment.legalEntity!.column)},record_id,revision,archived_at,
        ${q(fulfillmentColumn(shipment, 'shipment_number'))},
        ${q(fulfillmentColumn(shipment, 'shipment_state'))},
        ${q(fulfillmentColumn(shipment, 'shipment_kind'))},
        ${q(fulfillmentColumn(shipment, 'shipment_effective_at'))},
        ${q(fulfillmentColumn(shipment, 'shipment_location_id'))},
        ${q(fulfillmentColumn(shipment, 'shipment_external_reference'))},
        ${q(fulfillmentColumn(shipment, 'shipment_reason_code'))},
        ${q(fulfillmentColumn(shipment, 'shipment_reason_narrative'))},
        ${q(fulfillmentRelation(binding, shipment, 'shipment_order'))},
        ${q(fulfillmentRelation(binding, shipment, 'shipment_supersedes'))})
     VALUES ($1,$2,$3,$4,1,NULL,$5,$6,$7,$8,$9,NULL,$10,NULL,$11,NULL)`,
    [
      identity.tenant_id,
      identity.environment_id,
      legalEntityId,
      noiseShipmentId,
      `SHP-NOISE-${randomUUID()}`,
      fulfillmentOption(shipment, 'shipment_state', 'draft'),
      fulfillmentOption(shipment, 'shipment_kind', 'initial'),
      new Date().toISOString(),
      locationId,
      'packing-pagination-noise',
      input.orderId,
    ],
  );
  await pool.query(
    `INSERT INTO ${fulfillmentTable(line)}
       (tenant_id,environment_id,${q(line.legalEntity!.column)},record_id,revision,archived_at,
        ${q(fulfillmentColumn(line, 'shipment_line_line_number'))},
        ${q(fulfillmentColumn(line, 'shipment_line_item_id'))},
        ${q(fulfillmentColumn(line, 'shipment_line_quantity'))},
        ${q(fulfillmentColumn(line, 'shipment_line_unit_id'))},
        ${q(fulfillmentColumn(line, 'shipment_line_reversal_of_movement_id'))},
        ${q(fulfillmentRelation(binding, line, 'shipment_line_shipment'))},
        ${q(fulfillmentRelation(binding, line, 'shipment_line_order_line'))},
        ${q(fulfillmentRelation(binding, line, 'shipment_line_reservation'))})
     SELECT $1,$2,$3,
            ('00000000-0000-4000-8000-' || lpad(series::text,12,'0'))::uuid,
            1,NULL,series,$4,'1',$5,NULL,$6,$7,$8
       FROM generate_series(100,200) AS series`,
    [
      identity.tenant_id,
      identity.environment_id,
      legalEntityId,
      itemId,
      'EA',
      noiseShipmentId,
      input.orderLineId,
      input.reservationId,
    ],
  );
}

async function expectFulfillmentRow(page: Page, values: string[]) {
  const dataset = page.locator(
    '[data-composition-dataset$="dataset.fulfillment_lines"]',
  );
  const row = dataset.locator('tbody tr').first();
  for (const [index, label] of [
    'Ordered',
    'Reserved',
    'Shipped',
    'Open to ship',
  ].entries())
    await expect(row.locator(`td[data-column-label="${label}"]`)).toHaveText(
      values[index]!,
    );
  await row.getByRole('link', { name: 'Select', exact: true }).click();
}

async function expectStockRow(page: Page, values: string[]) {
  const row = page
    .locator('[data-composition-dataset$="dataset.line_reservations"] tbody tr')
    .first();
  for (const [index, label] of [
    'On hand',
    'Reserved stock',
    'Available',
  ].entries())
    await expect(row.locator(`td[data-column-label="${label}"]`)).toHaveText(
      values[index]!,
    );
}
