import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalize } from '../../packages/canonical-model/src/index.js';
import { WORKFLOW_SURFACE_FLOOR } from '../../packages/canonical-model/src/workflows.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import { executeVerificationPlan } from '../../packages/compiler/src/verification.js';
import { releaseVerificationBinding } from '../../packages/postgres-provider/src/release-verification-service.js';
import {
  compilePartyFixture,
  partyDefinitionBytes,
} from '../fixtures/g2/party/compiler.js';

import {
  assertArchivedTenantEnvelope,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-customization-runtime.js';

test(
  'the tenant runner preserves the full v6 envelope when the workflow declaration is absent',
  {
    skip: !process.env.CI,
  },
  () =>
    withArchivedCustomizationRuntime(
      '840c1b48c9694e62fdb7e284fa5a8397a1360dfd',
      assertArchivedTenantEnvelope,
    ),
);

const hash = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

test('workflow-free canonical bytes, release closure and verification evidence match the pre-workflow fixture', async () => {
  const fixture = compilePartyFixture();
  const {
    artifactClosureDigest,
    plan,
    releaseRoot,
    verificationPlanArtifactRoot,
    verificationPlanSemanticDigest,
    workflows,
  } = releaseVerificationBinding(fixture.compiled);
  assert.equal(workflows, undefined);
  assert.ok(
    !fixture.compiled.bundle.releaseManifest.projections.some(
      ({ familyId }) => familyId === PROJECTION_FAMILY_IDS.workflow,
    ),
  );
  const evidence = await executeVerificationPlan(
    plan,
    {
      artifactClosureDigest,
      releaseRoot,
      verificationPlanArtifactRoot,
      verificationPlanSemanticDigest,
      providerRunId: 'workflow-absence-fixed-verification',
    },
    ({ scenarioId }) =>
      Promise.resolve({
        positiveProbe: { scenarioId, observed: true },
        negativeProbe: { scenarioId, observed: false },
      }),
  );
  // Captured on the pre-workflow trunk at 840c1b48 with these fixture identities.
  assert.deepEqual(
    {
      definition: hash(partyDefinitionBytes(fixture.definition)),
      releaseRoot,
      artifactClosureDigest,
      evidence: hash(canonicalize(evidence)),
    },
    {
      definition:
        '210383a2569e8e1b4493194f6cae60c12da52bc4da587871cb532289d721710b',
      releaseRoot:
        '83599963b0ae19973cb2124a48df2a96a65b30112aa55a70bf1ec9cfcb80c9df',
      artifactClosureDigest:
        '0c911a5c3fa5997712083d1bd81bb5773e33982892c57f62216b5fad497c48a6',
      evidence:
        'e91baf95197908f66351e8336a021f8da9082cc1565d9463cd9624823d3b0fda',
    },
  );
});

test('a workflow release pins the declarations, SDK catalog and required reader', () => {
  const { definition } = compilePartyFixture();
  const workflow = {
    workflowId: 'after-receiving',
    schemaVersion: 'v6',
    trigger: 'goodsReceiptPosted',
    bodyDigest: 'a'.repeat(64),
    grants: { queries: [], operations: [] },
  };
  const draft = compilePartyFixture({
    ...definition,
    workflows: [workflow],
  }).compiled;
  const changed = compilePartyFixture({
    ...definition,
    workflows: [{ ...workflow, bodyDigest: 'b'.repeat(64) }],
  }).compiled;
  const binding = releaseVerificationBinding(draft);
  assert.equal(binding.workflows?.[0]?.bodyDigest, workflow.bodyDigest);
  assert.notEqual(draft.releaseRoot, changed.releaseRoot);
  assert.match(binding.workflows?.[0]?.sdkDigest ?? '', /^[a-f0-9]{64}$/u);
  const surface = draft.bundle.releaseManifest.projections.find(
    ({ familyId }) => familyId === PROJECTION_FAMILY_IDS.surfaceManifest,
  );
  assert.equal(
    surface?.requiredRuntimeCapability.minimumVersion,
    WORKFLOW_SURFACE_FLOOR,
  );

  const reference = draft.bundle.releaseManifest.projections.find(
    ({ familyId }) => familyId === PROJECTION_FAMILY_IDS.workflow,
  );
  const manifest = draft.bundle.artifacts.find(
    ({ contentHash }) => contentHash === reference?.artifactRoot,
  );
  assert.ok(manifest);
  const { chunks } = JSON.parse(
    Buffer.from(manifest.canonicalBytes).toString(),
  ) as {
    chunks: { contentHash: string }[];
  };
  assert.ok(reference);
  const requiresV2 = {
    ...reference.requiredRuntimeCapability,
    minimumVersion: 2,
  };
  assert.throws(
    () =>
      releaseVerificationBinding({
        ...draft,
        bundle: {
          ...draft.bundle,
          releaseManifest: {
            ...draft.bundle.releaseManifest,
            projections: draft.bundle.releaseManifest.projections.map(
              (projection) =>
                projection === reference
                  ? { ...projection, requiredRuntimeCapability: requiresV2 }
                  : projection,
            ),
          },
          artifacts: draft.bundle.artifacts.map((artifact) =>
            artifact === manifest
              ? {
                  ...artifact,
                  canonicalBytes: Buffer.from(
                    canonicalize({
                      ...JSON.parse(
                        Buffer.from(manifest.canonicalBytes).toString(),
                      ),
                      requiredRuntimeCapability: requiresV2,
                    }),
                  ),
                }
              : artifact,
          ),
        },
      }),
    { code: 'UNSUPPORTED_RUNTIME_CAPABILITY' },
  );
  const changeProjection = (overrides: Record<string, unknown>) => ({
    ...draft,
    bundle: {
      ...draft.bundle,
      artifacts: draft.bundle.artifacts.map((artifact) =>
        artifact.contentHash === chunks[0]?.contentHash
          ? {
              ...artifact,
              canonicalBytes: Buffer.from(
                canonicalize({
                  ...JSON.parse(
                    Buffer.from(artifact.canonicalBytes).toString(),
                  ),
                  workflows: [{ ...binding.workflows?.[0], ...overrides }],
                }),
              ),
            }
          : artifact,
      ),
    },
  });
  assert.throws(
    () =>
      releaseVerificationBinding(
        changeProjection({ sdkDigest: 'b'.repeat(64) }),
      ),
    { code: 'WORKFLOW_PROJECTION_MISMATCH' },
  );
  assert.throws(
    () =>
      releaseVerificationBinding(
        changeProjection({ trigger: 'untrustedEvent' }),
      ),
    /goodsReceiptPosted/u,
  );
  assert.throws(
    () =>
      compilePartyFixture({
        ...definition,
        workflows: [
          {
            ...workflow,
            grants: {
              operations: ['northstar.app:operation.no_such_action'],
              queries: [],
            },
          },
        ],
      }),
    /Workflow grant does not resolve/,
  );
});
