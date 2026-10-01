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
    // The order page reads its totals query (ruling B), so its company is
    // that query's parameter.
    const query =
      local === 'sales_order' && role === 'detail' ? 'commercial_order' : local;
    const parameters = new URLSearchParams({
      surface: `${namespace}:surface.${local}_${role}`,
    });
    if (!['party', 'party_role', 'item', 'location'].includes(local))
      parameters.set(
        `${namespace}:parameter.${query}_${type}_legal_entity_scope`,
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
    const secondary = page.locator(
      '.composition-record-actions:not([open]) > summary',
    );
    if (await secondary.count()) await secondary.click();
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

  // Draft-editor pickers: type into the field's combobox and choose an offered
  // result -- in place with the owned script, as ordinary submits without it --
  // then wait for the field to show the selection before the next step.
  const pick = async (name: string, term: string, option: string) => {
    const box = page.getByRole('combobox', { name, exact: true });
    await box.fill(term);
    if (!(await page.locator('body[data-reference-enhanced]').count()))
      await page
        .locator('[data-reference-control]')
        .filter({ has: box })
        .getByRole('button', { name: 'Search', exact: true })
        .click();
    await page
      .getByRole('option')
      .filter({ has: page.locator('strong', { hasText: option }) })
      .first()
      .click();
    await expect(
      page.getByRole('combobox', { name, exact: true }),
    ).toHaveAttribute('data-selected-label', option);
  };
  // Confirm needs a complete ship-to (ruling E). This customer has no address
  // book, so the order's own ship-to lines are typed after it is chosen.
  const fillShipTo = async () => {
    await page.getByLabel('Street', { exact: true }).fill('100 Industrial Way');
    await page.getByLabel('City', { exact: true }).fill('Calgary');
    await page.getByLabel('Postal code', { exact: true }).fill('T2P 0A1');
    await page.getByLabel('Country', { exact: true }).fill('Canada');
  };
  // Put stock on hand through the Inventory stock document and its registered
  // posting command; fulfillment receives no setup shortcut. The document is
  // numbered on save, and an adjustment is its type unless another is chosen.
  await page.goto(url('inventory_transaction', 'form'));
  await page
    .getByLabel('Reason', { exact: true })
    .selectOption({ label: 'Found' });
  await page
    .getByLabel('Narrative', { exact: true })
    .fill('Stock for fulfillment walkthrough');
  await page
    .getByLabel('Effective date (UTC) *', { exact: true })
    .fill(instant.slice(0, 19));
  await pick('Line 1 product', 'OFF-100', 'Field notebook');
  await pick('Line 1 to location', 'Calgary', 'Calgary warehouse');
  await page.getByLabel('Line 1 quantity', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page).toHaveURL(/inventory_transaction_detail/u);
  await expect(page.locator('.composition-header')).toContainText(/STK-\d{6}/u);
  await command('Post');

  // The customer picker offers only parties with an active customer role, so
  // the role exists before the order. Reservation activation still checks the
  // current persisted party-role facts on the server.
  await page.goto(url('party_role', 'form'));
  await choose('party_role', 'kind', 'Customer');
  await choose('party_role', 'status', 'Active');
  await relate('party_role_party', customerPartyId);
  await save();
  await page.goto(url('sales_order', 'form'));
  // The order number is assigned by the server on first save.
  await page.getByLabel('Order date (UTC) *').fill(instant.slice(0, 16));
  await page.getByLabel('Requested date (UTC)').fill(instant.slice(0, 16));
  await page.getByLabel('Notes').fill('Partial shipment and correction');
  await pick('Customer', 'Alpine', 'Alpine Office Supply');
  // The declared currency default; the unit follows the product's base unit.
  await expect(page.getByLabel('Currency *')).toHaveValue('CAD');
  await fillShipTo();
  await pick('Line 1 product', 'OFF-100', 'Field notebook');
  await expect(
    page.getByRole('status', { name: 'Line 1 unit', exact: true }),
  ).toHaveText('EA');
  await page.getByLabel('Line 1 quantity', { exact: true }).fill('10');
  await page.getByLabel('Line 1 unit price', { exact: true }).fill('12.5');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page).toHaveURL(/sales_order_detail/u);
  const orderId = new URL(page.url()).searchParams.get('record')!;
  const orderLineId = (await page
    .locator('[data-composition-dataset$="dataset.fulfillment_lines"] tbody tr')
    .filter({ hasText: 'Field notebook' })
    .getAttribute('data-record-id'))!;
  expect(orderLineId).toBeTruthy();
  await command('Confirm', false);

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
  // The shipment number is assigned on create (SHP-000001).
  await expect(page.locator('.composition-header')).toContainText(/SHP-\d{6}/u);
  await expect(
    page.locator(
      '[data-composition-dataset$="dataset.packing_lines"] tbody tr',
    ),
  ).toHaveCount(1);
  await page.goto(url('shipment', 'detail', initialShipment.shipmentId));
  // The shipment number is assigned on create (SHP-000001).
  await expect(page.locator('.composition-header')).toContainText(/SHP-\d{6}/u);
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
  await page.getByLabel('Order date (UTC) *').fill(instant.slice(0, 16));
  await page.getByLabel('Requested date (UTC)').fill(instant.slice(0, 16));
  await pick('Customer', 'Alpine', 'Alpine Office Supply');
  await expect(page.getByLabel('Currency *')).toHaveValue('CAD');
  await fillShipTo();
  await pick('Line 1 product', 'OFF-100', 'Field notebook');
  await page.getByLabel('Line 1 quantity', { exact: true }).fill('2');
  await page.getByLabel('Line 1 unit price', { exact: true }).fill('12.5');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page).toHaveURL(/sales_order_detail/u);
  const closureOrderId = new URL(page.url()).searchParams.get('record')!;
  const closureLineId = (await page
    .locator('[data-composition-dataset$="dataset.fulfillment_lines"] tbody tr')
    .filter({ hasText: 'Field notebook' })
    .getAttribute('data-record-id'))!;
  expect(closureLineId).toBeTruthy();
  await command('Confirm', false);
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
    order: closureOrderId,
    orderLine: closureLineId,
    quantity: '2',
    reservationId: closureReservationId,
  });
  await page.goto(url('shipment', 'detail', closureShipment.shipmentId));
  await command('Post');
  await page.goto(url('sales_order', 'detail', closureOrderId));
  await command('Close');
  await expect(
    page.locator('.composition-header').getByText('Closed', { exact: true }),
  ).toBeVisible();
  // Ruling F: a closed order may be reopened (nothing is invoiced yet); it
  // returns to the released state, confirmed like any consequential command.
  await command('Reopen');
  await expect(
    page.locator('.composition-header').getByText('Released', { exact: true }),
  ).toBeVisible();

  console.log(
    `SALE_FULFILLMENT_WALKTHROUGH ${JSON.stringify({ closureOrderId, closureShipmentId: closureShipment.shipmentId, correctionShipmentId: correction.shipmentId, initialShipmentId: initialShipment.shipmentId, movementId, orderId, orderLineId, packingDocument: true, partialShipment: '5', reservationId, reserveSequence: ['10/8/2', '5/3/2', '5/0/5'], shortageRefused: true, silentReservationResurrection: false })}`,
  );

  async function createShipment(input: {
    kind: 'initial' | 'correction' | 'reversal';
    order?: string;
    orderLine?: string;
    quantity: string;
    reservationId: string;
    supersedes?: string;
    reversalOfMovementId?: string;
  }) {
    await page.goto(url('shipment', 'form'));
    await choose('shipment', 'state', 'draft');
    await choose('shipment', 'kind', input.kind);
    await fill('shipment', 'effective_at', instant);
    await fill('shipment', 'location_id', locationId);
    await fill('shipment', 'external_reference', `PICK-${suffix}`);
    await fill('shipment', 'reason_code', input.kind);
    await fill('shipment', 'reason_narrative', `${input.kind} walkthrough`);
    // An initial shipment keeps the complete ship-to it goes to (ruling E).
    if (input.kind === 'initial')
      for (const [name, value] of [
        ['ship_to_street', '100 Industrial Way'],
        ['ship_to_city', 'Calgary'],
        ['ship_to_postal_code', 'T2P 0A1'],
        ['ship_to_country', 'Canada'],
      ] as const)
        await fill('shipment', name, value);
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
