import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import { expect, test } from '@playwright/test';

const namespace = 'northstar.catalog';

test('real Catalog surface creates an item and archives/restores through the generic press', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = await startFixture();
  try {
    await page.setExtraHTTPHeaders({ authorization: 'a' });

    await page.goto(
      `${surfaceUrl(fixture.baseUrl, 'item_detail')}&record=${encodeURIComponent(fixture.itemId)}`,
    );
    await expect(page.getByText('Browser Item', { exact: true })).toBeVisible();
    await expect(page.getByText('SKU-WEB-001', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Browser-seeded descriptor', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Archive' }).click();
    await expect(
      page.getByRole('heading', { name: 'Confirm Archive' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Confirm Archive' }).click();
    await expect(page.getByRole('status')).toContainText('Archive complete');
    await expect(page.getByText(/Archived · revision 2/)).toBeVisible();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByRole('status')).toContainText('Restore complete');
    await expect(page.getByText(/Active · revision 3/)).toBeVisible();

    await page.goto(surfaceUrl(fixture.baseUrl, 'item_form'));
    await page.getByLabel('SKU').fill('SKU-WEB-004');
    await page.getByLabel('Item Name').fill('Browser-created Item');
    await page.getByLabel('Description').fill('Created through generic form');
    await page.getByRole('button', { name: 'Create record' }).click();
    await expect(page.getByRole('status')).toContainText('Create complete');
    await expect(page.getByRole('status')).toContainText(
      'trust evidence is linked',
    );

    await page.goto(surfaceUrl(fixture.baseUrl, 'item_list'));
    await expect(
      page.getByRole('cell', { name: 'Browser-created Item' }),
    ).toBeVisible();
    await expect(page.getByRole('cell', { name: 'SKU-WEB-004' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('north_star_module');
    await expect(page.locator('body')).not.toContainText('storageClass');
    await expect(page.locator('body')).not.toContainText(
      /on[-_ ]?hand|quantity/i,
    );
  } finally {
    await stopFixture(fixture.process);
  }
});

interface RunningFixture {
  readonly baseUrl: string;
  readonly itemId: string;
  readonly process: ChildProcessWithoutNullStreams;
}

async function startFixture(): Promise<RunningFixture> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/fixtures/g2/catalog/runtime-harness.ts'],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise<{ baseUrl: string; itemId: string }>(
    (resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Catalog fixture timed out\n${stderr}`)),
        60_000,
      );
      lines.on('line', (line) => {
        if (!line.startsWith('CATALOG_BROWSER_READY ')) return;
        clearTimeout(timeout);
        resolve(
          JSON.parse(line.slice('CATALOG_BROWSER_READY '.length)) as {
            baseUrl: string;
            itemId: string;
          },
        );
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Catalog fixture exited before ready (${String(code)})\n${stderr}`,
          ),
        );
      });
    },
  );
  lines.close();
  assert.match(ready.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  return { ...ready, process: child };
}

async function stopFixture(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Catalog fixture did not stop after SIGTERM'));
    }, 15_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Catalog fixture exited with ${String(code)}`));
    });
  });
}

function surfaceUrl(baseUrl: string, localSurface: string): string {
  return `${baseUrl}/?surface=${encodeURIComponent(`${namespace}:surface.${localSurface}`)}`;
}
