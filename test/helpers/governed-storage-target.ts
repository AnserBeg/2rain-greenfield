import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { StorageTargetPayloadV1 } from '../../packages/compiler/src/index.js';

interface ReleaseArtifacts {
  readonly releaseManifest: {
    readonly projections: { familyId: string; artifactRoot: string }[];
  };
  readonly artifacts: {
    artifactKind: string;
    contentHash: string;
    canonicalBytesBase64: string;
  }[];
}

/** Read the actual checked-in governed head; never compile an isolated fixture. */
export async function governedStorageTarget(): Promise<StorageTargetPayloadV1> {
  return (await governedStorageTargetArtifact()).payload;
}

/** Read the governed payload together with the persisted projection-chunk hash. */
export async function governedStorageTargetArtifact(): Promise<{
  readonly contentHash: string;
  readonly payload: StorageTargetPayloadV1;
}> {
  const release = JSON.parse(
    await readFile(
      resolve(__dirname, '../../apps/web/release/app.compiled.json'),
      'utf8',
    ),
  ) as { application?: ReleaseArtifacts; applications?: ReleaseArtifacts[] };
  const head = release.applications?.at(-1) ?? release.application;
  assert.ok(head);
  const reference = head.releaseManifest.projections.find(
    (projection) =>
      projection.familyId ===
      'northstar.compiler:projection-family.storage-target',
  );
  assert.ok(reference);
  const artifact = head.artifacts.find(
    (candidate) =>
      candidate.artifactKind === 'projectionManifest' &&
      candidate.contentHash === reference.artifactRoot,
  );
  assert.ok(artifact);
  const manifest = JSON.parse(
    Buffer.from(artifact.canonicalBytesBase64, 'base64').toString('utf8'),
  ) as { chunks: { contentHash: string }[] };
  assert.equal(manifest.chunks.length, 1);
  const chunk = head.artifacts.find(
    (candidate) =>
      candidate.artifactKind === 'projectionChunk' &&
      candidate.contentHash === manifest.chunks[0]!.contentHash,
  );
  assert.ok(chunk);
  const target = JSON.parse(
    Buffer.from(chunk.canonicalBytesBase64, 'base64').toString('utf8'),
  ) as StorageTargetPayloadV1;
  assert.equal(target.kind, 'storageTargetPayload');
  return { contentHash: chunk.contentHash, payload: target };
}
