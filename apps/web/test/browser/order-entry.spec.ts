import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

test('normal shared order workspace creates, edits, removes, saves and reopens Sales and Purchase drafts', async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, measure) => {
    const captures: unknown[] = [];
    const capture = async (name: string) => {
      for (const [size, width, height] of [
        ['desktop', 1280, 800],
        ['mobile', 390, 844],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => window.scrollTo(0, 0));
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        if (name.endsWith('draft-editor')) {
          const boundary = await page
            .getByText(
              'Save commits the header and each line in sequence. Drafts do not change stock. Release is a separate action.',
              { exact: true },
            )
            .boundingBox();
          const save = await page
            .getByRole('button', { name: 'Save draft', exact: true })
            .boundingBox();
          expect(boundary).not.toBeNull();
          expect(save).not.toBeNull();
          expect(boundary!.y + boundary!.height).toBeLessThanOrEqual(save!.y);
        }
        await page.screenshot({
          path: testInfo.outputPath(`${name}-${size}.png`),
          fullPage: true,
        });
        captures.push({
          name,
          size,
          width,
          height,
          url: page.url(),
          releaseId: await page
            .locator('.app-shell')
            .getAttribute('data-release-id'),
          releaseRoot: await page
            .locator('.app-shell')
            .getAttribute('data-release-content-hash'),
        });
      }
      await page.setViewportSize({ width: 1280, height: 800 });
    };
    await page.goto(url);
    await expect(
      page.getByRole('heading', { name: 'Sales orders', level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText('Select legal entity', { exact: true }),
    ).toHaveCount(0);
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await header(page, 'SO-ENTRY-BROWSER', 'customer');
    await line(page, 1, 'Field notebook · OFF-100', '10', true);
    await submit(page, () =>
      page.getByRole('button', { name: 'Add line', exact: true }).click(),
    );
    await line(page, 2, 'Fine-point pen set · OFF-120', '2', true);
    await submit(page, () =>
      page.getByRole('button', { name: 'Add line', exact: true }).click(),
    );
    await line(page, 3, 'Task lamp · OFF-210', '4', true);
    await page.getByLabel('Line 2 quantity', { exact: true }).fill('3');
    await submit(page, () =>
      page.getByRole('button', { name: 'Remove line 3', exact: true }).click(),
    );
    await expect(page.locator('[data-draft-line]')).toHaveCount(2);
    await capture('sales-draft-editor');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page).toHaveURL(/sales_order_detail/);
    await expect(page.locator('.composition-header')).toContainText(
      'SO-ENTRY-BROWSER',
    );
    const orderId = new URL(page.url()).searchParams.get('record');
    await page.getByRole('link', { name: 'Sales', exact: true }).click();
    await page
      .getByRole('link', {
        name: 'Open Sales orders SO-ENTRY-BROWSER',
        exact: true,
      })
      .click();
    expect(new URL(page.url()).searchParams.get('record')).toBe(orderId);
    await capture('sales-saved-reopened');
    const salesUrl = page.url();
    await page.locator('.composition-record-actions > summary').click();
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await expect(
      page.getByLabel('Line 2 quantity', { exact: true }),
    ).toHaveValue('3');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await page.getByRole('link', { name: 'Purchasing', exact: true }).click();
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await header(page, 'PO-ENTRY-BROWSER', 'vendor');
    await line(page, 1, 'Field notebook · OFF-100', '10', false);
    await submit(page, () =>
      page.getByRole('button', { name: 'Add line', exact: true }).click(),
    );
    await line(page, 2, 'Fine-point pen set · OFF-120', '2', false);
    await submit(page, () =>
      page.getByRole('button', { name: 'Add line', exact: true }).click(),
    );
    await line(page, 3, 'Task lamp · OFF-210', '4', false);
    await page.getByLabel('Line 2 quantity', { exact: true }).fill('3');
    await submit(page, () =>
      page.getByRole('button', { name: 'Remove line 3', exact: true }).click(),
    );
    await capture('purchase-draft-editor');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page).toHaveURL(/purchase_order_detail/);
    const purchaseId = new URL(page.url()).searchParams.get('record');
    await page.getByRole('link', { name: 'Purchasing', exact: true }).click();
    await page.getByRole('link', { name: /Open .*PO-ENTRY-BROWSER$/ }).click();
    expect(new URL(page.url()).searchParams.get('record')).toBe(purchaseId);
    await capture('purchase-saved-reopened');
    const purchaseUrl = page.url();
    await page.locator('.composition-record-actions > summary').click();
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await expect(
      page.getByLabel('Line 2 quantity', { exact: true }),
    ).toHaveValue('3');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await measure('drafts', orderId!, purchaseId!);
    const navigation = page.getByRole('navigation', {
      name: 'Release navigation',
    });
    for (const local of [
      'reservation',
      'reservation_balance',
      'sales_order_line',
      'sales_order_shipped',
      'shipment_line',
      'purchase_order_line',
      'goods_receipt_line',
      'purchase_order_received',
    ])
      await expect(
        navigation.locator(`a[href*="surface.${local}_list"]`),
      ).toHaveCount(0);
    await page.goto(salesUrl);
    await page.locator('.composition-record-actions > summary').click();
    await page.getByRole('button', { name: 'Release', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Release complete');
    await expect(
      page.getByRole('link', { name: 'Edit', exact: true }),
    ).toHaveCount(0);
    const lines = () =>
      page.locator('[data-composition-dataset$="dataset.fulfillment_lines"]');
    const reservations = () =>
      page.locator('[data-composition-dataset$="dataset.line_reservations"]');
    const task = () => page.locator('[data-composition-task]');
    await lines()
      .locator('tbody tr')
      .filter({ hasText: 'Field notebook' })
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Reserve stock', exact: true })
      .click();
    await page.getByLabel('Quantity to reserve', { exact: true }).fill('8');
    await page
      .getByLabel('Stock location')
      .selectOption({ label: 'Calgary warehouse' });
    await page
      .getByRole('button', { name: 'Review reservation', exact: true })
      .click();
    const token = await task().locator('[name=taskToken]').inputValue();
    const prepared = await task().locator('[name=preparedId]').inputValue();
    const preparedUrl = page.url();
    const preparedReplay = await task()
      .locator('[name=preparedId]')
      .evaluate((input) => {
        const form = input.closest('form')!;
        return Object.fromEntries(
          [...new FormData(form).entries()].map(([key, value]) => [
            key,
            String(value),
          ]),
        );
      });
    preparedReplay.taskStage = 'confirm';
    const second = await measure('second_company');
    const other = await page.context().newPage();
    await other.goto(url);
    await other
      .getByRole('navigation', { name: 'Company', exact: true })
      .getByRole('link', { name: 'Second company', exact: true })
      .click();
    expect(
      new URL(other.url()).searchParams.get(
        'northstar.app:parameter.sales_order_list_legal_entity_scope',
      ),
    ).toBe(second.companyId);
    expect(
      new URL(page.url()).searchParams.get(
        'northstar.app:parameter.sales_order_get_legal_entity_scope',
      ),
    ).not.toBe(second.companyId);
    expect(await task().locator('[name=taskToken]').inputValue()).toBe(token);
    expect(await task().locator('[name=preparedId]').inputValue()).toBe(
      prepared,
    );
    await other.close();
    await page
      .getByRole('button', { name: 'Confirm reservation', exact: true })
      .click();
    await expect(task()).toContainText('complete');
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    await measure('reserved');
    await capture('sales-reserved');
    await reservations()
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Ship reserved stock', exact: true })
      .click();
    await page.getByLabel('Quantity to ship', { exact: true }).fill('5');
    await page
      .getByRole('button', { name: 'Review shipment', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm shipment', exact: true })
      .click();
    await expect(task()).toContainText('complete');
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    await measure('shipped');
    await capture('sales-partial-shipment');
    await page.locator('.composition-context-overflow summary').click();
    await page
      .getByRole('button', { name: 'Release remainder', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Review release', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm release', exact: true })
      .click();
    await expect(task()).toContainText('complete');
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    await measure('released');
    await capture('sales-remainder-released');
    await page.getByRole('link', { name: 'Open packing', exact: true }).click();
    const packed = page.locator(
      '[data-composition-dataset$="dataset.packing_lines"]',
    );
    await expect(packed.locator('tbody tr')).toHaveCount(1);
    await expect(packed.locator('td[data-column-label="Quantity"]')).toHaveText(
      '5',
    );
    await capture('sales-packing');
    await page.goto(purchaseUrl);
    await page.locator('.composition-record-actions > summary').click();
    await page.getByRole('button', { name: 'Release', exact: true }).click();
    await expect(
      page.getByRole('link', { name: 'Edit', exact: true }),
    ).toHaveCount(0);
    await page
      .locator(
        '[data-composition-dataset$="dataset.purchasing_lines"] tbody tr',
      )
      .filter({ hasText: 'Field notebook' })
      .getByRole('link', { name: 'Select', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Receive with actual cost', exact: true })
      .click();
    await page.getByLabel('Quantity to receive', { exact: true }).fill('2');
    await page.getByLabel('Base unit', { exact: true }).fill('EA');
    await page
      .getByRole('combobox', { name: 'Receiving location', exact: true })
      .selectOption({ label: 'Calgary warehouse' });
    await page
      .getByLabel('Actual received unit cost', { exact: true })
      .fill('2.45');
    await page.getByLabel('Actual cost currency', { exact: true }).fill('CAD');
    await page
      .getByRole('button', {
        name: 'Review Receive with actual cost',
        exact: true,
      })
      .click();
    await capture('purchase-receive-review');
    await page
      .getByRole('button', {
        name: 'Confirm Receive with actual cost',
        exact: true,
      })
      .click();
    await expect(task()).toContainText('complete');
    await page
      .getByRole('link', { name: 'Back to order', exact: true })
      .click();
    await measure('received');
    await capture('purchase-received');
    await measure('revoke_sales_read');
    const replay = await page.request.post(preparedUrl, {
      form: preparedReplay,
    });
    expect(replay.status()).toBe(200);
    const redacted = await replay.text();
    // This task completed with readable results before revocation. Its existing
    // replay contract retains the completion receipt and withholds record DTOs.
    expect(redacted).toContain('COMPOSITION_COMPLETE');
    expect(redacted).not.toContain('Field notebook');
    expect(redacted).not.toContain('SO-ENTRY-BROWSER');
    await measure('received');
    await writeFile(
      testInfo.outputPath('captures.json'),
      JSON.stringify(captures, null, 2),
    );
  }, testInfo.outputPath('serving.json'));
});
test('order editor pickers search past the first page and create missing masters in context without duplicates', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  await fixture(async (url, measure) => {
    const shot = (name: string) =>
      page.screenshot({
        path: testInfo.outputPath(`${name}.png`),
        fullPage: true,
      });
    const dialog = page.locator('dialog.editor-create');
    const customer = () => picker(page, 'Search customer');
    const selectedCustomer = page.locator(
      '.draft-header [data-reference-selected] strong',
    );
    const createForm = () =>
      dialog.locator('form').evaluate((form: HTMLFormElement) => ({
        action: form.action,
        fields: Object.fromEntries(
          [...new FormData(form).entries()].map(([key, value]) => [
            key,
            String(value),
          ]),
        ),
      }));
    await page.goto(url);
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await page.getByLabel('Order number *').fill('SO-PICKER');
    await page.getByLabel('Currency *').selectOption('USD');
    await page.getByLabel('Notes').fill('Dock 4\nCall ahead');

    // The first page does not hold every customer; the server searches the rest.
    await search(page, 'Search customer', '');
    await expect(customer().locator('.reference-option')).toHaveCount(20);
    await expect(
      customer().locator('.reference-option', {
        hasText: 'Whitecourt Forestry',
      }),
    ).toHaveCount(0);
    await submit(page, () =>
      customer().getByRole('button', { name: 'More results' }).click(),
    );
    expect(
      await customer().locator('.reference-option').count(),
    ).toBeGreaterThan(20);
    await search(page, 'Search customer', 'Whitecourt');
    await expect(customer().locator('.reference-option strong')).toHaveText([
      'Whitecourt Forestry',
    ]);
    await shot('picker-server-search');

    // Keyboard: Enter searches this field and never saves the order.
    const box = page.getByLabel('Search customer', { exact: true });
    await box.fill('Alpine');
    await submit(page, () => box.press('Enter'));
    expect(new URL(page.url()).searchParams.get('record')).toBeNull();
    await expect(customer().locator('.reference-option').first()).toBeFocused();
    await submit(page, () => page.keyboard.press('Enter'));
    await expect(selectedCustomer).toHaveText('Alpine Office Supply');
    await expect(
      page.getByRole('button', { name: 'Change customer', exact: true }),
    ).toBeFocused();
    await expect(page.getByLabel('Order number *')).toHaveValue('SO-PICKER');
    await expect(page.getByLabel('Currency *')).toHaveValue('USD');
    await expect(page.getByLabel('Notes')).toHaveValue('Dock 4\nCall ahead');

    // Cancel: nothing is written, nothing entered is lost, focus returns.
    await submit(page, () =>
      page
        .getByRole('button', { name: 'Change customer', exact: true })
        .click(),
    );
    await box.fill('Ghost Glazing');
    await submit(page, () =>
      page.getByRole('button', { name: '+ New customer', exact: true }).click(),
    );
    expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(
      true,
    );
    await expect(dialog.getByLabel('Name *')).toHaveValue('Ghost Glazing');
    await submit(page, () => page.keyboard.press('Escape'));
    await expect(dialog).toHaveCount(0);
    await expect(box).toBeFocused();
    await expect(page.getByLabel('Order number *')).toHaveValue('SO-PICKER');
    expect(
      (await measure('masters', undefined, undefined, 'Ghost Glazing')).parties,
    ).toBe(0);

    // Denied create: refused without a write; the picker still selects.
    await measure('deny', undefined, undefined, 'party_create');
    await box.fill('Denied Glazing');
    await submit(page, () =>
      page.getByRole('button', { name: '+ New customer', exact: true }).click(),
    );
    await dialog.getByLabel('Customer number *').fill('C-DENIED');
    expect(
      await submit(page, () =>
        dialog
          .getByRole('button', { name: 'Create and use', exact: true })
          .click(),
      ),
    ).toBe(422);
    await expect(
      dialog.locator('[data-diagnostic-code="OPERATION_PERMISSION_DENIED"]'),
    ).toHaveCount(1);
    await shot('create-denied');
    expect(
      (await measure('masters', undefined, undefined, 'Denied Glazing'))
        .parties,
    ).toBe(0);
    await submit(page, () =>
      dialog.getByRole('button', { name: 'Cancel', exact: true }).click(),
    );
    await choose(page, 'Search customer', 'Alpine', 'Alpine Office Supply');
    await expect(selectedCustomer).toHaveText('Alpine Office Supply');
    await measure('allow', undefined, undefined, 'party_create');

    // Partial create: the second governed step is refused; the party is kept,
    // not selected, and Retry finishes it with the same request.
    await submit(page, () =>
      page
        .getByRole('button', { name: 'Change customer', exact: true })
        .click(),
    );
    await measure('deny', undefined, undefined, 'party_role_create');
    await box.fill('Partial Glazing');
    await submit(page, () =>
      page.getByRole('button', { name: '+ New customer', exact: true }).click(),
    );
    await dialog.getByLabel('Customer number *').fill('C-PARTIAL');
    await dialog.getByLabel('Contact').fill('Pat Lee\n403-555-0199');
    await submit(page, () =>
      dialog
        .getByRole('button', { name: 'Create and use', exact: true })
        .click(),
    );
    await expect(dialog).toContainText('1 of 2 create steps committed');
    await expect(dialog.getByLabel('Name *')).toBeDisabled();
    await shot('create-partial');
    expect(
      await measure('masters', undefined, undefined, 'Partial Glazing'),
    ).toMatchObject({
      parties: 1,
      roles: [],
    });
    await measure('allow', undefined, undefined, 'party_role_create');
    const retry = await createForm();
    await submit(page, () =>
      dialog.getByRole('button', { name: 'Retry', exact: true }).click(),
    );
    await expect(dialog).toHaveCount(0);
    await expect(selectedCustomer).toHaveText('Partial Glazing');
    await expect(page.locator('[data-editor-create-selected]')).toBeVisible();
    await expect(page.getByLabel('Order number *')).toHaveValue('SO-PICKER');
    await shot('create-retried-selected');
    // A duplicate submission of the same create form writes nothing.
    const duplicate = await page.request.post(retry.action, {
      form: { ...retry.fields, draftCreate: 'submit' },
    });
    expect(duplicate.status()).toBe(409);
    expect(
      await measure('masters', undefined, undefined, 'Partial Glazing'),
    ).toMatchObject({
      parties: 1,
      roles: ['northstar.app:option.customer'],
    });

    // A product created from a line returns to that exact line.
    await page.getByLabel('Line 1 quantity', { exact: true }).fill('2.50');
    await picker(page, 'Search line 1 product')
      .getByLabel('Search line 1 product', { exact: true })
      .fill('Thermal Roll');
    await submit(page, () =>
      page.getByRole('button', { name: '+ New product', exact: true }).click(),
    );
    await dialog.getByLabel('SKU *').fill('TR-80');
    await dialog.getByLabel('Base unit *').fill('ROLL');
    await shot('create-product');
    await submit(page, () =>
      dialog
        .getByRole('button', { name: 'Create and use', exact: true })
        .click(),
    );
    await expect(
      page.getByRole('button', { name: 'Change line 1 product', exact: true }),
    ).toBeFocused();
    await expect(page.locator('tr.draft-line').first()).toContainText(
      'Thermal Roll',
    );
    await expect(page.locator('output.derived-value').first()).toHaveText(
      'ROLL',
    );
    await expect(
      page.getByLabel('Line 1 quantity', { exact: true }),
    ).toHaveValue('2.5');
    expect(
      (await measure('masters', undefined, undefined, 'Thermal Roll')).items,
    ).toBe(1);
    await shot('line-product-created');

    // Read-back withheld: the create commits but is not selected.
    await submit(page, () =>
      page
        .getByRole('button', { name: 'Change customer', exact: true })
        .click(),
    );
    await box.fill('Withheld Glazing');
    await submit(page, () =>
      page.getByRole('button', { name: '+ New customer', exact: true }).click(),
    );
    await dialog.getByLabel('Customer number *').fill('C-WITHHELD');
    await measure('deny', undefined, undefined, 'party_read');
    await submit(page, () =>
      dialog
        .getByRole('button', { name: 'Create and use', exact: true })
        .click(),
    );
    await measure('allow', undefined, undefined, 'party_read');
    const withheld = await measure(
      'masters',
      undefined,
      undefined,
      'Withheld Glazing',
    );
    await shot('create-withheld');
    await expect(page.locator('[data-editor-create-withheld]')).toHaveCount(1);
    await expect(selectedCustomer).toHaveCount(0);
    // Both governed steps committed; only the read-back was refused.
    expect(withheld).toMatchObject({
      parties: 1,
      roles: ['northstar.app:option.customer'],
    });

    // A stale create return -- a closed task at the current version -- is refused.
    if (await dialog.count())
      await submit(page, () =>
        dialog.getByRole('button', { name: 'Cancel', exact: true }).click(),
      );
    await page
      .getByLabel('Search customer', { exact: true })
      .fill('Stale Glazing');
    await submit(page, () =>
      page.getByRole('button', { name: '+ New customer', exact: true }).click(),
    );
    await dialog.getByLabel('Customer number *').fill('C-STALE');
    const stale = await createForm();
    await submit(page, () =>
      dialog.getByRole('button', { name: 'Cancel', exact: true }).click(),
    );
    const refused = await page.request.post(stale.action, {
      form: {
        ...stale.fields,
        draftCreate: 'submit',
        draftVersion: await page
          .locator('#draft-editor-form input[name="draftVersion"]')
          .inputValue(),
      },
    });
    expect(refused.status()).toBe(422);
    expect(
      (await measure('masters', undefined, undefined, 'Stale Glazing')).parties,
    ).toBe(0);

    // Without JavaScript the same controls are plain submits: search, select
    // and create-and-return all work, and the create form sits in the page.
    const plain = await browser.newContext({ javaScriptEnabled: false });
    const noScript = await plain.newPage();
    noScript.setDefaultTimeout(30_000);
    await noScript.goto(url);
    await noScript.getByRole('link', { name: 'New', exact: true }).click();
    await noScript.getByLabel('Order number *').fill('SO-NOSCRIPT');
    await search(noScript, 'Search customer', 'Alpine');
    await submit(noScript, () =>
      picker(noScript, 'Search customer')
        .locator('.reference-option', { hasText: 'Alpine Office Supply' })
        .click(),
    );
    await expect(
      noScript.locator('.draft-header [data-reference-selected] strong'),
    ).toHaveText('Alpine Office Supply');
    await submit(noScript, () =>
      noScript
        .getByRole('button', { name: 'Change customer', exact: true })
        .click(),
    );
    await noScript
      .getByLabel('Search customer', { exact: true })
      .fill('NoScript Glazing');
    await submit(noScript, () =>
      noScript
        .getByRole('button', { name: '+ New customer', exact: true })
        .click(),
    );
    const inline = noScript.locator('dialog.editor-create');
    expect(await inline.evaluate((element) => element.matches(':modal'))).toBe(
      false,
    );
    await inline.getByLabel('Customer number *').fill('C-NOSCRIPT');
    await noScript.screenshot({
      path: testInfo.outputPath('no-script-create.png'),
      fullPage: true,
    });
    await submit(noScript, () =>
      inline
        .getByRole('button', { name: 'Create and use', exact: true })
        .click(),
    );
    await expect(
      noScript.locator('.draft-header [data-reference-selected] strong'),
    ).toHaveText('NoScript Glazing');
    await expect(noScript.getByLabel('Order number *')).toHaveValue(
      'SO-NOSCRIPT',
    );
    expect(
      await measure('masters', undefined, undefined, 'NoScript Glazing'),
    ).toMatchObject({
      parties: 1,
      roles: ['northstar.app:option.customer'],
    });
    await plain.close();
  }, testInfo.outputPath('serving.json'));
});

/** Waits for the server-rendered response to a submit and the page it loads. */
async function submit(page: Page, act: () => Promise<unknown>) {
  const loaded = page.waitForEvent('load');
  const responded = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.request().resourceType() === 'document',
  );
  await act();
  const response = await responded;
  await loaded;
  return response.status();
}
function picker(page: Page, label: string) {
  return page
    .locator('[data-reference-control]')
    .filter({ has: page.getByLabel(label, { exact: true }) });
}
async function search(page: Page, label: string, term: string) {
  const control = picker(page, label);
  await control.getByLabel(label, { exact: true }).fill(term);
  return submit(page, () =>
    control.getByRole('button', { name: 'Search', exact: true }).click(),
  );
}
async function choose(page: Page, label: string, term: string, option: string) {
  await search(page, label, term);
  await submit(page, () =>
    picker(page, label)
      .locator('.reference-option', { hasText: option })
      .first()
      .click(),
  );
}
async function header(page: Page, number: string, party: string) {
  await page.getByLabel('Order number *').fill(number);
  await choose(page, `Search ${party}`, 'Alpine', 'Alpine Office Supply');
  await expect(
    page.getByRole('button', { name: `Change ${party}`, exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel('Order number *')).toHaveValue(number);
  await page.getByLabel('Order date (UTC) *').fill('2026-09-15T12:00');
  // The declared default; no other currency is typed.
  await expect(page.getByLabel('Currency *')).toHaveValue('CAD');
}
async function line(
  page: Page,
  index: number,
  item: string,
  quantity: string,
  sales: boolean,
) {
  const [name, sku] = item.split(' · ') as [string, string];
  await choose(page, `Search line ${index} product`, sku, name);
  await page
    .getByLabel(`Line ${index} quantity`, { exact: true })
    .fill(quantity);
  if (sales)
    await expect(
      page
        .locator('tr.draft-line')
        .nth(index - 1)
        .locator('output.derived-value'),
    ).toHaveText(sku === 'OFF-120' ? 'BOX' : 'EA');
  await page
    .getByLabel(`Line ${index} ${sales ? 'unit price' : 'unit cost'}`, {
      exact: true,
    })
    .fill('12.5');
}
/** What the fixture reports back: a company it made, or stored master counts. */
interface Measured {
  readonly companyId?: string;
  readonly parties?: number;
  readonly roles?: readonly string[];
  readonly items?: number;
}
async function fixture(
  run: (
    url: string,
    measure: (
      phase: string,
      orderId?: string,
      purchaseId?: string,
      subject?: string,
    ) => Promise<Measured>,
  ) => Promise<void>,
  servingPath: string,
) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'test/helpers/order-entry-fixture.ts',
      '--serve',
      '--verify',
      '--distributor',
    ],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let resolveReady: (url: string) => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exited = once(child, 'exit');
  let resolveMeasurement: ((value: Measured) => void) | null = null;
  let rejectMeasurement: ((error: Error) => void) | null = null;
  let consumed = '';
  const measurements: unknown[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    const match = /ORDER_ENTRY_URL=(.*)/.exec(output);
    if (match) resolveReady(match[1]!);
    consumed += chunk.toString();
    const lines = consumed.split('\n');
    consumed = lines.pop()!;
    for (const line of lines)
      if (line.startsWith('ORDER_ENTRY_MEASURED=')) {
        const value = JSON.parse(line.slice('ORDER_ENTRY_MEASURED='.length));
        measurements.push(value);
        resolveMeasurement?.(value);
        resolveMeasurement = null;
      }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.once('error', (error) => rejectReady(error));
  child.once('exit', () => rejectReady(new Error(output)));
  child.once('exit', () => rejectMeasurement?.(new Error(output)));
  const measure = (
    phase: string,
    orderId?: string,
    purchaseId?: string,
    subject?: string,
  ) =>
    new Promise<Measured>((resolve, reject) => {
      resolveMeasurement = resolve;
      rejectMeasurement = reject;
      child.stdin.write(
        JSON.stringify({ phase, orderId, purchaseId, subject }) + '\n',
      );
    });
  try {
    const url = await ready;
    const serving = /ORDER_ENTRY_SERVING=(.*)/.exec(output);
    expect(serving, output).not.toBeNull();
    await writeFile(servingPath, serving![1]! + '\n');
    console.log('ORDER_ENTRY_SERVING ' + serving![1]);
    await run(url, measure);
    console.log('ORDER_ENTRY_PERSISTED ' + JSON.stringify(measurements));
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    const [code] = await exited;
    expect(code, output).toBe(0);
  }
}
