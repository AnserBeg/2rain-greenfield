import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { applicationWithoutLineCreateValues } from '../helpers/application-without-line-create-values.js';

import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { escapeIdentifier } from 'pg';
import { PostgresModuleRuntimeInterpreter } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import {
  PostgresReleaseVerificationService,
  verificationEvidenceIdForCandidate,
} from '../../packages/postgres-provider/src/release-verification-service.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import type { FormulaRulePayload } from '../../packages/compiler/src/formula-validation-plan.js';
import type { MintedUuid } from '../../packages/platform-runtime/src/index.js';
import type { SemanticOperationExecutionRequest } from '../../packages/runtime/src/semantic-operation-gateway.js';
import type { SemanticQueryExecutionRequest } from '../../packages/runtime/src/semantic-query-gateway.js';
import { projectionPayload } from '../compiler/helpers.js';
import {
  contactDate,
  datedPartyDefinition,
} from '../fixtures/g2/party/validation.js';
import { PARTY_IDS } from '../fixtures/g2/party/definition.js';
import {
  withRealPartyRuntime,
  invokePartyOperation,
  humanActorIssuer,
} from '../fixtures/g2/party/runtime-harness.js';
import { literalValidationDraft } from '../../packages/customization/src/validation-draft.js';
import { OperationsAgentSession } from '../../packages/operations-agent/src/session.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import {
  archivedRuntimeRead,
  assertArchivedTenantEnvelope,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-customization-runtime.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

test(
  'literal validation checks changed values, keeps old records and refuses an older serving reader',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-validation',
      async ({ connection }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'customize-validation',
          compiledApplication: applicationWithoutLineCreateValues().release,
        };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        try {
          const world = worldOver(app.runtime, String(connection.database));
          const entityId = 'northstar.app:entity.item';
          const price = 'northstar.app:field.item_price_cad';
          const name = 'northstar.app:field.item_name';
          const issue = (sku: string, value: string, recordId = randomUUID()) =>
            world.invoke(
              'item_create',
              {
                recordId,
                relations: {},
                values: {
                  [name]: `Validation ${sku}`,
                  [price]: value,
                  'northstar.app:field.item_sku': sku,
                  'northstar.app:field.item_base_unit': 'EA',
                },
              },
              { actor: 'buyer' },
            );
          const apply = (
            recordId: string,
            expectedRevision: number,
            patch: Record<string, string>,
          ) =>
            world.invoke(
              'item_update',
              { recordId, expectedRevision, patch },
              { actor: 'buyer' },
            );
          const recordId = randomUUID();
          const baseline = await issue('GUARD-OLD', '1', recordId);
          assert.equal(baseline.outcome, 'succeeded');
          const target = (
            await opened.service.targets()
          ).validationTargets?.find(
            (candidate) => candidate.entityId === entityId,
          );
          assert.ok(target);
          const message = 'Enter a price of at least $10.';
          const patch = literalValidationDraft(target, {
            fieldId: price,
            check: 'minimum',
            limit: '10',
            message,
          });
          const draft = await opened.service.draft(patch, 'visualBuilder');
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          assert.match(draft.renderedDiff, /Enter a price of at least/u);
          await opened.service.approve(draft.patchId);

          await withArchivedCustomizationRuntime(
            'bae7e49e88bfde2257b4a0cb499af9fb9f121e74',
            async (run) => {
              await assertArchivedTenantEnvelope(run);
              const read = () =>
                archivedRuntimeRead(run, {
                  databaseUrl: options.databaseUrl,
                  identity: app.runtime.identity,
                });
              assert.equal((await read()).outcome, 'loaded');
              await opened.service.activate(draft.patchId);
              const refused = await read();
              assert.equal(refused.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
              assert.match(
                refused.message ?? '',
                /operation-catalog requires version 3/u,
              );
            },
          );

          await assert.rejects(() => issue('GUARD-NEW', '9.9999'), {
            code: 'MODULE_VALIDATION_REFUSED',
            message,
          });
          const agent = new OperationsAgentSession({
            runtime: app.runtime,
            companyId: COMPANY,
            personHeaders: { cookie: 'northstar-demo-actor=manager' },
            approve: () => Promise.resolve(true),
          });
          const discover = () =>
            agent.call('erp_discover', {
              mode: 'contracts',
              canonicalIds: ['northstar.app:operation.item_create'],
            });
          assert.match(
            JSON.stringify((await discover()).content),
            /Enter a price of at least/u,
          );
          const unrelated = await apply(recordId, 1, {
            [name]: 'An unrelated edit',
          });
          assert.equal(unrelated.outcome, 'succeeded');
          const sameValue = await apply(recordId, 2, { [price]: '1' });
          assert.equal(sameValue.outcome, 'succeeded');
          await assert.rejects(() => apply(recordId, 3, { [price]: '5' }), {
            code: 'MODULE_VALIDATION_REFUSED',
            message,
          });
          assert.equal((await world.read('item', recordId)).revision, 3);
          assert.equal(
            (await apply(recordId, 3, { [price]: '10' })).outcome,
            'succeeded',
          );
          await opened.service.rollback();
          assert.doesNotMatch(
            JSON.stringify((await discover()).content),
            /Enter a price of at least/u,
          );
          assert.equal((await issue('GUARD-BACK', '5')).outcome, 'succeeded');
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

test('live date validation uses the tenant business period under the module role', async () => {
  await withRealPartyRuntime(
    'live-validation-date',
    async (runtime) => {
      const { tenantId } = runtime.contexts.a;
      // Put the tenant boundary twelve hours from now, on the previous
      // UTC day. This keeps both sample dates stable throughout the test.
      await runtime.adminPool.query(
        `INSERT INTO platform.inventory_tenant_calendars
           (tenant_id,time_zone,business_day_boundary)
         VALUES ($1, 'Etc/GMT+12', (transaction_timestamp() AT TIME ZONE 'UTC')::time)
         ON CONFLICT (tenant_id) DO UPDATE SET time_zone=EXCLUDED.time_zone,business_day_boundary=EXCLUDED.business_day_boundary`,
        [tenantId],
      );
      const {
        rows: [dates],
      } = await runtime.adminPool.query<{ today: string; tomorrow: string }>(
        `SELECT d::text AS today,(d+1)::text AS tomorrow FROM north_star_internal.inventory_business_period($1,transaction_timestamp()) d`,
        [tenantId],
      );
      assert.ok(dates);
      const create = (date: string) =>
        invokePartyOperation(runtime, runtime.views.a, 'party_create', {
          recordId: randomUUID(),
          values: {
            [PARTY_IDS.fieldIds.name]: 'Contact',
            [PARTY_IDS.fieldIds.number]: randomUUID(),
            [contactDate]: date,
          },
        });
      assert.equal((await create(dates.today)).outcome, 'succeeded');
      await assert.rejects(create(dates.tomorrow), {
        code: 'MODULE_VALIDATION_REFUSED',
        message: 'Use today or an earlier contact date.',
      });
    },
    datedPartyDefinition(),
  );
});

test('verification creates use the compiled fixture overrides even when generated values would pass', async () => {
  await withRealPartyRuntime(
    'compiled-formula-fixtures',
    async (runtime) => {
      const party = runtime.storage.entities.find(
        (entity) => entity.entityId === PARTY_IDS.entityIds.party,
      )!;
      const column = party.columns.find(
        (field) => field.canonicalFieldId === contactDate,
      )!;
      const { witnesses } = projectionPayload<FormulaRulePayload>(
        runtime.compiled,
        PROJECTION_FAMILY_IDS.formulaRule,
      );
      const expected = new Set(
        witnesses.map(
          ({ satisfying }) => satisfying.values[contactDate]?.value,
        ),
      );
      const { rows } = await runtime.adminPool.query<{ day: string }>(
        `SELECT ${escapeIdentifier(column.physicalName)}::text AS day FROM north_star_module.${escapeIdentifier(party.physicalTableName)}
         WHERE tenant_id=$1`,
        [runtime.contexts.a.tenantId],
      );
      assert.ok(rows.length > witnesses.length);
      assert.deepEqual(new Set(rows.map((row) => row.day)), expected);
    },
    datedPartyDefinition(),
  );
});

for (const action of ['create', 'update'] as const)
  test(`verification detects a formula ${action} that changed its target before reporting refusal`, async (t) => {
    await withRealPartyRuntime(
      `formula-refused-${action}`,
      async (runtime) => {
        const interpreter = new PostgresModuleRuntimeInterpreter(
          runtime.runtimePool,
          humanActorIssuer(),
          [],
          undefined,
          undefined,
          { documentNumbers: 'verificationSentinel' },
        );
        const execute = interpreter.execute.bind(interpreter);
        const view = runtime.views.a;
        t.mock.method(
          interpreter,
          'execute',
          async (
            request:
              SemanticOperationExecutionRequest | SemanticQueryExecutionRequest,
          ) => {
            if ('arguments' in request) return execute(request);
            try {
              return await execute(request);
            } catch (error) {
              if (
                request.definition.operationId !==
                  `${PARTY_IDS.namespace}:operation.party_${action}` ||
                !(
                  error instanceof Error &&
                  'code' in error &&
                  error.code === 'MODULE_VALIDATION_REFUSED'
                )
              )
                throw error;
              const { recordId } = request.input as { recordId: string };
              // Simulate a committed partial write behind the matching error.
              // The update leaves the revision untouched so a revision-only
              // readback would miss it.
              const entity = runtime.storage.entities.find(
                (e) => e.entityId === PARTY_IDS.entityIds.party,
              )!;
              const table =
                'north_star_module.' +
                escapeIdentifier(entity.physicalTableName);
              const col = (id: string) =>
                escapeIdentifier(
                  entity.columns.find((c) => c.canonicalFieldId === id)!
                    .physicalName,
                );
              const sql =
                action === 'create'
                  ? `INSERT INTO ${table} (tenant_id, environment_id, record_id, ${col(PARTY_IDS.fieldIds.name)}, ${col(PARTY_IDS.fieldIds.number)})
                   VALUES ($1,$2,$3::uuid,'Fault fixture',($3::uuid)::text)`
                  : `UPDATE ${table} SET ${col(PARTY_IDS.fieldIds.contactSummary)}='Changed by fault fixture'
                    WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3`;
              const written = await runtime.adminPool.query(sql, [
                view.tenantId,
                view.environmentId,
                recordId,
              ]);
              assert.equal(written.rowCount, 1);
              throw error;
            }
          },
        );
        const context = runtime.contexts.a;
        const releaseId = view.release.releaseId as MintedUuid;
        const command = {
          releaseId,
          compiledRelease: runtime.compiled,
          evidenceId: verificationEvidenceIdForCandidate(
            context,
            releaseId,
            runtime.compiled.releaseRoot,
          ),
        };
        await assert.rejects(
          new PostgresReleaseVerificationService(
            runtime.runtimePool,
          ).executeSemanticCandidateWithExecutor(context, command, {
            execute: interpreter.execute.bind(interpreter),
            recordNonAccepted: interpreter.recordNonAccepted.bind(interpreter),
          }),
          { code: 'VERIFICATION_FORMULA_TARGET_CHANGED' },
        );
      },
      datedPartyDefinition(),
    );
  });

test(
  'layout revisions admit the current reader, reproduce tenant bytes and refuse the preceding serving reader',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-layout-reader',
      async ({ connection }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'customize-layout-reader',
          compiledApplication: applicationWithoutLineCreateValues().release,
        };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        try {
          const document = await opened.service.draft(
            {
              kind: 'addDocumentField',
              schemaVersion: 'northstar.document-field/v1',
              entityId: 'northstar.app:entity.item',
              fieldId: 'northstar.app:field.custom_item_evidence',
              label: 'Evidence',
              type: 'files',
              maxCount: 1,
              required: false,
              allowedCategoryIds: [],
            },
            'visualBuilder',
          );
          assert.ok(document.status === 'drafted', JSON.stringify(document));
          await opened.service.approve(document.patchId);
          await opened.service.activate(document.patchId);
          const { layoutCommand } =
            await import('../../packages/customization/src/layout-revision.js');
          const surfaceId = 'northstar.app:surface.item_detail';
          const target = (await opened.service.targets()).layouts?.find(
            (t) => t.body.surfaceId === surfaceId && t.body.mode === 'detail',
          );
          assert.ok(target);
          const layout = layoutCommand(target, {
            action: 'rename',
            member: target.body.sections[0]!.id,
            label: 'Item identification',
          });
          const draft = await opened.service.draft(layout, 'visualBuilder');
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          await opened.service.approve(draft.patchId);
          await withArchivedCustomizationRuntime(
            '60451569e92ffe9aad3fc2c67bfa326a978b1f3c',
            async (run) => {
              await assertArchivedTenantEnvelope(
                run,
                'northstar.app:entity.purchase_order',
              );
              const read = () =>
                archivedRuntimeRead(run, {
                  databaseUrl: options.databaseUrl,
                  identity: app.runtime.identity,
                });
              assert.equal((await read()).outcome, 'loaded');
              await opened.service.activate(draft.patchId);
              const refused = await read();
              assert.equal(refused.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
              assert.match(
                refused.message ?? '',
                /surface-manifest requires version 28 and this runtime supports 27/u,
              );
              const item = app.seededRecords.find(
                (row) =>
                  row.operationId === 'northstar.app:operation.item_create',
              );
              assert.ok(item);
              const url = new URL('/', app.baseUrl);
              url.searchParams.set(
                'surface',
                'northstar.app:surface.item_detail',
              );
              url.searchParams.set('record', item.recordId);
              const page = await fetch(url);
              assert.equal(page.status, 200);
              const html = await page.text();
              assert.match(html, /<h2>Item identification<\/h2>/u);
              assert.match(
                html,
                /data-document-field="northstar.app:field.custom_item_evidence"/u,
              );
            },
          );
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

test(
  'a released record button opens a no-script Task, checks grants and revisions, and commits once through its declared gateway operation',
  { timeout: 600_000 },
  async () => {
    await withArchivedCustomizationRuntime(
      '1fb2f63494b6f7718de2358c7b057e4f293c2b31',
      async (run) => {
        await assertArchivedTenantEnvelope(run);
        await withEphemeralPostgres(
          'customize-popup',
          async ({ connection, pool }) => {
            const options = {
              databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
              tenantSlug: 'customize-popup',
            };
            const app = await startComposedApplication({
              ...options,
              purchaseOrdersRequireApproval: true,
              port: 0,
            });
            const opened = await openCustomizeService(options);
            try {
              const surface = 'northstar.app:surface.item_detail',
                field = 'northstar.app:field.item_description',
                operation = 'northstar.app:operation.item_update';
              const target = (
                await opened.service.targets()
              ).popupActions?.find(
                (o) => o.surface === surface && o.target.kind === 'update',
              );
              assert.ok(target, 'Customize offers the Item update Task');
              const customize = new URL('/?customize', app.baseUrl);
              const post = async (url: URL, values: Record<string, string>) =>
                (
                  await fetch(url, {
                    method: 'POST',
                    headers: { origin: url.origin },
                    body: new URLSearchParams(values),
                  })
                ).text();
              const formKey = surface + '/' + operation;
              const editor = await (
                await fetch(
                  new URL(
                    '/?customize&popup=' + encodeURIComponent(formKey),
                    app.baseUrl,
                  ),
                )
              ).text();
              assert.match(editor, /Button label/u);
              const draft = await post(customize, {
                action: 'draft',
                kind: 'addPopupActionRevision',
                popup: formKey,
                contract: target.target.contractVersion,
                label: 'Edit item note',
                predecessor: '',
                button: '',
                ['source:' + field]: 'entry',
              });
              const patchId =
                /data-customize-result="drafted" data-patch-id="([^"]+)"/u.exec(
                  draft,
                )?.[1];
              assert.ok(patchId, draft.slice(-2500));
              await opened.service.approve(patchId);
              const historicalRead = () =>
                archivedRuntimeRead(run, {
                  databaseUrl: options.databaseUrl,
                  identity: app.runtime.identity,
                });
              assert.equal((await historicalRead()).outcome, 'loaded');
              await opened.service.activate(patchId);
              const refusal = await historicalRead();
              assert.equal(refusal.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
              assert.match(
                refusal.message ?? '',
                /surface-manifest requires version 37 and this runtime supports 36/u,
              );
              const option = (
                await opened.service.targets()
              ).popupActions!.find(
                (o) => o.surface === surface && o.target.kind === 'update',
              )!;
              const revision = option.existing[0]!;
              const record = app.seededRecords.find((r) =>
                r.operationId.endsWith(':operation.item_create'),
              )!;
              const url = new URL('/', app.baseUrl);
              url.searchParams.set('surface', surface);
              url.searchParams.set('record', record.recordId);
              const actualUrl = new URL((await fetch(url)).url);
              const receiptCount = async () =>
                Number(
                  (
                    await pool.query(
                      'SELECT count(*) FROM platform.semantic_operation_receipts WHERE tenant_id=$1 AND action_id=$2',
                      [app.runtime.identity.tenantId, operation],
                    )
                  ).rows[0].count,
                );
              const assistant = new OperationsAgentSession({
                runtime: app.runtime,
                companyId: COMPANY,
                personHeaders: { cookie: 'northstar-demo-actor=buyer' },
                approve: () => Promise.resolve(false),
              });
              const assistantContext = () =>
                assistant.turnContext({
                  surfaceId: surface,
                  recordId: record.recordId,
                });
              assert.ok(
                (await assistantContext()).includes(revision.actionId),
                'the assistant resolves this record button from its release',
              );
              const start = await receiptCount();
              const button = { compositionAction: revision.actionId };
              const page = await (await fetch(actualUrl)).text();
              assert.ok(
                page.includes('value="' + revision.actionId + '"'),
                'the record offers its custom action',
              );
              const open = async () => {
                const html = await post(actualUrl, button);
                assert.match(
                  html,
                  /<dialog open[^>]*data-task-fallback="page"/u,
                );
                assert.ok(
                  html.includes(operation) && html.includes(record.recordId),
                );
                const token = /name="taskToken" value="([^"]+)"/u.exec(
                  html,
                )?.[1];
                assert.ok(token);
                return { ...button, taskToken: token };
              };
              const first = await open(),
                stale = await open();
              assert.equal(await receiptCount(), start);
              const result = await post(actualUrl, {
                ...first,
                taskStage: 'apply',
                [field]: 'Dock three',
              });
              assert.match(result, /Edit item note: done/u);
              assert.equal(await receiptCount(), start + 1);
              await post(actualUrl, { ...first, taskStage: 'retry' });
              assert.equal(await receiptCount(), start + 1);
              const old = await post(actualUrl, {
                ...stale,
                taskStage: 'apply',
                [field]: 'Stale value',
              });
              assert.match(old, /Task unavailable/u);
              assert.doesNotMatch(old, /Edit item note: done/u);
              assert.equal(await receiptCount(), start + 1);
              const after = await (await fetch(actualUrl)).text();
              assert.match(after, /Dock three/u);
              assert.doesNotMatch(after, /Stale value/u);
              const { popupCommand, popupOptionId } =
                await import('../../packages/customization/src/popup-revision.js');
              const place = (await opened.service.targets()).popupActions!.find(
                (o) =>
                  o.target.operationId.endsWith(
                    ':operation.purchase_order_release',
                  ),
              )!;
              const send = popupCommand([place], {
                option: popupOptionId(place),
                label: 'Send to vendor',
                inputs: [
                  {
                    binding: place.fields[0]!.id,
                    source: 'constant',
                    value: 'Dock <3>',
                  },
                ],
              });
              const approved = await opened.service.draft(
                send,
                'visualBuilder',
              );
              assert.ok(
                approved.status === 'drafted',
                JSON.stringify(approved),
              );
              await opened.service.approve(approved.patchId);
              await opened.service.activate(approved.patchId);
              const world = worldOver(app.runtime, String(connection.database));
              const supplier = app.seededRecords.find((r) =>
                r.operationId.endsWith(':operation.party_create'),
              )!.recordId;
              await world.invoke('party_role_create', {
                recordId: randomUUID(),
                values: {
                  'northstar.app:field.party_role_kind':
                    'northstar.app:option.supplier',
                  'northstar.app:field.party_role_status':
                    'northstar.app:option.active',
                },
                relations: {
                  'northstar.app:relation.party_role_party': supplier,
                },
              });
              const order = await world.create('purchase_order', {
                supplier_party_id: supplier,
                order_date: new Date().toISOString(),
                currency: 'CAD',
              });
              await world.create(
                'purchase_order_line',
                {
                  line_number: '1',
                  item_id: record.recordId,
                  ordered_quantity: '1',
                  unit_price: '5',
                },
                { order: order.recordId },
              );
              const po = new URL('/', app.baseUrl);
              po.searchParams.set('surface', place.surface);
              po.searchParams.set('record', order.recordId);
              po.searchParams.set(
                'northstar.app:parameter.commercial_purchase_order_get_legal_entity_scope',
                COMPANY,
              );
              const poUrl = new URL((await fetch(po)).url);
              const launch = { compositionAction: send.actionId };
              assert.doesNotMatch(
                await post(poUrl, launch),
                /name="taskToken"/u,
                'a configured independent approval blocks the custom Place action',
              );
              // The approver explicitly releases this order through the original approval operations.
              const current = await world.read(
                'purchase_order',
                order.recordId,
              );
              await world.invoke(
                'purchase_order_submit',
                {
                  recordId: order.recordId,
                  expectedRevision: current.revision,
                },
                { actor: 'buyer' },
              );
              const request = (
                await world.list(
                  'northstar.app:query.purchase_order_approval_list',
                )
              )[0]!;
              await world.invoke(
                'purchase_order_approval_approve',
                {
                  recordId: request.recordId,
                  expectedRevision: request.revision,
                  arguments: { reason: 'Approved for delivery' },
                },
                { actor: 'manager' },
              );
              const openedTask = await post(poUrl, launch);
              const taskToken = /name="taskToken" value="([^"]+)"/u.exec(
                openedTask,
              )?.[1];
              assert.ok(taskToken, openedTask.slice(-900));
              const task = { ...launch, taskToken };
              assert.doesNotMatch(
                await post(poUrl, { ...task, taskStage: 'apply' }),
                /Send to vendor: done/u,
              );
              const review = async () => {
                const html = await post(poUrl, {
                  ...task,
                  taskStage: 'prepare',
                });
                assert.match(html, /Fixed value/u);
                assert.match(html, /Dock &lt;3&gt;/u);
                const id = /name="preparedId" value="([^"]+)"/u.exec(html)?.[1];
                assert.ok(id);
                return id;
              };
              const oldPreparation = await review();
              await post(poUrl, { ...task, taskStage: 'edit' });
              assert.doesNotMatch(
                await post(poUrl, {
                  ...task,
                  taskStage: 'confirm',
                  preparedId: oldPreparation,
                }),
                /Send to vendor: done/u,
              );
              const completed = await post(poUrl, {
                ...task,
                taskStage: 'confirm',
                preparedId: await review(),
              });
              assert.match(completed, /Send to vendor: done/u);
              const placed = await world.read('purchase_order', order.recordId);
              assert.equal(
                placed.values[
                  'northstar.app:derived_state_field.machine.purchase_order_lifecycle'
                ],
                'northstar.app:state.purchase_order_released',
              );
              const restrict = await opened.service.draft(
                {
                  kind: 'narrowPermission',
                  roleKey: 'local-demo-full-release',
                  target: { kind: 'operation', id: operation },
                },
                'visualBuilder',
              );
              assert.ok(
                restrict.status === 'drafted',
                JSON.stringify(restrict),
              );
              await opened.service.approve(restrict.patchId);
              await opened.service.activate(restrict.patchId);
              const denied = await opened.service.draft(
                {
                  ...revision,
                  kind: 'addPopupActionRevision',
                  revisionId: randomUUID(),
                  predecessor: revision.revisionId,
                },
                'visualBuilder',
              );
              assert.ok(
                denied.status === 'refused' &&
                  denied.code === 'CUSTOMIZE_POPUP_OPERATION_DENIED',
                JSON.stringify(denied),
              );
              assert.ok(
                !(await (await fetch(actualUrl)).text()).includes(
                  'value="' + revision.actionId + '"',
                ),
              );
              assert.ok(
                !(await assistantContext()).includes(revision.actionId),
                'the assistant also withholds the restricted button',
              );
              assert.doesNotMatch(
                await post(actualUrl, button),
                /name="taskToken"/u,
              );
            } finally {
              await opened.close();
              await app.close();
            }
          },
          LINEAGE_INSTALL_VOLUME,
        );
      },
    );
  },
);

test(
  'a preceding serving reader admits the same tenant until Board activation',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'customize-board-reader',
      async ({ connection }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'customize-board-reader',
          compiledApplication: applicationWithoutLineCreateValues().release,
        };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        try {
          const { draftBoardRevision } =
            await import('../../packages/customization/src/board-revision.js');
          const { BOARD_READER } =
            await import('../../packages/canonical-model/src/board.js');
          const target = (await opened.service.targets()).boards?.find(
            (t) => t.body.entityId === 'northstar.app:entity.purchase_order',
          );
          assert.ok(target);
          const revision = draftBoardRevision(
            target,
            'Purchase order board',
            target.body.grouping.stages.map((s) => s.stateId),
          );
          const draft = await opened.service.draft(revision, 'visualBuilder');
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          await opened.service.approve(draft.patchId);
          await withArchivedCustomizationRuntime(
            '032b87c00df3ee22184685050b9cecc01c62cc59',
            async (run) => {
              await assertArchivedTenantEnvelope(run);
              const read = () =>
                archivedRuntimeRead(run, {
                  databaseUrl: options.databaseUrl,
                  identity: app.runtime.identity,
                });
              assert.equal((await read()).outcome, 'loaded');
              await opened.service.activate(draft.patchId);
              const refused = await read();
              assert.equal(refused.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
              assert.ok(
                refused.message?.includes(
                  'surface-manifest requires version ' +
                    BOARD_READER +
                    ' and this runtime supports ' +
                    (BOARD_READER - 1),
                ),
                refused.message,
              );
              const url = new URL('/', app.baseUrl);
              url.searchParams.set('surface', revision.surfaceId);
              const response = await fetch(url);
              const html = await response.text();
              assert.equal(
                response.status,
                200,
                html.match(/data-diagnostic-code="[^"]+"/u)?.[0] ??
                  html.replace(/<[^>]+>/gu, ' ').slice(-900),
              );
              assert.match(html, /<h1[^>]*>Purchase order board<\/h1>/u);
            },
          );
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
