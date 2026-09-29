import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const refusedWith = (code: string) => (error: unknown) =>
  (error as { code?: unknown }).code === code;

test(
  'PURCHASING-PARITY: a received order is never cancelled; a line’s open remainder closes with a reason, then the order closes',
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
      const order = async (orderId: string) => {
        const read = await query('purchase_order_get', {
          recordId: orderId,
          includeArchived: false,
        });
        const record = read.records[0]!;
        return {
          revision: record.revision,
          state: String(
            record.values[
              `${ns}:derived_state_field.machine.purchase_order_lifecycle`
            ],
          ).split('.purchase_order_')[1],
        };
      };
      // Ordered, received and still open, per line, as the order page reads
      // them.
      const progress = async (orderId: string) =>
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
        ).records.map((record) => [
          record.values[`${ns}:field.purchase_order_line_ordered_quantity`],
          metric(record, 'received'),
          metric(record, 'open_to_receive'),
        ]);
      const released = async () => {
        const created = await fixture.create('purchase_order', {
          supplier_party_id: fixture.customer,
          order_date: new Date().toISOString(),
          expected_date: null,
          currency: 'CAD',
          notes: null,
        });
        const line = await fixture.create(
          'purchase_order_line',
          {
            line_number: '1',
            item_id: fixture.item,
            ordered_quantity: '5',
            unit_price: null,
          },
          { order: created.recordId },
        );
        const release = await fixture.invoke('purchase_order_release', {
          recordId: created.recordId,
          expectedRevision: created.revision,
        });
        assert.equal(release.outcome, 'succeeded');
        return { orderId: created.recordId, line };
      };
      const lifecycle = async (
        action: 'cancel' | 'close' | 'reopen',
        orderId: string,
      ) =>
        fixture.invoke(`purchase_order_${action}`, {
          recordId: orderId,
          expectedRevision: (await order(orderId)).revision,
        });

      const partly = await released();
      assert.deepEqual(await progress(partly.orderId), [['5', '0', '5']]);
      // Two of five arrive.
      const receipt = await fixture.create(
        'goods_receipt',
        {
          state: `${ns}:option.goods_receipt_state_draft`,
          kind: `${ns}:option.goods_receipt_kind_initial`,
          effective_at: new Date().toISOString(),
          location_id: fixture.location,
          reason_code: 'RECEIVE',
          reason_narrative: 'Partial delivery',
        },
        { order: partly.orderId },
      );
      await fixture.create(
        'goods_receipt_line',
        {
          line_number: '1',
          item_id: fixture.item,
          quantity: '2',
          unit_id: 'EA',
          cost_status: `${ns}:option.goods_receipt_line_cost_status_absent`,
          unit_cost: null,
          currency: null,
          reversal_of_movement_id: null,
        },
        { receipt: receipt.recordId, order_line: partly.line.recordId },
      );
      const posted = await fixture.invoke('goods_receipt_post', {
        recordId: receipt.recordId,
        expectedRevision: receipt.revision,
      });
      assert.equal(posted.outcome, 'succeeded');
      assert.deepEqual(await progress(partly.orderId), [['5', '2', '3']]);

      // Received goods are never cancelled away, and three are still open.
      await assert.rejects(
        lifecycle('cancel', partly.orderId),
        refusedWith('RECEIPT_QUANTITY_OUT_OF_BOUNDS'),
      );
      await assert.rejects(
        lifecycle('close', partly.orderId),
        refusedWith('RECEIPT_QUANTITY_OUT_OF_BOUNDS'),
      );
      assert.equal((await order(partly.orderId)).state, 'released');

      // The open remainder is closed with a reason: ordered becomes what is
      // received when the amend runs, not the quantity the operator saw. Two
      // such requests for the line's revision (a retry after a refusal, a
      // second tab) are one intent and are consumed together; one of them
      // names a stale quantity below what was received.
      const closeRequest = (quantity: string) =>
        fixture.create(
          'purchase_order_amendment',
          {
            number: randomUUID(),
            line_revision: String(partly.line.revision),
            quantity,
            reason: 'Supplier discontinued the rest',
            close_remainder: true,
          },
          { order_line: partly.line.recordId },
        );
      const first = await closeRequest('1');
      const second = await closeRequest('2');
      const amended = await fixture.invoke('purchase_order_line_amend', {
        recordId: partly.line.recordId,
        expectedRevision: partly.line.revision,
      });
      assert.equal(amended.outcome, 'succeeded');
      assert.deepEqual(await progress(partly.orderId), [['2', '2', '0']]);
      for (const request of [first, second])
        assert.equal(
          (
            await query('purchase_order_amendment_get', {
              recordId: request.recordId,
              includeArchived: true,
            })
          ).records[0]?.archived,
          true,
          'every staged close request is consumed',
        );

      assert.equal(
        (await lifecycle('close', partly.orderId)).outcome,
        'succeeded',
      );
      assert.equal((await order(partly.orderId)).state, 'closed');
      // Reopened, it is still an order with receipts: cancel stays refused.
      assert.equal(
        (await lifecycle('reopen', partly.orderId)).outcome,
        'succeeded',
      );
      await assert.rejects(
        lifecycle('cancel', partly.orderId),
        refusedWith('RECEIPT_QUANTITY_OUT_OF_BOUNDS'),
      );

      // A plain quantity request beside a close request is two intents: the
      // amend refuses rather than choosing between them.
      const untouched = await released();
      for (const [quantity, close_remainder] of [
        ['4', null],
        ['0', true],
      ] as const)
        await fixture.create(
          'purchase_order_amendment',
          {
            number: randomUUID(),
            line_revision: String(untouched.line.revision),
            quantity,
            reason: 'Two intents',
            close_remainder,
          },
          { order_line: untouched.line.recordId },
        );
      await assert.rejects(
        fixture.invoke('purchase_order_line_amend', {
          recordId: untouched.line.recordId,
          expectedRevision: untouched.line.revision,
        }),
        refusedWith('INVENTORY_POSTING_INPUT_INVALID'),
      );
      assert.deepEqual(await progress(untouched.orderId), [['5', '0', '5']]);

      // An order with nothing received cancels, through the same route.
      assert.equal(
        (await lifecycle('cancel', untouched.orderId)).outcome,
        'succeeded',
      );
      assert.equal((await order(untouched.orderId)).state, 'cancelled');

      // What has arrived re-enters current authority over the receiving
      // projection: withheld, neither received nor open is stated.
      await fixture.measure(
        'deny',
        undefined,
        undefined,
        'purchase_order_received_read',
      );
      assert.deepEqual(await progress(partly.orderId), [['2', null, null]]);
      await fixture.measure(
        'allow',
        undefined,
        undefined,
        'purchase_order_received_read',
      );
      assert.deepEqual(await progress(partly.orderId), [['2', '2', '0']]);
    });
  },
);
