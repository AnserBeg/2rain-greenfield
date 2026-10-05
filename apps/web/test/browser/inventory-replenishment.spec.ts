import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';

interface Scenario {
  readonly notebook: string;
  readonly pens: string;
  readonly lamp: string;
  readonly labels: string;
}

// REPLENISHMENT: what to keep, what is short and what to buy. The fixture
// moves stock and orders through the governed operations: Field notebook's
// opening 10, a released purchase order from Alpine Office Supply for 8 with 3
// received, a later one from Summit Industrial for 4, a confirmed sale of 6
// with 4 reserved and 1 shipped (and drafts that add nothing); Task lamp has
// a confirmed sale of 3 and no stock; Task lamp and Shipping labels have their
// levels. The person sets the notebook's on its form and works from there.
test('an item keeps its reorder levels, Stock by item names what is short and the Buying worklist what to order, and a purchase line starts from the standard cost', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    const scenario = await seed();
    await page.goto(url);
    const navigation = page.getByRole('navigation', {
      name: 'Release navigation',
    });

    // Catalog -> Items -> Field notebook -> Edit.
    const more = navigation
      .locator('.navigation-tree > li')
      .getByRole('group')
      .filter({ hasText: 'More' });
    await more.getByText('More', { exact: true }).click();
    await more.getByText('Catalog', { exact: true }).click();
    await navigation.getByRole('link', { name: 'Item', exact: true }).click();
    await page
      .locator('tr', { hasText: 'Field notebook' })
      .locator('a.record-link')
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Field notebook' }),
    ).toBeVisible();
    const itemUrl = page.url();
    const recordActions = page.locator(
      '[data-platform-slot="record:commandBar"] details.composition-record-actions',
    );
    await recordActions.locator(':scope > summary').click();
    await recordActions
      .getByRole('link', { name: 'Edit', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Edit Item' }),
    ).toBeVisible();
    await page.getByLabel('Reorder point', { exact: true }).fill('20');
    await page.getByLabel('Reorder up to', { exact: true }).fill('30');
    // The preferred location is chosen by name; the item keeps its id. A
    // select is found by its role, as every generic form's choice is: its
    // label's text includes the chosen option.
    const location = page.getByRole('combobox', {
      name: 'Preferred location',
      exact: true,
    });
    await expect(location).toHaveAttribute(
      'data-form-reference',
      `${ns}:field.item_preferred_location_id`,
    );
    await expect(location.locator('option')).toHaveText([
      'None',
      'Beltline store',
      'Calgary warehouse',
      'Edmonton store',
      'Vancouver warehouse',
    ]);
    await location.selectOption({ label: 'Calgary warehouse' });
    // The generic form names a field by its id, as it names Price cad.
    await page.getByLabel('Standard cost cad', { exact: true }).fill('4.5');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Update complete');

    // The item page shows them: the location by name, the cost as money.
    await page.goto(itemUrl);
    const fact = (label: string) =>
      page
        .locator('[data-composition-fields] div')
        .filter({
          has: page.locator('dt', { hasText: new RegExp(`^${label}$`, 'u') }),
        })
        .locator('dd');
    await expect(fact('Reorder point')).toHaveText('20');
    await expect(fact('Reorder up to')).toHaveText('30');
    await expect(fact('Preferred location')).toHaveText('Calgary warehouse');
    await expect(fact('Standard cost \\(CAD\\)')).toHaveText('4.50');
    await capture(page, testInfo, 'replenishment-item');

    // Inventory -> Stock by item: every item in this company.
    const inventory = navigation
      .locator('.navigation-tree > li')
      .getByRole('group')
      .filter({ hasText: 'Inventory' });
    await open(inventory, 'Inventory', 'Stock by item');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Stock by item' }),
    ).toBeVisible();
    const views = page.getByRole('navigation', { name: 'Views' });
    await expect(views.getByRole('link', { name: 'All 4' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(views.getByRole('link', { name: 'Shortage 1' })).toBeVisible();
    await expect(views.getByRole('link', { name: 'Reorder 2' })).toBeVisible();
    // 10 opening + 3 received - 1 shipped; 3 still reserved; 5 + 4 still to
    // arrive; 5 still to ship: projected 16, at or below its reorder point.
    expect(
      await cells(page, 'item_stock_list', scenario.notebook, [
        'on_hand',
        'reserved',
        'available',
        'incoming',
        'open_demand',
        'projected',
        'reorder_point',
        'status',
      ]),
    ).toEqual(['12', '3', '9', '9', '5', '16', '20', 'Reorder']);
    // A figure is shown, never offered as a sort.
    await expect(
      page.locator(
        `[data-sort-column="${ns}:list_column.item_stock_list_projected"]`,
      ),
    ).toHaveCount(0);
    await capture(page, testInfo, 'replenishment-stock');
    // The Shortage tab: only what projected stock cannot cover.
    await views.getByRole('link', { name: 'Shortage 1' }).click();
    await expect(page.getByText('1 matching record')).toBeVisible();
    expect(
      await cells(page, 'item_stock_list', scenario.lamp, [
        'projected',
        'status',
      ]),
    ).toEqual(['-3', 'Shortage']);
    await expect(
      page.locator(`tr[data-record-id="${scenario.notebook}"]`),
    ).toHaveCount(0);

    // Inventory -> Buying worklist: what is due, back up to its level.
    await open(inventory, 'Inventory', 'Buying worklist');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Buying worklist' }),
    ).toBeVisible();
    await expect(views.getByRole('link', { name: 'To buy 3' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      await cells(page, 'item_buying_list', scenario.notebook, [
        'projected',
        'reorder_point',
        'reorder_up_to',
        'suggested',
        'last_supplier',
      ]),
    ).toEqual(['16', '20', '30', '14', 'Summit Industrial']);
    // No level: no suggestion; never bought: no supplier -- "—", not 0.
    expect(
      await cells(page, 'item_buying_list', scenario.lamp, [
        'suggested',
        'last_supplier',
      ]),
    ).toEqual(['—', '—']);
    await expect(
      page.locator(`tr[data-record-id="${scenario.pens}"]`),
    ).toHaveCount(0);
    await capture(page, testInfo, 'replenishment-worklist');

    // A purchase line starts from the item's standard cost in the order's
    // currency (ruling PC).
    const purchasing = navigation.getByRole('link', {
      name: 'Purchase orders',
      exact: true,
    });
    if (!(await purchasing.isVisible()))
      await navigation.getByText('Purchasing', { exact: true }).click();
    await purchasing.click();
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await pick(page, 'Vendor', 'Alpine', 'Alpine Office Supply');
    await expect(page.getByLabel('Currency *')).toHaveValue('CAD');
    await pick(page, 'Line 1 product', 'OFF-100', 'Field notebook');
    await expect(
      page.getByLabel('Line 1 unit cost', { exact: true }),
    ).toHaveValue('4.5');
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
      child.stdin.write(`${JSON.stringify({ phase: 'replenishment' })}\n`);
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
