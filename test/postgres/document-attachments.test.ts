import { CAPABILITY_EXECUTOR_FACTORIES } from '../../apps/api/src/erp-capabilities.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { applicationBeforeStockCountWorkflow } from '../helpers/application-before-stock-count-workflow.js';
import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  readCompiledApplication,
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  DOCUMENT_DEMO_SCANNER_LABEL,
  DOCUMENT_FILES_SURFACE_FLOOR,
  DOCUMENT_TENANT_MAX_BYTES,
  documentAttachOperation,
} from '../../packages/canonical-model/src/documents.js';
import {
  DocumentRequestError,
  type DocumentMetadata,
} from '../../packages/runtime/src/document-gateway.js';
import {
  rolePool,
  createComposedApplicationRuntime,
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
  async (t) => {
    await withEphemeralPostgres(
      'documents-internal',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'documents-internal',
          port: 0,
        };
        await pool.query(
          "ALTER DATABASE postgres SET north_star.isolated_document_demo = 'on'",
        );
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

          await pool.query(`CREATE SEQUENCE public.observed_document_blob_writes;
            GRANT USAGE ON SEQUENCE public.observed_document_blob_writes TO north_star_runtime;
            CREATE FUNCTION public.count_document_blob_write() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN PERFORM nextval('public.observed_document_blob_writes'); RETURN NULL; END $$;
            CREATE TRIGGER observe_blob_write AFTER INSERT OR UPDATE ON platform.document_blobs
              FOR EACH ROW EXECUTE FUNCTION public.count_document_blob_write()`);
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
          const companyUpload = await upload(companyUrl, pixel);
          assert.equal(companyUpload.status, 201);
          const companyFile = (await companyUpload.json()) as DocumentMetadata;
          await t.test(
            'new and duplicate uploads both write the admitted bytes',
            async () => {
              const writes = await pool.query(
                'SELECT last_value::integer AS writes FROM public.observed_document_blob_writes',
              );
              assert.equal(
                writes.rows[0]?.writes,
                3,
                'each fresh upload writes its complete payload',
              );
            },
          );
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

          await t.test(
            'publication requires scanner evidence before writing a version or audit',
            async () => {
              const db = rolePool(options.databaseUrl, 'north_star_runtime', 1);
              const uploadId = randomUUID();
              try {
                const context = await trustedContext(app.runtime.identity);
                await withTrustedRequestTransaction(db, context, (client) =>
                  client.query(
                    "SELECT platform.stage_document_upload('shared','northstar.app:entity.item',$1,$2,NULL,NULL,'pending.png','image/png',$3)",
                    [item.recordId, uploadId, pixel],
                  ),
                );
                await assert.rejects(
                  withTrustedRequestTransaction(db, context, (client) =>
                    client.query(
                      "SELECT platform.publish_document_upload($1,encode(sha256($2::bytea),'hex'),'fixture/v1',$3,1,NULL,NULL)",
                      [uploadId, pixel, app.runtime.activeReleaseId],
                    ),
                  ),
                  { code: 'D0409' },
                );
                assert.deepEqual(await counts(), admitted);
              } finally {
                await db.end();
              }
            },
          );
          await t.test(
            'file lists return bounded nonoverlapping cursor pages',
            async () => {
              const page = listUrl(itemUrl);
              page.searchParams.set('limit', '1');
              const firstPage = await fetch(page);
              const rows = (await firstPage.json()) as DocumentMetadata[];
              assert.equal(
                rows.length,
                1,
                'list respects the requested page bound',
              );
              const next = firstPage.headers.get('x-next-document-link');
              assert.equal(next, rows[0]!.linkId);
              page.searchParams.set('after', next!);
              const lastPage = await fetch(page);
              const lastRows = (await lastPage.json()) as DocumentMetadata[];
              assert.equal(lastRows.length, 1);
              assert.notEqual(rows[0]!.linkId, lastRows[0]!.linkId);
              assert.equal(lastPage.headers.get('x-next-document-link'), null);
            },
          );
          await t.test(
            'published versions and attachment audit reject every mutation',
            async () => {
              for (const table of [
                'document_versions',
                'document_attachment_audit',
              ]) {
                for (const statement of [
                  `UPDATE platform.${table} SET link_id = link_id WHERE false`,
                  `DELETE FROM platform.${table} WHERE false`,
                  `TRUNCATE platform.${table} CASCADE`,
                ]) {
                  const client = await pool.connect();
                  try {
                    await client.query('BEGIN');
                    await assert.rejects(client.query(statement), {
                      code: '55000',
                    });
                  } finally {
                    await client.query('ROLLBACK');
                    client.release();
                  }
                }
              }
            },
          );
          const { tenantId, environmentId, principalId } = app.runtime.identity;
          const scopedRead = async (
            scope: string,
            entity: string,
            id: string,
            file: DocumentMetadata,
          ) => {
            const db = rolePool(options.databaseUrl, 'north_star_runtime', 1);
            try {
              return await withTrustedRequestTransaction(
                db,
                await trustedContext(app.runtime.identity),
                (client) =>
                  client.query(
                    'SELECT metadata FROM platform.read_document_version($1,$2,$3,$4,$5)',
                    [scope, entity, id, file.linkId, file.versionId],
                  ),
              );
            } finally {
              await db.end();
            }
          };
          await t.test(
            'scoped database reads follow live company membership',
            async () => {
              const read = () =>
                scopedRead(
                  company,
                  'northstar.app:entity.inventory_transaction',
                  transaction.recordId,
                  companyFile,
                );
              assert.equal((await read()).rowCount, 1);
              const restricted = await pool.query<{ membership_id: string }>(
                `UPDATE platform.current_policy_memberships
              SET legal_entity_id=$4 WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3
              AND legal_entity_id IS NULL RETURNING membership_id`,
                [tenantId, environmentId, principalId, randomUUID()],
              );
              try {
                assert.equal((await read()).rowCount, 0);
              } finally {
                await pool.query(
                  'UPDATE platform.current_policy_memberships SET legal_entity_id=NULL WHERE membership_id=ANY($1::uuid[])',
                  [restricted.rows.map((row) => row.membership_id)],
                );
              }
            },
          );
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
          await t.test(
            'revoked download is refused by the database',
            async () => {
              assert.equal(
                (
                  await scopedRead(
                    'shared',
                    'northstar.app:entity.item',
                    item.recordId,
                    attachment,
                  )
                ).rowCount,
                0,
                'the database returned bytes after download revocation',
              );
            },
          );
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

          const manager = { cookie: 'northstar-demo-actor=manager' };
          await pool.query(
            `INSERT INTO platform.document_blobs (tenant_id, environment_id, owner_scope, digest, content_type, bytes)
         SELECT $1, $2, 'shared', encode(sha256(bytes), 'hex'), 'image/png', bytes
           FROM (SELECT decode(repeat(lpad(to_hex(i), 2, '0'), $3::integer), 'hex') bytes
                   FROM generate_series(1, 1) i) quota`,
            [tenantId, environmentId, DOCUMENT_TENANT_MAX_BYTES / 5],
          );
          await pool.query(
            `INSERT INTO platform.document_versions
            SELECT v.tenant_id,v.environment_id,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),v.owner_scope,
              b.digest,v.entity_id,v.record_id,v.record_revision,v.field_id,v.category_id,v.retention_class,
              v.file_name,v.actor_id,v.release_id,v.scan_policy_version,clock_timestamp()
            FROM platform.document_versions v JOIN platform.document_blobs b USING (tenant_id,environment_id,owner_scope)
            CROSS JOIN generate_series(1,5) WHERE v.link_id = $1 AND b.byte_length > 1000`,
            [attachment.linkId],
          );
          await t.test(
            'quota charges each published version of shared bytes',
            async () => {
              const differentPixel = Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGOoAwAAgAB/ZMWU5gAAAABJRU5ErkJggg==',
                'base64',
              );
              assert.equal(differentPixel.length, pixel.length);
              const duplicate = await upload(itemUrl, pixel, {
                headers: manager,
              });
              const fresh = await upload(itemUrl, differentPixel, {
                headers: manager,
              });
              assert.equal(
                duplicate.status,
                413,
                'quota charges every version even when all five reference one blob',
              );
              assert.equal(fresh.status, duplicate.status);
              assert.deepEqual(await fresh.json(), await duplicate.json());
            },
          );
          await pool.query(
            `INSERT INTO platform.document_blobs (tenant_id, environment_id, owner_scope, digest, content_type, bytes)
         SELECT $1, $2, 'shared', encode(sha256(bytes), 'hex'), 'image/png', bytes
           FROM (SELECT decode(repeat(lpad(to_hex(i), 2, '0'), $3::integer), 'hex') bytes
                   FROM generate_series(2, 5) i) quota`,
            [tenantId, environmentId, DOCUMENT_TENANT_MAX_BYTES / 5],
          );
          const overQuota = await upload(itemUrl, pixel, { headers: manager });
          assert.equal(
            overQuota.status,
            413,
            'the stored-byte quota allowed publication',
          );
          await t.test(
            'refusals leave attachment counts unchanged',
            async () => {
              assert.deepEqual(await counts(), {
                blobs: 7,
                versions: 8,
                audit: 3,
              });
            },
          );

          await t.test(
            'runtime has only scoped attachment entries and no scanner authority',
            async () => {
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
                    const access = await client.query<{
                      table_name: string;
                      direct_access: boolean;
                    }>(
                      `SELECT name AS table_name, has_table_privilege(current_user, 'platform.' || name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS direct_access
                     FROM unnest(ARRAY['document_versions','document_blobs','document_attachment_audit','document_upload_staging']) AS name`,
                    );
                    assert.ok(
                      access.rows.every((row) => !row.direct_access),
                      'the serving role has direct attachment table access',
                    );
                    assert.equal(
                      (
                        await client.query(`SELECT has_function_privilege(current_user,
                  'platform.record_document_scan(uuid,uuid,uuid,uuid,text,text,boolean)', 'EXECUTE') AS allowed`)
                      ).rows[0]?.allowed,
                      false,
                    );
                  },
                );
                await assert.rejects(
                  withTrustedRequestTransaction(
                    runtimePool,
                    context,
                    (client) =>
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
            },
          );
        } finally {
          await app.close();
        }
        await t.test(
          'demo scanner refuses an unverified database',
          async () => {
            await assert.rejects(async () => {
              await pool.query(
                'ALTER DATABASE postgres RESET north_star.isolated_document_demo',
              );
              const unverified = await startComposedApplication({
                ...options,
                documentDemoScanner: true,
              });
              await unverified.close();
            }, /verified isolated demo database/u);
          },
        );
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
  'staged attachment verdicts and deadlines govern publication',
  { timeout: 600_000 },
  async (t) => {
    await withEphemeralPostgres(
      'document-screening',
      async ({ pool, connection }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'documents-screening',
          port: 0,
        };
        // A scanner decision is durable across a second request with the same input.
        let clean = false;
        let scans = 0;
        let afterScan: (() => Promise<void>) | undefined;
        const seeded = await startComposedApplication(options);
        const recordId = seeded.seededRecords.find(
          (row) => row.operationId === 'northstar.app:operation.item_create',
        )!.recordId;
        await seeded.close();
        const screening = await createComposedApplicationRuntime({
          databaseUrl: options.databaseUrl,
          tenantSlug: options.tenantSlug,
          localDemoIdentity: true,
          compiledApplication: await readCompiledApplication(),
          migrationsDirectory: 'db/migrations',
          providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
          capabilityOperationExecutorFactories: CAPABILITY_EXECUTOR_FACTORIES,
          inventoryScopeProvisioning: COMPOSED_APPLICATION_INVENTORY_SCOPE,
          documents: {
            scanner: {
              mode: 'real',
              label: 'Fixture scanner',
              policyVersion: 'fixture/v1',
              async scan({ digest }) {
                scans++;
                await afterScan?.();
                return { digest, clean };
              },
            },
          },
        });
        try {
          const retryKey = randomUUID();
          const manager = { cookie: 'northstar-demo-actor=manager' };
          const submit = () =>
            screening.entry.run({ headers: manager }, (view) =>
              screening.documents!.upload(
                view,
                { surfaceId: itemSurface, recordId, companyId: null },
                {
                  retryKey,
                  fieldId: null,
                  categoryId: null,
                  contentType: 'image/png',
                  fileName: 'fixture.png',
                },
                async () => pixel,
                new AbortController().signal,
              ),
            );
          await t.test(
            'rejected digest-bound scans survive retries',
            async () => {
              await assert.rejects(submit(), { status: 422 });
              clean = true;
              await assert.rejects(submit(), { status: 422 });
              assert.equal(scans, 1);
              const evidence =
                await pool.query(`SELECT scan_digest = digest AS bound, scan_policy
            FROM platform.document_upload_staging WHERE scan_clean IS FALSE`);
              assert.deepEqual(evidence.rows, [
                { bound: true, scan_policy: 'fixture/v1' },
              ]);
            },
          );
          clean = true;
          // Pause the publisher at the actual SQL lock. An injected monotonic deadline
          // expires while it waits, before the lock is released.
          await t.test(
            'expiry during the publication lock rolls back the version',
            async () => {
              const locker = await pool.connect();
              const {
                rows: [backend],
              } = await locker.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
              );
              const held = Promise.withResolvers<void>();
              const clock = { remaining: 30000 };
              const deadline = {
                signal: new AbortController().signal,
                remainingMilliseconds() {
                  if (!clock.remaining)
                    throw new DocumentRequestError(
                      408,
                      'The file response expired.',
                    );
                  return clock.remaining;
                },
              };
              let locked = false;
              try {
                afterScan = async () => {
                  await locker.query('BEGIN');
                  locked = true;
                  await locker.query(
                    "SELECT pg_advisory_xact_lock(hashtextextended('documents:' || $1 || ':' || $2,0))",
                    [
                      screening.identity.tenantId,
                      screening.identity.environmentId,
                    ],
                  );
                  held.resolve();
                };
                const before = (
                  await pool.query(
                    'SELECT count(*) FROM platform.document_versions',
                  )
                ).rows[0]!.count;
                const publication = screening.entry.run(
                  { headers: manager },
                  (view) =>
                    screening.documents!.upload(
                      view,
                      { surfaceId: itemSurface, recordId, companyId: null },
                      {
                        retryKey: randomUUID(),
                        fieldId: null,
                        categoryId: null,
                        fileName: 'deadline.png',
                        contentType: 'image/png',
                      },
                      async () => pixel,
                      deadline.signal,
                      deadline,
                    ),
                );
                // Surface an early request failure without waiting for the scanner barrier.
                await Promise.race([
                  held.promise,
                  publication.then(() => {
                    throw new Error('publication skipped scan');
                  }),
                ]);
                const until = performance.now() + 10000;
                while (
                  !(
                    await pool.query(
                      'SELECT FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
                      [backend!.pid],
                    )
                  ).rowCount
                ) {
                  if (performance.now() >= until)
                    throw new Error('publication never reached quota lock');
                  await new Promise((resolve) => setTimeout(resolve, 10));
                }
                clock.remaining = 0;
                await locker.query('ROLLBACK');
                locked = false;
                await assert.rejects(publication, { status: 408 });
                assert.equal(
                  (
                    await pool.query(
                      'SELECT count(*) FROM platform.document_versions',
                    )
                  ).rows[0]!.count,
                  before,
                );
              } finally {
                if (locked) await locker.query('ROLLBACK');
                locker.release();
              }
            },
          );
        } finally {
          await screening.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

test(
  'live Customize adds file fields with category and count contracts to tenant and first-party records',
  { timeout: 600_000 },
  async (t) => {
    await withEphemeralPostgres(
      'documents-fields',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'documents-fields',
          compiledApplication: applicationBeforeStockCountWorkflow().release,
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
          const equipmentDeclaration = {
            kind: 'addRecordType',
            label: 'Equipment',
            companyOwnership: 'entityOwned',
            fields: [{ type: 'text', label: 'Name', required: true }],
          };
          const candidate = await service.draft(
            {
              kind: 'changeSet',
              patches: [
                equipmentDeclaration,
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
          await t.test(
            'a field ID activated on another entity keeps rolled-back files hidden',
            async () => {
              const reused = await service.draft(
                {
                  kind: 'changeSet',
                  patches: [
                    equipmentDeclaration,
                    files(entityId, 'northstar.app:field.custom_item_evidence'),
                  ],
                },
                'visualBuilder',
              );
              assert.equal(reused.status, 'drafted', JSON.stringify(reused));
              await service.approve(reused.patchId);
              await service.activate(reused.patchId);
              assert.deepEqual(
                await (await fetch(listUrl(itemUrl))).json(),
                [],
              );
              assert.equal(
                (await fetch(byteUrl(itemUrl, itemAttachment, 'download')))
                  .status,
                404,
              );
              assert.equal(
                (await fetch(byteUrl(fieldUrl, published, 'download'))).status,
                404,
              );
            },
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
