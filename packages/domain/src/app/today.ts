/**
 * Today (LOOP-1): the page an office person lands on -- the day's work in the
 * loop, each tile a List view the application already declares with that
 * view's count: purchase orders with goods still to arrive, sales orders with
 * lines still to ship, invoices not yet paid and items to reorder; and a box
 * that opens a document by its number or an item by its SKU. Like the
 * Warehouse launcher it reads nothing but those Lists and resolve queries,
 * each under current policy, and posts nothing.
 */
export function todaySurface(namespace: string): Record<string, unknown> {
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
      `today_${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
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
    tileId: id('launcher_tile', `today_${name}`),
    label,
    description,
    orderKey,
    surface: id('surface', list),
    view: id('list_view', `${list}_${view}`),
  });
  const target = (local: string, page = `${local}_detail`) => ({
    query: id('query', `${local}_resolve`),
    surface: id('surface', page),
  });
  return {
    archetype: 'task',
    // A launcher's Task binds the on-hand lookup, in its module, as the
    // Warehouse launcher does; the tiles read only their Lists.
    dataSource: ref(
      'queryReference',
      id('query', 'inventory_movement_on_hand'),
    ),
    kind: 'surfaceDefinition',
    label: 'Today',
    launcher: {
      kind: 'surfaceLauncher',
      schemaVersion: 'v6',
      tiles: [
        tile(
          'receive',
          'To receive',
          'Purchase orders with goods still to arrive.',
          10,
          'expected_receipt_list',
          'to_receive',
        ),
        tile(
          'ship',
          'To ship',
          'Sales orders with lines still to ship.',
          20,
          'sales_order_list',
          'to_ship',
        ),
        tile(
          'get_paid',
          'Not yet paid',
          'Invoices with a balance still to be paid.',
          30,
          'customer_invoice_list',
          'open',
        ),
        tile(
          'reorder',
          'To reorder',
          'Items at or below their reorder point.',
          40,
          'item_stock_list',
          'reorder',
        ),
      ],
      scan: {
        label: 'Find an order, document or item by its number or SKU',
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
    surfaceId: id('surface', 'inventory_today'),
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
