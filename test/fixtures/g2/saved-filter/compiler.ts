import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  compileApplication,
  type CompileSuccess,
  type CompilerInput,
  type ContentAddressedArtifact,
  type ProjectionFamilyId,
} from '../../../../packages/compiler/src/index.js';
import { platformModuleDefinition } from '../../../../packages/domain/src/platform/index.js';
import type {
  ImmutableJsonValue,
  LoadedRequestRuntimeDefinition,
  RequestRuntimeProjectionFamily,
  RuntimeProjection,
} from '../../../../packages/runtime/src/request-runtime-view.js';

export interface CompiledPlatformFixture {
  readonly compiled: CompileSuccess;
  readonly definition: Record<string, unknown>;
}

export function compilePlatformFixture(): CompiledPlatformFixture {
  const definition = platformModuleDefinition();
  const compiled = mustCompile(platformCompilerInput(definition));
  return { compiled, definition };
}

export function platformDefinitionBytes(definition: unknown): Uint8Array {
  return new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(definition)),
  );
}

export function platformCompilerInput(definition: unknown): CompilerInput {
  return {
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: platformDefinitionBytes(definition),
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

export function platformRuntimeProjections(
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

function projectionPayload<T>(
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
