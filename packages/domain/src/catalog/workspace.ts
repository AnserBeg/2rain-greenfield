/**
 * A price list's page (SALES-EXTRAS): its prices -- one per item and quantity
 * break -- and the customers it prices for. Every task is an existing governed
 * Catalog operation; the runtime interprets the same data for any module.
 */
export function priceListWorkspace(namespace: string): Record<string, unknown> {
  const id = (type: string, name: string) => `${namespace}:${type}.${name}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const q = (name: string) => ref('queryReference', id('query', name));
  const field = (name: string) => id('field', name);
  const column = (
    name: string,
    label: string,
    orderKey: number,
    value: string,
    lookup?: readonly [string, string],
  ) => ({
    columnId: id('column', `price_list_${name}`),
    label,
    orderKey,
    field: value,
    ...(lookup
      ? {
          reference: {
            query: q(lookup[0]),
            labelField: ref('fieldReference', field(lookup[1])),
          },
        }
      : {}),
  });
  const role = <T extends object>(
    value: T,
    kind: 'primary' | 'secondary' | 'quantity' | 'detail',
    priority: number,
  ) => ({ ...value, presentation: { role: kind, priority } });
  const money = <T extends object>(value: T) => ({
    ...value,
    format: 'money' as const,
  });
  const record = (name: string) => ({ source: 'record', field: name });
  const selected = (name: string) => ({ source: 'selected', field: name });
  const literal = (value: string) => ({ source: 'literal', value });
  const input = (name: string) => ({
    source: 'input',
    inputId: id('input', `price_list_${name}`),
  });
  const bind = (path: string[], value: unknown) => ({ path, value });
  const step = (name: string, operation: string, bindings: unknown[]) => ({
    stepId: id('step', `price_list_${name}`),
    operation: ref('operationReference', id('operation', operation)),
    bindings,
  });
  const status = (value: 'active' | 'inactive') => ({
    value: record(field('price_list_status')),
    operator: 'equals',
    compare: id('option', `price_list_status_${value}`),
  });
  const setStatus = (value: 'active' | 'inactive') =>
    step(`status_${value}`, 'price_list_update', [
      bind(['recordId'], record('recordId')),
      bind(['expectedRevision'], record('revision')),
      bind(
        ['patch', field('price_list_status')],
        literal(id('option', `price_list_status_${value}`)),
      ),
    ]);
  const archive = (name: string, local: string) =>
    step(name, `${local}_archive`, [
      bind(['recordId'], selected('recordId')),
      bind(['expectedRevision'], selected('revision')),
    ]);
  const prices = id('dataset', 'price_list_prices');
  const customers = id('dataset', 'price_list_customers');
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: id('column', 'price_list_code'),
        subtitle: [id('column', 'price_list_name')],
        status: id('column', 'price_list_status'),
        facts: [
          id('column', 'price_list_currency'),
          id('column', 'price_list_priority'),
        ],
      },
      context: {
        label: 'Pricing',
        description:
          'A sales order line for one of these customers takes the price of its item for the largest quantity break at or below its quantity, from the customer’s active list in the order’s currency with the highest priority.',
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
      task: { mode: 'nativeDialog', fallback: 'page' },
    },
    fields: [
      column('code', 'Price list', 10, field('price_list_code')),
      column('name', 'Name', 20, field('price_list_name')),
      column('currency', 'Currency', 30, field('price_list_currency')),
      column('priority', 'Priority', 40, field('price_list_priority')),
      column('status', 'Status', 50, field('price_list_status')),
    ],
    children: [
      {
        datasetId: prices,
        presentation: { selection: 'explicit', selectedActions: 'row' },
        label: 'Prices',
        orderKey: 10,
        query: q('price_list_entry_list'),
        sort: [
          {
            fieldId: field('price_list_entry_item_id'),
            direction: 'ascending',
          },
          {
            fieldId: field('price_list_entry_minimum_quantity'),
            direction: 'ascending',
          },
        ],
        parent: {
          relationId: id('relation', 'price_list_entry_price_list'),
          value: record('recordId'),
          ownership: 'parentScopedChild',
        },
        columns: [
          role(
            column('item', 'Item', 10, field('price_list_entry_item_id'), [
              'item_get',
              'item_name',
            ]),
            'primary',
            10,
          ),
          role(
            column('sku', 'SKU', 20, field('price_list_entry_item_id'), [
              'item_get',
              'item_sku',
            ]),
            'secondary',
            20,
          ),
          role(
            column(
              'minimum',
              'From quantity',
              30,
              field('price_list_entry_minimum_quantity'),
            ),
            'quantity',
            30,
          ),
          role(
            money(
              column(
                'unit_price',
                'Unit price',
                40,
                field('price_list_entry_unit_price'),
              ),
            ),
            'quantity',
            40,
          ),
        ],
      },
      {
        datasetId: customers,
        presentation: { selection: 'explicit', selectedActions: 'row' },
        label: 'Customers',
        orderKey: 20,
        query: q('price_list_assignment_list'),
        parent: {
          relationId: id('relation', 'price_list_assignment_price_list'),
          value: record('recordId'),
          ownership: 'parentScopedChild',
        },
        columns: [
          role(
            column(
              'customer',
              'Customer',
              10,
              field('price_list_assignment_party_id'),
              ['party_get', 'party_name'],
            ),
            'primary',
            10,
          ),
          role(
            column(
              'customer_number',
              'Customer number',
              20,
              field('price_list_assignment_party_id'),
              ['party_get', 'party_number'],
            ),
            'secondary',
            20,
          ),
        ],
      },
    ],
    actions: [
      {
        actionId: id('action', 'price_list_add_price'),
        label: 'Add price',
        description:
          'Prices this item from this quantity up, in this list’s currency. A larger break of the same item takes over from its own quantity.',
        orderKey: 10,
        conditions: [],
        inputs: [
          {
            inputId: id('input', 'price_list_item'),
            label: 'Item',
            orderKey: 10,
            type: 'reference',
            required: true,
            query: q('item_list'),
            labelField: ref('fieldReference', field('item_name')),
          },
          {
            inputId: id('input', 'price_list_minimum'),
            label: 'From quantity',
            orderKey: 20,
            type: 'quantity',
            required: true,
          },
          {
            inputId: id('input', 'price_list_unit_price'),
            label: 'Unit price',
            orderKey: 30,
            type: 'text',
            required: true,
          },
        ],
        steps: [
          step('price_create', 'price_list_entry_create', [
            bind(['recordId'], { source: 'generated', value: 'uuid' }),
            bind(['values', field('price_list_entry_item_id')], input('item')),
            bind(
              ['values', field('price_list_entry_minimum_quantity')],
              input('minimum'),
            ),
            bind(
              ['values', field('price_list_entry_unit_price')],
              input('unit_price'),
            ),
            bind(
              ['relations', id('relation', 'price_list_entry_price_list')],
              record('recordId'),
            ),
          ]),
        ],
      },
      {
        actionId: id('action', 'price_list_remove_price'),
        presentation: { placement: 'selection' },
        label: 'Remove price',
        description:
          'Removes this price from the list. Orders it already priced keep their prices.',
        orderKey: 20,
        datasetId: prices,
        conditions: [],
        inputs: [],
        steps: [archive('price_archive', 'price_list_entry')],
      },
      {
        actionId: id('action', 'price_list_assign_customer'),
        label: 'Assign customer',
        description:
          'This customer’s new sales order lines in this list’s currency are priced from it, when no list of higher priority prices them.',
        orderKey: 30,
        conditions: [],
        inputs: [
          {
            inputId: id('input', 'price_list_customer'),
            label: 'Customer',
            orderKey: 10,
            type: 'reference',
            required: true,
            query: q('party_list'),
            labelField: ref('fieldReference', field('party_name')),
            // Only parties with an active customer role.
            eligibility: {
              queryId: id('query', 'party_role_list'),
              relationId: id('relation', 'party_role_party'),
              filters: [
                {
                  fieldId: field('party_role_kind'),
                  value: id('option', 'customer'),
                },
                {
                  fieldId: field('party_role_status'),
                  value: id('option', 'active'),
                },
              ],
            },
          },
        ],
        steps: [
          step('customer_create', 'price_list_assignment_create', [
            bind(['recordId'], { source: 'generated', value: 'uuid' }),
            bind(
              ['values', field('price_list_assignment_party_id')],
              input('customer'),
            ),
            bind(
              ['relations', id('relation', 'price_list_assignment_price_list')],
              record('recordId'),
            ),
          ]),
        ],
      },
      {
        actionId: id('action', 'price_list_remove_customer'),
        presentation: { placement: 'selection' },
        label: 'Remove customer',
        description:
          'This customer’s new lines are no longer priced from this list. Orders already priced keep their prices.',
        orderKey: 40,
        datasetId: customers,
        conditions: [],
        inputs: [],
        steps: [archive('customer_archive', 'price_list_assignment')],
      },
      {
        actionId: id('action', 'price_list_deactivate'),
        label: 'Deactivate',
        description:
          'The list prices nothing until it is activated again. Orders it already priced keep their prices.',
        orderKey: 50,
        conditions: [status('active')],
        inputs: [],
        steps: [setStatus('inactive')],
      },
      {
        actionId: id('action', 'price_list_activate'),
        label: 'Activate',
        description: 'The list prices its customers’ new lines again.',
        orderKey: 60,
        conditions: [status('inactive')],
        inputs: [],
        steps: [setStatus('active')],
      },
    ],
  };
}
