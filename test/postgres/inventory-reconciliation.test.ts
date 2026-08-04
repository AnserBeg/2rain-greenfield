import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import { INVENTORY_CONTRACT_V1 } from '../../packages/domain/src/inventory/contracts.js';
import {
  INVENTORY_POSTING_CAPABILITY_VERSION,
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  PostgresInventoryPostingService,
  type InventoryAdjustmentPostingCommandV1,
  type InventoryPostingRegistrationV1,
  type InventoryTransferPostingCommandV1,
} from '../../packages/postgres-provider/src/inventory-posting-service.js';
import {
  INVENTORY_RECONCILIATION_REPORT_VERSION,
  InventoryReconciliationError,
  PostgresInventoryReconciliationService,
  renderInventoryReconciliationReport,
  selectAnchors,
  type InventoryReconciliationArmReportV1,
  type InventoryReconciliationObservationV1,
  type InventoryReconciliationRegistrationV1,
  type InventoryReconciliationReportV1,
} from '../../packages/postgres-provider/src/inventory-reconciliation-service.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import {
  aggregateGenerationLockKey,
  type AggregateCacheObservation,
  PostgresModuleRuntimeInterpreter,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
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
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryGateway,
  type SemanticAggregateResultEnvelope,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const migrationsDirectory = resolve('db/migrations');

const tenantA = '1a000000-0000-4000-8000-00000000000a';
const environmentA = '2a000000-0000-4000-8000-00000000000a';
const legalEntityA = '3a000000-0000-4000-8000-00000000000a';
const quietLegalEntityA = '3a000000-0000-4000-8000-00000000000b';
const witnessLegalEntityA = '3a000000-0000-4000-8000-00000000000c';
const principalA = '4a000000-0000-4000-8000-00000000000a';
const tenantB = '1b000000-0000-4000-8000-00000000000b';
const environmentB = '2b000000-0000-4000-8000-00000000000b';
const principalB = '4b000000-0000-4000-8000-00000000000b';

const itemPrimary = '5a000000-0000-4000-8000-000000000001';
const locationPrimary = '6a000000-0000-4000-8000-000000000001';
const locationSecondary = '6a000000-0000-4000-8000-000000000002';
const locationOrphan = '6a000000-0000-4000-8000-000000000003';

const effectiveAt = '2026-07-29T12:00:00.000Z';
const recordedAt = '2026-07-29T13:00:00.000Z';
const businessPeriod = '2026-07-29';
const horizon = '2026-12-31T00:00:00.000Z';

const plantedAnchorCacheKey = 'ab'.repeat(32);
const unrecognizedAnchorCacheKey = 'cd'.repeat(32);
const scopeDivergedAnchorCacheKey = '0a'.repeat(32);
const overflowingAnchorCacheKey = '1b'.repeat(32);
const partiallyCorruptAnchorCacheKey = '2c'.repeat(32);
const fullyCorruptAnchorCacheKey = '3d'.repeat(32);
const authorityLessAnchorCacheKey = '4e'.repeat(32);
const nestedScopeAnchorCacheKey = '5f'.repeat(32);
const plantedFilterPlanDigest = 'ef'.repeat(32);
const plantedReleaseContentHash = '12'.repeat(32);
const plantedAnchorDigest = '34'.repeat(32);
const unrecognizedQueryId = `${APPLICATION_NAMESPACE}:query.unreconciled-probe`;
const onHandSelectionId = `${APPLICATION_NAMESPACE}:selection.inventory_movement_on_hand`;

const reconciliationIds = Object.freeze({
  onHandQueryId: `${APPLICATION_NAMESPACE}:query.inventory_movement_on_hand`,
  parameterIds: Object.freeze({
    atTime: `${APPLICATION_NAMESPACE}:parameter.on_hand_at_time`,
    itemId: `${APPLICATION_NAMESPACE}:parameter.on_hand_item_id`,
    legalEntityId: `${APPLICATION_NAMESPACE}:parameter.on_hand_legal_entity_id`,
    locationId: `${APPLICATION_NAMESPACE}:parameter.on_hand_location_id`,
    recordedAtHorizon: `${APPLICATION_NAMESPACE}:parameter.on_hand_recorded_at_horizon`,
  }),
});

type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];

interface TestEntityBinding {
  readonly archiveColumn: string;
  readonly entity: StorageEntityTarget;
  readonly fields: ReadonlyMap<string, StorageEntityTarget['columns'][number]>;
  readonly legalEntityColumn: string | null;
  readonly recordIdColumn: string;
  readonly tableName: string;
}

interface TestStorageBinding {
  readonly item: TestEntityBinding;
  readonly legalEntity: TestEntityBinding;
  readonly location: TestEntityBinding;
  readonly movement: TestEntityBinding;
  readonly schemaName: string;
  readonly storageTarget: StorageTargetPayloadV1;
  readonly transaction: TestEntityBinding;
  readonly transactionLine: TestEntityBinding;
}

interface Fixture {
  readonly empty: CompileSuccess;
  readonly emptyDefinition: Record<string, unknown>;
  readonly inventory: CompileSuccess;
  readonly inventoryDefinition: Record<string, unknown>;
  readonly storage: StorageTargetPayloadV1;
  readonly storageContentHash: string;
}

interface TenantScope {
  readonly context: TrustedRequestContext;
  readonly environmentId: string;
  readonly legalEntityId: string;
  readonly tenantId: string;
}

interface StateSnapshot {
  readonly anchors: unknown[];
  readonly discrepancies: unknown[];
  readonly movements: unknown[];
  readonly transactionLines: unknown[];
}

test('reconciliation names divergence, confirms consistency, repairs nothing, and never reports a scope it cannot see as clean', async (t) => {
  const fixture = buildFixture();
  const binding = testStorageBinding(fixture.storage);
  await withEphemeralPostgres('inventory-reconcile', async (database) => {
    await migrateAndProvision(database.pool, fixture.inventory.releaseRoot);
    const runtimePool = new pg.Pool({
      ...database.connection,
      application_name: 'g3-r1-reconciliation',
      max: 6,
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
      const scopeA: TenantScope = {
        context: await trustedContext(tenantA, environmentA, principalA),
        environmentId: environmentA,
        legalEntityId: legalEntityA,
        tenantId: tenantA,
      };
      const scopeB: TenantScope = {
        context: await trustedContext(tenantB, environmentB, principalB),
        environmentId: environmentB,
        legalEntityId: legalEntityA,
        tenantId: tenantB,
      };

      const releases = await persistSequence(runtimePool, scopeA.context, [
        [fixture.empty, fixture.emptyDefinition],
        [fixture.inventory, fixture.inventoryDefinition],
      ]);
      await setPointer(database.pool, scopeA, releases[0]!);
      await grantExecutorAuthority(database.pool, scopeA);
      const prepared = await new PostgresModuleStorageMaterializer(
        materializerPool,
        modulePool,
      ).prepare({
        context: scopeA.context,
        expiresAt: '2099-01-01T00:00:00.000Z',
        generationId: randomUUID(),
        initiatedBy: principalA,
        preparationId: randomUUID(),
        targetReleaseId: releases[1]!,
      });
      assert.equal(prepared.schemaState, 'APPLIED');
      await setPointer(database.pool, scopeA, releases[1]!);
      await seedFoundation(runtimePool, scopeA, binding, {
        legalEntityIds: [legalEntityA, quietLegalEntityA, witnessLegalEntityA],
      });
      // Tenant B reuses tenant A's legal-entity identifier deliberately: it
      // makes the separation below a tenancy fact rather than an identifier
      // filter, because both scopes name the same legal entity.
      await seedFoundation(runtimePool, scopeB, binding, {
        legalEntityIds: [legalEntityA],
      });

      const registration: InventoryPostingRegistrationV1 = {
        capabilityId: INVENTORY_CONTRACT_V1.capabilityId,
        capabilityVersion: INVENTORY_POSTING_CAPABILITY_VERSION,
        dependencySetRoot: INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
        releaseContentHash: fixture.inventory.releaseRoot,
        releaseId: releases[1]!,
        storageTarget: fixture.storage,
        storageTargetContentHash: fixture.storageContentHash,
      };
      const postingService = new PostgresInventoryPostingService(
        runtimePool,
        registration,
        { currentInstant: () => recordedAt },
      );
      const actor = await actorEnvelope(scopeA.context, principalA);

      const reconciliationRegistration: InventoryReconciliationRegistrationV1 =
        {
          aggregateParameterIds: reconciliationIds.parameterIds,
          aggregateQueryId: reconciliationIds.onHandQueryId,
          storageTarget: fixture.storage,
        };
      const observations: InventoryReconciliationObservationV1[] = [];
      const reconciliation = new PostgresInventoryReconciliationService(
        runtimePool,
        reconciliationRegistration,
        (observation) => observations.push(observation),
      );

      // --- posted documents produced by the real posting capability ---------
      const consistentTransactionId = randomUUID();
      const consistentLineId = randomUUID();
      const divergentTransactionId = randomUUID();
      const divergentLineId = randomUUID();
      const transferTransactionId = randomUUID();
      const transferLineId = randomUUID();

      const consistentAdjustment = adjustmentCommand({
        lineId: consistentLineId,
        locationId: locationPrimary,
        quantityDelta: '5',
        sourceId: 'reconcile-consistent',
        transactionId: consistentTransactionId,
      });
      await seedAdjustmentDraft(
        runtimePool,
        scopeA,
        binding,
        consistentAdjustment,
      );
      await postingService.postAdjustment(
        scopeA.context,
        actor,
        consistentAdjustment,
      );

      const divergentAdjustment = adjustmentCommand({
        lineId: divergentLineId,
        locationId: locationPrimary,
        quantityDelta: '4',
        sourceId: 'reconcile-divergent',
        transactionId: divergentTransactionId,
      });
      await seedAdjustmentDraft(
        runtimePool,
        scopeA,
        binding,
        divergentAdjustment,
      );
      await postingService.postAdjustment(
        scopeA.context,
        actor,
        divergentAdjustment,
      );

      const transfer = transferCommand({
        lineId: transferLineId,
        quantity: '3',
        sourceId: 'reconcile-transfer',
        transactionId: transferTransactionId,
      });
      await seedTransferDraft(runtimePool, scopeA, binding, transfer);
      await postingService.postTransfer(scopeA.context, actor, transfer);

      // --- a real aggregate read, so one anchor exists that somebody read ---
      const cacheObservations: AggregateCacheObservation[] = [];
      const policy = new AllowPolicy();
      const view = await issuedView(runtimePool, scopeA, policy);
      const interpreter = new PostgresModuleRuntimeInterpreter(
        runtimePool,
        actorIssuer(principalA),
        [],
        (observation) => cacheObservations.push(observation),
      );
      const gateway = new SemanticQueryGateway(policy, interpreter);
      const readBalance = await invokeOnHand(gateway, view, {
        itemId: itemPrimary,
        legalEntityId: legalEntityA,
        locationId: locationPrimary,
      });
      assert.equal(readBalance.value.value, '6');
      const readAnchorKey = await onlyAnchorCacheKey(
        database.pool,
        scopeA,
        reconciliationIds.onHandQueryId,
      );

      await t.test(
        'a genuinely consistent scope is reported consistent, naming every witness',
        async () => {
          observations.length = 0;
          const report = await reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [legalEntityA],
            scopeId: 'consistent-scope',
          });
          assert.equal(
            report.schemaVersion,
            INVENTORY_RECONCILIATION_REPORT_VERSION,
          );
          assert.equal(report.outcome, 'consistent');
          assert.deepEqual(report.findings, []);
          const sourceDocuments = arm(report, 'sourceDocuments');
          assert.deepEqual(
            sourceDocuments.consistentSubjectIds.toSorted(),
            [consistentLineId, divergentLineId, transferLineId].toSorted(),
            'every posted line produced by the posting capability reconciles',
          );
          assert.equal(sourceDocuments.outcome, 'consistent');
          const anchors = arm(report, 'aggregateAnchors');
          assert.deepEqual(anchors.consistentSubjectIds, [readAnchorKey]);
          assert.equal(anchors.outcome, 'consistent');
          assert.equal(report.subjectCount, 4);
          assert.equal(
            observations.filter(
              (observation) => observation.kind === 'reconciled',
            ).length,
            1,
          );
        },
      );

      // --- plant the divergences -------------------------------------------
      const shadowMovementId = randomUUID();
      await seedShadowMovement(runtimePool, scopeA, binding, {
        legalEntityId: legalEntityA,
        locationId: locationPrimary,
        movementId: shadowMovementId,
        quantityDelta: '7',
        sourceId: 'reconcile-divergent',
        transactionId: divergentTransactionId,
        transactionLineId: divergentLineId,
      });
      const orphanTransactionId = randomUUID();
      const orphanLineId = randomUUID();
      const orphanMovementId = randomUUID();
      await seedUnpostedDocumentWithMovement(runtimePool, scopeA, binding, {
        legalEntityId: legalEntityA,
        locationId: locationOrphan,
        movementId: orphanMovementId,
        quantityDelta: '2',
        transactionId: orphanTransactionId,
        transactionLineId: orphanLineId,
      });
      await plantAnchor(runtimePool, scopeA, {
        balanceValue: '999',
        cacheKey: plantedAnchorCacheKey,
        itemId: itemPrimary,
        legalEntityId: legalEntityA,
        locationId: locationSecondary,
        principalId: principalA,
        queryId: reconciliationIds.onHandQueryId,
      });
      await plantAnchor(runtimePool, scopeA, {
        balanceValue: '17',
        cacheKey: unrecognizedAnchorCacheKey,
        itemId: itemPrimary,
        legalEntityId: legalEntityA,
        locationId: locationSecondary,
        principalId: principalA,
        queryId: unrecognizedQueryId,
      });

      let divergentReport: InventoryReconciliationReportV1 | undefined;
      let recordedDiscrepancyAnchorKey: string | undefined;
      const before = await snapshotState(database.pool, binding);

      await t.test(
        'a planted movement/source-document divergence is detected and named',
        async () => {
          observations.length = 0;
          divergentReport = await reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [legalEntityA],
            scopeId: 'divergent-scope',
          });
          assert.equal(divergentReport.outcome, 'discrepant');
          const sourceDocuments = arm(divergentReport, 'sourceDocuments');
          assert.equal(sourceDocuments.outcome, 'discrepant');
          const quantity = onlyFinding(
            divergentReport,
            'SOURCE_DOCUMENT_QUANTITY_DIVERGED',
          );
          assert.equal(quantity.subjectId, divergentLineId);
          assert.equal(quantity.declaredValue, '4');
          assert.equal(quantity.observedValue, '11');
          assert.equal(quantity.detail.transactionId, divergentTransactionId);
          assert.equal(quantity.detail.locationId, locationPrimary);
          assert.equal(quantity.detail.itemId, itemPrimary);
          const count = onlyFinding(
            divergentReport,
            'SOURCE_DOCUMENT_MOVEMENT_COUNT_DIVERGED',
          );
          assert.equal(count.subjectId, divergentLineId);
          assert.equal(count.declaredValue, '1');
          assert.equal(count.observedValue, '2');
          const orphan = onlyFinding(
            divergentReport,
            'SOURCE_DOCUMENT_MISSING_FOR_MOVEMENT',
          );
          assert.equal(orphan.subjectId, orphanMovementId);
          assert.equal(orphan.observedValue, '2');
          assert.deepEqual(
            sourceDocuments.discrepantSubjectIds.toSorted(),
            [divergentLineId, orphanMovementId].toSorted(),
          );
          assert.deepEqual(
            sourceDocuments.consistentSubjectIds.toSorted(),
            [consistentLineId, transferLineId].toSorted(),
            'the positive witness is bound to the same legal entity and the same run as the negative one',
          );
        },
      );

      await t.test(
        'the sweep detects an anchor nobody has ever read, and refuses to call an unreadable one clean',
        async () => {
          assert.ok(divergentReport);
          const anchors = arm(divergentReport, 'aggregateAnchors');
          assert.equal(anchors.outcome, 'discrepant');
          const diverged = onlyFinding(
            divergentReport,
            'AGGREGATE_ANCHOR_LEDGER_DIVERGED',
          );
          assert.equal(diverged.subjectId, plantedAnchorCacheKey);
          assert.equal(diverged.declaredValue, '999');
          assert.equal(diverged.observedValue, '3');
          assert.deepEqual(anchors.discrepantSubjectIds, [
            plantedAnchorCacheKey,
          ]);
          const unrecognized = onlyFinding(
            divergentReport,
            'AGGREGATE_ANCHOR_QUERY_UNRECOGNIZED',
          );
          assert.equal(unrecognized.subjectId, unrecognizedAnchorCacheKey);
          assert.equal(unrecognized.observedValue, null);
          assert.deepEqual(anchors.unverifiableSubjectIds, [
            unrecognizedAnchorCacheKey,
          ]);
          assert.equal(
            anchors.consistentSubjectIds.includes(unrecognizedAnchorCacheKey),
            false,
            'ADR-0044: an anchor the sweep cannot check is never counted as consistent',
          );
          assert.ok(
            anchors.excludedSubjects.length >= 1,
            'the read anchor is superseded by the planted movements and is named as excluded',
          );

          // The whole point of R1-b: no read reached these keys, and the
          // read-path guard therefore never fired on them.
          assert.equal(
            cacheObservations.some(
              (observation) =>
                observation.cacheKey === plantedAnchorCacheKey ||
                observation.cacheKey === unrecognizedAnchorCacheKey,
            ),
            false,
          );
          const recorded = await database.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM north_star_internal.semantic_aggregate_anchor_discrepancies
              WHERE cache_key = ANY($1::text[])`,
            [[plantedAnchorCacheKey, unrecognizedAnchorCacheKey]],
          );
          assert.equal(recorded.rows[0]?.count, '0');
        },
      );

      await t.test(
        'reconciliation repairs nothing: the bad anchor and the source document are unmodified',
        async () => {
          assert.ok(divergentReport);
          const after = await snapshotState(database.pool, binding);
          assert.deepEqual(after, before, 'reconciliation wrote nothing');
          assert.equal(divergentReport.repairedSubjectCount, 0);
          assert.equal(
            divergentReport.transactionReadOnly,
            'on',
            'deleting the read-only guard\'s refusal makes this observe "off"; deleting the SET LOCAL itself makes every reconcile refuse',
          );
          const anchor = await database.pool.query<{ balance_value: string }>(
            `SELECT balance_value
               FROM north_star_internal.semantic_aggregate_anchors
              WHERE tenant_id = $1 AND environment_id = $2 AND cache_key = $3`,
            [tenantA, environmentA, plantedAnchorCacheKey],
          );
          assert.equal(anchor.rows[0]?.balance_value, '999');
          const line = await database.pool.query<{ quantity: string }>(
            `SELECT ${quoted(field(binding.transactionLine, 'inventory_transaction_line_quantity').physicalName)}::text
                      AS quantity
               FROM ${table(binding, binding.transactionLine)}
              WHERE tenant_id = $1 AND environment_id = $2
                AND ${quoted(binding.transactionLine.recordIdColumn)} = $3`,
            [tenantA, environmentA, divergentLineId],
          );
          assert.equal(
            normalizeDatabaseDecimal(line.rows[0]?.quantity ?? ''),
            '4',
          );
        },
      );

      await t.test(
        'the operator report names the line, both quantities, and every count',
        async () => {
          assert.ok(divergentReport);
          const rendered = renderInventoryReconciliationReport(divergentReport);
          const text = rendered.join('\n');
          assert.equal(
            rendered[0],
            'inventory reconciliation divergent-scope: DISCREPANT',
          );
          assert.match(
            text,
            new RegExp(
              `\\[SOURCE_DOCUMENT_QUANTITY_DIVERGED\\] ${divergentLineId}: document declares 4, movement ledger observes 11`,
              'u',
            ),
          );
          assert.match(
            text,
            new RegExp(
              `\\[AGGREGATE_ANCHOR_LEDGER_DIVERGED\\] ${plantedAnchorCacheKey}: document declares 999, movement ledger observes 3`,
              'u',
            ),
          );
          assert.ok(text.includes(`consistent ${transferLineId}`));
          assert.ok(
            text.includes('repaired=0 transactionReadOnly=on'),
            'the operator sees that nothing was repaired without having to trust it',
          );
        },
      );

      await t.test(
        'the sweep surfaces a read-path discrepancy that previously reached only a table',
        async () => {
          const refreshed = await invokeOnHand(gateway, view, {
            itemId: itemPrimary,
            legalEntityId: legalEntityA,
            locationId: locationPrimary,
          });
          assert.equal(refreshed.value.value, '13');
          const cacheKey = await currentAnchorCacheKey(
            database.pool,
            scopeA,
            reconciliationIds.onHandQueryId,
            [plantedAnchorCacheKey, unrecognizedAnchorCacheKey],
          );
          recordedDiscrepancyAnchorKey = cacheKey;
          await corruptAnchor(database.pool, scopeA, cacheKey, '777');
          cacheObservations.length = 0;
          const afterCorruption = await invokeOnHand(gateway, view, {
            itemId: itemPrimary,
            legalEntityId: legalEntityA,
            locationId: locationPrimary,
          });
          assert.equal(afterCorruption.value.value, '13');
          assert.deepEqual(
            cacheObservations.map((observation) => observation.kind),
            ['ledger-recomputation', 'anchor-discrepancy'],
          );
          const report = await reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [legalEntityA],
            scopeId: 'surfaced-scope',
          });
          const preserved = onlyFinding(
            report,
            'RECORDED_ANCHOR_DISCREPANCY_PRESERVED',
          );
          assert.equal(preserved.subjectId, cacheKey);
          assert.equal(preserved.detail.recordedDiscrepancyCount, '1');
          assert.equal(preserved.declaredValue, '777');
          assert.equal(preserved.observedValue, '13');
          const rendered =
            renderInventoryReconciliationReport(report).join('\n');
          assert.ok(
            rendered.includes(
              `[RECORDED_ANCHOR_DISCREPANCY_PRESERVED] ${cacheKey}`,
            ),
            'the discrepancy the read path buried in a table is now readable by a human',
          );
        },
      );

      await t.test(
        'reconciliation is tenant-scoped and cannot read across tenants',
        async () => {
          const seeded = await seedPostedDocumentWithDivergentMovement(
            runtimePool,
            scopeB,
            binding,
            {
              legalEntityId: legalEntityA,
              locationId: locationPrimary,
              lineQuantity: '6',
              movementQuantity: '60',
            },
          );
          await assertForcedRowLevelSecurity(database.pool, binding);

          // Both tenants' rows live in one physical table under one legal
          // entity identifier, so tenant separation is decisive rather than
          // incidental: an unscoped reader observes both.
          const unscoped = await database.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM ${table(binding, binding.movement)}
              WHERE ${quoted(binding.movement.legalEntityColumn!)} = $1
                AND tenant_id = ANY($2::uuid[])`,
            [legalEntityA, [tenantA, tenantB]],
          );
          assert.equal(
            Number(unscoped.rows[0]?.count) >= 5,
            true,
            'the fixture places both tenants under one legal entity in one table',
          );

          const fromA = await reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [legalEntityA],
            scopeId: 'tenant-a-scope',
          });
          const renderedA =
            renderInventoryReconciliationReport(fromA).join('\n');
          for (const tenantBIdentifier of [
            seeded.movementId,
            seeded.transactionId,
            seeded.transactionLineId,
          ]) {
            assert.equal(
              renderedA.includes(tenantBIdentifier),
              false,
              `tenant A must not observe the tenant B record ${tenantBIdentifier}`,
            );
          }
          assert.equal(
            fromA.findings.some((finding) => finding.observedValue === '60'),
            false,
            'tenant A must not observe the tenant B movement quantity',
          );

          const fromB = await reconciliation.reconcile(scopeB.context, {
            legalEntityIds: [legalEntityA],
            scopeId: 'tenant-b-scope',
          });
          assert.equal(fromB.outcome, 'discrepant');
          const quantity = onlyFinding(
            fromB,
            'SOURCE_DOCUMENT_QUANTITY_DIVERGED',
          );
          assert.equal(quantity.subjectId, seeded.transactionLineId);
          assert.equal(quantity.declaredValue, '6');
          assert.equal(quantity.observedValue, '60');
          const renderedB =
            renderInventoryReconciliationReport(fromB).join('\n');
          for (const tenantAIdentifier of [
            consistentLineId,
            divergentLineId,
            transferLineId,
            plantedAnchorCacheKey,
          ]) {
            assert.equal(
              renderedB.includes(tenantAIdentifier),
              false,
              `tenant B must not observe the tenant A record ${tenantAIdentifier}`,
            );
          }
        },
      );

      await t.test(
        'a scope with no subjects is indeterminate, never clean',
        async () => {
          const report = await reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [quietLegalEntityA],
            scopeId: 'quiet-scope',
          });
          assert.equal(
            report.outcome,
            'indeterminate',
            'reporting a zero-subject scope as consistent is the vacuity vector this control exists for',
          );
          assert.equal(report.subjectCount, 0);
          assert.deepEqual(
            report.findings.map((finding) => finding.code),
            ['SCOPE_OBSERVED_NO_SUBJECTS', 'SCOPE_OBSERVED_NO_SUBJECTS'],
          );
          for (const armReport of report.arms) {
            assert.equal(armReport.outcome, 'indeterminate');
            assert.deepEqual(armReport.consistentSubjectIds, []);
          }
          assert.ok(
            arm(report, 'aggregateAnchors').excludedSubjects.length > 0,
            'the anchors this scope excludes are counted, not silently dropped',
          );
        },
      );

      await t.test('an unnamed or empty scope is refused', async () => {
        await assert.rejects(
          reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [],
            scopeId: 'empty',
          }),
          (error: unknown) =>
            error instanceof InventoryReconciliationError &&
            error.code === 'INVENTORY_RECONCILIATION_SCOPE_INVALID',
        );
        await assert.rejects(
          reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [legalEntityA],
            scopeId: '   ',
          }),
          (error: unknown) =>
            error instanceof InventoryReconciliationError &&
            error.code === 'INVENTORY_RECONCILIATION_SCOPE_INVALID',
        );
      });

      await t.test(
        'an anchor whose stored scope or balance is out of contract is never called clean',
        async () => {
          await plantAnchor(runtimePool, scopeA, {
            balanceValue: '3',
            cacheKey: scopeDivergedAnchorCacheKey,
            itemId: itemPrimary,
            legalEntityId: legalEntityA,
            locationId: locationSecondary,
            principalId: principalA,
            queryId: reconciliationIds.onHandQueryId,
            // Stored scope names ONLY the other legal entity. Deciding
            // membership from the stored column alone would exclude this anchor
            // from the reconciliation below and never compare it at all.
            scopeLegalEntityIds: [quietLegalEntityA],
          });
          await plantAnchor(runtimePool, scopeA, {
            // Twenty-one integer digits: inside migration 0020's lexical check
            // and outside numeric(38,18), which is the gap a lexical check
            // cannot see.
            balanceValue: `1${'0'.repeat(20)}`,
            cacheKey: overflowingAnchorCacheKey,
            itemId: itemPrimary,
            legalEntityId: legalEntityA,
            locationId: locationSecondary,
            principalId: principalA,
            queryId: reconciliationIds.onHandQueryId,
          });
          const report = await reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [legalEntityA],
            scopeId: 'out-of-contract-scope',
          });
          const scopeDiverged = findingFor(
            report,
            'AGGREGATE_ANCHOR_SCOPE_DIVERGED',
            scopeDivergedAnchorCacheKey,
          );
          assert.equal(scopeDiverged.declaredValue, quietLegalEntityA);
          assert.equal(scopeDiverged.observedValue, legalEntityA);
          const anchors = arm(report, 'aggregateAnchors');
          assert.equal(
            anchors.consistentSubjectIds.includes(scopeDivergedAnchorCacheKey),
            false,
            'an anchor answering a different scope than its key claims is never consistent',
          );
          assert.ok(
            anchors.discrepantSubjectIds.includes(scopeDivergedAnchorCacheKey),
          );

          const overflowing = findingFor(
            report,
            'AGGREGATE_ANCHOR_BALANCE_UNRECOGNIZED',
            overflowingAnchorCacheKey,
          );
          assert.equal(overflowing.declaredValue, `1${'0'.repeat(20)}`);
          assert.equal(overflowing.observedValue, null);
          assert.ok(
            anchors.unverifiableSubjectIds.includes(overflowingAnchorCacheKey),
            'a stored balance outside numeric(38,18) is unverifiable, not clean',
          );
          assert.equal(
            anchors.consistentSubjectIds.includes(overflowingAnchorCacheKey),
            false,
          );
        },
      );

      await t.test(
        'the sweep holds the aggregate-generation guard, so a concurrent append cannot split its snapshot',
        async () => {
          const holder = await database.pool.connect();
          let pending: Promise<InventoryReconciliationReportV1> | undefined;
          let holderOpen = false;
          try {
            await holder.query('BEGIN');
            holderOpen = true;
            await holder.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
              [aggregateGenerationLockKey(tenantA, environmentA)],
            );
            pending = reconciliation.reconcile(scopeA.context, {
              legalEntityIds: [legalEntityA],
              scopeId: 'guarded-scope',
            });
            void pending.catch(() => undefined);
            const waiterPid = await waitForGenerationLockWaiter(database.pool);
            assert.equal(typeof waiterPid, 'number');
            await holder.query('ROLLBACK');
            holderOpen = false;
          } finally {
            if (holderOpen) await holder.query('ROLLBACK');
            holder.release();
          }
          assert.ok(pending);
          const report = await pending;
          assert.equal(report.scopeId, 'guarded-scope');
        },
      );

      await t.test(
        'a document-side change that no movement matches is detected',
        async () => {
          // A transaction line is an ordinary updatable entity and its updates
          // do not advance the aggregate generation, so the ledger guard alone
          // cannot see this writer. The arm reads both sides in one statement
          // for exactly that reason.
          await withModuleRole(runtimePool, scopeA, async (client) => {
            const updated = await client.query(
              `UPDATE ${table(binding, binding.transactionLine)}
                  SET ${quoted(field(binding.transactionLine, 'inventory_transaction_line_quantity').physicalName)} = $4
                WHERE tenant_id = $1 AND environment_id = $2
                  AND ${quoted(binding.transactionLine.recordIdColumn)} = $3`,
              [tenantA, environmentA, consistentLineId, '8'],
            );
            assert.equal(updated.rowCount, 1);
          });
          const report = await reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [legalEntityA],
            scopeId: 'document-drift-scope',
          });
          const drift = findingFor(
            report,
            'SOURCE_DOCUMENT_QUANTITY_DIVERGED',
            consistentLineId,
          );
          assert.equal(drift.declaredValue, '8');
          assert.equal(drift.observedValue, '5');
          assert.equal(
            arm(report, 'sourceDocuments').consistentSubjectIds.includes(
              consistentLineId,
            ),
            false,
          );
        },
      );

      await t.test(
        'a partly corrupt anchor cannot hide from the scope its own operand names',
        async () => {
          // A clean scope of its own, so the pre-fix verdict is `consistent`
          // rather than being masked by the divergences planted above.
          const witnessTransactionId = randomUUID();
          const witnessLineId = randomUUID();
          const witnessAdjustment = adjustmentCommand({
            legalEntityId: witnessLegalEntityA,
            lineId: witnessLineId,
            locationId: locationPrimary,
            quantityDelta: '5',
            sourceId: 'reconcile-witness',
            transactionId: witnessTransactionId,
          });
          await seedAdjustmentDraft(
            runtimePool,
            scopeA,
            binding,
            witnessAdjustment,
          );
          await postingService.postAdjustment(
            scopeA.context,
            actor,
            witnessAdjustment,
          );
          const witnessBalance = await invokeOnHand(gateway, view, {
            itemId: itemPrimary,
            legalEntityId: witnessLegalEntityA,
            locationId: locationPrimary,
          });
          assert.equal(witnessBalance.value.value, '5');

          // THE EXACT SCENARIO. Stored scope names another legal entity, the
          // legal-entity operand validly names the witness scope, and one
          // sibling parameter is malformed.
          await plantAnchor(runtimePool, scopeA, {
            balanceValue: '4',
            cacheKey: partiallyCorruptAnchorCacheKey,
            itemId: itemPrimary,
            legalEntityId: witnessLegalEntityA,
            locationId: locationPrimary,
            parameterOverrides: {
              [reconciliationIds.parameterIds.atTime]: 'not-an-instant',
            },
            principalId: principalA,
            queryId: reconciliationIds.onHandQueryId,
            scopeLegalEntityIds: [legalEntityA],
          });
          // No attributable operand at all: the scope authority is unreadable
          // too, so nothing links it to the witness scope except doubt.
          await plantAnchor(runtimePool, scopeA, {
            balanceValue: '4',
            cacheKey: fullyCorruptAnchorCacheKey,
            itemId: itemPrimary,
            legalEntityId: witnessLegalEntityA,
            locationId: locationPrimary,
            parameterOverrides: {
              [reconciliationIds.parameterIds.legalEntityId]: 'not-a-uuid',
            },
            principalId: principalA,
            queryId: reconciliationIds.onHandQueryId,
            // Its stored scope is the only authority left, and it names this
            // scope. Excluding it here would drop it from every report.
            scopeLegalEntityIds: [witnessLegalEntityA],
          });

          const report = await reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [witnessLegalEntityA],
            scopeId: 'witness-scope',
          });
          const anchors = arm(report, 'aggregateAnchors');

          assert.equal(
            report.outcome,
            'indeterminate',
            'an anchor the sweep could not check must never leave the scope reading clean',
          );
          for (const cacheKey of [
            partiallyCorruptAnchorCacheKey,
            fullyCorruptAnchorCacheKey,
          ]) {
            assert.ok(
              anchors.unverifiableSubjectIds.includes(cacheKey),
              `${cacheKey} must be reported, not excluded`,
            );
            assert.equal(
              anchors.excludedSubjects.some(
                (excluded) => excluded.subjectId === cacheKey,
              ),
              false,
              `${cacheKey} must not be silently excluded`,
            );
            const finding = findingFor(
              report,
              'AGGREGATE_ANCHOR_PARAMETERS_UNRECOGNIZED',
              cacheKey,
            );
            assert.equal(finding.observedValue, null);
          }

          // The positive witness, in the same run: a clean anchor with all
          // parameters valid is still attributed and reconciled normally, so
          // the fix is not "mark everything indeterminate".
          const witnessAnchorKey = await currentAnchorCacheKey(
            database.pool,
            scopeA,
            reconciliationIds.onHandQueryId,
            [
              plantedAnchorCacheKey,
              unrecognizedAnchorCacheKey,
              scopeDivergedAnchorCacheKey,
              overflowingAnchorCacheKey,
              partiallyCorruptAnchorCacheKey,
              fullyCorruptAnchorCacheKey,
            ],
          );
          assert.deepEqual(anchors.consistentSubjectIds, [witnessAnchorKey]);
          assert.deepEqual(
            arm(report, 'sourceDocuments').consistentSubjectIds,
            [witnessLineId],
          );
          assert.equal(arm(report, 'sourceDocuments').outcome, 'consistent');

          // Exclusion still names what it dropped and why.
          assert.ok(anchors.excludedSubjects.length > 0);
          for (const excluded of anchors.excludedSubjects) {
            assert.match(
              excluded.reason,
              /^(?:outOfScope|supersededGeneration)$/u,
            );
            assert.match(excluded.subjectId, /^[0-9a-f]{64}$/u);
          }
          const rendered =
            renderInventoryReconciliationReport(report).join('\n');
          assert.ok(
            rendered.includes(
              `excluded ${anchors.excludedSubjects[0]!.subjectId} (${anchors.excludedSubjects[0]!.reason})`,
            ),
            'the operator can read what the sweep left out and why',
          );
        },
      );

      await t.test(
        'an anchor with no readable attribution authority is still reported',
        async () => {
          // `legal_entity_ids uuid[] NOT NULL` forbids a null ARRAY, not null
          // ELEMENTS, and the zero-uuid predicate evaluates to NULL for one,
          // which a CHECK accepts. Whether that row is insertable is a fact
          // about PostgreSQL, so it is executed rather than argued.
          const planted = await plantNullScopeAnchor(runtimePool, scopeA, {
            cacheKey: authorityLessAnchorCacheKey,
            itemId: itemPrimary,
            locationId: locationPrimary,
            principalId: principalA,
            queryId: reconciliationIds.onHandQueryId,
          });
          assert.equal(
            planted,
            true,
            'the storage contract admits an anchor whose stored scope names nothing',
          );
          const report = await reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [witnessLegalEntityA],
            scopeId: 'authority-less-scope',
          });
          const anchors = arm(report, 'aggregateAnchors');
          assert.ok(
            anchors.unverifiableSubjectIds.includes(
              authorityLessAnchorCacheKey,
            ),
            'an anchor no authority can place must be reported by every scope, or it is reported by none',
          );
          assert.equal(
            anchors.excludedSubjects.some(
              (excluded) => excluded.subjectId === authorityLessAnchorCacheKey,
            ),
            false,
          );
          assert.notEqual(report.outcome, 'consistent');

          // The same trusted-shape assumption one step downstream: attribution
          // recovers the scope from a valid operand, and the scope-agreement
          // comparison then reads the stored member. A nested array reaches it
          // with every parameter valid, which the null-element case never does.
          await plantNestedScopeAnchor(runtimePool, scopeA, {
            cacheKey: nestedScopeAnchorCacheKey,
            itemId: itemPrimary,
            legalEntityId: witnessLegalEntityA,
            locationId: locationPrimary,
            principalId: principalA,
            queryId: reconciliationIds.onHandQueryId,
          });
          const nested = await reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [witnessLegalEntityA],
            scopeId: 'nested-scope',
          });
          const divergence = findingFor(
            nested,
            'AGGREGATE_ANCHOR_SCOPE_DIVERGED',
            nestedScopeAnchorCacheKey,
          );
          assert.equal(divergence.observedValue, witnessLegalEntityA);
          assert.match(divergence.declaredValue ?? '', /\[\[/u);
          assert.ok(
            arm(nested, 'aggregateAnchors').discrepantSubjectIds.includes(
              nestedScopeAnchorCacheKey,
            ),
          );
          assert.notEqual(nested.outcome, 'consistent');
        },
      );

      await t.test(
        'the returned anchor object carries no raw stored scope',
        async () => {
          // Asserted on the OBJECT, never on the type: the whole defect was that
          // `AnchorRow` already claimed the property was gone while the spread
          // kept putting it back at runtime.
          const anchors = await withModuleRole(runtimePool, scopeA, (client) =>
            selectAnchors(client, scopeA.context),
          );
          assert.ok(
            anchors.length > 0,
            'the control must observe real anchors, not an empty set',
          );
          for (const anchor of anchors) {
            assert.equal(
              Object.hasOwn(anchor, 'legalEntityIds'),
              false,
              `${anchor.cacheKey} still carries the raw stored scope`,
            );
            assert.deepEqual(
              Object.keys(anchor).filter((key) => /legal/iu.test(key)),
              ['legalEntityScope'],
            );
          }
          // The normalized form is still there and still validated, so this is
          // an absence control rather than a "delete the field" control.
          const nested = anchors.find(
            (anchor) => anchor.cacheKey === nestedScopeAnchorCacheKey,
          );
          assert.ok(nested);
          assert.equal(nested.legalEntityScope.wellFormed, false);
          assert.deepEqual(nested.legalEntityScope.ids, []);
        },
      );

      await t.test(
        'a movement effective on a different day than its document is detected',
        async () => {
          // Every quantity, item, unit, location and source identity agrees.
          // Only the date the movement takes effect differs, which decides the
          // period it lands in and every as-of balance that contains it.
          const transactionId = randomUUID();
          const transactionLineId = randomUUID();
          const movementId = randomUUID();
          await withModuleRole(runtimePool, scopeA, async (client) => {
            await insertTransactionHeader(client, scopeA, binding, {
              legalEntityId: witnessLegalEntityA,
              number: `EFF-${transactionId.slice(0, 12)}`,
              reasonCode: 'RECONCILE',
              reasonNarrative: 'Effective-date control',
              sourceId: 'reconcile-effective',
              sourceType: 'adjustment',
              state: 'posted',
              transactionId,
              type: 'adjustment',
            });
            await insertEntity(
              client,
              scopeA,
              binding,
              binding.transactionLine,
              {
                legalEntityId: witnessLegalEntityA,
                overrides: {
                  inventory_transaction_line_from_location_id: null,
                  inventory_transaction_line_item_id: itemPrimary,
                  inventory_transaction_line_line_number: 1,
                  inventory_transaction_line_quantity: '2',
                  inventory_transaction_line_to_location_id: locationSecondary,
                  inventory_transaction_line_unit_id: 'EA',
                },
                recordId: transactionLineId,
                relationIds: {
                  [binding.transaction.entity.entityId]: transactionId,
                },
              },
            );
            await insertMovement(client, scopeA, binding, {
              businessPeriod: '2026-07-28',
              effectiveAt: '2026-07-28T12:00:00.000Z',
              itemId: itemPrimary,
              legalEntityId: witnessLegalEntityA,
              locationId: locationSecondary,
              movementId,
              quantityDelta: '2',
              sourceId: 'reconcile-effective',
              sourceLine: '1',
              sourceType: 'adjustment',
              transactionId,
              transactionLineId,
            });
          });
          const report = await reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [witnessLegalEntityA],
            scopeId: 'effective-date-scope',
          });
          const drift = findingFor(
            report,
            'SOURCE_DOCUMENT_EFFECTIVE_AT_DIVERGED',
            transactionLineId,
          );
          assert.equal(drift.declaredValue, effectiveAt);
          assert.equal(drift.observedValue, '2026-07-28T12:00:00.000Z');
          assert.equal(drift.detail.movementId, movementId);
          assert.ok(
            arm(report, 'sourceDocuments').discrepantSubjectIds.includes(
              transactionLineId,
            ),
          );
          assert.equal(
            report.findings.filter(
              (finding) =>
                finding.subjectId === transactionLineId &&
                finding.code === 'SOURCE_DOCUMENT_QUANTITY_DIVERGED',
            ).length,
            0,
            'the quantities agree; only the effective date diverges',
          );
        },
      );

      await t.test(
        'a movement filed under the wrong line or posted in the wrong role is detected',
        async () => {
          const transactionId = randomUUID();
          const transactionLineId = randomUUID();
          const movementId = randomUUID();
          await withModuleRole(runtimePool, scopeA, async (client) => {
            await insertTransactionHeader(client, scopeA, binding, {
              legalEntityId: witnessLegalEntityA,
              number: `PRV-${transactionId.slice(0, 12)}`,
              reasonCode: 'RECONCILE',
              reasonNarrative: 'Provenance control',
              sourceId: 'reconcile-provenance',
              sourceType: 'adjustment',
              state: 'posted',
              transactionId,
              type: 'adjustment',
            });
            await insertEntity(
              client,
              scopeA,
              binding,
              binding.transactionLine,
              {
                legalEntityId: witnessLegalEntityA,
                overrides: {
                  inventory_transaction_line_from_location_id: null,
                  inventory_transaction_line_item_id: itemPrimary,
                  inventory_transaction_line_line_number: 1,
                  inventory_transaction_line_quantity: '2',
                  inventory_transaction_line_to_location_id: locationOrphan,
                  inventory_transaction_line_unit_id: 'EA',
                },
                recordId: transactionLineId,
                relationIds: {
                  [binding.transaction.entity.entityId]: transactionId,
                },
              },
            );
            // Quantity, item, location, unit, source identity and effective
            // date all agree. Only the provenance differs.
            await insertMovement(client, scopeA, binding, {
              itemId: itemPrimary,
              legalEntityId: witnessLegalEntityA,
              locationId: locationOrphan,
              movementId,
              postingRole: 'transfer',
              quantityDelta: '2',
              sourceId: 'reconcile-provenance',
              sourceLine: '2',
              sourceType: 'adjustment',
              transactionId,
              transactionLineId,
            });
          });
          const report = await reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [witnessLegalEntityA],
            scopeId: 'provenance-scope',
          });
          const sourceLine = findingFor(
            report,
            'SOURCE_DOCUMENT_SOURCE_LINE_DIVERGED',
            transactionLineId,
          );
          assert.equal(sourceLine.declaredValue, '1');
          assert.equal(sourceLine.observedValue, '2');
          const postingRole = findingFor(
            report,
            'SOURCE_DOCUMENT_POSTING_ROLE_DIVERGED',
            transactionLineId,
          );
          assert.equal(postingRole.observedValue?.endsWith('_transfer'), true);
          assert.equal(
            postingRole.declaredValue?.endsWith('_adjustment'),
            true,
          );
          assert.equal(
            report.findings.filter(
              (finding) =>
                finding.subjectId === transactionLineId &&
                finding.code === 'SOURCE_DOCUMENT_QUANTITY_DIVERGED',
            ).length,
            0,
            'the quantities agree; only the provenance diverges',
          );
        },
      );

      await t.test(
        'a discrepancy recorded against a now-superseded anchor is still surfaced',
        async () => {
          assert.ok(recordedDiscrepancyAnchorKey);
          const report = await reconciliation.reconcile(scopeA.context, {
            legalEntityIds: [legalEntityA],
            scopeId: 'superseded-discrepancy-scope',
          });
          const anchors = arm(report, 'aggregateAnchors');
          const preserved = findingFor(
            report,
            'RECORDED_ANCHOR_DISCREPANCY_PRESERVED',
            recordedDiscrepancyAnchorKey,
          );
          assert.equal(preserved.detail.recordedDiscrepancyCount, '1');
          assert.notEqual(
            preserved.detail.movementGeneration,
            preserved.detail.supersededBy,
            'the control is only meaningful once the generation has moved on',
          );
          assert.equal(
            anchors.excludedSubjects.some(
              (excluded) => excluded.subjectId === recordedDiscrepancyAnchorKey,
            ),
            false,
            'excluding it would bury every recorded discrepancy the next posting supersedes',
          );
          assert.ok(
            anchors.discrepantSubjectIds.includes(recordedDiscrepancyAnchorKey),
          );
        },
      );
    } finally {
      await Promise.all([
        runtimePool.end(),
        materializerPool.end(),
        modulePool.end(),
      ]);
    }
  });
});

function arm(
  report: InventoryReconciliationReportV1,
  armId: InventoryReconciliationArmReportV1['armId'],
): InventoryReconciliationArmReportV1 {
  const found = report.arms.find((candidate) => candidate.armId === armId);
  assert.ok(found, `missing arm ${armId}`);
  return found;
}

function findingFor(
  report: InventoryReconciliationReportV1,
  code: string,
  subjectId: string,
): InventoryReconciliationReportV1['findings'][number] {
  const matches = report.findings.filter(
    (finding) => finding.code === code && finding.subjectId === subjectId,
  );
  assert.equal(
    matches.length,
    1,
    `expected exactly one ${code} for ${subjectId}`,
  );
  return matches[0]!;
}

async function waitForGenerationLockWaiter(pool: Pool): Promise<number> {
  const deadline = process.hrtime.bigint() + 15_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    const result = await pool.query<{ pid: number }>(
      `SELECT activity.pid
         FROM pg_catalog.pg_stat_activity AS activity
         JOIN pg_catalog.pg_locks AS lock_record
           ON lock_record.pid = activity.pid
        WHERE activity.datname = current_database()
          AND activity.application_name = 'g3-r1-reconciliation'
          AND activity.wait_event_type = 'Lock'
          AND activity.wait_event = 'advisory'
          AND lock_record.locktype = 'advisory'
          AND lock_record.mode = 'ShareLock'
          AND NOT lock_record.granted
        ORDER BY activity.pid
        LIMIT 1`,
    );
    const pid = result.rows[0]?.pid;
    if (typeof pid === 'number') return pid;
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
  throw new Error(
    'the reconciliation never waited on the aggregate-generation guard',
  );
}

function onlyFinding(
  report: InventoryReconciliationReportV1,
  code: string,
): InventoryReconciliationReportV1['findings'][number] {
  const matches = report.findings.filter((finding) => finding.code === code);
  assert.equal(matches.length, 1, `expected exactly one ${code}`);
  return matches[0]!;
}

async function assertForcedRowLevelSecurity(
  pool: Pool,
  binding: TestStorageBinding,
): Promise<void> {
  const relations = [
    binding.movement.tableName,
    binding.transaction.tableName,
    binding.transactionLine.tableName,
  ];
  const managed = await pool.query<{
    enabled: boolean;
    forced: boolean;
    relation: string;
  }>(
    `SELECT relation.relname AS relation,
            relation.relrowsecurity AS enabled,
            relation.relforcerowsecurity AS forced
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'north_star_module'
        AND relation.relname = ANY($1::text[])`,
    [relations],
  );
  assert.equal(managed.rowCount, relations.length);
  for (const row of managed.rows) {
    assert.equal(row.enabled, true, `${row.relation} lacks row-level security`);
    assert.equal(row.forced, true, `${row.relation} does not force it`);
  }
  const internal = await pool.query<{
    enabled: boolean;
    forced: boolean;
    relation: string;
  }>(
    `SELECT relation.relname AS relation,
            relation.relrowsecurity AS enabled,
            relation.relforcerowsecurity AS forced
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'north_star_internal'
        AND relation.relname IN (
          'semantic_aggregate_anchors',
          'semantic_aggregate_anchor_discrepancies'
        )`,
  );
  assert.equal(internal.rowCount, 2);
  for (const row of internal.rows) {
    assert.equal(row.enabled, true, `${row.relation} lacks row-level security`);
    assert.equal(row.forced, true, `${row.relation} does not force it`);
  }
}

async function snapshotState(
  pool: Pool,
  binding: TestStorageBinding,
): Promise<StateSnapshot> {
  const movements = await pool.query(
    `SELECT to_jsonb(movement) AS row FROM ${table(binding, binding.movement)} AS movement
      ORDER BY ${quoted(binding.movement.recordIdColumn)}`,
  );
  const transactionLines = await pool.query(
    `SELECT to_jsonb(line) AS row FROM ${table(binding, binding.transactionLine)} AS line
      ORDER BY ${quoted(binding.transactionLine.recordIdColumn)}`,
  );
  const anchors = await pool.query(
    `SELECT to_jsonb(anchor) AS row
       FROM north_star_internal.semantic_aggregate_anchors AS anchor
      ORDER BY tenant_id, environment_id, cache_key`,
  );
  const discrepancies = await pool.query(
    `SELECT to_jsonb(recorded) AS row
       FROM north_star_internal.semantic_aggregate_anchor_discrepancies
              AS recorded
      ORDER BY tenant_id, environment_id, discrepancy_id`,
  );
  return {
    anchors: anchors.rows,
    discrepancies: discrepancies.rows,
    movements: movements.rows,
    transactionLines: transactionLines.rows,
  };
}

async function onlyAnchorCacheKey(
  pool: Pool,
  scope: TenantScope,
  queryId: string,
): Promise<string> {
  const result = await pool.query<{ cache_key: string }>(
    `SELECT cache_key
       FROM north_star_internal.semantic_aggregate_anchors
      WHERE tenant_id = $1 AND environment_id = $2 AND query_id = $3`,
    [scope.tenantId, scope.environmentId, queryId],
  );
  assert.equal(
    result.rowCount,
    1,
    'exactly one anchor was read into existence',
  );
  return result.rows[0]!.cache_key;
}

async function currentAnchorCacheKey(
  pool: Pool,
  scope: TenantScope,
  queryId: string,
  excludedCacheKeys: readonly string[],
): Promise<string> {
  const result = await pool.query<{ cache_key: string }>(
    `SELECT anchor.cache_key
       FROM north_star_internal.semantic_aggregate_anchors AS anchor
       JOIN north_star_internal.semantic_aggregate_generations AS generation
         ON generation.tenant_id = anchor.tenant_id
        AND generation.environment_id = anchor.environment_id
        AND generation.movement_generation = anchor.movement_generation
      WHERE anchor.tenant_id = $1 AND anchor.environment_id = $2
        AND anchor.query_id = $3
        AND NOT (anchor.cache_key = ANY($4::text[]))`,
    [scope.tenantId, scope.environmentId, queryId, [...excludedCacheKeys]],
  );
  assert.equal(
    result.rowCount,
    1,
    'exactly one live anchor was produced by the read path',
  );
  return result.rows[0]!.cache_key;
}

async function corruptAnchor(
  administrativePool: Pool,
  scope: TenantScope,
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
      [scope.tenantId, scope.environmentId, cacheKey, balance],
    );
    assert.equal(updated.rowCount, 1);
  } finally {
    await administrativePool.query(
      `ALTER TABLE north_star_internal.semantic_aggregate_anchors ENABLE RULE ${rule}`,
    );
  }
}

interface PlantedAnchorInput {
  readonly balanceValue: string;
  readonly cacheKey: string;
  readonly itemId: string;
  /** The value of the query's own legal-entity operand. */
  readonly legalEntityId: string;
  readonly locationId: string;
  readonly principalId: string;
  readonly queryId: string;
  /** Raw parameter_values overrides, so a single sibling can be corrupted. */
  readonly parameterOverrides?: Readonly<Record<string, unknown>>;
  /** The stored scope column, which defaults to agreeing with the operand. */
  readonly scopeLegalEntityIds?: readonly string[];
}

/**
 * The anchor is written straight into the cache, exactly as a defective compute
 * path would leave it, and it is never read afterwards. Only a sweep can find
 * it: the read path verifies an anchor when somebody asks for it.
 */
async function plantAnchor(
  pool: Pool,
  scope: TenantScope,
  input: PlantedAnchorInput,
): Promise<void> {
  await withModuleRole(pool, scope, async (client) => {
    const generation = await client.query<{ movement_generation: string }>(
      `SELECT movement_generation::text AS movement_generation
         FROM north_star_internal.semantic_aggregate_generations
        WHERE tenant_id = $1 AND environment_id = $2`,
      [scope.tenantId, scope.environmentId],
    );
    assert.equal(generation.rowCount, 1);
    await client.query(
      `INSERT INTO north_star_internal.semantic_aggregate_anchors (
         tenant_id, environment_id, cache_key, movement_generation, query_id,
         principal_id, release_content_hash, legal_entity_ids,
         parameter_values, temporal_horizons, filter_plan_digest, result_kind,
         selection_id, balance_value, result_precision, result_scale,
         base_unit_id, anchor_digest
       ) VALUES (
         $1, $2, $3, $4::bigint, $5, $6, $7, $8::uuid[], $9::jsonb, $10::jsonb,
         $11, 'exactDecimalResult', $12, $13, 38, 0, NULL, $14
       )`,
      [
        scope.tenantId,
        scope.environmentId,
        input.cacheKey,
        generation.rows[0]!.movement_generation,
        input.queryId,
        input.principalId,
        plantedReleaseContentHash,
        [...(input.scopeLegalEntityIds ?? [input.legalEntityId])],
        JSON.stringify({
          [reconciliationIds.parameterIds.atTime]: horizon,
          [reconciliationIds.parameterIds.itemId]: input.itemId,
          [reconciliationIds.parameterIds.legalEntityId]: input.legalEntityId,
          [reconciliationIds.parameterIds.locationId]: input.locationId,
          [reconciliationIds.parameterIds.recordedAtHorizon]: horizon,
          ...(input.parameterOverrides ?? {}),
        }),
        JSON.stringify({
          [reconciliationIds.parameterIds.atTime]: horizon,
          [reconciliationIds.parameterIds.recordedAtHorizon]: horizon,
        }),
        plantedFilterPlanDigest,
        onHandSelectionId,
        input.balanceValue,
        plantedAnchorDigest,
      ],
    );
  });
}

async function plantNestedScopeAnchor(
  pool: Pool,
  scope: TenantScope,
  input: {
    readonly cacheKey: string;
    readonly itemId: string;
    readonly legalEntityId: string;
    readonly locationId: string;
    readonly principalId: string;
    readonly queryId: string;
  },
): Promise<void> {
  await withModuleRole(pool, scope, async (client) => {
    const generation = await client.query<{ movement_generation: string }>(
      `SELECT movement_generation::text AS movement_generation
         FROM north_star_internal.semantic_aggregate_generations
        WHERE tenant_id = $1 AND environment_id = $2`,
      [scope.tenantId, scope.environmentId],
    );
    assert.equal(generation.rowCount, 1);
    // cardinality() counts members across every dimension, so a 1x1 nested
    // array satisfies migration 0020's BETWEEN 1 AND 64 exactly as a flat one
    // does. Dimensionality is unconstrained.
    await client.query(
      `INSERT INTO north_star_internal.semantic_aggregate_anchors (
         tenant_id, environment_id, cache_key, movement_generation, query_id,
         principal_id, release_content_hash, legal_entity_ids,
         parameter_values, temporal_horizons, filter_plan_digest, result_kind,
         selection_id, balance_value, result_precision, result_scale,
         base_unit_id, anchor_digest
       ) VALUES (
         $1, $2, $3, $4::bigint, $5, $6, $7, ARRAY[ARRAY[$8::uuid]],
         $9::jsonb, $10::jsonb, $11, 'exactDecimalResult', $12, '3', 38, 0,
         NULL, $13
       )`,
      [
        scope.tenantId,
        scope.environmentId,
        input.cacheKey,
        generation.rows[0]!.movement_generation,
        input.queryId,
        input.principalId,
        plantedReleaseContentHash,
        input.legalEntityId,
        JSON.stringify({
          [reconciliationIds.parameterIds.atTime]: horizon,
          [reconciliationIds.parameterIds.itemId]: input.itemId,
          [reconciliationIds.parameterIds.legalEntityId]: input.legalEntityId,
          [reconciliationIds.parameterIds.locationId]: input.locationId,
          [reconciliationIds.parameterIds.recordedAtHorizon]: horizon,
        }),
        JSON.stringify({
          [reconciliationIds.parameterIds.atTime]: horizon,
          [reconciliationIds.parameterIds.recordedAtHorizon]: horizon,
        }),
        plantedFilterPlanDigest,
        onHandSelectionId,
        plantedAnchorDigest,
      ],
    );
  });
}

async function plantNullScopeAnchor(
  pool: Pool,
  scope: TenantScope,
  input: {
    readonly cacheKey: string;
    readonly itemId: string;
    readonly locationId: string;
    readonly principalId: string;
    readonly queryId: string;
  },
): Promise<boolean> {
  return withModuleRole(pool, scope, async (client) => {
    const generation = await client.query<{ movement_generation: string }>(
      `SELECT movement_generation::text AS movement_generation
         FROM north_star_internal.semantic_aggregate_generations
        WHERE tenant_id = $1 AND environment_id = $2`,
      [scope.tenantId, scope.environmentId],
    );
    assert.equal(generation.rowCount, 1);
    await client.query(
      `INSERT INTO north_star_internal.semantic_aggregate_anchors (
         tenant_id, environment_id, cache_key, movement_generation, query_id,
         principal_id, release_content_hash, legal_entity_ids,
         parameter_values, temporal_horizons, filter_plan_digest, result_kind,
         selection_id, balance_value, result_precision, result_scale,
         base_unit_id, anchor_digest
       ) VALUES (
         $1, $2, $3, $4::bigint, $5, $6, $7, ARRAY[NULL]::uuid[], $8::jsonb,
         $9::jsonb, $10, 'exactDecimalResult', $11, '4', 38, 0, NULL, $12
       )`,
      [
        scope.tenantId,
        scope.environmentId,
        input.cacheKey,
        generation.rows[0]!.movement_generation,
        input.queryId,
        input.principalId,
        plantedReleaseContentHash,
        JSON.stringify({
          [reconciliationIds.parameterIds.atTime]: horizon,
          [reconciliationIds.parameterIds.itemId]: input.itemId,
          [reconciliationIds.parameterIds.legalEntityId]: 'not-a-uuid',
          [reconciliationIds.parameterIds.locationId]: input.locationId,
          [reconciliationIds.parameterIds.recordedAtHorizon]: horizon,
        }),
        JSON.stringify({
          [reconciliationIds.parameterIds.atTime]: horizon,
          [reconciliationIds.parameterIds.recordedAtHorizon]: horizon,
        }),
        plantedFilterPlanDigest,
        onHandSelectionId,
        plantedAnchorDigest,
      ],
    );
    return true;
  });
}

function adjustmentCommand(input: {
  readonly legalEntityId?: string;
  readonly lineId: string;
  readonly locationId: string;
  readonly quantityDelta: string;
  readonly sourceId: string;
  readonly transactionId: string;
}): InventoryAdjustmentPostingCommandV1 {
  return {
    authorization: {
      decision: 'ALLOW',
      evaluatorVersion: 'northstar.test-policy-evaluator/v1',
      policyVersion: 'northstar.test-policy/v1',
    },
    channel: 'API',
    effectiveAt,
    idempotencyKey: randomUUID(),
    legalEntityId: input.legalEntityId ?? legalEntityA,
    lines: [
      {
        itemId: itemPrimary,
        locationId: input.locationId,
        quantityDelta: input.quantityDelta,
        sourceLine: '1',
        transactionLineId: input.lineId,
        unitId: 'EA',
      },
    ],
    reason: { code: 'RECONCILE', narrative: 'Reconciliation fixture' },
    sourceId: input.sourceId,
    sourceRevision: 1,
    sourceType: 'adjustment',
    stockDimensionSetVersion: 'v1',
    transactionId: input.transactionId,
  };
}

function transferCommand(input: {
  readonly lineId: string;
  readonly quantity: string;
  readonly sourceId: string;
  readonly transactionId: string;
}): InventoryTransferPostingCommandV1 {
  return {
    authorization: {
      decision: 'ALLOW',
      evaluatorVersion: 'northstar.test-policy-evaluator/v1',
      policyVersion: 'northstar.test-policy/v1',
    },
    channel: 'API',
    effectiveAt,
    idempotencyKey: randomUUID(),
    legalEntityId: legalEntityA,
    lines: [
      {
        fromLocationId: locationPrimary,
        itemId: itemPrimary,
        quantity: input.quantity,
        sourceLine: '1',
        toLocationId: locationSecondary,
        transactionLineId: input.lineId,
        unitId: 'EA',
      },
    ],
    reason: { code: 'RECONCILE-TRANSFER', narrative: null },
    sourceId: input.sourceId,
    sourceRevision: 1,
    sourceType: 'transfer',
    stockDimensionSetVersion: 'v1',
    transactionId: input.transactionId,
  };
}

async function seedAdjustmentDraft(
  pool: Pool,
  scope: TenantScope,
  binding: TestStorageBinding,
  command: InventoryAdjustmentPostingCommandV1,
): Promise<void> {
  await withModuleRole(pool, scope, async (client) => {
    await insertTransactionHeader(client, scope, binding, {
      legalEntityId: command.legalEntityId,
      number: `ADJ-${command.transactionId.slice(0, 12)}`,
      reasonCode: command.reason.code,
      reasonNarrative: command.reason.narrative,
      sourceId: command.sourceId,
      sourceType: command.sourceType,
      state: 'draft',
      transactionId: command.transactionId,
      type: 'adjustment',
    });
    for (const line of command.lines) {
      const negative = line.quantityDelta.startsWith('-');
      await insertEntity(client, scope, binding, binding.transactionLine, {
        legalEntityId: command.legalEntityId,
        overrides: {
          inventory_transaction_line_from_location_id: negative
            ? line.locationId
            : null,
          inventory_transaction_line_item_id: line.itemId,
          inventory_transaction_line_line_number: Number(line.sourceLine),
          inventory_transaction_line_quantity: line.quantityDelta,
          inventory_transaction_line_to_location_id: negative
            ? null
            : line.locationId,
          inventory_transaction_line_unit_id: line.unitId,
        },
        recordId: line.transactionLineId,
        relationIds: {
          [binding.transaction.entity.entityId]: command.transactionId,
        },
      });
    }
  });
}

async function seedTransferDraft(
  pool: Pool,
  scope: TenantScope,
  binding: TestStorageBinding,
  command: InventoryTransferPostingCommandV1,
): Promise<void> {
  await withModuleRole(pool, scope, async (client) => {
    await insertTransactionHeader(client, scope, binding, {
      legalEntityId: command.legalEntityId,
      number: `TRF-${command.transactionId.slice(0, 12)}`,
      reasonCode: command.reason.code,
      reasonNarrative: command.reason.narrative,
      sourceId: command.sourceId,
      sourceType: command.sourceType,
      state: 'draft',
      transactionId: command.transactionId,
      type: 'transfer',
    });
    for (const line of command.lines) {
      await insertEntity(client, scope, binding, binding.transactionLine, {
        legalEntityId: command.legalEntityId,
        overrides: {
          inventory_transaction_line_from_location_id: line.fromLocationId,
          inventory_transaction_line_item_id: line.itemId,
          inventory_transaction_line_line_number: Number(line.sourceLine),
          inventory_transaction_line_quantity: line.quantity,
          inventory_transaction_line_to_location_id: line.toLocationId,
          inventory_transaction_line_unit_id: line.unitId,
        },
        recordId: line.transactionLineId,
        relationIds: {
          [binding.transaction.entity.entityId]: command.transactionId,
        },
      });
    }
  });
}

interface ShadowMovementInput {
  readonly legalEntityId: string;
  readonly locationId: string;
  readonly movementId: string;
  readonly quantityDelta: string;
  readonly sourceId: string;
  readonly transactionId: string;
  readonly transactionLineId: string;
}

/**
 * The exact failure the source-document arm exists for: the header and the line
 * are the real posting capability's output, and a second movement was appended
 * against that line. Nothing else in the system notices.
 */
async function seedShadowMovement(
  pool: Pool,
  scope: TenantScope,
  binding: TestStorageBinding,
  input: ShadowMovementInput,
): Promise<void> {
  await withModuleRole(pool, scope, (client) =>
    insertMovement(client, scope, binding, {
      itemId: itemPrimary,
      legalEntityId: input.legalEntityId,
      locationId: input.locationId,
      movementId: input.movementId,
      quantityDelta: input.quantityDelta,
      sourceId: input.sourceId,
      sourceLine: '1-shadow',
      sourceType: 'adjustment',
      transactionId: input.transactionId,
      transactionLineId: input.transactionLineId,
    }),
  );
}

async function seedUnpostedDocumentWithMovement(
  pool: Pool,
  scope: TenantScope,
  binding: TestStorageBinding,
  input: {
    readonly legalEntityId: string;
    readonly locationId: string;
    readonly movementId: string;
    readonly quantityDelta: string;
    readonly transactionId: string;
    readonly transactionLineId: string;
  },
): Promise<void> {
  await withModuleRole(pool, scope, async (client) => {
    await insertTransactionHeader(client, scope, binding, {
      legalEntityId: input.legalEntityId,
      number: `ORP-${input.transactionId.slice(0, 12)}`,
      reasonCode: 'RECONCILE',
      reasonNarrative: 'Never posted',
      sourceId: 'reconcile-orphan',
      sourceType: 'adjustment',
      state: 'draft',
      transactionId: input.transactionId,
      type: 'adjustment',
    });
    await insertEntity(client, scope, binding, binding.transactionLine, {
      legalEntityId: input.legalEntityId,
      overrides: {
        inventory_transaction_line_from_location_id: null,
        inventory_transaction_line_item_id: itemPrimary,
        inventory_transaction_line_line_number: 1,
        inventory_transaction_line_quantity: input.quantityDelta,
        inventory_transaction_line_to_location_id: input.locationId,
        inventory_transaction_line_unit_id: 'EA',
      },
      recordId: input.transactionLineId,
      relationIds: {
        [binding.transaction.entity.entityId]: input.transactionId,
      },
    });
    await insertMovement(client, scope, binding, {
      itemId: itemPrimary,
      legalEntityId: input.legalEntityId,
      locationId: input.locationId,
      movementId: input.movementId,
      quantityDelta: input.quantityDelta,
      sourceId: 'reconcile-orphan',
      sourceLine: '1',
      sourceType: 'adjustment',
      transactionId: input.transactionId,
      transactionLineId: input.transactionLineId,
    });
  });
}

async function seedPostedDocumentWithDivergentMovement(
  pool: Pool,
  scope: TenantScope,
  binding: TestStorageBinding,
  input: {
    readonly legalEntityId: string;
    readonly lineQuantity: string;
    readonly locationId: string;
    readonly movementQuantity: string;
  },
): Promise<{
  readonly movementId: string;
  readonly transactionId: string;
  readonly transactionLineId: string;
}> {
  const transactionId = randomUUID();
  const transactionLineId = randomUUID();
  const movementId = randomUUID();
  await withModuleRole(pool, scope, async (client) => {
    await insertTransactionHeader(client, scope, binding, {
      legalEntityId: input.legalEntityId,
      number: `TEN-${transactionId.slice(0, 12)}`,
      reasonCode: 'RECONCILE',
      reasonNarrative: 'Cross-tenant control',
      sourceId: 'reconcile-tenant-b',
      sourceType: 'adjustment',
      state: 'posted',
      transactionId,
      type: 'adjustment',
    });
    await insertEntity(client, scope, binding, binding.transactionLine, {
      legalEntityId: input.legalEntityId,
      overrides: {
        inventory_transaction_line_from_location_id: null,
        inventory_transaction_line_item_id: itemPrimary,
        inventory_transaction_line_line_number: 1,
        inventory_transaction_line_quantity: input.lineQuantity,
        inventory_transaction_line_to_location_id: input.locationId,
        inventory_transaction_line_unit_id: 'EA',
      },
      recordId: transactionLineId,
      relationIds: { [binding.transaction.entity.entityId]: transactionId },
    });
    await insertMovement(client, scope, binding, {
      itemId: itemPrimary,
      legalEntityId: input.legalEntityId,
      locationId: input.locationId,
      movementId,
      quantityDelta: input.movementQuantity,
      sourceId: 'reconcile-tenant-b',
      sourceLine: '1',
      sourceType: 'adjustment',
      transactionId,
      transactionLineId,
    });
  });
  return { movementId, transactionId, transactionLineId };
}

async function insertTransactionHeader(
  client: PoolClient,
  scope: TenantScope,
  binding: TestStorageBinding,
  input: {
    readonly legalEntityId: string;
    readonly number: string;
    readonly reasonCode: string;
    readonly reasonNarrative: string | null;
    readonly sourceId: string;
    readonly sourceType: string;
    readonly state: 'draft' | 'posted';
    readonly transactionId: string;
    readonly type: 'adjustment' | 'transfer';
  },
): Promise<void> {
  await insertEntity(client, scope, binding, binding.transaction, {
    legalEntityId: input.legalEntityId,
    overrides: {
      inventory_transaction_actor_id: scope.context.principalId,
      inventory_transaction_effective_at: effectiveAt,
      inventory_transaction_number: input.number,
      inventory_transaction_reason_code: input.reasonCode || null,
      inventory_transaction_reason_narrative: input.reasonNarrative,
      inventory_transaction_recorded_at: recordedAt,
      inventory_transaction_source_id: input.sourceId,
      inventory_transaction_source_type: input.sourceType,
      inventory_transaction_state: enumOption(
        field(binding.transaction, 'inventory_transaction_state'),
        input.state,
      ),
      inventory_transaction_type: enumOption(
        field(binding.transaction, 'inventory_transaction_type'),
        input.type,
      ),
    },
    recordId: input.transactionId,
    relationIds: {},
  });
}

async function insertMovement(
  client: PoolClient,
  scope: TenantScope,
  binding: TestStorageBinding,
  input: {
    readonly businessPeriod?: string;
    readonly effectiveAt?: string;
    readonly itemId: string;
    readonly legalEntityId: string;
    readonly locationId: string;
    readonly movementId: string;
    readonly postingRole?: string;
    readonly quantityDelta: string;
    readonly sourceId: string;
    readonly sourceLine: string;
    readonly sourceType: string;
    readonly transactionId: string;
    readonly transactionLineId: string;
  },
): Promise<void> {
  await insertEntity(client, scope, binding, binding.movement, {
    factBusinessPeriod: input.businessPeriod ?? businessPeriod,
    legalEntityId: input.legalEntityId,
    overrides: {
      inventory_movement_actor_id: scope.context.principalId,
      inventory_movement_effective_at: input.effectiveAt ?? effectiveAt,
      inventory_movement_item_id: input.itemId,
      inventory_movement_location_id: input.locationId,
      inventory_movement_posting_role: enumOption(
        field(binding.movement, 'inventory_movement_posting_role'),
        input.postingRole ?? 'adjustment',
      ),
      inventory_movement_quantity_delta: input.quantityDelta,
      inventory_movement_reason_code: 'RECONCILE',
      inventory_movement_reason_narrative: null,
      inventory_movement_recorded_at: recordedAt,
      inventory_movement_reversal_of_movement_id: null,
      inventory_movement_source_id: input.sourceId,
      inventory_movement_source_line: input.sourceLine,
      inventory_movement_source_revision: 1,
      inventory_movement_source_type: input.sourceType,
      inventory_movement_stock_dimension_set_version: enumOption(
        field(
          binding.movement,
          'inventory_movement_stock_dimension_set_version',
        ),
        'v1',
      ),
      inventory_movement_unit_id: 'EA',
    },
    recordId: input.movementId,
    relationIds: {
      [binding.transaction.entity.entityId]: input.transactionId,
      [binding.transactionLine.entity.entityId]: input.transactionLineId,
    },
  });
}

async function seedFoundation(
  pool: Pool,
  scope: TenantScope,
  binding: TestStorageBinding,
  input: { readonly legalEntityIds: readonly string[] },
): Promise<void> {
  await withModuleRole(pool, scope, async (client) => {
    for (const [index, legalEntityId] of input.legalEntityIds.entries()) {
      const present = await client.query(
        `SELECT 1 FROM ${table(binding, binding.legalEntity)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${quoted(binding.legalEntity.recordIdColumn)} = $3`,
        [scope.tenantId, scope.environmentId, legalEntityId],
      );
      if (present.rowCount !== 0) continue;
      await insertEntity(client, scope, binding, binding.legalEntity, {
        overrides: {
          legal_entity_code: `LE-${String(index + 1)}`,
          legal_entity_is_default: false,
          legal_entity_name: `Legal entity ${String(index + 1)}`,
          legal_entity_status: enumOption(
            field(binding.legalEntity, 'legal_entity_status'),
            'active',
          ),
        },
        recordId: legalEntityId,
        relationIds: {},
      });
    }
    await insertEntity(client, scope, binding, binding.item, {
      overrides: {
        item_base_unit: 'EA',
        item_code: 'ITEM-RECONCILE',
        item_name: 'Reconciliation item',
      },
      recordId: itemPrimary,
      relationIds: {},
    });
    for (const [index, locationId] of [
      locationPrimary,
      locationSecondary,
      locationOrphan,
    ].entries()) {
      await insertEntity(client, scope, binding, binding.location, {
        overrides: {
          location_code: `LOC-${String(index + 1)}`,
          location_name: `Location ${String(index + 1)}`,
        },
        recordId: locationId,
        relationIds: {},
      });
    }
  });
}

async function insertEntity(
  client: PoolClient,
  scope: TenantScope,
  binding: TestStorageBinding,
  entity: TestEntityBinding,
  input: {
    readonly factBusinessPeriod?: string;
    readonly legalEntityId?: string;
    readonly overrides: Record<string, unknown>;
    readonly recordId: string;
    readonly relationIds: Record<string, string>;
  },
): Promise<void> {
  const relationColumns = binding.storageTarget.relations.filter(
    (relation) =>
      relation.sourceEntityId === entity.entity.entityId &&
      relation.relationColumn.origin !== 'field',
  );
  const businessPeriodColumn = entity.entity.factStorage?.businessPeriod.column;
  if (businessPeriodColumn) assert.ok(input.factBusinessPeriod);
  const columns = [
    'tenant_id',
    'environment_id',
    ...(entity.legalEntityColumn ? [entity.legalEntityColumn] : []),
    ...(businessPeriodColumn ? [businessPeriodColumn] : []),
    entity.recordIdColumn,
    ...entity.entity.columns.map((column) => column.physicalName),
    ...relationColumns.map((relation) => relation.relationColumn.physicalName),
  ];
  const values = [
    scope.tenantId,
    scope.environmentId,
    ...(entity.legalEntityColumn ? [input.legalEntityId ?? null] : []),
    ...(businessPeriodColumn ? [input.factBusinessPeriod] : []),
    input.recordId,
    ...entity.entity.columns.map((column) =>
      Object.hasOwn(input.overrides, localField(column))
        ? input.overrides[localField(column)]
        : defaultFieldValue(column, input.recordId),
    ),
    ...relationColumns.map((relation) => {
      const value = input.relationIds[relation.targetEntityId];
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

async function withModuleRole<T>(
  pool: Pool,
  scope: TenantScope,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('lock_timeout',$1,true)", ['5s']);
    await client.query(
      `SELECT set_config('north_star.tenant_id',$1,true),
              set_config('north_star.environment_id',$2,true),
              set_config('north_star.principal_id',$3,true),
              set_config('north_star.request_id',$4,true)`,
      [
        scope.tenantId,
        scope.environmentId,
        scope.context.principalId,
        scope.context.requestId,
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

function invokeOnHand(
  gateway: SemanticQueryGateway,
  view: RequestRuntimeView,
  input: {
    readonly itemId: string;
    readonly legalEntityId: string;
    readonly locationId: string;
  },
): Promise<SemanticAggregateResultEnvelope> {
  return gateway.invokeAggregate(view, {
    arguments: {
      [reconciliationIds.parameterIds.atTime]: horizon,
      [reconciliationIds.parameterIds.itemId]: input.itemId,
      [reconciliationIds.parameterIds.legalEntityId]: input.legalEntityId,
      [reconciliationIds.parameterIds.locationId]: input.locationId,
      [reconciliationIds.parameterIds.recordedAtHorizon]: horizon,
    },
    queryId: reconciliationIds.onHandQueryId,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
}

class AllowPolicy implements CurrentPolicyGateway {
  async authorize(request: CurrentPolicyDecisionRequest) {
    void request;
    return {
      decision: 'ALLOW' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'inventory-reconciliation-policy/v1',
    };
  }

  async readCurrentVersion(subject: CurrentPolicySubject) {
    void subject;
    return { policyVersion: 'inventory-reconciliation-policy/v1' };
  }
}

async function issuedView(
  pool: Pool,
  scope: TenantScope,
  policy: CurrentPolicyGateway,
): Promise<RequestRuntimeView> {
  const identity: AuthenticatedIdentity = {
    environmentId: scope.environmentId,
    principalId: scope.context.principalId,
    tenantId: scope.tenantId,
  };
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => identity),
    new PostgresRequestRuntimeViewService(pool),
    policy,
  );
  return entry.run({}, async (view) => view);
}

function actorIssuer(principalId: string): TrustedActorEnvelopeIssuer {
  return new TrustedActorEnvelopeIssuer({
    async resolve() {
      return {
        approvingHumanId: null,
        delegation: null,
        executionPrincipal: { kind: 'HUMAN', principalId },
        initiatingHumanId: principalId,
        subject: null,
      };
    },
  });
}

async function actorEnvelope(
  context: TrustedRequestContext,
  principalId: string,
) {
  return actorIssuer(principalId).issue(context);
}

async function trustedContext(
  tenantId: string,
  environmentId: string,
  principalId: string,
): Promise<TrustedRequestContext> {
  const identity: AuthenticatedIdentity = {
    environmentId,
    principalId,
    tenantId,
  };
  return new AuthenticatedRequestEntryAdapter(async () => identity).enter({
    headers: { authorization: 'inventory-reconciliation' },
  });
}

async function migrateAndProvision(
  pool: Pool,
  contractReleaseRoot: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await runMigrations(client, await loadMigrations(migrationsDirectory));
    for (const tenant of [
      { environmentId: environmentA, slug: 'reconcile-a', tenantId: tenantA },
      { environmentId: environmentB, slug: 'reconcile-b', tenantId: tenantB },
    ]) {
      await client.query(
        'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
        [tenant.tenantId, tenant.slug],
      );
      await client.query(
        `INSERT INTO platform.environments (tenant_id, id, slug)
         VALUES ($1,$2,'production')`,
        [tenant.tenantId, tenant.environmentId],
      );
    }
    for (const provision of [
      {
        code: 'LE-A',
        environmentId: environmentA,
        legalEntityId: legalEntityA,
        tenantId: tenantA,
      },
      {
        code: 'LE-QUIET',
        environmentId: environmentA,
        legalEntityId: quietLegalEntityA,
        tenantId: tenantA,
      },
      {
        code: 'LE-WITNESS',
        environmentId: environmentA,
        legalEntityId: witnessLegalEntityA,
        tenantId: tenantA,
      },
      {
        code: 'LE-B',
        environmentId: environmentB,
        legalEntityId: legalEntityA,
        tenantId: tenantB,
      },
    ]) {
      await client.query(
        `SELECT platform.provision_inventory_scope(
           $1,$2,$3,$4,$5,'UTC','00:00:00',$6,1::smallint,'reject',0,
           'codeAndNarrative','codeOnly','codeAndNarrative',
           'codeAndNarrative','codeAndNarrative',NULL,NULL,NULL,NULL,NULL
         )`,
        [
          provision.tenantId,
          provision.environmentId,
          provision.legalEntityId,
          provision.code,
          `Legal entity ${provision.code}`,
          contractReleaseRoot,
        ],
      );
    }
  } finally {
    client.release();
  }
}

async function persistSequence(
  runtimePool: Pool,
  context: TrustedRequestContext,
  entries: ReadonlyArray<readonly [CompileSuccess, Record<string, unknown>]>,
): Promise<MintedUuid[]> {
  const repository = new PostgresImmutableReleaseRepository(runtimePool);
  const releases: MintedUuid[] = [];
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

async function setPointer(
  pool: Pool,
  scope: TenantScope,
  releaseId: MintedUuid,
): Promise<void> {
  await pool.query(
    'ALTER TABLE platform.active_release_pointers DISABLE TRIGGER active_release_pointer_exact_swap',
  );
  try {
    const result = await pool.query(
      `UPDATE platform.active_release_pointers SET release_id=$3, fence=fence+1
        WHERE tenant_id=$1 AND environment_id=$2`,
      [scope.tenantId, scope.environmentId, releaseId],
    );
    assert.equal(result.rowCount, 1);
  } finally {
    await pool.query(
      'ALTER TABLE platform.active_release_pointers ENABLE TRIGGER active_release_pointer_exact_swap',
    );
  }
}

async function grantExecutorAuthority(
  pool: Pool,
  scope: TenantScope,
): Promise<void> {
  await pool.query(
    'SELECT platform.set_release_executor_authority($1,$2,true,$2,$3)',
    [scope.tenantId, scope.context.principalId, randomUUID()],
  );
}

function buildFixture(): Fixture {
  const inventoryDefinition =
    composedApplicationDefinition() as unknown as Record<string, unknown>;
  const emptyDefinition = emptyDefinitionFrom(inventoryDefinition);
  const empty = mustCompile(moduleInput(emptyDefinition));
  const inventory = mustCompile(
    moduleInput(inventoryDefinition, expectedActiveReleaseFrom(empty)),
  );
  const storage = projectionPayload<StorageTargetPayloadV1>(
    inventory,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  return {
    empty,
    emptyDefinition,
    inventory,
    inventoryDefinition,
    storage: storage.payload,
    storageContentHash: storage.contentHash,
  };
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
    profile: profileForNormalizedBytes(definitionBytes(definition)),
  };
}

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

function testStorageBinding(
  target: StorageTargetPayloadV1,
): TestStorageBinding {
  const bind = (suffix: string): TestEntityBinding => {
    const entity = target.entities.find((candidate) =>
      candidate.entityId.endsWith(`:entity.${suffix}`),
    );
    assert.ok(entity, `missing ${suffix}`);
    return {
      archiveColumn: entity.archive.archivedAtColumn,
      entity,
      fields: new Map(
        entity.columns.map((column) => [localField(column), column]),
      ),
      legalEntityColumn: entity.legalEntity?.column ?? null,
      recordIdColumn: entity.recordIdentity.column,
      tableName: entity.physicalTableName,
    };
  };
  return {
    item: bind('item'),
    legalEntity: bind('legal_entity'),
    location: bind('location'),
    movement: bind('inventory_movement'),
    schemaName: target.providerAbi.managedSchema,
    storageTarget: target,
    transaction: bind('inventory_transaction'),
    transactionLine: bind('inventory_transaction_line'),
  };
}

function field(
  entity: TestEntityBinding,
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

function localField(column: StorageEntityTarget['columns'][number]): string {
  return column.canonicalFieldId.split(':field.').at(-1)!;
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
      return businessPeriod;
    case 'dateTimeFieldType':
      return recordedAt;
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
      return `${localField(column)}-${recordId.slice(0, 8)}`.slice(0, maximum);
    }
    case 'timeFieldType':
      return '00:00:00';
  }
}

function table(binding: TestStorageBinding, entity: TestEntityBinding): string {
  return `${quoted(binding.schemaName)}.${quoted(entity.tableName)}`;
}

function quoted(identifier: string): string {
  assert.match(identifier, /^[a-z][a-z0-9_]{0,62}$/u);
  return `"${identifier}"`;
}

function normalizeDatabaseDecimal(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/u, '').replace(/\.$/u, '');
}
