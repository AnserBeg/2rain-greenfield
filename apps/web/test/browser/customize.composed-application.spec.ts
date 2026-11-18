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

for (const target of ['purchase_order', 'party'] as const) {
  test(`a field added to ${target} can be entered under More details and read on the saved record`, async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await withEphemeralPostgres(
      'customize-' + target.replaceAll('_', '-'),
      async ({ connection }) => {
        const app = await startComposedApplication({
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'customize-field',
          port: 0,
          seedProfile: 'distributor',
        });
        try {
          await page.goto(app.baseUrl + '/?customize');
          const form = page.locator('[data-customize-form="addField"]');
          await form
            .locator('[name="entity"]')
            .selectOption('northstar.app:entity.' + target);
          await form.locator('[name="field_1_label"]').fill('Person ordering');
          await form.getByRole('button', { name: 'Draft this field' }).click();
          await page
            .getByRole('button', { name: 'Approve', exact: true })
            .click({ timeout: 180_000 });
          await page
            .getByRole('button', { name: 'Activate now' })
            .click({ timeout: 180_000 });
          await expect(
            page.locator('[data-customize-result="activated"]'),
          ).toBeVisible({ timeout: 180_000 });
          const surface = (role: string) =>
            app.baseUrl +
            '/?surface=' +
            encodeURIComponent('northstar.app:surface.' + target + '_' + role);
          await page.goto(surface('list'));
          await page.getByRole('link', { name: 'New', exact: true }).click();
          if (target === 'purchase_order') {
            for (const [label, term, result] of [
              ['Vendor', 'Alpine', 'Alpine Office Supply'],
              ['Line 1 product', 'OFF-100', 'Field notebook'],
            ] as const) {
              const box = page.getByRole('combobox', {
                name: label,
                exact: true,
              });
              await box.fill(term);
              await page
                .getByRole('option')
                .filter({ hasText: result })
                .click();
              await expect(box).toHaveAttribute('data-selected-label', result);
            }
            await page.getByLabel('Order date *').fill('2026-11-18');
            await page.getByLabel('Line 1 quantity', { exact: true }).fill('2');
            await page
              .getByLabel('Line 1 unit cost', { exact: true })
              .fill('12.5');
          } else {
            await page.getByLabel('Number', { exact: true }).fill('C2-PARTY');
            await page
              .getByLabel('Name', { exact: true })
              .fill('CUSTOMIZE-2 Party');
          }
          const details = page.locator('details').filter({
            has: page.getByLabel('Person ordering', { exact: true }),
          });
          await expect(details.locator('summary')).toContainText(
            'More details',
          );
          await details.locator('summary').click();
          await details
            .getByLabel('Person ordering', { exact: true })
            .fill('Morgan Bell');
          await page
            .getByRole('button', {
              name: target === 'party' ? 'Save' : 'Save draft',
              exact: true,
            })
            .click();
          if (target === 'party') {
            await expect(
              page.getByRole('status').filter({ hasText: 'Create complete' }),
            ).toBeVisible();
            await page.goto(surface('list'));
            await page.getByRole('link', { name: /C2-PARTY/u }).click();
          }
          await expect(page).toHaveURL(new RegExp(target + '_detail', 'u'));
          const panel = page.locator('[data-composition-fields]');
          const more = panel
            .locator('details')
            .filter({ has: page.getByText('Morgan Bell', { exact: true }) });
          if (await more.count()) await more.locator('summary').click();
          await expect(
            panel.getByText('Person ordering', { exact: true }),
          ).toBeVisible();
          await expect(
            panel.getByText('Morgan Bell', { exact: true }),
          ).toBeVisible();
        } finally {
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  });
}
