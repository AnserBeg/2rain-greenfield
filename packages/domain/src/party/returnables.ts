/**
 * Returnable assets (RETURNABLE-ASSETS): pallets, kegs, crates and the like
 * that go out with a customer or come in from a supplier against a refundable
 * deposit. A returnable type states its unit deposit per currency; a custody
 * record (RTN-) follows one party, one type, one direction and one currency;
 * its events -- Issue, Return, Forfeit, Refund deposit -- are written as drafts
 * and posted once through the returnables capability, which bounds them and
 * restates the custody figures. Off the stock ledger: nothing here moves
 * inventory. The deposits are receivables facts in the custody's currency:
 * no ledger, no provider, no other currency.
 */
const version = 'v6' as const;

export const RETURNABLES_CAPABILITY_ID =
  'northstar.party:capability.returnables' as const;
export const RETURNABLES_CAPABILITY_VERSION = 1 as const;

type FieldType = Record<string, unknown>;
type Choices = ReadonlyArray<readonly [string, string]>;

/** The currencies a deposit is stated and taken in (ruling B's three). */
export const RETURNABLE_CURRENCIES = [
  ['cad', 'CAD'],
  ['usd', 'USD'],
  ['eur', 'EUR'],
] as const;

/** How a deposit was paid or refunded, entered by hand: no provider. */
export const RETURNABLE_METHODS = [
  ['cash', 'Cash'],
  ['cheque', 'Cheque'],
  ['bank_transfer', 'Bank transfer'],
] as const;

export const RETURNABLE_DIRECTIONS = [
  // Our assets a customer holds.
  ['out', 'Out with customer'],
  // A supplier's assets we hold.
  ['held', 'Held from supplier'],
] as const;

export const RETURNABLE_CUSTODY_STATES = [
  ['new', 'New'],
  ['open', 'Open'],
  ['awaiting_refund', 'Awaiting refund'],
  ['closed', 'Closed'],
] as const;

export const RETURNABLE_EVENT_KINDS = [
  ['issue', 'Issue'],
  ['return', 'Return'],
  ['forfeit', 'Forfeit'],
  ['refund', 'Deposit refund'],
] as const;

type Spec = readonly [
  name: string,
  label: string,
  type: 'text' | 'decimal' | 'instant' | 'choice',
  options: {
    readonly length?: number;
    readonly optional?: boolean;
    readonly searchable?: boolean;
    readonly businessKey?: boolean;
    readonly numberedAs?: string;
    readonly choices?: Choices;
    /** Written only by the returnables capability (`maintainedBy`). */
    readonly maintained?: boolean;
  },
];

/** The entities, in declaration order: local id, label, company-owned. */
export const RETURNABLE_ENTITIES = [
  ['returnable_asset_type', 'Returnable type', false],
  ['returnable_custody', 'Returnable custody', true],
  ['returnable_event', 'Returnable event', true],
] as const;

/**
 * The custody figures -- the unit deposit frozen at the first Issue and every
 * quantity and deposit total -- are maintained by the capability: it restates
 * them from the custody's posted events whenever one posts, and no generic
 * create or update names them. A custody record that has posted nothing is
 * New and holds none of them. An event's attribution is the capability's too.
 */
export const RETURNABLE_FIELDS: Readonly<Record<string, readonly Spec[]>> = {
  returnable_asset_type: [
    [
      'code',
      'Code',
      'text',
      { length: 40, searchable: true, businessKey: true },
    ],
    ['name', 'Name', 'text', { length: 120, searchable: true }],
    [
      'asset_class',
      'Asset class',
      'choice',
      {
        choices: [
          ['pallet', 'Pallet'],
          ['keg', 'Keg'],
          ['crate', 'Crate'],
          ['tote', 'Tote'],
          ['cylinder', 'Cylinder'],
          ['other', 'Other'],
        ],
      },
    ],
    ['deposit_cad', 'Deposit (CAD)', 'decimal', { optional: true }],
    ['deposit_usd', 'Deposit (USD)', 'decimal', { optional: true }],
    ['deposit_eur', 'Deposit (EUR)', 'decimal', { optional: true }],
  ],
  returnable_custody: [
    ['number', 'Custody number', 'text', { length: 60, numberedAs: 'RTN' }],
    ['state', 'State', 'choice', { choices: RETURNABLE_CUSTODY_STATES }],
    ['party_id', 'Party', 'text', { length: 80, searchable: true }],
    ['direction', 'Direction', 'choice', { choices: RETURNABLE_DIRECTIONS }],
    [
      'asset_type_id',
      'Returnable type',
      'text',
      { length: 80, searchable: true },
    ],
    ['currency', 'Currency', 'choice', { choices: RETURNABLE_CURRENCIES }],
    ...(
      [
        ['unit_deposit', 'Unit deposit'],
        ['issued_quantity', 'Issued'],
        ['returned_quantity', 'Returned'],
        ['forfeited_quantity', 'Forfeited'],
        ['outstanding_quantity', 'Outstanding'],
        ['deposit_taken', 'Deposit taken'],
        ['deposit_refunded', 'Deposit refunded'],
        ['deposit_forfeited', 'Deposit kept'],
        ['deposit_held', 'Deposit held'],
        ['deposit_refundable', 'Refundable now'],
      ] as const
    ).map(([name, label]): Spec => [
      name,
      label,
      'decimal',
      { optional: true, maintained: true },
    ]),
    ['notes', 'Notes', 'text', { length: 1000, optional: true }],
  ],
  returnable_event: [
    [
      'state',
      'State',
      'choice',
      {
        choices: [
          ['draft', 'Draft'],
          ['posted', 'Posted'],
        ],
      },
    ],
    ['kind', 'Event', 'choice', { choices: RETURNABLE_EVENT_KINDS }],
    ['event_date', 'Date', 'instant', {}],
    ['quantity', 'Quantity', 'decimal', { optional: true }],
    ['amount', 'Amount', 'decimal', { optional: true }],
    [
      'method',
      'Method',
      'choice',
      { optional: true, choices: RETURNABLE_METHODS },
    ],
    ['reference', 'Reference', 'text', { length: 120, optional: true }],
    ['reason', 'Reason', 'text', { length: 1000, searchable: true }],
    [
      'recorded_by',
      'Recorded by',
      'text',
      { length: 240, optional: true, maintained: true },
    ],
  ],
};

/** What each entity is resolved by. */
const RESOLVE_FIELDS: Readonly<Record<string, string>> = {
  returnable_asset_type: 'code',
  returnable_custody: 'number',
  returnable_event: 'reason',
};

/**
 * The returnables declarations of the Party module, for its `returnables`
 * option. Each collection is merged into the module's own.
 */
export function returnablesDeclarations(
  namespace: string,
  moduleId: string,
  contentCapabilityId: string,
): Readonly<Record<string, Record<string, unknown>[]>> {
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: version,
    targetId,
  });
  const entityId = (local: string) => `${namespace}:entity.${local}`;
  const fieldId = (local: string, name: string) =>
    `${namespace}:field.${local}_${name}`;
  const option = (local: string, name: string, value: string) =>
    `${namespace}:option.${local}_${name}_${value}`;
  const companyOwned = new Set<string>(
    RETURNABLE_ENTITIES.filter(([, , owned]) => owned).map(([local]) => local),
  );
  const equals = (local: string, name: string, value: string) => ({
    field: ref('fieldReference', fieldId(local, name)),
    kind: 'fieldComparisonPredicate',
    operator: 'equals',
    schemaVersion: version,
    value: {
      kind: 'textValue',
      schemaVersion: version,
      value: option(local, name, value),
    },
  });
  // Generic writes of a custody record only while it is New -- the canonical
  // empty image, since no generic write names a figure -- and of an event only
  // while a draft; each event posts once through the capability.
  const guards: Readonly<Record<string, Record<string, unknown> | undefined>> =
    {
      returnable_asset_type: undefined,
      returnable_custody: equals('returnable_custody', 'state', 'new'),
      returnable_event: equals('returnable_event', 'state', 'draft'),
    };
  const fieldType = (local: string, name: string, spec: Spec): FieldType => {
    const [, , type, options] = spec;
    if (type === 'text')
      return {
        kind: 'textFieldType',
        maximumLength: options.length ?? 120,
        schemaVersion: version,
      };
    if (type === 'decimal')
      return {
        kind: 'exactDecimalFieldType',
        precision: 38,
        representation: 'canonicalString',
        scale: 18,
        schemaVersion: version,
      };
    if (type === 'instant')
      return {
        kind: 'dateTimeFieldType',
        precision: 'millisecond',
        schemaVersion: version,
        timezoneSemantics: 'utcInstant',
      };
    return {
      kind: 'enumFieldType',
      schemaVersion: version,
      options: (options.choices ?? []).map(([value, label], index) => ({
        kind: 'enumOption',
        schemaVersion: version,
        optionId: option(local, name, value),
        label,
        orderKey: (index + 1) * 10,
      })),
    };
  };
  const fields = Object.entries(RETURNABLE_FIELDS).flatMap(([local, specs]) =>
    specs.map((spec, index) => {
      const [name, label, type, options] = spec;
      return {
        ...(options.businessKey || options.numberedAs
          ? { businessKey: 'tenantEnvironmentCaseInsensitiveUnique' }
          : {}),
        ...(options.maintained
          ? {
              maintainedBy: ref(
                'capabilityReference',
                RETURNABLES_CAPABILITY_ID,
              ),
            }
          : {}),
        ...(options.numberedAs
          ? {
              numbering: {
                kind: 'documentSequence',
                sequenceId: `${namespace}:document_sequence.${local}`,
                prefix: options.numberedAs,
                minimumDigits: 6,
                start: 1,
              },
            }
          : {}),
        classification: 'internal',
        collation: type === 'text' ? 'unicodeCaseInsensitive' : 'binary',
        defaultSemantics: options.optional ? 'nullable' : 'none',
        entity: ref('entityReference', entityId(local)),
        fieldId: fieldId(local, name),
        fieldType: fieldType(local, name, spec),
        kind: 'fieldDefinition',
        label,
        orderKey: (index + 1) * 10,
        presence: options.optional ? 'optional' : 'required',
        reportable: true,
        schemaVersion: version,
        searchable: options.searchable ?? options.numberedAs !== undefined,
      };
    }),
  );
  const operations: Record<string, unknown>[] = RETURNABLE_ENTITIES.flatMap(
    ([local]) =>
      (
        [
          ['create', 'createRecordEffect'],
          ['update', 'updateRecordEffect'],
          ['archive', 'archiveRecordEffect'],
          ['restore', 'restoreRecordEffect'],
        ] as const
      ).map(([action, kind]) => ({
        confirmation: action === 'archive' ? 'humanRequired' : 'none',
        effect: {
          entity: ref('entityReference', entityId(local)),
          kind,
          schemaVersion: version,
        },
        kind: 'operationDefinition',
        module: ref('moduleReference', moduleId),
        operationId: `${namespace}:operation.${local}_${action}`,
        permission: ref(
          'permissionReference',
          `${namespace}:permission.${local}_${action}`,
        ),
        ...(guards[local] ? { precondition: guards[local] } : {}),
        readBack: ref('queryReference', `${namespace}:query.${local}_get`),
        schemaVersion: version,
        tier: 'o0',
      })),
  );
  // The one command: an event posts once, from a draft, through the
  // capability, which re-checks every bound under the custody's row lock.
  operations.push({
    confirmation: 'humanRequired',
    effect: {
      kind: 'registeredCapabilityEffect',
      schemaVersion: version,
      capability: ref('capabilityReference', RETURNABLES_CAPABILITY_ID),
    },
    kind: 'operationDefinition',
    module: ref('moduleReference', moduleId),
    operationId: `${namespace}:operation.returnable_event_post`,
    permission: ref(
      'permissionReference',
      `${namespace}:permission.returnable_event_post`,
    ),
    precondition: equals('returnable_event', 'state', 'draft'),
    readBack: ref('queryReference', `${namespace}:query.returnable_event_get`),
    schemaVersion: version,
    tier: 'o1',
  });
  const permissions: Record<string, unknown>[] = [
    ...RETURNABLE_ENTITIES.flatMap(([local]) =>
      ['create', 'read', 'update', 'archive', 'restore'].map((action) => ({
        action,
        kind: 'permissionDefinition',
        label: `${local} ${action}`,
        permissionId: `${namespace}:permission.${local}_${action}`,
        resource: ref('entityReference', entityId(local)),
        schemaVersion: version,
      })),
    ),
    {
      action: 'transition',
      kind: 'permissionDefinition',
      label: 'returnable_event post',
      permissionId: `${namespace}:permission.returnable_event_post`,
      resource: ref('entityReference', entityId('returnable_event')),
      schemaVersion: version,
    },
  ];
  const queries = RETURNABLE_ENTITIES.flatMap(([local]) =>
    (['get', 'list', 'search', 'resolve'] as const).map((queryType) => {
      const scopeParameterId = `${namespace}:parameter.${local}_${queryType}_legal_entity_scope`;
      return {
        kind: 'queryDefinition',
        ...(companyOwned.has(local)
          ? {
              legalEntityScope: {
                cardinality: 'exactlyOne',
                kind: 'queryLegalEntityScope',
                operand: {
                  kind: 'queryParameterReference',
                  parameterId: scopeParameterId,
                  schemaVersion: version,
                },
                schemaVersion: version,
              },
              parameters: [
                {
                  kind: 'queryParameterDefinition',
                  orderKey: 10,
                  parameterId: scopeParameterId,
                  schemaVersion: version,
                },
              ],
            }
          : {}),
        maximumResultCount: queryType === 'get' ? 1 : 100,
        // The declared Lists export this whole filtered set in one statement.
        ...(queryType === 'list' && local === 'returnable_custody'
          ? { exportMaximumResultCount: 5_000 }
          : {}),
        module: ref('moduleReference', moduleId),
        permission: ref(
          'permissionReference',
          `${namespace}:permission.${local}_read`,
        ),
        queryId: `${namespace}:query.${local}_${queryType}`,
        queryType,
        ...(queryType === 'resolve'
          ? {
              resolveMatchKeys: [
                {
                  authority: 'identifier',
                  field: ref(
                    'fieldReference',
                    fieldId(local, RESOLVE_FIELDS[local]!),
                  ),
                  kind: 'resolveMatchKey',
                  matchKeyId: `${namespace}:resolve-key.${local}`,
                  orderKey: 10,
                  schemaVersion: version,
                },
              ],
            }
          : {}),
        schemaVersion: version,
        selections: (RETURNABLE_FIELDS[local] ?? []).map(([name], index) => ({
          field: ref('fieldReference', fieldId(local, name)),
          kind: 'querySelection',
          orderKey: (index + 1) * 10,
          schemaVersion: version,
          selectionId: `${namespace}:selection.${local}_${queryType}_${String(index + 1)}`,
        })),
        sourceEntity: ref('entityReference', entityId(local)),
        tier: 'q0',
      };
    }),
  );
  const relation = (
    local: string,
    source: string,
    target: string,
    ownership: 'reference' | 'parentScopedChild',
    orderKey: number,
  ) => ({
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
    ownership,
    relationId: `${namespace}:relation.${local}`,
    required: true,
    schemaVersion: version,
    sourceEntity: ref('entityReference', entityId(source)),
    targetEntity: ref('entityReference', entityId(target)),
  });
  // Every entity has the three standard surfaces. A custody record is
  // started from its party's page and an event from its custody's; their
  // forms are reachable only while the record may still be written.
  const roles = ['list', 'detail', 'form'] as const;
  const slotsFor: Readonly<Record<string, readonly string[]>> = {
    list: ['title', 'dataGrid', 'bulkActions'],
    detail: ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts', 'sections'],
    form: ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts', 'sections'],
  };
  const surfaces = RETURNABLE_ENTITIES.flatMap(([local, label]) =>
    roles.map((suffix) => {
      const surfaceRole =
        suffix === 'list' ? 'list' : suffix === 'form' ? 'form' : 'record';
      return {
        archetype: suffix === 'list' ? 'list' : 'record',
        dataSource: ref(
          'queryReference',
          `${namespace}:query.${local}_${suffix === 'list' ? 'list' : 'get'}`,
        ),
        kind: 'surfaceDefinition',
        label: `${label} ${suffix}`,
        module: ref('moduleReference', moduleId),
        schemaVersion: version,
        slots: (slotsFor[suffix] ?? []).map((slot, index) => ({
          content: ref('opaqueSurfaceContentReference', contentCapabilityId),
          kind: 'surfaceSlot',
          orderKey: (index + 1) * 10,
          schemaVersion: version,
          slot,
          slotId: `${namespace}:slot.${local}_${suffix}_${slot.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}`,
        })),
        statusRoles: [],
        surfaceId: `${namespace}:surface.${local}_${suffix}`,
        surfaceRole,
      };
    }),
  );
  return {
    assertions: RETURNABLE_ENTITIES.map(([local]) => ({
      assertionId: `${namespace}:assertion.${local}_walking_slice`,
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
        query: ref('queryReference', `${namespace}:query.${local}_get`),
        schemaVersion: version,
      },
      kind: 'assertionDefinition',
      schemaVersion: version,
    })),
    capabilityRequirements: [
      {
        capabilityId: RETURNABLES_CAPABILITY_ID,
        capabilityVersion: RETURNABLES_CAPABILITY_VERSION,
        declaredEffects: ['recordMutation'],
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
    entities: RETURNABLE_ENTITIES.map(([local, label], index) => ({
      entityId: entityId(local),
      kind: 'entityDefinition',
      label,
      module: ref('moduleReference', moduleId),
      orderKey: 40 + index * 10,
      schemaVersion: version,
      storage: ref('storageMappingReference', `${namespace}:storage.${local}`),
    })),
    fields,
    operations,
    permissions,
    queries,
    // A custody record names its party, which lists it on its page, and its
    // returnable type, which is not archived while a live custody names it
    // (restrict); an event belongs to its custody record.
    relations: [
      relation(
        'returnable_custody_party',
        'returnable_custody',
        'party',
        'reference',
        30,
      ),
      relation(
        'returnable_custody_asset_type',
        'returnable_custody',
        'returnable_asset_type',
        'reference',
        35,
      ),
      // A reference, not an owned child: an owned child is written only
      // while its parent's own writes are admitted, and a custody record
      // takes events long after it stops admitting generic writes.
      relation(
        'returnable_event_custody',
        'returnable_event',
        'returnable_custody',
        'reference',
        40,
      ),
    ],
    storageMappings: RETURNABLE_ENTITIES.map(([local]) => ({
      entity: ref('entityReference', entityId(local)),
      kind: 'storageMappingDefinition',
      schemaVersion: version,
      storageClass: 'dedicatedTable',
      storageMappingId: `${namespace}:storage.${local}`,
    })),
    surfaces,
  };
}
