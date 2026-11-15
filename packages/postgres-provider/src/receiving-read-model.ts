import { RECEIVING_READ_MODEL_BINDINGS } from '../../domain/src/purchasing/workspace.js';
import { fulfillmentDecimal, fulfillmentQuantity } from './fulfillment.js';
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

/**
 * What each line of a posted receipt can still give back (ORDER-PARITY): the
 * inventory movement its posting wrote (source goodsReceipt, the receipt,
 * the line), what that movement still adds to stock once the compensations
 * posted against it are counted, the quantity that reverses exactly that,
 * and the line's order line. It reads only the declared movement and receipt
 * line lists, each under current policy and the page's company, and answers
 * only for the lines of one receipt (the executor's echoed parent scope).
 *
 * It is an offer, not the rule: the posting kernel's receipt compensation
 * check decides what a reversal may post. A withheld movement read states no
 * figure -- one denial answers for every line of the call -- so no reversal
 * is offered on a guess.
 */
export const receivingReadModel: SemanticQueryReadModelExecutor = async ({
  view,
  definition,
  arguments: args,
  result,
  gateway,
}) => {
  const model = definition.readModel!;
  if (model.binding !== RECEIVING_READ_MODEL_BINDINGS.receiptLine)
    throw new Error('Unknown receiving read-model binding');
  const ns = definition.sourceEntityId.split(':')[0]!;
  const scope = definition.legalEntityScope;
  if (!scope || !args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Receiving read model requires explicit scope');
  const scopeId = (args as Readonly<Record<string, ImmutableJsonValue>>)[
    scope.operand.parameterId
  ];
  if (typeof scopeId !== 'string')
    throw new Error('Receiving scope is not exact');
  const field = (name: string) => `${ns}:field.${name}`;
  const relation = (name: string) => `${ns}:relation.${name}`;
  const list = async (
    key: string,
    extra: Readonly<Record<string, ImmutableJsonValue>>,
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
      throw new Error('Invalid receiving read-model dependency');
    const records: SemanticRecordDto[] = [];
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
            [query.legalEntityScope.operand.parameterId]: scopeId,
            list: {
              relationLabels: [],
              ...extra,
              schemaVersion: SHARED_LIST_QUERY_VERSION,
              cursor,
              matchMode: 'substring',
              pageSize: 100,
              search: '',
              sort: [],
            },
          },
        }),
      );
      if (
        extra.fieldFilters &&
        JSON.stringify(page.listCoverage.fieldFilters) !==
          JSON.stringify(extra.fieldFilters)
      )
        throw new Error('Unapplied exact field filters');
      const parent = extra.parentScope as
        { relationId: string; recordId: string } | undefined;
      if (
        parent &&
        (page.listCoverage.parentScope?.recordId !== parent.recordId ||
          page.listCoverage.parentScope.relationId !== parent.relationId)
      )
        throw new Error('Unapplied exact parent scope');
      records.push(...page.records);
      if (
        page.listCoverage.hasMore &&
        (!page.records.length ||
          cursor === page.listCoverage.nextCursor ||
          records.length > 1000)
      )
        throw new Error('Incomplete receiving read model');
      cursor = page.listCoverage.nextCursor;
    } while (cursor !== null);
    return records;
  };
  const parent = result.listCoverage?.parentScope;
  const receiptId =
    parent && parent.relationId === relation('goods_receipt_line_receipt')
      ? parent.recordId
      : null;
  // Each line's order line, from one list of the receipt's lines that states
  // the relation's target under current policy.
  const orderLineRelation = relation('goods_receipt_line_order_line');
  let orderLines: ReadonlyMap<string, string | null> | null = null;
  if (receiptId && result.records.length) {
    try {
      orderLines = new Map(
        (
          await list('lines', {
            parentScope: {
              relationId: relation('goods_receipt_line_receipt'),
              recordId: receiptId,
            },
            relationLabels: [
              {
                relationId: orderLineRelation,
                queryId: `${ns}:query.purchase_order_line_list`,
                fieldId: field('purchase_order_line_line_number'),
              },
            ],
          })
        ).map((line) => [
          line.recordId,
          line.relationLabels?.[orderLineRelation]?.recordId ?? null,
        ]),
      );
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
    }
  }
  let movementsWithheld = false;
  /** What a line's movement still adds to stock, or `null` when not stated. */
  const reversibleOf = async (
    line: SemanticRecordDto,
  ): Promise<{ movement: string; reversible: bigint } | null> => {
    if (!receiptId || movementsWithheld) return null;
    try {
      const movements = await list('movements', {
        fieldFilters: [
          {
            fieldId: field('inventory_movement_source_type'),
            value: 'goodsReceipt',
          },
          { fieldId: field('inventory_movement_source_id'), value: receiptId },
          {
            fieldId: field('inventory_movement_source_line'),
            value: line.recordId,
          },
        ],
      });
      // A draft receipt has posted nothing yet; nothing can be reversed.
      if (!movements.length) return null;
      if (movements.length !== 1)
        throw new Error('Receipt line movements require reconciliation');
      const [movement] = movements;
      let reversible = fulfillmentQuantity(
        String(movement!.values[field('inventory_movement_quantity_delta')]),
      );
      for (const compensation of await list('movements', {
        fieldFilters: [
          {
            fieldId: field('inventory_movement_reversal_of_movement_id'),
            value: movement!.recordId,
          },
        ],
      }))
        reversible += fulfillmentQuantity(
          String(
            compensation.values[field('inventory_movement_quantity_delta')],
          ),
        );
      return { movement: movement!.recordId, reversible };
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
      movementsWithheld = true;
      return null;
    }
  };
  const rows: SemanticRecordDto[] = [];
  for (const row of result.records) {
    const values: Record<string, ImmutableJsonValue> = { ...row.values };
    const emit = (key: string, value: string | null) => {
      const target = model.resultFields[key];
      if (!target) throw new Error('Read-model output is undeclared');
      values[target] = value;
    };
    const figures = await reversibleOf(row);
    emit('movement', figures?.movement ?? null);
    emit('reversible', figures ? fulfillmentDecimal(figures.reversible) : null);
    emit(
      'reversal_quantity',
      figures ? fulfillmentDecimal(-figures.reversible) : null,
    );
    emit('order_line', orderLines?.get(row.recordId) ?? null);
    rows.push({ ...row, values });
  }
  return { ...result, records: rows };
};
