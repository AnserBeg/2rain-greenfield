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
    await header(page, 'SO-ENTRY-BROWSER', 'Customer');
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
    await header(page, 'PO-ENTRY-BROWSER', 'Vendor');
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
    // The unit is the selected line's product base unit, shown, not typed; the
    // currency is offered, starting from the order's own.
    await expect(task().locator('output[data-derived-input]')).toHaveText('EA');
    await page
      .getByRole('combobox', { name: 'Receiving location', exact: true })
      .selectOption({ label: 'Calgary warehouse' });
    await page
      .getByLabel('Actual received unit cost', { exact: true })
      .fill('2.45');
    await expect(
      page.getByRole('combobox', { name: 'Actual cost currency', exact: true }),
    ).toHaveValue('CAD');
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
    await expect(task().locator('[data-task-result]')).toContainText(
      'Receive with actual cost: done',
    );
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
test('order editor pickers answer in place: focus, type, choose, create and return without reloading the order', async ({
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
    const customer = page.getByRole('combobox', {
      name: 'Customer',
      exact: true,
    });
    const product = page.getByRole('combobox', {
      name: 'Line 1 product',
      exact: true,
    });
    const status = () => field(page, 'Customer').locator('.reference-status');
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
    // What left the page: document loads (navigations and ordinary submits)
    // and in-place answers.
    let documents = 0;
    let fragments = 0;
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documents += 1;
      if (request.headers()['x-rain-fragment'] === '1') fragments += 1;
    });
    await page.goto(url);
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await page.getByLabel('Order number *').fill('SO-PICKER');
    await page.getByLabel('Currency *').selectOption('USD');
    await page.getByLabel('Notes').fill('Dock 4\nCall ahead');
    const kept = async () => {
      await expect(page.getByLabel('Order number *')).toHaveValue('SO-PICKER');
      await expect(page.getByLabel('Currency *')).toHaveValue('USD');
      await expect(page.getByLabel('Notes')).toHaveValue('Dock 4\nCall ahead');
    };
    const loaded = documents;

    // Focus opens the first page of ELIGIBLE customers; "+ New customer" is
    // the popup's last row; More continues in place.
    await customer.focus();
    await expect(records(page, 'Customer')).toHaveCount(20);
    await expect(field(page, 'Customer').getByRole('option').last()).toHaveText(
      '+ New customer',
    );
    await expect(
      records(page, 'Customer').filter({ hasText: 'Whitecourt Forestry' }),
    ).toHaveCount(0);
    await field(page, 'Customer')
      .getByRole('option', { name: 'More results' })
      .click();
    await expect
      .poll(() => records(page, 'Customer').count())
      .toBeGreaterThan(20);
    await shot('picker-focus-more');
    expect(documents, 'focus and More load no page').toBe(loaded);
    const shownNames = await records(page, 'Customer')
      .locator('strong')
      .allInnerTexts();

    // FORM-1: once read access is withdrawn, nothing shown before is shown
    // again -- not by a fresh lookup and not by a full page answer.
    await measure('deny', undefined, undefined, 'party_read');
    await customer.fill('Grande');
    await expect(status().locator('[data-message]')).toBeVisible();
    await expect(records(page, 'Customer')).toHaveCount(0);
    await submit(page, () =>
      page.getByRole('button', { name: 'Add line', exact: true }).click(),
    );
    const withdrawn = await page.content();
    const escaped = (value: string) =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    expect(
      shownNames.filter(
        (name) => withdrawn.includes(name) || withdrawn.includes(escaped(name)),
      ),
    ).toEqual([]);
    await expect(page.locator('tr.draft-line')).toHaveCount(2);
    await measure('allow', undefined, undefined, 'party_read');
    await kept();
    const afterAddLine = documents;

    // Eligibility: a supplier-only party is not offered as a customer.
    await customer.fill('Cascade Fastener');
    await expect(status()).toContainText('No customer matches');
    // Typing narrows on the server, and a late answer to an older term never
    // replaces the newer one: the first 'Whit' request is held.
    const releaseOld = await holdFirst(page, (body) =>
      decodeURIComponent(body).includes('sales_order_customer_party_id'),
    );
    await customer.fill('Whit');
    await customer.fill('Whitecourt');
    await expect(records(page, 'Customer')).toHaveCount(1);
    await releaseOld();
    await page.waitForTimeout(300);
    await expect(records(page, 'Customer')).toHaveCount(1);
    await expect(records(page, 'Customer').first()).toContainText(
      'Whitecourt Forestry',
    );
    await shot('picker-typed');
    // Enter takes the highlighted match; it never saves the order.
    await customer.press('Enter');
    await expect(customer).toHaveAttribute(
      'data-selected-label',
      'Whitecourt Forestry',
    );
    await expect(customer).toBeFocused();
    expect(new URL(page.url()).searchParams.get('record')).toBeNull();
    await kept();
    // Escape closes the popup first and leaves the selection as it was.
    await customer.fill('Alp');
    await expect(records(page, 'Customer').first()).toBeVisible();
    await customer.press('Escape');
    await expect(
      field(page, 'Customer').locator('.reference-lookup'),
    ).toBeHidden();
    await expect(customer).toHaveValue('Whitecourt Forestry');

    // Two fields answering out of order: the customer lookup is held while the
    // line's product is found and chosen; each answer lands on its own field.
    const releaseCustomer = await holdFirst(page, (body) =>
      decodeURIComponent(body).includes('sales_order_customer_party_id'),
    );
    await customer.fill('Alpine');
    await product.fill('notebook');
    await records(page, 'Line 1 product')
      .filter({ hasText: 'Field notebook' })
      .first()
      .click();
    await expect(product).toHaveAttribute(
      'data-selected-label',
      'Field notebook',
    );
    await expect(page.locator('output.derived-value').first()).toHaveText('EA');
    await releaseCustomer();
    await page.waitForTimeout(300);
    await expect(product).toHaveAttribute(
      'data-selected-label',
      'Field notebook',
    );
    await expect(customer).toHaveAttribute(
      'data-selected-label',
      'Whitecourt Forestry',
    );
    expect(documents, 'no page load for focus, search, More or selection').toBe(
      afterAddLine,
    );
    expect(fragments).toBeGreaterThan(8);

    // Create: "+ New customer" opens over the order with the typed name and
    // Escape cancels it on the server, writing nothing.
    await customer.fill('Ghost Glazing');
    await field(page, 'Customer')
      .getByRole('option', { name: '+ New customer' })
      .click();
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(
      true,
    );
    await expect(dialog.getByLabel('Name *')).toHaveValue('Ghost Glazing');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(customer).toBeFocused();
    await kept();
    expect(
      (await measure('masters', undefined, undefined, 'Ghost Glazing')).parties,
    ).toBe(0);

    // FORM-2: Enter with a required value missing sends nothing.
    await customer.fill('Blank Glazing');
    await field(page, 'Customer')
      .getByRole('option', { name: '+ New customer' })
      .click();
    const beforeEnter = fragments;
    await dialog.getByLabel('Name *').press('Enter');
    await page.waitForTimeout(500);
    expect(fragments).toBe(beforeEnter);
    expect(
      await dialog
        .getByLabel('Customer number *')
        .evaluate((input: HTMLInputElement) => input.validity.valueMissing),
    ).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      (await measure('masters', undefined, undefined, 'Blank Glazing')).parties,
    ).toBe(0);

    // Create and use: governed Party + active customer role, selected in place.
    await customer.fill('Enter Glazing');
    await field(page, 'Customer')
      .getByRole('option', { name: '+ New customer' })
      .click();
    await dialog.getByLabel('Customer number *').fill('C-ENTER');
    const created = await createForm();
    await dialog.getByLabel('Name *').press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(customer).toHaveAttribute(
      'data-selected-label',
      'Enter Glazing',
    );
    await expect(customer).toBeFocused();
    await expect(page.locator('[data-editor-create-selected]')).toBeVisible();
    await expect(product).toHaveAttribute(
      'data-selected-label',
      'Field notebook',
    );
    await kept();
    await shot('create-returned');
    expect(
      await measure('masters', undefined, undefined, 'Enter Glazing'),
    ).toMatchObject({ parties: 1, roles: ['northstar.app:option.customer'] });
    // The same create replayed as an ordinary submit creates nothing more.
    const replayed = await page.request.post(created.action, {
      form: { ...created.fields, draftCreate: 'submit' },
    });
    expect(replayed.status()).toBeGreaterThanOrEqual(400);
    expect(
      (await measure('masters', undefined, undefined, 'Enter Glazing')).parties,
    ).toBe(1);

    // Not permitted: "+ New customer" is not offered at all.
    await measure('deny', undefined, undefined, 'party_create');
    await customer.fill('Denied Glazing');
    await expect(status()).toContainText('No customer matches');
    await expect(
      field(page, 'Customer').getByRole('option', { name: '+ New customer' }),
    ).toHaveCount(0);
    await shot('create-not-offered');
    await measure('allow', undefined, undefined, 'party_create');

    // Revoked after the flow opened: refused truthfully, Cancel only.
    await customer.fill('Revoked Glazing');
    await field(page, 'Customer')
      .getByRole('option', { name: '+ New customer' })
      .click();
    await dialog.getByLabel('Customer number *').fill('C-REVOKED');
    await measure('deny', undefined, undefined, 'party_create');
    await dialog
      .getByRole('button', { name: 'Create and use', exact: true })
      .click();
    await expect(dialog.locator('[data-editor-create-denied]')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: /Create and use|Retry/ }),
    ).toHaveCount(0);
    await shot('create-revoked');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await measure('allow', undefined, undefined, 'party_create');
    expect(
      (await measure('masters', undefined, undefined, 'Revoked Glazing'))
        .parties,
    ).toBe(0);

    // Partial: the role step is refused after the party committed. The party
    // is kept and not selected; Cancel says so.
    await customer.fill('Partial Glazing');
    await field(page, 'Customer')
      .getByRole('option', { name: '+ New customer' })
      .click();
    await dialog.getByLabel('Customer number *').fill('C-PARTIAL');
    await measure('deny', undefined, undefined, 'party_role_create');
    await dialog
      .getByRole('button', { name: 'Create and use', exact: true })
      .click();
    await expect(dialog).toContainText('1 of 2 create steps committed');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-editor-create-kept]')).toBeVisible();
    await expect(customer).toHaveAttribute(
      'data-selected-label',
      'Enter Glazing',
    );
    await measure('allow', undefined, undefined, 'party_role_create');
    expect(
      await measure('masters', undefined, undefined, 'Partial Glazing'),
    ).toMatchObject({ parties: 1, roles: [] });

    // Read-back withheld: both steps commit but the record is not selected.
    await customer.fill('Withheld Glazing');
    await field(page, 'Customer')
      .getByRole('option', { name: '+ New customer' })
      .click();
    await dialog.getByLabel('Customer number *').fill('C-WITHHELD');
    await measure('deny', undefined, undefined, 'party_read');
    await dialog
      .getByRole('button', { name: 'Create and use', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await measure('allow', undefined, undefined, 'party_read');
    await expect(page.locator('[data-editor-create-withheld]')).toBeVisible();
    await expect(customer).toHaveAttribute(
      'data-selected-label',
      'Enter Glazing',
    );
    expect(
      await measure('masters', undefined, undefined, 'Withheld Glazing'),
    ).toMatchObject({ parties: 1, roles: ['northstar.app:option.customer'] });

    // A product created from a line returns to that exact line, in place.
    await page.getByLabel('Line 1 quantity', { exact: true }).fill('2.50');
    await product.fill('Thermal Roll');
    await field(page, 'Line 1 product')
      .getByRole('option', { name: '+ New product' })
      .click();
    await dialog.getByLabel('SKU *').fill('TR-80');
    // The base unit is offered from the configured codes, not typed.
    await expect(dialog.getByLabel('Base unit *')).toHaveValue('EA');
    await dialog.getByLabel('Base unit *').selectOption('ROLL');
    await shot('create-product');
    // FORM-2: Enter in the product's single-line SKU creates it too.
    await dialog.getByLabel('SKU *').press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(product).toHaveAttribute(
      'data-selected-label',
      'Thermal Roll',
    );
    await expect(product).toBeFocused();
    await expect(page.locator('output.derived-value').first()).toHaveText(
      'ROLL',
    );
    await expect(
      page.getByLabel('Line 1 quantity', { exact: true }),
    ).toHaveValue('2.50');
    expect(
      (await measure('masters', undefined, undefined, 'Thermal Roll')).items,
    ).toBe(1);
    await kept();
    await shot('line-product-created');
    expect(documents, 'create and return reloaded nothing').toBe(afterAddLine);

    // A stale create return -- a closed task at the current version -- is refused.
    await customer.fill('Stale Glazing');
    await field(page, 'Customer')
      .getByRole('option', { name: '+ New customer' })
      .click();
    await dialog.getByLabel('Customer number *').fill('C-STALE');
    const stale = await createForm();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const refused = await page.request.post(stale.action, {
      form: { ...stale.fields, draftCreate: 'submit' },
    });
    expect(refused.status()).toBe(422);
    expect(
      (await measure('masters', undefined, undefined, 'Stale Glazing')).parties,
    ).toBe(0);

    // Save once: the in-place selections and untouched typed values persist.
    await page
      .getByRole('button', { name: 'Remove line 2', exact: true })
      .click();
    await page.waitForLoadState('load');
    await page.getByLabel('Order date (UTC) *').fill('2026-09-15T12:00');
    await page.getByLabel('Line 1 unit price', { exact: true }).fill('3.25');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page).toHaveURL(/sales_order_detail/);
    await expect(page.locator('.composition-header')).toContainText(
      'Enter Glazing',
    );
    await expect(page.locator('.composition-header')).toContainText('USD');
    await expect(page.locator('[data-composition-fields]')).toContainText(
      'Call ahead',
    );
    await expect(
      page.locator('[data-composition-dataset$="dataset.fulfillment_lines"]'),
    ).toContainText('Thermal Roll');
    await shot('saved-in-place-order');

    // The same control on a Purchase order creates a vendor: a party with an
    // active supplier role, selected on the order that asked for it.
    await page.getByRole('link', { name: 'Purchasing', exact: true }).click();
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await page.getByLabel('Order number *').fill('PO-PICKER');
    const vendor = page.getByRole('combobox', { name: 'Vendor', exact: true });
    await vendor.fill('Lethbridge Millwork');
    // A customer-only party is not a vendor.
    await expect(
      field(page, 'Vendor').locator('.reference-status'),
    ).toContainText('No vendor matches');
    await vendor.fill('Coastal Ink Supply');
    await field(page, 'Vendor')
      .getByRole('option', { name: '+ New vendor' })
      .click();
    await dialog.getByLabel('Vendor number *').fill('V-COASTAL');
    await dialog
      .getByRole('button', { name: 'Create and use', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(vendor).toHaveAttribute(
      'data-selected-label',
      'Coastal Ink Supply',
    );
    await expect(page.getByLabel('Order number *')).toHaveValue('PO-PICKER');
    await expect(
      page.getByRole('columnheader', { name: 'Unit cost' }),
    ).toBeVisible();
    await shot('purchase-new-vendor');
    expect(
      await measure('masters', undefined, undefined, 'Coastal Ink Supply'),
    ).toMatchObject({ parties: 1, roles: ['northstar.app:option.supplier'] });

    // Without JavaScript the same controls are plain submits: search, select
    // and create-and-return all work, and the create form sits in the page.
    const plain = await browser.newContext({ javaScriptEnabled: false });
    const noScript = await plain.newPage();
    noScript.setDefaultTimeout(30_000);
    await noScript.goto(url);
    await noScript.getByRole('link', { name: 'New', exact: true }).click();
    await noScript.getByLabel('Order number *').fill('SO-NOSCRIPT');
    await pick(noScript, 'Customer', 'Alpine', 'Alpine Office Supply');
    await expect(noScript.getByLabel('Order number *')).toHaveValue(
      'SO-NOSCRIPT',
    );
    await noScript
      .getByRole('combobox', { name: 'Customer', exact: true })
      .fill('NoScript Glazing');
    await submit(noScript, () =>
      field(noScript, 'Customer')
        .getByRole('button', { name: 'Search', exact: true })
        .click(),
    );
    await submit(noScript, () =>
      field(noScript, 'Customer')
        .getByRole('option', { name: '+ New customer' })
        .click(),
    );
    const inline = noScript.locator('dialog.editor-create');
    expect(await inline.evaluate((element) => element.matches(':modal'))).toBe(
      false,
    );
    // FORM-2 without JavaScript: the native default submission is the primary
    // action, so Enter with a required value missing sends nothing, and
    // explicit Cancel creates nothing and keeps the order.
    let plainPosts = 0;
    noScript.on('request', (request) => {
      if (request.method() === 'POST') plainPosts += 1;
    });
    const beforePlainEnter = plainPosts;
    await inline.getByLabel('Name *').press('Enter');
    await noScript.waitForTimeout(500);
    expect(plainPosts).toBe(beforePlainEnter);
    await expect(inline).toBeVisible();
    await submit(noScript, () =>
      inline.getByRole('button', { name: 'Cancel', exact: true }).click(),
    );
    await expect(inline).toHaveCount(0);
    await expect(noScript.getByLabel('Order number *')).toHaveValue(
      'SO-NOSCRIPT',
    );
    expect(
      (await measure('masters', undefined, undefined, 'NoScript Glazing'))
        .parties,
    ).toBe(0);
    await noScript
      .getByRole('combobox', { name: 'Customer', exact: true })
      .fill('NoScript Glazing');
    await submit(noScript, () =>
      field(noScript, 'Customer')
        .getByRole('button', { name: 'Search', exact: true })
        .click(),
    );
    await submit(noScript, () =>
      field(noScript, 'Customer')
        .getByRole('option', { name: '+ New customer' })
        .click(),
    );
    await inline.getByLabel('Customer number *').fill('C-NOSCRIPT');
    await noScript.screenshot({
      path: testInfo.outputPath('no-script-create.png'),
      fullPage: true,
    });
    await submit(noScript, () => inline.getByLabel('Name *').press('Enter'));
    await expect(
      noScript.getByRole('combobox', { name: 'Customer', exact: true }),
    ).toHaveAttribute('data-selected-label', 'NoScript Glazing');
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
/** One field's in-place control, found by its combobox's accessible name. */
function field(page: Page, name: string) {
  return page
    .locator('[data-reference-field]')
    .filter({ has: page.getByRole('combobox', { name, exact: true }) });
}
/** The field's offered records (not More or "+ New"). */
function records(page: Page, name: string) {
  return field(page, name)
    .getByRole('option')
    .filter({ has: page.locator('strong') });
}
/**
 * Types into a picker and chooses an offered record. With the owned script the
 * whole exchange is in place; without it, Search and the result are ordinary
 * submits. Either way the field then shows the selected record.
 */
async function pick(page: Page, name: string, term: string, option: string) {
  const box = page.getByRole('combobox', { name, exact: true });
  await box.fill(term);
  const enhanced =
    (await page.locator('body[data-reference-enhanced]').count()) > 0;
  if (!enhanced)
    await submit(page, () =>
      field(page, name)
        .getByRole('button', { name: 'Search', exact: true })
        .click(),
    );
  const choice = records(page, name).filter({ hasText: option }).first();
  if (enhanced) await choice.click();
  else await submit(page, () => choice.click());
  await expect(
    page.getByRole('combobox', { name, exact: true }),
  ).toHaveAttribute('data-selected-label', option);
}
/**
 * Holds the first in-place request whose body matches, so a test can deliver
 * answers out of order. The returned function releases it.
 */
async function holdFirst(page: Page, match: (body: string) => boolean) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (
      !held &&
      request.headers()['x-rain-fragment'] === '1' &&
      match(request.postData() ?? '')
    ) {
      held = true;
      await gate;
    }
    await route.continue();
  });
  return async () => {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  };
}
async function header(
  page: Page,
  number: string,
  party: 'Customer' | 'Vendor',
) {
  await page.getByLabel('Order number *').fill(number);
  await pick(page, party, 'Alpine', 'Alpine Office Supply');
  await expect(
    page.getByRole('combobox', { name: party, exact: true }),
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
  await pick(page, `Line ${index} product`, sku, name);
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
