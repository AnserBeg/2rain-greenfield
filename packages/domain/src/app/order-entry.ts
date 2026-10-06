import { isWorklist, worklistPlacement } from './list-declarations.js';

/** Each document List's own name; any other editor's List keeps its label. */
const DOCUMENT_LIST_LABELS: Readonly<Record<string, string>> = {
  sales_order: 'Sales orders',
  purchase_order: 'Purchase orders',
  inventory_transaction: 'Inventory transactions',
};

/** Product declarations for the shared draft document renderer. */
export function orderEntrySurfaces(
  namespace: string,
  surfaces: Record<string, unknown>[],
  queries: readonly Record<string, unknown>[] = [],
) {
  const id = (type: string, local: string) => `${namespace}:${type}.${local}`;
  // Whether the item's get reads a field: the replenishment fields exist only
  // where the application mounts Catalog with them (REPLENISHMENT).
  const itemGet = queries.find(
    (query) => query.queryId === id('query', 'item_get'),
  );
  const itemReads = (name: string) =>
    ((itemGet?.selections ?? []) as { field?: { targetId?: unknown } }[]).some(
      (selection) => selection.field?.targetId === id('field', name),
    );
  // A location's inventory status changes only through its page's "Change
  // status", with a reason (LOCATIONS): the generic form leaves it out.
  const locationGet = queries.find(
    (query) => query.queryId === id('query', 'location_get'),
  );
  const locationStatus = [
    'location_status',
    'location_status_reason',
    'location_status_changed_at',
  ].filter((name) =>
    (
      (locationGet?.selections ?? []) as { field?: { targetId?: unknown } }[]
    ).some((selection) => selection.field?.targetId === id('field', name)),
  );
  // A product picker also finds an item by an alias -- another SKU, a
  // barcode or a supplier's code -- where Catalog is mounted with them
  // (CATALOG-EXTRAS).
  const aliasSearch = queries.some(
    (query) => query.queryId === id('query', 'item_alias_list'),
  )
    ? {
        searchChildren: [
          {
            queryId: id('query', 'item_alias_list'),
            relationId: id('relation', 'item_alias_item'),
            fieldId: id('field', 'item_alias_value'),
          },
        ],
      }
    : {};
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
        // Only parties with an active role of this kind. A party holding both
        // roles is offered to both documents.
        eligibility: {
          queryId: id('query', 'party_role_list'),
          relationId: id('relation', 'party_role_party'),
          filters: [
            {
              fieldId: id('field', 'party_role_kind'),
              value: id('option', role),
            },
            {
              fieldId: id('field', 'party_role_status'),
              value: id('option', 'active'),
            },
          ],
        },
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
        ...aliasSearch,
        create: {
          label: 'New product',
          explanation:
            'Creates the product now as its own record. Saving or discarding this order does not undo it.',
          fields: [
            { fieldId: id('field', 'item_sku'), label: 'SKU' },
            { fieldId: id('field', 'item_name'), label: 'Name' },
            // The unit codes the catalog is configured with, offered rather than
            // typed. A code list only: no unit master or conversion exists.
            {
              fieldId: id('field', 'item_base_unit'),
              label: 'Base unit',
              presentation: {
                kind: 'choice',
                options: [
                  { value: 'EA', label: 'EA · Each' },
                  { value: 'BOX', label: 'BOX · Box' },
                  { value: 'CASE', label: 'CASE · Case' },
                  { value: 'PACK', label: 'PACK · Pack' },
                  { value: 'PAIR', label: 'PAIR · Pair' },
                  { value: 'ROLL', label: 'ROLL · Roll' },
                ],
                defaultValue: 'EA',
              },
            },
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
    const fromCustomer = (source: string) => ({
      defaultFrom: {
        referenceFieldId: id('field', `${local}_customer_party_id`),
        sourceFieldId: id('field', source),
      },
    });
    // A purchase order's supplier sets its currency, terms and tax code the
    // same way (ruling B extended to purchasing): a Party's defaults serve
    // whichever role it plays.
    const fromVendor = (source: string) => ({
      defaultFrom: {
        referenceFieldId: id('field', `${local}_supplier_party_id`),
        sourceFieldId: id('field', source),
      },
    });
    const fromAddress = (source: string) => ({
      defaultFrom: {
        referenceFieldId: id('field', `${local}_ship_to_address_id`),
        sourceFieldId: id('field', `party_address_${source}`),
      },
    });
    // A salesperson is a Party with an active salesperson role (ruling E).
    const salesperson = {
      reference: {
        queryId: id('query', 'party_list'),
        getQueryId: id('query', 'party_get'),
        labelFieldIds: [id('field', 'party_name')],
        detailFieldIds: [id('field', 'party_number')],
        eligibility: {
          queryId: id('query', 'party_role_list'),
          relationId: id('relation', 'party_role_party'),
          filters: [
            {
              fieldId: id('field', 'party_role_kind'),
              value: id('option', 'salesperson'),
            },
            {
              fieldId: id('field', 'party_role_status'),
              value: id('option', 'active'),
            },
          ],
        },
      },
    };
    const taxCode = {
      reference: {
        queryId: id('query', 'tax_code_list'),
        getQueryId: id('query', 'tax_code_get'),
        labelFieldIds: [id('field', 'tax_code_code')],
        detailFieldIds: [id('field', 'tax_code_name')],
      },
    };
    // Where a purchase order's goods are received; receipts start from it.
    const location = {
      reference: {
        queryId: id('query', 'location_list'),
        getQueryId: id('query', 'location_get'),
        labelFieldIds: [id('field', 'location_name')],
        detailFieldIds: [id('field', 'location_code')],
      },
    };
    // A rate is frozen from its tax code when the code is chosen (ruling B).
    const rateOf = (taxCodeField: string) => ({
      presentation: {
        kind: 'derived',
        referenceFieldId: id('field', taxCodeField),
        sourceFieldId: id('field', 'tax_code_rate_percent'),
      },
    });
    // A charge's tax code follows the order's whenever that changes.
    const fromOrderTaxCode = {
      defaultFrom: {
        referenceFieldId: id('field', `${local}_tax_code_id`),
        headerFieldId: id('field', `${local}_tax_code_id`),
      },
    };
    const priceInCurrency = {
      headerFieldId: id('field', `${local}_currency`),
      cases: (['cad', 'usd', 'eur'] as const).map((code) => ({
        value: code.toUpperCase(),
        sourceFieldId: id('field', `item_price_${code}`),
      })),
    };
    // A purchase line's unit cost starts from the item's standard cost in
    // the order currency (ruling PC), as a sales line's price does from its
    // price; a cost that differs from it is the buyer's to keep.
    const costInCurrency = {
      headerFieldId: id('field', `${local}_currency`),
      cases: (['cad', 'usd', 'eur'] as const).map((code) => ({
        value: code.toUpperCase(),
        sourceFieldId: id('field', `item_standard_cost_${code}`),
      })),
    };
    const standardCosts = (['cad', 'usd', 'eur'] as const).every((code) =>
      itemReads(`item_standard_cost_${code}`),
    );
    const shipTo = {
      reference: {
        queryId: id('query', 'party_address_list'),
        getQueryId: id('query', 'party_address_get'),
        labelFieldIds: [id('field', 'party_address_label')],
        detailFieldIds: [
          id('field', 'party_address_street'),
          id('field', 'party_address_city'),
        ],
        within: {
          referenceFieldId: id('field', `${local}_customer_party_id`),
          relationId: id('relation', 'party_address_party'),
        },
      },
    };
    return {
      kind: 'draftDocumentEditor',
      headerLabel: 'Order details',
      linesLabel: 'Order lines',
      saveDescription: sales
        ? 'Save commits the header and each line in sequence. Drafts do not change stock. Confirm is a separate action, offered once the order has a complete ship-to address (street, city, postal code and country).'
        : 'Save commits the header and each line in sequence. Drafts do not change stock. Place order is a separate action.',
      saveMode: 'sequential',
      headerFormSurfaceId: id('surface', `${local}_form`),
      recordSurfaceId: id('surface', `${local}_detail`),
      lineFormSurfaceId: id('surface', `${local}_line_form`),
      lineQueryId: id('query', `${local}_line_list`),
      parentRelationId: id('relation', `${local}_line_order`),
      stateFieldId: id('derived_state_field', `machine.${local}_lifecycle`),
      editableStateIds: [id('state', `${local}_draft`)],
      lineNumberFieldId: id('field', `${local}_line_line_number`),
      // The order number is assigned by the server on first save.
      headerFields: sales
        ? [
            field(
              `${local}_customer_party_id`,
              'Customer',
              counterparty('customer'),
            ),
            // Customer defaults (owner ruling E): choosing a customer resets
            // each of these to that customer's value, then they are the
            // order's to change.
            field(`${local}_salesperson_party_id`, 'Salesperson', {
              ...salesperson,
              ...fromCustomer('party_default_salesperson_party_id'),
            }),
            field(`${local}_order_date`, 'Order date'),
            // A new order asks for delivery three weeks out, as the reference
            // does; the user changes it before saving.
            field(`${local}_requested_date`, 'Requested date', {
              defaultDaysFromToday: 21,
            }),
            field(`${local}_currency`, 'Currency', {
              ...currency,
              ...fromCustomer('party_default_currency'),
            }),
            field(
              `${local}_payment_terms`,
              'Payment terms',
              fromCustomer('party_payment_terms'),
            ),
            // The order's tax code (ruling B): the customer's, then each new
            // line and charge starts from it.
            field(`${local}_tax_code_id`, 'Tax code', {
              ...taxCode,
              ...fromCustomer('party_default_tax_code_id'),
            }),
            // The ship-to address is chosen from that customer's own book; the
            // order keeps its own copy of the lines, filled from the choice.
            field(`${local}_ship_to_address_id`, 'Ship-to address', {
              ...shipTo,
              ...fromCustomer('party_default_ship_to_address_id'),
            }),
            field(
              `${local}_ship_to_name`,
              'Recipient',
              fromAddress('recipient'),
            ),
            field(`${local}_ship_to_street`, 'Street', {
              presentation: { kind: 'multiline' },
              ...fromAddress('street'),
            }),
            field(`${local}_ship_to_city`, 'City', fromAddress('city')),
            field(
              `${local}_ship_to_region`,
              'Province or state',
              fromAddress('region'),
            ),
            field(
              `${local}_ship_to_postal_code`,
              'Postal code',
              fromAddress('postal_code'),
            ),
            field(
              `${local}_ship_to_country`,
              'Country',
              fromAddress('country'),
            ),
            // Two charges, each taxed by its own code (ruling B).
            field(`${local}_freight_amount`, 'Freight'),
            field(`${local}_freight_tax_code_id`, 'Freight tax code', {
              ...taxCode,
              ...fromOrderTaxCode,
            }),
            field(
              `${local}_freight_tax_rate_percent`,
              'Freight tax rate %',
              rateOf(`${local}_freight_tax_code_id`),
            ),
            field(`${local}_other_fee_amount`, 'Other fee'),
            field(`${local}_other_fee_tax_code_id`, 'Other fee tax code', {
              ...taxCode,
              ...fromOrderTaxCode,
            }),
            field(
              `${local}_other_fee_tax_rate_percent`,
              'Other fee tax rate %',
              rateOf(`${local}_other_fee_tax_code_id`),
            ),
            field(`${local}_notes`, 'Notes', {
              presentation: { kind: 'multiline' },
            }),
          ]
        : [
            field(
              `${local}_${party}_party_id`,
              'Vendor',
              counterparty('supplier'),
            ),
            field(`${local}_order_date`, 'Order date'),
            // Two weeks out, as the reference defaults it.
            field(`${local}_${date}`, 'Expected date', {
              defaultDaysFromToday: 14,
            }),
            field(`${local}_receiving_location_id`, 'Receive into', location),
            field(`${local}_currency`, 'Currency', {
              ...currency,
              ...fromVendor('party_default_currency'),
            }),
            field(
              `${local}_payment_terms`,
              'Payment terms',
              fromVendor('party_payment_terms'),
            ),
            field(`${local}_tax_code_id`, 'Tax code', {
              ...taxCode,
              ...fromVendor('party_default_tax_code_id'),
            }),
            field(`${local}_freight_amount`, 'Freight'),
            field(`${local}_freight_tax_code_id`, 'Freight tax code', {
              ...taxCode,
              ...fromOrderTaxCode,
            }),
            field(
              `${local}_freight_tax_rate_percent`,
              'Freight tax rate %',
              rateOf(`${local}_freight_tax_code_id`),
            ),
            field(`${local}_other_fee_amount`, 'Other fee'),
            field(`${local}_other_fee_tax_code_id`, 'Other fee tax code', {
              ...taxCode,
              ...fromOrderTaxCode,
            }),
            field(
              `${local}_other_fee_tax_rate_percent`,
              'Other fee tax rate %',
              rateOf(`${local}_other_fee_tax_code_id`),
            ),
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
        ...(sales
          ? [
              // The item's price in the order currency, taken when the
              // product is chosen and kept: a unit price that differs from
              // it reads as a manual override (ruling B).
              field(`${local}_line_unit_price`, 'Unit price', {
                defaultFrom: {
                  referenceFieldId: id('field', `${local}_line_item_id`),
                  sourceByHeader: priceInCurrency,
                },
              }),
              field(`${local}_line_list_price`, 'List price', {
                presentation: {
                  kind: 'derived',
                  referenceFieldId: id('field', `${local}_line_item_id`),
                  sourceFieldId: id('field', 'item_price_cad'),
                  sourceByHeader: priceInCurrency,
                },
              }),
              field(`${local}_line_discount_percent`, 'Discount %'),
              field(`${local}_line_tax_code_id`, 'Tax code', {
                ...taxCode,
                defaultFrom: {
                  referenceFieldId: id('field', `${local}_line_item_id`),
                  headerFieldId: id('field', `${local}_tax_code_id`),
                },
              }),
              field(
                `${local}_line_tax_rate_percent`,
                'Tax rate %',
                rateOf(`${local}_line_tax_code_id`),
              ),
            ]
          : [
              field(
                `${local}_line_unit_price`,
                'Unit cost',
                standardCosts
                  ? {
                      defaultFrom: {
                        referenceFieldId: id('field', `${local}_line_item_id`),
                        sourceByHeader: costInCurrency,
                      },
                    }
                  : {},
              ),
              field(`${local}_line_discount_percent`, 'Discount %'),
              field(`${local}_line_tax_code_id`, 'Tax code', {
                ...taxCode,
                defaultFrom: {
                  referenceFieldId: id('field', `${local}_line_item_id`),
                  headerFieldId: id('field', `${local}_tax_code_id`),
                },
              }),
              field(
                `${local}_line_tax_rate_percent`,
                'Tax rate %',
                rateOf(`${local}_line_tax_code_id`),
              ),
            ]),
      ],
    };
  };
  /**
   * A stock document (INVENTORY-PARITY): an adjustment or a transfer, entered
   * like an order. The server numbers it STK-000001 on its first save, which
   * also writes its draft state, names the document itself as its posting
   * source and records when and by whom; Post stays the existing confirmed
   * command on the saved record.
   */
  const stockDocument = () => {
    const field = (
      name: string,
      label: string,
      declared: Record<string, unknown> = {},
    ) => ({ fieldId: id('field', name), label, ...declared });
    const option = (name: string) =>
      id('option', `inventory_transaction_${name}`);
    const choice = (
      options: readonly (readonly [value: string, label: string])[],
      defaultValue?: string,
    ) => ({
      presentation: {
        kind: 'choice',
        options: options.map(([value, label]) => ({ value, label })),
        ...(defaultValue ? { defaultValue } : {}),
      },
    });
    const location = {
      reference: {
        queryId: id('query', 'location_list'),
        getQueryId: id('query', 'location_get'),
        labelFieldIds: [id('field', 'location_name')],
        detailFieldIds: [id('field', 'location_code')],
      },
    };
    return {
      kind: 'draftDocumentEditor',
      headerLabel: 'Stock document',
      linesLabel: 'Lines',
      saveDescription:
        'Save commits the header and each line. A draft does not change stock; Post is a separate, confirmed action.',
      saveMode: 'sequential',
      headerFormSurfaceId: id('surface', 'inventory_transaction_form'),
      recordSurfaceId: id('surface', 'inventory_transaction_detail'),
      lineFormSurfaceId: id('surface', 'inventory_transaction_line_form'),
      lineQueryId: id('query', 'inventory_transaction_line_list'),
      parentRelationId: id(
        'relation',
        'inventory_transaction_line_transaction',
      ),
      stateFieldId: id('field', 'inventory_transaction_state'),
      editableStateIds: [option('state_draft')],
      lineNumberFieldId: id('field', 'inventory_transaction_line_line_number'),
      headerFields: [
        // Of the stored types, only these two post through this document.
        field(
          'inventory_transaction_type',
          'Type',
          choice(
            [
              [option('type_adjustment'), 'Adjustment'],
              [option('type_transfer'), 'Transfer'],
            ],
            option('type_adjustment'),
          ),
        ),
        // Opening stock is an adjustment with the reason OPENING (ruling R3).
        field(
          'inventory_transaction_reason_code',
          'Reason',
          choice([
            ['DAMAGED', 'Damaged'],
            ['FOUND', 'Found'],
            ['LOST', 'Lost'],
            ['COUNT_ERROR', 'Count error'],
            ['SCRAP', 'Scrap'],
            ['OPENING', 'Opening stock'],
            ['RELOCATION', 'Relocation'],
          ]),
        ),
        field('inventory_transaction_reason_narrative', 'Narrative', {
          presentation: { kind: 'multiline' },
        }),
        // Now, not midnight (ruling INV-A): stock received earlier today is
        // on hand at that instant, so taking or moving it is not refused as
        // negative stock. The posting window admits no earlier day.
        field('inventory_transaction_effective_at', 'Effective date', {
          defaultNow: true,
        }),
      ],
      createValues: [
        {
          fieldId: id('field', 'inventory_transaction_state'),
          value: { source: 'literal', value: option('state_draft') },
        },
        {
          fieldId: id('field', 'inventory_transaction_source_type'),
          value: { source: 'literal', value: 'inventoryTransaction' },
        },
        {
          fieldId: id('field', 'inventory_transaction_source_id'),
          value: { source: 'record', field: 'recordId' },
        },
        // When and by whom the document was first recorded; the movements
        // carry their own posting time and actor.
        {
          fieldId: id('field', 'inventory_transaction_recorded_at'),
          value: { source: 'generated', value: 'instant' },
        },
        {
          fieldId: id('field', 'inventory_transaction_actor_id'),
          value: { source: 'actor', field: 'principalId' },
        },
      ],
      lineFields: [
        // Products are chosen, never created here: a stock document does not
        // mint masters.
        field('inventory_transaction_line_item_id', 'Product', {
          reference: {
            queryId: id('query', 'item_list'),
            getQueryId: id('query', 'item_get'),
            labelFieldIds: [id('field', 'item_name')],
            detailFieldIds: [
              id('field', 'item_sku'),
              id('field', 'item_base_unit'),
            ],
            ...aliasSearch,
          },
        }),
        // A negative adjustment takes stock from its From location, a
        // positive one adds it at its To location; a transfer names both.
        field(
          'inventory_transaction_line_from_location_id',
          'From location',
          location,
        ),
        field(
          'inventory_transaction_line_to_location_id',
          'To location',
          location,
        ),
        field('inventory_transaction_line_quantity', 'Quantity'),
        // The posting kernel takes the product's base unit and no other.
        field('inventory_transaction_line_unit_id', 'Unit', {
          presentation: {
            kind: 'derived',
            referenceFieldId: id('field', 'inventory_transaction_line_item_id'),
            sourceFieldId: id('field', 'item_base_unit'),
          },
        }),
      ],
    };
  };
  const documents = new Map<string, Record<string, unknown>>([
    ['inventory_transaction', stockDocument()],
    [
      'sales_order',
      document('sales_order', 'customer', 'requested_date', true),
    ],
    [
      'purchase_order',
      document('purchase_order', 'supplier', 'expected_date', false),
    ],
  ]);
  // A List whose declared query is scoped to exactly one company enters with
  // the caller's authorized company, like the document workspaces do.
  const companyScoped = new Set(
    queries.flatMap((query) => {
      const scope = query.legalEntityScope as
        { cardinality?: string } | undefined;
      return query.queryType === 'list' && scope?.cardinality === 'exactlyOne'
        ? [String(query.queryId)]
        : [];
    }),
  );
  // Line tables belong inside the document that owns them; navigation lists
  // the documents. Each remains a contextual, deep-linkable surface.
  const lineOwners: Readonly<Record<string, string>> = {
    inventory_transaction_line: 'inventory_transaction',
    stock_count_line: 'stock_count',
    // An invoice's lines, payments and credits belong to its workspace.
    customer_invoice_line: 'customer_invoice',
    customer_payment: 'customer_invoice',
    customer_credit: 'customer_invoice',
    // A vendor bill's the same way (PAYABLES).
    vendor_bill_line: 'vendor_bill',
    vendor_payment: 'vendor_bill',
    vendor_credit: 'vendor_bill',
  };
  // A tenant-level child belongs to its master's workspace, such as a
  // customer's ship-to addresses or an item's aliases (CATALOG-EXTRAS); it
  // has no company entry to resolve.
  const masterOwners: Readonly<Record<string, string>> = {
    item_alias: 'item',
    party_address: 'party',
  };
  return surfaces.map((surface) => {
    const name = String(surface.surfaceId).split(':surface.')[1]!;
    const role = surface.surfaceRole;
    const local = name.replace(/_(list|detail|form)$/, '');
    const editor = documents.get(local);
    const owner =
      local === 'purchase_order_approval'
        ? 'purchase_order_approval'
        : local.startsWith('purchase_order') ||
            local.startsWith('goods_receipt')
          ? 'purchase_order'
          : local.startsWith('sales_order') ||
              [
                'reservation',
                'reservation_balance',
                'shipment',
                'shipment_line',
              ].includes(local)
            ? 'sales_order'
            : (lineOwners[local] ?? null);
    const master = masterOwners[local] ?? null;
    // A worklist beside a document's List (Expected receipts beside Purchase
    // orders) is a business destination of its own, entered with the caller's
    // company and authorized by its own query.
    const worklist = role === 'list' && isWorklist(name);
    // An item is shared by every company; its page shows one company's stock
    // and movements, entered like the Posted stock List and authorized by
    // that List's query (INVENTORY-PARITY).
    const stockPage = role === 'record' && local === 'item';
    // A List over shared items read in one company (REPLENISHMENT): listed
    // in another module's group and entered like the Posted stock List.
    const placement = role === 'list' ? worklistPlacement(name) : null;
    // Three Lists read items now; the Items List keeps the item's page and
    // form as their workspace -- the picker, breadcrumb and navigation
    // authority for an item (REPLENISHMENT).
    const itemOwned = role !== 'list' && local === 'item';
    const listQueryId = String(
      (surface.dataSource as { targetId?: unknown } | undefined)?.targetId,
    );
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
            ? editor ||
              worklist ||
              local === 'posted_stock_balance' ||
              local === 'inventory_value' ||
              local === 'customer_invoice' ||
              local === 'purchase_order_approval' ||
              local === 'vendor_bill'
              ? 'operational'
              : owner || master
                ? 'contextual'
                : 'setup'
            : 'contextual',
        ...(placement
          ? { navigationModuleId: id('module', placement.navigationModule) }
          : {}),
        ...(owner || master
          ? { ownerSurfaceId: id('surface', `${owner ?? master}_list`) }
          : itemOwned
            ? { ownerSurfaceId: id('surface', 'item_list') }
            : {}),
        ...(editor ||
        owner ||
        worklist ||
        stockPage ||
        local === 'posted_stock_balance' ||
        local === 'inventory_value' ||
        (role === 'list' && companyScoped.has(listQueryId))
          ? {
              entry: {
                ...company,
                authorizationQueryId: id(
                  'query',
                  stockPage
                    ? 'posted_stock_balance_list'
                    : (placement?.authorization ?? `${owner ?? local}_list`),
                ),
              },
            }
          : {}),
      },
      // The item's preferred location is chosen from the locations by name;
      // the field keeps the location's id (REPLENISHMENT).
      ...(role === 'form' &&
      local === 'item' &&
      itemReads('item_preferred_location_id')
        ? {
            form: {
              kind: 'surfaceForm',
              schemaVersion: 'v6',
              references: [
                {
                  field: id('field', 'item_preferred_location_id'),
                  query: {
                    kind: 'queryReference',
                    schemaVersion: 'v6',
                    targetId: id('query', 'location_list'),
                  },
                  labelField: {
                    kind: 'fieldReference',
                    schemaVersion: 'v6',
                    targetId: id('field', 'location_name'),
                  },
                },
              ],
            },
          }
        : {}),
      ...(role === 'form' && local === 'location' && locationStatus.length
        ? {
            form: {
              kind: 'surfaceForm',
              schemaVersion: 'v6',
              omit: locationStatus.map((name) => id('field', name)),
            },
          }
        : {}),
      ...(editor && role === 'list' && DOCUMENT_LIST_LABELS[local]
        ? { label: DOCUMENT_LIST_LABELS[local] }
        : {}),
      ...(local === 'customer_invoice' && role === 'list'
        ? { label: 'Invoices' }
        : {}),
      ...(local === 'vendor_bill' && role === 'list' ? { label: 'Bills' } : {}),
    };
  });
}
