import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
interface Seeded {
  readonly item: string;
  readonly company: string;
}

test('inventory value and item page show actual moving average and unvalued opening quantities', async ({
  page,
}) => {
  test.setTimeout(480_000);
  await fixture(async (url, seed) => {
    const data = await seed();
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
    destination.searchParams.set(
      'surface',
      'northstar.app:surface.item_detail',
    );
    destination.searchParams.set('record', data.item);
    destination.searchParams.set(
      'northstar.app:parameter.inventory_value_get_company',
      data.company,
    );
    await page.goto(destination.toString());
    await expect(page.locator('.composition-header-facts')).toContainText(
      'CAD 200.00',
    );
    await expect(page.locator('.composition-header-facts')).toContainText(
      'Unvalued quantity',
    );
    const sellingPrice = page
      .locator('[data-composition-fields] .record-fields > div')
      .filter({ has: page.getByText('Selling price (CAD)', { exact: true }) });
    await expect(sellingPrice.locator('dd')).toHaveText('12.50');
  });
});

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
      child.stdin.write(`${JSON.stringify({ phase: 'valuation' })}\n`);
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
