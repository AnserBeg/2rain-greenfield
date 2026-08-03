import type { Server } from 'node:http';

import { expect, test } from '@playwright/test';

import { createSurfaceRuntimeServer } from '../../src/app-server.js';
import { readDemoCompiledFixture } from '../../src/demo-runtime.js';
import { compiledFixturePath, demoEntry } from '../helpers.js';

let server: Server;
let baseUrl: string;

test.beforeAll(async () => {
  server = createSurfaceRuntimeServer(demoEntry());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('browser server did not bind a TCP address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('signed-in shell follows compiled navigation and preserves the pinned release', async ({
  page,
}) => {
  const surfaces = compiledSurfaces();
  await page.goto(baseUrl);

  await expect(
    page.getByRole('navigation', { name: 'Release navigation' }),
  ).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByLabel('Signed-in principal')).toContainText(
    'Signed in',
  );
  await expect(page.locator('nav a > span:nth-child(2)')).toHaveText(
    surfaces.map((surface) => surface.label),
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    surfaces[0]?.label ?? '',
  );
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-pointer-fence',
    '7',
  );

  const setup = surfaces.find((surface) => surface.label === 'Setup');
  if (!setup) throw new Error('compiled setup surface is missing');
  await page.getByRole('link', { name: setup.label }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(setup.label);
  await expect(page.locator('nav a[aria-current="page"]')).toContainText(
    setup.label,
  );
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-release-content-hash',
    /^[0-9a-f]{64}$/,
  );
});

test('compiled unsupported and renderer-failure surfaces remain usable diagnostics', async ({
  page,
}) => {
  const surfaces = compiledSurfaces();
  const unsupported = surfaces.find((surface) =>
    surface.slots.some(
      (slot) =>
        slot.contentReferenceId === 'northstar.shell:component.future_insights',
    ),
  );
  const failing = surfaces.find((surface) =>
    surface.slots.some(
      (slot) =>
        slot.contentReferenceId === 'northstar.shell:component.error_probe',
    ),
  );
  if (!unsupported) throw new Error('compiled unsupported surface is missing');
  if (!failing) throw new Error('compiled renderer-error surface is missing');

  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(unsupported.surfaceId)}`,
  );
  await expect(page.getByRole('alert')).toContainText(
    'Unsupported release capability',
  );
  await expect(page.getByRole('alert')).toContainText('UNSUPPORTED_COMPONENT');
  await expect(page.getByRole('navigation')).toBeVisible();

  await page.getByRole('link', { name: failing.label }).click();
  await expect(page.getByRole('alert')).toContainText('Component unavailable');
  await expect(page.getByRole('alert')).toContainText(
    'COMPONENT_RENDER_FAILED',
  );
  await expect(page.getByRole('navigation')).toBeVisible();
});

test('unknown surfaces remain page-level diagnostics before slot composition', async ({
  page,
}) => {
  const response = await page.goto(`${baseUrl}/?surface=not-in-release`);
  expect(response?.status()).toBe(404);
  await expect(
    page.locator(
      '.diagnostic--page[role="alert"][data-diagnostic-code="UNKNOWN_SURFACE"]',
    ),
  ).toBeVisible();
  await expect(page.locator('[data-platform-slot]')).toHaveCount(0);
});

test('shell exposes a keyboard-first semantic path', async ({ page }) => {
  await page.goto(baseUrl);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('navigation')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.locator('main')).toHaveAttribute('tabindex', '-1');
});

interface FixtureSurface {
  readonly label: string;
  readonly slots: readonly {
    readonly contentReferenceId: string;
  }[];
  readonly surfaceId: string;
}

function compiledSurfaces(): readonly FixtureSurface[] {
  const fixture = readDemoCompiledFixture(compiledFixturePath);
  const projections = fixture.projections as Record<string, unknown>;
  const surfaceProjection = projections.surface as Record<string, unknown>;
  const payload = surfaceProjection.payload as Record<string, unknown>;
  return payload.surfaces as unknown as readonly FixtureSurface[];
}
