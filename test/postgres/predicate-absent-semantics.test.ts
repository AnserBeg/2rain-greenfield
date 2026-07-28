import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectPredicateForExecution } from '../../packages/canonical-model/src/index.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

test('absent predicate semantics diverge from raw SQL and agree when totalized', async () => {
  const lessThanFive = {
    field: {
      kind: 'fieldReference',
      schemaVersion: 'v2',
      targetId: 'northstar.probe:field.optional_integer',
    },
    kind: 'fieldComparisonPredicate',
    operator: 'lessThan',
    schemaVersion: 'v2',
    value: { kind: 'integerValue', schemaVersion: 'v2', value: '5' },
  };
  const notLessThanFive = {
    kind: 'notPredicate',
    schemaVersion: 'v2',
    term: lessThanFive,
  };
  const kernel = inspectPredicateForExecution(notLessThanFive, {
    bindingPosition: 'queryFilter',
    resolveComparison: () => ({ presence: 'absent' }),
  });
  assert.equal(kernel.outcome, 'evaluated');
  assert.equal(kernel.outcome === 'evaluated' && kernel.result, true);

  await withEphemeralPostgres('q1-p0-absent-semantics', async ({ pool }) => {
    const truth = await pool.query<{
      raw_not_less: boolean | null;
      total_greater_or_equal: boolean;
      total_not_less: boolean;
    }>(`
      SELECT
        NOT (NULL::integer < 5) AS raw_not_less,
        NOT COALESCE(NULL::integer < 5, FALSE) AS total_not_less,
        COALESCE(NULL::integer >= 5, FALSE) AS total_greater_or_equal
    `);
    assert.deepEqual(truth.rows, [
      {
        raw_not_less: null,
        total_greater_or_equal: false,
        total_not_less: true,
      },
    ]);
    assert.equal(kernel.outcome === 'evaluated' && kernel.result, true);
    assert.notEqual(
      truth.rows[0]!.raw_not_less,
      kernel.outcome === 'evaluated' && kernel.result,
      'removing absent-value totalization must reproduce the old mismatch',
    );
    assert.equal(
      truth.rows[0]!.total_not_less,
      kernel.outcome === 'evaluated' && kernel.result,
    );
    assert.notEqual(
      truth.rows[0]!.total_not_less,
      truth.rows[0]!.total_greater_or_equal,
      'F3 operators cannot be replaced by negation after F1',
    );

    const aggregate = await pool.query<{
      empty_sum: string | null;
      present_values: string;
      rows: string;
      sum_optional: string;
    }>(`
      WITH inputs(value) AS (
        VALUES (2::integer), (NULL::integer), (3::integer)
      )
      SELECT
        SUM(value) AS sum_optional,
        COUNT(*) AS rows,
        COUNT(value) AS present_values,
        (SELECT SUM(empty.value) FROM (SELECT NULL::integer AS value WHERE FALSE) AS empty) AS empty_sum
      FROM inputs
    `);
    assert.deepEqual(aggregate.rows, [
      {
        empty_sum: null,
        present_values: '2',
        rows: '3',
        sum_optional: '5',
      },
    ]);

    console.log(
      `Q1-P0 absent probe: kernel_not_less=true raw_sql_not_less=NULL total_sql_not_less=${String(truth.rows[0]!.total_not_less)} total_sql_greater_or_equal=${String(truth.rows[0]!.total_greater_or_equal)} sum_optional=${aggregate.rows[0]!.sum_optional} rows=${aggregate.rows[0]!.rows} present=${aggregate.rows[0]!.present_values} empty_sum=NULL`,
    );
  });
});
