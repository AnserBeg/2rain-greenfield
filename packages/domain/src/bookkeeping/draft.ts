/**
 * DOCUMENT-POSTING slice 1: the staged manual journal (ADR-0093). A person
 * enters a draft -- kind, currency, date, memo -- and its lines -- number,
 * account code, side, amount -- marks it Ready, which freezes it, and Posts
 * it. The post is the ledger engine's `general_ledger` capability, bound by
 * the general document-posting block: the ledger resolves every table and
 * column from the released storage plan by these canonical IDs, converts the
 * lines and writes one manual entry, then moves the draft to Posted, which no
 * declared transition reaches or leaves.
 *
 * Every header edit is refused outside Draft, spelled not(state = S) for each
 * other state (the form a create can share), and the lines inherit that
 * guard through the declared parent-scoped relation, so Ready and Posted
 * documents cannot change under a post.
 */
const version = 'v6' as const;

const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

export const LEDGER_GENERAL_LEDGER_CAPABILITY_ID =
  'northstar.ledger:capability.general_ledger' as const;

const STATES = [
  ['draft', 'Draft', false],
  ['ready', 'Ready', false],
  ['posted', 'Posted', true],
] as const;
type StateLocal = (typeof STATES)[number][0];

const TRANSITIONS = [
  ['ready', 'Mark ready', 10, 'draft', 'ready'],
  ['reopen', 'Reopen', 20, 'ready', 'draft'],
] as const;

export function bookkeepingDraftIds(namespace: string) {
  const id = (kind: string, local: string) => `${namespace}:${kind}.${local}`;
  const machineId = id('machine', 'bookkeeping_draft_lifecycle');
  const separator = machineId.indexOf(':');
  return {
    entityIds: {
      draft: id('entity', 'bookkeeping_draft'),
      line: id('entity', 'bookkeeping_draft_line'),
    },
    fieldIds: {
      kind: id('field', 'bookkeeping_draft_kind'),
      currency: id('field', 'bookkeeping_draft_currency'),
      date: id('field', 'bookkeeping_draft_date'),
      memo: id('field', 'bookkeeping_draft_memo'),
      lineNumber: id('field', 'bookkeeping_draft_line_number'),
      lineAccountCode: id('field', 'bookkeeping_draft_line_account_code'),
      lineSide: id('field', 'bookkeeping_draft_line_side'),
      lineAmount: id('field', 'bookkeeping_draft_line_amount'),
    },
    optionIds: {
      manual: id('option', 'bookkeeping_draft_kind_manual'),
      opening: id('option', 'bookkeeping_draft_kind_opening'),
      debit: id('option', 'bookkeeping_draft_line_side_debit'),
      credit: id('option', 'bookkeeping_draft_line_side_credit'),
    },
    machineId,
    // Minted by normalization from the machine identity (ADR-0050); declared
    // here so guards and selections can address it.
    stateFieldId: `${machineId.slice(0, separator)}:derived_state_field.${machineId.slice(separator + 1)}`,
    stateIds: Object.fromEntries(
      STATES.map(([local]) => [
        local,
        id('state', `bookkeeping_draft_state_${local}`),
      ]),
    ) as Record<StateLocal, string>,
    relationId: id('relation', 'bookkeeping_draft_line_draft'),
    postOperationId: id('operation', 'bookkeeping_draft_post'),
  } as const;
}

type Ids = ReturnType<typeof bookkeepingDraftIds>;

const textType = (maximumLength: number) => ({
  kind: 'textFieldType',
  maximumLength,
  schemaVersion: version,
});

function field(
  entityId: string,
  fieldId: string,
  label: string,
  orderKey: number,
  fieldType: Record<string, unknown>,
  optional = false,
  searchable = false,
): Record<string, unknown> {
  return {
    classification: 'internal',
    collation: searchable ? 'unicodeCaseInsensitive' : 'binary',
    defaultSemantics: optional ? 'nullable' : 'none',
    entity: reference('entityReference', entityId),
    fieldId,
    fieldType,
    kind: 'fieldDefinition',
    label,
    orderKey,
    presence: optional ? 'optional' : 'required',
    reportable: true,
    schemaVersion: version,
    searchable,
  };
}

const choice = (options: readonly (readonly [string, string])[]) => ({
  kind: 'enumFieldType',
  options: options.map(([optionId, label], index) => ({
    kind: 'enumOption',
    label,
    optionId,
    orderKey: (index + 1) * 10,
    schemaVersion: version,
  })),
  schemaVersion: version,
});

const stateEquals = (ids: Ids, state: StateLocal) => ({
  field: reference('fieldReference', ids.stateFieldId),
  kind: 'fieldComparisonPredicate',
  operator: 'equals',
  schemaVersion: version,
  value: {
    kind: 'textValue',
    schemaVersion: version,
    value: ids.stateIds[state],
  },
});

/** Editable only while Draft: not(Ready) and not(Posted). */
const editableWhileDraft = (ids: Ids) => ({
  kind: 'allPredicate',
  schemaVersion: version,
  terms: (['ready', 'posted'] as const).map((state) => ({
    kind: 'notPredicate',
    schemaVersion: version,
    term: stateEquals(ids, state),
  })),
});

/**
 * The staged journal's declarations, merged into the Books module.
 * `moduleId` and `contentCapabilityId` are the module's own.
 */
export function bookkeepingDraftDeclarations(
  namespace: string,
  moduleId: string,
  contentCapabilityId: string,
) {
  const ids = bookkeepingDraftIds(namespace);
  const id = (kind: string, local: string) => `${namespace}:${kind}.${local}`;
  const { draft, line } = ids.entityIds;
  const entity = (
    local: string,
    label: string,
    entityId: string,
    orderKey: number,
  ) => ({
    entityId,
    kind: 'entityDefinition',
    label,
    module: reference('moduleReference', moduleId),
    orderKey,
    schemaVersion: version,
    storage: reference('storageMappingReference', id('storage', local)),
  });
  const storageMapping = (local: string, entityId: string) => ({
    entity: reference('entityReference', entityId),
    kind: 'storageMappingDefinition',
    schemaVersion: version,
    storageClass: 'dedicatedTable',
    storageMappingId: id('storage', local),
  });
  const permission = (
    permissionLocal: string,
    action: string,
    entityId: string,
  ) => ({
    action,
    kind: 'permissionDefinition',
    label: `${permissionLocal.replaceAll('_', ' ')}`,
    permissionId: id('permission', permissionLocal),
    resource: reference('entityReference', entityId),
    schemaVersion: version,
  });
  const queries = (
    local: string,
    entityId: string,
    selected: readonly string[],
    types: readonly string[],
    resolveFieldId: string,
  ) =>
    types.map((queryType) => {
      const scope = id('parameter', `${local}_${queryType}_legal_entity_scope`);
      return {
        kind: 'queryDefinition',
        legalEntityScope: {
          cardinality: 'exactlyOne',
          kind: 'queryLegalEntityScope',
          operand: {
            kind: 'queryParameterReference',
            parameterId: scope,
            schemaVersion: version,
          },
          schemaVersion: version,
        },
        parameters: [
          {
            kind: 'queryParameterDefinition',
            orderKey: 10,
            parameterId: scope,
            schemaVersion: version,
          },
        ],
        maximumResultCount: queryType === 'get' ? 1 : 100,
        module: reference('moduleReference', moduleId),
        permission: reference(
          'permissionReference',
          id('permission', `${local}_read`),
        ),
        queryId: id('query', `${local}_${queryType}`),
        queryType,
        ...(queryType === 'resolve'
          ? {
              resolveMatchKeys: [
                {
                  authority: 'advisory',
                  field: reference('fieldReference', resolveFieldId),
                  kind: 'resolveMatchKey',
                  matchKeyId: id('resolve-key', local),
                  orderKey: 10,
                  schemaVersion: version,
                },
              ],
            }
          : {}),
        schemaVersion: version,
        selections: selected.map((fieldId, index) => ({
          field: reference('fieldReference', fieldId),
          kind: 'querySelection',
          orderKey: (index + 1) * 10,
          schemaVersion: version,
          selectionId: id(
            'selection',
            `${local}_${queryType}_${String(index + 1)}`,
          ),
        })),
        sourceEntity: reference('entityReference', entityId),
        tier: 'q0',
      };
    });
  const recordOperations = (
    local: string,
    entityId: string,
    precondition?: Record<string, unknown>,
  ) =>
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
        entity: reference('entityReference', entityId),
        kind,
        schemaVersion: version,
      },
      kind: 'operationDefinition',
      module: reference('moduleReference', moduleId),
      operationId: id('operation', `${local}_${action}`),
      permission: reference(
        'permissionReference',
        id('permission', `${local}_${action}`),
      ),
      ...(precondition ? { precondition } : {}),
      readBack: reference('queryReference', id('query', `${local}_get`)),
      schemaVersion: version,
      tier: 'o0',
    }));
  const surfaces = (local: string, label: string) =>
    (
      [
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
      ] as const
    ).map(([suffix, archetype, slots, surfaceRole]) => ({
      archetype,
      dataSource: reference(
        'queryReference',
        id('query', `${local}_${surfaceRole === 'list' ? 'list' : 'get'}`),
      ),
      kind: 'surfaceDefinition',
      label: `${label} ${suffix}`,
      module: reference('moduleReference', moduleId),
      schemaVersion: version,
      slots: slots.map((slot, index) => ({
        content: reference(
          'opaqueSurfaceContentReference',
          contentCapabilityId,
        ),
        kind: 'surfaceSlot',
        orderKey: (index + 1) * 10,
        schemaVersion: version,
        slot,
        slotId: id(
          'slot',
          `${local}_${suffix}_${slot.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`,
        ),
      })),
      statusRoles: [],
      surfaceId: id('surface', `${local}_${suffix}`),
      surfaceRole,
    }));
  const guard = editableWhileDraft(ids);
  const headerFields = [
    ids.stateFieldId,
    ids.fieldIds.kind,
    ids.fieldIds.currency,
    ids.fieldIds.date,
    ids.fieldIds.memo,
  ];
  const lineFields = [
    ids.fieldIds.lineNumber,
    ids.fieldIds.lineAccountCode,
    ids.fieldIds.lineSide,
    ids.fieldIds.lineAmount,
  ];
  const transitionPermission = (local: string) =>
    id('permission', `bookkeeping_draft_${local}`);
  const walkingSlice = (local: string) => ({
    assertionId: id('assertion', `${local}_walking_slice`),
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
      query: reference('queryReference', id('query', `${local}_get`)),
      schemaVersion: version,
    },
    kind: 'assertionDefinition',
    schemaVersion: version,
  });
  return {
    assertions: [
      walkingSlice('bookkeeping_draft'),
      walkingSlice('bookkeeping_draft_line'),
    ],
    capabilityId: LEDGER_GENERAL_LEDGER_CAPABILITY_ID,
    entities: [
      entity('bookkeeping_draft', 'Journal draft', draft, 10),
      entity('bookkeeping_draft_line', 'Journal draft line', line, 20),
    ],
    fields: [
      field(
        draft,
        ids.fieldIds.kind,
        'Kind',
        10,
        choice([
          [ids.optionIds.manual, 'Manual'],
          [ids.optionIds.opening, 'Opening'],
        ]),
      ),
      // Searchable, as the purchase order's currency is: release verification
      // proves a non-searchable text field's value is not found by search, and
      // a three-letter value is a substring of the memo's.
      field(
        draft,
        ids.fieldIds.currency,
        'Currency',
        20,
        textType(3),
        false,
        true,
      ),
      field(draft, ids.fieldIds.date, 'Date', 30, {
        calendar: 'iso8601',
        kind: 'dateFieldType',
        schemaVersion: version,
        timezoneSemantics: 'calendarDate',
      }),
      field(draft, ids.fieldIds.memo, 'Memo', 40, textType(1000), true, true),
      field(line, ids.fieldIds.lineNumber, 'Line', 10, {
        kind: 'integerFieldType',
        representation: 'canonicalString',
        schemaVersion: version,
      }),
      field(
        line,
        ids.fieldIds.lineAccountCode,
        'Account code',
        20,
        textType(32),
        false,
        true,
      ),
      field(
        line,
        ids.fieldIds.lineSide,
        'Side',
        30,
        choice([
          [ids.optionIds.debit, 'Debit'],
          [ids.optionIds.credit, 'Credit'],
        ]),
      ),
      field(line, ids.fieldIds.lineAmount, 'Amount', 40, {
        kind: 'exactDecimalFieldType',
        precision: 18,
        representation: 'canonicalString',
        scale: 4,
        schemaVersion: version,
      }),
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
        relationId: ids.relationId,
        required: true,
        schemaVersion: version,
        sourceEntity: reference('entityReference', line),
        targetEntity: reference('entityReference', draft),
      },
    ],
    stateMachines: [
      {
        entity: reference('entityReference', draft),
        initialState: reference('stateReference', ids.stateIds.draft),
        kind: 'stateMachineDefinition',
        machineId: ids.machineId,
        schemaVersion: version,
        states: STATES.map(([local, label, terminal], index) => ({
          kind: 'stateDefinition',
          label,
          orderKey: (index + 1) * 10,
          schemaVersion: version,
          stateId: ids.stateIds[local],
          terminal,
        })),
        transitions: TRANSITIONS.map(([local, label, orderKey, from, to]) => ({
          fromState: reference('stateReference', ids.stateIds[from]),
          kind: 'transitionDefinition',
          label,
          orderKey,
          permission: reference(
            'permissionReference',
            transitionPermission(local),
          ),
          schemaVersion: version,
          toState: reference('stateReference', ids.stateIds[to]),
          transitionId: id('transition', `bookkeeping_draft_${local}`),
        })),
      },
    ],
    operations: [
      ...recordOperations('bookkeeping_draft', draft, guard),
      ...recordOperations('bookkeeping_draft_line', line),
      ...TRANSITIONS.map(([local, label, , from]) => ({
        confirmation: 'none',
        effect: {
          kind: 'transitionStateEffect',
          schemaVersion: version,
          transition: reference(
            'transitionReference',
            id('transition', `bookkeeping_draft_${local}`),
          ),
        },
        kind: 'operationDefinition',
        label,
        module: reference('moduleReference', moduleId),
        operationId: id('operation', `bookkeeping_draft_${local}`),
        permission: reference(
          'permissionReference',
          transitionPermission(local),
        ),
        precondition: stateEquals(ids, from),
        readBack: reference(
          'queryReference',
          id('query', 'bookkeeping_draft_get'),
        ),
        schemaVersion: version,
        tier: 'o0',
      })),
      {
        confirmation: 'humanRequired',
        documentPosting: {
          bindingVersion: 'documentPosting/v1',
          engine: LEDGER_GENERAL_LEDGER_CAPABILITY_ID,
          header: { entity: draft },
          lines: { relation: ids.relationId },
          state: {
            field: ids.stateFieldId,
            from: ids.stateIds.ready,
            to: ids.stateIds.posted,
          },
          roles: {
            kind: ids.fieldIds.kind,
            currency: ids.fieldIds.currency,
            date: ids.fieldIds.date,
            memo: ids.fieldIds.memo,
            number: ids.fieldIds.lineNumber,
            account: ids.fieldIds.lineAccountCode,
            side: ids.fieldIds.lineSide,
            amount: ids.fieldIds.lineAmount,
          },
          options: {
            manual: ids.optionIds.manual,
            opening: ids.optionIds.opening,
            debit: ids.optionIds.debit,
            credit: ids.optionIds.credit,
          },
        },
        effect: {
          capability: reference(
            'capabilityReference',
            LEDGER_GENERAL_LEDGER_CAPABILITY_ID,
          ),
          kind: 'registeredCapabilityEffect',
          schemaVersion: version,
        },
        kind: 'operationDefinition',
        label: 'Post',
        module: reference('moduleReference', moduleId),
        operationId: ids.postOperationId,
        permission: reference(
          'permissionReference',
          transitionPermission('post'),
        ),
        precondition: stateEquals(ids, 'ready'),
        readBack: reference(
          'queryReference',
          id('query', 'bookkeeping_draft_get'),
        ),
        schemaVersion: version,
        tier: 'o1',
      },
    ],
    permissions: [
      ...['create', 'read', 'update', 'archive', 'restore'].flatMap(
        (action) => [
          permission(`bookkeeping_draft_${action}`, action, draft),
          permission(`bookkeeping_draft_line_${action}`, action, line),
        ],
      ),
      ...['ready', 'reopen', 'post'].map((local) =>
        permission(`bookkeeping_draft_${local}`, 'transition', draft),
      ),
    ],
    queries: [
      ...queries(
        'bookkeeping_draft',
        draft,
        headerFields,
        ['get', 'list', 'search', 'resolve'],
        ids.fieldIds.memo,
      ),
      ...queries(
        'bookkeeping_draft_line',
        line,
        lineFields,
        ['get', 'list', 'search', 'resolve'],
        ids.fieldIds.lineAccountCode,
      ),
    ],
    storageMappings: [
      storageMapping('bookkeeping_draft', draft),
      storageMapping('bookkeeping_draft_line', line),
    ],
    surfaces: [
      ...surfaces('bookkeeping_draft', 'Journal draft'),
      ...surfaces('bookkeeping_draft_line', 'Journal draft line'),
    ],
  };
}
