/** Cross-module commercial links belong to application assembly, not either module. */
export const DROP_SHIP_CAPABILITY_ID = 'northstar.commercial:capability.drop_ship';
export const DROP_SHIP_CAPABILITY_VERSION = 1;

type Node = Record<string, unknown>;
const node = (value: unknown): Node => value as Node;
const rows = (value: unknown): Node[] => value as Node[];
const version = 'v6';
const id = (type: string, local: string) => `northstar.app:${type}.${local}`;
const ref = (kind: string, targetId: string) => ({ kind, schemaVersion: version, targetId });
const field = (local: string) => id('field', local);
const query = (local: string) => ref('queryReference', id('query', local));
const value = (source: string, field: string) => ({ source, field });
const literal = (value: unknown) => ({ source: 'literal', value });
const column = (local: string, label: string, orderKey: number, name: string) => ({
  columnId: id('column', local), label, orderKey, field: name,
});

/** Reuse canonical document declarations; all resulting metadata is compiled normally. */
export function withDropShip<T extends Node>(application: T): T {
  const result = structuredClone(application);
  const find = (key: string, property: string, local: string) => {
    const found = rows(result[key]).find((row) => row[property] === id(
      property === 'storageMappingId' ? 'storage' : property.replace(/Id$/u, ''), local));
    if (!found) throw new Error(`Missing ${key}/${local}`);
    return found;
  };
  const clone = (source: Node) => JSON.parse(JSON.stringify(source).replaceAll('vendor_credit', 'drop_ship_delivery')) as Node;
  const add = (key: string, source: Node) => rows(result[key]).push(source);
  const delivery = 'drop_ship_delivery';
  add('entities', { ...clone(find('entities', 'entityId', 'vendor_credit')), label: 'Supplier delivery', orderKey: 110 });
  add('storageMappings', clone(find('storageMappings', 'storageMappingId', 'vendor_credit')));
  add('assertions', clone(find('assertions', 'assertionId', 'vendor_credit_walking_slice')));
  const templates = rows(result.fields).filter((row) => node(row.entity).targetId === id('entity', 'vendor_credit'));
  for (const template of templates) {
    const copy = clone(template);
    if (String(copy.fieldId).endsWith('_amount')) {
      copy.fieldId = field(`${delivery}_quantity`); copy.label = 'Delivered quantity';
    } else if (String(copy.fieldId).endsWith('_credit_date')) {
      copy.fieldId = field(`${delivery}_delivery_date`); copy.label = 'Delivery date';
    } else if (String(copy.fieldId).endsWith('_number')) {
      copy.label = 'Delivery number'; node(copy.numbering).prefix = 'DSD';
    } else if (String(copy.fieldId).endsWith('_state')) {
      rows(node(copy.fieldType).options).push({ kind: 'enumOption', schemaVersion: version,
        optionId: id('option', `${delivery}_state_reversed`), label: 'Reversed', orderKey: 30 });
    } else if (String(copy.fieldId).endsWith('_reason')) {
      copy.presence = 'optional'; copy.label = 'Notes';
    }
    add('fields', copy);
  }
  const extraField = (entity: string, local: string, label: string, orderKey: number, type: Node) => ({
    ...find('fields', 'fieldId', 'sales_order_line_tax_code_id'),
    entity: ref('entityReference', id('entity', entity)), fieldId: field(local), label, orderKey,
    searchable: false, fieldType: { schemaVersion: version, ...type }, presence: 'optional',
  });
  add('fields', extraField('sales_order_line', 'sales_order_line_fulfillment_route', 'Fulfillment route', 100, {
    kind: 'enumFieldType', options: ['stock', 'drop_ship'].map((route, index) => ({
      kind: 'enumOption', schemaVersion: version, optionId: id('option', `fulfillment_route_${route}`),
      label: route === 'stock' ? 'Stock' : 'Drop ship', orderKey: (index + 1) * 10,
    })),
  }));
  add('fields', extraField('sales_order_line', 'sales_order_line_drop_ship_supplier_id', 'Drop-ship supplier', 110, { kind: 'textFieldType', maximumLength: 80 }));
  Object.assign(find('fields', 'fieldId', 'sales_order_line_fulfillment_route'), {
    defaultSemantics: 'coalesceAtRead', defaultValue: { kind: 'textValue', schemaVersion: version, value: id('option', 'fulfillment_route_stock') },
  });
  add('fields', extraField(delivery, `${delivery}_unit_id`, 'Unit', 60, { kind: 'textFieldType', maximumLength: 32 }));
  add('fields', extraField(delivery, `${delivery}_external_reference`, 'Supplier reference', 70, { kind: 'textFieldType', maximumLength: 120 }));
  add('fields', extraField(delivery, `${delivery}_reversal_reason`, 'Reversal reason', 80, { kind: 'textFieldType', maximumLength: 500 }));
  for (const source of rows(result.fields).filter((row) => String(row.fieldId).startsWith(field('sales_order_ship_to_'))))
    add('fields', { ...source, fieldId: String(source.fieldId).replace('sales_order_', 'purchase_order_'),
      entity: ref('entityReference', id('entity', 'purchase_order')), orderKey: Number(source.orderKey) + 300 });
  const relation = (local: string, source: string, target: string, required = false) => ({
    ...find('relations', 'relationId', 'vendor_credit_bill'), relationId: id('relation', local),
    sourceEntity: ref('entityReference', id('entity', source)),
    targetEntity: ref('entityReference', id('entity', target)), required,
    orderKey: 200 + rows(result.relations).length,
  });
  for (const [local, source, target, required] of [
    ['sales_order_line_purchase_line', 'sales_order_line', 'purchase_order_line', false],
    ['purchase_order_line_sales_line', 'purchase_order_line', 'sales_order_line', false],
    [`${delivery}_sales_order`, delivery, 'sales_order', true],
    [`${delivery}_purchase_order`, delivery, 'purchase_order', true],
    [`${delivery}_sales_line`, delivery, 'sales_order_line', true],
    [`${delivery}_purchase_line`, delivery, 'purchase_order_line', true],
  ] as const) add('relations', relation(local, source, target, required));

  for (const key of ['permissions', 'operations', 'queries', 'surfaces']) {
    const property = key === 'permissions' ? 'permissionId' : key === 'operations' ? 'operationId' : key === 'queries' ? 'queryId' : 'surfaceId';
    for (const source of rows(result[key]).filter((row) => String(row[property]).startsWith(id(property.replace(/Id$/u, ''), 'vendor_credit') + '_'))) {
      const copy = clone(source);
      if (key === 'queries') {
        if (String(copy.queryId).endsWith('_list')) copy.exportMaximumResultCount = 5000;
        copy.selections = rows(result.fields).filter((row) => node(row.entity).targetId === id('entity', delivery)).map((row, index) => ({
          kind: 'querySelection', schemaVersion: version, selectionId: id('selection', `${String(copy.queryId).split('.').at(-1)}_${index + 1}`),
          field: ref('fieldReference', String(row.fieldId)), orderKey: (index + 1) * 10,
        }));
      }
      if (key === 'operations' && node(copy.effect).kind === 'registeredCapabilityEffect')
        node(copy.effect).capability = ref('capabilityReference', DROP_SHIP_CAPABILITY_ID);
      if (key === 'surfaces') {
        copy.label = String(copy.label).replace('Vendor credit', 'Supplier delivery');
        node(copy.workspace).ownerSurfaceId = id('surface', 'purchase_order_list');
        node(node(copy.workspace).entry).authorizationQueryId = id('query', 'purchase_order_list');
        // A new List is declared below after the shared List pass.
        delete copy.list;
      }
      add(key, copy);
    }
  }
  add('capabilityRequirements', { ...rows(result.capabilityRequirements).find((row) => row.capabilityId === 'northstar.purchasing:capability.payables'),
    capabilityId: DROP_SHIP_CAPABILITY_ID });
  const command = (local: string, entity: string, label: string, before?: string) => {
    const source = clone(find('operations', 'operationId', 'vendor_credit_post'));
    source.operationId = id('operation', local); source.permission = ref('permissionReference', id('permission', local));
    source.readBack = query(`${entity}_get`);
    node(source.effect).capability = ref('capabilityReference', DROP_SHIP_CAPABILITY_ID);
    source.precondition = before ? {
      kind: 'fieldComparisonPredicate', schemaVersion: version,
      field: ref('fieldReference', id('derived_state_field', `machine.${entity}_lifecycle`)),
      operator: 'equals', value: { kind: 'textValue', schemaVersion: version, value: id('state', `${entity}_${before}`) },
    } : { ...node(source.precondition), value: { kind: 'textValue', schemaVersion: version, value: id('option', `${delivery}_state_posted`) } };
    add('operations', source);
    const permission = clone(find('permissions', 'permissionId', 'vendor_credit_post'));
    permission.permissionId = id('permission', local); permission.label = label;
    permission.resource = ref('entityReference', id('entity', entity));
    add('permissions', permission);
  };
  command('sales_order_create_drop_ship_po', 'sales_order', 'Create drop-ship PO', 'released');
  command('drop_ship_delivery_reverse', delivery, 'Reverse supplier delivery');
  command('purchase_order_record_delivery', 'purchase_order', 'Record supplier delivery', 'released');
  for (const [local, capability] of [['sales_order_close', 'northstar.sales:capability.receivables'], ['purchase_order_close', 'northstar.purchasing:capability.payables']] as const)
    node(find('operations', 'operationId', local).effect).capability = ref('capabilityReference', capability);

  for (const q of rows(result.queries)) {
    if (node(q.sourceEntity).targetId === id('entity', 'purchase_order')) {
      for (const source of rows(result.fields).filter((row) => String(row.fieldId).startsWith(field('purchase_order_ship_to_'))))
        rows(q.selections).push({ kind: 'querySelection', schemaVersion: version,
          selectionId: id('selection', `${String(q.queryId).split('.').at(-1)}_${String(source.fieldId).split('.').at(-1)}`),
          field: ref('fieldReference', String(source.fieldId)), orderKey: 300 + rows(q.selections).length });
    }
    if (node(q.sourceEntity).targetId === id('entity', 'sales_order_line')) {
      for (const local of ['sales_order_line_fulfillment_route', 'sales_order_line_drop_ship_supplier_id'])
        rows(q.selections).push({ kind: 'querySelection', schemaVersion: version,
          selectionId: id('selection', `${String(q.queryId).split('.').at(-1)}_${local}`),
          field: ref('fieldReference', field(local)), orderKey: 200 + rows(q.selections).length });
    }
    if (q.readModel) {
      const model = node(q.readModel);
      const kind = String(model.binding);
      if (kind.includes('.commercial_') || kind.endsWith('.fulfillment_line')) node(model.queries).deliveries = query(`${delivery}_list`);
      // All line models expose a separate delivered figure. The runtime never
      // replaces the physical projection's shipped/received quantity.
      if (kind.endsWith('.commercial_line') || kind.endsWith('.commercial_purchase_line') || kind.endsWith('.fulfillment_line'))
        node(model.resultFields).delivered = id('metric', kind.endsWith('.commercial_purchase_line') ? 'purchase_line_delivered' : 'line_delivered');
    }
  }

  const task = (local: string, label: string, operation: string, bindings: Node[] = []) => ({
    actionId: id('action', local), orderKey: 120, label, description: label,
    conditions: [], inputs: [], steps: [{ stepId: id('step', local),
      operation: ref('operationReference', id('operation', operation)), bindings: [
        { path: ['recordId'], value: value('record', 'recordId') },
        { path: ['expectedRevision'], value: value('record', 'revision') }, ...bindings,
      ] }],
  });
  const deliveriesSection = (order: string) => ({
    datasetId: id('dataset', `${order}_deliveries`), label: 'Deliveries', orderKey: 80,
    query: query(`${delivery}_list`), parent: { relationId: id('relation', `${delivery}_${order}`), ownership: 'reference', value: value('record', 'recordId') },
    columns: [column(`${order}_delivery_number`, 'Delivery', 10, field(`${delivery}_number`)),
      column(`${order}_delivery_quantity`, 'Delivered', 20, field(`${delivery}_quantity`)),
      column(`${order}_delivery_state`, 'State', 30, field(`${delivery}_state`))],
  });
  for (const surface of rows(result.surfaces)) {
    const local = String(surface.surfaceId).split(':surface.')[1];
    if (surface.documentEditor && local?.startsWith('sales_order_')) {
      const editor = node(surface.documentEditor);
      if (editor.lineFields && !rows(editor.lineFields).some((entry) => entry.fieldId === field('sales_order_line_fulfillment_route'))) rows(editor.lineFields).push(
        { fieldId: field('sales_order_line_fulfillment_route'), label: 'Fulfillment route (Stock by default)' },
        { fieldId: field('sales_order_line_drop_ship_supplier_id'), label: 'Drop-ship supplier',
          reference: { queryId: id('query', 'party_list'), getQueryId: id('query', 'party_get'), labelFieldIds: [field('party_name')] } });
    }
    if (local === 'sales_order_detail' || local === 'purchase_order_detail') {
      const order = local.replace('_detail', ''); const composition = node(surface.composition);
      if (order === 'purchase_order') for (const source of rows(result.fields).filter((row) => String(row.fieldId).startsWith(field('purchase_order_ship_to_'))))
        rows(composition.fields).push(column(`purchase_${String(source.fieldId).split('.').at(-1)}`, String(source.label), 400 + rows(composition.fields).length, String(source.fieldId)));
      rows(composition.children).push(deliveriesSection(order));
      const lines = rows(composition.children).find((child) => String(node(child.query).targetId).includes('line'))!;
      rows(lines.columns).push(column(`${order}_delivered`, 'Delivered', 125, id('metric', order === 'sales_order' ? 'line_delivered' : 'purchase_line_delivered')));
      if (order === 'sales_order') {
        rows(lines.columns).push(column('sales_line_route', 'Route', 126, field('sales_order_line_fulfillment_route')));
        rows(composition.actions).push(task('create_drop_ship_po', 'Create drop-ship PO', 'sales_order_create_drop_ship_po'));
      } else {
        rows(composition.actions).push({ ...task('record_supplier_delivery', 'Record supplier delivery', 'purchase_order_record_delivery', [
          { path: ['arguments', 'purchaseLineId'], value: value('selected', 'recordId') },
          { path: ['arguments', 'quantity'], value: { source: 'input', inputId: id('input', 'delivery_quantity') } },
          { path: ['arguments', 'reference'], value: { source: 'input', inputId: id('input', 'delivery_reference') } },
        ]), datasetId: lines.datasetId, inputs: [
          { inputId: id('input', 'delivery_quantity'), label: 'Delivered quantity', orderKey: 10, required: true, type: 'quantity' },
          { inputId: id('input', 'delivery_reference'), label: 'Supplier reference', orderKey: 20, required: false, type: 'text' },
        ] });
      }
      // Read-only relation navigation is declared just like invoice/order links.
      rows(composition.actions).push({ actionId: id('action', `${order}_open_delivery`), orderKey: 130,
        label: 'Open delivery', description: 'Open the supplier delivery document', conditions: [], inputs: [], steps: [],
        datasetId: id('dataset', `${order}_deliveries`), navigate: { surface: ref('surfaceReference', id('surface', `${delivery}_detail`)),
          query: query(`${delivery}_get`), record: value('selected', 'recordId') } });
    }
    if (local === `${delivery}_detail`) {
      surface.composition = {
        kind: 'surfaceComposition', schemaVersion: version,
        fields: rows(result.fields).filter((row) => node(row.entity).targetId === id('entity', delivery)).map((row, index) => column(`delivery_${index}`, String(row.label), (index + 1) * 10, String(row.fieldId))),
        children: [], actions: [task('post_delivery', 'Record supplier delivery', `${delivery}_post`),
          { ...task('reverse_delivery', 'Reverse supplier delivery', `${delivery}_reverse`, [{ path: ['arguments', 'reason'], value: { source: 'input', inputId: id('input', 'delivery_reversal_reason') } }]),
            inputs: [{ inputId: id('input', 'delivery_reversal_reason'), label: 'Reason', orderKey: 10, required: true, type: 'text' }] }],
      };
      rows(surface.slots).push({ kind: 'surfaceSlot', schemaVersion: version, slot: 'childTables',
        slotId: id('slot', 'drop_ship_delivery_detail_child_tables'), orderKey: 60,
        content: ref('opaqueSurfaceContentReference', id('capability', 'standard_surface_content')) });
    }
  }
  return result;
}
