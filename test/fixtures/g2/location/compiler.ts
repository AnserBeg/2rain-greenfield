import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../../../packages/canonical-model/src/index';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  expectedActiveReleaseFrom,
  type CompileSuccess,
  type CompilerInput,
  type ContentAddressedArtifact,
  type ProjectionFamilyId,
  type StorageTargetPayloadV1,
} from '../../../../packages/compiler/src/index';
import type {
  ImmutableJsonValue,
  LoadedRequestRuntimeDefinition,
  RequestRuntimeProjectionFamily,
  RuntimeProjection,
} from '../../../../packages/runtime/src/request-runtime-view';

import { locationModuleDefinition } from '../../../../packages/domain/src/location/index';

export interface CompiledLocationFixture {
  readonly compiled: CompileSuccess;
  readonly definition: Record<string, unknown>;
  readonly empty: CompileSuccess;
  readonly emptyDefinition: Record<string, unknown>;
}

export function compileLocationFixture(): CompiledLocationFixture {
  const definition = locationModuleDefinition();
  const emptyDefinition = emptyLocationDefinition(definition);
  const empty = mustCompile(locationCompilerInput(emptyDefinition));
  const compiled = mustCompile(
    locationCompilerInput(definition, expectedActiveReleaseFrom(empty)),
  );
  return { compiled, definition, empty, emptyDefinition };
}

export function emptyLocationDefinition(
  source: Record<string, unknown> = locationModuleDefinition(),
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

export function locationDefinitionBytes(definition: unknown): Uint8Array {
  return new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(definition)),
  );
}

export function locationCompilerInput(
  definition: unknown,
  expectedActiveRelease: CompilerInput['expectedActiveRelease'] = null,
): CompilerInput {
  return {
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: locationDefinitionBytes(definition),
    profile: { ...MODULE_COMPILER_PROFILE },
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
    (candidate) => candidate.familyId === familyId,
  );
  if (!reference) throw new Error(`missing projection ${familyId}`);
  const manifest = decode(artifact(compiled, reference.artifactRoot));
  if (!isRecord(manifest) || !Array.isArray(manifest.chunks)) {
    throw new Error(`invalid projection manifest ${familyId}`);
  }
  const descriptor = manifest.chunks[0];
  if (!isRecord(descriptor) || typeof descriptor.contentHash !== 'string') {
    throw new Error(`invalid projection chunk ${familyId}`);
  }
  return decode(artifact(compiled, descriptor.contentHash)) as T;
}

export function locationStorageTarget(
  compiled: CompileSuccess,
): StorageTargetPayloadV1 {
  return projectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
}

export function locationRuntimeProjections(
  compiled: CompileSuccess,
): LoadedRequestRuntimeDefinition['projections'] {
  return {
    agent: runtimeProjection(
      compiled,
      'northstar.compiler:projection-family.agent-discovery',
    ),
    catalog: runtimeProjection(
      compiled,
      'northstar.compiler:projection-family.semantic-model',
    ),
    operation: runtimeProjection(
      compiled,
      'northstar.compiler:projection-family.operation-catalog',
    ),
    query: runtimeProjection(
      compiled,
      'northstar.compiler:projection-family.query-catalog',
    ),
    surface: runtimeProjection(
      compiled,
      'northstar.compiler:projection-family.surface-manifest',
    ),
  };
}

function runtimeProjection<TFamily extends RequestRuntimeProjectionFamily>(
  compiled: CompileSuccess,
  familyId: TFamily,
): RuntimeProjection<TFamily> {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  if (!reference) throw new Error(`missing runtime projection ${familyId}`);
  return {
    artifactRoot: reference.artifactRoot,
    familyId,
    instanceId: reference.instanceId,
    payload: projectionPayload<ImmutableJsonValue>(compiled, familyId),
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  };
}

function artifact(
  compiled: CompileSuccess,
  contentHash: string,
): ContentAddressedArtifact {
  const value = compiled.bundle.artifacts.find(
    (candidate) => candidate.contentHash === contentHash,
  );
  if (!value) throw new Error(`missing artifact ${contentHash}`);
  return value;
}

function decode(value: ContentAddressedArtifact): unknown {
  return JSON.parse(new TextDecoder().decode(value.canonicalBytes)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
