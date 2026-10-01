/** APPROVAL-PO, rulings A1-A5: one decision, no new order state or workflow engine. */
export const PO_APPROVAL_CAPABILITY_ID =
  'northstar.purchasing:capability.order_approvals' as const;

const version = 'v6';
const ref = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});
const text = (maximumLength: number) => ({
  kind: 'textFieldType',
  schemaVersion: version,
  maximumLength,
});

/** Product-only declarations; the standalone Purchasing walking slice stays unchanged. */
export function withPurchaseOrderApprovals(
  definition: Record<string, unknown>,
  namespace: string,
): Record<string, unknown> {
  const id = (kind: string, local: string) => `${namespace}:${kind}.${local}`;
  const collection = (key: string) =>
    definition[key] as Record<string, unknown>[];
  const module = ref('moduleReference', id('module', 'purchasing'));
  const specs = {
    purchase_order_approval: [
      ['number', 'Request', text(80), false],
      ['order_number', 'Purchase order', text(60), false],
      [
        'state',
        'Decision',
        {
          kind: 'enumFieldType',
          schemaVersion: version,
          options: ['pending', 'approved', 'rejected', 'consumed'].map(
            (value, i) => ({
              kind: 'enumOption',
              schemaVersion: version,
              orderKey: (i + 1) * 10,
              optionId: id('option', `purchase_order_approval_state_${value}`),
              label: value[0]!.toUpperCase() + value.slice(1),
            }),
          ),
        },
        false,
      ],
      ['kind', 'Request kind', text(20), false],
      ['revision_digest', 'Requested revision', text(64), false],
      ['requested_by', 'Requested by', text(80), false],
      ['decided_by', 'Decided by', text(80), true],
      ['reason', 'Request reason', text(1000), true],
      ['decision_reason', 'Decision reason', text(1000), true],
      ['amendment_id', 'Staged amendment', text(80), true],
      ['current_quantity', 'Current ordered quantity', text(80), true],
      ['proposed_quantity', 'Proposed ordered quantity', text(80), true],
    ],
    purchasing_settings: [
      ['key', 'Setting', text(60), false],
      [
        'require_approval',
        'Purchase orders require approval',
        { kind: 'booleanFieldType', schemaVersion: version },
        false,
      ],
    ],
  } as const;
  const newFields: Record<string, unknown>[] = Object.entries(specs).flatMap(
    ([local, entries]) =>
      entries.map(([name, label, fieldType, optional], i) => ({
        kind: 'fieldDefinition',
        schemaVersion: version,
        entity: ref('entityReference', id('entity', local)),
        fieldId: id('field', `${local}_${name}`),
        label,
        orderKey: (i + 1) * 10,
        fieldType,
        presence: optional ? 'optional' : 'required',
        defaultSemantics: optional ? 'nullable' : 'none',
        classification: 'internal',
        collation: 'binary',
        reportable: true,
        searchable:
          name === 'number' || name === 'order_number' || name === 'key',
        ...(name === 'number' || name === 'key'
          ? { businessKey: 'tenantEnvironmentCaseInsensitiveUnique' }
          : {}),
      })),
  );
  newFields.push({
    kind: 'fieldDefinition',
    schemaVersion: version,
    entity: ref('entityReference', id('entity', 'purchase_order')),
    fieldId: id('field', 'purchase_order_supplier_reference'),
    label: 'Supplier reference',
    orderKey: 160,
    fieldType: text(80),
    presence: 'optional',
    defaultSemantics: 'nullable',
    classification: 'internal',
    collation: 'binary',
    reportable: true,
    // The reference is displayed, not a new indexed-search contract.
    searchable: false,
  });
  const operation = (
    local: string,
    target: string,
    permission: string,
    label: string,
  ) => ({
    kind: 'operationDefinition',
    schemaVersion: version,
    module,
    operationId: id('operation', local),
    label,
    tier: 'o1',
    confirmation: 'humanRequired',
    effect: {
      kind: 'registeredCapabilityEffect',
      schemaVersion: version,
      capability: ref('capabilityReference', PO_APPROVAL_CAPABILITY_ID),
    },
    permission: ref('permissionReference', id('permission', permission)),
    readBack: ref('queryReference', id('query', `${target}_get`)),
  });
  const stateGuard = (local: string) => ({
    kind: 'fieldComparisonPredicate',
    schemaVersion: version,
    field: ref(
      'fieldReference',
      id('derived_state_field', 'machine.purchase_order_lifecycle'),
    ),
    operator: 'equals',
    value: {
      kind: 'textValue',
      schemaVersion: version,
      value: id('state', `purchase_order_${local}`),
    },
  });
  const surfaces = Object.keys(specs).flatMap((local) =>
    [
      'list',
      'detail',
      ...(local === 'purchasing_settings' ? ['form'] : []),
    ].map((suffix) => ({
      kind: 'surfaceDefinition',
      schemaVersion: version,
      module,
      surfaceId: id('surface', `${local}_${suffix}`),
      label:
        local === 'purchase_order_approval'
          ? suffix === 'list'
            ? 'Approvals'
            : 'Approval request'
          : 'Purchasing settings',
      archetype: suffix === 'list' ? 'list' : 'record',
      surfaceRole: suffix === 'detail' ? 'record' : suffix,
      dataSource: ref(
        'queryReference',
        id('query', `${local}_${suffix === 'list' ? 'list' : 'get'}`),
      ),
      statusRoles: [],
      slots: (suffix === 'list'
        ? ['title', 'dataGrid', 'bulkActions']
        : ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts', 'sections']
      ).map((slot, i) => ({
        kind: 'surfaceSlot',
        schemaVersion: version,
        slot,
        slotId: id(
          'slot',
          `${local}_${suffix}_${slot.replace(/[A-Z]/g, (s) => `_${s.toLowerCase()}`)}`,
        ),
        orderKey: (i + 1) * 10,
        content: ref(
          'opaqueSurfaceContentReference',
          id('capability', 'standard_surface_content'),
        ),
      })),
    })),
  );
  const queries = Object.entries(specs).flatMap(([local, entries]) =>
    ['get', 'list', 'search', 'resolve'].map((type) => ({
      kind: 'queryDefinition',
      schemaVersion: version,
      module,
      queryId: id('query', `${local}_${type}`),
      sourceEntity: ref('entityReference', id('entity', local)),
      queryType: type,
      tier: 'q0',
      maximumResultCount: type === 'get' ? 1 : 100,
      permission: ref('permissionReference', id('permission', `${local}_read`)),
      ...(local === 'purchase_order_approval'
        ? {
            legalEntityScope: {
              kind: 'queryLegalEntityScope',
              schemaVersion: version,
              cardinality: 'exactlyOne',
              operand: {
                kind: 'queryParameterReference',
                schemaVersion: version,
                parameterId: id(
                  'parameter',
                  `${local}_${type}_legal_entity_scope`,
                ),
              },
            },
            parameters: [
              {
                kind: 'queryParameterDefinition',
                schemaVersion: version,
                orderKey: 10,
                parameterId: id(
                  'parameter',
                  `${local}_${type}_legal_entity_scope`,
                ),
              },
            ],
          }
        : {}),
      ...(type === 'resolve'
        ? {
            resolveMatchKeys: [
              {
                kind: 'resolveMatchKey',
                schemaVersion: version,
                authority: 'identifier',
                field: ref(
                  'fieldReference',
                  id(
                    'field',
                    `${local}_${local === 'purchasing_settings' ? 'key' : 'number'}`,
                  ),
                ),
                matchKeyId: id('resolve-key', local),
                orderKey: 10,
              },
            ],
          }
        : {}),
      selections: entries.map(([name], i) => ({
        kind: 'querySelection',
        schemaVersion: version,
        selectionId: id('selection', `${local}_${type}_${String(i + 1)}`),
        orderKey: (i + 1) * 10,
        field: ref('fieldReference', id('field', `${local}_${name}`)),
      })),
    })),
  );
  const settingsOperations = ['create', 'update', 'archive', 'restore'].map(
    (action) => ({
      kind: 'operationDefinition',
      schemaVersion: version,
      module,
      tier: 'o0',
      confirmation: action === 'archive' ? 'humanRequired' : 'none',
      operationId: id('operation', `purchasing_settings_${action}`),
      permission: ref(
        'permissionReference',
        id('permission', `purchasing_settings_${action}`),
      ),
      readBack: ref('queryReference', id('query', 'purchasing_settings_get')),
      effect: {
        kind: `${action}RecordEffect`,
        schemaVersion: version,
        entity: ref('entityReference', id('entity', 'purchasing_settings')),
      },
    }),
  );
  return {
    ...definition,
    assertions: [
      ...collection('assertions'),
      ...Object.keys(specs).map((local) => ({
        kind: 'assertionDefinition',
        schemaVersion: version,
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
          schemaVersion: version,
          query: ref('queryReference', id('query', `${local}_get`)),
        },
      })),
    ],
    capabilityRequirements: [
      ...collection('capabilityRequirements'),
      {
        kind: 'capabilityRequirement',
        schemaVersion: version,
        capabilityId: PO_APPROVAL_CAPABILITY_ID,
        capabilityVersion: 1,
        declaredEffects: ['recordMutation'],
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
        supportStatus: 'supported',
      },
    ],
    entities: [
      ...collection('entities'),
      ...Object.keys(specs).map((local, i) => ({
        kind: 'entityDefinition',
        schemaVersion: version,
        entityId: id('entity', local),
        label:
          local === 'purchasing_settings'
            ? 'Purchasing settings'
            : 'Approval request',
        module,
        orderKey: 110 + i * 10,
        storage: ref('storageMappingReference', id('storage', local)),
      })),
    ],
    fields: [...collection('fields'), ...newFields],
    storageMappings: [
      ...collection('storageMappings'),
      ...Object.keys(specs).map((local) => ({
        kind: 'storageMappingDefinition',
        schemaVersion: version,
        entity: ref('entityReference', id('entity', local)),
        storageClass: 'dedicatedTable',
        storageMappingId: id('storage', local),
      })),
    ],
    operations: [
      ...collection('operations').map((entry) =>
        entry.operationId === id('operation', 'purchase_order_release')
          ? {
              ...operation(
                'purchase_order_release',
                'purchase_order',
                'purchase_order_release',
                'Place order',
              ),
              precondition: stateGuard('draft'),
            }
          : entry.operationId === id('operation', 'purchase_order_line_amend')
            ? operation(
                'purchase_order_line_amend',
                'purchase_order_line',
                'purchase_order_line_amend',
                'Request amendment',
              )
            : entry,
      ),
      {
        ...operation(
          'purchase_order_submit',
          'purchase_order',
          'purchase_order_read',
          'Submit for approval',
        ),
        precondition: stateGuard('draft'),
      },
      operation(
        'purchase_order_approval_approve',
        'purchase_order_approval',
        'purchase_order_approve',
        'Approve',
      ),
      operation(
        'purchase_order_approval_reject',
        'purchase_order_approval',
        'purchase_order_approve',
        'Reject',
      ),
      ...settingsOperations,
    ],
    permissions: [
      ...collection('permissions'),
      ...[
        ['purchase_order_approve', 'transition', 'purchase_order_approval'],
        ['purchase_order_approval_read', 'read', 'purchase_order_approval'],
        ...['create', 'read', 'update', 'archive', 'restore'].map((action) => [
          `purchasing_settings_${action}`,
          action,
          'purchasing_settings',
        ]),
      ].map(([local, action, target]) => ({
        kind: 'permissionDefinition',
        schemaVersion: version,
        action,
        label: local!.replaceAll('_', ' '),
        permissionId: id('permission', local!),
        resource: ref('entityReference', id('entity', target!)),
      })),
    ],
    queries: [
      ...collection('queries').map((query) =>
        (query.sourceEntity as { targetId: string }).targetId ===
        id('entity', 'purchase_order')
          ? {
              ...query,
              selections: [
                ...(query.selections as unknown[]),
                {
                  kind: 'querySelection',
                  schemaVersion: version,
                  orderKey: 180,
                  selectionId: `${String(query.queryId).replace(':query.', ':selection.')}_supplier_reference`,
                  field: ref(
                    'fieldReference',
                    id('field', 'purchase_order_supplier_reference'),
                  ),
                },
              ],
            }
          : query,
      ),
      ...queries,
    ],
    relations: [
      ...collection('relations'),
      {
        kind: 'relationDefinition',
        schemaVersion: version,
        relationId: id('relation', 'purchase_order_approval_order'),
        orderKey: 110,
        sourceEntity: ref(
          'entityReference',
          id('entity', 'purchase_order_approval'),
        ),
        targetEntity: ref('entityReference', id('entity', 'purchase_order')),
        cardinality: 'manyToOne',
        ownership: 'reference',
        required: true,
        joinEligibility: 'query',
        archiveBehavior: 'restrict',
        foreignKeyActions: {
          schemaVersion: version,
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      },
    ],
    surfaces: [...collection('surfaces'), ...surfaces],
  };
}

/** Revision identity includes every live line; line edits do not advance the header. */
export function purchaseOrderRevisionImage(
  headerRevision: number,
  lines: readonly { recordId: string; revision: number }[],
): string {
  return JSON.stringify([
    headerRevision,
    [...lines]
      .sort((a, b) =>
        a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0,
      )
      .map((line) => [line.recordId, line.revision]),
  ]);
}
