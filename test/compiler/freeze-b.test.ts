import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalize } from '../../packages/canonical-model/src/index.js';
import {
  PROJECTION_FAMILY_IDS,
  REQUIRED_BASE_PROJECTION_FAMILIES,
  compileApplication,
  diffCompiledReleases,
  expectedActiveReleaseFrom,
} from '../../packages/compiler/src/index.js';
import {
  artifactSummary,
  authoredFixture,
  compilerInput,
  fixtureBytes,
  mustCompile,
  normalizedBytes,
  projectionPayload,
} from './helpers.js';

test('bootstrap emits one complete hierarchical release with no tenant identity', () => {
  const compiled = mustCompile(compilerInput(fixtureBytes('bootstrap')));
  assert.match(compiled.releaseRoot, /^[0-9a-f]{64}$/);
  assert.equal(compiled.bundle.releaseManifest.completeSnapshot, true);
  assert.equal(
    compiled.bundle.releaseManifest.runtimeOverlayEvaluation,
    'forbidden',
  );
  assert.equal(
    compiled.bundle.releaseManifest.policyDecisionDependency,
    'liveCurrentDenyCapable',
  );
  assert.deepEqual(
    compiled.bundle.releaseManifest.projections.map((entry) => entry.familyId),
    [...REQUIRED_BASE_PROJECTION_FAMILIES].sort(),
  );
  assert.equal(compiled.bundle.artifacts.length, 17);
  assert.equal(compiled.bundle.nodeContracts.length, 8);
  assert.equal(compiled.diagnostics.length, 0);

  const text = canonicalize(compiled.bundle.releaseManifest);
  assert.doesNotMatch(
    text,
    /tenantId|coordinatorId|environmentId|principalId|approvalId/,
  );
  for (const projection of compiled.bundle.releaseManifest.projections) {
    assert.match(projection.artifactRoot, /^[0-9a-f]{64}$/);
    assert.match(projection.semanticDigest, /^[0-9a-f]{64}$/);
    assert.ok(projection.familyId.startsWith('northstar.compiler:'));
    assert.equal(projection.chunkingSchemeVersion.includes('single'), true);
  }
});

test('identical input is byte-identical across deterministic schedules', () => {
  const input = compilerInput(fixtureBytes('vertical-v1'));
  const canonical = compileApplication(input, {
    projectionSchedule: 'canonical',
  });
  const reverse = compileApplication(input, { projectionSchedule: 'reverse' });
  const interleaved = compileApplication(input, {
    projectionSchedule: 'interleaved',
  });
  assert.equal(canonical.status, 'compiled');
  assert.equal(reverse.status, 'compiled');
  assert.equal(interleaved.status, 'compiled');
  if (
    canonical.status !== 'compiled' ||
    reverse.status !== 'compiled' ||
    interleaved.status !== 'compiled'
  ) {
    return;
  }
  assert.equal(canonical.releaseRoot, reverse.releaseRoot);
  assert.equal(canonical.releaseRoot, interleaved.releaseRoot);
  assert.deepEqual(artifactSummary(canonical), artifactSummary(reverse));
  assert.deepEqual(artifactSummary(canonical), artifactSummary(interleaved));
  assert.deepEqual(
    canonical.bundle.nodeContracts,
    reverse.bundle.nodeContracts,
  );
  for (const node of canonical.bundle.nodeContracts) {
    assert.match(node.stableNodeId, /^northstar\.bootstrap:/);
    assert.match(node.normalizedInputDigest, /^[0-9a-f]{64}$/);
    assert.match(node.cacheInputIdentity, /^[0-9a-f]{64}$/);
    assert.match(node.semanticProfileIdentity, /^[0-9a-f]{64}$/);
    assert.match(node.outputFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(node.orderedDependencyDigests.length, 0);
  }
});

test('revision two adds one optional field to storage and the existing form', () => {
  const first = mustCompile(compilerInput(fixtureBytes('vertical-v1')));
  const second = mustCompile(
    compilerInput(
      fixtureBytes('vertical-v2'),
      expectedActiveReleaseFrom(first),
    ),
  );
  const transition = projectionPayload<{
    fromReleaseRoot: string;
    operations: Array<{ entityId: string; fieldId: string; kind: string }>;
    toStorageTargetArtifactRoot: string;
  }>(second, PROJECTION_FAMILY_IDS.storageTransition);
  assert.equal(transition.fromReleaseRoot, first.releaseRoot);
  assert.deepEqual(transition.operations, [
    {
      entityId: 'northstar.bootstrap:entity.item',
      fieldId: 'northstar.bootstrap:field.item_description',
      kind: 'addOptionalField',
    },
  ]);

  const surface = projectionPayload<{
    surfaces: Array<{ fieldIds: string[]; surfaceId: string }>;
  }>(second, PROJECTION_FAMILY_IDS.surfaceManifest);
  assert.deepEqual(surface.surfaces, [
    {
      archetype: 'record',
      dataSourceQueryId: 'northstar.bootstrap:query.item_get',
      fieldIds: [
        'northstar.bootstrap:field.item_name',
        'northstar.bootstrap:field.item_description',
      ],
      label: 'Item form',
      lifecycle: 'active',
      slots: [
        {
          contentReferenceId: 'northstar.bootstrap:capability.auto_form',
          orderKey: 10,
          slot: 'keyFacts',
          slotId: 'northstar.bootstrap:slot.item_key_facts',
        },
      ],
      statusRoles: [],
      surfaceId: 'northstar.bootstrap:surface.item_form',
    },
  ]);

  const diff = diffCompiledReleases(first, second);
  assert.ok(diff.impactCodes.includes('surface-only'));
  assert.ok(diff.impactCodes.includes('storage-transition-required'));
  assert.ok(diff.impactCodes.includes('authorization-surface-added'));
  assert.match(diff.transitionPlanDigest ?? '', /^[0-9a-f]{64}$/);
  assert.match(diff.canonicalDiffDigest, /^[0-9a-f]{64}$/);
  assert.ok(
    diff.changes.some(
      (change) =>
        change.subjectId === 'northstar.bootstrap:field.item_description' &&
        change.changeKind === 'added',
    ),
  );
});

test('transition bases are verified through the release and projection hierarchy', () => {
  const first = mustCompile(compilerInput(fixtureBytes('vertical-v1')));
  const expected = expectedActiveReleaseFrom(first);
  const tampered = structuredClone(expected);
  tampered.storageTargetCanonicalBytes[0] =
    (tampered.storageTargetCanonicalBytes[0] ?? 0) ^ 1;
  const result = compileApplication(
    compilerInput(fixtureBytes('vertical-v2'), tampered),
  );
  assert.equal(result.status, 'failed');
  assert.deepEqual(
    result.diagnostics.map(({ code, phase }) => ({ code, phase })),
    [{ code: 'COMPILER_TRANSITION_BASE_INVALID', phase: 'resolve' }],
  );
});

test('the provisional transition lowerer rejects changes to existing storage fields', () => {
  const first = mustCompile(compilerInput(fixtureBytes('vertical-v1')));
  const authored = authoredFixture('vertical-v2');
  const existing = authored.fields.find(
    (field) => field.fieldId === 'northstar.bootstrap:field.item_name',
  );
  assert.equal(existing?.fieldType.kind, 'textFieldType');
  if (existing?.fieldType.kind !== 'textFieldType') return;
  existing.fieldType.maximumLength = 120;
  const result = compileApplication(
    compilerInput(normalizedBytes(authored), expectedActiveReleaseFrom(first)),
  );
  assert.equal(result.status, 'failed');
  assert.deepEqual(
    result.diagnostics.map(({ code, subjectId }) => ({ code, subjectId })),
    [
      {
        code: 'COMPILER_STORAGE_TRANSITION_UNSUPPORTED',
        subjectId: 'northstar.bootstrap:field.item_name',
      },
    ],
  );
});

test('identical releases have identical roots and an empty factual diff', () => {
  const first = mustCompile(compilerInput(fixtureBytes('vertical-v1')));
  const second = mustCompile(compilerInput(fixtureBytes('vertical-v1')));
  assert.equal(first.releaseRoot, second.releaseRoot);
  const diff = diffCompiledReleases(first, second);
  assert.deepEqual(diff.changes, []);
  assert.deepEqual(diff.impactCodes, []);
  assert.equal(diff.transitionPlanDigest, null);
  assert.equal(diff.fromManifestRoot, diff.toManifestRoot);
});

test('partial lowering fails atomically after staging with no release root', () => {
  const result = compileApplication(
    compilerInput(fixtureBytes('partial-lowering')),
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.releaseRoot, null);
  assert.equal(result.bundle, null);
  assert.equal(result.attestation, null);
  assert.ok(result.stagedArtifacts.length > 0);
  assert.deepEqual(
    result.diagnostics.map(
      ({ code, occurrenceIndex, path, phase, subjectId }) => ({
        code,
        occurrenceIndex,
        path,
        phase,
        subjectId,
      }),
    ),
    [
      {
        code: 'COMPILER_PROJECTION_REQUIRED_MISSING',
        occurrenceIndex: 0,
        path: '$.capabilityRequirements.requiredProjections',
        phase: 'verifyCompleteness',
        subjectId: 'northstar.partial:capability.reporting',
      },
    ],
  );
});

test('the output limit covers the final release manifest as well as staged leaves', () => {
  const input = compilerInput(fixtureBytes('bootstrap'));
  const compiled = mustCompile(input);
  const stagedByteLength = compiled.bundle.artifacts
    .filter((artifact) => artifact.artifactKind !== 'releaseManifest')
    .reduce((sum, artifact) => sum + artifact.canonicalBytes.byteLength, 0);
  input.limits.maximumOutputBytes = stagedByteLength;
  const result = compileApplication(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.releaseRoot, null);
  assert.equal(result.bundle, null);
  assert.deepEqual(
    result.diagnostics.map(({ code, phase }) => ({ code, phase })),
    [{ code: 'COMPILER_OUTPUT_LIMIT_EXCEEDED', phase: 'emit' }],
  );
});
