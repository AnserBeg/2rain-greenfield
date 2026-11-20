import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { canonicalize } from '@north-star/canonical-model';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import {
  DOCUMENT_BLOB_MAX_BYTES,
  DOCUMENT_PERMISSIONS,
  DOCUMENT_TEMPLATE_RENDERER,
  documentAttachPermission,
  documentAttachOperation,
  documentGenerateOperation,
} from '../../canonical-model/src/documents.js';
import type { DocumentTemplateRevision } from '../../canonical-model/src/document-template-schema.js';
import { DocumentsProjectionSchema } from '../../canonical-model/src/schemas.js';
import {
  DocumentRequestError,
  type DocumentGateway,
  type DocumentDeadline,
  DOCUMENT_PAGE_SIZE,
  documentDeadline,
  type DocumentMetadata,
  type DocumentTarget,
  type DocumentUpload,
} from '../../runtime/src/document-gateway.js';
import {
  authorizeCurrentPolicy,
  LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID,
  trustedContextForRequestRuntimeView,
  type RequestRuntimeView,
} from '../../runtime/src/request-runtime-view.js';
import {
  QUERY_BOUNDARY_PERMISSION_ID,
  registeredQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticQueryGateway,
  type RegisteredQueryDefinition,
  type SemanticRecordDto,
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
import {
  withReadSnapshot,
  setTransactionDeadline,
  withTrustedRequestTransaction,
} from './request-context.js';
import {
  OPERATION_BOUNDARY_PERMISSION_ID,
  type SemanticOperationGateway,
  type SemanticOperationMediationAuthority,
} from '../../runtime/src/semantic-operation-gateway.js';
import type { PostgresDocumentPublication } from './document-publication.js';

import {
  DOCUMENT_BRAND_COMPANY_ENTITY,
  type CompanyDocumentBrandResolver,
} from './document-company-brand.js';
import { renderDocumentPdf } from './document-pdf.js';
import {
  documentQueryDigest,
  documentSourceField,
  documentSourceQuery,
  readDocumentTemplateSources,
  safeDocumentPdfText,
  unavailableBinding,
  type DocumentFieldAuthority,
  type DocumentQuerySource,
  type GeneratedDocumentSource,
} from './document-template-sources.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
type Entity = StorageTargetPayloadV1['entities'][number];
type DocumentRelease = {
  readonly policy: PostgresCurrentPolicyGateway;
  readonly storage: StorageTargetPayloadV1 | null;
  readonly documentFields: ReadonlyMap<string, DocumentFieldAuthority> | null;
};

interface GoverningRecord {
  readonly entity: Entity;
  readonly record: SemanticRecordDto;
  readonly query: RegisteredQueryDefinition;
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
    private readonly scannerPool: Pool | undefined,
    private readonly publication: PostgresDocumentPublication,
    private readonly operations: SemanticOperationGateway,
    private readonly mediation: SemanticOperationMediationAuthority,
    private readonly companyBrand: CompanyDocumentBrandResolver,
  ) {}

  get scannerLabel() {
    return this.scanner?.label ?? null;
  }

  async list(
    view: RequestRuntimeView,
    target: DocumentTarget,
    page: { after: string | null; limit: number } = {
      after: null,
      limit: DOCUMENT_PAGE_SIZE,
    },
    deadline = documentDeadline(),
  ): Promise<readonly DocumentMetadata[]> {
    if (
      (page.after !== null && !uuid.test(page.after)) ||
      !Number.isInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > DOCUMENT_PAGE_SIZE + 1
    )
      throw new DocumentRequestError(400, 'Invalid file page.');
    return this.withRecord(
      view,
      target,
      [DOCUMENT_PERMISSIONS.view],
      deadline,
      async (client, record) => {
        const result = await client.query<{ metadata: DocumentMetadata }>(
          'SELECT metadata FROM platform.list_document_versions($1,$2,$3,$4,$5)',
          [
            record.scope,
            record.entity.entityId,
            record.recordId,
            page.after,
            page.limit,
          ],
        );
        return result.rows.map((row) => row.metadata);
      },
    );
  }

  async read(
    view: RequestRuntimeView,
    target: DocumentTarget,
    linkId: string,
    versionId: string,
    deliver: (metadata: DocumentMetadata, bytes: Buffer) => void,
    deadline = documentDeadline(),
  ): Promise<void> {
    if (!uuid.test(linkId) || !uuid.test(versionId)) throw notFound();
    await this.withRecord(
      view,
      target,
      [DOCUMENT_PERMISSIONS.view, DOCUMENT_PERMISSIONS.download],
      deadline,
      async (client, record) => {
        const result = await client.query<{
          metadata: DocumentMetadata;
          bytes: Buffer;
        }>('SELECT * FROM platform.read_document_version($1,$2,$3,$4,$5)', [
          record.scope,
          record.entity.entityId,
          record.recordId,
          linkId,
          versionId,
        ]);
        const row = result.rows[0];
        if (!row) throw notFound();
        deadline.remainingMilliseconds();
        deliver(row.metadata, row.bytes);
      },
    );
  }

  async upload(
    view: RequestRuntimeView,
    target: DocumentTarget,
    upload: DocumentUpload,
    receive: (maximumBytes: number) => Promise<Buffer>,
    signal: AbortSignal,
    deadline = documentDeadline(signal),
  ): Promise<DocumentMetadata> {
    return this.acceptUpload(view, target, upload, receive, deadline, null);
  }

  async generate(
    view: RequestRuntimeView,
    target: DocumentTarget,
    templateId: string,
    retryKey: string,
    signal: AbortSignal,
    deadline = documentDeadline(signal),
  ): Promise<DocumentMetadata> {
    if (!uuid.test(retryKey))
      throw new DocumentRequestError(400, 'Invalid PDF retry key.');
    const receipt = await this.withRecord(
      view,
      target,
      [DOCUMENT_PERMISSIONS.view],
      deadline,
      async (client, record) => {
        const { rows } = await client.query<{
          metadata: DocumentMetadata | null;
        }>(
          'SELECT platform.read_generated_document_receipt($1,$2,$3,$4,$5) AS metadata',
          [
            record.scope,
            record.entity.entityId,
            record.recordId,
            scopedUploadId(view, retryKey),
            templateId,
          ],
        );
        return rows[0]!.metadata;
      },
    );
    if (receipt) return receipt;
    if (!this.scanner || !this.scannerPool)
      throw new DocumentRequestError(
        503,
        'PDF generation requires an active document content scanner.',
      );
    const template = this.activeTemplate(view, target, templateId);
    const rendered = await this.renderTemplate(
      view,
      target,
      template,
      false,
      deadline,
    );
    const generated: GeneratedDocumentSource = {
      templateId,
      revisionId: template.revisionId,
      issuedIdentity: rendered.input.identity!,
      releaseRoot: view.release.contentHash,
      renderer: DOCUMENT_TEMPLATE_RENDERER,
      brandRevision: rendered.brandRevision,
      companyBrandSource: rendered.companyBrandSource,
      recordId: target.recordId,
      queries: rendered.queries,
      logo: rendered.logo,
      inputDigest: documentDigest(
        Buffer.from(
          canonicalize({
            revision: template,
            brandRevision: rendered.brandRevision,
            companyBrandSource: rendered.companyBrandSource,
            input: rendered.input,
            recordId: target.recordId,
            queries: rendered.queries,
            logo: rendered.logo,
          }),
        ),
      ),
    };
    const title = template.label.slice(
      0,
      175 - generated.issuedIdentity.length,
    );
    const fileName = `${title} ${generated.issuedIdentity}.pdf`;
    return this.acceptUpload(
      view,
      target,
      {
        retryKey,
        fieldId: null,
        categoryId: null,
        fileName,
        contentType: 'application/pdf',
      },
      async () => rendered.bytes,
      deadline,
      generated,
    );
  }

  async previewTemplate(
    view: RequestRuntimeView,
    target: DocumentTarget,
    templateId: string,
    signal: AbortSignal,
    deadline = documentDeadline(signal),
  ): Promise<Buffer> {
    const template = this.activeTemplate(view, target, templateId);
    const rendered = await this.renderTemplate(
      view,
      target,
      template,
      true,
      deadline,
    );
    return rendered.bytes;
  }

  private activeTemplate(
    view: RequestRuntimeView,
    target: DocumentTarget,
    templateId: string,
  ) {
    const projection = documentDefinition(view);
    const pointer = projection?.templates?.pointers.find(
      (entry) => entry.templateId === templateId,
    );
    const template = projection?.templates?.revisions.find(
      (entry) =>
        entry.templateId === templateId &&
        entry.revisionId === pointer?.activeRevisionId,
    );
    if (
      !template ||
      !projection?.bindings.some(
        ({ entityId, surfaceIds, generateOperationId }) =>
          entityId === template.entityId &&
          generateOperationId === documentGenerateOperation(entityId) &&
          surfaceIds.some((id) => id === target.surfaceId),
      )
    )
      throw notFound();
    return template;
  }

  private async renderTemplate(
    view: RequestRuntimeView,
    target: DocumentTarget,
    template: DocumentTemplateRevision,
    preview: boolean,
    deadline: DocumentDeadline,
  ) {
    const { storage, documentFields } = await this.release(
      view.release.releaseId,
    );
    if (!storage || !documentFields) throw unavailableBinding();
    const permissions = preview
      ? [DOCUMENT_PERMISSIONS.view, DOCUMENT_PERMISSIONS.download]
      : [DOCUMENT_PERMISSIONS.view, DOCUMENT_PERMISSIONS.upload];
    const initial = await this.withRecord(
      view,
      target,
      permissions,
      deadline,
      async (client, record) => {
        if (!preview) await this.authorizeAttach(client, view, record);
        return record;
      },
    );
    const context = { storage, fields: documentFields };
    const { inputs, brand } = await withReadSnapshot(
      this.pool,
      async () => ({
        inputs: await readDocumentTemplateSources(
          view,
          target,
          template,
          context,
          this.queryGateway,
          preview,
          deadline.signal,
        ),
        brand: await this.companyBrand.resolve(view, target.companyId, context),
      }),
      { retry: false, deadline },
    ).catch((error) => documentDatabaseError(error, deadline));
    if (inputs.record.revision !== initial.revision) throw unavailableBinding();

    const input = {
      ...inputs.input,
      name: safeDocumentPdfText(brand.displayName),
      ink: brand.ink,
      accent: brand.accent,
      logoDataUri: null,
    };
    const bytes = await renderDocumentPdf(input, deadline.signal);
    await validateDocumentContent(bytes, 'application/pdf', deadline.signal);
    const sources = {
      queries: inputs.queries,
      companyBrandSource: brand.companySource,
      logo: null,
    };
    await this.withRecord(
      view,
      target,
      permissions,
      deadline,
      async (client, record) => {
        checkSameRecord(initial, record);
        if (!preview) await this.authorizeAttach(client, view, record);
        await this.authorizeGenerated(client, view, record, sources);
      },
      { lockSources: true },
    );
    return { input, bytes, brandRevision: brand.revision, ...sources };
  }

  private async authorizeGenerated(
    client: PoolClient,
    view: RequestRuntimeView,
    governing: GoverningRecord,
    generated: Pick<GeneratedDocumentSource, 'queries' | 'companyBrandSource'>,
  ) {
    const { storage, documentFields, policy } = await this.release(
      view.release.releaseId,
    );
    if (!storage || !documentFields) throw unavailableBinding();
    const context = { storage, fields: documentFields };
    const check = async (source: DocumentQuerySource, entityId: string) => {
      const { query, entity, relation } = documentSourceQuery(
        view,
        context,
        source,
        entityId,
      );
      if (
        entity.entityId !== source.entityId ||
        documentQueryDigest(query) !== source.queryDigest
      )
        throw unavailableBinding();
      for (const field of source.fields) {
        const current = documentSourceField(
          context,
          query,
          entity,
          field.fieldId,
        );
        if (
          current.classification !== field.classification ||
          current.fieldKind !== field.fieldKind ||
          current.currencyCode !== field.currencyCode
        )
          throw unavailableBinding();
      }
      await this.authorize(client, policy, view, source.companyId ?? 'shared', [
        QUERY_BOUNDARY_PERMISSION_ID,
        query.permissionId,
        ...(source.companyId ? [LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID] : []),
      ]);
      const revisions = await withModuleRuntimeRole(client, async () =>
        client.query<{ id: string; revision: string }>(
          `SELECT ${identifier(entity.recordIdentity.column)} AS id,
                  ${identifier(entity.optimisticRevision.column)}::text AS revision
             FROM north_star_module.${identifier(entity.physicalTableName)}
            WHERE tenant_id = $1 AND environment_id = $2
              AND ($6::boolean OR ${identifier(entity.recordIdentity.column)} = ANY($3::uuid[]))
              AND ${identifier(entity.archive.archivedAtColumn)} IS NULL
              AND ${entity.legalEntity ? identifier(entity.legalEntity.column) + ' = $4::uuid' : '$4::uuid IS NULL'}
              AND ${relation ? identifier(relation.relationColumn.physicalName) + ' = $5::uuid' : '$5::uuid IS NULL'}
            ORDER BY ${identifier(entity.recordIdentity.column)} LIMIT 101 FOR SHARE`,
          [
            view.tenantId,
            view.environmentId,
            source.rows.map(({ recordId }) => recordId),
            source.companyId,
            relation ? governing.recordId : null,
            relation !== null,
          ],
        ),
      );
      const byId = new Map(
        revisions.rows.map(({ id, revision }) => [id, Number(revision)]),
      );
      if (
        byId.size !== source.rows.length ||
        source.rows.some(
          ({ recordId, revision }) => byId.get(recordId) !== revision,
        )
      )
        throw unavailableBinding();
    };
    for (const source of generated.queries) {
      if (
        (source.companyId ?? 'shared') !== governing.scope ||
        (!source.parentRelationId &&
          (source.rows.length !== 1 ||
            source.rows[0]?.recordId !== governing.recordId))
      )
        throw unavailableBinding();
      await check(source, governing.entity.entityId);
    }
    const company = generated.companyBrandSource;
    if (governing.scope !== 'shared') {
      if (
        !company ||
        company.companyId !== null ||
        company.parentRelationId !== null ||
        company.rows.length !== 1 ||
        company.rows[0]?.recordId !== governing.scope
      )
        throw unavailableBinding();
      await check(company, DOCUMENT_BRAND_COMPANY_ENTITY);
    } else if (company) {
      throw unavailableBinding();
    }
  }

  private async acceptUpload(
    view: RequestRuntimeView,
    target: DocumentTarget,
    upload: DocumentUpload,
    receive: (maximumBytes: number) => Promise<Buffer>,
    deadline: DocumentDeadline,
    generated: GeneratedDocumentSource | null,
  ): Promise<DocumentMetadata> {
    if (!this.scanner || !this.scannerPool)
      throw new DocumentRequestError(
        503,
        'File uploads are unavailable until a malware scanner is configured.',
      );
    const scanner = this.scanner;
    const scannerPool = this.scannerPool;
    if (!uuid.test(upload.retryKey))
      throw new DocumentRequestError(400, 'Invalid upload retry key.');
    const uploadId = scopedUploadId(view, upload.retryKey);
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
      deadline,
      async (client, record) => {
        checkField(record);
        await this.authorizeAttach(client, view, record);
        return record;
      },
    );
    const maximumBytes = category?.maxBytes ?? DOCUMENT_BLOB_MAX_BYTES;
    const bytes = await receive(maximumBytes);
    deadline.remainingMilliseconds();
    if (bytes.length > maximumBytes)
      throw new DocumentRequestError(
        413,
        'The file exceeds this upload limit.',
      );
    const contentType = await validateDocumentContent(
      bytes,
      upload.contentType,
      deadline.signal,
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
      deadline,
      async (client, record) => {
        checkSameRecord(targetRecord, record);
        await this.authorizeAttach(client, view, record);
        await setTransactionDeadline(client, deadline.remainingMilliseconds);
        const result = await client.query<{
          metadata: DocumentMetadata | null;
        }>(
          'SELECT platform.stage_document_upload($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS metadata',
          [
            record.scope,
            record.entity.entityId,
            record.recordId,
            uploadId,
            upload.fieldId,
            upload.categoryId,
            fileName,
            contentType,
            bytes,
            generated,
          ],
        );
        return result.rows[0]!.metadata;
      },
      { lockSources: generated !== null },
    );
    if (receipt) return receipt;
    const clean = await scanStage(
      scannerPool,
      scanner,
      view,
      uploadId,
      digest,
      bytes,
      contentType,
      deadline,
    );
    if (!clean)
      throw new DocumentRequestError(
        422,
        'The file did not pass content screening.',
      );

    return this.publication.publish(
      {
        view,
        record: targetRecord.record,
        query: targetRecord.query,
        companyId: target.companyId,
        ...(generated ? { generated: true as const } : {}),
        uploadId,
        commit: () =>
          this.withRecord(
            view,
            target,
            permissions,
            deadline,
            async (client, record) => {
              checkSameRecord(targetRecord, record);
              await this.authorizeAttach(client, view, record);
              await setTransactionDeadline(
                client,
                deadline.remainingMilliseconds,
              );
              const result = await client.query<{ metadata: DocumentMetadata }>(
                'SELECT platform.publish_document_upload($1,$2,$3,$4,$5,$6,$7) AS metadata',
                [
                  uploadId,
                  digest,
                  scanner.policyVersion,
                  view.release.releaseId,
                  record.revision,
                  category?.maxCount ?? null,
                  category?.retentionClass ?? null,
                ],
              );
              return result.rows[0]!.metadata;
            },
            {
              ...(deadline.beginPublicationCommit && {
                onCommitStart: deadline.beginPublicationCommit,
              }),
              lockSources: generated !== null,
            },
          ),
      },
      this.operations,
      this.mediation,
    );
  }

  private async authorizeAttach(
    client: PoolClient,
    view: RequestRuntimeView,
    record: GoverningRecord,
  ) {
    const { policy } = await this.release(view.release.releaseId);
    await this.authorize(client, policy, view, record.scope, [
      OPERATION_BOUNDARY_PERMISSION_ID,
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
    deadline: DocumentDeadline,
    work: (client: PoolClient, record: GoverningRecord) => Promise<T>,
    options: { onCommitStart?: () => void; lockSources?: boolean } = {},
  ): Promise<T> {
    const context = trustedContextForRequestRuntimeView(view);
    deadline.remainingMilliseconds();
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
      query.tier !== 'q0'
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
    if (query.readModel && !canonicalBinding) throw notFound();
    if (
      canonicalBinding &&
      (canonicalBinding.queryId !== query.queryId ||
        canonicalBinding.attachOperationId !==
          documentAttachOperation(entity.entityId) ||
        canonicalBinding.attachPermissionId !==
          documentAttachPermission(entity.entityId) ||
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

    return withTrustedRequestTransaction(
      this.pool,
      context,
      async (client) => {
        deadline.remainingMilliseconds();
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
               AND ${identifier(entity.archive.archivedAtColumn)} IS NULL FOR ${options.lockSources ? 'UPDATE' : 'SHARE'}`,
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
        await setTransactionDeadline(client, deadline.remainingMilliseconds);
        return work(client, {
          entity,
          record: result,
          query,
          recordId: target.recordId,
          revision: result.revision,
          scope,
        });
      },
      deadline.remainingMilliseconds,
      options.onCommitStart,
    ).catch((error) => documentDatabaseError(error, deadline));
  }
}

function scopedUploadId(view: RequestRuntimeView, retryKey: string): string {
  const bytes = createHash('sha256')
    .update('northstar.document-upload/v1\0')
    .update(
      JSON.stringify([
        view.tenantId,
        view.environmentId,
        view.principalId,
        retryKey,
      ]),
    )
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

function notFound(): DocumentRequestError {
  return new DocumentRequestError(
    404,
    'This attachment or record is unavailable.',
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function documentDatabaseError(
  error: unknown,
  deadline: DocumentDeadline,
): never {
  deadline.remainingMilliseconds();
  if (error instanceof Error && 'code' in error) {
    if (error.code === '57014')
      throw new DocumentRequestError(408, 'The file response expired.');
    if (
      typeof error.code === 'string' &&
      /^D0(404|409|413|422)$/u.test(error.code)
    )
      throw new DocumentRequestError(
        Number(error.code.slice(2)),
        error.message,
      );
  }
  throw error;
}

async function scanStage(
  pool: Pool,
  scanner: DocumentScanner,
  view: RequestRuntimeView,
  uploadId: string,
  digest: string,
  bytes: Buffer,
  contentType: string,
  deadline: DocumentDeadline,
) {
  const binding = [
    view.tenantId,
    view.environmentId,
    view.principalId,
    uploadId,
    digest,
    scanner.policyVersion,
  ];
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await setTransactionDeadline(client, deadline.remainingMilliseconds);
    const existing = await client.query<{ clean: boolean | null }>(
      'SELECT platform.lock_document_scan($1,$2,$3,$4,$5,$6) AS clean',
      binding,
    );
    let clean = existing.rows[0]!.clean;
    if (clean === null) {
      deadline.remainingMilliseconds();
      const verdict = await scanner.scan({
        bytes: Uint8Array.from(bytes),
        digest,
        contentType,
        signal: deadline.signal,
      });
      if (verdict.digest !== digest)
        throw new DocumentRequestError(
          422,
          'The scan did not match the staged file.',
        );
      clean = verdict.clean;
      await client.query(
        'SELECT platform.record_document_scan($1,$2,$3,$4,$5,$6,$7)',
        [...binding, clean],
      );
    }
    // Retain a scanner rejection even if the client disconnected during scanning.
    await client.query('COMMIT');
    return clean;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    return documentDatabaseError(error, deadline);
  } finally {
    client.release(discard);
  }
}
