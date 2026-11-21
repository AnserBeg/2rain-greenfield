import { DRAFT_CUSTOMIZATION_TOOL } from '../../../../packages/customization/src/ai-draft.js';
import { provisionLocalDemoAuthorization } from '../../../../packages/postgres-provider/src/composed-application-runtime.js';
import { workflowAutomationPrincipal } from '../../../../packages/postgres-provider/src/workflow-admission.js';
import { scriptedModel } from '../../../../packages/operations-agent/src/index.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  startComposedApplication,
  openCustomizeService,
} from '../../../api/src/composition-root.js';
import { WORKFLOW_SURFACE_FLOOR } from '../../../../packages/canonical-model/src/workflows.js';
import { composedApplicationSeed } from '../../../../packages/domain/src/app/seed.js';
import type { ImmutableJsonValue } from '../../../../packages/runtime/src/request-runtime-view.js';
import {
  parsePinnedOperationCatalog,
  SEMANTIC_OPERATION_REQUEST_VERSION,
} from '../../../../packages/runtime/src/semantic-operation-gateway.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../../../packages/runtime/src/semantic-query-gateway.js';
import {
  archivedRuntimeRead,
  withArchivedCustomizationRuntime,
} from '../../../../test/helpers/archived-runtime-process.js';
import {
  inspection,
  inspectionChange,
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

test('a drafted receipt workflow links an inspection and requests escalation after two days', async ({
  page,
}) => {
  test.setTimeout(900_000);
  await withEphemeralPostgres(
    'inspection-workflow-browser',
    async ({ connection, pool }) => {
      const databaseUrl = `postgresql://postgres@${String(connection.host)}:${String(connection.port)}/postgres`;
      const tenantSlug = 'inspection-workflow-browser';
      // Compile with the current permissions and omit the count editor's floor.
      // Run the existing compiler fixture through tsx, as the Node suites do.
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          '-e',
          `const { applicationWithoutLineCreateValues } = require('./test/helpers/application-without-line-create-values.ts');
process.stdout.write(JSON.stringify(applicationWithoutLineCreateValues().release));`,
        ],
        {
          cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const options = {
        databaseUrl,
        tenantSlug,
        compiledApplication: JSON.parse(stdout) as unknown,
        port: 0,
        seedProfile: 'demo',
      } as const;
      const workflowId = 'inspect-incoming-notebooks';
      const prefix = 'northstar.app';
      const movementQuery = `${prefix}:query.inventory_movement_list`;
      const inspectionQuery = `${prefix}:query.${inspection}_get`;
      const create = `${prefix}:operation.${inspection}_create`;
      const quarantine = `${prefix}:operation.${inspection}_action_quarantine`;
      const movementArguments = `${prefix}:parameter.inventory_movement_list_legal_entity_scope`;
      const inspectionArguments = `${prefix}:parameter.${inspection}_get_legal_entity_scope`;
      const inspectionName = `${prefix}:field.${inspection}_name`;
      const inspectionState = `${prefix}:derived_state_field.machine.${inspection}`;
      const receiptLink = `${prefix}:relation.${inspection}_goods_receipt`;
      const company = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
      const seed = composedApplicationSeed('demo');
      const seedId = (name: string) => {
        const row = seed.find((record) =>
          Object.values(record.values).includes(name),
        );
        if (!row) throw new Error(`Missing seed record ${name}`);
        return row.recordId;
      };
      const item = seedId('Field notebook');
      const summary = 'Escalate the pending inspection';
      const start = new Date('2026-11-19T17:30:00.000Z');
      let instant = start;
      const operationInput = (receiptId: string) => ({
        legalEntityId: company,
        recordId: receiptId,
        values: { [inspectionName]: 'Inspect incoming notebooks' },
        relations: { [receiptLink]: receiptId },
      });
      const example = randomUUID();
      const readInspection = {
        recordId: example,
        [inspectionArguments]: company,
      };
      const pending = {
        recordId: example,
        revision: 1,
        values: { [inspectionState]: `${prefix}:state.${inspection}_pending` },
      };
      const modelDraft = {
        kind: 'saveWorkflow',
        workflow: {
          schemaVersion: 'v6',
          workflowId,
          trigger: 'goodsReceiptPosted',
          grants: {
            queries: [inspectionQuery, movementQuery],
            operations: [quarantine, create].sort(),
          },
        },
        body: `
        const moves = sdk.query('${movementQuery}', { '${movementArguments}': event.legalEntityId });
        if (!moves.records.some(({ values }) =>
          values['${prefix}:field.inventory_movement_source_id'] === event.receiptId &&
          values['${prefix}:field.inventory_movement_item_id'] === '${item}')) {
          if (moves.records.length === 100) throw new Error('Receipt item cannot be established from this result');
          return;
        }
        sdk.operation('${create}', {
          recordId: event.receiptId, legalEntityId: event.legalEntityId,
          values: { '${inspectionName}': 'Inspect incoming notebooks' },
          relations: { '${receiptLink}': event.receiptId }
        });
        sdk.sleep(172800000);
        const current = sdk.query('${inspectionQuery}', {
          recordId: event.receiptId, '${inspectionArguments}': event.legalEntityId
        }).records[0];
        if (current && current.values['${inspectionState}'] === '${prefix}:state.${inspection}_pending') {
          sdk.requestApproval('${summary}', '${quarantine}', {
            recordId: current.recordId, expectedRevision: current.revision
          });
        }`,
        fixtures: [
          {
            event: {
              type: 'goodsReceiptPosted',
              eventId: randomUUID(),
              receiptId: example,
              legalEntityId: company,
            },
            effects: [
              {
                call: {
                  kind: 'query',
                  id: movementQuery,
                  input: { [movementArguments]: company },
                },
                result: {
                  outcome: 'exact',
                  records: [
                    {
                      recordId: randomUUID(),
                      revision: 1,
                      values: {
                        [`${prefix}:field.inventory_movement_source_id`]:
                          example,
                        [`${prefix}:field.inventory_movement_item_id`]: item,
                      },
                    },
                  ],
                },
              },
              {
                call: {
                  kind: 'operation',
                  id: create,
                  input: operationInput(example),
                },
                result: { outcome: 'succeeded', readBack: pending },
              },
              {
                call: { kind: 'sleep', milliseconds: 172800000 },
                result: null,
              },
              {
                call: {
                  kind: 'query',
                  id: inspectionQuery,
                  input: readInspection,
                },
                result: { outcome: 'exact', records: [pending] },
              },
              {
                call: {
                  kind: 'requestApproval',
                  summary,
                  operationId: quarantine,
                  input: { recordId: example, expectedRevision: 1 },
                },
                result: true,
              },
            ],
          },
        ],
      };
      const app = await startComposedApplication({
        ...options,
        draftingProvider: () =>
          Promise.resolve(
            scriptedModel([
              () => ({
                toolCalls: [
                  { name: DRAFT_CUSTOMIZATION_TOOL, input: modelDraft },
                ],
              }),
            ]),
          ),
        workflowScheduler: {
          workerDatabaseUrl: databaseUrl.replace(
            'postgres@',
            'north_star_workflow_worker@',
          ),
          runtimeDatabaseUrl: databaseUrl.replace(
            'postgres@',
            'north_star_runtime@',
          ),
          businessClock: () => instant,
        },
      });
      try {
        const opened = await openCustomizeService(options);
        try {
          const recordDraft = await opened.service.draft(
            inspectionChange,
            'declarativeEditor',
          );
          if (recordDraft.status !== 'drafted')
            throw new Error(JSON.stringify(recordDraft));
          const approved = await opened.service.approve(recordDraft.patchId);
          await opened.service.activate(recordDraft.patchId);
          const { tenantId, environmentId } = app.runtime.identity;
          const approver = await pool.query<{ approving_human_id: string }>(
            'SELECT approving_human_id FROM platform.release_approvals WHERE tenant_id=$1 AND environment_id=$2 AND activation_attempt_id=$3',
            [tenantId, environmentId, approved.activationAttemptId],
          );
          const bindings = [
            {
              action: 'read',
              permissionId: `${prefix}:permission.inventory_movement_read`,
              resourceId: `${prefix}:entity.inventory_movement`,
            },
            ...['create', 'read', 'transition'].map((action) => ({
              action,
              permissionId: `${prefix}:permission.${inspection}_${action === 'transition' ? 'action_quarantine' : action}`,
              resourceId: `${prefix}:entity.${inspection}`,
            })),
          ];
          for (const [principalId, role] of [
            [
              workflowAutomationPrincipal(tenantId, environmentId, workflowId),
              'inspection-workflow',
            ],
            [
              approver.rows[0]!.approving_human_id,
              'inspection-workflow-approver',
            ],
          ] as const) {
            await provisionLocalDemoAuthorization(
              pool,
              { tenantId, environmentId, principalId },
              bindings,
              role,
            );
          }
          await page.goto(`${app.baseUrl}/?customize`);
          await page
            .getByRole('combobox', { name: 'Acting as' })
            .selectOption('manager');
          await page.getByRole('button', { name: 'Switch person' }).click();
          await page.goto(`${app.baseUrl}/?customize`);
          const ask = page.locator('[data-customize-form="ask"]');
          await ask
            .locator('textarea')
            .fill(
              'When Field notebooks arrive, create a linked inspection and ask to escalate if it is pending after two days.',
            );
          await ask.getByRole('button', { name: 'Draft it' }).click();
          const draftResult = page.locator(
            '[data-customize-result="drafted"], [data-customize-result="refused"]',
          );
          await expect(draftResult).toBeVisible({ timeout: 180_000 });
          expect(
            await draftResult.getAttribute('data-customize-result'),
            await draftResult.innerText(),
          ).toBe('drafted');
          await expect(page.locator('[data-customize-diff]')).toContainText(
            workflowId,
            { timeout: 180_000 },
          );
          const review = page.locator('[data-customize-diff]');
          await expect(review).toContainText(modelDraft.body);
          await expect(review).toContainText('Waits 2 days without asking.');
          await expect(review).toContainText('Calls in the script');
          const digest = await page
            .locator('input[name="reviewedDigest"]')
            .inputValue();
          await page.goto(`${app.baseUrl}/?customize`);
          await page.getByRole('button', { name: 'Review workflow' }).click();
          await expect(
            page.locator('input[name="reviewedDigest"]'),
          ).toHaveValue(digest);
          await expect(
            page.locator('[data-customize-result="activated"]'),
          ).toHaveCount(0);
          await page
            .getByRole('button', { name: 'Approve', exact: true })
            .click();
          await expect(page.getByRole('main')).toContainText(
            'Approved — not live yet',
          );
          const activate = async () => {
            await page.getByRole('button', { name: 'Activate now' }).click();
            const result = page.locator(
              '[data-customize-result="activated"], [data-customize-result="refused"]',
            );
            await expect(result).toBeVisible({ timeout: 180_000 });
            expect(
              await result.getAttribute('data-customize-result'),
              await result.innerText(),
            ).toBe('activated');
          };
          if (process.env.CI) {
            await withArchivedCustomizationRuntime(
              '552b13d8837a5e44ac16d3383988c167345d0295',
              async (run) => {
                const read = () =>
                  archivedRuntimeRead(run, {
                    databaseUrl,
                    identity: app.runtime.identity,
                  });
                expect((await read()).outcome).toBe('loaded');
                await activate();
                expect(await read()).toEqual({
                  outcome: 'refused',
                  code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
                  message: expect.stringContaining(
                    `northstar.runtime:capability.surface-manifest requires version ${WORKFLOW_SURFACE_FLOOR}`,
                  ),
                });
              },
            );
          } else {
            await activate();
          }
          const runtime = app.runtime;
          const headers = { cookie: 'northstar-demo-actor=manager' };
          const invoke = (local: string, input: ImmutableJsonValue) =>
            runtime.entry.run({ headers }, async (view) => {
              const operationId = `${prefix}:operation.${local}`;
              const operation = parsePinnedOperationCatalog(
                view.projections.operation.payload,
              ).find((entry) => entry.operationId === operationId);
              if (!operation) throw new Error(`Missing ${operationId}`);
              const result = await runtime.operationGateway.invoke(
                view,
                {
                  schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
                  idempotencyKey: randomUUID(),
                  operationId,
                  input,
                  confirmationGrant:
                    operation.confirmation === 'humanRequired'
                      ? runtime.operationMediation.issueConfirmationGrant(
                          view,
                          operationId,
                          input,
                        )
                      : null,
                },
                runtime.operationMediation.issueInvocation(view, 'UI'),
              );
              if (result.outcome !== 'succeeded' || !result.readBack) {
                throw new Error(`${local} failed: ${JSON.stringify(result)}`);
              }
              return result.readBack;
            });
          const createRecord: Parameters<typeof inspectionLinkRecords>[0] = (
            local,
            values,
            relations = {},
          ) =>
            invoke(`${local}_create`, {
              recordId: randomUUID(),
              legalEntityId: company,
              values: Object.fromEntries(
                Object.entries(values).map(([key, value]) => [
                  `${prefix}:field.${local}_${key}`,
                  value,
                ]),
              ),
              relations: Object.fromEntries(
                Object.entries(relations).map(([key, value]) => [
                  `${prefix}:relation.${local}_${key}`,
                  value,
                ]),
              ),
            });
          const transition = async (
            local: string,
            action: string,
            recordId: string,
          ) => {
            const current = await runtime.entry.run(
              { headers },
              async (view) => {
                const result = await runtime.queryGateway.invoke(view, {
                  schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
                  queryId: `${prefix}:query.${local}_get`,
                  arguments: {
                    recordId,
                    [`${prefix}:parameter.${local}_get_legal_entity_scope`]:
                      company,
                  },
                });
                const record = result.records[0];
                if (!record) throw new Error(`Missing ${local} ${recordId}`);
                return record;
              },
            );
            return invoke(`${local}_${action}`, {
              recordId,
              expectedRevision: current.revision,
            });
          };
          const location = seedId('Calgary warehouse');
          const order = await createRecord('purchase_order', {
            supplier_party_id: seedId('Summit Industrial'),
            order_date: start.toISOString(),
            currency: 'CAD',
            receiving_location_id: location,
          });
          const orderLine = await createRecord(
            'purchase_order_line',
            {
              line_number: '1',
              item_id: item,
              ordered_quantity: '8',
              unit_price: '4',
            },
            { order: order.recordId },
          );
          await transition('purchase_order', 'release', order.recordId);
          const receipt = await createRecord(
            'goods_receipt',
            {
              state: `${prefix}:option.goods_receipt_state_draft`,
              kind: `${prefix}:option.goods_receipt_kind_initial`,
              effective_at: start.toISOString(),
              location_id: location,
              reason_code: 'RECEIVE',
              reason_narrative: 'Received in full',
            },
            { order: order.recordId },
          );
          const receiptId = receipt.recordId;
          await createRecord(
            'goods_receipt_line',
            {
              line_number: '1',
              item_id: item,
              quantity: '8',
              unit_id: 'EA',
              cost_status: `${prefix}:option.goods_receipt_line_cost_status_known`,
              unit_cost: '4',
              currency: 'CAD',
            },
            { receipt: receiptId, order_line: orderLine.recordId },
          );
          await transition('goods_receipt', 'post', receiptId);
          await expect
            .poll(
              async () => {
                const result = await pool.query<{ record_id: string }>(
                  `SELECT change.record_id
                     FROM platform.trust_business_change_documents AS change
                     JOIN platform.trust_action_invocations AS invocation
                       USING (tenant_id, environment_id, invocation_id)
                    WHERE change.tenant_id = $1 AND change.environment_id = $2
                      AND change.action_id = $3 AND invocation.channel = 'WORKFLOW'`,
                  [tenantId, environmentId, create],
                );
                return result.rows.map((row) => row.record_id);
              },
              { timeout: 45_000 },
            )
            .toEqual([receiptId]);
          await page
            .getByRole('link', {
              name: 'Open Goods Receipt Inspection',
              exact: true,
            })
            .click();
          await page
            .getByRole('link', { name: /Open .*Inspect incoming notebooks/u })
            .click();
          await expect(page).toHaveURL(
            (url) => url.searchParams.get('record') === receiptId,
          );
          await expect(page.locator('.composition-business-status')).toHaveText(
            'Pending',
          );
          await page.getByLabel('Record actions', { exact: true }).click();
          await page
            .getByRole('link', { name: 'Open Goods receipt', exact: true })
            .click();
          await expect(page).toHaveURL(
            (url) => url.searchParams.get('record') === receiptId,
          );
          await page.goto(`${app.baseUrl}/?approvals`);
          await expect(page.getByText(summary, { exact: true })).toHaveCount(0);
          await expect
            .poll(
              async () =>
                (
                  await pool.query(
                    'SELECT run_id FROM platform.workflow_timers WHERE tenant_id=$1',
                    [tenantId],
                  )
                ).rowCount,
            )
            .toBe(1);
          instant = new Date(start.getTime() + 172800000);
          await expect(async () => {
            await page.reload();
            await expect(page.getByText(summary, { exact: true })).toBeVisible({
              timeout: 1000,
            });
          }).toPass({ timeout: 45_000 });
          await expect(
            page.locator('[data-workflow-approval] pre'),
          ).toContainText(receiptId);

          await page.goto(`${app.baseUrl}/?customize`);
          await page
            .getByRole('button', { name: 'Roll back the latest change' })
            .click({ timeout: 180_000 });
          await expect(
            page.locator('[data-customize-result="rolledBack"]'),
          ).toBeVisible({ timeout: 180_000 });
          await page.goto(`${app.baseUrl}/?approvals`);
          await expect(page.getByText(summary, { exact: true })).toHaveCount(0);
          const history = await pool.query(
            'SELECT run_id FROM platform.workflow_pending_approvals WHERE tenant_id=$1',
            [tenantId],
          );
          expect(history.rowCount).toBe(1);
        } finally {
          await opened.close();
        }
      } finally {
        await app.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});
