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
  INVENTORY_CONTRACT_V1,
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT as DECLARED_DEPENDENCY_ROOT,
} from '../../packages/domain/src/inventory/contracts.js';
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import {
  INVENTORY_POSTING_CAPABILITY_VERSION,
  InventoryPostingError,
  PostgresInventoryPostingService,
  type InventoryAdjustmentPostingCommandV1,
  type InventoryPostingRegistrationV1,
} from '../../packages/postgres-provider/src/inventory-posting-service.js';
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
import { TrustedActorEnvelopeIssuer } from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const migrations = resolve('db/migrations');

const tenantId = '1b000000-0000-4000-8000-000000000001';
const environmentId = '2b000000-0000-4000-8000-000000000002';
const legalSevenDayWindow = '3b000000-0000-4000-8000-000000000003';
const legalClosedWindow = '3b000000-0000-4000-8000-000000000004';
const principalId = '7b000000-0000-4000-8000-000000000007';
const itemId = '4b000000-0000-4000-8000-000000000004';
const locationId = '5b000000-0000-4000-8000-000000000005';

/**
 * Recorded time is injected, never sampled: the policy under test is arithmetic
 * on the gap between the recorded and the effective business period, so a
 * wall-clock sample would make the verdict depend on the day the suite runs
 * (AGENTS.md section 6).
 */
const recordedAt = '2026-08-04T13:00:00.000Z';
const recordedPeriod = '2026-08-04';

const sevenDayWindow = 7;
const closedWindow = 0;

/** Exactly `sevenDayWindow` days before `recordedPeriod`. */
const atWindowEdgeEffectiveAt = '2026-07-28T09:00:00.000Z';
const atWindowEdgePeriod = '2026-07-28';
/** One day further back than `sevenDayWindow` allows. */
const beyondWindowEffectiveAt = '2026-07-27T09:00:00.000Z';
const beyondWindowPeriod = '2026-07-27';
const sameDayEffectiveAt = '2026-08-04T09:00:00.000Z';
const forwardDatedEffectiveAt = '2026-08-11T09:00:00.000Z';
const forwardDatedPeriod = '2026-08-11';

type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];

interface EntityBinding {
  readonly entity: StorageEntityTarget;
  readonly fields: ReadonlyMap<string, StorageEntityTarget['columns'][number]>;
  readonly legalEntityColumn: string | null;
  readonly recordIdColumn: string;
  readonly tableName: string;
}

interface StorageBinding {
  readonly item: EntityBinding;
  readonly legalEntity: EntityBinding;
  readonly location: EntityBinding;
  readonly movement: EntityBinding;
  readonly movementBusinessPeriodColumn: string;
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
  readonly storageContentHash: string;
}

interface PostedMovement {
  readonly businessPeriod: string;
  readonly quantityDelta: string;
}

test(
  'the configured backdate window decides which effective period a posting may carry',
  { timeout: 600_000 },
  async (testContext) => {
    const fixture = await compiledFixture();
    const binding = storageBinding(fixture.storage);
    const recordedRefusals: string[] = [];

    await withEphemeralPostgres('g3-r3-backdate-policy', async (database) => {
      await migrateAndProvision(database.pool, fixture.inventory.releaseRoot);
      const runtimePool = new pg.Pool({
        ...database.connection,
        application_name: 'g3-r3-backdate',
        max: 4,
        user: 'north_star_runtime',
      });
      const materializerPool = new pg.Pool({
        ...database.connection,
        max: 1,
        user: 'north_star_module_materializer',
      });
      const moduleRuntimePool = new pg.Pool({
        ...database.connection,
        max: 1,
        user: 'north_star_module_runtime',
      });
      try {
        const context = await trustedContext();
        const releases = await persistSequence(runtimePool, context, [
          [fixture.empty, fixture.emptyDefinition],
          [fixture.inventory, fixture.inventoryDefinition],
        ]);
        await setPointer(database.pool, releases[0]!);
        await grantExecutorAuthority(database.pool);
        const prepared = await new PostgresModuleStorageMaterializer(
          materializerPool,
          moduleRuntimePool,
        ).prepare({
          context,
          expiresAt: '2099-01-01T00:00:00.000Z',
          generationId: randomUUID(),
          initiatedBy: principalId,
          preparationId: randomUUID(),
          targetReleaseId: releases[1]!,
        });
        assert.equal(prepared.schemaState, 'APPLIED');
        await setPointer(database.pool, releases[1]!);
        await seedFoundation(runtimePool, context, binding);

        const registration: InventoryPostingRegistrationV1 = {
          capabilityId: INVENTORY_CONTRACT_V1.capabilityId,
          capabilityVersion: INVENTORY_POSTING_CAPABILITY_VERSION,
          dependencySetRoot: DECLARED_DEPENDENCY_ROOT,
          releaseContentHash: fixture.inventory.releaseRoot,
          releaseId: releases[1]!,
          storageTarget: fixture.storage,
          storageTargetContentHash: fixture.storageContentHash,
        };
        const service = new PostgresInventoryPostingService(
          runtimePool,
          registration,
          { currentInstant: () => recordedAt },
        );
        const actor = await actorIssuer().issue(context);

        assert.deepEqual(
          await configuredBackdateWindows(database.pool),
          [
            { legalEntityId: legalSevenDayWindow, window: sevenDayWindow },
            { legalEntityId: legalClosedWindow, window: closedWindow },
          ],
          'the two scopes must differ only in the dial this test isolates',
        );

        // 1. The dial's own edge is inside the window.
        const edge = adjustmentCommand({
          effectiveAt: atWindowEdgeEffectiveAt,
          legalEntityId: legalSevenDayWindow,
          sourceId: 'backdate-at-window-edge',
        });
        await seedDraft(runtimePool, context, binding, edge);
        const posted = await service.postAdjustment(context, actor, edge);
        assert.equal(posted.replayed, false);
        assert.deepEqual(
          await movementsBySource(database.pool, binding, edge.sourceId),
          [{ businessPeriod: atWindowEdgePeriod, quantityDelta: '2' }],
          `a posting exactly ${String(sevenDayWindow)} days back must be admitted, not merely not-crash`,
        );

        // 2. One day further back is refused, by name, inside the transaction.
        const beyond = adjustmentCommand({
          effectiveAt: beyondWindowEffectiveAt,
          legalEntityId: legalSevenDayWindow,
          sourceId: 'backdate-beyond-window',
        });
        await seedDraft(runtimePool, context, binding, beyond);
        recordedRefusals.push(
          await recordTypedRefusal(
            `INVENTORY_BACKDATE_LIMIT_EXCEEDED: effective period ${beyondWindowPeriod} exceeds the ${String(sevenDayWindow)} day backdate window`,
            {
              effectivePeriod: beyondWindowPeriod,
              recordedPeriod,
            },
            () => service.postAdjustment(context, actor, beyond),
          ),
        );
        assert.deepEqual(
          await movementsBySource(database.pool, binding, beyond.sourceId),
          [],
          'the refusal must leave no movement behind',
        );
        assert.equal(
          await transactionState(database.pool, binding, beyond.transactionId),
          enumOption(
            field(binding.transaction, 'inventory_transaction_state'),
            'draft',
          ),
          'the refusal must roll the source document back to draft, not half-post it',
        );

        // 3. The policy is one-sided: it bounds backdating, never forward dating.
        const forward = adjustmentCommand({
          effectiveAt: forwardDatedEffectiveAt,
          legalEntityId: legalSevenDayWindow,
          sourceId: 'forward-dated',
        });
        await seedDraft(runtimePool, context, binding, forward);
        assert.equal(
          (await service.postAdjustment(context, actor, forward)).replayed,
          false,
        );
        assert.deepEqual(
          await movementsBySource(database.pool, binding, forward.sourceId),
          [{ businessPeriod: forwardDatedPeriod, quantityDelta: '2' }],
          'a future effective period is outside this dial, which bounds only backdating',
        );

        // 4. The DIAL is the cause, not the date. The command accepted at (1)
        //    is refused verbatim under a narrower window, and the refusal names
        //    the narrower window.
        const edgeUnderClosedWindow = adjustmentCommand({
          effectiveAt: atWindowEdgeEffectiveAt,
          legalEntityId: legalClosedWindow,
          sourceId: 'backdate-at-window-edge-closed-scope',
        });
        await seedDraft(runtimePool, context, binding, edgeUnderClosedWindow);
        recordedRefusals.push(
          await recordTypedRefusal(
            `INVENTORY_BACKDATE_LIMIT_EXCEEDED: effective period ${atWindowEdgePeriod} exceeds the ${String(closedWindow)} day backdate window`,
            {
              effectivePeriod: atWindowEdgePeriod,
              recordedPeriod,
            },
            () => service.postAdjustment(context, actor, edgeUnderClosedWindow),
          ),
        );
        assert.deepEqual(
          await movementsBySource(
            database.pool,
            binding,
            edgeUnderClosedWindow.sourceId,
          ),
          [],
        );

        // 5. ...and a zero-day window still admits the recorded day itself, so
        //    the narrow scope is narrow rather than shut.
        const sameDay = adjustmentCommand({
          effectiveAt: sameDayEffectiveAt,
          legalEntityId: legalClosedWindow,
          sourceId: 'same-day-under-closed-scope',
        });
        await seedDraft(runtimePool, context, binding, sameDay);
        assert.equal(
          (await service.postAdjustment(context, actor, sameDay)).replayed,
          false,
        );
        assert.deepEqual(
          await movementsBySource(database.pool, binding, sameDay.sourceId),
          [{ businessPeriod: recordedPeriod, quantityDelta: '2' }],
          'a zero-day window must still admit same-day postings',
        );
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          moduleRuntimePool.end(),
        ]);
      }
    });

    assert.equal(recordedRefusals.length, 2);
    for (const refusal of recordedRefusals) {
      testContext.diagnostic(`G3-R3 EXECUTED RED: ${refusal}`);
    }
  },
);

/**
 * The refusal must be the typed one, with the window it enforced and the two
 * periods it compared. Asserting only that something threw would accept a
 * refusal produced by any of the six checks that run before this one.
 */
async function recordTypedRefusal(
  expectedMessage: string,
  expectedDetails: Readonly<Record<string, string>>,
  run: () => Promise<unknown>,
): Promise<string> {
  let recorded: string | undefined;
  await assert.rejects(run, (error: unknown) => {
    assert.ok(
      error instanceof InventoryPostingError,
      'the backdate refusal must be the capability-typed error',
    );
    assert.equal(error.code, 'INVENTORY_BACKDATE_LIMIT_EXCEEDED');
    assert.equal(error.message, expectedMessage);
    assert.deepEqual({ ...error.details }, { ...expectedDetails });
    recorded = error.message;
    return true;
  });
  assert.ok(recorded);
  return recorded;
}

async function configuredBackdateWindows(
  pool: Pool,
): Promise<Array<{ legalEntityId: string; window: number }>> {
  const result = await pool.query<{
    legal_entity_id: string;
    maximum_backdate_days: number;
  }>(
    `SELECT legal_entity_id, maximum_backdate_days
       FROM platform.inventory_posting_configurations
      WHERE tenant_id = $1 AND environment_id = $2
      ORDER BY maximum_backdate_days DESC`,
    [tenantId, environmentId],
  );
  return result.rows.map((row) => ({
    legalEntityId: row.legal_entity_id,
    window: row.maximum_backdate_days,
  }));
}

async function movementsBySource(
  pool: Pool,
  binding: StorageBinding,
  sourceId: string,
): Promise<PostedMovement[]> {
  const result = await pool.query<{
    business_period: Date;
    quantity_delta: string;
  }>(
    `SELECT ${quoted(binding.movementBusinessPeriodColumn)} AS business_period,
            ${quoted(field(binding.movement, 'inventory_movement_quantity_delta').physicalName)} AS quantity_delta
       FROM ${table(binding, binding.movement)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(field(binding.movement, 'inventory_movement_source_id').physicalName)} = $3
      ORDER BY ${quoted(field(binding.movement, 'inventory_movement_source_line').physicalName)}`,
    [tenantId, environmentId, sourceId],
  );
  return result.rows.map((row) => ({
    businessPeriod: row.business_period.toISOString().slice(0, 10),
    quantityDelta: normalizeDatabaseDecimal(String(row.quantity_delta)),
  }));
}

async function transactionState(
  pool: Pool,
  binding: StorageBinding,
  transactionId: string,
): Promise<string> {
  const result = await pool.query<{ state: string }>(
    `SELECT ${quoted(field(binding.transaction, 'inventory_transaction_state').physicalName)} AS state
       FROM ${table(binding, binding.transaction)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.transaction.recordIdColumn)} = $3`,
    [tenantId, environmentId, transactionId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0]!.state;
}

function adjustmentCommand(input: {
  readonly effectiveAt: string;
  readonly legalEntityId: string;
  readonly sourceId: string;
}): InventoryAdjustmentPostingCommandV1 {
  return {
    authorization: {
      decision: 'ALLOW',
      evaluatorVersion: 'g3-r3-evaluator/v1',
      policyVersion: 'g3-r3-policy/v1',
    },
    channel: 'API',
    effectiveAt: input.effectiveAt,
    idempotencyKey: randomUUID(),
    legalEntityId: input.legalEntityId,
    lines: [
      {
        itemId,
        locationId,
        quantityDelta: '2',
        sourceLine: '1',
        transactionLineId: randomUUID(),
        unitId: 'EA',
      },
    ],
    reason: {
      code: 'BACKDATE-POLICY',
      narrative: 'Backdate policy control posting',
    },
    sourceId: input.sourceId,
    sourceRevision: 1,
    sourceType: 'adjustment',
    stockDimensionSetVersion: 'v1',
    transactionId: randomUUID(),
  };
}

async function seedDraft(
  pool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
  command: InventoryAdjustmentPostingCommandV1,
): Promise<void> {
  await withModuleRole(pool, context, async (client) => {
    await insertEntity(
      client,
      binding,
      binding.transaction,
      {
        inventory_transaction_actor_id: principalId,
        inventory_transaction_effective_at: command.effectiveAt,
        inventory_transaction_number: `BD-${command.transactionId.slice(0, 12)}`,
        inventory_transaction_reason_code: command.reason.code,
        inventory_transaction_reason_narrative: command.reason.narrative,
        inventory_transaction_recorded_at: recordedAt,
        inventory_transaction_source_id: command.sourceId,
        inventory_transaction_source_type: command.sourceType,
        inventory_transaction_state: enumOption(
          field(binding.transaction, 'inventory_transaction_state'),
          'draft',
        ),
        inventory_transaction_type: enumOption(
          field(binding.transaction, 'inventory_transaction_type'),
          'adjustment',
        ),
      },
      command.transactionId,
      command.legalEntityId,
      {},
    );
    for (const line of command.lines) {
      await insertEntity(
        client,
        binding,
        binding.transactionLine,
        {
          inventory_transaction_line_from_location_id: null,
          inventory_transaction_line_item_id: line.itemId,
          inventory_transaction_line_line_number: Number(line.sourceLine),
          inventory_transaction_line_quantity: line.quantityDelta,
          inventory_transaction_line_to_location_id: line.locationId,
          inventory_transaction_line_unit_id: line.unitId,
        },
        line.transactionLineId,
        command.legalEntityId,
        { [binding.transaction.entity.entityId]: command.transactionId },
      );
    }
  });
}

async function seedFoundation(
  pool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
): Promise<void> {
  await withModuleRole(pool, context, async (client) => {
    for (const [index, entity] of [
      legalSevenDayWindow,
      legalClosedWindow,
    ].entries()) {
      const present = await client.query(
        `SELECT 1 FROM ${table(binding, binding.legalEntity)}
          WHERE tenant_id=$1 AND environment_id=$2
            AND ${quoted(binding.legalEntity.recordIdColumn)}=$3`,
        [tenantId, environmentId, entity],
      );
      if (present.rowCount === 0) {
        await insertEntity(
          client,
          binding,
          binding.legalEntity,
          {
            legal_entity_code: `LE-BD-${String(index + 1)}`,
            legal_entity_is_default: false,
            legal_entity_name: `Backdate legal entity ${String(index + 1)}`,
            legal_entity_status: enumOption(
              field(binding.legalEntity, 'legal_entity_status'),
              'active',
            ),
          },
          entity,
          null,
          {},
        );
      }
    }
    await insertEntity(
      client,
      binding,
      binding.item,
      {
        item_base_unit: 'EA',
        item_code: 'ITEM-BACKDATE',
        item_name: 'Backdate policy item',
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
        location_code: 'LOC-BACKDATE',
        location_name: 'Backdate policy location',
      },
      locationId,
      null,
      {},
    );
  });
}

let fixturePromise: Promise<Fixture> | undefined;

async function compiledFixture(): Promise<Fixture> {
  fixturePromise ??= buildFixture();
  return fixturePromise;
}

async function buildFixture(): Promise<Fixture> {
  const inventoryDefinition = await loadInventoryDefinition();
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

async function loadInventoryDefinition(): Promise<Record<string, unknown>> {
  const applicationBuilder: unknown =
    await import('../../packages/domain/src/app/builder.js');
  assert.ok(isRecord(applicationBuilder));
  assert.equal(
    typeof applicationBuilder.composedApplicationDefinition,
    'function',
  );
  const definition = (
    applicationBuilder.composedApplicationDefinition as () => unknown
  )();
  assert.ok(isRecord(definition));
  return definition;
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
      : { normalizationProfileVersion: declared.normalizationProfileVersion }),
  };
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
      [tenantId, 'inventory-backdate-policy'],
    );
    await client.query(
      `INSERT INTO platform.environments (tenant_id, id, slug)
       VALUES ($1,$2,'production')`,
      [tenantId, environmentId],
    );
    for (const scope of [
      { id: legalSevenDayWindow, label: '1', window: sevenDayWindow },
      { id: legalClosedWindow, label: '2', window: closedWindow },
    ]) {
      await client.query(
        `SELECT platform.provision_inventory_scope(
           $1,$2,$3,$4,$5,'UTC','00:00:00',$6,
           1::smallint,'reject',$7,'codeAndNarrative','codeOnly',
           'codeAndNarrative','codeAndNarrative','codeAndNarrative',
           NULL,NULL,NULL,NULL,NULL
         )`,
        [
          tenantId,
          environmentId,
          scope.id,
          `LE-BD-${scope.label}`,
          `Backdate legal entity ${scope.label}`,
          contractReleaseRoot,
          scope.window,
        ],
      );
    }
  } finally {
    client.release();
  }
}

function identity(): AuthenticatedIdentity {
  return { environmentId, principalId, tenantId };
}

async function trustedContext(): Promise<TrustedRequestContext> {
  return new AuthenticatedRequestEntryAdapter(async () => identity()).enter({
    headers: { authorization: 'inventory-backdate-policy' },
  });
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

async function insertEntity(
  client: PoolClient,
  binding: StorageBinding,
  entity: EntityBinding,
  overrides: Record<string, unknown>,
  recordId: string,
  scopedLegalEntityId: string | null,
  relationIds: Record<string, string>,
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
    entity.recordIdColumn,
    ...entity.entity.columns.map((column) => column.physicalName),
    ...relationColumns.map((relation) => relation.relationColumn.physicalName),
  ];
  const values = [
    tenantId,
    environmentId,
    ...(entity.legalEntityColumn ? [scopedLegalEntityId] : []),
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

function storageBinding(target: StorageTargetPayloadV1): StorageBinding {
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
      tableName: entity.physicalTableName,
    };
  };
  const movement = bind('inventory_movement');
  assert.ok(movement.entity.factStorage);
  return {
    item: bind('item'),
    legalEntity: bind('legal_entity'),
    location: bind('location'),
    movement,
    movementBusinessPeriodColumn:
      movement.entity.factStorage.businessPeriod.column,
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
      return '2026-08-04';
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
      return `${localField(column)}-${recordId.slice(-8)}`.slice(0, maximum);
    }
    case 'timeFieldType':
      return '00:00:00';
  }
}

function localField(column: StorageEntityTarget['columns'][number]): string {
  return column.canonicalFieldId.split(':field.').at(-1)!;
}

function table(binding: StorageBinding, entity: EntityBinding): string {
  return `${quoted(binding.schemaName)}.${quoted(entity.tableName)}`;
}

function quoted(identifier: string): string {
  assert.match(identifier, /^[a-z][a-z0-9_]{0,62}$/u);
  return `"${identifier}"`;
}

function normalizeDatabaseDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed === '-0' ? '0' : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
