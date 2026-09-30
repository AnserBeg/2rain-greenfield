import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  registeredSemanticQueryFromPinnedView,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';
import { SemanticOperationPolicyDeniedError } from '../../packages/runtime/src/semantic-operation-gateway.js';

const ns = 'northstar.app';
const field = (local: string, name: string) => `${ns}:field.${local}_${name}`;
const quantity = (value: unknown) =>
  String(value)
    .replace(/(\.\d*?)0+$/u, '$1')
    .replace(/\.$/u, '');

test(
  'APPROVAL-PO: trusted decisions, exact revision gating, replay, staged amendments and continued receiving',
  { timeout: 300_000 },
  async () => {
    await withOrderEntryFixture(
      async (f) => {
        const read = (
          local: string,
          args: Record<string, ImmutableJsonValue> = {},
          actor: 'buyer' | 'manager' = 'buyer',
        ) =>
          f.app.runtime.entry.run(
            { headers: { cookie: `northstar-demo-actor=${actor}` } },
            (view) => {
              const definition = registeredSemanticQueryFromPinnedView(
                view,
                `${ns}:query.${local}`,
              )!;
              return f.app.runtime.queryGateway.invoke(view, {
                schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
                queryId: definition.queryId,
                arguments: {
                  includeArchived: false,
                  ...args,
                  ...(definition.legalEntityScope
                    ? {
                        [definition.legalEntityScope.operand.parameterId]:
                          f.scope,
                      }
                    : {}),
                },
              });
            },
          );
        const get = async (local: string, id: string) =>
          (await read(`${local}_get`, { recordId: id })).records[0]!;
        const requests = async () =>
          (await read('purchase_order_approval_list')).records;
        const pending = async () =>
          (await requests()).find(
            (r) =>
              r.values[field('purchase_order_approval', 'state')] ===
              `${ns}:option.purchase_order_approval_state_pending`,
          )!;
        const order = await f.create('purchase_order', {
          supplier_party_id: f.customer,
          order_date: new Date().toISOString(),
          expected_date: null,
          currency: 'CAD',
          notes: null,
        });
        const line = await f.create(
          'purchase_order_line',
          {
            line_number: '1',
            item_id: f.item,
            ordered_quantity: '5',
            unit_price: '12.5',
          },
          { order: order.recordId },
        );
        const operate = async (
          operation: string,
          local: string,
          id: string,
          args: Record<string, ImmutableJsonValue> = {},
          actor: 'buyer' | 'manager' = 'buyer',
          key = randomUUID(),
        ) => {
          const current = await get(local, id);
          return f.invoke(
            operation,
            {
              recordId: id,
              expectedRevision: current.revision,
              arguments: args,
            },
            key,
            actor,
          );
        };
        const decide = async (
          decision: 'approve' | 'reject',
          reason: string,
          actor: 'buyer' | 'manager' = 'manager',
        ) => {
          const request = await pending();
          return operate(
            `purchase_order_approval_${decision}`,
            'purchase_order_approval',
            request.recordId,
            { reason },
            actor,
          );
        };
        await assert.rejects(
          operate('purchase_order_release', 'purchase_order', order.recordId),
          /current header and line revision/u,
        );
        const submitInput = {
          recordId: order.recordId,
          expectedRevision: order.revision,
        };
        const submitKey = randomUUID();
        const submitted = await f.invoke(
          'purchase_order_submit',
          submitInput,
          submitKey,
        );
        const replay = await f.invoke(
          'purchase_order_submit',
          submitInput,
          submitKey,
        );
        assert.deepEqual(replay.trust, submitted.trust);
        assert.equal((await requests()).length, 1);
        const first = await pending();
        await assert.rejects(
          decide(
            'approve',
            'Buyer must not have the approve permission',
            'buyer',
          ),
          (error: unknown) =>
            error instanceof SemanticOperationPolicyDeniedError,
        );
        assert.equal(
          (await get('purchase_order_approval', first.recordId)).revision,
          1,
        );
        await decide('reject', 'Please correct the quantity');
        const rejected = await get('purchase_order_approval', first.recordId);
        assert.equal(
          rejected.values[field('purchase_order_approval', 'decision_reason')],
          'Please correct the quantity',
        );
        const manager = await f.app.runtime.entry.run(
          { headers: { cookie: 'northstar-demo-actor=manager' } },
          (view) => view.principalId,
        );
        assert.equal(
          rejected.values[field('purchase_order_approval', 'decided_by')],
          manager,
        );
        assert.equal(
          first.values[field('purchase_order_approval', 'requested_by')],
          f.app.runtime.identity.principalId,
        );
        assert.notEqual(manager, f.app.runtime.identity.principalId);
        await operate(
          'purchase_order_submit',
          'purchase_order',
          order.recordId,
        );
        const stale = await pending();
        await f.invoke('purchase_order_line_update', {
          recordId: line.recordId,
          expectedRevision: line.revision,
          patch: { [field('purchase_order_line', 'ordered_quantity')]: '6' },
        });
        await assert.rejects(
          decide('approve', 'Old revision'),
          /purchase order changed/u,
        );
        await decide('reject', 'Superseded by an edit');
        assert.equal(
          (await get('purchase_order_approval', stale.recordId)).values[
            field('purchase_order_approval', 'state')
          ],
          `${ns}:option.purchase_order_approval_state_rejected`,
        );
        await operate(
          'purchase_order_submit',
          'purchase_order',
          order.recordId,
        );
        const approved = await pending();
        await decide('approve', 'Checked supplier and quantity');
        await operate(
          'purchase_order_release',
          'purchase_order',
          order.recordId,
          { supplierReference: 'SUP-7781' },
        );
        const placed = await get('purchase_order', order.recordId);
        assert.equal(
          placed.values[
            `${ns}:derived_state_field.machine.purchase_order_lifecycle`
          ],
          `${ns}:state.purchase_order_released`,
        );
        assert.equal(
          placed.values[field('purchase_order', 'supplier_reference')],
          'SUP-7781',
        );
        assert.equal(
          (await get('purchase_order_approval', approved.recordId)).values[
            field('purchase_order_approval', 'state')
          ],
          `${ns}:option.purchase_order_approval_state_consumed`,
        );

        const receive = async (amount: string) => {
          const receipt = await f.create(
            'goods_receipt',
            {
              state: `${ns}:option.goods_receipt_state_draft`,
              kind: `${ns}:option.goods_receipt_kind_initial`,
              effective_at: new Date().toISOString(),
              location_id: f.location,
              reason_code: 'RECEIVE',
              reason_narrative: 'Receiving while amendment is pending',
            },
            { order: order.recordId },
          );
          await f.create(
            'goods_receipt_line',
            {
              line_number: '1',
              item_id: f.item,
              quantity: amount,
              unit_id: 'EA',
              cost_status: `${ns}:option.goods_receipt_line_cost_status_absent`,
              unit_cost: null,
              currency: null,
              reversal_of_movement_id: null,
            },
            { receipt: receipt.recordId, order_line: line.recordId },
          );
          const result = await f.invoke('goods_receipt_post', {
            recordId: receipt.recordId,
            expectedRevision: receipt.revision,
          });
          assert.equal(result.outcome, 'succeeded');
        };
        await operate(
          'purchase_order_line_amend',
          'purchase_order_line',
          line.recordId,
          { quantity: '8', reason: 'More stock needed' },
        );
        assert.equal(
          quantity(
            (await get('purchase_order_line', line.recordId)).values[
              field('purchase_order_line', 'ordered_quantity')
            ],
          ),
          '6',
        );
        await receive('2');
        await decide('reject', 'Keep the existing order');
        assert.equal(
          quantity(
            (await get('purchase_order_line', line.recordId)).values[
              field('purchase_order_line', 'ordered_quantity')
            ],
          ),
          '6',
        );
        await operate(
          'purchase_order_line_amend',
          'purchase_order_line',
          line.recordId,
          { quantity: '8', reason: 'Demand confirmed' },
        );
        await receive('1');
        await decide('approve', 'Supplier agreed');
        assert.equal(
          quantity(
            (await get('purchase_order_line', line.recordId)).values[
              field('purchase_order_line', 'ordered_quantity')
            ],
          ),
          '8',
        );
        await operate(
          'purchase_order_line_amend',
          'purchase_order_line',
          line.recordId,
          { quantity: '2', reason: 'Below receipts' },
        );
        await assert.rejects(
          decide('approve', 'Cannot discard the three received units'),
          /below received quantity/u,
        );
        assert.equal(
          (await pending()).values[field('purchase_order_approval', 'state')],
          `${ns}:option.purchase_order_approval_state_pending`,
        );
        assert.equal(
          quantity(
            (await get('purchase_order_line', line.recordId)).values[
              field('purchase_order_line', 'ordered_quantity')
            ],
          ),
          '8',
        );
        await decide('reject', 'Receipt floor respected');
        assert.equal(
          (await requests()).filter(
            (r) =>
              r.values[field('purchase_order_approval', 'state')] ===
              `${ns}:option.purchase_order_approval_state_pending`,
          ).length,
          0,
        );
        // A2 is permission-gated, not maker-checker: a Manager may decide their own request.
        const ownOrder = await f.create('purchase_order', {
          supplier_party_id: f.customer,
          order_date: new Date().toISOString(),
          expected_date: null,
          currency: 'CAD',
          notes: null,
        });
        await f.create(
          'purchase_order_line',
          {
            line_number: '1',
            item_id: f.item,
            ordered_quantity: '1',
            unit_price: '12.5',
          },
          { order: ownOrder.recordId },
        );
        await operate(
          'purchase_order_submit',
          'purchase_order',
          ownOrder.recordId,
          {},
          'manager',
        );
        const ownRequest = await pending();
        assert.equal(
          ownRequest.values[field('purchase_order_approval', 'requested_by')],
          manager,
        );
        await decide('approve', 'Manager holds the approve permission');
        assert.equal(
          (await get('purchase_order_approval', ownRequest.recordId)).values[
            field('purchase_order_approval', 'decided_by')
          ],
          manager,
        );
        await operate(
          'purchase_order_release',
          'purchase_order',
          ownOrder.recordId,
          {},
          'manager',
        );
        // A tenant has no approval requirement unless it opts in. Turn it off through its governed setting, not SQL.
        const setting = (await read('purchasing_settings_list', {}, 'manager'))
          .records[0]!;
        await f.invoke(
          'purchasing_settings_update',
          {
            recordId: setting.recordId,
            expectedRevision: setting.revision,
            patch: {
              [field('purchasing_settings', 'require_approval')]: false,
            },
          },
          randomUUID(),
          'manager',
        );
        const unrequired = await f.create('purchase_order', {
          supplier_party_id: f.customer,
          order_date: new Date().toISOString(),
          expected_date: null,
          currency: 'CAD',
          notes: null,
        });
        await operate(
          'purchase_order_release',
          'purchase_order',
          unrequired.recordId,
        );
        assert.equal(
          (await get('purchase_order', unrequired.recordId)).values[
            `${ns}:derived_state_field.machine.purchase_order_lifecycle`
          ],
          `${ns}:state.purchase_order_released`,
        );
      },
      'demo',
      0,
      0,
      undefined,
      true,
    );
  },
);
