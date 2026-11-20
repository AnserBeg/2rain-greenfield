import type { Pool } from 'pg';
import {
  BillingPlansSchema,
  BillingListAssignmentSchema,
  BILLING_INTERVAL_READER,
} from '../../canonical-model/src/billing.js';
import { BillingQuoteEvidenceSchema } from '../../canonical-model/src/billing-evidence.js';
import { quoteBillingService } from '../../domain/src/billing/quote.js';
import { canonicalize } from '../../canonical-model/src/canonicalize.js';
import { compileRatePlan } from '../../domain/src/billing/terms.js';
import {
  type ImmutableJsonValue,
  trustedContextForRequestRuntimeView,
} from '../../runtime/src/request-runtime-view.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticQueryReadModelExecutor,
} from '../../runtime/src/semantic-query-gateway.js';
import { withTrustedRequestRead } from './request-context.js';

export function billingPlansIn(payload: unknown) {
  if (!payload || typeof payload !== 'object' || !('billingPlans' in payload))
    return [];
  return BillingPlansSchema.parse(payload.billingPlans);
}
export function billingQuoteReadModel(
  pool: Pool,
): SemanticQueryReadModelExecutor {
  return async ({ view, definition, result, arguments: args, gateway }) => {
    if (result.outcome !== 'exact' || !result.records.length) return result;
    const surface = view.projections.surface;
    const p = billingPlansIn(surface.payload).find(
      (p) => p.bindings?.quoteQueryId === definition.queryId,
    );
    if (
      !p?.bindings ||
      (surface.requiredRuntimeCapability?.minimumVersion ?? 0) <
        BILLING_INTERVAL_READER ||
      definition.queryType !== 'get' ||
      result.records.length !== 1 ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args)
    )
      throw new Error('Unbound billing quote');
    const b = p.bindings,
      base = result.records[0]!,
      scope = definition.legalEntityScope;
    const source = registeredSemanticQueryFromPinnedView(
      view,
      b.evidenceQueryId,
    );
    if (
      !scope ||
      scope.cardinality !== 'exactlyOne' ||
      !source?.legalEntityScope ||
      source.legalEntityScope.cardinality !== 'exactlyOne' ||
      source.queryType !== 'get' ||
      source.readModel ||
      source.sourceEntityId !== base.entityId ||
      definition.readModel?.queries.evidence?.targetId !== source.queryId
    )
      throw new Error('Billing evidence requires a scoped exact get');
    const company = (args as Record<string, ImmutableJsonValue>)[
      scope.operand.parameterId
    ];
    if (typeof company !== 'string')
      throw new Error('Billing requires one company');
    const read = await gateway.invoke(view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: source.queryId,
      arguments: {
        recordId: base.recordId,
        [source.legalEntityScope.operand.parameterId]: company,
      },
    });
    const row = read.records[0];
    if (
      read.outcome !== 'exact' ||
      read.records.length !== 1 ||
      row?.recordId !== base.recordId ||
      row.revision !== base.revision ||
      row.archived
    )
      throw new Error('Incomplete or stale service evidence');
    const fields = b.agreedInterval;
    if (!fields || b.evidenceFieldId)
      throw new Error('BILLING_SOURCE_FIELDS_REQUIRED');
    const customerId = row.values[fields.customerFieldId],
      currency = row.values[fields.currencyFieldId],
      anchor = row.values[fields.startFieldId],
      end = row.values[fields.endFieldId];
    // Both reads attest the same revision, company and commercial identity.
    if (
      typeof customerId !== 'string' ||
      !customerId ||
      currency !== p.currency ||
      base.values[fields.customerFieldId] !== customerId ||
      base.values[fields.currencyFieldId] !== currency ||
      typeof anchor !== 'string' ||
      typeof end !== 'string'
    )
      throw new Error(
        'Billing source identity, currency or interval disagrees',
      );
    const { plan } = compileRatePlan(p);
    const snapshot = await withTrustedRequestRead(
      pool,
      trustedContextForRequestRuntimeView(view),
      async (client) => {
        const result = await client.query<{
          tables: unknown[];
          assignments: unknown[];
          as_of: Date;
        }>('SELECT * FROM platform.billing_quote_terms($1,$2,$3,$4)', [
          view.release.releaseId,
          company,
          canonicalize(plan),
          customerId,
        ]);
        return result.rows[0]!;
      },
    );
    const assignments = snapshot.assignments.map((row) => {
      if (!row || typeof row !== 'object' || !('publishedAt' in row))
        throw new Error('Missing assignment publication');
      const { publishedAt, ...body } = row;
      const a = BillingListAssignmentSchema.parse(body);
      if (a.customerId !== customerId)
        throw new Error('Assignment owner mismatch');
      return {
        publishedAt,
        listId: a.listId,
        revision: a.revision,
        priority: a.priority,
        effectiveFrom: a.effectiveFrom,
        ...(a.effectiveEnd ? { effectiveEnd: a.effectiveEnd } : {}),
      };
    });
    const revision = String(row.revision);
    const evidence = BillingQuoteEvidenceSchema.parse({
      schemaVersion: 'northstar.billing-quote-evidence/v1',
      tenantId: view.tenantId,
      environmentId: view.environmentId,
      companyId: company,
      serviceId: row.recordId,
      sourceQueryId: source.queryId,
      sourceRevision: revision,
      cursor: revision,
      release: view.release.contentHash,
      customerId,
      currency,
      serviceUnit: p.serviceUnit,
      zone: fields.zone,
      anchor,
      periodStart: anchor,
      serviceEnd: end,
      asOf: snapshot.as_of.toISOString(),
      basis: 'agreed',
      bands: [
        {
          id: row.recordId,
          quantity: '1',
          intervals: [{ id: row.recordId, revision, start: anchor, end }],
        },
      ],
      pauses: [],
      usage: [],
      tables: snapshot.tables,
      assignments,
      allocations: [],
    });
    const quote = quoteBillingService(p, evidence);
    const target = definition.readModel?.resultFields.explanation;
    if (!target) throw new Error('Missing quote explanation binding');
    return {
      ...result,
      records: [
        {
          ...base,
          values: {
            ...base.values,
            [target]: JSON.stringify({
              ...quote,
              plan: { id: p.id, version: p.version, digest: quote.planDigest },
              source: {
                queryId: source.queryId,
                recordId: row.recordId,
                revision: row.revision,
                sourceRevision: evidence.sourceRevision,
                cursor: evidence.cursor,
                basis: evidence.basis,
              },
              release: evidence.release,
            }),
          },
        },
      ],
    };
  };
}
