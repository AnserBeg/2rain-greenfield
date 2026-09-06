import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import pg from 'pg';

import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  FEEDBACK_LADDER_BANDS,
  monotonicMilliseconds,
  type MetricSnapshot,
} from '../../packages/observability/src/index.js';
import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  expectedActiveReleaseFrom,
  type CompileSuccess,
  type StorageTargetPayloadV1,
  type VerificationPlanPayloadV1,
} from '../../packages/compiler/src/index.js';
import {
  APPLICATION_IDS,
  composedApplicationDefinition,
} from '../../packages/domain/src/app/builder.js';
import {
  COMPILER_TRANSITION_FACTS_VERSION,
  EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
  RELEASE_DIFF_BINDING_VERSION,
  SYSTEM_EXECUTION_PRINCIPAL,
  TRANSITION_COMPATIBILITY_POLICY_VERSION,
  TRANSITION_PREPARATION_RECEIPT_VERSION,
  type MintedUuid,
} from '../../packages/platform-runtime/src/index.js';
import {
  createComposedApplicationRuntime,
  parseCompiledApplication,
  type ComposedApplicationRuntime,
  type FreshTenantIntermediateActivationObservation,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/inventory-posting-capability-executor.js';
import { RECEIVING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receiving-capability-executor.js';
import {
  PostgresCurrentPolicyGateway,
  currentPolicyBindingsFromPermissions,
} from '../../packages/postgres-provider/src/current-policy.js';
import { ModuleRuntimeInterpreterError } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import {
  LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID,
  issueLegalEntityReadScope,
  type ImmutableJsonValue,
} from '../../packages/runtime/src/request-runtime-view.js';
import { captureSchemaSnapshot } from '../../packages/postgres-provider/src/migrations.js';
import { PostgresReleaseActivationService } from '../../packages/postgres-provider/src/release-activation-service.js';
import { PostgresReleaseApprovalService } from '../../packages/postgres-provider/src/release-approval-service.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { RequestRuntimeViewLoadError } from '../../packages/postgres-provider/src/request-runtime-view-service.js';
import { ReleaseReverseTransitionRefusal } from '../../packages/postgres-provider/src/release-reverse-transition-policy.js';
import {
  captureDeclaredCapabilityRefusal,
  declaredCapabilityVerificationRefusals,
  PostgresReleaseVerificationService,
  ReleaseVerificationIntegrityError,
  releaseVerificationBinding,
  type DurableReleaseVerificationEvidence,
} from '../../packages/postgres-provider/src/release-verification-service.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import { TrustEvidenceError } from '../../packages/postgres-provider/src/trust/postgres-trust-service.js';
import {
  AuthenticatedRequestEntryAdapter,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  MalformedSemanticOperationRequestError,
  SemanticOperationPolicyDeniedError,
  type SemanticOperationResultEnvelope,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import type { RequestRuntimeView } from '../../packages/runtime/src/request-runtime-view.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';
import {
  CURRENT_POLICY_BINDINGS_FILE,
  CURRENT_POLICY_BINDINGS_VERSION,
  UNBOUND_PERMISSION_ACKNOWLEDGEMENT_FILE,
  UNBOUND_PERMISSION_ACKNOWLEDGEMENT_VERSION,
} from '../../apps/web/scripts/unbound-permission-acknowledgement.js';

const compiledArtifactPath = resolve('apps/web/release/app.compiled.json');
const authoredArtifactPath = resolve('apps/web/release/app.authored.json');
const compileScriptPath = resolve('apps/web/scripts/compile-app-release.ts');

/**
 * A release-input directory carries its acknowledgement of every declared
 * permission no evaluator binds; the release script refuses to compile a head
 * whose directory has none (policy-unbound-refusal). Each workspace below
 * derives its acknowledgement from the definition it writes, exactly as the
 * checked-in one is derived from the composed application, so the script
 * reaches the compiler and the compiler's own refusals stay observable.
 */
async function writeAcknowledgementBeside(
  authoredPath: string,
  definition: unknown,
): Promise<void> {
  const authored = definition as {
    package: { packageId: string };
    permissions: ReadonlyArray<{
      action: string;
      permissionId: string;
      resource: { targetId: string };
    }>;
  };
  await Promise.all([
    writeFile(
      resolve(dirname(authoredPath), UNBOUND_PERMISSION_ACKNOWLEDGEMENT_FILE),
      JSON.stringify({
        header: [
          'test workspace: every declared permission is evaluator-bound',
        ],
        packages: { [authored.package.packageId]: [] },
        schemaVersion: UNBOUND_PERMISSION_ACKNOWLEDGEMENT_VERSION,
      }),
    ),
    writeFile(
      resolve(dirname(authoredPath), CURRENT_POLICY_BINDINGS_FILE),
      JSON.stringify({
        packages: {
          [authored.package.packageId]: authored.permissions.map(
            (permission) => ({
              action: permission.action,
              permissionId: permission.permissionId,
              resource: permission.resource.targetId,
            }),
          ),
        },
        schemaVersion: CURRENT_POLICY_BINDINGS_VERSION,
      }),
    ),
  ]);
}
const migrationsDirectory = resolve('db/migrations');
const fullReplaySchemaSnapshotPath = resolve(
  'test/postgres/fresh-tenant-full-replay-schema.snapshot.json',
);
const execFileAsync = promisify(execFile);
const rollbackFieldId = 'northstar.app:field.party_rollback_note';

test('composed product does not invent a verification evidence identity', async () => {
  const source = await readFile(
    resolve('packages/postgres-provider/src/composed-application-runtime.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /evidenceId\s*=\s*minted\(randomUUID\(\)\)/u);
});

test('historical reproduction cannot admit a non-conformant freshly compiled head', async () => {
  const compiledApplication = JSON.parse(
    await readFile(compiledArtifactPath, 'utf8'),
  ) as { applications: unknown[] };
  assert.ok(
    parseCompiledApplication(compiledApplication).applications.length > 0,
  );
  const nonConformantHead = JSON.parse(
    await readFile(authoredArtifactPath, 'utf8'),
  ) as {
    fields: Array<{ fieldId: string; searchable: boolean }>;
  };
  const unitField = nonConformantHead.fields.find(
    (field) => field.fieldId === 'northstar.app:field.stock_count_line_unit_id',
  );
  assert.ok(unitField?.searchable);
  unitField.searchable = false;
  const directory = await mkdtemp(
    resolve(tmpdir(), 'northstar-historical-head-scope-'),
  );
  const authoredPath = resolve(directory, 'app.authored.json');
  const compiledPath = resolve(directory, 'app.compiled.json');
  try {
    await Promise.all([
      writeFile(authoredPath, JSON.stringify(nonConformantHead)),
      writeFile(compiledPath, JSON.stringify(compiledApplication)),
      writeAcknowledgementBeside(authoredPath, nonConformantHead),
    ]);
    await assert.rejects(
      execFileAsync(process.execPath, ['--import', 'tsx', compileScriptPath], {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: {
          ...process.env,
          NORTH_STAR_APP_AUTHORED_PATH: authoredPath,
          NORTH_STAR_APP_COMPILED_PATH: compiledPath,
        },
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      }),
      (error: unknown) =>
        error instanceof Error &&
        /COMPILER_SEARCH_SELECTION_STORAGE_UNUSABLE/u.test(
          `${error.message} ${'stderr' in error ? String(error.stderr) : ''}`,
        ),
      'historical entries reproduce leniently, but a newly authored head always compiles strictly and is refused',
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('capability verification records only the exact declared typed refusal', async () => {
  const expectedRefusal =
    INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY.verificationRefusal;
  const exact = Object.assign(new Error(expectedRefusal.reason), {
    code: expectedRefusal.code,
  });
  assert.deepEqual(
    await captureDeclaredCapabilityRefusal(
      Promise.reject(exact),
      expectedRefusal,
      'northstar.test:operation.capability',
    ),
    {
      code: expectedRefusal.code,
      kind: 'registeredCapabilityRefusal',
      operationId: 'northstar.test:operation.capability',
      reason: expectedRefusal.reason,
      schemaVersion: 'northstar.release-verification-capability-probe/v1',
    },
  );
  await assert.rejects(
    captureDeclaredCapabilityRefusal(
      Promise.reject(
        Object.assign(new Error(expectedRefusal.reason), {
          code: 'WRONG_REFUSAL',
        }),
      ),
      expectedRefusal,
      'northstar.test:operation.capability',
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseVerificationIntegrityError);
      assert.equal(error.code, 'VERIFICATION_CAPABILITY_REFUSAL_MISMATCH');
      return true;
    },
    'RIGHT_REASON_WRONG_CODE_MUST_FAIL',
  );
  await assert.rejects(
    captureDeclaredCapabilityRefusal(
      Promise.reject(
        Object.assign(
          new Error(
            'INVENTORY_POSTING_INPUT_INVALID: an adjustment requires at least one line',
          ),
          { code: expectedRefusal.code },
        ),
      ),
      expectedRefusal,
      'northstar.test:operation.capability',
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseVerificationIntegrityError);
      assert.equal(error.code, 'VERIFICATION_CAPABILITY_REFUSAL_MISMATCH');
      return true;
    },
    'RIGHT_CODE_WRONG_REASON_MUST_FAIL',
  );
  await assert.rejects(
    captureDeclaredCapabilityRefusal(
      Promise.resolve({ outcome: 'succeeded' }),
      expectedRefusal,
      'northstar.test:operation.capability',
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseVerificationIntegrityError);
      assert.equal(error.code, 'VERIFICATION_CAPABILITY_REFUSAL_NOT_OBSERVED');
      return true;
    },
    'SUCCESS_WITHOUT_REFUSAL_MUST_FAIL',
  );
});

test('capability verification fails closed when a factory declares no refusal', () => {
  const factoryWithoutRefusal = Object.freeze({
    capabilityId: INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY.capabilityId,
    create: INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY.create,
  }) as unknown as typeof INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY;
  assert.throws(
    () => declaredCapabilityVerificationRefusals([factoryWithoutRefusal]),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseVerificationIntegrityError);
      assert.equal(
        error.code,
        'VERIFICATION_CAPABILITY_REFUSAL_CONTRACT_INVALID',
      );
      assert.match(error.message, /must declare its exact refusal/u);
      return true;
    },
    'MISSING_FACTORY_REFUSAL_MUST_FAIL_CLOSED',
  );
});

test('fresh-tenant install refuses a failing intermediate transition', async () => {
  const compiledApplication = appendSameProfileSuccessor(
    appendSameProfileSuccessor(
      JSON.parse(await readFile(compiledArtifactPath, 'utf8')),
    ),
  ) as { applications: unknown[] };
  assert.ok(
    compiledApplication.applications.length >= 3,
    'the fixture constructs two successors even after a one-entry re-baseline',
  );
  const firstIntermediate = compiledApplication.applications[1]!;
  compiledApplication.applications[1] = compiledApplication.applications[2]!;
  compiledApplication.applications[2] = firstIntermediate;
  await assert.rejects(
    createRuntime(
      compiledApplication,
      'postgresql://postgres@127.0.0.1:1/postgres',
      'failing-intermediate-transition',
    ),
    /transition does not match its declared previous release/u,
  );
});

// ADR-0047 §6, the direction the revision check alone cannot establish. Shared
// revision proves the two releases compile the same SOURCE; it does not prove
// the profile is what differs. Compilation identity also folds in the expected
// active release, the dependency closure and the limits, so a same-revision
// SAME-profile successor exists -- it has no revision-parent edge either, so
// authorization returns null down the identical path. Naming that a
// profile-only edge would be the same misnaming §6 exists to forbid.
//
// Deliberately its own lifecycle rather than another tenant on the test above,
// whose 300s bound is already 1.42x consumed.
//
// DECLARED GAP -- ADR-0047 §6's negative direction is NOT observed. This test
// proves that a same-revision, same-profile edge does not receive the
// profile-only name. It cannot prove the classifier was reached at all: a
// request rejected earlier by the index guard throws the same
// ReleaseReverseTransitionRefusal class with a code that likewise differs from
// the profile-only one, so both surviving assertions pass either way. Restoring
// an exact-code pin does not close this -- production emits that same code from
// the index guard AND the post-authorization fallback, so the pin was
// restrictive without ever being probative.
//
// Closing it needs a production observation distinguishing the two refusal
// sites: an execution counter after reverse authorization returns null, or a
// structured origin/phase field on the refusal. Both are changes to the refusal
// mechanism, which is `rollback-release-edge`'s subject, where this is now a
// binding criterion. Declared here in the ADR-0044 sense -- a structural
// absence, stated and observable, rather than a silent inability.
test(
  'a same-profile successor over one revision is not named a profile-only edge',
  { timeout: 300_000 },
  async () => {
    await withEphemeralPostgres(
      'proj-disc-same-profile-edge',
      async ({ connection, pool }) => {
        const lineage = appendSameProfileSuccessor(
          JSON.parse(await readFile(compiledArtifactPath, 'utf8')) as unknown,
        );
        const parsed = parseCompiledApplication(lineage);
        const head = parsed.application;
        const target = parsed.applications.at(-2)!;

        // The construction is the control: assert it really is same-source,
        // same-profile, distinct-root before drawing any conclusion from it.
        assert.ok(
          equalNormalizedDefinition(
            head.normalizedDefinitionBytes,
            target.normalizedDefinitionBytes,
          ),
        );
        assert.equal(
          head.compiled.bundle.releaseManifest.compilerSemanticProfileVersion,
          target.compiled.bundle.releaseManifest.compilerSemanticProfileVersion,
        );
        assert.notEqual(head.compiled.releaseRoot, target.compiled.releaseRoot);

        const databaseUrl = connectionUrl(connection);
        const slug = 'same-profile-edge-tenant';
        const serving = await createRuntime(lineage, databaseUrl, slug);
        assert.equal(serving.releaseRoot, head.compiled.releaseRoot);

        // OBSERVE the persisted effect rather than inferring it. "Same bytes,
        // therefore ensurePersistedRelease reused a revision" is a claim about
        // the current implementation, and two broken trees satisfy the byte
        // assertions above while failing here: a duplicate persisted as its own
        // revision with no usable parent edge still returns null and still
        // raises the same refusal, and a request rejected early by the index
        // check raises the same code from a different site. Only the persisted
        // revision identity distinguishes them.
        const headRevisionId = await persistedRevisionId(
          pool,
          serving.identity,
          head.compiled.releaseRoot,
        );
        const targetRevisionId = await persistedRevisionId(
          pool,
          serving.identity,
          target.compiled.releaseRoot,
        );
        assert.equal(
          headRevisionId,
          targetRevisionId,
          'the two releases must be persisted against ONE package revision, or this is not the same-revision edge under test',
        );
        await serving.close();

        await assert.rejects(
          createRuntime(lineage, databaseUrl, slug, {
            kind: 'rollback',
            targetReleaseRoot: target.compiled.releaseRoot,
          }),
          (error: unknown) => {
            assert.ok(error instanceof ReleaseReverseTransitionRefusal);
            // Assert ONLY what this test proves: the profile-only name is not
            // applied to an edge whose profiles are equal. The fallback code
            // this currently lands on is itself inaccurate after the index
            // check has passed -- that misnaming predates this packet and is
            // routed to `rollback-release-edge`. Pinning it here would make a
            // false name contractual and obstruct the packet that fixes it.
            assert.notEqual(
              error.code,
              'ROLLBACK_ACROSS_PROFILE_ONLY_EDGE',
              'the profiles are equal, so this edge is not profile-only',
            );
            return true;
          },
        );
      },
    );
  },
);

// Harness limit, not a product budget. Each fresh tenant applies every
// immutable application transition in the recorded lineage but verifies only
// the serving release, recording each non-serving release explicitly. The
// unchanged 256 MiB harness moved from >300s/capacity exhaustion to 54.6s and
// a 50.30 MiB peak when that lineage held five application entries.
//
// Both figures are now stale and the timeout is the reason to say so. The
// lineage holds NINE application entries, and this test drives TWO tenants,
// both for the gateway-persistence subject.
//
// THE SPLIT PRESCRIBED BELOW HAS BEEN TAKEN, by `LANG-ADOPT-v5`, and it took
// two rounds because the first was measured standalone and the bound is
// in-matrix. Adoption made the artifact's head source-changing rather than a
// profile sibling, which swapped which ADR-0047 §6 rollback direction could
// borrow the real head and which needed a served tenant of its own. Round one
// moved the source-changing direction out and left three tenants here: 251.1s
// standalone, 1.19x margin, and then a TIMEOUT at 300s in the matrix. Round two
// moved the profile-only direction out as well. Both now live in
// "ADR-0047 §6 refuses a profile-only rollback edge by name and leaves a
// source-changing one eligible", and this test is back to the two tenants it
// had before adoption.
//
// THE LESSON IS THE UNIT, not the number: a standalone measurement is not
// evidence about this bound. The prior in-matrix figure was 210.9s at a8c9d07
// against 117.6s standalone — a 1.79x load factor — and 251.1s standalone
// against that factor was never going to fit. Quote the in-matrix figure or
// quote nothing; that is also how the 54.6s figure above went stale.
//
// If this reds on timing again, split again. It is NOT to raise the bound:
// that widens what starvation is permitted to look like, which is the standing
// prohibition this repository carries.
test(
  'composed product activates through the kernel and persists tenant-scoped gateway data',
  { timeout: 300_000 },
  async (context) => {
    await withEphemeralPostgres(
      'g2-p5e-composed-application',
      async ({ connection, pool }) => {
        const compiledApplication = JSON.parse(
          await readFile(compiledArtifactPath, 'utf8'),
        ) as unknown;
        const authoredApplication = JSON.parse(
          await readFile(authoredArtifactPath, 'utf8'),
        ) as unknown;
        assert.deepEqual(
          authoredApplication,
          composedApplicationDefinition(),
          'the checked-in authored artifact is generated from the shared module factories',
        );
        const databaseUrl = connectionUrl(connection);
        const refusedIntermediateRoots: string[] = [];
        let tenantA = await createRuntime(
          compiledApplication,
          databaseUrl,
          'composed-tenant-a',
          undefined,
          async (observation) => {
            await assert.rejects(
              observation.loadActiveRuntimeDefinition,
              (error: unknown) => {
                assert.ok(error instanceof RequestRuntimeViewLoadError);
                assert.equal(error.code, 'ACTIVE_RELEASE_NOT_ADMITTED');
                return true;
              },
            );
            refusedIntermediateRoots.push(observation.releaseRoot);
          },
        );
        const firstTenantLineage =
          parseCompiledApplication(compiledApplication);
        assert.deepEqual(
          refusedIntermediateRoots,
          [firstTenantLineage.bootstrap, ...firstTenantLineage.applications]
            .slice(0, -1)
            .map((release) => release.compiled.releaseRoot),
          'every active intermediate pointer refuses request serving until semantic admission',
        );
        let tenantB: ComposedApplicationRuntime | undefined;
        try {
          assert.equal(tenantA.triggerEnabledDuringActivation, true);
          await assertExactSwapTriggerEnabled(pool);
          await assertRealProductDefinition(tenantA);
          await assertDurableProductEvidence(pool, tenantA);
          await assertBoundedFreshTenantInstallEvidence(
            pool,
            tenantA,
            compiledApplication,
            connection,
          );
          await assertBoundedInstallMatchesFullReplaySchema(pool);
          await context.test(
            'semantic verification keeps constrained-domain probes outside compiled partial uniqueness',
            () =>
              assertConstrainedDomainVerificationCompleted(
                pool,
                connection,
                tenantA,
                compiledApplication,
              ),
          );
          await context.test(
            'a released purchase order refuses every line mutation, and a draft one admits them',
            () =>
              assertPurchaseOrderParentGuard(
                pool,
                tenantA,
                compiledApplication,
              ),
          );
          await context.test(
            'entity-owned create takes its derived legal-entity input through the real operation path',
            () =>
              assertEntityOwnedCreateInput(pool, tenantA, compiledApplication),
          );
          await context.test(
            'verification persists required field references and leaves optional references unset',
            () =>
              assertVerificationFieldOriginCreates(
                pool,
                tenantA,
                compiledApplication,
              ),
          );
          await context.test(
            'registered Inventory posting route commits once and absorbs an identical replay',
            () =>
              assertInventoryPostingCapabilityRoute(
                pool,
                tenantA,
                compiledApplication,
              ),
          );
          await context.test(
            'posting authorization binds authoritative entity scope and preserves committed truth across read revocation',
            () =>
              assertInventoryPostingAuthorizationBoundaries(
                pool,
                tenantA,
                compiledApplication,
              ),
          );
          const recordId = randomUUID();
          const created = await tenantA.entry.run(
            { headers: { authorization: 'local' } },
            (view) =>
              tenantA.operationGateway.invoke(
                view,
                {
                  confirmationGrant: null,
                  idempotencyKey: randomUUID(),
                  input: {
                    recordId,
                    values: {
                      [APPLICATION_IDS.party.fieldIds.contactSummary]:
                        'persisted@example.test',
                      [APPLICATION_IDS.party.fieldIds.name]:
                        'Persistent Browser Party',
                      [APPLICATION_IDS.party.fieldIds.number]: 'P-REAL-001',
                    },
                  },
                  operationId: APPLICATION_IDS.party.createOperationId,
                  schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
                },
                tenantA.operationMediation.issueInvocation(view, 'UI'),
              ),
          );
          assert.equal(created.outcome, 'succeeded');

          const separateRequest = await listParty(tenantA);
          assert.deepEqual(
            separateRequest.records.map((record) => record.recordId),
            [recordId],
            'a separate gateway request reads the committed PostgreSQL row',
          );
          await context.test(
            'current grants enforce allow, read-only, revocation, scope and denial evidence on one pinned runtime',
            () =>
              assertCurrentAuthorizationVertical(
                pool,
                tenantA,
                compiledApplication,
                connection,
              ),
          );
          await context.test(
            'a composed runtime with no verified identity integration fails request entry closed',
            () =>
              assertFailClosedIdentitySeam(
                compiledApplication,
                databaseUrl,
                'composed-tenant-a',
              ),
          );

          await tenantA.close();
          tenantA = await createRuntime(
            compiledApplication,
            databaseUrl,
            'composed-tenant-a',
          );
          const afterRestart = await listParty(tenantA);
          assert.deepEqual(
            afterRestart.records.map((record) => record.recordId),
            [recordId],
            'the row survives composition-root reconstruction',
          );
          await context.test(
            'registered query latency is graded on the real request path',
            (ladderContext) =>
              assertRegisteredQueryLatencyIsGraded(tenantA, ladderContext),
          );
          await context.test(
            'a composed runtime grades a real read by its measured duration',
            () =>
              assertComposedRuntimeGradesByDuration(
                compiledApplication,
                databaseUrl,
              ),
          );

          tenantB = await createRuntime(
            compiledApplication,
            databaseUrl,
            'composed-tenant-b',
          );
          const isolated = await listParty(tenantB);
          assert.equal(isolated.listCoverage?.totalCount, 0);
          assert.deepEqual(isolated.records, []);
          tenantB = await reopenServingRuntime(
            tenantB,
            compiledApplication,
            databaseUrl,
            'composed-tenant-b',
          );
          await context.test(
            'materializer seeding and the provider-written projection stay narrowly scoped across tenants',
            () =>
              assertMaterializerSeedingIsNarrowlyScoped(
                pool,
                connection,
                tenantA,
                tenantB as ComposedApplicationRuntime,
                compiledApplication,
              ),
          );
          await assertApprovalEnforcementAndApprovedActivation(
            tenantA,
            compiledApplication,
            connection,
            pool,
          );
          await assertExactSwapTriggerEnabled(pool);
        } finally {
          await Promise.all([
            tenantA.close(),
            tenantB?.close() ?? Promise.resolve(),
          ]);
        }
      },
    );
  },
);

// Same harness limit: this parent performs one bounded fresh install and then
// verifies and activates compiled successors through the normal upgrade path.
test(
  'composed product advances an existing deployment to an exact compiled successor',
  { timeout: 300_000 },
  async () => {
    await withEphemeralPostgres(
      'g2-1g-release-advancement',
      async ({ connection, pool }) => {
        const compiledApplication = JSON.parse(
          await readFile(compiledArtifactPath, 'utf8'),
        ) as unknown;
        const authoredApplication = JSON.parse(
          await readFile(authoredArtifactPath, 'utf8'),
        ) as Record<string, unknown>;
        const databaseUrl = connectionUrl(connection);
        let runtime = await createRuntime(
          compiledApplication,
          databaseUrl,
          'advancing-tenant',
        );
        try {
          await assertExactSwapTriggerEnabled(pool);
          const sourceReleaseId = runtime.activeReleaseId;
          const recordId = randomUUID();
          const created = await createParty(runtime, recordId, 'P-UPGRADE-001');
          assert.equal(created.outcome, 'succeeded');
          const before = await partyRowSnapshot(
            pool,
            runtime,
            compiledApplication,
            recordId,
          );
          const approvalCandidate = await compileCandidateEnvelope(
            compiledApplication,
            authoredApplication,
            false,
          );
          const candidate = await compileCandidateEnvelope(
            compiledApplication,
            authoredApplication,
            true,
          );
          const mismatched = compileMismatchedEnvelope(
            compiledApplication,
            authoredApplication,
          );
          await runtime.close();

          await assert.rejects(
            createRuntime(mismatched, databaseUrl, 'advancing-tenant'),
            /transition does not match its declared previous release/,
          );
          assert.equal(
            await activeReleaseId(pool, runtime.identity),
            sourceReleaseId,
          );

          await pool.query(
            `ALTER TABLE platform.active_release_pointers
               DISABLE TRIGGER active_release_pointer_exact_swap`,
          );
          try {
            await assert.rejects(
              createRuntime(approvalCandidate, databaseUrl, 'advancing-tenant'),
              /active_release_pointer_exact_swap is not enabled/,
            );
          } finally {
            await pool.query(
              `ALTER TABLE platform.active_release_pointers
                 ENABLE TRIGGER active_release_pointer_exact_swap`,
            );
          }
          await assertExactSwapTriggerEnabled(pool);
          assert.equal(
            await activeReleaseId(pool, runtime.identity),
            sourceReleaseId,
          );

          await assertApprovalRequiredForAdvancement(
            runtime,
            approvalCandidate,
            connection,
            pool,
          );
          assert.equal(
            await activeReleaseId(pool, runtime.identity),
            sourceReleaseId,
          );
          await assertExactSwapTriggerEnabled(pool);

          runtime = await createRuntime(
            candidate,
            databaseUrl,
            'advancing-tenant',
          );
          await assertExactSwapTriggerEnabled(pool);
          assert.notEqual(
            runtime.releaseRoot,
            parseCompiledApplication(compiledApplication).application.compiled
              .releaseRoot,
          );
          const after = await partyRowSnapshot(
            pool,
            runtime,
            candidate,
            recordId,
          );
          assert.deepEqual(
            { ctid: after.ctid, xmin: after.xmin },
            { ctid: before.ctid, xmin: before.xmin },
            'the storage-changing forward transition does not rewrite the existing tuple',
          );
          assertRowRetainsPriorValues(before.row, after.row);
          const rollbackColumn = partyFieldColumn(candidate, rollbackFieldId);
          assert.equal(after.row[rollbackColumn], null);
          const listed = await listParty(runtime);
          assert.deepEqual(
            listed.records.map((record) => record.recordId),
            [recordId],
            'the row written under release A is readable under release B',
          );
          await assertApprovedActivationRecorded(
            pool,
            runtime,
            sourceReleaseId,
          );
          const candidateReleaseId = runtime.activeReleaseId;
          await assertMaterializedReversibleForwardTransition(
            pool,
            sourceReleaseId,
            candidateReleaseId,
          );
          await runtime.close();
          await setLatestForwardTransitionRecoveryMode(
            pool,
            sourceReleaseId,
            candidateReleaseId,
            'forwardOnly',
          );
          try {
            await assert.rejects(
              createRuntime(candidate, databaseUrl, 'advancing-tenant', {
                kind: 'rollback',
                targetReleaseRoot:
                  parseCompiledApplication(compiledApplication).application
                    .compiled.releaseRoot,
              }),
              (error: unknown) => {
                assert.ok(error instanceof ReleaseReverseTransitionRefusal);
                assert.equal(
                  error.code,
                  'ROLLBACK_FORWARD_TRANSITION_NOT_REVERSIBLE',
                );
                return true;
              },
            );
          } finally {
            await setLatestForwardTransitionRecoveryMode(
              pool,
              sourceReleaseId,
              candidateReleaseId,
              'reversible',
            );
          }
          assert.equal(
            await activeReleaseId(pool, runtime.identity),
            candidateReleaseId,
          );
          await assertNoReverseApprovalRecorded(
            pool,
            runtime,
            candidateReleaseId,
            sourceReleaseId,
          );
          await assertReleaseServicesRejectNonExactReversePairs(
            runtime,
            compiledApplication,
            connection,
            pool,
            candidateReleaseId,
            sourceReleaseId,
          );
          await assertExactSwapTriggerEnabled(pool);
          runtime = await createRuntime(
            candidate,
            databaseUrl,
            'advancing-tenant',
            {
              kind: 'rollback',
              targetReleaseRoot:
                parseCompiledApplication(compiledApplication).application
                  .compiled.releaseRoot,
            },
          );
          assert.equal(
            runtime.releaseRoot,
            parseCompiledApplication(compiledApplication).application.compiled
              .releaseRoot,
            'an explicit reverse transition selects the prior immutable release',
          );
          await assertExactSwapTriggerEnabled(pool);
          const afterRollback = await partyRowSnapshot(
            pool,
            runtime,
            candidate,
            recordId,
          );
          assert.deepEqual(
            afterRollback,
            after,
            'rollback leaves the physical tuple and additive storage unchanged',
          );
          assert.deepEqual(
            (await listParty(runtime)).records.map((record) => record.recordId),
            [recordId],
            'release A reads its original row after reversal',
          );
          await assertApprovedReverseActivationRecorded(
            pool,
            runtime,
            candidateReleaseId,
          );
          await assertEmptyRollbackSelectorFailsClosed(
            runtime,
            databaseUrl,
            pool,
          );

          await runtime.close();
          runtime = await createRuntime(
            candidate,
            databaseUrl,
            'advancing-tenant',
          );
          assert.equal(
            runtime.releaseRoot,
            parseCompiledApplication(candidate).application.compiled
              .releaseRoot,
            'the unchanged v2 lineage replays A -> B after rollback',
          );
          await assertExactSwapTriggerEnabled(pool);
          assert.deepEqual(
            await partyRowSnapshot(pool, runtime, candidate, recordId),
            after,
            'fresh v2 replay converges without rewriting the physical tuple',
          );
        } finally {
          await runtime.close();
        }
      },
    );
  },
);

async function assertEmptyRollbackSelectorFailsClosed(
  runtime: ComposedApplicationRuntime,
  databaseUrl: string,
  adminPool: pg.Pool,
): Promise<void> {
  const pointerBefore = await activePointerSnapshot(adminPool, runtime);
  const approvalCountBefore = await totalApprovalCount(adminPool, runtime);
  let unexpectedlyStarted:
    Awaited<ReturnType<typeof startComposedApplication>> | undefined;
  try {
    await assert.rejects(
      async () => {
        unexpectedlyStarted = await startComposedApplication({
          databaseUrl,
          host: '127.0.0.1',
          port: 0,
          rollbackReleaseRoot: '',
          tenantSlug: 'advancing-tenant',
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof ReleaseReverseTransitionRefusal);
        assert.equal(error.code, 'ROLLBACK_TARGET_NOT_IMMEDIATE_PREDECESSOR');
        return true;
      },
    );
  } finally {
    await unexpectedlyStarted?.close();
  }
  assert.deepEqual(
    await activePointerSnapshot(adminPool, runtime),
    pointerBefore,
    'an explicitly empty rollback selector leaves the persisted pointer unchanged',
  );
  assert.equal(
    await totalApprovalCount(adminPool, runtime),
    approvalCountBefore,
    'an explicitly empty rollback selector creates no approval',
  );
}

async function activePointerSnapshot(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
): Promise<Readonly<{ fence: string; releaseId: MintedUuid }>> {
  const result = await pool.query<{
    fence: string;
    release_id: MintedUuid;
  }>(
    `SELECT fence::text AS fence, release_id
       FROM platform.active_release_pointers
      WHERE tenant_id = $1 AND environment_id = $2`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return Object.freeze({ fence: row.fence, releaseId: row.release_id });
}

async function totalApprovalCount(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.release_approvals
      WHERE tenant_id = $1 AND environment_id = $2`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function assertRealProductDefinition(
  runtime: ComposedApplicationRuntime,
): Promise<void> {
  await runtime.entry.run({ headers: { authorization: 'local' } }, (view) => {
    const surfaces = (
      view.projections.surface.payload as {
        surfaces: readonly { surfaceId: string }[];
      }
    ).surfaces.map((surface) => surface.surfaceId);
    // Prior 40 + three writable receipt/request records and one read-only projection.
    assert.equal(surfaces.length, 51);
    for (const local of [
      'goods_receipt',
      'goods_receipt_line',
      'purchase_order_amendment',
      'purchase_order_received',
    ]) {
      for (const role of ['list', 'detail'])
        assert.ok(surfaces.includes(`northstar.app:surface.${local}_${role}`));
      assert.equal(
        surfaces.includes(`northstar.app:surface.${local}_form`),
        local !== 'purchase_order_received',
        'only authored receipt/request records expose a form',
      );
    }
    assert.ok(surfaces.includes(APPLICATION_IDS.party.listSurfaceId));
    assert.ok(surfaces.includes(APPLICATION_IDS.catalog.listSurfaceId));
    assert.ok(surfaces.includes(APPLICATION_IDS.location.listSurfaceId));
    // Purchasing reaches a mounted runtime in full: it is the first module to
    // declare a state machine, so a mounted purchase order form is also the
    // first place `transitionStateEffect` binds to a real surface.
    assert.ok(surfaces.includes(APPLICATION_IDS.purchasing.listSurfaceId));
    assert.ok(surfaces.includes(APPLICATION_IDS.purchasing.lineListSurfaceId));
    assert.ok(surfaces.includes(APPLICATION_IDS.purchasing.detailSurfaceId));
    assert.ok(surfaces.includes(APPLICATION_IDS.purchasing.formSurfaceId));
    // Inventory only reaches a mounted runtime once its emitted-but-
    // unarrangeable verification scenarios are recorded as derivations.
    for (const inventorySurfaceId of [
      'northstar.app:surface.inventory_movement_list',
      'northstar.app:surface.posted_stock_balance_list',
      'northstar.app:surface.inventory_on_hand_lookup',
      'northstar.app:surface.inventory_period_lock_list',
      'northstar.app:surface.inventory_transaction_list',
      'northstar.app:surface.legal_entity_list',
      'northstar.app:surface.stock_count_list',
    ]) {
      assert.ok(
        surfaces.includes(inventorySurfaceId),
        `the composed product mounts ${inventorySurfaceId}`,
      );
    }
  });
}

async function assertApprovalEnforcementAndApprovedActivation(
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
  connection: pg.PoolConfig,
  adminPool: pg.Pool,
): Promise<void> {
  const runtimePool = new pg.Pool({
    ...connection,
    max: 2,
    user: 'north_star_runtime',
  });
  runtimePool.on('error', () => undefined);
  try {
    const context = await new AuthenticatedRequestEntryAdapter(
      async () => runtime.identity,
    ).enter({});
    const revision = await adminPool.query<{ revision_id: MintedUuid }>(
      `SELECT app_package_revision_id AS revision_id
         FROM platform.tenant_releases
        WHERE release_id = $1`,
      [runtime.activeReleaseId],
    );
    const revisionId = revision.rows[0]?.revision_id;
    assert.ok(revisionId);
    const candidateReleaseId = randomUUID() as MintedUuid;
    const application =
      parseCompiledApplication(compiledApplication).application;
    const repository = new PostgresImmutableReleaseRepository(runtimePool);
    const staged = await repository.stageTenantReleaseCandidate(context, {
      appPackageRevisionId: revisionId,
      compiledRelease: application.compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId: candidateReleaseId,
      tenantId: context.tenantId,
    });
    await new PostgresReleaseVerificationService(
      runtimePool,
      INVENTORY_PROVIDER_ERROR_MAPPINGS,
      [
        INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
        RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
      ],
    ).executeSemanticCandidateAndPersist(context, {
      compiledRelease: application.compiled,
      evidenceId: staged.verificationEvidenceId,
      releaseId: candidateReleaseId,
    });
    await repository.registerTenantRelease(context, {
      appPackageRevisionId: revisionId,
      compiledRelease: application.compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId: candidateReleaseId,
      tenantId: context.tenantId,
      verificationEvidenceId: staged.verificationEvidenceId,
    });
    const approverPrincipalId = await currentApproverPrincipal(
      adminPool,
      context.tenantId,
    );
    const approverContext = await new AuthenticatedRequestEntryAdapter(
      async () => ({
        environmentId: context.environmentId,
        principalId: approverPrincipalId,
        tenantId: context.tenantId,
      }),
    ).enter({});
    const target = {
      compiled: application.compiled,
      evidenceId: staged.verificationEvidenceId,
      releaseId: candidateReleaseId,
    };
    const rejectedAttemptId = await prepareAndApproveCandidate(
      runtimePool,
      context,
      approverContext,
      target,
    );
    await assertAttemptTargetsCandidate(
      adminPool,
      rejectedAttemptId,
      candidateReleaseId,
    );
    await assertExactSwapTriggerEnabled(adminPool);

    const systemContext = await new AuthenticatedRequestEntryAdapter(
      async () => ({
        environmentId: runtime.identity.environmentId,
        principalId: SYSTEM_EXECUTION_PRINCIPAL.principalId,
        tenantId: runtime.identity.tenantId,
      }),
    ).enter({});
    const activation = new PostgresReleaseActivationService(runtimePool);
    await setApproverEligibility(
      adminPool,
      context.tenantId,
      approverPrincipalId,
      false,
    );
    const rejected = await activation.activate(systemContext, {
      activationAttemptId: rejectedAttemptId,
    });
    assert.equal(rejected.decisiveOutcomeCode, 'APPROVER_REVOCATION');
    assert.equal(rejected.status, 'NO_SWAP_TERMINAL');
    assert.equal(rejected.releaseId, null);
    assert.equal(
      await activeReleaseId(adminPool, runtime.identity),
      runtime.activeReleaseId,
    );
    await assertExactSwapTriggerEnabled(adminPool);

    await setApproverEligibility(
      adminPool,
      context.tenantId,
      approverPrincipalId,
      true,
    );
    const approvedAttemptId = await prepareAndApproveCandidate(
      runtimePool,
      context,
      approverContext,
      target,
    );
    assert.notEqual(approvedAttemptId, rejectedAttemptId);
    await assertAttemptTargetsCandidate(
      adminPool,
      approvedAttemptId,
      candidateReleaseId,
    );
    await assertExactSwapTriggerEnabled(adminPool);
    const activated = await activation.activate(systemContext, {
      activationAttemptId: approvedAttemptId,
    });
    assert.equal(activated.decisiveOutcomeCode, 'SWAPPED');
    assert.equal(activated.status, 'SWAPPED_VERIFIED');
    assert.equal(activated.releaseId, candidateReleaseId);
    assert.equal(
      await activeReleaseId(adminPool, runtime.identity),
      candidateReleaseId,
    );
    await assertExactSwapTriggerEnabled(adminPool);
  } finally {
    await runtimePool.end();
  }
}

async function assertApprovalRequiredForAdvancement(
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
  connection: pg.PoolConfig,
  adminPool: pg.Pool,
): Promise<void> {
  const runtimePool = new pg.Pool({
    ...connection,
    max: 2,
    user: 'north_star_runtime',
  });
  runtimePool.on('error', () => undefined);
  try {
    const context = await new AuthenticatedRequestEntryAdapter(
      async () => runtime.identity,
    ).enter({});
    const application =
      parseCompiledApplication(compiledApplication).application;
    const candidate = await adminPool.query<{
      app_package_revision_id: MintedUuid;
      release_id: MintedUuid;
      verification_evidence_id: MintedUuid;
    }>(
      `SELECT app_package_revision_id, release_id, verification_evidence_id
         FROM platform.tenant_releases
        WHERE tenant_id = $1
          AND environment_id = $2
          AND content_hash = $3`,
      [
        context.tenantId,
        context.environmentId,
        application.compiled.releaseRoot,
      ],
    );
    const target = candidate.rows[0];
    assert.ok(target, 'the trigger-negative startup staged the real candidate');
    const repository = new PostgresImmutableReleaseRepository(runtimePool);
    if (!(await repository.getTenantRelease(context, target.release_id))) {
      await new PostgresReleaseVerificationService(
        runtimePool,
        INVENTORY_PROVIDER_ERROR_MAPPINGS,
        [
          INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
          RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
        ],
      ).executeSemanticCandidateAndPersist(context, {
        compiledRelease: application.compiled,
        evidenceId: target.verification_evidence_id,
        releaseId: target.release_id,
      });
      await repository.registerTenantRelease(context, {
        appPackageRevisionId: target.app_package_revision_id,
        compiledRelease: application.compiled,
        createdBy: context.principalId,
        environmentId: context.environmentId,
        releaseId: target.release_id,
        tenantId: context.tenantId,
        verificationEvidenceId: target.verification_evidence_id,
      });
    }
    const approverPrincipalId = await currentApproverPrincipal(
      adminPool,
      context.tenantId,
    );
    const approverContext = await new AuthenticatedRequestEntryAdapter(
      async () => ({
        environmentId: context.environmentId,
        principalId: approverPrincipalId,
        tenantId: context.tenantId,
      }),
    ).enter({});
    const rejectedAttemptId = await prepareAndApproveCandidate(
      runtimePool,
      context,
      approverContext,
      {
        compiled: application.compiled,
        evidenceId: target.verification_evidence_id,
        releaseId: target.release_id,
      },
    );
    await assertAttemptTargetsCandidate(
      adminPool,
      rejectedAttemptId,
      target.release_id,
    );
    await setApproverEligibility(
      adminPool,
      context.tenantId,
      approverPrincipalId,
      false,
    );
    const systemContext = await new AuthenticatedRequestEntryAdapter(
      async () => ({
        environmentId: context.environmentId,
        principalId: SYSTEM_EXECUTION_PRINCIPAL.principalId,
        tenantId: context.tenantId,
      }),
    ).enter({});
    const rejected = await new PostgresReleaseActivationService(
      runtimePool,
    ).activate(systemContext, {
      activationAttemptId: rejectedAttemptId,
    });
    assert.equal(rejected.decisiveOutcomeCode, 'APPROVER_REVOCATION');
    assert.equal(rejected.status, 'NO_SWAP_TERMINAL');
    assert.equal(rejected.releaseId, null);
    await assertExactSwapTriggerEnabled(adminPool);
    await setApproverEligibility(
      adminPool,
      context.tenantId,
      approverPrincipalId,
      true,
    );
  } finally {
    await runtimePool.end();
  }
}

async function assertReleaseServicesRejectNonExactReversePairs(
  runtime: ComposedApplicationRuntime,
  previousCompiledApplication: unknown,
  connection: pg.PoolConfig,
  adminPool: pg.Pool,
  sourceReleaseId: MintedUuid,
  immediateTargetReleaseId: MintedUuid,
): Promise<void> {
  const runtimePool = new pg.Pool({
    ...connection,
    max: 2,
    user: 'north_star_runtime',
  });
  runtimePool.on('error', () => undefined);
  try {
    const context = await new AuthenticatedRequestEntryAdapter(
      async () => runtime.identity,
    ).enter({});
    const approverPrincipalId = await currentApproverPrincipal(
      adminPool,
      context.tenantId,
    );
    const approverContext = await new AuthenticatedRequestEntryAdapter(
      async () => ({
        environmentId: context.environmentId,
        principalId: approverPrincipalId,
        tenantId: context.tenantId,
      }),
    ).enter({});
    const systemContext = await new AuthenticatedRequestEntryAdapter(
      async () => ({
        environmentId: context.environmentId,
        principalId: SYSTEM_EXECUTION_PRINCIPAL.principalId,
        tenantId: context.tenantId,
      }),
    ).enter({});
    const previous = parseCompiledApplication(previousCompiledApplication);
    const immediateTarget = await releaseTarget(
      adminPool,
      context,
      immediateTargetReleaseId,
      previous.application.compiled,
    );
    const bootstrapRelease = await releaseTargetForRoot(
      adminPool,
      context,
      previous.bootstrap.compiled.releaseRoot,
      previous.bootstrap.compiled,
    );

    const skippedApprovalCount = await approvalCountForPair(
      adminPool,
      context,
      sourceReleaseId,
      bootstrapRelease.releaseId,
    );
    await assert.rejects(
      prepareAndApproveCandidate(
        runtimePool,
        context,
        approverContext,
        bootstrapRelease,
      ),
      (error: unknown) =>
        assertReverseRefusal(
          error,
          'RELEASE_TRANSITION_NOT_EXACT_LINEAGE_EDGE',
        ),
    );
    assert.equal(
      await approvalCountForPair(
        adminPool,
        context,
        sourceReleaseId,
        bootstrapRelease.releaseId,
      ),
      skippedApprovalCount,
      'approval refuses a skipped B-to-bootstrap lineage edge before writing an approval',
    );

    const outsideReleaseId = randomUUID() as MintedUuid;
    const repository = new PostgresImmutableReleaseRepository(runtimePool);
    const staged = await repository.stageTenantReleaseCandidate(context, {
      appPackageRevisionId: immediateTarget.revisionId,
      compiledRelease: immediateTarget.compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId: outsideReleaseId,
      tenantId: context.tenantId,
    });
    await new PostgresReleaseVerificationService(
      runtimePool,
      INVENTORY_PROVIDER_ERROR_MAPPINGS,
      [
        INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
        RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
      ],
    ).executeSemanticCandidateAndPersist(context, {
      compiledRelease: immediateTarget.compiled,
      evidenceId: staged.verificationEvidenceId,
      releaseId: outsideReleaseId,
    });
    await repository.registerTenantRelease(context, {
      appPackageRevisionId: immediateTarget.revisionId,
      compiledRelease: immediateTarget.compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId: outsideReleaseId,
      tenantId: context.tenantId,
      verificationEvidenceId: staged.verificationEvidenceId,
    });
    const outsideTarget = {
      compiled: immediateTarget.compiled,
      evidenceId: staged.verificationEvidenceId,
      releaseId: outsideReleaseId,
      revisionId: immediateTarget.revisionId,
    };
    await assert.rejects(
      prepareAndApproveCandidate(
        runtimePool,
        context,
        approverContext,
        outsideTarget,
      ),
      (error: unknown) =>
        assertReverseRefusal(error, 'ROLLBACK_FORWARD_ACTIVATION_NOT_VERIFIED'),
    );
    assert.equal(
      await approvalCountForPair(
        adminPool,
        context,
        sourceReleaseId,
        outsideReleaseId,
      ),
      0,
      'approval refuses an admitted release identity outside the activated lineage',
    );

    const activationAttemptId = await prepareAndApproveCandidate(
      runtimePool,
      context,
      approverContext,
      immediateTarget,
    );
    const sourceRevision = await adminPool.query<{
      parent_revision_id: MintedUuid | null;
      revision_id: MintedUuid;
    }>(
      `SELECT revision.revision_id, revision.parent_revision_id
         FROM platform.tenant_releases AS release
         JOIN platform.app_package_revisions AS revision
           ON revision.tenant_id = release.tenant_id
          AND revision.revision_id = release.app_package_revision_id
        WHERE release.tenant_id = $1
          AND release.environment_id = $2
          AND release.release_id = $3`,
      [context.tenantId, context.environmentId, sourceReleaseId],
    );
    const sourceRevisionRow = sourceRevision.rows[0];
    assert.ok(sourceRevisionRow);
    assert.equal(
      sourceRevisionRow.parent_revision_id,
      immediateTarget.revisionId,
      'the activation control starts from the real immediate reverse edge',
    );
    const skippedAncestorRevisionId = randomUUID() as MintedUuid;
    const insertedAncestor = await adminPool.query(
      `INSERT INTO platform.app_package_revisions (
         tenant_id, revision_id, parent_revision_id, schema_version,
         language_version, normalization_profile_version,
         canonicalization_profile_version, hash_algorithm, content_hash,
         desired_state, provenance, created_by
       )
       SELECT tenant_id, $3, revision_id, schema_version, language_version,
              normalization_profile_version,
              canonicalization_profile_version, hash_algorithm, content_hash,
              desired_state, provenance, $4
         FROM platform.app_package_revisions
        WHERE tenant_id = $1 AND revision_id = $2`,
      [
        context.tenantId,
        immediateTarget.revisionId,
        skippedAncestorRevisionId,
        context.principalId,
      ],
    );
    assert.equal(insertedAncestor.rowCount, 1);
    await adminPool.query(
      `ALTER TABLE platform.app_package_revisions
         DISABLE RULE app_package_revisions_reject_update`,
    );
    try {
      const changed = await adminPool.query(
        `UPDATE platform.app_package_revisions
            SET parent_revision_id = $3
          WHERE tenant_id = $1 AND revision_id = $2`,
        [
          context.tenantId,
          sourceRevisionRow.revision_id,
          skippedAncestorRevisionId,
        ],
      );
      assert.equal(changed.rowCount, 1);
      await assert.rejects(
        new PostgresReleaseActivationService(runtimePool).activate(
          systemContext,
          { activationAttemptId },
        ),
        (error: unknown) =>
          assertReverseRefusal(
            error,
            'RELEASE_TRANSITION_NOT_EXACT_LINEAGE_EDGE',
          ),
      );
    } finally {
      await adminPool.query(
        `UPDATE platform.app_package_revisions
            SET parent_revision_id = $3
          WHERE tenant_id = $1 AND revision_id = $2`,
        [
          context.tenantId,
          sourceRevisionRow.revision_id,
          immediateTarget.revisionId,
        ],
      );
      await adminPool.query(
        `ALTER TABLE platform.app_package_revisions
           ENABLE RULE app_package_revisions_reject_update`,
      );
    }
    const immutableRule = await adminPool.query<{ enabled: string }>(
      `SELECT ev_enabled AS enabled
         FROM pg_catalog.pg_rewrite
        WHERE ev_class = 'platform.app_package_revisions'::regclass
          AND rulename = 'app_package_revisions_reject_update'`,
    );
    assert.equal(
      immutableRule.rows[0]?.enabled,
      'O',
      'the immutable revision update rule is restored after the activation control',
    );
    assert.equal(
      await activeReleaseId(adminPool, runtime.identity),
      sourceReleaseId,
      'activation refuses the no-longer-exact pair before swapping the pointer',
    );
    const outcome = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM platform.release_activation_attempt_outcomes
        WHERE activation_attempt_id = $1`,
      [activationAttemptId],
    );
    assert.equal(
      outcome.rows[0]?.count,
      '0',
      'the activation boundary refuses before recording a decisive outcome',
    );
  } finally {
    await runtimePool.end();
  }
}

async function releaseTarget(
  pool: pg.Pool,
  context: TrustedRequestContext,
  releaseId: MintedUuid,
  compiled: ReturnType<
    typeof parseCompiledApplication
  >['application']['compiled'],
): Promise<{
  compiled: ReturnType<
    typeof parseCompiledApplication
  >['application']['compiled'];
  evidenceId: MintedUuid;
  releaseId: MintedUuid;
  revisionId: MintedUuid;
}> {
  const result = await pool.query<{
    app_package_revision_id: MintedUuid;
    release_id: MintedUuid;
    verification_evidence_id: MintedUuid;
  }>(
    `SELECT app_package_revision_id, release_id, verification_evidence_id
       FROM platform.tenant_releases
      WHERE tenant_id = $1
        AND environment_id = $2
        AND release_id = $3`,
    [context.tenantId, context.environmentId, releaseId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return {
    compiled,
    evidenceId: row.verification_evidence_id,
    releaseId: row.release_id,
    revisionId: row.app_package_revision_id,
  };
}

async function releaseTargetForRoot(
  pool: pg.Pool,
  context: TrustedRequestContext,
  releaseRoot: string,
  compiled: ReturnType<
    typeof parseCompiledApplication
  >['application']['compiled'],
): ReturnType<typeof releaseTarget> {
  const result = await pool.query<{ release_id: MintedUuid }>(
    `SELECT release_id
       FROM platform.tenant_releases
      WHERE tenant_id = $1
        AND environment_id = $2
        AND content_hash = $3
      ORDER BY created_at, release_id
      LIMIT 1`,
    [context.tenantId, context.environmentId, releaseRoot],
  );
  const releaseId = result.rows[0]?.release_id;
  assert.ok(releaseId);
  return releaseTarget(pool, context, releaseId, compiled);
}

async function approvalCountForPair(
  pool: pg.Pool,
  context: TrustedRequestContext,
  sourceReleaseId: MintedUuid,
  targetReleaseId: MintedUuid,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.release_approvals
      WHERE tenant_id = $1
        AND environment_id = $2
        AND expected_release_id = $3
        AND target_release_id = $4`,
    [context.tenantId, context.environmentId, sourceReleaseId, targetReleaseId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

function assertReverseRefusal(
  error: unknown,
  code:
    | 'RELEASE_TRANSITION_NOT_EXACT_LINEAGE_EDGE'
    | 'ROLLBACK_FORWARD_ACTIVATION_NOT_VERIFIED',
): true {
  assert.ok(error instanceof ReleaseReverseTransitionRefusal);
  assert.equal(error.code, code);
  return true;
}

async function prepareAndApproveCandidate(
  pool: pg.Pool,
  context: TrustedRequestContext,
  approverContext: TrustedRequestContext,
  target: Readonly<{
    compiled: ReturnType<
      typeof parseCompiledApplication
    >['application']['compiled'];
    evidenceId: MintedUuid;
    releaseId: MintedUuid;
  }>,
): Promise<MintedUuid> {
  const pointer = await withTrustedRequestTransaction(
    pool,
    context,
    async (client) => {
      const result = await client.query<{
        content_hash: string;
        fence: string;
        pointer_id: MintedUuid;
        release_id: MintedUuid;
      }>(
        `SELECT pointer.pointer_id,
                pointer.release_id,
                pointer.fence,
                release.content_hash
           FROM platform.active_release_pointers AS pointer
           JOIN platform.tenant_releases AS release
             ON release.tenant_id = pointer.tenant_id
            AND release.environment_id = pointer.environment_id
            AND release.release_id = pointer.release_id
          WHERE pointer.tenant_id = $1 AND pointer.environment_id = $2`,
        [context.tenantId, context.environmentId],
      );
      const row = result.rows[0];
      assert.ok(row);
      return row;
    },
  );
  const preparationId = randomUUID() as MintedUuid;
  const receiptId = randomUUID() as MintedUuid;
  const sourceRoot = Buffer.from(pointer.content_hash, 'hex');
  const targetRoot = Buffer.from(target.compiled.releaseRoot, 'hex');

  await withTrustedRequestTransaction(pool, context, async (client) => {
    const evidence = await client.query<{
      evidence_version: string;
      result_set_digest: string;
    }>(
      `SELECT evidence_version, result_set_digest
         FROM (
           SELECT evidence_version, result_set_digest
             FROM platform.release_verification_evidence
            WHERE verification_evidence_id = $1
           UNION ALL
           SELECT evidence_version, evidence_digest AS result_set_digest
             FROM platform.fresh_tenant_intermediate_release_admissions
            WHERE release_evidence_id = $1
              AND NOT EXISTS (
                SELECT 1
                  FROM platform.release_verification_evidence
                 WHERE verification_evidence_id = $1
              )
         ) AS release_evidence`,
      [target.evidenceId],
    );
    const verified = evidence.rows.length === 1 ? evidence.rows[0] : undefined;
    assert.ok(verified);
    await client.query(
      `INSERT INTO platform.transition_preparation_receipts (
         tenant_id, environment_id, receipt_id, receipt_version,
         source_release_id, source_manifest_root, target_release_id,
         target_manifest_root, transition_scope, storage_domain_id,
         schema_generation, compiler_facts_version, compiler_facts_digest,
         compiler_transition_class, compiler_static_compatibility,
         compiler_exact_pair, executor_evidence_version,
         executor_evidence_digest, executor_applied_state, executor_exact_pair,
         compatibility_policy_version, compatibility_policy_verdict,
         recovery_mode
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,'tenantLocal','tenant-primary-storage',$9,
         $10,$11,'NO_STORAGE_TRANSITION','SATISFIED',true,$12,$13,
         'NOT_REQUIRED',true,$14,'ALLOW','NO_STORAGE_RECOVERY_REQUIRED'
       )`,
      [
        context.tenantId,
        context.environmentId,
        receiptId,
        TRANSITION_PREPARATION_RECEIPT_VERSION,
        pointer.release_id,
        sourceRoot,
        target.releaseId,
        targetRoot,
        pointer.fence,
        COMPILER_TRANSITION_FACTS_VERSION,
        digest('candidate-compiler-facts', target.releaseId),
        EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
        digest('candidate-executor-evidence', target.releaseId),
        TRANSITION_COMPATIBILITY_POLICY_VERSION,
      ],
    );
    await client.query(
      `INSERT INTO platform.release_activation_preparations (
         tenant_id, environment_id, preparation_id, preparation_version,
         expected_pointer_id, expected_release_id, expected_fence,
         source_manifest_root, target_release_id, target_manifest_root,
         diff_binding_kind, diff_binding_version, release_diff_version,
         release_diff_algorithm_version, canonical_diff_digest,
         transition_plan_digest, compiler_attestation_digest, compiler_version,
         compiler_semantic_profile_version, compiler_output_protocol_version,
         verification_evidence_id, verification_evidence_version,
         verification_evidence_digest, capability_support_version,
         capability_support_digest, capability_support_result, renderer_version,
         view_schema_version, rendered_diff_evidence_digest,
         transition_preparation_receipt_id
       ) VALUES (
         $1,$2,$3,'northstar.release-activation-preparation/v1',$4,$5,$6,$7,$8,
         $9,'RELEASE_DIFF',$10,'northstar.release-diff/v0-experimental',
         'northstar.release-diff-algorithm/v1',$11,NULL,$12,$13,$14,$15,$16,
         $17,$18,
         'northstar.capability-support/v1',$19,'SUPPORTED',
         'northstar.release-diff-renderer/v1','northstar.release-diff-view/v1',
         $20,$21
       )`,
      [
        context.tenantId,
        context.environmentId,
        preparationId,
        pointer.pointer_id,
        pointer.release_id,
        pointer.fence,
        sourceRoot,
        target.releaseId,
        targetRoot,
        RELEASE_DIFF_BINDING_VERSION,
        digest('candidate-canonical-diff', target.releaseId),
        Buffer.from(target.compiled.attestation.attestationDigest, 'hex'),
        target.compiled.bundle.releaseManifest.compilerVersion,
        target.compiled.bundle.releaseManifest.compilerSemanticProfileVersion,
        target.compiled.bundle.releaseManifest.outputProtocolVersion,
        target.evidenceId,
        verified.evidence_version,
        Buffer.from(verified.result_set_digest, 'hex'),
        digest('candidate-capability-support', target.releaseId),
        digest('candidate-rendered-diff', target.releaseId),
        receiptId,
      ],
    );
  });

  const activationAttemptId = randomUUID() as MintedUuid;
  const created = await new PostgresReleaseApprovalService(pool).createApproval(
    approverContext,
    {
      activationAttemptId,
      approvalId: randomUUID() as MintedUuid,
      approvingHumanId: approverContext.principalId,
      initiatingHumanId: context.principalId,
      issuingActorId: approverContext.principalId,
      preparationId,
      targetReleaseId: target.releaseId,
    },
  );
  assert.equal(created.approval.targetReleaseId, target.releaseId);
  return created.attempt.activationAttemptId;
}

async function currentApproverPrincipal(
  pool: pg.Pool,
  tenantId: string,
): Promise<string> {
  const result = await pool.query<{ principal_id: string }>(
    `SELECT principal_id
       FROM (
         SELECT DISTINCT ON (principal_id) principal_id, eligible
           FROM platform.release_approver_eligibility_events
          WHERE tenant_id = $1
          ORDER BY principal_id, policy_version DESC
       ) AS current_approver
      WHERE eligible
      ORDER BY principal_id
      LIMIT 1`,
    [tenantId],
  );
  const principalId = result.rows[0]?.principal_id;
  assert.ok(principalId);
  return principalId;
}

async function setApproverEligibility(
  pool: pg.Pool,
  tenantId: string,
  principalId: string,
  eligible: boolean,
): Promise<void> {
  await pool.query(
    'SELECT platform.set_release_approver_eligibility($1,$2,$3,$4,$5)',
    [tenantId, principalId, eligible, randomUUID(), randomUUID()],
  );
}

async function assertAttemptTargetsCandidate(
  pool: pg.Pool,
  activationAttemptId: MintedUuid,
  candidateReleaseId: MintedUuid,
): Promise<void> {
  const result = await pool.query<{
    activation_attempt_id: MintedUuid;
    target_release_id: MintedUuid;
  }>(
    `SELECT attempt.activation_attempt_id, approval.target_release_id
       FROM platform.release_activation_attempts AS attempt
       JOIN platform.release_approvals AS approval
         ON approval.tenant_id = attempt.tenant_id
        AND approval.environment_id = attempt.environment_id
        AND approval.approval_id = attempt.approval_id
        AND approval.activation_attempt_id = attempt.activation_attempt_id
      WHERE attempt.activation_attempt_id = $1`,
    [activationAttemptId],
  );
  assert.deepEqual(result.rows[0], {
    activation_attempt_id: activationAttemptId,
    target_release_id: candidateReleaseId,
  });
}

/**
 * The package revision a release is persisted against. Same shape as
 * `activeReleaseId` and the same column the trigger-negative path reads; two
 * releases sharing one revision is the persisted fact that makes an edge a
 * same-revision edge, and it is observable rather than inferable from bytes.
 */
async function persistedRevisionId(
  pool: pg.Pool,
  identity: ComposedApplicationRuntime['identity'],
  releaseRoot: string,
): Promise<MintedUuid> {
  const result = await pool.query<{ app_package_revision_id: MintedUuid }>(
    `SELECT app_package_revision_id
       FROM platform.tenant_releases
      WHERE tenant_id = $1 AND environment_id = $2 AND content_hash = $3`,
    [identity.tenantId, identity.environmentId, releaseRoot],
  );
  // Exactly one, asserted rather than assumed. This query has no ORDER BY,
  // while production resolves a release root with `ORDER BY created_at LIMIT 1`
  // -- so under a duplicate-root state `rows[0]` could silently observe a
  // different release than production would, and the comparison built on it
  // would be meaningless while still passing.
  assert.equal(
    result.rows.length,
    1,
    `expected exactly one persisted tenant release for ${releaseRoot}, found ${String(result.rows.length)}`,
  );
  const revisionId = result.rows[0]?.app_package_revision_id;
  assert.ok(revisionId, `no persisted tenant release for ${releaseRoot}`);
  return revisionId;
}

async function activeReleaseId(
  pool: pg.Pool,
  identity: ComposedApplicationRuntime['identity'],
): Promise<MintedUuid> {
  const result = await pool.query<{ release_id: MintedUuid }>(
    `SELECT release_id
       FROM platform.active_release_pointers
      WHERE tenant_id = $1 AND environment_id = $2`,
    [identity.tenantId, identity.environmentId],
  );
  const releaseId = result.rows[0]?.release_id;
  assert.ok(releaseId);
  return releaseId;
}

function digest(label: string, ...values: string[]): Buffer {
  const hash = createHash('sha256').update(
    'northstar.composed-application-review-control/v1\0',
  );
  hash.update(label);
  for (const value of values) hash.update('\0').update(value);
  return hash.digest();
}

/**
 * The ladder, graded against a real compiled Party list query, a real
 * PostgreSQL, and the forced-RLS runtime role — not an injected clock.
 *
 * It deliberately asserts no latency threshold. `runtime-slos.md` records that
 * latency is evidence while the executable gate observes something else; here
 * the executable facts are that every real invocation is graded into exactly
 * one ADR-0032 band and that the composed monotonic source produced no sample
 * the recorder had to refuse. The observed distribution is emitted as a
 * diagnostic so a single-host reference can be read out of a matrix log.
 */
async function assertRegisteredQueryLatencyIsGraded(
  runtime: ComposedApplicationRuntime,
  context: TestContext,
): Promise<void> {
  const invocations = 20;
  const before = gradedInvocationCount(runtime.metrics.snapshot());
  const startedAt = monotonicMilliseconds();
  for (let ordinal = 0; ordinal < invocations; ordinal += 1) {
    await listParty(runtime);
  }
  const elapsedMilliseconds = monotonicMilliseconds() - startedAt;
  const snapshot = runtime.metrics.snapshot();

  assert.equal(
    gradedInvocationCount(snapshot) - before,
    invocations,
    'every real registered-query invocation is graded into exactly one band',
  );
  assert.deepEqual(
    snapshot.queryLatencyRejections,
    [],
    'the composed monotonic source produced no sample the recorder had to refuse',
  );
  for (const [key] of snapshot.queryLatency) {
    const band = key.split('|').at(-1) ?? '';
    assert.ok(
      (FEEDBACK_LADDER_BANDS as readonly string[]).includes(band),
      `${band} is not an ADR-0032 §1 band`,
    );
  }
  context.diagnostic(
    `REGISTERED_QUERY_LADDER_OBSERVATION ${JSON.stringify({
      bands: snapshot.queryLatency,
      invocations,
      meanMilliseconds: elapsedMilliseconds / invocations,
      totalMilliseconds: elapsedMilliseconds,
    })}`,
  );
}

/**
 * Fix 2 on the composed path, not on the instrumentation object alone. The
 * runtime is composed against the already-installed tenant with a clock the
 * test steps across ADR-0032's 400 ms boundary, so a composition that dropped
 * the duration — or a source frozen at a constant — cannot turn two identical
 * reads into two different bands. No sleep is involved; the clock is injected,
 * per AGENTS.md §6.
 */
async function assertComposedRuntimeGradesByDuration(
  compiledApplication: unknown,
  databaseUrl: string,
): Promise<void> {
  const readings = [0, 399.5, 1_000, 1_400.5];
  let read = 0;
  const runtime = await createRuntime(
    compiledApplication,
    databaseUrl,
    'composed-tenant-a',
    undefined,
    undefined,
    () => {
      const next = readings[read];
      assert.notEqual(next, undefined, 'the composed clock was over-read');
      read += 1;
      return next!;
    },
  );
  try {
    await listParty(runtime);
    await listParty(runtime);
    assert.equal(read, readings.length, 'two clock reads per invocation');
    assert.deepEqual(
      runtime.metrics.snapshot().queryLatency,
      [
        ['answered|100ms_400ms', 1],
        ['answered|400ms_1s', 1],
      ],
      'identical composed reads land in different bands because the clock moved',
    );
  } finally {
    await runtime.close();
  }
}

function gradedInvocationCount(snapshot: MetricSnapshot): number {
  return snapshot.queryLatency.reduce((total, [, count]) => total + count, 0);
}

function listParty(runtime: ComposedApplicationRuntime) {
  return runtime.entry.run(
    { headers: { authorization: 'local' } },
    (view: RequestRuntimeView) =>
      runtime.queryGateway.invoke(view, {
        arguments: {
          includeArchived: false,
          list: {
            cursor: null,
            matchMode: 'substring',
            pageSize: 100,
            relationLabels: [],
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            search: '',
            sort: [],
          },
        },
        queryId: APPLICATION_IDS.party.listQueryId,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      }),
  );
}

function createParty(
  runtime: ComposedApplicationRuntime,
  recordId: string,
  number: string,
) {
  return runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
    runtime.operationGateway.invoke(
      view,
      {
        confirmationGrant: null,
        idempotencyKey: randomUUID(),
        input: {
          recordId,
          values: {
            [APPLICATION_IDS.party.fieldIds.contactSummary]:
              'upgrade@example.test',
            [APPLICATION_IDS.party.fieldIds.name]: 'Upgrade-safe Party',
            [APPLICATION_IDS.party.fieldIds.number]: number,
          },
        },
        operationId: APPLICATION_IDS.party.createOperationId,
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      },
      runtime.operationMediation.issueInvocation(view, 'UI'),
    ),
  );
}

async function assertCurrentAuthorizationVertical(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
  connection: pg.PoolConfig,
): Promise<void> {
  assert.equal(runtime.identityMode, 'LOCAL_DEMO');
  const scope = [runtime.identity.tenantId, runtime.identity.environmentId];
  const role = await pool.query<{ role_id: string }>(
    `SELECT role_id
       FROM platform.current_policy_roles
      WHERE tenant_id = $1 AND environment_id = $2
        AND role_key = 'local-demo-full-release'`,
    scope,
  );
  const roleId = role.rows[0]?.role_id;
  assert.ok(roleId);
  const membership = await pool.query<{ membership_id: string }>(
    `SELECT membership_id
       FROM platform.current_policy_memberships
      WHERE tenant_id = $1 AND environment_id = $2
        AND principal_id = $3 AND role_id = $4`,
    [...scope, runtime.identity.principalId, roleId],
  );
  const membershipId = membership.rows[0]?.membership_id;
  assert.ok(membershipId);
  const deniedBefore = await deniedInvocationCount(pool, runtime);
  const allowedRecordId = randomUUID();
  const partyCreatePermission = 'northstar.app:permission.party_create';
  const partyReadPermission = 'northstar.app:permission.party_read';
  const inventoryScopeParameter =
    'northstar.app:parameter.inventory_transaction_list_legal_entity_scope';
  const inventoryList = (selectedEntityId: string) =>
    runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
      runtime.queryGateway.invoke(view, {
        arguments: {
          [inventoryScopeParameter]: selectedEntityId,
          includeArchived: false,
          list: {
            cursor: null,
            matchMode: 'substring',
            pageSize: 10,
            relationLabels: [],
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            search: '',
            sort: [],
          },
        },
        queryId: 'northstar.app:query.inventory_transaction_list',
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      }),
    );
  const currentPolicyPool = new pg.Pool({
    ...connection,
    max: 2,
    user: 'north_star_runtime',
  });
  currentPolicyPool.on('error', () => undefined);
  const currentPolicy = new PostgresCurrentPolicyGateway(
    currentPolicyPool,
    currentPolicyBindingsFromPermissions(
      composedApplicationDefinition().permissions as readonly Readonly<{
        action: string;
        permissionId: string;
        resource: { targetId: string };
      }>[],
    ),
  );
  const restorePolicy = async () => {
    await pool.query(
      `UPDATE platform.current_policy_permission_grants
          SET revoked_at = NULL
        WHERE tenant_id = $1 AND environment_id = $2 AND role_id = $3`,
      [...scope, roleId],
    );
    await pool.query(
      `UPDATE platform.current_policy_memberships
          SET legal_entity_id = NULL, revoked_at = NULL
        WHERE tenant_id = $1 AND environment_id = $2 AND membership_id = $3`,
      [...scope, membershipId],
    );
  };
  const setGrant = (permissionId: string, revoked: boolean) =>
    pool.query(
      `UPDATE platform.current_policy_permission_grants
          SET revoked_at = CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END
        WHERE tenant_id = $1 AND environment_id = $2 AND role_id = $3
          AND permission_id = $4`,
      [...scope, roleId, permissionId, revoked],
    );
  const invokePartyOnView = (
    view: RequestRuntimeView,
    recordId: string,
    number: string,
  ) =>
    runtime.operationGateway.invoke(
      view,
      {
        confirmationGrant: null,
        idempotencyKey: randomUUID(),
        input: {
          recordId,
          values: {
            [APPLICATION_IDS.party.fieldIds.contactSummary]:
              'authorization@example.test',
            [APPLICATION_IDS.party.fieldIds.name]: 'Authorization Party',
            [APPLICATION_IDS.party.fieldIds.number]: number,
          },
        },
        operationId: APPLICATION_IDS.party.createOperationId,
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      },
      runtime.operationMediation.issueInvocation(view, 'UI'),
    );

  try {
    // The same request view keeps its release pin while the live grant changes.
    const revokedRecordId = randomUUID();
    await runtime.entry.run(
      { headers: { authorization: 'local' } },
      async (view) => {
        const allowed = await invokePartyOnView(
          view,
          allowedRecordId,
          `AUTH-ALLOW-${randomUUID().slice(0, 8)}`,
        );
        assert.equal(allowed.outcome, 'succeeded');
        await setGrant(partyCreatePermission, true);
        await assert.rejects(
          invokePartyOnView(view, revokedRecordId, 'AUTH-REVOKED'),
          (error: unknown) =>
            error instanceof SemanticOperationPolicyDeniedError,
          'revocation must apply to an already-issued, release-pinned view',
        );
      },
    );
    assert.equal(
      await businessRecordCount(
        pool,
        runtime,
        compiledApplication,
        revokedRecordId,
      ),
      0,
      'the denied write left business data unchanged',
    );

    // A read-only role retains reads while every application mutation is denied.
    await setGrant(partyCreatePermission, false);
    await pool.query(
      `UPDATE platform.current_policy_permission_grants
          SET revoked_at = clock_timestamp()
        WHERE tenant_id = $1 AND environment_id = $2 AND role_id = $3
          AND permission_id LIKE 'northstar.app:permission.%'
          AND permission_id NOT LIKE '%\\_read' ESCAPE '\\'`,
      [...scope, roleId],
    );
    await listParty(runtime);
    await assert.rejects(
      createParty(runtime, randomUUID(), 'AUTH-READ-ONLY'),
      (error: unknown) => error instanceof SemanticOperationPolicyDeniedError,
    );
    await restorePolicy();

    // A relation label has its target query authorized independently.
    await setGrant(partyReadPermission, true);
    await assert.rejects(
      runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
        runtime.queryGateway.invoke(view, {
          arguments: {
            includeArchived: false,
            list: {
              cursor: null,
              matchMode: 'substring',
              pageSize: 10,
              relationLabels: [
                {
                  fieldId: APPLICATION_IDS.party.fieldIds.name,
                  queryId: APPLICATION_IDS.party.listQueryId,
                  relationId: 'northstar.app:relation.party_role_party',
                },
              ],
              schemaVersion: SHARED_LIST_QUERY_VERSION,
              search: '',
              sort: [],
            },
          },
          queryId: 'northstar.app:query.party_role_list',
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        }),
      ),
      (error: unknown) => error instanceof SemanticQueryPolicyDeniedError,
    );
    await setGrant(partyReadPermission, false);

    // Scope issuance and revalidation are live permission checks of their own.
    // Each denial is translated at the query boundary and recorded once before
    // the provider can execute.
    const legalEntityId = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
    await setGrant(LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID, true);
    const issuanceDeniedBefore = await deniedInvocationCount(pool, runtime);
    await assert.rejects(
      inventoryList(legalEntityId),
      (error: unknown) => error instanceof SemanticQueryPolicyDeniedError,
    );
    await assertSingleQueryDenial(
      pool,
      runtime,
      issuanceDeniedBefore,
      'northstar.app:query.inventory_transaction_list',
    );
    await setGrant(LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID, false);
    await runtime.entry.run(
      { headers: { authorization: 'local' } },
      async (view) => {
        const issuedScope = await issueLegalEntityReadScope(
          currentPolicy,
          view,
          [legalEntityId],
        );
        await setGrant(LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID, true);
        const revalidationDeniedBefore = await deniedInvocationCount(
          pool,
          runtime,
        );
        await assert.rejects(
          runtime.queryGateway.invoke(
            view,
            {
              arguments: {
                includeArchived: false,
                list: {
                  cursor: null,
                  matchMode: 'substring',
                  pageSize: 10,
                  relationLabels: [],
                  schemaVersion: SHARED_LIST_QUERY_VERSION,
                  search: '',
                  sort: [],
                },
              },
              queryId: APPLICATION_IDS.party.listQueryId,
              schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            },
            { legalEntityReadScope: issuedScope },
          ),
          (error: unknown) => error instanceof SemanticQueryPolicyDeniedError,
        );
        await assertSingleQueryDenial(
          pool,
          runtime,
          revalidationDeniedBefore,
          APPLICATION_IDS.party.listQueryId,
        );
      },
    );
    await setGrant(LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID, false);

    // A scoped membership may use its entity and cannot widen it through a
    // query operand or an operation input.
    const foreignLegalEntityId = randomUUID();
    await pool.query(
      `UPDATE platform.current_policy_memberships
          SET legal_entity_id = $4
        WHERE tenant_id = $1 AND environment_id = $2 AND membership_id = $3`,
      [...scope, membershipId, legalEntityId],
    );
    await inventoryList(legalEntityId);
    await assert.rejects(
      inventoryList(foreignLegalEntityId),
      (error: unknown) => error instanceof SemanticQueryPolicyDeniedError,
    );
    const scopedWriteRecordId = randomUUID();
    await assert.rejects(
      invokeInventoryTransactionCreate(
        runtime,
        scopedWriteRecordId,
        foreignLegalEntityId,
      ),
      (error: unknown) => error instanceof SemanticOperationPolicyDeniedError,
    );
    assert.equal(
      await businessRecordCount(
        pool,
        runtime,
        compiledApplication,
        scopedWriteRecordId,
        'northstar.app:entity.inventory_transaction',
      ),
      0,
    );
    await assert.rejects(
      inventoryList('caller-supplied-invalid-entity'),
      (error: unknown) => error instanceof SemanticQueryPolicyDeniedError,
    );
    await restorePolicy();

    // Revoking membership denies at the boundary even though all grants remain.
    await pool.query(
      `UPDATE platform.current_policy_memberships
          SET revoked_at = clock_timestamp()
        WHERE tenant_id = $1 AND environment_id = $2 AND membership_id = $3`,
      [...scope, membershipId],
    );
    await assert.rejects(
      listParty(runtime),
      (error: unknown) => error instanceof SemanticQueryPolicyDeniedError,
    );
    await restorePolicy();

    for (const header of [
      'x-tenant-id',
      'x-environment-id',
      'x-principal-id',
      'x-legal-entity-id',
    ]) {
      await assert.rejects(
        runtime.entry.run(
          { headers: { authorization: 'local', [header]: randomUUID() } },
          async () => undefined,
        ),
        `${header} must not widen the sealed identity`,
      );
    }

    const deniedAfter = await deniedInvocationCount(pool, runtime);
    assert.ok(
      deniedAfter - deniedBefore >= 7,
      'every denied query and operation must record trust evidence',
    );
    const evidence = await pool.query<{
      metadata: unknown;
      policy_decision: string;
      policy_inputs: unknown;
    }>(
      `SELECT metadata, policy_decision, policy_inputs
         FROM platform.trust_action_invocations
        WHERE tenant_id = $1 AND environment_id = $2 AND outcome = 'DENIED'
        ORDER BY recorded_at DESC
        LIMIT 7`,
      scope,
    );
    assert.ok(
      evidence.rows.length >= 7,
      'recorded denial evidence must remain queryable through the trust store',
    );
    assert.ok(evidence.rows.every((row) => row.policy_decision === 'DENY'));
    assert.ok(
      evidence.rows.every(
        (row) =>
          !JSON.stringify([row.metadata, row.policy_inputs]).includes(
            'authorization@example.test',
          ),
      ),
      'denial evidence must not persist business inputs or credentials',
    );
  } finally {
    await restorePolicy();
    await currentPolicyPool.end();
    if (
      (await businessRecordCount(
        pool,
        runtime,
        compiledApplication,
        allowedRecordId,
      )) === 1
    ) {
      const archiveOperationId = 'northstar.app:operation.party_archive';
      const archiveInput = { expectedRevision: 1, recordId: allowedRecordId };
      await runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
        runtime.operationGateway.invoke(
          view,
          {
            confirmationGrant:
              runtime.operationMediation.issueConfirmationGrant(
                view,
                archiveOperationId,
                archiveInput,
              ),
            idempotencyKey: randomUUID(),
            input: archiveInput,
            operationId: archiveOperationId,
            schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
          },
          runtime.operationMediation.issueInvocation(view, 'UI'),
        ),
      );
    }
  }
}

async function assertFailClosedIdentitySeam(
  compiledApplication: unknown,
  databaseUrl: string,
  tenantSlug: string,
): Promise<void> {
  const runtime = await createComposedApplicationRuntime({
    capabilityOperationExecutorFactories: [
      INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
      RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
    ],
    compiledApplication,
    databaseUrl,
    inventoryScopeProvisioning: COMPOSED_APPLICATION_INVENTORY_SCOPE,
    migrationsDirectory,
    providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
    tenantSlug,
  });
  try {
    assert.equal(runtime.identityMode, 'FAIL_CLOSED');
    await assert.rejects(
      runtime.entry.run({ headers: { authorization: 'unverified' } }, () =>
        Promise.resolve('must-not-run'),
      ),
      /authenticated request identity is required/u,
    );
  } finally {
    await runtime.close();
  }
}

function invokeInventoryTransactionCreate(
  runtime: ComposedApplicationRuntime,
  recordId: string,
  legalEntityId: string,
) {
  return runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
    runtime.operationGateway.invoke(
      view,
      {
        confirmationGrant: null,
        idempotencyKey: randomUUID(),
        input: {
          legalEntityId,
          recordId,
          relations: {},
          values: {
            'northstar.app:field.inventory_transaction_actor_id': 'auth-test',
            'northstar.app:field.inventory_transaction_effective_at':
              '2026-09-04T12:00:00.000Z',
            'northstar.app:field.inventory_transaction_number': `AUTH-SCOPE-${recordId.slice(0, 8)}`,
            'northstar.app:field.inventory_transaction_recorded_at':
              '2026-09-04T12:00:00.000Z',
            'northstar.app:field.inventory_transaction_source_id': 'auth-test',
            'northstar.app:field.inventory_transaction_source_type': 'test',
            'northstar.app:field.inventory_transaction_state':
              'northstar.app:option.inventory_transaction_state_draft',
            'northstar.app:field.inventory_transaction_type':
              'northstar.app:option.inventory_transaction_type_adjustment',
          },
        },
        operationId: 'northstar.app:operation.inventory_transaction_create',
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      },
      runtime.operationMediation.issueInvocation(view, 'UI'),
    ),
  );
}

async function deniedInvocationCount(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.trust_action_invocations
      WHERE tenant_id = $1 AND environment_id = $2 AND outcome = 'DENIED'`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function assertSingleQueryDenial(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  before: number,
  queryId: string,
): Promise<void> {
  assert.equal(await deniedInvocationCount(pool, runtime), before + 1);
  const result = await pool.query<{
    action_id: string;
    failure_code: string;
    metadata: unknown;
    policy_inputs: unknown;
    policy_version: string;
  }>(
    `SELECT action_id, failure_code, metadata, policy_inputs, policy_version
       FROM platform.trust_action_invocations
      WHERE tenant_id = $1 AND environment_id = $2 AND outcome = 'DENIED'
      ORDER BY recorded_at DESC, invocation_id DESC
      LIMIT 1`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  assert.equal(result.rows[0]?.action_id, queryId);
  assert.equal(result.rows[0]?.failure_code, 'SEMANTIC_QUERY_POLICY_DENIED');
  const epoch = await pool.query<{ policy_version: string }>(
    `SELECT policy_version::text AS policy_version
       FROM platform.current_policy_epochs
      WHERE tenant_id = $1 AND environment_id = $2`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  assert.equal(
    result.rows[0]?.policy_version,
    `northstar.current-policy/${epoch.rows[0]?.policy_version ?? '0'}`,
  );
  const recorded = JSON.stringify([
    result.rows[0]?.metadata,
    result.rows[0]?.policy_inputs,
  ]);
  assert.doesNotMatch(recorded, /authorization|legalEntityId|Bearer/iu);
}

async function businessRecordCount(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
  recordId: string,
  entityId: string = 'northstar.app:entity.party',
): Promise<number> {
  const storage = storageTarget(
    parseCompiledApplication(compiledApplication).application.compiled,
  );
  const entity = storage.entities.find(
    (candidate) => candidate.entityId === entityId,
  );
  assert.ok(entity);
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM north_star_module.${entity.physicalTableName}
      WHERE tenant_id = $1 AND environment_id = $2
        AND "${entity.recordIdentity.column}" = $3`,
    [runtime.identity.tenantId, runtime.identity.environmentId, recordId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function partyRowSnapshot(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
  recordId: string,
): Promise<
  Readonly<{ ctid: string; row: Record<string, unknown>; xmin: string }>
> {
  const storage = storageTarget(
    parseCompiledApplication(compiledApplication).application.compiled,
  );
  const party = storage.entities.find(
    (entity) => entity.entityId === 'northstar.app:entity.party',
  );
  assert.ok(party);
  assert.match(party.physicalTableName, /^nsm_t_[a-z2-7]+$/);
  const result = await pool.query<{
    ctid: string;
    row: Record<string, unknown>;
    xmin: string;
  }>(
    `SELECT ctid::text AS ctid,
            to_jsonb(stored_row) AS row,
            xmin::text AS xmin
       FROM north_star_module.${party.physicalTableName} AS stored_row
      WHERE tenant_id = $1 AND environment_id = $2 AND record_id = $3`,
    [runtime.identity.tenantId, runtime.identity.environmentId, recordId],
  );
  const snapshot = result.rows[0];
  assert.ok(snapshot);
  return snapshot;
}

function assertRowRetainsPriorValues(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): void {
  assert.deepEqual(
    Object.fromEntries(Object.keys(before).map((key) => [key, after[key]])),
    before,
    'every pre-transition physical column retains its exact value',
  );
}

function partyFieldColumn(
  compiledApplication: unknown,
  fieldId: string,
): string {
  const party = storageTarget(
    parseCompiledApplication(compiledApplication).application.compiled,
  ).entities.find((entity) => entity.entityId === 'northstar.app:entity.party');
  assert.ok(party);
  const column = party.columns.find(
    (candidate) => candidate.canonicalFieldId === fieldId,
  );
  assert.ok(column);
  return column.physicalName;
}

function storageTarget(compiled: CompileSuccess): StorageTargetPayloadV1 {
  return projectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
}

function projectionPayload<T>(compiled: CompileSuccess, familyId: string): T {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (projection) => projection.familyId === familyId,
  );
  assert.ok(reference);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (artifact) =>
      artifact.artifactKind === 'projectionManifest' &&
      artifact.contentHash === reference.artifactRoot,
  );
  assert.ok(manifestArtifact);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as { chunks: readonly { contentHash: string }[] };
  assert.equal(manifest.chunks.length, 1);
  const chunk = compiled.bundle.artifacts.find(
    (artifact) =>
      artifact.artifactKind === 'projectionChunk' &&
      artifact.contentHash === manifest.chunks[0]?.contentHash,
  );
  assert.ok(chunk);
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
}

async function assertApprovedActivationRecorded(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  sourceReleaseId: MintedUuid,
): Promise<void> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.release_activation_attempts AS attempt
       JOIN platform.release_approvals AS approval
         ON approval.tenant_id = attempt.tenant_id
        AND approval.environment_id = attempt.environment_id
        AND approval.approval_id = attempt.approval_id
        AND approval.activation_attempt_id = attempt.activation_attempt_id
       JOIN platform.release_activation_attempt_outcomes AS outcome
         ON outcome.tenant_id = attempt.tenant_id
        AND outcome.environment_id = attempt.environment_id
        AND outcome.activation_attempt_id = attempt.activation_attempt_id
      WHERE approval.tenant_id = $1
        AND approval.environment_id = $2
        AND approval.expected_release_id = $3
        AND approval.target_release_id = $4
        AND outcome.outcome_code = 'SWAPPED'`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      sourceReleaseId,
      runtime.activeReleaseId,
    ],
  );
  assert.equal(
    result.rows[0]?.count,
    '1',
    'the successful advancement is bound to a persisted human approval',
  );
}

async function assertApprovedReverseActivationRecorded(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  sourceReleaseId: MintedUuid,
): Promise<void> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.release_activation_attempts AS attempt
       JOIN platform.release_approvals AS approval
         ON approval.tenant_id = attempt.tenant_id
        AND approval.environment_id = attempt.environment_id
        AND approval.approval_id = attempt.approval_id
        AND approval.activation_attempt_id = attempt.activation_attempt_id
       JOIN platform.release_activation_attempt_outcomes AS outcome
         ON outcome.tenant_id = attempt.tenant_id
        AND outcome.environment_id = attempt.environment_id
        AND outcome.activation_attempt_id = attempt.activation_attempt_id
      WHERE approval.tenant_id = $1
        AND approval.environment_id = $2
        AND approval.expected_release_id = $3
        AND approval.target_release_id = $4
        AND outcome.outcome_code = 'SWAPPED'`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      sourceReleaseId,
      runtime.activeReleaseId,
    ],
  );
  assert.equal(
    result.rows[0]?.count,
    '1',
    'the reverse transition is bound to a fresh persisted human approval',
  );
}

async function assertMaterializedReversibleForwardTransition(
  pool: pg.Pool,
  sourceReleaseId: MintedUuid,
  targetReleaseId: MintedUuid,
): Promise<void> {
  const result = await pool.query<{
    compiler_transition_class: string;
    generation_id: MintedUuid | null;
    receipt_version: string;
    recovery_mode: string;
  }>(
    `SELECT receipt.receipt_version,
            receipt.generation_id,
            receipt.compiler_transition_class,
            receipt.recovery_mode
       FROM platform.release_activation_swap_receipts AS swap
       JOIN platform.release_approvals AS approval
         ON approval.tenant_id = swap.tenant_id
        AND approval.environment_id = swap.environment_id
        AND approval.approval_id = swap.approval_id
        AND approval.activation_attempt_id = swap.activation_attempt_id
       JOIN platform.transition_preparation_receipts AS receipt
         ON receipt.tenant_id = approval.tenant_id
        AND receipt.environment_id = approval.environment_id
        AND receipt.receipt_id = approval.transition_preparation_receipt_id
      WHERE swap.previous_release_id = $1
        AND swap.activated_release_id = $2`,
    [sourceReleaseId, targetReleaseId],
  );
  const receipt = result.rows[0];
  assert.ok(receipt);
  assert.equal(
    receipt.receipt_version,
    'northstar.transition-preparation-receipt/v2',
  );
  assert.ok(receipt.generation_id);
  assert.equal(receipt.compiler_transition_class, 'REVERSIBLE');
  assert.equal(receipt.recovery_mode, 'REVERSIBLE');
}

async function assertNoReverseApprovalRecorded(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  sourceReleaseId: MintedUuid,
  targetReleaseId: MintedUuid,
): Promise<void> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.release_approvals
      WHERE tenant_id = $1
        AND environment_id = $2
        AND expected_release_id = $3
        AND target_release_id = $4`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      sourceReleaseId,
      targetReleaseId,
    ],
  );
  assert.equal(
    result.rows[0]?.count,
    '0',
    'a refused reverse transition does not reach approval creation',
  );
}

async function setLatestForwardTransitionRecoveryMode(
  pool: pg.Pool,
  sourceReleaseId: MintedUuid,
  targetReleaseId: MintedUuid,
  mode: 'forwardOnly' | 'reversible',
): Promise<void> {
  await pool.query(
    `ALTER TABLE platform.transition_preparation_receipts
       DISABLE RULE transition_preparation_receipts_reject_update`,
  );
  try {
    const result = await pool.query(
      `UPDATE platform.transition_preparation_receipts AS receipt
          SET compiler_transition_class = $3,
              recovery_mode = $4
         FROM platform.release_approvals AS approval
         JOIN platform.release_activation_swap_receipts AS swap
           ON swap.tenant_id = approval.tenant_id
          AND swap.environment_id = approval.environment_id
          AND swap.approval_id = approval.approval_id
          AND swap.activation_attempt_id = approval.activation_attempt_id
        WHERE receipt.tenant_id = approval.tenant_id
          AND receipt.environment_id = approval.environment_id
          AND receipt.receipt_id = approval.transition_preparation_receipt_id
          AND swap.previous_release_id = $1
          AND swap.activated_release_id = $2`,
      [
        sourceReleaseId,
        targetReleaseId,
        mode === 'forwardOnly' ? 'IRREVERSIBLE' : 'REVERSIBLE',
        mode === 'forwardOnly' ? 'FORWARD_RECOVERY_ONLY' : 'REVERSIBLE',
      ],
    );
    assert.equal(result.rowCount, 1);
  } finally {
    await pool.query(
      `ALTER TABLE platform.transition_preparation_receipts
         ENABLE RULE transition_preparation_receipts_reject_update`,
    );
  }
  const rule = await pool.query<{ enabled: string }>(
    `SELECT ev_enabled AS enabled
       FROM pg_catalog.pg_rewrite
      WHERE ev_class = 'platform.transition_preparation_receipts'::regclass
        AND rulename = 'transition_preparation_receipts_reject_update'`,
  );
  assert.equal(
    rule.rows[0]?.enabled,
    'O',
    'the immutable receipt update rule is restored after the control',
  );
}

/**
 * Row-level security is a table property, so the tenant that first materializes
 * a seeded table seeds it before RLS is enabled and every later tenant does not.
 * The materializer therefore needs a real INSERT policy, and that policy must
 * stay as narrow as the SELECT policy it mirrors: the two seeded table classes,
 * only the trusted tenant and environment. The provider-written posted-stock
 * projection is the one other materializer INSERT authority and is named
 * independently so it cannot be mistaken for blanket seed access.
 */
async function assertMaterializerSeedingIsNarrowlyScoped(
  pool: pg.Pool,
  connection: pg.PoolConfig,
  tenantA: ComposedApplicationRuntime,
  tenantB: ComposedApplicationRuntime,
  compiledApplication: unknown,
): Promise<void> {
  const storage = storageTarget(
    parseCompiledApplication(compiledApplication).application.compiled,
  );
  const master = storage.entities.find(
    (candidate) => candidate.legalEntityMaster !== undefined,
  );
  const periodLock = storage.entities.find(
    (candidate) => candidate.periodLock !== undefined,
  );
  const ordinary = storage.entities.find(
    (candidate) => candidate.entityId === 'northstar.app:entity.party',
  );
  const postedStockBalance = storage.entities.find(
    (candidate) =>
      candidate.entityId === 'northstar.app:entity.posted_stock_balance',
  );
  const receivedQuantity = storage.entities.find(
    (candidate) =>
      candidate.entityId === 'northstar.app:entity.purchase_order_received',
  );
  assert.ok(master?.legalEntityMaster);
  assert.ok(periodLock?.periodLock);
  assert.ok(ordinary);
  assert.ok(postedStockBalance);
  assert.ok(receivedQuantity);

  // The second tenant reached the same seeded state as the first.
  const periodLockScope = periodLock.legalEntity;
  assert.ok(periodLockScope);
  for (const [runtime, tenantLabel] of [
    [tenantA, 'first'],
    [tenantB, 'second'],
  ] as const) {
    const seeded: pg.QueryResult<{ record_id: string }> = await pool.query(
      `SELECT "${master.recordIdentity.column}"::text AS record_id
         FROM north_star_module.${master.physicalTableName}
        WHERE tenant_id = $1 AND environment_id = $2
          AND "${master.legalEntityMaster.fieldColumns.code}" = 'DEFAULT'
          AND "${master.legalEntityMaster.fieldColumns.isDefault}" IS TRUE
          AND "${master.archive.archivedAtColumn}" IS NULL`,
      [runtime.identity.tenantId, runtime.identity.environmentId],
    );
    assert.equal(
      seeded.rows.length,
      1,
      `the ${tenantLabel} tenant carries its seeded default legal entity`,
    );
    const seededLegalEntityId = seeded.rows[0]?.record_id;
    const locks: pg.QueryResult<{ count: string }> = await pool.query(
      `SELECT count(*)::text AS count
         FROM north_star_module.${periodLock.physicalTableName}
        WHERE tenant_id = $1 AND environment_id = $2
          AND "${periodLockScope.column}" = $3`,
      [
        runtime.identity.tenantId,
        runtime.identity.environmentId,
        seededLegalEntityId,
      ],
    );
    assert.equal(
      locks.rows[0]?.count,
      '1',
      `the ${tenantLabel} tenant carries its seeded period-lock row`,
    );
  }

  // The insert policy exists for exactly the two seeded table classes and the
  // two explicitly named provider-written projections.
  const insertPolicies = await pool.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_catalog.pg_policies
      WHERE schemaname = 'north_star_module'
        AND cmd = 'INSERT'
        AND 'north_star_module_materializer' = ANY (roles::text[])
      ORDER BY tablename`,
  );
  assert.deepEqual(
    insertPolicies.rows.map((row) => row.tablename),
    [
      master.physicalTableName,
      periodLock.physicalTableName,
      postedStockBalance.physicalTableName,
      receivedQuantity.physicalTableName,
    ].toSorted(),
    'only the seeded table classes and named stock/received projections carry a materializer insert policy',
  );

  const materializerPool = new pg.Pool({
    ...connection,
    max: 1,
    user: 'north_star_module_materializer',
  });
  try {
    const client = await materializerPool.connect();
    try {
      const legalEntityMaster = master.legalEntityMaster;
      const seedColumns = [
        'tenant_id',
        'environment_id',
        master.recordIdentity.column,
        master.optimisticRevision.column,
        legalEntityMaster.fieldColumns.code,
        legalEntityMaster.fieldColumns.name,
        legalEntityMaster.fieldColumns.status,
        legalEntityMaster.fieldColumns.isDefault,
      ]
        .map((column) => `"${column}"`)
        .join(', ');
      const seedInsert = `INSERT INTO north_star_module.${master.physicalTableName}
           (${seedColumns})
         VALUES ($1, $2, $3, 1, 'CONTROL', 'Control legal entity', $4, false)`;

      // The predicate binds: the trusted pair is accepted and the other
      // tenant's pair is refused by the same statement in the same session.
      await client.query('BEGIN');
      await setTrustedScope(client, tenantB);
      await client.query(seedInsert, [
        tenantB.identity.tenantId,
        tenantB.identity.environmentId,
        randomUUID(),
        legalEntityMaster.activeStatusValue,
      ]);
      await assertRefusedByRowLevelSecurity(
        client.query(seedInsert, [
          tenantA.identity.tenantId,
          tenantA.identity.environmentId,
          randomUUID(),
          legalEntityMaster.activeStatusValue,
        ]),
        'a seed row for another tenant is refused',
      );
      await client.query('ROLLBACK');

      // The policy is not blanket: an ordinary business entity table stays
      // closed to the materializer even for its own trusted tenant. The row is
      // built from the physical catalog so no NOT NULL or CHECK violation can
      // stand in for the refusal under test.
      await client.query('BEGIN');
      await setTrustedScope(client, tenantB);
      await assertRefusedByRowLevelSecurity(
        satisfiableInsert(client, ordinary.physicalTableName, {
          environment_id: tenantB.identity.environmentId,
          tenant_id: tenantB.identity.tenantId,
        }),
        'an ordinary business entity table refuses the materializer',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await materializerPool.end();
  }
}

/**
 * Inserts one row whose every mandatory physical column is populated, so the
 * only thing left that can refuse it is a policy.
 */
async function satisfiableInsert(
  client: pg.PoolClient,
  tableName: string,
  overrides: Readonly<Record<string, string>>,
): Promise<unknown> {
  const columns = await client.query<{
    column_name: string;
    data_type: string;
  }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'north_star_module'
        AND table_name = $1
        AND is_nullable = 'NO'
        AND column_default IS NULL
        AND is_generated = 'NEVER'
      ORDER BY ordinal_position`,
    [tableName],
  );
  assert.ok(columns.rows.length > 0);
  const names: string[] = [];
  const expressions: string[] = [];
  const values: string[] = [];
  for (const [index, column] of columns.rows.entries()) {
    names.push(`"${column.column_name}"`);
    const override = overrides[column.column_name];
    if (override !== undefined) {
      values.push(override);
      expressions.push(`$${String(values.length)}`);
      continue;
    }
    expressions.push(defaultLiteral(column.data_type, index));
  }
  return client.query(
    `INSERT INTO north_star_module.${tableName} (${names.join(', ')})
     VALUES (${expressions.join(', ')})`,
    values,
  );
}

function defaultLiteral(dataType: string, seed: number): string {
  const unique = String(seed).padStart(2, '0');
  switch (dataType) {
    case 'boolean':
      return 'false';
    case 'bigint':
    case 'double precision':
    case 'integer':
    case 'numeric':
    case 'smallint':
      return '1';
    case 'character varying':
    case 'text':
      return `'control-${unique}'`;
    case 'date':
      return 'current_date';
    case 'time without time zone':
      return `'00:00:00'::time`;
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      return 'now()';
    case 'uuid':
      return `'000000${unique}-0000-4000-8000-000000000000'::uuid`;
    default:
      throw new Error(`unhandled physical column type ${dataType}`);
  }
}

async function setTrustedScope(
  client: pg.PoolClient,
  runtime: ComposedApplicationRuntime,
): Promise<void> {
  await client.query(
    `SELECT set_config('north_star.tenant_id', $1, true),
            set_config('north_star.environment_id', $2, true)`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
}

async function assertRefusedByRowLevelSecurity(
  attempt: Promise<unknown>,
  message: string,
): Promise<void> {
  await assert.rejects(
    attempt,
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === '42501' &&
      /row-level security policy/u.test(error.message),
    message,
  );
}

async function assertExactSwapTriggerEnabled(pool: pg.Pool): Promise<void> {
  const trigger = await pool.query<{ enabled: string }>(
    `SELECT tgenabled AS enabled
       FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'platform.active_release_pointers'::regclass
        AND tgname = 'active_release_pointer_exact_swap'
        AND NOT tgisinternal`,
  );
  assert.equal(trigger.rows[0]?.enabled, 'O');
}

async function assertDurableProductEvidence(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
): Promise<void> {
  const result = await pool.query<{
    executed_environment_id: string;
    executed_evidence_id: string;
    executed_tenant_id: string;
    release_root: string;
    result_count: string;
    result_rows: string;
    verification_evidence_id: string;
  }>(
    `SELECT evidence.verification_evidence_id,
            evidence.release_root,
            evidence.executed_tenant_id,
            evidence.executed_environment_id,
            evidence.executed_evidence_id,
            evidence.result_count::text,
            count(result.scenario_id)::text AS result_rows
       FROM platform.tenant_release_admissions AS admission
       JOIN platform.release_verification_evidence AS evidence
         ON evidence.tenant_id = admission.tenant_id
        AND evidence.environment_id = admission.environment_id
        AND evidence.verification_evidence_id =
            admission.verification_evidence_id
       LEFT JOIN platform.release_verification_results AS result
         ON result.tenant_id = evidence.tenant_id
        AND result.environment_id = evidence.environment_id
        AND result.verification_evidence_id =
            evidence.verification_evidence_id
      WHERE admission.tenant_id = $1
        AND admission.environment_id = $2
        AND admission.release_id = $3
      GROUP BY evidence.tenant_id, evidence.environment_id,
               evidence.verification_evidence_id`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      runtime.activeReleaseId,
    ],
  );
  const evidence = result.rows[0];
  assert.ok(evidence, 'the active product release has a durable admission');
  assert.equal(evidence.release_root, runtime.releaseRoot);
  assert.equal(evidence.executed_tenant_id, runtime.identity.tenantId);
  assert.equal(
    evidence.executed_environment_id,
    runtime.identity.environmentId,
  );
  assert.equal(
    evidence.executed_evidence_id,
    evidence.verification_evidence_id,
  );
  assert.ok(Number(evidence.result_count) > 0);
  assert.equal(evidence.result_rows, evidence.result_count);
}

async function assertBoundedFreshTenantInstallEvidence(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
  connection: pg.PoolConfig,
): Promise<void> {
  const compiled = parseCompiledApplication(compiledApplication);
  const lineage = [compiled.bootstrap, ...compiled.applications];
  const unverifiedRoots = lineage
    .slice(0, -1)
    .map((release) => release.compiled.releaseRoot);
  const transitionPairs = lineage.slice(1).map((release, index) => ({
    sourceReleaseRoot: lineage[index]!.compiled.releaseRoot,
    targetReleaseRoot: release.compiled.releaseRoot,
  }));
  const servingScenarioCount = releaseVerificationBinding(
    compiled.application.compiled,
  ).plan.scenarios.length;
  assertReceivingVerificationCoverage(compiledApplication);
  // 174 -> 198. PUR-1 adds exactly 24, MEASURED by enumerating the compiled
  // plan rather than derived from this arithmetic: 12 declaredEvidence (six per
  // purchasing entity), 6 searchableExclusion (the two dates, notes, and the
  // line's three non-searchable numerics), 2 resolverAuthority, 2
  // typedErrorSurface, 1 uniquenessFold on the order number, and 1
  // archiveRestrict on the line-to-order relation.
  //
  // THE MATERIALIZED STATE FIELD CONTRIBUTES ZERO, and that absence is the
  // interesting half of the count. It is an enum on a searchable entity, so it
  // would otherwise mint an `enumReject` and a `searchableExclusion` -- but both
  // probe a field THROUGH the create operation, and a machine's state field is
  // structurally excluded from that contract. `projections.ts` declines to emit
  // either, which is ADR-0050 section 6 item 2 closed at the compiler. Not
  // emitting differs from skipping: nothing is admitted unexecuted.
  assert.equal(
    servingScenarioCount,
    257,
    'the release includes the prior 198 scenarios plus 59 for the four receiving entities',
  );

  const intermediate = await pool.query<{
    install_id: MintedUuid;
    lineage_ordinal: number;
    release_id: MintedUuid;
    release_root: string;
    source_release_root: string | null;
  }>(
    `SELECT install_id, lineage_ordinal, release_id, release_root,
            source_release_root
       FROM platform.fresh_tenant_intermediate_release_admissions
      WHERE tenant_id = $1 AND environment_id = $2
      ORDER BY lineage_ordinal`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  assert.deepEqual(
    intermediate.rows.map((row) => row.release_root),
    unverifiedRoots,
    'every and only non-serving release is named as lacking scenario execution',
  );
  const installId = intermediate.rows[0]?.install_id;
  assert.ok(installId);
  assert.ok(
    intermediate.rows.every((row) => row.install_id === installId),
    'all intermediate admissions belong to one exact fresh install',
  );
  const preparationBindings = await pool.query<{
    fresh_tenant_install_id: MintedUuid;
    fresh_tenant_lineage_ordinal: number;
    release_id: MintedUuid;
  }>(
    `SELECT preparation.fresh_tenant_install_id,
            preparation.fresh_tenant_lineage_ordinal,
            intermediate.release_id
       FROM platform.release_activation_preparations AS preparation
       JOIN platform.fresh_tenant_intermediate_release_admissions
            AS intermediate
         ON intermediate.tenant_id = preparation.tenant_id
        AND intermediate.environment_id = preparation.environment_id
        AND intermediate.release_id = preparation.target_release_id
        AND intermediate.install_id = preparation.fresh_tenant_install_id
        AND intermediate.lineage_ordinal =
            preparation.fresh_tenant_lineage_ordinal
      WHERE preparation.tenant_id = $1
        AND preparation.environment_id = $2
      ORDER BY preparation.fresh_tenant_lineage_ordinal`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  assert.deepEqual(
    preparationBindings.rows,
    intermediate.rows.map((row) => ({
      fresh_tenant_install_id: row.install_id,
      fresh_tenant_lineage_ordinal: row.lineage_ordinal,
      release_id: row.release_id,
    })),
    'every transition-only preparation preserves its exact install and ordinal binding',
  );
  assert.deepEqual(
    intermediate.rows.map((row) => ({
      lineageOrdinal: row.lineage_ordinal,
      sourceReleaseRoot: row.source_release_root,
      targetReleaseRoot: row.release_root,
    })),
    unverifiedRoots.map((releaseRoot, index) => ({
      lineageOrdinal: index,
      sourceReleaseRoot:
        index === 0 ? null : lineage[index - 1]!.compiled.releaseRoot,
      targetReleaseRoot: releaseRoot,
    })),
    'transition-only admissions bind every exact intermediate lineage edge',
  );

  const semantic = await pool.query<{
    derived_count: number;
    release_id: MintedUuid;
    release_root: string;
    result_count: number;
  }>(
    `SELECT admission.release_id, evidence.release_root, evidence.result_count,
            CASE
              WHEN evidence.impact_analysis_derivation IS NULL THEN 0
              ELSE jsonb_array_length(
                evidence.impact_analysis_derivation -> 'derivations'
              )
            END AS derived_count
       FROM platform.tenant_release_admissions AS admission
       JOIN platform.release_verification_evidence AS evidence
         ON evidence.tenant_id = admission.tenant_id
        AND evidence.environment_id = admission.environment_id
        AND evidence.verification_evidence_id =
            admission.verification_evidence_id
      WHERE admission.tenant_id = $1 AND admission.environment_id = $2
      ORDER BY admission.release_id`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  assert.deepEqual(
    semantic.rows.map((row) => row.release_root),
    [runtime.releaseRoot],
    'only the serving release receives semantic verification admission',
  );
  assert.equal(semantic.rows[0]?.release_id, runtime.activeReleaseId);
  assert.equal(
    (semantic.rows[0]?.result_count ?? -1) +
      (semantic.rows[0]?.derived_count ?? -1),
    servingScenarioCount,
    'the serving release retains its complete scenario partition',
  );

  const evidence = runtime.freshTenantInstallEvidence;
  assert.ok(evidence, 'a fresh install returns its bounded-install evidence');
  assert.deepEqual(
    evidence.nonServingReleasesWithoutScenarioExecution.map(
      ({ releaseRoot }) => releaseRoot,
    ),
    unverifiedRoots,
    'the evidence set changes exactly when the compiled lineage changes',
  );
  assert.deepEqual(evidence.appliedTransitions, transitionPairs);
  assert.deepEqual(evidence.servingRelease, {
    releaseId: runtime.activeReleaseId,
    releaseRoot: runtime.releaseRoot,
    scenarioCount: servingScenarioCount,
  });

  const durable = await pool.query<{
    evidence_document: unknown;
    evidence_version: string;
    serving_scenario_count: number;
  }>(
    `SELECT evidence_document, evidence_version, serving_scenario_count
       FROM platform.fresh_tenant_install_evidence
      WHERE tenant_id = $1 AND environment_id = $2`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  assert.equal(durable.rows.length, 1);
  assert.equal(durable.rows[0]?.evidence_version, evidence.schemaVersion);
  assert.equal(durable.rows[0]?.serving_scenario_count, servingScenarioCount);
  assert.deepEqual(durable.rows[0]?.evidence_document, evidence);
  await assertFreshTenantEvidenceAuthorityRejectsMalformedClosure(
    connection,
    runtime,
    installId,
    evidence,
  );
}

async function assertFreshTenantEvidenceAuthorityRejectsMalformedClosure(
  connection: pg.PoolConfig,
  runtime: ComposedApplicationRuntime,
  installId: MintedUuid,
  evidence: NonNullable<
    ComposedApplicationRuntime['freshTenantInstallEvidence']
  >,
): Promise<void> {
  const runtimePool = new pg.Pool({
    ...connection,
    max: 2,
    user: 'north_star_runtime',
  });
  runtimePool.on('error', () => undefined);
  const context = await new AuthenticatedRequestEntryAdapter(
    async () => runtime.identity,
  ).enter({});
  const malformed = {
    appliedTransitions: [],
    nonServingReleasesWithoutScenarioExecution: [],
    schemaVersion: evidence.schemaVersion,
    servingRelease: {},
  };
  try {
    await assert.rejects(
      withTrustedRequestTransaction(runtimePool, context, (client) =>
        client.query(
          `INSERT INTO platform.fresh_tenant_install_evidence (
             tenant_id, environment_id, install_id, serving_release_id,
             serving_release_root, serving_scenario_count, evidence_version,
             evidence_document, evidence_digest, created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            context.tenantId,
            context.environmentId,
            installId,
            runtime.activeReleaseId,
            runtime.releaseRoot,
            evidence.servingRelease.scenarioCount,
            evidence.schemaVersion,
            malformed,
            '0'.repeat(64),
            context.principalId,
          ],
        ),
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, '42501');
        return true;
      },
      'the runtime role has no direct path around the closed evidence recorder',
    );
    await assert.rejects(
      withTrustedRequestTransaction(runtimePool, context, (client) =>
        client.query(
          `SELECT platform.record_fresh_tenant_install_evidence(
             $1,$2,$3,$4,$5
           )`,
          [
            installId,
            runtime.activeReleaseId,
            runtime.releaseRoot,
            evidence.servingRelease.scenarioCount,
            malformed,
          ],
        ),
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, '23514');
        return true;
      },
      'the only evidence writer refuses a document that omits durable lineage facts',
    );
  } finally {
    await runtimePool.end();
  }
}

async function assertBoundedInstallMatchesFullReplaySchema(
  pool: pg.Pool,
): Promise<void> {
  const expected = JSON.parse(
    await readFile(fullReplaySchemaSnapshotPath, 'utf8'),
  ) as unknown;
  const client = await pool.connect();
  try {
    assert.deepEqual(
      await captureSchemaSnapshot(client, ['north_star_module']),
      expected,
      'bounded verification produces the same head schema snapshot as full replay',
    );
  } finally {
    client.release();
  }
}

/**
 * Reopen the tenant's runtime on the recorded lineage.
 *
 * This was `assertIntermediateBecomesServingOnlyAfterVerification` and carried
 * BOTH ADR-0047 §6 rollback directions. `LANG-ADOPT-v5` moved them out: each
 * needs its own served tenant, three fresh installs exceeded this test's 300 s
 * bound in-matrix, and that test's standing instruction is to split rather than
 * raise the bound. The intermediate-becomes-serving fact this name claimed is
 * asserted by the caller, through `refusedIntermediateRoots`.
 */
async function reopenServingRuntime(
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
  databaseUrl: string,
  tenantSlug: string,
): Promise<ComposedApplicationRuntime> {
  await runtime.close();

  return createRuntime(compiledApplication, databaseUrl, tenantSlug);
}

// SPLIT OUT of "composed product activates through the kernel" by `LANG-ADOPT-v5`,
// and the split is that test's own standing instruction rather than a new idea:
//
//   "If this ever reds on timing, the fix is to split the `-source-edge` tenant
//    into its own test with its own lifecycle. It is NOT to raise the bound."
//
// BOTH ADR-0047 §6 rollback directions now live here, and it took two rounds to
// get there. Adoption made the artifact's head source-changing rather than a
// profile sibling, which swapped which direction could borrow the real head:
// the profile-only one suddenly needed a served tenant of its own. Moving only
// the source-changing direction out left the parent driving three tenants; that
// measured 251.1s standalone and then TIMED OUT at 300s IN-MATRIX, where the
// parent's own comment records a 1.79x load factor over standalone. So the
// second direction followed the first, the parent is back to its two
// gateway-persistence tenants, and each direction has its own budget.
//
// They belong together anyway: each is the other's discriminating half. Direction
// 1 alone is satisfied by a refusal that fires on every edge; direction 2 alone
// is satisfied by one that fires on none.
test(
  'ADR-0047 §6 refuses a profile-only rollback edge by name and leaves a source-changing one eligible',
  { timeout: 300_000 },
  async () => {
    await withEphemeralPostgres(
      'lang-adopt-v5-rollback-edges',
      async ({ connection }) => {
        const compiledApplication = JSON.parse(
          await readFile(compiledArtifactPath, 'utf8'),
        ) as unknown;
        const databaseUrl = connectionUrl(connection);
        const tenantSlug = 'composed-tenant-b';
        // DIRECTION 1 -- the refusal FIRES on a profile-only edge. A serving head and
        // its predecessor that share a normalized definition (ADR-0047 §4) share one
        // package revision, so the revision graph has no edge to reverse. The target
        // IS the immediate predecessor -- the index check passes and control reaches
        // the authorization -- so this must NOT borrow
        // ROLLBACK_TARGET_NOT_IMMEDIATE_PREDECESSOR (ADR-0047 §6).
        //
        // ADR-0066: construct identical source under v1 then v2 in memory.
        const profileEdgeLineage =
          throughProfileSiblingHead(compiledApplication);
        const profileEdge = parseCompiledApplication(profileEdgeLineage);
        const target = profileEdge.applications.at(-2);
        assert.ok(target);
        assert.ok(
          equalNormalizedDefinition(
            target.normalizedDefinitionBytes,
            profileEdge.application.normalizedDefinitionBytes,
          ),
          'this direction is only meaningful while the head is a profile sibling',
        );
        // The tenant must already serve that head for the rollback to be eligible at
        // all, exactly as direction 2 records below.
        const profileEdgeSlug = `${tenantSlug}-profile-edge`;
        const profileEdgeRuntime = await createRuntime(
          profileEdgeLineage,
          databaseUrl,
          profileEdgeSlug,
        );
        assert.equal(
          profileEdgeRuntime.releaseRoot,
          profileEdge.application.compiled.releaseRoot,
        );
        await profileEdgeRuntime.close();
        await assert.rejects(
          createRuntime(profileEdgeLineage, databaseUrl, profileEdgeSlug, {
            kind: 'rollback',
            targetReleaseRoot: target.compiled.releaseRoot,
          }),
          (error: unknown) => {
            assert.ok(error instanceof ReleaseReverseTransitionRefusal);
            assert.equal(error.code, 'ROLLBACK_ACROSS_PROFILE_ONLY_EDGE');
            assert.match(error.message, /shares its package revision/u);
            return true;
          },
          'ADR-0047 §6: a profile-only edge refuses by its own name, not as a wrong predecessor',
        );

        // ADR-0066: the source-changing synthetic edge has a usable target.
        // Actual successful rollback discriminates this from deny-every-edge.
        // The obsolete pre-search first-party target is no longer retained.
        const sourceChangingLineage =
          syntheticSourceChangingLineage(compiledApplication);
        const truncated = parseCompiledApplication(sourceChangingLineage);
        const sourceChangingTarget = truncated.applications.at(-2);
        assert.ok(sourceChangingTarget);
        assert.ok(
          !equalNormalizedDefinition(
            sourceChangingTarget.normalizedDefinitionBytes,
            truncated.application.normalizedDefinitionBytes,
          ),
          'direction 2 must cross an edge whose endpoints differ in source',
        );
        // The tenant must already be serving this head before the rollback is
        // eligible at all: on a fresh tenant `activeLineageIndex` is still the
        // fresh-install intermediate, so the index check at the FIRST refusal site
        // fires and control never reaches the authorization this direction is about.
        //
        // `tenantSlug` already serves it. Until `LANG-ADOPT-v5` the artifact's head
        // WAS a profile sibling, so this direction had to install a second tenant on
        // a truncated lineage to find a source-changing edge; now the head is itself
        // source-changing and the caller's tenant is already the right one. That
        // matters beyond tidiness -- direction 1 needs a fresh install of its own now,
        // and two fresh installs in one test exceed the 300 s budget.
        const sourceEdgeSlug = `${tenantSlug}-source-edge`;
        const sourceEdgeRuntime = await createRuntime(
          sourceChangingLineage,
          databaseUrl,
          sourceEdgeSlug,
        );
        assert.equal(
          sourceEdgeRuntime.releaseRoot,
          truncated.application.compiled.releaseRoot,
        );
        await sourceEdgeRuntime.close();

        const reversed = await createRuntime(
          sourceChangingLineage,
          databaseUrl,
          sourceEdgeSlug,
          {
            kind: 'rollback',
            targetReleaseRoot: sourceChangingTarget.compiled.releaseRoot,
          },
        );
        try {
          assert.equal(
            reversed.releaseRoot,
            sourceChangingTarget.compiled.releaseRoot,
            'a source-changing edge remains eligible and serves only after verification',
          );
        } finally {
          await reversed.close();
        }
      },
    );
  },
);

/**
 * The lineage with its trailing profile-sibling entries removed, so the head is
 * the last entry that actually changed the authored source. Used to exercise a
 * source-changing rollback edge while the real artifact's head is a profile
 * sibling (ADR-0047 §4).
 */
function syntheticSourceChangingLineage(compiledApplication: unknown): unknown {
  const previous = parseCompiledApplication(compiledApplication);
  const bytes = normalizedDefinitionVersion(
    composedApplicationDefinition(),
    '1.0.99',
  );
  const successor = compileSuccessor(previous.application.compiled, bytes);
  return {
    applications: [
      ...previous.applications.map((entry) =>
        serializedRelease(entry.normalizedDefinitionBytes, entry.compiled),
      ),
      serializedRelease(bytes, successor),
    ],
    bootstrap: serializedRelease(
      previous.bootstrap.normalizedDefinitionBytes,
      previous.bootstrap.compiled,
    ),
    schemaVersion: 'northstar.web:compiled-application-release/v2',
  };
}

/** ADR-0066: construct the profile edge instead of relying on disposable history. */
function throughProfileSiblingHead(compiledApplication: unknown): unknown {
  const previous = parseCompiledApplication(compiledApplication);
  const definition = structuredClone(composedApplicationDefinition()) as {
    surfaces: { slots: { disclosureTier?: string }[] }[];
  };
  // The previous profile cannot admit an explicitly declared newer UI field.
  // Both endpoints use this same synthetic source, so only the profile differs.
  for (const surface of definition.surfaces)
    for (const slot of surface.slots) delete slot.disclosureTier;
  const bytes = new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(definition)),
  );
  const predecessor = compileApplication({
    dependencies: [],
    expectedActiveRelease: expectedActiveReleaseFrom(
      previous.bootstrap.compiled,
    ),
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: bytes,
    profile: {
      ...profileForNormalizedBytes(bytes),
      compilerSemanticProfileVersion: COMPILER_SEMANTIC_PROFILE_V1_VERSION,
    },
  });
  assert.equal(
    predecessor.status,
    'compiled',
    predecessor.status === 'failed'
      ? JSON.stringify(predecessor.diagnostics)
      : undefined,
  );
  const successor = compileSuccessor(predecessor, bytes);
  return {
    applications: [
      serializedRelease(bytes, predecessor),
      serializedRelease(bytes, successor),
    ],
    bootstrap: serializedRelease(
      previous.bootstrap.normalizedDefinitionBytes,
      previous.bootstrap.compiled,
    ),
    schemaVersion: 'northstar.web:compiled-application-release/v2',
  };
}

async function assertConstrainedDomainVerificationCompleted(
  pool: pg.Pool,
  connection: pg.PoolConfig,
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
): Promise<void> {
  const compiled =
    parseCompiledApplication(compiledApplication).application.compiled;
  const storage = storageTarget(compiled);
  const entity = storage.entities.find(
    (candidate) => candidate.legalEntityMaster !== undefined,
  );
  assert.ok(entity?.legalEntityMaster);
  const constrainedColumn = entity.columns.find(
    (column) =>
      column.physicalName === entity.legalEntityMaster?.fieldColumns.isDefault,
  );
  assert.ok(constrainedColumn);
  const scenario = releaseVerificationBinding(compiled).plan.scenarios.find(
    (candidate) =>
      candidate.kind === 'searchableExclusion' &&
      candidate.entityId === entity.entityId &&
      candidate.subjectId === constrainedColumn.canonicalFieldId,
  );
  assert.ok(
    scenario,
    'the compiled plan contains the partial-unique boolean exclusion probe',
  );
  const constructibilityFindings =
    releaseVerificationBinding(compiled).findings;
  const operations = projectionPayload<{
    operations: readonly {
      effect: { entity: { targetId: string }; kind: string };
      inputContract: {
        fields: readonly {
          fieldId: string;
          fieldKind: string;
          writable: boolean;
        }[];
      };
      operationId: string;
    }[];
  }>(compiled, PROJECTION_FAMILY_IDS.operationCatalog).operations;
  const queries = projectionPayload<{
    queries: readonly {
      queryType: string;
      selections: readonly { fieldId: string }[];
      sourceEntityId: string;
    }[];
  }>(compiled, PROJECTION_FAMILY_IDS.queryCatalog).queries;
  const createOperations = new Map(
    operations
      .filter((operation) => operation.effect.kind === 'createRecordEffect')
      .map((operation) => [operation.effect.entity.targetId, operation]),
  );
  const excludedFields = new Map<string, Set<string>>();
  for (const excludedScenario of releaseVerificationBinding(compiled).plan
    .scenarios) {
    if (excludedScenario.kind !== 'searchableExclusion') continue;
    const fields = excludedFields.get(excludedScenario.entityId) ?? new Set();
    fields.add(excludedScenario.subjectId);
    excludedFields.set(excludedScenario.entityId, fields);
  }
  const searchQueries = queries.filter((query) => query.queryType === 'search');
  assert.ok(
    searchQueries.some((query) => !createOperations.has(query.sourceEntityId)),
    'the compiled product includes an append-only searchable source without a generic create operation',
  );
  assert.deepEqual(
    constructibilityFindings.filter(
      (finding) =>
        finding.code === 'VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE',
    ),
    [],
    'every entity-owned create is constructible from its compiled system input',
  );
  const scenarioSearch = searchQueries.find(
    (query) => query.sourceEntityId === scenario.entityId,
  );
  const scenarioCreate = createOperations.get(scenario.entityId);
  const constructiblePositiveCandidate = scenarioSearch?.selections
    .map((selection) => ({
      entityId: scenario.entityId,
      field: scenarioCreate?.inputContract.fields.find(
        (field) =>
          field.fieldId === selection.fieldId &&
          (field.fieldKind === 'textFieldType' ||
            field.fieldKind === 'enumFieldType') &&
          !excludedFields.get(scenario.entityId)?.has(field.fieldId),
      ),
    }))
    .find((candidate) => candidate.field);
  assert.ok(
    constructiblePositiveCandidate?.field,
    'the exclusion scenario retains a constructible same-entity searchable source for its positive witness',
  );
  assert.equal(constructiblePositiveCandidate.entityId, scenario.entityId);
  for (const identifier of [
    entity.physicalTableName,
    entity.archive.archivedAtColumn,
    constrainedColumn.physicalName,
  ]) {
    assert.match(identifier, /^[a-z][a-z0-9_]{0,62}$/u);
  }
  const rows = await pool.query<{
    active_constrained_rows: string;
    archived_unconstrained_probes: string;
  }>(
    `SELECT count(*) FILTER (
              WHERE ${constrainedColumn.physicalName} IS TRUE
                AND ${entity.archive.archivedAtColumn} IS NULL
            )::text AS active_constrained_rows,
            count(*) FILTER (
              WHERE ${constrainedColumn.physicalName} IS FALSE
                AND ${entity.archive.archivedAtColumn} IS NOT NULL
            )::text AS archived_unconstrained_probes
       FROM north_star_module.${entity.physicalTableName}
      WHERE tenant_id = $1 AND environment_id = $2`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  assert.equal(
    rows.rows[0]?.active_constrained_rows,
    '1',
    'the legitimate seeded member remains the only active row inside the partial-unique predicate',
  );
  assert.ok(
    Number(rows.rows[0]?.archived_unconstrained_probes) > 0,
    'semantic verification generated and archived a boolean probe outside the partial-unique predicate',
  );
  const result = await pool.query<{ positive_probe_digest: string }>(
    `SELECT result.positive_probe_digest
       FROM platform.tenant_release_admissions AS admission
       JOIN platform.release_verification_results AS result
         ON result.tenant_id = admission.tenant_id
        AND result.environment_id = admission.environment_id
        AND result.verification_evidence_id = admission.verification_evidence_id
      WHERE admission.tenant_id = $1
        AND admission.environment_id = $2
        AND admission.release_id = $3
        AND result.scenario_id = $4`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      runtime.activeReleaseId,
      scenario.scenarioId,
    ],
  );
  const expectedPositiveProbeDigest = createHash('sha256')
    .update('northstar.verification-proof/v1', 'utf8')
    .update(Uint8Array.of(0))
    .update(
      canonicalize({
        constructibilityFindings,
        searchWitness: {
          entityId: constructiblePositiveCandidate.entityId,
          fieldId: constructiblePositiveCandidate.field.fieldId,
          recordObserved: true,
        },
      }),
      'utf8',
    )
    .digest('hex');
  assert.equal(
    result.rows[0]?.positive_probe_digest,
    expectedPositiveProbeDigest,
    'the executed searchable-exclusion proof binds a positive witness from the same entity as its negative witness',
  );
  const admission = await pool.query<{ verification_evidence_id: string }>(
    `SELECT verification_evidence_id
       FROM platform.tenant_release_admissions
      WHERE tenant_id = $1 AND environment_id = $2 AND release_id = $3`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      runtime.activeReleaseId,
    ],
  );
  const evidenceId = admission.rows[0]?.verification_evidence_id;
  assert.ok(evidenceId);
  const context = await new AuthenticatedRequestEntryAdapter(
    async () => runtime.identity,
  ).enter({});
  // The durable reader runs inside a trusted request transaction, which refuses
  // any login role other than the unprivileged runtime role.
  const runtimePool = new pg.Pool({
    ...connection,
    max: 2,
    user: 'north_star_runtime',
  });
  runtimePool.on('error', () => undefined);
  let evidence: DurableReleaseVerificationEvidence | null;
  try {
    evidence = await new PostgresReleaseVerificationService(runtimePool).read(
      context,
      evidenceId as MintedUuid,
      compiled,
    );
  } finally {
    await runtimePool.end();
  }
  assert.deepEqual(
    evidence?.findings,
    constructibilityFindings,
    'durable verification evidence reports every witness-selection constructibility finding',
  );
  assert.ok(evidence);
  await assertExactPartitionEvidence(pool, runtime, evidenceId, evidence, {
    compiled,
    plan: releaseVerificationBinding(compiled).plan,
  });
}

/**
 * THE PARENT-AGGREGATE RULE, OBSERVED AGAINST REAL POSTGRESQL.
 *
 * `PUR-1` declares the guard once, on the header's four generic operations, and
 * relies on the platform to carry it down to `purchase_order_line` with zero
 * line-level declarations: `parentGuardsFromCatalog` derives a guard from every
 * active parent `updateRecordEffect`, and `requireRelationTarget` evaluates it
 * against the parent's PERSISTED values under `FOR SHARE` whenever a child is
 * created through its relation or mutated.
 *
 * The unit suite can only assert both halves of that mechanism and then
 * REPLICATE the derivation, which is a proxy. AGENTS.md §6 wants the fact
 * observed, and a stored-value boundary is exactly where a proxy is not enough:
 * a line silently editable after release is wrong in the database long before
 * anyone notices.
 *
 * So this runs the real gateway against the real interpreter:
 *
 *  1. create a DRAFT order and a line under it;
 *  2. the ADMISSION TWIN -- update the line successfully while the parent is
 *     draft, so the refusals below are known to be about state and not about a
 *     line that could never be mutated at all;
 *  3. release the order through its transition operation;
 *  4. attempt line create, update, archive AND RESTORE; require typed
 *     `MODULE_OPERATION_PRECONDITION_REFUSED` on each;
 *  5. read both rows back and require revision, values and archive state
 *     unchanged.
 *
 * Restore needs its own arm and its own archived line, because it is a distinct
 * generic operation reaching a distinct interpreter branch. Round 2 of review
 * found this vertical claiming "every line mutation" while never invoking it --
 * a claim wider than its evidence, and a reachable one-property survivor.
 */
async function assertPurchaseOrderParentGuard(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
): Promise<void> {
  const compiled =
    parseCompiledApplication(compiledApplication).application.compiled;
  const storage = storageTarget(compiled);
  const master = storage.entities.find(
    (candidate) => candidate.legalEntityMaster !== undefined,
  );
  assert.ok(master?.legalEntityMaster);
  const defaultEntity = await pool.query<{ legal_entity_id: string }>(
    `SELECT "${master.recordIdentity.column}"::text AS legal_entity_id
       FROM north_star_module.${master.physicalTableName}
      WHERE tenant_id = $1 AND environment_id = $2
        AND "${master.legalEntityMaster.fieldColumns.isDefault}" IS TRUE
        AND "${master.archive.archivedAtColumn}" IS NULL`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  const legalEntityId = defaultEntity.rows[0]?.legal_entity_id;
  assert.ok(legalEntityId);

  const purchasing = APPLICATION_IDS.purchasing;
  // `confirmed` matters for `archive`, which declares `humanRequired`: the
  // gateway checks the confirmation grant BEFORE the interpreter evaluates any
  // precondition, so without a grant the archive arm would observe
  // `SemanticOperationConfirmationRequiredError` and prove nothing about the
  // parent guard.
  const invoke = (
    operationId: string,
    input: Readonly<Record<string, unknown>>,
    confirmed = false,
  ) =>
    runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
      runtime.operationGateway.invoke(
        view,
        {
          confirmationGrant: confirmed
            ? runtime.operationMediation.issueConfirmationGrant(
                view,
                operationId,
                input as ImmutableJsonValue,
              )
            : null,
          idempotencyKey: randomUUID(),
          input,
          operationId,
          schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
        },
        runtime.operationMediation.issueInvocation(view, 'UI'),
      ),
    );

  const orderId = randomUUID();
  await invoke(purchasing.createOperationId, {
    legalEntityId,
    recordId: orderId,
    relations: {},
    values: {
      [purchasing.fieldIds.currency]: 'CAD',
      [purchasing.fieldIds.expectedDate]: '2026-09-01T00:00:00.000Z',
      [purchasing.fieldIds.notes]: 'parent guard vertical',
      [purchasing.fieldIds.number]: 'PO-GUARD-001',
      [purchasing.fieldIds.orderDate]: '2026-08-22T00:00:00.000Z',
      [purchasing.fieldIds.supplierPartyId]: 'SUP-GUARD-001',
    },
  });

  const lineId = randomUUID();
  const lineValues = {
    [purchasing.fieldIds.itemId]: 'ITEM-GUARD-001',
    [purchasing.fieldIds.lineNumber]: '1',
    [purchasing.fieldIds.orderedQuantity]: '10',
    // Canonical decimal: no trailing zero. `2.50` is refused by the compiled
    // value contract, `2.5` is the same number written canonically.
    [purchasing.fieldIds.unitPrice]: '2.5',
  } as const;
  await invoke(purchasing.lineCreateOperationId, {
    legalEntityId,
    recordId: lineId,
    relations: { [purchasing.lineRelationId]: orderId },
    values: lineValues,
  });

  // THE ADMISSION TWIN. Without it, every refusal below is satisfiable by a
  // line that could never be mutated in any state.
  await invoke(purchasing.lineUpdateOperationId, {
    expectedRevision: 1,
    patch: { [purchasing.fieldIds.orderedQuantity]: '11' },
    recordId: lineId,
  });

  // A SECOND line, archived while the parent is still draft, so the release
  // below can be followed by a RESTORE attempt. Restore is its own generic
  // operation and its own interpreter branch, and an earlier version of this
  // vertical claimed "every line mutation" while never invoking it -- a claim
  // wider than its evidence, and a one-property survivor: deleting only the
  // `requireExistingParentGuards` call from the `restoreRecordEffect` branch
  // would have left this test green.
  const archivedLineId = randomUUID();
  await invoke(purchasing.lineCreateOperationId, {
    legalEntityId,
    recordId: archivedLineId,
    relations: { [purchasing.lineRelationId]: orderId },
    values: { ...lineValues, [purchasing.fieldIds.lineNumber]: '2' },
  });
  await invoke(
    `${APPLICATION_IDS.namespace}:operation.purchase_order_line_archive`,
    { expectedRevision: 1, recordId: archivedLineId },
    true,
  );

  const lineEntity = storage.entities.find(
    (candidate) =>
      candidate.entityId === purchasing.entityIds.purchaseOrderLine,
  );
  assert.ok(lineEntity);
  const quantityColumn = lineEntity.columns.find(
    (column) => column.canonicalFieldId === purchasing.fieldIds.orderedQuantity,
  );
  assert.ok(quantityColumn);
  const readLine = async (recordId: string = lineId) => {
    const result = await pool.query<{
      archived: boolean;
      quantity: string;
      revision: string;
    }>(
      `SELECT "${lineEntity.archive.archivedAtColumn}" IS NOT NULL AS archived,
              "${quantityColumn.physicalName}"::text AS quantity,
              "${lineEntity.optimisticRevision.column}"::text AS revision
         FROM north_star_module.${lineEntity.physicalTableName}
        WHERE "${lineEntity.recordIdentity.column}" = $1`,
      [recordId],
    );
    assert.equal(result.rowCount, 1);
    return result.rows[0]!;
  };
  const admitted = await readLine();
  const archivedAdmitted = await readLine(archivedLineId);
  assert.equal(
    archivedAdmitted.archived,
    true,
    'the archive admission twin must have written',
  );
  assert.equal(admitted.revision, '2', 'the admission twin must have written');
  assert.equal(admitted.archived, false);

  await invoke(purchasing.releaseOperationId, {
    expectedRevision: 1,
    recordId: orderId,
  });

  const refused = async (
    label: string,
    operationId: string,
    input: Readonly<Record<string, unknown>>,
    confirmed = false,
  ) => {
    await assert.rejects(
      invoke(operationId, input, confirmed),
      (error: unknown) => {
        assert.ok(
          error instanceof ModuleRuntimeInterpreterError,
          `${label}: ${String(error)}`,
        );
        assert.equal(
          error.code,
          'MODULE_OPERATION_PRECONDITION_REFUSED',
          `${label} was refused for the wrong reason: ${error.code}`,
        );
        return true;
      },
    );
  };

  await refused('line update after release', purchasing.lineUpdateOperationId, {
    expectedRevision: 2,
    patch: { [purchasing.fieldIds.orderedQuantity]: '99' },
    recordId: lineId,
  });
  await refused(
    'line archive after release',
    `${APPLICATION_IDS.namespace}:operation.purchase_order_line_archive`,
    { expectedRevision: 2, recordId: lineId },
    true,
  );
  await refused('line create after release', purchasing.lineCreateOperationId, {
    legalEntityId,
    recordId: randomUUID(),
    relations: { [purchasing.lineRelationId]: orderId },
    values: lineValues,
  });
  await refused(
    'line restore after release',
    `${APPLICATION_IDS.namespace}:operation.purchase_order_line_restore`,
    { expectedRevision: 2, recordId: archivedLineId },
  );
  // The header itself is closed by the same predicate, evaluated on its own
  // prior image rather than through the relation.
  await refused('header update after release', purchasing.updateOperationId, {
    expectedRevision: 2,
    patch: { [purchasing.fieldIds.notes]: 'edited after release' },
    recordId: orderId,
  });

  // Nothing moved, on EITHER line. Revision, value and archive state are all as
  // the two admission twins left them -- so the archived line is still archived
  // and the active one still active.
  assert.deepEqual(
    await readLine(),
    admitted,
    'a refused mutation still changed the active line',
  );
  assert.deepEqual(
    await readLine(archivedLineId),
    archivedAdmitted,
    'the refused restore still changed the archived line',
  );
}

async function assertEntityOwnedCreateInput(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
): Promise<void> {
  const compiled =
    parseCompiledApplication(compiledApplication).application.compiled;
  const storage = storageTarget(compiled);
  const master = storage.entities.find(
    (candidate) => candidate.legalEntityMaster !== undefined,
  );
  const transaction = storage.entities.find(
    (candidate) =>
      candidate.entityId === 'northstar.app:entity.inventory_transaction',
  );
  assert.ok(master?.legalEntityMaster);
  assert.ok(transaction?.legalEntity);
  const defaultEntity = await pool.query<{ legal_entity_id: string }>(
    `SELECT "${master.recordIdentity.column}"::text AS legal_entity_id
       FROM north_star_module.${master.physicalTableName}
      WHERE tenant_id = $1 AND environment_id = $2
        AND "${master.legalEntityMaster.fieldColumns.isDefault}" IS TRUE
        AND "${master.archive.archivedAtColumn}" IS NULL`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  assert.equal(defaultEntity.rowCount, 1);
  const legalEntityId = defaultEntity.rows[0]?.legal_entity_id;
  assert.ok(legalEntityId);

  const values = {
    'northstar.app:field.inventory_transaction_actor_id': 'write-scope-control',
    'northstar.app:field.inventory_transaction_effective_at':
      '2026-08-01T12:00:00.000Z',
    'northstar.app:field.inventory_transaction_number': 'DRAFT-SCOPE-001',
    'northstar.app:field.inventory_transaction_recorded_at':
      '2026-08-01T12:00:00.000Z',
    'northstar.app:field.inventory_transaction_source_id':
      'write-scope-control',
    'northstar.app:field.inventory_transaction_source_type': 'test',
    'northstar.app:field.inventory_transaction_state':
      'northstar.app:option.inventory_transaction_state_draft',
    'northstar.app:field.inventory_transaction_type':
      'northstar.app:option.inventory_transaction_type_adjustment',
  } as const;
  const invokeCreate = (
    recordId: string,
    input: Readonly<Record<string, unknown>>,
    idempotencyKey: string = randomUUID(),
    createValues: Readonly<Record<string, unknown>> = values,
  ) =>
    runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
      runtime.operationGateway.invoke(
        view,
        {
          confirmationGrant: null,
          idempotencyKey,
          input: {
            recordId,
            relations: {},
            values: createValues,
            ...input,
          },
          operationId: 'northstar.app:operation.inventory_transaction_create',
          schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
        },
        runtime.operationMediation.issueInvocation(view, 'UI'),
      ),
    );

  const omittedRecordId = randomUUID();
  await assert.rejects(invokeCreate(omittedRecordId, {}), (error: unknown) => {
    assert.ok(error instanceof ModuleRuntimeInterpreterError);
    assert.equal(error.code, 'MODULE_REQUIRED_SYSTEM_INPUT_MISSING');
    assert.equal(error.subjectId, 'legalEntityId');
    return true;
  });
  const omitted = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM north_star_module.${transaction.physicalTableName}
      WHERE tenant_id = $1 AND environment_id = $2
        AND "${transaction.recordIdentity.column}" = $3`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      omittedRecordId,
    ],
  );
  assert.equal(
    omitted.rows[0]?.count,
    '0',
    'omission neither defaults nor inserts a partial row',
  );

  const recordId = randomUUID();
  const idempotencyKey = randomUUID();
  const created = await invokeCreate(
    recordId,
    { legalEntityId },
    idempotencyKey,
  );
  assert.equal(created.outcome, 'succeeded');
  const replayed = await invokeCreate(
    recordId,
    { legalEntityId },
    idempotencyKey,
  );
  assert.deepEqual(
    replayed.trust,
    created.trust,
    'the same effective input retains one stable idempotency identity',
  );
  await assert.rejects(
    invokeCreate(recordId, { legalEntityId: randomUUID() }, idempotencyKey),
    (error: unknown) => {
      assert.ok(error instanceof TrustEvidenceError);
      assert.equal(error.code, 'SEMANTIC_OPERATION_IDEMPOTENCY_CONFLICT');
      return true;
    },
  );
  const stored = await pool.query<{ legal_entity_id: string }>(
    `SELECT "${transaction.legalEntity.column}"::text AS legal_entity_id
       FROM north_star_module.${transaction.physicalTableName}
      WHERE tenant_id = $1 AND environment_id = $2
        AND "${transaction.recordIdentity.column}" = $3`,
    [runtime.identity.tenantId, runtime.identity.environmentId, recordId],
  );
  assert.deepEqual(stored.rows, [{ legal_entity_id: legalEntityId }]);

  const unscopedValues = {
    'northstar.app:field.legal_entity_code': 'LE-UNSCOPED-TWIN',
    'northstar.app:field.legal_entity_is_default': false,
    'northstar.app:field.legal_entity_name': 'Unscoped admission twin',
    'northstar.app:field.legal_entity_status':
      master.legalEntityMaster.activeStatusValue,
  } as const;
  const invokeUnscopedCreate = (
    unscopedRecordId: string,
    extra: Readonly<Record<string, unknown>>,
    createValues: Readonly<Record<string, unknown>> = unscopedValues,
  ) =>
    runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
      runtime.operationGateway.invoke(
        view,
        {
          confirmationGrant: null,
          idempotencyKey: randomUUID(),
          input: {
            recordId: unscopedRecordId,
            relations: {},
            values: createValues,
            ...extra,
          },
          operationId: 'northstar.app:operation.legal_entity_create',
          schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
        },
        runtime.operationMediation.issueInvocation(view, 'UI'),
      ),
    );
  await assert.rejects(
    invokeUnscopedCreate(randomUUID(), { legalEntityId }),
    (error: unknown) => {
      assert.ok(error instanceof ModuleRuntimeInterpreterError);
      assert.equal(error.code, 'MODULE_INPUT_MALFORMED');
      return true;
    },
  );
  assert.equal(
    (await invokeUnscopedCreate(randomUUID(), {})).outcome,
    'succeeded',
    'the unscoped refusal is discriminating rather than a create wall',
  );

  const statusColumn = master.columns.find(
    (column) =>
      column.physicalName === master.legalEntityMaster?.fieldColumns.status,
  );
  assert.ok(statusColumn);
  const inactiveStatus = statusColumn.fieldContract.enumOptionIds.find(
    (optionId) => optionId !== master.legalEntityMaster?.activeStatusValue,
  );
  assert.ok(inactiveStatus);
  const inactiveRecordId = randomUUID();
  const inactiveIdempotencyKey = randomUUID();
  const inactiveValues = {
    ...values,
    'northstar.app:field.inventory_transaction_number': 'DRAFT-SCOPE-INACTIVE',
  } as const;
  await pool.query(
    `UPDATE north_star_module.${master.physicalTableName}
        SET "${master.legalEntityMaster.fieldColumns.status}" = $1
      WHERE tenant_id = $2 AND environment_id = $3
        AND "${master.recordIdentity.column}" = $4`,
    [
      inactiveStatus,
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      legalEntityId,
    ],
  );
  try {
    await assert.rejects(
      invokeCreate(
        inactiveRecordId,
        { legalEntityId },
        inactiveIdempotencyKey,
        inactiveValues,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ModuleRuntimeInterpreterError);
        assert.equal(error.code, 'MODULE_LEGAL_ENTITY_CREATE_INACTIVE');
        assert.equal(error.subjectId, legalEntityId);
        return true;
      },
    );
    const refused = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM north_star_module.${transaction.physicalTableName}
        WHERE tenant_id = $1 AND environment_id = $2
          AND "${transaction.recordIdentity.column}" = $3`,
      [
        runtime.identity.tenantId,
        runtime.identity.environmentId,
        inactiveRecordId,
      ],
    );
    assert.equal(refused.rows[0]?.count, '0');
  } finally {
    await pool.query(
      `UPDATE north_star_module.${master.physicalTableName}
          SET "${master.legalEntityMaster.fieldColumns.status}" = $1
        WHERE tenant_id = $2 AND environment_id = $3
          AND "${master.recordIdentity.column}" = $4`,
      [
        master.legalEntityMaster.activeStatusValue,
        runtime.identity.tenantId,
        runtime.identity.environmentId,
        legalEntityId,
      ],
    );
  }
  assert.equal(
    (
      await invokeCreate(
        inactiveRecordId,
        { legalEntityId },
        inactiveIdempotencyKey,
        inactiveValues,
      )
    ).outcome,
    'succeeded',
    'the identical request is admitted after the business-status fact changes from inactive to active',
  );

  const invokeArchive = (archivedLegalEntityId: string) => {
    const input = Object.freeze({
      expectedRevision: 1,
      recordId: archivedLegalEntityId,
    });
    const operationId = 'northstar.app:operation.legal_entity_archive';
    return runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
      runtime.operationGateway.invoke(
        view,
        {
          confirmationGrant: runtime.operationMediation.issueConfirmationGrant(
            view,
            operationId,
            input,
          ),
          idempotencyKey: randomUUID(),
          input,
          operationId,
          schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
        },
        runtime.operationMediation.issueInvocation(view, 'UI'),
      ),
    );
  };
  const createLegalEntity = (
    legalEntityRecordId: string,
    code: string,
    name: string,
  ) =>
    invokeUnscopedCreate(
      legalEntityRecordId,
      {},
      {
        ...unscopedValues,
        'northstar.app:field.legal_entity_code': code,
        'northstar.app:field.legal_entity_name': name,
      },
    );
  const lockLegalEntity = async (lockedLegalEntityId: string) => {
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      `SELECT 1
         FROM north_star_module.${master.physicalTableName}
        WHERE tenant_id = $1 AND environment_id = $2
          AND "${master.recordIdentity.column}" = $3
        FOR UPDATE`,
      [
        runtime.identity.tenantId,
        runtime.identity.environmentId,
        lockedLegalEntityId,
      ],
    );
    return blocker;
  };

  const archiveFirstLegalEntityId = randomUUID();
  await createLegalEntity(
    archiveFirstLegalEntityId,
    'LE-ARCHIVE-FIRST',
    'Archive-first legal entity',
  );
  const archiveFirstRecordId = randomUUID();
  const archiveFirstIdempotencyKey = randomUUID();
  const archiveFirstBlocker = await lockLegalEntity(archiveFirstLegalEntityId);
  let archiveFirstBlockerOpen = true;
  let archiveFirstAttempt: Promise<unknown> | undefined;
  let archiveFirstCreate: Promise<unknown> | undefined;
  try {
    archiveFirstAttempt = invokeArchive(archiveFirstLegalEntityId);
    void archiveFirstAttempt.catch(() => undefined);
    await waitForLegalEntityMasterLockWaiters(
      pool,
      master.physicalTableName,
      1,
    );
    archiveFirstCreate = invokeCreate(
      archiveFirstRecordId,
      { legalEntityId: archiveFirstLegalEntityId },
      archiveFirstIdempotencyKey,
      {
        ...values,
        'northstar.app:field.inventory_transaction_number':
          'DRAFT-SCOPE-ARCHIVE-FIRST',
      },
    );
    void archiveFirstCreate.catch(() => undefined);
    await waitForLegalEntityMasterLockWaiters(
      pool,
      master.physicalTableName,
      2,
    );
    await archiveFirstBlocker.query('COMMIT');
    archiveFirstBlockerOpen = false;
    assert.equal(
      ((await archiveFirstAttempt) as { outcome?: string }).outcome,
      'succeeded',
    );
    await assert.rejects(archiveFirstCreate, (error: unknown) => {
      assert.ok(error instanceof ModuleRuntimeInterpreterError);
      assert.equal(error.code, 'MODULE_LEGAL_ENTITY_CREATE_INACTIVE');
      assert.equal(error.subjectId, archiveFirstLegalEntityId);
      return true;
    });
  } finally {
    if (archiveFirstBlockerOpen) {
      await archiveFirstBlocker.query('ROLLBACK');
    }
    archiveFirstBlocker.release();
    await Promise.allSettled(
      [archiveFirstAttempt, archiveFirstCreate].filter(
        (attempt): attempt is Promise<unknown> => attempt !== undefined,
      ),
    );
  }
  const archiveFirstState = await pool.query<{
    archived: boolean;
    business_rows: string;
    receipts: string;
    status: string;
  }>(
    `SELECT "${master.legalEntityMaster.fieldColumns.status}"::text AS status,
            "${master.archive.archivedAtColumn}" IS NOT NULL AS archived,
            (SELECT count(*)::text
               FROM north_star_module.${transaction.physicalTableName}
              WHERE tenant_id = $1 AND environment_id = $2
                AND "${transaction.recordIdentity.column}" = $4) AS business_rows,
            (SELECT count(*)::text
               FROM platform.semantic_operation_receipts
              WHERE tenant_id = $1 AND environment_id = $2
                AND action_id = 'northstar.app:operation.inventory_transaction_create'
                AND idempotency_key = $5) AS receipts
       FROM north_star_module.${master.physicalTableName}
      WHERE tenant_id = $1 AND environment_id = $2
        AND "${master.recordIdentity.column}" = $3`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      archiveFirstLegalEntityId,
      archiveFirstRecordId,
      archiveFirstIdempotencyKey,
    ],
  );
  assert.deepEqual(archiveFirstState.rows, [
    {
      archived: true,
      business_rows: '0',
      receipts: '0',
      status: master.legalEntityMaster.activeStatusValue,
    },
  ]);

  const createFirstLegalEntityId = randomUUID();
  await createLegalEntity(
    createFirstLegalEntityId,
    'LE-CREATE-FIRST',
    'Create-first legal entity',
  );
  const createFirstBlocker = await lockLegalEntity(createFirstLegalEntityId);
  let createFirstBlockerOpen = true;
  let createFirstAttempt: Promise<unknown> | undefined;
  let createFirstArchive: Promise<unknown> | undefined;
  try {
    createFirstAttempt = invokeCreate(
      randomUUID(),
      { legalEntityId: createFirstLegalEntityId },
      randomUUID(),
      {
        ...values,
        'northstar.app:field.inventory_transaction_number':
          'DRAFT-SCOPE-CREATE-FIRST',
      },
    );
    void createFirstAttempt.catch(() => undefined);
    await waitForLegalEntityMasterLockWaiters(
      pool,
      master.physicalTableName,
      1,
    );
    createFirstArchive = invokeArchive(createFirstLegalEntityId);
    void createFirstArchive.catch(() => undefined);
    await waitForLegalEntityMasterLockWaiters(
      pool,
      master.physicalTableName,
      2,
    );
    await createFirstBlocker.query('COMMIT');
    createFirstBlockerOpen = false;
    assert.equal(
      ((await createFirstAttempt) as { outcome?: string }).outcome,
      'succeeded',
    );
    assert.equal(
      ((await createFirstArchive) as { outcome?: string }).outcome,
      'succeeded',
    );
  } finally {
    if (createFirstBlockerOpen) {
      await createFirstBlocker.query('ROLLBACK');
    }
    createFirstBlocker.release();
    await Promise.allSettled(
      [createFirstAttempt, createFirstArchive].filter(
        (attempt): attempt is Promise<unknown> => attempt !== undefined,
      ),
    );
  }
  const postArchiveRecordId = randomUUID();
  const postArchiveIdempotencyKey = randomUUID();
  await assert.rejects(
    invokeCreate(
      postArchiveRecordId,
      { legalEntityId: createFirstLegalEntityId },
      postArchiveIdempotencyKey,
      {
        ...values,
        'northstar.app:field.inventory_transaction_number':
          'DRAFT-SCOPE-POST-ARCHIVE',
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ModuleRuntimeInterpreterError);
      assert.equal(error.code, 'MODULE_LEGAL_ENTITY_CREATE_INACTIVE');
      assert.equal(error.subjectId, createFirstLegalEntityId);
      return true;
    },
  );
  const postArchivePersistence = await pool.query<{
    business_rows: string;
    receipts: string;
  }>(
    `SELECT
       (SELECT count(*)::text
          FROM north_star_module.${transaction.physicalTableName}
         WHERE tenant_id = $1 AND environment_id = $2
           AND "${transaction.recordIdentity.column}" = $3) AS business_rows,
       (SELECT count(*)::text
          FROM platform.semantic_operation_receipts
         WHERE tenant_id = $1 AND environment_id = $2
           AND action_id = 'northstar.app:operation.inventory_transaction_create'
           AND idempotency_key = $4) AS receipts`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      postArchiveRecordId,
      postArchiveIdempotencyKey,
    ],
  );
  assert.deepEqual(postArchivePersistence.rows, [
    { business_rows: '0', receipts: '0' },
  ]);
}

async function waitForLegalEntityMasterLockWaiters(
  pool: pg.Pool,
  physicalTableName: string,
  expected: number,
): Promise<void> {
  const deadline = process.hrtime.bigint() + 10_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    const waiting = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE $1
          AND query LIKE '%FOR NO KEY UPDATE%'`,
      [`%${physicalTableName}%`],
    );
    if (Number(waiting.rows[0]?.count ?? 0) >= expected) return;
    await new Promise<void>((resolveImmediate) =>
      setImmediate(resolveImmediate),
    );
  }
  throw new Error(
    `expected ${expected} provider transaction(s) waiting on legal-entity master ${physicalTableName}`,
  );
}

async function assertInventoryPostingCapabilityRoute(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
): Promise<void> {
  const compiled =
    parseCompiledApplication(compiledApplication).application.compiled;
  const storage = storageTarget(compiled);
  const postingScenario = releaseVerificationBinding(
    compiled,
  ).plan.scenarios.find(
    (scenario) =>
      scenario.kind === 'declaredEvidence' &&
      scenario.assertionId ===
        'northstar.app:assertion.inventory_transaction_post_refusal',
  );
  assert.ok(postingScenario);
  const executedProbe = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM platform.tenant_release_admissions AS admission
       JOIN platform.release_verification_results AS result
         ON result.tenant_id = admission.tenant_id
        AND result.environment_id = admission.environment_id
        AND result.verification_evidence_id = admission.verification_evidence_id
      WHERE admission.tenant_id = $1
        AND admission.environment_id = $2
        AND admission.release_id = $3
        AND result.scenario_id = $4`,
    [
      runtime.identity.tenantId,
      runtime.identity.environmentId,
      runtime.activeReleaseId,
      postingScenario.scenarioId,
    ],
  );
  assert.deepEqual(
    executedProbe.rows,
    [{ count: '1' }],
    'the capability refusal has an executed result rather than a derivation or skip',
  );
  const transaction = requiredStorageEntity(storage, 'inventory_transaction');
  const movement = requiredStorageEntity(storage, 'inventory_movement');
  assert.ok(transaction.legalEntity);
  const legalEntityId = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
  const itemId = randomUUID();
  const locationId = randomUUID();
  const transactionId = randomUUID();
  const lineId = randomUUID();
  const suffix = transactionId.slice(0, 8);
  const effectiveAt = new Date().toISOString();
  const sourceId = `postroute-${suffix}`;

  const create = (
    operationId: string,
    recordId: string,
    values: Readonly<Record<string, unknown>>,
    options: Readonly<{
      legalEntityId?: string;
      relations?: Readonly<Record<string, string>>;
    }> = {},
  ) =>
    runtime.entry.run(
      { headers: { authorization: 'postroute-control' } },
      (view) =>
        runtime.operationGateway.invoke(
          view,
          {
            confirmationGrant: null,
            idempotencyKey: randomUUID(),
            input: {
              ...(options.legalEntityId
                ? { legalEntityId: options.legalEntityId }
                : {}),
              recordId,
              relations: options.relations ?? {},
              values,
            },
            operationId,
            schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
          },
          runtime.operationMediation.issueInvocation(view, 'UI'),
        ),
    );

  assert.equal(
    (
      await create('northstar.app:operation.item_create', itemId, {
        'northstar.app:field.item_base_unit': 'EA',
        'northstar.app:field.item_description': 'Posting route control item',
        'northstar.app:field.item_name': `Posting route ${suffix}`,
        'northstar.app:field.item_sku': `POST-${suffix}`,
      })
    ).outcome,
    'succeeded',
  );
  assert.equal(
    (
      await create('northstar.app:operation.location_create', locationId, {
        'northstar.app:field.location_code': `POST-${suffix}`,
        'northstar.app:field.location_name': `Posting route ${suffix}`,
        'northstar.app:field.location_type': 'northstar.app:option.warehouse',
      })
    ).outcome,
    'succeeded',
  );
  const createdTransaction = await create(
    'northstar.app:operation.inventory_transaction_create',
    transactionId,
    {
      'northstar.app:field.inventory_transaction_actor_id': 'postroute-control',
      'northstar.app:field.inventory_transaction_effective_at': effectiveAt,
      'northstar.app:field.inventory_transaction_number': `ADJ-${suffix}`,
      'northstar.app:field.inventory_transaction_reason_code': 'adjustment',
      'northstar.app:field.inventory_transaction_reason_narrative':
        'Registered capability route control',
      'northstar.app:field.inventory_transaction_recorded_at': effectiveAt,
      'northstar.app:field.inventory_transaction_source_id': sourceId,
      'northstar.app:field.inventory_transaction_source_type': 'test',
      'northstar.app:field.inventory_transaction_state':
        'northstar.app:option.inventory_transaction_state_draft',
      'northstar.app:field.inventory_transaction_type':
        'northstar.app:option.inventory_transaction_type_adjustment',
    },
    { legalEntityId },
  );
  assert.equal(createdTransaction.readBack?.revision, 1);
  assert.equal(
    (
      await create(
        'northstar.app:operation.inventory_transaction_line_create',
        lineId,
        {
          'northstar.app:field.inventory_transaction_line_from_location_id':
            null,
          'northstar.app:field.inventory_transaction_line_item_id': itemId,
          'northstar.app:field.inventory_transaction_line_line_number': '1',
          'northstar.app:field.inventory_transaction_line_quantity': '7',
          'northstar.app:field.inventory_transaction_line_to_location_id':
            locationId,
          'northstar.app:field.inventory_transaction_line_unit_id': 'EA',
        },
        {
          legalEntityId,
          relations: {
            'northstar.app:relation.inventory_transaction_line_transaction':
              transactionId,
          },
        },
      )
    ).outcome,
    'succeeded',
  );

  const idempotencyKey = randomUUID();
  const input = Object.freeze({ expectedRevision: 1, recordId: transactionId });
  const grants: string[] = [];
  const post = () =>
    runtime.entry.run(
      { headers: { authorization: 'postroute-control' } },
      (view) => {
        const confirmationGrant =
          runtime.operationMediation.issueConfirmationGrant(
            view,
            'northstar.app:operation.inventory_transaction_post',
            input,
          );
        grants.push(confirmationGrant);
        return runtime.operationGateway.invoke(
          view,
          {
            confirmationGrant,
            idempotencyKey,
            input,
            operationId: 'northstar.app:operation.inventory_transaction_post',
            schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
          },
          runtime.operationMediation.issueInvocation(view, 'UI'),
        );
      },
    );
  const posted = await post();
  const replayed = await post();
  assert.equal(posted.outcome, 'succeeded');
  assert.equal(posted.readBack?.revision, 2);
  assert.deepEqual(replayed.trust, posted.trust);
  assert.deepEqual(
    grants,
    [grants[0], grants[0]],
    'the same rendered command input produces the same server confirmation grant',
  );

  const movementSourceColumn = requiredStorageColumn(
    movement,
    'inventory_movement_source_id',
  );
  const movementQuantityColumn = requiredStorageColumn(
    movement,
    'inventory_movement_quantity_delta',
  );
  const movements = await pool.query<{ quantity: string }>(
    `SELECT ${quoteSqlIdentifier(movementQuantityColumn)}::text AS quantity
       FROM north_star_module.${quoteSqlIdentifier(movement.physicalTableName)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoteSqlIdentifier(movementSourceColumn)} = $3`,
    [runtime.identity.tenantId, runtime.identity.environmentId, sourceId],
  );
  assert.deepEqual(
    movements.rows,
    [{ quantity: '7.000000000000000000' }],
    'the registered route appends one movement and replay appends none',
  );
  const stateColumn = requiredStorageColumn(
    transaction,
    'inventory_transaction_state',
  );
  const storedTransaction = await pool.query<{
    revision: number;
    state: string;
  }>(
    `SELECT ${quoteSqlIdentifier(transaction.optimisticRevision.column)}::integer AS revision,
            ${quoteSqlIdentifier(stateColumn)}::text AS state
       FROM north_star_module.${quoteSqlIdentifier(transaction.physicalTableName)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoteSqlIdentifier(transaction.recordIdentity.column)} = $3`,
    [runtime.identity.tenantId, runtime.identity.environmentId, transactionId],
  );
  assert.deepEqual(storedTransaction.rows, [
    {
      revision: 2,
      state: 'northstar.app:option.inventory_transaction_state_posted',
    },
  ]);
}

async function assertInventoryPostingAuthorizationBoundaries(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
): Promise<void> {
  const compiled =
    parseCompiledApplication(compiledApplication).application.compiled;
  const storage = storageTarget(compiled);
  const transaction = requiredStorageEntity(storage, 'inventory_transaction');
  const movement = requiredStorageEntity(storage, 'inventory_movement');
  const legalEntity = requiredStorageEntity(storage, 'legal_entity');
  assert.ok(transaction.legalEntity);
  assert.ok(legalEntity.legalEntityMaster);
  const tenantEnvironment = [
    runtime.identity.tenantId,
    runtime.identity.environmentId,
  ];
  const role = await pool.query<{ role_id: string }>(
    `SELECT role_id
       FROM platform.current_policy_roles
      WHERE tenant_id = $1 AND environment_id = $2
        AND role_key = 'local-demo-full-release'`,
    tenantEnvironment,
  );
  const roleId = role.rows[0]?.role_id;
  assert.ok(roleId);
  const membership = await pool.query<{ membership_id: string }>(
    `SELECT membership_id
       FROM platform.current_policy_memberships
      WHERE tenant_id = $1 AND environment_id = $2
        AND principal_id = $3 AND role_id = $4`,
    [...tenantEnvironment, runtime.identity.principalId, roleId],
  );
  const membershipId = membership.rows[0]?.membership_id;
  assert.ok(membershipId);
  const readPermission = 'northstar.app:permission.inventory_transaction_read';
  const postOperation = 'northstar.app:operation.inventory_transaction_post';
  const entityA = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
  const entityB = randomUUID();
  const itemId = randomUUID();
  const locationId = randomUUID();

  const create = (
    operationId: string,
    recordId: string,
    values: Readonly<Record<string, unknown>>,
    options: Readonly<{
      legalEntityId?: string;
      relations?: Readonly<Record<string, string>>;
    }> = {},
  ) =>
    runtime.entry.run({ headers: { authorization: 'auth-review' } }, (view) =>
      runtime.operationGateway.invoke(
        view,
        {
          confirmationGrant: null,
          idempotencyKey: randomUUID(),
          input: {
            ...(options.legalEntityId
              ? { legalEntityId: options.legalEntityId }
              : {}),
            recordId,
            relations: options.relations ?? {},
            values,
          },
          operationId,
          schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
        },
        runtime.operationMediation.issueInvocation(view, 'UI'),
      ),
    );
  const setReadGrant = (revoked: boolean) =>
    pool.query(
      `UPDATE platform.current_policy_permission_grants
          SET revoked_at = CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END
        WHERE tenant_id = $1 AND environment_id = $2 AND role_id = $3
          AND permission_id = $4`,
      [...tenantEnvironment, roleId, readPermission, revoked],
    );
  const setMembershipScope = (legalEntityId: string | null) =>
    pool.query(
      `UPDATE platform.current_policy_memberships
          SET legal_entity_id = $4
        WHERE tenant_id = $1 AND environment_id = $2 AND membership_id = $3`,
      [...tenantEnvironment, membershipId, legalEntityId],
    );
  const seedDraft = async (legalEntityId: string, label: string) => {
    const recordId = randomUUID();
    const lineId = randomUUID();
    const sourceId = `auth-review-${label.toLowerCase()}-${recordId.slice(0, 8)}`;
    const effectiveAt = new Date().toISOString();
    await create(
      'northstar.app:operation.inventory_transaction_create',
      recordId,
      {
        'northstar.app:field.inventory_transaction_actor_id': 'auth-review',
        'northstar.app:field.inventory_transaction_effective_at': effectiveAt,
        'northstar.app:field.inventory_transaction_number': `AUTH-${label}-${recordId.slice(0, 8)}`,
        'northstar.app:field.inventory_transaction_reason_code': 'adjustment',
        'northstar.app:field.inventory_transaction_reason_narrative':
          'Focused authorization review regression',
        'northstar.app:field.inventory_transaction_recorded_at': effectiveAt,
        'northstar.app:field.inventory_transaction_source_id': sourceId,
        'northstar.app:field.inventory_transaction_source_type': 'test',
        'northstar.app:field.inventory_transaction_state':
          'northstar.app:option.inventory_transaction_state_draft',
        'northstar.app:field.inventory_transaction_type':
          'northstar.app:option.inventory_transaction_type_adjustment',
      },
      { legalEntityId },
    );
    await create(
      'northstar.app:operation.inventory_transaction_line_create',
      lineId,
      {
        'northstar.app:field.inventory_transaction_line_from_location_id': null,
        'northstar.app:field.inventory_transaction_line_item_id': itemId,
        'northstar.app:field.inventory_transaction_line_line_number': '1',
        'northstar.app:field.inventory_transaction_line_quantity': '3',
        'northstar.app:field.inventory_transaction_line_to_location_id':
          locationId,
        'northstar.app:field.inventory_transaction_line_unit_id': 'EA',
      },
      {
        legalEntityId,
        relations: {
          'northstar.app:relation.inventory_transaction_line_transaction':
            recordId,
        },
      },
    );
    return Object.freeze({
      input: Object.freeze({ expectedRevision: 1, recordId }),
      recordId,
      sourceId,
    });
  };
  const post = (
    draft: Awaited<ReturnType<typeof seedDraft>>,
    input: Readonly<Record<string, unknown>> = draft.input,
  ): Promise<SemanticOperationResultEnvelope> =>
    runtime.entry.run({ headers: { authorization: 'auth-review' } }, (view) =>
      runtime.operationGateway.invoke(
        view,
        {
          confirmationGrant: runtime.operationMediation.issueConfirmationGrant(
            view,
            postOperation,
            input as ImmutableJsonValue,
          ),
          idempotencyKey: randomUUID(),
          input: input as ImmutableJsonValue,
          operationId: postOperation,
          schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
        },
        runtime.operationMediation.issueInvocation(view, 'UI'),
      ),
    );
  const movementCount = async (sourceId: string): Promise<number> => {
    const sourceColumn = requiredStorageColumn(
      movement,
      'inventory_movement_source_id',
    );
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM north_star_module.${quoteSqlIdentifier(movement.physicalTableName)}
        WHERE tenant_id = $1 AND environment_id = $2
          AND ${quoteSqlIdentifier(sourceColumn)} = $3`,
      [...tenantEnvironment, sourceId],
    );
    return Number(result.rows[0]?.count ?? '0');
  };
  const revision = async (recordId: string): Promise<number> => {
    const result = await pool.query<{ revision: number }>(
      `SELECT ${quoteSqlIdentifier(transaction.optimisticRevision.column)}::integer AS revision
         FROM north_star_module.${quoteSqlIdentifier(transaction.physicalTableName)}
        WHERE tenant_id = $1 AND environment_id = $2
          AND ${quoteSqlIdentifier(transaction.recordIdentity.column)} = $3`,
      [...tenantEnvironment, recordId],
    );
    assert.equal(result.rows.length, 1);
    return result.rows[0]!.revision;
  };
  const policyVersion = async (): Promise<string> => {
    const result = await pool.query<{ policy_version: string }>(
      `SELECT policy_version::text AS policy_version
         FROM platform.current_policy_epochs
        WHERE tenant_id = $1 AND environment_id = $2`,
      tenantEnvironment,
    );
    return `northstar.current-policy/${result.rows[0]?.policy_version ?? '0'}`;
  };
  const assertOneDenied = async (
    before: number,
    failureCode: string,
    forbidden: readonly string[],
  ): Promise<void> => {
    assert.equal(await deniedInvocationCount(pool, runtime), before + 1);
    const evidence = await pool.query<{
      failure_code: string;
      metadata: unknown;
      policy_inputs: unknown;
      policy_version: string;
    }>(
      `SELECT failure_code, metadata, policy_inputs, policy_version
         FROM platform.trust_action_invocations
        WHERE tenant_id = $1 AND environment_id = $2 AND outcome = 'DENIED'
        ORDER BY recorded_at DESC, invocation_id DESC
        LIMIT 1`,
      tenantEnvironment,
    );
    assert.equal(evidence.rows[0]?.failure_code, failureCode);
    assert.equal(evidence.rows[0]?.policy_version, await policyVersion());
    const serialized = JSON.stringify([
      evidence.rows[0]?.metadata,
      evidence.rows[0]?.policy_inputs,
    ]);
    for (const value of forbidden)
      assert.doesNotMatch(serialized, new RegExp(value, 'u'));
  };

  let revocationTriggerInstalled = false;
  try {
    await create('northstar.app:operation.item_create', itemId, {
      'northstar.app:field.item_base_unit': 'EA',
      'northstar.app:field.item_description': 'AUTH review item',
      'northstar.app:field.item_name': `AUTH review ${itemId.slice(0, 8)}`,
      'northstar.app:field.item_sku': `AUTH-${itemId.slice(0, 8)}`,
    });
    await create('northstar.app:operation.location_create', locationId, {
      'northstar.app:field.location_code': `AUTH-${locationId.slice(0, 8)}`,
      'northstar.app:field.location_name': 'AUTH review location',
      'northstar.app:field.location_type': 'northstar.app:option.warehouse',
    });
    await create('northstar.app:operation.legal_entity_create', entityB, {
      'northstar.app:field.legal_entity_code': `AUTH-${entityB.slice(0, 8)}`,
      'northstar.app:field.legal_entity_is_default': false,
      'northstar.app:field.legal_entity_name': 'AUTH review entity B',
      'northstar.app:field.legal_entity_status':
        legalEntity.legalEntityMaster.activeStatusValue,
    });

    const missingRead = await seedDraft(entityA, 'MISSING-READ');
    await setReadGrant(true);
    const missingReadDenied = await deniedInvocationCount(pool, runtime);
    let missingReadError: unknown;
    try {
      await post(missingRead);
    } catch (error) {
      missingReadError = error;
    }
    assert.equal(await movementCount(missingRead.sourceId), 0);
    assert.equal(await revision(missingRead.recordId), 1);
    assert.ok(missingReadError instanceof SemanticOperationPolicyDeniedError);
    await assertOneDenied(
      missingReadDenied,
      'SEMANTIC_OPERATION_POLICY_DENIED',
      [missingRead.recordId, missingRead.sourceId],
    );
    await setReadGrant(false);

    const scopedA = await seedDraft(entityA, 'ENTITY-A');
    const scopedB = await seedDraft(entityB, 'ENTITY-B');
    await setMembershipScope(entityA);
    const allowedA = await post(scopedA);
    assert.equal(allowedA.outcome, 'succeeded');
    assert.equal(allowedA.readBack?.revision, 2);
    const foreignDenied = await deniedInvocationCount(pool, runtime);
    await assert.rejects(post(scopedB), SemanticOperationPolicyDeniedError);
    assert.equal(await movementCount(scopedB.sourceId), 0);
    assert.equal(await revision(scopedB.recordId), 1);
    await assertOneDenied(foreignDenied, 'SEMANTIC_OPERATION_POLICY_DENIED', [
      scopedB.recordId,
      scopedB.sourceId,
    ]);
    await assert.rejects(
      post(scopedA, { ...scopedA.input, legalEntityId: entityA }),
      MalformedSemanticOperationRequestError,
    );

    const afterCommit = await seedDraft(entityA, 'AFTER-COMMIT');
    await pool.query(
      `CREATE FUNCTION platform.auth_review_revoke_read_after_post()
       RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
       SET search_path = pg_catalog, platform AS $$ BEGIN
         UPDATE platform.current_policy_permission_grants
            SET revoked_at = clock_timestamp()
          WHERE tenant_id = NEW.tenant_id
            AND environment_id = NEW.environment_id
            AND permission_id = 'northstar.app:permission.inventory_transaction_read'
            AND revoked_at IS NULL;
         RETURN NEW;
       END $$`,
    );
    await pool.query(
      `CREATE TRIGGER auth_review_revoke_read_after_post
       AFTER INSERT ON platform.semantic_operation_receipts
       FOR EACH ROW EXECUTE FUNCTION platform.auth_review_revoke_read_after_post()`,
    );
    revocationTriggerInstalled = true;
    const committedDenied = await deniedInvocationCount(pool, runtime);
    const committed = await post(afterCommit);
    assert.equal(committed.outcome, 'succeeded');
    assert.equal(committed.readBack, null);
    assert.ok(committed.trust);
    assert.equal(await movementCount(afterCommit.sourceId), 1);
    assert.equal(await revision(afterCommit.recordId), 2);
    await assertOneDenied(committedDenied, 'SEMANTIC_QUERY_POLICY_DENIED', [
      afterCommit.recordId,
      afterCommit.sourceId,
    ]);
  } finally {
    if (revocationTriggerInstalled) {
      await pool.query(
        'DROP TRIGGER auth_review_revoke_read_after_post ON platform.semantic_operation_receipts',
      );
      await pool.query(
        'DROP FUNCTION platform.auth_review_revoke_read_after_post()',
      );
    }
    await setReadGrant(false);
    await setMembershipScope(null);
  }
}

function requiredStorageEntity(
  storage: StorageTargetPayloadV1,
  localId: string,
): StorageTargetPayloadV1['entities'][number] {
  const matches = storage.entities.filter((entity) =>
    entity.entityId.endsWith(`:entity.${localId}`),
  );
  assert.equal(matches.length, 1);
  return matches[0]!;
}

function requiredStorageColumn(
  entity: StorageTargetPayloadV1['entities'][number],
  localId: string,
): string {
  const matches = entity.columns.filter((column) =>
    column.canonicalFieldId.endsWith(`:field.${localId}`),
  );
  assert.equal(matches.length, 1);
  return matches[0]!.physicalName;
}

function quoteSqlIdentifier(value: string): string {
  assert.match(value, /^[a-z][a-z0-9_]{0,62}$/u);
  return `"${value}"`;
}

async function assertVerificationFieldOriginCreates(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
): Promise<void> {
  const compiled =
    parseCompiledApplication(compiledApplication).application.compiled;
  const storage = storageTarget(compiled);
  const requiredSources = new Set([
    'northstar.app:entity.inventory_transaction_line',
    'northstar.app:entity.stock_count',
    'northstar.app:entity.stock_count_line',
  ]);
  const requiredFieldRelations = storage.relations.filter(
    (relation) =>
      requiredSources.has(relation.sourceEntityId) &&
      relation.relationColumn.origin === 'field' &&
      !relation.relationColumn.nullable,
  );
  assert.equal(requiredFieldRelations.length, 3);
  const quoted = (identifier: string) =>
    `"${identifier.replaceAll('"', '""')}"`;
  for (const relation of requiredFieldRelations) {
    const source = storage.entities.find(
      (entity) => entity.entityId === relation.sourceEntityId,
    );
    const target = storage.entities.find(
      (entity) => entity.entityId === relation.targetEntityId,
    );
    assert.ok(source);
    assert.ok(target);
    const join = relation.foreignKey.sourceColumns
      .map(
        (sourceColumn, index) =>
          `target.${quoted(relation.foreignKey.targetColumns[index]!)} = source.${quoted(sourceColumn)}`,
      )
      .join(' AND ');
    const rows = await pool.query<{
      reference_id: string;
      target_id: string | null;
    }>(
      `SELECT source.${quoted(relation.relationColumn.physicalName)}::text AS reference_id,
              target.${quoted(target.recordIdentity.column)}::text AS target_id
         FROM north_star_module.${quoted(source.physicalTableName)} AS source
         LEFT JOIN north_star_module.${quoted(target.physicalTableName)} AS target
           ON ${join}
        WHERE source.tenant_id = $1
          AND source.environment_id = $2
          AND source.${quoted(source.archive.archivedAtColumn)} IS NOT NULL
          AND source.${quoted(relation.relationColumn.physicalName)} IS NOT NULL`,
      [runtime.identity.tenantId, runtime.identity.environmentId],
    );
    assert.ok(
      rows.rows.length > 0,
      `${relation.sourceEntityId} produced no archived verification record`,
    );
    assert.equal(
      rows.rows.every((row) => row.reference_id === row.target_id),
      true,
      `${relation.relationId} did not persist its arranged target UUID`,
    );
  }

  const transactionLine = storage.entities.find(
    (entity) =>
      entity.entityId === 'northstar.app:entity.inventory_transaction_line',
  );
  assert.ok(transactionLine);
  const optionalFieldRelations = storage.relations.filter(
    (relation) =>
      relation.sourceEntityId === transactionLine.entityId &&
      relation.relationColumn.origin === 'field' &&
      relation.relationColumn.nullable,
  );
  assert.equal(optionalFieldRelations.length, 2);
  const unset = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM north_star_module.${quoted(transactionLine.physicalTableName)}
      WHERE tenant_id = $1
        AND environment_id = $2
        AND ${quoted(transactionLine.archive.archivedAtColumn)} IS NOT NULL
        AND ${optionalFieldRelations
          .map(
            (relation) =>
              `${quoted(relation.relationColumn.physicalName)} IS NULL`,
          )
          .join(' AND ')}`,
    [runtime.identity.tenantId, runtime.identity.environmentId],
  );
  assert.ok(
    Number(unset.rows[0]?.count ?? 0) > 0,
    'ordinary verification creates must persist optional field-origin references as NULL',
  );
}

/**
 * ADR-0033: the admitted composed product records an exact partition of the
 * compiler-emitted plan. Executed results and derivations are separate durable
 * counters, and their union is complete and disjoint.
 */
async function assertExactPartitionEvidence(
  pool: pg.Pool,
  runtime: ComposedApplicationRuntime,
  evidenceId: string,
  evidence: DurableReleaseVerificationEvidence,
  binding: Readonly<{
    compiled: CompileSuccess;
    plan: VerificationPlanPayloadV1;
  }>,
): Promise<void> {
  assert.equal(evidence.schemaVersion, 'northstar.verification-result-set/v2');
  assert.ok(
    'derivations' in evidence,
    'admitted composed evidence carries a derivation array',
  );
  const derivations = evidence.derivations;
  const executedScenarioIds = evidence.results.map(
    (result) => result.scenarioId,
  );
  const derivedScenarioIds = derivations.map(
    (derivation) => derivation.scenarioId,
  );
  assert.ok(evidence.results.length > 0, 'real PostgreSQL probes still ran');
  assert.ok(derivations.length > 0);
  // Measured on the combined governed release: 200 executed + 57 derived.
  // The independent constructibility oracle below still verifies every member.
  assert.equal(
    evidence.results.length,
    200,
    'receiving adds 49 executed scenarios to the prior 151',
  );
  assert.equal(
    derivations.length,
    57,
    'the 10 operationless received-projection scenarios join the prior 47 derivations',
  );
  assert.equal(
    binding.plan.scenarios.some(
      (scenario) =>
        scenario.kind === 'resolverAuthority' &&
        scenario.entityId === 'northstar.app:entity.inventory_period_lock',
    ),
    false,
    'inventory_period_lock_resolve is absent from the plan, not reclassified as a derivation',
  );
  assert.equal(
    derivations.filter(
      (derivation) =>
        derivation.reason.code ===
        'VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE',
    ).length,
    0,
    'no create-input derivation remains after the derived input is executable',
  );
  assert.equal(
    derivations.filter(
      (derivation) =>
        derivation.reason.code === 'VERIFICATION_NO_GENERIC_CREATE_OPERATION',
    ).length,
    57,
  );
  assert.deepEqual(
    [...executedScenarioIds, ...derivedScenarioIds].toSorted(),
    binding.plan.scenarios.map((scenario) => scenario.scenarioId).toSorted(),
    'executed results and derivations partition the emitted plan exactly',
  );
  assert.equal(
    new Set([...executedScenarioIds, ...derivedScenarioIds]).size,
    binding.plan.scenarios.length,
    'no scenario is both executed and derived',
  );
  assertIndependentConstructibilityPartition(
    binding.compiled,
    binding.plan,
    evidence,
  );
  const constructibleResult = evidence.results[0];
  const derivationTemplate = derivations[0];
  assert.ok(constructibleResult);
  assert.ok(derivationTemplate);
  const constructibleScenario = binding.plan.scenarios.find(
    (scenario) => scenario.scenarioId === constructibleResult.scenarioId,
  );
  assert.ok(constructibleScenario);
  const mislabelledPartition = {
    derivations: [
      ...derivations,
      {
        reason: {
          code: 'VERIFICATION_NO_GENERIC_CREATE_OPERATION' as const,
          entityId: constructibleScenario.entityId,
          message: 'well-formed but false no-create derivation',
        },
        scenarioFingerprint: constructibleScenario.scenarioFingerprint,
        scenarioId: constructibleScenario.scenarioId,
        schemaVersion: derivationTemplate.schemaVersion,
      },
    ],
    results: evidence.results.filter(
      (result) => result.scenarioId !== constructibleScenario.scenarioId,
    ),
  };
  assert.throws(
    () =>
      assertIndependentConstructibilityPartition(
        binding.compiled,
        binding.plan,
        mislabelledPartition,
      ),
    new RegExp(
      `constructible scenario ${constructibleScenario.scenarioId} was recorded as derived`,
      'u',
    ),
    'the independent oracle rejects a structurally valid derivation that mislabels a constructible scenario',
  );
  assert.equal(
    derivations.some(
      (derivation) =>
        derivation.reason.code ===
        'VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE',
    ),
    false,
    'the compiler-derived system input makes entity-owned scenarios executable',
  );
  assert.ok(
    derivations.some(
      (derivation) =>
        derivation.reason.code === 'VERIFICATION_NO_GENERIC_CREATE_OPERATION' &&
        derivation.reason.entityId ===
          'northstar.app:entity.inventory_movement',
    ),
    'the append-only fact without a generic create operation is recorded as a derivation',
  );
  const header = await pool.query<{
    closed_document: boolean;
    derived_count: number;
    evidence_version: string;
    execution_scope: string;
    impact_analysis_version: string;
    result_count: number;
    skipped_scenario_ids: unknown;
    stored_results: string;
  }>(
    `SELECT evidence.evidence_version,
            evidence.execution_scope,
            evidence.skipped_scenario_ids,
            evidence.result_count,
            evidence.impact_analysis_derivation ->> 'schemaVersion'
              AS impact_analysis_version,
            jsonb_array_length(
              evidence.impact_analysis_derivation -> 'derivations'
            ) AS derived_count,
            evidence.impact_analysis_derivation
              - 'schemaVersion' - 'derivations' = '{}'::jsonb
              AS closed_document,
            (
              SELECT count(*)::text
                FROM platform.release_verification_results AS stored
               WHERE stored.tenant_id = evidence.tenant_id
                 AND stored.environment_id = evidence.environment_id
                 AND stored.verification_evidence_id =
                     evidence.verification_evidence_id
            ) AS stored_results
       FROM platform.release_verification_evidence AS evidence
      WHERE evidence.tenant_id = $1
        AND evidence.environment_id = $2
        AND evidence.verification_evidence_id = $3`,
    [runtime.identity.tenantId, runtime.identity.environmentId, evidenceId],
  );
  assert.deepEqual(header.rows[0], {
    closed_document: true,
    derived_count: derivations.length,
    evidence_version: 'northstar.verification-result-set/v2',
    execution_scope: 'EXACT_PARTITION',
    impact_analysis_version: 'northstar.verification-impact-analysis/v1',
    result_count: evidence.results.length,
    skipped_scenario_ids: [],
    stored_results: String(evidence.results.length),
  });
  assert.notEqual(
    header.rows[0]?.result_count,
    header.rows[0]?.derived_count,
    'the executed counter and the derivation count are separate durable facts',
  );
}

// DELETED by `LANG-ADOPT-v5`: `previousSourceRelease`, whose only caller now
// pins its pair by release root instead.
//
// It solved a real problem -- `at(-2)` selects the definition-equal sibling that
// an ADR-0047 §4 profile adoption mints -- but it solved it by making the answer
// depend on where the head happens to be, which is the same defect one step out.
// Both spellings answer "which entry is near the end"; neither answers "which
// entry carries the change this control is about".

function equalNormalizedDefinition(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

interface ConstructibilityPartition {
  readonly derivations?: readonly {
    readonly reason: {
      readonly code: string;
      readonly entityId: string;
      readonly operationId?: string;
      readonly requiredStorageColumn?: string;
    };
    readonly scenarioId: string;
  }[];
  readonly results: readonly { readonly scenarioId: string }[];
}

function assertReceivingVerificationCoverage(
  compiledApplication: unknown,
): void {
  // ADR-0066 retires the historical 168 -> 163 scenario delta with its
  // disposable lineage. Current verifier coverage remains a live assertion.
  const { plan } = releaseVerificationBinding(
    parseCompiledApplication(compiledApplication).application.compiled,
  );
  for (const [local, count] of Object.entries({
    goods_receipt: 19,
    goods_receipt_line: 17,
    purchase_order_amendment: 13,
    purchase_order_received: 10,
  })) {
    assert.equal(
      plan.scenarios.filter(
        (scenario) => scenario.entityId === `northstar.app:entity.${local}`,
      ).length,
      count,
      `the receiving entity ${local} contributes its measured verifier scenarios`,
    );
  }
  assert.equal(
    plan.scenarios.some(
      (scenario) =>
        scenario.subjectId ===
        'northstar.app:derived_state_field.machine.purchase_order_lifecycle',
    ),
    false,
    'the server-owned lifecycle field is not probed through generic writes',
  );
}

type IndependentUnconstructibleReason =
  | Readonly<{ kind: 'noCreateOperation' }>
  | Readonly<{
      kind: 'unconstructableInput';
      missingStorageColumns: ReadonlySet<string>;
      operationId: string;
    }>;

/**
 * Test-owned oracle for ADR-0020 derivations. It deliberately recomputes from
 * storage and operation contracts instead of calling the provider's findings
 * or scenario deriver, so the producer cannot certify its own exclusions.
 */
function assertIndependentConstructibilityPartition(
  compiled: CompileSuccess,
  plan: VerificationPlanPayloadV1,
  partition: ConstructibilityPartition,
): void {
  const storage = storageTarget(compiled);
  const operations = projectionPayload<{
    readonly operations: readonly {
      readonly effect: {
        readonly entity: { readonly targetId: string };
        readonly kind: string;
      };
      readonly inputContract: {
        readonly fields: readonly { readonly fieldId: string }[];
        readonly relationInputs: readonly {
          readonly relationId: string;
        }[];
        readonly systemInput?: {
          readonly argumentKey: string;
          readonly classification: string;
          readonly immutableAfterCreate: boolean;
          readonly physicalColumn: string;
          readonly required: boolean;
          readonly valueKind: string;
        };
      };
      readonly operationId: string;
    }[];
  }>(compiled, PROJECTION_FAMILY_IDS.operationCatalog).operations;
  const createOperations = new Map(
    operations
      .filter((operation) => operation.effect.kind === 'createRecordEffect')
      .map((operation) => [operation.effect.entity.targetId, operation]),
  );
  const unconstructibleByEntity = new Map<
    string,
    IndependentUnconstructibleReason
  >();
  for (const entity of storage.entities) {
    const createOperation = createOperations.get(entity.entityId);
    if (!createOperation) {
      unconstructibleByEntity.set(entity.entityId, {
        kind: 'noCreateOperation',
      });
      continue;
    }
    const constructibleColumns = new Set<string>();
    for (const field of createOperation.inputContract.fields) {
      const column = entity.columns.find(
        (candidate) => candidate.canonicalFieldId === field.fieldId,
      );
      if (column) constructibleColumns.add(column.physicalName);
    }
    for (const relationInput of createOperation.inputContract.relationInputs) {
      const relation = storage.relations.find(
        (candidate) =>
          candidate.sourceEntityId === entity.entityId &&
          candidate.relationId === relationInput.relationId,
      );
      if (relation) {
        constructibleColumns.add(relation.relationColumn.physicalName);
      }
    }
    const systemInput = createOperation.inputContract.systemInput;
    if (systemInput) {
      assert.deepEqual(systemInput, {
        argumentKey: 'legalEntityId',
        classification: 'INTERNAL',
        immutableAfterCreate: true,
        physicalColumn: entity.legalEntity?.column,
        required: true,
        valueKind: 'uuid',
      });
      constructibleColumns.add(systemInput.physicalColumn);
    }
    const requiredColumns = new Set(
      entity.columns
        .filter(
          (column) => !column.nullable && column.defaultSemantics === 'none',
        )
        .map((column) => column.physicalName),
    );
    for (const relation of storage.relations) {
      if (
        relation.sourceEntityId === entity.entityId &&
        !relation.relationColumn.nullable
      ) {
        requiredColumns.add(relation.relationColumn.physicalName);
      }
    }
    if (entity.legalEntity) requiredColumns.add(entity.legalEntity.column);
    const missingStorageColumns = new Set(
      [...requiredColumns].filter(
        (column) => !constructibleColumns.has(column),
      ),
    );
    if (missingStorageColumns.size > 0) {
      unconstructibleByEntity.set(entity.entityId, {
        kind: 'unconstructableInput',
        missingStorageColumns,
        operationId: createOperation.operationId,
      });
    }
  }

  const resultById = new Map(
    partition.results.map((result) => [result.scenarioId, result]),
  );
  const derivationById = new Map(
    (partition.derivations ?? []).map((derivation) => [
      derivation.scenarioId,
      derivation,
    ]),
  );
  const expectedDerivedScenarioIds: string[] = [];
  const expectedExecutedScenarioIds: string[] = [];
  for (const scenario of plan.scenarios) {
    const reason = unconstructibleByEntity.get(scenario.entityId);
    const result = resultById.get(scenario.scenarioId);
    const derivation = derivationById.get(scenario.scenarioId);
    if (!reason) {
      assert.equal(
        derivation,
        undefined,
        `constructible scenario ${scenario.scenarioId} was recorded as derived`,
      );
      assert.ok(
        result,
        `constructible scenario ${scenario.scenarioId} was not executed`,
      );
      expectedExecutedScenarioIds.push(scenario.scenarioId);
      continue;
    }
    assert.equal(
      result,
      undefined,
      `underivable scenario ${scenario.scenarioId} was reported as executed`,
    );
    assert.ok(
      derivation,
      `underivable scenario ${scenario.scenarioId} has no derivation`,
    );
    assert.equal(derivation.reason.entityId, scenario.entityId);
    if (reason.kind === 'noCreateOperation') {
      assert.equal(
        derivation.reason.code,
        'VERIFICATION_NO_GENERIC_CREATE_OPERATION',
      );
    } else {
      assert.equal(
        derivation.reason.code,
        'VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE',
      );
      assert.equal(derivation.reason.operationId, reason.operationId);
      assert.ok(
        derivation.reason.requiredStorageColumn !== undefined &&
          reason.missingStorageColumns.has(
            derivation.reason.requiredStorageColumn,
          ),
        `derivation for ${scenario.scenarioId} does not name an independently missing storage column`,
      );
    }
    expectedDerivedScenarioIds.push(scenario.scenarioId);
  }
  assert.deepEqual(
    [...derivationById.keys()].toSorted(),
    expectedDerivedScenarioIds.toSorted(),
    'every and only independently underivable scenarios are derived',
  );
  assert.deepEqual(
    [...resultById.keys()].toSorted(),
    expectedExecutedScenarioIds.toSorted(),
    'every and only independently constructible scenarios execute',
  );
}

function createRuntime(
  compiledApplication: unknown,
  databaseUrl: string,
  tenantSlug: string,
  releaseSelection?: Readonly<{
    kind: 'rollback';
    targetReleaseRoot: string;
  }>,
  afterFreshTenantIntermediateActivation?: (
    observation: FreshTenantIntermediateActivationObservation,
  ) => Promise<void>,
  monotonicMilliseconds?: () => number,
) {
  return createComposedApplicationRuntime({
    ...(monotonicMilliseconds ? { monotonicMilliseconds } : {}),
    ...(afterFreshTenantIntermediateActivation
      ? { afterFreshTenantIntermediateActivation }
      : {}),
    compiledApplication,
    capabilityOperationExecutorFactories: [
      INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
      RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
    ],
    databaseUrl,
    inventoryScopeProvisioning: COMPOSED_APPLICATION_INVENTORY_SCOPE,
    localDemoIdentity: true,
    migrationsDirectory,
    providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
    ...(releaseSelection ? { releaseSelection } : {}),
    tenantSlug,
  });
}

function connectionUrl(connection: pg.PoolConfig): string {
  return `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
}

async function compileCandidateEnvelope(
  compiledApplication: unknown,
  authoredApplication: Record<string, unknown>,
  storageChange: boolean,
): Promise<unknown> {
  const candidateDefinition = structuredClone(authoredApplication);
  const packageDefinition = candidateDefinition.package as Record<
    string,
    unknown
  >;
  packageDefinition.version = storageChange ? '1.0.2' : '1.0.1';
  if (storageChange) {
    // Version-from-artifact: a node spliced into this candidate must declare
    // the candidate's own version, not a literal.
    const candidateNodeVersion = (
      candidateDefinition as unknown as { languageVersion: string }
    ).languageVersion;
    const fields = candidateDefinition.fields as Array<Record<string, unknown>>;
    fields.push({
      classification: 'internal',
      collation: 'unicodeCaseInsensitive',
      defaultSemantics: 'nullable',
      entity: {
        kind: 'entityReference',
        schemaVersion: candidateNodeVersion,
        targetId: 'northstar.app:entity.party',
      },
      fieldId: rollbackFieldId,
      fieldType: {
        kind: 'textFieldType',
        maximumLength: 160,
        schemaVersion: candidateNodeVersion,
      },
      kind: 'fieldDefinition',
      label: 'Rollback note',
      orderKey: 40,
      presence: 'optional',
      reportable: true,
      schemaVersion: candidateNodeVersion,
      searchable: false,
    });
  }
  const directory = await mkdtemp(
    resolve(tmpdir(), 'northstar-app-release-advancement-'),
  );
  const authoredPath = resolve(directory, 'app.authored.json');
  const compiledPath = resolve(directory, 'app.compiled.json');
  try {
    await Promise.all([
      writeFile(authoredPath, JSON.stringify(candidateDefinition)),
      writeFile(compiledPath, JSON.stringify(compiledApplication)),
      writeAcknowledgementBeside(authoredPath, candidateDefinition),
    ]);
    const environment = {
      ...process.env,
      NORTH_STAR_APP_AUTHORED_PATH: authoredPath,
      NORTH_STAR_APP_COMPILED_PATH: compiledPath,
    };
    for (const arguments_ of [
      ['--import', 'tsx', compileScriptPath],
      ['--import', 'tsx', compileScriptPath, '--check'],
    ]) {
      await execFileAsync(process.execPath, arguments_, {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: environment,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      });
    }
    const candidate = JSON.parse(
      await readFile(compiledPath, 'utf8'),
    ) as unknown;
    const previous = parseCompiledApplication(compiledApplication);
    assert.equal(
      parseCompiledApplication(candidate).applications.length,
      previous.applications.length + 1,
      'the rebuild appends one immutable successor to the compiled lineage',
    );
    return candidate;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/**
 * A successor compiled from the head's OWN normalized bytes at the head's own
 * profile. Same source, so `ensurePersistedRelease` reuses one revision; same
 * profile, so the edge is not a profile-only edge. The roots still differ
 * because compilation identity folds in the expected active release.
 */
function appendSameProfileSuccessor(compiledApplication: unknown): unknown {
  const previous = parseCompiledApplication(compiledApplication);
  const headBytes = previous.application.normalizedDefinitionBytes;
  const successor = compileSuccessor(previous.application.compiled, headBytes);
  return {
    applications: [
      ...previous.applications.map((release) =>
        serializedRelease(release.normalizedDefinitionBytes, release.compiled),
      ),
      serializedRelease(headBytes, successor),
    ],
    bootstrap: serializedRelease(
      previous.bootstrap.normalizedDefinitionBytes,
      previous.bootstrap.compiled,
    ),
    schemaVersion: 'northstar.web:compiled-application-release/v2',
  };
}

function compileMismatchedEnvelope(
  compiledApplication: unknown,
  authoredApplication: Record<string, unknown>,
): unknown {
  const previous = parseCompiledApplication(compiledApplication);
  const decoyBytes = normalizedDefinitionVersion(authoredApplication, '1.0.8');
  const decoy = compileSuccessor(previous.application.compiled, decoyBytes);
  const mismatchedBytes = normalizedDefinitionVersion(
    authoredApplication,
    '1.0.9',
  );
  const mismatched = compileSuccessor(decoy, mismatchedBytes);
  return {
    applications: [
      ...previous.applications.map((release) =>
        serializedRelease(release.normalizedDefinitionBytes, release.compiled),
      ),
      serializedRelease(mismatchedBytes, mismatched),
    ],
    bootstrap: serializedRelease(
      previous.bootstrap.normalizedDefinitionBytes,
      previous.bootstrap.compiled,
    ),
    schemaVersion: 'northstar.web:compiled-application-release/v2',
  };
}

function normalizedDefinitionVersion(
  authoredApplication: Record<string, unknown>,
  version: string,
): Uint8Array {
  const candidateDefinition = structuredClone(authoredApplication);
  const packageDefinition = candidateDefinition.package as Record<
    string,
    unknown
  >;
  packageDefinition.version = version;
  return new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(candidateDefinition)),
  );
}

function compileSuccessor(
  previous: CompileSuccess,
  normalizedDefinitionBytes: Uint8Array,
): CompileSuccess {
  const result = compileApplication({
    dependencies: [],
    expectedActiveRelease: expectedActiveReleaseFrom(previous),
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes,
    profile: profileForNormalizedBytes(normalizedDefinitionBytes),
  });
  assert.equal(result.status, 'compiled');
  return result as CompileSuccess;
}

function serializedRelease(
  normalizedDefinitionBytes: Uint8Array,
  compiled: CompileSuccess,
): unknown {
  return {
    attestation: compiled.attestation,
    artifacts: compiled.bundle.artifacts.map((artifact) => ({
      ...artifact,
      canonicalBytesBase64: Buffer.from(artifact.canonicalBytes).toString(
        'base64',
      ),
      canonicalBytes: undefined,
    })),
    nodeContracts: compiled.bundle.nodeContracts,
    normalizedDefinitionBytesBase64: Buffer.from(
      normalizedDefinitionBytes,
    ).toString('base64'),
    outputProtocolVersion: compiled.bundle.outputProtocolVersion,
    releaseManifest: compiled.bundle.releaseManifest,
    releaseManifestBytesBase64: Buffer.from(
      compiled.bundle.releaseManifestBytes,
    ).toString('base64'),
    releaseRoot: compiled.releaseRoot,
    stagedArtifactHashes: compiled.stagedArtifacts.map(
      (artifact) => artifact.contentHash,
    ),
  };
}

/**
 * Version-from-artifact: compile a fixture at the version it declares rather
 * than at whichever version is currently adopted. A pinned profile makes every
 * control here fail the moment adoption moves, for reasons unrelated to what
 * they measure.
 */
function profileForNormalizedBytes(
  bytes: Uint8Array,
): typeof MODULE_COMPILER_PROFILE {
  const declared = JSON.parse(new TextDecoder().decode(bytes)) as {
    languageVersion?: (typeof MODULE_COMPILER_PROFILE)['languageVersion'];
    normalizationProfileVersion?: (typeof MODULE_COMPILER_PROFILE)['normalizationProfileVersion'];
  };
  return {
    ...MODULE_COMPILER_PROFILE,
    ...(declared.languageVersion === undefined
      ? {}
      : { languageVersion: declared.languageVersion }),
    ...(declared.normalizationProfileVersion === undefined
      ? {}
      : {
          normalizationProfileVersion: declared.normalizationProfileVersion,
        }),
  };
}
