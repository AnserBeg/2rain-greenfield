import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import {
  DOCUMENT_BLOB_MAX_BYTES,
  DOCUMENT_PERMISSIONS,
  DOCUMENT_STAGING_MAX_BYTES,
  DOCUMENT_TENANT_MAX_BYTES,
  documentAttachPermission,
} from '../../canonical-model/src/documents.js';
import { DocumentsProjectionSchema } from '../../canonical-model/src/schemas.js';
import {
  DocumentRequestError,
  type DocumentGateway,
  type DocumentMetadata,
  type DocumentTarget,
  type DocumentUpload,
} from '../../runtime/src/document-gateway.js';
import {
  authorizeCurrentPolicy,
  trustedContextForRequestRuntimeView,
  type RequestRuntimeView,
} from '../../runtime/src/request-runtime-view.js';
import {
  registeredQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticQueryGateway,
} from '../../runtime/src/semantic-query-gateway.js';
import {
  currentPolicyVersionOf,
  withRecordCompanyPolicyClient,
  type CurrentPolicyPermissionBinding,
  type PostgresCurrentPolicyGateway,
} from './current-policy.js';
import {
  documentDigest,
  validateDocumentContent,
  type DocumentScanner,
} from './document-content.js';
import { withModuleRuntimeRole } from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
type Entity = StorageTargetPayloadV1['entities'][number];
type DocumentRelease = {
  readonly policy: PostgresCurrentPolicyGateway;
  readonly storage: StorageTargetPayloadV1 | null;
};

const metadataColumns = `v.link_id AS "linkId", v.version_id AS "versionId",
  v.field_id AS "fieldId", v.category_id AS "categoryId", v.file_name AS "fileName",
  b.content_type AS "contentType", b.byte_length AS "byteLength"`;

interface GoverningRecord {
  readonly entity: Entity;
  readonly recordId: string;
  readonly revision: number;
  readonly scope: string;
}

export function documentPermissionBindings(
  entities: readonly { readonly entityId: string }[],
): CurrentPolicyPermissionBinding[] {
  return [
    ...Object.entries(DOCUMENT_PERMISSIONS).map(([action, permissionId]) => ({
      action,
      permissionId,
      resourceId: 'northstar.documents:resource.attachments',
    })),
    ...entities.map(({ entityId }) => ({
      action: 'attach',
      permissionId: documentAttachPermission(entityId),
      resourceId: entityId,
    })),
  ];
}

export class PostgresDocumentGateway implements DocumentGateway {
  constructor(
    private readonly pool: Pool,
    private readonly queryGateway: SemanticQueryGateway,
    private readonly release: (
      id: string,
    ) => DocumentRelease | Promise<DocumentRelease>,
    private readonly scanner: DocumentScanner | undefined,
  ) {}

  get scannerLabel() {
    return this.scanner?.label ?? null;
  }

  async list(
    view: RequestRuntimeView,
    target: DocumentTarget,
  ): Promise<readonly DocumentMetadata[]> {
    const projection = documentDefinition(view);
    const fields = projection?.fields.map(({ fieldId }) => fieldId) ?? [];
    return this.withRecord(
      view,
      target,
      [DOCUMENT_PERMISSIONS.view],
      async (client, record) => {
        const result = await client.query<DocumentMetadata>(
          `SELECT ${metadataColumns}
           FROM platform.document_versions v
           JOIN platform.document_blobs b USING (tenant_id, environment_id, owner_scope, digest)
          WHERE v.tenant_id = $1 AND v.environment_id = $2 AND v.entity_id = $3
            AND v.record_id = $4 AND v.owner_scope = $5
            AND (v.field_id IS NULL OR v.field_id = ANY($6::text[]))
          ORDER BY v.created_at, v.link_id`,
          [...targetKey(view, record), fields],
        );
        return result.rows;
      },
    );
  }

  async read(
    view: RequestRuntimeView,
    target: DocumentTarget,
    linkId: string,
    versionId: string,
    deliver: (metadata: DocumentMetadata, bytes: Buffer) => void,
  ): Promise<void> {
    if (!uuid.test(linkId) || !uuid.test(versionId)) throw notFound();
    const fields =
      documentDefinition(view)?.fields.map(({ fieldId }) => fieldId) ?? [];
    await this.withRecord(
      view,
      target,
      [DOCUMENT_PERMISSIONS.view, DOCUMENT_PERMISSIONS.download],
      async (client, record) => {
        const result = await client.query<DocumentMetadata & { bytes: Buffer }>(
          `SELECT ${metadataColumns}, b.bytes
           FROM platform.document_versions v
           JOIN platform.document_blobs b USING (tenant_id, environment_id, owner_scope, digest)
          WHERE v.tenant_id = $1 AND v.environment_id = $2 AND v.entity_id = $3
            AND v.record_id = $4 AND v.owner_scope = $5
            AND v.link_id = $6 AND v.version_id = $7
            AND (v.field_id IS NULL OR v.field_id = ANY($8::text[]))`,
          [...targetKey(view, record), linkId, versionId, fields],
        );
        const row = result.rows[0];
        if (!row) throw notFound();
        const { bytes, ...metadata } = row;
        deliver(metadata, bytes);
      },
    );
  }

  async upload(
    view: RequestRuntimeView,
    target: DocumentTarget,
    upload: DocumentUpload,
    receive: (maximumBytes: number) => Promise<Buffer>,
    signal: AbortSignal,
  ): Promise<DocumentMetadata> {
    if (!this.scanner)
      throw new DocumentRequestError(
        503,
        'File uploads are unavailable until a malware scanner is configured.',
      );
    const scanner = this.scanner;
    if (!uuid.test(upload.uploadId))
      throw new DocumentRequestError(400, 'Invalid upload ID.');
    const fileName = upload.fileName.trim().replace(/[\\/\p{Cc}\p{Cf}]/gu, '_');
    if (!fileName || fileName.length > 180)
      throw new DocumentRequestError(
        400,
        'Use a filename with 1 to 180 characters.',
      );
    const projection = documentDefinition(view);
    const field = projection?.fields.find(
      (entry) => entry.fieldId === upload.fieldId,
    );
    const category = projection?.categories.find(
      (entry) => entry.categoryId === upload.categoryId,
    );
    const permissions = [
      DOCUMENT_PERMISSIONS.view,
      DOCUMENT_PERMISSIONS.upload,
    ];
    const checkField = (record: GoverningRecord) => {
      if (
        (upload.fieldId && field?.entityId !== record.entity.entityId) ||
        (upload.categoryId &&
          (!category || category.fieldId !== field?.fieldId)) ||
        (field?.allowedCategoryIds.length &&
          (!category ||
            !field.allowedCategoryIds.includes(category.categoryId)))
      )
        throw new DocumentRequestError(
          400,
          'Choose an allowed category for this file field.',
        );
    };
    const targetRecord = await this.withRecord(
      view,
      target,
      permissions,
      async (client, record) => {
        checkField(record);
        await this.authorizeAttach(client, view, record);
        return record;
      },
    );
    const maximumBytes = category?.maxBytes ?? DOCUMENT_BLOB_MAX_BYTES;
    const bytes = await receive(maximumBytes);
    signal.throwIfAborted();
    if (bytes.length > maximumBytes)
      throw new DocumentRequestError(
        413,
        'The file exceeds this upload limit.',
      );
    const contentType = await validateDocumentContent(
      bytes,
      upload.contentType,
    );
    if (category && !category.contentTypes.some((type) => type === contentType))
      throw new DocumentRequestError(
        415,
        'This category does not accept that file type.',
      );
    const digest = documentDigest(bytes);
    const receipt = await this.withRecord(
      view,
      target,
      permissions,
      async (client, record) => {
        checkSameRecord(targetRecord, record);
        await this.authorizeAttach(client, view, record);
        signal.throwIfAborted();
        await lockDocumentQuota(client, view);
        const existing = await readUploadReceipt(client, view, upload.uploadId);
        if (existing) {
          if (!matchesUpload(existing, view, record, upload, digest, fileName))
            throw new DocumentRequestError(
              409,
              'This upload ID already has different input.',
            );
          return existing.metadata;
        }
        await client.query(
          `DELETE FROM platform.document_upload_staging
          WHERE tenant_id = $1 AND environment_id = $2 AND expires_at <= clock_timestamp()`,
          [view.tenantId, view.environmentId],
        );
        const staged = await client.query<{
          principal_id: string;
          owner_scope: string;
          entity_id: string;
          record_id: string;
          field_id: string | null;
          category_id: string | null;
          digest: string;
          file_name: string;
        }>(
          `SELECT principal_id, owner_scope, entity_id, record_id, field_id, category_id, digest, file_name
           FROM platform.document_upload_staging
          WHERE tenant_id = $1 AND environment_id = $2 AND upload_id = $3`,
          [view.tenantId, view.environmentId, upload.uploadId],
        );
        if (staged.rows[0]) {
          if (
            !matchesUpload(
              staged.rows[0],
              view,
              record,
              upload,
              digest,
              fileName,
            )
          )
            throw new DocumentRequestError(
              409,
              'This upload ID already has different input.',
            );
          return null;
        }
        const stagingUsage = await scopeBytes(
          client,
          view,
          'document_upload_staging',
        );
        if (stagingUsage + bytes.length > DOCUMENT_STAGING_MAX_BYTES)
          throw new DocumentRequestError(
            413,
            'The upload staging quota is full.',
          );
        await client.query(
          `INSERT INTO platform.document_upload_staging
          (tenant_id, environment_id, upload_id, principal_id, owner_scope, entity_id, record_id,
           field_id, category_id, file_name, content_type, digest, bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            view.tenantId,
            view.environmentId,
            upload.uploadId,
            view.principalId,
            record.scope,
            record.entity.entityId,
            record.recordId,
            upload.fieldId,
            upload.categoryId,
            fileName,
            contentType,
            digest,
            bytes,
          ],
        );
        return null;
      },
    );
    if (receipt) return receipt;
    const verdict = await scanner.scan({
      bytes: Uint8Array.from(bytes),
      digest,
      contentType,
      signal,
    });
    signal.throwIfAborted();
    if (!verdict.clean || verdict.digest !== digest)
      throw new DocumentRequestError(
        422,
        'The file did not pass content screening.',
      );

    return this.withRecord(
      view,
      target,
      permissions,
      async (client, record) => {
        checkSameRecord(targetRecord, record);
        await this.authorizeAttach(client, view, record);
        signal.throwIfAborted();
        await lockDocumentQuota(client, view);
        const existing = await readUploadReceipt(client, view, upload.uploadId);
        if (existing) {
          if (!matchesUpload(existing, view, record, upload, digest, fileName))
            throw new DocumentRequestError(
              409,
              'This upload ID already has different input.',
            );
          return existing.metadata;
        }
        // Apply the same quota refusal to new and matching bytes before touching
        // the blob's digest key, even if this publication would add no bytes.
        if (
          (await scopeBytes(client, view, 'document_blobs')) + bytes.length >
          DOCUMENT_TENANT_MAX_BYTES
        )
          throw new DocumentRequestError(413, 'The stored file quota is full.');
        if (field) {
          const count = await client.query<{
            total: number;
            categorized: number;
          }>(
            `SELECT count(*)::int AS total, count(*) FILTER (WHERE category_id = $7)::int AS categorized
             FROM platform.document_versions
            WHERE tenant_id = $1 AND environment_id = $2 AND entity_id = $3
              AND record_id = $4 AND owner_scope = $5 AND field_id = $6`,
            [...targetKey(view, record), upload.fieldId, upload.categoryId],
          );
          if (
            count.rows[0]!.total >= field.maxCount ||
            (category && count.rows[0]!.categorized >= category.maxCount)
          )
            throw new DocumentRequestError(
              409,
              'This file field or category is full.',
            );
        }
        const staged = await client.query(
          `SELECT 1 FROM platform.document_upload_staging
          WHERE tenant_id = $1 AND environment_id = $2 AND upload_id = $3
            AND principal_id = $4 AND digest = $5 AND expires_at > clock_timestamp()`,
          [
            view.tenantId,
            view.environmentId,
            upload.uploadId,
            view.principalId,
            digest,
          ],
        );
        if (!staged.rowCount)
          throw new DocumentRequestError(409, 'This staged upload expired.');
        await client.query(
          `INSERT INTO platform.document_blobs
            (tenant_id, environment_id, owner_scope, digest, content_type, bytes)
         SELECT tenant_id, environment_id, owner_scope, digest, content_type, bytes
           FROM platform.document_upload_staging
          WHERE tenant_id = $1 AND environment_id = $2 AND upload_id = $3
         ON CONFLICT (tenant_id, environment_id, owner_scope, digest) DO NOTHING`,
          [view.tenantId, view.environmentId, upload.uploadId],
        );
        const linkId = randomUUID();
        const versionId = randomUUID();
        await client.query(
          `INSERT INTO platform.document_versions
          (tenant_id, environment_id, link_id, version_id, upload_id, owner_scope, digest, entity_id,
           record_id, record_revision, field_id, category_id, retention_class, file_name, actor_id,
           release_id, scan_policy_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            view.tenantId,
            view.environmentId,
            linkId,
            versionId,
            upload.uploadId,
            record.scope,
            digest,
            record.entity.entityId,
            record.recordId,
            record.revision,
            upload.fieldId,
            upload.categoryId,
            category?.retentionClass ?? null,
            fileName,
            view.principalId,
            view.release.releaseId,
            scanner.policyVersion,
          ],
        );
        await client.query(
          `INSERT INTO platform.document_attachment_audit (tenant_id, environment_id, link_id, operation_id)
         VALUES ($1,$2,$3,$4)`,
          [
            view.tenantId,
            view.environmentId,
            linkId,
            documentAttachPermission(record.entity.entityId),
          ],
        );
        await client.query(
          'DELETE FROM platform.document_upload_staging WHERE tenant_id = $1 AND environment_id = $2 AND upload_id = $3',
          [view.tenantId, view.environmentId, upload.uploadId],
        );
        return {
          linkId,
          versionId,
          fieldId: upload.fieldId,
          categoryId: upload.categoryId,
          fileName,
          contentType,
          byteLength: bytes.length,
        };
      },
    );
  }

  private async authorizeAttach(
    client: PoolClient,
    view: RequestRuntimeView,
    record: GoverningRecord,
  ) {
    const { policy } = await this.release(view.release.releaseId);
    await this.authorize(client, policy, view, record.scope, [
      documentAttachPermission(record.entity.entityId),
    ]);
  }

  private async authorize(
    client: PoolClient,
    policy: PostgresCurrentPolicyGateway,
    view: RequestRuntimeView,
    scope: string,
    permissions: readonly string[],
  ) {
    const context = trustedContextForRequestRuntimeView(view);
    for (const permission of permissions) {
      const decision = await withRecordCompanyPolicyClient(
        this.pool,
        client,
        context,
        () =>
          authorizeCurrentPolicy(
            policy,
            view,
            permission,
            scope === 'shared' ? {} : { legalEntityId: scope },
          ),
      );
      if (
        decision.decision !== 'ALLOW' ||
        decision.policyVersion !== view.entryPolicyVersion
      )
        throw notFound();
    }
  }

  private async withRecord<T>(
    view: RequestRuntimeView,
    target: DocumentTarget,
    permissions: readonly string[],
    work: (client: PoolClient, record: GoverningRecord) => Promise<T>,
  ): Promise<T> {
    const context = trustedContextForRequestRuntimeView(view);
    const { storage, policy } = await this.release(view.release.releaseId);
    const surfacePayload = view.projections.surface.payload;
    if (
      !storage ||
      !isObject(surfacePayload) ||
      !Array.isArray(surfacePayload.surfaces) ||
      !uuid.test(target.recordId) ||
      (target.companyId && !uuid.test(target.companyId))
    )
      throw notFound();
    const surface = surfacePayload.surfaces.find(
      (entry: unknown) =>
        isObject(entry) &&
        entry.surfaceId === target.surfaceId &&
        entry.surfaceRole === 'record' &&
        entry.lifecycle === 'active',
    );
    if (!isObject(surface) || typeof surface.dataSourceQueryId !== 'string')
      throw notFound();
    const query = registeredQueryFromPinnedView(
      view,
      surface.dataSourceQueryId,
    );
    if (
      !query ||
      query.lifecycle !== 'active' ||
      query.queryType !== 'get' ||
      query.tier !== 'q0' ||
      query.readModel
    )
      throw notFound();
    const entity = storage.entities.find(
      (entry) => entry.entityId === query.sourceEntityId,
    );
    if (
      !entity ||
      entity.lifecycle !== 'active' ||
      Boolean(entity.legalEntity) !== Boolean(target.companyId)
    )
      throw notFound();
    const canonicalBinding = documentDefinition(view)?.bindings.find(
      (entry) => entry.entityId === entity.entityId,
    );
    if (
      canonicalBinding &&
      (canonicalBinding.queryId !== query.queryId ||
        !canonicalBinding.surfaceIds.some((id) => id === target.surfaceId))
    )
      throw notFound();
    if (!canonicalBinding) {
      const primary = surfacePayload.surfaces
        .flatMap((entry: unknown) => {
          if (
            !isObject(entry) ||
            entry.lifecycle !== 'active' ||
            entry.surfaceRole !== 'record' ||
            typeof entry.dataSourceQueryId !== 'string'
          )
            return [];
          const candidate = registeredQueryFromPinnedView(
            view,
            entry.dataSourceQueryId,
          );
          return candidate?.sourceEntityId === entity.entityId &&
            candidate.queryType === 'get' &&
            candidate.lifecycle === 'active' &&
            candidate.tier === 'q0' &&
            !candidate.readModel
            ? [candidate.queryId]
            : [];
        })
        .sort()[0];
      if (primary !== query.queryId) throw notFound();
    }
    const scopeParam = query.legalEntityScope?.operand.parameterId;
    if (Boolean(scopeParam) !== Boolean(target.companyId)) throw notFound();
    const readBack = await this.queryGateway
      .invoke(view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: query.queryId,
        arguments: {
          recordId: target.recordId,
          ...(scopeParam && target.companyId
            ? {
                [scopeParam]:
                  query.legalEntityScope?.cardinality === 'exactlyOne'
                    ? target.companyId
                    : [target.companyId],
              }
            : {}),
        },
      })
      .catch(() => {
        throw notFound();
      });
    const result = readBack.records[0];
    if (
      readBack.outcome !== 'exact' ||
      !result ||
      result.archived ||
      result.recordId !== target.recordId
    )
      throw notFound();

    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      await client.query("SET LOCAL statement_timeout = '20s'");
      const active = await client.query(
        `SELECT 1 FROM platform.active_release_pointers
          WHERE tenant_id = $1 AND environment_id = $2 AND pointer_id = $3
            AND release_id = $4 AND fence = $5 FOR SHARE`,
        [
          view.tenantId,
          view.environmentId,
          view.pointer.pointerId,
          view.release.releaseId,
          view.pointer.fence,
        ],
      );
      if (!active.rowCount) throw notFound();
      const epoch = await client.query<{ policy_version: string }>(
        'SELECT platform.lock_current_policy_epoch($1, $2) AS policy_version',
        [view.tenantId, view.environmentId],
      );
      if (
        currentPolicyVersionOf(epoch.rows[0]?.policy_version) !==
        view.entryPolicyVersion
      )
        throw notFound();
      const stored = await withModuleRuntimeRole(client, async () =>
        client.query<{ revision: string; company_id: string | null }>(
          `SELECT ${identifier(entity.optimisticRevision.column)}::text AS revision,
                   ${entity.legalEntity ? identifier(entity.legalEntity.column) : 'NULL::uuid'} AS company_id
              FROM north_star_module.${identifier(entity.physicalTableName)}
             WHERE tenant_id = $1 AND environment_id = $2
               AND ${identifier(entity.recordIdentity.column)} = $3
               AND ${identifier(entity.archive.archivedAtColumn)} IS NULL FOR SHARE`,
          [view.tenantId, view.environmentId, target.recordId],
        ),
      );
      const row = stored.rows[0];
      if (
        !row ||
        row.company_id !== target.companyId ||
        Number(row.revision) !== result.revision
      )
        throw notFound();
      const scope = row.company_id ?? 'shared';
      await this.authorize(client, policy, view, scope, permissions);
      return work(client, {
        entity,
        recordId: target.recordId,
        revision: result.revision,
        scope,
      });
    });
  }
}

function documentDefinition(view: RequestRuntimeView) {
  const projection = view.projections.documents;
  return projection
    ? DocumentsProjectionSchema.parse(projection.payload)
    : null;
}

function checkSameRecord(initial: GoverningRecord, current: GoverningRecord) {
  if (initial.revision !== current.revision || initial.scope !== current.scope)
    throw new DocumentRequestError(
      409,
      'The record changed during the upload.',
    );
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    throw new TypeError('invalid physical identifier');
  return '"' + value + '"';
}

function targetKey(view: RequestRuntimeView, record: GoverningRecord) {
  return [
    view.tenantId,
    view.environmentId,
    record.entity.entityId,
    record.recordId,
    record.scope,
  ];
}

function notFound(): DocumentRequestError {
  return new DocumentRequestError(
    404,
    'This attachment or record is unavailable.',
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function lockDocumentQuota(client: PoolClient, view: RequestRuntimeView) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('documents:' || $1 || ':' || $2, 0))",
    [view.tenantId, view.environmentId],
  );
}

async function scopeBytes(
  client: PoolClient,
  view: RequestRuntimeView,
  table: 'document_blobs' | 'document_upload_staging',
) {
  const result = await client.query<{ used: string }>(
    `SELECT coalesce(sum(byte_length), 0)::text AS used FROM platform.${table}
      WHERE tenant_id = $1 AND environment_id = $2`,
    [view.tenantId, view.environmentId],
  );
  return Number(result.rows[0]!.used);
}

interface UploadBinding {
  readonly principal_id: string;
  readonly owner_scope: string;
  readonly entity_id: string;
  readonly record_id: string;
  readonly field_id: string | null;
  readonly category_id: string | null;
  readonly file_name: string;
  readonly digest: string;
}

async function readUploadReceipt(
  client: PoolClient,
  view: RequestRuntimeView,
  uploadId: string,
) {
  const result = await client.query<
    UploadBinding & { metadata: DocumentMetadata }
  >(
    `SELECT v.actor_id AS principal_id, v.owner_scope, v.entity_id, v.record_id, v.field_id,
            v.category_id, v.digest, v.file_name,
            (SELECT row_to_json(summary) FROM (SELECT ${metadataColumns}) summary) AS metadata
       FROM platform.document_versions v
       JOIN platform.document_blobs b USING (tenant_id, environment_id, owner_scope, digest)
      WHERE v.tenant_id = $1 AND v.environment_id = $2 AND v.upload_id = $3`,
    [view.tenantId, view.environmentId, uploadId],
  );
  return result.rows[0];
}

function matchesUpload(
  binding: UploadBinding,
  view: RequestRuntimeView,
  record: GoverningRecord,
  upload: DocumentUpload,
  digest: string,
  fileName: string,
) {
  return (
    binding.principal_id === view.principalId &&
    binding.owner_scope === record.scope &&
    binding.entity_id === record.entity.entityId &&
    binding.record_id === record.recordId &&
    binding.field_id === upload.fieldId &&
    binding.category_id === upload.categoryId &&
    binding.digest === digest &&
    binding.file_name === fileName
  );
}
