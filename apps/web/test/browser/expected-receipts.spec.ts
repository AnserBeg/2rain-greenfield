import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';
const column = (local: string) =>
  `${ns}:list_column.expected_receipt_list_${local}`;
const DAY = 86_400_000;

interface Seeded {
  readonly expected: string;
  readonly number: string;
  readonly recordId: string;
}
interface Scenario {
  readonly late: Seeded;
  readonly future: Seeded;
  readonly complete: Seeded;
  readonly draft: Seeded;
}

// PURCHASING-PARITY slice 4: what is still to arrive. Purchase orders are
// seeded through the governed operations (released with a partial receipt
// four days late, released for later, fully received, and a draft); the List
// is then read, filtered, opened and exported in the browser.
test('Expected receipts lists what is still to arrive, counts its tabs, marks the late order and opens it', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    const orders = await seed();
    await page.goto(url);
    // Purchasing is a group of its orders and its expected receipts.
    const navigation = page.getByRole('navigation', {
      name: 'Release navigation',
    });
    await navigation.getByText('Purchasing', { exact: true }).click();
    await navigation
      .getByRole('link', { name: 'Expected receipts', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Expected receipts', level: 1 }),
    ).toBeVisible();
    await expect(
      navigation.getByRole('link', { name: 'Expected receipts', exact: true }),
    ).toHaveAttribute('aria-current', 'page');

    // Tabs are server counts: two orders have something open, one of them
    // late; three are released.
    const views = page.getByRole('navigation', { name: 'Views' });
    await expect(
      views.getByRole('link', { name: 'To receive 2' }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(views.getByRole('link', { name: 'Late 1' })).toBeVisible();
    await expect(
      views.getByRole('link', { name: 'All released 3' }),
    ).toBeVisible();
    await expect(page.getByText('2 matching records')).toBeVisible();
    await expect(page.getByText(orders.complete.number)).toHaveCount(0);
    await expect(page.getByText(orders.draft.number)).toHaveCount(0);

    // The late order: its units across both lines, and its date marked with
    // the days it is late, counted from the day the page compared with.
    const row = page.locator(`tr[data-record-id="${orders.late.recordId}"]`);
    const cell = (local: string) =>
      row.locator(`td[data-column-id="${column(local)}"]`);
    await expect(cell('ordered')).toHaveText('15');
    await expect(cell('received')).toHaveText('4');
    await expect(cell('open')).toHaveText('11');
    const anchor = await page
      .locator('[data-declared-list="true"]')
      .getAttribute('data-list-anchor');
    const expected = new Date(orders.late.expected);
    const days = Math.round(
      (Date.parse(anchor!) -
        Date.UTC(
          expected.getUTCFullYear(),
          expected.getUTCMonth(),
          expected.getUTCDate(),
        )) /
        DAY,
    );
    await expect(cell('expected_date')).toContainText(
      `${String(days)} ${days === 1 ? 'day' : 'days'} late`,
    );
    await expect(page.locator('[data-overdue-days]')).toHaveCount(1);
    // A figure is shown, not offered as a sort.
    await expect(
      page.locator(`[data-sort-column="${column('open')}"]`),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('expected-receipts-to-receive.png'),
    });

    // The Late tab by keyboard: only the late order.
    await views.getByRole('link', { name: 'Late 1' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('1 matching record')).toBeVisible();
    await expect(row).toBeVisible();

    // Export the To receive tab: one file holding each open order.
    await views.getByRole('link', { name: /^To receive/ }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export CSV (2)' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(
      /^expected-receipts-\d{4}-\d{2}-\d{2}\.csv$/u,
    );
    const csv = (await readFile((await file.path())!, 'utf8'))
      .replace(/^\uFEFF/u, '')
      .trimEnd()
      .split('\r\n');
    expect(csv[0]).toBe(
      'Number,Supplier,Expected,Ordered,Received,Open,Currency',
    );
    expect(csv.length - 1).toBe(2);
    expect(
      csv.some(
        (line) =>
          line.startsWith(`${orders.late.number},`) &&
          line.endsWith(',15,4,11,CAD'),
      ),
    ).toBe(true);

    // All released includes the order with nothing left, at zero open.
    await views.getByRole('link', { name: /^All released/ }).click();
    await expect(page.getByText('3 matching records')).toBeVisible();
    await expect(
      page
        .locator(`tr[data-record-id="${orders.complete.recordId}"]`)
        .locator(`td[data-column-id="${column('open')}"]`),
    ).toHaveText('0');

    // Opening a row opens the purchase order itself.
    await page
      .getByRole('link', {
        name: `Open Expected receipts ${orders.late.number}`,
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/purchase_order_detail/u);
    expect(new URL(page.url()).searchParams.get('record')).toBe(
      orders.late.recordId,
    );
    await expect(page.locator('.composition-header h1')).toHaveText(
      orders.late.number,
    );
    await capturePhone(
      page,
      testInfo.outputPath('expected-receipts-order.png'),
    );
  });
});

async function capturePhone(page: Page, path: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
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
      child.stdin.write(`${JSON.stringify({ phase: 'expected_receipts' })}\n`);
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
