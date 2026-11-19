import { performance } from 'node:perf_hooks';

import { expect, test } from '@playwright/test';

import { startComposedApplication } from '../../../api/src/composition-root.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../../../../test/helpers/postgres.js';

const equipmentList = 'northstar.app:surface.custom_equipment_list';

test('a rule drafted in Customize refuses an empty field on the live form until rollback', async ({
  page,
}) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  await withEphemeralPostgres(
    'customize-validation-browser',
    async ({ connection }) => {
      const app = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        tenantSlug: 'customize-validation-browser',
        port: 0,
      });
      try {
        const customize = `${app.baseUrl}/?customize`;
        const form = `${app.baseUrl}/?surface=${encodeURIComponent('northstar.app:surface.item_form')}`;
        const message = 'Enter a description before saving the item.';
        await page.goto(customize);
        const builder = page.locator('[data-customize-form="addValidation"]');
        await builder
          .getByLabel('Record type')
          .selectOption('northstar.app:entity.item');
        await builder
          .getByRole('button', { name: 'Set up validation' })
          .click();
        await page
          .locator('select[name="fieldId"]')
          .selectOption('northstar.app:field.item_description');
        await page.locator('select[name="check"]').selectOption('required');
        await page.getByLabel('Message shown when saving').fill(message);
        await page
          .getByRole('button', { name: 'Draft validation rule' })
          .click({ timeout: 180_000 });
        await expect(page.locator('[data-customize-diff]')).toContainText(
          message,
        );
        await page
          .getByRole('button', { name: 'Approve', exact: true })
          .click({ timeout: 180_000 });
        await page
          .getByRole('button', { name: 'Activate now' })
          .click({ timeout: 180_000 });
        await expect(
          page.locator('[data-customize-result="activated"]'),
        ).toBeVisible({ timeout: 180_000 });

        const itemField = (name: string) =>
          page.locator(`[name="value:northstar.app:field.item_${name}"]`);
        const makeItem = async (sku: string) => {
          await page.goto(form);
          await itemField('sku').fill(sku);
          await itemField('name').fill('Item with a validation witness');
          await itemField('base_unit').fill('EA');
          await page.getByRole('button', { name: 'Save', exact: true }).click();
        };
        await makeItem('GUARD-WEB');
        await expect(page.locator('[data-form-validation-refusal]')).toHaveText(
          message,
        );
        await expect(itemField('sku')).toHaveValue('GUARD-WEB');
        const description = itemField('description');
        await expect(description).toHaveAttribute('aria-invalid', 'true');
        await description.fill('Reviewed at receiving.');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.getByRole('status')).toContainText('Create complete');

        await page.goto(customize);
        await page
          .getByRole('button', { name: 'Roll back the latest change' })
          .click({ timeout: 180_000 });
        await expect(
          page.locator('[data-customize-result="rolledBack"]'),
        ).toBeVisible({ timeout: 180_000 });
        await makeItem('GUARD-WEB-BACK');
        await expect(page.getByRole('status')).toContainText('Create complete');
      } finally {
        await app.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});

test('Customize restricts the Archive action on a Location and rollback restores it', async ({
  page,
}) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  await withEphemeralPostgres(
    'customize-role-browser',
    async ({ connection }) => {
      const app = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        tenantSlug: 'customize-role-browser',
        seedProfile: 'distributor',
        port: 0,
      });
      try {
        const customize = `${app.baseUrl}/?customize`;
        const locations = `${app.baseUrl}/?surface=${encodeURIComponent('northstar.app:surface.location_list')}`;
        await page.goto(locations);
        await page
          .locator('[data-declared-list] tbody')
          .getByRole('link')
          .first()
          .click();
        await expect(page).toHaveURL(/location_detail/u);
        const record = page.url();
        const archive = page.getByRole('button', {
          name: 'Archive',
          exact: true,
          includeHidden: true,
        });
        await expect(archive).toHaveCount(1);

        await page.goto(customize);
        const actor = page.getByLabel('Acting as');
        await actor.selectOption('manager');
        await page.getByRole('button', { name: 'Switch person' }).click();
        await expect(actor).toHaveValue('manager');
        const editor = page.locator('[data-customize-form="narrowPermission"]');
        await editor
          .getByLabel('Role', { exact: true })
          .selectOption('local-demo-full-release');
        await editor
          .getByLabel('Action', { exact: true })
          .selectOption('northstar.app:operation.location_archive');
        await editor
          .getByRole('button', { name: 'Draft permission restriction' })
          .click({ timeout: 180_000 });
        await expect(page.locator('[data-customize-diff]')).toContainText(
          'local-demo-full-release',
        );
        await page
          .getByRole('button', { name: 'Approve', exact: true })
          .click({ timeout: 180_000 });
        await page
          .getByRole('button', { name: 'Activate now' })
          .click({ timeout: 180_000 });
        await expect(
          page.locator('[data-customize-result="activated"]'),
        ).toBeVisible({ timeout: 180_000 });
        await page.goto(record);
        await expect(archive).toHaveCount(1);
        await page.goto(customize);
        await actor.selectOption('buyer');
        await page.getByRole('button', { name: 'Switch person' }).click();
        await expect(actor).toHaveValue('buyer');
        await page.goto(record);
        await expect(archive).toHaveCount(0);

        await page.goto(customize);
        await actor.selectOption('manager');
        await page.getByRole('button', { name: 'Switch person' }).click();
        await page
          .getByRole('button', { name: 'Roll back the latest change' })
          .click({ timeout: 180_000 });
        await expect(
          page.locator('[data-customize-result="rolledBack"]'),
        ).toBeVisible({ timeout: 180_000 });
        await actor.selectOption('buyer');
        await page.getByRole('button', { name: 'Switch person' }).click();
        await page.goto(record);
        await expect(archive).toHaveCount(1);
      } finally {
        await app.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});

test('a saved Location view keeps its columns, ordering and filtered count until rollback', async ({
  page,
}) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  await withEphemeralPostgres(
    'customize-saved-view',
    async ({ connection }) => {
      const app = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        tenantSlug: 'customize-view',
        seedProfile: 'distributor',
        port: 0,
      });
      try {
        const surfaceId = 'northstar.app:surface.location_list';
        const listUrl = `${app.baseUrl}/?surface=${encodeURIComponent(surfaceId)}`;
        const warehouse = 'northstar.app:option.warehouse';
        await page.goto(listUrl);
        const grid = page.locator('[data-declared-list="true"]');
        await grid.getByLabel('Type', { exact: true }).selectOption(warehouse);
        await grid.getByRole('button', { name: 'Apply', exact: true }).click();
        const expected = await grid
          .locator('[data-list-total]')
          .getAttribute('data-list-total');
        expect(Number(expected)).toBeGreaterThan(0);

        await page.goto(`${app.baseUrl}/?customize`);
        const choose = page.locator('[data-customize-form="saveListView"]');
        await choose.getByLabel('List').selectOption(surfaceId);
        await choose.getByRole('button', { name: 'Set up view' }).click();
        const editor = page.locator('[data-customize-form="savedView"]');
        await editor.getByLabel('View name').fill('Managed warehouses');
        await editor.getByLabel('Position of Code').fill('2');
        await editor.getByLabel('Position of Name').fill('1');
        await editor.getByLabel('Hide Type').check();
        await editor.getByLabel('Hide Status reason').check();
        await editor
          .getByLabel('Sort by', { exact: true })
          .selectOption({ label: 'Name' });
        await editor
          .locator('[name="view_sort_direction_1"]')
          .selectOption('descending');
        await editor
          .getByLabel('Type', { exact: true })
          .selectOption(warehouse);
        await editor
          .getByRole('button', { name: 'Draft view' })
          .click({ timeout: 180_000 });
        await expect(page.locator('[data-customize-diff]')).toContainText(
          'Type is Warehouse',
        );
        await page
          .getByRole('button', { name: 'Approve', exact: true })
          .click({ timeout: 180_000 });
        await page
          .getByRole('button', { name: 'Activate now' })
          .click({ timeout: 180_000 });
        await expect(
          page.locator('[data-customize-result="activated"]'),
        ).toBeVisible({ timeout: 180_000 });

        await page.goto(listUrl);
        const saved = page
          .getByRole('navigation', { name: 'Views' })
          .getByRole('link', { name: /^Managed warehouses\b/u });
        await expect(saved.locator('[data-view-count]')).toHaveText(expected!);
        await saved.click();
        await expect(saved).toHaveAttribute('aria-current', 'page');
        await expect(grid.locator('[data-list-total]')).toHaveAttribute(
          'data-list-total',
          expected!,
        );
        const headings = grid
          .getByRole('columnheader')
          .filter({ hasNotText: /^(?:Select|Actions)$/u });
        await expect(headings.first()).toHaveAccessibleName(/^Name\b/u);
        await expect(headings.nth(1)).toHaveAccessibleName(/^Code\b/u);
        await expect(headings.first()).toHaveAttribute(
          'aria-sort',
          'descending',
        );
        await expect(headings.filter({ hasText: /^Type\b/u })).toHaveCount(0);

        await page.goto(`${app.baseUrl}/?customize`);
        await page
          .getByRole('button', { name: 'Roll back the latest change' })
          .click({ timeout: 180_000 });
        await expect(
          page.locator('[data-customize-result="rolledBack"]'),
        ).toBeVisible({ timeout: 180_000 });
        await page.goto(listUrl);
        await expect(saved).toHaveCount(0);
        await expect(headings.first()).toHaveAccessibleName(/^Code\b/u);
      } finally {
        await app.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});

test('a person adds a count to Today, opens its list and rolls it back', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await withEphemeralPostgres(
    'customize-metric-browser',
    async ({ connection }) => {
      const app = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        tenantSlug: 'customize-metric-browser',
        seedProfile: 'distributor',
        port: 0,
      });
      try {
        await page.goto(`${app.baseUrl}/?customize`);
        const picker = page.locator('[data-customize-form="addMetricCard"]');
        await picker
          .getByLabel('List')
          .selectOption('northstar.app:surface.location_list');
        await picker.getByRole('button', { name: 'Set up metric' }).click();
        await page.getByLabel('Card name').fill('Location count');
        await page.getByRole('button', { name: 'Draft metric' }).click();
        await expect(page.locator('[data-customize-diff]')).toContainText(
          'counts records in Locations',
        );
        await page
          .getByRole('button', { name: 'Approve', exact: true })
          .click({ timeout: 180_000 });
        await page
          .getByRole('button', { name: 'Activate now' })
          .click({ timeout: 180_000 });
        await expect(
          page.locator('[data-customize-result="activated"]'),
        ).toBeVisible({ timeout: 180_000 });
        await page.goto(app.baseUrl);
        const metric = page.getByRole('link', { name: /^Location count/u });
        const count = await metric
          .locator('.launcher-tile__count')
          .textContent();
        expect(Number(count)).toBeGreaterThan(0);
        await metric.click();
        await expect(page.locator('[data-list-total]')).toHaveAttribute(
          'data-list-total',
          count!,
        );
        await page.goto(`${app.baseUrl}/?customize`);
        await page
          .getByRole('button', { name: 'Roll back the latest change' })
          .click();
        await expect(
          page.locator('[data-customize-result="rolledBack"]'),
        ).toBeVisible({ timeout: 180_000 });
        await page.goto(app.baseUrl);
        await expect(metric).toHaveCount(0);
      } finally {
        await app.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});

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
              ['Vendor', 'Cascade', 'Cascade Fastener Works'],
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
            await page.goto(surface('list') + '&q=C2-PARTY');
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
          if (target === 'purchase_order') {
            await page.goto(app.baseUrl + '/?customize');
            const chooser = page.locator(
              '[data-customize-form="arrangeLayout"]',
            );
            await chooser
              .locator('[name="arrange"]')
              .selectOption('northstar.app:surface.purchase_order_list');
            await chooser
              .getByRole('button', { name: 'Choose columns' })
              .click();
            const arrangement = page.locator(
              '[data-customize-form="arrangeColumns"]',
            );
            for (const label of ['Person ordering', 'Notes']) {
              await arrangement
                .getByLabel('Hide ' + label, { exact: true })
                .uncheck();
            }
            await arrangement
              .getByRole('button', { name: 'Draft this arrangement' })
              .click();
            await page
              .getByRole('button', { name: 'Approve', exact: true })
              .click({ timeout: 180_000 });
            await page
              .getByRole('button', { name: 'Activate now' })
              .click({ timeout: 180_000 });
            await expect(
              page.locator('[data-customize-result="activated"]'),
            ).toBeVisible({ timeout: 180_000 });
            await page.goto(surface('list'));
            const grid = page.locator('[data-declared-list="true"]');
            const personOrdering = grid.getByRole('columnheader', {
              name: /^Person ordering\b/u,
            });
            const notes = grid.getByRole('columnheader', { name: /^Notes\b/u });
            await expect(personOrdering).toBeVisible();
            await expect(notes).toBeVisible();
            await expect(
              grid.getByRole('cell', { name: 'Morgan Bell', exact: true }),
            ).toBeVisible();
            await page.goto(app.baseUrl + '/?customize');
            await page
              .getByRole('button', { name: 'Roll back the latest change' })
              .click();
            await expect(
              page.locator('[data-customize-result="rolledBack"]'),
            ).toBeVisible({ timeout: 180_000 });
            await page.goto(surface('list'));
            await expect(grid.getByRole('columnheader').first()).toBeVisible();
            await expect(personOrdering).toHaveCount(0);
            await expect(notes).toHaveCount(0);
          }
        } finally {
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  });
}
