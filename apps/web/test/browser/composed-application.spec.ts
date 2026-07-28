import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { startComposedApplication } from '../../../api/src/composition-root.js';
import { withEphemeralPostgres } from '../../../../test/helpers/postgres.js';

const applicationNamespace = 'northstar.app';

test('composed Party, Catalog, and Location product creates and persists a real record', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const externalBaseUrl = process.env.COMPOSED_APPLICATION_BASE_URL;
  if (externalBaseUrl) {
    await productJourney(page, externalBaseUrl);
    return;
  }

  await withEphemeralPostgres('g2-p5e-browser', async ({ connection }) => {
    const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
    let application = await startComposedApplication({
      databaseUrl,
      port: 0,
      tenantSlug: 'composed-browser-tenant',
    });
    try {
      await productJourney(page, application.baseUrl);
      await application.close();
      application = await startComposedApplication({
        databaseUrl,
        port: 0,
        tenantSlug: 'composed-browser-tenant',
      });
      await page.goto(surfaceUrl(application.baseUrl, 'party_list'));
      await expect(
        page.getByRole('cell', { name: 'Browser-persisted Party' }),
      ).toBeVisible();
    } finally {
      await application.close();
    }
  });
});

async function productJourney(page: Page, baseUrl: string): Promise<void> {
  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  await expect(
    page.getByRole('link', { name: 'Party list', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Item list', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Location list', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('UNSUPPORTED_COMPONENT').first()).toBeVisible();

  await page.getByRole('link', { name: 'Item list', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Item list' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Location list', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Location list' }),
  ).toBeVisible();

  await page.goto(surfaceUrl(baseUrl, 'party_form'));
  await page.getByLabel('Party Number').fill('P-BROWSER-REAL-001');
  await page.getByLabel('Party Name').fill('Browser-persisted Party');
  await page
    .getByLabel('Party Contact Summary')
    .fill('browser-persisted@example.test');
  await page.getByRole('button', { name: 'Create record' }).click();
  await expect(page.getByRole('status')).toContainText('Create complete');

  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  await page.reload();
  await expect(
    page.getByRole('cell', { name: 'Browser-persisted Party' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'P-BROWSER-REAL-001' }),
  ).toBeVisible();
}

function surfaceUrl(baseUrl: string, localSurface: string): string {
  return `${baseUrl}/?surface=${encodeURIComponent(
    localSurface === 'party_list'
      ? `${applicationNamespace}:surface.party_list`
      : `${applicationNamespace}:surface.party_form`,
  )}`;
}
