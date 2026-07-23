import { hashCanonical } from './hash.js';
import {
  HASH_DOMAINS,
  PROJECTION_FAMILY_IDS,
  RELEASE_DIFF_ALGORITHM_VERSION,
  RELEASE_DIFF_VERSION,
  type CompileSuccess,
  type ProjectionFamilyId,
  type ProjectionManifestEnvelope,
  type ReleaseChange,
  type ReleaseDiffEnvelope,
  type ReleaseImpactCode,
} from './protocol.js';

interface SemanticConstruct {
  constructKind: string;
  semanticFingerprint: string;
  subjectId: string;
}

interface SemanticModelPayload {
  constructs: SemanticConstruct[];
}

interface SurfaceManifestPayload {
  surfaces: Array<{ fieldIds: string[] }>;
}

interface StorageTransitionPayload {
  fromNormalizedDefinitionDigest: string;
  fromReleaseRoot: string;
  fromStorageTargetArtifactRoot: string;
  fromStorageTargetSemanticDigest: string;
  toNormalizedDefinitionDigest: string;
  toStorageTargetArtifactRoot: string;
  toStorageTargetSemanticDigest: string;
}

const impactByFamily: Record<ProjectionFamilyId, ReleaseImpactCode> = {
  [PROJECTION_FAMILY_IDS.agentDiscovery]: 'agent-discovery-changed',
  [PROJECTION_FAMILY_IDS.operationCatalog]: 'operation-contract-changed',
  [PROJECTION_FAMILY_IDS.policyReferences]: 'policy-reference-changed',
  [PROJECTION_FAMILY_IDS.queryCatalog]: 'query-contract-changed',
  [PROJECTION_FAMILY_IDS.reporting]: 'reporting-projection-changed',
  [PROJECTION_FAMILY_IDS.semanticModel]: 'semantic-contract-changed',
  [PROJECTION_FAMILY_IDS.storageTarget]: 'storage-target-changed',
  [PROJECTION_FAMILY_IDS.storageTransition]: 'storage-transition-required',
  [PROJECTION_FAMILY_IDS.surfaceManifest]: 'surface-only',
  [PROJECTION_FAMILY_IDS.verificationPlan]: 'verification-plan-changed',
};

export function diffCompiledReleases(
  from: CompileSuccess,
  to: CompileSuccess,
): ReleaseDiffEnvelope {
  const transitionPlanDigest = transitionDigestForPair(from, to);
  const fromSemantic = projectionPayload<SemanticModelPayload>(
    from,
    PROJECTION_FAMILY_IDS.semanticModel,
  );
  const toSemantic = projectionPayload<SemanticModelPayload>(
    to,
    PROJECTION_FAMILY_IDS.semanticModel,
  );
  const fromConstructs = new Map(
    fromSemantic.constructs.map((entry) => [entry.subjectId, entry] as const),
  );
  const toConstructs = new Map(
    toSemantic.constructs.map((entry) => [entry.subjectId, entry] as const),
  );
  const fromSurfaceFields = surfaceFieldIds(from);
  const toSurfaceFields = surfaceFieldIds(to);
  const changedProjectionRefs = changedProjections(from, to);
  const affectedProjectionIds = changedProjectionRefs
    .map((entry) => entry.instanceId)
    .sort(compare);
  const changes: ReleaseChange[] = [];

  for (const subjectId of [
    ...new Set([...fromConstructs.keys(), ...toConstructs.keys()]),
  ].sort(compare)) {
    const before = fromConstructs.get(subjectId);
    const after = toConstructs.get(subjectId);
    if (before?.semanticFingerprint === after?.semanticFingerprint) continue;
    const impactCodes = new Set<ReleaseImpactCode>([
      'semantic-contract-changed',
    ]);
    if (
      after?.constructKind === 'fieldDefinition' &&
      !before &&
      !fromSurfaceFields.has(subjectId) &&
      toSurfaceFields.has(subjectId)
    ) {
      impactCodes.add('authorization-surface-added');
    }
    changes.push({
      affectedProjections: affectedProjectionIds,
      afterSemanticFingerprint: after?.semanticFingerprint ?? null,
      beforeSemanticFingerprint: before?.semanticFingerprint ?? null,
      changeKind: !before ? 'added' : !after ? 'removed' : 'changed',
      constructKind: after?.constructKind ?? before!.constructKind,
      impactCodes: [...impactCodes].sort(compare),
      subjectId,
    });
  }

  for (const projection of changedProjectionRefs) {
    const before = from.bundle.releaseManifest.projections.find(
      (entry) => entry.instanceId === projection.instanceId,
    );
    const after = to.bundle.releaseManifest.projections.find(
      (entry) => entry.instanceId === projection.instanceId,
    );
    changes.push({
      affectedProjections: [projection.instanceId],
      afterSemanticFingerprint: after?.semanticDigest ?? null,
      beforeSemanticFingerprint: before?.semanticDigest ?? null,
      changeKind: !before ? 'added' : !after ? 'removed' : 'changed',
      constructKind: 'projection',
      impactCodes: [impactByFamily[projection.familyId]],
      subjectId: projection.instanceId,
    });
  }

  changes.sort(
    (left, right) =>
      compare(left.subjectId, right.subjectId) ||
      compare(left.constructKind, right.constructKind) ||
      compare(left.changeKind, right.changeKind),
  );
  const impactCodes = [
    ...new Set(changes.flatMap((change) => change.impactCodes)),
  ].sort(compare);
  const core = {
    algorithmVersion: RELEASE_DIFF_ALGORITHM_VERSION,
    changes,
    diffVersion: RELEASE_DIFF_VERSION,
    fromManifestRoot: from.releaseRoot,
    fromNormalizedDefinitionDigest:
      from.bundle.releaseManifest.normalizedDefinitionDigest,
    impactCodes,
    kind: 'releaseDiff' as const,
    toManifestRoot: to.releaseRoot,
    toNormalizedDefinitionDigest:
      to.bundle.releaseManifest.normalizedDefinitionDigest,
    transitionPlanDigest,
  };
  return {
    ...core,
    canonicalDiffDigest: hashCanonical(HASH_DOMAINS.diff, core).digest,
  };
}

function transitionDigestForPair(
  from: CompileSuccess,
  to: CompileSuccess,
): string | null {
  const fromStorage = projectionReference(
    from,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const toStorage = projectionReference(
    to,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const transitions = to.bundle.releaseManifest.projections.filter(
    (entry) => entry.familyId === PROJECTION_FAMILY_IDS.storageTransition,
  );
  if (transitions.length > 1) {
    throw new Error('release diff requires exactly one candidate transition');
  }
  const transition = transitions[0];
  if (!transition) {
    if (fromStorage.semanticDigest !== toStorage.semanticDigest) {
      throw new Error('release diff storage change has no transition plan');
    }
    return null;
  }
  const payload = projectionPayload<StorageTransitionPayload>(
    to,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  const exactPair =
    payload.fromNormalizedDefinitionDigest ===
      from.bundle.releaseManifest.normalizedDefinitionDigest &&
    payload.fromReleaseRoot === from.releaseRoot &&
    payload.fromStorageTargetArtifactRoot === fromStorage.artifactRoot &&
    payload.fromStorageTargetSemanticDigest === fromStorage.semanticDigest &&
    payload.toNormalizedDefinitionDigest ===
      to.bundle.releaseManifest.normalizedDefinitionDigest &&
    payload.toStorageTargetArtifactRoot === toStorage.artifactRoot &&
    payload.toStorageTargetSemanticDigest === toStorage.semanticDigest;
  if (!exactPair) {
    throw new Error('release diff transition does not bind supplied pair');
  }
  return transition.semanticDigest;
}

function surfaceFieldIds(compiled: CompileSuccess): Set<string> {
  const payload = projectionPayload<SurfaceManifestPayload>(
    compiled,
    PROJECTION_FAMILY_IDS.surfaceManifest,
  );
  return new Set(payload.surfaces.flatMap((surface) => surface.fieldIds));
}

function changedProjections(
  from: CompileSuccess,
  to: CompileSuccess,
): Array<{ familyId: ProjectionFamilyId; instanceId: string }> {
  const byIdentity = new Map<
    string,
    {
      familyId: ProjectionFamilyId;
      fromDigest: string | null;
      instanceId: string;
      toDigest: string | null;
    }
  >();
  for (const entry of from.bundle.releaseManifest.projections) {
    byIdentity.set(entry.instanceId, {
      familyId: entry.familyId,
      fromDigest: entry.semanticDigest,
      instanceId: entry.instanceId,
      toDigest: null,
    });
  }
  for (const entry of to.bundle.releaseManifest.projections) {
    const current = byIdentity.get(entry.instanceId);
    byIdentity.set(entry.instanceId, {
      familyId: entry.familyId,
      fromDigest: current?.fromDigest ?? null,
      instanceId: entry.instanceId,
      toDigest: entry.semanticDigest,
    });
  }
  return [...byIdentity.values()]
    .filter((entry) => entry.fromDigest !== entry.toDigest)
    .map(({ familyId, instanceId }) => ({ familyId, instanceId }))
    .sort((left, right) => compare(left.instanceId, right.instanceId));
}

function projectionPayload<T>(
  compiled: CompileSuccess,
  familyId: ProjectionFamilyId,
): T {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (entry) => entry.familyId === familyId,
  );
  if (!reference) throw new Error(`missing projection ${familyId}`);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (entry) => entry.contentHash === reference.artifactRoot,
  );
  if (!manifestArtifact) throw new Error(`missing manifest ${familyId}`);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  const chunkHash = manifest.chunks[0]?.contentHash;
  const chunk = compiled.bundle.artifacts.find(
    (entry) => entry.contentHash === chunkHash,
  );
  if (!chunk) throw new Error(`missing chunk ${familyId}`);
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
}

function projectionReference(
  compiled: CompileSuccess,
  familyId: ProjectionFamilyId,
) {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (entry) => entry.familyId === familyId,
  );
  if (!reference) throw new Error(`missing projection ${familyId}`);
  return reference;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
