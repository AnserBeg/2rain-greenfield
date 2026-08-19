import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import pg from 'pg';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CanonicalModelError,
  CONTENT_HASH_ALGORITHM,
  canonicalAuthoredProjection,
  canonicalize,
  canonicalizeAndHash,
  normalizeApplicationPackage,
  parseNormalizedApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  compileApplication,
  executeVerificationPlan,
  expectedActiveReleaseFrom,
  PROJECTION_FAMILY_IDS,
  validateExecutedVerificationPlan,
  type CompileSuccess,
  type CompilerInput,
  type StorageTargetPayloadV1,
  type VerificationPlanPayloadV1,
} from '../../packages/compiler/src/index.js';
import { STORAGE_TARGET_PAYLOAD_V3_VERSION } from '../../packages/compiler/src/protocol.js';
import {
  APPLICATION_NAMESPACE,
  composedApplicationDefinition,
} from '../../packages/domain/src/app/builder.js';
import {
  INVENTORY_IDS,
  INVENTORY_NAMESPACE,
  inventoryModuleDefinition,
} from '../../packages/domain/src/inventory/index.js';
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import {
  assertModuleSemanticStorageContract,
  ModuleRuntimeInterpreterError,
  PostgresModuleRuntimeInterpreter,
  type PinnedStorageTargetCacheObservation,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { PostgresModuleStorageMaterializer } from '../../packages/postgres-provider/src/module-storage-materializer.js';
import {
  executeAggregateVerificationProbe,
  PostgresReleaseVerificationService,
  ReleaseVerificationIntegrityError,
  releaseVerificationBinding,
} from '../../packages/postgres-provider/src/release-verification-service.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { PostgresRequestRuntimeViewService } from '../../packages/postgres-provider/src/request-runtime-view-service.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import { TrustEvidenceError } from '../../packages/postgres-provider/src/trust/postgres-trust-service.js';
import { TrustedActorEnvelopeIssuer } from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationNonAcceptedRequest,
  type SemanticOperationResultEnvelope,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import {
  MalformedLegalEntityScopeArgumentError,
  MalformedSemanticQueryRequestError,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryGateway,
  type SemanticAggregateResultEnvelope,
  type SemanticQueryExecutionContext,
  type SemanticQueryResultEnvelope,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  InvalidLegalEntityReadScopeSelectionError,
  LegalEntityReadScopeIntegrityError,
  LegalEntityReadScopePolicyDeniedError,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  issueLegalEntityReadScope,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeProjectionFamily,
  type RequestRuntimeView,
  type RuntimeProjection,
} from '../../packages/runtime/src/request-runtime-view.js';
import {
  V3_AGGREGATE_IDS,
  v3AggregateModule,
} from '../compiler/v3-definition.js';
import {
  FIXTURE_IDS,
  ordinaryModuleV1,
  ordinaryModuleV1ForNamespace,
  ordinaryModuleV2,
  ordinaryModuleV2ForNamespace,
} from '../fixtures/g2/module-conformance/definitions.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const migrations = resolve('db/migrations');
const execFileAsync = promisify(execFile);
const localeProbeChild = process.env.PR1_LOCALE_PROBE_CHILD === '1';
const tenantA = 'a1000000-0000-4000-8000-000000000001';
const environmentA = 'a2000000-0000-4000-8000-000000000002';
const principalA = 'a3000000-0000-4000-8000-000000000003';
const principalASecond = 'a3000000-0000-4000-8000-000000000004';
const tenantB = 'b1000000-0000-4000-8000-000000000001';
const environmentB = 'b2000000-0000-4000-8000-000000000002';
const principalB = 'b3000000-0000-4000-8000-000000000003';
const localeOrderingFieldIds = Object.freeze({
  digit: `${FIXTURE_IDS.namespace}:field.a0`,
  punctuation: `${FIXTURE_IDS.namespace}:field.a_a`,
});
const inventoryScopeProbeIds = Object.freeze({
  itemParameter: `${APPLICATION_NAMESPACE}:parameter.scope_probe_item`,
  locationParameter: `${APPLICATION_NAMESPACE}:parameter.scope_probe_location`,
  query: `${APPLICATION_NAMESPACE}:query.inventory_movement_scope_probe_sum`,
  selection: `${APPLICATION_NAMESPACE}:selection.inventory_movement_scope_probe_sum`,
});

test('aggregate verification requires the exact typed omission refusal', async () => {
  const parameterizedQuery = {
    parameters: [{ parameterId: V3_AGGREGATE_IDS.stockParameter }],
    queryId: V3_AGGREGATE_IDS.aggregateQuery,
  };
  let aggregateCalls = 0;
  const refusal = await executeAggregateVerificationProbe(
    parameterizedQuery,
    async () => {
      aggregateCalls += 1;
      throw new MalformedSemanticQueryRequestError(
        'aggregate query arguments do not match the declared parameters',
      );
    },
  );
  assert.deepEqual(refusal, {
    code: 'MALFORMED_SEMANTIC_QUERY_REQUEST',
    kind: 'aggregateParameterOmissionRefusal',
    queryId: V3_AGGREGATE_IDS.aggregateQuery,
    reason: 'aggregate query arguments do not match the declared parameters',
    schemaVersion: 'northstar.release-verification-aggregate-probe/v1',
  });
  assert.equal(aggregateCalls, 1);

  const scopedRefusal = await executeAggregateVerificationProbe(
    {
      ...parameterizedQuery,
      legalEntityScope: {
        cardinality: 'exactlyOne',
        kind: 'queryLegalEntityScope',
        operand: {
          kind: 'queryParameterReference',
          parameterId: V3_AGGREGATE_IDS.stockParameter,
          schemaVersion: 'v4',
        },
        schemaVersion: 'v4',
      },
    },
    async () => {
      throw new MalformedLegalEntityScopeArgumentError(
        V3_AGGREGATE_IDS.aggregateQuery,
        'selection-omitted',
      );
    },
  );
  assert.deepEqual(scopedRefusal, {
    code: 'SEMANTIC_QUERY_LEGAL_ENTITY_SCOPE_INVALID',
    kind: 'aggregateParameterOmissionRefusal',
    queryId: V3_AGGREGATE_IDS.aggregateQuery,
    reason: 'selection-omitted',
    schemaVersion: 'northstar.release-verification-aggregate-probe/v1',
  });

  await assert.rejects(
    executeAggregateVerificationProbe(
      parameterizedQuery,
      async () => ({}) as SemanticAggregateResultEnvelope,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseVerificationIntegrityError);
      assert.equal(
        error.code,
        'VERIFICATION_AGGREGATE_PARAMETER_OMISSION_NOT_REFUSED',
      );
      return true;
    },
  );

  const wrongReason = new MalformedSemanticQueryRequestError(
    'aggregate query arguments must be an object',
  );
  await assert.rejects(
    executeAggregateVerificationProbe(parameterizedQuery, async () => {
      throw wrongReason;
    }),
    (error: unknown) => error === wrongReason,
  );
});

test('accepted pre-PR-2 semantic metadata fails closed before module DML', () => {
  const compiled = mustCompile(moduleInput(ordinaryModuleV1()));
  const storage = compiledProjectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const withoutArchiveBehavior = structuredClone(storage);
  delete (
    withoutArchiveBehavior.relations[0] as Partial<
      (typeof withoutArchiveBehavior.relations)[number]
    >
  ).archiveBehavior;
  assert.throws(
    () => assertModuleSemanticStorageContract(withoutArchiveBehavior),
    (error: unknown) =>
      assertModuleError(
        error,
        'MODULE_SEMANTIC_CONTRACT_UNSUPPORTED',
        storage.relations[0]!.relationId,
      ),
  );

  const withoutFieldContract = structuredClone(storage);
  delete (
    withoutFieldContract.entities[0]!.columns[0] as Partial<
      (typeof withoutFieldContract.entities)[number]['columns'][number]
    >
  ).fieldContract;
  assert.throws(
    () => assertModuleSemanticStorageContract(withoutFieldContract),
    (error: unknown) => {
      assert.ok(error instanceof ModuleRuntimeInterpreterError);
      assert.equal(error.code, 'MODULE_SEMANTIC_CONTRACT_UNSUPPORTED');
      return true;
    },
  );
});

test('release verification executes a parameterized aggregate assertion as an omission probe', async () => {
  const assertionId = `${FIXTURE_IDS.namespace}:assertion.aggregate_execution`;
  const definition = v3AggregateModule() as {
    assertions: Array<Record<string, unknown>>;
    languageVersion: string;
  } & Record<string, unknown>;
  definition.assertions.push({
    assertionId,
    evidenceKinds: ['provider'],
    expectedDiagnosticCode: null,
    expectedOutcome: 'succeeds',
    invocation: {
      kind: 'queryInvocation',
      query: {
        kind: 'queryReference',
        schemaVersion: definition.languageVersion,
        targetId: V3_AGGREGATE_IDS.aggregateQuery,
      },
      schemaVersion: definition.languageVersion,
    },
    kind: 'assertionDefinition',
    schemaVersion: definition.languageVersion,
  });
  const emptyDefinition_ = emptyDefinition(definition);
  const empty = mustCompile(moduleInput(emptyDefinition_));
  const compiled = mustCompile(
    moduleInput(definition, expectedActiveReleaseFrom(empty)),
  );
  const plan = releaseVerificationBinding(compiled).plan;
  const aggregateScenario = plan.scenarios.find(
    (scenario) =>
      scenario.kind === 'declaredEvidence' &&
      scenario.assertionId === assertionId,
  );
  assert.ok(aggregateScenario);

  const tenant = 'e1000000-0000-4000-8000-000000000001';
  const environment = 'e2000000-0000-4000-8000-000000000002';
  const principal = 'e3000000-0000-4000-8000-000000000003';
  await withEphemeralPostgres(
    'module-aggregate-verification',
    async ({ connection, pool }) => {
      await migrateAndSeed(pool, [
        [tenant, environment, 'aggregate-verification'],
      ]);
      const runtimePool = new pg.Pool({
        ...connection,
        max: 3,
        user: 'north_star_runtime',
      });
      const materializerPool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_module_materializer',
      });
      const modulePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_module_runtime',
      });
      try {
        const context = (
          await contextsFor([['aggregate', tenant, environment, principal]])
        ).aggregate!;
        const releases = await persistSequence(runtimePool, context, [
          [empty, emptyDefinition_],
          [compiled, definition],
        ]);
        await setPointer(pool, tenant, environment, releases[0]!);
        await grantExecutorAuthority(pool, [[tenant, principal]]);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        );
        await prepare(materializer, context, principal, releases[1]!);
        const staged = await withTrustedRequestTransaction(
          runtimePool,
          context,
          async (client) => {
            const result = await client.query<{
              verification_evidence_id: MintedUuid;
            }>(
              `SELECT verification_evidence_id
                 FROM platform.tenant_releases
                WHERE tenant_id = $1
                  AND environment_id = $2
                  AND release_id = $3`,
              [tenant, environment, releases[1]],
            );
            const row = result.rows[0];
            assert.ok(row);
            return row;
          },
        );
        const resultSet = await new PostgresReleaseVerificationService(
          runtimePool,
        ).executeSemanticCandidateWithExecutor(
          context,
          {
            compiledRelease: compiled,
            evidenceId: staged.verification_evidence_id,
            releaseId: releases[1]!,
          },
          new PostgresModuleRuntimeInterpreter(runtimePool, humanActorIssuer()),
        );
        assert.equal(resultSet.results.length, plan.scenarios.length);
        assert.equal(
          resultSet.results.some(
            (result) => result.scenarioId === aggregateScenario.scenarioId,
          ),
          true,
        );
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          modulePool.end(),
        ]);
      }
    },
  );
});

test('release verification leaves an optional self-reference unset and terminates', async () => {
  const observation = await executeSelfRelationVerification(false);
  assert.equal(
    observation.resultSet.results.length,
    observation.plan.scenarios.length,
    'every declared scenario must produce an executed result',
  );
  assert.equal(
    observation.relationPopulation.explicit,
    0,
    'verification must not invent the optional relation for any scenario',
  );
  assert.ok(
    observation.relationPopulation.unset > 0,
    'ordinary arrangements must persist without inventing an optional parent',
  );
});

test('release verification refuses a required relation cycle by name', async () => {
  await assert.rejects(
    executeSelfRelationVerification(true),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseVerificationIntegrityError);
      assert.equal(error.code, 'VERIFICATION_REQUIRED_RELATION_CYCLE');
      assert.match(error.message, /required relation arrangement cycle/u);
      return true;
    },
  );
});

test('release verification gives equal-depth required diamond paths distinct records', async () => {
  const observation = await executeRequiredDiamondVerification();
  assert.equal(
    observation.resultSet.results.length,
    observation.plan.scenarios.length,
    'every declared scenario must produce an executed result',
  );
  assert.ok(
    observation.parentPairs.length > 0,
    'verification must persist at least one complete required diamond',
  );
  for (const pair of observation.parentPairs) {
    assert.notEqual(
      pair.leftSharedRecordId,
      pair.rightSharedRecordId,
      `diamond root ${pair.rootRecordId} must receive two distinct shared parents`,
    );
  }
});

test('an unset optional restrict relation archives, restores, and verifies through the real operation path', async () => {
  await withOptionalRestrictRuntime('unset', async (runtime) => {
    assert.deepEqual(runtime.foreignKey, {
      deleteAction: 'r',
      deferrable: false,
      updateAction: 'r',
      validated: true,
    });

    await assert.rejects(
      operation(
        runtime.operations,
        runtime.view,
        'master_create',
        {
          recordId: randomUUID(),
          relations: { [runtime.relationId]: randomUUID() },
          values: masterValues(runtime.namespace, 'Dangling target'),
        },
        runtime.namespace,
      ),
      (error: unknown) =>
        assertModuleError(error, 'MODULE_RELATION_TARGET_NOT_FOUND', null),
    );

    const recordId = randomUUID();
    const created = await operation(
      runtime.operations,
      runtime.view,
      'master_create',
      {
        recordId,
        values: masterValues(runtime.namespace, 'Unset relation'),
      },
      runtime.namespace,
    );
    assert.equal(created.readBack?.recordId, recordId);
    assert.equal(await runtime.readRelation(recordId), null);

    const archived = await operation(
      runtime.operations,
      runtime.view,
      'master_archive',
      { expectedRevision: 1, recordId },
      runtime.namespace,
    );
    assert.equal(archived.readBack?.archived, true);

    const restored = await operation(
      runtime.operations,
      runtime.view,
      'master_restore',
      { expectedRevision: 2, recordId },
      runtime.namespace,
    );
    assert.equal(restored.readBack?.archived, false);
    assert.equal(await runtime.readRelation(recordId), null);

    const recoveryScenario = runtime.plan.scenarios.find(
      (scenario) =>
        scenario.kind === 'declaredEvidence' &&
        scenario.entityId === `${runtime.namespace}:entity.master` &&
        scenario.evidenceKind === 'recovery',
    );
    assert.ok(recoveryScenario);
    const resultSet = await new PostgresReleaseVerificationService(
      runtime.runtimePool,
    ).executeSemanticCandidateWithExecutor(
      runtime.context,
      {
        compiledRelease: runtime.compiled,
        evidenceId: runtime.evidenceId,
        releaseId: runtime.releaseId,
      },
      runtime.interpreter,
    );
    assert.equal(
      resultSet.results.some(
        (result) => result.scenarioId === recoveryScenario.scenarioId,
      ),
      true,
      'the generic recovery scenario must execute with the optional relation unset',
    );
  });
});

test('restore still refuses when an optional restrict relation names an archived target', async () => {
  await withOptionalRestrictRuntime('archived-target', async (runtime) => {
    const targetId = randomUUID();
    await operation(
      runtime.operations,
      runtime.view,
      'master_create',
      {
        recordId: targetId,
        values: masterValues(runtime.namespace, 'Archived target'),
      },
      runtime.namespace,
    );
    const sourceId = randomUUID();
    await operation(
      runtime.operations,
      runtime.view,
      'master_create',
      {
        recordId: sourceId,
        relations: { [runtime.relationId]: targetId },
        values: masterValues(runtime.namespace, 'Archived source'),
      },
      runtime.namespace,
    );
    await operation(
      runtime.operations,
      runtime.view,
      'master_archive',
      { expectedRevision: 1, recordId: sourceId },
      runtime.namespace,
    );
    await operation(
      runtime.operations,
      runtime.view,
      'master_archive',
      { expectedRevision: 1, recordId: targetId },
      runtime.namespace,
    );

    await assert.rejects(
      operation(
        runtime.operations,
        runtime.view,
        'master_restore',
        { expectedRevision: 2, recordId: sourceId },
        runtime.namespace,
      ),
      (error: unknown) =>
        assertModuleError(
          error,
          'MODULE_RELATION_VIOLATION',
          runtime.relationId,
        ),
    );
  });
});

test('definition-only module is served generically through Q0/O0, trust, RLS, and pinned coexistence', async (context) => {
  const empty = mustCompile(moduleInput(emptyDefinition(ordinaryModuleV1())));
  const v1 = mustCompile(
    moduleInput(ordinaryModuleV1(), expectedActiveReleaseFrom(empty)),
  );
  const v2 = mustCompile(
    moduleInput(ordinaryModuleV2(), expectedActiveReleaseFrom(v1)),
  );
  const storageV1 = compiledProjectionPayload<StorageTargetPayloadV1>(
    v1,
    PROJECTION_FAMILY_IDS.storageTarget,
  );

  await withEphemeralPostgres(
    'module-runtime',
    async ({ connection, pool }) => {
      await migrateAndSeed(pool, [
        [tenantA, environmentA, 'runtime-a'],
        [tenantB, environmentB, 'runtime-b'],
      ]);
      const runtimePool = new pg.Pool({
        ...connection,
        max: 4,
        user: 'north_star_runtime',
      });
      const materializerPool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_module_materializer',
      });
      const modulePool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_module_runtime',
      });
      materializerPool.on('error', () => undefined);
      modulePool.on('error', () => undefined);
      try {
        const contexts = await contextsFor([
          ['a', tenantA, environmentA, principalA],
          ['a-second', tenantA, environmentA, principalASecond],
          ['b', tenantB, environmentB, principalB],
        ]);
        const releasesA = await persistSequence(runtimePool, contexts.a!, [
          [empty, emptyDefinition(ordinaryModuleV1())],
          [v1, ordinaryModuleV1()],
          [v2, ordinaryModuleV2()],
          [v1, ordinaryModuleV1()],
        ]);
        const releasesB = await persistSequence(runtimePool, contexts.b!, [
          [empty, emptyDefinition(ordinaryModuleV1())],
          [v1, ordinaryModuleV1()],
        ]);
        await setPointer(pool, tenantA, environmentA, releasesA[0]!);
        await setPointer(pool, tenantB, environmentB, releasesB[0]!);
        await grantExecutorAuthority(pool, [
          [tenantA, principalA],
          [tenantA, principalASecond],
          [tenantB, principalB],
        ]);

        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        );
        await prepare(materializer, contexts.a!, principalA, releasesA[1]!);
        await prepare(materializer, contexts.a!, principalA, releasesA[3]!);
        await prepare(materializer, contexts.b!, principalB, releasesB[1]!);
        await admitCandidate(runtimePool, contexts.a!, releasesA[1]!, v1);
        await admitCandidate(runtimePool, contexts.a!, releasesA[3]!, v1);
        await admitCandidate(runtimePool, contexts.b!, releasesB[1]!, v1);
        await setPointer(pool, tenantA, environmentA, releasesA[1]!);
        await setPointer(pool, tenantB, environmentB, releasesB[1]!);

        const policy = new AllowPolicy();
        const interpreter = new PostgresModuleRuntimeInterpreter(
          runtimePool,
          humanActorIssuer(),
        );
        const queryGateway = new SemanticQueryGateway(policy, interpreter);
        const operationGateway = operationGatewayFor(policy, interpreter);
        const entry = runtimeEntry(runtimePool, {
          a: identity(tenantA, environmentA, principalA),
          'a-second': identity(tenantA, environmentA, principalASecond),
          b: identity(tenantB, environmentB, principalB),
        });
        const viewA1 = await issuedView(entry, 'a');
        const viewASecond = await issuedView(entry, 'a-second');
        const viewB1 = await issuedView(entry, 'b');

        const candidateView = (
          compiled: CompileSuccess,
          releaseId: string,
          candidateIdentity: AuthenticatedIdentity,
        ) =>
          issuedCandidateView(
            compiled,
            releaseId,
            candidateIdentity,
            viewA1.pointer,
            new AllowPolicy(),
          );
        const sameReleaseDifferentTenant = await candidateView(
          v1,
          releasesA[1]!,
          identity(tenantB, environmentA, principalB),
        );
        const sameReleaseDifferentEnvironment = await candidateView(
          v1,
          releasesA[1]!,
          identity(tenantA, environmentB, principalA),
        );
        const differentReleaseSameContent = await candidateView(
          v1,
          releasesA[3]!,
          identity(tenantA, environmentA, principalA),
        );
        const sameReleaseDifferentContent = await candidateView(
          v2,
          releasesA[1]!,
          identity(tenantA, environmentA, principalA),
        );

        const assertDimensionMiss = async (
          dimension: keyof PinnedStorageTargetCacheObservation['key'],
          changedView: RequestRuntimeView,
          changedViewSucceeds: boolean,
        ) => {
          const observations: PinnedStorageTargetCacheObservation[] = [];
          const cacheInterpreter = new PostgresModuleRuntimeInterpreter(
            runtimePool,
            humanActorIssuer(),
            [],
            undefined,
            (observation) => observations.push(observation),
          );
          const gateway = new SemanticQueryGateway(
            new AllowPolicy(),
            cacheInterpreter,
          );
          const invoke = (view: RequestRuntimeView) =>
            query(gateway, view, 'master_list', { limit: 20 });
          await invoke(viewA1);
          if (changedViewSucceeds) await invoke(changedView);
          else await assert.rejects(invoke(changedView));

          const misses = observations.filter(
            (observation) => observation.kind === 'cacheMiss',
          );
          assert.equal(misses.length, 2);
          const first = misses[0]!.key;
          const second = misses[1]!.key;
          for (const key of [
            'tenantId',
            'environmentId',
            'releaseId',
            'contentHash',
          ] as const) {
            if (key === dimension) assert.notEqual(second[key], first[key]);
            else assert.equal(second[key], first[key]);
          }
          assert.equal(
            observations.filter(
              (observation) =>
                observation.kind === 'tenantVisibleArtifactsRead',
            ).length,
            2,
          );
        };

        await context.test(
          'validated pinned storage cache misses for a different tenant',
          () =>
            assertDimensionMiss('tenantId', sameReleaseDifferentTenant, false),
        );
        await context.test(
          'validated pinned storage cache misses for a different environment',
          () =>
            assertDimensionMiss(
              'environmentId',
              sameReleaseDifferentEnvironment,
              false,
            ),
        );
        await context.test(
          'validated pinned storage cache misses for a different release id',
          () =>
            assertDimensionMiss('releaseId', differentReleaseSameContent, true),
        );
        await context.test(
          'validated pinned storage cache misses for a different content hash',
          () =>
            assertDimensionMiss(
              'contentHash',
              sameReleaseDifferentContent,
              false,
            ),
        );

        await context.test(
          'a corrupt first pinned storage load refuses and does not populate the cache',
          async () => {
            const observed = instrumentPinnedArtifactReads(
              runtimePool,
              (result, readCount) =>
                readCount === 1
                  ? {
                      ...result,
                      rows: result.rows.map((row, index) =>
                        index === 0
                          ? {
                              ...row,
                              canonical_bytes: Buffer.from(
                                'corrupt-first-pinned-artifact-load',
                              ),
                            }
                          : row,
                      ),
                    }
                  : result,
            );
            const observations: PinnedStorageTargetCacheObservation[] = [];
            const cacheInterpreter = new PostgresModuleRuntimeInterpreter(
              observed.pool,
              humanActorIssuer(),
              [],
              undefined,
              (observation) => observations.push(observation),
            );
            const gateway = new SemanticQueryGateway(
              new AllowPolicy(),
              cacheInterpreter,
            );
            const invoke = () =>
              query(gateway, viewA1, 'master_list', { limit: 20 });

            await assert.rejects(invoke(), (error: unknown) =>
              assertModuleError(error, 'MODULE_ARTIFACT_DIGEST_MISMATCH', null),
            );
            assert.equal(observed.readCount(), 1);
            assert.equal(
              observations.some(
                (observation) => observation.kind === 'cachePopulated',
              ),
              false,
            );

            await invoke();
            assert.equal(observed.readCount(), 2);
            assert.equal(
              observations.filter(
                (observation) => observation.kind === 'cacheMiss',
              ).length,
              2,
            );
            await invoke();
            assert.equal(
              observed.readCount(),
              2,
              'the successful retry, not the refused load, populated the cache',
            );
          },
        );

        await context.test(
          'pinned storage cache population follows every validation phase',
          async () => {
            const observations: PinnedStorageTargetCacheObservation[] = [];
            const cacheInterpreter = new PostgresModuleRuntimeInterpreter(
              runtimePool,
              humanActorIssuer(),
              [],
              undefined,
              (observation) => observations.push(observation),
            );
            const gateway = new SemanticQueryGateway(
              new AllowPolicy(),
              cacheInterpreter,
            );
            await query(gateway, viewA1, 'master_list', { limit: 20 });
            assert.deepEqual(
              observations.map((observation) => observation.kind),
              [
                'cacheMiss',
                'tenantVisibleArtifactsRead',
                'artifactHashesVerified',
                'canonicalArtifactsDecoded',
                'schemaValidated',
                'cachePopulated',
              ],
            );
            await query(gateway, viewA1, 'master_list', { limit: 20 });
            assert.equal(observations.at(-1)?.kind, 'cacheHit');
          },
        );

        await context.test(
          'concurrent first pinned storage loads coalesce behind validation',
          async () => {
            let releaseRead!: () => void;
            let reportReadStarted!: () => void;
            let reportCoalesced!: () => void;
            let reportSecondRead!: () => void;
            const readReleased = new Promise<void>((resolve) => {
              releaseRead = resolve;
            });
            const readStarted = new Promise<void>((resolve) => {
              reportReadStarted = resolve;
            });
            const coalesced = new Promise<void>((resolve) => {
              reportCoalesced = resolve;
            });
            const secondRead = new Promise<void>((resolve) => {
              reportSecondRead = resolve;
            });
            const observed = instrumentPinnedArtifactReads(
              runtimePool,
              async (result, readCount) => {
                if (readCount === 1) {
                  reportReadStarted();
                  await readReleased;
                } else reportSecondRead();
                return result;
              },
            );
            const observations: PinnedStorageTargetCacheObservation[] = [];
            const cacheInterpreter = new PostgresModuleRuntimeInterpreter(
              observed.pool,
              humanActorIssuer(),
              [],
              undefined,
              (observation) => {
                observations.push(observation);
                if (observation.kind === 'cacheCoalesced') reportCoalesced();
              },
            );
            const gateway = new SemanticQueryGateway(
              new AllowPolicy(),
              cacheInterpreter,
            );
            const invoke = () =>
              query(gateway, viewA1, 'master_list', { limit: 20 });
            let firstSettled = false;
            let secondSettled = false;
            const first = invoke().finally(() => {
              firstSettled = true;
            });
            await readStarted;
            const second = invoke().finally(() => {
              secondSettled = true;
            });
            const firstConcurrencyEvent = await Promise.race([
              coalesced.then(() => 'coalesced' as const),
              secondRead.then(() => 'secondRead' as const),
            ]);
            const settledBeforeRelease = { firstSettled, secondSettled };
            const populatedBeforeRelease = observations.some(
              (observation) => observation.kind === 'cachePopulated',
            );
            releaseRead();
            await Promise.all([first, second]);
            assert.deepEqual(settledBeforeRelease, {
              firstSettled: false,
              secondSettled: false,
            });
            assert.equal(populatedBeforeRelease, false);
            assert.equal(firstConcurrencyEvent, 'coalesced');
            assert.equal(observed.readCount(), 1);
            assert.deepEqual(
              observations.map((observation) => observation.kind),
              [
                'cacheMiss',
                'cacheCoalesced',
                'tenantVisibleArtifactsRead',
                'artifactHashesVerified',
                'canonicalArtifactsDecoded',
                'schemaValidated',
                'cachePopulated',
              ],
            );
          },
        );

        await assertRoleBridge(pool);

        const soloId = randomUUID();
        const acmeOneId = randomUUID();
        const acmeTwoId = randomUUID();
        const tenantBId = randomUUID();
        const soloKey = randomUUID();
        const soloInput = {
          recordId: soloId,
          values: {
            [FIXTURE_IDS.fieldIds.parentName]: 'Solo',
            [FIXTURE_IDS.fieldIds.parentNumber]: 'A-001',
          },
        };
        const created = await operation(
          operationGateway,
          viewA1,
          'master_create',
          soloInput,
          FIXTURE_IDS.namespace,
          soloKey,
        );
        assert.equal(created.outcome, 'succeeded');
        assert.equal(created.readBack?.recordId, soloId);
        assert.deepEqual(created.readBack?.values, {
          [FIXTURE_IDS.fieldIds.parentName]: 'Solo',
        });
        assert.ok(created.trust);
        await assertLinkedTrustFacts(pool, created, tenantA, environmentA);

        const retryFactsBefore = await trustFactCount(
          pool,
          tenantA,
          environmentA,
        );
        const firstAttempt = await operation(
          operationGateway,
          viewA1,
          'master_create',
          soloInput,
          FIXTURE_IDS.namespace,
          soloKey,
        );
        assert.deepEqual(firstAttempt, created);
        assert.equal(
          await trustFactCount(pool, tenantA, environmentA),
          retryFactsBefore,
        );
        const retryPersistence = await pool.query<{
          business_rows: string;
          deduplication_key: string;
          receipts: string;
        }>(
          `SELECT
             (SELECT count(*)
                FROM north_star_module.${storageV1.entities[0]!.physicalTableName}
               WHERE record_id = $1::uuid) AS business_rows,
             (SELECT deduplication_key
                FROM platform.trust_outbox
               WHERE outbox_id = $2) AS deduplication_key,
             (SELECT count(*)
                FROM platform.semantic_operation_receipts
               WHERE idempotency_key = $3) AS receipts`,
          [soloId, firstAttempt.trust!.outboxId, soloKey],
        );
        assert.deepEqual(retryPersistence.rows[0], {
          business_rows: '1',
          deduplication_key: `${principalA}:${viewA1.release.contentHash}:${viewA1.release.releaseId}:${FIXTURE_IDS.namespace}:operation.master_create:${soloKey}`,
          receipts: '1',
        });
        await assert.rejects(
          operation(
            operationGateway,
            viewA1,
            'master_create',
            {
              ...soloInput,
              values: {
                ...soloInput.values,
                [FIXTURE_IDS.fieldIds.parentName]: 'Different retry input',
              },
            },
            FIXTURE_IDS.namespace,
            soloKey,
          ),
          assertIdempotencyConflict,
        );
        assert.equal(await moduleRecordCount(pool, storageV1, soloId), 1);

        await assert.rejects(
          operation(
            operationGateway,
            viewASecond,
            'master_create',
            soloInput,
            FIXTURE_IDS.namespace,
            soloKey,
          ),
          assertIdempotencyConflict,
        );
        assert.equal(await moduleRecordCount(pool, storageV1, soloId), 1);

        await setPointer(pool, tenantA, environmentA, releasesA[3]!);
        const activatedReleaseView = await issuedView(entry, 'a');
        assert.notEqual(
          activatedReleaseView.release.releaseId,
          viewA1.release.releaseId,
        );
        assert.equal(
          activatedReleaseView.release.contentHash,
          viewA1.release.contentHash,
        );
        const activationFactsBefore = await trustFactCount(
          pool,
          tenantA,
          environmentA,
        );
        const activationReplay = await operation(
          operationGateway,
          activatedReleaseView,
          'master_create',
          soloInput,
          FIXTURE_IDS.namespace,
          soloKey,
        );
        assert.deepEqual(activationReplay, created);
        assert.equal(
          await trustFactCount(pool, tenantA, environmentA),
          activationFactsBefore,
        );
        assert.equal(await moduleRecordCount(pool, storageV1, soloId), 1);

        const activatedReleaseRecordId = randomUUID();
        const activatedReleaseKey = randomUUID();
        const activatedReleaseResult = await operation(
          operationGateway,
          activatedReleaseView,
          'master_create',
          {
            recordId: activatedReleaseRecordId,
            values: {
              [FIXTURE_IDS.fieldIds.parentName]: 'Activated release scope',
              [FIXTURE_IDS.fieldIds.parentNumber]: 'A-RELEASE',
            },
          },
          FIXTURE_IDS.namespace,
          activatedReleaseKey,
        );
        const activatedReleaseOutbox = await pool.query<{
          deduplication_key: string;
        }>(
          `SELECT deduplication_key
             FROM platform.trust_outbox
            WHERE outbox_id = $1`,
          [activatedReleaseResult.trust!.outboxId],
        );
        assert.equal(
          activatedReleaseOutbox.rows[0]?.deduplication_key,
          `${principalA}:${activatedReleaseView.release.contentHash}:${activatedReleaseView.release.releaseId}:${FIXTURE_IDS.namespace}:operation.master_create:${activatedReleaseKey}`,
        );
        await operation(
          operationGateway,
          activatedReleaseView,
          'master_archive',
          { expectedRevision: 1, recordId: activatedReleaseRecordId },
        );
        await setPointer(pool, tenantA, environmentA, releasesA[1]!);

        const concurrentRecordId = randomUUID();
        const concurrentKey = randomUUID();
        const concurrentInput = {
          recordId: concurrentRecordId,
          values: {
            [FIXTURE_IDS.fieldIds.parentName]: 'Concurrent retry',
            [FIXTURE_IDS.fieldIds.parentNumber]: 'A-CONCURRENT',
          },
        };
        const concurrentResults = await executeConcurrentRetryBehindBarrier(
          pool,
          operationGateway,
          viewA1,
          concurrentInput,
          concurrentKey,
        );
        assert.deepEqual(concurrentResults[1], concurrentResults[0]);
        const concurrentPersistence = await pool.query<{
          business_changes: string;
          business_rows: string;
          receipts: string;
        }>(
          `SELECT
             (SELECT count(*)
                FROM north_star_module.${storageV1.entities[0]!.physicalTableName}
               WHERE record_id = $1) AS business_rows,
             (SELECT count(*)
                FROM platform.trust_business_change_documents
               WHERE record_id = $1::text) AS business_changes,
             (SELECT count(*)
                FROM platform.semantic_operation_receipts
               WHERE tenant_id = $2
                 AND environment_id = $3
                 AND action_id = $4
                 AND idempotency_key = $5) AS receipts`,
          [
            concurrentRecordId,
            tenantA,
            environmentA,
            `${FIXTURE_IDS.namespace}:operation.master_create`,
            concurrentKey,
          ],
        );
        assert.deepEqual(concurrentPersistence.rows[0], {
          business_changes: '1',
          business_rows: '1',
          receipts: '1',
        });

        for (const [recordId, number] of [
          [acmeOneId, 'A-002'],
          [acmeTwoId, 'A-003'],
        ]) {
          await operation(operationGateway, viewA1, 'master_create', {
            recordId,
            values: {
              [FIXTURE_IDS.fieldIds.parentName]: 'Acme',
              [FIXTURE_IDS.fieldIds.parentNumber]: number,
            },
          });
        }
        await operation(
          operationGateway,
          viewB1,
          'master_create',
          {
            recordId: tenantBId,
            values: {
              [FIXTURE_IDS.fieldIds.parentName]: 'Tenant B',
              [FIXTURE_IDS.fieldIds.parentNumber]: 'B-001',
            },
          },
          FIXTURE_IDS.namespace,
          soloKey,
        );
        await assertReceiptTenantIsolation(
          runtimePool,
          contexts.a!,
          contexts.b!,
          soloKey,
        );

        const get = await query(queryGateway, viewA1, 'master_get', {
          recordId: soloId,
        });
        assert.equal(get.outcome, 'exact');
        assert.deepEqual(get.records[0]?.values, {
          [FIXTURE_IDS.fieldIds.parentName]: 'Solo',
        });
        assertNoPhysicalDetails(get);

        const list = await query(queryGateway, viewA1, 'master_list', {
          limit: 20,
        });
        assert.equal(list.outcome, 'exact');
        assert.equal(list.records.length, 4);
        assert.equal(
          list.records.some((record) => record.recordId === tenantBId),
          false,
        );

        const search = await query(queryGateway, viewA1, 'master_search', {
          text: 'acm',
        });
        assert.equal(search.outcome, 'exact');
        assert.equal(search.records.length, 2);
        const unusableQueryProjection = runtimeProjection(
          v1,
          REQUEST_RUNTIME_PROJECTION_FAMILIES.query,
        );
        const unusableQueryPayload = structuredClone(
          unusableQueryProjection.payload,
        ) as {
          queries: Array<{
            queryId: string;
            selections: Array<{ fieldId: string }>;
          }>;
        };
        const unusableSearch = unusableQueryPayload.queries.find(
          (candidate) =>
            candidate.queryId ===
            `${FIXTURE_IDS.namespace}:query.master_search`,
        );
        assert.ok(unusableSearch?.selections[0]);
        unusableSearch.selections = [
          {
            ...unusableSearch.selections[0],
            fieldId: FIXTURE_IDS.fieldIds.parentNotes,
          },
        ];
        const unusableSearchView = await issuedCandidateView(
          v1,
          releasesA[1]!,
          identity(tenantA, environmentA, principalA),
          viewA1.pointer,
          new AllowPolicy(),
          Object.freeze({
            ...unusableQueryProjection,
            payload: unusableQueryPayload as ImmutableJsonValue,
          }),
        );
        await assert.rejects(
          query(queryGateway, unusableSearchView, 'master_search', {
            text: 'acm',
          }),
          (error: unknown) =>
            assertModuleError(
              error,
              'MODULE_SEARCH_CAPABILITY_UNAVAILABLE',
              `${FIXTURE_IDS.namespace}:query.master_search`,
            ),
          'a registered search with zero usable lowered columns must refuse by name instead of returning a plausible empty result',
        );
        assert.equal(
          (
            await query(queryGateway, viewA1, 'master_resolve', {
              text: 'a-001',
            })
          ).outcome,
          'exact',
        );
        const advisorySingle = await query(
          queryGateway,
          viewA1,
          'master_resolve',
          { text: 'Solo' },
        );
        assert.equal(advisorySingle.outcome, 'ambiguous');
        assert.equal(advisorySingle.records.length, 1);
        const advisoryMultiple = await query(
          queryGateway,
          viewA1,
          'master_resolve',
          { text: 'Acme' },
        );
        assert.equal(advisoryMultiple.outcome, 'ambiguous');
        assert.equal(advisoryMultiple.records.length, 2);
        assert.equal(
          (
            await query(queryGateway, viewA1, 'master_resolve', {
              text: 'Missing',
            })
          ).outcome,
          'not-found',
        );
        assert.equal(
          (
            await query(queryGateway, viewA1, 'master_resolve', {
              text: 'B-001',
            })
          ).outcome,
          'not-found',
        );

        const updated = await operation(
          operationGateway,
          viewA1,
          'master_update',
          {
            expectedRevision: 1,
            patch: { [FIXTURE_IDS.fieldIds.parentName]: 'Solo Updated' },
            recordId: soloId,
          },
        );
        assert.equal(updated.readBack?.revision, 2);
        const archived = await operation(
          operationGateway,
          viewA1,
          'master_archive',
          { expectedRevision: 2, recordId: soloId },
        );
        assert.equal(archived.readBack?.archived, true);
        assert.equal(
          (
            await query(queryGateway, viewA1, 'master_get', {
              recordId: soloId,
            })
          ).outcome,
          'not-found',
        );
        assert.equal(
          (
            await query(queryGateway, viewA1, 'master_get', {
              includeArchived: true,
              recordId: soloId,
            })
          ).outcome,
          'exact',
        );
        const restored = await operation(
          operationGateway,
          viewA1,
          'master_restore',
          { expectedRevision: 3, recordId: soloId },
        );
        assert.equal(restored.readBack?.archived, false);

        const childId = randomUUID();
        const childCreated = await operation(
          operationGateway,
          viewA1,
          'master_role_create',
          {
            recordId: childId,
            relations: {
              [`${FIXTURE_IDS.namespace}:relation.master_role_parent`]: soloId,
            },
            values: {
              [FIXTURE_IDS.fieldIds.childRole]: FIXTURE_IDS.optionIds.owner,
            },
          },
        );
        assert.equal(childCreated.readBack?.revision, 1);
        assert.equal(
          (
            await operation(operationGateway, viewA1, 'master_role_update', {
              expectedRevision: 1,
              patch: {
                [FIXTURE_IDS.fieldIds.childRole]: FIXTURE_IDS.optionIds.buyer,
              },
              recordId: childId,
            })
          ).readBack?.revision,
          2,
        );
        assert.equal(
          (
            await operation(operationGateway, viewA1, 'master_role_archive', {
              expectedRevision: 2,
              recordId: childId,
            })
          ).readBack?.archived,
          true,
        );
        assert.equal(
          (
            await operation(operationGateway, viewA1, 'master_role_restore', {
              expectedRevision: 3,
              recordId: childId,
            })
          ).readBack?.revision,
          4,
        );

        const factsBefore = await trustFactCount(pool, tenantA, environmentA);
        await assert.rejects(
          operation(operationGateway, viewA1, 'master_role_create', {
            recordId: randomUUID(),
            relations: {
              [`${FIXTURE_IDS.namespace}:relation.master_role_parent`]:
                tenantBId,
            },
            values: {
              [FIXTURE_IDS.fieldIds.childRole]: FIXTURE_IDS.optionIds.owner,
            },
          }),
          (error: unknown) => {
            assert.ok(error instanceof ModuleRuntimeInterpreterError);
            assert.equal(error.code, 'MODULE_RELATION_TARGET_NOT_FOUND');
            assert.equal(error.message, 'relation target was not found');
            return true;
          },
        );
        assert.equal(
          await trustFactCount(pool, tenantA, environmentA),
          factsBefore + 1,
        );
        const failedInvocation = await pool.query<{
          channel: string;
          count: string;
          outcome: string;
        }>(
          `SELECT channel, outcome, count(*) AS count
             FROM platform.trust_action_invocations
            WHERE tenant_id = $1
              AND environment_id = $2
              AND failure_code = 'MODULE_RELATION_TARGET_NOT_FOUND'
            GROUP BY channel, outcome`,
          [tenantA, environmentA],
        );
        assert.deepEqual(failedInvocation.rows, [
          { channel: 'API', count: '1', outcome: 'FAILED' },
        ]);
        const deniedGateway = operationGatewayFor(
          new DenyPolicy(),
          interpreter,
        );
        await assert.rejects(
          operation(deniedGateway, viewA1, 'master_create', {
            recordId: randomUUID(),
            values: {
              [FIXTURE_IDS.fieldIds.parentName]: 'Denied',
              [FIXTURE_IDS.fieldIds.parentNumber]: 'A-DENIED',
            },
          }),
          /current policy denied operation/,
        );
        const deniedInvocation = await pool.query<{
          channel: string;
          count: string;
          outcome: string;
        }>(
          `SELECT channel, outcome, count(*) AS count
             FROM platform.trust_action_invocations
            WHERE tenant_id = $1
              AND environment_id = $2
              AND failure_code = 'SEMANTIC_OPERATION_POLICY_DENIED'
            GROUP BY channel, outcome`,
          [tenantA, environmentA],
        );
        assert.deepEqual(deniedInvocation.rows, [
          { channel: 'API', count: '1', outcome: 'DENIED' },
        ]);

        await prepare(materializer, contexts.a!, principalA, releasesA[2]!);
        await admitCandidate(runtimePool, contexts.a!, releasesA[2]!, v2);
        await setPointer(pool, tenantA, environmentA, releasesA[2]!);
        const viewA2 = await issuedView(entry, 'a');
        assert.notEqual(viewA2.release.contentHash, viewA1.release.contentHash);
        const recompileFactsBefore = await trustFactCount(
          pool,
          tenantA,
          environmentA,
        );
        const recompileReplay = await operation(
          operationGateway,
          viewA2,
          'master_create',
          soloInput,
          FIXTURE_IDS.namespace,
          soloKey,
        );
        assert.deepEqual(recompileReplay, created);
        assert.equal(
          await trustFactCount(pool, tenantA, environmentA),
          recompileFactsBefore,
        );
        assert.equal(await moduleRecordCount(pool, storageV1, soloId), 1);
        const v2Update = await operation(
          operationGateway,
          viewA2,
          'master_update',
          {
            expectedRevision: 4,
            patch: { [FIXTURE_IDS.fieldIds.parentNotes]: 'served by v2' },
            recordId: soloId,
          },
        );
        assert.equal(v2Update.readBack?.revision, 5);
        assert.deepEqual(v2Update.readBack?.values, {
          [FIXTURE_IDS.fieldIds.parentAmount]: null,
          [FIXTURE_IDS.fieldIds.parentLocalTime]: null,
          [FIXTURE_IDS.fieldIds.parentName]: 'Solo Updated',
          [FIXTURE_IDS.fieldIds.parentNotes]: 'served by v2',
          [FIXTURE_IDS.fieldIds.parentUtcInstant]: null,
        });
        const oldPinned = await query(queryGateway, viewA1, 'master_get', {
          recordId: soloId,
        });
        const newPinned = await query(queryGateway, viewA2, 'master_get', {
          recordId: soloId,
        });
        assert.deepEqual(Object.keys(oldPinned.records[0]!.values), [
          FIXTURE_IDS.fieldIds.parentName,
        ]);
        assert.deepEqual(Object.keys(newPinned.records[0]!.values), [
          FIXTURE_IDS.fieldIds.parentName,
          FIXTURE_IDS.fieldIds.parentNotes,
          FIXTURE_IDS.fieldIds.parentLocalTime,
          FIXTURE_IDS.fieldIds.parentUtcInstant,
          FIXTURE_IDS.fieldIds.parentAmount,
        ]);
        assert.equal(
          newPinned.records[0]?.values[FIXTURE_IDS.fieldIds.parentNotes],
          'served by v2',
        );
        assert.equal(
          (
            await query(queryGateway, viewA2, 'master_resolve', {
              text: 'served by v2',
            })
          ).outcome,
          'not-found',
        );
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          modulePool.end(),
        ]);
      }
    },
  );
});

test('v3 inventory reads require issued legal-entity scope and preserve generic operations', async () => {
  const definition = inventoryApplicationDefinition();
  const emptyInventory = emptyDefinition(ordinaryModuleV1());
  const empty = mustCompile(moduleInput(emptyInventory));
  const compiled = mustCompile(
    moduleInput(definition, expectedActiveReleaseFrom(empty)),
  );
  const storage = compiledProjectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  assert.equal(storage.schemaVersion, STORAGE_TARGET_PAYLOAD_V3_VERSION);
  const periodLock = storage.entities.find(
    (entity) =>
      entity.entityId ===
      applicationInventoryId(INVENTORY_IDS.entityIds.periodLock),
  );
  assert.ok(periodLock?.periodLock);
  assert.ok(periodLock.legalEntity?.column);
  const periodLockStorage = periodLock.periodLock;
  const periodLockLegalEntityColumn = periodLock.legalEntity.column;
  const legalEntityMaster = storage.entities.find(
    (entity) => entity.legalEntityMaster !== undefined,
  );
  const item = storage.entities.find(
    (entity) => entity.entityId === `${APPLICATION_NAMESPACE}:entity.item`,
  );
  const location = storage.entities.find(
    (entity) => entity.entityId === `${APPLICATION_NAMESPACE}:entity.location`,
  );
  const movement = storage.entities.find(
    (entity) =>
      entity.entityId ===
      applicationInventoryId(INVENTORY_IDS.entityIds.movement),
  );
  const transaction = storage.entities.find(
    (entity) =>
      entity.entityId ===
      applicationInventoryId(INVENTORY_IDS.entityIds.transaction),
  );
  const transactionLine = storage.entities.find(
    (entity) =>
      entity.entityId ===
      applicationInventoryId(INVENTORY_IDS.entityIds.transactionLine),
  );
  assert.ok(
    legalEntityMaster?.legalEntityMaster,
    'compiled target has no legal-entity master',
  );
  assert.ok(item, 'compiled target has no Item entity');
  assert.ok(location, 'compiled target has no Location entity');
  assert.equal(item.legalEntity, undefined);
  assert.equal(location.legalEntity, undefined);
  const legalEntityMasterStorage = legalEntityMaster.legalEntityMaster;
  assert.ok(movement?.legalEntity?.column);
  assert.ok(transaction?.legalEntity?.column);
  assert.ok(transactionLine?.legalEntity?.column);
  const transactionLegalEntityColumn = transaction.legalEntity.column;

  const tenant = 'd1000000-0000-4000-8000-000000000001';
  const environment = 'd2000000-0000-4000-8000-000000000002';
  const principal = 'd3000000-0000-4000-8000-000000000003';
  const closedThrough = '2026-07-28T23:59:59.999Z';
  const legalEntityId = randomUUID();
  const secondLegalEntityId = randomUUID();

  await withEphemeralPostgres(
    'module-runtime-inventory-v3',
    async ({ connection, pool }) => {
      await migrateAndSeed(pool, [[tenant, environment, 'inventory-v3']]);
      for (const [entityId, code, name] of [
        [legalEntityId, 'ENTITY-A', 'Legal entity A'],
        [secondLegalEntityId, 'ENTITY-B', 'Legal entity B'],
      ] as const) {
        await pool.query(
          `SELECT platform.provision_inventory_scope(
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9::smallint, $10, $11, $12, $13, $14, $15, $16,
             $17, $18, $19, $20, $21
           )`,
          [
            tenant,
            environment,
            entityId,
            code,
            name,
            'America/Edmonton',
            '00:00:00',
            compiled.releaseRoot,
            1,
            'reject',
            0,
            'codeOnly',
            'codeOnly',
            'codeOnly',
            'codeOnly',
            'codeOnly',
            null,
            null,
            null,
            null,
            null,
          ],
        );
      }
      const runtimePool = new pg.Pool({
        ...connection,
        max: 3,
        user: 'north_star_runtime',
      });
      const materializerPool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_module_materializer',
      });
      const modulePool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_module_runtime',
      });
      materializerPool.on('error', () => undefined);
      modulePool.on('error', () => undefined);
      try {
        const contexts = await contextsFor([
          ['inventory', tenant, environment, principal],
        ]);
        const context = contexts.inventory!;
        const releases = await persistSequence(runtimePool, context, [
          [empty, emptyInventory],
          [compiled, definition],
        ]);
        await setPointer(pool, tenant, environment, releases[0]!);
        await grantExecutorAuthority(pool, [[tenant, principal]]);

        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        );
        await prepare(materializer, context, principal, releases[1]!);
        for (const [entityId, code, name] of [
          [legalEntityId, 'ENTITY-A', 'Legal entity A'],
          [secondLegalEntityId, 'ENTITY-B', 'Legal entity B'],
        ] as const) {
          await pool.query(
            `INSERT INTO north_star_module.${legalEntityMaster.physicalTableName} (
               tenant_id,
               environment_id,
               ${legalEntityMaster.recordIdentity.column},
               ${legalEntityMaster.optimisticRevision.column},
               ${legalEntityMasterStorage.fieldColumns.code},
               ${legalEntityMasterStorage.fieldColumns.name},
               ${legalEntityMasterStorage.fieldColumns.status},
               ${legalEntityMasterStorage.fieldColumns.isDefault}
             ) VALUES ($1, $2, $3, 1, $4, $5, $6, false)
             ON CONFLICT (tenant_id, environment_id, ${legalEntityMaster.recordIdentity.column})
             DO NOTHING`,
            [
              tenant,
              environment,
              entityId,
              code,
              name,
              legalEntityMasterStorage.activeStatusValue,
            ],
          );
        }

        const provisioned = await pool.query<{
          closed_through: Date | null;
          legal_entity_id: string;
          record_id: string;
          revision: string;
        }>(
          `SELECT ${periodLockLegalEntityColumn} AS legal_entity_id,
                  ${periodLock.recordIdentity.column} AS record_id,
                  ${periodLock.optimisticRevision.column}::text AS revision,
                  ${periodLockStorage.closedThroughColumn} AS closed_through
             FROM north_star_module.${periodLock.physicalTableName}
            WHERE tenant_id = $1 AND environment_id = $2`,
          [tenant, environment],
        );
        assert.equal(provisioned.rowCount, 2);
        const locksByLegalEntity = new Map<string, number>();
        for (const row of provisioned.rows) {
          locksByLegalEntity.set(
            row.legal_entity_id,
            (locksByLegalEntity.get(row.legal_entity_id) ?? 0) + 1,
          );
          assert.equal(row.record_id, row.legal_entity_id);
          assert.equal(row.revision, '1');
          assert.equal(row.closed_through, null);
        }
        assert.deepEqual(
          locksByLegalEntity,
          new Map([
            [legalEntityId, 1],
            [secondLegalEntityId, 1],
          ]),
        );
        assert.equal(
          new Set(provisioned.rows.map((row) => row.record_id)).size,
          2,
        );
        const recordId = legalEntityId;

        const policy = new AllowPolicy();
        const interpreter = new PostgresModuleRuntimeInterpreter(
          runtimePool,
          humanActorIssuer(),
        );
        const queryGateway = new SemanticQueryGateway(policy, interpreter);
        const recordingExecutor = new RecordingForwardingOperationExecutor(
          interpreter,
        );
        const gateway = operationGatewayFor(policy, recordingExecutor);
        const activePointer = await pool.query<{
          fence: string;
          pointer_id: string;
        }>(
          `SELECT pointer_id, fence::text
             FROM platform.active_release_pointers
            WHERE tenant_id = $1 AND environment_id = $2`,
          [tenant, environment],
        );
        assert.ok(activePointer.rows[0]);
        const view = await issuedCandidateView(
          compiled,
          releases[1]!,
          identity(tenant, environment, principal),
          {
            fence: Number(activePointer.rows[0].fence),
            pointerId: activePointer.rows[0].pointer_id,
          },
          policy,
        );
        const transactionAId = randomUUID();
        const transactionBId = randomUUID();
        const lineAId = randomUUID();
        const lineBId = randomUUID();
        const movementAId = randomUUID();
        const movementBId = randomUUID();
        const adversarialMovementId = randomUUID();
        const sharedItemId = randomUUID();
        const sharedLocationId = randomUUID();
        const entityAStockIdentity = Object.freeze({
          itemId: sharedItemId,
          locationId: sharedLocationId,
        });
        const entityBStockIdentity = Object.freeze({
          itemId: sharedItemId,
          locationId: sharedLocationId,
        });
        assert.deepEqual(entityAStockIdentity, entityBStockIdentity);

        await insertTenantSharedTestRecord(
          pool,
          item,
          tenant,
          environment,
          sharedItemId,
        );
        await insertTenantSharedTestRecord(
          pool,
          location,
          tenant,
          environment,
          sharedLocationId,
        );

        const gatewayCreateRecordId = randomUUID();
        const gatewayCreateInput = inventoryTransactionCreateInput(
          legalEntityId,
          gatewayCreateRecordId,
          'DIRECT-OPERAND-GATEWAY',
        );
        const gatewayCreated = await operation(
          gateway,
          view,
          'inventory_transaction_create',
          gatewayCreateInput,
          APPLICATION_NAMESPACE,
        );
        assert.equal(gatewayCreated.outcome, 'succeeded');
        const gatewayExecution = recordingExecutor.calls.at(-1);
        assert.ok(gatewayExecution);

        // The exact gateway-built request is accepted when handed straight to
        // the public generic executor. This is intentionally NOT a sealed
        // receipt: under the untrusted-operand ruling an internal adapter can
        // construct the same request and the provider cannot distinguish it.
        const directReplay = await interpreter.execute(
          Object.freeze({ ...gatewayExecution }),
        );
        assert.equal(directReplay.outcome, 'succeeded');
        assert.deepEqual(directReplay.trust, gatewayCreated.trust);

        // A fresh direct request proves that success above is not merely the
        // idempotency receipt. Only record/idempotency identity changes to
        // avoid a primary-key collision; the legal-entity operand and business
        // values are the same, and the request never crosses the gateway.
        const directCreateRecordId = randomUUID();
        const directInput = inventoryTransactionCreateInput(
          legalEntityId,
          directCreateRecordId,
          'DIRECT-OPERAND-EXECUTOR',
        );
        const directCreated = await interpreter.execute(
          Object.freeze({
            ...gatewayExecution,
            idempotencyKey: randomUUID(),
            input: directInput,
            inputDigest: digestTestOperationInput(directInput),
          }),
        );
        assert.equal(directCreated.outcome, 'succeeded');
        const directlyPersisted = await pool.query<{
          legal_entity_id: string;
          record_id: string;
        }>(
          `SELECT ${transaction.recordIdentity.column}::text AS record_id,
                  ${transactionLegalEntityColumn}::text AS legal_entity_id
             FROM north_star_module.${transaction.physicalTableName}
            WHERE tenant_id = $1 AND environment_id = $2
              AND ${transaction.recordIdentity.column} = ANY($3::uuid[])
            ORDER BY ${transaction.recordIdentity.column}`,
          [tenant, environment, [gatewayCreateRecordId, directCreateRecordId]],
        );
        assert.deepEqual(
          directlyPersisted.rows,
          [
            {
              legal_entity_id: legalEntityId,
              record_id: gatewayCreateRecordId,
            },
            {
              legal_entity_id: legalEntityId,
              record_id: directCreateRecordId,
            },
          ].toSorted((left, right) =>
            left.record_id.localeCompare(right.record_id),
          ),
        );

        await insertScopedTestRecord(
          pool,
          storage,
          transaction,
          tenant,
          environment,
          legalEntityId,
          transactionAId,
          {
            [applicationInventoryId(INVENTORY_IDS.fieldIds.transaction.number)]:
              'ENTITY-A-TRANSACTION',
            [applicationInventoryId(INVENTORY_IDS.fieldIds.transaction.state)]:
              `${APPLICATION_NAMESPACE}:option.inventory_transaction_state_posted`,
          },
          {},
        );
        await insertScopedTestRecord(
          pool,
          storage,
          transaction,
          tenant,
          environment,
          secondLegalEntityId,
          transactionBId,
          {
            [applicationInventoryId(INVENTORY_IDS.fieldIds.transaction.number)]:
              'ENTITY-B-SECRET',
            [applicationInventoryId(INVENTORY_IDS.fieldIds.transaction.state)]:
              `${APPLICATION_NAMESPACE}:option.inventory_transaction_state_posted`,
          },
          {},
        );
        await insertScopedTestRecord(
          pool,
          storage,
          transactionLine,
          tenant,
          environment,
          legalEntityId,
          lineAId,
          {
            [applicationInventoryId(
              INVENTORY_IDS.fieldIds.transactionLine.itemId,
            )]: entityAStockIdentity.itemId,
          },
          { [transaction.entityId]: transactionAId },
        );
        await insertScopedTestRecord(
          pool,
          storage,
          transactionLine,
          tenant,
          environment,
          secondLegalEntityId,
          lineBId,
          {
            [applicationInventoryId(
              INVENTORY_IDS.fieldIds.transactionLine.itemId,
            )]: entityBStockIdentity.itemId,
          },
          { [transaction.entityId]: transactionBId },
        );
        await insertScopedTestRecord(
          pool,
          storage,
          movement,
          tenant,
          environment,
          legalEntityId,
          movementAId,
          movementScopeProbeValues(
            entityAStockIdentity.itemId,
            entityAStockIdentity.locationId,
            '5',
          ),
          {
            [transaction.entityId]: transactionAId,
            [transactionLine.entityId]: lineAId,
          },
          '2026-07-29',
        );
        await insertScopedTestRecord(
          pool,
          storage,
          movement,
          tenant,
          environment,
          secondLegalEntityId,
          movementBId,
          movementScopeProbeValues(
            entityBStockIdentity.itemId,
            entityBStockIdentity.locationId,
            '7',
          ),
          {
            [transaction.entityId]: transactionBId,
            [transactionLine.entityId]: lineBId,
          },
          '2026-07-29',
        );

        const scopeA = await issueLegalEntityReadScope(policy, view, [
          legalEntityId,
        ]);
        const scopeB = await issueLegalEntityReadScope(policy, view, [
          secondLegalEntityId,
        ]);
        const consolidatedScope = await issueLegalEntityReadScope(
          policy,
          view,
          [legalEntityId, secondLegalEntityId],
        );
        await assert.rejects(
          issueLegalEntityReadScope(policy, view, []),
          InvalidLegalEntityReadScopeSelectionError,
        );
        const [allowedFirstId, deniedSecondId] = [
          legalEntityId,
          secondLegalEntityId,
        ].toSorted();
        assert.ok(allowedFirstId);
        assert.ok(deniedSecondId);
        const mixedIssuancePolicy = new SelectiveLegalEntityPolicy();
        mixedIssuancePolicy.deny(deniedSecondId);
        await assert.rejects(
          issueLegalEntityReadScope(mixedIssuancePolicy, view, [
            deniedSecondId,
            allowedFirstId,
          ]),
          (error: unknown) =>
            error instanceof LegalEntityReadScopePolicyDeniedError &&
            error.legalEntityId === deniedSecondId,
        );
        assert.deepEqual(mixedIssuancePolicy.legalEntityAuthorizationCalls, [
          allowedFirstId,
          deniedSecondId,
        ]);
        const aggregateArguments = {
          [inventoryScopeProbeIds.itemParameter]: sharedItemId,
          [inventoryScopeProbeIds.locationParameter]: sharedLocationId,
        };
        assert.equal(
          (
            await aggregateQuery(queryGateway, view, aggregateArguments, {
              legalEntityReadScope: scopeA,
            })
          ).value.value,
          '5',
        );
        assert.equal(
          (
            await aggregateQuery(queryGateway, view, aggregateArguments, {
              legalEntityReadScope: scopeB,
            })
          ).value.value,
          '7',
        );
        assert.equal(
          (
            await aggregateQuery(queryGateway, view, aggregateArguments, {
              legalEntityReadScope: consolidatedScope,
            })
          ).value.value,
          '12',
        );

        const memberRecheckPolicy = new SelectiveLegalEntityPolicy();
        const memberRecheckGateway = new SemanticQueryGateway(
          memberRecheckPolicy,
          interpreter,
        );
        const memberRecheckScope = await issueLegalEntityReadScope(
          memberRecheckPolicy,
          view,
          [deniedSecondId, allowedFirstId],
        );
        memberRecheckPolicy.resetLegalEntityAuthorizationCalls();
        memberRecheckPolicy.deny(deniedSecondId);
        await assert.rejects(
          aggregateQuery(memberRecheckGateway, view, aggregateArguments, {
            legalEntityReadScope: memberRecheckScope,
          }),
          (error: unknown) =>
            error instanceof LegalEntityReadScopePolicyDeniedError &&
            error.legalEntityId === deniedSecondId,
        );
        assert.deepEqual(memberRecheckPolicy.legalEntityAuthorizationCalls, [
          allowedFirstId,
          deniedSecondId,
        ]);

        const advancedPolicy = new SelectiveLegalEntityPolicy();
        const advancedPolicyGateway = new SemanticQueryGateway(
          advancedPolicy,
          interpreter,
        );
        const staleScope = await issueLegalEntityReadScope(
          advancedPolicy,
          view,
          [legalEntityId],
        );
        advancedPolicy.resetLegalEntityAuthorizationCalls();
        advancedPolicy.setPolicyVersion('module-runtime-selective-policy/v2');
        await assert.rejects(
          aggregateQuery(advancedPolicyGateway, view, aggregateArguments, {
            legalEntityReadScope: staleScope,
          }),
          (error: unknown) =>
            assertLegalEntityReadScopeIntegrityError(
              error,
              movement.entityId,
              'issued legal-entity read scope policy is no longer current',
            ),
        );
        assert.deepEqual(advancedPolicy.legalEntityAuthorizationCalls, [
          legalEntityId,
        ]);
        const unscopedDefect = await pool.query<{
          contains_combined_quantity: boolean;
        }>(
          `SELECT COALESCE(SUM(${
            requiredStorageColumn(
              movement,
              INVENTORY_IDS.fieldIds.movement.quantityDelta,
            ).physicalName
          }), 0) = 12::numeric AS contains_combined_quantity
             FROM north_star_module.${movement.physicalTableName}
            WHERE tenant_id = $1 AND environment_id = $2
              AND ${
                requiredStorageColumn(
                  movement,
                  INVENTORY_IDS.fieldIds.movement.itemId,
                ).physicalName
              } = $3
              AND ${
                requiredStorageColumn(
                  movement,
                  INVENTORY_IDS.fieldIds.movement.locationId,
                ).physicalName
              } = $4`,
          [tenant, environment, sharedItemId, sharedLocationId],
        );
        assert.equal(unscopedDefect.rows[0]?.contains_combined_quantity, true);

        await assert.rejects(
          aggregateQuery(queryGateway, view, aggregateArguments),
          (error: unknown) =>
            assertModuleError(
              error,
              'MODULE_LEGAL_ENTITY_READ_SCOPE_REQUIRED',
              movement.entityId,
            ),
        );
        const nonexistentId = randomUUID();
        const nonexistentScope = await issueLegalEntityReadScope(policy, view, [
          nonexistentId,
        ]);
        await assert.rejects(
          aggregateQuery(queryGateway, view, aggregateArguments, {
            legalEntityReadScope: nonexistentScope,
          }),
          (error: unknown) =>
            assertModuleError(
              error,
              'MODULE_LEGAL_ENTITY_READ_SCOPE_NOT_FOUND',
              nonexistentId,
            ),
        );
        const copiedScope = Object.freeze({
          ...scopeA,
          legalEntityIds: Object.freeze([secondLegalEntityId]),
        });
        await assert.rejects(
          aggregateQuery(queryGateway, view, aggregateArguments, {
            legalEntityReadScope: copiedScope,
          }),
          (error: unknown) =>
            assertLegalEntityReadScopeIntegrityError(
              error,
              movement.entityId,
              'legal-entity read scope must be issued for this request runtime view',
            ),
        );
        const otherView = await issuedCandidateView(
          compiled,
          releases[1]!,
          identity(tenant, environment, principal),
          {
            fence: Number(activePointer.rows[0].fence),
            pointerId: activePointer.rows[0].pointer_id,
          },
          policy,
        );
        const otherViewScope = await issueLegalEntityReadScope(
          policy,
          otherView,
          [legalEntityId],
        );
        await assert.rejects(
          aggregateQuery(queryGateway, view, aggregateArguments, {
            legalEntityReadScope: otherViewScope,
          }),
          (error: unknown) =>
            assertLegalEntityReadScopeIntegrityError(
              error,
              movement.entityId,
              'legal-entity read scope must be issued for this request runtime view',
            ),
        );
        await assert.rejects(
          issueLegalEntityReadScope(new DenyPolicy(), view, [legalEntityId]),
          (error: unknown) =>
            error instanceof LegalEntityReadScopePolicyDeniedError &&
            error.legalEntityId === legalEntityId,
        );

        const tenantShared = await query(
          queryGateway,
          view,
          'legal_entity_list',
          { includeArchived: false, limit: 10 },
          APPLICATION_NAMESPACE,
        );
        assert.equal(tenantShared.records.length, 2);

        const adversarialClient = await pool.connect();
        try {
          await adversarialClient.query(
            'SET session_replication_role = replica',
          );
          await insertScopedTestRecord(
            adversarialClient,
            storage,
            movement,
            tenant,
            environment,
            legalEntityId,
            adversarialMovementId,
            movementScopeProbeValues(sharedItemId, sharedLocationId, '0'),
            {
              [transaction.entityId]: transactionBId,
              [transactionLine.entityId]: lineAId,
            },
            '2026-07-29',
          );
        } finally {
          await adversarialClient.query(
            'SET session_replication_role = origin',
          );
          adversarialClient.release();
        }
        const movementListQueryId = `${APPLICATION_NAMESPACE}:query.inventory_movement_list`;
        const queryCatalog = view.projections.query.payload;
        assert.ok(isImmutableJsonObject(queryCatalog));
        assert.ok(Array.isArray(queryCatalog.queries));
        const movementListDefinition = queryCatalog.queries.find(
          (candidate) =>
            isImmutableJsonObject(candidate) &&
            candidate.queryId === movementListQueryId,
        );
        assert.ok(isImmutableJsonObject(movementListDefinition));
        const movementListScope = movementListDefinition.legalEntityScope;
        assert.ok(isImmutableJsonObject(movementListScope));
        const movementListScopeOperand = movementListScope.operand;
        assert.ok(isImmutableJsonObject(movementListScopeOperand));
        const movementListScopeParameterId =
          movementListScopeOperand.parameterId;
        assert.ok(typeof movementListScopeParameterId === 'string');
        const movementListArguments = {
          [movementListScopeParameterId]: legalEntityId,
          includeArchived: false,
          list: {
            cursor: null,
            matchMode: 'substring',
            pageSize: 10,
            relationLabels: [
              {
                fieldId: applicationInventoryId(
                  INVENTORY_IDS.fieldIds.transaction.number,
                ),
                queryId: `${APPLICATION_NAMESPACE}:query.inventory_transaction_list`,
                relationId: applicationInventoryId(
                  INVENTORY_IDS.relationIds.movementTransaction,
                ),
              },
            ],
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            search: '',
            sort: [],
          },
        };
        await assert.rejects(
          query(
            queryGateway,
            view,
            'inventory_movement_list',
            movementListArguments,
            APPLICATION_NAMESPACE,
            { legalEntityReadScope: scopeA },
          ),
          (error: unknown) =>
            error instanceof MalformedSemanticQueryRequestError &&
            error.code === 'MALFORMED_SEMANTIC_QUERY_REQUEST' &&
            error.message ===
              'query declares a legal-entity operand and cannot also take an issued scope',
        );
        const joined = await query(
          queryGateway,
          view,
          'inventory_movement_list',
          movementListArguments,
          APPLICATION_NAMESPACE,
        );
        assert.equal(joined.records.length, 2);
        const normalJoined = joined.records.find(
          (record) => record.recordId === movementAId,
        );
        const adversarialJoined = joined.records.find(
          (record) => record.recordId === adversarialMovementId,
        );
        const relationId = applicationInventoryId(
          INVENTORY_IDS.relationIds.movementTransaction,
        );
        assert.equal(
          normalJoined?.relationLabels?.[relationId]?.label,
          'ENTITY-A-TRANSACTION',
        );
        assert.equal(
          normalJoined?.relationLabels?.[relationId]?.recordId,
          transactionAId,
        );
        assert.deepEqual(adversarialJoined?.relationLabels?.[relationId], {
          label: null,
          recordId: null,
        });
        assert.doesNotMatch(JSON.stringify(joined), /ENTITY-B-SECRET/u);
        assert.doesNotMatch(
          JSON.stringify(joined),
          new RegExp(transactionBId, 'u'),
        );

        const result = await operation(
          gateway,
          view,
          'advance_period_lock',
          {
            expectedRevision: 1,
            patch: {
              [applicationInventoryId(
                INVENTORY_IDS.fieldIds.periodLock.closedThrough,
              )]: closedThrough,
            },
            recordId,
          },
          APPLICATION_NAMESPACE,
        );
        assert.equal(result.outcome, 'succeeded');
        assert.equal(result.readBack?.recordId, recordId);
        assert.equal(result.readBack?.revision, 2);
        assert.equal(
          result.readBack?.values[
            applicationInventoryId(
              INVENTORY_IDS.fieldIds.periodLock.closedThrough,
            )
          ],
          closedThrough,
        );
        assert.ok(result.trust);

        const persisted = await pool.query<{
          closed_through: Date;
          revision: string;
        }>(
          `SELECT ${periodLock.optimisticRevision.column}::text AS revision,
                  ${periodLockStorage.closedThroughColumn} AS closed_through
             FROM north_star_module.${periodLock.physicalTableName}
            WHERE tenant_id = $1 AND environment_id = $2
              AND ${periodLock.recordIdentity.column} = $3`,
          [tenant, environment, recordId],
        );
        assert.equal(persisted.rows[0]?.revision, '2');
        assert.equal(
          persisted.rows[0]?.closed_through.toISOString(),
          closedThrough,
        );

        const updateColumns = await pool.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.column_privileges
            WHERE table_schema = 'north_star_module'
              AND table_name = $1
              AND grantee = 'north_star_module_runtime'
              AND privilege_type = 'UPDATE'
            ORDER BY column_name`,
          [periodLock.physicalTableName],
        );
        assert.deepEqual(
          updateColumns.rows.map(({ column_name }) => column_name),
          [
            periodLockStorage.closedThroughColumn,
            periodLock.optimisticRevision.column,
          ].toSorted(),
        );
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          modulePool.end(),
        ]);
      }
    },
  );
});

test('metamorphic random namespace executes the compiled declared-semantics contract without module code', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const namespace = `northstar.metamorphic${suffix}`;
  const definition = ordinaryModuleV2ForNamespace(namespace) as {
    fields: Array<{ classification: string; fieldId: string }>;
  } & Record<string, unknown>;
  const publicName = definition.fields.find(
    (field) => field.fieldId === `${namespace}:field.master_name`,
  );
  assert.ok(publicName);
  publicName.classification = 'public';
  const empty = mustCompile(moduleInput(emptyDefinition(definition)));
  const compiled = mustCompile(
    moduleInput(definition, expectedActiveReleaseFrom(empty)),
  );
  const tenant = 'c1000000-0000-4000-8000-000000000001';
  const environment = 'c2000000-0000-4000-8000-000000000002';
  const principal = 'c3000000-0000-4000-8000-000000000003';

  await withEphemeralPostgres(
    'module-metamorphic',
    async ({ connection, pool }) => {
      await migrateAndSeed(pool, [[tenant, environment, 'metamorphic']]);
      const runtimePool = new pg.Pool({
        ...connection,
        max: 3,
        user: 'north_star_runtime',
      });
      const materializerPool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_module_materializer',
      });
      const modulePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_module_runtime',
      });
      try {
        const context = (
          await contextsFor([['m', tenant, environment, principal]])
        ).m!;
        const releases = await persistSequence(runtimePool, context, [
          [empty, emptyDefinition(definition)],
          [compiled, definition],
        ]);
        await setPointer(pool, tenant, environment, releases[0]!);
        await grantExecutorAuthority(pool, [[tenant, principal]]);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        );
        await prepare(materializer, context, principal, releases[1]!);
        await admitCandidate(runtimePool, context, releases[1]!, compiled);
        await setPointer(pool, tenant, environment, releases[1]!);

        const policy = new AllowPolicy();
        const interpreter = new PostgresModuleRuntimeInterpreter(
          runtimePool,
          humanActorIssuer(),
        );
        const operations = operationGatewayFor(policy, interpreter);
        const queries = new SemanticQueryGateway(policy, interpreter);
        const entry = runtimeEntry(runtimePool, {
          m: identity(tenant, environment, principal),
        });
        const view = await issuedView(entry, 'm');
        const recordId = randomUUID();
        const result = await operation(
          operations,
          view,
          'master_create',
          {
            recordId,
            values: {
              [`${namespace}:field.master_amount`]: '123.45',
              [`${namespace}:field.master_name`]: 'Metamorphic',
              [`${namespace}:field.master_local_time`]: '08:15:30',
              [`${namespace}:field.master_notes`]: 'never-search-this-secret',
              [`${namespace}:field.master_number`]: 'M-001',
              [`${namespace}:field.master_utc_instant`]:
                '2026-07-24T12:34:56.789Z',
            },
          },
          namespace,
        );
        assert.equal(result.outcome, 'succeeded');
        assert.ok(result.trust);
        const read = await query(
          queries,
          view,
          'master_get',
          { recordId },
          namespace,
        );
        assert.equal(read.outcome, 'exact');
        assert.equal(read.records[0]?.recordId, recordId);
        assertNoPhysicalDetails(read);
        await assertLinkedTrustFacts(pool, result, tenant, environment);
        const classifiedChanges = await pool.query<{
          changes: Array<{
            classification: string;
            fieldId: string;
            newState: { representation?: string; value?: unknown };
          }>;
        }>(
          `SELECT changes
             FROM platform.trust_business_change_documents
            WHERE change_document_id = $1`,
          [result.trust!.changeDocumentId],
        );
        const persistedPublicName = classifiedChanges.rows[0]?.changes.find(
          (change) => change.fieldId === `${namespace}.field.master_name`,
        );
        assert.deepEqual(persistedPublicName, {
          classification: 'PUBLIC',
          fieldId: `${namespace}.field.master_name`,
          newState: {
            representation: 'VALUE',
            state: 'VALUE',
            value: 'Metamorphic',
          },
          oldState: { state: 'ABSENT' },
        });

        assert.equal(
          (
            await query(
              queries,
              view,
              'master_search',
              { text: 'NEVER-SEARCH-THIS-SECRET' },
              namespace,
            )
          ).records.length,
          0,
        );
        assert.equal(
          (
            await query(
              queries,
              view,
              'master_search',
              { text: 'METAMORPHIC' },
              namespace,
            )
          ).records.length,
          1,
        );
        await assert.rejects(
          operation(
            operations,
            view,
            'master_create',
            {
              recordId: randomUUID(),
              values: {
                [`${namespace}:field.master_name`]: 'Fold duplicate',
                [`${namespace}:field.master_number`]: 'm-001',
              },
            },
            namespace,
          ),
          (error: unknown) =>
            assertModuleError(
              error,
              'MODULE_UNIQUE_VIOLATION',
              `${namespace}:field.master_number`,
            ),
        );
        for (const [number, name] of [
          ['Ｍ－１００', 'Fullwidth'],
          ['M-100', 'ASCII'],
        ] as const) {
          await operation(
            operations,
            view,
            'master_create',
            {
              recordId: randomUUID(),
              values: {
                [`${namespace}:field.master_name`]: name,
                [`${namespace}:field.master_number`]: number,
              },
            },
            namespace,
          );
        }
        assert.equal(
          (
            await query(
              queries,
              view,
              'master_resolve',
              { text: 'M-001' },
              namespace,
            )
          ).outcome,
          'exact',
        );

        await assert.rejects(
          operation(
            operations,
            view,
            'master_update',
            {
              expectedRevision: 1,
              patch: {
                [`${namespace}:field.master_tier`]: `${namespace}:option.not-declared`,
              },
              recordId,
            },
            namespace,
          ),
          (error: unknown) =>
            assertModuleError(
              error,
              'MODULE_ENUM_VALUE_INVALID',
              `${namespace}:field.master_tier`,
            ),
        );
        assert.equal(
          (
            await operation(
              operations,
              view,
              'master_update',
              {
                expectedRevision: 1,
                patch: {
                  [`${namespace}:field.master_tier`]: `${namespace}:option.standard`,
                },
                recordId,
              },
              namespace,
            )
          ).readBack?.revision,
          2,
        );
        for (const [fieldId, invalidValue] of [
          [`${namespace}:field.master_local_time`, '08:15:30.000'],
          [`${namespace}:field.master_utc_instant`, '2026-07-24T12:34:56Z'],
          [`${namespace}:field.master_amount`, '12345'],
        ] as const) {
          await assert.rejects(
            operation(
              operations,
              view,
              'master_update',
              {
                expectedRevision: 2,
                patch: { [fieldId]: invalidValue },
                recordId,
              },
              namespace,
            ),
            (error: unknown) =>
              assertModuleError(error, 'MODULE_FIELD_VALUE_INVALID', fieldId),
          );
        }

        await assert.rejects(
          operation(
            operations,
            view,
            'master_role_create',
            {
              recordId: randomUUID(),
              relations: {
                [`${namespace}:relation.master_role_parent`]: recordId,
              },
              values: {
                [`${namespace}:field.master_role_kind`]: `${namespace}:option.not-declared`,
              },
            },
            namespace,
          ),
          (error: unknown) =>
            assertModuleError(
              error,
              'MODULE_ENUM_VALUE_INVALID',
              `${namespace}:field.master_role_kind`,
            ),
        );
        const childId = randomUUID();
        await operation(
          operations,
          view,
          'master_role_create',
          {
            recordId: childId,
            relations: {
              [`${namespace}:relation.master_role_parent`]: recordId,
            },
            values: {
              [`${namespace}:field.master_role_kind`]: `${namespace}:option.owner`,
            },
          },
          namespace,
        );
        await assert.rejects(
          operation(
            operations,
            view,
            'master_archive',
            { expectedRevision: 2, recordId },
            namespace,
          ),
          (error: unknown) =>
            assertModuleError(
              error,
              'MODULE_ARCHIVE_RESTRICTED',
              `${namespace}:relation.master_role_parent`,
            ),
        );
        await operation(
          operations,
          view,
          'master_role_archive',
          { expectedRevision: 1, recordId: childId },
          namespace,
        );
        await operation(
          operations,
          view,
          'master_archive',
          { expectedRevision: 2, recordId },
          namespace,
        );
        await assert.rejects(
          operation(
            operations,
            view,
            'master_role_create',
            {
              recordId: randomUUID(),
              relations: {
                [`${namespace}:relation.master_role_parent`]: recordId,
              },
              values: {
                [`${namespace}:field.master_role_kind`]: `${namespace}:option.owner`,
              },
            },
            namespace,
          ),
          (error: unknown) =>
            assertModuleError(
              error,
              'MODULE_RELATION_VIOLATION',
              `${namespace}:relation.master_role_parent`,
            ),
        );
        await assert.rejects(
          operation(
            operations,
            view,
            'master_role_restore',
            { expectedRevision: 2, recordId: childId },
            namespace,
          ),
          (error: unknown) =>
            assertModuleError(
              error,
              'MODULE_RELATION_VIOLATION',
              `${namespace}:relation.master_role_parent`,
            ),
        );
        await operation(
          operations,
          view,
          'master_restore',
          { expectedRevision: 3, recordId },
          namespace,
        );
        await operation(
          operations,
          view,
          'master_role_restore',
          { expectedRevision: 2, recordId: childId },
          namespace,
        );

        const verificationPlan =
          compiledProjectionPayload<VerificationPlanPayloadV1>(
            compiled,
            PROJECTION_FAMILY_IDS.verificationPlan,
          );
        assert.deepEqual(
          new Set(verificationPlan.scenarios.map((scenario) => scenario.kind)),
          new Set([
            'archiveRestrict',
            'declaredEvidence',
            'enumReject',
            'resolverAuthority',
            'searchableExclusion',
            'typedErrorSurface',
            'uniquenessFold',
          ]),
        );
        for (const entityId of [
          `${namespace}:entity.master`,
          `${namespace}:entity.master_role`,
        ]) {
          assert.deepEqual(
            verificationPlan.scenarios
              .filter(
                (scenario) =>
                  scenario.kind === 'declaredEvidence' &&
                  scenario.entityId === entityId,
              )
              .map((scenario) => scenario.evidenceKind)
              .sort(),
            [
              'agent',
              'migration',
              'provider',
              'recovery',
              'structure',
              'userInterface',
            ],
          );
        }
        const verificationBinding = releaseVerificationBinding(compiled);
        const results = await executeVerificationPlan(
          verificationPlan,
          {
            artifactClosureDigest: verificationBinding.artifactClosureDigest,
            providerRunId: 'module-metamorphic',
            releaseRoot: verificationBinding.releaseRoot,
            verificationPlanArtifactRoot:
              verificationBinding.verificationPlanArtifactRoot,
            verificationPlanSemanticDigest:
              verificationBinding.verificationPlanSemanticDigest,
          },
          async (scenario) => {
            const parent = scenario.entityId === `${namespace}:entity.master`;
            const localEntity = parent ? 'master' : 'master_role';
            const scenarioRecordId = parent ? recordId : childId;
            if (scenario.kind === 'declaredEvidence') {
              if (scenario.evidenceKind === 'recovery') {
                const recoveryRecordId = randomUUID();
                if (parent) {
                  await operation(
                    operations,
                    view,
                    'master_create',
                    {
                      recordId: recoveryRecordId,
                      values: {
                        [`${namespace}:field.master_name`]: 'Recovery probe',
                        [`${namespace}:field.master_number`]: `R-${recoveryRecordId}`,
                      },
                    },
                    namespace,
                  );
                } else {
                  await operation(
                    operations,
                    view,
                    'master_role_create',
                    {
                      recordId: recoveryRecordId,
                      relations: {
                        [`${namespace}:relation.master_role_parent`]: recordId,
                      },
                      values: {
                        [`${namespace}:field.master_role_kind`]: `${namespace}:option.owner`,
                      },
                    },
                    namespace,
                  );
                }
                await operation(
                  operations,
                  view,
                  `${localEntity}_archive`,
                  { expectedRevision: 1, recordId: recoveryRecordId },
                  namespace,
                );
                const restored = await operation(
                  operations,
                  view,
                  `${localEntity}_restore`,
                  { expectedRevision: 2, recordId: recoveryRecordId },
                  namespace,
                );
                assert.equal(restored.readBack?.archived, false);
                return { positiveProbe: restored };
              }
              const invocation = scenario.invocation as {
                query: { targetId: string };
              };
              const result = await query(
                queries,
                view,
                invocation.query.targetId.split(':query.')[1]!,
                { recordId: scenarioRecordId },
                namespace,
              );
              assert.equal(result.outcome, 'exact');
              return { positiveProbe: result };
            }
            if (scenario.kind === 'searchableExclusion') {
              const excludedValue = new Map([
                [`${namespace}:field.master_amount`, '123.45'],
                [`${namespace}:field.master_notes`, 'NEVER-SEARCH-THIS-SECRET'],
                [
                  `${namespace}:field.master_tier`,
                  `${namespace}:option.standard`,
                ],
                [`${namespace}:field.master_local_time`, '08:15:30'],
                [
                  `${namespace}:field.master_utc_instant`,
                  '2026-07-24T12:34:56.789Z',
                ],
              ]).get(scenario.subjectId);
              assert.ok(excludedValue);
              const excluded = await query(
                queries,
                view,
                `${localEntity}_search`,
                { text: excludedValue },
                namespace,
              );
              assert.equal(excluded.records.length, 0);
              const included = await query(
                queries,
                view,
                'master_search',
                { text: 'METAMORPHIC' },
                namespace,
              );
              assert.equal(included.records.length, 1);
              return { negativeProbe: excluded, positiveProbe: included };
            }
            if (scenario.kind === 'enumReject') {
              const current = await query(
                queries,
                view,
                `${localEntity}_get`,
                { recordId: scenarioRecordId },
                namespace,
              );
              const fieldId = scenario.subjectId;
              const invalid = await rejectedModuleError(
                operation(
                  operations,
                  view,
                  `${localEntity}_update`,
                  {
                    expectedRevision: current.records[0]!.revision,
                    patch: { [fieldId]: `${namespace}:option.not-declared` },
                    recordId: scenarioRecordId,
                  },
                  namespace,
                ),
                'MODULE_ENUM_VALUE_INVALID',
                fieldId,
              );
              const validValue = parent
                ? `${namespace}:option.premium`
                : `${namespace}:option.buyer`;
              const accepted = await operation(
                operations,
                view,
                `${localEntity}_update`,
                {
                  expectedRevision: current.records[0]!.revision,
                  patch: { [fieldId]: validValue },
                  recordId: scenarioRecordId,
                },
                namespace,
              );
              return { negativeProbe: invalid, positiveProbe: accepted };
            }
            if (scenario.kind === 'resolverAuthority') {
              const current = await query(
                queries,
                view,
                `${localEntity}_get`,
                { recordId: scenarioRecordId },
                namespace,
              );
              const text = parent
                ? 'M-001'
                : String(
                    current.records[0]?.values[
                      `${namespace}:field.master_role_kind`
                    ],
                  );
              const resolved = await query(
                queries,
                view,
                `${localEntity}_resolve`,
                { text },
                namespace,
              );
              assert.equal(resolved.outcome, parent ? 'exact' : 'ambiguous');
              const missing = await query(
                queries,
                view,
                `${localEntity}_resolve`,
                { text: `missing-${randomUUID()}` },
                namespace,
              );
              assert.equal(missing.outcome, 'not-found');
              return { negativeProbe: missing, positiveProbe: resolved };
            }
            if (scenario.kind === 'typedErrorSurface') {
              const read = await query(
                queries,
                view,
                `${localEntity}_get`,
                { recordId: scenarioRecordId },
                namespace,
              );
              const rejected = parent
                ? await rejectedModuleError(
                    operation(
                      operations,
                      view,
                      'master_create',
                      {
                        recordId: randomUUID(),
                        values: {
                          [`${namespace}:field.master_name`]: 'Typed duplicate',
                          [`${namespace}:field.master_number`]: 'm-001',
                        },
                      },
                      namespace,
                    ),
                    'MODULE_UNIQUE_VIOLATION',
                    `${namespace}:field.master_number`,
                  )
                : await rejectedModuleError(
                    operation(
                      operations,
                      view,
                      'master_role_create',
                      {
                        recordId: randomUUID(),
                        relations: {
                          [`${namespace}:relation.master_role_parent`]:
                            randomUUID(),
                        },
                        values: {
                          [`${namespace}:field.master_role_kind`]: `${namespace}:option.owner`,
                        },
                      },
                      namespace,
                    ),
                    'MODULE_RELATION_TARGET_NOT_FOUND',
                    null,
                  );
              return { negativeProbe: rejected, positiveProbe: read };
            }
            if (scenario.kind === 'archiveRestrict') {
              const parentId = randomUUID();
              const dependentId = randomUUID();
              await operation(
                operations,
                view,
                'master_create',
                {
                  recordId: parentId,
                  values: {
                    [`${namespace}:field.master_name`]: 'Restrict parent',
                    [`${namespace}:field.master_number`]: `R-${parentId}`,
                  },
                },
                namespace,
              );
              await operation(
                operations,
                view,
                'master_role_create',
                {
                  recordId: dependentId,
                  relations: {
                    [`${namespace}:relation.master_role_parent`]: parentId,
                  },
                  values: {
                    [`${namespace}:field.master_role_kind`]: `${namespace}:option.owner`,
                  },
                },
                namespace,
              );
              const rejected = await rejectedModuleError(
                operation(
                  operations,
                  view,
                  'master_archive',
                  { expectedRevision: 1, recordId: parentId },
                  namespace,
                ),
                'MODULE_ARCHIVE_RESTRICTED',
                scenario.subjectId,
              );
              const accepted = await operation(
                operations,
                view,
                'master_role_archive',
                { expectedRevision: 1, recordId: dependentId },
                namespace,
              );
              return { negativeProbe: rejected, positiveProbe: accepted };
            }
            const uniqueId = randomUUID();
            const uniqueValue = `V-${uniqueId}`;
            const accepted = await operation(
              operations,
              view,
              'master_create',
              {
                recordId: uniqueId,
                values: {
                  [`${namespace}:field.master_name`]: 'Fold probe',
                  [`${namespace}:field.master_number`]: uniqueValue,
                },
              },
              namespace,
            );
            const rejected = await rejectedModuleError(
              operation(
                operations,
                view,
                'master_create',
                {
                  recordId: randomUUID(),
                  values: {
                    [`${namespace}:field.master_name`]: 'Fold duplicate',
                    [`${namespace}:field.master_number`]:
                      uniqueValue.toLowerCase(),
                  },
                },
                namespace,
              ),
              'MODULE_UNIQUE_VIOLATION',
              scenario.subjectId,
            );
            return { negativeProbe: rejected, positiveProbe: accepted };
          },
        );
        assert.deepEqual(
          validateExecutedVerificationPlan(verificationPlan, results),
          { diagnostics: [], status: 'passed' },
        );
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          modulePool.end(),
        ]);
      }
    },
  );
});

test('persisted change-document ordering is byte-identical under a non-C locale', async () => {
  const baseline = await runPersistedOrderingProbe('C');
  const nonC = await runPersistedOrderingProbe('sv_SE.UTF-8');

  assert.equal(nonC.locale, 'sv-SE');
  assert.deepEqual(nonC.bytes, baseline.bytes);
  const changes = JSON.parse(nonC.bytes.toString('utf8')) as Array<{
    fieldId?: unknown;
  }>;
  assert.deepEqual(
    changes.map((change) => change.fieldId),
    [
      'recordLifecycle',
      'northstar.modulefixture.field.a0',
      'northstar.modulefixture.field.a_a',
    ],
  );
});

class AllowPolicy implements CurrentPolicyGateway {
  readonly calls: CurrentPolicyDecisionRequest[] = [];

  async authorize(request: CurrentPolicyDecisionRequest): Promise<{
    decision: 'ALLOW';
    decisionVersion: typeof CURRENT_POLICY_DECISION_VERSION;
    policyVersion: string;
  }> {
    this.calls.push(request);
    return {
      decision: 'ALLOW',
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'module-runtime-policy/v1',
    };
  }

  async readCurrentVersion(
    _subject: CurrentPolicySubject,
  ): Promise<{ policyVersion: string }> {
    void _subject;
    return { policyVersion: 'module-runtime-policy/v1' };
  }
}

class DenyPolicy implements CurrentPolicyGateway {
  async authorize(_request: CurrentPolicyDecisionRequest) {
    void _request;
    return {
      decision: 'DENY' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'module-runtime-deny-policy/v1',
    };
  }

  async readCurrentVersion(_subject: CurrentPolicySubject) {
    void _subject;
    return { policyVersion: 'module-runtime-deny-policy/v1' };
  }
}

class SelectiveLegalEntityPolicy implements CurrentPolicyGateway {
  readonly legalEntityAuthorizationCalls: string[] = [];
  readonly #deniedLegalEntityIds = new Set<string>();
  #policyVersion = 'module-runtime-selective-policy/v1';

  deny(...legalEntityIds: readonly string[]): void {
    for (const legalEntityId of legalEntityIds) {
      this.#deniedLegalEntityIds.add(legalEntityId);
    }
  }

  resetLegalEntityAuthorizationCalls(): void {
    this.legalEntityAuthorizationCalls.length = 0;
  }

  setPolicyVersion(policyVersion: string): void {
    this.#policyVersion = policyVersion;
  }

  async authorize(request: CurrentPolicyDecisionRequest) {
    const legalEntityId = legalEntityIdFromPolicyInput(request.decisionInput);
    if (legalEntityId) {
      this.legalEntityAuthorizationCalls.push(legalEntityId);
    }
    return {
      decision:
        legalEntityId && this.#deniedLegalEntityIds.has(legalEntityId)
          ? ('DENY' as const)
          : ('ALLOW' as const),
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: this.#policyVersion,
    };
  }

  async readCurrentVersion(_subject: CurrentPolicySubject) {
    void _subject;
    return { policyVersion: this.#policyVersion };
  }
}

function legalEntityIdFromPolicyInput(
  input: ImmutableJsonValue,
): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as { readonly [key: string]: ImmutableJsonValue };
  return record.kind === 'legalEntityReadScopePolicyInput' &&
    typeof record.legalEntityId === 'string'
    ? record.legalEntityId
    : null;
}

function isImmutableJsonObject(
  value: ImmutableJsonValue | undefined,
): value is Readonly<Record<string, ImmutableJsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function operation(
  gateway: SemanticOperationGateway,
  view: RequestRuntimeView,
  localId: string,
  input: Record<string, unknown>,
  namespace: string = FIXTURE_IDS.namespace,
  idempotencyKey: string = randomUUID(),
): Promise<SemanticOperationResultEnvelope> {
  const mediation = operationMediationByGateway.get(gateway);
  assert.ok(mediation);
  const operationId = `${namespace}:operation.${localId}`;
  const confirmationRequired = (
    view.projections.operation.payload as {
      operations: Array<{ confirmation: string; operationId: string }>;
    }
  ).operations.some(
    (candidate) =>
      candidate.operationId === operationId &&
      candidate.confirmation === 'humanRequired',
  );
  return gateway.invoke(
    view,
    {
      confirmationGrant: confirmationRequired
        ? mediation.issueConfirmationGrant(
            view,
            operationId,
            input as ImmutableJsonValue,
          )
        : null,
      idempotencyKey,
      input,
      operationId,
      schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
    },
    mediation.issueInvocation(view, 'API'),
  );
}

function assertIdempotencyConflict(error: unknown): true {
  assert.ok(error instanceof TrustEvidenceError);
  assert.equal(error.code, 'SEMANTIC_OPERATION_IDEMPOTENCY_CONFLICT');
  assert.equal(Object.hasOwn(error, 'mutationResult'), false);
  return true;
}

async function executeConcurrentRetryBehindBarrier(
  pool: pg.Pool,
  gateway: SemanticOperationGateway,
  view: RequestRuntimeView,
  input: Record<string, unknown>,
  idempotencyKey: string,
): Promise<
  readonly [SemanticOperationResultEnvelope, SemanticOperationResultEnvelope]
> {
  const operationId = `${FIXTURE_IDS.namespace}:operation.master_create`;
  const lockIdentity = [
    view.tenantId.toLowerCase(),
    view.environmentId.toLowerCase(),
    operationId,
    idempotencyKey.toLowerCase(),
  ].join('\u001f');
  const blocker = await pool.connect();
  let released = false;
  let attempts:
    | readonly [
        Promise<SemanticOperationResultEnvelope>,
        Promise<SemanticOperationResultEnvelope>,
      ]
    | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [lockIdentity],
    );
    attempts = [
      operation(
        gateway,
        view,
        'master_create',
        input,
        FIXTURE_IDS.namespace,
        idempotencyKey.toUpperCase(),
      ),
      operation(
        gateway,
        view,
        'master_create',
        input,
        FIXTURE_IDS.namespace,
        idempotencyKey,
      ),
    ];
    await waitForAdvisoryWaiters(pool, 2);
    await blocker.query('COMMIT');
    released = true;
    return await Promise.all(attempts);
  } catch (error) {
    if (!released) {
      await blocker.query('ROLLBACK');
      released = true;
    }
    if (attempts) await Promise.allSettled(attempts);
    throw error;
  } finally {
    if (!released) await blocker.query('ROLLBACK');
    blocker.release();
  }
}

async function waitForAdvisoryWaiters(
  pool: pg.Pool,
  expected: number,
): Promise<void> {
  const deadline = process.hrtime.bigint() + 10_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    const waiting = await pool.query<{ count: string }>(`
      SELECT count(*) AS count
        FROM pg_catalog.pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND wait_event = 'advisory'
         AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended%'
    `);
    if (Number(waiting.rows[0]?.count ?? 0) >= expected) return;
    await new Promise<void>((resolveImmediate) =>
      setImmediate(resolveImmediate),
    );
  }
  throw new Error(
    `expected ${expected} provider transactions to wait on one advisory lock`,
  );
}

async function assertReceiptTenantIsolation(
  runtimePool: pg.Pool,
  contextA: TrustedRequestContext,
  contextB: TrustedRequestContext,
  idempotencyKey: string,
): Promise<void> {
  const visibleTo = async (context: TrustedRequestContext): Promise<string[]> =>
    withTrustedRequestTransaction(runtimePool, context, async (client) => {
      const result = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id
           FROM platform.semantic_operation_receipts
          WHERE action_id = $1
            AND idempotency_key = $2
          ORDER BY tenant_id`,
        [`${FIXTURE_IDS.namespace}:operation.master_create`, idempotencyKey],
      );
      return result.rows.map(({ tenant_id }) => tenant_id);
    });

  assert.deepEqual(await visibleTo(contextA), [tenantA]);
  assert.deepEqual(await visibleTo(contextB), [tenantB]);
}

async function moduleRecordCount(
  pool: pg.Pool,
  storage: StorageTargetPayloadV1,
  recordId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM north_star_module.${storage.entities[0]!.physicalTableName}
      WHERE record_id = $1`,
    [recordId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

const operationMediationByGateway = new WeakMap<
  SemanticOperationGateway,
  SemanticOperationMediationAuthority
>();

function operationGatewayFor(
  policy: CurrentPolicyGateway,
  interpreter: SemanticOperationExecutor,
): SemanticOperationGateway {
  const mediation = new SemanticOperationMediationAuthority();
  const gateway = new SemanticOperationGateway(policy, interpreter, mediation);
  operationMediationByGateway.set(gateway, mediation);
  return gateway;
}

class RecordingForwardingOperationExecutor implements SemanticOperationExecutor {
  readonly calls: SemanticOperationExecutionRequest[] = [];

  constructor(private readonly delegate: SemanticOperationExecutor) {}

  execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    this.calls.push(request);
    return this.delegate.execute(request);
  }

  recordNonAccepted(
    request: SemanticOperationNonAcceptedRequest,
  ): Promise<void> {
    return this.delegate.recordNonAccepted(request);
  }
}

function inventoryTransactionCreateInput(
  legalEntityId: string,
  recordId: string,
  number: string,
): Readonly<Record<string, ImmutableJsonValue>> {
  return Object.freeze({
    legalEntityId,
    recordId,
    relations: Object.freeze({}),
    values: Object.freeze({
      [applicationInventoryId(INVENTORY_IDS.fieldIds.transaction.actorId)]:
        'direct-operand-control',
      [applicationInventoryId(INVENTORY_IDS.fieldIds.transaction.effectiveAt)]:
        '2026-08-18T12:00:00.000Z',
      [applicationInventoryId(INVENTORY_IDS.fieldIds.transaction.number)]:
        number,
      [applicationInventoryId(INVENTORY_IDS.fieldIds.transaction.recordedAt)]:
        '2026-08-18T12:00:00.000Z',
      [applicationInventoryId(INVENTORY_IDS.fieldIds.transaction.sourceId)]:
        number.toLowerCase(),
      [applicationInventoryId(INVENTORY_IDS.fieldIds.transaction.sourceType)]:
        'test',
      [applicationInventoryId(INVENTORY_IDS.fieldIds.transaction.state)]:
        `${APPLICATION_NAMESPACE}:option.inventory_transaction_state_draft`,
      [applicationInventoryId(INVENTORY_IDS.fieldIds.transaction.type)]:
        `${APPLICATION_NAMESPACE}:option.inventory_transaction_type_adjustment`,
    }),
  });
}

function digestTestOperationInput(input: ImmutableJsonValue): string {
  return createHash('sha256').update(canonicalize(input)).digest('hex');
}

function instrumentPinnedArtifactReads(
  pool: pg.Pool,
  transform: (
    result: pg.QueryResult<pg.QueryResultRow>,
    readCount: number,
  ) =>
    | pg.QueryResult<pg.QueryResultRow>
    | Promise<pg.QueryResult<pg.QueryResultRow>>,
): Readonly<{ pool: pg.Pool; readCount: () => number }> {
  let reads = 0;
  const instrumented = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'connect') {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === 'query') {
                return async (...arguments_: unknown[]) => {
                  const result = (await Reflect.apply(
                    clientTarget.query,
                    clientTarget,
                    arguments_,
                  )) as pg.QueryResult<pg.QueryResultRow>;
                  const statement = queryStatement(arguments_[0]);
                  if (
                    !statement.includes(
                      'platform.read_tenant_release_artifacts',
                    )
                  ) {
                    return result;
                  }
                  reads += 1;
                  return transform(result, reads);
                };
              }
              const value = Reflect.get(
                clientTarget,
                clientProperty,
                clientReceiver,
              );
              return typeof value === 'function'
                ? value.bind(clientTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return Object.freeze({ pool: instrumented, readCount: () => reads });
}

function queryStatement(argument: unknown): string {
  if (typeof argument === 'string') return argument;
  if (
    typeof argument === 'object' &&
    argument !== null &&
    'text' in argument &&
    typeof argument.text === 'string'
  ) {
    return argument.text;
  }
  return '';
}

async function query(
  gateway: SemanticQueryGateway,
  view: RequestRuntimeView,
  localId: string,
  args: Record<string, unknown>,
  namespace: string = FIXTURE_IDS.namespace,
  executionContext: SemanticQueryExecutionContext = Object.freeze({}),
): Promise<SemanticQueryResultEnvelope> {
  return gateway.invoke(
    view,
    {
      arguments: args,
      queryId: `${namespace}:query.${localId}`,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    },
    executionContext,
  );
}

async function aggregateQuery(
  gateway: SemanticQueryGateway,
  view: RequestRuntimeView,
  args: Record<string, unknown>,
  executionContext: SemanticQueryExecutionContext = Object.freeze({}),
): Promise<SemanticAggregateResultEnvelope> {
  return gateway.invokeAggregate(
    view,
    {
      arguments: args,
      queryId: inventoryScopeProbeIds.query,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    },
    executionContext,
  );
}

function runtimeEntry(
  pool: pg.Pool,
  identities: Readonly<Record<string, AuthenticatedIdentity>>,
): AuthenticatedRequestRuntimeEntryAdapter {
  return new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async (request) => {
      const token = request.headers?.authorization;
      return typeof token === 'string' ? (identities[token] ?? null) : null;
    }),
    new PostgresRequestRuntimeViewService(pool),
    new AllowPolicy(),
  );
}

async function issuedView(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
  token: string,
): Promise<RequestRuntimeView> {
  return entry.run({ headers: { authorization: token } }, async (view) => view);
}

async function issuedCandidateView(
  compiled: CompileSuccess,
  releaseId: string,
  candidateIdentity: AuthenticatedIdentity,
  pointer: LoadedRequestRuntimeDefinition['pointer'],
  policy: CurrentPolicyGateway,
  queryProjection = runtimeProjection(
    compiled,
    REQUEST_RUNTIME_PROJECTION_FAMILIES.query,
  ),
): Promise<RequestRuntimeView> {
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => candidateIdentity),
    {
      async load(): Promise<LoadedRequestRuntimeDefinition> {
        return {
          environmentId: candidateIdentity.environmentId,
          pointer,
          projections: {
            agent: runtimeProjection(
              compiled,
              REQUEST_RUNTIME_PROJECTION_FAMILIES.agent,
            ),
            catalog: runtimeProjection(
              compiled,
              REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog,
            ),
            operation: runtimeProjection(
              compiled,
              REQUEST_RUNTIME_PROJECTION_FAMILIES.operation,
            ),
            query: queryProjection,
            surface: runtimeProjection(
              compiled,
              REQUEST_RUNTIME_PROJECTION_FAMILIES.surface,
            ),
          },
          release: { contentHash: compiled.releaseRoot, releaseId },
          tenantId: candidateIdentity.tenantId,
        };
      },
    },
    policy,
  );
  return entry.run({}, async (view) => view);
}

function humanActorIssuer(): TrustedActorEnvelopeIssuer {
  return new TrustedActorEnvelopeIssuer({
    async resolve(context) {
      return {
        approvingHumanId: null,
        delegation: null,
        executionPrincipal: {
          kind: 'HUMAN',
          principalId: context.principalId,
        },
        initiatingHumanId: context.principalId,
        subject: null,
      };
    },
  });
}

async function contextsFor(
  facts: ReadonlyArray<readonly [string, string, string, string]>,
): Promise<Record<string, TrustedRequestContext>> {
  const identities = Object.fromEntries(
    facts.map(([token, tenantId, environmentId, principalId]) => [
      token,
      identity(tenantId, environmentId, principalId),
    ]),
  );
  const entry = new AuthenticatedRequestEntryAdapter(async (request) => {
    const token = request.headers?.authorization;
    return typeof token === 'string' ? (identities[token] ?? null) : null;
  });
  return Object.fromEntries(
    await Promise.all(
      facts.map(async ([token]) => [
        token,
        await entry.enter({ headers: { authorization: token } }),
      ]),
    ),
  );
}

function identity(
  tenantId: string,
  environmentId: string,
  principalId: string,
): AuthenticatedIdentity {
  return { environmentId, principalId, tenantId };
}

async function migrateAndSeed(
  pool: pg.Pool,
  scopes: ReadonlyArray<readonly [string, string, string]>,
): Promise<void> {
  const client = await pool.connect();
  try {
    const loaded = await loadMigrations(migrations);
    const result = await runMigrations(client, loaded);
    assert.equal(result.applied.length, loaded.length);
    assert.equal(result.verified.length, loaded.length);
    for (const [tenantId, environmentId, slug] of scopes) {
      await client.query(
        'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
        [tenantId, slug],
      );
      await client.query(
        `INSERT INTO platform.environments (tenant_id, id, slug)
         VALUES ($1,$2,'production')`,
        [tenantId, environmentId],
      );
    }
  } finally {
    client.release();
  }
}

async function persistSequence(
  runtimePool: pg.Pool,
  context: TrustedRequestContext,
  entries: ReadonlyArray<readonly [CompileSuccess, Record<string, unknown>]>,
): Promise<MintedUuid[]> {
  const repository = new PostgresImmutableReleaseRepository(runtimePool);
  const releases: MintedUuid[] = [];
  for (const [compiled, definition] of entries) {
    const revisionId = minted(randomUUID());
    const releaseId = minted(randomUUID());
    const bytes = definitionBytes(definition);
    await repository.storeAppPackageRevision(
      context,
      revisionCommand(context, revisionId, bytes),
    );
    const staged = await repository.stageTenantReleaseCandidate(context, {
      appPackageRevisionId: revisionId,
      compiledRelease: compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId,
      tenantId: context.tenantId,
    });
    if (releaseVerificationBinding(compiled).plan.scenarios.length === 0) {
      await new PostgresReleaseVerificationService(
        runtimePool,
      ).executeSemanticCandidateAndPersist(context, {
        compiledRelease: compiled,
        evidenceId: staged.verificationEvidenceId,
        releaseId,
      });
      await repository.registerTenantRelease(
        context,
        releaseCommand(
          context,
          releaseId,
          revisionId,
          staged.verificationEvidenceId,
          compiled,
        ),
      );
    }
    releases.push(releaseId);
  }
  return releases;
}

async function admitCandidate(
  runtimePool: pg.Pool,
  context: TrustedRequestContext,
  releaseId: MintedUuid,
  compiled: CompileSuccess,
): Promise<void> {
  const repository = new PostgresImmutableReleaseRepository(runtimePool);
  if (await repository.getTenantRelease(context, releaseId)) return;
  const staged = await withTrustedRequestTransaction(
    runtimePool,
    context,
    async (client) => {
      const result = await client.query<{
        app_package_revision_id: MintedUuid;
        verification_evidence_id: MintedUuid;
      }>(
        `SELECT app_package_revision_id, verification_evidence_id
           FROM platform.tenant_releases
          WHERE tenant_id = $1 AND environment_id = $2 AND release_id = $3`,
        [context.tenantId, context.environmentId, releaseId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('staged module candidate is missing');
      return row;
    },
  );
  await new PostgresReleaseVerificationService(
    runtimePool,
  ).executeSemanticCandidateAndPersist(context, {
    compiledRelease: compiled,
    evidenceId: staged.verification_evidence_id,
    releaseId,
  });
  await repository.registerTenantRelease(
    context,
    releaseCommand(
      context,
      releaseId,
      staged.app_package_revision_id,
      staged.verification_evidence_id,
      compiled,
    ),
  );
}

function revisionCommand(
  context: TrustedRequestContext,
  revisionId: MintedUuid,
  desiredState: Uint8Array,
): StoreAppPackageRevisionCommand {
  const normalizedDefinition =
    parseNormalizedApplicationPackageJson(desiredState);
  const digest = canonicalizeAndHash(normalizedDefinition);
  return {
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    contentHash: digest.contentHash,
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
  revisionId: MintedUuid,
  verificationEvidenceId: MintedUuid,
  compiledRelease: CompileSuccess,
): RegisterTenantReleaseCommand<CompileSuccess> {
  return {
    appPackageRevisionId: revisionId,
    compiledRelease,
    createdBy: context.principalId,
    environmentId: context.environmentId,
    releaseId,
    tenantId: context.tenantId,
    verificationEvidenceId,
  };
}

async function setPointer(
  pool: pg.Pool,
  tenantId: string,
  environmentId: string,
  releaseId: string,
): Promise<void> {
  await pool.query(
    'ALTER TABLE platform.active_release_pointers DISABLE TRIGGER active_release_pointer_exact_swap',
  );
  try {
    const result = await pool.query(
      `UPDATE platform.active_release_pointers
          SET release_id = $3, fence = fence + 1
        WHERE tenant_id = $1 AND environment_id = $2`,
      [tenantId, environmentId, releaseId],
    );
    assert.equal(result.rowCount, 1);
  } finally {
    await pool.query(
      'ALTER TABLE platform.active_release_pointers ENABLE TRIGGER active_release_pointer_exact_swap',
    );
  }
}

async function grantExecutorAuthority(
  pool: pg.Pool,
  subjects: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  for (const [tenantId, principalId] of subjects) {
    await pool.query(
      'SELECT platform.set_release_executor_authority($1,$2,true,$2,$3)',
      [tenantId, principalId, randomUUID()],
    );
  }
}

async function prepare(
  materializer: PostgresModuleStorageMaterializer,
  context: TrustedRequestContext,
  principalId: string,
  releaseId: MintedUuid,
): Promise<void> {
  const result = await materializer.prepare({
    context,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    generationId: randomUUID(),
    initiatedBy: principalId,
    preparationId: randomUUID(),
    targetReleaseId: releaseId,
  });
  assert.equal(result.schemaState, 'APPLIED');
}

async function assertRoleBridge(pool: pg.Pool): Promise<void> {
  const membership = await pool.query<{
    admin_option: boolean;
    inherit_option: boolean;
    set_option: boolean;
  }>(
    `SELECT membership.admin_option,
            membership.inherit_option,
            membership.set_option
       FROM pg_auth_members AS membership
       JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
       JOIN pg_roles AS member_role ON member_role.oid = membership.member
      WHERE granted_role.rolname = 'north_star_module_runtime'
        AND member_role.rolname = 'north_star_runtime'`,
  );
  assert.deepEqual(membership.rows, [
    { admin_option: false, inherit_option: false, set_option: true },
  ]);
  const forbidden = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM pg_auth_members AS membership
       JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
       JOIN pg_roles AS member_role ON member_role.oid = membership.member
      WHERE (granted_role.rolname = 'north_star_runtime'
             AND member_role.rolname = 'north_star_module_runtime')
         OR (granted_role.rolname = 'north_star_module_materializer'
             AND member_role.rolname IN (
               'north_star_runtime', 'north_star_module_runtime'
             ))`,
  );
  assert.equal(forbidden.rows[0]?.count, '0');
  const trustPrivilege = await pool.query<{ can_insert_trust: boolean }>(
    `SELECT has_table_privilege(
       'north_star_module_runtime',
       'platform.trust_action_invocations',
       'INSERT'
     ) AS can_insert_trust`,
  );
  assert.equal(trustPrivilege.rows[0]?.can_insert_trust, false);
  const roles = await pool.query<{
    rolbypassrls: boolean;
    rolinherit: boolean;
    rolname: string;
    rolsuper: boolean;
  }>(
    `SELECT rolname, rolsuper, rolbypassrls, rolinherit
       FROM pg_roles
      WHERE rolname IN (
        'north_star_runtime',
        'north_star_module_runtime',
        'north_star_module_materializer'
      )
      ORDER BY rolname`,
  );
  assert.equal(
    roles.rows.every((role) => !role.rolsuper && !role.rolbypassrls),
    true,
  );
  assert.equal(
    roles.rows.find((role) => role.rolname === 'north_star_runtime')
      ?.rolinherit,
    false,
  );
  const ambient = new pg.Pool({
    ...(pool.options as pg.PoolConfig),
    max: 1,
    user: 'north_star_runtime',
  });
  try {
    const privilege = await ambient.query<{ module_usage: boolean }>(
      `SELECT has_schema_privilege(
        current_user, 'north_star_module', 'USAGE'
      ) AS module_usage`,
    );
    assert.equal(privilege.rows[0]?.module_usage, false);
  } finally {
    await ambient.end();
  }
}

async function assertLinkedTrustFacts(
  pool: pg.Pool,
  result: SemanticOperationResultEnvelope,
  tenantId: string,
  environmentId: string,
): Promise<void> {
  assert.ok(result.trust);
  const linked = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM platform.trust_action_invocations AS invocation
       JOIN platform.trust_business_change_documents AS change
         ON change.tenant_id = invocation.tenant_id
        AND change.environment_id = invocation.environment_id
        AND change.invocation_id = invocation.invocation_id
       JOIN platform.trust_domain_events AS event
         ON event.tenant_id = invocation.tenant_id
        AND event.environment_id = invocation.environment_id
        AND event.invocation_id = invocation.invocation_id
       JOIN platform.trust_outbox AS outbox
         ON outbox.tenant_id = invocation.tenant_id
        AND outbox.environment_id = invocation.environment_id
        AND outbox.invocation_id = invocation.invocation_id
      WHERE invocation.tenant_id = $1
        AND invocation.environment_id = $2
        AND invocation.invocation_id = $3
        AND invocation.change_document_id = $4
        AND invocation.domain_event_id = $5
        AND invocation.outbox_id = $6`,
    [
      tenantId,
      environmentId,
      result.trust.invocationId,
      result.trust.changeDocumentId,
      result.trust.domainEventId,
      result.trust.outboxId,
    ],
  );
  assert.equal(linked.rows[0]?.count, '1');
  const redacted = await pool.query<{ changes: unknown }>(
    `SELECT changes
       FROM platform.trust_business_change_documents
      WHERE tenant_id = $1
        AND environment_id = $2
        AND change_document_id = $3`,
    [tenantId, environmentId, result.trust.changeDocumentId],
  );
  const serializedChanges = JSON.stringify(redacted.rows[0]?.changes);
  assert.match(serializedChanges, /INTERNAL/);
  assert.match(serializedChanges, /"representation":"VALUE"/);
  assert.doesNotMatch(serializedChanges, /SENSITIVE|REDACTED/);
}

async function trustFactCount(
  pool: pg.Pool,
  tenantId: string,
  environmentId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM platform.trust_action_invocations
      WHERE tenant_id = $1 AND environment_id = $2`,
    [tenantId, environmentId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function assertNoPhysicalDetails(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /north_star_module|nsm_[ctik]_|storageClass/);
}

type OptionalRestrictRuntime = Readonly<{
  compiled: CompileSuccess;
  context: TrustedRequestContext;
  evidenceId: MintedUuid;
  foreignKey: Readonly<{
    deleteAction: string;
    deferrable: boolean;
    updateAction: string;
    validated: boolean;
  }>;
  interpreter: PostgresModuleRuntimeInterpreter;
  namespace: string;
  operations: SemanticOperationGateway;
  plan: VerificationPlanPayloadV1;
  readRelation: (recordId: string) => Promise<string | null>;
  relationId: string;
  releaseId: MintedUuid;
  runtimePool: pg.Pool;
  view: RequestRuntimeView;
}>;

async function withOptionalRestrictRuntime(
  probe: 'archived-target' | 'unset',
  run: (runtime: OptionalRestrictRuntime) => Promise<void>,
): Promise<void> {
  const namespace =
    probe === 'unset' ? 'northstar.restorenull' : 'northstar.restorearchived';
  const definition = selfRelationDefinition(namespace, false, 'restrict');
  const emptyDefinition_ = emptyDefinition(definition);
  const empty = mustCompile(moduleInput(emptyDefinition_));
  const compiled = mustCompile(
    moduleInput(definition, expectedActiveReleaseFrom(empty)),
  );
  const plan = releaseVerificationBinding(compiled).plan;
  const relationId = `${namespace}:relation.master_supersedes`;
  const storage = compiledProjectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const relation = storage.relations.find(
    (candidate) => candidate.relationId === relationId,
  );
  assert.ok(relation);
  const entity = storage.entities.find(
    (candidate) => candidate.entityId === `${namespace}:entity.master`,
  );
  assert.ok(entity);

  const tenant =
    probe === 'unset'
      ? 'e4000000-0000-4000-8000-000000000001'
      : 'f1000000-0000-4000-8000-000000000001';
  const environment =
    probe === 'unset'
      ? 'e5000000-0000-4000-8000-000000000002'
      : 'f2000000-0000-4000-8000-000000000002';
  const principal =
    probe === 'unset'
      ? 'e6000000-0000-4000-8000-000000000003'
      : 'f3000000-0000-4000-8000-000000000003';
  await withEphemeralPostgres(
    probe === 'unset'
      ? 'optional-restrict-null-restore'
      : 'optional-restrict-archived-target',
    async ({ connection, pool }) => {
      await migrateAndSeed(pool, [[tenant, environment, probe]]);
      const runtimePool = new pg.Pool({
        ...connection,
        max: 3,
        user: 'north_star_runtime',
      });
      const materializerPool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_module_materializer',
      });
      const modulePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_module_runtime',
      });
      try {
        const context = (
          await contextsFor([['restore', tenant, environment, principal]])
        ).restore!;
        const releases = await persistSequence(runtimePool, context, [
          [empty, emptyDefinition_],
          [compiled, definition],
        ]);
        await setPointer(pool, tenant, environment, releases[0]!);
        await grantExecutorAuthority(pool, [[tenant, principal]]);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        );
        await prepare(materializer, context, principal, releases[1]!);
        const staged = await pool.query<{
          verification_evidence_id: MintedUuid;
        }>(
          `SELECT verification_evidence_id
             FROM platform.tenant_releases
            WHERE tenant_id = $1
              AND environment_id = $2
              AND release_id = $3`,
          [tenant, environment, releases[1]],
        );
        const evidenceId = staged.rows[0]?.verification_evidence_id;
        assert.ok(evidenceId);
        const foreignKeys = await pool.query<{
          confdeltype: string;
          condeferrable: boolean;
          confupdtype: string;
          convalidated: boolean;
        }>(
          `SELECT constraint_record.confdeltype,
                  constraint_record.condeferrable,
                  constraint_record.confupdtype,
                  constraint_record.convalidated
             FROM pg_constraint AS constraint_record
             JOIN pg_class AS relation_record
               ON relation_record.oid = constraint_record.conrelid
             JOIN pg_namespace AS namespace_record
               ON namespace_record.oid = relation_record.relnamespace
            WHERE namespace_record.nspname = 'north_star_module'
              AND relation_record.relname = $1
              AND constraint_record.conname = $2
              AND constraint_record.contype = 'f'`,
          [entity.physicalTableName, relation.foreignKey.physicalName],
        );
        assert.equal(foreignKeys.rowCount, 1);
        const foreignKey = foreignKeys.rows[0]!;
        const candidateIdentity = identity(tenant, environment, principal);
        const sourceView = await issuedView(
          runtimeEntry(runtimePool, { restore: candidateIdentity }),
          'restore',
        );
        const policy = new AllowPolicy();
        const view = await issuedCandidateView(
          compiled,
          releases[1]!,
          candidateIdentity,
          sourceView.pointer,
          policy,
        );
        const interpreter = new PostgresModuleRuntimeInterpreter(
          runtimePool,
          humanActorIssuer(),
        );
        await run(
          Object.freeze({
            compiled,
            context,
            evidenceId,
            foreignKey: Object.freeze({
              deleteAction: foreignKey.confdeltype,
              deferrable: foreignKey.condeferrable,
              updateAction: foreignKey.confupdtype,
              validated: foreignKey.convalidated,
            }),
            interpreter,
            namespace,
            operations: operationGatewayFor(policy, interpreter),
            plan,
            readRelation: async (recordId) => {
              const result = await pool.query<{ target_id: string | null }>(
                `SELECT ${quoteTestIdentifier(relation.relationColumn.physicalName)} AS target_id
                   FROM north_star_module.${quoteTestIdentifier(entity.physicalTableName)}
                  WHERE ${quoteTestIdentifier(entity.recordIdentity.column)} = $1`,
                [recordId],
              );
              assert.equal(result.rowCount, 1);
              return result.rows[0]!.target_id;
            },
            relationId,
            releaseId: releases[1]!,
            runtimePool,
            view,
          }),
        );
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          modulePool.end(),
        ]);
      }
    },
  );
}

function masterValues(
  namespace: string,
  name: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [`${namespace}:field.master_name`]: name,
    [`${namespace}:field.master_number`]: `R-${randomUUID()}`,
  });
}

async function executeSelfRelationVerification(required: boolean) {
  const namespace = required
    ? 'northstar.requiredcycle'
    : 'northstar.optionalcycle';
  const definition = selfRelationDefinition(namespace, required);
  const emptyDefinition_ = emptyDefinition(definition);
  const empty = mustCompile(moduleInput(emptyDefinition_));
  const compiled = mustCompile(
    moduleInput(definition, expectedActiveReleaseFrom(empty)),
  );
  const plan = releaseVerificationBinding(compiled).plan;
  const relationId = `${namespace}:relation.master_supersedes`;
  const storage = compiledProjectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const relation = storage.relations.find(
    (candidate) => candidate.relationId === relationId,
  );
  assert.ok(relation);
  const entity = storage.entities.find(
    (candidate) => candidate.entityId === `${namespace}:entity.master`,
  );
  assert.ok(entity);

  const tenant = required
    ? 'd1000000-0000-4000-8000-000000000001'
    : 'c1000000-0000-4000-8000-000000000001';
  const environment = required
    ? 'd2000000-0000-4000-8000-000000000002'
    : 'c2000000-0000-4000-8000-000000000002';
  const principal = required
    ? 'd3000000-0000-4000-8000-000000000003'
    : 'c3000000-0000-4000-8000-000000000003';
  return withEphemeralPostgres(
    required ? 'verification-required-cycle' : 'verification-optional-cycle',
    async ({ connection, pool }) => {
      await migrateAndSeed(pool, [
        [tenant, environment, required ? 'required-cycle' : 'optional-cycle'],
      ]);
      const runtimePool = new pg.Pool({
        ...connection,
        max: 3,
        user: 'north_star_runtime',
      });
      const materializerPool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_module_materializer',
      });
      const modulePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_module_runtime',
      });
      try {
        const context = (
          await contextsFor([['cycle', tenant, environment, principal]])
        ).cycle!;
        const releases = await persistSequence(runtimePool, context, [
          [empty, emptyDefinition_],
          [compiled, definition],
        ]);
        await setPointer(pool, tenant, environment, releases[0]!);
        await grantExecutorAuthority(pool, [[tenant, principal]]);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        );
        await prepare(materializer, context, principal, releases[1]!);
        const staged = await pool.query<{
          verification_evidence_id: MintedUuid;
        }>(
          `SELECT verification_evidence_id
             FROM platform.tenant_releases
            WHERE tenant_id = $1
              AND environment_id = $2
              AND release_id = $3`,
          [tenant, environment, releases[1]],
        );
        const evidenceId = staged.rows[0]?.verification_evidence_id;
        assert.ok(evidenceId);
        const interpreter = new PostgresModuleRuntimeInterpreter(
          runtimePool,
          humanActorIssuer(),
        );
        const resultSet = await new PostgresReleaseVerificationService(
          runtimePool,
        ).executeSemanticCandidateWithExecutor(
          context,
          {
            compiledRelease: compiled,
            evidenceId,
            releaseId: releases[1]!,
          },
          interpreter,
        );
        const population = await pool.query<{
          explicit: string;
          unset: string;
        }>(
          `SELECT count(*) FILTER (
                    WHERE ${quoteTestIdentifier(relation.relationColumn.physicalName)} IS NOT NULL
                  )::text AS explicit,
                  count(*) FILTER (
                    WHERE ${quoteTestIdentifier(relation.relationColumn.physicalName)} IS NULL
                  )::text AS unset
             FROM north_star_module.${quoteTestIdentifier(entity.physicalTableName)}`,
        );
        const row = population.rows[0];
        assert.ok(row);
        return Object.freeze({
          plan,
          relationPopulation: Object.freeze({
            explicit: Number(row.explicit),
            unset: Number(row.unset),
          }),
          resultSet,
        });
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          modulePool.end(),
        ]);
      }
    },
  );
}

async function executeRequiredDiamondVerification() {
  const namespace = 'northstar.requireddiamond';
  const definition = requiredDiamondDefinition(namespace);
  const emptyDefinition_ = emptyDefinition(definition);
  const empty = mustCompile(moduleInput(emptyDefinition_));
  const compiled = mustCompile(
    moduleInput(definition, expectedActiveReleaseFrom(empty)),
  );
  const plan = releaseVerificationBinding(compiled).plan;
  const storage = compiledProjectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const entity = (local: string) => {
    const candidate = storage.entities.find(
      (entry) => entry.entityId === `${namespace}:entity.${local}`,
    );
    assert.ok(candidate);
    return candidate;
  };
  const relation = (local: string) => {
    const candidate = storage.relations.find(
      (entry) => entry.relationId === `${namespace}:relation.${local}`,
    );
    assert.ok(candidate);
    return candidate;
  };
  const shared = entity('master');
  const left = entity('master_role');
  const right = entity('diamond_right');
  const root = entity('diamond_root');
  const leftShared = relation('master_role_parent');
  const rightShared = relation('diamond_right_shared');
  const rootLeft = relation('diamond_root_left');
  const rootRight = relation('diamond_root_right');
  const tenant = 'b1000000-0000-4000-8000-000000000001';
  const environment = 'b2000000-0000-4000-8000-000000000002';
  const principal = 'b3000000-0000-4000-8000-000000000003';

  return withEphemeralPostgres(
    'verification-required-diamond',
    async ({ connection, pool }) => {
      await migrateAndSeed(pool, [[tenant, environment, 'required-diamond']]);
      const runtimePool = new pg.Pool({
        ...connection,
        max: 3,
        user: 'north_star_runtime',
      });
      const materializerPool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_module_materializer',
      });
      const modulePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_module_runtime',
      });
      try {
        const context = (
          await contextsFor([['diamond', tenant, environment, principal]])
        ).diamond!;
        const releases = await persistSequence(runtimePool, context, [
          [empty, emptyDefinition_],
          [compiled, definition],
        ]);
        await setPointer(pool, tenant, environment, releases[0]!);
        await grantExecutorAuthority(pool, [[tenant, principal]]);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        );
        await prepare(materializer, context, principal, releases[1]!);
        const staged = await pool.query<{
          verification_evidence_id: MintedUuid;
        }>(
          `SELECT verification_evidence_id
             FROM platform.tenant_releases
            WHERE tenant_id = $1
              AND environment_id = $2
              AND release_id = $3`,
          [tenant, environment, releases[1]],
        );
        const evidenceId = staged.rows[0]?.verification_evidence_id;
        assert.ok(evidenceId);
        const resultSet = await new PostgresReleaseVerificationService(
          runtimePool,
        ).executeSemanticCandidateWithExecutor(
          context,
          {
            compiledRelease: compiled,
            evidenceId,
            releaseId: releases[1]!,
          },
          new PostgresModuleRuntimeInterpreter(runtimePool, humanActorIssuer()),
        );
        const pairs = await pool.query<{
          left_shared_record_id: string;
          right_shared_record_id: string;
          root_record_id: string;
        }>(
          `SELECT root.${quoteTestIdentifier(root.recordIdentity.column)} AS root_record_id,
                  left_parent.${quoteTestIdentifier(leftShared.relationColumn.physicalName)} AS left_shared_record_id,
                  right_parent.${quoteTestIdentifier(rightShared.relationColumn.physicalName)} AS right_shared_record_id
             FROM north_star_module.${quoteTestIdentifier(root.physicalTableName)} AS root
             JOIN north_star_module.${quoteTestIdentifier(left.physicalTableName)} AS left_parent
               ON left_parent.tenant_id = root.tenant_id
              AND left_parent.environment_id = root.environment_id
              AND left_parent.${quoteTestIdentifier(left.recordIdentity.column)} =
                  root.${quoteTestIdentifier(rootLeft.relationColumn.physicalName)}
             JOIN north_star_module.${quoteTestIdentifier(right.physicalTableName)} AS right_parent
               ON right_parent.tenant_id = root.tenant_id
              AND right_parent.environment_id = root.environment_id
              AND right_parent.${quoteTestIdentifier(right.recordIdentity.column)} =
                  root.${quoteTestIdentifier(rootRight.relationColumn.physicalName)}
             JOIN north_star_module.${quoteTestIdentifier(shared.physicalTableName)} AS left_shared
               ON left_shared.tenant_id = left_parent.tenant_id
              AND left_shared.environment_id = left_parent.environment_id
              AND left_shared.${quoteTestIdentifier(shared.recordIdentity.column)} =
                  left_parent.${quoteTestIdentifier(leftShared.relationColumn.physicalName)}
             JOIN north_star_module.${quoteTestIdentifier(shared.physicalTableName)} AS right_shared
               ON right_shared.tenant_id = right_parent.tenant_id
              AND right_shared.environment_id = right_parent.environment_id
              AND right_shared.${quoteTestIdentifier(shared.recordIdentity.column)} =
                  right_parent.${quoteTestIdentifier(rightShared.relationColumn.physicalName)}
            ORDER BY root_record_id`,
        );
        return Object.freeze({
          parentPairs: Object.freeze(
            pairs.rows.map((row) =>
              Object.freeze({
                leftSharedRecordId: row.left_shared_record_id,
                rightSharedRecordId: row.right_shared_record_id,
                rootRecordId: row.root_record_id,
              }),
            ),
          ),
          plan,
          resultSet,
        });
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          modulePool.end(),
        ]);
      }
    },
  );
}

function selfRelationDefinition(
  namespace: string,
  required: boolean,
  archiveBehavior: 'restrict' | 'retainReference' = 'retainReference',
): Record<string, unknown> {
  const definition = ordinaryModuleV1ForNamespace(namespace) as {
    languageVersion: string;
    relations: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  const version = definition.languageVersion;
  const entityId = `${namespace}:entity.master`;
  definition.relations.push({
    archiveBehavior,
    cardinality: 'manyToOne',
    foreignKeyActions: {
      onDelete: 'restrict',
      onUpdate: 'restrict',
      schemaVersion: version,
    },
    joinEligibility: 'query',
    kind: 'relationDefinition',
    orderKey: 20,
    ownership: 'reference',
    relationId: `${namespace}:relation.master_supersedes`,
    required,
    schemaVersion: version,
    sourceEntity: {
      kind: 'entityReference',
      schemaVersion: version,
      targetId: entityId,
    },
    targetEntity: {
      kind: 'entityReference',
      schemaVersion: version,
      targetId: entityId,
    },
  });
  return definition;
}

function requiredDiamondDefinition(namespace: string): Record<string, unknown> {
  const definition = ordinaryModuleV1ForNamespace(namespace) as {
    assertions: Array<Record<string, unknown>>;
    entities: Array<Record<string, unknown>>;
    fields: Array<Record<string, unknown>>;
    languageVersion: string;
    operations: Array<Record<string, unknown>>;
    permissions: Array<Record<string, unknown>>;
    queries: Array<Record<string, unknown>>;
    relations: Array<Record<string, unknown>>;
    storageMappings: Array<Record<string, unknown>>;
    surfaces: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  cloneFixtureEntityFamily(
    definition,
    namespace,
    'master_role',
    'diamond_right',
    30,
  );
  cloneFixtureEntityFamily(
    definition,
    namespace,
    'master_role',
    'diamond_root',
    40,
  );
  const version = definition.languageVersion;
  const relation = (
    local: string,
    sourceLocal: string,
    targetLocal: string,
    orderKey: number,
  ) => ({
    archiveBehavior: 'retainReference',
    cardinality: 'manyToOne',
    foreignKeyActions: {
      onDelete: 'restrict',
      onUpdate: 'restrict',
      schemaVersion: version,
    },
    joinEligibility: 'query',
    kind: 'relationDefinition',
    orderKey,
    ownership: 'reference',
    relationId: `${namespace}:relation.${local}`,
    required: true,
    schemaVersion: version,
    sourceEntity: {
      kind: 'entityReference',
      schemaVersion: version,
      targetId: `${namespace}:entity.${sourceLocal}`,
    },
    targetEntity: {
      kind: 'entityReference',
      schemaVersion: version,
      targetId: `${namespace}:entity.${targetLocal}`,
    },
  });
  definition.relations.push(
    relation('diamond_right_shared', 'diamond_right', 'master', 20),
    relation('diamond_root_left', 'diamond_root', 'master_role', 30),
    relation('diamond_root_right', 'diamond_root', 'diamond_right', 40),
  );
  return definition;
}

function cloneFixtureEntityFamily(
  definition: {
    assertions: Array<Record<string, unknown>>;
    entities: Array<Record<string, unknown>>;
    fields: Array<Record<string, unknown>>;
    operations: Array<Record<string, unknown>>;
    permissions: Array<Record<string, unknown>>;
    queries: Array<Record<string, unknown>>;
    storageMappings: Array<Record<string, unknown>>;
    surfaces: Array<Record<string, unknown>>;
  },
  namespace: string,
  sourceLocal: string,
  targetLocal: string,
  entityOrderKey: number,
): void {
  for (const collection of [
    'assertions',
    'entities',
    'fields',
    'operations',
    'permissions',
    'queries',
    'storageMappings',
    'surfaces',
  ] as const) {
    const sourceEntries = definition[collection].filter((entry) =>
      JSON.stringify(entry).includes(sourceLocal),
    );
    for (const source of sourceEntries) {
      const clone = replaceFixtureStrings(source, [
        [sourceLocal, targetLocal],
        [
          `${namespace}:option.owner`,
          `${namespace}:option.${targetLocal}_owner`,
        ],
        [
          `${namespace}:option.buyer`,
          `${namespace}:option.${targetLocal}_buyer`,
        ],
      ]) as Record<string, unknown>;
      if (collection === 'entities') clone.orderKey = entityOrderKey;
      definition[collection].push(clone);
    }
  }
}

function replaceFixtureStrings(
  value: unknown,
  replacements: ReadonlyArray<readonly [string, string]>,
): unknown {
  if (typeof value === 'string') {
    return replacements.reduce(
      (result, [source, target]) => result.replaceAll(source, target),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceFixtureStrings(entry, replacements));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceFixtureStrings(entry, replacements),
      ]),
    );
  }
  return value;
}

function emptyDefinition(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const definition = structuredClone(source);
  for (const family of [
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
  ]) {
    definition[family] = [];
  }
  return definition;
}

function inventoryApplicationDefinition(): Record<string, unknown> {
  const application = composedApplicationDefinition();
  const inventory = inventoryModuleDefinition(APPLICATION_NAMESPACE);
  for (const collection of [
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
    const composed = application[collection] as unknown[];
    for (const entry of inventory[collection] as unknown[]) {
      assert.equal(
        composed.filter(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(entry),
        ).length,
        1,
        `composed application must contain each inventory ${collection} entry exactly once`,
      );
    }
  }
  (application.queries as Array<Record<string, unknown>>).push({
    aggregate: {
      field: applicationReference(
        'fieldReference',
        INVENTORY_IDS.fieldIds.movement.quantityDelta,
      ),
      kind: 'queryAggregateSelection',
      operator: 'sum',
      schemaVersion: nodeVersion,
      selectionId: inventoryScopeProbeIds.selection,
    },
    filter: {
      kind: 'allPredicate',
      schemaVersion: nodeVersion,
      terms: [
        {
          field: applicationReference(
            'fieldReference',
            INVENTORY_IDS.fieldIds.movement.itemId,
          ),
          kind: 'fieldComparisonPredicate',
          operator: 'equals',
          schemaVersion: nodeVersion,
          value: {
            kind: 'queryParameterReference',
            parameterId: inventoryScopeProbeIds.itemParameter,
            schemaVersion: nodeVersion,
          },
        },
        {
          field: applicationReference(
            'fieldReference',
            INVENTORY_IDS.fieldIds.movement.locationId,
          ),
          kind: 'fieldComparisonPredicate',
          operator: 'equals',
          schemaVersion: nodeVersion,
          value: {
            kind: 'queryParameterReference',
            parameterId: inventoryScopeProbeIds.locationParameter,
            schemaVersion: nodeVersion,
          },
        },
      ],
    },
    kind: 'queryDefinition',
    maximumResultCount: 1,
    module: applicationReference('moduleReference', INVENTORY_IDS.moduleId),
    parameters: [
      {
        kind: 'queryParameterDefinition',
        orderKey: 10,
        parameterId: inventoryScopeProbeIds.itemParameter,
        schemaVersion: nodeVersion,
      },
      {
        kind: 'queryParameterDefinition',
        orderKey: 20,
        parameterId: inventoryScopeProbeIds.locationParameter,
        schemaVersion: nodeVersion,
      },
    ],
    permission: applicationReference(
      'permissionReference',
      `${INVENTORY_IDS.namespace}:permission.inventory_movement_read`,
    ),
    queryId: inventoryScopeProbeIds.query,
    queryType: 'aggregate',
    schemaVersion: nodeVersion,
    sourceEntity: applicationReference(
      'entityReference',
      INVENTORY_IDS.entityIds.movement,
    ),
    tier: 'q1',
  });
  const inventoryModule = (
    inventory.modules as Array<Record<string, unknown>>
  )[0];
  assert.ok(inventoryModule);
  assert.equal(
    (application.modules as Array<Record<string, unknown>>).filter(
      (candidate) => candidate.moduleId === inventoryModule.moduleId,
    ).length,
    1,
    'composed application must contain the inventory module exactly once',
  );
  return application;
}

// Version-from-artifact: nodes spliced into the composed application must
// declare that application's own version, never a literal. Inventory adoption
// moved it to v4, and a pinned 'v3' here mixes node versions.
const nodeVersion = (
  composedApplicationDefinition() as { languageVersion: string }
).languageVersion;

function applicationReference(kind: string, inventoryId: string) {
  return {
    kind,
    schemaVersion: nodeVersion,
    targetId: applicationInventoryId(inventoryId),
  };
}

function applicationInventoryId(id: string): string {
  assert.ok(id.startsWith(`${INVENTORY_NAMESPACE}:`));
  return `${APPLICATION_NAMESPACE}${id.slice(INVENTORY_NAMESPACE.length)}`;
}

function movementScopeProbeValues(
  itemId: string,
  locationId: string,
  quantityDelta: string,
): Record<string, unknown> {
  return {
    [applicationInventoryId(INVENTORY_IDS.fieldIds.movement.itemId)]: itemId,
    [applicationInventoryId(INVENTORY_IDS.fieldIds.movement.locationId)]:
      locationId,
    [applicationInventoryId(INVENTORY_IDS.fieldIds.movement.quantityDelta)]:
      quantityDelta,
    [applicationInventoryId(INVENTORY_IDS.fieldIds.movement.postingRole)]:
      `${APPLICATION_NAMESPACE}:option.inventory_posting_role_adjustment`,
    [applicationInventoryId(
      INVENTORY_IDS.fieldIds.movement.stockDimensionSetVersion,
    )]: `${APPLICATION_NAMESPACE}:option.stock_dimension_set_version_v1`,
  };
}

function requiredStorageColumn(
  entity: StorageTargetPayloadV1['entities'][number],
  inventoryFieldId: string,
): StorageTargetPayloadV1['entities'][number]['columns'][number] {
  const column = entity.columns.find(
    (candidate) =>
      candidate.canonicalFieldId === applicationInventoryId(inventoryFieldId),
  );
  assert.ok(column, `missing storage column for ${inventoryFieldId}`);
  return column;
}

async function insertScopedTestRecord(
  client: pg.Pool | pg.PoolClient,
  storage: StorageTargetPayloadV1,
  entity: StorageTargetPayloadV1['entities'][number],
  tenantId: string,
  environmentId: string,
  legalEntityId: string,
  recordId: string,
  overrides: Readonly<Record<string, unknown>>,
  relationTargetIds: Readonly<Record<string, string>>,
  businessPeriod: string | null = null,
): Promise<void> {
  assert.ok(entity.legalEntity);
  const relationColumns = storage.relations.filter(
    (relation) =>
      relation.sourceEntityId === entity.entityId &&
      relation.relationColumn.origin !== 'field',
  );
  const businessPeriodColumn = entity.factStorage?.businessPeriod.column;
  if (businessPeriodColumn) assert.ok(businessPeriod);
  const columns = [
    'tenant_id',
    'environment_id',
    entity.legalEntity.column,
    ...(businessPeriodColumn ? [businessPeriodColumn] : []),
    entity.recordIdentity.column,
    ...entity.columns.map((column) => column.physicalName),
    ...relationColumns.map((relation) => relation.relationColumn.physicalName),
  ];
  const values = [
    tenantId,
    environmentId,
    legalEntityId,
    ...(businessPeriodColumn ? [businessPeriod] : []),
    recordId,
    ...entity.columns.map((column) =>
      Object.hasOwn(overrides, column.canonicalFieldId)
        ? overrides[column.canonicalFieldId]
        : scopeProbeDefaultValue(column, recordId),
    ),
    ...relationColumns.map((relation) => {
      const targetId = relationTargetIds[relation.targetEntityId];
      assert.ok(targetId, `missing relation target ${relation.relationId}`);
      return targetId;
    }),
  ];
  await client.query(
    `INSERT INTO north_star_module.${quoteTestIdentifier(entity.physicalTableName)}
       (${columns.map(quoteTestIdentifier).join(', ')})
     VALUES (${values.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    values,
  );
}

async function insertTenantSharedTestRecord(
  client: pg.Pool | pg.PoolClient,
  entity: StorageTargetPayloadV1['entities'][number],
  tenantId: string,
  environmentId: string,
  recordId: string,
): Promise<void> {
  assert.equal(entity.legalEntity, undefined);
  const columns = [
    'tenant_id',
    'environment_id',
    entity.recordIdentity.column,
    ...entity.columns.map((column) => column.physicalName),
  ];
  const values = [
    tenantId,
    environmentId,
    recordId,
    ...entity.columns.map((column) => scopeProbeDefaultValue(column, recordId)),
  ];
  await client.query(
    `INSERT INTO north_star_module.${quoteTestIdentifier(entity.physicalTableName)}
       (${columns.map(quoteTestIdentifier).join(', ')})
     VALUES (${values.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    values,
  );
}

function scopeProbeDefaultValue(
  column: StorageTargetPayloadV1['entities'][number]['columns'][number],
  recordId: string,
): unknown {
  if (!column.fieldContract.required) return null;
  switch (column.fieldContract.fieldKind) {
    case 'booleanFieldType':
      return false;
    case 'dateFieldType':
      return '2026-07-29';
    case 'dateTimeFieldType':
      return '2026-07-29T12:00:00.000Z';
    case 'enumFieldType':
      return (
        column.fieldContract.enumOptionIds.find((option) =>
          option.endsWith('_active'),
        ) ?? column.fieldContract.enumOptionIds[0]
      );
    case 'exactDecimalFieldType':
    case 'moneyFieldType':
    case 'quantityFieldType':
      return '1';
    case 'integerFieldType':
      return 1;
    case 'textFieldType': {
      const maximumLength = column.fieldContract.bounds.maximumLength ?? 80;
      return `${column.physicalName}-${recordId.slice(0, 8)}`.slice(
        0,
        maximumLength,
      );
    }
    case 'timeFieldType':
      return '00:00:00';
  }
}

function quoteTestIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z][a-z0-9_]{0,62}$/u);
  return `"${identifier}"`;
}

function definitionBytes(definition: unknown): Uint8Array {
  return new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(definition)),
  );
}

function moduleInput(
  definition: unknown,
  expectedActiveRelease: CompilerInput['expectedActiveRelease'] = null,
): CompilerInput {
  return {
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: definitionBytes(definition),
    profile: profileForNormalizedBytes(definitionBytes(definition)),
  };
}

function mustCompile(input: CompilerInput): CompileSuccess {
  const result = compileApplication(input);
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function compiledProjectionPayload<T>(
  compiled: CompileSuccess,
  familyId: string,
): T {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === reference.artifactRoot,
  );
  assert.ok(manifestArtifact);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as { chunks: Array<{ contentHash: string }> };
  const chunk = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === manifest.chunks[0]?.contentHash,
  );
  assert.ok(chunk);
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
}

function runtimeProjection<TFamily extends RequestRuntimeProjectionFamily>(
  compiled: CompileSuccess,
  familyId: TFamily,
): RuntimeProjection<TFamily> {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  return Object.freeze({
    artifactRoot: reference.artifactRoot,
    familyId,
    instanceId: reference.instanceId,
    payload: compiledProjectionPayload<ImmutableJsonValue>(compiled, familyId),
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  });
}

function assertModuleError(
  error: unknown,
  code: string,
  subjectId: string | null,
): true {
  assert.ok(error instanceof ModuleRuntimeInterpreterError);
  assert.equal(error.code, code);
  assert.equal(error.subjectId, subjectId);
  assertNoPhysicalDetails({
    code: error.code,
    message: error.message,
    subjectId: error.subjectId,
  });
  return true;
}

function assertLegalEntityReadScopeIntegrityError(
  error: unknown,
  subjectId: string,
  message: string,
): true {
  assert.ok(error instanceof LegalEntityReadScopeIntegrityError);
  assert.equal(error.code, 'LEGAL_ENTITY_READ_SCOPE_INTEGRITY_INVALID');
  assert.equal(error.subjectId, subjectId);
  assert.equal(error.message, message);
  return true;
}

async function rejectedModuleError(
  promise: Promise<unknown>,
  code: string,
  subjectId: string | null,
): Promise<{ code: string; subjectId: string | null }> {
  try {
    await promise;
  } catch (error) {
    assertModuleError(error, code, subjectId);
    return { code, subjectId };
  }
  assert.fail(`expected ${code}`);
}

async function runPersistedOrderingProbe(
  locale: string,
): Promise<{ bytes: Buffer; locale: string }> {
  const probeEnvironment = { ...process.env };
  delete probeEnvironment.NODE_TEST_CONTEXT;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-name-pattern=emits persisted ordering probe bytes',
      resolve('test/postgres/module-runtime.test.ts'),
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...probeEnvironment,
        LANG: locale,
        LC_ALL: locale,
        PR1_LOCALE_PROBE_CHILD: '1',
      },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  const match = /PR1_LOCALE_PROBE=(\{[^\n]+\})/u.exec(stdout);
  assert.ok(match?.[1], `locale probe produced no result:\n${stdout}`);
  const result = JSON.parse(match[1]) as { bytes: string; locale: string };
  return { bytes: Buffer.from(result.bytes, 'base64'), locale: result.locale };
}

async function persistedLocaleOrderingChanges(): Promise<string> {
  const definition = localeOrderingDefinition();
  const empty = mustCompile(moduleInput(emptyDefinition(definition)));
  const compiled = mustCompile(
    moduleInput(definition, expectedActiveReleaseFrom(empty)),
  );
  const tenant = 'd1000000-0000-4000-8000-000000000001';
  const environment = 'd2000000-0000-4000-8000-000000000002';
  const principal = 'd3000000-0000-4000-8000-000000000003';

  return withEphemeralPostgres(
    'module-locale-order',
    async ({ connection, pool }) => {
      await migrateAndSeed(pool, [[tenant, environment, 'locale-order']]);
      const runtimePool = new pg.Pool({
        ...connection,
        max: 3,
        user: 'north_star_runtime',
      });
      const materializerPool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_module_materializer',
      });
      const modulePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_module_runtime',
      });
      try {
        const context = (
          await contextsFor([['l', tenant, environment, principal]])
        ).l!;
        const releases = await persistSequence(runtimePool, context, [
          [empty, emptyDefinition(definition)],
          [compiled, definition],
        ]);
        await setPointer(pool, tenant, environment, releases[0]!);
        await grantExecutorAuthority(pool, [[tenant, principal]]);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        );
        await prepare(materializer, context, principal, releases[1]!);
        await admitCandidate(runtimePool, context, releases[1]!, compiled);
        await setPointer(pool, tenant, environment, releases[1]!);

        const policy = new AllowPolicy();
        const interpreter = new PostgresModuleRuntimeInterpreter(
          runtimePool,
          humanActorIssuer(),
        );
        const gateway = operationGatewayFor(policy, interpreter);
        const entry = runtimeEntry(runtimePool, {
          l: identity(tenant, environment, principal),
        });
        const view = await issuedView(entry, 'l');
        const result = await operation(gateway, view, 'master_create', {
          recordId: randomUUID(),
          values: {
            [localeOrderingFieldIds.punctuation]: 'punctuation',
            [localeOrderingFieldIds.digit]: 'digit',
          },
        });
        assert.ok(result.trust);
        const persisted = await pool.query<{ changes: string }>(
          `SELECT changes::text AS changes
             FROM platform.trust_business_change_documents
            WHERE change_document_id = $1`,
          [result.trust.changeDocumentId],
        );
        const changes = persisted.rows[0]?.changes;
        assert.ok(changes);
        return changes;
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          modulePool.end(),
        ]);
      }
    },
  );
}

function localeOrderingDefinition(): Record<string, unknown> {
  return replaceDefinitionIds(
    ordinaryModuleV1(),
    new Map([
      [FIXTURE_IDS.fieldIds.parentName, localeOrderingFieldIds.punctuation],
      [FIXTURE_IDS.fieldIds.parentNumber, localeOrderingFieldIds.digit],
    ]),
  ) as Record<string, unknown>;
}

function replaceDefinitionIds(
  value: unknown,
  replacements: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) {
    return value.map((entry) => replaceDefinitionIds(entry, replacements));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceDefinitionIds(entry, replacements),
      ]),
    );
  }
  return value;
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}

if (localeProbeChild) {
  test('emits persisted ordering probe bytes', async () => {
    const changes = await persistedLocaleOrderingChanges();
    process.stdout.write(
      `PR1_LOCALE_PROBE=${JSON.stringify({
        bytes: Buffer.from(changes, 'utf8').toString('base64'),
        locale: Intl.Collator().resolvedOptions().locale,
      })}\n`,
    );
  });
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

// ===========================================================================
// Record transitions (ADR-0050).
//
// A document with a state machine, one `transitionStateEffect` operation, and
// one materialized state field, exercised through the real compiler, the real
// materializer, the real release-verification service, the real gateway and
// the real interpreter against real PostgreSQL.
// ===========================================================================

/**
 * The fixture is authored at v3 and pinned there deliberately, so the
 * transition module re-authors it at the version that materializes state
 * fields. Node-version purity is uniform within a package revision -- a v5
 * node in a v4 package is refused and so is the reverse -- so EVERY
 * `schemaVersion` moves together, which is also the mechanism that makes
 * adoption an application-wide event rather than a per-module choice.
 */
function transitionModuleDefinition(
  namespace: string,
  languageVersion: 'v4' | 'v5' = 'v5',
): Record<string, unknown> {
  const source = ordinaryModuleV1ForNamespace(namespace) as Record<
    string,
    unknown
  >;
  // Every node version at once. No fixture identity contains `v3`, so this
  // also carries `northstar.normalization/v3` to its paired profile.
  const definition = replaceFixtureStrings(source, [
    ['v3', languageVersion],
  ]) as {
    fields: Array<Record<string, unknown>>;
    languageVersion: string;
    normalizationProfileVersion: string;
    operations: Array<Record<string, unknown>>;
    permissions: Array<Record<string, unknown>>;
    queries: Array<Record<string, unknown>>;
    stateMachines: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  const version = languageVersion;
  const probeReference = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: version,
    targetId,
  });
  const entityId = `${namespace}:entity.master`;

  // An ORDINARY authored field, so the vertical can prove that a transition
  // still evaluates its operation precondition against the authoritative prior
  // image. It is deliberately NOT a second state field.
  const approvalFieldId = `${namespace}:field.master_approval`;
  definition.fields.push({
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'none',
    entity: probeReference('entityReference', entityId),
    fieldId: approvalFieldId,
    fieldType: {
      kind: 'textFieldType',
      maximumLength: 20,
      schemaVersion: version,
    },
    kind: 'fieldDefinition',
    label: 'Approval',
    orderKey: 30,
    presence: 'required',
    reportable: true,
    schemaVersion: version,
    searchable: false,
  });

  // The state machine. Under the ruling its state field is MATERIALIZED as an
  // ordinary enum field on this entity whose options are these states, so the
  // document has exactly one state.
  const machineId = `${namespace}:machine.master_lifecycle`;
  const draftStateId = `${namespace}:state.master_draft`;
  const releasedStateId = `${namespace}:state.master_released`;
  const transitionId = `${namespace}:transition.master_release`;
  const permissionId = `${namespace}:permission.master_release`;
  definition.stateMachines = [
    {
      entity: probeReference('entityReference', entityId),
      initialState: probeReference('stateReference', draftStateId),
      kind: 'stateMachineDefinition',
      machineId,
      schemaVersion: version,
      states: [
        {
          kind: 'stateDefinition',
          label: 'Draft',
          orderKey: 10,
          schemaVersion: version,
          stateId: draftStateId,
        },
        {
          kind: 'stateDefinition',
          label: 'Released',
          orderKey: 20,
          schemaVersion: version,
          stateId: releasedStateId,
        },
      ],
      transitions: [
        {
          fromState: probeReference('stateReference', draftStateId),
          kind: 'transitionDefinition',
          label: 'Release master',
          orderKey: 10,
          permission: probeReference('permissionReference', permissionId),
          schemaVersion: version,
          toState: probeReference('stateReference', releasedStateId),
          transitionId,
        },
      ],
    },
  ];
  // THE READ PATH -- acceptance criteria, not a follow-up. Materialization
  // puts the state field in `packageRevision.fields`, which is exactly what
  // makes this selection resolve: before the ruling the same selection failed
  // `CANON_QUERY_FIELD_LOCALITY` and `CANON_REFERENCE_UNRESOLVED`, so a
  // released document could be transitioned and then never listed by state.
  const stateFieldId = `${namespace}:derived_state_field.machine.master_lifecycle`;
  const masterQueryIds = new Set(
    ['get', 'list', 'search', 'resolve'].map(
      (queryType) => `${namespace}:query.master_${queryType}`,
    ),
  );
  // Below v5 this selection cannot exist -- the field is not in
  // `packageRevision.fields`, so it fails CANON_QUERY_FIELD_LOCALITY and
  // CANON_REFERENCE_UNRESOLVED before any compiler rule is consulted. That is
  // the read-path hole ADR-0050 §6 named, and it is why the v4 control below
  // has to omit the selection to observe the compiler's refusal at all.
  for (const query of languageVersion === 'v5' ? definition.queries : []) {
    if (!masterQueryIds.has(String(query.queryId))) continue;
    (query.selections as Array<Record<string, unknown>>).push({
      field: probeReference('fieldReference', stateFieldId),
      kind: 'querySelection',
      orderKey: 30,
      schemaVersion: version,
      selectionId: `${namespace}:selection.master_${String(query.queryType)}_state`,
    });
  }

  definition.permissions.push({
    action: 'transition',
    kind: 'permissionDefinition',
    label: 'master release',
    permissionId,
    resource: probeReference('entityReference', entityId),
    schemaVersion: version,
  });
  definition.operations.push({
    confirmation: 'none',
    effect: {
      kind: 'transitionStateEffect',
      schemaVersion: version,
      transition: probeReference('transitionReference', transitionId),
    },
    kind: 'operationDefinition',
    module: probeReference('moduleReference', `${namespace}:module.master`),
    operationId: `${namespace}:operation.master_release`,
    permission: probeReference('permissionReference', permissionId),
    // The transition still carries an ordinary precondition over an ordinary
    // authored field. It must be evaluated against the persisted image.
    precondition: {
      field: probeReference('fieldReference', approvalFieldId),
      kind: 'fieldComparisonPredicate',
      operator: 'equals',
      schemaVersion: version,
      value: { kind: 'textValue', schemaVersion: version, value: 'approved' },
    },
    readBack: probeReference('queryReference', `${namespace}:query.master_get`),
    schemaVersion: version,
    tier: 'o0',
  });
  return definition;
}

/**
 * One entry of a persisted change document, as this test reads it back out of
 * `platform.trust_business_change_documents.changes`.
 *
 * Declared structurally here rather than imported from the producer's
 * `BusinessFieldChangeInput`: the assertion's job is to observe what was
 * actually stored, and a reader typed by the writer's own contract stops being
 * an independent observation of it. `newState`/`oldState` are read as an
 * optional `value` carrier because a `VALUE` state nests the payload while
 * `CLEARED` and `ABSENT` do not.
 */
interface PersistedFieldChange {
  readonly fieldId: string;
  readonly newState: { readonly value?: unknown } | null;
  readonly oldState: { readonly value?: unknown } | null;
}

interface TransitionProbeRuntime {
  readonly approvalFieldId: string;
  readonly queries: SemanticQueryGateway;
  readonly stateFieldId: string;
  readonly changeDocumentStates: (
    recordId: string,
  ) => Promise<Array<{ newState: unknown; oldState: unknown }>>;
  readonly namespace: string;
  readonly operations: SemanticOperationGateway;
  readonly readState: (recordId: string) => Promise<{
    readonly revision: number;
    readonly state: string | null;
  }>;
  readonly stateColumnCount: () => Promise<number>;
  readonly view: RequestRuntimeView;
}

async function withTransitionProbeRuntime(
  run: (runtime: TransitionProbeRuntime) => Promise<void>,
): Promise<void> {
  const namespace = 'northstar.smtransition';
  const definition = transitionModuleDefinition(namespace);
  const emptyDefinition_ = emptyDefinition(definition);
  const empty = mustCompile(moduleInput(emptyDefinition_));
  const compiled = mustCompile(
    moduleInput(definition, expectedActiveReleaseFrom(empty)),
  );
  const storage = compiledProjectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const entity = storage.entities.find(
    (candidate) => candidate.entityId === `${namespace}:entity.master`,
  );
  assert.ok(entity);
  const approvalFieldId = `${namespace}:field.master_approval`;
  const stateFieldId = `${namespace}:derived_state_field.machine.master_lifecycle`;
  // The ruled shape: ONE state, an ordinary column on the entity.
  const stateColumn = entity.columns.find(
    (column) => column.canonicalFieldId === stateFieldId,
  );
  assert.ok(
    stateColumn,
    "the machine's state field must be an ordinary column",
  );

  const tenant = '5a000000-0000-4000-8000-000000000001';
  const environment = '5b000000-0000-4000-8000-000000000002';
  const principal = '5c000000-0000-4000-8000-000000000003';
  await withEphemeralPostgres(
    'sm-transition-probe',
    async ({ connection, pool }) => {
      await migrateAndSeed(pool, [[tenant, environment, 'smtransition']]);
      const runtimePool = new pg.Pool({
        ...connection,
        max: 3,
        user: 'north_star_runtime',
      });
      const materializerPool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_module_materializer',
      });
      const modulePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_module_runtime',
      });
      try {
        const context = (
          await contextsFor([['transition', tenant, environment, principal]])
        ).transition!;
        const releases = await persistSequence(runtimePool, context, [
          [empty, emptyDefinition_],
          [compiled, definition],
        ]);
        await setPointer(pool, tenant, environment, releases[0]!);
        await grantExecutorAuthority(pool, [[tenant, principal]]);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        );
        await prepare(materializer, context, principal, releases[1]!);
        const candidateIdentity = identity(tenant, environment, principal);
        const sourceView = await issuedView(
          runtimeEntry(runtimePool, { transition: candidateIdentity }),
          'transition',
        );
        const policy = new AllowPolicy();
        const view = await issuedCandidateView(
          compiled,
          releases[1]!,
          candidateIdentity,
          sourceView.pointer,
          policy,
        );
        const interpreter = new PostgresModuleRuntimeInterpreter(
          runtimePool,
          humanActorIssuer(),
        );

        const staged = await pool.query<{
          verification_evidence_id: MintedUuid;
        }>(
          `SELECT verification_evidence_id
           FROM platform.tenant_releases
          WHERE tenant_id = $1 AND environment_id = $2 AND release_id = $3`,
          [tenant, environment, releases[1]],
        );
        const evidenceId = staged.rows[0]?.verification_evidence_id;
        assert.ok(evidenceId);
        const verification = await new PostgresReleaseVerificationService(
          runtimePool,
        )
          .executeSemanticCandidateWithExecutor(
            context,
            {
              compiledRelease: compiled,
              evidenceId,
              releaseId: releases[1]!,
            },
            interpreter,
          )
          .then(
            (resultSet) =>
              `passed with ${(resultSet as unknown as { results: unknown[] }).results.length} executed results`,
            (error: unknown) =>
              `${(error as Error).name}: ${(error as Error).message}`,
          );
        assert.match(
          verification,
          /^passed with \d+ executed results$/,
          `release verification must pass for a transition module, got: ${verification}`,
        );

        await run(
          Object.freeze({
            approvalFieldId,
            queries: new SemanticQueryGateway(policy, interpreter),
            stateFieldId,
            changeDocumentStates: async (recordId: string) => {
              const result = await pool.query<{ changes: unknown }>(
                `SELECT changes
                 FROM platform.trust_business_change_documents
                WHERE tenant_id = $1
                  AND environment_id = $2
                  AND record_id = $3
                ORDER BY recorded_at`,
                [tenant, environment, recordId],
              );
              const auditKey = stateFieldId.replaceAll(/[^A-Za-z0-9_.-]/g, '.');
              return result.rows.flatMap((row) =>
                (row.changes as readonly PersistedFieldChange[])
                  .filter((change) => change.fieldId === auditKey)
                  .map((change) => ({
                    newState: change.newState?.value ?? change.newState,
                    oldState: change.oldState?.value ?? change.oldState,
                  })),
              );
            },
            namespace,
            operations: operationGatewayFor(policy, interpreter),
            readState: async (recordId: string) => {
              const result = await pool.query<{
                revision: string;
                state: string | null;
              }>(
                `SELECT ${quoteTestIdentifier(stateColumn.physicalName)} AS state,
                      ${quoteTestIdentifier(entity.optimisticRevision.column)} AS revision
                 FROM north_star_module.${quoteTestIdentifier(entity.physicalTableName)}
                WHERE ${quoteTestIdentifier(entity.recordIdentity.column)} = $1`,
                [recordId],
              );
              assert.equal(result.rowCount, 1);
              const row = result.rows[0]!;
              return { revision: Number(row.revision), state: row.state };
            },
            // A document must carry exactly ONE state column. This counts the
            // physical columns whose canonical identity is a state field.
            stateColumnCount: async () => {
              const result = await pool.query<{ total: string }>(
                `SELECT count(*)::text AS total
                 FROM information_schema.columns
                WHERE table_schema = 'north_star_module'
                  AND table_name = $1
                  AND column_name = ANY($2::text[])`,
                [
                  entity.physicalTableName,
                  [
                    stateColumn.physicalName,
                    ...entity.derivedStateFields.map(
                      (field) => field.physicalName,
                    ),
                  ],
                ],
              );
              return Number(result.rows[0]!.total);
            },
            view,
          }),
        );
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          modulePool.end(),
        ]);
      }
    },
  );
}

test('a materialized state field is selectable, and only a transition writes it', async () => {
  await withTransitionProbeRuntime(async (runtime) => {
    // Exactly one state column. The machine no longer lowers a parallel
    // `derivedStateFields` entry alongside an authored one.
    assert.equal(await runtime.stateColumnCount(), 1);

    const draftStateId = `${runtime.namespace}:state.master_draft`;
    const releasedStateId = `${runtime.namespace}:state.master_released`;

    const recordId = randomUUID();
    await operation(
      runtime.operations,
      runtime.view,
      'master_create',
      {
        recordId,
        values: {
          ...masterValues(runtime.namespace, 'Releasable'),
          [runtime.approvalFieldId]: 'approved',
        },
      },
      runtime.namespace,
    );
    assert.deepEqual(await runtime.readState(recordId), {
      revision: 1,
      state: draftStateId,
    });

    // ---- Control 1: a stale expected revision is refused. -----------------
    await assert.rejects(
      operation(
        runtime.operations,
        runtime.view,
        'master_release',
        { expectedRevision: 7, recordId },
        runtime.namespace,
      ),
      (error: unknown) =>
        assertModuleError(error, 'MODULE_REVISION_CONFLICT', null),
    );
    assert.deepEqual(await runtime.readState(recordId), {
      revision: 1,
      state: draftStateId,
    });

    // ---- Control 2: no caller argument can name a target state. ----------
    // The compiled contract is closed over ['expectedRevision','recordId'].
    await assert.rejects(
      operation(
        runtime.operations,
        runtime.view,
        'master_release',
        {
          expectedRevision: 1,
          patch: { [`${runtime.namespace}:field.master_name`]: 'forged' },
          recordId,
        },
        runtime.namespace,
      ),
      (error: unknown) => {
        // The GATEWAY refuses this now, not the interpreter. A transition's
        // contract is closed over ['expectedRevision','recordId'], and the
        // outer fence belongs where that contract is read; the interpreter
        // keeps its own check behind this one.
        assert.equal(
          (error as Error).name,
          'MalformedSemanticOperationRequestError',
        );
        return true;
      },
    );

    // ---- Control 3: the precondition is evaluated against the persisted
    // image, not against anything the caller sent. ------------------------
    const unapprovedId = randomUUID();
    await operation(
      runtime.operations,
      runtime.view,
      'master_create',
      {
        recordId: unapprovedId,
        values: {
          ...masterValues(runtime.namespace, 'Not approved'),
          [runtime.approvalFieldId]: 'pending',
        },
      },
      runtime.namespace,
    );
    await assert.rejects(
      operation(
        runtime.operations,
        runtime.view,
        'master_release',
        { expectedRevision: 1, recordId: unapprovedId },
        runtime.namespace,
      ),
      (error: unknown) =>
        assertModuleError(error, 'MODULE_OPERATION_PRECONDITION_REFUSED', null),
    );
    assert.deepEqual(await runtime.readState(unapprovedId), {
      revision: 1,
      state: draftStateId,
    });

    // ---- The transition itself: server-selected target, written once. ----
    const released = await operation(
      runtime.operations,
      runtime.view,
      'master_release',
      { expectedRevision: 1, recordId },
      runtime.namespace,
    );
    assert.equal(released.outcome, 'succeeded');
    assert.ok(released.trust?.changeDocumentId);
    assert.deepEqual(await runtime.readState(recordId), {
      revision: 2,
      state: releasedStateId,
    });

    // ---- The read path. The operation's own read-back returns the new state
    // through an ordinary compiled query selection, so a released document can
    // be listed by state rather than only transitioned. `PUR-1` cannot ship
    // without this, and it is what materialization buys. ------------------
    assert.equal(
      released.readBack?.values[runtime.stateFieldId],
      releasedStateId,
    );
    const listed = await query(
      runtime.queries,
      runtime.view,
      'master_list',
      {},
      runtime.namespace,
    );
    assert.deepEqual(
      listed.records
        .filter((entry) => entry.recordId === recordId)
        .map((entry) => entry.values[runtime.stateFieldId]),
      [releasedStateId],
    );

    // ---- Control 4: the ADR-0034 case. `draft -> released` refuses a
    // SECOND release without refusing the first, because the guard is the
    // transition's own fromState rather than a projected-image predicate. --
    await assert.rejects(
      operation(
        runtime.operations,
        runtime.view,
        'master_release',
        { expectedRevision: 2, recordId },
        runtime.namespace,
      ),
      (error: unknown) =>
        assertModuleError(error, 'MODULE_MUTATION_PRECONDITION_FAILED', null),
    );
    assert.deepEqual(await runtime.readState(recordId), {
      revision: 2,
      state: releasedStateId,
    });

    // ---- The change document records the state move exactly once. --------
    assert.deepEqual(await runtime.changeDocumentStates(recordId), [
      { newState: releasedStateId, oldState: draftStateId },
    ]);
  });
});

/**
 * The gate, proved in both directions.
 *
 * Below v5 a state field is not an ordinary field: nothing writes it, no
 * predicate addresses it and no query selects it, so the effect compiles into
 * a catalog the runtime cannot admit. The recorded consequence (commit
 * `bad2d8f`) was that release verification AND every unrelated operation in
 * the release failed with an anonymous `MalformedPinnedOperationCatalogError`
 * -- an unrelated `master_create` died with it.
 *
 * That release is now unbuildable, and the refusal names its subject.
 */
/**
 * The language declares TWO permissions for a transition and execution honours
 * one. The gateway authorizes `definition.permissionId` -- the OPERATION's --
 * so a transition declaring a restricted permission under an operation
 * declaring a permissive one would execute on the permissive one, and the
 * declaration a reader trusts is the one ignored.
 *
 * BOTH halves are load-bearing. Without the second, the first is satisfiable by
 * refusing every transition, which would pass a mismatch control while
 * destroying the feature. The vertical above could not observe any of this:
 * it declares one permission id in both positions, so its policy cannot tell
 * the two declarations apart.
 */
/**
 * The state field's identity is OWNED by the machine, and this cut moved that
 * identity out of the `stateMachines` id family in `collectIds` on exactly that
 * basis. Skipping generation on a bare id match let an authored field of any
 * shape occupy the carrier: a required text field with the derived id and a
 * matching default suppresses materialization, counterfeits the column, and
 * passes every other control because the id is present.
 */
/**
 * The admission twin of the collision refusal below, and it is not optional.
 *
 * Replacing the deep comparison with "refuse ANY id collision" keeps the
 * counterfeit control green and keeps the PostgreSQL vertical green, because
 * neither fixture already contains the derived field. A refusal control alone
 * cannot tell a discriminating guard from a blanket one.
 *
 * The authored form here is the machine's own derived field, obtained by
 * round-tripping through `canonicalAuthoredProjection` rather than hand-copied
 * -- a hand-copied expectation would drift from the generator and start
 * asserting the wrong shape without failing.
 */
test('the machine-derived state field may be authored, and changes nothing', () => {
  const namespace = 'northstar.smstateidempotent';
  const definition = transitionModuleDefinition(namespace);
  const normalized = normalizeApplicationPackage(definition) as {
    fields: Array<{ fieldId: string }>;
  };
  const stateFieldId = `${namespace}:derived_state_field.machine.master_lifecycle`;
  const materialized = normalized.fields.filter(
    (field) => field.fieldId === stateFieldId,
  );
  assert.equal(materialized.length, 1, 'exactly one state field is generated');

  // Author it explicitly, exactly as normalization produced it.
  const authored = canonicalAuthoredProjection(
    normalized as Parameters<typeof canonicalAuthoredProjection>[0],
  );
  const renormalized = normalizeApplicationPackage(authored) as {
    fields: Array<{ fieldId: string }>;
  };

  // Admitted, not refused.
  assert.equal(
    renormalized.fields.filter((field) => field.fieldId === stateFieldId)
      .length,
    1,
    'authoring the derived field adds no second field and is not refused',
  );
  // And byte-identical, so the collision path produces the same package the
  // generation path does.
  assert.equal(canonicalize(renormalized), canonicalize(normalized));
});

test('an authored field wearing the derived state identity is refused', () => {
  const namespace = 'northstar.smstatecollision';
  const definition = transitionModuleDefinition(namespace) as {
    fields: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  definition.fields.push({
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'declaredDefault',
    defaultValue: {
      kind: 'textValue',
      schemaVersion: 'v5',
      value: `${namespace}:state.master_draft`,
    },
    entity: {
      kind: 'entityReference',
      schemaVersion: 'v5',
      targetId: `${namespace}:entity.master`,
    },
    fieldId: `${namespace}:derived_state_field.machine.master_lifecycle`,
    fieldType: {
      kind: 'textFieldType',
      maximumLength: 40,
      schemaVersion: 'v5',
    },
    kind: 'fieldDefinition',
    label: 'State',
    orderKey: 0,
    presence: 'required',
    reportable: true,
    schemaVersion: 'v5',
    searchable: false,
  });
  assert.throws(
    () => moduleInput(definition),
    (error: unknown) => {
      assert.ok(error instanceof CanonicalModelError);
      assert.ok(
        error.diagnostics.some(
          (entry) => entry.code === 'CANON_STATE_FIELD_COLLISION',
        ),
        `expected CANON_STATE_FIELD_COLLISION: ${JSON.stringify(error.diagnostics)}`,
      );
      return true;
    },
  );
});

test('a transition permission that disagrees with its operation is refused by name', () => {
  const namespace = 'northstar.smpermmismatch';
  const definition = transitionModuleDefinition(namespace) as {
    operations: Array<Record<string, unknown>>;
    permissions: Array<Record<string, unknown>>;
  } & Record<string, unknown>;

  // A second, genuinely different permission -- the shape a real module has
  // when a release is restricted and ordinary editing is not.
  const restricted = `${namespace}:permission.master_release_restricted`;
  definition.permissions.push({
    action: 'transition',
    kind: 'permissionDefinition',
    label: 'master release restricted',
    permissionId: restricted,
    resource: {
      kind: 'entityReference',
      schemaVersion: 'v5',
      targetId: `${namespace}:entity.master`,
    },
    schemaVersion: 'v5',
  });
  const machine = (
    definition.stateMachines as Array<Record<string, unknown>>
  )[0]!;
  (machine.transitions as Array<Record<string, unknown>>)[0]!.permission = {
    kind: 'permissionReference',
    schemaVersion: 'v5',
    targetId: restricted,
  };

  const result = compileApplication(moduleInput(definition));
  assert.equal(result.status, 'failed');
  assert.deepEqual(
    result.diagnostics
      .filter(
        (entry) => entry.code === 'COMPILER_TRANSITION_PERMISSION_MISMATCH',
      )
      .map((entry) => ({ path: entry.path, subjectId: entry.subjectId })),
    [
      {
        path: '$.operations.permission',
        subjectId: `${namespace}:operation.master_release`,
      },
    ],
  );
});

test('a transition whose permissions agree still compiles', () => {
  const result = compileApplication(
    moduleInput(transitionModuleDefinition('northstar.smpermmatch')),
  );
  assert.equal(
    result.status,
    'compiled',
    `matched permissions must still compile: ${JSON.stringify(result.diagnostics)}`,
  );
});

test('below v5 a record transition is refused by name, at compile time', () => {
  const definition = transitionModuleDefinition(
    'northstar.smtransitionv4',
    'v4',
  );
  const result = compileApplication(moduleInput(definition));
  assert.equal(result.status, 'failed');
  assert.deepEqual(
    result.diagnostics
      .filter(
        (entry) => entry.code === 'COMPILER_TRANSITION_EFFECT_UNSUPPORTED',
      )
      .map((entry) => ({ path: entry.path, subjectId: entry.subjectId })),
    [
      {
        path: '$.operations.effect.kind',
        subjectId: 'northstar.smtransitionv4:operation.master_release',
      },
    ],
  );
});
