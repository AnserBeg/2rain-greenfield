export const COMPILER_VERSION = 'northstar.compiler/0.1.0' as const;
export const COMPILER_SEMANTIC_PROFILE_VERSION =
  'northstar.compiler-semantic/v0-experimental' as const;
export const OUTPUT_PROTOCOL_VERSION =
  'northstar.compiler-output/v0-experimental' as const;
export const RELEASE_MANIFEST_VERSION =
  'northstar.release-manifest/v0-experimental' as const;
export const PROJECTION_MANIFEST_VERSION =
  'northstar.projection-manifest/v0-experimental' as const;
export const CHUNK_DESCRIPTOR_VERSION =
  'northstar.chunk-descriptor/v0-experimental' as const;
export const CHUNKING_SCHEME_VERSION =
  'northstar.chunking.single/v0-experimental' as const;
export const COMPILER_DIAGNOSTIC_VERSION =
  'northstar.compiler-diagnostic/v0-experimental' as const;
export const RELEASE_DIFF_VERSION =
  'northstar.release-diff/v0-experimental' as const;
export const RELEASE_DIFF_ALGORITHM_VERSION =
  'northstar.release-diff-algorithm/v0-experimental' as const;
export const COMPILER_ATTESTATION_VERSION =
  'northstar.compiler-attestation/v0-experimental' as const;
export const POLICY_MODEL_VERSION =
  'northstar.policy-model/v0-experimental' as const;
export const HASH_ALGORITHM = 'sha256' as const;

export const HASH_DOMAINS = Object.freeze({
  cacheInput: 'northstar.compiler.cache-input/v0-experimental',
  compilerAttestation: 'northstar.compiler.attestation/v0-experimental',
  dependencyClosure: 'northstar.compiler.dependency-closure/v0-experimental',
  diff: 'northstar.compiler.release-diff/v0-experimental',
  limits: 'northstar.compiler.limits/v0-experimental',
  nodeOutput: 'northstar.compiler.node-output/v0-experimental',
  profile: 'northstar.compiler.semantic-profile/v0-experimental',
  projectionChunk: 'northstar.compiler.projection-chunk/v0-experimental',
  projectionManifest: 'northstar.compiler.projection-manifest/v0-experimental',
  projectionSemantic: 'northstar.compiler.projection-semantic/v0-experimental',
  releaseManifest: 'northstar.compiler.release-manifest/v0-experimental',
  semanticConstruct: 'northstar.compiler.semantic-construct/v0-experimental',
} as const);

export const PROJECTION_FAMILY_IDS = Object.freeze({
  agentDiscovery: 'northstar.compiler:projection-family.agent-discovery',
  operationCatalog: 'northstar.compiler:projection-family.operation-catalog',
  policyReferences: 'northstar.compiler:projection-family.policy-references',
  queryCatalog: 'northstar.compiler:projection-family.query-catalog',
  semanticModel: 'northstar.compiler:projection-family.semantic-model',
  storageTarget: 'northstar.compiler:projection-family.storage-target',
  storageTransition: 'northstar.compiler:projection-family.storage-transition',
  surfaceManifest: 'northstar.compiler:projection-family.surface-manifest',
  verificationPlan: 'northstar.compiler:projection-family.verification-plan',
} as const);

export type ProjectionFamilyId =
  (typeof PROJECTION_FAMILY_IDS)[keyof typeof PROJECTION_FAMILY_IDS];

export const REQUIRED_BASE_PROJECTION_FAMILIES: readonly ProjectionFamilyId[] =
  Object.freeze([
    PROJECTION_FAMILY_IDS.agentDiscovery,
    PROJECTION_FAMILY_IDS.operationCatalog,
    PROJECTION_FAMILY_IDS.policyReferences,
    PROJECTION_FAMILY_IDS.queryCatalog,
    PROJECTION_FAMILY_IDS.semanticModel,
    PROJECTION_FAMILY_IDS.storageTarget,
    PROJECTION_FAMILY_IDS.surfaceManifest,
    PROJECTION_FAMILY_IDS.verificationPlan,
  ]);

export const OPERATIONS_AGENT_TOOL_IDS = Object.freeze([
  'erp_discover',
  'erp_query',
  'erp_plan',
  'erp_execute',
  'erp_verify',
] as const);

export const INCREMENTAL_EQUIVALENCE_INVARIANT =
  'any cached, memoized, incremental, or parallel compile mode must produce bit-identical release roots and artifacts to a cold full compile for the same cache input identity' as const;

export interface CompilerSemanticProfile {
  canonicalizationProfileVersion: string;
  chunkingSchemeVersion: typeof CHUNKING_SCHEME_VERSION;
  compilerSemanticProfileVersion: typeof COMPILER_SEMANTIC_PROFILE_VERSION;
  compilerVersion: typeof COMPILER_VERSION;
  hashAlgorithm: typeof HASH_ALGORITHM;
  languageVersion: string;
  normalizationProfileVersion: string;
  outputProtocolVersion: typeof OUTPUT_PROTOCOL_VERSION;
  policyModelVersion: typeof POLICY_MODEL_VERSION;
}

export interface CompilerLimits {
  maximumChunksPerProjection: number;
  maximumDiagnostics: number;
  maximumOutputBytes: number;
}

export interface CompilerDependency {
  contentDigest: string;
  dependencyId: string;
  requiredRuntimeCapability: RuntimeCapabilityRequirement;
  version: string;
}

export interface ExpectedActiveRelease {
  normalizedDefinitionDigest: string;
  releaseManifestBytes: Uint8Array;
  releaseRoot: string;
  storageTargetArtifactRoot: string;
  storageTargetCanonicalBytes: Uint8Array;
  storageTargetProjectionManifestBytes: Uint8Array;
  storageTargetSemanticDigest: string;
}

export interface CompilerInput {
  dependencies: CompilerDependency[];
  expectedActiveRelease: ExpectedActiveRelease | null;
  kind: 'compilerInput';
  limits: CompilerLimits;
  normalizedDefinitionBytes: Uint8Array;
  profile: CompilerSemanticProfile;
}

export interface CompilerExecutionOptions {
  projectionSchedule?: 'canonical' | 'interleaved' | 'reverse';
}

export type CompilerPhase =
  | 'decodeSchemaCheck'
  | 'collectSymbols'
  | 'resolve'
  | 'typeCheck'
  | 'wholeModelValidation'
  | 'lowerTypedIr'
  | 'postLoweringValidation'
  | 'emit'
  | 'verifyCompleteness'
  | 'hashRelease';

export interface CompilerDiagnostic {
  acceptedAlternative: string;
  code: string;
  diagnosticVersion: typeof COMPILER_DIAGNOSTIC_VERSION;
  occurrenceIndex: number;
  path: string;
  phase: CompilerPhase;
  rule: string;
  severity: 'error';
  subjectId: string | null;
}

export interface RuntimeCapabilityRequirement {
  capabilityId: string;
  minimumVersion: number;
}

export interface LogicalScope {
  kind: 'packageScope' | 'storageTransitionScope';
  scopeId: string;
}

export interface ProjectionCompatibility {
  additiveInstances: 'allowed';
  minimumReaderProtocolVersion: typeof OUTPUT_PROTOCOL_VERSION;
  retirement: 'requiresNewProtocolOrExplicitOptionality';
  unknownRequiredFamily: 'reject';
  versionChange: 'newFamilyOrPayloadVersion';
}

export interface ProjectionChunkDescriptor {
  byteLength: number;
  chunkDescriptorVersion: typeof CHUNK_DESCRIPTOR_VERSION;
  chunkId: string;
  contentHash: string;
  logicalScope: LogicalScope;
  mediaType: 'application/vnd.northstar.canonical+json';
}

export interface ProjectionManifestEnvelope {
  chunkingSchemeVersion: typeof CHUNKING_SCHEME_VERSION;
  chunks: ProjectionChunkDescriptor[];
  compatibility: ProjectionCompatibility;
  familyId: ProjectionFamilyId;
  instanceId: string;
  kind: 'projectionManifest';
  logicalScope: LogicalScope;
  manifestVersion: typeof PROJECTION_MANIFEST_VERSION;
  outputProtocolVersion: typeof OUTPUT_PROTOCOL_VERSION;
  payloadSchemaVersion: string;
  requiredRuntimeCapability: RuntimeCapabilityRequirement;
  semanticDigest: string;
}

export interface ProjectionReference {
  artifactRoot: string;
  chunkingSchemeVersion: typeof CHUNKING_SCHEME_VERSION;
  compatibility: ProjectionCompatibility;
  familyId: ProjectionFamilyId;
  instanceId: string;
  logicalScope: LogicalScope;
  manifestVersion: typeof PROJECTION_MANIFEST_VERSION;
  outputProtocolVersion: typeof OUTPUT_PROTOCOL_VERSION;
  payloadSchemaVersion: string;
  requiredRuntimeCapability: RuntimeCapabilityRequirement;
  semanticDigest: string;
}

export interface CapabilityFact {
  capabilityId: string;
  capabilityVersion: number;
  declaredEffects: string[];
  requiredProjectionFamilies: ProjectionFamilyId[];
  supportStatus: 'supported';
}

export interface ReleaseManifestEnvelope {
  artifactClosure: string[];
  cacheInputDigest: string;
  canonicalizationProfileVersion: string;
  capabilityFacts: CapabilityFact[];
  compilerSemanticProfileVersion: typeof COMPILER_SEMANTIC_PROFILE_VERSION;
  compilerVersion: typeof COMPILER_VERSION;
  completeSnapshot: true;
  dependencyClosureDigest: string;
  hashAlgorithm: typeof HASH_ALGORITHM;
  kind: 'releaseManifest';
  languageVersion: string;
  limitsDigest: string;
  manifestVersion: typeof RELEASE_MANIFEST_VERSION;
  normalizationProfileVersion: string;
  normalizedDefinitionDigest: string;
  outputProtocolVersion: typeof OUTPUT_PROTOCOL_VERSION;
  policyDecisionDependency: 'liveCurrentDenyCapable';
  policyModelVersion: typeof POLICY_MODEL_VERSION;
  projections: ProjectionReference[];
  runtimeOverlayEvaluation: 'forbidden';
  semanticProfileDigest: string;
}

export interface ContentAddressedArtifact {
  artifactKind: 'projectionChunk' | 'projectionManifest' | 'releaseManifest';
  canonicalBytes: Uint8Array;
  contentHash: string;
  domainTag: string;
  kind: 'contentAddressedArtifact';
  mediaType: 'application/vnd.northstar.canonical+json';
}

export interface CompilationNodeContract {
  cacheInputIdentity: string;
  invalidationRule: 'recomputeWhenCacheInputIdentityChanges';
  normalizedInputDigest: string;
  orderedDependencyDigests: string[];
  outputFingerprint: string;
  semanticProfileIdentity: string;
  stableNodeId: string;
}

export interface CompiledReleaseBundle {
  artifacts: ContentAddressedArtifact[];
  kind: 'compiledReleaseBundle';
  nodeContracts: CompilationNodeContract[];
  outputProtocolVersion: typeof OUTPUT_PROTOCOL_VERSION;
  releaseManifest: ReleaseManifestEnvelope;
  releaseManifestBytes: Uint8Array;
}

export interface CompilerAttestation {
  attestationDigest: string;
  attestationVersion: typeof COMPILER_ATTESTATION_VERSION;
  cacheInputDigest: string;
  compileMode: 'coldFull';
  compilerSemanticProfileVersion: typeof COMPILER_SEMANTIC_PROFILE_VERSION;
  compilerVersion: typeof COMPILER_VERSION;
  dependencyClosureDigest: string;
  incrementalEquivalenceInvariant: typeof INCREMENTAL_EQUIVALENCE_INVARIANT;
  inputDefinitionDigest: string;
  kind: 'compilerAttestation';
  limitsDigest: string;
  releaseRoot: string;
}

export interface CompileSuccess {
  attestation: CompilerAttestation;
  bundle: CompiledReleaseBundle;
  diagnostics: [];
  releaseRoot: string;
  stagedArtifacts: ContentAddressedArtifact[];
  status: 'compiled';
}

export interface CompileFailure {
  attestation: null;
  bundle: null;
  diagnostics: CompilerDiagnostic[];
  releaseRoot: null;
  stagedArtifacts: ContentAddressedArtifact[];
  status: 'failed';
}

export type CompileResult = CompileSuccess | CompileFailure;

export const RELEASE_IMPACT_CODES = Object.freeze([
  'agent-discovery-changed',
  'authorization-surface-added',
  'operation-contract-changed',
  'policy-reference-changed',
  'query-contract-changed',
  'semantic-contract-changed',
  'storage-target-changed',
  'storage-transition-required',
  'surface-only',
  'verification-plan-changed',
] as const);

export type ReleaseImpactCode = (typeof RELEASE_IMPACT_CODES)[number];

export interface ReleaseChange {
  affectedProjections: string[];
  afterSemanticFingerprint: string | null;
  beforeSemanticFingerprint: string | null;
  changeKind: 'added' | 'changed' | 'removed';
  constructKind: string;
  impactCodes: ReleaseImpactCode[];
  subjectId: string;
}

export interface ReleaseDiffEnvelope {
  algorithmVersion: typeof RELEASE_DIFF_ALGORITHM_VERSION;
  canonicalDiffDigest: string;
  changes: ReleaseChange[];
  diffVersion: typeof RELEASE_DIFF_VERSION;
  fromManifestRoot: string;
  fromNormalizedDefinitionDigest: string;
  impactCodes: ReleaseImpactCode[];
  kind: 'releaseDiff';
  toManifestRoot: string;
  toNormalizedDefinitionDigest: string;
  transitionPlanDigest: string | null;
}

export interface CompilerTelemetryAttestation {
  activationMilliseconds: number | null;
  approvalMilliseconds: number | null;
  compileMilliseconds: number;
  incrementalCompileMilliseconds: number | null;
  kind: 'compilerTelemetryAttestation';
  previewMilliseconds: number | null;
  releaseRoot: string | null;
  transitionPreparationMilliseconds: number | null;
}
