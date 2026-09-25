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
    const field = (
      name: string,
      label: string,
      declared: Record<string, unknown> = {},
    ) => ({ fieldId: id('field', name), label, ...declared });
    // Counterparty and product pickers search the authorized list query and can
    // create the missing master in context. A customer or vendor is a Party plus
    // an active role, so its flow chains the two existing governed creates.
    const counterparty = (role: 'customer' | 'supplier') => ({
      reference: {
        queryId: id('query', 'party_list'),
        getQueryId: id('query', 'party_get'),
        labelFieldIds: [id('field', 'party_name')],
        detailFieldIds: [id('field', 'party_number')],
        create: {
          label: role === 'customer' ? 'New customer' : 'New vendor',
          explanation:
            role === 'customer'
              ? 'Creates the customer now as its own record. Saving or discarding this order does not undo it.'
              : 'Creates the vendor now as its own record. Saving or discarding this order does not undo it.',
          fields: [
            {
              fieldId: id('field', 'party_number'),
              label: role === 'customer' ? 'Customer number' : 'Vendor number',
            },
            { fieldId: id('field', 'party_name'), label: 'Name' },
            {
              fieldId: id('field', 'party_contact_summary'),
              label: 'Contact',
              presentation: { kind: 'multiline' },
            },
          ],
          steps: [
            { operationId: id('operation', 'party_create') },
            {
              operationId: id('operation', 'party_role_create'),
              fixed: [
                {
                  fieldId: id('field', 'party_role_kind'),
                  value: id('option', role),
                },
                {
                  fieldId: id('field', 'party_role_status'),
                  value: id('option', 'active'),
                },
              ],
              relations: [
                { relationId: id('relation', 'party_role_party'), step: 0 },
              ],
            },
          ],
          selectStep: 0,
        },
      },
    });
    const product = {
      reference: {
        queryId: id('query', 'item_list'),
        getQueryId: id('query', 'item_get'),
        labelFieldIds: [id('field', 'item_name')],
        detailFieldIds: [
          id('field', 'item_sku'),
          id('field', 'item_base_unit'),
        ],
        create: {
          label: 'New product',
          explanation:
            'Creates the product now as its own record. Saving or discarding this order does not undo it.',
          fields: [
            { fieldId: id('field', 'item_sku'), label: 'SKU' },
            { fieldId: id('field', 'item_name'), label: 'Name' },
            { fieldId: id('field', 'item_base_unit'), label: 'Base unit' },
            {
              fieldId: id('field', 'item_description'),
              label: 'Description',
              presentation: { kind: 'multiline' },
            },
          ],
          steps: [{ operationId: id('operation', 'item_create') }],
          selectStep: 0,
        },
      },
    };
    // Editor choice policy for the document currency. The stored field stays
    // text; these are the offered codes, and CAD is the declared default.
    const currency = {
      presentation: {
        kind: 'choice',
        options: [
          { value: 'CAD', label: 'CAD · Canadian dollar' },
          { value: 'USD', label: 'USD · US dollar' },
          { value: 'EUR', label: 'EUR · Euro' },
        ],
        defaultValue: 'CAD',
      },
    };
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
        field(
          `${local}_${party}_party_id`,
          sales ? 'Customer' : 'Vendor',
          counterparty(sales ? 'customer' : 'supplier'),
        ),
        field(`${local}_order_date`, 'Order date'),
        field(`${local}_${date}`, sales ? 'Requested date' : 'Expected date'),
        field(`${local}_currency`, 'Currency', currency),
        field(`${local}_notes`, 'Notes', {
          presentation: { kind: 'multiline' },
        }),
      ],
      lineFields: [
        field(`${local}_line_item_id`, 'Product', product),
        field(`${local}_line_ordered_quantity`, 'Quantity'),
        // The model has one unit per product, so the line shows that product's
        // base unit rather than inviting free text that could disagree with it.
        ...(sales
          ? [
              field(`${local}_line_unit_id`, 'Unit', {
                presentation: {
                  kind: 'derived',
                  referenceFieldId: id('field', `${local}_line_item_id`),
                  sourceFieldId: id('field', 'item_base_unit'),
                },
              }),
            ]
          : []),
        field(`${local}_line_unit_price`, sales ? 'Unit price' : 'Unit cost'),
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
