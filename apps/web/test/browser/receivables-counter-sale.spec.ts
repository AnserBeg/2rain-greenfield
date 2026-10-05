import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';

interface Seeded {
  readonly number: string;
  readonly recordId: string;
  readonly location: string;
  readonly scope: string;
}

// SALES-EXTRAS counter sale through the declared order page: the order-entry
// fixture seeds a draft sales order for the demo customer of two lines of the
// Field notebook, 3 and 2 EA at 12.50 untaxed -- 62.50 -- with a complete
// ship-to; the Calgary warehouse holds 10 on hand.
test('a counter sale confirms, ships, invoices and takes payment in one Task, and the order reads as a counter sale', async ({
  page,
}, testInfo) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    const order = await seed();
    const dialog = page.getByRole('dialog');
    const dataset = (name: string) =>
      page.locator(`[data-composition-dataset$="dataset.${name}"]`);
    const detail = (label: string) =>
      page
        .locator('[data-composition-fields] .record-fields > div')
        .filter({
          has: page.locator('dt', { hasText: new RegExp(`^${label}$`, 'u') }),
        })
        .locator('dd');
    // A document is opened in its company, as its List links it.
    const orderPage = new URL(url);
    orderPage.search = '';
    orderPage.searchParams.set('surface', `${ns}:surface.sales_order_detail`);
    orderPage.searchParams.set(
      `${ns}:parameter.commercial_order_get_legal_entity_scope`,
      order.scope,
    );
    orderPage.searchParams.set('record', order.recordId);
    await page.goto(orderPage.toString());
    await expect(page.locator('.composition-header h1')).toHaveText(
      order.number,
    );
    await expect(page.locator('.composition-header')).toContainText('Draft');

    // One Task: ship from the warehouse, paid by cheque.
    const label = 'Counter sale: take payment';
    const action = page.getByRole('button', { name: label, exact: true });
    if (!(await action.isVisible()))
      await page.locator('.composition-record-actions > summary').click();
    await action.click();
    await expect(dialog.locator('[data-task-row]')).toHaveCount(2);
    await dialog
      .getByLabel('Ship from')
      .selectOption({ label: 'Calgary warehouse' });
    await dialog.getByLabel('Paid by').selectOption({ label: 'Cheque' });
    await dialog.getByLabel('Reference (cheque number)').fill('CHQ-1042');
    await capture(page, testInfo, 'counter-sale-task');
    await dialog.getByRole('button', { name: `Review ${label}` }).click();
    await dialog.getByRole('button', { name: `Confirm ${label}` }).click();
    await expect(page.getByRole('status').first()).toContainText(
      `${label}: done`,
    );

    // The order is confirmed and marked; it shipped and is paid in full.
    await page.goto(orderPage.toString());
    await expect(page.locator('.composition-header')).toContainText('Released');
    await expect(detail('Counter sale')).toHaveText('Yes');
    const shipment = dataset('order_shipments').locator('tbody tr');
    await expect(shipment).toHaveCount(1);
    await expect(
      shipment.locator('td[data-column-label="Carrier"]'),
    ).toHaveText('Counter');
    // The shipment's states are labelled by their values.
    await expect(shipment.locator('td[data-column-label="State"]')).toHaveText(
      'posted',
    );
    const invoice = dataset('order_invoices').locator('tbody tr');
    await expect(invoice).toHaveCount(1);
    await expect(invoice.locator('td[data-column-label="State"]')).toHaveText(
      'Paid',
    );
    await expect(invoice.locator('td[data-column-label="Total"]')).toHaveText(
      '62.50',
    );
    await expect(invoice.locator('td[data-column-label="Balance"]')).toHaveText(
      '0.00',
    );
    // No counter Task is offered once the order is confirmed.
    await expect(
      page.locator(
        `[name="compositionAction"][value="${ns}:action.counter_sale_paid"]`,
      ),
    ).toHaveCount(0);
    await capture(page, testInfo, 'counter-sale-order');

    // The Sales orders List shows it on its Counter sales tab.
    await page.goto(url);
    const tab = page.locator(
      `[data-view-id="${ns}:list_view.sales_order_list_counter"]`,
    );
    await expect(tab.locator('.list-view__count')).toHaveText('1');
    await tab.click();
    await expect(tab).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('tbody tr[data-record-id]')).toHaveCount(1);
    await expect(
      page.locator(`tr[data-record-id="${order.recordId}"]`),
    ).toContainText(order.number);
  });
});

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
 * The order-entry fixture, served with `--verify` so the draft order is
 * seeded through its own governed operations once the application is up.
 */
async function fixture(
  run: (url: string, seed: () => Promise<Seeded>) => Promise<void>,
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
  let seeded: ((value: Seeded) => void) | null = null;
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
            JSON.parse(line.slice('ORDER_ENTRY_MEASURED='.length)) as Seeded,
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
    new Promise<Seeded>((resolve, reject) => {
      seeded = resolve;
      child.once('exit', () => reject(new Error(output)));
      child.stdin.write(`${JSON.stringify({ phase: 'counter_order' })}\n`);
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
