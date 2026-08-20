import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import { expect, test } from '@playwright/test';

const namespace = 'northstar.party';

test('real Party surface renders roles, creates, and archives/restores through the generic press', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = await startFixture();
  try {
    await page.setExtraHTTPHeaders({ authorization: 'a' });

    await page.goto(surfaceUrl(fixture.baseUrl, 'party_role_list'));
    await expect(
      page.getByRole('cell', { name: 'Supplier', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'Customer', exact: true }),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText(
      `${namespace}:option.supplier`,
    );
    await expect(page.locator('body')).not.toContainText(
      `${namespace}:option.customer`,
    );

    await page.goto(
      `${surfaceUrl(fixture.baseUrl, 'party_detail')}&record=${encodeURIComponent(fixture.partyId)}`,
    );
    await expect(
      page.getByRole('heading', { level: 1, name: 'Browser Party' }),
    ).toBeVisible();
    await expect(
      page.locator('dd').getByText('Browser Party', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('P-WEB-001', { exact: true })).toBeVisible();
    await page.locator('details.action-overflow summary').click();
    await page.getByRole('button', { name: 'Archive' }).click();
    await expect(
      page.getByRole('heading', { name: 'Confirm Archive' }),
    ).toBeVisible();
    await expect(page.locator('input[name="confirmed"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Confirm Archive' }).click();
    await expect(page.getByRole('status')).toContainText('Archive complete');
    await expect(page.getByText(/Archived · revision 2/)).toBeVisible();
    await page.locator('details.action-overflow summary').click();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByRole('status')).toContainText('Restore complete');
    await expect(page.getByText(/Active · revision 3/)).toBeVisible();

    await page.goto(surfaceUrl(fixture.baseUrl, 'party_form'));
    await page.getByLabel('Number', { exact: true }).fill('P-WEB-004');
    await page
      .getByLabel('Name', { exact: true })
      .fill('Browser-created Party');
    await page
      .getByLabel('Contact summary', { exact: true })
      .fill('created@example.test');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Create complete');
    await expect(page.getByRole('status')).toContainText(
      'trust evidence is linked',
    );

    await page.goto(surfaceUrl(fixture.baseUrl, 'party_list'));
    await expect(
      page.getByRole('cell', { name: 'Browser-created Party', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'P-WEB-004', exact: true }),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText('north_star_module');
    await expect(page.locator('body')).not.toContainText('storageClass');
  } finally {
    await stopFixture(fixture.process);
  }
});

interface RunningFixture {
  readonly baseUrl: string;
  readonly partyId: string;
  readonly process: ChildProcessWithoutNullStreams;
}

async function startFixture(): Promise<RunningFixture> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/fixtures/g2/party/browser-server.ts'],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise<{ baseUrl: string; partyId: string }>(
    (resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Party fixture timed out\n${stderr}`)),
        60_000,
      );
      lines.on('line', (line) => {
        if (!line.startsWith('PARTY_BROWSER_READY ')) return;
        clearTimeout(timeout);
        resolve(
          JSON.parse(line.slice('PARTY_BROWSER_READY '.length)) as {
            baseUrl: string;
            partyId: string;
          },
        );
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Party fixture exited before ready (${String(code)})\n${stderr}`,
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
      reject(new Error('Party fixture did not stop after SIGTERM'));
    }, 15_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Party fixture exited with ${String(code)}`));
      }
    });
  });
}

function surfaceUrl(baseUrl: string, localSurface: string): string {
  return `${baseUrl}/?surface=${encodeURIComponent(`${namespace}:surface.${localSurface}`)}`;
}
