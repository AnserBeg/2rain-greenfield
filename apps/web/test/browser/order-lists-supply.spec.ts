import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';
const salesColumn = (local: string) =>
  `${ns}:list_column.sales_order_list_${local}`;

interface Seeded {
  readonly number: string;
  readonly recordId: string;
  readonly lines: readonly string[];
}
interface Scenario {
  readonly orders: {
    readonly elsewhere: Seeded;
    readonly held: Seeded;
    readonly part: Seeded;
    readonly short: Seeded;
    readonly fine: Seeded;
    readonly draft: Seeded;
  };
}

// SUPPLY-WARNINGS: the Sales orders List says which confirmed orders wait
// for supply and which hold reserved stock still to ship, marks what each
// order is short, and leads a reserved order to its shipments. The orders
// are seeded through the governed operations (stock moved into a quarantined
// location, reservations here, elsewhere and in quarantine, a part shipment,
// two lines sharing the free stock and a draft); the List is then read,
// filtered and followed in the browser, by keyboard and at phone width.
test('the Sales orders List counts Blocked by supply and Reserved, marks each order short and opens a reserved order at its shipments, by keyboard and at phone width', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    const { short, draft, fine, elsewhere, held, part } = (await seed()).orders;
    await page.goto(url);
    await expect(
      page.getByRole('heading', { name: 'Sales orders', level: 1 }),
    ).toBeVisible();
    const views = page.getByRole('navigation', { name: 'Views' });
    const row = (seeded: Seeded) =>
      page.locator(`tr[data-record-id="${seeded.recordId}"]`);
    const cell = (seeded: Seeded, local: string) =>
      row(seeded).locator(`td[data-column-id="${salesColumn(local)}"]`);

    // Blocked by supply, by keyboard: only the confirmed order its free
    // stock cannot cover -- 20 and 10 asked, 4 reserved, 17 free: 9 short.
    await views.getByRole('link', { name: 'Blocked by supply 1' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('1 matching record')).toBeVisible();
    await expect(row(short)).toBeVisible();
    await expect(cell(short, 'short')).toContainText('9');
    await expect(
      cell(short, 'short').locator('[data-short-mark="true"]'),
    ).toHaveText('!Short of stock');
    await expect(cell(short, 'open')).toHaveText('30');
    // A figure is shown, not offered as a sort.
    await expect(
      page.locator(`[data-sort-column="${salesColumn('short')}"]`),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('order-lists-supply-blocked.png'),
    });

    // Reserved: every confirmed order holding reserved stock still to ship
    // -- here, elsewhere, in quarantine, after a part shipment -- each
    // offering "Post shipment".
    await views.getByRole('link', { name: 'Reserved 4' }).click();
    await expect(page.getByText('4 matching records')).toBeVisible();
    for (const seeded of [short, elsewhere, held, part])
      await expect(
        page.getByRole('link', {
          name: `Post shipment ${seeded.number}`,
          exact: true,
        }),
      ).toBeVisible();
    await expect(row(fine)).toHaveCount(0);
    const post = page.getByRole('link', {
      name: `Post shipment ${short.number}`,
      exact: true,
    });
    await atPhoneWidth(
      page,
      testInfo.outputPath('order-lists-supply-reserved-phone.png'),
      async () => {
        await expect(post).toBeVisible();
        await expect(cell(short, 'short')).toBeVisible();
        await expect(
          cell(short, 'short').locator('[data-short-mark="true"]'),
        ).toBeVisible();
      },
    );

    // The row's action by keyboard: the order, at its fulfillment section,
    // where its own Task ships reserved stock. The page names the same
    // shortage the List counted: line 2 is 9 short.
    await post.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/sales_order_detail/u);
    const opened = new URL(page.url());
    expect(opened.searchParams.get('record')).toBe(short.recordId);
    expect(decodeURIComponent(opened.hash)).toBe(
      `#${ns}:dataset.fulfillment_lines`,
    );
    await expect(page.locator('.composition-header h1')).toHaveText(
      short.number,
    );
    const fulfillment = page.locator(
      `section[data-composition-dataset="${ns}:dataset.fulfillment_lines"]`,
    );
    await expect(fulfillment).toBeInViewport();
    await expect(
      fulfillment
        .locator(`tr[data-record-id="${short.lines[1]!}"]`)
        .locator('td[data-column-label="Short"]'),
    ).toHaveText('9');
    await expect(page.locator('.composition-alert')).toContainText(
      'Fulfillment exception',
    );
    await page.screenshot({
      path: testInfo.outputPath('order-lists-supply-order-page.png'),
    });

    // All orders: the order with enough free stock offers its work, the
    // draft is short too -- as its page says -- but offers only its page.
    await page.goBack();
    await views.getByRole('link', { name: /^All/ }).click();
    await expect(page.getByText('6 matching records')).toBeVisible();
    await expect(
      page.getByRole('link', { name: `Fulfill ${fine.number}`, exact: true }),
    ).toBeVisible();
    await expect(cell(fine, 'short')).toHaveText('0');
    await expect(cell(draft, 'short')).toContainText('13');
    await expect(
      cell(draft, 'short').locator('[data-short-mark="true"]'),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: `View ${draft.number}`, exact: true }),
    ).toBeVisible();
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
      child.stdin.write(`${JSON.stringify({ phase: 'supply' })}\n`);
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
