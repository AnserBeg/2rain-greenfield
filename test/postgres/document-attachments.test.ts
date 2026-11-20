import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { applicationWithoutLineCreateValues } from '../helpers/application-without-line-create-values.js';
import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  DOCUMENT_DEMO_SCANNER_LABEL,
  DOCUMENT_FILES_SURFACE_FLOOR,
  DOCUMENT_TENANT_MAX_BYTES,
  documentAttachOperation,
} from '../../packages/canonical-model/src/documents.js';
import type { DocumentMetadata } from '../../packages/runtime/src/document-gateway.js';
import {
  ensureScope,
  rolePool,
  trustedContext,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';

import { worldOver } from '../agent/agent-world.js';
import {
  archivedRuntimeRead,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-customization-runtime.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGOoBwAAgQCA05RTSgAAAABJRU5ErkJggg==',
  'base64',
);
const itemSurface = 'northstar.app:surface.item_detail';
const companySurface = 'northstar.app:surface.inventory_transaction_detail';

test(
  'internal files use live record authority, scoped dedupe, bounded ingress and immutable audit',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'documents-internal',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'documents-internal',
          port: 0,
        };
        const app = await startComposedApplication({
          ...options,
          documentDemoScanner: true,
        });
        try {
          const item = app.seededRecords.find(
            (row) => row.operationId === 'northstar.app:operation.item_create',
          )!;
          const world = worldOver(app.runtime, String(connection.database));
          const transactionId = randomUUID();
          const transaction = await world.create(
            'inventory_transaction',
            {
              actor_id: 'document-test',
              recorded_at: new Date().toISOString(),
              source_id: transactionId,
              source_type: 'inventoryTransaction',
              state: 'northstar.app:option.inventory_transaction_state_draft',
              effective_at: new Date().toISOString(),
              reason_code: 'SETUP',
              reason_narrative: 'Attachment evidence',
              type: 'northstar.app:option.inventory_transaction_type_adjustment',
            },
            {},
            transactionId,
          );
          const company = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
          const itemUrl = documentUrl(app.baseUrl, itemSurface, item.recordId);
          const companyUrl = documentUrl(
            app.baseUrl,
            companySurface,
            transaction.recordId,
            company,
          );
          assert.equal(
            app.runtime.documents?.scannerLabel,
            DOCUMENT_DEMO_SCANNER_LABEL,
          );
          const retryKey = randomUUID();
          await assert.rejects(
            app.runtime.entry.run({}, (view) =>
              app.runtime.operationGateway.invoke(
                view,
                {
                  schemaVersion: 'northstar.semantic-operation-request/v1',
                  operationId: documentAttachOperation(
                    'northstar.app:entity.item',
                  ),
                  idempotencyKey: retryKey,
                  confirmationGrant: null,
                  input: {
                    recordId: item.recordId,
                    expectedRevision: 1,
                    uploadId: retryKey,
                  },
                },
                app.runtime.operationMediation.issueInvocation(view, 'UI'),
              ),
            ),
            { code: 'NO_SUCH_REGISTERED_OPERATION' },
          );

          const first = await upload(itemUrl, pixel, { retryKey });
          assert.equal(first.status, 201, await first.clone().text());
          const attachment = (await first.json()) as DocumentMetadata;
          const persisted = await pool.query<{ upload_id: string }>(
            'SELECT upload_id FROM platform.document_versions WHERE link_id = $1',
            [attachment.linkId],
          );
          assert.notEqual(persisted.rows[0]!.upload_id, retryKey);
          const retry = await upload(itemUrl, pixel, { retryKey });
          assert.deepEqual(await retry.json(), attachment);
          const second = await upload(itemUrl, pixel);
          assert.equal(second.status, 201, await second.clone().text());
          assert.notEqual(
            ((await second.json()) as DocumentMetadata).versionId,
            attachment.versionId,
          );
          assert.equal((await upload(companyUrl, pixel)).status, 201);
          const counts = async () =>
            (
              await pool.query(
                `SELECT (SELECT count(*)::int FROM platform.document_blobs) AS blobs,
                (SELECT count(*)::int FROM platform.document_versions) AS versions,
                (SELECT count(*)::int FROM platform.document_attachment_audit) AS audit`,
              )
            ).rows[0];
          const admitted = await counts();
          assert.equal(
            admitted?.blobs,
            2,
            'identical bytes were pooled across ownership scopes',
          );
          assert.equal(
            admitted?.versions,
            3,
            'an upload retry changed the version count',
          );
          assert.equal(
            admitted?.audit,
            3,
            'published attachments missed their audit rows',
          );

          const preview = await fetch(byteUrl(itemUrl, attachment, 'preview'));
          assert.equal(preview.status, 200);
          assert.match(
            preview.headers.get('content-disposition') ?? '',
            /^inline/u,
          );
          assert.equal(preview.headers.get('content-type'), 'image/png');
          assert.equal(
            preview.headers.get('x-content-type-options'),
            'nosniff',
          );
          assert.deepEqual(Buffer.from(await preview.arrayBuffer()), pixel);
          const download = await fetch(
            byteUrl(itemUrl, attachment, 'download'),
          );
          assert.match(
            download.headers.get('content-disposition') ?? '',
            /^attachment/u,
          );
          await download.arrayBuffer();
          assert.equal(
            (await fetch(byteUrl(companyUrl, attachment, 'download'))).status,
            404,
          );
          assert.equal(
            (
              await upload(
                documentUrl(
                  app.baseUrl,
                  companySurface,
                  transaction.recordId,
                  randomUUID(),
                ),
                pixel,
              )
            ).status,
            404,
          );
          assert.equal(
            (await upload(itemUrl, pixel.subarray(0, 20))).status,
            415,
          );
          assert.equal(
            (await upload(itemUrl, pixel, { contentType: 'image/jpeg' }))
              .status,
            415,
          );
          assert.equal(
            (await upload(itemUrl, Buffer.alloc(20 * 1024 * 1024 + 1))).status,
            413,
          );
          assert.deepEqual(await counts(), { blobs: 2, versions: 3, audit: 3 });

          const { tenantId, environmentId, principalId } = app.runtime.identity;
          const revoked = await pool.query(
            `UPDATE platform.current_policy_permission_grants
            SET revoked_at = clock_timestamp()
          WHERE tenant_id = $1 AND environment_id = $2
            AND permission_id = 'northstar.documents:permission.download'
            AND role_id IN (SELECT role_id FROM platform.current_policy_memberships
              WHERE tenant_id = $1 AND environment_id = $2 AND principal_id = $3)`,
            [tenantId, environmentId, principalId],
          );
          assert.ok(revoked.rowCount);
          assert.equal(
            (await fetch(byteUrl(itemUrl, attachment, 'download'))).status,
            404,
            'a revoked download grant still returned bytes',
          );
          assert.equal(
            (await fetch(byteUrl(itemUrl, attachment, 'preview'))).status,
            404,
          );
          assert.equal((await fetch(listUrl(itemUrl))).status, 200);
          await pool.query(
            `UPDATE platform.current_policy_permission_grants
            SET revoked_at = clock_timestamp()
          WHERE tenant_id = $1 AND environment_id = $2
            AND permission_id = 'northstar.documents:permission.view'
            AND role_id IN (SELECT role_id FROM platform.current_policy_memberships
              WHERE tenant_id = $1 AND environment_id = $2 AND principal_id = $3)`,
            [tenantId, environmentId, principalId],
          );
          assert.equal((await fetch(listUrl(itemUrl))).status, 404);

          await pool.query(
            `INSERT INTO platform.document_blobs (tenant_id, environment_id, owner_scope, digest, content_type, bytes)
         SELECT $1, $2, 'shared', encode(sha256(bytes), 'hex'), 'image/png', bytes
           FROM (SELECT decode(repeat(lpad(to_hex(i), 2, '0'), $3::integer), 'hex') bytes
                   FROM generate_series(1, 5) i) quota`,
            [tenantId, environmentId, DOCUMENT_TENANT_MAX_BYTES / 5],
          );
          const manager = { cookie: 'northstar-demo-actor=manager' };
          const overQuota = await upload(itemUrl, pixel, { headers: manager });
          assert.equal(
            overQuota.status,
            413,
            'the stored-byte quota allowed publication',
          );
          assert.deepEqual(await counts(), { blobs: 7, versions: 3, audit: 3 });

          const other = (
            await ensureScope(pool, 'documents-other', 'production')
          ).runtime;
          await pool.query(
            `INSERT INTO platform.document_blobs (tenant_id, environment_id, owner_scope, digest, content_type, bytes)
             VALUES ($1, $2, 'shared', encode(sha256($3), 'hex'), 'image/png', $3)`,
            [other.tenantId, other.environmentId, pixel],
          );
          const runtimePool = rolePool(
            options.databaseUrl,
            'north_star_runtime',
            1,
          );
          const context = await trustedContext(app.runtime.identity);
          try {
            await withTrustedRequestTransaction(
              runtimePool,
              context,
              async (client) => {
                const hidden = await client.query(
                  'SELECT bytes FROM platform.document_blobs WHERE tenant_id = $1 AND environment_id = $2',
                  [other.tenantId, other.environmentId],
                );
                assert.equal(
                  hidden.rowCount,
                  0,
                  'a different tenant received stored bytes',
                );
              },
            );
            await assert.rejects(
              withTrustedRequestTransaction(runtimePool, context, (client) =>
                client.query(
                  'DELETE FROM platform.document_versions WHERE link_id = $1',
                  [attachment.linkId],
                ),
              ),
              { code: '42501' },
            );
          } finally {
            await runtimePool.end();
          }
        } finally {
          await app.close();
        }
        const scannerless = await startComposedApplication(options);
        try {
          const item = scannerless.seededRecords.find(
            (row) => row.operationId === 'northstar.app:operation.item_create',
          )!;
          assert.equal(
            (
              await upload(
                documentUrl(scannerless.baseUrl, itemSurface, item.recordId),
                pixel,
              )
            ).status,
            503,
          );
        } finally {
          await scannerless.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

test(
  'live Customize adds file fields with category and count contracts to tenant and first-party records',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      'documents-fields',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'documents-fields',
          compiledApplication: applicationWithoutLineCreateValues().release,
          port: 0,
        };
        const app = await startComposedApplication({
          ...options,
          documentDemoScanner: true,
        });
        const customize = await openCustomizeService(options);
        try {
          const { service } = customize;
          const item = app.seededRecords.find(
            (row) => row.operationId === 'northstar.app:operation.item_create',
          )!;
          const entityId = 'northstar.app:entity.custom_equipment';
          const fieldId = 'northstar.app:field.custom_equipment_photos';
          const categoryId = 'northstar.app:category.custom_equipment_evidence';
          const files = (entity: string, field: string) => ({
            kind: 'addDocumentField',
            schemaVersion: 'northstar.document-field/v1',
            entityId: entity,
            fieldId: field,
            label: 'Evidence',
            type: 'files',
            maxCount: 1,
            required: true,
            allowedCategoryIds: [],
          });
          const candidate = await service.draft(
            {
              kind: 'changeSet',
              patches: [
                {
                  kind: 'addRecordType',
                  label: 'Equipment',
                  companyOwnership: 'entityOwned',
                  fields: [{ type: 'text', label: 'Name', required: true }],
                },
                files(
                  'northstar.app:entity.item',
                  'northstar.app:field.custom_item_evidence',
                ),
                {
                  ...files(entityId, fieldId),
                  allowedCategoryIds: [categoryId],
                },
                {
                  kind: 'addUploadCategory',
                  schemaVersion: 'northstar.document-category/v1',
                  entityId,
                  fieldId,
                  categoryId,
                  label: 'Photographs',
                  contentTypes: ['image/png'],
                  maxBytes: 1024,
                  maxCount: 1,
                  required: true,
                  retentionClass: 'northstar.documents:retention.manual',
                  visibility: 'internal',
                  documentExpiryDate: null,
                },
              ],
            },
            'visualBuilder',
          );
          assert.equal(candidate.status, 'drafted', JSON.stringify(candidate));
          assert.match(
            candidate.renderedDiff,
            /Evidence.+Maximum 1.+Required.+Photographs/u,
          );
          await service.approve(candidate.patchId);
          const activate = () => service.activate(candidate.patchId);
          if (process.env.CI) {
            await withArchivedCustomizationRuntime(
              'b2b7877e58074b325c53c7b13f926535e83f39e5',
              async (run) => {
                const read = () =>
                  archivedRuntimeRead(run, {
                    databaseUrl: options.databaseUrl,
                    identity: app.runtime.identity,
                  });
                assert.equal((await read()).outcome, 'loaded');
                await activate();
                assert.deepEqual(await read(), {
                  outcome: 'refused',
                  code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
                  message: `runtime capability northstar.runtime:capability.surface-manifest requires version ${DOCUMENT_FILES_SURFACE_FLOOR} and this runtime supports 26`,
                });
              },
            );
          } else {
            await activate();
          }
          const world = worldOver(app.runtime, String(connection.database));
          const equipment = await world.create('custom_equipment', {
            name: 'Inspection camera',
          });
          const fieldUrl = documentUrl(
            app.baseUrl,
            'northstar.app:surface.custom_equipment_detail',
            equipment.recordId,
            COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId,
          );
          const recordUrl = new URL('/', app.baseUrl);
          recordUrl.searchParams.set(
            'surface',
            'northstar.app:surface.custom_equipment_detail',
          );
          recordUrl.searchParams.set('record', equipment.recordId);
          recordUrl.searchParams.set(
            'northstar.app:parameter.custom_equipment_get_legal_entity_scope',
            COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId,
          );
          const record = await fetch(recordUrl);
          assert.match(
            await record.text(),
            /name="photo" accept="image\/jpeg,image\/png" capture="environment"/u,
          );
          const wrongCategory = await upload(fieldUrl, pixel, {
            fieldId,
            categoryId: 'northstar.app:category.unknown',
          });
          assert.equal(
            wrongCategory.status,
            400,
            await wrongCategory.clone().text(),
          );
          const uploads = await Promise.all([
            upload(fieldUrl, pixel, { fieldId, categoryId }),
            upload(fieldUrl, pixel, { fieldId, categoryId }),
          ]);
          assert.deepEqual(
            uploads.map(({ status }) => status).sort(),
            [201, 409],
          );
          const published = (await uploads
            .find(({ status }) => status === 201)!
            .json()) as DocumentMetadata;
          const firstParty = await upload(
            documentUrl(app.baseUrl, itemSurface, item.recordId),
            pixel,
            {
              fieldId: 'northstar.app:field.custom_item_evidence',
            },
          );
          assert.equal(firstParty.status, 201, await firstParty.clone().text());
          assert.equal((await fetch(listUrl(fieldUrl))).status, 200);
          const itemAttachment = (await firstParty.json()) as DocumentMetadata;
          await service.rollback();
          const itemUrl = documentUrl(app.baseUrl, itemSurface, item.recordId);
          assert.deepEqual(await (await fetch(listUrl(itemUrl))).json(), []);
          assert.equal(
            (await fetch(byteUrl(itemUrl, itemAttachment, 'download'))).status,
            404,
          );
          assert.equal(
            (await fetch(byteUrl(fieldUrl, published, 'download'))).status,
            404,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS count FROM platform.document_versions',
              )
            ).rows[0]?.count,
            2,
          );
        } finally {
          await customize.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

function documentUrl(
  origin: string,
  surface: string,
  record: string,
  company?: string,
): URL {
  const url = new URL('/documents', origin);
  url.searchParams.set('surface', surface);
  url.searchParams.set('record', record);
  if (company) url.searchParams.set('company', company);
  return url;
}

function listUrl(target: URL): URL {
  const url = new URL(target);
  url.searchParams.set('mode', 'list');
  return url;
}

function byteUrl(
  target: URL,
  attachment: DocumentMetadata,
  mode: 'preview' | 'download',
): URL {
  const url = new URL(target);
  url.searchParams.set('mode', mode);
  url.searchParams.set('link', attachment.linkId);
  url.searchParams.set('version', attachment.versionId);
  return url;
}

function upload(
  target: URL,
  bytes: Buffer,
  options: {
    retryKey?: string;
    fieldId?: string;
    categoryId?: string;
    contentType?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const url = new URL(target);
  url.searchParams.set('mode', 'upload');
  url.searchParams.set('retryKey', options.retryKey ?? randomUUID());
  url.searchParams.set('fileName', 'evidence.png');
  if (options.fieldId) url.searchParams.set('field', options.fieldId);
  if (options.categoryId) url.searchParams.set('category', options.categoryId);
  return fetch(url, {
    method: 'POST',
    body: new Uint8Array(bytes),
    headers: {
      origin: url.origin,
      'content-type': options.contentType ?? 'image/png',
      ...options.headers,
    },
  });
}
