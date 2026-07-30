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
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  PostgresInventoryPostingService,
  type InventoryPostingRegistrationV1,
  type InventoryStockCountPostingCommandV1,
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
const tenantId = '12000000-0000-4000-8000-000000000001';
const environmentId = '23000000-0000-4000-8000-000000000002';
const legalEntityId = '34000000-0000-4000-8000-000000000003';
const principalId = '78000000-0000-4000-8000-000000000007';
const itemId = '45000000-0000-4000-8000-000000000004';
const locationId = '56000000-0000-4000-8000-000000000005';
const recordedAt = '2026-07-30T13:00:00.000Z';
const effectiveAt = '2026-07-30T12:00:00.000Z';

type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];

interface EntityBinding {
  entity: StorageEntityTarget;
  fields: Map<string, StorageEntityTarget['columns'][number]>;
  legalEntityColumn: string | null;
  recordIdColumn: string;
  revisionColumn: string;
  tableName: string;
}

interface StorageBinding {
  item: EntityBinding;
  legalEntity: EntityBinding;
  location: EntityBinding;
  movement: EntityBinding;
  schemaName: string;
  stockCount: EntityBinding;
  stockCountLine: EntityBinding;
  storageTarget: StorageTargetPayloadV1;
  transaction: EntityBinding;
  transactionLine: EntityBinding;
}

interface Fixture {
  empty: CompileSuccess;
  emptyDefinition: Record<string, unknown>;
  inventory: CompileSuccess;
  inventoryDefinition: Record<string, unknown>;
  storage: StorageTargetPayloadV1;
  storageContentHash: string;
}

interface TraceEntry {
  text: string;
  values: readonly unknown[];
}

test('stock-count posting preserves three-value evidence and appends correction and exact reversal through the shared protocol', async () => {
  const fixture = await compiledFixture();
  const binding = storageBinding(fixture.storage);
  await withEphemeralPostgres('inventory-stock-count', async (database) => {
    await migrateAndProvision(database.pool, fixture.inventory.releaseRoot);
    const runtimePool = new pg.Pool({
      ...database.connection,
      application_name: 'g3-p4b-stock-count',
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

      const trace: TraceEntry[] = [];
      const tracedPool = tracingPool(runtimePool, trace);
      const registration: InventoryPostingRegistrationV1 = {
        capabilityId: INVENTORY_CONTRACT_V1.capabilityId,
        capabilityVersion: INVENTORY_POSTING_CAPABILITY_VERSION,
        dependencySetRoot: DECLARED_DEPENDENCY_ROOT,
        releaseContentHash: fixture.inventory.releaseRoot,
        releaseId: releases[1]!,
        storageTarget: fixture.storage,
        storageTargetContentHash: fixture.storageContentHash,
      };
      assert.equal(
        DECLARED_DEPENDENCY_ROOT,
        INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
      );
      const service = new PostgresInventoryPostingService(
        tracedPool,
        registration,
        { currentInstant: () => recordedAt },
      );
      const actor = await new TrustedActorEnvelopeIssuer({
        resolve: async () => ({
          approvingHumanId: null,
          delegation: null,
          executionPrincipal: { kind: 'HUMAN', principalId },
          initiatingHumanId: principalId,
          subject: null,
        }),
      }).issue(context);

      const initial = countCommand({
        countedQuantity: '5',
        expectedQuantity: '0',
        kind: 'initial',
        sequence: 1,
        supersedesStockCountId: null,
        varianceQuantity: '5',
      });
      await seedReviewedCount(runtimePool, context, binding, initial);
      const initialResult = await service.postStockCount(
        context,
        actor,
        initial,
      );
      assertThreeValues(initialResult.stockCountEvidence, '0', '5', '5');
      assert.equal(initialResult.movements[0]?.quantityDelta, '5');
      assertProtocolTrace(trace.splice(0), binding);

      const correction = countCommand({
        countedQuantity: '7',
        expectedQuantity: '5',
        kind: 'correction',
        sequence: 2,
        supersedesStockCountId: initial.stockCountId,
        varianceQuantity: '2',
      });
      await seedReviewedCount(runtimePool, context, binding, correction);
      const correctionResult = await service.postStockCount(
        context,
        actor,
        correction,
      );
      assertThreeValues(correctionResult.stockCountEvidence, '5', '7', '2');
      assert.equal(correctionResult.movements[0]?.quantityDelta, '2');
      assert.equal(
        correctionResult.stockCountEvidence?.supersedesStockCountId,
        initial.stockCountId,
      );
      assertProtocolTrace(trace.splice(0), binding);

      const reversal = countCommand({
        countedQuantity: '5',
        expectedQuantity: '7',
        kind: 'reversal',
        reversalOfMovementId: correctionResult.movements[0]!.movementId,
        sequence: 3,
        supersedesStockCountId: correction.stockCountId,
        varianceQuantity: '-2',
      });
      await seedReviewedCount(runtimePool, context, binding, reversal);
      const reversalResult = await service.postStockCount(
        context,
        actor,
        reversal,
      );
      assertThreeValues(reversalResult.stockCountEvidence, '7', '5', '-2');
      assert.equal(reversalResult.movements[0]?.quantityDelta, '-2');
      assert.equal(
        reversalResult.stockCountEvidence?.lines[0]?.reversalOfMovementId,
        correctionResult.movements[0]!.movementId,
      );
      assertProtocolTrace(trace.splice(0), binding);

      const replay = await service.postStockCount(context, actor, reversal);
      assert.equal(replay.replayed, true);
      assert.deepEqual(
        replay.stockCountEvidence,
        reversalResult.stockCountEvidence,
      );
      const receipt = await database.pool.query<{
        input_digest_version: number;
        mutation_result: Record<string, unknown>;
      }>(
        `SELECT input_digest_version, mutation_result
             FROM platform.semantic_operation_receipts
            WHERE tenant_id=$1 AND environment_id=$2
              AND idempotency_key=$3`,
        [tenantId, environmentId, reversal.idempotencyKey],
      );
      assert.equal(receipt.rows[0]?.input_digest_version, 3);

      const persisted = await readPersistedCountChain(
        runtimePool,
        context,
        binding,
      );
      assert.equal(persisted.sessions.length, 3);
      assert.equal(persisted.lines.length, 3);
      assert.deepEqual(
        persisted.lines.map((line) => [
          normalizeDatabaseDecimal(String(line.expected)),
          normalizeDatabaseDecimal(String(line.counted)),
          normalizeDatabaseDecimal(String(line.variance)),
        ]),
        [
          ['0', '5', '5'],
          ['5', '7', '2'],
          ['7', '5', '-2'],
        ],
      );
      assert.equal(persisted.movements.length, 3);
      assert.equal(
        String(persisted.movements[2]?.reversal).toLowerCase(),
        correctionResult.movements[0]!.movementId,
      );

      for (const entity of [binding.stockCount, binding.stockCountLine]) {
        await assert.rejects(
          withModuleRole(runtimePool, context, (client) =>
            client.query(
              `DELETE FROM ${table(binding, entity)}
                WHERE tenant_id=$1 AND environment_id=$2`,
              [tenantId, environmentId],
            ),
          ),
          'removing the no-hard-delete protection must make this DELETE succeed',
        );
      }
      const retained = await readPersistedCountChain(
        runtimePool,
        context,
        binding,
      );
      assert.equal(retained.sessions.length, 3);
      assert.equal(retained.lines.length, 3);
      assert.equal(retained.movements.length, 3);

      const trust = await database.pool.query<{
        changes: unknown;
        payload: unknown;
      }>(
        `SELECT change.changes, event.payload
             FROM platform.trust_business_change_documents AS change
             JOIN platform.trust_domain_events AS event
               ON event.tenant_id=change.tenant_id
              AND event.environment_id=change.environment_id
              AND event.change_document_id=change.change_document_id
            WHERE change.tenant_id=$1 AND change.environment_id=$2
              AND change.action_id=$3`,
        [tenantId, environmentId, INVENTORY_CONTRACT_V1.capabilityId],
      );
      assert.ok(trust.rows.length >= 3);
      const observedEvidence = [
        initialResult.stockCountEvidence,
        correctionResult.stockCountEvidence,
        reversalResult.stockCountEvidence,
        receipt.rows[0]?.mutation_result,
        ...trust.rows.flatMap((row) => [row.changes, row.payload]),
      ];
      assert.deepEqual(monetaryMembers(observedEvidence), []);
      assert.deepEqual(
        monetaryMembers({
          fieldId: 'unitCost',
          newState: { value: '1.00' },
        }),
        ['unitCost'],
        'the scan must inspect semantic fieldId values, not only property names',
      );
    } finally {
      await Promise.all([
        runtimePool.end(),
        materializerPool.end(),
        moduleRuntimePool.end(),
      ]);
    }
  });
});

function countCommand(input: {
  countedQuantity: string;
  expectedQuantity: string;
  kind: 'correction' | 'initial' | 'reversal';
  reversalOfMovementId?: string;
  sequence: number;
  supersedesStockCountId: string | null;
  varianceQuantity: string;
}): InventoryStockCountPostingCommandV1 {
  const suffix = String(input.sequence).padStart(2, '0');
  const stockCountId = `61000000-0000-4000-8000-0000000000${suffix}`;
  return {
    authorization: {
      decision: 'ALLOW',
      evaluatorVersion: 'stock-count-policy/v1',
      policyVersion: 'stock-count-policy/v1',
    },
    channel: 'API',
    effectiveAt,
    idempotencyKey: `62000000-0000-4000-8000-0000000000${suffix}`,
    kind: input.kind,
    legalEntityId,
    lines: [
      {
        countedQuantity: input.countedQuantity,
        expectedQuantity: input.expectedQuantity,
        itemId,
        reversalOfMovementId: input.reversalOfMovementId ?? null,
        sourceLine: String(input.sequence),
        stockCountLineId: `63000000-0000-4000-8000-0000000000${suffix}`,
        transactionLineId: `64000000-0000-4000-8000-0000000000${suffix}`,
        unitId: 'EA',
        varianceQuantity: input.varianceQuantity,
      },
    ],
    locationId,
    reason: { code: 'PHYSICAL_COUNT', narrative: 'Reviewed physical count' },
    sourceId: stockCountId,
    sourceRevision: 1,
    sourceType: 'stockCount',
    stockCountId,
    stockDimensionSetVersion: 'v1',
    supersedesStockCountId: input.supersedesStockCountId,
    transactionId: `65000000-0000-4000-8000-0000000000${suffix}`,
  };
}

function assertThreeValues(
  evidence: Awaited<
    ReturnType<PostgresInventoryPostingService['postStockCount']>
  >['stockCountEvidence'],
  expected: string,
  counted: string,
  variance: string,
): void {
  assert.ok(evidence);
  assert.equal(evidence.lines.length, 1);
  assert.equal(
    evidence.lines[0]?.expectedQuantity,
    expected,
    'deleting the expectedQuantity persistence/read-back line must fail here',
  );
  assert.equal(
    evidence.lines[0]?.countedQuantity,
    counted,
    'deleting the countedQuantity persistence/read-back line must fail here',
  );
  assert.equal(
    evidence.lines[0]?.varianceQuantity,
    variance,
    'deleting the varianceQuantity persistence/read-back line must fail here',
  );
}

function tracingPool(pool: Pool, trace: TraceEntry[]): Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'connect') {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(clientTarget, clientProperty, clientReceiver) {
            if (clientProperty !== 'query') {
              const value = Reflect.get(
                clientTarget,
                clientProperty,
                clientReceiver,
              ) as unknown;
              return typeof value === 'function'
                ? value.bind(clientTarget)
                : value;
            }
            return (...arguments_: unknown[]) => {
              const query = arguments_[0];
              const values = Array.isArray(arguments_[1])
                ? (arguments_[1] as readonly unknown[])
                : [];
              trace.push({
                text:
                  typeof query === 'string'
                    ? query
                    : String((query as { text?: unknown }).text ?? ''),
                values,
              });
              return Reflect.apply(
                clientTarget.query,
                clientTarget,
                arguments_,
              );
            };
          },
        });
      };
    },
  });
}

function assertProtocolTrace(
  trace: readonly TraceEntry[],
  binding: StorageBinding,
): void {
  const begin = trace.findIndex((entry) => entry.text === 'BEGIN');
  const timeout = trace.findIndex((entry) =>
    entry.text.includes("set_config('lock_timeout', $1::text, true)"),
  );
  const advisories = trace
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.text.includes('pg_advisory_xact_lock'));
  const firstBusinessRead = trace.findIndex((entry) =>
    entry.text.includes(table(binding, binding.stockCount)),
  );
  const savepoints = trace.filter((entry) =>
    entry.text.startsWith('SAVEPOINT inventory_posting_write'),
  );
  assert.ok(begin >= 0);
  assert.ok(timeout > begin);
  assert.equal(trace[timeout]?.values[0], '15000ms');
  assert.equal(advisories.length >= 2, true);
  assert.ok(advisories[0]!.index > timeout);
  assert.ok(advisories[1]!.index > advisories[0]!.index);
  assert.ok(firstBusinessRead > advisories[1]!.index);
  assert.equal(
    savepoints.length,
    1,
    'forking stock-count posting or adding a second savepoint must fail here',
  );
}

function monetaryMembers(value: unknown): string[] {
  const money = /(?:amount|money|monetary|valuation|cost|price|currency)/iu;
  const found: string[] = [];
  const inspect = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(inspect);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (money.test(key)) found.push(key);
      if (
        key === 'fieldId' &&
        typeof nested === 'string' &&
        money.test(nested)
      ) {
        found.push(nested);
      }
      inspect(nested);
    }
  };
  inspect(value);
  return found.toSorted();
}

async function readPersistedCountChain(
  pool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
): Promise<{
  lines: Array<Record<string, unknown>>;
  movements: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
}> {
  return withModuleRole(pool, context, async (client) => {
    const sessions = await client.query<Record<string, unknown>>(
      `SELECT * FROM ${table(binding, binding.stockCount)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(binding.stockCount.legalEntityColumn!)}=$3
          AND archived_at IS NULL
        ORDER BY ${quoted(binding.stockCount.recordIdColumn)}`,
      [tenantId, environmentId, legalEntityId],
    );
    const lines = await client.query<Record<string, unknown>>(
      `SELECT ${quoted(field(binding.stockCountLine, 'stock_count_line_expected_quantity').physicalName)} AS expected,
              ${quoted(field(binding.stockCountLine, 'stock_count_line_counted_quantity').physicalName)} AS counted,
              ${quoted(field(binding.stockCountLine, 'stock_count_line_variance_quantity').physicalName)} AS variance
         FROM ${table(binding, binding.stockCountLine)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(binding.stockCountLine.legalEntityColumn!)}=$3
          AND archived_at IS NULL
        ORDER BY ${quoted(field(binding.stockCountLine, 'stock_count_line_line_number').physicalName)}`,
      [tenantId, environmentId, legalEntityId],
    );
    const movements = await client.query<Record<string, unknown>>(
      `SELECT ${quoted(field(binding.movement, 'inventory_movement_reversal_of_movement_id').physicalName)} AS reversal
         FROM ${table(binding, binding.movement)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(binding.movement.legalEntityColumn!)}=$3
        ORDER BY ${quoted(field(binding.movement, 'inventory_movement_source_line').physicalName)}`,
      [tenantId, environmentId, legalEntityId],
    );
    return {
      lines: lines.rows,
      movements: movements.rows,
      sessions: sessions.rows,
    };
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
  const [loaded, applicationBuilder]: unknown[] = await Promise.all([
    import('../../packages/domain/src/inventory/definition.js'),
    import('../../packages/domain/src/app/builder.js'),
  ]);
  assert.ok(isRecord(loaded));
  assert.ok(isRecord(applicationBuilder));
  assert.equal(typeof loaded.inventoryModuleDefinition, 'function');
  assert.equal(
    typeof applicationBuilder.composedApplicationDefinition,
    'function',
  );
  assert.equal(typeof applicationBuilder.APPLICATION_NAMESPACE, 'string');
  const definition = (
    applicationBuilder.composedApplicationDefinition as () => unknown
  )();
  const inventory = (
    loaded.inventoryModuleDefinition as (namespace: string) => unknown
  )(String(applicationBuilder.APPLICATION_NAMESPACE));
  assert.ok(isRecord(definition));
  assert.ok(isRecord(inventory));
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
    profile: { ...MODULE_COMPILER_PROFILE },
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

async function migrateAndProvision(
  pool: Pool,
  contractReleaseRoot: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await runMigrations(client, await loadMigrations(migrations));
    await client.query(
      'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
      [tenantId, 'inventory-stock-count'],
    );
    await client.query(
      `INSERT INTO platform.environments (tenant_id, id, slug)
       VALUES ($1,$2,'production')`,
      [tenantId, environmentId],
    );
    await client.query(
      `SELECT platform.provision_inventory_scope(
         $1,$2,$3,'LE-COUNT','Count legal entity','UTC','00:00:00',$4,
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
    headers: { authorization: 'inventory-stock-count' },
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

async function seedFoundation(
  pool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
): Promise<void> {
  await withModuleRole(pool, context, async (client) => {
    const present = await client.query(
      `SELECT 1 FROM ${table(binding, binding.legalEntity)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quoted(binding.legalEntity.recordIdColumn)}=$3`,
      [tenantId, environmentId, legalEntityId],
    );
    if (present.rowCount === 0) {
      await insertEntity(
        client,
        binding,
        binding.legalEntity,
        {
          legal_entity_code: 'LE-COUNT',
          legal_entity_is_default: false,
          legal_entity_name: 'Count legal entity',
          legal_entity_status: enumOption(
            field(binding.legalEntity, 'legal_entity_status'),
            'active',
          ),
        },
        legalEntityId,
        null,
        {},
      );
    }
    await insertEntity(
      client,
      binding,
      binding.item,
      {
        item_base_unit: 'EA',
        item_code: 'ITEM-COUNT-UNIQUE',
        item_name: 'Physical count item',
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
        location_code: 'LOC-COUNT-UNIQUE',
        location_name: 'Physical count location',
      },
      locationId,
      null,
      {},
    );
  });
}

async function seedReviewedCount(
  pool: Pool,
  context: TrustedRequestContext,
  binding: StorageBinding,
  command: InventoryStockCountPostingCommandV1,
): Promise<void> {
  await withModuleRole(pool, context, async (client) => {
    await insertEntity(
      client,
      binding,
      binding.transaction,
      {
        inventory_transaction_actor_id: principalId,
        inventory_transaction_effective_at: command.effectiveAt,
        inventory_transaction_number: `COUNT-TXN-${command.lines[0]!.sourceLine}`,
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
          'count_correction',
        ),
      },
      command.transactionId,
      command.legalEntityId,
      {},
    );
    for (const line of command.lines) {
      const negative = line.varianceQuantity.startsWith('-');
      await insertEntity(
        client,
        binding,
        binding.transactionLine,
        {
          inventory_transaction_line_from_location_id: negative
            ? command.locationId
            : null,
          inventory_transaction_line_item_id: line.itemId,
          inventory_transaction_line_line_number: Number(line.sourceLine),
          inventory_transaction_line_quantity: line.varianceQuantity,
          inventory_transaction_line_to_location_id: negative
            ? null
            : command.locationId,
          inventory_transaction_line_unit_id: line.unitId,
        },
        line.transactionLineId,
        command.legalEntityId,
        { [binding.transaction.entity.entityId]: command.transactionId },
      );
    }
    await insertEntity(
      client,
      binding,
      binding.stockCount,
      {
        stock_count_actor_id: null,
        stock_count_counted_at: command.effectiveAt,
        stock_count_kind: enumOption(
          field(binding.stockCount, 'stock_count_kind'),
          command.kind,
        ),
        stock_count_location_id: command.locationId,
        stock_count_number: `COUNT-SESSION-${command.lines[0]!.sourceLine}`,
        stock_count_reason_code: command.reason.code,
        stock_count_reason_narrative: command.reason.narrative,
        stock_count_recorded_at: null,
        stock_count_state: enumOption(
          field(binding.stockCount, 'stock_count_state'),
          'reviewed',
        ),
      },
      command.stockCountId,
      command.legalEntityId,
      {
        [binding.stockCount.entity.entityId]:
          command.supersedesStockCountId ?? '',
        [binding.transaction.entity.entityId]: command.transactionId,
      },
    );
    for (const line of command.lines) {
      await insertEntity(
        client,
        binding,
        binding.stockCountLine,
        {
          stock_count_line_counted_quantity: line.countedQuantity,
          stock_count_line_expected_quantity: line.expectedQuantity,
          stock_count_line_item_id: line.itemId,
          stock_count_line_line_number: Number(line.sourceLine),
          stock_count_line_reversal_of_movement_id: line.reversalOfMovementId,
          stock_count_line_unit_id: line.unitId,
          stock_count_line_variance_quantity: line.varianceQuantity,
        },
        line.stockCountLineId,
        command.legalEntityId,
        {
          [binding.stockCount.entity.entityId]: command.stockCountId,
          [binding.transactionLine.entity.entityId]: line.transactionLineId,
        },
      );
    }
  });
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
      revisionColumn: entity.optimisticRevision.column,
      tableName: entity.physicalTableName,
    };
  };
  return {
    item: bind('item'),
    legalEntity: bind('legal_entity'),
    location: bind('location'),
    movement: bind('inventory_movement'),
    schemaName: target.providerAbi.managedSchema,
    stockCount: bind('stock_count'),
    stockCountLine: bind('stock_count_line'),
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
      return '2026-07-30';
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
