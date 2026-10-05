import { test, expect } from '@playwright/test';
import { require as tsxRequire } from 'tsx/cjs/api';
import type * as FixtureModule from '../../../../test/helpers/order-entry-fixture.js';
const { withOrderEntryFixture } = tsxRequire(
  '../../../../test/helpers/order-entry-fixture.ts',
  import.meta.url,
) as typeof FixtureModule;

test('special-order purchase receipt offers the explicit received-quantity reservation Task', async ({
  page,
}) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(5_000);
  await withOrderEntryFixture(async (fixture) => {
    const ns = 'northstar.app';
    const order = await fixture.create('sales_order', {
      customer_party_id: fixture.customer,
      currency: 'CAD',
      order_date: new Date().toISOString(),
      ship_to_name: 'Customer dock',
      ship_to_street: '82 Customer Way',
      ship_to_city: 'Calgary',
      ship_to_region: 'AB',
      ship_to_postal_code: 'T2P 0A1',
      ship_to_country: 'Canada',
    });
    await fixture.create(
      'sales_order_line',
      {
        line_number: '1',
        item_id: fixture.item,
        unit_id: 'EA',
        ordered_quantity: '3',
        unit_price: '12',
        fulfillment_route: `${ns}:option.fulfillment_route_special_order`,
        drop_ship_supplier_id: fixture.customer,
      },
      { order: order.recordId },
    );
    await fixture.invoke('sales_order_release', {
      recordId: order.recordId,
      expectedRevision: order.revision,
    });
    const dataset = (local: string) =>
      page.locator(`[data-composition-dataset$="dataset.${local}"]`);
    const finish = async (label: string) => {
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: /^Review /u }).click();
      await dialog.getByRole('button', { name: /^Confirm /u }).click();
      await expect(page.getByRole('status').first()).toContainText(
        `${label}: done`,
      );
    };
    await page.goto(
      `${fixture.app.baseUrl}/?surface=${encodeURIComponent(`${ns}:surface.sales_order_list`)}`,
    );
    console.info('SPECIAL_ORDER_BROWSER: open sales order');
    await page
      .getByRole('link', {
        name: `Open Sales orders ${order.values[`${ns}:field.sales_order_number`]}`,
        exact: true,
      })
      .click();
    const salesUrl = page.url();
    const selectSales = async () =>
      dataset('fulfillment_lines')
        .locator('tbody tr')
        .first()
        .getByRole('link', { name: 'Select', exact: true })
        .click();
    await selectSales();
    console.info('SPECIAL_ORDER_BROWSER: create linked purchase order');
    await expect(
      page.getByRole('button', {
        name: 'Reserve for the special order',
        exact: true,
      }),
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Create special-order PO', exact: true })
      .click();
    await finish('Create special-order PO');
    await page.goto(salesUrl);
    await selectSales();
    await page
      .getByRole('link', { name: 'Open purchase order', exact: true })
      .click();
    console.info('SPECIAL_ORDER_BROWSER: place purchase order');
    const purchaseUrl = page.url();
    const disclosure = page.locator(
      '.composition-record-actions:not([open]) > summary',
    );
    if (await disclosure.count()) await disclosure.click();
    await page
      .getByRole('button', { name: /^(Release|Place order)$/u })
      .click();
    await expect(page.locator('.composition-business-status')).toHaveText(
      'Released',
    );
    await page.goto(purchaseUrl);
    const row = dataset('purchasing_lines').locator('tbody tr').first();
    await expect(row).toContainText('Special order');
    await row.getByRole('link', { name: 'Select', exact: true }).click();
    console.info('SPECIAL_ORDER_BROWSER: receive linked supply');
    await page
      .getByRole('button', { name: 'Receive with cost absent', exact: true })
      .click();
    await page.getByLabel('Quantity to receive', { exact: true }).fill('2');
    await page
      .getByLabel('Receiving location', { exact: true })
      .selectOption(fixture.location);
    await finish('Receive with cost absent');
    await page.goto(purchaseUrl);
    await expect(
      dataset('purchasing_lines')
        .locator('td[data-column-label="Arrived"]')
        .first(),
    ).toHaveText('2');
    await page.goto(salesUrl);
    await expect(
      dataset('fulfillment_lines')
        .locator('td[data-column-label="Arrived"]')
        .first(),
    ).toHaveText('2');
    await selectSales();
    console.info('SPECIAL_ORDER_BROWSER: reserve arrived quantity');
    await page
      .getByRole('button', {
        name: 'Reserve for the special order',
        exact: true,
      })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByLabel('Quantity to reserve', { exact: true }),
    ).toHaveCount(0);
    await dialog
      .getByLabel('Stock location', { exact: true })
      .selectOption(fixture.location);
    await finish('Reserve for the special order');
    await page.goto(salesUrl);
    await selectSales();
    await expect(
      dataset('fulfillment_lines')
        .locator('td[data-column-label="Covered"]')
        .first(),
    ).toHaveText('2');
    await expect(
      page.getByRole('button', {
        name: 'Reserve for the special order',
        exact: true,
      }),
    ).toHaveCount(0);
    console.info('SPECIAL_ORDER_BROWSER: received quantity reserved');
  });
});
