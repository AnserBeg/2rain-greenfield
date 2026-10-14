import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';
const salesColumn = (local: string) =>
  `${ns}:list_column.sales_order_list_${local}`;
const purchaseColumn = (local: string) =>
  `${ns}:list_column.purchase_order_list_${local}`;

interface Seeded {
  readonly number: string;
  readonly recordId: string;
  readonly total?: string;
}
interface Scenario {
  readonly sales: { readonly shipping: Seeded; readonly draft: Seeded };
  readonly purchases: {
    readonly receiving: Seeded;
    readonly complete: Seeded;
  };
}

// ORDER-PARITY increment A: the order Lists state what is left to ship and to
// receive, total each purchase order, and link each row to the work on its
// order. The orders are seeded through the governed operations (a confirmed
// sales order with three of one line shipped and a draft; a released purchase
// order with priced lines and four of one received, and one received in
// full); the Lists are then read, filtered and followed in the browser.
test('the order Lists show what is left to ship and receive, total each purchase order and open an order at its work, by keyboard and at phone width', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    const orders = await seed();
    const { shipping, draft } = orders.sales;
    const { receiving, complete } = orders.purchases;
    await page.goto(url);
    await expect(
      page.getByRole('heading', { name: 'Sales orders', level: 1 }),
    ).toBeVisible();

    // The To ship tab by keyboard: only the confirmed order with work left.
    const views = page.getByRole('navigation', { name: 'Views' });
    await views.getByRole('link', { name: 'To ship 1' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('1 matching record')).toBeVisible();
    await expect(page.getByText(draft.number)).toHaveCount(0);
    const row = page.locator(`tr[data-record-id="${shipping.recordId}"]`);
    const cell = (local: string) =>
      row.locator(`td[data-column-id="${salesColumn(local)}"]`);
    // 5 + 3 ordered, 3 shipped: 5 left to ship.
    await expect(cell('ordered')).toHaveText('8');
    await expect(cell('shipped')).toHaveText('3');
    await expect(cell('open')).toHaveText('5');
    // A figure is shown, not offered as a sort.
    await expect(
      page.locator(`[data-sort-column="${salesColumn('open')}"]`),
    ).toHaveCount(0);
    // One of its reserved units is still to ship (SUPPLY-WARNINGS): the row
    // offers "Post shipment", at the same fulfillment section.
    const fulfill = page.getByRole('link', {
      name: `Post shipment ${shipping.number}`,
      exact: true,
    });
    await expect(fulfill).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('order-lists-to-ship.png'),
    });
    // At phone width the List scrolls down, never sideways, and the row's
    // card keeps its action.
    await atPhoneWidth(
      page,
      testInfo.outputPath('order-lists-to-ship-phone.png'),
      async () => {
        await expect(fulfill).toBeVisible();
        await expect(
          row.locator('td[data-column-label="Actions"]'),
        ).toBeVisible();
      },
    );

    // The row's action by keyboard: the order, at its fulfillment section.
    await fulfill.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/sales_order_detail/u);
    const opened = new URL(page.url());
    expect(opened.searchParams.get('record')).toBe(shipping.recordId);
    expect(decodeURIComponent(opened.hash)).toBe(
      `#${ns}:dataset.fulfillment_lines`,
    );
    await expect(page.locator('.composition-header h1')).toHaveText(
      shipping.number,
    );
    await expect(
      page.locator(
        `section[data-composition-dataset="${ns}:dataset.fulfillment_lines"]`,
      ),
    ).toBeInViewport();

    // All orders: the draft has nothing to ship and offers its page.
    await page.goBack();
    await views.getByRole('link', { name: /^All/ }).click();
    await expect(page.getByText('2 matching records')).toBeVisible();
    await expect(
      page.getByRole('link', { name: `View ${draft.number}`, exact: true }),
    ).toBeVisible();

    // Purchase orders: each order's Total beside its currency, never a sort,
    // with what is still to arrive.
    const navigation = page.getByRole('navigation', {
      name: 'Release navigation',
    });
    await navigation.getByText('Purchasing', { exact: true }).click();
    await navigation
      .getByRole('link', { name: 'Purchase orders', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Purchase orders', level: 1 }),
    ).toBeVisible();
    const purchase = (recordId: string, local: string) =>
      page.locator(
        `tr[data-record-id="${recordId}"] td[data-column-id="${purchaseColumn(local)}"]`,
      );
    await expect(purchase(receiving.recordId, 'total')).toHaveText(
      receiving.total!,
    );
    await expect(purchase(complete.recordId, 'total')).toHaveText(
      complete.total!,
    );
    await expect(purchase(receiving.recordId, 'ordered')).toHaveText('15');
    await expect(purchase(receiving.recordId, 'received')).toHaveText('4');
    await expect(purchase(receiving.recordId, 'open')).toHaveText('11');
    await expect(purchase(complete.recordId, 'open')).toHaveText('0');
    await expect(
      page.locator(`[data-sort-column="${purchaseColumn('total')}"]`),
    ).toHaveCount(0);
    await expect(
      views.getByRole('link', { name: 'To receive 1' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: `View ${complete.number}`, exact: true }),
    ).toBeVisible();
    const receive = page.getByRole('link', {
      name: `Receive ${receiving.number}`,
      exact: true,
    });
    await atPhoneWidth(
      page,
      testInfo.outputPath('order-lists-purchase-orders-phone.png'),
      async () => {
        await expect(receive).toBeVisible();
        await expect(purchase(receiving.recordId, 'total')).toBeVisible();
      },
    );

    // Receive: the order at its lines, whose page states the same Total.
    await receive.click();
    await expect(page).toHaveURL(/purchase_order_detail/u);
    const receivingPage = new URL(page.url());
    expect(receivingPage.searchParams.get('record')).toBe(receiving.recordId);
    expect(decodeURIComponent(receivingPage.hash)).toBe(
      `#${ns}:dataset.purchasing_lines`,
    );
    await expect(
      page.locator(
        `section[data-composition-dataset="${ns}:dataset.purchasing_lines"]`,
      ),
    ).toBeInViewport();
    await expect(
      page
        .locator('.composition-header-facts > div')
        .filter({ has: page.locator('dt', { hasText: /^Total$/u }) })
        .locator('dd'),
    ).toHaveText(receiving.total!);
  });
});

/** One screen width at phone size: the List scrolls down, never sideways. */
async function atPhoneWidth(
  page: Page,
  path: string,
  check: () => Promise<void>,
) {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await check();
  await page.screenshot({ path });
  await page.setViewportSize({ width: 1280, height: 800 });
}

/**
 * The order-entry fixture, served with `--verify` so the scenario is seeded
 * through its own governed operations once the application is up.
 */
async function fixture(
  run: (url: string, seed: () => Promise<Scenario>) => Promise<void>,
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
  let seeded: ((value: Scenario) => void) | null = null;
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
            JSON.parse(line.slice('ORDER_ENTRY_MEASURED='.length)) as Scenario,
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
    new Promise<Scenario>((resolve, reject) => {
      seeded = resolve;
      child.once('exit', () => reject(new Error(output)));
      child.stdin.write(`${JSON.stringify({ phase: 'order_lists' })}\n`);
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
