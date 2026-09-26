import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import pg from 'pg';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  canonicalize,
  canonicalizeAndHash,
  normalizeApplicationPackage,
  parseNormalizedApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import {
  COMPOSED_SURFACE_MANIFEST_PAYLOAD_VERSION,
  FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION,
  GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION,
  HASH_ALGORITHM,
  HASH_DOMAINS,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  type CompileSuccess,
  type ContentAddressedArtifact,
  type ProjectionManifestEnvelope,
} from '../../packages/compiler/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/index.js';
import { inventoryModuleDefinition } from '../../packages/domain/src/inventory/index.js';
import {
  COMPILER_TRANSITION_FACTS_VERSION,
  EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
  INITIAL_ACTIVATION_BINDING_VERSION,
  RELEASE_DIFF_BINDING_VERSION,
  SYSTEM_EXECUTION_PRINCIPAL,
  TRANSITION_COMPATIBILITY_POLICY_VERSION,
  TRANSITION_PREPARATION_RECEIPT_VERSION,
  type CreateReleaseApprovalCommand,
  type MintedUuid,
  type RegisterTenantReleaseCommand,
  type ReleaseActivationInvalidationEvent,
  type StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import { PostgresReleaseActivationService } from '../../packages/postgres-provider/src/release-activation-service.js';
import { PostgresReleaseApprovalService } from '../../packages/postgres-provider/src/release-approval-service.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { verificationEvidenceIdForCandidate } from '../../packages/postgres-provider/src/release-verification-service.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import {
  PostgresRequestRuntimeViewService,
  RequestRuntimeViewLoadError,
} from '../../packages/postgres-provider/src/request-runtime-view-service.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  authorizeCurrentPolicy,
  createPinnedRuntimeContextEnvelope,
  parsePinnedRuntimeContextEnvelope,
  type CurrentPolicyDecision,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type CurrentPolicyVersionEvidence,
  RequestRuntimeViewRefusalError,
  SUPPORTED_RUNTIME_CAPABILITIES,
  unsupportedRuntimeCapability,
  type PinnedRuntimeContextEnvelope,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import { compilerInput, fixtureBytes } from '../compiler/helpers.js';
import { assertComposedInventoryCollection } from '../helpers/assert-composed-inventory.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';
import {
  admitEmptyPlanRelease,
  definitionWithoutAssertions,
} from './release-verification-fixture.js';

const execFileAsync = promisify(execFile);
const checkedInMigrations = resolve('db/migrations');

const tenantA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const environmentA = 'a1000000-0000-4000-8000-000000000001';
const environmentB = 'b1000000-0000-4000-8000-000000000001';
const versionEnvironment = 'a1000000-0000-4000-8000-000000000003';
const brokenEnvironment = 'a1000000-0000-4000-8000-000000000002';
const missingEnvironment = 'a1000000-0000-4000-8000-000000000099';
const principalA = 'aa000000-0000-4000-8000-000000000001';
const principalB = 'bb000000-0000-4000-8000-000000000001';
const approverA = 'ac000000-0000-4000-8000-000000000002';
const approverB = 'bc000000-0000-4000-8000-000000000002';
const authorityOperator = 'a9000000-0000-4000-8000-000000000009';
const unknownSurfacePayloadVersion =
  'northstar.surface-manifest-payload/unknown';

interface ReleaseFixture {
  compiled: CompileSuccess;
  evidenceId: MintedUuid;
  releaseId: MintedUuid;
  revisionId: MintedUuid;
}

interface AttemptFixture {
  activationAttemptId: MintedUuid;
  targetReleaseId: MintedUuid;
}

interface PointerFixture {
  fence: number;
  pointerId: MintedUuid;
  releaseId: MintedUuid | null;
}

/**
 * THE CONTROL THAT OBSERVES THE COMPARISON ITSELF, required by the orchestrator
 * when the bridge was granted: *"floor 3 must refuse against a registry
 * declaring only 2, or the control never observes the comparison it exists to
 * prove."*
 *
 * The end-to-end pair below cannot do this. The live registry declares 3 and
 * ships 3, so no real release can produce a supported-BELOW-demanded case
 * against it -- the only reachable refusal is an absurd floor like 999, and a
 * comparison implemented as `minimumVersion > 100` would satisfy that while
 * passing everything real. The registry is therefore taken as a PARAMETER, and
 * this exercises the boundary at 2/3/4 where the two rules actually differ.
 *
 * `adoption-selector-seam` is the repository's own five-round proof that only a
 * seam taking the choice as a parameter can observe the choice. Same shape, one
 * subsystem over.
 */
test('the capability comparison binds the family to its capability, then compares versions', () => {
  const surface = PROJECTION_FAMILY_IDS.surfaceManifest;
  const requirement = {
    capabilityId: 'northstar.runtime:capability.surface-manifest',
    minimumVersion: 5,
  };
  const registryAt = (maximumSupportedVersion: number) => ({
    [surface]: {
      capabilityId: 'northstar.runtime:capability.surface-manifest',
      maximumSupportedVersion,
    },
  });

  // The one the orchestrator named: the SAME floor that serves in production
  // must refuse against a runtime declaring less.
  assert.match(
    unsupportedRuntimeCapability(surface, requirement, registryAt(4)) ?? '',
    /requires version 5 and this runtime supports 4/,
  );

  // Admission twins at the boundary, so the refusal is discriminating rather
  // than a wall: equal serves, and greater serves, because a floor is a MINIMUM
  // and support is cumulative.
  assert.equal(
    unsupportedRuntimeCapability(surface, requirement, registryAt(5)),
    null,
  );
  assert.equal(
    unsupportedRuntimeCapability(surface, requirement, registryAt(6)),
    null,
  );

  // THE BORROWED-CAPABILITY BYPASS, added on round-2 review. A surface manifest
  // declaring ANOTHER family's known capability at a floor this runtime does
  // support was previously served: the comparison saw a known id and a
  // satisfiable version and never asked whether the family was entitled to that
  // id. The floor the surface actually owed was never compared at all.
  //
  // Note the specimen is otherwise entirely valid -- known capability, floor 1,
  // registry that supports it -- so the ONLY thing wrong is the pairing.
  assert.match(
    unsupportedRuntimeCapability(
      surface,
      {
        capabilityId: 'northstar.runtime:capability.semantic-model',
        minimumVersion: 1,
      },
      {
        ...registryAt(4),
        [PROJECTION_FAMILY_IDS.semanticModel]: {
          capabilityId: 'northstar.runtime:capability.semantic-model',
          maximumSupportedVersion: 1,
        },
      },
    ) ?? '',
    /must declare northstar\.runtime:capability\.surface-manifest and declares northstar\.runtime:capability\.semantic-model/,
  );

  // Fails closed on a family nobody declared. Treating unknown as permitted is
  // how a new projection family would serve itself into an unaware reader.
  assert.match(
    unsupportedRuntimeCapability(surface, requirement, {}) ?? '',
    /projection family is unknown to this runtime/,
  );

  // The live table binds the pair the compiler emits. Pinned so that renaming a
  // capability on one side alone reds here rather than in production.
  assert.deepEqual(SUPPORTED_RUNTIME_CAPABILITIES[surface], {
    capabilityId: 'northstar.runtime:capability.surface-manifest',
    maximumSupportedVersion: 9,
  });
});

test('G1-P5 pins one immutable release while policy and pointer authority remain current', async (t) => {
  const bootstrapBytes = fixtureBytes('bootstrap');
  const verticalBytes = definitionWithoutAssertions(bootstrapBytes, '1.0.1');
  const groupedBytes = groupedNavigationDefinitionBytes();
  const bootstrap = mustCompile(bootstrapBytes);
  const vertical = mustCompile(verticalBytes);
  const grouped = withoutVerificationScenarios(mustCompile(groupedBytes));
  const unknownSurfaceVersion = rewriteSurfacePayloadVersions(grouped, {
    envelopeVersion: unknownSurfacePayloadVersion,
    payloadVersion: unknownSurfacePayloadVersion,
  });
  const mismatchedSurfaceVersion = rewriteSurfacePayloadVersions(grouped, {
    envelopeVersion: GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION,
    payloadVersion: FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION,
  });
  // A floor beyond anything this runtime declares, with a completely valid
  // payload. The ONLY thing wrong with this release is the demand.
  const unsupportedCapabilityFloor = withSurfaceCapabilityFloor(grouped, 999);
  // The same unsupported floor, PLUS a payload this runtime would also refuse.
  // It exists to observe ORDER: if the capability gate runs where it claims to,
  // this reports the capability code; if it ran after the payload were decoded,
  // it would report `projection payload version or kind is unsupported`
  // instead. Two reasons to fail, deliberately, because the fact under test is
  // WHICH ONE FIRES FIRST rather than whether it fails.
  const unsupportedCapabilityAndBadPayload = withSurfaceCapabilityFloor(
    grouped,
    999,
    (payload) => {
      payload.kind = 'notASurfaceManifestPayload';
    },
  );
  // A THIRD unsupported specimen, at 998 rather than 999 purely so it is a
  // distinct release. Each of these controls activates its own release, and the
  // pointer refuses re-activating the one already serving, so reusing 999 here
  // fails on the swap constraint rather than on anything under test.
  //
  // **It isolates ACTIVATION IDENTITY, not STORAGE — recorded on the confirm
  // arm, which found this and it is worth knowing.** The floor lives in the
  // projection MANIFEST, and `withSurfaceCapabilityFloor`'s payload mutation
  // here is a no-op, so 998, 999 and the ordinary grouped release all produce a
  // byte-identical surface CHUNK. `release_artifact_blobs` is keyed globally by
  // content hash, so `corruptSurfaceChunkBytes` corrupts the blob those three
  // releases SHARE.
  //
  // The current results are unaffected — both refusal controls run before the
  // corruption, and the deleted-link twin fails at its link before ever reading
  // the blob — but that makes the nested test ORDER load-bearing rather than
  // incidental. Reordering these subtests can break them without any production
  // change.
  const unsupportedCapabilityForCorruption = withSurfaceCapabilityFloor(
    grouped,
    998,
  );

  await withEphemeralPostgres(
    'request-runtime-view',
    async ({ connection, pool }) => {
      const admin = await pool.connect();
      try {
        await runMigrations(admin, await loadMigrations(checkedInMigrations));
        await seedScopes(admin);
        await makeInvisibleReleaseFixture(admin);
      } finally {
        admin.release();
      }

      const runtimePool = new pg.Pool({
        ...connection,
        max: 7,
        user: 'north_star_runtime',
      });
      const identities = new Map<string, AuthenticatedIdentity>([
        [
          'Bearer tenant-a',
          {
            environmentId: environmentA,
            principalId: principalA,
            tenantId: tenantA,
          },
        ],
        [
          'Bearer tenant-b',
          {
            environmentId: environmentB,
            principalId: principalB,
            tenantId: tenantB,
          },
        ],
        [
          'Bearer broken',
          {
            environmentId: brokenEnvironment,
            principalId: principalA,
            tenantId: tenantA,
          },
        ],
        [
          'Bearer missing',
          {
            environmentId: missingEnvironment,
            principalId: principalA,
            tenantId: tenantA,
          },
        ],
      ]);
      const authenticatedEntry = new AuthenticatedRequestEntryAdapter(
        async (request) => {
          const authorization = request.headers?.authorization;
          return typeof authorization === 'string'
            ? (identities.get(authorization) ?? null)
            : null;
        },
      );
      const contextA = await issuedContext(tenantA, environmentA, principalA);
      const contextB = await issuedContext(tenantB, environmentB, principalB);
      const approverContextA = await issuedContext(
        tenantA,
        environmentA,
        approverA,
      );
      const approverContextB = await issuedContext(
        tenantB,
        environmentB,
        approverB,
      );
      const versionContext = await issuedContext(
        tenantA,
        versionEnvironment,
        principalA,
      );
      const versionApproverContext = await issuedContext(
        tenantA,
        versionEnvironment,
        approverA,
      );
      const systemContextA = await issuedContext(
        tenantA,
        environmentA,
        SYSTEM_EXECUTION_PRINCIPAL.principalId,
      );
      const systemContextB = await issuedContext(
        tenantB,
        environmentB,
        SYSTEM_EXECUTION_PRINCIPAL.principalId,
      );
      const versionSystemContext = await issuedContext(
        tenantA,
        versionEnvironment,
        SYSTEM_EXECUTION_PRINCIPAL.principalId,
      );

      try {
        const releasesA = await seedReleases(runtimePool, contextA, [
          [bootstrapBytes, bootstrap],
          [verticalBytes, vertical],
        ]);
        const releasesB = await seedReleases(runtimePool, contextB, [
          [bootstrapBytes, bootstrap],
        ]);
        const versionReleases = await seedReleases(
          runtimePool,
          versionContext,
          [
            [groupedBytes, grouped],
            [groupedBytes, unknownSurfaceVersion],
            [groupedBytes, mismatchedSurfaceVersion],
            [groupedBytes, unsupportedCapabilityFloor],
            [groupedBytes, unsupportedCapabilityAndBadPayload],
            [groupedBytes, unsupportedCapabilityForCorruption],
          ],
        );
        const policy = new VersionedPolicyAdapter();
        policy.set(contextA, true);
        policy.set(contextB, true);
        policy.set(
          {
            environmentId: brokenEnvironment,
            principalId: principalA,
            tenantId: tenantA,
          },
          true,
        );
        policy.set(
          {
            environmentId: missingEnvironment,
            principalId: principalA,
            tenantId: tenantA,
          },
          true,
        );
        const viewService = new PostgresRequestRuntimeViewService(runtimePool);
        const requestEntry = new AuthenticatedRequestRuntimeEntryAdapter(
          authenticatedEntry,
          viewService,
          policy,
        );
        const activationService = new PostgresReleaseActivationService(
          runtimePool,
        );

        await t.test(
          'missing, null, and invisible release authority fail closed',
          async () => {
            await assertRuntimeViewRefusalError(
              () =>
                requestEntry.run(
                  { headers: { authorization: 'Bearer tenant-a' } },
                  (view) => view,
                ),
              'NULL_ACTIVE_RELEASE',
            );
            await assertRuntimeViewRefusalError(
              () =>
                requestEntry.run(
                  { headers: { authorization: 'Bearer missing' } },
                  (view) => view,
                ),
              'ACTIVE_POINTER_MISSING',
            );
            await assertRuntimeViewRefusalError(
              () =>
                requestEntry.run(
                  { headers: { authorization: 'Bearer broken' } },
                  (view) => view,
                ),
              'ACTIVE_RELEASE_NOT_VISIBLE',
            );
          },
        );

        await changeApproverEligibility(pool, tenantA, approverA, true);
        await changeApproverEligibility(pool, tenantB, approverB, true);
        await changeExecutorAuthority(pool, tenantA, true);
        await changeExecutorAuthority(pool, tenantB, true);
        const [initialA, initialB] = await Promise.all([
          activateRelease(
            runtimePool,
            pool,
            activationService,
            approverContextA,
            contextA,
            systemContextA,
            releasesA[0]!,
          ),
          activateRelease(
            runtimePool,
            pool,
            activationService,
            approverContextB,
            contextB,
            systemContextB,
            releasesB[0]!,
          ),
        ]);

        let oldView: RequestRuntimeView | undefined;
        let oldPin: PinnedRuntimeContextEnvelope | undefined;
        let secondEvent: ReleaseActivationInvalidationEvent | undefined;

        await t.test(
          'two tenants get different deeply immutable views and policy can revoke within one view',
          async () => {
            const [viewA, viewB] = await Promise.all([
              requestEntry.run(
                { headers: { authorization: 'Bearer tenant-a' } },
                (view) => view,
              ),
              requestEntry.run(
                { headers: { authorization: 'Bearer tenant-b' } },
                (view) => view,
              ),
            ]);
            assert.equal(viewA.release.releaseId, releasesA[0]!.releaseId);
            assert.equal(viewB.release.releaseId, releasesB[0]!.releaseId);
            assert.notEqual(viewA.release.releaseId, viewB.release.releaseId);
            assert.equal(viewA.pointer.fence, 1);
            assert.equal(viewB.pointer.fence, 1);
            assert.equal(
              viewA.projections.surface.payloadSchemaVersion,
              FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION,
            );
            assert.equal(Object.isFrozen(viewA), true);
            assert.equal(Object.isFrozen(viewA.projections), true);
            assert.equal(
              Object.isFrozen(viewA.projections.catalog.payload),
              true,
            );
            assert.equal(containsArrayBufferView(viewA), false);
            assert.throws(() => {
              (viewA.projections.catalog.payload as Record<string, unknown>)[
                'kind'
              ] = 'mutated';
            }, TypeError);

            const beforeRevocation = JSON.stringify(viewA);
            const allowed = await authorizeCurrentPolicy(
              policy,
              viewA,
              'bootstrap.read',
              { recordId: 'record-a' },
            );
            assert.equal(allowed.decision, 'ALLOW');
            policy.set(contextA, false);
            const denied = await authorizeCurrentPolicy(
              policy,
              viewA,
              'bootstrap.read',
              { recordId: 'record-a' },
            );
            assert.equal(denied.decision, 'DENY');
            assert.notEqual(denied.policyVersion, viewA.entryPolicyVersion);
            assert.equal(JSON.stringify(viewA), beforeRevocation);
            assert.equal(policy.authorizationCalls, 2);
            oldView = viewA;
            oldPin = createPinnedRuntimeContextEnvelope(viewA);
          },
        );

        await t.test(
          'actual P4b activation leaves the in-flight view old and gives a fresh entry the new release',
          async () => {
            assert.ok(oldView);
            assert.ok(oldPin);
            const oldSnapshot = JSON.stringify(oldView);
            const activated = await activateRelease(
              runtimePool,
              pool,
              activationService,
              approverContextA,
              contextA,
              systemContextA,
              releasesA[1]!,
            );
            secondEvent = activated.event;
            assert.equal(JSON.stringify(oldView), oldSnapshot);
            assert.equal(oldView.release.releaseId, releasesA[0]!.releaseId);

            const fresh = await requestEntry.run(
              { headers: { authorization: 'Bearer tenant-a' } },
              (view) => view,
            );
            assert.equal(fresh.release.releaseId, releasesA[1]!.releaseId);
            assert.equal(fresh.pointer.fence, 2);
            assert.deepEqual(await viewService.validatePin(contextA, oldPin), {
              reason: 'POINTER_GENERATION_CHANGED',
              resultVersion: 'northstar.pin-validation-result/v1',
              status: 'STALE_RELEASE_REPLAN',
            });
          },
        );

        await t.test(
          'fence-N slow fill cannot publish after N+1 invalidation and P4b ordering semantics are retained',
          async () => {
            assert.ok(secondEvent);
            let releaseFirstFill: (() => void) | undefined;
            const firstFillReleased = new Promise<void>((resolveRelease) => {
              releaseFirstFill = resolveRelease;
            });
            let announceFirstSnapshot: (() => void) | undefined;
            const firstSnapshotRead = new Promise<void>((resolveRead) => {
              announceFirstSnapshot = resolveRead;
            });
            let publicationCalls = 0;
            const slowService = new PostgresRequestRuntimeViewService(
              runtimePool,
              {
                beforeCachePublication: async () => {
                  publicationCalls += 1;
                  if (publicationCalls !== 1) return;
                  announceFirstSnapshot?.();
                  await firstFillReleased;
                },
              },
            );
            const returnAttempt = await prepareApproval(
              runtimePool,
              approverContextA,
              contextA,
              releasesA[0]!,
            );
            const slowLoad = slowService.load(contextA);
            await firstSnapshotRead;
            const returnResult = await activationService.activate(
              systemContextA,
              returnAttempt,
            );
            assert.equal(returnResult.status, 'SWAPPED_VERIFIED');
            const thirdEvent = await invalidationForAttempt(
              pool,
              activationService,
              systemContextA,
              returnAttempt.activationAttemptId,
            );
            const gap = await slowService.consumeInvalidation(
              systemContextA,
              thirdEvent,
            );
            assert.deepEqual(gap, {
              authoritativePointerReread: true,
              consumer: {
                decision: 'ACCEPTED_GAP_REREAD_REQUIRED',
                highestFence: 3,
                requestPointerReread: true,
              },
            });
            releaseFirstFill?.();
            const loaded = await slowLoad;
            assert.equal(loaded.pointer.fence, 3);
            assert.equal(loaded.release.releaseId, releasesA[0]!.releaseId);
            const cached = await slowService.load(contextA);
            assert.equal(cached, loaded);

            assert.deepEqual(
              await slowService.consumeInvalidation(systemContextA, thirdEvent),
              {
                authoritativePointerReread: false,
                consumer: {
                  decision: 'REJECTED_STALE_OR_DUPLICATE',
                  highestFence: 3,
                  requestPointerReread: false,
                },
              },
            );
            assert.equal(
              (
                await slowService.consumeInvalidation(
                  systemContextA,
                  secondEvent,
                )
              ).consumer.decision,
              'REJECTED_STALE_OR_DUPLICATE',
            );
            const doubt = await slowService.consumeInvalidation(
              systemContextA,
              thirdEvent,
              { doubt: true },
            );
            assert.equal(doubt.consumer.requestPointerReread, true);
            assert.equal(doubt.authoritativePointerReread, true);

            policy.set(contextA, true);
            const slowEntry = new AuthenticatedRequestRuntimeEntryAdapter(
              authenticatedEntry,
              slowService,
              policy,
            );
            const currentView = await slowEntry.run(
              { headers: { authorization: 'Bearer tenant-a' } },
              (view) => view,
            );
            const currentPin = createPinnedRuntimeContextEnvelope(currentView);
            assert.deepEqual(
              await slowService.validatePin(contextA, currentPin),
              {
                resultVersion: 'northstar.pin-validation-result/v1',
                status: 'CURRENT',
              },
            );
            assert.ok(oldPin);
            assert.equal(
              (await slowService.validatePin(contextA, oldPin)).status,
              'STALE_RELEASE_REPLAN',
            );
            await assertSeparateProcessPin(currentPin);
          },
        );

        await t.test(
          'persisted grouped surface payload propagates its v2 artifact version',
          async () => {
            await activateRelease(
              runtimePool,
              pool,
              activationService,
              versionApproverContext,
              versionContext,
              versionSystemContext,
              versionReleases[0]!,
            );
            const loaded = await new PostgresRequestRuntimeViewService(
              runtimePool,
            ).load(versionContext);
            assert.equal(
              loaded.projections.surface.payloadSchemaVersion,
              COMPOSED_SURFACE_MANIFEST_PAYLOAD_VERSION,
            );
            const payload = mutableRecord(loaded.projections.surface.payload);
            assert.equal(
              payload.schemaVersion,
              COMPOSED_SURFACE_MANIFEST_PAYLOAD_VERSION,
            );
            assert.ok(payload.navigation);
          },
        );

        await t.test(
          'unknown persisted surface payload version fails closed',
          async () => {
            await activateRelease(
              runtimePool,
              pool,
              activationService,
              versionApproverContext,
              versionContext,
              versionSystemContext,
              versionReleases[1]!,
            );
            await assertLoadError(
              () =>
                new PostgresRequestRuntimeViewService(runtimePool).load(
                  versionContext,
                ),
              'MALFORMED_REQUIRED_PROJECTION',
              /projection manifest contract is malformed/,
            );
          },
        );

        await t.test(
          'persisted surface manifest and payload version mismatch fails closed',
          async () => {
            await activateRelease(
              runtimePool,
              pool,
              activationService,
              versionApproverContext,
              versionContext,
              versionSystemContext,
              versionReleases[2]!,
            );
            await assertLoadError(
              () =>
                new PostgresRequestRuntimeViewService(runtimePool).load(
                  versionContext,
                ),
              'MALFORMED_REQUIRED_PROJECTION',
              /projection payload version or kind is unsupported/,
            );
          },
        );

        // THE ADMISSION TWIN. Without it every refusal below is satisfied by a
        // runtime that refuses everything, and the capability gate would be a
        // wall rather than a guard.
        //
        // It also proves the RETENTION half: the requirement survives the load
        // and reaches the caller. Before `profile-v2-adoption`'s round-2 fix,
        // `RuntimeProjection` had no such member and this assertion could not
        // have been written at all.
        await t.test(
          'a surface projection at the supported floor serves, and carries its requirement',
          async () => {
            await activateRelease(
              runtimePool,
              pool,
              activationService,
              versionApproverContext,
              versionContext,
              versionSystemContext,
              versionReleases[0]!,
            );
            const loaded = await new PostgresRequestRuntimeViewService(
              runtimePool,
            ).load(versionContext);
            assert.deepEqual(
              loaded.projections.surface.requiredRuntimeCapability,
              {
                capabilityId: 'northstar.runtime:capability.surface-manifest',
                minimumVersion: 9,
              },
            );
            // All FIVE loaded families carry their requirement, not just the
            // surface. Added on round-2 review, which named "carry it only for
            // `surface`" as a tree that keeps a surface-only assertion green.
            for (const [family, projection] of Object.entries(
              loaded.projections,
            )) {
              assert.ok(
                projection.requiredRuntimeCapability,
                `${family} must carry its capability requirement`,
              );
            }
            // The floor the compiler emits under adopted profile v2, and the
            // pair this runtime declares support for. Pinned literally so that
            // raising the emitted floor without raising declared support reds
            // here rather than in production.
            //
            // Keyed by FAMILY: the round-2 correction made the family/capability
            // pair the unit, and this assertion was left keyed by capability id
            // — it read `undefined` and its own control caught it.
            assert.deepEqual(
              SUPPORTED_RUNTIME_CAPABILITIES[
                PROJECTION_FAMILY_IDS.surfaceManifest
              ],
              {
                capabilityId: 'northstar.runtime:capability.surface-manifest',
                maximumSupportedVersion: 9,
              },
            );
          },
        );

        await t.test(
          'a surface projection demanding an unsupported floor refuses by its own name',
          async () => {
            await activateRelease(
              runtimePool,
              pool,
              activationService,
              versionApproverContext,
              versionContext,
              versionSystemContext,
              versionReleases[3]!,
            );
            await assertLoadError(
              () =>
                new PostgresRequestRuntimeViewService(runtimePool).load(
                  versionContext,
                ),
              'UNSUPPORTED_RUNTIME_CAPABILITY',
              /requires version 999 and this runtime supports 8/,
            );
          },
        );

        // ORDER, observed rather than asserted. This specimen is wrong TWICE --
        // unsupported floor and an unparseable payload kind -- and the fact
        // under test is which refusal wins. The capability code winning is the
        // only outcome consistent with the gate running before the payload is
        // decoded; the payload code winning would mean this runtime interpreted
        // bytes whose meaning it had already declared it cannot honour.
        await t.test(
          'the capability refusal precedes payload interpretation',
          async () => {
            await activateRelease(
              runtimePool,
              pool,
              activationService,
              versionApproverContext,
              versionContext,
              versionSystemContext,
              versionReleases[4]!,
            );
            await assertLoadError(
              () =>
                new PostgresRequestRuntimeViewService(runtimePool).load(
                  versionContext,
                ),
              'UNSUPPORTED_RUNTIME_CAPABILITY',
              /requires version 999 and this runtime supports 8/,
            );
          },
        );

        // THE OPAQUE-INTEGRITY TWIN, added on round-2 review. The capability
        // refusal claims the release is "well-formed and internally
        // consistent"; that premise has to be ESTABLISHED before the claim can
        // be made, or a corrupt release reports an under-supported reader and
        // sends an operator toward a runtime upgrade that fixes nothing.
        //
        // Same unsupported floor as the control above, plus a deleted chunk
        // link. The projection is now corrupt in a way provable on OPAQUE BYTES
        // — no payload interpretation required — so malformed must win.
        // THE DEEPER INTEGRITY TWIN, added on round-3 review. The twin below
        // deletes a chunk LINK, which is the FIRST check in the integrity
        // sequence — so it only proves link-before-capability, and a gate moved
        // to sit just after link validation but before artifact verification
        // would keep it green while misreporting every later corruption as an
        // under-supported reader.
        //
        // This one corrupts a byte of the stored chunk with the length held
        // constant, so the link resolves, the artifact is present, and the
        // descriptor still agrees — the loader reaches `verifyArtifact` and
        // refuses on the content hash. Together the pair brackets the range:
        // no placement earlier than artifact verification survives both.
        //
        // The remaining two checks (descriptor match, semantic digest) are NOT
        // covered behaviourally. **The earlier claim that they "cannot be seeded
        // at all" was WRONG and is withdrawn** — corrected on the confirm arm.
        // Normal admission does recompute the semantic digest from the chunk
        // bytes (`release-repository.ts`), but this suite does not go through
        // normal admission for its specimens: it admits a valid release and then
        // disables the immutable-storage rules, exactly as the two helpers below
        // already do. Both specimens are constructible that way.
        //
        // They are uncovered because they were not BUILT, not because they are
        // impossible, and the difference matters: the first is a limit, the
        // second was an excuse. **The surviving broken tree is therefore named
        // rather than implied** — a gate placed after `verifyArtifact` but before
        // the descriptor and digest checks keeps all four controls green while
        // misreporting both as an under-supported reader. Routed to
        // `runtime-integrity-attribution-untwinned`.
        await t.test(
          'a chunk failing artifact verification reports malformed, not unsupported capability',
          async () => {
            await activateRelease(
              runtimePool,
              pool,
              activationService,
              versionApproverContext,
              versionContext,
              versionSystemContext,
              versionReleases[5]!,
            );
            await corruptSurfaceChunkBytes(pool, versionReleases[5]!.releaseId);
            await assertLoadError(
              () =>
                new PostgresRequestRuntimeViewService(runtimePool).load(
                  versionContext,
                ),
              'MALFORMED_REQUIRED_PROJECTION',
              /artifact bytes, domain, or digest are invalid/,
            );
          },
        );

        await t.test(
          'a missing projection chunk link reports malformed, not unsupported capability',
          async () => {
            await activateRelease(
              runtimePool,
              pool,
              activationService,
              versionApproverContext,
              versionContext,
              versionSystemContext,
              versionReleases[3]!,
            );
            await removeSurfaceChunkLink(pool, versionReleases[3]!.releaseId);
            await assertLoadError(
              () =>
                new PostgresRequestRuntimeViewService(runtimePool).load(
                  versionContext,
                ),
              'MALFORMED_REQUIRED_PROJECTION',
              /projection chunk link is missing or duplicated/,
            );
          },
        );

        await t.test(
          'missing required projection structure has no source fallback',
          async () => {
            await removeRequiredProjection(pool, releasesB[0]!.releaseId);
            const uncached = new PostgresRequestRuntimeViewService(runtimePool);
            await assertLoadError(
              () => uncached.load(contextB),
              'REQUIRED_PROJECTION_MISSING',
            );
          },
        );

        assert.equal(initialA.event.fence, 1);
        assert.equal(initialB.event.fence, 1);
      } finally {
        await runtimePool.end();
      }
    },
  );
});

class VersionedPolicyAdapter implements CurrentPolicyGateway {
  authorizationCalls = 0;
  readonly #state = new Map<string, { allowed: boolean; version: number }>();

  set(subject: CurrentPolicySubject, allowed: boolean): void {
    const key = subjectKey(subject);
    const previous = this.#state.get(key);
    this.#state.set(key, {
      allowed,
      version: (previous?.version ?? 0) + 1,
    });
  }

  async readCurrentVersion(
    subject: CurrentPolicySubject,
  ): Promise<CurrentPolicyVersionEvidence> {
    const state = this.#required(subject);
    return Object.freeze({ policyVersion: `fixture-policy/${state.version}` });
  }

  async authorize(
    request: CurrentPolicyDecisionRequest,
  ): Promise<CurrentPolicyDecision> {
    this.authorizationCalls += 1;
    assert.match(request.permissionId, /\S/);
    assert.match(request.pinnedReleaseId, /^[0-9a-f-]{36}$/i);
    assert.match(request.pinnedReleaseContentHash, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(request.pointerFence));
    const state = this.#required(request);
    return Object.freeze({
      decision: state.allowed ? 'ALLOW' : 'DENY',
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: `fixture-policy/${state.version}`,
    });
  }

  #required(subject: CurrentPolicySubject): {
    allowed: boolean;
    version: number;
  } {
    const state = this.#state.get(subjectKey(subject));
    assert.ok(state, 'policy subject must be explicitly configured');
    return state;
  }
}

async function seedScopes(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO platform.tenants (id, slug)
     VALUES ($1, 'request-view-a'), ($2, 'request-view-b')`,
    [tenantA, tenantB],
  );
  await client.query(
    `INSERT INTO platform.environments (tenant_id, id, slug)
     VALUES ($1, $2, 'production'),
            ($3, $4, 'production'),
            ($1, $5, 'broken-fixture'),
            ($1, $6, 'surface-version-fixture')`,
    [
      tenantA,
      environmentA,
      tenantB,
      environmentB,
      brokenEnvironment,
      versionEnvironment,
    ],
  );
}

async function makeInvisibleReleaseFixture(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(
    'ALTER TABLE platform.active_release_pointers DISABLE TRIGGER ALL',
  );
  try {
    await client.query(
      `UPDATE platform.active_release_pointers
          SET release_id = $1,
              fence = fence + 1
        WHERE tenant_id = $2 AND environment_id = $3`,
      [randomUUID(), tenantA, brokenEnvironment],
    );
  } finally {
    await client.query(
      'ALTER TABLE platform.active_release_pointers ENABLE TRIGGER ALL',
    );
  }
}

async function seedReleases(
  pool: pg.Pool,
  context: TrustedRequestContext,
  sources: readonly (readonly [Uint8Array, CompileSuccess])[],
): Promise<ReleaseFixture[]> {
  const repository = new PostgresImmutableReleaseRepository(pool);
  const releases: ReleaseFixture[] = [];
  for (const [bytes, compiled] of sources) {
    const revisionId = minted(randomUUID());
    const releaseId = minted(randomUUID());
    const evidenceId = verificationEvidenceIdForCandidate(
      context,
      releaseId,
      compiled.releaseRoot,
    );
    await repository.storeAppPackageRevision(
      context,
      revisionCommand(context, revisionId, bytes),
    );
    await admitEmptyPlanRelease(
      pool,
      repository,
      context,
      releaseCommand(context, releaseId, revisionId, evidenceId, compiled),
    );
    releases.push({ compiled, evidenceId, releaseId, revisionId });
  }
  return releases;
}

async function activateRelease(
  runtimePool: pg.Pool,
  adminPool: pg.Pool,
  service: PostgresReleaseActivationService,
  approverContext: TrustedRequestContext,
  preparationContext: TrustedRequestContext,
  systemContext: TrustedRequestContext,
  target: ReleaseFixture,
): Promise<{
  attempt: AttemptFixture;
  event: ReleaseActivationInvalidationEvent;
}> {
  const attempt = await prepareApproval(
    runtimePool,
    approverContext,
    preparationContext,
    target,
  );
  const result = await service.activate(systemContext, attempt);
  assert.equal(result.status, 'SWAPPED_VERIFIED');
  assert.equal(result.releaseId, target.releaseId);
  return {
    attempt,
    event: await invalidationForAttempt(
      adminPool,
      service,
      systemContext,
      attempt.activationAttemptId,
    ),
  };
}

async function prepareApproval(
  pool: pg.Pool,
  approverContext: TrustedRequestContext,
  preparationContext: TrustedRequestContext,
  target: ReleaseFixture,
): Promise<AttemptFixture> {
  const current = await visiblePointer(pool, preparationContext);
  const preparationId = minted(randomUUID());
  const receiptId = minted(randomUUID());
  const targetRoot = Buffer.from(target.compiled.releaseRoot, 'hex');
  const sourceRoot =
    current.releaseId === null
      ? null
      : await releaseRoot(pool, preparationContext, current.releaseId);

  await withTrustedRequestTransaction(
    pool,
    preparationContext,
    async (client) => {
      await client.query(
        `INSERT INTO platform.transition_preparation_receipts (
           tenant_id, environment_id, receipt_id, receipt_version,
           source_release_id, source_manifest_root,
           target_release_id, target_manifest_root,
           transition_scope, storage_domain_id, schema_generation,
           compiler_facts_version, compiler_facts_digest,
           compiler_transition_class, compiler_static_compatibility,
           compiler_exact_pair, executor_evidence_version,
           executor_evidence_digest, executor_applied_state,
           executor_exact_pair, compatibility_policy_version,
           compatibility_policy_verdict, recovery_mode
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           'tenantLocal', 'tenant-primary-storage', $9,
           $10, $11, 'NO_STORAGE_TRANSITION', 'SATISFIED', true,
           $12, $13, 'NOT_REQUIRED', true, $14, 'ALLOW',
           'NO_STORAGE_RECOVERY_REQUIRED'
         )`,
        [
          preparationContext.tenantId,
          preparationContext.environmentId,
          receiptId,
          TRANSITION_PREPARATION_RECEIPT_VERSION,
          current.releaseId,
          sourceRoot,
          target.releaseId,
          targetRoot,
          current.fence,
          COMPILER_TRANSITION_FACTS_VERSION,
          digest('compiler-facts', current.pointerId, target.releaseId),
          EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
          digest('executor-evidence', current.pointerId, target.releaseId),
          TRANSITION_COMPATIBILITY_POLICY_VERSION,
        ],
      );

      const initial = current.releaseId === null;
      await client.query(
        `INSERT INTO platform.release_activation_preparations (
           tenant_id, environment_id, preparation_id, preparation_version,
           expected_pointer_id, expected_release_id, expected_fence,
           source_manifest_root, target_release_id, target_manifest_root,
           diff_binding_kind, diff_binding_version, release_diff_version,
           release_diff_algorithm_version, canonical_diff_digest,
           transition_plan_digest, compiler_attestation_digest,
           compiler_version, compiler_semantic_profile_version,
           compiler_output_protocol_version, verification_evidence_id,
           verification_evidence_version, verification_evidence_digest,
           capability_support_version, capability_support_digest,
           capability_support_result, renderer_version, view_schema_version,
           rendered_diff_evidence_digest, transition_preparation_receipt_id
         ) VALUES (
           $1, $2, $3, 'northstar.release-activation-preparation/v1',
           $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL,
           $15, $16, $17, $18, $19, 'northstar.verification-evidence/v1',
           $20, 'northstar.capability-support/v1', $21, 'SUPPORTED',
           'northstar.release-diff-renderer/v1',
           'northstar.release-diff-view/v1', $22, $23
         )`,
        [
          preparationContext.tenantId,
          preparationContext.environmentId,
          preparationId,
          current.pointerId,
          current.releaseId,
          current.fence,
          sourceRoot,
          target.releaseId,
          targetRoot,
          initial ? 'INITIAL_ACTIVATION' : 'RELEASE_DIFF',
          initial
            ? INITIAL_ACTIVATION_BINDING_VERSION
            : RELEASE_DIFF_BINDING_VERSION,
          initial ? null : 'northstar.release-diff/v0-experimental',
          initial ? null : 'northstar.release-diff-algorithm/v1',
          digest('canonical-diff', current.pointerId, target.releaseId),
          Buffer.from(target.compiled.attestation.attestationDigest, 'hex'),
          target.compiled.bundle.releaseManifest.compilerVersion,
          target.compiled.bundle.releaseManifest.compilerSemanticProfileVersion,
          target.compiled.bundle.releaseManifest.outputProtocolVersion,
          target.evidenceId,
          digest('verification-evidence', target.evidenceId),
          digest('capability-support', target.releaseId),
          digest('rendered-diff', current.pointerId, target.releaseId),
          receiptId,
        ],
      );
    },
  );

  const command: CreateReleaseApprovalCommand = {
    activationAttemptId: minted(randomUUID()),
    approvalId: minted(randomUUID()),
    approvingHumanId: approverContext.principalId,
    initiatingHumanId: approverContext.principalId,
    issuingActorId: approverContext.principalId,
    preparationId,
    targetReleaseId: target.releaseId,
  };
  const created = await new PostgresReleaseApprovalService(pool).createApproval(
    approverContext,
    command,
  );
  return {
    activationAttemptId: created.attempt.activationAttemptId,
    targetReleaseId: created.approval.targetReleaseId,
  };
}

async function invalidationForAttempt(
  adminPool: pg.Pool,
  service: PostgresReleaseActivationService,
  context: TrustedRequestContext,
  activationAttemptId: MintedUuid,
): Promise<ReleaseActivationInvalidationEvent> {
  const result = await adminPool.query<{ outbox_id: MintedUuid }>(
    `SELECT outbox_id
       FROM platform.release_activation_outbox
      WHERE activation_attempt_id = $1`,
    [activationAttemptId],
  );
  const outboxId = result.rows[0]?.outbox_id;
  assert.ok(outboxId);
  const event = await service.readInvalidationEvent(context, outboxId);
  assert.ok(event);
  return event;
}

async function visiblePointer(
  pool: pg.Pool,
  context: TrustedRequestContext,
): Promise<PointerFixture> {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    const result = await client.query<{
      fence: string;
      pointer_id: MintedUuid;
      release_id: MintedUuid | null;
    }>(
      `SELECT pointer_id, release_id, fence
         FROM platform.active_release_pointers
        WHERE tenant_id = $1 AND environment_id = $2`,
      [context.tenantId, context.environmentId],
    );
    const row = result.rows[0];
    assert.ok(row);
    return {
      fence: Number(row.fence),
      pointerId: row.pointer_id,
      releaseId: row.release_id,
    };
  });
}

async function releaseRoot(
  pool: pg.Pool,
  context: TrustedRequestContext,
  releaseId: MintedUuid,
): Promise<Uint8Array> {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    const result = await client.query<{ content_hash: string }>(
      'SELECT content_hash FROM platform.tenant_releases WHERE release_id = $1',
      [releaseId],
    );
    assert.ok(result.rows[0]);
    return Buffer.from(result.rows[0].content_hash, 'hex');
  });
}

async function changeApproverEligibility(
  pool: pg.Pool,
  tenantId: string,
  principalId: string,
  eligible: boolean,
): Promise<void> {
  await pool.query(
    'SELECT platform.set_release_approver_eligibility($1, $2, $3, $4, $5)',
    [tenantId, principalId, eligible, authorityOperator, randomUUID()],
  );
}

async function changeExecutorAuthority(
  pool: pg.Pool,
  tenantId: string,
  authorized: boolean,
): Promise<void> {
  await pool.query(
    'SELECT platform.set_release_executor_authority($1, $2, $3, $4, $5)',
    [
      tenantId,
      SYSTEM_EXECUTION_PRINCIPAL.principalId,
      authorized,
      authorityOperator,
      randomUUID(),
    ],
  );
}

async function removeRequiredProjection(
  pool: pg.Pool,
  releaseId: MintedUuid,
): Promise<void> {
  await pool.query(
    'ALTER TABLE platform.tenant_release_chunk_links DISABLE RULE tenant_release_chunk_links_reject_delete',
  );
  await pool.query(
    'ALTER TABLE platform.tenant_release_projection_links DISABLE RULE tenant_release_projection_links_reject_delete',
  );
  try {
    const instance = await pool.query<{ projection_instance_id: string }>(
      `SELECT projection_instance_id
         FROM platform.tenant_release_projection_links
        WHERE release_id = $1
          AND projection_family_id =
            'northstar.compiler:projection-family.semantic-model'`,
      [releaseId],
    );
    const instanceId = instance.rows[0]?.projection_instance_id;
    assert.ok(instanceId);
    await pool.query(
      `DELETE FROM platform.tenant_release_chunk_links
        WHERE release_id = $1 AND projection_instance_id = $2`,
      [releaseId, instanceId],
    );
    await pool.query(
      `DELETE FROM platform.tenant_release_projection_links
        WHERE release_id = $1 AND projection_instance_id = $2`,
      [releaseId, instanceId],
    );
  } finally {
    await pool.query(
      'ALTER TABLE platform.tenant_release_projection_links ENABLE RULE tenant_release_projection_links_reject_delete',
    );
    await pool.query(
      'ALTER TABLE platform.tenant_release_chunk_links ENABLE RULE tenant_release_chunk_links_reject_delete',
    );
  }
}

/**
 * Deletes the surface projection's CHUNK link, leaving the projection link and
 * the manifest intact. The loader then finds the manifest, validates it, and
 * fails opaque integrity when it cannot resolve exactly one chunk link.
 *
 * Used to prove the capability refusal does not mask corrupt storage.
 */
async function removeSurfaceChunkLink(
  pool: pg.Pool,
  releaseId: MintedUuid,
): Promise<void> {
  await pool.query(
    'ALTER TABLE platform.tenant_release_chunk_links DISABLE RULE tenant_release_chunk_links_reject_delete',
  );
  try {
    const instance = await pool.query<{ projection_instance_id: string }>(
      `SELECT projection_instance_id
         FROM platform.tenant_release_projection_links
        WHERE release_id = $1
          AND projection_family_id =
            'northstar.compiler:projection-family.surface-manifest'`,
      [releaseId],
    );
    const instanceId = instance.rows[0]?.projection_instance_id;
    assert.ok(instanceId);
    await pool.query(
      `DELETE FROM platform.tenant_release_chunk_links
        WHERE release_id = $1 AND projection_instance_id = $2`,
      [releaseId, instanceId],
    );
  } finally {
    await pool.query(
      'ALTER TABLE platform.tenant_release_chunk_links ENABLE RULE tenant_release_chunk_links_reject_delete',
    );
  }
}

/**
 * Substitutes one byte of the surface projection's stored CHUNK, keeping the
 * length identical so every table constraint still holds.
 *
 * The link resolves, the artifact is present, and the descriptor's byte length
 * still agrees — so the loader reaches `verifyArtifact` and refuses on the
 * content hash. That is strictly DEEPER in the integrity sequence than the
 * deleted-link twin, which is the point: it kills a gate placed anywhere before
 * artifact verification, not merely one placed before link validation.
 *
 * **THIS SPECIMEN IS NOT SINGLE-FAULT, corrected on the confirm arm.** An
 * earlier version of this comment claimed the content hash was the only broken
 * property. It is not. The chunk is canonical JSON, so its first byte is `{`
 * (0x7b); incrementing it yields `|`, which is not valid JSON. And the manifest's
 * semantic digest still describes the ORIGINAL bytes, so that comparison is
 * broken too. Three invariants are violated, not one.
 *
 * What the specimen therefore proves is narrower than "only the hash is wrong",
 * and it is still exactly the property this control exists for: **`verifyArtifact`
 * is the FIRST of the three to run, deterministically**, so a capability gate
 * placed before it reports an under-supported reader instead. Link and descriptor
 * metadata remain intact, which is what keeps the specimen from failing earlier.
 *
 * A genuinely single-fault content-hash specimen is possible — re-key the blob to
 * a deliberately wrong 64-hex hash and repoint the descriptor, link, closure and
 * release root at it, leaving the valid bytes and digest alone. It is not built:
 * see `runtime-integrity-attribution-untwinned`.
 */
async function corruptSurfaceChunkBytes(
  pool: pg.Pool,
  releaseId: MintedUuid,
): Promise<void> {
  const chunk = await pool.query<{ chunk_hash: string }>(
    `SELECT link.chunk_hash
       FROM platform.tenant_release_chunk_links AS link
       JOIN platform.tenant_release_projection_links AS projection
         ON projection.release_id = link.release_id
        AND projection.projection_instance_id = link.projection_instance_id
      WHERE link.release_id = $1
        AND projection.projection_family_id =
          'northstar.compiler:projection-family.surface-manifest'`,
    [releaseId],
  );
  const chunkHash = chunk.rows[0]?.chunk_hash;
  assert.ok(chunkHash);
  await pool.query(
    'ALTER TABLE platform.release_artifact_blobs DISABLE RULE release_artifact_blobs_reject_update',
  );
  try {
    // `set_byte` on the first byte, same length, so `byte_length =
    // octet_length(canonical_bytes)` still holds and the ONLY broken property is
    // the content hash.
    await pool.query(
      `UPDATE platform.release_artifact_blobs
          SET canonical_bytes =
                set_byte(canonical_bytes, 0, (get_byte(canonical_bytes, 0) + 1) % 256)
        WHERE content_hash = $1`,
      [chunkHash],
    );
  } finally {
    await pool.query(
      'ALTER TABLE platform.release_artifact_blobs ENABLE RULE release_artifact_blobs_reject_update',
    );
  }
}

async function assertSeparateProcessPin(
  pin: PinnedRuntimeContextEnvelope,
): Promise<void> {
  const moduleUrl = pathToFileURL(
    resolve('packages/runtime/src/request-runtime-view.ts'),
  ).href;
  const serialized = JSON.stringify(pin);
  const script = `
    import { parsePinnedRuntimeContextEnvelope } from ${JSON.stringify(moduleUrl)};
    let ambientRejected = false;
    try { parsePinnedRuntimeContextEnvelope(''); } catch { ambientRejected = true; }
    const parsed = parsePinnedRuntimeContextEnvelope(process.argv[1]);
    process.stdout.write(JSON.stringify({ ambientRejected, parsed }));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script, serialized],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  const received = JSON.parse(stdout) as {
    ambientRejected: boolean;
    parsed: PinnedRuntimeContextEnvelope;
  };
  assert.equal(received.ambientRejected, true);
  assert.deepEqual(
    received.parsed,
    parsePinnedRuntimeContextEnvelope(serialized),
  );
}

async function assertLoadError(
  run: () => Promise<unknown>,
  code: RequestRuntimeViewLoadError['code'],
  message?: RegExp,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof RequestRuntimeViewLoadError);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

async function assertRuntimeViewRefusalError(
  run: () => Promise<unknown>,
  code: RequestRuntimeViewRefusalError['code'],
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof RequestRuntimeViewRefusalError);
    assert.equal(error.code, code);
    return true;
  });
}

function revisionCommand(
  context: TrustedRequestContext,
  revisionId: MintedUuid,
  desiredState: Uint8Array,
): StoreAppPackageRevisionCommand {
  const normalizedDefinition =
    parseNormalizedApplicationPackageJson(desiredState);
  const normalized = canonicalizeAndHash(normalizedDefinition);
  return {
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    contentHash: normalized.contentHash,
    createdBy: context.principalId,
    desiredState,
    hashAlgorithm: CONTENT_HASH_ALGORITHM,
    languageVersion: normalizedDefinition.languageVersion,
    normalizationProfileVersion:
      normalizedDefinition.normalizationProfileVersion,
    parentRevisionId: null,
    provenance: 'firstParty',
    revisionId,
    schemaVersion: normalizedDefinition.schemaVersion,
    tenantId: context.tenantId,
  };
}

function releaseCommand(
  context: TrustedRequestContext,
  releaseId: MintedUuid,
  appPackageRevisionId: MintedUuid,
  verificationEvidenceId: MintedUuid,
  compiledRelease: CompileSuccess,
): RegisterTenantReleaseCommand<CompileSuccess> {
  return {
    appPackageRevisionId,
    compiledRelease,
    createdBy: context.principalId,
    environmentId: context.environmentId,
    releaseId,
    tenantId: context.tenantId,
    verificationEvidenceId,
  };
}

async function issuedContext(
  tenantId: string,
  environmentId: string,
  principalId: string,
): Promise<TrustedRequestContext> {
  return new AuthenticatedRequestEntryAdapter(async () => ({
    environmentId,
    principalId,
    tenantId,
  })).enter({ headers: { authorization: 'fixture' } });
}

function mustCompile(bytes: Uint8Array): CompileSuccess {
  const result = compileApplication(compilerInput(bytes));
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function groupedNavigationDefinitionBytes(): Uint8Array {
  const definition = structuredClone(composedApplicationDefinition());
  const inventory = inventoryModuleDefinition('northstar.app');
  for (const collectionName of [
    'assertions',
    'entities',
    'fields',
    'operations',
    'permissions',
    'queries',
    'relations',
    'stateMachines',
    'storageMappings',
    'surfaces',
  ] as const) {
    const target = definition[collectionName];
    const source = inventory[collectionName];
    assert.ok(Array.isArray(target));
    assert.ok(Array.isArray(source));
    assertComposedInventoryCollection(
      collectionName,
      target,
      source,
      'northstar.app',
    );
  }
  const modules = definition.modules;
  const inventoryModules = inventory.modules;
  assert.ok(Array.isArray(modules));
  assert.ok(Array.isArray(inventoryModules));
  const inventoryModule = inventoryModules[0];
  assert.ok(inventoryModule && typeof inventoryModule === 'object');
  assert.ok('moduleId' in inventoryModule);
  assert.equal(
    modules.filter(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        'moduleId' in candidate &&
        candidate.moduleId === inventoryModule.moduleId,
    ).length,
    1,
    'composed application must contain the inventory module exactly once',
  );
  return new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(definition)),
  );
}

function rewriteSurfacePayloadVersions(
  compiled: CompileSuccess,
  versions: {
    readonly envelopeVersion: string;
    readonly payloadVersion: string;
  },
): CompileSuccess {
  return rewriteProjectionPayload(
    compiled,
    PROJECTION_FAMILY_IDS.surfaceManifest,
    (payload) => {
      payload.schemaVersion = versions.payloadVersion;
    },
    versions.envelopeVersion,
  );
}

function withoutVerificationScenarios(
  compiled: CompileSuccess,
): CompileSuccess {
  return rewriteProjectionPayload(
    compiled,
    PROJECTION_FAMILY_IDS.verificationPlan,
    (payload) => {
      payload.scenarios = [];
    },
  );
}

/**
 * Forges an otherwise-VALID release whose surface projection demands a runtime
 * capability floor this runtime cannot honour.
 *
 * ONE property varies. Payload schema, payload kind, chunk bytes, digests,
 * artifact closure and node fingerprints are all regenerated consistently, and
 * the floor is written to BOTH the manifest and its reference so the provider's
 * canonical-agreement check still passes. Anything less and the specimen would
 * be refused for being MALFORMED, and the control would prove nothing about the
 * capability comparison -- the confound `review-tiers` calls "a broken tree with
 * two reasons to fail".
 */
function withSurfaceCapabilityFloor(
  compiled: CompileSuccess,
  minimumVersion: number,
  mutatePayload: (payload: Record<string, unknown>) => void = () => {},
): CompileSuccess {
  return rewriteProjectionPayload(
    compiled,
    PROJECTION_FAMILY_IDS.surfaceManifest,
    mutatePayload,
    undefined,
    minimumVersion,
  );
}

function rewriteProjectionPayload(
  compiled: CompileSuccess,
  familyId: string,
  mutatePayload: (payload: Record<string, unknown>) => void,
  envelopeVersion?: string,
  capabilityFloor?: number,
): CompileSuccess {
  const clone = structuredClone(compiled);
  const reference = clone.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  const priorManifestHash = reference.artifactRoot;
  const manifestArtifact = clone.bundle.artifacts.find(
    (candidate) => candidate.contentHash === priorManifestHash,
  );
  assert.ok(manifestArtifact);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  const descriptor = manifest.chunks[0];
  assert.ok(descriptor);
  const priorChunkHash = descriptor.contentHash;
  const chunkArtifact = clone.bundle.artifacts.find(
    (candidate) => candidate.contentHash === priorChunkHash,
  );
  assert.ok(chunkArtifact);
  const payload = JSON.parse(
    new TextDecoder().decode(chunkArtifact.canonicalBytes),
  ) as Record<string, unknown>;
  mutatePayload(payload);
  const payloadBytes = canonicalBytes(payload);
  const replacementChunk: ContentAddressedArtifact = {
    ...chunkArtifact,
    canonicalBytes: payloadBytes,
    contentHash: hashArtifactBytes(chunkArtifact.domainTag, payloadBytes),
  };

  descriptor.byteLength = payloadBytes.byteLength;
  descriptor.contentHash = replacementChunk.contentHash;
  if (envelopeVersion !== undefined) {
    manifest.payloadSchemaVersion = envelopeVersion;
    reference.payloadSchemaVersion = envelopeVersion;
  }
  if (capabilityFloor !== undefined) {
    // Written to BOTH sides on purpose: the provider canonicalizes the manifest
    // against its reference and refuses any disagreement, so a floor set on one
    // side alone would be refused as malformed and never reach the comparison.
    manifest.requiredRuntimeCapability = {
      ...manifest.requiredRuntimeCapability,
      minimumVersion: capabilityFloor,
    };
    reference.requiredRuntimeCapability = {
      ...reference.requiredRuntimeCapability,
      minimumVersion: capabilityFloor,
    };
  }
  manifest.semanticDigest = hashArtifactBytes(
    `${HASH_DOMAINS.projectionSemantic}/${familyId}`,
    payloadBytes,
  );
  reference.semanticDigest = manifest.semanticDigest;
  const manifestBytes = canonicalBytes(manifest);
  const replacementManifest: ContentAddressedArtifact = {
    ...manifestArtifact,
    canonicalBytes: manifestBytes,
    contentHash: hashArtifactBytes(manifestArtifact.domainTag, manifestBytes),
  };
  reference.artifactRoot = replacementManifest.contentHash;

  clone.bundle.releaseManifest.artifactClosure =
    clone.bundle.releaseManifest.artifactClosure
      .map((contentHash) =>
        contentHash === priorChunkHash
          ? replacementChunk.contentHash
          : contentHash === priorManifestHash
            ? replacementManifest.contentHash
            : contentHash,
      )
      .toSorted();
  clone.bundle.artifacts = replaceArtifacts(
    clone.bundle.artifacts,
    new Map([
      [priorChunkHash, replacementChunk],
      [priorManifestHash, replacementManifest],
    ]),
  );
  clone.stagedArtifacts = replaceArtifacts(
    clone.stagedArtifacts,
    new Map([
      [priorChunkHash, replacementChunk],
      [priorManifestHash, replacementManifest],
    ]),
  );
  const node = clone.bundle.nodeContracts.find(
    (candidate) => candidate.stableNodeId === `${reference.instanceId}.node`,
  );
  assert.ok(node);
  node.outputFingerprint = hashArtifactBytes(
    HASH_DOMAINS.nodeOutput,
    canonicalBytes({
      artifactRoot: replacementManifest.contentHash,
      semanticDigest: manifest.semanticDigest,
    }),
  );
  return rebuildReleaseRoot(clone);
}

function rebuildReleaseRoot(compiled: CompileSuccess): CompileSuccess {
  const bytes = canonicalBytes(compiled.bundle.releaseManifest);
  const root = hashArtifactBytes(HASH_DOMAINS.releaseManifest, bytes);
  const replacement: ContentAddressedArtifact = {
    artifactKind: 'releaseManifest',
    canonicalBytes: bytes,
    contentHash: root,
    domainTag: HASH_DOMAINS.releaseManifest,
    kind: 'contentAddressedArtifact',
    mediaType: 'application/vnd.northstar.canonical+json',
  };
  compiled.bundle.releaseManifestBytes = bytes;
  compiled.releaseRoot = root;
  compiled.bundle.artifacts = replaceRootArtifact(
    compiled.bundle.artifacts,
    replacement,
  );
  compiled.stagedArtifacts = replaceRootArtifact(
    compiled.stagedArtifacts,
    replacement,
  );
  compiled.attestation.releaseRoot = root;
  const attestation = { ...compiled.attestation } as Record<string, unknown>;
  delete attestation.attestationDigest;
  compiled.attestation.attestationDigest = hashArtifactBytes(
    HASH_DOMAINS.compilerAttestation,
    canonicalBytes(attestation),
  );
  return compiled;
}

function replaceArtifacts(
  artifacts: ContentAddressedArtifact[],
  replacements: ReadonlyMap<string, ContentAddressedArtifact>,
): ContentAddressedArtifact[] {
  return artifacts.map(
    (artifact) => replacements.get(artifact.contentHash) ?? artifact,
  );
}

function replaceRootArtifact(
  artifacts: ContentAddressedArtifact[],
  replacement: ContentAddressedArtifact,
): ContentAddressedArtifact[] {
  return artifacts.map((artifact) =>
    artifact.artifactKind === 'releaseManifest' ? replacement : artifact,
  );
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

function hashArtifactBytes(domainTag: string, bytes: Uint8Array): string {
  return createHash(HASH_ALGORITHM)
    .update(domainTag, 'utf8')
    .update(Uint8Array.of(0))
    .update(bytes)
    .digest('hex');
}

function mutableRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function subjectKey(subject: CurrentPolicySubject): string {
  return `${subject.tenantId}\0${subject.environmentId}\0${subject.principalId}`;
}

function containsArrayBufferView(value: unknown): boolean {
  if (ArrayBuffer.isView(value)) return true;
  if (Array.isArray(value)) return value.some(containsArrayBufferView);
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).some(containsArrayBufferView);
}

function digest(...parts: readonly string[]): Uint8Array {
  return createHash('sha256').update(parts.join('\0')).digest();
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}
