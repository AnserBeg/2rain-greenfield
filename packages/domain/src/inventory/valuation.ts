/** ADR-0067: operational valuation is compiled content over plain queries. */
export const VALUATION_CAPABILITY_ID =
  'northstar.inventory:capability.valuation';
export const VALUATION_ITEM_BINDING =
  'northstar.inventory:read_model.item_cost';
export const VALUATION_SHIPMENT_BINDING =
  'northstar.inventory:read_model.shipment_cost';
export const VALUATION_SHIPMENT_LINE_BINDING =
  'northstar.inventory:read_model.shipment_line_cost';
export const VALUATION_INVOICE_BINDING =
  'northstar.inventory:read_model.invoice_cost';
export const VALUATION_COST_OUTPUTS = [
  'cost_of_goods',
  'cost_unvalued_quantity',
  'cost_coverage',
] as const;
export const VALUATION_ITEM_OUTPUTS = [
  'on_hand',
  'average_cost',
  'inventory_value',
  'unvalued_quantity',
] as const;

const ref = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: 'v6',
  targetId,
});

export function valuationQueries(
  namespace: string,
  queries: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const clone = (source: string, name: string) => {
    const query = queries.find(
      (value) => value.queryId === `${namespace}:query.${source}`,
    );
    if (!query) throw new Error(`Missing valuation dependency ${source}`);
    return JSON.parse(
      JSON.stringify(query)
        .replaceAll(`:query.${source}`, `:query.${name}`)
        .replaceAll(`:selection.${source}_`, `:selection.${name}_`)
        .replaceAll(`:parameter.${source}_`, `:parameter.${name}_`),
    ) as Record<string, unknown>;
  };
  const item = (type: 'list' | 'get') => {
    const name = `inventory_value_${type}`;
    const parameterId = `${namespace}:parameter.${name}_company`;
    return {
      ...clone(`item_${type}`, name),
      ...(type === 'list' ? { exportMaximumResultCount: 5000 } : {}),
      parameters: [
        {
          kind: 'queryParameterDefinition',
          schemaVersion: 'v6',
          parameterId,
          orderKey: 10,
        },
      ],
      legalEntityScope: {
        kind: 'queryLegalEntityScope',
        schemaVersion: 'v6',
        cardinality: 'exactlyOne',
        operand: {
          kind: 'queryParameterReference',
          schemaVersion: 'v6',
          parameterId,
        },
      },
      readModel: {
        capability: ref('capabilityReference', VALUATION_CAPABILITY_ID),
        binding: VALUATION_ITEM_BINDING,
        queries: Object.fromEntries(
          ['inventory_movement', 'goods_receipt', 'goods_receipt_line'].map(
            (local) => [
              local,
              ref('queryReference', `${namespace}:query.${local}_list`),
            ],
          ),
        ),
        resultFields: Object.fromEntries(
          VALUATION_ITEM_OUTPUTS.map((key) => [
            key,
            `${namespace}:metric.${key}`,
          ]),
        ),
      },
    };
  };
  return [item('list'), item('get')];
}

export function valuationSurfaces(
  namespace: string,
  surfaces: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const source = surfaces.find(
    (surface) => surface.surfaceId === `${namespace}:surface.item_list`,
  );
  if (!source) throw new Error('Valuation requires Catalog');
  const list = JSON.parse(
    JSON.stringify(source)
      .replaceAll(':surface.item_list', ':surface.inventory_value_list')
      .replaceAll(':slot.item_list_', ':slot.inventory_value_list_'),
  ) as Record<string, unknown>;
  return [
    {
      ...list,
      label: 'Inventory value',
      dataSource: ref(
        'queryReference',
        `${namespace}:query.inventory_value_list`,
      ),
    },
  ];
}

export function itemCostWorkspace(namespace: string): Record<string, unknown> {
  const field = (name: string) => `${namespace}:field.item_${name}`;
  return {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: `${namespace}:column.item_cost_name`,
        subtitle: [`${namespace}:column.item_cost_sku`],
        facts: ['base_unit', ...VALUATION_ITEM_OUTPUTS].map(
          (key) => `${namespace}:column.item_cost_${key}`,
        ),
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
    },
    fields: [
      ...['sku', 'name', 'description', 'base_unit'].map((key, index) => ({
        columnId: `${namespace}:column.item_cost_${key}`,
        label: {
          sku: 'SKU',
          name: 'Name',
          description: 'Description',
          base_unit: 'Base unit',
        }[key],
        field: field(key),
        orderKey: (index + 1) * 10,
      })),
      ...VALUATION_ITEM_OUTPUTS.map((key, index) => ({
        columnId: `${namespace}:column.item_cost_${key}`,
        label: {
          on_hand: 'On hand',
          average_cost: 'Average cost',
          inventory_value: 'Known value',
          unvalued_quantity: 'Unvalued quantity',
        }[key],
        field: `${namespace}:metric.${key}`,
        orderKey: (index + 5) * 10,
      })),
      ...['cad', 'usd', 'eur'].map((currency, index) => ({
        columnId: `${namespace}:column.item_cost_price_${currency}`,
        label: `Selling price (${currency.toUpperCase()})`,
        field: field(`price_${currency}`),
        format: 'money',
        orderKey: (index + 9) * 10,
      })),
    ],
    children: [],
    actions: [],
  };
}

/** Product metadata adds internal cost facts; the generic renderer and print selections stay shared. */
export function withShipmentValuation<
  T extends {
    queries: Record<string, unknown>[];
    surfaces: Record<string, unknown>[];
  },
>(namespace: string, application: T): T {
  const dependencies = Object.fromEntries(
    [
      'inventory_movement',
      'goods_receipt',
      'goods_receipt_line',
      'shipment',
      'shipment_line',
      'sales_order',
      'sales_order_line',
      'customer_invoice',
      'customer_invoice_line',
    ].map((local) => [
      local,
      ref(
        'queryReference',
        `${namespace}:query.${local === 'sales_order_line' ? 'commercial_lines' : `${local}_list`}`,
      ),
    ]),
  );
  const outputs = (margin: boolean) =>
    Object.fromEntries(
      [...VALUATION_COST_OUTPUTS, ...(margin ? ['product_margin'] : [])].map(
        (key) => [key, `${namespace}:metric.${key}`],
      ),
    );
  const models: Record<string, string> = {
    shipment_get: VALUATION_SHIPMENT_BINDING,
    customer_invoice_get: VALUATION_INVOICE_BINDING,
  };
  const source = application.queries.find(
    (q) => q.queryId === `${namespace}:query.shipment_line_list`,
  );
  if (!source) throw new Error('Shipment valuation requires shipment lines');
  const costLines = JSON.parse(
    JSON.stringify(source)
      .replaceAll(
        ':query.shipment_line_list',
        ':query.valuation_shipment_line_list',
      )
      .replaceAll(
        ':selection.shipment_line_list_',
        ':selection.valuation_shipment_line_list_',
      )
      .replaceAll(
        ':parameter.shipment_line_list_',
        ':parameter.valuation_shipment_line_list_',
      ),
  ) as Record<string, unknown>;
  costLines.readModel = {
    capability: ref('capabilityReference', VALUATION_CAPABILITY_ID),
    binding: VALUATION_SHIPMENT_LINE_BINDING,
    queries: dependencies,
    resultFields: outputs(false),
  };
  const costGets = Object.entries(models).map(([local, binding]) => {
    const source = application.queries.find(
      (query) => query.queryId === `${namespace}:query.${local}`,
    );
    if (!source || source.readModel)
      throw new Error(`Shipment valuation requires plain ${local}`);
    const name = `valuation_${local}`;
    const clone = JSON.parse(
      JSON.stringify(source)
        .replaceAll(`:query.${local}`, `:query.${name}`)
        .replaceAll(`:selection.${local}_`, `:selection.${name}_`),
    ) as Record<string, unknown>;
    // Row-query operands are local to their query. Keeping the company's
    // existing operand preserves document URLs while the stored get stays plain.
    return {
      ...clone,
      readModel: {
        capability: ref('capabilityReference', VALUATION_CAPABILITY_ID),
        binding,
        queries: dependencies,
        resultFields: outputs(local === 'customer_invoice_get'),
      },
    };
  });
  return {
    ...application,
    queries: [
      ...costGets,
      ...application.queries.map((query) => {
        const local = String(query.queryId).split(':query.')[1]!;
        if (local === 'commercial_order_get') {
          const model = query.readModel as Record<string, unknown>;
          return {
            ...query,
            readModel: {
              ...model,
              queries: {
                ...(model.queries as Record<string, unknown>),
                ...dependencies,
              },
              resultFields: {
                ...(model.resultFields as Record<string, unknown>),
                ...outputs(true),
              },
            },
          };
        }
        return query;
      }),
      costLines,
    ],
    surfaces: application.surfaces.map((sourceSurface) => {
      const surface = JSON.parse(
        JSON.stringify(sourceSurface)
          .replaceAll(':query.shipment_get', ':query.valuation_shipment_get')
          .replaceAll(
            ':query.customer_invoice_get',
            ':query.valuation_customer_invoice_get',
          ),
      ) as Record<string, unknown>;
      const local = String(surface.surfaceId).split(':surface.')[1]!;
      if (
        ![
          'shipment_detail',
          'sales_order_detail',
          'customer_invoice_detail',
        ].includes(local)
      )
        return surface;
      const composition = surface.composition as Record<string, unknown>;
      const fields = composition.fields as Record<string, unknown>[];
      const costs = [
        ...VALUATION_COST_OUTPUTS,
        ...(local !== 'shipment_detail' ? ['product_margin'] : []),
      ].map((key, index) => ({
        columnId: `${namespace}:column.${local}_${key}`,
        field: `${namespace}:metric.${key}`,
        label: {
          cost_of_goods: 'Known cost of goods',
          cost_unvalued_quantity: 'Unvalued shipped quantity',
          cost_coverage: 'Cost coverage',
          product_margin:
            local === 'sales_order_detail'
              ? 'Shipped product margin'
              : 'Product margin (before charges and tax)',
        }[key],
        orderKey: 200 + index * 10,
      }));
      const children = composition.children as Record<string, unknown>[];
      const packed = children[0];
      return {
        ...surface,
        composition: {
          ...composition,
          fields: [...fields, ...costs],
          // Internal costs are a separate dataset, so packing/customer print selections never acquire them.
          children:
            local === 'shipment_detail'
              ? [
                  ...children,
                  {
                    ...packed,
                    datasetId: `${namespace}:dataset.shipment_relief`,
                    label: 'Relieved inventory cost',
                    orderKey: 20,
                    query: ref(
                      'queryReference',
                      `${namespace}:query.valuation_shipment_line_list`,
                    ),
                    columns: [
                      ...(packed!.columns as Record<string, unknown>[])
                        .slice(0, 2)
                        .map((column, index) => ({
                          ...column,
                          columnId: `${namespace}:column.shipment_relief_${index}`,
                        })),
                      ...costs.slice(0, 3).map((column) => ({
                        ...column,
                        columnId: String(column.columnId).replace(
                          ':column.',
                          ':column.line_',
                        ),
                      })),
                    ],
                  },
                ]
              : children,
        },
      };
    }),
  };
}
