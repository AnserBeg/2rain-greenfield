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
      // Price lists (SALES-EXTRAS): a list's prices per item and quantity
      // break, and the customers it is assigned to.
      priceList: `${namespace}:entity.price_list`,
      priceListEntry: `${namespace}:entity.price_list_entry`,
      priceListAssignment: `${namespace}:entity.price_list_assignment`,
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
      priceListCode: `${namespace}:field.price_list_code`,
      priceListName: `${namespace}:field.price_list_name`,
      priceListCurrency: `${namespace}:field.price_list_currency`,
      priceListPriority: `${namespace}:field.price_list_priority`,
      priceListStatus: `${namespace}:field.price_list_status`,
      entryItemId: `${namespace}:field.price_list_entry_item_id`,
      entryMinimumQuantity: `${namespace}:field.price_list_entry_minimum_quantity`,
      entryUnitPrice: `${namespace}:field.price_list_entry_unit_price`,
      assignmentPartyId: `${namespace}:field.price_list_assignment_party_id`,
    },
    relationIds: {
      entryPriceList: `${namespace}:relation.price_list_entry_price_list`,
      assignmentPriceList: `${namespace}:relation.price_list_assignment_price_list`,
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
  const priceListFields = [
    fieldIds.priceListCode,
    fieldIds.priceListName,
    fieldIds.priceListCurrency,
    fieldIds.priceListPriority,
    fieldIds.priceListStatus,
  ];
  const entryFields = [
    fieldIds.entryItemId,
    fieldIds.entryMinimumQuantity,
    fieldIds.entryUnitPrice,
  ];
  const assignmentFields = [fieldIds.assignmentPartyId];
  // Price lists (SALES-EXTRAS), each with its prices and its customers.
  const priceListEntities = [
    ['price_list', 'Price list', entityIds.priceList, 30],
    ['price_list_entry', 'Price list price', entityIds.priceListEntry, 40],
    [
      'price_list_assignment',
      'Price list customer',
      entityIds.priceListAssignment,
      50,
    ],
  ] as const;
  return {
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
        ...priceListEntities.map(([local]) =>
          conformanceAssertion(
            definitionIds,
            local,
            `${namespace}:query.${local}_get`,
          ),
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
        ...priceListEntities.map(([local, label, entityId, orderKey]) =>
          entity(definitionIds, local, label, entityId, orderKey),
        ),
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
        // A price list (SALES-EXTRAS): its code and name, the one currency
        // its prices are in, its rank among a customer's lists (highest
        // first) and whether it prices anything at all.
        textField({
          businessKey: 'tenantEnvironmentCaseInsensitiveUnique',
          entityId: entityIds.priceList,
          fieldId: fieldIds.priceListCode,
          label: 'Price list code',
          maximumLength: 20,
          orderKey: 10,
          presence: 'required',
          searchable: true,
        }),
        textField({
          entityId: entityIds.priceList,
          fieldId: fieldIds.priceListName,
          label: 'Name',
          maximumLength: 120,
          orderKey: 20,
          presence: 'required',
          searchable: true,
        }),
        enumField(
          definitionIds,
          entityIds.priceList,
          fieldIds.priceListCurrency,
          'Currency',
          30,
          [
            ['price_list_currency_cad', 'CAD'],
            ['price_list_currency_usd', 'USD'],
            ['price_list_currency_eur', 'EUR'],
          ],
        ),
        {
          ...decimalField(
            entityIds.priceList,
            fieldIds.priceListPriority,
            'Priority',
            40,
          ),
          defaultSemantics: 'none',
          fieldType: {
            kind: 'integerFieldType',
            representation: 'canonicalString',
            schemaVersion: version,
          },
          presence: 'required',
        },
        enumField(
          definitionIds,
          entityIds.priceList,
          fieldIds.priceListStatus,
          'Status',
          50,
          [
            ['price_list_status_active', 'Active'],
            ['price_list_status_inactive', 'Inactive'],
          ],
        ),
        // One price of an item, from a minimum quantity up (a quantity
        // break); the item is the record a sales line chooses.
        textField({
          entityId: entityIds.priceListEntry,
          fieldId: fieldIds.entryItemId,
          label: 'Item',
          maximumLength: 80,
          orderKey: 10,
          presence: 'required',
          searchable: true,
        }),
        {
          ...decimalField(
            entityIds.priceListEntry,
            fieldIds.entryMinimumQuantity,
            'Minimum quantity',
            20,
          ),
          defaultSemantics: 'none',
          presence: 'required',
        },
        {
          ...decimalField(
            entityIds.priceListEntry,
            fieldIds.entryUnitPrice,
            'Unit price',
            30,
          ),
          defaultSemantics: 'none',
          presence: 'required',
        },
        // A customer the list prices for.
        textField({
          entityId: entityIds.priceListAssignment,
          fieldId: fieldIds.assignmentPartyId,
          label: 'Customer',
          maximumLength: 80,
          orderKey: 10,
          presence: 'required',
          searchable: true,
        }),
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
      ...when(
        priceListEntities.flatMap(([local, , entityId]) =>
          entityOperations(definitionIds, local, entityId),
        ),
      ),
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
      ...when(
        priceListEntities.flatMap(([local, , entityId]) =>
          entityPermissions(definitionIds, local, entityId),
        ),
      ),
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
      ...when([
        ...entityQueries(
          definitionIds,
          'price_list',
          entityIds.priceList,
          priceListFields,
          [
            {
              authority: 'identifier',
              fieldId: fieldIds.priceListCode,
              localId: 'code',
            },
            {
              authority: 'advisory',
              fieldId: fieldIds.priceListName,
              localId: 'name',
            },
          ],
        ),
        ...entityQueries(
          definitionIds,
          'price_list_entry',
          entityIds.priceListEntry,
          entryFields,
          [
            {
              authority: 'advisory',
              fieldId: fieldIds.entryItemId,
              localId: 'item',
            },
          ],
        ),
        ...entityQueries(
          definitionIds,
          'price_list_assignment',
          entityIds.priceListAssignment,
          assignmentFields,
          [
            {
              authority: 'advisory',
              fieldId: fieldIds.assignmentPartyId,
              localId: 'party',
            },
          ],
        ),
      ]),
    ],
    relations: when([
      ownedRelation(
        definitionIds.relationIds.entryPriceList,
        entityIds.priceListEntry,
        entityIds.priceList,
        10,
      ),
      ownedRelation(
        definitionIds.relationIds.assignmentPriceList,
        entityIds.priceListAssignment,
        entityIds.priceList,
        20,
      ),
    ]),
    schemaVersion: version,
    stateMachines: [],
    storageMappings: [
      storageMapping(definitionIds, 'item', entityIds.item),
      ...when([storageMapping(definitionIds, 'tax_code', entityIds.taxCode)]),
      ...when(
        priceListEntities.map(([local, , entityId]) =>
          storageMapping(definitionIds, local, entityId),
        ),
      ),
    ],
    surfaces: [
      ...entitySurfaces(definitionIds, 'item', 'Item'),
      ...when(entitySurfaces(definitionIds, 'tax_code', 'Tax code')),
      ...when(
        priceListEntities.flatMap(([local, label]) =>
          entitySurfaces(definitionIds, local, label),
        ),
      ),
    ],
  };
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

/** A required enumeration, such as a price list's currency or status. */
function enumField(
  ids: CatalogIds,
  entityId: string,
  fieldId: string,
  label: string,
  orderKey: number,
  options: ReadonlyArray<readonly [string, string]>,
): Record<string, unknown> {
  return {
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'none',
    entity: reference('entityReference', entityId),
    fieldId,
    fieldType: {
      kind: 'enumFieldType',
      options: options.map(([local, optionLabel], index) => ({
        kind: 'enumOption',
        label: optionLabel,
        optionId: `${ids.namespace}:option.${local}`,
        orderKey: (index + 1) * 10,
        schemaVersion: version,
      })),
      schemaVersion: version,
    },
    kind: 'fieldDefinition',
    label,
    orderKey,
    presence: 'required',
    reportable: true,
    schemaVersion: version,
    searchable: false,
  };
}

/** A child owned by its parent record, such as a price list's prices. */
function ownedRelation(
  relationId: string,
  sourceEntityId: string,
  targetEntityId: string,
  orderKey: number,
): Record<string, unknown> {
  return {
    archiveBehavior: 'restrict',
    cardinality: 'manyToOne',
    foreignKeyActions: {
      onDelete: 'restrict',
      onUpdate: 'restrict',
      schemaVersion: version,
    },
    joinEligibility: 'query',
    kind: 'relationDefinition',
    orderKey,
    ownership: 'parentScopedChild',
    relationId,
    required: true,
    schemaVersion: version,
    sourceEntity: reference('entityReference', sourceEntityId),
    targetEntity: reference('entityReference', targetEntityId),
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
