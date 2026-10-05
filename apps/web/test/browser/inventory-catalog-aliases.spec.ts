import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';

interface Scenario {
  readonly notebook: string;
  readonly pens: string;
  readonly labels: string;
  readonly duplicate: string;
}

// CATALOG-EXTRAS over the replenishment scenario: the Field notebook (OFF-100)
// is known by a barcode and by Alpine's own code, Shipping labels are not
// kept in stock, the Fine-point pen set follows the company rule with a
// level of 50, the company reorders at 40% of an item's level, and the
// notebook was entered twice (OFF-100-DUP). The person finds the notebook by
// an alias, adds one, sees the stock Lists judge the rule and the policy,
// and merges the duplicate.
test('an item is found by its aliases, the stock Lists follow the company rule and skip what is not stocked, and a duplicate merges into the item it repeats', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    await seed('replenishment');
    const scenario = await seed('catalog_extras');
    await page.goto(url);
    const navigation = page.getByRole('navigation', {
      name: 'Release navigation',
    });
    const dialog = page.getByRole('dialog');
    const finish = async (label: string) => {
      await dialog.getByRole('button', { name: `Review ${label}` }).click();
      await dialog.getByRole('button', { name: `Confirm ${label}` }).click();
    };

    // Catalog -> Item: the barcode finds the notebook, in any case.
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
    const views = page.getByRole('navigation', { name: 'Views' });
    await expect(
      views.getByRole('link', { name: /^Non-stocked/u }),
    ).toBeVisible();
    const search = page.getByRole('searchbox').first();
    await search.fill('alp-nb-80');
    await search.press('Enter');
    await expect(
      page.locator(`tr[data-record-id="${scenario.notebook}"]`),
    ).toBeVisible();
    await expect(page.locator('tbody tr[data-record-id]')).toHaveCount(1);
    await capture(page, testInfo, 'catalog-extras-items');

    // The item page lists its aliases; Add alias names one more.
    await page
      .locator(`tr[data-record-id="${scenario.notebook}"]`)
      .locator('a.record-link')
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Field notebook' }),
    ).toBeVisible();
    const aliases = page.locator(
      `[data-composition-dataset="${ns}:dataset.item_aliases"] tbody tr`,
    );
    await expect(aliases.locator('strong')).toHaveText([
      '0012345678905',
      'ALP-NB-80',
    ]);
    await page.getByRole('button', { name: 'Add alias', exact: true }).click();
    await dialog.getByLabel('Alias', { exact: true }).fill('NB-RULED-80');
    await dialog
      .getByLabel('Kind', { exact: true })
      .selectOption({ label: 'Alternate SKU' });
    await finish('Add alias');
    await expect(page.getByRole('status').first()).toContainText(
      'Add alias: done',
    );
    await page.reload();
    await expect(aliases.locator('strong')).toHaveText([
      '0012345678905',
      'ALP-NB-80',
      'NB-RULED-80',
    ]);
    await capture(page, testInfo, 'catalog-extras-item');

    // A product picker finds it by the new alias too.
    const purchasing = navigation.getByRole('link', {
      name: 'Purchase orders',
      exact: true,
    });
    if (!(await purchasing.isVisible()))
      await navigation.getByText('Purchasing', { exact: true }).click();
    await purchasing.click();
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await pick(page, 'Line 1 product', 'nb-ruled', 'Field notebook');

    // Inventory -> Stock by item: the labels are not stocked and never short
    // or due; the pens reorder at 40% of their level of 50.
    const inventory = navigation
      .locator('.navigation-tree > li')
      .getByRole('group')
      .filter({ hasText: 'Inventory' });
    await open(inventory, 'Inventory', 'Stock by item');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Stock by item' }),
    ).toBeVisible();
    expect(
      await cells(page, 'item_stock_list', scenario.labels, ['status']),
    ).toEqual(['Not stocked']);
    expect(
      await cells(page, 'item_stock_list', scenario.pens, [
        'projected',
        'reorder_point',
        'status',
      ]),
    ).toEqual(['0', '20', 'Reorder']);
    await views.getByRole('link', { name: /^Reorder/u }).click();
    await expect(
      page.locator(`tr[data-record-id="${scenario.pens}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`tr[data-record-id="${scenario.labels}"]`),
    ).toHaveCount(0);
    await open(inventory, 'Inventory', 'Buying worklist');
    expect(
      await cells(page, 'item_buying_list', scenario.pens, [
        'reorder_point',
        'suggested',
      ]),
    ).toEqual(['20', '50']);
    await expect(
      page.locator(`tr[data-record-id="${scenario.labels}"]`),
    ).toHaveCount(0);
    await capture(page, testInfo, 'catalog-extras-worklist');

    // The duplicate merges into the notebook: never offered itself.
    const duplicate = new URL(url);
    duplicate.searchParams.set('surface', `${ns}:surface.item_detail`);
    duplicate.searchParams.set('record', scenario.duplicate);
    await page.goto(duplicate.toString());
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Field notebook (duplicate)',
      }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Merge into another item', exact: true })
      .click();
    const survivor = dialog.getByLabel('Surviving item (SKU)');
    await expect(
      survivor.locator('option', { hasText: 'OFF-100-DUP' }),
    ).toHaveCount(0);
    await survivor.selectOption({ label: 'OFF-100' });
    await finish('Merge into another item');
    await expect(page.getByText('Task complete').first()).toBeVisible();

    // Its SKU now finds the notebook.
    const items = new URL(url);
    items.searchParams.set('surface', `${ns}:surface.item_list`);
    items.searchParams.set('q', 'OFF-100-DUP');
    await page.goto(items.toString());
    await expect(
      page.locator(`tr[data-record-id="${scenario.notebook}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`tr[data-record-id="${scenario.duplicate}"]`),
    ).toHaveCount(0);
  });
});

/**
 * A destination inside a navigation group, which renders collapsed even on
 * its own pages: opened first unless it already shows the link.
 */
async function open(group: Locator, label: string, destination: string) {
  const link = group.getByRole('link', { name: destination, exact: true });
  if (!(await link.isVisible()))
    await group.getByText(label, { exact: true }).click();
  await link.click();
}

/** A row's cells by column, as shown. */
async function cells(
  page: Page,
  list: string,
  recordId: string,
  columns: readonly string[],
): Promise<string[]> {
  const row = page.locator(`tr[data-record-id="${recordId}"]`);
  const values: string[] = [];
  for (const local of columns)
    values.push(
      (
        await row
          .locator(`td[data-column-id="${ns}:list_column.${list}_${local}"]`)
          .innerText()
      ).trim(),
    );
  return values;
}

function combo(page: Page, name: string): Locator {
  return page.getByRole('combobox', { name, exact: true });
}

async function pick(page: Page, name: string, term: string, option: string) {
  const field = page
    .locator('[data-reference-field]')
    .filter({ has: combo(page, name) });
  await combo(page, name).fill(term);
  const enhanced =
    (await page.locator('body[data-reference-enhanced]').count()) > 0;
  if (!enhanced)
    await field.getByRole('button', { name: 'Search', exact: true }).click();
  await field
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

/** Desktop and phone width: the page scrolls down, never sideways. */
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
 * The order-entry fixture, served with `--verify` so each scenario is seeded
 * through its own governed operations once the application is up.
 */
async function fixture(
  run: (
    url: string,
    seed: (phase: string) => Promise<Scenario>,
  ) => Promise<void>,
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
  const seed = (phase: string) =>
    new Promise<Scenario>((resolve, reject) => {
      seeded = resolve;
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
