import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// Ruling B through the declared editor and the commercial read model. The
// fixture's Alpine Office Supply is taxed by GST-AB (5%) and orders in CAD;
// its Field notebook lists at 12.50 CAD, 9.25 USD and 8.50 EUR.
test('an order is priced in its currency, discounted and taxed per line, with charges, and totals read half up', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url) => {
    await page.goto(url);
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await pick(page, 'Customer', 'Alpine', 'Alpine Office Supply');
    await expect(combo(page, 'Tax code')).toHaveAttribute(
      'data-selected-label',
      'GST-AB',
    );
    // Each charge's tax code follows the order's, with its rate frozen.
    await expect(combo(page, 'Freight tax code')).toHaveAttribute(
      'data-selected-label',
      'GST-AB',
    );
    await expect(
      page.getByLabel('Freight tax rate %', { exact: true }),
    ).toHaveText('5');
    await page.getByLabel('Order date (UTC) *').fill('2026-09-28T12:00');
    // Choosing the product prices the line in the order's currency, takes the
    // order's tax code and freezes its rate.
    await pick(page, 'Line 1 product', 'OFF-100', 'Field notebook');
    await expect(
      page.getByLabel('Line 1 unit price', { exact: true }),
    ).toHaveValue('12.5');
    await expect(
      page.getByLabel('Line 1 list price', { exact: true }),
    ).toHaveText('12.5');
    await expect(combo(page, 'Line 1 tax code')).toHaveAttribute(
      'data-selected-label',
      'GST-AB',
    );
    await expect(
      page.getByLabel('Line 1 tax rate %', { exact: true }),
    ).toHaveText('5');
    await page.getByLabel('Line 1 quantity', { exact: true }).fill('3');
    await page.getByLabel('Line 1 discount %', { exact: true }).fill('10');
    await page.getByLabel('Freight', { exact: true }).fill('25');
    await capture(page, testInfo, 'pricing-editor');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page).toHaveURL(/sales_order_detail/u);
    const orderUrl = page.url();
    // 3 × 12.50 less 10% = 33.75; 5% = 1.6875 → 1.69; freight 25 + 1.25.
    await expectPriced(page, {
      amount: '33.75',
      tax: '1.69',
      basis: 'List price',
      subtotal: '33.75',
      charges: '25.00',
      taxTotal: '2.94',
      total: '61.69',
    });
    await capture(page, testInfo, 'pricing-workspace');

    // A currency change re-prices a line still at its list price.
    await page.locator('.composition-record-actions > summary').click();
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Currency *').selectOption('USD');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page).toHaveURL(/sales_order_detail/u);
    // 3 × 9.25 less 10% = 24.975 → 24.98; 5% = 1.249 → 1.25.
    await expectPriced(page, {
      amount: '24.98',
      tax: '1.25',
      basis: 'List price',
      subtotal: '24.98',
      charges: '25.00',
      taxTotal: '2.50',
      total: '52.48',
    });

    // A price set by hand stays, and reads as a manual override.
    await page.locator('.composition-record-actions > summary').click();
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Line 1 unit price', { exact: true }).fill('10');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page).toHaveURL(/sales_order_detail/u);
    await expectPriced(page, {
      amount: '27.00',
      tax: '1.35',
      basis: 'Manual price',
      subtotal: '27.00',
      charges: '25.00',
      taxTotal: '2.60',
      total: '54.60',
    });

    // The printed order carries the priced lines and the totals.
    await page.goto(orderUrl);
    await page.getByRole('link', { name: 'Print sales order' }).click();
    const totals = page.locator('.print-totals');
    for (const [label, value] of [
      ['Subtotal', '27.00'],
      ['Freight', '25'],
      ['Tax', '2.60'],
      ['Total', '54.60'],
    ] as const)
      await expect(
        totals
          .locator('div')
          .filter({ has: page.locator('dt', { hasText: label }) })
          .locator('dd'),
      ).toHaveText(value);
    await expect(page.locator('.print-document')).toContainText('Manual price');
  });
});

async function expectPriced(
  page: Page,
  expected: {
    amount: string;
    tax: string;
    basis: string;
    subtotal: string;
    charges: string;
    taxTotal: string;
    total: string;
  },
) {
  const line = page
    .locator(`[data-composition-dataset$="dataset.order_lines"] tbody tr`)
    .first();
  await expect(line.locator('td[data-column-label="Amount"]')).toHaveText(
    expected.amount,
  );
  await expect(line.locator('td[data-column-label="Tax"]')).toHaveText(
    expected.tax,
  );
  await expect(line).toContainText(expected.basis);
  const fact = (label: string) =>
    page
      .locator('.composition-header-facts div')
      .filter({ has: page.locator('dt', { hasText: label }) })
      .locator('dd');
  await expect(fact('Total')).toHaveText(expected.total);
  const detail = (label: string) =>
    page
      .locator('[data-composition-fields] div')
      .filter({
        has: page.locator('dt', { hasText: new RegExp(`^${label}$`, 'u') }),
      })
      .locator('dd');
  await expect(detail('Subtotal')).toHaveText(expected.subtotal);
  await expect(detail('Charges')).toHaveText(expected.charges);
  await expect(detail('Tax')).toHaveText(expected.taxTotal);
}

function combo(page: Page, name: string) {
  return page.getByRole('combobox', { name, exact: true });
}
function field(page: Page, name: string) {
  return page
    .locator('[data-reference-field]')
    .filter({ has: combo(page, name) });
}
async function pick(page: Page, name: string, term: string, option: string) {
  await combo(page, name).fill(term);
  const enhanced =
    (await page.locator('body[data-reference-enhanced]').count()) > 0;
  if (!enhanced)
    await field(page, name)
      .getByRole('button', { name: 'Search', exact: true })
      .click();
  await field(page, name)
    .getByRole('option')
    .filter({ has: page.locator('strong') })
    .filter({ hasText: option })
    .first()
    .click();
  await expect(combo(page, name)).toHaveAttribute(
    'data-selected-label',
    option,
  );
}
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
    [
      '--import',
      'tsx',
      'test/helpers/order-entry-fixture.ts',
      '--serve',
      '--distributor',
    ],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  const exited = once(child, 'exit');
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /ORDER_ENTRY_URL=(.*)/.exec(output);
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
    child.stdin.end();
    child.kill('SIGTERM');
    const [code] = await exited;
    expect(code, output).toBe(0);
  }
}
