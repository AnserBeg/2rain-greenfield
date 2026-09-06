import type { RequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticQueryGateway,
  type SemanticRecordDto,
} from '../../../packages/runtime/src/semantic-query-gateway.js';
import {
  requireSharedListResult,
  SHARED_LIST_QUERY_VERSION,
} from '../../../packages/runtime/src/list-behavior/index.js';
import { RECEIVING_SURFACE_RUNTIME_EXTENSION } from './receiving-section.js';

export interface SalesOrderSection {
  readonly legalEntityId: string;
  readonly namespace: string;
  readonly scopeParameterIds: Readonly<Record<string, string>>;
  readonly lines: readonly {
    readonly item: string;
    readonly lineNumber: string;
    readonly quantity: string;
    readonly recordId: string;
    readonly unit: string;
    readonly unitPrice: string;
  }[];
}

/** All reads use the pinned semantic query and its explicit entity scope. */
export async function loadSalesOrderSection(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  order: SemanticRecordDto,
  legalEntityId: string,
): Promise<SalesOrderSection> {
  const namespace = order.entityId.split(':')[0]!;
  const queryId = `${namespace}:query.sales_order_line_list`;
  const query = registeredSemanticQueryFromPinnedView(view, queryId);
  if (!query || query.queryType !== 'list' || !query.legalEntityScope)
    throw new Error('Sales order line query lacks explicit scope');
  const records: SemanticRecordDto[] = [];
  let cursor: string | null = null;
  do {
    const result: ReturnType<
      typeof requireSharedListResult<SemanticRecordDto>
    > = requireSharedListResult(
      await gateway.invoke(view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId,
        arguments: {
          includeArchived: false,
          [query.legalEntityScope.operand.parameterId]: legalEntityId,
          list: {
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            cursor,
            matchMode: 'substring',
            pageSize: query.maximumResultCount,
            search: '',
            sort: [],
            relationLabels: [
              {
                relationId: `${namespace}:relation.sales_order_line_order`,
                queryId: `${namespace}:query.sales_order_list`,
                fieldId: `${namespace}:field.sales_order_number`,
              },
            ],
          },
        },
      }),
    );
    records.push(...result.records);
    if (
      result.listCoverage.hasMore &&
      (result.records.length === 0 ||
        result.listCoverage.nextCursor === cursor ||
        records.length > 10000)
    )
      throw new Error('Sales order lines cannot be shown from a partial list');
    cursor = result.listCoverage.nextCursor;
  } while (cursor !== null);

  const lineQuery = registeredSemanticQueryFromPinnedView(
    view,
    `${namespace}:query.sales_order_line_get`,
  );
  if (!lineQuery?.legalEntityScope)
    throw new Error('Sales order line navigation lacks explicit scope');

  return {
    legalEntityId,
    namespace,
    scopeParameterIds: {
      sales_order_line_detail: lineQuery.legalEntityScope.operand.parameterId,
      sales_order_line_form: lineQuery.legalEntityScope.operand.parameterId,
      sales_order_line_list: query.legalEntityScope.operand.parameterId,
    },
    lines: records
      .filter(
        (line) =>
          line.relationLabels?.[`${namespace}:relation.sales_order_line_order`]
            ?.recordId === order.recordId,
      )
      .map((line) => ({
        item: String(
          line.values[`${namespace}:field.sales_order_line_item_id`],
        ),
        lineNumber: String(
          line.values[`${namespace}:field.sales_order_line_line_number`],
        ),
        quantity: String(
          line.values[`${namespace}:field.sales_order_line_ordered_quantity`],
        ),
        recordId: line.recordId,
        unit: String(
          line.values[`${namespace}:field.sales_order_line_unit_id`],
        ),
        unitPrice:
          line.values[`${namespace}:field.sales_order_line_unit_price`] === null
            ? '—'
            : String(
                line.values[`${namespace}:field.sales_order_line_unit_price`],
              ),
      })),
  };
}

/** Product composition: retain Receiving and add only the Sales order section. */
export const COMPOSED_APPLICATION_SURFACE_RUNTIME_EXTENSION = Object.freeze({
  async augmentRecordData(
    context: Parameters<
      typeof RECEIVING_SURFACE_RUNTIME_EXTENSION.augmentRecordData
    >[0],
  ) {
    const received =
      await RECEIVING_SURFACE_RUNTIME_EXTENSION.augmentRecordData(context);
    if (
      context.surface.surfaceRole !== 'record' ||
      context.legalEntitySelection.length !== 1 ||
      !context.binding.query.sourceEntityId.endsWith(':entity.sales_order') ||
      !received.records[0]
    )
      return received;
    return {
      ...received,
      salesOrder: await loadSalesOrderSection(
        context.view,
        context.queryGateway,
        received.records[0],
        context.legalEntitySelection[0]!,
      ),
    };
  },
  refreshAfterOperation(
    context: Parameters<
      typeof RECEIVING_SURFACE_RUNTIME_EXTENSION.refreshAfterOperation
    >[0],
  ) {
    return (
      RECEIVING_SURFACE_RUNTIME_EXTENSION.refreshAfterOperation(context) ||
      (context.intent === 'command' &&
        context.surface.surfaceRole === 'record' &&
        context.binding.query.sourceEntityId.endsWith(':entity.sales_order'))
    );
  },
});
