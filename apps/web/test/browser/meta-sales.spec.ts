import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

test.use({ screenshot: 'only-on-failure', trace: 'retain-on-failure' });

for (const javaScriptEnabled of [true, false]) {
  test.describe(`Task presentation JS ${javaScriptEnabled ? 'on' : 'off'}`, () => {
    test.use({ javaScriptEnabled });
    test('metadata workspace reserves, partially ships, releases and opens complete packing', async ({
      page,
    }, testInfo) => {
      test.setTimeout(480_000);
      page.setDefaultTimeout(30000);
      await withBrowserFixture(async (url) => {
        const orderId = new URL(url).searchParams.get('record');
        const captures: unknown[] = [];
        const capture = async (name: string, state: string) => {
          for (const [size, width, height] of [
            ['desktop', 1280, 800],
            ['mobile', 390, 844],
          ] as const) {
            await page.setViewportSize({ width, height });
            await page.evaluate(() => window.scrollTo(0, 0));
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            const file = `${name}-${size}.png`;
            await page.screenshot({
              path: testInfo.outputPath(file),
              fullPage: true,
            });
            await page.screenshot({
              path: testInfo.outputPath(`${name}-${size}-viewport.png`),
            });
            captures.push({
              file,
              viewport: { width, height },
              state,
              url: page.url(),
              releaseRoot: await page
                .locator('.app-shell')
                .getAttribute('data-release-content-hash'),
              releaseId: await page
                .locator('.app-shell')
                .getAttribute('data-release-id'),
            });
          }
          await page.setViewportSize({ width: 1280, height: 800 });
        };
        await page.goto(url);
        await expect(page.locator('script')).toHaveCount(0);
        await expect(
          page.getByText('Alpine Office Supply', { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText('Field notebook', { exact: true }),
        ).toBeVisible();
        const lines = () =>
          page.locator(
            '[data-composition-dataset$="dataset.fulfillment_lines"]',
          );
        const reservations = () =>
          page.locator(
            '[data-composition-dataset$="dataset.line_reservations"]',
          );
        const shipments = () =>
          page.locator('[data-composition-dataset$="dataset.order_shipments"]');
        await capture(
          'unreserved',
          'Released; ordered 10 EA, reserved 0, shipped 0, open 10',
        );
        // The order's lines lead the document on the first screen: its priced
        // lines (ruling B), with fulfillment by line below them.
        const lineTop = await page
          .locator('[data-composition-dataset$="dataset.order_lines"]')
          .boundingBox();
        expect(lineTop!.y).toBeLessThan(650);
        await expect(page.locator('.composition-header')).toContainText(
          'Released',
        );
        await lines()
          .getByRole('link', { name: 'Select', exact: true })
          .focus();
        await page.keyboard.press('Enter');
        const task = () => page.locator('[data-composition-task]');
        await page
          .getByRole('button', { name: 'Reserve stock', exact: true })
          .click();
        await expect(page.locator('script')).toHaveCount(1);
        await expect(task()).toHaveAttribute('data-task-fallback', 'page');
        expect(
          await task().evaluate((element) => element.matches(':modal')),
        ).toBe(javaScriptEnabled);
        const entryToken = await task()
          .locator('[name=taskToken]')
          .inputValue();
        if (javaScriptEnabled) {
          await expect(
            page.getByLabel(/^Quantity to (?:reserve|ship)$/),
          ).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(task()).not.toBeVisible();
          await expect(
            page.getByRole('button', { name: 'Continue task', exact: true }),
          ).toBeFocused();
          await page.keyboard.press('Enter');
          await expect(task()).toBeVisible();
          expect(await task().locator('[name=taskToken]').inputValue()).toBe(
            entryToken,
          );
        }
        await capture(
          'reserve-entry',
          'Reserve entry; no dispatch; order remains in context',
        );
        await page.getByLabel(/^Quantity to (?:reserve|ship)$/).fill('-2');
        await page
          .getByLabel('Stock location')
          .selectOption({ label: 'Calgary warehouse' });
        await page
          .getByRole('button', { name: 'Review reservation', exact: true })
          .click();
        await expect(task()).toContainText('Check the task inputs');
        // Focus lands on the input that needs correcting.
        await expect(
          page.getByLabel(/^Quantity to (?:reserve|ship)$/),
        ).toBeFocused();
        await expect(
          page.getByLabel(/^Quantity to (?:reserve|ship)$/),
        ).toHaveValue('-2');
        await expect(page.getByLabel('Stock location')).toHaveValue(
          '71000000-0000-4000-8000-000000000021',
        );
        await page.getByLabel(/^Quantity to (?:reserve|ship)$/).fill('8');
        await page
          .getByRole('button', { name: 'Review reservation', exact: true })
          .focus();
        await page.keyboard.press('Enter');
        await expect(
          page.getByRole('button', {
            name: 'Confirm reservation',
            exact: true,
          }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(task()).toContainText('Calgary warehouse');
        const preparedId = await task()
          .locator('[name=preparedId]')
          .inputValue();
        if (javaScriptEnabled) {
          await expect(task().locator('[data-task-heading]')).toBeFocused();
          await page.keyboard.press('Shift+Tab');
          expect(
            await page.evaluate(
              () => !!document.activeElement?.closest('dialog'),
            ),
          ).toBe(true);
          await page.keyboard.press('Tab');
          expect(
            await page.evaluate(
              () => !!document.activeElement?.closest('dialog'),
            ),
          ).toBe(true);
          await page
            .getByRole('button', { name: 'Close task', exact: true })
            .click();
          await expect(task()).not.toBeVisible();
          await page
            .getByRole('button', { name: 'Continue task', exact: true })
            .click();
          expect(await task().locator('[name=preparedId]').inputValue()).toBe(
            preparedId,
          );
          expect(await task().locator('[name=taskToken]').inputValue()).toBe(
            entryToken,
          );
        }
        // Forged confirmation is observed through the real route and unchanged visible stock.
        await page
          .getByRole('button', { name: 'Edit inputs', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Review reservation', exact: true })
          .click();
        const replacementId = await task()
          .locator('[name=preparedId]')
          .inputValue();
        expect(replacementId).not.toBe(preparedId);
        const stale = await page.request.post(page.url(), {
          form: {
            compositionAction: 'northstar.app:action.reserve_stock',
            taskToken: entryToken,
            taskStage: 'confirm',
            preparedId,
          },
        });
        expect(await stale.text()).toContain('COMPOSITION_TASK_UNAVAILABLE');
        const refused = await page.request.post(page.url(), {
          form: {
            compositionAction: 'northstar.app:action.reserve_stock',
            taskToken: entryToken,
            taskStage: 'confirm',
            preparedId: 'forged',
          },
        });
        expect(await refused.text()).toContain('COMPOSITION_TASK_UNAVAILABLE');
        await expect(
          lines().locator('td[data-column-label="Reserved"]'),
        ).toHaveText('0');
        await capture(
          'reserve-review',
          'Review reserve 8 EA at Calgary; not confirmed',
        );
        await page
          .getByRole('button', { name: 'Confirm reservation', exact: true })
          .click();
        await expect(task()).toContainText('complete');
        if (javaScriptEnabled) {
          await page.keyboard.press('Escape');
          await expect(task()).not.toBeVisible();
          await expect(
            page.getByRole('button', {
              name: 'View task outcome',
              exact: true,
            }),
          ).toBeFocused();
          await expect(reservations()).toContainText('Calgary warehouse');
          await page.keyboard.press('Enter');
          await expect(task()).toContainText('complete');
        }
        await page
          .getByRole('link', { name: 'Back to order', exact: true })
          .click();
        const totals = async (expected: string[]) => {
          for (const [index, label] of [
            'On hand',
            'Reserved stock',
            'Available',
          ].entries())
            await expect(
              reservations().locator(`td[data-column-label="${label}"]`),
            ).toHaveText(expected[index]!);
        };
        await totals(['10', '8', '2']);
        await capture('reserved', 'Released; stock 10/8/2; reservation 8 EA');
        await reservations()
          .getByRole('link', { name: 'Select', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Ship reserved stock', exact: true })
          .click();
        await page.getByLabel(/^Quantity to (?:reserve|ship)$/).fill('5');
        await page.getByLabel('Carrier', { exact: true }).fill('Purolator');
        await page
          .getByLabel('Tracking or BOL number', { exact: true })
          .fill('PUR-META-5');
        await page
          .getByRole('button', {
            name: 'Review shipment',
            exact: true,
          })
          .click();
        await capture(
          'ship-review',
          'Review ship 5 EA from explicit reservation; not confirmed',
        );
        await page
          .getByRole('button', {
            name: 'Confirm shipment',
            exact: true,
          })
          .click();
        await expect(task()).toContainText('complete');
        await page
          .getByRole('link', { name: 'Back to order', exact: true })
          .click();
        await totals(['5', '3', '2']);
        await capture(
          'partially-shipped',
          'Released; stock 5/3/2; shipped 5 EA, reservation remaining 3 EA',
        );
        await expect(
          lines().locator('td[data-column-label="Shipped"]'),
        ).toHaveText('5');
        await page
          .getByRole('button', { name: 'Ship reserved stock', exact: true })
          .click();
        await expect(task().locator('.composition-task-summary')).toContainText(
          '3 EA remaining in this reservation',
        );
        await expect(
          task().locator('.composition-task-summary'),
        ).not.toContainText('Ordered');
        await page.getByLabel('Quantity to ship', { exact: true }).fill('2');
        await page.getByLabel('Carrier', { exact: true }).fill('Purolator');
        await page
          .getByLabel('Tracking or BOL number', { exact: true })
          .fill('PUR-META-2');
        await capture(
          'partial-ship-entry',
          'Entry ship 2 EA; selected reservation remaining 3 EA; not dispatched',
        );
        await page
          .getByRole('button', { name: 'Review shipment', exact: true })
          .click();
        await expect(
          task().locator('.composition-task-confirmation'),
        ).toContainText('Ship 2 EA');
        await expect(
          task().locator('.composition-task-confirmation'),
        ).toContainText('Field notebook');
        await expect(
          task().locator('.composition-task-confirmation'),
        ).toContainText('Calgary warehouse');
        await capture(
          'partial-ship-review',
          'Review ship 2 EA; selected reservation remaining 3 EA; not confirmed',
        );
        await page
          .getByRole('link', { name: 'Back to order', exact: true })
          .click();
        await totals(['5', '3', '2']);
        await page.locator('.composition-context-overflow summary').click();
        await page
          .getByRole('button', { name: 'Release remainder', exact: true })
          .click();
        await page
          .getByRole('button', {
            name: 'Review release',
            exact: true,
          })
          .click();
        await page
          .getByRole('button', {
            name: 'Confirm release',
            exact: true,
          })
          .click();
        await expect(task()).toContainText('complete');
        await page
          .getByRole('link', { name: 'Back to order', exact: true })
          .click();
        await totals(['5', '0', '5']);
        await capture(
          'remainder-released',
          'Released; stock 5/0/5; ordered 10 EA, shipped 5, open 5; reservation released',
        );
        await page.screenshot({
          path: testInfo.outputPath('fulfillment-desktop.png'),
          fullPage: true,
        });
        await expect(
          page.getByRole('button', { name: 'Release remainder', exact: true }),
        ).toHaveCount(0);
        // A previous reservation selection must not override an explicit line selection.
        await lines()
          .getByRole('link', { name: 'Select', exact: true })
          .click();
        await expect(
          page.getByRole('button', { name: 'Reserve stock', exact: true }),
        ).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await expect(
          shipments().getByRole('link', { name: 'Open packing', exact: true }),
        ).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath('fulfillment-mobile.png'),
          fullPage: true,
        });
        const packingLink = page.getByRole('link', {
          name: 'Open packing',
          exact: true,
        });
        // Focus scrolls the local table; scroll the document clear of fixed shell navigation.
        await packingLink.focus();
        await page.evaluate(() => window.scrollBy(0, 128));
        const packingBounds = await packingLink.boundingBox();
        const navBounds = await page.locator('.sidebar').boundingBox();
        expect(packingBounds!.y + packingBounds!.height).toBeLessThan(
          navBounds!.y,
        );
        await packingLink.click();
        const packed = page.locator(
          '[data-composition-dataset$="dataset.packing_lines"]',
        );
        await expect(packed).toHaveAttribute('data-resolution', 'ready');
        await expect(packed.locator('tbody tr')).toHaveCount(1);
        await expect(packed).toContainText('Field notebook');
        await capture(
          'packing',
          'Posted shipment; Calgary warehouse; one packed line, Field notebook 5 EA',
        );
        await writeFile(
          testInfo.outputPath('captures.json'),
          JSON.stringify(captures, null, 2),
        );
        await page.screenshot({
          path: testInfo.outputPath('packing-mobile.png'),
          fullPage: true,
        });
        await expect(
          packed.locator('td[data-column-label="Quantity"]'),
        ).toHaveText('5');
        await expect(
          page.getByText('Calgary warehouse', { exact: true }),
        ).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page
          .getByRole('link', { name: 'Back to order', exact: true })
          .click();
        expect(new URL(page.url()).searchParams.get('record')).toBe(orderId);
      });
    });
  });
}

async function withBrowserFixture(
  run: (url: string) => Promise<void>,
): Promise<void> {
  const cwd = fileURLToPath(new URL('../../../../', import.meta.url));
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'test/helpers/meta-sales-fixture.ts',
      '--serve',
      '--verify',
    ],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let readyResolve: (url: string) => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const exited = once(child, 'exit');
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    const match = /META_SALES_URL=(.*)/.exec(output);
    if (match) readyResolve(match[1]!);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.once('error', (error) => readyReject(error));
  child.once('exit', () => readyReject(new Error(output)));
  try {
    await run(await ready);
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
  expect(output).toContain('META_SALES_VERIFIED');
}
