import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { WorkflowScope } from '../../packages/postgres-provider/src/workflow-consumer.js';

/** Exercise the admission boundary with 5,000 distinct source events on an
 * already verified fence. All four trust rows are cloned with fresh linked IDs.
 * A rollback keeps this import out of the subsequent receipt journey. */
export async function checkWorkflowStartLimits(
  pool: Pool,
  scope: WorkflowScope,
  sampleOutbox: string,
) {
  const client = await pool.connect();
  const count = async (sql: string) =>
    (await client.query<{ n: number }>(sql)).rows[0]!.n;
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('north_star.tenant_id',$1,true),set_config('north_star.environment_id',$2,true)",
      [scope.tenant_id, scope.environment_id],
    );
    await client.query(`CREATE TEMP TABLE import_batch ON COMMIT DROP AS
      SELECT gen_random_uuid() AS invocation_id,gen_random_uuid() AS request_id,gen_random_uuid() AS correlation_id,
        gen_random_uuid() AS domain_event_id,gen_random_uuid() AS change_document_id,gen_random_uuid() AS outbox_id,
        gen_random_uuid() AS record_id,gen_random_uuid()::text AS deduplication_key, ordinal
      FROM generate_series(1,5000) ordinal`);
    for (const table of [
      'trust_action_invocations',
      'trust_business_change_documents',
      'trust_domain_events',
      'trust_outbox',
    ]) {
      await client.query(
        `INSERT INTO platform.${table}
        SELECT cloned.* FROM platform.${table} original CROSS JOIN import_batch b
        CROSS JOIN LATERAL jsonb_populate_record(original,to_jsonb(b)) cloned WHERE original.outbox_id=$1`,
        [sampleOutbox],
      );
    }
    await client.query(
      `INSERT INTO platform.workflow_event_occurrences
      SELECT o.tenant_id,o.environment_id,b.outbox_id,o.pointer_id,o.fence,'CLAIMED'
        FROM platform.workflow_event_occurrences o CROSS JOIN import_batch b WHERE o.outbox_id=$1`,
      [sampleOutbox],
    );
    await client.query(
      `INSERT INTO platform.workflow_instances
      SELECT i.tenant_id,i.environment_id,gen_random_uuid(),b.outbox_id,b.domain_event_id,
             i.workflow_id,i.legal_entity_id,b.record_id,i.trigger_principal_id
      FROM platform.workflow_instances i CROSS JOIN import_batch b WHERE i.outbox_id=$1 AND i.workflow_id='receipt-review'`,
      [sampleOutbox],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const insert = `INSERT INTO platform.workflow_runs (tenant_id,environment_id,instance_id,workflow_id,run_id,
      pointer_id,release_id,release_root,initial_fence,execution_fence)
      SELECT i.tenant_id,i.environment_id,i.instance_id,i.workflow_id,gen_random_uuid(),
        w.pointer_id,w.release_id,w.release_root,w.fence,w.fence
      FROM import_batch b JOIN platform.workflow_instances i USING (outbox_id)
      JOIN platform.workflow_event_occurrences o USING (tenant_id,environment_id,outbox_id)
      JOIN platform.workflow_activation_watermarks w USING (tenant_id,environment_id,pointer_id,fence)`;
    // Isolate from the outer journey's runs without changing its durable state.
    await client.query(
      "UPDATE platform.workflow_runs SET status='COMPLETED',reason=NULL,created_at='2000-01-01'",
    );
    await client.query(
      'UPDATE north_star_internal.workflow_start_limits SET runnable=1,open_runs=2,workflow_per_hour=3,starts_per_hour=4',
    );
    assert.equal((await client.query(insert + ' WHERE ordinal=1')).rowCount, 1);
    await client.query(
      "UPDATE platform.workflow_runs SET status='WAITING' WHERE status='RUNNABLE'",
    );
    assert.equal(
      (await client.query(insert + ' WHERE ordinal=2')).rowCount,
      1,
      'a sleeping run frees a runnable slot',
    );
    await client.query(
      "UPDATE platform.workflow_runs SET status='RUNNABLE' WHERE status='WAITING'",
    );
    assert.equal(
      await count(
        "SELECT count(*)::int n FROM platform.workflow_runs WHERE status='CAPACITY_WAIT'",
      ),
      1,
      'a wake cannot oversubscribe',
    );
    await client.query(
      "UPDATE platform.workflow_runs SET status='WAITING' WHERE status='RUNNABLE'",
    );
    await client.query('SELECT platform.workflow_resume_capacity()');
    assert.equal(
      await count(
        "SELECT count(*)::int n FROM platform.workflow_runs WHERE status='RUNNABLE'",
      ),
      1,
    );
    await client.query(
      "UPDATE platform.workflow_runs SET status='WAITING' WHERE status='RUNNABLE'",
    );
    assert.equal(
      (await client.query(insert + ' WHERE ordinal=3')).rowCount,
      0,
      'open cap includes sleeping runs',
    );
    assert.equal(
      await count(
        "SELECT count(*)::int n FROM platform.workflow_deferred_starts WHERE disposition='deferred'",
      ),
      1,
    );
    await client.query('SAVEPOINT overflow_case');
    await client.query(
      'UPDATE north_star_internal.workflow_start_limits SET deferred=1',
    );
    assert.equal((await client.query(insert + ' WHERE ordinal=4')).rowCount, 0);
    const alerts = await client.query<{
      instance_id: string;
      disposition: string;
    }>('SELECT * FROM platform.workflow_waiting_starts()');
    assert.deepEqual(
      alerts.rows.map((row) => row.disposition),
      ['rate-limit-overflow', 'deferred'],
    );
    const manage = async (start: string, action: string) =>
      (
        await client.query<{ applied: boolean }>(
          'SELECT north_star_internal.workflow_manage_start($1,$2,$3,$4) AS applied',
          [scope.tenant_id, scope.environment_id, start, action],
        )
      ).rows[0]!.applied;
    assert.equal(await manage(alerts.rows[0]!.instance_id, 'release'), false);
    assert.equal(await manage(alerts.rows[1]!.instance_id, 'dismiss'), true);
    assert.equal(await manage(alerts.rows[0]!.instance_id, 'release'), true);
    assert.equal(
      await count(
        "SELECT count(*)::int n FROM platform.workflow_deferred_starts WHERE disposition='deferred' AND overflowed_at IS NOT NULL AND operator_action='release'",
      ),
      1,
    );
    await client.query('ROLLBACK TO SAVEPOINT overflow_case');
    await client.query(
      'UPDATE north_star_internal.workflow_start_limits SET runnable=6000,open_runs=6000',
    );
    await client.query(
      "UPDATE platform.workflow_deferred_starts SET not_before='2000-01-01'",
    );
    assert.equal(
      await count('SELECT platform.workflow_resume_capacity() n'),
      1,
    );
    assert.equal(
      (await client.query(insert + ' WHERE ordinal>=4')).rowCount,
      0,
      'workflow rolling-hour cap applies independently',
    );
    assert.equal(
      await count(
        "SELECT count(*)::int n FROM platform.workflow_deferred_starts WHERE disposition='deferred'",
      ),
      4997,
    );
    assert.equal(
      await count(`SELECT count(*)::int n FROM platform.workflow_instances i JOIN import_batch b USING (outbox_id)
      LEFT JOIN platform.workflow_runs r USING (tenant_id,environment_id,instance_id)
      LEFT JOIN platform.workflow_deferred_starts q USING (tenant_id,environment_id,instance_id)
      WHERE (r.run_id IS NOT NULL) <> coalesce(q.disposition='deferred',false)`),
      5000,
    );
    await client.query(
      'UPDATE north_star_internal.workflow_start_limits SET workflow_per_hour=6000',
    );
    await client.query(
      "UPDATE platform.workflow_deferred_starts SET not_before='2000-01-01' WHERE disposition='deferred'",
    );
    assert.equal(
      await count('SELECT platform.workflow_resume_capacity() n'),
      1,
      'scope-wide rolling-hour cap',
    );
    await client.query(
      "UPDATE platform.workflow_runs SET created_at=clock_timestamp()-interval '1 hour'",
    );
    await client.query(
      "UPDATE platform.workflow_deferred_starts SET not_before='2000-01-01' WHERE disposition='deferred'",
    );
    assert.equal(
      await count('SELECT platform.workflow_resume_capacity() n'),
      4,
      'old starts leave the rolling window',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
