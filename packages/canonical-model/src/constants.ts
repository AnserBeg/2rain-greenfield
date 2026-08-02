/**
 * Stable, append-only language identifiers. Adding a reader appends a named
 * entry and a supported-list member; it never renames an existing version.
 */
export const LANGUAGE_VERSIONS = Object.freeze({
  experimentalV0: 'v0-experimental',
  v1: 'v1',
  v2: 'v2',
  v3: 'v3',
  v4: 'v4',
} as const);

export const LEGACY_LANGUAGE_VERSION = LANGUAGE_VERSIONS.experimentalV0;
export const PREVIOUS_LANGUAGE_VERSION = LANGUAGE_VERSIONS.v1;
// Compatibility authority for packages already authored at v2. From v3 on,
// this name is stable and does not mean "latest supported".
export const LANGUAGE_VERSION = LANGUAGE_VERSIONS.v2;
/** The newest readable version. Readable is not the same as adopted. */
export const LATEST_LANGUAGE_VERSION = LANGUAGE_VERSIONS.v4;
/**
 * The version the default compiler profile selects. Moved to v4 by the
 * LANG-ADOPT packet: adoption is an application-wide artifact event, absorbed
 * exactly once, on the `4c` precedent ("definition was free, only adoption
 * cost"). Every product module declares v4 together, because node-version
 * purity is uniform within a package revision -- a v4 module in a v3
 * application is refused, and so is the reverse. Historical releases keep the
 * version they were compiled at.
 */
export const ADOPTED_LANGUAGE_VERSION = LANGUAGE_VERSIONS.v4;
export const SUPPORTED_LANGUAGE_VERSIONS = Object.freeze([
  LEGACY_LANGUAGE_VERSION,
  PREVIOUS_LANGUAGE_VERSION,
  LANGUAGE_VERSION,
  LANGUAGE_VERSIONS.v3,
  LANGUAGE_VERSIONS.v4,
] as const);
export type CanonicalLanguageVersion =
  (typeof SUPPORTED_LANGUAGE_VERSIONS)[number];

/** Stable, append-only normalization-profile identifiers. */
export const NORMALIZATION_PROFILE_VERSIONS = Object.freeze({
  experimentalV0: 'northstar.normalization/v0-experimental',
  v1: 'northstar.normalization/v1',
  v2: 'northstar.normalization/v2',
  v3: 'northstar.normalization/v3',
  v4: 'northstar.normalization/v4',
} as const);

export const LEGACY_NORMALIZATION_PROFILE_VERSION =
  NORMALIZATION_PROFILE_VERSIONS.experimentalV0;
export const PREVIOUS_NORMALIZATION_PROFILE_VERSION =
  NORMALIZATION_PROFILE_VERSIONS.v1;
// Compatibility authority paired with LANGUAGE_VERSION; not the latest reader.
export const NORMALIZATION_PROFILE_VERSION = NORMALIZATION_PROFILE_VERSIONS.v2;
export const LATEST_NORMALIZATION_PROFILE_VERSION =
  NORMALIZATION_PROFILE_VERSIONS.v4;
/** Paired with ADOPTED_LANGUAGE_VERSION; see that constant. */
export const ADOPTED_NORMALIZATION_PROFILE_VERSION =
  NORMALIZATION_PROFILE_VERSIONS.v4;
export const SUPPORTED_NORMALIZATION_PROFILE_VERSIONS = Object.freeze([
  LEGACY_NORMALIZATION_PROFILE_VERSION,
  PREVIOUS_NORMALIZATION_PROFILE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  NORMALIZATION_PROFILE_VERSIONS.v3,
  NORMALIZATION_PROFILE_VERSIONS.v4,
] as const);
export type CanonicalNormalizationProfileVersion =
  (typeof SUPPORTED_NORMALIZATION_PROFILE_VERSIONS)[number];

export interface CanonicalLanguageProfile {
  readonly featureLevel: 'v0-experimental' | 'v1' | 'v2' | 'v3' | 'v4';
  readonly normalizationProfileVersion: CanonicalNormalizationProfileVersion;
}

/**
 * Strict language/profile dispatch. v3 adds version-gated canonical families
 * and query nodes while retaining every prior reader unchanged; v4 adds the
 * legal-entity query operand on top of every v3 reader.
 */
export const CANONICAL_LANGUAGE_PROFILES: Readonly<
  Record<CanonicalLanguageVersion, CanonicalLanguageProfile>
> = Object.freeze({
  [LEGACY_LANGUAGE_VERSION]: Object.freeze({
    featureLevel: 'v0-experimental',
    normalizationProfileVersion: LEGACY_NORMALIZATION_PROFILE_VERSION,
  }),
  [PREVIOUS_LANGUAGE_VERSION]: Object.freeze({
    featureLevel: 'v1',
    normalizationProfileVersion: PREVIOUS_NORMALIZATION_PROFILE_VERSION,
  }),
  [LANGUAGE_VERSION]: Object.freeze({
    featureLevel: 'v2',
    normalizationProfileVersion: NORMALIZATION_PROFILE_VERSION,
  }),
  [LANGUAGE_VERSIONS.v3]: Object.freeze({
    featureLevel: 'v3',
    normalizationProfileVersion: NORMALIZATION_PROFILE_VERSIONS.v3,
  }),
  [LANGUAGE_VERSIONS.v4]: Object.freeze({
    featureLevel: 'v4',
    normalizationProfileVersion: NORMALIZATION_PROFILE_VERSIONS.v4,
  }),
});

/**
 * Feature levels are cumulative: v4 reads everything v3 reads. Version-gated
 * behaviour asks this question rather than comparing against a single version,
 * so cutting v5 does not silently drop a v3 rule.
 */
export function languageHasV3Features(
  languageVersion: CanonicalLanguageVersion,
): languageVersion is 'v3' | 'v4' {
  const featureLevel =
    CANONICAL_LANGUAGE_PROFILES[languageVersion].featureLevel;
  return featureLevel === 'v3' || featureLevel === 'v4';
}

/** v4 admits the legal-entity query operand; no earlier version does. */
export function languageHasLegalEntityQueryScope(
  languageVersion: CanonicalLanguageVersion,
): languageVersion is 'v4' {
  return CANONICAL_LANGUAGE_PROFILES[languageVersion].featureLevel === 'v4';
}

export function canonicalLanguageProfileFor(
  languageVersion: CanonicalLanguageVersion,
): CanonicalLanguageProfile {
  return CANONICAL_LANGUAGE_PROFILES[languageVersion];
}
export const CANONICALIZATION_PROFILE_VERSION =
  'northstar.canonical-json/v0-experimental' as const;
export const CONTENT_HASH_ALGORITHM = 'sha256' as const;
export const CONTENT_HASH_DOMAIN =
  'northstar.app-package.normalized/v0-experimental' as const;

export const PROMOTE_STORAGE_CLASS_CAPABILITY_ID =
  'northstar.storage:capability.promote-storage-class' as const;

export const CURRENCY_PROFILE_VERSION =
  'northstar.currency-minor-units/v0-experimental' as const;

// Freeze A admits only the currencies evidenced by the Canadian launch corpus:
// CAD as the base currency and USD for routine cross-border purchasing. Adding a
// currency or changing a minor unit is language evolution, not ambient Intl data.
export const CURRENCY_MINOR_UNITS_V0 = Object.freeze({
  CAD: 2,
  USD: 2,
} as const);

export const IMMUTABLE_DEFAULTS_V0 = Object.freeze({
  lifecycle: 'active' as const,
  presence: 'optional' as const,
  reportable: false,
  searchable: false,
  terminal: false,
  relationRequired: false,
  queryFilter: Object.freeze({
    kind: 'booleanPredicate' as const,
    schemaVersion: LANGUAGE_VERSION,
    value: true,
  }),
  operationPrecondition: Object.freeze({
    kind: 'booleanPredicate' as const,
    schemaVersion: LANGUAGE_VERSION,
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
    impactAnalyses: 4_096,
  }),
});

export const QUERY_PARAMETER_LIMIT_V3 = 64 as const;

export const SURFACE_ARCHETYPES = [
  'home',
  'list',
  'record',
  'task',
  'builder',
] as const;

/**
 * Exact per-archetype anatomy: every listed slot is allowed and required
 * exactly once. Canonical normalization currently enforces only the
 * closed/at-most-once half; the product conformance ratchet observes the
 * required floor until G2-P5d burns down the admitted module debt.
 */
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
