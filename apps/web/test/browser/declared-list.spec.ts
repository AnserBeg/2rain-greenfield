import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';
const ORDERS = 60;

// The fixture's own creation rule for its prerequisite orders, so the expected
// counts are independent of anything the page computes.
const expected = (() => {
  let released = 0;
  let cancelled = 0;
  let usd = 0;
  for (let index = 1; index <= ORDERS; index++) {
    if (index % 3 === 0) released++;
    else if (index % 7 === 0) cancelled++;
    if (index % 5 !== 0 && index % 4 === 0) usd++;
  }
  return { released, cancelled, draft: ORDERS - released - cancelled, usd };
})();

test('a declared Sales List navigates views, search, sort, filters, pages and export by keyboard and at phone width', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url) => {
    await page.goto(url);
    await expect(
      page.getByRole('heading', { name: 'Sales orders', level: 1 }),
    ).toBeVisible();
    const views = page.getByRole('navigation', { name: 'Views' });
    await expect(
      views.getByRole('link', { name: `All ${ORDERS}` }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(
      views.getByRole('link', { name: `Draft ${expected.draft}` }),
    ).toBeVisible();
    await expect(
      views.getByRole('link', { name: `Released ${expected.released}` }),
    ).toBeVisible();
    await expect(
      views.getByRole('link', { name: `Cancelled ${expected.cancelled}` }),
    ).toBeVisible();
    await expect(page.getByText(`${ORDERS} matching records`)).toBeVisible();
    await expect(page.getByText('Page 1 of 2')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('list-all-desktop.png'),
    });

    // A view by keyboard: focus the tab and press Enter.
    await views.getByRole('link', { name: `Draft ${expected.draft}` }).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText(`${expected.draft} matching records`),
    ).toBeVisible();
    const statuses = await page
      .locator(`td[data-column-id="${ns}:list_column.sales_order_list_status"]`)
      .allInnerTexts();
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses.map((value) => value.trim()))).toEqual(
      new Set(['Draft']),
    );

    // Sort by customer name from its header; the order is the label's order.
    await page.getByRole('link', { name: /^Customer/ }).click();
    await expect(page.locator('th[aria-sort="ascending"]')).toContainText(
      'Customer',
    );
    const customers = (
      await page
        .locator(
          `td[data-column-id="${ns}:list_column.sales_order_list_counterparty"]`,
        )
        .allInnerTexts()
    ).map((value) => value.trim());
    expect(customers).toEqual([...customers].sort());
    expect(customers.every((value) => !/^[0-9a-f-]{36}$/u.test(value))).toBe(
      true,
    );

    // Search by a customer's name keeps the view and the sort.
    const term = customers[0]!.split(' ')[0]!;
    await page.getByLabel('Search sales orders').fill(term);
    await page.getByLabel('Search sales orders').press('Enter');
    await expect(views.getByRole('link', { name: /^Draft/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const matched = (
      await page
        .locator(
          `td[data-column-id="${ns}:list_column.sales_order_list_counterparty"]`,
        )
        .allInnerTexts()
    ).map((value) => value.trim());
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.every((value) => value.includes(term))).toBe(true);
    await page.getByRole('link', { name: 'Clear', exact: true }).click();

    // A declared filter and the All view.
    await views.getByRole('link', { name: /^All/ }).click();
    await page.getByLabel('Currency', { exact: true }).selectOption('USD');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(
      page.getByText(`${expected.usd} matching records`),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Clear', exact: true }).click();

    // Pages: Next, then a page past the end lands on the last page.
    await page.getByRole('link', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await expect(
      page.locator('tbody tr[data-compact-card="true"]'),
    ).toHaveCount(ORDERS - 50);
    await page.getByLabel('Go to page').fill('7');
    await page.getByLabel('Go to page').press('Enter');
    await expect(page.getByText('Page 2 of 2')).toBeVisible();

    // Export the Draft view: the file holds every record of the view.
    await views.getByRole('link', { name: /^Draft/ }).click();
    const download = page.waitForEvent('download');
    await page
      .getByRole('link', { name: `Export CSV (${expected.draft})` })
      .click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(
      /^sales-orders-\d{4}-\d{2}-\d{2}\.csv$/u,
    );
    const csv = (await readFile((await file.path())!, 'utf8'))
      .replace(/^\uFEFF/u, '')
      .trimEnd()
      .split('\r\n');
    // Ruling E adds the salesperson, named like the customer; ORDER-PARITY
    // the units each order's lines order, ship and leave open.
    expect(csv[0]).toBe(
      'Number,Customer,Salesperson,Order date,Requested,Status,Ordered,Shipped,Open,Short,On order,Currency',
    );
    expect(csv.length - 1).toBe(expected.draft);

    // Phone: one screen width, tabs scroll inside their strip, cards.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(views.getByRole('link', { name: /^Draft/ })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('list-draft-phone.png'),
    });
  });
});

test('a declared List works without JavaScript', async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await fixture(async (url) => {
    await page.goto(url);
    await page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('link', { name: /^Released/ })
      .click();
    await expect(
      page.getByText(`${expected.released} matching records`),
    ).toBeVisible();
    await page
      .getByLabel('Sort by', { exact: true })
      .selectOption({ label: 'Customer' });
    await page.getByLabel('Order', { exact: true }).selectOption('desc');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('th[aria-sort="descending"]')).toContainText(
      'Customer',
    );
  });
  await context.close();
});

async function fixture(run: (url: string) => Promise<void>) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'test/helpers/order-entry-fixture.ts',
      '--serve',
      '--distributor',
      `--order-volume=${ORDERS}`,
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
