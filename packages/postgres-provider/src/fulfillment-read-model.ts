import { FULFILLMENT_READ_MODEL_BINDINGS } from '../../domain/src/sales/workspace.js';
import { commercialLinkedFacts } from './commercial-link-read-model.js';
import {
  fulfillmentDecimal,
  fulfillmentProjectionIdentity,
  fulfillmentQuantity,
} from './fulfillment.js';
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
    parentScope?: { relationId: string; recordId: string },
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
            ...(parentScope ? { parentScope } : {}),
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
        parentScope &&
        (page.listCoverage.parentScope?.recordId !== parentScope.recordId ||
          page.listCoverage.parentScope.relationId !== parentScope.relationId)
      )
        throw new Error('Unapplied exact parent scope');
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
  /**
   * A line's own fulfillment: what its reservations still cover, what has
   * shipped (net of corrections, as the kernel keeps it) and what it orders.
   * Read once per line and shared by the page's rows and the shortage below.
   */
  const lineFigures = new Map<
    string,
    Promise<{
      covered: bigint;
      shipped: bigint;
      ordered: bigint;
      delivered: bigint | null;
    }>
  >();
  const isDropShip = (line: SemanticRecordDto) =>
    String(
      line.values[`${ns}:field.sales_order_line_fulfillment_route`],
    ).endsWith(':option.fulfillment_route_drop_ship');
  const deliveredOf = async (
    line: SemanticRecordDto,
  ): Promise<bigint | null> => {
    if (!model.queries.deliveries) return 0n;
    try {
      let delivered = 0n;
      for (const document of await list(
        'deliveries',
        {},
        {
          relationId: `${ns}:relation.drop_ship_delivery_sales_line`,
          recordId: line.recordId,
        },
      ))
        if (
          document.values[`${ns}:field.drop_ship_delivery_state`] ===
          `${ns}:option.drop_ship_delivery_state_posted`
        )
          delivered += fulfillmentQuantity(
            String(document.values[`${ns}:field.drop_ship_delivery_quantity`]),
          );
      return delivered;
    } catch (error) {
      if (error instanceof SemanticQueryPolicyDeniedError) return null;
      throw error;
    }
  };
  const figuresOf = (line: SemanticRecordDto) => {
    let known = lineFigures.get(line.recordId);
    if (!known) {
      known = (async () => {
        const ordered = fulfillmentQuantity(
          String(line.values[`${ns}:field.sales_order_line_ordered_quantity`]),
        );
        const delivered = await deliveredOf(line);
        if (isDropShip(line))
          return { covered: 0n, shipped: 0n, ordered, delivered };
        const reservations = await list(
          'reservations',
          {},
          {
            relationId: `${ns}:relation.reservation_order_line`,
            recordId: line.recordId,
          },
        );
        let covered = 0n;
        for (const reservation of reservations)
          covered += await remaining(reservation);
        const read = await invoke('shipped', {
          recordId: fulfillmentProjectionIdentity(
            view,
            scopeId,
            'shipped',
            line.recordId,
          ),
          includeArchived: false,
        });
        const shipped = read.records[0]
          ? fulfillmentQuantity(
              String(
                read.records[0].values[
                  `${ns}:field.sales_order_shipped_shipped_quantity`
                ],
              ),
            )
          : 0n;
        if (shipped < 0n || shipped > ordered || covered < 0n)
          throw new Error('Fulfillment projections require reconciliation');
        return { covered, shipped, ordered, delivered };
      })();
      lineFigures.set(line.recordId, known);
    }
    return known;
  };
  /**
   * Free stock of an item now: its posted on hand at every location of the
   * company less what every live reservation of it still holds (owner ruling
   * of 2026-09-30). Incoming purchase orders are not counted.
   */
  const freeStock = new Map<string, Promise<bigint>>();
  const freeOf = (item: string) => {
    let known = freeStock.get(item);
    if (!known) {
      known = (async () => {
        let onHand = 0n;
        for (const balance of await list('stock', {
          fieldFilters: [
            {
              fieldId: `${ns}:field.posted_stock_balance_item_id`,
              value: item,
            },
          ],
        }))
          onHand += fulfillmentQuantity(
            String(
              balance.values[
                `${ns}:field.posted_stock_balance_posted_quantity`
              ],
            ),
          );
        let reserved = 0n;
        for (const reservation of await list('stockReservations', {
          fieldFilters: [
            { fieldId: `${ns}:field.reservation_item_id`, value: item },
          ],
        }))
          reserved += await remaining(reservation);
        return onHand - reserved;
      })();
      freeStock.set(item, known);
    }
    return known;
  };
  /**
   * What each line of the listed order is short (ORDER-PARITY, owner ruling of
   * 2026-09-30): its open quantity its own reservations do not cover, beyond
   * the item's free stock now, allocated to the order's lines in line order --
   * so two lines of one item share its free stock. Stated only for the lines
   * of one order (the executor's echoed parent scope) and only while that
   * order is a draft or confirmed; another state has nothing short. Advisory:
   * reserving and shipping are admitted by the posting kernel alone. A read
   * current policy withholds states nothing, never a guessed shortage.
   */
  let shortage:
    | Promise<ReadonlyMap<string, { available: bigint; short: bigint }> | null>
    | undefined;
  const shortageOf = () =>
    (shortage ??= (async () => {
      const scope = result.listCoverage?.parentScope;
      if (
        !scope ||
        scope.relationId !== `${ns}:relation.sales_order_line_order`
      )
        return null;
      try {
        const order = await invoke('order', {
          recordId: scope.recordId,
          includeArchived: false,
        });
        const [header] = order.records;
        if (order.outcome !== 'exact' || !header) return null;
        const open = [
          `${ns}:state.sales_order_draft`,
          `${ns}:state.sales_order_released`,
        ].includes(
          String(
            header.values[
              `${ns}:derived_state_field.machine.sales_order_lifecycle`
            ],
          ),
        );
        const lineNumber = (line: SemanticRecordDto) =>
          BigInt(
            String(line.values[`${ns}:field.sales_order_line_line_number`]),
          );
        const lines = (
          await list('orderLines', {}, undefined, {
            relationId: scope.relationId,
            recordId: scope.recordId,
          })
        ).sort((left, right) => {
          const difference = lineNumber(left) - lineNumber(right);
          return difference < 0n
            ? -1
            : difference > 0n
              ? 1
              : left.recordId < right.recordId
                ? -1
                : 1;
        });
        const unallocated = new Map<string, bigint>();
        const figures = new Map<string, { available: bigint; short: bigint }>();
        for (const line of lines) {
          if (isDropShip(line)) {
            figures.set(line.recordId, { available: 0n, short: 0n });
            continue;
          }
          const item = String(
            line.values[`${ns}:field.sales_order_line_item_id`],
          );
          const available = await freeOf(item);
          let short = 0n;
          if (open) {
            const { covered, shipped, ordered } = await figuresOf(line);
            const uncovered = ordered - shipped - covered;
            if (uncovered > 0n) {
              const left =
                unallocated.get(item) ?? (available > 0n ? available : 0n);
              const allocated = uncovered < left ? uncovered : left;
              unallocated.set(item, left - allocated);
              short = uncovered - allocated;
            }
          }
          figures.set(line.recordId, { available, short });
        }
        return figures;
      } catch (error) {
        if (error instanceof SemanticQueryPolicyDeniedError) return null;
        throw error;
      }
    })());
  const rows: SemanticRecordDto[] = [];
  for (const row of result.records) {
    const values: Record<string, ImmutableJsonValue> = { ...row.values };
    const emit = (key: string, value: bigint | null) => {
      const field = model.resultFields[key];
      if (!field) throw new Error('Read-model output is undeclared');
      values[field] = value === null ? null : fulfillmentDecimal(value);
    };
    if (model.binding === FULFILLMENT_READ_MODEL_BINDINGS.line) {
      const { covered, shipped, ordered, delivered } = await figuresOf(row);
      emit('coverage', covered);
      emit('shipped', shipped);
      if (model.resultFields.delivered) emit('delivered', delivered);
      if (model.resultFields.route) {
        const links = await commercialLinkedFacts(row, ns, false, invoke);
        values[model.resultFields.route] = links.route;
        values[model.resultFields.linked_line!] = links.linkedLine;
        values[model.resultFields.linked_order!] = links.linkedOrder;
      }
      emit(
        'open_to_ship',
        delivered === null ? null : ordered - shipped - delivered,
      );
      // Declared only where a page states what the order is short.
      if (model.resultFields.short) {
        const own = (await shortageOf())?.get(row.recordId);
        emit('available_now', own ? own.available : null);
        emit('short', own ? own.short : null);
      }
    } else if (model.binding === FULFILLMENT_READ_MODEL_BINDINGS.reservation) {
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
