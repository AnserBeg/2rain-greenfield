import {
  CANONICALIZATION_PROFILE_VERSION,
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  CanonicalModelError,
  canonicalizeAndHash,
  normalizeApplicationPackage,
  parseAuthoredApplicationPackageJson,
  type CanonicalDiagnostic,
  type NormalizedApplicationPackage,
} from '@north-star/canonical-model';

import { compilerDiagnostic, finalizeDiagnostics } from './diagnostics.js';
import {
  canonicalBytes,
  equalBytes,
  hashBytes,
  hashCanonical,
  isSha256,
} from './hash.js';
import {
  lowerBaseProjectionPayloads,
  requiredProjectionFamily,
  type ProjectionPayloadPlan,
} from './projections.js';
import {
  CHUNK_DESCRIPTOR_VERSION,
  CHUNKING_SCHEME_VERSION,
  COMPILER_ATTESTATION_VERSION,
  COMPILER_SEMANTIC_PROFILE_VERSION,
  COMPILER_VERSION,
  HASH_ALGORITHM,
  HASH_DOMAINS,
  INCREMENTAL_EQUIVALENCE_INVARIANT,
  OUTPUT_PROTOCOL_VERSION,
  POLICY_MODEL_VERSION,
  PROJECTION_FAMILY_IDS,
  PROJECTION_MANIFEST_VERSION,
  RELEASE_MANIFEST_VERSION,
  REQUIRED_BASE_PROJECTION_FAMILIES,
  type CapabilityFact,
  type CompilationNodeContract,
  type CompileFailure,
  type CompileResult,
  type CompilerAttestation,
  type CompilerDependency,
  type CompilerDiagnostic,
  type CompilerExecutionOptions,
  type CompilerInput,
  type CompilerLimits,
  type CompilerSemanticProfile,
  type CompileSuccess,
  type ContentAddressedArtifact,
  type ExpectedActiveRelease,
  type ProjectionManifestEnvelope,
  type ProjectionReference,
  type ReleaseManifestEnvelope,
} from './protocol.js';

export const DEFAULT_COMPILER_PROFILE: CompilerSemanticProfile = Object.freeze({
  canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
  chunkingSchemeVersion: CHUNKING_SCHEME_VERSION,
  compilerSemanticProfileVersion: COMPILER_SEMANTIC_PROFILE_VERSION,
  compilerVersion: COMPILER_VERSION,
  hashAlgorithm: HASH_ALGORITHM,
  languageVersion: LANGUAGE_VERSION,
  normalizationProfileVersion: NORMALIZATION_PROFILE_VERSION,
  outputProtocolVersion: OUTPUT_PROTOCOL_VERSION,
  policyModelVersion: POLICY_MODEL_VERSION,
});

export const DEFAULT_COMPILER_LIMITS: CompilerLimits = Object.freeze({
  maximumChunksPerProjection: 4_096,
  maximumDiagnostics: 64,
  maximumOutputBytes: 16_777_216,
});

const projectionCompatibility = Object.freeze({
  additiveInstances: 'allowed' as const,
  minimumReaderProtocolVersion: OUTPUT_PROTOCOL_VERSION,
  retirement: 'requiresNewProtocolOrExplicitOptionality' as const,
  unknownRequiredFamily: 'reject' as const,
  versionChange: 'newFamilyOrPayloadVersion' as const,
});

interface EmittedProjection {
  artifacts: ContentAddressedArtifact[];
  nodeContract: CompilationNodeContract;
  payload: unknown;
  reference: ProjectionReference;
}

export function compileApplication(
  input: CompilerInput,
  options: CompilerExecutionOptions = {},
): CompileResult {
  const maximumDiagnostics = validDiagnosticLimit(input?.limits)
    ? input.limits.maximumDiagnostics
    : DEFAULT_COMPILER_LIMITS.maximumDiagnostics;
  if (!isSerializableData(input)) {
    return failure(
      [
        compilerDiagnostic(
          'COMPILER_INPUT_NOT_SERIALIZABLE',
          'decodeSchemaCheck',
          '$',
          null,
        ),
      ],
      maximumDiagnostics,
    );
  }

  const inputDiagnostics = [
    ...validateProfile(input.profile),
    ...validateLimits(input.limits),
    ...validateDependencies(input.dependencies),
    ...validateExpectedActive(input.expectedActiveRelease),
  ];
  if (inputDiagnostics.length > 0) {
    return failure(inputDiagnostics, maximumDiagnostics);
  }

  const decoded = decodeNormalizedPackage(input.normalizedDefinitionBytes);
  if ('diagnostics' in decoded) {
    return failure(decoded.diagnostics, maximumDiagnostics);
  }

  const { normalizedDefinitionDigest, packageRevision } = decoded;
  const symbols = collectSymbols(packageRevision);
  if (symbols.diagnostics.length > 0) {
    return failure(symbols.diagnostics, maximumDiagnostics);
  }
  const resolutionDiagnostics = resolveReferences(packageRevision, symbols);
  if (resolutionDiagnostics.length > 0) {
    return failure(resolutionDiagnostics, maximumDiagnostics);
  }
  const typeDiagnostics = typeCheck(packageRevision);
  if (typeDiagnostics.length > 0) {
    return failure(typeDiagnostics, maximumDiagnostics);
  }

  const wholeModelDiagnostics = validateWholeModel(packageRevision);
  if (wholeModelDiagnostics.length > 0) {
    return failure(wholeModelDiagnostics, maximumDiagnostics);
  }

  const semanticProfileDigest = hashCanonical(
    HASH_DOMAINS.profile,
    input.profile,
  ).digest;
  const limitsDigest = hashCanonical(HASH_DOMAINS.limits, input.limits).digest;
  const orderedDependencies = [...input.dependencies].sort(compareDependencies);
  const dependencyClosureDigest = hashCanonical(
    HASH_DOMAINS.dependencyClosure,
    orderedDependencies,
  ).digest;
  const cacheInputDigest = hashCanonical(HASH_DOMAINS.cacheInput, {
    dependencyClosureDigest,
    expectedActiveRelease: input.expectedActiveRelease
      ? {
          normalizedDefinitionDigest:
            input.expectedActiveRelease.normalizedDefinitionDigest,
          releaseRoot: input.expectedActiveRelease.releaseRoot,
          storageTargetArtifactRoot:
            input.expectedActiveRelease.storageTargetArtifactRoot,
          storageTargetSemanticDigest:
            input.expectedActiveRelease.storageTargetSemanticDigest,
        }
      : null,
    limitsDigest,
    normalizedDefinitionDigest,
    semanticProfileDigest,
  }).digest;

  const basePlans = lowerBaseProjectionPayloads(packageRevision);
  const emittedBase = emitScheduledProjections(
    basePlans,
    normalizedDefinitionDigest,
    semanticProfileDigest,
    orderedDependencies.map((dependency) => dependency.contentDigest),
    cacheInputDigest,
    options.projectionSchedule ?? 'canonical',
  );
  const storageProjection = emittedBase.find(
    (entry) => entry.reference.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  if (!storageProjection) {
    return failure(
      [
        compilerDiagnostic(
          'COMPILER_PROJECTION_INVARIANT_FAILED',
          'postLoweringValidation',
          '$.projections',
          packageRevision.package.packageId,
        ),
      ],
      maximumDiagnostics,
      flattenArtifacts(emittedBase),
    );
  }

  const transition = input.expectedActiveRelease
    ? lowerStorageTransition(
        packageRevision,
        input.expectedActiveRelease,
        storageProjection,
        normalizedDefinitionDigest,
        semanticProfileDigest,
        orderedDependencies.map((dependency) => dependency.contentDigest),
        cacheInputDigest,
      )
    : null;
  if (transition && 'diagnostic' in transition) {
    return failure(
      [transition.diagnostic],
      maximumDiagnostics,
      flattenArtifacts(emittedBase),
    );
  }

  const emitted = transition ? [...emittedBase, transition] : emittedBase;
  const stagedArtifacts = sortArtifacts(flattenArtifacts(emitted));
  const completenessDiagnostics = verifyCompleteness(packageRevision, emitted);
  if (completenessDiagnostics.length > 0) {
    return failure(
      completenessDiagnostics,
      maximumDiagnostics,
      stagedArtifacts,
    );
  }

  const totalStagedBytes = stagedArtifacts.reduce(
    (sum, artifact) => sum + artifact.canonicalBytes.byteLength,
    0,
  );
  if (totalStagedBytes > input.limits.maximumOutputBytes) {
    return failure(
      [
        compilerDiagnostic(
          'COMPILER_OUTPUT_LIMIT_EXCEEDED',
          'emit',
          '$.artifacts',
          packageRevision.package.packageId,
        ),
      ],
      maximumDiagnostics,
      stagedArtifacts,
    );
  }

  const projections = emitted
    .map((entry) => entry.reference)
    .sort((left, right) => compare(left.instanceId, right.instanceId));
  const capabilityFacts = buildCapabilityFacts(packageRevision);
  const releaseManifest: ReleaseManifestEnvelope = {
    artifactClosure: stagedArtifacts
      .map((artifact) => artifact.contentHash)
      .sort(compare),
    cacheInputDigest,
    canonicalizationProfileVersion:
      input.profile.canonicalizationProfileVersion,
    capabilityFacts,
    compilerSemanticProfileVersion: COMPILER_SEMANTIC_PROFILE_VERSION,
    compilerVersion: COMPILER_VERSION,
    completeSnapshot: true,
    dependencyClosureDigest,
    hashAlgorithm: HASH_ALGORITHM,
    kind: 'releaseManifest',
    languageVersion: input.profile.languageVersion,
    limitsDigest,
    manifestVersion: RELEASE_MANIFEST_VERSION,
    normalizationProfileVersion: input.profile.normalizationProfileVersion,
    normalizedDefinitionDigest,
    outputProtocolVersion: OUTPUT_PROTOCOL_VERSION,
    policyDecisionDependency: 'liveCurrentDenyCapable',
    policyModelVersion: POLICY_MODEL_VERSION,
    projections,
    runtimeOverlayEvaluation: 'forbidden',
    semanticProfileDigest,
  };
  const releaseManifestBytes = canonicalBytes(releaseManifest);
  const releaseRoot = hashBytes(
    HASH_DOMAINS.releaseManifest,
    releaseManifestBytes,
  );
  const releaseArtifact: ContentAddressedArtifact = {
    artifactKind: 'releaseManifest',
    canonicalBytes: releaseManifestBytes,
    contentHash: releaseRoot,
    domainTag: HASH_DOMAINS.releaseManifest,
    kind: 'contentAddressedArtifact',
    mediaType: 'application/vnd.northstar.canonical+json',
  };
  const allArtifacts = sortArtifacts([...stagedArtifacts, releaseArtifact]);
  const totalOutputBytes = allArtifacts.reduce(
    (sum, artifact) => sum + artifact.canonicalBytes.byteLength,
    0,
  );
  if (totalOutputBytes > input.limits.maximumOutputBytes) {
    return failure(
      [
        compilerDiagnostic(
          'COMPILER_OUTPUT_LIMIT_EXCEEDED',
          'emit',
          '$.artifacts',
          packageRevision.package.packageId,
        ),
      ],
      maximumDiagnostics,
      allArtifacts,
    );
  }
  const nodeContracts = emitted
    .map((entry) => entry.nodeContract)
    .sort((left, right) => compare(left.stableNodeId, right.stableNodeId));
  const attestation = buildAttestation({
    cacheInputDigest,
    dependencyClosureDigest,
    inputDefinitionDigest: normalizedDefinitionDigest,
    limitsDigest,
    releaseRoot,
  });

  return {
    attestation,
    bundle: {
      artifacts: allArtifacts,
      kind: 'compiledReleaseBundle',
      nodeContracts,
      outputProtocolVersion: OUTPUT_PROTOCOL_VERSION,
      releaseManifest,
      releaseManifestBytes,
    },
    diagnostics: [],
    releaseRoot,
    stagedArtifacts: allArtifacts,
    status: 'compiled',
  };
}

export function expectedActiveReleaseFrom(
  compiled: CompileSuccess,
): ExpectedActiveRelease {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (entry) => entry.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  if (!reference) throw new Error('compiled bundle has no storage target');
  const manifestArtifact = compiled.bundle.artifacts.find(
    (entry) =>
      entry.artifactKind === 'projectionManifest' &&
      entry.contentHash === reference.artifactRoot,
  );
  if (!manifestArtifact) {
    throw new Error(
      'compiled bundle has no storage target projection manifest',
    );
  }
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  const chunkHash = manifest.chunks[0]?.contentHash;
  const chunk = compiled.bundle.artifacts.find(
    (entry) =>
      entry.artifactKind === 'projectionChunk' &&
      entry.contentHash === chunkHash,
  );
  if (!chunk) throw new Error('compiled bundle has no storage target chunk');
  return {
    normalizedDefinitionDigest:
      compiled.bundle.releaseManifest.normalizedDefinitionDigest,
    releaseManifestBytes: compiled.bundle.releaseManifestBytes,
    releaseRoot: compiled.releaseRoot,
    storageTargetArtifactRoot: reference.artifactRoot,
    storageTargetCanonicalBytes: chunk.canonicalBytes,
    storageTargetProjectionManifestBytes: manifestArtifact.canonicalBytes,
    storageTargetSemanticDigest: reference.semanticDigest,
  };
}

function decodeNormalizedPackage(bytes: Uint8Array):
  | {
      normalizedDefinitionDigest: string;
      packageRevision: NormalizedApplicationPackage;
    }
  | { diagnostics: CompilerDiagnostic[] } {
  try {
    const authored = parseAuthoredApplicationPackageJson(bytes);
    const packageRevision = normalizeApplicationPackage(authored);
    const canonical = canonicalizeAndHash(packageRevision);
    if (!equalBytes(bytes, canonical.bytes)) {
      return {
        diagnostics: [
          compilerDiagnostic(
            'COMPILER_INPUT_NOT_CANONICAL',
            'decodeSchemaCheck',
            '$',
            packageRevision.package.packageId,
          ),
        ],
      };
    }
    return {
      normalizedDefinitionDigest: canonical.contentHash,
      packageRevision,
    };
  } catch (error) {
    if (error instanceof CanonicalModelError) {
      return {
        diagnostics: error.diagnostics.map(mapCanonicalDiagnostic),
      };
    }
    return {
      diagnostics: [
        compilerDiagnostic(
          'COMPILER_DEFINITION_INVALID',
          'decodeSchemaCheck',
          '$',
          null,
        ),
      ],
    };
  }
}

function mapCanonicalDiagnostic(
  diagnostic: CanonicalDiagnostic,
  index: number,
): CompilerDiagnostic {
  return {
    acceptedAlternative: diagnostic.acceptedAlternative,
    code: diagnostic.code,
    diagnosticVersion: 'northstar.compiler-diagnostic/v0-experimental',
    occurrenceIndex: index,
    path: diagnostic.path,
    phase: 'decodeSchemaCheck',
    rule: diagnostic.rule,
    severity: 'error',
    subjectId: diagnostic.objectId,
  };
}

interface CompilerSymbols {
  byId: Map<string, string>;
  diagnostics: CompilerDiagnostic[];
  references: Map<string, Set<string>>;
}

function collectSymbols(
  packageRevision: NormalizedApplicationPackage,
): CompilerSymbols {
  const byId = new Map<string, string>();
  const diagnostics: CompilerDiagnostic[] = [];
  const references = new Map<string, Set<string>>([
    ['capabilityReference', new Set<string>()],
    ['entityReference', new Set<string>()],
    ['fieldReference', new Set<string>()],
    ['moduleReference', new Set<string>()],
    ['opaqueSurfaceContentReference', new Set<string>()],
    ['operationReference', new Set<string>()],
    ['permissionReference', new Set<string>()],
    ['queryReference', new Set<string>()],
    ['stateMachineReference', new Set<string>()],
    ['stateReference', new Set<string>()],
    ['storageMappingReference', new Set<string>()],
    ['surfaceReference', new Set<string>()],
    ['transitionReference', new Set<string>()],
    ['unitReference', new Set<string>()],
  ]);
  const add = (id: string, kind: string, referenceKinds: string[]) => {
    const existing = byId.get(id);
    if (existing) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_SYMBOL_DUPLICATE',
          'collectSymbols',
          '$',
          id,
        ),
      );
      return;
    }
    byId.set(id, kind);
    for (const referenceKind of referenceKinds) {
      references.get(referenceKind)?.add(id);
    }
  };

  add(packageRevision.package.packageId, packageRevision.package.kind, []);
  for (const value of packageRevision.modules) {
    add(value.moduleId, value.kind, ['moduleReference']);
  }
  for (const value of packageRevision.entities) {
    add(value.entityId, value.kind, ['entityReference']);
  }
  for (const value of packageRevision.fields) {
    add(value.fieldId, value.kind, ['fieldReference']);
  }
  for (const value of packageRevision.relations) {
    add(value.relationId, value.kind, []);
  }
  for (const machine of packageRevision.stateMachines) {
    add(machine.machineId, machine.kind, ['stateMachineReference']);
    add(machine.stateField.fieldId, machine.stateField.kind, []);
    for (const state of machine.states) {
      add(state.stateId, state.kind, ['stateReference']);
    }
    for (const transition of machine.transitions) {
      add(transition.transitionId, transition.kind, ['transitionReference']);
    }
  }
  for (const surface of packageRevision.surfaces) {
    add(surface.surfaceId, surface.kind, ['surfaceReference']);
    for (const slot of surface.slots) add(slot.slotId, slot.kind, []);
  }
  for (const query of packageRevision.queries) {
    add(query.queryId, query.kind, ['queryReference']);
    for (const selection of query.selections) {
      add(selection.selectionId, selection.kind, []);
    }
  }
  for (const value of packageRevision.operations) {
    add(value.operationId, value.kind, ['operationReference']);
  }
  for (const value of packageRevision.permissions) {
    add(value.permissionId, value.kind, ['permissionReference']);
  }
  for (const value of packageRevision.assertions) {
    add(value.assertionId, value.kind, []);
  }
  for (const value of packageRevision.storageMappings) {
    add(value.storageMappingId, value.kind, ['storageMappingReference']);
  }
  for (const value of packageRevision.capabilityRequirements) {
    add(value.capabilityId, value.kind, [
      'capabilityReference',
      'opaqueSurfaceContentReference',
      'unitReference',
    ]);
  }
  return { byId, diagnostics, references };
}

function resolveReferences(
  packageRevision: NormalizedApplicationPackage,
  symbols: CompilerSymbols,
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (
      typeof object.kind === 'string' &&
      typeof object.targetId === 'string' &&
      object.kind.endsWith('Reference')
    ) {
      const candidates = symbols.references.get(object.kind);
      if (!candidates?.has(object.targetId)) {
        diagnostics.push(
          compilerDiagnostic(
            'COMPILER_REFERENCE_UNRESOLVED',
            'resolve',
            path,
            object.targetId,
          ),
        );
      }
      return;
    }
    for (const [key, entry] of Object.entries(object)) {
      visit(entry, `${path}.${key}`);
    }
  };
  visit(packageRevision, '$');
  return diagnostics;
}

function typeCheck(
  packageRevision: NormalizedApplicationPackage,
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const fieldById = new Map(
    packageRevision.fields.map((field) => [field.fieldId, field] as const),
  );
  const queryById = new Map(
    packageRevision.queries.map((query) => [query.queryId, query] as const),
  );
  for (const query of packageRevision.queries) {
    for (const selection of query.selections) {
      if (
        fieldById.get(selection.field.targetId)?.entity.targetId !==
        query.sourceEntity.targetId
      ) {
        diagnostics.push(
          compilerDiagnostic(
            'COMPILER_TYPE_INVALID',
            'typeCheck',
            '$.queries.selections.field',
            selection.selectionId,
          ),
        );
      }
    }
  }
  for (const surface of packageRevision.surfaces) {
    const query = queryById.get(surface.dataSource.targetId);
    if (query?.module.targetId !== surface.module.targetId) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_TYPE_INVALID',
          'typeCheck',
          '$.surfaces.dataSource',
          surface.surfaceId,
        ),
      );
    }
  }
  return diagnostics;
}

function validateWholeModel(
  packageRevision: NormalizedApplicationPackage,
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  if (packageRevision.package.provenance !== 'firstParty') {
    diagnostics.push(
      compilerDiagnostic(
        'COMPILER_UNTRUSTED_INPUT_GATE_REQUIRED',
        'wholeModelValidation',
        '$.package.provenance',
        packageRevision.package.packageId,
      ),
    );
  }
  packageRevision.capabilityRequirements.forEach((requirement, index) => {
    if (
      requirement.lifecycle === 'active' &&
      requirement.supportStatus !== 'supported'
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_CAPABILITY_NOT_SUPPORTED',
          'wholeModelValidation',
          '$.capabilityRequirements.supportStatus',
          requirement.capabilityId,
          index,
        ),
      );
    }
  });
  return diagnostics;
}

function validateProfile(
  profile: CompilerSemanticProfile,
): CompilerDiagnostic[] {
  return equalObjects(profile, DEFAULT_COMPILER_PROFILE)
    ? []
    : [
        compilerDiagnostic(
          'COMPILER_PROFILE_UNSUPPORTED',
          'decodeSchemaCheck',
          '$.profile',
          null,
        ),
      ];
}

function validateLimits(limits: CompilerLimits): CompilerDiagnostic[] {
  const valid =
    Number.isSafeInteger(limits.maximumChunksPerProjection) &&
    limits.maximumChunksPerProjection >= 1 &&
    Number.isSafeInteger(limits.maximumDiagnostics) &&
    limits.maximumDiagnostics >= 1 &&
    Number.isSafeInteger(limits.maximumOutputBytes) &&
    limits.maximumOutputBytes >= 1;
  return valid
    ? []
    : [
        compilerDiagnostic(
          'COMPILER_PROFILE_UNSUPPORTED',
          'decodeSchemaCheck',
          '$.limits',
          null,
        ),
      ];
}

function validateDependencies(
  dependencies: CompilerDependency[],
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const seen = new Set<string>();
  dependencies.forEach((dependency, index) => {
    const identity = `${dependency.dependencyId}\u0000${dependency.version}`;
    if (
      seen.has(identity) ||
      !isSha256(dependency.contentDigest) ||
      !dependency.dependencyId ||
      !dependency.version ||
      !dependency.requiredRuntimeCapability.capabilityId ||
      !Number.isSafeInteger(
        dependency.requiredRuntimeCapability.minimumVersion,
      ) ||
      dependency.requiredRuntimeCapability.minimumVersion < 1
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_DEPENDENCY_INVALID',
          'resolve',
          `$.dependencies[${index}]`,
          dependency.dependencyId || null,
          index,
        ),
      );
    }
    seen.add(identity);
  });
  return diagnostics;
}

function validateExpectedActive(
  expected: ExpectedActiveRelease | null,
): CompilerDiagnostic[] {
  if (!expected) return [];
  try {
    const validHashes =
      isSha256(expected.normalizedDefinitionDigest) &&
      isSha256(expected.releaseRoot) &&
      isSha256(expected.storageTargetArtifactRoot) &&
      isSha256(expected.storageTargetSemanticDigest);
    const releaseManifest = parseCanonicalJson<ReleaseManifestEnvelope>(
      expected.releaseManifestBytes,
    );
    const projectionManifest = parseCanonicalJson<ProjectionManifestEnvelope>(
      expected.storageTargetProjectionManifestBytes,
    );
    const storageReference = releaseManifest.projections.find(
      (entry) => entry.familyId === PROJECTION_FAMILY_IDS.storageTarget,
    );
    const chunk = projectionManifest.chunks[0];
    const valid =
      validHashes &&
      releaseManifest.kind === 'releaseManifest' &&
      releaseManifest.manifestVersion === RELEASE_MANIFEST_VERSION &&
      releaseManifest.outputProtocolVersion === OUTPUT_PROTOCOL_VERSION &&
      releaseManifest.normalizedDefinitionDigest ===
        expected.normalizedDefinitionDigest &&
      hashBytes(HASH_DOMAINS.releaseManifest, expected.releaseManifestBytes) ===
        expected.releaseRoot &&
      storageReference?.artifactRoot === expected.storageTargetArtifactRoot &&
      storageReference.semanticDigest ===
        expected.storageTargetSemanticDigest &&
      projectionManifest.kind === 'projectionManifest' &&
      projectionManifest.familyId === PROJECTION_FAMILY_IDS.storageTarget &&
      projectionManifest.outputProtocolVersion === OUTPUT_PROTOCOL_VERSION &&
      projectionManifest.semanticDigest ===
        expected.storageTargetSemanticDigest &&
      projectionManifest.chunks.length === 1 &&
      chunk?.byteLength === expected.storageTargetCanonicalBytes.byteLength &&
      chunk.contentHash ===
        hashBytes(
          projectionChunkDomain(PROJECTION_FAMILY_IDS.storageTarget),
          expected.storageTargetCanonicalBytes,
        ) &&
      hashBytes(
        projectionSemanticDomain(PROJECTION_FAMILY_IDS.storageTarget),
        expected.storageTargetCanonicalBytes,
      ) === expected.storageTargetSemanticDigest &&
      hashBytes(
        projectionManifestDomain(PROJECTION_FAMILY_IDS.storageTarget),
        expected.storageTargetProjectionManifestBytes,
      ) === expected.storageTargetArtifactRoot;
    if (valid) return [];
  } catch {
    // Invalid stored bytes use stable compiler-owned diagnostic copy below.
  }
  return [
    compilerDiagnostic(
      'COMPILER_TRANSITION_BASE_INVALID',
      'resolve',
      '$.expectedActiveRelease',
      null,
    ),
  ];
}

function emitScheduledProjections(
  plans: ProjectionPayloadPlan[],
  normalizedDefinitionDigest: string,
  semanticProfileDigest: string,
  orderedDependencyDigests: string[],
  cacheInputIdentity: string,
  schedule: 'canonical' | 'interleaved' | 'reverse',
): EmittedProjection[] {
  const ordered = schedulePlans(plans, schedule);
  return ordered.map((plan) =>
    emitProjection(
      plan,
      normalizedDefinitionDigest,
      semanticProfileDigest,
      orderedDependencyDigests,
      cacheInputIdentity,
    ),
  );
}

function emitProjection(
  plan: ProjectionPayloadPlan,
  normalizedDefinitionDigest: string,
  semanticProfileDigest: string,
  orderedDependencyDigests: string[],
  cacheInputIdentity: string,
): EmittedProjection {
  const payloadBytes = canonicalBytes(plan.payload);
  const semanticDigest = hashBytes(
    projectionSemanticDomain(plan.familyId),
    payloadBytes,
  );
  const chunkHash = hashBytes(
    projectionChunkDomain(plan.familyId),
    payloadBytes,
  );
  const chunkArtifact: ContentAddressedArtifact = {
    artifactKind: 'projectionChunk',
    canonicalBytes: payloadBytes,
    contentHash: chunkHash,
    domainTag: projectionChunkDomain(plan.familyId),
    kind: 'contentAddressedArtifact',
    mediaType: 'application/vnd.northstar.canonical+json',
  };
  const projectionManifest: ProjectionManifestEnvelope = {
    chunkingSchemeVersion: CHUNKING_SCHEME_VERSION,
    chunks: [
      {
        byteLength: payloadBytes.byteLength,
        chunkDescriptorVersion: CHUNK_DESCRIPTOR_VERSION,
        chunkId: `${plan.instanceId}.chunk.root`,
        contentHash: chunkHash,
        logicalScope: plan.logicalScope,
        mediaType: 'application/vnd.northstar.canonical+json',
      },
    ],
    compatibility: projectionCompatibility,
    familyId: plan.familyId,
    instanceId: plan.instanceId,
    kind: 'projectionManifest',
    logicalScope: plan.logicalScope,
    manifestVersion: PROJECTION_MANIFEST_VERSION,
    outputProtocolVersion: OUTPUT_PROTOCOL_VERSION,
    payloadSchemaVersion: plan.payloadSchemaVersion,
    requiredRuntimeCapability: plan.requiredRuntimeCapability,
    semanticDigest,
  };
  const manifestBytes = canonicalBytes(projectionManifest);
  const artifactRoot = hashBytes(
    projectionManifestDomain(plan.familyId),
    manifestBytes,
  );
  const manifestArtifact: ContentAddressedArtifact = {
    artifactKind: 'projectionManifest',
    canonicalBytes: manifestBytes,
    contentHash: artifactRoot,
    domainTag: projectionManifestDomain(plan.familyId),
    kind: 'contentAddressedArtifact',
    mediaType: 'application/vnd.northstar.canonical+json',
  };
  return {
    artifacts: [chunkArtifact, manifestArtifact],
    nodeContract: {
      cacheInputIdentity,
      invalidationRule: 'recomputeWhenCacheInputIdentityChanges',
      normalizedInputDigest: normalizedDefinitionDigest,
      orderedDependencyDigests,
      outputFingerprint: hashCanonical(HASH_DOMAINS.nodeOutput, {
        artifactRoot,
        semanticDigest,
      }).digest,
      semanticProfileIdentity: semanticProfileDigest,
      stableNodeId: `${plan.instanceId}.node`,
    },
    payload: plan.payload,
    reference: {
      artifactRoot,
      chunkingSchemeVersion: CHUNKING_SCHEME_VERSION,
      familyId: plan.familyId,
      instanceId: plan.instanceId,
      logicalScope: plan.logicalScope,
      payloadSchemaVersion: plan.payloadSchemaVersion,
      requiredRuntimeCapability: plan.requiredRuntimeCapability,
      semanticDigest,
    },
  };
}

function lowerStorageTransition(
  packageRevision: NormalizedApplicationPackage,
  expected: ExpectedActiveRelease,
  candidateStorage: EmittedProjection,
  normalizedDefinitionDigest: string,
  semanticProfileDigest: string,
  orderedDependencyDigests: string[],
  cacheInputIdentity: string,
): EmittedProjection | { diagnostic: CompilerDiagnostic } {
  const previous = parseStorageTarget(expected.storageTargetCanonicalBytes);
  const candidate = candidateStorage.payload as StorageTargetPayload;
  const previousFields = collectStorageFields(previous);
  const candidateFields = collectStorageFields(candidate);
  const operations: Array<{
    entityId: string;
    fieldId: string;
    kind: 'addOptionalField';
  }> = [];

  if (
    !equalObjects(
      storageEntitySkeletons(previous),
      storageEntitySkeletons(candidate),
    )
  ) {
    return {
      diagnostic: compilerDiagnostic(
        'COMPILER_STORAGE_TRANSITION_UNSUPPORTED',
        'postLoweringValidation',
        '$.entities',
        packageRevision.package.packageId,
      ),
    };
  }

  for (const [fieldId, field] of candidateFields) {
    const previousField = previousFields.get(fieldId);
    if (!previousField) {
      if (field.presence !== 'optional') {
        return {
          diagnostic: compilerDiagnostic(
            'COMPILER_STORAGE_TRANSITION_UNSUPPORTED',
            'postLoweringValidation',
            '$.fields.presence',
            fieldId,
          ),
        };
      }
      operations.push({
        entityId: field.entityId,
        fieldId,
        kind: 'addOptionalField',
      });
    } else if (previousField.fingerprint !== field.fingerprint) {
      return {
        diagnostic: compilerDiagnostic(
          'COMPILER_STORAGE_TRANSITION_UNSUPPORTED',
          'postLoweringValidation',
          '$.fields',
          fieldId,
        ),
      };
    }
  }
  for (const fieldId of previousFields.keys()) {
    if (!candidateFields.has(fieldId)) {
      return {
        diagnostic: compilerDiagnostic(
          'COMPILER_STORAGE_TRANSITION_UNSUPPORTED',
          'postLoweringValidation',
          '$.fields',
          fieldId,
        ),
      };
    }
  }
  operations.sort((left, right) => compare(left.fieldId, right.fieldId));
  const payload = {
    fromNormalizedDefinitionDigest: expected.normalizedDefinitionDigest,
    fromReleaseRoot: expected.releaseRoot,
    fromStorageTargetArtifactRoot: expected.storageTargetArtifactRoot,
    fromStorageTargetSemanticDigest: expected.storageTargetSemanticDigest,
    kind: 'storageTransitionPayload',
    operations,
    schemaVersion: 'northstar.storage-transition-payload/v0-provisional',
    toNormalizedDefinitionDigest: normalizedDefinitionDigest,
    toStorageTargetArtifactRoot: candidateStorage.reference.artifactRoot,
    toStorageTargetSemanticDigest: candidateStorage.reference.semanticDigest,
  };
  const namespace = packageRevision.package.namespace;
  const plan: ProjectionPayloadPlan = {
    familyId: PROJECTION_FAMILY_IDS.storageTransition,
    instanceId: `${namespace}:projection.storage-transition.${expected.storageTargetArtifactRoot.slice(0, 12)}.${candidateStorage.reference.artifactRoot.slice(0, 12)}`,
    logicalScope: {
      kind: 'storageTransitionScope',
      scopeId: `${expected.storageTargetArtifactRoot}:${candidateStorage.reference.artifactRoot}`,
    },
    payload,
    payloadSchemaVersion: 'northstar.storage-transition-payload/v0-provisional',
    requiredRuntimeCapability: {
      capabilityId: 'northstar.runtime:capability.storage-transition',
      minimumVersion: 1,
    },
  };
  return emitProjection(
    plan,
    normalizedDefinitionDigest,
    semanticProfileDigest,
    orderedDependencyDigests,
    cacheInputIdentity,
  );
}

function verifyCompleteness(
  packageRevision: NormalizedApplicationPackage,
  emitted: EmittedProjection[],
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const families = new Set(emitted.map((entry) => entry.reference.familyId));
  for (const familyId of REQUIRED_BASE_PROJECTION_FAMILIES) {
    if (!families.has(familyId)) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_PROJECTION_REQUIRED_MISSING',
          'verifyCompleteness',
          '$.projections',
          familyId,
        ),
      );
    }
  }
  for (const requirement of packageRevision.capabilityRequirements) {
    for (const required of requirement.requiredProjections) {
      const familyId = requiredProjectionFamily(required);
      if (!familyId || !families.has(familyId)) {
        diagnostics.push(
          compilerDiagnostic(
            'COMPILER_PROJECTION_REQUIRED_MISSING',
            'verifyCompleteness',
            '$.capabilityRequirements.requiredProjections',
            requirement.capabilityId,
          ),
        );
      }
    }
  }

  const byFamily = new Map(
    emitted.map((entry) => [entry.reference.familyId, entry.payload] as const),
  );
  const storageFields = collectStorageFields(
    byFamily.get(PROJECTION_FAMILY_IDS.storageTarget) as StorageTargetPayload,
  );
  const expectedFields = new Set(
    packageRevision.fields.map((field) => field.fieldId),
  );
  if (!setsEqual(new Set(storageFields.keys()), expectedFields)) {
    diagnostics.push(
      compilerDiagnostic(
        'COMPILER_PROJECTION_INVARIANT_FAILED',
        'verifyCompleteness',
        '$.projections.storageTarget.fields',
        packageRevision.package.packageId,
      ),
    );
  }
  const surface = byFamily.get(PROJECTION_FAMILY_IDS.surfaceManifest) as {
    surfaces: Array<{ fieldIds: string[]; surfaceId: string }>;
  };
  const queryById = new Map(
    packageRevision.queries.map((query) => [query.queryId, query] as const),
  );
  for (const compiledSurface of surface.surfaces) {
    const source = packageRevision.surfaces.find(
      (entry) => entry.surfaceId === compiledSurface.surfaceId,
    );
    const query = source
      ? queryById.get(source.dataSource.targetId)
      : undefined;
    const expected =
      query?.selections.map((entry) => entry.field.targetId) ?? [];
    if (!arraysEqual(compiledSurface.fieldIds, expected)) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_PROJECTION_INVARIANT_FAILED',
          'verifyCompleteness',
          '$.projections.surfaceManifest.fieldIds',
          compiledSurface.surfaceId,
        ),
      );
    }
  }
  for (const entry of emitted) {
    if (containsForbiddenShareableIdentity(entry.payload)) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_PROJECTION_INVARIANT_FAILED',
          'verifyCompleteness',
          '$.projections',
          entry.reference.instanceId,
        ),
      );
    }
  }
  return diagnostics;
}

function buildCapabilityFacts(
  packageRevision: NormalizedApplicationPackage,
): CapabilityFact[] {
  return packageRevision.capabilityRequirements
    .map((requirement) => ({
      capabilityId: requirement.capabilityId,
      capabilityVersion: requirement.capabilityVersion,
      declaredEffects: [...requirement.declaredEffects].sort(compare),
      requiredProjectionFamilies: requirement.requiredProjections
        .map(requiredProjectionFamily)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort(compare),
      supportStatus: 'supported' as const,
    }))
    .sort((left, right) => compare(left.capabilityId, right.capabilityId));
}

function buildAttestation(
  core: Omit<
    CompilerAttestation,
    | 'attestationDigest'
    | 'attestationVersion'
    | 'compileMode'
    | 'compilerSemanticProfileVersion'
    | 'compilerVersion'
    | 'incrementalEquivalenceInvariant'
    | 'kind'
  >,
): CompilerAttestation {
  const value = {
    attestationVersion: COMPILER_ATTESTATION_VERSION,
    ...core,
    compileMode: 'coldFull' as const,
    compilerSemanticProfileVersion: COMPILER_SEMANTIC_PROFILE_VERSION,
    compilerVersion: COMPILER_VERSION,
    incrementalEquivalenceInvariant: INCREMENTAL_EQUIVALENCE_INVARIANT,
    kind: 'compilerAttestation' as const,
  };
  return {
    ...value,
    attestationDigest: hashCanonical(HASH_DOMAINS.compilerAttestation, value)
      .digest,
  };
}

function failure(
  diagnostics: CompilerDiagnostic[],
  maximumDiagnostics: number,
  stagedArtifacts: ContentAddressedArtifact[] = [],
): CompileFailure {
  return {
    attestation: null,
    bundle: null,
    diagnostics: finalizeDiagnostics(diagnostics, maximumDiagnostics),
    releaseRoot: null,
    stagedArtifacts: sortArtifacts(stagedArtifacts),
    status: 'failed',
  };
}

function schedulePlans(
  plans: ProjectionPayloadPlan[],
  schedule: 'canonical' | 'interleaved' | 'reverse',
): ProjectionPayloadPlan[] {
  const canonical = [...plans].sort((left, right) =>
    compare(left.instanceId, right.instanceId),
  );
  if (schedule === 'reverse') return canonical.reverse();
  if (schedule === 'interleaved') {
    return canonical
      .filter((_, index) => index % 2 === 0)
      .concat(canonical.filter((_, index) => index % 2 === 1));
  }
  return canonical;
}

function flattenArtifacts(
  projections: EmittedProjection[],
): ContentAddressedArtifact[] {
  return projections.flatMap((entry) => entry.artifacts);
}

function sortArtifacts(
  artifacts: ContentAddressedArtifact[],
): ContentAddressedArtifact[] {
  return [...artifacts].sort(
    (left, right) =>
      compare(left.artifactKind, right.artifactKind) ||
      compare(left.contentHash, right.contentHash),
  );
}

function projectionSemanticDomain(familyId: string): string {
  return `${HASH_DOMAINS.projectionSemantic}/${familyId}`;
}

function projectionChunkDomain(familyId: string): string {
  return `${HASH_DOMAINS.projectionChunk}/${familyId}`;
}

function projectionManifestDomain(familyId: string): string {
  return `${HASH_DOMAINS.projectionManifest}/${familyId}`;
}

interface StorageTargetPayload {
  entities: Array<{
    entityId: string;
    fields: Array<{
      classification: string;
      fieldId: string;
      fieldType: unknown;
      lifecycle: string;
      presence: string;
    }>;
    lifecycle: string;
    storageClass: string | null;
    storageMappingId: string;
  }>;
  kind: 'storageTargetPayload';
  schemaVersion: string;
}

function parseStorageTarget(bytes: Uint8Array): StorageTargetPayload {
  return JSON.parse(new TextDecoder().decode(bytes)) as StorageTargetPayload;
}

function collectStorageFields(
  payload: StorageTargetPayload,
): Map<string, { entityId: string; fingerprint: string; presence: string }> {
  const fields = new Map<
    string,
    { entityId: string; fingerprint: string; presence: string }
  >();
  for (const entity of payload.entities) {
    for (const field of entity.fields) {
      fields.set(field.fieldId, {
        entityId: entity.entityId,
        fingerprint: hashCanonical(
          `${HASH_DOMAINS.projectionSemantic}/${PROJECTION_FAMILY_IDS.storageTarget}/field`,
          { entityId: entity.entityId, field },
        ).digest,
        presence: field.presence,
      });
    }
  }
  return fields;
}

function storageEntitySkeletons(payload: StorageTargetPayload): unknown {
  return {
    entities: payload.entities.map((entity) => ({
      entityId: entity.entityId,
      lifecycle: entity.lifecycle,
      storageClass: entity.storageClass,
      storageMappingId: entity.storageMappingId,
    })),
    kind: payload.kind,
    schemaVersion: payload.schemaVersion,
  };
}

function parseCanonicalJson<T>(bytes: Uint8Array): T {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as T;
  if (!equalBytes(bytes, canonicalBytes(parsed))) {
    throw new Error('stored artifact bytes are not canonical');
  }
  return parsed;
}

function containsForbiddenShareableIdentity(value: unknown): boolean {
  if (Array.isArray(value))
    return value.some(containsForbiddenShareableIdentity);
  if (!value || typeof value !== 'object') return false;
  for (const [key, entry] of Object.entries(value)) {
    if (/tenant|coordinator|principal|environmentId|approvalId/i.test(key)) {
      return true;
    }
    if (containsForbiddenShareableIdentity(entry)) return true;
  }
  return false;
}

function validDiagnosticLimit(limits: CompilerLimits | undefined): boolean {
  return Boolean(
    limits &&
    Number.isSafeInteger(limits.maximumDiagnostics) &&
    limits.maximumDiagnostics >= 1,
  );
}

function isSerializableData(value: unknown, seen = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (value instanceof Uint8Array) return true;
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.every((entry) => isSerializableData(entry, seen));
  }
  if (typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (seen.has(object)) return false;
  seen.add(object);
  return Object.values(object).every((entry) =>
    isSerializableData(entry, seen),
  );
}

function compareDependencies(
  left: CompilerDependency,
  right: CompilerDependency,
): number {
  return (
    compare(left.dependencyId, right.dependencyId) ||
    compare(left.version, right.version) ||
    compare(left.contentDigest, right.contentDigest)
  );
}

function equalObjects(left: unknown, right: unknown): boolean {
  try {
    return equalBytes(canonicalBytes(left), canonicalBytes(right));
  } catch {
    return false;
  }
}

function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return (
    left.size === right.size && [...left].every((entry) => right.has(entry))
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
