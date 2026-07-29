export const INVENTORY_CONTRACT_SCHEMA_VERSION =
  'northstar.inventory-contract/v1' as const;
export const INVENTORY_CONTRACT_RELEASE_VERSION =
  'northstar.inventory-contract-release/v1' as const;
export const STOCK_DIMENSION_SET_ID =
  'northstar.stock-dimension-set/v1' as const;
export const INVENTORY_POSTING_DEPENDENCY_SET_ROOT =
  '7ef50e86732818a0ec4ec2a03a001066ac59408ea260c65bf018646e4377a63d' as const;

export const INVENTORY_POSTING_ROLES = Object.freeze([
  'adjustment',
  'transfer',
  'count',
  'correction',
  'reBaseline',
] as const);

export type InventoryPostingRole = (typeof INVENTORY_POSTING_ROLES)[number];
export type NegativeStockMode = 'reject' | 'allowWithFlag' | 'allow';
export type ReasonRequirement = 'codeOnly' | 'codeAndNarrative';

export interface InventoryAuthoritativeDependencyV1 {
  readonly access: 'read' | 'append' | 'transition';
  readonly authority:
    | 'trustedContext'
    | 'operationInput'
    | 'catalog'
    | 'location'
    | 'party'
    | 'inventory'
    | 'trust';
  readonly dependencyId: string;
}

export interface InventoryContractDefinitionV1 {
  readonly authoritativeDependencies: {
    readonly accessPlan: readonly InventoryAuthoritativeDependencyV1[];
    readonly dependencySetRoot: typeof INVENTORY_POSTING_DEPENDENCY_SET_ROOT;
    readonly dependencies: readonly InventoryAuthoritativeDependencyV1[];
    readonly exhaustiveByConstruction: true;
    readonly undeclaredAccess: 'compileFailure';
    readonly version: 1;
  };
  readonly baseUnit: {
    readonly bindingFact: 'firstPostedMovement';
    readonly changeWhenBound: 'reject';
    readonly diagnostic: {
      readonly bindingMovementField: 'movementId';
      readonly code: 'INVENTORY_BASE_UNIT_IMMUTABLE';
    };
    readonly itemFieldId: 'northstar.catalog:field.item_base_unit';
    readonly operationContract: 'namedBaseUnitChange';
  };
  readonly capabilityId: 'northstar.inventory:capability.posting';
  readonly capabilityVersion: 1;
  readonly compiledArtifacts: readonly {
    readonly artifactId: string;
    readonly outputSemantic: 'fact' | 'quantity' | 'time' | 'text';
    readonly source: 'inventoryMovement';
  }[];
  readonly configuration: {
    readonly dials: {
      readonly approvalThresholds: {
        readonly comparison: 'absoluteQuantityGreaterThan';
        readonly default: Readonly<Record<InventoryPostingRole, string | null>>;
        readonly exactBaseUnit: true;
        readonly kind: 'postingRoleExactQuantityMap';
        readonly precision: 38;
        readonly scale: 18;
      };
      readonly maximumBackdateDays: {
        readonly default: 0;
        readonly kind: 'integer';
        readonly maximum: 3650;
        readonly minimum: 0;
      };
      readonly negativeStock: {
        readonly default: 'reject';
        readonly evaluation: 'insidePostingTransactionAgainstSerializedState';
        readonly kind: 'enum';
        readonly values: readonly ['reject', 'allowWithFlag', 'allow'];
      };
      readonly reasonRequirements: {
        readonly default: Readonly<
          Record<InventoryPostingRole, ReasonRequirement>
        >;
        readonly kind: 'postingRoleReasonMap';
      };
    };
    readonly scope: 'legalEntity';
    readonly scopeRationale: string;
    readonly valuesAreReleaseRecorded: true;
    readonly version: 1;
  };
  readonly monetaryBoundary: {
    readonly movementAmountFields: 'forbidden';
    readonly movementDerivedMonetaryArtifacts: 'compileFailure';
    readonly receiptCostOwner: 'G4';
    readonly valuationCapability: 'unsupported';
  };
  readonly movement: {
    readonly fields: readonly {
      readonly fieldId: string;
      readonly immutable: true;
      readonly presence: 'required';
      readonly semantic:
        | 'identifier'
        | 'quantity'
        | 'unit'
        | 'instant'
        | 'sourceType'
        | 'sourceLine'
        | 'postingRole'
        | 'stockDimensionSetVersion';
      readonly valueShape?: Readonly<Record<string, unknown>>;
    }[];
    readonly kind: 'quantityOnlyMovement';
    readonly updatePath: 'none';
  };
  readonly sameInstantTieBreak: {
    readonly configurable: false;
    readonly ordering: readonly [
      'effectiveAt',
      'recordedAt',
      'sourceType',
      'sourceId',
      'sourceLine',
      'postingRole',
      'movementId',
    ];
    readonly rule: 'ascendingCanonicalValueOrder';
    readonly scope: 'global';
  };
  readonly schemaVersion: typeof INVENTORY_CONTRACT_SCHEMA_VERSION;
  readonly stockDimensionSet: {
    readonly dimensions: readonly ['legalEntityId', 'itemId', 'locationId'];
    readonly extension: {
      readonly addition: 'governedVersionedEvent';
      readonly reBaselineOperationId: 'northstar.inventory:operation.re_baseline';
      readonly removal: 'unsupported';
      readonly unspecifiedFromVersion: 2;
    };
    readonly setId: typeof STOCK_DIMENSION_SET_ID;
    readonly v1: {
      readonly allowedVersions: readonly ['v1'];
      readonly membersRequiredAtPosting: true;
      readonly unspecifiedMembers: 'structurallyUnreachable';
    };
  };
  readonly temporal: {
    readonly businessCalendar: {
      readonly businessDayBoundary: 'tenantDeclaredRequired';
      readonly timeZone: 'tenantDeclaredIanaRequired';
      readonly utcDefault: 'forbidden';
    };
    readonly effectiveAt: {
      readonly source: 'operationInput';
    };
    readonly periodLock: {
      readonly advance: {
        readonly audited: true;
        readonly operationId: 'northstar.inventory:operation.advance_period_lock';
        readonly permissionId: 'northstar.inventory:permission.advance_period_lock';
      };
      readonly closedThroughScope: 'legalEntity';
      readonly enforcement: 'insidePostingTransaction';
      readonly reopen: {
        readonly audited: true;
        readonly operationId: 'northstar.inventory:operation.reopen_period';
        readonly permissionId: 'northstar.inventory:permission.reopen_period';
      };
    };
    readonly recordedAt: {
      readonly projectionRetention: 'required';
      readonly source: 'trustedRequestContext';
      readonly updatePath: 'none';
    };
  };
  readonly v2DecimalLimit: {
    readonly canonicalPattern: string;
    readonly fieldShapePermitted: true;
    readonly signedSubUnitExample: '-0.25';
    readonly signedSubUnitValues: 'inexpressibleUntilV3';
  };
}

export interface InventoryPostingConfigurationInputV1 {
  readonly approvalThresholds?: Readonly<
    Record<InventoryPostingRole, string | null>
  >;
  readonly maximumBackdateDays?: number;
  readonly negativeStock?: NegativeStockMode;
  readonly reasonRequirements?: Readonly<
    Record<InventoryPostingRole, ReasonRequirement>
  >;
}

const dependency = (
  dependencyId: string,
  access: InventoryAuthoritativeDependencyV1['access'],
  authority: InventoryAuthoritativeDependencyV1['authority'],
): InventoryAuthoritativeDependencyV1 => ({ access, authority, dependencyId });

const AUTHORITATIVE_DEPENDENCIES = Object.freeze([
  dependency('northstar.context:tenant_id', 'read', 'trustedContext'),
  dependency('northstar.context:environment_id', 'read', 'trustedContext'),
  dependency('northstar.context:actor_id', 'read', 'trustedContext'),
  dependency('northstar.context:recorded_at', 'read', 'trustedContext'),
  dependency('northstar.context:release_id', 'read', 'trustedContext'),
  dependency(
    'northstar.inventory-input:stock_identity',
    'read',
    'operationInput',
  ),
  dependency(
    'northstar.inventory-input:stock_dimension_set_version',
    'read',
    'operationInput',
  ),
  dependency(
    'northstar.inventory-input:quantity_delta',
    'read',
    'operationInput',
  ),
  dependency('northstar.inventory-input:unit_id', 'read', 'operationInput'),
  dependency(
    'northstar.inventory-input:effective_at',
    'read',
    'operationInput',
  ),
  dependency(
    'northstar.inventory-input:source_identity',
    'read',
    'operationInput',
  ),
  dependency(
    'northstar.inventory-input:posting_role',
    'read',
    'operationInput',
  ),
  dependency('northstar.inventory-input:reason', 'read', 'operationInput'),
  dependency('northstar.inventory-input:approval', 'read', 'operationInput'),
  dependency('northstar.catalog:item.base_unit', 'read', 'catalog'),
  dependency('northstar.catalog:item.lifecycle', 'read', 'catalog'),
  dependency('northstar.location:location.lifecycle', 'read', 'location'),
  dependency('northstar.party:legal_entity.lifecycle', 'read', 'party'),
  dependency(
    'northstar.inventory:period_lock.closed_through',
    'read',
    'inventory',
  ),
  dependency('northstar.inventory:posting_configuration', 'read', 'inventory'),
  dependency(
    'northstar.inventory:movement.quantity_delta',
    'read',
    'inventory',
  ),
  dependency(
    'northstar.inventory:transaction.state',
    'transition',
    'inventory',
  ),
  dependency('northstar.inventory:movement', 'append', 'inventory'),
  dependency('northstar.trust:semantic_operation_receipt', 'read', 'trust'),
  dependency('northstar.trust:operation_invocation', 'append', 'trust'),
  dependency('northstar.trust:business_change_document', 'append', 'trust'),
  dependency('northstar.trust:domain_event', 'append', 'trust'),
  dependency('northstar.trust:audit_event', 'append', 'trust'),
  dependency('northstar.trust:outbox_event', 'append', 'trust'),
  dependency('northstar.trust:semantic_operation_receipt', 'append', 'trust'),
]);

const DEFAULT_REASON_REQUIREMENTS = Object.freeze({
  adjustment: 'codeAndNarrative',
  correction: 'codeAndNarrative',
  count: 'codeAndNarrative',
  reBaseline: 'codeAndNarrative',
  transfer: 'codeOnly',
} as const satisfies Record<InventoryPostingRole, ReasonRequirement>);

const DEFAULT_APPROVAL_THRESHOLDS = Object.freeze({
  adjustment: null,
  correction: null,
  count: null,
  reBaseline: null,
  transfer: null,
} as const satisfies Record<InventoryPostingRole, string | null>);

const movementField = (
  fieldId: string,
  semantic: InventoryContractDefinitionV1['movement']['fields'][number]['semantic'],
  valueShape?: Readonly<Record<string, unknown>>,
): InventoryContractDefinitionV1['movement']['fields'][number] => ({
  fieldId,
  immutable: true,
  presence: 'required',
  semantic,
  ...(valueShape ? { valueShape } : {}),
});

/**
 * Freeze J's non-key declarations. This is protocol data only: it contains no
 * storage schema, posting handler, balance implementation, or family map.
 */
export const INVENTORY_CONTRACT_V1 = Object.freeze({
  authoritativeDependencies: {
    accessPlan: AUTHORITATIVE_DEPENDENCIES.map((entry) => ({ ...entry })),
    dependencySetRoot: INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
    dependencies: AUTHORITATIVE_DEPENDENCIES.map((entry) => ({ ...entry })),
    exhaustiveByConstruction: true,
    undeclaredAccess: 'compileFailure',
    version: 1,
  },
  baseUnit: {
    bindingFact: 'firstPostedMovement',
    changeWhenBound: 'reject',
    diagnostic: {
      bindingMovementField: 'movementId',
      code: 'INVENTORY_BASE_UNIT_IMMUTABLE',
    },
    itemFieldId: 'northstar.catalog:field.item_base_unit',
    operationContract: 'namedBaseUnitChange',
  },
  capabilityId: 'northstar.inventory:capability.posting',
  capabilityVersion: 1,
  compiledArtifacts: [
    {
      artifactId: 'northstar.inventory:artifact.movement_read_back',
      outputSemantic: 'fact',
      source: 'inventoryMovement',
    },
    {
      artifactId: 'northstar.inventory:artifact.movement_quantity',
      outputSemantic: 'quantity',
      source: 'inventoryMovement',
    },
  ],
  configuration: {
    dials: {
      approvalThresholds: {
        comparison: 'absoluteQuantityGreaterThan',
        default: DEFAULT_APPROVAL_THRESHOLDS,
        exactBaseUnit: true,
        kind: 'postingRoleExactQuantityMap',
        precision: 38,
        scale: 18,
      },
      maximumBackdateDays: {
        default: 0,
        kind: 'integer',
        maximum: 3650,
        minimum: 0,
      },
      negativeStock: {
        default: 'reject',
        evaluation: 'insidePostingTransactionAgainstSerializedState',
        kind: 'enum',
        values: ['reject', 'allowWithFlag', 'allow'],
      },
      reasonRequirements: {
        default: DEFAULT_REASON_REQUIREMENTS,
        kind: 'postingRoleReasonMap',
      },
    },
    scope: 'legalEntity',
    scopeRationale:
      'Stock authority, period close, approval accountability, and the serialized negative-stock decision are already legal-entity scoped; using the same scope avoids one entity silently imposing its operating posture on another while preserving a trivial single-entity default.',
    valuesAreReleaseRecorded: true,
    version: 1,
  },
  monetaryBoundary: {
    movementAmountFields: 'forbidden',
    movementDerivedMonetaryArtifacts: 'compileFailure',
    receiptCostOwner: 'G4',
    valuationCapability: 'unsupported',
  },
  movement: {
    fields: [
      movementField('movementId', 'identifier'),
      movementField('stockDimensionSetVersion', 'stockDimensionSetVersion', {
        allowedValues: ['v1'],
      }),
      movementField('quantityDelta', 'quantity', {
        precision: 38,
        representation: 'canonicalDecimalStringV2',
        scale: 18,
        signed: true,
        unitFieldId: 'unitId',
      }),
      movementField('unitId', 'unit'),
      movementField('effectiveAt', 'instant'),
      movementField('recordedAt', 'instant'),
      movementField('sourceType', 'sourceType'),
      movementField('sourceId', 'identifier'),
      movementField('sourceLine', 'sourceLine'),
      movementField('postingRole', 'postingRole'),
    ],
    kind: 'quantityOnlyMovement',
    updatePath: 'none',
  },
  sameInstantTieBreak: {
    configurable: false,
    ordering: [
      'effectiveAt',
      'recordedAt',
      'sourceType',
      'sourceId',
      'sourceLine',
      'postingRole',
      'movementId',
    ],
    rule: 'ascendingCanonicalValueOrder',
    scope: 'global',
  },
  schemaVersion: INVENTORY_CONTRACT_SCHEMA_VERSION,
  stockDimensionSet: {
    dimensions: ['legalEntityId', 'itemId', 'locationId'],
    extension: {
      addition: 'governedVersionedEvent',
      reBaselineOperationId: 'northstar.inventory:operation.re_baseline',
      removal: 'unsupported',
      unspecifiedFromVersion: 2,
    },
    setId: STOCK_DIMENSION_SET_ID,
    v1: {
      allowedVersions: ['v1'],
      membersRequiredAtPosting: true,
      unspecifiedMembers: 'structurallyUnreachable',
    },
  },
  temporal: {
    businessCalendar: {
      businessDayBoundary: 'tenantDeclaredRequired',
      timeZone: 'tenantDeclaredIanaRequired',
      utcDefault: 'forbidden',
    },
    effectiveAt: {
      source: 'operationInput',
    },
    periodLock: {
      advance: {
        audited: true,
        operationId: 'northstar.inventory:operation.advance_period_lock',
        permissionId: 'northstar.inventory:permission.advance_period_lock',
      },
      closedThroughScope: 'legalEntity',
      enforcement: 'insidePostingTransaction',
      reopen: {
        audited: true,
        operationId: 'northstar.inventory:operation.reopen_period',
        permissionId: 'northstar.inventory:permission.reopen_period',
      },
    },
    recordedAt: {
      projectionRetention: 'required',
      source: 'trustedRequestContext',
      updatePath: 'none',
    },
  },
  v2DecimalLimit: {
    canonicalPattern: '^(?:0|-[1-9]\\d*|[1-9]\\d*)(?:\\.\\d*[1-9])?$',
    fieldShapePermitted: true,
    signedSubUnitExample: '-0.25',
    signedSubUnitValues: 'inexpressibleUntilV3',
  },
} as const satisfies InventoryContractDefinitionV1);
