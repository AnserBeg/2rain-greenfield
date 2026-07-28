import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
const authoredPath = resolve(
  process.env.NORTH_STAR_APP_AUTHORED_PATH ??
    resolve(root, 'apps/web/release/app.authored.json'),
);
const outputPath = resolve(
  process.env.NORTH_STAR_APP_COMPILED_PATH ??
    resolve(root, 'apps/web/release/app.compiled.json'),
);
const envelopeV1 = 'northstar.web:compiled-application-release/v1' as const;
const envelopeV2 = 'northstar.web:compiled-application-release/v2' as const;

const authored = parseAuthoredApplicationPackageJson(
  readFileSync(authoredPath),
);
const applicationBytes = normalizedBytes(authored);
const existing = existsSync(outputPath)
  ? (JSON.parse(readFileSync(outputPath, 'utf8')) as unknown)
  : null;
const verified = existing
  ? verifyExistingLineage(existing)
  : initialLineage(authored);
const latest = verified.applications.at(-1)!;
const authoredIsCurrent = equalBytes(
  applicationBytes,
  latest.normalizedDefinitionBytes,
);

let payload: unknown = verified.payload;
if (!authoredIsCurrent && !process.argv.includes('--check')) {
  const candidate = mustCompile(
    applicationBytes,
    expectedActiveReleaseFrom(latest.compiled),
  );
  payload = {
    applications: [
      ...verified.applications.map((release) =>
        serializedRelease(release.normalizedDefinitionBytes, release.compiled),
      ),
      serializedRelease(applicationBytes, candidate),
    ],
    bootstrap: serializedRelease(
      verified.bootstrap.normalizedDefinitionBytes,
      verified.bootstrap.compiled,
    ),
    schemaVersion: envelopeV2,
  };
}
const serialized = await format(JSON.stringify(payload), { parser: 'json' });

if (process.argv.includes('--check')) {
  if (!authoredIsCurrent) {
    throw new Error(
      'compiled application release is stale; run pnpm --filter @north-star/web build:app-release',
    );
  }
} else {
  writeFileSync(outputPath, serialized);
}

interface CompiledLineageRelease {
  readonly compiled: CompileSuccess;
  readonly normalizedDefinitionBytes: Uint8Array;
}

interface CompiledLineage {
  readonly applications: readonly CompiledLineageRelease[];
  readonly bootstrap: CompiledLineageRelease;
  readonly payload: unknown;
}

function initialLineage(
  authoredDefinition: Record<string, unknown>,
): CompiledLineage {
  const bootstrapBytes = normalizedBytes(
    emptyApplicationDefinition(authoredDefinition),
  );
  const bootstrap = mustCompile(bootstrapBytes, null);
  const application = mustCompile(
    applicationBytes,
    expectedActiveReleaseFrom(bootstrap),
  );
  const payload = {
    application: serializedRelease(applicationBytes, application),
    bootstrap: serializedRelease(bootstrapBytes, bootstrap),
    schemaVersion: envelopeV1,
  };
  return {
    applications: [
      { compiled: application, normalizedDefinitionBytes: applicationBytes },
    ],
    bootstrap: {
      compiled: bootstrap,
      normalizedDefinitionBytes: bootstrapBytes,
    },
    payload,
  };
}

function verifyExistingLineage(input: unknown): CompiledLineage {
  if (!isRecord(input)) {
    throw new TypeError('compiled application release envelope is invalid');
  }
  const bootstrapBytes = releaseBytes(input.bootstrap, 'bootstrap');
  const applicationValues =
    input.schemaVersion === envelopeV1
      ? [input.application]
      : input.schemaVersion === envelopeV2 && Array.isArray(input.applications)
        ? input.applications
        : null;
  if (!applicationValues || applicationValues.length === 0) {
    throw new TypeError('compiled application release envelope is invalid');
  }
  const bootstrap = mustCompile(bootstrapBytes, null);
  const applications: CompiledLineageRelease[] = [];
  let previous = bootstrap;
  for (const [index, value] of applicationValues.entries()) {
    const normalizedDefinitionBytes = releaseBytes(
      value,
      `applications[${String(index)}]`,
    );
    const compiled = mustCompile(
      normalizedDefinitionBytes,
      expectedActiveReleaseFrom(previous),
    );
    applications.push({ compiled, normalizedDefinitionBytes });
    previous = compiled;
  }
  const payload =
    input.schemaVersion === envelopeV1
      ? {
          application: serializedRelease(
            applications[0]!.normalizedDefinitionBytes,
            applications[0]!.compiled,
          ),
          bootstrap: serializedRelease(bootstrapBytes, bootstrap),
          schemaVersion: envelopeV1,
        }
      : {
          applications: applications.map((release) =>
            serializedRelease(
              release.normalizedDefinitionBytes,
              release.compiled,
            ),
          ),
          bootstrap: serializedRelease(bootstrapBytes, bootstrap),
          schemaVersion: envelopeV2,
        };
  if (JSON.stringify(input) !== JSON.stringify(payload)) {
    throw new Error(
      'compiled application lineage is invalid; restore the last verified artifact before rebuilding',
    );
  }
  return {
    applications,
    bootstrap: {
      compiled: bootstrap,
      normalizedDefinitionBytes: bootstrapBytes,
    },
    payload,
  };
}

function releaseBytes(value: unknown, path: string): Uint8Array {
  if (
    !isRecord(value) ||
    typeof value.normalizedDefinitionBytesBase64 !== 'string'
  ) {
    throw new TypeError(`${path} normalized definition bytes are invalid`);
  }
  const bytes = Buffer.from(value.normalizedDefinitionBytesBase64, 'base64');
  if (bytes.toString('base64') !== value.normalizedDefinitionBytesBase64) {
    throw new TypeError(
      `${path} normalized definition bytes are not canonical`,
    );
  }
  return new Uint8Array(bytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
