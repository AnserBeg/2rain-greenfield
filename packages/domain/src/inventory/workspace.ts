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
              // The movements carry the reason, and the true recorded time,
              // which a stock document's own header leaves blank.
              column(
                'movement',
                'reason',
                'Reason',
                60,
                'inventory_movement_reason_code',
              ),
              column(
                'movement',
                'recorded',
                'Recorded',
                70,
                'inventory_movement_recorded_at',
              ),
            ],
          ),
        ]
      : [
          // STOCK-COUNTS: what each line expects and differs by, from the
          // count line read model -- live from posted stock while counting,
          // the reviewed figures once reviewed.
          {
            ...child(
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
                {
                  columnId: id('column', 'count_line_book'),
                  label: 'Expected',
                  orderKey: 30,
                  field: id('metric', 'count_book'),
                },
                column(
                  'count_line',
                  'physical',
                  'Physical count',
                  40,
                  'stock_count_line_physical_quantity',
                ),
                {
                  columnId: id('column', 'count_line_variance'),
                  label: 'Variance',
                  orderKey: 50,
                  field: id('metric', 'count_variance'),
                },
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
            query: ref(
              'queryReference',
              id('query', 'stock_count_count_lines'),
            ),
            presentation: {
              selection: 'none',
              description:
                'Expected is what is posted at the location: now while counting, and as of the counted instant once reviewed. Variance is the physical count less expected; a reviewed count posts it.',
            },
          },
          // What this count posted: the movements naming it as their source.
          {
            datasetId: id('dataset', 'stock_count_movements'),
            label: 'Posted movements',
            orderKey: 20,
            query: ref(
              'queryReference',
              id('query', 'inventory_movement_list'),
            ),
            presentation: { selection: 'none' },
            fieldScope: {
              fieldId: f('inventory_movement_source_id'),
              value: { source: 'record', field: 'recordId' },
            },
            columns: [
              column(
                'count_movement',
                'item',
                'Product',
                10,
                'inventory_movement_item_id',
                item,
              ),
              column(
                'count_movement',
                'delta',
                'Quantity change',
                20,
                'inventory_movement_quantity_delta',
              ),
              column(
                'count_movement',
                'unit',
                'Unit',
                30,
                'inventory_movement_unit_id',
              ),
              column(
                'count_movement',
                'role',
                'Role',
                40,
                'inventory_movement_posting_role',
              ),
              column(
                'count_movement',
                'effective',
                'Effective',
                50,
                'inventory_movement_effective_at',
              ),
            ],
          },
          // The counts that correct or reverse this one.
          {
            datasetId: id('dataset', 'stock_count_compensations'),
            label: 'Corrections and reversals',
            orderKey: 30,
            query: ref('queryReference', id('query', 'stock_count_list')),
            presentation: { selection: 'explicit', selectedActions: 'row' },
            parent: {
              relationId: id('relation', 'stock_count_supersedes'),
              value: { source: 'record', field: 'recordId' },
              ownership: 'reference',
            },
            columns: [
              column(
                'count_compensation',
                'number',
                'Count',
                10,
                'stock_count_number',
              ),
              column(
                'count_compensation',
                'kind',
                'Kind',
                20,
                'stock_count_kind',
              ),
              column(
                'count_compensation',
                'state',
                'State',
                30,
                'stock_count_state',
              ),
              column(
                'count_compensation',
                'counted',
                'Counted',
                40,
                'stock_count_counted_at',
              ),
            ],
          },
        ];
  const posted = {
    value: { source: 'record', field: f('stock_count_state') },
    operator: 'equals',
    compare: id('option', 'stock_count_state_posted'),
  };
  const notReversal = {
    value: { source: 'record', field: f('stock_count_kind') },
    operator: 'notEquals',
    compare: id('option', 'stock_count_kind_reversal'),
  };
  const literal = (value: string | boolean | null) => ({
    source: 'literal',
    value,
  });
  const input = (name: string) => ({
    source: 'input',
    inputId: id('input', name),
  });
  const stepValue = (name: string, field: string) => ({
    source: 'step',
    stepId: id('step', name),
    field,
  });
  const operation = (name: string) =>
    ref('operationReference', id('operation', name));
  /** A count of the same location that supersedes this posted one. */
  const compensation = (
    name: string,
    kind: 'correction' | 'reversal',
    reason: unknown,
  ) => ({
    stepId: id('step', name),
    operation: operation('stock_count_create'),
    bindings: [
      {
        path: ['values', f('stock_count_kind')],
        value: literal(id('option', `stock_count_kind_${kind}`)),
      },
      {
        // A correction starts its own count; a reversal is reviewed and
        // posted in the same task, so it begins counting.
        path: ['values', f('stock_count_state')],
        value: literal(
          id(
            'option',
            kind === 'correction'
              ? 'stock_count_state_draft'
              : 'stock_count_state_counting',
          ),
        ),
      },
      {
        path: ['values', f('stock_count_location_id')],
        value: { source: 'record', field: f('stock_count_location_id') },
      },
      {
        path: ['values', f('stock_count_counted_at')],
        value: { source: 'generated', value: 'instant' },
      },
      { path: ['values', f('stock_count_reason_code')], value: reason },
      {
        path: ['values', f('stock_count_reason_narrative')],
        value: input(`${name}_narrative`),
      },
      {
        path: ['values', f('stock_count_recorded_at')],
        value: literal(null),
      },
      { path: ['values', f('stock_count_actor_id')], value: literal(null) },
      {
        path: ['relations', id('relation', 'stock_count_supersedes')],
        value: { source: 'record', field: 'recordId' },
      },
      {
        path: ['recordId'],
        value: { source: 'generated', value: 'uuid' },
      },
      {
        path: ['legalEntityId'],
        value: { source: 'generated', value: 'scope' },
      },
    ],
  });
  const command = (
    name: string,
    command: string,
    after: string,
    target: string,
  ) => ({
    stepId: id('step', name),
    operation: operation(`stock_count_${command}`),
    bindings: [
      { path: ['recordId'], value: stepValue(target, 'recordId') },
      { path: ['expectedRevision'], value: stepValue(after, 'revision') },
    ],
  });
  const narrative = (name: string, label: string) => ({
    inputId: id('input', `${name}_narrative`),
    label,
    orderKey: 20,
    type: 'text',
    required: true,
    presentation: { kind: 'multiline' },
  });
  const actions =
    document === 'stock_count'
      ? [
          {
            actionId: id('action', 'correct_count'),
            label: 'Correct',
            description:
              'Starts a correction of this count at the same location, listing the products it counted. Enter what you find, then Review and Post it: the correction posts what you count less what is posted then.',
            orderKey: 10,
            conditions: [posted, notReversal],
            inputs: [
              {
                inputId: id('input', 'correct_count_reason'),
                label: 'Reason',
                orderKey: 10,
                type: 'text',
                required: true,
                presentation: {
                  kind: 'choice',
                  options: [
                    { value: 'COUNT_ERROR', label: 'Counting error confirmed' },
                    { value: 'RECOUNT', label: 'Recount' },
                  ],
                  defaultValue: 'COUNT_ERROR',
                },
              },
              narrative('correct_count', 'Narrative'),
            ],
            steps: [
              compensation(
                'correct_count',
                'correction',
                input('correct_count_reason'),
              ),
              command(
                'correct_count_start',
                'start',
                'correct_count',
                'correct_count',
              ),
            ],
          },
          {
            actionId: id('action', 'reverse_count'),
            label: 'Reverse',
            description:
              'Posts a reversal of this count at the same location: each of its movements, exactly undone. Refused if the stock has left since.',
            orderKey: 20,
            conditions: [posted, notReversal],
            inputs: [narrative('reverse_count', 'Reason')],
            steps: [
              compensation('reverse_count', 'reversal', literal('REVERSE')),
              command(
                'reverse_count_review',
                'review',
                'reverse_count',
                'reverse_count',
              ),
              command(
                'reverse_count_post',
                'post',
                'reverse_count_review',
                'reverse_count',
              ),
            ],
          },
          {
            actionId: id('action', 'open_compensation'),
            presentation: { placement: 'row' },
            label: 'Open',
            description: 'Opens this count.',
            orderKey: 30,
            datasetId: id('dataset', 'stock_count_compensations'),
            conditions: [],
            inputs: [],
            steps: [],
            navigate: {
              surface: ref(
                'surfaceReference',
                id('surface', 'stock_count_detail'),
              ),
              query: ref('queryReference', id('query', 'stock_count_get')),
              record: { source: 'selected', field: 'recordId' },
            },
          },
        ]
      : [];
  // STOCK-COUNTS: a count reads as a document -- its number, location and
  // state, then its lines, what it posted, and what corrected it.
  const header =
    document === 'stock_count'
      ? {
          presentation: {
            header: {
              title: id('column', 'count_number'),
              subtitle: [id('column', 'count_location')],
              status: id('column', 'count_state'),
              facts: [
                id('column', 'count_kind'),
                id('column', 'count_counted'),
                id('column', 'count_reason'),
              ],
            },
            context: {
              label: 'Stock count',
              description:
                'Start counting lists every product posted at the location. Edit the count to enter what you find, then Review and Post.',
            },
            recordActions: 'progressive',
            technicalDetails: 'progressive',
            task: { mode: 'nativeDialog', fallback: 'page' },
          },
          fields: [
            column('count', 'number', 'Count', 10, 'stock_count_number'),
            column(
              'count',
              'location',
              'Location',
              20,
              'stock_count_location_id',
              location,
            ),
            column('count', 'state', 'State', 30, 'stock_count_state'),
            column('count', 'kind', 'Kind', 40, 'stock_count_kind'),
            column(
              'count',
              'counted',
              'Counted at',
              50,
              'stock_count_counted_at',
            ),
            column('count', 'reason', 'Reason', 60, 'stock_count_reason_code'),
            column(
              'count',
              'narrative',
              'Narrative',
              70,
              'stock_count_reason_narrative',
            ),
          ],
        }
      : { fields: [] };
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    ...header,
    children,
    actions,
  };
}

/**
 * STOCK-COUNTS: what each line of a count expects and differs by. While the
 * count is a draft or counting, expected is what is posted at the count's
 * location now and variance is the physical count less it; once reviewed,
 * both are the figures the review froze.
 */
export const INVENTORY_READ_MODEL_BINDINGS = Object.freeze({
  countLine: 'northstar.inventory:read_model.count_line',
});
/** The count line read model's outputs. */
export const INVENTORY_READ_MODEL_OUTPUTS = Object.freeze({
  countLine: ['count_book', 'count_variance'],
} as const);

/**
 * The count line read model's query: a copy of the count line list, so that
 * list stays exactly as it is. It reads the count and the posted stock lists,
 * each under current policy and scope.
 */
export function stockCountWorkspaceQueries(
  namespace: string,
  queries: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const named = (local: string) =>
    queries.find((query) => query.queryId === `${namespace}:query.${local}`);
  const source = named('stock_count_line_list');
  if (!source || !named('posted_stock_balance_list')) return [];
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const name = 'stock_count_count_lines';
  const clone = JSON.parse(
    JSON.stringify(source)
      .replaceAll(
        `${namespace}:query.stock_count_line_list`,
        `${namespace}:query.${name}`,
      )
      .replaceAll('selection.stock_count_line_list_', `selection.${name}_`)
      .replaceAll('parameter.stock_count_line_list_', `parameter.${name}_`),
  ) as Record<string, unknown>;
  return [
    {
      ...clone,
      readModel: {
        capability: ref(
          'capabilityReference',
          'northstar.inventory:capability.posting',
        ),
        binding: INVENTORY_READ_MODEL_BINDINGS.countLine,
        queries: {
          count: ref('queryReference', `${namespace}:query.stock_count_get`),
          stock: ref(
            'queryReference',
            `${namespace}:query.posted_stock_balance_list`,
          ),
        },
        resultFields: Object.fromEntries(
          INVENTORY_READ_MODEL_OUTPUTS.countLine.map((key) => [
            key,
            `${namespace}:metric.${key}`,
          ]),
        ),
      },
    },
  ];
}
