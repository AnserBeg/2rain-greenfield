import { VALUATION_ITEM_BINDING } from '../../domain/src/inventory/valuation.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
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

/** Every input is an authorized plain dependency, never a table or a cached answer. */
export const inventoryValuationReadModel: SemanticQueryReadModelExecutor =
  async ({ view, definition, arguments: args, result, gateway }) => {
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
    const listAll = async (key: string) => {
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
                relationLabels: [],
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
            ? String(
                value(row, 'inventory_movement', 'reversal_of_movement_id'),
              )
            : null,
      };
    });
    const replay = replayInventoryValue(history, costs);
    if (model.binding !== VALUATION_ITEM_BINDING)
      throw new Error('Unknown valuation binding');
    return {
      ...result,
      records: result.records.map((row) => {
        const figures = itemCostFigures(replay.items.get(row.recordId));
        const values = { ...row.values };
        for (const [key, output] of Object.entries(model.resultFields)) {
          if (!Object.hasOwn(figures, key))
            throw new Error('Unknown valuation result');
          values[output] = figures[key]!;
        }
        return { ...row, values };
      }),
    };
  };
