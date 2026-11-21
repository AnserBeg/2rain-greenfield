import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('dispatchers pan just the map, return with Back and can open each stop with the keyboard at 390 px', async ({
  browser,
  page,
}) => {
  test.setTimeout(900000);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/helpers/planner-map-fixture.ts', '--serve'],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  );
  const exit = once(child, 'exit');
  const ready = new Promise<string>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (bytes) => {
      output += String(bytes);
      const match = /PLANNER_MAP_URL=([^\n]+)\n/u.exec(output);
      if (match) resolve(match[1]!);
    });
    child.once('exit', (code) =>
      reject(new Error('Map fixture exited ' + code)),
    );
  });
  try {
    const url = await ready;
    const response = await page.goto(url);
    const region = page.locator('[data-surface-archetype="map"]'),
      svg = region.locator('[data-map-drag]');
    await expect(svg.locator('a')).toHaveCount(2);
    const script = await page.locator('script').allTextContents();
    expect(script).toHaveLength(1);
    expect(response?.headers()['content-security-policy']).toContain(
      'sha256-' + createHash('sha256').update(script[0]!).digest('base64'),
    );
    const sidebar = await page.locator('aside,nav').first().elementHandle();
    const heading = region.locator('h1'),
      origin = await heading.getAttribute('data-map-state');
    const north = region.getByRole('link', { name: 'North', exact: true });
    await north.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/area=1/u);
    await expect(north).toBeFocused();
    expect(await sidebar?.evaluate((el) => el.isConnected)).toBe(true);
    await page.goBack();
    await expect(heading).toHaveAttribute('data-map-state', origin!);
    await expect(svg.locator('line.map-route')).toHaveCount(1);
    await expect(svg.getByRole('link', { name: '1. Warehouse' })).toHaveCount(
      1,
    );
    await expect(svg.getByRole('link', { name: '2. Pickup' })).toHaveCount(1);

    // Release the older reply while the newer navigation is still in flight.
    // Both requests start on the same connected region.
    const older = Promise.withResolvers<void>();
    const newer = Promise.withResolvers<void>();
    const sent = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let requests = 0;
    await page.route('**/*', async (route) => {
      if (route.request().headers()['x-rain-fragment'] !== 'map')
        return route.continue();
      const index = requests++;
      const reply = await route.fetch();
      sent[index]!.resolve();
      await (index === 0 ? older.promise : newer.promise);
      await route.fulfill({ response: reply });
    });
    try {
      await north.click();
      await sent[0]!.promise;
      const south = region.getByRole('link', { name: 'South', exact: true });
      const latest = await south.getAttribute('href');
      await south.click();
      await sent[1]!.promise;
      const oldReply = page.waitForResponse(
        (r) => r.request().headers()['x-rain-fragment'] === 'map',
      );
      older.resolve();
      await (await oldReply).finished();
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      await expect(heading).toHaveAttribute('data-map-state', origin!);
      newer.resolve();
      await expect(heading).toHaveAttribute('data-map-state', latest!);
      await expect(south).toBeFocused();
      await page.unrouteAll({ behavior: 'wait' });
      await page.goBack();
      await expect(heading).toHaveAttribute('data-map-state', origin!);
    } finally {
      older.resolve();
      newer.resolve();
      await page.unrouteAll({ behavior: 'wait' });
    }
    const box = await svg.boundingBox();
    expect(box).toBeTruthy();
    const x = box!.x + 4,
      y = box!.y + 4;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 50, y + 25);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(heading).toHaveAttribute('data-map-state', origin!);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y + 25);
    await page.mouse.up();
    await expect(page).toHaveURL(/area=1/u);
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width, height: 820 },
      });
      try {
        const tab = await context.newPage();
        await tab.goto(url);
        const list = tab.locator('.map-list'),
          canvas = tab.locator('.map-canvas');
        if (width === 390)
          expect((await list.boundingBox())!.y).toBeLessThan(
            (await canvas.boundingBox())!.y,
          );
        const route = tab.getByRole('combobox', { name: 'Route' });
        await route.selectOption({ label: 'North' });
        await tab.getByRole('button', { name: 'Apply filters' }).press('Enter');
        await expect(list.getByRole('link')).toHaveCount(2);
        if (width === 390) {
          await tab.getByRole('button', { name: 'Apply filters' }).focus();
          await tab.keyboard.press('Tab');
          await expect(list.getByRole('link').first()).toBeFocused();
        }
        for (const [size, width, height] of [
          ['small', 320, 240],
          ['medium', 768, 512],
          ['large', 1024, 640],
        ] as const) {
          await tab.getByLabel('Map size').selectOption(size);
          await tab
            .getByRole('button', { name: 'Apply filters' })
            .press('Enter');
          await expect(canvas.locator('svg')).toHaveAttribute(
            'viewBox',
            `0 0 ${width} ${height}`,
          );
        }
        const zoom = canvas.getByRole('link', { name: 'Zoom out' });
        await zoom.focus();
        await tab.keyboard.press('Enter');
        await expect(tab).toHaveURL(/area=1/u);
        const pin = tab.locator('[data-map-drag] a').first();
        await pin.focus();
        await tab.keyboard.press('Enter');
        await expect(tab).toHaveURL(/[?&]record=/u);
        await expect(
          tab.locator('[data-surface-archetype="record"]').first(),
        ).toBeVisible();
      } finally {
        await context.close();
      }
    }
  } finally {
    child.stdin.end();
    await exit;
  }
});
