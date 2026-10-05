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
  v5: 'v5',
} as const);

export const LEGACY_LANGUAGE_VERSION = LANGUAGE_VERSIONS.experimentalV0;
export const PREVIOUS_LANGUAGE_VERSION = LANGUAGE_VERSIONS.v1;
// Compatibility authority for packages already authored at v2. From v3 on,
// this name is stable and does not mean "latest supported".
export const LANGUAGE_VERSION = LANGUAGE_VERSIONS.v2;
/** The newest readable version. Readable is not the same as adopted. */
export const LATEST_LANGUAGE_VERSION = LANGUAGE_VERSIONS.v5;
/**
 * The version the default compiler profile selects. Moved to v5 by
 * `LANG-ADOPT-v5`, and to v4 by `LANG-ADOPT` before it: adoption is an
 * application-wide artifact event, absorbed exactly once, on the `4c`
 * precedent ("definition was free, only adoption cost"). Every product module
 * declares v5 together, because node-version purity is uniform within a
 * package revision -- a v5 module in a v4 application is refused, and so is
 * the reverse. Historical releases keep the version they were compiled at.
 *
 * THIS CONSTANT IS NOT THE ARTIFACT EVENT, and `LANG-ADOPT-v5` measured that
 * rather than inheriting it. Moving this line and its normalization pair alone
 * leaves `check:app-release` green with byte-identical `app.authored.json` and
 * `app.compiled.json`: the release path takes `languageVersion` from the
 * normalized definition's own bytes (`compile-app-release.ts`
 * `compileNormalizedDefinition`), not from the profile. What mints a lineage
 * entry is the AUTHORED edit -- the six `const version` declarations in
 * `packages/domain/src`. Moving this constant without them is adoption that
 * looks done and is not; moving them without this constant reds the
 * composed-package assertion in `canonical-contracts-purity`.
 */
export const ADOPTED_LANGUAGE_VERSION = LANGUAGE_VERSIONS.v5;
export const SUPPORTED_LANGUAGE_VERSIONS = Object.freeze([
  LEGACY_LANGUAGE_VERSION,
  PREVIOUS_LANGUAGE_VERSION,
  LANGUAGE_VERSION,
  LANGUAGE_VERSIONS.v3,
  LANGUAGE_VERSIONS.v4,
  LANGUAGE_VERSIONS.v5,
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
  v5: 'northstar.normalization/v5',
} as const);

export const LEGACY_NORMALIZATION_PROFILE_VERSION =
  NORMALIZATION_PROFILE_VERSIONS.experimentalV0;
export const PREVIOUS_NORMALIZATION_PROFILE_VERSION =
  NORMALIZATION_PROFILE_VERSIONS.v1;
// Compatibility authority paired with LANGUAGE_VERSION; not the latest reader.
export const NORMALIZATION_PROFILE_VERSION = NORMALIZATION_PROFILE_VERSIONS.v2;
export const LATEST_NORMALIZATION_PROFILE_VERSION =
  NORMALIZATION_PROFILE_VERSIONS.v5;
/** Paired with ADOPTED_LANGUAGE_VERSION; see that constant. */
export const ADOPTED_NORMALIZATION_PROFILE_VERSION =
  NORMALIZATION_PROFILE_VERSIONS.v5;
export const SUPPORTED_NORMALIZATION_PROFILE_VERSIONS = Object.freeze([
  LEGACY_NORMALIZATION_PROFILE_VERSION,
  PREVIOUS_NORMALIZATION_PROFILE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  NORMALIZATION_PROFILE_VERSIONS.v3,
  NORMALIZATION_PROFILE_VERSIONS.v4,
  NORMALIZATION_PROFILE_VERSIONS.v5,
] as const);
export type CanonicalNormalizationProfileVersion =
  (typeof SUPPORTED_NORMALIZATION_PROFILE_VERSIONS)[number];

export interface CanonicalLanguageProfile {
  readonly featureLevel: 'v0-experimental' | 'v1' | 'v2' | 'v3' | 'v4' | 'v5';
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
  [LANGUAGE_VERSIONS.v5]: Object.freeze({
    featureLevel: 'v5',
    normalizationProfileVersion: NORMALIZATION_PROFILE_VERSIONS.v5,
  }),
});

/**
 * Feature levels are cumulative: v4 reads everything v3 reads. Version-gated
 * behaviour asks this question rather than comparing against a single version,
 * so cutting v5 does not silently drop a v3 rule.
 */
export function languageHasV3Features(
  languageVersion: CanonicalLanguageVersion,
): languageVersion is 'v3' | 'v4' | 'v5' {
  const featureLevel =
    CANONICAL_LANGUAGE_PROFILES[languageVersion].featureLevel;
  return (
    featureLevel === 'v3' || featureLevel === 'v4' || featureLevel === 'v5'
  );
}

/** v4 admits the legal-entity query operand; no earlier version does. */
export function languageHasLegalEntityQueryScope(
  languageVersion: CanonicalLanguageVersion,
): languageVersion is 'v4' | 'v5' {
  const featureLevel =
    CANONICAL_LANGUAGE_PROFILES[languageVersion].featureLevel;
  return featureLevel === 'v4' || featureLevel === 'v5';
}

/**
 * v5 materializes each state machine's state field as an ordinary enumeration
 * field on its entity, and retires the parallel `derivedStateField` storage
 * construct ([ADR-0050](../../../docs/decisions/ADR-0050-the-record-transition-carrier.md)).
 *
 * This is the only question any state-field behaviour asks. It is deliberately
 * a feature-level test rather than a comparison against a single version, so
 * cutting v6 does not silently drop the rule -- the same discipline
 * `languageHasV3Features` already documents one function above.
 *
 * The gate is what keeps the cut free: a v4 package normalizes to byte-identical
 * output before and after this change, which is why every recorded release root
 * still reproduces.
 *
 * CUMULATIVE, and it was not. This tested `featureLevel === 'v5'` exactly while
 * its own comment claimed a v6 cut could not drop the rule -- which was false,
 * and is the sixth instance of this packet's named finding: a version written by
 * hand where it was derivable.
 *
 * Its siblings above enumerate their levels, which is why each of them had to be
 * edited by this cut and why one of them was missed. This one asks the ORDERED
 * supported list instead -- "at or after the version that introduced the rule" --
 * so a v6 cut inherits it with no edit, and there is nothing to forget.
 */
export function languageHasMaterializedStateFields(
  languageVersion: CanonicalLanguageVersion,
): boolean {
  const introducedAt = SUPPORTED_LANGUAGE_VERSIONS.indexOf(
    LANGUAGE_VERSIONS.v5,
  );
  const candidate = SUPPORTED_LANGUAGE_VERSIONS.indexOf(languageVersion);
  return introducedAt >= 0 && candidate >= introducedAt;
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
  relationJoinEligibility: 'none' as const,
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

/**
 * The two package-byte ceilings are a v0 structural/performance budget, not a
 * security control: they are outside `limitsDigest`, no request path or storage
 * column depends on them, and raising them only admits more. Raised from
 * 2,097,152 (2 MiB) to 4,194,304 (4 MiB) by STRUCTURAL-LIMITS-RAISE under
 * ADR-0070 (PENDING owner ruling); `canonical-language-v0.md` T10 records the
 * values and `compiler-slos.md` the compile budget re-measured at this size.
 */
export const STRUCTURAL_LIMITS_V0 = Object.freeze({
  maximumAuthoredBytes: 4_194_304,
  maximumNormalizedBytes: 4_194_304,
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

/**
 * Progressive-disclosure tiers, from the `ux-grammar` skill's Disclosure tiers
 * section. The tier distinguishes DEFERRED from HIDDEN: nothing a user should
 * have is ever concealed, and both non-`always` tiers stay discoverable.
 *
 * `onDemand` is READABLE BUT NOT HONOURABLE today, and normalization refuses it
 * by name -- see `CANON_SURFACE_DISCLOSURE_TIER_UNHONOURED`. It means "fetched
 * on expand", which needs a fetch this application cannot make: it is
 * server-rendered, and none of ADR-0036's four authorised client behaviours is
 * a fetch-on-expand. Declaring the value here rather than omitting it keeps the
 * closed set the skill granted intact, while ADR-0041's honour-or-refuse rule
 * keeps it from shipping as a silent alias for `progressive`.
 */
export const DISCLOSURE_TIERS = ['always', 'progressive', 'onDemand'] as const;

/**
 * The tier a slot carries when it declares none. Interpretive, and NEVER
 * materialized into normalized output: `normalize.ts` does not write this value
 * onto a slot that omitted it.
 *
 * Materializing it rewrites every existing normalized definition. MEASURED, on
 * a throwaway mutation: `check:app-release` does not merely move a release root
 * -- it fails earlier and harder, with `COMPILER_INPUT_NOT_CANONICAL` at
 * `decodeSchemaCheck`, because the STORED normalized bytes of a recorded entry
 * no longer round-trip through the changed normalizer. Reproduction never
 * reaches a root comparison at all.
 *
 * The `surfaceRole` precedent is the one to follow -- absent stays absent and is
 * resolved at projection time -- not the `IMMUTABLE_DEFAULTS_V0` precedent,
 * which materializes and is only safe because it predates the recorded lineage.
 */
export const DEFAULT_DISCLOSURE_TIER = 'always' as const;
export type SurfaceArchetype = (typeof SURFACE_ARCHETYPES)[number];
export type SurfaceSlot = (typeof SURFACE_SLOTS)[SurfaceArchetype][number];
export type DisclosureTier = (typeof DISCLOSURE_TIERS)[number];
