import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ADOPTED_LANGUAGE_VERSION,
  SUPPORTED_LANGUAGE_VERSIONS,
  parseNormalizedApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import {
  ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
  COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  COMPILER_SEMANTIC_PROFILE_VERSION,
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  MODULE_COMPILER_PROFILE,
  SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS,
  compileApplication,
  expectedActiveReleaseFrom,
  reproduceHistoricalApplication,
  selectAdoptedProfileVersion,
  type CompilerSemanticProfileVersion,
} from '../../packages/compiler/src/index.js';

import {
  authoredFixture,
  compilerInput,
  fixtureBytes,
  mustCompile,
  normalizedBytes,
} from './helpers.js';

const LINEAGE_PATH = 'apps/web/release/app.compiled.json';

// Release roots recorded on `main` at 66c8d96, BEFORE v1 was cut. Frozen
// rather than compared against a second fresh compile: comparing two fresh
// compiles proves DETERMINISM, not identity with the pre-cut output, and a
// deterministic change to v0 lowering would move both and stay green.
const PRE_CUT_V0_RELEASE_ROOTS = Object.freeze({
  bootstrap: '283ce0505f8f8349f5841d594183dd39f2b6f91ae4c303c4257d632930c329c3',
  'vertical-v1':
    '07819a2ec1e2e9288294d53f3bb66daa767ffaf62754b01ad40aadc721a0f5f7',
});

// Victim: `ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION` and the
// DEFAULT_COMPILER_PROFILE key in compiler.ts. The analogue on the language
// axis is `legal-entity-query-scope.test.ts`'s "cutting v4 leaves v3 output
// byte-identical", which fired correctly during proj-disc's design pass.
test('cutting compiler-semantic profile v1 leaves v0 output byte-identical', () => {
  // Observed DIRECTLY on the constant. test/compiler/helpers.ts derives its
  // profile from the package under compile and would never notice this
  // constant moving -- the language control's first run missed exactly that
  // and passed while the default profile pointed at the unadopted version.
  // A control that derives the profile from the artifact cannot see the
  // defect it exists to catch, so this half must not go through a compile.
  //
  // On its own this assertion is DEGENERATE today: adopted and latest-readable
  // are both v1, so a "take the last readable member" implementation satisfies
  // it. The rule is therefore proven separately on a constructed readable set
  // in the selector test below, and production is proven to route through that
  // same selector rather than an inlined copy.
  assert.equal(
    DEFAULT_COMPILER_PROFILE.compilerSemanticProfileVersion,
    ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
  );
  assert.equal(
    MODULE_COMPILER_PROFILE.compilerSemanticProfileVersion,
    ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
  );
  // The axis is append-only: v0 stays readable after v1 is cut, and the
  // adopted version is a member of the supported list rather than a free
  // string. Cutting a version never renames or drops an existing one.
  assert.deepEqual(
    [...SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS],
    [
      COMPILER_SEMANTIC_PROFILE_VERSION,
      COMPILER_SEMANTIC_PROFILE_V1_VERSION,
      COMPILER_SEMANTIC_PROFILE_V2_VERSION,
    ],
  );
  assert.ok(
    SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS.includes(
      ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
    ),
  );

  // The byte-identity half. Compiled at an EXPLICIT v0 so it is independent of
  // wherever the default currently points, which is what lets these two halves
  // together cover both the constant and the output.
  for (const [name, expectedRoot] of Object.entries(PRE_CUT_V0_RELEASE_ROOTS)) {
    assert.equal(
      compileAt(name, COMPILER_SEMANTIC_PROFILE_VERSION).releaseRoot,
      expectedRoot,
      `${name} v0 release root moved when v1 was cut`,
    );
  }
});

// Pre-cut v1 roots, measured on `main` at 3b74fc1 BEFORE v2 was cut, from a
// clean checkout rather than from the branch that cuts it. Deriving them from
// the post-cut tree would be circular: it would record whatever the cut
// produced and then assert the cut did not change it.
const PRE_CUT_V1_RELEASE_ROOTS = Object.freeze({
  bootstrap: 'b8d5353634eec9b97e146523801b333a993117fc67196fb033f740142c5a0093',
  'vertical-v1':
    '64bf0535c2453feade300de7c5d46ec85a48bd2bb8c3f7d5d051515117dd80ee',
});

// The control ADR-0047's Consequences owes on every new cut, now on v2. Its v1
// sibling above is what fired correctly when v1 was cut; this is the same
// instrument one version along, and it is what makes "cutting is inert"
// observable rather than asserted. `U5b` relies on that inertness: every field
// it gates on v2 is invisible until adoption, and if a cut were NOT inert the
// recorded lineage would move the moment the constant was appended.
test('cutting compiler-semantic profile v2 leaves v1 output byte-identical', () => {
  for (const [name, expectedRoot] of Object.entries(PRE_CUT_V1_RELEASE_ROOTS)) {
    assert.equal(
      compileAt(name, COMPILER_SEMANTIC_PROFILE_V1_VERSION).releaseRoot,
      expectedRoot,
      `${name} v1 release root moved when v2 was cut`,
    );
  }
});

// HALF ONE of the adoption rule: the selector is exercised on a CONSTRUCTED
// readable set whose adopted member is not its last, so "take the latest
// readable version" -- the defect -- produces a recorded red. Against today's
// live constants the two rules agree, which is exactly why this cannot be
// proven from the constants alone.
test('the adoption selector takes the adopted version, not the latest readable', () => {
  const readable = ['v0', 'v1'] as const;

  assert.equal(selectAdoptedProfileVersion(readable, 'v0'), 'v0');
  assert.notEqual(selectAdoptedProfileVersion(readable, 'v0'), readable.at(-1));
  assert.equal(selectAdoptedProfileVersion(readable, 'v1'), 'v1');

  // The same shape as the live axes: three readable, adoption lagging by one.
  const threeReadable = ['v0', 'v1', 'v2'] as const;
  assert.equal(selectAdoptedProfileVersion(threeReadable, 'v1'), 'v1');

  // Fails closed rather than substituting a default.
  assert.throws(
    () => selectAdoptedProfileVersion(readable, 'v2' as 'v0' | 'v1'),
    /not a member of the readable set/u,
  );
});

// HALF TWO: production routes through that selector rather than an inlined
// copy. Structural by nature -- while adoption and latest-readable coincide no
// runtime observation can separate them -- so this asserts the selector,
// applied to the real inputs, yields exactly what production selected. It
// arms fully the moment either axis cuts without adopting.
test('the default profile is the selector applied to the live axes', () => {
  assert.equal(
    DEFAULT_COMPILER_PROFILE.compilerSemanticProfileVersion,
    selectAdoptedProfileVersion(
      SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS,
      ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
    ),
  );
  assert.equal(
    DEFAULT_COMPILER_PROFILE.languageVersion,
    selectAdoptedProfileVersion(
      SUPPORTED_LANGUAGE_VERSIONS,
      ADOPTED_LANGUAGE_VERSION,
    ),
  );
});

// ADR-0047 §1: the profile is hashed whole into
// `releaseManifest.semanticProfileDigest`, which is what makes it a real
// discriminator rather than a label.
test('the compiler-semantic profile discriminates the release root', () => {
  const v0 = compileAt('vertical-v1', COMPILER_SEMANTIC_PROFILE_VERSION);
  const v1 = compileAt('vertical-v1', COMPILER_SEMANTIC_PROFILE_V1_VERSION);

  assert.notEqual(v0.releaseRoot, v1.releaseRoot);
  assert.notEqual(
    v0.bundle.releaseManifest.semanticProfileDigest,
    v1.bundle.releaseManifest.semanticProfileDigest,
  );
  assert.equal(
    v0.bundle.releaseManifest.compilerSemanticProfileVersion,
    COMPILER_SEMANTIC_PROFILE_VERSION,
  );
  assert.equal(
    v1.bundle.releaseManifest.compilerSemanticProfileVersion,
    COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  );
  // The attestation is the DURABLE per-entry discriminator -- it is what
  // reproduction reads back. It must carry the selected profile, not the
  // module constant, or a recorded entry cannot say what it was compiled under.
  assert.equal(
    v0.attestation.compilerSemanticProfileVersion,
    COMPILER_SEMANTIC_PROFILE_VERSION,
  );
  assert.equal(
    v1.attestation.compilerSemanticProfileVersion,
    COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  );

  // This packet lands the discriminator ALONE: no projection payload changes
  // shape at v1 yet. Pinning that here means the first consumer's added field
  // is visible as a deliberate move of this assertion, not as drift.
  const projectionArtifacts = (
    compiled: typeof v0,
  ): readonly (readonly [string, string])[] =>
    compiled.bundle.releaseManifest.projections
      .map(
        (projection) =>
          [projection.instanceId, projection.artifactRoot] as const,
      )
      .sort((left, right) => (left[0] < right[0] ? -1 : 1));
  assert.deepEqual(projectionArtifacts(v0), projectionArtifacts(v1));
});

// ADR-0047 §4: the lineage advances when the OUTPUT CONTRACT changes, not only
// when the authored source does, so two consecutive entries may have
// byte-identical normalized definitions and different release roots. Observed
// on the recorded artifact rather than declared.
test('consecutive lineage entries may share a normalized definition', () => {
  const lineage = readLineage();
  const head = lineage.applications.at(-1)!;
  const predecessor = lineage.applications.at(-2)!;

  assert.equal(
    head.normalizedDefinitionBytesBase64,
    predecessor.normalizedDefinitionBytesBase64,
  );
  assert.notEqual(head.releaseRoot, predecessor.releaseRoot);
  assert.equal(
    head.attestation.compilerSemanticProfileVersion,
    ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
  );
  assert.equal(
    predecessor.attestation.compilerSemanticProfileVersion,
    COMPILER_SEMANTIC_PROFILE_VERSION,
  );
  // The predecessor is retired to history, never rewritten in place: its root
  // is recorded and may be activated, so overwriting it is the history rewrite
  // the freeze exists to prevent.
  assert.equal(
    predecessor.releaseManifest.compilerSemanticProfileVersion,
    COMPILER_SEMANTIC_PROFILE_VERSION,
  );
});

// ADR-0047 §5: every entry reproduces under the profile its OWN attestation
// records, never under today's constant. The red is asserted here rather than
// remembered -- reproduction that inherits the current constant fails at the
// bootstrap root, and that failure is the reason this control exists.
test('historical reproduction reads the profile from the entry, not the constant', () => {
  const lineage = readLineage();
  const bootstrap = lineage.bootstrap;
  const recorded = bootstrap.attestation.compilerSemanticProfileVersion;

  // The recorded profile differs from today's adopted one; without that this
  // control would be vacuous, because inheriting the constant and reading the
  // attestation would be indistinguishable.
  assert.notEqual(recorded, ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION);

  assert.equal(reproduceBootstrapUnder(bootstrap, recorded).status, 'compiled');

  const inherited = reproduceBootstrapUnder(
    bootstrap,
    ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
  );
  assert.equal(inherited.status, 'failed');
  if (inherited.status !== 'failed') return;
  assert.deepEqual(
    inherited.diagnostics.map((diagnostic) => diagnostic.code),
    ['COMPILER_HISTORICAL_REPRODUCTION_MISMATCH'],
  );
});

// ADR-0043 keeps experimental lineage truncation available while the output
// protocol is v0-experimental, and ADR-0047 deliberately leaves it there. The
// truncation path re-compiles stored bytes and exact-compares against their
// recorded serialization, so it must use each entry's OWN recorded profile.
// `check:app-release` cannot catch a regression here: that command runs the
// ordinary verification path, never the flag.
//
// Built as a constructed lineage rather than the checked-in one because the
// real v0 history survives only under historical leniency, so truncation
// legitimately refuses it with "no valid application prefix to retain" -- a
// different outcome that would hide this defect.
test('--truncate-invalid-lineage retains a v0 prefix while the adopted profile is v1', () => {
  assert.notEqual(
    ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
    COMPILER_SEMANTIC_PROFILE_VERSION,
    'this control is only meaningful while adoption has moved off v0',
  );

  const workspace = mkdtempSync(join(tmpdir(), 'northstar-truncate-'));
  try {
    const authoredPath = join(workspace, 'app.authored.json');
    const compiledPath = join(workspace, 'app.compiled.json');
    const fixture = buildV0LineageWithInvalidSuffix(authoredPath, compiledPath);

    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/web/scripts/compile-app-release.ts',
        '--truncate-invalid-lineage',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NORTH_STAR_APP_AUTHORED_PATH: authoredPath,
          NORTH_STAR_APP_COMPILED_PATH: compiledPath,
        },
      },
    );

    assert.equal(
      run.status,
      0,
      `truncation failed: ${run.stderr || run.stdout}`,
    );
    assert.match(
      run.stdout,
      /TRUNCATED_INVALID_LINEAGE kept=1 dropped=1 firstInvalid=1/u,
    );

    const rewritten = JSON.parse(readFileSync(compiledPath, 'utf8')) as {
      applications: RecordedRelease[];
      bootstrap: RecordedRelease;
    };
    // Two entries, and the distinction between them is the whole point: the
    // invalid suffix is dropped, the valid v0 prefix is RETAINED byte-for-byte
    // under the profile it was recorded with, and the ordinary flow then mints
    // a fresh head at today's adopted profile. Truncation repairs the tail; it
    // never re-adopts or rewrites what it keeps.
    assert.equal(rewritten.applications.length, 2);
    assert.equal(rewritten.applications[0]!.releaseRoot, fixture.validRoot);
    assert.equal(
      rewritten.applications[0]!.attestation.compilerSemanticProfileVersion,
      COMPILER_SEMANTIC_PROFILE_VERSION,
    );
    assert.equal(
      rewritten.applications[1]!.attestation.compilerSemanticProfileVersion,
      ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
    );
    assert.notEqual(
      rewritten.applications[1]!.releaseRoot,
      fixture.validRoot,
      'the re-minted head must be a new release, not the retained entry',
    );
    // The bootstrap is reproduced, never re-minted.
    assert.equal(rewritten.bootstrap.releaseRoot, fixture.bootstrapRoot);
    assert.equal(
      rewritten.bootstrap.attestation.compilerSemanticProfileVersion,
      COMPILER_SEMANTIC_PROFILE_VERSION,
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

function compileAt(fixture: string, version: CompilerSemanticProfileVersion) {
  const base = compilerInput(fixtureBytes(fixture));
  return mustCompile({
    ...base,
    profile: { ...base.profile, compilerSemanticProfileVersion: version },
  });
}

/**
 * A lineage whose bootstrap and first application are valid and recorded at
 * compiler-semantic v0, followed by an entry that does not compile under
 * current conformance. Mirrors the shape `compile-app-release.ts` writes; the
 * serialized-release expression is copied verbatim from that script because
 * truncation exact-compares against it, key order included.
 */
function buildV0LineageWithInvalidSuffix(
  authoredPath: string,
  compiledPath: string,
): { readonly bootstrapRoot: string; readonly validRoot: string } {
  const authored = authoredFixture('vertical-v1');
  const bootstrapBytes = normalizedBytes(emptyApplicationDefinition(authored));
  const applicationBytes = normalizedBytes(authored);

  const bootstrap = compileFixtureAtV0(bootstrapBytes, null);
  const application = compileFixtureAtV0(
    applicationBytes,
    expectedActiveReleaseFrom(bootstrap),
  );

  // Normalizes cleanly but fails current conformance, which is precisely the
  // "invalid suffix" truncation exists to drop.
  const invalidBytes = fixtureBytes('partial-lowering');

  writeFileSync(authoredPath, JSON.stringify(authored));
  writeFileSync(
    compiledPath,
    JSON.stringify({
      applications: [
        serializeRelease(applicationBytes, application),
        {
          attestation: {
            compilerSemanticProfileVersion: COMPILER_SEMANTIC_PROFILE_VERSION,
          },
          normalizedDefinitionBytesBase64:
            Buffer.from(invalidBytes).toString('base64'),
          outputProtocolVersion: 'northstar.compiler-output/v0-experimental',
          releaseRoot: '0'.repeat(64),
        },
      ],
      bootstrap: serializeRelease(bootstrapBytes, bootstrap),
      schemaVersion: 'northstar.web:compiled-application-release/v2',
    }),
  );
  return {
    bootstrapRoot: bootstrap.releaseRoot,
    validRoot: application.releaseRoot,
  };
}

function compileFixtureAtV0(
  normalizedDefinitionBytes: Uint8Array,
  expectedActiveRelease: Parameters<
    typeof compileApplication
  >[0]['expectedActiveRelease'],
) {
  const normalizedDefinition = parseNormalizedApplicationPackageJson(
    normalizedDefinitionBytes,
  );
  const result = compileApplication({
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes,
    profile: {
      ...MODULE_COMPILER_PROFILE,
      compilerSemanticProfileVersion: COMPILER_SEMANTIC_PROFILE_VERSION,
      languageVersion: normalizedDefinition.languageVersion,
      normalizationProfileVersion:
        normalizedDefinition.normalizationProfileVersion,
    },
  });
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function serializeRelease(
  normalizedDefinitionBytes: Uint8Array,
  compiled: ReturnType<typeof compileFixtureAtV0>,
) {
  return {
    attestation: compiled.attestation,
    artifacts: compiled.bundle.artifacts.map((artifact) => ({
      ...artifact,
      canonicalBytesBase64: Buffer.from(artifact.canonicalBytes).toString(
        'base64',
      ),
      canonicalBytes: undefined,
    })),
    nodeContracts: compiled.bundle.nodeContracts,
    normalizedDefinitionBytesBase64: Buffer.from(
      normalizedDefinitionBytes,
    ).toString('base64'),
    outputProtocolVersion: compiled.bundle.outputProtocolVersion,
    releaseManifest: compiled.bundle.releaseManifest,
    releaseManifestBytesBase64: Buffer.from(
      compiled.bundle.releaseManifestBytes,
    ).toString('base64'),
    releaseRoot: compiled.releaseRoot,
    stagedArtifactHashes: compiled.stagedArtifacts.map(
      (artifact) => artifact.contentHash,
    ),
  };
}

function emptyApplicationDefinition(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const definition = structuredClone(source);
  for (const family of [
    'assertions',
    'entities',
    'fields',
    'operations',
    'permissions',
    'queries',
    'relations',
    'stateMachines',
    'storageMappings',
    'surfaces',
  ]) {
    definition[family] = [];
  }
  return definition;
}

interface RecordedRelease {
  readonly attestation: {
    readonly compilerSemanticProfileVersion: CompilerSemanticProfileVersion;
  };
  readonly normalizedDefinitionBytesBase64: string;
  readonly releaseManifest: {
    readonly compilerSemanticProfileVersion: CompilerSemanticProfileVersion;
  };
  readonly releaseRoot: string;
}

function readLineage(): {
  readonly applications: readonly RecordedRelease[];
  readonly bootstrap: RecordedRelease;
} {
  return JSON.parse(readFileSync(LINEAGE_PATH, 'utf8')) as {
    readonly applications: readonly RecordedRelease[];
    readonly bootstrap: RecordedRelease;
  };
}

function reproduceBootstrapUnder(
  entry: RecordedRelease,
  version: CompilerSemanticProfileVersion,
) {
  const normalizedDefinitionBytes = new Uint8Array(
    Buffer.from(entry.normalizedDefinitionBytesBase64, 'base64'),
  );
  const normalizedDefinition = parseNormalizedApplicationPackageJson(
    normalizedDefinitionBytes,
  );
  return reproduceHistoricalApplication(
    {
      dependencies: [],
      expectedActiveRelease: null,
      kind: 'compilerInput',
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes,
      profile: {
        ...MODULE_COMPILER_PROFILE,
        compilerSemanticProfileVersion: version,
        languageVersion: normalizedDefinition.languageVersion,
        normalizationProfileVersion:
          normalizedDefinition.normalizationProfileVersion,
      },
    },
    { releaseRoot: entry.releaseRoot },
  );
}
