export const COMPILER_VERSION = 'northstar.compiler/0.1.0' as const;
/**
 * Stable, append-only compiler-semantic profile identifiers, mirroring
 * `LANGUAGE_VERSIONS`. Cutting a reader appends a named constant and a
 * supported-list member; an existing version is never renamed or redefined.
 * The whole profile object is hashed into `releaseManifest.semanticProfileDigest`
 * (ADR-0047 §1), so this identifier is the per-entry discriminator on which a
 * compiled projection may evolve without invalidating recorded history.
 */
export const COMPILER_SEMANTIC_PROFILE_VERSION =
  'northstar.compiler-semantic/v0-experimental' as const;
export const COMPILER_SEMANTIC_PROFILE_V1_VERSION =
  'northstar.compiler-semantic/v1' as const;
/**
 * Cut by `U5b`, and deliberately NOT adopted.
 *
 * `U5-design` measured that a profile version freezes at ADOPTION, not at the
 * cut (probe preserved at `packet/u5-design` `38ade5b`): a field gated on the
 * adopted v1 fails `check:app-release` outright, while a field gated on a
 * cut-but-unadopted version leaves the entire lineage byte-identical.
 *
 * So v2 is an accumulation window. Projection fields land on it one packet at a
 * time and cost nothing; adoption is a separate, schedulable event that mints
 * exactly one lineage entry no matter how many fields accumulated first.
 * No DEFAULT compile and no recorded lineage entry uses v2 until
 * `ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION` moves. Tests do compile under it
 * by passing the version explicitly -- that is how a readable-but-unadopted
 * version is exercised at all -- and nothing they produce is recorded.
 */
export const COMPILER_SEMANTIC_PROFILE_V2_VERSION =
  'northstar.compiler-semantic/v2' as const;
export const SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS = Object.freeze([
  COMPILER_SEMANTIC_PROFILE_VERSION,
  COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  COMPILER_SEMANTIC_PROFILE_V2_VERSION,
] as const);
export type CompilerSemanticProfileVersion =
  (typeof SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS)[number];
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
export const STORAGE_TARGET_PAYLOAD_VERSION =
  'northstar.storage-target-payload/v1' as const;
export const STORAGE_TARGET_PAYLOAD_V2_VERSION =
  'northstar.storage-target-payload/v2' as const;
export const STORAGE_TARGET_PAYLOAD_V3_VERSION =
  'northstar.storage-target-payload/v3' as const;
export const SUPPORTED_STORAGE_TARGET_PAYLOAD_VERSIONS = Object.freeze([
  STORAGE_TARGET_PAYLOAD_VERSION,
  STORAGE_TARGET_PAYLOAD_V2_VERSION,
  STORAGE_TARGET_PAYLOAD_V3_VERSION,
] as const);
export const FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION =
  'northstar.surface-manifest-payload/v0-provisional' as const;
export const GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION =
  'northstar.surface-manifest-payload/v1' as const;
export const SUPPORTED_SURFACE_MANIFEST_PAYLOAD_VERSIONS = Object.freeze([
  FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION,
  GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION,
] as const);
export const MODULE_FIELD_CONTRACT_VERSION =
  'northstar.module-field-contract/v1' as const;
export const MODULE_INPUT_CONTRACT_VERSION =
  'northstar.module-input-contract/v1' as const;
export const MODULE_INPUT_CONTRACT_V2_VERSION =
  'northstar.module-input-contract/v2' as const;
// Generation 2 carries `targetEntityId` on every relation input, so a renderer
// can resolve what a relation points at without a module-specific id. The two
// constants preserve the v1/v2 systemInput biconditional exactly one axis over:
// systemInput is present iff v2 or v4, relation targets are present iff v3 or
// v4. A single generational constant would have collapsed those axes and made
// a systemInput-bearing contract indistinguishable from one without.
export const MODULE_INPUT_CONTRACT_V3_VERSION =
  'northstar.module-input-contract/v3' as const;
export const MODULE_INPUT_CONTRACT_V4_VERSION =
  'northstar.module-input-contract/v4' as const;
export const SUPPORTED_MODULE_INPUT_CONTRACT_VERSIONS = Object.freeze([
  MODULE_INPUT_CONTRACT_VERSION,
  MODULE_INPUT_CONTRACT_V2_VERSION,
  MODULE_INPUT_CONTRACT_V3_VERSION,
  MODULE_INPUT_CONTRACT_V4_VERSION,
] as const);
export const VERIFICATION_PLAN_PAYLOAD_VERSION =
  'northstar.verification-plan-payload/v1' as const;
export const VERIFICATION_SCENARIO_VERSION =
  'northstar.verification-scenario/v1' as const;
export const VERIFICATION_RESULT_VERSION =
  'northstar.verification-result/v1' as const;
export const VERIFICATION_RESULT_SET_VERSION =
  'northstar.verification-result-set/v1' as const;
export const VERIFICATION_PARTITIONED_RESULT_SET_VERSION =
  'northstar.verification-result-set/v2' as const;
export const VERIFICATION_DERIVATION_VERSION =
  'northstar.verification-derivation/v1' as const;
export const VERIFICATION_IMPACT_ANALYSIS_VERSION =
  'northstar.verification-impact-analysis/v1' as const;
export const STORAGE_TRANSITION_ENVELOPE_VERSION =
  'northstar.storage-transition-envelope/v1' as const;
export const STORAGE_ELEMENT_CONTRACT_VERSION =
  'northstar.storage-transition-element/v1' as const;
export const STORAGE_COMPATIBILITY_MATRIX_VERSION =
  'northstar.storage-compatibility-matrix/v1' as const;
export const PHYSICAL_MAPPING_VERSION =
  'northstar.physical-mapping/v1' as const;
export const POSTGRES_PROVIDER_ABI_VERSION =
  'northstar.postgresql-module-provider-abi/v1' as const;
export const STORAGE_RENDERER_POLICY_VERSION =
  'northstar.storage-renderer-allowlist/v1' as const;
export const TIGHTENING_DEBT_VERSION = 'northstar.tightening-debt/v2' as const;
export const BACKFILL_ADMISSIBILITY_VERSION =
  'northstar.backfill-admissibility/v1' as const;
export const HASH_ALGORITHM = 'sha256' as const;

export const HASH_DOMAINS = Object.freeze({
  cacheInput: 'northstar.compiler.cache-input/v0-experimental',
  compilerAttestation: 'northstar.compiler.attestation/v0-experimental',
  dependencyClosure: 'northstar.compiler.dependency-closure/v0-experimental',
  diff: 'northstar.compiler.release-diff/v0-experimental',
  limits: 'northstar.compiler.limits/v0-experimental',
  nodeOutput: 'northstar.compiler.node-output/v0-experimental',
  physicalName: 'northstar.compiler.physical-name/v1',
  profile: 'northstar.compiler.semantic-profile/v0-experimental',
  projectionChunk: 'northstar.compiler.projection-chunk/v0-experimental',
  projectionManifest: 'northstar.compiler.projection-manifest/v0-experimental',
  projectionSemantic: 'northstar.compiler.projection-semantic/v0-experimental',
  releaseManifest: 'northstar.compiler.release-manifest/v0-experimental',
  semanticConstruct: 'northstar.compiler.semantic-construct/v0-experimental',
  storageTransitionElement: 'northstar.compiler.storage-transition-element/v1',
  verificationScenario: 'northstar.compiler.verification-scenario/v1',
} as const);

export const PROJECTION_FAMILY_IDS = Object.freeze({
  agentDiscovery: 'northstar.compiler:projection-family.agent-discovery',
  operationCatalog: 'northstar.compiler:projection-family.operation-catalog',
  policyReferences: 'northstar.compiler:projection-family.policy-references',
  queryCatalog: 'northstar.compiler:projection-family.query-catalog',
  reporting: 'northstar.compiler:projection-family.reporting',
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

export const REQUIRED_MODULE_PROJECTION_FAMILIES: readonly ProjectionFamilyId[] =
  Object.freeze([
    ...REQUIRED_BASE_PROJECTION_FAMILIES,
    PROJECTION_FAMILY_IDS.reporting,
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
  compilerSemanticProfileVersion: CompilerSemanticProfileVersion;
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

/**
 * One acknowledged-unbound permission: a permission the package declares on
 * `resource` that no evaluator binds, named so a release may still build.
 */
export interface UnboundPermissionAcknowledgementEntry {
  readonly permissionId: string;
  readonly resource: string;
}

/**
 * The acknowledgement a RELEASE BUILD hands the compiler, for exactly one
 * package. It is not part of `CompilerInput` and is hashed into nothing: it is
 * a build-time admission gate, not an artifact fact. The subject is explicit --
 * `packageId` must equal the compiled package's id, or the compile refuses --
 * so a mislabelled acknowledgement can never silently ungovern a release.
 * Absent, the compile is a fixture or standalone compile and the rule does not
 * run; the release scripts always pass it and fail before compiling when their
 * checked-in list has no entry for their package.
 */
export interface UnboundPermissionAcknowledgementInput {
  readonly entries: readonly UnboundPermissionAcknowledgementEntry[];
  readonly packageId: string;
}

export interface CompilerExecutionOptions {
  projectionSchedule?: 'canonical' | 'interleaved' | 'reverse';
  unboundPermissionAcknowledgement?: UnboundPermissionAcknowledgementInput;
}

export type StorageTransitionElementKind =
  | 'addColumn'
  | 'addForeignKey'
  | 'addNotValidConstraint'
  | 'backfill'
  | 'createIndex'
  | 'createPartition'
  | 'createCompanionTable'
  | 'createRejectMutationTrigger'
  | 'addAbiFunctionCheck'
  | 'createTable'
  | 'duplicateScan'
  | 'relaxNotNull'
  | 'tightenNotNull'
  | 'validateConstraint'
  | 'widenEnumDomain';

export type PreparationValidity =
  | 'preApprovalInert'
  | 'inAttemptOnly'
  | 'deferredOnlineFamily'
  | 'deferredTightening';
export type SemanticEffect = 'none' | 'additive' | 'tightening';
export type DataEffect = 'none' | 'catalogOnly' | 'rowMutation' | 'dataScan';
export type OperationalRisk =
  'none' | 'boundedCatalogLock' | 'onlineStrategyRequired' | 'longRunning';
export type CompatibilityState =
  'compatible' | 'notApplicable' | 'requiresReadFallback' | 'mayReject';

export interface StorageCompatibilityCell {
  admission: 'additive' | 'blockingWhileAffectedWritersLive' | 'deferred';
  newRead: CompatibilityState;
  newWrite: CompatibilityState;
  oldRead: CompatibilityState;
  oldWrite: CompatibilityState;
}

export interface StorageElementClassification {
  dataEffect: DataEffect;
  operationalRisk: OperationalRisk;
  preparationValidity: PreparationValidity;
  semanticEffect: SemanticEffect;
}

export interface StorageTransitionElement {
  classification: StorageElementClassification;
  coexistence: StorageCompatibilityCell;
  coexistenceImpact: 'none' | 'oldWritesMayReject' | 'requiresReadFallback';
  declaredDependencyIds: string[];
  elementId: string;
  fieldId: string | null;
  kind: StorageTransitionElementKind;
  physicalObjectName: string;
  schemaVersion: typeof STORAGE_ELEMENT_CONTRACT_VERSION;
  scope: {
    keyColumns: readonly ['tenant_id', 'environment_id'];
    kind: 'tenantEnvironment';
  };
  storageDomain: 'managedModule';
  storageGeneration: 'dedicatedTyped/v1';
  subjectId: string;
}

export interface TighteningDebt {
  admissionConsequence: 'blocksTenantAccessibleModuleCreation';
  blockingRootIds: string[];
  candidateAffectedReaderQueryIds: string[];
  candidateAffectedWriterOperationIds: string[];
  debtId: string;
  elementId: string;
  liveRootResolution: 'materializerResolvesActiveAndNonTerminalPreparationUnion';
  owner: string;
  prerequisites: string[];
  priorAffectedReaderQueryIds: string[];
  priorAffectedWriterOperationIds: string[];
  schemaVersion: typeof TIGHTENING_DEBT_VERSION;
}

export interface StorageTransitionEnvelope {
  backfillAdmissibilityVersion: typeof BACKFILL_ADMISSIBILITY_VERSION;
  compatibilityMatrixVersion: typeof STORAGE_COMPATIBILITY_MATRIX_VERSION;
  elements: StorageTransitionElement[];
  fromNormalizedDefinitionDigest: string;
  fromReleaseRoot: string;
  fromStorageTargetArtifactRoot: string;
  fromStorageTargetSemanticDigest: string;
  kind: 'storageTransitionEnvelope';
  rendererPolicyVersion: typeof STORAGE_RENDERER_POLICY_VERSION;
  schemaVersion: typeof STORAGE_TRANSITION_ENVELOPE_VERSION;
  tighteningDebt: TighteningDebt[];
  toNormalizedDefinitionDigest: string;
  toStorageTargetArtifactRoot: string;
  toStorageTargetSemanticDigest: string;
  totalOrdering: 'declaredDependenciesThenElementIdCodeUnits';
}

export interface PhysicalMappingRecord {
  canonicalId: string;
  mappingVersion: typeof PHYSICAL_MAPPING_VERSION;
  objectKind: 'column' | 'constraint' | 'index' | 'table' | 'trigger';
  physicalName: string;
  shapeFingerprint: string;
  storageDomain: 'managedModule';
}

export type StorageRendererStatement =
  | {
      kind:
        | 'addAbiFunctionCheck'
        | 'addColumn'
        | 'createCompanionTable'
        | 'createIndex'
        | 'createPartition'
        | 'createRejectMutationTrigger'
        | 'createTable';
    }
  | { kind: 'addForeignKey'; onDelete: 'restrict'; onUpdate: 'restrict' }
  | { kind: 'addNotValidConstraint' | 'validateConstraint' }
  | { kind: 'onDeleteCascade' }
  | { kind: 'deleteCapableRule' | 'deleteCapableTrigger' }
  | { kind: 'truncateTable' | 'removePartition' | 'dropBusinessObject' };

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
  compilerSemanticProfileVersion: CompilerSemanticProfileVersion;
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
  compilerSemanticProfileVersion: CompilerSemanticProfileVersion;
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
  'reporting-projection-changed',
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
