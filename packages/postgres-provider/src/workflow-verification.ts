import { createHash } from 'node:crypto';
import { canonicalize } from '@north-star/canonical-model';
import {
  PROJECTION_FAMILY_IDS,
  workflowTierBDependencies,
  type ProjectionFamilyId,
  type ProjectionManifestEnvelope,
  type ReleaseManifestEnvelope,
  type StorageTargetPayloadV1,
} from '@north-star/compiler';
import type { PersistedTenantRelease } from '@north-star/platform-runtime';
import type { PoolClient } from 'pg';

import { parsePinnedOperationCatalog } from '../../runtime/src/semantic-operation-gateway.js';
import { sha256 } from './workflow-execution.js';
import type { WorkflowGrants } from './workflow-sdk.js';

type WorkflowVerificationRelease = {
  readonly artifacts: readonly Pick<
    PersistedTenantRelease['artifacts'][number],
    'artifactKind' | 'canonicalBytes' | 'contentHash' | 'domainTag'
  >[];
  readonly release: Pick<
    PersistedTenantRelease['release'],
    | 'contentHash'
    | 'tenantId'
    | 'environmentId'
    | 'releaseId'
    | 'verificationEvidenceId'
  >;
};

function pinnedProjection(
  release: WorkflowVerificationRelease,
  family: ProjectionFamilyId,
): unknown {
  function read<T>(hash: string | undefined, kind: string): T {
    const artifact = release.artifacts.find(
      (entry) => entry.contentHash === hash,
    );
    if (
      !artifact ||
      artifact.artifactKind !== kind ||
      createHash('sha256')
        .update(artifact.domainTag)
        .update(Uint8Array.of(0))
        .update(artifact.canonicalBytes)
        .digest('hex') !== hash
    ) {
      throw new Error(
        `Workflow verification artifact is missing or invalid: ${family}`,
      );
    }
    return JSON.parse(Buffer.from(artifact.canonicalBytes).toString()) as T;
  }
  const root = read<ReleaseManifestEnvelope>(
    release.release.contentHash,
    'releaseManifest',
  );
  const reference = root.projections.find(
    (projection) => projection.familyId === family,
  );
  const manifest = read<ProjectionManifestEnvelope>(
    reference?.artifactRoot,
    'projectionManifest',
  );
  if (manifest.familyId !== family || manifest.chunks.length !== 1)
    throw new Error(
      `Workflow verification projection is unavailable: ${family}`,
    );
  return read(manifest.chunks[0]?.contentHash, 'projectionChunk');
}

export function compileWorkflowUnattendedOperations(
  release: WorkflowVerificationRelease,
  grants: WorkflowGrants,
) {
  if (!grants.operations.length) return {};
  const catalog = parsePinnedOperationCatalog(
    pinnedProjection(release, PROJECTION_FAMILY_IDS.operationCatalog),
  );
  const storage = pinnedProjection(
    release,
    PROJECTION_FAMILY_IDS.storageTarget,
  ) as StorageTargetPayloadV1;
  if (storage.kind !== 'storageTargetPayload') return {};
  const dependencies = workflowTierBDependencies(
    storage,
    new Set(
      catalog
        .filter((operation) => operation.tier === 'o1')
        .map((operation) => operation.operationId),
    ),
  );
  const candidates = new Set(grants.operations);
  const entities = new Set(storage.entities.map((entity) => entity.entityId));
  return Object.fromEntries(
    catalog.flatMap((operation) => {
      if (
        !candidates.has(operation.operationId) ||
        operation.lifecycle !== 'active' ||
        operation.tier !== 'o0' ||
        operation.effect.kind !== 'createRecordEffect' ||
        operation.confirmation !== 'none' ||
        !operation.inputContract
      )
        return [];
      const entity = operation.effect.entity.targetId;
      if (!entities.has(entity) || dependencies.has(entity)) return [];
      return [
        [
          operation.operationId,
          {
            releaseRoot: release.release.contentHash,
            operationDigest: sha256(canonicalize(operation)),
            inputContractDigest: sha256(canonicalize(operation.inputContract)),
            reachableWriteEntities: [entity],
            tierBIntersections: [],
          },
        ],
      ];
    }),
  );
}

/** Called on the verifier connection after verification of the exact definition. */
export async function recordVerifiedWorkflow(
  client: PoolClient,
  release: WorkflowVerificationRelease,
  definition: {
    readonly id: string;
    readonly digest: string;
    readonly grants: WorkflowGrants;
  },
  resultBytes: Uint8Array,
): Promise<void> {
  const pin = release.release;
  await client.query(
    `INSERT INTO platform.workflow_verification_evidence (
       tenant_id, environment_id, verification_evidence_id, workflow_id,
       binding_digest, result_bytes, unattended_operations, verified_release_id, verified_release_root
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      pin.tenantId,
      pin.environmentId,
      pin.verificationEvidenceId,
      definition.id,
      definition.digest,
      Buffer.from(resultBytes),
      JSON.stringify(
        compileWorkflowUnattendedOperations(release, definition.grants),
      ),
      pin.releaseId,
      pin.contentHash,
    ],
  );
}
