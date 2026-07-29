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
  const navigation = page.getByRole('navigation', {
    name: 'Release navigation',
  });
  await expect(navigation.locator('a > span:nth-child(2)')).toHaveText([
    'Item',
    'Location',
    'Party',
    'Party role',
  ]);
  await expect(
    navigation.getByRole('link', { name: /detail|form/i }),
  ).toHaveCount(0);
  await expect(
    navigation.getByRole('link', { name: 'Party', exact: true }),
  ).toBeVisible();
  await expect(
    navigation.getByRole('link', { name: 'Item', exact: true }),
  ).toBeVisible();
  await expect(
    navigation.getByRole('link', { name: 'Location', exact: true }),
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
  const responsiveList = page.locator(
    '[data-list-rendering="responsive-single"]',
  );
  const firstResponsiveRow = responsiveList
    .locator('tr[data-compact-card="true"]')
    .first();
  await expect(responsiveList).toHaveCount(1);
  await expect(firstResponsiveRow).toHaveCSS('display', 'table-row');
  const priorities = await firstResponsiveRow
    .locator('[data-column-priority]')
    .evaluateAll((cells) =>
      cells.map((cell) => Number(cell.getAttribute('data-column-priority'))),
    );
  expect(priorities).toEqual(
    [...priorities].sort((left, right) => left - right),
  );

  const bulkBar = page.locator(
    '[data-platform-slot="list:bulkActions"] [data-bulk-selection-form]',
  );
  const firstSelector = firstResponsiveRow.getByRole('checkbox');
  await expect(bulkBar.getByText('Select records to begin')).toBeVisible();
  await expect(bulkBar.getByText('Selection ready')).toBeHidden();
  await firstSelector.check();
  await expect(bulkBar.getByText('Selection ready')).toBeVisible();
  await bulkBar.getByRole('button', { name: 'Clear selection' }).click();
  await expect(firstSelector).not.toBeChecked();

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(responsiveList).toHaveCount(1);
  await expect(firstResponsiveRow).toHaveCSS('display', 'grid');
  await expect(page.locator('.sidebar')).toHaveCSS('position', 'fixed');
  await expect(page.locator('.sidebar')).toHaveCSS('bottom', '0px');
  expect(await navigation.getByRole('link').count()).toBeLessThanOrEqual(5);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ height: 720, width: 1280 });

  await navigation.getByRole('link', { name: 'Item', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Item list' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Field notebook' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);
  await navigation.getByRole('link', { name: 'Location', exact: true }).click();
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
  await expect(
    page.locator('[data-platform-slot="record:keyFacts"]'),
  ).toContainText('New record');
  await expect(
    page.locator('[data-platform-slot="record:sections"]'),
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
  const createdRecordId = await createdRow.getAttribute('data-record-id');
  expect(createdRecordId).not.toBeNull();
  await createdRow.getByRole('link').click();
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Browser-persisted Party',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' }),
  ).toContainText('Party list');
  const keyFactsSlot = page.locator('[data-platform-slot="record:keyFacts"]');
  const sectionsSlot = page.locator('[data-platform-slot="record:sections"]');
  await expect(
    sectionsSlot.getByText('P-BROWSER-REAL-001', { exact: true }),
  ).toBeVisible();
  await expect(keyFactsSlot).toContainText('Revision');
  await expect(keyFactsSlot.locator('[data-field-id]')).toHaveCount(0);
  await expect(keyFactsSlot).not.toContainText(
    'browser-persisted@example.test',
  );
  await expect(sectionsSlot.locator('[data-field-id]')).toHaveCount(3);
  await expect(sectionsSlot).toContainText('browser-persisted@example.test');
  await page.setViewportSize({ height: 844, width: 390 });
  const compactSections = page.locator(
    '[data-platform-slot="record:sections"] details.record-section-group',
  );
  await expect(compactSections).toHaveAttribute('open', '');
  await expect(
    page.locator('[data-platform-slot="record:commandBar"] .command-bar'),
  ).toHaveCSS('position', 'sticky');
  const compactSectionSummary = compactSections.locator('summary');
  await compactSectionSummary.focus();
  await page.keyboard.press('Enter');
  await expect(compactSections).not.toHaveAttribute('open', '');
  await page.setViewportSize({ height: 720, width: 1280 });
  await expect(compactSectionSummary).toBeVisible();
  await compactSectionSummary.focus();
  await page.keyboard.press('Enter');
  await expect(compactSections).toHaveAttribute('open', '');
  await expect(
    compactSections.getByText('browser-persisted@example.test'),
  ).toBeVisible();
  const overflow = page.locator(
    '[data-platform-slot="record:commandBar"] details.action-overflow',
  );
  const archive = page.getByRole('button', { name: 'Archive' });
  await expect(overflow).toBeVisible();
  await expect(archive).toBeHidden();
  await overflow.locator('summary').click();
  await expect(archive).toBeVisible();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Edit Party' }),
  ).toBeVisible();
  await page
    .getByLabel('Party Contact Summary')
    .fill('updated-after-navigation@example.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Update complete');

  const detailUrl = `${surfaceUrl(baseUrl, 'party_detail')}&record=${encodeURIComponent(createdRecordId ?? '')}`;
  await page.goto(detailUrl);
  const archiveOverflow = page.locator(
    '[data-platform-slot="record:commandBar"] details.action-overflow',
  );
  await archiveOverflow.locator('summary').click();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirm Archive' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm Archive' }).click();
  await expect(page.getByRole('status')).toContainText('Archive complete');
  await expect(page.getByText(/Archived · revision 3/)).toBeVisible();

  await page.goto(detailUrl);
  await expect(
    page.locator('[data-diagnostic-code="QUERY_NOT_FOUND"]'),
  ).toHaveCount(1);
  await expect(page.locator('[data-platform-slot^="record:"]')).toHaveCount(0);

  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  await expect(
    page.locator('tr', { hasText: 'Browser-persisted Party' }),
  ).toHaveCount(0);
  const showArchived = page.getByRole('link', { name: 'Show archived' });
  await expect(showArchived).toBeVisible();
  await showArchived.click();
  const archivedRow = page.locator('tr', {
    hasText: 'Browser-persisted Party',
  });
  await expect(
    archivedRow.getByText('Archived', { exact: true }),
  ).toBeVisible();
  const hideArchived = page.getByRole('link', { name: 'Hide archived' });
  await expect(hideArchived).toBeVisible();
  await hideArchived.click();
  await expect(
    page.locator('tr', { hasText: 'Browser-persisted Party' }),
  ).toHaveCount(0);
  await expect(showArchived).toBeVisible();
  await showArchived.click();
  await expect(archivedRow).toBeVisible();
  await archivedRow.getByRole('link').click();
  await expect(page).toHaveURL(/(?:\?|&)archived=yes(?:&|$)/);
  await expect(page.getByText(/Archived · revision 3/)).toBeVisible();
  const restoreOverflow = page.locator(
    '[data-platform-slot="record:commandBar"] details.action-overflow',
  );
  await restoreOverflow.locator('summary').click();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('status')).toContainText('Restore complete');

  await page.goto(detailUrl);
  await expect(page.getByText(/Active · revision 4/)).toBeVisible();
  await expect(
    page.getByText('updated-after-navigation@example.test', { exact: true }),
  ).toBeVisible();
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
