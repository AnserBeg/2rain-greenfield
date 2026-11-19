import { expect, test } from '@playwright/test';

import { startComposedApplication } from '../../../api/src/composition-root.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../../../../test/helpers/postgres.js';

test('Customize compares a location name with its declared parent on the live form', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await withEphemeralPostgres(
    'customize-relation-guard-browser',
    async ({ connection }) => {
      const app = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        tenantSlug: 'customize-relation-guard-browser',
        port: 0,
      });
      try {
        const customize = `${app.baseUrl}/?customize`;
        const form = `${app.baseUrl}/?surface=${encodeURIComponent('northstar.app:surface.location_form')}`;
        const nameId = 'northstar.app:field.location_name';
        const parentId = 'northstar.app:relation.location_parent';
        const parentName = 'Northbound warehouse';
        const message =
          'Give the inside location a different name from its parent.';
        const parent = page.locator(`[name="relation:${parentId}"]`);
        const fillLocation = async (
          code: string,
          name: string,
          inside?: string,
        ) => {
          await page.goto(form);
          await page
            .locator('[name="value:northstar.app:field.location_code"]')
            .fill(code);
          await page.locator(`[name="value:${nameId}"]`).fill(name);
          await page
            .getByRole('combobox', { name: 'Type', exact: true })
            .fill('northstar.app:option.store');
          if (inside) await parent.selectOption(inside);
        };
        const save = () =>
          page.getByRole('button', { name: 'Save', exact: true }).click();
        await fillLocation('GUARD-PARENT', parentName);
        await save();
        await expect(page.getByRole('status')).toContainText('Create complete');
        await page.goto(
          `${app.baseUrl}/?surface=${encodeURIComponent('northstar.app:surface.location_list')}`,
        );
        const parentRecord = await page
          .getByRole('row')
          .filter({ has: page.getByText(parentName, { exact: true }) })
          .getAttribute('data-record-id');
        if (!parentRecord)
          throw new Error('The new parent location is missing from Locations.');

        await page.goto(customize);
        const picker = page.locator('[data-customize-form="addValidation"]');
        await picker
          .getByLabel('Record type')
          .selectOption('northstar.app:entity.location');
        await picker.getByRole('button', { name: 'Set up validation' }).click();
        const comparison = page.locator(
          '[data-customize-form="compareValidationFields"]',
        );
        await comparison.locator('select[name="fieldId"]').selectOption(nameId);
        await comparison
          .locator('select[name="operator"]')
          .selectOption('notEqual');
        await comparison
          .locator('select[name="otherField"]')
          .selectOption(`${parentId}/${nameId}`);
        await comparison
          .getByLabel('Message when the comparison fails')
          .fill(message);
        await comparison
          .getByRole('button', { name: 'Draft field comparison' })
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

        await fillLocation('GUARD-CHILD', parentName, parentRecord);
        const selected = await parent.inputValue();
        await save();
        await expect(page.locator('[data-form-validation-refusal]')).toHaveText(
          message,
        );
        await expect(parent).toHaveValue(selected);
        await page.locator(`[name="value:${nameId}"]`).fill('Northbound bin');
        await save();
        await expect(page.getByRole('status')).toContainText('Create complete');

        await page.goto(customize);
        await page
          .getByRole('button', { name: 'Roll back the latest change' })
          .click({ timeout: 180_000 });
        await expect(
          page.locator('[data-customize-result="rolledBack"]'),
        ).toBeVisible({ timeout: 180_000 });
        await fillLocation('GUARD-BACK', parentName, parentRecord);
        await save();
        await expect(page.getByRole('status')).toContainText('Create complete');
      } finally {
        await app.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});

test('Customize shows exact margin on Items and the item page and removes it on rollback', async ({
  page,
}) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  await withEphemeralPostgres(
    'customize-calculated-display-browser',
    async ({ connection }) => {
      const app = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        tenantSlug: 'customize-calculated-display-browser',
        port: 0,
      });
      try {
        const customize = `${app.baseUrl}/?customize`;
        const surface = (id: string) =>
          `${app.baseUrl}/?surface=${encodeURIComponent('northstar.app:surface.' + id)}`;
        const title = 'Margin CAD';
        const itemName = 'Margin example item';
        const margin = '0.999999999999999999';
        await page.goto(surface('item_form'));
        const itemField = (name: string) =>
          page.locator(`[name="value:northstar.app:field.item_${name}"]`);
        await itemField('sku').fill('MARGIN-WEB');
        await itemField('name').fill(itemName);
        await itemField('base_unit').fill('EA');
        if (!(await itemField('price_cad').isVisible()))
          await page.locator('details.draft-more summary').click();
        await itemField('price_cad').fill('1.230000000000000001');
        await itemField('standard_cost_cad').fill('0.230000000000000002');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.getByRole('status')).toContainText('Create complete');

        await page.goto(customize);
        const builder = page.locator(
          '[data-customize-form="calculatedDisplayPicker"]',
        );
        await builder
          .getByLabel('Record page')
          .selectOption('northstar.app:surface.item_detail');
        await builder
          .getByRole('button', { name: 'Set up calculation' })
          .click();
        const form = page.locator('[data-customize-form="calculatedDisplay"]');
        await form.getByLabel('Field name').fill(title);
        await form
          .getByLabel('First field')
          .selectOption('northstar.app:field.item_price_cad');
        await form.getByLabel('Operation').selectOption('subtract');
        await form
          .getByLabel('Second field')
          .selectOption('northstar.app:field.item_standard_cost_cad');
        await form
          .getByLabel('Also show on a list')
          .selectOption('northstar.app:surface.item_list');
        await form
          .getByRole('button', { name: 'Draft calculation' })
          .click({ timeout: 180_000 });
        await expect(page.locator('[data-customize-diff]')).toContainText(
          'Price (CAD) − Standard cost (CAD)',
        );
        await page
          .getByRole('button', { name: 'Approve', exact: true })
          .click({ timeout: 180_000 });
        await expect(page.locator('[data-customize-screen]')).toContainText(
          'Activate now',
          { timeout: 180_000 },
        );
        await page
          .getByRole('button', { name: 'Activate now' })
          .click({ timeout: 180_000 });
        await expect(
          page.locator('[data-customize-result="activated"]'),
        ).toBeVisible({ timeout: 180_000 });

        const list = surface('item_list');
        await page.goto(list);
        await expect(
          page.getByRole('columnheader', { name: title }),
        ).toBeVisible();
        const row = page
          .getByRole('row')
          .filter({ has: page.getByRole('link', { name: /MARGIN-WEB/u }) });
        await expect(row).toContainText(margin);
        const exported = await page.request.get(`${list}&export=csv`);
        expect(exported.ok()).toBe(true);
        const csv = await exported.text();
        expect(csv).toContain(title);
        expect(csv).toContain(margin);
        await row.getByRole('link', { name: /MARGIN-WEB/u }).click();
        const marginLabel = page.getByText(title, { exact: true });
        if (!(await marginLabel.isVisible()))
          await page.locator('details.composition-more-fields summary').click();
        await expect(marginLabel).toBeVisible();
        await expect(page.getByText(margin, { exact: true })).toBeVisible();
        const record = page.url();
        await page.goto(customize);
        await page
          .getByRole('button', { name: 'Roll back the latest change' })
          .click({ timeout: 180_000 });
        await expect(
          page.locator('[data-customize-result="rolledBack"]'),
        ).toBeVisible({ timeout: 180_000 });
        await page.goto(record);
        await expect(page.getByText(title, { exact: true })).toHaveCount(0);
        await page.goto(list);
        await expect(
          page.getByRole('columnheader', { name: title }),
        ).toHaveCount(0);
      } finally {
        await app.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});
