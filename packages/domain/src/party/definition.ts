const version = 'v6' as const;
const normalizationProfileVersion = 'northstar.normalization/v6' as const;

export const PARTY_NAMESPACE = 'northstar.party' as const;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

function ids(namespace: string) {
  return {
    contentCapabilityId: `${namespace}:capability.standard_surface_content`,
    entityIds: {
      address: `${namespace}:entity.party_address`,
      party: `${namespace}:entity.party`,
      role: `${namespace}:entity.party_role`,
    },
    fieldIds: {
      contactSummary: `${namespace}:field.party_contact_summary`,
      // Customer defaults a sales order takes when this party is chosen
      // (owner ruling E): currency, payment terms, salesperson, ship-to.
      defaultCurrency: `${namespace}:field.party_default_currency`,
      defaultSalespersonPartyId: `${namespace}:field.party_default_salesperson_party_id`,
      defaultShipToAddressId: `${namespace}:field.party_default_ship_to_address_id`,
      defaultTaxCodeId: `${namespace}:field.party_default_tax_code_id`,
      // Credit control (SALES-EXTRAS): a limit in the customer's currency and
      // a manual hold, read when one of its orders is confirmed.
      creditLimit: `${namespace}:field.party_credit_limit`,
      creditHold: `${namespace}:field.party_credit_hold`,
      name: `${namespace}:field.party_name`,
      number: `${namespace}:field.party_number`,
      paymentTerms: `${namespace}:field.party_payment_terms`,
      roleKind: `${namespace}:field.party_role_kind`,
      roleStatus: `${namespace}:field.party_role_status`,
    },
    addressFieldIds: Object.fromEntries(
      ADDRESS_FIELDS.map(([name]) => [
        name,
        `${namespace}:field.party_address_${name}`,
      ]),
    ) as Record<(typeof ADDRESS_FIELDS)[number][0], string>,
    moduleId: `${namespace}:module.party`,
    namespace,
    packageId: `${namespace}:package.party`,
    relationIds: {
      addressParty: `${namespace}:relation.party_address_party`,
      roleParty: `${namespace}:relation.party_role_party`,
    },
  } as const;
}

/** A ship-to address: its label in the book, then the lines it prints. */
const ADDRESS_FIELDS = [
  ['label', 'Address label', 80, true],
  ['recipient', 'Recipient', 240, false],
  ['street', 'Street address', 500, true],
  ['city', 'City', 120, true],
  ['region', 'Province or state', 120, false],
  ['postal_code', 'Postal code', 20, true],
  ['country', 'Country', 60, true],
] as const;

/** Payment terms (owner ruling B); an invoice is due this many days after its date. */
export const PAYMENT_TERMS = [
  ['due_on_receipt', 'Due on receipt'],
  ['net_15', 'Net 15'],
  ['net_30', 'Net 30'],
  ['net_45', 'Net 45'],
  ['net_60', 'Net 60'],
] as const;

type PartyIds = ReturnType<typeof ids>;

const {
  addressFieldIds,
  contentCapabilityId,
  entityIds,
  fieldIds,
  moduleId,
  relationIds,
} = ids(PARTY_NAMESPACE);

/**
 * The complete Party module is definition data. Compiler projections and the
 * generic platform press own storage, queries, operations, surfaces, agent
 * discovery, reporting, policy, verification, and runtime execution.
 */
export function partyModuleDefinition(
  namespace: string = PARTY_NAMESPACE,
  options: {
    /**
     * Sales master data (owner ruling E): the salesperson role, customer
     * order defaults and the ship-to address book. The product application
     * mounts Party with it; the standalone reference harness keeps the Party
     * it has always compiled.
     */
    readonly salesMasterData?: boolean;
  } = {},
): Record<string, unknown> {
  const definitionIds = ids(namespace);
  const sales = options.salesMasterData === true;
  const when = <T>(values: readonly T[]): readonly T[] => (sales ? values : []);
  const {
    addressFieldIds,
    contentCapabilityId,
    entityIds,
    fieldIds,
    moduleId,
    packageId,
    relationIds,
  } = definitionIds;
  const partyFields = [
    fieldIds.number,
    fieldIds.name,
    fieldIds.contactSummary,
    ...when([
      fieldIds.defaultCurrency,
      fieldIds.paymentTerms,
      fieldIds.defaultSalespersonPartyId,
      fieldIds.defaultShipToAddressId,
      fieldIds.defaultTaxCodeId,
      fieldIds.creditLimit,
      fieldIds.creditHold,
    ]),
  ];
  const roleFields = [fieldIds.roleKind, fieldIds.roleStatus];
  const addressFields = Object.values(addressFieldIds);
  return {
    assertions: [
      conformanceAssertion(
        definitionIds,
        'party',
        `${namespace}:query.party_get`,
      ),
      conformanceAssertion(
        definitionIds,
        'party_role',
        `${namespace}:query.party_role_get`,
      ),
      ...when([
        conformanceAssertion(
          definitionIds,
          'party_address',
          `${namespace}:query.party_address_get`,
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
      entity(definitionIds, 'party', 'Party', entityIds.party, 10),
      entity(definitionIds, 'party_role', 'Party role', entityIds.role, 20),
      ...when([
        entity(
          definitionIds,
          'party_address',
          'Ship-to address',
          entityIds.address,
          30,
        ),
      ]),
    ],
    fields: [
      textField({
        businessKey: 'tenantEnvironmentCaseInsensitiveUnique',
        entityId: entityIds.party,
        fieldId: fieldIds.number,
        label: 'Party number',
        maximumLength: 40,
        orderKey: 10,
        presence: 'required',
        searchable: true,
      }),
      textField({
        entityId: entityIds.party,
        fieldId: fieldIds.name,
        label: 'Party name',
        maximumLength: 240,
        orderKey: 20,
        presence: 'required',
        searchable: true,
      }),
      textField({
        classification: 'internal',
        entityId: entityIds.party,
        fieldId: fieldIds.contactSummary,
        label: 'Contact summary',
        maximumLength: 500,
        orderKey: 30,
        presence: 'optional',
        searchable: false,
      }),
      enumField(
        definitionIds,
        entityIds.role,
        fieldIds.roleKind,
        'Party role',
        10,
        [
          ['supplier', 'Supplier'],
          ['customer', 'Customer'],
          // Owner ruling E: a salesperson is a Party holding this role.
          ...when([['salesperson', 'Salesperson'] as const]),
        ],
        true,
      ),
      enumField(
        definitionIds,
        entityIds.role,
        fieldIds.roleStatus,
        'Role status',
        20,
        [
          ['active', 'Active'],
          ['inactive', 'Inactive'],
        ],
      ),
      ...when([
        // The currencies an order may be in (ruling B), offered as a choice;
        // an order copies the chosen code, which is the option's label.
        enumField(
          definitionIds,
          entityIds.party,
          fieldIds.defaultCurrency,
          'Default currency',
          110,
          [
            ['party_default_currency_cad', 'CAD'],
            ['party_default_currency_usd', 'USD'],
            ['party_default_currency_eur', 'EUR'],
          ],
          false,
          true,
        ),
        enumField(
          definitionIds,
          entityIds.party,
          fieldIds.paymentTerms,
          'Payment terms',
          120,
          PAYMENT_TERMS.map(([local, label]) => [
            `party_payment_terms_${local}`,
            label,
          ]),
          false,
          true,
        ),
        textField({
          entityId: entityIds.party,
          fieldId: fieldIds.defaultSalespersonPartyId,
          label: 'Default salesperson',
          maximumLength: 80,
          orderKey: 130,
          presence: 'optional',
          searchable: false,
        }),
        textField({
          entityId: entityIds.party,
          fieldId: fieldIds.defaultShipToAddressId,
          label: 'Default ship-to address',
          maximumLength: 80,
          orderKey: 140,
          presence: 'optional',
          searchable: false,
        }),
        // The tax code a customer's orders are taxed by (ruling B).
        textField({
          entityId: entityIds.party,
          fieldId: fieldIds.defaultTaxCodeId,
          label: 'Default tax code',
          maximumLength: 80,
          orderKey: 150,
          presence: 'optional',
          searchable: false,
        }),
        // Credit control (SALES-EXTRAS): the most a customer may owe on open
        // invoices and confirmed orders not yet invoiced, in its own currency;
        // empty or zero sets no limit. A customer on hold has no order
        // confirmed until the hold is released.
        {
          classification: 'internal',
          collation: 'binary',
          defaultSemantics: 'nullable',
          entity: reference('entityReference', entityIds.party),
          fieldId: fieldIds.creditLimit,
          fieldType: {
            kind: 'exactDecimalFieldType',
            precision: 38,
            representation: 'canonicalString',
            scale: 18,
            schemaVersion: version,
          },
          kind: 'fieldDefinition',
          label: 'Credit limit',
          orderKey: 160,
          presence: 'optional',
          reportable: true,
          schemaVersion: version,
          searchable: false,
        },
        {
          classification: 'internal',
          collation: 'binary',
          defaultSemantics: 'nullable',
          entity: reference('entityReference', entityIds.party),
          fieldId: fieldIds.creditHold,
          fieldType: { kind: 'booleanFieldType', schemaVersion: version },
          kind: 'fieldDefinition',
          label: 'On credit hold',
          orderKey: 170,
          presence: 'optional',
          reportable: true,
          schemaVersion: version,
          searchable: false,
        },
        ...ADDRESS_FIELDS.map(([name, label, maximumLength, required], index) =>
          textField({
            entityId: entityIds.address,
            fieldId: addressFieldIds[name],
            label,
            maximumLength,
            orderKey: (index + 1) * 10,
            presence: required ? 'required' : 'optional',
            searchable: name === 'label' || name === 'city',
          }),
        ),
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
        label: 'Party',
        moduleId,
        orderKey: 10,
        ownerPackageId: packageId,
        schemaVersion: version,
      },
    ],
    normalizationProfileVersion,
    operations: [
      ...entityOperations(definitionIds, 'party', entityIds.party),
      ...entityOperations(definitionIds, 'party_role', entityIds.role),
      ...when(
        entityOperations(definitionIds, 'party_address', entityIds.address),
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
      ...entityPermissions(definitionIds, 'party', entityIds.party),
      ...entityPermissions(definitionIds, 'party_role', entityIds.role),
      ...when(
        entityPermissions(definitionIds, 'party_address', entityIds.address),
      ),
    ],
    queries: [
      ...entityQueries(definitionIds, 'party', entityIds.party, partyFields, [
        {
          authority: 'identifier',
          fieldId: fieldIds.number,
          localId: 'number',
        },
        { authority: 'advisory', fieldId: fieldIds.name, localId: 'name' },
      ]),
      ...entityQueries(
        definitionIds,
        'party_role',
        entityIds.role,
        roleFields,
        [
          {
            authority: 'advisory',
            fieldId: fieldIds.roleKind,
            localId: 'role_kind',
          },
        ],
      ),
      ...when(
        entityQueries(
          definitionIds,
          'party_address',
          entityIds.address,
          addressFields,
          [
            {
              authority: 'advisory',
              fieldId: addressFieldIds.label,
              localId: 'label',
            },
          ],
        ),
      ),
    ],
    relations: [
      {
        archiveBehavior: 'restrict',
        cardinality: 'manyToOne',
        foreignKeyActions: {
          onDelete: 'restrict',
          onUpdate: 'restrict',
          schemaVersion: version,
        },
        joinEligibility: 'query',
        kind: 'relationDefinition',
        orderKey: 10,
        ownership: 'parentScopedChild',
        relationId: relationIds.roleParty,
        required: true,
        schemaVersion: version,
        sourceEntity: reference('entityReference', entityIds.role),
        targetEntity: reference('entityReference', entityIds.party),
      },
      ...when([
        {
          archiveBehavior: 'restrict',
          cardinality: 'manyToOne',
          foreignKeyActions: {
            onDelete: 'restrict',
            onUpdate: 'restrict',
            schemaVersion: version,
          },
          joinEligibility: 'query',
          kind: 'relationDefinition',
          orderKey: 20,
          ownership: 'parentScopedChild',
          relationId: relationIds.addressParty,
          required: true,
          schemaVersion: version,
          sourceEntity: reference('entityReference', entityIds.address),
          targetEntity: reference('entityReference', entityIds.party),
        },
      ]),
    ],
    schemaVersion: version,
    stateMachines: [],
    storageMappings: [
      storageMapping(definitionIds, 'party', entityIds.party),
      storageMapping(definitionIds, 'party_role', entityIds.role),
      ...when([
        storageMapping(definitionIds, 'party_address', entityIds.address),
      ]),
    ],
    surfaces: [
      ...entitySurfaces(definitionIds, 'party', 'Party'),
      ...entitySurfaces(definitionIds, 'party_role', 'Party role'),
      ...when(
        entitySurfaces(definitionIds, 'party_address', 'Ship-to address'),
      ),
    ],
  };
}

export const PARTY_IDS = Object.freeze({
  addressFieldIds,
  contentCapabilityId,
  entityIds,
  fieldIds,
  moduleId,
  namespace: PARTY_NAMESPACE,
  relationIds,
});

function entity(
  ids: PartyIds,
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

function enumField(
  ids: PartyIds,
  entityId: string,
  fieldId: string,
  label: string,
  orderKey: number,
  options: ReadonlyArray<readonly [string, string]>,
  searchable = false,
  optional = false,
): Record<string, unknown> {
  return {
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: optional ? 'nullable' : 'none',
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
    presence: optional ? 'optional' : 'required',
    reportable: true,
    schemaVersion: version,
    searchable,
  };
}

function entityQueries(
  ids: PartyIds,
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
  ids: PartyIds,
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
  ids: PartyIds,
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
  ids: PartyIds,
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
      // The first authored disclosure tier, and a fact rather than a
      // gate-satisfying gesture. `party_detail`'s keyFacts panel carries
      // `party_number` and `party_name` -- an identifying business key and a
      // required field -- so `ux-grammar`'s hard rule FORCES `always` here and
      // would refuse any other value. Declaring it states what the compiler
      // already enforces.
      //
      // Deliberately one slot. The sibling surfaces omit the tier and are
      // interpreted as `always` identically; declaring it on all of them would
      // add instances without adding evidence.
      //
      // Authored first by `U5b` and REVERTED there, on ADR-0047 §4a: under the
      // then-adopted v1 profile the tier reached zero artifacts, so the entry it
      // minted was a source change carrying no semantic delta -- exactly the
      // shape §4a tells a packet not to mint. It lands here instead, in the
      // packet that adopts v2, where the same one line finally reaches
      // `surfaceManifestPayload` and the affected assertions are corrected once
      // against a delta that means something.
      ...(local === 'party' && suffix === 'detail' && slot === 'keyFacts'
        ? { disclosureTier: 'always' as const }
        : {}),
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
  ids: PartyIds,
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
  ids: PartyIds,
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
