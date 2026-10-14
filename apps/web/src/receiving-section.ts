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
import { escapeHtml } from './html.js';
import type { SurfaceRuntimeApplicationExtension } from './app-server.js';

export interface ReceivingSection {
  readonly namespace: string;
  readonly legalEntityId: string;
  readonly scopeParameterIds: Readonly<Record<string, string>>;
  readonly lines: readonly {
    readonly recordId: string;
    readonly item: string;
    readonly ordered: string;
    readonly received: string;
    readonly remaining: string;
  }[];
}
export interface ReceivingNavigation {
  readonly links: readonly { readonly label: string; readonly href: string }[];
  readonly guidance: string;
}

export function receivingNavigation(
  view: RequestRuntimeView,
  entityId: string,
  legalEntityId: string,
): ReceivingNavigation | undefined {
  const namespace = entityId.split(':')[0]!;
  const spec = entityId.endsWith(':entity.goods_receipt')
    ? {
        links: [
          [
            'goods_receipt_line_form',
            'goods_receipt_line_get',
            'Add receipt line',
          ],
          [
            'goods_receipt_line_list',
            'goods_receipt_line_list',
            'View receipt lines',
          ],
          // Where the product composes it, the Purchase orders List reads its
          // orders with their totals (ORDER-PARITY), under that query's own
          // company parameter; otherwise it reads its plain query.
          [
            'purchase_order_list',
            'commercial_purchase_order_list',
            'View order progress',
            'purchase_order_list',
          ],
        ],
        guidance:
          'Add lines linked to this receipt and the matching purchase order lines, then post this receipt. Enter actual received unit cost and currency, or explicitly choose absent. To correct, create a new correction or reversal receipt linked to the posted original and identify the compensated movement on each line. Reopen a closed order first.',
      }
    : entityId.endsWith(':entity.purchase_order_line')
      ? {
          links: [
            [
              'purchase_order_amendment_form',
              'purchase_order_amendment_get',
              'Request quantity amendment',
            ],
          ],
          guidance:
            'Create one amendment request for this line and its current revision, then return here and apply Amend. New ordered quantity cannot be below received quantity. A closed order must be reopened first.',
        }
      : undefined;
  if (!spec) return undefined;
  return {
    guidance: spec.guidance,
    // A link carries the company under the parameter of the query its surface
    // reads: the first one named that the release registers.
    links: spec.links.map(([surface, query, label, otherwise]) => {
      const definition =
        registeredSemanticQueryFromPinnedView(
          view,
          `${namespace}:query.${query}`,
        ) ??
        (otherwise
          ? registeredSemanticQueryFromPinnedView(
              view,
              `${namespace}:query.${otherwise}`,
            )
          : null);
      if (!definition?.legalEntityScope)
        throw new Error('Receiving link lacks registered scope');
      return {
        label: label!,
        href: `/?${new URLSearchParams({ surface: `${namespace}:surface.${surface}`, [definition.legalEntityScope.operand.parameterId]: legalEntityId })}`,
      };
    }),
  };
}
export function renderReceivingNavigation(
  navigation: ReceivingNavigation,
): string {
  return `<section class="panel data-panel" data-receiving-navigation><h2>Receiving actions</h2><p>${navigation.links.map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join(' · ')}</p><p>${escapeHtml(navigation.guidance)}</p></section>`;
}
const scale = 10n ** 18n;
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?\d+(\.\d{1,18})?$/u.test(value))
    throw new Error('Receiving requires exact decimal quantities');
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

/** Focused registered Record-section loader. All reads retain the semantic
 * gateway's current policy, field authorization, release and entity scope. */
export async function loadReceivingSection(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  order: SemanticRecordDto,
  legalEntityId: string,
): Promise<ReceivingSection> {
  const namespace = order.entityId.split(':')[0]!;
  async function all(
    local: string,
    relationLocal: string,
    targetLocal: string,
    labelField: string,
  ) {
    const queryId = `${namespace}:query.${local}_list`;
    const query = registeredSemanticQueryFromPinnedView(view, queryId);
    if (!query || query.queryType !== 'list' || !query.legalEntityScope)
      throw new Error('Receiving query lacks explicit scope');
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
                  relationId: `${namespace}:relation.${relationLocal}`,
                  queryId: `${namespace}:query.${targetLocal}_list`,
                  fieldId: `${namespace}:field.${labelField}`,
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
        throw new Error(
          'Receiving progress cannot be presented from a partial enumeration',
        );
      cursor = result.listCoverage.nextCursor;
    } while (cursor !== null);
    return records;
  }
  const lines = await all(
    'purchase_order_line',
    'purchase_order_line_order',
    'purchase_order',
    'purchase_order_number',
  );
  const progress = await all(
    'purchase_order_received',
    'purchase_order_received_order_line',
    'purchase_order_line',
    'purchase_order_line_item_id',
  );
  const quantities = new Map<string, bigint>();
  for (const row of progress) {
    const lineId =
      row.relationLabels?.[
        `${namespace}:relation.purchase_order_received_order_line`
      ]?.recordId;
    if (!lineId || quantities.has(lineId))
      throw new Error(
        'Received projection attribution is missing or duplicated',
      );
    quantities.set(
      lineId,
      quantity(
        row.values[
          `${namespace}:field.purchase_order_received_received_quantity`
        ],
      ),
    );
  }
  return {
    namespace,
    legalEntityId,
    scopeParameterIds: Object.fromEntries(
      [
        ['goods_receipt_form', 'goods_receipt_get'],
        ['goods_receipt_list', 'goods_receipt_list'],
        ['purchase_order_line_detail', 'purchase_order_line_get'],
      ].map(([surface, queryLocal]) => {
        const definition = registeredSemanticQueryFromPinnedView(
          view,
          `${namespace}:query.${queryLocal}`,
        );
        if (!definition?.legalEntityScope)
          throw new Error(
            'Receiving navigation requires explicit legal entity scope',
          );
        return [surface!, definition.legalEntityScope.operand.parameterId];
      }),
    ),
    lines: lines
      .filter(
        (line) =>
          line.relationLabels?.[
            `${namespace}:relation.purchase_order_line_order`
          ]?.recordId === order.recordId,
      )
      .map((line) => {
        const ordered = quantity(
          line.values[
            `${namespace}:field.purchase_order_line_ordered_quantity`
          ],
        );
        const received = quantities.get(line.recordId) ?? 0n;
        if (received < 0n || received > ordered)
          throw new Error(
            'Receiving quantities disagree; reconcile before continuing',
          );
        return {
          recordId: line.recordId,
          item: String(
            line.values[`${namespace}:field.purchase_order_line_item_id`],
          ),
          ordered: decimal(ordered),
          received: decimal(received),
          remaining: decimal(ordered - received),
        };
      }),
  };
}

export function renderReceivingSection(section: ReceivingSection): string {
  const link = (local: string, recordId?: string) => {
    const params = new URLSearchParams({
      surface: `${section.namespace}:surface.${local}`,
      [section.scopeParameterIds[local]!]: section.legalEntityId,
    });
    if (recordId) params.set('record', recordId);
    return escapeHtml(`/?${params}`);
  };
  return `<section class="panel data-panel" data-receiving-progress><h2>Receiving</h2><p><a href="${link('goods_receipt_form')}">Create goods receipt</a> · <a href="${link('goods_receipt_list')}">View receipts and corrections</a></p><p>Receive against a released order. Close only when every active line has zero remaining. Reopen before receiving, correcting or amending a closed order.</p><table><thead><tr><th>Order line</th><th>Ordered</th><th>Received</th><th>Remaining</th></tr></thead><tbody>${section.lines.map((line) => `<tr data-order-line="${escapeHtml(line.recordId)}"><td><a href="${link('purchase_order_line_detail', line.recordId)}">${escapeHtml(line.item)}</a></td><td>${escapeHtml(line.ordered)}</td><td>${escapeHtml(line.received)}</td><td>${escapeHtml(line.remaining)}</td></tr>`).join('')}</tbody></table>${section.lines.length === 0 ? '<p>No active order lines.</p>' : ''}<p>Corrections append compensating movements; they never edit the original receipt. If a correction would make historical stock negative, correct the erroneous outbound movement first, or use the stock-count process if the discrepancy is physical.</p></section>`;
}

/** Purchasing-specific selection, loading and refresh policy. The API
 * composition root installs this contribution explicitly; SurfaceRuntime stays
 * unaware of purchasing identities. */
export const RECEIVING_SURFACE_RUNTIME_EXTENSION = Object.freeze({
  async augmentRecordData({
    binding,
    data,
    legalEntitySelection,
    queryGateway,
    surface,
    surfaces,
    view,
  }) {
    if (
      surface.surfaceRole !== 'record' ||
      legalEntitySelection.length !== 1 ||
      !surfaces.some((candidate) =>
        candidate.surfaceId.endsWith(':surface.goods_receipt_detail'),
      )
    )
      return data;
    const legalEntityId = legalEntitySelection[0]!;
    const navigation = receivingNavigation(
      view,
      binding.query.sourceEntityId,
      legalEntityId,
    );
    const order = data.records[0];
    return {
      ...data,
      ...(navigation ? { receivingNavigation: navigation } : {}),
      ...(binding.query.sourceEntityId.endsWith(':entity.purchase_order') &&
      order
        ? {
            receiving: await loadReceivingSection(
              view,
              queryGateway,
              order,
              legalEntityId,
            ),
          }
        : {}),
    };
  },
  refreshAfterOperation({ binding, intent, surface, surfaces }) {
    return (
      intent === 'command' &&
      surface.surfaceRole === 'record' &&
      ['purchase_order', 'purchase_order_line', 'goods_receipt'].some(
        (entity) => binding.query.sourceEntityId.endsWith(`:entity.${entity}`),
      ) &&
      surfaces.some((candidate) =>
        candidate.surfaceId.endsWith(':surface.goods_receipt_detail'),
      )
    );
  },
} satisfies SurfaceRuntimeApplicationExtension);
