import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  formatCents,
  parseExact,
  toCents,
} from '../../packages/postgres-provider/src/commercial-amounts.js';
import {
  fulfillmentBinding,
  fulfillmentColumn,
  fulfillmentTable,
  quoteFulfillmentIdentifier as q,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { InventoryPostingError } from '../../packages/postgres-provider/src/inventory-posting-error.js';
import { PAYABLES_SETTLEMENT_SPEC } from '../../packages/postgres-provider/src/payables-capability-executor.js';
import {
  progressByOrderLine,
  settlementBinding,
} from '../../packages/postgres-provider/src/settlement-capability-executor.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
  type SemanticRecordDto,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';

/** A stored exact decimal as money: `22.500000000000000000` -> `22.50`. */
function money(value: ImmutableJsonValue | undefined): string | null {
  const parsed = parseExact(value);
  return parsed ? formatCents(toCents(parsed.units, parsed.scale)) : null;
}

/** A stored exact quantity in its shortest form: `2.000...` -> `2`. */
function quantity(value: ImmutableJsonValue | undefined): string | null {
  const parsed = parseExact(value);
  if (!parsed) return null;
  const scale = 10n ** BigInt(parsed.scale);
  const fraction = (parsed.units % scale)
    .toString()
    .padStart(parsed.scale, '0')
    .replace(/0+$/u, '');
  return `${String(parsed.units / scale)}${fraction ? `.${fraction}` : ''}`;
}

function refusedWith(code: string) {
  return (error: unknown) =>
    error instanceof InventoryPostingError && error.code === code;
}

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

/** Purchase orders, their receipts and the payables documents over one fixture. */
function payablesKit(fixture: Fixture) {
  const value = (record: SemanticRecordDto, local: string, name: string) =>
    record.values[`${ns}:field.${local}_${name}`];
  const operate = async (
    operation: string,
    record: { recordId: string; revision: number },
  ) => {
    const result = await fixture.invoke(operation, {
      recordId: record.recordId,
      expectedRevision: record.revision,
    });
    assert.equal(result.outcome, 'succeeded', operation);
    return result.readBack!;
  };
  /** A purchase order at Net 30 with freight and a fee, released unless not. */
  const purchase = async (
    lines: readonly { quantity: string; cost: string | null }[],
    release = true,
  ) => {
    const header = await fixture.create('purchase_order', {
      supplier_party_id: fixture.customer,
      order_date: new Date().toISOString(),
      expected_date: null,
      currency: 'CAD',
      notes: null,
      payment_terms: `${ns}:option.purchase_order_payment_terms_net_30`,
      // Freight taxed at its frozen 5%; an untaxed other fee.
      freight_amount: '25',
      freight_tax_code_id: fixture.taxCode,
      freight_tax_rate_percent: '5',
      other_fee_amount: '10',
      other_fee_tax_code_id: null,
      other_fee_tax_rate_percent: null,
    });
    const created = [];
    for (const [index, line] of lines.entries())
      created.push(
        await fixture.create(
          'purchase_order_line',
          {
            line_number: String(index + 1),
            item_id: fixture.item,
            ordered_quantity: line.quantity,
            unit_price: line.cost,
            discount_percent: '10',
            tax_code_id: fixture.taxCode,
            tax_rate_percent: '5',
          },
          { order: header.recordId },
        ),
      );
    return {
      header: release
        ? await operate('purchase_order_release', header)
        : header,
      lines: created,
    };
  };
  /** A receipt of one order line, posted; a correction names the original. */
  const receive = async (
    orderId: string,
    orderLineId: string,
    received: string,
    correcting?: { receiptId: string; movementId: string },
  ) => {
    const header = await fixture.create(
      'goods_receipt',
      {
        state: `${ns}:option.goods_receipt_state_draft`,
        kind: `${ns}:option.goods_receipt_kind_${correcting ? 'correction' : 'initial'}`,
        effective_at: new Date().toISOString(),
        location_id: fixture.location,
        reason_code: correcting ? 'CORRECT' : 'RECEIVE',
        reason_narrative: correcting
          ? 'One unit was not received'
          : 'Payables proof',
      },
      {
        order: orderId,
        ...(correcting ? { supersedes: correcting.receiptId } : {}),
      },
    );
    await fixture.create(
      'goods_receipt_line',
      {
        line_number: '1',
        item_id: fixture.item,
        quantity: received,
        unit_id: 'EA',
        cost_status: `${ns}:option.goods_receipt_line_cost_status_absent`,
        unit_cost: null,
        currency: null,
        reversal_of_movement_id: correcting?.movementId ?? null,
      },
      { receipt: header.recordId, order_line: orderLineId },
    );
    return operate('goods_receipt_post', header);
  };
  const draftBill = (
    orderId: string,
    supplierInvoice: string | null = null,
    billDate = new Date().toISOString(),
  ) =>
    fixture.create(
      'vendor_bill',
      {
        state: `${ns}:option.vendor_bill_state_draft`,
        bill_date: billDate,
        supplier_invoice_number: supplierInvoice,
      },
      { order: orderId },
    );
  const bill = async (orderId: string, supplierInvoice: string | null = null) =>
    operate('vendor_bill_post', await draftBill(orderId, supplierInvoice));
  const settle = async (
    kind: 'payment' | 'credit',
    billId: string,
    amount: string,
  ) =>
    fixture.invoke(
      `vendor_${kind}_post`,
      await (async () => {
        const draft = await fixture.create(
          `vendor_${kind}`,
          kind === 'payment'
            ? {
                state: `${ns}:option.vendor_payment_state_draft`,
                payment_date: new Date().toISOString(),
                amount,
                method: `${ns}:option.vendor_payment_method_cheque`,
                reference: `CHQ-${randomUUID().slice(0, 8)}`,
              }
            : {
                state: `${ns}:option.vendor_credit_state_draft`,
                credit_date: new Date().toISOString(),
                amount,
                reason: 'Short-shipped carton',
              },
          { bill: billId },
        );
        return {
          recordId: draft.recordId,
          expectedRevision: draft.revision,
        };
      })(),
    );
  const query = async (
    local: string,
    arguments_: Record<string, ImmutableJsonValue>,
  ) =>
    fixture.app.runtime.entry.run({ headers: {} }, (view) => {
      const definition = registeredSemanticQueryFromPinnedView(
        view,
        `${ns}:query.${local}`,
      )!;
      return fixture.app.runtime.queryGateway.invoke(view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: definition.queryId,
        arguments: {
          ...arguments_,
          [definition.legalEntityScope!.operand.parameterId]: fixture.scope,
        },
      });
    });
  const reread = async (local: string, recordId: string) =>
    (await query(`${local}_get`, { recordId, includeArchived: false }))
      .records[0]!;
  /** What the order offers to bill (the commercial read model). */
  const toBill = async (orderId: string) =>
    (await reread('commercial_purchase_order', orderId)).values[
      `${ns}:metric.order_to_bill`
    ];
  /** The bill's lines, in line order. */
  const billLines = async (billId: string) =>
    (
      await query('vendor_bill_line_list', {
        includeArchived: false,
        list: {
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          cursor: null,
          matchMode: 'substring',
          pageSize: 100,
          search: '',
          sort: [],
          relationLabels: [],
          parentScope: {
            relationId: `${ns}:relation.vendor_bill_line_bill`,
            recordId: billId,
          },
        },
      })
    ).records.toSorted(
      (left, right) =>
        Number(value(left, 'vendor_bill_line', 'line_number')) -
        Number(value(right, 'vendor_bill_line', 'line_number')),
    );
  const figures = (record: SemanticRecordDto) =>
    Object.fromEntries(
      [
        'subtotal',
        'charges',
        'tax',
        'total',
        'paid_amount',
        'credited_amount',
        'balance',
      ].map((name) => [name, money(value(record, 'vendor_bill', name))]),
    );
  const state = (record: SemanticRecordDto, local: string) =>
    String(value(record, local, 'state')).split(`${local}_state_`)[1];
  /** The stock movement a posted receipt wrote, for a correction to name. */
  const movementOf = async (receiptId: string) => {
    const binding = fulfillmentBinding(await governedStorageTarget())!;
    const movement = await fixture.pool.query<{ record_id: string }>(
      `SELECT record_id::text FROM ${fulfillmentTable(binding.movement)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${q(binding.movement.legalEntity!.column)}=$3
          AND ${q(fulfillmentColumn(binding.movement, 'inventory_movement_source_id'))}=$4`,
      [
        fixture.app.runtime.identity.tenantId,
        fixture.app.runtime.identity.environmentId,
        fixture.scope,
        receiptId,
      ],
    );
    assert.equal(movement.rows.length, 1);
    return movement.rows[0]!.record_id;
  };
  /**
   * Each order line's three-way match as the purchase-line read model states
   * it on the order page (PY-G).
   */
  const matchOf = async (orderId: string) =>
    Object.fromEntries(
      (
        await query('commercial_purchase_order_lines', {
          includeArchived: false,
          list: {
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            cursor: null,
            matchMode: 'substring',
            pageSize: 100,
            search: '',
            sort: [],
            relationLabels: [],
            parentScope: {
              relationId: `${ns}:relation.purchase_order_line_order`,
              recordId: orderId,
            },
          },
        })
      ).records.map((line) => [
        line.recordId,
        {
          received: quantity(line.values[`${ns}:metric.received`]),
          billed: quantity(line.values[`${ns}:metric.billed`]),
          toBill: quantity(line.values[`${ns}:metric.to_bill`]),
          match: line.values[`${ns}:metric.match_status`] ?? null,
        },
      ]),
    );
  /**
   * The same match computed independently, straight from storage: what each
   * line's receiving projection holds, and its lines on bills that count
   * (open, partially paid, paid), compared by this test's own reading of
   * ruling PY-G.
   */
  const independentMatch = async (orderLineIds: readonly string[]) => {
    const target = await governedStorageTarget();
    const entity = (local: string) =>
      target.entities.find(
        (value) => value.entityId === `${ns}:entity.${local}`,
      )!;
    const col = (local: string, field: string) =>
      q(
        entity(local).columns.find(
          (column) => column.canonicalFieldId === `${ns}:field.${field}`,
        )!.physicalName,
      );
    const rel = (relationId: string) =>
      q(
        target.relations.find(
          (value) => value.relationId === `${ns}:relation.${relationId}`,
        )!.relationColumn.physicalName,
      );
    const table = (local: string) => fulfillmentTable(entity(local));
    const scope = [
      fixture.app.runtime.identity.tenantId,
      fixture.app.runtime.identity.environmentId,
      fixture.scope,
    ];
    const received = await fixture.pool.query<{ line: string; q: string }>(
      `SELECT ${rel('purchase_order_received_order_line')}::text AS line,
              sum(${col('purchase_order_received', 'purchase_order_received_received_quantity')})::text AS q
         FROM ${table('purchase_order_received')}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${q(entity('purchase_order_received').legalEntity!.column)}=$3
          AND archived_at IS NULL
          AND ${rel('purchase_order_received_order_line')} = ANY($4::uuid[])
        GROUP BY 1`,
      [...scope, orderLineIds],
    );
    const billed = await fixture.pool.query<{ line: string; q: string }>(
      `SELECT line.${rel('vendor_bill_line_order_line')}::text AS line,
              sum(line.${col('vendor_bill_line', 'vendor_bill_line_quantity')})::text AS q
         FROM ${table('vendor_bill_line')} line
         JOIN ${table('vendor_bill')} bill
           ON bill.tenant_id=line.tenant_id
          AND bill.environment_id=line.environment_id
          AND bill.record_id=line.${rel('vendor_bill_line_bill')}
        WHERE line.tenant_id=$1 AND line.environment_id=$2
          AND line.${q(entity('vendor_bill_line').legalEntity!.column)}=$3
          AND line.archived_at IS NULL
          AND bill.archived_at IS NULL
          AND bill.${col('vendor_bill', 'vendor_bill_state')} = ANY($5::text[])
          AND line.${rel('vendor_bill_line_order_line')} = ANY($4::uuid[])
        GROUP BY 1`,
      [
        ...scope,
        orderLineIds,
        ['open', 'partially_paid', 'paid'].map(
          (state) => `${ns}:option.vendor_bill_state_${state}`,
        ),
      ],
    );
    const exact = (value: string | undefined) =>
      Number(quantity(value ?? '0') ?? '0');
    return Object.fromEntries(
      orderLineIds.map((line) => {
        const r = exact(received.rows.find((row) => row.line === line)?.q);
        const b = exact(billed.rows.find((row) => row.line === line)?.q);
        return [
          line,
          {
            received: String(r),
            billed: String(b),
            toBill: String(Math.max(0, r - b)),
            match:
              b > r
                ? 'Billed above received'
                : r > b
                  ? 'Received, not billed'
                  : r === 0
                    ? 'Not received'
                    : 'Matched',
          },
        ];
      }),
    );
  };
  return {
    value,
    operate,
    purchase,
    receive,
    draftBill,
    bill,
    settle,
    query,
    reread,
    toBill,
    billLines,
    figures,
    state,
    movementOf,
    matchOf,
    independentMatch,
  };
}

test(
  'payables: bills take received, not yet billed quantities at frozen figures, dated when posted and due after the terms; a supplier invoice number is used once; payments and credits never exceed the balance; void only while unsettled',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const {
        value,
        operate,
        purchase,
        receive,
        draftBill,
        bill,
        settle,
        query,
        reread,
        toBill,
        billLines,
        figures,
        state,
      } = payablesKit(fixture);

      const a = await purchase([{ quantity: '3', cost: '12.5' }]);
      const [lineA] = a.lines;

      // Nothing is received yet, so there is nothing to bill (PY-B).
      await assert.rejects(
        bill(a.header.recordId),
        refusedWith('PAYABLES_NOTHING_TO_BILL'),
      );
      assert.equal(await toBill(a.header.recordId), '0');
      await receive(a.header.recordId, lineA!.recordId, '2');
      assert.equal(await toBill(a.header.recordId), '2');

      // 2 × 12.50 less 10% = 22.50, tax 1.125 → 1.13; the order's charges go
      // on its first bill: freight 25 (+1.25 tax) and an untaxed fee of 10
      // (PY-C). A draft dated in the past is dated when it posts (PY-D).
      const before = Date.now();
      const first = await operate(
        'vendor_bill_post',
        await draftBill(
          a.header.recordId,
          'INV-7001',
          '2026-01-01T00:00:00.000Z',
        ),
      );
      assert.match(
        String(value(first, 'vendor_bill', 'number')),
        /^BILL-\d{6}$/u,
      );
      assert.equal(state(first, 'vendor_bill'), 'open');
      assert.deepEqual(figures(first), {
        subtotal: '22.50',
        charges: '35.00',
        tax: '2.38',
        total: '59.88',
        paid_amount: '0.00',
        credited_amount: '0.00',
        balance: '59.88',
      });
      assert.equal(value(first, 'vendor_bill', 'currency'), 'CAD');
      assert.equal(
        value(first, 'vendor_bill', 'supplier_party_id'),
        fixture.customer,
      );
      assert.equal(
        value(first, 'vendor_bill', 'supplier_invoice_number'),
        'INV-7001',
      );
      const billDate = Date.parse(
        String(value(first, 'vendor_bill', 'bill_date')),
      );
      assert.ok(
        billDate >= before - 5_000 && billDate <= Date.now() + 5_000,
        'the bill is dated when it posts',
      );
      // Net 30 from the order: due thirty days after the bill date (PY-D).
      assert.equal(
        Date.parse(String(value(first, 'vendor_bill', 'due_date'))) - billDate,
        30 * 86_400_000,
      );
      // Its line: the order line's frozen cost, discount and rate, in the
      // unit the receipt recorded.
      const [firstLine, ...moreLines] = await billLines(first.recordId);
      assert.equal(moreLines.length, 0);
      assert.deepEqual(
        [
          quantity(value(firstLine!, 'vendor_bill_line', 'quantity')),
          value(firstLine!, 'vendor_bill_line', 'unit_id'),
          money(value(firstLine!, 'vendor_bill_line', 'unit_price')),
          quantity(value(firstLine!, 'vendor_bill_line', 'discount_percent')),
          quantity(value(firstLine!, 'vendor_bill_line', 'tax_rate_percent')),
          money(value(firstLine!, 'vendor_bill_line', 'amount')),
          money(value(firstLine!, 'vendor_bill_line', 'tax')),
        ],
        ['2', 'EA', '12.50', '10', '5', '22.50', '1.13'],
      );

      assert.equal(await toBill(a.header.recordId), '0');
      // The same received quantity is never billed twice.
      await assert.rejects(
        bill(a.header.recordId),
        refusedWith('PAYABLES_NOTHING_TO_BILL'),
      );
      // A later receipt is billed on its own, without the charges again; its
      // supplier invoice number may not repeat one of the vendor's live bills
      // (PY-F), whatever its case or spacing.
      await receive(a.header.recordId, lineA!.recordId, '1');
      await assert.rejects(
        bill(a.header.recordId, ' inv-7001 '),
        refusedWith('PAYABLES_DUPLICATE_SUPPLIER_INVOICE'),
      );
      // 1 × 12.50 less 10% = 11.25, tax 0.5625 → 0.56.
      const second = await bill(a.header.recordId, 'INV-7002');
      assert.deepEqual(figures(second), {
        subtotal: '11.25',
        charges: '0.00',
        tax: '0.56',
        total: '11.81',
        paid_amount: '0.00',
        credited_amount: '0.00',
        balance: '11.81',
      });

      // A payment may not exceed the balance, nor be a fraction of a cent.
      await assert.rejects(
        settle('payment', first.recordId, '60'),
        refusedWith('PAYABLES_AMOUNT_EXCEEDS_BALANCE'),
      );
      await assert.rejects(
        settle('payment', first.recordId, '0.001'),
        refusedWith('PAYABLES_AMOUNT_INVALID'),
      );
      const paid = await settle('payment', first.recordId, '20');
      assert.equal(paid.outcome, 'succeeded');
      assert.match(
        String(value(paid.readBack!, 'vendor_payment', 'number')),
        /^VPAY-\d{6}$/u,
      );
      assert.equal(state(paid.readBack!, 'vendor_payment'), 'posted');
      let current = await reread('vendor_bill', first.recordId);
      assert.equal(state(current, 'vendor_bill'), 'partially_paid');
      assert.equal(figures(current).balance, '39.88');

      // A vendor credit reduces the same balance.
      const credited = await settle('credit', first.recordId, '9.88');
      assert.match(
        String(value(credited.readBack!, 'vendor_credit', 'number')),
        /^VCM-\d{6}$/u,
      );
      current = await reread('vendor_bill', first.recordId);
      assert.deepEqual(
        [figures(current).credited_amount, figures(current).balance],
        ['9.88', '30.00'],
      );

      // Two payments racing for one balance: the bill row serializes them,
      // so exactly one posts and the other is refused.
      const race = await Promise.allSettled([
        settle('payment', first.recordId, '20'),
        settle('payment', first.recordId, '20'),
      ]);
      assert.equal(
        race.filter((outcome) => outcome.status === 'fulfilled').length,
        1,
      );
      assert.ok(
        race.some(
          (outcome) =>
            outcome.status === 'rejected' &&
            refusedWith('PAYABLES_AMOUNT_EXCEEDS_BALANCE')(outcome.reason),
        ),
      );
      current = await reread('vendor_bill', first.recordId);
      assert.deepEqual(
        [figures(current).paid_amount, figures(current).balance],
        ['40.00', '10.00'],
      );
      await settle('payment', first.recordId, '10');
      current = await reread('vendor_bill', first.recordId);
      assert.equal(state(current, 'vendor_bill'), 'paid');
      assert.equal(figures(current).balance, '0.00');
      await assert.rejects(
        settle('payment', first.recordId, '1'),
        refusedWith('PAYABLES_BILL_STATE_CONFLICT'),
      );

      // Void only while nothing is settled: a paid bill stays; an open one
      // is voided and its quantity can be billed again. A voided bill's
      // supplier invoice number is free for the bill that replaces it.
      await assert.rejects(
        operate('vendor_bill_void', current),
        refusedWith('PAYABLES_BILL_SETTLED'),
      );
      const voided = await operate('vendor_bill_void', second);
      assert.equal(state(voided, 'vendor_bill'), 'void');
      assert.equal(figures(voided).balance, '0.00');
      assert.equal(await toBill(a.header.recordId), '1');
      const rebilled = await bill(a.header.recordId, 'INV-7002');
      assert.deepEqual(
        [figures(rebilled).subtotal, figures(rebilled).total],
        ['11.25', '11.81'],
      );

      // A generic write cannot change a posted bill.
      await assert.rejects(
        fixture.invoke('vendor_bill_update', {
          recordId: rebilled.recordId,
          expectedRevision: rebilled.revision,
          patch: { [`${ns}:field.vendor_bill_total`]: '0' },
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code ===
          'MODULE_OPERATION_PRECONDITION_REFUSED',
      );

      // A draft order is not billed, and a received line without a cost is
      // refused rather than billed at nothing.
      const draft = await purchase([{ quantity: '1', cost: '5' }], false);
      await assert.rejects(
        bill(draft.header.recordId),
        refusedWith('PAYABLES_ORDER_NOT_BILLABLE'),
      );
      const unpriced = await purchase([{ quantity: '1', cost: null }]);
      await receive(unpriced.header.recordId, unpriced.lines[0]!.recordId, '1');
      await assert.rejects(
        bill(unpriced.header.recordId),
        refusedWith('PAYABLES_LINE_UNPRICED'),
      );

      // Current authority: without bill read the Bills List is refused by
      // its own name, and the order still reads -- stating nothing to bill
      // rather than a guessed zero.
      await fixture.measure('deny', undefined, undefined, 'vendor_bill_read');
      const refused = await query('vendor_bill_list', {
        includeArchived: false,
        list: {
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          cursor: null,
          matchMode: 'substring',
          pageSize: 10,
          search: '',
          sort: [],
          relationLabels: [],
        },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(refused instanceof SemanticQueryPolicyDeniedError);
      assert.equal(refused.queryId, `${ns}:query.vendor_bill_list`);
      const withheld = await reread(
        'commercial_purchase_order',
        a.header.recordId,
      );
      assert.equal(withheld.values[`${ns}:metric.order_to_bill`], null);
      assert.notEqual(withheld.values[`${ns}:metric.order_total`], null);
      await fixture.measure('allow', undefined, undefined, 'vendor_bill_read');
      assert.equal(await toBill(a.header.recordId), '0');
    });
  },
);

test(
  "payables under concurrency and per line: two bills of one order take its quantity once; a receipt and a bill post serialize; a correction on one line hides no other line's unbilled quantity; posting reads only its order's received rows; each line's three-way match reads as storage says; a billed order is not cancelled until its bill is void",
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const {
        value,
        operate,
        purchase,
        receive,
        draftBill,
        bill,
        toBill,
        billLines,
        figures,
        movementOf,
        matchOf,
        independentMatch,
        reread,
        state,
      } = payablesKit(fixture);

      // Two bills racing for one order: the order row serializes them, so
      // one takes the received quantity and the other has nothing to bill.
      const b = await purchase([{ quantity: '2', cost: '8' }]);
      await receive(b.header.recordId, b.lines[0]!.recordId, '2');
      const drafts = [
        await draftBill(b.header.recordId),
        await draftBill(b.header.recordId),
      ];
      const racing = await Promise.allSettled(
        drafts.map((draft) => operate('vendor_bill_post', draft)),
      );
      assert.equal(
        racing.filter((outcome) => outcome.status === 'fulfilled').length,
        1,
      );
      assert.ok(
        racing.some(
          (outcome) =>
            outcome.status === 'rejected' &&
            refusedWith('PAYABLES_NOTHING_TO_BILL')(outcome.reason),
        ),
      );
      assert.equal(await toBill(b.header.recordId), '0');

      // A receipt and a bill post of one order serialize on the order row:
      // whichever runs first, what is billed and what is left to bill add up
      // to exactly what was received.
      const c = await purchase([{ quantity: '3', cost: '2' }]);
      await receive(c.header.recordId, c.lines[0]!.recordId, '1');
      const pending = await draftBill(c.header.recordId);
      const [posted] = await Promise.all([
        operate('vendor_bill_post', pending),
        receive(c.header.recordId, c.lines[0]!.recordId, '1'),
      ]);
      const [line] = await billLines(posted.recordId);
      const billedUnits = Number(
        quantity(value(line!, 'vendor_bill_line', 'quantity')),
      );
      assert.ok([1, 2].includes(billedUnits));
      assert.equal(Number(await toBill(c.header.recordId)), 2 - billedUnits);

      // Per line, as the post bills: after a receipt correction leaves the
      // first line billed above what was received (2 over 1), the second
      // line's unbilled unit is still offered and billed (PY-G: the match is
      // shown, never enforced).
      const d = await purchase([
        { quantity: '2', cost: '10' },
        { quantity: '2', cost: '4' },
      ]);
      const [first, second] = d.lines;
      const receivedFirst = await receive(
        d.header.recordId,
        first!.recordId,
        '2',
      );
      await receive(d.header.recordId, second!.recordId, '1');
      await bill(d.header.recordId);
      assert.equal(await toBill(d.header.recordId), '0');
      await receive(d.header.recordId, first!.recordId, '-1', {
        receiptId: receivedFirst.recordId,
        movementId: await movementOf(receivedFirst.recordId),
      });
      await receive(d.header.recordId, second!.recordId, '1');
      // Across the order received (1 + 2) equals billed (2 + 1): a netted
      // offer would read zero.
      assert.equal(await toBill(d.header.recordId), '1');

      // Posting reads this order's received rows and no other's.
      const target = await governedStorageTarget();
      const client = await fixture.pool.connect();
      try {
        const progressed = await progressByOrderLine(
          client,
          PAYABLES_SETTLEMENT_SPEC,
          settlementBinding(PAYABLES_SETTLEMENT_SPEC, target),
          {
            tenantId: fixture.app.runtime.identity.tenantId,
            environmentId: fixture.app.runtime.identity.environmentId,
            legalEntityId: fixture.scope,
          },
          [first!.recordId, second!.recordId],
        );
        const byLine = (left: readonly unknown[], right: readonly unknown[]) =>
          String(left[0]).localeCompare(String(right[0]));
        assert.deepEqual(
          [...progressed.entries()]
            .map(([orderLine, progress]) => [
              orderLine,
              progress.quantity,
              progress.unit,
            ])
            .sort(byLine),
          [
            [first!.recordId, 10n ** 18n, 'EA'],
            [second!.recordId, 2n * 10n ** 18n, 'EA'],
          ].sort(byLine),
        );
        const received = settlementBinding(
          PAYABLES_SETTLEMENT_SPEC,
          target,
        ).progress;
        const companyReceived = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${fulfillmentTable(received)}
            WHERE tenant_id=$1 AND environment_id=$2
              AND ${q(received.legalEntity!.column)}=$3`,
          [
            fixture.app.runtime.identity.tenantId,
            fixture.app.runtime.identity.environmentId,
            fixture.scope,
          ],
        );
        assert.ok(Number(companyReceived.rows[0]!.count) > 2);
      } finally {
        client.release();
      }

      // The post bills the second line's unit alone, without the charges the
      // order's first bill carried: 1 × 4 less 10% = 3.60, tax 0.18.
      const corrected = await bill(d.header.recordId);
      assert.deepEqual(figures(corrected), {
        subtotal: '3.60',
        charges: '0.00',
        tax: '0.18',
        total: '3.78',
        paid_amount: '0.00',
        credited_amount: '0.00',
        balance: '3.78',
      });
      const [only, ...rest] = await billLines(corrected.recordId);
      assert.equal(rest.length, 0);
      assert.equal(
        value(only!, 'vendor_bill_line', 'item_id'),
        value(second!, 'purchase_order_line', 'item_id'),
      );
      assert.equal(await toBill(d.header.recordId), '0');

      // The three-way match (PY-G), as the order page reads it, equals an
      // independent computation from storage: the first line billed above
      // what was received (2 over 1), the second matched (2 and 2). It is
      // shown, never enforced: the correction above was not refused.
      const lineIds = [first!.recordId, second!.recordId];
      const stated = await matchOf(d.header.recordId);
      const expected = await independentMatch(lineIds);
      assert.deepEqual(stated, expected);
      assert.deepEqual(
        lineIds.map((line) => [stated[line]!.match, stated[line]!.toBill]),
        [
          ['Billed above received', '0'],
          ['Matched', '0'],
        ],
      );
      // A line received and not yet billed, and one not received at all.
      const e = await purchase([
        { quantity: '3', cost: '2' },
        { quantity: '1', cost: '2' },
      ]);
      await receive(e.header.recordId, e.lines[0]!.recordId, '2');
      const partly = await matchOf(e.header.recordId);
      assert.deepEqual(
        partly,
        await independentMatch(e.lines.map((line) => line.recordId)),
      );
      assert.deepEqual(
        e.lines.map((line) => [
          partly[line.recordId]!.match,
          partly[line.recordId]!.toBill,
        ]),
        [
          ['Received, not billed', '2'],
          ['Not received', '0'],
        ],
      );

      // PY-H: a purchase order with a live bill is not cancelled, even once
      // its receipts are taken back; voiding the bill lets it cancel.
      const f = await purchase([{ quantity: '2', cost: '5' }]);
      const receivedF = await receive(
        f.header.recordId,
        f.lines[0]!.recordId,
        '2',
      );
      const billedF = await bill(f.header.recordId);
      await receive(f.header.recordId, f.lines[0]!.recordId, '-2', {
        receiptId: receivedF.recordId,
        movementId: await movementOf(receivedF.recordId),
      });
      await assert.rejects(
        operate(
          'purchase_order_cancel',
          await reread('purchase_order', f.header.recordId),
        ),
        refusedWith('PAYABLES_ORDER_BILLED'),
      );
      // Refused before anything changed: the order is still released.
      assert.match(
        String(
          (await reread('purchase_order', f.header.recordId)).values[
            `${ns}:derived_state_field.machine.purchase_order_lifecycle`
          ],
        ),
        /:state\.purchase_order_released$/u,
      );
      assert.equal(
        state(await operate('vendor_bill_void', billedF), 'vendor_bill'),
        'void',
      );
      const cancelled = await operate(
        'purchase_order_cancel',
        await reread('purchase_order', f.header.recordId),
      );
      assert.match(
        String(
          cancelled.values[
            `${ns}:derived_state_field.machine.purchase_order_lifecycle`
          ],
        ),
        /:state\.purchase_order_cancelled$/u,
      );
    });
  },
);
