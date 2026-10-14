import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';
// Distributor seed: Whitecourt Forestry and Chestermere Dental Group are
// customers with order defaults and one "Main delivery" address each.
const whitecourt = '71000000-0000-4000-8000-000000001026';

test('a customer workspace sets order defaults and an address book that a new sales order takes in place', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url) => {
    const dialog = page.getByRole('dialog');
    const workspace = new URL(url);
    workspace.searchParams.set('surface', `${ns}:surface.party_detail`);
    workspace.searchParams.set('record', whitecourt);
    const facts = page.locator('.composition-header-facts');
    const fact = (label: string) =>
      facts
        .locator('div')
        .filter({ has: page.locator('dt', { hasText: label }) })
        .locator('dd');
    const finish = async (label: string) => {
      await dialog.getByRole('button', { name: `Review ${label}` }).click();
      await dialog.getByRole('button', { name: `Confirm ${label}` }).click();
      await expect(page.getByRole('status').first()).toContainText(
        `${label}: done`,
      );
    };

    // The customer workspace: its seeded defaults, roles and address book.
    await page.goto(workspace.toString());
    await expect(
      page.getByRole('heading', { name: 'Whitecourt Forestry', level: 1 }),
    ).toBeVisible();
    await expect(fact('Default currency')).toHaveText('CAD');
    await expect(fact('Payment terms')).toHaveText('Net 30');
    await expect(fact('Default salesperson')).toHaveText('Jordan Blake');
    await expect(fact('Default ship-to')).toHaveText('Main delivery');
    await expect(page.locator('[aria-label="Record tasks"] button')).toHaveText(
      [
        'Add role',
        'Set order defaults',
        'Set default salesperson',
        // Ruling B: new lines start from the customer's tax code.
        'Set default tax code',
        // SALES-EXTRAS: credit control.
        'Set credit limit',
        'Put on credit hold',
        'Add ship-to address',
      ],
    );

    // Add an address to the book, then make it the default ship-to.
    await page
      .getByRole('button', { name: 'Add ship-to address', exact: true })
      .click();
    await dialog.getByLabel('Address label').fill('North yard');
    await dialog.getByLabel('Recipient').fill('Yard office');
    await dialog.getByLabel('Street address').fill('4500 Forestry Road');
    await dialog.getByLabel('City').fill('Whitecourt');
    await dialog.getByLabel('Province or state').fill('AB');
    await dialog.getByLabel('Postal code').fill('T7S 1A2');
    await dialog.getByLabel('Country').fill('Canada');
    await finish('Add ship-to address');
    await page.goto(workspace.toString());
    const addresses = page.locator(
      '[data-composition-dataset$="dataset.party_addresses"] tbody tr',
    );
    // The book is ordered by label.
    await expect(addresses.locator('strong')).toHaveText([
      'Main delivery',
      'North yard',
    ]);
    await addresses
      .filter({ hasText: 'North yard' })
      .getByRole('link', { name: 'Select' })
      .click();
    await addresses
      .filter({ hasText: 'North yard' })
      .getByRole('button', { name: 'Use as default ship-to' })
      .click();
    await finish('Use as default ship-to');

    // Order defaults start from the stored values.
    await page.goto(workspace.toString());
    await page
      .getByRole('button', { name: 'Set order defaults', exact: true })
      .click();
    await expect(dialog.getByLabel('Default currency')).toHaveValue(
      `${ns}:option.party_default_currency_cad`,
    );
    await expect(dialog.getByLabel('Payment terms')).toHaveValue(
      `${ns}:option.party_payment_terms_net_30`,
    );
    await dialog
      .getByLabel('Default currency')
      .selectOption({ label: 'USD · US dollar' });
    await dialog.getByLabel('Payment terms').selectOption({ label: 'Net 45' });
    await finish('Set order defaults');

    // Only parties holding an active salesperson role are offered.
    await page.goto(workspace.toString());
    await page
      .getByRole('button', { name: 'Set default salesperson', exact: true })
      .click();
    // The offered set, in no promised order: the fixture's own salesperson
    // takes a random record id, so where it lists is incidental.
    const salespeople = dialog.getByLabel('Salesperson').locator('option');
    await expect(salespeople).toHaveCount(5);
    const offered = await salespeople.allTextContents();
    expect(offered[0]).toBe('Select…');
    expect(offered.slice(1).toSorted()).toEqual([
      'Avery Chen',
      'Jordan Blake',
      'Morgan Lee',
      'Priya Natarajan',
    ]);
    await dialog
      .getByLabel('Salesperson')
      .selectOption({ label: 'Priya Natarajan' });
    await finish('Set default salesperson');
    await page.goto(workspace.toString());
    await expect(fact('Default currency')).toHaveText('USD');
    await expect(fact('Payment terms')).toHaveText('Net 45');
    await expect(fact('Default salesperson')).toHaveText('Priya Natarajan');
    await expect(fact('Default ship-to')).toHaveText('North yard');
    await capture(page, testInfo, 'customer-workspace');

    // A new order takes every default in place when the customer is chosen.
    await page.goto(url);
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await pick(page, 'Customer', 'Whitecourt', 'Whitecourt Forestry');
    await expect(combo(page, 'Salesperson')).toHaveAttribute(
      'data-selected-label',
      'Priya Natarajan',
    );
    await expect(page.getByLabel('Currency *')).toHaveValue('USD');
    await expect(page.getByLabel('Payment terms')).toHaveValue(
      `${ns}:option.sales_order_payment_terms_net_45`,
    );
    await expect(combo(page, 'Ship-to address')).toHaveAttribute(
      'data-selected-label',
      'North yard',
    );
    await expect
      .poll(() => shipTo(page))
      .toEqual({
        recipient: 'Yard office',
        street: '4500 Forestry Road',
        city: 'Whitecourt',
        region: 'AB',
        postal: 'T7S 1A2',
        country: 'Canada',
      });
    // The ship-to picker lists this customer's own book only.
    await combo(page, 'Ship-to address').focus();
    await expect(records(page, 'Ship-to address')).toHaveCount(2);
    await records(page, 'Ship-to address')
      .filter({ hasText: 'Main delivery' })
      .click();
    await expect(page.getByLabel('Street', { exact: true })).toHaveValue(
      '726 Industrial Way',
    );
    await page.getByLabel('Order date (UTC) *').fill('2026-09-28T12:00');
    await pick(page, 'Line 1 product', 'OFF-100', 'Field notebook');
    await page.getByLabel('Line 1 quantity', { exact: true }).fill('2');
    await page.getByLabel('Line 1 unit price', { exact: true }).fill('12.5');
    await capture(page, testInfo, 'order-defaults');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page).toHaveURL(/sales_order_detail/u);
    const header = page.locator('.composition-header');
    for (const text of ['USD', 'Priya Natarajan', 'Net 45'])
      await expect(header).toContainText(text);
    const orderUrl = page.url();

    // A complete ship-to: Confirm is offered, and the print names the address.
    await page.locator('.composition-record-actions > summary').click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Confirm complete');
    await page.goto(orderUrl);
    await page.getByRole('link', { name: 'Print sales order' }).click();
    const printed = page.locator('.print-block');
    await expect(printed.locator('h2')).toHaveText('Ship to');
    await expect(printed.locator('p')).toHaveText(
      'Whitecourt Forestry receiving726 Industrial WayWhitecourtABT7S 0A1Canada',
    );

    // The List names the salesperson and finds the order by that name.
    await page.goto(url);
    await expect(page.locator('thead')).toContainText('Salesperson');
    await page.locator('input[name="q"]').fill('Priya');
    await page.locator('input[name="q"]').press('Enter');
    await expect(page.getByText('1 matching record')).toBeVisible();
  });
});

test('without JavaScript, choosing a customer fills its defaults, and an incomplete ship-to withholds Confirm', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    await fixture(async (url) => {
      await page.goto(url);
      await page.getByRole('link', { name: 'New', exact: true }).click();
      await pick(page, 'Customer', 'Chestermere', 'Chestermere Dental Group');
      await expect(combo(page, 'Salesperson')).toHaveAttribute(
        'data-selected-label',
        'Jordan Blake',
      );
      await expect(page.getByLabel('Currency *')).toHaveValue('CAD');
      await expect(combo(page, 'Ship-to address')).toHaveAttribute(
        'data-selected-label',
        'Main delivery',
      );
      await expect(page.getByLabel('City', { exact: true })).toHaveValue(
        'Chestermere',
      );
      // The order's copy is its own: clearing the city here leaves the book.
      await page.getByLabel('City', { exact: true }).fill('');
      await page.getByLabel('Order date (UTC) *').fill('2026-09-28T12:00');
      await pick(page, 'Line 1 product', 'OFF-100', 'Field notebook');
      await page.getByLabel('Line 1 quantity', { exact: true }).fill('1');
      await page
        .getByRole('button', { name: 'Save draft', exact: true })
        .click();
      await expect(page).toHaveURL(/sales_order_detail/u);
      const commands = () =>
        page
          .locator(
            '[aria-label="Record commands"] button, [aria-label="Record commands"] a',
          )
          .evaluateAll((nodes) =>
            nodes.map((node) => (node.textContent ?? '').trim()),
          );
      expect(await commands()).toContain('Edit');
      expect(await commands()).not.toContain('Confirm');
      // Completing the ship-to offers Confirm again.
      await page.goto(
        new URL(
          (await page
            .locator('[aria-label="Record commands"] a', { hasText: 'Edit' })
            .getAttribute('href'))!,
          url,
        ).toString(),
      );
      await page.getByLabel('City', { exact: true }).fill('Chestermere');
      await page
        .getByRole('button', { name: 'Save draft', exact: true })
        .click();
      await expect(page).toHaveURL(/sales_order_detail/u);
      expect(await commands()).toContain('Confirm');
      await page.screenshot({
        path: testInfo.outputPath('confirm-offered-nojs-desktop.png'),
        fullPage: true,
      });
    });
  } finally {
    await context.close();
  }
});

function combo(page: Page, name: string) {
  return page.getByRole('combobox', { name, exact: true });
}
function field(page: Page, name: string) {
  return page
    .locator('[data-reference-field]')
    .filter({ has: combo(page, name) });
}
function records(page: Page, name: string) {
  return field(page, name)
    .getByRole('option')
    .filter({ has: page.locator('strong') });
}
/** Types into a picker and chooses a result, in place or by page answers. */
async function pick(page: Page, name: string, term: string, option: string) {
  await combo(page, name).fill(term);
  const enhanced =
    (await page.locator('body[data-reference-enhanced]').count()) > 0;
  if (!enhanced)
    await field(page, name)
      .getByRole('button', { name: 'Search', exact: true })
      .click();
  await records(page, name).filter({ hasText: option }).first().click();
  await expect(combo(page, name)).toHaveAttribute(
    'data-selected-label',
    option,
  );
}
async function shipTo(page: Page) {
  const value = (label: string) =>
    page.getByLabel(label, { exact: true }).inputValue();
  return {
    recipient: await value('Recipient'),
    street: await value('Street'),
    city: await value('City'),
    region: await value('Province or state'),
    postal: await value('Postal code'),
    country: await value('Country'),
  };
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

async function fixture(run: (url: string) => Promise<void>) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'test/helpers/order-entry-fixture.ts',
      '--serve',
      '--distributor',
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
