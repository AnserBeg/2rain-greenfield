import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  declaredListArguments,
  readDeclaredListState,
} from '../../apps/web/src/list-declaration.js';
import { readCompiledSurfaceManifest } from '../../apps/web/src/surface-contract.js';
import { COMPOSED_APPLICATION_INVENTORY_SCOPE } from '../../apps/api/src/composition-root.js';
import {
  requireSharedListResult,
  SharedListContractError,
} from '../../packages/runtime/src/list-behavior/index.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
  type SemanticRecordDto,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

/**
 * REPORTS-HOME over PostgreSQL: Receivables aging and Customer accounts read
 * through the gateway exactly as the web List asks them (the declaration's
 * own arguments, with an injected request clock), the customer account page
 * and its printed statement, and the Today launcher's counts.
 */
const ns = 'northstar.app';
const AGING = 'receivables_aging_list';
const ACCOUNTS = 'customer_account_list';
const DAY = 86_400_000;
const shipTo = {
  ship_to_name: 'Receiving dock',
  ship_to_street: '100 Industrial Way',
  ship_to_city: 'Calgary',
  ship_to_region: 'AB',
  ship_to_postal_code: 'T2P 0A1',
  ship_to_country: 'Canada',
};

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

/** Orders, shipments, invoices and settlements through the governed path. */
function kit(fixture: Fixture) {
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
  const party = async (name: string, roles: readonly string[]) => {
    const created = await fixture.create(
      'party',
      { number: `RH-${randomUUID().slice(0, 6)}`, name },
      {},
      false,
    );
    for (const kind of roles)
      await fixture.create(
        'party_role',
        { kind: `${ns}:option.${kind}`, status: `${ns}:option.active` },
        { party: created.recordId },
        false,
      );
    return created.recordId;
  };
  const order = async (input: {
    readonly customer: string;
    readonly currency: string;
    readonly terms: string;
    readonly lines: readonly {
      readonly quantity: string;
      readonly price: string;
      readonly discount?: string;
    }[];
    readonly release?: boolean;
  }) => {
    const header = await fixture.create('sales_order', {
      customer_party_id: input.customer,
      order_date: new Date().toISOString(),
      requested_date: null,
      currency: input.currency,
      notes: null,
      payment_terms: `${ns}:option.sales_order_payment_terms_${input.terms}`,
      ...shipTo,
    });
    const lines = [];
    for (const [index, line] of input.lines.entries())
      lines.push(
        await fixture.create(
          'sales_order_line',
          {
            item_id: fixture.item,
            unit_id: 'EA',
            line_number: String(index + 1),
            ordered_quantity: line.quantity,
            unit_price: line.price,
            list_price: line.price,
            discount_percent: line.discount ?? '0',
            tax_code_id: fixture.taxCode,
            tax_rate_percent: '5',
          },
          { order: header.recordId },
        ),
      );
    const released =
      input.release === false
        ? header
        : await operate('sales_order_release', header);
    return { header: released, lines };
  };
  const reserve = async (orderLineId: string, quantity: string) =>
    operate(
      'reservation_reserve',
      await fixture.create(
        'reservation',
        {
          number: randomUUID(),
          state: `${ns}:option.reservation_state_draft`,
          item_id: fixture.item,
          location_id: fixture.location,
          quantity,
          unit_id: 'EA',
          reason: 'Reports proof',
        },
        { order_line: orderLineId },
      ),
    );
  const ship = async (
    orderId: string,
    orderLineId: string,
    reservationId: string,
    quantity: string,
  ) => {
    const header = await fixture.create(
      'shipment',
      {
        state: `${ns}:option.shipment_state_draft`,
        kind: `${ns}:option.shipment_kind_initial`,
        effective_at: new Date().toISOString(),
        location_id: fixture.location,
        external_reference: null,
        reason_code: 'SHIP',
        reason_narrative: 'Reports proof',
        carrier: 'Purolator',
        shipping_reference_kind: `${ns}:option.shipment_shipping_reference_kind_tracking`,
        shipping_reference: randomUUID(),
        ...shipTo,
      },
      { order: orderId },
    );
    await fixture.create(
      'shipment_line',
      {
        line_number: '1',
        item_id: fixture.item,
        quantity,
        unit_id: 'EA',
        reversal_of_movement_id: null,
      },
      {
        shipment: header.recordId,
        order_line: orderLineId,
        reservation: reservationId,
      },
    );
    return operate('shipment_post', header);
  };
  /** A shipped single-line order, invoiced on its own date. */
  const invoiced = async (input: {
    readonly customer: string;
    readonly currency: string;
    readonly terms: string;
    readonly price: string;
    readonly invoiceDate: string;
  }) => {
    const placed = await order({
      customer: input.customer,
      currency: input.currency,
      terms: input.terms,
      lines: [{ quantity: '1', price: input.price }],
    });
    const line = placed.lines[0]!;
    const reservation = await reserve(line.recordId, '1');
    await ship(
      placed.header.recordId,
      line.recordId,
      reservation.recordId,
      '1',
    );
    const draft = await fixture.create(
      'customer_invoice',
      {
        state: `${ns}:option.customer_invoice_state_draft`,
        invoice_date: input.invoiceDate,
      },
      { order: placed.header.recordId },
    );
    return operate('customer_invoice_post', draft);
  };
  const pay = async (invoiceId: string, amount: string) => {
    const draft = await fixture.create(
      'customer_payment',
      {
        state: `${ns}:option.customer_payment_state_draft`,
        payment_date: new Date().toISOString(),
        amount,
        method: `${ns}:option.customer_payment_method_eft`,
        reference: `EFT-${randomUUID().slice(0, 8)}`,
      },
      { invoice: invoiceId },
    );
    const paid = await fixture.invoke('customer_payment_post', {
      recordId: draft.recordId,
      expectedRevision: draft.revision,
    });
    assert.equal(paid.outcome, 'succeeded');
  };
  return { operate, party, order, reserve, ship, invoiced, pay };
}

/** A List read as the web reads it: its declaration's own arguments. */
async function readList(
  fixture: Fixture,
  local: string,
  company: string,
  options: {
    readonly now: Date;
    readonly view?: string;
    readonly currency?: string;
  },
) {
  return fixture.app.runtime.entry.run({ headers: {} }, async (issued) => {
    const list = readCompiledSurfaceManifest(issued).surfaces.find(
      (surface) => surface.surfaceId === `${ns}:surface.${local}`,
    )!.list!;
    const url = new URL('http://list.local/');
    if (options.view)
      url.searchParams.set('view', `${ns}:list_view.${local}_${options.view}`);
    if (options.currency) url.searchParams.set('currency', options.currency);
    return requireSharedListResult(
      await fixture.app.runtime.queryGateway.invoke(issued, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: `${ns}:query.${local}`,
        arguments: declaredListArguments(
          list,
          readDeclaredListState(list, url),
          {
            mode: 'page',
            now: options.now,
            queryId: `${ns}:query.${local}`,
            scopeArguments: {
              [`${ns}:parameter.${local}_legal_entity_scope`]: company,
            },
          },
        ),
      }),
    );
  });
}

const figure = (
  record: SemanticRecordDto | undefined,
  local: string,
  name: string,
): ImmutableJsonValue | undefined =>
  record?.values[`${ns}:list_figure.${local}_${name}`];

/** An exact decimal as cents, for sums that never meet a float. */
const cents = (value: ImmutableJsonValue | undefined): bigint => {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(String(value));
  assert.ok(match, `not an exact decimal: ${String(value)}`);
  const fraction = (match[3] ?? '').padEnd(2, '0');
  assert.match(fraction.slice(2), /^0*$/u, 'more precise than cents');
  const magnitude = BigInt(match[2]!) * 100n + BigInt(fraction.slice(0, 2));
  return match[1] ? -magnitude : magnitude;
};
/** Cents as the canonical decimal the statement answers with. */
const canonical = (value: bigint): string => {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const fraction = String(magnitude % 100n)
    .padStart(2, '0')
    .replace(/0+$/u, '');
  const text = `${String(magnitude / 100n)}${fraction ? `.${fraction}` : ''}`;
  return negative && text !== '0' ? `-${text}` : text;
};

/** A second company that shares the tenant's calendar, active and offered. */
async function secondCompany(fixture: Fixture, code: string) {
  const company = randomUUID();
  await fixture.pool.query(
    `SELECT platform.provision_inventory_scope($1,$2,$3,$7,$8,$5,$6,$4,1::smallint,'reject',0,'codeAndNarrative','codeOnly','codeAndNarrative','codeAndNarrative','codeAndNarrative',NULL,NULL,NULL,NULL,NULL)`,
    [
      fixture.app.runtime.identity.tenantId,
      fixture.app.runtime.identity.environmentId,
      company,
      fixture.app.runtime.releaseRoot,
      COMPOSED_APPLICATION_INVENTORY_SCOPE.timeZone,
      COMPOSED_APPLICATION_INVENTORY_SCOPE.businessDayBoundary,
      code,
      `${code} company`,
    ],
  );
  const master = await fixture.invoke('legal_entity_create', {
    recordId: company,
    values: {
      [`${ns}:field.legal_entity_code`]: code,
      [`${ns}:field.legal_entity_name`]: `${code} company`,
      [`${ns}:field.legal_entity_is_default`]: false,
      [`${ns}:field.legal_entity_status`]: `${ns}:option.legal_entity_status_active`,
    },
  });
  assert.equal(master.outcome, 'succeeded');
  return company;
}

test(
  'REPORTS-HOME: receivables aging buckets each balance by whole UTC calendar days past due, one currency at a time, in one company, and is refused without the invoice read',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const { party, invoiced, pay } = kit(fixture);
      const company = fixture.scope;
      // Posted late on 15 June (UTC): an invoice due "today" at 23:30 is one
      // calendar day past due a minute after midnight, never zero days.
      const invoiceDate = '2026-06-15T23:30:00.000Z';
      const posted = Date.parse('2026-06-15T00:00:00.000Z');
      const at = (days: number) => new Date(posted + days * DAY + 60_000);
      const brook = await party('Brook Hardware', ['customer']);
      const terms = [
        ['due_on_receipt', '100'],
        ['net_15', '200'],
        ['net_30', '300'],
        ['net_45', '400'],
        ['net_60', '500'],
      ] as const;
      const own: SemanticRecordDto[] = [];
      for (const [term, price] of terms)
        own.push(
          await invoiced({
            customer: fixture.customer,
            currency: 'CAD',
            terms: term,
            price,
            invoiceDate,
          }),
        );
      // Each total is the price plus 5% tax: 105, 210, 315, 420 and 525.
      assert.deepEqual(
        own.map((record) =>
          canonical(cents(record.values[`${ns}:field.customer_invoice_total`])),
        ),
        ['105', '210', '315', '420', '525'],
      );
      // The due-on-receipt invoice is part paid: its balance, 100, is what
      // ages -- never its total.
      await pay(own[0]!.recordId, '5');
      await invoiced({
        customer: fixture.customer,
        currency: 'USD',
        terms: 'net_30',
        price: '1000',
        invoiceDate,
      });
      const brookInvoice = await invoiced({
        customer: brook,
        currency: 'CAD',
        terms: 'due_on_receipt',
        price: '40',
        invoiceDate,
      });
      await pay(brookInvoice.recordId, '2');

      const buckets = [
        'current',
        'days_1_30',
        'days_31_60',
        'days_61_90',
        'over_90',
        'owing',
      ] as const;
      const row = (records: readonly SemanticRecordDto[], recordId: string) =>
        records.find((record) => record.recordId === recordId);
      const amounts = (record: SemanticRecordDto | undefined) =>
        buckets.map((name) => String(figure(record, AGING, name)));
      // Due 0, 15, 30, 45 and 60 days after 15 June, balances 100, 210, 315,
      // 420 and 525: each step of `today` moves one invoice across exactly
      // one boundary (0|1, 30|31, 60|61, 90|91).
      const expected: Record<number, readonly string[]> = {
        0: ['1570', '0', '0', '0', '0', '1570'],
        1: ['1470', '100', '0', '0', '0', '1570'],
        30: ['1260', '310', '0', '0', '0', '1570'],
        31: ['945', '525', '100', '0', '0', '1570'],
        60: ['525', '735', '310', '0', '0', '1570'],
        61: ['0', '945', '525', '100', '0', '1570'],
        90: ['0', '525', '735', '310', '0', '1570'],
        91: ['0', '0', '945', '525', '100', '1570'],
      };
      const brookBucket = (days: number) =>
        days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
      for (const [days, values] of Object.entries(expected)) {
        const now = at(Number(days));
        const result = await readList(fixture, AGING, company, {
          now,
          view: 'owing',
        });
        // Both customers owe, in CAD; nobody else in the demo data does.
        assert.deepEqual(
          result.records.map((record) => record.recordId).sort(),
          [fixture.customer, brook].sort(),
          `owing at ${days}`,
        );
        assert.deepEqual(
          amounts(row(result.records, fixture.customer)),
          values,
          `customer at ${days} days`,
        );
        assert.equal(
          figure(row(result.records, fixture.customer), AGING, 'invoices'),
          '5',
        );
        const brookAmounts = ['0', '0', '0', '0', '0', '40'];
        brookAmounts[brookBucket(Number(days))] = '40';
        assert.deepEqual(amounts(row(result.records, brook)), brookAmounts);
        // The totals add up every kept row, in the List's one currency.
        const summary = result.listCoverage.figureSummary!;
        assert.deepEqual(
          [
            'owing',
            'current',
            'days_1_30',
            'days_31_60',
            'days_61_90',
            'over_90',
          ].map((name) => summary[`${ns}:list_figure.${AGING}_${name}`]),
          [
            'owing',
            'current',
            'days_1_30',
            'days_31_60',
            'days_61_90',
            'over_90',
          ].map((name) =>
            canonical(
              cents(
                figure(row(result.records, fixture.customer), AGING, name),
              ) + cents(figure(row(result.records, brook), AGING, name)),
            ),
          ),
        );
        // Past due keeps exactly the customers with something late.
        const late = await readList(fixture, AGING, company, {
          now,
          view: 'past_due',
        });
        assert.deepEqual(
          late.records.map((record) => record.recordId).sort(),
          Number(days) === 0 ? [] : [fixture.customer, brook].sort(),
          `past due at ${days}`,
        );
      }

      // USD on its own: only the USD invoice, never converted or added.
      const usd = await readList(fixture, AGING, company, {
        now: at(31),
        view: 'owing',
        currency: 'USD',
      });
      assert.deepEqual(
        usd.records.map((record) => record.recordId),
        [fixture.customer],
      );
      assert.deepEqual(amounts(usd.records[0]), [
        '0',
        '1050',
        '0',
        '0',
        '0',
        '1050',
      ]);
      assert.equal(
        usd.listCoverage.figureSummary![`${ns}:list_figure.${AGING}_owing`],
        '1050',
      );
      const eur = await readList(fixture, AGING, company, {
        now: at(31),
        view: 'owing',
        currency: 'EUR',
      });
      assert.equal(eur.records.length, 0);
      assert.equal(
        eur.listCoverage.figureSummary![`${ns}:list_figure.${AGING}_owing`],
        '0',
      );

      // Company scope: another company sees none of these balances, and its
      // reading leaves this one's unchanged.
      const other = await secondCompany(fixture, 'RPT-B');
      const elsewhere = await readList(fixture, AGING, other, {
        now: at(91),
        view: 'owing',
      });
      assert.equal(
        elsewhere.records.length,
        0,
        'another company sees none of these balances',
      );
      assert.equal(elsewhere.listCoverage.totalCount, 0);
      assert.equal(
        elsewhere.listCoverage.figureSummary![
          `${ns}:list_figure.${AGING}_owing`
        ],
        '0',
      );
      const here = await readList(fixture, AGING, company, {
        now: at(91),
        view: 'owing',
      });
      assert.deepEqual(
        amounts(row(here.records, fixture.customer)),
        expected[91],
      );

      // The customer's statement: its account page in this company lists
      // every invoice with its balance, and prints them.
      const account = new URL(fixture.app.baseUrl);
      account.searchParams.set(
        'surface',
        `${ns}:surface.customer_account_detail`,
      );
      account.searchParams.set('record', fixture.customer);
      account.searchParams.set(
        `${ns}:parameter.customer_invoice_list_legal_entity_scope`,
        company,
      );
      const page = await fetch(account, { redirect: 'manual' });
      assert.equal(page.status, 200);
      const html = await page.text();
      for (const number of own.map((record) =>
        String(record.values[`${ns}:field.customer_invoice_number`]),
      ))
        assert.ok(html.includes(number), `statement lists ${number}`);
      assert.ok(html.includes('Print statement'));
      account.searchParams.set('print', 'document');
      const printed = await (
        await fetch(account, { redirect: 'manual' })
      ).text();
      assert.match(
        printed,
        /data-print-document="northstar\.app:surface\.customer_account_detail"/u,
      );
      // Five CAD invoices and the USD one, each in its own currency.
      assert.match(printed, /6 lines/u);
      assert.ok(
        !printed.includes(
          String(brookInvoice.values[`${ns}:field.customer_invoice_number`]),
        ),
      );
      // In the other company the statement is empty: none of A's invoices.
      account.searchParams.delete('print');
      account.searchParams.set(
        `${ns}:parameter.customer_invoice_list_legal_entity_scope`,
        other,
      );
      const otherPage = await (
        await fetch(account, { redirect: 'manual' })
      ).text();
      for (const record of own)
        assert.ok(
          !otherPage.includes(
            String(record.values[`${ns}:field.customer_invoice_number`]),
          ),
        );

      // Current authority: without the invoice read the aging List is
      // refused by that query's name -- never shown as nothing owed.
      await fixture.measure(
        'deny',
        undefined,
        undefined,
        'customer_invoice_read',
      );
      const refused = await readList(fixture, AGING, company, {
        now: at(91),
        view: 'owing',
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(refused instanceof SemanticQueryPolicyDeniedError);
      assert.equal(refused.queryId, `${ns}:query.customer_invoice_list`);
      await fixture.measure(
        'allow',
        undefined,
        undefined,
        'customer_invoice_read',
      );

      // The request contract: a currency figure is never read without one
      // currency, nor an age without the day it counts from.
      const unanchored = await fixture.app.runtime.entry
        .run({ headers: {} }, (issued) =>
          fixture.app.runtime.queryGateway.invoke(issued, {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId: `${ns}:query.${AGING}`,
            arguments: {
              includeArchived: false,
              [`${ns}:parameter.${AGING}_legal_entity_scope`]: company,
              list: {
                cursor: null,
                figures: {
                  sums: [
                    {
                      figureId: `${ns}:list_figure.${AGING}_owing`,
                      rows: {
                        matchFieldId: `${ns}:field.customer_invoice_customer_party_id`,
                        queryId: `${ns}:query.customer_invoice_list`,
                        quantityFieldId: `${ns}:field.customer_invoice_balance`,
                      },
                      sum: 'rows',
                      currencyFieldId: `${ns}:field.customer_invoice_currency`,
                    },
                  ],
                },
                matchMode: 'substring',
                pageSize: 10,
                relationLabels: [],
                schemaVersion: 'northstar.shared-list-query/v1',
                search: '',
                sort: [],
              },
            },
          }),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      assert.ok(unanchored instanceof SharedListContractError);
    });
  },
);

test(
  'REPORTS-HOME: customer accounts count released orders, open units and open value in one currency, for customers only; Today counts the Lists it opens',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const { party, order, reserve, ship, operate } = kit(fixture);
      const company = fixture.scope;
      const now = new Date();
      const brook = await party('Brook Hardware', ['customer']);
      const supplier = await party('Supply Only Ltd', ['supplier']);
      // A: 10 at 12.50 less 10% and 4 at 3.00, 4 of the first shipped and
      // 2 more reserved: open 6 + 4 = 10 units worth 67.50 + 12.00.
      const a = await order({
        customer: fixture.customer,
        currency: 'CAD',
        terms: 'net_30',
        lines: [
          { quantity: '10', price: '12.5', discount: '10' },
          { quantity: '4', price: '3' },
        ],
      });
      const held = await reserve(a.lines[0]!.recordId, '6');
      await ship(a.header.recordId, a.lines[0]!.recordId, held.recordId, '4');
      // B: in USD, read only under USD.
      await order({
        customer: fixture.customer,
        currency: 'USD',
        terms: 'net_30',
        lines: [{ quantity: '2', price: '100' }],
      });
      // C: shipped in full and closed -- no longer open.
      const c = await order({
        customer: fixture.customer,
        currency: 'CAD',
        terms: 'net_30',
        lines: [{ quantity: '1', price: '5' }],
      });
      const cHeld = await reserve(c.lines[0]!.recordId, '1');
      await ship(c.header.recordId, c.lines[0]!.recordId, cHeld.recordId, '1');
      const closed = await fixture.app.runtime.entry.run(
        { headers: {} },
        async (issued) => {
          const definition = registeredSemanticQueryFromPinnedView(
            issued,
            `${ns}:query.sales_order_get`,
          )!;
          return (
            await fixture.app.runtime.queryGateway.invoke(issued, {
              schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
              queryId: definition.queryId,
              arguments: {
                recordId: c.header.recordId,
                includeArchived: false,
                [definition.legalEntityScope!.operand.parameterId]: company,
              },
            })
          ).records[0]!;
        },
      );
      await operate('sales_order_close', closed);
      // D: a draft is not an open order.
      await order({
        customer: fixture.customer,
        currency: 'CAD',
        terms: 'net_30',
        lines: [{ quantity: '3', price: '7' }],
        release: false,
      });

      const figures = (record: SemanticRecordDto | undefined) =>
        ['open_orders', 'ordered', 'open_units', 'open_value', 'owing'].map(
          (name) => String(figure(record, ACCOUNTS, name)),
        );
      const all = await readList(fixture, ACCOUNTS, company, {
        now,
        view: 'all',
      });
      const ids = all.records.map((record) => record.recordId);
      // Customers only: the supplier-only party is never listed.
      assert.ok(ids.includes(fixture.customer));
      assert.ok(ids.includes(brook));
      assert.ok(!ids.includes(supplier), 'customers only');
      assert.deepEqual(
        figures(
          all.records.find((record) => record.recordId === fixture.customer),
        ),
        ['1', '14', '10', '79.5', '0'],
      );
      assert.deepEqual(
        figures(all.records.find((record) => record.recordId === brook)),
        ['0', '0', '0', '0', '0'],
      );
      const open = await readList(fixture, ACCOUNTS, company, {
        now,
        view: 'open',
      });
      assert.deepEqual(
        open.records.map((record) => record.recordId),
        [fixture.customer],
      );
      assert.deepEqual(
        ['open_orders', 'open_units', 'open_value', 'owing'].map(
          (name) =>
            open.listCoverage.figureSummary![
              `${ns}:list_figure.${ACCOUNTS}_${name}`
            ],
        ),
        ['1', '10', '79.5', '0'],
      );
      const usd = await readList(fixture, ACCOUNTS, company, {
        now,
        view: 'open',
        currency: 'USD',
      });
      assert.deepEqual(figures(usd.records[0]), ['1', '2', '2', '200', '0']);
      // Another company has none of these orders.
      const other = await secondCompany(fixture, 'ACC-B');
      const elsewhere = await readList(fixture, ACCOUNTS, other, {
        now,
        view: 'open',
      });
      assert.equal(
        elsewhere.listCoverage.totalCount,
        0,
        'another company has none of these orders',
      );
      // Without the order read the List is refused by that query's name.
      await fixture.measure('deny', undefined, undefined, 'sales_order_read');
      const refused = await readList(fixture, ACCOUNTS, company, {
        now,
        view: 'all',
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(refused instanceof SemanticQueryPolicyDeniedError);
      assert.equal(refused.queryId, `${ns}:query.sales_order_list`);
      await fixture.measure('allow', undefined, undefined, 'sales_order_read');

      // Today: each tile shows its List view's count, as that List counts it.
      const today = new URL(fixture.app.baseUrl);
      today.searchParams.set('surface', `${ns}:surface.a_today`);
      today.searchParams.set(
        `${ns}:parameter.sales_order_list_legal_entity_scope`,
        company,
      );
      const launcher = await (
        await fetch(today, { redirect: 'manual' })
      ).text();
      const tiles = Object.fromEntries(
        [
          ...launcher.matchAll(
            /data-launcher-tile="northstar\.app:launcher_tile\.today_([a-z_]+)"[^>]*>[\s\S]*?<span class="launcher-tile__count" data-launcher-count>(\d+)<\/span>/gu,
          ),
        ].map((match) => [match[1]!, Number(match[2]!)]),
      );
      // Order A still has 2 reserved units to ship.
      assert.equal(tiles.ready_to_ship, 1);
      assert.equal(tiles.late_receipts, 0);
      assert.equal(tiles.approvals, 0);
      assert.deepEqual(Object.keys(tiles).sort(), [
        'approvals',
        'blocked_sales',
        'inventory_risks',
        'late_receipts',
        'ready_to_ship',
        'receipts_due',
      ]);
    });
  },
);
