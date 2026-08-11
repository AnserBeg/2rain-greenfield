import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanonicalModelError,
  LANGUAGE_VERSIONS,
  LATEST_LANGUAGE_VERSION,
  LEGAL_ENTITY_SCOPE_PROFILE_VERSION,
  canonicalAuthoredProjection,
  canonicalize,
  canonicalizeAndHash,
  evaluateLegalEntityScopeSelection,
  languageHasLegalEntityQueryScope,
  normalizeApplicationPackage,
  parseAuthoredApplicationPackageJson,
  parseVersionedAuthoredApplicationPackageJson,
  VersionedAuthoredApplicationPackageSchema,
  VersionedNormalizedApplicationPackageSchema,
  ADOPTED_LANGUAGE_VERSION,
  ADOPTED_NORMALIZATION_PROFILE_VERSION,
  type LegalEntityScopeSelectionReceipt,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
} from '../../packages/compiler/src/index.js';

import { registeredSemanticQueryFromPinnedView } from '../../packages/runtime/src/semantic-query-gateway.js';

import { compilerInput, mustCompile, projectionPayload } from './helpers.js';
import { V3_AGGREGATE_IDS, v3AggregateModule } from './v3-definition.js';
import {
  V4_SCOPE_IDS,
  adoptedScopedModule,
  legalEntityScope,
  parameterDefinition,
  requireQuery,
  v4ScopedModule,
  v4UnscopedModule,
} from './v4-definition.js';

const ENTITY_A = '5a2b6f10-9c31-4d8e-b7a4-1f0c2d3e4a5b';
const ENTITY_B = '7c4d8e20-1a53-4f6b-9d82-3e5a7c9b1d0f';

type CatalogQuery = Record<string, unknown> & { queryId: string };
type NormalizedQuery = {
  legalEntityScope?: { cardinality: string };
  parameters?: { parameterId: string; parameterType: unknown }[];
  queryId: string;
};
type QueryCatalog = { queries: CatalogQuery[] };

function normalizedBytesFor(definition: unknown): Uint8Array {
  return new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(definition)),
  );
}

function catalogQuery(definition: unknown, queryId: string): CatalogQuery {
  const compiled = mustCompile(compilerInput(normalizedBytesFor(definition)));
  const catalog = projectionPayload<QueryCatalog>(
    compiled,
    PROJECTION_FAMILY_IDS.queryCatalog,
  );
  const query = catalog.queries.find(
    (candidate) => candidate.queryId === queryId,
  );
  assert.ok(query, `compiled catalog is missing ${queryId}`);
  return query;
}

function rejectionReason(receipt: LegalEntityScopeSelectionReceipt): string {
  assert.equal(receipt.outcome, 'rejected');
  return receipt.outcome === 'rejected' ? receipt.reason : '';
}

function diagnosticCodes(action: () => unknown): string[] {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof CanonicalModelError);
    return error.diagnostics.map((entry) => entry.code);
  }
  throw new Error('expected the canonical model to refuse this document');
}

// THE ADR-0021 CONTROL. Adding a spelling to a released version retroactively
// widens it, so the member must be unreachable at v3. The victim is the absence
// of `legalEntityScope` from `normalizedV3RowQueryDefinition` and
// `normalizedAggregateQueryDefinition` in schemas.ts: adding the optional
// member to either v3 shape, or relaxing either `z.strictObject` to a loose
// object, turns both refusals below into silent acceptance.
test('a v3 document carrying legalEntityScope is rejected on both query branches', () => {
  const v3Aggregate = v3AggregateModule() as {
    queries: Array<Record<string, unknown>>;
  };
  const aggregate = requireQuery(
    v3Aggregate as never,
    V3_AGGREGATE_IDS.aggregateQuery,
  );
  (aggregate.parameters as Record<string, unknown>[]).push(
    parameterDefinition(
      V4_SCOPE_IDS.aggregateScopeParameter,
      30,
      LANGUAGE_VERSIONS.v3,
    ),
  );
  aggregate.legalEntityScope = legalEntityScope(
    'exactlyOne',
    V4_SCOPE_IDS.aggregateScopeParameter,
    LANGUAGE_VERSIONS.v3,
  );
  assert.ok(
    diagnosticCodes(() => normalizeApplicationPackage(v3Aggregate)).includes(
      'CANON_SCHEMA_INVALID',
    ),
    'v3 admitted the v4 aggregate operand',
  );

  const v3Row = v3AggregateModule() as {
    queries: Array<Record<string, unknown>>;
  };
  const row = requireQuery(v3Row as never, V4_SCOPE_IDS.rowQuery);
  row.parameters = [
    parameterDefinition(
      V4_SCOPE_IDS.rowScopeParameter,
      10,
      LANGUAGE_VERSIONS.v3,
    ),
  ];
  row.legalEntityScope = legalEntityScope(
    'nonEmptySet',
    V4_SCOPE_IDS.rowScopeParameter,
    LANGUAGE_VERSIONS.v3,
  );
  assert.ok(
    diagnosticCodes(() => normalizeApplicationPackage(v3Row)).includes(
      'CANON_SCHEMA_INVALID',
    ),
    'v3 admitted the v4 row operand',
  );

  // Negative control for the control: the identical documents at v4 normalize.
  // Without this, deleting the member from v4 entirely would leave both
  // refusals above green while the packet shipped nothing.
  assert.doesNotThrow(() => normalizeApplicationPackage(v4ScopedModule()));
});

/**
 * REVIEW FINDING 1. The v3 family's node schemas admit `v3` and `v4`, so
 * version purity is not a schema property. Before this control the PUBLIC
 * authored parsers accepted a v3 package carrying a v4 node — a document every
 * prior reader rejected — and only `normalizeApplicationPackage` caught it.
 * Accepting it at the parser is retroactive widening even though
 * `legalEntityScope` itself stayed rejected.
 *
 * Victim: the `assertNodeVersionPurity` call in `parseAuthoredValue`
 * (normalize.ts). Deleting it makes the parse below succeed.
 */
test('the exported versioned schemas reject a v3 package carrying a v4 node', () => {
  // The EXPORTED SCHEMAS are public readers in their own right. Round 1 fixed
  // only the function parsers, which left this path open — every entry point
  // without its own guard was a hole, so purity now lives on the schema and
  // there is one authority instead of a guard per caller.
  const authored = v3AggregateModule() as {
    queries: Array<Record<string, unknown>>;
  };
  const cleanAuthored = structuredClone(authored);
  authored.queries[0]!.schemaVersion = LANGUAGE_VERSIONS.v4;
  assert.equal(
    VersionedAuthoredApplicationPackageSchema.safeParse(authored).success,
    false,
  );
  assert.equal(
    VersionedAuthoredApplicationPackageSchema.safeParse(cleanAuthored).success,
    true,
  );

  const normalized = normalizeApplicationPackage(cleanAuthored) as unknown as {
    queries: Array<Record<string, unknown>>;
  };
  const mixedNormalized = structuredClone(normalized);
  mixedNormalized.queries[0]!.schemaVersion = LANGUAGE_VERSIONS.v4;
  assert.equal(
    VersionedNormalizedApplicationPackageSchema.safeParse(mixedNormalized)
      .success,
    false,
  );
  assert.equal(
    VersionedNormalizedApplicationPackageSchema.safeParse(normalized).success,
    true,
  );

  // A whole v4 package is admitted, so the guard refuses MIXING, not v4.
  assert.equal(
    VersionedAuthoredApplicationPackageSchema.safeParse(v4ScopedModule())
      .success,
    true,
  );
});

test('the authored parsers reject a v3 package carrying a v4 node', () => {
  const mixed = v3AggregateModule() as {
    queries: Array<Record<string, unknown>>;
  };
  mixed.queries[0]!.schemaVersion = LANGUAGE_VERSIONS.v4;
  const wire = canonicalize(mixed);
  for (const parse of [
    parseAuthoredApplicationPackageJson,
    parseVersionedAuthoredApplicationPackageJson,
  ]) {
    assert.ok(
      diagnosticCodes(() => parse(wire)).includes('CANON_VERSION_MIXED'),
      parse.name,
    );
  }
  // The unmixed document still parses, so the guard refuses mixing rather
  // than refusing v4.
  assert.doesNotThrow(() =>
    parseVersionedAuthoredApplicationPackageJson(
      canonicalize(v4ScopedModule()),
    ),
  );
});

// Victim: `v4NormalizedShape`/`v4AuthoredShape` in schemas.ts and the v4 entry
// in CANONICAL_LANGUAGE_PROFILES. Deleting either makes v4 unreadable and this
// normalization throws CANON_VERSION_UNSUPPORTED.
test('v4 normalizes, derives the operand parameter type, and round-trips', () => {
  const normalized = normalizeApplicationPackage(v4ScopedModule());
  assert.equal(normalized.languageVersion, LANGUAGE_VERSIONS.v4);
  assert.equal(
    normalized.normalizationProfileVersion,
    'northstar.normalization/v4',
  );

  const queries = normalized.queries as unknown as NormalizedQuery[];
  const aggregate = queries.find(
    (query) => query.queryId === V3_AGGREGATE_IDS.aggregateQuery,
  );
  assert.equal(aggregate?.legalEntityScope?.cardinality, 'exactlyOne');
  const row = queries.find((query) => query.queryId === V4_SCOPE_IDS.rowQuery);
  assert.equal(row?.legalEntityScope?.cardinality, 'nonEmptySet');

  // The operand's type is derived, never authored: an author cannot assert a
  // second, disagreeing type for the same argument.
  const scopeParameter = row?.parameters?.find(
    (parameter) => parameter.parameterId === V4_SCOPE_IDS.rowScopeParameter,
  );
  assert.deepEqual(scopeParameter?.parameterType, {
    kind: 'legalEntityReferenceParameterType',
    schemaVersion: 'v4',
  });

  // Normalized authority equals the normalization of its authored projection.
  assert.equal(
    canonicalizeAndHash(normalizeApplicationPackage(v4ScopedModule()))
      .contentHash,
    canonicalizeAndHash(normalized).contentHash,
  );
});

// Victim: the scope-operand branch of `deriveQueryParameterTypes` in
// normalize.ts. Deleting the unresolved-operand push, or the conflict push,
// leaves a query whose declared operand names nothing or names two things.
test('v4 refuses an unresolved, conflicting, or unused scope operand', () => {
  const unresolved = v4ScopedModule();
  requireQuery(unresolved, V4_SCOPE_IDS.rowQuery).legalEntityScope =
    legalEntityScope('nonEmptySet', `${V4_SCOPE_IDS.rowScopeParameter}_absent`);
  assert.ok(
    diagnosticCodes(() => normalizeApplicationPackage(unresolved)).includes(
      'CANON_QUERY_PARAMETER_UNRESOLVED',
    ),
  );

  // One parameter cannot be both the scope operand and a filter comparison
  // operand: the two positions imply different argument types.
  const conflicting = v4ScopedModule();
  const aggregate = requireQuery(conflicting, V3_AGGREGATE_IDS.aggregateQuery);
  aggregate.legalEntityScope = legalEntityScope(
    'exactlyOne',
    V3_AGGREGATE_IDS.stockParameter,
  );
  assert.ok(
    diagnosticCodes(() => normalizeApplicationPackage(conflicting)).includes(
      'CANON_QUERY_LEGAL_ENTITY_SCOPE_PARAMETER_CONFLICT',
    ),
  );

  const unused = v4ScopedModule();
  delete requireQuery(unused, V4_SCOPE_IDS.rowQuery).legalEntityScope;
  assert.ok(
    diagnosticCodes(() => normalizeApplicationPackage(unused)).includes(
      'CANON_QUERY_PARAMETER_UNUSED',
    ),
  );
});

// Victim: `legalEntityScopeCatalogEntry` and `queryParameterCatalogEntries` in
// projections.ts, and their two call sites in the version-aware decoration in
// compiler.ts. Deleting any of them compiles a query whose scope requirement is
// invisible to every reader of the catalog — which is exactly the state that
// made the read scope unreachable in the first place.
test('the compiled query catalog carries the operand on both branches', () => {
  const aggregate = catalogQuery(
    v4ScopedModule(),
    V3_AGGREGATE_IDS.aggregateQuery,
  );
  assert.deepEqual(aggregate.legalEntityScope, {
    cardinality: 'exactlyOne',
    kind: 'queryLegalEntityScope',
    operand: {
      kind: 'queryParameterReference',
      parameterId: V4_SCOPE_IDS.aggregateScopeParameter,
      schemaVersion: 'v4',
    },
    schemaVersion: 'v4',
  });

  const row = catalogQuery(v4ScopedModule(), V4_SCOPE_IDS.rowQuery);
  assert.equal(
    (row.legalEntityScope as { cardinality: string }).cardinality,
    'nonEmptySet',
  );
  assert.deepEqual(row.parameters, [
    {
      orderKey: 10,
      parameterId: V4_SCOPE_IDS.rowScopeParameter,
      parameterType: {
        kind: 'legalEntityReferenceParameterType',
        schemaVersion: 'v4',
      },
    },
  ]);

  // Absent member means the query declares no operand. It never means "all",
  // and the compiler must not invent one.
  const unscoped = catalogQuery(v4UnscopedModule(), V4_SCOPE_IDS.rowQuery);
  assert.equal(Object.hasOwn(unscoped, 'legalEntityScope'), false);
});

// Victim: the `cardinality === 'exactlyOne'` array branch and the
// `selection.length === 0` branch of evaluateLegalEntityScopeSelection in
// legal-entity-scope-kernel.ts. These are the two refusals the packet names.
test('exactlyOne refuses a set and nonEmptySet refuses an empty selection', () => {
  const evaluate = (
    cardinality: 'exactlyOne' | 'nonEmptySet',
    selection: unknown,
  ) =>
    evaluateLegalEntityScopeSelection({
      cardinality,
      profileVersion: LEGAL_ENTITY_SCOPE_PROFILE_VERSION,
      selection,
    });

  assert.deepEqual(evaluate('exactlyOne', [ENTITY_A]), {
    kind: 'legalEntityScopeSelectionReceipt',
    outcome: 'rejected',
    reason: 'set-selection-for-exactly-one',
    schemaVersion: 'northstar.query-legal-entity-scope-kernel-receipt/v1',
  });
  assert.equal(rejectionReason(evaluate('nonEmptySet', [])), 'empty-selection');

  // Positive controls, so neither refusal above can pass by refusing
  // everything.
  const one = evaluate('exactlyOne', ENTITY_A);
  assert.equal(one.outcome, 'accepted');
  assert.deepEqual(one.outcome === 'accepted' ? one.members : null, [ENTITY_A]);
  const many = evaluate('nonEmptySet', [ENTITY_B, ENTITY_A]);
  assert.equal(many.outcome, 'accepted');
  assert.deepEqual(many.outcome === 'accepted' ? many.members : null, [
    ENTITY_A,
    ENTITY_B,
  ]);

  // Omission is a refusal, not "all" and not a narrower scope. This is the
  // false-zero path the whole operand exists to close.
  assert.equal(
    rejectionReason(evaluate('nonEmptySet', undefined)),
    'selection-omitted',
  );
  assert.equal(
    rejectionReason(evaluate('exactlyOne', null)),
    'selection-omitted',
  );

  // A scalar is not a one-member set, a duplicate is not collapsed, and a
  // non-canonical member is not repaired.
  for (const [cardinality, selection, reason] of [
    ['nonEmptySet', ENTITY_A, 'scalar-selection-for-non-empty-set'],
    ['nonEmptySet', [ENTITY_A, ENTITY_A], 'duplicate-member'],
    ['nonEmptySet', [ENTITY_A.toUpperCase()], 'invalid-member'],
    ['exactlyOne', 'not-a-uuid', 'invalid-member'],
    ['nonEmptySet', [ENTITY_A, 42], 'invalid-member'],
  ] as const) {
    assert.equal(
      rejectionReason(evaluate(cardinality, selection)),
      reason,
      `${cardinality} ${JSON.stringify(selection)}`,
    );
  }

  // An unreadable request never yields an accepted receipt.
  assert.equal(
    evaluateLegalEntityScopeSelection({
      cardinality: 'exactlyOne',
      profileVersion: 'northstar.query-legal-entity-scope-profile/v0',
      selection: ENTITY_A,
    }).outcome,
    'rejected',
  );
  assert.equal(
    evaluateLegalEntityScopeSelection({
      cardinality: 'everyEntity',
      profileVersion: LEGAL_ENTITY_SCOPE_PROFILE_VERSION,
      selection: ENTITY_A,
    }).outcome,
    'rejected',
  );
});

// Victim: `ADOPTED_LANGUAGE_VERSION` and the DEFAULT_COMPILER_PROFILE key in
// compiler.ts:111. Pointing the default profile at the latest readable version
// instead migrates every package to v4 and moves every root.
test('cutting v4 leaves v3 output byte-identical', () => {
  // Observed directly, because test/compiler/helpers.ts derives its profile
  // from the package and would never notice this constant moving. The first
  // run of this control missed exactly that and passed while the default
  // profile pointed at v4.
  assert.equal(
    DEFAULT_COMPILER_PROFILE.languageVersion,
    ADOPTED_LANGUAGE_VERSION,
  );
  assert.equal(
    DEFAULT_COMPILER_PROFILE.normalizationProfileVersion,
    ADOPTED_NORMALIZATION_PROFILE_VERSION,
  );

  const v3 = normalizedBytesFor(v3AggregateModule());
  // The unmodified default profile still compiles an ADOPTED-version package.
  // Using an unadopted-version module here would assert the opposite of this
  // control, so the fixture must FOLLOW adoption rather than name a version.
  //
  // It named `v4ScopedModule()`, which was the adopted-version fixture for
  // exactly one adoption cycle. `LANG-ADOPT-v5` moved adoption to v5 and this
  // arm went red as `failed` -- node-version purity refusing a v4 package under
  // a v5 profile -- while the v3 freeze it guards had not moved at all. That is
  // the `LANG-ADOPT` (v4) row's recorded latent firing: a fixture that passes
  // only because module and adopted version coincide.
  //
  // The precondition is named rather than assumed: this fixture carries a
  // legal-entity scope operand, which no version before v4 declares.
  assert.equal(
    languageHasLegalEntityQueryScope(ADOPTED_LANGUAGE_VERSION),
    true,
  );
  assert.equal(
    compileApplication({
      dependencies: [],
      expectedActiveRelease: null,
      kind: 'compilerInput',
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes: normalizedBytesFor(adoptedScopedModule()),
      profile: { ...DEFAULT_COMPILER_PROFILE },
    }).status,
    'compiled',
  );
  // Frozen expected digest, measured on BOTH sides of the v4 adoption boundary
  // and found identical: pre-adoption main and this branch both produce
  // 921ee278... Comparing two fresh compiles to each other, as this control did
  // before, proves DETERMINISM, not identity with the pre-v4 output -- a
  // deterministic change to the v3 manifest would move both and stay green.
  // Re-derived by proj-disc-impl when compiler-semantic profile v1 was
  // adopted (ADR-0047). This pin guards the LANGUAGE axis, and the v3 language
  // output did not move: recompiling this fixture at an EXPLICIT
  // `northstar.compiler-semantic/v0-experimental` still produces 921ee278...,
  // the pre-adoption value. `compilerInput` spreads DEFAULT_COMPILER_PROFILE,
  // so the digest here now reflects the adopted profile. Measured field by
  // field, exactly three keys move and all three are profile-derived:
  // `compilerSemanticProfileVersion`, `semanticProfileDigest` (the whole
  // profile hashed) and `cacheInputDigest` (which folds in that digest).
  // Every projection reference, artifact and payload field is unchanged.
  const V3_RELEASE_MANIFEST_DIGEST =
    'aac9f52d2fe2fa592ec9df1a04f66d6d6ac4929f4b00ca047533bd7c9e5adce5';
  const before = canonicalizeAndHash(
    mustCompile(compilerInput(v3)).bundle.releaseManifest,
  ).contentHash;
  const again = canonicalizeAndHash(
    mustCompile(compilerInput(v3)).bundle.releaseManifest,
  ).contentHash;
  assert.equal(before, again);
  assert.equal(before, V3_RELEASE_MANIFEST_DIGEST);

  const manifest = mustCompile(compilerInput(v3)).bundle.releaseManifest;
  assert.equal(manifest.languageVersion, LANGUAGE_VERSIONS.v3);
  assert.equal(
    manifest.normalizationProfileVersion,
    'northstar.normalization/v3',
  );

  // A v4 package stamps v4, so the manifest dispatch is version-derived rather
  // than a hardcoded v3 that happens to be right.
  const v4Manifest = mustCompile(
    compilerInput(normalizedBytesFor(v4ScopedModule())),
  ).bundle.releaseManifest;
  assert.equal(v4Manifest.languageVersion, LANGUAGE_VERSIONS.v4);
  assert.equal(
    v4Manifest.normalizationProfileVersion,
    'northstar.normalization/v4',
  );
  assert.notEqual(v4Manifest.languageVersion, manifest.languageVersion);
});

/**
 * The legal-entity reference parameter type is MINTED by normalization, not
 * authored, and `CANON_VERSION_MIXED` refuses any node whose version disagrees
 * with the package envelope. A literal version on that node therefore makes
 * every LATER language version unnormalizable the moment it carries a scope
 * operand -- silently, and only for that one shape.
 *
 * This control exists because three separate version predicates were exercised
 * by the v5 cut and none of them could see this: a v5 package WITHOUT
 * `legalEntityScope` normalizes perfectly. The shape has to be present for the
 * defect to exist, so the control carries it.
 *
 * It is written against `LATEST_LANGUAGE_VERSION` rather than a literal, so the
 * next cut inherits the coverage instead of re-opening the same hole.
 */
test('a scope operand derives its parameter type at the package version, not a pinned one', () => {
  const latest = LATEST_LANGUAGE_VERSION;
  const scoped = replaceLanguageVersion(
    v4ScopedModule(),
    LANGUAGE_VERSIONS.v4,
    latest,
  ) as Record<string, unknown>;
  scoped.normalizationProfileVersion = `northstar.normalization/${latest}`;

  // 1. It normalizes at all. Before the fix this threw CANON_VERSION_MIXED.
  const normalized = normalizeApplicationPackage(scoped) as {
    languageVersion: string;
    queries: NormalizedQuery[];
  };
  assert.equal(normalized.languageVersion, latest);

  // 2. The derived node carries the PACKAGE's version.
  const row = normalized.queries.find(
    (query) => query.queryId === V4_SCOPE_IDS.rowQuery,
  );
  const scopeParameter = row?.parameters?.find(
    (parameter) => parameter.parameterId === V4_SCOPE_IDS.rowScopeParameter,
  );
  assert.deepEqual(scopeParameter?.parameterType, {
    kind: 'legalEntityReferenceParameterType',
    schemaVersion: latest,
  });

  // 3. Authored projection and renormalization reproduce identical bytes, so
  // the derived node round-trips rather than merely parsing once.
  const projected = canonicalAuthoredProjection(
    normalized as Parameters<typeof canonicalAuthoredProjection>[0],
  );
  assert.equal(
    canonicalize(normalizeApplicationPackage(projected)),
    canonicalize(normalized),
  );
});

function replaceLanguageVersion(
  value: unknown,
  from: string,
  to: string,
): unknown {
  if (typeof value === 'string') return value === from ? to : value;
  if (Array.isArray(value)) {
    return value.map((entry) => replaceLanguageVersion(entry, from, to));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceLanguageVersion(entry, from, to),
      ]),
    );
  }
  return value;
}

/**
 * The normalization control above stops at the canonical model. It cannot see
 * the four version literals that lived in the RUNTIME's reader, and those were
 * the dangerous half: a v5 scoped query normalized, compiled, and was then
 * refused by `registeredSemanticQueryFromPinnedView` as a malformed pinned
 * catalog -- an admitter literal failing closed three layers from its cause.
 *
 * So this one presents the COMPILED catalog to the real gateway reader. It is
 * the shape the earlier control could not reach, and it is why "we added a
 * control" was not the same as "the path is covered".
 */
test('a compiled v5 scoped query is admitted by the runtime catalog reader', () => {
  const latest = LATEST_LANGUAGE_VERSION;
  const scoped = replaceLanguageVersion(
    v4ScopedModule(),
    LANGUAGE_VERSIONS.v4,
    latest,
  ) as Record<string, unknown>;
  scoped.normalizationProfileVersion = `northstar.normalization/${latest}`;

  const compiled = mustCompile(compilerInput(normalizedBytesFor(scoped)));
  const catalog = projectionPayload<QueryCatalog>(
    compiled,
    PROJECTION_FAMILY_IDS.queryCatalog,
  );
  const view = {
    projections: {
      query: {
        familyId: 'northstar.compiler:projection-family.query-catalog',
        payloadSchemaVersion: 'northstar.query-catalog-payload/v0-provisional',
        payload: catalog,
      },
    },
  } as unknown as Parameters<typeof registeredSemanticQueryFromPinnedView>[0];

  const registered = registeredSemanticQueryFromPinnedView(
    view,
    V4_SCOPE_IDS.rowQuery,
  );
  assert.ok(
    registered,
    'the runtime must admit a legal scoped query at the newest language version',
  );
  assert.equal(registered.legalEntityScope?.cardinality, 'nonEmptySet');
});
