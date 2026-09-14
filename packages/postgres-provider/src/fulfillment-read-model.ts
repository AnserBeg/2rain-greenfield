import {
  fulfillmentDecimal,
  fulfillmentProjectionIdentity,
  fulfillmentQuantity,
} from './fulfillment.js';
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

/** Read model uses only declared dependency queries; each re-enters current policy and scope. */
export const fulfillmentReadModel: SemanticQueryReadModelExecutor = async ({
  view,
  definition,
  arguments: args,
  result,
  gateway,
}) => {
  const model = definition.readModel!;
  const ns = definition.sourceEntityId.split(':')[0]!;
  const scope = definition.legalEntityScope;
  if (!scope || !args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Fulfillment read model requires explicit scope');
  const scopeId = (args as Readonly<Record<string, ImmutableJsonValue>>)[
    scope.operand.parameterId
  ];
  if (typeof scopeId !== 'string')
    throw new Error('Fulfillment scope is not exact');
  const invoke = async (
    key: string,
    arguments_: Record<string, ImmutableJsonValue>,
  ) => {
    const queryId = model.queries[key]?.targetId;
    const query = queryId
      ? registeredSemanticQueryFromPinnedView(view, queryId)
      : null;
    if (
      !query ||
      query.queryType === 'aggregate' ||
      query.readModel ||
      !query.legalEntityScope
    )
      throw new Error('Invalid fulfillment read-model dependency');
    return gateway.invoke(view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: query.queryId,
      arguments: {
        ...arguments_,
        [query.legalEntityScope.operand.parameterId]: scopeId,
      },
    });
  };
  const list = async (
    key: string,
    extra: Record<string, ImmutableJsonValue> = {},
    referenceScope?: { relationId: string; recordId: string },
  ) => {
    const records: SemanticRecordDto[] = [];
    let cursor: string | null = null;
    do {
      const page: ReturnType<
        typeof requireSharedListResult<SemanticRecordDto>
      > = requireSharedListResult(
        await invoke(key, {
          includeArchived: false,
          list: {
            ...extra,
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            cursor,
            matchMode: 'substring',
            pageSize: 100,
            search: '',
            sort: [],
            relationLabels: [],
            ...(referenceScope ? { referenceScope } : {}),
          },
        }),
      );
      if (
        referenceScope &&
        (page.listCoverage.referenceScope?.recordId !==
          referenceScope.recordId ||
          page.listCoverage.referenceScope.relationId !==
            referenceScope.relationId)
      )
        throw new Error('Unapplied exact reference scope');
      if (
        extra.fieldFilters &&
        JSON.stringify(page.listCoverage.fieldFilters) !==
          JSON.stringify(extra.fieldFilters)
      )
        throw new Error('Unapplied exact field filters');
      records.push(...page.records);
      if (
        page.listCoverage.hasMore &&
        (!page.records.length ||
          cursor === page.listCoverage.nextCursor ||
          records.length > 1000)
      )
        throw new Error('Incomplete fulfillment read model');
      cursor = page.listCoverage.nextCursor;
    } while (cursor !== null);
    return records;
  };
  const remaining = async (reservation: SemanticRecordDto) => {
    const balanceId = fulfillmentProjectionIdentity(
      view,
      scopeId,
      'reservation',
      reservation.recordId,
    );
    const balance = await invoke('balances', {
      recordId: balanceId,
      includeArchived: false,
    });
    if (!balance.records[0]) {
      if (
        reservation.values[`${ns}:field.reservation_state`] !==
        `${ns}:option.reservation_state_draft`
      )
        throw new Error('Reservation projection is missing');
      return 0n;
    }
    return fulfillmentQuantity(
      String(
        balance.records[0].values[
          `${ns}:field.reservation_balance_remaining_quantity`
        ],
      ),
    );
  };
  const rows: SemanticRecordDto[] = [];
  for (const row of result.records) {
    const values: Record<string, ImmutableJsonValue> = { ...row.values };
    const emit = (key: string, value: bigint) => {
      const field = model.resultFields[key];
      if (!field) throw new Error('Read-model output is undeclared');
      values[field] = fulfillmentDecimal(value);
    };
    if (model.binding === 'northstar.sales:read_model.line') {
      const reservations = await list(
        'reservations',
        {},
        {
          relationId: `${ns}:relation.reservation_order_line`,
          recordId: row.recordId,
        },
      );
      let covered = 0n;
      for (const reservation of reservations)
        covered += await remaining(reservation);
      const shipped = await invoke('shipped', {
        recordId: fulfillmentProjectionIdentity(
          view,
          scopeId,
          'shipped',
          row.recordId,
        ),
        includeArchived: false,
      });
      const quantity = shipped.records[0]
        ? fulfillmentQuantity(
            String(
              shipped.records[0].values[
                `${ns}:field.sales_order_shipped_shipped_quantity`
              ],
            ),
          )
        : 0n;
      const ordered = fulfillmentQuantity(
        String(row.values[`${ns}:field.sales_order_line_ordered_quantity`]),
      );
      if (quantity < 0n || quantity > ordered || covered < 0n)
        throw new Error('Fulfillment projections require reconciliation');
      emit('coverage', covered);
      emit('shipped', quantity);
      emit('open_to_ship', ordered - quantity);
    } else if (model.binding === 'northstar.sales:read_model.reservation') {
      const item = row.values[`${ns}:field.reservation_item_id`]!;
      const location = row.values[`${ns}:field.reservation_location_id`]!;
      const reservations = await list('stockReservations', {
        fieldFilters: [
          { fieldId: `${ns}:field.reservation_item_id`, value: item },
          { fieldId: `${ns}:field.reservation_location_id`, value: location },
        ],
      });
      let reserved = 0n;
      for (const reservation of reservations)
        reserved += await remaining(reservation);
      const balances = await list('stock', {
        fieldFilters: [
          { fieldId: `${ns}:field.posted_stock_balance_item_id`, value: item },
          {
            fieldId: `${ns}:field.posted_stock_balance_location_id`,
            value: location,
          },
        ],
      });
      let onHand = 0n;
      for (const balance of balances)
        onHand += fulfillmentQuantity(
          String(
            balance.values[`${ns}:field.posted_stock_balance_posted_quantity`],
          ),
        );
      emit('remaining', await remaining(row));
      emit('on_hand', onHand);
      emit('reserved', reserved);
      emit('available', onHand - reserved);
    } else throw new Error('Unknown fulfillment read-model binding');
    rows.push({ ...row, values });
  }
  return { ...result, records: rows };
};
