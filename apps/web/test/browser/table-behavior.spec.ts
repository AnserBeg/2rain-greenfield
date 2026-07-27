import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import { expect, test } from '@playwright/test';

const namespace = 'northstar.party';

test('compiled list surface preserves covered paging, pre-page search, archive choice, and formatting', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = await startFixture();
  try {
    await page.setExtraHTTPHeaders({ authorization: 'a' });
    await page.goto(surfaceUrl(fixture.baseUrl, 'party_list'));

    const coverage = page.locator('[data-list-coverage]');
    await expect(coverage).toHaveAttribute('data-status-role', 'attention');
    await expect(coverage).toHaveAttribute(
      'data-list-coverage',
      '1–100 of 102',
    );
    await expect(
      page.getByText('Page Two Needle', { exact: true }),
    ).toHaveCount(0);
    const next = page.getByRole('link', { name: 'Next page' });
    await expect(next).toBeVisible();
    expect(
      await next.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    await next.click();
    await expect(coverage).toHaveAttribute(
      'data-list-coverage',
      '101–102 of 102',
    );
    await expect(
      page.getByText('Page Two Needle', { exact: true }),
    ).toBeVisible();

    await page.goto(
      `${surfaceUrl(fixture.baseUrl, 'party_list')}&q=${encodeURIComponent('Page Two Needle')}`,
    );
    await expect(coverage).toHaveAttribute('data-list-coverage', '1–1 of 1');
    await expect(
      page.getByText('Page Two Needle', { exact: true }),
    ).toBeVisible();

    await page.goto(
      `${surfaceUrl(fixture.baseUrl, 'party_list')}&q=${encodeURIComponent('Archived Needle')}`,
    );
    await expect(coverage).toHaveAttribute('data-list-coverage', '0–0 of 0');
    await expect(page.locator('[data-list-zero-input="true"]')).toBeVisible();
    await page.goto(
      `${surfaceUrl(fixture.baseUrl, 'party_list')}&q=${encodeURIComponent('Archived Needle')}&archived=yes`,
    );
    await expect(
      page.getByText('Archived Needle', { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('tr[data-record-id] [data-status-role="attention"]'),
    ).toHaveText('Archived');

    await page.goto(surfaceUrl(fixture.baseUrl, 'party_role_list'));
    await expect(page.getByRole('cell', { name: 'Supplier' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Customer' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(
      `${namespace}:option.supplier`,
    );
  } finally {
    await stopFixture(fixture.process);
  }
});

interface RunningFixture {
  readonly baseUrl: string;
  readonly process: ChildProcessWithoutNullStreams;
}

async function startFixture(): Promise<RunningFixture> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/fixtures/g2/table-behavior/browser-server.ts'],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise<{ baseUrl: string }>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Table behavior fixture timed out\n${stderr}`)),
      90_000,
    );
    lines.on('line', (line) => {
      if (!line.startsWith('TABLE_BEHAVIOR_BROWSER_READY ')) return;
      clearTimeout(timeout);
      resolve(
        JSON.parse(line.slice('TABLE_BEHAVIOR_BROWSER_READY '.length)) as {
          baseUrl: string;
        },
      );
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Table behavior fixture exited before ready (${String(code)})\n${stderr}`,
        ),
      );
    });
  });
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
      reject(new Error('Table behavior fixture did not stop after SIGTERM'));
    }, 15_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else
        reject(new Error(`Table behavior fixture exited with ${String(code)}`));
    });
  });
}

function surfaceUrl(baseUrl: string, localSurface: string): string {
  return `${baseUrl}/?surface=${encodeURIComponent(`${namespace}:surface.${localSurface}`)}`;
}
