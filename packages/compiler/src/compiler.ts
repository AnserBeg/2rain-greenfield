import {
  CANONICALIZATION_PROFILE_VERSION,
  LANGUAGE_VERSION,
  ADOPTED_LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  SUPPORTED_LANGUAGE_VERSIONS,
  CanonicalModelError,
  canonicalLanguageProfileFor,
  languageHasV3Features,
  canonicalizeAndHash,
  parseNormalizedApplicationPackageJson,
  type CanonicalDiagnostic,
  type NormalizedApplicationPackage,
  type V3NormalizedApplicationPackage,
  type V4NormalizedApplicationPackage,
  type VersionedNormalizedApplicationPackage,
} from '@north-star/canonical-model';

import { validateModuleConformance } from './conformance.js';
import { compilerDiagnostic, finalizeDiagnostics } from './diagnostics.js';
import {
  canonicalBytes,
  equalBytes,
  hashBytes,
  hashCanonical,
  isSha256,
} from './hash.js';
import {
  legalEntityScopeCatalogEntry,
  lowerBaseProjectionPayloads,
  queryParameterCatalogEntries,
  requiredProjectionFamily,
  verificationAssertionEntityId,
  type ProjectionPayloadPlan,
} from './projections.js';
import {
  isPredicateLoweringAdmitted,
  lowerQueryAggregate,
  lowerQueryPredicate,
} from './predicate-lowering.js';
import {
  buildStorageTransitionEnvelope,
  buildStorageTransitionEnvelopeFromLegacyTargets,
  validatePhysicalMappingRecords,
  type StorageTargetPayloadV1,
} from './storage.js';
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
  REQUIRED_MODULE_PROJECTION_FAMILIES,
  STORAGE_TARGET_PAYLOAD_VERSION,
  STORAGE_TARGET_PAYLOAD_V2_VERSION,
  STORAGE_TARGET_PAYLOAD_V3_VERSION,
  STORAGE_TRANSITION_ENVELOPE_VERSION,
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
  type StorageTransitionEnvelope,
} from './protocol.js';

const compilerProfileBase = Object.freeze({
  canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
  chunkingSchemeVersion: CHUNKING_SCHEME_VERSION,
  compilerSemanticProfileVersion: COMPILER_SEMANTIC_PROFILE_VERSION,
  compilerVersion: COMPILER_VERSION,
  hashAlgorithm: HASH_ALGORITHM,
  outputProtocolVersion: OUTPUT_PROTOCOL_VERSION,
  policyModelVersion: POLICY_MODEL_VERSION,
});

const supportedCompilerProfiles: readonly CompilerSemanticProfile[] =
  Object.freeze(
    SUPPORTED_LANGUAGE_VERSIONS.map((languageVersion) =>
      Object.freeze({
        ...compilerProfileBase,
        languageVersion,
        normalizationProfileVersion:
          canonicalLanguageProfileFor(languageVersion)
            .normalizationProfileVersion,
      }),
    ),
  );

// Keyed to the ADOPTED version, not the latest readable one. A newly cut but
// unadopted version must not silently become every caller's default profile.
export const DEFAULT_COMPILER_PROFILE: CompilerSemanticProfile =
  supportedCompilerProfiles.find(
    (profile) => profile.languageVersion === ADOPTED_LANGUAGE_VERSION,
  )!;

export const MODULE_COMPILER_PROFILE: CompilerSemanticProfile =
  DEFAULT_COMPILER_PROFILE;

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
  if (
    input.profile.languageVersion !== packageRevision.languageVersion ||
    input.profile.normalizationProfileVersion !==
      packageRevision.normalizationProfileVersion
  ) {
    return failure(
      [
        compilerDiagnostic(
          'COMPILER_PROFILE_UNSUPPORTED',
          'decodeSchemaCheck',
          '$.profile',
          packageRevision.package.packageId,
        ),
      ],
      maximumDiagnostics,
    );
  }
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

  const previousStorageTarget = input.expectedActiveRelease
    ? parseStorageTarget(
        input.expectedActiveRelease.storageTargetCanonicalBytes,
      )
    : null;
  const basePlans = decorateV3ProjectionPlans(
    lowerBaseProjectionPayloads(
      projectionDispatchRevision(packageRevision),
      isStorageTargetV1(previousStorageTarget) ? previousStorageTarget : null,
      packageRevision,
    ),
    packageRevision,
  );
  const resolveStorageDiagnostics = validateResolveStorageConformance(
    packageRevision,
    basePlans,
  );
  if (resolveStorageDiagnostics.length > 0) {
    return failure(resolveStorageDiagnostics, maximumDiagnostics);
  }
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
  if (
    languageUsesModuleProjectionShape(packageRevision.languageVersion) &&
    isStorageTargetV1(storageProjection.payload)
  ) {
    const mappingDiagnostics = validatePhysicalMappingRecords(
      storageProjection.payload.physicalMapping.records,
    );
    if (mappingDiagnostics.length > 0) {
      return failure(
        mappingDiagnostics,
        maximumDiagnostics,
        flattenArtifacts(emittedBase),
      );
    }
  }

  const transition = input.expectedActiveRelease
    ? lowerStorageTransition(
        packageRevision,
        input.expectedActiveRelease,
        previousStorageTarget!,
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
    languageVersion: languageHasV3Features(packageRevision.languageVersion)
      ? packageRevision.languageVersion
      : LANGUAGE_VERSION,
    limitsDigest,
    manifestVersion: RELEASE_MANIFEST_VERSION,
    normalizationProfileVersion: languageHasV3Features(
      packageRevision.languageVersion,
    )
      ? canonicalLanguageProfileFor(packageRevision.languageVersion)
          .normalizationProfileVersion
      : NORMALIZATION_PROFILE_VERSION,
    normalizedDefinitionDigest,
    outputProtocolVersion: OUTPUT_PROTOCOL_VERSION,
    policyDecisionDependency: 'liveCurrentDenyCapable',
    policyModelVersion: POLICY_MODEL_VERSION,
    projections,
    runtimeOverlayEvaluation: 'forbidden',
    semanticProfileDigest,
  };
  const releaseManifestBytes = canonicalBytes(releaseManifest);
  if (
    totalStagedBytes + releaseManifestBytes.byteLength >
    input.limits.maximumOutputBytes
  ) {
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

function validateResolveStorageConformance(
  packageRevision: VersionedNormalizedApplicationPackage,
  plans: readonly ProjectionPayloadPlan[],
): CompilerDiagnostic[] {
  const storagePlan = plans.find(
    (plan) => plan.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  if (!storagePlan || !isStorageTargetV1(storagePlan.payload)) return [];
  const storageByEntity = new Map(
    storagePlan.payload.entities.map((entity) => [entity.entityId, entity]),
  );
  type VersionedQuery =
    VersionedNormalizedApplicationPackage['queries'][number];
  const resolveByEntity = new Map<string, VersionedQuery[]>();
  for (const query of packageRevision.queries) {
    if (
      query.lifecycle !== 'active' ||
      query.tier !== 'q0' ||
      query.queryType !== 'resolve'
    ) {
      continue;
    }
    const sourceEntityId = query.sourceEntity.targetId;
    const queries = resolveByEntity.get(sourceEntityId) ?? [];
    resolveByEntity.set(sourceEntityId, [...queries, query]);
  }
  const diagnostics: CompilerDiagnostic[] = [];
  for (const entity of packageRevision.entities.filter(
    (candidate) => candidate.lifecycle === 'active',
  )) {
    const storageEntity = storageByEntity.get(entity.entityId);
    if (!storageEntity) continue;
    const textBackedColumns = storageEntity.columns.filter((column) =>
      /^(?:text|character varying|varchar)/u.test(column.postgresqlType),
    );
    const resolveQueries = resolveByEntity.get(entity.entityId) ?? [];
    if (textBackedColumns.length > 0 && resolveQueries.length === 0) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_RESOLVE_QUERY_REQUIRED',
          'postLoweringValidation',
          '$.entities.resolveQuery',
          entity.entityId,
        ),
      );
    }
    const columnsById = new Map(
      storageEntity.columns.map((column) => [column.canonicalFieldId, column]),
    );
    for (const query of resolveQueries) {
      for (const [index, matchKey] of (
        query.resolveMatchKeys ?? []
      ).entries()) {
        const column = columnsById.get(matchKey.field.targetId);
        if (
          column &&
          /^(?:text|character varying|varchar)/u.test(column.postgresqlType)
        ) {
          continue;
        }
        diagnostics.push(
          compilerDiagnostic(
            'COMPILER_RESOLVE_MATCH_KEY_STORAGE_UNSUPPORTED',
            'postLoweringValidation',
            '$.queries.resolveMatchKeys.field',
            matchKey.matchKeyId,
            index,
          ),
        );
      }
    }
  }
  return diagnostics;
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
      packageRevision: VersionedNormalizedApplicationPackage;
    }
  | { diagnostics: CompilerDiagnostic[] } {
  try {
    const packageRevision = parseNormalizedApplicationPackageJson(bytes);
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
  packageRevision: VersionedNormalizedApplicationPackage,
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
    ['queryParameterReference', new Set<string>()],
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
    for (const matchKey of query.resolveMatchKeys ?? []) {
      add(matchKey.matchKeyId, matchKey.kind, []);
    }
    if (query.queryType === 'aggregate') {
      add(query.aggregate.selectionId, query.aggregate.kind, []);
      for (const parameter of query.parameters) {
        add(parameter.parameterId, parameter.kind, ['queryParameterReference']);
      }
    } else {
      for (const selection of query.selections) {
        add(selection.selectionId, selection.kind, []);
      }
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
  packageRevision: VersionedNormalizedApplicationPackage,
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
  packageRevision: VersionedNormalizedApplicationPackage,
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const fieldById = new Map(
    packageRevision.fields.map((field) => [field.fieldId, field] as const),
  );
  const queryById = new Map(
    packageRevision.queries.map((query) => [query.queryId, query] as const),
  );
  for (const query of packageRevision.queries) {
    if (query.queryType !== 'aggregate') {
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
    for (const matchKey of query.resolveMatchKeys ?? []) {
      if (
        fieldById.get(matchKey.field.targetId)?.entity.targetId !==
        query.sourceEntity.targetId
      ) {
        diagnostics.push(
          compilerDiagnostic(
            'COMPILER_TYPE_INVALID',
            'typeCheck',
            '$.queries.resolveMatchKeys.field',
            matchKey.matchKeyId,
          ),
        );
      }
    }
    if (query.queryType === 'aggregate') {
      const aggregateField = fieldById.get(query.aggregate.field.targetId);
      if (
        aggregateField?.entity.targetId !== query.sourceEntity.targetId ||
        aggregateField.presence !== 'required' ||
        (aggregateField.fieldType.kind !== 'exactDecimalFieldType' &&
          aggregateField.fieldType.kind !== 'quantityFieldType')
      ) {
        diagnostics.push(
          compilerDiagnostic(
            'COMPILER_TYPE_INVALID',
            'typeCheck',
            '$.queries.aggregate.field',
            query.aggregate.selectionId,
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
  packageRevision: VersionedNormalizedApplicationPackage,
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
  diagnostics.push(
    ...validateVerificationAssertionInvocations(packageRevision),
  );
  diagnostics.push(
    ...validateModuleConformance(
      projectionDispatchRevision(packageRevision),
      packageRevision,
    ),
  );
  return diagnostics;
}

function validateVerificationAssertionInvocations(
  packageRevision: VersionedNormalizedApplicationPackage,
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  for (const assertion of packageRevision.assertions.filter(
    (entry) => entry.lifecycle === 'active',
  )) {
    const resolved =
      verificationAssertionEntityId(packageRevision, assertion) !== undefined;
    if (!resolved) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_VERIFICATION_ASSERTION_INVOCATION_UNRESOLVED',
          'wholeModelValidation',
          assertion.invocation.kind === 'queryInvocation'
            ? '$.assertions.invocation.query'
            : '$.assertions.invocation.operation',
          assertion.assertionId,
        ),
      );
    }
  }
  return diagnostics;
}

function languageUsesModuleProjectionShape(
  languageVersion: VersionedNormalizedApplicationPackage['languageVersion'],
): boolean {
  const featureLevel =
    canonicalLanguageProfileFor(languageVersion).featureLevel;
  return (
    featureLevel === 'v2' || featureLevel === 'v3' || featureLevel === 'v4'
  );
}

/**
 * Existing projection families retain their v2 physical interpretation at v3.
 * Canonical node-version markers are projected back to v2 before those
 * families calculate physical fingerprints; v3-only metadata is added later
 * by decorateV3ProjectionPlans. This alias is never hashed as the normalized
 * definition.
 */
function isV3PlusRevision(
  packageRevision: VersionedNormalizedApplicationPackage,
): packageRevision is
  V3NormalizedApplicationPackage | V4NormalizedApplicationPackage {
  return languageHasV3Features(packageRevision.languageVersion);
}

function projectionDispatchRevision(
  packageRevision: VersionedNormalizedApplicationPackage,
): NormalizedApplicationPackage {
  if (!isV3PlusRevision(packageRevision)) {
    return packageRevision;
  }
  const common = Object.fromEntries(
    Object.entries(packageRevision).filter(([key]) => key !== 'impactAnalyses'),
  ) as Omit<
    Extract<
      VersionedNormalizedApplicationPackage,
      { languageVersion: 'v3' | 'v4' }
    >,
    'impactAnalyses'
  >;
  return {
    ...common,
    fields: packageRevision.fields.map((field) => ({
      ...field,
      fieldType:
        field.fieldType.kind === 'enumFieldType'
          ? {
              ...field.fieldType,
              options: field.fieldType.options.map((option) => ({
                ...option,
                schemaVersion: LANGUAGE_VERSION,
              })),
              schemaVersion: LANGUAGE_VERSION,
            }
          : { ...field.fieldType, schemaVersion: LANGUAGE_VERSION },
    })),
    languageVersion: LANGUAGE_VERSION,
    operations: packageRevision.operations.map((operation) => ({
      ...operation,
      precondition: {
        kind: 'booleanPredicate' as const,
        schemaVersion: LANGUAGE_VERSION,
        value: true,
      },
    })),
    queries: packageRevision.queries
      .filter((query) => query.queryType !== 'aggregate')
      .map((query) => {
        // The v2 alias must be a v2 shape. v4 row members are dropped here and
        // re-attached by the version-aware decoration, exactly as the aggregate
        // branch already is; leaving them on would let a v2 physical family
        // read a member no v2 reader knows.
        const v2 = Object.fromEntries(
          Object.entries(query).filter(
            ([key]) => key !== 'legalEntityScope' && key !== 'parameters',
          ),
        ) as typeof query;
        return {
          ...v2,
          filter: {
            kind: 'booleanPredicate' as const,
            schemaVersion: LANGUAGE_VERSION,
            value: true,
          },
        };
      }),
  };
}

function aggregateMeasureFieldType(
  query: Extract<
    VersionedNormalizedApplicationPackage['queries'][number],
    { queryType: 'aggregate' }
  >,
  packageRevision: VersionedNormalizedApplicationPackage,
): VersionedNormalizedApplicationPackage['fields'][number]['fieldType'] {
  const field = packageRevision.fields.find(
    (candidate) => candidate.fieldId === query.aggregate.field.targetId,
  );
  if (!field) {
    throw new TypeError(
      'aggregate measure field has no canonical field definition',
    );
  }
  return structuredClone(field.fieldType);
}

function decorateV3ProjectionPlans(
  plans: ProjectionPayloadPlan[],
  packageRevision: VersionedNormalizedApplicationPackage,
): ProjectionPayloadPlan[] {
  if (!languageHasV3Features(packageRevision.languageVersion)) return plans;
  const dispatchRevision = projectionDispatchRevision(packageRevision);
  const storagePlan = plans.find(
    (plan) => plan.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  if (!storagePlan || !isStorageTargetV1(storagePlan.payload)) {
    throw new TypeError('v3 projection decoration requires a storage target');
  }
  const storage = storagePlan.payload;
  return plans.map((plan) => {
    if (plan.familyId === PROJECTION_FAMILY_IDS.queryCatalog) {
      const payload = plan.payload as {
        kind: string;
        queries: Array<Record<string, unknown>>;
        schemaVersion: string;
      };
      return {
        ...plan,
        payload: {
          ...payload,
          queries: packageRevision.queries
            .map((query) =>
              query.queryType === 'aggregate'
                ? {
                    ...lowerQueryAggregate(query, packageRevision, storage),
                    aggregate: {
                      fieldId: query.aggregate.field.targetId,
                      measureFieldType: aggregateMeasureFieldType(
                        query,
                        packageRevision,
                      ),
                      operator: query.aggregate.operator,
                      resultType: query.aggregate.resultType,
                      selectionId: query.aggregate.selectionId,
                    },
                    filter: query.filter,
                    ...legalEntityScopeCatalogEntry(query),
                    lifecycle: query.lifecycle,
                    maximumResultCount: query.maximumResultCount,
                    parameters: queryParameterCatalogEntries(query),
                    permissionId: query.permission.targetId,
                    queryId: query.queryId,
                    queryType: query.queryType,
                    resultContract: {
                      kind: 'semanticAggregateResult',
                      outcome: 'exact',
                      schemaVersion: 'northstar.semantic-aggregate-result/v1',
                    },
                    sourceEntityId: query.sourceEntity.targetId,
                    tier: query.tier,
                  }
                : {
                    filter: query.filter,
                    ...(query.tier === 'q1' &&
                    isPredicateLoweringAdmitted(query.filter)
                      ? {
                          filterPlan: lowerQueryPredicate(
                            query.filter,
                            query.sourceEntity.targetId,
                            dispatchRevision,
                            storage,
                          ),
                        }
                      : {}),
                    infrastructure: {
                      archive: 'nullableArchivedAt',
                      optimisticRevision: 'requiredOnMutation',
                      recordIdentity: 'canonicalUuid',
                    },
                    ...legalEntityScopeCatalogEntry(query),
                    lifecycle: query.lifecycle,
                    maximumResultCount: query.maximumResultCount,
                    ...('parameters' in query
                      ? { parameters: queryParameterCatalogEntries(query) }
                      : {}),
                    permissionId: query.permission.targetId,
                    queryId: query.queryId,
                    queryType: query.queryType,
                    resolveMatchKeys: (query.resolveMatchKeys ?? []).map(
                      (matchKey) => ({
                        authority: matchKey.authority,
                        fieldId: matchKey.field.targetId,
                        matchKeyId: matchKey.matchKeyId,
                        orderKey: matchKey.orderKey,
                      }),
                    ),
                    selections: query.selections.map((selection) => ({
                      fieldId: selection.field.targetId,
                      orderKey: selection.orderKey,
                      selectionId: selection.selectionId,
                    })),
                    sourceEntityId: query.sourceEntity.targetId,
                    tier: query.tier,
                  },
            )
            .sort((left, right) =>
              compare(String(left.queryId), String(right.queryId)),
            ),
        },
      };
    }
    if (plan.familyId === PROJECTION_FAMILY_IDS.operationCatalog) {
      const payload = plan.payload as {
        kind: string;
        operations: Array<Record<string, unknown>>;
        schemaVersion: string;
      };
      const preconditions = new Map<string, unknown>(
        packageRevision.operations.map((operation) => [
          String(operation.operationId),
          operation.precondition,
        ]),
      );
      return {
        ...plan,
        payload: {
          ...payload,
          operations: payload.operations.map((operation) => ({
            ...operation,
            precondition: preconditions.get(String(operation.operationId))!,
          })),
        },
      };
    }
    if (plan.familyId === PROJECTION_FAMILY_IDS.semanticModel) {
      const payload = plan.payload as {
        constructs: Array<{
          constructKind: string;
          semanticFingerprint: string;
          subjectId: string;
        }>;
        kind: string;
        schemaVersion: string;
      };
      const replacements = new Map<string, unknown>([
        ...packageRevision.queries.map(
          (query) => [query.queryId, query] as const,
        ),
        ...packageRevision.operations.map(
          (operation) => [operation.operationId, operation] as const,
        ),
      ]);
      const existingIds = new Set(
        payload.constructs.map((construct) => construct.subjectId),
      );
      const constructs = payload.constructs.map((construct) => {
        const source = replacements.get(construct.subjectId);
        return source === undefined
          ? construct
          : {
              ...construct,
              semanticFingerprint: hashCanonical(
                HASH_DOMAINS.semanticConstruct,
                source,
              ).digest,
            };
      });
      for (const [subjectId, source] of replacements) {
        if (existingIds.has(subjectId)) continue;
        constructs.push({
          constructKind: String(
            (source as { kind?: unknown }).kind ?? 'unknown',
          ),
          semanticFingerprint: hashCanonical(
            HASH_DOMAINS.semanticConstruct,
            source,
          ).digest,
          subjectId,
        });
      }
      constructs.sort((left, right) =>
        compare(left.subjectId, right.subjectId),
      );
      return { ...plan, payload: { ...payload, constructs } };
    }
    return plan;
  });
}

function validateProfile(
  profile: CompilerSemanticProfile,
): CompilerDiagnostic[] {
  return supportedCompilerProfiles.some((candidate) =>
    equalObjects(profile, candidate),
  )
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
    const storageReferences = releaseManifest.projections.filter(
      (entry) => entry.familyId === PROJECTION_FAMILY_IDS.storageTarget,
    );
    const storageReference = storageReferences[0];
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
      storageReferences.length === 1 &&
      storageReference?.artifactRoot === expected.storageTargetArtifactRoot &&
      equalObjects(storageReference, {
        artifactRoot: expected.storageTargetArtifactRoot,
        chunkingSchemeVersion: projectionManifest.chunkingSchemeVersion,
        compatibility: projectionManifest.compatibility,
        familyId: projectionManifest.familyId,
        instanceId: projectionManifest.instanceId,
        logicalScope: projectionManifest.logicalScope,
        manifestVersion: projectionManifest.manifestVersion,
        outputProtocolVersion: projectionManifest.outputProtocolVersion,
        payloadSchemaVersion: projectionManifest.payloadSchemaVersion,
        requiredRuntimeCapability: projectionManifest.requiredRuntimeCapability,
        semanticDigest: expected.storageTargetSemanticDigest,
      }) &&
      projectionManifest.kind === 'projectionManifest' &&
      projectionManifest.familyId === PROJECTION_FAMILY_IDS.storageTarget &&
      projectionManifest.manifestVersion === PROJECTION_MANIFEST_VERSION &&
      projectionManifest.outputProtocolVersion === OUTPUT_PROTOCOL_VERSION &&
      equalObjects(projectionManifest.compatibility, projectionCompatibility) &&
      projectionManifest.semanticDigest ===
        expected.storageTargetSemanticDigest &&
      projectionManifest.chunks.length === 1 &&
      chunk?.chunkDescriptorVersion === CHUNK_DESCRIPTOR_VERSION &&
      chunk?.byteLength === expected.storageTargetCanonicalBytes.byteLength &&
      equalObjects(chunk.logicalScope, projectionManifest.logicalScope) &&
      chunk.mediaType === 'application/vnd.northstar.canonical+json' &&
      chunk.contentHash ===
        hashBytes(
          projectionChunkDomain(PROJECTION_FAMILY_IDS.storageTarget),
          expected.storageTargetCanonicalBytes,
        ) &&
      releaseManifest.artifactClosure.includes(
        expected.storageTargetArtifactRoot,
      ) &&
      releaseManifest.artifactClosure.includes(chunk.contentHash) &&
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
      compatibility: projectionCompatibility,
      familyId: plan.familyId,
      instanceId: plan.instanceId,
      logicalScope: plan.logicalScope,
      manifestVersion: PROJECTION_MANIFEST_VERSION,
      outputProtocolVersion: OUTPUT_PROTOCOL_VERSION,
      payloadSchemaVersion: plan.payloadSchemaVersion,
      requiredRuntimeCapability: plan.requiredRuntimeCapability,
      semanticDigest,
    },
  };
}

function lowerStorageTransition(
  packageRevision: VersionedNormalizedApplicationPackage,
  expected: ExpectedActiveRelease,
  previous: StorageTargetPayload,
  candidateStorage: EmittedProjection,
  normalizedDefinitionDigest: string,
  semanticProfileDigest: string,
  orderedDependencyDigests: string[],
  cacheInputIdentity: string,
): EmittedProjection | { diagnostic: CompilerDiagnostic } {
  const candidate = candidateStorage.payload as StorageTargetPayload;
  if (isStorageTargetV1(candidateStorage.payload)) {
    if (!isStorageTargetV1(previous)) {
      return {
        diagnostic: compilerDiagnostic(
          'COMPILER_STORAGE_TRANSITION_UNSUPPORTED',
          'postLoweringValidation',
          '$.schemaVersion',
          packageRevision.package.packageId,
        ),
      };
    }
    const lowered = buildStorageTransitionEnvelope(
      projectionDispatchRevision(packageRevision),
      previous,
      candidateStorage.payload,
      {
        fromNormalizedDefinitionDigest: expected.normalizedDefinitionDigest,
        fromReleaseRoot: expected.releaseRoot,
        fromStorageTargetArtifactRoot: expected.storageTargetArtifactRoot,
        fromStorageTargetSemanticDigest: expected.storageTargetSemanticDigest,
        toNormalizedDefinitionDigest: normalizedDefinitionDigest,
        toStorageTargetArtifactRoot: candidateStorage.reference.artifactRoot,
        toStorageTargetSemanticDigest:
          candidateStorage.reference.semanticDigest,
      },
    );
    if ('diagnostic' in lowered) return lowered;
    return emitStorageTransitionProjection(
      packageRevision,
      expected,
      candidateStorage,
      lowered,
      normalizedDefinitionDigest,
      semanticProfileDigest,
      orderedDependencyDigests,
      cacheInputIdentity,
    );
  }
  if (isStorageTargetV1(previous)) {
    return {
      diagnostic: compilerDiagnostic(
        'COMPILER_STORAGE_TRANSITION_UNSUPPORTED',
        'postLoweringValidation',
        '$.schemaVersion',
        packageRevision.package.packageId,
      ),
    };
  }
  const legacyPrevious = previous as LegacyStorageTargetPayload;
  const legacyCandidate = candidate as LegacyStorageTargetPayload;
  const previousFields = collectStorageFields(legacyPrevious);
  const candidateFields = collectStorageFields(legacyCandidate);
  const additions: Array<{
    entityId: string;
    fieldId: string;
  }> = [];

  if (
    !equalObjects(
      storageEntitySkeletons(legacyPrevious),
      storageEntitySkeletons(legacyCandidate),
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
      additions.push({
        entityId: field.entityId,
        fieldId,
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
  additions.sort((left, right) => compare(left.fieldId, right.fieldId));
  const envelope = buildStorageTransitionEnvelopeFromLegacyTargets(additions, {
    fromNormalizedDefinitionDigest: expected.normalizedDefinitionDigest,
    fromReleaseRoot: expected.releaseRoot,
    fromStorageTargetArtifactRoot: expected.storageTargetArtifactRoot,
    fromStorageTargetSemanticDigest: expected.storageTargetSemanticDigest,
    toNormalizedDefinitionDigest: normalizedDefinitionDigest,
    toStorageTargetArtifactRoot: candidateStorage.reference.artifactRoot,
    toStorageTargetSemanticDigest: candidateStorage.reference.semanticDigest,
  });
  return emitStorageTransitionProjection(
    packageRevision,
    expected,
    candidateStorage,
    envelope,
    normalizedDefinitionDigest,
    semanticProfileDigest,
    orderedDependencyDigests,
    cacheInputIdentity,
  );
}

function emitStorageTransitionProjection(
  packageRevision: VersionedNormalizedApplicationPackage,
  expected: ExpectedActiveRelease,
  candidateStorage: EmittedProjection,
  payload: StorageTransitionEnvelope,
  normalizedDefinitionDigest: string,
  semanticProfileDigest: string,
  orderedDependencyDigests: string[],
  cacheInputIdentity: string,
): EmittedProjection {
  const namespace = packageRevision.package.namespace;
  const plan: ProjectionPayloadPlan = {
    familyId: PROJECTION_FAMILY_IDS.storageTransition,
    instanceId: `${namespace}:projection.storage-transition.${expected.storageTargetArtifactRoot.slice(0, 12)}.${candidateStorage.reference.artifactRoot.slice(0, 12)}`,
    logicalScope: {
      kind: 'storageTransitionScope',
      scopeId: `${expected.storageTargetArtifactRoot}:${candidateStorage.reference.artifactRoot}`,
    },
    payload,
    payloadSchemaVersion: STORAGE_TRANSITION_ENVELOPE_VERSION,
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
  packageRevision: VersionedNormalizedApplicationPackage,
  emitted: EmittedProjection[],
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const families = new Set(emitted.map((entry) => entry.reference.familyId));
  const requiredFamilies = languageUsesModuleProjectionShape(
    packageRevision.languageVersion,
  )
    ? REQUIRED_MODULE_PROJECTION_FAMILIES
    : REQUIRED_BASE_PROJECTION_FAMILIES;
  for (const familyId of requiredFamilies) {
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
  for (const requirement of packageRevision.capabilityRequirements.filter(
    (entry) =>
      entry.lifecycle === 'active' && entry.supportStatus === 'supported',
  )) {
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
  const emittedStorage = byFamily.get(
    PROJECTION_FAMILY_IDS.storageTarget,
  ) as StorageTargetPayload;
  const storageFieldIds = isStorageTargetV1(emittedStorage)
    ? emittedStorage.entities.flatMap((entity) =>
        entity.columns.map((field) => field.canonicalFieldId),
      )
    : [...collectStorageFields(emittedStorage).keys()];
  const expectedFields = new Set(
    packageRevision.fields.map((field) => field.fieldId),
  );
  if (!setsEqual(new Set(storageFieldIds), expectedFields)) {
    diagnostics.push(
      compilerDiagnostic(
        'COMPILER_PROJECTION_INVARIANT_FAILED',
        'verifyCompleteness',
        '$.projections.storageTarget.fields',
        packageRevision.package.packageId,
      ),
    );
  }
  const expectedStateFields = new Set(
    packageRevision.stateMachines.map((machine) => machine.stateField.fieldId),
  );
  const emittedStateFields = new Set(
    isStorageTargetV1(emittedStorage)
      ? emittedStorage.entities.flatMap((entity) =>
          entity.derivedStateFields.map((field) => field.fieldId),
        )
      : emittedStorage.entities.flatMap((entity) =>
          entity.derivedStateFields.map((field) => field.fieldId),
        ),
  );
  if (!setsEqual(emittedStateFields, expectedStateFields)) {
    diagnostics.push(
      compilerDiagnostic(
        'COMPILER_PROJECTION_INVARIANT_FAILED',
        'verifyCompleteness',
        '$.projections.storageTarget.derivedStateFields',
        packageRevision.package.packageId,
      ),
    );
  }
  const storageById = new Map(
    packageRevision.storageMappings.map((mapping) => [
      mapping.storageMappingId,
      mapping,
    ]),
  );
  for (const entity of emittedStorage.entities) {
    const source = packageRevision.entities.find(
      (candidate) => candidate.entityId === entity.entityId,
    );
    const selected = source ? storageById.get(source.storage.targetId) : null;
    if (
      !source ||
      !selected ||
      entity.storageMappingId !== selected.storageMappingId ||
      entity.storageClass !== selected.storageClass
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_PROJECTION_INVARIANT_FAILED',
          'verifyCompleteness',
          '$.projections.storageTarget.storageMapping',
          entity.entityId,
        ),
      );
    }
  }
  if (languageUsesModuleProjectionShape(packageRevision.languageVersion)) {
    const reporting = byFamily.get(PROJECTION_FAMILY_IDS.reporting) as {
      entities?: Array<{ entityId: string }>;
    };
    const expectedEntityIds = new Set(
      packageRevision.entities
        .filter((entity) => entity.lifecycle === 'active')
        .map((entity) => entity.entityId),
    );
    const reportingEntityIds = new Set(
      (reporting.entities ?? []).map((entity) => entity.entityId),
    );
    if (!setsEqual(reportingEntityIds, expectedEntityIds)) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_PROJECTION_INVARIANT_FAILED',
          'verifyCompleteness',
          '$.projections.reporting.entities',
          packageRevision.package.packageId,
        ),
      );
    }
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
      query !== undefined && query.queryType !== 'aggregate'
        ? query.selections.map((entry) => entry.field.targetId)
        : [];
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
  packageRevision: VersionedNormalizedApplicationPackage,
): CapabilityFact[] {
  return packageRevision.capabilityRequirements
    .filter(
      (requirement) =>
        requirement.lifecycle === 'active' &&
        requirement.supportStatus === 'supported',
    )
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

interface LegacyStorageTargetPayload {
  entities: Array<{
    derivedStateFields: Array<{
      fieldId: string;
      lifecycle: string;
      stateMachineId: string;
      valueKind: 'stateId';
    }>;
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

type StorageTargetPayload = LegacyStorageTargetPayload | StorageTargetPayloadV1;

function parseStorageTarget(bytes: Uint8Array): StorageTargetPayload {
  return JSON.parse(new TextDecoder().decode(bytes)) as StorageTargetPayload;
}

function isStorageTargetV1(value: unknown): value is StorageTargetPayloadV1 {
  const schemaVersion = (value as { schemaVersion?: unknown } | null)
    ?.schemaVersion;
  return (
    typeof value === 'object' &&
    value !== null &&
    (schemaVersion === STORAGE_TARGET_PAYLOAD_VERSION ||
      schemaVersion === STORAGE_TARGET_PAYLOAD_V2_VERSION ||
      schemaVersion === STORAGE_TARGET_PAYLOAD_V3_VERSION)
  );
}

function collectStorageFields(
  payload: LegacyStorageTargetPayload,
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

function storageEntitySkeletons(payload: LegacyStorageTargetPayload): unknown {
  return {
    entities: payload.entities.map((entity) => ({
      derivedStateFields: entity.derivedStateFields,
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
    if (
      /^(tenantId|coordinatorId|principalId|environmentId|approvalId)$/i.test(
        key,
      )
    ) {
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
