import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  type CompileSuccess,
  type CompilerInput,
  type StorageTargetPayloadV1,
} from '../../packages/compiler/src/index.js';
import {
  type AuthenticatedIdentity,
  AuthenticatedRequestEntryAdapter,
} from '../../packages/runtime/src/request-context.js';
import {
  SEMANTIC_AGGREGATE_RESULT_VERSION,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SEMANTIC_QUERY_RESULT_VERSION,
  SemanticQueryGateway,
  type SemanticAggregateQueryExecutionRequest,
  type SemanticAggregateResultEnvelope,
  type SemanticQueryExecutionRequest,
  type SemanticQueryExecutor,
  type SemanticQueryResultEnvelope,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  type CurrentPolicyGateway,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeProjectionFamily,
  type RequestRuntimeView,
  type RuntimeProjection,
} from '../../packages/runtime/src/request-runtime-view.js';
import {
  DIMENSION_REPLAY_IDS,
  DIMENSION_REPLAY_STOCK,
  FIXTURE_DIMENSION_SET_V1,
  FIXTURE_DIMENSION_SET_V2,
  POST_EXTENSION_DIMENSION_REPLAY_EVENT,
  PRIOR_DIMENSION_REPLAY_HISTORY,
  dimensionReplayModuleDefinition,
  type DimensionReplayEvent,
  type FixtureStockDimensionSet,
} from '../fixtures/g3/dimension-set-replay.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const tenantId = '11a00000-0000-4000-8000-000000000001';
const environmentId = '21a00000-0000-4000-8000-000000000001';
const principalId = '71a00000-0000-4000-8000-000000000001';

const projectionTables = Object.freeze({
  ignored: 'g3_r2_projection_ignored',
  nullMember: 'g3_r2_projection_null',
  v1: 'g3_r2_projection_v1',
  v2: 'g3_r2_projection_v2',
});

type ProjectionTable = (typeof projectionTables)[keyof typeof projectionTables];

interface BalanceProbe {
  readonly atTime: string;
  readonly id: string;
  readonly itemId: string;
  readonly legalEntityId: string;
  readonly locationId: string;
  readonly recordedAt: string;
}

const priorBalanceProbes: readonly BalanceProbe[] = Object.freeze([
  Object.freeze({
    atTime: '2026-01-31T23:59:59.999Z',
    id: 'same-stock-before-backdated-recording',
    itemId: DIMENSION_REPLAY_STOCK.itemA,
    legalEntityId: DIMENSION_REPLAY_STOCK.legalEntityId,
    locationId: DIMENSION_REPLAY_STOCK.locationA,
    recordedAt: '2026-01-15T23:59:59.999Z',
  }),
  Object.freeze({
    atTime: '2026-01-31T23:59:59.999Z',
    id: 'same-stock-after-backdated-recording',
    itemId: DIMENSION_REPLAY_STOCK.itemA,
    legalEntityId: DIMENSION_REPLAY_STOCK.legalEntityId,
    locationId: DIMENSION_REPLAY_STOCK.locationA,
    recordedAt: '2026-02-15T23:59:59.999Z',
  }),
  Object.freeze({
    atTime: '2026-03-31T23:59:59.999Z',
    id: 'same-stock-complete-prior-history',
    itemId: DIMENSION_REPLAY_STOCK.itemA,
    legalEntityId: DIMENSION_REPLAY_STOCK.legalEntityId,
    locationId: DIMENSION_REPLAY_STOCK.locationA,
    recordedAt: '2026-03-31T23:59:59.999Z',
  }),
  Object.freeze({
    atTime: '2026-03-31T23:59:59.999Z',
    id: 'other-location',
    itemId: DIMENSION_REPLAY_STOCK.itemA,
    legalEntityId: DIMENSION_REPLAY_STOCK.legalEntityId,
    locationId: DIMENSION_REPLAY_STOCK.locationB,
    recordedAt: '2026-03-31T23:59:59.999Z',
  }),
  Object.freeze({
    atTime: '2026-03-31T23:59:59.999Z',
    id: 'other-item',
    itemId: DIMENSION_REPLAY_STOCK.itemB,
    legalEntityId: DIMENSION_REPLAY_STOCK.legalEntityId,
    locationId: DIMENSION_REPLAY_STOCK.locationA,
    recordedAt: '2026-03-31T23:59:59.999Z',
  }),
]);

interface ServedBalance {
  readonly bytes: Uint8Array;
  readonly probe: BalanceProbe;
  readonly queryId: string;
  readonly releaseRoot: string;
}

test('fixture dimension-set v2 replay reproduces every prior gateway balance byte-for-byte and makes unspecified first-class', async () => {
  const v1 = mustCompile(
    compilerInput(dimensionReplayModuleDefinition(FIXTURE_DIMENSION_SET_V1)),
  );
  const v2 = mustCompile(
    compilerInput(dimensionReplayModuleDefinition(FIXTURE_DIMENSION_SET_V2)),
  );
  const policy = new AllowPolicy();
  const v1View = await issuedCompiledView(v1, policy);
  const v2View = await issuedCompiledView(v2, policy);

  await withEphemeralPostgres('g3-r2-dimension-replay', async ({ pool }) => {
    await createProjectionTables(pool);
    await activateProjection(
      pool,
      projectionTables.v1,
      FIXTURE_DIMENSION_SET_V1,
      v1.releaseRoot,
    );
    await activateProjection(
      pool,
      projectionTables.v2,
      FIXTURE_DIMENSION_SET_V2,
      v2.releaseRoot,
    );
    await replayV1(pool, projectionTables.v1, PRIOR_DIMENSION_REPLAY_HISTORY);
    await replayV2(
      pool,
      projectionTables.v2,
      PRIOR_DIMENSION_REPLAY_HISTORY,
      () => DIMENSION_REPLAY_IDS.members.unspecified,
    );

    await assertSamePriorEventHistory(pool);
    await assertV2Activated(pool, v1, v2, v2View, projectionTables.v2);

    const v1Gateway = new SemanticQueryGateway(
      policy,
      new FixtureBalanceExecutor(pool, projectionTables.v1),
    );
    const v2Gateway = new SemanticQueryGateway(
      policy,
      new FixtureBalanceExecutor(pool, projectionTables.v2),
    );
    const v1Balances = await observePriorBalances(v1Gateway, v1View);
    const v2Balances = await observePriorBalances(v2Gateway, v2View);
    assertPriorReplayInvariant(
      v1Balances,
      v2Balances,
      PRIOR_DIMENSION_REPLAY_HISTORY,
    );
    await assertFirstClassUnspecified(
      pool,
      projectionTables.v2,
      PRIOR_DIMENSION_REPLAY_HISTORY,
      v2Gateway,
      v2View,
    );

    await replayV2(
      pool,
      projectionTables.v2,
      [POST_EXTENSION_DIMENSION_REPLAY_EVENT],
      () => DIMENSION_REPLAY_IDS.members.unspecified,
    );
    const v2BalancesAfterNewMember = await observePriorBalances(
      v2Gateway,
      v2View,
    );
    assertPriorReplayInvariant(
      v1Balances,
      v2BalancesAfterNewMember,
      PRIOR_DIMENSION_REPLAY_HISTORY,
    );
    await assertPostExtensionMemberBehaviour(pool, v2Gateway, v2View);

    const recordedReds: string[] = [];
    await expectRed(
      recordedReds,
      'empty-comparison',
      'G3_R2_ZERO_BALANCES_OBSERVED: replay comparison requires at least one served prior balance from each activated set',
      () => assertPriorReplayInvariant([], [], PRIOR_DIMENSION_REPLAY_HISTORY),
    );
    await expectRed(
      recordedReds,
      'empty-history',
      'G3_R2_REPLAY_HISTORY_EMPTY: the replay subject must contain at least one prior movement',
      () => assertPriorReplayInvariant(v1Balances, v2Balances, []),
    );

    const mutuallyWrongV1 = corruptBalances(v1Balances);
    const mutuallyWrongV2 = corruptBalances(v2Balances);
    assert.deepEqual(
      mutuallyWrongV1.map(({ bytes }) => bytes),
      mutuallyWrongV2.map(({ bytes }) => bytes),
      'the negative control must really construct two equally wrong sets',
    );
    await expectRed(
      recordedReds,
      'shared-bug-agreement',
      'G3_R2_INDEPENDENT_ORACLE_MISMATCH: v1 same-stock-before-backdated-recording expected 10.5, observed 999',
      () =>
        assertPriorReplayInvariant(
          mutuallyWrongV1,
          mutuallyWrongV2,
          PRIOR_DIMENSION_REPLAY_HISTORY,
        ),
    );

    await activateProjection(
      pool,
      projectionTables.ignored,
      FIXTURE_DIMENSION_SET_V2,
      v2.releaseRoot,
    );
    await replayV2(
      pool,
      projectionTables.ignored,
      PRIOR_DIMENSION_REPLAY_HISTORY,
      () => 'ignored',
    );
    const ignoredGateway = new SemanticQueryGateway(
      policy,
      new FixtureBalanceExecutor(pool, projectionTables.ignored),
    );
    const ignoredBalances = await observePriorBalances(ignoredGateway, v2View);
    assertPriorReplayInvariant(
      v1Balances,
      ignoredBalances,
      PRIOR_DIMENSION_REPLAY_HISTORY,
    );
    await expectRed(
      recordedReds,
      'ignored-dimension-resolution',
      `G3_R2_UNSPECIFIED_RESOLUTION_MISMATCH: event ${PRIOR_DIMENSION_REPLAY_HISTORY[0]!.eventId} expected ${DIMENSION_REPLAY_IDS.members.unspecified}, observed ignored`,
      () =>
        assertFirstClassUnspecified(
          pool,
          projectionTables.ignored,
          PRIOR_DIMENSION_REPLAY_HISTORY,
          ignoredGateway,
          v2View,
        ),
    );

    await activateProjection(
      pool,
      projectionTables.nullMember,
      FIXTURE_DIMENSION_SET_V2,
      v2.releaseRoot,
    );
    await replayV2(
      pool,
      projectionTables.nullMember,
      PRIOR_DIMENSION_REPLAY_HISTORY,
      () => null,
    );
    const nullGateway = new SemanticQueryGateway(
      policy,
      new FixtureBalanceExecutor(pool, projectionTables.nullMember),
    );
    const nullBalances = await observePriorBalances(nullGateway, v2View);
    assertPriorReplayInvariant(
      v1Balances,
      nullBalances,
      PRIOR_DIMENSION_REPLAY_HISTORY,
    );
    await expectRed(
      recordedReds,
      'null-unspecified-member',
      `G3_R2_UNSPECIFIED_RESOLUTION_MISMATCH: event ${PRIOR_DIMENSION_REPLAY_HISTORY[0]!.eventId} expected ${DIMENSION_REPLAY_IDS.members.unspecified}, observed NULL`,
      () =>
        assertFirstClassUnspecified(
          pool,
          projectionTables.nullMember,
          PRIOR_DIMENSION_REPLAY_HISTORY,
          nullGateway,
          v2View,
        ),
    );

    await expectRed(
      recordedReds,
      'v2-not-activated',
      `G3_R2_V2_NOT_ACTIVATED: expected release ${v2.releaseRoot}, observed ${v1.releaseRoot}`,
      () => assertV2Activated(pool, v1, v2, v1View, projectionTables.v1),
    );

    assert.equal(recordedReds.length, 6);
    for (const failure of recordedReds) {
      console.log(`G3-R2 EXECUTED RED: ${failure}`);
    }
  });
});

class FixtureBalanceExecutor implements SemanticQueryExecutor {
  constructor(
    private readonly pool: Pool,
    private readonly projectionTable: ProjectionTable,
  ) {}

  async execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope> {
    await assertProjectionBoundToView(
      this.pool,
      this.projectionTable,
      request.view,
    );
    if (
      request.definition.queryId !==
      DIMENSION_REPLAY_IDS.queries.renderAddedDimension
    ) {
      throw new Error(
        `G3_R2_RECORD_QUERY_UNEXPECTED: ${request.definition.queryId}`,
      );
    }
    const member = DIMENSION_REPLAY_IDS.members.unspecified;
    const result = await this.pool.query<{
      added_dimension_member: string;
      event_id: string;
    }>(
      `SELECT event_id::text, added_dimension_member
         FROM ${quoted(this.projectionTable)}
        WHERE added_dimension_member = $1
        ORDER BY event_id
        LIMIT 1`,
      [member],
    );
    const row = result.rows[0];
    return {
      kind: 'semanticQueryResult',
      outcome: row ? 'exact' : 'not-found',
      queryId: request.definition.queryId,
      records: row
        ? [
            {
              archived: false,
              displayValues: {
                [DIMENSION_REPLAY_IDS.fields.addedDimension]:
                  member === DIMENSION_REPLAY_IDS.members.unspecified
                    ? 'Unspecified'
                    : 'Batch red',
              },
              entityId: DIMENSION_REPLAY_IDS.entity,
              recordId: row.event_id,
              revision: 1,
              values: {
                [DIMENSION_REPLAY_IDS.fields.addedDimension]:
                  row.added_dimension_member,
              },
            },
          ]
        : [],
      schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
      unsupportedReason: null,
    };
  }

  async executeAggregate(
    request: SemanticAggregateQueryExecutionRequest,
  ): Promise<SemanticAggregateResultEnvelope> {
    await assertProjectionBoundToView(
      this.pool,
      this.projectionTable,
      request.view,
    );
    const byAddedDimension =
      request.definition.queryId ===
      DIMENSION_REPLAY_IDS.queries.byAddedDimension;
    const stockIdentity = requiredArgument(
      request.parameterValues,
      byAddedDimension
        ? DIMENSION_REPLAY_IDS.parameters.byAddedDimensionStockIdentity
        : DIMENSION_REPLAY_IDS.parameters.stockIdentity,
    );
    const atTime = requiredArgument(
      request.parameterValues,
      byAddedDimension
        ? DIMENSION_REPLAY_IDS.parameters.byAddedDimensionAtTime
        : DIMENSION_REPLAY_IDS.parameters.atTime,
    );
    const recordedAt = requiredArgument(
      request.parameterValues,
      byAddedDimension
        ? DIMENSION_REPLAY_IDS.parameters.byAddedDimensionRecordedAt
        : DIMENSION_REPLAY_IDS.parameters.recordedAt,
    );
    const values: string[] = [stockIdentity, atTime, recordedAt];
    let memberPredicate = '';
    if (byAddedDimension) {
      values.push(
        requiredArgument(
          request.parameterValues,
          DIMENSION_REPLAY_IDS.parameters.addedDimension,
        ),
      );
      memberPredicate = 'AND added_dimension_member = $4';
    } else if (
      request.definition.queryId !== DIMENSION_REPLAY_IDS.queries.total
    ) {
      throw new Error(
        `G3_R2_UNKNOWN_FIXTURE_QUERY: ${request.definition.queryId}`,
      );
    }
    const result = await this.pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::numeric(38,18)::text AS balance
         FROM ${quoted(this.projectionTable)}
        WHERE stock_identity = $1
          AND effective_at <= $2::timestamptz
          AND recorded_at <= $3::timestamptz
          ${memberPredicate}`,
      values,
    );
    return {
      kind: 'semanticAggregateResult',
      outcome: 'exact',
      queryId: request.definition.queryId,
      schemaVersion: SEMANTIC_AGGREGATE_RESULT_VERSION,
      value: {
        kind: 'exactDecimalResult',
        precision: 38,
        scale: 18,
        selectionId: request.definition.aggregate.selectionId,
        value: canonicalDatabaseDecimal(result.rows[0]?.balance ?? '0'),
      },
    };
  }
}

async function createProjectionTables(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE g3_r2_projection_activation (
       projection_table text PRIMARY KEY,
       set_id text NOT NULL,
       set_version integer NOT NULL,
       dimensions jsonb NOT NULL,
       compiled_release_root text NOT NULL
     )`,
  );
  await pool.query(
    `CREATE TABLE ${quoted(projectionTables.v1)} (
       event_id uuid PRIMARY KEY,
       stock_dimension_set_version text NOT NULL CHECK (stock_dimension_set_version = 'v1'),
       stock_identity text NOT NULL,
       legal_entity_id uuid NOT NULL,
       item_id uuid NOT NULL,
       location_id uuid NOT NULL,
       quantity numeric(38,18) NOT NULL,
       effective_at timestamptz NOT NULL,
       recorded_at timestamptz NOT NULL
     )`,
  );
  await pool.query(
    `CREATE TABLE ${quoted(projectionTables.v2)} (
       event_id uuid PRIMARY KEY,
       stock_dimension_set_version text NOT NULL CHECK (stock_dimension_set_version IN ('v1','v2')),
       stock_identity text NOT NULL,
       legal_entity_id uuid NOT NULL,
       item_id uuid NOT NULL,
       location_id uuid NOT NULL,
       added_dimension_member text NOT NULL CHECK (
         added_dimension_member IN (
           '${DIMENSION_REPLAY_IDS.members.unspecified}',
           '${DIMENSION_REPLAY_IDS.members.batchRed}'
         )
       ),
       quantity numeric(38,18) NOT NULL,
       effective_at timestamptz NOT NULL,
       recorded_at timestamptz NOT NULL
     )`,
  );
  for (const table of [projectionTables.ignored, projectionTables.nullMember]) {
    await pool.query(
      `CREATE TABLE ${quoted(table)} (
         event_id uuid PRIMARY KEY,
         stock_dimension_set_version text NOT NULL,
         stock_identity text NOT NULL,
         legal_entity_id uuid NOT NULL,
         item_id uuid NOT NULL,
         location_id uuid NOT NULL,
         added_dimension_member text,
         quantity numeric(38,18) NOT NULL,
         effective_at timestamptz NOT NULL,
         recorded_at timestamptz NOT NULL
       )`,
    );
  }
}

async function activateProjection(
  pool: Pool,
  table: ProjectionTable,
  dimensionSet: FixtureStockDimensionSet,
  releaseRoot: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO g3_r2_projection_activation
       (projection_table, set_id, set_version, dimensions, compiled_release_root)
     VALUES ($1,$2,$3,$4::jsonb,$5)`,
    [
      table,
      dimensionSet.setId,
      dimensionSet.version,
      JSON.stringify(dimensionSet.dimensions),
      releaseRoot,
    ],
  );
}

async function replayV1(
  pool: Pool,
  table: typeof projectionTables.v1,
  events: readonly DimensionReplayEvent[],
): Promise<void> {
  for (const event of events) {
    if (event.stockDimensionSetVersion !== 'v1') {
      throw new Error(`G3_R2_V1_REPLAY_REJECTED_VERSION: ${event.eventId}`);
    }
    await pool.query(
      `INSERT INTO ${quoted(table)}
         (event_id, stock_dimension_set_version, stock_identity,
          legal_entity_id, item_id, location_id, quantity, effective_at, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [...eventValues(event)],
    );
  }
}

async function replayV2(
  pool: Pool,
  table: Exclude<ProjectionTable, typeof projectionTables.v1>,
  events: readonly DimensionReplayEvent[],
  resolvePriorMember: (event: DimensionReplayEvent) => string | null,
): Promise<void> {
  for (const event of events) {
    const member =
      event.stockDimensionSetVersion === 'v1'
        ? resolvePriorMember(event)
        : event.addedDimensionMember;
    if (event.stockDimensionSetVersion === 'v2' && !member) {
      throw new Error(`G3_R2_V2_MEMBER_REQUIRED: ${event.eventId}`);
    }
    await pool.query(
      `INSERT INTO ${quoted(table)}
         (event_id, stock_dimension_set_version, stock_identity,
          legal_entity_id, item_id, location_id, added_dimension_member,
          quantity, effective_at, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ...eventValues(event).slice(0, 6),
        member,
        ...eventValues(event).slice(6),
      ],
    );
  }
}

function eventValues(event: DimensionReplayEvent): readonly string[] {
  return [
    event.eventId,
    event.stockDimensionSetVersion,
    stockIdentity(event),
    event.legalEntityId,
    event.itemId,
    event.locationId,
    event.quantity,
    event.effectiveAt,
    event.recordedAt,
  ];
}

async function observePriorBalances(
  gateway: SemanticQueryGateway,
  view: RequestRuntimeView,
): Promise<ServedBalance[]> {
  const observations: ServedBalance[] = [];
  for (const probe of priorBalanceProbes) {
    const result = await invokeBalance(gateway, view, probe);
    observations.push({
      bytes: new TextEncoder().encode(result.value.value),
      probe,
      queryId: result.queryId,
      releaseRoot: view.release.contentHash,
    });
  }
  return observations;
}

async function invokeBalance(
  gateway: SemanticQueryGateway,
  view: RequestRuntimeView,
  probe: BalanceProbe,
  addedDimensionMember?: string,
): Promise<SemanticAggregateResultEnvelope> {
  const byAddedDimension = addedDimensionMember !== undefined;
  const arguments_: Record<string, string> = {
    [byAddedDimension
      ? DIMENSION_REPLAY_IDS.parameters.byAddedDimensionAtTime
      : DIMENSION_REPLAY_IDS.parameters.atTime]: probe.atTime,
    [byAddedDimension
      ? DIMENSION_REPLAY_IDS.parameters.byAddedDimensionRecordedAt
      : DIMENSION_REPLAY_IDS.parameters.recordedAt]: probe.recordedAt,
    [byAddedDimension
      ? DIMENSION_REPLAY_IDS.parameters.byAddedDimensionStockIdentity
      : DIMENSION_REPLAY_IDS.parameters.stockIdentity]: stockIdentity(probe),
  };
  if (byAddedDimension) {
    arguments_[DIMENSION_REPLAY_IDS.parameters.addedDimension] =
      addedDimensionMember;
  }
  return gateway.invokeAggregate(view, {
    arguments: arguments_,
    queryId: byAddedDimension
      ? DIMENSION_REPLAY_IDS.queries.byAddedDimension
      : DIMENSION_REPLAY_IDS.queries.total,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
}

function assertPriorReplayInvariant(
  v1: readonly ServedBalance[],
  v2: readonly ServedBalance[],
  history: readonly DimensionReplayEvent[],
): void {
  if (history.length === 0) {
    fail(
      'G3_R2_REPLAY_HISTORY_EMPTY: the replay subject must contain at least one prior movement',
    );
  }
  if (v1.length === 0 || v2.length === 0) {
    fail(
      'G3_R2_ZERO_BALANCES_OBSERVED: replay comparison requires at least one served prior balance from each activated set',
    );
  }
  if (v1.length !== priorBalanceProbes.length || v2.length !== v1.length) {
    fail(
      `G3_R2_BALANCE_OBSERVATION_COUNT_MISMATCH: expected ${String(priorBalanceProbes.length)} v1=${String(v1.length)} v2=${String(v2.length)}`,
    );
  }
  for (let index = 0; index < priorBalanceProbes.length; index += 1) {
    const before = v1[index]!;
    const after = v2[index]!;
    const probe = priorBalanceProbes[index]!;
    if (before.probe.id !== probe.id || after.probe.id !== probe.id) {
      fail(`G3_R2_BALANCE_PROBE_MISMATCH: ${probe.id}`);
    }
    const expected = oracleBalance(history, probe);
    assertOracleBytes('v1', before, expected);
    assertOracleBytes('v2', after, expected);
    if (!bytesEqual(before.bytes, after.bytes)) {
      fail(
        `G3_R2_PRIOR_BALANCE_BYTES_CHANGED: ${probe.id} v1=${decode(before.bytes)} v2=${decode(after.bytes)}`,
      );
    }
  }
}

function assertOracleBytes(
  version: 'v1' | 'v2',
  observation: ServedBalance,
  expected: Uint8Array,
): void {
  if (!bytesEqual(observation.bytes, expected)) {
    fail(
      `G3_R2_INDEPENDENT_ORACLE_MISMATCH: ${version} ${observation.probe.id} expected ${decode(expected)}, observed ${decode(observation.bytes)}`,
    );
  }
}

async function assertSamePriorEventHistory(pool: Pool): Promise<void> {
  const expected = PRIOR_DIMENSION_REPLAY_HISTORY.map(({ eventId }) => eventId);
  const [v1, v2] = await Promise.all([
    persistedEventIds(pool, projectionTables.v1),
    persistedEventIds(pool, projectionTables.v2),
  ]);
  assert.deepEqual(v1, expected);
  assert.deepEqual(v2, expected);
  assert.deepEqual(v1, v2);
}

async function persistedEventIds(
  pool: Pool,
  table: ProjectionTable,
): Promise<string[]> {
  const result = await pool.query<{ event_id: string }>(
    `SELECT event_id::text FROM ${quoted(table)} ORDER BY event_id`,
  );
  return result.rows.map(({ event_id: eventId }) => eventId);
}

async function assertV2Activated(
  pool: Pool,
  v1: CompileSuccess,
  v2: CompileSuccess,
  activeView: RequestRuntimeView,
  table: ProjectionTable,
): Promise<void> {
  if (activeView.release.contentHash !== v2.releaseRoot) {
    fail(
      `G3_R2_V2_NOT_ACTIVATED: expected release ${v2.releaseRoot}, observed ${activeView.release.contentHash}`,
    );
  }
  if (v1.releaseRoot === v2.releaseRoot) {
    fail(`G3_R2_DIMENSION_SET_SUBJECT_UNCHANGED: ${v1.releaseRoot}`);
  }
  const activation = await pool.query<{
    compiled_release_root: string;
    dimensions: string[];
    set_id: string;
    set_version: number;
  }>(
    `SELECT compiled_release_root, dimensions, set_id, set_version
       FROM g3_r2_projection_activation
      WHERE projection_table = $1`,
    [table],
  );
  const row = activation.rows[0];
  if (
    activation.rowCount !== 1 ||
    row?.compiled_release_root !== v2.releaseRoot ||
    row.set_id !== FIXTURE_DIMENSION_SET_V2.setId ||
    row.set_version !== 2 ||
    JSON.stringify(row.dimensions) !==
      JSON.stringify(FIXTURE_DIMENSION_SET_V2.dimensions)
  ) {
    fail(`G3_R2_V2_ACTIVATION_EVIDENCE_INVALID: ${table}`);
  }
  const queryPayload = activeView.projections.query.payload;
  if (
    !isRecord(queryPayload) ||
    !Array.isArray(queryPayload.queries) ||
    !queryPayload.queries.some(
      (query) =>
        isRecord(query) &&
        query.queryId === DIMENSION_REPLAY_IDS.queries.byAddedDimension,
    )
  ) {
    fail('G3_R2_V2_QUERY_NOT_ACTIVE');
  }
  const storage = projectionPayload<StorageTargetPayloadV1>(
    v2,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  if (
    !storage.entities.some((entity) =>
      entity.columns.some(
        (column) =>
          column.canonicalFieldId ===
          DIMENSION_REPLAY_IDS.fields.addedDimension,
      ),
    )
  ) {
    fail('G3_R2_V2_STORAGE_FIELD_NOT_ACTIVE');
  }
}

async function assertFirstClassUnspecified(
  pool: Pool,
  table: Exclude<ProjectionTable, typeof projectionTables.v1>,
  history: readonly DimensionReplayEvent[],
  gateway: SemanticQueryGateway,
  view: RequestRuntimeView,
): Promise<void> {
  const result = await pool.query<{
    added_dimension_member: string | null;
    event_id: string;
  }>(
    `SELECT event_id::text, added_dimension_member
       FROM ${quoted(table)}
      WHERE stock_dimension_set_version = 'v1'
      ORDER BY event_id`,
  );
  if (result.rowCount !== history.length) {
    fail(
      `G3_R2_UNSPECIFIED_SUBJECT_COUNT_MISMATCH: expected ${String(history.length)}, observed ${String(result.rowCount)}`,
    );
  }
  for (const row of result.rows) {
    if (
      row.added_dimension_member !== DIMENSION_REPLAY_IDS.members.unspecified
    ) {
      fail(
        `G3_R2_UNSPECIFIED_RESOLUTION_MISMATCH: event ${row.event_id} expected ${DIMENSION_REPLAY_IDS.members.unspecified}, observed ${displayMember(row.added_dimension_member)}`,
      );
    }
  }
  const groups = await groupedBalances(pool, table);
  const unspecified = groups.find(
    ({ member }) => member === DIMENSION_REPLAY_IDS.members.unspecified,
  );
  if (!unspecified || !unspecified.member) {
    fail('G3_R2_UNSPECIFIED_GROUP_MISSING');
  }
  const served = await gateway.invoke(view, {
    arguments: {},
    queryId: DIMENSION_REPLAY_IDS.queries.renderAddedDimension,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
  assert.equal(served.outcome, 'exact');
  assert.equal(served.records.length, 1);
  assert.equal(
    served.records[0]?.values[DIMENSION_REPLAY_IDS.fields.addedDimension],
    DIMENSION_REPLAY_IDS.members.unspecified,
  );
  assert.equal(
    served.records[0]?.displayValues?.[
      DIMENSION_REPLAY_IDS.fields.addedDimension
    ],
    'Unspecified',
  );
}

async function assertPostExtensionMemberBehaviour(
  pool: Pool,
  gateway: SemanticQueryGateway,
  view: RequestRuntimeView,
): Promise<void> {
  const latestProbe: BalanceProbe = {
    atTime: '2026-12-31T23:59:59.999Z',
    id: 'post-extension-latest',
    itemId: DIMENSION_REPLAY_STOCK.itemA,
    legalEntityId: DIMENSION_REPLAY_STOCK.legalEntityId,
    locationId: DIMENSION_REPLAY_STOCK.locationA,
    recordedAt: '2026-12-31T23:59:59.999Z',
  };
  const history = [
    ...PRIOR_DIMENSION_REPLAY_HISTORY,
    POST_EXTENSION_DIMENSION_REPLAY_EVENT,
  ];
  const total = await invokeBalance(gateway, view, latestProbe);
  const unspecified = await invokeBalance(
    gateway,
    view,
    latestProbe,
    DIMENSION_REPLAY_IDS.members.unspecified,
  );
  const batchRed = await invokeBalance(
    gateway,
    view,
    latestProbe,
    DIMENSION_REPLAY_IDS.members.batchRed,
  );
  assertBytes(
    total.value.value,
    oracleBalance(history, latestProbe),
    'post-extension total',
  );
  assertBytes(
    unspecified.value.value,
    oracleBalance(
      history,
      latestProbe,
      DIMENSION_REPLAY_IDS.members.unspecified,
    ),
    'unspecified filtered aggregate',
  );
  assertBytes(
    batchRed.value.value,
    oracleBalance(history, latestProbe, DIMENSION_REPLAY_IDS.members.batchRed),
    'real-member filtered aggregate',
  );

  const groups = await groupedBalances(pool, projectionTables.v2, latestProbe);
  assert.deepEqual(groups, [
    {
      balance: '2.125000000000000000',
      member: DIMENSION_REPLAY_IDS.members.batchRed,
    },
    {
      balance: '8.375000000000000000',
      member: DIMENSION_REPLAY_IDS.members.unspecified,
    },
  ]);
  assert.equal(
    groups.some(({ member }) => member === null || member === ''),
    false,
  );
}

async function groupedBalances(
  pool: Pool,
  table: Exclude<ProjectionTable, typeof projectionTables.v1>,
  probe?: BalanceProbe,
): Promise<
  Array<{ readonly balance: string; readonly member: string | null }>
> {
  const result = await pool.query<{
    balance: string;
    member: string | null;
  }>(
    `SELECT added_dimension_member AS member,
            SUM(quantity)::numeric(38,18)::text AS balance
       FROM ${quoted(table)}
      WHERE ($1::text IS NULL OR stock_identity = $1)
        AND ($2::timestamptz IS NULL OR effective_at <= $2)
        AND ($3::timestamptz IS NULL OR recorded_at <= $3)
      GROUP BY added_dimension_member
      ORDER BY added_dimension_member NULLS FIRST`,
    probe
      ? [stockIdentity(probe), probe.atTime, probe.recordedAt]
      : [null, null, null],
  );
  return result.rows;
}

function oracleBalance(
  history: readonly DimensionReplayEvent[],
  probe: BalanceProbe,
  addedDimensionMember?: string,
): Uint8Array {
  let total = 0n;
  for (const event of history) {
    if (
      event.legalEntityId !== probe.legalEntityId ||
      event.itemId !== probe.itemId ||
      event.locationId !== probe.locationId ||
      event.effectiveAt > probe.atTime ||
      event.recordedAt > probe.recordedAt
    ) {
      continue;
    }
    const resolvedMember =
      event.stockDimensionSetVersion === 'v1'
        ? DIMENSION_REPLAY_IDS.members.unspecified
        : event.addedDimensionMember;
    if (
      addedDimensionMember !== undefined &&
      resolvedMember !== addedDimensionMember
    ) {
      continue;
    }
    total += parseFixedQuantity(event.quantity);
  }
  return new TextEncoder().encode(formatFixedQuantity(total));
}

function parseFixedQuantity(value: string): bigint {
  const match = /^(-?)(\d+)\.(\d{18})$/u.exec(value);
  if (!match) throw new Error(`fixture quantity is not canonical: ${value}`);
  const magnitude = BigInt(match[2]!) * 10n ** 18n + BigInt(match[3]!);
  return match[1] === '-' ? -magnitude : magnitude;
}

function formatFixedQuantity(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const integer = magnitude / 10n ** 18n;
  const fraction = String(magnitude % 10n ** 18n)
    .padStart(18, '0')
    .replace(/0+$/u, '');
  return `${negative ? '-' : ''}${String(integer)}${fraction.length > 0 ? `.${fraction}` : ''}`;
}

function stockIdentity(input: {
  readonly itemId: string;
  readonly legalEntityId: string;
  readonly locationId: string;
}): string {
  return `${input.legalEntityId}|${input.itemId}|${input.locationId}`;
}

function corruptBalances(source: readonly ServedBalance[]): ServedBalance[] {
  return source.map((entry) => ({
    ...entry,
    bytes: new TextEncoder().encode('999'),
  }));
}

async function expectRed(
  recorded: string[],
  label: string,
  expectedMessage: string,
  run: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof Error, `${label} did not throw an Error`);
    assert.equal(error.message, expectedMessage, label);
    recorded.push(error.message);
    return;
  }
  assert.fail(`${label} did not execute red`);
}

async function assertProjectionBoundToView(
  pool: Pool,
  table: ProjectionTable,
  view: RequestRuntimeView,
): Promise<void> {
  const result = await pool.query<{ compiled_release_root: string }>(
    `SELECT compiled_release_root
       FROM g3_r2_projection_activation
      WHERE projection_table = $1`,
    [table],
  );
  assert.equal(result.rowCount, 1);
  if (result.rows[0]?.compiled_release_root !== view.release.contentHash) {
    fail(
      `G3_R2_PROJECTION_RELEASE_MISMATCH: ${table} expected ${String(result.rows[0]?.compiled_release_root)}, observed ${view.release.contentHash}`,
    );
  }
}

function compilerInput(definition: unknown): CompilerInput {
  const normalized = normalizeApplicationPackage(definition);
  return {
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    profile: {
      ...MODULE_COMPILER_PROFILE,
      languageVersion: normalized.languageVersion,
      normalizationProfileVersion: normalized.normalizationProfileVersion,
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

async function issuedCompiledView(
  compiled: CompileSuccess,
  policy: CurrentPolicyGateway,
): Promise<RequestRuntimeView> {
  const identity: AuthenticatedIdentity = {
    environmentId,
    principalId,
    tenantId,
  };
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
            query: runtimeProjection(
              compiled,
              REQUEST_RUNTIME_PROJECTION_FAMILIES.query,
            ),
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

function runtimeProjection<TFamily extends RequestRuntimeProjectionFamily>(
  compiled: CompileSuccess,
  familyId: TFamily,
): RuntimeProjection<TFamily> {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  return {
    artifactRoot: reference.artifactRoot,
    familyId,
    instanceId: reference.instanceId,
    payload: projectionPayload(compiled, familyId) as never,
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  } as RuntimeProjection<TFamily>;
}

function projectionPayload<T>(compiled: CompileSuccess, familyId: string): T {
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

class AllowPolicy implements CurrentPolicyGateway {
  async authorize() {
    return {
      decision: 'ALLOW' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'g3-r2-fixture-policy/v1',
    };
  }

  async readCurrentVersion() {
    return { policyVersion: 'g3-r2-fixture-policy/v1' };
  }
}

function requiredArgument(
  values: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = values[key];
  if (typeof value !== 'string') {
    throw new Error(`G3_R2_ARGUMENT_INVALID: ${key}`);
  }
  return value;
}

function assertBytes(
  observed: string,
  expected: Uint8Array,
  label: string,
): void {
  assert.deepEqual(new TextEncoder().encode(observed), expected, label);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function displayMember(value: string | null): string {
  if (value === null) return 'NULL';
  return value === '' ? 'EMPTY' : value;
}

function canonicalDatabaseDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const canonical = value.replace(/0+$/u, '').replace(/\.$/u, '');
  return canonical === '-0' ? '0' : canonical;
}

function quoted(identifier: string): string {
  assert.match(identifier, /^[a-z][a-z0-9_]{0,62}$/u);
  return `"${identifier}"`;
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
