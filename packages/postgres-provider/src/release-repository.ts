import { createHash } from 'node:crypto';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  CONTENT_HASH_DOMAIN,
  canonicalize,
  canonicalizeAndHash,
  parseNormalizedApplicationPackageJson,
} from '@north-star/canonical-model';
import {
  CHUNK_DESCRIPTOR_VERSION,
  CHUNKING_SCHEME_VERSION,
  COMPILER_ATTESTATION_VERSION,
  SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS,
  COMPILER_VERSION,
  HASH_ALGORITHM,
  HASH_DOMAINS,
  INCREMENTAL_EQUIVALENCE_INVARIANT,
  OUTPUT_PROTOCOL_VERSION,
  POLICY_MODEL_VERSION,
  PROJECTION_MANIFEST_VERSION,
  RELEASE_MANIFEST_VERSION,
  type CompileSuccess,
  type ContentAddressedArtifact,
  type ProjectionManifestEnvelope,
  type ProjectionReference,
  type ReleaseManifestEnvelope,
} from '@north-star/compiler';
import type {
  AppPackageRevision,
  ImmutableReleaseRepository,
  MintedUuid,
  PersistedReleaseArtifact,
  PersistedTenantRelease,
  RegisterTenantReleaseCommand,
  StoreAppPackageRevisionCommand,
  TenantRelease,
} from '@north-star/platform-runtime';
import type { TrustedRequestContext } from '@north-star/runtime';
import type { Pool, PoolClient } from 'pg';

import {
  readDurableVerificationEvidence,
  releaseVerificationBinding,
  verificationEvidenceIdForCandidate,
} from './release-verification-service.js';
import { withTrustedRequestTransaction } from './request-context.js';

const sha256Pattern = /^[0-9a-f]{64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const artifactMediaType = 'application/vnd.northstar.canonical+json' as const;
const forbiddenShareableIdentityKeys = new Set([
  'activationAttemptId',
  'approvalId',
  'coordinatorId',
  'createdBy',
  'environmentId',
  'principalId',
  'tenantId',
  'verificationEvidenceId',
]);

export class ReleasePersistenceIntegrityError extends Error {
  override readonly name = 'ReleasePersistenceIntegrityError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ReleasePersistenceIdentityError extends Error {
  override readonly name = 'ReleasePersistenceIdentityError';
}

interface RevisionRow {
  canonicalization_profile_version: string;
  content_hash: string;
  created_at: Date | string;
  created_by: string;
  desired_state: Uint8Array;
  hash_algorithm: 'sha256';
  language_version: string;
  normalization_profile_version: string;
  parent_revision_id: MintedUuid | null;
  provenance: string;
  revision_id: MintedUuid;
  schema_version: string;
  tenant_id: string;
}

interface ReleaseRow {
  app_package_revision_id: MintedUuid;
  compiler_attestation_digest: string;
  compiler_semantic_profile_version: string;
  compiler_version: string;
  content_hash: string;
  created_at: Date | string;
  created_by: string;
  environment_id: string;
  output_protocol_version: string;
  release_id: MintedUuid;
  tenant_id: string;
  verification_evidence_id: MintedUuid;
}

interface ArtifactRow {
  artifact_kind: PersistedReleaseArtifact['artifactKind'];
  canonical_bytes: Uint8Array;
  content_hash: string;
  domain_tag: string;
  media_type: typeof artifactMediaType;
}

interface ProjectionLink {
  familyId: string;
  instanceId: string;
  manifestHash: string;
}

interface ChunkLink {
  chunkHash: string;
  chunkId: string;
  projectionInstanceId: string;
}

interface VerifiedRelease {
  artifacts: readonly ContentAddressedArtifact[];
  chunks: readonly ChunkLink[];
  closureArtifacts: readonly ContentAddressedArtifact[];
  manifest: ReleaseManifestEnvelope;
  projections: readonly ProjectionLink[];
}

export type StageTenantReleaseCandidateCommand = Omit<
  RegisterTenantReleaseCommand<CompileSuccess>,
  'verificationEvidenceId'
>;

export interface StagedTenantReleaseCandidate {
  readonly releaseId: MintedUuid;
  readonly verificationEvidenceId: MintedUuid;
}

export class PostgresImmutableReleaseRepository implements ImmutableReleaseRepository<
  TrustedRequestContext,
  CompileSuccess
> {
  constructor(private readonly pool: Pool) {}

  async storeAppPackageRevision(
    context: TrustedRequestContext,
    command: StoreAppPackageRevisionCommand,
  ): Promise<AppPackageRevision> {
    assertRevisionIdentity(context, command);
    verifyRevisionCommand(command);
    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      const result = await client.query<RevisionRow>(
        `INSERT INTO platform.app_package_revisions (
           tenant_id,
           revision_id,
           parent_revision_id,
           schema_version,
           language_version,
           normalization_profile_version,
           canonicalization_profile_version,
           hash_algorithm,
           content_hash,
           desired_state,
           provenance,
           created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          command.tenantId,
          command.revisionId,
          command.parentRevisionId,
          command.schemaVersion,
          command.languageVersion,
          command.normalizationProfileVersion,
          command.canonicalizationProfileVersion,
          command.hashAlgorithm,
          command.contentHash,
          Buffer.from(command.desiredState),
          command.provenance,
          command.createdBy,
        ],
      );
      return revisionFromRow(requiredRow(result.rows[0], 'stored revision'));
    });
  }

  async getAppPackageRevision(
    context: TrustedRequestContext,
    revisionId: MintedUuid,
  ): Promise<AppPackageRevision | null> {
    assertUuid(revisionId, 'revisionId');
    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      const result = await client.query<RevisionRow>(
        `SELECT *
           FROM platform.app_package_revisions
          WHERE tenant_id = $1 AND revision_id = $2`,
        [context.tenantId, revisionId],
      );
      return result.rows[0] ? revisionFromRow(result.rows[0]) : null;
    });
  }

  async registerTenantRelease(
    context: TrustedRequestContext,
    command: RegisterTenantReleaseCommand<CompileSuccess>,
  ): Promise<PersistedTenantRelease> {
    assertReleaseIdentity(context, command);
    const revision = await this.getAppPackageRevision(
      context,
      command.appPackageRevisionId,
    );
    if (!revision) {
      throw integrity(
        'REVISION_NOT_FOUND',
        'tenant release registration requires a visible package revision',
      );
    }

    // All Freeze A/B verification completes before the transaction can insert
    // an admission event. A staged candidate root is not an admitted release.
    const verified = verifyCompiledRelease(command.compiledRelease, revision);
    const verificationBinding = releaseVerificationBinding(
      command.compiledRelease,
    );

    await withTrustedRequestTransaction(this.pool, context, async (client) => {
      await ensureStagedCandidate(client, command, verified);
      const evidence = await readDurableVerificationEvidence(
        client,
        context,
        command.verificationEvidenceId,
        verificationBinding,
      );
      if (!evidence) {
        throw integrity(
          'VERIFICATION_EVIDENCE_NOT_FOUND',
          'candidate admission requires durable exact-partition verification evidence',
        );
      }
      const admitted = await client.query<{ admitted: boolean }>(
        `SELECT true AS admitted
           FROM platform.tenant_release_admissions
          WHERE tenant_id = $1
            AND environment_id = $2
            AND release_id = $3`,
        [context.tenantId, context.environmentId, command.releaseId],
      );
      if (!admitted.rows[0]) {
        await client.query(
          `INSERT INTO platform.tenant_release_admissions (
             tenant_id, environment_id, release_id, verification_evidence_id,
             admitted_by
           ) VALUES ($1,$2,$3,$4,$5)`,
          [
            context.tenantId,
            context.environmentId,
            command.releaseId,
            command.verificationEvidenceId,
            context.principalId,
          ],
        );
      }
    });

    const stored = await this.getTenantRelease(context, command.releaseId);
    if (!stored) {
      throw integrity(
        'REGISTERED_RELEASE_NOT_VISIBLE',
        'registered tenant release did not read back in the trusted context',
      );
    }
    return stored;
  }

  async stageTenantReleaseCandidate(
    context: TrustedRequestContext,
    command: StageTenantReleaseCandidateCommand,
  ): Promise<StagedTenantReleaseCandidate> {
    assertStagedReleaseIdentity(context, command);
    const revision = await this.getAppPackageRevision(
      context,
      command.appPackageRevisionId,
    );
    if (!revision) {
      throw integrity(
        'REVISION_NOT_FOUND',
        'tenant release staging requires a visible package revision',
      );
    }
    const verified = verifyCompiledRelease(command.compiledRelease, revision);
    const verificationEvidenceId = verificationEvidenceIdForCandidate(
      context,
      command.releaseId,
      command.compiledRelease.releaseRoot,
    );
    const stagedCommand = { ...command, verificationEvidenceId };
    await withTrustedRequestTransaction(this.pool, context, (client) =>
      ensureStagedCandidate(client, stagedCommand, verified),
    );
    return Object.freeze({
      releaseId: command.releaseId,
      verificationEvidenceId,
    });
  }

  async getTenantRelease(
    context: TrustedRequestContext,
    releaseId: MintedUuid,
  ): Promise<PersistedTenantRelease | null> {
    assertUuid(releaseId, 'releaseId');
    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      const releaseResult = await client.query<ReleaseRow>(
        `SELECT release.*
           FROM platform.tenant_releases AS release
           JOIN platform.tenant_release_admissions AS admission
             ON admission.tenant_id = release.tenant_id
            AND admission.environment_id = release.environment_id
            AND admission.release_id = release.release_id
            AND admission.verification_evidence_id =
                release.verification_evidence_id
          WHERE release.tenant_id = $1
            AND release.environment_id = $2
            AND release.release_id = $3`,
        [context.tenantId, context.environmentId, releaseId],
      );
      const row = releaseResult.rows[0];
      if (!row) return null;
      const artifactResult = await client.query<ArtifactRow>(
        `SELECT artifact_kind,
                content_hash,
                domain_tag,
                media_type,
                canonical_bytes
           FROM platform.read_tenant_release_artifacts($1)`,
        [releaseId],
      );
      return Object.freeze({
        artifacts: Object.freeze(
          artifactResult.rows.map((artifact) => artifactFromRow(artifact)),
        ),
        release: releaseFromRow(row),
      });
    });
  }
}

function assertStagedReleaseIdentity(
  context: TrustedRequestContext,
  command: StageTenantReleaseCandidateCommand,
): void {
  assertUuid(command.releaseId, 'releaseId');
  assertUuid(command.appPackageRevisionId, 'appPackageRevisionId');
  if (
    command.tenantId !== context.tenantId ||
    command.environmentId !== context.environmentId
  ) {
    throw new ReleasePersistenceIdentityError(
      'release tenant and environment must match trusted request context',
    );
  }
  if (command.createdBy !== context.principalId) {
    throw new ReleasePersistenceIdentityError(
      'release creator must match trusted principal context',
    );
  }
}

function assertRevisionIdentity(
  context: TrustedRequestContext,
  command: StoreAppPackageRevisionCommand,
): void {
  assertUuid(command.revisionId, 'revisionId');
  if (command.parentRevisionId) {
    assertUuid(command.parentRevisionId, 'parentRevisionId');
  }
  if (command.tenantId !== context.tenantId) {
    throw new ReleasePersistenceIdentityError(
      'revision tenant must match trusted request context',
    );
  }
  if (command.createdBy !== context.principalId) {
    throw new ReleasePersistenceIdentityError(
      'revision creator must match trusted principal context',
    );
  }
}

function assertReleaseIdentity(
  context: TrustedRequestContext,
  command: RegisterTenantReleaseCommand<CompileSuccess>,
): void {
  assertStagedReleaseIdentity(context, command);
  assertUuid(command.verificationEvidenceId, 'verificationEvidenceId');
}

function verifyRevisionCommand(command: StoreAppPackageRevisionCommand): void {
  if (
    command.canonicalizationProfileVersion !==
      CANONICALIZATION_PROFILE_VERSION ||
    command.hashAlgorithm !== CONTENT_HASH_ALGORITHM
  ) {
    throw integrity(
      'REVISION_ENVELOPE_MISMATCH',
      'revision envelope must consume the exact Freeze A profiles',
    );
  }
  if (command.provenance.trim().length === 0) {
    throw integrity(
      'REVISION_PROVENANCE_INVALID',
      'provenance must not be blank',
    );
  }
  try {
    const normalized = parseNormalizedApplicationPackageJson(
      command.desiredState,
    );
    if (
      command.schemaVersion !== normalized.schemaVersion ||
      command.languageVersion !== normalized.languageVersion ||
      command.normalizationProfileVersion !==
        normalized.normalizationProfileVersion
    ) {
      throw integrity(
        'REVISION_ENVELOPE_MISMATCH',
        'revision envelope profiles must match the normalized desired state',
      );
    }
    const canonical = canonicalizeAndHash(normalized);
    if (!equalBytes(canonical.bytes, command.desiredState)) {
      throw integrity(
        'REVISION_BYTES_NOT_NORMALIZED',
        'desired state must be the exact normalized Freeze A byte sequence',
      );
    }
    if (canonical.contentHash !== command.contentHash) {
      throw integrity(
        'REVISION_DIGEST_MISMATCH',
        'desired-state digest does not match its normalized bytes',
      );
    }
    if (
      hashBytes(CONTENT_HASH_DOMAIN, command.desiredState) !==
      command.contentHash
    ) {
      throw integrity(
        'REVISION_DIGEST_DOMAIN_MISMATCH',
        'desired-state digest must use the Freeze A domain separator',
      );
    }
    if (normalized.package.provenance !== command.provenance) {
      throw integrity(
        'REVISION_PROVENANCE_MISMATCH',
        'revision provenance must match the normalized desired state',
      );
    }
  } catch (error) {
    if (error instanceof ReleasePersistenceIntegrityError) throw error;
    throw integrity(
      'REVISION_BYTES_INVALID',
      'desired state is not a valid normalized Freeze A package',
    );
  }
}

function verifyCompiledRelease(
  compiled: CompileSuccess,
  revision: AppPackageRevision,
): VerifiedRelease {
  if (
    compiled.status !== 'compiled' ||
    !Array.isArray(compiled.diagnostics) ||
    compiled.diagnostics.length !== 0 ||
    compiled.releaseRoot.length === 0 ||
    !compiled.bundle ||
    compiled.bundle.kind !== 'compiledReleaseBundle' ||
    !compiled.attestation
  ) {
    throw integrity(
      'COMPILE_RESULT_NOT_SUCCESSFUL',
      'only a successful Freeze B compiler result can be registered',
    );
  }
  if (
    compiled.bundle.outputProtocolVersion !== OUTPUT_PROTOCOL_VERSION ||
    compiled.bundle.releaseManifest.outputProtocolVersion !==
      OUTPUT_PROTOCOL_VERSION
  ) {
    throw integrity(
      'OUTPUT_PROTOCOL_MISMATCH',
      'compiled release does not use the frozen output protocol',
    );
  }

  const artifacts = uniqueArtifacts(compiled.bundle.artifacts);
  assertArtifactListsEqual(artifacts, compiled.stagedArtifacts);
  for (const artifact of artifacts) verifyArtifactHash(artifact);

  const manifestArtifact = artifacts.find(
    (artifact) => artifact.contentHash === compiled.releaseRoot,
  );
  if (
    !manifestArtifact ||
    manifestArtifact.artifactKind !== 'releaseManifest' ||
    manifestArtifact.domainTag !== HASH_DOMAINS.releaseManifest
  ) {
    throw integrity(
      'RELEASE_MANIFEST_MISSING',
      'release root must resolve to one release-manifest artifact',
    );
  }
  if (
    !equalBytes(
      manifestArtifact.canonicalBytes,
      compiled.bundle.releaseManifestBytes,
    ) ||
    hashBytes(HASH_DOMAINS.releaseManifest, manifestArtifact.canonicalBytes) !==
      compiled.releaseRoot
  ) {
    throw integrity(
      'RELEASE_ROOT_MISMATCH',
      'release root and release-manifest bytes do not match',
    );
  }

  const manifest = decodeCanonicalObject(
    manifestArtifact.canonicalBytes,
    'RELEASE_MANIFEST_NOT_CANONICAL',
  ) as unknown as ReleaseManifestEnvelope;
  if (
    canonicalize(manifest) !== canonicalize(compiled.bundle.releaseManifest)
  ) {
    throw integrity(
      'RELEASE_MANIFEST_OBJECT_MISMATCH',
      'release-manifest bytes differ from the compiler result envelope',
    );
  }
  verifyReleaseManifestEnvelope(manifest, revision);
  verifyAttestation(compiled, manifest);

  const artifactByHash = new Map(
    artifacts.map((artifact) => [artifact.contentHash, artifact]),
  );
  const reachable = new Set<string>();
  const projections: ProjectionLink[] = [];
  const chunks: ChunkLink[] = [];
  const instanceIds = new Set<string>();

  for (const reference of manifest.projections) {
    if (instanceIds.has(reference.instanceId)) {
      throw integrity(
        'PROJECTION_INSTANCE_DUPLICATE',
        'release manifest contains a duplicate projection instance',
      );
    }
    instanceIds.add(reference.instanceId);
    const projectionArtifact = artifactByHash.get(reference.artifactRoot);
    if (!projectionArtifact) {
      throw integrity(
        'PROJECTION_MANIFEST_MISSING',
        'projection reference points to a missing artifact',
      );
    }
    if (
      projectionArtifact.artifactKind !== 'projectionManifest' ||
      projectionArtifact.domainTag !==
        `${HASH_DOMAINS.projectionManifest}/${reference.familyId}`
    ) {
      throw integrity(
        'PROJECTION_MANIFEST_DOMAIN_MISMATCH',
        'projection reference points to an artifact with the wrong kind or domain',
      );
    }
    const projectionManifest = decodeCanonicalObject(
      projectionArtifact.canonicalBytes,
      'PROJECTION_MANIFEST_NOT_CANONICAL',
    ) as unknown as ProjectionManifestEnvelope;
    if (!Array.isArray(projectionManifest.chunks)) {
      throw integrity(
        'PROJECTION_MANIFEST_LINK_MISMATCH',
        'projection reference metadata differs from its manifest',
      );
    }
    reachable.add(reference.artifactRoot);
    projections.push({
      familyId: reference.familyId,
      instanceId: reference.instanceId,
      manifestHash: reference.artifactRoot,
    });

    const chunkIds = new Set<string>();
    const projectionPayloadBytes: Uint8Array[] = [];
    for (const descriptor of projectionManifest.chunks) {
      if (chunkIds.has(descriptor.chunkId)) {
        throw integrity(
          'PROJECTION_CHUNK_ID_DUPLICATE',
          'projection manifest contains a duplicate chunk identity',
        );
      }
      chunkIds.add(descriptor.chunkId);
      const chunkArtifact = artifactByHash.get(descriptor.contentHash);
      if (!chunkArtifact) {
        throw integrity(
          'PROJECTION_CHUNK_MISSING',
          'projection manifest points to a missing chunk artifact',
        );
      }
      if (
        chunkArtifact.artifactKind !== 'projectionChunk' ||
        chunkArtifact.domainTag !==
          `${HASH_DOMAINS.projectionChunk}/${reference.familyId}` ||
        descriptor.chunkDescriptorVersion !== CHUNK_DESCRIPTOR_VERSION ||
        chunkArtifact.canonicalBytes.byteLength !== descriptor.byteLength ||
        descriptor.mediaType !== artifactMediaType ||
        canonicalize(descriptor.logicalScope) !==
          canonicalize(projectionManifest.logicalScope)
      ) {
        throw integrity(
          'PROJECTION_CHUNK_LINK_MISMATCH',
          'projection chunk metadata does not bind the referenced bytes',
        );
      }
      decodeCanonicalObject(
        chunkArtifact.canonicalBytes,
        'PROJECTION_CHUNK_NOT_CANONICAL',
      );
      projectionPayloadBytes.push(chunkArtifact.canonicalBytes);
      reachable.add(descriptor.contentHash);
      chunks.push({
        chunkHash: descriptor.contentHash,
        chunkId: descriptor.chunkId,
        projectionInstanceId: reference.instanceId,
      });
    }
    verifyProjectionReference(
      reference,
      projectionManifest,
      projectionPayloadBytes,
    );
  }

  const closureArtifacts = artifacts.filter(
    (artifact) => artifact.artifactKind !== 'releaseManifest',
  );
  const actualClosure = closureArtifacts
    .map((artifact) => artifact.contentHash)
    .toSorted();
  const declaredClosure = [...manifest.artifactClosure].toSorted();
  const reachableClosure = [...reachable].toSorted();
  if (
    new Set(manifest.artifactClosure).size !==
      manifest.artifactClosure.length ||
    !equalStrings(actualClosure, declaredClosure) ||
    !equalStrings(actualClosure, reachableClosure)
  ) {
    throw integrity(
      'ARTIFACT_CLOSURE_MISMATCH',
      'release artifact closure is missing, extra, duplicated, or unreachable',
    );
  }

  return {
    artifacts,
    chunks,
    closureArtifacts,
    manifest,
    projections,
  };
}

function verifyReleaseManifestEnvelope(
  manifest: ReleaseManifestEnvelope,
  revision: AppPackageRevision,
): void {
  if (
    manifest.kind !== 'releaseManifest' ||
    manifest.completeSnapshot !== true ||
    manifest.runtimeOverlayEvaluation !== 'forbidden' ||
    manifest.policyDecisionDependency !== 'liveCurrentDenyCapable' ||
    manifest.manifestVersion !== RELEASE_MANIFEST_VERSION ||
    manifest.policyModelVersion !== POLICY_MODEL_VERSION ||
    manifest.compilerVersion !== COMPILER_VERSION ||
    !SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS.includes(
      manifest.compilerSemanticProfileVersion,
    ) ||
    manifest.outputProtocolVersion !== OUTPUT_PROTOCOL_VERSION ||
    manifest.hashAlgorithm !== HASH_ALGORITHM ||
    manifest.languageVersion !== revision.languageVersion ||
    manifest.normalizationProfileVersion !==
      revision.normalizationProfileVersion ||
    manifest.canonicalizationProfileVersion !==
      revision.canonicalizationProfileVersion ||
    manifest.normalizedDefinitionDigest !== revision.contentHash ||
    !hasValidCapabilityFacts(manifest.capabilityFacts) ||
    typeof manifest.semanticProfileDigest !== 'string' ||
    !sha256Pattern.test(manifest.semanticProfileDigest) ||
    !Array.isArray(manifest.projections) ||
    !Array.isArray(manifest.artifactClosure)
  ) {
    throw integrity(
      'RELEASE_MANIFEST_ENVELOPE_MISMATCH',
      'release manifest does not bind the immutable revision and Freeze B profiles',
    );
  }
}

function hasValidCapabilityFacts(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (fact) =>
        isRecord(fact) &&
        typeof fact.capabilityId === 'string' &&
        fact.capabilityId.length > 0 &&
        Number.isSafeInteger(fact.capabilityVersion) &&
        Number(fact.capabilityVersion) >= 1 &&
        Array.isArray(fact.declaredEffects) &&
        fact.declaredEffects.every(
          (effect) => typeof effect === 'string' && effect.length > 0,
        ) &&
        Array.isArray(fact.requiredProjectionFamilies) &&
        fact.requiredProjectionFamilies.every(
          (familyId) => typeof familyId === 'string' && familyId.length > 0,
        ) &&
        fact.supportStatus === 'supported',
    )
  );
}

function verifyAttestation(
  compiled: CompileSuccess,
  manifest: ReleaseManifestEnvelope,
): void {
  const { attestationDigest, ...attestationBody } = compiled.attestation;
  if (
    compiled.attestation.kind !== 'compilerAttestation' ||
    compiled.attestation.attestationVersion !== COMPILER_ATTESTATION_VERSION ||
    compiled.attestation.compileMode !== 'coldFull' ||
    compiled.attestation.incrementalEquivalenceInvariant !==
      INCREMENTAL_EQUIVALENCE_INVARIANT ||
    compiled.attestation.compilerVersion !== COMPILER_VERSION ||
    compiled.attestation.compilerVersion !== manifest.compilerVersion ||
    !SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS.includes(
      compiled.attestation.compilerSemanticProfileVersion,
    ) ||
    compiled.attestation.compilerSemanticProfileVersion !==
      manifest.compilerSemanticProfileVersion ||
    compiled.attestation.inputDefinitionDigest !==
      manifest.normalizedDefinitionDigest ||
    compiled.attestation.releaseRoot !== compiled.releaseRoot ||
    compiled.attestation.cacheInputDigest !== manifest.cacheInputDigest ||
    compiled.attestation.dependencyClosureDigest !==
      manifest.dependencyClosureDigest ||
    compiled.attestation.limitsDigest !== manifest.limitsDigest ||
    hashBytes(
      HASH_DOMAINS.compilerAttestation,
      new TextEncoder().encode(canonicalize(attestationBody)),
    ) !== attestationDigest
  ) {
    throw integrity(
      'COMPILER_ATTESTATION_MISMATCH',
      'compiler attestation does not bind the registered release and revision',
    );
  }
}

function verifyProjectionReference(
  reference: ProjectionReference,
  manifest: ProjectionManifestEnvelope,
  projectionPayloadBytes: readonly Uint8Array[],
): void {
  const sharedKeys = [
    'chunkingSchemeVersion',
    'compatibility',
    'familyId',
    'instanceId',
    'logicalScope',
    'manifestVersion',
    'outputProtocolVersion',
    'payloadSchemaVersion',
    'requiredRuntimeCapability',
  ] as const;
  const payloadBytes =
    projectionPayloadBytes.length === 1 ? projectionPayloadBytes[0] : undefined;
  const semanticDigest = payloadBytes
    ? hashBytes(
        `${HASH_DOMAINS.projectionSemantic}/${reference.familyId}`,
        payloadBytes,
      )
    : null;
  if (
    manifest.kind !== 'projectionManifest' ||
    reference.chunkingSchemeVersion !== CHUNKING_SCHEME_VERSION ||
    manifest.chunkingSchemeVersion !== CHUNKING_SCHEME_VERSION ||
    reference.manifestVersion !== PROJECTION_MANIFEST_VERSION ||
    manifest.manifestVersion !== PROJECTION_MANIFEST_VERSION ||
    reference.outputProtocolVersion !== OUTPUT_PROTOCOL_VERSION ||
    manifest.outputProtocolVersion !== OUTPUT_PROTOCOL_VERSION ||
    !hasSupportedProjectionCompatibility(reference.compatibility) ||
    !hasSupportedProjectionCompatibility(manifest.compatibility) ||
    !Array.isArray(manifest.chunks) ||
    manifest.chunks.length !== 1 ||
    reference.semanticDigest !== semanticDigest ||
    manifest.semanticDigest !== semanticDigest ||
    sharedKeys.some(
      (key) => canonicalize(reference[key]) !== canonicalize(manifest[key]),
    )
  ) {
    throw integrity(
      'PROJECTION_MANIFEST_LINK_MISMATCH',
      'projection reference metadata differs from its manifest',
    );
  }
}

function hasSupportedProjectionCompatibility(
  compatibility: ProjectionReference['compatibility'],
): boolean {
  return (
    compatibility.additiveInstances === 'allowed' &&
    compatibility.minimumReaderProtocolVersion === OUTPUT_PROTOCOL_VERSION &&
    compatibility.retirement === 'requiresNewProtocolOrExplicitOptionality' &&
    compatibility.unknownRequiredFamily === 'reject' &&
    compatibility.versionChange === 'newFamilyOrPayloadVersion'
  );
}

function uniqueArtifacts(
  artifacts: readonly ContentAddressedArtifact[],
): readonly ContentAddressedArtifact[] {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw integrity(
      'ARTIFACT_SET_EMPTY',
      'compiled artifact set must not be empty',
    );
  }
  const hashes = new Set<string>();
  for (const artifact of artifacts) {
    if (hashes.has(artifact.contentHash)) {
      throw integrity(
        'ARTIFACT_HASH_DUPLICATE',
        'compiled artifact set contains a duplicate content hash',
      );
    }
    hashes.add(artifact.contentHash);
  }
  return artifacts;
}

function assertArtifactListsEqual(
  bundleArtifacts: readonly ContentAddressedArtifact[],
  stagedArtifacts: readonly ContentAddressedArtifact[],
): void {
  if (!Array.isArray(stagedArtifacts)) {
    throw integrity(
      'STAGED_ARTIFACT_SET_MISMATCH',
      'compiler staged artifact set is missing',
    );
  }
  const summarize = (artifacts: readonly ContentAddressedArtifact[]) =>
    artifacts.map((artifact) => ({
      artifactKind: artifact.artifactKind,
      bytes: [...artifact.canonicalBytes],
      contentHash: artifact.contentHash,
      domainTag: artifact.domainTag,
      mediaType: artifact.mediaType,
    }));
  if (
    canonicalize(summarize(bundleArtifacts)) !==
    canonicalize(summarize(stagedArtifacts))
  ) {
    throw integrity(
      'STAGED_ARTIFACT_SET_MISMATCH',
      'compiler bundle and staged artifact sets differ',
    );
  }
}

function verifyArtifactHash(artifact: ContentAddressedArtifact): void {
  if (
    artifact.kind !== 'contentAddressedArtifact' ||
    !sha256Pattern.test(artifact.contentHash) ||
    artifact.mediaType !== artifactMediaType ||
    artifact.canonicalBytes.byteLength === 0 ||
    hashBytes(artifact.domainTag, artifact.canonicalBytes) !==
      artifact.contentHash
  ) {
    throw integrity(
      'ARTIFACT_CONTENT_HASH_MISMATCH',
      'artifact bytes and domain-separated content hash do not match',
    );
  }
}

function decodeCanonicalObject(
  bytes: Uint8Array,
  code: string,
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed)) throw new Error('not an object');
    const canonicalBytes = new TextEncoder().encode(canonicalize(parsed));
    if (!equalBytes(bytes, canonicalBytes)) throw new Error('not canonical');
    assertNoShareableIdentity(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof ReleasePersistenceIntegrityError) throw error;
    throw integrity(code, 'artifact bytes are not canonical policy-free JSON');
  }
}

function assertNoShareableIdentity(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoShareableIdentity(entry);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenShareableIdentityKeys.has(key)) {
      throw integrity(
        'SHAREABLE_ARTIFACT_CONTAINS_IDENTITY',
        `shareable artifact contains forbidden identity key ${key}`,
      );
    }
    assertNoShareableIdentity(entry);
  }
}

async function stageArtifacts(
  client: PoolClient,
  artifacts: readonly ContentAddressedArtifact[],
): Promise<void> {
  for (const artifact of artifacts) {
    await client.query(
      'SELECT platform.stage_release_artifact($1, $2, $3, $4, $5)',
      [
        artifact.contentHash,
        artifact.artifactKind,
        artifact.domainTag,
        artifact.mediaType,
        Buffer.from(artifact.canonicalBytes),
      ],
    );
  }
}

async function ensureStagedCandidate(
  client: PoolClient,
  command: RegisterTenantReleaseCommand<CompileSuccess>,
  verified: VerifiedRelease,
): Promise<void> {
  const existing = await client.query<ReleaseRow>(
    `SELECT *
       FROM platform.tenant_releases
      WHERE tenant_id = $1
        AND environment_id = $2
        AND release_id = $3`,
    [command.tenantId, command.environmentId, command.releaseId],
  );
  const row = existing.rows[0];
  if (row) {
    if (
      row.app_package_revision_id !== command.appPackageRevisionId ||
      row.content_hash !== command.compiledRelease.releaseRoot ||
      row.compiler_attestation_digest !==
        command.compiledRelease.attestation.attestationDigest ||
      row.verification_evidence_id !== command.verificationEvidenceId ||
      row.created_by !== command.createdBy
    ) {
      throw integrity(
        'STAGED_CANDIDATE_IDENTITY_MISMATCH',
        'staged candidate identity differs from the exact registration command',
      );
    }
    return;
  }
  await stageArtifacts(client, verified.artifacts);
  await insertReleaseRoot(client, command, verified);
  await insertArtifactLinks(client, command, verified.closureArtifacts);
  await insertProjectionLinks(client, command, verified.projections);
  await insertChunkLinks(client, command, verified.chunks);
}

async function insertReleaseRoot(
  client: PoolClient,
  command: RegisterTenantReleaseCommand<CompileSuccess>,
  verified: VerifiedRelease,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.tenant_releases (
       tenant_id,
       environment_id,
       release_id,
       app_package_revision_id,
       compiler_version,
       compiler_semantic_profile_version,
       output_protocol_version,
       content_hash,
       compiler_attestation_digest,
       verification_evidence_id,
       created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      command.tenantId,
      command.environmentId,
      command.releaseId,
      command.appPackageRevisionId,
      verified.manifest.compilerVersion,
      verified.manifest.compilerSemanticProfileVersion,
      verified.manifest.outputProtocolVersion,
      command.compiledRelease.releaseRoot,
      command.compiledRelease.attestation.attestationDigest,
      command.verificationEvidenceId,
      command.createdBy,
    ],
  );
}

async function insertArtifactLinks(
  client: PoolClient,
  command: RegisterTenantReleaseCommand<CompileSuccess>,
  artifacts: readonly ContentAddressedArtifact[],
): Promise<void> {
  for (const artifact of artifacts) {
    await client.query(
      `INSERT INTO platform.tenant_release_artifact_links (
         tenant_id,
         environment_id,
         release_id,
         content_hash,
         artifact_kind
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        command.tenantId,
        command.environmentId,
        command.releaseId,
        artifact.contentHash,
        artifact.artifactKind,
      ],
    );
  }
}

async function insertProjectionLinks(
  client: PoolClient,
  command: RegisterTenantReleaseCommand<CompileSuccess>,
  projections: readonly ProjectionLink[],
): Promise<void> {
  for (const projection of projections) {
    await client.query(
      `INSERT INTO platform.tenant_release_projection_links (
         tenant_id,
         environment_id,
         release_id,
         projection_instance_id,
         projection_family_id,
         projection_manifest_hash
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        command.tenantId,
        command.environmentId,
        command.releaseId,
        projection.instanceId,
        projection.familyId,
        projection.manifestHash,
      ],
    );
  }
}

async function insertChunkLinks(
  client: PoolClient,
  command: RegisterTenantReleaseCommand<CompileSuccess>,
  chunks: readonly ChunkLink[],
): Promise<void> {
  for (const chunk of chunks) {
    await client.query(
      `INSERT INTO platform.tenant_release_chunk_links (
         tenant_id,
         environment_id,
         release_id,
         projection_instance_id,
         chunk_id,
         chunk_hash
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        command.tenantId,
        command.environmentId,
        command.releaseId,
        chunk.projectionInstanceId,
        chunk.chunkId,
        chunk.chunkHash,
      ],
    );
  }
}

function revisionFromRow(row: RevisionRow): AppPackageRevision {
  return Object.freeze({
    canonicalizationProfileVersion: row.canonicalization_profile_version,
    contentHash: row.content_hash,
    createdAt: timestampText(row.created_at),
    createdBy: row.created_by,
    desiredState: new Uint8Array(row.desired_state),
    hashAlgorithm: row.hash_algorithm,
    languageVersion: row.language_version,
    normalizationProfileVersion: row.normalization_profile_version,
    parentRevisionId: row.parent_revision_id,
    provenance: row.provenance,
    revisionId: row.revision_id,
    schemaVersion: row.schema_version,
    tenantId: row.tenant_id,
  });
}

function releaseFromRow(row: ReleaseRow): TenantRelease {
  return Object.freeze({
    appPackageRevisionId: row.app_package_revision_id,
    compilerAttestationDigest: row.compiler_attestation_digest,
    compilerSemanticProfileVersion: row.compiler_semantic_profile_version,
    compilerVersion: row.compiler_version,
    contentHash: row.content_hash,
    createdAt: timestampText(row.created_at),
    createdBy: row.created_by,
    environmentId: row.environment_id,
    outputProtocolVersion: row.output_protocol_version,
    releaseId: row.release_id,
    tenantId: row.tenant_id,
    verificationEvidenceId: row.verification_evidence_id,
  });
}

function artifactFromRow(row: ArtifactRow): PersistedReleaseArtifact {
  return Object.freeze({
    artifactKind: row.artifact_kind,
    canonicalBytes: new Uint8Array(row.canonical_bytes),
    contentHash: row.content_hash,
    domainTag: row.domain_tag,
    mediaType: row.media_type,
  });
}

function hashBytes(domainTag: string, bytes: Uint8Array): string {
  return createHash(HASH_ALGORITHM)
    .update(domainTag, 'utf8')
    .update(Uint8Array.of(0))
    .update(bytes)
    .digest('hex');
}

function assertUuid(value: string, name: string): void {
  if (!uuidPattern.test(value)) {
    throw new ReleasePersistenceIdentityError(`${name} must be a minted UUID`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredRow<T>(value: T | undefined, label: string): T {
  if (!value)
    throw integrity('DATABASE_ROW_MISSING', `${label} was not returned`);
  return value;
}

function timestampText(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function integrity(
  code: string,
  message: string,
): ReleasePersistenceIntegrityError {
  return new ReleasePersistenceIntegrityError(code, message);
}
