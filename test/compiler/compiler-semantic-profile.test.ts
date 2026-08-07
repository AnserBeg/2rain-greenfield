import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseNormalizedApplicationPackageJson } from '../../packages/canonical-model/src/index.js';
import {
  ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
  COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  COMPILER_SEMANTIC_PROFILE_VERSION,
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  MODULE_COMPILER_PROFILE,
  SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS,
  reproduceHistoricalApplication,
  type CompilerSemanticProfileVersion,
} from '../../packages/compiler/src/index.js';

import { compilerInput, fixtureBytes, mustCompile } from './helpers.js';

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
    [COMPILER_SEMANTIC_PROFILE_VERSION, COMPILER_SEMANTIC_PROFILE_V1_VERSION],
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

function compileAt(fixture: string, version: CompilerSemanticProfileVersion) {
  const base = compilerInput(fixtureBytes(fixture));
  return mustCompile({
    ...base,
    profile: { ...base.profile, compilerSemanticProfileVersion: version },
  });
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
