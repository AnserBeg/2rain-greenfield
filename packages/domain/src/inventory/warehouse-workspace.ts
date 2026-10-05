/**
 * Warehouse mode (WAREHOUSE-MODE): the Task floor staff open first, entered
 * in one company like any workspace. Large tiles open the work the Lists
 * already hold -- the purchase orders with something still to arrive, the
 * transfers that put stock away, the sales orders with something still to
 * ship -- each with that List view's count; the scan box opens the document a
 * scanned or typed number names, or the item a SKU names, at its stock.
 *
 * The Task reads the on-hand lookup's own company-scoped query, the read its
 * archetype binds; the launcher reads nothing else but the declared Lists and
 * resolve queries, each under current policy, and posts nothing: receiving,
 * putting away and shipping stay the Tasks and documents the records already
 * offer. Counting stock waits for STOCK-COUNTS, so it has no tile yet.
 */
export function warehouseSurface(namespace: string): Record<string, unknown> {
  const id = (kind: string, name: string) => `${namespace}:${kind}.${name}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const slot = (name: string, orderKey: number) => ({
    content: ref(
      'opaqueSurfaceContentReference',
      id('capability', 'standard_surface_content'),
    ),
    kind: 'surfaceSlot',
    orderKey,
    schemaVersion: 'v6',
    slot: name,
    slotId: id(
      'slot',
      `inventory_warehouse_${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
    ),
  });
  const tile = (
    name: string,
    label: string,
    description: string,
    orderKey: number,
    list: string,
    view: string,
  ) => ({
    tileId: id('launcher_tile', `inventory_warehouse_${name}`),
    label,
    description,
    orderKey,
    surface: id('surface', list),
    view: id('list_view', `${list}_${view}`),
  });
  // Documents by their server-assigned numbers (PO-, SO-, RCV-, SHP-, STK-),
  // then an item by its SKU: the first exact identifier, in this order, opens.
  const target = (local: string, page = `${local}_detail`) => ({
    query: id('query', `${local}_resolve`),
    surface: id('surface', page),
  });
  return {
    archetype: 'task',
    dataSource: ref(
      'queryReference',
      id('query', 'inventory_movement_on_hand'),
    ),
    kind: 'surfaceDefinition',
    label: 'Warehouse',
    launcher: {
      kind: 'surfaceLauncher',
      schemaVersion: 'v6',
      tiles: [
        tile(
          'receive',
          'Receive',
          'Purchase orders with something still to arrive. Open one to receive its lines.',
          10,
          'expected_receipt_list',
          'to_receive',
        ),
        tile(
          'put_away',
          'Put away',
          'Transfers that move stock to where it is kept. New starts a transfer document.',
          20,
          'inventory_transaction_list',
          'transfers',
        ),
        tile(
          'pick_ship',
          'Pick and ship',
          'Sales orders with something still to ship. Open one to reserve and ship its lines.',
          30,
          'sales_order_list',
          'to_ship',
        ),
      ],
      scan: {
        label: 'Scan or type a SKU or document number',
        actionLabel: 'Open',
        targets: [
          target('purchase_order'),
          target('sales_order'),
          target('goods_receipt'),
          target('shipment'),
          target('inventory_transaction'),
          target('item'),
        ],
      },
    },
    module: ref('moduleReference', id('module', 'inventory')),
    schemaVersion: 'v6',
    slots: [
      slot('decision', 10),
      slot('scanInput', 20),
      slot('primaryAction', 30),
    ],
    statusRoles: [],
    surfaceId: id('surface', 'inventory_warehouse'),
    // A destination in navigation, entered with the caller's company and
    // authorized, as the item page is, by the Posted stock List's query.
    workspace: {
      membership: 'operational',
      entry: {
        companyQueryId: id('query', 'legal_entity_list'),
        authorizationQueryId: id('query', 'posted_stock_balance_list'),
        companyNameFieldId: id('field', 'legal_entity_name'),
        companyStateFieldId: id('field', 'legal_entity_status'),
        activeStateId: id('option', 'legal_entity_status_active'),
        policy: 'authorizedSingleOrPreference',
      },
    },
  };
}
