export const LANGUAGE_VERSION = 'v0-experimental' as const;
export const NORMALIZATION_PROFILE_VERSION =
  'northstar.normalization/v0-experimental' as const;
export const CANONICALIZATION_PROFILE_VERSION =
  'northstar.canonical-json/v0-experimental' as const;
export const CONTENT_HASH_ALGORITHM = 'sha256' as const;
export const CONTENT_HASH_DOMAIN =
  'northstar.app-package.normalized/v0-experimental' as const;

export const IMMUTABLE_DEFAULTS_V0 = Object.freeze({
  lifecycle: 'active' as const,
  presence: 'optional' as const,
  reportable: false,
  searchable: false,
  terminal: false,
  relationRequired: false,
  relationJoinEligibility: 'none' as const,
  queryFilter: Object.freeze({
    kind: 'booleanPredicate' as const,
    value: true,
  }),
  operationPrecondition: Object.freeze({
    kind: 'booleanPredicate' as const,
    value: true,
  }),
});

export const STRUCTURAL_LIMITS_V0 = Object.freeze({
  maximumAuthoredBytes: 2_097_152,
  maximumNormalizedBytes: 2_097_152,
  maximumCollectionCount: 4_096,
  maximumExpressionDepth: 24,
  maximumStringScalars: 4_000,
  families: Object.freeze({
    modules: 64,
    entities: 256,
    fields: 4_096,
    relations: 2_048,
    stateMachines: 256,
    surfaces: 512,
    queries: 1_024,
    operations: 1_024,
    permissions: 2_048,
    assertions: 4_096,
    storageMappings: 256,
    capabilityRequirements: 512,
  }),
});

export const SURFACE_ARCHETYPES = [
  'home',
  'list',
  'record',
  'task',
  'builder',
] as const;

export const SURFACE_SLOTS = Object.freeze({
  home: ['exceptions', 'setupChecklist'],
  list: ['title', 'savedViews', 'dataGrid', 'bulkActions'],
  record: [
    'breadcrumb',
    'titleStatus',
    'commandBar',
    'keyFacts',
    'sections',
    'childTables',
    'activity',
  ],
  task: ['decision', 'scanInput', 'primaryAction'],
  builder: [
    'modeSwitch',
    'selection',
    'properties',
    'draftBanner',
    'publishDiff',
  ],
} as const);

export const STATUS_ROLES = [
  'success',
  'attention',
  'blocked',
  'inProgress',
] as const;

export type SurfaceArchetype = (typeof SURFACE_ARCHETYPES)[number];
export type SurfaceSlot = (typeof SURFACE_SLOTS)[SurfaceArchetype][number];
