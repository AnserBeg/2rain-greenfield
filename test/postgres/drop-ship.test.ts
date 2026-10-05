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
import { readCompiledSurfaceManifest } from '../../apps/web/src/surface-contract.js';
import {
  declaredListArguments,
  readDeclaredListState,
} from '../../apps/web/src/list-declaration.js';

const ns = 'northstar.app';
const field = (local: string) => `${ns}:field.${local}`;
const relation = (local: string) => `${ns}:relation.${local}`;
const option = (local: string) => `${ns}:option.${local}`;
const shipTo = {
  ship_to_name: 'Customer dock',
  ship_to_street: '82 Customer Way',
  ship_to_city: 'Calgary',
  ship_to_region: 'AB',
  ship_to_postal_code: 'T2P 0A1',
  ship_to_country: 'Canada',
};

test('D-A/B/C: linked supplier delivery settles both orders without stock and reverses only above live settlement floors', async () => {
  await withOrderEntryFixture(async (fixture) => {
    const read = (
      local: string,
      arguments_: Record<string, ImmutableJsonValue> = {},
    ) =>
      fixture.app.runtime.entry.run({ headers: {} }, (view) => {
        const queryId = `${ns}:query.${local}`;
        const definition = registeredSemanticQueryFromPinnedView(
          view,
          queryId,
        )!;
        return fixture.app.runtime.queryGateway.invoke(view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId,
          arguments: {
            ...arguments_,
            ...(definition.legalEntityScope
              ? {
                  [definition.legalEntityScope.operand.parameterId]:
                    fixture.scope,
                }
              : {}),
          },
        });
      });
    const get = async (
      local: string,
      recordId: string,
      targets: string[] = [],
    ) =>
      (
        await read(`${local}_get`, {
          recordId,
          includeArchived: false,
          ...(targets.length ? { relationTargets: targets.map(relation) } : {}),
        })
      ).records[0]!;
    const list = async (
      local: string,
      scope?: {
        kind: 'parentScope' | 'referenceScope';
        relation: string;
        recordId: string;
      },
    ) =>
      (
        await read(local, {
          includeArchived: false,
          list: {
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            cursor: null,
            matchMode: 'substring',
            pageSize: 100,
            search: '',
            sort: [],
            relationLabels: [],
            ...(scope
              ? {
                  [scope.kind]: {
                    relationId: relation(scope.relation),
                    recordId: scope.recordId,
                  },
                }
              : {}),
          },
        })
      ).records;
    const command = async (
      name: string,
      record: SemanticRecordDto,
      arguments_?: Record<string, ImmutableJsonValue>,
      key?: ReturnType<typeof randomUUID>,
    ) => {
      const result = await fixture.invoke(
        name,
        {
          recordId: record.recordId,
          expectedRevision: record.revision,
          ...(arguments_ ? { arguments: arguments_ } : {}),
        },
        key,
      );
      assert.equal(result.outcome, 'succeeded');
      assert.ok(result.trust);
      return result.readBack!;
    };
    const orderProgress = (
      side: 'sales' | 'purchase',
      recordId: string,
      openOnly = false,
    ) =>
      fixture.app.runtime.entry.run({ headers: {} }, async (view) => {
        const surface = readCompiledSurfaceManifest(view).surfaces.find(
          (surface) => surface.surfaceId === `${ns}:surface.${side}_order_list`,
        )!;
        const declaration = surface.list!;
        const tab = declaration.views.find((tab) => tab.open)!;
        const state = readDeclaredListState(
          declaration,
          new URL(
            `http://list.local/${openOnly ? `?view=${encodeURIComponent(tab.viewId)}` : ''}`,
          ),
        );
        const definition = registeredSemanticQueryFromPinnedView(
          view,
          surface.dataSourceQueryId,
        )!;
        const result = await fixture.app.runtime.queryGateway.invoke(view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId: definition.queryId,
          arguments: declaredListArguments(declaration, state, {
            mode: 'export',
            now: new Date('2026-10-01T00:00:00Z'),
            queryId: definition.queryId,
            scopeArguments: {
              [definition.legalEntityScope!.operand.parameterId]: fixture.scope,
            },
          }),
        });
        return {
          row: result.records.find((row) => row.recordId === recordId),
          coverage: result.listCoverage,
        };
      });
    const draft = await fixture.create('sales_order', {
      customer_party_id: fixture.customer,
      order_date: new Date().toISOString(),
      requested_date: null,
      currency: 'CAD',
      ...shipTo,
    });
    await assert.rejects(
      () =>
        fixture.create(
          'sales_order_line',
          {
            line_number: '1',
            item_id: fixture.item,
            unit_id: 'EA',
            ordered_quantity: '5',
            fulfillment_route: option('fulfillment_route_drop_ship'),
          },
          { order: draft.recordId },
        ),
      /requires a supplier/u,
    );
    const salesLine = await fixture.create(
      'sales_order_line',
      {
        line_number: '1',
        item_id: fixture.item,
        unit_id: 'EA',
        ordered_quantity: '5',
        unit_price: '12',
        fulfillment_route: option('fulfillment_route_drop_ship'),
        drop_ship_supplier_id: fixture.customer,
      },
      { order: draft.recordId },
    );
    await assert.rejects(
      () => command('sales_order_create_drop_ship_po', draft),
      /precondition|confirmed/iu,
    );
    let salesOrder = await command('sales_order_release', draft);
    const supplierRole = (
      await list('party_role_list', {
        kind: 'parentScope',
        relation: 'party_role_party',
        recordId: fixture.customer,
      })
    ).find(
      (row) => row.values[field('party_role_kind')] === option('supplier'),
    )!;
    const inactiveRole = await fixture.invoke('party_role_update', {
      recordId: supplierRole.recordId,
      expectedRevision: supplierRole.revision,
      patch: { [field('party_role_status')]: option('inactive') },
    });
    await assert.rejects(
      () => command('sales_order_create_drop_ship_po', salesOrder),
      /active supplier/u,
    );
    await fixture.invoke('party_role_update', {
      recordId: supplierRole.recordId,
      expectedRevision: inactiveRole.readBack!.revision,
      patch: { [field('party_role_status')]: option('active') },
    });
    const createKey = randomUUID();
    const inputRevision = salesOrder.revision;
    salesOrder = await command(
      'sales_order_create_drop_ship_po',
      salesOrder,
      undefined,
      createKey,
    );
    const linkedSalesLine = await get('sales_order_line', salesLine.recordId, [
      'sales_order_line_purchase_line',
    ]);
    const purchaseLineId =
      linkedSalesLine.relationLabels![
        relation('sales_order_line_purchase_line')
      ]!.recordId;
    assert.ok(purchaseLineId);
    const purchaseLine = await get('purchase_order_line', purchaseLineId, [
      'purchase_order_line_order',
      'purchase_order_line_sales_line',
    ]);
    assert.equal(
      purchaseLine.relationLabels![relation('purchase_order_line_sales_line')]!
        .recordId,
      salesLine.recordId,
    );
    const purchaseId =
      purchaseLine.relationLabels![relation('purchase_order_line_order')]!
        .recordId!;
    let purchaseOrder = await get('purchase_order', purchaseId);
    await assert.rejects(
      () =>
        fixture.invoke('purchase_order_update', {
          recordId: purchaseId,
          expectedRevision: purchaseOrder.revision,
          patch: {
            [field('purchase_order_ship_to_street')]: 'Wrong warehouse',
          },
        }),
      /customer ship-to/u,
    );
    assert.equal(
      purchaseOrder.values[field('purchase_order_ship_to_street')],
      shipTo.ship_to_street,
    );
    const unchangedHeader = await fixture.invoke('purchase_order_update', {
      recordId: purchaseId,
      expectedRevision: purchaseOrder.revision,
      patch: {
        [field('purchase_order_supplier_party_id')]: fixture.customer,
        [field('purchase_order_currency')]: 'CAD',
        [field('purchase_order_ship_to_street')]: shipTo.ship_to_street,
      },
    });
    purchaseOrder = unchangedHeader.readBack!;
    await fixture.invoke(
      'sales_order_create_drop_ship_po',
      { recordId: salesOrder.recordId, expectedRevision: inputRevision },
      createKey,
    );
    await command('sales_order_create_drop_ship_po', salesOrder);
    assert.equal(
      (await list('purchase_order_line_list')).filter(
        (line) => line.recordId === purchaseLineId,
      ).length,
      1,
    );
    await fixture.invoke('purchase_order_line_update', {
      recordId: purchaseLineId,
      expectedRevision: purchaseLine.revision,
      patch: { [field('purchase_order_line_unit_price')]: '7' },
    });
    const reservation = await fixture.create(
      'reservation',
      {
        number: randomUUID(),
        state: option('reservation_state_draft'),
        item_id: fixture.item,
        location_id: fixture.location,
        quantity: '1',
        unit_id: 'EA',
        reason: 'Route control',
      },
      { order_line: salesLine.recordId },
    );
    await assert.rejects(
      () => command('reservation_reserve', reservation),
      /never reserve/u,
    );
    await assert.rejects(
      () =>
        command('purchase_order_record_delivery', purchaseOrder, {
          purchaseLineId,
          quantity: '1',
        }),
      /precondition|placed/iu,
    );
    purchaseOrder = await command('purchase_order_release', purchaseOrder);
    await fixture.measure(
      'deny',
      undefined,
      undefined,
      'purchase_order_record_delivery',
    );
    await assert.rejects(
      () =>
        command('purchase_order_record_delivery', purchaseOrder, {
          purchaseLineId,
          quantity: '1',
        }),
      /POLICY_DENIED|permission|denied/iu,
    );
    await fixture.measure(
      'allow',
      undefined,
      undefined,
      'purchase_order_record_delivery',
    );
    const stockBefore = (await list('inventory_movement_list'))
      .map((row) => row.recordId)
      .sort();
    await assert.rejects(
      () =>
        command('purchase_order_record_delivery', purchaseOrder, {
          purchaseLineId,
          quantity: '6',
        }),
      /exceeds.*open/u,
    );
    const deliveryKey = randomUUID();
    const deliveryPin = purchaseOrder.revision;
    purchaseOrder = await command(
      'purchase_order_record_delivery',
      purchaseOrder,
      { purchaseLineId, quantity: '2', reference: 'SUP-DEL-1' },
      deliveryKey,
    );
    await fixture.invoke(
      'purchase_order_record_delivery',
      {
        recordId: purchaseId,
        expectedRevision: deliveryPin,
        arguments: { purchaseLineId, quantity: '2', reference: 'SUP-DEL-1' },
      },
      deliveryKey,
    );
    let deliveries = await list('drop_ship_delivery_list', {
      kind: 'referenceScope',
      relation: 'drop_ship_delivery_purchase_order',
      recordId: purchaseId,
    });
    assert.equal(deliveries.length, 1);
    assert.equal(
      deliveries[0]!.values[field('drop_ship_delivery_number')],
      'DSD-000001',
    );
    assert.equal(
      deliveries[0]!.values[field('drop_ship_delivery_external_reference')],
      'SUP-DEL-1',
    );
    assert.deepEqual(
      (await list('inventory_movement_list')).map((row) => row.recordId).sort(),
      stockBefore,
    );
    let progress = (
      await list('commercial_purchase_order_lines', {
        kind: 'parentScope',
        relation: 'purchase_order_line_order',
        recordId: purchaseId,
      })
    )[0]!;
    assert.equal(
      Number(progress.values[`${ns}:metric.purchase_line_delivered`]),
      2,
    );
    assert.equal(Number(progress.values[`${ns}:metric.received`]), 0);
    assert.equal(Number(progress.values[`${ns}:metric.open_to_receive`]), 3);
    let fulfillment = (
      await list('fulfillment_order_lines', {
        kind: 'parentScope',
        relation: 'sales_order_line_order',
        recordId: salesOrder.recordId,
      })
    )[0]!;
    assert.equal(Number(fulfillment.values[`${ns}:metric.line_delivered`]), 2);
    assert.equal(Number(fulfillment.values[`${ns}:metric.shipped`]), 0);
    assert.equal(Number(fulfillment.values[`${ns}:metric.open_to_ship`]), 3);
    for (const [side, recordId] of [
      ['sales', salesOrder.recordId],
      ['purchase', purchaseId],
    ] as const) {
      const { row } = await orderProgress(side, recordId);
      assert.ok(row);
      assert.equal(
        Number(row.values[`${ns}:list_output.${side}_order_list_delivered`]),
        2,
      );
      assert.equal(
        Number(row.values[`${ns}:list_output.${side}_order_list_open`]),
        3,
      );
      assert.equal(
        Number(
          row.values[
            `${ns}:list_output.${side}_order_list_${side === 'sales' ? 'shipped' : 'received'}`
          ],
        ),
        0,
      );
    }
    await assert.rejects(
      () => command('purchase_order_close', purchaseOrder),
      /every line/u,
    );
    const invoice = await fixture.create(
      'customer_invoice',
      {
        state: option('customer_invoice_state_draft'),
        invoice_date: new Date().toISOString(),
      },
      { order: salesOrder.recordId },
    );
    let postedInvoice = await command('customer_invoice_post', invoice);
    const bill = await fixture.create(
      'vendor_bill',
      {
        state: option('vendor_bill_state_draft'),
        bill_date: new Date().toISOString(),
      },
      { order: purchaseId },
    );
    let postedBill = await command('vendor_bill_post', bill);
    assert.equal(
      Number(postedInvoice.values[field('customer_invoice_total')]),
      24,
    );
    assert.equal(Number(postedBill.values[field('vendor_bill_total')]), 14);
    await assert.rejects(
      () =>
        command('drop_ship_delivery_reverse', deliveries[0]!, {
          reason: 'Supplier correction',
        }),
      /Void the live invoice or bill/u,
    );
    await assert.rejects(
      () =>
        fixture.invoke('drop_ship_delivery_update', {
          recordId: deliveries[0]!.recordId,
          expectedRevision: deliveries[0]!.revision,
          patch: { [field('drop_ship_delivery_quantity')]: '9' },
        }),
      /precondition/iu,
    );
    postedInvoice = await command('customer_invoice_void', postedInvoice);
    await assert.rejects(
      () =>
        command('drop_ship_delivery_reverse', deliveries[0]!, {
          reason: 'Supplier correction',
        }),
      /Void the live invoice or bill/u,
    );
    postedBill = await command('vendor_bill_void', postedBill);
    assert.ok(postedInvoice);
    assert.ok(postedBill);
    const reversed = await command(
      'drop_ship_delivery_reverse',
      deliveries[0]!,
      { reason: 'Supplier correction' },
    );
    assert.equal(
      reversed.values[field('drop_ship_delivery_state')],
      option('drop_ship_delivery_state_reversed'),
    );
    assert.equal(
      Number(reversed.values[field('drop_ship_delivery_quantity')]),
      2,
      'Original fact is preserved',
    );
    assert.equal(
      reversed.values[field('drop_ship_delivery_reversal_reason')],
      'Supplier correction',
    );
    purchaseOrder = await get('purchase_order', purchaseId);
    purchaseOrder = await command(
      'purchase_order_record_delivery',
      purchaseOrder,
      { purchaseLineId, quantity: '5' },
    );
    deliveries = await list('drop_ship_delivery_list', {
      kind: 'referenceScope',
      relation: 'drop_ship_delivery_purchase_order',
      recordId: purchaseId,
    });
    assert.deepEqual(
      deliveries
        .map((row) => row.values[field('drop_ship_delivery_number')])
        .sort(),
      ['DSD-000001', 'DSD-000002'],
    );
    progress = (
      await list('commercial_purchase_order_lines', {
        kind: 'parentScope',
        relation: 'purchase_order_line_order',
        recordId: purchaseId,
      })
    )[0]!;
    fulfillment = (
      await list('fulfillment_order_lines', {
        kind: 'parentScope',
        relation: 'sales_order_line_order',
        recordId: salesOrder.recordId,
      })
    )[0]!;
    assert.equal(Number(progress.values[`${ns}:metric.open_to_receive`]), 0);
    assert.equal(Number(fulfillment.values[`${ns}:metric.open_to_ship`]), 0);
    assert.equal(
      (await orderProgress('sales', salesOrder.recordId, true)).row,
      undefined,
    );
    assert.equal(
      (await orderProgress('purchase', purchaseId, true)).row,
      undefined,
    );
    await command('purchase_order_close', purchaseOrder);
    await command(
      'sales_order_close',
      await get('sales_order', salesOrder.recordId),
    );
    assert.deepEqual(
      (await list('inventory_movement_list')).map((row) => row.recordId).sort(),
      stockBefore,
    );
  });
});
