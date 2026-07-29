import {
  canonicalize,
  normalizeApplicationPackage,
  parseNormalizedApplicationPackageJson,
} from '@north-star/canonical-model';
import {
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  type CompileSuccess,
  type ProjectionFamilyId,
  type ProjectionManifestEnvelope,
} from '../../../../packages/compiler/src/index.js';

import {
  authoredSurfaceGrammarFixture,
  type FixtureCompiledSurface,
  type SurfaceGrammarFixtureOptions,
} from './definitions.js';

export function compileSurfaceGrammarFixture(
  options: SurfaceGrammarFixtureOptions = {},
): CompileSuccess {
  const normalizedDefinitionBytes = new TextEncoder().encode(
    canonicalize(
      normalizeApplicationPackage(authoredSurfaceGrammarFixture(options)),
    ),
  );
  const normalizedDefinition = parseNormalizedApplicationPackageJson(
    normalizedDefinitionBytes,
  );
  const result = compileApplication({
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes,
    profile: {
      ...DEFAULT_COMPILER_PROFILE,
      languageVersion: normalizedDefinition.languageVersion,
      normalizationProfileVersion:
        normalizedDefinition.normalizationProfileVersion,
    },
  });
  if (result.status !== 'compiled') {
    throw new Error(
      `surface grammar fixture did not compile: ${JSON.stringify(result.diagnostics)}`,
    );
  }
  return result;
}

export function compiledSurfaceGrammarSurfaces(
  compiled = compileSurfaceGrammarFixture(),
): readonly FixtureCompiledSurface[] {
  return runtimeProjection(compiled, PROJECTION_FAMILY_IDS.surfaceManifest)
    .payload.surfaces as unknown as readonly FixtureCompiledSurface[];
}

export function surfaceGrammarRuntimeFixture(
  options: SurfaceGrammarFixtureOptions = {},
): Readonly<Record<string, unknown>> {
  const compiled = compileSurfaceGrammarFixture(options);
  return Object.freeze({
    compilerVersion: compiled.bundle.releaseManifest.compilerVersion,
    normalizedDefinitionDigest:
      compiled.bundle.releaseManifest.normalizedDefinitionDigest,
    outputProtocolVersion: compiled.bundle.outputProtocolVersion,
    projections: Object.freeze({
      agent: runtimeProjection(compiled, PROJECTION_FAMILY_IDS.agentDiscovery),
      catalog: runtimeProjection(compiled, PROJECTION_FAMILY_IDS.semanticModel),
      operation: runtimeProjection(
        compiled,
        PROJECTION_FAMILY_IDS.operationCatalog,
      ),
      query: runtimeProjection(compiled, PROJECTION_FAMILY_IDS.queryCatalog),
      surface: runtimeProjection(
        compiled,
        PROJECTION_FAMILY_IDS.surfaceManifest,
      ),
    }),
    releaseRoot: compiled.releaseRoot,
    schemaVersion: 'northstar.web:compiled-shell-fixture/v1',
  });
}

export function runtimeProjection(
  compiled: CompileSuccess,
  familyId: ProjectionFamilyId,
): Readonly<Record<string, unknown>> & {
  readonly payload: Readonly<Record<string, unknown>>;
} {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  if (!reference) throw new Error(`missing projection ${familyId}`);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === reference.artifactRoot,
  );
  if (!manifestArtifact) throw new Error(`missing manifest ${familyId}`);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  const chunk = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === manifest.chunks[0]?.contentHash,
  );
  if (!chunk) throw new Error(`missing payload chunk ${familyId}`);
  const payload = JSON.parse(
    new TextDecoder().decode(chunk.canonicalBytes),
  ) as Readonly<Record<string, unknown>>;
  return Object.freeze({
    artifactRoot: reference.artifactRoot,
    familyId: reference.familyId,
    instanceId: reference.instanceId,
    payload,
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  });
}
