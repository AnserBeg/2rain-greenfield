/**
 * The item page (INVENTORY-PARITY): the item's own facts -- with its reorder
 * levels, preferred location and standard costs (REPLENISHMENT), its
 * inventory policy and reorder rule (CATALOG-EXTRAS) -- then its stock at
 * each location and its latest movements, and the other numbers it is known
 * by. An item is shared by every company; its stock and movements belong to
 * one. Each of them holds the item as plain text, with no declared relation
 * to it, so each dataset is scoped by that field (`fieldScope`) and read in
 * the company the page's entry chose. Its aliases are its own children
 * (CATALOG-EXTRAS): added and removed here through Catalog's governed alias
 * operations, never edited in place.
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
  const alias = (name: string) => f(`item_alias_${name}`);
  const option = (name: string) => id('option', name);
  const aliases = id('dataset', 'item_aliases');
  const record = (field: string) => ({ source: 'record', field });
  const selected = (field: string) => ({ source: 'selected', field });
  const input = (name: string) => ({
    source: 'input',
    inputId: id('input', `item_${name}`),
  });
  const bind = (path: string[], value: unknown) => ({ path, value });
  const step = (name: string, operation: string, bindings: unknown[]) => ({
    stepId: id('step', `item_${name}`),
    operation: ref('operationReference', id('operation', operation)),
    bindings,
  });
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
          id('column', 'item_inventory_policy'),
          id('column', 'item_reorder_rule'),
        ],
      },
      context: {
        label: 'Stock',
        description:
          'Stock at each location and the latest movements, in the company chosen above, and the other numbers the item is known by.',
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
      task: { mode: 'nativeDialog', fallback: 'page' },
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
      // Whether it is kept in stock, and whose reorder point it follows
      // (CATALOG-EXTRAS): set on the item's form. Under the company rule the
      // stock Lists work the point out in the company they are read in.
      column(
        'inventory_policy',
        'Inventory policy',
        140,
        f('item_inventory_policy'),
      ),
      column('reorder_rule', 'Reorder rule', 150, f('item_reorder_rule')),
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
      {
        datasetId: aliases,
        presentation: {
          selection: 'explicit',
          description:
            'Other SKUs, barcodes and supplier codes this item is known by. Each belongs to one item, so a search, a picker or a scan that names it finds this item.',
        },
        label: 'Aliases',
        orderKey: 30,
        query: q('item_alias_list'),
        sort: [{ fieldId: alias('value'), direction: 'ascending' }],
        parent: {
          relationId: id('relation', 'item_alias_item'),
          value: record('recordId'),
          ownership: 'parentScopedChild',
        },
        columns: [
          column('alias_value', 'Alias', 10, alias('value'), {
            ...role('primary', 10),
          }),
          column('alias_kind', 'Kind', 20, alias('kind'), {
            ...role('secondary', 20),
          }),
        ],
      },
    ],
    actions: [
      {
        actionId: id('action', 'item_add_alias'),
        label: 'Add alias',
        description:
          'Adds another number this item is known by. An alias names one item: one already in use, on this item or another, is refused.',
        orderKey: 10,
        conditions: [],
        inputs: [
          {
            inputId: id('input', 'item_alias_value'),
            label: 'Alias',
            orderKey: 10,
            type: 'text',
            required: true,
          },
          {
            inputId: id('input', 'item_alias_kind'),
            label: 'Kind',
            orderKey: 20,
            type: 'text',
            required: true,
            presentation: {
              kind: 'choice',
              options: [
                {
                  value: option('item_alias_kind_alternate_sku'),
                  label: 'Alternate SKU',
                },
                { value: option('item_alias_kind_barcode'), label: 'Barcode' },
                {
                  value: option('item_alias_kind_supplier_code'),
                  label: 'Supplier code',
                },
              ],
              defaultValue: option('item_alias_kind_alternate_sku'),
            },
          },
        ],
        steps: [
          step('alias_create', 'item_alias_create', [
            bind(['recordId'], { source: 'generated', value: 'uuid' }),
            bind(['values', alias('value')], input('alias_value')),
            bind(['values', alias('kind')], input('alias_kind')),
            bind(
              ['relations', id('relation', 'item_alias_item')],
              record('recordId'),
            ),
          ]),
        ],
      },
      {
        actionId: id('action', 'item_remove_alias'),
        presentation: { placement: 'selection' },
        label: 'Remove alias',
        description:
          'This item is no longer found by the chosen alias, which another item may then take. A merged SKU stays: it is how the duplicate merged into this item is still found.',
        orderKey: 20,
        datasetId: aliases,
        conditions: [
          {
            value: { source: 'selected', field: alias('kind') },
            operator: 'notEquals',
            compare: option('item_alias_kind_merged_sku'),
          },
        ],
        inputs: [],
        steps: [
          step('alias_archive', 'item_alias_archive', [
            bind(['recordId'], selected('recordId')),
            bind(['expectedRevision'], selected('revision')),
          ]),
        ],
      },
      // A duplicate is merged by retiring it: its SKU becomes an alias of
      // the item that survives, then it is archived. Nothing it posted is
      // moved -- its movements stay its own (plan §12, ruling M). An item
      // with aliases of its own is refused at the archive, since an archived
      // item keeps no active alias: remove them first.
      {
        actionId: id('action', 'item_merge'),
        label: 'Merge into another item',
        description:
          'Retires this duplicate: its SKU becomes an alias of the item you choose, and it is archived. Its posted stock and movements stay as they are. Remove its own aliases first.',
        orderKey: 30,
        conditions: [],
        inputs: [
          {
            inputId: id('input', 'item_survivor'),
            label: 'Surviving item (SKU)',
            orderKey: 10,
            type: 'reference',
            required: true,
            query: q('item_list'),
            labelField: ref('fieldReference', f('item_sku')),
            excludeRecord: true,
          },
        ],
        steps: [
          step('merge_alias', 'item_alias_create', [
            bind(['recordId'], { source: 'generated', value: 'uuid' }),
            bind(['values', alias('value')], record(f('item_sku'))),
            bind(['values', alias('kind')], {
              source: 'literal',
              value: option('item_alias_kind_merged_sku'),
            }),
            bind(
              ['relations', id('relation', 'item_alias_item')],
              input('survivor'),
            ),
          ]),
          step('merge_archive', 'item_archive', [
            bind(['recordId'], record('recordId')),
            bind(['expectedRevision'], record('revision')),
          ]),
        ],
      },
    ],
  };
}
