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
      party: `${namespace}:entity.party`,
      role: `${namespace}:entity.party_role`,
    },
    fieldIds: {
      contactSummary: `${namespace}:field.party_contact_summary`,
      name: `${namespace}:field.party_name`,
      number: `${namespace}:field.party_number`,
      roleKind: `${namespace}:field.party_role_kind`,
      roleStatus: `${namespace}:field.party_role_status`,
    },
    moduleId: `${namespace}:module.party`,
    namespace,
    packageId: `${namespace}:package.party`,
    relationIds: {
      roleParty: `${namespace}:relation.party_role_party`,
    },
  } as const;
}

type PartyIds = ReturnType<typeof ids>;

const { contentCapabilityId, entityIds, fieldIds, moduleId, relationIds } =
  ids(PARTY_NAMESPACE);

/**
 * The complete Party module is definition data. Compiler projections and the
 * generic platform press own storage, queries, operations, surfaces, agent
 * discovery, reporting, policy, verification, and runtime execution.
 */
export function partyModuleDefinition(
  namespace: string = PARTY_NAMESPACE,
): Record<string, unknown> {
  const definitionIds = ids(namespace);
  const {
    contentCapabilityId,
    entityIds,
    fieldIds,
    moduleId,
    packageId,
    relationIds,
  } = definitionIds;
  const partyFields = [fieldIds.number, fieldIds.name, fieldIds.contactSummary];
  const roleFields = [fieldIds.roleKind, fieldIds.roleStatus];
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
    ],
    schemaVersion: version,
    stateMachines: [],
    storageMappings: [
      storageMapping(definitionIds, 'party', entityIds.party),
      storageMapping(definitionIds, 'party_role', entityIds.role),
    ],
    surfaces: [
      ...entitySurfaces(definitionIds, 'party', 'Party'),
      ...entitySurfaces(definitionIds, 'party_role', 'Party role'),
    ],
  };
}

export const PARTY_IDS = Object.freeze({
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
