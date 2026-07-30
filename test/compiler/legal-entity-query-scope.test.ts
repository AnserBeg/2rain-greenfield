import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanonicalModelError,
  LANGUAGE_VERSIONS,
  LEGAL_ENTITY_SCOPE_PROFILE_VERSION,
  canonicalize,
  canonicalizeAndHash,
  evaluateLegalEntityScopeSelection,
  normalizeApplicationPackage,
  ADOPTED_LANGUAGE_VERSION,
  type LegalEntityScopeSelectionReceipt,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
} from '../../packages/compiler/src/index.js';

import { compilerInput, mustCompile, projectionPayload } from './helpers.js';
import { V3_AGGREGATE_IDS, v3AggregateModule } from './v3-definition.js';
import {
  V4_SCOPE_IDS,
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
    'northstar.normalization/v3',
  );

  const v3 = normalizedBytesFor(v3AggregateModule());
  // The unmodified default profile still compiles an adopted-version package.
  assert.equal(
    compileApplication({
      dependencies: [],
      expectedActiveRelease: null,
      kind: 'compilerInput',
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes: v3,
      profile: { ...DEFAULT_COMPILER_PROFILE },
    }).status,
    'compiled',
  );
  const before = canonicalizeAndHash(
    mustCompile(compilerInput(v3)).bundle.releaseManifest,
  ).contentHash;
  const again = canonicalizeAndHash(
    mustCompile(compilerInput(v3)).bundle.releaseManifest,
  ).contentHash;
  assert.equal(before, again);

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
