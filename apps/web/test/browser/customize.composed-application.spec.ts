import { performance } from 'node:perf_hooks';

import { expect, test } from '@playwright/test';

import { startComposedApplication } from '../../../api/src/composition-root.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../../../../test/helpers/postgres.js';

const equipmentList = 'northstar.app:surface.custom_equipment_list';

/**
 * The non-developer path (CUSTOMIZE slices 3 and 5): on the Customize screen a
 * person describes Equipment, reads the plain diff, approves and activates it,
 * opens the new list with no restart, and rolls it back. The elapsed time from
 * opening the screen to the live list is printed for the week-6 record and
 * must stay under ten minutes.
 */
test('a person adds a record type on the Customize screen, uses it live, and rolls it back', async ({
  page,
}) => {
  test.setTimeout(900_000);
  await withEphemeralPostgres(
    'customize-browser',
    async ({ connection }) => {
      const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
      const application = await startComposedApplication({
        databaseUrl,
        port: 0,
        tenantSlug: 'customize-browser',
      });
      try {
        const started = performance.now();
        await page.goto(`${application.baseUrl}/?customize`);
        await expect(page.locator('[data-customize-live]')).toContainText(
          'The standard application',
        );
        const form = page.locator('form[data-customize-form="addRecordType"]');
        await form.locator('input[name="label"]').fill('Equipment');
        await form.locator('input[name="field_2_label"]').fill('Serial number');
        await form.locator('input[name="field_3_label"]').fill('Purchase date');
        await form.locator('select[name="field_3_type"]').selectOption('date');
        await form.locator('input[name="field_4_label"]').fill('Status');
        await form
          .locator('select[name="field_4_type"]')
          .selectOption('choice');
        await form
          .locator('input[name="field_4_options"]')
          .fill('In service, Under repair, Retired');
        await form
          .getByRole('button', { name: 'Draft this record type' })
          .click();

        await expect(
          page.locator('[data-customize-result="drafted"]'),
        ).toBeVisible({ timeout: 180_000 });
        await expect(page.locator('[data-customize-diff] pre')).toContainText(
          'New record type "Equipment" with 4 fields',
        );
        await expect(page.locator('[data-customize-diff] pre')).toContainText(
          'Status (one of "In service", "Under repair", "Retired")',
        );
        await page.getByRole('button', { name: 'Approve' }).click();
        await expect(
          page.getByRole('button', { name: 'Activate now' }),
        ).toBeVisible({ timeout: 180_000 });
        await page.getByRole('button', { name: 'Activate now' }).click();
        await expect(
          page.locator('[data-customize-result="activated"]'),
        ).toBeVisible({ timeout: 180_000 });

        await page.getByRole('link', { name: 'Open Equipment' }).click();
        await expect(page).toHaveURL(
          new RegExp(encodeURIComponent(equipmentList)),
        );
        await expect(page.locator('main')).toContainText('Equipment');
        await expect(page.locator('body')).not.toContainText('UNKNOWN_SURFACE');
        const liveMilliseconds = Math.round(performance.now() - started);
        console.log(`CUSTOMIZE_REHEARSAL_LIVE_MS ${String(liveMilliseconds)}`);
        expect(liveMilliseconds).toBeLessThan(600_000);

        await page.goto(`${application.baseUrl}/?customize`);
        await expect(page.locator('[data-customize-live]')).toContainText(
          'New record type "Equipment"',
        );
        await page
          .getByRole('button', { name: 'Roll back the latest change' })
          .click();
        await expect(
          page.locator('[data-customize-result="rolledBack"]'),
        ).toBeVisible({ timeout: 180_000 });
        const hidden = await page.goto(
          `${application.baseUrl}/?surface=${encodeURIComponent(equipmentList)}`,
        );
        expect(hidden?.status()).toBe(404);
        console.log(
          `CUSTOMIZE_REHEARSAL_TOTAL_MS ${String(Math.round(performance.now() - started))}`,
        );
      } finally {
        await application.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});
