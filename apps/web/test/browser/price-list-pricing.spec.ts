import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';

interface Seeded {
  readonly code: string;
  readonly recordId: string;
}

// SALES-EXTRAS price lists through the declared Catalog page and the order
// editor. The fixture seeds WHOLESALE (CAD, priority 10) for Alpine Office
// Supply -- Field notebook from 1 at 11.00 and from 10 at 9.50 -- and a
// lower-priority RETAIL list (12.00) it never reaches; the notebook lists at
// 12.50 CAD.
test('a sales line is priced from its customer’s price list, by quantity break, and a typed price stays manual', async ({
  page,
}, testInfo) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    const list = await seed();
    const dialog = page.getByRole('dialog');
    const dataset = (name: string) =>
      page.locator(`[data-composition-dataset$="dataset.${name}"]`);
    const finish = async (label: string) => {
      await dialog.getByRole('button', { name: `Review ${label}` }).click();
      await dialog.getByRole('button', { name: `Confirm ${label}` }).click();
      await expect(page.getByRole('status').first()).toContainText(
        `${label}: done`,
      );
    };

    // The price list page: its prices and its customers; a third break.
    const listPage = new URL(url);
    listPage.search = '';
    listPage.searchParams.set('surface', `${ns}:surface.price_list_detail`);
    listPage.searchParams.set('record', list.recordId);
    await page.goto(listPage.toString());
    await expect(page.locator('.composition-header h1')).toHaveText(list.code);
    await expect(dataset('price_list_prices').locator('tbody tr')).toHaveCount(
      2,
    );
    await expect(dataset('price_list_customers')).toContainText(
      'Alpine Office Supply',
    );
    await page.getByRole('button', { name: 'Add price', exact: true }).click();
    await dialog.getByLabel('Item').selectOption({ label: 'Field notebook' });
    await dialog.getByLabel('From quantity').fill('50');
    await dialog.getByLabel('Unit price').fill('8.75');
    await finish('Add price');
    await page.goto(listPage.toString());
    await expect(dataset('price_list_prices').locator('tbody tr')).toHaveCount(
      3,
    );
    await capture(page, testInfo, 'price-list');

    // A new order for the customer: the 1+ break of its highest-priority list.
    await page.goto(url);
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await pick(page, 'Customer', 'Alpine', 'Alpine Office Supply');
    await page.getByLabel('Order date (UTC) *').fill('2026-10-05T12:00');
    await pick(page, 'Line 1 product', 'OFF-100', 'Field notebook');
    const unitPrice = page.getByLabel('Line 1 unit price', { exact: true });
    const listPrice = page.getByLabel('Line 1 list price', { exact: true });
    const priceList = page.getByLabel('Line 1 price list', { exact: true });
    await expect(unitPrice).toHaveValue('11');
    await expect(listPrice).toHaveText('11');
    await expect(priceList).toHaveText(list.code);
    // 12 crosses the 10 break: the price follows while it is not typed.
    await page.getByLabel('Line 1 quantity', { exact: true }).fill('12');
    await page.getByLabel('Line 1 quantity', { exact: true }).press('Enter');
    await expect(unitPrice).toHaveValue('9.5');
    await expect(listPrice).toHaveText('9.5');
    await capture(page, testInfo, 'price-list-editor');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page).toHaveURL(/sales_order_detail/u);
    const line = dataset('order_lines').locator('tbody tr').first();
    await expect(line.locator('td[data-column-label="Amount"]')).toHaveText(
      '114.00',
    );
    await expect(line).toContainText('Price list');
    await expect(line).toContainText(list.code);

    // A typed price stays when the quantity crosses the next break, and
    // reads as manual; the list price shows the break it would take.
    await page.locator('.composition-record-actions > summary').click();
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Line 1 unit price', { exact: true }).fill('9');
    await page.getByLabel('Line 1 quantity', { exact: true }).fill('60');
    await page.getByLabel('Line 1 quantity', { exact: true }).press('Enter');
    await expect(unitPrice).toHaveValue('9');
    await expect(listPrice).toHaveText('8.75');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page).toHaveURL(/sales_order_detail/u);
    await expect(line.locator('td[data-column-label="Amount"]')).toHaveText(
      '540.00',
    );
    await expect(line).toContainText('Manual price');
  });
});

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

/**
 * The order-entry fixture, served with `--verify` so the price lists are
 * seeded through their own governed operations once the application is up.
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
      child.stdin.write(`${JSON.stringify({ phase: 'price_lists' })}\n`);
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
