import {
  canonicalizeAndHash,
  parseNormalizedApplicationPackageJson,
} from '@north-star/canonical-model';
import {
  compilerAttestationFromManifest,
  diffCompiledReleases,
  type ContentAddressedArtifact,
  type ReleaseManifestEnvelope,
} from '@north-star/compiler';
import { renderCompiledDiff } from '@north-star/customization';
import type { MintedUuid } from '@north-star/platform-runtime';
import type { TrustedRequestContext } from '@north-star/runtime';
import type { PoolClient } from 'pg';

import type { ParsedRelease } from './composed-application-runtime.js';

/**
 * What the approver of one release edge is shown and what the approval binds:
 * the compiler's canonical diff digest and the digest of the plain-language
 * rendering of it (CUSTOMIZE). A reverse edge -- a rollback -- binds the
 * forward diff it undoes, read backwards.
 */
export interface ReleaseDiffBinding {
  readonly canonicalDiffDigest: string;
  readonly renderedDigest: string;
  readonly renderedText: string;
  readonly transitionPlanDigest: string | null;
}

export function releaseDiffBinding(
  source: ParsedRelease,
  target: ParsedRelease,
  direction: 'forward' | 'reverse' = 'forward',
): ReleaseDiffBinding {
  const [from, to] =
    direction === 'forward' ? [source, target] : [target, source];
  const diff = diffCompiledReleases(from.compiled, to.compiled);
  const rendered = renderCompiledDiff(from, to, diff, direction);
  return Object.freeze({
    canonicalDiffDigest: diff.canonicalDiffDigest,
    renderedDigest: rendered.renderedDigest,
    renderedText: rendered.text,
    transitionPlanDigest: diff.transitionPlanDigest,
  });
}

export async function loadPersistedDiffRelease(
  client: PoolClient,
  scope: Pick<TrustedRequestContext, 'tenantId' | 'environmentId'>,
  releaseId: MintedUuid,
): Promise<ParsedRelease> {
  const {
    rows: [release],
  } = await client.query<{
    content_hash: string;
    desired_state: Buffer;
    compiler_attestation_digest: string;
  }>(
    `SELECT release.content_hash, revision.desired_state, release.compiler_attestation_digest
       FROM platform.tenant_releases AS release
       JOIN platform.app_package_revisions AS revision
         ON (revision.tenant_id, revision.revision_id) = (release.tenant_id, release.app_package_revision_id)
      WHERE (release.tenant_id, release.environment_id, release.release_id) = ($1,$2,$3)`,
    [scope.tenantId, scope.environmentId, releaseId],
  );
  if (!release) throw new Error('the recorded release is missing');
  const { rows } = await client.query<{
    artifact_kind: ContentAddressedArtifact['artifactKind'];
    content_hash: string;
    domain_tag: string;
    media_type: ContentAddressedArtifact['mediaType'];
    canonical_bytes: Buffer;
  }>('SELECT * FROM platform.read_tenant_release_artifacts($1)', [releaseId]);
  const artifacts: ContentAddressedArtifact[] = rows.map((artifact) => ({
    artifactKind: artifact.artifact_kind,
    contentHash: artifact.content_hash,
    domainTag: artifact.domain_tag,
    mediaType: artifact.media_type,
    canonicalBytes: artifact.canonical_bytes,
    kind: 'contentAddressedArtifact',
  }));
  const manifest = artifacts.find(
    (artifact) => artifact.contentHash === release.content_hash,
  );
  if (!manifest) throw new Error('the recorded release has no manifest');
  const releaseManifest = JSON.parse(
    Buffer.from(manifest.canonicalBytes).toString('utf8'),
  ) as ReleaseManifestEnvelope;
  const attestation = compilerAttestationFromManifest(
    releaseManifest,
    release.content_hash,
  );
  const definition = parseNormalizedApplicationPackageJson(
    release.desired_state,
  );
  if (
    attestation.attestationDigest !== release.compiler_attestation_digest ||
    canonicalizeAndHash(definition).contentHash !==
      releaseManifest.normalizedDefinitionDigest
  ) {
    throw new Error(
      'the recorded release definition or compiler attestation disagrees with its manifest',
    );
  }
  return {
    normalizedDefinitionBytes: release.desired_state,
    compiled: {
      attestation,
      bundle: {
        artifacts,
        releaseManifest,
        releaseManifestBytes: manifest.canonicalBytes,
        outputProtocolVersion: releaseManifest.outputProtocolVersion,
        nodeContracts: [],
        kind: 'compiledReleaseBundle',
      },
      stagedArtifacts: artifacts,
      status: 'compiled',
      diagnostics: [],
      releaseRoot: release.content_hash,
    },
  };
}
