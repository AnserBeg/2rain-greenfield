import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import { expect, test } from '@playwright/test';

const namespace = 'northstar.location';

test('real Location surface creates a location and archives/restores through the generic press', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = await startFixture();
  try {
    await page.setExtraHTTPHeaders({ authorization: 'a' });

    await page.goto(
      `${surfaceUrl(fixture.baseUrl, 'location_detail')}&record=${encodeURIComponent(fixture.locationId)}`,
    );
    await expect(
      page.getByRole('heading', { level: 1, name: 'Browser Location' }),
    ).toBeVisible();
    await expect(
      page.locator('dd').getByText('Browser Location', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('LOC-WEB-001', { exact: true })).toBeVisible();
    await expect(
      page.getByText(`${namespace}:option.warehouse`, { exact: true }),
    ).toBeVisible();
    await page.locator('details.action-overflow summary').click();
    await page.getByRole('button', { name: 'Archive' }).click();
    await expect(
      page.getByRole('heading', { name: 'Confirm Archive' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Confirm Archive' }).click();
    await expect(page.getByRole('status')).toContainText('Archive complete');
    await expect(page.getByText(/Archived · revision 2/)).toBeVisible();
    await page.locator('details.action-overflow summary').click();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByRole('status')).toContainText('Restore complete');
    await expect(page.getByText(/Active · revision 3/)).toBeVisible();

    await page.goto(surfaceUrl(fixture.baseUrl, 'location_form'));
    await page.getByLabel('Code', { exact: true }).fill('LOC-WEB-004');
    await page
      .getByLabel('Name', { exact: true })
      .fill('Browser-created Location');
    // `fill` -> `selectOption`, corrected by `profile-v2-adoption`, and this one
    // line is the sharpest evidence in the repository that the adoption reaches
    // a real user.
    //
    // `location_type` is an `enumFieldType`. Under compiler-semantic v1 the
    // surface manifest carried no `fields` array, so `renderFormControl` took
    // its `if (!field)` branch and emitted a bare `<input>` -- into which a user
    // had to type `northstar.location:option.store` by hand, exactly as this
    // line did. Adopting v2 emits the field kinds, so the same control is now a
    // `<select>` and Playwright refuses `fill` on it by name: *"Element is not
    // an <input>, <textarea> or [contenteditable]"*.
    //
    // The assertion's MEANING is unchanged -- choose the store option and save.
    // Only its shape moved, because the control moved. Every other `fill` in
    // every browser spec targets a `textFieldType` and is untouched; this is the
    // only enum any of them writes, which is why it is the only correction.
    await page
      .getByRole('combobox', { name: 'Type', exact: true })
      .selectOption(`${namespace}:option.store`);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Create complete');
    await expect(page.getByRole('status')).toContainText(
      'trust evidence is linked',
    );

    await page.goto(surfaceUrl(fixture.baseUrl, 'location_list'));
    await expect(
      page.getByRole('cell', {
        name: 'Browser-created Location',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'LOC-WEB-004', exact: true }),
    ).toBeVisible();
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
  readonly locationId: string;
  readonly process: ChildProcessWithoutNullStreams;
}

async function startFixture(): Promise<RunningFixture> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/fixtures/g2/location/runtime-harness.ts'],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise<{ baseUrl: string; locationId: string }>(
    (resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Location fixture timed out\n${stderr}`)),
        60_000,
      );
      lines.on('line', (line) => {
        if (!line.startsWith('LOCATION_BROWSER_READY ')) return;
        clearTimeout(timeout);
        resolve(
          JSON.parse(line.slice('LOCATION_BROWSER_READY '.length)) as {
            baseUrl: string;
            locationId: string;
          },
        );
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Location fixture exited before ready (${String(code)})\n${stderr}`,
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
      reject(new Error('Location fixture did not stop after SIGTERM'));
    }, 15_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Location fixture exited with ${String(code)}`));
    });
  });
}

function surfaceUrl(baseUrl: string, localSurface: string): string {
  return `${baseUrl}/?surface=${encodeURIComponent(`${namespace}:surface.${localSurface}`)}`;
}
