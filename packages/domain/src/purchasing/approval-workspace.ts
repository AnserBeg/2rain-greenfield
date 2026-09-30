/** Approval content inside the shared Record, Task and List grammar. */
const ref = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: 'v6',
  targetId,
});

function action(
  namespace: string,
  name: string,
  label: string,
  target: 'record' | 'selected',
  operation: string,
  inputs: Record<string, unknown>[] = [],
  extra: unknown[] = [],
) {
  const id = (kind: string, local: string) => `${namespace}:${kind}.${local}`;
  return {
    actionId: id('action', name),
    label,
    description: label,
    orderKey: name === 'submit_approval' ? 1 : 5,
    conditions: [],
    inputs,
    steps: [
      {
        stepId: id('step', name),
        operation: ref('operationReference', id('operation', operation)),
        bindings: [
          { path: ['recordId'], value: { source: target, field: 'recordId' } },
          {
            path: ['expectedRevision'],
            value: { source: target, field: 'revision' },
          },
          ...extra,
        ],
      },
    ],
  };
}

export function approvalWorkspace(namespace: string): Record<string, unknown> {
  const f = (name: string) =>
    `${namespace}:field.purchase_order_approval_${name}`;
  const column = (name: string, label: string, orderKey: number) => ({
    columnId: `${namespace}:column.approval_${name}`,
    label,
    orderKey,
    field: f(name),
  });
  const reason = (name: string) => ({
    inputId: `${namespace}:input.${name}_reason`,
    label: 'Reason',
    orderKey: 10,
    type: 'text',
    required: true,
    presentation: { kind: 'multiline' },
  });
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: `${namespace}:column.approval_order_number`,
        subtitle: [],
        status: `${namespace}:column.approval_state`,
        facts: [
          `${namespace}:column.approval_kind`,
          `${namespace}:column.approval_requested_by`,
        ],
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
      task: { mode: 'nativeDialog', fallback: 'page' },
    },
    fields: [
      column('order_number', 'Purchase order', 10),
      column('state', 'Decision', 20),
      column('kind', 'Request kind', 30),
      column('requested_by', 'Requested by', 40),
      column('reason', 'Request reason', 50),
      column('decided_by', 'Decided by', 60),
      column('decision_reason', 'Decision reason', 70),
    ],
    children: [],
    actions: ['approve', 'reject'].map((decision) => ({
      ...action(
        namespace,
        `approval_${decision}`,
        decision === 'approve' ? 'Approve' : 'Reject',
        'record',
        `purchase_order_approval_${decision}`,
        [reason(decision)],
        [
          {
            path: ['arguments', 'reason'],
            value: {
              source: 'input',
              inputId: `${namespace}:input.${decision}_reason`,
            },
          },
        ],
      ),
      conditions: [
        {
          value: { source: 'record', field: f('state') },
          operator: 'equals',
          compare: `${namespace}:option.purchase_order_approval_state_pending`,
        },
      ],
    })),
  };
}

export function withApprovalWorkspace(
  namespace: string,
  composition: Record<string, unknown>,
): Record<string, unknown> {
  const id = (kind: string, local: string) => `${namespace}:${kind}.${local}`;
  const record = (field: string) => ({ source: 'record', field });
  const inDraft = {
    value: record(
      id('derived_state_field', 'machine.purchase_order_lifecycle'),
    ),
    operator: 'equals',
    compare: id('state', 'purchase_order_draft'),
  };
  const field = (name: string, label: string, orderKey: number) => ({
    columnId: id('column', `purchasing_${name}`),
    label,
    orderKey,
    field: id('metric', name),
  });
  const submit = {
    ...action(
      namespace,
      'submit_approval',
      'Submit for approval',
      'record',
      'purchase_order_submit',
    ),
    conditions: [
      inDraft,
      {
        value: record(id('metric', 'approval_required')),
        operator: 'equals',
        compare: true,
      },
      {
        value: record(id('metric', 'approval_status')),
        operator: 'notEquals',
        compare: 'Pending',
      },
      {
        value: record(id('metric', 'approval_status')),
        operator: 'notEquals',
        compare: 'Approved',
      },
    ],
  };
  const place = {
    ...action(
      namespace,
      'place_order',
      'Place order',
      'record',
      'purchase_order_release',
      [
        {
          inputId: id('input', 'place_supplier_reference'),
          label: 'Supplier reference',
          orderKey: 10,
          type: 'text',
          required: false,
        },
      ],
      [
        {
          path: ['arguments', 'supplierReference'],
          value: {
            source: 'input',
            inputId: id('input', 'place_supplier_reference'),
          },
        },
      ],
    ),
    description:
      'Place this order with its optional supplier reference. Receiving opens once the order is Released.',
    conditions: [
      inDraft,
      {
        value: record(id('metric', 'approval_ready')),
        operator: 'equals',
        compare: true,
      },
    ],
  };
  const requestAmendment = {
    ...action(
      namespace,
      'request_quantity_amendment',
      'Request quantity amendment',
      'selected',
      'purchase_order_line_amend',
      [
        {
          inputId: id('input', 'amend_quantity'),
          label: 'New ordered quantity',
          orderKey: 10,
          type: 'quantity',
          required: true,
        },
        {
          inputId: id('input', 'amend_reason'),
          label: 'Reason',
          orderKey: 20,
          type: 'text',
          required: true,
          presentation: { kind: 'multiline' },
        },
      ],
      [
        {
          path: ['arguments', 'quantity'],
          value: { source: 'input', inputId: id('input', 'amend_quantity') },
        },
        {
          path: ['arguments', 'reason'],
          value: { source: 'input', inputId: id('input', 'amend_reason') },
        },
      ],
    ),
    datasetId: id('dataset', 'purchasing_lines'),
    presentation: { placement: 'selection' },
    orderKey: 24,
    description:
      'Stage a new ordered quantity. Receiving continues on the current quantity while approval is pending.',
    conditions: [
      {
        value: record(
          id('derived_state_field', 'machine.purchase_order_lifecycle'),
        ),
        operator: 'equals',
        compare: id('state', 'purchase_order_released'),
      },
    ],
  };
  const presentation = composition.presentation as Record<string, unknown>;
  const header = presentation.header as Record<string, unknown>;
  const progression = presentation.progression as Record<string, unknown>;
  return {
    ...composition,
    presentation: {
      ...presentation,
      header: {
        ...header,
        facts: [
          ...(header.facts as unknown[]),
          id('column', 'purchasing_approval_status'),
        ],
      },
      context: {
        label: 'Purchasing',
        description:
          'Submit for approval, place the current approved revision, then receive against the released quantities.',
      },
      progression: {
        ...progression,
        next: [
          { action: submit.actionId },
          { action: place.actionId },
          ...(progression.next as Record<string, unknown>[]).filter(
            (entry) =>
              !('operation' in entry) ||
              (entry.operation as { targetId: string }).targetId !==
                id('operation', 'purchase_order_release'),
          ),
        ],
      },
    },
    fields: [
      ...(composition.fields as unknown[]),
      field('approval_status', 'Approval', 180),
      {
        columnId: id('column', 'purchasing_supplier_reference'),
        label: 'Supplier reference',
        orderKey: 190,
        field: id('field', 'purchase_order_supplier_reference'),
      },
    ],
    children: [
      ...(composition.children as unknown[]),
      {
        datasetId: id('dataset', 'purchasing_approvals'),
        label: 'Approval requests',
        orderKey: 80,
        query: ref(
          'queryReference',
          id('query', 'purchase_order_approval_list'),
        ),
        parent: {
          relationId: id('relation', 'purchase_order_approval_order'),
          value: record('recordId'),
          ownership: 'reference',
        },
        sort: [],
        columns: ['number', 'state', 'kind', 'reason', 'decision_reason'].map(
          (name, i) => ({
            columnId: id('column', `purchasing_approval_${name}`),
            label: name.replaceAll('_', ' '),
            orderKey: (i + 1) * 10,
            field: id('field', `purchase_order_approval_${name}`),
          }),
        ),
      },
    ],
    actions: [
      submit,
      place,
      requestAmendment,
      ...(composition.actions as Record<string, unknown>[]),
      {
        actionId: id('action', 'open_approval'),
        label: 'Open approval',
        description: 'Read or decide this request.',
        orderKey: 90,
        datasetId: id('dataset', 'purchasing_approvals'),
        presentation: { placement: 'row' },
        conditions: [],
        inputs: [],
        steps: [],
        navigate: {
          surface: ref(
            'surfaceReference',
            id('surface', 'purchase_order_approval_detail'),
          ),
          query: ref(
            'queryReference',
            id('query', 'purchase_order_approval_get'),
          ),
          record: { source: 'selected', field: 'recordId' },
        },
      },
    ],
  };
}

export function declareApprovalReadModels(
  namespace: string,
  queries: Record<string, unknown>[],
): Record<string, unknown>[] {
  return queries.map((query) => {
    if (
      query.queryId !== `${namespace}:query.commercial_purchase_order_get` &&
      query.queryId !== `${namespace}:query.commercial_purchase_order_list`
    )
      return query;
    const model = query.readModel as {
      queries: Record<string, unknown>;
      resultFields: Record<string, unknown>;
    };
    return {
      ...query,
      readModel: {
        ...model,
        queries: {
          ...model.queries,
          settings: ref(
            'queryReference',
            `${namespace}:query.purchasing_settings_list`,
          ),
          approvals: ref(
            'queryReference',
            `${namespace}:query.purchase_order_approval_list`,
          ),
        },
        resultFields: {
          ...model.resultFields,
          ...Object.fromEntries(
            ['approval_required', 'approval_status', 'approval_ready'].map(
              (name) => [name, `${namespace}:metric.${name}`],
            ),
          ),
        },
      },
    };
  });
}
