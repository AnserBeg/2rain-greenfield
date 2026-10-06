import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
interface Seeded {
  readonly item: string;
  readonly company: string;
  readonly shipment?: string;
  readonly order?: string;
  readonly invoice?: string;
  readonly items?: readonly { id: string; name: string }[];
}

test('inventory value shows actual moving average and unvalued opening quantities', async ({
  page,
}) => {
  test.setTimeout(480_000);
  await fixture(async (url, seed) => {
    await seed();
    const destination = new URL(url);
    destination.search = '';
    destination.searchParams.set(
      'surface',
      'northstar.app:surface.inventory_value_list',
    );
    await page.goto(destination.toString());
    await expect(
      page.getByRole('heading', { name: 'Inventory value', level: 1 }),
    ).toBeVisible();
    const row = page
      .locator('main tbody tr')
      .filter({ hasText: 'Field notebook' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('CAD 10');
    await expect(row).toContainText('CAD 200.00');
    await expect(
      row.locator('td[data-column-label="Unvalued quantity"]'),
    ).toHaveText('10');
    // INTEGRATION (decision I-V1): the item page stays INVENTORY-PARITY's
    // stock page, so the item's figures are read here, on the Inventory value
    // List, and not on the item page.
  });
});

test('inventory shipment relief and order/invoice margin remain at shipment cost after a later receipt', async ({
  page,
}) => {
  test.setTimeout(480_000);
  await fixture(async (url, seed) => {
    const data = await seed('valuation-shipped');
    const destination = new URL(url);
    destination.search = '';
    for (const [local, query, record] of [
      ['shipment_detail', 'shipment_get', data.shipment],
      ['sales_order_detail', 'commercial_order_get', data.order],
      ['customer_invoice_detail', 'customer_invoice_get', data.invoice],
    ]) {
      destination.search = '';
      destination.searchParams.set('surface', `northstar.app:surface.${local}`);
      destination.searchParams.set('record', record!);
      destination.searchParams.set(
        `northstar.app:parameter.${query}_legal_entity_scope`,
        data.company,
      );
      await page.goto(destination.toString());
      const details = page.locator('[data-composition-fields]');
      await expect(details).toContainText('CAD 40.00');
      await expect(details).toContainText('Fully valued');
      if (local === 'shipment_detail')
        await expect(
          page.locator('[data-composition-dataset$="dataset.shipment_relief"]'),
        ).toContainText('CAD 40.00');
      else await expect(details).toContainText('CAD 60.00');
    }
    await page
      .getByRole('link', { name: 'Print invoice', exact: true })
      .click();
    const printed = page.locator('[data-print-document]');
    await expect(printed).toBeVisible();
    await expect(printed).not.toContainText('cost of goods');
    await expect(printed).not.toContainText('margin');
  });
});

test('inventory value includes vendor freight and fees allocated by actual receipt value', async ({
  page,
}) => {
  test.setTimeout(480_000);
  await fixture(async (url, seed) => {
    const data = await seed('valuation-landed');
    const destination = new URL(url);
    destination.search = '';
    destination.searchParams.set(
      'surface',
      'northstar.app:surface.inventory_value_list',
    );
    await page.goto(destination.toString());
    await expect(
      page.getByRole('heading', { name: 'Inventory value', level: 1 }),
    ).toBeVisible();
    for (const [index, item] of data.items!.entries()) {
      const row = page.locator('main tbody tr').filter({ hasText: item.name });
      await expect(row).toHaveCount(1);
      await expect(
        row.locator('td[data-column-label="Average cost"]'),
      ).toHaveText(index === 0 ? 'CAD 5.5' : 'CAD 16.5');
      await expect(
        row.locator('td[data-column-label="Known value"]'),
      ).toHaveText(index === 0 ? 'CAD 55.00' : 'CAD 165.00');
      await expect(
        row.locator('td[data-column-label="Unvalued quantity"]'),
      ).toHaveText('0');
      await expect(
        row.locator('td[data-column-label="Landed cost coverage"]'),
      ).toHaveText('Allocated by actual receipt value');
    }
  });
});

/**
 * The order-entry fixture, served with `--verify` so the purchase order is
 * seeded through its own governed operations once the application is up.
 */
async function fixture(
  run: (
    url: string,
    seed: (phase?: string) => Promise<Seeded>,
  ) => Promise<void>,
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
  const seed = (phase = 'valuation') =>
    new Promise<Seeded>((resolve, reject) => {
      seeded = resolve;
      child.once('exit', () => reject(new Error(output)));
      child.stdin.write(`${JSON.stringify({ phase })}\n`);
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
