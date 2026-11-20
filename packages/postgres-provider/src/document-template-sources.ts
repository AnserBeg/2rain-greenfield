import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import { canonicalize } from '@north-star/canonical-model';
import {
  DOCUMENT_TEMPLATE_MAX_ROWS,
  type DOCUMENT_TEMPLATE_RENDERER,
} from '../../canonical-model/src/documents.js';
import type { DocumentTemplateRevision } from '../../canonical-model/src/document-template-schema.js';
import {
  DocumentRequestError,
  type DocumentTarget,
} from '../../runtime/src/document-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../runtime/src/list-behavior/index.js';
import type { RequestRuntimeView } from '../../runtime/src/request-runtime-view.js';
import {
  registeredQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type RegisteredQueryDefinition,
  type SemanticQueryGateway,
  type SemanticRecordDto,
} from '../../runtime/src/semantic-query-gateway.js';
import { documentDigest } from './document-content.js';
import type { DocumentPdfInput } from './document-pdf.js';

type StorageEntity = StorageTargetPayloadV1['entities'][number];
type StorageRelation = StorageTargetPayloadV1['relations'][number];

export interface DocumentFieldAuthority {
  readonly classification:
    'public' | 'internal' | 'confidential' | 'restricted';
  readonly fieldKind: string;
}

interface FieldSource extends DocumentFieldAuthority {
  readonly fieldId: string;
}

export interface DocumentQuerySource {
  readonly queryId: string;
  readonly queryDigest: string;
  readonly entityId: string;
  readonly companyId: string | null;
  readonly parentRelationId: string | null;
  readonly fields: readonly FieldSource[];
  readonly rows: ReadonlyArray<{
    readonly recordId: string;
    readonly revision: number;
  }>;
}

export interface GeneratedDocumentSource {
  readonly templateId: string;
  readonly revisionId: string;
  readonly issuedIdentity: string;
  readonly inputDigest: string;
  readonly releaseRoot: string;
  readonly brandRevision: string;
  readonly companyBrandSource: DocumentQuerySource | null;
  readonly renderer: typeof DOCUMENT_TEMPLATE_RENDERER;
  readonly recordId: string;
  readonly queries: readonly DocumentQuerySource[];
  readonly logo: {
    readonly source: DocumentQuerySource;
    readonly linkId: string;
    readonly versionId: string;
    readonly digest: string;
  } | null;
}

export interface DocumentSourceContext {
  readonly storage: StorageTargetPayloadV1;
  readonly fields: ReadonlyMap<string, DocumentFieldAuthority>;
}

export function documentSourceQuery(
  view: RequestRuntimeView,
  context: DocumentSourceContext,
  source: Pick<
    DocumentQuerySource,
    'queryId' | 'companyId' | 'parentRelationId'
  >,
  governingEntityId: string,
): {
  query: RegisteredQueryDefinition;
  entity: StorageEntity;
  relation: StorageRelation | null;
} {
  const query = registeredQueryFromPinnedView(view, source.queryId);
  const entity = context.storage.entities.find(
    (entity) => entity.entityId === query?.sourceEntityId,
  );
  const relation = source.parentRelationId
    ? context.storage.relations.find(
        ({ relationId }) => relationId === source.parentRelationId,
      )
    : null;
  if (
    !query ||
    !entity ||
    query.lifecycle !== 'active' ||
    entity.lifecycle !== 'active' ||
    query.tier !== 'q0' ||
    query.readModel ||
    query.filter.kind !== 'booleanPredicate' ||
    query.filter.value !== true ||
    Boolean(query.legalEntityScope) !== Boolean(source.companyId) ||
    Boolean(entity.legalEntity) !== Boolean(source.companyId) ||
    (query.parameters?.length ?? 0) !== (source.companyId ? 1 : 0) ||
    (source.parentRelationId
      ? query.queryType !== 'list' ||
        relation?.sourceEntityId !== entity.entityId ||
        relation.targetEntityId !== governingEntityId ||
        relation.ownership !== 'parentScopedChild'
      : query.queryType !== 'get' || query.sourceEntityId !== governingEntityId)
  )
    throw unavailableBinding();
  return { query, entity, relation: relation ?? null };
}

export function documentSourceField(
  context: DocumentSourceContext,
  query: RegisteredQueryDefinition,
  entity: StorageEntity,
  fieldId: string,
): FieldSource {
  const field = context.fields.get(fieldId);
  const column = entity.columns.find(
    ({ canonicalFieldId }) => canonicalFieldId === fieldId,
  );
  if (
    !field ||
    (field.classification !== 'public' &&
      field.classification !== 'internal') ||
    field.fieldKind !== column?.fieldContract.fieldKind ||
    !query.selections.some((selection) => selection.fieldId === fieldId)
  )
    throw unavailableBinding();
  return { ...field, fieldId };
}

export function documentQueryDigest(query: RegisteredQueryDefinition): string {
  return documentDigest(
    Buffer.from(
      canonicalize({
        filter: query.filter,
        legalEntityScope: query.legalEntityScope ?? null,
        parameters: query.parameters ?? [],
        permissionId: query.permissionId,
        queryId: query.queryId,
        queryType: query.queryType,
        sourceEntityId: query.sourceEntityId,
        tier: query.tier,
      }),
    ),
  );
}

export async function readDocumentTemplateSources(
  view: RequestRuntimeView,
  target: DocumentTarget,
  template: DocumentTemplateRevision,
  context: DocumentSourceContext,
  gateway: SemanticQueryGateway,
  preview: boolean,
  signal: AbortSignal,
) {
  const used: DocumentQuerySource[] = [];
  const read = async (
    queryId: string,
    parentRelationId: string | null,
    fieldIds: readonly string[],
  ) => {
    signal.throwIfAborted();
    const { query, entity } = documentSourceQuery(
      view,
      context,
      { queryId, parentRelationId, companyId: target.companyId },
      template.entityId,
    );
    const fields = [...new Set(fieldIds)].map((fieldId) =>
      documentSourceField(context, query, entity, fieldId),
    );
    const scope = query.legalEntityScope;
    const argumentsForQuery = {
      ...(parentRelationId
        ? {
            list: {
              schemaVersion: SHARED_LIST_QUERY_VERSION,
              cursor: null,
              pageSize: DOCUMENT_TEMPLATE_MAX_ROWS,
              search: '',
              matchMode: 'prefix',
              sort: [],
              relationLabels: [],
              parentScope: {
                relationId: parentRelationId,
                recordId: target.recordId,
              },
            },
          }
        : { recordId: target.recordId }),
      ...(scope && target.companyId
        ? {
            [scope.operand.parameterId]:
              scope.cardinality === 'exactlyOne'
                ? target.companyId
                : [target.companyId],
          }
        : {}),
    };
    const result = await gateway
      .invoke(view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId,
        arguments: argumentsForQuery,
      })
      .catch(() => {
        throw unavailableBinding();
      });
    signal.throwIfAborted();
    if (
      result.outcome !== 'exact' ||
      (parentRelationId
        ? !result.listCoverage ||
          result.listCoverage.hasMore ||
          result.listCoverage.totalCount !== result.records.length ||
          result.records.length > DOCUMENT_TEMPLATE_MAX_ROWS
        : result.records.length !== 1 ||
          result.records[0]?.recordId !== target.recordId) ||
      result.records.some(
        (row) => row.archived || row.entityId !== entity.entityId,
      )
    )
      throw unavailableBinding();
    used.push({
      queryId,
      parentRelationId,
      companyId: target.companyId,
      entityId: entity.entityId,
      queryDigest: documentQueryDigest(query),
      fields,
      rows: result.records.map(({ recordId, revision }) => ({
        recordId,
        revision,
      })),
    });
    return {
      rows: result.records,
      fields: new Map(fields.map((field) => [field.fieldId, field])),
    };
  };

  const header = await read(template.headerQueryId, null, [
    ...(!preview ? [template.identityFieldId] : []),
    ...template.layout.flatMap((block) =>
      block.kind === 'field' ? [block.fieldId] : [],
    ),
    ...(template.currencyFieldId ? [template.currencyFieldId] : []),
  ]);
  const record = header.rows[0]!;
  const identity = preview
    ? null
    : issueIdentity(record.values[template.identityFieldId]);
  const blocks: DocumentPdfInput['blocks'][number][] = [];
  for (const block of template.layout) {
    if (block.kind === 'field') {
      const value = formatField(
        record,
        header.fields.get(block.fieldId)!,
        template,
        template.currencyFieldId,
      );
      blocks.push({
        kind: 'text',
        text: safeDocumentPdfText(block.label + ': ' + value),
      });
    } else if (block.kind === 'table') {
      const table = await read(block.queryId, block.parentRelationId, [
        ...block.columns.map(({ fieldId }) => fieldId),
        ...(block.currencyFieldId ? [block.currencyFieldId] : []),
      ]);
      blocks.push({
        kind: 'table',
        title: safeDocumentPdfText(block.label),
        columns: block.columns.map(({ label }) => safeDocumentPdfText(label)),
        rows: table.rows.map((row) =>
          block.columns.map(({ fieldId }) =>
            safeDocumentPdfText(
              formatField(
                row,
                table.fields.get(fieldId)!,
                template,
                block.currencyFieldId,
              ),
            ),
          ),
        ),
      });
    } else {
      blocks.push({ kind: block.kind, text: safeDocumentPdfText(block.text) });
    }
  }
  return {
    record,
    queries: used,
    input: {
      identity,
      paper: template.format.pageSize,
      pageNumbers: template.pageNumbers,
      blocks,
    } satisfies Omit<
      DocumentPdfInput,
      'name' | 'ink' | 'accent' | 'logoDataUri'
    >,
  };
}

function formatField(
  record: SemanticRecordDto,
  field: FieldSource,
  template: DocumentTemplateRevision,
  currencyFieldId: string | null,
): string {
  const value = record.values[field.fieldId];
  const { locale, currency, numberGrouping, dateStyle, timeZone } =
    template.format;
  switch (field.fieldKind) {
    case 'booleanFieldType':
      if (typeof value !== 'boolean') throw unavailableBinding();
      return locale === 'fr-CA'
        ? value
          ? 'Oui'
          : 'Non'
        : value
          ? 'Yes'
          : 'No';
    case 'integerFieldType':
    case 'exactDecimalFieldType':
    case 'quantityFieldType':
    case 'moneyFieldType': {
      const exact =
        typeof value === 'number' && Number.isSafeInteger(value)
          ? String(value)
          : value;
      if (
        typeof exact !== 'string' ||
        !/^-?\d{1,38}(?:\.\d{1,20})?$/u.test(exact)
      )
        throw unavailableBinding();
      const money = field.fieldKind === 'moneyFieldType';
      if (
        money &&
        (!currencyFieldId || record.values[currencyFieldId] !== currency)
      )
        throw unavailableBinding();
      const fraction = exact.split('.')[1]?.length ?? 0;
      const formatter = new Intl.NumberFormat(locale, {
        useGrouping: numberGrouping,
        maximumFractionDigits: fraction,
        minimumFractionDigits: fraction,
        ...(money
          ? { style: 'currency', currency, currencyDisplay: 'code' }
          : {}),
      });
      // Intl takes a decimal string as an exact mathematical value in the pinned Node runtime.
      return formatter.format(exact as `${number}`);
    }
    case 'dateFieldType':
    case 'dateTimeFieldType': {
      if (typeof value !== 'string') throw unavailableBinding();
      const isDate = field.fieldKind === 'dateFieldType';
      const date = new Date(isDate ? value + 'T00:00:00Z' : value);
      if (!Number.isFinite(date.getTime())) throw unavailableBinding();
      return new Intl.DateTimeFormat(locale, {
        dateStyle,
        ...(isDate ? {} : { timeStyle: 'short' }),
        timeZone: isDate ? 'UTC' : timeZone,
      }).format(date);
    }
    default:
      if (typeof value !== 'string') throw unavailableBinding();
      return value;
  }
}

function issueIdentity(value: unknown) {
  if (
    (typeof value !== 'string' && !Number.isSafeInteger(value)) ||
    String(value).trim().length === 0 ||
    String(value).length > 100
  )
    throw unavailableBinding();
  return safeDocumentPdfText(String(value));
}

export function safeDocumentPdfText(value: string) {
  const text = value.normalize('NFC').replaceAll('\u202f', '\u00a0');
  // The built-in PDFKit fonts use WinAnsi. Refuse glyphs they cannot encode.
  if (
    text.length > 1024 ||
    /[^\n\x20-\x7e\xa0-\xff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u2013\u2014\u2018\u2019\u201a\u201c\u201d\u201e\u2020\u2021\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/u.test(
      text,
    )
  )
    throw new DocumentRequestError(
      422,
      'This template contains text the PDF font cannot render.',
    );
  return text;
}

export function unavailableBinding() {
  return new DocumentRequestError(
    404,
    'A required template value or source record is unavailable.',
  );
}
