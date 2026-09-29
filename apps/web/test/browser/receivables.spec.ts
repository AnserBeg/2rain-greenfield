import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// Ruling C through the declared workspaces: the metadata-sales fixture serves
// a confirmed order of 10 EA of Field notebook at 12.50, untaxed, with stock
// at the Calgary warehouse.
test('a shipped order is invoiced, paid in part, credited, printed and voided through declared workspaces', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (orderUrl) => {
    const task = () => page.locator('[data-composition-task]');
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
    const reserveAndShip = async (reserve: string | null, ship: string) => {
      // Reservations show for the selected line.
      await dataset('fulfillment_lines')
        .getByRole('link', { name: 'Select', exact: true })
        .click();
      if (reserve) {
        await page
          .getByRole('button', { name: 'Reserve stock', exact: true })
          .click();
        await page
          .getByLabel('Quantity to reserve', { exact: true })
          .fill(reserve);
        await page
          .getByLabel('Stock location')
          .selectOption({ label: 'Calgary warehouse' });
        await page
          .getByRole('button', { name: 'Review reservation', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Confirm reservation', exact: true })
          .click();
        await expect(task()).toContainText('complete');
        await page
          .getByRole('link', { name: 'Back to order', exact: true })
          .click();
      }
      await dataset('line_reservations')
        .getByRole('link', { name: 'Select', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Ship reserved stock', exact: true })
        .click();
      await page.getByLabel('Quantity to ship', { exact: true }).fill(ship);
      await page.getByLabel('Carrier', { exact: true }).fill('Purolator');
      await page
        .getByLabel('Tracking or BOL number', { exact: true })
        .fill(`PUR-AR-${ship}`);
      await page
        .getByRole('button', { name: 'Review shipment', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Confirm shipment', exact: true })
        .click();
      await expect(task()).toContainText('complete');
      await page.goto(orderUrl);
    };
    const invoiceTask = () =>
      page.getByRole('button', {
        name: 'Invoice shipped quantities',
        exact: true,
      });

    await page.goto(orderUrl);
    // Nothing is shipped, so nothing is offered to invoice.
    await expect(invoiceTask()).toHaveCount(0);
    await reserveAndShip('3', '2');

    // Invoice the shipped 2 EA: 2 × 12.50, untaxed, no charges.
    await invoiceTask().click();
    await finish('Invoice shipped quantities');
    await page.goto(orderUrl);
    const invoices = dataset('order_invoices').locator('tbody tr');
    await expect(invoices).toHaveCount(1);
    await expect(invoices.first()).toContainText(/INV-\d{6}/u);
    await expect(
      invoices.first().locator('td[data-column-label="State"]'),
    ).toHaveText('Open');
    await expect(
      invoices.first().locator('td[data-column-label="Total"]'),
    ).toHaveText('25');
    // Everything shipped is invoiced, so the task is no longer offered.
    await expect(invoiceTask()).toHaveCount(0);
    await capture(page, testInfo, 'order-invoiced');

    // The invoice: its frozen figures, its line, and its balance.
    await invoices
      .first()
      .getByRole('link', { name: 'Open invoice', exact: true })
      .click();
    const invoiceUrl = page.url();
    await expect(page.locator('.composition-header h1')).toHaveText(
      /INV-\d{6}/u,
    );
    await expect(fact('Total')).toHaveText('25');
    await expect(fact('Balance')).toHaveText('25');
    await expect(fact('Due date')).not.toHaveText('');
    const lines = dataset('invoice_lines').locator('tbody tr');
    await expect(lines).toHaveCount(1);
    await expect(
      lines.first().locator('td[data-column-label="Quantity"]'),
    ).toHaveText('2');
    await expect(
      lines.first().locator('td[data-column-label="Amount"]'),
    ).toHaveText('25');

    // A payment above the balance is refused and changes nothing.
    await page
      .getByRole('button', { name: 'Record payment', exact: true })
      .click();
    await page.getByLabel('Amount received', { exact: true }).fill('30');
    await page
      .getByLabel('Reference (cheque or transaction number)')
      .fill('EFT-1001');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Review Record payment' })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirm Record payment' })
      .click();
    await expect(page.locator('[data-message-subject]').first()).toHaveText(
      'RECEIVABLES_AMOUNT_EXCEEDS_BALANCE',
    );
    await page.goto(invoiceUrl);
    await expect(fact('Balance')).toHaveText('25');

    // A payment in part, then a credit.
    await page
      .getByRole('button', { name: 'Record payment', exact: true })
      .click();
    await page.getByLabel('Amount received', { exact: true }).fill('10');
    await page.getByLabel('Method').selectOption({ label: 'Cheque' });
    await page
      .getByLabel('Reference (cheque or transaction number)')
      .fill('CHQ-2207');
    await finish('Record payment');
    await page.goto(invoiceUrl);
    await expect(fact('Balance')).toHaveText('15');
    await expect(page.locator('.composition-header')).toContainText(
      'Partially paid',
    );
    await expect(dataset('invoice_payments').locator('tbody tr')).toContainText(
      [/PAY-\d{6}.*Posted.*10.*Cheque.*CHQ-2207/su],
    );
    // Void is offered only while nothing is paid or credited.
    await expect(
      page.getByRole('button', { name: 'Void invoice', exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Issue credit', exact: true })
      .click();
    await page.getByLabel('Amount credited', { exact: true }).fill('5');
    await page.getByLabel('Reason', { exact: true }).fill('Two covers scuffed');
    await finish('Issue credit');
    await page.goto(invoiceUrl);
    await expect(fact('Balance')).toHaveText('10');
    await expect(dataset('invoice_credits').locator('tbody tr')).toContainText([
      /CM-\d{6}.*Posted.*5.*Two covers scuffed/su,
    ]);
    await capture(page, testInfo, 'invoice-settled-in-part');

    // The printable invoice (ruling G): its line and every figure.
    await page.getByRole('link', { name: 'Print invoice' }).click();
    const totals = page.locator('.print-totals');
    for (const [label, value] of [
      ['Total', '25'],
      ['Paid', '10'],
      ['Credited', '5'],
      ['Balance', '10'],
    ] as const)
      await expect(
        totals
          .locator('div')
          .filter({
            has: page.locator('dt', { hasText: new RegExp(`^${label}$`, 'u') }),
          })
          .locator('dd'),
      ).toHaveText(value);
    await capture(page, testInfo, 'invoice-print');

    // A later shipment is invoiced on its own; an unsettled invoice voids.
    await page.goto(orderUrl);
    await reserveAndShip(null, '1');
    await invoiceTask().click();
    await finish('Invoice shipped quantities');
    await page.goto(orderUrl);
    await expect(invoices).toHaveCount(2);
    const second = invoices.filter({ hasText: '12.5' });
    await second
      .getByRole('link', { name: 'Open invoice', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Void invoice', exact: true })
      .click();
    await finish('Void invoice');
    await page.reload();
    await expect(page.locator('.composition-header')).toContainText('Void');
    await expect(fact('Balance')).toHaveText('0');
    // Its quantity can be invoiced again.
    await page.goto(orderUrl);
    await expect(invoiceTask()).toHaveCount(1);

    // The Invoices List: one tab per state, customers by name.
    // The sidebar's Sales group lists it; the order page also has an
    // "Invoices" section link, so open the List by its surface.
    const invoiceList = new URL(orderUrl);
    invoiceList.search = '';
    invoiceList.searchParams.set(
      'surface',
      'northstar.app:surface.customer_invoice_list',
    );
    await page.goto(invoiceList.toString());
    await expect(
      page.getByRole('heading', { name: 'Invoices', level: 1 }),
    ).toBeVisible();
    const views = page.getByRole('navigation', { name: 'Views' });
    await expect(views.getByRole('link', { name: 'All 2' })).toBeVisible();
    await expect(views.getByRole('link', { name: 'Open 0' })).toBeVisible();
    await expect(
      views.getByRole('link', { name: 'Partially paid 1' }),
    ).toBeVisible();
    await expect(page.getByText('2 matching records')).toBeVisible();
    await expect(page.locator('main')).toContainText('Alpine Office Supply');
    await views.getByRole('link', { name: 'Void 1' }).click();
    await expect(page.getByText('1 matching record')).toBeVisible();
    await capture(page, testInfo, 'invoice-list');
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

async function fixture(run: (url: string) => Promise<void>) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/helpers/meta-sales-fixture.ts', '--serve'],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  const exited = once(child, 'exit');
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /META_SALES_URL=(.*)/.exec(output);
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
    child.kill('SIGTERM');
    await exited;
  }
}
