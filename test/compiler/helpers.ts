import { readFileSync } from 'node:fs';

import {
  canonicalize,
  normalizeApplicationPackage,
  parseAuthoredApplicationPackageJson,
  type AuthoredApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  compileApplication,
  type CompileSuccess,
  type CompilerInput,
  type ExpectedActiveRelease,
  type ProjectionFamilyId,
  type ProjectionManifestEnvelope,
} from '../../packages/compiler/src/index.js';

export function authoredFixture(name: string): AuthoredApplicationPackage {
  return parseAuthoredApplicationPackageJson(
    readFileSync(`test/fixtures/g1/compiler/${name}.authored.json`),
  );
}

export function normalizedBytes(
  authored: AuthoredApplicationPackage,
): Uint8Array {
  return new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(authored)),
  );
}

export function fixtureBytes(name: string): Uint8Array {
  return normalizedBytes(authoredFixture(name));
}

export function compilerInput(
  bytes: Uint8Array,
  expectedActiveRelease: ExpectedActiveRelease | null = null,
): CompilerInput {
  return {
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: bytes,
    profile: { ...DEFAULT_COMPILER_PROFILE },
  };
}

export function mustCompile(input: CompilerInput): CompileSuccess {
  const result = compileApplication(input);
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

export function projectionPayload<T>(
  compiled: CompileSuccess,
  familyId: ProjectionFamilyId,
): T {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (entry) => entry.familyId === familyId,
  );
  if (!reference) throw new Error(`missing projection ${familyId}`);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (entry) => entry.contentHash === reference.artifactRoot,
  );
  if (!manifestArtifact) throw new Error(`missing manifest ${familyId}`);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  const chunk = compiled.bundle.artifacts.find(
    (entry) => entry.contentHash === manifest.chunks[0]?.contentHash,
  );
  if (!chunk) throw new Error(`missing chunk ${familyId}`);
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
}

export function artifactSummary(compiled: CompileSuccess): unknown {
  return compiled.bundle.artifacts.map((artifact) => ({
    artifactKind: artifact.artifactKind,
    bytes: [...artifact.canonicalBytes],
    contentHash: artifact.contentHash,
    domainTag: artifact.domainTag,
  }));
}
