import { DRAFT_CUSTOMIZATION_TOOL } from '../../../../packages/customization/src/ai-draft.js';
import { provisionLocalDemoAuthorization } from '../../../../packages/postgres-provider/src/composed-application-runtime.js';
import { workflowAutomationPrincipal } from '../../../../packages/postgres-provider/src/workflow-admission.js';
import {
  OperationsAgentSession,
  runOperationsAgent,
  scriptedModel,
  SpendMeter,
} from '../../../../packages/operations-agent/src/index.js';
import {
  COMPANY,
  seededId,
  worldOver,
} from '../../../../test/agent/agent-world.js';
import { referenceScript } from '../../../../test/agent/reference-scripts.js';
import { TASKS } from '../../../../test/agent/tasks.js';
import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  startComposedApplication,
  openCustomizeService,
} from '../../../api/src/composition-root.js';
import { composedApplicationSeed } from '../../../../packages/domain/src/app/seed.js';
import { SEMANTIC_OPERATION_REQUEST_VERSION } from '../../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  inspection,
  inspectionChange,
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
      const options = {
        databaseUrl,
        tenantSlug,
        port: 0,
        seedProfile: 'distributor',
      } as const;
      const seeded = await startComposedApplication(options);
      await seeded.close();
      const opened = await openCustomizeService(options);
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
      const item = seededId('Field notebook');
      const summary = 'Escalate the pending inspection';
      const start = new Date('2026-11-19T17:30:00.000Z');
      let instant = start;
      const operationInput = (receiptId: string) => ({
        legalEntityId: COMPANY,
        recordId: receiptId,
        values: { [inspectionName]: 'Inspect incoming notebooks' },
        relations: { [receiptLink]: receiptId },
      });
      const example = randomUUID();
      const readInspection = {
        recordId: example,
        [inspectionArguments]: COMPANY,
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
              legalEntityId: COMPANY,
            },
            effects: [
              {
                call: {
                  kind: 'query',
                  id: movementQuery,
                  input: { [movementArguments]: COMPANY },
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
      try {
        const recordDraft = await opened.service.draft(
          inspectionChange,
          'declarativeEditor',
        );
        if (recordDraft.status !== 'drafted')
          throw new Error(JSON.stringify(recordDraft));
        const approved = await opened.service.approve(recordDraft.patchId);
        await opened.service.activate(recordDraft.patchId);
        const { tenantId, environmentId } = seeded.runtime.identity;
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
          await page.goto(`${app.baseUrl}/?customize`);
          const ask = page.locator('[data-customize-form="ask"]');
          await ask
            .locator('textarea')
            .fill(
              'When Field notebooks arrive, create a linked inspection and ask to escalate if it is pending after two days.',
            );
          await ask.getByRole('button', { name: 'Draft it' }).click();
          await expect(page.locator('[data-customize-diff]')).toContainText(
            workflowId,
            { timeout: 180_000 },
          );
          await expect(
            page.locator('[data-customize-result="activated"]'),
          ).toHaveCount(0);
          await page
            .getByRole('button', { name: 'Approve', exact: true })
            .click();
          await page.getByRole('button', { name: 'Activate now' }).click();
          await expect(
            page.locator('[data-customize-result="activated"]'),
          ).toBeVisible({ timeout: 180_000 });
          const world = worldOver(app.runtime, 'postgres');
          const task = TASKS.find(({ id }) => id === 5)!;
          const context = await task.arrange(world);
          const session = new OperationsAgentSession({
            runtime: app.runtime,
            companyId: COMPANY,
            personHeaders: { cookie: 'northstar-demo-actor=buyer' },
            approve: () => Promise.resolve(true),
          });
          const posted = await runOperationsAgent({
            meter: new SpendMeter(null, 1),
            model: scriptedModel(referenceScript(task.id, context)),
            request: task.request(context),
            session,
          });
          expect(posted.stop, posted.answer).toBe('answered');
          expect(
            session.toolCalls.every((call) => !call.isError),
            posted.answer,
          ).toBe(true);
          const lookup = () =>
            pool.query<{ record_id: string }>(
              "SELECT record_id FROM platform.trust_business_change_documents WHERE tenant_id=$1 AND action_id=$2 AND channel='WORKFLOW'",
              [tenantId, create],
            );
          await expect
            .poll(async () => (await lookup()).rows.length, { timeout: 45_000 })
            .toBe(1);
          const receiptId = (await lookup()).rows[0]!.record_id;
          const detail = new URL(app.baseUrl);
          detail.searchParams.set(
            'surface',
            `${prefix}:surface.${inspection}_detail`,
          );
          detail.searchParams.set('record', receiptId);
          await page.goto(detail.toString());
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
          await app.close();
        }
      } finally {
        await opened.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
});
