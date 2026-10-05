import { COMMERCIAL_READ_MODEL_BINDINGS } from '../../domain/src/sales/workspace.js';
import {
  chargeAmounts,
  formatCents,
  lineAmounts,
  parseExact,
  sameExact,
  threeWayMatch,
  type LineAmounts,
} from './commercial-amounts.js';
import { creditOutputs, readCreditPosition } from './credit-read-model.js';
import { fulfillmentProjectionIdentity } from './fulfillment.js';
import { receivedIdentity } from './goods-receipt.js';
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
 * Line amounts and order totals (owner ruling B, for sales and purchase
 * orders), from each line's and charge's own frozen figures; the order's lines are read through the declared
 * dependency query, re-entering current policy and scope. A figure that cannot
 * be stated -- an unpriced line, a discount outside 0-100%, a tax code without
 * a frozen rate -- is `null`, and so is every total it would feed: nothing is
 * guessed as zero.
 */
export const commercialReadModel: SemanticQueryReadModelExecutor = async ({
  view,
  definition,
  arguments: args,
  result,
  gateway,
}) => {
  const model = definition.readModel!;
  const ns = definition.sourceEntityId.split(':')[0]!;
  // A customer's credit (SALES-EXTRAS), on its own page: the customer is a
  // tenant-wide record, so its figures are read company by company.
  if (model.binding === COMMERCIAL_READ_MODEL_BINDINGS.customerCredit) {
    const rows: SemanticRecordDto[] = [];
    for (const row of result.records) {
      const values: Record<string, ImmutableJsonValue> = { ...row.values };
      const outputs = creditOutputs(
        await readCreditPosition({
          view,
          gateway,
          queries: model.queries,
          namespace: ns,
          party: row,
          currency: null,
        }),
      );
      for (const [key, value] of Object.entries(outputs)) {
        const target = model.resultFields[key];
        if (!target) throw new Error('Read-model output is undeclared');
        values[target] = value;
      }
      rows.push({ ...row, values });
    }
    return { ...result, records: rows };
  }
  const scope = definition.legalEntityScope;
  if (!scope || !args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Commercial read model requires explicit scope');
  const scopeId = (args as Readonly<Record<string, ImmutableJsonValue>>)[
    scope.operand.parameterId
  ];
  if (typeof scopeId !== 'string')
    throw new Error('Commercial scope is not exact');
  const field = (name: string) => `${ns}:field.${name}`;
  // A purchase order states the same figures from its own fields (ruling B
  // extended to purchasing); a sales order also has list prices and invoices.
  const purchase =
    model.binding === COMMERCIAL_READ_MODEL_BINDINGS.purchaseLine ||
    model.binding === COMMERCIAL_READ_MODEL_BINDINGS.purchaseOrder;
  const doc = purchase ? 'purchase_order' : 'sales_order';
  const invoke = async (
    key: string,
    arguments_: Record<string, ImmutableJsonValue>,
  ) => {
    const queryId = model.queries[key]?.targetId;
    const query = queryId
      ? registeredSemanticQueryFromPinnedView(view, queryId)
      : null;
    if (!query || query.queryType === 'aggregate' || query.readModel)
      throw new Error('Invalid commercial read-model dependency');
    return gateway.invoke(view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: query.queryId,
      arguments: {
        ...arguments_,
        ...(query.legalEntityScope
          ? { [query.legalEntityScope.operand.parameterId]: scopeId }
          : {}),
      },
    });
  };
  // The rate a line or charge is taxed at, frozen from its tax code when the
  // code was chosen. `undefined`: no code (untaxed); `null`: a code without a
  // frozen rate, which cannot be stated.
  const frozenRate = (
    taxCodeId: ImmutableJsonValue | undefined,
    rate: ImmutableJsonValue | undefined,
  ): string | null | undefined =>
    typeof taxCodeId !== 'string' || taxCodeId === ''
      ? undefined
      : typeof rate === 'string' && rate !== ''
        ? rate
        : null;
  const priced = (line: SemanticRecordDto): LineAmounts | null =>
    lineAmounts({
      quantity: line.values[field(`${doc}_line_ordered_quantity`)],
      unitPrice: line.values[field(`${doc}_line_unit_price`)],
      discountPercent: line.values[field(`${doc}_line_discount_percent`)],
      taxRatePercent: frozenRate(
        line.values[field(`${doc}_line_tax_code_id`)],
        line.values[field(`${doc}_line_tax_rate_percent`)],
      ),
    });
  /**
   * Every record a dependency lists under one exact scope: a parent scope for
   * an owned child relation, a reference scope for a reference relation. A
   * relation label names, for each record, the record a relation points at.
   */
  const listAll = async (
    key: string,
    relationId: string,
    recordId: string,
    kind: 'parentScope' | 'referenceScope' = 'parentScope',
    relationLabels: readonly {
      readonly relationId: string;
      readonly queryId: string;
      readonly fieldId: string;
    }[] = [],
  ) => {
    const records: SemanticRecordDto[] = [];
    const scope = { relationId, recordId };
    let cursor: string | null = null;
    do {
      const page: ReturnType<
        typeof requireSharedListResult<SemanticRecordDto>
      > = requireSharedListResult(
        await invoke(key, {
          includeArchived: false,
          list: {
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            cursor,
            matchMode: 'substring',
            pageSize: 100,
            search: '',
            sort: [],
            relationLabels: relationLabels.map((label) => ({ ...label })),
            [kind]: scope,
          },
        }),
      );
      const applied = page.listCoverage[kind];
      if (applied?.recordId !== recordId || applied.relationId !== relationId)
        throw new Error('Unapplied exact list scope');
      records.push(...page.records);
      if (
        page.listCoverage.hasMore &&
        (!page.records.length ||
          cursor === page.listCoverage.nextCursor ||
          records.length > 1000)
      )
        throw new Error('Incomplete commercial read model');
      cursor = page.listCoverage.nextCursor;
    } while (cursor !== null);
    return records;
  };
  const linesOf = (orderId: string) =>
    listAll('lines', `${ns}:relation.${doc}_line_order`, orderId);
  /**
   * An order's lines for its totals. On a List the totals are supplementary
   * (ORDER-PARITY, owner ruling of 2026-09-30): a withheld line read states no
   * totals rather than refusing the page, and one denial answers for every row
   * of the call, as a withheld received read does. A single order's read keeps
   * refusing -- its page is the document those lines make up.
   */
  let linesWithheld = false;
  const totalledLines = async (
    orderId: string,
  ): Promise<readonly SemanticRecordDto[] | null> => {
    if (linesWithheld) return null;
    try {
      return await linesOf(orderId);
    } catch (error) {
      if (
        definition.queryType !== 'list' ||
        !(error instanceof SemanticQueryPolicyDeniedError)
      )
        throw error;
      linesWithheld = true;
      return null;
    }
  };
  /** An exact quantity as units at scale 18, or `null`. */
  const units = (value: ImmutableJsonValue | undefined): bigint | null => {
    const parsed = parseExact(value);
    return parsed && parsed.scale <= 18
      ? parsed.units * 10n ** BigInt(18 - parsed.scale)
      : null;
  };
  const quantityText = (value: bigint) => {
    const scale = 10n ** 18n;
    const magnitude = value < 0n ? -value : value;
    const fraction = (magnitude % scale)
      .toString()
      .padStart(18, '0')
      .replace(/0+$/u, '');
    return `${value < 0n ? '-' : ''}${String(magnitude / scale)}${fraction ? `.${fraction}` : ''}`;
  };
  /**
   * What has arrived against a purchase line (PURCHASING-PARITY): the
   * receiving projection's received quantity, read under current policy.
   * Nothing received yet has no projection row and reads as zero; a withheld
   * or unanswered read states nothing, rather than a guessed zero. One denial
   * answers for every line of the call: the same principal, scope and
   * permission would be refused again.
   */
  let receivedWithheld = false;
  const receivedOf = async (
    line: SemanticRecordDto,
  ): Promise<bigint | null> => {
    if (receivedWithheld) return null;
    try {
      const read = await invoke('received', {
        recordId: receivedIdentity(view, scopeId, line.recordId),
        includeArchived: false,
      });
      const [record] = read.records;
      if (read.outcome === 'exact' && record)
        return units(
          record.values[field('purchase_order_received_received_quantity')],
        );
      return read.outcome === 'not-found' || read.outcome === 'exact'
        ? 0n
        : null;
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
      receivedWithheld = true;
      return null;
    }
  };
  /**
   * Progressed quantity not yet on a document that counts: what was shipped
   * and is not on a live invoice (ruling C), or what was received and is not
   * on a live bill. Each line counts only its own positive part, exactly as
   * the settlement capability posts it, so a task is offered only when a post
   * would settle something: a line settled above what it progressed (after a
   * correction) never hides another line's unsettled quantity. The capability
   * recomputes it per line under the order's lock; this is the offer, not the
   * rule.
   */
  const toSettle = async (
    orderId: string,
    lines: readonly SemanticRecordDto[],
    family: {
      /** What one order line progressed, or `null` when it cannot be stated. */
      readonly progressOf: (line: SemanticRecordDto) => Promise<bigint | null>;
      /** Dependency keys of the documents and of their lines. */
      readonly documents: string;
      readonly documentLines: string;
      /** The document entity's local id. */
      readonly document: string;
      readonly relations: {
        readonly order: string;
        readonly lineDocument: string;
        readonly lineOrderLine: string;
      };
    },
  ): Promise<string | null> => {
    const progressed = new Map<string, bigint>();
    for (const line of lines) {
      const quantity = await family.progressOf(line);
      if (quantity === null) return null;
      progressed.set(line.recordId, quantity);
    }
    const live = new Set(
      ['open', 'partially_paid', 'paid'].map(
        (state) => `${ns}:option.${family.document}_state_${state}`,
      ),
    );
    const lineQuery = model.queries.lines?.targetId;
    if (!lineQuery) throw new Error('Invalid commercial read-model dependency');
    const lineOrderLine = `${ns}:relation.${family.relations.lineOrderLine}`;
    const settled = new Map<string, bigint>();
    for (const document of await listAll(
      family.documents,
      `${ns}:relation.${family.relations.order}`,
      orderId,
      'referenceScope',
    )) {
      if (!live.has(String(document.values[field(`${family.document}_state`)])))
        continue;
      for (const line of await listAll(
        family.documentLines,
        `${ns}:relation.${family.relations.lineDocument}`,
        document.recordId,
        'parentScope',
        // Each document line names the order line it settles.
        [
          {
            relationId: lineOrderLine,
            queryId: lineQuery,
            fieldId: field(`${doc}_line_line_number`),
          },
        ],
      )) {
        const quantity = units(
          line.values[field(`${family.document}_line_quantity`)],
        );
        const orderLineId = line.relationLabels?.[lineOrderLine]?.recordId;
        if (quantity === null || !orderLineId) return null;
        settled.set(orderLineId, (settled.get(orderLineId) ?? 0n) + quantity);
      }
    }
    let open = 0n;
    for (const line of lines) {
      const remaining =
        (progressed.get(line.recordId) ?? 0n) -
        (settled.get(line.recordId) ?? 0n);
      if (remaining > 0n) open += remaining;
    }
    return quantityText(open);
  };
  /** Shipped quantity not yet on an invoice that counts (ruling C). */
  const toInvoice = (orderId: string, lines: readonly SemanticRecordDto[]) =>
    toSettle(orderId, lines, {
      progressOf: async (line) => {
        const read = await invoke('shipped', {
          recordId: fulfillmentProjectionIdentity(
            view,
            scopeId,
            'shipped',
            line.recordId,
          ),
          includeArchived: false,
        });
        return read.records[0]
          ? units(
              read.records[0].values[
                field('sales_order_shipped_shipped_quantity')
              ],
            )
          : 0n;
      },
      documents: 'invoices',
      documentLines: 'invoiceLines',
      document: 'customer_invoice',
      relations: {
        order: 'customer_invoice_order',
        lineDocument: 'customer_invoice_line_invoice',
        lineOrderLine: 'customer_invoice_line_order_line',
      },
    });
  /**
   * Received quantity not yet on a live vendor bill (PAYABLES), from the
   * receiving projection. A withheld read of what was received or billed
   * states nothing -- the order itself still reads -- rather than a guessed
   * zero.
   */
  const toBill = async (
    orderId: string,
    lines: readonly SemanticRecordDto[],
  ): Promise<string | null> => {
    try {
      return await toSettle(orderId, lines, {
        progressOf: receivedOf,
        documents: 'bills',
        documentLines: 'billLines',
        document: 'vendor_bill',
        relations: {
          order: 'vendor_bill_order',
          lineDocument: 'vendor_bill_line_bill',
          lineOrderLine: 'vendor_bill_line_order_line',
        },
      });
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
      return null;
    }
  };
  /**
   * What is billed against one purchase order line (PAYABLES, PY-G): its
   * lines on the order's live bills -- open, partially paid or paid; drafts
   * and void bills do not count -- found through the line's own reference,
   * each bill's state read once per call. A withheld bill read states nothing
   * for every line of the call, as a withheld received read does.
   */
  let billsWithheld = false;
  const billStates = new Map<string, Promise<string | null>>();
  const billStateOf = (billId: string) => {
    let state = billStates.get(billId);
    if (!state) {
      state = invoke('bill', { recordId: billId, includeArchived: false }).then(
        (read) =>
          read.outcome === 'exact' && read.records[0]
            ? String(read.records[0].values[field('vendor_bill_state')])
            : null,
      );
      billStates.set(billId, state);
    }
    return state;
  };
  const billedOf = async (line: SemanticRecordDto): Promise<bigint | null> => {
    if (billsWithheld) return null;
    const billsQuery = model.queries.bills?.targetId;
    if (!billsQuery)
      throw new Error('Invalid commercial read-model dependency');
    const lineBill = `${ns}:relation.vendor_bill_line_bill`;
    const live = new Set(
      ['open', 'partially_paid', 'paid'].map(
        (state) => `${ns}:option.vendor_bill_state_${state}`,
      ),
    );
    try {
      let billed = 0n;
      for (const billLine of await listAll(
        'billLines',
        `${ns}:relation.vendor_bill_line_order_line`,
        line.recordId,
        'referenceScope',
        // Each bill line names its bill.
        [
          {
            relationId: lineBill,
            queryId: billsQuery,
            fieldId: field('vendor_bill_number'),
          },
        ],
      )) {
        const billId = billLine.relationLabels?.[lineBill]?.recordId;
        const quantity = units(
          billLine.values[field('vendor_bill_line_quantity')],
        );
        if (!billId || quantity === null) return null;
        const state = await billStateOf(billId);
        if (state === null) return null;
        if (live.has(state)) billed += quantity;
      }
      return billed;
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
      billsWithheld = true;
      return null;
    }
  };
  const money = (cents: bigint | null) =>
    cents === null ? null : formatCents(cents);
  const rows: SemanticRecordDto[] = [];
  for (const row of result.records) {
    const values: Record<string, ImmutableJsonValue> = { ...row.values };
    const emit = (key: string, value: string | null) => {
      const target = model.resultFields[key];
      if (!target) throw new Error('Read-model output is undeclared');
      values[target] = value;
    };
    if (
      model.binding === COMMERCIAL_READ_MODEL_BINDINGS.line ||
      model.binding === COMMERCIAL_READ_MODEL_BINDINGS.purchaseLine
    ) {
      const amounts = priced(row);
      emit('line_amount', money(amounts?.amountCents ?? null));
      emit('line_tax', money(amounts?.taxCents ?? null));
      // What is still to arrive: ordered less received, when both are known.
      // A release whose purchase lines declare no progress states none.
      const received =
        purchase && model.resultFields.received ? await receivedOf(row) : null;
      if (purchase && model.resultFields.received) {
        const ordered = units(
          row.values[field('purchase_order_line_ordered_quantity')],
        );
        emit('received', received === null ? null : quantityText(received));
        emit(
          'open_to_receive',
          received === null || ordered === null
            ? null
            : quantityText(ordered - received),
        );
      }
      // The three-way match (PAYABLES, PY-G): ordered and received beside
      // what is billed, what is left to bill and how the two compare. Shown,
      // never enforced; declared only where payables are composed.
      if (purchase && model.resultFields.match_status) {
        const billed = await billedOf(row);
        const match = threeWayMatch(received, billed);
        emit('billed', billed === null ? null : quantityText(billed));
        emit(
          'to_bill',
          match.toBill === null ? null : quantityText(match.toBill),
        );
        emit('match_status', match.status);
      }
      // A unit price that differs from the list price it started from was
      // set by hand (ruling B); without a list price there is nothing to mark.
      // A price a price list set reads as that (SALES-EXTRAS). A purchase
      // line has no list price: its cost is always typed.
      if (!purchase) {
        const list = row.values[field('sales_order_line_list_price')];
        const unit = row.values[field('sales_order_line_unit_price')];
        const priceList = row.values[field('sales_order_line_price_list_id')];
        emit(
          'price_basis',
          list === null || list === undefined || list === ''
            ? null
            : sameExact(list, unit)
              ? typeof priceList === 'string' && priceList !== ''
                ? 'Price list'
                : 'List price'
              : 'Manual price',
        );
      }
    } else if (
      model.binding === COMMERCIAL_READ_MODEL_BINDINGS.order ||
      model.binding === COMMERCIAL_READ_MODEL_BINDINGS.purchaseOrder
    ) {
      const lines = await totalledLines(row.recordId);
      // Withheld lines state nothing, as an unpriced line does.
      let complete = lines !== null;
      let subtotal = 0n;
      let tax = 0n;
      for (const line of lines ?? []) {
        const amounts = priced(line);
        if (!amounts) complete = false;
        else {
          subtotal += amounts.amountCents;
          tax += amounts.taxCents;
        }
      }
      let charges = 0n;
      for (const charge of ['freight', 'other_fee'] as const) {
        const amounts = chargeAmounts(
          row.values[field(`${doc}_${charge}_amount`)],
          frozenRate(
            row.values[field(`${doc}_${charge}_tax_code_id`)],
            row.values[field(`${doc}_${charge}_tax_rate_percent`)],
          ),
        );
        if (!amounts) complete = false;
        else {
          charges += amounts.amountCents;
          tax += amounts.taxCents;
        }
      }
      emit('order_subtotal', complete ? money(subtotal) : null);
      emit('order_charges', complete ? money(charges) : null);
      emit('order_tax', complete ? money(tax) : null);
      emit('order_total', complete ? money(subtotal + charges + tax) : null);
      if (model.resultFields.order_to_invoice)
        emit(
          'order_to_invoice',
          lines === null ? null : await toInvoice(row.recordId, lines),
        );
      if (model.resultFields.order_to_bill)
        emit(
          'order_to_bill',
          lines === null ? null : await toBill(row.recordId, lines),
        );
      // The customer's credit in this order's currency (SALES-EXTRAS): what
      // it owes, what its confirmed orders will still invoice, and what its
      // limit leaves. A withheld customer read states none of it.
      if (model.resultFields.customer_credit_status) {
        let party: SemanticRecordDto | null = null;
        const customer = row.values[field('sales_order_customer_party_id')];
        if (typeof customer === 'string' && customer !== '')
          try {
            const read = await invoke('party', {
              recordId: customer,
              includeArchived: true,
            });
            party = read.outcome === 'exact' ? (read.records[0] ?? null) : null;
          } catch (error) {
            if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
          }
        const currency = row.values[field('sales_order_currency')];
        for (const [key, value] of Object.entries(
          creditOutputs(
            party
              ? await readCreditPosition({
                  view,
                  gateway,
                  queries: model.queries,
                  namespace: ns,
                  party,
                  currency:
                    typeof currency === 'string' && currency !== ''
                      ? currency
                      : null,
                })
              : null,
          ),
        ))
          emit(key, value);
      }
    } else throw new Error('Unknown commercial read-model binding');
    rows.push({ ...row, values });
  }
  return { ...result, records: rows };
};
