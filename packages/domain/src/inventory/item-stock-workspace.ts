/**
 * The item page (INVENTORY-PARITY): the item's own facts -- with its reorder
 * levels, preferred location and standard costs (REPLENISHMENT) -- then its
 * stock at each location and its latest movements. An item is shared by every company;
 * its stock and movements belong to one. Each of them holds the item as plain
 * text, with no declared relation to it, so each dataset is scoped by that
 * field (`fieldScope`) and read in the company the page's entry chose.
 * Read-only: no action is declared here.
 */
export function itemStockWorkspace(namespace: string): Record<string, unknown> {
  const id = (kind: string, name: string) => `${namespace}:${kind}.${name}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const q = (name: string) => ref('queryReference', id('query', name));
  const f = (name: string) => id('field', name);
  const column = (
    name: string,
    label: string,
    orderKey: number,
    field: string,
    declared: Record<string, unknown> = {},
  ) => ({
    columnId: id('column', `item_${name}`),
    label,
    orderKey,
    field,
    ...declared,
  });
  const location = {
    reference: {
      query: q('location_get'),
      labelField: ref('fieldReference', f('location_code')),
    },
  };
  const role = (kind: string, priority: number) => ({
    presentation: { role: kind, priority },
  });
  const money = { format: 'money' };
  const scopedBy = (field: string) => ({
    fieldId: f(field),
    value: { source: 'record', field: 'recordId' },
  });
  const stock = (name: string) => f(`posted_stock_balance_${name}`);
  const movement = (name: string) => f(`inventory_movement_${name}`);
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: id('column', 'item_name'),
        subtitle: [id('column', 'item_sku')],
        facts: [
          id('column', 'item_base_unit'),
          id('column', 'item_price_cad'),
          id('column', 'item_price_usd'),
          id('column', 'item_price_eur'),
        ],
      },
      context: {
        label: 'Stock',
        description:
          'Stock at each location and the latest movements, in the company chosen above.',
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
    },
    fields: [
      column('name', 'Name', 10, f('item_name')),
      column('sku', 'SKU', 20, f('item_sku')),
      column('description', 'Description', 30, f('item_description')),
      column('base_unit', 'Base unit', 40, f('item_base_unit')),
      column('price_cad', 'Price (CAD)', 50, f('item_price_cad'), money),
      column('price_usd', 'Price (USD)', 60, f('item_price_usd'), money),
      column('price_eur', 'Price (EUR)', 70, f('item_price_eur'), money),
      // How much to keep and where, and what it usually costs to buy
      // (REPLENISHMENT): set on the item's form.
      column('reorder_point', 'Reorder point', 80, f('item_reorder_point')),
      column('reorder_up_to', 'Reorder up to', 90, f('item_reorder_up_to')),
      column(
        'preferred_location',
        'Preferred location',
        100,
        f('item_preferred_location_id'),
        {
          reference: {
            query: q('location_get'),
            labelField: ref('fieldReference', f('location_name')),
          },
        },
      ),
      column(
        'standard_cost_cad',
        'Standard cost (CAD)',
        110,
        f('item_standard_cost_cad'),
        money,
      ),
      column(
        'standard_cost_usd',
        'Standard cost (USD)',
        120,
        f('item_standard_cost_usd'),
        money,
      ),
      column(
        'standard_cost_eur',
        'Standard cost (EUR)',
        130,
        f('item_standard_cost_eur'),
        money,
      ),
    ],
    children: [
      {
        datasetId: id('dataset', 'item_stock'),
        presentation: {
          selection: 'none',
          description:
            'On hand is the stock posted at the location in this company. Reserved is what active reservations still hold there, and Available is on hand less reserved. Missing or unavailable data is not zero stock.',
        },
        label: 'Stock by location',
        orderKey: 10,
        query: q('item_stock_positions'),
        sort: [{ fieldId: stock('posted_quantity'), direction: 'descending' }],
        fieldScope: scopedBy('posted_stock_balance_item_id'),
        columns: [
          column('stock_location', 'Location', 10, stock('location_id'), {
            ...location,
            ...role('primary', 10),
          }),
          column('stock_on_hand', 'On hand', 20, stock('posted_quantity'), {
            ...role('quantity', 20),
          }),
          column('stock_reserved', 'Reserved', 30, id('metric', 'reserved'), {
            ...role('quantity', 30),
          }),
          column(
            'stock_available',
            'Available',
            40,
            id('metric', 'available'),
            role('quantity', 40),
          ),
          column('stock_unit', 'Unit', 50, stock('unit_id')),
        ],
      },
      {
        datasetId: id('dataset', 'item_movements'),
        presentation: {
          selection: 'none',
          compact: 'scrollTable',
          description:
            "Every posted change to this item's stock in this company, newest first. A positive change adds stock and a negative one removes it.",
        },
        label: 'Recent movements',
        orderKey: 20,
        query: q('inventory_movement_list'),
        sort: [
          { fieldId: movement('effective_at'), direction: 'descending' },
          { fieldId: movement('recorded_at'), direction: 'descending' },
        ],
        fieldScope: scopedBy('inventory_movement_item_id'),
        columns: [
          column('movement_date', 'Date', 10, movement('effective_at'), {
            ...role('primary', 10),
          }),
          column('movement_role', 'Role', 20, movement('posting_role')),
          column('movement_location', 'Location', 30, movement('location_id'), {
            ...location,
          }),
          column('movement_change', 'Change', 40, movement('quantity_delta'), {
            ...role('quantity', 40),
          }),
          column('movement_unit', 'Unit', 50, movement('unit_id')),
          column('movement_source', 'Source', 60, movement('source_type')),
          column('movement_reason', 'Reason', 70, movement('reason_code')),
        ],
      },
    ],
    actions: [],
  };
}
