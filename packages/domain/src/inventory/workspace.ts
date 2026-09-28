/**
 * Inventory documents shown with their own lines. Line tables stay reachable
 * inside the document they belong to, so ordinary navigation lists documents
 * rather than line tables. Read-only: no action is declared here.
 */
export function inventoryDocumentWorkspace(
  namespace: string,
  document: 'inventory_transaction' | 'stock_count',
): Record<string, unknown> {
  const id = (kind: string, name: string) => `${namespace}:${kind}.${name}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    targetId,
    schemaVersion: 'v6',
  });
  const f = (name: string) => id('field', name);
  const column = (
    dataset: string,
    name: string,
    label: string,
    orderKey: number,
    field: string,
    lookup?: [string, string],
  ) => ({
    columnId: id('column', `${dataset}_${name}`),
    label,
    orderKey,
    field: f(field),
    ...(lookup
      ? {
          reference: {
            query: ref('queryReference', id('query', lookup[0])),
            labelField: ref('fieldReference', f(lookup[1])),
          },
        }
      : {}),
  });
  const child = (
    local: string,
    label: string,
    orderKey: number,
    relation: string,
    columns: unknown[],
    sort?: string,
  ) => ({
    datasetId: id('dataset', `${document}_${local}`),
    label,
    orderKey,
    query: ref('queryReference', id('query', `${local}_list`)),
    parent: {
      relationId: id('relation', relation),
      value: { source: 'record', field: 'recordId' },
      ownership: 'parentScopedChild',
    },
    ...(sort ? { sort: [{ fieldId: f(sort), direction: 'ascending' }] } : {}),
    columns,
  });
  const item: [string, string] = ['item_get', 'item_name'];
  const location: [string, string] = ['location_get', 'location_name'];
  const children =
    document === 'inventory_transaction'
      ? [
          child(
            'inventory_transaction_line',
            'Lines',
            10,
            'inventory_transaction_line_transaction',
            [
              column(
                'line',
                'line',
                'Line',
                10,
                'inventory_transaction_line_line_number',
              ),
              column(
                'line',
                'item',
                'Product',
                20,
                'inventory_transaction_line_item_id',
                item,
              ),
              column(
                'line',
                'quantity',
                'Quantity',
                30,
                'inventory_transaction_line_quantity',
              ),
              column(
                'line',
                'unit',
                'Unit',
                40,
                'inventory_transaction_line_unit_id',
              ),
              column(
                'line',
                'from',
                'From location',
                50,
                'inventory_transaction_line_from_location_id',
                location,
              ),
              column(
                'line',
                'to',
                'To location',
                60,
                'inventory_transaction_line_to_location_id',
                location,
              ),
            ],
            'inventory_transaction_line_line_number',
          ),
          child(
            'inventory_movement',
            'Posted movements',
            20,
            'inventory_movement_transaction',
            [
              column(
                'movement',
                'item',
                'Product',
                10,
                'inventory_movement_item_id',
                item,
              ),
              column(
                'movement',
                'location',
                'Location',
                20,
                'inventory_movement_location_id',
                location,
              ),
              column(
                'movement',
                'delta',
                'Quantity change',
                30,
                'inventory_movement_quantity_delta',
              ),
              column(
                'movement',
                'unit',
                'Unit',
                40,
                'inventory_movement_unit_id',
              ),
              column(
                'movement',
                'effective',
                'Effective',
                50,
                'inventory_movement_effective_at',
              ),
            ],
          ),
        ]
      : [
          child(
            'stock_count_line',
            'Counted lines',
            10,
            'stock_count_line_session',
            [
              column(
                'count_line',
                'line',
                'Line',
                10,
                'stock_count_line_line_number',
              ),
              column(
                'count_line',
                'item',
                'Product',
                20,
                'stock_count_line_item_id',
                item,
              ),
              column(
                'count_line',
                'expected',
                'Expected',
                30,
                'stock_count_line_expected_quantity',
              ),
              column(
                'count_line',
                'counted',
                'Counted',
                40,
                'stock_count_line_counted_quantity',
              ),
              column(
                'count_line',
                'variance',
                'Variance',
                50,
                'stock_count_line_variance_quantity',
              ),
              column(
                'count_line',
                'unit',
                'Unit',
                60,
                'stock_count_line_unit_id',
              ),
            ],
            'stock_count_line_line_number',
          ),
        ];
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    fields: [],
    children,
    actions: [],
  };
}
