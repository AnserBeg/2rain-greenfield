import { randomUUID } from 'node:crypto';

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
  inspectionStates,
  inspectionTransitions,
} from '../../../../test/fixtures/inspection-customization.js';
import { inspectionLinkRecords } from '../../../../test/fixtures/inspection-link-records.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../../../../test/helpers/postgres.js';

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
