import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { startComposedApplication } from '../../../api/src/composition-root.js';
import { withEphemeralPostgres } from '../../../../test/helpers/postgres.js';

const legalEntityId = '74000000-0000-4000-8000-000000000001';
const itemId = '71000000-0000-4000-8000-000000000011';
const locationId = '71000000-0000-4000-8000-000000000021';

test('authorized receiving journey denies a revoked grant, then posts and shows server progress', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const externalBaseUrl = process.env.COMPOSED_APPLICATION_BASE_URL;
  if (externalBaseUrl) {
    // An external run must explicitly identify its disposable lane-owned DB.
    const databaseUrl = process.env.RECEIVING_TEST_DATABASE_URL;
    if (!databaseUrl)
      throw new Error('RECEIVING_TEST_DATABASE_URL is required');
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      await journey(page, externalBaseUrl, pool);
    } finally {
      await pool.end();
    }
    return;
  }
  await withEphemeralPostgres(
    'authorized-receiving-browser',
    async ({ connection, pool }) => {
      const application = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        port: 0,
        tenantSlug: 'authorized-receiving-browser',
      });
      try {
        await journey(page, application.baseUrl, pool);
      } finally {
        await application.close();
      }
    },
  );
});

async function journey(
  page: Page,
  baseUrl: string,
  pool: pg.Pool,
): Promise<void> {
  page.setDefaultTimeout(10_000);
  const definition = JSON.parse(
    await readFile(
      new URL('../../release/app.authored.json', import.meta.url),
      'utf8',
    ),
  ) as {
    queries: {
      queryId: string;
      legalEntityScope?: { operand: { parameterId: string } };
    }[];
  };
  function url(
    local: string,
    role: 'form' | 'detail',
    recordId?: string,
  ): string {
    const query = definition.queries.find(
      (candidate) => candidate.queryId === `northstar.app:query.${local}_get`,
    );
    if (!query?.legalEntityScope)
      throw new Error(`Missing scoped query: ${local}`);
    return `${baseUrl}/?${new URLSearchParams({
      surface: `northstar.app:surface.${local}_${role}`,
      [query.legalEntityScope.operand.parameterId]: legalEntityId,
      ...(recordId ? { record: recordId } : {}),
    })}`;
  }
  async function fill(label: string, value: string): Promise<void> {
    const fields: Record<string, string> = {
      Number: 'number',
      'Supplier party': 'supplier_party_id',
      'Order date': 'order_date',
      Currency: 'currency',
      'Line number': 'line_number',
      'Item id': 'item_id',
      'Ordered quantity': 'ordered_quantity',
      'Receipt number': 'number',
      'Received at': 'effective_at',
      'Receiving location': 'location_id',
      'Reason code': 'reason_code',
      Reason: 'reason_narrative',
      Item: 'item_id',
      Quantity: 'quantity',
      'Base unit': 'unit_id',
      'Actual received unit cost': 'unit_cost',
      'Actual cost currency': 'currency',
    };
    const operationId = await page
      .locator('form#surface-record-form input[name="operationId"]')
      .inputValue();
    const local = operationId.split(':operation.')[1]!.replace(/_create$/u, '');
    await page
      .locator(`[name="value:northstar.app:field.${local}_${fields[label]}"]`)
      .fill(value);
  }
  async function relation(local: string, id: string): Promise<void> {
    await page
      .locator(`select[name="relation:northstar.app:relation.${local}"]`)
      .selectOption(id);
  }
  async function save(): Promise<string> {
    const id = await page
      .locator('form#surface-record-form input[name="recordId"]')
      .inputValue();
    await page
      .locator('[data-platform-slot="record:commandBar"]')
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText('Create complete');
    return id;
  }
  const suffix = randomUUID().slice(0, 8);
  await page.goto(url('purchase_order', 'form'));
  await expect(
    page.locator(
      '[name="value:northstar.app:derived_state_field.machine.purchase_order_lifecycle"]',
    ),
  ).toHaveCount(0);
  await fill('Number', `RECEIPT-PO-${suffix}`);
  await fill('Supplier party', 'local-receiving-supplier');
  await fill('Order date', new Date().toISOString());
  await fill('Currency', 'CAD');
  const orderId = await save();
  await page.goto(url('purchase_order_line', 'form'));
  await fill('Line number', '1');
  await fill('Item id', itemId);
  await fill('Ordered quantity', '5');
  await relation('purchase_order_line_order', orderId);
  const orderLineId = await save();
  const orderUrl = url('purchase_order', 'detail', orderId);
  await page.goto(orderUrl);
  await page.getByRole('button', { name: 'Release', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Release complete');
  const progress = page.locator(`[data-order-line="${orderLineId}"]`);
  await expect(progress.locator('td')).toHaveText([itemId, '5', '0', '5']);
  await page
    .getByRole('link', { name: 'Create goods receipt', exact: true })
    .click();
  await fill('Receipt number', `RECEIPT-GR-${suffix}`);
  await page
    .getByRole('combobox', { name: 'State', exact: true })
    .selectOption({ label: 'draft' });
  await page
    .getByRole('combobox', { name: 'Kind', exact: true })
    .selectOption({ label: 'initial' });
  await fill('Received at', new Date().toISOString());
  await fill('Receiving location', locationId);
  await fill('Reason code', 'DELIVERY');
  await fill('Reason', 'Authorized receiving browser journey');
  await relation('goods_receipt_order', orderId);
  const receiptId = await save();
  await page.goto(url('goods_receipt', 'detail', receiptId));
  await page
    .getByRole('link', { name: 'Add receipt line', exact: true })
    .click();
  await fill('Line number', '1');
  await fill('Item', itemId);
  await fill('Quantity', '3');
  await fill('Base unit', 'EA');
  await page
    .locator(
      '[name="value:northstar.app:field.goods_receipt_line_cost_status"]',
    )
    .selectOption({ label: 'known' });
  await fill('Actual received unit cost', '12.5');
  await fill('Actual cost currency', 'CAD');
  await relation('goods_receipt_line_receipt', receiptId);
  await relation('goods_receipt_line_order_line', orderLineId);
  await save();

  const grants = await pool.query<{
    tenant_id: string;
    environment_id: string;
    role_id: string;
  }>(
    `SELECT g.tenant_id, g.environment_id, g.role_id
       FROM platform.current_policy_permission_grants g
       JOIN platform.current_policy_roles r USING (tenant_id, environment_id, role_id)
      WHERE r.role_key = 'local-demo-full-release' AND r.revoked_at IS NULL
        AND g.permission_id = 'northstar.app:permission.goods_receipt_post'
        AND g.resource_id = 'northstar.app:entity.goods_receipt' AND g.revoked_at IS NULL`,
  );
  expect(grants.rows).toHaveLength(1);
  const grant = grants.rows[0]!;
  const scope = [grant.tenant_id, grant.environment_id, grant.role_id];
  async function deniedPosts(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.trust_action_invocations
      WHERE tenant_id=$1 AND environment_id=$2
        AND action_id='northstar.app:operation.goods_receipt_post'
        AND outcome='DENIED' AND policy_decision='DENY'`,
      scope.slice(0, 2),
    );
    return Number(result.rows[0]!.count);
  }
  const deniedBefore = await deniedPosts();
  const grantWhere = `tenant_id=$1 AND environment_id=$2 AND role_id=$3
    AND permission_id='northstar.app:permission.goods_receipt_post'
    AND resource_id='northstar.app:entity.goods_receipt'`;
  // Revoke after rendering the command: submitting stale UI must reauthorize.
  await page.goto(url('goods_receipt', 'detail', receiptId));
  await pool.query(
    `UPDATE platform.current_policy_permission_grants SET revoked_at=transaction_timestamp() WHERE ${grantWhere}`,
    scope,
  );
  try {
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await page
      .getByRole('button', { name: 'Confirm Post', exact: true })
      .click();
    await expect(
      page.locator('[data-diagnostic-code="OPERATION_PERMISSION_DENIED"]'),
    ).toHaveCount(1);
    expect(await deniedPosts()).toBe(deniedBefore + 1);
    await page.goto(orderUrl);
    await expect(progress.locator('td')).toHaveText([itemId, '5', '0', '5']);
  } finally {
    await pool.query(
      `UPDATE platform.current_policy_permission_grants SET revoked_at=NULL WHERE ${grantWhere}`,
      scope,
    );
  }
  await page.goto(url('goods_receipt', 'detail', receiptId));
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Post', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Post complete');
  await expect(page.getByText(/Active · revision 2/)).toBeVisible();
  await page
    .getByRole('link', { name: 'View order progress', exact: true })
    .click();
  await page
    .getByRole('link', {
      name: `Open Purchase order RECEIPT-PO-${suffix}`,
      exact: true,
    })
    .click();
  await expect(progress.locator('td')).toHaveText([itemId, '5', '3', '2']);
  console.log(
    `RECEIVING_AUTHORIZED_WALKTHROUGH ${JSON.stringify({ orderUrl, receiptUrl: url('goods_receipt', 'detail', receiptId), ordered: '5', received: '3', remaining: '2', revokedPostDenied: true })}`,
  );
}
