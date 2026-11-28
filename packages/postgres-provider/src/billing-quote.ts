import type { Pool } from 'pg';
import {
  BillingPlansSchema,
  type BillingPlan,
  BillingListAssignmentSchema,
  BILLING_INTERVAL_READER,
  BILLING_ARREARS_READER,
  BILLING_RULES_READER,
  BILLING_TIMING_READER,
  billingEvidenceQuery,
  hasBillingRules,
  hasBillingTiming,
  type BillingEvidenceQuery,
} from '../../canonical-model/src/billing.js';
import { serviceUseProvider } from '../../canonical-model/src/service-evidence.js';
import {
  BillingQuoteEvidenceSchema,
  type BillingQuoteEvidence,
} from '../../canonical-model/src/billing-evidence.js';
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
  type SemanticRecordDto,
} from '../../runtime/src/semantic-query-gateway.js';
import { serviceUseFence } from './service-use-fence.js';
import {
  dueArrearsCycle,
  reviewArrearsCharges,
} from '../../domain/src/billing/arrears.js';
import {
  withTrustedRequestRead,
  withTrustedRequestTransaction,
} from './request-context.js';

/** B7: the agreed band's commercial quantity is the record's own quantity
 * field (seats, desks, units) when the plan binds one, else 1. A missing or
 * non-numeric value is undefined, and the caller refuses; the evidence schema
 * then requires an exact nonnegative decimal. */
export function agreedQuantity(
  values: Readonly<Record<string, ImmutableJsonValue>>,
  quantityFieldId: string | undefined,
): string | undefined {
  if (quantityFieldId === undefined) return '1';
  const value = values[quantityFieldId];
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : undefined;
}

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
        (hasBillingTiming(p)
          ? BILLING_TIMING_READER
          : hasBillingRules(p)
            ? BILLING_RULES_READER
            : p.bindings.arrearsSource
              ? BILLING_ARREARS_READER
              : BILLING_INTERVAL_READER) ||
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
    const quantity = agreedQuantity(row.values, fields.quantityFieldId);
    // Both reads attest the same revision, company and commercial identity.
    if (
      typeof customerId !== 'string' ||
      !customerId ||
      currency !== p.currency ||
      base.values[fields.customerFieldId] !== customerId ||
      base.values[fields.currencyFieldId] !== currency ||
      typeof anchor !== 'string' ||
      (typeof end !== 'string' && !(b.arrearsSource && end === null)) ||
      quantity === undefined
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
          quantity,
          intervals: [{ id: row.recordId, revision, start: anchor, end }],
        },
      ],
      pauses: [],
      usage: [],
      tables: snapshot.tables,
      assignments,
      allocations: [],
    });
    const target = definition.readModel?.resultFields.explanation;
    if (!target) throw new Error('Missing quote explanation binding');
    const arrears = b.arrearsSource;
    if (arrears) {
      const review = await readArrearsCycle(
        pool,
        { view, gateway },
        plan,
        evidence,
        row,
        arrears,
      );
      return {
        ...result,
        records: [
          {
            ...base,
            values: { ...base.values, [target]: JSON.stringify(review) },
          },
        ],
      };
    }
    const quote = quoteBillingService(p, evidence);
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

async function readArrearsCycle(
  pool: Pool,
  {
    view,
    gateway,
  }: Pick<Parameters<SemanticQueryReadModelExecutor>[0], 'view' | 'gateway'>,
  plan: BillingPlan,
  evidence: BillingQuoteEvidence,
  row: SemanticRecordDto,
  arrears: NonNullable<NonNullable<BillingPlan['bindings']>['arrearsSource']>,
) {
  const evidenceQuery = billingEvidenceQuery(arrears);
  if (evidenceQuery)
    return readServiceUseArrearsCycle(
      pool,
      { view, gateway },
      plan,
      evidence,
      row,
      evidenceQuery,
    );
  // An agreed interval reviews its closed cycle and, for an advance fee, its
  // opened cycles (reviewArrearsCharges decides which are due).
  if (arrears.kind === 'periodMeter') {
    // A meter plan never bills in advance (refused at parse).
    const cycle = dueArrearsCycle(plan, evidence);
    if (!cycle) return { status: 'notDue' as const };
    const missing = [
      arrears.openingReadingFieldId,
      arrears.openingInstantFieldId,
      arrears.closingReadingFieldId,
      arrears.closingInstantFieldId,
    ].filter((field) => row.values[field] === null);
    if (missing.length)
      return { status: 'pendingReadings' as const, cycle, missing };
    const reading = (field: string) => {
      const v = row.values[field];
      if (typeof v !== 'string')
        throw new Error('Incomplete billing meter source');
      return v;
    };
    evidence.bands = [];
    evidence.basis = 'usageOnly';
    evidence.periodMeter = {
      streamId: arrears.streamId,
      unit: arrears.unit,
      opening: {
        at: reading(arrears.openingInstantFieldId),
        reading: reading(arrears.openingReadingFieldId),
      },
      closing: {
        at: reading(arrears.closingInstantFieldId),
        reading: reading(arrears.closingReadingFieldId),
      },
    };
  }
  return reviewArrearsCharges(plan, evidence);
}

async function readServiceUseArrearsCycle(
  pool: Pool,
  {
    view,
    gateway,
  }: Pick<Parameters<SemanticQueryReadModelExecutor>[0], 'view' | 'gateway'>,
  plan: BillingPlan,
  evidence: BillingQuoteEvidence,
  row: SemanticRecordDto,
  source: BillingEvidenceQuery,
) {
  if (Date.parse(evidence.asOf) <= Date.parse(evidence.anchor))
    return { status: 'notDue' as const };
  const found = registeredSemanticQueryFromPinnedView(view, source.queryId);
  const usage = found?.queryType === 'get' ? found : undefined;
  const provider = serviceUseProvider(usage?.readModel?.binding);
  const field = provider && usage?.readModel?.resultFields[provider.resultKey];
  const fence = provider && serviceUseFence(provider.binding);
  if (
    !usage ||
    !provider ||
    !field ||
    !fence ||
    usage.sourceEntityId !== row.entityId ||
    usage.legalEntityScope?.cardinality !== 'exactlyOne'
  )
    throw new Error('Billing requires scoped service-use evidence');
  const read = await gateway.invoke(view, {
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    queryId: usage.queryId,
    arguments: {
      recordId: row.recordId,
      [usage.legalEntityScope.operand.parameterId]: evidence.companyId,
      // Use is read through the review instant, so a hire kept past its
      // agreed end keeps earning cycles (ADR-0083, calculation v3).
      ...provider.window(evidence.anchor, evidence.asOf),
    },
  });
  const owner = read.records[0];
  if (
    read.outcome !== 'exact' ||
    read.records.length !== 1 ||
    owner?.recordId !== row.recordId ||
    owner.entityId !== row.entityId ||
    owner.archived ||
    owner.revision !== row.revision
  )
    throw new Error('Incomplete or stale service-use owner');
  const snapshot = provider.decode(owner.values[field]);
  const review = reviewArrearsCharges(plan, evidence, {
    snapshot,
    subjectId: source.subjectId,
    ...(source.earlyReturn && { earlyReturn: source.earlyReturn }),
    owner: {
      entityId: owner.entityId,
      recordId: owner.recordId,
      companyId: evidence.companyId,
    },
  });
  if (review.status !== 'due') return review;
  await withTrustedRequestTransaction(
    pool,
    trustedContextForRequestRuntimeView(view),
    (client) =>
      fence(client, view.release.releaseId, view.pointer.fence, [
        {
          queryId: usage.queryId,
          entityId: owner.entityId,
          recordId: owner.recordId,
          cursor: evidence.cursor,
        },
      ]),
  );
  return review;
}
