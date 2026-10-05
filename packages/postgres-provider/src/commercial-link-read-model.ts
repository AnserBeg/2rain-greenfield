import {
  SemanticQueryPolicyDeniedError,
  type SemanticRecordDto,
  type SemanticQueryResultEnvelope,
} from '../../runtime/src/semantic-query-gateway.js';
import type { ImmutableJsonValue } from '../../runtime/src/request-runtime-view.js';

/** Both commercial and fulfillment sections use the same governed link reads. */
export async function commercialLinkedFacts(
  row: SemanticRecordDto,
  namespace: string,
  purchase: boolean,
  invoke: (
    key: string,
    args: Record<string, ImmutableJsonValue>,
  ) => Promise<SemanticQueryResultEnvelope>,
) {
  const sourceRelation = `${namespace}:relation.${purchase ? 'purchase' : 'sales'}_order_line_${purchase ? 'sales_line' : 'purchase_line'}`;
  const otherRelation = `${namespace}:relation.${purchase ? 'sales' : 'purchase'}_order_line_order`;
  try {
    const own = await invoke('lineSource', {
      recordId: row.recordId,
      includeArchived: false,
      relationTargets: [sourceRelation],
    });
    const linkedLine =
      own.records[0]?.relationLabels?.[sourceRelation]?.recordId ?? null;
    const route = purchase
      ? linkedLine
        ? 'Drop ship'
        : 'Stock'
      : String(
            row.values[`${namespace}:field.sales_order_line_fulfillment_route`],
          ).endsWith(':option.fulfillment_route_drop_ship')
        ? 'Drop ship'
        : 'Stock';
    if (!linkedLine) return { linkedLine: null, linkedOrder: null, route };
    const partner = await invoke('linkedLine', {
      recordId: linkedLine,
      includeArchived: false,
      relationTargets: [otherRelation],
    });
    return {
      linkedLine,
      linkedOrder:
        partner.records[0]?.relationLabels?.[otherRelation]?.recordId ?? null,
      route,
    };
  } catch (error) {
    if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
    return { linkedLine: null, linkedOrder: null, route: null };
  }
}
