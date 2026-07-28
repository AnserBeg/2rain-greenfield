import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QUERY_AGGREGATE_PROFILE_VERSION,
  evaluateQueryAggregateSemantics,
} from '../../packages/canonical-model/src/index.js';
import {
  Q1_AGGREGATE_PARITY_CASES,
  type QueryAggregateParityCase,
} from '../helpers/q1-predicate-corpus.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const perturbEmptyIdentity = process.env.Q1P3A_PERTURB_EMPTY_IDENTITY === '1';
const perturbArchivedVisibility =
  process.env.Q1P3A_PERTURB_ARCHIVED_VISIBILITY === '1';
const perturbAbsentAdmission =
  process.env.Q1P3A_PERTURB_ABSENT_ADMISSION === '1';

test('query aggregate ruling agrees with PostgreSQL for required values, empty input, absence, and archive visibility', async () => {
  await withEphemeralPostgres(
    'q1-p3a-aggregate-semantics',
    async ({ pool }) => {
      let irExecutions = 0;
      let postgresExecutions = 0;
      for (const candidate of Q1_AGGREGATE_PARITY_CASES) {
        const ir = evaluateCandidate(candidate);
        irExecutions += 1;
        assert.equal(ir.outcome, 'evaluated', candidate.caseId);
        const sql = await pool.query<{ raw: string | null; total: string }>(
          `SELECT
           SUM(value)::text AS raw,
           COALESCE(SUM(value), 0::numeric)::text AS total
         FROM unnest($1::text[]) AS input(raw)
         CROSS JOIN LATERAL (
           SELECT input.raw::numeric(${String(candidate.field.precision)}, ${String(candidate.field.scale)}) AS value
         ) AS typed`,
          [candidate.elements],
        );
        postgresExecutions += 1;
        assert.equal(sql.rowCount, 1);
        const postgresValue = perturbEmptyIdentity
          ? sql.rows[0]!.raw
          : sql.rows[0]!.total;
        assert.equal(
          postgresValue === null ? null : canonicalDecimal(postgresValue),
          ir.outcome === 'evaluated' ? ir.result.value : null,
          candidate.caseId,
        );
        assert.equal(
          ir.outcome === 'evaluated' && ir.result.value,
          candidate.expected,
        );
      }

      await pool.query(`
      CREATE TABLE aggregate_scope_probe (
        tenant_id text NOT NULL,
        environment_id text NOT NULL,
        lifecycle text NOT NULL,
        policy_visible boolean NOT NULL,
        value numeric(20, 6) NOT NULL
      )
    `);
      await pool.query(
        `INSERT INTO aggregate_scope_probe
         (tenant_id, environment_id, lifecycle, policy_visible, value)
       VALUES
         ('tenant-a', 'env-a', 'active',   TRUE,    1.25),
         ('tenant-a', 'env-a', 'active',   TRUE,   -0.25),
         ('tenant-a', 'env-a', 'archived', TRUE,  100.00),
         ('tenant-a', 'env-a', 'active',   FALSE,  10.00),
         ('tenant-b', 'env-a', 'active',   TRUE, 1000.00),
         ('tenant-a', 'env-b', 'active',   TRUE, 2000.00)`,
      );
      const archivePredicate = perturbArchivedVisibility
        ? "lifecycle IN ('active', 'archived')"
        : "lifecycle = 'active'";
      const visible = await pool.query<{ total: string }>(`
      SELECT COALESCE(SUM(value), 0::numeric)::text AS total
        FROM aggregate_scope_probe
       WHERE tenant_id = 'tenant-a'
         AND environment_id = 'env-a'
         AND ${archivePredicate}
         AND policy_visible = TRUE
    `);
      postgresExecutions += 1;
      const visibleIr = evaluateQueryAggregateSemantics({
        elements: [
          { presence: 'present', value: '1.25' },
          { presence: 'present', value: '-0.25' },
        ],
        field: {
          fieldId: 'northstar.q1:field.aggregate_quantity',
          kind: 'quantityFieldType',
          baseUnitId: 'northstar.inventory:unit.each',
          precision: 20,
          presence: 'required',
          scale: 6,
        },
        operator: 'sum',
        profileVersion: QUERY_AGGREGATE_PROFILE_VERSION,
      });
      irExecutions += 1;
      assert.equal(visibleIr.outcome, 'evaluated');
      assert.equal(
        canonicalDecimal(visible.rows[0]!.total),
        visibleIr.outcome === 'evaluated' && visibleIr.result.value,
      );
      const opposite = await pool.query<{ total: string }>(`
      SELECT COALESCE(SUM(value), 0::numeric)::text AS total
        FROM aggregate_scope_probe
       WHERE tenant_id = 'tenant-a'
         AND environment_id = 'env-a'
         AND lifecycle IN ('active', 'archived')
         AND policy_visible = TRUE
    `);
      postgresExecutions += 1;
      assert.equal(canonicalDecimal(opposite.rows[0]!.total), '101');
      assert.notEqual(
        canonicalDecimal(opposite.rows[0]!.total),
        visibleIr.outcome === 'evaluated' && visibleIr.result.value,
        'including archived rows must observably change the ruled total',
      );

      const optionalSql = await pool.query<{
        present: string;
        rows: string;
        total: string;
      }>(`
      WITH inputs(value) AS (VALUES (2::numeric), (NULL::numeric), (3::numeric))
      SELECT SUM(value)::text AS total,
             COUNT(*)::text AS rows,
             COUNT(value)::text AS present
        FROM inputs
    `);
      postgresExecutions += 1;
      assert.deepEqual(optionalSql.rows, [
        { present: '2', rows: '3', total: '5' },
      ]);
      const optionalIr = evaluateQueryAggregateSemantics({
        elements: [
          { presence: 'present', value: '2' },
          { presence: 'absent' },
          { presence: 'present', value: '3' },
        ],
        field: {
          fieldId: 'northstar.q1:field.aggregate_exact_decimal',
          kind: 'exactDecimalFieldType',
          precision: 20,
          presence: 'optional',
          scale: 0,
        },
        operator: 'sum',
        profileVersion: QUERY_AGGREGATE_PROFILE_VERSION,
      });
      irExecutions += 1;
      if (perturbAbsentAdmission) {
        assert.equal(optionalIr.outcome, 'evaluated');
      } else {
        assert.deepEqual(optionalIr, {
          kind: 'queryAggregateKernelReceipt',
          outcome: 'rejected',
          reason: 'optional-aggregand',
          schemaVersion: 'northstar.query-aggregate-kernel-receipt/v1',
        });
      }

      assert.equal(irExecutions, Q1_AGGREGATE_PARITY_CASES.length + 2);
      assert.equal(postgresExecutions, Q1_AGGREGATE_PARITY_CASES.length + 3);
      console.log(
        `Q1-P3a aggregate probe cases=${String(Q1_AGGREGATE_PARITY_CASES.length)} ir=${String(irExecutions)} postgres=${String(postgresExecutions)} empty_raw=NULL empty_total=0 visible_total=1 archived_included_total=101 optional_sql_sum=5 optional_rows=3 optional_present=2 optional_ir=${optionalIr.outcome === 'rejected' ? optionalIr.reason : optionalIr.result.value}`,
      );
    },
  );
});

function evaluateCandidate(candidate: QueryAggregateParityCase) {
  return evaluateQueryAggregateSemantics({
    elements: candidate.elements.map((value) => ({
      presence: 'present',
      value,
    })),
    field:
      candidate.field.kind === 'quantityFieldType'
        ? {
            ...candidate.field,
            baseUnitId: 'northstar.inventory:unit.each',
            presence: 'required',
          }
        : { ...candidate.field, presence: 'required' },
    operator: 'sum',
    profileVersion: QUERY_AGGREGATE_PROFILE_VERSION,
  });
}

function canonicalDecimal(value: string): string {
  if (!value.includes('.')) return value === '-0' ? '0' : value;
  const trimmed = value.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed === '-0' ? '0' : trimmed;
}
