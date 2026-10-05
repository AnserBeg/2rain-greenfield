import { test, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ns = 'northstar.app';
// The order-entry fixture's demo party, a customer and a supplier.
const alpine = '71000000-0000-4000-8000-000000000001';

// RETURNABLE-ASSETS through the declared workspaces: a keg type with a CAD
// deposit, six kegs issued to a customer against the deposit, four returned,
// two forfeited and the deposit on the returned four refunded; nothing moves
// stock, and every event is dated and attributed on the custody record.
test('kegs go out to a customer against a deposit, come back or are forfeited, and the deposit on what came back is refunded', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url) => {
    const dialog = page.getByRole('dialog');
    const surface = (local: string, record?: string) => {
      const target = new URL(url);
      target.search = '';
      target.searchParams.set('surface', `${ns}:surface.${local}`);
      if (record) target.searchParams.set('record', record);
      return target.toString();
    };
    const dataset = (name: string) =>
      page.locator(`[data-composition-dataset$="dataset.${name}"]`);
    const fact = (label: string) =>
      page
        .locator('.composition-header-facts div')
        .filter({
          has: page.locator('dt', {
            hasText: new RegExp(`^${label}$`, 'u'),
          }),
        })
        .locator('dd');
    const finish = async (label: string) => {
      await dialog.getByRole('button', { name: `Review ${label}` }).click();
      await dialog.getByRole('button', { name: `Confirm ${label}` }).click();
      await expect(page.getByRole('status').first()).toContainText(
        `${label}: done`,
      );
    };
    const refused = async (label: string, code: string) => {
      await dialog.getByRole('button', { name: `Review ${label}` }).click();
      await dialog.getByRole('button', { name: `Confirm ${label}` }).click();
      await expect(page.locator('[data-message-subject]').first()).toHaveText(
        code,
      );
    };
    const task = (label: string) =>
      page.getByRole('button', { name: label, exact: true });

    // Party lists the returnable types and both Returnables Lists.
    await page.goto(url);
    const navigation = page.getByRole('navigation', {
      name: 'Release navigation',
    });
    // The Party group's label, not the Party List inside it.
    await navigation
      .locator('summary .nav-group-label', { hasText: /^Party$/u })
      .click();
    for (const name of [
      'Returnable type',
      'Returnables out',
      'Returnables held',
    ])
      await expect(
        navigation.getByRole('link', { name, exact: true }),
      ).toBeVisible();

    // A keg type with a 30.00 deposit in CAD.
    await page.goto(surface('returnable_asset_type_list'));
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await page.getByLabel('Code', { exact: true }).fill('KEG-50');
    await page.getByLabel('Name', { exact: true }).fill('50 L keg');
    await page
      .getByLabel('Asset class', { exact: true })
      .selectOption({ label: 'Keg' });
    await page.getByLabel('Deposit cad', { exact: true }).fill('30');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Create complete');

    // The customer's page enters the company and lists no returnables yet.
    await page.goto(surface('party_detail', alpine));
    await expect(
      page.getByRole('heading', { name: 'Alpine Office Supply', level: 1 }),
    ).toBeVisible();
    const partyUrl = page.url();
    expect(
      new URL(partyUrl).searchParams.get(
        `${ns}:parameter.returnable_custody_list_legal_entity_scope`,
      ),
      'the party page pins the company it reads returnables in',
    ).toBeTruthy();
    await expect(dataset('party_returnables').locator('tbody tr')).toHaveCount(
      0,
    );

    // Issue six kegs: a custody record and its first Issue, the deposit paid
    // by cheque.
    await task('Issue returnables').click();
    await dialog
      .getByLabel('Returnable type', { exact: true })
      .selectOption({ label: '50 L keg' });
    await expect(dialog.getByLabel('Direction', { exact: true })).toHaveValue(
      `${ns}:option.returnable_custody_direction_out`,
    );
    await dialog.getByLabel('Quantity', { exact: true }).fill('6');
    await dialog
      .getByLabel('Deposit paid by', { exact: true })
      .selectOption({ label: 'Cheque' });
    await dialog
      .getByLabel('Reference (cheque or transfer number)')
      .fill('CHQ-4410');
    await dialog.getByLabel('Reason', { exact: true }).fill('Opening delivery');
    await finish('Issue returnables');
    await page.goto(partyUrl);
    const custodyRows = dataset('party_returnables').locator('tbody tr');
    await expect(custodyRows).toHaveCount(1);
    await expect(custodyRows.first()).toContainText(/RTN-\d{6}/u);
    await expect(
      custodyRows.first().locator('td[data-column-label="Outstanding"]'),
    ).toHaveText('6');
    await expect(
      custodyRows.first().locator('td[data-column-label="Deposit held"]'),
    ).toHaveText('180.00');
    await capture(page, testInfo, 'party-returnables');

    // The custody record: its figures and its dated, attributed events.
    await custodyRows
      .first()
      .getByRole('link', { name: 'Open custody', exact: true })
      .click();
    const custodyUrl = page.url();
    await expect(page.locator('.composition-header h1')).toHaveText(
      /RTN-\d{6}/u,
    );
    await expect(fact('Returnable type')).toHaveText('50 L keg');
    await expect(fact('Outstanding')).toHaveText('6');
    await expect(fact('Deposit held')).toHaveText('180.00');
    await expect(fact('Refundable now')).toHaveText('0.00');
    const events = dataset('custody_events').locator('tbody tr');
    await expect(events).toHaveCount(1);
    await expect(events.first()).toContainText(
      /Issue.*6.*180\.00.*Cheque.*CHQ-4410.*Opening delivery/su,
    );
    // Nothing is refundable until something comes back.
    await expect(task('Refund deposit')).toHaveCount(0);

    // More than is outstanding is refused and changes nothing.
    await task('Return').click();
    await dialog.getByLabel('Quantity returned', { exact: true }).fill('7');
    await dialog.getByLabel('Reason', { exact: true }).fill('Count at dock');
    await refused('Return', 'RETURNABLES_QUANTITY_EXCEEDS_OUTSTANDING');
    await page.goto(custodyUrl);
    await expect(fact('Outstanding')).toHaveText('6');

    // Four come back: their deposit becomes refundable.
    await task('Return').click();
    await dialog.getByLabel('Quantity returned', { exact: true }).fill('4');
    await dialog.getByLabel('Reason', { exact: true }).fill('Empties back');
    await finish('Return');
    await page.goto(custodyUrl);
    await expect(fact('Outstanding')).toHaveText('2');
    await expect(fact('Refundable now')).toHaveText('120.00');

    // Two will not come back: their deposit is kept.
    await task('Forfeit').click();
    await dialog.getByLabel('Quantity forfeited', { exact: true }).fill('2');
    await dialog
      .getByLabel('Reason', { exact: true })
      .fill('Lost at the customer');
    await finish('Forfeit');
    await page.goto(custodyUrl);
    await expect(fact('Outstanding')).toHaveText('0');
    await expect(page.locator('.composition-header')).toContainText(
      'Awaiting refund',
    );
    await expect(task('Return')).toHaveCount(0);
    await expect(task('Forfeit')).toHaveCount(0);

    // A refund above the deposit on what came back is refused; the rest is
    // refunded by bank transfer and the custody closes.
    await task('Refund deposit').click();
    await dialog.getByLabel('Amount refunded', { exact: true }).fill('120.01');
    await dialog.getByLabel('Reason', { exact: true }).fill('Deposit back');
    await refused('Refund deposit', 'RETURNABLES_REFUND_EXCEEDS_DEPOSIT');
    await page.goto(custodyUrl);
    await task('Refund deposit').click();
    await dialog.getByLabel('Amount refunded', { exact: true }).fill('120');
    await dialog
      .getByLabel('Refunded by', { exact: true })
      .selectOption({ label: 'Bank transfer' });
    await dialog
      .getByLabel('Reference (cheque or transfer number)')
      .fill('EFT-88');
    await dialog.getByLabel('Reason', { exact: true }).fill('Deposit back');
    await finish('Refund deposit');
    await page.goto(custodyUrl);
    await expect(page.locator('.composition-header')).toContainText('Closed');
    // Nothing is held any more: 120.00 went back, 60.00 was kept.
    await expect(fact('Deposit held')).toHaveText('0.00');
    await expect(fact('Refundable now')).toHaveText('0.00');
    // Four posted events; the two refused attempts stay as drafts, as a
    // refused payment's draft does.
    await expect(events).toHaveCount(6);
    await expect(
      events.filter({
        has: page.locator('td[data-column-label="State"]', {
          hasText: 'Posted',
        }),
      }),
    ).toHaveCount(4);
    await expect(events).toContainText([
      /Issue.*6.*180\.00/su,
      /Return.*4/su,
      /Forfeit.*2.*60\.00/su,
      /Deposit refund.*120\.00.*Bank transfer.*EFT-88/su,
    ]);
    await capture(page, testInfo, 'custody-closed');

    // Returnables out: the customer's kegs, by state; none held of suppliers.
    await page.goto(surface('returnable_custody_list'));
    await expect(
      page.getByRole('heading', { name: 'Returnables out', level: 1 }),
    ).toBeVisible();
    const views = page.getByRole('navigation', { name: 'Views' });
    await expect(views.getByRole('link', { name: 'Closed 1' })).toBeVisible();
    await expect(views.getByRole('link', { name: 'Open 0' })).toBeVisible();
    await views.getByRole('link', { name: 'Closed 1' }).click();
    await expect(page.locator('main')).toContainText('Alpine Office Supply');
    await expect(page.locator('main')).toContainText('50 L keg');
    await capture(page, testInfo, 'returnables-out');
    await page.goto(surface('returnables_held_list'));
    await expect(
      page.getByRole('heading', { name: 'Returnables held', level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Views' }).getByRole('link', {
        name: 'All 0',
      }),
    ).toBeVisible();
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

/** The order-entry fixture, served. */
async function fixture(run: (url: string) => Promise<void>) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/helpers/order-entry-fixture.ts', '--serve'],
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
    child.kill('SIGTERM');
    const [code] = await exited;
    expect(code, output).toBe(0);
  }
}
