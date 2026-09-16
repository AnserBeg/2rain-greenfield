/** Product declarations for the shared draft document renderer. */
export function orderEntrySurfaces(
  namespace: string,
  surfaces: Record<string, unknown>[],
) {
  const id = (type: string, local: string) => `${namespace}:${type}.${local}`;
  const company = {
    companyQueryId: id('query', 'legal_entity_list'),
    companyNameFieldId: id('field', 'legal_entity_name'),
    companyStateFieldId: id('field', 'legal_entity_status'),
    activeStateId: id('option', 'legal_entity_status_active'),
    policy: 'authorizedSingleOrPreference',
  };
  const document = (
    local: string,
    party: string,
    date: string,
    sales: boolean,
  ) => {
    const field = (name: string, label: string, ref?: [string, string[]]) => ({
      fieldId: id('field', name),
      label,
      ...(ref
        ? {
            reference: {
              queryId: id('query', ref[0]),
              labelFieldIds: ref[1].map((value) => id('field', value)),
            },
          }
        : {}),
    });
    return {
      kind: 'draftDocumentEditor',
      headerLabel: 'Order details',
      linesLabel: 'Order lines',
      saveDescription:
        'Save commits the header and each line in sequence. Drafts do not change stock. Release is a separate action.',
      saveMode: 'sequential',
      headerFormSurfaceId: id('surface', `${local}_form`),
      recordSurfaceId: id('surface', `${local}_detail`),
      lineFormSurfaceId: id('surface', `${local}_line_form`),
      lineQueryId: id('query', `${local}_line_list`),
      parentRelationId: id('relation', `${local}_line_order`),
      stateFieldId: id('derived_state_field', `machine.${local}_lifecycle`),
      editableStateIds: [id('state', `${local}_draft`)],
      lineNumberFieldId: id('field', `${local}_line_line_number`),
      headerFields: [
        field(`${local}_number`, 'Order number'),
        field(`${local}_${party}_party_id`, sales ? 'Customer' : 'Vendor', [
          'party_list',
          ['party_name'],
        ]),
        field(`${local}_order_date`, 'Order date'),
        field(`${local}_${date}`, sales ? 'Requested date' : 'Expected date'),
        field(`${local}_currency`, 'Currency'),
        field(`${local}_notes`, 'Notes'),
      ],
      lineFields: [
        field(`${local}_line_item_id`, 'Product', [
          'item_list',
          ['item_name', 'item_sku', 'item_base_unit'],
        ]),
        field(`${local}_line_ordered_quantity`, 'Quantity'),
        ...(sales ? [field(`${local}_line_unit_id`, 'Unit')] : []),
        field(`${local}_line_unit_price`, 'Unit price'),
      ],
    };
  };
  const documents = new Map([
    [
      'sales_order',
      document('sales_order', 'customer', 'requested_date', true),
    ],
    [
      'purchase_order',
      document('purchase_order', 'supplier', 'expected_date', false),
    ],
  ]);
  return surfaces.map((surface) => {
    const name = String(surface.surfaceId).split(':surface.')[1]!;
    const role = surface.surfaceRole;
    const local = name.replace(/_(list|detail|form)$/, '');
    const editor = documents.get(local);
    const owner =
      local.startsWith('purchase_order') || local.startsWith('goods_receipt')
        ? 'purchase_order'
        : local.startsWith('sales_order') ||
            [
              'reservation',
              'reservation_balance',
              'shipment',
              'shipment_line',
            ].includes(local)
          ? 'sales_order'
          : null;
    return {
      ...surface,
      ...(editor && role !== 'list' ? { documentEditor: editor } : {}),
      ...(editor && role === 'form'
        ? {
            slots: (surface.slots as Record<string, unknown>[]).map((slot) => ({
              ...slot,
              ...(slot.slot === 'commandBar' ? { orderKey: 90 } : {}),
            })),
          }
        : {}),
      workspace: {
        membership:
          role === 'list'
            ? editor || local === 'posted_stock_balance'
              ? 'operational'
              : owner
                ? 'contextual'
                : 'setup'
            : 'contextual',
        ...(owner ? { ownerSurfaceId: id('surface', `${owner}_list`) } : {}),
        ...(editor || owner || local === 'posted_stock_balance'
          ? {
              entry: {
                ...company,
                authorizationQueryId: id('query', `${owner ?? local}_list`),
              },
            }
          : {}),
      },
      ...(editor && role === 'list'
        ? {
            label: local === 'sales_order' ? 'Sales orders' : 'Purchase orders',
          }
        : {}),
    };
  });
}
