import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// UNITS setup slice. Entered document quantities wait for UNITS-VERIFICATION.
test('code-keyed units and company conversions use the shared setup forms', async ({
  page,
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/helpers/order-entry-fixture.ts', '--serve'],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      stdio: ['pipe', 'pipe', 'pipe'],
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
    const url = new URL(await ready);
    const open = async (local: string) => {
      url.searchParams.set('surface', `northstar.app:surface.${local}`);
      await page.goto(url.toString());
    };
    await open('unit_list');
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await page.getByLabel('Code', { exact: true }).fill('BOX');
    await page.getByLabel('Name', { exact: true }).fill('Box of twelve');
    // The shared renderer uses a datalist for enums with more than five choices.
    await page
      .getByLabel('Decimals')
      .fill('northstar.app:option.unit_decimals_0');
    await expect(page.locator('datalist option')).toHaveCount(19);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(
      /saved|created|complete/i,
    );
    await open('unit_list');
    await expect(
      page.getByRole('cell', { name: 'BOX', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'Box of twelve', exact: true }),
    ).toBeVisible();
    await open('unit_conversion_list');
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await page.getByLabel('Code', { exact: true }).fill('BOX-EA');
    await page.getByLabel('From unit', { exact: true }).fill('BOX');
    await page.getByLabel('To unit', { exact: true }).fill('EA');
    await page.getByLabel('Numerator', { exact: true }).fill('12');
    await page.getByLabel('Denominator', { exact: true }).fill('1');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(
      /saved|created|complete/i,
    );
    await open('unit_conversion_list');
    await expect(
      page.getByRole('cell', { name: 'BOX-EA', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('cell', { name: '12', exact: true }),
    ).toBeVisible();
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    const [code] = await exited;
    expect(code, output).toBe(0);
  }
});
