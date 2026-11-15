import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';
/** The item page carries its company under the Posted stock List's operand. */
const COMPANY = `${ns}:parameter.posted_stock_balance_list_legal_entity_scope`;

interface Scenario {
  readonly itemId: string;
  readonly main: string;
  readonly overflow: string;
  readonly shipmentId: string;
}

// INVENTORY-PARITY S1: stock on the item page. Field notebook's stock is
// moved through the governed operations (6 more at VAN-WH, a receipt of 5,
// and a shipment of 2 against a reservation of 3 at CAL-WH); the page is then
// reached from the menu the way a person reaches it.
test('the item page shows stock by location and the recent movements, in the company it picks', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    const scenario = await seed();
    await page.goto(url);
    // Catalog -> Items -> the item.
    const navigation = page.getByRole('navigation', {
      name: 'Release navigation',
    });
    const more = navigation
      .locator('.navigation-tree > li')
      .getByRole('group')
      .filter({ hasText: 'More' });
    await more.getByText('More', { exact: true }).click();
    await more.getByText('Catalog', { exact: true }).click();
    await navigation.getByRole('link', { name: 'Item', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Item' }),
    ).toBeVisible();
    await page
      .locator('tr', { hasText: 'Field notebook' })
      .locator('a.record-link')
      .click();

    // The only authorized company is picked, and the bar names it.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Field notebook' }),
    ).toBeVisible();
    const address = new URL(page.url());
    expect(address.searchParams.get('record')).toBe(scenario.itemId);
    const company = address.searchParams.get(COMPANY);
    expect(company).not.toBeNull();
    const bar = page.getByRole('navigation', { name: 'Company' });
    await expect(bar).toHaveAttribute('data-scope-parameter-id', COMPANY);
    await expect(
      bar.locator(`a[data-legal-entity-id="${company!}"]`),
    ).toHaveAttribute('aria-current', 'true');

    // Stock by location: on hand, what the reservation still holds, and
    // what is left, highest stock first.
    const stock = page.locator(
      `[data-composition-dataset="${ns}:dataset.item_stock"]`,
    );
    await expect(
      stock.getByRole('heading', { name: 'Stock by location' }),
    ).toBeVisible();
    // Each location names its inventory status (LOCATIONS): both usable.
    expect(await rows(stock)).toEqual([
      {
        Location: 'CAL-WH',
        Status: 'Usable',
        'On hand': '13',
        Reserved: '1',
        Available: '12',
        Unit: 'EA',
      },
      {
        Location: 'VAN-WH',
        Status: 'Usable',
        'On hand': '6',
        Reserved: '0',
        Available: '6',
        Unit: 'EA',
      },
    ]);
    await stock.getByText('About these quantities').click();
    await expect(
      stock.getByText('Missing or unavailable data is not zero stock.', {
        exact: false,
      }),
    ).toBeVisible();

    // Recent movements, newest first: the shipment leads.
    const movements = page.locator(
      `[data-composition-dataset="${ns}:dataset.item_movements"]`,
    );
    const history = await rows(movements);
    expect(
      history.map((row) => [row.Role, row.Location, row.Change, row.Source]),
    ).toEqual([
      ['shipment', 'CAL-WH', '-2', 'shipment'],
      ['receipt', 'CAL-WH', '5', 'goodsReceipt'],
      ['adjustment', 'VAN-WH', '6', 'inventoryTransaction'],
      ['adjustment', 'CAL-WH', '10', 'inventoryTransaction'],
    ]);
    await expect(
      movements.locator('tr[data-record-id]').first().locator('td').first(),
    ).toContainText('UTC');
    await page.screenshot({
      path: testInfo.outputPath('item-stock.png'),
      fullPage: true,
    });

    // The company follows the menu: Posted stock opens in the same company.
    const inventory = navigation
      .locator('.navigation-tree > li')
      .getByRole('group')
      .filter({ hasText: 'Inventory' });
    const postedStock = inventory.locator('a', { hasText: 'Posted stock' });
    expect(
      new URL(
        (await postedStock.getAttribute('href'))!,
        page.url(),
      ).searchParams.get(COMPANY),
    ).toBe(company);

    // Phone width: the page scrolls down, never sideways.
    await capturePhone(page, testInfo.outputPath('item-stock-phone.png'));
  });
});

/** Each row of a section as its column labels and shown values. */
async function rows(section: Locator) {
  return section
    .locator('tr[data-record-id]')
    .evaluateAll((elements) =>
      elements.map((row) =>
        Object.fromEntries(
          [...row.querySelectorAll('td[data-column-label]')].map((cell) => [
            cell.getAttribute('data-column-label')!,
            (cell.querySelector('strong') ?? cell).textContent!.trim(),
          ]),
        ),
      ),
    );
}

/** One screen width at phone size: the page scrolls down, never sideways. */
async function capturePhone(page: Page, path: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole('heading', { name: 'Stock by location' }),
  ).toBeVisible();
  await page.screenshot({ path, fullPage: true });
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
      child.stdin.write(`${JSON.stringify({ phase: 'item_stock' })}\n`);
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
