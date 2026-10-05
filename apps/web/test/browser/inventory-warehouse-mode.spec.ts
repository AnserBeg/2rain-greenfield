import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';
const SCAN_LABEL = 'Scan or type a SKU or document number';

interface ItemStockScenario {
  readonly numbers: {
    readonly adjustment: string;
    readonly purchase: string;
    readonly receipt: string;
    readonly order: string;
    readonly shipment: string;
  };
}
interface ExpectedReceiptsScenario {
  readonly late: { readonly number: string };
  readonly future: { readonly number: string };
}

// WAREHOUSE-MODE: the floor staff's Warehouse. The fixture first moves stock
// and documents through the governed operations -- a received purchase
// order, a released sales order with 3 still to ship, a stock adjustment --
// then two more released purchase orders with something still to arrive.
test('the Warehouse opens the floor work with its counts, and a scanned SKU or document number opens its record', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    const stock = await seed<ItemStockScenario>('item_stock');
    const expected = await seed<ExpectedReceiptsScenario>('expected_receipts');
    await page.goto(url);

    // Inventory -> Warehouse: three large tiles, each with its List view's
    // count, and the scan box, which has the keyboard on arrival.
    await openWarehouse(page);
    expect(await tiles(page)).toEqual([
      ['Receive', '2', 'To receive'],
      ['Put away', '0', 'Transfers'],
      ['Pick and ship', '1', 'To ship'],
    ]);
    await expect(page.getByLabel(SCAN_LABEL, { exact: true })).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath('warehouse.png'),
      fullPage: true,
    });

    // Each tile opens its List at its view, whose own tab counts the same.
    for (const [label, list, view, count] of [
      ['Receive', 'Expected receipts', 'To receive', '2'],
      ['Put away', 'Inventory transactions', 'Transfers', '0'],
      ['Pick and ship', 'Sales orders', 'To ship', '1'],
    ] as const) {
      await openWarehouse(page);
      await page.locator('a.launcher-tile', { hasText: label }).click();
      await expect(
        page.getByRole('heading', { level: 1, name: list }),
      ).toBeVisible();
      const current = page.locator('.list-views a[aria-current="page"]');
      await expect(current.locator('span').first()).toHaveText(view);
      await expect(current.locator('[data-view-count]')).toHaveText(count);
    }

    // A SKU opens the item at its stock; each number opens its document.
    await openWarehouse(page);
    await scan(page, 'OFF-100');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Field notebook' }),
    ).toBeVisible();
    await expect(
      page.locator(`[data-composition-dataset="${ns}:dataset.item_stock"]`),
    ).toBeVisible();
    for (const [code, page_] of [
      [expected.late.number, 'purchase_order_detail'],
      [stock.numbers.order, 'sales_order_detail'],
      [stock.numbers.receipt, 'goods_receipt_detail'],
      [stock.numbers.shipment, 'shipment_detail'],
      [stock.numbers.adjustment, 'inventory_transaction_detail'],
    ] as const) {
      await openWarehouse(page);
      // Typed in lower case, as a hand might: a number is matched exactly,
      // case aside.
      await scan(page, code.toLowerCase());
      await expect(page).toHaveURL(
        new RegExp(`surface=${encodeURIComponent(`${ns}:surface.${page_}`)}`),
      );
      await expect(
        page.getByRole('heading', { level: 1, name: code, exact: true }),
      ).toBeVisible();
    }

    // A code that names nothing, or only a name, opens nothing: the code
    // stays in the box beside the reason.
    await openWarehouse(page);
    await scan(page, 'NOPE-404');
    await expect(page.locator('[data-message="SCAN_NO_MATCH"]')).toBeVisible();
    await expect(page.getByLabel(SCAN_LABEL, { exact: true })).toHaveValue(
      'NOPE-404',
    );
    await scan(page, 'Field notebook');
    await expect(page.locator('[data-message="SCAN_NOT_EXACT"]')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('warehouse-scan-refused.png'),
      fullPage: true,
    });

    // Phone width: one tile a row, the page scrolls down, never sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const [first, second] = await page
      .locator('a.launcher-tile')
      .evaluateAll((links) =>
        links.slice(0, 2).map((link) => link.getBoundingClientRect().top),
      );
    expect(second!).toBeGreaterThan(first!);
    await page.screenshot({
      path: testInfo.outputPath('warehouse-phone.png'),
      fullPage: true,
    });
  });
});

// The period lock page: Close period through, then Reopen to, each reviewed
// and confirmed; a stock document dated now is refused while its period is
// closed and posts once it is reopened.
test('the period lock closes a period and reopens it, each reviewed and confirmed, and a closed period refuses a posting', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url) => {
    await page.goto(url);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);

    // Inventory -> Inventory period lock -> the company's lock: open, so
    // there is only something to close.
    await openPeriodLock(page);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Posting period' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Reopen to', exact: true }),
    ).toHaveCount(0);

    // Close through the end of today (UTC): reviewed, then confirmed.
    await command(
      page,
      'Close period through',
      'Close through',
      `${today}T23:59:59`,
    );
    await page.screenshot({
      path: testInfo.outputPath('period-lock-closed.png'),
      fullPage: true,
    });

    // A stock document dated now falls in the closed period: its Post is
    // refused inside the posting transaction and nothing moves.
    await openNewStockDocument(page);
    await page
      .getByLabel('Reason', { exact: true })
      .selectOption({ label: 'Found' });
    await page
      .getByLabel('Narrative', { exact: true })
      .fill('Found while the period was closed');
    await pick(page, 'Line 1 product', 'OFF-100', 'Field notebook');
    await pick(page, 'Line 1 to location', 'Calgary', 'Calgary warehouse');
    await page.getByLabel('Line 1 quantity', { exact: true }).fill('1');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page).toHaveURL(/inventory_transaction_detail/u);
    const documentUrl = page.url();
    await post(page);
    await expect(page.locator('[data-message-subject]').first()).toHaveText(
      'INVENTORY_PERIOD_CLOSED',
    );
    // The refusal is a page of its own; the document is opened again, still
    // a draft.
    await page.goto(documentUrl);
    await expect(page.getByText(/Active · revision 1/u)).toBeVisible();

    // Closing through an earlier time would reopen: refused by name.
    await openPeriodLock(page);
    await command(
      page,
      'Close period through',
      'Close through',
      `${yesterday}T00:00:00`,
      'MODULE_PERIOD_LOCK_DIRECTION_INVALID',
    );

    // Reopen to yesterday, confirmed: the same document now posts.
    await openPeriodLock(page);
    await command(page, 'Reopen to', 'Reopen to', `${yesterday}T00:00:00`);
    await page.goto(documentUrl);
    await post(page);
    await expect(page.getByRole('status')).toContainText('Post complete');
  });
});

/** Inventory -> Warehouse, from the menu. */
async function openWarehouse(page: Page) {
  await openInventory(page, 'Warehouse');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Warehouse' }),
  ).toBeVisible();
}

/** Inventory -> Inventory period lock -> the company's one lock. */
async function openPeriodLock(page: Page) {
  await openInventory(page, 'Inventory period lock');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Inventory period lock' }),
  ).toBeVisible();
  await page
    .locator('[data-platform-slot="list:dataGrid"] a.record-link')
    .first()
    .click();
  await expect(page).toHaveURL(/inventory_period_lock_detail/u);
}

/** Inventory -> Inventory transactions -> New. */
async function openNewStockDocument(page: Page) {
  await openInventory(page, 'Inventory transactions');
  await page.getByRole('link', { name: 'New', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'New Inventory transaction' }),
  ).toBeVisible();
}

async function openInventory(page: Page, destination: string) {
  const inventory = page
    .getByRole('navigation', { name: 'Release navigation' })
    .locator('.navigation-tree > li')
    .getByRole('group')
    .filter({ hasText: 'Inventory' });
  const link = inventory.getByRole('link', { name: destination, exact: true });
  // A group already open on this page stays open; clicking it would close it.
  if (!(await link.isVisible()))
    await inventory.getByText('Inventory', { exact: true }).click();
  await link.click();
}

/** The tiles as their label, count and view. */
async function tiles(page: Page) {
  return page
    .locator('a.launcher-tile')
    .evaluateAll((links) =>
      links.map((link) => [
        link.querySelector('.launcher-tile__label')?.textContent ?? '',
        link.querySelector('[data-launcher-count]')?.textContent ?? '',
        link.querySelector('.launcher-tile__view')?.textContent ?? '',
      ]),
    );
}

/** Types a code into the scan box and presses Enter, as a scanner does. */
async function scan(page: Page, code: string) {
  const box = page.getByLabel(SCAN_LABEL, { exact: true });
  await box.fill(code);
  await box.press('Enter');
}

/**
 * A record command entered, reviewed and confirmed; with `refusal`, the
 * confirmed command is refused by that code.
 */
async function command(
  page: Page,
  label: string,
  input: string,
  value: string,
  refusal?: string,
) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByLabel(`${input} (UTC)`, { exact: true }).fill(value);
  await page
    .getByRole('button', { name: `Review ${label}`, exact: true })
    .click();
  await expect(page.locator('.composition-reviewed-inputs')).toContainText(
    `${value}.000Z`,
  );
  await page
    .getByRole('button', { name: `Confirm ${label}`, exact: true })
    .click();
  if (refusal)
    await expect(page.locator('[data-message-subject]').first()).toHaveText(
      refusal,
    );
  else
    await expect(page.locator('[data-task-result]')).toContainText(
      `${label}: done`,
    );
}

/** Post on the saved stock document, confirmed. */
async function post(page: Page) {
  const secondary = page.locator(
    '.composition-record-actions:not([open]) > summary',
  );
  if (await secondary.count()) await secondary.click();
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Post', exact: true }).click();
}

/**
 * Types into a picker and chooses an offered record -- in place with the
 * owned script, as ordinary submits without it.
 */
async function pick(page: Page, name: string, term: string, option: string) {
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
}

/**
 * The order-entry fixture, served with `--verify` so each scenario is seeded
 * through its own governed operations once the application is up.
 */
async function fixture(
  run: (url: string, seed: <T>(phase: string) => Promise<T>) => Promise<void>,
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
  let seeded: ((value: unknown) => void) | null = null;
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
          seeded?.(JSON.parse(line.slice('ORDER_ENTRY_MEASURED='.length)));
          seeded = null;
        }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('exit', () => reject(new Error(output)));
  });
  const seed = <T>(phase: string) =>
    new Promise<T>((resolve, reject) => {
      seeded = resolve as (value: unknown) => void;
      child.once('exit', () => reject(new Error(output)));
      child.stdin.write(`${JSON.stringify({ phase })}\n`);
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
