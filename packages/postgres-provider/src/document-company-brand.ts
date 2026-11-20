import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticQueryGateway,
} from '../../runtime/src/semantic-query-gateway.js';
import type { RequestRuntimeView } from '../../runtime/src/request-runtime-view.js';
import {
  documentQueryDigest,
  documentSourceField,
  documentSourceQuery,
  unavailableBinding,
  type DocumentQuerySource,
  type DocumentSourceContext,
} from './document-template-sources.js';

export const DOCUMENT_BRAND_COMPANY_ENTITY =
  'northstar.app:entity.legal_entity';
const companyQueryId = 'northstar.app:query.legal_entity_get';
const companyNameFieldId = 'northstar.app:field.legal_entity_name';

// Ledger's light ink and accent tokens on white paper.
const ledgerPrintPalette = { ink: '#17191C', accent: '#0E6670' };

export interface CompanyDocumentBrand {
  readonly revision: string;
  readonly displayName: string;
  readonly ink: string;
  readonly accent: string;
  readonly companySource: DocumentQuerySource | null;
  readonly logo: {
    readonly surfaceId: string;
    readonly recordId: string;
    readonly companyId: string | null;
    readonly linkId: string;
    readonly versionId: string;
  } | null;
}

export interface CompanyDocumentBrandResolver {
  resolve(
    view: RequestRuntimeView,
    companyId: string | null,
    context: DocumentSourceContext,
  ): Promise<CompanyDocumentBrand>;
}

export class LedgerDocumentBrandResolver implements CompanyDocumentBrandResolver {
  constructor(private readonly queries: SemanticQueryGateway) {}

  async resolve(
    view: RequestRuntimeView,
    companyId: string | null,
    context: DocumentSourceContext,
  ): Promise<CompanyDocumentBrand> {
    const defaults = {
      ...ledgerPrintPalette,
      revision: 'platform-default',
      logo: null,
    };
    if (!companyId)
      return { ...defaults, displayName: 'Ledger', companySource: null };

    const binding = {
      companyId: null,
      queryId: companyQueryId,
      parentRelationId: null,
    };
    const { query, entity } = documentSourceQuery(
      view,
      context,
      binding,
      DOCUMENT_BRAND_COMPANY_ENTITY,
    );
    const field = documentSourceField(
      context,
      query,
      entity,
      companyNameFieldId,
    );
    const result = await this.queries.invoke(view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: companyQueryId,
      arguments: { recordId: companyId },
    });
    const [record] = result.records;
    const displayName = record?.values[companyNameFieldId];
    if (
      result.outcome !== 'exact' ||
      result.records.length !== 1 ||
      record?.recordId !== companyId ||
      record.entityId !== entity.entityId ||
      record.archived ||
      typeof displayName !== 'string' ||
      !displayName.trim()
    )
      throw unavailableBinding();
    return {
      ...defaults,
      displayName,
      companySource: {
        ...binding,
        entityId: entity.entityId,
        queryDigest: documentQueryDigest(query),
        fields: [field],
        rows: [{ recordId: companyId, revision: record.revision }],
      },
    };
  }
}
