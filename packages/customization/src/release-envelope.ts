import type {
  CompileSuccess,
  ContentAddressedArtifact,
} from '@north-star/compiler';

import type { CompiledCustomization } from './candidate.js';

/**
 * One compiled release as JSON-safe data: the same envelope
 * `apps/web/release/app.compiled.json` records per lineage entry, so the
 * isolated worker and its caller exchange releases in the shape the composed
 * runtime already parses.
 */
export interface SerializedRelease {
  readonly attestation: unknown;
  readonly artifacts: readonly Record<string, unknown>[];
  readonly nodeContracts: unknown;
  readonly normalizedDefinitionBytesBase64: string;
  readonly outputProtocolVersion: string;
  readonly releaseManifest: unknown;
  readonly releaseManifestBytesBase64: string;
  readonly releaseRoot: string;
  readonly stagedArtifactHashes: readonly string[];
}

export function serializeRelease(
  release: CompiledCustomization,
): SerializedRelease {
  const { compiled } = release;
  return {
    attestation: compiled.attestation,
    artifacts: compiled.bundle.artifacts.map((artifact) => ({
      artifactKind: artifact.artifactKind,
      canonicalBytesBase64: base64(artifact.canonicalBytes),
      contentHash: artifact.contentHash,
      domainTag: artifact.domainTag,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
    })),
    nodeContracts: compiled.bundle.nodeContracts,
    normalizedDefinitionBytesBase64: base64(release.normalizedDefinitionBytes),
    outputProtocolVersion: compiled.bundle.outputProtocolVersion,
    releaseManifest: compiled.bundle.releaseManifest,
    releaseManifestBytesBase64: base64(compiled.bundle.releaseManifestBytes),
    releaseRoot: compiled.releaseRoot,
    stagedArtifactHashes: compiled.stagedArtifacts.map(
      (artifact) => artifact.contentHash,
    ),
  };
}

export function parseSerializedRelease(
  value: SerializedRelease,
): CompiledCustomization {
  const artifacts: ContentAddressedArtifact[] = value.artifacts.map(
    (artifact) => ({
      artifactKind:
        artifact.artifactKind as ContentAddressedArtifact['artifactKind'],
      canonicalBytes: bytes(String(artifact.canonicalBytesBase64)),
      contentHash: String(artifact.contentHash),
      domainTag: String(artifact.domainTag),
      kind: 'contentAddressedArtifact',
      mediaType: 'application/vnd.northstar.canonical+json',
    }),
  );
  const byHash = new Map(
    artifacts.map((artifact) => [artifact.contentHash, artifact]),
  );
  const compiled = {
    attestation: value.attestation,
    bundle: {
      artifacts,
      kind: 'compiledReleaseBundle',
      nodeContracts: value.nodeContracts,
      outputProtocolVersion: value.outputProtocolVersion,
      releaseManifest: value.releaseManifest,
      releaseManifestBytes: bytes(value.releaseManifestBytesBase64),
    },
    diagnostics: [],
    releaseRoot: value.releaseRoot,
    stagedArtifacts: value.stagedArtifactHashes.map((hash) => {
      const artifact = byHash.get(hash);
      if (!artifact) throw new TypeError('serialized release is incomplete');
      return artifact;
    }),
    status: 'compiled',
  } as unknown as CompileSuccess;
  return {
    compiled,
    normalizedDefinitionBytes: bytes(value.normalizedDefinitionBytesBase64),
  };
}

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function bytes(value: string): Uint8Array {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new TypeError('serialized release bytes are not canonical base64');
  }
  return new Uint8Array(decoded);
}
