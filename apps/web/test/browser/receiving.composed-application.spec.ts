import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { startComposedApplication } from '../../../api/src/composition-root.js';
import { withEphemeralPostgres } from '../../../../test/helpers/postgres.js';
import { governedStorageTarget } from '../../../../test/helpers/governed-storage-target.js';
import {
  receiptBinding,
  receiptColumn,
  receiptRelation,
  receiptTable,
  quoteReceiptIdentifier as q,
} from '../../../../packages/postgres-provider/src/goods-receipt.js';

const legalEntityId = '74000000-0000-4000-8000-000000000001';
const itemId = '71000000-0000-4000-8000-000000000011';
const locationId = '71000000-0000-4000-8000-000000000021';

test('authorized receiving journey denies a revoked grant, then posts and exercises correction, reversal and order lifecycle', async ({
  page,
}) => {
  test.setTimeout(420_000);
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
      'Line revision': 'line_revision',
      'Amendment reason': 'reason',
      'Reversal of movement': 'reversal_of_movement_id',
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
  // The vendor picker offers only parties with an active supplier role.
  await page.goto(
    `${baseUrl}/?${new URLSearchParams({ surface: 'northstar.app:surface.party_role_form' })}`,
  );
  await page
    .locator('select[name="value:northstar.app:field.party_role_kind"]')
    .selectOption('northstar.app:option.supplier');
  await page
    .locator('select[name="value:northstar.app:field.party_role_status"]')
    .selectOption('northstar.app:option.active');
  await relation('party_role_party', '71000000-0000-4000-8000-000000000001');
  await save();
  const suffix = randomUUID().slice(0, 8);
  await page.goto(url('purchase_order', 'form'));
  await expect(
    page.locator(
      '[name="value:northstar.app:derived_state_field.machine.purchase_order_lifecycle"]',
    ),
  ).toHaveCount(0);
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
  // The order number is assigned by the server on first save.
  await page
    .getByLabel('Order date (UTC) *')
    .fill(new Date().toISOString().slice(0, 16));
  await pick('Vendor', 'Alpine', 'Alpine Office Supply');
  await expect(page.getByLabel('Currency *')).toHaveValue('CAD');
  await pick('Line 1 product', 'OFF-100', 'Field notebook');
  await page.getByLabel('Line 1 quantity', { exact: true }).fill('5');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page).toHaveURL(/purchase_order_detail/u);
  const orderNumber = (
    await page.locator('.composition-header h1').innerText()
  ).trim();
  expect(orderNumber).toMatch(/^PO-\d{6}$/u);
  const orderId = new URL(page.url()).searchParams.get('record')!;
  const orderLine = page
    .locator('[data-composition-dataset$="dataset.purchasing_lines"] tbody tr')
    .filter({ hasText: 'Field notebook' });
  const orderLineId = (await orderLine.getAttribute('data-record-id'))!;
  expect(orderLineId).toBeTruthy();
  const orderUrl = url('purchase_order', 'detail', orderId);
  await page.locator('.composition-record-actions > summary').click();
  await page.getByRole('button', { name: 'Release', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Release complete');
  await expectOrderProgress('5', '0', '5');
  await page.goto(url('goods_receipt', 'form'));
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
    await expectOrderProgress('5', '0', '5');
    await expect(
      page.locator('[data-composition-dataset$="dataset.purchasing_receipts"]'),
    ).toContainText(`RECEIPT-GR-${suffix}`);
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
      name: `Open Purchase orders ${orderNumber}`,
      exact: true,
    })
    .click();
  await expectOrderProgress('5', '3', '2');
  console.log(
    `RECEIVING_AUTHORIZED_WALKTHROUGH ${JSON.stringify({ orderUrl, receiptUrl: url('goods_receipt', 'detail', receiptId), ordered: '5', received: '3', remaining: '2', revokedPostDenied: true })}`,
  );

  // The rest of this journey is also browser work, not service/fixture proof.
  const orderLineUrl = url('purchase_order_line', 'detail', orderLineId);
  await page.goto(orderLineUrl);
  await page
    .getByRole('link', { name: 'Request quantity amendment', exact: true })
    .click();
  await fill('Number', `RECEIPT-AM-${suffix}`);
  await fill('Line revision', '1');
  await fill('Quantity', '3');
  await fill(
    'Amendment reason',
    'Correct ordered quantity to actual required quantity',
  );
  await relation('purchase_order_amendment_order_line', orderLineId);
  await save();
  await page.goto(orderLineUrl);
  await command('Amend');
  await expect(page.getByRole('status')).toContainText('Amend complete');
  await page.goto(orderUrl);
  await expectOrderProgress('3', '3', '0');

  const originalMovements = await movementsFor(receiptId);
  expect(originalMovements).toHaveLength(1);
  const originalMovementId = String(originalMovements[0]!.record_id);
  const correctionId = await compensatingReceipt(
    'correction',
    '-1',
    originalMovementId,
  );
  await page.goto(orderUrl);
  await command('Close');
  await expect(page.getByRole('status')).toContainText('Close complete');
  await expect(page.locator('.composition-business-status')).toHaveText(
    'Closed',
  );
  // A staged correction cannot execute while its order is closed.
  await page.goto(url('goods_receipt', 'detail', correctionId));
  await command('Post');
  await expect(page.locator('[data-diagnostic-code]')).toContainText(
    'RECEIPT_ORDER_NOT_RELEASED',
  );
  expect(await movementsFor(correctionId)).toHaveLength(0);
  await page.goto(orderUrl);
  await command('Reopen');
  await expect(page.getByRole('status')).toContainText('Reopen complete');
  await page.goto(url('goods_receipt', 'detail', correctionId));
  await command('Post');
  await expect(page.getByRole('status')).toContainText('Post complete');
  await page.goto(orderUrl);
  await expectOrderProgress('3', '2', '1');
  expect(await movementsFor(receiptId)).toEqual(originalMovements);

  const reversalId = await compensatingReceipt(
    'reversal',
    '-2',
    originalMovementId,
  );
  await page.goto(url('goods_receipt', 'detail', reversalId));
  const key = await page
    .locator('form.capability-command input[name="idempotencyKey"]')
    .inputValue();
  const deniedBeforeReadBack = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM platform.trust_action_invocations WHERE tenant_id=$1 AND environment_id=$2 AND outcome='DENIED'`,
    scope.slice(0, 2),
  );
  const trigger = `receipt_browser_revoke_${suffix}`;
  await pool.query(`CREATE FUNCTION platform.${trigger}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN
    IF NEW.idempotency_key=TG_ARGV[0]::uuid THEN UPDATE platform.current_policy_permission_grants SET revoked_at=clock_timestamp() WHERE tenant_id=NEW.tenant_id AND environment_id=NEW.environment_id AND role_id=TG_ARGV[1]::uuid AND permission_id='northstar.app:permission.goods_receipt_read'; END IF; RETURN NEW; END $$`);
  await pool.query(
    `CREATE TRIGGER ${trigger} AFTER INSERT ON platform.semantic_operation_receipts FOR EACH ROW EXECUTE FUNCTION platform.${trigger}('${key}','${grant.role_id}')`,
  );
  try {
    await command('Post');
    await expect(page.getByRole('status')).toContainText('Operation committed');
    await expect(page.getByRole('status')).toContainText(
      'Do not submit this operation again',
    );
    await expect(page.locator('form')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Post|Retry|Submit/u }),
    ).toHaveCount(0);
    await expect(page.locator('[data-field-id]')).toHaveCount(0);
    const persisted = await pool.query<{
      invocation_id: string;
      change_document_id: string;
      domain_event_id: string;
      outbox_id: string;
    }>(
      `SELECT invocation_id,change_document_id,domain_event_id,outbox_id FROM platform.semantic_operation_receipts WHERE tenant_id=$1 AND environment_id=$2 AND idempotency_key=$3`,
      [...scope.slice(0, 2), key],
    );
    expect(persisted.rows).toHaveLength(1);
    for (const id of Object.values(persisted.rows[0]!))
      await expect(page.locator('[data-operation-trust]')).toContainText(id);
    expect(await movementsFor(reversalId)).toHaveLength(1);
    const deniedAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.trust_action_invocations WHERE tenant_id=$1 AND environment_id=$2 AND outcome='DENIED'`,
      scope.slice(0, 2),
    );
    expect(Number(deniedAfter.rows[0]!.count)).toBe(
      Number(deniedBeforeReadBack.rows[0]!.count) + 1,
    );
  } finally {
    await pool.query(
      `DROP TRIGGER ${trigger} ON platform.semantic_operation_receipts`,
    );
    await pool.query(`DROP FUNCTION platform.${trigger}()`);
    await pool.query(
      `UPDATE platform.current_policy_permission_grants SET revoked_at=NULL WHERE tenant_id=$1 AND environment_id=$2 AND role_id=$3 AND permission_id='northstar.app:permission.goods_receipt_read'`,
      scope,
    );
  }
  await page.goto(orderUrl);
  await expectOrderProgress('3', '0', '3');
  expect(await movementsFor(receiptId)).toEqual(originalMovements);
  console.log(
    `RECEIVING_LIFECYCLE_WALKTHROUGH ${JSON.stringify({ orderUrl, correctionUrl: url('goods_receipt', 'detail', correctionId), reversalUrl: url('goods_receipt', 'detail', reversalId), ordered: '3', received: '0', remaining: '3', committedReadBackWithheld: true })}`,
  );

  async function command(label: string) {
    const secondary = page.locator(
      '.composition-record-actions:not([open]) > summary',
    );
    if (await secondary.count()) await secondary.click();
    await page.getByRole('button', { name: label, exact: true }).click();
    await page
      .getByRole('button', { name: `Confirm ${label}`, exact: true })
      .click();
  }
  async function expectOrderProgress(
    ordered: string,
    received: string,
    remaining: string,
  ) {
    const presentedLine = page.locator(
      `[data-composition-dataset$="dataset.purchasing_lines"] tbody tr[data-record-id="${orderLineId}"]`,
    );
    await expect(
      presentedLine.locator('td[data-column-label="Ordered"]'),
    ).toHaveText(new RegExp(`^${ordered}(?:\\.0+)?$`, 'u'));
    const binding = receiptBinding(await governedStorageTarget())!;
    const result = await pool.query<{ quantity: string }>(
      `SELECT ${q(receiptColumn(binding.received, 'purchase_order_received_received_quantity'))}::text AS quantity FROM ${receiptTable(binding.received)} WHERE ${q(receiptRelation(binding, binding.received, 'purchase_order_received_order_line'))}=$1 AND archived_at IS NULL`,
      [orderLineId],
    );
    const observedReceived = result.rows[0]?.quantity ?? '0';
    expect([ordered, observedReceived, remaining].map(Number)).toEqual([
      Number(ordered),
      Number(received),
      Number(ordered) - Number(received),
    ]);
  }
  async function compensatingReceipt(
    kind: 'correction' | 'reversal',
    quantity: string,
    movement: string,
  ) {
    await page.goto(url('goods_receipt', 'form'));
    await fill('Receipt number', `RECEIPT-${kind}-${suffix}`);
    await page
      .getByRole('combobox', { name: 'State', exact: true })
      .selectOption({ label: 'draft' });
    await page
      .getByRole('combobox', { name: 'Kind', exact: true })
      .selectOption({ label: kind });
    await fill('Received at', new Date().toISOString());
    await fill('Receiving location', locationId);
    await fill('Reason code', 'CORRECTION');
    await fill(
      'Reason',
      'Correct original received facts without rewriting history',
    );
    await relation('goods_receipt_order', orderId);
    await relation('goods_receipt_supersedes', receiptId);
    const id = await save();
    await page.goto(url('goods_receipt', 'detail', id));
    await page
      .getByRole('link', { name: 'Add receipt line', exact: true })
      .click();
    await fill('Line number', '1');
    await fill('Item', itemId);
    await fill('Quantity', quantity);
    await fill('Base unit', 'EA');
    await page
      .locator(
        '[name="value:northstar.app:field.goods_receipt_line_cost_status"]',
      )
      .selectOption({ label: 'absent' });
    await fill('Reversal of movement', movement);
    await relation('goods_receipt_line_receipt', id);
    await relation('goods_receipt_line_order_line', orderLineId);
    await save();
    return id;
  }
  async function movementsFor(
    sourceId: string,
  ): Promise<Record<string, unknown>[]> {
    // Inspect persisted immutable facts only; document creation/posting remains UI-only.
    const binding = receiptBinding(await governedStorageTarget())!;
    return (
      await pool.query(
        `SELECT * FROM ${receiptTable(binding.movement)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(receiptColumn(binding.movement, 'inventory_movement_source_id'))}=$3 ORDER BY record_id`,
        [...scope.slice(0, 2), sourceId],
      )
    ).rows as Record<string, unknown>[];
  }
}
