import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const ns = 'northstar.app';
interface Scenario {
  notebook: string;
  warehouse: string;
  second: string;
  bin: string;
  nested: string;
}

test('warehouse selection follows a moved nested bin while stock quantities stay unchanged', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await fixture(async (base, seed) => {
    const scenario = await seed();
    const url = (surface: string, root?: string, record?: string) => {
      const target = new URL(base);
      target.search = '';
      target.searchParams.set('surface', `${ns}:surface.${surface}`);
      if (root)
        target.searchParams.set(
          `${ns}:list_selector.${surface}_warehouse`,
          root,
        );
      if (record) target.searchParams.set('record', record);
      return target.href;
    };
    const cell = (record: string, local: string, column: string) =>
      page.locator(
        `tr[data-record-id="${record}"] td[data-column-id="${ns}:list_column.${local}_${column}"]`,
      );
    await page.goto(url('location_list', scenario.warehouse));
    await expect(page.getByLabel('Warehouse', { exact: true })).toHaveValue(
      scenario.warehouse,
    );
    await expect(cell(scenario.nested, 'location_list', 'parent')).toHaveText(
      'Calgary warehouse',
    );
    await expect(
      page.locator(`tr[data-record-id="${scenario.second}"]`),
    ).toHaveCount(0);
    await page.goto(url('location_detail', undefined, scenario.bin));
    await page
      .getByRole('button', { name: 'Move location', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('New warehouse').selectOption(scenario.second);
    await dialog.getByRole('button', { name: 'Review Move location' }).click();
    await dialog.getByRole('button', { name: 'Confirm Move location' }).click();
    await expect(page.getByRole('status').first()).toContainText(
      'Move location: done',
    );
    await page.goto(url('location_list', scenario.second));
    await expect(cell(scenario.nested, 'location_list', 'parent')).toHaveText(
      'Second warehouse',
    );
    await page.goto(url('item_stock_list', scenario.warehouse));
    await expect(
      cell(scenario.notebook, 'item_stock_list', 'on_hand'),
    ).toHaveText('6');
    await page
      .getByLabel('Warehouse', { exact: true })
      .selectOption(scenario.second);
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(
      cell(scenario.notebook, 'item_stock_list', 'on_hand'),
    ).toHaveText('4');
    await expect(
      cell(scenario.notebook, 'item_stock_list', 'incoming'),
    ).toHaveText('0');
    await page.goto(url('item_buying_list', scenario.second));
    await expect(
      cell(scenario.notebook, 'item_buying_list', 'usable'),
    ).toHaveText('4');
  });
});

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
      child.stdin.write(`${JSON.stringify({ phase: 'locations-2' })}\n`);
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
