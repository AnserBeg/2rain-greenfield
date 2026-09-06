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
    readonly reservationCoverage: string;
    readonly netShipped: string;
    readonly openToShip: string;
    readonly recordId: string;
    readonly unit: string;
    readonly unitPrice: string;
  }[];
  readonly stock: readonly {
    readonly available: string;
    readonly item: string;
    readonly location: string;
    readonly onHand: string;
    readonly reserved: string;
  }[];
}

export interface ShipmentPackingDocument {
  readonly effectiveAt: string;
  readonly externalReference: string;
  readonly legalEntityId: string;
  readonly lines: readonly {
    readonly item: string;
    readonly lineNumber: string;
    readonly quantity: string;
    readonly unit: string;
  }[];
  readonly location: string;
  readonly namespace: string;
  readonly orderId: string;
  readonly shipmentNumber: string;
}

const scale = 10n ** 18n;
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?\d+(\.\d{1,18})?$/u.test(value))
    throw new Error('Fulfillment requires exact decimal quantities');
  const [whole, fraction = ''] = value.replace(/^-/u, '').split('.');
  return (
    (BigInt(whole!) * scale + BigInt(fraction.padEnd(18, '0'))) *
    (value.startsWith('-') ? -1n : 1n)
  );
}
function decimal(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  const fraction = (magnitude % scale)
    .toString()
    .padStart(18, '0')
    .replace(/0+$/u, '');
  return `${value < 0n ? '-' : ''}${magnitude / scale}${fraction ? `.${fraction}` : ''}`;
}

/** All reads use the pinned semantic query and its explicit entity scope. */
export async function loadSalesOrderSection(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  order: SemanticRecordDto,
  legalEntityId: string,
): Promise<SalesOrderSection> {
  const namespace = order.entityId.split(':')[0]!;
  async function all(
    local: string,
    relationLabels: readonly {
      readonly relationId: string;
      readonly queryId: string;
      readonly fieldId: string;
    }[] = [],
  ): Promise<SemanticRecordDto[]> {
    const registered = registeredSemanticQueryFromPinnedView(
      view,
      `${namespace}:query.${local}_list`,
    );
    if (!registered?.legalEntityScope || registered.queryType !== 'list')
      throw new Error(`Fulfillment ${local} query lacks explicit scope`);
    const allRecords: SemanticRecordDto[] = [];
    let next: string | null = null;
    do {
      const page: ReturnType<
        typeof requireSharedListResult<SemanticRecordDto>
      > = requireSharedListResult(
        await gateway.invoke(view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId: registered.queryId,
          arguments: {
            includeArchived: false,
            [registered.legalEntityScope.operand.parameterId]: legalEntityId,
            list: {
              schemaVersion: SHARED_LIST_QUERY_VERSION,
              cursor: next,
              matchMode: 'substring',
              pageSize: registered.maximumResultCount,
              search: '',
              sort: [],
              relationLabels,
            },
          },
        }),
      );
      allRecords.push(...page.records);
      if (
        page.listCoverage.hasMore &&
        (page.records.length === 0 ||
          page.listCoverage.nextCursor === next ||
          allRecords.length > 10000)
      )
        throw new Error('Fulfillment totals cannot use a partial list');
      next = page.listCoverage.nextCursor;
    } while (next !== null);
    return allRecords;
  }
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

  const reservations = await all('reservation', [
    {
      relationId: `${namespace}:relation.reservation_order_line`,
      queryId: `${namespace}:query.sales_order_line_list`,
      fieldId: `${namespace}:field.sales_order_line_item_id`,
    },
  ]);
  const reservationBalances = await all('reservation_balance', [
    {
      relationId: `${namespace}:relation.reservation_balance_reservation`,
      queryId: `${namespace}:query.reservation_list`,
      fieldId: `${namespace}:field.reservation_number`,
    },
  ]);
  const shipped = await all('sales_order_shipped', [
    {
      relationId: `${namespace}:relation.sales_order_shipped_order_line`,
      queryId: `${namespace}:query.sales_order_line_list`,
      fieldId: `${namespace}:field.sales_order_line_item_id`,
    },
  ]);
  const balances = await all('posted_stock_balance');
  const lineQuery = registeredSemanticQueryFromPinnedView(
    view,
    `${namespace}:query.sales_order_line_get`,
  );
  if (!lineQuery?.legalEntityScope)
    throw new Error('Sales order line navigation lacks explicit scope');
  const stockByIdentity = new Map<
    string,
    { readonly item: string; readonly location: string; reserved: bigint }
  >();
  for (const reservation of reservations) {
    const item = String(
      reservation.values[`${namespace}:field.reservation_item_id`],
    );
    const location = String(
      reservation.values[`${namespace}:field.reservation_location_id`],
    );
    const remaining = reservationBalances.find(
      (candidate) =>
        candidate.relationLabels?.[
          `${namespace}:relation.reservation_balance_reservation`
        ]?.recordId === reservation.recordId,
    );
    const key = `${item}\0${location}`;
    const stock = stockByIdentity.get(key) ?? { item, location, reserved: 0n };
    stock.reserved += remaining
      ? quantity(
          remaining.values[
            `${namespace}:field.reservation_balance_remaining_quantity`
          ],
        )
      : 0n;
    stockByIdentity.set(key, stock);
  }

  return {
    legalEntityId,
    namespace,
    scopeParameterIds: {
      sales_order_line_detail: lineQuery.legalEntityScope.operand.parameterId,
      sales_order_line_form: lineQuery.legalEntityScope.operand.parameterId,
      sales_order_line_list: query.legalEntityScope.operand.parameterId,
      reservation_form: registeredSemanticQueryFromPinnedView(
        view,
        `${namespace}:query.reservation_get`,
      )!.legalEntityScope!.operand.parameterId,
      reservation_list: registeredSemanticQueryFromPinnedView(
        view,
        `${namespace}:query.reservation_list`,
      )!.legalEntityScope!.operand.parameterId,
      shipment_form: registeredSemanticQueryFromPinnedView(
        view,
        `${namespace}:query.shipment_get`,
      )!.legalEntityScope!.operand.parameterId,
      shipment_list: registeredSemanticQueryFromPinnedView(
        view,
        `${namespace}:query.shipment_list`,
      )!.legalEntityScope!.operand.parameterId,
    },
    lines: records
      .filter(
        (line) =>
          line.relationLabels?.[`${namespace}:relation.sales_order_line_order`]
            ?.recordId === order.recordId,
      )
      .map((line) => {
        const ordered = quantity(
          line.values[`${namespace}:field.sales_order_line_ordered_quantity`],
        );
        const lineReservations = reservations.filter(
          (reservation) =>
            reservation.relationLabels?.[
              `${namespace}:relation.reservation_order_line`
            ]?.recordId === line.recordId,
        );
        const covered = lineReservations.reduce((sum, reservation) => {
          const balance = reservationBalances.find(
            (candidate) =>
              candidate.relationLabels?.[
                `${namespace}:relation.reservation_balance_reservation`
              ]?.recordId === reservation.recordId,
          );
          return (
            sum +
            (balance
              ? quantity(
                  balance.values[
                    `${namespace}:field.reservation_balance_remaining_quantity`
                  ],
                )
              : 0n)
          );
        }, 0n);
        const netShipped = shipped
          .filter(
            (progress) =>
              progress.relationLabels?.[
                `${namespace}:relation.sales_order_shipped_order_line`
              ]?.recordId === line.recordId,
          )
          .reduce(
            (sum, progress) =>
              sum +
              quantity(
                progress.values[
                  `${namespace}:field.sales_order_shipped_shipped_quantity`
                ],
              ),
            0n,
          );
        if (netShipped < 0n || netShipped > ordered || covered < 0n)
          throw new Error('Fulfillment projections require reconciliation');
        return {
          item: String(
            line.values[`${namespace}:field.sales_order_line_item_id`],
          ),
          lineNumber: String(
            line.values[`${namespace}:field.sales_order_line_line_number`],
          ),
          quantity: decimal(ordered),
          reservationCoverage: decimal(covered),
          netShipped: decimal(netShipped),
          openToShip: decimal(ordered - netShipped),
          recordId: line.recordId,
          unit: String(
            line.values[`${namespace}:field.sales_order_line_unit_id`],
          ),
          unitPrice:
            line.values[`${namespace}:field.sales_order_line_unit_price`] ===
            null
              ? '—'
              : String(
                  line.values[`${namespace}:field.sales_order_line_unit_price`],
                ),
        };
      }),
    stock: [...stockByIdentity.values()].map(({ item, location, reserved }) => {
      const onHand = balances
        .filter(
          (balance) =>
            balance.values[
              `${namespace}:field.posted_stock_balance_item_id`
            ] === item &&
            balance.values[
              `${namespace}:field.posted_stock_balance_location_id`
            ] === location,
        )
        .reduce(
          (sum, balance) =>
            sum +
            quantity(
              balance.values[
                `${namespace}:field.posted_stock_balance_posted_quantity`
              ],
            ),
          0n,
        );
      return {
        item,
        location,
        onHand: decimal(onHand),
        reserved: decimal(reserved),
        available: decimal(onHand - reserved),
      };
    }),
  };
}

async function loadShipmentPackingDocument(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  shipment: SemanticRecordDto,
  legalEntityId: string,
): Promise<ShipmentPackingDocument | undefined> {
  const namespace = shipment.entityId.split(':')[0]!;
  if (
    shipment.values[`${namespace}:field.shipment_state`] !==
    `${namespace}:option.shipment_state_posted`
  )
    return undefined;
  const query = registeredSemanticQueryFromPinnedView(
    view,
    `${namespace}:query.shipment_line_list`,
  );
  if (!query?.legalEntityScope || query.queryType !== 'list')
    throw new Error('Packing document line query lacks exact scope');
  const shipmentNumber = String(
    shipment.values[`${namespace}:field.shipment_number`],
  );
  const records: SemanticRecordDto[] = [];
  let cursor: string | null = null;
  do {
    // Relation labels participate in the registered list search. Shipment
    // number is a scoped business key, so this narrows retrieval to the parent
    // before pagination; the record-id comparison below remains authoritative
    // if another label merely contains the searched number.
    const result: ReturnType<
      typeof requireSharedListResult<SemanticRecordDto>
    > = requireSharedListResult(
      await gateway.invoke(view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: query.queryId,
        arguments: {
          includeArchived: false,
          [query.legalEntityScope.operand.parameterId]: legalEntityId,
          list: {
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            cursor,
            matchMode: 'substring',
            pageSize: query.maximumResultCount,
            search: shipmentNumber,
            sort: [],
            relationLabels: [
              {
                relationId: `${namespace}:relation.shipment_line_shipment`,
                queryId: `${namespace}:query.shipment_list`,
                fieldId: `${namespace}:field.shipment_number`,
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
      throw new Error('Packing document refuses incomplete parent pagination');
    cursor = result.listCoverage.nextCursor;
  } while (cursor !== null);
  return {
    namespace,
    legalEntityId,
    shipmentNumber,
    effectiveAt: String(
      shipment.values[`${namespace}:field.shipment_effective_at`],
    ),
    externalReference:
      shipment.values[`${namespace}:field.shipment_external_reference`] === null
        ? '—'
        : String(
            shipment.values[`${namespace}:field.shipment_external_reference`],
          ),
    location: String(
      shipment.values[`${namespace}:field.shipment_location_id`],
    ),
    orderId:
      shipment.relationLabels?.[`${namespace}:relation.shipment_order`]
        ?.recordId ?? '—',
    lines: records
      .filter(
        (line) =>
          line.relationLabels?.[`${namespace}:relation.shipment_line_shipment`]
            ?.recordId === shipment.recordId,
      )
      .map((line) => ({
        lineNumber: String(
          line.values[`${namespace}:field.shipment_line_line_number`],
        ),
        item: String(line.values[`${namespace}:field.shipment_line_item_id`]),
        quantity: String(
          line.values[`${namespace}:field.shipment_line_quantity`],
        ),
        unit: String(line.values[`${namespace}:field.shipment_line_unit_id`]),
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
      !received.records[0]
    )
      return received;
    if (context.binding.query.sourceEntityId.endsWith(':entity.shipment')) {
      const packingDocument = await loadShipmentPackingDocument(
        context.view,
        context.queryGateway,
        received.records[0],
        context.legalEntitySelection[0]!,
      );
      return {
        ...received,
        ...(packingDocument ? { packingDocument } : {}),
      };
    }
    if (!context.binding.query.sourceEntityId.endsWith(':entity.sales_order'))
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
        context.binding.query.sourceEntityId.endsWith(':entity.sales_order')) ||
      (context.intent === 'command' &&
        context.surface.surfaceRole === 'record' &&
        context.binding.query.sourceEntityId.endsWith(':entity.shipment'))
    );
  },
});
