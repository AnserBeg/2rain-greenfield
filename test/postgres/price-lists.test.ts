import assert from 'node:assert/strict';
import test from 'node:test';

import { workspaceRestricted } from '../../apps/web/src/workspace-entry.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';

test(
  'SALES-EXTRAS price lists: a customer reads only its assigned active lists in a currency, each list its breaks for an item; a line names the list that priced it',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(async (fixture) => {
      const tenant = (
        local: string,
        values: Record<string, ImmutableJsonValue>,
        relations: Record<string, string> = {},
      ) => fixture.create(local, values, relations, false);
      const list = async (
        code: string,
        currency: 'cad' | 'usd',
        status: 'active' | 'inactive',
        priority: string,
        breaks: readonly (readonly [string, string])[],
        customers: readonly string[],
      ) => {
        const created = await tenant('price_list', {
          code,
          name: `${code} prices`,
          currency: `${ns}:option.price_list_currency_${currency}`,
          priority,
          status: `${ns}:option.price_list_status_${status}`,
        });
        for (const [minimum, price] of breaks)
          await tenant(
            'price_list_entry',
            {
              item_id: fixture.item,
              minimum_quantity: minimum,
              unit_price: price,
            },
            { price_list: created.recordId },
          );
        for (const party of customers)
          await tenant(
            'price_list_assignment',
            { party_id: party },
            { price_list: created.recordId },
          );
        return created.recordId;
      };
      const other = await tenant('party', {
        number: 'P-PRICE',
        name: 'Unlisted customer',
      });
      const wholesale = await list(
        'WHOLESALE',
        'cad',
        'active',
        '10',
        [
          ['1', '11'],
          ['10', '9.5'],
        ],
        [fixture.customer],
      );
      const retail = await list(
        'RETAIL',
        'cad',
        'active',
        '1',
        [['1', '12']],
        [fixture.customer, other.recordId],
      );
      await list(
        'EXPORT',
        'usd',
        'active',
        '20',
        [['1', '7']],
        [fixture.customer],
      );
      await list(
        'PROMO',
        'cad',
        'inactive',
        '99',
        [['1', '5']],
        [fixture.customer],
      );
      const plain = (value: unknown) => {
        const text = String(value);
        return text.includes('.')
          ? text.replace(/0+$/u, '').replace(/\.$/u, '')
          : text;
      };
      // The editor's own read of the tables a header party may be priced from.
      const tables = (party: string, currency: 'cad' | 'usd') =>
        fixture.app.runtime.entry.run({ headers: {} }, async (view) =>
          (
            await workspaceRestricted(
              view,
              fixture.app.runtime.queryGateway,
              `${ns}:query.price_list_list`,
              null,
              {
                relatedFilter: {
                  queryId: `${ns}:query.price_list_assignment_list`,
                  relationId: `${ns}:relation.price_list_assignment_price_list`,
                  fieldFilters: [
                    {
                      fieldId: `${ns}:field.price_list_assignment_party_id`,
                      value: party,
                    },
                  ],
                },
                fieldFilters: [
                  {
                    fieldId: `${ns}:field.price_list_currency`,
                    value: `${ns}:option.price_list_currency_${currency}`,
                  },
                  {
                    fieldId: `${ns}:field.price_list_status`,
                    value: `${ns}:option.price_list_status_active`,
                  },
                ],
              },
            )
          )
            .map((record) =>
              String(record.values[`${ns}:field.price_list_code`]),
            )
            .sort(),
        );
      assert.deepEqual(await tables(fixture.customer, 'cad'), [
        'RETAIL',
        'WHOLESALE',
      ]);
      assert.deepEqual(await tables(fixture.customer, 'usd'), ['EXPORT']);
      assert.deepEqual(await tables(other.recordId, 'cad'), ['RETAIL']);
      // A list's breaks for one item, through its owned relation.
      const breaks = (priceList: string) =>
        fixture.app.runtime.entry.run({ headers: {} }, async (view) =>
          (
            await workspaceRestricted(
              view,
              fixture.app.runtime.queryGateway,
              `${ns}:query.price_list_entry_list`,
              null,
              {
                parentScope: {
                  relationId: `${ns}:relation.price_list_entry_price_list`,
                  recordId: priceList,
                },
                fieldFilters: [
                  {
                    fieldId: `${ns}:field.price_list_entry_item_id`,
                    value: fixture.item,
                  },
                ],
              },
            )
          )
            .map(
              (record) =>
                `${plain(record.values[`${ns}:field.price_list_entry_minimum_quantity`])}@${plain(record.values[`${ns}:field.price_list_entry_unit_price`])}`,
            )
            .sort(),
        );
      assert.deepEqual(await breaks(wholesale), ['10@9.5', '1@11']);
      assert.deepEqual(await breaks(retail), ['1@12']);

      // A line a price list priced reads as that; a typed one as manual; a
      // line at the item's own list price as before.
      const order = await fixture.create('sales_order', {
        customer_party_id: fixture.customer,
        order_date: new Date().toISOString(),
        requested_date: null,
        currency: 'CAD',
        notes: null,
      });
      for (const [index, [unit, listed, priceList]] of (
        [
          ['9.5', '9.5', wholesale],
          ['9', '9.5', wholesale],
          ['12.5', '12.5', null],
        ] as const
      ).entries())
        await fixture.create(
          'sales_order_line',
          {
            item_id: fixture.item,
            unit_id: 'EA',
            line_number: String(index + 1),
            ordered_quantity: '12',
            unit_price: unit,
            list_price: listed,
            price_list_id: priceList,
          },
          { order: order.recordId },
        );
      const lines = await fixture.app.runtime.entry.run(
        { headers: {} },
        (view) => {
          const definition = registeredSemanticQueryFromPinnedView(
            view,
            `${ns}:query.commercial_order_lines`,
          )!;
          return fixture.app.runtime.queryGateway.invoke(view, {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId: definition.queryId,
            arguments: {
              includeArchived: false,
              [definition.legalEntityScope!.operand.parameterId]: fixture.scope,
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
                  recordId: order.recordId,
                },
              },
            },
          });
        },
      );
      assert.deepEqual(
        lines.records.map(
          (record) => record.values[`${ns}:metric.price_basis`],
        ),
        ['Price list', 'Manual price', 'List price'],
      );
    });
  },
);
