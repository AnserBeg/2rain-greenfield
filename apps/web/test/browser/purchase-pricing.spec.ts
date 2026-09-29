import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// PURCHASING-PARITY slice 1: ruling B extended to purchase orders, through the
// declared editor and the commercial read model. The fixture's Alpine Office
// Supply is also a supplier; it defaults to CAD, Net 30 and GST-AB (5%).
test('a purchase order takes its supplier defaults, is discounted and taxed per line, with charges, and totals read half up', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url) => {
    await page.goto(url);
    await page.getByRole('link', { name: 'Purchasing', exact: true }).click();
    await page.getByRole('link', { name: 'New', exact: true }).click();
    // A new order expects delivery two weeks out, at midnight UTC; the
    // browser shows a whole minute without its seconds.
    const today = new Date();
    const expected = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + 14,
      ),
    )
      .toISOString()
      .slice(0, 16);
    await expect(page.getByLabel('Expected date (UTC)')).toHaveValue(expected);
    await page.getByLabel('Order date (UTC) *').fill('2026-09-28T12:00');
    // Choosing the supplier sets its currency, terms and tax code; each
    // charge's tax code follows the order's, with its rate frozen.
    await pick(page, 'Vendor', 'Alpine', 'Alpine Office Supply');
    await expect(page.getByLabel('Currency *')).toHaveValue('CAD');
    await expect(page.getByLabel('Payment terms')).toHaveValue(
      'northstar.app:option.purchase_order_payment_terms_net_30',
    );
    await expect(combo(page, 'Tax code')).toHaveAttribute(
      'data-selected-label',
      'GST-AB',
    );
    await expect(combo(page, 'Freight tax code')).toHaveAttribute(
      'data-selected-label',
      'GST-AB',
    );
    await expect(
      page.getByLabel('Freight tax rate %', { exact: true }),
    ).toHaveText('5');
    // A line's tax code starts from the order's, with its rate frozen.
    await pick(page, 'Line 1 product', 'OFF-100', 'Field notebook');
    await expect(combo(page, 'Line 1 tax code')).toHaveAttribute(
      'data-selected-label',
      'GST-AB',
    );
    await expect(
      page.getByLabel('Line 1 tax rate %', { exact: true }),
    ).toHaveText('5');
    await page.getByLabel('Line 1 quantity', { exact: true }).fill('3');
    await page.getByLabel('Line 1 unit cost', { exact: true }).fill('12.5');
    await page.getByLabel('Line 1 discount %', { exact: true }).fill('10');
    await page.getByLabel('Freight', { exact: true }).fill('25');
    await capture(page, testInfo, 'purchase-pricing-editor');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page).toHaveURL(/purchase_order_detail/u);
    const orderUrl = page.url();
    // 3 × 12.50 less 10% = 33.75; 5% = 1.6875 → 1.69; freight 25 + 1.25.
    const line = page
      .locator(
        '[data-composition-dataset$="dataset.purchasing_priced_lines"] tbody tr',
      )
      .first();
    await expect(line.locator('td[data-column-label="Amount"]')).toHaveText(
      '33.75',
    );
    await expect(line.locator('td[data-column-label="Tax"]')).toHaveText(
      '1.69',
    );
    // A secondary column reads inside the line's product cell.
    await expect(line).toContainText('Unit cost 12.50');
    const fact = (label: string) =>
      page
        .locator('.composition-header-facts div')
        .filter({ has: page.locator('dt', { hasText: label }) })
        .locator('dd');
    await expect(fact('Total')).toHaveText('61.69');
    await expect(fact('Payment terms')).toHaveText('Net 30');
    const detail = (label: string) =>
      page
        .locator('[data-composition-fields] div')
        .filter({
          has: page.locator('dt', { hasText: new RegExp(`^${label}$`, 'u') }),
        })
        .locator('dd');
    await expect(detail('Subtotal')).toHaveText('33.75');
    await expect(detail('Charges')).toHaveText('25.00');
    await expect(detail('Tax')).toHaveText('2.94');
    await capture(page, testInfo, 'purchase-pricing-workspace');

    // The printed order carries the priced lines and the totals.
    await page.goto(orderUrl);
    await page.getByRole('link', { name: 'Print purchase order' }).click();
    const totals = page.locator('.print-totals');
    for (const [label, value] of [
      ['Subtotal', '33.75'],
      ['Freight', '25.00'],
      ['Tax', '2.94'],
      ['Total', '61.69'],
    ] as const)
      await expect(
        totals
          .locator('div')
          .filter({
            has: page.locator('dt', { hasText: new RegExp(`^${label}$`, 'u') }),
          })
          .locator('dd'),
      ).toHaveText(value);
    await capture(page, testInfo, 'purchase-pricing-print');
  });
});

// PURCHASING-PARITY slice 2: each order line states what has arrived and what
// is still open; a line's open remainder is closed with a reason; an order with
// receipts is never cancelled, and one with none still is.
test('a partly received order shows what is still open, closes its remainder with a reason, and is never cancelled', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url) => {
    const newOrder = async () => {
      await page.goto(url);
      await page.getByRole('link', { name: 'Purchasing', exact: true }).click();
      await page.getByRole('link', { name: 'New', exact: true }).click();
      await page.getByLabel('Order date (UTC) *').fill('2026-09-28T12:00');
      await pick(page, 'Vendor', 'Alpine', 'Alpine Office Supply');
      await pick(page, 'Line 1 product', 'OFF-100', 'Field notebook');
      await page.getByLabel('Line 1 quantity', { exact: true }).fill('5');
      await page
        .getByRole('button', { name: 'Save draft', exact: true })
        .click();
      await expect(page).toHaveURL(/purchase_order_detail/u);
      await command(page, 'Release', false);
      await expect(page.getByRole('status')).toContainText('Release complete');
      return page.url();
    };
    const row = () =>
      page
        .locator(
          '[data-composition-dataset$="dataset.purchasing_lines"] tbody tr',
        )
        .filter({ hasText: 'Field notebook' });
    const cell = (label: string) =>
      row().locator(`td[data-column-label="${label}"]`);
    const task = () => page.locator('[data-composition-task]');
    const runTask = async (
      label: string,
      fill: () => Promise<void>,
    ): Promise<void> => {
      await row().getByRole('link', { name: 'Select', exact: true }).click();
      await page.getByRole('button', { name: label, exact: true }).click();
      await fill();
      await page
        .getByRole('button', { name: `Review ${label}`, exact: true })
        .click();
      await page
        .getByRole('button', { name: `Confirm ${label}`, exact: true })
        .click();
      await expect(task().locator('[data-task-result]')).toContainText(
        `${label}: done`,
      );
      await page
        .getByRole('link', { name: 'Back to order', exact: true })
        .click();
    };

    const orderUrl = await newOrder();
    await expect(cell('Ordered')).toHaveText(/^5(?:\.0+)?$/u);
    await expect(cell('Received')).toHaveText('0');
    await expect(cell('Open')).toHaveText('5');
    // Two of five arrive.
    await runTask('Receive with cost explicitly absent', async () => {
      await page.getByLabel('Quantity to receive', { exact: true }).fill('2');
      await page
        .getByRole('combobox', { name: 'Receiving location', exact: true })
        .selectOption({ label: 'Calgary warehouse' });
    });
    await expect(cell('Received')).toHaveText('2');
    await expect(cell('Open')).toHaveText('3');
    await capture(page, testInfo, 'purchase-partly-received');

    // Received goods are never cancelled away; the order stays released.
    await command(page, 'Cancel');
    await expect(page.locator('[data-diagnostic-code]')).toContainText(
      'RECEIPT_QUANTITY_OUT_OF_BOUNDS',
    );
    await page.goto(orderUrl);
    await expect(page.locator('.composition-business-status')).toHaveText(
      'Released',
    );
    // The three still open are closed with a reason; ordered becomes received.
    await runTask('Close open remainder', async () => {
      await page
        .getByLabel('Reason', { exact: true })
        .fill('Supplier discontinued the rest');
    });
    await expect(cell('Ordered')).toHaveText(/^2(?:\.0+)?$/u);
    await expect(cell('Open')).toHaveText('0');
    await row().getByRole('link', { name: 'Select', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Close open remainder', exact: true }),
    ).toHaveCount(0);
    await capture(page, testInfo, 'purchase-remainder-closed');
    // Nothing is open, so the order closes.
    await page.goto(orderUrl);
    await command(page, 'Close');
    await expect(page.getByRole('status')).toContainText('Close complete');
    await expect(page.locator('.composition-business-status')).toHaveText(
      'Closed',
    );

    // An order with nothing received still cancels.
    await newOrder();
    await command(page, 'Cancel');
    await expect(page.getByRole('status')).toContainText('Cancel complete');
    await expect(page.locator('.composition-business-status')).toHaveText(
      'Cancelled',
    );
  });
});

/** A record command; those that end or reverse an order ask to be confirmed. */
async function command(page: Page, label: string, confirmed = true) {
  const secondary = page.locator(
    '.composition-record-actions:not([open]) > summary',
  );
  if (await secondary.count()) await secondary.click();
  await page.getByRole('button', { name: label, exact: true }).click();
  if (confirmed)
    await page
      .getByRole('button', { name: `Confirm ${label}`, exact: true })
      .click();
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
