import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';

interface Seeded {
  readonly number: string;
  readonly recordId: string;
  readonly customer: string;
  readonly scope: string;
}

// SALES-EXTRAS credit control through the declared workspaces: the
// order-entry fixture seeds a draft sales order for the demo customer of
// 4 EA at 12.50, taxed 5% -- 52.50 -- with a complete ship-to.
test('a customer on credit hold or over its limit has no order confirmed; both pages show the credit', async ({
  page,
}, testInfo) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    const order = await seed();
    const dialog = page.getByRole('dialog');
    const customerPage = new URL(url);
    customerPage.search = '';
    customerPage.searchParams.set('surface', `${ns}:surface.party_detail`);
    customerPage.searchParams.set('record', order.customer);
    const fact = (label: string) =>
      page
        .locator('.composition-header-facts div')
        .filter({ has: page.locator('dt', { hasText: label }) })
        .locator('dd');
    const detail = (label: string) =>
      page
        .locator('[data-composition-fields] .record-fields > div')
        .filter({
          has: page.locator('dt', { hasText: new RegExp(`^${label}$`, 'u') }),
        })
        .locator('dd');
    const finish = async (label: string) => {
      await dialog.getByRole('button', { name: `Review ${label}` }).click();
      await dialog.getByRole('button', { name: `Confirm ${label}` }).click();
      await expect(page.getByRole('status').first()).toContainText(
        `${label}: done`,
      );
    };
    const confirmOrder = async () => {
      await page.locator('.composition-record-actions > summary').click();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    };

    // No limit yet: the customer's page says so.
    await page.goto(customerPage.toString());
    await expect(fact('Credit')).toHaveText('No limit');
    await expect(detail('Open balance')).toHaveText('0.00');

    // A limit of 40.00 in the customer's currency.
    await page
      .getByRole('button', { name: 'Set credit limit', exact: true })
      .click();
    await dialog.getByLabel('Credit limit (0 for none)').fill('40');
    await expect(dialog.getByLabel('Currency')).toHaveValue(
      `${ns}:option.party_default_currency_cad`,
    );
    await finish('Set credit limit');
    await page.goto(customerPage.toString());
    await expect(fact('Credit')).toHaveText('Within limit');
    await expect(detail('Credit limit')).toHaveText('40.00');
    await expect(detail('Available credit')).toHaveText('40.00');
    await capture(page, testInfo, 'customer-credit');

    // The order's 52.50 would take the customer 12.50 over its limit.
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
    await expect(detail('Credit')).toHaveText('Within limit');
    await expect(detail('Available credit')).toHaveText('40.00');
    await confirmOrder();
    await expect(page.locator('[data-message-subject]').first()).toHaveText(
      'CREDIT_LIMIT_EXCEEDED',
    );
    await page.goto(orderPage.toString());
    await expect(page.locator('.composition-header')).toContainText('Draft');

    // A hold refuses the confirmation by name, whatever the limit.
    await page.goto(customerPage.toString());
    await page
      .getByRole('button', { name: 'Put on credit hold', exact: true })
      .click();
    await finish('Put on credit hold');
    await page.goto(customerPage.toString());
    await expect(fact('Credit')).toHaveText('On hold');
    await expect(
      page.getByRole('button', { name: 'Put on credit hold', exact: true }),
    ).toHaveCount(0);
    await page.goto(orderPage.toString());
    await expect(detail('Credit')).toHaveText('On hold');
    await confirmOrder();
    await expect(page.locator('[data-message-subject]').first()).toHaveText(
      'CREDIT_HOLD',
    );

    // Released, and with room under a limit of 100.00, it confirms.
    await page.goto(customerPage.toString());
    await page
      .getByRole('button', { name: 'Release credit hold', exact: true })
      .click();
    await finish('Release credit hold');
    await page.goto(customerPage.toString());
    await page
      .getByRole('button', { name: 'Set credit limit', exact: true })
      .click();
    await dialog.getByLabel('Credit limit (0 for none)').fill('100');
    await finish('Set credit limit');
    await page.goto(orderPage.toString());
    await confirmOrder();
    await expect(page.getByRole('status')).toContainText('Confirm complete');
    await page.goto(orderPage.toString());
    await expect(detail('Confirmed, not invoiced')).toHaveText('52.50');
    await expect(detail('Available credit')).toHaveText('47.50');
    await capture(page, testInfo, 'order-credit');
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
      child.stdin.write(`${JSON.stringify({ phase: 'credit_order' })}\n`);
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
