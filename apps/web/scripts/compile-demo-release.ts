import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  canonicalize,
  normalizeApplicationPackage,
  parseAuthoredApplicationPackageJson,
} from '@north-star/canonical-model';
import {
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  type CompileSuccess,
  type ProjectionFamilyId,
  type ProjectionManifestEnvelope,
} from '@north-star/compiler';

const root = resolve(import.meta.dirname, '../../..');
const authoredPath = resolve(root, 'apps/web/release/shell.authored.json');
const outputPath = resolve(root, 'apps/web/release/shell.compiled.json');

const authored = parseAuthoredApplicationPackageJson(
  readFileSync(authoredPath),
);
const normalizedDefinitionBytes = new TextEncoder().encode(
  canonicalize(normalizeApplicationPackage(authored)),
);
const result = compileApplication({
  dependencies: [],
  expectedActiveRelease: null,
  kind: 'compilerInput',
  limits: { ...DEFAULT_COMPILER_LIMITS },
  normalizedDefinitionBytes,
  profile: { ...DEFAULT_COMPILER_PROFILE },
});

if (result.status !== 'compiled') {
  throw new Error(
    `demo release did not compile: ${JSON.stringify(result.diagnostics)}`,
  );
}

const payload = {
  compilerVersion: result.bundle.releaseManifest.compilerVersion,
  normalizedDefinitionDigest:
    result.bundle.releaseManifest.normalizedDefinitionDigest,
  outputProtocolVersion: result.bundle.outputProtocolVersion,
  projections: {
    agent: runtimeProjection(result, PROJECTION_FAMILY_IDS.agentDiscovery),
    catalog: runtimeProjection(result, PROJECTION_FAMILY_IDS.semanticModel),
    operation: runtimeProjection(
      result,
      PROJECTION_FAMILY_IDS.operationCatalog,
    ),
    query: runtimeProjection(result, PROJECTION_FAMILY_IDS.queryCatalog),
    surface: runtimeProjection(result, PROJECTION_FAMILY_IDS.surfaceManifest),
  },
  releaseRoot: result.releaseRoot,
  schemaVersion: 'northstar.web:compiled-shell-fixture/v1',
};
const serialized = `${JSON.stringify(payload, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existing = readFileSync(outputPath, 'utf8');
  if (JSON.stringify(JSON.parse(existing)) !== JSON.stringify(payload)) {
    throw new Error(
      'compiled shell fixture is stale; run pnpm --filter @north-star/web build:demo-release',
    );
  }
} else {
  writeFileSync(outputPath, serialized);
}

function runtimeProjection(
  compiled: CompileSuccess,
  familyId: ProjectionFamilyId,
) {
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

  return {
    artifactRoot: reference.artifactRoot,
    familyId: reference.familyId,
    instanceId: reference.instanceId,
    payload: JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)),
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  };
}
