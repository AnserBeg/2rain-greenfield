import type { Pool } from 'pg';
import {
  BillingPlansSchema,
  BillingListAssignmentSchema,
  BILLING_READER,
} from '../../canonical-model/src/billing.js';
import { BillingQuoteEvidenceSchema } from '../../canonical-model/src/billing-evidence.js';
import { quoteBillingService } from '../../domain/src/billing/quote.js';
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
        BILLING_READER ||
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
    const text = row.values[b.evidenceFieldId];
    if (typeof text !== 'string' || Buffer.byteLength(text) > 1048576)
      throw new Error('Missing bounded billing evidence');
    const facts: unknown = JSON.parse(text);
    if (
      !facts ||
      typeof facts !== 'object' ||
      'tables' in facts ||
      'assignments' in facts ||
      'allocations' in facts
    )
      throw new Error(
        'Service facts cannot supply commercial terms or allocations',
      );
    const planDigest = compileRatePlan(p).digest;
    const customerId = 'customerId' in facts ? facts.customerId : null;
    const { tables, assignments } = await withTrustedRequestRead(
      pool,
      trustedContextForRequestRuntimeView(view),
      async (client) => {
        const inputs = await client.query<{
          assignments: unknown[];
          tables: unknown[];
        }>(
          `WITH assignments AS (
       SELECT list_id,body FROM platform.billing_list_assignments
        WHERE tenant_id=$1 AND environment_id=$2 AND company_id=$3 AND plan_digest=$4 AND customer_id=$5
        ORDER BY effective_from,revision_id LIMIT 129
     ), prices AS (
       SELECT body FROM platform.billing_rate_tables
        WHERE tenant_id=$1 AND environment_id=$2 AND company_id=$3 AND plan_digest=$4
          AND (selector->>'kind'='base' OR (selector->>'kind'='customer' AND selector->>'customerId'=$5)
            OR (selector->>'kind'='priceList' AND selector->>'listId' IN (SELECT list_id FROM assignments)))
        ORDER BY effective_from,version_id LIMIT 257
     ) SELECT ARRAY(SELECT body FROM assignments) AS assignments, ARRAY(SELECT body FROM prices) AS tables`,
          [view.tenantId, view.environmentId, company, planDigest, customerId],
        );
        const snapshot = inputs.rows[0]!;
        const assignments = snapshot.assignments.map((body) => {
          const a = BillingListAssignmentSchema.parse(body);
          if (a.customerId !== customerId)
            throw new Error('Assignment owner mismatch');
          return {
            listId: a.listId,
            revision: a.revision,
            priority: a.priority,
            effectiveFrom: a.effectiveFrom,
            ...(a.effectiveEnd ? { effectiveEnd: a.effectiveEnd } : {}),
          };
        });
        return { tables: snapshot.tables, assignments };
      },
    );
    const evidence = BillingQuoteEvidenceSchema.parse({
      ...facts,
      tables,
      assignments,
      allocations: [],
    });
    if (
      evidence.tenantId !== view.tenantId ||
      evidence.environmentId !== view.environmentId ||
      evidence.companyId !== company ||
      evidence.serviceId !== row.recordId ||
      evidence.sourceQueryId !== source.queryId ||
      evidence.release !== view.release.contentHash
    )
      throw new Error('Billing source and release scope disagree');
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
              algorithm: quote.algorithm,
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
              lines: quote.lines,
              terms: quote.terms,
              calendar: quote.calendar,
              coverage: quote.coverage,
              inputDigest: quote.inputDigest,
              resultDigest: quote.resultDigest,
            }),
          },
        },
      ],
    };
  };
}
