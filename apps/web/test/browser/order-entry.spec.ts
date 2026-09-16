import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

test('normal shared order workspace creates, edits, removes, saves and reopens Sales and Purchase drafts', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, measure) => {
    const captures: unknown[] = [];
    const capture = async (name: string) => {
      for (const [size, width, height] of [
        ['desktop', 1280, 800],
        ['mobile', 390, 844],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => window.scrollTo(0, 0));
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`${name}-${size}.png`),
          fullPage: true,
        });
        captures.push({
          name,
          size,
          width,
          height,
          url: page.url(),
          releaseId: await page
            .locator('.app-shell')
            .getAttribute('data-release-id'),
          releaseRoot: await page
            .locator('.app-shell')
            .getAttribute('data-release-content-hash'),
        });
      }
      await page.setViewportSize({ width: 1280, height: 800 });
    };
    await page.goto(url);
    await expect(
      page.getByRole('heading', { name: 'Sales orders', level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText('Select legal entity', { exact: true }),
    ).toHaveCount(0);
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await header(page, 'SO-ENTRY-BROWSER', 'Customer');
    await line(page, 1, 'Field notebook · OFF-100', '10', true);
    await page.getByRole('button', { name: 'Add line', exact: true }).click();
    await line(page, 2, 'Fine-point pen set · OFF-120', '2', true);
    await page.getByRole('button', { name: 'Add line', exact: true }).click();
    await line(page, 3, 'Task lamp · OFF-210', '4', true);
    await page
      .getByRole('group', { name: 'Line 2', exact: true })
      .getByLabel('Quantity *')
      .fill('3');
    await page
      .getByRole('button', { name: 'Remove line 3', exact: true })
      .click();
    await expect(page.locator('[data-draft-line]')).toHaveCount(2);
    await capture('sales-draft-editor');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page).toHaveURL(/sales_order_detail/);
    await expect(page.locator('.composition-header')).toContainText(
      'SO-ENTRY-BROWSER',
    );
    const orderId = new URL(page.url()).searchParams.get('record');
    await page.getByRole('link', { name: 'Sales', exact: true }).click();
    await page
      .getByRole('link', {
        name: 'Open Sales orders SO-ENTRY-BROWSER',
        exact: true,
      })
      .click();
    expect(new URL(page.url()).searchParams.get('record')).toBe(orderId);
    await capture('sales-saved-reopened');
    const salesUrl = page.url();
    await page.locator('.composition-record-actions > summary').click();
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await expect(
      page
        .getByRole('group', { name: 'Line 2', exact: true })
        .getByLabel('Quantity *'),
    ).toHaveValue(/^3(?:\.0+)?$/);
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await page.getByRole('link', { name: 'Purchasing', exact: true }).click();
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await header(page, 'PO-ENTRY-BROWSER', 'Vendor');
    await line(page, 1, 'Field notebook · OFF-100', '10', false);
    await page.getByRole('button', { name: 'Add line', exact: true }).click();
    await line(page, 2, 'Fine-point pen set · OFF-120', '2', false);
    await page.getByRole('button', { name: 'Add line', exact: true }).click();
    await line(page, 3, 'Task lamp · OFF-210', '4', false);
    await page
      .getByRole('group', { name: 'Line 2', exact: true })
      .getByLabel('Quantity *')
      .fill('3');
    await page
      .getByRole('button', { name: 'Remove line 3', exact: true })
      .click();
    await capture('purchase-draft-editor');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page).toHaveURL(/purchase_order_detail/);
    const purchaseId = new URL(page.url()).searchParams.get('record');
    await page.getByRole('link', { name: 'Purchasing', exact: true }).click();
    await page.getByRole('link', { name: /Open .*PO-ENTRY-BROWSER$/ }).click();
    expect(new URL(page.url()).searchParams.get('record')).toBe(purchaseId);
    await capture('purchase-saved-reopened');
    const purchaseUrl = page.url();
    await page.locator('.composition-record-actions > summary').click();
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await expect(
      page
        .getByRole('group', { name: 'Line 2', exact: true })
        .getByLabel('Quantity *'),
    ).toHaveValue(/^3(?:\.0+)?$/);
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await measure('drafts', orderId!, purchaseId!);
    const navigation = page.getByRole('navigation', {
      name: 'Release navigation',
    });
    for (const local of [
      'reservation',
      'reservation_balance',
      'sales_order_line',
      'sales_order_shipped',
      'shipment_line',
      'purchase_order_line',
      'goods_receipt_line',
      'purchase_order_received',
    ])
      await expect(
        navigation.locator(`a[href*="surface.${local}_list"]`),
      ).toHaveCount(0);
    await page.goto(salesUrl);
    await page.locator('.composition-record-actions > summary').click();
    await page.getByRole('button', { name: 'Release', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Release complete');
    await expect(
      page.getByRole('link', { name: 'Edit', exact: true }),
    ).toHaveCount(0);
    const lines = () =>
      page.locator('[data-composition-dataset$="dataset.fulfillment_lines"]');
    const reservations = () =>
      page.locator('[data-composition-dataset$="dataset.line_reservations"]');
    const task = () => page.locator('[data-composition-task]');
    await lines()
      .locator('tbody tr')
      .filter({ hasText: 'Field notebook' })
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Reserve stock', exact: true })
      .click();
    await page.getByLabel('Quantity to reserve', { exact: true }).fill('8');
    await page
      .getByLabel('Stock location')
      .selectOption({ label: 'Calgary warehouse' });
    await page
      .getByRole('button', { name: 'Review reservation', exact: true })
      .click();
    const token = await task().locator('[name=taskToken]').inputValue();
    const prepared = await task().locator('[name=preparedId]').inputValue();
    const second = await measure('second_company');
    const other = await page.context().newPage();
    await other.goto(url);
    await other
      .getByRole('navigation', { name: 'Company', exact: true })
      .getByRole('link', { name: 'Second company', exact: true })
      .click();
    expect(
      new URL(other.url()).searchParams.get(
        'northstar.app:parameter.sales_order_list_legal_entity_scope',
      ),
    ).toBe(second.companyId);
    expect(
      new URL(page.url()).searchParams.get(
        'northstar.app:parameter.sales_order_get_legal_entity_scope',
      ),
    ).not.toBe(second.companyId);
    expect(await task().locator('[name=taskToken]').inputValue()).toBe(token);
    expect(await task().locator('[name=preparedId]').inputValue()).toBe(
      prepared,
    );
    await other.close();
    await page
      .getByRole('button', { name: 'Confirm reservation', exact: true })
      .click();
    await expect(task()).toContainText('complete');
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    await measure('reserved');
    await capture('sales-reserved');
    await reservations()
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Ship reserved stock', exact: true })
      .click();
    await page.getByLabel('Quantity to ship', { exact: true }).fill('5');
    await page
      .getByRole('button', { name: 'Review shipment', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm shipment', exact: true })
      .click();
    await expect(task()).toContainText('complete');
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    await measure('shipped');
    await capture('sales-partial-shipment');
    await page.locator('.composition-context-overflow summary').click();
    await page
      .getByRole('button', { name: 'Release remainder', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Review release', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm release', exact: true })
      .click();
    await expect(task()).toContainText('complete');
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    await measure('released');
    await capture('sales-remainder-released');
    await page.getByRole('link', { name: 'Open packing', exact: true }).click();
    const packed = page.locator(
      '[data-composition-dataset$="dataset.packing_lines"]',
    );
    await expect(packed.locator('tbody tr')).toHaveCount(1);
    await expect(packed.locator('td[data-column-label="Quantity"]')).toHaveText(
      '5',
    );
    await capture('sales-packing');
    await page.goto(purchaseUrl);
    await page.locator('.composition-record-actions > summary').click();
    await page.getByRole('button', { name: 'Release', exact: true }).click();
    await expect(
      page.getByRole('link', { name: 'Edit', exact: true }),
    ).toHaveCount(0);
    await page
      .locator(
        '[data-composition-dataset$="dataset.purchasing_lines"] tbody tr',
      )
      .filter({ hasText: 'Field notebook' })
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Receive with actual cost', exact: true })
      .click();
    await page.getByLabel('Quantity to receive', { exact: true }).fill('2');
    await page.getByLabel('Base unit', { exact: true }).fill('EA');
    await page
      .getByRole('combobox', { name: 'Receiving location', exact: true })
      .selectOption({ label: 'Calgary warehouse' });
    await page
      .getByLabel('Actual received unit cost', { exact: true })
      .fill('2.45');
    await page.getByLabel('Actual cost currency', { exact: true }).fill('CAD');
    await page
      .getByRole('button', {
        name: 'Review Receive with actual cost',
        exact: true,
      })
      .click();
    await capture('purchase-receive-review');
    await page
      .getByRole('button', {
        name: 'Confirm Receive with actual cost',
        exact: true,
      })
      .click();
    await expect(task()).toContainText('complete');
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    await measure('received');
    await capture('purchase-received');
    await writeFile(
      testInfo.outputPath('captures.json'),
      JSON.stringify(captures, null, 2),
    );
  }, testInfo.outputPath('serving.json'));
});
async function header(page: Page, number: string, party: string) {
  await page.getByLabel('Order number *').fill(number);
  await page
    .getByLabel(`${party} *`)
    .selectOption({ label: 'Alpine Office Supply' });
  await page.getByLabel('Order date (UTC) *').fill('2026-09-15T12:00');
  await page.getByLabel('Currency *').fill('CAD');
}
async function line(
  page: Page,
  index: number,
  item: string,
  quantity: string,
  sales: boolean,
) {
  const group = page.getByRole('group', { name: `Line ${index}`, exact: true });
  await group.getByLabel('Product *').selectOption({
    label: item + (item.includes('OFF-120') ? ' · BOX' : ' · EA'),
  });
  await group.getByLabel('Quantity *').fill(quantity);
  if (sales)
    await group
      .getByLabel('Unit *')
      .fill(item.includes('OFF-120') ? 'BOX' : 'EA');
  await group.getByLabel('Unit price').fill('12.5');
}
async function fixture(
  run: (
    url: string,
    measure: (
      phase: string,
      orderId?: string,
      purchaseId?: string,
    ) => Promise<{ companyId?: string }>,
  ) => Promise<void>,
  servingPath: string,
) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'test/helpers/order-entry-fixture.ts',
      '--serve',
      '--verify',
    ],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let resolveReady: (url: string) => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exited = once(child, 'exit');
  let resolveMeasurement: ((value: { companyId?: string }) => void) | null =
    null;
  let rejectMeasurement: ((error: Error) => void) | null = null;
  let consumed = '';
  const measurements: unknown[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    const match = /ORDER_ENTRY_URL=(.*)/.exec(output);
    if (match) resolveReady(match[1]!);
    consumed += chunk.toString();
    const lines = consumed.split('\n');
    consumed = lines.pop()!;
    for (const line of lines)
      if (line.startsWith('ORDER_ENTRY_MEASURED=')) {
        const value = JSON.parse(line.slice('ORDER_ENTRY_MEASURED='.length));
        measurements.push(value);
        resolveMeasurement?.(value);
        resolveMeasurement = null;
      }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.once('error', (error) => rejectReady(error));
  child.once('exit', () => rejectReady(new Error(output)));
  child.once('exit', () => rejectMeasurement?.(new Error(output)));
  const measure = (phase: string, orderId?: string, purchaseId?: string) =>
    new Promise<{ companyId?: string }>((resolve, reject) => {
      resolveMeasurement = resolve;
      rejectMeasurement = reject;
      child.stdin.write(JSON.stringify({ phase, orderId, purchaseId }) + '\n');
    });
  try {
    const url = await ready;
    const serving = /ORDER_ENTRY_SERVING=(.*)/.exec(output);
    expect(serving, output).not.toBeNull();
    await writeFile(servingPath, serving![1]! + '\n');
    console.log('ORDER_ENTRY_SERVING ' + serving![1]);
    await run(url, measure);
    console.log('ORDER_ENTRY_PERSISTED ' + JSON.stringify(measurements));
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    const [code] = await exited;
    expect(code, output).toBe(0);
  }
}
