import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test.use({ screenshot: 'only-on-failure', trace: 'retain-on-failure' });

test('metadata workspace reserves, partially ships, releases and opens complete packing', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30000);
  await withBrowserFixture(async (url) => {
    const orderId = new URL(url).searchParams.get('record');
    await page.goto(url);
    await expect(
      page.getByText('Alpine Office Supply', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Field notebook', { exact: true }),
    ).toBeVisible();
    const lines = () =>
      page.locator('[data-composition-dataset$="dataset.fulfillment_lines"]');
    const reservations = () =>
      page.locator('[data-composition-dataset$="dataset.line_reservations"]');
    const shipments = () =>
      page.locator('[data-composition-dataset$="dataset.order_shipments"]');
    await lines().getByRole('link', { name: 'Select', exact: true }).focus();
    await page.keyboard.press('Enter');
    const task = () => page.locator('[data-composition-task]');
    await page
      .getByRole('button', { name: 'Reserve stock', exact: true })
      .click();
    await page.getByLabel('Quantity', { exact: true }).fill('-2');
    await page
      .getByLabel('Stock location')
      .selectOption({ label: 'Calgary warehouse' });
    await page
      .getByRole('button', { name: 'Review Reserve stock', exact: true })
      .click();
    await expect(task()).toContainText('Check the task inputs');
    await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue(
      '-2',
    );
    await expect(page.getByLabel('Stock location')).toHaveValue(
      '71000000-0000-4000-8000-000000000021',
    );
    await page.getByLabel('Quantity', { exact: true }).fill('8');
    await page
      .getByRole('button', { name: 'Review Reserve stock', exact: true })
      .focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('button', { name: 'Confirm Reserve stock', exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(task()).toContainText('Calgary warehouse');
    await page
      .getByRole('button', { name: 'Confirm Reserve stock', exact: true })
      .click();
    await expect(task()).toContainText('complete');
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    const totals = async (expected: string[]) => {
      for (const [index, label] of [
        'On hand',
        'Reserved stock',
        'Available',
      ].entries())
        await expect(
          reservations().locator(`td[data-column-label="${label}"]`),
        ).toHaveText(expected[index]!);
    };
    await totals(['10', '8', '2']);
    await reservations()
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Ship reserved stock', exact: true })
      .click();
    await page.getByLabel('Quantity', { exact: true }).fill('5');
    await page
      .getByRole('button', { name: 'Review Ship reserved stock', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm Ship reserved stock', exact: true })
      .click();
    await expect(task()).toContainText('complete');
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    await totals(['5', '3', '2']);
    await expect(lines().locator('td[data-column-label="Shipped"]')).toHaveText(
      '5',
    );
    await page
      .getByRole('button', { name: 'Release remainder', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Review Release remainder', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm Release remainder', exact: true })
      .click();
    await expect(task()).toContainText('complete');
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    await totals(['5', '0', '5']);
    await page.screenshot({
      path: testInfo.outputPath('fulfillment-desktop.png'),
      fullPage: true,
    });
    await expect(
      page.getByRole('button', { name: 'Release remainder', exact: true }),
    ).toHaveCount(0);
    // A previous reservation selection must not override an explicit line selection.
    await lines().getByRole('link', { name: 'Select', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Reserve stock', exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await shipments()
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    await page.screenshot({
      path: testInfo.outputPath('fulfillment-mobile.png'),
      fullPage: true,
    });
    await page.getByRole('link', { name: 'Open packing', exact: true }).click();
    const packed = page.locator(
      '[data-composition-dataset$="dataset.packing_lines"]',
    );
    await expect(packed).toHaveAttribute('data-resolution', 'ready');
    await expect(packed.locator('tbody tr')).toHaveCount(1);
    await expect(packed).toContainText('Field notebook');
    await page.screenshot({
      path: testInfo.outputPath('packing-mobile.png'),
      fullPage: true,
    });
    await expect(packed.locator('td[data-column-label="Quantity"]')).toHaveText(
      '5',
    );
    await expect(
      page.getByText('Calgary warehouse', { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    expect(new URL(page.url()).searchParams.get('record')).toBe(orderId);
  });
});

async function withBrowserFixture(
  run: (url: string) => Promise<void>,
): Promise<void> {
  const cwd = fileURLToPath(new URL('../../../../', import.meta.url));
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'test/helpers/meta-sales-fixture.ts',
      '--serve',
      '--verify',
    ],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let readyResolve: (url: string) => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const exited = once(child, 'exit');
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    const match = /META_SALES_URL=(.*)/.exec(output);
    if (match) readyResolve(match[1]!);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.once('error', (error) => readyReject(error));
  child.once('exit', () => readyReject(new Error(output)));
  try {
    await run(await ready);
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
  expect(output).toContain('META_SALES_VERIFIED');
}
