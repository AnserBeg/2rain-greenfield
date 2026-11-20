import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { DOCUMENT_TEMPLATES_SURFACE_FLOOR } from '../../packages/canonical-model/src/documents.js';
import type { DocumentMetadata } from '../../packages/runtime/src/document-gateway.js';
import { worldOver, seededId } from '../agent/agent-world.js';
import {
  archivedRuntimeRead,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-customization-runtime.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

const id = (kind: string, name: string) => `northstar.app:${kind}.${name}`;
const companyId = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
const tenant = 'custom_service_sheet';
const template = (
  type: string,
  name: string,
  heading: string,
  query: string,
  identity: string,
) => ({
  kind: 'addDocumentTemplateRevision',
  schemaVersion: 'northstar.document-template-revision/v1',
  templateId: id('template', 'custom_' + name),
  revisionId: id('revision', 'custom_' + name + '_1'),
  previousRevisionId: null,
  entityId: id('entity', type),
  label: heading,
  documentKind: type === 'purchase_order' ? 'purchaseOrder' : 'workOrder',
  headerQueryId: id('query', query),
  identityFieldId: id('field', identity),
  currencyFieldId: null,
  format: {
    locale: 'en-CA',
    timeZone: 'America/Edmonton',
    currency: 'CAD',
    dateStyle: 'medium',
    numberGrouping: true,
    pageSize: 'LETTER',
  },
  branding: {
    displayName: 'North Star',
    ink: '#172431',
    accent: '#284467',
    logo: null,
  },
  layout: [{ kind: 'heading', text: heading }] as unknown[],
  pageNumbers: true,
});

test(
  'approved template revisions publish governed PDFs, refuse hidden sources, and retire',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'document-templates',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'document-templates',
          port: 0,
        };
        const app = await startComposedApplication({
          ...options,
          documentDemoScanner: true,
        });
        const customize = await openCustomizeService(options);
        try {
          const { service } = customize;
          const live = async (change: unknown) => {
            const draft = await service.draft(change, 'visualBuilder');
            assert.equal(draft.status, 'drafted', JSON.stringify(draft));
            await service.approve(draft.patchId);
            await service.activate(draft.patchId);
            return draft.renderedDiff;
          };
          await live({
            kind: 'changeSet',
            patches: [
              {
                kind: 'addRecordType',
                label: 'Service Sheet',
                companyOwnership: 'entityOwned',
                fields: [{ label: 'Name', type: 'text', required: true }],
              },
              {
                kind: 'addLineTable',
                entity: id('entity', tenant),
                label: 'Service Steps',
                fields: [
                  { label: 'Description', type: 'text', required: true },
                ],
              },
            ],
          });
          const po = template(
            'purchase_order',
            'purchase_pdf',
            'Purchase order',
            'purchase_order_get',
            'purchase_order_number',
          );
          const serviceSheet = template(
            tenant,
            'service_pdf',
            'Service work order',
            tenant + '_get',
            tenant + '_name',
          );
          const hidden = {
            ...po,
            layout: [
              ...po.layout,
              {
                kind: 'field',
                label: 'Undeclared',
                fieldId: id('field', tenant + '_name'),
              },
            ],
          };
          const refused = await service.draft(hidden, 'visualBuilder');
          assert.notEqual(refused.status, 'drafted');
          assert.match(
            JSON.stringify(refused),
            /selected and admitted result field/u,
          );
          serviceSheet.layout.push({
            kind: 'table',
            label: 'Work',
            queryId: id('query', tenant + '_lines_list'),
            parentRelationId: id('relation', tenant + '_lines_parent'),
            currencyFieldId: null,
            columns: [
              {
                fieldId: id('field', tenant + '_lines_description'),
                label: 'Description',
              },
            ],
          });
          const change = { kind: 'changeSet', patches: [po, serviceSheet] };
          const draft = await service.draft(change, 'visualBuilder');
          assert.equal(draft.status, 'drafted', JSON.stringify(draft));
          assert.match(
            draft.renderedDiff,
            /North Star.*[\s\S]*Service work order[\s\S]*Description/u,
          );
          const world = worldOver(app.runtime, String(connection.database));
          const sheet = await world.create(tenant, { name: 'WO-17' });
          await world.create(
            tenant + '_lines',
            { line_number: 1, description: 'Replace filter' },
            { parent: sheet.recordId },
          );
          const orderId = randomUUID();
          const created = await world.invoke('purchase_order_create', {
            recordId: orderId,
            legalEntityId: companyId,
            relations: {},
            values: {
              [id('field', 'purchase_order_supplier_party_id')]: seededId(
                'Cascade Fastener Works',
              ),
              [id('field', 'purchase_order_order_date')]:
                '2026-11-18T00:00:00.000Z',
              [id('field', 'purchase_order_currency')]: 'CAD',
            },
          });
          assert.equal(created.outcome, 'succeeded');
          const endpoint = (
            type: string,
            recordId: string,
            templateId: string,
            company?: string,
          ) =>
            new URL(
              '/documents?' +
                new URLSearchParams({
                  surface: id('surface', type + '_detail'),
                  record: recordId,
                  template: templateId,
                  ...(company ? { company } : {}),
                }),
              app.baseUrl,
            );
          const sheetUrl = endpoint(
            tenant,
            sheet.recordId,
            serviceSheet.templateId,
            companyId,
          );
          const poUrl = endpoint(
            'purchase_order',
            orderId,
            po.templateId,
            companyId,
          );
          const request = (
            endpoint: URL,
            mode: string,
            metadata?: DocumentMetadata,
            retryKey?: string,
          ) => {
            const url = new URL(endpoint);
            url.searchParams.set('mode', mode);
            if (metadata) {
              url.searchParams.set('version', metadata.versionId);
              url.searchParams.set('link', metadata.linkId);
            }
            if (mode === 'generate') {
              url.searchParams.set('retryKey', retryKey ?? randomUUID());
              return fetch(url, {
                method: 'POST',
                headers: { origin: url.origin },
              });
            }
            return fetch(url);
          };
          assert.equal((await request(sheetUrl, 'generate')).status, 404);
          await service.approve(draft.patchId);
          if (process.env.CI) {
            await withArchivedCustomizationRuntime(
              '552b13d8837a5e44ac16d3383988c167345d0295',
              async (run) => {
                const read = () =>
                  archivedRuntimeRead(run, {
                    databaseUrl: options.databaseUrl,
                    identity: app.runtime.identity,
                  });
                assert.equal((await read()).outcome, 'loaded');
                await service.activate(draft.patchId);
                assert.deepEqual(await read(), {
                  outcome: 'refused',
                  code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
                  message: `runtime capability northstar.runtime:capability.surface-manifest requires version ${DOCUMENT_TEMPLATES_SURFACE_FLOOR} and this runtime supports 28`,
                });
              },
            );
          } else {
            await service.activate(draft.patchId);
          }
          const preview = await request(sheetUrl, 'template-preview');
          assert.equal(preview.status, 200, await preview.clone().text());
          const retry = randomUUID();
          const issued = await request(sheetUrl, 'generate', undefined, retry);
          assert.equal(issued.status, 201, await issued.clone().text());
          const attachment = (await issued.json()) as DocumentMetadata;
          const same = await request(sheetUrl, 'generate', undefined, retry);
          assert.deepEqual(await same.json(), attachment);
          const second = await request(sheetUrl, 'generate');
          assert.equal(second.status, 201, await second.clone().text());
          const secondAttachment = (await second.json()) as DocumentMetadata;
          assert.notEqual(secondAttachment.versionId, attachment.versionId);
          const bytes = async (metadata: DocumentMetadata) => {
            const response = await request(sheetUrl, 'download', metadata);
            assert.equal(response.status, 200, await response.clone().text());
            return Buffer.from(await response.arrayBuffer());
          };
          const firstBytes = await bytes(attachment);
          assert.deepEqual(await bytes(secondAttachment), firstBytes);
          assert.notDeepEqual(
            Buffer.from(await preview.arrayBuffer()),
            firstBytes,
          );
          const purchase = await request(poUrl, 'generate');
          assert.equal(purchase.status, 201, await purchase.clone().text());
          const purchaseArtifact = (await purchase.json()) as DocumentMetadata;

          const count = await pool.query(`SELECT count(*)::int AS version_count,
             (SELECT count(*)::int FROM platform.document_attachment_audit) AS audit
             FROM platform.document_versions WHERE generated_source IS NOT NULL`);
          assert.deepEqual(count.rows[0], { version_count: 3, audit: 3 });
          const saved = await pool.query(
            'SELECT generated_source FROM platform.document_versions WHERE version_id = $1',
            [purchaseArtifact.versionId],
          );
          assert.equal(
            saved.rows[0]?.generated_source.revisionId,
            po.revisionId,
          );
          assert.match(saved.rows[0]?.generated_source.issuedIdentity, /^PO-/u);

          await live({
            kind: 'retireDocumentTemplate',
            schemaVersion: 'northstar.document-template-retire/v1',
            templateId: po.templateId,
            previousRevisionId: po.revisionId,
          });
          assert.equal((await request(poUrl, 'generate')).status, 404);
          assert.equal(
            (await request(poUrl, 'download', purchaseArtifact)).status,
            200,
          );

          // The parent record remains readable. Revoking the child query removes the PDF.
          const { tenantId, environmentId, principalId } = app.runtime.identity;
          const revoke = await pool.query(
            `UPDATE platform.current_policy_permission_grants SET revoked_at = clock_timestamp()
          WHERE tenant_id = $1 AND environment_id = $2 AND permission_id = $4
            AND role_id IN (SELECT role_id FROM platform.current_policy_memberships
              WHERE tenant_id = $1 AND environment_id = $2 AND principal_id = $3)`,
            [
              tenantId,
              environmentId,
              principalId,
              id('permission', tenant + '_lines_read'),
            ],
          );
          assert.ok(revoke.rowCount);
          assert.equal((await request(sheetUrl, 'generate')).status, 404);
          assert.equal(
            (await request(sheetUrl, 'download', attachment)).status,
            404,
            'a revoked source query still returned a generated PDF',
          );
          const list = await request(sheetUrl, 'list');
          assert.equal(list.status, 200);
          assert.deepEqual(await list.json(), []);
        } finally {
          await customize.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
