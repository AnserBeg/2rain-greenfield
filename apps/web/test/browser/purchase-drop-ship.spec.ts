import { test, expect } from '@playwright/test';
import { require as tsxRequire } from 'tsx/cjs/api';
import type * as FixtureModule from '../../../../test/helpers/order-entry-fixture.js';
import type * as QueryModule from '../../../../packages/runtime/src/semantic-query-gateway.js';

// The browser runner does not transpile backend fixture dependencies. Load
// those through the scoped TypeScript loader used by the PostgreSQL tests.
const { withOrderEntryFixture } = tsxRequire(
  '../../../../test/helpers/order-entry-fixture.ts',
  import.meta.url,
) as typeof FixtureModule;
const {
  SEMANTIC_QUERY_REQUEST_VERSION,
  registeredSemanticQueryFromPinnedView,
} = tsxRequire(
  '../../../../packages/runtime/src/semantic-query-gateway.ts',
  import.meta.url,
) as typeof QueryModule;

test('a supplier delivery appears on both linked orders and reverses with its reason', async ({
  page,
}) => {
  test.setTimeout(480_000);
  await withOrderEntryFixture(async (fixture) => {
    const ns = 'northstar.app';
    const draft = await fixture.create('sales_order', {
      customer_party_id: fixture.customer,
      currency: 'CAD',
      order_date: new Date().toISOString(),
      ship_to_name: 'Customer dock',
      ship_to_street: '82 Customer Way',
      ship_to_city: 'Calgary',
      ship_to_postal_code: 'T2P 0A1',
      ship_to_country: 'Canada',
    });
    const demand = await fixture.create(
      'sales_order_line',
      {
        line_number: '1',
        item_id: fixture.item,
        unit_id: 'EA',
        ordered_quantity: '3',
        unit_price: '12',
        fulfillment_route: `${ns}:option.fulfillment_route_drop_ship`,
        drop_ship_supplier_id: fixture.customer,
      },
      { order: draft.recordId },
    );
    await fixture.invoke('sales_order_release', {
      recordId: draft.recordId,
      expectedRevision: draft.revision,
    });
    const finish = async (label: string) => {
      const dialog = page.getByRole('dialog');
      await dialog
        .getByRole('button', { name: `Review ${label}`, exact: true })
        .click();
      await dialog
        .getByRole('button', { name: `Confirm ${label}`, exact: true })
        .click();
      await expect(
        page.getByRole('status').first(),
        await dialog.innerText(),
      ).toContainText(`${label}: done`);
    };
    const dataset = (local: string) =>
      page.locator(`[data-composition-dataset$="dataset.${local}"]`);
    await page.goto(
      `${fixture.app.baseUrl}/?surface=${encodeURIComponent(`${ns}:surface.sales_order_list`)}`,
    );
    await page
      .getByRole('link', {
        name: `Open Sales orders ${draft.values[`${ns}:field.sales_order_number`]}`,
        exact: true,
      })
      .click();
    const salesUrl = page.url();
    await dataset('fulfillment_lines')
      .locator('tbody tr')
      .first()
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Create drop-ship PO', exact: true })
      .click();
    await finish('Create drop-ship PO');
    const linked = await fixture.app.runtime.entry.run(
      { headers: {} },
      (view) =>
        fixture.app.runtime.queryGateway.invoke(view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId: `${ns}:query.sales_order_line_get`,
          arguments: {
            recordId: demand.recordId,
            includeArchived: false,
            [registeredSemanticQueryFromPinnedView(
              view,
              `${ns}:query.sales_order_line_get`,
            )!.legalEntityScope!.operand.parameterId]: fixture.scope,
            relationTargets: [`${ns}:relation.sales_order_line_purchase_line`],
          },
        }),
    );
    const purchaseLineId =
      linked.records[0]!.relationLabels![
        `${ns}:relation.sales_order_line_purchase_line`
      ]!.recordId!;
    const purchaseLine = await fixture.app.runtime.entry.run(
      { headers: {} },
      (view) =>
        fixture.app.runtime.queryGateway.invoke(view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId: `${ns}:query.purchase_order_line_get`,
          arguments: {
            recordId: purchaseLineId,
            includeArchived: false,
            [registeredSemanticQueryFromPinnedView(
              view,
              `${ns}:query.purchase_order_line_get`,
            )!.legalEntityScope!.operand.parameterId]: fixture.scope,
          },
        }),
    );
    await fixture.invoke('purchase_order_line_update', {
      recordId: purchaseLineId,
      expectedRevision: purchaseLine.records[0]!.revision,
      patch: { [`${ns}:field.purchase_order_line_unit_price`]: '7' },
    });
    await page.goto(salesUrl);
    const salesLine = dataset('fulfillment_lines').locator('tbody tr').first();
    await expect(salesLine).toContainText('Drop ship');
    await salesLine.getByRole('link', { name: 'Select', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Reserve stock', exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole('link', { name: 'Open purchase order', exact: true })
      .click();
    const purchaseUrl = page.url();
    await page
      .getByRole('button', { name: /^(Release|Place order)$/u })
      .click();
    // Bare confirmed commands use the shared confirmation route.
    const confirmation = page.getByRole('button', { name: /Confirm/u });
    if (await confirmation.count()) await confirmation.first().click();
    await page.goto(purchaseUrl);
    const purchaseRow = dataset('purchasing_lines').locator('tbody tr').first();
    await expect(purchaseRow).toContainText('Drop ship');
    await purchaseRow
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: 'Receive with actual cost',
        exact: true,
      }),
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Record supplier delivery', exact: true })
      .click();
    await page.getByLabel('Delivered quantity', { exact: true }).fill('2');
    await page
      .getByLabel('Supplier reference', { exact: true })
      .fill('SUP-REF-1');
    await finish('Record supplier delivery');
    await page.goto(purchaseUrl);
    const deliveredRow = dataset('purchasing_lines')
      .locator('tbody tr')
      .first();
    await expect(
      deliveredRow.locator('td[data-column-label="Received"]'),
    ).toHaveText('0');
    await expect(
      deliveredRow.locator('td[data-column-label="Delivered"]'),
    ).toHaveText('2');
    await expect(
      deliveredRow.locator('td[data-column-label="Open"]'),
    ).toHaveText('1');
    await dataset('purchase_order_deliveries')
      .getByRole('link', { name: 'Open delivery', exact: true })
      .click();
    await expect(page.locator('body')).toContainText('DSD-000001');
    await page
      .getByRole('button', { name: 'Reverse supplier delivery', exact: true })
      .click();
    await page
      .getByLabel('Reason', { exact: true })
      .fill('Supplier corrected the delivery');
    await finish('Reverse supplier delivery');
    await page.goto(salesUrl);
    const reversedLine = dataset('fulfillment_lines')
      .locator('tbody tr')
      .first();
    await expect(
      reversedLine.locator('td[data-column-label="Delivered"]'),
    ).toHaveText('0');
    await expect(dataset('sales_order_deliveries')).toContainText('Reversed');
  });
});
