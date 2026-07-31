import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  canonicalize,
  canonicalizeAndHash,
  normalizeApplicationPackage,
  parseNormalizedApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  expectedActiveReleaseFrom,
  type CompileSuccess,
  type CompilerInput,
  type StorageTargetPayloadV1,
} from '../../packages/compiler/src/index.js';
import {
  APPLICATION_NAMESPACE,
  composedApplicationDefinition,
} from '../../packages/domain/src/app/builder.js';
import { inventoryModuleDefinition } from '../../packages/domain/src/inventory/definition.js';
import { partyModuleDefinition } from '../../packages/domain/src/party/definition.js';
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import {
  type AggregateCacheObservation,
  PostgresModuleRuntimeInterpreter,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { PostgresModuleStorageMaterializer } from '../../packages/postgres-provider/src/module-storage-materializer.js';
import {
  PostgresReleaseVerificationService,
  releaseVerificationBinding,
} from '../../packages/postgres-provider/src/release-verification-service.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { PostgresRequestRuntimeViewService } from '../../packages/postgres-provider/src/request-runtime-view-service.js';
import { TrustedActorEnvelopeIssuer } from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import {
  MalformedLegalEntityScopeArgumentError,
  MalformedPinnedQueryCatalogError,
  SEMANTIC_AGGREGATE_RESULT_VERSION,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryGateway,
  type QueryPolicyNarrowingGateway,
  type RegisteredAggregateQueryDefinition,
  type SemanticAggregateResultEnvelope,
  type SemanticQueryExecutor,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeProjectionFamily,
  type RequestRuntimeView,
  type RuntimeProjection,
} from '../../packages/runtime/src/request-runtime-view.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const migrations = resolve('db/migrations');
const tenantId = '15000000-0000-4000-8000-000000000001';
const environmentId = '25000000-0000-4000-8000-000000000002';
const legalEntityId = '35000000-0000-4000-8000-000000000003';
const principalId = '45000000-0000-4000-8000-000000000004';
const itemId = '55000000-0000-4000-8000-000000000005';
const locationId = '65000000-0000-4000-8000-000000000006';
const otherItemId = '75000000-0000-4000-8000-000000000007';
const inventoryIds = Object.freeze({
  namespace: APPLICATION_NAMESPACE,
  queryIds: {
    onHand: `${APPLICATION_NAMESPACE}:query.inventory_movement_on_hand`,
  },
  queryParameterIds: {
    onHandAtTime: `${APPLICATION_NAMESPACE}:parameter.on_hand_at_time`,
    onHandItemId: `${APPLICATION_NAMESPACE}:parameter.on_hand_item_id`,
    onHandLegalEntityId: `${APPLICATION_NAMESPACE}:parameter.on_hand_legal_entity_id`,
    onHandLocationId: `${APPLICATION_NAMESPACE}:parameter.on_hand_location_id`,
    onHandRecordedAtHorizon: `${APPLICATION_NAMESPACE}:parameter.on_hand_recorded_at_horizon`,
  },
});

const earlyEffectiveHorizon = '2026-02-01T00:00:00.000Z';
const lateEffectiveHorizon = '2026-06-01T00:00:00.000Z';
const firstRecordedHorizon = '2026-06-15T00:00:00.000Z';
const secondRecordedHorizon = '2026-08-01T00:00:00.000Z';
const verificationScopeAssertionId = `${APPLICATION_NAMESPACE}:assertion.party_verification_scope`;

type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];

interface EntityBinding {
  readonly entity: StorageEntityTarget;
  readonly fields: ReadonlyMap<string, StorageEntityTarget['columns'][number]>;
  readonly legalEntityColumn: string | null;
  readonly recordIdColumn: string;
}

interface InventoryStorageBinding {
  readonly item: EntityBinding;
  readonly location: EntityBinding;
  readonly movement: EntityBinding;
  readonly schemaName: string;
  readonly storageTarget: StorageTargetPayloadV1;
  readonly transaction: EntityBinding;
  readonly transactionLine: EntityBinding;
}

interface Fixture {
  readonly empty: CompileSuccess;
  readonly emptyDefinition: Record<string, unknown>;
  readonly inventory: CompileSuccess;
  readonly inventoryDefinition: Record<string, unknown>;
  readonly storage: StorageTargetPayloadV1;
}

interface StagedRelease {
  readonly command: RegisterTenantReleaseCommand<CompileSuccess>;
  readonly releaseId: MintedUuid;
}

test('canonical-language-v4 onHand aggregate catalog is accepted and every unknown nested version is refused before execution', async () => {
  const fixture = buildFixture();
  const policy = new AllowPolicy();
  const arguments_ = onHandArguments(
    lateEffectiveHorizon,
    firstRecordedHorizon,
  );
  let executions = 0;
  const executor = aggregateExecutor(() => {
    executions += 1;
  });
  const view = await issuedCompiledView(fixture.inventory, policy);
  const accepted = await new SemanticQueryGateway(
    policy,
    executor,
  ).invokeAggregate(view, {
    arguments: arguments_,
    queryId: inventoryIds.queryIds.onHand,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assertAggregateValue(accepted, '0');
  assert.equal(executions, 1);

  const versionVictims = [
    {
      label: 'former semantic-query-gateway.ts:1057 source field type',
      mutate(query: MutableAggregateCatalogQuery) {
        query.aggregatePlan.sourceFieldType.schemaVersion = 'v999';
      },
    },
    {
      label: 'former semantic-query-gateway.ts:1089 result type',
      mutate(query: MutableAggregateCatalogQuery) {
        query.aggregate.resultType.schemaVersion = 'v999';
      },
    },
    {
      label: 'former semantic-query-gateway.ts:1105 result base unit',
      mutate(query: MutableAggregateCatalogQuery) {
        query.aggregate.resultType.kind = 'quantityAggregateResultType';
        query.aggregate.resultType.baseUnit = {
          kind: 'unitReference',
          schemaVersion: 'v999',
          targetId: `${inventoryIds.namespace}:unit.each`,
        };
        query.aggregatePlan.sourceFieldType.kind = 'quantityFieldType';
        query.aggregatePlan.sourceFieldType.baseUnit = {
          kind: 'unitReference',
          schemaVersion: 'v4',
          targetId: `${inventoryIds.namespace}:unit.each`,
        };
      },
    },
    {
      label: 'former semantic-query-gateway.ts:1409 predicate source type',
      mutate(query: MutableAggregateCatalogQuery) {
        const comparison = firstComparison(query.filterPlan.root);
        comparison.sourceFieldType.schemaVersion = 'v999';
      },
    },
    {
      label: 'former semantic-query-gateway.ts:1432 parameter reference',
      mutate(query: MutableAggregateCatalogQuery) {
        const comparison = firstComparison(query.filterPlan.root);
        comparison.value.schemaVersion = 'v999';
      },
    },
  ] as const;

  for (const victim of versionVictims) {
    let malformedExecutions = 0;
    const malformedView = await issuedCompiledView(
      fixture.inventory,
      policy,
      (payload) => {
        victim.mutate(requiredMutableOnHand(payload));
      },
    );
    await assert.rejects(
      () =>
        new SemanticQueryGateway(
          policy,
          aggregateExecutor(() => {
            malformedExecutions += 1;
          }),
        ).invokeAggregate(malformedView, {
          arguments: arguments_,
          queryId: inventoryIds.queryIds.onHand,
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        }),
      (error: unknown) => error instanceof MalformedPinnedQueryCatalogError,
      victim.label,
    );
    assert.equal(malformedExecutions, 0, victim.label);
  }
});

test('omitting the exactly-one legal-entity operand is a typed refusal, never zero or a generic rejection', async () => {
  const fixture = buildFixture();
  const policy = new AllowPolicy();
  const view = await issuedCompiledView(fixture.inventory, policy);
  let executions = 0;
  const gateway = new SemanticQueryGateway(
    policy,
    aggregateExecutor(() => {
      executions += 1;
    }),
  );

  await assert.rejects(
    () =>
      gateway.invokeAggregate(view, {
        arguments: {
          [inventoryIds.queryParameterIds.onHandAtTime]: lateEffectiveHorizon,
          [inventoryIds.queryParameterIds.onHandItemId]: itemId,
          [inventoryIds.queryParameterIds.onHandLocationId]: locationId,
          [inventoryIds.queryParameterIds.onHandRecordedAtHorizon]:
            firstRecordedHorizon,
        },
        queryId: inventoryIds.queryIds.onHand,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      }),
    (error: unknown) => {
      assert.ok(error instanceof MalformedLegalEntityScopeArgumentError);
      assert.equal(error.code, 'SEMANTIC_QUERY_LEGAL_ENTITY_SCOPE_INVALID');
      assert.equal(error.reason, 'selection-omitted');
      return true;
    },
  );
  assert.equal(
    executions,
    0,
    'a returned zero or generic provider rejection would mean the refused request reached execution',
  );
});

test('registered onHand is temporal, narrowed, and atomically invalidates a same-key anchor after an append', async () => {
  const fixture = buildFixture();
  const binding = storageBinding(fixture.storage);
  await withEphemeralPostgres('inventory-onhand', async (database) => {
    await migrateAndProvision(database.pool, fixture.inventory.releaseRoot);
    const runtimePool = new pg.Pool({
      ...database.connection,
      application_name: 'g3-p5-onhand',
      max: 4,
      user: 'north_star_runtime',
    });
    const materializerPool = new pg.Pool({
      ...database.connection,
      max: 1,
      user: 'north_star_module_materializer',
    });
    const modulePool = new pg.Pool({
      ...database.connection,
      max: 1,
      user: 'north_star_module_runtime',
    });
    try {
      const context = await trustedContext();
      await assert.rejects(
        withModuleRole(runtimePool, context, (client) =>
          client.query(
            'SELECT north_star_internal.advance_semantic_aggregate_generation($1,$2)',
            [otherItemId, legalEntityId],
          ),
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { code?: string }).code, 'P0001');
          assert.match(
            error.message,
            /SEMANTIC_AGGREGATE_GENERATION_SCOPE_MISMATCH/u,
          );
          return true;
        },
        'the definer-backed generation advance must reject a caller-selected tenant and environment',
      );
      const releases = await persistSequence(runtimePool, context, [
        [fixture.empty, fixture.emptyDefinition],
        [fixture.inventory, fixture.inventoryDefinition],
      ]);
      await setPointer(database.pool, releases[0]!.releaseId);
      await grantExecutorAuthority(database.pool);
      const prepared = await new PostgresModuleStorageMaterializer(
        materializerPool,
        modulePool,
      ).prepare({
        context,
        expiresAt: '2099-01-01T00:00:00.000Z',
        generationId: randomUUID(),
        initiatedBy: principalId,
        preparationId: randomUUID(),
        targetReleaseId: releases[1]!.releaseId,
      });
      assert.equal(prepared.schemaState, 'APPLIED');
      await setPointer(database.pool, releases[1]!.releaseId);
      await seedFoundation(runtimePool, context, binding);
      await seedMovement(runtimePool, context, binding, {
        effectiveAt: '2026-01-10T00:00:00.000Z',
        ordinal: 1,
        quantity: '5',
        recordedAt: '2026-01-11T00:00:00.000Z',
      });
      await seedMovement(runtimePool, context, binding, {
        effectiveAt: '2026-03-10T00:00:00.000Z',
        ordinal: 2,
        quantity: '3',
        recordedAt: '2026-03-11T00:00:00.000Z',
      });
      await seedMovement(runtimePool, context, binding, {
        archived: true,
        effectiveAt: '2026-01-15T00:00:00.000Z',
        ordinal: 3,
        quantity: '100',
        recordedAt: '2026-01-16T00:00:00.000Z',
      });

      const policy = new AllowPolicy();
      const entry = runtimeEntry(runtimePool, policy);
      const view = await issuedView(entry);
      const observations: AggregateCacheObservation[] = [];
      const interpreter = new PostgresModuleRuntimeInterpreter(
        runtimePool,
        actorIssuer(),
        (observation) => observations.push(observation),
      );
      const gateway = new SemanticQueryGateway(policy, interpreter);
      const sameKeyAppendArguments = onHandArguments(
        earlyEffectiveHorizon,
        firstRecordedHorizon,
      );

      const empty = await invokeOnHand(
        gateway,
        view,
        onHandArguments(
          lateEffectiveHorizon,
          firstRecordedHorizon,
          otherItemId,
        ),
      );
      assertAggregateValue(empty, '0');

      observations.length = 0;
      const historical = await invokeOnHand(
        gateway,
        view,
        sameKeyAppendArguments,
      );
      assertAggregateValue(historical, '5');
      assert.deepEqual(
        observations.map((entry) => entry.kind),
        ['ledger-recomputation'],
      );
      const historicalAnchor = await readOnlyAnchor(
        runtimePool,
        context,
        inventoryIds.queryIds.onHand,
        earlyEffectiveHorizon,
      );
      assert.deepEqual(historicalAnchor.temporal_horizons, {
        [inventoryIds.queryParameterIds.onHandAtTime]: earlyEffectiveHorizon,
        [inventoryIds.queryParameterIds.onHandRecordedAtHorizon]:
          firstRecordedHorizon,
      });

      observations.length = 0;
      const cachedHistorical = await invokeOnHand(
        gateway,
        view,
        sameKeyAppendArguments,
      );
      assertAggregateValue(cachedHistorical, '5');
      assert.deepEqual(
        observations.map((entry) => entry.kind),
        ['cache-hit'],
        'deleting the consistent-anchor return in executeAggregateQuery makes this observe a ledger recomputation',
      );
      assert.equal(observations[0]?.cacheKey, historicalAnchor.cache_key);

      await seedMovement(runtimePool, context, binding, {
        effectiveAt: '2026-01-20T00:00:00.000Z',
        ordinal: 4,
        quantity: '2',
        recordedAt: '2026-01-21T00:00:00.000Z',
      });
      observations.length = 0;
      const correctedHistorical = await invokeOnHand(
        gateway,
        view,
        sameKeyAppendArguments,
      );
      assertAggregateValue(
        correctedHistorical,
        '7',
        'the identical request after an in-horizon append must not return its intact stale anchor',
      );
      assert.deepEqual(
        observations.map((entry) => entry.kind),
        ['ledger-recomputation'],
        'the append must invalidate the prior anchor instead of preserving a cache hit',
      );
      const correctedAnchor = await readOnlyAnchor(
        runtimePool,
        context,
        inventoryIds.queryIds.onHand,
        earlyEffectiveHorizon,
        firstRecordedHorizon,
      );
      assert.equal(
        BigInt(correctedAnchor.movement_generation),
        BigInt(historicalAnchor.movement_generation) + 1n,
        'one movement append must advance the generation exactly once',
      );
      assert.notEqual(
        correctedAnchor.cache_key,
        historicalAnchor.cache_key,
        'the stable request identity must resolve under the newly posted movement generation',
      );
      assert.equal(observations[0]?.cacheKey, correctedAnchor.cache_key);
      assert.equal(
        await independentLedgerSum(database.pool, binding, {
          atTime: earlyEffectiveHorizon,
          includeArchived: false,
          recordedAtHorizon: firstRecordedHorizon,
        }),
        '7',
        'the independent ledger oracle must observe the appended correction inside both unchanged horizons',
      );

      observations.length = 0;
      const cachedCorrection = await invokeOnHand(
        gateway,
        view,
        sameKeyAppendArguments,
      );
      assertAggregateValue(cachedCorrection, '7');
      assert.deepEqual(
        observations.map((entry) => entry.kind),
        ['cache-hit'],
        'a genuinely repeated query after invalidation must still hit the cache',
      );
      assert.equal(observations[0]?.cacheKey, correctedAnchor.cache_key);

      const rollbackMarker = new Error('ROLLBACK_GENERATION_CONTROL');
      await assert.rejects(
        withModuleRole(runtimePool, context, async (client) => {
          await insertMovement(client, binding, {
            effectiveAt: '2026-01-25T00:00:00.000Z',
            ordinal: 6,
            quantity: '1000',
            recordedAt: '2026-01-26T00:00:00.000Z',
          });
          assert.equal(
            BigInt(await readMovementGenerationOnClient(client)),
            BigInt(correctedAnchor.movement_generation) + 1n,
            'the trigger must advance the generation inside the movement transaction',
          );
          throw rollbackMarker;
        }),
        (error: unknown) => error === rollbackMarker,
      );
      assert.equal(
        await readMovementGeneration(runtimePool, context),
        correctedAnchor.movement_generation,
        'rolling back the movement must roll back its generation advance',
      );
      assert.equal(
        await independentLedgerSum(database.pool, binding, {
          atTime: earlyEffectiveHorizon,
          includeArchived: false,
          recordedAtHorizon: firstRecordedHorizon,
        }),
        '7',
        'the rolled-back movement and its generation must remain jointly invisible',
      );

      const current = await invokeOnHand(
        gateway,
        view,
        onHandArguments(lateEffectiveHorizon, firstRecordedHorizon),
      );
      assertAggregateValue(current, '10');
      assert.notDeepEqual(current.value.value, historical.value.value);
      assert.equal(
        await independentLedgerSum(database.pool, binding, {
          atTime: lateEffectiveHorizon,
          includeArchived: true,
          recordedAtHorizon: firstRecordedHorizon,
        }),
        '110',
        'removing the provider archive predicate would return the independently observed wrong balance',
      );

      const policyContribution = mismatchedItemPolicyContribution(view);
      const policyNarrowing: QueryPolicyNarrowingGateway = {
        async narrow() {
          return policyContribution;
        },
      };
      const narrowed = await invokeOnHand(
        new SemanticQueryGateway(
          policy,
          new PostgresModuleRuntimeInterpreter(runtimePool, actorIssuer()),
          undefined,
          policyNarrowing,
        ),
        view,
        onHandArguments(lateEffectiveHorizon, firstRecordedHorizon),
      );
      assertAggregateValue(narrowed, '0');
      const withoutPolicy = await invokeOnHand(
        gateway,
        view,
        onHandArguments(lateEffectiveHorizon, firstRecordedHorizon),
      );
      assertAggregateValue(withoutPolicy, '10');

      await seedMovement(runtimePool, context, binding, {
        effectiveAt: '2026-01-20T00:00:00.000Z',
        ordinal: 5,
        quantity: '2',
        recordedAt: '2026-07-01T00:00:00.000Z',
      });
      const unchangedBelief = await invokeOnHand(
        gateway,
        view,
        onHandArguments(earlyEffectiveHorizon, firstRecordedHorizon),
      );
      assertAggregateValue(unchangedBelief, '7');
      const revisedHistory = await invokeOnHand(
        gateway,
        view,
        onHandArguments(earlyEffectiveHorizon, secondRecordedHorizon),
      );
      assertAggregateValue(revisedHistory, '9');

      const independent = await independentLedgerSum(database.pool, binding, {
        atTime: earlyEffectiveHorizon,
        includeArchived: false,
        recordedAtHorizon: secondRecordedHorizon,
      });
      assert.equal(independent, revisedHistory.value.value);

      const revisedAnchor = await readOnlyAnchor(
        runtimePool,
        context,
        inventoryIds.queryIds.onHand,
        earlyEffectiveHorizon,
        secondRecordedHorizon,
      );
      await corruptAnchor(database.pool, revisedAnchor.cache_key, '999');
      observations.length = 0;
      const afterCorruption = await invokeOnHand(
        gateway,
        view,
        onHandArguments(earlyEffectiveHorizon, secondRecordedHorizon),
      );
      assertAggregateValue(afterCorruption, independent);
      assert.deepEqual(
        observations.map((entry) => entry.kind),
        ['ledger-recomputation', 'anchor-discrepancy'],
      );
      const preserved = await database.pool.query<{
        balance_value: string;
      }>(
        `SELECT balance_value
           FROM north_star_internal.semantic_aggregate_anchors
          WHERE tenant_id = $1 AND environment_id = $2 AND cache_key = $3`,
        [tenantId, environmentId, revisedAnchor.cache_key],
      );
      assert.equal(preserved.rows[0]?.balance_value, '999');
      const discrepancies = await database.pool.query<{
        cached_balance_value: string;
        recomputed_balance_value: string;
      }>(
        `SELECT cached_balance_value, recomputed_balance_value
           FROM north_star_internal.semantic_aggregate_anchor_discrepancies
          WHERE tenant_id = $1 AND environment_id = $2 AND cache_key = $3`,
        [tenantId, environmentId, revisedAnchor.cache_key],
      );
      assert.deepEqual(discrepancies.rows, [
        {
          cached_balance_value: '999',
          recomputed_balance_value: independent,
        },
      ]);
    } finally {
      await Promise.all([
        runtimePool.end(),
        materializerPool.end(),
        modulePool.end(),
      ]);
    }
  });
});

test(
  'release verification executes a scoped aggregate probe and records the typed omission refusal',
  {
    skip: 'BLOCKED(ver-agg): compiler.ts filters aggregates before building the authoritative verification plan',
  },
  async () => {
    const fixture = buildVerificationFixture();
    await withEphemeralPostgres(
      'inventory-onhand-verification',
      async (database) => {
        await migrateAndProvision(database.pool, fixture.inventory.releaseRoot);
        const runtimePool = new pg.Pool({
          ...database.connection,
          max: 2,
          user: 'north_star_runtime',
        });
        try {
          const context = await trustedContext();
          const releases = await persistSequence(runtimePool, context, [
            [fixture.empty, fixture.emptyDefinition],
            [fixture.inventory, fixture.inventoryDefinition],
          ]);
          await setPointer(database.pool, releases[0]!.releaseId);
          await grantExecutorAuthority(database.pool);
          const materializerPool = new pg.Pool({
            ...database.connection,
            max: 1,
            user: 'north_star_module_materializer',
          });
          const modulePool = new pg.Pool({
            ...database.connection,
            max: 1,
            user: 'north_star_module_runtime',
          });
          try {
            const prepared = await new PostgresModuleStorageMaterializer(
              materializerPool,
              modulePool,
            ).prepare({
              context,
              expiresAt: '2099-01-01T00:00:00.000Z',
              generationId: randomUUID(),
              initiatedBy: principalId,
              preparationId: randomUUID(),
              targetReleaseId: releases[1]!.releaseId,
            });
            assert.equal(prepared.schemaState, 'APPLIED');
            await setPointer(database.pool, releases[1]!.releaseId);
            const verification = new PostgresReleaseVerificationService(
              runtimePool,
            );
            const command = {
              compiledRelease: fixture.inventory,
              evidenceId: releases[1]!.command.verificationEvidenceId,
              releaseId: releases[1]!.releaseId,
            };
            const results =
              await verification.executeSemanticCandidateAndPersist(
                context,
                command,
              );
            const plan = releaseVerificationBinding(fixture.inventory).plan;
            const scopeScenario = plan.scenarios.find(
              (scenario) =>
                scenario.assertionId === verificationScopeAssertionId,
            );
            assert.ok(scopeScenario);
            const invocation = scopeScenario.invocation;
            assert.ok(isRecord(invocation));
            assert.ok(isRecord(invocation.query));
            const scopeResult = results.results.find(
              (result) => result.scenarioId === scopeScenario.scenarioId,
            );
            assert.ok(scopeResult);
            const expectedProbe = {
              kind: 'legalEntityScopeOmissionRefusal',
              queryId: invocation.query.targetId,
              reason: 'selection-omitted',
              schemaVersion:
                'northstar.release-verification-query-scope-probe/v1',
            };
            assert.equal(
              scopeResult.positiveProbeDigest,
              verificationProofDigest(expectedProbe),
            );
            const durable = await verification.read(
              context,
              command.evidenceId,
              fixture.inventory,
            );
            assert.ok(durable);
            assert.equal(
              durable.results.find(
                (result) => result.scenarioId === scopeScenario.scenarioId,
              )?.positiveProbeDigest,
              verificationProofDigest(expectedProbe),
            );
          } finally {
            await Promise.all([materializerPool.end(), modulePool.end()]);
          }
        } finally {
          await runtimePool.end();
        }
      },
    );
  },
);

interface MutableAggregateCatalogQuery {
  aggregate: {
    resultType: Record<string, unknown> & {
      baseUnit?: Record<string, unknown>;
      kind: string;
      schemaVersion: string;
    };
  };
  aggregatePlan: {
    sourceFieldType: Record<string, unknown> & {
      baseUnit?: Record<string, unknown>;
      kind: string;
      schemaVersion: string;
    };
  };
  filterPlan: { root: unknown };
  queryId: string;
}

interface MutableComparison {
  sourceFieldType: { schemaVersion: string };
  value: { schemaVersion: string };
}

function firstComparison(value: unknown): MutableComparison {
  assert.ok(isRecord(value));
  if (value.kind === 'fieldComparisonPredicate') {
    assert.ok(isRecord(value.sourceFieldType));
    assert.ok(isRecord(value.value));
    return value as unknown as MutableComparison;
  }
  assert.ok(Array.isArray(value.terms));
  return firstComparison(value.terms[0]);
}

function requiredMutableOnHand(payload: Record<string, unknown>) {
  assert.ok(Array.isArray(payload.queries));
  const query = payload.queries.find(
    (candidate) =>
      isRecord(candidate) && candidate.queryId === inventoryIds.queryIds.onHand,
  );
  assert.ok(query);
  return query as unknown as MutableAggregateCatalogQuery;
}

function aggregateExecutor(observe: () => void): SemanticQueryExecutor {
  return {
    async execute() {
      throw new Error('record executor must not receive onHand');
    },
    async executeAggregate(request) {
      observe();
      return {
        kind: 'semanticAggregateResult',
        outcome: 'exact',
        queryId: request.definition.queryId,
        schemaVersion: SEMANTIC_AGGREGATE_RESULT_VERSION,
        value: {
          kind: 'exactDecimalResult',
          precision: 38,
          scale: Number(request.definition.aggregate.resultType.scale),
          selectionId: request.definition.aggregate.selectionId,
          value: '0',
        },
      };
    },
  };
}

function buildFixture(
  options: {
    readonly removeOnHandScope?: boolean;
  } = {},
): Fixture {
  const inventoryDefinition = inventoryDefinitionForTest(options);
  const emptyDefinition = emptyDefinitionFrom(inventoryDefinition);
  const empty = mustCompile(moduleInput(emptyDefinition));
  const inventory = mustCompile(
    moduleInput(inventoryDefinition, expectedActiveReleaseFrom(empty)),
  );
  return {
    empty,
    emptyDefinition,
    inventory,
    inventoryDefinition,
    storage: projectionPayload<StorageTargetPayloadV1>(
      inventory,
      PROJECTION_FAMILY_IDS.storageTarget,
    ).payload,
  };
}

function buildVerificationFixture(): Fixture {
  const inventoryDefinition = verificationDefinitionForTest();
  const emptyDefinition = emptyDefinitionFrom(inventoryDefinition);
  const empty = mustCompile(moduleInput(emptyDefinition));
  const inventory = mustCompile(
    moduleInput(inventoryDefinition, expectedActiveReleaseFrom(empty)),
  );
  return {
    empty,
    emptyDefinition,
    inventory,
    inventoryDefinition,
    storage: projectionPayload<StorageTargetPayloadV1>(
      inventory,
      PROJECTION_FAMILY_IDS.storageTarget,
    ).payload,
  };
}

function verificationDefinitionForTest(): Record<string, unknown> {
  const definition = structuredClone(
    partyModuleDefinition(APPLICATION_NAMESPACE),
  );
  const inventory = inventoryModuleDefinition(APPLICATION_NAMESPACE);
  const partyEntityId = `${APPLICATION_NAMESPACE}:entity.party`;
  const partyModuleId = `${APPLICATION_NAMESPACE}:module.party`;
  const partyPermissionId = `${APPLICATION_NAMESPACE}:permission.party_read`;
  const probeFieldId = `${APPLICATION_NAMESPACE}:field.party_verification_quantity`;
  const probeParameterId = `${APPLICATION_NAMESPACE}:parameter.party_verification_legal_entity_id`;
  const probeQueryId = `${APPLICATION_NAMESPACE}:query.party_verification_scoped_sum`;
  const probeSelectionId = `${APPLICATION_NAMESPACE}:selection.party_verification_scoped_sum`;

  assert.ok(Array.isArray(definition.entities));
  definition.entities = definition.entities.filter(
    (entity) => isRecord(entity) && entity.entityId === partyEntityId,
  );
  assert.ok(Array.isArray(definition.fields));
  definition.fields = definition.fields.filter(
    (candidate) =>
      isRecord(candidate) &&
      isRecord(candidate.entity) &&
      candidate.entity.targetId === partyEntityId,
  );
  assert.ok(Array.isArray(definition.operations));
  definition.operations = definition.operations.filter(
    (operation) =>
      isRecord(operation) &&
      isRecord(operation.effect) &&
      isRecord(operation.effect.entity) &&
      operation.effect.entity.targetId === partyEntityId,
  );
  assert.ok(Array.isArray(definition.permissions));
  definition.permissions = definition.permissions.filter(
    (permission) =>
      isRecord(permission) &&
      isRecord(permission.resource) &&
      permission.resource.targetId === partyEntityId,
  );
  assert.ok(Array.isArray(definition.queries));
  definition.queries = definition.queries.filter(
    (query) =>
      isRecord(query) &&
      isRecord(query.sourceEntity) &&
      query.sourceEntity.targetId === partyEntityId,
  );
  definition.relations = [];
  assert.ok(Array.isArray(definition.storageMappings));
  definition.storageMappings = definition.storageMappings.filter(
    (mapping) =>
      isRecord(mapping) &&
      isRecord(mapping.entity) &&
      mapping.entity.targetId === partyEntityId,
  );
  const partySurfaceIds = new Set([
    `${APPLICATION_NAMESPACE}:surface.party_detail`,
    `${APPLICATION_NAMESPACE}:surface.party_form`,
    `${APPLICATION_NAMESPACE}:surface.party_list`,
  ]);
  assert.ok(Array.isArray(definition.surfaces));
  definition.surfaces = definition.surfaces.filter(
    (surface) =>
      isRecord(surface) &&
      typeof surface.surfaceId === 'string' &&
      partySurfaceIds.has(surface.surfaceId),
  );
  assert.ok(Array.isArray(definition.assertions));
  definition.assertions = definition.assertions.filter(
    (assertion) =>
      isRecord(assertion) &&
      assertion.assertionId ===
        `${APPLICATION_NAMESPACE}:assertion.party_walking_slice`,
  );

  assert.ok(Array.isArray(inventory.fields));
  const quantityField = structuredClone(
    inventory.fields.find(
      (candidate) =>
        isRecord(candidate) &&
        candidate.fieldId ===
          `${APPLICATION_NAMESPACE}:field.inventory_movement_quantity_delta`,
    ),
  );
  assert.ok(isRecord(quantityField));
  assert.ok(isRecord(quantityField.entity));
  quantityField.entity.targetId = partyEntityId;
  quantityField.fieldId = probeFieldId;
  quantityField.label = 'Verification quantity';
  quantityField.orderKey = 40;
  quantityField.searchable = true;
  (definition.fields as unknown[]).push(quantityField);

  assert.ok(Array.isArray(inventory.queries));
  const aggregate = structuredClone(
    inventory.queries.find(
      (query) =>
        isRecord(query) && query.queryId === inventoryIds.queryIds.onHand,
    ),
  );
  assert.ok(isRecord(aggregate));
  assert.ok(isRecord(aggregate.aggregate));
  assert.ok(isRecord(aggregate.aggregate.field));
  assert.ok(isRecord(aggregate.module));
  assert.ok(isRecord(aggregate.permission));
  assert.ok(isRecord(aggregate.sourceEntity));
  assert.ok(isRecord(aggregate.legalEntityScope));
  assert.ok(isRecord(aggregate.legalEntityScope.operand));
  aggregate.aggregate.field.targetId = probeFieldId;
  aggregate.aggregate.selectionId = probeSelectionId;
  aggregate.filter = {
    kind: 'booleanPredicate',
    schemaVersion: 'v4',
    value: true,
  };
  aggregate.legalEntityScope.operand.parameterId = probeParameterId;
  aggregate.maximumResultCount = 1;
  aggregate.module.targetId = partyModuleId;
  aggregate.parameters = [
    {
      kind: 'queryParameterDefinition',
      orderKey: 10,
      parameterId: probeParameterId,
      schemaVersion: 'v4',
    },
  ];
  aggregate.permission.targetId = partyPermissionId;
  aggregate.queryId = probeQueryId;
  aggregate.sourceEntity.targetId = partyEntityId;
  (definition.queries as unknown[]).push(aggregate);

  const [partyAssertion] = definition.assertions as unknown[];
  assert.ok(isRecord(partyAssertion));
  const scopeAssertion = structuredClone(partyAssertion);
  assert.ok(isRecord(scopeAssertion));
  assert.ok(isRecord(scopeAssertion.invocation));
  assert.ok(isRecord(scopeAssertion.invocation.query));
  scopeAssertion.assertionId = verificationScopeAssertionId;
  scopeAssertion.evidenceKinds = ['provider'];
  scopeAssertion.invocation.query.targetId = probeQueryId;
  (definition.assertions as unknown[]).push(scopeAssertion);
  adoptCanonicalLanguageV4(definition);
  definition.languageVersion = 'v4';
  definition.normalizationProfileVersion = 'northstar.normalization/v4';
  return definition;
}

function inventoryDefinitionForTest(options: {
  readonly removeOnHandScope?: boolean;
}): Record<string, unknown> {
  const definition = structuredClone(composedApplicationDefinition());
  const inventory = inventoryModuleDefinition(APPLICATION_NAMESPACE);
  adoptCanonicalLanguageV4(definition);
  definition.languageVersion = 'v4';
  definition.normalizationProfileVersion = 'northstar.normalization/v4';
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
  ]) {
    assert.ok(Array.isArray(definition[collection]));
    assert.ok(Array.isArray(inventory[collection]));
    definition[collection] = [
      ...(definition[collection] as unknown[]),
      ...(inventory[collection] as unknown[]),
    ];
  }
  assert.ok(Array.isArray(definition.modules));
  assert.ok(Array.isArray(inventory.modules));
  assert.ok(isRecord(inventory.modules[0]));
  assert.ok(isRecord(definition.package));
  definition.modules.push({
    ...inventory.modules[0],
    orderKey: 40,
    ownerPackageId: definition.package.packageId,
  });
  assert.ok(Array.isArray(definition.queries));
  const onHand = definition.queries.find(
    (query) =>
      isRecord(query) && query.queryId === inventoryIds.queryIds.onHand,
  );
  assert.ok(isRecord(onHand));
  if (options.removeOnHandScope) {
    delete onHand.legalEntityScope;
    assert.ok(Array.isArray(onHand.parameters));
    onHand.parameters = onHand.parameters.filter(
      (parameter) =>
        !isRecord(parameter) ||
        parameter.parameterId !==
          inventoryIds.queryParameterIds.onHandLegalEntityId,
    );
  }
  return definition;
}

function adoptCanonicalLanguageV4(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) adoptCanonicalLanguageV4(entry);
    return;
  }
  if (!isRecord(value)) return;
  if (value.schemaVersion === 'v3') value.schemaVersion = 'v4';
  for (const child of Object.values(value)) adoptCanonicalLanguageV4(child);
}

function emptyDefinitionFrom(
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
    profile: {
      ...MODULE_COMPILER_PROFILE,
      // Canonical language v4; unrelated to Inventory dependency-set v4.
      languageVersion: 'v4',
      normalizationProfileVersion: 'northstar.normalization/v4',
    },
  };
}

function mustCompile(input: CompilerInput): CompileSuccess {
  const result = compileApplication(input);
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function projectionPayload<T>(
  compiled: CompileSuccess,
  familyId: string,
): { contentHash: string; payload: T } {
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
  return {
    contentHash: chunk.contentHash,
    payload: JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T,
  };
}

function runtimeProjection<TFamily extends RequestRuntimeProjectionFamily>(
  compiled: CompileSuccess,
  familyId: TFamily,
): RuntimeProjection<TFamily> {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  const payload = projectionPayload<unknown>(compiled, familyId);
  return {
    artifactRoot: reference.artifactRoot,
    familyId,
    instanceId: reference.instanceId,
    payload: payload.payload as never,
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  } as RuntimeProjection<TFamily>;
}

async function issuedCompiledView(
  compiled: CompileSuccess,
  policy: CurrentPolicyGateway,
  mutateQueryPayload?: (payload: Record<string, unknown>) => void,
): Promise<RequestRuntimeView> {
  const identity: AuthenticatedIdentity = {
    environmentId,
    principalId,
    tenantId,
  };
  const query = runtimeProjection(
    compiled,
    REQUEST_RUNTIME_PROJECTION_FAMILIES.query,
  );
  const queryPayload = structuredClone(query.payload) as Record<
    string,
    unknown
  >;
  mutateQueryPayload?.(queryPayload);
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => identity),
    {
      async load(): Promise<LoadedRequestRuntimeDefinition> {
        return {
          environmentId,
          pointer: { fence: 1, pointerId: randomUUID() },
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
            query: { ...query, payload: queryPayload as never },
            surface: runtimeProjection(
              compiled,
              REQUEST_RUNTIME_PROJECTION_FAMILIES.surface,
            ),
          },
          release: {
            contentHash: compiled.releaseRoot,
            releaseId: randomUUID(),
          },
          tenantId,
        };
      },
    },
    policy,
  );
  return entry.run({}, async (view) => view);
}

function onHandArguments(
  atTime: string,
  recordedAtHorizon: string,
  selectedItemId: string = itemId,
): Record<string, unknown> {
  return {
    [inventoryIds.queryParameterIds.onHandAtTime]: atTime,
    [inventoryIds.queryParameterIds.onHandItemId]: selectedItemId,
    [inventoryIds.queryParameterIds.onHandLegalEntityId]: legalEntityId,
    [inventoryIds.queryParameterIds.onHandLocationId]: locationId,
    [inventoryIds.queryParameterIds.onHandRecordedAtHorizon]: recordedAtHorizon,
  };
}

function invokeOnHand(
  gateway: SemanticQueryGateway,
  view: RequestRuntimeView,
  arguments_: Record<string, unknown>,
): Promise<SemanticAggregateResultEnvelope> {
  return gateway.invokeAggregate(view, {
    arguments: arguments_,
    queryId: inventoryIds.queryIds.onHand,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
}

function assertAggregateValue(
  result: SemanticAggregateResultEnvelope,
  expected: string,
  message?: string,
): void {
  assert.equal(result.kind, 'semanticAggregateResult');
  assert.equal(result.outcome, 'exact');
  assert.equal(result.value.kind, 'exactDecimalResult');
  assert.equal(result.value.value, expected, message);
}

class AllowPolicy implements CurrentPolicyGateway {
  readonly calls: CurrentPolicyDecisionRequest[] = [];

  async authorize(request: CurrentPolicyDecisionRequest) {
    this.calls.push(request);
    return {
      decision: 'ALLOW' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'inventory-onhand-policy/v1',
    };
  }

  async readCurrentVersion(_subject: CurrentPolicySubject) {
    void _subject;
    return { policyVersion: 'inventory-onhand-policy/v1' };
  }
}

async function migrateAndProvision(
  pool: Pool,
  contractReleaseRoot: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await runMigrations(client, await loadMigrations(migrations));
    await client.query(
      'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
      [tenantId, 'inventory-onhand'],
    );
    await client.query(
      `INSERT INTO platform.environments (tenant_id, id, slug)
       VALUES ($1,$2,'production')`,
      [tenantId, environmentId],
    );
    await client.query(
      `SELECT platform.provision_inventory_scope(
         $1,$2,$3,'LE-OH','On-hand legal entity','UTC','00:00:00',$4,
         1::smallint,'reject',0,'codeAndNarrative','codeOnly',
         'codeAndNarrative','codeAndNarrative','codeAndNarrative',
         NULL,NULL,NULL,NULL,NULL
       )`,
      [tenantId, environmentId, legalEntityId, contractReleaseRoot],
    );
  } finally {
    client.release();
  }
}

async function trustedContext(): Promise<TrustedRequestContext> {
  const identity: AuthenticatedIdentity = {
    environmentId,
    principalId,
    tenantId,
  };
  return new AuthenticatedRequestEntryAdapter(async () => identity).enter({
    headers: { authorization: 'inventory-onhand' },
  });
}

async function persistSequence(
  runtimePool: Pool,
  context: TrustedRequestContext,
  entries: ReadonlyArray<readonly [CompileSuccess, Record<string, unknown>]>,
): Promise<StagedRelease[]> {
  const repository = new PostgresImmutableReleaseRepository(runtimePool);
  const releases: StagedRelease[] = [];
  for (const [compiled, definition] of entries) {
    const revisionId = randomUUID() as MintedUuid;
    const releaseId = randomUUID() as MintedUuid;
    const desiredState = definitionBytes(definition);
    await repository.storeAppPackageRevision(
      context,
      revisionCommand(context, revisionId, desiredState),
    );
    const staged = await repository.stageTenantReleaseCandidate(context, {
      appPackageRevisionId: revisionId,
      compiledRelease: compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId,
      tenantId: context.tenantId,
    });
    const command = releaseCommand(
      context,
      releaseId,
      revisionId,
      staged.verificationEvidenceId,
      compiled,
    );
    releases.push({ command, releaseId });
    if (releaseVerificationBinding(compiled).plan.scenarios.length === 0) {
      await new PostgresReleaseVerificationService(
        runtimePool,
      ).executeSemanticCandidateAndPersist(context, {
        compiledRelease: compiled,
        evidenceId: staged.verificationEvidenceId,
        releaseId,
      });
      await repository.registerTenantRelease(context, command);
    }
  }
  return releases;
}

function revisionCommand(
  context: TrustedRequestContext,
  revisionId: MintedUuid,
  desiredState: Uint8Array,
): StoreAppPackageRevisionCommand {
  const normalized = parseNormalizedApplicationPackageJson(desiredState);
  const digest = canonicalizeAndHash(normalized);
  return {
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    contentHash: digest.contentHash,
    createdBy: context.principalId,
    desiredState,
    hashAlgorithm: CONTENT_HASH_ALGORITHM,
    languageVersion: normalized.languageVersion,
    normalizationProfileVersion: normalized.normalizationProfileVersion,
    parentRevisionId: null,
    provenance: 'firstParty',
    revisionId,
    schemaVersion: normalized.schemaVersion,
    tenantId: context.tenantId,
  };
}

function releaseCommand(
  context: TrustedRequestContext,
  releaseId: MintedUuid,
  revisionId: MintedUuid,
  evidenceId: MintedUuid,
  compiledRelease: CompileSuccess,
): RegisterTenantReleaseCommand<CompileSuccess> {
  return {
    appPackageRevisionId: revisionId,
    compiledRelease,
    createdBy: context.principalId,
    environmentId: context.environmentId,
    releaseId,
    tenantId: context.tenantId,
    verificationEvidenceId: evidenceId,
  };
}

async function setPointer(pool: Pool, releaseId: MintedUuid): Promise<void> {
  await pool.query(
    'ALTER TABLE platform.active_release_pointers DISABLE TRIGGER active_release_pointer_exact_swap',
  );
  try {
    const result = await pool.query(
      `UPDATE platform.active_release_pointers SET release_id=$3, fence=fence+1
        WHERE tenant_id=$1 AND environment_id=$2`,
      [tenantId, environmentId, releaseId],
    );
    assert.equal(result.rowCount, 1);
  } finally {
    await pool.query(
      'ALTER TABLE platform.active_release_pointers ENABLE TRIGGER active_release_pointer_exact_swap',
    );
  }
}

async function grantExecutorAuthority(pool: Pool): Promise<void> {
  await pool.query(
    'SELECT platform.set_release_executor_authority($1,$2,true,$2,$3)',
    [tenantId, principalId, randomUUID()],
  );
}

function runtimeEntry(
  pool: Pool,
  policy: CurrentPolicyGateway,
): AuthenticatedRequestRuntimeEntryAdapter {
  const identity: AuthenticatedIdentity = {
    environmentId,
    principalId,
    tenantId,
  };
  return new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => identity),
    new PostgresRequestRuntimeViewService(pool),
    policy,
  );
}

async function issuedView(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
): Promise<RequestRuntimeView> {
  return entry.run({}, async (view) => view);
}

function actorIssuer(): TrustedActorEnvelopeIssuer {
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

async function withModuleRole<T>(
  pool: Pool,
  context: TrustedRequestContext,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('lock_timeout',$1,true)", ['3s']);
    await client.query(
      `SELECT set_config('north_star.tenant_id',$1,true),
              set_config('north_star.environment_id',$2,true),
              set_config('north_star.principal_id',$3,true),
              set_config('north_star.request_id',$4,true)`,
      [
        context.tenantId,
        context.environmentId,
        context.principalId,
        context.requestId,
      ],
    );
    await client.query('SET LOCAL ROLE north_star_module_runtime');
    const value = await run(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedMovement(
  pool: Pool,
  context: TrustedRequestContext,
  binding: InventoryStorageBinding,
  input: MovementSeedInput,
): Promise<void> {
  await withModuleRole(pool, context, (client) =>
    insertMovement(client, binding, input),
  );
}

interface MovementSeedInput {
  readonly archived?: boolean;
  readonly effectiveAt: string;
  readonly ordinal: number;
  readonly quantity: string;
  readonly recordedAt: string;
}

async function insertMovement(
  client: PoolClient,
  binding: InventoryStorageBinding,
  input: MovementSeedInput,
): Promise<void> {
  const transactionId = stableId(10 + input.ordinal);
  const transactionLineId = stableId(30 + input.ordinal);
  const movementId = stableId(50 + input.ordinal);
  await insertEntity(
    client,
    binding,
    binding.transaction,
    {
      inventory_transaction_actor_id: principalId,
      inventory_transaction_effective_at: input.effectiveAt,
      inventory_transaction_number: `OH-TXN-${String(input.ordinal).padStart(3, '0')}`,
      inventory_transaction_reason_code: 'ON_HAND_TEST',
      inventory_transaction_reason_narrative: null,
      inventory_transaction_recorded_at: input.recordedAt,
      inventory_transaction_source_id: transactionId,
      inventory_transaction_source_type: 'onHandControl',
      inventory_transaction_state: enumOption(
        field(binding.transaction, 'inventory_transaction_state'),
        'posted',
      ),
      inventory_transaction_type: enumOption(
        field(binding.transaction, 'inventory_transaction_type'),
        'adjustment',
      ),
    },
    transactionId,
    legalEntityId,
    {},
  );
  await insertEntity(
    client,
    binding,
    binding.transactionLine,
    {
      inventory_transaction_line_from_location_id: null,
      inventory_transaction_line_item_id: itemId,
      inventory_transaction_line_line_number: input.ordinal,
      inventory_transaction_line_quantity: input.quantity,
      inventory_transaction_line_to_location_id: locationId,
      inventory_transaction_line_unit_id: 'EA',
    },
    transactionLineId,
    legalEntityId,
    { [binding.transaction.entity.entityId]: transactionId },
  );
  await insertEntity(
    client,
    binding,
    binding.movement,
    {
      inventory_movement_actor_id: principalId,
      inventory_movement_effective_at: input.effectiveAt,
      inventory_movement_item_id: itemId,
      inventory_movement_location_id: locationId,
      inventory_movement_posting_role: enumOption(
        field(binding.movement, 'inventory_movement_posting_role'),
        'adjustment',
      ),
      inventory_movement_quantity_delta: input.quantity,
      inventory_movement_reason_code: 'ON_HAND_TEST',
      inventory_movement_reason_narrative: null,
      inventory_movement_recorded_at: input.recordedAt,
      inventory_movement_reversal_of_movement_id: null,
      inventory_movement_source_id: transactionId,
      inventory_movement_source_line: String(input.ordinal),
      inventory_movement_source_revision: 1,
      inventory_movement_source_type: 'onHandControl',
      inventory_movement_stock_dimension_set_version: enumOption(
        field(
          binding.movement,
          'inventory_movement_stock_dimension_set_version',
        ),
        'v1',
      ),
      inventory_movement_unit_id: 'EA',
    },
    movementId,
    legalEntityId,
    {
      [binding.transaction.entity.entityId]: transactionId,
      [binding.transactionLine.entity.entityId]: transactionLineId,
    },
    input.effectiveAt.slice(0, 10),
    input.archived ? input.recordedAt : null,
  );
}

async function seedFoundation(
  pool: Pool,
  context: TrustedRequestContext,
  binding: InventoryStorageBinding,
): Promise<void> {
  await withModuleRole(pool, context, async (client) => {
    await insertEntity(
      client,
      binding,
      binding.item,
      {
        item_base_unit: 'EA',
        item_description: 'On-hand control item',
        item_name: 'On-hand control item',
        item_sku: 'OH-ITEM-001',
      },
      itemId,
      null,
      {},
    );
    await insertEntity(
      client,
      binding,
      binding.location,
      {
        location_code: 'OH-LOC-001',
        location_name: 'On-hand control location',
      },
      locationId,
      null,
      {},
    );
  });
}

async function corruptAnchor(
  administrativePool: Pool,
  cacheKey: string,
  balance: string,
): Promise<void> {
  const rule = 'semantic_aggregate_anchors_reject_update';
  await administrativePool.query(
    `ALTER TABLE north_star_internal.semantic_aggregate_anchors DISABLE RULE ${rule}`,
  );
  try {
    const updated = await administrativePool.query(
      `UPDATE north_star_internal.semantic_aggregate_anchors
          SET balance_value = $4
        WHERE tenant_id = $1 AND environment_id = $2 AND cache_key = $3`,
      [tenantId, environmentId, cacheKey, balance],
    );
    assert.equal(updated.rowCount, 1);
  } finally {
    await administrativePool.query(
      `ALTER TABLE north_star_internal.semantic_aggregate_anchors ENABLE RULE ${rule}`,
    );
  }
}

async function insertEntity(
  client: PoolClient,
  binding: InventoryStorageBinding,
  entity: EntityBinding,
  overrides: Record<string, unknown>,
  recordId: string,
  scopedLegalEntityId: string | null,
  relationIds: Record<string, string>,
  factBusinessPeriod: string | null = null,
  archivedAt: string | null = null,
): Promise<void> {
  const relationColumns = binding.storageTarget.relations.filter(
    (relation) =>
      relation.sourceEntityId === entity.entity.entityId &&
      relation.relationColumn.origin !== 'field',
  );
  const columns = [
    'tenant_id',
    'environment_id',
    ...(entity.legalEntityColumn ? [entity.legalEntityColumn] : []),
    ...(entity.entity.factStorage
      ? [entity.entity.factStorage.businessPeriod.column]
      : []),
    ...(archivedAt ? [entity.entity.archive.archivedAtColumn] : []),
    entity.recordIdColumn,
    ...entity.entity.columns.map((column) => column.physicalName),
    ...relationColumns.map((relation) => relation.relationColumn.physicalName),
  ];
  const values = [
    tenantId,
    environmentId,
    ...(entity.legalEntityColumn ? [scopedLegalEntityId] : []),
    ...(entity.entity.factStorage ? [factBusinessPeriod] : []),
    ...(archivedAt ? [archivedAt] : []),
    recordId,
    ...entity.entity.columns.map((column) =>
      Object.hasOwn(overrides, localField(column))
        ? overrides[localField(column)]
        : defaultFieldValue(column, recordId),
    ),
    ...relationColumns.map((relation) => {
      const value = relationIds[relation.targetEntityId];
      if (value) return value;
      assert.equal(
        relation.relationColumn.nullable,
        true,
        `missing required relation ${relation.relationId}`,
      );
      return null;
    }),
  ];
  await client.query(
    `INSERT INTO ${table(binding, entity)} (${columns.map(quoted).join(',')})
     VALUES (${values.map((_, index) => `$${String(index + 1)}`).join(',')})`,
    values,
  );
}

function storageBinding(
  target: StorageTargetPayloadV1,
): InventoryStorageBinding {
  const bind = (suffix: string): EntityBinding => {
    const entity = target.entities.find((candidate) =>
      candidate.entityId.endsWith(`:entity.${suffix}`),
    );
    assert.ok(entity, `missing ${suffix}`);
    return {
      entity,
      fields: new Map(
        entity.columns.map((column) => [localField(column), column]),
      ),
      legalEntityColumn: entity.legalEntity?.column ?? null,
      recordIdColumn: entity.recordIdentity.column,
    };
  };
  return {
    item: bind('item'),
    location: bind('location'),
    movement: bind('inventory_movement'),
    schemaName: target.providerAbi.managedSchema,
    storageTarget: target,
    transaction: bind('inventory_transaction'),
    transactionLine: bind('inventory_transaction_line'),
  };
}

function field(
  entity: EntityBinding,
  localId: string,
): StorageEntityTarget['columns'][number] {
  const value = entity.fields.get(localId);
  assert.ok(value, `missing field ${localId}`);
  return value;
}

function enumOption(
  column: StorageEntityTarget['columns'][number],
  suffix: string,
): string {
  const options = column.fieldContract.enumOptionIds.filter((option) =>
    option.endsWith(`_${suffix}`),
  );
  assert.equal(options.length, 1, `missing enum option ${suffix}`);
  return options[0]!;
}

function defaultFieldValue(
  column: StorageEntityTarget['columns'][number],
  recordId: string,
): unknown {
  if (!column.fieldContract.required) return null;
  switch (column.fieldContract.fieldKind) {
    case 'booleanFieldType':
      return false;
    case 'dateFieldType':
      return '2026-01-01';
    case 'dateTimeFieldType':
      return '2026-01-01T00:00:00.000Z';
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
      const maximum = column.fieldContract.bounds.maximumLength ?? 80;
      return `${localField(column)}-${recordId.slice(-8)}`.slice(0, maximum);
    }
    case 'timeFieldType':
      return '00:00:00';
  }
}

async function independentLedgerSum(
  pool: Pool,
  binding: InventoryStorageBinding,
  input: {
    readonly atTime: string;
    readonly includeArchived: boolean;
    readonly recordedAtHorizon: string;
  },
): Promise<string> {
  const quantity = field(
    binding.movement,
    'inventory_movement_quantity_delta',
  ).physicalName;
  const item = field(
    binding.movement,
    'inventory_movement_item_id',
  ).physicalName;
  const location = field(
    binding.movement,
    'inventory_movement_location_id',
  ).physicalName;
  const effective = field(
    binding.movement,
    'inventory_movement_effective_at',
  ).physicalName;
  const recorded = field(
    binding.movement,
    'inventory_movement_recorded_at',
  ).physicalName;
  assert.ok(binding.movement.legalEntityColumn);
  const result = await pool.query<{ balance: string }>(
    `SELECT COALESCE(SUM(${quoted(quantity)}), 0)::text AS balance
       FROM ${table(binding, binding.movement)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.movement.legalEntityColumn)} = $3
        AND ${quoted(item)} = $4
        AND ${quoted(location)} = $5
        AND ${quoted(effective)} <= $6
        AND ${quoted(recorded)} <= $7
        ${input.includeArchived ? '' : 'AND archived_at IS NULL'}`,
    [
      tenantId,
      environmentId,
      legalEntityId,
      itemId,
      locationId,
      input.atTime,
      input.recordedAtHorizon,
    ],
  );
  return normalizeDatabaseDecimal(result.rows[0]?.balance ?? '0');
}

async function readMovementGeneration(
  pool: Pool,
  context: TrustedRequestContext,
): Promise<string> {
  return withModuleRole(pool, context, readMovementGenerationOnClient);
}

async function readMovementGenerationOnClient(
  client: PoolClient,
): Promise<string> {
  const result = await client.query<{ movement_generation: string }>(
    `SELECT movement_generation::text AS movement_generation
       FROM north_star_internal.semantic_aggregate_generations
      WHERE tenant_id = $1 AND environment_id = $2`,
    [tenantId, environmentId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0]!.movement_generation;
}

async function readOnlyAnchor(
  pool: Pool,
  context: TrustedRequestContext,
  queryId: string,
  atTime: string,
  recordedAtHorizon?: string,
): Promise<{
  balance_value: string;
  cache_key: string;
  movement_generation: string;
  temporal_horizons: Record<string, unknown>;
}> {
  return withModuleRole(pool, context, async (client) => {
    const values: unknown[] = [tenantId, environmentId, queryId, atTime];
    const recordedPredicate = recordedAtHorizon
      ? `AND temporal_horizons ->> $6 = $7`
      : '';
    if (recordedAtHorizon) {
      values.push(
        inventoryIds.queryParameterIds.onHandRecordedAtHorizon,
        recordedAtHorizon,
      );
    }
    const result = await client.query<{
      balance_value: string;
      cache_key: string;
      movement_generation: string;
      temporal_horizons: Record<string, unknown>;
    }>(
      `SELECT balance_value,
              cache_key,
              movement_generation::text AS movement_generation,
              temporal_horizons
         FROM north_star_internal.semantic_aggregate_anchors
        WHERE tenant_id = $1 AND environment_id = $2 AND query_id = $3
          AND temporal_horizons ->> $4 = $5
          ${recordedPredicate}
        ORDER BY movement_generation DESC
        LIMIT 1`,
      [
        tenantId,
        environmentId,
        queryId,
        inventoryIds.queryParameterIds.onHandAtTime,
        atTime,
        ...values.slice(4),
      ],
    );
    assert.equal(result.rowCount, 1);
    return result.rows[0]!;
  });
}

function compiledAggregateQuery(
  view: RequestRuntimeView,
  queryId: string,
): RegisteredAggregateQueryDefinition & {
  readonly filter: Readonly<Record<string, unknown>>;
} {
  const payload = view.projections.query.payload as unknown as {
    queries: Array<Record<string, unknown>>;
  };
  const query = payload.queries.find(
    (candidate) => candidate.queryId === queryId,
  );
  assert.ok(query);
  return query as unknown as RegisteredAggregateQueryDefinition & {
    readonly filter: Readonly<Record<string, unknown>>;
  };
}

function mismatchedItemPolicyContribution(view: RequestRuntimeView): {
  readonly filter: Readonly<Record<string, unknown>>;
  readonly filterPlan: Readonly<Record<string, unknown>>;
} {
  const query = compiledAggregateQuery(view, inventoryIds.queryIds.onHand);
  const filter = structuredClone(query.filter);
  const filterPlan = structuredClone(query.filterPlan) as unknown as Record<
    string,
    unknown
  >;
  assert.ok(Array.isArray(filter.terms));
  const authoredComparison = filter.terms.find(
    (term) =>
      isRecord(term) &&
      isRecord(term.field) &&
      term.field.targetId ===
        inventoryIds.namespace + ':field.inventory_movement_item_id',
  );
  assert.ok(isRecord(authoredComparison));
  assert.ok(isRecord(authoredComparison.value));
  authoredComparison.value.parameterId =
    inventoryIds.queryParameterIds.onHandLocationId;
  assert.ok(isRecord(filterPlan.root));
  assert.ok(Array.isArray(filterPlan.root.terms));
  const loweredComparison = filterPlan.root.terms.find(
    (term) =>
      isRecord(term) &&
      term.fieldId ===
        inventoryIds.namespace + ':field.inventory_movement_item_id',
  );
  assert.ok(isRecord(loweredComparison));
  assert.ok(isRecord(loweredComparison.value));
  loweredComparison.value.parameterId =
    inventoryIds.queryParameterIds.onHandLocationId;
  filterPlan.predicateDigest = canonicalizeAndHash(filter).contentHash;
  return { filter, filterPlan };
}

function localField(column: StorageEntityTarget['columns'][number]): string {
  return column.canonicalFieldId.split(':field.').at(-1)!;
}

function table(
  binding: InventoryStorageBinding,
  entity: EntityBinding,
): string {
  return `${quoted(binding.schemaName)}.${quoted(entity.entity.physicalTableName)}`;
}

function quoted(identifier: string): string {
  assert.match(identifier, /^[a-z][a-z0-9_]{0,62}$/u);
  return `"${identifier}"`;
}

function stableId(ordinal: number): string {
  return `85000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
}

function verificationProofDigest(value: unknown): string {
  return createHash('sha256')
    .update('northstar.verification-proof/v1', 'utf8')
    .update(Uint8Array.of(0))
    .update(canonicalize(value), 'utf8')
    .digest('hex');
}

function normalizeDatabaseDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed === '-0' ? '0' : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
