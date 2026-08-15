import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanonicalIdSchema,
  LANGUAGE_VERSION,
  LANGUAGE_VERSIONS,
  NORMALIZATION_PROFILE_VERSIONS,
  LEGACY_LANGUAGE_VERSION,
  LEGACY_NORMALIZATION_PROFILE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  PREVIOUS_LANGUAGE_VERSION,
  PREVIOUS_NORMALIZATION_PROFILE_VERSION,
  canonicalize,
} from '../../packages/canonical-model/src/index.js';
import {
  PROJECTION_FAMILY_IDS,
  REQUIRED_MODULE_PROJECTION_FAMILIES,
  STORAGE_ELEMENT_CONTRACT_VERSION,
  STORAGE_TRANSITION_ENVELOPE_VERSION,
  compileApplication,
  diffCompiledReleases,
  expectedActiveReleaseFrom,
  physicalNameFor,
  type StorageTransitionEnvelope,
} from '../../packages/compiler/src/index.js';
import { hashBytes } from '../../packages/compiler/src/hash.js';
import { HASH_DOMAINS } from '../../packages/compiler/src/protocol.js';
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
    [...REQUIRED_MODULE_PROJECTION_FAMILIES].sort(),
  );
  assert.equal(compiled.bundle.artifacts.length, 19);
  assert.equal(compiled.bundle.nodeContracts.length, 9);
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
    assert.equal(projection.manifestVersion.includes('experimental'), true);
    assert.equal(
      projection.outputProtocolVersion.includes('experimental'),
      true,
    );
    assert.equal(projection.compatibility.unknownRequiredFamily, 'reject');
  }
});

// The version `bootstrap.authored.json` is actually authored at, pinned to a
// literal. Deriving it from a "current" constant makes the next version cut
// silently re-author every node this file builds.
const BOOTSTRAP_LANGUAGE_VERSION = LANGUAGE_VERSIONS.v3;
const BOOTSTRAP_NORMALIZATION_PROFILE_VERSION =
  NORMALIZATION_PROFILE_VERSIONS.v3;

test('release manifests derive v3 versions from the adopted canonical package', () => {
  const input = compilerInput(fixtureBytes('bootstrap'));
  assert.equal(input.profile.languageVersion, BOOTSTRAP_LANGUAGE_VERSION);
  assert.equal(
    input.profile.normalizationProfileVersion,
    BOOTSTRAP_NORMALIZATION_PROFILE_VERSION,
  );

  const compiled = mustCompile(input);
  assert.equal(
    compiled.bundle.releaseManifest.languageVersion,
    BOOTSTRAP_LANGUAGE_VERSION,
  );
  assert.equal(
    compiled.bundle.releaseManifest.normalizationProfileVersion,
    BOOTSTRAP_NORMALIZATION_PROFILE_VERSION,
  );
});

test('v0, v1, and v2 readers still normalize and compile after v3 adoption', () => {
  for (const [languageVersion, normalizationProfileVersion] of [
    [LEGACY_LANGUAGE_VERSION, LEGACY_NORMALIZATION_PROFILE_VERSION],
    [PREVIOUS_LANGUAGE_VERSION, PREVIOUS_NORMALIZATION_PROFILE_VERSION],
    [LANGUAGE_VERSION, NORMALIZATION_PROFILE_VERSION],
  ] as const) {
    const authored = authoredFixture('bootstrap') as unknown as Record<
      string,
      unknown
    >;
    delete authored.impactAnalyses;
    replaceSchemaVersion(authored, languageVersion);
    authored.languageVersion = languageVersion;
    authored.normalizationProfileVersion = normalizationProfileVersion;
    const compiled = mustCompile(compilerInput(normalizedBytes(authored)));
    assert.equal(
      compiled.bundle.releaseManifest.languageVersion,
      LANGUAGE_VERSION,
    );
    assert.equal(
      compiled.bundle.releaseManifest.normalizationProfileVersion,
      NORMALIZATION_PROFILE_VERSION,
    );
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
  const transition = projectionPayload<StorageTransitionEnvelope>(
    second,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  assert.equal(transition.fromReleaseRoot, first.releaseRoot);
  assert.equal(transition.kind, 'storageTransitionEnvelope');
  assert.equal(transition.schemaVersion, STORAGE_TRANSITION_ENVELOPE_VERSION);
  assert.equal(transition.elements.length, 1);
  assert.match(transition.elements[0]?.elementId ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(
    transition.elements.map(({ elementId, ...element }) => {
      void elementId;
      return element;
    }),
    [
      {
        classification: {
          dataEffect: 'catalogOnly',
          operationalRisk: 'boundedCatalogLock',
          preparationValidity: 'preApprovalInert',
          semanticEffect: 'additive',
        },
        coexistence: {
          admission: 'additive',
          newRead: 'requiresReadFallback',
          newWrite: 'compatible',
          oldRead: 'compatible',
          oldWrite: 'compatible',
        },
        coexistenceImpact: 'requiresReadFallback',
        declaredDependencyIds: [],
        fieldId: 'northstar.bootstrap:field.item_description',
        kind: 'addColumn',
        physicalObjectName: physicalNameFor(
          'column',
          'northstar.bootstrap:field.item_description',
        ),
        schemaVersion: STORAGE_ELEMENT_CONTRACT_VERSION,
        scope: {
          keyColumns: ['tenant_id', 'environment_id'],
          kind: 'tenantEnvironment',
        },
        storageDomain: 'managedModule',
        storageGeneration: 'dedicatedTyped/v1',
        subjectId: 'northstar.bootstrap:entity.item',
      },
    ],
  );

  const surface = projectionPayload<{
    surfaces: Array<{ fieldIds: string[]; surfaceId: string }>;
  }>(second, PROJECTION_FAMILY_IDS.surfaceManifest);
  assert.deepEqual(
    surface.surfaces.find(
      (entry) => entry.surfaceId === 'northstar.bootstrap:surface.item_form',
    ),
    // GREW BY `profile-v2-adoption`. This whole-object `deepEqual` is the
    // clearest statement in the suite of what adoption did to a compiled
    // surface: exactly two keys appear, and both are accumulated v2 emissions.
    //
    //   `fields`                  one entry per selected field, in fieldIds order
    //   `slots[].disclosureTier`  resolved at projection time
    //
    // `disclosureTier: 'always'` here is the DEFAULT resolving, not an authored
    // declaration -- this bootstrap fixture declares no tier anywhere. That is
    // the documented behaviour of `?? DEFAULT_DISCLOSURE_TIER`, and it is also
    // why an authored `always` is indistinguishable from an absent one in any
    // compiled artifact. The authored declaration this packet lands on
    // `party_detail`'s keyFacts slot is observable in the NORMALIZED definition
    // and in the language conformance ledger, never here.
    {
      archetype: 'record',
      dataSourceQueryId: 'northstar.bootstrap:query.item_get',
      fieldIds: [
        'northstar.bootstrap:field.item_name',
        'northstar.bootstrap:field.item_description',
      ],
      fields: [
        {
          fieldId: 'northstar.bootstrap:field.item_name',
          kind: 'textFieldType',
          required: false,
        },
        {
          fieldId: 'northstar.bootstrap:field.item_description',
          kind: 'textFieldType',
          required: false,
        },
      ],
      label: 'Item form',
      lifecycle: 'active',
      slots: [
        {
          contentReferenceId: 'northstar.bootstrap:capability.auto_form',
          disclosureTier: 'always',
          orderKey: 10,
          slot: 'keyFacts',
          slotId: 'northstar.bootstrap:slot.item_key_facts',
        },
      ],
      statusRoles: [],
      surfaceId: 'northstar.bootstrap:surface.item_form',
      surfaceRole: 'form',
    },
  );

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

test('transition bases reject contradictory release and projection descriptors', () => {
  const first = mustCompile(compilerInput(fixtureBytes('vertical-v1')));
  const expected = expectedActiveReleaseFrom(first);
  const releaseManifest = JSON.parse(
    new TextDecoder().decode(expected.releaseManifestBytes),
  ) as typeof first.bundle.releaseManifest;
  const storage = releaseManifest.projections.find(
    (entry) => entry.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.ok(storage);
  storage.payloadSchemaVersion = 'northstar.mismatched-payload/v999';
  expected.releaseManifestBytes = new TextEncoder().encode(
    canonicalize(releaseManifest),
  );
  expected.releaseRoot = hashBytes(
    HASH_DOMAINS.releaseManifest,
    expected.releaseManifestBytes,
  );
  const result = compileApplication(
    compilerInput(fixtureBytes('vertical-v2'), expected),
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.diagnostics[0]?.code, 'COMPILER_TRANSITION_BASE_INVALID');
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
        code: 'COMPILER_STORAGE_RETYPE_UNSUPPORTED',
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

test('release diff fails closed on a missing or mismatched transition pair', () => {
  const bootstrap = mustCompile(compilerInput(fixtureBytes('bootstrap')));
  const first = mustCompile(compilerInput(fixtureBytes('vertical-v1')));
  const preparedSecond = mustCompile(
    compilerInput(
      fixtureBytes('vertical-v2'),
      expectedActiveReleaseFrom(first),
    ),
  );
  const unpreparedSecond = mustCompile(
    compilerInput(fixtureBytes('vertical-v2')),
  );
  assert.throws(
    () => diffCompiledReleases(bootstrap, preparedSecond),
    /transition does not bind supplied pair/,
  );
  assert.throws(
    () => diffCompiledReleases(first, unpreparedSecond),
    /storage change has no transition plan/,
  );
});

test('retired unsupported capabilities are never advertised as supported facts', () => {
  const authored = authoredFixture('vertical-v1');
  const capability = authored.capabilityRequirements[0]!;
  capability.lifecycle = 'retired';
  capability.supportStatus = 'unsupported';
  capability.requiredProjections = ['reporting'];
  const result = mustCompile(compilerInput(normalizedBytes(authored)));
  assert.deepEqual(result.bundle.releaseManifest.capabilityFacts, []);
});

test('derived state fields are present in the complete storage target', () => {
  const authored = authoredFixture('vertical-v1');
  authored.stateMachines.push({
    entity: {
      kind: 'entityReference',
      schemaVersion: BOOTSTRAP_LANGUAGE_VERSION,
      targetId: CanonicalIdSchema.parse('northstar.bootstrap:entity.item'),
    },
    initialState: {
      kind: 'stateReference',
      schemaVersion: BOOTSTRAP_LANGUAGE_VERSION,
      targetId: CanonicalIdSchema.parse(
        'northstar.bootstrap:state.item_active',
      ),
    },
    kind: 'stateMachineDefinition',
    machineId: CanonicalIdSchema.parse(
      'northstar.bootstrap:machine.item_lifecycle',
    ),
    schemaVersion: BOOTSTRAP_LANGUAGE_VERSION,
    states: [
      {
        kind: 'stateDefinition',
        label: 'Active',
        orderKey: 10,
        schemaVersion: BOOTSTRAP_LANGUAGE_VERSION,
        stateId: CanonicalIdSchema.parse(
          'northstar.bootstrap:state.item_active',
        ),
      },
    ],
    transitions: [],
  });
  const result = mustCompile(compilerInput(normalizedBytes(authored)));
  const storage = projectionPayload<{
    entities: Array<{
      derivedStateFields: Array<{
        fieldId: string;
        lifecycle: string;
        stateMachineId: string;
        valueKind: string;
      }>;
      entityId: string;
    }>;
  }>(result, PROJECTION_FAMILY_IDS.storageTarget);
  assert.deepEqual(
    storage.entities[0]?.derivedStateFields.map(
      ({ fieldId, stateMachineId }) => ({ fieldId, stateMachineId }),
    ),
    [
      {
        fieldId:
          'northstar.bootstrap:derived_state_field.machine.item_lifecycle',
        stateMachineId: 'northstar.bootstrap:machine.item_lifecycle',
      },
    ],
  );
});

test('storage targets use the mapping selected by canonical entity identity', () => {
  const authored = authoredFixture('vertical-v1');
  authored.storageMappings.push({
    entity: {
      kind: 'entityReference',
      schemaVersion: BOOTSTRAP_LANGUAGE_VERSION,
      targetId: CanonicalIdSchema.parse('northstar.bootstrap:entity.item'),
    },
    kind: 'storageMappingDefinition',
    schemaVersion: BOOTSTRAP_LANGUAGE_VERSION,
    storageClass: 'dedicatedTable',
    storageMappingId: CanonicalIdSchema.parse(
      'northstar.bootstrap:storage.item_alternative',
    ),
  });
  const result = mustCompile(compilerInput(normalizedBytes(authored)));
  const storage = projectionPayload<{
    entities: Array<{
      entityId: string;
      storageClass: string;
      storageMappingId: string;
    }>;
  }>(result, PROJECTION_FAMILY_IDS.storageTarget);
  assert.equal(
    storage.entities[0]?.entityId,
    'northstar.bootstrap:entity.item',
  );
  assert.equal(storage.entities[0]?.storageClass, 'dedicatedTable');
  assert.equal(
    storage.entities[0]?.storageMappingId,
    'northstar.bootstrap:storage.item',
  );
});

test('diagnostic truncation preserves the frozen structural order', () => {
  const authored = authoredFixture('vertical-v1');
  const capability = authored.capabilityRequirements[0]!;
  capability.supportStatus = 'unsupported';
  authored.capabilityRequirements.push(
    {
      ...structuredClone(capability),
      capabilityId: CanonicalIdSchema.parse(
        'northstar.bootstrap:capability.unsupported_b',
      ),
    },
    {
      ...structuredClone(capability),
      capabilityId: CanonicalIdSchema.parse(
        'northstar.bootstrap:capability.unsupported_c',
      ),
    },
  );
  const input = compilerInput(normalizedBytes(authored));
  input.limits.maximumDiagnostics = 2;
  const result = compileApplication(input);
  assert.equal(result.status, 'failed');
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
        code: 'COMPILER_DIAGNOSTIC_LIMIT_REACHED',
        occurrenceIndex: 1,
        path: '$',
        phase: 'wholeModelValidation',
        subjectId: null,
      },
      {
        code: 'COMPILER_CAPABILITY_NOT_SUPPORTED',
        occurrenceIndex: 0,
        path: '$.capabilityRequirements.supportStatus',
        phase: 'wholeModelValidation',
        subjectId: 'northstar.bootstrap:capability.auto_form',
      },
    ],
  );
});

test('unsupported capability requirements fail before lowering', () => {
  const result = compileApplication(
    compilerInput(fixtureBytes('partial-lowering')),
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.releaseRoot, null);
  assert.equal(result.bundle, null);
  assert.equal(
    result.stagedArtifacts.some(
      (artifact) => artifact.artifactKind === 'releaseManifest',
    ),
    false,
  );
  assert.equal(result.attestation, null);
  assert.equal(result.stagedArtifacts.length, 0);
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
        code: 'COMPILER_CAPABILITY_NOT_SUPPORTED',
        occurrenceIndex: 0,
        path: '$.capabilityRequirements.supportStatus',
        phase: 'wholeModelValidation',
        subjectId: 'northstar.partial:capability.reporting',
      },
    ],
  );
});

function replaceSchemaVersion(value: unknown, version: string): void {
  if (Array.isArray(value)) {
    for (const entry of value) replaceSchemaVersion(entry, version);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if ('schemaVersion' in record) record.schemaVersion = version;
  for (const entry of Object.values(record))
    replaceSchemaVersion(entry, version);
}

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
  assert.equal(
    result.stagedArtifacts.some(
      (artifact) => artifact.artifactKind === 'releaseManifest',
    ),
    false,
  );
  assert.deepEqual(
    result.diagnostics.map(({ code, phase }) => ({ code, phase })),
    [{ code: 'COMPILER_OUTPUT_LIMIT_EXCEEDED', phase: 'emit' }],
  );
});
