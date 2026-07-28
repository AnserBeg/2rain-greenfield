import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  canonicalize,
  normalizeApplicationPackage,
  parseAuthoredApplicationPackageJson,
} from '@north-star/canonical-model';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  compileApplication,
  expectedActiveReleaseFrom,
  type CompileSuccess,
} from '@north-star/compiler';
import { format } from 'prettier';

const root = resolve(import.meta.dirname, '../../..');
const authoredPath = resolve(root, 'apps/web/release/app.authored.json');
const outputPath = resolve(root, 'apps/web/release/app.compiled.json');

const authored = parseAuthoredApplicationPackageJson(
  readFileSync(authoredPath),
);
const bootstrapAuthored = emptyApplicationDefinition(authored);
const bootstrapBytes = normalizedBytes(bootstrapAuthored);
const bootstrap = mustCompile(bootstrapBytes, null);
const applicationBytes = normalizedBytes(authored);
const application = mustCompile(
  applicationBytes,
  expectedActiveReleaseFrom(bootstrap),
);

const payload = {
  application: serializedRelease(applicationBytes, application),
  bootstrap: serializedRelease(bootstrapBytes, bootstrap),
  schemaVersion: 'northstar.web:compiled-application-release/v1',
};
const serialized = await format(JSON.stringify(payload), { parser: 'json' });

if (process.argv.includes('--check')) {
  const existing = readFileSync(outputPath, 'utf8');
  if (JSON.stringify(JSON.parse(existing)) !== JSON.stringify(payload)) {
    throw new Error(
      'compiled application release is stale; run pnpm --filter @north-star/web build:app-release',
    );
  }
} else {
  writeFileSync(outputPath, serialized);
}

function normalizedBytes(definition: unknown): Uint8Array {
  return new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(definition)),
  );
}

function mustCompile(
  normalizedDefinitionBytes: Uint8Array,
  expectedActiveRelease: Parameters<
    typeof compileApplication
  >[0]['expectedActiveRelease'],
): CompileSuccess {
  const result = compileApplication({
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes,
    profile: { ...MODULE_COMPILER_PROFILE },
  });
  if (result.status !== 'compiled') {
    throw new Error(
      `composed application release did not compile: ${JSON.stringify(result.diagnostics)}`,
    );
  }
  return result;
}

function serializedRelease(
  normalizedDefinitionBytes: Uint8Array,
  compiled: CompileSuccess,
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
