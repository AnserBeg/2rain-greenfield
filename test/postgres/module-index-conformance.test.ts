import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool, PoolClient } from 'pg';

import type { StorageTargetPayloadV1 } from '../../packages/compiler/src/index.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import { PARTY_IDS } from '../fixtures/g2/party/definition.js';
import {
  PARTY_TEST_SCOPE,
  withRealPartyRuntime,
} from '../fixtures/g2/party/runtime-harness.js';

const plannerMilestones = [10, 100, 500, 1_000, 5_000, 10_000] as const;
const targetRow = 7;
const demonstrateMissingIndex = process.env.PR6_DEMONSTRATE_MISSING_INDEX;

if (
  demonstrateMissingIndex !== undefined &&
  demonstrateMissingIndex !== 'relation'
) {
  throw new Error(
    `unsupported PR6_DEMONSTRATE_MISSING_INDEX value: ${demonstrateMissingIndex}`,
  );
}

test('EXPLAIN plan guard rejects sequential and wrong-index scans structurally', () => {
  assert.throws(
    () =>
      assertRelationIndexPlan(
        { 'Node Type': 'Seq Scan', 'Relation Name': 'child' },
        'expected_relation_index',
      ),
    /relation predicate used a sequential scan/,
  );
  assert.throws(
    () =>
      assertRelationIndexPlan(
        { 'Index Name': 'unrelated_primary_key', 'Node Type': 'Index Scan' },
        'expected_relation_index',
      ),
    /did not use expected relation index expected_relation_index; used unrelated_primary_key/,
  );
  assert.throws(
    () => inspectPlan({ 'Node Type': 'Future Scan' }),
    /unrecognized EXPLAIN node type: Future Scan/,
  );
});

test('the forced-RLS relation predicate uses its declared relation index', async () => {
  await withRealPartyRuntime('module-index-conformance', async (runtime) => {
    const targets = requiredTargets(runtime.storage);
    let priorRowCount = 0;
    let plannerFlipRows: number | null = null;

    for (const rowCount of plannerMilestones) {
      await seedRows(runtime.adminPool, targets, priorRowCount + 1, rowCount);
      priorRowCount = rowCount;
      await runtime.adminPool.query(
        `ANALYZE north_star_module.${quoted(targets.role.physicalTableName)}`,
      );
      const plan = await explainRelationPredicate(runtime, targets);
      if (
        inspectPlan(plan).indexNames.has(targets.relationIndex.physicalName)
      ) {
        plannerFlipRows = rowCount;
        break;
      }
    }

    assert.notEqual(
      plannerFlipRows,
      null,
      `relation predicate did not use ${targets.relationIndex.physicalName} by ${priorRowCount} analyzed rows`,
    );
    console.log(
      `PR-6 relation planner flip rows=${plannerFlipRows}; analyzed rows=${priorRowCount}`,
    );

    if (demonstrateMissingIndex === 'relation') {
      await runtime.adminPool.query(
        `DROP INDEX north_star_module.${quoted(targets.relationIndex.physicalName)}`,
      );
      await runtime.adminPool.query(
        `ANALYZE north_star_module.${quoted(targets.role.physicalTableName)}`,
      );
    }

    assertRelationIndexPlan(
      await explainRelationPredicate(runtime, targets),
      targets.relationIndex.physicalName,
    );
  });
});

interface PlanNode {
  readonly 'Index Name'?: unknown;
  readonly 'Node Type'?: unknown;
  readonly Plans?: unknown;
  readonly [key: string]: unknown;
}

interface RelationTargets {
  readonly nameColumn: StorageTargetPayloadV1['entities'][number]['columns'][number];
  readonly numberColumn: StorageTargetPayloadV1['entities'][number]['columns'][number];
  readonly party: StorageTargetPayloadV1['entities'][number];
  readonly relation: StorageTargetPayloadV1['relations'][number];
  readonly relationIndex: StorageTargetPayloadV1['entities'][number]['indexes'][number];
  readonly role: StorageTargetPayloadV1['entities'][number];
  readonly roleKindColumn: StorageTargetPayloadV1['entities'][number]['columns'][number];
  readonly roleStatusColumn: StorageTargetPayloadV1['entities'][number]['columns'][number];
}

function requiredTargets(storage: StorageTargetPayloadV1): RelationTargets {
  const party = requiredEntity(storage, PARTY_IDS.entityIds.party);
  const role = requiredEntity(storage, PARTY_IDS.entityIds.role);
  const relation = storage.relations.find(
    (candidate) => candidate.relationId === PARTY_IDS.relationIds.roleParty,
  );
  assert.ok(relation);
  const relationIndex = role.indexes.find(
    (candidate) =>
      candidate.indexKind === 'relation' &&
      candidate.columnNames.includes(relation.relationColumn.physicalName),
  );
  assert.ok(relationIndex);
  return {
    nameColumn: requiredColumn(party, PARTY_IDS.fieldIds.name),
    numberColumn: requiredColumn(party, PARTY_IDS.fieldIds.number),
    party,
    relation,
    relationIndex,
    role,
    roleKindColumn: requiredColumn(role, PARTY_IDS.fieldIds.roleKind),
    roleStatusColumn: requiredColumn(role, PARTY_IDS.fieldIds.roleStatus),
  };
}

function requiredEntity(
  storage: StorageTargetPayloadV1,
  entityId: string,
): StorageTargetPayloadV1['entities'][number] {
  const entity = storage.entities.find(
    (candidate) => candidate.entityId === entityId,
  );
  assert.ok(entity);
  return entity;
}

function requiredColumn(
  entity: StorageTargetPayloadV1['entities'][number],
  fieldId: string,
): StorageTargetPayloadV1['entities'][number]['columns'][number] {
  const column = entity.columns.find(
    (candidate) => candidate.canonicalFieldId === fieldId,
  );
  assert.ok(column);
  return column;
}

async function seedRows(
  pool: Pool,
  targets: RelationTargets,
  from: number,
  through: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO north_star_module.${quoted(targets.party.physicalTableName)} (
         tenant_id, environment_id, record_id,
         ${quoted(targets.numberColumn.physicalName)},
         ${quoted(targets.nameColumn.physicalName)}
       )
       SELECT $1::uuid, $2::uuid,
              ('10000000-0000-4000-8000-' || lpad(row_number::text, 12, '0'))::uuid,
              'PARTY-' || lpad(row_number::text, 8, '0'),
              'Ordinary party ' || row_number::text
         FROM generate_series($3::integer, $4::integer) AS row_number`,
      [
        PARTY_TEST_SCOPE.a.tenantId,
        PARTY_TEST_SCOPE.a.environmentId,
        from,
        through,
      ],
    );
    await client.query(
      `INSERT INTO north_star_module.${quoted(targets.role.physicalTableName)} (
         tenant_id, environment_id, record_id,
         ${quoted(targets.roleKindColumn.physicalName)},
         ${quoted(targets.roleStatusColumn.physicalName)},
         ${quoted(targets.relation.relationColumn.physicalName)}
       )
       SELECT $1::uuid, $2::uuid,
              ('20000000-0000-4000-8000-' || lpad(row_number::text, 12, '0'))::uuid,
              $5::text, $6::text,
              ('10000000-0000-4000-8000-' || lpad(row_number::text, 12, '0'))::uuid
         FROM generate_series($3::integer, $4::integer) AS row_number`,
      [
        PARTY_TEST_SCOPE.a.tenantId,
        PARTY_TEST_SCOPE.a.environmentId,
        from,
        through,
        `${PARTY_IDS.namespace}:option.supplier`,
        `${PARTY_IDS.namespace}:option.active`,
      ],
    );
  } finally {
    client.release();
  }
}

async function explainRelationPredicate(
  runtime: Parameters<Parameters<typeof withRealPartyRuntime>[1]>[0],
  targets: RelationTargets,
): Promise<PlanNode> {
  return withTrustedRequestTransaction(
    runtime.runtimePool,
    runtime.contexts.a,
    async (client) => {
      await client.query('SET LOCAL ROLE north_star_module_runtime');
      try {
        return await explain(
          client,
          `SELECT 1
             FROM north_star_module.${quoted(targets.role.physicalTableName)}
            WHERE ${quoted(targets.relation.relationColumn.physicalName)} = $1
              AND ${quoted(targets.role.archive.archivedAtColumn)} IS NULL
            LIMIT 1`,
          [`10000000-0000-4000-8000-${String(targetRow).padStart(12, '0')}`],
        );
      } finally {
        await client.query('RESET ROLE');
      }
    },
  );
}

async function explain(
  client: PoolClient,
  sql: string,
  values: readonly unknown[],
): Promise<PlanNode> {
  const result = await client.query<{ 'QUERY PLAN': unknown }>(
    `EXPLAIN (FORMAT JSON) ${sql}`,
    [...values],
  );
  const envelope = result.rows[0]?.['QUERY PLAN'];
  if (!Array.isArray(envelope) || envelope.length !== 1) {
    throw new Error('unrecognized EXPLAIN JSON envelope');
  }
  const root = envelope[0];
  if (!isRecord(root) || !isRecord(root.Plan)) {
    throw new Error('unrecognized EXPLAIN JSON root');
  }
  return root.Plan;
}

const recognizedPlanNodeTypes = new Set([
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'Index Only Scan',
  'Index Scan',
  'Limit',
  'Seq Scan',
]);

function inspectPlan(root: PlanNode): {
  indexNames: Set<string>;
  sequentialScan: boolean;
} {
  const indexNames = new Set<string>();
  let sequentialScan = false;
  const visit = (node: PlanNode): void => {
    const nodeType = node['Node Type'];
    if (
      typeof nodeType !== 'string' ||
      !recognizedPlanNodeTypes.has(nodeType)
    ) {
      throw new Error(`unrecognized EXPLAIN node type: ${String(nodeType)}`);
    }
    if (nodeType === 'Seq Scan') sequentialScan = true;
    if (node['Index Name'] !== undefined) {
      if (typeof node['Index Name'] !== 'string') {
        throw new Error(
          `unrecognized EXPLAIN index name: ${String(node['Index Name'])}`,
        );
      }
      indexNames.add(node['Index Name']);
    }
    if (node.Plans !== undefined) {
      if (!Array.isArray(node.Plans) || !node.Plans.every(isRecord)) {
        throw new Error('unrecognized EXPLAIN child plan collection');
      }
      for (const child of node.Plans) visit(child);
    }
  };
  visit(root);
  return { indexNames, sequentialScan };
}

function assertRelationIndexPlan(
  root: PlanNode,
  expectedIndexName: string,
): void {
  const plan = inspectPlan(root);
  assert.equal(
    plan.sequentialScan,
    false,
    'relation predicate used a sequential scan',
  );
  assert.ok(
    plan.indexNames.has(expectedIndexName),
    `relation predicate did not use expected relation index ${expectedIndexName}; used ${[...plan.indexNames].join(', ') || 'none'}`,
  );
}

function quoted(identifier: string): string {
  assert.match(identifier, /^[a-z_][a-z0-9_]*$/);
  return `"${identifier}"`;
}

function isRecord(value: unknown): value is PlanNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
