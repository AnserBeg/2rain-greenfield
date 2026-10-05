import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

interface Seeded {
  readonly sale: string;
  readonly purchase: string;
}

// RETURNS through the declared workspaces: the order-entry fixture seeds a
// confirmed sales order whose one line shipped all 3 EA of Field notebook,
// and a released purchase order whose one line received all 4.
test('goods come back from a customer into a chosen location and are reversed, and received goods go back to the supplier', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    const seeded = await seed();
    const navigation = page.getByRole('navigation', {
      name: 'Release navigation',
    });
    const dataset = (name: string) =>
      page.locator(`[data-composition-dataset$="dataset.${name}"]`);
    const runTask = async (
      row: () => ReturnType<Page['locator']>,
      label: string,
      fill: () => Promise<void>,
    ) => {
      await row().getByRole('link', { name: 'Select', exact: true }).click();
      await page.getByRole('button', { name: label, exact: true }).click();
      await fill();
      await page
        .getByRole('button', { name: `Review ${label}`, exact: true })
        .click();
      await page
        .getByRole('button', { name: `Confirm ${label}`, exact: true })
        .click();
      await expect(
        page.locator('[data-composition-task] [data-task-result]'),
      ).toContainText(`${label}: done`);
      await page
        .getByRole('link', { name: 'Back to order', exact: true })
        .click();
    };

    // The confirmed order: its line shipped three and has none back.
    await page.goto(url);
    await navigation.getByText('Sales', { exact: true }).click();
    await navigation
      .getByRole('link', { name: 'Sales orders', exact: true })
      .click();
    await page
      .getByRole('link', {
        name: `Open Sales orders ${seeded.sale}`,
        exact: true,
      })
      .click();
    await expect(page.locator('.composition-header h1')).toHaveText(
      seeded.sale,
    );
    const orderUrl = page.url();
    const line = () =>
      dataset('fulfillment_lines')
        .locator('tbody tr')
        .filter({ hasText: 'Field notebook' });
    const cell = (label: string) =>
      line().locator(`td[data-column-label="${label}"]`);
    await expect(cell('Shipped')).toHaveText('3');
    await expect(cell('Returned')).toHaveText('0');

    // One unit comes back damaged into the warehouse the operator chooses;
    // shipped stays three (ruling D).
    await runTask(line, 'Receive return', async () => {
      await page.getByLabel('Quantity returned', { exact: true }).fill('1');
      await page
        .getByRole('combobox', { name: 'Return into location', exact: true })
        .selectOption({ label: 'Calgary warehouse' });
      await page
        .getByLabel('What came back', { exact: true })
        .fill('One notebook, cover torn');
    });
    await expect(cell('Shipped')).toHaveText('3');
    await expect(cell('Returned')).toHaveText('1');
    const returns = () => dataset('order_returns').locator('tbody tr');
    await expect(returns()).toHaveCount(1);
    await expect(returns().first()).toContainText(/RMA-\d{6}/u);
    await expect(
      returns().first().locator('td[data-column-label="State"]'),
    ).toHaveText('Posted');
    await capture(page, testInfo, 'order-return-received');

    // The return was a mistake: it is reversed whole, from where it went.
    await runTask(
      () => returns().first(),
      'Reverse return',
      async () => {
        await page
          .getByLabel('Reason', { exact: true })
          .fill('Recorded against the wrong order');
      },
    );
    await expect(cell('Returned')).toHaveText('0');
    await expect(returns()).toHaveCount(2);
    await expect(
      returns().filter({
        has: page.locator('td[data-column-label="Kind"]', {
          hasText: 'Reversal',
        }),
      }),
    ).toHaveCount(1);
    await capture(page, testInfo, 'order-return-reversed');

    // Sales lists its returns beside its orders.
    await page.goto(orderUrl);
    await navigation.getByText('Sales', { exact: true }).click();
    await navigation
      .getByRole('link', { name: 'Returns', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Returns', level: 1 }),
    ).toBeVisible();
    // The return and its reversal, both posted; nothing left in draft.
    const views = page.getByRole('navigation', { name: 'Views' });
    await expect(views.getByRole('link', { name: 'All 2' })).toBeVisible();
    await expect(views.getByRole('link', { name: 'Posted 2' })).toBeVisible();
    await expect(views.getByRole('link', { name: 'Draft 0' })).toBeVisible();
    await expect(page.locator('main')).toContainText(/RMA-\d{6}/u);
    await capture(page, testInfo, 'returns-list');

    // The purchase order: all four received, nothing open.
    await page.goto(url);
    await navigation.getByText('Purchasing', { exact: true }).click();
    await navigation
      .getByRole('link', { name: 'Purchase orders', exact: true })
      .click();
    await page
      .getByRole('link', {
        name: `Open Purchase orders ${seeded.purchase}`,
        exact: true,
      })
      .click();
    await expect(page.locator('.composition-header h1')).toHaveText(
      seeded.purchase,
    );
    const purchaseLine = () =>
      dataset('purchasing_lines')
        .locator('tbody tr')
        .filter({ hasText: 'Field notebook' });
    const purchaseCell = (label: string) =>
      purchaseLine().locator(`td[data-column-label="${label}"]`);
    await expect(purchaseCell('Received')).toHaveText('4');
    await expect(purchaseCell('Open')).toHaveText('0');

    // One defective unit goes back to the supplier: received falls to three
    // and the line reopens to receive the replacement (ruling R-A).
    await runTask(purchaseLine, 'Return to vendor', async () => {
      await page.getByLabel('Quantity to return', { exact: true }).fill('1');
      await page
        .getByRole('combobox', { name: 'Return from location', exact: true })
        .selectOption({ label: 'Calgary warehouse' });
      await page
        .getByLabel('What goes back', { exact: true })
        .fill('Spine split on arrival');
    });
    await expect(purchaseCell('Received')).toHaveText('3');
    await expect(purchaseCell('Open')).toHaveText('1');
    const vendorReturns = dataset('purchasing_vendor_returns').locator(
      'tbody tr',
    );
    await expect(vendorReturns).toHaveCount(1);
    await expect(vendorReturns.first()).toContainText(/VRT-\d{6}/u);
    await capture(page, testInfo, 'purchase-returned-to-vendor');
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

/**
 * The order-entry fixture, served with `--verify` so the documents are seeded
 * through their own governed operations once the application is up.
 */
async function fixture(
  run: (url: string, seed: () => Promise<Seeded>) => Promise<void>,
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
  let pending = '';
  let seeded: ((value: Seeded) => void) | null = null;
  const exited = once(child, 'exit');
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /ORDER_ENTRY_URL=(.*)/.exec(output);
      if (match) resolve(match[1]!);
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines)
        if (line.startsWith('ORDER_ENTRY_MEASURED=')) {
          seeded?.(
            JSON.parse(line.slice('ORDER_ENTRY_MEASURED='.length)) as Seeded,
          );
          seeded = null;
        }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('exit', () => reject(new Error(output)));
  });
  const seed = () =>
    new Promise<Seeded>((resolve, reject) => {
      seeded = resolve;
      child.once('exit', () => reject(new Error(output)));
      child.stdin.write(`${JSON.stringify({ phase: 'returns' })}\n`);
    });
  try {
    await run(await ready, seed);
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    const [code] = await exited;
    expect(code, output).toBe(0);
  }
}
