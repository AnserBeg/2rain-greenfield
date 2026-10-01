import {
  VALUATION_ITEM_BINDING,
  VALUATION_SHIPMENT_BINDING,
  VALUATION_SHIPMENT_LINE_BINDING,
  VALUATION_INVOICE_BINDING,
} from '../../domain/src/inventory/valuation.js';
import { COMMERCIAL_READ_MODEL_BINDINGS } from '../../domain/src/sales/workspace.js';
import { commercialReadModel } from './commercial-read-model.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
  type SemanticQueryReadModelExecutor,
  type SemanticRecordDto,
} from '../../runtime/src/semantic-query-gateway.js';
import {
  requireSharedListResult,
  SHARED_LIST_QUERY_VERSION,
} from '../../runtime/src/list-behavior/index.js';
import type { ImmutableJsonValue } from '../../runtime/src/request-runtime-view.js';
import {
  itemCostFigures,
  replayInventoryValue,
  type CostMovement,
  type ReceiptCost,
} from './inventory-valuation.js';
import {
  deriveShipmentCosts,
  deriveInvoiceCosts,
  emptyRelief,
  relievedCostFigures,
  productMargin,
  shippedProductRevenue,
  type ShipmentCostSource,
  type OrderCostSource,
} from './inventory-shipment-cost.js';

type ModelContext = Parameters<SemanticQueryReadModelExecutor>[0];

/** Every input is an authorized plain dependency, never a table or a cached answer. */
function valuationReader({
  view,
  definition,
  arguments: args,
  gateway,
}: ModelContext) {
  const model = definition.readModel!;
  const ns = definition.sourceEntityId.split(':')[0]!;
  const scope = definition.legalEntityScope;
  if (!scope || !args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Valuation requires explicit company');
  const company = (args as Readonly<Record<string, ImmutableJsonValue>>)[
    scope.operand.parameterId
  ];
  if (typeof company !== 'string')
    throw new Error('Valuation company is not exact');
  const value = (row: SemanticRecordDto, local: string, key: string) =>
    row.values[`${ns}:field.${local}_${key}`];
  const text = (row: SemanticRecordDto, local: string, key: string) => {
    const answer = value(row, local, key);
    if (typeof answer !== 'string')
      throw new Error(`Valuation input is absent: ${local}.${key}`);
    return answer;
  };
  const listAll = async (
    key: string,
    relations: readonly (readonly [string, string, string])[] = [],
  ) => {
    const queryId = model.queries[key]?.targetId;
    const query = queryId
      ? registeredSemanticQueryFromPinnedView(view, queryId)
      : null;
    if (
      !query ||
      query.queryType !== 'list' ||
      query.readModel ||
      !query.legalEntityScope
    )
      throw new Error('Invalid valuation dependency');
    const rows: SemanticRecordDto[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: ReturnType<
        typeof requireSharedListResult<SemanticRecordDto>
      > = requireSharedListResult(
        await gateway.invoke(view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId: query.queryId,
          arguments: {
            includeArchived: false,
            [query.legalEntityScope.operand.parameterId]: company,
            list: {
              schemaVersion: SHARED_LIST_QUERY_VERSION,
              cursor,
              matchMode: 'substring',
              pageSize: 100,
              search: '',
              sort: [],
              relationLabels: relations.map(([relation, target, field]) => {
                const queryId = model.queries[target]?.targetId;
                if (!queryId)
                  throw new Error('Undeclared valuation relation target');
                return {
                  relationId: `${ns}:relation.${relation}`,
                  queryId,
                  fieldId: `${ns}:field.${field}`,
                };
              }),
            },
          },
        }),
      );
      rows.push(...page.records);
      cursor = page.listCoverage.nextCursor;
      if (
        page.listCoverage.hasMore !== (cursor !== null) ||
        (cursor !== null && (!page.records.length || cursors.has(cursor)))
      )
        throw new Error('Incomplete valuation history');
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    return rows;
  };
  const relation = (row: SemanticRecordDto, local: string) => {
    const answer = row.relationLabels?.[`${ns}:relation.${local}`]?.recordId;
    if (!answer) throw new Error(`Valuation relation is absent: ${local}`);
    return answer;
  };
  return { ns, value, text, listAll, relation };
}

async function valuationHistory(reader: ReturnType<typeof valuationReader>) {
  const { ns, value, text, listAll } = reader;
  const movements = await listAll('inventory_movement');
  const headers = new Map(
    (await listAll('goods_receipt')).map((row) => [row.recordId, row]),
  );
  const lines = new Map(
    (await listAll('goods_receipt_line')).map((row) => [row.recordId, row]),
  );
  const costs = new Map<string, ReceiptCost>();
  const history: CostMovement[] = movements.map((row) => {
    const m = (key: string) => text(row, 'inventory_movement', key);
    const sourceType = m('source_type');
    const sourceId = m('source_id');
    const sourceLine = m('source_line');
    if (sourceType === 'goodsReceipt') {
      const header = headers.get(sourceId);
      const line = lines.get(sourceLine);
      if (
        !header ||
        !line ||
        value(header, 'goods_receipt', 'state') !==
          `${ns}:option.goods_receipt_state_posted`
      )
        throw new Error('Posted receipt valuation source is missing');
      costs.set(JSON.stringify([sourceId, sourceLine]), {
        item: text(line, 'goods_receipt_line', 'item_id'),
        unit: text(line, 'goods_receipt_line', 'unit_id'),
        known:
          value(line, 'goods_receipt_line', 'cost_status') ===
          `${ns}:option.goods_receipt_line_cost_status_known`,
        unitCost:
          typeof value(line, 'goods_receipt_line', 'unit_cost') === 'string'
            ? String(value(line, 'goods_receipt_line', 'unit_cost'))
            : null,
        currency:
          typeof value(line, 'goods_receipt_line', 'currency') === 'string'
            ? String(value(line, 'goods_receipt_line', 'currency'))
            : null,
      });
    }
    const role = m('posting_role').split('inventory_posting_role_').at(-1)!;
    return {
      id: row.recordId,
      item: m('item_id'),
      unit: m('unit_id'),
      quantity: m('quantity_delta'),
      effectiveAt: m('effective_at'),
      recordedAt: m('recorded_at'),
      sourceType,
      sourceId,
      sourceLine,
      role,
      reversal:
        typeof value(row, 'inventory_movement', 'reversal_of_movement_id') ===
        'string'
          ? String(value(row, 'inventory_movement', 'reversal_of_movement_id'))
          : null,
    };
  });
  return { history, costs, replay: replayInventoryValue(history, costs) };
}

export const inventoryValuationReadModel: SemanticQueryReadModelExecutor =
  async (context) => {
    const { definition, result } = context;
    const model = definition.readModel!;
    const reader = valuationReader(context);
    const { ns, value, text, listAll, relation } = reader;
    const optionalText = (
      row: SemanticRecordDto,
      local: string,
      key: string,
    ) => {
      const answer = value(row, local, key);
      return typeof answer === 'string' ? answer : '';
    };
    const emit = (
      figures: (row: SemanticRecordDto) => Record<string, string | null>,
    ) => ({
      ...result,
      records: result.records.map((row) => {
        const stated = figures(row);
        const values = { ...row.values };
        for (const [key, output] of Object.entries(model.resultFields)) {
          if (Object.hasOwn(stated, key)) values[output] = stated[key]!;
          else if (model.binding !== COMMERCIAL_READ_MODEL_BINDINGS.order)
            throw new Error('Unknown valuation result');
        }
        return { ...row, values };
      }),
    });
    try {
      const { history, replay } = await valuationHistory(reader);
      if (model.binding === VALUATION_ITEM_BINDING)
        return emit((row) => itemCostFigures(replay.items.get(row.recordId)));
      if (
        ![
          VALUATION_SHIPMENT_BINDING,
          VALUATION_SHIPMENT_LINE_BINDING,
          VALUATION_INVOICE_BINDING,
          COMMERCIAL_READ_MODEL_BINDINGS.order,
        ].includes(model.binding)
      )
        throw new Error('Unknown valuation binding');
      const orderLines = new Map<string, OrderCostSource>();
      for (const row of await listAll('sales_order_line', [
        ['sales_order_line_order', 'sales_order', 'sales_order_number'],
      ]))
        orderLines.set(row.recordId, {
          order:
            row.relationLabels?.[`${ns}:relation.sales_order_line_order`]
              ?.recordId ?? '',
          item: optionalText(row, 'sales_order_line', 'item_id'),
          unit: optionalText(row, 'sales_order_line', 'unit_id'),
          unitPrice: value(row, 'sales_order_line', 'unit_price'),
          discountPercent: value(row, 'sales_order_line', 'discount_percent'),
        });
      const shipments = new Map(
        (
          await listAll('shipment', [
            ['shipment_order', 'sales_order', 'sales_order_number'],
          ])
        ).map((row) => [row.recordId, row]),
      );
      const sources = new Map<string, ShipmentCostSource>();
      const postedLineIds = new Set(
        history
          .filter((movement) => movement.sourceType === 'shipment')
          .map((movement) => movement.sourceLine),
      );
      for (const row of await listAll('shipment_line', [
        ['shipment_line_shipment', 'shipment', 'shipment_number'],
        [
          'shipment_line_order_line',
          'sales_order_line',
          'sales_order_line_line_number',
        ],
      ])) {
        if (!postedLineIds.has(row.recordId)) continue;
        const shipment = relation(row, 'shipment_line_shipment');
        const orderLine = relation(row, 'shipment_line_order_line');
        const header = shipments.get(shipment);
        if (
          !header ||
          relation(header, 'shipment_order') !==
            orderLines.get(orderLine)?.order
        )
          throw new Error('Shipment order cost lineage is incomplete');
        sources.set(row.recordId, {
          shipment,
          orderLine,
          item: optionalText(row, 'shipment_line', 'item_id'),
          unit: optionalText(row, 'shipment_line', 'unit_id'),
          posted:
            value(header, 'shipment', 'state') ===
            `${ns}:option.shipment_state_posted`,
        });
      }
      const costs = deriveShipmentCosts(history, replay, sources, orderLines);
      if (model.binding === VALUATION_SHIPMENT_LINE_BINDING)
        return emit((row) => {
          const cost = costs.shipmentLines.get(row.recordId);
          return cost
            ? relievedCostFigures(cost)
            : {
                cost_of_goods: null,
                cost_unvalued_quantity: null,
                cost_coverage: 'Not posted',
              };
        });
      if (model.binding === VALUATION_SHIPMENT_BINDING)
        return emit((row) => {
          const cost = costs.shipments.get(row.recordId);
          return cost
            ? relievedCostFigures(cost)
            : {
                cost_of_goods: null,
                cost_unvalued_quantity: null,
                cost_coverage: 'Not posted',
              };
        });
      if (model.binding === COMMERCIAL_READ_MODEL_BINDINGS.order)
        return emit((row) => {
          const cost = costs.orders.get(row.recordId) ?? emptyRelief();
          return {
            ...relievedCostFigures(cost),
            product_margin: productMargin(
              cost,
              text(row, 'sales_order', 'currency'),
              shippedProductRevenue(row.recordId, orderLines, costs.orderLines),
            ),
          };
        });
      const invoices = await listAll('customer_invoice', [
        ['customer_invoice_order', 'sales_order', 'sales_order_number'],
      ]);
      const live = (row: SemanticRecordDto) =>
        ['open', 'partially_paid', 'paid'].some(
          (state) =>
            value(row, 'customer_invoice', 'state') ===
            `${ns}:option.customer_invoice_state_${state}`,
        );
      const invoiceById = new Map(invoices.map((row) => [row.recordId, row]));
      const billed = [];
      for (const row of await listAll('customer_invoice_line', [
        [
          'customer_invoice_line_invoice',
          'customer_invoice',
          'customer_invoice_number',
        ],
        [
          'customer_invoice_line_order_line',
          'sales_order_line',
          'sales_order_line_line_number',
        ],
      ])) {
        const invoice = relation(row, 'customer_invoice_line_invoice');
        const header = invoiceById.get(invoice);
        if (!header || !live(header)) continue;
        const orderLine = relation(row, 'customer_invoice_line_order_line');
        if (
          relation(header, 'customer_invoice_order') !==
          orderLines.get(orderLine)?.order
        )
          throw new Error('Invoice cost lineage is incomplete');
        billed.push({
          invoice,
          orderLine,
          quantity: text(row, 'customer_invoice_line', 'quantity'),
          amount: text(row, 'customer_invoice_line', 'amount'),
        });
      }
      const invoiceCosts = deriveInvoiceCosts(
        invoices.filter(live).map((row) => ({
          id: row.recordId,
          date: text(row, 'customer_invoice', 'invoice_date'),
          live: true,
        })),
        billed,
        costs.orderLines,
      );
      return emit((row) => {
        const derived = invoiceCosts.get(row.recordId);
        return derived
          ? {
              ...relievedCostFigures(derived.cost),
              ...(derived.coverage ? { cost_coverage: derived.coverage } : {}),
              product_margin: productMargin(
                derived.cost,
                text(row, 'customer_invoice', 'currency'),
                derived.revenue,
              ),
            }
          : {
              cost_of_goods: null,
              cost_unvalued_quantity: null,
              product_margin: null,
              cost_coverage: 'Not a live invoice',
            };
      });
    } catch (error) {
      if (
        !(error instanceof SemanticQueryPolicyDeniedError) ||
        model.binding === VALUATION_ITEM_BINDING
      )
        throw error;
      // Cost is supplementary on commercial documents: current denial withholds it,
      // while the document's own authorized stored facts remain readable.
      return emit(() => ({
        cost_of_goods: null,
        cost_unvalued_quantity: null,
        product_margin: null,
        cost_coverage: 'Withheld by current policy',
      }));
    }
  };

export const commercialReadModelWithInventoryCost: SemanticQueryReadModelExecutor =
  async (context) => {
    const result = await commercialReadModel(context);
    return context.definition.readModel!.resultFields.cost_of_goods
      ? inventoryValuationReadModel({ ...context, result })
      : result;
  };
