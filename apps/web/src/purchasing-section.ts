/**
 * The purchasing workspace: how a purchase order is presented in the List and
 * Record archetypes.
 *
 * This file has three layers, and keeping them apart is the point:
 *
 *   1. **View models** (`PurchaseOrderSummary`, `PurchaseOrderLineView`, …) —
 *      plain data describing what the screen shows. No HTML, no gateway.
 *   2. **Loaders** (`loadPurchaseOrderDocument`, `loadPurchaseOrderWorklist`)
 *      — read through the semantic query gateway and build view models. Every
 *      read keeps the gateway's policy, field authorization, pinned release
 *      and legal-entity scope; nothing here touches storage.
 *   3. **Renderers** (`renderPurchaseOrder…`) — turn a view model into HTML by
 *      composing the primitives in `ui/primitives.ts`. They do no I/O.
 *
 * So a new FACT about an order is added in three small, obvious steps: a
 * property on the view model, one line in the loader that fills it, and one
 * entry in the `factList`/`columns` array that shows it.
 *
 * WHAT IS DERIVED HERE AND WHAT IS NOT. The order's lifecycle state is stored
 * and owned by the state machine in `packages/domain/src/purchasing`. Received
 * quantity is the `purchase_order_received` read model. Everything else on
 * these screens — line totals, the order total, receiving progress, "overdue"
 * — is arithmetic over those stored facts, computed per request and never
 * written back. There is no tax, freight, discount or approval step because
 * the purchasing module declares none; this file does not invent them.
 */
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
import { escapeHtml, shortIdentity } from './html.js';
import {
  calendarDaysBetween,
  formatAmount,
  formatDate,
  formatQuantity,
  formatUnitPrice,
  multiplyDecimal,
  parseDecimal,
  parseInstant,
  percentOf,
  ZERO,
  type ExactDecimal,
} from './ui/format.js';
import {
  actionMenu,
  dataTable,
  disclosure,
  emptyState,
  emptyValue,
  factList,
  labeledStatus,
  linkAction,
  metricStrip,
  notice,
  pageSection,
  pagination,
  progressMeter,
  recordHeading,
  searchBar,
  stackedCell,
  statusBadge,
  stepper,
  totalsList,
  type ActionMenuItem,
  type Html,
  type StatusRole,
  type Step,
  type TableColumn,
} from './ui/primitives.js';

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/** The states the purchasing state machine declares, plus a safe fallback. */
export type PurchaseOrderLifecycle =
  'cancelled' | 'closed' | 'draft' | 'released' | 'unknown';

/** Receiving progress, derived from ordered and received quantity. */
export type PurchaseOrderReceiving =
  'complete' | 'notApplicable' | 'notStarted' | 'partial';

export interface PurchaseOrderSummary {
  readonly archived: boolean;
  readonly currency: string;
  readonly expectedDate: Date | null;
  readonly lifecycle: PurchaseOrderLifecycle;
  readonly lineCount: number;
  readonly notes: string;
  readonly number: string;
  readonly orderDate: Date | null;
  readonly orderedQuantity: ExactDecimal;
  /** Whole days past the expected date while goods are still outstanding. */
  readonly overdueDays: number | null;
  readonly receivedQuantity: ExactDecimal;
  readonly receiving: PurchaseOrderReceiving;
  readonly recordId: string;
  readonly remainingQuantity: ExactDecimal;
  readonly revision: number;
  /** The stored supplier reference, exactly as entered on the order. */
  readonly supplier: string;
  /** The matching party's name, when the reference identifies one. */
  readonly supplierName: string | null;
  /** That party's number, shown beside its name. */
  readonly supplierNumber: string | null;
  /** Sum of priced lines; `null` when no line carries a unit price. */
  readonly total: ExactDecimal | null;
  /** Lines with no unit price, which the total therefore excludes. */
  readonly unpricedLineCount: number;
}

export interface PurchaseOrderLineView {
  /** The stored item reference, exactly as entered on the line. */
  readonly item: string;
  /** `SKU · name` of the matching catalog item, when one matches. */
  readonly itemLabel: string | null;
  readonly lineNumber: string;
  readonly lineTotal: ExactDecimal | null;
  readonly ordered: ExactDecimal;
  readonly received: ExactDecimal;
  readonly recordId: string;
  readonly remaining: ExactDecimal;
  readonly unitPrice: ExactDecimal | null;
}

/** Everything the purchase order Record page shows beyond generic fields. */
export interface PurchaseOrderDocument {
  readonly lines: readonly PurchaseOrderLineView[];
  readonly links: {
    readonly addLine: string;
    readonly allLines: string;
    readonly lineDetail: (lineRecordId: string) => string;
    readonly receipts: string;
    readonly receiveGoods: string;
  };
  /** Value of what has been received and what is still open, when priced. */
  readonly openValue: ExactDecimal | null;
  readonly receivedValue: ExactDecimal | null;
  readonly summary: PurchaseOrderSummary;
}

export interface PurchaseOrderWorklistRow {
  readonly detailHref: string;
  readonly receiveHref: string;
  readonly summary: PurchaseOrderSummary;
}

/** The purchase order List page: one row per order on the current page. */
export interface PurchaseOrderWorklist {
  readonly rows: readonly PurchaseOrderWorklistRow[];
}

/**
 * The parts of a list that belong to the shared List runtime rather than to
 * purchasing: paging, search and coverage. `component-registry.ts` computes
 * them exactly as it does for every other list and hands them over, so this
 * module decides the COLUMNS and the platform keeps deciding the MECHANICS.
 */
export interface ListFrame {
  readonly clearSearchHref?: string;
  /** `1–25 of 112`. */
  readonly coverageLabel: string;
  readonly newHref?: string;
  readonly nextHref?: string;
  readonly previousHref?: string;
  readonly search: string;
  readonly searchPreserved: readonly (readonly [string, string])[];
}

// ---------------------------------------------------------------------------
// Presentation vocabulary
// ---------------------------------------------------------------------------

/**
 * One place maps a lifecycle state to its words and its status role. Adding a
 * state to the machine means adding one entry here; an unmapped state falls
 * back to `unknown` and shows the stored value, never a wrong label.
 */
const LIFECYCLE_PRESENTATION: Readonly<
  Record<
    PurchaseOrderLifecycle,
    { readonly label: string; readonly role: StatusRole }
  >
> = Object.freeze({
  cancelled: { label: 'Cancelled', role: 'blocked' },
  closed: { label: 'Closed', role: 'success' },
  draft: { label: 'Draft', role: 'attention' },
  released: { label: 'Released', role: 'inProgress' },
  unknown: { label: 'Unknown state', role: 'neutral' },
});

const RECEIVING_PRESENTATION: Readonly<
  Record<
    PurchaseOrderReceiving,
    { readonly label: string; readonly role: StatusRole }
  >
> = Object.freeze({
  complete: { label: 'Fully received', role: 'success' },
  notApplicable: { label: 'Not applicable', role: 'neutral' },
  notStarted: { label: 'Awaiting receipt', role: 'attention' },
  partial: { label: 'Partially received', role: 'inProgress' },
});

const LIFECYCLE_STATES: readonly PurchaseOrderLifecycle[] = Object.freeze([
  'draft',
  'released',
  'closed',
  'cancelled',
]);

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface RelationLabelRequest {
  readonly fieldId: string;
  readonly queryId: string;
  readonly relationId: string;
}

/**
 * Reads EVERY record of one registered list query, page by page.
 *
 * A total computed from a partial enumeration is a wrong number that looks
 * right, so an enumeration that cannot be completed throws instead of
 * returning what it has. This is the same rule the receiving and fulfilment
 * sections apply.
 */
async function listEveryRecord(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  queryId: string,
  legalEntityId: string | null,
  relationLabels: readonly RelationLabelRequest[] = [],
): Promise<SemanticRecordDto[]> {
  const query = registeredSemanticQueryFromPinnedView(view, queryId);
  if (!query || query.queryType !== 'list')
    throw new Error(`Purchasing requires the list query ${queryId}`);
  if (legalEntityId !== null && !query.legalEntityScope)
    throw new Error(`Purchasing query ${queryId} lacks explicit scope`);
  const records: SemanticRecordDto[] = [];
  let cursor: string | null = null;
  do {
    const page: ReturnType<typeof requireSharedListResult<SemanticRecordDto>> =
      requireSharedListResult(
        await gateway.invoke(view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId,
          arguments: {
            includeArchived: false,
            ...(legalEntityId !== null && query.legalEntityScope
              ? { [query.legalEntityScope.operand.parameterId]: legalEntityId }
              : {}),
            list: {
              schemaVersion: SHARED_LIST_QUERY_VERSION,
              cursor,
              matchMode: 'substring',
              pageSize: query.maximumResultCount,
              search: '',
              sort: [],
              relationLabels: [...relationLabels],
            },
          },
        }),
      );
    records.push(...page.records);
    if (
      page.listCoverage.hasMore &&
      (page.records.length === 0 ||
        page.listCoverage.nextCursor === cursor ||
        records.length > 10000)
    )
      throw new Error(
        'Purchasing totals cannot be presented from a partial enumeration',
      );
    cursor = page.listCoverage.nextCursor;
  } while (cursor !== null);
  return records;
}

/** Order lines and received quantities for one legal entity. */
interface OrderLineFacts {
  /** Line records grouped by the record id of the order they belong to. */
  readonly linesByOrder: ReadonlyMap<string, readonly SemanticRecordDto[]>;
  /** Net received quantity keyed by order line record id. */
  readonly receivedByLine: ReadonlyMap<string, ExactDecimal>;
}

async function loadOrderLineFacts(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  namespace: string,
  legalEntityId: string,
): Promise<OrderLineFacts> {
  const lineOrderRelationId = `${namespace}:relation.purchase_order_line_order`;
  const receivedLineRelationId = `${namespace}:relation.purchase_order_received_order_line`;
  const lines = await listEveryRecord(
    view,
    gateway,
    `${namespace}:query.purchase_order_line_list`,
    legalEntityId,
    [
      {
        relationId: lineOrderRelationId,
        queryId: `${namespace}:query.purchase_order_list`,
        fieldId: `${namespace}:field.purchase_order_number`,
      },
    ],
  );
  const received = await listEveryRecord(
    view,
    gateway,
    `${namespace}:query.purchase_order_received_list`,
    legalEntityId,
    [
      {
        relationId: receivedLineRelationId,
        queryId: `${namespace}:query.purchase_order_line_list`,
        fieldId: `${namespace}:field.purchase_order_line_item_id`,
      },
    ],
  );
  const receivedByLine = new Map<string, ExactDecimal>();
  for (const row of received) {
    const lineId = row.relationLabels?.[receivedLineRelationId]?.recordId;
    const quantity = parseDecimal(
      row.values[
        `${namespace}:field.purchase_order_received_received_quantity`
      ],
    );
    if (!lineId || receivedByLine.has(lineId) || quantity === null)
      throw new Error(
        'Received projection attribution is missing or duplicated',
      );
    receivedByLine.set(lineId, quantity);
  }
  const linesByOrder = new Map<string, SemanticRecordDto[]>();
  for (const line of lines) {
    const orderId = line.relationLabels?.[lineOrderRelationId]?.recordId;
    if (!orderId) continue;
    const siblings = linesByOrder.get(orderId);
    if (siblings) siblings.push(line);
    else linesByOrder.set(orderId, [line]);
  }
  return { linesByOrder, receivedByLine };
}

/**
 * Display names for stored references.
 *
 * `supplier_party_id` and `item_id` are TEXT fields, not relations, so the
 * platform does not resolve them. This looks the stored text up against the
 * party and item masters and returns a name when it matches a record id (or,
 * for a supplier, a party number). It is cosmetic by construction: on any
 * failure, and for any reference that matches nothing, the screens show the
 * stored text unchanged.
 */
interface ReferenceNames {
  readonly itemLabel: (reference: string) => string | null;
  readonly supplier: (
    reference: string,
  ) => { readonly name: string; readonly number: string } | null;
}

async function loadReferenceNames(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  namespace: string,
): Promise<ReferenceNames> {
  const text = (record: SemanticRecordDto, local: string): string => {
    const value = record.values[`${namespace}:field.${local}`];
    return typeof value === 'string' ? value.trim() : '';
  };
  const every = async (queryLocal: string): Promise<SemanticRecordDto[]> => {
    try {
      return await listEveryRecord(
        view,
        gateway,
        `${namespace}:query.${queryLocal}`,
        null,
      );
    } catch {
      return [];
    }
  };
  const suppliers = new Map<string, { name: string; number: string }>();
  for (const party of await every('party_list')) {
    const name = text(party, 'party_name');
    if (name === '') continue;
    const number = text(party, 'party_number');
    suppliers.set(party.recordId, { name, number });
    if (number !== '' && !suppliers.has(number))
      suppliers.set(number, { name, number });
  }
  const items = new Map<string, string>();
  for (const item of await every('item_list')) {
    const label = [text(item, 'item_sku'), text(item, 'item_name')]
      .filter((part) => part !== '')
      .join(' · ');
    if (label !== '') items.set(item.recordId, label);
  }
  return {
    itemLabel: (reference) => items.get(reference) ?? null,
    supplier: (reference) => suppliers.get(reference) ?? null,
  };
}

function lifecycleOf(
  order: SemanticRecordDto,
  namespace: string,
): PurchaseOrderLifecycle {
  const value =
    order.values[
      `${namespace}:derived_state_field.machine.purchase_order_lifecycle`
    ];
  const prefix = `${namespace}:state.purchase_order_`;
  if (typeof value !== 'string' || !value.startsWith(prefix)) return 'unknown';
  const local = value.slice(prefix.length);
  return (LIFECYCLE_STATES as readonly string[]).includes(local)
    ? (local as PurchaseOrderLifecycle)
    : 'unknown';
}

function lineViews(
  namespace: string,
  lines: readonly SemanticRecordDto[],
  facts: OrderLineFacts,
  names: ReferenceNames,
): PurchaseOrderLineView[] {
  const value = (line: SemanticRecordDto, local: string) =>
    line.values[`${namespace}:field.purchase_order_line_${local}`];
  return lines
    .map((line) => {
      const ordered = parseDecimal(value(line, 'ordered_quantity'));
      if (ordered === null)
        throw new Error('Purchasing requires exact decimal quantities');
      const received = facts.receivedByLine.get(line.recordId) ?? ZERO;
      if (received < ZERO || received > ordered)
        throw new Error(
          'Receiving quantities disagree; reconcile before continuing',
        );
      const unitPrice = parseDecimal(value(line, 'unit_price'));
      const item = String(value(line, 'item_id') ?? '');
      return {
        item,
        itemLabel: names.itemLabel(item),
        lineNumber: String(value(line, 'line_number') ?? ''),
        lineTotal:
          unitPrice === null ? null : multiplyDecimal(ordered, unitPrice),
        ordered,
        received,
        recordId: line.recordId,
        remaining: ordered - received,
        unitPrice,
      };
    })
    .sort(
      (left, right) =>
        Number(left.lineNumber) - Number(right.lineNumber) ||
        left.recordId.localeCompare(right.recordId),
    );
}

function summarize(
  namespace: string,
  order: SemanticRecordDto,
  lines: readonly PurchaseOrderLineView[],
  names: ReferenceNames,
  now: Date,
): PurchaseOrderSummary {
  const text = (local: string): string => {
    const value = order.values[`${namespace}:field.purchase_order_${local}`];
    return typeof value === 'string' ? value : '';
  };
  const sum = (pick: (line: PurchaseOrderLineView) => ExactDecimal) =>
    lines.reduce((total, line) => total + pick(line), ZERO);
  const lifecycle = lifecycleOf(order, namespace);
  const orderedQuantity = sum((line) => line.ordered);
  const receivedQuantity = sum((line) => line.received);
  const remainingQuantity = orderedQuantity - receivedQuantity;
  const priced = lines.filter((line) => line.lineTotal !== null);
  const expectedDate = parseInstant(text('expected_date'));
  const receiving: PurchaseOrderReceiving =
    lifecycle === 'draft' ||
    lifecycle === 'cancelled' ||
    lifecycle === 'unknown' ||
    orderedQuantity === ZERO
      ? 'notApplicable'
      : receivedQuantity === ZERO
        ? 'notStarted'
        : remainingQuantity > ZERO
          ? 'partial'
          : 'complete';
  const daysLate =
    expectedDate === null ? 0 : calendarDaysBetween(expectedDate, now);
  const supplier = text('supplier_party_id');
  return {
    archived: order.archived,
    currency: text('currency'),
    expectedDate,
    lifecycle,
    lineCount: lines.length,
    notes: text('notes'),
    number: text('number') || shortIdentity(order.recordId),
    orderDate: parseInstant(text('order_date')),
    orderedQuantity,
    // Late only while it can still be received: a released order with goods
    // outstanding. A closed or cancelled order is not "late", it is finished.
    overdueDays:
      lifecycle === 'released' && remainingQuantity > ZERO && daysLate > 0
        ? daysLate
        : null,
    receivedQuantity,
    receiving,
    recordId: order.recordId,
    remainingQuantity,
    revision: order.revision,
    supplier,
    supplierName: names.supplier(supplier)?.name ?? null,
    supplierNumber: names.supplier(supplier)?.number || null,
    total:
      priced.length === 0
        ? null
        : priced.reduce((total, line) => total + line.lineTotal!, ZERO),
    unpricedLineCount: lines.length - priced.length,
  };
}

/** Builds `/?surface=…` links that carry the selected legal entity. */
function surfaceLinker(
  view: RequestRuntimeView,
  namespace: string,
  legalEntityId: string,
): (surfaceLocal: string, queryLocal: string, recordId?: string) => string {
  return (surfaceLocal, queryLocal, recordId) => {
    const scope = registeredSemanticQueryFromPinnedView(
      view,
      `${namespace}:query.${queryLocal}`,
    )?.legalEntityScope;
    if (!scope)
      throw new Error('Purchasing navigation requires explicit scope');
    const parameters = new URLSearchParams({
      surface: `${namespace}:surface.${surfaceLocal}`,
      [scope.operand.parameterId]: legalEntityId,
    });
    if (recordId) parameters.set('record', recordId);
    return `/?${parameters.toString()}`;
  };
}

/** Loads the purchase order Record page for one order. */
export async function loadPurchaseOrderDocument(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  order: SemanticRecordDto,
  legalEntityId: string,
  now: Date,
): Promise<PurchaseOrderDocument> {
  const namespace = order.entityId.split(':')[0]!;
  const facts = await loadOrderLineFacts(
    view,
    gateway,
    namespace,
    legalEntityId,
  );
  const names = await loadReferenceNames(view, gateway, namespace);
  const lines = lineViews(
    namespace,
    facts.linesByOrder.get(order.recordId) ?? [],
    facts,
    names,
  );
  const summary = summarize(namespace, order, lines, names, now);
  const link = surfaceLinker(view, namespace, legalEntityId);
  const valueOf = (pick: (line: PurchaseOrderLineView) => ExactDecimal) =>
    summary.total === null
      ? null
      : lines.reduce(
          (total, line) =>
            line.unitPrice === null
              ? total
              : total + multiplyDecimal(pick(line), line.unitPrice),
          ZERO,
        );
  return {
    lines,
    links: {
      addLine: link('purchase_order_line_form', 'purchase_order_line_get'),
      allLines: link('purchase_order_line_list', 'purchase_order_line_list'),
      lineDetail: (lineRecordId) =>
        link(
          'purchase_order_line_detail',
          'purchase_order_line_get',
          lineRecordId,
        ),
      receipts: link('goods_receipt_list', 'goods_receipt_list'),
      receiveGoods: link('goods_receipt_form', 'goods_receipt_get'),
    },
    openValue: valueOf((line) => line.remaining),
    receivedValue: valueOf((line) => line.received),
    summary,
  };
}

/** Loads the purchase order List page for the orders on the current page. */
export async function loadPurchaseOrderWorklist(
  view: RequestRuntimeView,
  gateway: SemanticQueryGateway,
  orders: readonly SemanticRecordDto[],
  legalEntityId: string,
  now: Date,
): Promise<PurchaseOrderWorklist> {
  const namespace = orders[0]?.entityId.split(':')[0];
  if (!namespace) return { rows: [] };
  const facts = await loadOrderLineFacts(
    view,
    gateway,
    namespace,
    legalEntityId,
  );
  const names = await loadReferenceNames(view, gateway, namespace);
  const link = surfaceLinker(view, namespace, legalEntityId);
  return {
    rows: orders.map((order) => ({
      detailHref: `${link('purchase_order_detail', 'purchase_order_get', order.recordId)}${order.archived ? '&archived=yes' : ''}`,
      receiveHref: link('goods_receipt_form', 'goods_receipt_get'),
      summary: summarize(
        namespace,
        order,
        lineViews(
          namespace,
          facts.linesByOrder.get(order.recordId) ?? [],
          facts,
          names,
        ),
        names,
        now,
      ),
    })),
  };
}

// ---------------------------------------------------------------------------
// Shared render helpers
// ---------------------------------------------------------------------------

function lifecycleBadge(summary: PurchaseOrderSummary): Html {
  return statusBadge({
    ...LIFECYCLE_PRESENTATION[summary.lifecycle],
    kind: 'lifecycle',
  });
}

function receivingBadge(summary: PurchaseOrderSummary): Html {
  return summary.receiving === 'notApplicable'
    ? emptyValue('Receiving does not apply yet')
    : statusBadge({
        ...RECEIVING_PRESENTATION[summary.receiving],
        kind: 'receiving',
      });
}

function dateHtml(instant: Date | null, missing: string): Html {
  return instant
    ? `<time datetime="${escapeHtml(instant.toISOString())}">${escapeHtml(formatDate(instant))}</time>`
    : emptyValue(missing);
}

function overdueText(days: number): string {
  return `${String(days)} day${days === 1 ? '' : 's'} overdue`;
}

function supplierHtml(summary: PurchaseOrderSummary): Html {
  if (summary.supplier === '') return emptyValue('No supplier recorded');
  return summary.supplierName
    ? stackedCell(
        `<span>${escapeHtml(summary.supplierName)}</span>`,
        summary.supplierNumber ?? undefined,
      )
    : escapeHtml(summary.supplier);
}

function amountHtml(value: ExactDecimal | null, currency: string): Html {
  return value === null
    ? emptyValue('No priced lines')
    : `<span class="ui-inline">${escapeHtml(formatAmount(value))}${currency ? ` <small class="muted">${escapeHtml(currency)}</small>` : ''}</span>`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Record page
// ---------------------------------------------------------------------------

/** `record:titleStatus` — which order this is and what state it is in. */
export function renderPurchaseOrderHeading(
  document: PurchaseOrderDocument,
): Html {
  const { summary } = document;
  return recordHeading({
    kicker: `Purchase order · Revision ${String(summary.revision)}`,
    statusHtml: [
      labeledStatus('Order', lifecycleBadge(summary)),
      labeledStatus('Receiving', receivingBadge(summary)),
      summary.archived
        ? labeledStatus(
            'Record',
            statusBadge({ label: 'Archived', role: 'attention' }),
          )
        : '',
    ].join(''),
    subtitle: summary.supplierName ?? summary.supplier,
    title: summary.number,
  });
}

function lifecycleSteps(summary: PurchaseOrderSummary): readonly Step[] {
  if (summary.lifecycle === 'cancelled') {
    return [
      { label: 'Draft', state: 'done' },
      { label: 'Cancelled', state: 'stopped' },
    ];
  }
  const order = ['draft', 'released', 'closed'] as const;
  const reached = order.indexOf(
    summary.lifecycle === 'unknown' ? 'draft' : summary.lifecycle,
  );
  return order.map((state, index) => ({
    label: LIFECYCLE_PRESENTATION[state].label,
    state:
      index < reached || (state === 'closed' && reached === 2)
        ? 'done'
        : index === reached
          ? 'current'
          : 'upcoming',
  }));
}

function summaryNotice(summary: PurchaseOrderSummary): Html {
  if (summary.overdueDays !== null) {
    return notice({
      attributes: { 'data-purchase-order-notice': 'overdue' },
      detail: `Expected ${summary.expectedDate ? formatDate(summary.expectedDate) : ''}; ${formatQuantity(summary.remainingQuantity)} still to receive.`,
      role: 'blocked',
      title: `${overdueText(summary.overdueDays)}.`,
    });
  }
  if (summary.lifecycle === 'draft' && summary.lineCount === 0) {
    return notice({
      attributes: { 'data-purchase-order-notice': 'no-lines' },
      detail: 'Add at least one line before releasing it to the supplier.',
      role: 'attention',
      title: 'This draft has no lines.',
    });
  }
  if (summary.lifecycle === 'cancelled') {
    return notice({
      attributes: { 'data-purchase-order-notice': 'cancelled' },
      detail:
        'A cancelled order cannot be reopened. Create a new order to reissue it.',
      role: 'blocked',
      title: 'This order is cancelled.',
    });
  }
  return '';
}

/** `record:keyFacts` — lifecycle, headline figures and the order's key facts. */
export function renderPurchaseOrderKeyFacts(
  document: PurchaseOrderDocument,
): Html {
  const { summary } = document;
  const percent = percentOf(summary.receivedQuantity, summary.orderedQuantity);
  return pageSection({
    attributes: {
      'data-data-state': 'exact',
      'data-purchase-order-summary': summary.lifecycle,
      'data-record-id': summary.recordId,
    },
    bodyHtml: [
      stepper('Order lifecycle', lifecycleSteps(summary)),
      summaryNotice(summary),
      metricStrip([
        {
          caption:
            summary.unpricedLineCount > 0
              ? `${plural(summary.unpricedLineCount, 'unpriced line')} excluded`
              : plural(summary.lineCount, 'line'),
          key: 'total',
          label: 'Order total',
          unit: summary.total === null ? '' : summary.currency,
          value: summary.total === null ? '—' : formatAmount(summary.total),
        },
        {
          key: 'ordered',
          label: 'Ordered',
          value: formatQuantity(summary.orderedQuantity),
        },
        {
          caption:
            summary.receiving === 'notApplicable'
              ? 'Not released for receiving'
              : `${String(percent)}% of ordered`,
          key: 'received',
          label: 'Received',
          value: formatQuantity(summary.receivedQuantity),
        },
        {
          key: 'remaining',
          label: 'Open to receive',
          value: formatQuantity(summary.remainingQuantity),
        },
      ]),
      `<div class="ui-section__body">${factList([
        {
          key: 'supplier',
          label: 'Supplier',
          valueHtml: supplierHtml(summary),
        },
        {
          key: 'orderDate',
          label: 'Order date',
          valueHtml: dateHtml(summary.orderDate, 'No order date'),
        },
        {
          key: 'expectedDate',
          label: 'Expected delivery',
          valueHtml: dateHtml(summary.expectedDate, 'No expected date'),
        },
        {
          key: 'currency',
          label: 'Currency',
          valueHtml: summary.currency
            ? escapeHtml(summary.currency)
            : emptyValue('No currency'),
        },
      ])}</div>`,
    ].join(''),
    density: 'flush',
  });
}

function lineColumns(
  document: PurchaseOrderDocument,
): readonly TableColumn<PurchaseOrderLineView>[] {
  const quantity = (
    key: 'ordered' | 'received' | 'remaining',
    label: string,
  ): TableColumn<PurchaseOrderLineView> => ({
    align: 'end',
    cell: (line) => escapeHtml(formatQuantity(line[key])),
    // The receiving journey reads these three cells by this attribute.
    cellAttributes: { 'data-quantity': key },
    key,
    label,
  });
  return [
    {
      align: 'end',
      cell: (line) => escapeHtml(line.lineNumber),
      key: 'line',
      label: '#',
    },
    {
      cell: (line) =>
        `<a class="record-link" href="${escapeHtml(document.links.lineDetail(line.recordId))}" data-item-id="${escapeHtml(line.item)}">${escapeHtml(line.itemLabel ?? line.item)}</a>`,
      key: 'item',
      label: 'Item',
    },
    quantity('ordered', 'Ordered'),
    quantity('received', 'Received'),
    quantity('remaining', 'Open'),
    {
      cell: (line) =>
        progressMeter({
          label: `${formatQuantity(line.received)} of ${formatQuantity(line.ordered)} received`,
          percent: percentOf(line.received, line.ordered),
          role:
            line.remaining === ZERO && line.ordered > ZERO
              ? 'success'
              : 'inProgress',
        }),
      hideLabel: true,
      key: 'progress',
      label: 'Receiving progress',
    },
    {
      align: 'end',
      cell: (line) =>
        line.unitPrice === null
          ? emptyValue('No unit price')
          : escapeHtml(formatUnitPrice(line.unitPrice)),
      key: 'unitPrice',
      label: 'Unit price',
    },
    {
      align: 'end',
      cell: (line) =>
        line.lineTotal === null
          ? emptyValue('No unit price')
          : escapeHtml(formatAmount(line.lineTotal)),
      key: 'lineTotal',
      label: 'Line total',
    },
  ];
}

const RECEIVING_GUIDANCE: readonly string[] = Object.freeze([
  'Receive against a released order. Close it only when every active line has nothing left to receive, and reopen it before receiving, correcting or amending a closed order.',
  'Corrections append compensating movements; they never edit the original receipt. If a correction would make historical stock negative, correct the erroneous outbound movement first, or use the stock-count process if the discrepancy is physical.',
  'To change an ordered quantity after release, open the line and request a quantity amendment.',
]);

/** `record:sections` — the lines, the money and the supplementary detail. */
export function renderPurchaseOrderSections(
  document: PurchaseOrderDocument,
): Html {
  const { lines, links, summary } = document;
  const canAddLines = summary.lifecycle === 'draft' && !summary.archived;
  const canReceive =
    summary.lifecycle === 'released' && summary.remainingQuantity > ZERO;
  const receivingStarted =
    summary.lifecycle === 'released' || summary.lifecycle === 'closed';
  const more: ActionMenuItem[] = [
    ...(receivingStarted
      ? [{ href: links.receipts, label: 'View receipts and corrections' }]
      : []),
    { href: links.allLines, label: 'Browse all order lines' },
  ];
  const totals = totalsList([
    ...(receivingStarted && summary.total !== null
      ? [
          {
            key: 'received',
            label: 'Received value',
            valueHtml: amountHtml(document.receivedValue, summary.currency),
          },
          {
            key: 'open',
            label: 'Open value',
            valueHtml: amountHtml(document.openValue, summary.currency),
          },
        ]
      : []),
    {
      emphasis: true,
      key: 'total',
      label: 'Order total',
      valueHtml: amountHtml(summary.total, summary.currency),
    },
  ]);
  return pageSection({
    actionsHtml: [
      canAddLines ? linkAction({ href: links.addLine, label: 'Add line' }) : '',
      canReceive
        ? linkAction({
            href: links.receiveGoods,
            label: 'Create goods receipt',
            variant: 'primary',
          })
        : '',
      // One destination is a link; a menu is for a real choice.
      more.length === 1
        ? linkAction(more[0]!)
        : actionMenu({
            describedAs: `More actions for order ${summary.number}`,
            items: more,
            label: 'More',
          }),
    ].join(''),
    attributes: { 'data-purchase-order-lines': String(lines.length) },
    bodyHtml: [
      dataTable({
        caption: `Lines of purchase order ${summary.number}`,
        columns: lineColumns(document),
        emptyHtml: emptyState({
          actionHtml: canAddLines
            ? linkAction({
                href: links.addLine,
                label: 'Add the first line',
                variant: 'primary',
              })
            : '',
          description: canAddLines
            ? 'Lines say what is being ordered and how much. An order needs at least one before it can be received.'
            : 'This order was recorded without any lines.',
          title: 'No order lines',
        }),
        rowAttributes: (line) => ({ 'data-order-line': line.recordId }),
        rows: lines,
      }),
      lines.length > 0 ? totals : '',
      disclosure({
        attributes: { 'data-purchase-order-notes': '' },
        bodyHtml:
          summary.notes === ''
            ? '<p class="muted">No notes were recorded on this order.</p>'
            : `<p class="ui-prose">${escapeHtml(summary.notes)}</p>`,
        ...(summary.notes === '' ? { hint: 'None' } : {}),
        open: summary.notes !== '',
        summary: 'Internal notes',
      }),
      disclosure({
        bodyHtml: RECEIVING_GUIDANCE.map(
          (paragraph) => `<p>${escapeHtml(paragraph)}</p>`,
        ).join(''),
        summary: 'How receiving and corrections work',
      }),
    ].join(''),
    density: 'flush',
    ...(lines.length === 0
      ? {}
      : {
          description: `${plural(lines.length, 'line')}${summary.currency ? ` · amounts in ${summary.currency}` : ''}`,
        }),
    title: 'Order lines',
  });
}

// ---------------------------------------------------------------------------
// List page
// ---------------------------------------------------------------------------

function worklistColumns(): readonly TableColumn<PurchaseOrderWorklistRow>[] {
  return [
    {
      cell: ({ detailHref, summary }) =>
        stackedCell(
          `<a class="record-link" href="${escapeHtml(detailHref)}" aria-label="Open Purchase order ${escapeHtml(summary.number)}">${escapeHtml(summary.number)}</a>`,
          summary.archived
            ? `Archived · rev ${String(summary.revision)}`
            : `Rev ${String(summary.revision)}`,
        ),
      key: 'number',
      label: 'Order',
    },
    {
      cell: ({ summary }) => supplierHtml(summary),
      key: 'supplier',
      label: 'Supplier',
    },
    {
      cell: ({ summary }) => lifecycleBadge(summary),
      key: 'lifecycle',
      label: 'Status',
    },
    {
      cell: ({ summary }) =>
        summary.receiving === 'notApplicable'
          ? receivingBadge(summary)
          : stackedCell(
              receivingBadge(summary),
              `${formatQuantity(summary.receivedQuantity)} of ${formatQuantity(summary.orderedQuantity)} received`,
            ),
      key: 'receiving',
      label: 'Receiving',
    },
    {
      cell: ({ summary }) => dateHtml(summary.orderDate, 'No order date'),
      key: 'orderDate',
      label: 'Ordered',
    },
    {
      cell: ({ summary }) =>
        summary.overdueDays === null
          ? dateHtml(summary.expectedDate, 'No expected date')
          : stackedCell(
              dateHtml(summary.expectedDate, 'No expected date'),
              overdueText(summary.overdueDays),
            ),
      cellAttributes: { 'data-expected': '' },
      key: 'expectedDate',
      label: 'Expected',
    },
    {
      align: 'end',
      cell: ({ summary }) => escapeHtml(String(summary.lineCount)),
      key: 'lines',
      label: 'Lines',
    },
    {
      align: 'end',
      cell: ({ summary }) => amountHtml(summary.total, summary.currency),
      key: 'total',
      label: 'Total',
    },
    {
      align: 'end',
      cell: ({ detailHref, receiveHref, summary }) =>
        summary.lifecycle === 'released' && summary.remainingQuantity > ZERO
          ? linkAction({
              attributes: { 'data-row-action': 'receive' },
              href: receiveHref,
              label: 'Receive',
              variant: 'quiet',
            })
          : linkAction({
              attributes: { 'data-row-action': 'open' },
              href: detailHref,
              label: 'Open',
              variant: 'quiet',
            }),
      hideLabel: true,
      key: 'action',
      label: 'Action',
    },
  ];
}

/** Counts of the visible orders by state, as a row of badges. */
function lifecycleBreakdown(worklist: PurchaseOrderWorklist): Html {
  return LIFECYCLE_STATES.map((state) => {
    const count = worklist.rows.filter(
      (row) => row.summary.lifecycle === state,
    ).length;
    return count === 0
      ? ''
      : statusBadge({
          kind: 'lifecycle-count',
          label: `${LIFECYCLE_PRESENTATION[state].label} ${String(count)}`,
          role: LIFECYCLE_PRESENTATION[state].role,
        });
  }).join('');
}

/** `list:dataGrid` — the purchase order worklist. */
export function renderPurchaseOrderWorklist(
  worklist: PurchaseOrderWorklist,
  frame: ListFrame,
): Html {
  const overdue = worklist.rows.filter(
    (row) => row.summary.overdueDays !== null,
  ).length;
  return pageSection({
    attributes: {
      'data-data-state': 'exact',
      'data-purchase-order-worklist': String(worklist.rows.length),
    },
    bodyHtml: [
      searchBar({
        ...(frame.clearSearchHref ? { clearHref: frame.clearSearchHref } : {}),
        label: 'Search purchase orders',
        placeholder: 'Order number, supplier or currency',
        preserved: frame.searchPreserved,
        trailingHtml: `<span data-list-coverage="${escapeHtml(frame.coverageLabel)}">${escapeHtml(frame.coverageLabel)}</span>${lifecycleBreakdown(worklist)}`,
        value: frame.search,
      }),
      overdue > 0
        ? notice({
            attributes: { 'data-purchase-order-notice': 'overdue' },
            detail:
              'Their expected delivery date has passed and goods are still outstanding.',
            role: 'blocked',
            title: `${plural(overdue, 'order')} on this page ${overdue === 1 ? 'is' : 'are'} overdue.`,
          })
        : '',
      dataTable({
        caption: 'Purchase orders',
        columns: worklistColumns(),
        emptyHtml:
          frame.search === ''
            ? emptyState({
                actionHtml: frame.newHref
                  ? linkAction({
                      href: frame.newHref,
                      label: 'New purchase order',
                      variant: 'primary',
                    })
                  : '',
                attributes: { 'data-list-zero-input': 'true' },
                description:
                  'Orders raised for this legal entity appear here with their status, receiving progress and value.',
                title: 'No purchase orders yet',
              })
            : emptyState({
                attributes: { 'data-list-zero-input': 'true' },
                description: `Nothing matches “${frame.search}”. Search looks at the order number, supplier and currency.`,
                title: 'No matching purchase orders',
              }),
        rowAttributes: ({ summary }) => ({
          'data-record-id': summary.recordId,
        }),
        rows: worklist.rows,
      }),
      pagination({
        ...(frame.nextHref ? { nextHref: frame.nextHref } : {}),
        ...(frame.previousHref ? { previousHref: frame.previousHref } : {}),
      }),
    ].join(''),
    density: 'flush',
  });
}
