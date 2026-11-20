import { expect, test } from '@playwright/test';

import { startComposedApplication } from '../../../api/src/composition-root.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../../../../test/helpers/postgres.js';

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
        const literal = page.locator('form').filter({
          has: page.getByRole('button', { name: 'Draft validation rule' }),
        });
        await literal
          .locator('select[name="fieldId"]')
          .selectOption('northstar.app:field.item_description');
        await literal.locator('select[name="check"]').selectOption('required');
        await literal.getByLabel('Message shown when saving').fill(message);
        await literal
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
