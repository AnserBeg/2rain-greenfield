import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { canonicalize } from '@north-star/canonical-model';
import { mountDocumentHttp } from '../../apps/web/src/document-http.js';
import type { GeneratedDocumentSource } from '../../packages/postgres-provider/src/document-template-sources.js';
import { documentPdfText } from '../helpers/document-pdf-text.js';
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
  assertArchivedTenantEnvelope,
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
  layout: [{ kind: 'heading', text: heading }] as unknown[],
  pageNumbers: true,
});

test(
  'approved template revisions publish governed PDFs, refuse hidden sources, and retire',
  { timeout: 600_000 },
  async (t) => {
    await withEphemeralPostgres(
      'document-templates',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'document-templates',
          port: 0,
        };
        await pool.query(
          "ALTER DATABASE postgres SET north_star.isolated_document_demo = 'on'",
        );
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
                fields: [
                  { label: 'Name', type: 'text', required: true },
                  { label: 'Service Date', type: 'date', required: true },
                ],
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
          const headerOnly = template(
            tenant,
            'service_header',
            'Service cover',
            tenant + '_get',
            tenant + '_name',
          );
          po.layout.push({
            kind: 'field',
            label: 'Order date',
            fieldId: id('field', 'purchase_order_order_date'),
          });
          serviceSheet.layout.push({
            kind: 'field',
            label: 'Service date',
            fieldId: id('field', tenant + '_service_date'),
          });
          const localBrand = await service.draft(
            { ...po, branding: { displayName: 'Template-local brand' } },
            'visualBuilder',
          );
          assert.notEqual(localBrand.status, 'drafted');
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
          const change = {
            kind: 'changeSet',
            patches: [po, serviceSheet, headerOnly],
          };
          const draft = await service.draft(change, 'visualBuilder');
          assert.equal(draft.status, 'drafted', JSON.stringify(draft));
          assert.match(
            draft.renderedDiff,
            /Service work order[\s\S]*Description/u,
          );
          const world = worldOver(app.runtime, String(connection.database));
          const sheet = await world.create(tenant, {
            name: 'WO-17',
            service_date: '2026-11-18',
          });
          await world.create(
            tenant + '_lines',
            { line_number: '1', description: 'Replace filter' },
            { parent: sheet.recordId },
          );
          const purchaseOrder = await world.create('purchase_order', {
            supplier_party_id: seededId('Cascade Fastener Works'),
            order_date: '2026-11-18T00:00:00.000Z',
            expected_date: null,
            currency: 'CAD',
            notes: null,
          });
          const orderId = purchaseOrder.recordId;
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
              '2042780bcc3889022af36493a2dcaa3a62b8cb56',
              async (run) => {
                await assertArchivedTenantEnvelope(run);
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
                  message: `runtime capability northstar.runtime:capability.surface-manifest requires version ${DOCUMENT_TEMPLATES_SURFACE_FLOOR} and this runtime supports 29`,
                });
              },
            );
          } else {
            await service.activate(draft.patchId);
          }
          await t.test(
            'the compiled application serves real template PDFs through the production launcher',
            {
              skip: !existsSync('dist/apps/api/src/main.js'),
            },
            async () => {
              const child = spawn(
                process.execPath,
                ['scripts/start-production.mjs'],
                {
                  env: {
                    ...process.env,
                    PORT: '0',
                    DATABASE_URL: options.databaseUrl,
                    NORTH_STAR_TENANT_SLUG: options.tenantSlug,
                    NORTH_STAR_DOCUMENT_DEMO_SCANNER: '0',
                    NORTH_STAR_DEV_DATABASE_CONTAINER:
                      'dev-composed-app-postgres-docs-1-production-test',
                  },
                  stdio: ['ignore', 'pipe', 'pipe'],
                },
              );
              const closed = once(child, 'exit');
              let stderr = '';
              child.stderr.setEncoding('utf8').on('data', (text) => {
                stderr += String(text);
              });
              try {
                const started = new Promise<string>((resolve, reject) => {
                  let stdout = '';
                  child.stdout.setEncoding('utf8').on('data', (text) => {
                    stdout += String(text);
                    const ready = /^COMPOSED_APPLICATION_READY (.+)$/mu.exec(
                      stdout,
                    );
                    if (ready)
                      resolve(
                        (JSON.parse(ready[1]!) as { baseUrl: string }).baseUrl,
                      );
                  });
                  child.once('error', reject);
                  child.once('exit', (code) =>
                    reject(
                      new Error(
                        'Production startup exited: ' +
                          String(code) +
                          ' ' +
                          stderr,
                      ),
                    ),
                  );
                });
                const timeout = AbortSignal.timeout(120_000);
                const baseUrl = await Promise.race([
                  started,
                  once(timeout, 'abort').then(() => {
                    throw new Error('Production startup timed out: ' + stderr);
                  }),
                ]);
                const url = new URL(
                  sheetUrl.pathname + sheetUrl.search,
                  baseUrl,
                );
                const rendered = await request(url, 'template-preview');
                assert.equal(
                  rendered.status,
                  200,
                  await rendered.clone().text(),
                );
                assert.equal(
                  rendered.headers.get('content-type'),
                  'application/pdf',
                );
                assert.match(
                  documentPdfText(Buffer.from(await rendered.arrayBuffer())),
                  /Replace filter/u,
                );
              } finally {
                child.kill('SIGTERM');
                await closed;
              }
            },
          );
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
          assert.match(
            firstBytes.toString('latin1'),
            /\(Default legal entity\)/u,
            'issued PDF title should use the company record name',
          );
          assert.match(
            documentPdfText(firstBytes),
            /Replace filter/u,
            'issued PDF lost the saved line text',
          );
          assert.match(
            documentPdfText(firstBytes),
            /Service date: Nov 18, 2026/u,
          );
          assert.deepEqual(await bytes(secondAttachment), firstBytes);
          assert.notDeepEqual(
            Buffer.from(await preview.arrayBuffer()),
            firstBytes,
          );
          const purchaseRetry = randomUUID();
          const purchase = await request(
            poUrl,
            'generate',
            undefined,
            purchaseRetry,
          );
          assert.equal(purchase.status, 201, await purchase.clone().text());
          const purchaseArtifact = (await purchase.json()) as DocumentMetadata;

          const count = await pool.query(`SELECT count(*)::int AS version_count,
             (SELECT count(*)::int FROM platform.document_attachment_audit) AS audit
             FROM platform.document_versions WHERE generated_source IS NOT NULL`);
          assert.deepEqual(count.rows[0], { version_count: 3, audit: 3 });
          const { tenantId, environmentId, principalId } = app.runtime.identity;
          const direct = async <T>(
            run: (client: PoolClient) => Promise<T>,
            role:
              | 'north_star_runtime'
              | 'north_star_document_scanner'
              | null = 'north_star_runtime',
          ) => {
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              await client.query(
                `SELECT set_config('north_star.tenant_id',$1,true),
                   set_config('north_star.environment_id',$2,true), set_config('north_star.principal_id',$3,true)`,
                [tenantId, environmentId, principalId],
              );
              if (role) await client.query('SET LOCAL ROLE ' + role);
              const result = await run(client);
              await client.query('COMMIT');
              return result;
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          };
          const stored = async (file: DocumentMetadata) =>
            (
              await pool.query<{
                generated_source: GeneratedDocumentSource;
                upload_id: string;
                digest: string;
                file_name: string;
                release_id: string;
                record_revision: string;
                bytes: Buffer;
                revision: unknown;
              }>(
                `SELECT v.*, b.bytes, (SELECT value
              FROM jsonb_array_elements(platform.document_app(v.tenant_id,v.environment_id,v.release_id)->'documentTemplateRevisions')
              WHERE value->>'revisionId' = v.generated_source->>'revisionId') AS revision
            FROM platform.document_versions v JOIN platform.document_blobs b USING (tenant_id,environment_id,owner_scope,digest)
            WHERE version_id = $1`,
                [file.versionId],
              )
            ).rows[0]!;
          const issuedPo = await stored(purchaseArtifact);
          const saved = { rows: [issuedPo] };
          const stage = (
            recordId: string,
            uploadId: string,
            file: typeof issuedPo,
            source = file.generated_source,
          ) =>
            direct((client) =>
              client.query(
                `SELECT platform.stage_document_upload($1,$2,$3,$4,NULL,NULL,$5,'application/pdf',$6,$7) AS metadata`,
                [
                  companyId,
                  id('entity', tenant),
                  recordId,
                  uploadId,
                  file.file_name,
                  file.bytes,
                  source,
                ],
              ),
            );
          const scan = (uploadId: string, digest: string) =>
            direct(
              (client) =>
                client.query(
                  'SELECT platform.record_document_scan($1,$2,$3,$4,$5,$6,true)',
                  [
                    tenantId,
                    environmentId,
                    principalId,
                    uploadId,
                    digest,
                    'fixture/v1',
                  ],
                ),
              'north_star_document_scanner',
            );
          const publish = (uploadId: string, file: typeof issuedPo) =>
            direct((client) =>
              client.query(
                'SELECT platform.publish_document_upload($1,$2,$3,$4,$5,NULL,NULL)',
                [
                  uploadId,
                  file.digest,
                  'fixture/v1',
                  file.release_id,
                  file.record_revision,
                ],
              ),
            );
          const directRead = (
            recordId: string,
            file: DocumentMetadata,
            entity = tenant,
          ) =>
            direct((client) =>
              client.query(
                'SELECT * FROM platform.read_document_version($1,$2,$3,$4,$5)',
                [
                  companyId,
                  id('entity', entity),
                  recordId,
                  file.linkId,
                  file.versionId,
                ],
              ),
            );
          const revokeGrant = (permissionId: string) =>
            pool.query(
              `UPDATE platform.current_policy_permission_grants SET revoked_at = clock_timestamp()
            WHERE tenant_id = $1 AND environment_id = $2 AND permission_id = $4
              AND role_id IN (SELECT role_id FROM platform.current_policy_memberships
              WHERE tenant_id = $1 AND environment_id = $2 AND principal_id = $3)`,
              [tenantId, environmentId, principalId, permissionId],
            );
          const companyDraft = issuedPo.generated_source;
          const expectedDate = 'Nov 18, 2026';
          const record = new URL('/', app.baseUrl);
          record.searchParams.set(
            'surface',
            id('surface', 'purchase_order_detail'),
          );
          record.searchParams.set('record', orderId);
          record.searchParams.set(
            id('parameter', 'purchase_order_get_legal_entity_scope'),
            companyId,
          );
          assert.ok(
            (await (await fetch(record)).text()).includes(expectedDate),
            'Record did not display the expected business day',
          );
          assert.ok(
            documentPdfText(issuedPo.bytes).includes(
              'Order date: ' + expectedDate,
            ),
            'PDF did not preserve the Record business day',
          );
          const expectedInput = {
            revision: issuedPo.revision,
            brandRevision: companyDraft.brandRevision,
            companyBrandSource: companyDraft.companyBrandSource,
            input: {
              name: 'Default legal entity',
              identity: companyDraft.issuedIdentity,
              paper: 'LETTER',
              pageNumbers: true,
              ink: '#17191C',
              accent: '#0E6670',
              logoDataUri: null,
              blocks: [
                ...po.layout.slice(0, 1),
                { kind: 'text', text: 'Order date: ' + expectedDate },
              ],
            },
            recordId: orderId,
            queries: companyDraft.queries,
            logo: null,
          };
          assert.equal(
            companyDraft.inputDigest,
            createHash('sha256')
              .update(canonicalize(expectedInput))
              .digest('hex'),
            'persisted input digest did not cover the actual render input and authorities',
          );
          assert.equal(
            saved.rows[0]?.generated_source.templateId,
            po.templateId,
          );
          assert.match(
            saved.rows[0]?.generated_source.inputDigest,
            /^[0-9a-f]{64}$/u,
          );
          assert.equal(
            saved.rows[0]?.generated_source.revisionId,
            po.revisionId,
          );
          assert.equal(
            saved.rows[0]?.generated_source.brandRevision,
            'platform-default',
          );
          assert.match(saved.rows[0]?.generated_source.issuedIdentity, /^PO-/u);

          await t.test(
            'the SQL source gate rejects a selected hidden field on the same entity',
            async () => {
              const sheetIssue = await stored(attachment);
              const header = sheetIssue.generated_source.queries[0]!;
              const sourceField = header.fields[0]!;
              const result = await direct(
                (client) =>
                  client.query<{ classification: string; admitted: boolean }>(
                    `
              WITH definition AS (SELECT platform.document_app($1,$2) AS app),
              trials(classification) AS (VALUES ('internal'::text), ('confidential'::text))
              SELECT classification, platform.document_source_allowed(
                jsonb_set(app, '{fields}', (SELECT jsonb_agg(CASE WHEN value->>'fieldId' = $3
                  THEN jsonb_set(value, '{classification}', to_jsonb(classification)) ELSE value END)
                  FROM jsonb_array_elements(app->'fields'))), app, platform.document_storage($1,$2),
                jsonb_set($4::jsonb, '{fields,0,classification}', to_jsonb(classification)),
                $5, $6, $7, false) AS admitted
              FROM definition, trials ORDER BY classification`,
                    [
                      tenantId,
                      environmentId,
                      sourceField.fieldId,
                      header,
                      companyId,
                      id('entity', tenant),
                      sheet.recordId,
                    ],
                  ),
                null,
              );
              assert.deepEqual(result.rows, [
                { classification: 'confidential', admitted: false },
                { classification: 'internal', admitted: true },
              ]);
            },
          );

          await t.test(
            'publication refuses when new children arrive after staging even from an empty table',
            async () => {
              const empty = await world.create(tenant, {
                name: 'WO-EMPTY',
                service_date: '2026-11-18',
              });
              const emptyIssue = await request(
                endpoint(
                  tenant,
                  empty.recordId,
                  serviceSheet.templateId,
                  companyId,
                ),
                'generate',
              );
              assert.equal(
                emptyIssue.status,
                201,
                await emptyIssue.clone().text(),
              );
              for (const [recordId, issued, size] of [
                [sheet.recordId, attachment, 1],
                [
                  empty.recordId,
                  (await emptyIssue.json()) as DocumentMetadata,
                  0,
                ],
              ] as const) {
                const file = await stored(issued);
                assert.equal(
                  file.generated_source.queries[1]!.rows.length,
                  size,
                );
                const uploadId = randomUUID();
                await stage(recordId, uploadId, file);
                await scan(uploadId, file.digest);
                await world.create(
                  tenant + '_lines',
                  {
                    line_number: String(size + 1),
                    description: 'New service step',
                  },
                  { parent: recordId },
                );
                await assert.rejects(publish(uploadId, file), {
                  code: 'D0404',
                  message: 'Unavailable PDF source',
                });
                assert.equal(
                  (
                    await pool.query(
                      'SELECT 1 FROM platform.document_versions WHERE upload_id = $1',
                      [uploadId],
                    )
                  ).rowCount,
                  0,
                );
              }
            },
          );

          await t.test(
            'blocked source reads obey SQL deadlines and disconnects free HTTP transfer slots',
            async () => {
              const locker = await pool.connect();
              const table = (
                await pool.query<{ table: string }>(
                  `
              SELECT quote_ident(value->>'physicalTableName') AS table
              FROM jsonb_array_elements(platform.document_storage($1,$2)->'entities')
              WHERE value->>'entityId' = $3`,
                  [tenantId, environmentId, id('entity', tenant + '_lines')],
                )
              ).rows[0]!.table;
              const handler = mountDocumentHttp(
                app.runtime.entry,
                app.runtime.documents!,
              );
              const server = createServer(
                (req, res) =>
                  void handler(
                    req,
                    res,
                    new URL(req.url!, 'http://localhost'),
                    true,
                  ),
              );
              await new Promise<void>((resolve) =>
                server.listen(0, '127.0.0.1', resolve),
              );
              const port = (server.address() as AddressInfo).port;
              const localURL = (url: URL, mode: string) => {
                const result = new URL(
                  url.pathname + url.search,
                  'http://127.0.0.1:' + port,
                );
                result.searchParams.set('mode', mode);
                return result;
              };
              const waitFor = async (
                predicate: () => Promise<boolean>,
                message: string,
              ) => {
                const expires = performance.now() + 5_000;
                while (!(await predicate())) {
                  assert.ok(performance.now() < expires, message);
                  await delay(20);
                }
              };
              const controllers = [
                new AbortController(),
                new AbortController(),
              ];
              try {
                await locker.query('BEGIN');
                const lockerPid = (
                  await locker.query<{ pid: number }>(
                    'SELECT pg_backend_pid() AS pid',
                  )
                ).rows[0]!.pid;
                const countBlocked = () =>
                  pool
                    .query<{ count: string }>(
                      "SELECT count(*) FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%north_star_module%'",
                      [lockerPid],
                    )
                    .then(({ rows }) => Number(rows[0]!.count));
                await locker.query(
                  'LOCK north_star_module.' +
                    table +
                    ' IN ACCESS EXCLUSIVE MODE',
                );
                const directSignal = new AbortController();
                const timed = app.runtime.entry.run({}, (view) =>
                  app.runtime.documents!.previewTemplate!(
                    view,
                    {
                      surfaceId: id('surface', tenant + '_detail'),
                      recordId: sheet.recordId,
                      companyId,
                    },
                    serviceSheet.templateId,
                    directSignal.signal,
                    {
                      signal: directSignal.signal,
                      remainingMilliseconds: () => 600,
                    },
                  ),
                );
                const refused = assert.rejects(timed, { status: 408 });
                await waitFor(
                  async () => (await countBlocked()) === 1,
                  'the source query did not block in PostgreSQL',
                );
                await Promise.race([
                  refused,
                  delay(4_000).then(() => {
                    throw new Error('The SQL snapshot outlived its deadline');
                  }),
                ]);
                assert.equal(await countBlocked(), 0);
                const previews = controllers.map(({ signal }) =>
                  fetch(localURL(sheetUrl, 'template-preview'), {
                    signal,
                  }).catch((error: unknown) => error),
                );
                await waitFor(
                  async () => (await countBlocked()) === 2,
                  'both transfer slots must hold blocked reads',
                );
                const download = localURL(poUrl, 'download');
                download.searchParams.set('link', purchaseArtifact.linkId);
                download.searchParams.set(
                  'version',
                  purchaseArtifact.versionId,
                );
                assert.equal((await fetch(download)).status, 429);
                for (const controller of controllers) controller.abort();
                await Promise.all(previews);
                await waitFor(
                  async () => (await countBlocked()) === 0,
                  'aborted source queries retained their PostgreSQL locks',
                );
                await waitFor(async () => {
                  const response = await fetch(download);
                  await response.arrayBuffer();
                  return response.status === 200;
                }, 'source query cancellation did not free an HTTP transfer slot');
              } finally {
                for (const controller of controllers) controller.abort();
                await locker.query('ROLLBACK');
                locker.release();
                server.closeAllConnections();
                await new Promise<void>((resolve) =>
                  server.close(() => resolve()),
                );
              }
            },
          );
          const headerUrl = endpoint(
            tenant,
            sheet.recordId,
            headerOnly.templateId,
            companyId,
          );
          const cover = await request(headerUrl, 'generate');
          assert.equal(cover.status, 201, await cover.clone().text());
          const coverFile = await stored(
            (await cover.json()) as DocumentMetadata,
          );

          await live({
            kind: 'retireDocumentTemplate',
            schemaVersion: 'northstar.document-template-retire/v1',
            templateId: po.templateId,
            previousRevisionId: po.revisionId,
          });
          assert.equal((await request(poUrl, 'generate')).status, 404);
          const retiredReplay = await request(
            poUrl,
            'generate',
            undefined,
            purchaseRetry,
          );
          assert.equal(
            retiredReplay.status,
            201,
            await retiredReplay.clone().text(),
          );
          assert.deepEqual(await retiredReplay.json(), purchaseArtifact);
          assert.equal(
            (await request(poUrl, 'download', purchaseArtifact)).status,
            200,
          );

          const revoke = await revokeGrant(
            id('permission', tenant + '_lines_read'),
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

          await t.test(
            'staging replay checks the stored source after a source grant is revoked',
            async () => {
              const original = await stored(attachment);
              const active = (
                await pool.query<{ release_id: string; content_hash: string }>(
                  `
                SELECT ptr.release_id,r.content_hash FROM platform.active_release_pointers ptr
                JOIN platform.tenant_releases r USING (tenant_id,environment_id,release_id)
                WHERE (ptr.tenant_id,ptr.environment_id)=($1,$2)`,
                  [tenantId, environmentId],
                )
              ).rows[0]!;
              const replacement = {
                ...coverFile.generated_source,
                releaseRoot: active.content_hash,
                inputDigest: original.generated_source.inputDigest,
              };
              const forged = await direct(
                (client) =>
                  client.query<{ allowed: boolean }>(
                    'SELECT platform.document_generated_allowed($1,$2,$3,$4,$5,true) AS allowed',
                    [
                      replacement,
                      active.release_id,
                      companyId,
                      id('entity', tenant),
                      sheet.recordId,
                    ],
                  ),
                null,
              );
              assert.equal(
                forged.rows[0]?.allowed,
                true,
                'the retry description must pass its own source check',
              );
              assert.equal(
                (await directRead(sheet.recordId, attachment)).rowCount,
                0,
              );
              await assert.rejects(
                stage(
                  sheet.recordId,
                  original.upload_id,
                  original,
                  replacement,
                ),
                { code: 'D0404' },
              );
            },
          );

          await t.test(
            'SQL attachment reads require the commercial Record child-query grant',
            async () => {
              assert.equal(
                (await directRead(orderId, purchaseArtifact, 'purchase_order'))
                  .rowCount,
                1,
              );
              assert.ok(
                (
                  await revokeGrant(
                    id('permission', 'purchase_order_line_read'),
                  )
                ).rowCount,
              );
              assert.equal(
                (await directRead(orderId, purchaseArtifact, 'purchase_order'))
                  .rowCount,
                0,
              );
            },
          );
          // Restore this unrelated commercial grant before isolating company brand authority.
          await pool.query(
            `UPDATE platform.current_policy_permission_grants SET revoked_at = NULL
            WHERE tenant_id = $1 AND environment_id = $2 AND permission_id = $3`,
            [
              tenantId,
              environmentId,
              id('permission', 'purchase_order_line_read'),
            ],
          );

          const revokeCompany = await pool.query(
            `UPDATE platform.current_policy_permission_grants SET revoked_at = clock_timestamp()
              WHERE tenant_id = $1 AND environment_id = $2 AND permission_id = $4
                AND role_id IN (SELECT role_id FROM platform.current_policy_memberships
                  WHERE tenant_id = $1 AND environment_id = $2 AND principal_id = $3)`,
            [
              tenantId,
              environmentId,
              principalId,
              id('permission', 'legal_entity_read'),
            ],
          );
          assert.ok(revokeCompany.rowCount);
          assert.equal(
            (await request(poUrl, 'download', purchaseArtifact)).status,
            404,
            'a revoked company source still returned a generated PDF',
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
