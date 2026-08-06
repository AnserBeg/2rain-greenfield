import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  canonicalize,
  normalizeApplicationPackage,
  parseAuthoredApplicationPackageJson,
  parseNormalizedApplicationPackageJson,
} from '@north-star/canonical-model';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS,
  compileApplication,
  expectedActiveReleaseFrom,
  reproduceHistoricalApplication,
  type CompileResult,
  type CompilerSemanticProfileVersion,
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
const experimentalOutputProtocol =
  'northstar.compiler-output/v0-experimental' as const;
const truncateInvalidLineage = process.argv.includes(
  '--truncate-invalid-lineage',
);
const checkOnly = process.argv.includes('--check');

if (truncateInvalidLineage && checkOnly) {
  throw new Error(
    '--truncate-invalid-lineage writes a new lineage and cannot be combined with --check',
  );
}

const authored = parseAuthoredApplicationPackageJson(
  readFileSync(authoredPath),
);
const applicationBytes = normalizedBytes(authored);
const existing = existsSync(outputPath)
  ? (JSON.parse(readFileSync(outputPath, 'utf8')) as unknown)
  : null;
const verified = existing
  ? truncateInvalidLineage
    ? longestValidExperimentalLineagePrefix(existing)
    : verifyExistingLineage(existing, applicationBytes)
  : initialLineage(authored);
const latest = verified.applications.at(-1)!;
// PROBE: the lineage advances on either axis — an authored-source edit, or an
// adopted compiler-semantic profile the recorded head does not carry.
const headIsCurrent =
  equalBytes(applicationBytes, latest.normalizedDefinitionBytes) &&
  latest.compiled.bundle.releaseManifest.compilerSemanticProfileVersion ===
    MODULE_COMPILER_PROFILE.compilerSemanticProfileVersion;
const authoredIsCurrent = headIsCurrent;

let payload: unknown = verified.payload;
if (!authoredIsCurrent && !checkOnly) {
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

if (checkOnly) {
  if (!authoredIsCurrent) {
    throw new Error(
      'compiled application release is stale; run pnpm --filter @north-star/web build:app-release',
    );
  }
} else {
  writeFileSync(outputPath, serialized);
}

function longestValidExperimentalLineagePrefix(
  input: unknown,
): CompiledLineage {
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
  assertExperimentalRelease(input.bootstrap, 'bootstrap');
  applicationValues.forEach((value, index) =>
    assertExperimentalRelease(value, `applications[${String(index)}]`),
  );

  const bootstrap = mustCompile(bootstrapBytes, null);
  assertSerializedRelease(
    input.bootstrap,
    bootstrapBytes,
    bootstrap,
    'bootstrap',
  );
  const applications: CompiledLineageRelease[] = [];
  let previous = bootstrap;
  let firstInvalidIndex: number | null = null;
  for (const [index, value] of applicationValues.entries()) {
    const normalizedDefinitionBytes = releaseBytes(
      value,
      `applications[${String(index)}]`,
    );
    const result = compileNormalizedDefinition(
      normalizedDefinitionBytes,
      expectedActiveReleaseFrom(previous),
    );
    if (result.status !== 'compiled') {
      firstInvalidIndex = index;
      break;
    }
    assertSerializedRelease(
      value,
      normalizedDefinitionBytes,
      result,
      `applications[${String(index)}]`,
    );
    applications.push({ compiled: result, normalizedDefinitionBytes });
    previous = result;
  }
  if (firstInvalidIndex === null) {
    throw new Error(
      'compiled application lineage has no invalid suffix to truncate',
    );
  }
  if (applications.length === 0) {
    throw new Error(
      'compiled application lineage has no valid application prefix to retain',
    );
  }
  for (
    let index = firstInvalidIndex;
    index < applicationValues.length;
    index += 1
  ) {
    releaseBytes(applicationValues[index], `applications[${String(index)}]`);
  }
  const payload = {
    applications: applications.map((release) =>
      serializedRelease(release.normalizedDefinitionBytes, release.compiled),
    ),
    bootstrap: serializedRelease(bootstrapBytes, bootstrap),
    schemaVersion: envelopeV2,
  };
  console.log(
    `TRUNCATED_INVALID_LINEAGE kept=${String(applications.length)} ` +
      `dropped=${String(applicationValues.length - firstInvalidIndex)} ` +
      `firstInvalid=${String(firstInvalidIndex)}`,
  );
  return {
    applications,
    bootstrap: {
      compiled: bootstrap,
      normalizedDefinitionBytes: bootstrapBytes,
    },
    payload,
  };
}

function assertExperimentalRelease(value: unknown, path: string): void {
  if (
    !isRecord(value) ||
    value.outputProtocolVersion !== experimentalOutputProtocol
  ) {
    throw new Error(
      `${path} is not eligible for experimental lineage truncation`,
    );
  }
}

function assertSerializedRelease(
  value: unknown,
  normalizedDefinitionBytes: Uint8Array,
  compiled: CompileSuccess,
  path: string,
): void {
  if (
    JSON.stringify(value) !==
    JSON.stringify(serializedRelease(normalizedDefinitionBytes, compiled))
  ) {
    throw new Error(`${path} does not match its current compiler output`);
  }
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

function verifyExistingLineage(
  input: unknown,
  currentSourceBytes: Uint8Array,
): CompiledLineage {
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
  const bootstrap = mustReproduceHistorical(
    bootstrapBytes,
    null,
    recordedReleaseRoot(input.bootstrap, 'bootstrap'),
    recordedCompilerSemanticProfileVersion(input.bootstrap, 'bootstrap'),
  );
  const applications: CompiledLineageRelease[] = [];
  let previous = bootstrap;
  for (const [index, value] of applicationValues.entries()) {
    const normalizedDefinitionBytes = releaseBytes(
      value,
      `applications[${String(index)}]`,
    );
    // PROBE: an entry is the serving head only when BOTH the source bytes and
    // the compiler-semantic profile still match today's. A profile move
    // retires the old head to history exactly as a source edit does.
    const servingHead =
      index === applicationValues.length - 1 &&
      equalBytes(normalizedDefinitionBytes, currentSourceBytes) &&
      recordedCompilerSemanticProfileVersion(
        value,
        `applications[${String(index)}]`,
      ) === MODULE_COMPILER_PROFILE.compilerSemanticProfileVersion;
    const compiled = servingHead
      ? mustCompile(
          normalizedDefinitionBytes,
          expectedActiveReleaseFrom(previous),
        )
      : mustReproduceHistorical(
          normalizedDefinitionBytes,
          expectedActiveReleaseFrom(previous),
          recordedReleaseRoot(value, `applications[${String(index)}]`),
          recordedCompilerSemanticProfileVersion(
            value,
            `applications[${String(index)}]`,
          ),
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

// PROBE: the durable per-entry discriminator. Every recorded entry already
// carries the profile version it was compiled under, so reproduction never has
// to inherit today's constant.
function recordedCompilerSemanticProfileVersion(
  value: unknown,
  path: string,
): CompilerSemanticProfileVersion {
  const attestation = isRecord(value) ? value.attestation : null;
  const recorded = isRecord(attestation)
    ? attestation.compilerSemanticProfileVersion
    : null;
  const supported = SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS.find(
    (candidate) => candidate === recorded,
  );
  if (!supported) {
    throw new TypeError(
      `${path} records an unreadable compiler-semantic profile version`,
    );
  }
  return supported;
}

function recordedReleaseRoot(value: unknown, path: string): string {
  if (
    !isRecord(value) ||
    typeof value.releaseRoot !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.releaseRoot)
  ) {
    throw new TypeError(`${path} recorded release root is invalid`);
  }
  return value.releaseRoot;
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
  const result = compileNormalizedDefinition(
    normalizedDefinitionBytes,
    expectedActiveRelease,
  );
  if (result.status !== 'compiled') {
    throw new Error(
      `composed application release did not compile: ${JSON.stringify(result.diagnostics)}`,
    );
  }
  return result;
}

function mustReproduceHistorical(
  normalizedDefinitionBytes: Uint8Array,
  expectedActiveRelease: Parameters<
    typeof compileApplication
  >[0]['expectedActiveRelease'],
  recordedReleaseRoot: string,
  recordedCompilerSemanticProfileVersion: CompilerSemanticProfileVersion,
): CompileSuccess {
  const normalizedDefinition = parseNormalizedApplicationPackageJson(
    normalizedDefinitionBytes,
  );
  const result = reproduceHistoricalApplication(
    {
      dependencies: [],
      expectedActiveRelease,
      kind: 'compilerInput',
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes,
      profile: {
        ...MODULE_COMPILER_PROFILE,
        compilerSemanticProfileVersion:
          recordedCompilerSemanticProfileVersion,
        languageVersion: normalizedDefinition.languageVersion,
        normalizationProfileVersion:
          normalizedDefinition.normalizationProfileVersion,
      },
    },
    { releaseRoot: recordedReleaseRoot },
  );
  if (result.status !== 'compiled') {
    throw new Error(
      `historical application release did not reproduce: ${JSON.stringify(result.diagnostics)}`,
    );
  }
  return result;
}

function compileNormalizedDefinition(
  normalizedDefinitionBytes: Uint8Array,
  expectedActiveRelease: Parameters<
    typeof compileApplication
  >[0]['expectedActiveRelease'],
): CompileResult {
  const normalizedDefinition = parseNormalizedApplicationPackageJson(
    normalizedDefinitionBytes,
  );
  return compileApplication({
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes,
    profile: {
      ...MODULE_COMPILER_PROFILE,
      languageVersion: normalizedDefinition.languageVersion,
      normalizationProfileVersion:
        normalizedDefinition.normalizationProfileVersion,
    },
  });
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
