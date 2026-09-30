import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';
/** Field notebook, the demo seed's first product. */
const FIELD_NOTEBOOK = '71000000-0000-4000-8000-000000000011';

interface Line {
  readonly from?: string;
  readonly to?: string;
  readonly quantity: string;
}
interface Document {
  readonly type: 'Adjustment' | 'Transfer';
  readonly reason: string;
  readonly narrative?: string;
  readonly line: Line;
}

// INVENTORY-PARITY: stock documents. Before each journey the fixture moves
// Field notebook's stock through the governed operations: Calgary warehouse
// holds 13 with 1 still reserved for a sales order, Vancouver warehouse 6.
// Every document is then entered from the menu, the way a person enters one.
test('an adjustment is entered like a document, numbered on save, and posted or refused by name', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    await seed();
    await page.goto(url);
    expect(await stock(page)).toEqual({ 'CAL-WH': '13', 'VAN-WH': '6' });

    // Inventory -> Inventory transactions -> New: the editor opens with an
    // Adjustment dated now -- a time of today, not midnight (ruling INV-A);
    // the control drops a zero seconds field -- and nothing for the number,
    // state or source.
    await openNew(page);
    await expect(page.getByLabel('Type *', { exact: true })).toHaveValue(
      `${ns}:option.inventory_transaction_type_adjustment`,
    );
    await expect(
      page.getByLabel('Effective date (UTC) *', { exact: true }),
    ).toHaveValue(
      new RegExp(
        `^${new Date().toISOString().slice(0, 10)}T\\d{2}:\\d{2}(?::\\d{2})?$`,
      ),
    );
    for (const local of ['number', 'state', 'source_type', 'source_id'])
      await expect(
        page.locator(`[name$=":${ns}:field.inventory_transaction_${local}"]`),
      ).toHaveCount(0);
    await enter(page, {
      type: 'Adjustment',
      reason: 'Damaged',
      narrative: 'Forklift damage',
      line: { from: 'Calgary warehouse', quantity: '-2' },
    });
    await expect(
      page.getByRole('status', { name: 'Line 1 unit', exact: true }),
    ).toHaveText('EA');
    await page.screenshot({
      path: testInfo.outputPath('stock-document-editor.png'),
      fullPage: true,
    });
    const damaged = await saveDraft(page);
    await command(page, 'Post');
    // The document's movement carries its reason; stock drops by two.
    expect(
      (
        await rows(
          page.locator(
            `[data-composition-dataset="${ns}:dataset.inventory_transaction_inventory_movement"]`,
          ),
        )
      ).map((row) => [row.Location, row['Quantity change'], row.Reason]),
    ).toEqual([['Calgary warehouse', '-2', 'DAMAGED']]);
    await page.screenshot({
      path: testInfo.outputPath('stock-document-posted.png'),
      fullPage: true,
    });
    expect(await stock(page)).toEqual({ 'CAL-WH': '11', 'VAN-WH': '6' });

    // Found stock entered in From: saved as a draft, refused at Post.
    await openNew(page);
    await enter(page, {
      type: 'Adjustment',
      reason: 'Found',
      line: { from: 'Calgary warehouse', quantity: '3' },
    });
    const addedInFrom = await saveDraft(page);
    expect(addedInFrom).not.toBe(damaged);
    await refused(page, 'INVENTORY_POSTING_INPUT_INVALID');

    // More than is on hand: the posting's own refusal.
    await openNew(page);
    await enter(page, {
      type: 'Adjustment',
      reason: 'Lost',
      line: { from: 'Calgary warehouse', quantity: '-999' },
    });
    await saveDraft(page);
    await refused(page, 'INVENTORY_STOCK_NEGATIVE');
    expect(await stock(page)).toEqual({ 'CAL-WH': '11', 'VAN-WH': '6' });
  });
});

test('a transfer moves unreserved stock, and opening stock goes only where there is none, through the same Post', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    await seed();
    await page.goto(url);

    // Five from Vancouver to the Edmonton store: one document, two transfer
    // movements, out of one location and into the other.
    await openNew(page);
    await enter(page, {
      type: 'Transfer',
      reason: 'Relocation',
      line: {
        from: 'Vancouver warehouse',
        to: 'Edmonton store',
        quantity: '5',
      },
    });
    await saveDraft(page);
    await command(page, 'Post');
    expect(
      (
        await rows(
          page.locator(
            `[data-composition-dataset="${ns}:dataset.inventory_transaction_inventory_movement"]`,
          ),
        )
      )
        .map((row) => [row.Location, row['Quantity change'], row.Reason])
        .sort(),
    ).toEqual([
      ['Edmonton store', '5', 'RELOCATION'],
      ['Vancouver warehouse', '-5', 'RELOCATION'],
    ]);
    await page.screenshot({
      path: testInfo.outputPath('stock-transfer-posted.png'),
      fullPage: true,
    });
    expect(await stock(page)).toEqual({
      'CAL-WH': '13',
      'EDM-ST': '5',
      'VAN-WH': '1',
    });

    // Calgary's one reserved unit stays: moving all thirteen is refused.
    await openNew(page);
    await enter(page, {
      type: 'Transfer',
      reason: 'Relocation',
      line: { from: 'Calgary warehouse', to: 'Beltline store', quantity: '13' },
    });
    await saveDraft(page);
    await refused(page, 'FULFILLMENT_RESERVATION_SHORTAGE');

    // Opening stock: twenty into the Beltline store, which has none.
    await openNew(page);
    await enter(page, {
      type: 'Adjustment',
      reason: 'Opening stock',
      line: { to: 'Beltline store', quantity: '20' },
    });
    await saveDraft(page);
    await command(page, 'Post');
    // ... and never into a location that already holds the item.
    await openNew(page);
    await enter(page, {
      type: 'Adjustment',
      reason: 'Opening stock',
      line: { to: 'Calgary warehouse', quantity: '5' },
    });
    await saveDraft(page);
    await refused(page, 'INVENTORY_POSTING_INPUT_INVALID');
    expect(await stock(page)).toEqual({
      'CAL-WH': '13',
      'EDM-ST': '5',
      'VAN-WH': '1',
      'YYC-ST': '20',
    });
  });
});

/** Inventory -> Inventory transactions -> New, from the menu. */
async function openNew(page: Page) {
  const inventory = page
    .getByRole('navigation', { name: 'Release navigation' })
    .locator('.navigation-tree > li')
    .getByRole('group')
    .filter({ hasText: 'Inventory' });
  const transactions = inventory.getByRole('link', {
    name: 'Inventory transactions',
    exact: true,
  });
  // A group already open on this page stays open; clicking it would close it.
  if (!(await transactions.isVisible()))
    await inventory.getByText('Inventory', { exact: true }).click();
  await transactions.click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Inventory transactions' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'New', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'New Inventory transaction' }),
  ).toBeVisible();
}

/**
 * The header and one line. The Effective date is left as the editor dates a
 * new document -- now (ruling INV-A) -- so a document that takes stock is not
 * dated before the stock it takes, which the fixture received today.
 */
async function enter(page: Page, document: Document) {
  await page
    .getByLabel('Type *', { exact: true })
    .selectOption({ label: document.type });
  await page
    .getByLabel('Reason', { exact: true })
    .selectOption({ label: document.reason });
  await page
    .getByLabel('Narrative', { exact: true })
    .fill(document.narrative ?? `${document.reason} in the browser`);
  await pick(page, 'Line 1 product', 'OFF-100', 'Field notebook');
  if (document.line.from)
    await pick(
      page,
      'Line 1 from location',
      document.line.from.split(' ')[0]!,
      document.line.from,
    );
  if (document.line.to)
    await pick(
      page,
      'Line 1 to location',
      document.line.to.split(' ')[0]!,
      document.line.to,
    );
  await page
    .getByLabel('Line 1 quantity', { exact: true })
    .fill(document.line.quantity);
}

/** Save draft opens the saved document, numbered by the server. */
async function saveDraft(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page).toHaveURL(/inventory_transaction_detail/u);
  const header = page.locator('.composition-header');
  await expect(header).toContainText(/STK-\d{6}/u);
  return /STK-\d{6}/u.exec(await header.innerText())![0];
}

/** A confirmed command on the saved document. */
async function command(page: Page, label: string) {
  const secondary = page.locator(
    '.composition-record-actions:not([open]) > summary',
  );
  if (await secondary.count()) await secondary.click();
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(
    page.getByRole('heading', { name: `Confirm ${label}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: `Confirm ${label}`, exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(`${label} complete`);
}

/** Post, confirmed and refused: the refusal names its code. */
async function refused(page: Page, code: string) {
  const secondary = page.locator(
    '.composition-record-actions:not([open]) > summary',
  );
  if (await secondary.count()) await secondary.click();
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Post', exact: true }).click();
  await expect(page.locator('[data-message-subject]')).toHaveText(code);
}

/**
 * Types into a picker and chooses an offered record -- in place with the
 * owned script, as ordinary submits without it -- then waits for the field to
 * show the selection.
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

/** Field notebook's on hand by location code, as its item page shows it. */
async function stock(page: Page): Promise<Record<string, string>> {
  const url = new URL(page.url());
  await page.goto(
    `${url.origin}/?${new URLSearchParams({
      surface: `${ns}:surface.item_detail`,
      record: FIELD_NOTEBOOK,
    }).toString()}`,
  );
  await expect(
    page.getByRole('heading', { level: 1, name: 'Field notebook' }),
  ).toBeVisible();
  return Object.fromEntries(
    (
      await rows(
        page.locator(`[data-composition-dataset="${ns}:dataset.item_stock"]`),
      )
    )
      .map((row) => [row.Location!, row['On hand']!] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

/** Each row of a section as its column labels and shown values. */
async function rows(section: Locator) {
  return section
    .locator('tr[data-record-id]')
    .evaluateAll((elements) =>
      elements.map(
        (row) =>
          Object.fromEntries(
            [...row.querySelectorAll('td[data-column-label]')].map((cell) => [
              cell.getAttribute('data-column-label')!,
              (cell.querySelector('strong') ?? cell).textContent!.trim(),
            ]),
          ) as Record<string, string>,
      ),
    );
}

/**
 * The order-entry fixture, served with `--verify` so the item page's stock
 * scenario is seeded through its own governed operations once the
 * application is up.
 */
async function fixture(
  run: (url: string, seed: () => Promise<unknown>) => Promise<void>,
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
  const seed = () =>
    new Promise<unknown>((resolve, reject) => {
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
