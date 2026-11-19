import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { expect, test } from '@playwright/test';

import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  startComposedApplication,
} from '../../../api/src/composition-root.js';
import { composedApplicationSeed } from '../../../../packages/domain/src/app/seed.js';
import { SEMANTIC_OPERATION_REQUEST_VERSION } from '../../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  inspection,
  inspectionFields,
  inspectionLinks,
  inspectionLinkRecords,
  inspectionStates,
  inspectionTransitions,
} from '../../../../test/fixtures/inspection-customization.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../../../../test/helpers/postgres.js';

const equipmentList = 'northstar.app:surface.custom_equipment_list';

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

test('a person builds Goods Receipt Inspection with the Customize screen and uses the generated editor', async ({
  page,
}) => {
  test.setTimeout(900_000);
  await withEphemeralPostgres(
    'customize-inspection-browser',
    async ({ connection }) => {
      const app = await startComposedApplication({
        databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
        tenantSlug: 'customize-inspection-browser',
        port: 0,
        seedProfile: 'distributor',
      });
      try {
        const runtime = app.runtime;
        const createRecord: Parameters<typeof inspectionLinkRecords>[0] = (
          local,
          values,
          relations = {},
        ) =>
          runtime.entry.run(
            { headers: { cookie: 'northstar-demo-actor=manager' } },
            async (view) => {
              const result = await runtime.operationGateway.invoke(
                view,
                {
                  schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
                  operationId: `northstar.app:operation.${local}_create`,
                  idempotencyKey: randomUUID(),
                  confirmationGrant: null,
                  input: {
                    recordId: randomUUID(),
                    legalEntityId:
                      COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId,
                    values: Object.fromEntries(
                      Object.entries(values).map(([field, value]) => [
                        `northstar.app:field.${local}_${field}`,
                        value,
                      ]),
                    ),
                    relations: Object.fromEntries(
                      Object.entries(relations).map(([relation, value]) => [
                        `northstar.app:relation.${local}_${relation}`,
                        value,
                      ]),
                    ),
                  },
                },
                runtime.operationMediation.issueInvocation(view, 'UI'),
              );
              if (result.outcome !== 'succeeded' || !result.readBack)
                throw new Error(`Creating ${local} for the journey failed`);
              return result.readBack;
            },
          );
        const seed = composedApplicationSeed('distributor');
        const { receipt } = await inspectionLinkRecords(
          createRecord,
          (name) => {
            const record = seed.find((item) =>
              Object.values(item.values).includes(name),
            );
            if (!record) throw new Error(`Missing seed record ${name}`);
            return record.recordId;
          },
        );
        const receiptNumber = String(
          receipt.values['northstar.app:field.goods_receipt_number'],
        );
        const publish = async () => {
          await page
            .getByRole('button', { name: 'Approve', exact: true })
            .click({ timeout: 180_000 });
          await page
            .getByRole('button', { name: 'Activate now' })
            .click({ timeout: 180_000 });
          await expect(page.getByRole('main')).toContainText(
            'The change is live',
          );
          await expect(
            page.locator('[data-customize-result="activated"]'),
          ).toBeVisible();
        };
        await page.goto(`${app.baseUrl}/?customize`);
        const create = page.locator('[data-customize-form="addRecordType"]');
        await create.locator('[name="label"]').fill('Goods Receipt Inspection');
        await create
          .locator('[name="companyOwnership"]')
          .selectOption('entityOwned');
        await create.getByText('Line table', { exact: true }).click();
        await create.locator('[name="lines_label"]').fill('Inspection results');
        for (const [index, field] of inspectionFields.entries()) {
          await create
            .locator(`[name="line_${index + 1}_label"]`)
            .fill(field.label);
          await create
            .locator(`[name="line_${index + 1}_type"]`)
            .selectOption(field.type);
        }
        await create.locator('[name="line_1_required"]').check();
        await create.getByText('Links', { exact: true }).click();
        for (const [index, link] of inspectionLinks.entries()) {
          await create
            .locator(`[name="link_${index + 1}_label"]`)
            .fill(link.label);
          await create
            .locator(`[name="link_${index + 1}_target"]`)
            .selectOption(`northstar.app:entity.${link.target}`);
        }
        await create.getByText('States and actions', { exact: true }).click();
        await create.locator('[name="initial"]').fill('Pending');
        for (const [index, state] of inspectionStates.entries()) {
          await create
            .locator(`[name="state_${index + 1}_label"]`)
            .fill(state.label);
          await create
            .locator(`[name="state_${index + 1}_role"]`)
            .selectOption(state.role);
        }
        for (const [index, transition] of inspectionTransitions.entries()) {
          for (const key of ['label', 'from', 'to'] as const)
            await create
              .locator(`[name="transition_${index + 1}_${key}"]`)
              .fill(transition[key]);
        }
        await create
          .getByRole('button', { name: 'Draft this record type' })
          .click();
        await expect(page.locator('[data-customize-diff] pre')).toContainText(
          'Quarantine changes',
          { timeout: 180_000 },
        );
        await publish();
        await page
          .getByRole('link', {
            name: 'Open Goods Receipt Inspection',
            exact: true,
          })
          .click();
        const listUrl = page.url();
        await page.getByRole('link', { name: 'New', exact: true }).click();
        await page
          .locator(`[name$=":field.${inspection}_name"]`)
          .fill('Incoming lot');
        for (const [label, term, result] of [
          ['Goods receipt', receiptNumber, receiptNumber],
          ['Supplier', 'Cascade', 'Cascade Fastener Works'],
          ['Item', 'Field notebook', 'Field notebook'],
          ['Location', 'Calgary', 'Calgary warehouse'],
        ] as const) {
          const picker = page.getByRole('combobox', {
            name: label,
            exact: true,
          });
          await picker.fill(term);
          await page.getByRole('option').filter({ hasText: result }).click();
          await expect(picker).toHaveAttribute('data-selected-label', result);
        }
        await page
          .getByLabel('Line 1 characteristic', { exact: true })
          .fill('Length');
        await page
          .getByLabel('Line 1 measured value', { exact: true })
          .fill('21');
        await page
          .getByRole('button', { name: 'Add line', exact: true })
          .click();
        await page
          .getByLabel('Line 2 characteristic', { exact: true })
          .fill('Width');
        await page
          .getByRole('button', { name: 'Save draft', exact: true })
          .click();
        await expect(page).toHaveURL(new RegExp(`${inspection}_detail`, 'u'));
        const detailUrl = page.url();
        await expect(
          page.getByRole('cell', { name: 'Length', exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole('cell', { name: 'Width', exact: true }),
        ).toBeVisible();
        await page.getByLabel('Record actions', { exact: true }).click();
        const openReceipt = page.getByRole('link', {
          name: 'Open Goods receipt',
          exact: true,
        });
        await expect(openReceipt).toBeVisible();
        await openReceipt.click();
        await expect(page).toHaveURL(
          (url) => url.searchParams.get('record') === receipt.recordId,
        );
        await page.goto(detailUrl);
        await page.getByLabel('Record actions', { exact: true }).click();
        await page.getByLabel('More actions', { exact: true }).click();
        await page
          .getByRole('button', { name: 'Archive', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Confirm Archive', exact: true })
          .click();
        await expect(
          page.locator(
            '[data-diagnostic-code="OPERATION_ARCHIVE_HAS_DEPENDENTS"]',
          ),
        ).toBeVisible();
        await page.goto(detailUrl);
        await page.getByLabel('Record actions', { exact: true }).click();
        await page.getByRole('link', { name: 'Edit', exact: true }).click();
        await page
          .getByLabel('Line 1 measured value', { exact: true })
          .fill('22');
        await page
          .getByRole('button', { name: 'Remove line 2', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Save draft', exact: true })
          .click();
        await page
          .getByRole('button', {
            name: 'Confirm removal and save',
            exact: true,
          })
          .click();
        await expect(
          page.getByRole('cell', { name: '22', exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole('cell', { name: 'Width', exact: true }),
        ).toHaveCount(0);
        await expect(page.locator('.composition-business-status')).toHaveText(
          'Pending',
        );
        await page.getByLabel('Record actions', { exact: true }).click();
        await expect(
          page.getByRole('button', { name: 'Quarantine', exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Release', exact: true }),
        ).toHaveCount(0);
        await page
          .getByRole('button', { name: 'Quarantine', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Confirm Quarantine', exact: true })
          .click();
        await expect(page.locator('.composition-business-status')).toHaveText(
          'Quarantined',
        );
        await page.getByLabel('Record actions', { exact: true }).click();
        await expect(
          page.getByRole('button', { name: 'Release', exact: true }),
        ).toBeVisible();
        await page
          .getByRole('button', { name: 'Release', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Confirm Release', exact: true })
          .click();
        await expect(page.locator('.composition-business-status')).toHaveText(
          'Released',
        );
        await page.goto(listUrl);
        await createRecord(inspection, { name: 'Unrelated lot' });
        await page.getByRole('searchbox').last().fill(receiptNumber);
        await page.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect(
          page.getByRole('link', { name: /Open .*Incoming lot/u }),
        ).toBeVisible();
        await page
          .getByRole('link', {
            name: `Filter by Goods receipt ${receiptNumber}`,
          })
          .click();
        await expect(page).toHaveURL(/linkedRecord=/u);
        await page.getByRole('searchbox').last().fill('');
        await page.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect(
          page.getByRole('link', { name: /Open .*Incoming lot/u }),
        ).toBeVisible();
        await expect(
          page.getByRole('link', { name: /Open .*Unrelated lot/u }),
        ).toHaveCount(0);
        await expect(page.locator('[data-list-total]')).toHaveAttribute(
          'data-list-total',
          '1',
        );
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
