import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canonicalize } from '../../packages/canonical-model/src/index.js';
import {
  PROJECTION_FAMILY_IDS,
  compileApplication,
  diffCompiledReleases,
  expectedActiveReleaseFrom,
  type ProjectionManifestEnvelope,
} from '../../packages/compiler/src/index.js';
import { compilerInput, fixtureBytes, mustCompile } from './helpers.js';

test('compiler leaf, projection, and release golden vectors are stable', () => {
  const bootstrap = mustCompile(compilerInput(fixtureBytes('bootstrap')));
  assert.equal(
    bootstrap.releaseRoot,
    golden('bootstrap.release-root.golden.sha256'),
  );
  const storageReference = bootstrap.bundle.releaseManifest.projections.find(
    (entry) => entry.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.ok(storageReference);
  const manifest = bootstrap.bundle.artifacts.find(
    (artifact) => artifact.contentHash === storageReference.artifactRoot,
  );
  assert.ok(manifest);
  assert.equal(
    Buffer.from(manifest.canonicalBytes).toString('hex'),
    golden('bootstrap.storage-target.manifest.golden.bytes'),
  );
  assert.equal(
    manifest.contentHash,
    golden('bootstrap.storage-target.manifest.golden.sha256'),
  );
  const manifestValue = JSON.parse(
    new TextDecoder().decode(manifest.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  const chunk = bootstrap.bundle.artifacts.find(
    (artifact) => artifact.contentHash === manifestValue.chunks[0]?.contentHash,
  );
  assert.ok(chunk);
  assert.equal(
    Buffer.from(chunk.canonicalBytes).toString('hex'),
    golden('bootstrap.storage-target.chunk.golden.bytes'),
  );
  assert.equal(
    chunk.contentHash,
    golden('bootstrap.storage-target.chunk.golden.sha256'),
  );
});

test('vertical roots and factual release diff have pinned hashes', () => {
  const first = mustCompile(compilerInput(fixtureBytes('vertical-v1')));
  const second = mustCompile(
    compilerInput(
      fixtureBytes('vertical-v2'),
      expectedActiveReleaseFrom(first),
    ),
  );
  assert.equal(
    first.releaseRoot,
    golden('vertical-v1.release-root.golden.sha256'),
  );
  assert.equal(
    second.releaseRoot,
    golden('vertical-v2.release-root.golden.sha256'),
  );
  assert.equal(
    diffCompiledReleases(first, second).canonicalDiffDigest,
    golden('vertical-v1-v2.diff.golden.sha256'),
  );
});

test('negative diagnostic golden contains structural fields and no prose', () => {
  const result = compileApplication(
    compilerInput(fixtureBytes('partial-lowering')),
  );
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  const structural = result.diagnostics.map(
    ({ code, occurrenceIndex, path, phase, subjectId }) => ({
      code,
      occurrenceIndex,
      path,
      phase,
      subjectId,
    }),
  );
  assert.equal(
    Buffer.from(canonicalize(structural)).toString('hex'),
    golden('partial-lowering.diagnostics.golden.bytes'),
  );
});

function golden(name: string): string {
  return readFileSync(`test/fixtures/g1/compiler/${name}`, 'utf8').trim();
}
