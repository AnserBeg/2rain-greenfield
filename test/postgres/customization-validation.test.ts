import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
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
          const { layouts } = await opened.service.targets();
          const form = layouts?.find(
            (t) =>
              t.body.surfaceId === 'northstar.app:surface.item_form' &&
              t.body.mode === 'create',
          );
          const detail = layouts?.find(
            (t) =>
              t.body.surfaceId === 'northstar.app:surface.item_detail' &&
              t.body.mode === 'detail',
          );
          assert.ok(form && detail);
          const { layoutCommand } =
            await import('../../packages/customization/src/layout-revision.js');
          const draft = await opened.service.draft(
            {
              kind: 'changeSet',
              patches: [form, detail].map((target) =>
                layoutCommand(target, {
                  action: 'rename',
                  member: target.body.sections[0]!.id,
                  label: 'Item identification',
                }),
              ),
            },
            'visualBuilder',
          );
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          await opened.service.approve(draft.patchId);
          await withArchivedCustomizationRuntime(
            '181aef42fddddc3bbc9bd1d164115f7e2ed05bd4',
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
                /surface-manifest requires version 28 and this runtime supports 27/u,
              );
              const form = await fetch(
                app.baseUrl + '/?surface=northstar.app%3Asurface.item_form',
              );
              assert.equal(form.status, 200);
              assert.match(
                await form.text(),
                /<legend>Item identification<\/legend>/u,
              );
              const item = app.seededRecords.find(
                (row) =>
                  row.operationId === 'northstar.app:operation.item_create',
              );
              assert.ok(item);
              const url = new URL('/', app.baseUrl);
              url.searchParams.set('surface', detail.body.surfaceId);
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
