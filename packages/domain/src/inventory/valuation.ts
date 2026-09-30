/** ADR-0067: operational valuation is compiled content over plain queries. */
export const VALUATION_CAPABILITY_ID =
  'northstar.inventory:capability.valuation';
export const VALUATION_ITEM_BINDING =
  'northstar.inventory:read_model.item_cost';
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
