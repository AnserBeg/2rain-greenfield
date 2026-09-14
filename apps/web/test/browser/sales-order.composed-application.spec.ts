import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { startComposedApplication } from '../../../api/src/composition-root.js';
import {
  receiptColumn,
  receiptTable,
  quoteReceiptIdentifier as q,
} from '../../../../packages/postgres-provider/src/goods-receipt.js';
import { governedStorageTarget } from '../../../../test/helpers/governed-storage-target.js';
import { withEphemeralPostgres } from '../../../../test/helpers/postgres.js';

const legalEntityId = '74000000-0000-4000-8000-000000000001';
const customerPartyId = '71000000-0000-4000-8000-000000000001';
const itemId = '71000000-0000-4000-8000-000000000011';

test('sales order works through forms, policy, scope and server lifecycle without touching stock', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const externalBaseUrl = process.env.COMPOSED_APPLICATION_BASE_URL;
  if (externalBaseUrl) {
    const databaseUrl = process.env.SALES_TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('SALES_TEST_DATABASE_URL is required');
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      await journey(page, externalBaseUrl, pool);
    } finally {
      await pool.end();
    }
    return;
  }
  await withEphemeralPostgres(
    'sales-order-browser',
    async ({ connection, pool }) => {
      const application = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        port: 0,
        tenantSlug: 'sales-order-browser',
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
  page.setDefaultTimeout(10_000);
  const target = await governedStorageTarget();
  const entity = (local: string) => {
    const found = target.entities.filter((candidate) =>
      candidate.entityId.endsWith(`:entity.${local}`),
    );
    if (found.length !== 1) throw new Error(`Expected one ${local} entity`);
    return found[0]!;
  };
  const salesOrder = entity('sales_order');
  const salesOrderLine = entity('sales_order_line');
  const movement = entity('inventory_movement');
  const balance = entity('posted_stock_balance');
  const party = entity('party');
  const grant = await pool.query<{
    environment_id: string;
    role_id: string;
    tenant_id: string;
  }>(
    `SELECT g.tenant_id,g.environment_id,g.role_id
       FROM platform.current_policy_permission_grants g
       JOIN platform.current_policy_roles r USING (tenant_id,environment_id,role_id)
      WHERE r.role_key='local-demo-full-release' AND r.revoked_at IS NULL
        AND g.permission_id='northstar.app:permission.sales_order_update'
        AND g.resource_id='northstar.app:entity.sales_order'
        AND g.revoked_at IS NULL`,
  );
  expect(grant.rows).toHaveLength(1);
  const scope = grant.rows[0]!;
  const scopeValues = [scope.tenant_id, scope.environment_id];

  const customer = await pool.query(
    `SELECT record_id FROM ${receiptTable(party)}
      WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL`,
    [...scopeValues, customerPartyId],
  );
  expect(customer.rows).toHaveLength(1);

  const url = (
    local: string,
    role: 'detail' | 'form' | 'list',
    recordId?: string,
    selectedEntity = legalEntityId,
  ) => {
    const queryRole = role === 'list' ? 'list' : 'get';
    const parameters = new URLSearchParams({
      surface: `northstar.app:surface.${local}_${role}`,
      [`northstar.app:parameter.${local}_${queryRole}_legal_entity_scope`]:
        selectedEntity,
    });
    if (recordId) parameters.set('record', recordId);
    return `${baseUrl}/?${parameters}`;
  };
  const field = async (local: string, name: string, value: string) => {
    await page
      .locator(`[name="value:northstar.app:field.${local}_${name}"]`)
      .fill(value);
  };
  const save = async () => {
    const id = await page
      .locator('form#surface-record-form input[name="recordId"]')
      .inputValue();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    return id;
  };
  const snapshot = async () => {
    const result: Record<string, string> = {};
    for (const [name, storage] of [
      ['movement', movement],
      ['balance', balance],
    ] as const) {
      const rows = await pool.query<{ snapshot: string }>(
        `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY record_id),'[]'::jsonb)::text AS snapshot
           FROM ${receiptTable(storage)} t
          WHERE tenant_id=$1 AND environment_id=$2 AND ${q(storage.legalEntity!.column)}=$3`,
        [...scopeValues, legalEntityId],
      );
      result[name] = rows.rows[0]!.snapshot;
    }
    return result;
  };
  const initialStock = await snapshot();

  await page.goto(`${baseUrl}/`);
  const navigation = page.getByRole('navigation', {
    name: 'Release navigation',
  });
  const more = navigation
    .locator('.navigation-tree > li')
    .getByRole('group')
    .filter({ hasText: 'More' });
  await more.getByText('More', { exact: true }).click();
  const sales = more.getByRole('group').filter({ hasText: 'Sales' });
  await sales.getByText('Sales', { exact: true }).click();
  await sales.getByRole('link', { name: 'Sales order', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Sales order', exact: true }),
  ).toBeVisible();

  const suffix = randomUUID().slice(0, 8);
  await page.goto(url('sales_order', 'form'));
  await field('sales_order', 'number', `SO-${suffix}`);
  await field('sales_order', 'customer_party_id', customerPartyId);
  await field('sales_order', 'order_date', new Date().toISOString());
  await field('sales_order', 'requested_date', new Date().toISOString());
  await field('sales_order', 'currency', 'CAD');
  await field('sales_order', 'notes', 'Initial sales order');
  const orderId = await save();
  await expect(page.getByRole('status')).toContainText('Create complete');
  expect(await snapshot()).toEqual(initialStock);

  await page.goto(url('sales_order_line', 'form'));
  await field('sales_order_line', 'line_number', '1');
  await field('sales_order_line', 'item_id', itemId);
  await field('sales_order_line', 'unit_id', 'EA');
  await field('sales_order_line', 'ordered_quantity', '10');
  await field('sales_order_line', 'unit_price', '12.5');
  await page
    .locator(
      'select[name="relation:northstar.app:relation.sales_order_line_order"]',
    )
    .selectOption(orderId);
  const lineId = await save();
  await expect(page.getByRole('status')).toContainText('Create complete');
  expect(await snapshot()).toEqual(initialStock);

  const orderFormUrl = url('sales_order', 'form', orderId);
  await page.goto(orderFormUrl);
  await field('sales_order', 'notes', 'Edited while draft');
  const staleUpdate = await formPayload(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Update complete');
  expect(await snapshot()).toEqual(initialStock);

  staleUpdate.idempotencyKey = randomUUID();
  staleUpdate[`value:northstar.app:field.sales_order_notes`] =
    'Stale revision must not persist';
  const staleResponse = await page.request.post(orderFormUrl, {
    form: staleUpdate,
  });
  expect(await staleResponse.text()).toContain('MODULE_REVISION_CONFLICT');

  await page.goto(orderFormUrl);
  const deniedStateBefore = await businessState();
  await pool.query(
    `UPDATE platform.current_policy_permission_grants
        SET revoked_at=transaction_timestamp()
      WHERE tenant_id=$1 AND environment_id=$2 AND role_id=$3
        AND permission_id='northstar.app:permission.sales_order_update'
        AND resource_id='northstar.app:entity.sales_order'`,
    [...scopeValues, scope.role_id],
  );
  await field('sales_order', 'notes', 'This denied value must not persist');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.locator('[data-diagnostic-code="OPERATION_PERMISSION_DENIED"]'),
  ).toHaveCount(1);
  expect(await businessState()).toEqual(deniedStateBefore);
  expect(await snapshot()).toEqual(initialStock);

  const lineFormUrl = url('sales_order_line', 'form', lineId);
  await page.goto(lineFormUrl);
  const releasedLineAttempt = await formPayload(page);
  await page.goto(url('sales_order', 'detail', orderId));
  const lineRow = page.locator(
    `[data-composition-dataset$="dataset.fulfillment_lines"] [data-record-id="${lineId}"]`,
  );
  for (const [label, value] of Object.entries({
    Line: '1',
    Item: 'Field notebook',
    Ordered: '10',
    Reserved: '0',
    Shipped: '0',
    'Open to ship': '10',
    Unit: 'EA',
  }))
    await expect(
      lineRow.locator(`td[data-column-label="${label}"]`),
    ).toHaveText(value);
  await page.getByRole('button', { name: 'Release', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Release complete');
  expect(await snapshot()).toEqual(initialStock);

  releasedLineAttempt.idempotencyKey = randomUUID();
  releasedLineAttempt[
    `value:northstar.app:field.sales_order_line_ordered_quantity`
  ] = '11';
  releasedLineAttempt[`value:northstar.app:field.sales_order_line_unit_price`] =
    '12.5';
  const releasedEdit = await page.request.post(lineFormUrl, {
    form: releasedLineAttempt,
  });
  expect(await releasedEdit.text()).toContain(
    'MODULE_OPERATION_PRECONDITION_REFUSED',
  );
  await page.goto(lineFormUrl);
  await expect(
    page.locator(
      '[name="value:northstar.app:field.sales_order_line_ordered_quantity"]',
    ),
  ).toHaveValue('10.000000000000000000');
  expect(await businessState()).toEqual({
    lineQuantity: '10.000000000000000000',
    notes: 'Edited while draft',
    state: 'northstar.app:state.sales_order_released',
  });
  expect(await snapshot()).toEqual(initialStock);

  await page.goto(url('sales_order', 'detail', orderId));
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page
    .getByRole('button', { name: 'Confirm Cancel', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Cancel complete');
  expect(await businessState()).toEqual({
    lineQuantity: '10.000000000000000000',
    notes: 'Edited while draft',
    state: 'northstar.app:state.sales_order_cancelled',
  });
  expect(await snapshot()).toEqual(initialStock);

  // Narrow the demo's explicit local grant immediately before the foreign
  // read. The installed evaluator must refuse the other legal entity.
  await pool.query(
    `UPDATE platform.current_policy_memberships
        SET legal_entity_id=$4
      WHERE tenant_id=$1 AND environment_id=$2 AND role_id=$3 AND revoked_at IS NULL`,
    [...scopeValues, scope.role_id, legalEntityId],
  );
  const foreignEntity = randomUUID();
  await page.goto(url('sales_order', 'list', undefined, foreignEntity));
  await expect(
    page.locator('[data-diagnostic-code="QUERY_PERMISSION_DENIED"]'),
  ).toHaveCount(1);
  expect(await businessState()).toEqual({
    lineQuantity: '10.000000000000000000',
    notes: 'Edited while draft',
    state: 'northstar.app:state.sales_order_cancelled',
  });
  expect(await snapshot()).toEqual(initialStock);

  console.log(
    `SALES_ORDER_WALKTHROUGH ${JSON.stringify({ customerPartyId, foreignScopeDenied: true, itemId, lineId, orderId, orderedQuantity: '10', permissionDeniedWithoutMutation: true, releaseEditRefused: true, stockUnchanged: true })}`,
  );

  async function businessState() {
    const stateColumn = receiptColumn(
      salesOrder,
      'derived_state_field.machine.sales_order_lifecycle',
    );
    const notesColumn = receiptColumn(salesOrder, 'sales_order_notes');
    const quantityColumn = receiptColumn(
      salesOrderLine,
      'sales_order_line_ordered_quantity',
    );
    const order = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${receiptTable(salesOrder)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(salesOrder.legalEntity!.column)}=$3 AND record_id=$4`,
      [...scopeValues, legalEntityId, orderId],
    );
    const line = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${receiptTable(salesOrderLine)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(salesOrderLine.legalEntity!.column)}=$3 AND record_id=$4`,
      [...scopeValues, legalEntityId, lineId],
    );
    return {
      lineQuantity: String(line.rows[0]?.[quantityColumn]),
      notes: String(order.rows[0]?.[notesColumn]),
      state: String(order.rows[0]?.[stateColumn]),
    };
  }
}

async function formPayload(page: Page): Promise<Record<string, string>> {
  return Object.fromEntries(
    await page
      .locator('form#surface-record-form')
      .evaluate((form) =>
        [...new FormData(form as HTMLFormElement).entries()].map(
          ([key, value]) => [key, String(value)],
        ),
      ),
  );
}
