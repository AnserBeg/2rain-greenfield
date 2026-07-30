import { createHash } from 'node:crypto';

import { canonicalize } from '@north-star/canonical-model';
import {
  CHUNK_DESCRIPTOR_VERSION,
  CHUNKING_SCHEME_VERSION,
  HASH_DOMAINS,
  OUTPUT_PROTOCOL_VERSION,
  PROJECTION_MANIFEST_VERSION,
  RELEASE_MANIFEST_VERSION,
  SUPPORTED_SURFACE_MANIFEST_PAYLOAD_VERSIONS,
} from '@north-star/compiler';
import {
  ReleaseInvalidationFenceState,
  shouldDiscardFenceTaggedCache,
  type InvalidationConsumerResult,
  type MintedUuid,
  type ReleaseActivationInvalidationEvent,
} from '@north-star/platform-runtime';
import {
  assertTrustedRequestContext,
  type TrustedRequestContext,
} from '@north-star/runtime';
import {
  PIN_VALIDATION_RESULT_VERSION,
  PINNED_RUNTIME_CONTEXT_VERSION,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  parsePinnedRuntimeContextEnvelope,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type PinnedRuntimeContextEnvelope,
  type PinValidationResult,
  type RequestRuntimeDefinitionLoader,
  type RequestRuntimeProjectionFamily,
  type RuntimeProjection,
} from '@north-star/runtime/request-runtime-view';
import type { Pool, PoolClient } from 'pg';

import { withTrustedRequestTransaction } from './request-context.js';

export type RequestRuntimeViewLoadErrorCode =
  | 'ACTIVE_POINTER_MISSING'
  | 'ACTIVE_RELEASE_NOT_VISIBLE'
  | 'INVALIDATION_AHEAD_OF_AUTHORITY'
  | 'INVALIDATION_CONTEXT_MISMATCH'
  | 'MALFORMED_RELEASE'
  | 'MALFORMED_REQUIRED_PROJECTION'
  | 'NULL_ACTIVE_RELEASE'
  | 'PIN_CONTEXT_MISMATCH'
  | 'POINTER_CHANGED_DURING_LOAD'
  | 'POINTER_IDENTITY_CHANGED'
  | 'REQUEST_CONTEXT_MISMATCH'
  | 'REQUIRED_PROJECTION_DUPLICATE'
  | 'REQUIRED_PROJECTION_MISSING';

export class RequestRuntimeViewLoadError extends Error {
  override readonly name = 'RequestRuntimeViewLoadError';

  constructor(
    readonly code: RequestRuntimeViewLoadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface RequestRuntimeViewServiceOptions {
  /** Deterministic synchronization seam for slow-fill tests and diagnostics. */
  readonly beforeCachePublication?: (
    definition: LoadedRequestRuntimeDefinition,
  ) => Promise<void>;
}

export interface RequestRuntimeInvalidationResult {
  readonly authoritativePointerReread: boolean;
  readonly consumer: InvalidationConsumerResult;
}

interface PointerAuthority {
  environmentId: string;
  fence: number;
  pointerId: MintedUuid;
  releaseContentHash: string;
  releaseId: MintedUuid;
  tenantId: string;
}

interface SnapshotRow {
  artifact_canonical_bytes: Uint8Array | null;
  artifact_content_hash: string | null;
  artifact_domain_tag: string | null;
  artifact_kind:
    'projectionChunk' | 'projectionManifest' | 'releaseManifest' | null;
  artifact_media_type: string | null;
  chunk_id: string | null;
  chunk_projection_instance_id: string | null;
  environment_id: string;
  fence: string;
  manifest_projection_family_id: string | null;
  manifest_projection_instance_id: string | null;
  pointer_id: MintedUuid;
  pointer_release_id: MintedUuid | null;
  release_compiler_semantic_profile_version: string | null;
  release_compiler_version: string | null;
  release_content_hash: string | null;
  release_id: MintedUuid | null;
  release_output_protocol_version: string | null;
  tenant_id: string;
}

interface PointerRow {
  environment_id: string;
  fence: string;
  pointer_id: MintedUuid;
  pointer_release_id: MintedUuid | null;
  release_content_hash: string | null;
  release_id: MintedUuid | null;
  tenant_id: string;
}

interface ArtifactRecord {
  bytes: Uint8Array;
  contentHash: string;
  domainTag: string;
  kind: 'projectionChunk' | 'projectionManifest' | 'releaseManifest';
  mediaType: string;
}

interface ProjectionLinkRecord {
  familyId: string;
  instanceId: string;
  manifestHash: string;
}

interface ChunkLinkRecord {
  chunkHash: string;
  chunkId: string;
  instanceId: string;
}

interface CacheEntry {
  definition: LoadedRequestRuntimeDefinition;
  fence: number;
  pointerId: MintedUuid;
  releaseId: MintedUuid;
}

const artifactMediaType = 'application/vnd.northstar.canonical+json';
const sha256Pattern = /^[0-9a-f]{64}$/;
const maximumFillAttempts = 4;

const supportedProjectionSchemas = Object.freeze({
  [REQUEST_RUNTIME_PROJECTION_FAMILIES.agent]: Object.freeze({
    payloadKind: 'agentDiscoveryPayload',
    payloadSchemaVersions: Object.freeze([
      'northstar.agent-discovery-payload/v0-provisional',
    ]),
  }),
  [REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog]: Object.freeze({
    payloadKind: 'semanticModelPayload',
    payloadSchemaVersions: Object.freeze([
      'northstar.semantic-model-payload/v0-provisional',
    ]),
  }),
  [REQUEST_RUNTIME_PROJECTION_FAMILIES.operation]: Object.freeze({
    payloadKind: 'operationCatalogPayload',
    payloadSchemaVersions: Object.freeze([
      'northstar.operation-catalog-payload/v0-provisional',
    ]),
  }),
  [REQUEST_RUNTIME_PROJECTION_FAMILIES.query]: Object.freeze({
    payloadKind: 'queryCatalogPayload',
    payloadSchemaVersions: Object.freeze([
      'northstar.query-catalog-payload/v0-provisional',
    ]),
  }),
  [REQUEST_RUNTIME_PROJECTION_FAMILIES.surface]: Object.freeze({
    payloadKind: 'surfaceManifestPayload',
    payloadSchemaVersions: SUPPORTED_SURFACE_MANIFEST_PAYLOAD_VERSIONS,
  }),
} satisfies Record<
  RequestRuntimeProjectionFamily,
  { payloadKind: string; payloadSchemaVersions: readonly string[] }
>);

const authoritativeSnapshotSql = `
  SELECT pointer.tenant_id,
         pointer.environment_id,
         pointer.pointer_id,
         pointer.release_id AS pointer_release_id,
         pointer.fence,
         release.release_id,
         release.content_hash AS release_content_hash,
         release.compiler_version AS release_compiler_version,
         release.compiler_semantic_profile_version
           AS release_compiler_semantic_profile_version,
         release.output_protocol_version AS release_output_protocol_version,
         artifact.artifact_kind,
         artifact.content_hash AS artifact_content_hash,
         artifact.domain_tag AS artifact_domain_tag,
         artifact.media_type AS artifact_media_type,
         artifact.canonical_bytes AS artifact_canonical_bytes,
         projection.projection_instance_id
           AS manifest_projection_instance_id,
         projection.projection_family_id AS manifest_projection_family_id,
         chunk.projection_instance_id AS chunk_projection_instance_id,
         chunk.chunk_id
    FROM platform.active_release_pointers AS pointer
    LEFT JOIN platform.tenant_releases AS release
      ON release.tenant_id = pointer.tenant_id
     AND release.environment_id = pointer.environment_id
     AND release.release_id = pointer.release_id
    LEFT JOIN LATERAL
      platform.read_tenant_release_artifacts(pointer.release_id) AS artifact
      ON pointer.release_id IS NOT NULL
    LEFT JOIN platform.tenant_release_projection_links AS projection
      ON projection.tenant_id = pointer.tenant_id
     AND projection.environment_id = pointer.environment_id
     AND projection.release_id = pointer.release_id
     AND projection.projection_manifest_hash = artifact.content_hash
    LEFT JOIN platform.tenant_release_chunk_links AS chunk
      ON chunk.tenant_id = pointer.tenant_id
     AND chunk.environment_id = pointer.environment_id
     AND chunk.release_id = pointer.release_id
     AND chunk.chunk_hash = artifact.content_hash
   WHERE pointer.tenant_id = $1
     AND pointer.environment_id = $2
   ORDER BY artifact.content_hash,
            projection.projection_instance_id,
            chunk.projection_instance_id,
            chunk.chunk_id
`;

const pointerAuthoritySql = `
  SELECT pointer.tenant_id,
         pointer.environment_id,
         pointer.pointer_id,
         pointer.release_id AS pointer_release_id,
         pointer.fence,
         release.release_id,
         release.content_hash AS release_content_hash
    FROM platform.active_release_pointers AS pointer
    LEFT JOIN platform.tenant_releases AS release
      ON release.tenant_id = pointer.tenant_id
     AND release.environment_id = pointer.environment_id
     AND release.release_id = pointer.release_id
   WHERE pointer.tenant_id = $1
     AND pointer.environment_id = $2
`;

export class PostgresRequestRuntimeViewService implements RequestRuntimeDefinitionLoader {
  readonly #beforeCachePublication?: RequestRuntimeViewServiceOptions['beforeCachePublication'];
  readonly #cache = new Map<string, CacheEntry>();
  readonly #invalidationFences = new ReleaseInvalidationFenceState();

  constructor(
    private readonly pool: Pool,
    options: RequestRuntimeViewServiceOptions = {},
  ) {
    this.#beforeCachePublication = options.beforeCachePublication;
  }

  async load(
    context: TrustedRequestContext,
  ): Promise<LoadedRequestRuntimeDefinition> {
    assertTrustedRequestContext(context);
    const authority = await this.#readPointerAuthority(context);
    const key = cacheKey(authority);
    const cached = this.#cache.get(key);
    const highestInvalidatedFence = this.#invalidationFences.highestFence(
      authority.pointerId,
    );
    if (
      cached &&
      cached.pointerId === authority.pointerId &&
      cached.releaseId === authority.releaseId &&
      cached.fence === authority.fence &&
      (highestInvalidatedFence === null ||
        !shouldDiscardFenceTaggedCache(
          { filledAtFence: cached.fence, pointerId: cached.pointerId },
          highestInvalidatedFence,
        ))
    ) {
      return cached.definition;
    }
    if (cached) this.#cache.delete(key);
    return this.#fillAndPublish(context);
  }

  async consumeInvalidation(
    context: TrustedRequestContext,
    event: ReleaseActivationInvalidationEvent,
    options: Readonly<{ doubt?: boolean }> = {},
  ): Promise<RequestRuntimeInvalidationResult> {
    assertTrustedRequestContext(context);
    if (
      context.tenantId !== event.tenantId ||
      context.environmentId !== event.environmentId
    ) {
      throw loadError(
        'INVALIDATION_CONTEXT_MISMATCH',
        'invalidation scope must match the issued trusted request context',
      );
    }
    const consumer = this.#invalidationFences.consume(event, options);
    const key = scopedPointerKey(
      event.tenantId,
      event.environmentId,
      event.pointerId,
    );
    const cached = this.#cache.get(key);
    if (
      cached &&
      shouldDiscardFenceTaggedCache(
        { filledAtFence: cached.fence, pointerId: cached.pointerId },
        consumer.highestFence,
      )
    ) {
      this.#cache.delete(key);
    }

    if (consumer.requestPointerReread) {
      const authority = await this.#readPointerAuthority(context);
      if (authority.pointerId !== event.pointerId) {
        throw loadError(
          'POINTER_IDENTITY_CHANGED',
          'authoritative pointer identity differs from invalidation identity',
        );
      }
      if (authority.fence < consumer.highestFence) {
        throw loadError(
          'INVALIDATION_AHEAD_OF_AUTHORITY',
          'invalidation fence is ahead of the authoritative pointer',
        );
      }
      const rereadCached = this.#cache.get(key);
      if (
        rereadCached &&
        (rereadCached.fence !== authority.fence ||
          rereadCached.releaseId !== authority.releaseId)
      ) {
        this.#cache.delete(key);
      }
    }

    return Object.freeze({
      authoritativePointerReread: consumer.requestPointerReread,
      consumer,
    });
  }

  async validatePin(
    context: TrustedRequestContext,
    envelope: PinnedRuntimeContextEnvelope,
  ): Promise<PinValidationResult> {
    assertTrustedRequestContext(context);
    const pin = parsePinnedRuntimeContextEnvelope(JSON.stringify(envelope));
    if (
      pin.schemaVersion !== PINNED_RUNTIME_CONTEXT_VERSION ||
      pin.tenantId !== context.tenantId ||
      pin.environmentId !== context.environmentId ||
      pin.principalId !== context.principalId
    ) {
      throw loadError(
        'PIN_CONTEXT_MISMATCH',
        'pinned context identity must match the issued trusted context',
      );
    }
    const authority = await this.#readPointerAuthority(context);
    if (
      authority.pointerId === pin.pointerId &&
      authority.releaseId === pin.releaseId &&
      authority.releaseContentHash === pin.releaseContentHash &&
      authority.fence === pin.pointerFence
    ) {
      return Object.freeze({
        resultVersion: PIN_VALIDATION_RESULT_VERSION,
        status: 'CURRENT',
      });
    }
    return Object.freeze({
      reason: 'POINTER_GENERATION_CHANGED',
      resultVersion: PIN_VALIDATION_RESULT_VERSION,
      status: 'STALE_RELEASE_REPLAN',
    });
  }

  async #fillAndPublish(
    context: TrustedRequestContext,
  ): Promise<LoadedRequestRuntimeDefinition> {
    for (let attempt = 0; attempt < maximumFillAttempts; attempt += 1) {
      const definition = await withTrustedRequestTransaction(
        this.pool,
        context,
        async (client) => loadAuthoritativeSnapshot(client, context),
      );
      await this.#beforeCachePublication?.(definition);

      const authority = await this.#readPointerAuthority(context);
      if (!definitionMatchesAuthority(definition, authority)) continue;
      const highestInvalidatedFence = this.#invalidationFences.highestFence(
        authority.pointerId,
      );
      if (
        highestInvalidatedFence !== null &&
        definition.pointer.fence < highestInvalidatedFence
      ) {
        continue;
      }

      const key = cacheKey(authority);
      const existing = this.#cache.get(key);
      if (!existing || existing.fence <= definition.pointer.fence) {
        this.#cache.set(key, {
          definition,
          fence: definition.pointer.fence,
          pointerId: authority.pointerId,
          releaseId: authority.releaseId,
        });
      }
      return definition;
    }
    throw loadError(
      'POINTER_CHANGED_DURING_LOAD',
      'active release pointer did not stabilize during request entry',
    );
  }

  async #readPointerAuthority(
    context: TrustedRequestContext,
  ): Promise<PointerAuthority> {
    return withTrustedRequestTransaction(this.pool, context, async (client) => {
      const result = await client.query<PointerRow>(pointerAuthoritySql, [
        context.tenantId,
        context.environmentId,
      ]);
      return pointerAuthorityFromRows(context, result.rows);
    });
  }
}

async function loadAuthoritativeSnapshot(
  client: PoolClient,
  context: TrustedRequestContext,
): Promise<LoadedRequestRuntimeDefinition> {
  // All mutable pointer and immutable release/artifact facts are read by this
  // one statement, so READ COMMITTED cannot split the fill across snapshots.
  const result = await client.query<SnapshotRow>(authoritativeSnapshotSql, [
    context.tenantId,
    context.environmentId,
  ]);
  return definitionFromSnapshotRows(context, result.rows);
}

function definitionFromSnapshotRows(
  context: TrustedRequestContext,
  rows: readonly SnapshotRow[],
): LoadedRequestRuntimeDefinition {
  const first = rows[0];
  if (!first) {
    throw loadError(
      'ACTIVE_POINTER_MISSING',
      'trusted tenant and environment have no active release pointer',
    );
  }
  assertSnapshotContext(context, first);
  if (first.pointer_release_id === null) {
    throw loadError(
      'NULL_ACTIVE_RELEASE',
      'active release pointer has no selected release',
    );
  }
  if (
    first.release_id === null ||
    first.release_content_hash === null ||
    first.release_compiler_version === null ||
    first.release_compiler_semantic_profile_version === null ||
    first.release_output_protocol_version === null
  ) {
    throw loadError(
      'ACTIVE_RELEASE_NOT_VISIBLE',
      'selected tenant release is missing or invisible in trusted context',
    );
  }
  const fence = safeFence(first.fence);
  const artifacts = new Map<string, ArtifactRecord>();
  const projectionLinks: ProjectionLinkRecord[] = [];
  const chunkLinks: ChunkLinkRecord[] = [];

  for (const row of rows) {
    assertSnapshotContext(context, row);
    if (
      row.pointer_id !== first.pointer_id ||
      row.pointer_release_id !== first.pointer_release_id ||
      row.fence !== first.fence ||
      row.release_id !== first.release_id ||
      row.release_content_hash !== first.release_content_hash
    ) {
      throw malformedRelease('snapshot rows disagree about release identity');
    }
    if (
      row.artifact_kind === null ||
      row.artifact_content_hash === null ||
      row.artifact_domain_tag === null ||
      row.artifact_media_type === null ||
      row.artifact_canonical_bytes === null
    ) {
      throw malformedRelease('selected release artifact set is incomplete');
    }
    const artifact: ArtifactRecord = {
      bytes: new Uint8Array(row.artifact_canonical_bytes),
      contentHash: row.artifact_content_hash,
      domainTag: row.artifact_domain_tag,
      kind: row.artifact_kind,
      mediaType: row.artifact_media_type,
    };
    const existing = artifacts.get(artifact.contentHash);
    if (existing && !sameArtifact(existing, artifact)) {
      throw malformedRelease('duplicate artifact hash has conflicting data');
    }
    artifacts.set(artifact.contentHash, artifact);
    if (
      row.manifest_projection_instance_id !== null ||
      row.manifest_projection_family_id !== null
    ) {
      if (
        row.manifest_projection_instance_id === null ||
        row.manifest_projection_family_id === null
      ) {
        throw malformedProjection('projection link is incomplete');
      }
      addUniqueProjectionLink(projectionLinks, {
        familyId: row.manifest_projection_family_id,
        instanceId: row.manifest_projection_instance_id,
        manifestHash: artifact.contentHash,
      });
    }
    if (row.chunk_projection_instance_id !== null || row.chunk_id !== null) {
      if (row.chunk_projection_instance_id === null || row.chunk_id === null) {
        throw malformedProjection('projection chunk link is incomplete');
      }
      addUniqueChunkLink(chunkLinks, {
        chunkHash: artifact.contentHash,
        chunkId: row.chunk_id,
        instanceId: row.chunk_projection_instance_id,
      });
    }
  }

  const root = artifacts.get(first.release_content_hash);
  if (!root || root.kind !== 'releaseManifest') {
    throw malformedRelease('release root artifact is missing');
  }
  verifyArtifact(root, HASH_DOMAINS.releaseManifest, 'MALFORMED_RELEASE');
  const releaseManifest = decodeCanonicalObject(
    root.bytes,
    'MALFORMED_RELEASE',
  );
  validateReleaseManifest(first, releaseManifest);
  const references = requireArray(releaseManifest.projections, 'projections');
  const closure = new Set(
    requireArray(releaseManifest.artifactClosure, 'artifactClosure').map(
      (entry) => requireString(entry, 'artifactClosure entry'),
    ),
  );

  const projectionFor = <TFamily extends RequestRuntimeProjectionFamily>(
    familyId: TFamily,
  ): RuntimeProjection<TFamily> => {
    const referenceMatches = references.filter(
      (entry) => isRecord(entry) && entry.familyId === familyId,
    );
    const linkMatches = projectionLinks.filter(
      (entry) => entry.familyId === familyId,
    );
    if (referenceMatches.length === 0 || linkMatches.length === 0) {
      throw loadError(
        'REQUIRED_PROJECTION_MISSING',
        `required runtime projection is missing: ${familyId}`,
      );
    }
    if (referenceMatches.length !== 1 || linkMatches.length !== 1) {
      throw loadError(
        'REQUIRED_PROJECTION_DUPLICATE',
        `required runtime projection is duplicated: ${familyId}`,
      );
    }
    const reference = referenceMatches[0];
    const link = linkMatches[0];
    if (!isRecord(reference) || !link) {
      throw malformedProjection('projection reference is malformed');
    }
    const artifactRoot = requireSha256(reference.artifactRoot, 'artifactRoot');
    const instanceId = requireString(reference.instanceId, 'instanceId');
    if (
      link.instanceId !== instanceId ||
      link.manifestHash !== artifactRoot ||
      !closure.has(artifactRoot)
    ) {
      throw malformedProjection('projection reference and link disagree');
    }
    const manifestArtifact = artifacts.get(artifactRoot);
    if (!manifestArtifact || manifestArtifact.kind !== 'projectionManifest') {
      throw malformedProjection('projection manifest artifact is missing');
    }
    verifyArtifact(
      manifestArtifact,
      `${HASH_DOMAINS.projectionManifest}/${familyId}`,
      'MALFORMED_REQUIRED_PROJECTION',
    );
    const manifest = decodeCanonicalObject(
      manifestArtifact.bytes,
      'MALFORMED_REQUIRED_PROJECTION',
    );
    const payloadSchemaVersion = validateProjectionManifest(
      familyId,
      reference,
      manifest,
    );
    const descriptors = requireArray(manifest.chunks, 'chunks');
    if (descriptors.length !== 1) {
      throw malformedProjection(
        'supported single-chunk projection must have exactly one chunk',
      );
    }
    const descriptor = descriptors[0];
    if (!isRecord(descriptor)) {
      throw malformedProjection('projection chunk descriptor is malformed');
    }
    const chunkId = requireString(descriptor.chunkId, 'chunkId');
    const chunkHash = requireSha256(
      descriptor.contentHash,
      'chunk contentHash',
    );
    const byteLength = requireSafeInteger(descriptor.byteLength, 'byteLength');
    const matchingChunkLinks = chunkLinks.filter(
      (entry) =>
        entry.instanceId === instanceId &&
        entry.chunkId === chunkId &&
        entry.chunkHash === chunkHash,
    );
    if (matchingChunkLinks.length !== 1 || !closure.has(chunkHash)) {
      throw malformedProjection(
        'projection chunk link is missing or duplicated',
      );
    }
    const chunkArtifact = artifacts.get(chunkHash);
    if (!chunkArtifact || chunkArtifact.kind !== 'projectionChunk') {
      throw malformedProjection('projection chunk artifact is missing');
    }
    verifyArtifact(
      chunkArtifact,
      `${HASH_DOMAINS.projectionChunk}/${familyId}`,
      'MALFORMED_REQUIRED_PROJECTION',
    );
    if (
      byteLength !== chunkArtifact.bytes.byteLength ||
      descriptor.chunkDescriptorVersion !== CHUNK_DESCRIPTOR_VERSION ||
      descriptor.mediaType !== artifactMediaType ||
      canonicalize(descriptor.logicalScope) !==
        canonicalize(manifest.logicalScope)
    ) {
      throw malformedProjection('projection chunk descriptor does not match');
    }
    const semanticDigest = requireSha256(
      manifest.semanticDigest,
      'semanticDigest',
    );
    if (
      semanticDigest !==
      hashBytes(
        `${HASH_DOMAINS.projectionSemantic}/${familyId}`,
        chunkArtifact.bytes,
      )
    ) {
      throw malformedProjection('projection semantic digest does not match');
    }
    const payload = decodeCanonicalJson(
      chunkArtifact.bytes,
      'MALFORMED_REQUIRED_PROJECTION',
    );
    const expected = supportedProjectionSchemas[familyId];
    if (
      !isRecord(payload) ||
      payload.kind !== expected.payloadKind ||
      payload.schemaVersion !== payloadSchemaVersion
    ) {
      throw malformedProjection(
        'projection payload version or kind is unsupported',
      );
    }
    return Object.freeze({
      artifactRoot,
      familyId,
      instanceId,
      payload: freezeJson(payload),
      payloadSchemaVersion,
      semanticDigest,
    });
  };

  return Object.freeze({
    environmentId: context.environmentId,
    pointer: Object.freeze({ fence, pointerId: first.pointer_id }),
    projections: Object.freeze({
      agent: projectionFor(REQUEST_RUNTIME_PROJECTION_FAMILIES.agent),
      catalog: projectionFor(REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog),
      operation: projectionFor(REQUEST_RUNTIME_PROJECTION_FAMILIES.operation),
      query: projectionFor(REQUEST_RUNTIME_PROJECTION_FAMILIES.query),
      surface: projectionFor(REQUEST_RUNTIME_PROJECTION_FAMILIES.surface),
    }),
    release: Object.freeze({
      contentHash: first.release_content_hash,
      releaseId: first.release_id,
    }),
    tenantId: context.tenantId,
  });
}

function validateReleaseManifest(
  row: SnapshotRow,
  manifest: Record<string, unknown>,
): void {
  if (
    manifest.kind !== 'releaseManifest' ||
    manifest.manifestVersion !== RELEASE_MANIFEST_VERSION ||
    manifest.outputProtocolVersion !== OUTPUT_PROTOCOL_VERSION ||
    manifest.outputProtocolVersion !== row.release_output_protocol_version ||
    manifest.compilerVersion !== row.release_compiler_version ||
    manifest.compilerSemanticProfileVersion !==
      row.release_compiler_semantic_profile_version ||
    manifest.completeSnapshot !== true ||
    manifest.policyDecisionDependency !== 'liveCurrentDenyCapable' ||
    manifest.runtimeOverlayEvaluation !== 'forbidden' ||
    !Array.isArray(manifest.projections) ||
    !Array.isArray(manifest.artifactClosure)
  ) {
    throw malformedRelease('release manifest contract is malformed');
  }
}

function validateProjectionManifest(
  familyId: RequestRuntimeProjectionFamily,
  reference: Record<string, unknown>,
  manifest: Record<string, unknown>,
): string {
  const expected = supportedProjectionSchemas[familyId];
  const payloadSchemaVersion = manifest.payloadSchemaVersion;
  if (
    typeof payloadSchemaVersion !== 'string' ||
    !expected.payloadSchemaVersions.some(
      (supported) => supported === payloadSchemaVersion,
    ) ||
    manifest.kind !== 'projectionManifest' ||
    manifest.familyId !== familyId ||
    manifest.instanceId !== reference.instanceId ||
    manifest.manifestVersion !== PROJECTION_MANIFEST_VERSION ||
    manifest.outputProtocolVersion !== OUTPUT_PROTOCOL_VERSION ||
    manifest.chunkingSchemeVersion !== CHUNKING_SCHEME_VERSION ||
    canonicalize(reference) !==
      canonicalize({
        artifactRoot: reference.artifactRoot,
        chunkingSchemeVersion: manifest.chunkingSchemeVersion,
        compatibility: manifest.compatibility,
        familyId: manifest.familyId,
        instanceId: manifest.instanceId,
        logicalScope: manifest.logicalScope,
        manifestVersion: manifest.manifestVersion,
        outputProtocolVersion: manifest.outputProtocolVersion,
        payloadSchemaVersion: manifest.payloadSchemaVersion,
        requiredRuntimeCapability: manifest.requiredRuntimeCapability,
        semanticDigest: manifest.semanticDigest,
      }) ||
    !Array.isArray(manifest.chunks)
  ) {
    throw malformedProjection('projection manifest contract is malformed');
  }
  return payloadSchemaVersion;
}

function pointerAuthorityFromRows(
  context: TrustedRequestContext,
  rows: readonly PointerRow[],
): PointerAuthority {
  const row = rows[0];
  if (!row) {
    throw loadError(
      'ACTIVE_POINTER_MISSING',
      'trusted tenant and environment have no active release pointer',
    );
  }
  if (
    row.tenant_id !== context.tenantId ||
    row.environment_id !== context.environmentId
  ) {
    throw loadError(
      'REQUEST_CONTEXT_MISMATCH',
      'authoritative pointer scope differs from trusted request context',
    );
  }
  if (row.pointer_release_id === null) {
    throw loadError(
      'NULL_ACTIVE_RELEASE',
      'active release pointer has no selected release',
    );
  }
  if (row.release_id === null || row.release_content_hash === null) {
    throw loadError(
      'ACTIVE_RELEASE_NOT_VISIBLE',
      'selected tenant release is missing or invisible in trusted context',
    );
  }
  if (!sha256Pattern.test(row.release_content_hash)) {
    throw malformedRelease(
      'release content hash must be a lowercase SHA-256 digest',
    );
  }
  return {
    environmentId: row.environment_id,
    fence: safeFence(row.fence),
    pointerId: row.pointer_id,
    releaseContentHash: row.release_content_hash,
    releaseId: row.release_id,
    tenantId: row.tenant_id,
  };
}

function assertSnapshotContext(
  context: TrustedRequestContext,
  row: SnapshotRow,
): void {
  if (
    row.tenant_id !== context.tenantId ||
    row.environment_id !== context.environmentId
  ) {
    throw loadError(
      'REQUEST_CONTEXT_MISMATCH',
      'authoritative snapshot scope differs from trusted request context',
    );
  }
}

function definitionMatchesAuthority(
  definition: LoadedRequestRuntimeDefinition,
  authority: PointerAuthority,
): boolean {
  return (
    definition.tenantId === authority.tenantId &&
    definition.environmentId === authority.environmentId &&
    definition.pointer.pointerId === authority.pointerId &&
    definition.pointer.fence === authority.fence &&
    definition.release.releaseId === authority.releaseId &&
    definition.release.contentHash === authority.releaseContentHash
  );
}

function cacheKey(authority: PointerAuthority): string {
  return scopedPointerKey(
    authority.tenantId,
    authority.environmentId,
    authority.pointerId,
  );
}

function scopedPointerKey(
  tenantId: string,
  environmentId: string,
  pointerId: string,
): string {
  return `${tenantId}\0${environmentId}\0${pointerId}`;
}

function addUniqueProjectionLink(
  links: ProjectionLinkRecord[],
  candidate: ProjectionLinkRecord,
): void {
  if (
    !links.some(
      (entry) =>
        entry.familyId === candidate.familyId &&
        entry.instanceId === candidate.instanceId &&
        entry.manifestHash === candidate.manifestHash,
    )
  ) {
    links.push(candidate);
  }
}

function addUniqueChunkLink(
  links: ChunkLinkRecord[],
  candidate: ChunkLinkRecord,
): void {
  if (
    !links.some(
      (entry) =>
        entry.instanceId === candidate.instanceId &&
        entry.chunkId === candidate.chunkId &&
        entry.chunkHash === candidate.chunkHash,
    )
  ) {
    links.push(candidate);
  }
}

function verifyArtifact(
  artifact: ArtifactRecord,
  expectedDomain: string,
  code: 'MALFORMED_RELEASE' | 'MALFORMED_REQUIRED_PROJECTION',
): void {
  if (
    artifact.domainTag !== expectedDomain ||
    artifact.mediaType !== artifactMediaType ||
    !sha256Pattern.test(artifact.contentHash) ||
    artifact.bytes.byteLength === 0 ||
    hashBytes(artifact.domainTag, artifact.bytes) !== artifact.contentHash
  ) {
    throw loadError(code, 'artifact bytes, domain, or digest are invalid');
  }
}

function sameArtifact(left: ArtifactRecord, right: ArtifactRecord): boolean {
  return (
    left.contentHash === right.contentHash &&
    left.domainTag === right.domainTag &&
    left.kind === right.kind &&
    left.mediaType === right.mediaType &&
    Buffer.from(left.bytes).equals(Buffer.from(right.bytes))
  );
}

function decodeCanonicalObject(
  bytes: Uint8Array,
  code: 'MALFORMED_RELEASE' | 'MALFORMED_REQUIRED_PROJECTION',
): Record<string, unknown> {
  const value = decodeCanonicalJson(bytes, code);
  if (!isRecord(value)) {
    throw loadError(code, 'canonical artifact must decode to an object');
  }
  return value;
}

function decodeCanonicalJson(
  bytes: Uint8Array,
  code: 'MALFORMED_RELEASE' | 'MALFORMED_REQUIRED_PROJECTION',
): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !Buffer.from(bytes).equals(
        Buffer.from(new TextEncoder().encode(canonicalize(value))),
      )
    ) {
      throw new Error('artifact JSON is not canonical');
    }
    return value;
  } catch (error) {
    if (error instanceof RequestRuntimeViewLoadError) throw error;
    throw loadError(code, 'artifact is not canonical JSON');
  }
}

function freezeJson(value: unknown): ImmutableJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeJson(entry)));
  }
  if (isRecord(value)) {
    const result: Record<string, ImmutableJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = freezeJson(entry);
    }
    return Object.freeze(result);
  }
  throw malformedProjection('projection payload contains a non-JSON value');
}

function hashBytes(domainTag: string, bytes: Uint8Array): string {
  return createHash('sha256')
    .update(domainTag, 'utf8')
    .update(Uint8Array.of(0))
    .update(bytes)
    .digest('hex');
}

function safeFence(value: string): number {
  const fence = Number(value);
  if (!Number.isSafeInteger(fence) || fence < 0) {
    throw malformedRelease('pointer fence is not a nonnegative safe integer');
  }
  return fence;
}

function requireSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw malformedProjection(`${name} must be a nonnegative safe integer`);
  }
  return Number(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw malformedProjection(`${name} must not be blank`);
  }
  return value;
}

function requireSha256(value: unknown, name: string): string {
  const text = requireString(value, name);
  if (!sha256Pattern.test(text)) {
    throw malformedProjection(`${name} must be a lowercase SHA-256 digest`);
  }
  return text;
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw malformedProjection(`${name} must be an array`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformedRelease(message: string): RequestRuntimeViewLoadError {
  return loadError('MALFORMED_RELEASE', message);
}

function malformedProjection(message: string): RequestRuntimeViewLoadError {
  return loadError('MALFORMED_REQUIRED_PROJECTION', message);
}

function loadError(
  code: RequestRuntimeViewLoadErrorCode,
  message: string,
): RequestRuntimeViewLoadError {
  return new RequestRuntimeViewLoadError(code, message);
}
