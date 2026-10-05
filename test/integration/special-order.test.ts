import assert from 'node:assert/strict';
import test from 'node:test';
import { commercialLinkedFacts } from '../../packages/postgres-provider/src/commercial-link-read-model.js';
import { SemanticQueryPolicyDeniedError } from '../../packages/runtime/src/semantic-query-gateway.js';

test('both governed commercial link directions expose the special-order route and linked net receipts', async () => {
  const ns = 'example.app';
  const sales = {
    recordId: 'sales-line',
    values: {
      [`${ns}:field.sales_order_line_fulfillment_route`]: `${ns}:option.fulfillment_route_special_order`,
    },
    relationLabels: {
      [`${ns}:relation.sales_order_line_purchase_line`]: {
        recordId: 'purchase-line',
      },
      [`${ns}:relation.sales_order_line_order`]: { recordId: 'sales-order' },
    },
  };
  const purchase = {
    recordId: 'purchase-line',
    values: {},
    relationLabels: {
      [`${ns}:relation.purchase_order_line_sales_line`]: {
        recordId: 'sales-line',
      },
      [`${ns}:relation.purchase_order_line_order`]: {
        recordId: 'purchase-order',
      },
    },
  };
  for (const isPurchase of [false, true]) {
    const calls: string[] = [];
    const invoke = async (key: string) => {
      calls.push(key);
      return {
        outcome: 'exact',
        records: [
          key === 'arrivals'
            ? {
                values: {
                  [`${ns}:field.purchase_order_received_received_quantity`]:
                    '2.5',
                },
              }
            : key === 'lineSource'
              ? isPurchase
                ? purchase
                : sales
              : isPurchase
                ? sales
                : purchase,
        ],
      };
    };
    const facts = await commercialLinkedFacts(
      (isPurchase ? purchase : sales) as unknown as Parameters<
        typeof commercialLinkedFacts
      >[0],
      ns,
      isPurchase,
      invoke as unknown as Parameters<typeof commercialLinkedFacts>[3],
      (id) => {
        assert.equal(id, 'purchase-line');
        return 'received-id';
      },
    );
    assert.deepEqual(facts, {
      route: 'Special order',
      linkedLine: isPurchase ? 'sales-line' : 'purchase-line',
      linkedOrder: isPurchase ? 'sales-order' : 'purchase-order',
      arrived: '2.5',
    });
    assert.deepEqual(calls, ['lineSource', 'linkedLine', 'arrivals']);
  }
});

test('a denied arrival query does not fabricate zero received or expose cached links', async () => {
  const row = { recordId: 'line', values: {} } as Parameters<
    typeof commercialLinkedFacts
  >[0];
  const facts = await commercialLinkedFacts(
    row,
    'example.app',
    false,
    async () => {
      throw new SemanticQueryPolicyDeniedError('denied', {
        release: { releaseId: 'release', contentHash: 'hash' },
      } as never);
    },
  );
  assert.deepEqual(facts, {
    route: null,
    linkedLine: null,
    linkedOrder: null,
    arrived: null,
  });
});
