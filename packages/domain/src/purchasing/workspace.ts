/**
 * What each line of a posted receipt can still give back (ORDER-PARITY): its
 * movement, what that movement still adds to stock after the compensations
 * already posted against it, and its order line -- read by the receiving read
 * model, so a reversal names exactly what the posting kernel will admit.
 */
export const RECEIVING_READ_MODEL_BINDINGS = Object.freeze({
  receiptLine: 'northstar.purchasing:read_model.receipt_line',
});
/** The receiving outputs, by read-model binding. */
export const RECEIVING_READ_MODEL_OUTPUTS = Object.freeze({
  receiptLine: ['movement', 'reversible', 'reversal_quantity', 'order_line'],
} as const);

/**
 * The receiving read model's query: a receipt's lines with what each can
 * still reverse, cut from the receipt line list when the application composes
 * purchasing with inventory. The movements and the lines it reads are the
 * plain declared lists, under current policy and scope.
 */
export function receivingWorkspaceQueries(
  namespace: string,
  queries: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const named = (local: string) =>
    queries.find((query) => query.queryId === `${namespace}:query.${local}`);
  const source = named('goods_receipt_line_list');
  if (!source || !named('inventory_movement_list')) return [];
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const name = 'receiving_receipt_lines';
  const clone = JSON.parse(
    JSON.stringify(source)
      .replaceAll(
        `${namespace}:query.goods_receipt_line_list`,
        `${namespace}:query.${name}`,
      )
      .replaceAll('selection.goods_receipt_line_list_', `selection.${name}_`)
      .replaceAll('parameter.goods_receipt_line_list_', `parameter.${name}_`),
  ) as Record<string, unknown>;
  return [
    {
      ...clone,
      readModel: {
        capability: ref(
          'capabilityReference',
          'northstar.purchasing:capability.receiving',
        ),
        binding: RECEIVING_READ_MODEL_BINDINGS.receiptLine,
        queries: {
          lines: ref(
            'queryReference',
            `${namespace}:query.goods_receipt_line_list`,
          ),
          movements: ref(
            'queryReference',
            `${namespace}:query.inventory_movement_list`,
          ),
        },
        resultFields: Object.fromEntries(
          RECEIVING_READ_MODEL_OUTPUTS.receiptLine.map((key) => [
            key,
            `${namespace}:metric.${key}`,
          ]),
        ),
      },
    },
  ];
}

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
  const literal = (value: string | boolean | null) => ({
    source: 'literal',
    value,
  });
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
  // Shown with grouped digits and two decimals, never rounded.
  const money = <T extends object>(value: T) => ({
    ...value,
    format: 'money' as const,
  });
  const lines = id('dataset', 'purchasing_lines');
  // What each line costs and the order's totals (ruling B extended to
  // purchasing), read through the commercial purchase order queries.
  const pricedLines = id('dataset', 'purchasing_priced_lines');
  const metric = (name: string) => id('metric', name);
  const receipts = id('dataset', 'purchasing_receipts');
  // PAYABLES: the order's vendor bills and their balances.
  const bills = id('dataset', 'purchasing_bills');
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
        // Nothing is offered to receive on a line with nothing left to arrive:
        // its open quantity reads exactly '0'. A withheld received read states
        // no open quantity at all, and receiving stays offered -- the
        // receiving kernel refuses an over-receipt either way.
        {
          value: selected(metric('open_to_receive')),
          operator: 'notEquals',
          compare: '0',
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
          // Starts from where the order says its goods are received; the
          // operator may choose another.
          defaultFrom: record(f('purchase_order_receiving_location_id')),
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
        // The receipt's paperwork, kept on the receipt; both may stay empty.
        {
          inputId: id('input', 'receive_packing_slip'),
          label: 'Packing slip / delivery note',
          orderKey: 60,
          type: 'text',
          required: false,
        },
        {
          inputId: id('input', 'receive_notes'),
          label: 'Notes',
          orderKey: 70,
          type: 'text',
          required: false,
          presentation: { kind: 'multiline' },
        },
      ],
      steps: [
        create(
          header,
          'goods_receipt',
          {
            // The receipt number is assigned by the server (RCV-000001).
            state: literal(id('option', 'goods_receipt_state_draft')),
            kind: literal(id('option', 'goods_receipt_kind_initial')),
            effective_at: generated('instant'),
            location_id: input('location'),
            reason_code: literal('RECEIVE'),
            reason_narrative: literal('Receive from purchase order'),
            packing_slip: input('packing_slip'),
            notes: input('notes'),
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
  const released = {
    value: record(
      id('derived_state_field', 'machine.purchase_order_lifecycle'),
    ),
    operator: 'equals',
    compare: id('state', 'purchase_order_released'),
  };
  const receiptLines = id('dataset', 'purchasing_receipt_lines');
  /**
   * A truck's delivery against this order (ORDER-PARITY, PaneFlow's
   * multi-line receipt): one receipt into one location, with a quantity typed
   * on each line that arrived. Rows start empty; "Fill open quantities" fills
   * each from what is still to arrive, and a line left empty is not received.
   * The receipt is created, each entered line added, then posted -- atomic in
   * the posting kernel, which refuses an over-receipt of any line.
   */
  const receiveLines = (known: boolean) => {
    const suffix = known ? 'known' : 'absent';
    const header = `receipt_lines_${suffix}`;
    const input = (name: string) => ({
      source: 'input',
      inputId: id('input', `receive_lines_${name}`),
    });
    return {
      actionId: id('action', `receive_lines_${suffix}`),
      label: known
        ? 'Receive lines with actual cost'
        : 'Receive lines with cost explicitly absent',
      description: known
        ? 'Posts one receipt for every line given a quantity, at the actual unit cost and currency you enter. A line left empty is not received.'
        : 'Posts one receipt for every line given a quantity, with actual cost explicitly recorded as absent. A line left empty is not received.',
      orderKey: known ? 5 : 6,
      conditions: [released],
      // A withheld open quantity keeps its line offered, left empty by Fill.
      rows: {
        datasetId: lines,
        conditions: [
          {
            value: selected(metric('open_to_receive')),
            operator: 'notEquals',
            compare: '0',
          },
        ],
        fillLabel: 'Fill open quantities',
      },
      inputs: [
        {
          inputId: id('input', 'receive_lines_quantity'),
          label: 'Quantity to receive',
          orderKey: 10,
          type: 'quantity',
          required: true,
          perRow: {
            fillFrom: {
              datasetId: lines,
              columnId: id('column', 'purchasing_open'),
            },
          },
        },
        {
          inputId: id('input', 'receive_lines_unit'),
          label: 'Base unit',
          orderKey: 20,
          type: 'text',
          required: true,
          perRow: {},
          // Each line's product base unit, read on the server.
          presentation: {
            kind: 'derived',
            column: {
              datasetId: lines,
              columnId: id('column', 'purchasing_base_unit'),
            },
          },
        },
        ...(known
          ? [
              {
                inputId: id('input', 'receive_lines_cost'),
                label: 'Actual received unit cost',
                orderKey: 30,
                type: 'text',
                required: true,
                perRow: {},
              },
            ]
          : []),
        {
          inputId: id('input', 'receive_lines_location'),
          label: 'Receiving location',
          orderKey: 40,
          type: 'reference',
          required: true,
          query: q('location_list'),
          labelField: ref('fieldReference', f('location_name')),
          defaultFrom: record(f('purchase_order_receiving_location_id')),
        },
        ...(known
          ? [
              {
                inputId: id('input', 'receive_lines_currency'),
                label: 'Actual cost currency',
                orderKey: 50,
                type: 'text',
                required: true,
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
        {
          inputId: id('input', 'receive_lines_packing_slip'),
          label: 'Packing slip / delivery note',
          orderKey: 60,
          type: 'text',
          required: false,
        },
        {
          inputId: id('input', 'receive_lines_notes'),
          label: 'Notes',
          orderKey: 70,
          type: 'text',
          required: false,
          presentation: { kind: 'multiline' },
        },
      ],
      steps: [
        create(
          header,
          'goods_receipt',
          {
            state: literal(id('option', 'goods_receipt_state_draft')),
            kind: literal(id('option', 'goods_receipt_kind_initial')),
            effective_at: generated('instant'),
            location_id: input('location'),
            reason_code: literal('RECEIVE'),
            reason_narrative: literal('Receive from purchase order'),
            packing_slip: input('packing_slip'),
            notes: input('notes'),
          },
          { order: record('recordId') },
        ),
        {
          ...create(
            `receipt_lines_line_${suffix}`,
            'goods_receipt_line',
            {
              // The order line's own number, so the receipt reads as the order.
              line_number: selected(f('purchase_order_line_line_number')),
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
          each: true,
        },
        step(`receipt_lines_post_${suffix}`, 'goods_receipt_post', [
          bind(['recordId'], stepValue(header, 'recordId')),
          bind(['expectedRevision'], stepValue(header, 'revision')),
        ]),
      ],
    };
  };
  /**
   * A posted receipt reversed through the receiving routes (ORDER-PARITY): a
   * draft receipt of kind reversal naming the original, one line for every
   * line of it that still adds to stock -- each at exactly that quantity,
   * compensating its own movement -- then posted. The posting kernel admits
   * only that (every uncompensated movement, each at its remainder, order
   * line, item, location and unit kept) and refuses it once the stock has
   * left; the read model offers only what it would admit.
   */
  const reverseReceipt = {
    actionId: id('action', 'reverse_receipt'),
    label: 'Reverse receipt',
    description:
      'Reverses every line of this receipt that still adds to stock, at exactly that quantity, with a posted reversal receipt. Refused if the stock has already left.',
    orderKey: 32,
    datasetId: receipts,
    presentation: { placement: 'selection' },
    conditions: [
      released,
      {
        value: selected(f('goods_receipt_state')),
        operator: 'equals',
        compare: id('option', 'goods_receipt_state_posted'),
      },
      {
        value: selected(f('goods_receipt_kind')),
        operator: 'equals',
        compare: id('option', 'goods_receipt_kind_initial'),
      },
    ],
    rows: {
      datasetId: receiptLines,
      conditions: [
        {
          value: selected(metric('reversible')),
          operator: 'positive',
          compare: null,
        },
      ],
    },
    inputs: [
      {
        inputId: id('input', 'reverse_receipt_reason'),
        label: 'Reason',
        orderKey: 10,
        type: 'text',
        required: true,
        presentation: { kind: 'multiline' },
      },
    ],
    steps: [
      create(
        'reversal',
        'goods_receipt',
        {
          state: literal(id('option', 'goods_receipt_state_draft')),
          kind: literal(id('option', 'goods_receipt_kind_reversal')),
          effective_at: generated('instant'),
          // The original's location: a reversal gives back where it received.
          location_id: selected(f('goods_receipt_location_id')),
          reason_code: literal('REVERSE'),
          reason_narrative: {
            source: 'input',
            inputId: id('input', 'reverse_receipt_reason'),
          },
          packing_slip: literal(null),
          notes: literal(null),
        },
        { order: record('recordId'), supersedes: selected('recordId') },
      ),
      {
        ...create(
          'reversal_line',
          'goods_receipt_line',
          {
            line_number: selected(f('goods_receipt_line_line_number')),
            item_id: selected(f('goods_receipt_line_item_id')),
            quantity: selected(metric('reversal_quantity')),
            unit_id: selected(f('goods_receipt_line_unit_id')),
            cost_status: selected(f('goods_receipt_line_cost_status')),
            unit_cost: selected(f('goods_receipt_line_unit_cost')),
            currency: selected(f('goods_receipt_line_currency')),
            reversal_of_movement_id: selected(metric('movement')),
          },
          {
            receipt: stepValue('reversal', 'recordId'),
            order_line: selected(metric('order_line')),
          },
        ),
        each: true,
      },
      step('reversal_post', 'goods_receipt_post', [
        bind(['recordId'], stepValue('reversal', 'recordId')),
        bind(['expectedRevision'], stepValue('reversal', 'revision')),
      ]),
    ],
  };
  const state = (operator: 'equals' | 'notEquals', local: string) => ({
    value: record(
      id('derived_state_field', 'machine.purchase_order_lifecycle'),
    ),
    operator,
    compare: id('state', `purchase_order_${local}`),
  });
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
          id('column', 'purchasing_payment_terms'),
          id('column', 'purchasing_total'),
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
      print: {
        label: 'Purchase order',
        datasets: [pricedLines],
        totals: [
          id('column', 'purchasing_subtotal'),
          id('column', 'purchasing_freight'),
          id('column', 'purchasing_other_fee'),
          id('column', 'purchasing_tax'),
          id('column', 'purchasing_total'),
        ],
        note: id('column', 'purchasing_notes'),
      },
      // Purchase to receipt: where this order stands and what to do next.
      progression: {
        title: 'Purchase to receipt',
        steps: [
          {
            label: 'Draft',
            current: [state('equals', 'draft')],
            complete: [
              state('notEquals', 'draft'),
              state('notEquals', 'cancelled'),
            ],
            stopped: [state('equals', 'cancelled')],
          },
          {
            label: 'Released',
            current: [],
            complete: [
              state('notEquals', 'draft'),
              state('notEquals', 'cancelled'),
            ],
            stopped: [state('equals', 'cancelled')],
          },
          {
            label: 'Receiving',
            current: [state('equals', 'released')],
            complete: [state('equals', 'closed')],
            stopped: [state('equals', 'cancelled')],
            documents: receipts,
          },
          {
            // PAYABLES: received quantity is waiting to be billed -- a closed
            // order too, since it is still billed.
            label: 'Billing',
            current: [state('equals', 'released')],
            complete: [state('equals', 'closed')],
            attention: [
              {
                value: record(metric('order_to_bill')),
                operator: 'positive',
                compare: null,
              },
            ],
            stopped: [state('equals', 'cancelled')],
            documents: bills,
          },
          {
            label: 'Closed',
            current: [],
            complete: [state('equals', 'closed')],
            stopped: [state('equals', 'cancelled')],
          },
        ],
        // Release, then receive what is still to arrive, bill what arrived,
        // then close: Close is next only once nothing is left to receive or
        // to bill.
        next: [
          {
            operation: ref(
              'operationReference',
              id('operation', 'purchase_order_release'),
            ),
          },
          { action: id('action', 'receive_lines_known') },
          // Then bill what was received and is not yet billed (PAYABLES).
          { action: id('action', 'bill_received') },
          {
            operation: ref(
              'operationReference',
              id('operation', 'purchase_order_close'),
            ),
          },
        ],
      },
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
      // Where the goods are received; shown in the document's details.
      column(
        'receive_into',
        'Receive into',
        42,
        f('purchase_order_receiving_location_id'),
        ['location_get', 'location_name'],
      ),
      column('currency', 'Currency', 45, f('purchase_order_currency')),
      column(
        'payment_terms',
        'Payment terms',
        46,
        f('purchase_order_payment_terms'),
      ),
      // Read back as stored; shown in the document's sections.
      column('notes', 'Notes', 50, f('purchase_order_notes')),
      column('tax_code', 'Tax code', 60, f('purchase_order_tax_code_id'), [
        'tax_code_get',
        'tax_code_code',
      ]),
      money(
        column('freight', 'Freight', 61, f('purchase_order_freight_amount')),
      ),
      column(
        'freight_tax_code',
        'Freight tax code',
        62,
        f('purchase_order_freight_tax_code_id'),
        ['tax_code_get', 'tax_code_code'],
      ),
      money(
        column(
          'other_fee',
          'Other fee',
          63,
          f('purchase_order_other_fee_amount'),
        ),
      ),
      column(
        'other_fee_tax_code',
        'Other fee tax code',
        64,
        f('purchase_order_other_fee_tax_code_id'),
        ['tax_code_get', 'tax_code_code'],
      ),
      money(column('subtotal', 'Subtotal', 70, metric('order_subtotal'))),
      money(column('charges', 'Charges', 71, metric('order_charges'))),
      money(column('tax', 'Tax', 72, metric('order_tax'))),
      money(column('total', 'Total', 73, metric('order_total'))),
    ],
    children: [
      {
        datasetId: pricedLines,
        label: 'Priced lines',
        orderKey: 5,
        query: q('commercial_purchase_order_lines'),
        presentation: { selection: 'none' },
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
            'priced_line',
            'Line',
            10,
            f('purchase_order_line_line_number'),
            undefined,
            'secondary',
          ),
          column(
            'priced_item',
            'Product',
            20,
            f('purchase_order_line_item_id'),
            ['item_get', 'item_name'],
            'primary',
          ),
          column(
            'priced_quantity',
            'Quantity',
            30,
            f('purchase_order_line_ordered_quantity'),
            undefined,
            'quantity',
          ),
          money(
            column(
              'priced_unit_cost',
              'Unit cost',
              40,
              f('purchase_order_line_unit_price'),
              undefined,
              'secondary',
            ),
          ),
          column(
            'priced_discount',
            'Discount %',
            50,
            f('purchase_order_line_discount_percent'),
            undefined,
            'detail',
          ),
          column(
            'priced_tax_code',
            'Tax code',
            60,
            f('purchase_order_line_tax_code_id'),
            ['tax_code_get', 'tax_code_code'],
            'detail',
          ),
          money(
            column(
              'priced_tax',
              'Tax',
              70,
              metric('line_tax'),
              undefined,
              'quantity',
            ),
          ),
          money(
            column(
              'priced_amount',
              'Amount',
              80,
              metric('line_amount'),
              undefined,
              'quantity',
            ),
          ),
        ],
      },
      {
        datasetId: lines,
        label: 'Order lines',
        orderKey: 10,
        // Read with what has arrived and what is still to arrive
        // (PURCHASING-PARITY), through the commercial purchase line query.
        query: q('commercial_purchase_order_lines'),
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
            'received',
            'Received',
            32,
            metric('received'),
            undefined,
            'quantity',
          ),
          column(
            'open',
            'Open',
            34,
            metric('open_to_receive'),
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
          {
            // Shown with grouped digits and two decimals, never rounded.
            ...column(
              'unit_cost',
              'Unit cost',
              50,
              f('purchase_order_line_unit_price'),
              undefined,
              'secondary',
            ),
            format: 'money' as const,
          },
        ],
      },
      {
        datasetId: receipts,
        label: 'Connected receipts',
        orderKey: 20,
        query: q('goods_receipt_list'),
        // Selectable (ORDER-PARITY): a selected receipt shows its lines and
        // what can still be reversed.
        presentation: {
          selection: 'explicit',
          selectedActions: 'row',
          compact: 'scrollTable',
        },
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
            'receipt_kind',
            'Kind',
            25,
            f('goods_receipt_kind'),
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
          column(
            'packing_slip',
            'Packing slip',
            40,
            f('goods_receipt_packing_slip'),
            undefined,
            'secondary',
          ),
        ],
      },
      {
        // The selected receipt's lines and what each still adds to stock.
        datasetId: receiptLines,
        label: 'Receipt lines',
        orderKey: 30,
        query: q('receiving_receipt_lines'),
        presentation: {
          selection: 'none',
          compact: 'scrollTable',
          description:
            'Reversible is what each line still adds to stock after earlier corrections. Missing or unavailable data is not zero.',
        },
        parent: {
          relationId: id('relation', 'goods_receipt_line_receipt'),
          value: { ...selected('recordId'), datasetId: receipts },
          ownership: 'parentScopedChild',
        },
        sort: [
          {
            fieldId: f('goods_receipt_line_line_number'),
            direction: 'ascending',
          },
        ],
        columns: [
          column(
            'receipt_line',
            'Line',
            10,
            f('goods_receipt_line_line_number'),
            undefined,
            'secondary',
          ),
          column(
            'receipt_item',
            'Product',
            20,
            f('goods_receipt_line_item_id'),
            ['item_get', 'item_name'],
            'primary',
          ),
          column(
            'receipt_quantity',
            'Quantity',
            30,
            f('goods_receipt_line_quantity'),
            undefined,
            'quantity',
          ),
          column(
            'receipt_unit',
            'Unit',
            40,
            f('goods_receipt_line_unit_id'),
            undefined,
            'secondary',
          ),
          column(
            'receipt_reversible',
            'Reversible',
            50,
            metric('reversible'),
            undefined,
            'quantity',
          ),
        ],
      },
      {
        // PAYABLES: the order's vendor bills and what each still owes.
        datasetId: bills,
        label: 'Bills',
        orderKey: 40,
        query: q('vendor_bill_list'),
        presentation: { selection: 'none', compact: 'scrollTable' },
        parent: {
          relationId: id('relation', 'vendor_bill_order'),
          value: record('recordId'),
          ownership: 'reference',
        },
        sort: [{ fieldId: f('vendor_bill_bill_date'), direction: 'ascending' }],
        columns: [
          column('bill', 'Bill', 10, f('vendor_bill_number')),
          column('bill_state', 'State', 20, f('vendor_bill_state')),
          column('bill_date', 'Bill date', 30, f('vendor_bill_bill_date')),
          column('bill_due', 'Due', 40, f('vendor_bill_due_date')),
          column(
            'bill_supplier_invoice',
            'Supplier invoice',
            45,
            f('vendor_bill_supplier_invoice_number'),
          ),
          money(column('bill_total', 'Total', 50, f('vendor_bill_total'))),
          money(
            column('bill_balance', 'Balance', 60, f('vendor_bill_balance')),
          ),
        ],
      },
    ],
    actions: [
      receiveLines(true),
      receiveLines(false),
      reverseReceipt,
      receive(true),
      receive(false),
      {
        // PURCHASING-PARITY: what will not arrive stops being expected. The
        // line's ordered quantity becomes what was received, through the
        // staged amendment request and the receiving amend, which refuses a
        // quantity below what was received; the reason stays with the request.
        actionId: id('action', 'close_remainder'),
        label: 'Close open remainder',
        description:
          'Stops expecting what has not arrived on this line: its ordered quantity becomes the quantity received. Nothing received is changed.',
        orderKey: 25,
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
          {
            value: selected(metric('open_to_receive')),
            operator: 'positive',
            compare: null,
          },
        ],
        inputs: [
          {
            inputId: id('input', 'close_remainder_reason'),
            label: 'Reason',
            orderKey: 10,
            type: 'text',
            required: true,
            presentation: { kind: 'multiline' },
          },
        ],
        steps: [
          create(
            'close_remainder_request',
            'purchase_order_amendment',
            {
              number: generated('uuid'),
              line_revision: selected('revision'),
              // What the operator saw received; the amend uses what is
              // received when it runs.
              quantity: selected(metric('received')),
              close_remainder: literal(true),
              reason: {
                source: 'input',
                inputId: id('input', 'close_remainder_reason'),
              },
            },
            { order_line: selected('recordId') },
          ),
          step('close_remainder_amend', 'purchase_order_line_amend', [
            bind(['recordId'], selected('recordId')),
            bind(['expectedRevision'], selected('revision')),
          ]),
        ],
      },
      {
        // PAYABLES (PY-B, PY-C): every received quantity not yet billed, at
        // the order's own costs, discounts and frozen rates; the first live
        // bill carries the freight and other fee.
        actionId: id('action', 'bill_received'),
        label: 'Bill received quantities',
        description:
          'Bills every received quantity not yet billed at this order’s costs and tax rates. The first bill also carries the freight and other fee.',
        orderKey: 27,
        // Offered while received quantity is not yet billed and the order's
        // figures can be stated; the capability decides per line.
        conditions: [
          {
            value: record(metric('order_to_bill')),
            operator: 'positive',
            compare: null,
          },
          {
            value: record(metric('order_total')),
            operator: 'positive',
            compare: null,
          },
        ],
        inputs: [
          {
            inputId: id('input', 'bill_supplier_invoice'),
            label: 'Supplier invoice number',
            orderKey: 10,
            type: 'text',
            required: false,
          },
        ],
        steps: [
          create(
            'bill_draft',
            'vendor_bill',
            {
              // The bill number is assigned on create (BILL-000001); the
              // bill is dated when it posts (PY-D).
              state: literal(id('option', 'vendor_bill_state_draft')),
              bill_date: generated('instant'),
              supplier_invoice_number: {
                source: 'input',
                inputId: id('input', 'bill_supplier_invoice'),
              },
            },
            { order: record('recordId') },
          ),
          step('bill_commit', 'vendor_bill_post', [
            bind(['recordId'], stepValue('bill_draft', 'recordId')),
            bind(['expectedRevision'], stepValue('bill_draft', 'revision')),
          ]),
        ],
      },
      {
        actionId: id('action', 'open_bill'),
        label: 'Open bill',
        description: 'Open the bill with its lines, payments and credits.',
        orderKey: 35,
        datasetId: bills,
        presentation: { placement: 'row' },
        conditions: [],
        inputs: [],
        steps: [],
        navigate: {
          surface: ref('surfaceReference', id('surface', 'vendor_bill_detail')),
          query: q('vendor_bill_get'),
          record: selected('recordId'),
        },
      },
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

/**
 * A vendor bill (PAYABLES): its frozen figures and balance, its lines, and the
 * payments and vendor credits against it. A payment or a credit posts only up
 * to the balance; Void is offered only while nothing is settled. Commands the
 * bill's own state admits -- Post on a draft whose post was refused -- come
 * from their declared preconditions.
 */
export function billWorkspace(namespace: string): Record<string, unknown> {
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
    columnId: id('column', `bill_${name}`),
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
  const money = <T extends object>(value: T) => ({
    ...value,
    format: 'money' as const,
  });
  const record = (name: string) => ({ source: 'record', field: name });
  const literal = (value: string | null) => ({ source: 'literal', value });
  const generated = (value: string) => ({ source: 'generated', value });
  const input = (name: string) => ({
    source: 'input',
    inputId: id('input', `bill_${name}`),
  });
  const bind = (path: string[], value: unknown) => ({ path, value });
  const step = (name: string, operation: string, bindings: unknown[]) => ({
    stepId: id('step', `bill_${name}`),
    operation: ref('operationReference', id('operation', operation)),
    bindings,
  });
  const settle = (
    kind: 'payment' | 'credit',
    values: Record<string, unknown>,
  ) => [
    step(`${kind}_draft`, `vendor_${kind}_create`, [
      bind(['recordId'], generated('uuid')),
      bind(['legalEntityId'], generated('scope')),
      ...Object.entries(values).map(([key, value]) =>
        bind(['values', field(`vendor_${kind}_${key}`)], value),
      ),
      bind(
        ['relations', id('relation', `vendor_${kind}_bill`)],
        record('recordId'),
      ),
    ]),
    step(`${kind}_commit`, `vendor_${kind}_post`, [
      bind(['recordId'], {
        source: 'step',
        stepId: id('step', `bill_${kind}_draft`),
        field: 'recordId',
      }),
      bind(['expectedRevision'], {
        source: 'step',
        stepId: id('step', `bill_${kind}_draft`),
        field: 'revision',
      }),
    ]),
  ];
  const state = field('vendor_bill_state');
  const inState = (...states: string[]) =>
    states.length === 1
      ? [
          {
            value: record(state),
            operator: 'equals',
            compare: id('option', `vendor_bill_state_${states[0]!}`),
          },
        ]
      : // Neither of the states the task does not apply to.
        (['draft', 'open', 'partially_paid', 'paid', 'void'] as const)
          .filter((value) => !states.includes(value))
          .map((value) => ({
            value: record(state),
            operator: 'notEquals',
            compare: id('option', `vendor_bill_state_${value}`),
          }));
  const amount = (label: string) => ({
    inputId: id('input', 'bill_amount'),
    label,
    orderKey: 10,
    type: 'quantity',
    required: true,
  });
  const lines = id('dataset', 'bill_lines');
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: id('column', 'bill_number'),
        subtitle: [id('column', 'bill_vendor')],
        status: id('column', 'bill_state'),
        facts: [
          id('column', 'bill_date'),
          id('column', 'bill_due'),
          id('column', 'bill_currency'),
          id('column', 'bill_total'),
          id('column', 'bill_balance'),
          id('column', 'bill_supplier_invoice'),
        ],
      },
      context: {
        label: 'Balance',
        description:
          'Record a payment or a vendor credit against this bill’s balance.',
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
      task: { mode: 'nativeDialog', fallback: 'page' },
      // The printable bill, saved as PDF by the browser.
      print: {
        label: 'Vendor bill',
        datasets: [lines],
        totals: [
          id('column', 'bill_subtotal'),
          id('column', 'bill_charges'),
          id('column', 'bill_tax'),
          id('column', 'bill_total'),
          id('column', 'bill_paid'),
          id('column', 'bill_credited'),
          id('column', 'bill_balance'),
        ],
      },
    },
    fields: [
      column('number', 'Bill', 10, field('vendor_bill_number')),
      column('state', 'Bill state', 15, state),
      column('vendor', 'Vendor', 20, field('vendor_bill_supplier_party_id'), [
        'party_get',
        'party_name',
      ]),
      column('date', 'Bill date', 25, field('vendor_bill_bill_date')),
      column('due', 'Due date', 30, field('vendor_bill_due_date')),
      column('currency', 'Currency', 35, field('vendor_bill_currency')),
      column('terms', 'Payment terms', 40, field('vendor_bill_payment_terms')),
      column(
        'supplier_invoice',
        'Supplier invoice number',
        45,
        field('vendor_bill_supplier_invoice_number'),
      ),
      ...[
        column('subtotal', 'Subtotal', 50, field('vendor_bill_subtotal')),
        column('charges', 'Charges', 51, field('vendor_bill_charges')),
        column('tax', 'Tax', 52, field('vendor_bill_tax')),
        column('total', 'Total', 53, field('vendor_bill_total')),
        column('paid', 'Paid', 54, field('vendor_bill_paid_amount')),
        column(
          'credited',
          'Credited',
          55,
          field('vendor_bill_credited_amount'),
        ),
        column('balance', 'Balance', 56, field('vendor_bill_balance')),
      ].map(money),
    ],
    children: [
      {
        datasetId: lines,
        presentation: { selection: 'none' },
        label: 'Bill lines',
        orderKey: 10,
        query: q('vendor_bill_line_list'),
        sort: [
          {
            fieldId: field('vendor_bill_line_line_number'),
            direction: 'ascending',
          },
        ],
        parent: {
          relationId: id('relation', 'vendor_bill_line_bill'),
          value: record('recordId'),
          ownership: 'parentScopedChild',
        },
        columns: [
          column('line', 'Line', 10, field('vendor_bill_line_line_number')),
          column('item', 'Item', 20, field('vendor_bill_line_item_id'), [
            'item_get',
            'item_name',
          ]),
          column(
            'quantity',
            'Quantity',
            30,
            field('vendor_bill_line_quantity'),
          ),
          column('unit', 'Unit', 40, field('vendor_bill_line_unit_id')),
          money(
            column(
              'unit_cost',
              'Unit cost',
              50,
              field('vendor_bill_line_unit_price'),
            ),
          ),
          column(
            'discount',
            'Discount %',
            60,
            field('vendor_bill_line_discount_percent'),
          ),
          column(
            'tax_rate',
            'Tax rate %',
            70,
            field('vendor_bill_line_tax_rate_percent'),
          ),
          money(
            column('amount', 'Amount', 80, field('vendor_bill_line_amount')),
          ),
          money(column('line_tax', 'Tax', 90, field('vendor_bill_line_tax'))),
        ],
      },
      ...(['payment', 'credit'] as const).map((kind, index) => ({
        datasetId: id('dataset', `bill_${kind}s`),
        presentation: { selection: 'none', compact: 'scrollTable' },
        label: kind === 'payment' ? 'Payments' : 'Vendor credits',
        orderKey: 20 + index * 10,
        query: q(`vendor_${kind}_list`),
        parent: {
          relationId: id('relation', `vendor_${kind}_bill`),
          value: record('recordId'),
          ownership: 'reference',
        },
        columns: [
          column(
            `${kind}_number`,
            kind === 'payment' ? 'Payment' : 'Credit',
            10,
            field(`vendor_${kind}_number`),
          ),
          column(`${kind}_state`, 'State', 20, field(`vendor_${kind}_state`)),
          column(
            `${kind}_date`,
            'Date',
            30,
            field(
              kind === 'payment'
                ? 'vendor_payment_payment_date'
                : 'vendor_credit_credit_date',
            ),
          ),
          money(
            column(
              `${kind}_amount`,
              'Amount',
              40,
              field(`vendor_${kind}_amount`),
            ),
          ),
          ...(kind === 'payment'
            ? [
                column(
                  'payment_method',
                  'Method',
                  50,
                  field('vendor_payment_method'),
                ),
                column(
                  'payment_reference',
                  'Reference',
                  60,
                  field('vendor_payment_reference'),
                ),
              ]
            : [
                column(
                  'credit_reason',
                  'Reason',
                  50,
                  field('vendor_credit_reason'),
                ),
              ]),
        ],
      })),
    ],
    actions: [
      {
        actionId: id('action', 'bill_record_payment'),
        label: 'Record payment',
        description:
          'Records a payment made to the vendor against this bill. It may not exceed the balance.',
        orderKey: 10,
        conditions: inState('open', 'partially_paid'),
        inputs: [
          amount('Amount paid'),
          {
            inputId: id('input', 'bill_method'),
            label: 'Method',
            orderKey: 20,
            type: 'text',
            required: true,
            presentation: {
              kind: 'choice',
              options: (
                [
                  ['cash', 'Cash'],
                  ['cheque', 'Cheque'],
                  ['eft', 'EFT'],
                  ['card', 'Card'],
                  ['other', 'Other'],
                ] as const
              ).map(([value, label]) => ({
                value: id('option', `vendor_payment_method_${value}`),
                label,
              })),
              defaultValue: id('option', 'vendor_payment_method_eft'),
            },
          },
          {
            inputId: id('input', 'bill_reference'),
            label: 'Reference (cheque or transaction number)',
            orderKey: 30,
            type: 'text',
            required: true,
          },
        ],
        steps: settle('payment', {
          // The payment number is assigned on create (VPAY-000001).
          state: literal(id('option', 'vendor_payment_state_draft')),
          payment_date: generated('instant'),
          amount: input('amount'),
          method: input('method'),
          reference: input('reference'),
        }),
      },
      {
        actionId: id('action', 'bill_record_credit'),
        label: 'Record vendor credit',
        description:
          'Records a credit the vendor issued against this bill’s balance, such as for a return or a price correction.',
        orderKey: 20,
        conditions: inState('open', 'partially_paid'),
        inputs: [
          amount('Amount credited'),
          {
            inputId: id('input', 'bill_reason'),
            label: 'Reason',
            orderKey: 20,
            type: 'text',
            required: true,
            presentation: { kind: 'multiline' },
          },
        ],
        steps: settle('credit', {
          // The credit number is assigned on create (VCM-000001).
          state: literal(id('option', 'vendor_credit_state_draft')),
          credit_date: generated('instant'),
          amount: input('amount'),
          reason: input('reason'),
        }),
      },
      {
        actionId: id('action', 'bill_void'),
        label: 'Void bill',
        description:
          'Voids this bill while nothing is paid or credited on it; its quantities can be billed again.',
        orderKey: 30,
        conditions: inState('open'),
        inputs: [],
        steps: [
          step('void', 'vendor_bill_void', [
            bind(['recordId'], record('recordId')),
            bind(['expectedRevision'], record('revision')),
          ]),
        ],
      },
    ],
  };
}
