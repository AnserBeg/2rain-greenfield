const version = 'v6' as const;
const normalizationProfileVersion = 'northstar.normalization/v6' as const;

export const CATALOG_NAMESPACE = 'northstar.catalog' as const;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

function ids(namespace: string) {
  return {
    contentCapabilityId: `${namespace}:capability.standard_surface_content`,
    entityIds: {
      item: `${namespace}:entity.item`,
      taxCode: `${namespace}:entity.tax_code`,
    },
    fieldIds: {
      baseUnit: `${namespace}:field.item_base_unit`,
      description: `${namespace}:field.item_description`,
      name: `${namespace}:field.item_name`,
      // Selling prices in each order currency (owner ruling B).
      priceCad: `${namespace}:field.item_price_cad`,
      priceEur: `${namespace}:field.item_price_eur`,
      priceUsd: `${namespace}:field.item_price_usd`,
      sku: `${namespace}:field.item_sku`,
      taxCode: `${namespace}:field.tax_code_code`,
      taxName: `${namespace}:field.tax_code_name`,
      taxRatePercent: `${namespace}:field.tax_code_rate_percent`,
    },
    moduleId: `${namespace}:module.catalog`,
    namespace,
    packageId: `${namespace}:package.catalog`,
  } as const;
}

type CatalogIds = ReturnType<typeof ids>;

const { contentCapabilityId, entityIds, fieldIds, moduleId } =
  ids(CATALOG_NAMESPACE);

/**
 * The complete Catalog module is definition data. Compiler projections and the
 * generic platform press own storage, queries, operations, surfaces, agent
 * discovery, reporting, policy, verification, and runtime execution.
 */
export function catalogModuleDefinition(
  namespace: string = CATALOG_NAMESPACE,
  options: {
    /**
     * Selling prices per order currency and the fixed-rate tax codes lines
     * are sold under (owner ruling B). The product application mounts
     * Catalog with them; the standalone reference harness keeps the Catalog
     * it has always compiled.
     */
    readonly sellingPrices?: boolean;
    readonly units?: boolean;
  } = {},
): Record<string, unknown> {
  const definitionIds = ids(namespace);
  const { contentCapabilityId, entityIds, fieldIds, moduleId, packageId } =
    definitionIds;
  const prices = options.sellingPrices === true;
  const priceFields = [
    [fieldIds.priceCad, 'Price (CAD)', 50],
    [fieldIds.priceUsd, 'Price (USD)', 60],
    [fieldIds.priceEur, 'Price (EUR)', 70],
  ] as const;
  const itemFields = [
    fieldIds.sku,
    fieldIds.name,
    fieldIds.description,
    fieldIds.baseUnit,
    ...(prices ? priceFields.map(([fieldId]) => fieldId) : []),
  ];
  const when = <T>(values: readonly T[]): readonly T[] =>
    prices ? values : [];
  const taxCodeFields = [
    fieldIds.taxCode,
    fieldIds.taxName,
    fieldIds.taxRatePercent,
  ];
  const definition = {
    assertions: [
      conformanceAssertion(
        definitionIds,
        'item',
        `${namespace}:query.item_get`,
      ),
      ...when([
        conformanceAssertion(
          definitionIds,
          'tax_code',
          `${namespace}:query.tax_code_get`,
        ),
      ]),
    ],
    capabilityRequirements: [
      {
        capabilityId: contentCapabilityId,
        capabilityVersion: 1,
        declaredEffects: ['read'],
        kind: 'capabilityRequirement',
        requiredProjections: [
          'storage',
          'policy',
          'query',
          'operation',
          'surface',
          'agent',
          'reporting',
          'verification',
        ],
        schemaVersion: version,
        supportStatus: 'supported',
      },
    ],
    entities: [
      entity(definitionIds, 'item', 'Item', entityIds.item, 10),
      ...when([
        entity(definitionIds, 'tax_code', 'Tax code', entityIds.taxCode, 20),
      ]),
    ],
    fields: [
      textField({
        businessKey: 'tenantEnvironmentCaseInsensitiveUnique',
        entityId: entityIds.item,
        fieldId: fieldIds.sku,
        label: 'SKU',
        maximumLength: 40,
        orderKey: 10,
        presence: 'required',
        searchable: true,
      }),
      textField({
        entityId: entityIds.item,
        fieldId: fieldIds.name,
        label: 'Item name',
        maximumLength: 240,
        orderKey: 20,
        presence: 'required',
        searchable: true,
      }),
      textField({
        classification: 'internal',
        entityId: entityIds.item,
        fieldId: fieldIds.description,
        label: 'Description',
        maximumLength: 500,
        orderKey: 30,
        presence: 'optional',
        searchable: true,
      }),
      textField({
        entityId: entityIds.item,
        fieldId: fieldIds.baseUnit,
        label: 'Base unit',
        maximumLength: 32,
        orderKey: 40,
        presence: 'required',
        searchable: false,
      }),
      ...(prices
        ? priceFields.map(([fieldId, label, orderKey]) =>
            decimalField(entityIds.item, fieldId, label, orderKey),
          )
        : []),
      // A tax code's rate; a line or charge freezes it when choosing the code.
      ...when([
        textField({
          businessKey: 'tenantEnvironmentCaseInsensitiveUnique',
          entityId: entityIds.taxCode,
          fieldId: fieldIds.taxCode,
          label: 'Tax code',
          maximumLength: 20,
          orderKey: 10,
          presence: 'required',
          searchable: true,
        }),
        textField({
          entityId: entityIds.taxCode,
          fieldId: fieldIds.taxName,
          label: 'Name',
          maximumLength: 120,
          orderKey: 20,
          presence: 'required',
          searchable: true,
        }),
        {
          ...decimalField(
            entityIds.taxCode,
            fieldIds.taxRatePercent,
            'Rate %',
            30,
          ),
          defaultSemantics: 'none',
          presence: 'required',
        },
      ]),
    ],
    hashAlgorithm: 'sha256',
    impactAnalyses: [],
    kind: 'applicationPackageRevision',
    languageVersion: version,
    modules: [
      {
        composition: {
          kind: 'compositionSeam',
          schemaVersion: version,
          status: 'unsupported',
        },
        kind: 'moduleDefinition',
        label: 'Catalog',
        moduleId,
        orderKey: 10,
        ownerPackageId: packageId,
        schemaVersion: version,
      },
    ],
    normalizationProfileVersion,
    operations: [
      ...entityOperations(definitionIds, 'item', entityIds.item),
      ...when(entityOperations(definitionIds, 'tax_code', entityIds.taxCode)),
    ],
    package: {
      kind: 'packageDefinition',
      namespace,
      packageId,
      provenance: 'firstParty',
      schemaVersion: version,
      version: '1.0.0',
    },
    permissions: [
      ...entityPermissions(definitionIds, 'item', entityIds.item),
      ...when(entityPermissions(definitionIds, 'tax_code', entityIds.taxCode)),
    ],
    queries: [
      ...entityQueries(definitionIds, 'item', entityIds.item, itemFields, [
        {
          authority: 'identifier',
          fieldId: fieldIds.sku,
          localId: 'sku',
        },
        { authority: 'advisory', fieldId: fieldIds.name, localId: 'name' },
      ]),
      ...when(
        entityQueries(
          definitionIds,
          'tax_code',
          entityIds.taxCode,
          taxCodeFields,
          [
            {
              authority: 'identifier',
              fieldId: fieldIds.taxCode,
              localId: 'code',
            },
          ],
        ),
      ),
    ],
    relations: [],
    schemaVersion: version,
    stateMachines: [],
    storageMappings: [
      storageMapping(definitionIds, 'item', entityIds.item),
      ...when([storageMapping(definitionIds, 'tax_code', entityIds.taxCode)]),
    ],
    surfaces: [
      ...entitySurfaces(definitionIds, 'item', 'Item'),
      ...when(entitySurfaces(definitionIds, 'tax_code', 'Tax code')),
    ],
  };
  return options.units
    ? withUnitMasters(definition, definitionIds)
    : definition;
}

export const CATALOG_IDS = Object.freeze({
  contentCapabilityId,
  entityIds,
  fieldIds,
  moduleId,
  namespace: CATALOG_NAMESPACE,
});

function entity(
  ids: CatalogIds,
  local: string,
  label: string,
  entityId: string,
  orderKey: number,
): Record<string, unknown> {
  return {
    entityId,
    kind: 'entityDefinition',
    label,
    module: reference('moduleReference', ids.moduleId),
    orderKey,
    schemaVersion: version,
    storage: reference(
      'storageMappingReference',
      `${ids.namespace}:storage.${local}`,
    ),
  };
}

/** An optional exact decimal, such as a price. */
function decimalField(
  entityId: string,
  fieldId: string,
  label: string,
  orderKey: number,
): Record<string, unknown> {
  return {
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'nullable',
    entity: reference('entityReference', entityId),
    fieldId,
    fieldType: {
      kind: 'exactDecimalFieldType',
      precision: 38,
      representation: 'canonicalString',
      scale: 18,
      schemaVersion: version,
    },
    kind: 'fieldDefinition',
    label,
    orderKey,
    presence: 'optional',
    reportable: true,
    schemaVersion: version,
    searchable: false,
  };
}

function textField(input: {
  businessKey?: 'tenantEnvironmentCaseInsensitiveUnique';
  classification?: 'internal';
  entityId: string;
  fieldId: string;
  label: string;
  maximumLength: number;
  orderKey: number;
  presence: 'optional' | 'required';
  searchable: boolean;
}): Record<string, unknown> {
  return {
    ...(input.businessKey ? { businessKey: input.businessKey } : {}),
    classification: input.classification ?? 'internal',
    collation: 'unicodeCaseInsensitive',
    defaultSemantics: input.presence === 'optional' ? 'nullable' : 'none',
    entity: reference('entityReference', input.entityId),
    fieldId: input.fieldId,
    fieldType: {
      kind: 'textFieldType',
      maximumLength: input.maximumLength,
      schemaVersion: version,
    },
    kind: 'fieldDefinition',
    label: input.label,
    orderKey: input.orderKey,
    presence: input.presence,
    reportable: true,
    schemaVersion: version,
    searchable: input.searchable,
  };
}

function entityQueries(
  ids: CatalogIds,
  local: string,
  entityId: string,
  selectedFieldIds: readonly string[],
  resolveKeys: readonly {
    authority: 'advisory' | 'identifier';
    fieldId: string;
    localId: string;
  }[],
): Array<Record<string, unknown>> {
  return ['get', 'list', 'search', 'resolve'].map((queryType) => ({
    kind: 'queryDefinition',
    maximumResultCount: queryType === 'get' ? 1 : 100,
    module: reference('moduleReference', ids.moduleId),
    permission: reference(
      'permissionReference',
      `${ids.namespace}:permission.${local}_read`,
    ),
    queryId: `${ids.namespace}:query.${local}_${queryType}`,
    queryType,
    ...(queryType === 'resolve'
      ? {
          resolveMatchKeys: resolveKeys.map((key, index) => ({
            authority: key.authority,
            field: reference('fieldReference', key.fieldId),
            kind: 'resolveMatchKey',
            matchKeyId: `${ids.namespace}:resolve-key.${local}_${key.localId}`,
            orderKey: (index + 1) * 10,
            schemaVersion: version,
          })),
        }
      : {}),
    schemaVersion: version,
    selections: selectedFieldIds.map((fieldId, index) => ({
      field: reference('fieldReference', fieldId),
      kind: 'querySelection',
      orderKey: (index + 1) * 10,
      schemaVersion: version,
      selectionId: `${ids.namespace}:selection.${local}_${queryType}_${String(index + 1)}`,
    })),
    sourceEntity: reference('entityReference', entityId),
    tier: 'q0',
  }));
}

function entityOperations(
  ids: CatalogIds,
  local: string,
  entityId: string,
): Array<Record<string, unknown>> {
  const effects = [
    ['create', 'createRecordEffect'],
    ['update', 'updateRecordEffect'],
    ['archive', 'archiveRecordEffect'],
    ['restore', 'restoreRecordEffect'],
  ] as const;
  return effects.map(([action, kind]) => ({
    confirmation: action === 'archive' ? 'humanRequired' : 'none',
    effect: {
      entity: reference('entityReference', entityId),
      kind,
      schemaVersion: version,
    },
    kind: 'operationDefinition',
    module: reference('moduleReference', ids.moduleId),
    operationId: `${ids.namespace}:operation.${local}_${action}`,
    permission: reference(
      'permissionReference',
      `${ids.namespace}:permission.${local}_${action}`,
    ),
    readBack: reference(
      'queryReference',
      `${ids.namespace}:query.${local}_get`,
    ),
    schemaVersion: version,
    tier: 'o0',
  }));
}

function entityPermissions(
  ids: CatalogIds,
  local: string,
  entityId: string,
): Array<Record<string, unknown>> {
  return ['create', 'read', 'update', 'archive', 'restore'].map((action) => ({
    action,
    kind: 'permissionDefinition',
    label: `${local} ${action}`,
    permissionId: `${ids.namespace}:permission.${local}_${action}`,
    resource: reference('entityReference', entityId),
    schemaVersion: version,
  }));
}

function entitySurfaces(
  ids: CatalogIds,
  local: string,
  label: string,
): Array<Record<string, unknown>> {
  return [
    ['list', 'list', ['title', 'dataGrid', 'bulkActions'], 'list'],
    [
      'detail',
      'record',
      ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts', 'sections'],
      'record',
    ],
    [
      'form',
      'record',
      ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts', 'sections'],
      'form',
    ],
  ].map(([suffix, archetype, slots, surfaceRole]) => ({
    archetype,
    dataSource: reference(
      'queryReference',
      `${ids.namespace}:query.${local}_${surfaceRole === 'list' ? 'list' : 'get'}`,
    ),
    kind: 'surfaceDefinition',
    label: `${label} ${suffix}`,
    module: reference('moduleReference', ids.moduleId),
    schemaVersion: version,
    slots: (slots as string[]).map((slot, index) => ({
      content: reference(
        'opaqueSurfaceContentReference',
        ids.contentCapabilityId,
      ),
      kind: 'surfaceSlot',
      orderKey: (index + 1) * 10,
      schemaVersion: version,
      slot,
      slotId: `${ids.namespace}:slot.${local}_${suffix}_${slot.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}`,
    })),
    statusRoles: [],
    surfaceId: `${ids.namespace}:surface.${local}_${suffix}`,
    surfaceRole,
  }));
}

function storageMapping(
  ids: CatalogIds,
  local: string,
  entityId: string,
): Record<string, unknown> {
  return {
    entity: reference('entityReference', entityId),
    kind: 'storageMappingDefinition',
    schemaVersion: version,
    storageClass: 'dedicatedTable',
    storageMappingId: `${ids.namespace}:storage.${local}`,
  };
}

function conformanceAssertion(
  ids: CatalogIds,
  local: string,
  queryId: string,
): Record<string, unknown> {
  return {
    assertionId: `${ids.namespace}:assertion.${local}_walking_slice`,
    evidenceKinds: [
      'structure',
      'provider',
      'userInterface',
      'agent',
      'migration',
      'recovery',
    ],
    expectedDiagnosticCode: null,
    expectedOutcome: 'succeeds',
    invocation: {
      kind: 'queryInvocation',
      query: reference('queryReference', queryId),
      schemaVersion: version,
    },
    kind: 'assertionDefinition',
    schemaVersion: version,
  };
}

/** Code-keyed masters; document conversion waits for UNITS-VERIFICATION. */
function withUnitMasters(
  definition: Record<string, unknown>,
  ids: CatalogIds,
): Record<string, unknown> {
  const namespace = ids.namespace;
  const ref = (kind: string, local: string) =>
    reference(kind, `${namespace}:${local}`);
  const master = (
    local: string,
    label: string,
    fields: Record<string, unknown>[],
    orderKey: number,
  ) => {
    const entityId = `${namespace}:entity.${local}`;
    return {
      assertions: [
        conformanceAssertion(ids, local, `${namespace}:query.${local}_get`),
      ],
      entities: [entity(ids, local, label, entityId, orderKey)],
      fields,
      operations: entityOperations(ids, local, entityId),
      permissions: entityPermissions(ids, local, entityId),
      queries: entityQueries(
        ids,
        local,
        entityId,
        fields.map((field) => String(field.fieldId)),
        [
          {
            authority: 'identifier',
            fieldId: String(fields[0]!.fieldId),
            localId: 'code',
          },
        ],
      ),
      storageMappings: [storageMapping(ids, local, entityId)],
      surfaces: entitySurfaces(ids, local, label),
    };
  };
  const text = (
    local: string,
    name: string,
    label: string,
    orderKey: number,
    unique = false,
  ) =>
    textField({
      entityId: `${namespace}:entity.${local}`,
      fieldId: `${namespace}:field.${local}_${name}`,
      label,
      orderKey,
      maximumLength: name === 'name' ? 120 : 32,
      presence: 'required',
      searchable: true,
      ...(unique
        ? { businessKey: 'tenantEnvironmentCaseInsensitiveUnique' as const }
        : {}),
    });
  const factor = (name: string, label: string, orderKey: number) => ({
    ...decimalField(
      `${namespace}:entity.unit_conversion`,
      `${namespace}:field.unit_conversion_${name}`,
      label,
      orderKey,
    ),
    presence: 'required',
    defaultSemantics: 'none',
    fieldType: {
      kind: 'exactDecimalFieldType',
      precision: 38,
      scale: 0,
      representation: 'canonicalString',
      schemaVersion: version,
    },
  });
  const units = master(
    'unit',
    'Unit',
    [
      text('unit', 'code', 'Code', 10, true),
      text('unit', 'name', 'Name', 20),
      {
        ...text('unit', 'decimals', 'Decimals', 30),
        searchable: false,
        fieldType: {
          kind: 'enumFieldType',
          schemaVersion: version,
          options: Array.from({ length: 19 }, (_, decimals) => ({
            kind: 'enumOption',
            schemaVersion: version,
            optionId: `${namespace}:option.unit_decimals_${decimals}`,
            label: String(decimals),
            orderKey: decimals + 1,
          })),
        },
      },
    ],
    30,
  );
  const conversions = master(
    'unit_conversion',
    'Unit conversion',
    [
      text('unit_conversion', 'code', 'Conversion code', 10, true),
      text('unit_conversion', 'from_unit', 'From unit code', 20),
      text('unit_conversion', 'to_unit', 'Base unit code', 30),
      factor('numerator', 'Numerator', 40),
      factor('denominator', 'Denominator', 50),
    ],
    40,
  );
  // Company-owned conversion rules reuse the existing legal-entity scope.
  conversions.queries = conversions.queries.map((query) => {
    const parameterId = `${String(query.queryId).replace(':query.', ':parameter.')}_legal_entity_scope`;
    return {
      ...query,
      legalEntityScope: {
        kind: 'queryLegalEntityScope',
        schemaVersion: version,
        cardinality: 'exactlyOne',
        operand: {
          kind: 'queryParameterReference',
          schemaVersion: version,
          parameterId,
        },
      },
      parameters: [
        {
          kind: 'queryParameterDefinition',
          schemaVersion: version,
          parameterId,
          orderKey: 10,
        },
      ],
    };
  });
  const relations = [
    {
      kind: 'relationDefinition',
      schemaVersion: version,
      relationId: `${namespace}:relation.unit_conversion_item`,
      sourceEntity: ref('entityReference', 'entity.unit_conversion'),
      targetEntity: ref('entityReference', 'entity.item'),
      cardinality: 'manyToOne',
      ownership: 'reference',
      required: false,
      joinEligibility: 'query',
      archiveBehavior: 'restrict',
      orderKey: 10,
    },
  ];
  const result = { ...definition };
  for (const key of Object.keys(units) as (keyof typeof units)[]) {
    result[key] = [
      ...(definition[key] as unknown[]),
      ...units[key],
      ...conversions[key],
    ];
  }
  result.relations = [...(definition.relations as unknown[]), ...relations];
  return result;
}
