import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';

interface Scenario {
  readonly notebook: string;
  readonly warehouse: string;
  readonly hold: string;
  readonly order: string;
  readonly line: string;
}

// LOCATIONS: a location's inventory status says what the stock held there
// may be used for. The fixture moves stock through the governed operations:
// Field notebook's opening 10 at Calgary warehouse; a Quality hold location
// of the quarantine type, put in quarantine with a reason; a transfer of 4
// notebooks into it; a confirmed sale of 8 notebooks, nothing reserved.
test('a quarantined location keeps its stock on hand but neither usable nor available, until its page changes the status back with a reason', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    const scenario = await seed();
    const dialog = page.getByRole('dialog');
    await page.goto(url);
    const navigation = page.getByRole('navigation', {
      name: 'Release navigation',
    });
    const groups = navigation
      .locator('.navigation-tree > li')
      .getByRole('group');
    const more = groups.filter({ hasText: 'More' });
    const inventory = groups.filter({ hasText: 'Inventory' });

    // More -> Location: every location with its type and inventory status.
    await open(more, 'More', 'Location');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Location' }),
    ).toBeVisible();
    expect(
      await cells(page, 'location_list', scenario.hold, [
        'code',
        'type',
        'status',
        'status_reason',
      ]),
    ).toEqual([
      'QA-HOLD',
      'Quarantine',
      'Quarantine',
      'Water damage on an inbound pallet',
    ]);
    expect(
      await cells(page, 'location_list', scenario.warehouse, ['status']),
    ).toEqual(['Usable']);
    // The status filter keeps the quarantined location alone.
    await page
      .getByLabel('Inventory status', { exact: true })
      .selectOption({ label: 'Quarantine' });
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByText('1 matching record')).toBeVisible();
    await expect(
      page.locator(`tr[data-record-id="${scenario.warehouse}"]`),
    ).toHaveCount(0);
    await capture(page, testInfo, 'locations-list');

    // Inventory -> Stock by item: 10 on hand, 6 of them usable; nothing
    // reserved, so 6 available; 8 to ship: projected -2, a shortage the
    // quarantined 4 does not hide.
    await open(inventory, 'Inventory', 'Stock by item');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Stock by item' }),
    ).toBeVisible();
    expect(
      await cells(page, 'item_stock_list', scenario.notebook, [
        'on_hand',
        'usable',
        'reserved',
        'available',
        'open_demand',
        'projected',
        'status',
      ]),
    ).toEqual(['10', '6', '0', '6', '8', '-2', 'Shortage']);
    await capture(page, testInfo, 'locations-stock');

    // The hold's page: its status in the header, and "Change status".
    await open(more, 'More', 'Location');
    await page
      .locator(`tr[data-record-id="${scenario.hold}"]`)
      .locator('a.record-link')
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Quality hold' }),
    ).toBeVisible();
    const holdUrl = page.url();
    await expect(page.locator('.composition-business-status')).toHaveText(
      'Quarantine',
    );
    const fact = (label: string) =>
      page
        .locator('.composition-header-facts div')
        .filter({
          has: page.locator('dt', { hasText: new RegExp(`^${label}$`, 'u') }),
        })
        .locator('dd');
    await expect(fact('Type')).toHaveText('Quarantine');
    await expect(fact('Status reason')).toHaveText(
      'Water damage on an inbound pallet',
    );
    await capture(page, testInfo, 'location-page');
    // The generic form edits the code, name and type, never the status.
    const recordActions = page.locator(
      '[data-platform-slot="record:commandBar"] details.composition-record-actions',
    );
    await recordActions.locator(':scope > summary').click();
    await recordActions
      .getByRole('link', { name: 'Edit', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Edit Location' }),
    ).toBeVisible();
    await expect(page.getByLabel('Code', { exact: true })).toHaveValue(
      'QA-HOLD',
    );
    await expect(page.locator('[name$="field.location_status"]')).toHaveCount(
      0,
    );
    await expect(
      page.locator('[name$="field.location_status_reason"]'),
    ).toHaveCount(0);

    // Inspected and released: a reason is required.
    await page.goto(holdUrl);
    await page
      .getByRole('button', { name: 'Change status', exact: true })
      .click();
    await expect(dialog.getByLabel('Inventory status')).toHaveValue(
      `${ns}:option.location_status_quarantine`,
    );
    await dialog
      .getByLabel('Inventory status')
      .selectOption({ label: 'Usable' });
    await dialog.getByLabel('Reason').fill('Inspected and released');
    await dialog.getByRole('button', { name: 'Review Change status' }).click();
    await dialog.getByRole('button', { name: 'Confirm Change status' }).click();
    await expect(page.getByRole('status').first()).toContainText(
      'Change status: done',
    );
    await page.goto(holdUrl);
    await expect(page.locator('.composition-business-status')).toHaveText(
      'Usable',
    );
    await expect(fact('Status reason')).toHaveText('Inspected and released');

    // Every figure follows: all 10 usable and available.
    await open(inventory, 'Inventory', 'Stock by item');
    expect(
      await cells(page, 'item_stock_list', scenario.notebook, [
        'usable',
        'available',
        'projected',
      ]),
    ).toEqual(['10', '10', '2']);

    // Slice 2: a bin placed inside Calgary warehouse when it is created.
    await open(more, 'More', 'Location');
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'New Location' }),
    ).toBeVisible();
    await page.getByLabel('Code', { exact: true }).fill('CAL-A1');
    await page.getByLabel('Name', { exact: true }).fill('Aisle 1');
    await page
      .getByRole('combobox', { name: 'Type', exact: true })
      .selectOption({ label: 'Storage' });
    await page
      .getByRole('combobox', { name: 'Parent', exact: true })
      .selectOption(scenario.warehouse);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Create complete');
    // The warehouse's page lists the bin inside it.
    await open(more, 'More', 'Location');
    await page
      .locator(`tr[data-record-id="${scenario.warehouse}"]`)
      .locator('a.record-link')
      .click();
    const inside = page.locator(
      `[data-composition-dataset="${ns}:dataset.location_children"]`,
    );
    await expect(inside).toContainText('CAL-A1');
    await expect(inside).toContainText('Storage');
    await capture(page, testInfo, 'location-warehouse');
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
      child.stdin.write(`${JSON.stringify({ phase: 'locations' })}\n`);
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
