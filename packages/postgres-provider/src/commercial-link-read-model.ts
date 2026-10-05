import {
  SemanticQueryPolicyDeniedError,
  type SemanticRecordDto,
  type SemanticQueryResultEnvelope,
} from '../../runtime/src/semantic-query-gateway.js';
import type { ImmutableJsonValue } from '../../runtime/src/request-runtime-view.js';
import { fulfillmentDecimal, fulfillmentQuantity } from './fulfillment.js';

/** Both commercial and fulfillment sections use the same governed link reads. */
export async function commercialLinkedFacts(
  row: SemanticRecordDto,
  namespace: string,
  purchase: boolean,
  invoke: (
    key: string,
    args: Record<string, ImmutableJsonValue>,
  ) => Promise<SemanticQueryResultEnvelope>,
  arrivalId?: (purchaseLineId: string) => string,
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
    const routeOf = (line: SemanticRecordDto | undefined) => {
      const route = String(
        line?.values[`${namespace}:field.sales_order_line_fulfillment_route`],
      );
      return route.endsWith(':option.fulfillment_route_drop_ship')
        ? 'Drop ship'
        : route.endsWith(':option.fulfillment_route_special_order')
          ? 'Special order'
          : 'Stock';
    };
    if (!linkedLine)
      return {
        linkedLine: null,
        linkedOrder: null,
        route: purchase ? 'Stock' : routeOf(row),
        arrived: '0',
      };
    const partner = await invoke('linkedLine', {
      recordId: linkedLine,
      includeArchived: false,
      relationTargets: [otherRelation],
    });
    const arrival = arrivalId
      ? await invoke('arrivals', {
          recordId: arrivalId(purchase ? row.recordId : linkedLine),
          includeArchived: false,
        })
      : null;
    return {
      linkedLine,
      linkedOrder:
        partner.records[0]?.relationLabels?.[otherRelation]?.recordId ?? null,
      route: routeOf(purchase ? partner.records[0] : row),
      arrived:
        arrival &&
        (arrival.outcome === 'exact' || arrival.outcome === 'not-found')
          ? fulfillmentDecimal(
              fulfillmentQuantity(
                String(
                  arrival.records[0]?.values[
                    `${namespace}:field.purchase_order_received_received_quantity`
                  ] ?? '0',
                ),
              ),
            )
          : null,
    };
  } catch (error) {
    if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
    return { linkedLine: null, linkedOrder: null, route: null, arrived: null };
  }
}
