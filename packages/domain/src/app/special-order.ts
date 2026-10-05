/** Special-order content extends the existing commercial demand/supply link. */
type Node = Record<string, unknown>;
const node = (value: unknown): Node => value as Node;
const rows = (value: unknown): Node[] => value as Node[];
const id = (kind: string, local: string) => `northstar.app:${kind}.${local}`;
const query = (local: string) => ({
  kind: 'queryReference',
  schemaVersion: 'v6',
  targetId: id('query', local),
});
const selected = (field: string) => ({ source: 'selected', field });

export function withSpecialOrder<T extends Node>(application: T): T {
  const result = structuredClone(application);
  const route = rows(result.fields).find(
    (row) => row.fieldId === id('field', 'sales_order_line_fulfillment_route'),
  )!;
  rows(node(route.fieldType).options).push({
    kind: 'enumOption',
    schemaVersion: 'v6',
    optionId: id('option', 'fulfillment_route_special_order'),
    label: 'Special order',
    orderKey: 30,
  });
  rows(result.fields).find(
    (row) =>
      row.fieldId === id('field', 'sales_order_line_drop_ship_supplier_id'),
  )!.label = 'Supplier';
  for (const key of ['operations', 'permissions']) {
    const property = key === 'operations' ? 'operationId' : 'permissionId';
    const source = rows(result[key]).find(
      (row) =>
        row[property] ===
        id(property.replace(/Id$/u, ''), 'sales_order_create_drop_ship_po'),
    )!;
    const copy = structuredClone(source);
    copy[property] = id(
      property.replace(/Id$/u, ''),
      'sales_order_create_special_order_po',
    );
    if (key === 'permissions') copy.label = 'Create special-order PO';
    else
      copy.permission = {
        kind: 'permissionReference',
        schemaVersion: 'v6',
        targetId: id('permission', 'sales_order_create_special_order_po'),
      };
    rows(result[key]).push(copy);
  }
  for (const definition of rows(result.queries)) {
    if (!definition.readModel) continue;
    const model = node(definition.readModel);
    if (!node(model.resultFields).linked_line) continue;
    const purchase = String(model.binding).endsWith(
      '.commercial_purchase_line',
    );
    node(model.queries).arrivals = query('purchase_order_received_get');
    node(model.resultFields).arrived = id(
      'metric',
      `${purchase ? 'purchase' : 'sales'}_line_arrived`,
    );
    if (model.binding === 'northstar.sales:read_model.line')
      node(model.resultFields).special_reservable = id(
        'metric',
        'special_reservable',
      );
  }
  for (const surface of rows(result.surfaces)) {
    if (
      surface.documentEditor &&
      String(surface.surfaceId).includes('sales_order_')
    ) {
      for (const field of rows(node(surface.documentEditor).lineFields ?? []))
        if (
          field.fieldId ===
          id('field', 'sales_order_line_drop_ship_supplier_id')
        )
          field.label = 'Supplier (Drop ship or Special order)';
    }
    if (
      !['sales_order_detail', 'purchase_order_detail'].some(
        (local) => surface.surfaceId === id('surface', local),
      )
    )
      continue;
    const purchase =
      surface.surfaceId === id('surface', 'purchase_order_detail');
    const composition = node(surface.composition);
    const actions = rows(composition.actions);
    const children = rows(composition.children);
    for (const child of children) {
      if (
        !rows(child.columns).some(
          (column) =>
            column.field ===
            id('metric', `${purchase ? 'purchase' : 'sales'}_line_route`),
        )
      )
        continue;
      rows(child.columns).push({
        columnId: id(
          'column',
          `${purchase ? 'purchase' : 'sales'}_${String(child.datasetId).split('.').at(-1)}_arrived`,
        ),
        label: 'Arrived',
        orderKey: 180,
        field: id('metric', `${purchase ? 'purchase' : 'sales'}_line_arrived`),
      });
    }
    if (purchase) {
      for (const action of actions) {
        const conditions = String(action.actionId).includes('.receive_lines_')
          ? rows(node(action.rows).conditions)
          : rows(action.conditions);
        if (
          ![
            '.receive_known',
            '.receive_absent',
            '.close_remainder',
            '.receive_lines_',
          ].some((suffix) => String(action.actionId).includes(suffix))
        )
          continue;
        for (const condition of conditions)
          if (condition.compare === 'Stock') {
            condition.operator = 'notEquals';
            condition.compare = 'Drop ship';
          }
      }
      continue;
    }
    const create = structuredClone(
      actions.find(
        (action) => action.actionId === id('action', 'create_drop_ship_po'),
      )!,
    );
    create.actionId = id('action', 'create_special_order_po');
    create.label = 'Create special-order PO';
    create.description =
      'Create or reuse dedicated purchase supply received into stock.';
    node(rows(create.steps)[0]!.operation).targetId = id(
      'operation',
      'sales_order_create_special_order_po',
    );
    for (const condition of rows(create.conditions))
      if (condition.compare === 'Drop ship')
        condition.compare = 'Special order';
    actions.push(create);
    const reserve = structuredClone(
      actions.find(
        (action) => action.actionId === id('action', 'reserve_stock'),
      )!,
    );
    reserve.actionId = id('action', 'reserve_special_order');
    reserve.orderKey = 15;
    reserve.label = 'Reserve for the special order';
    reserve.description =
      'Reserve arrived, unshipped and unreserved supply at the stock location you choose.';
    for (const condition of rows(reserve.conditions))
      if (condition.compare === 'Stock') condition.compare = 'Special order';
    reserve.conditions = [
      ...rows(reserve.conditions),
      {
        value: selected(id('metric', 'special_reservable')),
        operator: 'positive',
        compare: null,
      },
    ];
    reserve.inputs = rows(reserve.inputs).filter(
      (input) => input.type !== 'quantity',
    );
    const dataset = children.find(
      (child) => child.datasetId === reserve.datasetId,
    )!;
    const quantityColumn = id('column', 'special_reservable');
    const quantityPresentation = structuredClone(
      node(
        rows(dataset.columns).find(
          (column) => column.field === id('metric', 'coverage'),
        )!.presentation,
      ),
    );
    rows(dataset.columns).push({
      columnId: quantityColumn,
      label: 'Arrived to reserve',
      orderKey: 185,
      field: id('metric', 'special_reservable'),
      presentation: quantityPresentation,
    });
    node(node(node(reserve.presentation).task).confirmation).quantity = {
      source: 'column',
      datasetId: dataset.datasetId,
      columnId: quantityColumn,
    };
    for (const step of rows(reserve.steps))
      for (const binding of rows(step.bindings)) {
        if (
          JSON.stringify(binding.value) ===
          JSON.stringify({ source: 'input', inputId: id('input', 'quantity') })
        )
          binding.value = selected(id('metric', 'special_reservable'));
      }
    actions.push(reserve);
  }
  return result;
}
