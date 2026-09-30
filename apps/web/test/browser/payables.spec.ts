import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

interface Seeded {
  readonly number: string;
  readonly recordId: string;
}

// PAYABLES through the declared workspaces: the order-entry fixture seeds a
// released purchase order of 3 EA of Field notebook at a unit cost of 12.50
// less 10%, taxed at 5%, with freight of 25 (taxed) and an untaxed fee of 10,
// two of its three units received.
test('a received purchase order is billed, paid in part and credited for the rest; the order lists its bill', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, seed) => {
    const order = await seed();
    const dataset = (name: string) =>
      page.locator(`[data-composition-dataset$="dataset.${name}"]`);
    const fact = (label: string) =>
      page
        .locator('.composition-header-facts div')
        .filter({ has: page.locator('dt', { hasText: label }) })
        .locator('dd');
    const finish = async (label: string) => {
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: `Review ${label}` }).click();
      await dialog.getByRole('button', { name: `Confirm ${label}` }).click();
      await expect(page.getByRole('status').first()).toContainText(
        `${label}: done`,
      );
    };
    const billTask = () =>
      page.getByRole('button', {
        name: 'Bill received quantities',
        exact: true,
      });

    // Purchasing lists its bills beside its orders.
    await page.goto(url);
    const navigation = page.getByRole('navigation', {
      name: 'Release navigation',
    });
    await navigation.getByText('Purchasing', { exact: true }).click();
    await expect(navigation.locator('a', { hasText: 'Bills' })).toBeVisible();
    await navigation
      .getByRole('link', { name: 'Purchase orders', exact: true })
      .click();
    await page
      .getByRole('link', {
        name: `Open Purchase orders ${order.number}`,
        exact: true,
      })
      .click();
    await expect(page.locator('.composition-header h1')).toHaveText(
      order.number,
    );
    const orderUrl = page.url();

    // Bill the two received units at the order's frozen cost, with the
    // supplier's own invoice number: 2 × 12.50 less 10% = 22.50, tax 1.13,
    // freight 25 (+1.25) and the fee of 10 on this first bill: 59.88.
    await billTask().click();
    await page
      .getByLabel('Supplier invoice number', { exact: true })
      .fill('INV-5501');
    await finish('Bill received quantities');
    await page.goto(orderUrl);
    const bills = dataset('purchasing_bills').locator('tbody tr');
    await expect(bills).toHaveCount(1);
    await expect(bills.first()).toContainText(/BILL-\d{6}/u);
    await expect(
      bills.first().locator('td[data-column-label="State"]'),
    ).toHaveText('Open');
    await expect(
      bills.first().locator('td[data-column-label="Total"]'),
    ).toHaveText('59.88');
    await expect(
      bills.first().locator('td[data-column-label="Supplier invoice"]'),
    ).toHaveText('INV-5501');
    // Everything received is billed, so the task is no longer offered.
    await expect(billTask()).toHaveCount(0);
    // The line's three-way match (PY-G): 3 ordered, 2 received and 2 billed,
    // nothing left to bill.
    const line = dataset('purchasing_lines').locator('tbody tr').first();
    await expect(line.locator('td[data-column-label="Received"]')).toHaveText(
      '2',
    );
    await expect(line.locator('td[data-column-label="Billed"]')).toHaveText(
      '2',
    );
    await expect(line.locator('td[data-column-label="To bill"]')).toHaveText(
      '0',
    );
    await expect(line).toContainText('Matched');
    await capture(page, testInfo, 'order-billed');

    // The bill: its frozen figures, its line and its balance.
    await bills
      .first()
      .getByRole('link', { name: 'Open bill', exact: true })
      .click();
    const billUrl = page.url();
    await expect(page.locator('.composition-header h1')).toHaveText(
      /BILL-\d{6}/u,
    );
    await expect(fact('Total')).toHaveText('59.88');
    await expect(fact('Balance')).toHaveText('59.88');
    await expect(fact('Supplier invoice number')).toHaveText('INV-5501');
    // The bill names its order (PAYABLES increment 3).
    await expect(fact('Purchase order')).toHaveText(order.number);
    await expect(fact('Due date')).not.toHaveText('');
    const lines = dataset('bill_lines').locator('tbody tr');
    await expect(lines).toHaveCount(1);
    await expect(
      lines.first().locator('td[data-column-label="Quantity"]'),
    ).toHaveText('2');
    await expect(
      lines.first().locator('td[data-column-label="Amount"]'),
    ).toHaveText('22.50');

    // A payment above the balance is refused and changes nothing.
    await page
      .getByRole('button', { name: 'Record payment', exact: true })
      .click();
    await page.getByLabel('Amount paid', { exact: true }).fill('60');
    await page
      .getByLabel('Reference (cheque or transaction number)')
      .fill('CHQ-3300');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Review Record payment' })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirm Record payment' })
      .click();
    await expect(page.locator('[data-message-subject]').first()).toHaveText(
      'PAYABLES_AMOUNT_EXCEEDS_BALANCE',
    );
    await page.goto(billUrl);
    await expect(fact('Balance')).toHaveText('59.88');

    // Pay part by cheque.
    await page
      .getByRole('button', { name: 'Record payment', exact: true })
      .click();
    await page.getByLabel('Amount paid', { exact: true }).fill('20');
    await page.getByLabel('Method').selectOption({ label: 'Cheque' });
    await page
      .getByLabel('Reference (cheque or transaction number)')
      .fill('CHQ-3301');
    await finish('Record payment');
    await page.goto(billUrl);
    await expect(fact('Balance')).toHaveText('39.88');
    await expect(page.locator('.composition-header')).toContainText(
      'Partially paid',
    );
    await expect(dataset('bill_payments').locator('tbody tr')).toContainText([
      /VPAY-\d{6}.*Posted.*20.*Cheque.*CHQ-3301/su,
    ]);
    // Void is offered only while nothing is paid or credited.
    await expect(
      page.getByRole('button', { name: 'Void bill', exact: true }),
    ).toHaveCount(0);

    // The vendor credits the rest.
    await page
      .getByRole('button', { name: 'Record vendor credit', exact: true })
      .click();
    await page.getByLabel('Amount credited', { exact: true }).fill('39.88');
    await page
      .getByLabel('Reason', { exact: true })
      .fill('Price correction agreed with the vendor');
    await finish('Record vendor credit');
    await page.goto(billUrl);
    await expect(fact('Balance')).toHaveText('0.00');
    await expect(page.locator('.composition-header')).toContainText('Paid');
    await expect(dataset('bill_credits').locator('tbody tr')).toContainText([
      /VCM-\d{6}.*Posted.*39\.88.*Price correction/su,
    ]);
    // A settled bill offers no further payment or credit.
    await expect(
      page.getByRole('button', { name: 'Record payment', exact: true }),
    ).toHaveCount(0);
    await capture(page, testInfo, 'bill-settled');

    // The way back to the order, from wherever the bill was opened.
    await page
      .getByRole('link', { name: 'Open purchase order', exact: true })
      .click();
    await expect(page.locator('.composition-header h1')).toHaveText(
      order.number,
    );
    await page.goto(billUrl);

    // The printable bill: every figure.
    await page.getByRole('link', { name: 'Print vendor bill' }).click();
    const totals = page.locator('.print-totals');
    for (const [label, value] of [
      ['Total', '59.88'],
      ['Paid', '20.00'],
      ['Credited', '39.88'],
      ['Balance', '0.00'],
    ] as const)
      await expect(
        totals
          .locator('div')
          .filter({
            has: page.locator('dt', { hasText: new RegExp(`^${label}$`, 'u') }),
          })
          .locator('dd'),
      ).toHaveText(value);

    // The order still lists its bill, now paid.
    await page.goto(orderUrl);
    await expect(bills).toHaveCount(1);
    await expect(
      bills.first().locator('td[data-column-label="State"]'),
    ).toHaveText('Paid');
    await expect(
      bills.first().locator('td[data-column-label="Balance"]'),
    ).toHaveText('0.00');

    // The Bills List: one tab per state, the vendor by name.
    const billList = new URL(orderUrl);
    billList.search = '';
    billList.searchParams.set(
      'surface',
      'northstar.app:surface.vendor_bill_list',
    );
    await page.goto(billList.toString());
    await expect(
      page.getByRole('heading', { name: 'Bills', level: 1 }),
    ).toBeVisible();
    const views = page.getByRole('navigation', { name: 'Views' });
    await expect(views.getByRole('link', { name: 'All 1' })).toBeVisible();
    await expect(views.getByRole('link', { name: 'Paid 1' })).toBeVisible();
    await expect(views.getByRole('link', { name: 'Open 0' })).toBeVisible();
    await expect(page.locator('main')).toContainText('Alpine Office Supply');
    await expect(page.locator('main')).toContainText('INV-5501');
    await capture(page, testInfo, 'bill-list');
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
 * The order-entry fixture, served with `--verify` so the purchase order is
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
      child.stdin.write(`${JSON.stringify({ phase: 'payables' })}\n`);
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
