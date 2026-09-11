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
  compileApplicationRelease,
  expectedActiveReleaseFrom,
  reproduceHistoricalApplication,
  type CompileResult,
  type CompilerSemanticProfileVersion,
  type CompileSuccess,
} from '@north-star/compiler';
import { format } from 'prettier';

import {
  narrowAcknowledgementToDeclared,
  readRetainableAcknowledgementFor,
  readUnboundPermissionAcknowledgementFor,
  type UnboundPermissionAcknowledgementInput,
} from './unbound-permission-acknowledgement.js';

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
const preTenantRebaseline = process.argv.includes('--pre-tenant-rebaseline');
const checkOnly = process.argv.includes('--check');

if ((truncateInvalidLineage || preTenantRebaseline) && checkOnly) {
  throw new Error('lineage rewrite options cannot be combined with --check');
}
if (truncateInvalidLineage && preTenantRebaseline) {
  throw new Error('choose truncation or the ADR-0066 pre-tenant rebaseline');
}

const authored = parseAuthoredApplicationPackageJson(
  readFileSync(authoredPath),
);
const applicationBytes = normalizedBytes(authored);
// THE ACKNOWLEDGED-UNBOUND GATE. EVERY current compile in this script goes
// through `compileApplicationRelease`, whose acknowledgement is a required
// parameter -- there is no call here that could omit governance, and adding one
// would not compile. The loader throws before any compile if the checked-in
// file has no entry for the package.
//
// Three kinds of compile, three honest acknowledgements:
//   - the authored head (candidate under build, serving head under --check):
//     the checked-in list for this package, unnarrowed, so its census must be
//     complete;
//   - the bootstrap: the same package with every family emptied, so its honest
//     acknowledgement is explicitly empty;
//   - a RECORDED revision recompiled by --truncate-invalid-lineage: the
//     checked-in list narrowed to what that revision declares (see
//     `narrowAcknowledgementToDeclared`). Round 2 passed these NOTHING and
//     recorded that as a stated limit; its review was right that naming a live
//     bypass does not make the invariant true.
//
// Historical entries under `verifyExistingLineage` are reproduced rather than
// re-judged -- `reproduceHistoricalApplication` skips whole-model validation
// altogether, by design, because it can only verify an already-recorded root.
function currentAcknowledgement(): UnboundPermissionAcknowledgementInput {
  return readUnboundPermissionAcknowledgementFor(
    authoredPath,
    parseNormalizedApplicationPackageJson(applicationBytes).package.packageId,
  );
}
function emptyAcknowledgement(
  normalizedDefinitionBytes: Uint8Array,
): UnboundPermissionAcknowledgementInput {
  return {
    entries: [],
    packageId: parseNormalizedApplicationPackageJson(normalizedDefinitionBytes)
      .package.packageId,
  };
}

/** The checked-in list narrowed to one recorded revision's own census. */
function recordedAcknowledgement(
  normalizedDefinitionBytes: Uint8Array,
): UnboundPermissionAcknowledgementInput {
  const recorded = parseNormalizedApplicationPackageJson(
    normalizedDefinitionBytes,
  );
  return narrowAcknowledgementToDeclared(
    readRetainableAcknowledgementFor(authoredPath, recorded.package.packageId),
    new Set(recorded.permissions.map((permission) => permission.permissionId)),
  );
}
const existing =
  !preTenantRebaseline && existsSync(outputPath)
    ? (JSON.parse(readFileSync(outputPath, 'utf8')) as unknown)
    : null;
const verified = existing
  ? truncateInvalidLineage
    ? longestValidExperimentalLineagePrefix(existing)
    : verifyExistingLineage(existing, applicationBytes)
  : initialLineage(authored);
const latest = verified.applications.at(-1)!;
// The lineage advances on EITHER axis: an authored-source edit, or an adopted
// compiler-semantic profile the recorded head does not carry (ADR-0047 §4).
// Two consecutive entries may therefore share a normalized definition.
const authoredIsCurrent =
  equalBytes(applicationBytes, latest.normalizedDefinitionBytes) &&
  latest.compiled.bundle.releaseManifest.compilerSemanticProfileVersion ===
    MODULE_COMPILER_PROFILE.compilerSemanticProfileVersion;

let payload: unknown = verified.payload;
if (!authoredIsCurrent && !checkOnly) {
  const candidate = mustCompile(
    applicationBytes,
    expectedActiveReleaseFrom(latest.compiled),
    undefined,
    currentAcknowledgement(),
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

  // Truncation re-compiles STORED bytes and exact-compares each result against
  // its recorded serialization, so every candidate entry must be compiled under
  // the profile it was recorded with (ADR-0047 §5). Inheriting today's adopted
  // profile fails the bootstrap outright once adoption has moved, which would
  // remove the ADR-0043 recovery mechanism this command exists to provide.
  // Current conformance validation still applies: this is compileApplication,
  // NOT the historical-leniency entry point. Truncation decides what a lineage
  // may still mint; it must not admit what today's rules reject.
  const bootstrap = mustCompile(
    bootstrapBytes,
    null,
    recordedCompilerSemanticProfileVersion(input.bootstrap, 'bootstrap'),
    emptyAcknowledgement(bootstrapBytes),
  );
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
    const path = `applications[${String(index)}]`;
    const normalizedDefinitionBytes = releaseBytes(value, path);
    const result = compileNormalizedDefinition(
      normalizedDefinitionBytes,
      expectedActiveReleaseFrom(previous),
      recordedCompilerSemanticProfileVersion(value, path),
      equalBytes(normalizedDefinitionBytes, applicationBytes)
        ? currentAcknowledgement()
        : recordedAcknowledgement(normalizedDefinitionBytes),
    );
    if (result.status !== 'compiled') {
      firstInvalidIndex = index;
      break;
    }
    assertSerializedRelease(value, normalizedDefinitionBytes, result, path);
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
  const bootstrap = mustCompile(
    bootstrapBytes,
    null,
    undefined,
    emptyAcknowledgement(bootstrapBytes),
  );
  const application = mustCompile(
    applicationBytes,
    expectedActiveReleaseFrom(bootstrap),
    undefined,
    currentAcknowledgement(),
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
    const path = `applications[${String(index)}]`;
    const normalizedDefinitionBytes = releaseBytes(value, path);
    // An entry is the serving head only when BOTH its source bytes and its
    // recorded compiler-semantic profile still match today's. A profile move
    // retires the old head to history exactly as a source edit does; without
    // this it would be recompiled in place, which is the history rewrite the
    // freeze exists to prevent (ADR-0047 §4).
    const servingHead =
      index === applicationValues.length - 1 &&
      equalBytes(normalizedDefinitionBytes, currentSourceBytes) &&
      recordedCompilerSemanticProfileVersion(value, path) ===
        MODULE_COMPILER_PROFILE.compilerSemanticProfileVersion;
    const compiled = servingHead
      ? mustCompile(
          normalizedDefinitionBytes,
          expectedActiveReleaseFrom(previous),
          undefined,
          currentAcknowledgement(),
        )
      : mustReproduceHistorical(
          normalizedDefinitionBytes,
          expectedActiveReleaseFrom(previous),
          recordedReleaseRoot(value, path),
          recordedCompilerSemanticProfileVersion(value, path),
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

/**
 * The durable per-entry discriminator, read from the entry's OWN attestation.
 * Every recorded entry already carries the profile version it was compiled
 * under, so reproduction never has to inherit today's constant (ADR-0047 §5).
 */
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
    typeof compileApplicationRelease
  >[0]['expectedActiveRelease'],
  compilerSemanticProfileVersion: CompilerSemanticProfileVersion | undefined,
  unboundPermissionAcknowledgement: UnboundPermissionAcknowledgementInput,
): CompileSuccess {
  const result = compileNormalizedDefinition(
    normalizedDefinitionBytes,
    expectedActiveRelease,
    compilerSemanticProfileVersion,
    unboundPermissionAcknowledgement,
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
    typeof compileApplicationRelease
  >[0]['expectedActiveRelease'],
  recordedReleaseRoot: string,
  recordedProfileVersion: CompilerSemanticProfileVersion,
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
        compilerSemanticProfileVersion: recordedProfileVersion,
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
    typeof compileApplicationRelease
  >[0]['expectedActiveRelease'],
  // Defaults to today's adopted profile, which is correct for a freshly minted
  // head. A RECORDED entry must pass its own, or its output is compared against
  // a serialization it was never compiled to produce.
  compilerSemanticProfileVersion: CompilerSemanticProfileVersion | undefined,
  unboundPermissionAcknowledgement: UnboundPermissionAcknowledgementInput,
): CompileResult {
  const normalizedDefinition = parseNormalizedApplicationPackageJson(
    normalizedDefinitionBytes,
  );
  return compileApplicationRelease(
    {
      dependencies: [],
      expectedActiveRelease,
      kind: 'compilerInput',
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes,
      profile: {
        ...MODULE_COMPILER_PROFILE,
        compilerSemanticProfileVersion:
          compilerSemanticProfileVersion ??
          MODULE_COMPILER_PROFILE.compilerSemanticProfileVersion,
        languageVersion: normalizedDefinition.languageVersion,
        normalizationProfileVersion:
          normalizedDefinition.normalizationProfileVersion,
      },
    },
    unboundPermissionAcknowledgement,
  );
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
