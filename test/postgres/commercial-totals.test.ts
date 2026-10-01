import assert from 'node:assert/strict';
import test from 'node:test';

import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticRecordDto,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';
const metric = (record: SemanticRecordDto, key: string) =>
  record.values[`${ns}:metric.${key}`];

test(
  'ruling B: line amounts and order totals are read exactly, half up per line, from each line and charge own frozen figures',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const query = (
        queryId: string,
        args: Record<string, ImmutableJsonValue>,
      ) =>
        fixture.app.runtime.entry.run({ headers: {} }, (view) => {
          const definition = registeredSemanticQueryFromPinnedView(
            view,
            `${ns}:query.${queryId}`,
          )!;
          return fixture.app.runtime.queryGateway.invoke(view, {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId: definition.queryId,
            arguments: {
              ...args,
              [definition.legalEntityScope!.operand.parameterId]: fixture.scope,
            },
          });
        });
      const totals = async (orderId: string) => {
        const read = await query('commercial_order_get', {
          recordId: orderId,
          includeArchived: false,
        });
        assert.equal(read.outcome, 'exact');
        return Object.fromEntries(
          ['order_subtotal', 'order_charges', 'order_tax', 'order_total'].map(
            (key) => [key, metric(read.records[0]!, key)],
          ),
        );
      };
      const pricedLines = async (orderId: string) =>
        (
          await query('commercial_order_lines', {
            includeArchived: false,
            list: {
              schemaVersion: SHARED_LIST_QUERY_VERSION,
              cursor: null,
              matchMode: 'substring',
              pageSize: 100,
              search: '',
              sort: [
                {
                  fieldId: `${ns}:field.sales_order_line_line_number`,
                  direction: 'ascending',
                },
              ],
              relationLabels: [],
              parentScope: {
                relationId: `${ns}:relation.sales_order_line_order`,
                recordId: orderId,
              },
            },
          })
        ).records.map((record) => [
          metric(record, 'line_amount'),
          metric(record, 'line_tax'),
          metric(record, 'price_basis'),
        ]);

      const order = await fixture.create('sales_order', {
        customer_party_id: fixture.customer,
        order_date: new Date().toISOString(),
        requested_date: null,
        currency: 'CAD',
        notes: null,
        freight_amount: '25',
        freight_tax_code_id: fixture.taxCode,
        freight_tax_rate_percent: '5',
        other_fee_amount: '10',
        other_fee_tax_code_id: null,
        other_fee_tax_rate_percent: null,
      });
      const line = (values: Record<string, ImmutableJsonValue>) =>
        fixture.create(
          'sales_order_line',
          { item_id: fixture.item, unit_id: 'EA', ...values },
          { order: order.recordId },
        );
      // 3 × 12.50 less 10% = 33.75; 5% tax 1.6875 → 1.69; at its list price.
      await line({
        line_number: '1',
        ordered_quantity: '3',
        unit_price: '12.5',
        list_price: '12.5',
        discount_percent: '10',
        tax_code_id: fixture.taxCode,
        tax_rate_percent: '5',
      });
      // 2.5 × 3.99 = 9.975 → 9.98, untaxed; a price changed by hand.
      await line({
        line_number: '2',
        ordered_quantity: '2.5',
        unit_price: '3.99',
        list_price: '4.25',
        discount_percent: null,
        tax_code_id: null,
        tax_rate_percent: null,
      });
      assert.deepEqual(await pricedLines(order.recordId), [
        ['33.75', '1.69', 'List price'],
        ['9.98', '0.00', 'Manual price'],
      ]);
      // Subtotal 43.73; freight 25 (+1.25 tax) and an untaxed fee of 10.
      assert.deepEqual(await totals(order.recordId), {
        order_subtotal: '43.73',
        order_charges: '35.00',
        order_tax: '2.94',
        order_total: '81.67',
      });

      // A figure that cannot be stated makes every total it feeds unknown:
      // a line with a tax code but no frozen rate.
      await line({
        line_number: '3',
        ordered_quantity: '1',
        unit_price: '1',
        list_price: null,
        discount_percent: null,
        tax_code_id: fixture.taxCode,
        tax_rate_percent: null,
      });
      assert.deepEqual((await pricedLines(order.recordId))[2], [
        null,
        null,
        null,
      ]);
      assert.deepEqual(await totals(order.recordId), {
        order_subtotal: null,
        order_charges: null,
        order_tax: null,
        order_total: null,
      });

      // Totals re-enter current authority: without line read they are not
      // computed from lines the caller may no longer see.
      await fixture.measure(
        'deny',
        undefined,
        undefined,
        'sales_order_line_read',
      );
      await assert.rejects(totals(order.recordId));
      await fixture.measure(
        'allow',
        undefined,
        undefined,
        'sales_order_line_read',
      );
      assert.equal((await totals(order.recordId)).order_total, null);
    });
  },
);
