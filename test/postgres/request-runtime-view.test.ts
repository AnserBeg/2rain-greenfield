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
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  canonicalizeAndHash,
} from '../../packages/canonical-model/src/index.js';
import {
  compileApplication,
  type CompileSuccess,
} from '../../packages/compiler/src/index.js';
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
  type PinnedRuntimeContextEnvelope,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import { compilerInput, fixtureBytes } from '../compiler/helpers.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const execFileAsync = promisify(execFile);
const checkedInMigrations = resolve('db/migrations');

const tenantA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const environmentA = 'a1000000-0000-4000-8000-000000000001';
const environmentB = 'b1000000-0000-4000-8000-000000000001';
const brokenEnvironment = 'a1000000-0000-4000-8000-000000000002';
const missingEnvironment = 'a1000000-0000-4000-8000-000000000099';
const principalA = 'aa000000-0000-4000-8000-000000000001';
const principalB = 'bb000000-0000-4000-8000-000000000001';
const approverA = 'ac000000-0000-4000-8000-000000000002';
const approverB = 'bc000000-0000-4000-8000-000000000002';
const authorityOperator = 'a9000000-0000-4000-8000-000000000009';

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

test('G1-P5 pins one immutable release while policy and pointer authority remain current', async (t) => {
  const bootstrapBytes = fixtureBytes('bootstrap');
  const verticalBytes = fixtureBytes('vertical-v1');
  const bootstrap = mustCompile(bootstrapBytes);
  const vertical = mustCompile(verticalBytes);

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
        max: 6,
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

      try {
        const releasesA = await seedReleases(runtimePool, contextA, [
          [bootstrapBytes, bootstrap],
          [verticalBytes, vertical],
        ]);
        const releasesB = await seedReleases(runtimePool, contextB, [
          [bootstrapBytes, bootstrap],
        ]);
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
            await assertLoadError(
              () =>
                requestEntry.run(
                  { headers: { authorization: 'Bearer tenant-a' } },
                  (view) => view,
                ),
              'NULL_ACTIVE_RELEASE',
            );
            await assertLoadError(
              () =>
                requestEntry.run(
                  { headers: { authorization: 'Bearer missing' } },
                  (view) => view,
                ),
              'ACTIVE_POINTER_MISSING',
            );
            await assertLoadError(
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
            ($1, $5, 'broken-fixture')`,
    [tenantA, environmentA, tenantB, environmentB, brokenEnvironment],
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
    const evidenceId = minted(randomUUID());
    await repository.storeAppPackageRevision(
      context,
      revisionCommand(context, revisionId, bytes),
    );
    await repository.registerTenantRelease(
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
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof RequestRuntimeViewLoadError);
    assert.equal(error.code, code);
    return true;
  });
}

function revisionCommand(
  context: TrustedRequestContext,
  revisionId: MintedUuid,
  desiredState: Uint8Array,
): StoreAppPackageRevisionCommand {
  const normalized = canonicalizeAndHash(
    JSON.parse(new TextDecoder().decode(desiredState)) as unknown,
  );
  return {
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    contentHash: normalized.contentHash,
    createdBy: context.principalId,
    desiredState,
    hashAlgorithm: CONTENT_HASH_ALGORITHM,
    languageVersion: LANGUAGE_VERSION,
    normalizationProfileVersion: NORMALIZATION_PROFILE_VERSION,
    parentRevisionId: null,
    provenance: 'firstParty',
    revisionId,
    schemaVersion: LANGUAGE_VERSION,
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
