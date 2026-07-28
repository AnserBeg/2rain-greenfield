import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type pg from 'pg';

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

  await withEphemeralPostgres(
    'g2-p5da-browser',
    async ({ connection, pool }) => {
      const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
      let application = await startComposedApplication({
        databaseUrl,
        port: 0,
        tenantSlug: 'composed-browser-tenant',
      });
      try {
        await assertSeedTrust(pool, application);
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
    },
  );
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
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-platform-slot="list:title"]')).toBeVisible();
  await expect(
    page.locator('[data-platform-slot="list:dataGrid"]'),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Alpine Office Supply' }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Item list', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Item list' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Field notebook' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Location list', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Location list' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Calgary warehouse' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);

  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  await page.getByRole('link', { name: 'New', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'New Party' }),
  ).toBeVisible();
  await page.getByLabel('Party Number').fill('P-BROWSER-REAL-001');
  await page.getByLabel('Party Name').fill('Browser-persisted Party');
  await page
    .getByLabel('Party Contact Summary')
    .fill('browser-persisted@example.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Create complete');
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);

  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  await page.reload();
  await expect(
    page.getByRole('cell', { name: 'Browser-persisted Party' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'P-BROWSER-REAL-001' }),
  ).toBeVisible();
  const createdRow = page.locator('tr', { hasText: 'Browser-persisted Party' });
  await createdRow.getByRole('link').click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Party' }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' }),
  ).toContainText('Party list');
  await expect(
    page.getByText('P-BROWSER-REAL-001', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Edit Party' }),
  ).toBeVisible();
  await page
    .getByLabel('Party Contact Summary')
    .fill('updated-after-navigation@example.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Update complete');
}

function surfaceUrl(baseUrl: string, localSurface: string): string {
  return `${baseUrl}/?surface=${encodeURIComponent(`${applicationNamespace}:surface.${localSurface}`)}`;
}

async function assertSeedTrust(
  pool: pg.Pool,
  application: Awaited<ReturnType<typeof startComposedApplication>>,
): Promise<void> {
  expect(application.seededRecords).toHaveLength(12);
  for (const seed of application.seededRecords) {
    const linked = await pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM platform.trust_action_invocations AS invocation
         JOIN platform.trust_business_change_documents AS change
           ON change.tenant_id = invocation.tenant_id
          AND change.environment_id = invocation.environment_id
          AND change.invocation_id = invocation.invocation_id
         JOIN platform.trust_domain_events AS event
           ON event.tenant_id = invocation.tenant_id
          AND event.environment_id = invocation.environment_id
          AND event.invocation_id = invocation.invocation_id
         JOIN platform.trust_outbox AS outbox
           ON outbox.tenant_id = invocation.tenant_id
          AND outbox.environment_id = invocation.environment_id
          AND outbox.invocation_id = invocation.invocation_id
        WHERE invocation.tenant_id = $1
          AND invocation.environment_id = $2
          AND invocation.invocation_id = $3
          AND invocation.change_document_id = $4
          AND invocation.domain_event_id = $5
          AND invocation.outbox_id = $6`,
      [
        application.runtime.identity.tenantId,
        application.runtime.identity.environmentId,
        seed.trust.invocationId,
        seed.trust.changeDocumentId,
        seed.trust.domainEventId,
        seed.trust.outboxId,
      ],
    );
    expect(linked.rows[0]?.count).toBe('1');
  }
}
