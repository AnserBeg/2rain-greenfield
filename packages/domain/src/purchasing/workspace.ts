/** Purchasing declarations interpreted by the shared Record/Task renderer. */
export function purchasingWorkspace(
  namespace: string,
): Record<string, unknown> {
  const id = (kind: string, name: string) => `${namespace}:${kind}.${name}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    targetId,
    schemaVersion: 'v6',
  });
  const q = (name: string) => ref('queryReference', id('query', name));
  const f = (name: string) => id('field', name);
  const record = (field: string) => ({ source: 'record', field });
  const selected = (field: string) => ({ source: 'selected', field });
  const literal = (value: string | null) => ({ source: 'literal', value });
  const generated = (value: string) => ({ source: 'generated', value });
  const input = (name: string) => ({
    source: 'input',
    inputId: id('input', `receive_${name}`),
  });
  const stepValue = (name: string, field: string) => ({
    source: 'step',
    stepId: id('step', name),
    field,
  });
  const bind = (path: string[], value: unknown) => ({ path, value });
  const step = (name: string, operation: string, bindings: unknown[]) => ({
    stepId: id('step', name),
    operation: ref('operationReference', id('operation', operation)),
    bindings,
  });
  const create = (
    name: string,
    entity: string,
    values: Record<string, unknown>,
    relations: Record<string, unknown>,
  ) =>
    step(name, `${entity}_create`, [
      bind(['recordId'], generated('uuid')),
      bind(['legalEntityId'], generated('scope')),
      ...Object.entries(values).map(([name, value]) =>
        bind(['values', f(`${entity}_${name}`)], value),
      ),
      ...Object.entries(relations).map(([name, value]) =>
        bind(['relations', id('relation', `${entity}_${name}`)], value),
      ),
    ]);
  const column = (
    name: string,
    label: string,
    orderKey: number,
    field: string,
    lookup?: [string, string],
    role?: string,
  ) => ({
    columnId: id('column', `purchasing_${name}`),
    label,
    orderKey,
    field,
    ...(lookup
      ? {
          reference: {
            query: q(lookup[0]),
            labelField: ref('fieldReference', f(lookup[1])),
          },
        }
      : {}),
    ...(role ? { presentation: { role, priority: orderKey } } : {}),
  });
  const lines = id('dataset', 'purchasing_lines');
  const receipts = id('dataset', 'purchasing_receipts');
  const receive = (known: boolean) => {
    const suffix = known ? 'known' : 'absent';
    const header = `receipt_${suffix}`;
    const detail = `receipt_line_${suffix}`;
    return {
      actionId: id('action', `receive_${suffix}`),
      label: known
        ? 'Receive with actual cost'
        : 'Receive with cost explicitly absent',
      description: known
        ? 'Post received quantity using the actual received cost and currency you enter.'
        : 'Post received quantity with actual cost explicitly recorded as absent. Order price is not received cost.',
      orderKey: known ? 10 : 20,
      datasetId: lines,
      presentation: { placement: 'selection' },
      conditions: [
        {
          value: record(
            id('derived_state_field', 'machine.purchase_order_lifecycle'),
          ),
          operator: 'equals',
          compare: id('state', 'purchase_order_released'),
        },
      ],
      inputs: [
        {
          inputId: id('input', 'receive_quantity'),
          label: 'Quantity to receive',
          orderKey: 10,
          type: 'quantity',
          required: true,
        },
        {
          inputId: id('input', 'receive_unit'),
          label: 'Base unit',
          orderKey: 20,
          type: 'text',
          required: true,
          // The selected line's product base unit, read on the server; the
          // operator is never asked to type a unit the product already has.
          presentation: {
            kind: 'derived',
            column: {
              datasetId: lines,
              columnId: id('column', 'purchasing_base_unit'),
            },
          },
        },
        {
          inputId: id('input', 'receive_location'),
          label: 'Receiving location',
          orderKey: 30,
          type: 'reference',
          required: true,
          query: q('location_list'),
          labelField: ref('fieldReference', f('location_name')),
        },
        ...(known
          ? [
              {
                inputId: id('input', 'receive_cost'),
                label: 'Actual received unit cost',
                orderKey: 40,
                type: 'text',
                required: true,
              },
              {
                inputId: id('input', 'receive_currency'),
                label: 'Actual cost currency',
                orderKey: 50,
                type: 'text',
                required: true,
                // The offered codes, starting from the order's own currency;
                // the actual cost itself is always entered explicitly.
                presentation: {
                  kind: 'choice',
                  options: [
                    { value: 'CAD', label: 'CAD · Canadian dollar' },
                    { value: 'USD', label: 'USD · US dollar' },
                    { value: 'EUR', label: 'EUR · Euro' },
                  ],
                  defaultFrom: {
                    source: 'record',
                    field: f('purchase_order_currency'),
                  },
                },
              },
            ]
          : []),
      ],
      steps: [
        create(
          header,
          'goods_receipt',
          {
            number: generated('uuid'),
            state: literal(id('option', 'goods_receipt_state_draft')),
            kind: literal(id('option', 'goods_receipt_kind_initial')),
            effective_at: generated('instant'),
            location_id: input('location'),
            reason_code: literal('RECEIVE'),
            reason_narrative: literal('Receive from purchase order'),
          },
          { order: record('recordId') },
        ),
        create(
          detail,
          'goods_receipt_line',
          {
            line_number: literal('1'),
            item_id: selected(f('purchase_order_line_item_id')),
            quantity: input('quantity'),
            unit_id: input('unit'),
            cost_status: literal(
              id('option', `goods_receipt_line_cost_status_${suffix}`),
            ),
            unit_cost: known ? input('cost') : literal(null),
            currency: known ? input('currency') : literal(null),
            reversal_of_movement_id: literal(null),
          },
          {
            receipt: stepValue(header, 'recordId'),
            order_line: selected('recordId'),
          },
        ),
        step(`receipt_post_${suffix}`, 'goods_receipt_post', [
          bind(['recordId'], stepValue(header, 'recordId')),
          bind(['expectedRevision'], stepValue(header, 'revision')),
        ]),
      ],
    };
  };
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: id('column', 'purchasing_number'),
        subtitle: [id('column', 'purchasing_vendor')],
        status: id('column', 'purchasing_state'),
        facts: [
          id('column', 'purchasing_ordered'),
          id('column', 'purchasing_expected'),
          id('column', 'purchasing_currency'),
        ],
      },
      context: {
        label: 'Receiving',
        description:
          'Choose an order line to receive it. Actual cost is entered explicitly; draft editing and Release remain separate.',
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
      task: { mode: 'nativeDialog', fallback: 'page' },
    },
    fields: [
      column('number', 'Purchase order', 10, f('purchase_order_number')),
      column('vendor', 'Vendor', 20, f('purchase_order_supplier_party_id'), [
        'party_get',
        'party_name',
      ]),
      column(
        'state',
        'Order state',
        30,
        id('derived_state_field', 'machine.purchase_order_lifecycle'),
      ),
      column('ordered', 'Order date', 35, f('purchase_order_order_date')),
      column(
        'expected',
        'Expected date',
        40,
        f('purchase_order_expected_date'),
      ),
      column('currency', 'Currency', 45, f('purchase_order_currency')),
      // Read back as stored; shown in the document's sections.
      column('notes', 'Notes', 50, f('purchase_order_notes')),
    ],
    children: [
      {
        datasetId: lines,
        label: 'Order lines',
        orderKey: 10,
        query: q('purchase_order_line_list'),
        presentation: { selection: 'explicit', selectedActions: 'row' },
        parent: {
          relationId: id('relation', 'purchase_order_line_order'),
          value: record('recordId'),
          ownership: 'parentScopedChild',
        },
        sort: [
          {
            fieldId: f('purchase_order_line_line_number'),
            direction: 'ascending',
          },
        ],
        columns: [
          column(
            'line',
            'Line',
            10,
            f('purchase_order_line_line_number'),
            undefined,
            'secondary',
          ),
          column(
            'item',
            'Product',
            20,
            f('purchase_order_line_item_id'),
            ['item_get', 'item_name'],
            'primary',
          ),
          column(
            'sku',
            'SKU',
            25,
            f('purchase_order_line_item_id'),
            ['item_get', 'item_sku'],
            'secondary',
          ),
          column(
            'quantity',
            'Ordered',
            30,
            f('purchase_order_line_ordered_quantity'),
            undefined,
            'quantity',
          ),
          column(
            'base_unit',
            'Product base unit',
            40,
            f('purchase_order_line_item_id'),
            ['item_get', 'item_base_unit'],
            'secondary',
          ),
          column(
            'unit_cost',
            'Unit cost',
            50,
            f('purchase_order_line_unit_price'),
            undefined,
            'secondary',
          ),
        ],
      },
      {
        datasetId: receipts,
        label: 'Connected receipts',
        orderKey: 20,
        query: q('goods_receipt_list'),
        presentation: { selection: 'none', compact: 'scrollTable' },
        parent: {
          relationId: id('relation', 'goods_receipt_order'),
          value: record('recordId'),
          ownership: 'reference',
        },
        columns: [
          column(
            'receipt',
            'Receipt',
            10,
            f('goods_receipt_number'),
            undefined,
            'primary',
          ),
          column(
            'receipt_state',
            'State',
            20,
            f('goods_receipt_state'),
            undefined,
            'secondary',
          ),
          column(
            'received_at',
            'Received at',
            30,
            f('goods_receipt_effective_at'),
            undefined,
            'secondary',
          ),
        ],
      },
    ],
    actions: [
      receive(true),
      receive(false),
      {
        actionId: id('action', 'open_receipt'),
        label: 'Open receipt',
        description:
          'Open the connected receipt and its existing amendment/correction workflow.',
        orderKey: 30,
        datasetId: receipts,
        presentation: { placement: 'row' },
        conditions: [],
        inputs: [],
        steps: [],
        navigate: {
          surface: ref(
            'surfaceReference',
            id('surface', 'goods_receipt_detail'),
          ),
          query: q('goods_receipt_get'),
          record: selected('recordId'),
        },
      },
    ],
  };
}
