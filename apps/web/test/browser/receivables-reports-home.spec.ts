import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// REPORTS-HOME through the served application: the metadata-sales fixture
// serves a released order of 10 EA of Field notebook at 12.50, untaxed, for
// Alpine Office Supply, with stock at the Calgary warehouse.
test('Today, customer accounts and receivables aging read the business in one company and one currency, and a customer statement prints', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (orderUrl) => {
    const surface = (local: string) => {
      const url = new URL(orderUrl);
      url.search = '';
      url.searchParams.set('surface', `northstar.app:surface.${local}`);
      return url.toString();
    };
    const row = (name: string) =>
      page.locator('tr[data-record-id]').filter({ hasText: name });
    const cell = (name: string, column: string) =>
      row(name).locator(`td[data-column-label="${column}"]`);
    const total = (label: string) =>
      page
        .locator('[data-list-summary] div')
        .filter({
          has: page.locator('dt', { hasText: new RegExp(`^${label}$`, 'u') }),
        })
        .locator('dd');

    // Today: the page the application opens on -- six tiles, each a count
    // that opens the List behind it, in the one company the entry chose.
    const root = new URL(orderUrl);
    root.search = '';
    await page.goto(root.toString());
    await expect(
      page.getByRole('heading', { name: 'Today', level: 1 }),
    ).toBeVisible();
    const tiles = page.locator('[data-launcher-tile]');
    await expect(tiles).toHaveCount(6);
    await expect(tiles).toContainText([
      'Late receipts',
      'Blocked sales orders',
      'Approvals waiting',
      'Receipts due',
      'Ready to ship',
      'Inventory risks',
    ]);
    for (const label of ['Late receipts', 'Ready to ship'])
      await expect(
        tiles.filter({ hasText: label }).locator('[data-launcher-count]'),
      ).toHaveText('0');
    await capture(page, testInfo, 'today');
    await tiles.filter({ hasText: 'Blocked sales orders' }).click();
    await expect(
      page.getByRole('heading', { name: 'Sales orders', level: 1 }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Views' })
        .locator('[aria-current="page"]'),
    ).toContainText('Blocked by supply');

    // Customer accounts: the released order's open units and value, in CAD.
    await page.goto(surface('customer_account_list'));
    await expect(
      page.getByRole('heading', { name: 'Customer accounts', level: 1 }),
    ).toBeVisible();
    await expect(cell('Alpine Office Supply', 'Open orders')).toHaveText('1');
    await expect(cell('Alpine Office Supply', 'Open units')).toHaveText('10');
    await expect(cell('Alpine Office Supply', 'Open value')).toHaveText(
      '125.00',
    );
    await expect(page.locator('[data-list-summary-currency]')).toHaveText(
      'Totals in CAD',
    );
    await expect(total('Open value')).toHaveText('125.00');
    await capture(page, testInfo, 'customer-accounts');
    // One currency at a time: in USD this order is not counted at all.
    await page.getByLabel('Currency').selectOption('USD');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('[data-list-summary-currency]')).toHaveText(
      'Totals in USD',
    );
    await expect(cell('Alpine Office Supply', 'Open value')).toHaveText('0.00');
    await expect(total('Open value')).toHaveText('0.00');
    await page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('link', { name: /With open orders/u })
      .click();
    await expect(page.getByText('0 matching records')).toBeVisible();

    // Ship 2 EA and invoice them (25.00, due on receipt: due today).
    await page.goto(orderUrl);
    const dataset = (name: string) =>
      page.locator(`[data-composition-dataset$="dataset.${name}"]`);
    await dataset('fulfillment_lines')
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Reserve stock', exact: true })
      .click();
    await page.getByLabel('Quantity to reserve', { exact: true }).fill('2');
    await page
      .getByLabel('Stock location')
      .selectOption({ label: 'Calgary warehouse' });
    await page
      .getByRole('button', { name: 'Review reservation', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm reservation', exact: true })
      .click();
    await expect(page.locator('[data-composition-task]')).toContainText(
      'complete',
    );
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    await dataset('line_reservations')
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Ship reserved stock', exact: true })
      .click();
    await page.getByLabel('Quantity to ship', { exact: true }).fill('2');
    await page.getByLabel('Carrier', { exact: true }).fill('Purolator');
    await page
      .getByLabel('Tracking or BOL number', { exact: true })
      .fill('PUR-RPT-2');
    await page
      .getByRole('button', { name: 'Review shipment', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm shipment', exact: true })
      .click();
    await expect(page.locator('[data-composition-task]')).toContainText(
      'complete',
    );
    await page.goto(orderUrl);
    await page
      .getByRole('button', { name: 'Invoice shipped quantities', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('button', { name: 'Review Invoice shipped quantities' })
      .click();
    await dialog
      .getByRole('button', { name: 'Confirm Invoice shipped quantities' })
      .click();
    await expect(page.getByRole('status').first()).toContainText(
      'Invoice shipped quantities: done',
    );

    // Receivables aging: Alpine owes 25.00, current, in CAD.
    await page.goto(surface('receivables_aging_list'));
    await expect(
      page.getByRole('heading', { name: 'Receivables aging', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('1 matching record')).toBeVisible();
    await expect(cell('Alpine Office Supply', 'Current')).toHaveText('25.00');
    await expect(cell('Alpine Office Supply', 'Over 90 days')).toHaveText(
      '0.00',
    );
    await expect(cell('Alpine Office Supply', 'Total owing')).toHaveText(
      '25.00',
    );
    await expect(cell('Alpine Office Supply', 'Status')).toHaveText('Current');
    await expect(total('Total owing')).toHaveText('25.00');
    await expect(total('Current')).toHaveText('25.00');
    await expect(
      page
        .getByRole('navigation', { name: 'Views' })
        .getByRole('link', { name: 'Past due 0' }),
    ).toBeVisible();
    await capture(page, testInfo, 'receivables-aging');

    // The statement: the customer's account in this company, printable.
    await row('Alpine Office Supply')
      .getByRole('link', { name: /^Statement/u })
      .click();
    await expect(page.locator('.composition-header h1')).toHaveText(
      'Alpine Office Supply',
    );
    const invoices = dataset('customer_account_invoices').locator('tbody tr');
    await expect(invoices).toHaveCount(1);
    await expect(invoices.first()).toContainText(/INV-\d{6}/u);
    await expect(
      invoices.first().locator('td[data-column-label="Balance"]'),
    ).toHaveText('25.00');
    await expect(
      dataset('customer_account_orders').locator('tbody tr'),
    ).toHaveCount(1);
    await capture(page, testInfo, 'customer-account');
    await page.getByRole('link', { name: 'Print statement' }).click();
    await expect(page.locator('.print-document .eyebrow')).toHaveText(
      'Statement',
    );
    await expect(page.locator('.print-document')).toContainText(/INV-\d{6}/u);
    await capture(page, testInfo, 'statement-print');
  });
});

async function capture(
  page: Page,
  testInfo: { outputPath: (name: string) => string },
  name: string,
) {
  for (const [size, width, height] of [
    ['desktop', 1280, 800],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${name} fits ${size} without horizontal scroll`,
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`${name}-${size}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function fixture(run: (url: string) => Promise<void>) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/helpers/meta-sales-fixture.ts', '--serve'],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  const exited = once(child, 'exit');
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /META_SALES_URL=(.*)/.exec(output);
      if (match) resolve(match[1]!);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('exit', () => reject(new Error(output)));
  });
  try {
    await run(await ready);
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
}
